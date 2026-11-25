// Conector MCP: servidor MCP (sem estado) e montagem das rotas OAuth + /mcp no app Express.
//
// mountMcp(app, { provider, publicUrl, users, audit, rateLimit, serverDeps })
//  - provider: createOAuthProvider(...); publicUrl: origem pública sem barra final
//    (https://<publicHost> em produção; http://127.0.0.1:<porta> local/testes — ver publicUrlFor).
//  - Deve ser chamado DEPOIS do requireUser (as rotas /api/consentimento usam req.user) e ANTES
//    do static/handlers finais. As rotas OAuth e /mcp não usam cookie (requireUser só barra
//    /api/* e *.html).
//  - rateLimit: repassado às opções de cada handler do SDK (false desliga; padrão do SDK).
//  - serverDeps: repassado a createMcpServer, que registra as ferramentas (src/mcp/tools.js).
import { createRequire } from 'node:module';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { HttpError, route, auditLog } from '../web/route.js';
import { registerTools } from './tools.js';

const { version } = createRequire(import.meta.url)('../../package.json');

// Caminhos sem cookie: a checagem de CSRF por Origin não se aplica (ver server.js).
export const MCP_CSRF_EXEMPT = new Set(['/authorize', '/token', '/register', '/revoke', '/mcp']);

// https://<publicHost> quando configurado; senão a origem local onde o app escuta.
export function publicUrlFor(config, port) {
  if (config?.publicHost) return `https://${config.publicHost}`;
  return `http://127.0.0.1:${port}`;
}

// Um servidor por requisição (modo sem estado). deps = { ...serverDeps, user, auth, publicUrl }:
// `user` é { id, name, email, role } de quem chama e `auth` o AuthInfo do Bearer (extra.userId).
// serverDeps (de createApp): { contexts, holidayProvider, autoRunner, now }. Sem `user` (ex.: testes
// de unidade), o servidor sobe sem ferramentas.
export function createMcpServer(deps = {}) {
  const server = new McpServer({ name: 'cast-jira', version });
  const { user, contexts, holidayProvider, autoRunner, publicUrl, now } = deps;
  if (user) {
    const ctx = contexts ? contexts.forUser(user) : { missing: true };
    registerTools(server, { user, ctx, holidays: holidayProvider, autoRunner, publicUrl, ...(now ? { now } : {}) });
  }
  return server;
}

export function mountMcp(app, { provider, publicUrl, users, audit, rateLimit, serverDeps = {} }) {
  if (!provider || !publicUrl || !users) throw new Error('mountMcp: provider, publicUrl e users são obrigatórios.');
  const base = String(publicUrl).replace(/\/+$/, '');
  const rl = rateLimit === undefined ? {} : { rateLimit };

  // Segredo de cliente confidencial conferido antes dos handlers do SDK.
  const secretCheck = [express.urlencoded({ extended: false }), provider.checkClientSecret];
  app.post('/token', ...secretCheck);
  app.post('/revoke', ...secretCheck);

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(`${base}/`),
    resourceName: 'Cast Jira',
    authorizationOptions: rl,
    tokenOptions: rl,
    clientRegistrationOptions: rl,
    revocationOptions: rl,
  }));

  app.get('/api/consentimento/:pedido', route((req) => {
    const info = provider.describe(req.params.pedido);
    if (!info) throw new HttpError(404, 'Pedido de autorização inválido, vencido ou já usado. Volte ao Claude e conecte de novo.');
    return info;
  }));

  app.post('/api/consentimento/:pedido', route((req) => {
    const permitir = req.body?.permitir;
    if (typeof permitir !== 'boolean') throw new HttpError(400, 'Informe permitir: true ou false.');
    const out = provider.decide(req.params.pedido, req.user.id, permitir);
    if (!out) throw new HttpError(404, 'Pedido de autorização inválido, vencido ou já usado. Volte ao Claude e conecte de novo.');
    auditLog(audit, req, 'mcp.consentimento', { clientId: out.clientId, permitido: out.allowed });
    return { redirect: out.redirect };
  }));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource`,
  });

  app.post('/mcp', bearer, async (req, res) => {
    const u = users.byId(req.auth.extra.userId);
    const user = { id: u.id, name: u.name, email: u.email, role: u.role };
    const server = createMcpServer({ ...serverDeps, user, auth: req.auth, publicUrl: base });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp]', err?.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno no servidor do app.' }, id: null });
      }
    }
  });

  // Sem estado: não há stream GET nem sessão para encerrar.
  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
  app.get('/mcp', bearer, notAllowed);
  app.delete('/mcp', bearer, notAllowed);
}
