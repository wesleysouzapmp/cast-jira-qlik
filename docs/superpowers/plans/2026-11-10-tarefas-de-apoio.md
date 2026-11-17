# Tarefas de Apoio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `apoio.html` que lista os itens atribuídos ao usuário e cria, para os épicos escolhidos, as duas "Tarefas de apoio" padronizadas no QSENSE.

**Architecture:** Módulos novos em `src/support/`: configuração, funções puras e um serviço que usa o `client.call` existente. O servidor ganha três rotas `/api/support/*`, e a interface é uma página estática nova. O caminho de leitura (`catalog.js`, `/api/call`, `/api/paginate`) não muda.

**Tech Stack:** Node 24 (ESM), Express 4, `node --test`, HTML/JS puro.

**Spec:** `docs/superpowers/specs/2026-11-10-tarefas-de-apoio-design.md`

## Global Constraints

- Projeto `QSENSE`; tipo `{ id: '10002' }` ("Tarefa de apoio"); componente `{ id: '10013' }` ("Qlik Sense").
- Item do Catálogo `customfield_10104`: pai `11927`; Modelo 1 filho `11930` (CAT-105); Modelo 2 filho `12117` (CAT-166).
- Rótulo do épico: `<chave> - <resumo>`.
- Modelo 1:
  - resumo `Analise da demanda {EPICO}`;
  - descrição `Analise da demanda {EPICO}. Levantamento das necessidades para execução.`
- Modelo 2:
  - resumo `Implementação da demanda {EPICO}`;
  - descrição `Desenvolvimento e Testes da Demanda {EPICO}. Criação de scripts Python, AQL e desenvolvimento de telas para atender a necessidade do usuário chave.`
- Resumo com no máximo 255 caracteres. Quando passar disso, o resumo do épico é cortado e termina em `…`.
- É épico o item com `fields.issuetype.hierarchyLevel === 1`.
- Chave válida: `^[A-Z][A-Z0-9_]+-\d+$`. No máximo 50 chaves por pedido.
- Listagem: JQL `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, `maxResults` 100, até 10 páginas por `nextPageToken`.
- O navegador só envia chaves. Textos e campos são montados no servidor.
- Mensagens da interface em português do Brasil.
- Sem repositório git: os passos de commit são pulados (mesma decisão do plano anterior, registrada em `.superpowers/progress.md`).

## Review Focus

1. **Duplo clique ou repetição em "Confirmar e criar":** não pode surgir tarefa duplicada. O serviço pula o que já existe (teste na Task 2), e a tela desativa o botão enquanto a criação roda (verificação na Task 4).
2. **Resumo do épico longo, com aspas ou acentos:** o resumo fica com no máximo 255 caracteres e o texto sai intacto na descrição (teste na Task 1).
3. **O Jira recusa um campo** (por exemplo, opção do catálogo desativada): a linha mostra a mensagem do Jira e os outros épicos continuam (teste na Task 2).
4. **Nenhuma chave, mais de 50 ou chave malformada:** a rota responde 400 sem chamar o Jira (teste na Task 3).
5. **Mais de 1000 itens atribuídos:** a lista para em 10 páginas e devolve `truncated: true`, e a tela avisa (teste na Task 2).

---

### Task 1: Modelos e funções puras

**Files:**
- Create: `src/support/models.js`, `src/support/render.js`
- Test: `test/support.render.test.js`

**Interfaces:**
- Produces, em `models.js`:
  - `QSENSE = { projectKey: 'QSENSE', issueTypeId: '10002', componentId: '10013', catalogFieldId: 'customfield_10104' }`;
  - `MODELS: Array<{ id: 'analise'|'implementacao', prefix: string, summary: string, description: string, catalog: { parentId, childId, label } }>`, com `{EPICO}` literal nos textos.
- Produces, em `render.js`:
  - `epicLabel(issue) -> string`, onde `issue` = `{ key, fields: { summary } }`;
  - `renderModel(model, issue) -> { summary, description }`;
  - `toAdf(text) -> object`, um documento ADF com um parágrafo;
  - `buildCreateBody(model, issue, accountId) -> { fields }`, no formato da spec §3;
  - `matchesModel(model, summary) -> boolean`, que compara o prefixo sem diferenciar maiúsculas nem acentos (NFD e remoção de `\p{M}`).

- [ ] **Step 1: Escrever os testes que falham**

```js
test('renderModel substitui {EPICO}', () => {
  const issue = { key: 'BI-2931', fields: { summary: 'CEINJUR - Atualiza Painel "Julgamento"' } };
  const r = renderModel(MODELS[0], issue);
  assert.equal(r.summary, 'Analise da demanda BI-2931 - CEINJUR - Atualiza Painel "Julgamento"');
  assert.equal(r.description, 'Analise da demanda BI-2931 - CEINJUR - Atualiza Painel "Julgamento". Levantamento das necessidades para execução.');
});
test('modelo 2', () => { /* summary começa com 'Implementação da demanda BI-1 - X'; description começa com 'Desenvolvimento e Testes da Demanda BI-1 - X.' */ });
test('resumo limitado a 255 com …', () => {
  const r = renderModel(MODELS[1], { key: 'BI-1', fields: { summary: 'x'.repeat(400) } });
  assert.equal(r.summary.length, 255); assert.ok(r.summary.endsWith('…'));
  assert.ok(r.description.includes('x'.repeat(400)));
});
test('buildCreateBody', () => {
  const b = buildCreateBody(MODELS[0], { key: 'BI-1', fields: { summary: 'S' } }, 'acc-1');
  assert.deepEqual(b.fields.project, { key: 'QSENSE' });
  assert.deepEqual(b.fields.issuetype, { id: '10002' });
  assert.deepEqual(b.fields.parent, { key: 'BI-1' });
  assert.deepEqual(b.fields.components, [{ id: '10013' }]);
  assert.deepEqual(b.fields.assignee, { accountId: 'acc-1' });
  assert.deepEqual(b.fields.customfield_10104, { id: '11927', child: { id: '11930' } });
  assert.equal(b.fields.description.content[0].content[0].text, 'Analise da demanda BI-1 - S. Levantamento das necessidades para execução.');
});
test('matchesModel ignora acentos e caixa', () => {
  assert.ok(matchesModel(MODELS[1], 'IMPLEMENTACAO DA DEMANDA BI-1 - S'));
  assert.ok(matchesModel(MODELS[0], 'Análise da demanda BI-1'));
  assert.ok(!matchesModel(MODELS[0], 'Implementação da demanda BI-1'));
});
```

- [ ] **Step 2: Rodar e ver falhar.** `node --test test/support.render.test.js` → FAIL, porque o módulo não existe.
- [ ] **Step 3: Implementar `models.js` e `render.js` com as interfaces acima.** O corte do resumo reduz só a parte do resumo do épico, para que o total fique em 255 com `…` no fim.
- [ ] **Step 4: Rodar e ver passar.** `node --test test/support.render.test.js` → PASS.

### Task 2: Serviço

**Files:**
- Create: `src/support/service.js`
- Test: `test/support.service.test.js`

**Interfaces:**
- Consumes: `client.call({ method, path, query, body }) -> { status, ok, data }`, de `src/jiraClient.js`, e tudo da Task 1.
- Produces: `createSupportService({ client, baseUrl }) -> { listItems({ onlyEpics }), preview(keys), create(keys) }`. Os tipos de retorno são:
  - `listItems -> { items: Item[], truncated: boolean }`, com `Item = { key, summary, type, isEpic, status, project, url, existing: [{ model, key, url }] }` e `url = baseUrl + '/browse/' + key`;
  - `preview(keys) -> { epics: [{ epic, summary, toCreate: [{ model, summary, description, catalog }], skipped: [{ model, key }] }], rejected: [{ key, reason }] }`;
  - `create(keys) -> { results: [{ epic, model, status: 'created'|'skipped'|'error', key?, url?, error? }] }`.
- Lança `JiraError` (exportado, com `status` e `message`) quando a busca ou o `/myself` falha.

Chamadas ao Jira:
- `POST /rest/api/3/search/jql`, com body `{ jql, maxResults, fields, nextPageToken? }`;
- busca de existentes com a JQL `project = QSENSE AND parent in (K1, K2)` e os campos `['summary','parent']`, em lotes de 50;
- `GET /rest/api/3/myself`, com o `accountId` guardado em memória;
- `POST /rest/api/3/issue`.

Uma tarefa existente pertence ao épico `fields.parent.key` e ao primeiro modelo para o qual `matchesModel` é verdadeiro. `preview` e `create` buscam os itens de novo com `key in (...)` e põem em `rejected` (preview) ou devolvem `status: 'error'` (create) para os que não são épicos ou não foram encontrados. A mensagem de erro do Jira junta `errorMessages` e os valores de `errors`.

- [ ] **Step 1: Escrever os testes que falham**, com um `client` simulado que responde conforme `path` e JQL e registra as chamadas:
  - `listItems marca épicos e existentes`: dois itens, um épico (hierarchyLevel 1) e uma história. O épico tem `QSENSE-9` "Analise da demanda …" e fica com `existing: [{ model: 'analise', key: 'QSENSE-9', url: '…/browse/QSENSE-9' }]`. A história fica com `isEpic: false`.
  - `listItems onlyEpics filtra`.
  - `listItems pagina por nextPageToken e marca truncated após 10 páginas`: o simulado sempre devolve `nextPageToken`, e o resultado tem `truncated === true` e 10 buscas de itens.
  - `create pula modelo existente`: o épico já tem "Analise…". O resultado é `[{model:'analise',status:'skipped',key:'QSENSE-9'}, {model:'implementacao',status:'created',key:'QSENSE-10'}]` e só um `POST /rest/api/3/issue` é feito.
  - `create recusa não-épico`: `status: 'error'` e nenhum POST de issue.
  - `create continua após erro`: o 1º POST responde 400 `{ errors: { customfield_10104: 'Opção inválida' } }`. O resultado traz `error` contendo `Opção inválida`, e os demais POSTs acontecem.
  - `accountId em cache`: duas chamadas a `create` fazem um único `/myself`.
- [ ] **Step 2: Rodar e ver falhar.** `node --test test/support.service.test.js` → FAIL.
- [ ] **Step 3: Implementar `service.js`.** As criações são sequenciais (um `await` por POST), na ordem épico → modelo.
- [ ] **Step 4: Rodar e ver passar.** `node --test test/support.service.test.js` → PASS.

### Task 3: Rotas no servidor

**Files:**
- Modify: `src/server.js` (`createApp` aceita `supportService` opcional; as rotas são registradas antes de `express.static`), `src/index.js` (cria o serviço e o passa ao app)
- Test: `test/server.test.js` (acrescentar)

**Interfaces:**
- Consumes: `createSupportService`, da Task 2.
- Produces as rotas:
  - `GET /api/support/items?onlyEpics=1` → `listItems`;
  - `POST /api/support/preview` `{ keys }` → `preview`;
  - `POST /api/support/create` `{ keys }` → `create`.
- As respostas de erro são JSON `{ error }`:
  - 400: token ausente, ou `keys` que não seja um array de 1 a 50 chaves válidas (as duplicadas são removidas);
  - 403: `Origin` presente e diferente de `http://localhost:<porta>` ou `http://127.0.0.1:<porta>`;
  - 502: `JiraError`, com a mensagem dele;
  - 500: erro inesperado, com a mensagem genérica que já existe.

- [ ] **Step 1: Escrever os testes que falham.** O helper `start` passa a aceitar `supportService` simulado.
  - `support items repassa onlyEpics`: chama com `{ onlyEpics: true }`.
  - `support create valida keys`: `[]`, `['bi-1']`, 51 chaves e `'BI-1'` (string) respondem 400, e o serviço não é chamado.
  - `support create remove duplicadas`: `['BI-1','BI-1']` chega como `['BI-1']`.
  - `support create recusa Origin externo`: header `Origin: https://evil.example` → 403.
  - `support create aceita Origin localhost` → 200.
  - `JiraError vira 502`.
  - `sem token → 400`.
- [ ] **Step 2: Rodar e ver falhar.** `node --test test/server.test.js` → FAIL nos testes novos.
- [ ] **Step 3: Implementar as rotas e a ligação em `index.js`.**
- [ ] **Step 4: Rodar a suíte inteira.** `npm test` → todos passam, incluindo os 54 testes que já existiam.

### Task 4: Interface

**Files:**
- Create: `public/apoio.html`, `public/apoio.js`, `scripts/mock-support.js` (sobe o app em `127.0.0.1:3101` com um `client` simulado em memória: dois épicos e uma história; o POST de issue gera `QSENSE-<n>` e responde 400 quando a chave do épico é `BI-ERR`)
- Modify: `public/index.html` (link "Tarefas de apoio" no topo), `public/style.css` (só o necessário: modal de prévia e coluna de resultado)
- Modify: `.claude/launch.json` (configuração `apoio-mock` na porta 3101)

**Interfaces:**
- Consumes: as rotas da Task 3 e `/api/config`.
- Elementos, por id:
  - `onlyEpics` (checkbox marcado), `btnRefresh` e `count` na barra;
  - `items` (tbody);
  - `btnCreate` ("Criar tarefas de apoio (N)", desativado quando N = 0);
  - `previewDialog` (`<dialog>`) com `previewBody`, `btnConfirm` e `btnCancel`;
  - `truncatedNote` e `errorBox`.

Comportamento, conforme a spec §5:
- A caixa de seleção fica desativada quando `!isEpic` ou quando `existing.length === 2`.
- "Confirmar e criar" desativa os dois botões até a resposta chegar. Depois, a coluna de resultado mostra os links, "já existia" ou o erro, e a lista é recarregada.
- O texto vindo do Jira entra na página por `textContent`, nunca por `innerHTML`.

- [ ] **Step 1: Implementar a página e o mock.**
- [ ] **Step 2: Verificar no navegador** (`preview_start apoio-mock`):
  - a lista mostra 2 épicos com o filtro ligado e 3 itens sem ele;
  - a prévia mostra os textos exatos dos modelos;
  - depois de confirmar, aparecem as chaves QSENSE com link;
  - repetir mostra "já existia";
  - com `BI-ERR`, aparece o erro na linha;
  - o botão fica desativado durante a criação;
  - o console não tem erros;
  - o layout não quebra em 375 px.
- [ ] **Step 3: `npm test`** → tudo passa.

### Task 5: Documentação e validação real

**Files:**
- Modify: `README.md` (seção "Tarefas de apoio": o que faz, o link da página, os modelos em `src/support/models.js` e o aviso de que essa tela **escreve** no Jira)

- [ ] **Step 1: Atualizar o README.**
- [ ] **Step 2: Subir o app real** (`preview_start jira-api-tester`) e abrir `/apoio.html`. A lista deve mostrar BI-2931 e BI-2861 sem tarefas existentes.
- [ ] **Step 3: Pedir o ok do usuário** e então criar só as tarefas de BI-2931. Abrir as duas no Jira e conferir pai, componente, responsável, item do catálogo e textos.
- [ ] **Step 4: Recarregar a página.** BI-2931 deve mostrar as duas tarefas em "Apoio existente", com a caixa de seleção desativada.
