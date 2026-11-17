# Jira API Tester — Design

**Data:** 2026-11-06
**Projeto:** `cast-jira-qlik`
**Status:** aprovado em conversa; aguardando revisão do spec escrito

## 1. Objetivo

Antes de montar a carga no Qlik Sense Enterprise, validar contra o Jira Cloud `https://tjmg.atlassian.net`:

- autenticação (e-mail + API token, HTTP Basic);
- endpoints das 5 áreas de dados: cadastros, issues, changelog, worklogs e agile;
- paginação completa de cada endpoint, até a última página;
- estrutura dos dados achatada em tabelas, como o Qlik REST Connector vai enxergar.

**Critério de sucesso:** para cada endpoint do catálogo, o app
1. retorna HTTP 200;
2. pagina até o fim, mostrando os totais por página;
3. exibe o resultado em tabela e exporta CSV;
4. gera um trecho de script Qlik que reproduz a chamada e a paginação.

## 2. O que foi dito vs. premissas

| Dito pelo usuário | Premissa assumida |
|---|---|
| Jira Cloud `tjmg.atlassian.net` | REST API v3 e Agile API 1.0 |
| Levar tudo: issues, changelog, worklogs, agile, cadastros | Só leitura; nenhuma escrita no Jira |
| App web local | Roda em `localhost:3000`, usado por uma pessoa |
| Design aprovado | Aba "Script Qlik" incluída (era a recomendação; o usuário aprovou o design sem objeção) |

## 3. Arquitetura

```
Navegador (HTML+JS puro)  ──►  Express (Node 24, localhost:3000)  ──►  tjmg.atlassian.net
                                 │  .env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
```

- O token fica só no backend (`.env`) e nunca é enviado ao navegador nem aparece nos logs.
- O backend é necessário porque o Jira Cloud não permite chamadas diretas do navegador (bloqueio de CORS).
- Não há framework de frontend, build nem banco de dados.

### Unidades

| Arquivo | Responsabilidade |
|---|---|
| `src/server.js` | Express: rotas `/api/*` e arquivos estáticos de `public/` |
| `src/jiraClient.js` | Chamada HTTP ao Jira: auth Basic, timeout, tentativa nova em 429 respeitando `Retry-After`, coleta de status, tempo e headers |
| `src/paginators.js` | Estratégias de paginação: `none`, `offset`, `token`, `worklogUpdated` |
| `src/catalog.js` | Catálogo de endpoints: área, método, caminho, parâmetros padrão, estratégia de paginação e chave do array de dados |
| `src/flatten.js` | JSON → tabelas: tabela-raiz e tabelas-filhas para arrays, ligadas por `__parent_id` |
| `src/qlikScript.js` | Gera o trecho de script de carga Qlik para um endpoint e os parâmetros informados |
| `public/index.html`, `public/app.js`, `public/style.css` | Interface |

### Rotas do backend

- `GET /api/config` → URL base, e-mail e se o token está configurado (sem o valor do token).
- `GET /api/catalog` → catálogo de endpoints.
- `POST /api/call` `{method, path, query, body}` → `{status, ms, headers, data}`.
- `POST /api/paginate` `{endpointId | custom, query, body, maxPages}` → `{pages:[{n, count, ms}], total, records}`.

Apenas GET e os POSTs de leitura do catálogo (`/search/jql`, `/changelog/bulkfetch`, `/worklog/list`) são aceitos. Qualquer outro método é recusado.

## 4. Catálogo de endpoints

| Área | Endpoint | Paginação | Array de dados |
|---|---|---|---|
| Cadastros | `GET /rest/api/3/myself` | none | (objeto) |
| Cadastros | `GET /rest/api/3/project/search` | offset (`startAt`/`maxResults`/`isLast`) | `values` |
| Cadastros | `GET /rest/api/3/users/search` | offset (para quando a página vem vazia) | (array raiz) |
| Cadastros | `GET /rest/api/3/status` · `/issuetype` · `/priority` · `/field` | none | (array raiz) |
| Issues | `GET /rest/api/3/search/jql` (`jql`, `fields`, `maxResults`) | token (`nextPageToken`, `isLast`) | `issues` |
| Changelog | `GET /rest/api/3/issue/{key}/changelog` | offset | `values` |
| Changelog | `POST /rest/api/3/changelog/bulkfetch` (`issueIdsOrKeys`) | token (`nextPageToken`) | `issueChangeLogs` |
| Worklogs | `GET /rest/api/3/issue/{key}/worklog` | offset | `worklogs` |
| Worklogs | `GET /rest/api/3/worklog/updated` (`since`) | worklogUpdated (`nextPage`/`lastPage`) | `values` |
| Worklogs | `POST /rest/api/3/worklog/list` (`ids`) | none | (array raiz) |
| Agile | `GET /rest/agile/1.0/board` | offset (`isLast`) | `values` |
| Agile | `GET /rest/agile/1.0/board/{boardId}/sprint` | offset (`isLast`) | `values` |
| Agile | `GET /rest/agile/1.0/sprint/{sprintId}/issue` | offset (`total`) | `issues` |
| Livre | qualquer caminho GET informado | escolhida pelo usuário | escolhida pelo usuário |

Os parâmetros de caminho (`{key}`, `{boardId}`, `{sprintId}`) são campos editáveis na tela.

## 5. Paginação

- Cada estratégia é uma função pura `next(response, state) → nextState | null`, que pode ser testada sem rede.
- `maxPages` tem padrão 20 e é ajustável na tela, para não varrer o Jira inteiro por acidente.
- O resultado informa, por página, o número da página, a quantidade de registros e o tempo, além do total consolidado e se a varredura parou pelo limite ou porque chegou ao fim.

## 6. Achatamento (estilo Qlik)

- Campos escalares de objetos aninhados viram colunas com caminho: `fields.status.name`.
- Arrays de escalares viram texto unido por `;`.
- Arrays de objetos viram uma tabela-filha (`issues.fields.components`) com `__parent_id` apontando para a linha-pai e `__index`.
- O documento ADF (rich text do Jira v3, como `description` e `comment.body`) vira texto simples (concatenação dos nós `text`).

## 7. Interface

- **Barra superior:** URL do Jira, usuário autenticado (via `/myself`) e indicador de token configurado.
- **Esquerda:** catálogo agrupado por área e a opção "Endpoint livre".
- **Centro:** parâmetros (query, caminho, body JSON), `maxPages` e os botões **Chamar** (1 página) e **Paginar tudo**.
- **Abas de resultado:**
  - **JSON**: bruto e formatado;
  - **Tabela**: seletor da tabela raiz ou filhas; grade com no máximo 500 linhas na tela;
  - **Paginação**: tabela por página e totais;
  - **Script Qlik**: trecho gerado, com botão copiar;
  - **Exportar CSV**: da tabela selecionada, com separador `;` e UTF-8 com BOM, para abrir no Excel pt-BR.

## 8. Script Qlik gerado

Para o endpoint e os parâmetros atuais, o app gera:

- `LIB CONNECT TO 'Jira_REST';` (nome editável), assumindo uma conexão REST com Basic Auth já criada no QMC/hub;
- laço de paginação adequado à estratégia: `Do While` com `nextPageToken` ou `startAt`, usando `WITH CONNECTION (URL "...", QUERY "...")`;
- `SQL SELECT ... FROM JSON (wrap on) "root" PK "__KEY_root"` com os campos principais e `RESIDENT`/`LOAD` para as tabelas-filhas.

O script é um ponto de partida, a ser ajustado no editor de carga do Qlik.

## 9. Tratamento de erros

| Situação | Comportamento |
|---|---|
| `.env` ausente ou incompleto | Banner na tela explicando como criar o token em id.atlassian.com e preencher o `.env` |
| 401 / 403 | Mensagem: token inválido ou sem permissão no projeto, com o corpo do erro do Jira |
| 400 | Mostra `errorMessages`/`errors` do Jira (por exemplo, JQL inválida) |
| 404 | Mostra o caminho chamado; sugere conferir chave, ID ou permissão |
| 429 | Até 3 novas tentativas, esperando o tempo de `Retry-After`; depois disso, mostra o erro |
| Timeout / rede | Mensagem clara; a paginação para e mantém as páginas já obtidas |

## 10. Testes

- `node --test` cobrindo:
  - `paginators.js`: cada estratégia com respostas simuladas, incluindo última página, página vazia e limite de `maxPages`;
  - `flatten.js`: objetos aninhados, arrays de escalares, arrays de objetos e ADF;
  - `qlikScript.js`: script gerado para uma estratégia offset e uma token (snapshot simples);
  - `jiraClient.js`: nova tentativa em 429 com `fetch` simulado.
- Teste manual contra `tjmg.atlassian.net`: `/myself`, uma área de cada vez, "Paginar tudo" e exportação CSV.

## 11. Fora do escopo

Escrita no Jira, OAuth 2.0, multiusuário, banco de dados, agendamento e deploy em servidor.

## 12. Execução

```
npm install
copy .env.example .env   # preencher e-mail e API token
npm start                # http://localhost:3000
npm test
```
