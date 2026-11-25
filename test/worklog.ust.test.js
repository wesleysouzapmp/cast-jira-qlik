import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUstCalculator } from '../src/worklog/ust.js';

const BASE = 'https://x.atlassian.net';
const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 0.4 }, { cat: 'CAT-105', size: 'M', ust: 8 },
  { cat: 'CAT-166', size: 'P', ust: 8 }, { cat: 'CAT-157', size: 'Hora', ust: 1 },
];
const FIELDS = [
  { id: 'summary', name: 'Resumo', custom: false },
  { id: 'customfield_10104', name: 'Item do Catálogo', custom: true },
  { id: 'customfield_10200', name: 'Tamanho', custom: true },
];
const task = (key, cat, size, status = 'Concluído') => ({
  key,
  fields: {
    summary: `Tarefa ${key}`,
    status: { name: status },
    customfield_10104: cat === undefined ? null : { value: 'Business Intelligence', child: { value: cat } },
    customfield_10200: size === undefined ? null : { value: size },
  },
});

function fake({ done = [], open = [], fields = FIELDS, worklogs = [] } = {}) {
  const calls = [];
  const client = {
    async call(req) {
      calls.push(req);
      if (req.path === '/rest/api/3/field') return { status: 200, ok: true, data: fields };
      if (req.path === '/rest/api/3/search/jql') {
        const issues = req.body.jql.includes('statusCategory = Done') ? done : open;
        return { status: 200, ok: true, data: { issues, isLast: true } };
      }
      return { status: 404, ok: false, data: {} };
    },
  };
  const myWorklogs = async () => worklogs;
  return { calc: createUstCalculator({ client, baseUrl: BASE, myWorklogs }), calls };
}

test('soma UST das concluídas e das em andamento pelo CAT + Tamanho', async () => {
  const { calc, calls } = fake({
    done: [task('Q-1', 'CAT-105 - Realizar diagnóstico', 'M'), task('Q-2', 'CAT-166 - Manter script', 'P')],
    open: [task('Q-3', 'CAT-105 - Realizar diagnóstico', 'P', 'Em Execução')],
    worklogs: [{ issueKey: 'Q-3', minutes: 60 }],
  });
  const r = await calc.summary({ from: '2026-10-21', to: '2026-11-20', catalog: CATALOG });
  assert.equal(r.sizeField, 'Tamanho');
  assert.equal(r.concluded.ust, 16);
  assert.deepEqual(r.concluded.tasks.map((t) => [t.key, t.cat, t.size, t.ust, t.status]), [['Q-1', 'CAT-105', 'M', 8, 'Concluído'], ['Q-2', 'CAT-166', 'P', 8, 'Concluído']]);
  assert.equal(r.concluded.tasks[0].url, BASE + '/browse/Q-1');
  assert.equal(r.inProgress.ust, 0.4);
  assert.deepEqual(r.problems, []);
  const jqls = calls.filter((c) => c.path === '/rest/api/3/search/jql').map((c) => c.body.jql);
  assert.match(jqls[0], /^assignee = currentUser\(\) AND statusCategory = Done AND statusCategoryChangedDate >= "2026-10-21" AND statusCategoryChangedDate < "2026-11-21" AND cf\[10104\] is not EMPTY/);
  assert.match(jqls[1], /^worklogAuthor = currentUser\(\) AND worklogDate >= "2026-10-20" AND worklogDate <= "2026-11-21" AND statusCategory != Done AND cf\[10104\] is not EMPTY/);
  for (const c of calls.filter((x) => x.path === '/rest/api/3/search/jql')) assert.ok(c.body.fields.includes('customfield_10200'));
});

test('itens por hora multiplicam a UST pelas horas apontadas no período', async () => {
  const { calc } = fake({
    open: [task('Q-5', 'CAT-157 - Participar de reunião', 'Hora', 'Em Execução')],
    worklogs: [{ issueKey: 'Q-5', minutes: 90 }, { issueKey: 'Q-5', minutes: 30 }, { issueKey: 'Q-9', minutes: 60 }],
  });
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.equal(r.inProgress.ust, 2);
  assert.deepEqual([r.inProgress.tasks[0].hours, r.inProgress.tasks[0].ust], [2, 2]);
});

test('tarefas sem tamanho, sem CAT ou fora do catálogo vão para problemas e não somam', async () => {
  const { calc } = fake({
    done: [task('Q-1', 'CAT-105 - X', undefined), task('Q-2', 'Outro item', 'P'), task('Q-3', 'CAT-999 - Y', 'G'), task('Q-4', 'CAT-105 - X', 'Gigante')],
  });
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.equal(r.concluded.ust, 0);
  assert.deepEqual(r.problems.map((p) => [p.key, p.problem]), [
    ['Q-1', 'sem Tamanho'],
    ['Q-2', 'Item do Catálogo sem código CAT ("Business Intelligence › Outro item")'],
    ['Q-3', 'CAT-999 G não está no catálogo de UST'],
    ['Q-4', 'Tamanho não reconhecido ("Gigante")'],
  ]);
});

test('em andamento só conta tarefa com horas suas no período (worklogAuthor e worklogDate não são o mesmo apontamento)', async () => {
  const { calc } = fake({
    open: [task('Q-3', 'CAT-105 - X', 'M', 'Em Execução'), task('Q-4', 'CAT-105 - X', 'P', 'Em Execução')],
    worklogs: [{ issueKey: 'Q-4', minutes: 30 }],
  });
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.deepEqual(r.inProgress.tasks.map((t) => t.key), ['Q-4']);
  assert.equal(r.inProgress.ust, 0.4);
});

test('campo Tamanho ausente não fica em cache (pode ser criado depois)', async () => {
  let fields = FIELDS.filter((f) => f.name !== 'Tamanho');
  const calls = [];
  const client = { async call(req) { calls.push(req); if (req.path === '/rest/api/3/field') return { status: 200, ok: true, data: fields }; return { status: 200, ok: true, data: { issues: [], isLast: true } }; } };
  const calc = createUstCalculator({ client, baseUrl: BASE, myWorklogs: async () => [] });
  assert.ok((await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG })).error);
  fields = FIELDS;
  assert.equal((await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG })).sizeField, 'Tamanho');
});

test('sem campo Tamanho no Jira: avisa e não busca tarefas', async () => {
  const { calc, calls } = fake({ fields: FIELDS.filter((f) => f.name !== 'Tamanho') });
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.equal(r.sizeField, null);
  assert.match(r.error, /Tamanho/);
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/search/jql').length, 0);
});

test('catálogo vazio: avisa sem consultar o Jira', async () => {
  const { calc, calls } = fake();
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: [] });
  assert.match(r.error, /catálogo de UST está vazio/);
  assert.equal(calls.length, 0);
});

test('o id do campo Tamanho fica em cache', async () => {
  const { calc, calls } = fake();
  await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.equal(calls.filter((c) => c.path === '/rest/api/3/field').length, 1);
});

test('tamanho como texto simples ou lista também funciona', async () => {
  const t1 = task('Q-1', 'CAT-105 - X', undefined);
  t1.fields.customfield_10200 = 'M';
  const t2 = task('Q-2', 'CAT-166 - Y', undefined);
  t2.fields.customfield_10200 = [{ value: 'P' }];
  const { calc } = fake({ done: [t1, t2] });
  const r = await calc.summary({ from: '2026-11-01', to: '2026-11-30', catalog: CATALOG });
  assert.equal(r.concluded.ust, 16);
});
