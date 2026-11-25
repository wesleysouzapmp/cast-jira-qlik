// Filtro da tela "Apontar horas": só tarefas de apoio Em Execução ou Aberto aparecem para apontar
// (as em Aberto passam para Em Execução ao gravar). Usado no navegador (/lib/taskFilter.js) e testado no Node.

export const WORKABLE = ['Em Execução', 'Aberto'];

const norm = (s) => String(s ?? '').trim().toLowerCase();
const allowed = new Set(WORKABLE.map(norm));

// epics: [{ key, tasks: [{ key, status, ... }] }] → { epics (só com tarefas permitidas), hidden }.
export function onlyWorkable(epics) {
  const hidden = [];
  const kept = [];
  for (const e of epics) {
    const tasks = e.tasks.filter((t) => {
      const ok = allowed.has(norm(t.status));
      if (!ok) hidden.push({ key: t.key, status: t.status, epicKey: e.key });
      return ok;
    });
    if (tasks.length) kept.push({ ...e, tasks });
  }
  return { epics: kept, hidden };
}
