// Parte 2: criar tarefa e apontar pelo calendário — espaços onde dá para criar épico e o fluxo
// épico → tarefa → apontamento (runQuick), com as regras de parada entre os passos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME } from './fakeJira.js';
import { quickSetup } from './helpers/quick.js';
import { ConflictError, ScopeError } from '../src/worklog/service.js';
import { runQuick } from '../src/support/quick.js';

const BASE = 'https://x.atlassian.net';

const posts = (jira, path) => jira.calls.filter((c) => c.method === 'POST' && (typeof path === 'string' ? c.path === path : path.test(c.path)));
const newTask = (o = {}) => ({ cat: 'CAT-200', size: 'G', summary: 'Revisar painel da demanda {EPICO}', description: 'Revisão {EPICO}', ...o });
const wl = (o = {}) => ({ date: '2026-11-09', start: '09:00', minutes: 60, comment: 'Revisão do painel', ...o });

test('listSpaces: pagina o project/search e fica só com quem tem tipo épico (hierarchyLevel 1)', async () => {
  const { jira, supportService } = quickSetup();
  const spaces = await supportService.listSpaces();
  assert.deepEqual(spaces, [
    { id: '100', key: 'BI', name: 'Business Intelligence', epicTypeId: '10000' },
    { id: '300', key: 'DADOS', name: 'Dados', epicTypeId: '10100' },
  ]);
  const calls = jira.calls.filter((c) => c.path === '/rest/api/3/project/search');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.action, 'create');
  assert.equal(calls[0].query.expand, 'issueTypes');
  assert.deepEqual(calls.map((c) => Number(c.query.startAt)), [0, 2]);
});

test('tarefa solta: cria sem parent (CAT, tamanho, responsável) e aponta nela', async () => {
  const { jira, ctx, worklogService } = quickSetup();
  const out = await runQuick(ctx, { epic: null, task: newTask({ summary: 'Revisar painel', description: '' }), worklog: wl() });
  assert.equal(out.epic, undefined);
  assert.equal(out.task.status, 'created');
  assert.equal(out.task.key, 'QSENSE-900');
  assert.equal(out.task.url, `${BASE}/browse/QSENSE-900`);
  assert.deepEqual(out.worklog.status, 'created');
  const [create] = posts(jira, '/rest/api/3/issue');
  assert.equal(create.body.fields.parent, undefined);
  assert.equal(create.body.fields.summary, 'Revisar painel');
  assert.equal(create.body.fields.description, undefined);
  assert.deepEqual(create.body.fields.assignee, { accountId: ME });
  assert.deepEqual(create.body.fields.customfield_10104, { id: '11927', child: { id: '12200' } });
  assert.deepEqual(create.body.fields.customfield_10300, { id: '703' });
  assert.deepEqual(create.body.fields.project, { key: 'QSENSE' });
  const [w] = posts(jira, /\/worklog$/);
  assert.equal(w.path, '/rest/api/3/issue/QSENSE-900/worklog');
  assert.equal(w.body.started, '2026-11-09T09:00:00.000-0300');
  assert.equal(w.body.timeSpent, '1h');
  // A tarefa solta aparece depois na lista de tarefas (para apontar nela de novo).
  const { loose } = await worklogService.listTasks();
  assert.deepEqual(loose.map((t) => [t.key, t.cat]), [['QSENSE-900', 'CAT-200']]);
});

test('novo épico: cria no espaço com o tipo épico dele, depois a tarefa com o épico como pai', async () => {
  const { jira, ctx } = quickSetup();
  const out = await runQuick(ctx, { epic: { new: { projectId: '300', summary: 'Nova demanda' } }, task: newTask(), worklog: wl() });
  assert.deepEqual(out.epic, { key: 'DADOS-900', url: `${BASE}/browse/DADOS-900`, status: 'created' });
  assert.equal(out.task.status, 'created');
  assert.equal(out.worklog.status, 'created');
  const [epicReq, taskReq] = posts(jira, '/rest/api/3/issue');
  assert.deepEqual(epicReq.body, { fields: { project: { id: '300' }, issuetype: { id: '10100' }, summary: 'Nova demanda', assignee: { accountId: ME } } });
  assert.deepEqual(taskReq.body.fields.parent, { key: 'DADOS-900' });
  assert.equal(taskReq.body.fields.summary, 'Revisar painel da demanda DADOS-900 - Nova demanda');
});

test('épico existente: precisa ser um dos épicos do usuário; tarefa recebe o pai', async () => {
  const { jira, ctx } = quickSetup();
  await assert.rejects(runQuick(ctx, { epic: { key: 'BI-77' }, task: newTask(), worklog: wl() }), ScopeError);
  assert.equal(posts(jira, '/rest/api/3/issue').length, 0);
  const out = await runQuick(ctx, { epic: { key: 'BI-1' }, task: newTask(), worklog: wl() });
  assert.equal(out.epic.status, 'existing');
  assert.equal(out.epic.key, 'BI-1');
  const [taskReq] = posts(jira, '/rest/api/3/issue');
  assert.deepEqual(taskReq.body.fields.parent, { key: 'BI-1' });
  assert.equal(taskReq.body.fields.summary, 'Revisar painel da demanda BI-1 - Painel de vendas');
});

test('espaço fora da lista de /spaces: recusa sem criar nada', async () => {
  const { jira, ctx } = quickSetup();
  await assert.rejects(runQuick(ctx, { epic: { new: { projectId: '200', summary: 'X' } }, task: newTask(), worklog: wl() }), (e) => e instanceof ScopeError && /espaço/i.test(e.message));
  assert.equal(posts(jira, '/rest/api/3/issue').length, 0);
});

test('épico falhou: nada mais é feito', async () => {
  const { jira, ctx } = quickSetup({ failCreate: (b) => (b.fields.project?.id ? 'Campo Epic Name obrigatório' : null) });
  const out = await runQuick(ctx, { epic: { new: { projectId: '100', summary: 'Nova' } }, task: newTask(), worklog: wl() });
  assert.equal(out.epic.status, 'error');
  assert.match(out.epic.error, /Epic Name/);
  assert.equal(out.task.status, 'skipped');
  assert.equal(out.worklog.status, 'skipped');
  assert.equal(posts(jira, '/rest/api/3/issue').length, 1);
  assert.equal(posts(jira, /\/worklog$/).length, 0);
});

test('tarefa falhou: não aponta e mostra a chave do épico criado', async () => {
  const { jira, ctx } = quickSetup({ failCreate: (b) => (b.fields.project?.key === 'QSENSE' ? 'Componente inválido' : null) });
  const out = await runQuick(ctx, { epic: { new: { projectId: '100', summary: 'Nova' } }, task: newTask(), worklog: wl() });
  assert.equal(out.epic.status, 'created');
  assert.equal(out.epic.key, 'BI-900');
  assert.equal(out.task.status, 'error');
  assert.match(out.task.error, /Componente inválido/);
  assert.equal(out.worklog.status, 'skipped');
  assert.equal(posts(jira, /\/worklog$/).length, 0);
});

test('apontamento falhou: mostra a chave da tarefa criada e o erro', async () => {
  const { ctx } = quickSetup({ failWorklogFor: ['QSENSE-900'] });
  const out = await runQuick(ctx, { epic: null, task: newTask({ summary: 'Revisar' , description: '' }), worklog: wl() });
  assert.equal(out.task.status, 'created');
  assert.equal(out.task.key, 'QSENSE-900');
  assert.equal(out.worklog.status, 'error');
  assert.match(out.worklog.error, /recusado/);
});

test('sobreposição com batida do dia: recusa antes de criar qualquer coisa', async () => {
  const { jira, ctx } = quickSetup();
  await assert.rejects(runQuick(ctx, { epic: null, task: newTask({ summary: 'X', description: '' }), worklog: wl({ start: '08:30' }) }), (e) => e instanceof ConflictError && /QSENSE-1/.test(e.message) && /08:00/.test(e.message));
  assert.equal(posts(jira, '/rest/api/3/issue').length, 0);
});

test('tarefa existente: só aponta', async () => {
  const { jira, ctx } = quickSetup();
  const out = await runQuick(ctx, { epic: null, task: { key: 'QSENSE-1' }, worklog: wl() });
  assert.equal(out.epic, undefined);
  assert.deepEqual(out.task, { key: 'QSENSE-1', url: `${BASE}/browse/QSENSE-1`, status: 'existing' });
  assert.equal(out.worklog.status, 'created');
  assert.equal(posts(jira, '/rest/api/3/issue').length, 0);
  await assert.rejects(runQuick(ctx, { epic: null, task: { key: 'BI-1' }, worklog: wl({ start: '11:00' }) }), ScopeError);
});

// ---------- Fix round 1 ----------
const isLooseJql = (req) => req.path === '/rest/api/3/search/jql' && /parent is EMPTY/.test(req.body?.jql ?? '');

test('createmeta fora do ar: para antes de criar o épico (nada gravado)', async () => {
  const { jira, ctx } = quickSetup({ intercept: (req, next) => (req.path.startsWith('/rest/api/3/issue/createmeta/') ? { status: 503, ok: false, data: { errorMessages: ['down'] } } : next(req)) });
  await assert.rejects(runQuick(ctx, { epic: { new: { projectId: '100', summary: 'Novo' } }, task: newTask(), worklog: wl() }), /down/);
  assert.equal(posts(jira, '/rest/api/3/issue').length, 0);
});

test('erro lançado ao criar a tarefa depois do épico criado: devolve a chave do épico e tarefa com erro', async () => {
  const { jira, ctx } = quickSetup({ intercept: (req, next) => {
    if (req.method === 'POST' && req.path === '/rest/api/3/issue' && req.body?.fields?.project?.key === 'QSENSE') throw new Error('conexão caiu');
    return next(req);
  } });
  const out = await runQuick(ctx, { epic: { new: { projectId: '100', summary: 'Novo' } }, task: newTask(), worklog: wl() });
  assert.equal(out.epic.status, 'created');
  assert.equal(out.epic.key, 'BI-900');
  assert.equal(out.task.status, 'error');
  assert.match(out.task.error, /conexão caiu/);
  assert.equal(out.worklog.status, 'skipped');
  assert.equal(posts(jira, /\/worklog$/).length, 0);
});

test('repetir com o épico recém-criado é aceito mesmo com o índice de busca atrasado', async () => {
  let failTask = true;
  const { ctx, worklogService } = quickSetup({
    failCreate: (b) => (b.fields.project?.key === 'QSENSE' && failTask ? 'Opção desativada' : null),
    // A busca ainda não mostra o épico novo nem a tarefa nova.
    intercept: async (req, next) => {
      const res = await next(req);
      if (req.path === '/rest/api/3/search/jql' && res.ok) return { ...res, data: { ...res.data, issues: res.data.issues.filter((i) => !['BI-900', 'QSENSE-901'].includes(i.key)) } };
      return res;
    },
  });
  const first = await runQuick(ctx, { epic: { new: { projectId: '100', summary: 'Novo' } }, task: newTask(), worklog: wl() });
  assert.equal(first.epic.key, 'BI-900');
  assert.equal(first.task.status, 'error');
  failTask = false;
  const again = await runQuick(ctx, { epic: { key: 'BI-900' }, task: newTask(), worklog: wl() });
  assert.equal(again.epic.status, 'existing');
  assert.equal(again.task.status, 'created');
  assert.equal(again.task.key, 'QSENSE-901');
  assert.equal(again.worklog.status, 'created');
  // O épico e a tarefa novos aparecem na lista de tarefas.
  const { epics } = await worklogService.listTasks();
  const e = epics.find((x) => x.key === 'BI-900');
  assert.ok(e, 'épico novo fora da lista');
  assert.deepEqual(e.tasks.map((t) => t.key), ['QSENSE-901']);
});

test('tarefa recém-criada num épico (índice atrasado) é aceita como tarefa existente depois que o apontamento falhou', async () => {
  let failWl = true;
  const { ctx } = quickSetup({
    intercept: async (req, next) => {
      if (failWl && req.method === 'POST' && /\/worklog$/.test(req.path)) return { status: 400, ok: false, data: { errorMessages: ['recusado'] } };
      const res = await next(req);
      if (req.path === '/rest/api/3/search/jql' && res.ok) return { ...res, data: { ...res.data, issues: res.data.issues.filter((i) => i.key !== 'QSENSE-900') } };
      return res;
    },
  });
  const first = await runQuick(ctx, { epic: { key: 'BI-1' }, task: newTask(), worklog: wl() });
  assert.equal(first.task.key, 'QSENSE-900');
  assert.equal(first.worklog.status, 'error');
  failWl = false;
  const again = await runQuick(ctx, { epic: null, task: { key: 'QSENSE-900' }, worklog: wl() });
  assert.equal(again.worklog.status, 'created');
});

test('tarefa existente: só as tarefas de apoio do usuário (não qualquer issue)', async () => {
  const { ctx, jira } = quickSetup();
  jira.issues.set('SIJUD-1', { key: 'SIJUD-1', fields: { summary: 'Atendimento', status: { name: 'Aberto' }, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, project: { key: 'SIJUD' } } });
  await assert.rejects(runQuick(ctx, { epic: null, task: { key: 'SIJUD-1' }, worklog: wl() }), (e) => e instanceof ScopeError && /SIJUD-1/.test(e.message));
  assert.equal(posts(jira, /\/worklog$/).length, 0);
});

test('busca de tarefas soltas com erro não derruba lista, envio nem o novo apontamento', async () => {
  const { ctx, worklogService } = quickSetup({ intercept: (req, next) => (isLooseJql(req) ? { status: 400, ok: false, data: { errorMessages: ['JQL inválida'] } } : next(req)) });
  const { epics, loose } = await worklogService.listTasks();
  assert.deepEqual(epics.map((e) => e.key), ['BI-1']);
  assert.deepEqual(loose, []);
  const r = await worklogService.submit({ entries: [{ taskKey: 'QSENSE-1', date: '2026-11-10', start: '08:00', minutes: 60, comment: '' }] });
  assert.equal(r.results[0].status, 'created');
  const out = await runQuick(ctx, { epic: null, task: { key: 'QSENSE-1' }, worklog: wl() });
  assert.equal(out.worklog.status, 'created');
});
