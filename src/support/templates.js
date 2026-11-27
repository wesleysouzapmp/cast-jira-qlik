// Validação dos rascunhos (antigos modelos), das atividades e das tarefas/subtarefas criadas.
// CAT e tamanho precisam existir no catálogo de UST do app. Lança RangeError com mensagem para o usuário.
import { SIZES, normSize } from '../shared/ustCatalog.js';
import { GROUP_LIMITS } from '../shared/groupPlan.js';
import { phaseOfAction } from './actions.js';

export const LIMITS = { name: 80, items: 20, summary: 255, description: 2000 };
const CAT_RE = /^CAT-\d{1,6}$/i;

// Uma tarefa { cat, size, summary, description }; where identifica o item nas mensagens.
// truncate: corta a descrição no limite (tarefas já renderizadas da prévia) em vez de recusar.
export function validateTask(t, catalog, where, { truncate = false } = {}) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new RangeError(`${where}: tarefa inválida.`);
  if (!catalog.length) throw new RangeError('O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.');
  const cat = typeof t.cat === 'string' && CAT_RE.test(t.cat.trim()) ? t.cat.trim().toUpperCase() : null;
  if (!cat) throw new RangeError(`${where}: item do catálogo inválido (use CAT-123).`);
  const size = SIZES.includes(t.size) ? t.size : normSize(t.size);
  if (!size) throw new RangeError(`${where}: tamanho inválido (use P, M, G ou Hora).`);
  const sizes = catalog.filter((i) => i.cat === cat).map((i) => i.size);
  if (!sizes.length) throw new RangeError(`${where}: ${cat} não está no catálogo de UST.`);
  if (!sizes.includes(size)) throw new RangeError(`${where}: ${cat} não tem tamanho ${size} no catálogo de UST (há ${sizes.join(', ')}).`);
  if (typeof t.summary !== 'string' || !t.summary.trim()) throw new RangeError(`${where}: informe o título.`);
  const summary = t.summary.trim();
  if (summary.length > LIMITS.summary) throw new RangeError(`${where}: título com até ${LIMITS.summary} caracteres.`);
  const description = t.description ?? '';
  if (typeof description !== 'string') throw new RangeError(`${where}: descrição inválida.`);
  let desc = description.trim();
  if (desc.length > LIMITS.description) {
    if (!truncate) throw new RangeError(`${where}: descrição com até ${LIMITS.description} caracteres.`);
    desc = `${desc.slice(0, LIMITS.description - 1)}…`;
  }
  return { cat, size, summary, description: desc };
}

// Corpo de criação/edição de um rascunho (antigo modelo): { name, public, activities: [{ action, text }] }.
// Sem CAT, horas nem datas.
export function validateDraft(body) {
  if (!body || typeof body !== 'object') throw new RangeError('Envie o rascunho.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new RangeError('Informe o nome do rascunho.');
  if (name.length > LIMITS.name) throw new RangeError(`Nome do rascunho com até ${LIMITS.name} caracteres.`);
  if (typeof body.public !== 'boolean') throw new RangeError('Informe se o rascunho é público (true ou false).');
  const list = body.activities;
  if (!Array.isArray(list) || !list.length || list.length > GROUP_LIMITS.activities) throw new RangeError(`O rascunho precisa ter de 1 a ${GROUP_LIMITS.activities} atividades.`);
  return { name, public: body.public, activities: list.map((a, n) => validateActivity(a, `Atividade ${n + 1}`)).map(({ action, text }) => ({ action, text })) };
}

// Uma linha { action, text } do passo Atividades (rascunho ou wizard): ação da lista fixa
// (src/support/actions.js) e atividade de 10 a 300 caracteres. Devolve também a fase da ação.
export function validateActivity(a, where) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new RangeError(`${where}: atividade inválida.`);
  const phase = typeof a.action === 'string' ? phaseOfAction(a.action) : null;
  if (!phase) throw new RangeError(`${where}: escolha a ação na lista.`);
  const text = typeof a.text === 'string' ? a.text.trim().replace(/\s+/g, ' ') : '';
  if (text.length < GROUP_LIMITS.activityMin || text.length > GROUP_LIMITS.activityMax) {
    throw new RangeError(`${where}: descreva a atividade executada com ${GROUP_LIMITS.activityMin} a ${GROUP_LIMITS.activityMax} caracteres.`);
  }
  return { action: a.action, text, phase };
}
