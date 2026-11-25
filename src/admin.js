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
export function createPrompt() {
  return (question, { hidden = false } = {}) => new Promise((resolve) => {
    let muted = false;
    const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

function firstAdmin(users) {
  return users.list().find((u) => u.role === 'admin' && u.active) ?? null;
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

function importFiles({ db, adminId, rootDir, log }) {
  const present = {};
  for (const [k, name] of Object.entries(LEGACY)) {
    const file = path.join(rootDir, name);
    if (fs.existsSync(file)) present[k] = { file, data: readJson(file) };
  }
  const kinds = Object.keys(present);
  if (!kinds.length) { log('Arquivos antigos: já migrado (nada a importar).'); return []; }
  importLegacy(db, adminId, {
    rules: present.rules?.data, log: present.log?.data, favorites: present.favorites?.data,
  });
  const moved = [];
  for (const k of kinds) {
    fs.renameSync(present[k].file, `${present[k].file}.migrado`);
    moved.push(LEGACY[k]);
  }
  log(`Arquivos antigos importados e renomeados para .migrado: ${moved.join(', ')}.`);
  return moved;
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
  const imported = importFiles({ db, adminId: admin.id, rootDir, log });

  const host = env.PUBLIC_HOST?.trim();
  log('');
  log('Próximos passos:');
  log(`  1. Entre em ${host ? `https://${host}/` : 'http://127.0.0.1:3100/ (ou o endereço público)'} com ${admin.email}.`);
  log('  2. Remova JIRA_EMAIL e JIRA_API_TOKEN do .env (o token agora fica cifrado no banco).');
  log('  3. Convide os demais usuários: node src/admin.js invite');
  return { admin, created, jira, imported };
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
  try { process.loadEnvFile(path.join(PROJECT_DIR, '.env')); } catch { /* sem .env: usa o ambiente */ }
  const env = process.env;
  const [{ loadMasterKey }, { openDb }, { createUserRepo }, { createSessionRepo }, { createJiraClient }] = await Promise.all([
    import('./auth/crypto.js'), import('./db/index.js'), import('./db/users.js'), import('./db/sessions.js'), import('./jiraClient.js'),
  ]);
  const masterKey = loadMasterKey(env);
  const dataDir = path.resolve(env.DATA_DIR?.trim() || path.join(PROJECT_DIR, 'data'));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(path.join(dataDir, 'app.db'));
  const users = createUserRepo(db, masterKey);
  const sessions = createSessionRepo(db);
  if (cmd === 'bootstrap') {
    await runBootstrap({ db, users, env, args, prompt: createPrompt(), makeJiraClient: createJiraClient });
  } else if (cmd === 'invite') {
    runInvite({ users, sessions, env, args });
  } else {
    console.log('Uso: node src/admin.js bootstrap [--email x --nome y] | invite [--admin]');
    process.exitCode = 1;
  }
  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Erro: ${err.message}`); process.exit(1); });
}
