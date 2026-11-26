// Campos do Jira usados pelas tarefas de apoio e pelo indicador de UST: texto de campos de opção,
// o campo "Tamanho" (achado pelo nome) e a escolha da opção certa entre as que o Jira oferece
// (editmeta ao alterar uma tarefa, createmeta ao criar).
import { catOf, normSize } from '../shared/ustCatalog.js';

export const SIZE_FIELD_NAME = 'tamanho';
const norm = (s) => String(s ?? '').trim().toLowerCase();

// Texto de um campo de opção do Jira: opção ({ value }), cascata ({ value, child }), lista ou texto.
export function optionText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(optionText).filter(Boolean).join(', ');
  return v.child?.value ? `${v.value ?? ''} › ${v.child.value}` : String(v.value ?? v.name ?? '');
}

// Campo "Tamanho" numa lista de campos ({ id | fieldId, name, custom? }); prefere o personalizado.
export function sizeFieldIn(fields) {
  const matches = (fields ?? []).filter((f) => norm(f?.name) === SIZE_FIELD_NAME);
  const f = matches.find((x) => x.custom || String(x.id ?? x.fieldId ?? '').startsWith('customfield_')) ?? matches[0];
  return f ? { id: String(f.id ?? f.fieldId), name: f.name } : null;
}

// Opção do campo Tamanho: ignora desativadas; prefere o texto exato ("M"); senão aceita uma única
// opção que normalize para o tamanho ("M - Médio"). Mais de uma: ambíguo.
// where completa as mensagens ("desta tarefa", "na criação de tarefas de apoio").
export function pickOption(allowed, size, where = 'desta tarefa') {
  const active = (allowed ?? []).filter((o) => o?.disabled !== true);
  const label = (o) => String(o.value ?? o.name ?? '');
  const exact = active.filter((o) => norm(label(o)) === norm(size));
  if (exact.length === 1) return { opt: exact[0] };
  const close = exact.length ? exact : active.filter((o) => normSize(label(o)) === size);
  if (close.length === 1) return { opt: close[0] };
  if (!close.length) return { error: `O Jira não oferece o valor ${size} no campo Tamanho ${where}.` };
  return { error: `O campo Tamanho tem mais de uma opção para ${size} (${close.map(label).join(', ')}); ajuste no Jira.` };
}

// Opção do Item do Catálogo (cascata pai › filho) cujo filho tem o código CAT pedido; ignora desativadas.
export function pickCatOption(allowed, cat, where = 'desta tarefa') {
  const found = [];
  for (const parent of (allowed ?? []).filter((o) => o?.disabled !== true)) {
    for (const child of (parent.children ?? []).filter((c) => c?.disabled !== true)) {
      if (catOf(child.value ?? child.name) === cat) found.push({ parent, child });
    }
  }
  if (found.length === 1) return { value: { id: String(found[0].parent.id), child: { id: String(found[0].child.id) } } };
  if (!found.length) return { error: `O Jira não oferece o ${cat} no Item do Catálogo ${where}.` };
  return { error: `O Item do Catálogo tem mais de uma opção para ${cat} (${found.map((f) => `${f.parent.value} › ${f.child.value}`).join('; ')}); ajuste no Jira.` };
}
