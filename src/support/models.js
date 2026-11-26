// Configuração das "Tarefas de apoio" do QSENSE. As tarefas criadas vêm dos modelos mantidos no
// app (tabela support_templates; o "Padrão" repete os textos abaixo). MODELS continua valendo para
// reconhecer Análise/Implementação nas tarefas existentes e para as frases dos apontamentos.
// {EPICO} vira "<chave> - <resumo do épico>".
// comments: frases sorteadas para os apontamentos de horas ({EPICO} e {TAREFA} são substituídos).

export const QSENSE = {
  projectKey: 'QSENSE',
  issueTypeId: '10002', // Tarefa de apoio
  componentId: '10013', // Qlik Sense
  catalogFieldId: 'customfield_10104', // Item do Catálogo (aba Apontamento)
};

export const MODELS = [
  {
    id: 'analise',
    cat: 'CAT-105',
    prefix: 'Analise da demanda',
    summary: 'Analise da demanda {EPICO}',
    description: 'Analise da demanda {EPICO}. Levantamento das necessidades para execução.',
    comments: [
      'Levantamento de requisitos com o usuário-chave da demanda {EPICO}.',
      'Análise das fontes de dados envolvidas na demanda {EPICO}.',
      'Reunião de entendimento da necessidade da demanda {EPICO}.',
      'Mapeamento das regras de negócio da demanda {EPICO}.',
      'Diagnóstico da solução de BI atual para a demanda {EPICO}.',
      'Verificação dos QVDs e scripts de carga impactados pela demanda {EPICO}.',
      'Definição do escopo e dos indicadores da demanda {EPICO}.',
      'Registro das necessidades levantadas para a demanda {EPICO}.',
    ],
    catalog: {
      parentId: '11927',
      childId: '11930',
      label: 'Business Intelligence › CAT-105 - Realizar diagnóstico de incidente, problema, erro ou demanda na solução de BI',
    },
  },
  {
    id: 'implementacao',
    cat: 'CAT-166',
    prefix: 'Implementação da demanda',
    summary: 'Implementação da demanda {EPICO}',
    description: 'Desenvolvimento e Testes da Demanda {EPICO}. Criação de scripts Python, AQL e desenvolvimento de telas para atender a necessidade do usuário chave.',
    comments: [
      'Ajustes no script de carga do Qlik Sense para a demanda {EPICO}.',
      'Desenvolvimento de scripts Python para a demanda {EPICO}.',
      'Desenvolvimento de telas e objetos no Qlik Sense para a demanda {EPICO}.',
      'Criação e validação de expressões e medidas da demanda {EPICO}.',
      'Testes de carga e conferência dos dados da demanda {EPICO}.',
      'Correções após validação com o usuário-chave da demanda {EPICO}.',
      'Otimização do modelo de dados da demanda {EPICO}.',
      'Publicação e conferência do aplicativo da demanda {EPICO}.',
    ],
    catalog: {
      parentId: '11927',
      childId: '12117',
      label: 'Business Intelligence › CAT-166 - Manter script de carga do Qlik Sense',
    },
  },
];
