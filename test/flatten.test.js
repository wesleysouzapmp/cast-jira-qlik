import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, adfToText, isAdf } from '../src/shared/flatten.js';
import { toCsv } from '../src/shared/csv.js';

test('flattens nested objects', () => {
  const t = flatten([{ key: 'A-1', fields: { status: { name: 'Done' } } }]);
  assert.deepEqual(t.root[0], { __id: '0', key: 'A-1', 'fields.status.name': 'Done' });
});

test('scalar arrays joined', () => {
  assert.equal(flatten([{ labels: ['a', 'b'] }]).root[0].labels, 'a;b');
  assert.equal(flatten([{ labels: [] }]).root[0].labels, '');
});

test('object arrays become child tables', () => {
  const t = flatten([{ key: 'A', fields: { components: [{ name: 'X' }, { name: 'Y' }] } }]);
  assert.deepEqual(t['root.fields.components'], [
    { __id: '0.0', __parent_id: '0', __index: 0, name: 'X' },
    { __id: '0.1', __parent_id: '0', __index: 1, name: 'Y' },
  ]);
  assert.ok(!('fields.components' in t.root[0]));
});

test('nested child of child', () => {
  const t = flatten([{ histories: [{ items: [{ field: 'status' }] }] }]);
  assert.equal(t['root.histories.items'][0].__parent_id, '0.0');
  assert.equal(t['root.histories.items'][0].field, 'status');
});

test('adf to text', () => {
  const doc = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Olá' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'mundo' }] },
  ] };
  assert.ok(isAdf(doc));
  assert.equal(adfToText(doc), 'Olá\nmundo');
  assert.equal(flatten([{ description: doc }]).root[0].description, 'Olá\nmundo');
});

test('scalar records', () => {
  assert.deepEqual(flatten(['a']).root, [{ __id: '0', value: 'a' }]);
});

test('empty input', () => {
  assert.deepEqual(flatten([]), { root: [] });
});

test('csv quoting and union', () => {
  assert.equal(
    toCsv([{ a: 'x;y', b: 'say "hi"' }, { a: 'l1\nl2', c: 1 }]),
    '﻿a;b;c\r\n"x;y";"say ""hi""";\r\n"l1\nl2";;1',
  );
});

test('csv empty', () => {
  assert.equal(toCsv([]), '﻿');
});
