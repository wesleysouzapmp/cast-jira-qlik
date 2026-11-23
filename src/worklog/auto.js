// Apontamentos automáticos: regras do tipo "SIJUD-123, 09:00, 15m, todo dia útil".
// - Regras em agendamentos.json; resultado de cada dia em agendamentos-log.json (raiz do projeto).
// - O agendador roda a cada minuto, grava os dias úteis pendentes (até 31 dias para trás,
//   nunca antes da data de início) e nunca grava duas vezes o mesmo dia de uma regra.
// - AUTO_WORKLOG=off no .env desliga tudo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addDays, businessDays, hhmmToMin, minToHhmm } from './time.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_COMMENT = 'Participação na reunião diária.';
export const LOOKBACK_DAYS = 31;
export const MAX_RULES = 20;
const RETRY_MS = 15 * 60000;
const HISTORY_MAX = 200;
const OFFSET_MS = 3 * 3600 * 1000;

// ---------- funções puras ----------
export function localNow(ms) {
  const d = new Date(ms - OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// Dias úteis em que a regra já deveria ter gravado (hoje só depois do fim do horário),
// dentro da vigência: data de início até a data de fim (opcional).
export function dueDates({ rule, today, nowMin, holidays = new Set(), lookbackDays = LOOKBACK_DAYS }) {
  if (!rule.enabled) return [];
  const floor = addDays(today, -lookbackDays);
  const from = rule.since > floor ? rule.since : floor;
  const to = rule.until && rule.until < today ? rule.until : today;
  if (from > to) return [];
  const days = businessDays(from, to, holidays);
  if (days.at(-1) === today && nowMin < hhmmToMin(rule.start) + rule.minutes) days.pop();
  return days;
}

// Decide se o horário pode ser gravado, olhando os apontamentos do dia (myWorklogs).
export function checkSlot(slot, existing) {
  const a = hhmmToMin(slot.start);
  const b = a + slot.minutes;
  const sameDay = existing.filter((w) => w.date === slot.date);
  const same = sameDay.find((w) => w.issueKey === slot.taskKey && w.start === slot.start);
  if (same) return { status: 'skipped', message: `já existe apontamento em ${slot.taskKey} às ${slot.start}` };
  const hit = sameDay.find((w) => { const s = hhmmToMin(w.start); return s < b && a < s + w.minutes; });
  if (hit) return { status: 'conflict', message: `horário bate com ${hit.issueKey} ${hit.start}–${minToHhmm(Math.min(hhmmToMin(hit.start) + hit.minutes, 1440))}` };
  return { status: 'ok' };
}

export function nextRun({ rule, today, nowMin, holidays = new Set() }) {
  if (!rule.enabled) return null;
  let from = rule.since > today ? rule.since : today;
  if (from === today && nowMin >= hhmmToMin(rule.start) + rule.minutes) from = addDays(today, 1);
  const last = addDays(from, 30);
  const to = rule.until && rule.until < last ? rule.until : last;
  if (from > to) return null;
  const [d] = businessDays(from, to, holidays);
  return d ? `${d} ${rule.start}` : null;
}

// Texto da tarefa com mês variável: {MM/AAAA}, {MM} e {AAAA} viram o mês/ano do dia apontado.
const PLACEHOLDER_RE = /\{(MM\/AAAA|MM|AAAA)\}/;
export function summaryFor(text, date) {
  const [y, m] = date.split('-');
  return text.replaceAll('{MM/AAAA}', `${m}/${y}`).replaceAll('{MM}', m).replaceAll('{AAAA}', y);
}

// A tarefa da regra é a chave (key) ou o texto do título (summary), nunca os dois.
export function normalizeRule(input = {}, { today }) {
  const { key, start, minutes } = input;
  const summary = typeof input.summary === 'string' ? input.summary.trim().replace(/\s+/g, ' ') : '';
  const hasKey = key !== undefined && key !== null && key !== '';
  if (hasKey && summary) throw new RangeError('Informe a chave ou o texto da tarefa, não os dois.');
  if (!hasKey && !summary) throw new RangeError('Informe a chave (ex.: SIJUD-123) ou o texto da tarefa.');
  if (hasKey && (typeof key !== 'string' || !KEY_RE.test(key))) throw new RangeError('Chave de tarefa inválida (ex.: SIJUD-123).');
  if (summary && (summary.length < 3 || summary.length > 255)) throw new RangeError('Texto da tarefa: de 3 a 255 caracteres.');
  if (typeof start !== 'string' || !HHMM_RE.test(start)) throw new RangeError('Horário inválido (use HH:MM, ex.: 09:00).');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new RangeError('Duração inválida (de 1 minuto a 8h).');
  if (hhmmToMin(start) + minutes > 1440) throw new RangeError('O apontamento tem de terminar no mesmo dia.');
  const since = input.since ?? today;
  if (typeof since !== 'string' || !DATE_RE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) throw new RangeError('Data de início inválida.');
  const until = input.until === undefined || input.until === null || input.until === '' ? null : input.until;
  if (until !== null && (typeof until !== 'string' || !DATE_RE.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`)))) throw new RangeError('Data de fim inválida.');
  if (until !== null && until < since) throw new RangeError('A data de fim não pode ser anterior à data de início.');
  const comment = input.comment === undefined || input.comment === null || String(input.comment).trim() === '' ? DEFAULT_COMMENT : input.comment;
  if (typeof comment !== 'string' || comment.length > 500) throw new RangeError('Comentário: no máximo 500 caracteres.');
  return { key: hasKey ? key : null, summary: summary || null, start, minutes, comment: comment.trim(), since, until, enabled: input.enabled === undefined ? true : Boolean(input.enabled) };
}

// ---------- arquivos ----------
export function createAutoStore({
  file = path.join(ROOT, 'agendamentos.json'),
  logFile = path.join(ROOT, 'agendamentos-log.json'),
  readFile = (f) => fs.promises.readFile(f, 'utf8'),
  writeFile = (f, text) => fs.promises.writeFile(f, text, 'utf8'),
  rename = (a, b) => fs.promises.rename(a, b),
  log = console.warn,
} = {}) {
  async function readJson(f, fallback, check) {
    let text;
    try { text = await readFile(f); } catch (err) {
      if (err?.code !== 'ENOENT') log(`[agendamentos] não foi possível ler ${f}: ${err?.message}`);
      return fallback();
    }
    try {
      const data = JSON.parse(text);
      if (check(data)) return data;
      log(`[agendamentos] ${f} com formato inesperado; ignorado.`);
    } catch (err) {
      log(`[agendamentos] ${f} não é um JSON válido (${err.message}); ignorado.`);
    }
    return fallback();
  }
  async function writeJson(f, data) {
    await writeFile(`${f}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
    await rename(`${f}.tmp`, f);
  }
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  return {
    readRules: () => readJson(file, () => ({ paused: false, rules: [] }), (d) => isObj(d) && Array.isArray(d.rules)),
    writeRules: (d) => writeJson(file, d),
    readLog: () => readJson(logFile, () => ({ done: {}, history: [] }), (d) => isObj(d) && isObj(d.done) && Array.isArray(d.history)),
    writeLog: (d) => writeJson(logFile, d),
  };
}

// ---------- agendador ----------
export function createAutoScheduler({ store, service, holidays, now = () => Date.now(), disabled = false, log = console.log }) {
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const lastError = new Map(); // "id|data" → ms da última falha
  let timer = null;

  const validRule = (r) => r && typeof r.id === 'string' && (() => { try { normalizeRule(r, { today: '2000-01-01' }); return true; } catch { return false; } })();
  async function rules() {
    const d = await store.readRules();
    return { paused: Boolean(d.paused), rules: d.rules.filter(validRule) };
  }
  async function holidaySet(from, to) {
    return new Set((await holidays.between(from, to)).keys());
  }
  // Confere a tarefa da regra no Jira ao salvar. Texto com mês variável sem tarefa no mês: salva com aviso.
  async function checkTarget(rule) {
    if (rule.key) {
      const [t] = await service.describe([rule.key]);
      if (!t.available) throw new RangeError(t.error);
      return {};
    }
    const today = localNow(now()).date;
    const date = rule.since > today ? rule.since : today;
    const text = summaryFor(rule.summary, date);
    const f = await service.findBySummary(text);
    if (f.available) return { resolved: { date, text, key: f.key } };
    if (!PLACEHOLDER_RE.test(rule.summary)) throw new RangeError(f.error);
    return { warning: `${f.error} A regra foi salva; nos dias desse mês o app tenta de novo a cada 15 minutos.` };
  }

  async function tickNow() {
    if (disabled) return [];
    const { paused, rules: list } = await rules();
    if (paused || !list.some((r) => r.enabled)) return [];
    const t = now();
    const { date: today, min: nowMin } = localNow(t);
    const hol = await holidaySet(addDays(today, -LOOKBACK_DAYS), today);
    const logData = await store.readLog();
    const out = [];
    const found = new Map(); // texto → resultado da busca (uma vez por execução)
    const find = async (text) => {
      if (!found.has(text)) found.set(text, await service.findBySummary(text).catch((err) => ({ available: false, error: err?.message ?? String(err) })));
      return found.get(text);
    };
    for (const rule of list) {
      for (const date of dueDates({ rule, today, nowMin, holidays: hol })) {
        const id = `${rule.id}|${date}`;
        if (logData.done[id]) continue;
        if (t - (lastError.get(id) ?? -Infinity) < RETRY_MS) continue;
        let r;
        let taskKey = rule.key;
        let label = rule.key;
        if (rule.summary) {
          const text = summaryFor(rule.summary, date);
          const f = await find(text);
          label = f.available ? f.key : text;
          if (f.available) taskKey = f.key;
          else r = { status: 'error', message: f.error };
        }
        if (!r) {
          const slot = { taskKey, date, start: rule.start, minutes: rule.minutes, comment: rule.comment };
          try { r = await service.autoLog(slot); } catch (err) { r = { status: 'error', message: err?.message ?? String(err) }; }
        }
        const entry = { at: new Date(t).toISOString(), ruleId: rule.id, key: label, date, start: rule.start, minutes: rule.minutes, status: r.status, ...(r.message ? { message: r.message } : {}), ...(r.worklogId ? { worklogId: String(r.worklogId) } : {}) };
        if (r.status === 'error') lastError.set(id, t);
        else { lastError.delete(id); logData.done[id] = { status: r.status, at: entry.at }; }
        logData.history.unshift(entry);
        out.push(entry);
        log(`[agendamentos] ${label} ${date} ${rule.start}: ${r.status}${r.message ? ` — ${r.message}` : ''}`);
      }
    }
    if (out.length) {
      const keep = addDays(today, -(LOOKBACK_DAYS + 10));
      for (const k of Object.keys(logData.done)) if (k.split('|')[1] < keep) delete logData.done[k];
      logData.history = logData.history.slice(0, HISTORY_MAX);
      await store.writeLog(logData);
    }
    return out;
  }

  async function status() {
    const { paused, rules: list } = await rules();
    const { history, done } = await store.readLog();
    const { date: today, min: nowMin } = localNow(now());
    const hol = await holidaySet(today, addDays(today, 60));
    return {
      disabled, paused,
      rules: list.map((r) => {
        const last = history.find((h) => h.ruleId === r.id) ?? null;
        return { ...r, lastRun: last, nextRun: disabled || paused ? null : nextRun({ rule: r, today, nowMin, holidays: hol }), doneCount: Object.keys(done).filter((k) => k.startsWith(`${r.id}|`)).length };
      }),
      history: history.slice(0, 50),
    };
  }

  return {
    tick: () => serial(tickNow),
    status: () => serial(status),
    addRule: (input) => serial(async () => {
      const rule = normalizeRule(input, { today: localNow(now()).date });
      const check = await checkTarget(rule);
      const d = await rules();
      if (d.rules.length >= MAX_RULES) throw new RangeError(`No máximo ${MAX_RULES} regras.`);
      const created = { id: crypto.randomUUID().slice(0, 8), ...rule };
      await store.writeRules({ paused: d.paused, rules: [...d.rules, created] });
      return { ...created, ...check };
    }),
    updateRule: (id, input) => serial(async () => {
      const d = await rules();
      const i = d.rules.findIndex((r) => r.id === id);
      if (i < 0) throw new RangeError('Regra não encontrada.');
      const rule = normalizeRule(input, { today: localNow(now()).date });
      const prev = d.rules[i];
      const check = rule.key !== prev.key || rule.summary !== (prev.summary ?? null) || rule.since !== prev.since ? await checkTarget(rule) : {};
      d.rules[i] = { id, ...rule };
      await store.writeRules(d);
      // Conflitos e erros dessa regra voltam a ser tentados com a regra nova.
      const logData = await store.readLog();
      let changed = false;
      for (const [k, v] of Object.entries(logData.done)) if (k.startsWith(`${id}|`) && v.status === 'conflict') { delete logData.done[k]; changed = true; }
      if (changed) await store.writeLog(logData);
      for (const k of lastError.keys()) if (k.startsWith(`${id}|`)) lastError.delete(k);
      return { ...d.rules[i], ...check };
    }),
    removeRule: (id) => serial(async () => {
      const d = await rules();
      if (!d.rules.some((r) => r.id === id)) throw new RangeError('Regra não encontrada.');
      await store.writeRules({ paused: d.paused, rules: d.rules.filter((r) => r.id !== id) });
    }),
    setPaused: (paused) => serial(async () => {
      const d = await rules();
      await store.writeRules({ ...d, paused: Boolean(paused) });
    }),
    start(intervalMs = 60000) {
      if (timer || disabled) return;
      const run = () => this.tick().catch((err) => log(`[agendamentos] falha: ${err?.message}`));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
