# Tarefas de Apoio — Design

**Data:** 2026-11-10
**Projeto:** `cast-jira-qlik`
**Status:** design aprovado em conversa; aguardando revisão desta spec

## 1. Objetivo

Em uma tela do app local, listar os itens do Jira atribuídos ao usuário e, para os épicos escolhidos, criar duas "Tarefas de apoio" padronizadas no projeto QSENSE.

**Critério de sucesso:**
1. A tela lista os itens em aberto atribuídos ao usuário. O filtro "Só épicos" vem ligado.
2. Para cada épico selecionado, o app cria as duas tarefas dos modelos abaixo, com o épico como pai. Ele mostra a chave e o link de cada tarefa criada.
3. Uma tarefa que o épico já tem não é criada de novo.
4. Nada é gravado sem o usuário ver a prévia e confirmar.

## 2. O que foi dito vs. premissas

| Dito pelo usuário | Premissa assumida |
|---|---|
| Listar épicos atribuídos e qualquer issue atribuída | Só itens não concluídos (`statusCategory != Done`), com o filtro "Só épicos" ligado por padrão |
| Criar as tarefas de apoio no espaço QSENSE | Tipo "Tarefa de apoio" (id 10002), com o épico como `parent`: é o padrão já usado pela equipe (ex.: QSENSE-4074 → BI-2887) |
| Modelos 1 e 2 (texto abaixo) | A frase repetida no início das descrições foi removida (aprovado) |
| Interface visual | Nova página no app existente, em `http://localhost:3100/apoio.html` |
| — | Itens que não são épicos aparecem na lista, mas não podem receber tarefas: o Jira não aceita "Tarefa de apoio" filha de história ou tarefa (aprovado) |
| — | Responsável = usuário do token; componente "Qlik Sense"; prioridade padrão (Média); sprint, datas, Tamanho e Story Points em branco (aprovado) |

## 3. Modelos

`{EPICO}` = `<chave> - <resumo do épico>`, por exemplo `BI-2931 - CEINJUR - Atualiza Painel "Julgamento de feitos vinculados a Temas"`.

| | Modelo 1 | Modelo 2 |
|---|---|---|
| Resumo | `Analise da demanda {EPICO}` | `Implementação da demanda {EPICO}` |
| Descrição | `Analise da demanda {EPICO}. Levantamento das necessidades para execução.` | `Desenvolvimento e Testes da Demanda {EPICO}. Criação de scripts Python, AQL e desenvolvimento de telas para atender a necessidade do usuário chave.` |
| Item do Catálogo (`customfield_10104`) | Business Intelligence (11927) › CAT-105 - Realizar diagnóstico de incidente, problema, erro ou demanda na solução de BI (11930) | Business Intelligence (11927) › CAT-166 - Manter script de carga do Qlik Sense (12117) |

O Jira limita o resumo a 255 caracteres. Quando passar disso, o resumo do épico é cortado e termina em `…`. A descrição não é cortada.

Os modelos ficam em um único arquivo de configuração (`src/support/models.js`), para que um ajuste de texto não exija mexer no código.

### Corpo enviado ao Jira (`POST /rest/api/3/issue`)

```json
{
  "fields": {
    "project": { "key": "QSENSE" },
    "issuetype": { "id": "10002" },
    "parent": { "key": "BI-2931" },
    "summary": "Analise da demanda BI-2931 - …",
    "description": { "type": "doc", "version": 1, "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "…" } ] } ] },
    "components": [ { "id": "10013" } ],
    "assignee": { "accountId": "<do /myself>" },
    "customfield_10104": { "id": "11927", "child": { "id": "11930" } }
  }
}
```

## 4. Arquitetura

O fluxo é o mesmo do app atual: navegador → Express em `127.0.0.1:3100` → `tjmg.atlassian.net`, e o token continua só no `.env`. A funcionalidade nova fica em módulos próprios. O fluxo de leitura e o catálogo existentes não mudam.

| Arquivo | Responsabilidade |
|---|---|
| `src/support/models.js` | Constantes do QSENSE (projeto, tipo, componente) e os dois modelos |
| `src/support/render.js` | Funções puras: `epicLabel(issue)`, `renderModel(model, issue)` → `{summary, description}`, `toAdf(text)`, `buildCreateBody(model, issue, accountId)`, `matchesModel(model, summary)` |
| `src/support/service.js` | `createSupportService({ client })`: `listItems({ onlyEpics })`, `preview(keys)`, `create(keys)`, que chamam o Jira por meio do `client.call` existente |
| `src/server.js` | Três rotas novas (abaixo), registradas por `registerSupportRoutes(app, { service, config })` |
| `public/apoio.html`, `public/apoio.js` | A tela, usando o `style.css` atual. O topo das duas páginas ganha um link entre "API Tester" e "Tarefas de apoio" |

### Rotas

- `GET /api/support/items?onlyEpics=1` → `{ items: [{ key, summary, type, isEpic, status, project, url, existing: [{ model, key, url }] }] }`
- `POST /api/support/preview` `{ keys: [...] }` → para cada chave, as tarefas que seriam criadas (`summary`, `description`, `catalog`) e as que seriam puladas por já existirem.
- `POST /api/support/create` `{ keys: [...] }` → `{ results: [{ epic, model, status: 'created'|'skipped'|'error', key?, url?, error? }] }`

O navegador só envia chaves de issue. Projeto, tipo, campos e textos são definidos no servidor, e o caminho de escrita só sabe criar "Tarefa de apoio" no QSENSE. `isAllowed` do catálogo continua recusando escrita no restante do app.

### Fluxo de dados

1. **Listar.** `POST /rest/api/3/search/jql` com `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, paginando por `nextPageToken`, até 10 páginas de 100. Pede os campos `summary, issuetype, status, project`. É épico o item com `issuetype.hierarchyLevel === 1`, o que não depende do nome traduzido do tipo.
2. **Tarefas existentes.** Uma busca `project = QSENSE AND parent in (<chaves dos épicos>)` com o campo `summary`, em lotes de 50 chaves. Uma tarefa corresponde a um modelo quando o resumo começa com o prefixo do modelo ("Analise da demanda" / "Implementação da demanda"), sem diferenciar maiúsculas nem acentos.
3. **Criar.** No servidor:
   - recebe as chaves e descarta as duplicadas e as inválidas (padrão `^[A-Z][A-Z0-9_]+-\d+$`; no máximo 50 por pedido);
   - busca de novo os itens, sem confiar em dados do navegador, e recusa os que não são épicos;
   - consulta de novo as tarefas existentes;
   - obtém o `accountId` por `/rest/api/3/myself`, guardado em memória;
   - cria em sequência só os modelos que faltam: um `POST` por tarefa, um épico por vez.

## 5. Tela

- **Topo:** igual ao do app atual (URL, usuário, selo do token), com o link entre as páginas.
- **Barra:** caixa "Só épicos" (ligada), botão "Atualizar" e contador de itens.
- **Tabela:**
  - caixa de seleção (desativada nos itens que não são épicos e nos que já têm as duas tarefas);
  - chave, com link para o Jira;
  - tipo;
  - status;
  - resumo;
  - "Apoio existente", com as chaves que já existem e link para elas, ou `—`.
- **Botão "Criar tarefas de apoio (N)":** abre a prévia. A prévia lista, por épico, as tarefas a criar (resumo, descrição e item do catálogo) e as que serão puladas. Os botões são "Confirmar e criar" e "Cancelar".
- **Resultado:** cada linha mostra as chaves criadas com link, "já existia" ou a mensagem de erro do Jira. A lista é recarregada depois.

## 6. Erros

- Token ausente: 400 com a mesma mensagem do app atual. A tela mostra o aviso.
- Falha ao criar uma tarefa: o resultado traz o status HTTP e as mensagens `errorMessages`/`errors` do Jira, e a criação continua nos outros épicos. Repetir o pedido é seguro porque a etapa 3 pula o que já existe.
- O 429 já é tratado pelo `jiraClient`, que tenta de novo.
- Pedido com `Origin` que não seja localhost: 403. É uma proteção contra outra página no navegador disparar a criação, somada à checagem de `Host` que já existe.

## 7. Testes

- `test/support.render.test.js`: montagem de rótulo, resumo, ADF e corpo, corte em 255 caracteres e correspondência de modelo (acentos e maiúsculas).
- `test/support.service.test.js`, com `client` simulado:
  - listagem com e sem filtro;
  - paginação;
  - marcação de tarefas existentes;
  - criação que pula o que existe;
  - recusa de item que não é épico;
  - erro parcial;
  - `accountId` guardado em memória.
- `test/server.test.js`: as três rotas, a validação de chaves e o 403 por `Origin`.
- Navegador com Jira simulado: lista, prévia, criação e erro mostrado na linha.
- Validação real: depois do ok do usuário, criar as tarefas de **um** épico (BI-2931) e conferir no Jira.

## 8. Fora do escopo

- Editar os modelos pela tela.
- Criar tarefas para itens que não são épicos.
- Preencher sprint, datas, estimativas ou apontar horas.
- Excluir ou alterar tarefas já criadas.
