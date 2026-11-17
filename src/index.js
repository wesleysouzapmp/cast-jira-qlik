import { createJiraClient } from './jiraClient.js';
import { createApp } from './server.js';
import { createSupportService } from './support/service.js';
import { createWorklogService } from './worklog/service.js';
import { createAiCommenter } from './worklog/ai.js';
import { createHolidayProvider } from './worklog/holidays.js';
import { createFavoritesStore } from './worklog/favorites.js';
import { createAutoStore, createAutoScheduler } from './worklog/auto.js';

try {
  process.loadEnvFile();
} catch {
  console.warn('Arquivo .env não encontrado. Copie .env.example para .env e preencha e-mail e API token.');
}

const baseUrl = (process.env.JIRA_BASE_URL || 'https://tjmg.atlassian.net').replace(/\/+$/, '');
const email = process.env.JIRA_EMAIL || '';
const token = process.env.JIRA_API_TOKEN || '';
const port = Number(process.env.PORT) || 3100;

const client = createJiraClient({ baseUrl, email, token });
const supportService = createSupportService({ client, baseUrl });
const ai = createAiCommenter({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
const holidayProvider = createHolidayProvider();
const worklogService = createWorklogService({ client, baseUrl, supportService, ai, holidays: holidayProvider });
const tokenConfigured = Boolean(email && token);
// Apontamentos automáticos: AUTO_WORKLOG=off no .env desliga o agendador.
const autoScheduler = createAutoScheduler({ store: createAutoStore(), service: worklogService, holidays: holidayProvider, disabled: /^(off|0|false|não|nao)$/i.test(process.env.AUTO_WORKLOG ?? '') || !tokenConfigured });
const app = createApp({ client, config: { baseUrl, email, tokenConfigured }, supportService, worklogService, holidayProvider, favoritesStore: createFavoritesStore(), autoScheduler });

// Escuta só em localhost: o servidor repassa chamadas autenticadas com o seu token.
app.listen(port, '127.0.0.1', () => {
  console.log(`Jira API Tester em http://localhost:${port}`);
  if (!email || !token) console.log('Atenção: JIRA_EMAIL / JIRA_API_TOKEN não configurados no .env');
  autoScheduler.start();
});
