// Funções puras que transformam um épico + tarefa do modelo no pedido de criação do Jira e
// reconhecem tarefas de apoio existentes.
import { QSENSE, MODELS } from './models.js';
import { catOf } from '../shared/ustCatalog.js';

const MAX_SUMMARY = 255;
const MAX_DESCRIPTION = 2000;
const ELLIPSIS = '…';

export function epicLabel(issue) {
  return `${issue.key} - ${String(issue.fields?.summary ?? '').trim()}`;
}

export function renderModel(model, issue) {
  const label = epicLabel(issue);
  // Substituição por função: um "$" no resumo do épico (ex.: R$) não vira padrão especial.
  const fill = (tpl, value) => tpl.replaceAll('{EPICO}', () => value);
  let description = fill(model.description, label);
  // {EPICO} pode passar do limite da descrição: corta em vez de recusar a criação.
  if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION - ELLIPSIS.length) + ELLIPSIS;
  let summary = fill(model.summary, label);
  if (summary.length > MAX_SUMMARY) {
    // Corta só o resumo do épico; o prefixo e a chave ficam inteiros.
    const fixed = model.summary.replaceAll('{EPICO}', '').length + issue.key.length + 3;
    const room = MAX_SUMMARY - fixed - ELLIPSIS.length;
    const epicSummary = String(issue.fields?.summary ?? '').trim();
    summary = fill(model.summary, `${issue.key} - ${epicSummary.slice(0, Math.max(room, 0))}${ELLIPSIS}`);
    // {EPICO} repetido (ou texto fixo longo): corte final para caber no limite do Jira.
    if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - ELLIPSIS.length) + ELLIPSIS;
  }
  return { summary, description };
}

export function toAdf(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

// task: { summary, description } (com {EPICO}); options: campos de opção já resolvidos no
// createmeta (Item do Catálogo e Tamanho), { fieldId: valor }.
// issue null = tarefa solta (sem épico): sem parent e textos usados como vieram (sem {EPICO}).
export function buildCreateBody(task, issue, accountId, options = {}) {
  const { summary, description } = issue ? renderModel(task, issue) : { summary: task.summary, description: task.description ?? '' };
  return {
    fields: {
      project: { key: QSENSE.projectKey },
      issuetype: { id: QSENSE.issueTypeId },
      ...(issue ? { parent: { key: issue.key } } : {}),
      summary,
      ...(description.trim() ? { description: toAdf(description) } : {}),
      components: [{ id: QSENSE.componentId }],
      assignee: { accountId },
      ...options,
    },
  };
}

function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function matchesModel(model, summary) {
  const s = normalize(summary);
  return s.length > 0 && s.startsWith(normalize(model.prefix));
}

// Modelo de uma tarefa existente no QSENSE: pelo Item do Catálogo (CAT-105/CAT-166);
// o começo do resumo é a alternativa para tarefas sem catálogo preenchido.
export function modelOfTask(task) {
  const childId = task.fields?.[QSENSE.catalogFieldId]?.child?.id;
  return MODELS.find((m) => childId && m.catalog.childId === String(childId))
    ?? MODELS.find((m) => matchesModel(m, task.fields?.summary))
    ?? null;
}

// Tarefa de apoio existente: { model, cat, catLabel } ou null. Vale o código CAT do Item do Catálogo;
// Análise/Implementação pelo id da opção do catálogo, senão pelo CAT (CAT-105/CAT-166) e, sem CAT
// preenchido, pelo começo do título (tarefas antigas). catLabel: texto da opção no Jira ("CAT-105 - Realizar diagnóstico…").
export function supportTaskInfo(task) {
  const child = task.fields?.[QSENSE.catalogFieldId]?.child;
  const text = String(child?.value ?? '');
  const byChild = child?.id ? MODELS.find((m) => m.catalog.childId === String(child.id)) : null;
  const cat = catOf(text) ?? byChild?.cat ?? null;
  const model = byChild ?? (cat ? MODELS.find((m) => m.cat === cat) ?? null : MODELS.find((m) => matchesModel(m, task.fields?.summary)) ?? null);
  const finalCat = cat ?? model?.cat ?? null;
  if (!finalCat) return null;
  const label = text || (model ? model.catalog.label.split(' › ').pop() : '');
  return { model: model?.id ?? null, cat: finalCat, catLabel: label };
}
