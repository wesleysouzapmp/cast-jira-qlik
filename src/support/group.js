// Wizard "Tarefas de apoio" (Parte 3): agrupadora do épico (criar ou usar) → subtarefas (CAT e
// tamanho próprios) → apontamentos. A prévia só lê; a criação grava nessa ordem, na fila única.
//
// Regras de parada da criação:
//  - Revalidação antes de gravar (épico do usuário, agrupadora como a tela viu, opções no
//    createmeta, sobreposição e limite diário com o que já existe no Jira): erro lança
//    ScopeError/ConflictError/JiraError e nada é gravado.
//  - Agrupadora falhou: nada mais é feito.
//  - Subtarefa falhou: as outras continuam; os apontamentos dela não são feitos.
//  - Apontamento falhou: os outros continuam.
import { ScopeError, ConflictError } from '../worklog/service.js';
import { validateActivity, validateTask } from './templates.js';
import {
  GROUP_LIMITS, GROUP_CAT, PHASE_IDS, isWorkday, subtaskCount, shortageMessage, isValidPartition, majorityPhase, hoursProblems,
  planCalendar, groupDescription, minutesByDay, addDaysIso, fmtHours,
} from '../shared/groupPlan.js';
import { epicLabel } from './render.js';

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WORKLOGS = 200;
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const fmtDate = (d) => d.split('-').reverse().join('/');

function checkDate(s, what) {
  const ok = typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!ok) throw new RangeError(`${what} inválida (use AAAA-MM-DD).`);
  return s;
}
function checkStart(s, what) {
  if (typeof s !== 'string' || !HHMM_RE.test(s)) throw new RangeError(`${what} inválido (use HH:MM).`);
  if (toMin(s) % 15) throw new RangeError(`${what} deve ser múltiplo de 15 min.`);
  return s;
}

// Corpo da prévia/criação. requireWorklogs: a criação exige a grade de apontamentos.
// Lança RangeError com a mensagem para o usuário. Devolve o pedido normalizado (fases recalculadas).
export function parseGroupInput(body, catalog, { requireWorklogs = false } = {}) {
  if (!isObj(body)) throw new RangeError('Envie a tarefa de apoio.');
  if (typeof body.epicKey !== 'string' || !KEY_RE.test(body.epicKey)) throw new RangeError('Chave do épico inválida.');
  let group;
  if (isObj(body.group) && body.group.key !== undefined) {
    if (typeof body.group.key !== 'string' || !KEY_RE.test(body.group.key)) throw new RangeError('Chave da agrupadora inválida.');
    group = { key: body.group.key };
  } else if (isObj(body.group)) {
    const summary = typeof body.group.summary === 'string' ? body.group.summary.trim() : '';
    if (!summary) throw new RangeError('Informe o título da agrupadora.');
    if (summary.length > GROUP_LIMITS.title) throw new RangeError(`Título da agrupadora com até ${GROUP_LIMITS.title} caracteres.`);
    group = { summary };
  } else throw new RangeError('Agrupadora inválida: informe { key } (usar) ou { summary } (criar).');

  const list = body.activities;
  if (!Array.isArray(list) || !list.length || list.length > GROUP_LIMITS.activities) throw new RangeError(`Descreva de 1 a ${GROUP_LIMITS.activities} atividades.`);
  const activities = list.map((a, n) => validateActivity(a, `Atividade ${n + 1}`));

  const total = body.totalMinutes;
  if (!isInt(total) || total < GROUP_LIMITS.totalMin || total > GROUP_LIMITS.totalMax || total % 15) throw new RangeError('Total de horas de 0h15 a 200h, em blocos de 15 min.');
  const n = subtaskCount(total);
  const short = shortageMessage(total, activities.length);
  if (short) throw new RangeError(short);

  const subs = body.subtasks;
  if (!Array.isArray(subs) || subs.length !== n) throw new RangeError(`${fmtHours(total)} ${n === 1 ? 'exige 1 subtarefa' : `exigem ${n} subtarefas`}; envie ${n === 1 ? 'a subtarefa' : `as ${n} subtarefas`}.`);
  const blocks = subs.map((s) => (isObj(s) && Array.isArray(s.activities) ? s.activities : null));
  if (blocks.some((b) => !b) || !isValidPartition(blocks, activities.length)) throw new RangeError('As atividades das subtarefas precisam estar em ordem, cada subtarefa com pelo menos 1 atividade.');
  const subtasks = subs.map((s, i) => {
    const t = validateTask(s, catalog, `Subtarefa ${i + 1}`);
    if (t.cat === GROUP_CAT) throw new RangeError(`Subtarefa ${i + 1}: ${GROUP_CAT} é o item da agrupadora; escolha outro CAT.`);
    return { ...t, activities: blocks[i], phase: majorityPhase(blocks[i].map((k) => activities[k].phase)), minutes: s.minutes };
  });
  const hp = hoursProblems(subtasks.map((s) => s.minutes), total);
  if (hp.length) throw new RangeError(hp[0]);

  const mode = body.mode === 'percent' ? 'percent' : 'manual';
  if (mode === 'percent') {
    const p = body.percents;
    if (!isObj(p) || PHASE_IDS.some((k) => !isInt(p[k]) || p[k] < 0 || p[k] > 100)) throw new RangeError('Percentuais por fase: inteiros de 0 a 100.');
    if (PHASE_IDS.reduce((s, k) => s + p[k], 0) !== 100) throw new RangeError('Os percentuais por fase precisam somar 100%.');
  }
  const startDate = checkDate(body.startDate, 'Data inicial');
  const startTime = checkStart(body.startTime ?? '08:00', 'Hora de início');
  const dailyLimit = body.dailyLimit ?? 480;
  if (!isInt(dailyLimit) || dailyLimit < 15 || dailyLimit > 1440) throw new RangeError('Limite diário inválido (minutos, de 15 a 1440).');

  let worklogs = null;
  if (body.worklogs !== undefined && body.worklogs !== null) {
    if (!Array.isArray(body.worklogs) || !body.worklogs.length || body.worklogs.length > MAX_WORKLOGS) throw new RangeError(`Envie de 1 a ${MAX_WORKLOGS} apontamentos.`);
    worklogs = body.worklogs.map((w, k) => {
      const where = `Apontamento ${k + 1}`;
      if (!isObj(w) || !isInt(w.sub) || w.sub < 0 || w.sub >= n) throw new RangeError(`${where}: subtarefa inválida.`);
      const date = checkDate(w.date, `${where}: data`);
      const start = checkStart(w.start, `${where}: horário`);
      if (!isInt(w.minutes) || w.minutes < 15 || w.minutes > GROUP_LIMITS.entryMax || w.minutes % 15) throw new RangeError(`${where}: duração inválida (15 a 480 min, blocos de 15).`);
      if (toMin(start) + w.minutes > 1440) throw new RangeError(`${where}: passa da meia-noite.`);
      const comment = w.comment ?? '';
      if (typeof comment !== 'string' || comment.length > GROUP_LIMITS.comment) throw new RangeError(`${where}: comentário com até ${GROUP_LIMITS.comment} caracteres.`);
      return { sub: w.sub, date, start, minutes: w.minutes, comment: comment.trim() || subtasks[w.sub].summary.slice(0, GROUP_LIMITS.comment) };
    });
    subtasks.forEach((s, i) => {
      const sum = worklogs.filter((w) => w.sub === i).reduce((t, w) => t + w.minutes, 0);
      if (sum !== s.minutes) throw new RangeError(`Subtarefa ${i + 1}: os apontamentos somam ${fmtHours(sum)}, mas a subtarefa tem ${fmtHours(s.minutes)}.`);
    });
    const spans = worklogs.map((w) => ({ date: w.date, a: toMin(w.start), b: toMin(w.start) + w.minutes }));
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (spans[i].date === spans[j].date && spans[i].a < spans[j].b && spans[j].a < spans[i].b) throw new RangeError(`Os apontamentos ${i + 1} e ${j + 1} se sobrepõem em ${fmtDate(spans[i].date)}.`);
      }
    }
    for (const [date, min] of minutesByDay(worklogs)) {
      if (min > dailyLimit) throw new RangeError(`${fmtDate(date)}: ${fmtHours(min)} passa do limite diário de ${fmtHours(dailyLimit)}.`);
    }
  } else if (requireWorklogs) throw new RangeError('Monte as datas dos apontamentos antes de confirmar.');

  return { epicKey: body.epicKey, group, activities, totalMinutes: total, subtasks, mode, ...(mode === 'percent' ? { percents: body.percents } : {}), startDate, startTime, dailyLimit, worklogs };
}

// Épico do usuário (em aberto) e a situação da agrupadora dele.
// group: { status: 'new' } | { status: 'existing', key, url, summary, subtasks } | { status: 'conflict', keys }.
export async function groupStatus({ supportService }, epicKey) {
  const { items } = await supportService.listItems({ onlyEpics: true });
  const found = items.find((i) => i.key === epicKey);
  if (!found) throw new ScopeError(`${epicKey} não é um épico seu em aberto.`);
  const epic = { key: found.key, summary: found.summary, url: found.url, label: epicLabel({ key: found.key, fields: { summary: found.summary } }) };
  // listItems já leu as agrupadoras e as subtarefas do épico (inclusive as criadas por este processo).
  const groups = (found.existing ?? []).filter((t) => t.group);
  if (groups.length > 1) return { epic, group: { status: 'conflict', keys: groups.map((g) => g.key) } };
  if (groups.length === 1) {
    const g = groups[0];
    return { epic, group: { status: 'existing', key: g.key, url: g.url, summary: g.summary, subtasks: (g.subtasks ?? []).map((s) => ({ key: s.key, url: s.url, cat: s.cat, size: s.size ?? null, summary: s.summary, status: s.status, phase: s.phase })) } };
  }
  return { epic, group: { status: 'new' } };
}

export const conflictMessage = (epicKey, keys) => `O épico ${epicKey} tem mais de uma tarefa agrupadora (${keys.join(', ')}); corrija no Jira antes de continuar.`;

// Leituras comuns da prévia e da criação: épico, agrupadora (igual à que a tela viu), opções do
// createmeta e a grade de apontamentos (proposta, se não veio) checada contra o Jira.
async function check(ctx, input) {
  const { supportService, worklogService } = ctx;
  const st = await groupStatus(ctx, input.epicKey);
  if (st.group.status === 'conflict') throw new ScopeError(conflictMessage(input.epicKey, st.group.keys));
  if (input.group.key && (st.group.status !== 'existing' || st.group.key !== input.group.key)) {
    throw new ConflictError(st.group.status === 'existing'
      ? `A agrupadora de ${input.epicKey} agora é ${st.group.key}; volte ao passo 1.`
      : `A agrupadora ${input.group.key} não está mais sob ${input.epicKey}; volte ao passo 1.`);
  }
  if (!input.group.key && st.group.status === 'existing') throw new ConflictError(`O épico ${input.epicKey} já tem a agrupadora ${st.group.key}; volte ao passo 1 para usá-la.`);
  const prep = await supportService.prepareGroup({ needGroup: !input.group.key });
  input.subtasks.forEach((t, i) => {
    const o = supportService.subtaskOptions(prep, t);
    if (o.error) throw new ScopeError(`Subtarefa ${i + 1}: ${o.error}`);
  });

  let worklogs = input.worklogs;
  let unallocated = 0;
  const minutes = input.subtasks.map((s) => s.minutes);
  if (!worklogs) {
    // Proposta: distribui, lê feriados e apontamentos do período e redistribui até estabilizar.
    let plan = planCalendar({ minutes, startDate: input.startDate, startTime: input.startTime, dailyLimit: input.dailyLimit });
    for (let round = 0; round < 3; round++) {
      const last = addDaysIso(plan.entries.at(-1)?.date ?? input.startDate, 14);
      const holidays = new Set((await worklogService.holidaysBetween(input.startDate, last)).keys());
      const busy = await worklogService.busy(input.startDate, last);
      const next = planCalendar({ minutes, startDate: input.startDate, startTime: input.startTime, dailyLimit: input.dailyLimit, holidays, busy });
      const done = (next.entries.at(-1)?.date ?? '') <= last;
      plan = next;
      if (done) break;
    }
    unallocated = plan.unallocated;
    worklogs = plan.entries.map((e) => ({ ...e, comment: input.subtasks[e.sub].summary.slice(0, GROUP_LIMITS.comment) }));
  } else {
    const dates = worklogs.map((w) => w.date).sort();
    // Só dias úteis: sem fim de semana nem feriado (os mesmos de Apontar horas).
    const hol = await worklogService.holidaysBetween(dates[0], dates.at(-1));
    const off = dates.find((d) => !isWorkday(d, new Set(hol.keys())));
    if (off) throw new ScopeError(`${fmtDate(off)} não é dia útil${hol.has(off) ? ` (${hol.get(off)})` : ' (fim de semana)'}; ajuste a grade de datas.`);
    const existing = await worklogService.myWorklogs(dates[0], dates.at(-1));
    for (const w of worklogs) {
      const a = toMin(w.start);
      const hit = existing.find((b) => b.date === w.date && a < toMin(b.start) + b.minutes && toMin(b.start) < a + w.minutes);
      if (hit) throw new ConflictError(`O apontamento de ${fmtDate(w.date)} às ${w.start} sobrepõe a batida ${hit.issueKey} das ${hit.start}; ajuste a grade de datas.`);
    }
    const newByDay = minutesByDay(worklogs);
    for (const [date, min] of newByDay) {
      const old = existing.filter((b) => b.date === date).reduce((s, b) => s + b.minutes, 0);
      if (old + min > input.dailyLimit) throw new ScopeError(`${fmtDate(date)}: ${fmtHours(old)} já apontadas + ${fmtHours(min)} passam do limite diário de ${fmtHours(input.dailyLimit)}.`);
    }
  }
  return { st, prep, worklogs, unallocated };
}

const view = (input, st, worklogs, unallocated) => ({
  epic: st.epic,
  group: input.group.key ? { status: 'existing', key: st.group.key, url: st.group.url, summary: st.group.summary } : { status: 'new', summary: input.group.summary },
  subtasks: input.subtasks.map(({ cat, size, summary, description, phase, minutes, activities }) => ({ cat, size, summary, description, phase, minutes, activities })),
  worklogs,
  unallocated,
});

// Prévia: nada é gravado.
export async function previewGroup(ctx, input) {
  const { st, worklogs, unallocated } = await check(ctx, input);
  return view(input, st, worklogs, unallocated);
}

// Criação na fila única do usuário. Resposta: { group, subtasks: [{ index, status, key?, error? }],
// worklogs: [{ index, sub, status, error? }] } (status 'created' | 'existing' | 'error' | 'skipped').
export function createGroupFlow(ctx, input) {
  return ctx.supportService.exclusive(() => createNow(ctx, input));
}

async function createNow(ctx, input) {
  const { supportService, worklogService } = ctx;
  const { st, prep, worklogs } = await check(ctx, input);
  const epic = { key: st.epic.key, fields: { summary: st.epic.summary } };
  const skipAll = () => ({
    subtasks: input.subtasks.map((_, index) => ({ index, status: 'skipped' })),
    worklogs: worklogs.map((w, index) => ({ index, sub: w.sub, status: 'skipped' })),
  });

  let group;
  if (input.group.key) group = { status: 'existing', key: st.group.key, url: st.group.url };
  else {
    try {
      group = await supportService.createGroup(prep, epic, { summary: input.group.summary, description: groupDescription(input.activities) });
    } catch (err) {
      group = { status: 'error', error: err?.message || 'Erro ao criar a agrupadora.' };
    }
    if (group.status !== 'created') return { group, ...skipAll() };
  }

  const subtasks = [];
  for (const [index, t] of input.subtasks.entries()) {
    let r;
    try {
      r = await supportService.createSubtask(prep, { groupKey: group.key, epic, task: t, phase: t.phase });
    } catch (err) {
      r = { status: 'error', error: err?.message || 'Erro ao criar a subtarefa.' };
    }
    subtasks.push({ index, ...r });
  }

  const out = worklogs.map((w, index) => ({ index, sub: w.sub, status: 'skipped' }));
  const todo = worklogs.map((w, index) => ({ w, index })).filter(({ w }) => subtasks[w.sub].status === 'created');
  if (todo.length) {
    try {
      const res = await worklogService.submit({ entries: todo.map(({ w }) => ({ taskKey: subtasks[w.sub].key, date: w.date, start: w.start, minutes: w.minutes, comment: w.comment })) });
      todo.forEach(({ index }, k) => {
        const r = res.results?.[k];
        out[index] = r?.status === 'created' ? { index, sub: worklogs[index].sub, status: 'created' } : { index, sub: worklogs[index].sub, status: 'error', error: r?.error ?? 'Apontamento não gravado.' };
      });
    } catch (err) {
      for (const { index } of todo) out[index] = { index, sub: worklogs[index].sub, status: 'error', error: err.message };
    }
  }
  return { group, subtasks, worklogs: out };
}
