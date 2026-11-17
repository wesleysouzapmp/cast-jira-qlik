// Comentários de apontamento gerados pelo Claude (opcional: só com ANTHROPIC_API_KEY no .env).
// Uma chamada a cada 40 lançamentos; envia apenas épico, tarefa, data e duração de cada lançamento.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const MAX_LEN = 160;
const BATCH = 40; // lançamentos por chamada: mantém a resposta bem abaixo de max_tokens

const SYSTEM = 'Você escreve comentários curtos de apontamento de horas (worklog) para uma equipe de BI/Qlik Sense de um tribunal. '
  + 'Uma frase em português do Brasil por lançamento, até 160 caracteres, sem inventar fatos além do contexto, '
  + 'coerente com o tipo da tarefa (análise = levantamento/diagnóstico; implementação = scripts, telas, testes). '
  + 'Varie as frases entre lançamentos.';

const SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, text: { type: 'string' } },
        required: ['index', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['comments'],
  additionalProperties: false,
};

const KIND = { analise: 'análise', implementacao: 'implementação', avulsa: 'tarefa avulsa' };

export class AiError extends Error {}

export function createAiCommenter({ apiKey, client } = {}) {
  const enabled = Boolean(apiKey || client);
  const api = client ?? (apiKey ? new Anthropic({ apiKey }) : null);

  async function generate(entries, ctxByTask) {
    if (!api) throw new AiError('IA não configurada (ANTHROPIC_API_KEY ausente).');
    const out = [];
    for (let i = 0; i < entries.length; i += BATCH) out.push(...await generateBatch(entries.slice(i, i + BATCH), ctxByTask));
    return out;
  }

  async function generateBatch(entries, ctxByTask) {
    const items = entries.map((e, index) => {
      const c = ctxByTask[e.taskKey] ?? {};
      return { index, tipo: KIND[e.model] ?? e.model, tarefa: `${e.taskKey} - ${c.taskSummary ?? ''}`, epico: c.epicKey ? `${c.epicKey} - ${c.epicSummary ?? ''}` : '', data: e.date, duracao_min: e.minutes };
    });
    let res;
    try {
      res = await api.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Escreva um comentário para cada lançamento abaixo (use o mesmo index):\n${JSON.stringify(items, null, 1)}` }],
      });
    } catch (err) {
      throw new AiError(`Falha ao chamar a IA: ${err?.message ?? err}`);
    }
    if (res.stop_reason === 'refusal') throw new AiError('A IA recusou gerar os comentários.');
    if (res.stop_reason === 'max_tokens') throw new AiError('A resposta da IA ficou longa demais (limite de tokens). Tente com menos lançamentos.');
    const text = res.content?.find((b) => b.type === 'text')?.text;
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new AiError('A IA devolveu uma resposta inválida.'); }
    const byIndex = new Map((parsed?.comments ?? []).map((c) => [c.index, String(c.text ?? '').trim()]));
    const out = entries.map((_, i) => byIndex.get(i));
    if (out.some((c) => !c)) throw new AiError('A IA não devolveu um comentário para cada lançamento.');
    return out.map((c) => c.slice(0, MAX_LEN));
  }

  return { enabled, generate };
}
