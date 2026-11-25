import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createSessionRepo } from '../src/db/sessions.js';

const DIA = 24 * 3600 * 1000;

function setup() {
  const db = openDb();
  const key = randomBytes(32);
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const users = createUserRepo(db, key, clock.now);
  const sessions = createSessionRepo(db, clock.now);
  return { db, key, clock, users, sessions };
}

test('create/byId/byEmail: e-mail normalizado, objeto simples', () => {
  const { users } = setup();
  const u = users.create({ email: '  Ana@Exemplo.COM ', name: 'Ana', role: 'admin', passwordHash: 'h' });
  assert.equal(u.email, 'ana@exemplo.com');
  assert.equal(u.role, 'admin');
  assert.equal(u.active, true);
  assert.equal(Object.getPrototypeOf(u), Object.prototype);
  assert.equal(users.byId(u.id).email, 'ana@exemplo.com');
  assert.equal(users.byEmail('ANA@exemplo.com ').id, u.id);
  assert.equal(users.byEmail('x@y.z'), null);
  assert.equal(users.byId('nao'), null);
});

test('e-mail repetido com caixa diferente lança erro', () => {
  const { users } = setup();
  users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  assert.throws(() => users.create({ email: 'A@B.COM', name: 'A2', passwordHash: 'h' }));
});

test('segredos ficam cifrados no banco e voltam decifrados', () => {
  const { db, users } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  users.setJira(u.id, { email: 'j@x.com', token: 'JIRA-TOKEN-SECRETO', accountId: 'acc1' });
  users.setAnthropic(u.id, 'sk-ant-SECRETA');
  const raw = JSON.stringify(db.prepare('SELECT * FROM user_secrets').all());
  assert.ok(!raw.includes('JIRA-TOKEN-SECRETO'));
  assert.ok(!raw.includes('sk-ant-SECRETA'));
  const s = users.getSecrets(u.id);
  assert.deepEqual(s, {
    jiraEmail: 'j@x.com', jiraToken: 'JIRA-TOKEN-SECRETO', anthropicKey: 'sk-ant-SECRETA',
    tokenStatus: 'ok', accountId: 'acc1',
  });
  users.setAnthropic(u.id, null);
  assert.equal(users.getSecrets(u.id).anthropicKey, null);
  users.markToken(u.id, 'invalid');
  assert.equal(users.getSecrets(u.id).tokenStatus, 'invalid');
});

test('getSecrets sem linha: tudo nulo e tokenStatus missing', () => {
  const { users } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const s = users.getSecrets(u.id);
  assert.equal(s.tokenStatus, 'missing');
  assert.equal(s.jiraToken, null);
});

test('outra chave mestra: getSecrets devolve tokenStatus missing', () => {
  const { db, users } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  users.setJira(u.id, { email: 'j@x.com', token: 'T', accountId: 'acc1' });
  const outro = createUserRepo(db, randomBytes(32));
  const s = outro.getSecrets(u.id);
  assert.equal(s.tokenStatus, 'missing');
  assert.equal(s.jiraToken, null);
});

test('list: sem segredos, com tokenStatus; setActive/setPassword', () => {
  const { users } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const v = users.create({ email: 'c@d.com', name: 'C', passwordHash: 'h' });
  users.setJira(u.id, { email: 'j@x.com', token: 'T', accountId: 'a' });
  const l = users.list();
  assert.equal(l.length, 2);
  assert.equal(l.find((x) => x.id === u.id).tokenStatus, 'ok');
  assert.equal(l.find((x) => x.id === v.id).tokenStatus, 'missing');
  assert.ok(l.every((x) => !('passwordHash' in x) && !('password_hash' in x)));
  users.setActive(v.id, false);
  assert.equal(users.byId(v.id).active, false);
  users.setPassword(u.id, 'novo');
  assert.equal(users.byId(u.id).passwordHash, 'novo');
});

test('getSettings default e setAutoPaused faz upsert', () => {
  const { users } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  assert.deepEqual(users.getSettings(u.id), { autoPaused: false });
  users.setAutoPaused(u.id, true);
  assert.deepEqual(users.getSettings(u.id), { autoPaused: true });
  users.setAutoPaused(u.id, false);
  assert.deepEqual(users.getSettings(u.id), { autoPaused: false });
});

test('sessão: resolve, renova, expira', () => {
  const { users, sessions, clock, db } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const { token } = sessions.create(u.id, 'UA');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(token));
  clock.advance(20 * DIA);
  const r = sessions.resolve(token);
  assert.equal(r.user.id, u.id);
  clock.advance(20 * DIA); // 40 dias desde a criação, mas renovada aos 20
  assert.ok(sessions.resolve(token));
  clock.advance(31 * DIA);
  assert.equal(sessions.resolve(token), null);
  assert.equal(sessions.resolve('lixo'), null);
});

test('sessão de usuário inativo dá null', () => {
  const { users, sessions } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const { token } = sessions.create(u.id, 'UA');
  users.setActive(u.id, false);
  assert.equal(sessions.resolve(token), null);
});

test('destroy, destroyAllFor (com exceção) e listFor', () => {
  const { users, sessions } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const a = sessions.create(u.id, 'A');
  const b = sessions.create(u.id, 'B');
  const c = sessions.create(u.id, 'C');
  assert.equal(sessions.listFor(u.id).length, 3);
  sessions.destroy(a.token);
  assert.equal(sessions.resolve(a.token), null);
  sessions.destroyAllFor(u.id, b.token);
  assert.ok(sessions.resolve(b.token));
  assert.equal(sessions.resolve(c.token), null);
  sessions.destroyAllFor(u.id);
  assert.equal(sessions.listFor(u.id).length, 0);
});

test('convite usado duas vezes: a segunda dá null; kind errado dá null', () => {
  const { users, sessions } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', role: 'admin', passwordHash: 'h' });
  const { token } = sessions.createInvite({ role: 'user', createdBy: u.id, kind: 'invite', ttlMs: 7 * DIA });
  assert.equal(sessions.takeInvite(token, 'reset'), null);
  const inv = sessions.takeInvite(token, 'invite');
  assert.equal(inv.role, 'user');
  assert.equal(inv.kind, 'invite');
  assert.equal(inv.createdBy, u.id);
  assert.equal(sessions.takeInvite(token, 'invite'), null);
});

test('convite expirado dá null; reset guarda userId', () => {
  const { users, sessions, clock } = setup();
  const u = users.create({ email: 'a@b.com', name: 'A', passwordHash: 'h' });
  const exp = sessions.createInvite({ role: 'user', createdBy: u.id, kind: 'invite', ttlMs: DIA });
  const rst = sessions.createInvite({ role: 'user', createdBy: u.id, kind: 'reset', userId: u.id, ttlMs: DIA });
  clock.advance(DIA - 1);
  assert.equal(sessions.takeInvite(rst.token, 'reset').userId, u.id);
  clock.advance(2);
  assert.equal(sessions.takeInvite(exp.token, 'invite'), null);
});
