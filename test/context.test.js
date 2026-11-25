import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createContextFactory } from '../src/context.js';

function setup() {
  const db = openDb();
  const users = createUserRepo(db, randomBytes(32));
  const a = users.create({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const b = users.create({ email: 'b@x.com', name: 'B', passwordHash: 'h' });
  users.setJira(a.id, { email: 'a@jira.com', token: 'tok-A', accountId: 'acc-A' });
  users.setJira(b.id, { email: 'b@jira.com', token: 'tok-B', accountId: 'acc-B' });
  users.markToken(a.id, 'ok');
  users.markToken(b.id, 'ok');
  const built = [];
  let status = 200;
  const makeClient = (creds) => {
    built.push(creds);
    const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
    return { auth, async call() { return { status, ok: status < 300, data: {} }; } };
  };
  const makeAi = ({ apiKey }) => ({ enabled: Boolean(apiKey), apiKey });
  const factory = createContextFactory({ db, users, baseUrl: 'https://j.example', holidays: null, makeClient, makeAi });
  return { db, users, a, b, built, factory, setStatus: (s) => { status = s; } };
}

test('dois usuários recebem clientes com credenciais diferentes', () => {
  const { factory, a, b, built } = setup();
  const ca = factory.forUser(a);
  const cb = factory.forUser(b);
  assert.equal(built.length, 2);
  assert.deepEqual([built[0].email, built[0].token, built[0].baseUrl], ['a@jira.com', 'tok-A', 'https://j.example']);
  assert.deepEqual([built[1].email, built[1].token], ['b@jira.com', 'tok-B']);
  assert.notEqual(ca.client, cb.client);
  assert.notEqual(ca.worklogService, cb.worklogService);
});

test('forUser duas vezes devolve o mesmo objeto; invalidate cria novo', () => {
  const { factory, a } = setup();
  const c1 = factory.forUser(a);
  assert.equal(factory.forUser(a), c1);
  factory.invalidate(a.id);
  assert.notEqual(factory.forUser(a), c1);
});

test('401 marca o token como inválido, invalida o cache e devolve a resposta', async () => {
  const { factory, users, a, setStatus } = setup();
  const c1 = factory.forUser(a);
  setStatus(401);
  const res = await c1.client.call({ method: 'GET', path: '/x' });
  assert.deepEqual(res, { status: 401, ok: false, data: {} });
  assert.equal(users.getSecrets(a.id).tokenStatus, 'invalid');
  const c2 = factory.forUser(a);
  assert.notEqual(c2, c1);
  assert.equal(c2.secrets.tokenStatus, 'invalid');
});

test('resposta não-401 não mexe no status', async () => {
  const { factory, users, a, setStatus } = setup();
  setStatus(500);
  await factory.forUser(a).client.call({ path: '/x' });
  assert.equal(users.getSecrets(a.id).tokenStatus, 'ok');
});

test('sem token devolve { missing: true } e não constrói cliente', () => {
  const { factory, users, built } = setup();
  const c = users.create({ email: 'c@x.com', name: 'C', passwordHash: 'h' });
  assert.deepEqual(factory.forUser(c), { missing: true });
  assert.equal(built.length, 0);
});

test('secrets não vazam token nem chave; ai usa a chave do usuário; favoritos/auto por usuário', async () => {
  const { factory, users, a, b } = setup();
  users.setAnthropic(a.id, 'sk-A');
  const ca = factory.forUser(a);
  assert.deepEqual(ca.secrets, { jiraEmail: 'a@jira.com', tokenStatus: 'ok', accountId: 'acc-A' });
  assert.ok(!JSON.stringify(ca.secrets).includes('tok-A'));
  assert.equal(ca.ai.enabled, true);
  assert.equal(factory.forUser(b).ai.enabled, false);
  await ca.favorites.add('BI-1');
  assert.deepEqual(await factory.forUser(b).favorites.list(), []);
  assert.deepEqual(await ca.autoStore.readRules(), { paused: false, rules: [] });
});

test('401 tardio de contexto já invalidado não marca o token novo como inválido', async () => {
  const { factory, users, a, setStatus } = setup();
  const ctx1 = factory.forUser(a);
  users.setJira(a.id, { email: 'a@jira.com', token: 'tok-A2', accountId: 'acc-A' });
  users.markToken(a.id, 'ok');
  factory.invalidate(a.id);
  const ctx2 = factory.forUser(a);
  setStatus(401);
  await ctx1.client.call({ path: '/x' });
  assert.equal(users.getSecrets(a.id).tokenStatus, 'ok');
  assert.equal(factory.forUser(a), ctx2);
});
