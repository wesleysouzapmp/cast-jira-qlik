import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeJira, epicIssue, taskIssue, ME } from './fakeJira.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService } from '../src/worklog/service.js';

const BASE = 'https://x.atlassian.net';
const loose = (key) => ({ key, fields: { summary: 'Daily', issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: key.split('-')[0] } } });
const wl = (id, started, sec) => ({ id: String(id), author: { accountId: ME }, started, timeSpentSeconds: sec });

function setup(worklogs = {}) {
  const jira = createFakeJira({ issues: [epicIssue('BI-1', 'Aberto'), taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto'), loose('SIJUD-1')], worklogs });
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE });
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false } });
  return { jira, svc };
}
const slot = (o = {}) => ({ taskKey: 'SIJUD-1', date: '2026-11-09', start: '09:00', minutes: 15, comment: 'Daily', ...o });
const posts = (jira) => jira.calls.filter((c) => c.method === 'POST' && /\/worklog$/.test(c.path));

test('autoLog grava o worklog sem notificar e sem mexer em status', async () => {
  const { jira, svc } = setup();
  const r = await svc.autoLog(slot());
  assert.equal(r.status, 'created');
  const [p] = posts(jira);
  assert.equal(p.path, '/rest/api/3/issue/SIJUD-1/worklog');
  assert.deepEqual(p.query, { notifyUsers: 'false' });
  assert.equal(p.body.started, '2026-11-09T09:00:00.000-0300');
  assert.equal(p.body.timeSpent, '15m');
  assert.ok(!jira.calls.some((c) => c.path.includes('/transitions')));
});

test('autoLog não duplica: segunda chamada no mesmo dia é pulada', async () => {
  const { jira, svc } = setup();
  await svc.autoLog(slot());
  const r = await svc.autoLog(slot());
  assert.equal(r.status, 'skipped');
  assert.equal(posts(jira).length, 1);
});

test('autoLog em tarefa de apoio também não muda status', async () => {
  const { jira, svc } = setup();
  assert.equal((await svc.autoLog(slot({ taskKey: 'QSENSE-1' }))).status, 'created');
  assert.ok(!jira.calls.some((c) => c.path.includes('/transitions')));
});

test('autoLog não grava sobre outro apontamento seu (conflito)', async () => {
  const { jira, svc } = setup({ 'QSENSE-1': [wl(1, '2026-11-09T08:30:00.000-0300', 3600)] });
  const r = await svc.autoLog(slot());
  assert.equal(r.status, 'conflict');
  assert.match(r.message, /QSENSE-1/);
  assert.equal(posts(jira).length, 0);
});

test('autoLog: chave indisponível vira erro sem gravar', async () => {
  const { jira, svc } = setup();
  const r = await svc.autoLog(slot({ taskKey: 'BI-1' }));
  assert.equal(r.status, 'error');
  assert.match(r.message, /épico/);
  assert.equal(posts(jira).length, 0);
});

test('findBySummary acha a tarefa pelo título exato (sem diferenciar maiúsculas) e recusa ambíguo/épico/inexistente', async () => {
  const jira = createFakeJira({ issues: [
    { ...loose('SIJUD-27633'), fields: { ...loose('SIJUD-27633').fields, summary: 'Daily COSARQ - BI - 11/2026' } },
    { ...loose('SIJUD-27634'), fields: { ...loose('SIJUD-27634').fields, summary: 'Daily COSARQ - BI - 11/2026 (cópia)' } },
    { ...loose('SIJUD-5'), fields: { ...loose('SIJUD-5').fields, summary: 'Dup' } },
    { ...loose('SIJUD-6'), fields: { ...loose('SIJUD-6').fields, summary: 'dup' } },
    epicIssue('BI-9', 'Aberto', 'Daily épico'),
  ] });
  const svc = createWorklogService({ client: jira.client, baseUrl: BASE, supportService: createSupportService({ client: jira.client, baseUrl: BASE }), ai: { enabled: false } });
  const ok = await svc.findBySummary('daily cosarq - bi - 11/2026');
  assert.equal(ok.key, 'SIJUD-27633');
  assert.equal(ok.available, true);
  assert.match((await svc.findBySummary('Dup')).error, /Mais de uma.*SIJUD-5.*SIJUD-6/);
  assert.equal((await svc.findBySummary('Daily épico')).available, false);
  assert.match((await svc.findBySummary('Nada disso')).error, /Nenhuma tarefa/);
});
