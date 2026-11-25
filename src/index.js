// Ponto de entrada do servidor multiusuário: lê o .env, abre o banco em DATA_DIR/app.db,
// monta repositórios, contextos por usuário, agendador e o conector MCP, e escuta só em
// 127.0.0.1 (em produção o Caddy na mesma máquina faz o HTTPS e repassa para cá).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';
import { loadMasterKey } from './auth/crypto.js';
import { createRateLimiter } from './auth/rateLimit.js';
import { openDb } from './db/index.js';
import { createUserRepo } from './db/users.js';
import { createSessionRepo } from './db/sessions.js';
import { createOAuthRepo } from './db/oauth.js';
import { createAuditRepo } from './db/audit.js';
import { createContextFactory } from './context.js';
import { createHolidayProvider } from './worklog/holidays.js';
import { createAutoRunner } from './worklog/autoRunner.js';
import { publicUrlFor } from './mcp/index.js';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

try {
  process.loadEnvFile();
} catch {
  console.warn('Arquivo .env não encontrado. Copie .env.example para .env (ou rode o setup.sh).');
}

let masterKey;
try {
  masterKey = loadMasterKey(process.env);
} catch (err) {
  console.error(`Defina APP_SECRET_KEY no .env (o setup.sh gera). (${err.message})`);
  process.exit(1);
}

const baseUrl = (process.env.JIRA_BASE_URL || 'https://tjmg.atlassian.net').replace(/\/+$/, '');
const port = Number(process.env.PORT) || 3100;
const publicHost = process.env.PUBLIC_HOST?.trim() || undefined;
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(PROJECT_DIR, 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(dataDir, 0o700); } catch { /* Windows: sem permissões POSIX */ }

const db = openDb(path.join(dataDir, 'app.db'));
const users = createUserRepo(db, masterKey);
const sessions = createSessionRepo(db);
const oauth = createOAuthRepo(db);
const audit = createAuditRepo(db);
const holidayProvider = createHolidayProvider();
const contexts = createContextFactory({ db, users, baseUrl, holidays: holidayProvider });
// AUTO_WORKLOG=off no .env desliga o agendador de apontamentos automáticos.
const autoRunner = createAutoRunner({
  db, users, contexts, holidays: holidayProvider, audit,
  disabled: /^(off|0|false|não|nao)$/i.test(process.env.AUTO_WORKLOG?.trim() ?? ''),
});
const limiter = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const config = { baseUrl, publicHost };
const publicUrl = publicUrlFor(config, port);

const app = createApp({
  config, db, users, sessions, contexts, holidayProvider, autoRunner, limiter, audit, oauth,
  mcp: { publicUrl },
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Cast Jira escutando em http://127.0.0.1:${port}`);
  console.log(`URL pública: ${publicUrl}  (conector MCP: ${publicUrl}/mcp)`);
  console.log(`Dados em ${dataDir}`);
  if (users.list().length === 0) console.log('Nenhum usuário: rode `node src/admin.js bootstrap`');
  autoRunner.start();
});
server.on('error', (err) => {
  console.error(`Não foi possível escutar em 127.0.0.1:${port}: ${err.message}`);
  process.exit(1);
});

// Encerramento limpo (systemd manda SIGTERM): para o agendador e fecha o banco.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    autoRunner.stop();
    server.close(() => { try { db.close(); } catch { /* já fechado */ } process.exit(0); });
    server.closeAllConnections?.();
  });
}
