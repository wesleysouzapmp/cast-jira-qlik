// Achata registros JSON em tabelas, no estilo do Qlik REST Connector.
// Roda no Node e no navegador (sem imports).
//   - objetos aninhados  -> colunas "a.b.c"
//   - arrays de escalares -> texto unido por ";"
//   - arrays de objetos   -> tabela-filha "<tabela>.<caminho>" com __parent_id/__index
//   - documentos ADF (rich text do Jira v3) -> texto simples

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow']);

export function isAdf(v) {
  return v !== null && typeof v === 'object' && v.type === 'doc' && Array.isArray(v.content);
}

export function adfToText(node) {
  const parts = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    else if (n.type === 'hardBreak') parts.push('\n');
    else if (n.type === 'mention') parts.push(n.attrs?.text ?? '');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (BLOCK_TYPES.has(n.type)) parts.push('\n');
  })(node);
  return parts.join('').replace(/\n{2,}/g, '\n').trim();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function flatten(records, rootName = 'root') {
  const tables = { [rootName]: [] };

  function addRow(tableName, row) {
    (tables[tableName] ??= []).push(row);
  }

  // Preenche `row` com as colunas de `obj`; arrays de objetos viram tabelas-filhas.
  function fill(row, obj, prefix, tableName, rowId) {
    for (const [k, v] of Object.entries(obj)) {
      const col = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) row[col] = v ?? null;
      else if (isAdf(v)) row[col] = adfToText(v);
      else if (Array.isArray(v)) {
        if (v.some((x) => isPlainObject(x) && !isAdf(x))) {
          v.forEach((item, i) => emit(`${tableName}.${col}`, item, `${rowId}.${i}`, rowId, i));
        } else {
          row[col] = v.map((x) => (isAdf(x) ? adfToText(x) : typeof x === 'object' && x !== null ? JSON.stringify(x) : x)).join(';');
        }
      } else if (isPlainObject(v)) fill(row, v, col, tableName, rowId);
      else row[col] = v;
    }
  }

  function emit(tableName, item, id, parentId, index) {
    const row = { __id: id };
    if (parentId !== undefined) {
      row.__parent_id = parentId;
      row.__index = index;
    }
    if (isPlainObject(item)) fill(row, item, '', tableName, id);
    else row.value = item;
    addRow(tableName, row);
  }

  (records ?? []).forEach((rec, i) => emit(rootName, rec, String(i)));
  return tables;
}
