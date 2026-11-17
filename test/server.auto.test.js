import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

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

async function start(autoScheduler) {
  const app = createApp({ client: { async call() { return { ok: true, status: 200, data: {} }; } }, config: { baseUrl: 'https://x', email: 'e', tokenConfigured: true }, worklogService: {}, autoScheduler });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return (method, path, body, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
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
