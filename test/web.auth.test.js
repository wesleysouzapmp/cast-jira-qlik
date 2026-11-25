import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createSessionRepo } from '../src/db/sessions.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { hashPassword } from '../src/auth/passwords.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

const SENHA = 'senha-bem-longa-1';

async function start({ publicHost } = {}) {
  const db = openDb(':memory:');
  const users = createUserRepo(db, randomBytes(32));
  const sessions = createSessionRepo(db);
  const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  const config = { baseUrl: 'https://x.atlassian.net', email: 'e@x', tokenConfigured: true, ...(publicHost ? { publicHost } : {}) };
  const worklogService = { async listTasks() { return []; } };
  const app = createApp({ client: { async call() { return {}; } }, config, worklogService, users, sessions, limiter });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ana = users.create({ email: 'ana@x.com', name: 'Ana', role: 'admin', passwordHash: await hashPassword(SENHA) });
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  // fetch não deixa sobrescrever Host; usa http.request quando precisa.
  const raw = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
  return { base, post, raw, users, sessions, ana };
}

const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('login correto devolve cookie HttpOnly SameSite=Lax e /api/me funciona', async () => {
  const { base, post } = await start();
  const res = await post('/api/login', { email: 'ANA@x.com', senha: SENHA });
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^sid=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  assert.doesNotMatch(sc, /Secure/i);
  const me = await (await fetch(base + '/api/me', { headers: { cookie: cookieOf(res) } })).json();
  assert.deepEqual(me.user, { id: me.user.id, name: 'Ana', email: 'ana@x.com', role: 'admin' });
  assert.equal(me.token.status, 'missing');
  assert.equal(JSON.stringify(me).includes('scrypt'), false);
});

test('com publicHost o cookie vai Secure', async () => {
  const { post } = await start({ publicHost: 'cast-horas.duckdns.org' });
  const res = await post('/api/login', { email: 'ana@x.com', senha: SENHA });
  assert.match(res.headers.get('set-cookie'), /Secure/);
});

test('senha errada e e-mail desconhecido dão a mesma resposta 401', async () => {
  const { post } = await start();
  const a = await post('/api/login', { email: 'ana@x.com', senha: 'errada-errada' });
  const b = await post('/api/login', { email: 'ninguem@x.com', senha: 'errada-errada' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), { error: 'E-mail ou senha inválidos.' });
  assert.deepEqual(await b.json(), { error: 'E-mail ou senha inválidos.' });
  assert.equal(a.headers.get('set-cookie'), null);
});

test('a sexta tentativa dá 429 e login certo zera o contador', async () => {
  const { post } = await start();
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { email: 'ana@x.com', senha: 'errada-errada' })).status, 401);
  assert.equal((await post('/api/login', { email: 'ana@x.com', senha: SENHA })).status, 429);

  const outro = await start();
  for (let i = 0; i < 4; i++) await outro.post('/api/login', { email: 'ana@x.com', senha: 'errada-errada' });
  assert.equal((await outro.post('/api/login', { email: 'ana@x.com', senha: SENHA })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await outro.post('/api/login', { email: 'ana@x.com', senha: 'errada-errada' })).status, 401);
});

test('logout encerra a sessão e limpa o cookie', async () => {
  const { base, post } = await start();
  const cookie = cookieOf(await post('/api/login', { email: 'ana@x.com', senha: SENHA }));
  const out = await post('/api/logout', {}, { cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /sid=;/);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0|Expires=/i);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie } })).status, 401);
});

test('login com cookie antigo troca a sessão (regenera)', async () => {
  const { base, post } = await start();
  const c1 = cookieOf(await post('/api/login', { email: 'ana@x.com', senha: SENHA }));
  const c2 = cookieOf(await post('/api/login', { email: 'ana@x.com', senha: SENHA }, { cookie: c1 }));
  assert.notEqual(c1, c2);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: c1 } })).status, 401);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: c2 } })).status, 200);
});

test('API protegida sem cookie dá 401; página protegida dá 302 para o login', async () => {
  const { base } = await start();
  const api = await fetch(base + '/api/worklog/tasks');
  assert.equal(api.status, 401);
  assert.ok((await api.json()).error);
  const page = await fetch(base + '/apontar.html?x=1', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html?next=' + encodeURIComponent('/apontar.html?x=1'));
  const raiz = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(raiz.status, 302);
});

test('rotas públicas respondem sem cookie', async () => {
  const { base } = await start();
  for (const p of ['/login.html', '/login.js', '/convite.html', '/convite.js', '/style.css']) {
    assert.equal((await fetch(base + p, { redirect: 'manual' })).status, 200, p);
  }
});

test('convite: GET valida, POST cria usuário e loga, segundo uso dá 410', async () => {
  const { base, post, sessions, users, ana } = await start();
  const { token } = sessions.createInvite({ role: 'user', createdBy: ana.id, kind: 'invite', ttlMs: 3600_000 });
  assert.equal((await fetch(`${base}/api/convite/${token}`)).status, 200);
  assert.equal((await fetch(`${base}/api/convite/invalido`)).status, 410);
  const res = await post(`/api/convite/${token}`, { nome: 'Beto', email: 'Beto@x.com', senha: SENHA });
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  assert.equal(me.user.email, 'beto@x.com');
  assert.equal(me.user.role, 'user');
  assert.ok(users.byEmail('beto@x.com'));
  const again = await post(`/api/convite/${token}`, { nome: 'Outro', email: 'outro@x.com', senha: SENHA });
  assert.equal(again.status, 410);
  assert.equal((await fetch(`${base}/api/convite/${token}`)).status, 410);
});

test('convite: senha curta dá 400 e não consome o convite; e-mail repetido dá 409', async () => {
  const { post, sessions, ana } = await start();
  const { token } = sessions.createInvite({ role: 'user', createdBy: ana.id, kind: 'invite', ttlMs: 3600_000 });
  assert.equal((await post(`/api/convite/${token}`, { nome: 'Beto', email: 'b@x.com', senha: 'curta' })).status, 400);
  assert.equal((await post(`/api/convite/${token}`, { nome: 'Ana 2', email: 'ana@x.com', senha: SENHA })).status, 409);
  assert.equal((await post(`/api/convite/${token}`, { nome: 'Beto', email: 'b@x.com', senha: SENHA })).status, 200);
});

test('redefinir: troca a senha e encerra as sessões', async () => {
  const { base, post, sessions, ana } = await start();
  const cookie = cookieOf(await post('/api/login', { email: 'ana@x.com', senha: SENHA }));
  const { token } = sessions.createInvite({ role: 'admin', createdBy: ana.id, kind: 'reset', userId: ana.id, ttlMs: 3600_000 });
  assert.equal((await post(`/api/redefinir/${token}`, { senha: 'curta' })).status, 400);
  assert.equal((await post(`/api/redefinir/${token}`, { senha: 'nova-senha-longa' })).status, 200);
  assert.equal((await post(`/api/redefinir/${token}`, { senha: 'nova-senha-longa' })).status, 410);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie } })).status, 401);
  assert.equal((await post('/api/login', { email: 'ana@x.com', senha: SENHA })).status, 401);
  assert.equal((await post('/api/login', { email: 'ana@x.com', senha: 'nova-senha-longa' })).status, 200);
});

test('cabeçalhos de segurança em qualquer resposta', async () => {
  const { base } = await start();
  for (const p of ['/login.html', '/api/me', '/nao-existe']) {
    const res = await fetch(base + p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'", p);
  }
});

test('Host: publicHost aceito só quando configurado (ignora caixa e porta)', async () => {
  const sem = await start();
  assert.equal((await sem.raw('/login.html', { headers: { Host: 'cast-horas.duckdns.org' } })).status, 403);
  const com = await start({ publicHost: 'Cast-Horas.duckdns.org' });
  assert.equal((await com.raw('/login.html', { headers: { Host: 'cast-horas.duckdns.org' } })).status, 200);
  assert.equal((await com.raw('/login.html', { headers: { Host: 'CAST-horas.duckdns.org:8443' } })).status, 200);
  assert.equal((await com.raw('/login.html', { headers: { Host: 'evil.com' } })).status, 403);
  assert.equal((await com.raw('/login.html', { headers: { Host: 'localhost' } })).status, 200);
});

test('POST com Origin de outro site dá 403; mesmo host passa', async () => {
  const { base, post } = await start();
  const evil = await post('/api/login', { email: 'ana@x.com', senha: SENHA }, { Origin: 'https://evil.com' });
  assert.equal(evil.status, 403);
  const host = new URL(base).host;
  const ok = await post('/api/login', { email: 'ana@x.com', senha: SENHA }, { Origin: `http://${host}` });
  assert.equal(ok.status, 200);
});

test('createApp sem auth continua igual (sem 401, sem rotas de login)', async () => {
  const app = createApp({ client: { async call() { return {}; } }, config: { tokenConfigured: true } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/catalog')).status, 200);
  assert.equal((await fetch(base + '/api/me')).status, 404);
});
