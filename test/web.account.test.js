import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';
import { createContextFactory } from '../src/context.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';

const TOKEN = 'TOKEN-SECRETO-123';

// Fábrica de cliente Jira falsa: responde /myself conforme `status` e registra as credenciais.
function fakeJira({ status = 200, accountId = 'acc-1', fail = false } = {}) {
  const made = [];
  const factory = ({ baseUrl, email, token }) => {
    made.push({ baseUrl, email, token });
    return {
      async call({ path }) {
        if (fail) return { status: 0, ok: false, data: { error: 'Falha de rede' } };
        if (path === '/rest/api/3/myself' && status === 200) return { status: 200, ok: true, data: { accountId, emailAddress: email } };
        return { status, ok: false, data: { errorMessages: ['nope'] } };
      },
    };
  };
  factory.made = made;
  return factory;
}

test('GET /api/conta nunca devolve o token nem a chave Anthropic', async () => {
  const t = await makeTestApp();
  t.users.setJira(t.user.id, { email: 'ana@x.com', token: TOKEN, accountId: 'acc-9' });
  t.users.setAnthropic(t.user.id, 'sk-ant-SEGREDO');
  const res = await t.json('GET', '/api/conta');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('SEGREDO'));
  const body = JSON.parse(text);
  assert.equal(body.name, 'Ana');
  assert.equal(body.email, 'ana@x.com');
  assert.equal(body.jira.email, 'ana@x.com');
  assert.equal(body.jira.status, 'ok');
  assert.equal(typeof body.jira.checkedAt, 'number');
  assert.deepEqual(body.anthropic, { configured: true });
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].current, true);
  assert.equal(body.connectors, undefined);
});

test('PUT /api/conta/jira: Jira 401 → 400 e nada é gravado', async () => {
  const makeJiraClient = fakeJira({ status: 401 });
  const t = await makeTestApp({ makeJiraClient });
  const res = await t.json('PUT', '/api/conta/jira', { email: 'ana@x.com', token: TOKEN });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'O Jira recusou esse e-mail/token.');
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal(t.users.getSecrets(t.user.id).jiraToken, null);
  assert.equal(t.users.getSecrets(t.user.id).tokenStatus, 'missing');
  assert.equal(makeJiraClient.made[0].token, TOKEN);
  assert.equal(makeJiraClient.made[0].baseUrl, 'https://x.atlassian.net');
});

test('PUT /api/conta/jira: falha de rede → 502 e nada é gravado', async () => {
  const t = await makeTestApp({ makeJiraClient: fakeJira({ fail: true }) });
  const res = await t.json('PUT', '/api/conta/jira', { email: 'ana@x.com', token: TOKEN });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Jira/);
  assert.equal(t.users.getSecrets(t.user.id).jiraToken, null);
});

test('PUT /api/conta/jira: entrada inválida → 400', async () => {
  const t = await makeTestApp({ makeJiraClient: fakeJira() });
  assert.equal((await t.json('PUT', '/api/conta/jira', { email: 'x', token: TOKEN })).status, 400);
  assert.equal((await t.json('PUT', '/api/conta/jira', { email: 'ana@x.com', token: '' })).status, 400);
});

test('PUT /api/conta/jira: Jira 200 grava com accountId, invalida e o forUser seguinte usa o token novo', async () => {
  const makeJiraClient = fakeJira({ status: 200, accountId: 'acc-NEW' });
  const ctxClients = [];
  const t = await makeTestApp({
    makeJiraClient,
    contexts: (db, users) => createContextFactory({
      db, users, baseUrl: 'https://x.atlassian.net',
      makeClient: (opts) => { ctxClients.push(opts); return { async call() { return { status: 200, ok: true, data: {} }; } }; },
      makeAi: () => ({ enabled: false }),
    }),
  });
  // Contexto antigo em cache, com token velho.
  t.users.setJira(t.user.id, { email: 'ana@x.com', token: 'VELHO', accountId: 'acc-old' });
  const old = t.contexts.forUser(t.user);
  assert.equal(ctxClients.at(-1).token, 'VELHO');
  assert.equal(t.contexts.forUser(t.user), old); // cache

  const res = await t.json('PUT', '/api/conta/jira', { email: 'Ana.Jira@x.com', token: TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  const s = t.users.getSecrets(t.user.id);
  assert.equal(s.jiraToken, TOKEN);
  assert.equal(s.accountId, 'acc-NEW');
  assert.equal(s.tokenStatus, 'ok');

  const fresh = t.contexts.forUser(t.user);
  assert.notEqual(fresh, old);
  assert.equal(ctxClients.at(-1).token, TOKEN);

  const log = t.audit.list(t.user.id);
  assert.equal(log[0].action, 'conta.jira');
  assert.ok(!JSON.stringify(log).includes(TOKEN));
});

test('PUT /api/conta/anthropic: chave recusada → 400; aceita grava; null remove', async () => {
  const seen = [];
  const validateAnthropicKey = async (key) => { seen.push(key); return key === 'sk-boa'; };
  const t = await makeTestApp({ validateAnthropicKey });
  let res = await t.json('PUT', '/api/conta/anthropic', { key: 'sk-ruim' });
  assert.equal(res.status, 400);
  assert.equal(t.users.getSecrets(t.user.id).anthropicKey, null);

  res = await t.json('PUT', '/api/conta/anthropic', { key: 'sk-boa' });
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes('sk-boa'));
  assert.equal(t.users.getSecrets(t.user.id).anthropicKey, 'sk-boa');

  res = await t.json('PUT', '/api/conta/anthropic', { key: null });
  assert.equal(res.status, 200);
  assert.equal(t.users.getSecrets(t.user.id).anthropicKey, null);
  assert.deepEqual(seen, ['sk-ruim', 'sk-boa']);
  assert.equal(t.audit.list(t.user.id).filter((a) => a.action === 'conta.anthropic').length, 2);
  assert.ok(!JSON.stringify(t.audit.list(t.user.id)).includes('sk-boa'));
});

test('PUT /api/conta/anthropic: erro de rede na validação → 502', async () => {
  const t = await makeTestApp({ validateAnthropicKey: async () => { throw new Error('ECONNRESET'); } });
  const res = await t.json('PUT', '/api/conta/anthropic', { key: 'sk-x' });
  assert.equal(res.status, 502);
  assert.equal(t.users.getSecrets(t.user.id).anthropicKey, null);
});

test('PUT /api/conta/senha exige a atual, mínimo de 10 e encerra as outras sessões', async () => {
  const t = await makeTestApp();
  t.users.setPassword(t.user.id, await hashPassword('senha-antiga-1'));
  const other = t.sessions.create(t.user.id, 'outro').token;

  let res = await t.json('PUT', '/api/conta/senha', { atual: 'errada-errada', nova: 'senha-nova-123' });
  assert.equal(res.status, 400);
  res = await t.json('PUT', '/api/conta/senha', { atual: 'senha-antiga-1', nova: 'curta' });
  assert.equal(res.status, 400);
  res = await t.json('PUT', '/api/conta/senha', { atual: 'senha-antiga-1', nova: 'senha-nova-123' });
  assert.equal(res.status, 200);
  assert.ok(await verifyPassword('senha-nova-123', t.users.byId(t.user.id).passwordHash));
  assert.equal(t.sessions.resolve(other), null);
  assert.equal((await t.json('GET', '/api/conta')).status, 200); // a sessão atual continua
  assert.ok(t.audit.list(t.user.id).some((a) => a.action === 'conta.senha'));
});

test('DELETE /api/conta/sessoes encerra só as outras sessões', async () => {
  const t = await makeTestApp();
  const other = t.sessions.create(t.user.id, 'outro').token;
  const res = await t.json('DELETE', '/api/conta/sessoes');
  assert.equal(res.status, 200);
  assert.equal(t.sessions.resolve(other), null);
  assert.equal((await t.json('GET', '/api/conta')).status, 200);
});

test('usuário comum em /api/admin/* recebe 403', async () => {
  const t = await makeTestApp();
  const bob = t.login({ email: 'bob@x.com', name: 'Bob', role: 'user' });
  for (const [m, p, b] of [
    ['GET', '/api/admin/usuarios'],
    ['POST', '/api/admin/convites', { role: 'user' }],
    ['POST', `/api/admin/usuarios/${t.user.id}/redefinicao`],
    ['PUT', `/api/admin/usuarios/${t.user.id}/ativo`, { ativo: false }],
  ]) {
    assert.equal((await bob.json(m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.equal(t.users.byId(t.user.id).active, true);
});

test('admin lista usuários sem hash de senha', async () => {
  const t = await makeTestApp();
  t.login({ email: 'bob@x.com', name: 'Bob' });
  const res = await t.json('GET', '/api/admin/usuarios');
  assert.equal(res.status, 200);
  const { users } = await res.json();
  assert.equal(users.length, 2);
  assert.ok(users.every((u) => !('passwordHash' in u)));
  assert.ok(users.some((u) => u.email === 'bob@x.com' && u.tokenStatus === 'missing'));
});

test('convite gerado pelo admin funciona no cadastro (Tarefa 7)', async () => {
  const t = await makeTestApp();
  const res = await t.json('POST', '/api/admin/convites', { role: 'user' });
  assert.equal(res.status, 200);
  const { link } = await res.json();
  const url = new URL(link);
  assert.equal(url.origin, t.base);
  assert.equal(url.pathname, '/convite.html');
  const token = url.searchParams.get('token');
  assert.ok(token);
  const reg = await fetch(`${t.base}/api/convite/${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Caio', email: 'caio@x.com', senha: 'senha-bem-longa-1' }),
  });
  assert.equal(reg.status, 200);
  assert.equal(t.users.byEmail('caio@x.com').role, 'user');
  assert.ok(t.audit.list(t.user.id).some((a) => a.action === 'admin.convite'));
});

test('convite: papel inválido → 400; link usa o publicHost quando configurado', async () => {
  const t = await makeTestApp({ config: { publicHost: 'app.exemplo.com' } });
  assert.equal((await t.json('POST', '/api/admin/convites', { role: 'root' })).status, 400);
  const { link } = await (await t.json('POST', '/api/admin/convites', { role: 'admin' })).json();
  assert.match(link, /^https:\/\/app\.exemplo\.com\/convite\.html\?token=/);
});

test('link de redefinição funciona em /api/redefinir', async () => {
  const t = await makeTestApp();
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  assert.equal((await t.json('POST', '/api/admin/usuarios/nao-existe/redefinicao')).status, 404);
  const res = await t.json('POST', `/api/admin/usuarios/${bob.user.id}/redefinicao`);
  assert.equal(res.status, 200);
  const url = new URL((await res.json()).link);
  assert.equal(url.searchParams.get('tipo'), 'redefinir');
  const r = await fetch(`${t.base}/api/redefinir/${url.searchParams.get('token')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'outra-senha-longa' }),
  });
  assert.equal(r.status, 200);
  assert.ok(await verifyPassword('outra-senha-longa', t.users.byId(bob.user.id).passwordHash));
});

test('desativar: a sessão da pessoa dá 401, sessões apagadas, OAuth revogado e contexto invalidado', async () => {
  const revoked = [];
  const t = await makeTestApp({ oauth: { async revokeFor(id) { revoked.push(id); } } });
  const invalidated = [];
  const orig = t.contexts.invalidate;
  t.contexts.invalidate = (id) => { invalidated.push(id); orig(id); };
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  assert.equal((await bob.json('GET', '/api/conta')).status, 200);

  assert.equal((await t.json('PUT', `/api/admin/usuarios/${bob.user.id}/ativo`, { ativo: 'nao' })).status, 400);
  const res = await t.json('PUT', `/api/admin/usuarios/${bob.user.id}/ativo`, { ativo: false });
  assert.equal(res.status, 200);
  assert.equal((await bob.json('GET', '/api/conta')).status, 401);
  assert.equal(t.users.byId(bob.user.id).active, false);
  assert.deepEqual(t.sessions.listFor(bob.user.id), []);
  assert.deepEqual(revoked, [bob.user.id]);
  assert.deepEqual(invalidated, [bob.user.id]);
  assert.ok(t.audit.list(t.user.id).some((a) => a.action === 'admin.ativo' && a.detail.ativo === false));

  // Reativar volta a permitir login (nova sessão).
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${bob.user.id}/ativo`, { ativo: true })).status, 200);
  assert.equal(t.users.byId(bob.user.id).active, true);
});

test('o admin não consegue desativar a si mesmo', async () => {
  const t = await makeTestApp();
  const res = await t.json('PUT', `/api/admin/usuarios/${t.user.id}/ativo`, { ativo: false });
  assert.equal(res.status, 400);
  assert.equal(t.users.byId(t.user.id).active, true);
  assert.equal((await t.json('GET', '/api/conta')).status, 200);
});

test('rotas da conta exigem login', async () => {
  const t = await makeTestApp();
  const res = await fetch(`${t.base}/api/conta`);
  assert.equal(res.status, 401);
});
