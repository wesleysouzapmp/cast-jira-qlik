import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribute, DEFAULT_SCHEDULE } from '../src/worklog/time.js';

const S = DEFAULT_SCHEDULE;
const strip = (es) => es.map((e) => `${e.date} ${e.start} ${e.minutes} ${e.taskKey}`);
const perDay = (minutes, taskKey = 'Q-1') => ({ taskKey, model: 'analise', minutes, perDay: true });
const total = (minutes, taskKey = 'Q-2') => ({ taskKey, model: 'implementacao', minutes });

test('perDay: as mesmas horas em cada dia útil, pulando fim de semana e feriado', () => {
  // 06/11 (sex), 07–08 fim de semana, 09 (seg), 10 (ter, feriado no teste)
  const r = distribute({ demands: [perDay(120)], from: '2026-11-06', to: '2026-11-10', schedule: S, holidays: new Set(['2026-11-10']) });
  assert.deepEqual(strip(r.entries), ['2026-11-06 08:00 120 Q-1', '2026-11-09 08:00 120 Q-1']);
  assert.deepEqual(r.unallocated, []);
});

test('perDay: desvia de batida existente no dia', () => {
  const busy = [{ date: '2026-11-09', startMin: 8 * 60, endMin: 9 * 60 }];
  const r = distribute({ demands: [perDay(120)], from: '2026-11-09', to: '2026-11-09', schedule: S, busy });
  assert.deepEqual(strip(r.entries), ['2026-11-09 09:00 120 Q-1']);
});

test('perDay: dia sem espaço vira horas não alocadas com a data', () => {
  const busy = [{ date: '2026-11-09', startMin: 8 * 60, endMin: 12 * 60 }, { date: '2026-11-09', startMin: 13 * 60, endMin: 16 * 60 + 30 }];
  const r = distribute({ demands: [perDay(120)], from: '2026-11-09', to: '2026-11-10', schedule: S, busy });
  // limite 8h: 7h30 já ocupadas → cabem 30m em 09/11
  assert.deepEqual(strip(r.entries), ['2026-11-09 16:30 30 Q-1', '2026-11-10 08:00 120 Q-1']);
  assert.deepEqual(r.unallocated, [{ taskKey: 'Q-1', minutes: 90, date: '2026-11-09' }]);
});

test('perDay entra antes do total; o total usa o que sobra de cada dia', () => {
  const r = distribute({ demands: [total(480), perDay(360)], from: '2026-11-09', to: '2026-11-10', schedule: S });
  assert.deepEqual(strip(r.entries), [
    '2026-11-09 08:00 240 Q-1', '2026-11-09 13:00 120 Q-1', '2026-11-09 15:00 120 Q-2',
    '2026-11-10 08:00 240 Q-1', '2026-11-10 13:00 120 Q-1', '2026-11-10 15:00 120 Q-2',
  ]);
  assert.deepEqual(r.unallocated, [{ taskKey: 'Q-2', minutes: 240 }]);
});

test('perDay: duas tarefas por dia somadas respeitam o limite diário', () => {
  const r = distribute({ demands: [perDay(300, 'Q-1'), perDay(300, 'Q-3')], from: '2026-11-09', to: '2026-11-09', schedule: S });
  assert.deepEqual(strip(r.entries), ['2026-11-09 08:00 240 Q-1', '2026-11-09 13:00 60 Q-1', '2026-11-09 14:00 180 Q-3']);
  assert.deepEqual(r.unallocated, [{ taskKey: 'Q-3', minutes: 120, date: '2026-11-09' }]);
});
