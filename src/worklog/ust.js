// Indicador de UST: soma a UST das tarefas do usuário pelo "Item do Catálogo" (CAT-nnn) e pelo
// "Tamanho" (P, M, G ou Hora) da aba Apontamentos, usando o catálogo de UST mantido no app.
//  - concluídas: tarefas atribuídas ao usuário que foram para Concluído (categoria Done) no período;
//  - em andamento: tarefas ainda abertas em que o usuário apontou horas no período.
// Itens por hora (tamanho "Hora") valem UST × horas apontadas pelo usuário no período.
import { QSENSE } from '../support/models.js';
import { JiraError, jiraMessage } from '../support/service.js';
import { catOf, normSize, ustOf } from '../shared/ustCatalog.js';

const SIZE_FIELD_NAME = 'tamanho';
const norm = (s) => String(s ?? '').trim().toLowerCase();
const round2 = (n) => Math.round(n * 100) / 100;
const shiftDay = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextDay = (date) => shiftDay(date, 1);

// Texto de um campo de opção do Jira: opção ({ value }), cascata ({ value, child }), lista ou texto.
function optionText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(optionText).filter(Boolean).join(', ');
  return v.child?.value ? `${v.value ?? ''} › ${v.child.value}` : String(v.value ?? v.name ?? '');
}

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
    const matches = (fields ?? []).filter((f) => norm(f.name) === SIZE_FIELD_NAME);
    const f = matches.find((x) => x.custom) ?? matches[0];
    // Só guarda quando achou: o campo pode ser criado ou renomeado depois.
    if (f) sizeField = { id: f.id, name: f.name };
    return f ? sizeField : null;
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

  return { summary };
}
