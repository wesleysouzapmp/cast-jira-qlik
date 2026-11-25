import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyInExecution, IN_EXECUTION } from '../src/shared/taskFilter.js';

const t = (key, status, model = 'analise') => ({ key, status, model });
const epics = [
  { key: 'BI-1', tasks: [t('Q-1', 'Em Execução'), t('Q-2', 'Aberto', 'implementacao')] },
  { key: 'BI-2', tasks: [t('Q-3', 'Concluído')] },
  { key: 'BI-3', tasks: [t('Q-4', ' em execução ')] },
];

test('onlyInExecution mantém só tarefas Em Execução e some com épicos vazios', () => {
  const r = onlyInExecution(epics);
  assert.equal(IN_EXECUTION, 'Em Execução');
  assert.deepEqual(r.epics.map((e) => [e.key, e.tasks.map((x) => x.key)]), [['BI-1', ['Q-1']], ['BI-3', ['Q-4']]]);
  assert.deepEqual(r.hidden, [{ key: 'Q-2', status: 'Aberto', epicKey: 'BI-1' }, { key: 'Q-3', status: 'Concluído', epicKey: 'BI-2' }]);
});

test('onlyInExecution não altera a lista original', () => {
  onlyInExecution(epics);
  assert.equal(epics[0].tasks.length, 2);
});
