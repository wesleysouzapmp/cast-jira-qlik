// Serviço das "Tarefas de apoio": lista itens atribuídos, detecta tarefas já criadas
// no QSENSE e cria as que faltam. Toda chamada passa pelo client.call do jiraClient.
import { MODELS, QSENSE } from './models.js';
import { renderModel, buildCreateBody, modelOfTask } from './render.js';

const LIST_JQL_OPEN = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const LIST_JQL_ALL = 'assignee = currentUser() ORDER BY updated DESC';
const LIST_FIELDS = ['summary', 'issuetype', 'status', 'project'];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const BATCH = 50;

export class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jiraMessage(data) {
  if (!data || typeof data !== 'object') return String(data ?? '').slice(0, 300);
  const parts = [...(data.errorMessages ?? []), ...Object.entries(data.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
  return parts.join('; ') || data.error || '';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function createSupportService({ client, baseUrl }) {
  const browse = (key) => `${baseUrl}/browse/${key}`;
  let accountId = null;
  // Tarefas criadas por este processo: épico → { modelo: { key, id } }. Cobre o atraso do
  // índice de busca do Jira, que pode ainda não mostrar uma issue recém-criada.
  const created = new Map();
  // Fila única: dois pedidos de criação nunca rodam ao mesmo tempo.
  let queue = Promise.resolve();

  async function call(req, what) {
    const res = await client.call(req);
    if (!res.ok) throw new JiraError(res.status, `${what}: HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    return res.data;
  }

  const isEpic = (issue) => issue.fields?.issuetype?.hierarchyLevel === 1;

  // Pede ao Jira consistência de leitura para as issues que este processo criou.
  function reconcile(epicKeys) {
    const ids = epicKeys.flatMap((k) => Object.values(created.get(k) ?? {}).map((t) => Number(t.id))).filter(Number.isFinite);
    return ids.length ? { reconcileIssues: ids } : {};
  }

  // Mapa chave do épico → { modelId: chave da tarefa existente }.
  // Mapa épico → { modelo: chave da tarefa }; map.info: chave da tarefa → { status, summary }.
  async function findExisting(epicKeys) {
    const map = new Map();
    const info = new Map();
    for (const keys of chunk(epicKeys, BATCH)) {
      let nextPageToken;
      do {
        const data = await call({
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body: { jql: `project = ${QSENSE.projectKey} AND parent in (${keys.join(', ')})`, maxResults: PAGE_SIZE, fields: ['summary', 'status', 'parent', QSENSE.catalogFieldId], ...reconcile(keys), ...(nextPageToken ? { nextPageToken } : {}) },
        }, 'Busca de tarefas existentes');
        for (const t of data.issues ?? []) {
          const parent = t.fields?.parent?.key;
          const model = modelOfTask(t);
          if (!parent || !model) continue;
          const entry = map.get(parent) ?? {};
          entry[model.id] ??= t.key;
          map.set(parent, entry);
          info.set(t.key, { status: t.fields?.status?.name ?? '', summary: t.fields?.summary ?? '' });
        }
        nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
      } while (nextPageToken);
    }
    for (const key of epicKeys) {
      for (const [modelId, t] of Object.entries(created.get(key) ?? {})) {
        const entry = map.get(key) ?? {};
        entry[modelId] ??= t.key;
        map.set(key, entry);
        if (!info.has(t.key)) info.set(t.key, { status: 'Aberto', summary: '' });
      }
    }
    return Object.assign(map, { info });
  }

  async function listItems({ onlyEpics = false, includeDone = false } = {}) {
    const issues = [];
    let nextPageToken;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) { truncated = true; break; }
      const data = await call({
        method: 'POST',
        path: '/rest/api/3/search/jql',
        body: { jql: includeDone ? LIST_JQL_ALL : LIST_JQL_OPEN, maxResults: PAGE_SIZE, fields: LIST_FIELDS, ...(nextPageToken ? { nextPageToken } : {}) },
      }, 'Busca de itens atribuídos');
      issues.push(...(data.issues ?? []));
      if (!data.nextPageToken || data.isLast === true) break;
      nextPageToken = data.nextPageToken;
    }
    const filtered = onlyEpics ? issues.filter(isEpic) : issues;
    const existing = await findExisting(filtered.filter(isEpic).map((i) => i.key));
    const items = filtered.map((i) => ({
      key: i.key,
      summary: i.fields?.summary ?? '',
      type: i.fields?.issuetype?.name ?? '',
      isEpic: isEpic(i),
      status: i.fields?.status?.name ?? '',
      project: i.fields?.project?.key ?? '',
      url: browse(i.key),
      existing: MODELS.filter((m) => existing.get(i.key)?.[m.id]).map((m) => {
        const key = existing.get(i.key)[m.id];
        return { model: m.id, key, url: browse(key), ...existing.info.get(key) };
      }),
    }));
    return { items, truncated };
  }

  // Busca de novo os itens pedidos; não confia em nada vindo do navegador.
  async function resolve(keys) {
    const found = new Map();
    for (const part of chunk(keys, BATCH)) {
      const data = await call({ method: 'POST', path: '/rest/api/3/issue/bulkfetch', body: { issueIdsOrKeys: part, fields: LIST_FIELDS } }, 'Busca dos épicos');
      for (const i of data.issues ?? []) found.set(i.key, i);
    }
    const epics = [];
    const rejected = [];
    for (const key of keys) {
      const issue = found.get(key);
      if (!issue) rejected.push({ key, reason: 'Item não encontrado ou sem permissão.' });
      else if (!isEpic(issue)) rejected.push({ key, reason: 'Só épicos recebem tarefas de apoio.' });
      else epics.push(issue);
    }
    const existing = await findExisting(epics.map((e) => e.key));
    return { epics, rejected, existing };
  }

  async function preview(keys) {
    const { epics, rejected, existing } = await resolve(keys);
    return {
      epics: epics.map((e) => {
        const have = existing.get(e.key) ?? {};
        return {
          epic: e.key,
          summary: e.fields.summary,
          toCreate: MODELS.filter((m) => !have[m.id]).map((m) => ({ model: m.id, ...renderModel(m, e), catalog: m.catalog.label })),
          skipped: MODELS.filter((m) => have[m.id]).map((m) => ({ model: m.id, key: have[m.id] })),
        };
      }),
      rejected,
    };
  }

  async function myAccountId() {
    if (!accountId) accountId = (await call({ method: 'GET', path: '/rest/api/3/myself' }, 'Usuário do token')).accountId;
    return accountId;
  }

  function create(keys) {
    const run = queue.then(() => createNow(keys));
    queue = run.catch(() => {});
    return run;
  }

  async function createNow(keys) {
    const { epics, rejected, existing } = await resolve(keys);
    const results = rejected.map((r) => ({ epic: r.key, model: null, status: 'error', error: r.reason }));
    if (!epics.length) return { results };
    const acc = await myAccountId();
    for (const e of epics) {
      const have = existing.get(e.key) ?? {};
      for (const m of MODELS) {
        if (have[m.id]) { results.push({ epic: e.key, model: m.id, status: 'skipped', key: have[m.id], url: browse(have[m.id]) }); continue; }
        const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body: buildCreateBody(m, e, acc) });
        if (res.ok && res.data?.key) {
          created.set(e.key, { ...created.get(e.key), [m.id]: { key: res.data.key, id: res.data.id } });
          results.push({ epic: e.key, model: m.id, status: 'created', key: res.data.key, url: browse(res.data.key) });
        } else results.push({ epic: e.key, model: m.id, status: 'error', error: res.status === 0
          ? `${jiraMessage(res.data)} — o Jira pode ter criado a tarefa mesmo assim; confira o épico antes de repetir.`
          : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim() });
      }
    }
    return { results };
  }

  return { listItems, preview, create };
}
