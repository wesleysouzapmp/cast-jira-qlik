// Ferramentas do conector MCP (leitura e gravação). Registradas por requisição em createMcpServer.
//
// registerTools(server, { user, ctx, holidays, autoRunner, publicUrl, previews, audit, now })
//  - user: { id, name, email, role } de quem chama (do Bearer).
//  - ctx: contexts.forUser(user) — { worklogService, favorites, secrets, ... } ou { missing: true }.
//  - holidays: provedor com between(from, to) → Map (opcional; sem ele, nenhum feriado).
//  - autoRunner: schedulerFor(userId).status() (opcional; sem ele, listar_regras dá erro).
//  - publicUrl: origem pública (mensagens apontam para <publicUrl>/conta.html).
//  - previews: createPreviewStore() único do processo (gerar_previa → confirmar_previa).
//  - audit: createAuditRepo(); toda gravação bem-sucedida registra via = 'mcp', action = nome da
//    ferramenta e um detalhe sem comentários nem segredos (chaves, datas, ids, contagens).
//  - now: relógio injetável (ms); "hoje" é a data em -03:00.
// Gravações: mesmas regras das telas (sem sobreposição, épico recusado, transição para "Em Execução"
// só em tarefas de apoio). Ids de batida são conferidos entre os apontamentos do próprio usuário
// (de hoje − 62 a hoje + 31 dias); regras sempre no agendador de user.id.
// Saída: content [{type:'text', text: JSON}]. Erros: isError com mensagem em português e o
// próximo passo. Nunca devolve token nem segredo (secrets não sai daqui).
import { z } from 'zod';
import { JiraError } from '../support/service.js';
import { ScopeError, ConflictError } from '../worklog/service.js';
import { closingPeriod, periodIndicators, parseDuration, addDays, hhmmToMin, DEFAULT_SCHEDULE } from '../worklog/time.js';
import { localNow, summaryFor } from '../worklog/auto.js';

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WORKLOG_ID_RE = /^\d{1,20}$/;
const MAX_DAYS = 62;
// Mesmos limites da tela Apontar horas (server.js): prévia de até 31 dias e até 200 batidas por envio.
const MAX_PREVIEW_DAYS = 31;
const MAX_ENTRIES = 200;
const MAX_ITEMS = 100;
const MAX_COMMENT = 1000;
// Janela em que um id de batida é procurado entre os apontamentos do usuário (a partir de hoje).
const LOOKUP_BACK = 62;
const LOOKUP_FWD = 31;
const READ_ONLY = { readOnlyHint: true };
const WRITES = { readOnlyHint: false, destructiveHint: true };

class ToolError extends Error {}

const ok = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

const dateArg = (what) => z.string().describe(`${what} no formato AAAA-MM-DD (fuso -03:00).`);

function checkDate(s, what) {
  const t = typeof s === 'string' && DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new ToolError(`${what} inválida: use AAAA-MM-DD (ex.: 2026-11-03).`);
  return s;
}

function checkRange(de, ate, maxDays = MAX_DAYS) {
  checkDate(de, 'Data inicial (de)');
  checkDate(ate, 'Data final (ate)');
  const days = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000 + 1;
  if (days < 1) throw new ToolError('A data final (ate) deve ser igual ou posterior à inicial (de).');
  if (days > maxDays) throw new ToolError(`Período de no máximo ${maxDays} dias; divida a consulta em partes menores.`);
  return { from: de, to: ate };
}

function checkHhmm(s, what) {
  if (typeof s !== 'string' || !HHMM_RE.test(s)) throw new ToolError(`${what} inválido: use HH:MM (ex.: 09:00).`);
  return s;
}

function checkKey(s, what = 'Chave de tarefa') {
  const key = typeof s === 'string' ? s.trim().toUpperCase() : '';
  if (!KEY_RE.test(key)) throw new ToolError(`${what} inválida (ex.: SIJUD-123).`);
  return key;
}

// Minutos exatos de uma duração em texto, sem arredondar (mesmos formatos de parseDuration:
// "1:30", "1,5", "2h", "1h 30m", "45m"/"45min"); null se o formato não for reconhecido.
function rawMinutes(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+):([0-5]\d)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) return Number(m[1].replace(',', '.')) * 60;
  if ((m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/)) && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}

// Duração em blocos exatos de 15 min (como a tela: nada é arredondado em silêncio) ou ToolError.
function checkBlocks(text, what) {
  const m = rawMinutes(text);
  if (m === null) throw new ToolError(`${what} inválida: use, ex.: "2h", "1h 15m", "45m".`);
  if (!Number.isInteger(m) || m % 15) throw new ToolError(`${what} inválida ("${text}"): use blocos de 15 min, ex.: 1h 15m.`);
  return m;
}

// Duração em texto ("2h", "1h 30m", "90m", "1,5") → minutos em blocos de 15, dentro de [min, max].
function checkDuration(text, what, { min = 15, max = 480 } = {}) {
  const m = checkBlocks(text, what);
  if (m < min || m > max) {
    throw new ToolError(`${what} inválida: use blocos de 15 min entre ${fmtMin(min)} e ${fmtMin(max)} (ex.: "2h", "1h 30m", "45m").`);
  }
  return m;
}

function checkComment(s, what = 'Comentário') {
  if (s === undefined || s === null) return undefined;
  if (typeof s !== 'string' || s.length > MAX_COMMENT) throw new ToolError(`${what}: no máximo ${MAX_COMMENT} caracteres.`);
  return s;
}

const fmtMin = (m) => [Math.floor(m / 60) ? `${Math.floor(m / 60)}h` : '', m % 60 ? `${m % 60}m` : ''].filter(Boolean).join(' ') || '0m';

// Minutos → "HH:MM" (horas podem passar de 24; saldo pode ser negativo).
function hhmm(min) {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export function registerTools(server, { user, ctx, holidays, autoRunner, publicUrl, previews, audit, now = () => Date.now() } = {}) {
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
  // write: erros do Jira falam em "gravação" em vez de "consulta".
  const handler = (fn, { write = false } = {}) => async (args) => {
    try {
      return ok(await fn(args ?? {}));
    } catch (err) {
      if (err instanceof ToolError || err instanceof ScopeError || err instanceof ConflictError || err instanceof RangeError) return fail(err.message);
      if (err instanceof JiraError) {
        if (err.status === 401) return fail(`Seu token do Jira está inválido; atualize em Minha conta: ${conta}`);
        return fail(`O Jira recusou a ${write ? 'gravação' : 'consulta'}: ${err.message}. Tente de novo em instantes.`);
      }
      console.error('[mcp tool]', err?.message);
      return fail('Erro interno no servidor do app. Tente de novo; se persistir, avise o administrador.');
    }
  };

  // Auditoria da gravação já feita: falha aqui não derruba a resposta.
  function record(action, detail) {
    if (!audit) return;
    try { audit.log({ userId: user.id, via: 'mcp', action, detail }); } catch (err) { console.error('[auditoria]', err?.message); }
  }

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
      + 'previstas (limite diário × dias úteis), executadas e saldo (previstas − executadas), em minutos e em HH:MM. '
      + 'Informe de e ate (AAAA-MM-DD, até 62 dias) ou fechamento "AAAA-MM": do dia 21 do mês anterior '
      + 'ao dia 20 do mês informado. Fuso -03:00. O limite diário padrão é 8h; a pessoa pode informar em '
      + 'limite_diario o limite que usa na tela (ex.: "6h", "7h 30m", "450m").',
    inputSchema: {
      de: dateArg('Data inicial').optional(),
      ate: dateArg('Data final').optional(),
      fechamento: z.string().optional().describe('Mês de fechamento AAAA-MM (ex.: 2026-11 = 2026-10-21 a 2026-11-20).'),
      limite_diario: z.string().max(20).optional().describe('Limite diário de horas, ex.: "8h", "7h 30m", "6" ou "450m" (de 1h a 24h). Padrão: 8h.'),
    },
    annotations: READ_ONLY,
  }, handler(async ({ de, ate, fechamento, limite_diario: limite }) => {
    let dailyLimit = DEFAULT_SCHEDULE.dailyLimit;
    if (limite !== undefined) {
      dailyLimit = parseDuration(limite);
      if (dailyLimit === null || dailyLimit < 60 || dailyLimit > 1440) {
        throw new ToolError('Limite diário inválido: use de 1h a 24h, ex.: "8h", "7h 30m", "6" ou "450m".');
      }
    }
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
    const r = periodIndicators({ ...range, today: today(), entries, holidays: hol, dailyLimit });
    return {
      de: range.from, ate: range.to, hoje: today(), limiteDiarioMin: dailyLimit,
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
    if (!autoRunner) throw new ToolError('Os apontamentos automáticos não estão disponíveis neste servidor; tente novamente mais tarde ou use a tela Apontar horas.');
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

  registerWriteTools({ server, user, jira, handler, record, previews, autoRunner, now, today });
}

// "AAAA-MM-DD HH:MM" no fuso -03:00.
function localStamp(ms) {
  const { date, min } = localNow(ms);
  return `${date} ${hhmm(min)}`;
}

// Regra do agendador → saída do MCP (mesmos nomes de listar_regras).
const ruleOut = (r) => ({
  id: r.id, chave: r.key ?? null, texto: r.summary ?? null, inicio: r.start, minutos: r.minutes,
  comentario: r.comment ?? '', desde: r.since ?? null, ate: r.until ?? null, ativa: Boolean(r.enabled),
});

const transOut = (list) => list.map((t) => ({
  tarefa: t.key, status: t.status, de: t.from, ...(t.to ? { para: t.to } : {}), ...(t.error ? { erro: t.error } : {}),
}));

function registerWriteTools({ server, user, jira, handler, record, previews, autoRunner, now, today }) {
  const writeHandler = (fn) => handler(fn, { write: true });
  const ttlMs = previews?.ttlMs ?? 30 * 60e3;
  const ttlMin = Math.round(ttlMs / 60e3);

  // ---------- prévia e confirmação ----------
  function parseSchedule(e) {
    if (e === null || typeof e !== 'object') throw new ToolError('Expediente inválido.');
    const d = DEFAULT_SCHEDULE;
    const s = {
      start: checkHhmm(e.inicio ?? d.start, 'Início do expediente'),
      lunchStart: checkHhmm(e.almoco_de ?? d.lunchStart, 'Início do almoço'),
      lunchEnd: checkHhmm(e.almoco_ate ?? d.lunchEnd, 'Fim do almoço'),
      end: checkHhmm(e.fim ?? d.end, 'Fim do expediente'),
      dailyLimit: e.limite_diario === undefined ? d.dailyLimit : checkDuration(e.limite_diario, 'Limite diário', { min: 15, max: 1440 }),
    };
    const m = hhmmToMin;
    if (!(m(s.start) < m(s.lunchStart) && m(s.lunchStart) <= m(s.lunchEnd) && m(s.lunchEnd) < m(s.end))) {
      throw new ToolError('Expediente incoerente: precisa ser inicio < almoco_de ≤ almoco_ate < fim (padrão 08:00, 12:00, 13:00, 17:00).');
    }
    return s;
  }

  server.registerTool('gerar_previa', {
    title: 'Gerar prévia de apontamentos',
    description: 'Distribui as horas pedidas por tarefa nos dias úteis de de a ate (AAAA-MM-DD, até 31 dias e 200 batidas, '
      + 'fuso -03:00), sem sobrepor os seus apontamentos, respeitando expediente, limite diário e feriados. '
      + 'Não grava nada: devolve as batidas numeradas (indice, tarefa, data, inicio HH:MM, minutos, comentário '
      + 'sugerido), as horas que não couberam (faltantes), as transições de status previstas e um previa_id '
      + `válido por ${ttlMin} minutos. Mostre a prévia à pessoa e, com o de acordo, chame confirmar_previa. `
      + 'horas aceita "2h", "1h 30m", "90m" (blocos de 15 min); por_dia = true aplica as horas em cada dia útil (até 8h). '
      + 'Dividir um total entre tarefas (ex.: Análise e Implementação de um épico): ANTES de gerar, pergunte à pessoa '
      + 'o dia do apontamento e informe-o em dia em cada item; as horas começam nesse dia, que não passa do limite diário '
      + 'somando os apontamentos de outras tarefas, e o que sobrar vai para os próximos dias úteis, mesmo depois de ate. '
      + 'expediente (opcional): inicio, almoco_de, almoco_ate, fim em HH:MM e limite_diario (ex.: "8h"); '
      + 'padrão 08:00–12:00, 13:00–17:00 e 8h. Épicos não servem: use as tarefas de apoio (listar_tarefas) ou outras tarefas.',
    inputSchema: {
      itens: z.array(z.object({
        tarefa: z.string().describe('Chave da tarefa, ex.: QSENSE-123.'),
        horas: z.string().describe('Horas, ex.: "2h", "1h 30m", "45m".'),
        por_dia: z.boolean().optional().describe('true: as horas valem para cada dia útil do período.'),
        dia: z.string().optional().describe('Dia do apontamento (AAAA-MM-DD) ao dividir um total; pergunte à pessoa antes. A sobra vai para os próximos dias úteis.'),
      })).describe('Tarefas e horas a distribuir.'),
      de: dateArg('Data inicial'),
      ate: dateArg('Data final'),
      expediente: z.object({
        inicio: z.string().optional(),
        almoco_de: z.string().optional(),
        almoco_ate: z.string().optional(),
        fim: z.string().optional(),
        limite_diario: z.string().optional(),
      }).optional().describe('Expediente (HH:MM) e limite diário; padrão 08:00, 12:00, 13:00, 17:00 e 8h.'),
    },
    annotations: READ_ONLY,
  }, handler(async ({ itens, de, ate, expediente }) => {
    const { from, to } = checkRange(de, ate, MAX_PREVIEW_DAYS);
    if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITEMS) throw new ToolError(`Informe de 1 a ${MAX_ITEMS} itens com tarefa e horas.`);
    const items = itens.map((i) => {
      const taskKey = checkKey(i?.tarefa);
      const max = i?.por_dia ? 480 : 200 * 60;
      const minutes = rawMinutes(i?.horas);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes % 15)) {
        throw new ToolError(`Horas inválidas para ${taskKey} ("${i.horas}"): use blocos de 15 min, ex.: 1h 15m.`);
      }
      if (minutes === null || minutes < 15 || minutes > max) {
        throw new ToolError(`Horas inválidas para ${taskKey}: use blocos de 15 min até ${fmtMin(max)}${i?.por_dia ? ' por dia' : ''} (ex.: "2h", "1h 30m", "45m").`);
      }
      if (i.dia !== undefined) {
        checkDate(i.dia, `Dia do apontamento de ${taskKey}`);
        if (i.por_dia) throw new ToolError(`${taskKey}: use dia ou por_dia, não os dois.`);
      }
      return { taskKey, minutes, ...(i.por_dia ? { perDay: true } : {}), ...(i.dia ? { startDate: i.dia } : {}) };
    });
    const schedule = parseSchedule(expediente ?? {});
    if (!previews) throw new ToolError('As prévias não estão disponíveis neste servidor; tente novamente mais tarde ou use a tela Apontar horas.');
    const c = jira();
    const out = await c.worklogService.preview({ items, from, to, schedule });
    if (out.entries.length > MAX_ENTRIES) {
      throw new ToolError(`A prévia teria ${out.entries.length} batidas (máximo ${MAX_ENTRIES} por envio); divida o período ou as tarefas em partes menores.`);
    }
    const entries = out.entries.map((e) => ({ taskKey: e.taskKey, date: e.date, start: e.start, minutes: e.minutes, comment: e.comment ?? '' }));
    const id = entries.length ? previews.put(user.id, { entries }) : null;
    return {
      de: from,
      ate: to,
      previa_id: id,
      expira_em: id ? localStamp(now() + ttlMs) : null,
      batidas: out.entries.map((e, n) => ({ indice: n + 1, tarefa: e.taskKey, data: e.date, inicio: e.start, minutos: e.minutes, duracao: e.timeSpent, comentario: e.comment ?? '' })),
      faltantes: out.unallocated.map((u) => ({ tarefa: u.taskKey, minutos: u.minutes, ...(u.date ? { data: u.date } : {}) })),
      transicoes: out.transitions.map((t) => ({ tarefa: t.key, de: t.from, para: t.to })),
      proximo_passo: id
        ? `Mostre a prévia; para gravar, chame confirmar_previa com previa_id em até ${ttlMin} minutos (comentarios opcionais por indice).`
        : 'Nenhuma batida coube no período (sem dias úteis ou horários livres); ajuste o período, as horas ou o expediente.',
    };
  }));

  server.registerTool('confirmar_previa', {
    title: 'Confirmar prévia (grava no Jira)',
    description: 'Grava no Jira as batidas de uma prévia gerada por gerar_previa (uso único, válida por '
      + `${ttlMin} minutos). comentarios (opcional) troca o comentário de batidas pelo indice da prévia. `
      + 'Antes de gravar, o app confere de novo se surgiram apontamentos no período; se houver, nada é gravado '
      + 'e é preciso gerar a prévia de novo. Tarefas de apoio em "Aberto" (e o épico) vão para "Em Execução". '
      + 'Devolve o resultado por batida e as transições.',
    inputSchema: {
      previa_id: z.string().max(100).describe('previa_id devolvido por gerar_previa.'),
      comentarios: z.array(z.object({
        indice: z.number().int().describe('Índice da batida na prévia (1, 2, ...).'),
        texto: z.string().describe(`Novo comentário (até ${MAX_COMMENT} caracteres).`),
      })).max(500).optional(),
    },
    annotations: WRITES,
  }, writeHandler(async ({ previa_id: previaId, comentarios = [] }) => {
    for (const k of comentarios) checkComment(k?.texto, `Comentário da batida ${k?.indice}`);
    const c = jira(); // antes do take: sem token, a prévia não é consumida
    const notFound = 'Prévia não encontrada ou expirada; gere de novo com gerar_previa.';
    // Valida com get (sem consumir): índice errado não descarta a prévia.
    const peek = previews?.get(user.id, previaId);
    if (!peek) throw new ToolError(notFound);
    const n = peek.entries.length;
    if (n > MAX_ENTRIES) throw new ToolError(`A prévia tem ${n} batidas (máximo ${MAX_ENTRIES} por envio); gere prévias de períodos menores.`);
    for (const k of comentarios) {
      if (!Number.isInteger(k.indice) || k.indice < 1 || k.indice > n) {
        throw new ToolError(`Comentário com índice ${k.indice} inexistente: a prévia tem ${n} batida(s); use índices de 1 a ${n} e chame confirmar_previa de novo com o mesmo previa_id.`);
      }
    }
    const preview = previews.take(user.id, previaId);
    if (!preview) throw new ToolError(notFound);
    const entries = preview.entries.map((e) => ({ ...e }));
    for (const k of comentarios) entries[k.indice - 1].comment = k.texto;
    const out = await c.worklogService.submit({ entries });
    const created = out.results.filter((r) => r.status === 'created');
    if (!created.length) {
      throw new ToolError(`Nenhuma batida foi gravada: ${out.results[0]?.error ?? 'o Jira recusou'}. Confira em meus_apontamentos antes de tentar de novo.`);
    }
    const dates = entries.map((e) => e.date).sort();
    record('confirmar_previa', {
      batidas: entries.length, criadas: created.length, tarefas: [...new Set(entries.map((e) => e.taskKey))], de: dates[0], ate: dates.at(-1),
    });
    return {
      gravadas: created.length,
      falhas: entries.length - created.length,
      resultados: out.results.map((r) => ({
        indice: r.index + 1, tarefa: entries[r.index].taskKey, data: entries[r.index].date, inicio: entries[r.index].start,
        status: r.status, ...(r.worklogId ? { worklogId: String(r.worklogId) } : {}), ...(r.error ? { erro: r.error } : {}),
      })),
      transicoes: transOut(out.transitions),
    };
  }));

  // ---------- batidas avulsas ----------
  server.registerTool('apontar', {
    title: 'Apontar horas (grava no Jira)',
    description: 'Grava um apontamento (worklog) na tarefa: data AAAA-MM-DD, inicio HH:MM (múltiplo de 15 min) '
      + 'e duracao ("1h", "1h 30m", "45m"; de 15 min a 8h), fuso -03:00, comentario opcional. Recusa épicos e '
      + 'horários que se sobrepõem a apontamentos seus (nada é gravado). Tarefa de apoio em "Aberto" vai para "Em Execução".',
    inputSchema: {
      tarefa: z.string().describe('Chave da tarefa, ex.: SIJUD-123.'),
      data: dateArg('Data do apontamento'),
      inicio: z.string().describe('Horário de início HH:MM (múltiplo de 15 min).'),
      duracao: z.string().describe('Duração, ex.: "1h", "1h 30m", "45m".'),
      comentario: z.string().optional().describe(`Comentário (até ${MAX_COMMENT} caracteres).`),
    },
    annotations: WRITES,
  }, writeHandler(async ({ tarefa, data, inicio, duracao, comentario }) => {
    const taskKey = checkKey(tarefa);
    const date = checkDate(data, 'Data');
    const start = checkHhmm(inicio, 'Início');
    if (hhmmToMin(start) % 15) throw new ToolError('Início deve ser múltiplo de 15 min (ex.: 09:00, 09:15).');
    const minutes = checkDuration(duracao, 'Duração');
    if (hhmmToMin(start) + minutes > 1440) throw new ToolError('O apontamento passa da meia-noite; divida em dois dias.');
    const comment = checkComment(comentario) ?? '';
    const c = jira();
    let out;
    try {
      out = await c.worklogService.submit({ entries: [{ taskKey, date, start, minutes, comment }] });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new ToolError(`O horário ${start}–${hhmm(hhmmToMin(start) + minutes)} de ${date} se sobrepõe a um apontamento seu; nada foi gravado. Consulte meus_apontamentos e escolha outro horário.`);
      }
      throw err;
    }
    const r = out.results[0];
    if (r?.status !== 'created') throw new ToolError(`O Jira recusou o apontamento: ${r?.error ?? 'erro desconhecido'}. Confira em meus_apontamentos antes de tentar de novo.`);
    const worklogId = r.worklogId ? String(r.worklogId) : null;
    record('apontar', { tarefa: taskKey, data: date, inicio: start, minutos: minutes, worklogId });
    return { status: 'created', worklogId, tarefa: taskKey, data: date, inicio: start, minutos: minutes, transicoes: transOut(out.transitions) };
  }));

  // Batida do próprio usuário (author.accountId = o do token) pelo id, na janela de busca.
  async function findMine(c, id) {
    const wid = typeof id === 'string' ? id.trim() : '';
    if (!WORKLOG_ID_RE.test(wid)) throw new ToolError('Id de apontamento inválido; use o id de meus_apontamentos.');
    const d = today();
    const from = addDays(d, -LOOKUP_BACK);
    const to = addDays(d, LOOKUP_FWD);
    const w = (await c.worklogService.myWorklogs(from, to)).find((x) => x.id === wid);
    if (!w) {
      throw new ToolError(`Apontamento ${wid} não encontrado entre os seus de ${from} a ${to}; confira o id em meus_apontamentos. Só é possível mudar apontamentos seus.`);
    }
    return w;
  }

  const batchFail = (r) => new ToolError(`O Jira recusou a alteração: ${r?.error ?? 'erro desconhecido'}. Confira em meus_apontamentos antes de tentar de novo.`);

  server.registerTool('alterar_apontamento', {
    title: 'Alterar apontamento (grava no Jira)',
    description: 'Altera um apontamento seu pelo id (de meus_apontamentos; procurado entre os seus de 62 dias '
      + 'atrás a 31 dias à frente). Informe só o que muda: tarefa (move para outra tarefa de apoio), data '
      + '(AAAA-MM-DD), inicio (HH:MM), duracao ("1h 30m") e comentario. Sem sobreposição com outros apontamentos seus.',
    inputSchema: {
      id: z.string().describe('Id do apontamento (meus_apontamentos).'),
      tarefa: z.string().optional().describe('Nova tarefa (tarefa de apoio), ex.: QSENSE-123.'),
      data: dateArg('Nova data').optional(),
      inicio: z.string().optional().describe('Novo início HH:MM.'),
      duracao: z.string().optional().describe('Nova duração, ex.: "1h 30m".'),
      comentario: z.string().optional().describe(`Novo comentário (até ${MAX_COMMENT} caracteres; "" apaga).`),
    },
    annotations: WRITES,
  }, writeHandler(async ({ id, tarefa, data, inicio, duracao, comentario }) => {
    const fields = { tarefa, data, inicio, duracao, comentario };
    const changed = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!changed.length) throw new ToolError('Informe ao menos um campo para alterar: tarefa, data, inicio, duracao ou comentario.');
    const targetKey = tarefa === undefined ? undefined : checkKey(tarefa, 'Tarefa de destino');
    const date = data === undefined ? undefined : checkDate(data, 'Data');
    const start = inicio === undefined ? undefined : checkHhmm(inicio, 'Início');
    const minutes = duracao === undefined ? undefined : checkDuration(duracao, 'Duração');
    const comment = checkComment(comentario);
    const c = jira();
    const w = await findMine(c, id);
    const change = {
      id: w.id, issueKey: w.issueKey, action: 'update',
      date: date ?? w.date, start: start ?? w.start, minutes: minutes ?? w.minutes, comment: comment ?? w.comment ?? '',
      ...(w.updated ? { updated: w.updated } : {}),
      ...(targetKey && targetKey !== w.issueKey ? { targetKey } : {}),
    };
    if (hhmmToMin(change.start) + change.minutes > 1440) throw new ToolError('O apontamento passaria da meia-noite; ajuste início ou duração.');
    const out = await c.worklogService.batch({ changes: [change] });
    const r = out.results[0];
    if (!r || r.status === 'error') throw batchFail(r);
    record('alterar_apontamento', { id: w.id, tarefa: w.issueKey, ...(change.targetKey ? { para: change.targetKey } : {}), campos: changed });
    return {
      status: r.status, id: w.id, ...(r.newId ? { novoId: String(r.newId) } : {}), ...(r.error ? { aviso: r.error } : {}),
      tarefa: change.targetKey ?? w.issueKey, data: change.date, inicio: change.start, minutos: change.minutes,
      transicoes: transOut(out.transitions),
    };
  }));

  server.registerTool('apagar_apontamento', {
    title: 'Apagar apontamento (grava no Jira)',
    description: 'Apaga um apontamento seu pelo id (de meus_apontamentos; procurado entre os seus de 62 dias '
      + 'atrás a 31 dias à frente). Apontamentos de outras pessoas não podem ser apagados.',
    inputSchema: { id: z.string().describe('Id do apontamento (meus_apontamentos).') },
    annotations: WRITES,
  }, writeHandler(async ({ id }) => {
    const c = jira();
    const w = await findMine(c, id);
    const out = await c.worklogService.batch({ changes: [{ id: w.id, issueKey: w.issueKey, action: 'delete' }] });
    const r = out.results[0];
    if (!r || r.status !== 'deleted') throw batchFail(r);
    record('apagar_apontamento', { id: w.id, tarefa: w.issueKey, data: w.date });
    return { status: 'deleted', id: w.id, tarefa: w.issueKey, data: w.date, inicio: w.start, minutos: w.minutes };
  }));

  // ---------- regras de apontamento automático (sempre no agendador de user.id) ----------
  function sched() {
    if (!autoRunner) throw new ToolError('Os apontamentos automáticos não estão disponíveis neste servidor; tente novamente mais tarde ou use a tela Apontamentos automáticos.');
    return autoRunner.schedulerFor(user.id);
  }
  const ruleId = (id) => {
    const v = typeof id === 'string' ? id.trim() : '';
    if (!v || v.length > 64) throw new ToolError('Id de regra inválido; use o id de listar_regras.');
    return v;
  };
  async function currentRule(s, id) {
    const r = (await s.status()).rules?.find((x) => x.id === id);
    if (!r) throw new ToolError('Regra não encontrada; confira o id em listar_regras.');
    return { key: r.key ?? null, summary: r.summary ?? null, start: r.start, minutes: r.minutes, comment: r.comment, since: r.since, until: r.until ?? null, enabled: Boolean(r.enabled) };
  }
  const saved = (r) => ({ regra: ruleOut(r), aviso: r.warning ?? null, ...(r.resolved ? { tarefaEncontrada: r.resolved.key } : {}) });
  const upperKey = (k) => (typeof k === 'string' ? k.trim().toUpperCase() : k);

  const ruleFields = {
    chave: z.string().optional().describe('Chave da tarefa, ex.: SIJUD-123 (ou use texto).'),
    texto: z.string().max(255).optional().describe('Título exato da tarefa; aceita {MM/AAAA}, {MM} e {AAAA} (ou use chave).'),
    inicio: z.string().describe('Horário HH:MM (fuso -03:00).'),
    minutos: z.number().int().describe('Duração em minutos (1 a 480).'),
    comentario: z.string().max(500).optional().describe('Comentário do apontamento.'),
    desde: dateArg('Início da vigência').optional(),
    ate: dateArg('Fim da vigência').nullable().optional(),
    ativa: z.boolean().optional().describe('Regra ativa (padrão true).'),
  };

  server.registerTool('criar_regra', {
    title: 'Criar regra de apontamento automático',
    description: 'Cria uma regra que aponta todo dia útil (seg–sex sem feriado) no horário inicio (HH:MM, -03:00) '
      + 'por minutos na tarefa da chave ou do texto do título (com {MM/AAAA} o app acha a tarefa do mês), '
      + 'entre desde e ate (AAAA-MM-DD; desde padrão hoje, ate opcional). Devolve a regra salva e um aviso, se houver.',
    inputSchema: ruleFields,
    annotations: WRITES,
  }, writeHandler(async ({ chave, texto, inicio, minutos, comentario, desde, ate, ativa }) => {
    const s = sched();
    const r = await s.addRule({
      key: chave === undefined ? null : upperKey(chave), summary: texto ?? null, start: inicio, minutes: minutos,
      comment: comentario, since: desde, until: ate ?? null, enabled: ativa ?? true,
    });
    record('criar_regra', { regraId: r?.id ?? null, chave: r?.key ?? null });
    return saved(r);
  }));

  server.registerTool('alterar_regra', {
    title: 'Alterar regra de apontamento automático',
    description: 'Altera uma regra pelo id (listar_regras). Informe só o que muda: chave ou texto, inicio, minutos, '
      + 'comentario, desde, ate (null tira o fim) e ativa.',
    inputSchema: {
      id: z.string().describe('Id da regra (listar_regras).'),
      ...Object.fromEntries(Object.entries(ruleFields).map(([k, v]) => [k, v.optional()])),
    },
    annotations: WRITES,
  }, writeHandler(async ({ id: rawId, chave, texto, inicio, minutos, comentario, desde, ate, ativa }) => {
    const id = ruleId(rawId);
    const s = sched();
    const next = await currentRule(s, id);
    if (chave !== undefined) { next.key = upperKey(chave); if (texto === undefined) next.summary = null; }
    if (texto !== undefined) { next.summary = texto; if (chave === undefined) next.key = null; }
    if (inicio !== undefined) next.start = inicio;
    if (minutos !== undefined) next.minutes = minutos;
    if (comentario !== undefined) next.comment = comentario;
    if (desde !== undefined) next.since = desde;
    if (ate !== undefined) next.until = ate;
    if (ativa !== undefined) next.enabled = ativa;
    const r = await s.updateRule(id, next);
    record('alterar_regra', { regraId: id, chave: r?.key ?? null });
    return saved(r);
  }));

  server.registerTool('pausar_regra', {
    title: 'Pausar ou retomar uma regra',
    description: 'Pausa (pausar = true) ou retoma (pausar = false) só a regra do id informado (listar_regras); as outras continuam.',
    inputSchema: {
      id: z.string().describe('Id da regra (listar_regras).'),
      pausar: z.boolean().describe('true pausa; false retoma.'),
    },
    annotations: WRITES,
  }, writeHandler(async ({ id: rawId, pausar }) => {
    const id = ruleId(rawId);
    if (typeof pausar !== 'boolean') throw new ToolError('Informe pausar: true ou false.');
    const s = sched();
    const cur = await currentRule(s, id);
    const r = await s.updateRule(id, { ...cur, enabled: !pausar });
    record('pausar_regra', { regraId: id, pausada: pausar });
    return saved(r);
  }));

  server.registerTool('excluir_regra', {
    title: 'Excluir regra de apontamento automático',
    description: 'Exclui a regra do id informado (listar_regras). Os apontamentos já gravados por ela continuam no Jira.',
    inputSchema: { id: z.string().describe('Id da regra (listar_regras).') },
    annotations: WRITES,
  }, writeHandler(async ({ id: rawId }) => {
    const id = ruleId(rawId);
    await sched().removeRule(id);
    record('excluir_regra', { regraId: id });
    return { status: 'deleted', id };
  }));
}
