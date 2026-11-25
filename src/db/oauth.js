import { randomToken, sha256 } from '../auth/tokens.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 3600 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const parseScopes = (s) => (s ? JSON.parse(s) : []);

// Repositório OAuth do MCP. Códigos e tokens só existem no banco como SHA-256.
// O client_secret (se houver) também só é guardado como hash: getClient() NUNCA o devolve;
// use verifyClientSecret(). Clientes públicos (token_endpoint_auth_method 'none') não têm segredo.
export function createOAuthRepo(db, now = () => Date.now()) {
  const q = {
    clientInsert: db.prepare(`INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, name, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET client_secret_hash = excluded.client_secret_hash,
        redirect_uris = excluded.redirect_uris, name = excluded.name, metadata = excluded.metadata`),
    clientGet: db.prepare('SELECT client_id, client_secret_hash, redirect_uris, name, created_at, metadata FROM oauth_clients WHERE client_id = ?'),
    codeInsert: db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, expires_at, resource)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    codePeek: db.prepare('SELECT client_id, user_id, code_challenge, redirect_uri, scopes, expires_at, resource FROM oauth_codes WHERE code_hash = ?'),
    codeTake: db.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING client_id, user_id, code_challenge, redirect_uri, scopes, expires_at, resource'),
    tokenInsert: db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    accessGet: db.prepare(`SELECT user_id, client_id, scopes, expires_at FROM oauth_tokens
      WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?`),
    refreshTake: db.prepare(`UPDATE oauth_tokens SET revoked_at = ?
      WHERE token_hash = ? AND kind = 'refresh' AND client_id = ? AND revoked_at IS NULL AND expires_at > ?
      RETURNING user_id, scopes`),
    revoke: db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL'),
    revokeUser: db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'),
    revokeUserClient: db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL'),
    connectors: db.prepare(`SELECT t.client_id, c.name, MIN(t.created_at) AS created_at, MAX(t.created_at) AS last_used_at
      FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
      GROUP BY t.client_id, c.name ORDER BY created_at, t.client_id`),
  };

  function codeRow(r) {
    if (!r || r.expires_at <= now()) return null;
    return {
      clientId: r.client_id, userId: r.user_id, challenge: r.code_challenge,
      redirectUri: r.redirect_uri, scopes: parseScopes(r.scopes), resource: r.resource ?? undefined,
    };
  }

  function mint(clientId, userId, scopes) {
    const t = now();
    const access = randomToken();
    const refresh = randomToken();
    const sc = JSON.stringify(scopes ?? []);
    q.tokenInsert.run(sha256(access), 'access', clientId, userId, sc, t + ACCESS_TTL_MS, t);
    q.tokenInsert.run(sha256(refresh), 'refresh', clientId, userId, sc, t + REFRESH_TTL_MS, t);
    return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000 };
  }

  return {
    // info: OAuthClientInformationFull do SDK. O metadata (sem client_secret) vai como JSON.
    saveClient(info) {
      const { client_secret, ...meta } = info;
      q.clientInsert.run(
        info.client_id,
        client_secret ? sha256(client_secret) : null,
        JSON.stringify(info.redirect_uris ?? []),
        info.client_name ?? null,
        now(),
        JSON.stringify(meta),
      );
    },
    getClient(clientId) {
      const r = q.clientGet.get(String(clientId));
      if (!r) return null;
      if (r.metadata) return JSON.parse(r.metadata);
      return { client_id: r.client_id, redirect_uris: JSON.parse(r.redirect_uris), client_name: r.name ?? undefined };
    },
    verifyClientSecret(clientId, secret) {
      const r = q.clientGet.get(String(clientId));
      if (!r?.client_secret_hash || !secret) return false;
      return r.client_secret_hash === sha256(secret);
    },
    saveCode({ code, clientId, userId, challenge, redirectUri, scopes, resource }) {
      q.codeInsert.run(sha256(code), clientId, userId, challenge, redirectUri,
        JSON.stringify(scopes ?? []), now() + CODE_TTL_MS, resource ?? null);
    },
    // Uso único: o código é apagado ao ser lido, vencido ou não.
    takeCode(code) {
      if (!code) return null;
      return codeRow(q.codeTake.get(sha256(code)));
    },
    // Leitura sem consumir (o SDK pede o desafio PKCE antes da troca).
    peekCode(code) {
      if (!code) return null;
      return codeRow(q.codePeek.get(sha256(code)));
    },
    issueTokens({ clientId, userId, scopes }) {
      return mint(clientId, userId, scopes);
    },
    // Rotação: o refresh antigo é revogado atomicamente; null se inválido/vencido/de outro cliente.
    // Obs.: access tokens já emitidos continuam valendo até vencer (1 h).
    refresh(refreshToken, clientId) {
      if (!refreshToken) return null;
      const r = q.refreshTake.get(now(), sha256(refreshToken), String(clientId), now());
      if (!r) return null;
      return mint(clientId, r.user_id, parseScopes(r.scopes));
    },
    verify(accessToken) {
      if (!accessToken) return null;
      const r = q.accessGet.get(sha256(accessToken), now());
      if (!r) return null;
      return { userId: r.user_id, clientId: r.client_id, scopes: parseScopes(r.scopes), expiresAt: r.expires_at };
    },
    revoke(token) {
      if (token) q.revoke.run(now(), sha256(token));
    },
    revokeFor(userId, clientId) {
      if (clientId) q.revokeUserClient.run(now(), userId, clientId);
      else q.revokeUser.run(now(), userId);
    },
    connectorsFor(userId) {
      return q.connectors.all(userId, now()).map((r) => ({
        clientId: r.client_id, name: r.name ?? r.client_id, createdAt: r.created_at, lastUsedAt: r.last_used_at,
      }));
    },
  };
}
