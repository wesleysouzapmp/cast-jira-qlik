import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, extractRecords } from '../src/paginators.js';

function pager(datas) {
  const reqs = [];
  const fetchPage = async (req) => {
    reqs.push(structuredClone(req));
    const d = datas[reqs.length - 1];
    if (d && d.__resp) return d.__resp;
    return { status: 200, ok: true, ms: 1, data: d };
  };
  return { fetchPage, reqs };
}
const GET = (q = {}) => ({ method: 'GET', path: '/x', query: q, body: null });

test('extractRecords', () => {
  assert.deepEqual(extractRecords({ v: [1] }, 'v'), [1]);
  assert.deepEqual(extractRecords({}, 'v'), []);
  assert.deepEqual(extractRecords([1, 2], null), [1, 2]);
  assert.deepEqual(extractRecords({ a: 1 }, null), [{ a: 1 }]);
});

test('offset stops on isLast', async () => {
  const p = pager([{ values: [1, 2], isLast: false }, { values: [3], isLast: true }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'offset', dataKey: 'values', request: GET() });
  assert.equal(r.total, 3);
  assert.equal(r.stoppedBy, 'end');
  assert.equal(p.reqs[1].query.startAt, 2);
});

test('offset stops on total', async () => {
  const p = pager([{ issues: ['a', 'b'], total: 3, startAt: 0 }, { issues: ['c'], total: 3 }, { issues: ['z'] }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'offset', dataKey: 'issues', request: GET() });
  assert.equal(r.pages.length, 2);
  assert.equal(r.total, 3);
});

test('offset root array continues on short page and stops on empty page', async () => {
  const p = pager([['u1'], ['u2', 'u3'], [], ['never']]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'offset', dataKey: null, request: GET({ maxResults: 2 }) });
  assert.equal(r.total, 3);
  assert.equal(r.pages.length, 3);
  assert.equal(p.reqs[1].query.startAt, 1);
  assert.equal(p.reqs[2].query.startAt, 3);
});

test('token GET puts token in query', async () => {
  const p = pager([{ issues: ['x'], nextPageToken: 'T1' }, { issues: ['y'], isLast: true }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'token', dataKey: 'issues', request: GET({ jql: 'a' }) });
  assert.equal(p.reqs[1].query.nextPageToken, 'T1');
  assert.equal(p.reqs[1].query.jql, 'a');
  assert.equal(r.total, 2);
  assert.equal(p.reqs[0].query.nextPageToken, undefined);
});

test('token POST puts token in body', async () => {
  const p = pager([{ issueChangeLogs: ['x'], nextPageToken: 'T1' }, { issueChangeLogs: ['y'] }]);
  const req = { method: 'POST', path: '/x', query: {}, body: { issueIdsOrKeys: ['A-1'] } };
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'token', dataKey: 'issueChangeLogs', request: req });
  assert.equal(p.reqs[1].body.nextPageToken, 'T1');
  assert.equal(r.total, 2);
  assert.equal(req.body.nextPageToken, undefined, 'não muta o request original');
});

test('worklogUpdated reads since from nextPage', async () => {
  const p = pager([
    { values: ['w1'], lastPage: false, nextPage: 'https://x/rest/api/3/worklog/updated?since=1700000000000' },
    { values: ['w2'], lastPage: true },
  ]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'worklogUpdated', dataKey: 'values', request: GET({ since: 0 }) });
  assert.equal(p.reqs[1].query.since, '1700000000000');
  assert.equal(r.total, 2);
});

test('maxPages stops', async () => {
  const p = pager([{ values: [1], isLast: false }, { values: [2], isLast: false }, { values: [3], isLast: false }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'offset', dataKey: 'values', request: GET(), maxPages: 2 });
  assert.equal(r.stoppedBy, 'maxPages');
  assert.equal(r.pages.length, 2);
});

test('error keeps previous pages', async () => {
  const p = pager([{ values: [1, 2], isLast: false }, { __resp: { status: 400, ok: false, ms: 1, data: { errorMessages: ['x'] } } }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'offset', dataKey: 'values', request: GET() });
  assert.equal(r.stoppedBy, 'error');
  assert.equal(r.total, 2);
  assert.deepEqual(r.error, { errorMessages: ['x'] });
  assert.equal(r.pages[1].status, 400);
});

test('repeated token stops with loop', async () => {
  const p = pager([{ issues: [1], nextPageToken: 'T1' }, { issues: [2], nextPageToken: 'T1' }, { issues: [3] }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'token', dataKey: 'issues', request: GET() });
  assert.equal(r.stoppedBy, 'loop');
  assert.equal(r.total, 2);
});

test('empty result', async () => {
  const p = pager([{ issues: [], isLast: true }]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'token', dataKey: 'issues', request: GET() });
  assert.equal(r.total, 0);
  assert.equal(r.stoppedBy, 'end');
});

test('none does one call', async () => {
  const p = pager([[{ id: 1 }, { id: 2 }], ['never']]);
  const r = await paginate({ fetchPage: p.fetchPage, strategy: 'none', dataKey: null, request: GET() });
  assert.equal(r.total, 2);
  assert.equal(r.pages.length, 1);
});
