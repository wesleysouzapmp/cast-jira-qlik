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
// - "Gerar com IA" fica desligado (nenhuma chave Anthropic; a validação de chave sempre recusa).
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { createUserRepo } from '../src/db/users.js';
import { createSessionRepo } from '../src/db/sessions.js';
import { createOAuthRepo } from '../src/db/oauth.js';
import { createAuditRepo } from '../src/db/audit.js';
import { favoritesFor } from '../src/db/userData.js';
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
const FIELDS = [{ id: 'summary', name: 'Resumo', custom: false }, { id: 'customfield_10104', name: 'Item do Catálogo', custom: true }, { id: 'customfield_10300', name: 'Tamanho', custom: true }];
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
  const issues = new Map(list.map((i) => [i.key, i]));
  let nextWl = 100;
  const ok = (data, status = 200) => ({ status, ok: true, data });
  const seconds = (ts) => (Number(ts.match(/(\d+)h/)?.[1] ?? 0) * 60 + Number(ts.match(/(\d+)m/)?.[1] ?? 0)) * 60;
  const startedMs = (s) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

  return {
    async call({ method = 'GET', path, query = {}, body }) {
      if (path === '/rest/api/3/myself') return ok({ accountId: me, displayName });
      if (path === '/rest/api/3/field') return ok(FIELDS);
      if (path === '/rest/api/3/search/jql') {
        const jql = body.jql;
        const done = (i) => /^conclu/i.test(i.fields.status?.name ?? '');
        let found = [];
        if (jql.includes('statusCategory = Done')) found = [...issues.values()].filter((i) => done(i) && i.fields.customfield_10104);
        else if (jql.startsWith('assignee')) found = [...issues.values()].filter((i) => i.fields.project?.key === 'BI');
        else if (jql.startsWith('project = QSENSE')) {
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
      if (path === '/rest/api/3/issue/bulkfetch') return ok({ issues: body.issueIdsOrKeys.map((k) => issues.get(k)).filter(Boolean), issueErrors: [] });
      if (path === '/rest/api/3/issue' && method === 'POST') {
        await sleep(400);
        if (body.fields.parent.key === 'BI-9999') return { status: 400, ok: false, data: { errorMessages: [], errors: { customfield_10104: 'Opção selecionada inválida (simulado)' } } };
        const key = `QSENSE-${nextIssue++}`;
        issues.set(key, { key, fields: { summary: body.fields.summary, issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 }, status: { name: 'Aberto' }, parent: { key: body.fields.parent.key }, timespent: 0, customfield_10104: body.fields.customfield_10104 } });
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
