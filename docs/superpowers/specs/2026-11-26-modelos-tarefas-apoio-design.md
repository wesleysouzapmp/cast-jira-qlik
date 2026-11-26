# Modelos de tarefas de apoio (Parte 1)

Aprovado pelo usuário em 2026-11-26. Parte 2 (criar tarefa e apontar pelo calendário) vem depois, em outra spec.

## Objetivo

Hoje "Tarefas de apoio" cria sempre duas tarefas fixas por épico (Análise CAT-105 e Implementação CAT-166, em `src/support/models.js`). Passa a criar a partir de **modelos** mantidos no app: cada modelo é uma lista de tarefas com **CAT + tamanho + título + descrição**. Na prévia a pessoa escolhe o modelo, ajusta cada tarefa e pode **adicionar tarefas avulsas** (CAT, tamanho, título).

## Regras

### Modelos
- Modelo: `nome`, `público` (sim/não), dono, lista ordenada de itens `{ cat, size, summary, description }`.
  - `cat`: `CAT-nnn` presente no catálogo de UST (`ust_catalog`); `size`: P, M, G ou Hora, existente no catálogo para esse CAT.
  - `summary` e `description`: texto com o marcador `{EPICO}` (vira `<chave> - <resumo do épico>`, com o mesmo corte de 255 caracteres de `renderModel`). Padrão sugerido na tela: `<tarefa do CAT no catálogo> da demanda {EPICO}`.
- Quem cria e edita: o **admin** sempre; um **usuário comum só se o admin o habilitar** (nova chave por usuário "pode criar modelos", na tela Usuários). Editar/excluir: o dono ou o admin.
- Visibilidade: **público** = todos os usuários veem e usam; **privado** = só o dono (e o admin, para administrar).
- Modelo inicial (migração): público, dono nulo (do sistema, editável pelo admin), nome "Padrão", itens: Análise CAT-105 tamanho M (`Analise da demanda {EPICO}` / descrição atual do modelo `analise`) e Implementação CAT-166 tamanho P (`Implementação da demanda {EPICO}` / descrição atual do modelo `implementacao`). Textos iguais aos de `src/support/models.js`.
- Limites: nome até 80 caracteres; até 20 itens por modelo; título e descrição até 255 e 2000 caracteres.

### Criação de tarefas (tela Tarefas de apoio)
- Seleção de épicos continua como hoje. **Criar tarefas de apoio** abre a prévia:
  - Seletor de **modelo** (os visíveis para a pessoa; padrão = o último usado por ela, senão "Padrão").
  - Para cada épico: as tarefas do modelo, cada uma com caixa de marcação, **CAT** (seletor com os CATs do catálogo de UST), **tamanho** (só os do CAT escolhido), título (já com o épico) e descrição. A tarefa cujo **CAT já existe** naquele épico vem **desmarcada** com o aviso "já existe: QSENSE-…" (pode marcar para criar mais uma).
  - Botão **Adicionar tarefa avulsa** por épico: nova linha com CAT, tamanho e título (padrão como acima), marcada.
  - Total de tarefas a criar e botão Confirmar; nada é gravado antes de confirmar.
- Gravação no Jira (uma tarefa por vez, fila única por usuário, como hoje): projeto QSENSE, tipo `QSENSE.issueTypeId`, componente, pai = épico, responsável = o usuário, resumo/descrição renderizados, **Item do Catálogo** = opção em cascata cujo filho tem o código CAT, **Tamanho** = opção do campo "Tamanho" (achado pelo nome, como em `src/worklog/ust.js`).
  - Os IDs das opções vêm do **createmeta** do Jira: `GET /rest/api/3/issue/createmeta/QSENSE/issuetypes/<issueTypeId>` (resposta paginada; a lista de campos pode vir em `fields` ou `values`, cada um com `fieldId` e `allowedValues`). Opção de CAT: filho ativo (não `disabled`) cujo texto contém o código CAT; exatamente um, senão erro claro. Opção de tamanho: mesma regra de `pickOption` em `src/worklog/ust.js` (exato; senão uma única normalizada; ambíguo = erro).
  - Resultado por tarefa (criada / erro com a mensagem do Jira). Erro de uma não impede as outras. Auditoria `support.create` com épicos, CAT/tamanho de cada tarefa e o modelo usado (sem textos longos).
- **Reconhecer tarefas existentes pelo CAT**: uma tarefa do QSENSE com pai = épico é uma tarefa de apoio se o Item do Catálogo tiver um código CAT. `listItems` passa a devolver em `existing` todas elas com `{ key, cat, size?, status, summary, url }`; a árvore da tela mostra o rótulo do CAT (tarefa do catálogo, ex.: "Realizar diagnóstico…") em vez de só Análise/Implementação. Tarefas antigas sem CAT continuam reconhecidas pelo começo do título (Análise/Implementação), como hoje.

### Apontar horas e demais telas
- `loadScope` em `src/worklog/service.js` hoje ignora tarefas cujo `modelOfTask` é nulo: passa a **incluir qualquer tarefa de apoio com CAT** sob os épicos do usuário. Para as que não são Análise/Implementação, o "modelo" é genérico (comentários de `GENERIC_MODEL`) e o rótulo exibido é o código CAT + tarefa do catálogo. A ordenação mantém Análise, Implementação e depois as demais por chave.
- "Dividir total" (Análise/Implementação por percentual) continua só para épicos com essas duas tarefas; épicos com outras tarefas apontam por tarefa.

### Telas
- **Tarefas de apoio**: além da lista atual, uma seção **Modelos** (lista dos modelos visíveis: nome, público/privado, dono, itens resumidos; botões Novo, Editar, Excluir conforme permissão) com editor (nome, público, itens com CAT, tamanho, título, descrição, adicionar/remover/reordenar). Quem não pode criar vê só a lista e o aviso "peça ao administrador para habilitar".
- **Usuários (admin)**: coluna/alternância "Pode criar modelos" por usuário.

## API
- `GET /api/support/templates` → modelos visíveis + `canEdit` (pode criar) + id do último usado.
- `POST /api/support/templates`, `PUT /api/support/templates/:id`, `DELETE /api/support/templates/:id` (dono ou admin; validação no servidor).
- `PUT /api/admin/usuarios/:id/modelos` `{ pode: boolean }`.
- `POST /api/support/preview` e `/api/support/create` passam a receber, por épico, a lista de tarefas a criar `{ cat, size, summary, description }` (o servidor revalida CAT/tamanho no catálogo, o épico e os limites; `templateId` opcional para guardar o último usado e auditar). O formato antigo (`models: { epico: ['analise', ...] }`) pode ser removido junto com a tela antiga, desde que nada mais o use (o MCP não usa).

## Fora de escopo
- Criar tarefa pelo calendário, tarefa solta e criação de épico (Parte 2).
- Ferramentas MCP para modelos.
