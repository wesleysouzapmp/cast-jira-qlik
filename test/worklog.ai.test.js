import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiCommenter, AiError } from '../src/worklog/ai.js';

const entries = [
  { taskKey: 'QSENSE-1', model: 'analise', date: '2026-11-09', minutes: 60 },
  { taskKey: 'QSENSE-2', model: 'implementacao', date: '2026-11-09', minutes: 90 },
];
const ctx = { 'QSENSE-1': { epicKey: 'BI-1', epicSummary: 'Painel', taskSummary: 'Analise da demanda BI-1' }, 'QSENSE-2': { epicKey: 'BI-1', epicSummary: 'Painel', taskSummary: 'Implementação da demanda BI-1' } };

function fakeClient(response) {
  const calls = [];
  return { calls, beta: { messages: { async create(p) { calls.push(p); return typeof response === 'function' ? response(p) : response; } } } };
}
const ok = (comments) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ comments }) }] });

test('chama o modelo com effort low, fallback e schema', async () => {
  const client = fakeClient(ok([{ index: 1, text: 'B' }, { index: 0, text: 'A' }]));
  const ai = createAiCommenter({ client });
  assert.equal(ai.enabled, true);
  const r = await ai.generate(entries, ctx);
  assert.deepEqual(r, ['A', 'B']);
  const p = client.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.output_config.format.schema.required, ['comments']);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(JSON.stringify(p.messages).includes('QSENSE-2'));
});

test('corta comentário em 160 caracteres', async () => {
  const ai = createAiCommenter({ client: fakeClient(ok([{ index: 0, text: 'x'.repeat(300) }, { index: 1, text: 'y' }])) });
  const r = await ai.generate(entries, ctx);
  assert.equal(r[0].length, 160);
});

test('recusa vira AiError', async () => {
  const ai = createAiCommenter({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(ai.generate(entries, ctx), (e) => e instanceof AiError && /recusou/.test(e.message));
});

test('quantidade errada vira AiError', async () => {
  const ai = createAiCommenter({ client: fakeClient(ok([{ index: 0, text: 'A' }])) });
  await assert.rejects(ai.generate(entries, ctx), AiError);
});

test('JSON inválido vira AiError', async () => {
  const ai = createAiCommenter({ client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }] }) });
  await assert.rejects(ai.generate(entries, ctx), AiError);
});

test('erro da API vira AiError', async () => {
  const ai = createAiCommenter({ client: fakeClient(() => { throw new Error('401 invalid x-api-key'); }) });
  await assert.rejects(ai.generate(entries, ctx), (e) => e instanceof AiError && /401/.test(e.message));
});

test('desativado sem chave', () => {
  assert.equal(createAiCommenter({}).enabled, false);
});

test('prévia grande é dividida em lotes', async () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ taskKey: 'QSENSE-1', model: 'analise', date: '2026-11-09', minutes: 15 + 0 * i }));
  const client = fakeClient((p) => {
    const n = JSON.parse(p.messages[0].content.slice(p.messages[0].content.indexOf(String.fromCharCode(10)) + 1)).length;
    return ok(Array.from({ length: n }, (_, i) => ({ index: i, text: 'c' + i })));
  });
  const r = await createAiCommenter({ client }).generate(many, ctx);
  assert.equal(r.length, 95);
  assert.equal(client.calls.length, 3);
  assert.ok(client.calls.every((p) => p.max_tokens >= 4000));
});

test('resposta cortada por max_tokens vira AiError claro', async () => {
  const ai = createAiCommenter({ client: fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"comments":[' }] }) });
  await assert.rejects(ai.generate(entries, ctx), (e) => e instanceof AiError && /longa|limite/.test(e.message));
});
