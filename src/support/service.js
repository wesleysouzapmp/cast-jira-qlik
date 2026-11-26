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
// Tarefas de apoio sem épico atribuídas ao usuário (criadas soltas pelo calendário).
const LOOSE_JQL = `project = ${QSENSE.projectKey} AND issuetype = ${QSENSE.issueTypeId} AND parent is EMPTY AND assignee = currentUser() AND statusCategory != Done ORDER BY created DESC`;
const LOOSE = ''; // chave do mapa `created` para as tarefas soltas
const SPACES_PAGE = 50;

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
  // Épicos criados por este processo (pelo calendário): chave → { id, summary, project }. Entram em
  // listItems mesmo que a busca ainda não os mostre (para repetir a criação da tarefa neles).
  const createdEpics = new Map();
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

  function epicReconcile() {
    const ids = [...createdEpics.values()].map((e) => Number(e.id)).filter(Number.isFinite);
    return ids.length ? { reconcileIssues: ids } : {};
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
        body: { jql: includeDone ? LIST_JQL_ALL : LIST_JQL_OPEN, maxResults: PAGE_SIZE, fields: LIST_FIELDS, ...epicReconcile(), ...(nextPageToken ? { nextPageToken } : {}) },
      }, 'Busca de itens atribuídos');
      issues.push(...(data.issues ?? []));
      if (!data.nextPageToken || data.isLast === true) break;
      nextPageToken = data.nextPageToken;
    }
    for (const [key, e] of createdEpics) {
      if (!issues.some((i) => i.key === key)) issues.push({ key, fields: { summary: e.summary, issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: 'Aberto' }, project: { key: e.project } } });
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

  // Fila única: fn roda sozinha (criação pela tela de apoio e criação + apontamento pelo calendário).
  function exclusive(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  // tasks: { épico: [{ cat, size, summary, description }] } já validadas (CAT/tamanho no catálogo).
  // Cria todas as tarefas listadas, uma por vez; erro numa não impede as outras.
  function create(keys, tasks) {
    return exclusive(() => createNow(keys, tasks));
  }

  // O que vale para todas as criações de um pedido: campos do createmeta e o usuário do token.
  async function prepareCreate() {
    const meta = await createMeta();
    const size = sizeFieldIn(meta);
    return {
      catField: meta.find((f) => f.id === QSENSE.catalogFieldId),
      size,
      sizeAllowed: size ? meta.find((f) => f.id === size.id)?.allowedValues : null,
      acc: await myAccountId(),
    };
  }

  // Cria uma tarefa de apoio no épico e ({ key, fields: { summary } }) ou solta (e = null, sem parent).
  // Devolve { status: 'created', key, url, warning? } ou { status: 'error', error }.
  async function createOne({ catField, size, sizeAllowed, acc }, t, e) {
    const fail = (error) => ({ status: 'error', error });
    if (!catField?.allowedValues) return fail(`O Item do Catálogo não aparece ${WHERE_CREATE}; ajuste no Jira.`);
    const c = pickCatOption(catField.allowedValues, t.cat, WHERE_CREATE);
    if (!c.value) return fail(c.error);
    // Tamanho na tela de criação: vai no próprio pedido. Fora dela: grava depois (editmeta + PUT).
    const options = { [QSENSE.catalogFieldId]: c.value };
    if (sizeAllowed) {
      const s = pickOption(sizeAllowed, t.size, WHERE_CREATE);
      if (!s.opt) return fail(s.error);
      options[size.id] = { id: String(s.opt.id) };
    }
    const body = buildCreateBody(t, e, acc, options);
    const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body });
    if (!res.ok || !res.data?.key) {
      return fail(res.status === 0
        ? `${jiraMessage(res.data)} — o Jira pode ter criado a tarefa mesmo assim; confira ${e ? 'o épico' : 'suas tarefas'} antes de repetir.`
        : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    }
    let warning;
    if (!sizeAllowed) {
      const why = await setSizeAfter(res.data.key, t.size).catch((err) => err.message);
      if (why) warning = `criada sem Tamanho: ${why}`;
    }
    const childText = childValue(catField.allowedValues, c.value.child.id);
    const info = supportTaskInfo({ fields: { summary: body.fields.summary, [QSENSE.catalogFieldId]: { id: c.value.id, child: { id: c.value.child.id, value: childText } } } });
    const slot = e ? e.key : LOOSE;
    created.set(slot, [...(created.get(slot) ?? []), { key: res.data.key, id: res.data.id, info: { ...info, ...(warning ? {} : { size: t.size }), status: 'Aberto', summary: body.fields.summary } }]);
    return { status: 'created', key: res.data.key, url: browse(res.data.key), ...(warning ? { warning } : {}) };
  }

  async function createNow(keys, tasks = {}) {
    const { epics, rejected } = await resolve(keys, { withExisting: false });
    const results = rejected.map((r) => ({ epic: r.key, cat: null, status: 'error', error: r.reason }));
    const todo = epics.flatMap((e) => (tasks[e.key] ?? []).map((t) => ({ e, t })));
    if (!todo.length) return { results };
    const prep = await prepareCreate();
    for (const { e, t } of todo) {
      const base = { epic: e.key, cat: t.cat, size: t.size, summary: renderModel(t, e).summary };
      results.push({ ...base, ...(await createOne(prep, t, e)) });
    }
    return { results };
  }

  // Uma tarefa de apoio já validada, no épico epic ({ key, fields: { summary } }) ou solta (null).
  // Chame dentro de exclusive().
  // prep: resultado de prepareCreate() já lido (o fluxo do calendário lê antes de criar o épico).
  async function createTask(t, epic, prep) {
    return createOne(prep ?? await prepareCreate(), t, epic);
  }

  // Espaços (projetos) onde o usuário pode criar issues e que têm tipo épico (hierarchyLevel 1):
  // [{ id, key, name, epicTypeId }].
  async function listSpaces() {
    const out = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call({ method: 'GET', path: '/rest/api/3/project/search', query: { action: 'create', expand: 'issueTypes', startAt, maxResults: SPACES_PAGE } }, 'Busca dos espaços');
      const list = data?.values ?? [];
      for (const p of list) {
        const type = (p.issueTypes ?? []).find((x) => x?.hierarchyLevel === 1 && x.subtask !== true);
        if (type) out.push({ id: String(p.id), key: String(p.key ?? ''), name: String(p.name ?? p.key ?? ''), epicTypeId: String(type.id) });
      }
      startAt += list.length;
      if (!list.length || data.isLast === true) break;
      if (Number.isFinite(data.total) && startAt >= data.total) break;
    }
    return out;
  }

  // Épico novo no espaço (um de listSpaces), responsável = usuário do token. Chame dentro de exclusive().
  // Devolve { key, url, status: 'created' } ou { status: 'error', error } com a mensagem do Jira.
  async function createEpic({ space, summary }) {
    const acc = await myAccountId();
    const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body: { fields: { project: { id: space.id }, issuetype: { id: space.epicTypeId }, summary, assignee: { accountId: acc } } } });
    if (res.ok && res.data?.key) {
      createdEpics.set(res.data.key, { id: res.data.id, summary, project: space.key });
      return { key: res.data.key, url: browse(res.data.key), status: 'created' };
    }
    return { status: 'error', error: res.status === 0
      ? `${jiraMessage(res.data)} — o Jira pode ter criado o épico mesmo assim; confira no espaço ${space.key} antes de repetir.`
      : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim() };
  }

  // Tarefas de apoio soltas (sem épico) atribuídas ao usuário e em aberto, inclusive as criadas por
  // este processo que a busca ainda não mostra: [{ key, url, model, cat, catLabel, summary, status, timeSpentMin }].
  async function listLoose() {
    const out = new Map();
    let nextPageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call({
        method: 'POST',
        path: '/rest/api/3/search/jql',
        body: { jql: LOOSE_JQL, maxResults: PAGE_SIZE, fields: ['summary', 'status', 'timespent', QSENSE.catalogFieldId], ...reconcile([LOOSE]), ...(nextPageToken ? { nextPageToken } : {}) },
      }, 'Busca das tarefas de apoio sem épico');
      for (const t of data.issues ?? []) {
        const info = supportTaskInfo(t);
        if (!info || out.has(t.key)) continue;
        out.set(t.key, { key: t.key, url: browse(t.key), ...info, summary: t.fields?.summary ?? '', status: t.fields?.status?.name ?? '', timeSpentMin: Math.round((t.fields?.timespent ?? 0) / 60) });
      }
      nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
      if (!nextPageToken) break;
    }
    for (const t of created.get(LOOSE) ?? []) {
      if (!out.has(t.key)) out.set(t.key, { key: t.key, url: browse(t.key), model: t.info.model, cat: t.info.cat, catLabel: t.info.catLabel, summary: t.info.summary, status: t.info.status, timeSpentMin: 0 });
    }
    return [...out.values()];
  }

  // Tarefas criadas por este processo no épico: [{ key, info }] (cobre o atraso do índice de busca).
  const recentTasks = (epicKey) => (created.get(epicKey) ?? []).map((t) => ({ key: t.key, info: t.info }));

  return { listItems, preview, create, exclusive, prepareCreate, createTask, createEpic, listSpaces, listLoose, recentTasks };
}

function childValue(allowed, childId) {
  for (const p of allowed ?? []) for (const c of p.children ?? []) if (String(c.id) === String(childId)) return String(c.value ?? c.name ?? '');
  return '';
}
