import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createTemplateRepo, createSubtaskRepo, SYSTEM_TEMPLATE_ID } from '../src/db/templates.js';
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

const act = (text, action = 'Desenvolver') => ({ action, text });

test('rascunho "Padrão" (migração 7): atividades vindas dos itens antigos; itens antigos seguem legíveis', () => {
  const { templates } = setup();
  const t = templates.get(SYSTEM_TEMPLATE_ID);
  assert.equal(t.name, 'Padrão');
  assert.equal(t.public, true);
  assert.equal(t.ownerId, null);
  assert.deepEqual(t.activities, [
    { action: 'Analisar', text: 'Analise da demanda' },
    { action: 'Desenvolver', text: 'Implementação da demanda' },
  ]);
  const [a, i] = MODELS;
  assert.deepEqual(t.items, [
    { cat: 'CAT-105', size: 'M', summary: a.summary, description: a.description },
    { cat: 'CAT-166', size: 'P', summary: i.summary, description: i.description },
  ]);
});

test('create/get/update/remove mantêm a ordem das atividades', () => {
  const { templates, bia } = setup();
  const t = templates.create({ name: 'Meu', public: false, activities: [act('segunda coisa a fazer'), act('primeira coisa', 'Analisar')] }, bia.id);
  assert.equal(t.ownerId, bia.id);
  assert.equal(t.ownerName, 'Bia');
  assert.deepEqual(t.activities.map((x) => x.text), ['segunda coisa a fazer', 'primeira coisa']);
  assert.deepEqual(t.items, []);
  const u = templates.update(t.id, { name: 'Outro', public: true, activities: [act('a carga de dados', 'Testar')] });
  assert.equal(u.name, 'Outro');
  assert.equal(u.public, true);
  assert.deepEqual(u.activities, [act('a carga de dados', 'Testar')]);
  assert.ok(u.updatedAt > t.updatedAt);
  assert.equal(templates.remove(t.id), true);
  assert.equal(templates.get(t.id), null);
  assert.equal(templates.remove(t.id), false);
});

test('visíveis: públicos + os próprios; admin vê todos', () => {
  const { templates, ana, bia, caio } = setup();
  const priv = templates.create({ name: 'Privado da Bia', public: false, activities: [act('atividade qualquer')] }, bia.id);
  const pub = templates.create({ name: 'Público da Bia', public: true, activities: [act('atividade qualquer')] }, bia.id);
  const names = (list) => list.map((t) => t.name);
  assert.deepEqual(names(templates.listVisible({ id: caio.id, role: 'user' })), ['Padrão', 'Público da Bia']);
  assert.deepEqual(names(templates.listVisible({ id: bia.id, role: 'user' })), ['Padrão', 'Privado da Bia', 'Público da Bia']);
  assert.deepEqual(names(templates.listVisible({ id: ana.id, role: 'admin' })), ['Padrão', 'Privado da Bia', 'Público da Bia']);
  assert.equal(templates.isVisible(priv, { id: caio.id, role: 'user' }), false);
  assert.equal(templates.isVisible(pub, { id: caio.id, role: 'user' }), true);
});

test('último rascunho usado por usuário; some quando o rascunho é excluído', () => {
  const { templates, bia, caio } = setup();
  assert.equal(templates.lastUsed(bia.id), null);
  const t = templates.create({ name: 'X', public: true, activities: [act('atividade qualquer')] }, bia.id);
  templates.setLastUsed(bia.id, t.id);
  templates.setLastUsed(caio.id, SYSTEM_TEMPLATE_ID);
  assert.equal(templates.lastUsed(bia.id), t.id);
  templates.remove(t.id);
  assert.equal(templates.lastUsed(bia.id), null);
  assert.equal(templates.lastUsed(caio.id), SYSTEM_TEMPLATE_ID);
});

test('usuário apagado: os rascunhos dele ficam como do sistema', () => {
  const { db, templates, bia } = setup();
  const t = templates.create({ name: 'X', public: true, activities: [act('atividade qualquer')] }, bia.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(bia.id);
  const kept = templates.get(t.id);
  assert.equal(kept.ownerId, null);
  assert.equal(kept.activities.length, 1);
});

test('usable: público ou próprio (o admin vê os privados alheios, mas não os usa)', () => {
  const { templates, ana, bia } = setup();
  const priv = templates.create({ name: 'P', public: false, activities: [act('atividade qualquer')] }, bia.id);
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

test('fases das subtarefas (support_subtasks): grava, relê em lote e regrava', () => {
  const { db, bia } = setup();
  const repo = createSubtaskRepo(db, bia.id);
  repo.set({ key: 'QSENSE-1', phase: 'analise', epicKey: 'BI-1' });
  repo.set({ key: 'QSENSE-2', phase: 'testes', epicKey: 'BI-1' });
  assert.deepEqual([...repo.phases(['QSENSE-1', 'QSENSE-2', 'QSENSE-3'])], [['QSENSE-1', 'analise'], ['QSENSE-2', 'testes']]);
  repo.set({ key: 'QSENSE-1', phase: 'producao', epicKey: 'BI-1' });
  assert.equal(repo.phases(['QSENSE-1']).get('QSENSE-1'), 'producao');
  assert.throws(() => repo.set({ key: 'QSENSE-9', phase: 'dança', epicKey: 'BI-1' }), /CHECK/);
});
