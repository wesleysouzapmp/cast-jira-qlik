// Provedor OAuth do conector MCP (interface OAuthServerProvider do SDK), sobre o
// repositório src/db/oauth.js.
//
// Decisões:
//  - authorize() não decide nada: guarda o pedido em memória (id aleatório, 10 min) e manda o
//    navegador para /consentimento.html?pedido=<id>. A tela (com sessão) chama describe() e
//    decide(); quem aprova é o dono do código. O pedido é de uso único.
//  - challengeForAuthorizationCode() só LÊ o código (peekCode): o SDK confere o PKCE antes de
//    chamar exchangeAuthorizationCode(), que consome (takeCode) e confere cliente e redirect_uri.
//  - Registro: só redirect_uri HTTPS em host da lista permitida (redirectHosts; env
//    MCP_REDIRECT_HOSTS; padrão claude.ai,claude.com) ou http/https em localhost/127.0.0.1/[::1]
//    (desenvolvimento/testes). Evita consentimento "phishing" com destino arbitrário.
//    getClient() esconde clientes já gravados cujo redirect_uri saiu da lista (o /authorize
//    responde 400 direto, sem redirecionar).
//  - getClient() nunca devolve client_secret (o banco só tem o hash); por isso o segredo de
//    clientes confidenciais é conferido por checkClientSecret(), montado antes do /token e do
//    /revoke (o authenticateClient do SDK compara texto puro e pularia a checagem).
//  - verifyAccessToken() recusa token de usuário desativado; AuthInfo.extra = { userId }.
import { randomToken } from '../auth/tokens.js';
import {
  InvalidClientError, InvalidClientMetadataError, InvalidGrantError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const PENDING_TTL_MS = 10 * 60 * 1000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const DEFAULT_REDIRECT_HOSTS = Object.freeze(['claude.ai', 'claude.com']);

// 'a.com, B.com' ou ['a.com'] -> ['a.com','b.com']; vazio/ausente -> padrão.
export function parseRedirectHosts(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [...DEFAULT_REDIRECT_HOSTS];
}

function redirectChecker(hosts) {
  const allowed = new Set(parseRedirectHosts(hosts));
  return (uri) => {
    let u;
    try { u = new URL(uri); } catch { return false; }
    if (u.hash || u.username || u.password) return false;
    if (LOOPBACK.has(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
    return u.protocol === 'https:' && allowed.has(u.hostname);
  };
}

const withType = (tokens, scopes) => ({
  ...tokens, token_type: 'Bearer', ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
});

export function createOAuthProvider({ oauth, users, now = () => Date.now(), redirectHosts }) {
  if (!oauth || !users) throw new Error('createOAuthProvider: oauth e users são obrigatórios.');
  const allowedRedirect = redirectChecker(redirectHosts);
  const pending = new Map(); // id -> { clientId, clientName, redirectUri, challenge, state, scopes, resource, expiresAt }

  function prune() {
    const t = now();
    for (const [id, p] of pending) if (p.expiresAt <= t) pending.delete(id);
  }
  function live(id) {
    prune();
    return pending.get(String(id)) ?? null;
  }

  const clientsStore = {
    getClient(clientId) {
      const c = oauth.getClient(clientId);
      if (!c || !(c.redirect_uris ?? []).every(allowedRedirect)) return undefined;
      return c;
    },
    registerClient(client) {
      const uris = client.redirect_uris ?? [];
      if (!uris.length || !uris.every(allowedRedirect)) {
        throw new InvalidClientMetadataError('redirect_uri não permitida: use HTTPS num host autorizado (MCP_REDIRECT_HOSTS) ou http://localhost para testes.');
      }
      oauth.saveClient(client);
      return client; // o SDK devolve isto ao cliente (com o client_secret, se houver, uma única vez)
    },
  };

  return {
    clientsStore,

    async authorize(client, params, res) {
      prune();
      const id = randomToken(24);
      pending.set(id, {
        clientId: client.client_id,
        clientName: client.client_name || client.client_id,
        redirectUri: params.redirectUri,
        challenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.href,
        expiresAt: now() + PENDING_TTL_MS,
      });
      res.redirect(302, `/consentimento.html?pedido=${encodeURIComponent(id)}`);
    },

    // Para a tela de consentimento. null = pedido inexistente/vencido/já usado.
    describe(id) {
      const p = live(id);
      if (!p) return null;
      return { cliente: p.clientName, escopos: p.scopes, destino: new URL(p.redirectUri).host };
    },

    // Consome o pedido e devolve a URL de retorno (com code ou error=access_denied).
    decide(id, userId, allow) {
      const p = live(id);
      if (!p) return null;
      pending.delete(String(id));
      const url = new URL(p.redirectUri);
      if (allow) {
        const code = randomToken();
        oauth.saveCode({
          code, clientId: p.clientId, userId, challenge: p.challenge,
          redirectUri: p.redirectUri, scopes: p.scopes, resource: p.resource,
        });
        url.searchParams.set('code', code);
      } else {
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('error_description', 'O usuário negou o acesso.');
      }
      if (p.state !== undefined) url.searchParams.set('state', p.state);
      return { redirect: url.href, clientId: p.clientId, allowed: Boolean(allow) };
    },

    async challengeForAuthorizationCode(client, code) {
      const c = oauth.peekCode(code);
      if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Código de autorização inválido ou vencido.');
      return c.challenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri) {
      const c = oauth.takeCode(code);
      if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Código de autorização inválido ou vencido.');
      if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri não confere com a do pedido.');
      if (!users.byId(c.userId)?.active) throw new InvalidGrantError('Usuário desativado.');
      return withType(oauth.issueTokens({ clientId: c.clientId, userId: c.userId, scopes: c.scopes }), c.scopes);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const tokens = oauth.refresh(refreshToken, client.client_id);
      if (!tokens) throw new InvalidGrantError('Token de renovação inválido ou vencido.');
      return withType(tokens);
    },

    async verifyAccessToken(token) {
      const r = oauth.verify(token);
      if (!r) throw new InvalidTokenError('Token inválido ou vencido.');
      if (!users.byId(r.userId)?.active) throw new InvalidTokenError('Usuário desativado.');
      return { token, clientId: r.clientId, scopes: r.scopes, expiresAt: Math.floor(r.expiresAt / 1000), extra: { userId: r.userId } };
    },

    async revokeToken(_client, { token }) {
      oauth.revoke(token);
    },

    // Middleware (depois de um body parser urlencoded): confere client_secret de clientes
    // confidenciais. Públicos (token_endpoint_auth_method 'none') passam direto.
    checkClientSecret(req, res, next) {
      const clientId = req.body?.client_id;
      const client = typeof clientId === 'string' ? oauth.getClient(clientId) : null;
      if (!client || client.token_endpoint_auth_method === 'none') return next();
      const expired = client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(now() / 1000);
      if (expired || !oauth.verifyClientSecret(clientId, req.body?.client_secret)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json(new InvalidClientError('Credenciais do cliente inválidas.').toResponseObject());
      }
      next();
    },
  };
}
