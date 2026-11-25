import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createSessionRepo } from '../src/db/sessions.js';
import { autoStoreFor, favoritesFor } from '../src/db/userData.js';
import { runBootstrap, runInvite } from '../src/admin.js';

const RULES = {
  paused: false,
  rules: [
    { id: 'ba2f553f', key: 'SIJUD-1', summary: null, start: '09:00', minutes: 15, comment: 'Daily', since: '2026-11-03', until: null, enabled: true },
    { id: 'e134e535', key: null, summary: 'Daily - {MM/AAAA}', start: '13:30', minutes: 30, comment: 'x', since: '2026-11-01', until: null, enabled: true },
  ],
};
const LOG = {
  done: {
    'ba2f553f|2026-11-03': { status: 'created', at: '2026-11-10T19:36:27.273Z' },
    'e134e535|2026-11-04': { status: 'conflict', at: '2026-11-10T19:36:27.273Z' },
  },
  history: [{ at: '2026-11-10T19:36:27.273Z', ruleId: 'ba2f553f', key: 'SIJUD-1', date: '2026-11-03', start: '09:00', minutes: 15, status: 'created' }],
};

function setup({ legacy = true, env = {}, jiraStatus = 200 } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-'));
  if (legacy) {
    fs.writeFileSync(path.join(rootDir, 'agendamentos.json'), JSON.stringify(RULES));
    fs.writeFileSync(path.join(rootDir, 'agendamentos-log.json'), JSON.stringify(LOG));
    fs.writeFileSync(path.join(rootDir, 'favoritos.json'), JSON.stringify(['SIJUD-1', 'BI-2']));
  }
  const db = openDb();
  const users = createUserRepo(db, randomBytes(32));
  const sessions = createSessionRepo(db);
  const out = [];
  const calls = [];
  const makeJiraClient = (opts) => {
    calls.push(opts);
    return { call: async () => ({ status: jiraStatus, data: { accountId: 'acc-1' } }) };
  };
  return {
    db, users, sessions, rootDir, makeJiraClient, out, calls,
    env: { ADMIN_PASSWORD: 'senha-longa-123', ...env },
    args: { email: 'Admin@x.com', nome: 'Admin' },
    log: (m) => out.push(String(m)),
  };
}

test('importação preserva ids e done das regras, favoritos e renomeia para .migrado', async () => {
  const s = setup();
  const r = await runBootstrap(s);
  const admin = s.users.byEmail('admin@x.com');
  assert.equal(admin.role, 'admin');
  assert.equal(r.created, true);
  const store = autoStoreFor(s.db, admin.id);
  assert.deepEqual((await store.readRules()).rules.map((x) => x.id).sort(), ['ba2f553f', 'e134e535']);
  const { done } = await store.readLog();
  assert.deepEqual(Object.keys(done).sort(), ['ba2f553f|2026-11-03', 'e134e535|2026-11-04']);
  assert.equal(done['ba2f553f|2026-11-03'].status, 'created');
  assert.deepEqual(await favoritesFor(s.db, admin.id).list(), ['SIJUD-1', 'BI-2']);
  for (const f of ['agendamentos.json', 'agendamentos-log.json', 'favoritos.json']) {
    assert.equal(fs.existsSync(path.join(s.rootDir, f)), false);
    assert.equal(fs.existsSync(path.join(s.rootDir, `${f}.migrado`)), true);
  }
});

test('segunda execução não duplica nada e informa já migrado', async () => {
  const s = setup();
  await runBootstrap(s);
  s.out.length = 0;
  const r = await runBootstrap(s);
  assert.equal(r.created, false);
  assert.equal(s.users.list().length, 1);
  const admin = s.users.byEmail('admin@x.com');
  assert.equal((await autoStoreFor(s.db, admin.id).readRules()).rules.length, 2);
  assert.deepEqual(await favoritesFor(s.db, admin.id).list(), ['SIJUD-1', 'BI-2']);
  assert.ok(s.out.some((l) => /já migrado/.test(l)));
});

test('admin existente: importa os arquivos para ele sem criar outro', async () => {
  const s = setup();
  const ex = s.users.create({ email: 'velho@x.com', name: 'V', role: 'admin', passwordHash: 'h' });
  const r = await runBootstrap(s);
  assert.equal(r.created, false);
  assert.equal(s.users.list().length, 1);
  assert.equal((await autoStoreFor(s.db, ex.id).readRules()).rules.length, 2);
});

test('sem arquivos JSON segue sem erro', async () => {
  const s = setup({ legacy: false });
  const r = await runBootstrap(s);
  assert.equal(r.created, true);
  assert.ok(s.users.byEmail('admin@x.com'));
});

test('Jira: valida via /myself (maxRetries 0) e grava só com 200; token nunca é impresso', async () => {
  const s = setup({ env: { JIRA_EMAIL: 'j@x.com', JIRA_API_TOKEN: 'SEGREDO-TOKEN' } });
  await runBootstrap(s);
  const admin = s.users.byEmail('admin@x.com');
  const sec = s.users.getSecrets(admin.id);
  assert.equal(sec.jiraToken, 'SEGREDO-TOKEN');
  assert.equal(sec.accountId, 'acc-1');
  assert.equal(s.calls[0].maxRetries, 0);
  assert.ok(!s.out.join('\n').includes('SEGREDO-TOKEN'));
  assert.ok(s.out.some((l) => /JIRA_API_TOKEN/.test(l)), 'recomenda remover do .env');
});

test('Jira recusado: avisa, não grava e continua', async () => {
  const s = setup({ env: { JIRA_EMAIL: 'j@x.com', JIRA_API_TOKEN: 'SEGREDO-TOKEN' }, jiraStatus: 401 });
  await runBootstrap(s);
  const admin = s.users.byEmail('admin@x.com');
  assert.equal(s.users.getSecrets(admin.id).jiraToken, null);
  assert.ok(s.out.some((l) => /Minha conta/.test(l)));
  assert.ok(!s.out.join('\n').includes('SEGREDO-TOKEN'));
});

test('senha curta é recusada', async () => {
  const s = setup({ env: { ADMIN_PASSWORD: 'curta' } });
  await assert.rejects(runBootstrap(s), /10 caracteres/);
  assert.equal(s.users.list().length, 0);
});

test('senha via prompt oculto exige confirmação igual', async () => {
  const s = setup({ env: { ADMIN_PASSWORD: '' } });
  const answers = ['abcdefghij1', 'diferente123'];
  s.prompt = async () => answers.shift();
  await assert.rejects(runBootstrap(s), /não conferem/);
});

test('invite: link absoluto com PUBLIC_HOST, válido por 7 dias, criado pelo primeiro admin', async () => {
  const s = setup({ legacy: false });
  await runBootstrap(s);
  const env = { PUBLIC_HOST: 'app.exemplo.com' };
  const link = runInvite({ ...s, env, args: {} });
  assert.match(link, /^https:\/\/app\.exemplo\.com\/convite\.html\?token=[\w-]+$/);
  const peek = s.sessions.peekInvite(new URL(link).searchParams.get('token'), 'invite');
  assert.equal(peek.role, 'user');
  assert.ok(Math.abs(peek.expiresAt - (Date.now() + 7 * 864e5)) < 60000);
  const l2 = runInvite({ ...s, env, args: { admin: true } });
  assert.equal(s.sessions.peekInvite(new URL(l2).searchParams.get('token'), 'invite').role, 'admin');
});
