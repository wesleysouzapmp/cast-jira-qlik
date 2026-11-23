# Jira API Tester → Qlik Sense

App local para testar as APIs do Jira Cloud (`https://tjmg.atlassian.net`) antes de configurar a carga no Qlik Sense Enterprise. Com ele você:

- chama os endpoints que alimentam o Qlik: cadastros, issues, changelog, worklogs e agile;
- percorre todas as páginas com a mesma lógica que o script do Qlik vai usar;
- vê o JSON achatado em tabelas, do jeito que o Qlik REST Connector enxerga;
- exporta CSV para o Excel;
- gera o trecho de script de carga do Qlik para cada endpoint testado.

O app só **lê** dados: aceita GET e os POSTs de consulta do catálogo. O token fica no `.env`, na sua máquina, e o servidor só aceita conexões de `localhost`.

## Pré-requisitos

- Node.js 24 ou mais recente
- Um API token da Atlassian, criado com o seu usuário do Jira

## Configuração

1. Crie o token em <https://id.atlassian.com/manage-profile/security/api-tokens> (**Create API token**). Copie o valor, que só aparece uma vez.
2. Na pasta do projeto:
   ```bash
   npm install
   copy .env.example .env
   ```
3. Edite o `.env`:
   ```
   JIRA_BASE_URL=https://tjmg.atlassian.net
   JIRA_EMAIL=seu.email@tjmg.jus.br
   JIRA_API_TOKEN=<token>
   PORT=3100
   ```
4. Inicie o app e abra <http://localhost:3100>:
   ```bash
   npm start
   ```
   O selo **Token OK** e o seu nome no topo confirmam a autenticação.

Para rodar os testes automatizados: `npm test`.

## Roteiro de teste sugerido

| # | Área | Endpoint no app | O que validar |
|---|---|---|---|
| 1 | Cadastros | Usuário autenticado | HTTP 200 e seu nome: a autenticação funciona |
| 2 | Cadastros | Projetos → **Paginar tudo** | Quantidade de projetos visíveis ao usuário do token |
| 3 | Cadastros | Campos | IDs `customfield_XXXXX` (story points, equipe, etc.) para usar no `fields` da busca |
| 4 | Issues | Buscar issues (JQL), `maxResults` = 50 → **Paginar tudo** | Várias páginas via `nextPageToken`; tabela `root` e tabelas-filhas |
| 5 | Changelog | Histórico em lote, com `issueIdsOrKeys` preenchido com chaves do passo 4 | Tabela `root.histories.items` com as transições de status |
| 6 | Worklogs | IDs de worklogs alterados → Worklogs por IDs | Carga incremental de horas apontadas |
| 7 | Agile | Boards → Sprints de um board → Issues de uma sprint | Sprints só existem em boards scrum |

Dicas:
- A JQL precisa ter restrição (por exemplo `project = ABC` ou `updated >= -30d`). Consultas sem limite são recusadas pelo `/search/jql`.
- **Máx. páginas** (padrão 20) evita varrer o Jira inteiro sem querer. Aumente quando quiser medir o volume total.
- O texto formatado do Jira (descrição, comentários) já aparece como texto simples nas tabelas.

## Levando para o Qlik Sense

1. No hub ou QMC, crie uma conexão **REST**:
   - URL: `https://tjmg.atlassian.net/rest/api/3/myself`. A URL é sobrescrita pelo script.
   - Method: `GET`.
   - Authentication: **Basic**, com o mesmo e-mail e API token.
   - Marque **Allow "WITH CONNECTION"**.
   - Nome: `Jira_REST`, ou o nome informado no campo *Conexão Qlik* do app.
2. Para os endpoints POST (*Histórico em lote*, *Worklogs por IDs*), crie uma segunda conexão igual, com **Method = POST**, chamada `Jira_REST_POST`.
3. Na aba **Script Qlik** do app, copie o trecho gerado e cole no editor de carga.
4. O script gerado traz as colunas escalares de primeiro nível e o laço de paginação. Para objetos aninhados (por exemplo `fields.status.name`) e tabelas-filhas, use o assistente **Selecionar dados** do conector REST e reaproveite o laço de paginação do script gerado.

## Tarefas de apoio (QSENSE)

Página: <http://localhost:3100/apoio.html>. Também há um link no topo do app.

Lista os itens em aberto atribuídos a você. O filtro **Só épicos** vem ligado. Para cada épico marcado, a página cria duas tarefas do tipo **Tarefa de apoio** no projeto QSENSE:

| Tarefa | Item do Catálogo |
|---|---|
| `Analise da demanda <chave> - <resumo do épico>` | Business Intelligence › CAT-105 |
| `Implementação da demanda <chave> - <resumo do épico>` | Business Intelligence › CAT-166 |

Em todas as tarefas, o épico fica como pai, o componente é **Qlik Sense** e você é o responsável.

> **Atenção: esta página grava no Jira.** É a única parte do app que escreve. Antes de criar, ela mostra uma prévia para você confirmar. Se o épico já tiver uma das tarefas, essa tarefa é pulada. Uma tarefa do QSENSE filha do épico conta como já existente quando o Item do Catálogo é CAT-105 (análise) ou CAT-166 (implementação). Se o catálogo estiver vazio, vale o começo do resumo. Por isso, repetir a operação não cria duplicatas.

- Para mudar textos ou itens do catálogo, edite `src/support/models.js` e reinicie com `npm start`.
- Itens que não são épicos aparecem com o filtro desligado, mas não recebem tarefas: o Jira só aceita uma "Tarefa de apoio" filha de épico.
- Para testar a tela sem tocar no Jira, rode `node scripts/mock-support.js` e abra <http://localhost:3101/apoio.html>. O épico BI-9999 simula um erro do Jira.

## Apontamento de horas (Clockwork)

Página: <http://localhost:3100/apontar.html>. Também há um link no topo das outras páginas.

Lança horas nas tarefas de apoio dos seus épicos em aberto. Os lançamentos são worklogs nativos do Jira, os mesmos que o Clockwork Pro mostra.

0. **Meus apontamentos (calendário).** No topo da página, as visões Dia, Semana, Mês e Fechamento mostram os seus worklogs no Jira (os mesmos do My Work Overview do Clockwork), de todos os projetos. Cada dia aparece em verde quando atinge o limite diário, em âmbar quando fica abaixo e em vermelho quando passa dele. Clique num dia para usá-lo como período; Shift+clique estende o período até o dia clicado; "Usar período exibido" preenche a semana (segunda a sexta), o mês ou o fechamento exibido.
   - **Fechamento.** Vai do dia inicial do mês anterior ao dia final do mês de referência (padrão: 21 a 20; o fechamento de novembro é 21/10 a 20/11). Os dois dias aparecem ao lado das caixas de exibição, ficam salvos no navegador e, se não existirem no mês, viram o último dia dele. O período pode ter até 62 dias.
   - **Indicadores.** Acima do calendário, para o período exibido: dias úteis, dias trabalhados (úteis com alguma batida), dias a trabalhar (úteis de hoje até o fim ainda sem batida), horas previstas (dias úteis × limite por dia), horas executadas (todas as batidas do período, inclusive em fim de semana e feriado) e saldo.
   - **Dias úteis e feriados.** Por padrão, o calendário mostra só os dias úteis. As caixas "Mostrar sábados e domingos" e "Mostrar feriados" exibem o resto. Um feriado oculto aparece como espaço vazio com o nome.
   - **Feriados.** Os nacionais são calculados automaticamente, inclusive Carnaval e Corpus Christi, que legalmente são pontos facultativos. Os locais (BH, recesso do TJMG) ficam em `feriados.json`, na raiz, e aceitam `{ "date": "AAAA-MM-DD", "name": "…" }` ou `{ "from": "…", "to": "…", "name": "…" }`. O arquivo é relido a cada consulta, sem precisar reiniciar o app. O gerador de batidas também pula os feriados.
   - **Painel do dia.** Clique num dia para ver as batidas. Você pode alterar tarefa, data, início, duração e comentário, ou marcar batidas para exclusão, e depois salvar tudo de uma vez.
     - A tarefa de destino só pode ser uma tarefa de apoio sua.
     - Ao mudar a tarefa, o app cria a batida na tarefa nova e apaga a original.
     - **Exclusões e mudanças de tarefa não podem ser desfeitas.**
     - Antes de gravar, o servidor relê cada batida, confere se ela é sua e se não foi alterada em outro lugar, e verifica sobreposições. Havendo conflito, nada é gravado.
     - Batidas antigas fora dos blocos de 15 min (ex.: 20m às 09:07) só mudam se você alterar esses campos.
1. **Horas por tarefa.** Marque as tarefas e informe as horas (`1h 30m`, `1,5`, `90m` ou `1:30`). Com **Dividir total**, informe o total do épico e o percentual de Análise (padrão 30%); o resto vai para Implementação. As horas são arredondadas em blocos de 15 min.
   - **No total ou por dia útil.** O seletor ao lado das horas define o modo. "No total" distribui as horas no período. "Por dia útil" repete as horas em cada dia útil do período (até 8h por dia), por exemplo 2h de segunda a sexta. As horas por dia entram primeiro, nos horários livres; as do modo total usam o que sobra. Quando um dia não comporta as horas, a prévia avisa: "faltaram 30m em 09/11".
   - **Outras tarefas e favoritos.** Abaixo das tarefas de apoio, informe a chave de qualquer tarefa do Jira (ex.: `SIJUD-123`) e clique em Adicionar. O app confere a chave no Jira e recusa épicos e chaves inexistentes ou sem acesso. Essas tarefas usam frases genéricas com chave e resumo (ou a IA), e o app não muda o status delas. Clique em ☆ para guardar a tarefa nos favoritos: ela fica em `favoritos.json`, na raiz, e aparece sempre que a tela abre. ✕ só tira da lista da tela. Mudar a tarefa de uma batida no painel do dia continua restrito às tarefas de apoio.
2. **Período e expediente.** Escolha as datas e o expediente (padrão 08:00–12:00 e 13:00–17:00, até 8h por dia). O expediente fica salvo no navegador.
3. **Prévia.** O app distribui as horas pelos dias úteis (segunda a sexta), nos horários livres. O que você já apontou no Jira em qualquer tarefa é respeitado. Cada lançamento recebe um comentário sorteado de um banco de frases; você pode editar ou remover lançamentos.
4. **Confirmar.** Grava os worklogs com duração no formato `1h 30m`, início e comentário.

> **Atenção: esta página grava no Jira e muda status.**
> - Depois de gravar algum lançamento numa tarefa em **Aberto**, ela passa para **Em Execução**.
> - O épico também passa para **Em Execução** se ainda não tiver começado (Aberto, Priorizado, Em Análise ou Aguardando Execução). Épicos em homologação ou em fases posteriores não mudam.
> - Se aparecer um apontamento novo no período depois da prévia, o envio é recusado. Nesse caso, gere a prévia de novo.

- **Comentários com IA (opcional).** Com `ANTHROPIC_API_KEY` no `.env`, aparece o botão **Gerar comentários com IA**.
  - Ele usa o Claude Opus 5.5, com uma chamada a cada 40 lançamentos.
  - Envia só o épico, a tarefa, a data e a duração de cada lançamento.
  - Cada geração custa centavos de dólar.
  - Sem a chave, a tela usa só as frases-modelo.
- **Frases-modelo.** Ficam em `src/support/models.js`, no campo `comments` de cada modelo.
- **Teste sem tocar no Jira.** Rode `node scripts/mock-support.js` e abra <http://localhost:3101/apontar.html>.

### Apontamentos automáticos

O bloco **Apontamentos automáticos**, em Apontar horas, grava um apontamento fixo todo dia útil sem você clicar. Serve, por exemplo, para a daily: `SIJUD-27633`, 09:00, 15m.

- **Regra.** Cada regra tem:
  - a tarefa (qualquer uma, exceto épico; o app confere no Jira ao salvar). Informe a **chave** (`SIJUD-27633`) ou o **texto exato do título**. No texto, `{MM/AAAA}` vira o mês de cada dia (`{MM}` e `{AAAA}` também valem). Com `Daily COSARQ - BI - {MM/AAAA}`, os dias de novembro vão para a tarefa "Daily COSARQ - BI - 11/2026", os de dezembro para a "…12/2026", e assim por diante. A tela sugere a troca quando o texto tem um mês fixo. Se a tarefa do mês ainda não existe, o dia fica como erro e é tentado de novo a cada 15 minutos. Se houver mais de uma tarefa com o mesmo título, nada é gravado;
  - o horário de início e a duração;
  - o comentário (padrão: "Participação na reunião diária.");
  - a data de início (padrão: hoje; pode ser passada ou futura);
  - a data de fim, opcional. Depois dela, a regra aparece como "encerrada" e não grava mais nada.

  As regras ficam em `agendamentos.json`, na raiz. Uma regra pode ser editada, pausada ou excluída. Excluir uma regra não apaga o que ela já gravou.
- **Quando grava.** O servidor confere as regras a cada minuto. Um dia é gravado assim que o horário da reunião termina.
  - Fins de semana, feriados nacionais e os dias de `feriados.json` são pulados.
  - Dias perdidos, com o app desligado, são gravados quando ele volta. Isso vale para até 31 dias para trás, e nunca antes da data de início (padrão: hoje; pode ser passada ou futura).
  - **Rodar agora** executa na hora o que estiver pendente.
- **Segurança.**
  - Cada dia de cada regra é tratado uma única vez. O resultado fica em `agendamentos-log.json` e aparece no Histórico.
  - Se já existe um apontamento seu na mesma tarefa e no mesmo horário, o dia é **pulado**.
  - Se o horário bate com outro apontamento seu, o app não grava e registra um **conflito**. Editar a regra faz os dias em conflito serem tentados de novo.
  - Erros do Jira, como falha de rede, são tentados de novo a cada 15 minutos.
  - O app grava sem notificar ninguém e não muda o status da tarefa.
- **Desligar.**
  - Marque **Pausar todas** na tela.
  - Para desligar o agendador inteiro, coloque `AUTO_WORKLOG=off` no `.env` e reinicie o app.
- **O app precisa estar rodando.** Para ele subir sozinho quando você entrar no Windows, crie uma tarefa no Agendador de Tarefas. Use o disparador "Ao fazer logon" e a ação `node src/index.js`, com "Iniciar em" apontando para a pasta do projeto.

## Estrutura

```
src/index.js          entrada (lê o .env, sobe o servidor em localhost)
src/server.js         rotas /api/config, /api/catalog, /api/call, /api/paginate
src/jiraClient.js     HTTP + Basic Auth + novas tentativas em 429
src/paginators.js     estratégias de paginação (offset, nextPageToken, worklog nextPage)
src/worklog/           apontamento: tempo e distribuição (time.js), frases (comments.js), IA (ai.js), serviço (service.js)
src/support/           tarefas de apoio: modelos (models.js), montagem do pedido (render.js), serviço (service.js)
src/catalog.js        endpoints pré-configurados + bloqueio de chamadas de escrita ou para outros hosts
src/shared/           achatamento JSON→tabelas, CSV e gerador de script Qlik (usados no navegador também)
public/               interface (index.html = API Tester, apoio.html = Tarefas de apoio, apontar.html = Apontar horas)
scripts/mock-support.js  Jira simulado para testar a tela de apoio
test/                 testes (node --test)
docs/superpowers/     spec e plano de implementação
```
