// Ações das atividades da tarefa agrupadora (Parte 3), cada uma ligada a uma fase. Lista fixa,
// mantida aqui (não no banco); a tela recebe por GET /api/support/actions.
import { PHASES } from '../shared/groupPlan.js';

export const ACTIONS = [
  { action: 'Analisar', phase: 'analise' },
  { action: 'Identificar', phase: 'analise' },
  { action: 'Levantar', phase: 'analise' },
  { action: 'Mapear', phase: 'analise' },
  { action: 'Desenvolver', phase: 'execucao' },
  { action: 'Reescrever', phase: 'execucao' },
  { action: 'Ajustar', phase: 'execucao' },
  { action: 'Criar', phase: 'execucao' },
  { action: 'Fazer engenharia reversa', phase: 'execucao' },
  { action: 'Testar', phase: 'testes' },
  { action: 'Validar', phase: 'testes' },
  { action: 'Disponibilizar para validação', phase: 'testes' },
  { action: 'Publicar', phase: 'producao' },
  { action: 'Implantar', phase: 'producao' },
  { action: 'Documentar', phase: 'producao' },
];

const BY_NAME = new Map(ACTIONS.map((a) => [a.action, a.phase]));

// Fase de uma ação da lista, ou null se a ação não existe.
export const phaseOfAction = (action) => BY_NAME.get(action) ?? null;

export { PHASES };
