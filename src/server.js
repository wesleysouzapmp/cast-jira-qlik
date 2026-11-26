import express from 'express';
import { fileURLToPath } from 'node:url';
import { CATALOG, getEndpoint, buildPath, isAllowed } from './catalog.js';
import { paginate } from './paginators.js';
import { JiraError } from './support/service.js';
import { validateTemplate, validateTask } from './support/templates.js';
import { createTemplateRepo, SYSTEM_TEMPLATE_ID } from './db/templates.js';
import { epicSpaceFor } from './db/userData.js';
import { runQuick } from './support/quick.js';
import { ConflictError, ScopeError } from './worklog/service.js';
import { AiError } from './worklog/ai.js';
import { registerAuth } from './web/auth.js';
import { registerAccount, defaultValidateAnthropicKey } from './web/account.js';
import { registerAdmin } from './web/admin.js';
import { registerCatalog } from './web/catalog.js';
import { createCatalogRepo } from './db/catalog.js';
import { SIZES, normSize } from './shared/ustCatalog.js';
import { createJiraClient } from './jiraClient.js';
import { createAuditRepo } from './db/audit.js';
import { createOAuthProvider } from './mcp/oauthProvider.js';
import { mountMcp, MCP_CSRF_EXEMPT } from './mcp/index.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('./shared', import.meta.url));
const WORKLOG_TIME = fileURLToPath(new URL('./worklog/time.js', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const STRATEGIES = new Set(['none', 'offset', 'token', 'worklogUpdated']);

class BadRequest extends Error {}

// Monta o Request a partir do catálogo (endpointId) ou do modo livre (path).
function resolveRequest(input = {}) {
  let endpoint;
  let request;
  if (input.endpointId) {
    endpoint = getEndpoint(input.endpointId);
    if (!endpoint) throw new BadRequest(`Endpoint desconhecido: ${input.endpointId}`);
    let path;
    try { path = buildPath(endpoint.path, input.pathParams); } catch (e) { throw new BadRequest(e.message); }
    request = {
      method: endpoint.method,
      path,
      query: input.query ?? { ...endpoint.query },
      body: endpoint.method === 'POST' ? (input.body ?? structuredClone(endpoint.body)) : null,
    };
  } else {
    const method = (input.method ?? 'GET').toUpperCase();
    request = { method, path: String(input.path ?? '').trim(), query: input.query ?? {}, body: method === 'POST' ? (input.body ?? {}) : null };
    const pagination = STRATEGIES.has(input.pagination) ? input.pagination : 'none';
    endpoint = { id: 'custom', label: 'Endpoint livre', method, path: request.path, pagination, dataKey: input.dataKey || null };
  }
  if (!isAllowed(request)) {
    throw new BadRequest('Chamada não permitida: só GET em caminhos /rest/... do próprio Jira (ou os POSTs de leitura do catálogo).');
  }
  if (request.query === null || typeof request.query !== 'object' || Array.isArray(request.query)) {
    throw new BadRequest('query deve ser um objeto chave/valor.');
  }
  return { endpoint, request };
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_KEYS = 50;

function parseKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || !keys.every((k) => typeof k === 'string' && KEY_RE.test(k))) {
    throw new BadRequest(`Informe de 1 a ${MAX_KEYS} chaves de issue válidas (ex.: BI-2931).`);
  }
  return [...new Set(keys)];
}

// Tarefas da prévia/criação por épico: { 'BI-1': [{ cat, size, summary, description }] }, só para
// chaves pedidas; CAT e tamanho revalidados no catálogo de UST.
const MAX_TASKS_PER_EPIC = 40;
const MAX_TASKS = 200;
function parseTasks(tasks, keys, catalogItems) {
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) throw new BadRequest('Lista de tarefas por épico inválida.');
  const out = {};
  let total = 0;
  for (const [key, list] of Object.entries(tasks)) {
    if (!keys.includes(key)) throw new BadRequest(`Tarefas para ${String(key).slice(0, 30)}, que não está entre os épicos escolhidos.`);
    if (!Array.isArray(list) || list.length > MAX_TASKS_PER_EPIC) throw new BadRequest(`${key}: envie de 0 a ${MAX_TASKS_PER_EPIC} tarefas.`);
    total += list.length;
    if (total > MAX_TASKS) throw new BadRequest(`No máximo ${MAX_TASKS} tarefas por pedido.`);
    try {
      out[key] = list.map((t, n) => validateTask(t, catalogItems, `${key}, tarefa ${n + 1}`, { truncate: true }));
    } catch (err) {
      if (err instanceof RangeError) throw new BadRequest(err.message);
      throw err;
    }
  }
  return out;
}

function parseTemplateId(id) {
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' || !id || id.length > 64) throw new BadRequest('Modelo inválido.');
  return id;
}

class NotFound extends Error {}
class Forbidden extends Error {}
class MissingToken extends Error {}
const MISSING_TOKEN = 'Configure seu token do Jira em Minha conta.';

// Contexto Jira do usuário logado (req.ctx); sem token utilizável -> 409.
function jiraCtx(req) {
  if (!req.ctx || req.ctx.missing) throw new MissingToken(MISSING_TOKEN);
  return req.ctx;
}

// Grava a auditoria sem derrubar a resposta: a ação no Jira já aconteceu.
function auditWeb(audit, req, action, detail) {
  if (!audit) return;
  try { audit.log({ userId: req.user.id, via: 'web', action, detail }); } catch (err) { console.error('[auditoria]', err?.message); }
}
const uniqueKeys = (list, field) => [...new Set(list.map((x) => x[field]))];

// Handler das rotas da API: Origin, contexto Jira (quando exigido) e mapeamento de erros.
// fn(req, ctx) recebe o contexto do usuário; com { jira: false } a rota não exige token.
function makeGuard({ jira = true } = {}) {
  return (fn) => async (req, res) => {
    try {
      // Outra página aberta no navegador não pode disparar a criação.
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* origem inválida */ }
        if (host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) {
          return res.status(403).json({ error: 'Origem não permitida.' });
        }
      }
      const ctx = jira ? jiraCtx(req) : req.ctx;
      res.json(await fn(req, ctx));
    } catch (err) {
      if (err instanceof MissingToken) return res.status(409).json({ error: err.message });
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      if (err instanceof NotFound) return res.status(404).json({ error: err.message });
      if (err instanceof Forbidden) return res.status(403).json({ error: err.message });
      if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
      if (err instanceof ScopeError) return res.status(400).json({ error: err.message });
      if (err instanceof JiraError || err instanceof AiError) return res.status(502).json({ error: err.message });
      console.error('[erro interno]', err?.message);
      res.status(500).json({ error: 'Erro interno no servidor do app.' });
    }
  };
}

// Rotas das "Tarefas de apoio" e dos modelos de tarefas.
// Modelos: criar/editar/excluir exige "pode criar" (admin ou chave ligada pelo admin) e ser o dono
// ou o admin; o modelo do sistema (sem dono) só o admin. Privado de outra pessoa: 404.
function registerSupportRoutes(app, { audit, catalog, templates, users, db }) {
  const handle = makeGuard();
  const local = makeGuard({ jira: false });
  const catalogItems = () => catalog?.get().items ?? [];
  const isAdmin = (req) => req.user.role === 'admin';
  const canCreate = (req) => isAdmin(req) || users.byId(req.user.id)?.canCreateTemplates === true;
  const canEdit = (req, t) => canCreate(req) && (isAdmin(req) || (t.ownerId !== null && t.ownerId === req.user.id));
  const view = (req, t) => ({
    id: t.id, name: t.name, public: t.public, system: t.ownerId === null, ownerName: t.ownerName,
    mine: t.ownerId === req.user.id, items: t.items, updatedAt: t.updatedAt, canEdit: canEdit(req, t),
    usable: templates.isUsable(t, req.user),
  });
  const visibleTemplate = (req, id) => {
    const t = templates?.get(id);
    if (!t || !templates.isVisible(t, req.user)) throw new NotFound('Modelo não encontrado.');
    return t;
  };
  // Modelo padrão da prévia: o último usado (se ainda utilizável), senão o "Padrão", senão o primeiro.
  const defaultTemplate = (req) => {
    if (!templates) return null;
    const list = templates.listVisible(req.user).filter((t) => templates.isUsable(t, req.user));
    const last = templates.lastUsed(req.user.id);
    return list.find((t) => t.id === last) ?? list.find((t) => t.id === SYSTEM_TEMPLATE_ID) ?? list[0] ?? null;
  };
  const checked = (fn) => (...args) => {
    try { return fn(...args); } catch (err) { if (err instanceof RangeError) throw new BadRequest(err.message); throw err; }
  };
  const auditTemplate = (req, action, t) => auditWeb(audit, req, action, { templateId: t.id, name: t.name, public: t.public, items: t.items.length });

  app.get('/api/support/items', handle((req, ctx) => {
    const opts = { onlyEpics: req.query.onlyEpics === '1' };
    if (req.query.includeDone === '1') opts.includeDone = true;
    return ctx.supportService.listItems(opts);
  }));

  if (templates) {
    app.get('/api/support/templates', local((req) => ({
      templates: templates.listVisible(req.user).map((t) => view(req, t)),
      canEdit: canCreate(req),
      lastUsedId: defaultTemplate(req)?.id ?? null,
    })));
    app.post('/api/support/templates', local(checked((req) => {
      if (!canCreate(req)) throw new Forbidden('Peça ao administrador para habilitar a criação de modelos.');
      const t = templates.create(validateTemplate(req.body, catalogItems()), req.user.id);
      auditTemplate(req, 'support.template.create', t);
      return { template: view(req, t) };
    })));
    app.put('/api/support/templates/:id', local(checked((req) => {
      const t = visibleTemplate(req, String(req.params.id));
      if (!canEdit(req, t)) throw new Forbidden('Só o dono do modelo ou o administrador pode alterá-lo.');
      const out = templates.update(t.id, validateTemplate(req.body, catalogItems()));
      auditTemplate(req, 'support.template.update', out);
      return { template: view(req, out) };
    })));
    app.delete('/api/support/templates/:id', local((req) => {
      const t = visibleTemplate(req, String(req.params.id));
      if (t.id === SYSTEM_TEMPLATE_ID) throw new Forbidden('O modelo do sistema "Padrão" não pode ser excluído; o administrador pode editá-lo.');
      if (!canEdit(req, t)) throw new Forbidden('Só o dono do modelo ou o administrador pode excluí-lo.');
      templates.remove(t.id);
      auditTemplate(req, 'support.template.delete', t);
      return { ok: true };
    }));
  }

  // Prévia: tarefas do modelo (templateId, ou o padrão da pessoa) e/ou tarefas por épico.
  app.post('/api/support/preview', handle(async (req, ctx) => {
    const keys = parseKeys(req.body?.keys);
    const id = parseTemplateId(req.body?.templateId);
    const template = id ? visibleTemplate(req, id) : defaultTemplate(req);
    const tasks = req.body?.tasks === undefined ? undefined : parseTasks(req.body.tasks, keys, catalogItems());
    const out = await ctx.supportService.preview(keys, { items: template?.items ?? [], ...(tasks ? { tasks } : {}) });
    return { ...out, templateId: template?.id ?? null };
  }));

  // Criação: as tarefas escolhidas na prévia, por épico. templateId (opcional) guarda o último
  // modelo usado e vai para a auditoria.
  app.post('/api/support/create', handle(async (req, ctx) => {
    const keys = parseKeys(req.body?.keys);
    const id = parseTemplateId(req.body?.templateId);
    if (req.body?.tasks === undefined) throw new BadRequest('Informe as tarefas a criar em cada épico.');
    const tasks = parseTasks(req.body.tasks, keys, catalogItems());
    if (!Object.values(tasks).some((l) => l.length)) throw new BadRequest('Marque ao menos uma tarefa para criar.');
    const t = id && templates ? templates.get(id) : null;
    const template = t && templates.isVisible(t, req.user) ? t : null;
    const out = await ctx.supportService.create(keys, tasks);
    if (template) {
      try { templates.setLastUsed(req.user.id, template.id); } catch (err) { console.error('[modelos]', err?.message); }
    }
    auditWeb(audit, req, 'support.create', {
      keys, templateId: template?.id ?? null, template: template?.name ?? null,
      tasks: (out.results ?? []).map((r) => ({ epic: r.epic, cat: r.cat ?? null, size: r.size ?? null, status: r.status, ...(r.key ? { key: r.key } : {}) })),
    });
    return out;
  }));

  // Espaços (projetos do Jira) onde a pessoa pode criar épico; defaultId = o último usado, se ainda vale.
  app.get('/api/support/spaces', handle(async (req, ctx) => {
    const spaces = await ctx.supportService.listSpaces();
    const saved = db ? epicSpaceFor(db, req.user.id).get() : null;
    return { spaces: spaces.map(({ id, key, name }) => ({ id, key, name })), defaultId: spaces.some((s) => s.id === saved) ? saved : null };
  }));

  // Novo apontamento pelo painel do dia: épico (existente, novo ou nenhum) → tarefa (existente ou
  // nova) → apontamento. Resposta por passo; o espaço vira o padrão só quando o épico é criado.
  app.post('/api/support/quick', handle(async (req, ctx) => {
    const input = parseQuick(req.body, catalogItems());
    const out = await runQuick(ctx, input);
    if (input.epic?.new && out.epic?.status === 'created' && db) {
      try { epicSpaceFor(db, req.user.id).set(input.epic.new.projectId); } catch (err) { console.error('[espaço padrão]', err?.message); }
    }
    auditWeb(audit, req, 'support.quick', {
      epic: out.epic?.key ?? null, epicCreated: out.epic?.status === 'created', projectId: input.epic?.new?.projectId ?? null,
      task: out.task?.key ?? null, taskCreated: out.task?.status === 'created', cat: input.task.cat ?? null, size: input.task.size ?? null,
      date: input.worklog.date, start: input.worklog.start, minutes: input.worklog.minutes,
      status: { epic: out.epic?.status ?? null, task: out.task?.status ?? null, worklog: out.worklog?.status ?? null },
    });
    return out;
  }));
}

// Corpo de /api/support/quick (ver src/support/quick.js). CAT e tamanho no catálogo de UST, limites
// de texto da Parte 1 e as regras de horário de /api/worklog/submit.
const PROJECT_ID_RE = /^\d{1,18}$/;
const EPIC_SUMMARY_MAX = 255;
function parseQuick(body, catalogItems) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Envie o novo apontamento.');
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  let epic = null;
  if (body.epic !== undefined && body.epic !== null) {
    if (!isObj(body.epic)) throw new BadRequest('Épico inválido: informe { key }, { new } ou null.');
    if (body.epic.key !== undefined) {
      if (typeof body.epic.key !== 'string' || !KEY_RE.test(body.epic.key)) throw new BadRequest('Chave do épico inválida.');
      epic = { key: body.epic.key };
    } else if (isObj(body.epic.new)) {
      const { projectId, summary } = body.epic.new;
      if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw new BadRequest('Espaço do novo épico inválido.');
      const text = typeof summary === 'string' ? summary.trim() : '';
      if (!text) throw new BadRequest('Informe o resumo do épico.');
      if (text.length > EPIC_SUMMARY_MAX) throw new BadRequest(`Resumo do épico com até ${EPIC_SUMMARY_MAX} caracteres.`);
      epic = { new: { projectId, summary: text } };
    } else throw new BadRequest('Épico inválido: informe { key }, { new } ou null.');
  }
  const t = body.task;
  if (!isObj(t)) throw new BadRequest('Informe a tarefa (existente ou nova).');
  let task;
  if (t.key !== undefined) {
    if (typeof t.key !== 'string' || !KEY_RE.test(t.key)) throw new BadRequest('Chave da tarefa inválida.');
    if (epic) throw new BadRequest('Tarefa existente já tem pai: não informe épico.');
    task = { key: t.key };
  } else {
    try {
      task = validateTask(t, catalogItems, 'Nova tarefa');
    } catch (err) {
      if (err instanceof RangeError) throw new BadRequest(err.message);
      throw err;
    }
    if (!epic && (task.summary.includes('{EPICO}') || task.description.includes('{EPICO}'))) {
      throw new BadRequest('Tarefa sem épico: tire o {EPICO} do título e da descrição.');
    }
  }
  if (!isObj(body.worklog)) throw new BadRequest('Informe o apontamento (data, início e duração).');
  return { epic, task, worklog: parseSlot(body.worklog, 'Apontamento') };
}

// ---- Apontamento de horas: validação de entrada ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ENTRIES = 200;
const MAX_ITEMS = 100;
const MAX_DAYS = 31;
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const isInt = (n) => Number.isInteger(n);

function checkDate(s, what) {
  const ok = typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!ok) throw new BadRequest(`${what} inválida (use AAAA-MM-DD).`);
  return s;
}

function checkHhmm(s, what) {
  if (typeof s !== 'string' || !HHMM_RE.test(s)) throw new BadRequest(`${what} inválido (use HH:MM).`);
  return s;
}

function parseSchedule(s) {
  if (!s || typeof s !== 'object') throw new BadRequest('Expediente não informado.');
  const out = {
    start: checkHhmm(s.start, 'Início do expediente'),
    lunchStart: checkHhmm(s.lunchStart, 'Início do almoço'),
    lunchEnd: checkHhmm(s.lunchEnd, 'Fim do almoço'),
    end: checkHhmm(s.end, 'Fim do expediente'),
    dailyLimit: s.dailyLimit,
  };
  if (!(toMin(out.start) < toMin(out.lunchStart) && toMin(out.lunchStart) <= toMin(out.lunchEnd) && toMin(out.lunchEnd) < toMin(out.end))) {
    throw new BadRequest('Expediente incoerente: precisa ser início < almoço ≤ fim do almoço < fim.');
  }
  if (!isInt(out.dailyLimit) || out.dailyLimit < 15 || out.dailyLimit > 1440) throw new BadRequest('Limite diário inválido (minutos, de 15 a 1440).');
  return out;
}

function parsePreview(body = {}) {
  const from = checkDate(body.from, 'Data inicial');
  const to = checkDate(body.to, 'Data final');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1) throw new BadRequest('A data final deve ser igual ou posterior à inicial.');
  if (days > MAX_DAYS) throw new BadRequest(`Período de no máximo ${MAX_DAYS} dias.`);
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw new BadRequest('Informe as horas de ao menos uma tarefa.');
  for (const i of items) {
    if (typeof i?.taskKey !== 'string' || !KEY_RE.test(i.taskKey)) throw new BadRequest('Chave de tarefa inválida.');
    if (!isInt(i.minutes) || i.minutes < 15 || i.minutes % 15 || i.minutes > 200 * 60) throw new BadRequest(`Horas inválidas para ${i.taskKey} (blocos de 15 min).`);
    if (i.perDay !== undefined && typeof i.perDay !== 'boolean') throw new BadRequest(`Modo inválido para ${i.taskKey}.`);
    if (i.perDay && i.minutes > 480) throw new BadRequest(`Horas por dia de ${i.taskKey}: no máximo 8h.`);
    if (i.startDate !== undefined) {
      checkDate(i.startDate, `Dia do apontamento de ${i.taskKey}`);
      if (i.perDay) throw new BadRequest(`${i.taskKey}: dia do apontamento não combina com horas por dia útil.`);
    }
  }
  return {
    items: items.map((i) => ({ taskKey: i.taskKey, minutes: i.minutes, ...(i.perDay ? { perDay: true } : {}), ...(i.startDate ? { startDate: i.startDate } : {}) })),
    from, to, schedule: parseSchedule(body.schedule),
  };
}

// Horário de um lançamento: { date, start, minutes, comment } (regras de /api/worklog/submit).
function parseSlot(e, where) {
  const date = checkDate(e.date, `${where}: data`);
  const start = checkHhmm(e.start, `${where}: horário`);
  if (toMin(start) % 15) throw new BadRequest(`${where}: horário deve ser múltiplo de 15 min.`);
  if (!isInt(e.minutes) || e.minutes < 15 || e.minutes > 480 || e.minutes % 15) throw new BadRequest(`${where}: duração inválida (15 a 480 min, blocos de 15).`);
  if (toMin(start) + e.minutes > 1440) throw new BadRequest(`${where}: passa da meia-noite.`);
  const comment = e.comment ?? '';
  if (typeof comment !== 'string' || comment.length > 1000) throw new BadRequest(`${where}: comentário com até 1000 caracteres.`);
  return { date, start, minutes: e.minutes, comment };
}

function parseEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new BadRequest(`Envie de 1 a ${MAX_ENTRIES} lançamentos.`);
  return entries.map((e, n) => {
    const where = `Lançamento ${n + 1}`;
    if (typeof e?.taskKey !== 'string' || !KEY_RE.test(e.taskKey)) throw new BadRequest(`${where}: chave de tarefa inválida.`);
    return { taskKey: e.taskKey, ...parseSlot(e, where) };
  });
}

// Lote de manutenção de batidas (alterar, mover de tarefa, excluir).
const MAX_CHANGES = 100;
function parseChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) throw new BadRequest(`Envie de 1 a ${MAX_CHANGES} alterações.`);
  const ids = new Set();
  return changes.map((c, n) => {
    const where = `Alteração ${n + 1}`;
    if (typeof c?.id !== 'string' || !/^\d+$/.test(c.id)) throw new BadRequest(`${where}: id de batida inválido.`);
    if (ids.has(c.id)) throw new BadRequest(`${where}: batida ${c.id} repetida no lote.`);
    ids.add(c.id);
    if (typeof c.issueKey !== 'string' || !KEY_RE.test(c.issueKey)) throw new BadRequest(`${where}: chave da tarefa inválida.`);
    if (c.action === 'delete') return { id: c.id, issueKey: c.issueKey, action: 'delete' };
    if (c.action !== 'update') throw new BadRequest(`${where}: ação deve ser update ou delete.`);
    // Formato aqui; a exigência de blocos de 15 min (só para o que mudou) fica no serviço,
    // que compara com a batida original — batidas antigas de 20m ou 09:07 continuam editáveis.
    const date = checkDate(c.date, `${where}: data`);
    const start = checkHhmm(c.start, `${where}: horário`);
    if (!isInt(c.minutes) || c.minutes < 1 || c.minutes > 480) throw new BadRequest(`${where}: duração inválida (até 8h).`);
    if (toMin(start) + c.minutes > 1440) throw new BadRequest(`${where}: passa da meia-noite.`);
    const comment = c.comment ?? '';
    if (typeof comment !== 'string' || comment.length > 1000) throw new BadRequest(`${where}: comentário com até 1000 caracteres.`);
    const out = { id: c.id, issueKey: c.issueKey, action: 'update', date, start, minutes: c.minutes, comment };
    if (c.updated !== undefined) {
      if (typeof c.updated !== 'string' || c.updated.length > 40) throw new BadRequest(`${where}: marca de atualização inválida.`);
      out.updated = c.updated;
    }
    if (c.targetKey !== undefined) {
      if (typeof c.targetKey !== 'string' || !KEY_RE.test(c.targetKey)) throw new BadRequest(`${where}: tarefa de destino inválida.`);
      out.targetKey = c.targetKey;
    }
    return out;
  });
}

// Rotas do apontamento de horas.
function registerWorklogRoutes(app, { audit, catalog }) {
  const handle = makeGuard();
  app.get('/api/worklog/tasks', handle((_req, ctx) => ctx.worklogService.listTasks()));

  // Indicador de UST do período (até 400 dias), com o catálogo de UST do app.
  app.get('/api/worklog/ust', handle((req, ctx) => {
    const from = checkDate(req.query.from, 'Data inicial');
    const to = checkDate(req.query.to, 'Data final');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 400) throw new BadRequest('Período de UST: de 1 a 400 dias.');
    return ctx.worklogService.ustSummary({ from, to, catalog: catalog?.get().items ?? [] });
  }));

  // Tamanhos e UST: análise das tarefas e troca do campo Tamanho em lote (escolha do usuário).
  const MAX_SIZE_CHANGES = 50;
  const CAT_KEY_RE = /^CAT-\d{1,6}$/i;
  app.get('/api/worklog/tamanhos', handle((req, ctx) => {
    const from = checkDate(req.query.from, 'Data inicial');
    const to = checkDate(req.query.to, 'Data final');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 400) throw new BadRequest('Período: de 1 a 400 dias.');
    return ctx.worklogService.sizeAnalysis({ from, to, catalog: catalog?.get().items ?? [] });
  }));
  app.post('/api/worklog/tamanhos', handle(async (req, ctx) => {
    const list = req.body?.changes;
    if (!Array.isArray(list) || !list.length || list.length > MAX_SIZE_CHANGES) throw new BadRequest(`Informe de 1 a ${MAX_SIZE_CHANGES} trocas de tamanho.`);
    const seen = new Set();
    const changes = list.map((c) => {
      if (typeof c?.key !== 'string' || !KEY_RE.test(c.key)) throw new BadRequest('Chave de tarefa inválida.');
      const size = SIZES.includes(c.size) ? c.size : normSize(c.size);
      if (!size) throw new BadRequest(`Tamanho inválido para ${c.key} (use P, M, G ou Hora).`);
      if (seen.has(c.key)) throw new BadRequest(`${c.key} aparece mais de uma vez.`);
      seen.add(c.key);
      const out = { key: c.key, size };
      // from/fromCat (opcionais): tamanho e CAT que a pessoa viu na tela; '' = vazio. cat: novo CAT.
      if (c.from !== undefined) {
        if (c.from !== '' && !SIZES.includes(c.from)) throw new BadRequest(`Tamanho anterior inválido para ${c.key}.`);
        out.from = c.from;
      }
      if (c.cat !== undefined) {
        if (typeof c.cat !== 'string' || !CAT_KEY_RE.test(c.cat)) throw new BadRequest(`CAT inválido para ${c.key} (use CAT-123).`);
        out.cat = c.cat.toUpperCase();
      }
      if (c.fromCat !== undefined) {
        if (typeof c.fromCat !== 'string' || (c.fromCat !== '' && !CAT_KEY_RE.test(c.fromCat))) throw new BadRequest(`CAT anterior inválido para ${c.key}.`);
        out.fromCat = c.fromCat.toUpperCase();
      }
      return out;
    });
    const out = await ctx.worklogService.changeSizes({ changes, catalog: catalog?.get().items ?? [] });
    auditWeb(audit, req, 'ust.tamanho', { changes: out.results.map((r) => ({ key: r.key, fromCat: r.fromCat ?? null, cat: r.toCat ?? null, from: r.from ?? null, size: r.to, status: r.status })) });
    return out;
  }));

  // Tarefas avulsas: consulta de uma chave e favoritos (favoritos.json).
  const checkKey = (key) => {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new BadRequest('Chave de tarefa inválida (ex.: SIJUD-123).');
    return key;
  };
  app.get('/api/worklog/lookup', handle(async (req, ctx) => {
    const [task] = await ctx.worklogService.describe([checkKey(req.query.key)]);
    return { task };
  }));
  app.get('/api/worklog/favorites', handle(async (_req, ctx) => {
    const keys = await ctx.favorites.list();
    return { favorites: keys.length ? await ctx.worklogService.describe(keys) : [] };
  }));
  app.post('/api/worklog/favorites', handle(async (req, ctx) => {
    const [task] = await ctx.worklogService.describe([checkKey(req.body?.key)]);
    if (!task.available) throw new BadRequest(task.error);
    try { await ctx.favorites.add(task.key); } catch (err) { if (err instanceof RangeError) throw new BadRequest(err.message); throw err; }
    return { favorite: task };
  }));
  app.delete('/api/worklog/favorites/:key', handle(async (req, ctx) => {
    await ctx.favorites.remove(checkKey(req.params.key));
    return { ok: true };
  }));
  app.get('/api/worklog/calendar', handle(async (req, ctx) => {
    const from = checkDate(req.query.from, 'Data inicial');
    const to = checkDate(req.query.to, 'Data final');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 62) throw new BadRequest('Período do calendário: de 1 a 62 dias.');
    return { entries: await ctx.worklogService.myWorklogs(from, to) };
  }));
  app.post('/api/worklog/preview', handle((req, ctx) => ctx.worklogService.preview(parsePreview(req.body))));
  app.post('/api/worklog/ai-comments', handle((req, ctx) => {
    if (!ctx.worklogService.aiEnabled) throw new NotFound('IA não configurada (cadastre sua chave Anthropic em Minha conta).');
    return ctx.worklogService.aiComments(parseEntries(req.body?.entries));
  }));
  app.post('/api/worklog/submit', handle(async (req, ctx) => {
    const entries = parseEntries(req.body?.entries);
    const out = await ctx.worklogService.submit({ entries });
    auditWeb(audit, req, 'worklog.submit', { entries: entries.length, keys: uniqueKeys(entries, 'taskKey') });
    return out;
  }));
  app.post('/api/worklog/batch', handle(async (req, ctx) => {
    const changes = parseChanges(req.body?.changes);
    const out = await ctx.worklogService.batch({ changes });
    auditWeb(audit, req, 'worklog.batch', { changes: changes.length, keys: uniqueKeys(changes, 'issueKey') });
    return out;
  }));
}

// Apontamentos automáticos do usuário logado (autoRunner.schedulerFor). Não exigem token do
// Jira (o executor pula quem não está com token ok). Erros de validação (RangeError) viram 400.
function registerAutoRoutes(app, { autoRunner, audit }) {
  const handle = makeGuard({ jira: false });
  const sched = (req) => autoRunner.schedulerFor(req.user.id);
  const v = (fn) => handle(async (req) => {
    try { return await fn(req, sched(req)); } catch (err) { if (err instanceof RangeError) throw new BadRequest(err.message); throw err; }
  });
  app.get('/api/auto', handle((req) => sched(req).status()));
  app.post('/api/auto/rules', v(async (req, s) => {
    const rule = await s.addRule(req.body ?? {});
    auditWeb(audit, req, 'auto.rule.add', { ruleId: rule?.id ?? null, key: rule?.key ?? null });
    return { rule };
  }));
  app.put('/api/auto/rules/:id', v(async (req, s) => {
    const rule = await s.updateRule(String(req.params.id), req.body ?? {});
    auditWeb(audit, req, 'auto.rule.update', { ruleId: String(req.params.id), key: rule?.key ?? null });
    return { rule };
  }));
  app.delete('/api/auto/rules/:id', v(async (req, s) => {
    await s.removeRule(String(req.params.id));
    auditWeb(audit, req, 'auto.rule.remove', { ruleId: String(req.params.id) });
    return { ok: true };
  }));
  app.post('/api/auto/paused', v(async (req, s) => {
    if (typeof req.body?.paused !== 'boolean') throw new BadRequest('Informe paused: true ou false.');
    await s.setPaused(req.body.paused);
    auditWeb(audit, req, 'auto.paused', { paused: req.body.paused });
    return { ok: true };
  }));
  app.post('/api/auto/run', handle(async (req) => {
    const results = await sched(req).tick();
    auditWeb(audit, req, 'auto.run', { results: Array.isArray(results) ? results.length : 0 });
    return { results };
  }));
}

// Dependências obrigatórias: config, users, sessions, contexts e limiter (a autenticação é
// sempre registrada). `audit` é opcional: se ausente e houver `db`, é criado a partir dele.
// holidayProvider e autoRunner são opcionais (sem eles, /api/holidays e /api/auto* não existem).
// makeJiraClient e validateAnthropicKey (validação de credenciais em Minha conta) têm padrão
// real; os testes injetam falsos. `oauth` é opcional: se tiver revokeFor, é chamado ao desativar,
// e connectorsFor/revokeFor alimentam os conectores de Minha conta.
// `mcp` é opcional: { publicUrl, redirectHosts?, rateLimit?, serverDeps? } (exige `oauth` = createOAuthRepo) monta o
// conector MCP (rotas OAuth do SDK, /api/consentimento e /mcp); publicUrl vem de publicUrlFor().
export function createApp({
  config, db, users, sessions, contexts, holidayProvider, autoRunner, limiter, now, audit,
  makeJiraClient = createJiraClient, validateAnthropicKey = defaultValidateAnthropicKey, oauth, mcp,
}) {
  if (!users || !sessions || !contexts || !limiter) throw new Error('createApp: users, sessions, contexts e limiter são obrigatórios.');
  if (mcp && !oauth) throw new Error('createApp: mcp exige oauth.');
  audit ??= db ? createAuditRepo(db, now) : null;
  const catalog = db ? createCatalogRepo(db, now) : null;
  const templates = db ? createTemplateRepo(db, now) : null;
  const app = express();
  app.set('case sensitive routing', true);
  const stripPort = (h) => String(h ?? '').replace(/:\d+$/, '').toLowerCase();
  const publicHost = stripPort(config.publicHost);
  // Atrás do proxy reverso (Caddy no mesmo host): req.ip vem do X-Forwarded-For só quando a
  // conexão chega pelo loopback. Também evita o erro de validação do express-rate-limit do SDK.
  if (publicHost) app.set('trust proxy', 'loopback');

  // Cabeçalhos de segurança em todas as respostas.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    next();
  });

  // Proteção contra DNS rebinding: só atende localhost (e o host público configurado, se houver).
  app.use((req, res, next) => {
    const host = stripPort(req.headers.host);
    if (LOCAL_HOSTS.has(host) || (publicHost && host === publicHost)) return next();
    res.status(403).json({ error: 'Acesso permitido só via localhost.' });
  });

  // CSRF: método que altera estado com Origin de outro site é recusado.
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    // OAuth do MCP e /mcp não usam cookie (Bearer/PKCE): CSRF não se aplica, e clientes web mandam Origin.
    if (mcp && MCP_CSRF_EXEMPT.has(req.path)) return next();
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    let originHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* inválido */ }
    if (originHost && originHost === String(req.headers.host ?? '').toLowerCase()) return next();
    res.status(403).json({ error: 'Origem não permitida.' });
  });

  app.use(express.json({ limit: '1mb' }));

  const requireUser = registerAuth(app, { users, sessions, limiter, config, now, oauth });
  app.use(requireUser);
  // Contexto por usuário (serviços com as credenciais Jira dele); só para requisições logadas.
  app.use((req, _res, next) => {
    if (req.user) req.ctx = contexts.forUser(req.user);
    next();
  });

  app.get('/api/config', (req, res) => {
    res.json({ baseUrl: config.baseUrl, email: req.user.email, tokenConfigured: req.ctx?.secrets?.tokenStatus === 'ok' });
  });

  app.get('/api/catalog', (_req, res) => res.json(CATALOG));

  registerAccount(app, { users, sessions, contexts, config, audit, limiter, makeJiraClient, validateAnthropicKey, oauth });
  registerAdmin(app, { users, sessions, contexts, config, audit, oauth });
  if (catalog) registerCatalog(app, { catalog, audit });
  if (mcp) {
    const provider = createOAuthProvider({ oauth, users, now, redirectHosts: mcp.redirectHosts });
    mountMcp(app, {
      ...mcp, provider, users, audit,
      serverDeps: { contexts, holidayProvider, autoRunner, catalog, ...(now ? { now } : {}), ...mcp.serverDeps },
    });
  }

  function guard(handler) {
    return async (req, res) => {
      try {
        const { client } = jiraCtx(req);
        const resolved = resolveRequest(req.body);
        res.json(await handler(resolved, req.body ?? {}, client));
      } catch (err) {
        if (err instanceof MissingToken) return res.status(409).json({ error: err.message });
        if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
        console.error('[erro interno]', err?.message);
        res.status(500).json({ error: 'Erro interno no servidor do app.' });
      }
    };
  }

  app.post('/api/call', guard(async ({ request }, _input, client) => ({ request, ...(await client.call(request)) })));

  app.post('/api/paginate', guard(async ({ endpoint, request }, input, client) => {
    const maxPages = Math.min(Math.max(Number(input.maxPages) || 20, 1), 1000);
    const result = await paginate({
      fetchPage: (r) => client.call(r),
      strategy: endpoint.pagination,
      dataKey: endpoint.dataKey,
      request,
      maxPages,
    });
    return { request, ...result };
  }));

  registerSupportRoutes(app, { audit, catalog, templates, users, db });
  registerWorklogRoutes(app, { audit, catalog });
  if (autoRunner) registerAutoRoutes(app, { autoRunner, audit });
  if (holidayProvider) {
    app.get('/api/holidays', async (req, res) => {
      try {
        const from = checkDate(req.query.from, 'Data inicial');
        const to = checkDate(req.query.to, 'Data final');
        const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
        if (days < 1 || days > 400) throw new BadRequest('Período de feriados: de 1 a 400 dias.');
        const map = await holidayProvider.between(from, to);
        res.json({ holidays: [...map].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date)) });
      } catch (err) {
        if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
        console.error('[erro interno]', err?.message);
        res.status(500).json({ error: 'Erro interno no servidor do app.' });
      }
    });
  }

  // time.js do apontamento é puro (sem imports) e também é usado no navegador.
  app.get('/lib/time.js', (_req, res) => res.type('application/javascript').sendFile(WORKLOG_TIME));
  app.use('/lib', express.static(SHARED_DIR));
  app.use(express.static(PUBLIC_DIR));
  // JSON malformado etc.: resposta JSON (com os cabeçalhos de segurança já definidos).
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode;
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'Requisição inválida.' });
    console.error('[erro interno]', err?.message);
    res.status(500).json({ error: 'Erro interno no servidor do app.' });
  });
  // 404 próprio: o handler padrão do Express sobrescreve o Content-Security-Policy.
  app.use((req, res) => res.status(404).type('text/plain').send(`Cannot ${req.method} ${req.path}`));
  return app;
}
