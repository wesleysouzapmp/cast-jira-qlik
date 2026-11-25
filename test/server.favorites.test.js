import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';

function fakes() {
  const keys = ['SIJUD-1'];
  const calls = [];
  const info = {
    'SIJUD-1': { key: 'SIJUD-1', summary: 'Atendimento', status: 'Aberto', url: 'u1', available: true },
    'BI-3000': { key: 'BI-3000', summary: 'História', status: 'Aberto', url: 'u2', available: true },
    'BI-77': { key: 'BI-77', summary: 'Épico', status: 'Aberto', url: 'u3', available: false, error: 'BI-77 é um épico; aponte nas tarefas dele.' },
  };
  const worklogService = {
    async describe(list) { calls.push(['describe', list]); return list.map((k) => info[k] ?? { key: k, available: false, error: `Tarefa ${k} não encontrada ou sem acesso.` }); },
  };
  const favoritesStore = {
    async list() { return [...keys]; },
    async add(k) { calls.push(['add', k]); if (!keys.includes(k)) keys.push(k); return [...keys]; },
    async remove(k) { calls.push(['remove', k]); keys.splice(keys.indexOf(k), 1); return [...keys]; },
  };
  return { worklogService, favoritesStore, calls, keys };
}

async function start(f) {
  const client = { async call() { return { ok: true, status: 200, data: {} }; } };
  return makeTestApp({ services: { client, worklogService: f.worklogService, favorites: f.favoritesStore } });
}

test('GET favoritos devolve as chaves descritas pelo Jira', async () => {
  const f = fakes();
  const { json } = await start(f);
  const res = await json('GET', '/api/worklog/favorites');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { favorites: [{ key: 'SIJUD-1', summary: 'Atendimento', status: 'Aberto', url: 'u1', available: true }] });
});

test('lookup descreve uma chave e recusa formato inválido', async () => {
  const f = fakes();
  const { json } = await start(f);
  const ok = await json('GET', '/api/worklog/lookup?key=BI-3000');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).task.summary, 'História');
  const missing = await (await json('GET', '/api/worklog/lookup?key=NOPE-1')).json();
  assert.equal(missing.task.available, false);
  for (const q of ['key=bi-1', 'key=', '']) assert.equal((await json('GET', `/api/worklog/lookup?${q}`)).status, 400, q);
});

test('POST favoritos valida no Jira antes de gravar; épico e inexistente são recusados', async () => {
  const f = fakes();
  const { json } = await start(f);
  const res = await json('POST', '/api/worklog/favorites', { key: 'BI-3000' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).favorite.key, 'BI-3000');
  assert.deepEqual(f.keys, ['SIJUD-1', 'BI-3000']);
  for (const key of ['BI-77', 'NOPE-1', 'minusculo-1', 42]) {
    assert.equal((await json('POST', '/api/worklog/favorites', { key })).status, 400, String(key));
  }
  assert.equal(f.calls.filter((c) => c[0] === 'add').length, 1);
});

test('DELETE favoritos remove a chave', async () => {
  const f = fakes();
  const { json } = await start(f);
  assert.equal((await json('DELETE', '/api/worklog/favorites/SIJUD-1')).status, 200);
  assert.deepEqual(f.keys, []);
  assert.equal((await json('DELETE', '/api/worklog/favorites/nao-chave')).status, 400);
});

test('favoritos: outra origem é recusada', async () => {
  const f = fakes();
  const { json } = await start(f);
  const res = await json('POST', '/api/worklog/favorites', { key: 'BI-3000' }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.deepEqual(f.keys, ['SIJUD-1']);
});
