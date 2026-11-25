import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createAuditRepo } from '../src/db/audit.js';

function setup() {
  const db = openDb(':memory:');
  const users = createUserRepo(db, randomBytes(32));
  let t = 1000;
  const audit = createAuditRepo(db, () => t++);
  const ana = users.create({ email: 'ana@x.com', name: 'Ana', passwordHash: 'x' });
  const beto = users.create({ email: 'beto@x.com', name: 'Beto', passwordHash: 'x' });
  return { db, audit, ana, beto };
}

test('audit.log grava linha com via, ação e detalhe JSON; list devolve do mais novo ao mais antigo', () => {
  const { db, audit, ana } = setup();
  audit.log({ userId: ana.id, via: 'web', action: 'worklog.submit', detail: { entries: 2, keys: ['BI-1'] } });
  audit.log({ userId: ana.id, via: 'web', action: 'auto.paused', detail: { paused: true } });
  const row = db.prepare('SELECT * FROM audit ORDER BY id LIMIT 1').get();
  assert.equal(row.user_id, ana.id);
  assert.equal(row.via, 'web');
  assert.equal(row.at, 1000);
  assert.deepEqual(JSON.parse(row.detail), { entries: 2, keys: ['BI-1'] });
  const list = audit.list(ana.id);
  assert.deepEqual(list.map((e) => e.action), ['auto.paused', 'worklog.submit']);
  assert.deepEqual(list[1], { id: list[1].id, userId: ana.id, at: 1000, via: 'web', action: 'worklog.submit', detail: { entries: 2, keys: ['BI-1'] } });
});

test('audit.list é por usuário e respeita o limite', () => {
  const { audit, ana, beto } = setup();
  for (let i = 0; i < 5; i++) audit.log({ userId: ana.id, via: 'mcp', action: `a${i}` });
  audit.log({ userId: beto.id, via: 'auto', action: 'b' });
  assert.equal(audit.list(ana.id).length, 5);
  assert.deepEqual(audit.list(ana.id, 2).map((e) => e.action), ['a4', 'a3']);
  assert.deepEqual(audit.list(beto.id).map((e) => [e.action, e.detail]), [['b', null]]);
});

test('audit.log recusa via inválida', () => {
  const { audit, ana } = setup();
  assert.throws(() => audit.log({ userId: ana.id, via: 'outro', action: 'x' }));
});
