import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyWorkable, WORKABLE } from '../src/shared/taskFilter.js';

const t = (key, status, model = 'analise') => ({ key, status, model });
const epics = [
  { key: 'BI-1', tasks: [t('Q-1', 'Em Execução'), t('Q-2', 'Aberto', 'implementacao')] },
  { key: 'BI-2', tasks: [t('Q-3', 'Concluído')] },
  { key: 'BI-3', tasks: [t('Q-4', ' em execução '), t('Q-5', 'Em Homologação')] },
];

test('onlyWorkable mantém tarefas Em Execução e Aberto e some com épicos vazios', () => {
  const r = onlyWorkable(epics);
  assert.deepEqual(WORKABLE, ['Em Execução', 'Aberto']);
  assert.deepEqual(r.epics.map((e) => [e.key, e.tasks.map((x) => x.key)]), [['BI-1', ['Q-1', 'Q-2']], ['BI-3', ['Q-4']]]);
  assert.deepEqual(r.hidden, [{ key: 'Q-3', status: 'Concluído', epicKey: 'BI-2' }, { key: 'Q-5', status: 'Em Homologação', epicKey: 'BI-3' }]);
});

test('onlyWorkable não altera a lista original', () => {
  onlyWorkable(epics);
  assert.equal(epics[0].tasks.length, 2);
});
