import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../src/jiraClient.js';

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '{}', { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const base = { baseUrl: 'https://x.atlassian.net/', email: 'e@x', token: 'tok' };

test('sends basic auth and builds url', async () => {
  const f = mockFetch([{ body: '{"ok":1}' }]);
  const c = createJiraClient({ ...base, fetchImpl: f });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: { a: 1 }, body: null });
  assert.equal(f.calls[0].url, 'https://x.atlassian.net/rest/api/3/myself?a=1');
  const h = new Headers(f.calls[0].init.headers);
  assert.equal(h.get('Authorization'), 'Basic ' + Buffer.from('e@x:tok').toString('base64'));
  assert.equal(h.get('Accept'), 'application/json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: 1 });
});

test('POST sends json body', async () => {
  const f = mockFetch([{}]);
  const c = createJiraClient({ ...base, fetchImpl: f });
  await c.call({ method: 'POST', path: '/rest/api/3/worklog/list', query: {}, body: { ids: [1] } });
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.body, JSON.stringify({ ids: [1] }));
  assert.equal(new Headers(f.calls[0].init.headers).get('Content-Type'), 'application/json');
});

test('retries on 429 using Retry-After', async () => {
  const f = mockFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }]);
  const sleeps = [];
  const c = createJiraClient({ ...base, fetchImpl: f, sleep: async (ms) => sleeps.push(ms) });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(r.status, 200);
  assert.equal(r.retries, 1);
});

test('gives up after maxRetries', async () => {
  const f = mockFetch([{ status: 429, headers: { 'retry-after': '1' } }]);
  const c = createJiraClient({ ...base, fetchImpl: f, sleep: async () => {} });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.equal(f.calls.length, 4);
  assert.equal(r.status, 429);
});

test('non-json body returned as text', async () => {
  const f = mockFetch([{ status: 503, body: '<html>down</html>', headers: { 'content-type': 'text/html' } }]);
  const c = createJiraClient({ ...base, fetchImpl: f });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.equal(r.data, '<html>down</html>');
  assert.equal(r.ok, false);
});

test('network error resolves status 0', async () => {
  const f = mockFetch([new Error('ECONNRESET')]);
  const c = createJiraClient({ ...base, fetchImpl: f });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.equal(r.status, 0);
  assert.equal(r.ok, false);
  assert.match(r.data.error, /ECONNRESET/);
});

test('token never in result', async () => {
  const f = mockFetch([{ status: 401, body: '{"errorMessages":["no"]}' }]);
  const c = createJiraClient({ ...base, fetchImpl: f });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.ok(!JSON.stringify(r).includes('tok'));
});

test('body read failure resolves status 0', async () => {
  const f = async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => { throw new Error('aborted'); } });
  const c = createJiraClient({ ...base, fetchImpl: f });
  const r = await c.call({ method: 'GET', path: '/rest/api/3/myself', query: {}, body: null });
  assert.equal(r.status, 0);
  assert.equal(r.ok, false);
  assert.match(r.data.error, /aborted/);
});
