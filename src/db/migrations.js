// Migrações do SQLite. Cada item de MIGRATIONS é um script SQL aplicado uma única vez,
// em ordem; `schema_version` guarda o número de migrações já aplicadas.
//
// Convenções:
//  - Timestamps (created_at, at, expires_at, ...): inteiros em epoch milissegundos (INTEGER).
//    Datas de calendário (rule_done.date, rule_log.date, since, until): 'AAAA-MM-DD' (TEXT).
//  - users.email: UNIQUE com COLLATE NOCASE (a unicidade ignora maiúsculas); a camada
//    de repositório grava sempre em minúsculas.
//  - Tudo que pertence a um usuário referencia users(id) com ON DELETE CASCADE.
//  - Ids de usuário/regra são TEXT (rules.id preserva os ids hex de 8 caracteres existentes).
//  - Segredos/tokens: só hash ou texto criptografado (*_hash, *_enc); nunca texto claro.
//  - Booleanos: INTEGER 0/1.

export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    active        INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE user_secrets (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    jira_email        TEXT,
    jira_account_id   TEXT,
    jira_token_enc    TEXT,
    anthropic_key_enc TEXT,
    token_status      TEXT NOT NULL DEFAULT 'missing' CHECK (token_status IN ('ok','invalid','missing')),
    checked_at        INTEGER
  );

  CREATE TABLE sessions (
    id_hash    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_by    TEXT REFERENCES users(id) ON DELETE CASCADE,
    used_at    INTEGER,
    kind       TEXT NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite','reset'))
  );

  CREATE TABLE rules (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    summary TEXT,
    start   TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    comment TEXT,
    since   TEXT,
    until   TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_rules_user ON rules(user_id);

  CREATE TABLE rule_done (
    rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    status  TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (rule_id, date)
  );

  CREATE TABLE rule_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id    TEXT,
    at         INTEGER NOT NULL,
    key        TEXT,
    date       TEXT,
    start      TEXT,
    minutes    INTEGER,
    status     TEXT NOT NULL,
    message    TEXT,
    worklog_id TEXT
  );
  CREATE INDEX idx_rule_log_user_at ON rule_log(user_id, at);

  CREATE TABLE user_settings (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auto_paused INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_favorites_user_key ON favorites(user_id, key);

  CREATE TABLE oauth_clients (
    client_id          TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    redirect_uris      TEXT NOT NULL,
    name               TEXT,
    created_at         INTEGER NOT NULL
  );

  CREATE TABLE oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_challenge TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    scopes         TEXT,
    expires_at     INTEGER NOT NULL
  );

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes     TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id);

  CREATE TABLE audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,
    via     TEXT NOT NULL CHECK (via IN ('web','mcp','auto')),
    action  TEXT NOT NULL,
    detail  TEXT
  );
  CREATE INDEX idx_audit_user_at ON audit(user_id, at);
  `,
  // Convites do tipo 'reset' apontam para o usuário cuja senha será redefinida.
  `
  ALTER TABLE invites ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  `,
];

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const atual = row?.v ?? 0;
  for (let i = atual; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
