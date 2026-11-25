import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createCatalogRepo } from '../src/db/catalog.js';

function setup() {
  const db = openDb(':memory:');
  const users = createUserRepo(db, randomBytes(32));
  const ana = users.create({ email: 'ana@x.com', name: 'Ana', passwordHash: 'x' });
  let t = 5000;
  return { db, ana, catalog: createCatalogRepo(db, () => t++) };
}

const item = (cat, size, ust, task = 'T', description = '') => ({ cat, size, ust, task, description });

test('catálogo começa vazio, sem autor', () => {
  const { catalog } = setup();
  assert.deepEqual(catalog.get(), { items: [], updatedAt: null, updatedBy: null });
});

test('replaceAll troca tudo, ordena por número do CAT e tamanho e guarda quem alterou', () => {
  const { catalog, ana } = setup();
  catalog.replaceAll([item('CAT-110', 'G', 12), item('CAT-105', 'M', 8), item('CAT-105', 'P', 0.4), item('CAT-99', 'Hora', 1)], ana.id);
  const r = catalog.get();
  assert.deepEqual(r.items.map((i) => `${i.cat} ${i.size} ${i.ust}`), ['CAT-99 Hora 1', 'CAT-105 P 0.4', 'CAT-105 M 8', 'CAT-110 G 12']);
  assert.deepEqual([r.updatedAt, r.updatedBy], [5000, 'Ana']);
  catalog.replaceAll([item('CAT-1', 'P', 2)], ana.id);
  assert.deepEqual(catalog.get().items, [item('CAT-1', 'P', 2)]);
  assert.equal(catalog.get().updatedAt, 5001);
});

test('replaceAll com erro não apaga o catálogo anterior', () => {
  const { catalog, ana } = setup();
  catalog.replaceAll([item('CAT-1', 'P', 2)], ana.id);
  assert.throws(() => catalog.replaceAll([item('CAT-2', 'P', 1), item('CAT-2', 'P', 3)], ana.id));
  assert.deepEqual(catalog.get().items, [item('CAT-1', 'P', 2)]);
});
