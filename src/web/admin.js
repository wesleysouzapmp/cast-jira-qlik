// Rotas de administração (só role = admin): usuários, convites, redefinição de senha e
// ativação/desativação.
//
// Decisões:
//  - O papel é lido de req.user (resolvido do banco a cada requisição): rebaixar um admin
//    vale na hora.
//  - Links são absolutos: https://<publicHost> quando configurado; senão a origem da própria
//    requisição (o Host já passou pela checagem de localhost/publicHost do servidor).
//  - Desativar: setActive(false), apaga as sessões, invalida o contexto e só então revoga os
//    tokens OAuth (oauth.revokeFor, quando existir): falha na revogação não pula a invalidação
//    (e o verificador do MCP já recusa usuário inativo). O admin não pode desativar a si mesmo.
import { HttpError, route, auditLog } from './route.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESET_TTL_MS = 24 * 3600 * 1000;
const ROLES = new Set(['user', 'admin']);

export function registerAdmin(app, { users, sessions, contexts, config, audit, oauth }) {
  app.use('/api/admin', (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    next();
  });

  const origin = (req) => (config.publicHost ? `https://${config.publicHost}` : `${req.protocol}://${req.headers.host}`);
  const target = (req) => {
    const u = users.byId(String(req.params.id));
    if (!u) throw new HttpError(404, 'Usuário não encontrado.');
    return u;
  };

  app.get('/api/admin/usuarios', route(() => ({ users: users.list() })));

  app.post('/api/admin/convites', route((req) => {
    const role = req.body?.role ?? 'user';
    if (!ROLES.has(role)) throw new HttpError(400, 'Papel inválido (use user ou admin).');
    const { token } = sessions.createInvite({ role, createdBy: req.user.id, kind: 'invite', ttlMs: INVITE_TTL_MS });
    auditLog(audit, req, 'admin.convite', { role });
    return { link: `${origin(req)}/convite.html?token=${encodeURIComponent(token)}`, expiresInHours: INVITE_TTL_MS / 3600000 };
  }));

  app.post('/api/admin/usuarios/:id/redefinicao', route((req) => {
    const u = target(req);
    const { token } = sessions.createInvite({ role: u.role, createdBy: req.user.id, kind: 'reset', userId: u.id, ttlMs: RESET_TTL_MS });
    auditLog(audit, req, 'admin.redefinicao', { userId: u.id });
    return { link: `${origin(req)}/convite.html?token=${encodeURIComponent(token)}&tipo=redefinir`, expiresInHours: RESET_TTL_MS / 3600000 };
  }));

  app.put('/api/admin/usuarios/:id/ativo', route(async (req) => {
    const ativo = req.body?.ativo;
    if (typeof ativo !== 'boolean') throw new HttpError(400, 'Informe ativo: true ou false.');
    const u = target(req);
    if (!ativo && u.id === req.user.id) throw new HttpError(400, 'Você não pode desativar a sua própria conta.');
    users.setActive(u.id, ativo);
    if (!ativo) {
      sessions.destroyAllFor(u.id);
      contexts.invalidate(u.id);
      if (typeof oauth?.revokeFor === 'function') await oauth.revokeFor(u.id);
    }
    auditLog(audit, req, 'admin.ativo', { userId: u.id, ativo });
    return { ok: true };
  }));
}
