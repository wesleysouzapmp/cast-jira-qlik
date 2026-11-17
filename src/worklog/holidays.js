// Feriados: nacionais calculados (inclusive os que dependem da Páscoa) + lista local
// editável em feriados.json, na raiz do projeto (relida a cada consulta).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDays } from './time.js';

const DEFAULT_FILE = fileURLToPath(new URL('../../feriados.json', import.meta.url));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FIXED = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['12-25', 'Natal'],
];

// Algoritmo de Meeus/Jones/Butcher (calendário gregoriano).
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function nationalHolidays(year) {
  const easter = easterSunday(year);
  return [
    ...FIXED.map(([md, name]) => ({ date: `${year}-${md}`, name })),
    { date: addDays(easter, -48), name: 'Carnaval' },
    { date: addDays(easter, -47), name: 'Carnaval' },
    { date: addDays(easter, -2), name: 'Sexta-feira Santa' },
    { date: addDays(easter, 60), name: 'Corpus Christi' },
  ].sort((x, y) => x.date.localeCompare(y.date));
}

const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function expandCustom(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? 'Feriado');
    if (item.date !== undefined) {
      if (validDate(item.date)) out.push({ date: item.date, name });
      continue;
    }
    if (!validDate(item.from) || !validDate(item.to) || item.from > item.to) continue;
    for (let d = item.from; d <= item.to; d = addDays(d, 1)) out.push({ date: d, name });
  }
  return out;
}

export function holidaysBetween(from, to, custom = []) {
  const map = new Map();
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of nationalHolidays(y)) if (h.date >= from && h.date <= to) map.set(h.date, h.name);
  }
  for (const h of expandCustom(custom)) if (h.date >= from && h.date <= to) map.set(h.date, h.name);
  return map;
}

export function createHolidayProvider({ file = DEFAULT_FILE, readFile = (f) => fs.promises.readFile(f, 'utf8'), log = console.warn } = {}) {
  async function loadCustom() {
    let text;
    try {
      text = await readFile(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`[feriados] não foi possível ler ${file}: ${err?.message}`);
      return [];
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      log(`[feriados] ${file} não é um JSON válido (${err.message}); usando só os feriados nacionais.`);
      return [];
    }
  }
  return { async between(from, to) { return holidaysBetween(from, to, await loadCustom()); } };
}
