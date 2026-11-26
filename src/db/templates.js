// Modelos de tarefas de apoio (support_templates + itens) e o último modelo usado por usuário.
// Itens já validados (src/support/templates.js); a ordem da lista é a ordem de criação no Jira.
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
    insert: db.prepare('INSERT INTO support_templates (id, name, is_public, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE support_templates SET name = ?, is_public = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM support_templates WHERE id = ?'),
    clearItems: db.prepare('DELETE FROM support_template_items WHERE template_id = ?'),
    addItem: db.prepare('INSERT INTO support_template_items (template_id, position, cat, size, summary, description) VALUES (?, ?, ?, ?, ?, ?)'),
    lastUsed: db.prepare('SELECT last_template_id FROM user_settings WHERE user_id = ?'),
    setLastUsed: db.prepare(`INSERT INTO user_settings (user_id, last_template_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_template_id = excluded.last_template_id`),
  };

  const map = (r) => (r ? {
    id: r.id, name: r.name, public: r.is_public === 1, ownerId: r.owner_id ?? null, ownerName: r.owner_name ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, items: q.items.all(r.id).map((i) => ({ ...i })),
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
  const writeItems = (id, items) => {
    q.clearItems.run(id);
    items.forEach((i, n) => q.addItem.run(id, n, i.cat, i.size, i.summary, i.description ?? ''));
  };
  // Utilizável na prévia: público ou do próprio usuário (o admin vê os privados alheios só para administrar).
  const isUsable = (t, user) => Boolean(t) && (t.public || (t.ownerId !== null && t.ownerId === user?.id));
  // user: { id, role }.
  const isVisible = (t, user) => Boolean(t) && (t.public || user?.role === 'admin' || (t.ownerId !== null && t.ownerId === user?.id));

  return {
    get: (id) => map(q.one.get(String(id))),
    isVisible,
    isUsable,
    listVisible: (user) => q.all.all().map(map).filter((t) => isVisible(t, user)),
    create({ name, public: isPublic, items }, ownerId) {
      const id = randomUUID();
      const t = now();
      tx(() => {
        q.insert.run(id, name, isPublic ? 1 : 0, ownerId ?? null, t, t);
        writeItems(id, items);
      });
      return map(q.one.get(id));
    },
    update(id, { name, public: isPublic, items }) {
      tx(() => {
        q.update.run(name, isPublic ? 1 : 0, now(), id);
        writeItems(id, items);
      });
      return map(q.one.get(id));
    },
    remove: (id) => q.remove.run(String(id)).changes > 0,
    lastUsed: (userId) => q.lastUsed.get(userId)?.last_template_id ?? null,
    setLastUsed(userId, templateId) { q.setLastUsed.run(userId, templateId); },
  };
}
