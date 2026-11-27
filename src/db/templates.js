// Rascunhos das tarefas de apoio (antigos modelos; tabela support_templates + atividades em
// support_draft_activities) e o último rascunho usado por usuário. Atividades já validadas
// (src/support/templates.js), na ordem do passo Atividades do wizard.
// Os itens antigos (CAT, tamanho, título; support_template_items) continuam legíveis em `items`.
// Visibilidade: público = todos; privado = só o dono; o admin vê todos (para administrar).
import { randomUUID } from 'node:crypto';

export const SYSTEM_TEMPLATE_ID = 'padrao';

export function createTemplateRepo(db, now = () => Date.now()) {
  const q = {
    all: db.prepare(`SELECT t.*, u.name AS owner_name FROM support_templates t
      LEFT JOIN users u ON u.id = t.owner_id ORDER BY (t.id = '${SYSTEM_TEMPLATE_ID}') DESC, t.name COLLATE NOCASE, t.created_at`),
    one: db.prepare(`SELECT t.*, u.name AS owner_name FROM support_templates t
      LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ?`),
    items: db.prepare('SELECT cat, size, summary, description FROM support_template_items WHERE template_id = ? ORDER BY position'),
    activities: db.prepare('SELECT action, activity AS text FROM support_draft_activities WHERE template_id = ? ORDER BY position'),
    insert: db.prepare('INSERT INTO support_templates (id, name, is_public, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE support_templates SET name = ?, is_public = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM support_templates WHERE id = ?'),
    clearActivities: db.prepare('DELETE FROM support_draft_activities WHERE template_id = ?'),
    addActivity: db.prepare('INSERT INTO support_draft_activities (template_id, position, action, activity) VALUES (?, ?, ?, ?)'),
    lastUsed: db.prepare('SELECT last_template_id FROM user_settings WHERE user_id = ?'),
    setLastUsed: db.prepare(`INSERT INTO user_settings (user_id, last_template_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_template_id = excluded.last_template_id`),
  };

  const map = (r) => (r ? {
    id: r.id, name: r.name, public: r.is_public === 1, ownerId: r.owner_id ?? null, ownerName: r.owner_name ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    activities: q.activities.all(r.id).map((a) => ({ action: a.action, text: a.text })),
    items: q.items.all(r.id).map((i) => ({ ...i })),
  } : null);

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const writeActivities = (id, list) => {
    q.clearActivities.run(id);
    list.forEach((a, n) => q.addActivity.run(id, n, a.action, a.text));
  };
  // Utilizável no wizard: público ou do próprio usuário (o admin vê os privados alheios só para administrar).
  const isUsable = (t, user) => Boolean(t) && (t.public || (t.ownerId !== null && t.ownerId === user?.id));
  // user: { id, role }.
  const isVisible = (t, user) => Boolean(t) && (t.public || user?.role === 'admin' || (t.ownerId !== null && t.ownerId === user?.id));

  return {
    get: (id) => map(q.one.get(String(id))),
    isVisible,
    isUsable,
    listVisible: (user) => q.all.all().map(map).filter((t) => isVisible(t, user)),
    create({ name, public: isPublic, activities }, ownerId) {
      const id = randomUUID();
      const t = now();
      tx(() => {
        q.insert.run(id, name, isPublic ? 1 : 0, ownerId ?? null, t, t);
        writeActivities(id, activities);
      });
      return map(q.one.get(id));
    },
    update(id, { name, public: isPublic, activities }) {
      tx(() => {
        q.update.run(name, isPublic ? 1 : 0, now(), id);
        writeActivities(id, activities);
      });
      return map(q.one.get(id));
    },
    remove: (id) => q.remove.run(String(id)).changes > 0,
    lastUsed: (userId) => q.lastUsed.get(userId)?.last_template_id ?? null,
    setLastUsed(userId, templateId) { q.setLastUsed.run(userId, templateId); },
  };
}

// Fase das subtarefas criadas pelo app (support_subtasks). Chave do Jira → fase.
export function createSubtaskRepo(db, userId = null, now = () => Date.now()) {
  const ins = db.prepare(`INSERT INTO support_subtasks (key, phase, epic_key, user_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET phase = excluded.phase, epic_key = excluded.epic_key`);
  return {
    set({ key, phase, epicKey }) { ins.run(key, phase, epicKey, userId, now()); },
    phases(keys) {
      const out = new Map();
      const list = [...new Set(keys)];
      for (let i = 0; i < list.length; i += 200) {
        const part = list.slice(i, i + 200);
        const rows = db.prepare(`SELECT key, phase FROM support_subtasks WHERE key IN (${part.map(() => '?').join(', ')})`).all(...part);
        for (const r of rows) out.set(r.key, r.phase);
      }
      return out;
    },
  };
}
