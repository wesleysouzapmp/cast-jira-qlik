import express from 'express';
import { fileURLToPath } from 'node:url';
import { CATALOG, getEndpoint, buildPath, isAllowed } from './catalog.js';
import { paginate } from './paginators.js';
import { JiraError } from './support/service.js';
import { ConflictError, ScopeError } from './worklog/service.js';
import { AiError } from './worklog/ai.js';
import { registerAuth } from './web/auth.js';

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

class NotFound extends Error {}

// Handler das rotas que gravam no Jira (tarefas de apoio e apontamento): Origin, token e erros.
function makeGuard(config) {
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
      if (!config.tokenConfigured) throw new BadRequest('Token não configurado no .env (JIRA_EMAIL e JIRA_API_TOKEN).');
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      if (err instanceof NotFound) return res.status(404).json({ error: err.message });
      if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
      if (err instanceof ScopeError) return res.status(400).json({ error: err.message });
      if (err instanceof JiraError || err instanceof AiError) return res.status(502).json({ error: err.message });
      console.error('[erro interno]', err?.message);
      res.status(500).json({ error: 'Erro interno no servidor do app.' });
    }
  };
}

// Rotas das "Tarefas de apoio".
function registerSupportRoutes(app, { service, config }) {
  const handle = makeGuard(config);
  app.get('/api/support/items', handle((req) => {
    const opts = { onlyEpics: req.query.onlyEpics === '1' };
    if (req.query.includeDone === '1') opts.includeDone = true;
    return service.listItems(opts);
  }));
  app.post('/api/support/preview', handle((req) => service.preview(parseKeys(req.body?.keys))));
  app.post('/api/support/create', handle((req) => service.create(parseKeys(req.body?.keys))));
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
  }
  return { items: items.map((i) => ({ taskKey: i.taskKey, minutes: i.minutes, ...(i.perDay ? { perDay: true } : {}) })), from, to, schedule: parseSchedule(body.schedule) };
}

function parseEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new BadRequest(`Envie de 1 a ${MAX_ENTRIES} lançamentos.`);
  return entries.map((e, n) => {
    const where = `Lançamento ${n + 1}`;
    if (typeof e?.taskKey !== 'string' || !KEY_RE.test(e.taskKey)) throw new BadRequest(`${where}: chave de tarefa inválida.`);
    const date = checkDate(e.date, `${where}: data`);
    const start = checkHhmm(e.start, `${where}: horário`);
    if (toMin(start) % 15) throw new BadRequest(`${where}: horário deve ser múltiplo de 15 min.`);
    if (!isInt(e.minutes) || e.minutes < 15 || e.minutes > 480 || e.minutes % 15) throw new BadRequest(`${where}: duração inválida (15 a 480 min, blocos de 15).`);
    if (toMin(start) + e.minutes > 1440) throw new BadRequest(`${where}: passa da meia-noite.`);
    const comment = e.comment ?? '';
    if (typeof comment !== 'string' || comment.length > 1000) throw new BadRequest(`${where}: comentário com até 1000 caracteres.`);
    return { taskKey: e.taskKey, date, start, minutes: e.minutes, comment };
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
function registerWorklogRoutes(app, { service, config, favorites }) {
  const handle = makeGuard(config);
  app.get('/api/worklog/tasks', handle(() => service.listTasks()));

  // Tarefas avulsas: consulta de uma chave e favoritos (favoritos.json).
  const checkKey = (key) => {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new BadRequest('Chave de tarefa inválida (ex.: SIJUD-123).');
    return key;
  };
  app.get('/api/worklog/lookup', handle(async (req) => {
    const [task] = await service.describe([checkKey(req.query.key)]);
    return { task };
  }));
  if (favorites) {
    app.get('/api/worklog/favorites', handle(async () => {
      const keys = await favorites.list();
      return { favorites: keys.length ? await service.describe(keys) : [] };
    }));
    app.post('/api/worklog/favorites', handle(async (req) => {
      const [task] = await service.describe([checkKey(req.body?.key)]);
      if (!task.available) throw new BadRequest(task.error);
      try { await favorites.add(task.key); } catch (err) { if (err instanceof RangeError) throw new BadRequest(err.message); throw err; }
      return { favorite: task };
    }));
    app.delete('/api/worklog/favorites/:key', handle(async (req) => {
      await favorites.remove(checkKey(req.params.key));
      return { ok: true };
    }));
  }
  app.get('/api/worklog/calendar', handle(async (req) => {
    const from = checkDate(req.query.from, 'Data inicial');
    const to = checkDate(req.query.to, 'Data final');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 62) throw new BadRequest('Período do calendário: de 1 a 62 dias.');
    return { entries: await service.myWorklogs(from, to) };
  }));
  app.post('/api/worklog/preview', handle((req) => service.preview(parsePreview(req.body))));
  app.post('/api/worklog/ai-comments', handle((req) => {
    if (!service.aiEnabled) throw new NotFound('IA não configurada (defina ANTHROPIC_API_KEY no .env).');
    return service.aiComments(parseEntries(req.body?.entries));
  }));
  app.post('/api/worklog/submit', handle((req) => service.submit({ entries: parseEntries(req.body?.entries) })));
  app.post('/api/worklog/batch', handle((req) => service.batch({ changes: parseChanges(req.body?.changes) })));
}

// Apontamentos automáticos (agendamentos.json). Erros de validação (RangeError) viram 400.
function registerAutoRoutes(app, { scheduler, config }) {
  const handle = makeGuard(config);
  const v = (fn) => handle(async (req) => {
    try { return await fn(req); } catch (err) { if (err instanceof RangeError) throw new BadRequest(err.message); throw err; }
  });
  app.get('/api/auto', handle(() => scheduler.status()));
  app.post('/api/auto/rules', v(async (req) => ({ rule: await scheduler.addRule(req.body ?? {}) })));
  app.put('/api/auto/rules/:id', v(async (req) => ({ rule: await scheduler.updateRule(String(req.params.id), req.body ?? {}) })));
  app.delete('/api/auto/rules/:id', v(async (req) => { await scheduler.removeRule(String(req.params.id)); return { ok: true }; }));
  app.post('/api/auto/paused', v(async (req) => {
    if (typeof req.body?.paused !== 'boolean') throw new BadRequest('Informe paused: true ou false.');
    await scheduler.setPaused(req.body.paused);
    return { ok: true };
  }));
  app.post('/api/auto/run', handle(async () => ({ results: await scheduler.tick() })));
}

export function createApp({ client, config, supportService, worklogService, holidayProvider, favoritesStore, autoScheduler, users, sessions, limiter }) {
  const app = express();
  const stripPort = (h) => String(h ?? '').replace(/:\d+$/, '').toLowerCase();
  const publicHost = stripPort(config.publicHost);

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
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    let originHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* inválido */ }
    if (originHost && originHost === String(req.headers.host ?? '').toLowerCase()) return next();
    res.status(403).json({ error: 'Origem não permitida.' });
  });

  app.use(express.json({ limit: '1mb' }));

  if (users && sessions) {
    const requireUser = registerAuth(app, { users, sessions, limiter, config });
    app.use(requireUser);
  }

  app.get('/api/config', (_req, res) => {
    res.json({ baseUrl: config.baseUrl, email: config.email, tokenConfigured: Boolean(config.tokenConfigured) });
  });

  app.get('/api/catalog', (_req, res) => res.json(CATALOG));

  function guard(handler) {
    return async (req, res) => {
      try {
        if (!config.tokenConfigured) throw new BadRequest('Token não configurado no .env (JIRA_EMAIL e JIRA_API_TOKEN).');
        const resolved = resolveRequest(req.body);
        res.json(await handler(resolved, req.body ?? {}));
      } catch (err) {
        if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
        console.error('[erro interno]', err?.message);
        res.status(500).json({ error: 'Erro interno no servidor do app.' });
      }
    };
  }

  app.post('/api/call', guard(async ({ request }) => ({ request, ...(await client.call(request)) })));

  app.post('/api/paginate', guard(async ({ endpoint, request }, input) => {
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

  if (supportService) registerSupportRoutes(app, { service: supportService, config });
  if (worklogService) registerWorklogRoutes(app, { service: worklogService, config, favorites: favoritesStore });
  if (autoScheduler) registerAutoRoutes(app, { scheduler: autoScheduler, config });
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
  // 404 próprio: o handler padrão do Express sobrescreve o Content-Security-Policy.
  app.use((req, res) => res.status(404).type('text/plain').send(`Cannot ${req.method} ${req.path}`));
  return app;
}
