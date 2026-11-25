// Rotas de "Minha conta": dados da conta, token do Jira, chave Anthropic, senha e sessões.
//
// Decisões:
//  - Token do Jira e chave Anthropic nunca voltam em resposta nem vão para a auditoria.
//  - O token só é gravado depois que o Jira aceita (GET /rest/api/3/myself com um cliente
//    novo); o accountId vem dessa resposta. Depois de gravar, o contexto é invalidado.
//  - Troca de senha exige a atual e encerra as outras sessões (a atual continua).
import Anthropic from '@anthropic-ai/sdk';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { sha256 } from '../auth/tokens.js';
import { HttpError, route, auditLog } from './route.js';

const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const JIRA_REFUSED = 'O Jira recusou esse e-mail/token.';
const JIRA_UNREACHABLE = 'Não foi possível falar com o Jira agora. Tente de novo em instantes.';

// Validação padrão da chave Anthropic: uma listagem de modelos (barata, sem gerar texto).
// true = aceita; false = recusada (401/403); outras falhas propagam (viram 502).
export async function defaultValidateAnthropicKey(key) {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.list({ limit: 1 });
    return true;
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) return false;
    throw err;
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function registerAccount(app, { users, sessions, contexts, config, audit, limiter, makeJiraClient, validateAnthropicKey }) {
  app.get('/api/conta', route((req) => {
    const id = req.user.id;
    const s = users.getSecrets(id);
    const current = req.sessionToken ? sha256(req.sessionToken) : null;
    return {
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      jira: { email: s.jiraEmail, status: s.tokenStatus, checkedAt: s.checkedAt ?? null },
      anthropic: { configured: Boolean(s.anthropicKey) },
      sessions: sessions.listFor(id).map((x) => ({
        createdAt: x.createdAt, expiresAt: x.expiresAt, userAgent: x.userAgent, current: x.id === current,
      })),
    };
  }));

  app.put('/api/conta/jira', route(async (req) => {
    const email = str(req.body?.email);
    const token = str(req.body?.token);
    if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'Informe um e-mail válido.');
    if (!token || token.length > 1000) throw new HttpError(400, 'Informe o token do Jira.');
    const client = makeJiraClient({ baseUrl: config.baseUrl, email, token });
    let res;
    try { res = await client.call({ method: 'GET', path: '/rest/api/3/myself' }); } catch { res = { status: 0 }; }
    const status = res?.status ?? 0;
    if (status === 0 || status === 429 || status >= 500) throw new HttpError(502, JIRA_UNREACHABLE);
    if (status !== 200) throw new HttpError(400, JIRA_REFUSED);
    const accountId = typeof res.data?.accountId === 'string' ? res.data.accountId : null;
    users.setJira(req.user.id, { email, token, accountId });
    contexts.invalidate(req.user.id);
    auditLog(audit, req, 'conta.jira', { jiraEmail: email });
    return { ok: true, jira: { email, status: 'ok' } };
  }));

  app.put('/api/conta/anthropic', route(async (req) => {
    const raw = req.body?.key;
    if (raw === null) {
      users.setAnthropic(req.user.id, null);
      contexts.invalidate(req.user.id);
      auditLog(audit, req, 'conta.anthropic', { configured: false });
      return { ok: true, anthropic: { configured: false } };
    }
    const key = str(raw);
    if (!key || key.length > 500) throw new HttpError(400, 'Informe a chave da Anthropic (ou null para remover).');
    let ok;
    try { ok = await validateAnthropicKey(key); } catch {
      throw new HttpError(502, 'Não foi possível validar a chave com a Anthropic agora. Tente de novo em instantes.');
    }
    if (!ok) throw new HttpError(400, 'A Anthropic recusou essa chave.');
    users.setAnthropic(req.user.id, key);
    contexts.invalidate(req.user.id);
    auditLog(audit, req, 'conta.anthropic', { configured: true });
    return { ok: true, anthropic: { configured: true } };
  }));

  app.put('/api/conta/senha', route(async (req) => {
    const atual = typeof req.body?.atual === 'string' ? req.body.atual : '';
    const nova = typeof req.body?.nova === 'string' ? req.body.nova : '';
    const key = `senha|${req.user.id}`;
    if (!limiter.hit(key)) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const user = users.byId(req.user.id);
    if (!user || !(await verifyPassword(atual, user.passwordHash))) throw new HttpError(400, 'Senha atual incorreta.');
    if (nova.length < MIN_PASSWORD) throw new HttpError(400, `A nova senha deve ter pelo menos ${MIN_PASSWORD} caracteres.`);
    limiter.reset(key);
    users.setPassword(user.id, await hashPassword(nova));
    sessions.destroyAllFor(user.id, req.sessionToken);
    auditLog(audit, req, 'conta.senha', null);
    return { ok: true };
  }));

  app.delete('/api/conta/sessoes', route((req) => {
    sessions.destroyAllFor(req.user.id, req.sessionToken);
    auditLog(audit, req, 'conta.sessoes', null);
    return { ok: true };
  }));
}
