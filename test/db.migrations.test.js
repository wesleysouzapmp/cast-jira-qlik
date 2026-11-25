import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

const TABELAS = [
  'users', 'user_secrets', 'sessions', 'invites', 'rules', 'rule_done', 'rule_log',
  'user_settings', 'favorites', 'oauth_clients', 'oauth_codes', 'oauth_tokens', 'audit',
  'schema_version',
];

test('openDb(): cria todas as tabelas e índices', () => {
  const db = openDb();
  const nomes = (tipo) => db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(tipo).map((r) => r.name);
  const tabelas = nomes('table');
  for (const t of TABELAS) assert.ok(tabelas.includes(t), `falta a tabela ${t}`);
  const indices = nomes('index');
  for (const i of ['idx_rules_user', 'idx_rule_log_user_at', 'idx_favorites_user_key', 'idx_oauth_tokens_user']) {
    assert.ok(indices.includes(i), `falta o índice ${i}`);
  }
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});

const versoes = (db) => db.prepare('SELECT version FROM schema_version').all().map((r) => r.version);

test('openDb(): reabrir o mesmo arquivo não reaplica migrações', () => {
  const file = join(tmpdir(), `cast-db-${process.pid}-${Date.now()}.sqlite`);
  let db;
  try {
    db = openDb(file);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.deepEqual(versoes(db), [MIGRATIONS.length]);
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1','a@b.c','A','h',1)").run();
    db.close();
    db = openDb(file);
    assert.deepEqual(versoes(db), [MIGRATIONS.length]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally {
    try { db?.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true });
  }
});

test('FK: apagar usuário apaga regras, favoritos e dependentes', () => {
  const db = openDb();
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1','a@b.c','A','h','t')").run();
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2','d@e.f','D','h','t')").run();
  db.prepare("INSERT INTO rules (id, user_id, key, start, minutes) VALUES ('ba2f553f','u1','ABC-1','09:00',60)").run();
  db.prepare("INSERT INTO rules (id, user_id, key, start, minutes) VALUES ('0000aaaa','u2','ABC-2','09:00',60)").run();
  db.prepare("INSERT INTO rule_done (rule_id, date, status, at) VALUES ('ba2f553f','2026-11-25','ok','t')").run();
  db.prepare("INSERT INTO favorites (user_id, key) VALUES ('u1','ABC-1')").run();
  db.prepare("INSERT INTO favorites (user_id, key) VALUES ('u2','ABC-1')").run();
  db.prepare("INSERT INTO user_settings (user_id) VALUES ('u1')").run();
  db.prepare("INSERT INTO user_secrets (user_id, jira_account_id) VALUES ('u1','acc')").run();
  db.prepare("DELETE FROM users WHERE id = 'u1'").run();
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.equal(n('rules'), 1);
  assert.equal(n('rule_done'), 0);
  assert.equal(n('favorites'), 1);
  assert.equal(n('user_settings'), 0);
  assert.equal(n('user_secrets'), 0);
  db.close();
});

test('constraints: e-mail único sem diferenciar maiúsculas; favorito único; FK exige usuário', () => {
  const db = openDb();
  const ins = db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'N', 'h', 't')");
  ins.run('u1', 'a@b.c');
  assert.throws(() => ins.run('u2', 'A@B.C'), /UNIQUE/);
  db.prepare("INSERT INTO favorites (user_id, key) VALUES ('u1','K-1')").run();
  assert.throws(() => db.prepare("INSERT INTO favorites (user_id, key) VALUES ('u1','K-1')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO favorites (user_id, key) VALUES ('nope','K-1')").run(), /FOREIGN/);
  assert.throws(() => db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('u3','x@y.z','N','root','h','t')").run(), /CHECK/);
  db.close();
});
