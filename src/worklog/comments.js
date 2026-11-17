// Frases-modelo dos apontamentos: sorteio sem repetição (Fisher–Yates), em ciclos.

function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Frases das tarefas avulsas (fora das tarefas de apoio). {ITEM} vira "<chave> - <resumo da tarefa>".
export const GENERIC_MODEL = {
  id: 'avulsa',
  label: 'Avulsa',
  comments: [
    'Atividades da tarefa {ITEM}.',
    'Análise e levantamento de informações para a tarefa {ITEM}.',
    'Execução das atividades previstas na tarefa {ITEM}.',
    'Reunião de alinhamento sobre a tarefa {ITEM}.',
    'Ajustes e correções referentes à tarefa {ITEM}.',
    'Testes e validação da tarefa {ITEM}.',
    'Atendimento e acompanhamento da tarefa {ITEM}.',
    'Documentação e registro das atividades da tarefa {ITEM}.',
  ],
};

export function pickComments(model, ctx, n, rng = Math.random) {
  const epic = `${ctx.epicKey} - ${String(ctx.epicSummary ?? '').trim()}`;
  const item = `${ctx.taskKey ?? ''} - ${String(ctx.taskSummary ?? '').trim()}`;
  const fill = (t) => t.replaceAll('{EPICO}', () => epic).replaceAll('{TAREFA}', () => ctx.taskKey ?? '').replaceAll('{ITEM}', () => item);
  const out = [];
  while (out.length < n) out.push(...shuffled(model.comments, rng).slice(0, n - out.length));
  return out.map(fill);
}
