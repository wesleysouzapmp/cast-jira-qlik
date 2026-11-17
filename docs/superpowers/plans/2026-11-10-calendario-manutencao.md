# Calendário: dias úteis, feriados e manutenção — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O calendário mostra só os dias úteis (com opções para fins de semana e feriados). O app conhece os feriados nacionais e os da lista `feriados.json`. Clicar num dia abre um painel para editar, mover e excluir batidas, salvando tudo em lote.

**Architecture:**
- Feriados em funções puras (`src/worklog/holidays.js`) mais um leitor de arquivo injetável.
- `time.js` passa a aceitar um conjunto de feriados.
- `worklog/service.js` ganha `batch(changes)`, na mesma fila e com a mesma memória contra o atraso do índice de busca.
- Rotas novas `/api/holidays` e `/api/worklog/batch`.
- `public/calendar.js` ganha as opções de exibição e o painel do dia, num módulo próprio: `public/daypanel.js`.

**Tech Stack:** Node 24 ESM, Express 4, `node --test`, HTML/JS puro.

**Spec:** `docs/superpowers/specs/2026-11-10-calendario-manutencao-design.md`

## Global Constraints

- Feriados nacionais: as datas fixas e as móveis (Carnaval −48 e −47, Sexta-feira Santa −2, Corpus Christi +60) estão em §3 da spec, com os nomes exatos.
- O `feriados.json` fica na raiz e é lido a cada pedido. Arquivo ausente ou inválido conta como lista vazia; o caso inválido também gera um aviso no log.
- Limites:
  - `GET /api/holidays`: no máximo 400 dias;
  - `batch`: de 1 a 100 itens, `id` só com dígitos e sem repetição;
  - numa alteração: início em múltiplo de 15, duração de 15 a 480 min sem passar de 24:00, e comentário com até 1000 caracteres.
- Toda escrita usa `notifyUsers=false`. Mudança de tarefa: primeiro o `POST` no destino, depois o `DELETE` na origem. Se o `DELETE` falhar, o status é `duplicated`.
- `batch` roda na mesma fila do `submit`. Erros: `ScopeError` → 400, `ConflictError` → 409, `JiraError` → 502.
- Fuso -03:00. Texto do Jira só entra na página por `textContent`.
- As opções "Mostrar sábados e domingos" e "Mostrar feriados" vêm desmarcadas e ficam salvas em `localStorage` (com try/catch).
- Sem git: commits pulados (ledger).

## Review Focus

1. **Batida movida para um horário que só fica livre porque ela mesma sai de lá:** precisa ser aceita, não pode virar 409. Teste na Task 3.
2. **Duas abas salvando o mesmo lote:** o segundo envio não pode apagar nem duplicar nada. As batidas relidas já não existem, então o resultado é `ScopeError` ou erro na linha, sem escrita. Teste na Task 3.
3. **`feriados.json` com JSON inválido ou um período com `from > to`:** o app não pode quebrar; ignora o item e segue. Teste na Task 1.
4. **Batida que acabou de ser apagada:** não pode reaparecer no calendário nem bloquear horários, mesmo com o índice de busca atrasado. Teste na Task 3.
5. **Feriado coincidindo com sábado ou domingo, com fim de semana oculto e feriado exibido:** a célula não aparece. A regra: o fim de semana manda. Verificação na Task 5.

---

### Task 1: Feriados (`src/worklog/holidays.js`, `feriados.json`)

**Files:** Create `src/worklog/holidays.js`, `feriados.json`. Test `test/worklog.holidays.test.js`.

**Interfaces (Produces):**
- `easterSunday(year) -> 'YYYY-MM-DD'`;
- `nationalHolidays(year) -> [{ date, name }]`;
- `expandCustom(list) -> [{ date, name }]`;
- `holidaysBetween(from, to, custom = []) -> Map<date, name>`;
- `createHolidayProvider({ file = <raiz>/feriados.json, readFile = fs.promises.readFile, log = console.warn }) -> { between(from, to) -> Promise<Map> }`.

- [ ] **Step 1: Testes que falham**
  - `easterSunday(2026) === '2026-04-05'`, `easterSunday(2027) === '2027-03-28'`, `easterSunday(2024) === '2024-03-31'`;
  - `nationalHolidays(2026)` contém `{ date: '2026-02-16', name: 'Carnaval' }`, `'2026-02-17'`, `{ date: '2026-04-03', name: 'Sexta-feira Santa' }`, `{ date: '2026-06-04', name: 'Corpus Christi' }`, `{ date: '2026-11-02', name: 'Finados' }` e `{ date: '2026-11-20', name: 'Dia Nacional de Zumbi e da Consciência Negra' }`, num total de 13 itens;
  - `expandCustom`:
    - `[{ from: '2026-12-30', to: '2027-01-02', name: 'R' }]` gera 4 datas;
    - itens inválidos (`{ date: 'x' }`, `{ from: '2026-12-02', to: '2026-12-01' }`, `null`) são ignorados;
  - `holidaysBetween('2026-11-01', '2026-11-30', [{ date: '2026-11-02', name: 'Finados (TJMG)' }])` → `get('2026-11-02') === 'Finados (TJMG)'` e contém o 15/11 e o 20/11;
  - provider:
    - com `readFile` que lança ENOENT → só os nacionais, sem aviso no log;
    - com JSON inválido → só os nacionais e um aviso no log;
    - o arquivo é lido em todas as chamadas.
- [ ] **Step 2:** `node --test test/worklog.holidays.test.js` → FAIL.
- [ ] **Step 3:** Implementar. A Páscoa usa o algoritmo de Meeus/Jones/Butcher. Criar o `feriados.json` com as entradas de §3 da spec para 2026 e 2027.
- [ ] **Step 4:** PASS.

### Task 2: Dias úteis sem feriados (`time.js`, `preview`, rota `/api/holidays`)

**Files:** Modify `src/worklog/time.js` (`businessDays(from, to, holidays = new Set())` e `distribute({ ..., holidays })`), `src/worklog/service.js` (`createWorklogService({ ..., holidays })`: o `preview` busca `holidays.between(from, to)` e passa as datas para `distribute`), `src/server.js` (`GET /api/holidays`, que recebe o provider por `createApp({ ..., holidayProvider })`) e `src/index.js`. Tests: `test/worklog.time.test.js`, `test/worklog.service.test.js`, `test/server.test.js`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `GET /api/holidays?from&to` → `{ holidays: [{ date, name }] }`;
  - o serviço de apontamento recebe `holidays` (provider) e usa `{ between: async () => new Map() }` quando ele não é informado.

- [ ] **Step 1: Testes que falham:**
  - `businessDays('2026-11-02', '2026-11-03', new Set(['2026-11-02']))` → `['2026-11-03']`;
  - `distribute` com `holidays = Set(['2026-11-09'])` começa em 10/11;
  - `preview` com provider que devolve 09/11 → nenhum lançamento em 09/11;
  - rota: o período válido repassa ao provider; 401 dias → 400; datas inválidas → 400.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → verde.

### Task 3: `batch` no serviço

**Files:** Modify `src/worklog/service.js`. Test `test/worklog.service.test.js`. Modify `test/fakeJira.js`: `GET`, `PUT` e `DELETE` em `/issue/{key}/worklog/{id}` e a opção `failDeleteFor: [id]`.

**Interfaces:**
- Produces: `batch({ changes }) -> { results: [{ id, status, newId?, error? }], transitions }`, conforme §6 da spec.
- Estado novo em memória: `deleted: Set<id>`. Os ids desse conjunto são ignorados em `myWorklogs`, e as entradas de `written` com esses ids são descartadas.

- [ ] **Step 1: Testes que falham** (o Jira simulado tem worklogs do usuário em QSENSE-1 e QSENSE-2 e um de outro autor):
  - alteração: `PUT` em `/rest/api/3/issue/QSENSE-1/worklog/7` com `query.notifyUsers === 'false'`, `timeSpent '1h 30m'`, `started '2026-11-09T10:00:00.000-0300'` e o comentário em ADF;
  - comentário vazio → `comment: null`;
  - exclusão: `DELETE`, status `deleted`; depois disso `myWorklogs` não lista o id 7, mesmo com `indexLag`;
  - mudança de tarefa (de QSENSE-1 para QSENSE-3): a ordem das chamadas é `POST` em QSENSE-3 e depois `DELETE` em QSENSE-1/7; status `moved` com `newId`; a tarefa QSENSE-3, em Aberto, passa para Em Execução;
  - `failDeleteFor: ['7']` numa mudança de tarefa → `duplicated`, com o texto "não pôde ser apagada";
  - batida de outro autor → `ScopeError`, sem escrita;
  - `targetKey` fora do escopo → `ScopeError`;
  - nova posição sobreposta a outra batida → `ConflictError`, sem escrita;
  - batida 7 (08:00–09:00) movida para 08:30 no mesmo dia, sem outras batidas no intervalo → aceita;
  - mudança de data para um dia livre → `PUT` com o novo `started`;
  - o mesmo lote enviado duas vezes, com exclusões → o segundo recebe `ScopeError` (a batida não existe mais) e não faz nenhum `DELETE` a mais.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar. A releitura usa `GET /issue/{k}/worklog/{id}`: um 404 ou outro autor viram `ScopeError` com a chave e o id. A checagem de sobreposição reaproveita a regra `overlaps` do `submit`.
- [ ] **Step 4:** `npm test` → verde.

### Task 4: Rota `POST /api/worklog/batch`

**Files:** Modify `src/server.js` (`parseChanges` e a rota). Test `test/server.test.js`.

- [ ] **Step 1: Testes que falham:**
  - um lote válido chega ao serviço já normalizado;
  - casos que respondem 400:
    - lote vazio ou com 101 itens;
    - `id: 'a1'`;
    - `id` repetido;
    - `action: 'move'`;
    - alteração sem `date`;
    - início `'08:10'`;
    - 495 min;
    - `targetKey` inválido;
    - comentário com 1001 caracteres;
  - Origin externo → 403;
  - `ConflictError` → 409.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` → verde.

### Task 5: Calendário (dias úteis e feriados) e painel do dia

**Files:**
- Modify `public/calendar.js`:
  - opções `showWeekends` e `showHolidays`;
  - feriados carregados com `/api/holidays` para o intervalo da grade;
  - colunas de 5 ou 7 dias;
  - célula vazia com o nome para feriado oculto;
  - setas da visão Dia pulando dias ocultos;
  - o clique chama `onOpenDay(date)` em vez de `onPick`; o Shift+clique continua estendendo o período.
- Create `public/daypanel.js`: `openDayPanel({ date, entries, tasks, limit, onSaved, onUsePeriod })`, com o `<dialog>`, a tabela editável, a validação ao vivo, o `confirm` com resumo, o `POST /api/worklog/batch` e o resultado em cada linha.
- Modify `public/apontar.html`: as duas caixas na barra do calendário e o `<dialog id="dayPanel">`.
- Modify `public/apontar.js`: ligar o `onOpenDay` (usando as tarefas carregadas e as batidas daquele dia) e o `onSaved`, que recarrega o calendário e as tarefas.
- Modify `public/style.css`.
- Modify `scripts/mock-support.js`: `GET`, `PUT` e `DELETE` de worklog por id, e worklogs do autor em mais de uma tarefa, inclusive SIJUD-1 (fora do escopo de apoio).

- [ ] **Step 1: Implementar.**
- [ ] **Step 2: Verificar no navegador** (`apoio-mock`):
  - o mês aparece com 5 colunas e Finados oculto (célula com o nome);
  - marcar as duas opções mostra 7 colunas e Finados em cinza;
  - um feriado num sábado com o fim de semana oculto não aparece;
  - clicar num dia abre o painel com as batidas;
  - num lote: editar a duração de uma batida, mover outra para a tarefa de apoio, excluir uma terceira e confirmar; os resultados aparecem em cada linha e o calendário se atualiza;
  - a batida de SIJUD-1 pode ser editada, mas a lista de destino só traz tarefas de apoio;
  - criar uma sobreposição mostra o aviso ao vivo, e forçar o envio dá 409;
  - o console fica sem erros;
  - em 375 px não há rolagem horizontal da página.
- [ ] **Step 3:** `npm test` → verde.

### Task 6: README e validação real

- [ ] **Step 1:** README: feriados (o que é automático e como editar o `feriados.json`), as opções do calendário e o painel do dia, com o aviso de que exclusões e mudanças de tarefa são irreversíveis.
- [ ] **Step 2:** App real (só leitura): o calendário de novembro com Finados oculto e o 20/11 como feriado; o painel de 09/11 lista as batidas.
- [ ] **Step 3:** Com o ok do usuário, editar o comentário do lançamento de 15m de QSENSE-4085 (09/11) e conferir no Jira.
