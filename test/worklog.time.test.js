import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, splitTotal, businessDays, distribute, toJiraStarted, DEFAULT_SCHEDULE } from '../src/worklog/time.js';

const S = DEFAULT_SCHEDULE;
const d = (minutes, taskKey = 'Q-1', model = 'analise') => ({ taskKey, model, minutes });
const strip = (es) => es.map((e) => `${e.date} ${e.start} ${e.minutes} ${e.taskKey}`);

test('parseDuration aceita formatos e arredonda para 15', () => {
  const cases = { '1h 30m': 90, '1h': 60, '45m': 45, '90m': 90, '1,5': 90, '1.5': 90, '1:30': 90, '1h 20m': 75, ' 2H ': 120, '8': 480 };
  for (const [k, v] of Object.entries(cases)) assert.equal(parseDuration(k), v, k);
  for (const bad of ['', '0', '-1', 'abc', '201h', '5m', null, undefined]) assert.equal(parseDuration(bad), null, String(bad));
});

test('formatDuration no formato do Jira', () => {
  assert.equal(formatDuration(90), '1h 30m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(615), '10h 15m');
});

test('splitTotal soma exata em blocos de 15', () => {
  assert.deepEqual(splitTotal(240, 30), { analise: 75, implementacao: 165 });
  assert.deepEqual(splitTotal(60, 0), { analise: 0, implementacao: 60 });
  assert.deepEqual(splitTotal(60, 100), { analise: 60, implementacao: 0 });
  for (const [t, p] of [[195, 33], [15, 50], [480, 70]]) {
    const r = splitTotal(t, p);
    assert.equal(r.analise + r.implementacao, t);
    assert.equal(r.analise % 15, 0);
  }
});

test('businessDays pula fim de semana', () => {
  assert.deepEqual(businessDays('2026-11-06', '2026-11-10'), ['2026-11-06', '2026-11-09', '2026-11-10']);
  assert.deepEqual(businessDays('2026-11-07', '2026-11-08'), []);
});

test('distribute simples', () => {
  const r = distribute({ demands: [d(120)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 120 Q-1']);
  assert.deepEqual(r.unallocated, []);
});

test('distribute quebra no almoço', () => {
  const r = distribute({ demands: [d(300)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 240 Q-1', '2026-11-09 13:00 60 Q-1']);
});

test('distribute continua no dia seguinte e pula fim de semana', () => {
  const r = distribute({ demands: [d(600)], from: '2026-11-06', to: '2026-11-10', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-06 08:00 240 Q-1', '2026-11-06 13:00 240 Q-1', '2026-11-09 08:00 120 Q-1']);
});

test('distribute desvia de apontamento existente', () => {
  const busy = [{ date: '2026-11-09', startMin: 9 * 60, endMin: 10 * 60 }];
  const r = distribute({ demands: [d(120)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 60 Q-1', '2026-11-09 10:00 60 Q-1']);
});

test('distribute arredonda janela após apontamento quebrado', () => {
  const busy = [{ date: '2026-11-09', startMin: 8 * 60, endMin: 12 * 60 }, { date: '2026-11-09', startMin: 11 * 60 + 50, endMin: 13 * 60 + 10 }];
  const r = distribute({ demands: [d(60)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy });
  assert.deepEqual(strip(r.entries), ['2026-11-09 13:15 60 Q-1']);
});

test('distribute respeita limite diário já consumido', () => {
  const busy = [{ date: '2026-11-09', startMin: 8 * 60, endMin: 12 * 60 }, { date: '2026-11-09', startMin: 13 * 60, endMin: 16 * 60 }];
  const r = distribute({ demands: [d(120)], from: '2026-11-09', to: '2026-11-10', schedule: { ...S, dailyLimit: 480 }, busy });
  assert.deepEqual(strip(r.entries), ['2026-11-09 16:00 60 Q-1', '2026-11-10 08:00 60 Q-1']);
  const r2 = distribute({ demands: [d(120)], from: '2026-11-09', to: '2026-11-09', schedule: { ...S, dailyLimit: 420 }, busy });
  assert.deepEqual(r2.entries, []);
  assert.deepEqual(r2.unallocated, [{ taskKey: 'Q-1', minutes: 120 }]);
});

test('distribute mantém a ordem das demandas', () => {
  const r = distribute({ demands: [d(60, 'Q-1', 'analise'), d(60, 'Q-2', 'implementacao')], from: '2026-11-09', to: '2026-11-09', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 60 Q-1', '2026-11-09 09:00 60 Q-2']);
});

test('distribute devolve o que não coube', () => {
  const r = distribute({ demands: [d(1000)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy: [] });
  assert.equal(r.entries.reduce((s, e) => s + e.minutes, 0), 480);
  assert.deepEqual(r.unallocated, [{ taskKey: 'Q-1', minutes: 520 }]);
});

// Dividir total: a demanda com dia (from) começa nele e o que sobra vai para os próximos dias úteis, mesmo após o "até".
test('distribute com dia começa no dia escolhido e respeita 8h somando os outros apontamentos', () => {
  const busy = [{ date: '2026-11-12', startMin: 8 * 60, endMin: 11 * 60 }];
  const r = distribute({ demands: [{ ...d(360), from: '2026-11-12' }], from: '2026-11-09', to: '2026-11-13', schedule: S, busy });
  assert.deepEqual(strip(r.entries), ['2026-11-12 11:00 60 Q-1', '2026-11-12 13:00 240 Q-1', '2026-11-13 08:00 60 Q-1']);
  assert.deepEqual(r.unallocated, []);
});

test('distribute com dia passa a sobra para o próximo dia útil mesmo depois do até', () => {
  const r = distribute({ demands: [{ ...d(600, 'Q-1'), from: '2026-11-13' }], from: '2026-11-13', to: '2026-11-13', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-13 08:00 240 Q-1', '2026-11-13 13:00 240 Q-1', '2026-11-16 08:00 120 Q-1']);
});

test('distribute com dia convive com demanda do período', () => {
  const r = distribute({ demands: [d(60, 'Q-9', 'avulsa'), { ...d(60, 'Q-1'), from: '2026-11-10' }, { ...d(60, 'Q-2', 'implementacao'), from: '2026-11-10' }], from: '2026-11-09', to: '2026-11-13', schedule: S, busy: [] });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 60 Q-9', '2026-11-10 08:00 60 Q-1', '2026-11-10 09:00 60 Q-2']);
});

test('distribute com dia não passa de 31 dias a partir do dia', () => {
  const r = distribute({ demands: [{ ...d(200 * 60), from: '2026-11-09' }], from: '2026-11-09', to: '2026-11-09', schedule: S, busy: [] });
  assert.ok(r.entries.every((e) => e.date <= '2026-12-09'));
  assert.equal(r.unallocated.length, 1);
  assert.equal(r.unallocated[0].minutes, 200 * 60 - r.entries.reduce((n, e) => n + e.minutes, 0));
});

test('toJiraStarted', () => {
  assert.equal(toJiraStarted('2026-11-04', '08:00'), '2026-11-04T08:00:00.000-0300');
});

import { addDays, weekRange, monthGrid } from '../src/worklog/time.js';

test('addDays atravessa mês e ano', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
});

test('weekRange vai de segunda a domingo', () => {
  assert.deepEqual(weekRange('2026-11-10'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(weekRange('2026-11-15'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(weekRange('2026-11-09'), { from: '2026-11-09', to: '2026-11-15' });
});

test('monthGrid tem 42 dias começando na segunda', () => {
  const g = monthGrid(2026, 11); // novembro/2026 começa num domingo
  assert.equal(g.length, 42);
  assert.equal(g[0], '2026-10-26');
  assert.equal(g[6], '2026-11-01');
  assert.equal(g[41], '2026-12-06');
  const fev = monthGrid(2027, 2); // fevereiro/2027 começa numa segunda
  assert.equal(fev[0], '2027-02-01');
});

test('businessDays e distribute pulam feriados', () => {
  assert.deepEqual(businessDays('2026-11-02', '2026-11-03', new Set(['2026-11-02'])), ['2026-11-03']);
  const r = distribute({ demands: [d(60)], from: '2026-11-09', to: '2026-11-10', schedule: S, busy: [], holidays: new Set(['2026-11-09']) });
  assert.deepEqual(strip(r.entries), ['2026-11-10 08:00 60 Q-1']);
});
