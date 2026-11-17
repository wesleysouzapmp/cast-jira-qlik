import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFavoritesStore } from '../src/worklog/favorites.js';
import { GENERIC_MODEL, pickComments } from '../src/worklog/comments.js';

// Sistema de arquivos em memória: grava no temporário e renomeia, como o fs real.
function memFs(initial) {
  const files = new Map(initial === undefined ? [] : [['fav.json', initial]]);
  const logs = [];
  return {
    files,
    logs,
    opts: {
      file: 'fav.json',
      readFile: async (f) => { if (!files.has(f)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(f); },
      writeFile: async (f, text) => { files.set(f, text); },
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
      log: (m) => logs.push(m),
    },
  };
}

test('favoritos: arquivo ausente é lista vazia', async () => {
  const fs = memFs();
  assert.deepEqual(await createFavoritesStore(fs.opts).list(), []);
  assert.deepEqual(fs.logs, []);
});

test('favoritos: adiciona sem repetir, remove e grava só as chaves', async () => {
  const fs = memFs();
  const store = createFavoritesStore(fs.opts);
  await store.add('SIJUD-1');
  await store.add('BI-3000');
  await store.add('SIJUD-1');
  assert.deepEqual(await store.list(), ['SIJUD-1', 'BI-3000']);
  await store.remove('SIJUD-1');
  assert.deepEqual(JSON.parse(fs.files.get('fav.json')), ['BI-3000']);
  assert.ok(![...fs.files.keys()].some((k) => k !== 'fav.json'), 'não sobra arquivo temporário');
});

test('favoritos: JSON inválido ou fora do formato vira lista vazia com aviso', async () => {
  for (const bad of ['{nao json', '{"a":1}', '["ok-1", 3]']) {
    const fs = memFs(bad);
    assert.deepEqual(await createFavoritesStore(fs.opts).list(), [], bad);
    assert.equal(fs.logs.length, 1, bad);
  }
});

test('favoritos: ignora chaves inválidas no arquivo e recusa ao adicionar', async () => {
  const fs = memFs('["SIJUD-1", "minusculo-2", "X"]');
  const store = createFavoritesStore(fs.opts);
  assert.deepEqual(await store.list(), ['SIJUD-1']);
  await assert.rejects(store.add('nao chave'));
});

test('favoritos: gravações simultâneas não se perdem', async () => {
  const fs = memFs();
  const store = createFavoritesStore(fs.opts);
  await Promise.all(['AA-1', 'BB-2', 'CC-3'].map((k) => store.add(k)));
  assert.deepEqual((await store.list()).sort(), ['AA-1', 'BB-2', 'CC-3']);
});

test('frases genéricas: 8 distintas com chave e resumo da tarefa', () => {
  let seed = 3;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const r = pickComments(GENERIC_MODEL, { taskKey: 'SIJUD-1', taskSummary: 'Atendimento R$ 1' }, 8, rng);
  assert.equal(GENERIC_MODEL.comments.length, 8);
  assert.equal(new Set(r).size, 8);
  assert.ok(r.every((c) => c.includes('SIJUD-1 - Atendimento R$ 1') && !c.includes('{')), r.join('\n'));
});
