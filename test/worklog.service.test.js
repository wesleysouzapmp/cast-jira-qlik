import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeJira, epicIssue, taskIssue, ME } from './fakeJira.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService, ConflictError, ScopeError } from '../src/worklog/service.js';
import { DEFAULT_SCHEDULE } from '../src/worklog/time.js';

const BASE = 'https://x.atlassian.net';
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function setup(opts = {}) {
  const issues = opts.issues ?? [
    epicIssue('BI-1', 'Aberto'),
    taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto', 3600),
    taskIssue('QSENSE-2', 'BI-1', 'implementacao', 'Concluído'),
    epicIssue('BI-2', 'Em Homologação'),
    taskIssue('QSENSE-3', 'BI-2', 'analise', 'Aberto'),
  ];
  const jira = createFakeJira({ ...opts, issues });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const ai = opts.ai ?? { enabled: false, async generate() { throw new Error('off'); } };
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai, rng: seeded() });
  return { jira, svc };
}

const posts = (calls) => calls.filter((c) => c.method === 'POST' && /\/worklog$/.test(c.path));
const entry = (taskKey, date, start, minutes, comment = 'ok') => ({ taskKey, date, start, minutes, comment });

test('listTasks agrupa tarefas por épico', async () => {
  const { svc } = setup();
  const r = await svc.listTasks();
  assert.equal(r.aiEnabled, false);
  assert.deepEqual(r.epics.map((e) => e.key), ['BI-1', 'BI-2']);
  const [t1, t2] = r.epics[0].tasks;
  assert.deepEqual([t1.key, t1.model, t1.status, t1.timeSpentMin], ['QSENSE-1', 'analise', 'Aberto', 60]);
  assert.equal(t2.model, 'implementacao');
  assert.equal(t1.url, BASE + '/browse/QSENSE-1');
});

test('busy filtra autor e período e converte fuso para -03:00', async () => {
  const { svc } = setup({ worklogs: {
    'QSENSE-1': [
      { id: '1', author: { accountId: ME }, started: '2026-11-04T23:30:00.000+0000', timeSpentSeconds: 3600 },
      { id: '2', author: { accountId: 'outro' }, started: '2026-11-04T10:00:00.000-0300', timeSpentSeconds: 3600 },
      { id: '3', author: { accountId: ME }, started: '2026-11-20T10:00:00.000-0300', timeSpentSeconds: 3600 },
    ],
  } });
  const r = await svc.busy('2026-11-03', '2026-11-07');
  assert.deepEqual(r, [{ date: '2026-11-04', startMin: 20 * 60 + 30, endMin: 21 * 60 + 30 }]);
});

test('preview gera lançamentos com comentário e transições previstas', async () => {
  const { svc } = setup({ worklogs: { 'QSENSE-2': [{ id: '1', author: { accountId: ME }, started: '2026-11-09T09:00:00.000-0300', timeSpentSeconds: 3600 }] } });
  const r = await svc.preview({ items: [{ taskKey: 'QSENSE-1', minutes: 120 }, { taskKey: 'QSENSE-3', minutes: 30 }], from: '2026-11-09', to: '2026-11-09', schedule: DEFAULT_SCHEDULE });
  assert.deepEqual(r.entries.map((e) => `${e.taskKey} ${e.start} ${e.minutes} ${e.timeSpent}`), ['QSENSE-1 08:00 60 1h', 'QSENSE-1 10:00 60 1h', 'QSENSE-3 11:00 30 30m']);
  assert.ok(r.entries.every((e) => e.comment.length > 10));
  assert.ok(r.entries[0].comment.includes('BI-1 - Painel BI-1'));
  assert.deepEqual(r.transitions, [
    { key: 'QSENSE-1', from: 'Aberto', to: 'Em Execução' },
    { key: 'BI-1', from: 'Aberto', to: 'Em Execução' },
    { key: 'QSENSE-3', from: 'Aberto', to: 'Em Execução' },
  ]);
});

test('preview recusa tarefa fora do escopo', async () => {
  const { svc } = setup();
  await assert.rejects(svc.preview({ items: [{ taskKey: 'QSENSE-999', minutes: 60 }], from: '2026-11-09', to: '2026-11-09', schedule: DEFAULT_SCHEDULE }), ScopeError);
});

test('submit grava worklogs e muda status de tarefa e épico', async () => {
  const { svc, jira } = setup();
  const r = await svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 90, 'Levantamento')] });
  assert.deepEqual(r.results.map((x) => x.status), ['created']);
  const p = posts(jira.calls)[0];
  assert.equal(p.path, '/rest/api/3/issue/QSENSE-1/worklog');
  assert.deepEqual(p.query, { notifyUsers: 'false' });
  assert.equal(p.body.timeSpent, '1h 30m');
  assert.equal(p.body.started, '2026-11-09T08:00:00.000-0300');
  assert.equal(p.body.comment.content[0].content[0].text, 'Levantamento');
  assert.equal(p.body.properties, undefined);
  assert.equal(jira.issues.get('QSENSE-1').fields.status.name, 'Em Execução');
  assert.equal(jira.issues.get('BI-1').fields.status.name, 'Em Execução');
  assert.deepEqual(r.transitions.map((t) => [t.key, t.status]), [['QSENSE-1', 'moved'], ['BI-1', 'moved']]);
});

test('submit não muda épico em homologação nem tarefa concluída', async () => {
  const { svc, jira } = setup();
  const r = await svc.submit({ entries: [entry('QSENSE-3', '2026-11-09', '08:00', 60), entry('QSENSE-2', '2026-11-09', '09:00', 60)] });
  assert.equal(jira.issues.get('BI-2').fields.status.name, 'Em Homologação');
  assert.equal(jira.issues.get('QSENSE-2').fields.status.name, 'Concluído');
  assert.deepEqual(r.transitions.map((t) => [t.key, t.status]), [['QSENSE-3', 'moved'], ['BI-2', 'unchanged'], ['QSENSE-2', 'unchanged'], ['BI-1', 'moved']]);
});

test('submit recusa sobreposição com 409 e não grava nada', async () => {
  const { svc, jira } = setup({ worklogs: { 'QSENSE-2': [{ id: '1', author: { accountId: ME }, started: '2026-11-09T08:30:00.000-0300', timeSpentSeconds: 1800 }] } });
  await assert.rejects(svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 60)] }), ConflictError);
  assert.equal(posts(jira.calls).length, 0);
});

test('submit recusa lançamentos sobrepostos entre si', async () => {
  const { svc } = setup();
  await assert.rejects(svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 60), entry('QSENSE-3', '2026-11-09', '08:30', 60)] }), ConflictError);
});

test('submit recusa tarefa fora do escopo', async () => {
  const { svc, jira } = setup();
  await assert.rejects(svc.submit({ entries: [entry('QSENSE-999', '2026-11-09', '08:00', 60)] }), ScopeError);
  assert.equal(posts(jira.calls).length, 0);
});

test('submit continua após erro num worklog e não move tarefa sem sucesso', async () => {
  const { svc, jira } = setup({ failWorklogFor: ['QSENSE-1'] });
  const r = await svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 60), entry('QSENSE-3', '2026-11-09', '09:00', 60)] });
  assert.deepEqual(r.results.map((x) => x.status), ['error', 'created']);
  assert.match(r.results[0].error, /recusado/);
  assert.equal(jira.issues.get('QSENSE-1').fields.status.name, 'Aberto');
  assert.equal(jira.issues.get('BI-1').fields.status.name, 'Aberto');
});

test('transição ausente vira aviso e mantém worklog', async () => {
  const { svc } = setup({ transitionsTo: { 'Em Execução': false, Pausado: true } });
  const r = await svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 60)] });
  assert.equal(r.results[0].status, 'created');
  assert.equal(r.transitions[0].status, 'error');
  assert.match(r.transitions[0].error, /Em Execução/);
});

test('dois submits simultâneos: o segundo recebe 409', async () => {
  const { svc, jira } = setup({ delayMs: 5 });
  const e = [entry('QSENSE-1', '2026-11-09', '08:00', 60)];
  const [a, b] = await Promise.allSettled([svc.submit({ entries: e }), svc.submit({ entries: e })]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.ok(b.reason instanceof ConflictError);
  assert.equal(posts(jira.calls).length, 1);
});

test('aiComments usa o contexto das tarefas', async () => {
  let got;
  const ai = { enabled: true, async generate(entries, ctx) { got = ctx; return entries.map(() => 'IA'); } };
  const { svc } = setup({ ai });
  const r = await svc.aiComments([{ taskKey: 'QSENSE-1', model: 'analise', date: '2026-11-09', minutes: 60 }]);
  assert.deepEqual(r, { comments: ['IA'] });
  assert.equal(got['QSENSE-1'].epicKey, 'BI-1');
});

test('submit não duplica quando o índice de busca ainda não vê o que foi gravado', async () => {
  const { svc, jira } = setup({ indexLag: true });
  const e = [entry('QSENSE-1', '2026-11-09', '08:00', 60)];
  await svc.submit({ entries: e });
  await assert.rejects(svc.submit({ entries: e }), ConflictError);
  await assert.rejects(svc.submit({ entries: [entry('QSENSE-3', '2026-11-09', '08:30', 60)] }), ConflictError);
  assert.equal(posts(jira.calls).length, 1);
});

test('busy acha apontamento perto da meia-noite quando a JQL usa outro fuso', async () => {
  // 22:00 -03:00 de 09/11 = 01:00Z de 10/11: uma JQL em UTC limitada a 09/11 não acharia a issue.
  const { svc } = setup({ searchTz: 'UTC', worklogs: { 'QSENSE-2': [{ id: '1', author: { accountId: ME }, started: '2026-11-09T22:00:00.000-0300', timeSpentSeconds: 3600 }] } });
  assert.deepEqual(await svc.busy('2026-11-09', '2026-11-09'), [{ date: '2026-11-09', startMin: 22 * 60, endMin: 23 * 60 }]);
});

test('myWorklogs devolve detalhes dos seus apontamentos no fuso -03:00', async () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Levantamento' }] }] };
  const { svc } = setup({ worklogs: {
    'QSENSE-1': [
      { id: '7', author: { accountId: ME }, started: '2026-11-09T11:00:00.000+0000', timeSpentSeconds: 5400, comment: adf },
      { id: '8', author: { accountId: 'outro' }, started: '2026-11-09T12:00:00.000-0300', timeSpentSeconds: 3600 },
    ],
    'QSENSE-2': [{ id: '9', author: { accountId: ME }, started: '2026-11-10T13:00:00.000-0300', timeSpentSeconds: 900 }],
  } });
  const r = await svc.myWorklogs('2026-11-09', '2026-11-10');
  assert.deepEqual(r, [
    { id: '7', issueKey: 'QSENSE-1', issueSummary: 'Analise da demanda BI-1', url: BASE + '/browse/QSENSE-1', date: '2026-11-09', start: '08:00', minutes: 90, comment: 'Levantamento' },
    { id: '9', issueKey: 'QSENSE-2', issueSummary: 'Implementação da demanda BI-1', url: BASE + '/browse/QSENSE-2', date: '2026-11-10', start: '13:00', minutes: 15, comment: '' },
  ]);
});

test('myWorklogs mostra o que acabou de ser gravado mesmo com o índice atrasado', async () => {
  const { svc } = setup({ indexLag: true });
  await svc.submit({ entries: [entry('QSENSE-1', '2026-11-09', '08:00', 60, 'Novo')] });
  const r = await svc.myWorklogs('2026-11-09', '2026-11-09');
  assert.deepEqual(r.map((x) => [x.issueKey, x.start, x.minutes, x.comment]), [['QSENSE-1', '08:00', 60, 'Novo']]);
});

test('preview não coloca batidas em feriados', async () => {
  const issues = [epicIssue('BI-1', 'Aberto'), taskIssue('QSENSE-1', 'BI-1', 'analise')];
  const jira = createFakeJira({ issues });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const holidays = { async between() { return new Map([['2026-11-09', 'Feriado X']]); } };
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false }, rng: seeded(), holidays });
  const r = await svc.preview({ items: [{ taskKey: 'QSENSE-1', minutes: 60 }], from: '2026-11-09', to: '2026-11-10', schedule: DEFAULT_SCHEDULE });
  assert.deepEqual(r.entries.map((e) => e.date), ['2026-11-10']);
});

test('preview com perDay gera as horas em cada dia útil e informa dias sem espaço', async () => {
  const { svc } = setup({ worklogs: { 'QSENSE-2': [{ id: '1', author: { accountId: ME }, started: '2026-11-10T08:00:00.000-0300', timeSpentSeconds: 7 * 3600 + 1800 }] } });
  const r = await svc.preview({ items: [{ taskKey: 'QSENSE-1', minutes: 60, perDay: true }], from: '2026-11-09', to: '2026-11-11', schedule: DEFAULT_SCHEDULE });
  assert.deepEqual(r.entries.map((e) => `${e.date} ${e.start} ${e.minutes}`), ['2026-11-09 08:00 60', '2026-11-10 15:30 30', '2026-11-11 08:00 60']);
  assert.deepEqual(r.unallocated, [{ taskKey: 'QSENSE-1', minutes: 30, date: '2026-11-10' }]);
  assert.ok(r.entries.every((e) => e.comment.length > 10));
});

// ---- batch (manutenção de batidas) ----
const mine = (id, started, minutes, text = 'c') => ({ id, author: { accountId: ME }, started, timeSpentSeconds: minutes * 60, comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
function batchSetup(extra = {}) {
  return setup({ ...extra, worklogs: {
    'QSENSE-1': [mine('7', '2026-11-09T08:00:00.000-0300', 60), mine('8', '2026-11-09T10:00:00.000-0300', 60)],
    'QSENSE-2': [mine('9', '2026-11-09T13:00:00.000-0300', 60), { id: '10', author: { accountId: 'outro' }, started: '2026-11-09T14:00:00.000-0300', timeSpentSeconds: 3600 }],
    ...(extra.worklogs ?? {}),
  } });
}
const upd = (id, issueKey, date, start, minutes, comment = 'novo', targetKey) => ({ id, issueKey, action: 'update', date, start, minutes, comment, ...(targetKey ? { targetKey } : {}) });
const writes = (calls) => calls.filter((c) => ['PUT', 'DELETE'].includes(c.method) || (c.method === 'POST' && /\/worklog$/.test(c.path)));

test('batch altera batida com PUT', async () => {
  const { svc, jira } = batchSetup();
  const r = await svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '11:00', 90, 'Ajustado')] });
  assert.deepEqual(r.results, [{ id: '7', status: 'updated' }]);
  const put = jira.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/rest/api/3/issue/QSENSE-1/worklog/7');
  assert.deepEqual(put.query, { notifyUsers: 'false' });
  assert.equal(put.body.timeSpent, '1h 30m');
  assert.equal(put.body.started, '2026-11-09T11:00:00.000-0300');
  assert.equal(put.body.comment.content[0].content[0].text, 'Ajustado');
});

test('batch com comentário vazio envia documento vazio no PUT e omite no POST', async () => {
  const { svc, jira } = batchSetup();
  await svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '08:00', 60, '  '), upd('8', 'QSENSE-1', '2026-11-09', '10:00', 60, '', 'QSENSE-3')] });
  assert.deepEqual(jira.calls.find((c) => c.method === 'PUT').body.comment, { type: 'doc', version: 1, content: [{ type: 'paragraph' }] });
  const post = jira.calls.find((c) => c.method === 'POST' && /\/worklog$/.test(c.path));
  assert.equal('comment' in post.body, false);
});

test('batch exclui e a batida some de myWorklogs mesmo com índice atrasado', async () => {
  const { svc, jira } = batchSetup({ indexLag: true });
  const r = await svc.batch({ changes: [{ id: '8', issueKey: 'QSENSE-1', action: 'delete' }] });
  assert.deepEqual(r.results, [{ id: '8', status: 'deleted' }]);
  assert.equal(jira.calls.find((c) => c.method === 'DELETE').path, '/rest/api/3/issue/QSENSE-1/worklog/8');
  const ids = (await svc.myWorklogs('2026-11-09', '2026-11-09')).map((w) => w.id);
  assert.ok(!ids.includes('8'));
});

test('batch move de tarefa: cria no destino e depois apaga a original', async () => {
  const { svc, jira } = batchSetup();
  const r = await svc.batch({ changes: [upd('8', 'QSENSE-1', '2026-11-09', '10:00', 60, 'movida', 'QSENSE-3')] });
  assert.equal(r.results[0].status, 'moved');
  assert.ok(r.results[0].newId);
  const w = writes(jira.calls).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(w, ['POST /rest/api/3/issue/QSENSE-3/worklog', 'DELETE /rest/api/3/issue/QSENSE-1/worklog/8']);
  assert.equal(jira.issues.get('QSENSE-3').fields.status.name, 'Em Execução');
  assert.deepEqual(r.transitions.map((t) => [t.key, t.status]), [['QSENSE-3', 'moved'], ['BI-2', 'unchanged']]);
});

test('batch move com falha ao apagar a original vira duplicated', async () => {
  const { svc } = batchSetup({ failDeleteFor: ['8'] });
  const r = await svc.batch({ changes: [upd('8', 'QSENSE-1', '2026-11-09', '10:00', 60, 'x', 'QSENSE-3')] });
  assert.equal(r.results[0].status, 'duplicated');
  assert.match(r.results[0].error, /não pôde ser apagada/);
});

test('batch recusa batida de outro autor sem escrever nada', async () => {
  const { svc, jira } = batchSetup();
  await assert.rejects(svc.batch({ changes: [{ id: '10', issueKey: 'QSENSE-2', action: 'delete' }] }), ScopeError);
  assert.equal(writes(jira.calls).length, 0);
});

test('batch recusa destino fora do escopo', async () => {
  const { svc, jira } = batchSetup();
  await assert.rejects(svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '08:00', 60, 'x', 'SIJUD-1')] }), ScopeError);
  assert.equal(writes(jira.calls).length, 0);
});

test('batch recusa sobreposição sem escrever nada', async () => {
  const { svc, jira } = batchSetup();
  await assert.rejects(svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '09:30', 60)] }), ConflictError);
  assert.equal(writes(jira.calls).length, 0);
});

test('batch aceita mover para horário que só fica livre porque a própria batida sai', async () => {
  const { svc } = batchSetup();
  const r = await svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '08:30', 60)] });
  assert.equal(r.results[0].status, 'updated');
});

test('batch troca a data para um dia livre', async () => {
  const { svc, jira } = batchSetup();
  await svc.batch({ changes: [upd('9', 'QSENSE-2', '2026-11-10', '08:00', 60)] });
  assert.equal(jira.calls.find((c) => c.method === 'PUT').body.started, '2026-11-10T08:00:00.000-0300');
});

test('batch considera trocas entre batidas do mesmo lote', async () => {
  const { svc } = batchSetup();
  // 7 (08–09) vai para 10:00 e 8 (10–11) vai para 08:00: só funciona se o lote for avaliado inteiro.
  const r = await svc.batch({ changes: [upd('7', 'QSENSE-1', '2026-11-09', '10:00', 60), upd('8', 'QSENSE-1', '2026-11-09', '08:00', 60)] });
  assert.deepEqual(r.results.map((x) => x.status), ['updated', 'updated']);
});

test('mesmo lote de exclusão enviado duas vezes não apaga nada a mais', async () => {
  const { svc, jira } = batchSetup();
  const changes = [{ id: '8', issueKey: 'QSENSE-1', action: 'delete' }];
  await svc.batch({ changes });
  await assert.rejects(svc.batch({ changes }), ScopeError);
  assert.equal(jira.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('batch preserva duração e início fora dos blocos de 15 quando não foram alterados', async () => {
  const { svc, jira } = batchSetup({ worklogs: { 'QSENSE-3': [mine('30', '2026-11-11T09:07:00.000-0300', 20)] } });
  const r = await svc.batch({ changes: [upd('30', 'QSENSE-3', '2026-11-11', '09:07', 20, 'só o comentário')] });
  assert.equal(r.results[0].status, 'updated');
  const put = jira.calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.timeSpent, '20m');
  assert.equal(put.body.started, '2026-11-11T09:07:00.000-0300');
});

test('batch exige blocos de 15 quando duração ou início mudam', async () => {
  const { svc, jira } = batchSetup({ worklogs: { 'QSENSE-3': [mine('30', '2026-11-11T09:07:00.000-0300', 20)] } });
  await assert.rejects(svc.batch({ changes: [upd('30', 'QSENSE-3', '2026-11-11', '09:07', 25)] }), ScopeError);
  await assert.rejects(svc.batch({ changes: [upd('30', 'QSENSE-3', '2026-11-11', '09:08', 20)] }), ScopeError);
  assert.equal(writes(jira.calls).length, 0);
});

test('batch recusa batida alterada em outro lugar desde que o painel abriu', async () => {
  const { svc, jira } = batchSetup();
  jira.worklogs['QSENSE-1'].find((w) => w.id === '7').updated = '2026-11-10T10:00:00.000-0300';
  await assert.rejects(svc.batch({ changes: [{ ...upd('7', 'QSENSE-1', '2026-11-09', '08:00', 60, 'x'), updated: '2026-11-09T09:00:00.000-0300' }] }), ConflictError);
  assert.equal(writes(jira.calls).length, 0);
  const ok = await svc.batch({ changes: [{ ...upd('7', 'QSENSE-1', '2026-11-09', '08:00', 60, 'x'), updated: '2026-11-10T10:00:00.000-0300' }] });
  assert.equal(ok.results[0].status, 'updated');
});

test('myWorklogs devolve updated para a checagem de concorrência', async () => {
  const { svc, jira } = batchSetup();
  jira.worklogs['QSENSE-1'].find((w) => w.id === '7').updated = '2026-11-10T10:00:00.000-0300';
  const w = (await svc.myWorklogs('2026-11-09', '2026-11-09')).find((x) => x.id === '7');
  assert.equal(w.updated, '2026-11-10T10:00:00.000-0300');
});

test('batida duplicada por falha ao apagar não pode ser movida de novo', async () => {
  const { svc, jira } = batchSetup({ failDeleteFor: ['8'] });
  const move = [upd('8', 'QSENSE-1', '2026-11-09', '10:00', 60, 'x', 'QSENSE-3')];
  assert.equal((await svc.batch({ changes: move })).results[0].status, 'duplicated');
  await assert.rejects(svc.batch({ changes: [upd('8', 'QSENSE-1', '2026-11-09', '15:00', 60, 'x', 'QSENSE-3')] }), ScopeError);
  assert.equal(jira.calls.filter((c) => c.method === 'POST' && /\/worklog$/.test(c.path)).length, 1);
});
