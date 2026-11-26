// Validação dos modelos de tarefas de apoio e das tarefas enviadas na prévia/criação.
// CAT e tamanho precisam existir no catálogo de UST do app. Lança RangeError com mensagem para o usuário.
import { SIZES, normSize } from '../shared/ustCatalog.js';

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

// Corpo de criação/edição de um modelo: { name, public, items }.
export function validateTemplate(body, catalog) {
  if (!body || typeof body !== 'object') throw new RangeError('Envie o modelo.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new RangeError('Informe o nome do modelo.');
  if (name.length > LIMITS.name) throw new RangeError(`Nome do modelo com até ${LIMITS.name} caracteres.`);
  if (typeof body.public !== 'boolean') throw new RangeError('Informe se o modelo é público (true ou false).');
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > LIMITS.items) throw new RangeError(`O modelo precisa ter de 1 a ${LIMITS.items} tarefas.`);
  return { name, public: body.public, items: items.map((t, n) => validateTask(t, catalog, `Tarefa ${n + 1}`)) };
}
