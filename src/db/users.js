import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from '../auth/crypto.js';

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

function mapUser(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email, name: r.name, role: r.role,
    active: r.active === 1, passwordHash: r.password_hash, createdAt: r.created_at,
  };
}

// Repositório de usuários e segredos. Jira token e chave Anthropic são cifrados com a chave mestra.
export function createUserRepo(db, masterKey, now = () => Date.now()) {
  const q = {
    insert: db.prepare('INSERT INTO users (id, email, name, role, active, password_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    list: db.prepare(`SELECT u.*, COALESCE(s.token_status, 'missing') AS token_status
      FROM users u LEFT JOIN user_secrets s ON s.user_id = u.id ORDER BY u.created_at, u.email`),
    setActive: db.prepare('UPDATE users SET active = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    secrets: db.prepare('SELECT * FROM user_secrets WHERE user_id = ?'),
    setJira: db.prepare(`INSERT INTO user_secrets (user_id, jira_email, jira_account_id, jira_token_enc, token_status, checked_at)
      VALUES (?, ?, ?, ?, 'ok', ?)
      ON CONFLICT(user_id) DO UPDATE SET jira_email = excluded.jira_email, jira_account_id = excluded.jira_account_id,
        jira_token_enc = excluded.jira_token_enc, token_status = 'ok', checked_at = excluded.checked_at`),
    setAnthropic: db.prepare(`INSERT INTO user_secrets (user_id, anthropic_key_enc) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET anthropic_key_enc = excluded.anthropic_key_enc`),
    markToken: db.prepare(`INSERT INTO user_secrets (user_id, token_status, checked_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token_status = excluded.token_status, checked_at = excluded.checked_at`),
    settings: db.prepare('SELECT auto_paused FROM user_settings WHERE user_id = ?'),
    setPaused: db.prepare(`INSERT INTO user_settings (user_id, auto_paused) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET auto_paused = excluded.auto_paused`),
  };

  return {
    create({ email, name, role = 'user', passwordHash }) {
      const id = randomUUID();
      q.insert.run(id, normEmail(email), name, role, passwordHash, now());
      return mapUser(q.byId.get(id));
    },
    byId: (id) => mapUser(q.byId.get(id)),
    byEmail: (email) => mapUser(q.byEmail.get(normEmail(email))),
    list() {
      return q.list.all().map((r) => {
        const { passwordHash, ...u } = mapUser(r);
        return { ...u, tokenStatus: r.token_status };
      });
    },
    setActive(id, active) { q.setActive.run(active ? 1 : 0, id); },
    setPassword(id, hash) { q.setPassword.run(hash, id); },

    getSecrets(id) {
      const r = q.secrets.get(id);
      const vazio = { jiraEmail: null, jiraToken: null, anthropicKey: null, tokenStatus: 'missing', accountId: null };
      if (!r) return vazio;
      try {
        return {
          jiraEmail: r.jira_email,
          jiraToken: r.jira_token_enc ? decrypt(r.jira_token_enc, masterKey) : null,
          anthropicKey: r.anthropic_key_enc ? decrypt(r.anthropic_key_enc, masterKey) : null,
          tokenStatus: r.token_status,
          accountId: r.jira_account_id,
        };
      } catch {
        // Chave mestra diferente / dado corrompido: trata como ausente, sem vazar nada.
        return { ...vazio, jiraEmail: r.jira_email, accountId: r.jira_account_id };
      }
    },
    setJira(id, { email, token, accountId }) {
      q.setJira.run(id, email ?? null, accountId ?? null, encrypt(token, masterKey), now());
    },
    setAnthropic(id, key) { q.setAnthropic.run(id, key ? encrypt(key, masterKey) : null); },
    markToken(id, status) { q.markToken.run(id, status, now()); },

    getSettings(id) {
      const r = q.settings.get(id);
      return { autoPaused: r ? r.auto_paused === 1 : false };
    },
    setAutoPaused(id, paused) { q.setPaused.run(id, paused ? 1 : 0); },
  };
}
