import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate, validateTask, LIMITS } from '../src/support/templates.js';

const CATALOG = [
  { cat: 'CAT-105', size: 'P', ust: 1, task: 'Realizar diagnóstico', description: '' },
  { cat: 'CAT-105', size: 'M', ust: 2, task: 'Realizar diagnóstico', description: '' },
  { cat: 'CAT-166', size: 'P', ust: 8, task: 'Manter script', description: '' },
];
const item = (o = {}) => ({ cat: 'CAT-105', size: 'M', summary: 'Analise da demanda {EPICO}', description: 'Desc {EPICO}', ...o });
const bad = (body, re) => assert.throws(() => validateTemplate(body, CATALOG), (e) => e instanceof RangeError && re.test(e.message));

test('aceita modelo válido e normaliza CAT, tamanho e espaços', () => {
  const t = validateTemplate({ name: '  Meu modelo ', public: true, items: [item({ cat: 'cat-166', size: 'p', summary: '  Implementação {EPICO} ' })] }, CATALOG);
  assert.deepEqual(t, { name: 'Meu modelo', public: true, items: [{ cat: 'CAT-166', size: 'P', summary: 'Implementação {EPICO}', description: 'Desc {EPICO}' }] });
});

test('descrição ausente vira texto vazio; public precisa ser booleano', () => {
  const t = validateTemplate({ name: 'X', public: false, items: [{ cat: 'CAT-105', size: 'P', summary: 'A' }] }, CATALOG);
  assert.equal(t.items[0].description, '');
  bad({ name: 'X', public: 'sim', items: [item()] }, /público/i);
});

test('limites: nome até 80, 1 a 20 itens, título 255, descrição 2000', () => {
  assert.equal(LIMITS.name, 80);
  bad({ name: '', public: false, items: [item()] }, /nome/i);
  bad({ name: 'x'.repeat(81), public: false, items: [item()] }, /80/);
  bad({ name: 'X', public: false, items: [] }, /20/);
  bad({ name: 'X', public: false, items: Array.from({ length: 21 }, () => item()) }, /20/);
  bad({ name: 'X', public: false, items: [item({ summary: 'x'.repeat(256) })] }, /255/);
  bad({ name: 'X', public: false, items: [item({ summary: '  ' })] }, /título/i);
  bad({ name: 'X', public: false, items: [item({ description: 'x'.repeat(2001) })] }, /2000/);
  validateTemplate({ name: 'x'.repeat(80), public: false, items: Array.from({ length: 20 }, () => item({ summary: 'x'.repeat(255), description: 'y'.repeat(2000) })) }, CATALOG);
});

test('CAT e tamanho precisam existir no catálogo de UST', () => {
  bad({ name: 'X', public: false, items: [item({ cat: 'CAT-999' })] }, /CAT-999.*catálogo/);
  bad({ name: 'X', public: false, items: [item({ cat: 'CAT-166', size: 'G' })] }, /CAT-166.*G/);
  bad({ name: 'X', public: false, items: [item({ cat: 'xyz' })] }, /CAT-123/);
  bad({ name: 'X', public: false, items: [item({ size: 'Enorme' })] }, /tamanho/i);
  assert.throws(() => validateTemplate({ name: 'X', public: false, items: [item()] }, []), /catálogo de UST está vazio/);
});

test('validateTask: mesma regra para tarefas da prévia e da criação', () => {
  assert.deepEqual(validateTask({ cat: 'CAT-105', size: 'P', summary: 'T', description: 'D' }, CATALOG, 'Tarefa 1'), { cat: 'CAT-105', size: 'P', summary: 'T', description: 'D' });
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'G', summary: 'T' }, CATALOG, 'BI-1, tarefa 2'), /^RangeError: BI-1, tarefa 2: /);
  assert.throws(() => validateTask(null, CATALOG, 'Tarefa 1'), RangeError);
});

test('validateTask com truncate corta a descrição em 2000 em vez de recusar', () => {
  const t = validateTask({ cat: 'CAT-105', size: 'P', summary: 'T', description: 'x'.repeat(2500) }, CATALOG, 'T1', { truncate: true });
  assert.equal(t.description.length, 2000);
  assert.throws(() => validateTask({ cat: 'CAT-105', size: 'P', summary: 'T', description: 'x'.repeat(2001) }, CATALOG, 'T1'), /2000/);
});
