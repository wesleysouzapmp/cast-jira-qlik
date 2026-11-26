// Serviço das "Tarefas de apoio": lista itens atribuídos, reconhece as tarefas de apoio já
// criadas no QSENSE (pelo código CAT do Item do Catálogo) e cria as tarefas escolhidas na prévia
// (vindas de um modelo ou avulsas). Toda chamada passa pelo client.call do jiraClient.
import { MODELS, QSENSE } from './models.js';
import { renderModel, buildCreateBody, supportTaskInfo, epicLabel } from './render.js';
import { optionText, sizeFieldIn, pickOption, pickCatOption } from './jiraFields.js';
import { normSize } from '../shared/ustCatalog.js';

const LIST_JQL_OPEN = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const LIST_JQL_ALL = 'assignee = currentUser() ORDER BY updated DESC';
const LIST_FIELDS = ['summary', 'issuetype', 'status', 'project'];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const BATCH = 50;
const META_PATH = `/rest/api/3/issue/createmeta/${QSENSE.projectKey}/issuetypes/${QSENSE.issueTypeId}`;
const WHERE_CREATE = 'na criação de tarefas de apoio do QSENSE';
const SIZE_MISS_TTL_MS = 10 * 60 * 1000; // "Tamanho" não achado: tenta de novo depois de 10 min

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

// Ordem das tarefas de um épico: Análise, Implementação e depois as demais por chave.
const keyNum = (k) => Number(k.split('-').pop());
const modelRank = (m) => { const i = MODELS.findIndex((x) => x.id === m); return i < 0 ? MODELS.length : i; };
export const byTaskOrder = (a, b) => modelRank(a.model) - modelRank(b.model) || keyNum(a.key) - keyNum(b.key) || a.key.localeCompare(b.key);

export function createSupportService({ client, baseUrl, now = () => Date.now() }) {
  const browse = (key) => `${baseUrl}/browse/${key}`;
  let accountId = null;
  let sizeField; // { id, name } depois de achado em /rest/api/3/field
  let sizeMissUntil = 0; // até quando vale o "não achado" (cache negativo)
  // Tarefas criadas por este processo: épico → [{ key, id, info }]. Cobre o atraso do índice de
  // busca do Jira, que pode ainda não mostrar uma issue recém-criada.
  const created = new Map();
  // Fila única: dois pedidos de criação nunca rodam ao mesmo tempo.
  let queue = Promise.resolve();

  async function call(req, what) {
    const res = await client.call(req);
    if (!res.ok) throw new JiraError(res.status, `${what}: HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    return res.data;
  }

  const isEpic = (issue) => issue.fields?.issuetype?.hierarchyLevel === 1;

  // Campo Tamanho (tamanho das tarefas existentes e gravação depois da criação): falha na leitura ou
  // campo ausente = sem tamanho, e a resposta negativa fica guardada por 10 minutos.
  async function findSizeField() {
    if (sizeField) return sizeField;
    if (now() < sizeMissUntil) return null;
    const res = await client.call({ method: 'GET', path: '/rest/api/3/field' });
    if (res.ok) sizeField = sizeFieldIn(res.data) ?? undefined;
    if (!sizeField) sizeMissUntil = now() + SIZE_MISS_TTL_MS;
    return sizeField ?? null;
  }

  // Tamanho gravado depois da criação (o campo não está na tela de criação): editmeta + PUT, com as
  // mesmas regras de opção da tela Tamanhos. Devolve null se gravou, senão o motivo.
  async function setSizeAfter(key, size) {
    const field = await findSizeField();
    if (!field) return 'campo "Tamanho" não encontrado no Jira.';
    const meta = await client.call({ method: 'GET', path: `/rest/api/3/issue/${key}/editmeta` });
    if (!meta.ok) return `HTTP ${meta.status} ${jiraMessage(meta.data)}`.trim();
    const allowed = meta.data?.fields?.[field.id]?.allowedValues;
    if (!allowed) return `o campo ${field.name} não pode ser editado nesta tarefa (permissão ou status).`;
    const { opt, error } = pickOption(allowed, size);
    if (!opt) return error;
    const res = await client.call({ method: 'PUT', path: `/rest/api/3/issue/${key}`, body: { fields: { [field.id]: { id: String(opt.id) } } } });
    return res.ok ? null : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim();
  }

  // Pede ao Jira consistência de leitura para as issues que este processo criou.
  function reconcile(epicKeys) {
    const ids = epicKeys.flatMap((k) => (created.get(k) ?? []).map((t) => Number(t.id))).filter(Number.isFinite);
    return ids.length ? { reconcileIssues: ids } : {};
  }

  // Mapa épico → [{ key, url, cat, catLabel, model, size?, status, summary }] em ordem.
  async function findExisting(epicKeys) {
    const map = new Map();
    const put = (epicKey, t) => {
      const list = map.get(epicKey) ?? [];
      if (!list.some((x) => x.key === t.key)) list.push(t);
      map.set(epicKey, list);
    };
    const size = epicKeys.length ? await findSizeField() : null;
    for (const keys of chunk(epicKeys, BATCH)) {
      let nextPageToken;
      do {
        const data = await call({
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body: { jql: `project = ${QSENSE.projectKey} AND parent in (${keys.join(', ')})`, maxResults: PAGE_SIZE, fields: ['summary', 'status', 'parent', QSENSE.catalogFieldId, ...(size ? [size.id] : [])], ...reconcile(keys), ...(nextPageToken ? { nextPageToken } : {}) },
        }, 'Busca de tarefas existentes');
        for (const t of data.issues ?? []) {
          const parent = t.fields?.parent?.key;
          const info = supportTaskInfo(t);
          if (!parent || !info) continue;
          const sz = size ? normSize(optionText(t.fields?.[size.id])) : null;
          put(parent, { key: t.key, url: browse(t.key), ...info, ...(sz ? { size: sz } : {}), status: t.fields?.status?.name ?? '', summary: t.fields?.summary ?? '' });
        }
        nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
      } while (nextPageToken);
    }
    for (const key of epicKeys) for (const t of created.get(key) ?? []) put(key, { key: t.key, url: browse(t.key), ...t.info });
    for (const list of map.values()) list.sort(byTaskOrder);
    return map;
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
      existing: existing.get(i.key) ?? [],
    }));
    return { items, truncated };
  }

  // Busca de novo os itens pedidos; não confia em nada vindo do navegador.
  async function resolve(keys, { withExisting = true } = {}) {
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
    const existing = withExisting ? await findExisting(epics.map((e) => e.key)) : new Map();
    return { epics, rejected, existing };
  }

  // items: tarefas do modelo (valem para todos os épicos); tasks: { épico: [tarefas] } substitui
  // as do modelo naquele épico. Tarefa cujo CAT o épico já tem vem desmarcada.
  async function preview(keys, { items = [], tasks = {} } = {}) {
    const { epics, rejected, existing } = await resolve(keys);
    return {
      epics: epics.map((e) => {
        const have = existing.get(e.key) ?? [];
        const list = Object.hasOwn(tasks, e.key) ? tasks[e.key] : items;
        return {
          epic: e.key,
          summary: e.fields.summary,
          label: epicLabel(e),
          existing: have,
          tasks: list.map((t) => {
            const same = have.filter((x) => x.cat === t.cat).map((x) => x.key);
            return { cat: t.cat, size: t.size, ...renderModel({ summary: t.summary, description: t.description ?? '' }, e), existing: same, checked: same.length === 0 };
          }),
        };
      }),
      rejected,
    };
  }

  async function myAccountId() {
    if (!accountId) accountId = (await call({ method: 'GET', path: '/rest/api/3/myself' }, 'Usuário do token')).accountId;
    return accountId;
  }

  // Campos da criação de "Tarefa de apoio" no QSENSE (paginado; a lista vem em fields ou values).
  async function createMeta() {
    const out = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call({ method: 'GET', path: META_PATH, query: { startAt, maxResults: PAGE_SIZE } }, 'Campos de criação da tarefa de apoio');
      const list = data?.fields ?? data?.values ?? [];
      out.push(...list);
      startAt += list.length;
      if (!list.length || data.isLast === true) break;
      if (Number.isFinite(data.total) ? startAt >= data.total : list.length < (data.maxResults ?? PAGE_SIZE)) break;
    }
    return out.map((f) => ({ ...f, id: String(f.fieldId ?? f.key ?? f.id ?? '') }));
  }

  // tasks: { épico: [{ cat, size, summary, description }] } já validadas (CAT/tamanho no catálogo).
  // Cria todas as tarefas listadas, uma por vez; erro numa não impede as outras.
  function create(keys, tasks) {
    const run = queue.then(() => createNow(keys, tasks));
    queue = run.catch(() => {});
    return run;
  }

  async function createNow(keys, tasks = {}) {
    const { epics, rejected } = await resolve(keys, { withExisting: false });
    const results = rejected.map((r) => ({ epic: r.key, cat: null, status: 'error', error: r.reason }));
    const todo = epics.flatMap((e) => (tasks[e.key] ?? []).map((t) => ({ e, t })));
    if (!todo.length) return { results };
    const meta = await createMeta();
    const catField = meta.find((f) => f.id === QSENSE.catalogFieldId);
    const size = sizeFieldIn(meta);
    const sizeAllowed = size ? meta.find((f) => f.id === size.id)?.allowedValues : null;
    const acc = await myAccountId();
    for (const { e, t } of todo) {
      const base = { epic: e.key, cat: t.cat, size: t.size, summary: renderModel(t, e).summary };
      const fail = (error) => results.push({ ...base, status: 'error', error });
      if (!catField?.allowedValues) { fail(`O Item do Catálogo não aparece ${WHERE_CREATE}; ajuste no Jira.`); continue; }
      const c = pickCatOption(catField.allowedValues, t.cat, WHERE_CREATE);
      if (!c.value) { fail(c.error); continue; }
      // Tamanho na tela de criação: vai no próprio pedido. Fora dela: grava depois (editmeta + PUT).
      const options = { [QSENSE.catalogFieldId]: c.value };
      if (sizeAllowed) {
        const s = pickOption(sizeAllowed, t.size, WHERE_CREATE);
        if (!s.opt) { fail(s.error); continue; }
        options[size.id] = { id: String(s.opt.id) };
      }
      const body = buildCreateBody(t, e, acc, options);
      const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body });
      if (res.ok && res.data?.key) {
        let warning;
        if (!sizeAllowed) {
          const why = await setSizeAfter(res.data.key, t.size).catch((err) => err.message);
          if (why) warning = `criada sem Tamanho: ${why}`;
        }
        const childText = childValue(catField.allowedValues, c.value.child.id);
        const info = supportTaskInfo({ fields: { summary: body.fields.summary, [QSENSE.catalogFieldId]: { id: c.value.id, child: { id: c.value.child.id, value: childText } } } });
        created.set(e.key, [...(created.get(e.key) ?? []), { key: res.data.key, id: res.data.id, info: { ...info, ...(warning ? {} : { size: t.size }), status: 'Aberto', summary: body.fields.summary } }]);
        results.push({ ...base, status: 'created', key: res.data.key, url: browse(res.data.key), ...(warning ? { warning } : {}) });
      } else fail(res.status === 0
        ? `${jiraMessage(res.data)} — o Jira pode ter criado a tarefa mesmo assim; confira o épico antes de repetir.`
        : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    }
    return { results };
  }

  return { listItems, preview, create };
}

function childValue(allowed, childId) {
  for (const p of allowed ?? []) for (const c of p.children ?? []) if (String(c.id) === String(childId)) return String(c.value ?? c.name ?? '');
  return '';
}
