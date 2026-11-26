import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeJira, epicIssue, taskIssue } from './fakeJira.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService, ScopeError } from '../src/worklog/service.js';
import { DEFAULT_SCHEDULE } from '../src/worklog/time.js';

const BASE = 'https://x.atlassian.net';
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const loose = (key, summary, status = 'Aberto') => ({ key, fields: { summary, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: status }, project: { key: key.split('-')[0] } } });

function setup({ ai } = {}) {
  const issues = [
    epicIssue('BI-1', 'Aberto'),
    taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'),
    loose('SIJUD-1', 'Atendimento SIJUD'),
    { key: 'BI-77', fields: { summary: 'Épico de outra pessoa', issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: 'Aberto' }, project: { key: 'BI' }, assignee: { accountId: 'outro' } } },
  ];
  const jira = createFakeJira({ issues });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: ai ?? { enabled: false }, rng: seeded() });
  return { jira, svc };
}
const day = { from: '2026-11-09', to: '2026-11-09', schedule: DEFAULT_SCHEDULE };

test('describe: devolve resumo e status; marca inexistente e épico como indisponíveis', async () => {
  const { svc } = setup();
  const r = await svc.describe(['SIJUD-1', 'NOPE-9', 'BI-77']);
  assert.deepEqual(r[0], { key: 'SIJUD-1', summary: 'Atendimento SIJUD', status: 'Aberto', url: `${BASE}/browse/SIJUD-1`, available: true });
  assert.equal(r[1].available, false);
  assert.match(r[1].error, /não encontrada|sem acesso/);
  assert.equal(r[2].available, false);
  assert.match(r[2].error, /épico/i);
});

test('preview aceita tarefa avulsa com frases genéricas e sem transição', async () => {
  const { svc } = setup();
  const r = await svc.preview({ ...day, items: [{ taskKey: 'SIJUD-1', minutes: 60 }, { taskKey: 'QSENSE-1', minutes: 60 }] });
  // tarefas de apoio primeiro, avulsas depois
  assert.deepEqual(r.entries.map((e) => `${e.taskKey} ${e.start}`), ['QSENSE-1 08:00', 'SIJUD-1 09:00']);
  assert.ok(r.entries[1].comment.includes('SIJUD-1 - Atendimento SIJUD'), r.entries[1].comment);
  assert.equal(r.entries[1].model, 'avulsa');
  assert.ok(!r.transitions.some((t) => t.key === 'SIJUD-1'));
  assert.ok(r.transitions.some((t) => t.key === 'QSENSE-1'));
});

test('preview e submit recusam chave inexistente e épico', async () => {
  const { svc, jira } = setup();
  await assert.rejects(svc.preview({ ...day, items: [{ taskKey: 'NOPE-9', minutes: 60 }] }), ScopeError);
  await assert.rejects(svc.preview({ ...day, items: [{ taskKey: 'BI-77', minutes: 60 }] }), ScopeError);
  await assert.rejects(svc.submit({ entries: [{ taskKey: 'NOPE-9', date: '2026-11-09', start: '08:00', minutes: 60, comment: 'x' }] }), ScopeError);
  assert.ok(!jira.calls.some((c) => c.method === 'POST' && /\/worklog$/.test(c.path)));
});

test('submit grava na avulsa sem mexer no status dela', async () => {
  const { svc, jira } = setup();
  const r = await svc.submit({ entries: [{ taskKey: 'SIJUD-1', date: '2026-11-09', start: '08:00', minutes: 60, comment: 'Atendimento' }] });
  assert.equal(r.results[0].status, 'created');
  assert.deepEqual(r.transitions, []);
  assert.ok(!jira.calls.some((c) => /\/transitions$/.test(c.path)));
});

test('aiComments aceita avulsa e manda o resumo da tarefa como contexto', async () => {
  let seen;
  const ai = { enabled: true, async generate(entries, ctx) { seen = { entries, ctx }; return entries.map(() => 'texto'); } };
  const { svc } = setup({ ai });
  await svc.aiComments([{ taskKey: 'SIJUD-1', date: '2026-11-09', start: '08:00', minutes: 60, comment: '' }]);
  assert.equal(seen.entries[0].model, 'avulsa');
  assert.equal(seen.ctx['SIJUD-1'].taskSummary, 'Atendimento SIJUD');
});

test('tarefa de apoio sem épico, atribuída ao usuário, entra na lista e no escopo (sem transição)', async () => {
  const solta = { key: 'QSENSE-50', fields: { summary: 'Revisar painel', status: { name: 'Aberto' }, issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 }, timespent: 1800, customfield_10104: { id: '11927', child: { id: '12200', value: 'CAT-200 - Revisar painel' } } } };
  const jira = createFakeJira({ issues: [epicIssue('BI-1', 'Aberto'), taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'), solta] });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false }, rng: seeded() });
  const { epics, loose } = await svc.listTasks();
  assert.deepEqual(epics.map((e) => e.tasks.map((t) => t.key)), [['QSENSE-1']]);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].key, 'QSENSE-50');
  assert.equal(loose[0].cat, 'CAT-200');
  assert.equal(loose[0].label, 'CAT-200 - Revisar painel');
  assert.equal(loose[0].timeSpentMin, 30);
  const search = jira.calls.find((c) => c.path === '/rest/api/3/search/jql' && /parent is EMPTY/.test(c.body.jql));
  assert.match(search.body.jql, /project = QSENSE/);
  assert.match(search.body.jql, /assignee = currentUser\(\)/);
  assert.match(search.body.jql, /statusCategory != Done/);
  const r = await svc.submit({ entries: [{ taskKey: 'QSENSE-50', date: '2026-11-09', start: '08:00', minutes: 60, comment: '' }] });
  assert.equal(r.results[0].status, 'created');
  assert.deepEqual(r.transitions, []);
});
