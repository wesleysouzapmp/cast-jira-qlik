// Catálogo de endpoints do Jira Cloud usados para alimentar o Qlik.
// pagination: none | offset | token | worklogUpdated
// dataKey: chave do array de registros na resposta (null = a resposta é o array/objeto)

const ep = (id, area, label, method, path, opts = {}) => ({
  id,
  area,
  label,
  method,
  path,
  pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
  query: opts.query ?? {},
  body: opts.body ?? null,
  pagination: opts.pagination ?? 'none',
  dataKey: opts.dataKey ?? null,
  help: opts.help ?? '',
});

export const CATALOG = [
  // Cadastros
  ep('myself', 'Cadastros', 'Usuário autenticado (teste de conexão)', 'GET', '/rest/api/3/myself'),
  ep('projects', 'Cadastros', 'Projetos', 'GET', '/rest/api/3/project/search', {
    query: { maxResults: 50, expand: 'lead,description' }, pagination: 'offset', dataKey: 'values',
  }),
  ep('users', 'Cadastros', 'Usuários', 'GET', '/rest/api/3/users/search', {
    query: { maxResults: 100 }, pagination: 'offset',
  }),
  ep('statuses', 'Cadastros', 'Status', 'GET', '/rest/api/3/status'),
  ep('issuetypes', 'Cadastros', 'Tipos de issue', 'GET', '/rest/api/3/issuetype'),
  ep('priorities', 'Cadastros', 'Prioridades', 'GET', '/rest/api/3/priority'),
  ep('fields', 'Cadastros', 'Campos (inclui customfield_*)', 'GET', '/rest/api/3/field', {
    help: 'Use para traduzir os IDs customfield_XXXXX em nomes legíveis.',
  }),

  // Issues
  ep('search-jql', 'Issues', 'Buscar issues (JQL)', 'GET', '/rest/api/3/search/jql', {
    query: { jql: 'updated >= -30d ORDER BY updated DESC', fields: '*navigable', maxResults: 100 },
    pagination: 'token', dataKey: 'issues',
    help: 'A JQL precisa ser restrita (ex.: project = X ou updated >= -30d). fields aceita lista separada por vírgula, *navigable ou *all.',
  }),

  // Changelog
  ep('issue-changelog', 'Changelog', 'Histórico de uma issue', 'GET', '/rest/api/3/issue/{key}/changelog', {
    query: { maxResults: 100 }, pagination: 'offset', dataKey: 'values',
  }),
  ep('changelog-bulk', 'Changelog', 'Histórico em lote (até 1000 issues)', 'POST', '/rest/api/3/changelog/bulkfetch', {
    body: { issueIdsOrKeys: [], maxResults: 1000 }, pagination: 'token', dataKey: 'issueChangeLogs',
    help: 'Preencha issueIdsOrKeys com chaves obtidas na busca JQL. Opcional: fieldIds:["status"] para trazer só mudanças de status.',
  }),

  // Worklogs
  ep('issue-worklog', 'Worklogs', 'Worklogs de uma issue', 'GET', '/rest/api/3/issue/{key}/worklog', {
    query: { maxResults: 1000 }, pagination: 'offset', dataKey: 'worklogs',
  }),
  ep('worklog-updated', 'Worklogs', 'IDs de worklogs alterados desde (carga incremental)', 'GET', '/rest/api/3/worklog/updated', {
    query: { since: 0 }, pagination: 'worklogUpdated', dataKey: 'values',
    help: 'since = epoch em milissegundos. Devolve só IDs; use "Worklogs por IDs" para o detalhe.',
  }),
  ep('worklog-list', 'Worklogs', 'Worklogs por IDs (até 1000)', 'POST', '/rest/api/3/worklog/list', {
    body: { ids: [] },
  }),

  // Agile
  ep('boards', 'Agile', 'Boards', 'GET', '/rest/agile/1.0/board', {
    query: { maxResults: 50 }, pagination: 'offset', dataKey: 'values',
  }),
  ep('board-sprints', 'Agile', 'Sprints de um board', 'GET', '/rest/agile/1.0/board/{boardId}/sprint', {
    query: { maxResults: 50 }, pagination: 'offset', dataKey: 'values',
    help: 'Só funciona em boards do tipo scrum.',
  }),
  ep('sprint-issues', 'Agile', 'Issues de uma sprint', 'GET', '/rest/agile/1.0/sprint/{sprintId}/issue', {
    query: { maxResults: 50, fields: 'summary,status,assignee,issuetype,customfield_10016' },
    pagination: 'offset', dataKey: 'issues',
  }),
];

export function getEndpoint(id) {
  return CATALOG.find((e) => e.id === id);
}

export function buildPath(path, params = {}) {
  return path.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params?.[name];
    if (v === undefined || v === null || String(v).trim() === '') throw new Error(`Parâmetro obrigatório: ${name}`);
    return encodeURIComponent(String(v).trim());
  });
}

const READ_POSTS = new Set(['/rest/api/3/search/jql', '/rest/api/3/changelog/bulkfetch', '/rest/api/3/worklog/list']);

export function isAllowed({ method, path }) {
  if (typeof path !== 'string') return false;
  if (method === 'POST') return READ_POSTS.has(path);
  if (method !== 'GET') return false;
  if (!path.startsWith('/rest/')) return false;
  if (!/^[A-Za-z0-9\-._~/%]+$/.test(path)) return false; // sem ":", "@", "?", "#", "\" etc.
  if (path.includes('..') || /%2e/i.test(path)) return false;
  return true;
}
