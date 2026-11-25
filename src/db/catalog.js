// Catálogo de UST (um só para todos os usuários): itens CAT + tamanho → UST e a última alteração.
// replaceAll troca o catálogo inteiro numa transação: se algo falhar, o anterior fica intacto.
const SIZE_ORDER = { P: 1, M: 2, G: 3, Hora: 4 };
const catNum = (cat) => Number(cat.slice(4));

export function createCatalogRepo(db, now = () => Date.now()) {
  const q = {
    all: db.prepare('SELECT cat, size, ust, task, description FROM ust_catalog'),
    meta: db.prepare('SELECT m.updated_at, u.name FROM ust_catalog_meta m LEFT JOIN users u ON u.id = m.updated_by WHERE m.id = 1'),
    clear: db.prepare('DELETE FROM ust_catalog'),
    insert: db.prepare('INSERT INTO ust_catalog (cat, size, ust, task, description) VALUES (?, ?, ?, ?, ?)'),
    touch: db.prepare('INSERT INTO ust_catalog_meta (id, updated_at, updated_by) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, updated_by = excluded.updated_by'),
  };
  return {
    // { items (ordenados por número do CAT e tamanho), updatedAt (epoch ms) | null, updatedBy (nome) | null }
    get() {
      const items = q.all.all().map((r) => ({ cat: r.cat, size: r.size, ust: r.ust, task: r.task, description: r.description }))
        .sort((a, b) => catNum(a.cat) - catNum(b.cat) || SIZE_ORDER[a.size] - SIZE_ORDER[b.size]);
      const m = q.meta.get();
      return { items, updatedAt: m?.updated_at ?? null, updatedBy: m?.name ?? null };
    },
    // items já validados (validateItems).
    replaceAll(items, userId) {
      db.exec('BEGIN');
      try {
        q.clear.run();
        for (const i of items) q.insert.run(i.cat, i.size, i.ust, i.task ?? '', i.description ?? '');
        q.touch.run(now(), userId ?? null);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
