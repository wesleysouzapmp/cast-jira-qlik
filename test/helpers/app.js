// App de teste: banco em memória, usuário real com sessão real (cookie `sid`) e
// `contexts.forUser` devolvendo os serviços falsos que o teste passar.
//
// makeTestApp({ services, user, scheduler, holidayProvider, config })
//  - services: objeto de contexto ({ client, supportService, worklogService, favorites, secrets })
//    ou função (user) => contexto; `{ missing: true }` simula usuário sem token do Jira.
//    Sem `secrets`, o contexto ganha { tokenStatus: 'ok' }.
//  - user: { email, name, role } do usuário logado (padrão ana@x.com).
//  - scheduler: agendador falso; vira autoRunner.schedulerFor(userId) => scheduler
//    (ou passe `autoRunner` direto).
//  - contexts: fábrica de contexto real (substitui a falsa); makeJiraClient, validateAnthropicKey
//    e oauth são repassados ao createApp. `contexts` aqui é (db, users) => fábrica.
//  - mcp: true (ou objeto extra) monta o conector MCP com publicUrl = base e, sem `oauth`,
//    um repositório OAuth real no mesmo banco.
// Devolve { base, json, cookie, login, db, users, sessions, audit, user, contexts, requester, oauth }.
//  - json(method, path, body, headers) envia o cookie da sessão.
//  - login(dados) cria outro usuário + sessão e devolve { user, cookie, json }.
import { after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../../src/server.js';
import { openDb } from '../../src/db/index.js';
import { createUserRepo } from '../../src/db/users.js';
import { createSessionRepo } from '../../src/db/sessions.js';
import { createAuditRepo } from '../../src/db/audit.js';
import { createRateLimiter } from '../../src/auth/rateLimit.js';
import { createOAuthRepo } from '../../src/db/oauth.js';

const servers = [];
after(() => servers.forEach((s) => { s.closeAllConnections?.(); s.close(); }));

export async function makeTestApp({ services = {}, user = {}, scheduler, autoRunner, holidayProvider, config = {}, contexts: realContexts, makeJiraClient, validateAnthropicKey, oauth, mcp } = {}) {
  const db = openDb(':memory:');
  const users = createUserRepo(db, randomBytes(32));
  const sessions = createSessionRepo(db);
  const audit = createAuditRepo(db);
  const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  const contexts = realContexts?.(db, users) ?? {
    forUser(u) {
      const ctx = typeof services === 'function' ? services(u) : services;
      if (ctx.missing) return { missing: true };
      return { secrets: { jiraEmail: u.email, tokenStatus: 'ok', accountId: null }, ...ctx };
    },
    invalidate() {},
  };
  const runner = autoRunner ?? (scheduler ? { schedulerFor: () => scheduler } : undefined);
  // O servidor sobe antes do app: o MCP precisa da URL pública (com a porta) ao montar.
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  if (mcp) oauth ??= createOAuthRepo(db);
  const app = createApp({
    config: { baseUrl: 'https://x.atlassian.net', ...config },
    db, users, sessions, contexts, audit, holidayProvider, autoRunner: runner, limiter,
    makeJiraClient, validateAnthropicKey, oauth,
    mcp: mcp ? { publicUrl: base, ...(typeof mcp === 'object' ? mcp : {}) } : undefined,
  });
  server.on('request', app);

  const requester = (cookie) => (method, path, body, headers = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  function login({ email, name = 'Usuário', role = 'user' } = {}) {
    const u = users.create({ email: email ?? `u${randomBytes(4).toString('hex')}@x.com`, name, role, passwordHash: 'nao-usado' });
    const cookie = `sid=${sessions.create(u.id, 'teste').token}`;
    return { user: u, cookie, json: requester(cookie) };
  }
  const main = login({ email: 'ana@x.com', name: 'Ana', role: 'admin', ...user });
  return { base, json: main.json, cookie: main.cookie, user: main.user, login, db, users, sessions, audit, contexts, requester, oauth };
}
