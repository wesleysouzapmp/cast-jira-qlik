import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { favoritesFor, autoStoreFor, exportLegacy, importLegacy } from '../src/db/userData.js';

function setup() {
  const db = openDb();
  const users = createUserRepo(db, randomBytes(32));
  const a = users.create({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const b = users.create({ email: 'b@x.com', name: 'B', passwordHash: 'h' });
  return { db, a, b };
}

const RULES = {
  paused: true,
  rules: [
    { id: 'a1b2c3d4', key: 'SIJUD-1', summary: null, start: '09:00', minutes: 15, comment: 'Daily', since: '2026-11-03', until: null, enabled: true },
    { id: 'ffee0011', key: null, summary: 'Daily - {MM/AAAA}', start: '13:30', minutes: 30, comment: 'x', since: '2026-11-01', until: '2026-12-31', enabled: false },
  ],
};

test('favoritos: isolados por usuário, mesmas regras e mensagens', async () => {
  const { db, a, b } = setup();
  const fa = favoritesFor(db, a.id);
  const fb = favoritesFor(db, b.id);
  assert.deepEqual(await fa.add('SIJUD-1'), ['SIJUD-1']);
  assert.deepEqual(await fa.add('BI-2'), ['SIJUD-1', 'BI-2']);
  assert.deepEqual(await fa.add('SIJUD-1'), ['SIJUD-1', 'BI-2'], 'sem duplicar');
  assert.deepEqual(await fb.list(), []);
  await fb.add('BI-9');
  assert.deepEqual(await fa.list(), ['SIJUD-1', 'BI-2']);
  assert.deepEqual(await fa.remove('SIJUD-1'), ['BI-2']);
  assert.deepEqual(await fb.list(), ['BI-9']);
  await assert.rejects(fa.add('abc'), (e) => e instanceof RangeError && e.message === 'Chave de tarefa inválida.');
  await assert.rejects(fa.add(5), /inválida/);
});

test('favoritos: limite de 50', async () => {
  const { db, a } = setup();
  const f = favoritesFor(db, a.id);
  for (let i = 1; i <= 50; i++) await f.add(`BI-${i}`);
  await assert.rejects(f.add('BI-51'), (e) => e instanceof RangeError && e.message === 'No máximo 50 favoritos.');
  assert.equal((await f.add('BI-1')).length, 50);
});

test('regras: padrão vazio e ida e volta idêntica com ids preservados', async () => {
  const { db, a } = setup();
  const s = autoStoreFor(db, a.id);
  assert.deepEqual(await s.readRules(), { paused: false, rules: [] });
  await s.writeRules(RULES);
  assert.deepEqual(await s.readRules(), RULES);
  await s.writeRules({ paused: false, rules: [RULES.rules[1]] });
  assert.deepEqual(await s.readRules(), { paused: false, rules: [RULES.rules[1]] });
});

test('regras: usuários não enxergam as regras um do outro', async () => {
  const { db, a, b } = setup();
  const sa = autoStoreFor(db, a.id);
  const sb = autoStoreFor(db, b.id);
  await sa.writeRules(RULES);
  assert.deepEqual(await sb.readRules(), { paused: false, rules: [] });
  await sb.writeRules({ paused: true, rules: [] });
  assert.deepEqual(await sa.readRules(), RULES);
  assert.deepEqual(await sb.readLog(), { done: {}, history: [] });
});

test('log: ida e volta de done/history, e regravar regras não apaga o done', async () => {
  const { db, a } = setup();
  const s = autoStoreFor(db, a.id);
  await s.writeRules(RULES);
  const log = {
    done: { 'a1b2c3d4|2026-11-03': { status: 'created', at: '2026-11-03T12:15:00.000Z' }, 'ffee0011|2026-11-04': { status: 'conflict', at: '2026-11-04T12:15:00.000Z' } },
    history: [
      { at: '2026-11-04T12:15:00.000Z', ruleId: 'ffee0011', key: 'SIJUD-5', date: '2026-11-04', start: '13:30', minutes: 30, status: 'conflict', message: 'bate' },
      { at: '2026-11-03T12:15:00.000Z', ruleId: 'a1b2c3d4', key: 'SIJUD-1', date: '2026-11-03', start: '09:00', minutes: 15, status: 'created', worklogId: '77' },
    ],
  };
  await s.writeLog(log);
  assert.deepEqual(await s.readLog(), log);
  await s.writeRules(RULES);
  assert.deepEqual((await s.readLog()).done, log.done);
  await s.writeRules({ paused: false, rules: [RULES.rules[0]] });
  assert.deepEqual(Object.keys((await s.readLog()).done), ['a1b2c3d4|2026-11-03']);
});

test('log: 250 registros guardam os 200 mais novos', async () => {
  const { db, a, b } = setup();
  const s = autoStoreFor(db, a.id);
  const history = [];
  for (let i = 250; i >= 1; i--) history.push({ at: new Date(i * 60000).toISOString(), ruleId: 'r', key: 'BI-1', date: '2026-11-03', start: '09:00', minutes: 15, status: 'created' });
  await s.writeLog({ done: {}, history });
  const out = (await s.readLog()).history;
  assert.equal(out.length, 200);
  assert.equal(out[0].at, new Date(250 * 60000).toISOString());
  assert.equal(out[199].at, new Date(51 * 60000).toISOString());
  assert.deepEqual((await autoStoreFor(db, b.id).readLog()).history, []);
});

test('legado: export/import preservam ids e done, e importar duas vezes não duplica', async () => {
  const { db, a, b } = setup();
  const legacy = {
    rules: RULES,
    log: {
      done: { 'a1b2c3d4|2026-11-03': { status: 'created', at: '2026-11-03T12:15:00.000Z' } },
      history: [{ at: '2026-11-03T12:15:00.000Z', ruleId: 'a1b2c3d4', key: 'SIJUD-1', date: '2026-11-03', start: '09:00', minutes: 15, status: 'created' }],
    },
    favorites: ['SIJUD-1', 'BI-2'],
  };
  importLegacy(db, a.id, legacy);
  importLegacy(db, a.id, legacy);
  assert.deepEqual(exportLegacy(db, a.id), legacy);
  assert.deepEqual(exportLegacy(db, b.id), { rules: { paused: false, rules: [] }, log: { done: {}, history: [] }, favorites: [] });
});
