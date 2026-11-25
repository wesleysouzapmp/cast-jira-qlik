// Conector MCP: ferramentas de leitura, chamadas pelo Client do SDK por HTTP real (Bearer
// emitido direto no repositório OAuth) contra o app de teste com o Jira simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp } from './helpers/app.js';
import { createFakeJira, epicIssue, taskIssue, ME } from './fakeJira.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService } from '../src/worklog/service.js';

const BASE = 'https://x.atlassian.net';
// 2026-11-25 10:00 em -03:00.
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const READ_TOOLS = ['listar_tarefas', 'buscar_tarefa', 'meus_apontamentos', 'indicadores', 'listar_regras'];
const loose = (key, summary) => ({ key, fields: { summary, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: key.split('-')[0] } } });

function jiraCtx() {
  const jira = createFakeJira({
    issues: [
      epicIssue('BI-1', 'Aberto'),
      taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'),
      loose('SIJUD-10', 'Reunião diária 10/2026'),
      loose('SIJUD-11', 'Reunião diária 11/2026'),
      loose('SIJUD-1', 'Atendimento SIJUD'),
    ],
    worklogs: {
      'SIJUD-1': [
        { id: '7', author: { accountId: ME }, started: '2026-11-04T09:00:00.000-0300', timeSpentSeconds: 3600, comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Atendimento' }] }] } },
        { id: '8', author: { accountId: ME }, started: '2026-10-22T09:00:00.000-0300', timeSpentSeconds: 1800 },
        { id: '9', author: { accountId: 'outro' }, started: '2026-11-04T10:00:00.000-0300', timeSpentSeconds: 3600 },
      ],
    },
  });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const worklogService = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false } });
  return { client: jira.client, supportService, worklogService, favorites: { list: async () => ['SIJUD-1'] } };
}

const holidayProvider = { between: async () => new Map([['2026-11-02', 'Finados'], ['2026-11-20', 'Consciência Negra']]) };
const scheduler = {
  status: async () => ({
    disabled: false, paused: false,
    rules: [{ id: 'a1b2c3d4', key: 'SIJUD-1', summary: null, start: '09:00', minutes: 15, comment: 'Daily', since: '2026-11-03', until: null, enabled: true, lastRun: { date: '2026-11-24', status: 'created' }, nextRun: '2026-11-26 09:00', doneCount: 3 }],
    history: [],
  }),
};

async function setup({ services = () => jiraCtx(), ...opts } = {}) {
  const t = await makeTestApp({ services, holidayProvider, scheduler, mcp: { serverDeps: { now: () => NOW } }, ...opts });
  t.oauth.saveClient({ client_id: 'cli-1', redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude', token_endpoint_auth_method: 'none' });
  t.tokenFor = (userId = t.user.id) => t.oauth.issueTokens({ clientId: 'cli-1', userId, scopes: [] }).access_token;
  return t;
}

async function connect(t, accessToken = t.tokenFor()) {
  const client = new Client({ name: 'teste', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const parse = (r) => JSON.parse(r.content[0].text);

test('tools/list traz as ferramentas de leitura com readOnlyHint', async () => {
  const t = await setup();
  const client = await connect(t);
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  for (const n of READ_TOOLS) {
    assert.ok(names.includes(n), `falta ${n}`);
    const tool = tools.find((x) => x.name === n);
    assert.equal(tool.annotations?.readOnlyHint, true, n);
    assert.ok(tool.description?.length > 20, `${n} sem descrição`);
  }
  await client.close();
});

test('listar_tarefas: épicos com tarefas de apoio, favoritos e IA', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'listar_tarefas');
  assert.ok(!r.isError, r.content[0].text);
  const out = parse(r);
  assert.deepEqual(out.epicos.map((e) => [e.key, e.tasks.map((x) => x.key)]), [['BI-1', ['QSENSE-1']]]);
  assert.deepEqual(out.favoritos.map((f) => f.key), ['SIJUD-1']);
  assert.equal(out.iaHabilitada, false);
  await client.close();
});

test('buscar_tarefa por texto com {MM/AAAA} acha a SIJUD do mês; por chave também', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'buscar_tarefa', { texto: 'Reunião diária {MM/AAAA}' });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(parse(r), { key: 'SIJUD-11', summary: 'Reunião diária 11/2026', status: 'Aberto', url: `${BASE}/browse/SIJUD-11` });

  const k = await call(client, 'buscar_tarefa', { chave: 'SIJUD-10' });
  assert.equal(parse(k).summary, 'Reunião diária 10/2026');

  const nada = await call(client, 'buscar_tarefa', { chave: 'NOPE-9' });
  assert.equal(nada.isError, true);
  assert.match(nada.content[0].text, /não encontrada/);

  const ambos = await call(client, 'buscar_tarefa', { chave: 'SIJUD-10', texto: 'x' });
  assert.equal(ambos.isError, true);
  const nenhum = await call(client, 'buscar_tarefa', {});
  assert.equal(nenhum.isError, true);
  await client.close();
});

test('meus_apontamentos: lista do período e recusa mais de 62 dias', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'meus_apontamentos', { de: '2026-11-01', ate: '2026-11-30' });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(parse(r).apontamentos, [
    { id: '7', tarefa: 'SIJUD-1', titulo: 'Atendimento SIJUD', data: '2026-11-04', inicio: '09:00', minutos: 60, comentario: 'Atendimento' },
  ]);

  const longo = await call(client, 'meus_apontamentos', { de: '2026-09-01', ate: '2026-11-30' });
  assert.equal(longo.isError, true);
  assert.match(longo.content[0].text, /62 dias/);

  const ruim = await call(client, 'meus_apontamentos', { de: '01/11/2026', ate: '2026-11-30' });
  assert.equal(ruim.isError, true);
  await client.close();
});

test('indicadores: fechamento AAAA-MM usa 21 do mês anterior a 20 do mês, com feriados', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'indicadores', { fechamento: '2026-11' });
  assert.ok(!r.isError, r.content[0].text);
  const out = parse(r);
  assert.equal(out.de, '2026-10-21');
  assert.equal(out.ate, '2026-11-20');
  // 21/10–20/11: 23 dias úteis menos Finados (02/11 é segunda) e 20/11 (sexta) = 21.
  assert.equal(out.diasUteis, 21);
  assert.equal(out.diasTrabalhados, 2);
  assert.equal(out.diasATrabalhar, 0);
  assert.equal(out.previstasMin, 21 * 480);
  assert.equal(out.executadasMin, 90);
  assert.equal(out.saldoMin, 21 * 480 - 90);
  assert.equal(out.executadas, '01:30');

  const livre = await call(client, 'indicadores', { de: '2026-11-23', ate: '2026-11-27' });
  const l = parse(livre);
  assert.equal(l.diasUteis, 5);
  assert.equal(l.diasATrabalhar, 3, 'hoje (25) em diante sem batida');

  const errado = await call(client, 'indicadores', { fechamento: '2026-13' });
  assert.equal(errado.isError, true);
  await client.close();
});

test('listar_regras: regras com próxima e última execução', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'listar_regras');
  assert.ok(!r.isError, r.content[0].text);
  const out = parse(r);
  assert.equal(out.pausado, false);
  assert.equal(out.regras[0].id, 'a1b2c3d4');
  assert.equal(out.regras[0].proximaExecucao, '2026-11-26 09:00');
  assert.deepEqual(out.regras[0].ultimaExecucao, { date: '2026-11-24', status: 'created' });
  await client.close();
});

test('usuário sem token do Jira recebe a mensagem orientando', async () => {
  const t = await setup({ services: () => ({ missing: true }) });
  const client = await connect(t);
  const r = await call(client, 'listar_tarefas');
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, `Configure seu token do Jira em Minha conta: ${t.base}/conta.html`);
  // listar_regras não depende do Jira.
  assert.ok(!(await call(client, 'listar_regras')).isError);
  await client.close();
});

test('token do Jira inválido: erro pedindo para atualizar', async () => {
  const t = await setup({ services: () => ({ ...jiraCtx(), secrets: { tokenStatus: 'invalid' } }) });
  const client = await connect(t);
  const r = await call(client, 'meus_apontamentos', { de: '2026-11-01', ate: '2026-11-30' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /inválido/);
  assert.ok(r.content[0].text.includes(`${t.base}/conta.html`));
  await client.close();
});

test('usuário desativado depois de emitir o token → 401 no /mcp', async () => {
  const t = await setup();
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  const token = t.tokenFor(bob.user.id);
  const client = await connect(t, token);
  assert.ok((await client.listTools()).tools.length >= 5);
  await client.close();
  t.users.setActive(bob.user.id, false);
  const res = await fetch(`${t.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  await assert.rejects(connect(t, token));
});
