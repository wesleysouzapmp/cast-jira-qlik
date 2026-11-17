// Sobe o app com um Jira simulado em memória, para testar as telas "Tarefas de apoio" e
// "Apontar horas" sem gravar nada no Jira real.
// Uso: node scripts/mock-support.js  →  http://localhost:3101/apoio.html  ou  /apontar.html
// BI-9999 simula o Jira recusando a criação de tarefas. Há um apontamento seu às 09:00–10:00
// da segunda-feira da semana atual, para ver o gerador desviando dele.
import { createApp } from '../src/server.js';
import { createSupportService } from '../src/support/service.js';
import { createWorklogService } from '../src/worklog/service.js';
import { createHolidayProvider } from '../src/worklog/holidays.js';
import { createFavoritesStore } from '../src/worklog/favorites.js';
import { createAutoStore, createAutoScheduler } from '../src/worklog/auto.js';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://tjmg.atlassian.net';
const PORT = Number(process.env.PORT) || 3101;
const ME = 'mock-me';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mondayOfThisWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const epic = (key, summary, status) => ({ key, fields: { summary, issuetype: { name: 'Épico', hierarchyLevel: 1 }, status: { name: status }, project: { key: 'BI' } } });
const task = (key, parent, model, status) => ({
  key,
  fields: {
    summary: `${model === 'analise' ? 'Analise' : 'Implementação'} da demanda ${parent}`,
    issuetype: { name: 'Tarefa de apoio', hierarchyLevel: 0 },
    status: { name: status },
    parent: { key: parent },
    timespent: 0,
    customfield_10104: { id: '11927', child: { id: model === 'analise' ? '11930' : '12117' } },
  },
});

const issues = new Map([
  epic('BI-2931', 'CEINJUR - Atualiza Painel "Julgamento de feitos vinculados a Temas"', 'Em Execução'),
  epic('BI-2861', 'CEINFO - CAMPOS ADICIONAIS - QVD_MDI_DESIGNACAO', 'Em Homologação'),
  epic('BI-3001', 'Painel de Inconsistências da Central de Processos', 'Aberto'),
  epic('BI-9999', 'Épico que simula erro do Jira', 'Aberto'),
  epic('BI-2700', 'Épico já concluído, sem tarefas de apoio', 'Concluído'),
  { key: 'BI-3000', fields: { summary: 'História de exemplo', issuetype: { name: 'História', hierarchyLevel: 0 }, status: { name: 'Aberto' }, project: { key: 'BI' } } },
  task('QSENSE-4085', 'BI-2931', 'analise', 'Aberto'),
  task('QSENSE-4086', 'BI-2931', 'implementacao', 'Aberto'),
  task('QSENSE-4057', 'BI-2861', 'analise', 'Concluído'),
  task('QSENSE-4058', 'BI-2861', 'implementacao', 'Concluído'),
  task('QSENSE-5100', 'BI-3001', 'analise', 'Aberto'),
  task('QSENSE-5101', 'BI-3001', 'implementacao', 'Aberto'),
  { key: 'SIJUD-1', fields: { summary: 'Atendimento SIJUD (fora das tarefas de apoio)', issuetype: { name: 'Tarefa', hierarchyLevel: 0 }, status: { name: 'Em Execução' }, project: { key: 'SIJUD' }, timespent: 0 } },
].map((i) => [i.key, i]));
// Semana anterior: segunda 8h (na meta), terça 9h (acima), quarta 3h (abaixo) — para ver as cores do calendário.
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const wl = (id, date, hhmm, hours, text) => ({ id: String(id), author: { accountId: ME }, started: `${date}T${hhmm}:00.000-0300`, timeSpentSeconds: hours * 3600, comment: adf(text) });
const prevMon = shift(mondayOfThisWeek(), -7);
const worklogs = {
  'QSENSE-4057': [
    wl(1, mondayOfThisWeek(), '09:00', 1, 'Reunião de entendimento da demanda'),
    wl(2, prevMon, '08:00', 4, 'Levantamento com o usuário-chave'),
    wl(3, shift(prevMon, 1), '08:00', 4, 'Mapeamento das regras de negócio'),
    wl(4, shift(prevMon, 2), '08:00', 3, 'Análise das fontes de dados'),
  ],
  'SIJUD-1': [wl(20, mondayOfThisWeek(), '14:00', 0.5, 'Atendimento ao usuário'), wl(21, shift(mondayOfThisWeek(), 2), '09:07', 1 / 3, 'Batida de timer (20m às 09:07)')],
  'QSENSE-4058': [
    wl(5, prevMon, '13:00', 4, 'Ajustes no script de carga'),
    wl(6, shift(prevMon, 1), '13:00', 5, 'Desenvolvimento de telas no Qlik Sense'),
  ],
};
let nextIssue = 5000;
let nextWl = 100;

const ok = (data, status = 200) => ({ status, ok: true, data });
const seconds = (ts) => (Number(ts.match(/(\d+)h/)?.[1] ?? 0) * 60 + Number(ts.match(/(\d+)m/)?.[1] ?? 0)) * 60;
const startedMs = (s) => Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

const client = {
  async call({ method = 'GET', path, query = {}, body }) {
    if (path === '/rest/api/3/myself') return ok({ accountId: ME, displayName: 'Usuário simulado' });
    if (path === '/rest/api/3/search/jql') {
      const jql = body.jql;
      let list = [];
      if (jql.startsWith('assignee')) list = [...issues.values()].filter((i) => i.fields.project?.key === 'BI');
      else if (jql.startsWith('project = QSENSE')) {
        const keys = jql.match(/parent in \(([^)]*)\)/)[1].split(',').map((s) => s.trim());
        list = [...issues.values()].filter((i) => keys.includes(i.fields.parent?.key));
      } else if (jql.startsWith('worklogAuthor')) {
        const [, from, to] = jql.match(/worklogDate >= "([^"]+)" AND worklogDate <= "([^"]+)"/);
        list = [...issues.values()].filter((i) => (worklogs[i.key] ?? []).some((w) => w.started.slice(0, 10) >= from && w.started.slice(0, 10) <= to));
      }
      return ok({ issues: list, isLast: true });
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
      const list = worklogs[key] ?? [];
      const idx = list.findIndex((w) => w.id === id);
      if (idx < 0) return { status: 404, ok: false, data: { errorMessages: ['Worklog não encontrado'] } };
      await sleep(120);
      if (method === 'GET') return ok(list[idx]);
      if (method === 'DELETE') {
        issues.get(key).fields.timespent -= list[idx].timeSpentSeconds;
        list.splice(idx, 1);
        return { status: 204, ok: true, data: '' };
      }
      if (method === 'PUT') {
        const before = list[idx].timeSpentSeconds;
        Object.assign(list[idx], { started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: seconds(body.timeSpent), comment: body.comment });
        issues.get(key).fields.timespent += list[idx].timeSpentSeconds - before;
        return ok(list[idx]);
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
      const w = { id: String(nextWl++), author: { accountId: ME }, started: body.started, timeSpent: body.timeSpent, timeSpentSeconds: seconds(body.timeSpent), comment: body.comment };
      (worklogs[key] ??= []).push(w);
      issues.get(key).fields.timespent += w.timeSpentSeconds;
      return ok(w, 201);
    }
    if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/))) {
      const issue = issues.get(m[1]);
      const transitions = [{ id: issue.fields.project ? '341' : '181', name: 'Em Execução', to: { name: 'Em Execução' } }];
      if (method === 'GET') return ok({ transitions });
      issue.fields.status = { name: 'Em Execução' };
      return { status: 204, ok: true, data: '' };
    }
    return { status: 404, ok: false, data: { errorMessages: [`Rota não simulada: ${method} ${path}`] } };
  },
};

// IA simulada: devolve frases fixas, sem chamar a API.
const ai = {
  enabled: true,
  async generate(entries) {
    await sleep(300);
    return entries.map((e, i) => `[IA simulada] Atividade ${i + 1} em ${e.taskKey} (${e.minutes} min).`);
  },
};

const supportService = createSupportService({ client, baseUrl: BASE });
const holidayProvider = createHolidayProvider();
const worklogService = createWorklogService({ client, baseUrl: BASE, supportService, ai, holidays: holidayProvider });
const favoritesStore = createFavoritesStore({ file: path.join(os.tmpdir(), 'mock-favoritos.json') });
// Agendamentos do mock em arquivos temporários (não mexem nos agendamentos.json reais).
const autoScheduler = createAutoScheduler({ store: createAutoStore({ file: path.join(os.tmpdir(), 'mock-agendamentos.json'), logFile: path.join(os.tmpdir(), 'mock-agendamentos-log.json') }), service: worklogService, holidays: holidayProvider });
const app = createApp({ client, config: { baseUrl: BASE, email: 'simulado@local', tokenConfigured: true }, supportService, worklogService, holidayProvider, favoritesStore, autoScheduler });
app.listen(PORT, '127.0.0.1', () => { console.log(`Mock em http://localhost:${PORT}/apoio.html e /apontar.html`); autoScheduler.start(); });
