// Contexto por usuário: cada requisição/execução do agendador recebe serviços construídos
// com as credenciais Jira DAQUELE usuário. É o ponto central do isolamento multiusuário.
//
// Decisões:
//  - Sem token utilizável (tokenStatus 'missing' ou sem token) -> { missing: true }.
//  - tokenStatus 'invalid' ainda constrói o contexto (a UI precisa mostrar o problema e
//    permitir reenviar o token); o agendador pula quem não está 'ok' via secrets.tokenStatus.
//  - Cache por userId; invalidate(userId) descarta (use ao trocar token/chave).
//  - Resposta 401 do Jira: markToken(id,'invalid') + invalidate(id); a resposta segue intacta.
//  - `secrets` expõe só { jiraEmail, tokenStatus, accountId }: nunca token nem chave Anthropic.
import { createJiraClient } from './jiraClient.js';
import { createSupportService } from './support/service.js';
import { createWorklogService } from './worklog/service.js';
import { createAiCommenter } from './worklog/ai.js';
import { favoritesFor, autoStoreFor } from './db/userData.js';
import { createSubtaskRepo } from './db/templates.js';

export function createContextFactory({ db, users, baseUrl, holidays, makeClient = createJiraClient, makeAi = createAiCommenter }) {
  const cache = new Map();

  function invalidate(userId) { cache.delete(userId); }

  function build(userId) {
    const s = users.getSecrets(userId);
    if (!s.jiraToken || s.tokenStatus === 'missing') return { missing: true };

    const raw = makeClient({ baseUrl, email: s.jiraEmail, token: s.jiraToken });
    const client = {
      ...raw,
      async call(opts) {
        const res = await raw.call(opts);
        if (res && res.status === 401) {
          // Só age se este contexto ainda é o vigente; 401 tardio de contexto antigo é ignorado.
          if (cache.get(userId) === ctx) {
            users.markToken(userId, 'invalid');
            invalidate(userId);
          }
        }
        return res;
      },
    };
    // Fase das subtarefas criadas pelo app (Parte 3), no banco.
    const supportService = createSupportService({ client, baseUrl, subtaskStore: createSubtaskRepo(db, userId) });
    const ai = makeAi({ apiKey: s.anthropicKey || undefined });
    const worklogService = createWorklogService({ client, baseUrl, supportService, ai, holidays });
    const ctx = {
      client, supportService, worklogService, ai,
      favorites: favoritesFor(db, userId),
      autoStore: autoStoreFor(db, userId),
      secrets: { jiraEmail: s.jiraEmail, tokenStatus: s.tokenStatus, accountId: s.accountId },
    };
    return ctx;
  }

  return {
    forUser(user) {
      const hit = cache.get(user.id);
      if (hit) return hit;
      const ctx = build(user.id);
      if (!ctx.missing) cache.set(user.id, ctx);
      return ctx;
    },
    invalidate,
  };
}
