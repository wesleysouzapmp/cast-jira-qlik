import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createAuditRepo } from '../src/db/audit.js';
import { createContextFactory } from '../src/context.js';
import { createAutoRunner } from '../src/worklog/autoRunner.js';
import { createFakeJira } from './fakeJira.js';
import { autoStoreFor } from '../src/db/userData.js';

const NOW = Date.parse('2026-11-10T12:30:00Z'); // terça, 09:30 local
const issue = (key) => ({ key, fields: { summary: 'Daily', issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: 'SIJUD' } } });
const rule = { key: 'SIJUD-1', start: '08:00', minutes: 15 };

function setup({ disabled = false, concurrency = 2 } = {}) {
  const db = openDb();
  const users = createUserRepo(db, randomBytes(32));
  const audit = createAuditRepo(db, () => NOW);
  const mk = (n) => { const u = users.create({ email: `${n}@x.com`, name: n, passwordHash: 'h' }); users.setJira(u.id, { email: `${n}@jira.com`, token: `tok-${n}`, accountId: `acc-${n}` }); users.markToken(u.id, 'ok'); return u; };
  const [a, b, c] = ['a', 'b', 'c'].map(mk);
  const jiras = { 'a@jira.com': createFakeJira({ issues: [issue('SIJUD-1')] }), 'b@jira.com': createFakeJira({ issues: [issue('SIJUD-1')], unauthorized: true }), 'c@jira.com': createFakeJira({ issues: [issue('SIJUD-1')] }) };
  const inflight = new Set(); let maxInflight = 0;
  const makeClient = ({ email }) => ({ async call(o) {
    inflight.add(email); maxInflight = Math.max(maxInflight, inflight.size);
    await new Promise((r) => setTimeout(r, 5));
    try { return await jiras[email].client.call(o); } finally { inflight.delete(email); }
  } });
  const holidays = { between: async () => new Map() };
  const contexts = createContextFactory({ db, users, baseUrl: 'https://j.example', holidays, makeClient, makeAi: () => ({ enabled: false }) });
  const runner = createAutoRunner({ db, users, contexts, holidays, now: () => NOW, disabled, log: () => {}, audit, concurrency });
  return { maxInflight: () => maxInflight, db, users, audit, contexts, runner, jiras, a, b, c, makeClient };
}
const posts = (j) => j.calls.filter((x) => x.method === 'POST' && /\/worklog$/.test(x.path));

test('A grava; B (401) recebe um único erro e é pulado depois; C pausado não grava', async () => {
  const { db, runner, jiras, audit, users, a, b, c } = setup();
  for (const u of [a, c]) await runner.schedulerFor(u.id).addRule(rule);
  // B: o 401 impede validar a regra; grava direto pela store
  await autoStoreFor(db, b.id).writeRules({ paused: false, rules: [{ id: 'rb1', ...rule, comment: 'x', since: '2026-11-10', until: null, enabled: true }] });
  await runner.schedulerFor(c.id).setPaused(true);
  const r1 = await runner.tick();
  assert.equal(posts(jiras['a@jira.com']).length, 1);
  assert.equal(posts(jiras['c@jira.com']).length, 0);
  const rb = r1.filter((e) => e.userId === b.id);
  assert.equal(rb.length, 1);
  assert.equal(rb[0].status, 'error');
  assert.equal(rb[0].message, 'token do Jira inválido');
  assert.equal(users.getSecrets(b.id).tokenStatus, 'invalid');
  const callsB = jiras['b@jira.com'].calls.length;
  const r2 = await runner.tick();
  assert.equal(r2.filter((e) => e.userId === b.id).length, 0);
  assert.equal(jiras['b@jira.com'].calls.length, callsB);
  assert.equal(posts(jiras['a@jira.com']).length, 1); // sem duplicar
  const au = audit.list(a.id);
  assert.equal(au.length, 1);
  assert.deepEqual([au[0].via, au[0].action], ['auto', 'auto.worklog']);
  assert.equal(au[0].detail.key, 'SIJUD-1');
  assert.equal(au[0].detail.date, '2026-11-10');
  assert.ok(au[0].detail.worklogId);
  assert.equal(audit.list(b.id).length, 0);
});

test('histórico de cada um só contém as próprias regras', async () => {
  const { runner, a, c } = setup();
  const ra = await runner.schedulerFor(a.id).addRule(rule);
  const rc = await runner.schedulerFor(c.id).addRule({ ...rule, key: 'SIJUD-1', start: '08:30' });
  await runner.tick();
  const sa = await runner.schedulerFor(a.id).status();
  const sc = await runner.schedulerFor(c.id).status();
  assert.deepEqual(sa.rules.map((r) => r.id), [ra.id]);
  assert.deepEqual(sc.rules.map((r) => r.id), [rc.id]);
  assert.ok(sa.history.every((h) => h.ruleId === ra.id));
  assert.ok(sc.history.every((h) => h.ruleId === rc.id));
  assert.equal(sa.history.length, 1);
});

test('disabled não grava nada e start é no-op', async () => {
  const { runner, jiras, a } = setup({ disabled: true });
  await runner.schedulerFor(a.id).addRule(rule);
  assert.deepEqual(await runner.tick(), []);
  runner.start(10); runner.stop();
  assert.equal(posts(jiras['a@jira.com']).length, 0);
});

test('troca de token (contexto novo) é usada pelo agendador em cache', async () => {
  const { runner, contexts, users, jiras, a, makeClient } = setup();
  const sched = runner.schedulerFor(a.id);
  assert.equal(runner.schedulerFor(a.id), sched);
  await sched.addRule(rule);
  const old = jiras['a@jira.com'];
  jiras['a2@jira.com'] = createFakeJira({ issues: [issue('SIJUD-1')] });
  users.setJira(a.id, { email: 'a2@jira.com', token: 'tok-new', accountId: 'acc-a2' });
  users.markToken(a.id, 'ok');
  contexts.invalidate(a.id);
  await runner.tick();
  assert.equal(posts(old).length, 0);
  assert.equal(posts(jiras['a2@jira.com']).length, 1);
  void makeClient;
});

test('usuário sem token: CRUD de regras funciona; tick o ignora', async () => {
  const { runner, users } = setup();
  const d = users.create({ email: 'd@x.com', name: 'd', passwordHash: 'h' });
  const s = runner.schedulerFor(d.id);
  await s.setPaused(false);
  const st = await s.status();
  assert.deepEqual(st.rules, []);
  await assert.rejects(s.addRule(rule));
  await runner.tick();
});

async function seed(db, ids) {
  for (const id of ids) await autoStoreFor(db, id).writeRules({ paused: false, rules: [{ id: `r-${id.slice(0, 4)}`, ...rule, comment: 'x', since: '2026-11-10', until: null, enabled: true }] });
}

test('concurrency limita usuários simultâneos', async () => {
  const one = setup({ concurrency: 1 });
  await seed(one.db, [one.a.id, one.c.id]);
  await one.runner.tick();
  assert.equal(one.maxInflight(), 1);
  const two = setup({ concurrency: 2 });
  await seed(two.db, [two.a.id, two.c.id]);
  await two.runner.tick();
  assert.equal(two.maxInflight(), 2);
});

test('erro inesperado em um usuário não impede os outros', async () => {
  const { db, runner, jiras, users, contexts, a, c } = setup();
  await seed(db, [a.id, c.id]);
  const orig = contexts.forUser;
  contexts.forUser = (u) => { if (u.id === a.id) throw new Error('boom'); return orig(u); };
  const out = await runner.tick();
  assert.equal(posts(jiras['c@jira.com']).length, 1);
  assert.ok(out.some((e) => e.userId === c.id && e.status === 'created'));
  void users;
});
