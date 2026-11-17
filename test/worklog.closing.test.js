import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingPeriod, periodIndicators } from '../src/worklog/time.js';

test('closingPeriod: dia inicial do mês anterior ao dia final do mês', () => {
  assert.deepEqual(closingPeriod(2026, 11, 21, 20), { from: '2026-10-21', to: '2026-11-20' });
});

test('closingPeriod: vira o ano em janeiro', () => {
  assert.deepEqual(closingPeriod(2027, 1, 21, 20), { from: '2026-12-21', to: '2027-01-20' });
});

test('closingPeriod: dia inexistente vira o último dia do mês', () => {
  assert.deepEqual(closingPeriod(2026, 11, 31, 31), { from: '2026-10-31', to: '2026-11-30' });
  assert.deepEqual(closingPeriod(2026, 3, 30, 31), { from: '2026-02-28', to: '2026-03-31' });
});

test('closingPeriod: rejeita dias fora de 1 a 31', () => {
  assert.throws(() => closingPeriod(2026, 11, 0, 20));
  assert.throws(() => closingPeriod(2026, 11, 21, 32));
  assert.throws(() => closingPeriod(2026, 11, 2.5, 20));
});

const e = (date, minutes) => ({ date, minutes });

test('periodIndicators: período atual com feriado, batida no sábado e dias restantes', () => {
  // 02/11 a 13/11/2026: 10 dias de semana; 02/11 é Finados → 9 úteis.
  const r = periodIndicators({
    from: '2026-11-02', to: '2026-11-13', today: '2026-11-10', dailyLimit: 480,
    holidays: new Set(['2026-11-02']),
    entries: [e('2026-11-03', 480), e('2026-11-04', 240), e('2026-11-04', 60), e('2026-11-07', 120), e('2026-11-11', 30)],
  });
  assert.deepEqual(r, {
    businessDays: 9,
    worked: 3, // 03, 04 e 11 (sábado 07 não é dia útil)
    toWork: 3, // 10, 12 e 13 (11 já tem batida)
    expectedMin: 9 * 480,
    executedMin: 480 + 300 + 120 + 30,
    balanceMin: 9 * 480 - 930,
  });
});

test('periodIndicators: período passado não tem dias a trabalhar; futuro tem todos', () => {
  const base = { from: '2026-11-16', to: '2026-11-20', dailyLimit: 480, holidays: new Set(['2026-11-20']), entries: [] };
  assert.equal(periodIndicators({ ...base, today: '2026-12-01' }).toWork, 0);
  const fut = periodIndicators({ ...base, today: '2026-11-10' });
  assert.equal(fut.businessDays, 4);
  assert.equal(fut.toWork, 4);
  assert.equal(fut.balanceMin, 4 * 480);
});

test('periodIndicators: ignora batidas fora do período e saldo negativo quando excede', () => {
  const r = periodIndicators({
    from: '2026-11-09', to: '2026-11-09', today: '2026-11-09', dailyLimit: 480, holidays: new Set(),
    entries: [e('2026-11-09', 540), e('2026-11-10', 60)],
  });
  assert.equal(r.executedMin, 540);
  assert.equal(r.balanceMin, -60);
  assert.equal(r.toWork, 0);
});
