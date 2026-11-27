// Tarefa agrupadora com subtarefas (Parte 3): regras puras do wizard "Tarefas de apoio" e da
// divisão por fase de "Apontar horas". Sem imports: usado no navegador (/lib/groupPlan.js) e no
// servidor (validação), com os mesmos números nos dois lados.
// Tudo em minutos, blocos de 15 min. Datas 'AAAA-MM-DD', horários em minutos desde 00:00.

export const PHASES = [
  { id: 'analise', label: 'Análise' },
  { id: 'execucao', label: 'Execução' },
  { id: 'testes', label: 'Testes' },
  { id: 'producao', label: 'Produção' },
];
export const PHASE_IDS = PHASES.map((p) => p.id);
export const DEFAULT_PERCENT = { analise: 10, execucao: 50, testes: 30, producao: 10 };
// Subtarefa criada fora do app (sem fase guardada) conta como Execução.
export const DEFAULT_PHASE = 'execucao';
export const GROUP_CAT = 'CAT-87';
export const GROUP_TITLE = 'Apoio da demanda {EPICO}';
export const GROUP_INTRO = 'As atividades realizadas foram:';
export const GROUP_LIMITS = {
  subtaskMax: 450, // 7h30 por subtarefa
  totalMin: 15,
  totalMax: 200 * 60,
  activityMin: 10,
  activityMax: 300,
  activities: 60,
  title: 255,
  description: 2000,
  comment: 1000,
  entryMax: 480,
};

const STEP = 15;
const ELLIPSIS = '…';
const floor15 = (m) => Math.floor(m / STEP) * STEP;
const ceil15 = (m) => Math.ceil(m / STEP) * STEP;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - ELLIPSIS.length)}${ELLIPSIS}` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "40h", "7h30", "0h15" (como a spec escreve as horas).
export function fmtHours(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${m ? String(m).padStart(2, '0') : ''}`;
}

// Quantidade de subtarefas: uma a cada 7h30 informadas (⌈total ÷ 7h30⌉).
export function subtaskCount(totalMin) {
  return Math.max(1, Math.ceil(totalMin / GROUP_LIMITS.subtaskMax));
}

// Mensagem de falta de insumo (menos atividades que subtarefas) ou '' quando dá.
export function shortageMessage(totalMin, activityCount) {
  const n = subtaskCount(totalMin);
  if (activityCount >= n) return '';
  const need = n - activityCount;
  return `${fmtHours(totalMin)} ${n === 1 ? 'exige 1 subtarefa' : `exigem ${n} subtarefas`}; você descreveu ${plural(activityCount, 'atividade', 'atividades')}. Detalhe mais ${plural(need, 'atividade', 'atividades')}.`;
}

// Atividades em ordem, em blocos seguidos, entre n subtarefas: as primeiras recebem uma a mais
// quando a divisão não é exata. Devolve n listas de índices (cada uma com pelo menos 1) ou null.
export function distributeActivities(count, n) {
  if (!Number.isInteger(count) || !Number.isInteger(n) || n < 1 || count < n) return null;
  const base = Math.floor(count / n);
  const extra = count % n;
  const out = [];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push(Array.from({ length: size }, (_, k) => next + k));
    next += size;
  }
  return out;
}

// Fase da maioria das ações; em empate, a que aparece primeiro.
export function majorityPhase(phases) {
  const count = new Map();
  for (const p of phases) count.set(p, (count.get(p) ?? 0) + 1);
  let best = null;
  for (const p of phases) if (best === null || count.get(p) > count.get(best)) best = p;
  return best ?? DEFAULT_PHASE;
}

// Texto da atividade sem a ação repetida no começo ("analisar o script" com ação Analisar → "o script").
function rest({ action, text }) {
  const a = String(action ?? '').trim();
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  return a && t.toLowerCase().startsWith(`${a.toLowerCase()} `) ? t.slice(a.length + 1).trim() : t;
}
// Linha do texto gerado: ação + atividade ("Analisar o script SQL e o documento de negócio").
export function activityLine(act) {
  return `${String(act.action ?? '').trim()} ${rest(act)}`.trim();
}
// Título padrão: "<Ação da 1ª atividade> - <atividade>".
export function defaultSubtaskTitle(first) {
  return cut(`${String(first.action ?? '').trim()} - ${rest(first)}`, GROUP_LIMITS.title);
}
const numbered = (acts) => acts.map((a, i) => `${i + 1}. ${activityLine(a)}`).join('\n');
export function subtaskDescription(acts) {
  return cut(numbered(acts), GROUP_LIMITS.description);
}
export function groupDescription(acts) {
  return cut(`${GROUP_INTRO}\n${numbered(acts)}`, GROUP_LIMITS.description);
}

// Proposta das subtarefas. activities: [{ action, text, phase }].
// Devolve { subtasks: [{ activities: [índices], phase, summary, description }] } ou { error }.
export function proposeSubtasks(activities, totalMin) {
  const n = subtaskCount(totalMin);
  const blocks = distributeActivities(activities.length, n);
  if (!blocks) return { error: shortageMessage(totalMin, activities.length) };
  return { subtasks: blocks.map((idx) => describeBlock(activities, idx)) };
}

// Fase, título e descrição padrão de um bloco de atividades.
export function describeBlock(activities, idx) {
  const acts = idx.map((i) => activities[i]);
  return { activities: idx, phase: majorityPhase(acts.map((a) => a.phase)), summary: defaultSubtaskTitle(acts[0]), description: subtaskDescription(acts) };
}

// O bloco de cada subtarefa precisa ser contíguo, em ordem, cobrindo todas as atividades e com
// pelo menos 1 atividade por subtarefa (mover só entre vizinhas mantém isso).
export function isValidPartition(blocks, count) {
  if (!Array.isArray(blocks) || !blocks.length) return false;
  let next = 0;
  for (const b of blocks) {
    if (!Array.isArray(b) || !b.length) return false;
    for (const i of b) { if (i !== next) return false; next++; }
  }
  return next === count;
}

// Move a última atividade da subtarefa i para o começo da próxima (dir = 1) ou a primeira para o
// fim da anterior (dir = -1). Devolve os blocos novos ou null se a origem ficaria vazia.
export function moveActivity(blocks, i, dir) {
  const j = i + dir;
  if (!blocks[i] || !blocks[j] || blocks[i].length < 2) return null;
  const out = blocks.map((b) => [...b]);
  if (dir === 1) out[j].unshift(out[i].pop());
  else out[j].push(out[i].shift());
  return out;
}

// Dividir por percentual. phases: fase de cada subtarefa (em ordem); percents: { fase: % }.
// - Fase sem subtarefa não entra; o percentual dela é redistribuído proporcionalmente.
// - Horas da fase em blocos de 15 min; a sobra do arredondamento vai para a primeira fase presente.
// - Dentro da fase, partes iguais em blocos de 15 min; a sobra vai para a primeira subtarefa dela.
// - cap (padrão 7h30): o que passar do máximo vai para as outras subtarefas da mesma fase e depois
//   para as demais, em ordem (adjusted = true). Use cap = Infinity para não limitar.
// Devolve { minutes: [por subtarefa], byPhase: { fase: minutos }, adjusted }.
export function splitByPercent(totalMin, phases, percents = DEFAULT_PERCENT, { cap = GROUP_LIMITS.subtaskMax } = {}) {
  const present = PHASE_IDS.filter((p) => phases.includes(p));
  const pct = (p) => Math.max(Number(percents?.[p]) || 0, 0);
  const sum = present.reduce((s, p) => s + pct(p), 0);
  const byPhase = {};
  for (const p of present) byPhase[p] = sum > 0 ? floor15((totalMin * pct(p)) / sum) : floor15(totalMin / present.length);
  const used = present.reduce((s, p) => s + byPhase[p], 0);
  if (present.length) byPhase[present[0]] += totalMin - used;
  const minutes = phases.map(() => 0);
  for (const p of present) {
    const idx = phases.map((x, i) => (x === p ? i : -1)).filter((i) => i >= 0);
    const each = floor15(byPhase[p] / idx.length);
    idx.forEach((i) => { minutes[i] = each; });
    minutes[idx[0]] += byPhase[p] - each * idx.length;
  }
  let adjusted = false;
  for (let i = 0; i < minutes.length; i++) {
    let over = minutes[i] - cap;
    if (over <= 0) continue;
    adjusted = true;
    minutes[i] = cap;
    const order = [...phases.keys()].filter((k) => k !== i).sort((a, b) => (phases[a] === phases[i] ? 0 : 1) - (phases[b] === phases[i] ? 0 : 1) || a - b);
    for (const k of order) {
      if (over <= 0) break;
      const room = Math.max(cap - minutes[k], 0);
      const give = Math.min(room, over);
      minutes[k] += give;
      over -= give;
    }
    if (over > 0) minutes[i] += over; // não coube em lugar nenhum: a validação acusa
  }
  return { minutes, byPhase, adjusted };
}

// Problemas das horas das subtarefas (lista vazia = ok): blocos de 15, de 15 min a 7h30, soma = total.
export function hoursProblems(minutes, totalMin) {
  const out = [];
  minutes.forEach((m, i) => {
    if (!Number.isInteger(m) || m < STEP || m % STEP) out.push(`Subtarefa ${i + 1}: informe as horas em blocos de 15 min.`);
    else if (m > GROUP_LIMITS.subtaskMax) out.push(`Subtarefa ${i + 1}: no máximo ${fmtHours(GROUP_LIMITS.subtaskMax)}.`);
  });
  const sum = minutes.reduce((s, m) => s + (Number.isInteger(m) ? m : 0), 0);
  if (!out.length && sum !== totalMin) out.push(`A soma das subtarefas (${fmtHours(sum)}) precisa fechar o total de ${fmtHours(totalMin)}.`);
  return out;
}

// ---- Datas dos apontamentos ----
export function addDaysIso(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function isWorkday(date, holidays = new Set()) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(date);
}
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const MAX_PLAN_DAYS = 400;

// Distribui as horas de cada subtarefa (em ordem) pelos dias úteis a partir de startDate, começando
// em startTime todo dia, sem passar do limite diário (somando os apontamentos que já existem, busy)
// e sem sobrepor busy. Uma subtarefa que não cabe no dia continua no próximo dia útil.
// busy: [{ date, startMin, endMin }]. Devolve { entries: [{ sub, date, start, minutes }], unallocated }.
export function planCalendar({ minutes, startDate, startTime = '08:00', dailyLimit = 480, holidays = new Set(), busy = [] }) {
  const entries = [];
  const first = toMin(startTime);
  let date = startDate;
  let day = null;
  const open = () => {
    const mine = busy.filter((b) => b.date === date).sort((a, b) => a.startMin - b.startMin);
    let wins = [[first, 1440]];
    for (const b of mine) {
      wins = wins.flatMap(([a, z]) => {
        if (b.endMin <= a || b.startMin >= z) return [[a, z]];
        return [...(b.startMin > a ? [[a, b.startMin]] : []), ...(b.endMin < z ? [[b.endMin, z]] : [])];
      });
    }
    wins = wins.map(([a, z]) => [ceil15(a), floor15(z)]).filter(([a, z]) => z > a);
    day = { wins, wi: 0, cursor: wins[0]?.[0], room: floor15(dailyLimit - mine.reduce((s, b) => s + (b.endMin - b.startMin), 0)) };
  };
  const nextDay = () => { do date = addDaysIso(date, 1); while (!isWorkday(date, holidays)); open(); };
  while (!isWorkday(date, holidays)) date = addDaysIso(date, 1);
  open();
  let days = 0;
  for (const [sub, total] of minutes.entries()) {
    let left = total;
    while (left > 0) {
      if (days > MAX_PLAN_DAYS) return { entries, unallocated: minutes.slice(sub).reduce((s, m, k) => s + (k ? m : left), 0) };
      const win = day.wins[day.wi];
      if (!win || day.room <= 0) { nextDay(); days++; continue; }
      if (day.cursor >= win[1]) { day.wi++; day.cursor = day.wins[day.wi]?.[0]; continue; }
      const chunk = Math.min(left, win[1] - day.cursor, day.room, GROUP_LIMITS.entryMax);
      if (chunk <= 0) { nextDay(); days++; continue; }
      const last = entries.at(-1);
      // Mesmo dia, mesma subtarefa e emendado: um apontamento só (até 8h).
      if (last && last.sub === sub && last.date === date && toMin(last.start) + last.minutes === day.cursor && last.minutes + chunk <= GROUP_LIMITS.entryMax) last.minutes += chunk;
      else entries.push({ sub, date, start: hhmm(day.cursor), minutes: chunk });
      day.cursor += chunk;
      day.room -= chunk;
      left -= chunk;
    }
  }
  return { entries, unallocated: 0 };
}

// Total por dia dos apontamentos novos: Map data → minutos.
export function minutesByDay(entries) {
  const out = new Map();
  for (const e of entries) out.set(e.date, (out.get(e.date) ?? 0) + e.minutes);
  return out;
}
