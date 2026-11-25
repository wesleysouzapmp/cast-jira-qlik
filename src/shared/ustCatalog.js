// Catálogo de UST: item do catálogo (CAT-nnn) + tamanho (P, M, G ou Hora) → valor em UST.
// Usado na importação da planilha (navegador), na validação do servidor e no cálculo do indicador.

export const SIZES = ['P', 'M', 'G', 'Hora'];
// 1000 linhas com textos de até 300 caracteres cabem no limite de 1 MB do corpo JSON.
export const MAX_ITEMS = 1000;
const MAX_TEXT = 300;
const CAT_RE = /\bCAT-(\d+)\b/i;

// Código do item do catálogo dentro de um texto ("CAT-105 - Realizar...") ou null.
export function catOf(text) {
  const m = CAT_RE.exec(String(text ?? ''));
  return m ? `CAT-${m[1]}` : null;
}

// Tamanho normalizado: P, M, G ou Hora; aceita "p", "G - Grande", "Médio", "Pequeno", "hora".
export function normSize(text) {
  const s = String(text ?? '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!s) return null;
  if (s.startsWith('hora')) return 'Hora';
  if (/^p(\b|equeno)/.test(s)) return 'P';
  if (/^m(\b|edio)/.test(s)) return 'M';
  if (/^g(\b|rande)/.test(s)) return 'G';
  return null;
}

// Número de célula: "0.5", "0,8", "1.234,5" (milhar com ponto), "1.2E+2" (notação exponencial do Excel).
const num = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  return s && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN;
};
const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Linhas da planilha (colunas: B = CAT, C = tarefa, D = tamanho, E = descrição, G = UST).
// Linha sem CAT herda o CAT de cima; linha sem tamanho/UST válidos (seções, títulos) é ignorada.
export function catalogFromRows(rows) {
  const items = [];
  const warnings = [];
  const seen = new Map();
  let cat = null;
  let task = '';
  for (const row of rows) {
    const c = catOf(row?.[1]);
    if (c) { cat = c; task = text(row?.[2]); }
    const size = normSize(row?.[3]);
    if (!cat || !size) continue;
    const key = `${cat} ${size}`;
    const ust = num(row?.[6]);
    if (!Number.isFinite(ust) || ust < 0) {
      if (text(row?.[6])) warnings.push(`${key}: UST ilegível ("${text(row?.[6])}"); linha ignorada.`);
      continue;
    }
    if (seen.has(key)) {
      const prev = seen.get(key);
      warnings.push(prev.ust === ust
        ? `${key} aparece mais de uma vez com a mesma UST; mantida uma linha.`
        : `${key} aparece mais de uma vez com UST diferentes (${prev.ust} e ${ust}); mantida a primeira.`);
      continue;
    }
    const item = { cat, size, ust, task, description: text(row?.[4]) };
    seen.set(key, item);
    items.push(item);
  }
  return { items, warnings };
}

// Validação do que chega do navegador. Lança RangeError com mensagem para o usuário.
export function validateItems(items) {
  if (!Array.isArray(items)) throw new RangeError('Envie a lista de itens do catálogo.');
  if (!items.length) throw new RangeError('O catálogo não pode ficar vazio.');
  if (items.length > MAX_ITEMS) throw new RangeError(`No máximo ${MAX_ITEMS} itens no catálogo.`);
  const seen = new Set();
  return items.map((i, n) => {
    const where = `Linha ${n + 1}`;
    const cat = typeof i?.cat === 'string' && /^CAT-\d+$/i.test(i.cat.trim()) ? i.cat.trim().toUpperCase() : null;
    if (!cat) throw new RangeError(`${where}: item do catálogo inválido (use CAT-123).`);
    const size = SIZES.includes(i.size) ? i.size : normSize(i.size);
    if (!size) throw new RangeError(`${where}: tamanho inválido (use P, M, G ou Hora).`);
    const ust = typeof i.ust === 'number' ? i.ust : num(i.ust);
    if (!Number.isFinite(ust) || ust < 0 || ust > 100000) throw new RangeError(`${where}: UST inválida.`);
    const task = text(i.task);
    const description = text(i.description);
    if (task.length > MAX_TEXT || description.length > MAX_TEXT) throw new RangeError(`${where}: texto longo demais (máximo ${MAX_TEXT} caracteres).`);
    const key = `${cat} ${size}`;
    if (seen.has(key)) throw new RangeError(`${where}: ${key} repetido.`);
    seen.add(key);
    return { cat, size, ust, task, description };
  });
}

// UST de um CAT + tamanho no catálogo, ou null.
export function ustOf(items, cat, size) {
  return items.find((i) => i.cat === cat && i.size === size)?.ust ?? null;
}
