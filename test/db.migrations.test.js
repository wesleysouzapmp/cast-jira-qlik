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
  'ust_catalog', 'ust_catalog_meta', 'schema_version',
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

test('openDb(): arquivo abre com busy_timeout de 5000 ms; escrita após o COMMIT de outra conexão passa', () => {
  const file = join(tmpdir(), `busy-${process.pid}-${Date.now()}.db`);
  const a = openDb(file);
  const b = openDb(file);
  try {
    assert.equal(Object.values(b.prepare('PRAGMA busy_timeout').get())[0], 5000);
    a.exec('BEGIN IMMEDIATE');
    a.prepare("INSERT INTO schema_version (version) VALUES (999)").run();
    a.exec('COMMIT');
    b.exec('BEGIN IMMEDIATE');
    b.prepare('DELETE FROM schema_version WHERE version = 999').run();
    b.exec('COMMIT');
    assert.equal(a.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 999').get().n, 0);
  } finally {
    a.close(); b.close();
    for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true });
  }
});

test('openDb(): se a migração falhar, fecha a conexão e repassa o erro', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(tmpdir(), `migfail-${process.pid}-${Date.now()}.db`);
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE users (x INTEGER)'); // conflita com a 1ª migração
  raw.close();
  const closed = [];
  const orig = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { closed.push(true); return orig.call(this); };
  try {
    assert.throws(() => openDb(file), /users/);
    assert.equal(closed.length, 1, 'a conexão deveria ter sido fechada');
  } finally {
    DatabaseSync.prototype.close = orig;
    for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true });
  }
});

test('migração 6: user_settings.epic_project_id (texto, nulo) e o padrão por usuário', async () => {
  const { epicSpaceFor } = await import('../src/db/userData.js');
  const db = openDb();
  const col = db.prepare('PRAGMA table_info(user_settings)').all().find((c) => c.name === 'epic_project_id');
  assert.ok(col, 'falta user_settings.epic_project_id');
  assert.equal(col.type, 'TEXT');
  assert.equal(col.notnull, 0);
  assert.ok(MIGRATIONS.length >= 6);
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1','a@b.c','A','h',1)").run();
  db.prepare("INSERT INTO user_settings (user_id, auto_paused) VALUES ('u1', 1)").run();
  const s = epicSpaceFor(db, 'u1');
  assert.equal(s.get(), null);
  s.set('300');
  assert.equal(s.get(), '300');
  s.set('100');
  assert.equal(s.get(), '100');
  // Não apaga as outras configurações da linha.
  assert.equal(db.prepare("SELECT auto_paused FROM user_settings WHERE user_id = 'u1'").get().auto_paused, 1);
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2','b@b.c','B','h',1)").run();
  epicSpaceFor(db, 'u2').set('7');
  assert.equal(epicSpaceFor(db, 'u2').get(), '7');
  db.close();
});
