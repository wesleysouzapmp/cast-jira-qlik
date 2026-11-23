// Serviço de apontamento de horas nas tarefas de apoio: lista as tarefas, lê os apontamentos
// já existentes do usuário, monta a prévia (batidas + comentários) e grava os worklogs,
// movendo tarefa e épico para "Em Execução" conforme as regras da spec.
import { MODELS, QSENSE } from '../support/models.js';
import { modelOfTask, toAdf } from '../support/render.js';
import { JiraError, jiraMessage } from '../support/service.js';
import { distribute, formatDuration, toJiraStarted, hhmmToMin, minToHhmm } from './time.js';
import { isAdf, adfToText } from '../shared/flatten.js';
import { pickComments, GENERIC_MODEL } from './comments.js';
import { checkSlot } from './auto.js';

export class ConflictError extends Error {}
export class ScopeError extends Error {}

const TARGET = 'Em Execução';
const TASK_FROM = new Set(['Aberto']);
const EPIC_FROM = new Set(['Aberto', 'Priorizado', 'Em Análise', 'Aguardando Execução']);
const OFFSET_MS = 3 * 3600 * 1000; // -03:00
const BATCH = 50;

const modelOrder = (id) => MODELS.findIndex((m) => m.id === id);
const isEpicIssue = (i) => (i.fields?.issuetype?.hierarchyLevel ?? 0) >= 1 || /^(épico|epic)$/i.test(i.fields?.issuetype?.name ?? '');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const localStartMs = (date) => Date.parse(`${date}T00:00:00.000-03:00`);
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const prevDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

function parseJiraDate(s) {
  return Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
}

const NO_HOLIDAYS = { async between() { return new Map(); } };

export function createWorklogService({ client, baseUrl, supportService, ai, rng = Math.random, holidays = NO_HOLIDAYS }) {
  const browse = (key) => `${baseUrl}/browse/${key}`;
  let accountId = null;
  let queue = Promise.resolve();
  // Worklogs gravados por este processo. A busca do Jira demora a indexar o que acabou de ser
  // gravado; esta lista cobre esse intervalo na checagem de sobreposição.
  const written = [];
  // Ids apagados por este processo: não voltam a aparecer mesmo que a leitura venha atrasada.
  const deleted = new Set();
  // Batidas cuja mudança de tarefa criou a cópia mas não apagou a original: não movê-las de novo.
  const duplicatedFrom = new Set();

  async function call(req, what) {
    const res = await client.call(req);
    if (!res.ok) throw new JiraError(res.status, `${what}: HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    return res.data;
  }

  async function search(jql, fields, what) {
    const out = [];
    let nextPageToken;
    do {
      const data = await call({ method: 'POST', path: '/rest/api/3/search/jql', body: { jql, maxResults: 100, fields, ...(nextPageToken ? { nextPageToken } : {}) } }, what);
      out.push(...(data.issues ?? []));
      nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  async function me() {
    if (!accountId) accountId = (await call({ method: 'GET', path: '/rest/api/3/myself' }, 'Usuário do token')).accountId;
    return accountId;
  }

  // Escopo: épicos em aberto atribuídos ao usuário e suas tarefas de apoio.
  async function loadScope() {
    const { items } = await supportService.listItems({ onlyEpics: true });
    const epics = items.map((e) => ({ key: e.key, summary: e.summary, status: e.status, url: e.url, tasks: [] }));
    const byEpic = new Map(epics.map((e) => [e.key, e]));
    for (const keys of chunk(epics.map((e) => e.key), BATCH)) {
      const found = await search(`project = ${QSENSE.projectKey} AND parent in (${keys.join(', ')})`, ['summary', 'status', 'parent', 'timespent', QSENSE.catalogFieldId], 'Busca das tarefas de apoio');
      for (const t of found) {
        const model = modelOfTask(t);
        const epic = byEpic.get(t.fields?.parent?.key);
        if (!model || !epic) continue;
        epic.tasks.push({ key: t.key, model: model.id, summary: t.fields.summary ?? '', status: t.fields.status?.name ?? '', url: browse(t.key), timeSpentMin: Math.round((t.fields.timespent ?? 0) / 60) });
      }
    }
    for (const e of epics) e.tasks.sort((a, b) => modelOrder(a.model) - modelOrder(b.model) || a.key.localeCompare(b.key));
    const tasks = new Map();
    epics.forEach((e, ei) => e.tasks.forEach((t, ti) => tasks.set(t.key, { ...t, epic: e, order: ei * 1000 + ti })));
    return { epics, tasks };
  }

  // Tarefas avulsas: qualquer issue que o token enxergue, exceto épicos. Lidas direto no Jira.
  async function describe(keys) {
    const uniq = [...new Set(keys)];
    const found = new Map();
    for (const part of chunk(uniq, BATCH)) {
      const data = await call({ method: 'POST', path: '/rest/api/3/issue/bulkfetch', body: { issueIdsOrKeys: part, fields: ['summary', 'status', 'issuetype'] } }, 'Leitura das tarefas');
      for (const i of data.issues ?? []) found.set(i.key, i);
    }
    return uniq.map((key) => {
      const i = found.get(key);
      if (!i) return { key, available: false, error: `Tarefa ${key} não encontrada ou sem acesso.` };
      const base = { key, summary: i.fields?.summary ?? '', status: i.fields?.status?.name ?? '', url: browse(key) };
      if (isEpicIssue(i)) return { ...base, available: false, error: `${key} é um épico; aponte nas tarefas dele.` };
      return { ...base, available: true };
    });
  }

  // Tarefa pelo título exato (sem diferenciar maiúsculas/espaços), exceto épicos. Usado pelos agendamentos.
  async function findBySummary(text) {
    const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const phrase = String(text).replace(/["\\]/g, ' ').trim();
    const issues = await search(`summary ~ "\\"${phrase}\\"" ORDER BY created DESC`, ['summary', 'status', 'issuetype'], 'Busca da tarefa pelo texto');
    const exact = issues.filter((i) => norm(i.fields?.summary) === norm(text) && !isEpicIssue(i));
    if (!exact.length) return { available: false, error: `Nenhuma tarefa com o texto "${text}".` };
    if (exact.length > 1) return { available: false, error: `Mais de uma tarefa com o texto "${text}": ${exact.map((i) => i.key).sort().join(', ')}.` };
    const [i] = exact;
    return { key: i.key, summary: i.fields?.summary ?? '', status: i.fields?.status?.name ?? '', url: browse(i.key), available: true };
  }

  // Só tarefas de apoio (usado no destino ao mudar a tarefa de uma batida).
  function requireInScope(scope, keys) {
    const missing = [...new Set(keys)].filter((k) => !scope.tasks.has(k));
    if (missing.length) throw new ScopeError(`Tarefa fora do escopo (não é tarefa de apoio de um épico seu em aberto): ${missing.join(', ')}`);
  }

  // Escopo + as avulsas pedidas. Chave inexistente, sem acesso ou épico → ScopeError (nada é gravado).
  async function scopeFor(keys) {
    const scope = await loadScope();
    const extra = [...new Set(keys)].filter((k) => !scope.tasks.has(k));
    if (!extra.length) return scope;
    const described = await describe(extra);
    const bad = described.filter((d) => !d.available);
    if (bad.length) throw new ScopeError(bad.map((d) => d.error).join(' '));
    described.forEach((d, i) => scope.tasks.set(d.key, { key: d.key, model: GENERIC_MODEL.id, summary: d.summary, status: d.status, url: d.url, loose: true, epic: null, order: 1e9 + i }));
    return scope;
  }

  async function listTasks() {
    const { epics } = await loadScope();
    return { epics, aiEnabled: Boolean(ai?.enabled) };
  }

  // Apontamentos do usuário no período, como intervalos no fuso -03:00.
  // - A JQL usa um dia a mais de cada lado: worklogDate segue o fuso do perfil do Jira,
  //   que pode não ser -03:00; o filtro exato por horário vem depois.
  // - extraKeys: issues lidas direto (sem depender do índice de busca).
  // - written: o que este processo gravou e a busca ainda pode não mostrar.
  async function myWorklogs(from, to, extraKeys = []) {
    const acc = await me();
    const issues = await search(`worklogAuthor = currentUser() AND worklogDate >= "${prevDay(from)}" AND worklogDate <= "${nextDay(to)}"`, ['summary'], 'Busca dos apontamentos existentes');
    const summaries = new Map(issues.map((i) => [i.key, i.fields?.summary ?? '']));
    const keys = [...new Set([...issues.map((i) => i.key), ...extraKeys])];
    const after = localStartMs(from);
    const before = localStartMs(nextDay(to));
    const out = [];
    const seen = new Set();
    const add = (w) => {
      if (w.id && (seen.has(w.id) || deleted.has(w.id))) return;
      if (w.id) seen.add(w.id);
      if (!Number.isFinite(w.startedMs) || w.startedMs < after || w.startedMs >= before) return;
      const local = new Date(w.startedMs - OFFSET_MS);
      out.push({
        id: w.id, issueKey: w.issueKey, issueSummary: w.issueSummary ?? summaries.get(w.issueKey) ?? '', url: browse(w.issueKey),
        date: local.toISOString().slice(0, 10), start: minToHhmm(local.getUTCHours() * 60 + local.getUTCMinutes()), minutes: w.minutes, comment: w.comment ?? '',
        ...(w.updated ? { updated: w.updated } : {}),
      });
    };
    for (const key of keys) {
      const data = await call({ method: 'GET', path: `/rest/api/3/issue/${key}/worklog`, query: { startedAfter: after - 1, startedBefore: before, maxResults: 5000 } }, 'Leitura dos apontamentos');
      for (const w of data.worklogs ?? []) {
        if (w.author?.accountId !== acc) continue;
        add({ id: w.id ? String(w.id) : null, issueKey: key, startedMs: parseJiraDate(w.started), minutes: Math.round((w.timeSpentSeconds ?? 0) / 60), comment: isAdf(w.comment) ? adfToText(w.comment).trim() : '', updated: w.updated });
      }
    }
    for (const w of written) add(w);
    return out.sort((x, y) => x.date.localeCompare(y.date) || x.start.localeCompare(y.start));
  }

  // Intervalos ocupados (minutos desde 00:00, fuso -03:00) para o gerador de batidas.
  async function busy(from, to, extraKeys = []) {
    return (await myWorklogs(from, to, extraKeys)).map((w) => {
      const startMin = hhmmToMin(w.start);
      return { date: w.date, startMin, endMin: Math.min(startMin + w.minutes, 24 * 60) };
    });
  }

  function plannedTransitions(scope, taskKeys) {
    const out = [];
    const seenEpics = new Set();
    for (const key of taskKeys) {
      const t = scope.tasks.get(key);
      if (t.loose) continue; // avulsas: o app não mexe no status
      if (TASK_FROM.has(t.status)) out.push({ key, from: t.status, to: TARGET });
      if (!seenEpics.has(t.epic.key)) {
        seenEpics.add(t.epic.key);
        if (EPIC_FROM.has(t.epic.status)) out.push({ key: t.epic.key, from: t.epic.status, to: TARGET });
      }
    }
    return out;
  }

  async function preview({ items, from, to, schedule }) {
    const scope = await scopeFor(items.map((i) => i.taskKey));
    const demands = items
      .filter((i) => i.minutes > 0)
      .map((i) => ({ taskKey: i.taskKey, model: scope.tasks.get(i.taskKey).model, minutes: i.minutes, ...(i.perDay ? { perDay: true } : {}) }))
      .sort((a, b) => scope.tasks.get(a.taskKey).order - scope.tasks.get(b.taskKey).order);
    const hol = new Set((await holidays.between(from, to)).keys());
    const { entries, unallocated } = distribute({ demands, from, to, schedule, busy: await busy(from, to), holidays: hol });

    const byTask = new Map();
    for (const e of entries) byTask.set(e.taskKey, [...(byTask.get(e.taskKey) ?? []), e]);
    const comments = new Map();
    for (const [key, list] of byTask) {
      const t = scope.tasks.get(key);
      const model = t.loose ? GENERIC_MODEL : MODELS.find((m) => m.id === t.model);
      comments.set(key, pickComments(model, { epicKey: t.epic?.key, epicSummary: t.epic?.summary, taskKey: key, taskSummary: t.summary }, list.length, rng));
    }
    const used = new Map();
    const withComments = entries.map((e) => {
      const n = used.get(e.taskKey) ?? 0;
      used.set(e.taskKey, n + 1);
      return { ...e, timeSpent: formatDuration(e.minutes), comment: comments.get(e.taskKey)[n] };
    });
    return { entries: withComments, unallocated, transitions: plannedTransitions(scope, [...byTask.keys()]) };
  }

  async function aiComments(entries) {
    const scope = await scopeFor(entries.map((e) => e.taskKey));
    const ctx = {};
    for (const e of entries) {
      const t = scope.tasks.get(e.taskKey);
      ctx[e.taskKey] = { epicKey: t.epic?.key, epicSummary: t.epic?.summary, taskSummary: t.summary };
    }
    return { comments: await ai.generate(entries.map((e) => ({ ...e, model: scope.tasks.get(e.taskKey).model })), ctx) };
  }

  async function transition(key) {
    const data = await call({ method: 'GET', path: `/rest/api/3/issue/${key}/transitions` }, `Transições de ${key}`);
    const t = (data.transitions ?? []).find((x) => x.to?.name === TARGET);
    if (!t) throw new Error(`transição para "${TARGET}" não disponível no workflow`);
    const res = await client.call({ method: 'POST', path: `/rest/api/3/issue/${key}/transitions`, body: { transition: { id: t.id } } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
  }

  function overlaps(a, b) {
    return a.date === b.date && a.startMin < b.endMin && b.startMin < a.endMin;
  }

  async function submitNow({ entries }) {
    const scope = await scopeFor(entries.map((e) => e.taskKey));
    const spans = entries.map((e) => ({ date: e.date, startMin: hhmmToMin(e.start), endMin: hhmmToMin(e.start) + e.minutes }));
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (overlaps(spans[i], spans[j])) throw new ConflictError('Há lançamentos sobrepostos entre si na prévia.');
      }
    }
    const dates = entries.map((e) => e.date).sort();
    const existing = await busy(dates[0], dates.at(-1), [...new Set(entries.map((e) => e.taskKey))]);
    if (spans.some((s) => existing.some((b) => overlaps(s, b)))) {
      throw new ConflictError('Há apontamentos novos no período; gere a prévia de novo.');
    }

    const results = [];
    const succeeded = [];
    for (const [index, e] of entries.entries()) {
      const body = { timeSpent: formatDuration(e.minutes), started: toJiraStarted(e.date, e.start) };
      if (e.comment?.trim()) body.comment = toAdf(e.comment.trim());
      const res = await client.call({ method: 'POST', path: `/rest/api/3/issue/${e.taskKey}/worklog`, query: { notifyUsers: 'false' }, body });
      if (res.ok) {
        written.push({ id: res.data?.id ? String(res.data.id) : null, issueKey: e.taskKey, issueSummary: scope.tasks.get(e.taskKey).summary, startedMs: parseJiraDate(body.started), minutes: e.minutes, comment: e.comment?.trim() ?? '' });
        results.push({ index, status: 'created', worklogId: res.data?.id });
        if (!succeeded.includes(e.taskKey)) succeeded.push(e.taskKey);
      } else {
        results.push({ index, status: 'error', error: res.status === 0
          ? `${jiraMessage(res.data)} — o Jira pode ter gravado mesmo assim; confira a tarefa antes de repetir.`
          : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim() });
      }
    }

    return { results, transitions: await applyTransitions(scope, succeeded) };
  }

  // Tarefa em "Aberto" e épico não iniciado vão para "Em Execução" (só tarefas com gravação bem-sucedida).
  async function applyTransitions(scope, taskKeys) {
    const transitions = [];
    const seenEpics = new Set();
    const move = async (key, status, allowed) => {
      if (!allowed.has(status)) return transitions.push({ key, status: 'unchanged', from: status });
      try {
        await transition(key);
        transitions.push({ key, status: 'moved', from: status, to: TARGET });
      } catch (err) {
        transitions.push({ key, status: 'error', from: status, error: err.message });
      }
    };
    for (const key of taskKeys) {
      const t = scope.tasks.get(key);
      if (!t || t.loose) continue;
      await move(key, t.status, TASK_FROM);
      if (!seenEpics.has(t.epic.key)) {
        seenEpics.add(t.epic.key);
        await move(t.epic.key, t.epic.status, EPIC_FROM);
      }
    }
    return transitions;
  }

  // Intervalo local (-03:00) de um worklog do Jira.
  function localSpan(started, minutes) {
    const local = new Date(parseJiraDate(started) - OFFSET_MS);
    const startMin = local.getUTCHours() * 60 + local.getUTCMinutes();
    return { date: local.toISOString().slice(0, 10), startMin, endMin: Math.min(startMin + minutes, 24 * 60) };
  }

  const EMPTY_DOC = { type: 'doc', version: 1, content: [{ type: 'paragraph' }] };
  function worklogBody(c, { forPost = false } = {}) {
    const body = { timeSpent: formatDuration(c.minutes), started: toJiraStarted(c.date, c.start) };
    if (c.comment?.trim()) body.comment = toAdf(c.comment.trim());
    else if (!forPost) body.comment = EMPTY_DOC; // limpa o comentário no PUT
    return body;
  }

  async function batchNow({ changes }) {
    const scope = await loadScope();
    const acc = await me();

    // 1. Relê cada batida: precisa existir, ser do usuário e estar na issue informada.
    const originals = new Map();
    for (const c of changes) {
      const res = await client.call({ method: 'GET', path: `/rest/api/3/issue/${c.issueKey}/worklog/${c.id}` });
      if (res.status === 404 || (res.ok && res.data?.author?.accountId !== acc)) {
        throw new ScopeError(`A batida ${c.id} de ${c.issueKey} não existe mais ou não é sua. Recarregue o calendário.`);
      }
      if (!res.ok) throw new JiraError(res.status, `Leitura da batida ${c.id}: HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
      const orig = res.data;
      if (c.updated && orig.updated && c.updated !== orig.updated) {
        throw new ConflictError(`A batida ${c.id} de ${c.issueKey} foi alterada em outro lugar depois que o painel abriu. Recarregue e refaça a alteração.`);
      }
      if (c.action === 'update') {
        const span = localSpan(orig.started, Math.round((orig.timeSpentSeconds ?? 0) / 60));
        const origMinutes = Math.round((orig.timeSpentSeconds ?? 0) / 60);
        if (c.minutes !== origMinutes && (c.minutes < 15 || c.minutes % 15)) throw new ScopeError(`Batida ${c.id}: a nova duração deve ser em blocos de 15 min.`);
        if (c.start !== minToHhmm(span.startMin) && hhmmToMin(c.start) % 15) throw new ScopeError(`Batida ${c.id}: o novo início deve ser múltiplo de 15 min.`);
        if (c.targetKey && c.targetKey !== c.issueKey && duplicatedFrom.has(c.id)) {
          throw new ScopeError(`A batida ${c.id} já foi copiada para outra tarefa e a original não pôde ser apagada. Confira no Jira antes de mover de novo.`);
        }
      }
      originals.set(c.id, orig);
    }

    // 2. Destino de mudança de tarefa: só tarefas de apoio do usuário.
    const targets = changes.filter((c) => c.action === 'update' && c.targetKey && c.targetKey !== c.issueKey).map((c) => c.targetKey);
    requireInScope(scope, targets);

    // 3. Sobreposição: o resultado final dos dias afetados não pode ter intervalos sobrepostos.
    const changedIds = new Set(changes.map((c) => c.id));
    const finalSpans = changes.filter((c) => c.action === 'update').map((c) => ({ id: c.id, date: c.date, startMin: hhmmToMin(c.start), endMin: hhmmToMin(c.start) + c.minutes }));
    const dates = [...new Set([
      ...[...originals.values()].map((w) => localSpan(w.started, Math.round((w.timeSpentSeconds ?? 0) / 60)).date),
      ...finalSpans.map((x) => x.date),
    ])].sort();
    const others = (await myWorklogs(dates[0], dates.at(-1), [...new Set(changes.map((c) => c.issueKey))]))
      .filter((w) => !changedIds.has(w.id) && dates.includes(w.date))
      .map((w) => ({ id: w.id, date: w.date, startMin: hhmmToMin(w.start), endMin: hhmmToMin(w.start) + w.minutes }));
    for (const [i, a] of finalSpans.entries()) {
      const hit = [...others, ...finalSpans.slice(i + 1)].find((b) => overlaps(a, b));
      if (hit) throw new ConflictError(`A batida ${a.id} (${a.date.split("-").reverse().join("/")} ${minToHhmm(a.startMin)}) ficaria sobreposta à batida ${hit.id}. Ajuste os horários.`);
    }

    // 4. Aplica: alteração (PUT), mudança de tarefa (POST no destino e DELETE na origem) e exclusão (DELETE).
    const results = [];
    const movedTo = [];
    const forget = (id) => { deleted.add(id); const k = written.findIndex((w) => w.id === id); if (k >= 0) written.splice(k, 1); };
    for (const c of changes) {
      const fail = (res) => `HTTP ${res.status} ${jiraMessage(res.data)}`.trim();
      if (c.action === 'delete') {
        const res = await client.call({ method: 'DELETE', path: `/rest/api/3/issue/${c.issueKey}/worklog/${c.id}`, query: { notifyUsers: 'false' } });
        if (res.ok) { forget(c.id); results.push({ id: c.id, status: 'deleted' }); } else results.push({ id: c.id, status: 'error', error: fail(res) });
        continue;
      }
      const body = worklogBody(c);
      if (c.targetKey && c.targetKey !== c.issueKey) {
        const postBody = worklogBody(c, { forPost: true });
        const created = await client.call({ method: 'POST', path: `/rest/api/3/issue/${c.targetKey}/worklog`, query: { notifyUsers: 'false' }, body: postBody });
        if (!created.ok) { results.push({ id: c.id, status: 'error', error: fail(created) }); continue; }
        const newId = created.data?.id ? String(created.data.id) : null;
        written.push({ id: newId, issueKey: c.targetKey, issueSummary: scope.tasks.get(c.targetKey).summary, startedMs: parseJiraDate(body.started), minutes: c.minutes, comment: c.comment?.trim() ?? '' });
        if (!movedTo.includes(c.targetKey)) movedTo.push(c.targetKey);
        const del = await client.call({ method: 'DELETE', path: `/rest/api/3/issue/${c.issueKey}/worklog/${c.id}`, query: { notifyUsers: 'false' } });
        if (del.ok) {
          forget(c.id);
          results.push({ id: c.id, status: 'moved', newId });
        } else {
          duplicatedFrom.add(c.id);
          results.push({ id: c.id, status: 'duplicated', newId, error: `Criada em ${c.targetKey}, mas a original não pôde ser apagada (${fail(del)}): confira.` });
        }
        continue;
      }
      const res = await client.call({ method: 'PUT', path: `/rest/api/3/issue/${c.issueKey}/worklog/${c.id}`, query: { notifyUsers: 'false' }, body });
      if (res.ok) {
        const w = written.find((x) => x.id === c.id);
        if (w) Object.assign(w, { startedMs: parseJiraDate(body.started), minutes: c.minutes, comment: c.comment?.trim() ?? '' });
        results.push({ id: c.id, status: 'updated' });
      } else results.push({ id: c.id, status: 'error', error: fail(res) });
    }
    return { results, transitions: await applyTransitions(scope, movedTo) };
  }

  // Fila única: lote de manutenção também espera os envios em andamento.
  function batch(input) {
    const run = queue.then(() => batchNow(input));
    queue = run.catch(() => {});
    return run;
  }

  // Apontamento automático (agendador): um horário fixo numa tarefa qualquer (não épico).
  // Não muda status; não duplica (mesmo início na mesma tarefa) nem grava sobre outro apontamento.
  async function autoLogNow(slot) {
    const [t] = await describe([slot.taskKey]);
    if (!t.available) return { status: 'error', message: t.error };
    const c = checkSlot(slot, await myWorklogs(slot.date, slot.date, [slot.taskKey]));
    if (c.status !== 'ok') return c;
    const body = { timeSpent: formatDuration(slot.minutes), started: toJiraStarted(slot.date, slot.start) };
    if (slot.comment?.trim()) body.comment = toAdf(slot.comment.trim());
    const res = await client.call({ method: 'POST', path: `/rest/api/3/issue/${slot.taskKey}/worklog`, query: { notifyUsers: 'false' }, body });
    if (!res.ok) return { status: 'error', message: res.status === 0 ? jiraMessage(res.data) : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim() };
    written.push({ id: res.data?.id ? String(res.data.id) : null, issueKey: slot.taskKey, issueSummary: t.summary, startedMs: parseJiraDate(body.started), minutes: slot.minutes, comment: slot.comment?.trim() ?? '' });
    return { status: 'created', worklogId: res.data?.id };
  }

  function autoLog(slot) {
    const run = queue.then(() => autoLogNow(slot));
    queue = run.catch(() => {});
    return run;
  }

  // Fila única: dois envios nunca gravam ao mesmo tempo.
  function submit(input) {
    const run = queue.then(() => submitNow(input));
    queue = run.catch(() => {});
    return run;
  }

  return { aiEnabled: Boolean(ai?.enabled), listTasks, describe, myWorklogs, busy, preview, aiComments, submit, batch, autoLog, findBySummary };
}
