// Serviço das "Tarefas de apoio": lista itens atribuídos, reconhece as tarefas de apoio já
// criadas no QSENSE (pelo código CAT do Item do Catálogo) e cria as tarefas escolhidas na prévia
// (vindas de um modelo ou avulsas). Toda chamada passa pelo client.call do jiraClient.
//
// Parte 3: por épico há uma tarefa agrupadora (Tarefa do QSENSE com Item do Catálogo CAT-87, pai =
// épico) e o trabalho fica nas subtarefas dela (tipo subtarefa do QSENSE, pai = agrupadora).
import { MODELS, QSENSE } from './models.js';
import { renderModel, buildCreateBody, buildIssueBody, supportTaskInfo, epicLabel } from './render.js';
import { optionText, sizeFieldIn, pickOption, pickCatOption } from './jiraFields.js';
import { normSize, catOf } from '../shared/ustCatalog.js';
import { GROUP_CAT, DEFAULT_PHASE } from '../shared/groupPlan.js';

const LIST_JQL_OPEN = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const LIST_JQL_ALL = 'assignee = currentUser() ORDER BY updated DESC';
const LIST_FIELDS = ['summary', 'issuetype', 'status', 'project'];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const BATCH = 50;
const TYPES_PATH = `/rest/api/3/issue/createmeta/${QSENSE.projectKey}/issuetypes`;
const WHERE_CREATE = 'na criação de tarefas de apoio do QSENSE';
const WHERE_SUBTASK = 'na criação de subtarefas do QSENSE';
const WHERE_GROUP = 'na criação da tarefa agrupadora do QSENSE';
const SUBTASK_NAME = /^(subtarefa|sub-task|subtask)$/i;
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

// Agrupadora: Item do Catálogo com CAT-87 no filho.
export const isGroupInfo = (info) => info?.cat === GROUP_CAT;

// Fase das subtarefas sem banco (testes e uso avulso): em memória.
export function memorySubtaskStore() {
  const map = new Map();
  return {
    set({ key, phase }) { map.set(key, phase); },
    phases(keys) { return new Map(keys.filter((k) => map.has(k)).map((k) => [k, map.get(k)])); },
  };
}

export function createSupportService({ client, baseUrl, now = () => Date.now(), subtaskStore = memorySubtaskStore() }) {
  const browse = (key) => `${baseUrl}/browse/${key}`;
  let accountId = null;
  let sizeField; // { id, name } depois de achado em /rest/api/3/field
  let sizeMissUntil = 0; // até quando vale o "não achado" (cache negativo)
  // Tarefas criadas por este processo: épico → [{ key, id, info }]. Cobre o atraso do índice de
  // busca do Jira, que pode ainda não mostrar uma issue recém-criada.
  const created = new Map();
  // Subtarefas criadas por este processo: agrupadora → [{ key, id, info }].
  const createdSubs = new Map();
  let subtaskTypeCache = null; // { id, name } do tipo subtarefa do QSENSE
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
          body: { jql: `project = ${QSENSE.projectKey} AND parent in (${keys.join(', ')})`, maxResults: PAGE_SIZE, fields: ['summary', 'status', 'parent', 'timespent', 'assignee', QSENSE.catalogFieldId, ...(size ? [size.id] : [])], ...reconcile(keys), ...(nextPageToken ? { nextPageToken } : {}) },
        }, 'Busca de tarefas existentes');
        for (const t of data.issues ?? []) {
          const parent = t.fields?.parent?.key;
          const info = supportTaskInfo(t);
          if (!parent || !info) continue;
          const sz = size ? normSize(optionText(t.fields?.[size.id])) : null;
          put(parent, { key: t.key, url: browse(t.key), ...info, ...(isGroupInfo(info) ? { group: true } : {}), ...(sz ? { size: sz } : {}), status: t.fields?.status?.name ?? '', summary: t.fields?.summary ?? '', assignee: t.fields?.assignee?.accountId ?? null, timeSpentMin: Math.round((t.fields?.timespent ?? 0) / 60) });
        }
        nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
      } while (nextPageToken);
    }
    for (const key of epicKeys) for (const t of created.get(key) ?? []) put(key, { key: t.key, url: browse(t.key), assignee: accountId, timeSpentMin: 0, ...t.info });
    for (const list of map.values()) list.sort(byTaskOrder);
    // Subtarefas das agrupadoras (uma busca para todas).
    const groups = [...map.values()].flat().filter((t) => t.group);
    if (groups.length) {
      const subs = await subtasksOf(groups.map((g) => g.key), size);
      for (const g of groups) g.subtasks = subs.get(g.key) ?? [];
    }
    return map;
  }

  // Subtarefas das agrupadoras: Map agrupadora → [{ key, url, cat, catLabel, model, size?, status,
  // summary, assignee, timeSpentMin }] por chave. JQL `parent in (...)`, em lotes.
  async function subtasksOf(groupKeys, sizeField) {
    const map = new Map(groupKeys.map((k) => [k, []]));
    const size = sizeField === undefined ? await findSizeField() : sizeField;
    for (const keys of chunk(groupKeys, BATCH)) {
      const ids = keys.flatMap((k) => (createdSubs.get(k) ?? []).map((t) => Number(t.id))).filter(Number.isFinite);
      let nextPageToken;
      do {
        const data = await call({
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body: { jql: `parent in (${keys.join(', ')})`, maxResults: PAGE_SIZE, fields: ['summary', 'status', 'parent', 'timespent', 'assignee', QSENSE.catalogFieldId, ...(size ? [size.id] : [])], ...(ids.length ? { reconcileIssues: ids } : {}), ...(nextPageToken ? { nextPageToken } : {}) },
        }, 'Busca das subtarefas');
        for (const t of data.issues ?? []) {
          const list = map.get(t.fields?.parent?.key);
          if (!list || list.some((x) => x.key === t.key)) continue;
          const info = supportTaskInfo(t) ?? { model: null, cat: null, catLabel: '' };
          const sz = size ? normSize(optionText(t.fields?.[size.id])) : null;
          list.push({ key: t.key, url: browse(t.key), ...info, ...(sz ? { size: sz } : {}), status: t.fields?.status?.name ?? '', summary: t.fields?.summary ?? '', assignee: t.fields?.assignee?.accountId ?? null, timeSpentMin: Math.round((t.fields?.timespent ?? 0) / 60) });
        }
        nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
      } while (nextPageToken);
    }
    for (const [g, list] of map) {
      for (const t of createdSubs.get(g) ?? []) if (!list.some((x) => x.key === t.key)) list.push({ key: t.key, url: browse(t.key), ...t.info, assignee: accountId, timeSpentMin: 0 });
      list.sort((a, b) => keyNum(a.key) - keyNum(b.key));
    }
    const phases = subtaskStore.phases([...map.values()].flat().map((t) => t.key));
    for (const list of map.values()) for (const t of list) t.phase = phases.get(t.key) ?? DEFAULT_PHASE;
    return map;
  }

  // Agrupadoras sob cada épico: Map épico → [{ key, url, summary, status, subtasks }].
  async function groupsOf(epicKeys) {
    const existing = await findExisting(epicKeys);
    return new Map(epicKeys.map((k) => [k, (existing.get(k) ?? []).filter((t) => t.group)]));
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

  // Campos da criação de um tipo do QSENSE (paginado; a lista vem em fields ou values).
  // Padrão: "Tarefa de apoio" (QSENSE.issueTypeId).
  async function createMeta(typeId = QSENSE.issueTypeId, what = 'Campos de criação da tarefa de apoio') {
    const out = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call({ method: 'GET', path: `${TYPES_PATH}/${typeId}`, query: { startAt, maxResults: PAGE_SIZE } }, what);
      const list = data?.fields ?? data?.values ?? [];
      out.push(...list);
      startAt += list.length;
      if (!list.length || data.isLast === true) break;
      if (Number.isFinite(data.total) ? startAt >= data.total : list.length < (data.maxResults ?? PAGE_SIZE)) break;
    }
    return out.map((f) => ({ ...f, id: String(f.fieldId ?? f.key ?? f.id ?? '') }));
  }

  // Tipo subtarefa do QSENSE: subtask = true na lista de tipos do createmeta (paginada, em
  // issueTypes ou values). Mais de um: o de nome Subtarefa/Sub-task; senão, erro claro. Fica em cache.
  async function subtaskType() {
    if (subtaskTypeCache) return subtaskTypeCache;
    const types = [];
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call({ method: 'GET', path: TYPES_PATH, query: { startAt, maxResults: PAGE_SIZE } }, 'Tipos de item do QSENSE');
      const list = data?.issueTypes ?? data?.values ?? [];
      types.push(...list);
      startAt += list.length;
      if (!list.length || data.isLast === true) break;
      if (Number.isFinite(data.total) ? startAt >= data.total : list.length < (data.maxResults ?? PAGE_SIZE)) break;
    }
    const subs = types.filter((t) => t?.subtask === true);
    const named = subs.filter((t) => SUBTASK_NAME.test(String(t.name ?? '').trim()));
    const pick = subs.length === 1 ? subs[0] : named.length === 1 ? named[0] : null;
    if (!pick) {
      throw new JiraError(422, subs.length
        ? `O QSENSE tem mais de um tipo de subtarefa (${subs.map((t) => t.name).join(', ')}) e nenhum se chama "Subtarefa"; ajuste no Jira.`
        : 'O QSENSE não tem tipo de subtarefa disponível para você criar; ajuste no Jira.');
    }
    subtaskTypeCache = { id: String(pick.id), name: String(pick.name ?? '') };
    return subtaskTypeCache;
  }

  // O que vale para criar agrupadora e subtarefas: opção CAT-87 (só se needGroup), tipo subtarefa e
  // os campos do createmeta dele (Item do Catálogo e Tamanho). Só leituras; erro = JiraError.
  async function prepareGroup({ needGroup = true } = {}) {
    let groupCat = null;
    if (needGroup) {
      const meta = await createMeta(QSENSE.issueTypeId, 'Campos de criação da tarefa agrupadora');
      const field = meta.find((f) => f.id === QSENSE.catalogFieldId);
      if (!field?.allowedValues) throw new JiraError(422, `O Item do Catálogo não aparece ${WHERE_GROUP}; ajuste no Jira.`);
      const c = pickCatOption(field.allowedValues, GROUP_CAT, WHERE_GROUP);
      if (!c.value) throw new JiraError(422, c.error);
      groupCat = { value: c.value, label: childValue(field.allowedValues, c.value.child.id) };
    }
    const type = await subtaskType();
    const meta = await createMeta(type.id, 'Campos de criação da subtarefa');
    const catField = meta.find((f) => f.id === QSENSE.catalogFieldId);
    if (!catField?.allowedValues) throw new JiraError(422, `O Item do Catálogo não aparece ${WHERE_SUBTASK}; ajuste no Jira.`);
    const size = sizeFieldIn(meta);
    return { groupCat, type, catField, size, sizeAllowed: size ? meta.find((f) => f.id === size.id)?.allowedValues : null, acc: await myAccountId() };
  }

  // CAT e tamanho de uma subtarefa no createmeta do tipo subtarefa: { options } ou { error }.
  function subtaskOptions(prep, t) {
    const c = pickCatOption(prep.catField.allowedValues, t.cat, WHERE_SUBTASK);
    if (!c.value) return { error: c.error };
    const options = { [QSENSE.catalogFieldId]: c.value };
    if (prep.sizeAllowed) {
      const s = pickOption(prep.sizeAllowed, t.size, WHERE_SUBTASK);
      if (!s.opt) return { error: s.error };
      options[prep.size.id] = { id: String(s.opt.id) };
    }
    return { options, childId: c.value.child.id };
  }

  const failText = (res, what) => (res.status === 0
    ? `${jiraMessage(res.data)} — o Jira pode ter criado ${what} mesmo assim; confira no Jira antes de repetir.`
    : `HTTP ${res.status} ${jiraMessage(res.data)}`.trim());

  // Agrupadora no épico e ({ key, fields: { summary } }): Tarefa, CAT-87, sem Tamanho.
  // t: { summary, description } ({EPICO} vira o épico). Chame dentro de exclusive().
  async function createGroup(prep, e, t) {
    const { summary, description } = renderModel({ summary: t.summary, description: t.description ?? '' }, e);
    const body = buildIssueBody({ typeId: QSENSE.issueTypeId, parentKey: e.key, summary, description, accountId: prep.acc, options: { [QSENSE.catalogFieldId]: prep.groupCat.value } });
    const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body });
    if (!res.ok || !res.data?.key) return { status: 'error', error: failText(res, 'a agrupadora') };
    const info = { model: null, cat: GROUP_CAT, catLabel: prep.groupCat.label, group: true, status: 'Aberto', summary };
    created.set(e.key, [...(created.get(e.key) ?? []), { key: res.data.key, id: res.data.id, info }]);
    return { status: 'created', key: res.data.key, url: browse(res.data.key), summary };
  }

  // Subtarefa na agrupadora groupKey do épico e. t: { cat, size, summary, description } já validada;
  // phase: fase guardada no app. Chame dentro de exclusive().
  async function createSubtask(prep, { groupKey, epic: e, task: t, phase = DEFAULT_PHASE }) {
    const o = subtaskOptions(prep, t);
    if (o.error) return { status: 'error', error: o.error };
    const { summary, description } = e ? renderModel({ summary: t.summary, description: t.description ?? '' }, e) : t;
    const body = buildIssueBody({ typeId: prep.type.id, parentKey: groupKey, summary, description, accountId: prep.acc, options: o.options });
    const res = await client.call({ method: 'POST', path: '/rest/api/3/issue', body });
    if (!res.ok || !res.data?.key) return { status: 'error', error: failText(res, 'a subtarefa') };
    let warning;
    if (!prep.sizeAllowed) {
      const why = await setSizeAfter(res.data.key, t.size).catch((err) => err.message);
      if (why) warning = `criada sem Tamanho: ${why}`;
    }
    try { subtaskStore.set({ key: res.data.key, phase, epicKey: e?.key ?? '' }); } catch (err) { console.error('[fase da subtarefa]', err?.message); }
    const label = childValue(prep.catField.allowedValues, o.childId);
    const info = { model: null, cat: catOf(label) ?? t.cat, catLabel: label, subtask: true, groupKey, phase, ...(warning ? {} : { size: t.size }), status: 'Aberto', summary };
    createdSubs.set(groupKey, [...(createdSubs.get(groupKey) ?? []), { key: res.data.key, id: res.data.id, info }]);
    return { status: 'created', key: res.data.key, url: browse(res.data.key), ...(warning ? { warning } : {}) };
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
        // Agrupadora (CAT-87) sem épico nunca é tarefa solta: não recebe horas.
        if (!info || isGroupInfo(info) || out.has(t.key)) continue;
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

  return {
    listItems, preview, create, exclusive, prepareCreate, createTask, createEpic, listSpaces, listLoose, recentTasks,
    subtaskType, prepareGroup, subtaskOptions, groupsOf, subtasksOf, createGroup, createSubtask,
  };
}

function childValue(allowed, childId) {
  for (const p of allowed ?? []) for (const c of p.children ?? []) if (String(c.id) === String(childId)) return String(c.value ?? c.name ?? '');
  return '';
}
