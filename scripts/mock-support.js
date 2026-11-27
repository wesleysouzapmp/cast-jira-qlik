// Sobe o app multiusuário com Jiras simulados em memória, para testar as telas (login, Minha conta,
// Tarefas de apoio, Apontar horas, regras automáticas, administração e o conector MCP) sem gravar
// nada no Jira real nem no banco real.
// Uso: node scripts/mock-support.js  →  http://localhost:3101  (credenciais no console)
//
// - Chave mestra aleatória e banco SQLite em memória: tudo some ao encerrar.
// - Dois usuários: admin@local (admin) e teste@local (user), cada um com o PRÓPRIO Jira simulado
//   (o cliente é escolhido pelo token gravado). Os tokens já vêm cadastrados; em Minha conta é
//   possível regravar com os tokens simulados mostrados no console (outro token = Jira recusa).
// - Jira do admin: BI-9999 simula o Jira recusando a criação de tarefas; há um apontamento às
//   09:00–10:00 da segunda-feira da semana atual, para ver o gerador desviando dele.
// - Tarefas de apoio: createmeta simulado com CAT-105/166/200 (CAT-201 desativado no Jira, para ver
//   o erro) e Tamanho P/M/G/Hora; teste@local começa sem "Pode criar modelos" (ligue em Usuários).
// - Parte 3: BI-3100 já tem agrupadora (QSENSE-6000, CAT-87) com a subtarefa QSENSE-6001; o tipo
//   subtarefa (10010) aparece no createmeta do QSENSE com Item do Catálogo e Tamanho.
// - "Gerar com IA" fica desligado (nenhuma chave Anthropic; a validação de chave sempre recusa).
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createSessionRepo } from '../src/db/sessions.js';
import { createOAuthRepo } from '../src/db/oauth.js';
import { createAuditRepo } from '../src/db/audit.js';
import { favoritesFor } from '../src/db/userData.js';
import { createCatalogRepo } from '../src/db/catalog.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { createContextFactory } from '../src/context.js';
import { createHolidayProvider } from '../src/worklog/holidays.js';
import { createAutoRunner } from '../src/worklog/autoRunner.js';

const BASE = 'https://tjmg.atlassian.net';
const PORT = Number(process.env.PORT) || 3101;
const PUBLIC_URL = `http://localhost:${PORT}`;
const SENHA = 'senha-teste-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mondayOfThisWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const epic = (key, summary, status) => ({ key, fields: { summary, issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: status }, project: { key: 'BI' } } });
// Item do Catálogo (cascata) e Tamanho (customfield_10300, aba Apontamentos) para o indicador de UST.
const task = (key, parent, model, status, size) => ({
  key,
  fields: {
    summary: `${model === 'analise' ? 'Analise' : 'Implementação'} da demanda ${parent}`,
    issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 },
    status: { name: status },
    parent: { key: parent },
    timespent: 0,
    customfield_10104: model === 'analise'
      ? { id: '11927', value: 'Business Intelligence', child: { id: '11930', value: 'CAT-105 - Realizar diagnóstico de incidente, problema, erro ou demanda na solução de BI' } }
      : { id: '11927', value: 'Business Intelligence', child: { id: '12117', value: 'CAT-166 - Manter script de carga do Qlik Sense' } },
    ...(size ? { customfield_10300: { value: size } } : {}),
  },
});
const CAT_OPTIONS = [{ id: '11927', value: 'Business Intelligence', children: [
  { id: '11930', value: 'CAT-105 - Realizar diagnóstico de incidente, problema, erro ou demanda na solução de BI' },
  { id: '12117', value: 'CAT-166 - Manter script de carga do Qlik Sense' },
  { id: '12200', value: 'CAT-200 - Revisar painel do Qlik Sense' },
  { id: '12201', value: 'CAT-201 - Opção desativada (simulada)', disabled: true },
] }, { id: '13000', value: 'Apoio', children: [{ id: '13087', value: 'CAT-87 - Item agrupador (Não será contabilizado)' }] }];
// Tipos do QSENSE no createmeta (Parte 3): Tarefa de apoio e a subtarefa (descoberta pelo subtask: true).
const QSENSE_TYPES = [{ id: '10002', name: 'Tarefa', subtask: false }, { id: '10010', name: 'Subtarefa', subtask: true }];
// Agrupadora (CAT-87, pai = épico) e subtarefa dela (pai = agrupadora), como o app cria.
const group = (key, parent) => ({ key, fields: {
  summary: `Apoio da demanda ${parent}`, issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 }, status: { name: 'Aberto' }, parent: { key: parent }, timespent: 0,
  customfield_10104: { id: '13000', value: 'Apoio', child: { id: '13087', value: 'CAT-87 - Item agrupador (Não será contabilizado)' } },
} });
const subtask = (key, parent, summary, size) => ({ key, fields: {
  summary, issuetype: { name: 'Subtarefa', hierarchyLevel: -1 }, status: { name: 'Aberto' }, parent: { key: parent }, timespent: 0,
  customfield_10104: { id: '11927', value: 'Business Intelligence', child: { id: '12200', value: 'CAT-200 - Revisar painel do Qlik Sense' } },
  customfield_10300: { value: size },
} });
const SIZE_OPTIONS = [{ id: '701', value: 'P' }, { id: '702', value: 'M' }, { id: '703', value: 'G' }, { id: '704', value: 'Hora' }];
const FIELDS = [{ id: 'summary', name: 'Resumo', custom: false }, { id: 'customfield_10104', name: 'Item do Catálogo', custom: true }, { id: 'customfield_10300', name: 'Tamanho', custom: true }];
// Espaços para criar épico pelo calendário (GET /project/search?action=create&expand=issueTypes):
// BI e DADOS têm tipo épico; SIJUD não (fica fora da lista); CPOS simula o Jira exigindo um campo a mais.
const PROJECTS = [
  { id: '10010', key: 'BI', name: 'Business Intelligence', issueTypes: [{ id: '10000', name: 'Epic', hierarchyLevel: 1 }, { id: '10001', name: 'História', hierarchyLevel: 0 }] },
  { id: '10020', key: 'DADOS', name: 'Dados e Indicadores (simulado)', issueTypes: [{ id: '10100', name: 'Épico', hierarchyLevel: 1 }, { id: '10101', name: 'Subtarefa', hierarchyLevel: -1, subtask: true }] },
  { id: '10030', key: 'SIJUD', name: 'SIJUD', issueTypes: [{ id: '10200', name: 'Tarefa', hierarchyLevel: 0 }] },
  { id: '10040', key: 'CPOS', name: 'Espaço que exige campo extra (simulado)', issueTypes: [{ id: '10300', name: 'Epic', hierarchyLevel: 1 }] },
];
const sijud = (key, summary) => ({ key, fields: { summary, issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Em Execução' }, project: { key: 'SIJUD' }, timespent: 0 } });

// Dados do Jira do admin (o conjunto completo do mock antigo).
function adminDataset(me) {
  const wl = (id, date, hhmm, hours, text) => ({ id: String(id), author: { accountId: me }, started: `${date}T${hhmm}:00.000-0300`, timeSpentSeconds: hours * 3600, comment: adf(text) });
  const mon = mondayOfThisWeek();
  // Semana anterior: segunda 8h (na meta), terça 9h (acima), quarta 3h (abaixo) — para ver as cores do calendário.
  const prevMon = shift(mon, -7);
  return {
    issues: [
      epic('BI-2931', 'CEINJUR - Atualiza Painel "Julgamento de feitos vinculados a Temas"', 'Em Execução'),
      epic('BI-2861', 'CEINFO - CAMPOS ADICIONAIS - QVD_MDI_DESIGNACAO', 'Em Homologação'),
      epic('BI-3001', 'Painel de Inconsistências da Central de Processos', 'Aberto'),
      epic('BI-9999', 'Épico que simula erro do Jira', 'Aberto'),
      epic('BI-2700', 'Épico já concluído, sem tarefas de apoio', 'Concluído'),
      epic('BI-3100', 'Painel com tarefa agrupadora (simulado)', 'Em Execução'),
      group('QSENSE-6000', 'BI-3100'),
      subtask('QSENSE-6001', 'QSENSE-6000', 'Analisar - as fontes do painel', 'G'),
      { key: 'BI-3000', fields: { summary: 'História de exemplo', issuetype: { name: 'História', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: 'BI' } } },
      task('QSENSE-4085', 'BI-2931', 'analise', 'Aberto', 'P'),
      task('QSENSE-4086', 'BI-2931', 'implementacao', 'Aberto'),
      task('QSENSE-4057', 'BI-2861', 'analise', 'Concluído', 'M'),
      task('QSENSE-4058', 'BI-2861', 'implementacao', 'Concluído', 'P'),
      task('QSENSE-5100', 'BI-3001', 'analise', 'Aberto'),
      task('QSENSE-5101', 'BI-3001', 'implementacao', 'Aberto'),
      // Dailies mensais, para testar regra automática pelo texto com {MM/AAAA}.
      ...['10', '11'].map((m, n) => sijud(`SIJUD-2763${n}`, `Daily COSARQ - BI - ${m}/2026`)),
      sijud('SIJUD-1', 'Atendimento SIJUD (fora das tarefas de apoio)'),
    ],
    worklogs: {
      'QSENSE-4057': [
        wl(1, mon, '09:00', 1, 'Reunião de entendimento da demanda'),
        wl(2, prevMon, '08:00', 4, 'Levantamento com o usuário-chave'),
        wl(3, shift(prevMon, 1), '08:00', 4, 'Mapeamento das regras de negócio'),
        wl(4, shift(prevMon, 2), '08:00', 3, 'Análise das fontes de dados'),
      ],
      'SIJUD-1': [wl(20, mon, '14:00', 0.5, 'Atendimento ao usuário'), wl(21, shift(mon, 2), '09:07', 1 / 3, 'Batida de timer (20m às 09:07)')],
      'QSENSE-4085': [wl(30, shift(mon, 1), '08:00', 2, 'Diagnóstico inicial')],
      'QSENSE-5100': [wl(31, shift(mon, 1), '10:00', 1, 'Levantamento (tarefa sem Tamanho)')],
      'QSENSE-4058': [
        wl(5, prevMon, '13:00', 4, 'Ajustes no script de carga'),
        wl(6, shift(prevMon, 1), '13:00', 5, 'Desenvolvimento de telas no Qlik Sense'),
      ],
    },
  };
}

// Dados do Jira do teste: conjunto menor e diferente (para ver o isolamento entre usuários).
function testeDataset(me) {
  const wl = (id, date, hhmm, hours, text) => ({ id: String(id), author: { accountId: me }, started: `${date}T${hhmm}:00.000-0300`, timeSpentSeconds: hours * 3600, comment: adf(text) });
  return {
    issues: [
      epic('BI-4100', 'Painel de produtividade das varas (teste)', 'Em Execução'),
      task('QSENSE-7001', 'BI-4100', 'analise', 'Aberto'),
      task('QSENSE-7002', 'BI-4100', 'implementacao', 'Aberto'),
      sijud('SIJUD-500', 'Atendimento de teste'),
    ],
    worklogs: {
      'QSENSE-7001': [wl(1, shift(mondayOfThisWeek(), -7), '08:00', 2, 'Reunião inicial (teste)')],
    },
  };
}

// Jira simulado com estado, no formato do jiraClient ({ status, ok, data }).
function createMockJira({ me, displayName, issues: list, worklogs, nextIssue = 5000 }) {
  // Tudo atribuído ao usuário do mock (a troca de Tamanho só aceita tarefas suas).
  const issues = new Map(list.map((i) => [i.key, { ...i, fields: { assignee: { accountId: me }, ...i.fields } }]));
  let nextWl = 100;
  const ok = (data, status = 200) => ({ status, ok: true, data });
  const seconds = (ts) => (Number(ts.match(/(\d+)h/)?.[1] ?? 0) * 60 + Number(ts.match(/(\d+)m/)?.[1] ?? 0)) * 60;
  const startedMs = (s) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

  return {
    async call({ method = 'GET', path, query = {}, body }) {
      const done = (i) => /^conclu/i.test(i.fields.status?.name ?? '');
      if (path === '/rest/api/3/myself') return ok({ accountId: me, displayName });
      if (path === '/rest/api/3/field') return ok(FIELDS);
      if (path === '/rest/api/3/search/jql') {
        const jql = body.jql;
        let found = [];
        if (jql.startsWith('assignee = currentUser() AND cf[')) {
          // Tela Tamanhos e UST: qualquer status com Item do Catálogo (o mock ignora as datas).
          found = [...issues.values()].filter((i) => i.fields.customfield_10104)
            .map((i) => ({ ...i, fields: { ...i.fields, timespent: (worklogs[i.key] ?? []).reduce((s, w) => s + w.timeSpentSeconds, 0) } }));
        } else if (jql.includes('statusCategory = Done')) found = [...issues.values()].filter((i) => done(i) && i.fields.customfield_10104);
        else if (jql.startsWith('assignee')) found = [...issues.values()].filter((i) => i.fields.project?.key === 'BI' || i.fields.issuetype?.hierarchyLevel === 1);
        else if (jql.includes('parent is EMPTY')) found = [...issues.values()].filter((i) => i.key.startsWith('QSENSE-') && !i.fields.parent && i.fields.customfield_10104 && !done(i));
        else if (jql.startsWith('parent in (')) {
          const keys = jql.match(/parent in \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
          found = [...issues.values()].filter((i) => keys.includes(i.fields.parent?.key));
        } else if (jql.startsWith('project = QSENSE')) {
          const keys = jql.match(/parent in \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
          found = [...issues.values()].filter((i) => keys.includes(i.fields.parent?.key));
        } else if (jql.startsWith('summary ~')) {
          const phrase = jql.match(/^summary ~ "\\"(.*)\\""/)[1].toLowerCase();
          found = [...issues.values()].filter((i) => (i.fields.summary ?? '').toLowerCase().includes(phrase));
        } else if (jql.startsWith('worklogAuthor')) {
          const [, from, to] = jql.match(/worklogDate >= "([^"]+)" AND worklogDate <= "([^"]+)"/);
          found = [...issues.values()].filter((i) => (worklogs[i.key] ?? []).some((w) => w.started.slice(0, 10) >= from && w.started.slice(0, 10) <= to));
          if (jql.includes('statusCategory != Done')) found = found.filter((i) => !done(i) && i.fields.customfield_10104);
        }
        return ok({ issues: found, isLast: true });
      }
      // Campos da criação de "Tarefa de apoio" no QSENSE (paginado como o Jira: fields + total).
      if (path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes') return ok({ startAt: 0, maxResults: 50, total: QSENSE_TYPES.length, issueTypes: QSENSE_TYPES });
      if (path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes/10002' || path === '/rest/api/3/issue/createmeta/QSENSE/issuetypes/10010') {
        const all = [
          { fieldId: 'summary', name: 'Resumo', required: true },
          { fieldId: 'customfield_10104', name: 'Item do Catálogo', required: false, allowedValues: CAT_OPTIONS },
          { fieldId: 'customfield_10300', name: 'Tamanho', required: false, allowedValues: SIZE_OPTIONS },
        ];
        const startAt = Number(query.startAt ?? 0);
        const maxResults = Number(query.maxResults ?? 50);
        return ok({ startAt, maxResults, total: all.length, fields: all.slice(startAt, startAt + maxResults) });
      }
      let em;
      if ((em = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/editmeta$/))) {
        const i = issues.get(em[1]);
        if (!i) return { status: 404, ok: false, data: { errorMessages: ['Tarefa não encontrada'] } };
        // Tarefa concluída: o fluxo não deixa editar o Tamanho (para ver o erro na tela).
        return ok({ fields: done(i) ? {} : { customfield_10300: { allowedValues: SIZE_OPTIONS }, customfield_10104: { allowedValues: CAT_OPTIONS } } });
      }
      if ((em = path.match(/^\/rest\/api\/3\/issue\/([^/]+)$/)) && method === 'PUT') {
        await sleep(300);
        const i = issues.get(em[1]);
        if (!i) return { status: 404, ok: false, data: { errorMessages: ['Tarefa não encontrada'] } };
        if (body.fields?.customfield_10300) {
          const opt = SIZE_OPTIONS.find((o) => o.id === body.fields.customfield_10300.id);
          if (!opt) return { status: 400, ok: false, data: { errorMessages: ['Valor inválido (simulado)'] } };
          i.fields.customfield_10300 = { value: opt.value };
        }
        if (body.fields?.customfield_10104) {
          const parent = CAT_OPTIONS.find((o) => o.id === body.fields.customfield_10104.id);
          const child = parent?.children.find((c) => c.id === body.fields.customfield_10104.child?.id);
          if (!child) return { status: 400, ok: false, data: { errorMessages: ['Item do Catálogo inválido (simulado)'] } };
          i.fields.customfield_10104 = { id: parent.id, value: parent.value, child: { id: child.id, value: child.value } };
        }
        return { status: 204, ok: true, data: '' };
      }
      if (path === '/rest/api/3/project/search') {
        const startAt = Number(query.startAt ?? 0);
        const maxResults = Math.min(Number(query.maxResults ?? 50), 2); // páginas pequenas para exercitar a paginação
        const values = query.expand === 'issueTypes' ? PROJECTS.slice(startAt, startAt + maxResults) : PROJECTS.slice(startAt, startAt + maxResults).map(({ issueTypes, ...p }) => p);
        return ok({ startAt, maxResults, total: PROJECTS.length, isLast: startAt + maxResults >= PROJECTS.length, values });
      }
      if (path === '/rest/api/3/issue/bulkfetch') return ok({ issues: body.issueIdsOrKeys.map((k) => issues.get(k)).filter(Boolean), issueErrors: [] });
      if (path === '/rest/api/3/issue' && method === 'POST') {
        await sleep(400);
        // Épico (tipo hierarchyLevel 1 do projeto pelo id): CPOS recusa como um campo obrigatório extra.
        const project = PROJECTS.find((p) => p.id === String(body.fields.project?.id ?? ''));
        const epicType = project?.issueTypes.find((t) => t.id === String(body.fields.issuetype?.id ?? '') && t.hierarchyLevel === 1);
        if (project) {
          if (!epicType) return { status: 400, ok: false, data: { errorMessages: [], errors: { issuetype: 'Tipo de item inválido (simulado)' } } };
          if (project.key === 'CPOS') return { status: 400, ok: false, data: { errorMessages: [], errors: { customfield_19999: 'Área responsável é obrigatório (simulado)' } } };
          const key = `${project.key}-${nextIssue++}`;
          issues.set(key, { key, fields: { summary: body.fields.summary, assignee: { accountId: me }, issuetype: { name: epicType.name, hierarchyLevel: 1 }, status: { name: 'Aberto' }, project: { key: project.key } } });
          return ok({ id: String(90000 + nextIssue), key }, 201);
        }
        if (body.fields.parent?.key === 'BI-9999') return { status: 400, ok: false, data: { errorMessages: [], errors: { customfield_10104: 'Opção selecionada inválida (simulado)' } } };
        // Opções pelo id, como o Jira: cascata do Item do Catálogo e Tamanho (customfield_10300).
        const catIn = body.fields.customfield_10104;
        const parentOpt = CAT_OPTIONS.find((o) => o.id === catIn?.id);
        const childOpt = parentOpt?.children.find((c) => c.id === catIn?.child?.id && !c.disabled);
        if (!childOpt) return { status: 400, ok: false, data: { errorMessages: [], errors: { customfield_10104: 'Item do Catálogo inválido (simulado)' } } };
        const sizeOpt = SIZE_OPTIONS.find((o) => o.id === body.fields.customfield_10300?.id);
        const isGroup = childOpt.id === '13087';
        const isSub = String(body.fields.issuetype?.id) === '10010';
        if (isSub && !issues.get(body.fields.parent?.key)) return { status: 400, ok: false, data: { errorMessages: [], errors: { parent: 'Pai da subtarefa inválido (simulado)' } } };
        if (!sizeOpt && !isGroup) return { status: 400, ok: false, data: { errorMessages: [], errors: { customfield_10300: 'Tamanho inválido (simulado)' } } };
        const key = `QSENSE-${nextIssue++}`;
        issues.set(key, { key, fields: {
          summary: body.fields.summary, assignee: { accountId: me }, issuetype: isSub ? { name: 'Subtarefa', hierarchyLevel: -1 } : { name: 'Tarefa de apoio', hierarchyLevel: 0 }, status: { name: 'Aberto' }, ...(body.fields.parent ? { parent: { key: body.fields.parent.key } } : {}), project: { key: 'QSENSE' }, timespent: 0,
          customfield_10104: { id: parentOpt.id, value: parentOpt.value, child: { id: childOpt.id, value: childOpt.value } },
          ...(sizeOpt ? { customfield_10300: { value: sizeOpt.value } } : {}),
        } });
        return ok({ id: String(90000 + nextIssue), key }, 201);
      }
      let m;
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog\/(\d+)$/))) {
        const [, key, id] = m;
        const wls = worklogs[key] ?? [];
        const idx = wls.findIndex((w) => w.id === id);
        if (idx < 0) return { status: 404, ok: false, data: { errorMessages: ['Worklog não encontrado'] } };
        await sleep(120);
        if (method === 'GET') return ok(wls[idx]);
        if (method === 'DELETE') {
          issues.get(key).fields.timespent -= wls[idx].timeSpentSeconds;
          wls.splice(idx, 1);
          return { status: 204, ok: true, data: '' };
        }
        if (method === 'PUT') {
          const before = wls[idx].timeSpentSeconds;
          Object.assign(wls[idx], { started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: seconds(body.timeSpent), comment: body.comment });
          issues.get(key).fields.timespent += wls[idx].timeSpentSeconds - before;
          return ok(wls[idx]);
        }
      }
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/))) {
        const key = m[1];
        if (method === 'GET') {
          const after = Number(query.startedAfter ?? 0);
          const before = Number(query.startedBefore ?? Infinity);
          return ok({ worklogs: (worklogs[key] ?? []).filter((w) => startedMs(w.started) >= after && startedMs(w.started) < before) });
        }
        await sleep(150);
        const w = { id: String(nextWl++), author: { accountId: me }, started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: seconds(body.timeSpent), comment: body.comment };
        (worklogs[key] ??= []).push(w);
        issues.get(key).fields.timespent += w.timeSpentSeconds;
        return ok(w, 201);
      }
      if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/))) {
        const issue = issues.get(m[1]);
        if (!issue) return { status: 404, ok: false, data: { errorMessages: ['Issue não encontrada (simulado)'] } };
        const transitions = [{ id: issue.fields.project ? '341' : '181', name: 'Em Execução', to: { name: 'Em Execução' } }];
        if (method === 'GET') return ok({ transitions });
        issue.fields.status = { name: 'Em Execução' };
        return { status: 204, ok: true, data: '' };
      }
      return { status: 404, ok: false, data: { errorMessages: [`Rota não simulada: ${method} ${path}`] } };
    },
  };
}

// Um Jira simulado por usuário, escolhido pelas credenciais (e-mail + token).
const MOCK_USERS = [
  { email: 'admin@local', name: 'Admin Simulado', role: 'admin', token: 'mock-token-admin', me: 'mock-admin', dataset: adminDataset },
  { email: 'teste@local', name: 'Teste Simulado', role: 'user', token: 'mock-token-teste', me: 'mock-teste', dataset: testeDataset, nextIssue: 8000 },
];
const jiras = new Map(MOCK_USERS.map((u) => [`${u.email}|${u.token}`, createMockJira({ me: u.me, displayName: u.name, nextIssue: u.nextIssue, ...u.dataset(u.me) })]));
// Credencial desconhecida: o "Jira" responde 401 (como o real com token errado).
const refused = { async call() { return { status: 401, ok: false, data: { message: 'Unauthorized (simulado)' } }; } };
const makeJiraClient = ({ email, token }) => jiras.get(`${String(email).toLowerCase()}|${token}`) ?? refused;

const db = openDb(':memory:');
const users = createUserRepo(db, randomBytes(32));
const sessions = createSessionRepo(db);
const oauth = createOAuthRepo(db);
const audit = createAuditRepo(db);
const holidayProvider = createHolidayProvider();
const contexts = createContextFactory({ db, users, baseUrl: BASE, holidays: holidayProvider, makeClient: makeJiraClient });
const autoRunner = createAutoRunner({ db, users, contexts, holidays: holidayProvider, audit });
const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

const passwordHash = await hashPassword(SENHA);
for (const u of MOCK_USERS) {
  const user = users.create({ email: u.email, name: u.name, role: u.role, passwordHash });
  users.setJira(user.id, { email: u.email, token: u.token, accountId: u.me });
  if (u.role === 'admin') await favoritesFor(db, user.id).add('SIJUD-1');
}

// Catálogo de UST pequeno, para as telas de UST e Tamanhos (dá para reimportar na tela Catálogo).
createCatalogRepo(db).replaceAll([
  { cat: 'CAT-105', size: 'P', ust: 0.4, task: 'Realizar diagnóstico', description: 'Revisão da atividade' },
  { cat: 'CAT-105', size: 'M', ust: 8, task: 'Realizar diagnóstico', description: 'Diagnóstico de Incidente' },
  { cat: 'CAT-166', size: 'P', ust: 8, task: 'Manter script de carga do Qlik Sense', description: 'Script de carga do Qlik Sense' },
  { cat: 'CAT-200', size: 'P', ust: 2, task: 'Revisar painel do Qlik Sense', description: 'Revisão pequena' },
  { cat: 'CAT-200', size: 'G', ust: 6, task: 'Revisar painel do Qlik Sense', description: 'Revisão grande' },
  { cat: 'CAT-201', size: 'M', ust: 3, task: 'Opção desativada no Jira', description: 'Para ver o erro de opção desativada' },
], null);

const app = createApp({
  config: { baseUrl: BASE },
  db, users, sessions, contexts, holidayProvider, autoRunner, limiter, audit, oauth,
  makeJiraClient,
  validateAnthropicKey: async () => false,
  mcp: { publicUrl: PUBLIC_URL },
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock em ${PUBLIC_URL}  (/apoio.html, /apontar.html, /conta.html; conector MCP em ${PUBLIC_URL}/mcp)`);
  console.log('Usuários de teste (senha igual para os dois):');
  for (const u of MOCK_USERS) console.log(`  ${u.email.padEnd(12)} ${u.role.padEnd(5)} senha ${SENHA}  token Jira simulado ${u.token}`);
  console.log('Banco em memória: tudo some ao encerrar.');
  autoRunner.start();
});
