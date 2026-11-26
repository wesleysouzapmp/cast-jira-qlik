// Dados por usuário no SQLite: favoritos e agendamentos automáticos. Expõem as mesmas
// interfaces dos stores em arquivo (createFavoritesStore / createAutoStore), então
// createAutoScheduler e as rotas funcionam sem mudança.
//
// Decisões:
//  - Timestamps do agendador (`at`) são strings ISO; as colunas são INTEGER (epoch ms,
//    convenção das migrações). Gravamos Date.parse(iso) e lemos new Date(ms).toISOString():
//    para ISOs gerados por toISOString() (o que o agendador usa) a ida e volta é idêntica.
//    Um `at` não interpretável vira 0.
//  - rules.key é NOT NULL; regras por texto (key null) guardam '' e voltam como null.
//  - Ordem das regras/favoritos = ordem de inserção (rowid); writeRules faz upsert (nunca
//    apaga e recria regras mantidas, para não perder o rule_done por cascata).
//  - rules.id é chave primária global: id já usado por outro usuário lança Error.
//  - importLegacy/exportLegacy são síncronas e rodam em transação.
import { KEY_RE, MAX_FAVORITES } from '../worklog/favorites.js';

const HISTORY_MAX = 200;

const toMs = (iso) => { const n = Date.parse(iso); return Number.isNaN(n) ? 0 : n; };
const toIso = (ms) => new Date(ms).toISOString();

function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- favoritos ----------
function listFavorites(db, userId) {
  return db.prepare('SELECT key FROM favorites WHERE user_id = ? ORDER BY rowid').all(userId).map((r) => r.key);
}

export function favoritesFor(db, userId) {
  return {
    async list() { return listFavorites(db, userId); },
    async add(key) {
      if (typeof key !== 'string' || !KEY_RE.test(key)) throw new RangeError('Chave de tarefa inválida.');
      return tx(db, () => {
        const keys = listFavorites(db, userId);
        if (keys.includes(key)) return keys;
        if (keys.length >= MAX_FAVORITES) throw new RangeError(`No máximo ${MAX_FAVORITES} favoritos.`);
        db.prepare('INSERT INTO favorites (user_id, key) VALUES (?, ?)').run(userId, key);
        return [...keys, key];
      });
    },
    async remove(key) {
      db.prepare('DELETE FROM favorites WHERE user_id = ? AND key = ?').run(userId, String(key));
      return listFavorites(db, userId);
    },
  };
}

// ---------- espaço padrão para novos épicos ----------
// Id do projeto do Jira escolhido na última criação de épico (só gravado quando o épico foi criado).
export function epicSpaceFor(db, userId) {
  return {
    get() { return db.prepare('SELECT epic_project_id AS p FROM user_settings WHERE user_id = ?').get(userId)?.p ?? null; },
    set(projectId) {
      db.prepare('INSERT INTO user_settings (user_id, epic_project_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET epic_project_id = excluded.epic_project_id')
        .run(userId, String(projectId));
    },
  };
}

// ---------- regras ----------
function readRulesSync(db, userId) {
  const paused = Boolean(db.prepare('SELECT auto_paused AS p FROM user_settings WHERE user_id = ?').get(userId)?.p);
  const rules = db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY rowid').all(userId).map((r) => ({
    id: r.id, key: r.key === '' ? null : r.key, summary: r.summary ?? null, start: r.start, minutes: r.minutes,
    comment: r.comment ?? null, since: r.since ?? null, until: r.until ?? null, enabled: Boolean(r.enabled),
  }));
  return { paused, rules };
}

function writeRulesSync(db, userId, { paused = false, rules = [] } = {}) {
  tx(db, () => {
    db.prepare('INSERT INTO user_settings (user_id, auto_paused) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET auto_paused = excluded.auto_paused')
      .run(userId, paused ? 1 : 0);
    const owner = db.prepare('SELECT user_id FROM rules WHERE id = ?');
    const upsert = db.prepare(`INSERT INTO rules (id, user_id, key, summary, start, minutes, comment, since, until, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET key = excluded.key, summary = excluded.summary, start = excluded.start, minutes = excluded.minutes,
        comment = excluded.comment, since = excluded.since, until = excluded.until, enabled = excluded.enabled`);
    for (const r of rules) {
      const o = owner.get(r.id);
      if (o && o.user_id !== userId) throw new Error(`Regra ${r.id} pertence a outro usuário.`);
      upsert.run(r.id, userId, r.key ?? '', r.summary ?? null, r.start, r.minutes, r.comment ?? null, r.since ?? null, r.until ?? null, r.enabled === false ? 0 : 1);
    }
    const keep = new Set(rules.map((r) => r.id));
    const del = db.prepare('DELETE FROM rules WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM rules WHERE user_id = ?').all(userId)) if (!keep.has(id)) del.run(id);
  });
}

// ---------- log ----------
function readLogSync(db, userId) {
  const done = {};
  const rows = db.prepare(`SELECT d.rule_id, d.date, d.status, d.at FROM rule_done d JOIN rules r ON r.id = d.rule_id
    WHERE r.user_id = ? ORDER BY d.rowid`).all(userId);
  for (const r of rows) done[`${r.rule_id}|${r.date}`] = { status: r.status, at: toIso(r.at) };
  const history = db.prepare('SELECT * FROM rule_log WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(userId, HISTORY_MAX).map((r) => ({
    at: toIso(r.at), ruleId: r.rule_id, key: r.key, date: r.date, start: r.start, minutes: r.minutes, status: r.status,
    ...(r.message != null ? { message: r.message } : {}),
    ...(r.worklog_id != null ? { worklogId: r.worklog_id } : {}),
  }));
  return { done, history };
}

function writeLogSync(db, userId, { done = {}, history = [] } = {}) {
  tx(db, () => {
    db.prepare('DELETE FROM rule_done WHERE rule_id IN (SELECT id FROM rules WHERE user_id = ?)').run(userId);
    const ins = db.prepare('INSERT OR REPLACE INTO rule_done (rule_id, date, status, at) VALUES (?, ?, ?, ?)');
    const mine = new Set(db.prepare('SELECT id FROM rules WHERE user_id = ?').all(userId).map((r) => r.id));
    for (const [k, v] of Object.entries(done)) {
      const i = k.indexOf('|');
      const ruleId = k.slice(0, i);
      if (i < 0 || !mine.has(ruleId)) continue; // done de regra inexistente não tem onde ficar
      ins.run(ruleId, k.slice(i + 1), v.status, toMs(v.at));
    }
    db.prepare('DELETE FROM rule_log WHERE user_id = ?').run(userId);
    // Mais novos primeiro; empates mantêm a ordem do array. Insere do mais velho ao mais novo
    // para que o id cresça com a recência (leitura: at DESC, id DESC).
    const newest = history.map((h, i) => ({ h, i })).sort((x, y) => toMs(y.h.at) - toMs(x.h.at) || x.i - y.i).slice(0, HISTORY_MAX).reverse();
    const log = db.prepare(`INSERT INTO rule_log (user_id, rule_id, at, key, date, start, minutes, status, message, worklog_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const { h } of newest) {
      log.run(userId, h.ruleId ?? null, toMs(h.at), h.key ?? null, h.date ?? null, h.start ?? null, h.minutes ?? null, h.status, h.message ?? null, h.worklogId != null ? String(h.worklogId) : null);
    }
  });
}

export function autoStoreFor(db, userId) {
  return {
    async readRules() { return readRulesSync(db, userId); },
    async writeRules(d) { writeRulesSync(db, userId, d); },
    async readLog() { return readLogSync(db, userId); },
    async writeLog(d) { writeLogSync(db, userId, d); },
  };
}

// ---------- migração dos arquivos JSON (Tarefa 17) ----------
export function exportLegacy(db, userId) {
  return { rules: readRulesSync(db, userId), log: readLogSync(db, userId), favorites: listFavorites(db, userId) };
}

// Idempotente: regras/log substituem os do usuário (ids e `done` preservados); favoritos
// são acrescentados sem duplicar (até o limite).
export function importLegacy(db, userId, { rules, log, favorites } = {}) {
  tx(db, () => {
    if (rules) writeRulesSync(db, userId, rules);
    if (log) writeLogSync(db, userId, log);
    if (favorites) {
      const ins = db.prepare('INSERT OR IGNORE INTO favorites (user_id, key) VALUES (?, ?)');
      for (const k of favorites) {
        if (typeof k !== 'string' || !KEY_RE.test(k)) continue;
        if (listFavorites(db, userId).length >= MAX_FAVORITES) break;
        ins.run(userId, k);
      }
    }
  });
}
