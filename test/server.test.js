import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import http from 'node:http';

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start({ responses = [{ status: 200, ok: true, ms: 1, data: {} }], tokenConfigured = true, supportService, worklogService, holidayProvider } = {}) {
  const calls = [];
  const client = {
    async call(req) {
      calls.push(req);
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
  const app = createApp({ client, config: { baseUrl: 'https://x.atlassian.net', email: 'e@x', tokenConfigured }, supportService, worklogService, holidayProvider });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, calls };
}

test('config hides token', async () => {
  const { base } = await start();
  const res = await fetch(base + '/api/config');
  const json = await res.json();
  assert.deepEqual(json, { baseUrl: 'https://x.atlassian.net', email: 'e@x', tokenConfigured: true });
});

test('catalog route', async () => {
  const { base } = await start();
  const json = await (await fetch(base + '/api/catalog')).json();
  assert.ok(json.some((e) => e.id === 'search-jql'));
});

test('call by endpointId', async () => {
  const { post, calls } = await start();
  const res = await post('/api/call', { endpointId: 'issue-worklog', pathParams: { key: 'AB-1' } });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, '/rest/api/3/issue/AB-1/worklog');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].query, { maxResults: 1000 });
});

test('call uses overridden query and body', async () => {
  const { post, calls } = await start();
  await post('/api/call', { endpointId: 'worklog-list', body: { ids: [5] } });
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { ids: [5] });
});

test('rejects foreign host', async () => {
  const { post, calls } = await start();
  const res = await post('/api/call', { path: 'https://evil.com/x' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('rejects write method', async () => {
  const { post, calls } = await start();
  const res = await post('/api/call', { path: '/rest/api/3/issue', method: 'POST' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('unknown endpoint', async () => {
  const { post } = await start();
  const res = await post('/api/call', { endpointId: 'nope' });
  assert.equal(res.status, 400);
});

test('missing path param', async () => {
  const { post } = await start();
  const res = await post('/api/call', { endpointId: 'sprint-issues' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /sprintId/);
});

test('no token', async () => {
  const { post, calls } = await start({ tokenConfigured: false });
  const res = await post('/api/call', { endpointId: 'myself' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Token não configurado/);
  assert.equal(calls.length, 0);
});

test('paginate uses catalog strategy', async () => {
  const { post } = await start({ responses: [
    { status: 200, ok: true, ms: 1, data: { issues: [1], nextPageToken: 'A' } },
    { status: 200, ok: true, ms: 1, data: { issues: [2], isLast: true } },
  ] });
  const res = await post('/api/paginate', { endpointId: 'search-jql' });
  const json = await res.json();
  assert.equal(json.total, 2);
  assert.equal(json.stoppedBy, 'end');
});

test('paginate custom uses given strategy', async () => {
  const { post, calls } = await start({ responses: [
    { status: 200, ok: true, ms: 1, data: { values: [1], isLast: false } },
    { status: 200, ok: true, ms: 1, data: { values: [2], isLast: true } },
  ] });
  const json = await (await post('/api/paginate', { path: '/rest/agile/1.0/board', pagination: 'offset', dataKey: 'values', maxPages: 5 })).json();
  assert.equal(json.total, 2);
  assert.equal(calls[1].query.startAt, 1);
});

test('serves shared lib and ui', async () => {
  const { base } = await start();
  const res = await fetch(base + '/lib/flatten.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('rejects foreign Host header (DNS rebinding)', async () => {
  const { base, calls } = await start();
  const port = new URL(base).port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/call', method: 'POST', headers: { Host: `evil.example:${port}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify({ endpointId: 'myself' }));
  });
  assert.equal(status, 403);
  assert.equal(calls.length, 0);
});

test('accepts localhost Host header', async () => {
  const { base } = await start();
  const port = new URL(base).port;
  const res = await fetch(`http://localhost:${port}/api/config`);
  assert.equal(res.status, 200);
});

// ---- Tarefas de apoio ----
import { JiraError } from '../src/support/service.js';

function fakeSupport({ fail } = {}) {
  const calls = [];
  const svc = {
    async listItems(opts) { calls.push(['list', opts]); if (fail) throw fail; return { items: [], truncated: false }; },
    async preview(keys) { calls.push(['preview', keys]); return { epics: [], rejected: [] }; },
    async create(keys) { calls.push(['create', keys]); if (fail) throw fail; return { results: [] }; },
  };
  return { svc, calls };
}

test('support items repassa onlyEpics', async () => {
  const { svc, calls } = fakeSupport();
  const { base } = await start({ supportService: svc });
  const res = await fetch(base + '/api/support/items?onlyEpics=1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [], truncated: false });
  assert.deepEqual(calls[0], ['list', { onlyEpics: true }]);
  await fetch(base + '/api/support/items');
  assert.deepEqual(calls[1], ['list', { onlyEpics: false }]);
  await fetch(base + '/api/support/items?includeDone=1');
  assert.deepEqual(calls[2], ['list', { onlyEpics: false, includeDone: true }]);
});

test('support create valida keys', async () => {
  const { svc, calls } = fakeSupport();
  const { post } = await start({ supportService: svc });
  const many = Array.from({ length: 51 }, (_, i) => `BI-${i + 1}`);
  for (const keys of [[], ['bi-1'], many, 'BI-1', ['BI-1 OR 1=1'], undefined]) {
    const res = await post('/api/support/create', { keys });
    assert.equal(res.status, 400, JSON.stringify(keys));
  }
  assert.equal(calls.length, 0);
});

test('support create remove duplicadas', async () => {
  const { svc, calls } = fakeSupport();
  const { post } = await start({ supportService: svc });
  const res = await post('/api/support/create', { keys: ['BI-1', 'BI-1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ['create', ['BI-1']]);
});

test('support preview chama o serviço', async () => {
  const { svc, calls } = fakeSupport();
  const { post } = await start({ supportService: svc });
  const res = await post('/api/support/preview', { keys: ['BI-2'] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ['preview', ['BI-2']]);
});

test('support create recusa Origin externo', async () => {
  const { svc, calls } = fakeSupport();
  const { post } = await start({ supportService: svc });
  const res = await post('/api/support/create', { keys: ['BI-1'] }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('support create aceita Origin do próprio app', async () => {
  const { svc } = fakeSupport();
  const { post, base } = await start({ supportService: svc });
  const res = await post('/api/support/create', { keys: ['BI-1'] }, { Origin: base });
  assert.equal(res.status, 200);
});

test('support JiraError vira 502', async () => {
  const { svc } = fakeSupport({ fail: new JiraError(401, 'Busca: HTTP 401 Não autorizado') });
  const { base } = await start({ supportService: svc });
  const res = await fetch(base + '/api/support/items');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Não autorizado/);
});

test('support sem token → 400', async () => {
  const { svc, calls } = fakeSupport();
  const { post } = await start({ supportService: svc, tokenConfigured: false });
  const res = await post('/api/support/create', { keys: ['BI-1'] });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// ---- Apontamento de horas ----
import { ConflictError, ScopeError } from '../src/worklog/service.js';
import { AiError } from '../src/worklog/ai.js';

function fakeWorklog({ fail, aiEnabled = true } = {}) {
  const calls = [];
  const svc = {
    aiEnabled,
    async listTasks() { calls.push(['tasks']); return { epics: [], aiEnabled }; },
    async myWorklogs(from, to) { calls.push(['calendar', from, to]); return []; },
    async preview(input) { calls.push(['preview', input]); if (fail) throw fail; return { entries: [], unallocated: [], transitions: [] }; },
    async aiComments(entries) { calls.push(['ai', entries]); if (fail) throw fail; return { comments: [] }; },
    async submit(input) { calls.push(['submit', input]); if (fail) throw fail; return { results: [], transitions: [] }; },
    async batch(input) { calls.push(['batch', input]); if (fail) throw fail; return { results: [], transitions: [] }; },
  };
  return { svc, calls };
}
const SCHED = { start: '08:00', lunchStart: '12:00', lunchEnd: '13:00', end: '17:00', dailyLimit: 480 };
const okPreview = { items: [{ taskKey: 'QSENSE-1', minutes: 60 }], from: '2026-11-09', to: '2026-11-13', schedule: SCHED };
const okEntry = { taskKey: 'QSENSE-1', date: '2026-11-09', start: '08:00', minutes: 60, comment: 'x' };

test('worklog tasks repassa o serviço', async () => {
  const { svc } = fakeWorklog();
  const { base } = await start({ worklogService: svc });
  const res = await fetch(base + '/api/worklog/tasks');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { epics: [], aiEnabled: true });
});

test('worklog preview válido chega ao serviço', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const res = await post('/api/worklog/preview', okPreview);
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ['preview', okPreview]);
});

test('worklog preview repassa horas por dia útil (perDay) e limita a 8h', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const body = { ...okPreview, items: [{ taskKey: 'QSENSE-1', minutes: 120, perDay: true }, { taskKey: 'QSENSE-2', minutes: 60 }] };
  assert.equal((await post('/api/worklog/preview', body)).status, 200);
  assert.deepEqual(calls[0][1].items, [{ taskKey: 'QSENSE-1', minutes: 120, perDay: true }, { taskKey: 'QSENSE-2', minutes: 60 }]);
  for (const items of [[{ taskKey: 'QSENSE-1', minutes: 495, perDay: true }], [{ taskKey: 'QSENSE-1', minutes: 60, perDay: 'sim' }]]) {
    assert.equal((await post('/api/worklog/preview', { ...okPreview, items })).status, 400, JSON.stringify(items));
  }
  assert.equal(calls.length, 1);
});

test('worklog preview valida período, horas e expediente', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const bad = [
    { ...okPreview, to: '2026-12-11' },
    { ...okPreview, from: '2026-11-13', to: '2026-11-09' },
    { ...okPreview, from: '09/11/2026' },
    { ...okPreview, items: [] },
    { ...okPreview, items: [{ taskKey: 'QSENSE-1', minutes: 20 }] },
    { ...okPreview, items: [{ taskKey: 'qsense-1', minutes: 60 }] },
    { ...okPreview, schedule: { ...SCHED, lunchStart: '07:00' } },
    { ...okPreview, schedule: { ...SCHED, end: '25:00' } },
    { ...okPreview, schedule: { ...SCHED, dailyLimit: 0 } },
  ];
  for (const b of bad) assert.equal((await post('/api/worklog/preview', b)).status, 400, JSON.stringify(b));
  assert.equal(calls.length, 0);
});

test('worklog submit valida lançamentos', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const many = Array.from({ length: 201 }, () => okEntry);
  const bad = [[], many, [{ ...okEntry, minutes: 20 }], [{ ...okEntry, minutes: 495 }], [{ ...okEntry, comment: 'x'.repeat(1001) }], [{ ...okEntry, start: '25:00' }], [{ ...okEntry, start: '08:10' }], [{ ...okEntry, date: '2026-13-01' }], [{ ...okEntry, taskKey: 'X' }]];
  for (const entries of bad) assert.equal((await post('/api/worklog/submit', { entries })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await post('/api/worklog/submit', { entries: [okEntry] })).status, 200);
  assert.deepEqual(calls[0][1].entries, [okEntry]);
});

test('worklog submit recusa Origin externo', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  assert.equal((await post('/api/worklog/submit', { entries: [okEntry] }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(calls.length, 0);
});

test('worklog erros viram 409, 400 e 502', async () => {
  for (const [err, code] of [[new ConflictError('novo'), 409], [new ScopeError('fora'), 400], [new AiError('recusou'), 502]]) {
    const { svc } = fakeWorklog({ fail: err });
    const { post } = await start({ worklogService: svc });
    const res = await post(err instanceof AiError ? '/api/worklog/ai-comments' : '/api/worklog/submit', err instanceof AiError ? { entries: [okEntry] } : { entries: [okEntry] });
    assert.equal(res.status, code);
    assert.match((await res.json()).error, /novo|fora|recusou/);
  }
});

test('worklog ai-comments dá 404 sem IA', async () => {
  const { svc, calls } = fakeWorklog({ aiEnabled: false });
  const { post } = await start({ worklogService: svc });
  const res = await post('/api/worklog/ai-comments', { entries: [okEntry] });
  assert.equal(res.status, 404);
  assert.equal(calls.filter((c) => c[0] === 'ai').length, 0);
});

test('worklog sem token → 400', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc, tokenConfigured: false });
  assert.equal((await post('/api/worklog/submit', { entries: [okEntry] })).status, 400);
  assert.equal(calls.length, 0);
});

test('worklog calendar valida o período e repassa ao serviço', async () => {
  const { svc, calls } = fakeWorklog();
  const { base } = await start({ worklogService: svc });
  const ok = await fetch(base + '/api/worklog/calendar?from=2026-10-01&to=2026-12-01');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { entries: [] });
  assert.deepEqual(calls[0], ['calendar', '2026-10-01', '2026-12-01']); // 62 dias
  for (const q of ['from=2026-10-01&to=2026-12-02', 'from=2026-11-10&to=2026-11-09', 'from=x&to=2026-11-09', '']) {
    assert.equal((await fetch(base + '/api/worklog/calendar?' + q)).status, 400, q);
  }
  assert.equal(calls.length, 1);
});

test('holidays repassa o período e valida', async () => {
  const seen = [];
  const holidayProvider = { async between(f, t) { seen.push([f, t]); return new Map([['2026-11-02', 'Finados']]); } };
  const { base } = await start({ holidayProvider });
  const ok = await fetch(base + '/api/holidays?from=2026-11-01&to=2026-11-30');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { holidays: [{ date: '2026-11-02', name: 'Finados' }] });
  assert.deepEqual(seen, [['2026-11-01', '2026-11-30']]);
  for (const q of ['from=2026-01-01&to=2027-02-05', 'from=x&to=2026-11-01', 'from=2026-11-02&to=2026-11-01']) {
    assert.equal((await fetch(base + '/api/holidays?' + q)).status, 400, q);
  }
});

test('worklog batch valida e repassa', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const u = { id: '7', issueKey: 'QSENSE-1', action: 'update', date: '2026-11-09', start: '08:00', minutes: 60, comment: 'x' };
  const okRes = await post('/api/worklog/batch', { changes: [u, { id: '8', issueKey: 'SIJUD-1', action: 'delete' }, { ...u, id: '9', targetKey: 'QSENSE-3' }] });
  assert.equal(okRes.status, 200);
  assert.deepEqual(calls[0][1].changes, [u, { id: '8', issueKey: 'SIJUD-1', action: 'delete' }, { ...u, id: '9', targetKey: 'QSENSE-3' }]);
  const many = Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), issueKey: 'QSENSE-1', action: 'delete' }));
  const bad = [[], many, [{ ...u, id: 'a1' }], [u, u], [{ ...u, action: 'move' }], [{ ...u, date: undefined }], [{ ...u, start: '8:10' }], [{ ...u, minutes: 495 }], [{ ...u, targetKey: 'x' }], [{ ...u, comment: 'x'.repeat(1001) }], [{ ...u, issueKey: 'bad' }]];
  for (const changes of bad) assert.equal((await post('/api/worklog/batch', { changes })).status, 400, JSON.stringify(changes).slice(0, 80));
  assert.equal(calls.length, 1);
});

test('worklog batch: Origin externo 403 e conflito 409', async () => {
  const u = { id: '7', issueKey: 'QSENSE-1', action: 'delete' };
  const a = fakeWorklog();
  const s1 = await start({ worklogService: a.svc });
  assert.equal((await s1.post('/api/worklog/batch', { changes: [u] }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(a.calls.length, 0);
  const b = fakeWorklog({ fail: new ConflictError('sobreposta') });
  const s2 = await start({ worklogService: b.svc });
  assert.equal((await s2.post('/api/worklog/batch', { changes: [u] })).status, 409);
});

test('worklog batch aceita duração e início fora dos blocos de 15 (o serviço confere contra o original)', async () => {
  const { svc, calls } = fakeWorklog();
  const { post } = await start({ worklogService: svc });
  const u = { id: '30', issueKey: 'QSENSE-3', action: 'update', date: '2026-11-11', start: '09:07', minutes: 20, comment: 'x', updated: '2026-11-10T10:00:00.000-0300' };
  assert.equal((await post('/api/worklog/batch', { changes: [u] })).status, 200);
  assert.deepEqual(calls[0][1].changes, [u]);
  for (const bad of [{ ...u, minutes: 0 }, { ...u, minutes: 481 }, { ...u, start: '23:59', minutes: 20 }, { ...u, updated: 5 }]) {
    assert.equal((await post('/api/worklog/batch', { changes: [bad] })).status, 400, JSON.stringify(bad));
  }
});
