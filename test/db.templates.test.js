import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createTemplateRepo, SYSTEM_TEMPLATE_ID } from '../src/db/templates.js';
import { MODELS } from '../src/support/models.js';

function setup() {
  const db = openDb();
  let t = 1_000_000;
  const users = createUserRepo(db, randomBytes(32), () => t);
  const templates = createTemplateRepo(db, () => ++t);
  const ana = users.create({ email: 'ana@x.com', name: 'Ana', role: 'admin', passwordHash: 'h' });
  const bia = users.create({ email: 'bia@x.com', name: 'Bia', role: 'user', passwordHash: 'h' });
  const caio = users.create({ email: 'caio@x.com', name: 'Caio', role: 'user', passwordHash: 'h' });
  return { db, users, templates, ana, bia, caio };
}

const item = (cat, size = 'P', summary = `Tarefa ${cat} {EPICO}`, description = '') => ({ cat, size, summary, description });

test('migração cria o modelo "Padrão" público, do sistema, com os textos de models.js', () => {
  const { templates } = setup();
  const t = templates.get(SYSTEM_TEMPLATE_ID);
  assert.equal(t.name, 'Padrão');
  assert.equal(t.public, true);
  assert.equal(t.ownerId, null);
  assert.equal(t.ownerName, null);
  const [a, i] = MODELS;
  assert.deepEqual(t.items, [
    { cat: 'CAT-105', size: 'M', summary: a.summary, description: a.description },
    { cat: 'CAT-166', size: 'P', summary: i.summary, description: i.description },
  ]);
});

test('create/get/update/remove mantêm a ordem dos itens', () => {
  const { templates, bia } = setup();
  const t = templates.create({ name: 'Meu', public: false, items: [item('CAT-2'), item('CAT-1', 'G')] }, bia.id);
  assert.equal(t.ownerId, bia.id);
  assert.equal(t.ownerName, 'Bia');
  assert.deepEqual(t.items.map((x) => x.cat), ['CAT-2', 'CAT-1']);
  const u = templates.update(t.id, { name: 'Outro', public: true, items: [item('CAT-3', 'Hora')] });
  assert.equal(u.name, 'Outro');
  assert.equal(u.public, true);
  assert.deepEqual(u.items, [item('CAT-3', 'Hora')]);
  assert.ok(u.updatedAt > t.updatedAt);
  assert.equal(templates.remove(t.id), true);
  assert.equal(templates.get(t.id), null);
  assert.equal(templates.remove(t.id), false);
});

test('visíveis: públicos + os próprios; admin vê todos', () => {
  const { templates, ana, bia, caio } = setup();
  const priv = templates.create({ name: 'Privado da Bia', public: false, items: [item('CAT-1')] }, bia.id);
  const pub = templates.create({ name: 'Público da Bia', public: true, items: [item('CAT-1')] }, bia.id);
  const names = (list) => list.map((t) => t.name);
  assert.deepEqual(names(templates.listVisible({ id: caio.id, role: 'user' })), ['Padrão', 'Público da Bia']);
  assert.deepEqual(names(templates.listVisible({ id: bia.id, role: 'user' })), ['Padrão', 'Privado da Bia', 'Público da Bia']);
  assert.deepEqual(names(templates.listVisible({ id: ana.id, role: 'admin' })), ['Padrão', 'Privado da Bia', 'Público da Bia']);
  assert.equal(templates.isVisible(priv, { id: caio.id, role: 'user' }), false);
  assert.equal(templates.isVisible(pub, { id: caio.id, role: 'user' }), true);
});

test('último modelo usado por usuário; some quando o modelo é excluído', () => {
  const { templates, bia, caio } = setup();
  assert.equal(templates.lastUsed(bia.id), null);
  const t = templates.create({ name: 'X', public: true, items: [item('CAT-1')] }, bia.id);
  templates.setLastUsed(bia.id, t.id);
  templates.setLastUsed(caio.id, SYSTEM_TEMPLATE_ID);
  assert.equal(templates.lastUsed(bia.id), t.id);
  templates.remove(t.id);
  assert.equal(templates.lastUsed(bia.id), null);
  assert.equal(templates.lastUsed(caio.id), SYSTEM_TEMPLATE_ID);
});

test('usuário apagado: os modelos dele ficam como modelos do sistema', () => {
  const { db, templates, bia } = setup();
  const t = templates.create({ name: 'X', public: true, items: [item('CAT-1')] }, bia.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(bia.id);
  const kept = templates.get(t.id);
  assert.equal(kept.ownerId, null);
  assert.equal(kept.items.length, 1);
});

test('usable: público ou próprio (o admin vê os privados alheios, mas não os usa)', () => {
  const { templates, ana, bia } = setup();
  const priv = templates.create({ name: 'P', public: false, items: [item('CAT-1')] }, bia.id);
  assert.equal(templates.isUsable(priv, { id: ana.id, role: 'admin' }), false);
  assert.equal(templates.isUsable(priv, { id: bia.id, role: 'user' }), true);
  assert.equal(templates.isUsable(templates.get('padrao'), { id: ana.id, role: 'admin' }), true);
});

test('usuário: chave "pode criar modelos" desligada por padrão', () => {
  const { users, bia } = setup();
  assert.equal(users.byId(bia.id).canCreateTemplates, false);
  users.setCanCreateTemplates(bia.id, true);
  assert.equal(users.byId(bia.id).canCreateTemplates, true);
  assert.equal(users.list().find((u) => u.id === bia.id).canCreateTemplates, true);
  users.setCanCreateTemplates(bia.id, false);
  assert.equal(users.byId(bia.id).canCreateTemplates, false);
});
