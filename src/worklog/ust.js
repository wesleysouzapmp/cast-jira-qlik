// Indicador de UST: soma a UST das tarefas do usuário pelo "Item do Catálogo" (CAT-nnn) e pelo
// "Tamanho" (P, M, G ou Hora) da aba Apontamentos, usando o catálogo de UST mantido no app.
//  - concluídas: tarefas atribuídas ao usuário que foram para Concluído (categoria Done) no período;
//  - em andamento: tarefas ainda abertas em que o usuário apontou horas no período.
// Itens por hora (tamanho "Hora") valem UST × horas apontadas pelo usuário no período.
import { QSENSE } from '../support/models.js';
import { JiraError, jiraMessage } from '../support/service.js';
import { catOf, normSize, ustOf } from '../shared/ustCatalog.js';
import { optionText, sizeFieldIn, pickOption, pickCatOption } from '../support/jiraFields.js';

const round2 = (n) => Math.round(n * 100) / 100;
const shiftDay = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextDay = (date) => shiftDay(date, 1);

export function createUstCalculator({ client, baseUrl, myWorklogs }) {
  const browse = (key) => `${baseUrl}/browse/${key}`;
  let sizeField; // { id, name } depois de achado; undefined = ainda não achado

  async function call(req, what) {
    const res = await client.call(req);
    if (!res.ok) throw new JiraError(res.status, `${what}: HTTP ${res.status} ${jiraMessage(res.data)}`.trim());
    return res.data;
  }

  async function search(jql, fields) {
    const out = [];
    let nextPageToken;
    do {
      const data = await call({ method: 'POST', path: '/rest/api/3/search/jql', body: { jql, maxResults: 100, fields, ...(nextPageToken ? { nextPageToken } : {}) } }, 'Busca das tarefas para UST');
      out.push(...(data.issues ?? []));
      nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  async function findSizeField() {
    if (sizeField) return sizeField;
    const fields = await call({ method: 'GET', path: '/rest/api/3/field' }, 'Campos do Jira');
    // Só guarda quando achou: o campo pode ser criado ou renomeado depois.
    sizeField = sizeFieldIn(fields) ?? undefined;
    return sizeField ?? null;
  }

  // catalog: itens { cat, size, ust } do catálogo de UST.
  async function summary({ from, to, catalog }) {
    const empty = () => ({ ust: 0, tasks: [] });
    const base = { from, to, sizeField: null, concluded: empty(), inProgress: empty(), problems: [] };
    if (!catalog.length) return { ...base, error: 'O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.' };
    const field = await findSizeField();
    if (!field) return { ...base, error: 'Campo "Tamanho" não encontrado no Jira; sem ele não dá para saber a UST de cada tarefa.' };

    const catField = QSENSE.catalogFieldId;
    const catNum = catField.replace('customfield_', '');
    const fields = ['summary', 'status', catField, field.id];
    const [done, open] = await Promise.all([
      search(`assignee = currentUser() AND statusCategory = Done AND statusCategoryChangedDate >= "${from}" AND statusCategoryChangedDate < "${nextDay(to)}" AND cf[${catNum}] is not EMPTY ORDER BY key`, fields),
      // worklogDate segue o fuso do perfil do Jira (busca com um dia a mais de cada lado) e, no JQL,
      // worklogAuthor e worklogDate não precisam ser o mesmo apontamento: o filtro exato vem de myWorklogs.
      search(`worklogAuthor = currentUser() AND worklogDate >= "${shiftDay(from, -1)}" AND worklogDate <= "${shiftDay(to, 1)}" AND statusCategory != Done AND cf[${catNum}] is not EMPTY ORDER BY key`, fields),
    ]);

    // Minutos do usuário no período (fuso -03:00) por tarefa.
    let minutesBy = null;
    const loadMinutes = async () => {
      if (!minutesBy) {
        minutesBy = new Map();
        for (const w of await myWorklogs(from, to)) minutesBy.set(w.issueKey, (minutesBy.get(w.issueKey) ?? 0) + w.minutes);
      }
      return minutesBy;
    };
    const hoursOf = async (key) => round2(((await loadMinutes()).get(key) ?? 0) / 60);
    const mine = open.length ? await loadMinutes() : new Map();
    const openMine = open.filter((i) => (mine.get(i.key) ?? 0) > 0);

    const problems = [];
    async function evaluate(list) {
      const group = empty();
      for (const i of list) {
        const info = { key: i.key, summary: i.fields?.summary ?? '', status: i.fields?.status?.name ?? '', url: browse(i.key) };
        const catText = optionText(i.fields?.[catField]);
        const cat = catOf(catText);
        const sizeText = optionText(i.fields?.[field.id]);
        const size = normSize(sizeText);
        let problem = null;
        if (!cat) problem = `Item do Catálogo sem código CAT ("${catText}")`;
        else if (!sizeText) problem = `sem ${field.name}`;
        else if (!size) problem = `${field.name} não reconhecido ("${sizeText}")`;
        const unit = problem ? null : ustOf(catalog, cat, size);
        if (!problem && unit === null) problem = `${cat} ${size} não está no catálogo de UST`;
        if (problem) { problems.push({ ...info, cat, problem }); continue; }
        const hours = size === 'Hora' ? await hoursOf(i.key) : null;
        const ust = round2(size === 'Hora' ? unit * hours : unit);
        group.tasks.push({ ...info, cat, size, unitUst: unit, ...(hours !== null ? { hours } : {}), ust });
        group.ust = round2(group.ust + ust);
      }
      return group;
    }
    const concluded = await evaluate(done);
    const inProgress = await evaluate(openMine);
    return { from, to, sizeField: field.name, concluded, inProgress, problems };
  }

  // ---------- Análise de tamanhos e troca em lote ----------
  const SIZE_ORDER = { P: 1, M: 2, G: 3, Hora: 4 };
  const optionsFor = (catalog, cat) => catalog.filter((i) => i.cat === cat)
    .sort((a, b) => SIZE_ORDER[a.size] - SIZE_ORDER[b.size])
    .map((i) => ({ size: i.size, ust: i.ust, description: i.description ?? '' }));

  // Indicação (não decisão): o tamanho cuja UST fica mais perto das horas da tarefa (empate → maior).
  // under = esse tamanho tem UST maior que o atual; over = menor. Sem horas ou item por hora: sem alerta.
  function alertsFor(options, size, ust, hours) {
    if (!hours || size === 'Hora' || ust === null || !options.length) return [];
    const best = options.filter((o) => o.size !== 'Hora')
      .reduce((a, o) => (!a || Math.abs(o.ust - hours) < Math.abs(a.ust - hours) || (Math.abs(o.ust - hours) === Math.abs(a.ust - hours) && o.ust > a.ust) ? o : a), null);
    if (!best || best.ust === ust) return [];
    return [best.ust > ust ? 'under' : 'over'];
  }

  function describeTask(i, field, catalog) {
    const catField = QSENSE.catalogFieldId;
    const catText = optionText(i.fields?.[catField]);
    const cat = catOf(catText);
    const sizeText = optionText(i.fields?.[field.id]);
    const size = normSize(sizeText);
    const options = cat ? optionsFor(catalog, cat) : [];
    let problem = null;
    if (!cat) problem = `Item do Catálogo sem código CAT ("${catText}")`;
    else if (!options.length) problem = `${cat} não está no catálogo de UST`;
    else if (!sizeText) problem = `sem ${field.name}`;
    else if (!size) problem = `${field.name} não reconhecido ("${sizeText}")`;
    const ust = !problem ? options.find((o) => o.size === size)?.ust ?? null : null;
    if (!problem && ust === null) problem = `${cat} ${size} não está no catálogo de UST`;
    return { cat, size, sizeText, options, ust, problem };
  }

  // Tarefas do usuário com Item do Catálogo, em qualquer status, com movimento no período:
  // horas dele apontadas, criação ou mudança de categoria de status (abrir, andamento, concluir).
  async function sizeAnalysis({ from, to, catalog }) {
    if (!catalog.length) return { from, to, sizeField: null, tasks: [], error: 'O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.' };
    const field = await findSizeField();
    if (!field) return { from, to, sizeField: null, tasks: [], error: 'Campo "Tamanho" não encontrado no Jira.' };
    const catField = QSENSE.catalogFieldId;
    const catNum = catField.replace('customfield_', '');
    // worklogDate segue o fuso do perfil do Jira: um dia a mais de cada lado (como em myWorklogs).
    const inPeriod = `((worklogAuthor = currentUser() AND worklogDate >= "${shiftDay(from, -1)}" AND worklogDate <= "${shiftDay(to, 1)}")`
      + ` OR (created >= "${from}" AND created < "${nextDay(to)}")`
      + ` OR (statusCategoryChangedDate >= "${from}" AND statusCategoryChangedDate < "${nextDay(to)}"))`;
    const issues = await search(`assignee = currentUser() AND cf[${catNum}] is not EMPTY AND ${inPeriod} ORDER BY key`, ['summary', 'status', 'timespent', catField, field.id]);
    const tasks = issues.map((i) => {
      const d = describeTask(i, field, catalog);
      const hours = round2((i.fields?.timespent ?? 0) / 3600);
      return {
        key: i.key, summary: i.fields?.summary ?? '', status: i.fields?.status?.name ?? '', url: browse(i.key),
        cat: d.cat, size: d.size, hours, ust: d.ust, options: d.options,
        alerts: d.problem ? [] : alertsFor(d.options, d.size, d.ust, hours),
        ...(d.problem ? { problem: d.problem } : {}),
      };
    });
    const cats = [...new Set(catalog.map((i) => i.cat))]
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
      .map((cat) => ({ cat, task: catalog.find((i) => i.cat === cat)?.task ?? '', options: optionsFor(catalog, cat) }));
    return { from, to, sizeField: field.name, tasks, cats };
  }

  // Grava o Tamanho (e, se pedido, o Item do Catálogo) escolhidos em cada tarefa, uma por vez.
  // Valida CAT + tamanho no catálogo e usa as opções que o Jira oferece nessa tarefa (editmeta).
  let queue = Promise.resolve();
  let myAccountId = null;

  function changeSizes(args) {
    const run = queue.then(() => changeSizesNow(args));
    queue = run.catch(() => {});
    return run;
  }

  async function changeSizesNow({ changes, catalog }) {
    const field = await findSizeField();
    if (!field) throw new JiraError(404, 'Campo "Tamanho" não encontrado no Jira.');
    myAccountId ??= (await call({ method: 'GET', path: '/rest/api/3/myself' }, 'Usuário do token')).accountId;
    const catField = QSENSE.catalogFieldId;
    const found = new Map();
    const keys = [...new Set(changes.map((c) => c.key))];
    for (let i = 0; i < keys.length; i += 50) {
      const data = await call({ method: 'POST', path: '/rest/api/3/issue/bulkfetch', body: { issueIdsOrKeys: keys.slice(i, i + 50), fields: ['summary', 'assignee', catField, field.id] } }, 'Leitura das tarefas');
      for (const issue of data.issues ?? []) found.set(issue.key, issue);
    }
    const results = [];
    // cat (opcional): novo CAT; fromCat/from: CAT e tamanho que a pessoa viu na tela ('' = vazio).
    for (const { key, size, from, cat: newCat, fromCat } of changes) {
      const issue = found.get(key);
      if (!issue) { results.push({ key, status: 'error', to: size, ...(newCat ? { toCat: newCat } : {}), error: 'Tarefa não encontrada ou sem acesso.' }); continue; }
      const d = describeTask(issue, field, catalog);
      const toCat = newCat ?? d.cat;
      const base = { key, fromCat: d.cat, toCat, from: d.size, to: size, ustBefore: d.ust };
      if (issue.fields?.assignee?.accountId !== myAccountId) { results.push({ ...base, status: 'error', error: 'A tarefa não está atribuída a você.' }); continue; }
      // Mudou no Jira desde que a tela carregou: não grava.
      if (fromCat !== undefined && (d.cat ?? '') !== fromCat) {
        results.push({ ...base, status: 'conflict', error: `O CAT mudou para ${d.cat ?? 'vazio'} no Jira desde que a tela carregou; clique em Carregar e revise.` });
        continue;
      }
      if (from !== undefined && (d.size ?? '') !== from) {
        results.push({ ...base, status: 'conflict', error: `O tamanho mudou para ${d.size ?? 'vazio'} no Jira desde que a tela carregou; clique em Carregar e revise.` });
        continue;
      }
      if (!toCat) { results.push({ ...base, status: 'error', error: 'Tarefa sem código CAT no Item do Catálogo.' }); continue; }
      const targetOptions = optionsFor(catalog, toCat);
      if (!targetOptions.length) { results.push({ ...base, status: 'error', error: `${toCat} não está no catálogo de UST.` }); continue; }
      const target = targetOptions.find((o) => o.size === size);
      if (!target) { results.push({ ...base, status: 'error', error: `${toCat} não tem tamanho ${size} no catálogo de UST.` }); continue; }
      const catChanges = toCat !== d.cat;
      const sizeChanges = size !== d.size;
      if (!catChanges && !sizeChanges) { results.push({ ...base, status: 'unchanged', ustAfter: target.ust }); continue; }
      try {
        const meta = await call({ method: 'GET', path: `/rest/api/3/issue/${key}/editmeta` }, `Campos editáveis de ${key}`);
        const fields = {};
        if (catChanges) {
          const allowedCat = meta?.fields?.[catField]?.allowedValues;
          if (!allowedCat) { results.push({ ...base, status: 'error', error: 'O Item do Catálogo não pode ser editado nesta tarefa (permissão ou status).' }); continue; }
          const { value, error } = pickCatOption(allowedCat, toCat);
          if (!value) { results.push({ ...base, status: 'error', error }); continue; }
          fields[catField] = value;
        }
        if (sizeChanges) {
          const allowed = meta?.fields?.[field.id]?.allowedValues;
          if (!allowed) { results.push({ ...base, status: 'error', error: `O campo ${field.name} não pode ser editado nesta tarefa (permissão ou status).` }); continue; }
          const { opt, error } = pickOption(allowed, size);
          if (!opt) { results.push({ ...base, status: 'error', error }); continue; }
          fields[field.id] = { id: String(opt.id) };
        }
        const res = await client.call({ method: 'PUT', path: `/rest/api/3/issue/${key}`, body: { fields } });
        if (!res.ok) { results.push({ ...base, status: 'error', error: `HTTP ${res.status} ${jiraMessage(res.data)}`.trim() }); continue; }
        results.push({ ...base, status: 'updated', ustAfter: target.ust });
      } catch (err) {
        results.push({ ...base, status: 'error', error: err.message });
      }
    }
    return { results };
  }

  return { summary, sizeAnalysis, changeSizes };
}
