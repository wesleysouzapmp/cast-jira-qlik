# App multiusuário + conector MCP: plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano tarefa a tarefa. Os passos usam caixas de seleção (`- [ ]`) para acompanhar o progresso.

**Objetivo.** Transformar o app de usuário único num app para até cerca de 20 colegas. Cada colega tem login próprio e o próprio token do Jira, e acessa por um endereço HTTPS público (DuckDNS + Caddy). O app também ganha um servidor MCP com OAuth para o conector do claude.ai.

**Arquitetura.**
- O mesmo app Express, migrado para Express 5, com SQLite (`node:sqlite`) no lugar dos arquivos JSON.
- Cada requisição autenticada recebe um `req.ctx` com o cliente do Jira e os serviços **daquele** usuário, vindos de um cache por usuário.
- O agendador reaproveita `createAutoScheduler`, com uma *store* no banco por usuário, e um laço global percorre os usuários.
- O MCP usa o SDK oficial: `McpServer` com Streamable HTTP sem estado, e `mcpAuthRouter` com um `OAuthServerProvider` próprio, gravado no banco.

**Tecnologia.**
- Node 24 (ESM), Express 5, `node:sqlite`, `@modelcontextprotocol/sdk` ^1.32 e `zod`.
- Testes com `node --test` e o Jira simulado em `test/fakeJira.js`.
- Caddy, DuckDNS e systemd na VM Oracle (Ubuntu 24.04).

**Spec:** `docs/superpowers/specs/2026-11-25-multiusuario-mcp-design.md`

## Restrições globais

- Fuso fixo -03:00. Datas no formato `AAAA-MM-DD`, horas `HH:MM` e granularidade de 15 minutos, como já é hoje.
- Base do Jira: `JIRA_BASE_URL` do servidor (padrão `https://tjmg.atlassian.net`).
- **Segredos:**
  - token do Jira e chave Anthropic: AES-256-GCM, formato `v1:<iv b64>:<tag b64>:<dados b64>`, chave de 32 bytes em `APP_SECRET_KEY` (base64);
  - senhas: scrypt (N=16384, r=8, p=1, sal de 16 bytes), formato `scrypt$<sal b64>$<hash b64>`;
  - sessões, convites, códigos e tokens OAuth: só o SHA-256 vai para o banco.
- **Cookie de sessão:** `sid`, com `HttpOnly`, `SameSite=Lax`, `Path=/` e `Max-Age=30 dias` (renovado com o uso). `Secure` sempre que `PUBLIC_HOST` estiver definido.
- **Validades:**
  - convite: 7 dias, uso único;
  - redefinição de senha: 24 horas;
  - código OAuth: 10 minutos;
  - token de acesso: 1 hora;
  - token de renovação: 30 dias;
  - prévia do MCP: 30 minutos.
- **Limite de login:** 5 tentativas por (e-mail, IP) a cada 15 minutos.
- **Senha:** mínimo de 10 caracteres.
- **O Node escuta só em `127.0.0.1`.** A checagem de Host aceita `localhost`, `127.0.0.1`, `[::1]` e `PUBLIC_HOST`. A checagem de Origin vale para POST, PUT, PATCH e DELETE.
- **Isolamento:** o `user_id` vem **sempre** da sessão ou do token, nunca do corpo ou da query da requisição. Ids recebidos (de regra, apontamento ou prévia) são conferidos contra o dono.
- **Logs:** nunca imprimem token, senha, cookie ou chave.
- **Textos de interface e mensagens de erro em português**, no tom das telas atuais.
- **`AUTO_WORKLOG=off`** desliga o agendador para todos.
- **Nomes das ferramentas MCP** exatamente como na seção 7 da spec.

## Foco da revisão final

As cinco situações mais prováveis de causar problema que nenhum teste de tarefa cobre diretamente:

1. Um id de outro usuário mandado direto: regra, apontamento ou `previa_id` na URL ou no corpo. A resposta esperada é 404 ou "não encontrado", sem vazar nada (teste na Tarefa 16).
2. Um token do Jira revogado no meio do uso: o agendador marca `invalid` uma vez e para; as telas avisam; o MCP orienta (teste na Tarefa 10).
3. Uma pessoa desativada com o conector já autorizado: o próximo `/mcp` responde 401 (teste na Tarefa 13).
4. O app reiniciado: as sessões e os tokens OAuth continuam valendo, porque estão no banco; as prévias do MCP se perdem e o pedido de confirmação explica isso (teste na Tarefa 14).
5. A migração do admin rodando duas vezes: na segunda vez nada é duplicado e as regras mantêm os ids (teste na Tarefa 17).

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/auth/crypto.js` | `encrypt(text, key)`, `decrypt(blob, key)`, `loadMasterKey(env)` |
| `src/auth/passwords.js` | `hashPassword(pw)`, `verifyPassword(pw, stored)` |
| `src/auth/tokens.js` | `randomToken(bytes=32)`, `sha256(text)` |
| `src/auth/rateLimit.js` | `createRateLimiter({max, windowMs, now})` → `{hit(key), reset(key)}` |
| `src/db/index.js` | `openDb(file)` → `DatabaseSync` com WAL, `foreign_keys` ligado e migrações aplicadas |
| `src/db/migrations.js` | lista ordenada de SQL (`schema_version`) |
| `src/db/users.js` | repositório de usuários, segredos e configurações |
| `src/db/sessions.js` | sessões, convites e redefinições |
| `src/db/userData.js` | favoritos (interface de `favorites.js`) e *store* de regras (interface de `createAutoStore`) por usuário |
| `src/db/oauth.js` | clientes, códigos e tokens OAuth |
| `src/db/audit.js` | `audit.log({userId, via, action, detail})`, `audit.list(userId)` |
| `src/context.js` | `createContextFactory({db, masterKey, baseUrl, holidays, makeClient})` → `{forUser(user), invalidate(userId)}` |
| `src/web/auth.js` | middleware de sessão, rotas de login, logout, convite e redefinição |
| `src/web/account.js` | API de Minha conta |
| `src/web/admin.js` | API de administração |
| `src/server.js` | `createApp(deps)` monta tudo e registra as rotas de API atuais usando `req.ctx` |
| `src/worklog/autoRunner.js` | `createAutoRunner({db, contexts, holidays, now, disabled, log})` → `{tick(), start(), stop(), schedulerFor(userId)}` |
| `src/mcp/oauthProvider.js` | `createOAuthProvider({db, publicUrl})` implementa `OAuthServerProvider` |
| `src/mcp/previews.js` | prévias em memória por usuário, com TTL |
| `src/mcp/tools.js` | `registerTools(server, {ctx, user, ...})` |
| `src/mcp/index.js` | `mountMcp(app, deps)`: rotas OAuth, consentimento e `/mcp` |
| `src/admin.js` | CLI: `bootstrap` (primeiro admin e importação) e `invite` |
| `src/index.js` | carrega o `.env`, abre o banco e liga app, agendador e MCP |
| `public/login.html`, `convite.html`, `conta.html`, `admin.html`, `consentimento.html` e os `.js` de cada uma | telas novas |
| `public/session.js` | cabeçalho com usuário e "Sair", redirecionamento em 401, aviso de token |
| `deploy/oracle/setup.sh`, `Caddyfile.tmpl`, `cast-jira-backup.{service,timer}`, `duckdns.{service,timer}`, `README.md` | implantação |
| `test/helpers/app.js` | `makeTestApp({services?, users?})`: banco em memória, usuário logado, cookie pronto |

---

## Fase A: base

### Task 1: Express 5

**Arquivos:** `package.json`, `src/server.js`, os testes `test/server*.test.js` que quebrarem.

- [ ] Rodar `npm install express@^5`. Esperado: `express` ^5 no `package.json`.
- [ ] Rodar `npm test`. Para cada falha, ajustar ao Express 5:
  - `req.query` passa a ser só leitura;
  - erros assíncronos agora chegam ao *handler* de erro;
  - mudanças de sintaxe em `path-to-regexp`, se houver.
- [ ] Rodar `npm test`. Esperado: 230/230.
- [ ] Commit: `chore: Express 5`.

### Task 2: criptografia, senhas e tokens

**Arquivos:**
- criar `src/auth/crypto.js`, `src/auth/passwords.js` e `src/auth/tokens.js`;
- teste: `test/auth.crypto.test.js`.

**Interfaces:**
- Produz:
  - `encrypt(plain: string, key: Buffer): string` e `decrypt(blob: string, key: Buffer): string`, que lança `Error('decrypt')` se o dado foi adulterado ou a chave é outra;
  - `loadMasterKey(env): Buffer`, que lança se `APP_SECRET_KEY` faltar ou não tiver 32 bytes;
  - `hashPassword(pw): Promise<string>` e `verifyPassword(pw, stored): Promise<boolean>`, esta com `timingSafeEqual`;
  - `randomToken(bytes = 32): string` (base64url) e `sha256(text): string` (hex).

- [ ] Escrever os testes:
  - ida e volta de criptografia;
  - dois `encrypt` do mesmo texto dão resultados diferentes;
  - alterar 1 caractere do bloco faz `decrypt` lançar;
  - chave errada faz `decrypt` lançar;
  - `loadMasterKey` recusa ausente e recusa 16 bytes;
  - `verifyPassword` aceita a senha certa e recusa a errada;
  - o hash começa com `scrypt$`;
  - `randomToken()` tem 43 caracteres e dois tokens seguidos são diferentes.
- [ ] Rodar `node --test test/auth.crypto.test.js`. Esperado: falha por módulo inexistente.
- [ ] Implementar com `node:crypto` (`createCipheriv('aes-256-gcm')`, `scrypt`, `randomBytes`, `createHash`).
- [ ] Rodar o mesmo comando. Esperado: tudo passa.
- [ ] Commit.

### Task 3: banco e migrações

**Arquivos:**
- criar `src/db/index.js` e `src/db/migrations.js`;
- teste: `test/db.migrations.test.js`.

**Interfaces:**
- Produz `openDb(file = ':memory:'): DatabaseSync`, com `PRAGMA journal_mode=WAL` (exceto em memória), `foreign_keys=ON` e as migrações aplicadas.
- As tabelas são exatamente as da seção 4 da spec, mais:
  - `schema_version(version)`;
  - `user_settings(user_id PK, auto_paused INT DEFAULT 0)`;
  - `users.jira_account_id`, coluna em `user_secrets`.
- Índices: `rules(user_id)`, `rule_log(user_id, at)`, `favorites(user_id, key)` único, `oauth_tokens(user_id)`.

- [ ] Escrever os testes:
  - `openDb()` cria todas as tabelas (conferir em `sqlite_master`);
  - abrir duas vezes o mesmo arquivo temporário não reaplica migrações (`schema_version` = N);
  - FK: apagar um usuário apaga regras e favoritos (`ON DELETE CASCADE`).
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 4: repositórios de usuários, sessões e convites

**Arquivos:**
- criar `src/db/users.js` e `src/db/sessions.js`;
- teste: `test/db.users.test.js`.

**Interfaces.** Produz `createUserRepo(db, masterKey)`, com estes métodos:

| Método | Retorno ou efeito |
| --- | --- |
| `create({email, name, role, passwordHash})` | `user` |
| `byId(id)` | `user` |
| `byEmail(email)` | `user` (e-mail normalizado para minúsculas) |
| `list()` | usuários, sem segredos, com `tokenStatus` |
| `setActive(id, active)` | — |
| `setPassword(id, hash)` | — |
| `getSecrets(id)` | `{jiraEmail, jiraToken, anthropicKey, tokenStatus, accountId}` já decifrado; se a decifração falhar, `tokenStatus = 'missing'` |
| `setJira(id, {email, token, accountId})` | grava; `tokenStatus` vira `ok` |
| `setAnthropic(id, key \| null)` | — |
| `markToken(id, status)` | — |
| `getSettings(id)` | configurações do usuário |
| `setAutoPaused(id, bool)` | — |

Produz também `createSessionRepo(db)`, com estes métodos:

| Método | Retorno ou efeito |
| --- | --- |
| `create(userId, userAgent)` | `{token}` (sessão de 30 dias) |
| `resolve(token)` | `{session, user}` ou `null`; expirada ou de usuário inativo vira `null`; renova a validade |
| `destroy(token)` | — |
| `destroyAllFor(userId, exceptToken?)` | — |
| `listFor(userId)` | sessões do usuário |
| `createInvite({role, createdBy, kind, userId?, ttlMs})` | `{token}` |
| `takeInvite(token, kind)` | `invite` ou `null`; marca como usado, de forma atômica |

- [ ] Escrever os testes:
  - os segredos ficam cifrados no banco (o SELECT bruto não contém o token);
  - com outra chave mestra, `getSecrets` devolve `tokenStatus: 'missing'`;
  - sessão expirada (com `now` injetado) dá `null`;
  - usuário inativo dá `null`;
  - convite usado duas vezes: a segunda dá `null`;
  - convite expirado dá `null`;
  - e-mail repetido com caixa diferente lança erro.
- [ ] Ver falhar, implementar com *statements* preparados e ver passar.
- [ ] Commit.

### Task 5: dados por usuário (favoritos e regras)

**Arquivos:**
- criar `src/db/userData.js`;
- teste: `test/db.userData.test.js`.

**Interfaces:**
- Consome a interface de `createFavoritesStore` em `src/worklog/favorites.js`: `{list, add, remove}`, com as mesmas mensagens de RangeError. Consome também a de `createAutoStore` em `src/worklog/auto.js`: `{readRules, writeRules, readLog, writeLog}`.
- Produz:
  - `favoritesFor(db, userId)`: mesma interface do `createFavoritesStore`, com limite de 50;
  - `autoStoreFor(db, userId)`, onde:
    - `readRules()` devolve `{paused, rules}` a partir de `rules` e `user_settings`;
    - `writeRules({paused, rules})` substitui as regras do usuário numa transação, preservando os ids;
    - `readLog()` devolve `{done: {'<ruleId>|<data>': {status, at}}, history: [...]}` a partir de `rule_done` e `rule_log` (os 200 mais novos);
    - `writeLog({done, history})` sincroniza as duas tabelas do usuário;
  - `exportLegacy`/`importLegacy(db, userId, {rules, log, favorites})`, usados na Tarefa 17.

- [ ] Escrever os testes:
  - os dois usuários não enxergam os favoritos nem as regras um do outro;
  - `writeRules` + `readRules` dá ida e volta idêntica, com ids preservados;
  - `writeLog` com 250 registros guarda os 200 mais novos;
  - reaproveitar `test/worklog.autoscheduler.test.js` rodando o agendador com `autoStoreFor` no lugar do `memFs`: os mesmos casos passam (parametrizar o `setup()` do teste).
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

---

## Fase B: web multiusuário

### Task 6: contexto por usuário

**Arquivos:**
- criar `src/context.js`;
- teste: `test/context.test.js`.

**Interfaces:**
- Consome `createJiraClient`, `createSupportService`, `createWorklogService`, `createAiCommenter`, `favoritesFor` e `autoStoreFor`.
- Produz `createContextFactory({db, users, baseUrl, holidays, makeClient = createJiraClient, makeAi = createAiCommenter})`, que devolve:
  - `forUser(user)`, que devolve `{client, supportService, worklogService, ai, favorites, autoStore, secrets}`, ou `{missing: true}` se a pessoa não tem token;
  - `invalidate(userId)`.
- O `client` é encapsulado: uma resposta 401 chama `users.markToken(id, 'invalid')` e `invalidate(id)`, e a resposta segue normalmente.

- [ ] Escrever os testes:
  - dois usuários recebem clientes com credenciais diferentes (conferir o cabeçalho `Authorization` no `makeClient` falso);
  - `forUser` duas vezes devolve o mesmo objeto (cache);
  - `invalidate` faz criar um novo;
  - uma resposta 401 marca `invalid`;
  - sem token, devolve `{missing: true}`.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 7: sessão, login, convite e checagem de Host

**Arquivos:**
- criar `src/web/auth.js`, `src/auth/rateLimit.js`, `public/login.html`, `public/login.js`, `public/convite.html` e `public/convite.js`;
- modificar `src/server.js`;
- teste: `test/web.auth.test.js`.

**Interfaces.** Produz `registerAuth(app, {users, sessions, limiter, config})`, com estas rotas:

| Rota | Comportamento |
| --- | --- |
| `POST /api/login {email, senha}` | cria o cookie; erro genérico 401 "E-mail ou senha inválidos."; 429 depois de 5 tentativas |
| `POST /api/logout` | encerra a sessão |
| `GET /api/me` | `{user: {id, name, email, role}, token: {status}}` |
| `GET /api/convite/:token` | valida o convite |
| `POST /api/convite/:token {nome, email, senha}` | cria a conta e já faz login |
| `POST /api/redefinir/:token {senha}` | troca a senha e encerra as outras sessões |

- Middleware `requireUser`:
  - em `/api/*`, sem sessão: 401 JSON;
  - em página HTML protegida, sem sessão: redireciona para `/login.html?next=`.
- As rotas públicas são `/login.html`, `/convite.html`, `/style.css`, `/api/login`, `/api/convite/*` e `/api/redefinir/*`.
- A checagem de Host aceita `config.publicHost`.
- O app envia os cabeçalhos `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` e `Content-Security-Policy: default-src 'self'` em todas as respostas.

- [ ] Escrever os testes:
  - login certo devolve o cookie com `HttpOnly` e `SameSite=Lax`;
  - senha errada dá 401, sem dizer se o e-mail existe;
  - a sexta tentativa dá 429;
  - `/api/worklog/tasks` sem cookie dá 401;
  - página protegida sem cookie dá 302 para o login;
  - convite: cria o usuário e o segundo uso dá 410;
  - senha curta dá 400;
  - os quatro cabeçalhos de segurança aparecem numa resposta qualquer;
  - `Host: cast-horas.duckdns.org` dá 200 com `publicHost` configurado e 403 sem;
  - POST com Origin de outro site dá 403.
- [ ] Ver falhar, implementar e ver passar. As páginas seguem o estilo de `style.css`.
- [ ] Commit.

### Task 8: rotas atuais sob `req.ctx`

**Arquivos:**
- modificar `src/server.js`;
- criar `test/helpers/app.js`;
- modificar `test/server.test.js`, `test/server.favorites.test.js` e `test/server.auto.test.js`.

**Interfaces:**
- `createApp({config, db, users, sessions, contexts, holidayProvider, autoRunner, limiter})`.
- Os *handlers* atuais trocam `service`, `client`, `favorites` e `scheduler` por `req.ctx.*`:
  - `/api/call` e `/api/paginate` usam `req.ctx.client`;
  - `/api/auto*` usa `autoRunner.schedulerFor(req.user.id)`;
  - `/api/config` devolve `{baseUrl, email: user.email, tokenConfigured: tokenStatus === 'ok'}`.
- Se `req.ctx.missing`, as rotas de Jira dão 409 "Configure seu token do Jira em Minha conta."
- `/api/worklog/submit`, `/api/worklog/batch`, `/api/support/create` e as gravações de `/api/auto/*` chamam `audit.log({via: 'web'})`. O `src/db/audit.js` é criado nesta tarefa e reutilizado na Tarefa 14.
- `makeTestApp({services, user})` monta um banco em memória e um usuário logado. O `contexts.forUser` devolve os `services` falsos que o teste passar. Devolve `{base, json, cookie}`.

- [ ] Escrever o teste: um `submit` pela web gera uma linha em `audit` com `via = web`.
- [ ] Converter os testes de servidor existentes para `makeTestApp`. Eles devem falhar até `createApp` mudar.
- [ ] Mudar `createApp` e o registro das rotas.
- [ ] Rodar `npm test`. Esperado: tudo passa, com o mesmo número de casos ou mais.
- [ ] Commit.

### Task 9: Minha conta e administração

**Arquivos:**
- criar `src/web/account.js`, `src/web/admin.js`, `public/conta.html`, `public/conta.js`, `public/admin.html`, `public/admin.js`, `public/session.js`;
- modificar `public/apoio.html`, `public/apontar.html` e `public/index.html` (incluir `session.js`);
- teste: `test/web.account.test.js`.

**Rotas da conta:**

| Rota | Comportamento |
| --- | --- |
| `GET /api/conta` | `{name, email, jira: {email, status, checkedAt}, anthropic: {configured}, sessions, connectors}` (nunca o token) |
| `PUT /api/conta/jira {email, token}` | chama `GET /rest/api/3/myself` com essas credenciais por um cliente novo; se 200, grava com o `accountId` e invalida o contexto; senão 400 "O Jira recusou esse e-mail/token." |
| `PUT /api/conta/anthropic {key \| null}` | valida a chave com uma chamada mínima à API da Anthropic (no teste, cliente falso); 400 se for recusada. `null` remove |
| `PUT /api/conta/senha {atual, nova}` | troca a senha |
| `DELETE /api/conta/sessoes` | encerra as outras sessões |
| `DELETE /api/conta/conectores/:clientId` | revoga os tokens OAuth do usuário para esse cliente |

**Rotas de administração** (exigem `role = admin`, senão 403):

| Rota | Comportamento |
| --- | --- |
| `GET /api/admin/usuarios` | lista de usuários |
| `POST /api/admin/convites {role}` | `{link}` |
| `POST /api/admin/usuarios/:id/redefinicao` | `{link}` |
| `PUT /api/admin/usuarios/:id/ativo {ativo}` | ao desativar: apaga sessões, revoga tokens OAuth e invalida o contexto |

O admin não pode desativar a si mesmo.

**`session.js`:**
- busca `/api/me` e mostra o nome no cabeçalho, com os links "Minha conta" e "Sair" (e "Usuários" para o admin);
- qualquer `fetch` 401 leva ao login;
- com token `missing` ou `invalid`, mostra uma faixa com link para Minha conta.

- [ ] Escrever os testes:
  - o token salvo nunca aparece em `GET /api/conta`;
  - Jira com resposta 401 dá 400 e nada é gravado;
  - Jira com resposta 200 grava, e o `forUser` seguinte usa o token novo;
  - usuário comum em `/api/admin/*` dá 403;
  - convite gerado pelo admin funciona na Tarefa 7;
  - desativar faz a sessão da pessoa dar 401 na próxima chamada;
  - o admin não consegue desativar a si mesmo.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Verificação manual no mock (depois da Tarefa 17): login, configurar token, convite.
- [ ] Commit.

### Task 10: agendador multiusuário

**Arquivos:**
- criar `src/worklog/autoRunner.js`;
- modificar `src/worklog/auto.js`, se precisar expor algo;
- teste: `test/worklog.autorunner.test.js`.

**Interfaces:**
- Consome `createAutoScheduler({store, service, holidays, now, disabled, log})` (já existe), `autoStoreFor` e `contexts.forUser`.
- Produz `createAutoRunner({db, users, contexts, holidays, now, disabled, log, concurrency = 2})`, que devolve:
  - `schedulerFor(userId)`: um `createAutoScheduler` com cache, `store = autoStoreFor(db, userId)` e `service = ctx.worklogService`;
  - `tick()`: roda o `tick()` dos usuários ativos com `tokenStatus === 'ok'` e não pausados, com no máximo `concurrency` simultâneos;
  - `start()` e `stop()`.
- Pausa por usuário: `user_settings.auto_paused`. A rota `/api/auto/paused` passa a gravar ali, pelo `writeRules({paused})` da *store*.
- Quando o Jira responde 401 durante o `autoLog`, o contexto marca `invalid` (Tarefa 6). No `tick` seguinte o usuário é pulado. O log daquele dia registra `error` com a mensagem "token do Jira inválido".
- Cada gravação feita pelo agendador gera uma linha em `audit` com `via = auto`.

- [ ] Escrever os testes, com 3 usuários e o Jira simulado (`createFakeJira` por usuário):
  - o usuário A, normal, grava;
  - o usuário B, com token inválido (o falso responde 401), recebe um único registro de erro e não aparece mais nos `tick`s seguintes;
  - o usuário C, pausado, não grava nada;
  - o histórico de cada um só contém as próprias regras;
  - `disabled` não grava nada.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

---

## Fase C: MCP

### Task 11: SDK do MCP e repositório OAuth

**Arquivos:**
- `package.json`: adicionar `@modelcontextprotocol/sdk@^1.32` e `zod`;
- criar `src/db/oauth.js`;
- teste: `test/db.oauth.test.js`.

**Interfaces.** Produz `createOAuthRepo(db)`, com estes métodos:

| Método | Retorno ou efeito |
| --- | --- |
| `saveClient(info)` | grava o cliente |
| `getClient(id)` | cliente |
| `saveCode({code, clientId, userId, challenge, redirectUri, scopes})` | grava o código |
| `takeCode(code)` | uso único; respeita a validade |
| `issueTokens({clientId, userId, scopes})` | `{access_token, refresh_token, expires_in: 3600}` |
| `refresh(refreshToken, clientId)` | gira o token de renovação: o antigo é revogado |
| `verify(accessToken)` | `{userId, clientId, scopes, expiresAt}` ou `null` |
| `revoke(token)` | revoga |
| `revokeFor(userId, clientId?)` | revoga tudo do usuário, ou só do cliente |
| `connectorsFor(userId)` | conectores autorizados |

- [ ] Escrever os testes:
  - código usado duas vezes: o segundo dá `null`;
  - código vencido dá `null`;
  - refresh gira o token e o antigo deixa de valer;
  - `verify` de token revogado ou vencido dá `null`;
  - só os hashes estão no banco;
  - `revokeFor(user)` derruba tudo daquele usuário e nada de outro.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 12: provedor OAuth, consentimento e montagem

**Arquivos:**
- criar `src/mcp/oauthProvider.js`, `src/mcp/index.js`, `public/consentimento.html` e `public/consentimento.js`;
- teste: `test/mcp.oauth.test.js`.

**Interfaces:**
- Consome, do SDK, `mcpAuthRouter` (`@modelcontextprotocol/sdk/server/auth/router.js`), `requireBearerAuth` (`.../server/auth/middleware/bearerAuth.js`) e o tipo `OAuthServerProvider` (`.../server/auth/provider.js`).
- Produz `createOAuthProvider({oauth, users, publicUrl})`, com estes membros:

| Membro | Comportamento |
| --- | --- |
| `clientsStore` | `getClient` e `registerClient` |
| `authorize(client, params, res)` | guarda o pedido pendente (memória, 10 minutos, id aleatório) e redireciona para `/consentimento.html?pedido=<id>` |
| `challengeForAuthorizationCode` | devolve o desafio PKCE do código |
| `exchangeAuthorizationCode` | troca o código por tokens |
| `exchangeRefreshToken` | gira o token de renovação |
| `verifyAccessToken` | rejeita se o usuário estiver inativo |
| `revokeToken` | revoga o token |

- Produz também `mountMcp(app, {provider, publicUrl, ...})`:
  - monta `mcpAuthRouter({provider, issuerUrl: publicUrl})`;
  - `GET /api/consentimento/:pedido` devolve `{cliente, escopos}` e exige sessão;
  - `POST /api/consentimento/:pedido {permitir}` gera o código e devolve `{redirect}` para `redirect_uri?code=&state=`, ou `?error=access_denied`;
  - `/mcp` fica atrás de `requireBearerAuth({verifier: provider})`.

- [ ] Escrever o teste de ponta a ponta com HTTP real:
  1. `POST /register` → `GET /authorize` (PKCE S256) → 302 para o consentimento;
  2. login → `POST /api/consentimento/:pedido` → `redirect` com `code`;
  3. `POST /token` → `access_token`;
  4. `POST /mcp` com `initialize` → 200;
  5. sem token → 401;
  6. refresh funciona;
  7. negar → `access_denied`;
  8. `redirect_uri` diferente da registrada → erro.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 13: ferramentas de leitura

**Arquivos:**
- criar `src/mcp/tools.js` (leitura);
- modificar `src/mcp/index.js` (monta `McpServer` e o `StreamableHTTPServerTransport` sem sessão, por requisição);
- teste: `test/mcp.tools.read.test.js`.

**Interfaces:**
- Consome `req.auth` (do `requireBearerAuth`) e `users.byId` mais `contexts.forUser`.
- Produz `registerTools(server, {user, ctx, holidays, today})`. As ferramentas `listar_tarefas`, `buscar_tarefa`, `meus_apontamentos`, `indicadores` e `listar_regras`:
  - têm entrada validada com `zod`;
  - levam `annotations: {readOnlyHint: true}`;
  - devolvem `content: [{type: 'text', text: JSON}]`.
- `indicadores` usa `periodIndicators` e `closingPeriod` (21 a 20) de `src/worklog/time.js`.
- Erros viram `isError: true` com mensagem em português. Sem token: "Configure seu token do Jira em Minha conta: <publicUrl>/conta.html".

- [ ] Escrever os testes, com `Client` do SDK e transporte HTTP contra o app de teste com um token emitido direto no repositório:
  - `tools/list` traz os nomes da spec;
  - as de leitura têm `readOnlyHint`;
  - `meus_apontamentos` com mais de 62 dias dá `isError`;
  - `buscar_tarefa` por texto acha a SIJUD do mês;
  - usuário sem token recebe a mensagem orientando;
  - **usuário desativado depois de emitir o token dá 401**.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 14: ferramentas de gravação e auditoria

**Arquivos:**
- modificar `src/mcp/tools.js`;
- criar `src/mcp/previews.js` (o `src/db/audit.js` já existe desde a Tarefa 8);
- teste: `test/mcp.tools.write.test.js`.

**Interfaces:**
- Produz `createPreviewStore({ttlMs = 30*60e3, now})`, com:
  - `put(userId, preview)`, que devolve um `id`;
  - `take(userId, id)`, que devolve a prévia ou `null` (também `null` se a prévia for de outro usuário ou estiver vencida).
- Ferramentas de gravação, todas com `annotations: {readOnlyHint: false, destructiveHint: true}`:

| Ferramenta | Comportamento |
| --- | --- |
| `gerar_previa` | `worklogService.preview` e `put` (é de leitura, mas cria o estado da prévia) |
| `confirmar_previa` | `take`, depois `worklogService.submit` com os comentários, revalidando sobreposição |
| `apontar` | `worklogService.submit` com uma batida |
| `alterar_apontamento` / `apagar_apontamento` | `worklogService.batch` com `change`/`delete`; o id é conferido entre os apontamentos do usuário |
| `criar_regra` / `alterar_regra` / `pausar_regra` / `excluir_regra` | `schedulerFor(user.id)` |

- Cada gravação chama `audit.log({userId, via: 'mcp', action: <ferramenta>, detail})`, sem comentários longos nem segredos.

- [ ] Escrever os testes:
  - fluxo `gerar_previa` → `confirmar_previa` grava no Jira simulado e muda o status da tarefa de apoio;
  - `confirmar_previa` com o id de outro usuário dá `isError` "Prévia não encontrada";
  - prévia vencida dá `isError`;
  - `apontar` com sobreposição dá `isError` com conflito, sem gravar;
  - `apagar_apontamento` de um worklog de outro autor dá `isError`;
  - cada gravação gera uma linha em `audit`;
  - as anotações estão corretas.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

---

## Fase D: ligação, migração e implantação

### Task 15: ligação em `src/index.js` e mock

**Arquivos:**
- modificar `src/index.js` e `scripts/mock-support.js`;
- modificar `.env.example` (novas variáveis: `APP_SECRET_KEY`, `PUBLIC_HOST`, `DATA_DIR`, `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN`).

**`src/index.js`:**
1. carrega o `.env`;
2. chama `loadMasterKey`, ou encerra com a mensagem "Defina APP_SECRET_KEY no .env (o setup.sh gera)";
3. chama `openDb(DATA_DIR/app.db)` e cria os repositórios, contextos, `autoRunner` e `createApp`;
4. chama `mountMcp`;
5. faz `listen` em `127.0.0.1`.

**Mock:**
- chave mestra aleatória e banco em memória;
- usuários `admin@local` / `teste@local` com senha `senha-teste-123`;
- cada um com o próprio `createFakeJira`;
- a saída no console mostra as credenciais de teste e a URL.

- [ ] Rodar `node --check` nos arquivos e `npm test`. Esperado: tudo passa.
- [ ] Subir o mock: login como teste, configurar token, Apontar horas, regras e Minha conta. Conferir no navegador e no console.
- [ ] Commit.

### Task 16: teste de isolamento ponta a ponta

**Arquivo:** `test/isolation.test.js`.

- [ ] Montar dois usuários com Jiras simulados distintos. O usuário B tenta, com o próprio cookie e com o próprio token MCP:
  - `PUT` e `DELETE` em `/api/auto/rules/<id de A>`;
  - `DELETE /api/worklog/favorites/<chave de A>` (deve só afetar os favoritos dele);
  - `/api/worklog/batch` com o worklog de A;
  - `confirmar_previa` com o `previa_id` de A;
  - `excluir_regra` com o id de A.

  Esperado: 404, `isError` ou nenhum efeito. Os dados de A ficam intactos e o `audit` de A não ganha linhas.
- [ ] Rodar. Se algo passar indevidamente, corrigir na origem (repositório ou rota) com um teste específico.
- [ ] Commit.

### Task 17: CLI de bootstrap e migração

**Arquivos:**
- criar `src/admin.js`;
- teste: `test/admin.bootstrap.test.js`.

**Interfaces.** `node src/admin.js bootstrap`:
1. pergunta e-mail, nome e senha (a senha oculta, via `readline`), ou lê `--email --nome`, com a senha em `ADMIN_PASSWORD` para testes;
2. cria o admin, se ainda não houver nenhum;
3. importa `JIRA_EMAIL`/`JIRA_API_TOKEN` do `.env`, validando com `/myself`;
4. chama `importLegacy` com `agendamentos.json`, `agendamentos-log.json` e `favoritos.json`, preservando os ids;
5. renomeia os arquivos para `.migrado`.

É idempotente: rodar de novo não duplica nada.

`node src/admin.js invite [--admin]` imprime um link de convite.

- [ ] Escrever os testes:
  - a importação preserva os ids e o `done` das regras;
  - a segunda execução não duplica nada e informa "já migrado";
  - sem os arquivos JSON, segue sem erro.
- [ ] Ver falhar, implementar e ver passar.
- [ ] Commit.

### Task 18: implantação (Caddy, DuckDNS, portas, backup)

**Arquivos:**
- modificar `deploy/oracle/setup.sh` e `deploy/oracle/README.md`;
- criar `deploy/oracle/Caddyfile.tmpl`, `cast-jira-backup.service`, `cast-jira-backup.timer`, `duckdns.service` e `duckdns.timer`.

**O `setup.sh` passa a:**
- gerar `APP_SECRET_KEY` (`openssl rand -base64 32`) no `.env`, se faltar;
- criar `DATA_DIR=/opt/cast-jira-qlik/data` com permissão 700;
- instalar o Caddy pelo repositório oficial (`cloudsmith`);
- instalar o `sqlite3`, para o backup;
- **se `PUBLIC_HOST` estiver definido:**
  - escrever `/etc/caddy/Caddyfile` a partir do modelo (`reverse_proxy 127.0.0.1:3100` e os cabeçalhos de segurança);
  - liberar 80/443 no `iptables`, inserindo antes da regra REJECT da imagem Oracle;
  - salvar com `netfilter-persistent`;
  - recarregar o Caddy;
- instalar os timers de backup (diário, guardando 7 em `/var/backups/cast-jira`) e do DuckDNS (a cada 5 minutos, se `DUCKDNS_TOKEN` estiver definido).

**O guia passa a ter:**
- a criação da conta e do subdomínio no DuckDNS;
- como abrir 80/443 na *security list*, com o comando `oci network security-list update` pronto;
- o `bootstrap`;
- como gerar convites;
- como cadastrar o conector no claude.ai;
- o aviso para guardar a `APP_SECRET_KEY` junto com o backup.

- [ ] Rodar `bash -n` nos scripts e repetir o teste em Docker (`ubuntu:24.04`, com `systemctl` simulado) da entrega anterior. Esperado: `Caddyfile` gerado, regras de `iptables` presentes e `.env` com `APP_SECRET_KEY`.
- [ ] Commit.

### Task 19: implantação real e verificação

Esta tarefa não tem código; usa o painel Terminal, a OCI CLI e SSH.

1. **[Usuário]** Criar a conta no DuckDNS e o subdomínio, e me passar o nome e o token. O token o usuário cola sozinho no `.env` da VM, pelo `set-env.sh` estendido ou pelo nano.
2. Abrir 80/443 na *security list* com `oci`, depois de confirmar com o usuário.
3. Na VM: `bash setup.sh` com `PUBLIC_HOST` definido, depois `node src/admin.js bootstrap` como `castjira`.
4. Verificar:
   - `https://<nome>.duckdns.org` com certificado válido;
   - login do admin;
   - regras migradas e a daily do dia seguinte agendada;
   - `curl -I` mostrando os cabeçalhos de segurança.
5. **[Usuário]** Cadastrar o conector no claude.ai e testar `meus_apontamentos` e `indicadores`, e uma gravação com confirmação.
6. Gerar o convite do primeiro colega.

---

## Ordem e dependências

A → B → C → D.

- Dentro de A, as tarefas 2, 3 e 4 são sequenciais, e a 5 depende da 3.
- A Tarefa 8 depende das 6 e 7.
- A Tarefa 10 depende das 5 e 6.
- As tarefas 12 a 14 dependem das 6, 8 e 11.
- A Tarefa 16 depende das 14 e 9.
- A Tarefa 17 depende da 5.
