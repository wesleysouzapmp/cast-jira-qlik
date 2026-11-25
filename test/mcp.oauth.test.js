// Conector MCP: fluxo OAuth completo (registro dinâmico, PKCE S256, consentimento, token,
// refresh) e /mcp atrás do Bearer, tudo por HTTP real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { makeTestApp } from './helpers/app.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const MCP_ACCEPT = 'application/json, text/event-stream';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(t, body = {}) {
  const res = await fetch(`${t.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...body,
    }),
  });
  return { status: res.status, body: await res.json() };
}

function authorizeUrl(t, clientId, challenge, extra = {}) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', ...extra,
  });
  return `${t.base}/authorize?${q}`;
}

// /authorize → 302 para o consentimento; devolve o id do pedido.
async function startAuthorize(t, clientId, challenge, extra) {
  const res = await fetch(authorizeUrl(t, clientId, challenge, extra), { redirect: 'manual' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'), t.base);
  assert.equal(loc.pathname, '/consentimento.html');
  return loc.searchParams.get('pedido');
}

async function token(t, form) {
  const res = await fetch(`${t.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: await res.json() };
}

const initialize = (t, accessToken) => fetch(`${t.base}/mcp`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json', Accept: MCP_ACCEPT,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } },
  }),
});

// Fluxo completo até os tokens, com a sessão `who` aprovando.
async function fullFlow(t, who = t) {
  const reg = await register(t);
  const { verifier, challenge } = pkce();
  const pedido = await startAuthorize(t, reg.body.client_id, challenge);
  const res = await who.json('POST', `/api/consentimento/${pedido}`, { permitir: true });
  assert.equal(res.status, 200);
  const redirect = new URL((await res.json()).redirect);
  const tok = await token(t, {
    grant_type: 'authorization_code', client_id: reg.body.client_id, code: redirect.searchParams.get('code'),
    code_verifier: verifier, redirect_uri: REDIRECT,
  });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  return { clientId: reg.body.client_id, tokens: tok.body };
}

test('fluxo de ponta a ponta: registro → authorize → login → consentimento → token → /mcp → refresh', async () => {
  const t = await makeTestApp({ mcp: true });

  // Metadados de descoberta.
  const meta = await (await fetch(`${t.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, `${t.base}/`);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.registration_endpoint, `${t.base}/register`);
  const prm = await fetch(`${t.base}/.well-known/oauth-protected-resource`);
  assert.equal(prm.status, 200);

  // 1. Registro dinâmico (cliente público) + authorize com PKCE S256 → consentimento.
  const reg = await register(t);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(reg.body.client_secret, undefined);
  const clientId = reg.body.client_id;
  const { verifier, challenge } = pkce();
  const pedido = await startAuthorize(t, clientId, challenge);
  assert.ok(pedido);

  // A página de consentimento exige sessão: sem cookie vai para o login com next.
  const semLogin = await fetch(`${t.base}/consentimento.html?pedido=${pedido}`, { redirect: 'manual' });
  assert.equal(semLogin.status, 302);
  assert.equal(semLogin.headers.get('location'), `/login.html?next=${encodeURIComponent(`/consentimento.html?pedido=${pedido}`)}`);
  assert.equal((await fetch(`${t.base}/api/consentimento/${pedido}`)).status, 401);

  // 2. Logado: vê o pedido e permite.
  const pagina = await fetch(`${t.base}/consentimento.html?pedido=${pedido}`, { headers: { cookie: t.cookie } });
  assert.equal(pagina.status, 200);
  const info = await (await t.json('GET', `/api/consentimento/${pedido}`)).json();
  assert.equal(info.cliente, 'Claude');
  assert.deepEqual(info.escopos, []);
  assert.equal(info.destino, 'claude.ai');
  const ok = await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true });
  assert.equal(ok.status, 200);
  const redirect = new URL((await ok.json()).redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'st-123');
  const code = redirect.searchParams.get('code');
  assert.ok(code);
  // Pedido é de uso único.
  assert.equal((await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true })).status, 404);
  assert.equal((await t.json('GET', `/api/consentimento/${pedido}`)).status, 404);

  // 3. Token: verifier errado é recusado sem queimar o código; o certo funciona.
  const errado = await token(t, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pkce().verifier, redirect_uri: REDIRECT });
  assert.equal(errado.status, 400);
  assert.equal(errado.body.error, 'invalid_grant');
  const tok = await token(t, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  assert.ok(tok.body.access_token);
  assert.ok(tok.body.refresh_token);
  assert.equal(tok.body.token_type, 'Bearer');
  assert.equal(tok.body.expires_in, 3600);
  // O código não serve duas vezes.
  const reuso = await token(t, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(reuso.status, 400);

  // 4. /mcp initialize com o token → 200.
  const mcp = await initialize(t, tok.body.access_token);
  assert.equal(mcp.status, 200);
  const init = await mcp.json();
  assert.equal(init.result.serverInfo.name, 'cast-jira');
  assert.ok(init.result.protocolVersion);

  // 5. Sem token (ou token inválido) → 401 com WWW-Authenticate apontando os metadados.
  const sem = await initialize(t);
  assert.equal(sem.status, 401);
  assert.match(sem.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await initialize(t, 'inventado')).status, 401);

  // 6. Refresh gira o token; o refresh antigo não vale mais.
  const ref = await token(t, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.body.refresh_token });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  assert.notEqual(ref.body.access_token, tok.body.access_token);
  assert.equal(ref.body.token_type, 'Bearer');
  assert.equal((await initialize(t, ref.body.access_token)).status, 200);
  const velho = await token(t, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.body.refresh_token });
  assert.equal(velho.status, 400);
  assert.equal(velho.body.error, 'invalid_grant');

  // /revoke derruba o access token.
  const rv = await fetch(`${t.base}/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, token: ref.body.access_token }),
  });
  assert.equal(rv.status, 200);
  assert.equal((await initialize(t, ref.body.access_token)).status, 401);
});

test('negar → redirect com access_denied e state', async () => {
  const t = await makeTestApp({ mcp: true });
  const reg = await register(t);
  const pedido = await startAuthorize(t, reg.body.client_id, pkce().challenge);
  const res = await t.json('POST', `/api/consentimento/${pedido}`, { permitir: false });
  assert.equal(res.status, 200);
  const redirect = new URL((await res.json()).redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'st-123');
  assert.equal(redirect.searchParams.get('code'), null);
  assert.equal((await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true })).status, 404);
  assert.equal((await t.json('POST', '/api/consentimento/inexistente', { permitir: true })).status, 404);
  const ruim = await startAuthorize(t, reg.body.client_id, pkce().challenge);
  assert.equal((await t.json('POST', `/api/consentimento/${ruim}`, { permitir: 'sim' })).status, 400);
});

test('redirect_uri diferente da registrada é recusada (authorize e token)', async () => {
  const t = await makeTestApp({ mcp: true });
  const reg = await register(t);
  const res = await fetch(authorizeUrl(t, reg.body.client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_request');

  // No /token, redirect_uri diferente da usada no authorize → invalid_grant.
  const { verifier, challenge } = pkce();
  const pedido = await startAuthorize(t, reg.body.client_id, challenge);
  const ok = await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true });
  const code = new URL((await ok.json()).redirect).searchParams.get('code');
  const tok = await token(t, { grant_type: 'authorization_code', client_id: reg.body.client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/outro' });
  assert.equal(tok.status, 400);
  assert.equal(tok.body.error, 'invalid_grant');
});

test('registro: só redirect_uri HTTPS ou http://localhost', async () => {
  const t = await makeTestApp({ mcp: true });
  assert.equal((await register(t, { redirect_uris: ['http://evil.example/cb'] })).status, 400);
  assert.equal((await register(t, { redirect_uris: ['http://localhost:6274/cb'] })).status, 201);
  assert.equal((await register(t, { redirect_uris: ['http://127.0.0.1:6274/cb'] })).status, 201);
});

test('código de outro cliente é recusado', async () => {
  const t = await makeTestApp({ mcp: true });
  const a = await register(t);
  const b = await register(t, { client_name: 'Outro' });
  const { verifier, challenge } = pkce();
  const pedido = await startAuthorize(t, a.body.client_id, challenge);
  const code = new URL((await (await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true })).json()).redirect).searchParams.get('code');
  const tok = await token(t, { grant_type: 'authorization_code', client_id: b.body.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(tok.status, 400);
  assert.equal(tok.body.error, 'invalid_grant');
});

test('cliente confidencial: o client_secret é conferido no /token', async () => {
  const t = await makeTestApp({ mcp: true });
  const reg = await register(t, { token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.client_secret);
  const { verifier, challenge } = pkce();
  const pedido = await startAuthorize(t, reg.body.client_id, challenge);
  const code = new URL((await (await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true })).json()).redirect).searchParams.get('code');
  const base = { grant_type: 'authorization_code', client_id: reg.body.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT };
  const sem = await token(t, base);
  assert.equal(sem.status, 401);
  assert.equal(sem.body.error, 'invalid_client');
  assert.equal((await token(t, { ...base, client_secret: 'errado' })).status, 401);
  const ok = await token(t, { ...base, client_secret: reg.body.client_secret });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('o código fica com o usuário que aprovou; usuário desativado → 401 no /mcp', async () => {
  const t = await makeTestApp({ mcp: true });
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  const { tokens } = await fullFlow(t, bob);
  assert.equal(t.oauth.verify(tokens.access_token).userId, bob.user.id);
  assert.equal((await initialize(t, tokens.access_token)).status, 200);
  // Desativado direto no banco (sem passar pela revogação): o verificador recusa.
  t.users.setActive(bob.user.id, false);
  assert.equal((await initialize(t, tokens.access_token)).status, 401);
});

test('conectores: listados em /api/conta e revogados pelo DELETE', async () => {
  const t = await makeTestApp({ mcp: true });
  const { clientId, tokens } = await fullFlow(t);
  const conta = await (await t.json('GET', '/api/conta')).json();
  assert.deepEqual(conta.connectors.map((c) => [c.clientId, c.name]), [[clientId, 'Claude']]);
  assert.equal((await t.json('DELETE', `/api/conta/conectores/${clientId}`)).status, 200);
  assert.equal((await initialize(t, tokens.access_token)).status, 401);
  const ref = await token(t, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
  assert.equal(ref.status, 400);
  assert.deepEqual((await (await t.json('GET', '/api/conta')).json()).connectors, []);
});

test('/mcp: GET e DELETE sem sessão MCP dão 405 (modo sem estado), mas exigem token antes', async () => {
  const t = await makeTestApp({ mcp: true });
  assert.equal((await fetch(`${t.base}/mcp`)).status, 401);
  const { tokens } = await fullFlow(t);
  const res = await fetch(`${t.base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: MCP_ACCEPT } });
  assert.equal(res.status, 405);
});

test('endpoints OAuth e /mcp aceitam Origin de outro site (não usam cookie)', async () => {
  const t = await makeTestApp({ mcp: true });
  const res = await fetch(`${t.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://claude.ai' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201);
  // O consentimento (cookie) continua protegido contra CSRF.
  const pedido = await startAuthorize(t, (await res.json()).client_id, pkce().challenge);
  const csrf = await t.json('POST', `/api/consentimento/${pedido}`, { permitir: true }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
});

test('atrás do proxy (publicHost) o rate limit do SDK aceita X-Forwarded-For sem erro de validação', async () => {
  const t = await makeTestApp({ mcp: true, config: { publicHost: 'cast-horas.duckdns.org' } });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  try {
    const res = await fetch(`${t.base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(res.status, 201);
  } finally { console.error = orig; }
  assert.deepEqual(errors.filter((e) => /X-Forwarded-For|ERR_ERL/.test(e)), []);
});

test('registro: redirect_uri só em hosts permitidos (padrão claude.ai/claude.com) ou loopback', async () => {
  const t = await makeTestApp({ mcp: true });
  const evil = await register(t, { redirect_uris: ['https://evil.example/cb'] });
  assert.equal(evil.status, 400);
  assert.equal(evil.body.error, 'invalid_client_metadata');
  assert.equal((await register(t, { redirect_uris: ['https://claude.ai.evil.example/cb'] })).status, 400);
  assert.equal((await register(t, { redirect_uris: [REDIRECT, 'https://evil.example/cb'] })).status, 400);
  assert.equal((await register(t, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).status, 201);
  assert.equal((await register(t, { redirect_uris: ['https://claude.com/api/mcp/auth_callback'] })).status, 201);
  assert.equal((await register(t, { redirect_uris: ['http://claude.ai/api/mcp/auth_callback'] })).status, 400);
  assert.equal((await register(t, { redirect_uris: ['http://[::1]:6274/cb'] })).status, 201);
});

test('registro: MCP_REDIRECT_HOSTS (redirectHosts) substitui a lista padrão', async () => {
  const t = await makeTestApp({ mcp: { redirectHosts: ['cliente.example'] } });
  assert.equal((await register(t, { redirect_uris: ['https://cliente.example/cb'] })).status, 201);
  assert.equal((await register(t, { redirect_uris: [REDIRECT] })).status, 400);
  assert.equal((await register(t, { redirect_uris: ['http://localhost:6274/cb'] })).status, 201);
});

test('authorize: cliente antigo com redirect_uri fora da lista é recusado sem redirecionar', async () => {
  const t = await makeTestApp({ mcp: true });
  t.oauth.saveClient({ client_id: 'velho', redirect_uris: ['https://evil.example/cb'], client_name: 'Claude', token_endpoint_auth_method: 'none' });
  const res = await fetch(authorizeUrl(t, 'velho', pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
});
