# Tarefa agrupadora com subtarefas (Parte 3)

Substitui a criação de "várias tarefas de apoio por épico" (Parte 1) e muda o fluxo do calendário (Parte 2). Decisões do usuário em 2026-11-27:
- Por épico existe **uma única tarefa agrupadora**. Ela é do tipo Tarefa, com Item do Catálogo **Apoio › CAT-87 - Item agrupador (Não será contabilizado)**. O trabalho fica em **N subtarefas** dentro dela; o restante (projeto, componente, responsável, pai = épico) é como hoje.
- **Uma subtarefa a cada 7h30** de horas informadas.
- Cada subtarefa tem **CAT e tamanho próprios**, escolhidos pelo usuário.
- A descrição é feita de linhas **Ação + Atividade executada**, por exemplo "Analisar" e "analisar o script SQL e o documento de negócio".
- As horas **já são apontadas** ao confirmar: uma a uma, ou com **Dividir por percentual** (padrão 10% Análise, 50% Execução, 30% Testes, 10% Produção), com base nas ações.
- **Modelos viram rascunhos** reaproveitáveis.

Exemplo real: na QSENSE-4057, a descrição "As atividades realizadas foram: 1. … 6. …" gerou 3 subtarefas, e as horas foram divididas entre elas.

## Wizard "Tarefas de apoio" (substitui a prévia da Parte 1)

Fica na tela Tarefas de apoio. Começa ao selecionar **um** épico e clicar em **Criar tarefa de apoio**.

1. **Agrupadora**
   - Se o épico ainda não tem agrupadora, aparece "Será criada: `Apoio da demanda {EPICO}`" (título editável, até 255 caracteres).
   - Se já tem (subtarefa ou tarefa do QSENSE sob o épico com CAT-87), aparece "Usará QSENSE-…". As novas subtarefas entram nela.
   - Se houver mais de uma agrupadora sob o épico, o wizard bloqueia com a lista das chaves (é um erro de cadastro, resolvido no Jira).
2. **Atividades**
   - Lista de linhas com **Ação** e **Atividade executada**.
   - **Ação**: seletor com a lista fixa abaixo, cada ação ligada a uma fase.
   - **Atividade executada**: texto livre de 10 a 300 caracteres.
   - Pode adicionar, remover e reordenar linhas, e carregar um **rascunho** (ver Rascunhos).

   | Fase | Ações |
   |---|---|
   | Análise | Analisar, Identificar, Levantar, Mapear |
   | Execução | Desenvolver, Reescrever, Ajustar, Criar, Fazer engenharia reversa |
   | Testes | Testar, Validar, Disponibilizar para validação |
   | Produção | Publicar, Implantar, Documentar |

   Cada linha do texto gerado é a ação com a atividade, por exemplo "Analisar o script SQL e o documento de negócio". A lista fica num arquivo de configuração (`src/support/actions.js`), não no banco.
3. **Horas**
   - Total de horas, de 0h15 a 200h, em blocos de 15 min.
   - Quantidade de subtarefas = **⌈total ÷ 7h30⌉**. Exemplos: 7h30 dá 1; 8h dá 2; 40h dá 6.
4. **Subtarefas** (o wizard monta a proposta e você ajusta)
   - **Distribuição das atividades:** em ordem, em blocos seguidos, entre as N subtarefas. Cada subtarefa recebe pelo menos 1 atividade e fica com a fase da maioria das suas ações; em empate, vale a primeira.
   - **Falta de insumo:** se houver menos atividades que subtarefas, aparece "40h exigem 6 subtarefas; você descreveu 4 atividades. Detalhe mais 2 atividades." e o Continuar fica bloqueado.
   - **Campos de cada subtarefa:**
     - **Título**: padrão `<Ação da 1ª atividade> - <atividade>`, até 255 caracteres.
     - **CAT e Tamanho**: obrigatórios, sem escolha automática. Só aparecem os CATs do catálogo de UST e só os tamanhos daquele CAT.
     - **Descrição**: as atividades dela, numeradas. Editável, até 2000 caracteres.
     - Ainda dá para mover uma atividade de uma subtarefa para a vizinha.
5. **Apontamento**
   - **Modo de divisão:**
     - **Uma a uma**: as horas de cada subtarefa são digitadas.
     - **Dividir por percentual**: os percentuais por fase vêm com o padrão 10/50/30/10, são editáveis e precisam somar 100%. As horas de cada fase são divididas igualmente entre as subtarefas daquela fase, em blocos de 15 min, e a sobra vai para a primeira. Uma fase sem subtarefa não entra; o percentual dela é redistribuído proporcionalmente.
   - **Regra das horas:** em qualquer modo, a soma das subtarefas tem que fechar o total, e cada subtarefa tem no máximo 7h30.
   - **Datas:**
     - Cada subtarefa vira um ou mais apontamentos, com **data inicial** (padrão hoje) e **hora de início** (padrão 08:00).
     - Os dias seguem úteis em sequência, pulando fins de semana e feriados (os mesmos de Apontar horas), sem passar do limite diário. Uma subtarefa que não cabe no dia continua no próximo dia útil.
     - A grade de datas é editável: data, início e duração.
     - Os apontamentos seguem as regras de sempre: início múltiplo de 15, 15 a 480 min, sem cruzar a meia-noite, sem sobreposição com o que já existe no Jira (checado no servidor) e comentário de até 1000 caracteres (padrão: título da subtarefa).
6. **Prévia e Confirmar**
   - Lista a agrupadora (criar ou usar), as subtarefas (título, CAT, tamanho, horas) e os apontamentos por dia.
   - Nada é gravado antes de confirmar.
   - Ordem de gravação: agrupadora → subtarefas, uma por vez → apontamentos.
   - **Se algo falhar:**
     - Falha na agrupadora: nada mais é feito.
     - Falha numa subtarefa: as outras continuam, e os apontamentos dela não são feitos.
     - Falha num apontamento: os outros continuam.
   - O resultado mostra cada passo com a chave ou o erro do Jira.

## Criação no Jira

- **Agrupadora:** projeto QSENSE, tipo `QSENSE.issueTypeId` (Tarefa, 10002), componente, pai = épico, responsável = o usuário, Item do Catálogo = a opção cujo filho contém **CAT-87** (achada pelo createmeta, como hoje). Sem Tamanho. A descrição tem "As atividades realizadas foram:" e todas as atividades numeradas.
- **Subtarefa:**
  - Projeto QSENSE e tipo **subtarefa** do projeto. O tipo é descoberto pelo `subtask: true` em `GET /rest/api/3/issue/createmeta/QSENSE/issuetypes`, sem id fixo; se houver mais de um, vale o de nome "Subtarefa"/"Sub-task", e se não der para decidir, aparece um erro claro.
  - Pai = a agrupadora, componente e responsável = o usuário.
  - Item do Catálogo (CAT) e Tamanho são escolhidos no createmeta **do tipo subtarefa**. Se Tamanho não estiver lá, vale o mesmo plano B de hoje: editar depois de criar.
- **Validação no servidor:** revalida tudo (épico do usuário, CATs e tamanhos no catálogo, limites, contagem ⌈total ÷ 7h30⌉, atividades ≥ subtarefas, soma das horas, regras dos apontamentos). Toda gravação passa pela fila única do usuário.
- **Auditoria `support.group`:** épico, agrupadora, subtarefas com CAT e tamanho, total de minutos e número de apontamentos (sem textos).

## Rascunhos (substituem os modelos)

- **Conteúdo:** nome mais a lista de atividades (Ação + Atividade). Não têm CAT, horas nem datas.
- **Permissões e visibilidade:** as mesmas de hoje. O admin cria sempre; o usuário comum só se o admin habilitar. Um rascunho público é visto por todos; um privado, só pelo dono e pelo admin.
- **Migração 7:**
  - Os modelos existentes viram rascunhos: cada item vira uma atividade, com ação "Analisar" para CAT-105 e "Desenvolver" para os demais, e atividade = título sem `{EPICO}`.
  - As colunas CAT e tamanho dos itens deixam de ser usadas, mas não são apagadas.
- **No wizard:** carregar um rascunho preenche o passo 2 (substitui as linhas, com confirmação se já houver texto). O botão "Salvar como rascunho" grava as linhas atuais.

## Apontar horas, painel do dia e MCP

- **Destinos de horas:** as **subtarefas** das agrupadoras sob os épicos do usuário, com rótulo `CAT - tarefa do catálogo` e o título. A agrupadora em si **não** recebe horas: ela some da lista e o servidor recusa apontamento nela.
- **Tarefas antigas:** as tarefas com CAT direto sob o épico (Parte 1) e as tarefas soltas continuam aceitando horas.
- **"Dividir total" de Apontar horas:**
  - Passa a dividir pelo mesmo percentual por fase quando o épico tem agrupadora.
  - Épicos antigos mantêm a divisão Análise/Implementação.
  - A fase de cada subtarefa é guardada no app, numa tabela `support_subtasks(key, phase, epic_key)` gravada na criação. Subtarefas criadas fora do app ficam com a fase "Execução".
- **Painel do dia (Parte 2):**
  - "Nova tarefa" passa a criar **uma subtarefa** na agrupadora do épico, criando a agrupadora se faltar.
  - "Sem épico" continua criando tarefa solta, sem agrupadora.
  - "Criar novo épico" continua igual e cria também a agrupadora.

## Fora de escopo

- Editar ou excluir subtarefas já criadas, e mover horas entre elas (isso continua no Jira e na edição de batidas).
- Ferramentas MCP para criar agrupadora e subtarefas.
- Mudar a lista de ações pela tela.

## A confirmar no Jira real antes de implementar (leitura)

- O tipo subtarefa do QSENSE e os campos obrigatórios dele, e se Item do Catálogo e Tamanho estão na tela de criação.
- A opção **Apoio › CAT-87** no Item do Catálogo e se ela está ativa.
- Como as subtarefas da QSENSE-4057 estão preenchidas, como referência.
