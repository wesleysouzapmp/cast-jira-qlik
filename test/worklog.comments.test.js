import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/support/models.js';
import { pickComments } from '../src/worklog/comments.js';

const [ANALISE, IMPL] = MODELS;
const ctx = { epicKey: 'BI-1', epicSummary: 'Painel X', taskKey: 'QSENSE-9' };
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('modelos têm 8 frases cada', () => {
  assert.equal(ANALISE.comments.length, 8);
  assert.equal(IMPL.comments.length, 8);
});

test('8 frases distintas e {EPICO} substituído', () => {
  const r = pickComments(ANALISE, ctx, 8, seeded());
  assert.equal(new Set(r).size, 8);
  assert.ok(r.every((c) => c.includes('BI-1 - Painel X') && !c.includes('{EPICO}')));
});

test('mais pedidos que frases repete só depois de usar todas', () => {
  const r = pickComments(IMPL, ctx, 10, seeded(7));
  assert.equal(r.length, 10);
  assert.equal(new Set(r.slice(0, 8)).size, 8);
});

test('$ no resumo fica literal', () => {
  const r = pickComments(ANALISE, { ...ctx, epicSummary: 'R$$ 1' }, 1, seeded());
  assert.ok(r[0].includes('BI-1 - R$$ 1'));
});

test('rng fixo dá resultado determinístico', () => {
  assert.deepEqual(pickComments(ANALISE, ctx, 3, seeded(3)), pickComments(ANALISE, ctx, 3, seeded(3)));
});
