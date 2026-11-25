// Funções puras de tempo do apontamento: leitura e formatação de durações,
// divisão por percentual e distribuição das batidas pelos dias úteis.
// Tudo em minutos, com granularidade de 15 min e fuso fixo -03:00.

export const STEP = 15;
export const MAX_MINUTES = 200 * 60;
export const TZ_OFFSET = '-0300';
export const DEFAULT_SCHEDULE = { start: '08:00', lunchStart: '12:00', lunchEnd: '13:00', end: '17:00', dailyLimit: 480 };

const round15 = (m) => Math.round(m / STEP) * STEP;
const ceil15 = (m) => Math.ceil(m / STEP) * STEP;
const floor15 = (m) => Math.floor(m / STEP) * STEP;

export function parseDuration(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim().toLowerCase();
  if (!s) return null;
  let minutes = null;
  let m;
  if ((m = s.match(/^(\d+):([0-5]\d)$/))) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) minutes = Number(m[1].replace(',', '.')) * 60;
  else if ((m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/)) && (m[1] || m[2])) minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const r = round15(minutes);
  return r > 0 && r <= MAX_MINUTES ? r : null;
}

export function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

export function splitTotal(totalMin, pctAnalise) {
  const analise = Math.min(totalMin, round15((totalMin * pctAnalise) / 100));
  return { analise, implementacao: totalMin - analise };
}

export const hhmmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const minToHhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export function businessDays(from, to, holidays = new Set()) {
  const out = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !holidays.has(iso)) out.push(iso);
  }
  return out;
}

// Janelas [início, fim] menos os intervalos ocupados, arredondadas para dentro em blocos de 15.
function freeWindows(base, busy) {
  let wins = base.map(([a, b]) => [a, b]);
  for (const { startMin, endMin } of busy) {
    wins = wins.flatMap(([a, b]) => {
      if (endMin <= a || startMin >= b) return [[a, b]];
      const parts = [];
      if (startMin > a) parts.push([a, startMin]);
      if (endMin < b) parts.push([endMin, b]);
      return parts;
    });
  }
  return wins.map(([a, b]) => [ceil15(a), floor15(b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
}

// Dias que uma demanda com dia (from) pode usar para a sobra, contando o próprio dia.
export const ANCHOR_SPAN_DAYS = 31;

// demands: { taskKey, model, minutes, perDay?, from? }.
// - perDay: as mesmas horas em cada dia útil de from..to, alocadas primeiro.
// - from (dividir total): começa nesse dia e o que sobra vai para os próximos dias úteis,
//   mesmo depois de `to`, por até ANCHOR_SPAN_DAYS dias.
// - as demais dividem o que sobra de from..to, em ordem.
// O limite diário conta os apontamentos já existentes (busy) e os gerados aqui.
export function distribute({ demands, from, to, schedule = DEFAULT_SCHEDULE, busy = [], holidays = new Set() }) {
  const s = { start: hhmmToMin(schedule.start), lunchStart: hhmmToMin(schedule.lunchStart), lunchEnd: hhmmToMin(schedule.lunchEnd), end: hhmmToMin(schedule.end) };
  const base = [[s.start, s.lunchStart], [s.lunchEnd, s.end]];
  const active = demands.filter((x) => x.minutes > 0);
  const daily = active.filter((x) => x.perDay);
  const queue = active.filter((x) => !x.perDay).map((x) => ({ ...x, left: x.minutes, ...(x.from ? { until: addDays(x.from, ANCHOR_SPAN_DAYS - 1) } : {}) }));
  const eligible = (dem, date) => (dem.from ? date >= dem.from && date <= dem.until : date >= from && date <= to);
  const first = [from, ...queue.filter((x) => x.from).map((x) => x.from)].sort()[0];
  const last = [to, ...queue.filter((x) => x.until).map((x) => x.until)].sort().at(-1);
  const entries = [];
  const unallocated = [];
  for (const date of businessDays(first, last, holidays)) {
    const inPeriod = date >= from && date <= to;
    if (!queue.some((x) => x.left > 0) && !(daily.length && inPeriod)) {
      if (date > to) break;
      continue;
    }
    const dayBusy = busy.filter((b) => b.date === date);
    let capacity = schedule.dailyLimit - dayBusy.reduce((sum, b) => sum + (b.endMin - b.startMin), 0);
    const wins = freeWindows(base, dayBusy);
    let wi = 0;
    let cursor = wins[0]?.[0];
    // Aloca até `want` minutos de `dem` nas janelas livres do dia, a partir do cursor.
    const take = (dem, want) => {
      let left = want;
      while (left > 0 && capacity > 0 && wi < wins.length) {
        const [, b] = wins[wi];
        const chunk = Math.min(left, b - cursor, floor15(capacity));
        if (chunk <= 0) { if (cursor >= b) { wi++; cursor = wins[wi]?.[0]; continue; } capacity = 0; break; }
        entries.push({ taskKey: dem.taskKey, model: dem.model, date, start: minToHhmm(cursor), minutes: chunk });
        cursor += chunk;
        capacity -= chunk;
        left -= chunk;
        if (cursor >= b) { wi++; cursor = wins[wi]?.[0]; }
      }
      return left;
    };
    if (inPeriod) {
      for (const dem of daily) {
        const left = take(dem, dem.minutes);
        if (left > 0) unallocated.push({ taskKey: dem.taskKey, minutes: left, date });
      }
    }
    for (const dem of queue) {
      if (dem.left <= 0 || !eligible(dem, date)) continue;
      dem.left = take(dem, dem.left);
      if (dem.left > 0) break; // dia cheio
    }
  }
  for (const x of queue) if (x.left > 0) unallocated.push({ taskKey: x.taskKey, minutes: x.left });
  return { entries, unallocated };
}

export function toJiraStarted(date, hhmm) {
  return `${date}T${hhmm}:00.000${TZ_OFFSET}`;
}

// ---- Datas para o calendário (AAAA-MM-DD, sem fuso) ----
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekRange(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  const from = addDays(date, -((wd + 6) % 7));
  return { from, to: addDays(from, 6) };
}

// 42 dias (6 semanas) a partir da segunda-feira da semana do dia 1º. month: 1–12.
export function monthGrid(year, month) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const start = weekRange(first).from;
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const lastDayOf = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Mês de fechamento: do dia `startDay` do mês anterior ao dia `endDay` do mês informado (1–12).
// Dia que não existe no mês vira o último dia dele (31 em novembro → 30/11).
export function closingPeriod(year, month, startDay, endDay) {
  for (const d of [startDay, endDay]) {
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new RangeError('Dia do fechamento deve ser de 1 a 31.');
  }
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  return {
    from: iso(py, pm, Math.min(startDay, lastDayOf(py, pm))),
    to: iso(year, month, Math.min(endDay, lastDayOf(year, month))),
  };
}

// Indicadores do período: dias úteis (seg–sex sem feriado), trabalhados (úteis com batida),
// a trabalhar (úteis de hoje em diante sem batida), horas previstas, executadas e saldo (minutos).
export function periodIndicators({ from, to, today, entries, holidays = new Set(), dailyLimit }) {
  const days = businessDays(from, to, holidays);
  const inside = entries.filter((x) => x.date >= from && x.date <= to);
  const logged = new Set(inside.filter((x) => x.minutes > 0).map((x) => x.date));
  const executedMin = inside.reduce((s, x) => s + (x.minutes || 0), 0);
  const expectedMin = days.length * dailyLimit;
  return {
    businessDays: days.length,
    worked: days.filter((d) => logged.has(d)).length,
    toWork: days.filter((d) => d >= today && !logged.has(d)).length,
    expectedMin,
    executedMin,
    balanceMin: expectedMin - executedMin,
  };
}
