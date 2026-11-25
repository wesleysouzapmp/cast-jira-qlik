// Isolamento ponta a ponta: o usuário B (com o próprio cookie e o próprio token MCP) nunca lê nem
// altera os dados do usuário A. Usa o contexto real (createContextFactory), o agendador real
// (createAutoRunner), repositórios reais e um Jira simulado com estado por usuário. Cada tentativa
// confere o status/isError E que os dados de A (regras, favoritos, apontamentos no Jira de A,
// auditoria de A, chamadas ao Jira de A) ficaram exatamente como estavam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp } from './helpers/app.js';
import { createFakeJira, epicIssue, taskIssue, ME } from './fakeJira.js';
import { createContextFactory } from '../src/context.js';
import { createAutoRunner } from '../src/worklog/autoRunner.js';
import { favoritesFor, autoStoreFor } from '../src/db/userData.js';

const BASE = 'https://x.atlassian.net';
// 2026-11-25 10:00 em -03:00.
const T0 = Date.parse('2026-11-25T13:00:00.000Z');
const loose = (key, summary) => ({ key, fields: { summary, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: key.split('-')[0] } } });
const holidays = { between: async () => new Map() };

async function setup() {
  const jiraA = createFakeJira({
    issues: [epicIssue('BI-1', 'Aberto'), taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'), loose('SIJUD-1', 'Atendimento A'), loose('SIJUD-2', 'Outra A')],
    worklogs: {
      'SIJUD-1': [{ id: '7', author: { accountId: ME }, started: '2026-11-04T09:00:00.000-0300', timeSpentSeconds: 3600 }],
      'SIJUD-2': [{ id: '8', author: { accountId: ME }, started: '2026-11-05T09:00:00.000-0300', timeSpentSeconds: 1800 }],
    },
  });
  const jiraB = createFakeJira({
    issues: [epicIssue('BI-2', 'Aberto'), taskIssue('QSENSE-2', 'BI-2', 'analise', 'Aberto'), loose('SIJUD-1', 'Atendimento B'), loose('SIJUD-3', 'Tarefa de B')],
    worklogs: { 'SIJUD-3': [{ id: '31', author: { accountId: ME }, started: '2026-11-06T09:00:00.000-0300', timeSpentSeconds: 3600 }] },
  });
  const jiras = { 'ana@jira.com': jiraA, 'bob@jira.com': jiraB };
  const makeClient = ({ email }) => jiras[email].client;
  let runner;
  const t = await makeTestApp({
    contexts: (db, users) => createContextFactory({ db, users, baseUrl: BASE, holidays, makeClient, makeAi: () => ({ enabled: false }) }),
    autoRunner: { schedulerFor: (id) => runner.schedulerFor(id) },
    mcp: { serverDeps: { now: () => T0 } },
  });
  runner = createAutoRunner({ db: t.db, users: t.users, contexts: t.contexts, holidays, now: () => T0, log: () => {}, audit: t.audit });
  t.oauth.saveClient({ client_id: 'cli-1', redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude', token_endpoint_auth_method: 'none' });
  const tokenFor = (userId) => t.oauth.issueTokens({ clientId: 'cli-1', userId, scopes: [] }).access_token;

  const A = t.user;
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  const B = bob.user;
  for (const [u, email] of [[A, 'ana@jira.com'], [B, 'bob@jira.com']]) {
    t.users.setJira(u.id, { email, token: `tok-${u.id}`, accountId: ME });
    t.users.markToken(u.id, 'ok');
  }

  // Dados de A: duas regras, dois favoritos; B tem o favorito SIJUD-1 também (o dele).
  const rule = await runner.schedulerFor(A.id).addRule({ key: 'SIJUD-1', start: '09:00', minutes: 15, comment: 'Daily' });
  const rule2 = await runner.schedulerFor(A.id).addRule({ key: 'SIJUD-2', start: '10:00', minutes: 30, comment: 'Outra' });
  await favoritesFor(t.db, A.id).add('SIJUD-1');
  await favoritesFor(t.db, A.id).add('SIJUD-2');
  await favoritesFor(t.db, B.id).add('SIJUD-1');
  await runner.schedulerFor(B.id).addRule({ key: 'SIJUD-3', start: '11:00', minutes: 15, comment: 'Regra de B' });

  async function connect(userId) {
    const client = new Client({ name: 'teste', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokenFor(userId)}` } } }));
    return client;
  }
  const mcpA = await connect(A.id);
  const mcpB = await connect(B.id);

  // Retrato completo do que pertence a A (estado + trilha + chamadas ao Jira de A).
  const snapA = () => structuredClone({
    rules: t.db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY rowid').all(A.id),
    settings: t.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(A.id) ?? null,
    favorites: t.db.prepare('SELECT key FROM favorites WHERE user_id = ? ORDER BY rowid').all(A.id),
    worklogs: jiraA.worklogs,
    issues: [...jiraA.issues.entries()],
    audit: t.audit.list(A.id, 1000),
    jiraCalls: jiraA.calls.length,
  });
  const snapB = () => structuredClone({
    rules: t.db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY rowid').all(B.id),
    favorites: t.db.prepare('SELECT key FROM favorites WHERE user_id = ? ORDER BY rowid').all(B.id),
    worklogs: jiraB.worklogs,
    audit: t.audit.list(B.id, 1000),
  });
  return { t, A, B, bob, jiraA, jiraB, rule, rule2, mcpA, mcpB, snapA, snapB, runner };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const parse = (r) => JSON.parse(r.content[0].text);
const jsonOf = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test('web: PUT e DELETE em /api/auto/rules/<id de A> → 4xx, regra e auditoria de A intactas', async () => {
  const { t, bob, rule, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();

  const put = await jsonOf(await bob.json('PUT', `/api/auto/rules/${rule.id}`, { key: 'SIJUD-3', start: '15:00', minutes: 60, comment: 'sequestrada', since: '2026-11-25', until: null, enabled: false }));
  assert.ok(put.status >= 400 && put.status < 500, `PUT status ${put.status}`);
  assert.match(put.body.error, /Regra não encontrada/);

  const del = await jsonOf(await bob.json('DELETE', `/api/auto/rules/${rule.id}`));
  assert.ok(del.status >= 400 && del.status < 500, `DELETE status ${del.status}`);
  assert.match(del.body.error, /Regra não encontrada/);

  assert.deepEqual(snapA(), antes, 'dados de A inalterados');
  assert.deepEqual(snapB(), antesB, 'B também não ganhou nem perdeu nada');

  // Controle positivo: A ainda altera e exclui a própria regra, e isso é auditado para A.
  const ok = await jsonOf(await t.json('PUT', `/api/auto/rules/${rule.id}`, { key: 'SIJUD-1', start: '09:30', minutes: 15, comment: 'Daily', since: '2026-11-25', until: null, enabled: true }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(t.audit.list(t.user.id, 100).filter((a) => a.action === 'auto.rule.update').length, 1);
});

test('web: DELETE /api/worklog/favorites/<chave de A> só afeta os favoritos de B', async () => {
  const { t, A, B, bob, snapA } = await setup();
  const antes = snapA();
  const favB = () => t.db.prepare('SELECT key FROM favorites WHERE user_id = ? ORDER BY rowid').all(B.id).map((r) => r.key);

  // Chave que só A tem: sem efeito nenhum em A (e B continua com o dele).
  const so = await jsonOf(await bob.json('DELETE', '/api/worklog/favorites/SIJUD-2'));
  assert.equal(so.status, 200);
  assert.deepEqual(favB(), ['SIJUD-1']);
  assert.deepEqual(snapA(), antes, 'favoritos de A intactos');

  // Chave que os dois têm: remove só a de B.
  const ambos = await jsonOf(await bob.json('DELETE', '/api/worklog/favorites/SIJUD-1'));
  assert.equal(ambos.status, 200);
  assert.deepEqual(favB(), []);
  assert.deepEqual(snapA(), antes, 'SIJUD-1 de A continua favorito');
  assert.deepEqual(await favoritesFor(t.db, A.id).list(), ['SIJUD-1', 'SIJUD-2']);
});

test('web: /api/worklog/batch com o worklog de A (update, delete e mover) não toca o Jira nem os dados de A', async () => {
  const { bob, jiraB, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();
  const writesB = () => jiraB.calls.filter((c) => c.method && c.method !== 'GET' && !c.path.endsWith('/search/jql') && !c.path.endsWith('/bulkfetch')).length;

  // Mesma chave nos dois Jiras (SIJUD-1) e chave só do Jira de A (SIJUD-2), com ids de A (7, 8).
  const tentativas = [
    [{ id: '7', issueKey: 'SIJUD-1', action: 'delete' }],
    [{ id: '8', issueKey: 'SIJUD-2', action: 'delete' }],
    [{ id: '7', issueKey: 'SIJUD-1', action: 'update', date: '2026-11-04', start: '14:00', minutes: 60, comment: 'sequestrado' }],
    [{ id: '7', issueKey: 'SIJUD-1', action: 'update', date: '2026-11-04', start: '09:00', minutes: 60, comment: '', targetKey: 'QSENSE-1' }],
  ];
  for (const changes of tentativas) {
    const r = await jsonOf(await bob.json('POST', '/api/worklog/batch', { changes }));
    if (r.status === 200) {
      assert.ok(r.body.results.every((x) => x.status === 'error' || x.status === 'skipped' || x.status === 'conflict'), `resultado inesperado: ${JSON.stringify(r.body.results)}`);
    } else {
      assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    }
    assert.deepEqual(snapA(), antes, `A intacto após ${JSON.stringify(changes[0])}`);
    assert.equal(writesB(), 0, 'nada gravado nem no Jira de B');
  }
  assert.deepEqual(snapB().worklogs, antesB.worklogs);
});

test('MCP: confirmar_previa com o previa_id de A → isError, nada gravado, e A ainda confirma depois', async () => {
  const { t, A, B, mcpA, mcpB, jiraA, jiraB, snapA, snapB } = await setup();
  const p = parse(await call(mcpA, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26' }));
  const antes = snapA();
  const antesB = snapB();
  const jiraBCalls = jiraB.calls.length;

  const r = await call(mcpB, 'confirmar_previa', { previa_id: p.previa_id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Prévia não encontrada ou expirada/);
  assert.deepEqual(snapA(), antes);
  assert.deepEqual(snapB(), antesB);
  assert.equal(jiraB.calls.length, jiraBCalls, 'B nem chegou a falar com o Jira');

  // A prévia não foi consumida por B: A confirma e grava só no Jira de A.
  const ok = await call(mcpA, 'confirmar_previa', { previa_id: p.previa_id });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(jiraA.worklogs['QSENSE-1'].length, 1);
  assert.equal(jiraB.worklogs['QSENSE-2'], undefined);
  assert.equal(t.audit.list(A.id, 100).filter((a) => a.via === 'mcp' && a.action === 'confirmar_previa').length, 1);
  assert.equal(t.audit.list(B.id, 100).filter((a) => a.via === 'mcp').length, 0);
});

test('MCP: excluir_regra, pausar_regra e alterar_regra com o id de A → isError, regra de A intacta', async () => {
  const { rule, mcpB, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();

  for (const [name, args] of [
    ['excluir_regra', { id: rule.id }],
    ['pausar_regra', { id: rule.id, pausar: true }],
    ['alterar_regra', { id: rule.id, inicio: '15:00', minutos: 60 }],
  ]) {
    const r = await call(mcpB, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /Regra não encontrada/, name);
    assert.deepEqual(snapA(), antes, `A intacto após ${name}`);
    assert.deepEqual(snapB(), antesB, `B intacto após ${name}`);
  }
});

test('MCP: apagar_apontamento e alterar_apontamento com ids de A → isError, Jira de A sem chamadas', async () => {
  const { mcpB, jiraB, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();

  for (const [name, args] of [
    ['apagar_apontamento', { id: '7' }],
    ['alterar_apontamento', { id: '7', inicio: '14:00' }],
    ['apagar_apontamento', { id: '8' }],
  ]) {
    const r = await call(mcpB, name, args);
    assert.equal(r.isError, true, `${name} ${args.id}`);
    assert.match(r.content[0].text, /não encontrado entre os seus/);
    assert.deepEqual(snapA(), antes);
  }
  assert.deepEqual(snapB(), antesB);
  assert.ok(!jiraB.calls.some((c) => c.method && c.method !== 'GET' && !c.path.endsWith('/search/jql') && !c.path.endsWith('/bulkfetch')), 'nenhuma gravação no Jira de B');
});

test('MCP: alterar_apontamento de B movendo para tarefa que não é tarefa de apoio dele → isError, nada gravado', async () => {
  const { mcpB, jiraB, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();
  const writesB = () => jiraB.calls.filter((c) => c.method && c.method !== 'GET' && !c.path.endsWith('/search/jql') && !c.path.endsWith('/bulkfetch')).length;

  // A batida 31 é de B. Destinos inválidos: tarefa de apoio de A (QSENSE-1, inexistente no Jira de B),
  // tarefa avulsa dele (SIJUD-1) e épico dele (BI-2): nenhum é tarefa de apoio de B.
  for (const alvo of ['QSENSE-1', 'SIJUD-1', 'BI-2']) {
    const r = await call(mcpB, 'alterar_apontamento', { id: '31', tarefa: alvo });
    assert.equal(r.isError, true, alvo);
    assert.match(r.content[0].text, /fora do escopo/, alvo);
    assert.equal(writesB(), 0, `destino ${alvo}: nada gravado`);
    assert.deepEqual(snapB(), antesB, `destino ${alvo}: dados de B intactos`);
    assert.deepEqual(snapA(), antes);
  }
  assert.ok(jiraB.worklogs['SIJUD-3'].some((w) => w.id === '31'), 'a batida continua onde estava');
});

test('MCP: tokens distintos enxergam só os próprios dados (listar_regras e meus_apontamentos)', async () => {
  const { rule, mcpA, mcpB } = await setup();
  const regrasB = parse(await call(mcpB, 'listar_regras'));
  assert.ok(!JSON.stringify(regrasB).includes(rule.id), 'B não vê a regra de A');
  const regrasA = parse(await call(mcpA, 'listar_regras'));
  assert.ok(JSON.stringify(regrasA).includes(rule.id));
  const apB = JSON.stringify(parse(await call(mcpB, 'meus_apontamentos', { de: '2026-11-01', ate: '2026-11-30' })));
  assert.ok(apB.includes('SIJUD-3'));
  assert.ok(!apB.includes('"7"') && !apB.includes('SIJUD-2'), 'B não vê os apontamentos de A');
});

test('repositório: writeRules de B com id de regra de A lança e a linha de A não muda', async () => {
  const { t, A, B, rule, snapA, snapB } = await setup();
  const antes = snapA();
  const antesB = snapB();

  await assert.rejects(
    autoStoreFor(t.db, B.id).writeRules({ paused: true, rules: [{ id: rule.id, key: 'SIJUD-3', summary: null, start: '16:00', minutes: 45, comment: 'sequestrada', since: '2026-11-25', until: null, enabled: false }] }),
    /pertence a outro usuário/,
  );
  assert.deepEqual(snapA(), antes, 'regra de A e configurações de A intactas');
  assert.deepEqual(snapB(), antesB, 'a transação foi desfeita: B também não mudou');
  assert.equal(t.db.prepare('SELECT auto_paused AS p FROM user_settings WHERE user_id = ?').get(B.id)?.p ?? 0, 0, 'pausa de B não gravada');

  // B enviando uma lista sem a regra de A não apaga a de A (só apaga as dele).
  await autoStoreFor(t.db, B.id).writeRules({ paused: false, rules: [] });
  assert.deepEqual(snapA().rules, antes.rules);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE user_id = ?').get(B.id).n, 0, 'as dele foram removidas');

  // Log: um "feito" de B com a regra de A não grava nada na regra de A.
  await autoStoreFor(t.db, B.id).writeLog({ done: { [`${rule.id}|2026-11-25`]: { status: 'created', at: new Date(T0).toISOString() } }, history: [] });
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rule_done WHERE rule_id = ?').get(rule.id).n, 0);
  assert.deepEqual(snapA().rules, antes.rules);
});
