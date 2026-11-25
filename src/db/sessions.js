import { randomToken, sha256 } from '../auth/tokens.js';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// Sessões e convites/reset. Só o hash SHA-256 do token é gravado.
export function createSessionRepo(db, now = () => Date.now()) {
  const q = {
    insert: db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
    resolve: db.prepare(`SELECT s.user_id, s.expires_at, s.created_at, s.user_agent,
        u.id AS u_id, u.email, u.name, u.role, u.active, u.password_hash, u.created_at AS u_created
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`),
    renew: db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    destroyAll: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    destroyExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?'),
    listFor: db.prepare('SELECT id_hash, expires_at, created_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at'),
    inviteInsert: db.prepare('INSERT INTO invites (token_hash, role, created_by, expires_at, kind, user_id) VALUES (?, ?, ?, ?, ?, ?)'),
    inviteTake: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?'),
    inviteGet: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
  };

  return {
    create(userId, userAgent) {
      const token = randomToken();
      const t = now();
      q.insert.run(sha256(token), userId, t + SESSION_TTL_MS, t, userAgent ?? null);
      return { token };
    },
    resolve(token) {
      if (!token) return null;
      const hash = sha256(token);
      const r = q.resolve.get(hash);
      if (!r) return null;
      const t = now();
      if (r.expires_at <= t) { q.purge.run(hash); return null; }
      if (r.active !== 1) return null;
      const expiresAt = t + SESSION_TTL_MS;
      q.renew.run(expiresAt, hash);
      return {
        session: { userId: r.user_id, expiresAt, createdAt: r.created_at, userAgent: r.user_agent },
        user: { id: r.u_id, email: r.email, name: r.name, role: r.role, active: true, passwordHash: r.password_hash, createdAt: r.u_created },
      };
    },
    destroy(token) { q.purge.run(sha256(token)); },
    destroyAllFor(userId, exceptToken) {
      if (exceptToken) q.destroyExcept.run(userId, sha256(exceptToken));
      else q.destroyAll.run(userId);
    },
    listFor(userId) {
      return q.listFor.all(userId, now()).map((r) => ({
        id: r.id_hash, expiresAt: r.expires_at, createdAt: r.created_at, userAgent: r.user_agent,
      }));
    },

    createInvite({ role = 'user', createdBy = null, kind = 'invite', userId = null, ttlMs }) {
      const token = randomToken();
      q.inviteInsert.run(sha256(token), role, createdBy, now() + ttlMs, kind, userId);
      return { token };
    },
    // Atômico: um único UPDATE condicional; só quem muda a linha leva o convite.
    takeInvite(token, kind) {
      if (!token) return null;
      const hash = sha256(token);
      const t = now();
      const res = q.inviteTake.run(t, hash, kind, t);
      if (res.changes !== 1) return null;
      const r = q.inviteGet.get(hash);
      return {
        role: r.role, kind: r.kind, createdBy: r.created_by, userId: r.user_id,
        expiresAt: r.expires_at, usedAt: r.used_at,
      };
    },
  };
}
