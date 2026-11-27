// Rotas da Parte 2: GET /api/support/spaces (espaço padrão salvo) e POST /api/support/quick
// (validação no servidor, resposta por passo, padrão do espaço só com épico criado e auditoria).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/app.js';
import { createCatalogRepo } from '../src/db/catalog.js';
import { quickSetup } from './helpers/quick.js';

const CATALOG = [
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico' },
  { cat: 'CAT-200', size: 'G', ust: 5, task: 'Revisar painel' },
];

async function setup(opts) {
  const q = quickSetup(opts);
  const t = await makeTestApp({ services: q.ctx });
  createCatalogRepo(t.db).replaceAll(CATALOG, null);
  return { ...t, jira: q.jira };
}
const audits = (db, action) => db.prepare('SELECT action, detail FROM audit WHERE action = ? ORDER BY id').all(action).map((r) => JSON.parse(r.detail));
const body = (o = {}) => ({
  epic: null,
  task: { cat: 'CAT-200', size: 'G', summary: 'Revisar painel', description: '' },
  worklog: { date: '2026-11-09', start: '09:00', minutes: 60, comment: 'Revisão' },
  ...o,
});
const creates = (jira) => jira.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue');

test('GET /spaces: só espaços com épico, sem padrão salvo no começo', async () => {
  const t = await setup();
  const res = await t.json('GET', '/api/support/spaces');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { spaces: [{ id: '100', key: 'BI', name: 'Business Intelligence' }, { id: '300', key: 'DADOS', name: 'Dados' }], defaultId: null });
});

test('POST /quick com novo épico: grava o espaço como padrão (só quando o épico é criado)', async () => {
  const t = await setup();
  const res = await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '300', summary: ' Nova demanda ' } }, task: { cat: 'cat-200', size: 'g', summary: 'Revisar {EPICO}' } }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.epic.status, 'created');
  assert.equal(out.task.status, 'created');
  assert.equal(out.worklog.status, 'created');
  assert.equal(creates(t.jira)[0].body.fields.summary, 'Nova demanda');
  const spaces = await (await t.json('GET', '/api/support/spaces')).json();
  assert.equal(spaces.defaultId, '300');
  // Outro usuário não herda o padrão.
  const other = t.login({ email: 'bia@x.com' });
  assert.equal((await (await other.json('GET', '/api/support/spaces')).json()).defaultId, null);
});

test('POST /quick: épico que falha não muda o espaço padrão', async () => {
  const t = await setup({ failCreate: (b) => (b.fields.project?.id === '100' ? 'Epic Name é obrigatório' : null) });
  await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '300', summary: 'A' } }, worklog: { date: '2026-11-09', start: '10:00', minutes: 30 } }));
  const res = await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '100', summary: 'B' } }, worklog: { date: '2026-11-09', start: '11:00', minutes: 30 } }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.epic.status, 'error');
  assert.equal(out.task.status, 'skipped');
  assert.equal((await (await t.json('GET', '/api/support/spaces')).json()).defaultId, '300');
});

test('POST /quick: validação no servidor (400) e nada é criado', async () => {
  const t = await setup();
  const task = (o) => ({ task: { cat: 'CAT-200', size: 'G', summary: 'Revisar', description: '', ...o } });
  const worklog = (o) => ({ worklog: { date: '2026-11-09', start: '09:00', minutes: 60, comment: '', ...o } });
  const cases = [
    [{ epic: { key: 'BI-1' }, task: { key: 'QSENSE-1' } }, /já tem pai|tarefa existente/i],
    [{ epic: { new: { projectId: '300', summary: 'X' } }, task: { key: 'QSENSE-1' } }, /já tem pai|tarefa existente/i],
    [{ task: { key: 'nao-e-chave' } }, /chave/i],
    [task({ cat: 'CAT-999' }), /CAT-999/],
    [task({ size: 'P' }), /não tem tamanho P/],
    [task({ size: '' }), /tamanho/i],
    [task({ summary: '' }), /título/i],
    [task({ summary: 'x'.repeat(256) }), /255/],
    [task({ description: 'x'.repeat(2001) }), /2000/],
    [task({ summary: 'Revisar {EPICO}' }), /épico/i],
    [{ epic: { key: 'bi 1' } }, /épico/i],
    [{ epic: { new: { projectId: '300', summary: '' } } }, /resumo do épico/i],
    [{ epic: { new: { projectId: '300', summary: 'x'.repeat(256) } } }, /255/],
    [{ epic: { new: { projectId: 'abc', summary: 'X' } } }, /espaço/i],
    [{ epic: 'BI-1' }, /épico/i],
    [worklog({ start: '09:10' }), /15 min/],
    [worklog({ minutes: 10 }), /duração/i],
    [worklog({ minutes: 495 }), /duração/i],
    [worklog({ start: '23:00', minutes: 120 }), /meia-noite/],
    [worklog({ comment: 'x'.repeat(1001) }), /1000/],
    [worklog({ date: '2026-13-40' }), /data/i],
    [{ worklog: undefined }, /apontamento/i],
    [{ task: undefined }, /tarefa/i],
  ];
  for (const [o, re] of cases) {
    const res = await t.json('POST', '/api/support/quick', body(o));
    assert.equal(res.status, 400, JSON.stringify(o).slice(0, 100));
    assert.match((await res.json()).error, re, JSON.stringify(o).slice(0, 100));
  }
  assert.equal(creates(t.jira).length, 0);
  assert.equal(audits(t.db, 'support.quick').length, 0);
});

test('POST /quick: épico que não é do usuário e espaço fora da lista = 400', async () => {
  const t = await setup();
  assert.equal((await t.json('POST', '/api/support/quick', body({ epic: { key: 'BI-77' } }))).status, 400);
  assert.equal((await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '200', summary: 'X' } } }))).status, 400);
  assert.equal(creates(t.jira).length, 0);
});

test('POST /quick: sobreposição com o Jira = 409 sem criar nada', async () => {
  const t = await setup();
  const res = await t.json('POST', '/api/support/quick', body({ worklog: { date: '2026-11-09', start: '08:30', minutes: 30 } }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /QSENSE-1/);
  assert.equal(creates(t.jira).length, 0);
});

test('POST /quick: auditoria support.quick com chaves, CAT/tamanho, data e minutos, sem textos', async () => {
  const t = await setup();
  await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '300', summary: 'Resumo secreto' } }, task: { cat: 'CAT-200', size: 'G', summary: 'Título secreto', description: 'Descrição secreta' }, worklog: { date: '2026-11-09', start: '09:00', minutes: 45, comment: 'Comentário secreto' } }));
  const [d] = audits(t.db, 'support.quick');
  assert.deepEqual(d, {
    epic: 'DADOS-900', epicCreated: true, projectId: '300', group: 'QSENSE-901', groupCreated: true, task: 'QSENSE-902', taskCreated: true, cat: 'CAT-200', size: 'G',
    date: '2026-11-09', start: '09:00', minutes: 45, status: { epic: 'created', group: 'created', task: 'created', worklog: 'created' },
  });
  assert.doesNotMatch(JSON.stringify(d), /secret/);
  // Tarefa existente também é auditada.
  await t.json('POST', '/api/support/quick', body({ task: { key: 'QSENSE-1' }, worklog: { date: '2026-11-09', start: '10:00', minutes: 15 } }));
  const [, d2] = audits(t.db, 'support.quick');
  assert.equal(d2.task, 'QSENSE-1');
  assert.equal(d2.taskCreated, false);
  assert.equal(d2.cat, null);
  assert.equal(d2.epic, null);
});

test('POST /quick recusa Origin externo', async () => {
  const t = await setup();
  assert.equal((await t.json('POST', '/api/support/quick', body(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal(creates(t.jira).length, 0);
});

test('POST /quick: erro lançado na tarefa depois do épico criado → 200, chave do épico, espaço padrão e auditoria', async () => {
  const q = quickSetup({ intercept: (req, next) => {
    if (req.method === 'POST' && req.path === '/rest/api/3/issue' && req.body?.fields?.issuetype?.id === '10003') throw new Error('conexão caiu');
    return next(req);
  } });
  const t = await makeTestApp({ services: q.ctx });
  createCatalogRepo(t.db).replaceAll(CATALOG, null);
  const res = await t.json('POST', '/api/support/quick', body({ epic: { new: { projectId: '300', summary: 'Nova' } } }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.epic.key, 'DADOS-900');
  assert.equal(out.task.status, 'error');
  assert.equal((await (await t.json('GET', '/api/support/spaces')).json()).defaultId, '300');
  const [d] = audits(t.db, 'support.quick');
  assert.equal(d.epic, 'DADOS-900');
  assert.deepEqual(d.status, { epic: 'created', group: 'created', task: 'error', worklog: 'skipped' });
});

test('POST /quick: CAT-87 (item da agrupadora) não vale como CAT da tarefa nova (400, nada criado)', async () => {
  const t = await setup();
  createCatalogRepo(t.db).replaceAll([...CATALOG, { cat: 'CAT-87', size: 'P', ust: 0, task: 'Item agrupador' }], null);
  const res = await t.json('POST', '/api/support/quick', body({ task: { cat: 'CAT-87', size: 'P', summary: 'Apoio', description: '' } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /CAT-87 é o item da agrupadora/);
  assert.equal(creates(t.jira).length, 0);
});
