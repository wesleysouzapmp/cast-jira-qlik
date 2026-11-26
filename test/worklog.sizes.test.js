import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUstCalculator } from '../src/worklog/ust.js';

const BASE = 'https://x.atlassian.net';
const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 0.4, description: 'Revisão da atividade' },
  { cat: 'CAT-105', size: 'M', ust: 8, description: 'Diagnóstico de Incidente' },
  { cat: 'CAT-106', size: 'P', ust: 0.3, description: 'Revisão' },
  { cat: 'CAT-106', size: 'M', ust: 2, description: 'Até 5 tabelas' },
  { cat: 'CAT-106', size: 'G', ust: 4, description: 'De 6 a 10 tabelas' },
  { cat: 'CAT-157', size: 'Hora', ust: 1, description: 'Hora de participação' },
];
const FIELDS = [{ id: 'customfield_10104', name: 'Item do Catálogo', custom: true }, { id: 'customfield_10200', name: 'Tamanho', custom: true }];
const OPTIONS = [{ id: '501', value: 'P' }, { id: '502', value: 'M' }, { id: '503', value: 'G' }, { id: '504', value: 'Hora' }];
const task = (key, cat, size, hours, status = 'Em Execução', assignee = 'me') => ({
  key,
  fields: {
    assignee: assignee ? { accountId: assignee } : null,
    summary: `Tarefa ${key}`,
    status: { name: status },
    timespent: Math.round(hours * 3600),
    customfield_10104: cat ? { value: 'Business Intelligence', child: { value: `${cat} - item` } } : null,
    customfield_10200: size ? { value: size } : null,
  },
});

const CAT_OPTIONS = [
  { id: '11927', value: 'Business Intelligence', children: [
    { id: '11930', value: 'CAT-105 - Realizar diagnóstico' },
    { id: '11931', value: 'CAT-106 - Elaborar modelo dimensional' },
    { id: '11932', value: 'CAT-157 - Participar de reunião' },
  ] },
  { id: '11999', value: 'Antigo', disabled: true, children: [{ id: '12999', value: 'CAT-106 - antigo' }] },
];

function fake({ issues = [], options = OPTIONS, catOptions = CAT_OPTIONS, putFail = {}, editable = true } = {}) {
  const calls = [];
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const client = {
    async call(req) {
      calls.push(req);
      const { method = 'GET', path, body } = req;
      if (path === '/rest/api/3/field') return { status: 200, ok: true, data: FIELDS };
      if (path === '/rest/api/3/myself') return { status: 200, ok: true, data: { accountId: 'me' } };
      if (path === '/rest/api/3/search/jql') return { status: 200, ok: true, data: { issues, isLast: true } };
      if (path === '/rest/api/3/issue/bulkfetch') return { status: 200, ok: true, data: { issues: body.issueIdsOrKeys.map((k) => byKey.get(k)).filter(Boolean) } };
      let m;
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/editmeta$/))) {
        return { status: 200, ok: true, data: { fields: editable ? { customfield_10200: { allowedValues: options }, customfield_10104: { allowedValues: catOptions } } : {} } };
      }
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)$/)) && method === 'PUT') {
        if (putFail[m[1]]) return { status: 400, ok: false, data: { errorMessages: [putFail[m[1]]] } };
        if (body.fields.customfield_10200) {
          const opt = options.find((o) => o.id === body.fields.customfield_10200.id);
          byKey.get(m[1]).fields.customfield_10200 = { value: opt.value ?? opt.name };
        }
        if (body.fields.customfield_10104) {
          const parent = catOptions.find((o) => o.id === body.fields.customfield_10104.id);
          const child = parent.children.find((c) => c.id === body.fields.customfield_10104.child.id);
          byKey.get(m[1]).fields.customfield_10104 = { value: parent.value, child: { value: child.value } };
        }
        return { status: 204, ok: true, data: '' };
      }
      return { status: 404, ok: false, data: {} };
    },
  };
  return { calc: createUstCalculator({ client, baseUrl: BASE, myWorklogs: async () => [] }), calls, byKey };
}

test('análise lista tamanhos do CAT com UST e descrição, horas da tarefa e alertas', async () => {
  const { calc, calls } = fake({ issues: [
    task('Q-1', 'CAT-105', 'P', 7.5),
    task('Q-2', 'CAT-106', 'G', 1),
    task('Q-3', 'CAT-106', 'M', 3),
    task('Q-4', 'CAT-105', 'M', 0),
  ] });
  const r = await calc.sizeAnalysis({ from: '2026-10-21', to: '2026-11-20', catalog: CATALOG });
  assert.equal(r.sizeField, 'Tamanho');
  const [q1, q2, q3, q4] = r.tasks;
  assert.deepEqual([q1.key, q1.cat, q1.size, q1.hours, q1.ust], ['Q-1', 'CAT-105', 'P', 7.5, 0.4]);
  assert.deepEqual(q1.options, [{ size: 'P', ust: 0.4, description: 'Revisão da atividade' }, { size: 'M', ust: 8, description: 'Diagnóstico de Incidente' }]);
  assert.deepEqual(q1.alerts, ['under']);
  assert.deepEqual(q2.alerts, ['over']);
  assert.deepEqual(q3.alerts, ['under']);
  assert.deepEqual(q4.alerts, []);
  const jql = calls.find((c) => c.path === '/rest/api/3/search/jql').body.jql;
  assert.match(jql, /^assignee = currentUser\(\) AND cf\[10104\] is not EMPTY AND \(/);
  assert.doesNotMatch(jql, /statusCategory (!=|=) Done/);
  assert.ok(calls.find((c) => c.path === '/rest/api/3/search/jql').body.fields.includes('timespent'));
});

test('análise traz tarefas de qualquer status com movimento no período: horas suas, criação ou mudança de status', async () => {
  const { calc, calls } = fake({ issues: [] });
  await calc.sizeAnalysis({ from: '2026-10-21', to: '2026-11-20', catalog: CATALOG });
  const jql = calls.find((c) => c.path === '/rest/api/3/search/jql').body.jql;
  assert.equal(jql, 'assignee = currentUser() AND cf[10104] is not EMPTY AND ('
    + '(worklogAuthor = currentUser() AND worklogDate >= "2026-10-20" AND worklogDate <= "2026-11-21")'
    + ' OR (created >= "2026-10-21" AND created < "2026-11-21")'
    + ' OR (statusCategoryChangedDate >= "2026-10-21" AND statusCategoryChangedDate < "2026-11-21")) ORDER BY key');
});

test('análise marca tarefa sem tamanho ou fora do catálogo, sem alertas', async () => {
  const { calc } = fake({ issues: [task('Q-1', 'CAT-105', null, 2), task('Q-2', 'CAT-999', 'P', 2), task('Q-3', null, 'P', 2)] });
  const r = await calc.sizeAnalysis({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.deepEqual(r.tasks.map((t) => [t.key, t.size, t.problem ?? null, t.alerts]), [
    ['Q-1', null, 'sem Tamanho', []],
    ['Q-2', 'P', 'CAT-999 não está no catálogo de UST', []],
    ['Q-3', 'P', 'Item do Catálogo sem código CAT ("")', []],
  ]);
  assert.equal(r.tasks[0].options.length, 2);
});

test('troca grava o Tamanho pela opção do Jira e devolve UST antes e depois', async () => {
  const { calc, calls, byKey } = fake({ issues: [task('Q-1', 'CAT-105', 'P', 7.5), task('Q-2', 'CAT-106', 'G', 1)] });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', size: 'M' }, { key: 'Q-2', size: 'G' }], catalog: CATALOG });
  assert.deepEqual(r.results.map((x) => [x.key, x.status, x.from, x.to, x.ustBefore, x.ustAfter]), [
    ['Q-1', 'updated', 'P', 'M', 0.4, 8],
    ['Q-2', 'unchanged', 'G', 'G', 4, 4],
  ]);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/rest/api/3/issue/Q-1');
  assert.deepEqual(put.body, { fields: { customfield_10200: { id: '502' } } });
  assert.equal(byKey.get('Q-1').fields.customfield_10200.value, 'M');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
});

test('troca recusa tamanho fora do catálogo do CAT, opção inexistente no Jira, campo não editável e erro do Jira', async () => {
  const issues = [task('Q-1', 'CAT-105', 'P', 1), task('Q-2', 'CAT-106', 'P', 1), task('Q-3', 'CAT-106', 'P', 1)];
  const { calc, calls } = fake({ issues, options: OPTIONS.filter((o) => o.value !== 'G'), putFail: { 'Q-3': 'Campo não pode ser editado' } });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', size: 'G' }, { key: 'Q-2', size: 'G' }, { key: 'Q-3', size: 'M' }, { key: 'Q-404', size: 'P' }], catalog: CATALOG });
  assert.deepEqual(r.results.map((x) => [x.key, x.status]), [['Q-1', 'error'], ['Q-2', 'error'], ['Q-3', 'error'], ['Q-404', 'error']]);
  assert.match(r.results[0].error, /CAT-105 não tem tamanho G no catálogo/);
  assert.match(r.results[1].error, /Jira não oferece o valor G/);
  assert.match(r.results[2].error, /Campo não pode ser editado/);
  assert.match(r.results[3].error, /não encontrada/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);

  const ro = fake({ issues: [task('Q-1', 'CAT-105', 'P', 1)], editable: false });
  const r2 = await ro.calc.changeSizes({ changes: [{ key: 'Q-1', size: 'M' }], catalog: CATALOG });
  assert.match(r2.results[0].error, /não pode ser editado nesta tarefa/);
});

test('troca usa a opção exata, ignora desativadas, aceita "M - Médio" e só "name", e recusa ambiguidade', async () => {
  const pick = async (options, size = 'M') => {
    const { calc, calls } = fake({ issues: [task('Q-1', 'CAT-105', 'P', 1)], options });
    const r = await calc.changeSizes({ changes: [{ key: 'Q-1', size }], catalog: CATALOG });
    return { r: r.results[0], put: calls.find((c) => c.method === 'PUT') };
  };
  assert.equal((await pick([{ id: '1', value: 'M - Médio (antigo)', disabled: true }, { id: '2', value: 'M - Médio' }])).put.body.fields.customfield_10200.id, '2');
  assert.equal((await pick([{ id: '3', value: 'Médio' }, { id: '4', value: 'M' }])).put.body.fields.customfield_10200.id, '4');
  assert.equal((await pick([{ id: '5', name: 'M' }])).put.body.fields.customfield_10200.id, '5');
  const amb = await pick([{ id: '6', value: 'M - Médio' }, { id: '7', value: 'Médio' }]);
  assert.equal(amb.r.status, 'error');
  assert.match(amb.r.error, /mais de uma opção para M/);
  assert.equal(amb.put, undefined);
});

test('troca não grava se o tamanho mudou no Jira depois da tela carregar', async () => {
  const { calc, calls } = fake({ issues: [task('Q-1', 'CAT-105', 'M', 1)] });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', size: 'P', from: 'P' }], catalog: CATALOG });
  assert.equal(r.results[0].status, 'conflict');
  assert.match(r.results[0].error, /mudou para M no Jira/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  const sem = await calc.changeSizes({ changes: [{ key: 'Q-1', size: 'P', from: '' }], catalog: CATALOG });
  assert.equal(sem.results[0].status, 'conflict');
});

test('troca recusa tarefa atribuída a outra pessoa', async () => {
  const { calc, calls } = fake({ issues: [task('Q-1', 'CAT-105', 'P', 1, 'Em Execução', 'outro')] });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', size: 'M' }], catalog: CATALOG });
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].error, /não está atribuída a você/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('análise devolve os CATs do catálogo com seus tamanhos, para trocar o CAT na tela', async () => {
  const { calc } = fake({ issues: [] });
  const r = await calc.sizeAnalysis({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.deepEqual(r.cats.map((c) => [c.cat, c.options.map((o) => o.size).join('')]), [['CAT-105', 'PM'], ['CAT-106', 'PMG'], ['CAT-157', 'Hora']]);
});

test('troca de CAT e tamanho grava os dois campos com as opções do Jira', async () => {
  const { calc, calls, byKey } = fake({ issues: [task('Q-1', 'CAT-105', 'P', 3)] });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', cat: 'CAT-106', size: 'G', fromCat: 'CAT-105', from: 'P' }], catalog: CATALOG });
  assert.deepEqual(r.results.map((x) => [x.status, x.fromCat, x.toCat, x.from, x.to, x.ustBefore, x.ustAfter]), [['updated', 'CAT-105', 'CAT-106', 'P', 'G', 0.4, 4]]);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { fields: { customfield_10104: { id: '11927', child: { id: '11931' } }, customfield_10200: { id: '503' } } });
  assert.match(byKey.get('Q-1').fields.customfield_10104.child.value, /^CAT-106/);
});

test('troca só de CAT mantendo o tamanho grava só o Item do Catálogo', async () => {
  const { calc, calls } = fake({ issues: [task('Q-1', 'CAT-105', 'M', 3)] });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', cat: 'CAT-106', size: 'M' }], catalog: CATALOG });
  assert.equal(r.results[0].status, 'updated');
  assert.deepEqual(Object.keys(calls.find((c) => c.method === 'PUT').body.fields), ['customfield_10104']);
});

test('troca de CAT recusa tamanho inexistente no novo CAT, CAT fora do Jira, CAT mudado e CAT fora do catálogo', async () => {
  const issues = [task('Q-1', 'CAT-105', 'P', 1), task('Q-2', 'CAT-105', 'P', 1), task('Q-3', 'CAT-106', 'P', 1), task('Q-4', 'CAT-105', 'P', 1)];
  const { calc, calls } = fake({ issues, catOptions: [{ id: '1', value: 'BI', children: [{ id: '2', value: 'CAT-105 - X' }, { id: '3', value: 'CAT-106 - Y' }] }] });
  const r = await calc.changeSizes({ changes: [
    { key: 'Q-1', cat: 'CAT-106', size: 'Hora' },
    { key: 'Q-2', cat: 'CAT-157', size: 'Hora' },
    { key: 'Q-3', cat: 'CAT-105', size: 'M', fromCat: 'CAT-105' },
    { key: 'Q-4', cat: 'CAT-999', size: 'P' },
  ], catalog: CATALOG });
  assert.deepEqual(r.results.map((x) => x.status), ['error', 'error', 'conflict', 'error']);
  assert.match(r.results[0].error, /CAT-106 não tem tamanho Hora/);
  assert.match(r.results[1].error, /Jira não oferece o CAT-157/);
  assert.match(r.results[2].error, /CAT mudou para CAT-106/);
  assert.match(r.results[3].error, /CAT-999 não está no catálogo de UST/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('troca de CAT recusa CAT que aparece em mais de um item ativo do Jira', async () => {
  const dup = [{ id: '1', value: 'BI', children: [{ id: '2', value: 'CAT-106 - A' }] }, { id: '5', value: 'Outro', children: [{ id: '6', value: 'CAT-106 - B' }] }];
  const { calc } = fake({ issues: [task('Q-1', 'CAT-105', 'P', 1)], catOptions: dup });
  const r = await calc.changeSizes({ changes: [{ key: 'Q-1', cat: 'CAT-106', size: 'M' }], catalog: CATALOG });
  assert.match(r.results[0].error, /mais de uma opção para CAT-106/);
});
