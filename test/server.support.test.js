// Rotas das Tarefas de apoio: CRUD de rascunhos (permissão e visibilidade, antigos modelos), a chave
// "Pode criar modelos" na administração e o wizard da tarefa agrupadora (ações, situação da
// agrupadora, prévia e criação com auditoria support.group).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';
import { quickSetup } from './helpers/quick.js';
import { createCatalogRepo } from '../src/db/catalog.js';

const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 1, task: 'Realizar diagnóstico' },
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico' },
  { cat: 'CAT-166', size: 'P', ust: 8, task: 'Manter script' },
  { cat: 'CAT-200', size: 'G', ust: 5, task: 'Revisar painel' },
];

async function setup(opts) {
  const q = quickSetup(opts);
  const t = await makeTestApp({ services: q.ctx });
  createCatalogRepo(t.db).replaceAll(CATALOG, null);
  const bia = t.login({ email: 'bia@x.com', name: 'Bia' });
  const caio = t.login({ email: 'caio@x.com', name: 'Caio' });
  t.users.setCanCreateTemplates(bia.user.id, true);
  return { ...t, jira: q.jira, bia, caio };
}

const act = (text = 'o script SQL e o documento', action = 'Analisar') => ({ action, text });
const body = (o = {}) => ({ name: 'Meu rascunho', public: false, activities: [act()], ...o });
const audits = (db) => db.prepare('SELECT action, detail FROM audit ORDER BY id').all().map((r) => [r.action, JSON.parse(r.detail)]);

// ---------- rascunhos ----------
test('GET templates: Padrão (rascunho) visível para todos, com atividades, canEdit e último usado', async () => {
  const t = await setup();
  const r = await (await t.caio.json('GET', '/api/support/templates')).json();
  assert.equal(r.canEdit, false);
  assert.equal(r.lastUsedId, 'padrao');
  assert.deepEqual(r.templates.map((x) => [x.id, x.name, x.public, x.system, x.canEdit]), [['padrao', 'Padrão', true, true, false]]);
  assert.deepEqual(r.templates[0].activities.map((a) => a.action), ['Analisar', 'Desenvolver']);
  const admin = await (await t.json('GET', '/api/support/templates')).json();
  assert.equal(admin.canEdit, true);
  assert.equal(admin.templates[0].canEdit, true);
});

test('criar rascunho: só admin ou usuário habilitado; dono é quem cria; auditoria sem textos', async () => {
  const t = await setup();
  assert.equal((await t.caio.json('POST', '/api/support/templates', body())).status, 403);
  const res = await t.bia.json('POST', '/api/support/templates', body());
  assert.equal(res.status, 200);
  const { template } = await res.json();
  assert.equal(template.ownerName, 'Bia');
  assert.equal(template.canEdit, true);
  assert.deepEqual(template.activities, [act()]);
  assert.equal((await t.json('POST', '/api/support/templates', body({ name: 'Do admin', public: true }))).status, 200);
  assert.deepEqual(audits(t.db).map(([a, d]) => [a, d.name, d.activities]), [['support.template.create', 'Meu rascunho', 1], ['support.template.create', 'Do admin', 1]]);
});

test('visibilidade: privado só para o dono e o admin; público para todos', async () => {
  const t = await setup();
  const { template: priv } = await (await t.bia.json('POST', '/api/support/templates', body({ name: 'Privado' }))).json();
  const { template: pub } = await (await t.bia.json('POST', '/api/support/templates', body({ name: 'Público', public: true }))).json();
  const names = async (who) => (await (await who.json('GET', '/api/support/templates')).json()).templates.map((x) => x.name);
  assert.deepEqual(await names(t.caio), ['Padrão', 'Público']);
  assert.deepEqual(await names(t.bia), ['Padrão', 'Privado', 'Público']);
  assert.deepEqual(await names(t), ['Padrão', 'Privado', 'Público']);
  t.users.setCanCreateTemplates(t.caio.user.id, true);
  assert.equal((await t.caio.json('PUT', `/api/support/templates/${priv.id}`, body())).status, 404);
  assert.equal((await t.caio.json('PUT', `/api/support/templates/${pub.id}`, body())).status, 403);
  assert.equal((await t.caio.json('DELETE', `/api/support/templates/${pub.id}`)).status, 403);
});

test('editar/excluir: dono (habilitado) ou admin; rascunho do sistema só o admin e não se exclui', async () => {
  const t = await setup();
  const { template } = await (await t.bia.json('POST', '/api/support/templates', body())).json();
  const put = await t.bia.json('PUT', `/api/support/templates/${template.id}`, body({ name: 'Renomeado', public: true }));
  assert.equal(put.status, 200);
  assert.equal((await put.json()).template.name, 'Renomeado');
  assert.equal((await t.bia.json('PUT', '/api/support/templates/padrao', body())).status, 403);
  t.users.setCanCreateTemplates(t.bia.user.id, false);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 403);
  t.users.setCanCreateTemplates(t.bia.user.id, true);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 200);
  assert.equal((await t.bia.json('DELETE', `/api/support/templates/${template.id}`)).status, 404);
  const del = await t.json('DELETE', '/api/support/templates/padrao');
  assert.equal(del.status, 403);
  assert.match((await del.json()).error, /Padrão.*não pode ser excluído/);
  assert.equal((await t.json('PUT', '/api/support/templates/padrao', body({ name: 'Padrão', public: true }))).status, 200);
});

test('validação do rascunho no servidor (400 com mensagem)', async () => {
  const t = await setup();
  const cases = [
    [body({ name: '' }), /nome/i],
    [body({ name: 'x'.repeat(81) }), /80/],
    [body({ activities: [] }), /60/],
    [body({ activities: Array.from({ length: 61 }, () => act()) }), /60/],
    [body({ activities: [act('o script', 'Dançar')] }), /ação/],
    [body({ activities: [act('curta')] }), /10 a 300/],
    [body({ public: 'sim' }), /público/i],
  ];
  for (const [b, re] of cases) {
    const res = await t.bia.json('POST', '/api/support/templates', b);
    assert.equal(res.status, 400, JSON.stringify(b).slice(0, 80));
    assert.match((await res.json()).error, re);
  }
  assert.equal(audits(t.db).length, 0);
});

test('rotas de rascunho recusam Origin externo', async () => {
  const t = await setup();
  const evil = { Origin: 'https://evil.example' };
  assert.equal((await t.bia.json('POST', '/api/support/templates', body(), evil)).status, 403);
  assert.equal((await t.json('PUT', '/api/support/templates/padrao', body(), evil)).status, 403);
  assert.equal((await t.json('DELETE', '/api/support/templates/padrao', undefined, evil)).status, 403);
  assert.equal(audits(t.db).length, 0);
});

test('admin: liga e desliga "Pode criar modelos"; usuário comum recebe 403', async () => {
  const t = await setup();
  const id = t.caio.user.id;
  assert.equal((await t.caio.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: true })).status, 403);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: 'sim' })).status, 400);
  assert.equal((await t.json('PUT', '/api/admin/usuarios/nao-existe/modelos', { pode: true })).status, 404);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: true })).status, 200);
  assert.equal(t.users.byId(id).canCreateTemplates, true);
  assert.equal((await (await t.caio.json('GET', '/api/support/templates')).json()).canEdit, true);
  assert.equal((await t.json('PUT', `/api/admin/usuarios/${id}/modelos`, { pode: false })).status, 200);
  assert.deepEqual(audits(t.db).map(([a, d]) => [a, d]), [['admin.modelos', { userId: id, pode: true }], ['admin.modelos', { userId: id, pode: false }]]);
});

// ---------- wizard da agrupadora ----------
const acts = [act('a parte 1 do painel de vendas'), act('a parte 2 do painel de vendas', 'Desenvolver'), act('a parte 3 do painel de vendas', 'Testar')];
const groupBody = (o = {}) => ({
  epicKey: 'BI-1', group: { summary: 'Apoio da demanda {EPICO}' }, activities: acts, totalMinutes: 480,
  subtasks: [
    { activities: [0, 1], cat: 'CAT-105', size: 'M', summary: 'Título secreto 1', description: 'Descrição secreta', minutes: 240 },
    { activities: [2], cat: 'CAT-200', size: 'G', summary: 'Título secreto 2', description: '', minutes: 240 },
  ],
  mode: 'percent', percents: { analise: 10, execucao: 50, testes: 30, producao: 10 },
  startDate: '2026-11-30', startTime: '08:00', dailyLimit: 480, ...o,
});
const grid = [
  { sub: 0, date: '2026-11-30', start: '08:00', minutes: 240, comment: 'Comentário secreto' },
  { sub: 1, date: '2026-11-30', start: '12:00', minutes: 240, comment: '' },
];

test('GET /actions: lista fixa de ações e fases, sem exigir token', async () => {
  const t = await setup();
  const r = await (await t.json('GET', '/api/support/actions')).json();
  assert.equal(r.actions.length, 15);
  assert.deepEqual(r.phases.map((p) => p.id), ['analise', 'execucao', 'testes', 'producao']);
  assert.deepEqual(r.defaultPercent, { analise: 10, execucao: 50, testes: 30, producao: 10 });
  assert.equal(r.limits.subtaskMax, 450);
});

test('GET /group: situação da agrupadora; chave inválida 400; épico alheio 400', async () => {
  const t = await setup();
  const r = await t.json('GET', '/api/support/group?epic=BI-1');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).group, { status: 'new' });
  assert.equal((await t.json('GET', '/api/support/group?epic=x')).status, 400);
  assert.equal((await t.json('GET', '/api/support/group?epic=BI-77')).status, 400);
});

test('POST /group/preview: valida (400), propõe a grade e não grava', async () => {
  const t = await setup();
  const bad = await t.json('POST', '/api/support/group/preview', groupBody({ totalMinutes: 2400 }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, '40h exigem 6 subtarefas; você descreveu 3 atividades. Detalhe mais 3 atividades.');
  const res = await t.json('POST', '/api/support/group/preview', groupBody());
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.subtasks.map((s) => s.phase), ['analise', 'testes']);
  assert.deepEqual(out.worklogs.map((w) => [w.sub, w.date, w.start, w.minutes]), [[0, '2026-11-30', '08:00', 240], [1, '2026-11-30', '12:00', 240]]);
  assert.equal(t.jira.calls.filter((c) => c.method === 'POST' && (c.path === '/rest/api/3/issue' || /\/worklog$/.test(c.path))).length, 0);
  assert.equal(audits(t.db).length, 0);
});

test('POST /group: exige a grade; cria tudo, guarda o rascunho usado e audita sem textos', async () => {
  const t = await setup();
  assert.equal((await t.json('POST', '/api/support/group', groupBody())).status, 400);
  const res = await t.json('POST', '/api/support/group', groupBody({ worklogs: grid, templateId: 'padrao' }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.group.status, 'created');
  assert.deepEqual(out.subtasks.map((s) => s.status), ['created', 'created']);
  assert.deepEqual(out.worklogs.map((s) => s.status), ['created', 'created']);
  const [[action, d]] = audits(t.db);
  assert.equal(action, 'support.group');
  assert.deepEqual(d, {
    epic: 'BI-1', group: 'QSENSE-900', groupCreated: true, groupStatus: 'created',
    subtasks: [
      { cat: 'CAT-105', size: 'M', minutes: 240, phase: 'analise', key: 'QSENSE-901', status: 'created' },
      { cat: 'CAT-200', size: 'G', minutes: 240, phase: 'testes', key: 'QSENSE-902', status: 'created' },
    ],
    totalMinutes: 480, worklogs: 2, worklogsCreated: 2,
  });
  assert.doesNotMatch(JSON.stringify(d), /secret/);
});

test('POST /group: Origin externo 403; sobreposição com o Jira 409 sem gravar', async () => {
  const t = await setup();
  assert.equal((await t.json('POST', '/api/support/group', groupBody({ worklogs: grid }), { Origin: 'https://evil.example' })).status, 403);
  t.jira.worklogs['QSENSE-1'] = [{ id: '9', author: { accountId: 'acc-me' }, started: '2026-11-30T09:00:00.000-0300', timeSpentSeconds: 1800 }];
  const res = await t.json('POST', '/api/support/group', groupBody({ worklogs: grid }));
  assert.equal(res.status, 409);
  assert.equal(t.jira.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue').length, 0);
  assert.equal(audits(t.db).length, 0);
});
