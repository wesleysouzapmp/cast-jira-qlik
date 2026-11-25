# App multiusuário + conector MCP — design

- **Data:** 25/11/2026.
- **Status:** aprovado em conversa e aguardando revisão desta spec.

## 1. Objetivo

Transformar o app (hoje de uma pessoa só, acessado por túnel SSH) em um app para **até ~20 colegas**.
- Cada colega tem a **própria conta, o próprio token do Jira, os próprios dados e as próprias regras automáticas**.
- Cada colega usa o app de duas formas:
  1. pelas **telas web** atuais, num endereço HTTPS público;
  2. pelo **conector MCP no claude.ai**, conversando com o Claude para apontar horas, consultar indicadores e gerenciar regras.

### Critérios de sucesso

1. Um colega convidado consegue fazer tudo pelo navegador, sem o admin mexer na VM: criar senha, cadastrar o token do Jira e usar Apontar horas, Tarefas de apoio, o calendário e as regras automáticas.
2. Um colega conecta o claude.ai com a URL `https://<nome>.duckdns.org/mcp`, faz login e autoriza. Depois disso, consegue apontar horas na conversa, e cada gravação pede confirmação.
3. Nenhum usuário vê ou grava dados de outro, nem pelas telas, nem pelo MCP, nem pelo agendador. Há testes para isso.
4. As regras, o histórico e os favoritos atuais do admin migram sem interrupção da daily automática.
5. Os 230 testes atuais continuam passando, adaptados para rodar como um usuário.

### Fora do escopo

- Domínio próprio. Depois é só trocar o nome no Caddy.
- Recuperação de senha por e-mail. O admin gera um link de redefinição.
- Jiras além de `tjmg.atlassian.net`. A URL continua sendo configuração do servidor.
- Login com Atlassian (OAuth 3LO).
- Cadastro aberto.

## 2. Decisões

| Tema | Decisão | Motivo |
| --- | --- | --- |
| Usuários | Até ~20, só por convite | Time conhecido |
| Login no app | E-mail e senha próprios (hash scrypt). Convite por link de uso único, válido por 7 dias | Funciona mesmo se o TJMG bloquear apps OAuth da Atlassian |
| Acesso ao Jira | Token de API de cada pessoa, criptografado | Cada um grava com a própria identidade |
| IA nas telas | Chave Anthropic opcional, de cada pessoa | O custo fica com quem usa. No MCP, quem escreve o comentário é o próprio Claude |
| Banco | SQLite via `node:sqlite` (Node 24), arquivo `data/app.db` | Sem dependência nativa; backup é copiar o arquivo |
| HTTPS | DuckDNS (`<nome>.duckdns.org`) + Caddy com Let's Encrypt, portas 80/443 abertas | Sem domínio próprio; endereço fixo, exigido pelo conector |
| MCP | `@modelcontextprotocol/sdk` (≥ 1.32), transporte Streamable HTTP em `/mcp` | SDK oficial, compatível com os conectores remotos do claude.ai |
| Autorização do MCP | O app é o servidor OAuth 2.1 (`mcpAuthRouter` do SDK), com registro dinâmico de cliente e PKCE | É o fluxo que o claude.ai usa |
| Express | Migrar de 4 para **5** | O SDK usa Express 5. Misturar as duas versões é arriscado |
| Entrega | Tudo numa entrega, com fases internas no plano | Escolha do usuário |

## 3. Arquitetura

```
Navegador ──HTTPS──┐                          ┌── Jira do TJMG (token do usuário)
claude.ai ──HTTPS──┤ Caddy :443 ──► Node 127.0.0.1:3100 ─┤
                   │  (Let's Encrypt)          └── Anthropic (chave do usuário, opcional)
                   └ VM Oracle (Ubuntu 24.04, systemd cast-jira)
                                    │
                                    └── data/app.db (SQLite) + .env (APP_SECRET_KEY)
```

### Contexto por requisição

Um middleware de autenticação resolve o `user` de uma de duas fontes:
- o cookie de sessão, nas telas;
- o *bearer token* OAuth, em `/mcp`.

Uma fábrica `userContext(user)` devolve, de um cache por usuário, os objetos de trabalho:
- `jiraClient`, montado com o e-mail e o token **daquele** usuário;
- `supportService`, `worklogService` (com a fila e as listas `written`/`deleted` daquele usuário) e `ai` (com a chave dele, se houver);
- os repositórios de regras, log e favoritos, filtrados por `user_id`.

O cache invalida quando o usuário troca o token ou é desativado. Nenhum serviço guarda referência a outro usuário.

### Módulos novos ou alterados

- **`src/db/`:**
  - abertura do SQLite, migrações versionadas (`schema_version`) e WAL ligado;
  - repositórios `users`, `secrets`, `sessions`, `invites`, `rules`, `ruleLog`, `favorites`, `oauth`, `audit`.
- **`src/auth/`:**
  - `crypto.js`: AES-256-GCM com chave de 32 bytes de `APP_SECRET_KEY` (base64). Formato `v1:iv:tag:dados`;
  - `passwords.js`: scrypt com sal;
  - `sessions.js`: id aleatório de 32 bytes; o banco guarda o hash SHA-256 do id; cookie `sid` com `HttpOnly`, `Secure`, `SameSite=Lax` e validade de 30 dias, renovada com o uso;
  - `rateLimit.js`: 5 tentativas de login por e-mail e IP a cada 15 minutos.
- **`src/mcp/`:**
  - `oauthProvider.js`: implementa o `OAuthServerProvider` do SDK em cima do banco;
  - `tools.js`: as ferramentas;
  - `server.js`: monta `McpServer` e o transporte por requisição, em modo sem estado (*stateless*).
- **`src/worklog/auto.js`:** os *stores* deixam de ser arquivos JSON. O agendador itera pelos usuários ativos com token válido.
- **`src/server.js`:**
  - Express 5;
  - rotas `/login`, `/logout`, `/convite/:token`, `/conta`, `/admin/usuarios`;
  - todas as rotas `/api/*` exigem sessão;
  - a checagem de Host aceita `PUBLIC_HOST` além de `localhost`;
  - a checagem de Origin continua.
- **`public/`:**
  - páginas `login.html`, `convite.html`, `conta.html` e `admin.html`;
  - cabeçalho com o nome do usuário e o botão "Sair";
  - as telas atuais continuam iguais.

## 4. Dados (SQLite)

| Tabela | Campos principais |
| --- | --- |
| `users` | `id`, `email` (único, minúsculo), `name`, `role` (`admin`/`user`), `active`, `password_hash`, `created_at` |
| `user_secrets` | `user_id`, `jira_email`, `jira_token_enc`, `anthropic_key_enc`, `token_status` (`ok`/`invalid`/`missing`), `checked_at` |
| `sessions` | `id_hash`, `user_id`, `expires_at`, `created_at`, `user_agent` |
| `invites` | `token_hash`, `role`, `created_by`, `expires_at`, `used_by`, `used_at`, `kind` (`invite`/`reset`) |
| `rules` | `id`, `user_id`, `key`, `summary`, `start`, `minutes`, `comment`, `since`, `until`, `enabled` |
| `rule_done` | `rule_id`, `date`, `status`, `at` (um dia tratado por regra) |
| `rule_log` | `id`, `user_id`, `rule_id`, `at`, `key`, `date`, `start`, `minutes`, `status`, `message`, `worklog_id` |
| `user_settings` | `user_id`, `auto_paused` |
| `favorites` | `user_id`, `key` |
| `oauth_clients` | `client_id`, `client_secret_hash`, `redirect_uris`, `name`, `created_at` |
| `oauth_codes` | `code_hash`, `client_id`, `user_id`, `code_challenge`, `redirect_uri`, `scopes`, `expires_at` (10 min, uso único) |
| `oauth_tokens` | `token_hash`, `kind` (`access`/`refresh`), `client_id`, `user_id`, `scopes`, `expires_at` (access 1 h, refresh 30 d), `revoked_at` |
| `audit` | `id`, `user_id`, `at`, `via` (`web`/`mcp`/`auto`), `action`, `detail` (JSON sem segredos) |

- Segredos e tokens nunca são gravados em texto claro. Tokens e códigos ficam como hash; credenciais do Jira e da Anthropic ficam criptografadas.
- O log de regras guarda os últimos 200 registros por usuário. O `rule_done` guarda 41 dias.

## 5. Contas e telas

### Admin

A tela **Usuários** mostra a lista com nome, e-mail, papel, ativo e o estado do token (ok, inválido ou ausente). Ela permite:
- **Gerar convite**, com papel `user` ou `admin`, devolvendo um link para copiar;
- **Gerar link de redefinição de senha**;
- **Desativar ou reativar** uma pessoa. Desativar invalida na hora as sessões e os tokens OAuth dela.

O admin **não** vê o token nem os dados de horas de ninguém.

### Convite

`/convite/<token>` pede nome, e-mail e senha (mínimo de 10 caracteres). Depois de concluído, o link fica invalidado, a pessoa já entra logada e cai em "Minha conta".

### Minha conta

- **E-mail e token do Jira:** ao salvar, o app chama `GET /rest/api/3/myself` com essas credenciais. Só grava se a resposta for 200, e guarda o `accountId`. O token nunca volta para a tela; aparece só "configurado em dd/mm".
- **Chave Anthropic** (opcional): validada com uma chamada barata, e com botão para remover.
- **Trocar senha.**
- **Conectores autorizados:** lista os clientes OAuth com data, com botão "Revogar".
- **Sessões ativas,** com botão "Encerrar as outras".

### Telas existentes

- Sem token configurado, mostram só o aviso com link para "Minha conta".
- Com token marcado como inválido, mostram um aviso vermelho.

## 6. Agendador multiusuário

- O laço continua um só, rodando a cada minuto. Ele percorre os usuários `active` com `token_status = ok` e `auto_paused = 0`, e para cada um avalia as regras com o `userContext` do usuário.
- **Erro 401 do Jira:** marca `token_status = invalid`, registra "token do Jira inválido" no log daquele dia e não tenta mais até a pessoa salvar um token novo.
- O `AUTO_WORKLOG=off` desliga o agendador para todos.
- Toda gravação vai para a fila do próprio usuário, então um usuário lento não segura os outros. O laço processa usuários em sequência, com no máximo 2 em paralelo.

## 7. Conector MCP

### Endpoints

Todos vêm do `mcpAuthRouter`:
- `/.well-known/oauth-authorization-server` e `/.well-known/oauth-protected-resource`;
- `/register` (registro dinâmico), `/authorize`, `/token` e `/revoke`;
- `/mcp`, protegido por `requireBearerAuth`.

### `/authorize`

Mostra o login do app se não houver sessão, e depois a tela de consentimento: "**<nome do cliente>** quer acessar e gravar seus apontamentos no Jira." com os botões Permitir e Negar. Ao permitir, gera o código e redireciona para a `redirect_uri` registrada.

As `redirect_uri` aceitas são:
- as que o cliente registrou;
- só HTTPS, ou `http://localhost` para testes.

### Ferramentas

Todas recebem e devolvem datas como `AAAA-MM-DD` e horas como `HH:MM`, no fuso -03:00.

| Ferramenta | Entrada | Saída | Grava |
| --- | --- | --- | --- |
| `listar_tarefas` | — | épicos e tarefas de apoio, favoritos, IA habilitada | não |
| `buscar_tarefa` | `chave` ou `texto` | `{key, summary, status, url}` ou erro | não |
| `meus_apontamentos` | `de`, `ate` (≤ 62 dias) | lista de `{id, tarefa, data, inicio, minutos, comentario}` | não |
| `indicadores` | `de`/`ate` ou `fechamento: "AAAA-MM"` (padrão 21 a 20) | dias úteis trabalhados e a trabalhar, previstas, executadas, saldo | não |
| `gerar_previa` | `itens[{tarefa, horas, por_dia?}]`, `de`, `ate`, `expediente?` | batidas, faltantes, transições previstas, `previa_id` (válido por 30 min) | não |
| `confirmar_previa` | `previa_id`, `comentarios?[{indice, texto}]` | resultado por batida e transições | **sim** |
| `apontar` | `tarefa`, `data`, `inicio`, `duracao`, `comentario?` | worklog criado ou conflito | **sim** |
| `alterar_apontamento` | `id`, `tarefa?`, `data?`, `inicio?`, `duracao?`, `comentario?` | resultado | **sim** |
| `apagar_apontamento` | `id` | resultado | **sim** |
| `listar_regras` | — | regras com próxima execução e última execução | não |
| `criar_regra` / `alterar_regra` | campos da regra (chave ou texto com `{MM/AAAA}`) | regra salva e aviso, se houver | **sim** |
| `pausar_regra` / `excluir_regra` | `id` (e `pausar: bool`) | resultado | **sim** |

- As ferramentas de gravação usam `annotations: { readOnlyHint: false, destructiveHint: true }`, para o claude.ai pedir confirmação. As de leitura usam `readOnlyHint: true`.
- As regras de negócio são as mesmas das telas: sem sobreposição com apontamentos existentes, épico recusado, transição para "Em Execução" só em tarefas de apoio, limite diário e feriados.
- A prévia fica em memória por usuário, com validade de 30 minutos. Na confirmação, o app revalida as sobreposições.
- Erros voltam como `isError: true` com mensagem em português e o próximo passo. Exemplo: "Seu token do Jira está inválido; atualize em Minha conta: https://…/conta."
- Toda chamada de gravação gera um registro em `audit` com `via = mcp`.

## 8. Segurança

- **Exposição:** só o Caddy fica exposto. O Node escuta em `127.0.0.1`. A checagem de Host aceita `PUBLIC_HOST` e localhost; a checagem de Origin vale para os métodos que alteram dados.
- **Cabeçalhos** (Caddy e app): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` e CSP `default-src 'self'` (as telas já não usam inline).
- **Login:**
  - limite de tentativas;
  - mensagem genérica "e-mail ou senha inválidos";
  - comparação em tempo constante;
  - a sessão é regenerada no login.
- **Chave mestra:** `APP_SECRET_KEY` é obrigatória e é gerada pelo `setup.sh` (32 bytes aleatórios). Sem ela, o app não sobe. No mock local, o script gera uma chave temporária.
- **Isolamento:**
  - toda consulta a `rules`, `rule_log`, `favorites`, `oauth_tokens` e `audit` filtra por `user_id` vindo do contexto autenticado, nunca da requisição;
  - os ids de regra e de apontamento recebidos são conferidos contra o dono;
  - para apontamentos, o `author.accountId` tem de ser igual ao `accountId` do usuário.
- **Logs:** nunca imprimem token, senha, cookie nem chave.

## 9. Migração e implantação

- **`setup.sh`:**
  - instala o Caddy (repositório oficial);
  - gera `APP_SECRET_KEY` no `.env` se faltar;
  - abre 80/443 no `iptables` do Ubuntu e salva com `netfilter-persistent`;
  - grava o `Caddyfile` com `PUBLIC_HOST`;
  - instala um timer systemd de backup diário (`sqlite3 .backup`, mantendo os últimos 7, em `/var/backups/cast-jira`).
- **Oracle:** é preciso abrir 80/443 TCP de `0.0.0.0/0` na *security list* da VCN. O guia mostra como, e o `oci` pode fazer isso.
- **DuckDNS:** o usuário cria a conta e o subdomínio. Um timer atualiza o IP a cada 5 minutos usando o token do DuckDNS no `.env` (`DUCKDNS_DOMAIN` e `DUCKDNS_TOKEN`).
- **`node src/admin.js bootstrap`** (rodado uma vez):
  1. cria o primeiro admin (pede e-mail, nome e senha no terminal);
  2. importa `JIRA_EMAIL`/`JIRA_API_TOKEN` do `.env` como segredo do admin;
  3. importa `agendamentos.json`, `agendamentos-log.json` e `favoritos.json` para o admin;
  4. renomeia os JSON para `.migrado`.
- Os ids das regras importadas são preservados, então o `rule_done` evita gravar duas vezes.
- **Modo local, para desenvolvimento:** `node scripts/mock-support.js` sobe com um usuário de teste já logado e o Jira simulado.

## 10. Erros e situações de borda

| Situação | Comportamento |
| --- | --- |
| Token do Jira revogado ou expirado | `token_status = invalid`; aviso nas telas; agendador pula; MCP devolve erro orientando |
| Usuário sem token | Telas e MCP pedem para configurar o token |
| `APP_SECRET_KEY` perdida ou trocada | Os segredos não decifram: o app marca `missing` e pede o token de novo. O guia manda guardar a chave junto com o backup |
| Jira fora do ar ou 5xx | Igual a hoje: erro na tela e no MCP; agendador tenta de novo em 15 minutos |
| Convite expirado ou já usado | Página explica e pede novo link ao admin |
| Usuário desativado | Sessões e tokens OAuth recusados na hora; regras deixam de rodar |
| Prévia MCP expirada ou com sobreposição nova | `confirmar_previa` recusa e pede para gerar de novo |
| Dois cliques ou duas abas gravando ao mesmo tempo | Fila por usuário serializa as gravações |

## 11. Testes

- **Existentes:** adaptados para criar um usuário de teste e chamar as rotas com sessão.
- **Novos (unidade):**
  - `crypto` (ida e volta, adulteração detectada, chave errada);
  - `passwords`;
  - `sessions` (expiração, renovação);
  - `rateLimit`;
  - repositórios (filtro por usuário);
  - migrações.
- **Novos (integração, com Jira simulado):**
  - convite → cadastro → token válido e inválido → telas;
  - **isolamento**: o usuário B não lê nem altera regra, favorito, apontamento ou prévia do A, nem por id direto;
  - agendador com 3 usuários: token inválido, pausado e normal;
  - fluxo OAuth completo: registro → authorize com login e consentimento → token → `/mcp`, refresh, revogação, usuário desativado;
  - cada ferramenta MCP, com as anotações de leitura e gravação conferidas.
- **Ponta a ponta:**
  1. mock local com dois usuários;
  2. VM com o admin real só em leitura;
  3. conector no claude.ai com o admin;
  4. um colega convidado.

## 12. Riscos e pontos em aberto

- **Bloqueio por IP:** o Jira do TJMG pode passar a bloquear IPs externos. Mitigação: o log mostra 401 ou 403 com a mensagem do Jira.
- **Instância ociosa:** a Oracle pode recuperar VMs Always Free ociosas. Mitigação: o uso aumenta com vários usuários; a recomendação de converter para *Pay As You Go* fica no guia.
- **Disponibilidade do DuckDNS:** é um serviço gratuito e pode ficar fora do ar. Migrar para domínio próprio é trocar `PUBLIC_HOST` e o DNS.
- **Mudanças no conector do claude.ai:** se o fluxo mudar, por exemplo os requisitos de metadados OAuth, fica isolado em `src/mcp/oauthProvider.js` e no SDK.
- **Express 5:** muda algumas assinaturas, como os padrões de rota e `req.query`. A suíte de testes cobre.
