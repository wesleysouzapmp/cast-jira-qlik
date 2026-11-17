// Funções puras que transformam um épico + modelo no pedido de criação do Jira.
import { QSENSE, MODELS } from './models.js';

const MAX_SUMMARY = 255;
const ELLIPSIS = '…';

export function epicLabel(issue) {
  return `${issue.key} - ${String(issue.fields?.summary ?? '').trim()}`;
}

export function renderModel(model, issue) {
  const label = epicLabel(issue);
  // Substituição por função: um "$" no resumo do épico (ex.: R$) não vira padrão especial.
  const fill = (tpl, value) => tpl.replaceAll('{EPICO}', () => value);
  const description = fill(model.description, label);
  let summary = fill(model.summary, label);
  if (summary.length > MAX_SUMMARY) {
    // Corta só o resumo do épico; o prefixo e a chave ficam inteiros.
    const fixed = model.summary.replaceAll('{EPICO}', '').length + issue.key.length + 3;
    const room = MAX_SUMMARY - fixed - ELLIPSIS.length;
    const epicSummary = String(issue.fields?.summary ?? '').trim();
    summary = fill(model.summary, `${issue.key} - ${epicSummary.slice(0, Math.max(room, 0))}${ELLIPSIS}`);
  }
  return { summary, description };
}

export function toAdf(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export function buildCreateBody(model, issue, accountId) {
  const { summary, description } = renderModel(model, issue);
  return {
    fields: {
      project: { key: QSENSE.projectKey },
      issuetype: { id: QSENSE.issueTypeId },
      parent: { key: issue.key },
      summary,
      description: toAdf(description),
      components: [{ id: QSENSE.componentId }],
      assignee: { accountId },
      [QSENSE.catalogFieldId]: { id: model.catalog.parentId, child: { id: model.catalog.childId } },
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
