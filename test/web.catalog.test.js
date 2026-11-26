import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';

const ITEMS = [{ cat: 'CAT-105', size: 'M', ust: 8, task: 'Diagnóstico', description: 'Incidente' }, { cat: 'cat-166', size: 'p', ust: '8', task: 'Script', description: '' }];

test('admin grava o catálogo de UST e qualquer usuário lê', async () => {
  const t = await makeTestApp();
  const put = await t.json('PUT', '/api/admin/ust/catalogo', { items: ITEMS });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true, count: 2 });
  const beto = t.login({ name: 'Beto' });
  const get = await beto.json('GET', '/api/ust/catalogo');
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.deepEqual(body.items.map((i) => `${i.cat} ${i.size} ${i.ust}`), ['CAT-105 M 8', 'CAT-166 P 8']);
  assert.equal(body.updatedBy, 'Ana');
  assert.equal(typeof body.updatedAt, 'number');
  assert.equal(body.canEdit, false);
  assert.equal((await (await t.json('GET', '/api/ust/catalogo')).json()).canEdit, true);
  const log = t.audit.list(t.user.id);
  assert.equal(log[0].action, 'ust.catalogo');
  assert.deepEqual(log[0].detail, { count: 2 });
});

test('usuário comum não grava o catálogo', async () => {
  const t = await makeTestApp();
  const beto = t.login({ name: 'Beto' });
  const res = await beto.json('PUT', '/api/admin/ust/catalogo', { items: ITEMS });
  assert.equal(res.status, 403);
  assert.deepEqual((await (await t.json('GET', '/api/ust/catalogo')).json()).items, []);
});

test('catálogo inválido → 400 com a mensagem e nada muda', async () => {
  const t = await makeTestApp();
  await t.json('PUT', '/api/admin/ust/catalogo', { items: ITEMS });
  const res = await t.json('PUT', '/api/admin/ust/catalogo', { items: [{ cat: 'CAT-1', size: 'X', ust: 1 }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Linha 1: tamanho inválido/);
  assert.equal((await t.json('PUT', '/api/admin/ust/catalogo', { items: [] })).status, 400);
  assert.equal((await (await t.json('GET', '/api/ust/catalogo')).json()).items.length, 2);
});

test('GET /api/worklog/ust repassa período e catálogo ao serviço', async () => {
  const calls = [];
  const worklogService = { async ustSummary(args) { calls.push(args); return { from: args.from, to: args.to, concluded: { ust: 8, tasks: [] }, inProgress: { ust: 0, tasks: [] }, problems: [] }; } };
  const t = await makeTestApp({ services: { worklogService } });
  await t.json('PUT', '/api/admin/ust/catalogo', { items: ITEMS });
  const res = await t.json('GET', '/api/worklog/ust?from=2026-10-21&to=2026-11-20');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).concluded.ust, 8);
  assert.deepEqual([calls[0].from, calls[0].to, calls[0].catalog.length], ['2026-10-21', '2026-11-20', 2]);
  for (const q of ['from=2026-11-20&to=2026-10-21', 'from=x&to=2026-11-20', 'from=2025-01-01&to=2026-11-20']) {
    assert.equal((await t.json('GET', `/api/worklog/ust?${q}`)).status, 400, q);
  }
  assert.equal(calls.length, 1);
});

test('tamanhos: GET repassa período, concluídas e catálogo; POST valida e audita a troca', async () => {
  const calls = [];
  const worklogService = {
    async sizeAnalysis(args) { calls.push(['analise', args]); return { tasks: [] }; },
    async changeSizes(args) { calls.push(['troca', args]); return { results: args.changes.map((c) => ({ key: c.key, status: 'updated', from: 'P', to: c.size })) }; },
  };
  const t = await makeTestApp({ services: { worklogService } });
  await t.json('PUT', '/api/admin/ust/catalogo', { items: ITEMS });
  assert.equal((await t.json('GET', '/api/worklog/tamanhos?from=2026-10-21&to=2026-11-20&concluidas=1')).status, 200);
  assert.deepEqual([calls[0][1].from, calls[0][1].to, calls[0][1].includeDone, calls[0][1].catalog.length], ['2026-10-21', '2026-11-20', true, 2]);
  await t.json('GET', '/api/worklog/tamanhos?from=2026-10-21&to=2026-11-20');
  assert.equal(calls[1][1].includeDone, false);

  const res = await t.json('POST', '/api/worklog/tamanhos', { changes: [{ key: 'QSENSE-1', size: 'M', from: 'P' }, { key: 'QSENSE-2', size: 'g', from: '' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[2][1].changes, [{ key: 'QSENSE-1', size: 'M', from: 'P' }, { key: 'QSENSE-2', size: 'G', from: '' }]);
  const log = t.audit.list(t.user.id).find((x) => x.action === 'ust.tamanho');
  assert.deepEqual(log.detail, { changes: [{ key: 'QSENSE-1', from: 'P', size: 'M', status: 'updated' }, { key: 'QSENSE-2', from: 'P', size: 'G', status: 'updated' }] });

  for (const changes of [[], 'x', [{ key: 'qsense-1', size: 'M' }], [{ key: 'QSENSE-1', size: 'XG' }], [{ key: 'QSENSE-1', size: 'M' }, { key: 'QSENSE-1', size: 'G' }], [{ key: 'QSENSE-1', size: 'M', from: 'XG' }], Array.from({ length: 51 }, (_, i) => ({ key: `Q-${i + 1}`, size: 'P' }))]) {
    assert.equal((await t.json('POST', '/api/worklog/tamanhos', { changes })).status, 400, JSON.stringify(changes).slice(0, 60));
  }
  assert.equal(calls.length, 3);
});

test('tamanhos: troca recusa Origin externo', async () => {
  const worklogService = { async changeSizes() { throw new Error('não deveria chamar'); } };
  const t = await makeTestApp({ services: { worklogService } });
  const res = await t.json('POST', '/api/worklog/tamanhos', { changes: [{ key: 'QSENSE-1', size: 'M' }] }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});
