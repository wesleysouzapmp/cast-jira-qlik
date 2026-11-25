// Leitor mínimo de .xlsx (só a primeira planilha, valores como texto), sem dependências.
// Roda no navegador e no Node (>= 22): usa DecompressionStream('deflate-raw') para o zip.
// Suporta textos compartilhados, texto embutido, números e booleanos; ignora estilos e fórmulas
// (usa o valor já calculado que o Excel grava na célula).

// Limites contra arquivos hostis ou fora do comum (o catálogo tem poucas centenas de linhas).
const MAX_ENTRY = 20 * 1024 * 1024; // bytes descompactados por parte do zip
const MAX_CELLS = 200_000;
const MAX_COL = 16383; // XFD
const MAX_ROW = 1048575; // linha 1.048.576

class XlsxError extends Error {}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// Índice do zip: nome → { method, size, offset } a partir do diretório central.
function zipIndex(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('Arquivo não é uma planilha .xlsx válida.');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new XlsxError('Planilha .xlsx corrompida.');
    const method = u16(b, p + 10);
    const size = u32(b, p + 20);
    const usize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    out.set(dec.decode(b.subarray(p + 46, p + 46 + nameLen)), { method, size, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(b, index, name) {
  const e = index.get(name);
  if (!e) return null;
  if (e.size > MAX_ENTRY || e.usize > MAX_ENTRY) throw new XlsxError('Planilha grande demais.');
  const h = e.offset;
  if (u32(b, h) !== 0x04034b50) throw new XlsxError('Planilha .xlsx corrompida.');
  const start = h + 30 + u16(b, h + 26) + u16(b, h + 28);
  if (start + e.size > b.length) throw new XlsxError('Planilha .xlsx corrompida.');
  const data = b.subarray(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new XlsxError('Compressão da planilha não suportada.');
  // O tamanho declarado no zip pode mentir: conta os bytes de verdade e para ao passar do limite.
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY) { await reader.cancel().catch(() => {}); throw new XlsxError('Planilha grande demais.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { all.set(c, p); p += c.length; }
  return new TextDecoder().decode(all);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g) => {
    if (g[0] !== '#') return ENTITIES[g.toLowerCase()] ?? m;
    const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// Texto de um <si> ou <is>: concatena todos os <t>, sem os textos fonéticos (<rPh>).
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += m[1] ?? '';
  return unescapeXml(s);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Primeira planilha do arquivo, pelo workbook.xml e seus relacionamentos.
async function firstSheetPath(b, index) {
  const wb = await readEntry(b, index, 'xl/workbook.xml');
  const rels = await readEntry(b, index, 'xl/_rels/workbook.xml.rels');
  const rid = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (/\bId="([^"]+)"/.exec(tag)?.[1] !== rid) continue;
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

// bytes (Uint8Array | ArrayBuffer) → linhas da primeira planilha: arrays de string|null
// (linha 1 = índice 0; colunas vazias antes de uma preenchida viram null; linhas vazias ficam
// como buracos do array, que um for...of entrega como undefined).
export async function readXlsxRows(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 22 || u32(b, 0) !== 0x04034b50) throw new XlsxError('Arquivo não é uma planilha .xlsx válida.');
  const index = zipIndex(b);
  const sheetXml = await readEntry(b, index, await firstSheetPath(b, index));
  if (!sheetXml) throw new XlsxError('Planilha .xlsx sem abas.');
  const sstXml = await readEntry(b, index, 'xl/sharedStrings.xml');
  const shared = sstXml ? [...sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textOf(m[1] ?? '')) : [];

  // Linhas esparsas: uma planilha formatada até a linha 1.048.576 não vira um milhão de arrays.
  const rows = [];
  let next = 0;
  let last = -1;
  let cells = 0;
  const limits = () => new XlsxError('Planilha fora dos limites do Excel (linha ou coluna).');
  for (const rm of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] ?? rm[3] ?? '';
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? next + 1) - 1;
    if (!Number.isInteger(r) || r < 0 || r > MAX_ROW) throw limits();
    next = r + 1;
    const row = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(ca)?.[1];
      const col = ref ? colIndex(ref) : row.length;
      if (col < 0 || col > MAX_COL) throw limits();
      if (++cells > MAX_CELLS) throw new XlsxError('Planilha grande demais.');
      const type = /\bt="([^"]+)"/.exec(ca)?.[1] ?? 'n';
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = null;
      if (type === 's') val = v === undefined ? null : shared[Number(v)] ?? null;
      else if (type === 'inlineStr') val = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (type === 'b') val = v === undefined ? null : v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = unescapeXml(v);
      while (row.length < col) row.push(null);
      row[col] = val === '' ? null : val;
    }
    if (!row.length) continue;
    rows[r] = row;
    last = Math.max(last, r);
  }
  rows.length = last + 1;
  return rows;
}
