# Apontamento de Horas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `apontar.html` que gera e grava worklogs (no formato do Clockwork) nas tarefas de apoio, com divisão de horas, distribuição automática das batidas, comentários automáticos (frases-modelo ou IA) e mudança de status para "Em Execução".

**Architecture:**
- Funções puras de tempo e distribuição em `src/worklog/time.js`.
- Comentários em `src/worklog/comments.js` (frases-modelo) e `src/worklog/ai.js` (SDK da Anthropic, com cliente injetável).
- `src/worklog/service.js` conversa com o Jira pelo `client.call` existente.
- As rotas `/api/worklog/*` ficam no `server.js`, com as mesmas proteções de `/api/support/*`.
- A tela é estática e o mock é estendido para os testes no navegador.

**Tech Stack:** Node 24 ESM, Express 4, `node --test`, `@anthropic-ai/sdk` (nova dependência), HTML/JS puro.

**Spec:** `docs/superpowers/specs/2026-11-10-apontamento-horas-design.md`

## Global Constraints

- Granularidade de 15 min. `timeSpent` no formato `Xh Ym`, omitindo a parte zerada (`1h`, `45m`, `1h 30m`).
- Fuso fixo `-03:00`. `started` no formato `YYYY-MM-DDTHH:MM:00.000-0300`.
- Expediente padrão: `08:00`, almoço `12:00`–`13:00`, fim `17:00`, limite diário de 480 min. Dias úteis de segunda a sexta.
- Divisão padrão: 30% Análise.
- Limites do envio:
  - 1 a 200 lançamentos;
  - de 15 a 480 min por lançamento, sempre múltiplo de 15;
  - comentário com até 1000 caracteres;
  - período de no máximo 31 dias.
- Status de destino "Em Execução". O épico só muda quando o status atual é um destes: `Aberto`, `Priorizado`, `Em Análise`, `Aguardando Execução`. A tarefa só muda quando está em `Aberto`.
- IA:
  - modelo `claude-opus-5-5`;
  - `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`;
  - `betas: ['server-side-fallback-2026-07-01']` e `fallbacks: 'default'`, por `client.beta.messages.create`;
  - checar `stop_reason === 'refusal'` antes de ler o conteúdo;
  - chave lida de `ANTHROPIC_API_KEY`.
- Worklog gravado sem `properties` e com `?notifyUsers=false`.
- Texto vindo do Jira ou da IA entra na página só por `textContent`.
- Sem git: os commits são pulados (ledger).

## Review Focus

1. **Duas abas confirmando a mesma prévia:** o segundo envio precisa receber 409 por sobreposição e não duplicar horas. Teste na Task 4 (a fila mais a nova checagem de `busy` dentro da fila).
2. **Apontamento existente que atravessa o almoço ou começa fora do expediente:** os horários livres são calculados corretamente. Teste na Task 1.
3. **`started` no limite do dia e conversão de fuso:** um worklog gravado às 23:30 em outro fuso não pode cair no dia errado. Teste na Task 4 (`busy` converte para -03:00).
4. **A IA devolve uma quantidade de comentários diferente da de lançamentos, ou recusa:** a tela mantém as frases-modelo. Teste na Task 3.
5. **Tarefa de um épico que não é seu, ou chave forjada no submit:** a rota responde 400 e nada é gravado. Teste nas Tasks 4 e 5.

---

### Task 1: Tempo e distribuição (`src/worklog/time.js`)

**Files:** Create `src/worklog/time.js`. Test `test/worklog.time.test.js`.

**Interfaces (Produces):**
- `parseDuration(text) -> number | null` (minutos, arredondados para 15; `null` quando inválido).
- `formatDuration(min) -> string`.
- `splitTotal(totalMin, pctAnalise) -> { analise, implementacao }`.
- `businessDays(from, to) -> string[]` (`YYYY-MM-DD`, de segunda a sexta, com os dois extremos incluídos).
- `distribute({ demands, from, to, schedule, busy }) -> { entries, unallocated }`, onde:
  - `demands: [{ taskKey, model, minutes }]`;
  - `schedule: { start, lunchStart, lunchEnd, end, dailyLimit }` (horários em `HH:MM`, `dailyLimit` em minutos);
  - `busy: [{ date, startMin, endMin }]` (minutos desde 00:00);
  - `entries: [{ taskKey, model, date, start: 'HH:MM', minutes }]`;
  - `unallocated: [{ taskKey, minutes }]`.
- `toJiraStarted(date, hhmm) -> string`.
- `DEFAULT_SCHEDULE`.

- [ ] **Step 1: Testes que falham**
  - `parseDuration`:
    - `'1h 30m'` → 90; `'1h'` → 60; `'45m'` → 45; `'90m'` → 90; `'1,5'` → 90; `'1.5'` → 90; `'1:30'` → 90; `'1h 20m'` → 75 (arredonda);
    - `''`, `'0'`, `'-1'`, `'abc'` e `'201h'` → `null`.
  - `formatDuration`: 90 → `'1h 30m'`; 60 → `'1h'`; 45 → `'45m'`; 615 → `'10h 15m'`.
  - `splitTotal`:
    - `(240, 30)` → `{ analise: 75, implementacao: 165 }`;
    - `(60, 0)` → `{ 0, 60 }`; `(60, 100)` → `{ 60, 0 }`;
    - a soma é sempre igual ao total.
  - `businessDays('2026-11-06', '2026-11-10')` → `['2026-11-06', '2026-11-09', '2026-11-10']`.
  - `distribute`:
    - preenchimento simples: 120 min em 2026-11-09 → `[{ start: '08:00', minutes: 120 }]`;
    - quebra no almoço: 300 min → `08:00 / 240` e `13:00 / 60`;
    - continua no dia seguinte: 600 min → 240 + 240 na segunda e 120 às 08:00 da terça;
    - desvia de apontamento existente: busy 09:00–10:00 → `08:00 / 60` e `10:00 / …`;
    - busy de 11:50 a 13:10 → a janela da tarde começa às 13:15 (arredondado para cima);
    - limite diário: já existem 420 min no dia → só 60 min cabem nesse dia;
    - ordem: Análise de BI-1 antes de Implementação de BI-1;
    - falta de horário: 1000 min em 1 dia → `unallocated: [{ minutes: 520 }]`;
    - pula sábado e domingo.
  - `toJiraStarted('2026-11-04', '08:00')` → `'2026-11-04T08:00:00.000-0300'`.
- [ ] **Step 2:** `node --test test/worklog.time.test.js` → FAIL (o módulo não existe).
- [ ] **Step 3:** Implementar. Na `distribute`, as janelas de cada dia são `[start, lunchStart]` e `[lunchEnd, end]` menos os intervalos de `busy`. O início de cada janela é arredondado para cima e o fim para baixo, em múltiplos de 15. A capacidade do dia é `dailyLimit` menos a soma de `busy` naquele dia.
- [ ] **Step 4:** `node --test test/worklog.time.test.js` → PASS.

### Task 2: Frases-modelo (`models.js` e `src/worklog/comments.js`)

**Files:** Modify `src/support/models.js` (acrescentar `comments: string[8]` aos dois modelos). Create `src/worklog/comments.js`. Test `test/worklog.comments.test.js`.

**Interfaces:**
- Produces: `pickComments(model, ctx, n, rng = Math.random) -> string[]`, onde `ctx = { epicKey, epicSummary, taskKey }`.
- Substitui `{EPICO}` por `epicKey - epicSummary` e `{TAREFA}` por `taskKey`, usando um replacer em função (para tratar `$` no texto).

Frases (texto fixado aqui):
- Análise:
  1. `Levantamento de requisitos com o usuário-chave da demanda {EPICO}.`
  2. `Análise das fontes de dados envolvidas na demanda {EPICO}.`
  3. `Reunião de entendimento da necessidade da demanda {EPICO}.`
  4. `Mapeamento das regras de negócio da demanda {EPICO}.`
  5. `Diagnóstico da solução de BI atual para a demanda {EPICO}.`
  6. `Verificação dos QVDs e scripts de carga impactados pela demanda {EPICO}.`
  7. `Definição do escopo e dos indicadores da demanda {EPICO}.`
  8. `Registro das necessidades levantadas para a demanda {EPICO}.`
- Implementação:
  1. `Ajustes no script de carga do Qlik Sense para a demanda {EPICO}.`
  2. `Desenvolvimento de scripts Python para a demanda {EPICO}.`
  3. `Desenvolvimento de telas e objetos no Qlik Sense para a demanda {EPICO}.`
  4. `Criação e validação de expressões e medidas da demanda {EPICO}.`
  5. `Testes de carga e conferência dos dados da demanda {EPICO}.`
  6. `Correções após validação com o usuário-chave da demanda {EPICO}.`
  7. `Otimização do modelo de dados da demanda {EPICO}.`
  8. `Publicação e conferência do aplicativo da demanda {EPICO}.`

- [ ] **Step 1: Testes que falham**
  - `n = 8` gera 8 frases distintas;
  - `n = 10` gera 10 frases, e as 8 primeiras são distintas;
  - `{EPICO}` é substituído;
  - o resumo `'R$$ 1'` aparece literal no texto;
  - um `rng` fixo gera um resultado determinístico.
- [ ] **Step 2:** `node --test test/worklog.comments.test.js` → FAIL.
- [ ] **Step 3:** Implementar com um embaralhamento Fisher–Yates usando `rng`, repetido em ciclos.
- [ ] **Step 4:** `node --test test/worklog.comments.test.js` e `npm test` → PASS. Os testes de `support.render` continuam verdes.

### Task 3: Comentários por IA (`src/worklog/ai.js`)

**Files:** `npm install @anthropic-ai/sdk`. Create `src/worklog/ai.js`. Test `test/worklog.ai.test.js`.

**Interfaces:**
- Produces: `createAiCommenter({ apiKey, client? }) -> { enabled: boolean, generate(entries, ctxByTask) -> Promise<string[]> }`. O `client` padrão é `new Anthropic({ apiKey })`, e `enabled` é `Boolean(apiKey || client)`.
- `entries: [{ taskKey, model, date, minutes }]`.
- `ctxByTask[taskKey] = { epicKey, epicSummary, taskSummary }`.
- Lança `AiError(message)` em caso de recusa, JSON inválido ou quantidade errada de comentários.

A chamada usa:
- `client.beta.messages.create({ model: 'claude-opus-5-5', max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system, messages })`;
- `schema = { type: 'object', properties: { comments: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' } }, required: ['index', 'text'], additionalProperties: false } } }, required: ['comments'], additionalProperties: false }`;
- `system`: "Você escreve comentários curtos de apontamento de horas (worklog) para uma equipe de BI/Qlik Sense de um tribunal. Uma frase em português do Brasil por lançamento, até 160 caracteres, sem inventar fatos além do contexto, coerente com o tipo da tarefa (análise = levantamento/diagnóstico; implementação = scripts, telas, testes). Varie as frases entre lançamentos.";
- `messages`: uma mensagem `user` com o JSON dos lançamentos e o índice de cada um.

O texto da resposta é o primeiro bloco `text`. O JSON é ordenado por `index` e o resultado é cortado em 160 caracteres.

- [ ] **Step 1: Testes que falham**, com um `client` simulado que registra os parâmetros:
  - os parâmetros contêm `model`, `effort: 'low'`, `fallbacks: 'default'`, o beta e o `schema`;
  - devolve os textos na ordem dos índices;
  - `stop_reason: 'refusal'` → `AiError` com "recusou";
  - JSON com menos itens que os lançamentos → `AiError`;
  - `enabled === false` sem chave e sem client.
- [ ] **Step 2:** `node --test test/worklog.ai.test.js` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `node --test test/worklog.ai.test.js` → PASS.

### Task 4: Serviço de apontamento (`src/worklog/service.js`)

**Files:**
- Modify `src/support/service.js`: mover a regra `modelOf` para `src/support/render.js` como `modelOfTask(task)` exportado, sem mudar o comportamento. Os testes existentes continuam verdes.
- Create `src/worklog/service.js`. Test `test/worklog.service.test.js`.

**Interfaces:**
- Consumes: `client.call`; `supportService.listItems({ onlyEpics: true })`; `modelOfTask`; tudo das Tasks 1 a 3; `JiraError` e `jiraMessage` de `support/service.js`.
- Produces: `createWorklogService({ client, baseUrl, supportService, ai }) -> { listTasks, preview, aiComments, submit }`, com:
  - `listTasks() -> { epics: [{ key, summary, status, url, tasks: [{ key, model, summary, status, url, timeSpentMin }] }], aiEnabled }`. A busca é `project = QSENSE AND parent in (...)` com os campos `summary, status, parent, timespent, customfield_10104`, e só entram as tarefas cujo `modelOfTask` não é nulo;
  - `busy(from, to) -> [{ date, startMin, endMin }]`, conforme a spec §5;
  - `preview({ items: [{ taskKey, minutes }], from, to, schedule }) -> { entries: [..., comment], unallocated, transitions: [{ key, from, to: 'Em Execução' }] }`;
  - `aiComments(entries) -> { comments }`;
  - `submit({ entries, schedule }) -> { results, transitions }`, ou lança `ConflictError` (409).
- `ConflictError` e `ScopeError` são exportados. `ScopeError` vira 400 na rota.
- O `submit` roda numa fila única, igual à de `support/service.js`. Dentro da fila:
  1. revalida o escopo das tarefas;
  2. chama `busy` nos dias envolvidos e lança `ConflictError` se houver sobreposição;
  3. grava os worklogs em sequência;
  4. aplica as transições: tarefa em `Aberto` e épico nos status "não iniciados", buscando o id da transição pelo `to.name === 'Em Execução'`.

- [ ] **Step 1: Testes que falham**, com um Jira simulado com estado (worklogs, status e transições):
  - `listTasks` agrupa por épico e devolve `timeSpentMin = timespent / 60`;
  - `busy`:
    - filtra worklogs de outro autor e fora do período;
    - converte `2026-11-04T23:30:00.000+0000` para `2026-11-04` 20:30 em -03:00;
  - `preview`:
    - gera os lançamentos com comentário;
    - prevê a transição de uma tarefa em Aberto e não prevê a de um épico em `Em Homologação`;
  - `submit`:
    - grava com `timeSpent: '1h 30m'` e `started` correto, chamando `?notifyUsers=false`;
    - lança 409 quando há sobreposição;
    - lança `ScopeError` para uma tarefa fora do escopo;
    - um erro num worklog não impede os outros;
    - a tarefa em Aberto vai para Em Execução, e o épico em Aberto também;
    - transição ausente → `status: 'error'` com aviso, e os worklogs ficam gravados;
    - dois `submit` simultâneos com a mesma prévia → o segundo recebe `ConflictError`.
- [ ] **Step 2:** `node --test test/worklog.service.test.js` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → tudo verde.

### Task 5: Rotas (`src/server.js` e `src/index.js`)

**Files:** Modify `src/server.js` (`registerWorklogRoutes`, reaproveitando o handler com checagem de Origin e token — extrair `guardedHandler` compartilhado com as rotas de support) e `src/index.js` (`createAiCommenter({ apiKey: process.env.ANTHROPIC_API_KEY })` e o serviço). Test: acréscimos em `test/server.test.js`. `.env.example` ganha `ANTHROPIC_API_KEY=` (opcional) com um comentário.

**Interfaces:** as rotas da spec §5.
- `ConflictError` → 409; `ScopeError` → 400; `AiError` → 502; IA desativada → 404.
- Validação na rota:
  - datas e horários com regex;
  - limites globais;
  - `from <= to` e no máximo 31 dias;
  - `schedule` coerente (`start < lunchStart <= lunchEnd < end`).

- [ ] **Step 1: Testes que falham:**
  - `tasks` repassa o resultado;
  - `preview` valida o período (32 dias → 400, `to < from` → 400);
  - `submit`:
    - 0 lançamentos → 400; 201 → 400;
    - 20 min → 400; comentário com 1001 caracteres → 400;
    - hora `'25:00'` → 400;
    - Origin externo → 403;
    - `ConflictError` → 409;
  - `ai-comments` → 404 quando a IA está desativada.
- [ ] **Step 2:** `node --test test/server.test.js` → FAIL nos testes novos.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → tudo verde.

### Task 6: Interface e mock

**Files:**
- Create `public/apontar.html` e `public/apontar.js`.
- Modify `public/index.html` e `public/apoio.html` (link "Apontar horas" no topo) e `public/style.css` (só o necessário).
- Modify `scripts/mock-support.js`:
  - tarefas de apoio simuladas em BI-2931 (uma em Aberto) e BI-2861 (Concluídas);
  - worklogs, `GET/POST .../worklog`, `GET/POST .../transitions`;
  - busca `worklogAuthor`;
  - um worklog existente às 09:00–10:00 de um dia útil da semana;
  - IA simulada que devolve frases fixas.

**Elementos (ids):**
- seleção: `epics` (container);
- período e expediente: `from`, `to`, `start`, `lunchStart`, `lunchEnd`, `end`, `dailyLimit`;
- ações: `btnPreview`, `btnAi`, `btnSubmit`;
- prévia: `previewTable` (tbody `previewRows`), `summary`, `unallocated`, `transitions`;
- erros: `errorBox`.

Comportamento conforme a spec §6:
- o expediente é salvo em `localStorage`, com try/catch;
- a prévia permite editar o comentário e remover linhas;
- `btnSubmit` desativa a tela enquanto grava;
- um 409 mostra a mensagem da spec.

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificar no navegador** (`preview_start apoio-mock`, `/apontar.html`):
  - o modo individual gera lançamentos que desviam do horário 09:00–10:00;
  - o modo "Dividir total" de 4h com 30% gera 1h 15m e 2h 45m;
  - a quebra no almoço aparece;
  - um período curto gera o aviso de horas sem horário;
  - "Gerar com IA" substitui os comentários;
  - é possível editar e remover linhas;
  - confirmar mostra o resultado e as transições;
  - repetir a mesma prévia gera 409;
  - o console fica sem erros;
  - em 375 px não há rolagem horizontal da página.
- [ ] **Step 3:** `npm test` → verde.

### Task 7: README e validação real

- [ ] **Step 1:** README: seção "Apontamento de horas", explicando o que faz, a `ANTHROPIC_API_KEY` opcional e o custo, o aviso de que a tela grava no Jira e muda status, e onde editar as frases.
- [ ] **Step 2:** App real: abrir `/apontar.html` e conferir a lista de tarefas e a prévia (só leitura).
- [ ] **Step 3:** Com o ok do usuário, gravar **um** lançamento de 15 min na tarefa que ele escolher. Conferir o worklog e o status no Jira e pedir que ele confira no Clockwork.
