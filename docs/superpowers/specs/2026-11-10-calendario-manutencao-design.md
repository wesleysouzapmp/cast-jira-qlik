# Calendário: dias úteis, feriados e manutenção de batidas — Design

**Data:** 2026-11-10
**Projeto:** `cast-jira-qlik`
**Status:** design aprovado em conversa; aguardando revisão desta spec
**Depende de:** `2026-11-10-apontamento-horas-design.md`, que define o serviço de apontamento, a função `myWorklogs`, a fila e as regras de transição. O calendário Dia/Semana/Mês já está implementado.

## 1. Objetivo

1. O calendário mostra **só os dias úteis** por padrão. Sábados e domingos aparecem quando a opção correspondente está marcada, e feriados também.
2. O app passa a conhecer **feriados**: os nacionais são calculados e os locais vêm de uma lista editável. O gerador de batidas deixa de usar feriados.
3. **Clicar num dia** abre um painel com as batidas do dia. Nele é possível alterar início, duração, comentário, tarefa e data, ou excluir batidas, e **salvar tudo de uma vez**.

**Critério de sucesso:**
- O mês e a semana mostram de segunda a sexta, sem feriados, enquanto as opções estiverem desmarcadas.
- A prévia nunca coloca batidas em feriados.
- Uma edição em lote com alteração, mudança de tarefa e exclusão é aplicada no Jira e o calendário reflete o resultado.
- Nenhuma edição cria sobreposição nem altera worklog de outra pessoa.

## 2. O que foi dito vs. premissas

| Dito pelo usuário | Premissa assumida |
|---|---|
| Sempre os dias úteis; flag para sábado, domingo e feriados | São duas caixas, "Mostrar sábados e domingos" e "Mostrar feriados", desmarcadas por padrão e salvas no `localStorage` |
| Feriados: nacionais e lista editável | Os nacionais incluem os pontos facultativos de Carnaval (segunda e terça) e Corpus Christi. A lista fica em `feriados.json`, na raiz do projeto |
| Clicar no dia lista as batidas para manutenção | O clique abre o painel. "Usar este dia como período" fica dentro do painel. O Shift+clique e o "Usar período exibido" continuam como estão |
| Alterar início, duração, comentário, tarefa e data; excluir | Tudo é salvo num único envio, depois de uma confirmação com resumo |
| Todas as suas batidas | Pode ser qualquer worklog do usuário, em qualquer projeto. O destino de "mudar tarefa" só pode ser uma tarefa de apoio dos épicos em aberto do usuário |

## 3. Feriados

- `src/worklog/holidays.js`, com funções puras:
  - `easterSunday(year) -> 'YYYY-MM-DD'` (algoritmo de Meeus/Jones/Butcher);
  - `nationalHolidays(year) -> [{ date, name }]`:
    - datas fixas: 01/01 Confraternização Universal; 21/04 Tiradentes; 01/05 Dia do Trabalho; 07/09 Independência; 12/10 Nossa Senhora Aparecida; 02/11 Finados; 15/11 Proclamação da República; 20/11 Dia Nacional de Zumbi e da Consciência Negra; 25/12 Natal;
    - datas móveis: Carnaval (segunda, Páscoa −48; terça, Páscoa −47); Sexta-feira Santa (Páscoa −2); Corpus Christi (Páscoa +60);
  - `expandCustom(list) -> [{ date, name }]`: aceita `{ date, name }` e `{ from, to, name }` (com os dois extremos incluídos) e ignora itens inválidos;
  - `holidaysBetween(from, to, custom) -> Map<date, name>`: junta nacionais e locais. Se as duas listas tiverem a mesma data, vale o nome da lista local.
- `feriados.json`: um array JSON, lido a cada pedido (sem cache), o que permite editar sem reiniciar.
  - Arquivo ausente equivale a uma lista vazia.
  - JSON inválido gera um aviso no log e também conta como lista vazia.
  - O arquivo já vem com estas entradas, para o usuário conferir: 15/08 "Assunção de Nossa Senhora (BH)", 08/12 "Imaculada Conceição (BH)" e de 20/12 a 06/01 "Recesso forense (TJMG)", para 2026 e 2027.
- `businessDays(from, to, holidays = new Set())` exclui também as datas do conjunto. `distribute` recebe `holidays` (Set) e repassa.
- Rota `GET /api/holidays?from=&to=` (até 400 dias) → `{ holidays: [{ date, name }] }`.
- `preview` passa os feriados do período para `distribute`.

## 4. Calendário

- O mês tem 5 colunas (segunda a sexta), ou 7 com fim de semana. A grade de dados continua com 42 dias, e as colunas ocultas não são desenhadas.
- Um feriado oculto vira uma célula vazia, não clicável, com o nome em cinza (ex.: "Finados"). Um feriado exibido é uma célula clicável em cinza, com o nome, sem a cor de meta, e pode ter batidas.
- A semana tem 5 ou 7 colunas. Um feriado oculto vira uma coluna estreita com o nome.
- As setas da visão Dia pulam os dias ocultos.
- O "Usar período exibido" ignora feriados porque o gerador já os pula.
- As cores de meta (verde, âmbar e vermelho) só valem para dias úteis.

## 5. Painel de batidas (manutenção)

- Clicar num dia, em qualquer visão, abre um `<dialog>` com o título "Batidas de seg, 09/11/2026", o total do dia comparado à meta e os botões "Usar este dia como período", "Salvar alterações" e "Fechar".
- Cada batida é uma linha editável:
  - **Tarefa:** um `<select>` com a tarefa atual (mesmo de outro projeto) seguida das tarefas de apoio (chave, Análise ou Implementação, épico);
  - **Data** (date), **Início** (time, passo de 15 min), **Duração** (texto, `parseDuration`) e **Comentário** (até 1000 caracteres);
  - **Excluir** (checkbox).
- Uma linha alterada fica destacada, e uma linha marcada para exclusão aparece riscada.
- Validação ao vivo:
  - duração inválida;
  - horário que passa de 24:00;
  - sobreposição com outra batida do mesmo dia, inclusive as que não estão no painel quando a data muda. O servidor confirma essa checagem.
- Clicar em "Salvar alterações" faz o seguinte:
  1. Abre um `confirm()` com o resumo: "Aplicar no Jira: N alteração(ões), M mudança(s) de tarefa, K exclusão(ões)? Exclusões não podem ser desfeitas."
  2. Faz um único `POST /api/worklog/batch`.
  3. Mostra o resultado em cada linha e recarrega o calendário.

## 6. Serviço: `batch(changes)`

Entrada: `changes: [{ id, issueKey, action: 'update'|'delete', date?, start?, minutes?, comment?, targetKey? }]`. O `issueKey` é a tarefa atual da batida. O `targetKey` só aparece quando a batida muda de tarefa.

Roda dentro da mesma fila do `submit`:
1. **Relê** cada batida com `GET /rest/api/3/issue/{issueKey}/worklog/{id}`. Uma batida inexistente, de outro autor ou de outra issue é recusada com `ScopeError`.
2. Confere o destino: todo `targetKey` precisa ser uma tarefa de apoio do escopo (`ScopeError`).
3. **Sobreposição.** O resultado final dos dias afetados (os dias originais e os novos de cada batida) não pode ter intervalos sobrepostos.
   - Os intervalos comparados vêm de `myWorklogs` nesses dias, sem as batidas que estão sendo alteradas ou excluídas, mais os novos intervalos das alteradas.
   - Se houver conflito, o envio inteiro é recusado com `ConflictError`, e a mensagem diz qual batida conflita.
4. Aplica, em ordem:
   - **Alteração na mesma tarefa:** `PUT /rest/api/3/issue/{issueKey}/worklog/{id}?notifyUsers=false` com `{ timeSpent, started, comment }`. Comentário vazio é enviado como `null`.
   - **Mudança de tarefa:**
     1. `POST /rest/api/3/issue/{targetKey}/worklog?notifyUsers=false` com os valores finais;
     2. se der certo, `DELETE /rest/api/3/issue/{issueKey}/worklog/{id}?notifyUsers=false`;
     3. se a exclusão falhar, o resultado é `status: 'duplicated'`, com o aviso "Criada em {targetKey}, mas a original não pôde ser apagada: confira".
   - **Exclusão:** `DELETE ...?notifyUsers=false`.
5. Mantém a memória de batidas recentes (contra o atraso do índice de busca): uma batida apagada não volta a aparecer em `myWorklogs`, e uma batida criada por mudança de tarefa entra em `written`.
6. **Transições:** um `targetKey` com status "Aberto" e o épico dele seguem as mesmas regras do `submit`.

Saída: `{ results: [{ id, status: 'updated'|'moved'|'deleted'|'duplicated'|'error', newId?, error? }], transitions }`.

## 7. Rotas e validação

- `GET /api/holidays?from=&to=`: datas válidas, `from <= to`, no máximo 400 dias.
- `POST /api/worklog/batch` `{ changes }`, com as mesmas proteções das outras rotas (Origin, token):
  - de 1 a 100 itens;
  - `id` só com dígitos;
  - `issueKey` e `targetKey` no formato de chave;
  - `action` igual a `update` ou `delete`;
  - numa alteração: data válida, início HH:MM em múltiplo de 15, duração de 15 a 480 min em múltiplos de 15 sem passar de 24:00, e comentário com até 1000 caracteres;
  - um `id` aparece no máximo uma vez.
- Erros: `ScopeError` → 400, `ConflictError` → 409, `JiraError` → 502.

## 8. Testes

- `test/worklog.holidays.test.js`:
  - Páscoa de 2026 (05/04) e de 2027 (28/03);
  - nacionais de 2026: Carnaval em 16 e 17/02, Sexta-feira Santa em 03/04, Corpus Christi em 04/06;
  - `expandCustom` com período e com item inválido;
  - na junção, prevalece o nome da lista local.
- `test/worklog.time.test.js`: `businessDays` e `distribute` pulando feriados.
- `test/worklog.service.test.js`:
  - `batch`:
    - alteração (corpo e caminho do `PUT`);
    - exclusão;
    - mudança de tarefa (`POST` antes do `DELETE`);
    - exclusão que falha depois de criar → `duplicated`;
    - batida de outro autor → `ScopeError`;
    - destino fora do escopo → `ScopeError`;
    - sobreposição com outra batida → `ConflictError`, sem nenhuma escrita;
    - mudança de data que só cabe porque a batida original sai → aceita;
    - batida apagada some de `myWorklogs`;
    - transição no destino;
  - `preview` não coloca batidas em feriados (o arquivo de feriados é injetado).
- `test/server.test.js`: validação de `batch` e de `holidays`.
- Navegador com o mock:
  - o calendário só com dias úteis e as duas opções;
  - Finados aparece oculto e depois exibido;
  - o painel: editar, mover, excluir, confirmar, ver o resultado e o calendário atualizado;
  - erro 409;
  - tela de 375 px.
- Validação real, com o ok do usuário: editar o comentário do lançamento de 15m de 09/11 (QSENSE-4085) e conferir no Jira.

## 9. Fora do escopo

- Calendário oficial do TJMG baixado automaticamente.
- Criar batidas pelo painel; a criação continua pela prévia.
- Editar batidas de outras pessoas.
