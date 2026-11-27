import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, validateActivity, validateTask, LIMITS } from '../src/support/templates.js';

const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 1, task: 'Realizar diagnóstico', description: '' },
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico', description: '' },
  { cat: 'CAT-166', size: 'P', ust: 8, task: 'Manter script', description: '' },
];
const act = (o = {}) => ({ action: 'Analisar', text: 'o script SQL e o documento', ...o });
const bad = (body, re) => assert.throws(() => validateDraft(body), (e) => e instanceof RangeError && re.test(e.message));

test('rascunho válido: nome e espaços normalizados, só ação e atividade', () => {
  const t = validateDraft({ name: '  Meu rascunho ', public: true, activities: [act({ text: '  o script   SQL e o documento ' })] });
  assert.deepEqual(t, { name: 'Meu rascunho', public: true, activities: [{ action: 'Analisar', text: 'o script SQL e o documento' }] });
});

test('rascunho: limites de nome, 1 a 60 atividades, public booleano', () => {
  assert.equal(LIMITS.name, 80);
  bad({ name: '', public: false, activities: [act()] }, /nome/i);
  bad({ name: 'x'.repeat(81), public: false, activities: [act()] }, /80/);
  bad({ name: 'X', public: false, activities: [] }, /60/);
  bad({ name: 'X', public: false, activities: Array.from({ length: 61 }, () => act()) }, /60/);
  bad({ name: 'X', public: 'sim', activities: [act()] }, /público/i);
  validateDraft({ name: 'x'.repeat(80), public: false, activities: Array.from({ length: 60 }, () => act({ text: 'y'.repeat(300) })) });
});

test('atividade: ação da lista fixa e texto de 10 a 300 caracteres; devolve a fase', () => {
  assert.deepEqual(validateActivity(act({ action: 'Publicar' }), 'Atividade 1'), { action: 'Publicar', text: 'o script SQL e o documento', phase: 'producao' });
  assert.throws(() => validateActivity(act({ action: 'Dançar' }), 'Atividade 2'), /^RangeError: Atividade 2: escolha a ação/);
  assert.throws(() => validateActivity(act({ text: 'curto' }), 'Atividade 1'), /10 a 300/);
  assert.throws(() => validateActivity(act({ text: 'x'.repeat(301) }), 'Atividade 1'), /10 a 300/);
  assert.throws(() => validateActivity(null, 'Atividade 1'), RangeError);
});

test('validateTask: CAT e tamanho no catálogo de UST, título e descrição', () => {
  assert.deepEqual(validateTask({ cat: 'cat-105', size: 'p', summary: ' T ', description: 'D' }, CATALOG, 'Tarefa 1'), { cat: 'CAT-105', size: 'P', summary: 'T', description: 'D' });
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'G', summary: 'T' }, CATALOG, 'BI-1, tarefa 2'), /^RangeError: BI-1, tarefa 2: /);
  assert.throws(() => validateTask({ cat: 'CAT-999', size: 'P', summary: 'T' }, CATALOG, 'T'), /CAT-999.*catálogo/);
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'P', summary: 'x'.repeat(256) }, CATALOG, 'T'), /255/);
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'P', summary: 'T' }, [], 'T'), /catálogo de UST está vazio/);
  assert.throws(() => validateTask(null, CATALOG, 'Tarefa 1'), RangeError);
});

test('validateTask com truncate corta a descrição em 2000 em vez de recusar', () => {
  const t = validateTask({ cat: 'CAT-105', size: 'P', summary: 'T', description: 'x'.repeat(2500) }, CATALOG, 'T1', { truncate: true });
  assert.equal(t.description.length, 2000);
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'P', summary: 'T', description: 'x'.repeat(2001) }, CATALOG, 'T1'), /2000/);
});
