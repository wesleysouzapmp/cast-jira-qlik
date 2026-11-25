// Conector MCP: ferramentas de gravação (prévia/confirmação, apontar, alterar/apagar batida,
// regras automáticas) e auditoria via = mcp. Client do SDK por HTTP real contra o app de teste
// com o Jira simulado (um mesmo contexto para todas as chamadas, para o estado persistir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp } from './helpers/app.js';
import { createFakeJira, epicIssue, taskIssue, ME } from './fakeJira.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService } from '../src/worklog/service.js';
import { createPreviewStore } from '../src/mcp/previews.js';

const BASE = 'https://x.atlassian.net';
// 2026-11-25 10:00 em -03:00.
const T0 = Date.parse('2026-11-25T13:00:00.000Z');
const WRITE_TOOLS = ['confirmar_previa', 'apontar', 'alterar_apontamento', 'apagar_apontamento', 'criar_regra', 'alterar_regra', 'pausar_regra', 'excluir_regra'];
const loose = (key, summary) => ({ key, fields: { summary, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: key.split('-')[0] } } });

function jiraCtx() {
  const jira = createFakeJira({
    issues: [
      epicIssue('BI-1', 'Aberto'),
      taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'),
      loose('SIJUD-1', 'Atendimento SIJUD'),
    ],
    worklogs: {
      'SIJUD-1': [
        { id: '7', author: { accountId: ME }, started: '2026-11-04T09:00:00.000-0300', timeSpentSeconds: 3600 },
        { id: '9', author: { accountId: 'outro' }, started: '2026-11-04T10:00:00.000-0300', timeSpentSeconds: 3600 },
      ],
    },
  });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const worklogService = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false } });
  return { jira, ctx: { client: jira.client, supportService, worklogService, favorites: { list: async () => [] } } };
}

// Agendador falso com estado (o real é coberto em worklog.autoscheduler.test.js).
function fakeScheduler() {
  const rules = [{ id: 'r1', key: 'SIJUD-1', summary: null, start: '09:00', minutes: 15, comment: 'Daily', since: '2026-11-03', until: null, enabled: true }];
  const calls = [];
  const find = (id) => {
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0) throw new RangeError('Regra não encontrada.');
    return i;
  };
  return {
    rules, calls,
    status: async () => ({ disabled: false, paused: false, rules: rules.map((r) => ({ ...r, nextRun: null, lastRun: null, doneCount: 0 })), history: [] }),
    addRule: async (input) => { calls.push(['add', input]); const r = { id: `r${rules.length + 1}`, ...input }; rules.push(r); return { ...r, warning: 'aviso de teste' }; },
    updateRule: async (id, input) => { calls.push(['update', id, input]); const i = find(id); rules[i] = { id, ...input }; return rules[i]; },
    removeRule: async (id) => { calls.push(['remove', id]); rules.splice(find(id), 1); },
    setPaused: async () => { throw new Error('não deveria pausar tudo'); },
  };
}

async function setup() {
  const { jira, ctx } = jiraCtx();
  const sched = fakeScheduler();
  const seenUsers = [];
  const clock = { now: T0 };
  const t = await makeTestApp({
    services: () => ctx,
    autoRunner: { schedulerFor: (id) => { seenUsers.push(id); return sched; } },
    mcp: { serverDeps: { now: () => clock.now } },
  });
  t.oauth.saveClient({ client_id: 'cli-1', redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude', token_endpoint_auth_method: 'none' });
  t.tokenFor = (userId = t.user.id) => t.oauth.issueTokens({ clientId: 'cli-1', userId, scopes: [] }).access_token;
  return Object.assign(t, { jira, sched, seenUsers, clock });
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
const writes = (jira) => jira.calls.filter((c) => c.method && c.method !== 'GET' && !c.path.endsWith('/search/jql') && !c.path.endsWith('/bulkfetch'));
const mcpAudit = (t, userId = t.user.id) => t.audit.list(userId, 100).filter((a) => a.via === 'mcp');
const adfText = (doc) => JSON.stringify(doc ?? '');

test('previews: put/take de uso único, por usuário e com validade', () => {
  let now = 1000;
  const store = createPreviewStore({ ttlMs: 60_000, now: () => now });
  const id = store.put(1, { entries: [1] });
  assert.match(id, /^[A-Za-z0-9_-]{16,}$/);
  assert.notEqual(store.put(1, {}), id, 'ids diferentes');
  assert.equal(store.take(2, id), null, 'outro usuário');
  assert.deepEqual(store.take(1, id), { entries: [1] }, 'outro usuário não consome');
  assert.equal(store.take(1, id), null, 'uso único');
  const velho = store.put(1, { x: 1 });
  now += 60_001;
  assert.equal(store.take(1, velho), null, 'vencida');
  assert.equal(store.take(1, 'nao-existe'), null);
  assert.equal(store.take(1, undefined), null);
});

test('anotações: gerar_previa só leitura; gravações com destructiveHint', async () => {
  const t = await setup();
  const client = await connect(t);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  assert.equal(byName.get('gerar_previa')?.annotations?.readOnlyHint, true);
  for (const n of WRITE_TOOLS) {
    const tool = byName.get(n);
    assert.ok(tool, `falta ${n}`);
    assert.equal(tool.annotations?.readOnlyHint, false, n);
    assert.equal(tool.annotations?.destructiveHint, true, n);
    assert.ok(tool.description?.length > 20, `${n} sem descrição`);
  }
  await client.close();
});

test('gerar_previa → confirmar_previa grava no Jira, troca o comentário e move a tarefa de apoio', async () => {
  const t = await setup();
  const client = await connect(t);
  const r = await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '2h' }], de: '2026-11-26', ate: '2026-11-26' });
  assert.ok(!r.isError, r.content[0].text);
  const p = parse(r);
  assert.equal(p.batidas.length, 1);
  assert.deepEqual(
    { indice: p.batidas[0].indice, tarefa: p.batidas[0].tarefa, data: p.batidas[0].data, inicio: p.batidas[0].inicio, minutos: p.batidas[0].minutos },
    { indice: 1, tarefa: 'QSENSE-1', data: '2026-11-26', inicio: '08:00', minutos: 120 },
  );
  assert.ok(p.batidas[0].comentario.length > 0);
  assert.deepEqual(p.faltantes, []);
  assert.deepEqual(p.transicoes.map((x) => x.tarefa).sort(), ['BI-1', 'QSENSE-1']);
  assert.ok(p.previa_id);
  assert.equal(p.expira_em, '2026-11-25 10:30');
  assert.equal(writes(t.jira).length, 0, 'prévia não grava');
  assert.equal(mcpAudit(t).length, 0, 'prévia não audita');

  const c = await call(client, 'confirmar_previa', { previa_id: p.previa_id, comentarios: [{ indice: 1, texto: 'Análise do painel novo' }] });
  assert.ok(!c.isError, c.content[0].text);
  const out = parse(c);
  assert.equal(out.resultados[0].status, 'created');
  const wl = t.jira.worklogs['QSENSE-1'];
  assert.equal(wl.length, 1);
  assert.equal(wl[0].started, '2026-11-26T08:00:00.000-0300');
  assert.match(adfText(wl[0].comment), /Análise do painel novo/);
  assert.equal(t.jira.issues.get('QSENSE-1').fields.status.name, 'Em Execução');
  assert.equal(t.jira.issues.get('BI-1').fields.status.name, 'Em Execução');
  assert.ok(out.transicoes.some((x) => x.tarefa === 'QSENSE-1' && x.status === 'moved'));

  const audit = mcpAudit(t);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'confirmar_previa');
  assert.equal(audit[0].userId, t.user.id);
  assert.ok(!JSON.stringify(audit[0].detail).includes('Análise do painel'), 'sem comentários na auditoria');

  const again = await call(client, 'confirmar_previa', { previa_id: p.previa_id });
  assert.equal(again.isError, true, 'uso único');
  assert.match(again.content[0].text, /Prévia não encontrada/);
  await client.close();
});

test('confirmar_previa com id de outro usuário → Prévia não encontrada, nada gravado', async () => {
  const t = await setup();
  const ana = await connect(t);
  const p = parse(await call(ana, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26' }));
  const bob = t.login({ email: 'bob@x.com', name: 'Bob' });
  const bobClient = await connect(t, t.tokenFor(bob.user.id));
  const r = await call(bobClient, 'confirmar_previa', { previa_id: p.previa_id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Prévia não encontrada ou expirada; gere de novo/);
  assert.equal(writes(t.jira).length, 0);
  assert.equal(mcpAudit(t, bob.user.id).length, 0);
  // A dona ainda consegue confirmar.
  assert.ok(!(await call(ana, 'confirmar_previa', { previa_id: p.previa_id })).isError);
  await ana.close();
  await bobClient.close();
});

test('prévia vencida (30 min) → isError', async () => {
  const t = await setup();
  const client = await connect(t);
  const p = parse(await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26' }));
  t.clock.now = T0 + 30 * 60_000 + 1;
  const r = await call(client, 'confirmar_previa', { previa_id: p.previa_id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Prévia não encontrada ou expirada/);
  assert.equal(writes(t.jira).length, 0);
  await client.close();
});

test('confirmar_previa com apontamento novo no período → conflito, nada gravado', async () => {
  const t = await setup();
  const client = await connect(t);
  const p = parse(await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26' }));
  t.jira.worklogs['SIJUD-1'].push({ id: '50', author: { accountId: ME }, started: '2026-11-26T08:30:00.000-0300', timeSpentSeconds: 1800 });
  const r = await call(client, 'confirmar_previa', { previa_id: p.previa_id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Há apontamentos novos no período; gere a prévia de novo/);
  assert.equal(t.jira.worklogs['QSENSE-1'], undefined);
  assert.equal(mcpAudit(t).length, 0);
  await client.close();
});

test('gerar_previa valida entrada: horas, período e índice de comentário', async () => {
  const t = await setup();
  const client = await connect(t);
  const ruim = await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: 'muito' }], de: '2026-11-26', ate: '2026-11-26' });
  assert.equal(ruim.isError, true);
  assert.match(ruim.content[0].text, /Horas inválidas/);
  const longo = await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-09-01', ate: '2026-11-26' });
  assert.equal(longo.isError, true);
  assert.match(longo.content[0].text, /62 dias/);
  const epico = await call(client, 'gerar_previa', { itens: [{ tarefa: 'BI-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26' });
  assert.equal(epico.isError, true);
  assert.match(epico.content[0].text, /épico/);
  const exp = await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26', expediente: { inicio: '13:00', almoco_de: '12:00' } });
  assert.equal(exp.isError, true);
  assert.match(exp.content[0].text, /Expediente incoerente/);
  const p = parse(await call(client, 'gerar_previa', { itens: [{ tarefa: 'QSENSE-1', horas: '1h' }], de: '2026-11-26', ate: '2026-11-26', expediente: { inicio: '09:00' } }));
  assert.equal(p.batidas[0].inicio, '09:00');
  const idx = await call(client, 'confirmar_previa', { previa_id: p.previa_id, comentarios: [{ indice: 5, texto: 'x' }] });
  assert.equal(idx.isError, true);
  assert.match(idx.content[0].text, /índice 5/i);
  assert.equal(writes(t.jira).length, 0);
  await client.close();
});

test('apontar grava uma batida; com sobreposição dá conflito sem gravar; épico recusado', async () => {
  const t = await setup();
  const client = await connect(t);
  const conflito = await call(client, 'apontar', { tarefa: 'SIJUD-1', data: '2026-11-04', inicio: '09:30', duracao: '1h' });
  assert.equal(conflito.isError, true);
  assert.match(conflito.content[0].text, /sobrep/i);
  assert.equal(writes(t.jira).length, 0);
  assert.equal(mcpAudit(t).length, 0);

  const epico = await call(client, 'apontar', { tarefa: 'BI-1', data: '2026-11-05', inicio: '09:00', duracao: '1h' });
  assert.equal(epico.isError, true);
  assert.match(epico.content[0].text, /épico/);

  const ruim = await call(client, 'apontar', { tarefa: 'SIJUD-1', data: '2026-11-05', inicio: '09:10', duracao: '1h' });
  assert.equal(ruim.isError, true);
  assert.match(ruim.content[0].text, /múltiplo de 15/);

  const r = await call(client, 'apontar', { tarefa: 'SIJUD-1', data: '2026-11-05', inicio: '09:00', duracao: '1h 30m', comentario: 'Suporte ao usuário' });
  assert.ok(!r.isError, r.content[0].text);
  const out = parse(r);
  assert.equal(out.status, 'created');
  assert.ok(out.worklogId);
  const w = t.jira.worklogs['SIJUD-1'].find((x) => x.id === String(out.worklogId));
  assert.equal(w.started, '2026-11-05T09:00:00.000-0300');
  assert.equal(w.timeSpentSeconds, 5400);
  const audit = mcpAudit(t);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'apontar');
  assert.equal(audit[0].detail.tarefa, 'SIJUD-1');
  assert.ok(!JSON.stringify(audit[0].detail).includes('Suporte ao usuário'));
  await client.close();
});

test('alterar_apontamento e apagar_apontamento: só batidas do próprio usuário', async () => {
  const t = await setup();
  const client = await connect(t);
  const alheio = await call(client, 'apagar_apontamento', { id: '9' });
  assert.equal(alheio.isError, true);
  assert.match(alheio.content[0].text, /não encontrado entre os seus/);
  const alheio2 = await call(client, 'alterar_apontamento', { id: '9', inicio: '14:00' });
  assert.equal(alheio2.isError, true);
  assert.equal(writes(t.jira).length, 0);
  assert.ok(t.jira.worklogs['SIJUD-1'].some((w) => w.id === '9'));

  const alt = await call(client, 'alterar_apontamento', { id: '7', inicio: '14:00', comentario: 'Ajustado' });
  assert.ok(!alt.isError, alt.content[0].text);
  assert.equal(parse(alt).status, 'updated');
  const w7 = t.jira.worklogs['SIJUD-1'].find((w) => w.id === '7');
  assert.equal(w7.started, '2026-11-04T14:00:00.000-0300');
  assert.equal(w7.timeSpentSeconds, 3600);

  const del = await call(client, 'apagar_apontamento', { id: '7' });
  assert.ok(!del.isError, del.content[0].text);
  assert.equal(parse(del).status, 'deleted');
  assert.ok(!t.jira.worklogs['SIJUD-1'].some((w) => w.id === '7'));

  assert.deepEqual(mcpAudit(t).map((a) => a.action).sort(), ['alterar_apontamento', 'apagar_apontamento']);
  await client.close();
});

test('regras: criar, alterar (parcial), pausar uma, excluir — sempre no agendador do usuário', async () => {
  const t = await setup();
  const client = await connect(t);
  const c = await call(client, 'criar_regra', { chave: 'SIJUD-1', inicio: '10:00', minutos: 30, comentario: 'Reunião' });
  assert.ok(!c.isError, c.content[0].text);
  const criada = parse(c);
  assert.equal(criada.regra.chave, 'SIJUD-1');
  assert.equal(criada.aviso, 'aviso de teste');
  assert.deepEqual(t.sched.calls[0], ['add', { key: 'SIJUD-1', summary: null, start: '10:00', minutes: 30, comment: 'Reunião', since: undefined, until: null, enabled: true }]);

  const a = await call(client, 'alterar_regra', { id: 'r1', inicio: '09:15' });
  assert.ok(!a.isError, a.content[0].text);
  assert.deepEqual(t.sched.calls[1], ['update', 'r1', { key: 'SIJUD-1', summary: null, start: '09:15', minutes: 15, comment: 'Daily', since: '2026-11-03', until: null, enabled: true }]);

  const p = await call(client, 'pausar_regra', { id: 'r1', pausar: true });
  assert.ok(!p.isError, p.content[0].text);
  assert.equal(t.sched.calls[2][0], 'update');
  assert.equal(t.sched.calls[2][2].enabled, false);
  assert.equal(parse(p).regra.ativa, false);

  const nada = await call(client, 'excluir_regra', { id: 'zzz' });
  assert.equal(nada.isError, true);
  assert.match(nada.content[0].text, /Regra não encontrada/);

  const e = await call(client, 'excluir_regra', { id: 'r1' });
  assert.ok(!e.isError, e.content[0].text);
  assert.deepEqual(t.sched.calls.at(-1), ['remove', 'r1']);

  assert.ok(t.seenUsers.length > 0 && t.seenUsers.every((id) => id === t.user.id));
  assert.deepEqual(mcpAudit(t).map((x) => x.action).sort(), ['alterar_regra', 'criar_regra', 'excluir_regra', 'pausar_regra']);
  await client.close();
});
