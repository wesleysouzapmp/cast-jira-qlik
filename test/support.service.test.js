import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportService, JiraError } from '../src/support/service.js';

const BASE = 'https://x.atlassian.net';
const epic = (key, summary = 'Épico ' + key) => ({ key, fields: { summary, issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: 'Em Execução' }, project: { key: key.split('-')[0] } } });
const story = (key) => ({ key, fields: { summary: 'História', issuetype: { name: 'História', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: 'BI' } } });

// Jira simulado: responde por path/JQL e registra as chamadas.
function fakeClient({ items = [], existing = [], alwaysNextPage = false, createResponses = [] } = {}) {
  const calls = [];
  let created = 0;
  let nextId = 10;
  const client = {
    async call(req) {
      calls.push(req);
      if (req.path === '/rest/api/3/myself') return { status: 200, ok: true, data: { accountId: 'acc-1' } };
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

test('listItems marca épicos e tarefas existentes', async () => {
  const { client } = fakeClient({ items: [epic('BI-1'), story('BI-5')], existing: [existingAnalise] });
  const svc = createSupportService({ client, baseUrl: BASE });
  const r = await svc.listItems({ onlyEpics: false });
  assert.equal(r.truncated, false);
  assert.equal(r.items.length, 2);
  const [e, s] = r.items;
  assert.equal(e.isEpic, true);
  assert.equal(e.url, BASE + '/browse/BI-1');
  assert.deepEqual(e.existing, [{ model: 'analise', key: 'QSENSE-9', url: BASE + '/browse/QSENSE-9', status: '', summary: 'Analise da demanda BI-1 - X' }]);
  assert.equal(s.isEpic, false);
  assert.deepEqual(s.existing, []);
  assert.equal(e.type, 'Épico');
  assert.equal(e.status, 'Em Execução');
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

test('preview mostra o que criar e o que pular', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1', 'X'), story('BI-5')], existing: [existingAnalise] });
  const r = await createSupportService({ client, baseUrl: BASE }).preview(['BI-1', 'BI-5', 'BI-404']);
  assert.equal(r.epics.length, 1);
  assert.deepEqual(r.epics[0].skipped, [{ model: 'analise', key: 'QSENSE-9' }]);
  assert.equal(r.epics[0].toCreate.length, 1);
  assert.equal(r.epics[0].toCreate[0].summary, 'Implementação da demanda BI-1 - X');
  assert.ok(r.epics[0].toCreate[0].catalog.includes('CAT-166'));
  assert.deepEqual(r.rejected.map((x) => x.key), ['BI-5', 'BI-404']);
  assert.equal(creates(calls).length, 0);
});

test('create pula modelo existente', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')], existing: [existingAnalise] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1']);
  assert.deepEqual(r.results.map(({ epic: e, model, status, key }) => ({ e, model, status, key })), [
    { e: 'BI-1', model: 'analise', status: 'skipped', key: 'QSENSE-9' },
    { e: 'BI-1', model: 'implementacao', status: 'created', key: 'QSENSE-10' },
  ]);
  assert.equal(r.results[1].url, BASE + '/browse/QSENSE-10');
  assert.equal(creates(calls).length, 1);
  assert.equal(creates(calls)[0].body.fields.parent.key, 'BI-1');
});

test('create recusa item que não é épico', async () => {
  const { client, calls } = fakeClient({ items: [story('BI-5')] });
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-5']);
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
  const r = await createSupportService({ client, baseUrl: BASE }).create(['BI-1', 'BI-2']);
  assert.equal(creates(calls).length, 4);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].error, /Opção inválida/);
  assert.deepEqual(r.results.slice(1).map((x) => x.status), ['created', 'created', 'created']);
});

test('accountId fica em cache', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1'), epic('BI-2')] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1']);
  await svc.create(['BI-2']);
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/myself').length, 1);
});

test('create concorrente não duplica tarefas', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const slow = { async call(req) { await new Promise((r) => setTimeout(r, 20)); return client.call(req); } };
  const svc = createSupportService({ client: slow, baseUrl: BASE });
  const [a, b] = await Promise.all([svc.create(['BI-1']), svc.create(['BI-1'])]);
  assert.equal(creates(calls).length, 2);
  assert.deepEqual([...a.results, ...b.results].map((r) => r.status).sort(), ['created', 'created', 'skipped', 'skipped']);
});

test('create não duplica quando a busca ainda não enxerga o que foi criado', async () => {
  // A busca de existentes sempre volta vazia (índice do Jira atrasado).
  const { client, calls } = fakeClient({ items: [epic('BI-1')], existing: [] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1']);
  const again = await svc.create(['BI-1']);
  assert.equal(creates(calls).length, 2);
  assert.deepEqual(again.results.map((r) => [r.status, r.key]), [['skipped', 'QSENSE-10'], ['skipped', 'QSENSE-11']]);
  const list = await svc.listItems({ onlyEpics: true });
  assert.deepEqual(list.items[0].existing.map((e) => e.key), ['QSENSE-10', 'QSENSE-11']);
});

test('busca de existentes pede reconcileIssues com os ids criados', async () => {
  const { client, calls } = fakeClient({ items: [epic('BI-1')] });
  const svc = createSupportService({ client, baseUrl: BASE });
  await svc.create(['BI-1']);
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
  assert.deepEqual(list.items[0].existing.map((e) => [e.model, e.key]), [['analise', 'QSENSE-4057'], ['implementacao', 'QSENSE-4058']]);
  const r = await svc.create(['BI-1']);
  assert.deepEqual(r.results.map((x) => x.status), ['skipped', 'skipped']);
  assert.equal(creates(calls).length, 0);
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
  assert.deepEqual(r.items[0].existing, [{ model: 'analise', key: 'QSENSE-9', url: BASE + '/browse/QSENSE-9', status: 'Concluído', summary: 'Analise da demanda BI-1 - X' }]);
  assert.ok(calls.find((c) => c.body?.jql?.startsWith('project = QSENSE')).body.fields.includes('status'));
});
