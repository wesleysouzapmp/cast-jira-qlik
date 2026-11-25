// Catálogo de UST: leitura para qualquer usuário logado; gravação só para admin
// (a rota /api/admin/* já passa pela checagem de papel em registerAdmin).
import { HttpError, route, auditLog } from './route.js';
import { validateItems } from '../shared/ustCatalog.js';

export function registerCatalog(app, { catalog, audit }) {
  app.get('/api/ust/catalogo', route((req) => ({ ...catalog.get(), canEdit: req.user?.role === 'admin' })));

  app.put('/api/admin/ust/catalogo', route((req) => {
    let items;
    try { items = validateItems(req.body?.items); } catch (err) {
      if (err instanceof RangeError) throw new HttpError(400, err.message);
      throw err;
    }
    catalog.replaceAll(items, req.user.id);
    auditLog(audit, req, 'ust.catalogo', { count: items.length });
    return { ok: true, count: items.length };
  }));
}
