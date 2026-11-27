// Parte 3: tarefa agrupadora (CAT-87) com subtarefas — validação do pedido, situação da agrupadora
// do épico, descoberta do tipo subtarefa, prévia (sem gravar) e criação com as regras de parada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, QSENSE_TYPES } from './fakeJira.js';
import { quickSetup, META } from './helpers/quick.js';
import { parseGroupInput, groupStatus, previewGroup, createGroupFlow } from '../src/support/group.js';
import { ConflictError, ScopeError } from '../src/worklog/service.js';
import { JiraError } from '../src/support/service.js';

const BASE = 'https://x.atlassian.net';
const CATALOG = [
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico' },
  { cat: 'CAT-200', size: 'G', ust: 5, task: 'Revisar painel' },
  { cat: 'CAT-200', size: 'P', ust: 1, task: 'Revisar painel' },
];
const acts = (n) => Array.from({ length: n }, (_, i) => ({ action: i === 0 ? 'Analisar' : 'Desenvolver', text: `a parte ${i + 1} do painel de vendas` }));
const body = (o = {}) => ({
  epicKey: 'BI-1',
  group: { summary: 'Apoio da demanda {EPICO}' },
  activities: acts(3),
  totalMinutes: 480,
  subtasks: [
    { activities: [0, 1], cat: 'CAT-105', size: 'M', summary: 'Analisar - a parte 1', description: '1. Analisar a parte 1', minutes: 240 },
    { activities: [2], cat: 'CAT-200', size: 'G', summary: 'Desenvolver - a parte 3', description: '1. Desenvolver a parte 3', minutes: 240 },
  ],
  mode: 'manual',
  startDate: '2026-11-30',
  startTime: '08:00',
  dailyLimit: 480,
  ...o,
});
const parse = (o, opts) => parseGroupInput(body(o), CATALOG, opts);
const wls = () => [
  { sub: 0, date: '2026-11-30', start: '08:00', minutes: 240, comment: '' },
  { sub: 1, date: '2026-11-30', start: '12:00', minutes: 240, comment: 'Desenvolvimento' },
];
const groupIssue = (key, parent) => ({ key, fields: {
  summary: `Apoio da demanda ${parent}`, status: { name: 'Aberto' }, parent: { key: parent }, issuetype: { name: 'Tarefa', hierarchyLevel: 0 },
  customfield_10104: { id: '13000', child: { id: '13087', value: 'CAT-87 - Item agrupador (Não será contabilizado)' } },
} });
const subIssue = (key, parent, cat = 'CAT-200', assignee = ME) => ({ key, fields: {
  summary: `Sub ${key}`, status: { name: 'Aberto' }, parent: { key: parent }, issuetype: { name: 'Subtarefa', hierarchyLevel: -1 }, timespent: 1800,
  assignee: { accountId: assignee }, customfield_10104: { id: '11927', child: { id: '12200', value: `${cat} - Revisar painel` } },
} });
const posts = (jira, re) => jira.calls.filter((c) => c.method === 'POST' && re.test(c.path));
const issuePosts = (jira) => posts(jira, /^\/rest\/api\/3\/issue$/);

// ---------- validação ----------
test('validação: pedido normalizado com a fase pela maioria das ações', () => {
  const p = parse({ worklogs: wls() }, { requireWorklogs: true });
  assert.deepEqual(p.subtasks.map((s) => [s.phase, s.minutes, s.cat, s.size]), [['analise', 240, 'CAT-105', 'M'], ['execucao', 240, 'CAT-200', 'G']]);
  assert.equal(p.worklogs[0].comment, 'Analisar - a parte 1'); // comentário vazio = título da subtarefa
  assert.equal(p.worklogs[1].comment, 'Desenvolvimento');
  assert.deepEqual(p.activities[0], { action: 'Analisar', text: 'a parte 1 do painel de vendas', phase: 'analise' });
});

test('validação: erros com mensagem (400 no servidor)', () => {
  const cases = [
    [{ epicKey: 'x' }, /épico/],
    [{ group: null }, /Agrupadora inválida/],
    [{ group: { summary: 'x'.repeat(256) } }, /255/],
    [{ activities: [] }, /1 a 60/],
    [{ activities: [{ action: 'Dançar', text: 'uma atividade qualquer' }, ...acts(2)] }, /Atividade 1: escolha a ação/],
    [{ activities: [{ action: 'Analisar', text: 'curta' }, ...acts(2)] }, /10 a 300/],
    [{ totalMinutes: 10 }, /0h15 a 200h/],
    [{ totalMinutes: 12015 }, /0h15 a 200h/],
    [{ totalMinutes: 2400 }, /^40h exigem 6 subtarefas; você descreveu 3 atividades\. Detalhe mais 3 atividades\.$/],
    [{ subtasks: [body().subtasks[0]] }, /exigem 2 subtarefas/],
    [{ subtasks: [{ ...body().subtasks[0], activities: [0] }, { ...body().subtasks[1], activities: [1, 2] }].reverse() }, /em ordem/],
    [{ subtasks: [{ ...body().subtasks[0], cat: 'CAT-999' }, body().subtasks[1]] }, /Subtarefa 1: CAT-999 não está no catálogo/],
    [{ subtasks: [body().subtasks[0], { ...body().subtasks[1], size: 'M' }] }, /Subtarefa 2: CAT-200 não tem tamanho M/],
    [{ subtasks: [{ ...body().subtasks[0], summary: 'x'.repeat(256) }, body().subtasks[1]] }, /255/],
    [{ subtasks: [{ ...body().subtasks[0], description: 'x'.repeat(2001) }, body().subtasks[1]] }, /2000/],
    [{ subtasks: [{ ...body().subtasks[0], minutes: 465 }, { ...body().subtasks[1], minutes: 15 }] }, /no máximo 7h30/],
    [{ subtasks: [{ ...body().subtasks[0], minutes: 240 }, { ...body().subtasks[1], minutes: 225 }] }, /fechar o total de 8h/],
    [{ mode: 'percent', percents: { analise: 10, execucao: 50, testes: 30, producao: 5 } }, /somar 100%/],
    [{ startDate: '2026-02-30' }, /Data inicial/],
    [{ startTime: '08:10' }, /múltiplo de 15/],
    [{ dailyLimit: 5 }, /Limite diário/],
    [{ worklogs: [{ ...wls()[0], minutes: 495 }, wls()[1]] }, /15 a 480/],
    [{ worklogs: [{ ...wls()[0], start: '22:00', minutes: 240 }, wls()[1]] }, /meia-noite/],
    [{ worklogs: [{ ...wls()[0], comment: 'x'.repeat(1001) }, wls()[1]] }, /1000/],
    [{ worklogs: [{ ...wls()[0], minutes: 180 }, wls()[1]] }, /Subtarefa 1: os apontamentos somam 3h/],
    [{ worklogs: [wls()[0], { ...wls()[1], start: '11:00' }] }, /se sobrepõem/],
    [{ dailyLimit: 420, worklogs: wls() }, /limite diário de 7h/],
    [{ worklogs: [{ ...wls()[0], sub: 5 }, wls()[1]] }, /subtarefa inválida/],
  ];
  for (const [o, re] of cases) {
    assert.throws(() => parse(o), (e) => e instanceof RangeError && re.test(e.message), JSON.stringify(o).slice(0, 90));
  }
  assert.throws(() => parse({}, { requireWorklogs: true }), /Monte as datas/);
});

// ---------- situação da agrupadora ----------
test('agrupadora do épico: nenhuma, uma (com subtarefas e fase) ou várias; épico de outra pessoa = ScopeError', async () => {
  const q = quickSetup();
  assert.deepEqual((await groupStatus(q.ctx, 'BI-1')).group, { status: 'new' });
  assert.equal((await groupStatus(q.ctx, 'BI-1')).epic.label, 'BI-1 - Painel de vendas');
  await assert.rejects(groupStatus(q.ctx, 'BI-77'), ScopeError);
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  q.jira.issues.set('QSENSE-60', subIssue('QSENSE-60', 'QSENSE-50'));
  const one = (await groupStatus(q.ctx, 'BI-1')).group;
  assert.equal(one.status, 'existing');
  assert.equal(one.key, 'QSENSE-50');
  assert.deepEqual(one.subtasks.map((s) => [s.key, s.cat, s.phase]), [['QSENSE-60', 'CAT-200', 'execucao']]);
  // Subtarefas numa busca só, pela JQL parent in (agrupadoras).
  assert.ok(q.jira.calls.some((c) => c.path === '/rest/api/3/search/jql' && c.body.jql === 'parent in (QSENSE-50)'));
  q.jira.issues.set('QSENSE-51', groupIssue('QSENSE-51', 'BI-1'));
  assert.deepEqual((await groupStatus(q.ctx, 'BI-1')).group, { status: 'conflict', keys: ['QSENSE-50', 'QSENSE-51'] });
});

test('listItems: agrupadora marcada (group) com as subtarefas dela', async () => {
  const q = quickSetup();
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  q.jira.issues.set('QSENSE-60', subIssue('QSENSE-60', 'QSENSE-50'));
  const { items } = await q.supportService.listItems({ onlyEpics: true });
  const g = items[0].existing.find((t) => t.key === 'QSENSE-50');
  assert.equal(g.group, true);
  assert.equal(g.cat, 'CAT-87');
  assert.deepEqual(g.subtasks.map((s) => s.key), ['QSENSE-60']);
  assert.equal(items[0].existing.find((t) => t.key === 'QSENSE-1').group, undefined);
});

// ---------- tipo subtarefa ----------
test('tipo subtarefa: subtask = true; vários → o de nome Subtarefa/Sub-task; em cache', async () => {
  const q = quickSetup();
  assert.deepEqual(await q.supportService.subtaskType(), { id: '10003', name: 'Subtarefa' });
  await q.supportService.subtaskType();
  assert.equal(q.jira.calls.filter((c) => c.path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes').length, 1);
  const many = quickSetup({ qsenseTypes: [...QSENSE_TYPES.slice(0, 1), { id: '20', name: 'Subtarefa de teste', subtask: true }, { id: '21', name: 'Sub-task', subtask: true }] });
  assert.deepEqual(await many.supportService.subtaskType(), { id: '21', name: 'Sub-task' });
});

test('tipo subtarefa: nenhum ou ambíguo → erro claro', async () => {
  const none = quickSetup({ qsenseTypes: QSENSE_TYPES.slice(0, 1) });
  await assert.rejects(none.supportService.subtaskType(), (e) => e instanceof JiraError && /não tem tipo de subtarefa/.test(e.message));
  const amb = quickSetup({ qsenseTypes: [{ id: '20', name: 'Subtarefa A', subtask: true }, { id: '21', name: 'Subtarefa B', subtask: true }] });
  await assert.rejects(amb.supportService.subtaskType(), /mais de um tipo de subtarefa \(Subtarefa A, Subtarefa B\)/);
});

test('tipo subtarefa: lista paginada em values', async () => {
  const pages = [
    { startAt: 0, maxResults: 1, total: 2, values: [{ id: '10002', name: 'Tarefa', subtask: false }] },
    { startAt: 1, maxResults: 1, total: 2, values: [{ id: '10009', name: 'Subtarefa', subtask: true }] },
  ];
  const q = quickSetup({ intercept: (req, next) => (req.path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes' ? { status: 200, ok: true, data: pages[Number(req.query.startAt) ? 1 : 0] } : next(req)) });
  assert.deepEqual(await q.supportService.subtaskType(), { id: '10009', name: 'Subtarefa' });
});

// ---------- prévia ----------
test('prévia: propõe a grade de datas (dias úteis, feriado, batidas existentes) sem gravar nada', async () => {
  const holidays = { async between() { return new Map([['2026-12-01', 'Feriado local']]); } };
  const q = quickSetup({
    holidays,
    worklogs: { 'QSENSE-1': [{ id: '1', author: { accountId: ME }, started: '2026-11-30T08:00:00.000-0300', timeSpentSeconds: 3600 }] },
  });
  const out = await previewGroup(q.ctx, parse({ totalMinutes: 900, subtasks: [{ ...body().subtasks[0], minutes: 450 }, { ...body().subtasks[1], minutes: 450 }] }));
  assert.deepEqual(out.group, { status: 'new', summary: 'Apoio da demanda {EPICO}' });
  assert.deepEqual(out.worklogs.map((w) => [w.sub, w.date, w.start, w.minutes]), [
    [0, '2026-11-30', '09:00', 420],
    [0, '2026-12-02', '08:00', 30],
    [1, '2026-12-02', '08:30', 450],
  ]);
  assert.equal(out.worklogs[2].comment, 'Desenvolver - a parte 3');
  assert.equal(issuePosts(q.jira).length, 0);
  assert.equal(posts(q.jira, /\/worklog$/).length, 0);
});

test('prévia: grade enviada é checada contra o Jira (sobreposição e limite diário)', async () => {
  const q = quickSetup({ worklogs: { 'QSENSE-1': [{ id: '1', author: { accountId: ME }, started: '2026-11-30T12:30:00.000-0300', timeSpentSeconds: 1800 }] } });
  await assert.rejects(previewGroup(q.ctx, parse({ worklogs: wls() })), (e) => e instanceof ConflictError && /QSENSE-1 das 12:30/.test(e.message));
  const q2 = quickSetup({ worklogs: { 'QSENSE-1': [{ id: '1', author: { accountId: ME }, started: '2026-11-30T17:00:00.000-0300', timeSpentSeconds: 1800 }] } });
  await assert.rejects(previewGroup(q2.ctx, parse({ worklogs: wls() })), (e) => e instanceof ScopeError && /limite diário de 8h/.test(e.message));
});

test('prévia: agrupadora diferente da que a tela viu = ConflictError; várias = ScopeError', async () => {
  const q = quickSetup();
  await assert.rejects(previewGroup(q.ctx, parse({ group: { key: 'QSENSE-50' } })), ConflictError);
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  await assert.rejects(previewGroup(q.ctx, parse()), (e) => e instanceof ConflictError && /já tem a agrupadora QSENSE-50/.test(e.message));
  const ok = await previewGroup(q.ctx, parse({ group: { key: 'QSENSE-50' } }));
  assert.equal(ok.group.key, 'QSENSE-50');
  q.jira.issues.set('QSENSE-51', groupIssue('QSENSE-51', 'BI-1'));
  await assert.rejects(previewGroup(q.ctx, parse({ group: { key: 'QSENSE-50' } })), (e) => e instanceof ScopeError && /QSENSE-50, QSENSE-51/.test(e.message));
});

test('prévia: CAT-87 ou CAT da subtarefa fora do createmeta param antes de gravar', async () => {
  const noGroupCat = quickSetup({ metaByType: { 10002: META.map((f) => (f.fieldId === 'customfield_10104' ? { ...f, allowedValues: f.allowedValues.slice(0, 1) } : f)) } });
  await assert.rejects(previewGroup(noGroupCat.ctx, parse()), (e) => e instanceof JiraError && /CAT-87/.test(e.message));
  const subMeta = META.map((f) => (f.fieldId === 'customfield_10104' ? { ...f, allowedValues: [{ id: '11927', value: 'BI', children: [{ id: '12200', value: 'CAT-200 - Revisar painel' }] }] } : f));
  const noSubCat = quickSetup({ metaByType: { 10003: subMeta } });
  await assert.rejects(previewGroup(noSubCat.ctx, parse()), (e) => e instanceof ScopeError && /Subtarefa 1: O Jira não oferece o CAT-105/.test(e.message));
  assert.equal(issuePosts(noSubCat.jira).length, 0);
});

// ---------- criação ----------
test('criação: agrupadora → subtarefas (uma por vez) → apontamentos, com fase guardada', async () => {
  const q = quickSetup();
  const out = await createGroupFlow(q.ctx, parse({ worklogs: wls() }, { requireWorklogs: true }));
  assert.deepEqual(out.group, { status: 'created', key: 'QSENSE-900', url: `${BASE}/browse/QSENSE-900`, summary: 'Apoio da demanda BI-1 - Painel de vendas' });
  assert.deepEqual(out.subtasks.map((s) => [s.index, s.status, s.key]), [[0, 'created', 'QSENSE-901'], [1, 'created', 'QSENSE-902']]);
  assert.deepEqual(out.worklogs.map((w) => [w.index, w.sub, w.status]), [[0, 0, 'created'], [1, 1, 'created']]);
  const [g, s1, s2] = issuePosts(q.jira).map((c) => c.body.fields);
  assert.deepEqual(g.parent, { key: 'BI-1' });
  assert.deepEqual(g.issuetype, { id: '10002' });
  assert.deepEqual(g.customfield_10104, { id: '13000', child: { id: '13087' } });
  assert.equal(g.customfield_10300, undefined);
  assert.deepEqual(g.components, [{ id: '10013' }]);
  assert.deepEqual(g.assignee, { accountId: ME });
  assert.deepEqual(g.description.content.map((p) => p.content?.[0]?.text), [
    'As atividades realizadas foram:', '1. Analisar a parte 1 do painel de vendas', '2. Desenvolver a parte 2 do painel de vendas', '3. Desenvolver a parte 3 do painel de vendas',
  ]);
  assert.deepEqual(s1.parent, { key: 'QSENSE-900' });
  assert.deepEqual(s1.issuetype, { id: '10003' });
  assert.deepEqual(s1.customfield_10104, { id: '11927', child: { id: '11930' } });
  assert.deepEqual(s1.customfield_10300, { id: '702' });
  assert.deepEqual(s2.customfield_10300, { id: '703' });
  const w = posts(q.jira, /\/worklog$/);
  assert.deepEqual(w.map((c) => [c.path, c.body.started, c.body.timeSpent]), [
    ['/rest/api/3/issue/QSENSE-901/worklog', '2026-11-30T08:00:00.000-0300', '4h'],
    ['/rest/api/3/issue/QSENSE-902/worklog', '2026-11-30T12:00:00.000-0300', '4h'],
  ]);
  // Destinos de horas: as subtarefas, com a fase; a agrupadora não.
  const { epics } = await q.worklogService.listTasks();
  const e = epics.find((x) => x.key === 'BI-1');
  assert.deepEqual(e.tasks.map((t) => [t.key, t.phase ?? null]), [['QSENSE-1', null], ['QSENSE-901', 'analise'], ['QSENSE-902', 'execucao']]);
  assert.deepEqual(e.groups, ['QSENSE-900']);
});

test('criação: agrupadora falhou → nada mais é feito', async () => {
  const q = quickSetup({ failCreate: (b) => (b.fields.customfield_10104?.child?.id === '13087' ? 'Sem permissão' : null) });
  const out = await createGroupFlow(q.ctx, parse({ worklogs: wls() }, { requireWorklogs: true }));
  assert.equal(out.group.status, 'error');
  assert.match(out.group.error, /Sem permissão/);
  assert.deepEqual(out.subtasks.map((s) => s.status), ['skipped', 'skipped']);
  assert.deepEqual(out.worklogs.map((s) => s.status), ['skipped', 'skipped']);
  assert.equal(issuePosts(q.jira).length, 1);
  assert.equal(posts(q.jira, /\/worklog$/).length, 0);
});

test('criação: subtarefa falhou → as outras continuam e os apontamentos dela não são feitos', async () => {
  const q = quickSetup({ failCreate: (b) => (b.fields.summary === 'Analisar - a parte 1' ? 'Campo obrigatório' : null) });
  const out = await createGroupFlow(q.ctx, parse({ worklogs: wls() }, { requireWorklogs: true }));
  assert.equal(out.group.status, 'created');
  assert.deepEqual(out.subtasks.map((s) => s.status), ['error', 'created']);
  assert.match(out.subtasks[0].error, /Campo obrigatório/);
  assert.deepEqual(out.worklogs.map((s) => s.status), ['skipped', 'created']);
  assert.equal(posts(q.jira, /\/worklog$/).length, 1);
});

test('criação: apontamento falhou → os outros continuam', async () => {
  const q = quickSetup({ failWorklogFor: ['QSENSE-901'] });
  const out = await createGroupFlow(q.ctx, parse({ worklogs: wls() }, { requireWorklogs: true }));
  assert.deepEqual(out.worklogs.map((s) => s.status), ['error', 'created']);
  assert.match(out.worklogs[0].error, /recusado/);
});

test('criação na agrupadora existente: só subtarefas e apontamentos', async () => {
  const q = quickSetup();
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  const out = await createGroupFlow(q.ctx, parse({ group: { key: 'QSENSE-50' }, worklogs: wls() }, { requireWorklogs: true }));
  assert.deepEqual(out.group, { status: 'existing', key: 'QSENSE-50', url: `${BASE}/browse/QSENSE-50` });
  assert.deepEqual(issuePosts(q.jira).map((c) => c.body.fields.parent.key), ['QSENSE-50', 'QSENSE-50']);
});

// ---------- destinos de horas ----------
test('apontar: a agrupadora some da lista e o servidor recusa horas nela; subtarefas de colegas ficam de fora', async () => {
  const q = quickSetup();
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  q.jira.issues.set('QSENSE-60', subIssue('QSENSE-60', 'QSENSE-50'));
  q.jira.issues.set('QSENSE-61', subIssue('QSENSE-61', 'QSENSE-50', 'CAT-200', 'acc-colega'));
  const { epics } = await q.worklogService.listTasks();
  assert.deepEqual(epics[0].tasks.map((t) => [t.key, t.subtask ?? false, t.label]), [['QSENSE-1', false, 'Análise'], ['QSENSE-60', true, 'CAT-200 - Revisar painel']]);
  assert.equal(epics[0].tasks[1].phase, 'execucao'); // criada fora do app
  assert.equal(epics[0].tasks[1].timeSpentMin, 30);
  await assert.rejects(q.worklogService.submit({ entries: [{ taskKey: 'QSENSE-50', date: '2026-11-30', start: '08:00', minutes: 60, comment: '' }] }), (e) => e instanceof ScopeError && /agrupadora/.test(e.message));
  const r = await q.worklogService.submit({ entries: [{ taskKey: 'QSENSE-60', date: '2026-11-30', start: '08:00', minutes: 60, comment: '' }] });
  assert.equal(r.results[0].status, 'created');
  assert.deepEqual(r.transitions.map((t) => [t.key, t.status]), [['QSENSE-60', 'moved'], ['BI-1', 'moved']]);
  const [d] = await q.worklogService.describe(['QSENSE-50']);
  assert.equal(d.available, false);
});

// ---------- Fix round 1 ----------
const groupOrphan = (key) => ({ key, fields: {
  summary: 'Apoio órfão', status: { name: 'Aberto' }, assignee: { accountId: ME }, issuetype: { name: 'Tarefa', hierarchyLevel: 0 },
  customfield_10104: { id: '13000', child: { id: '13087', value: 'CAT-87 - Item agrupador (Não será contabilizado)' } },
} });

test('I2: agrupadora sem épico não é tarefa solta; submit e findBySummary recusam', async () => {
  const q = quickSetup();
  q.jira.issues.set('QSENSE-60', groupOrphan('QSENSE-60'));
  const { loose } = await q.worklogService.listTasks();
  assert.deepEqual(loose.map((t) => t.key), []);
  await assert.rejects(q.worklogService.submit({ entries: [{ taskKey: 'QSENSE-60', date: '2026-11-30', start: '08:00', minutes: 60, comment: '' }] }), (e) => e instanceof ScopeError && /agrupadora/.test(e.message));
  assert.equal(posts(q.jira, /\/worklog$/).length, 0);
  const found = await q.worklogService.findBySummary('Apoio órfão');
  assert.equal(found.available, false);
  assert.match(found.error, /agrupadora/);
});

test('I2: CAT-87 não vale como CAT de subtarefa no assistente', () => {
  const cat87 = [...CATALOG, { cat: 'CAT-87', size: 'P', ust: 0, task: 'Item agrupador' }];
  assert.throws(() => parseGroupInput(body({ subtasks: [{ ...body().subtasks[0], cat: 'CAT-87', size: 'P' }, body().subtasks[1]] }), cat87), /Subtarefa 1: .*CAT-87/);
});

test('I3: listTasks e groupStatus não repetem buscas no Jira', async () => {
  const q = quickSetup();
  q.jira.issues.set('QSENSE-50', groupIssue('QSENSE-50', 'BI-1'));
  q.jira.issues.set('QSENSE-60', subIssue('QSENSE-60', 'QSENSE-50'));
  const jqls = () => q.jira.calls.filter((c) => c.path === '/rest/api/3/search/jql').map((c) => c.body.jql);
  const { epics } = await q.worklogService.listTasks();
  assert.deepEqual(epics[0].tasks.map((t) => t.key), ['QSENSE-1', 'QSENSE-60']);
  let list = jqls();
  assert.equal(list.filter((j) => j.includes('parent in (BI-1)')).length, 1, list.join('\n'));
  assert.equal(list.filter((j) => j.includes('parent in (QSENSE-50)')).length, 1, list.join('\n'));
  assert.equal(list.length, 4, list.join('\n')); // épicos, filhos dos épicos, subtarefas, soltas
  q.jira.calls.length = 0;
  await groupStatus(q.ctx, 'BI-1');
  list = jqls();
  assert.equal(list.length, 3, list.join('\n')); // épicos, filhos dos épicos, subtarefas
});

test('M1: grade editada com sábado ou feriado é recusada no servidor', async () => {
  const holidays = { async between() { return new Map([['2026-12-01', 'Feriado local']]); } };
  const q = quickSetup({ holidays });
  await assert.rejects(previewGroup(q.ctx, parse({ worklogs: [{ ...wls()[0], date: '2026-11-28' }, wls()[1]] })), (e) => e instanceof ScopeError && /28\/11\/2026 não é dia útil/.test(e.message));
  await assert.rejects(previewGroup(q.ctx, parse({ worklogs: [wls()[0], { ...wls()[1], date: '2026-12-01' }] })), (e) => e instanceof ScopeError && /01\/12\/2026 não é dia útil \(Feriado local\)/.test(e.message));
});

test('I1: nova tentativa depois de falha usa a agrupadora criada (memória do processo, índice atrasado)', async () => {
  let failSub = true;
  const q = quickSetup({
    failCreate: (b) => (failSub && b.fields.summary === 'Desenvolver - a parte 3' ? 'Campo obrigatório' : null),
    // A busca ainda não mostra a agrupadora nem as subtarefas novas.
    intercept: async (req, next) => {
      const res = await next(req);
      if (req.path === '/rest/api/3/search/jql' && res.ok) return { ...res, data: { ...res.data, issues: res.data.issues.filter((i) => !/^QSENSE-9\d\d$/.test(i.key)) } };
      return res;
    },
  });
  const first = await createGroupFlow(q.ctx, parse({ worklogs: wls() }, { requireWorklogs: true }));
  assert.deepEqual(first.subtasks.map((s) => s.status), ['created', 'error']);
  // A tela volta ao passo 1 e relê a situação: usa a agrupadora criada.
  const st = await groupStatus(q.ctx, 'BI-1');
  assert.equal(st.group.status, 'existing');
  assert.equal(st.group.key, first.group.key);
  assert.deepEqual(st.group.subtasks.map((s) => s.key), ['QSENSE-901']);
  // Repetir só a subtarefa que falhou, na agrupadora existente.
  failSub = false;
  const retry = await createGroupFlow(q.ctx, parse({
    group: { key: first.group.key }, activities: [acts(3)[2]], totalMinutes: 240,
    subtasks: [{ ...body().subtasks[1], activities: [0] }], worklogs: [{ ...wls()[1], sub: 0 }],
  }, { requireWorklogs: true }));
  assert.equal(retry.group.status, 'existing');
  assert.deepEqual(retry.subtasks.map((s) => s.status), ['created']);
  assert.deepEqual(retry.worklogs.map((s) => s.status), ['created']);
  assert.equal(issuePosts(q.jira).filter((c) => c.body.fields.customfield_10104.child.id === '13087').length, 1);
});
