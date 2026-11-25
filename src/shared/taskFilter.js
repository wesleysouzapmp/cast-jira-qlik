// Filtro da tela "Apontar horas": só tarefas de apoio Em Execução aparecem para apontar.
// Usado no navegador (/lib/taskFilter.js) e testado no Node.

export const IN_EXECUTION = 'Em Execução';

const norm = (s) => String(s ?? '').trim().toLowerCase();

// epics: [{ key, tasks: [{ key, status, ... }] }] → { epics (só com tarefas Em Execução), hidden }.
export function onlyInExecution(epics) {
  const hidden = [];
  const kept = [];
  for (const e of epics) {
    const tasks = e.tasks.filter((t) => {
      const ok = norm(t.status) === norm(IN_EXECUTION);
      if (!ok) hidden.push({ key: t.key, status: t.status, epicKey: e.key });
      return ok;
    });
    if (tasks.length) kept.push({ ...e, tasks });
  }
  return { epics: kept, hidden };
}
