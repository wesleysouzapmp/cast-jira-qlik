import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportService, JiraError } from '../src/support/service.js';

const BASE = 'https://x.atlassian.net';
const epic = (key, summary = 'Épico ' + key) => ({ key, fields: { summary, issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: 'Em Execução' }, project: { key: key.split('-')[0] } } });
const story = (key) => ({ key, fields: { summary: 'História', issuetype: { name: 'História', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: 'BI' } } });

// Item do Catálogo (cascata) e Tamanho como o createmeta do Jira devolve.
const CAT_FIELD = {
  fieldId: 'customfield_10104', name: 'Item do Catálogo',
  allowedValues: [
    { id: '11927', value: 'Business Intelligence', children: [
      { id: '11930', value: 'CAT-105 - Realizar diagnóstico' },
      { id: '12117', value: 'CAT-166 - Manter script de carga do Qlik Sense' },
      { id: '12200', value: 'CAT-200 - Revisar painel' },
      { id: '12201', value: 'CAT-201 - Opção antiga', disabled: true },
    ] },
    { id: '20000', value: 'Outra área', children: [{ id: '20001', value: 'CAT-300 - Repetido A' }, { id: '20002', value: 'CAT-300 - Repetido B' }] },
  ],
};
const SIZE_FIELD = { fieldId: 'customfield_10300', name: 'Tamanho', allowedValues: [{ id: '701', value: 'P' }, { id: '702', value: 'M' }, { id: '703', value: 'G - Grande' }, { id: '704', value: 'Hora' }, { id: '705', value: 'Hora (antigo)', disabled: true }] };
const META = [{ fieldId: 'summary', name: 'Resumo' }, CAT_FIELD, SIZE_FIELD];

// Jira simulado: responde por path/JQL e registra as chamadas.
function fakeClient({ items = [], existing = [], alwaysNextPage = false, createResponses = [], meta = META, metaPageSize = 100, metaKey = 'fields', fields = null, editmeta = null, putResponse = null } = {}) {
  const calls = [];
  let created = 0;
  let nextId = 10;
  const client = {
    async call(req) {
      calls.push(req);
      if (req.path === '/rest/api/3/myself') return { status: 200, ok: true, data: { accountId: 'acc-1' } };
      if (req.path === '/rest/api/3/field') return fields ? { status: 200, ok: true, data: fields } : { status: 404, ok: false, data: {} };
      if (req.path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes/10002') {
        const startAt = Number(req.query?.startAt ?? 0);
        const page = meta.slice(startAt, startAt + metaPageSize);
        return { status: 200, ok: true, data: { startAt, maxResults: metaPageSize, total: meta.length, [metaKey]: page } };
      }
      if (req.path === '/rest/api/3/search/jql') {
        const jql = req.body.jql;
        if (jql.startsWith('project = QSENSE')) return { status: 200, ok: true, data: { issues: existing, isLast: true } };
        return { status: 200, ok: true, data: alwaysNextPage ? { issues: items, nextPageToken: 't' } : { issues: items, isLast: true } };
      }
      if (req.path === '/rest/api/3/issue/bulkfetch') {
        const keys = req.body.issueIdsOrKeys;
        return { status: 200, ok: true, data: {
          issues: items.filter((i) => keys.includes(i.key)),
          issueErrors: keys.filter((k) => !items.some((i) => i.key === k)).map((k) => ({ issueIdOrKey: k, errorMessages: ['não existe'] })),
        } };
      }
      if (/^\/rest\/api\/3\/issue\/QSENSE-\d+\/editmeta$/.test(req.path)) return editmeta ? { status: 200, ok: true, data: editmeta } : { status: 404, ok: false, data: { errorMessages: ['sem editmeta'] } };
      if (/^\/rest\/api\/3\/issue\/QSENSE-\d+$/.test(req.path) && req.method === 'PUT') return putResponse ?? { status: 204, ok: true, data: '' };
      if (req.path === '/rest/api/3/issue' && req.method === 'POST') {
        const r = createResponses[created++];
        if (r) return r;
        { const n = nextId++; return { status: 201, ok: true, data: { id: String(1000 + n), key: `QSENSE-${n}` } }; }
      }
      return { status: 404, ok: false, data: {} };
    },
  };
  return { client, calls };
}

const creates = (calls) => calls.filter((c) => c.path === '/rest/api/3/issue');
const existingAnalise = { key: 'QSENSE-9', fields: { summary: 'Analise da demanda BI-1 - X', parent: { key: 'BI-1' } } };
const catTask = (key, cat, text, parent = 'BI-1', extra = {}) => ({ key, fields: { summary: `${cat} ${key}`, status: { name: 'Aberto' }, parent: { key: parent }, customfield_10104: { id: '11927', value: 'Business Intelligence', child: { id: '1', value: `${cat} - ${text}` } }, ...extra } });
const task = (cat, size, summary = `T ${cat} {EPICO}`, description = 'D {EPICO}') => ({ cat, size, summary, description });
const ANALISE_T = task('CAT-105', 'M', 'Analise da demanda {EPICO}', 'Analise da demanda {EPICO}. Levantamento.');
const IMPL_T = task('CAT-166', 'P', 'Implementação da demanda {EPICO}', 'Implementação {EPICO}');

test('listItems marca épicos e tarefas existentes (antigas pelo título)', async () => {
  const { client } = fakeClient({ items: [epic('BI-1'), story('BI-5')], existing: [existingAnalise] });
  const svc = createSupportService({ client, baseUrl: BASE });
  const r = await svc.listItems({ onlyEpics: false });
  assert.equal(r.truncated, false);
  assert.equal(r.items.length, 2);
  const [e, s] = r.items;
  assert.equal(e.isEpic, true);
  assert.equal(e.url, BASE + '/browse/BI-1');
  assert.deepEqual(e.existing, [{ key: 'QSENSE-9', url: BASE + '/browse/QSENSE-9', cat: 'CAT-105', catLabel: 'CAT-105 - Realizar diagnóstico de incidente, problema, erro ou demanda na solução de BI', model: 'analise', status: '', summary: 'Analise da demanda BI-1 - X' }]);
  assert.equal(s.isEpic, false);
  assert.deepEqual(s.existing, []);
  assert.equal(e.type, 'Épico');
  assert.equal(e.status, 'Em Execução');
});

test('listItems reconhece qualquer tarefa com CAT, com tamanho quando o campo existe', async () => {
  const fields = [{ id: 'customfield_10300', name: 'Tamanho', custom: true }];
  const existing = [
    catTask('QSENSE-30', 'CAT-200', 'Revisar painel', 'BI-1', { customfield_10300: { value: 'G' } }),
    catTask('QSENSE-31', 'CAT-105', 'Realizar diagnóstico'),
    { key: 'QSENSE-32', fields: { summary: 'Sem CAT nem título conhecido', parent: { key: 'BI-1' } } },
  ];
  const { client, calls } = fakeClient({ items: [epic('BI-1')], existing, fields });
  const r = await createSupportService({ client, baseUrl: BASE }).listItems({ onlyEpics: true });
  assert.deepEqual(r.items[0].existing.map((t) => [t.key, t.cat, t.size, t.model]), [['QSENSE-31', 'CAT-105', undefined, 'analise'], ['QSENSE-30', 'CAT-200', 'G', null]]);
  assert.equal(r.items[0].existing[1].catLabel, 'CAT-200 - Revisar painel');
  const search = calls.find((c) => c.body?.jql?.startsWith('project = QSENSE'));
  assert.ok(search.body.fields.includes('customfield_10300'));
});

test('listItems: Análise e Implementação primeiro, depois as demais por chave', async () => {
  const t = (key, model) => ({ key, fields: { summary: key, parent: { key: 'BI-1' }, customfield_10104: { id: '11927', child: { id: model === 'analise' ? '11930' : '12117' } } } });
  const { client } = fakeClient({ items: [epic('BI-1')], existing: [catTask('QSENSE-5', 'CAT-200', 'X'), t('QSENSE-12', 'analise'), t('QSENSE-11', 'implementacao'), t('QSENSE-9', 'analise')] });
  const r = await createSupportService({ client, baseUrl: BASE }).listItems({ onlyEpics: true });
  assert.deepEqual(r.items[0].existing.map((e) => [e.model, e.key]), [['analise', 'QSENSE-9'], ['analise', 'QSENSE-12'], ['implementacao', 'QSENSE-11'], [null, 'QSENSE-5']]);
});

test('listItems onlyEpics filtra', async () => {
  const { client } = fakeClient({ items: [epic('BI-1'), story('BI-5')] });
  const r = await createSupportService({ client, baseUrl: BASE }).listItems({ onlyEpics: true });
  assert.deepEqual(r.items.map((i) => i.key), ['BI-1']);
});

test('listItems pagina e marca truncated após 10 páginas', async () => {
  const { client, calls } = fakeClient({ items: [story('BI-5')], alwaysNextPage: true });
  const r = await createSupportService({ client, baseUrl: BASE }).listItems({ onlyEpics: false });
  assert.equal(r.truncated, true);
  const searches = calls.filter((c) => c.path === '/rest/api/3/search/jql' && c.body.jql.startsWith('assignee'));
  assert.equal(searches.length, 10);
  assert.equal(searches[1].body.nextPageToken, 't');
});

test('listItems lança JiraError se a busca falhar', async () => {
  const client = { async call() { return { status: 401, ok: false, data: { errorMessages: ['Não autorizado'] } }; } };
  await assert.rejects(createSupportService({ client, baseUrl: BASE }).listItems({}), (e) => e instanceof JiraError && /Não autorizado/.test(e.message));
});

test('preview com as tarefas do modelo: renderiza o épico e desmarca CAT que já existe', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1', 'X'), story('BI-5')], existing: [existingAnalise, catTask('QSENSE-40', 'CAT-105', 'Realizar diagnóstico')] });
  const r = await createSupportService({ client, baseUrl: BASE }).preview(['BI-1', 'BI-5', 'BI-404'], { items: [ANALISE_T, IMPL_T] });
  assert.equal(r.epics.length, 1);
  const [e] = r.epics;
  assert.equal(e.label, 'BI-1 - X');
  assert.deepEqual(e.existing.map((t) => t.key), ['QSENSE-9', 'QSENSE-40']);
  const [a, i] = e.tasks;
  assert.deepEqual([a.cat, a.size, a.checked, a.existing], ['CAT-105', 'M', false, ['QSENSE-9', 'QSENSE-40']]);
  assert.deepEqual([i.cat, i.size, i.checked, i.existing], ['CAT-166', 'P', true, []]);
  assert.equal(i.summary, 'Implementação da demanda BI-1 - X');
  assert.equal(i.description, 'Implementação BI-1 - X');
  assert.deepEqual(r.rejected.map((x) => x.key), ['BI-5', 'BI-404']);
  assert.equal(creates(calls).length, 0);
});

test('preview com tarefas por épico (substituem as do modelo naquele épico)', async () => {
  const { client } = fakeClient({ items: [epic('BI-1', 'X'), epic('BI-2', 'Y')] });
  const r = await createSupportService({ client, baseUrl: BASE }).preview(['BI-1', 'BI-2'], { items: [ANALISE_T], tasks: { 'BI-2': [task('CAT-200', 'G', 'Revisão {EPICO}', '')] } });
  assert.deepEqual(r.epics.map((e) => e.tasks.map((t) => t.summary)), [['Analise da demanda BI-1 - X'], ['Revisão BI-2 - Y']]);
});

test('create: resolve as opções no createmeta e monta o pedido', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1', 'X')] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [ANALISE_T, task('CAT-200', 'G', 'Revisão {EPICO}', '')] });
  assert.deepEqual(r.results.map((x) => [x.epic, x.cat, x.size, x.status, x.key]), [['BI-1', 'CAT-105', 'M', 'created', 'QSENSE-10'], ['BI-1', 'CAT-200', 'G', 'created', 'QSENSE-11']]);
  assert.equal(r.results[0].url, BASE + '/browse/QSENSE-10');
  assert.equal(r.results[0].summary, 'Analise da demanda BI-1 - X');
  const [b1, b2] = creates(calls).map((c) => c.body.fields);
  assert.deepEqual(b1.customfield_10104, { id: '11927', child: { id: '11930' } });
  assert.deepEqual(b1.customfield_10300, { id: '702' });
  assert.equal(b1.summary, 'Analise da demanda BI-1 - X');
  assert.deepEqual(b1.assignee, { accountId: 'acc-1' });
  assert.deepEqual(b1.parent, { key: 'BI-1' });
  assert.deepEqual(b2.customfield_10104, { id: '11927', child: { id: '12200' } });
  assert.deepEqual(b2.customfield_10300, { id: '703' });
  assert.equal('description' in b2, false);
  // createmeta lido uma vez por criação.
  assert.equal(calls.filter((c) => c.path.includes('/createmeta/')).length, 1);
});

test('createmeta paginado e com a lista em "values"', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')], metaPageSize: 1, metaKey: 'values' });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [IMPL_T] });
  assert.deepEqual(r.results.map((x) => x.status), ['created']);
  const metaCalls = calls.filter((c) => c.path.includes('/createmeta/'));
  assert.deepEqual(metaCalls.map((c) => c.query.startAt), [0, 1, 2]);
});

test('create: opção de CAT inexistente, desativada ou ambígua vira erro só daquela tarefa', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [task('CAT-999', 'P'), task('CAT-201', 'P'), task('CAT-300', 'P'), IMPL_T] });
  assert.deepEqual(r.results.map((x) => x.status), ['error', 'error', 'error', 'created']);
  assert.match(r.results[0].error, /não oferece o CAT-999/);
  assert.match(r.results[1].error, /não oferece o CAT-201/);
  assert.match(r.results[2].error, /mais de uma opção para CAT-300/);
  assert.equal(creates(calls).length, 1);
});

test('create: tamanho ambíguo ou ausente no Jira vira erro claro', async () => {
  const sizes = { ...SIZE_FIELD, allowedValues: [{ id: '1', value: 'P - Pequeno' }, { id: '2', value: 'Pequeno' }, { id: '3', value: 'M' }] };
  const { client, calls } = fakeClient({ items: [epic('BI-1')], meta: [CAT_FIELD, sizes] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [task('CAT-105', 'P'), task('CAT-105', 'G'), task('CAT-105', 'M')] });
  assert.deepEqual(r.results.map((x) => x.status), ['error', 'error', 'created']);
  assert.match(r.results[0].error, /mais de uma opção para P/);
  assert.match(r.results[1].error, /não oferece o valor G no campo Tamanho/);
  assert.deepEqual(creates(calls)[0].body.fields.customfield_10300, { id: '3' });
});

test('create: sem Item do Catálogo no createmeta, erro por tarefa e nada é criado', async () => {
  const other = fakeClient({ items: [epic('BI-1')], meta: [SIZE_FIELD] });
  const r2 = await createSupportService({ client: other.client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [IMPL_T] });
  assert.match(r2.results[0].error, /Item do Catálogo/);
  const none = fakeClient({ items: [epic('BI-1')], meta: [] });
  const r3 = await createSupportService({ client: none.client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [IMPL_T, ANALISE_T] });
  assert.deepEqual(r3.results.map((x) => x.status), ['error', 'error']);
  assert.equal(creates(other.calls).length + creates(none.calls).length, 0);
});

test('create com lista vazia não consulta o createmeta nem cria nada', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [] });
  assert.deepEqual(r.results, []);
  assert.equal(creates(calls).length, 0);
  assert.equal(calls.filter((c) => c.path.includes('/createmeta/')).length, 0);
});

test('create cria mesmo quando o CAT já existe no épico (a escolha é da pessoa)', async () => {
  const { client } = fakeClient({ items: [epic('BI-1')], existing: [existingAnalise] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [ANALISE_T] });
  assert.deepEqual(r.results.map((x) => x.status), ['created']);
});

test('create recusa item que não é épico', async () => {
  const { client, calls } = fakeClient({ items: [story('BI-5')] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-5'], { 'BI-5': [IMPL_T] });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'error');
  assert.equal(r.results[0].epic, 'BI-5');
  assert.equal(creates(calls).length, 0);
});

test('create continua após erro do Jira', async () => {
  const { client, calls } = fakeClient({
    items: [epic('BI-1'), epic('BI-2')],
    createResponses: [{ status: 400, ok: false, data: { errorMessages: [], errors: { customfield_10104: 'Opção inválida' } } }],
  });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1', 'BI-2'], { 'BI-1': [ANALISE_T, IMPL_T], 'BI-2': [ANALISE_T, IMPL_T] });
  assert.equal(creates(calls).length, 4);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].error, /Opção inválida/);
  assert.deepEqual(r.results.slice(1).map((x) => x.status), ['created', 'created', 'created']);
});

test('accountId fica em cache', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1'), epic('BI-2')] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1'], { 'BI-1': [IMPL_T] });
  await svc.create(['BI-2'], { 'BI-2': [IMPL_T] });
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/myself').length, 1);
});

test('create concorrente roda em fila (um pedido por vez)', async () => {
  const { client } = fakeClient({ items: [epic('BI-1')] });
  let running = 0;
  let max = 0;
  const slow = { async call(req) { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 5)); running--; return client.call(req); } };
  const svc = createSupportService({ client: slow, baseUrl: BASE });
  const [a, b] = await Promise.all([svc.create(['BI-1'], { 'BI-1': [IMPL_T] }), svc.create(['BI-1'], { 'BI-1': [IMPL_T] })]);
  assert.equal(max, 1);
  assert.deepEqual([...a.results, ...b.results].map((r) => r.key).sort(), ['QSENSE-10', 'QSENSE-11']);
});

test('tarefa recém-criada aparece como existente mesmo com o índice de busca atrasado', async () => {
  // A busca de existentes sempre volta vazia (índice do Jira atrasado).
  const { client } = fakeClient({ items: [epic('BI-1')], existing: [] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1'], { 'BI-1': [ANALISE_T, task('CAT-200', 'G', 'Revisão {EPICO}')] });
  const list = await svc.listItems({ onlyEpics: true });
  assert.deepEqual(list.items[0].existing.map((e) => [e.key, e.cat, e.size, e.model]), [['QSENSE-10', 'CAT-105', 'M', 'analise'], ['QSENSE-11', 'CAT-200', 'G', null]]);
  const p = await svc.preview(['BI-1'], { items: [ANALISE_T] });
  assert.deepEqual(p.epics[0].tasks[0].existing, ['QSENSE-10']);
  assert.equal(p.epics[0].tasks[0].checked, false);
});

test('busca de existentes pede reconcileIssues com os ids criados', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1'], { 'BI-1': [ANALISE_T, IMPL_T] });
  await svc.listItems({});
  const lastExisting = calls.filter((c) => c.path === '/rest/api/3/search/jql' && c.body.jql.startsWith('project = QSENSE')).at(-1);
  assert.deepEqual(lastExisting.body.reconcileIssues, [1010, 1011]);
});

test('reconhece tarefa existente pelo Item do Catálogo mesmo com resumo diferente', async () => {
  // Caso real: QSENSE-4057/4058 criadas à mão como "Analise demanda BI-2861" (sem "da").
  const manual = [
    { key: 'QSENSE-4057', fields: { summary: 'Analise demanda BI-1', parent: { key: 'BI-1' }, customfield_10104: { id: '11927', child: { id: '11930' } } } },
    { key: 'QSENSE-4058', fields: { summary: 'Implementação demanda BI-1', parent: { key: 'BI-1' }, customfield_10104: { id: '11927', child: { id: '12117' } } } },
  ];
  const { client, calls } = fakeClient({ items: [epic('BI-1')], existing: manual });
  const svc = createSupportService({ client, baseUrl: BASE });
  const list = await svc.listItems({ onlyEpics: true });
  assert.deepEqual(list.items[0].existing.map((e) => [e.model, e.cat, e.key]), [['analise', 'CAT-105', 'QSENSE-4057'], ['implementacao', 'CAT-166', 'QSENSE-4058']]);
  const search = calls.find((c) => c.body?.jql?.startsWith('project = QSENSE'));
  assert.ok(search.body.fields.includes('customfield_10104'));
});

test('listItems por padrão exclui concluídos; includeDone mostra tudo', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.listItems({});
  await svc.listItems({ includeDone: true });
  const jqls = calls.filter((c) => c.path === '/rest/api/3/search/jql' && c.body.jql.startsWith('assignee')).map((c) => c.body.jql);
  assert.match(jqls[0], /statusCategory != Done/);
  assert.doesNotMatch(jqls[1], /statusCategory/);
  assert.match(jqls[1], /^assignee = currentUser\(\) ORDER BY updated DESC$/);
});

test('tarefas existentes vêm com status e resumo', async () => {
  const t = { key: 'QSENSE-9', fields: { summary: 'Analise da demanda BI-1 - X', status: { name: 'Concluído' }, parent: { key: 'BI-1' } } };
  const { client, calls } = fakeClient({ items: [epic('BI-1')], existing: [t] });
  const r = await createSupportService({ client, baseUrl: BASE }).listItems({ includeDone: true });
  assert.equal(r.items[0].existing[0].status, 'Concluído');
  assert.equal(r.items[0].existing[0].summary, 'Analise da demanda BI-1 - X');
  assert.ok(calls.find((c) => c.body?.jql?.startsWith('project = QSENSE')).body.fields.includes('status'));
});

// ---------- Revisão: Tamanho fora do createmeta, cache negativo do campo ----------
const FIELDS_LIST = [{ id: 'customfield_10300', name: 'Tamanho', custom: true }];
const EDITMETA = { fields: { customfield_10300: { allowedValues: SIZE_FIELD.allowedValues } } };

test('create: Tamanho fora do createmeta → cria sem ele e grava pelo editmeta + PUT', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')], meta: [CAT_FIELD], fields: FIELDS_LIST, editmeta: EDITMETA });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [ANALISE_T] });
  assert.deepEqual(r.results.map((x) => [x.status, x.key, x.warning]), [['created', 'QSENSE-10', undefined]]);
  const body = creates(calls)[0].body.fields;
  assert.equal('customfield_10300' in body, false);
  assert.deepEqual(body.customfield_10104, { id: '11927', child: { id: '11930' } });
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/rest/api/3/issue/QSENSE-10');
  assert.deepEqual(put.body, { fields: { customfield_10300: { id: '702' } } });
});

test('create: Tamanho não gravado depois → tarefa criada com aviso', async () => {
  const cases = [
    [{ fields: FIELDS_LIST, editmeta: { fields: {} } }, /criada sem Tamanho: .*não pode ser editado/],
    [{ fields: FIELDS_LIST, editmeta: { fields: { customfield_10300: { allowedValues: [{ id: '1', value: 'P' }] } } } }, /criada sem Tamanho: O Jira não oferece o valor M/],
    [{ fields: FIELDS_LIST, editmeta: EDITMETA, putResponse: { status: 400, ok: false, data: { errorMessages: ['Recusado'] } } }, /criada sem Tamanho: .*Recusado/],
    [{ fields: null }, /criada sem Tamanho: .*não encontrado/],
  ];
  for (const [opts, re] of cases) {
    const { client } = fakeClient({ items: [epic('BI-1')], meta: [CAT_FIELD], ...opts });
    const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1'], { 'BI-1': [ANALISE_T] });
    assert.equal(r.results[0].status, 'created');
    assert.equal(r.results[0].key, 'QSENSE-10');
    assert.match(r.results[0].warning, re);
  }
});

test('campo Tamanho não encontrado fica em cache por 10 minutos', async () => {
  let t = 0;
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const svc = createSupportService({ client, baseUrl: BASE, now: () => t });
  await svc.listItems({});
  await svc.listItems({});
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/field').length, 1);
  t += 10 * 60 * 1000 + 1;
  await svc.listItems({});
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/field').length, 2);
});
