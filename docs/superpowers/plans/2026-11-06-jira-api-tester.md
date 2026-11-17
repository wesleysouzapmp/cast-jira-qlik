# Jira API Tester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App web local que chama as APIs do Jira Cloud (`tjmg.atlassian.net`), pagina até o fim, achata o JSON em tabelas no estilo do Qlik, exporta CSV e gera o trecho de script de carga do Qlik.

**Architecture:** Express (Node 24, ESM) em `localhost:3000` serve uma página HTML+JS puro e repassa as chamadas ao Jira com auth Basic lida do `.env`. A lógica sem I/O (paginação, achatamento, CSV, script Qlik) fica em módulos puros, testados com `node --test`. `flatten`/`csv`/`qlikScript` ficam em `src/shared/`, servidos ao navegador em `/lib`.

**Tech Stack:** Node 24 (`fetch`, `process.loadEnvFile`, `node:test`), Express 4. Nenhuma outra dependência.

**Spec:** `docs/superpowers/specs/2026-11-06-jira-api-tester-design.md`

## Global Constraints

- Node 24, `"type": "module"`; única dependência de runtime: `express@^4`; sem dependências de dev.
- Porta padrão `3000` (sobrescrita por `PORT` no `.env`).
- `.env`: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. O token nunca sai do backend: não vai em resposta, log nem mensagem de erro.
- Só leitura: só GET e os POSTs de leitura do catálogo (`/rest/api/3/search/jql`, `/rest/api/3/changelog/bulkfetch`, `/rest/api/3/worklog/list`).
- `maxPages` padrão 20.
- 429: até 3 novas tentativas, esperando `Retry-After` segundos (padrão 5 se o header faltar, teto de 60).
- CSV: separador `;`, UTF-8 com BOM (`﻿`), quebra de linha `\r\n`.
- Grade da UI: no máximo 500 linhas exibidas.
- Textos da UI em português.
- Passos de commit só são executados se o usuário autorizar `git init` (a pasta não é um repositório).

## Review Focus

1. **Caminho livre malicioso:** um caminho absoluto (`https://outro.host/...`), um caminho com `..` ou um caminho fora de `/rest/` deve ser recusado com 400, sem enviar o token a outro host. Teste na Task 6.
2. **Resposta não-JSON:** se o Atlassian devolver HTML (página de erro, manutenção), o cliente deve retornar `data` como texto, sem lançar exceção. Teste na Task 1.
3. **Token repetido na paginação:** se o Jira devolver o mesmo `nextPageToken` duas vezes, a paginação deve parar com `stoppedBy: 'loop'` em vez de ficar em laço até `maxPages`. Teste na Task 2.
4. **Resultado vazio** (JQL sem resultados): a paginação deve terminar com `total: 0`, `flatten` deve retornar `{root: []}` e o CSV deve sair só com o BOM. Testes nas Tasks 2 e 3.
5. **Valores com `;`, aspas ou quebra de linha, e registros com colunas diferentes:** o CSV deve citar corretamente e usar a união das colunas, na ordem em que aparecem. Teste na Task 3.

---

## File Structure

```
package.json, .env.example, .gitignore, README.md
src/index.js            entrada: carrega .env, cria client e app, listen
src/server.js           createApp({client, config}) — rotas /api/*, estáticos
src/jiraClient.js       createJiraClient(...) — HTTP, auth, retry 429
src/paginators.js       extractRecords, nextRequest, paginate
src/catalog.js          CATALOG, getEndpoint, buildPath, isAllowed
src/shared/flatten.js   flatten, adfToText          (servido em /lib)
src/shared/csv.js       toCsv                       (servido em /lib)
src/shared/qlikScript.js generateQlikScript         (servido em /lib)
public/index.html, public/app.js, public/style.css
test/*.test.js
```

Forma comum de requisição usada em todo o app (`Request`):
`{ method: 'GET'|'POST', path: string, query: Record<string,string|number>, body: object|null }`.

---

### Task 1: Scaffold + cliente Jira

**Files:**
- Create: `package.json`, `.env.example`, `.gitignore`, `src/jiraClient.js`
- Test: `test/jiraClient.test.js`

**Interfaces:**
- Produces: `createJiraClient({ baseUrl, email, token, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), maxRetries = 3, timeoutMs = 30000 }) -> { call(req: Request) -> Promise<{ status:number, ok:boolean, ms:number, headers:Record<string,string>, data:any, retries:number }> }`
  - `headers` contém só: `content-type`, `retry-after` e todo header que comece com `x-ratelimit` ou `x-arequestid`.
  - Erro de rede ou timeout: resolve com `{ status: 0, ok: false, data: { error: <mensagem> } }`, nunca rejeita.

- [ ] **Step 1: Scaffold**
  - `package.json`: `name: "cast-jira-qlik"`, `"type": "module"`, scripts `start: "node src/index.js"` e `test: "node --test"`, dependência `express@^4`.
  - `.env.example`:
    ```
    JIRA_BASE_URL=https://tjmg.atlassian.net
    JIRA_EMAIL=seu.email@tjmg.jus.br
    JIRA_API_TOKEN=
    PORT=3000
    ```
  - `.gitignore`: `node_modules/` e `.env`.
  - Rode `npm install`.

- [ ] **Step 2: Write failing tests** em `test/jiraClient.test.js`, com `fetchImpl` simulado que registra as chamadas:
  - `sends basic auth and builds url`: chamar `{method:'GET', path:'/rest/api/3/myself', query:{a:1}}` com baseUrl `https://x.atlassian.net/` (barra final). Esperado:
    - URL `https://x.atlassian.net/rest/api/3/myself?a=1`;
    - header `Authorization` igual a `'Basic ' + Buffer.from('e@x:tok').toString('base64')`;
    - `Accept` igual a `application/json`.
  - `POST sends json body`: o body serializado é igual a `JSON.stringify({ids:[1]})` e o `Content-Type` é `application/json`.
  - `retries on 429 using Retry-After`: o fetch simulado devolve 429 (`retry-after: 2`) e depois 200. Esperado: `sleep` chamado com `2000`, `status 200`, `retries 1`.
  - `gives up after maxRetries`: 429 sempre. Esperado: 4 chamadas ao fetch, `status 429`.
  - `non-json body returned as text`: resposta 503 com `content-type: text/html` e corpo `<html>down</html>`. Esperado: `data === '<html>down</html>'`, sem exceção.
  - `network error resolves status 0`: o fetch rejeita com `Error('ECONNRESET')`. Esperado: `{status:0, ok:false}` e `data.error` contendo `ECONNRESET`.
  - `token never in result`: `JSON.stringify(result)` não contém `tok`.

- [ ] **Step 3: Run** `npm test` → FAIL (módulo não existe).
- [ ] **Step 4: Implement** `createJiraClient` em `src/jiraClient.js`. Use `AbortSignal.timeout(timeoutMs)`, faça o parse JSON quando `content-type` contiver `json` (senão, `text()`) e meça o tempo com `performance.now()`.
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat: scaffold and jira client with 429 retry`.

---

### Task 2: Paginação

**Files:**
- Create: `src/paginators.js`
- Test: `test/paginators.test.js`

**Interfaces:**
- Consumes: forma de `call()` da Task 1 (`{status, ok, ms, data}`).
- Produces:
  - `extractRecords(data:any, dataKey:string|null) -> any[]`: com `dataKey`, devolve `data[dataKey] ?? []`; com `dataKey` null, devolve `data` se for array, senão `[data]`.
  - `nextRequest(strategy, { data, request, records, pageSize }) -> Request | null`. As estratégias são:
    - `none` → `null`.
    - `offset` → `null` se:
      - `records.length === 0`;
      - `data.isLast === true`;
      - `typeof data.total === 'number'` e o novo `startAt` ≥ `data.total`;
      - `data` é array e `records.length < pageSize`.
      Senão, devolve o request com `query.startAt = (Number(request.query.startAt) || 0) + records.length`.
    - `token` → `null` se não houver `data.nextPageToken` ou se `data.isLast === true`. Senão, grava `nextPageToken` em `query` (GET) ou em `body` (POST).
    - `worklogUpdated` → `null` se `data.lastPage === true` ou se não houver `data.nextPage`. Senão, `query.since` recebe o parâmetro `since` lido de `new URL(data.nextPage)`.
  - `async paginate({ fetchPage, strategy, dataKey, request, maxPages = 20 }) -> { pages: [{n, status, count, ms}], total, records, stoppedBy: 'end'|'maxPages'|'error'|'loop', error? }`
    - `pageSize` = `request.query.maxResults ?? request.body?.maxResults ?? 50`.
    - Com resposta `!ok`, para com `stoppedBy:'error'` e `error: data`, mantendo as páginas anteriores.
    - Se o próximo `nextPageToken` for igual ao anterior, para com `'loop'`.

- [ ] **Step 1: Write failing tests**, cada um com `fetchPage` simulado que devolve uma sequência de respostas:
  - `offset stops on isLast`: páginas `{values:[1,2], isLast:false}` e `{values:[3], isLast:true}`. Esperado: `total 3`, `stoppedBy 'end'`, segundo request com `query.startAt === 2`.
  - `offset stops on total`: `{issues:[a,b], total:3, startAt:0}` e `{issues:[c], total:3}`. Esperado: 2 páginas.
  - `offset root array stops when short page`: `pageSize 2`, páginas `[u1,u2]` e `[u3]`. Esperado: `total 3`.
  - `token GET puts token in query`: `{issues:[x], nextPageToken:'T1'}` e `{issues:[y], isLast:true}`. Esperado: segundo request com `query.nextPageToken === 'T1'`.
  - `token POST puts token in body`: mesmo cenário com `method:'POST'`. Esperado: `body.nextPageToken === 'T1'`.
  - `worklogUpdated reads since from nextPage`: `{values:[w1], lastPage:false, nextPage:'https://x/rest/api/3/worklog/updated?since=1700000000000'}` e `{values:[w2], lastPage:true}`. Esperado: `query.since === '1700000000000'`.
  - `maxPages stops`: com `isLast` sempre false e `maxPages:2`. Esperado: `stoppedBy 'maxPages'` e 2 páginas.
  - `error keeps previous pages`: página 1 ok, página 2 `{ok:false, status:400, data:{errorMessages:['x']}}`. Esperado: `stoppedBy 'error'`, `total` igual à contagem da página 1.
  - `repeated token stops with loop` (Review Focus 3): `nextPageToken:'T1'` duas vezes seguidas. Esperado: `stoppedBy 'loop'`.
  - `empty result` (Review Focus 4): `{issues:[], isLast:true}`. Esperado: `total 0`, `stoppedBy 'end'`.
- [ ] **Step 2: Run** `node --test test/paginators.test.js` → FAIL.
- [ ] **Step 3: Implement** em `src/paginators.js`. Não mute o `request` recebido; clone `query` e `body` a cada página.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: pagination strategies`.

---

### Task 3: Achatamento + CSV (compartilhados)

**Files:**
- Create: `src/shared/flatten.js`, `src/shared/csv.js`
- Test: `test/flatten.test.js`, `test/csv.test.js`

**Interfaces:**
- Produces:
  - `adfToText(node) -> string`: concatena os `text` em profundidade e insere `\n` entre blocos `paragraph`/`heading`/`listItem`; o resultado sai com `trim`.
  - `isAdf(v) -> boolean`: `v?.type === 'doc' && Array.isArray(v.content)`.
  - `flatten(records:any[], rootName = 'root') -> Record<string, object[]>`
    - Cada linha recebe `__id`. Na raiz, `__id` = índice em string (`'0'`, `'1'`). Nas filhas, `__id` = `${parentId}.${i}`, e a linha tem também `__parent_id` e `__index`.
    - Objetos aninhados viram colunas `a.b.c`; ADF vira texto na coluna do próprio campo; array de escalares vira `join(';')`; array vazio vira `''`.
    - Array de objetos vira a tabela `${tableName}.${path}` (por exemplo `root.fields.components`), recursivamente.
    - Escalar no topo (por exemplo, registro string) vira `{__id, value}`.
    - A tabela raiz sempre existe (`{root: []}` para entrada vazia).
  - `toCsv(rows:object[]) -> string`
    - Colunas: união das chaves na ordem da primeira aparição.
    - Formato: BOM + cabeçalho + linhas, separador `;` e `\r\n`.
    - Cite com `"` (e duplique as aspas internas) todo valor que contenha `;`, `"`, `\r` ou `\n`.
    - `null`/`undefined` viram `''`; objetos viram `JSON.stringify`.
    - Com `rows` vazio, retorna `'﻿'`.

- [ ] **Step 1: Write failing tests**
  - `flattens nested objects`: `flatten([{key:'A-1', fields:{status:{name:'Done'}}}])`. Esperado: `root[0]` = `{__id:'0', key:'A-1', 'fields.status.name':'Done'}`.
  - `scalar arrays joined`: `{labels:['a','b']}` → `labels === 'a;b'`.
  - `object arrays become child tables`: `{key:'A', fields:{components:[{name:'X'},{name:'Y'}]}}`. Esperado: `root['root.fields.components']` = `[{__id:'0.0', __parent_id:'0', __index:0, name:'X'}, {__id:'0.1', __parent_id:'0', __index:1, name:'Y'}]`, e `root[0]` sem a coluna `fields.components`.
  - `nested child of child`: `{histories:[{items:[{field:'status'}]}]}`. Esperado: existe a tabela `root.histories.items` com `__parent_id '0.0'`.
  - `adf to text`: `{description:{type:'doc', version:1, content:[{type:'paragraph', content:[{type:'text', text:'Olá'}]}, {type:'paragraph', content:[{type:'text', text:'mundo'}]}]}}` → `description === 'Olá\nmundo'`.
  - `empty input` (Review Focus 4): `flatten([])` deepEquals `{root: []}`.
  - `csv quoting and union` (Review Focus 5): `toCsv([{a:'x;y', b:'say "hi"'}, {a:'l1\nl2', c:1}])` é igual a `'﻿a;b;c\r\n"x;y";"say ""hi""";\r\n"l1\nl2";;1'`.
  - `csv empty`: `toCsv([]) === '﻿'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** os dois módulos sem nenhum import de Node, porque também rodam no navegador.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: qlik-style flatten and csv export`.

---

### Task 4: Catálogo de endpoints

**Files:**
- Create: `src/catalog.js`
- Test: `test/catalog.test.js`

**Interfaces:**
- Produces:
  - `CATALOG: Endpoint[]`, com `Endpoint = { id, area, label, method, path, pathParams: string[], query: object, body: object|null, pagination: 'none'|'offset'|'token'|'worklogUpdated', dataKey: string|null }`.
  - `getEndpoint(id) -> Endpoint | undefined`.
  - `buildPath(path, params) -> string`: troca `{x}` por `encodeURIComponent(params.x)` e lança `Error('Parâmetro obrigatório: x')` se faltar algum.
  - `isAllowed({method, path}) -> boolean`, que é true se:
    - `method === 'GET'` e `path` começa com `/rest/`, sem `..`, sem `://` e sem começar por `//`; ou
    - `method === 'POST'` e `path` é exatamente um destes: `/rest/api/3/search/jql`, `/rest/api/3/changelog/bulkfetch`, `/rest/api/3/worklog/list`.

- [ ] **Step 1: Write failing tests**
  - `catalog has all spec endpoints`: os `id`s incluem exatamente estes 16:
    `myself, projects, users, statuses, issuetypes, priorities, fields, search-jql, issue-changelog, changelog-bulk, issue-worklog, worklog-updated, worklog-list, boards, board-sprints, sprint-issues`.
  - `entries match spec table`: confere as linhas do catálogo da seção 4 do spec, por exemplo:
    - `search-jql` → `{method:'GET', path:'/rest/api/3/search/jql', pagination:'token', dataKey:'issues'}`, com `query` padrão `{jql:'updated >= -30d ORDER BY updated DESC', fields:'*navigable', maxResults:100}`;
    - `changelog-bulk` → POST, `token`, `issueChangeLogs`, body padrão `{issueIdsOrKeys:[], maxResults:1000}`;
    - `worklog-updated` → `worklogUpdated`, `values`, query `{since:0}`;
    - `sprint-issues` → path `/rest/agile/1.0/sprint/{sprintId}/issue`, `pathParams:['sprintId']`, `offset`, `issues`;
    - `users` → `offset`, `dataKey:null`, query `{maxResults:100}`;
    - `statuses` / `issuetypes` / `priorities` / `fields` → `none`, `dataKey:null`.
  - `buildPath encodes and requires`: `buildPath('/rest/api/3/issue/{key}/worklog', {key:'AB-1'})` é igual a `/rest/api/3/issue/AB-1/worklog`; com `{}`, lança erro.
  - `isAllowed` (Review Focus 1):
    - false para `GET https://evil.com/x`, `GET //evil.com/rest/x`, `GET /rest/../x`, `GET /wiki/x` e `POST /rest/api/3/issue`;
    - true para `GET /rest/api/3/myself` e `POST /rest/api/3/worklog/list`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/catalog.js`:
  - `area` deve ser um destes: `Cadastros`, `Issues`, `Changelog`, `Worklogs`, `Agile`;
  - `label` em português, por exemplo `Buscar issues (JQL)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: endpoint catalog and request guard`.

---

### Task 5: Gerador de script Qlik (compartilhado)

**Files:**
- Create: `src/shared/qlikScript.js`
- Test: `test/qlikScript.test.js`

**Interfaces:**
- Consumes: o formato `Endpoint` (Task 4) e um registro de amostra.
- Produces: `generateQlikScript({ baseUrl, endpoint, request, sampleRecord, connectionName = 'Jira_REST' }) -> string`
  - Cabeçalho:
    - comentário com o endpoint;
    - `LIB CONNECT TO '<connectionName>';`.
  - Colunas: as chaves escalares de topo do `sampleRecord`; sem amostra, o comentário `// Rode a chamada no app para listar as colunas`.
  - Cada valor de `request.query` vira `QUERY "k" "v"`. Com `request.body`, gera `BODY "<json com aspas duplicadas>"` e `HTTPHEADER "Content-Type" "application/json"`.
  - URL = `baseUrl` + `request.path`.
  - Bloco de leitura: `SQL SELECT <colunas> FROM JSON (wrap on) "<dataKey ou root>"` dentro de `WITH CONNECTION ( URL "...", QUERY ... )`.
  - Paginação:
    - `none`: uma chamada.
    - `offset`: `LET vStartAt = 0;` e `DO ... LOOP WHILE` com `QUERY "startAt" "$(vStartAt)"`, incrementando `vStartAt` pelo número de linhas lidas (`NoOfRows`); para quando a página vem vazia.
    - `token`: `LET vNextToken = '';` e um laço que usa `$(vTokenClause)` (vazio na primeira volta, `, QUERY "nextPageToken" "$(vNextToken)"` depois); lê `nextPageToken` de um `SQL SELECT "nextPageToken" FROM JSON (wrap on) "root"` e para quando vem vazio.
    - `worklogUpdated`: igual a `offset`, mas com `QUERY "since" "$(vSince)"`, lendo `nextPage` e `lastPage` e extraindo `since` com `TextBetween(nextPage, 'since=', '&')`.
  - O texto termina com uma linha de comentário avisando que é ponto de partida e que tabelas-filhas devem ser geradas pelo assistente do conector REST.

- [ ] **Step 1: Write failing tests**
  - `none`: endpoint `statuses` com sample `{id:'1', name:'To Do', statusCategory:{}}`. O resultado contém `LIB CONNECT TO 'Jira_REST';`, `"id"`, `"name"` e `URL "https://tjmg.atlassian.net/rest/api/3/status"`; não contém `statusCategory` nem `DO`.
  - `offset`: endpoint `boards`. Contém `QUERY "startAt" "$(vStartAt)"` e `DO`.
  - `token`: endpoint `search-jql`, query com `jql` contendo aspas: `project = "X"`. Contém `vNextToken`, `nextPageToken` e a JQL com as aspas duplicadas: `project = ""X""`.
  - `POST body`: endpoint `worklog-list`, body `{ids:[1,2]}`. Contém `BODY "{""ids"":[1,2]}"`.
  - `custom connection name`: com `connectionName:'Jira_TJMG'`, contém `LIB CONNECT TO 'Jira_TJMG';`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** com um template por estratégia (template strings) e escape de aspas `"` → `""`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: qlik load script generator`.

---

### Task 6: Servidor HTTP

**Files:**
- Create: `src/server.js`, `src/index.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `createJiraClient` (Task 1), `paginate`/`extractRecords` (Task 2), `CATALOG`/`getEndpoint`/`buildPath`/`isAllowed` (Task 4).
- Produces: `createApp({ client, config: { baseUrl, email, tokenConfigured } }) -> express.Application`. Rotas:
  - `GET /api/config` → `{ baseUrl, email, tokenConfigured }`.
  - `GET /api/catalog` → `CATALOG`.
  - `POST /api/call`, com body `{ endpointId?, path?, method?, pathParams?, query?, body? }`:
    - resolve o request pelo catálogo (`endpointId`) ou pelo caminho livre (`path`, `method` padrão GET);
    - `buildPath` falhou ou `isAllowed` deu false → `400 {error}`;
    - sem token configurado → `400 {error:'Token não configurado no .env'}`;
    - senão, devolve o resultado de `client.call` (o status HTTP da rota é sempre 200; o status do Jira vai no corpo).
  - `POST /api/paginate`: o mesmo body mais `maxPages`, `pagination` e `dataKey` (os dois últimos só no modo livre) → resultado de `paginate`.
  - Arquivos estáticos: `public/` em `/` e `src/shared/` em `/lib`.
- `src/index.js`:
  - executa `process.loadEnvFile()` dentro de try/catch (se o `.env` faltar, segue com `tokenConfigured:false`);
  - cria o client e o app e faz `listen(PORT || 3000)`;
  - loga `Jira API Tester em http://localhost:<porta>` (nunca o token).

- [ ] **Step 1: Write failing tests**, subindo `createApp` com client falso numa porta efêmera (`app.listen(0)`) e fazendo as chamadas com `fetch`:
  - `config hides token`: a resposta de `/api/config` não tem a chave `token` e o JSON não contém o valor `tok`.
  - `call by endpointId`: client falso que registra o request. Com `{endpointId:'issue-worklog', pathParams:{key:'AB-1'}}`, o client recebe `path === '/rest/api/3/issue/AB-1/worklog'`.
  - `rejects foreign host` (Review Focus 1): `{path:'https://evil.com/x'}` → 400, e o client não é chamado.
  - `rejects write method`: `{path:'/rest/api/3/issue', method:'POST'}` → 400.
  - `missing path param`: `{endpointId:'sprint-issues'}` → 400 com `error` contendo `sprintId`.
  - `no token`: com `tokenConfigured:false` → 400.
  - `paginate uses catalog strategy`: o client falso devolve `{issues:[1], nextPageToken:'A'}` e depois `{issues:[2], isLast:true}`. Esperado: `total 2`.
  - `serves shared lib`: `GET /lib/flatten.js` → 200 com content-type JavaScript.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/server.js` e `src/index.js` (`express.json({limit:'1mb'})`).
- [ ] **Step 4: Run** `npm test` → todos PASS.
- [ ] **Step 5: Commit** `feat: express api server`.

---

### Task 7: Interface web

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: as rotas da Task 6; `flatten` e `isAdf` de `/lib/flatten.js`, `toCsv` de `/lib/csv.js` e `generateQlikScript` de `/lib/qlikScript.js` (via `<script type="module">`).

Layout e comportamento, conforme a seção 7 do spec:

- [ ] **Step 1: `index.html` + `style.css`**
  - Barra superior: URL base, nome do usuário (via `/api/call` em `myself`, campo `displayName`) e um selo "Token OK" / "Token ausente" que mostra o banner de ajuda da seção 9 do spec.
  - Esquerda: catálogo agrupado por `area` e o item "Endpoint livre".
  - Centro:
    - um campo por `pathParams`;
    - um par chave/valor por `query` (é possível adicionar ou remover pares);
    - textarea do body JSON (só quando `method === 'POST'`);
    - `maxPages`;
    - nome da conexão Qlik (padrão `Jira_REST`);
    - botões **Chamar** e **Paginar tudo**.
  - No modo livre, aparecem ainda os campos de método (só GET), estratégia de paginação e `dataKey`.
  - Abas: JSON, Tabela, Paginação, Script Qlik.
  - Use CSS simples (grid), legível a partir de 1280px.
- [ ] **Step 2: `app.js`: chamada e resultado**
  - **Chamar**: o retorno vai para a aba JSON (`JSON.stringify(data, null, 2)`); mostre status, ms e headers de rate limit.
  - **Paginar tudo**: os `records` alimentam as abas; a aba Paginação mostra a tabela por página, o total e o `stoppedBy` traduzido (`end` = "Fim dos dados", `maxPages` = "Parou no limite de páginas", `error` = "Erro na página N", `loop` = "Token repetido – interrompido").
  - Erros, conforme a tabela da seção 9 do spec:
    - 401/403 → texto sobre token ou permissão;
    - 400 → lista `errorMessages` e `errors`;
    - 404 → mostra o caminho;
    - 429 → informa que esgotou as tentativas;
    - status 0 → erro de rede.
- [ ] **Step 3: `app.js`: Tabela, CSV e Script Qlik**
  - Na Chamar, a fonte de registros é `extractRecords` aplicado no cliente: `data[dataKey]` ou `data`. Na Paginar tudo, são os `records`.
  - **Tabela**: `flatten(records)`, com seletor de tabela, grade com no máximo 500 linhas e contagem "mostrando X de Y".
  - **Exportar CSV**: `toCsv` da tabela selecionada; download via `Blob`, nome `<endpointId>_<tabela>.csv`.
  - **Script Qlik**: `generateQlikScript({ baseUrl, endpoint, request, sampleRecord: records[0], connectionName })`, num `<pre>` com botão copiar (`navigator.clipboard`).
- [ ] **Step 4: Verificar no navegador** com `npm start` e `.env` sem token:
  - a página carrega sem erros no console;
  - o selo mostra "Token ausente" e o banner;
  - o catálogo lista as 5 áreas;
  - Chamar retorna o erro 400 de token na tela.
- [ ] **Step 5: Commit** `feat: web ui`.

---

### Task 8: README e validação real

**Files:**
- Create: `README.md`

- [ ] **Step 1: README em português:**
  - pré-requisitos;
  - como criar o API token (https://id.atlassian.com/manage-profile/security/api-tokens);
  - `.env`;
  - `npm install` / `npm start` / `npm test`;
  - roteiro de teste por área;
  - como usar o script Qlik: criar a conexão REST no hub com Basic Auth, mesmo e-mail e token, URL `https://tjmg.atlassian.net`, "Allow WITH CONNECTION" ligado.
- [ ] **Step 2: Validação real** (o usuário preenche o `.env`). Executar na UI:
  - `myself` → 200;
  - `projects` → Paginar tudo;
  - `search-jql` com 2 páginas (`maxResults` 50);
  - `changelog-bulk` com 2 chaves obtidas na busca;
  - `worklog-updated`;
  - `boards` → `board-sprints` → `sprint-issues`.
  Registrar quais endpoints passaram.
- [ ] **Step 3: Commit** `docs: readme`.
