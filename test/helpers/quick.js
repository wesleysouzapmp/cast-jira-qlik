// Jira simulado da Parte 2 (espaços com tipo épico, createmeta da tarefa de apoio) e os serviços
// reais de apoio e apontamento em cima dele. Usado por support.quick e server.quick.
import { createFakeJira, epicIssue, taskIssue, ME } from '../fakeJira.js';
import { createSupportService } from '../../src/support/service.js';
import { createWorklogService } from '../../src/worklog/service.js';

const BASE = 'https://x.atlassian.net';
export const PROJECTS = [
  { id: '100', key: 'BI', name: 'Business Intelligence', issueTypes: [{ id: '10000', name: 'Epic', hierarchyLevel: 1 }, { id: '10001', name: 'Story', hierarchyLevel: 0 }] },
  { id: '200', key: 'SIJUD', name: 'SIJUD', issueTypes: [{ id: '3', name: 'Tarefa', hierarchyLevel: 0 }] },
  { id: '300', key: 'DADOS', name: 'Dados', issueTypes: [{ id: '5', name: 'Subtarefa', hierarchyLevel: -1, subtask: true }, { id: '10100', name: 'Épico', hierarchyLevel: 1 }] },
];
export const META = [
  { fieldId: 'summary', name: 'Resumo' },
  { fieldId: 'customfield_10104', name: 'Item do Catálogo', allowedValues: [{ id: '11927', value: 'Business Intelligence', children: [
    { id: '11930', value: 'CAT-105 - Realizar diagnóstico' },
    { id: '12200', value: 'CAT-200 - Revisar painel' },
  ] }, { id: '13000', value: 'Apoio', children: [{ id: '13087', value: 'CAT-87 - Item agrupador (Não será contabilizado)' }] }] },
  { fieldId: 'customfield_10300', name: 'Tamanho', allowedValues: [{ id: '701', value: 'P' }, { id: '702', value: 'M' }, { id: '703', value: 'G' }] },
];

// intercept(req, next): troca a resposta de um pedido (ex.: simular 503, erro de rede ou índice atrasado).
// holidays: { between(from, to) } dos feriados; subtaskStore: fases das subtarefas (padrão em memória).
export function quickSetup({ intercept, holidays, subtaskStore, ...opts } = {}) {
  const jira = createFakeJira({
    issues: [epicIssue('BI-1', 'Aberto', 'Painel de vendas'), taskIssue('QSENSE-1', 'BI-1', 'analise', 'Aberto')],
    worklogs: { 'QSENSE-1': [{ id: '1', author: { accountId: ME }, started: '2026-11-09T08:00:00.000-0300', timeSpentSeconds: 3600 }] },
    projects: PROJECTS, projectPageSize: 2, meta: META, ...opts,
  });
  if (intercept) {
    const next = jira.client.call.bind(jira.client);
    jira.client.call = (req) => intercept(req, next);
  }
  const supportService = createSupportService({ client: jira.client, baseUrl: BASE, ...(subtaskStore ? { subtaskStore } : {}) });
  const worklogService = createWorklogService({ client: jira.client, baseUrl: BASE, supportService, ai: { enabled: false }, ...(holidays ? { holidays } : {}) });
  return { jira, supportService, worklogService, ctx: { supportService, worklogService } };
}

