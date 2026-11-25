// Ferramentas do conector MCP (leitura). Registradas por requisição em createMcpServer.
//
// registerTools(server, { user, ctx, holidays, autoRunner, publicUrl, now })
//  - user: { id, name, email, role } de quem chama (do Bearer).
//  - ctx: contexts.forUser(user) — { worklogService, favorites, secrets, ... } ou { missing: true }.
//  - holidays: provedor com between(from, to) → Map (opcional; sem ele, nenhum feriado).
//  - autoRunner: schedulerFor(userId).status() (opcional; sem ele, listar_regras dá erro).
//  - publicUrl: origem pública (mensagens apontam para <publicUrl>/conta.html).
//  - now: relógio injetável (ms); "hoje" é a data em -03:00.
// Saída: content [{type:'text', text: JSON}]. Erros: isError com mensagem em português e o
// próximo passo. Nunca devolve token nem segredo (secrets não sai daqui).
import { z } from 'zod';
import { JiraError } from '../support/service.js';
import { ScopeError } from '../worklog/service.js';
import { closingPeriod, periodIndicators, DEFAULT_SCHEDULE } from '../worklog/time.js';
import { localNow, summaryFor } from '../worklog/auto.js';

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_DAYS = 62;
const READ_ONLY = { readOnlyHint: true };

class ToolError extends Error {}

const ok = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

const dateArg = (what) => z.string().describe(`${what} no formato AAAA-MM-DD (fuso -03:00).`);

function checkDate(s, what) {
  const t = typeof s === 'string' && DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new ToolError(`${what} inválida: use AAAA-MM-DD (ex.: 2026-11-03).`);
  return s;
}

function checkRange(de, ate) {
  checkDate(de, 'Data inicial (de)');
  checkDate(ate, 'Data final (ate)');
  const days = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1) throw new ToolError('A data final (ate) deve ser igual ou posterior à inicial (de).');
  if (days > MAX_DAYS) throw new ToolError(`Período de no máximo ${MAX_DAYS} dias; divida a consulta em partes menores.`);
  return { from: de, to: ate };
}

// Minutos → "HH:MM" (horas podem passar de 24; saldo pode ser negativo).
function hhmm(min) {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export function registerTools(server, { user, ctx, holidays, autoRunner, publicUrl, now = () => Date.now() } = {}) {
  const conta = `${String(publicUrl ?? '').replace(/\/+$/, '')}/conta.html`;
  const today = () => localNow(now()).date;

  // Contexto Jira utilizável ou ToolError com o próximo passo.
  function jira() {
    if (!ctx || ctx.missing) throw new ToolError(`Configure seu token do Jira em Minha conta: ${conta}`);
    if (ctx.secrets?.tokenStatus === 'invalid') {
      throw new ToolError(`Seu token do Jira está inválido; atualize em Minha conta: ${conta}`);
    }
    return ctx;
  }

  // Envolve o handler: ToolError e erros do Jira viram isError; o resto, mensagem genérica.
  const handler = (fn) => async (args) => {
    try {
      return ok(await fn(args ?? {}));
    } catch (err) {
      if (err instanceof ToolError || err instanceof ScopeError || err instanceof RangeError) return fail(err.message);
      if (err instanceof JiraError) {
        if (err.status === 401) return fail(`Seu token do Jira está inválido; atualize em Minha conta: ${conta}`);
        return fail(`O Jira recusou a consulta: ${err.message}. Tente de novo em instantes.`);
      }
      console.error('[mcp tool]', err?.message);
      return fail('Erro interno no servidor do app. Tente de novo; se persistir, avise o administrador.');
    }
  };

  async function holidaySet(from, to) {
    if (!holidays) return new Set();
    return new Set((await holidays.between(from, to)).keys());
  }

  server.registerTool('listar_tarefas', {
    title: 'Listar tarefas',
    description: 'Lista os épicos em aberto atribuídos a você com as tarefas de apoio de cada um '
      + '(key, summary, status, url, minutos já apontados), as tarefas favoritas e se a IA de '
      + 'comentários está habilitada. Use as chaves (ex.: QSENSE-123) nas outras ferramentas.',
    annotations: READ_ONLY,
  }, handler(async () => {
    const c = jira();
    const { epics, aiEnabled } = await c.worklogService.listTasks();
    const favKeys = c.favorites ? await c.favorites.list() : [];
    const favoritos = favKeys.length ? await c.worklogService.describe(favKeys) : [];
    return { epicos: epics, favoritos, iaHabilitada: Boolean(aiEnabled) };
  }));

  server.registerTool('buscar_tarefa', {
    title: 'Buscar tarefa',
    description: 'Busca uma tarefa do Jira pela chave (ex.: SIJUD-123) ou pelo título exato (texto). '
      + 'Informe só um dos dois. No texto, {MM/AAAA}, {MM} e {AAAA} viram o mês/ano de hoje '
      + '(fuso -03:00), ex.: "Reunião diária {MM/AAAA}". Devolve {key, summary, status, url}; '
      + 'épicos não servem para apontar.',
    inputSchema: {
      chave: z.string().optional().describe('Chave da tarefa, ex.: SIJUD-123.'),
      texto: z.string().max(300).optional().describe('Título exato da tarefa; aceita {MM/AAAA}, {MM} e {AAAA}.'),
    },
    annotations: READ_ONLY,
  }, handler(async ({ chave, texto }) => {
    const hasKey = chave !== undefined && chave !== '';
    const hasText = texto !== undefined && texto.trim() !== '';
    if (hasKey === hasText) throw new ToolError('Informe a chave (ex.: SIJUD-123) ou o texto do título, só um dos dois.');
    const c = jira();
    let found;
    if (hasKey) {
      const key = chave.trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new ToolError('Chave de tarefa inválida (ex.: SIJUD-123).');
      [found] = await c.worklogService.describe([key]);
    } else {
      found = await c.worklogService.findBySummary(summaryFor(texto.trim(), today()));
    }
    if (!found.available) throw new ToolError(found.error);
    return { key: found.key, summary: found.summary, status: found.status, url: found.url };
  }));

  server.registerTool('meus_apontamentos', {
    title: 'Meus apontamentos',
    description: 'Lista os seus apontamentos (worklogs) no Jira entre as datas de e ate, inclusive, '
      + `no máximo ${MAX_DAYS} dias. Datas em AAAA-MM-DD; horários de início em HH:MM; tudo no fuso -03:00. `
      + 'Cada item: {id, tarefa, titulo, data, inicio, minutos, comentario}.',
    inputSchema: { de: dateArg('Data inicial'), ate: dateArg('Data final') },
    annotations: READ_ONLY,
  }, handler(async ({ de, ate }) => {
    const { from, to } = checkRange(de, ate);
    const c = jira();
    const list = await c.worklogService.myWorklogs(from, to);
    return {
      de: from, ate: to,
      apontamentos: list.map((w) => ({
        id: w.id, tarefa: w.issueKey, titulo: w.issueSummary, data: w.date, inicio: w.start, minutos: w.minutes, comentario: w.comment,
      })),
    };
  }));

  server.registerTool('indicadores', {
    title: 'Indicadores do período',
    description: 'Indicadores de horas do período: dias úteis (seg–sex sem feriado), dias trabalhados '
      + '(úteis com apontamento), dias a trabalhar (úteis de hoje em diante sem apontamento), horas '
      + 'previstas (8h por dia útil), executadas e saldo (previstas − executadas), em minutos e em HH:MM. '
      + 'Informe de e ate (AAAA-MM-DD, até 62 dias) ou fechamento "AAAA-MM": do dia 21 do mês anterior '
      + 'ao dia 20 do mês informado. Fuso -03:00.',
    inputSchema: {
      de: dateArg('Data inicial').optional(),
      ate: dateArg('Data final').optional(),
      fechamento: z.string().optional().describe('Mês de fechamento AAAA-MM (ex.: 2026-11 = 2026-10-21 a 2026-11-20).'),
    },
    annotations: READ_ONLY,
  }, handler(async ({ de, ate, fechamento }) => {
    let range;
    if (fechamento !== undefined) {
      if (de !== undefined || ate !== undefined) throw new ToolError('Informe fechamento ou de/ate, não os dois.');
      if (typeof fechamento !== 'string' || !MONTH_RE.test(fechamento)) throw new ToolError('Fechamento inválido: use AAAA-MM (ex.: 2026-11).');
      const [y, m] = fechamento.split('-').map(Number);
      range = closingPeriod(y, m, 21, 20);
    } else {
      if (de === undefined || ate === undefined) throw new ToolError('Informe de e ate (AAAA-MM-DD) ou fechamento (AAAA-MM).');
      range = checkRange(de, ate);
    }
    const c = jira();
    const [entries, hol] = await Promise.all([
      c.worklogService.myWorklogs(range.from, range.to),
      holidaySet(range.from, range.to),
    ]);
    const r = periodIndicators({ ...range, today: today(), entries, holidays: hol, dailyLimit: DEFAULT_SCHEDULE.dailyLimit });
    return {
      de: range.from, ate: range.to, hoje: today(),
      diasUteis: r.businessDays, diasTrabalhados: r.worked, diasATrabalhar: r.toWork,
      previstasMin: r.expectedMin, executadasMin: r.executedMin, saldoMin: r.balanceMin,
      previstas: hhmm(r.expectedMin), executadas: hhmm(r.executedMin), saldo: hhmm(r.balanceMin),
    };
  }));

  server.registerTool('listar_regras', {
    title: 'Listar regras de apontamento automático',
    description: 'Lista as suas regras de apontamento automático (tarefa por chave ou texto do título, '
      + 'início HH:MM, minutos, comentário, vigência desde/ate em AAAA-MM-DD, ativa), com a próxima '
      + 'execução ("AAAA-MM-DD HH:MM", fuso -03:00) e a última execução registrada.',
    annotations: READ_ONLY,
  }, handler(async () => {
    if (!autoRunner) throw new ToolError('Os apontamentos automáticos não estão disponíveis neste servidor.');
    const s = await autoRunner.schedulerFor(user.id).status();
    return {
      desativado: Boolean(s.disabled),
      pausado: Boolean(s.paused),
      regras: (s.rules ?? []).map((r) => ({
        id: r.id, chave: r.key ?? null, texto: r.summary ?? null, inicio: r.start, minutos: r.minutes,
        comentario: r.comment, desde: r.since, ate: r.until ?? null, ativa: Boolean(r.enabled),
        proximaExecucao: r.nextRun ?? null, ultimaExecucao: r.lastRun ?? null, diasGravados: r.doneCount ?? 0,
      })),
    };
  }));
}
