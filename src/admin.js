// CLI de administração (rodar na VM, uma vez e quando precisar de convites):
//   node src/admin.js bootstrap [--email x --nome y]   cria o 1º admin e migra os dados do modo antigo
//   node src/admin.js invite [--admin]                  imprime um link de convite (7 dias)
// As funções são exportadas para teste; a entrada na linha de comando fica no fim do arquivo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth/passwords.js';
import { importLegacy } from './db/userData.js';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_PASSWORD = 10;
const LEGACY = { rules: 'agendamentos.json', log: 'agendamentos-log.json', favorites: 'favoritos.json' };

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
  }
  return args;
}

// Pergunta no terminal; com hidden=true nada do que é digitado é ecoado.
export function createPrompt({ onInterrupt } = {}) {
  return (question, { hidden = false } = {}) => new Promise((resolve) => {
    let muted = false;
    const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      if (onInterrupt) onInterrupt();
      process.exit(130);
    });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

function firstAdmin(users) {
  const admins = users.list().filter((u) => u.role === 'admin' && u.active);
  admins.sort((a, b) => a.createdAt - b.createdAt || a.email.localeCompare(b.email));
  return admins[0] ?? null;
}

async function readPassword({ env, prompt }) {
  if (env.ADMIN_PASSWORD) {
    if (env.ADMIN_PASSWORD.length < MIN_PASSWORD) throw new Error(`A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`);
    return env.ADMIN_PASSWORD;
  }
  if (!prompt) throw new Error('Defina ADMIN_PASSWORD ou rode em um terminal interativo.');
  const p1 = await prompt('Senha do administrador: ', { hidden: true });
  if (p1.length < MIN_PASSWORD) throw new Error(`A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`);
  const p2 = await prompt('Repita a senha: ', { hidden: true });
  if (p1 !== p2) throw new Error('As senhas não conferem.');
  return p1;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw new Error(`Não foi possível ler ${path.basename(file)}: ${err.message}`);
  }
}

async function importJira({ users, adminId, env, makeJiraClient, baseUrl, log }) {
  const email = env.JIRA_EMAIL?.trim();
  const token = env.JIRA_API_TOKEN?.trim();
  if (!email || !token) {
    log('Jira: JIRA_EMAIL/JIRA_API_TOKEN ausentes; o admin informa o token em "Minha conta".');
    return 'ausente';
  }
  if (users.getSecrets(adminId).jiraToken) { log('Jira: já configurado para o admin.'); return 'ja-configurado'; }
  let res;
  try {
    const client = makeJiraClient({ baseUrl, email, token, maxRetries: 0 });
    res = await client.call({ method: 'GET', path: '/rest/api/3/myself' });
  } catch { res = { status: 0 }; }
  if (res?.status !== 200) {
    log(`AVISO: o Jira não aceitou as credenciais do .env (HTTP ${res?.status ?? 0}); nada foi gravado. Informe o token em "Minha conta".`);
    return 'recusado';
  }
  users.setJira(adminId, { email, token, accountId: typeof res.data?.accountId === 'string' ? res.data.accountId : null });
  log('Jira: credenciais do .env validadas e gravadas (cifradas) para o admin.');
  return 'ok';
}

// ANTHROPIC_API_KEY do modo antigo: gravada (cifrada) para o admin, sem validar e sem imprimir.
// Não sobrescreve uma chave já cadastrada (rodar de novo é seguro).
function importAnthropic({ users, adminId, env, log }) {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return 'ausente';
  if (users.getSecrets(adminId).anthropicKey) { log('Anthropic: chave já configurada para o admin.'); return 'ja-configurado'; }
  users.setAnthropic(adminId, key);
  log('Anthropic: ANTHROPIC_API_KEY do .env gravada (cifrada) para o admin. Remova-a do .env.');
  return 'ok';
}

function hasAppData(db, userId) {
  const n = (sql) => db.prepare(sql).get(userId).n;
  return n('SELECT COUNT(*) AS n FROM rules WHERE user_id = ?') > 0
    || n('SELECT COUNT(*) AS n FROM rule_log WHERE user_id = ?') > 0
    || n('SELECT COUNT(*) AS n FROM rule_done WHERE rule_id IN (SELECT id FROM rules WHERE user_id = ?)') > 0
    || n('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?') > 0;
}

function migratedName(file, now) {
  const base = `${file}.migrado`;
  return fs.existsSync(base) ? `${file}.migrado-${now()}` : base;
}

function importFiles({ db, adminId, rootDir, log, force = false, now = () => Date.now() }) {
  const present = [];
  for (const k of ['rules', 'log', 'favorites']) {
    const file = path.join(rootDir, LEGACY[k]);
    if (fs.existsSync(file)) present.push({ k, file, data: readJson(file) });
  }
  if (!present.length) {
    const names = fs.readdirSync(rootDir);
    const migrated = Object.values(LEGACY).some((n) => names.some((f) => f === `${n}.migrado` || f.startsWith(`${n}.migrado-`)));
    log(migrated ? 'Arquivos antigos: já migrado (nada a importar).' : 'Arquivos antigos: nenhum arquivo antigo para importar.');
    return [];
  }
  if (!force && hasAppData(db, adminId)) {
    log('O admin já tem dados no app; nada foi importado e os arquivos antigos foram mantidos. Use --forcar para substituir pelos arquivos.');
    return [];
  }
  const moved = [];
  for (const { k, file, data } of present) {
    importLegacy(db, adminId, { [k]: data });
    fs.renameSync(file, migratedName(file, now));
    moved.push(LEGACY[k]);
  }
  log(`Arquivos antigos importados e renomeados para .migrado: ${moved.join(', ')}.`);
  return moved;
}

// Em POSIX, recusa rodar como outro usuário do SO que o dono do diretório de dados.
export function checkDataDirOwner(dataDir, { stat = fs.statSync, getuid = process.getuid?.bind(process) } = {}) {
  if (!getuid) return;
  let st;
  try { st = stat(dataDir); } catch { return; }
  if (st.uid !== getuid()) {
    throw new Error(`O diretório ${dataDir} pertence a outro usuário do sistema (uid ${st.uid}). Rode: sudo -u castjira node src/admin.js ...`);
  }
}

export async function runBootstrap({
  db, users, env = process.env, rootDir = PROJECT_DIR, args = {}, prompt, makeJiraClient,
  baseUrl = (env.JIRA_BASE_URL || 'https://tjmg.atlassian.net').replace(/\/+$/, ''), log = console.log,
}) {
  let admin = firstAdmin(users);
  let created = false;
  if (admin) {
    log(`Já existe um administrador (${admin.email}); nenhum outro será criado.`);
  } else {
    const email = String(args.email || (prompt ? await prompt('E-mail do administrador: ') : '')).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido (--email).');
    const name = String(args.nome || (prompt ? await prompt('Nome: ') : '') || email.split('@')[0]).trim();
    const password = await readPassword({ env, prompt });
    admin = users.create({ email, name, role: 'admin', passwordHash: await hashPassword(password) });
    created = true;
    log(`Administrador criado: ${admin.email}.`);
  }

  const jira = await importJira({ users, adminId: admin.id, env, makeJiraClient, baseUrl, log });
  const anthropic = importAnthropic({ users, adminId: admin.id, env, log });
  const imported = importFiles({ db, adminId: admin.id, rootDir, log, force: Boolean(args.forcar) });

  const host = env.PUBLIC_HOST?.trim();
  log('');
  log('Próximos passos:');
  log(`  1. Entre em ${host ? `https://${host}/` : 'http://127.0.0.1:3100/ (ou o endereço público)'} com ${admin.email}.`);
  log('  2. Remova JIRA_EMAIL, JIRA_API_TOKEN e ANTHROPIC_API_KEY do .env (agora ficam cifrados no banco).');
  log('  3. Convide os demais usuários: node src/admin.js invite');
  return { admin, created, jira, anthropic, imported };
}

export function runInvite({ users, sessions, env = process.env, args = {}, log = console.log }) {
  const admin = firstAdmin(users);
  if (!admin) throw new Error('Nenhum administrador: rode primeiro `node src/admin.js bootstrap`.');
  const { token } = sessions.createInvite({
    role: args.admin ? 'admin' : 'user', createdBy: admin.id, kind: 'invite', ttlMs: INVITE_TTL_MS,
  });
  const host = env.PUBLIC_HOST?.trim();
  const origin = host ? `https://${host}` : 'http://127.0.0.1:3100';
  const link = `${origin}/convite.html?token=${encodeURIComponent(token)}`;
  log(link);
  log('Válido por 7 dias, uso único.');
  return link;
}

// ---------- entrada na linha de comando ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd !== 'bootstrap' && cmd !== 'invite') {
    console.log('Uso: node src/admin.js bootstrap [--email x --nome y] [--forcar] | invite [--admin]');
    process.exitCode = 1;
    return;
  }
  try { process.loadEnvFile(path.join(PROJECT_DIR, '.env')); } catch { /* sem .env: usa o ambiente */ }
  const env = process.env;
  const [{ loadMasterKey }, { openDb }, { createUserRepo }, { createSessionRepo }, { createJiraClient }] = await Promise.all([
    import('./auth/crypto.js'), import('./db/index.js'), import('./db/users.js'), import('./db/sessions.js'), import('./jiraClient.js'),
  ]);
  const masterKey = loadMasterKey(env);
  const dataDir = path.resolve(env.DATA_DIR?.trim() || path.join(PROJECT_DIR, 'data'));
  checkDataDirOwner(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch { /* Windows: sem permissões POSIX */ }
  const dbPath = path.join(dataDir, 'app.db');
  console.log(`Banco: ${dbPath}`);
  const db = openDb(dbPath);
  const closeDb = () => { try { db.close(); } catch { /* já fechado */ } };
  try {
    const users = createUserRepo(db, masterKey);
    const sessions = createSessionRepo(db);
    if (cmd === 'bootstrap') {
      await runBootstrap({ db, users, env, args, prompt: createPrompt({ onInterrupt: closeDb }), makeJiraClient: createJiraClient });
    } else {
      runInvite({ users, sessions, env, args });
    }
  } finally {
    closeDb();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Erro: ${err.message}`); process.exit(1); });
}
