# Criar tarefa e apontar pelo calendário (Parte 2)

Continua a Parte 1 (`2026-11-26-modelos-tarefas-apoio-design.md`). Decisões do usuário em 2026-11-26:
- Depois de criar a tarefa pelo calendário, **já aponta as horas naquele dia**.
- Sem épico: **avisar que vai ficar como tarefa solta** ou **dar a opção de criar um épico**.
- Ao criar épico: **escolher o espaço (projeto do Jira)**; o escolhido vira o **padrão** para as próximas vezes, podendo mudar.

## Objetivo

Hoje, em **Meus apontamentos**, o clique num dia abre o painel com as batidas, e o botão "Apontar neste dia" leva para **Apontar horas**, onde não fica claro onde preencher. O painel do dia passa a ter um bloco **Novo apontamento** para apontar ali mesmo, numa tarefa existente ou numa **tarefa nova** criada a partir de um item do catálogo de UST.

## Painel do dia: bloco "Novo apontamento"

Botão **+ Novo apontamento** no topo do painel abre o bloco (o botão "Apontar neste dia" continua, para lançar vários dias pela tela Apontar horas).

Campos:
1. **Tarefa**: `Tarefa existente` (seletor com as tarefas de apoio do usuário, as mesmas da lista de mover batida) ou `Nova tarefa`.
2. Só para **Nova tarefa**:
   - **Épico**: seletor com os épicos do usuário (abertos, como em Apontar horas), mais `Sem épico (tarefa solta)` e `Criar novo épico`.
   - `Criar novo épico`: **Espaço** (projetos do Jira onde o usuário pode criar épico; vem marcado o padrão salvo) e **Resumo do épico** (1 a 255 caracteres).
   - **CAT** (catálogo de UST) e **Tamanho** (só os do CAT; sem escolha automática), **Título** (sugestão: `<tarefa do CAT no catálogo> da demanda {EPICO}`; sem épico: só a tarefa do CAT) e **Descrição** opcional. Mesmos limites da Parte 1 (título 255, descrição 2000).
3. **Início** (padrão: fim da última batida do dia, ou 08:00 se não houver; múltiplo de 15 min), **Duração** (15 min a 8h, blocos de 15) e **Comentário** (até 1000; opcional).

Validação na tela, antes de enviar:
- Sobreposição com as batidas do dia = bloqueia, com a batida que conflita.
- Total do dia passando do limite diário (o mesmo de "Apontar horas", padrão 8h) = bloqueia, com quanto ainda cabe no dia.
- Nova tarefa sem épico: ao clicar em Continuar aparece o aviso **"Esta tarefa vai ficar solta, sem épico. Criar assim ou criar um épico?"** com os botões `Criar sem épico` e `Criar um épico` (este volta ao formulário com `Criar novo épico` marcado).

**Prévia** (nada é gravado antes de confirmar): lista o que será feito, em ordem — criar o épico `<resumo>` no espaço X; criar a tarefa `<título>` (CAT, tamanho, pai); apontar `<duração>` em `<data>` às `<início>`. Botão **Confirmar**.

**Resultado** por passo (criado / erro com a mensagem do Jira). Ordem e regras:
- Épico falhou: nada mais é feito.
- Tarefa falhou: o apontamento não é feito; se o épico foi criado, mostra a chave dele (para não criar de novo).
- Apontamento falhou: mostra a chave da tarefa criada e o erro; a pessoa pode apontar nela depois (já aparece na lista de tarefas existentes).
- Sucesso: o calendário e o painel do dia recarregam com a batida nova.

## Servidor

- `GET /api/support/spaces` → `{ spaces: [{ id, key, name }], defaultId }`: projetos com `GET /rest/api/3/project/search?action=create&expand=issueTypes` (paginado), só os que têm tipo de item com `hierarchyLevel` 1 (épico); `defaultId` é o salvo do usuário, se ainda estiver na lista.
- `POST /api/support/quick` (fila única por usuário, como as outras gravações):
  ```
  { epic: { key } | { new: { projectId, summary } } | null,
    task: { key } | { cat, size, summary, description },
    worklog: { date, start, minutes, comment } }
  ```
  - Revalida tudo no servidor: CAT e tamanho no catálogo, limites de texto, regras do apontamento (as de `/api/worklog/submit`), épico existente = um dos épicos do usuário (`hierarchyLevel` 1), espaço = um dos de `/spaces`. `task.key` com `epic` diferente de `null` é erro (tarefa existente já tem pai).
  - Novo épico: cria com projeto, tipo épico daquele projeto, resumo e responsável = o usuário. Se o Jira exigir outros campos, devolve a mensagem dele. Guarda o projeto como padrão do usuário (só quando o épico for criado).
  - Nova tarefa: mesma criação da Parte 1 (createmeta, Item do Catálogo, Tamanho com o plano B de editar depois), com `parent` = épico ou sem `parent` quando solta.
  - Apontamento: mesmo caminho de `submit` (checa sobreposição com o Jira antes de gravar).
  - Resposta: `{ epic?: { key, url, status, error? }, task: { key?, url?, status, error?, warning? }, worklog: { status, error? } }`.
  - Auditoria `support.quick` com chaves, CAT/tamanho, data e minutos (sem textos).
- Migração 6: `user_settings.epic_project_id` (texto, nulo).

## Fora de escopo
- Ferramentas MCP para este fluxo.
- Mudança na tela Apontar horas.
- Campos extras obrigatórios na criação de épico em algum espaço (o erro do Jira aparece e a pessoa escolhe outro espaço ou cria o épico no Jira).
