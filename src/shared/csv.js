// CSV para Excel pt-BR: separador ";", UTF-8 com BOM, linhas "\r\n".

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  if (!rows || rows.length === 0) return '﻿';
  const columns = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  const lines = [columns.map(cell).join(';'), ...rows.map((r) => columns.map((c) => cell(r[c])).join(';'))];
  return '﻿' + lines.join('\r\n');
}
