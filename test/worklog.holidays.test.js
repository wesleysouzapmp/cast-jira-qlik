import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easterSunday, nationalHolidays, expandCustom, holidaysBetween, createHolidayProvider } from '../src/worklog/holidays.js';

test('easterSunday', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2024), '2024-03-31');
});

test('nationalHolidays de 2026', () => {
  const h = nationalHolidays(2026);
  assert.equal(h.length, 13);
  const has = (date, name) => assert.ok(h.some((x) => x.date === date && x.name === name), `${date} ${name}`);
  has('2026-02-16', 'Carnaval');
  has('2026-02-17', 'Carnaval');
  has('2026-04-03', 'Sexta-feira Santa');
  has('2026-06-04', 'Corpus Christi');
  has('2026-11-02', 'Finados');
  has('2026-11-20', 'Dia Nacional de Zumbi e da Consciência Negra');
  has('2026-01-01', 'Confraternização Universal');
});

test('expandCustom expande períodos e ignora inválidos', () => {
  const r = expandCustom([
    { from: '2026-12-30', to: '2027-01-02', name: 'R' },
    { date: 'x', name: 'ruim' },
    { from: '2026-12-02', to: '2026-12-01', name: 'invertido' },
    null,
    { date: '2026-08-15', name: 'Assunção' },
  ]);
  assert.deepEqual(r.map((x) => x.date), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2026-08-15']);
});

test('holidaysBetween junta nacionais e locais; local prevalece', () => {
  const m = holidaysBetween('2026-11-01', '2026-11-30', [{ date: '2026-11-02', name: 'Finados (TJMG)' }]);
  assert.equal(m.get('2026-11-02'), 'Finados (TJMG)');
  assert.ok(m.has('2026-11-15'));
  assert.ok(m.has('2026-11-20'));
  assert.ok(!m.has('2026-10-12'));
});

test('holidaysBetween cobre virada de ano', () => {
  const m = holidaysBetween('2026-12-20', '2027-01-05');
  assert.ok(m.has('2026-12-25'));
  assert.ok(m.has('2027-01-01'));
});

test('provider: arquivo ausente usa só nacionais, sem aviso', async () => {
  const logs = [];
  const p = createHolidayProvider({ readFile: async () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; }, log: (m) => logs.push(m) });
  const m = await p.between('2026-11-01', '2026-11-30');
  assert.ok(m.has('2026-11-02'));
  assert.equal(logs.length, 0);
});

test('provider: JSON inválido avisa e segue', async () => {
  const logs = [];
  const p = createHolidayProvider({ readFile: async () => '{ruim', log: (m) => logs.push(m) });
  const m = await p.between('2026-11-01', '2026-11-30');
  assert.ok(m.has('2026-11-02'));
  assert.equal(logs.length, 1);
});

test('provider relê o arquivo a cada chamada', async () => {
  let n = 0;
  const p = createHolidayProvider({ readFile: async () => { n++; return JSON.stringify([{ date: '2026-11-03', name: 'Local' }]); } });
  assert.equal((await p.between('2026-11-01', '2026-11-30')).get('2026-11-03'), 'Local');
  await p.between('2026-11-01', '2026-11-30');
  assert.equal(n, 2);
});
