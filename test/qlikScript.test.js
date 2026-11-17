import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQlikScript } from '../src/shared/qlikScript.js';
import { getEndpoint } from '../src/catalog.js';

const baseUrl = 'https://tjmg.atlassian.net';
const reqOf = (ep, over = {}) => ({ method: ep.method, path: ep.path, query: { ...ep.query }, body: ep.body, ...over });

test('none', () => {
  const ep = getEndpoint('statuses');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep), sampleRecord: { id: '1', name: 'To Do', statusCategory: {} } });
  assert.match(s, /LIB CONNECT TO 'Jira_REST';/);
  assert.match(s, /"id"/);
  assert.match(s, /"name"/);
  assert.ok(s.includes('URL "https://tjmg.atlassian.net/rest/api/3/status"'));
  assert.ok(!s.includes('statusCategory'));
  assert.ok(!/^\s*DO\b/m.test(s));
});

test('no sample', () => {
  const ep = getEndpoint('statuses');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep) });
  assert.match(s, /Rode a chamada no app para listar as colunas/);
});

test('offset', () => {
  const ep = getEndpoint('boards');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep), sampleRecord: { id: 1, name: 'B', type: 'scrum' } });
  assert.ok(s.includes('QUERY "startAt" "$(vStartAt)"'));
  assert.match(s, /^\s*DO\b/m);
  assert.ok(s.includes('FROM "values" FK "__FK_values"'));
  assert.ok(s.includes('QUERY "maxResults" "50"'));
});

test('token', () => {
  const ep = getEndpoint('search-jql');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep, { query: { jql: 'project = "X"', maxResults: 100 } }), sampleRecord: { id: '1', key: 'X-1', fields: {} } });
  assert.ok(s.includes('vNextToken'));
  assert.ok(s.includes('nextPageToken'));
  assert.ok(s.includes('QUERY "jql" "project = ""X"""'));
});

test('worklogUpdated', () => {
  const ep = getEndpoint('worklog-updated');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep), sampleRecord: { worklogId: 1, updatedTime: 2 } });
  assert.ok(s.includes('QUERY "since" "$(vSince)"'));
  assert.ok(s.includes('lastPage'));
});

test('POST body', () => {
  const ep = getEndpoint('worklog-list');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep, { body: { ids: [1, 2] } }), sampleRecord: { id: '1' } });
  assert.ok(s.includes('BODY "{""ids"":[1,2]}"'));
  assert.ok(s.includes('HTTPHEADER "Content-Type" "application/json"'));
  assert.ok(s.includes("LIB CONNECT TO 'Jira_REST_POST';"));
  assert.ok(s.includes('Method = POST'));
});

test('custom connection name', () => {
  const ep = getEndpoint('myself');
  const s = generateQlikScript({ baseUrl, endpoint: ep, request: reqOf(ep), sampleRecord: { accountId: 'a' }, connectionName: 'Jira_TJMG' });
  assert.match(s, /LIB CONNECT TO 'Jira_TJMG';/);
});
