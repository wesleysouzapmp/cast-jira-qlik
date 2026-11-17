# Apontamento de Horas — Design

**Data:** 2026-11-10
**Projeto:** `cast-jira-qlik`
**Status:** design aprovado em conversa; aguardando revisão desta spec
**Depende de:** `2026-11-10-tarefas-de-apoio-design.md`, que define as tarefas de apoio, `src/support/*` e a forma de reconhecer as tarefas existentes.

## 1. Objetivo

Apontar, numa tela do app local, as horas trabalhadas nas tarefas de apoio (Análise e Implementação) dos épicos do usuário. A tela gera automaticamente as batidas (data e hora de início) e os comentários, e o resultado no Clockwork Pro fica igual ao de um apontamento manual.

**Critério de sucesso:**
1. O usuário informa as horas de uma tarefa, ou um total por épico dividido por percentual, e um período. O app gera os lançamentos e os mostra numa prévia editável.
2. Nenhum lançamento cai fora do expediente, no almoço ou por cima de um apontamento que o usuário já tenha no Jira.
3. Depois da confirmação, cada lançamento vira um worklog no Jira com `timeSpent` no formato `1h 30m`, `started` e comentário, e aparece no Clockwork.
4. Uma tarefa em "Aberto" e um épico ainda não iniciado passam para "Em Execução".

## 2. O que foi dito vs. premissas

| Dito pelo usuário | Premissa assumida |
|---|---|
| Apontar individualmente ou dividir um total entre as duas tarefas | A divisão usa um percentual editável, com padrão 30% Análise / 70% Implementação |
| Clockwork Pro: "1h 30m", comentário, started at | O Clockwork lê os worklogs nativos do Jira (confirmado em QSENSE-4074). O app grava pela API de worklog sem a propriedade `clockwork.ignore_time_logged_validator_processing`, para não desligar a validação do Clockwork |
| Gerador automático de batida | Distribui as horas pelos dias úteis de um período (aprovado) |
| Expediente | Configurável na tela. O padrão é 08:00–12:00 e 13:00–17:00, com limite de 8h por dia |
| Comentário automático relacionado à tarefa | Frases-modelo e um botão opcional "Gerar com IA" (aprovado) |
| Tarefa em "Aberto" muda para "Em Execução"; épico também | O épico só muda se ainda não tiver começado (aprovado). As tarefas em outros status ficam como estão |
| — | Dias úteis são de segunda a sexta, sem feriados. O usuário remove dias ou linhas na prévia. Fuso fixo em -03:00 (Brasília, sem horário de verão) |
| — | Só aparecem as tarefas de apoio, inclusive as concluídas, dos épicos em aberto atribuídos ao usuário |

## 3. Regras de cálculo

Todas as durações são em minutos. A granularidade é de **15 min**.

### 3.1 Entrada de horas
`parseDuration(text)` aceita estes formatos:
- `1h 30m`, `1h`, `45m`, `90m`;
- `1,5` e `1.5`, lidos como horas;
- `1:30`.

O resultado é arredondado para o múltiplo de 15 mais próximo. Valores vazios, negativos, zero ou acima de 200h são inválidos.

`formatDuration(min)` devolve o texto no formato do Jira: `90` → `1h 30m`, `60` → `1h`, `45` → `45m`.

### 3.2 Divisão por percentual
`splitTotal(totalMin, pctAnalise)` funciona assim:
- `analise = round15(totalMin × pct / 100)` e `implementacao = totalMin − analise`;
- as duas partes são múltiplas de 15 e somam exatamente o total;
- `pct` é um inteiro de 0 a 100. Uma parte que dá 0 não vira lançamento.

### 3.3 Distribuição (gerador de batidas)
Entradas:
- a lista ordenada de demandas `{ taskKey, model, minutes }`. A ordem é épico a épico e, dentro de cada épico, Análise antes de Implementação;
- o período `[dataInicial, dataFinal]`;
- o expediente: `inicio`, `almocoInicio`, `almocoFim`, `fim` (HH:MM) e `limiteDiarioMin`;
- os apontamentos que o usuário já tem no período, como intervalos `{ start, end }`.

Algoritmo, em `distribute(...)`:
1. Para cada dia útil do período, monta as janelas livres: `[inicio, almocoInicio]` e `[almocoFim, fim]`, menos os intervalos já ocupados nesse dia. A capacidade do dia é `limiteDiarioMin` menos o que já está apontado nele.
2. Percorre as demandas em ordem e consome as janelas livres do primeiro dia em diante. Cada trecho contínuo vira um lançamento. Se uma demanda passa pelo almoço, pelo fim do dia ou por um apontamento existente, ela é quebrada em mais de um lançamento.
3. Os limites das janelas são arredondados para múltiplos de 15: o início para cima e o fim para baixo.
4. Se o período acabar antes, o resultado traz `unallocated: [{ taskKey, minutes }]` e a tela avisa.

Saída: `entries: [{ taskKey, model, date: 'YYYY-MM-DD', start: 'HH:MM', minutes }]`, em ordem cronológica.

### 3.4 Comentários
- **Frases-modelo:** `MODELS[i].comments` em `src/support/models.js`, com 8 frases por modelo que aceitam `{EPICO}` e `{TAREFA}`. `pickComments(model, issue, n, rng)` sorteia sem repetir enquanto houver frases e só depois volta a repetir. `rng` é injetável nos testes.
- **IA (opcional):** o botão aparece quando o `.env` tem `ANTHROPIC_API_KEY`.
  - Faz **uma** chamada por prévia com o SDK oficial `@anthropic-ai/sdk`, modelo `claude-opus-5-5`, `output_config.effort: "low"`, fallback do servidor ativado (`fallbacks: "default"`) e saída estruturada em JSON: `{ comments: [{ index, text }] }`.
  - Envia só o épico (chave e resumo), o tipo, a chave e o resumo da tarefa, e a data e a duração de cada lançamento. Não envia nenhum dado pessoal.
  - O prompt pede, para cada lançamento, uma frase em português, com no máximo 160 caracteres, no tom de um registro de atividade de BI/Qlik e coerente com o tipo da tarefa.
  - Se a resposta for uma recusa ou um erro, a tela mantém as frases-modelo e mostra o motivo.

## 4. Mudança de status

O servidor faz a mudança depois de gravar os lançamentos, e só para os itens que tiveram pelo menos um worklog gravado com sucesso.

- **Tarefa:** se o status for "Aberto", aplica a transição cujo `to.name` é "Em Execução".
- **Épico pai:** se o status for Aberto, Priorizado, Em Análise ou Aguardando Execução, aplica a transição cujo `to.name` é "Em Execução". Em qualquer outro status, nada muda.
- As transições são procuradas com `GET /rest/api/3/issue/{key}/transitions` e aplicadas com `POST .../transitions { transition: { id } }`. Hoje os ids são 181 para a tarefa e 341 para o épico, mas não ficam fixos no código.
- Se a transição não existir ou o Jira recusar, o resultado traz um aviso no item. Os worklogs gravados ficam como estão.
- A prévia já mostra o que vai mudar, por exemplo "QSENSE-4085: Aberto → Em Execução".

## 5. Arquitetura

| Arquivo | Responsabilidade |
|---|---|
| `src/support/models.js` | Acrescentar `comments` aos dois modelos |
| `src/worklog/time.js` | Funções puras: `parseDuration`, `formatDuration`, `splitTotal`, `businessDays`, `distribute`, `toJiraStarted(date, start)` → `2026-11-04T08:00:00.000-0300` |
| `src/worklog/comments.js` | `pickComments` (frases-modelo) |
| `src/worklog/ai.js` | `createAiCommenter({ apiKey })`: `generate(entries, context)` → `string[]`, com `@anthropic-ai/sdk` |
| `src/worklog/service.js` | `createWorklogService({ client, baseUrl, supportService })`, com as operações `listTasks()`, `busy(from, to)`, `preview(request)` e `submit(entries)` |
| `src/server.js` | Rotas `/api/worklog/*`, com as mesmas proteções de `/api/support/*` (Origin, token, validação) |
| `public/apontar.html`, `public/apontar.js` | Tela. O topo das três páginas ganha o link "Apontar horas" |

### Rotas
- `GET /api/worklog/tasks` → `{ epics: [{ key, summary, status, url, tasks: [{ key, model, summary, status, url, timeSpentMin }] }], aiEnabled }`
- `POST /api/worklog/preview` `{ items: [{ taskKey, minutes }], from, to, schedule }` → `{ entries: [...com comment], unallocated, transitions: [{ key, from, to }] }`. Só lê o Jira, para buscar os apontamentos existentes.
- `POST /api/worklog/ai-comments` `{ entries }` → `{ comments: string[] }`. Responde 404 quando não há chave.
- `POST /api/worklog/submit` `{ entries: [{ taskKey, date, start, minutes, comment }] }` → `{ results: [{ index, status: 'created'|'error', worklogId?, error? }], transitions: [{ key, status: 'moved'|'unchanged'|'error', from, to?, error? }] }`

### Validação no servidor
- A `taskKey` precisa ser uma tarefa de apoio de um épico em aberto do usuário. O servidor confere de novo com `supportService`.
- Os limites de tamanho são:
  - 1 a 200 lançamentos por envio;
  - de 15 a 480 minutos por lançamento, sempre múltiplo de 15;
  - comentário com até 1000 caracteres;
  - período de no máximo 31 dias.
- Data em `YYYY-MM-DD` e hora em `HH:MM`, com a hora dentro do expediente informado.
- O `submit` busca de novo os apontamentos do usuário nos dias envolvidos e **recusa o envio inteiro** (409) se algum lançamento se sobrepuser a eles. O usuário então gera a prévia de novo.
- Os envios entram numa fila única, um de cada vez, e os worklogs são gravados em sequência.

### Apontamentos existentes (`busy`)
1. Busca as issues com a JQL `worklogAuthor = currentUser() AND worklogDate >= "<from>" AND worklogDate <= "<to>"`, paginando.
2. Para cada issue, chama `GET /rest/api/3/issue/{key}/worklog?startedAfter=<ms>&startedBefore=<ms>` e filtra pelo `accountId` do usuário.
3. Devolve os intervalos `{ start, end }` no fuso -03:00.

### Worklog enviado
```json
POST /rest/api/3/issue/QSENSE-4085/worklog?notifyUsers=false
{ "timeSpent": "1h 30m", "started": "2026-11-04T08:00:00.000-0300",
  "comment": { "type": "doc", "version": 1, "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "…" } ] } ] } }
```

## 6. Tela

1. **Tarefas:** um bloco por épico, mostrando o status do épico e as duas tarefas com status e horas já apontadas. Cada tarefa tem uma caixa de seleção e um campo de horas. O épico tem uma chave "Dividir total", que troca os dois campos por um campo de total e um campo de % de Análise (padrão 30).
2. **Período e expediente:** data inicial e final (padrão: a segunda e a sexta da semana atual), início, almoço (início e fim), fim e limite diário. O expediente fica salvo no `localStorage` do navegador.
3. **Botão "Gerar prévia":** mostra uma tabela com tarefa, data, início, duração e um comentário editável, além de um botão de remover em cada linha. Acima da tabela ficam o total por tarefa, o aviso do que ficou sem horário (`unallocated`) e as mudanças de status previstas. O botão "Gerar com IA" só aparece quando `aiEnabled` é verdadeiro.
4. **Botão "Confirmar apontamentos":** desativa a tela enquanto grava e depois mostra o resultado em cada linha e as mudanças de status. Um erro 409 mostra "Há apontamentos novos no período; gere a prévia de novo".
5. Todo texto vindo do Jira ou da IA entra na página por `textContent`.

## 7. Erros

- Token ausente → 400. `JiraError` → 502. Sobreposição detectada no submit → 409. Chave da IA ausente → 404 na rota de IA.
- Falha num worklog: aparece na linha e os outros continuam. Não há nova tentativa automática. Quando o status é 0 (rede ou timeout), a mensagem avisa que o Jira pode ter gravado mesmo assim.
- Falha na IA: as frases-modelo continuam na tela e o motivo aparece.

## 8. Testes

- `test/worklog.time.test.js`:
  - `parseDuration` e `formatDuration` (todos os formatos e os inválidos);
  - `splitTotal` (soma exata, 0% e 100%);
  - `businessDays`;
  - `distribute`:
    - preenchimento simples;
    - quebra no almoço;
    - quebra no fim do dia e continuação no dia seguinte;
    - pula fim de semana;
    - desvia de apontamento existente;
    - respeita o limite diário já consumido;
    - devolve `unallocated` quando falta horário;
    - arredonda as janelas para múltiplos de 15;
  - `toJiraStarted`.
- `test/worklog.comments.test.js`: sorteio sem repetição, substituição de `{EPICO}` e `{TAREFA}`, e `$` no resumo.
- `test/worklog.service.test.js` (Jira simulado):
  - `listTasks`;
  - `busy` filtra por autor e por período;
  - `preview` monta os lançamentos e as transições previstas;
  - `submit`:
    - grava em sequência;
    - recusa com 409 quando há sobreposição;
    - recusa tarefa fora do escopo;
    - continua depois de um erro;
    - faz as transições de tarefa e de épico pelas regras, inclusive épico em homologação que não muda e transição ausente que gera aviso;
    - dois envios simultâneos rodam em fila.
- `test/worklog.ai.test.js`: o SDK é simulado. O teste confere modelo, effort, fallback e esquema, o tratamento de recusa e uma quantidade errada de comentários.
- `test/server.test.js`: validação das rotas (limites, formatos, Origin, token).
- Navegador com o mock: fluxo completo, edição e remoção de linhas, erro 409 e tela de 375 px.
- Validação real, com o ok do usuário: um lançamento pequeno (15 min) numa tarefa escolhida por ele, conferido no Jira e no Clockwork.

## 9. Fora do escopo

- Feriados e calendário do tribunal.
- Editar ou excluir worklogs já gravados.
- Apontar em issues que não sejam as tarefas de apoio.
- Usar a API própria do Clockwork, como timers.
