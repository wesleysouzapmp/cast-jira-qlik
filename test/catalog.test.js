import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, getEndpoint, buildPath, isAllowed } from '../src/catalog.js';

test('catalog has all spec endpoints', () => {
  assert.deepEqual(CATALOG.map((e) => e.id).sort(), [
    'myself', 'projects', 'users', 'statuses', 'issuetypes', 'priorities', 'fields',
    'search-jql', 'issue-changelog', 'changelog-bulk', 'issue-worklog', 'worklog-updated', 'worklog-list',
    'boards', 'board-sprints', 'sprint-issues',
  ].sort());
  for (const e of CATALOG) {
    assert.ok(['Cadastros', 'Issues', 'Changelog', 'Worklogs', 'Agile'].includes(e.area), e.id);
    assert.ok(isAllowed({ method: e.method, path: e.path.replace(/\{\w+\}/g, 'X') }), e.id);
  }
});

test('entries match spec table', () => {
  const s = getEndpoint('search-jql');
  assert.equal(s.method, 'GET');
  assert.equal(s.path, '/rest/api/3/search/jql');
  assert.equal(s.pagination, 'token');
  assert.equal(s.dataKey, 'issues');
  assert.deepEqual(s.query, { jql: 'updated >= -30d ORDER BY updated DESC', fields: '*navigable', maxResults: 100 });

  const c = getEndpoint('changelog-bulk');
  assert.equal(c.method, 'POST');
  assert.equal(c.pagination, 'token');
  assert.equal(c.dataKey, 'issueChangeLogs');
  assert.deepEqual(c.body, { issueIdsOrKeys: [], maxResults: 1000 });

  const w = getEndpoint('worklog-updated');
  assert.equal(w.pagination, 'worklogUpdated');
  assert.equal(w.dataKey, 'values');
  assert.deepEqual(w.query, { since: 0 });

  const si = getEndpoint('sprint-issues');
  assert.equal(si.path, '/rest/agile/1.0/sprint/{sprintId}/issue');
  assert.deepEqual(si.pathParams, ['sprintId']);
  assert.equal(si.pagination, 'offset');
  assert.equal(si.dataKey, 'issues');

  const u = getEndpoint('users');
  assert.equal(u.pagination, 'offset');
  assert.equal(u.dataKey, null);
  assert.deepEqual(u.query, { maxResults: 100 });

  for (const id of ['statuses', 'issuetypes', 'priorities', 'fields']) {
    assert.equal(getEndpoint(id).pagination, 'none', id);
    assert.equal(getEndpoint(id).dataKey, null, id);
  }
});

test('buildPath encodes and requires', () => {
  assert.equal(buildPath('/rest/api/3/issue/{key}/worklog', { key: 'AB-1' }), '/rest/api/3/issue/AB-1/worklog');
  assert.equal(buildPath('/rest/api/3/issue/{key}', { key: 'a/b' }), '/rest/api/3/issue/a%2Fb');
  assert.throws(() => buildPath('/rest/api/3/issue/{key}/worklog', {}), /Parâmetro obrigatório: key/);
});

test('isAllowed', () => {
  assert.equal(isAllowed({ method: 'GET', path: 'https://evil.com/x' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '//evil.com/rest/x' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '/rest/../x' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '/rest/%2e%2e/x' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '/wiki/x' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '/rest/x@evil.com' }), false);
  assert.equal(isAllowed({ method: 'POST', path: '/rest/api/3/issue' }), false);
  assert.equal(isAllowed({ method: 'DELETE', path: '/rest/api/3/issue/A-1' }), false);
  assert.equal(isAllowed({ method: 'GET', path: '/rest/api/3/myself' }), true);
  assert.equal(isAllowed({ method: 'POST', path: '/rest/api/3/worklog/list' }), true);
});
