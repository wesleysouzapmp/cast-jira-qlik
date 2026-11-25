import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';

function fakeScheduler() {
  const calls = [];
  return {
    calls,
    async status() { return { disabled: false, paused: false, rules: [], history: [] }; },
    async addRule(b) { calls.push(['add', b]); if (b.start === 'x') throw new RangeError('Horário inválido'); return { id: 'r1', ...b }; },
    async updateRule(id, b) { calls.push(['update', id, b]); if (id !== 'r1') throw new RangeError('Regra não encontrada.'); return { id, ...b }; },
    async removeRule(id) { calls.push(['remove', id]); },
    async setPaused(p) { calls.push(['paused', p]); },
    async tick() { calls.push(['tick']); return [{ status: 'created' }]; },
  };
}

async function start(scheduler, services = { client: { async call() { return { ok: true, status: 200, data: {} }; } }, worklogService: {} }) {
  const t = await makeTestApp({ services, scheduler });
  return t.json;
}

test('rotas de apontamentos automáticos', async () => {
  const s = fakeScheduler();
  const req = await start(s);
  assert.equal((await req('GET', '/api/auto')).status, 200);
  const created = await req('POST', '/api/auto/rules', { key: 'SIJUD-1', start: '09:00', minutes: 15 });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).rule.id, 'r1');
  assert.equal((await req('POST', '/api/auto/rules', { key: 'SIJUD-1', start: 'x', minutes: 15 })).status, 400);
  assert.equal((await req('PUT', '/api/auto/rules/r1', { key: 'SIJUD-1', start: '08:00', minutes: 15 })).status, 200);
  assert.equal((await req('PUT', '/api/auto/rules/zz', { key: 'SIJUD-1', start: '08:00', minutes: 15 })).status, 400);
  assert.equal((await req('DELETE', '/api/auto/rules/r1')).status, 200);
  assert.equal((await req('POST', '/api/auto/paused', { paused: true })).status, 200);
  assert.equal((await req('POST', '/api/auto/paused', { paused: 'sim' })).status, 400);
  const run = await req('POST', '/api/auto/run', {});
  assert.deepEqual((await run.json()).results, [{ status: 'created' }]);
  assert.deepEqual(s.calls.map((c) => c[0]), ['add', 'add', 'update', 'update', 'remove', 'paused', 'tick']);
});

test('apontamentos automáticos: outra origem é recusada', async () => {
  const s = fakeScheduler();
  const req = await start(s);
  const res = await req('POST', '/api/auto/rules', { key: 'SIJUD-1', start: '09:00', minutes: 15 }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(s.calls.length, 0);
});

test('apontamentos automáticos: gravações auditadas com via = web; leitura e erro não', async () => {
  const s = fakeScheduler();
  const t = await makeTestApp({ services: {}, scheduler: s });
  await t.json('GET', '/api/auto');
  await t.json('POST', '/api/auto/rules', { key: 'SIJUD-1', start: '09:00', minutes: 15 });
  await t.json('POST', '/api/auto/rules', { key: 'SIJUD-1', start: 'x', minutes: 15 });
  await t.json('PUT', '/api/auto/rules/r1', { key: 'SIJUD-1', start: '08:00', minutes: 15 });
  await t.json('DELETE', '/api/auto/rules/r1');
  await t.json('POST', '/api/auto/paused', { paused: true });
  await t.json('POST', '/api/auto/run', {});
  const rows = t.db.prepare('SELECT user_id, via, action, detail FROM audit ORDER BY id').all();
  assert.ok(rows.every((r) => r.via === 'web' && r.user_id === t.user.id));
  assert.deepEqual(rows.map((r) => [r.action, JSON.parse(r.detail)]), [
    ['auto.rule.add', { ruleId: 'r1', key: 'SIJUD-1' }],
    ['auto.rule.update', { ruleId: 'r1', key: 'SIJUD-1' }],
    ['auto.rule.remove', { ruleId: 'r1' }],
    ['auto.paused', { paused: true }],
    ['auto.run', { results: 1 }],
  ]);
});

test('apontamentos automáticos: agendador é o do usuário logado e não depende do token', async () => {
  const porUsuario = new Map();
  const autoRunner = { schedulerFor(id) { if (!porUsuario.has(id)) porUsuario.set(id, fakeScheduler()); return porUsuario.get(id); } };
  const t = await makeTestApp({ services: { missing: true }, autoRunner });
  const beto = t.login({ email: 'beto@x.com' });
  assert.equal((await t.json('POST', '/api/auto/paused', { paused: true })).status, 200);
  assert.equal((await beto.json('POST', '/api/auto/paused', { paused: false })).status, 200);
  assert.deepEqual(porUsuario.get(t.user.id).calls, [['paused', true]]);
  assert.deepEqual(porUsuario.get(beto.user.id).calls, [['paused', false]]);
});
