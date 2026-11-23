import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNow, dueDates, checkSlot, nextRun, normalizeRule, summaryFor } from '../src/worklog/auto.js';

const rule = (o = {}) => ({ id: 'r1', key: 'SIJUD-1', start: '09:00', minutes: 15, comment: 'Daily', since: '2026-11-02', enabled: true, ...o });

test('localNow converte para o fuso -03:00', () => {
  assert.deepEqual(localNow(Date.parse('2026-11-10T12:30:00Z')), { date: '2026-11-10', min: 9 * 60 + 30 });
  assert.deepEqual(localNow(Date.parse('2026-11-11T01:00:00Z')), { date: '2026-11-10', min: 22 * 60 });
});

test('dueDates: dias úteis desde "a partir de", pulando feriados e o dia de hoje antes do fim da reunião', () => {
  const holidays = new Set(['2026-11-04']);
  // terça 10/11, 09:10: a reunião (09:00–09:15) ainda não terminou
  assert.deepEqual(dueDates({ rule: rule(), today: '2026-11-10', nowMin: 9 * 60 + 10, holidays }), ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09']);
  // às 09:15 hoje também entra
  assert.equal(dueDates({ rule: rule(), today: '2026-11-10', nowMin: 9 * 60 + 15, holidays }).at(-1), '2026-11-10');
});

test('dueDates: no máximo 31 dias para trás; regra pausada ou futura não gera nada', () => {
  const d = dueDates({ rule: rule({ since: '2026-01-01' }), today: '2026-11-10', nowMin: 0, holidays: new Set() });
  assert.equal(d[0], '2026-10-12'); // 10/10 é sábado; primeiro dia útil dentro de 31 dias
  assert.deepEqual(dueDates({ rule: rule({ enabled: false }), today: '2026-11-10', nowMin: 1000, holidays: new Set() }), []);
  assert.deepEqual(dueDates({ rule: rule({ since: '2026-11-20' }), today: '2026-11-10', nowMin: 1000, holidays: new Set() }), []);
});

test('checkSlot: mesmo início na mesma tarefa → pulado; sobreposição → conflito; livre → ok', () => {
  const slot = { taskKey: 'SIJUD-1', date: '2026-11-09', start: '09:00', minutes: 15 };
  assert.equal(checkSlot(slot, []).status, 'ok');
  assert.equal(checkSlot(slot, [{ issueKey: 'SIJUD-1', date: '2026-11-09', start: '09:00', minutes: 30 }]).status, 'skipped');
  const c = checkSlot(slot, [{ issueKey: 'QSENSE-1', date: '2026-11-09', start: '08:30', minutes: 45 }]);
  assert.equal(c.status, 'conflict');
  assert.match(c.message, /QSENSE-1 08:30/);
  // encostado (termina às 09:00) não conflita; outro dia também não
  assert.equal(checkSlot(slot, [{ issueKey: 'X-1', date: '2026-11-09', start: '08:00', minutes: 60 }, { issueKey: 'X-1', date: '2026-11-10', start: '09:00', minutes: 60 }]).status, 'ok');
});

test('nextRun: hoje se ainda não passou; senão o próximo dia útil', () => {
  const h = new Set(['2026-11-13']);
  assert.equal(nextRun({ rule: rule(), today: '2026-11-10', nowMin: 8 * 60, holidays: h }), '2026-11-10 09:00');
  assert.equal(nextRun({ rule: rule(), today: '2026-11-12', nowMin: 10 * 60, holidays: h }), '2026-11-16 09:00');
  assert.equal(nextRun({ rule: rule({ since: '2026-11-20' }), today: '2026-11-10', nowMin: 0, holidays: h }), '2026-11-20 09:00');
  assert.equal(nextRun({ rule: rule({ enabled: false }), today: '2026-11-10', nowMin: 0, holidays: h }), null);
});

test('normalizeRule valida e preenche o padrão', () => {
  const r = normalizeRule({ key: 'SIJUD-27633', start: '09:00', minutes: 15 }, { today: '2026-11-10' });
  assert.deepEqual(r, { key: 'SIJUD-27633', start: '09:00', minutes: 15, comment: 'Participação na reunião diária.', since: '2026-11-10', until: null, enabled: true, summary: null });
  assert.equal(normalizeRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10', until: '2026-12-19' }, { today: '2026-11-10' }).until, '2026-12-19');
  assert.equal(normalizeRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, until: '' }, { today: '2026-11-10' }).until, null);
  for (const bad of [
    { key: 'sijud-1', start: '09:00', minutes: 15 },
    { key: 'SIJUD-1', start: '9h', minutes: 15 },
    { key: 'SIJUD-1', start: '24:00', minutes: 15 },
    { key: 'SIJUD-1', start: '09:00', minutes: 0 },
    { key: 'SIJUD-1', start: '09:00', minutes: 481 },
    { key: 'SIJUD-1', start: '23:50', minutes: 15 },
    { key: 'SIJUD-1', start: '09:00', minutes: 15, since: '10/11/2026' },
    { key: 'SIJUD-1', start: '09:00', minutes: 15, comment: 'x'.repeat(501) },
    { key: 'SIJUD-1', start: '09:00', minutes: 15, since: '2026-11-10', until: '2026-11-09' },
    { key: 'SIJUD-1', start: '09:00', minutes: 15, until: '31/12/2026' },
  ]) assert.throws(() => normalizeRule(bad, { today: '2026-11-10' }), RangeError, JSON.stringify(bad));
});

test('data de fim: não grava depois dela e a próxima execução some quando ela passa', () => {
  const r = rule({ since: '2026-11-02', until: '2026-11-05' });
  assert.deepEqual(dueDates({ rule: r, today: '2026-11-10', nowMin: 1000, holidays: new Set() }), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  assert.equal(nextRun({ rule: r, today: '2026-11-10', nowMin: 0, holidays: new Set() }), null);
  assert.equal(nextRun({ rule: rule({ until: '2026-11-11' }), today: '2026-11-10', nowMin: 10 * 60, holidays: new Set() }), '2026-11-11 09:00');
  assert.equal(nextRun({ rule: rule({ until: '2026-11-10' }), today: '2026-11-10', nowMin: 10 * 60, holidays: new Set() }), null);
  // fim num feriado/fim de semana: não há próximo dia útil dentro da vigência
  assert.equal(nextRun({ rule: rule({ until: '2026-11-15' }), today: '2026-11-13', nowMin: 10 * 60, holidays: new Set() }), null);
});

test('summaryFor troca {MM/AAAA}, {MM} e {AAAA} pelo mês do dia', () => {
  assert.equal(summaryFor('Daily COSARQ - BI - {MM/AAAA}', '2026-12-03'), 'Daily COSARQ - BI - 12/2026');
  assert.equal(summaryFor('Daily {MM}-{AAAA}', '2027-01-15'), 'Daily 01-2027');
  assert.equal(summaryFor('Daily fixa', '2026-11-10'), 'Daily fixa');
});

test('normalizeRule aceita texto da tarefa no lugar da chave', () => {
  const r = normalizeRule({ summary: '  Daily COSARQ - BI - {MM/AAAA} ', start: '13:30', minutes: 30 }, { today: '2026-11-10' });
  assert.equal(r.key, null);
  assert.equal(r.summary, 'Daily COSARQ - BI - {MM/AAAA}');
  assert.throws(() => normalizeRule({ start: '13:30', minutes: 30 }, { today: '2026-11-10' }), RangeError);
  assert.throws(() => normalizeRule({ key: 'SIJUD-1', summary: 'Daily', start: '13:30', minutes: 30 }, { today: '2026-11-10' }), RangeError);
  assert.throws(() => normalizeRule({ summary: 'ab', start: '13:30', minutes: 30 }, { today: '2026-11-10' }), RangeError);
  assert.throws(() => normalizeRule({ summary: 'x'.repeat(256), start: '13:30', minutes: 30 }, { today: '2026-11-10' }), RangeError);
});
