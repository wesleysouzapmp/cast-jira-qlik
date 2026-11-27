// Tela "Meus apontamentos": indicadores do período exibido (horas, régua por dia útil e UST) e o
// calendário com as batidas do Jira. Clique num dia abre o painel do dia; Shift+clique marca um
// período para abrir "Apontar horas" com ele. Texto do Jira só por textContent.
import { parseDuration, formatDuration, periodIndicators, businessDays, DEFAULT_SCHEDULE } from '/lib/time.js';
import { createCalendar } from './calendar.js';
import { openDayPanel } from './daypanel.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'apontar.schedule'; // expediente salvo em "Apontar horas" (limite diário)

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}
const link = (key, url) => el('a', { href: url, target: '_blank', rel: 'noopener' }, key);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) { const e = new Error(json.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}

// Limite diário: o mesmo salvo em "Apontar horas" (padrão 8h).
function dailyLimit() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
    return Number.isInteger(saved.dailyLimit) && saved.dailyLimit > 0 ? saved.dailyLimit : DEFAULT_SCHEDULE.dailyLimit;
  } catch { return DEFAULT_SCHEDULE.dailyLimit; }
}

// Período marcado com Shift+clique (vazio = nenhum) e o link para apontar nele.
const sel = { from: '', to: '' };
const apontarUrl = (from, to) => `apontar.html?${new URLSearchParams({ from, to })}`;
function renderSel() {
  $('selBar').hidden = !sel.from;
  if (!sel.from) return;
  $('selText').textContent = sel.from === sel.to ? fmtShort(sel.from) : `${fmtShort(sel.from)} a ${fmtShort(sel.to)}`;
}

// Tarefas de apoio (destinos de mover batida e "Tarefa existente" do novo apontamento), inclusive
// as soltas (sem épico), e os épicos em aberto do usuário (como em Apontar horas).
let tasks = [];
let epics = [];
async function loadTasks() {
  try {
    const r = await api('/api/worklog/tasks');
    tasks = [
      // Subtarefas da agrupadora: "CAT - tarefa do catálogo" e o título.
      ...r.epics.flatMap((e) => e.tasks.map((t) => ({ key: t.key, model: t.model, label: t.subtask ? `${t.label} — ${t.summary}` : t.label, epicKey: e.key }))),
      ...(r.loose ?? []).map((t) => ({ key: t.key, model: t.model, label: t.label, epicKey: '' })),
    ];
    epics = r.epics.map((e) => ({ key: e.key, summary: e.summary }));
  } catch { tasks = []; epics = []; }
}

// Catálogo de UST (CAT e tamanhos) para a nova tarefa do painel do dia.
let catalog = [];
async function loadCatalog() {
  try { catalog = (await api('/api/ust/catalogo')).items ?? []; } catch { catalog = []; }
}

let calendar = null;
let lastShown = null;

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtShort = (date) => date.split('-').reverse().join('/');
const hours = (min) => (min ? formatDuration(min) : '0h');

// Indicadores do período exibido no calendário: horas executadas em destaque, régua com um
// traço por dia útil (altura = horas do dia, tracejado = limite diário) e os números do período.
function renderKpis() {
  if (!lastShown) return;
  const limit = dailyLimit();
  const today = todayLocal();
  const k = periodIndicators({ ...lastShown, today, dailyLimit: limit });
  const card = (label, value, cls = '', title = '') => el('div', { class: `kpi ${cls}`.trim(), title }, el('strong', {}, value), el('span', {}, label));
  const balance = k.balanceMin > 0 ? `Faltam ${hours(k.balanceMin)} para a meta` : k.balanceMin < 0 ? `${hours(-k.balanceMin)} acima da meta` : 'Na meta';
  const balanceCls = k.balanceMin > 0 ? 'under' : k.balanceMin < 0 ? 'over' : 'ok';
  $('kpiPeriod').textContent = lastShown.from === lastShown.to ? fmtShort(lastShown.from) : `${fmtShort(lastShown.from)} a ${fmtShort(lastShown.to)}`;

  const perDay = new Map();
  for (const e of lastShown.entries ?? []) perDay.set(e.date, (perDay.get(e.date) ?? 0) + (e.minutes || 0));
  const days = businessDays(lastShown.from, lastShown.to, lastShown.holidays ?? new Set());
  const top = Math.max(limit * 1.25, ...days.map((d) => perDay.get(d) ?? 0)) || 1;
  const ticks = days.map((d) => {
    const m = perDay.get(d) ?? 0;
    const future = d > today && !m;
    const cls = ['tick', future ? 'future' : !m ? 'zero' : '', m > limit ? 'over' : '', d === today ? 'today' : ''].filter(Boolean).join(' ');
    const pct = future ? limit / top * 100 : m / top * 100;
    return el('span', { class: cls, style: `height:${pct.toFixed(1)}%`, title: `${fmtShort(d)} · ${future ? 'a trabalhar' : hours(m)}` });
  });
  const ruler = days.length > 1 ? el('div', { class: 'ruler' },
    el('div', { class: 'ruler-bars' }, el('span', { class: 'ruler-goal', style: `bottom:${(limit / top * 100).toFixed(1)}%` }), ...ticks),
    el('div', { class: 'ruler-days' }, ...days.map((d) => el('span', {}, Number(d.slice(8))))),
    el('span', { class: 'ruler-note' }, `Um traço por dia útil · tracejado = limite de ${hours(limit)}`)) : null;

  $('kpis').replaceChildren(
    el('div', { class: 'saldo' },
      el('div', { class: 'saldo-main' },
        el('span', { class: 'muted' }, 'Horas executadas'),
        el('div', { class: 'saldo-fig' }, el('strong', {}, hours(k.executedMin)), el('span', {}, `de ${hours(k.expectedMin)}`)),
        el('span', { class: `saldo-bal ${balanceCls}`, title: 'Previstas − executadas' }, balance)),
      ruler),
    el('div', { class: 'kpi-stats' },
      card('Dias úteis no período', String(k.businessDays)),
      card('Dias trabalhados', String(k.worked), '', 'Dias úteis com pelo menos uma batida'),
      card('Dias a trabalhar', String(k.toWork), '', 'Dias úteis de hoje até o fim do período ainda sem batida'),
      card('Horas previstas', hours(k.expectedMin), '', `${k.businessDays} dias × ${hours(limit)}`)),
  );
}

// ---------- UST do período (catálogo de UST + Item do Catálogo e Tamanho das tarefas) ----------
let ustSeq = 0;
let ustKey = '';
const fmtUst = (n) => String(n).replace('.', ',');

async function loadUst(force = false) {
  if (!lastShown) return;
  const key = `${lastShown.from}|${lastShown.to}`;
  if (key === ustKey && !force) return;
  ustKey = key;
  const seq = ++ustSeq;
  $('ustKpis').replaceChildren(el('p', { class: 'muted' }, 'Calculando UST…'));
  $('ustInfo').replaceChildren();
  try {
    const r = await api(`/api/worklog/ust?from=${lastShown.from}&to=${lastShown.to}`);
    if (seq === ustSeq) renderUst(r);
  } catch (e) {
    if (seq === ustSeq) { ustKey = ''; $('ustKpis').replaceChildren(); $('ustInfo').replaceChildren(el('span', { class: 'bad' }, `UST: ${e.message}`)); }
  }
}

function renderUst(r) {
  const card = (label, value, title) => el('div', { class: 'kpi', title }, el('strong', {}, value), el('span', {}, label));
  if (r.error) {
    $('ustKpis').replaceChildren();
    $('ustInfo').replaceChildren(el('span', {}, `UST: ${r.error}`), ' ', el('a', { href: 'catalogo.html' }, 'Catálogo de UST'));
    return;
  }
  $('ustKpis').replaceChildren(
    card('UST concluídas', fmtUst(r.concluded.ust), 'Tarefas suas que foram para Concluído no período'),
    card('UST em andamento', fmtUst(r.inProgress.ust), 'Tarefas abertas com horas suas no período'),
  );
  const table = (tasks) => el('table', { class: 'items small' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Tarefa'), el('th', {}, 'Status'), el('th', {}, 'CAT'), el('th', {}, 'Tamanho'), el('th', {}, 'UST'))),
    el('tbody', {}, ...tasks.map((t) => el('tr', {},
      el('td', { class: 'wrap', title: t.summary }, link(t.key, t.url), ` ${t.summary}`),
      el('td', {}, t.status), el('td', {}, t.cat),
      el('td', {}, t.hours !== undefined ? `Hora (${fmtUst(t.hours)} h)` : t.size),
      el('td', {}, fmtUst(t.ust))))));
  const group = (title, g) => (g.tasks.length ? el('details', {}, el('summary', {}, `${title}: ${g.tasks.length} tarefa(s), ${fmtUst(g.ust)} UST`), table(g.tasks)) : null);
  $('ustInfo').replaceChildren(...[
    group('Concluídas', r.concluded),
    group('Em andamento', r.inProgress),
    r.problems.length ? el('details', {}, el('summary', { class: 'bad' }, `${r.problems.length} tarefa(s) sem UST calculada`),
      el('ul', {}, ...r.problems.map((p) => el('li', {}, link(p.key, p.url), ` ${p.summary} — ${p.problem}`)))) : null,
    !r.concluded.tasks.length && !r.inProgress.tasks.length && !r.problems.length ? el('span', { class: 'muted' }, 'Nenhuma tarefa com Item do Catálogo no período.') : null,
  ].filter(Boolean));
}

function setupCalendar() {
  calendar = createCalendar({
    els: { body: $('calBody'), label: $('calLabel'), error: $('calError'), prev: $('calPrev'), next: $('calNext'), today: $('calToday'), use: $('calUse'), showWeekends: $('calWeekends'), showHolidays: $('calHolidays'), closingOpts: $('calClosingOpts'), closeStart: $('calCloseStart'), closeEnd: $('calCloseEnd'), views: [...document.querySelectorAll('#calPanel [data-view]')] },
    getLimit: dailyLimit,
    getPeriod: () => ({ from: sel.from, to: sel.to }),
    onChange: (shown) => { lastShown = shown; renderKpis(); loadUst(); },
    // Shift+clique: marca/estende o período. Botão "Apontar no período exibido": abre Apontar horas.
    onPick: (date, extend, to) => {
      if (to) { location.assign(apontarUrl(date, to)); return; }
      if (!extend || !sel.from) { sel.from = date; sel.to = date; } else if (date < sel.from) sel.from = date; else sel.to = date;
      renderSel();
    },
    onOpenDay: (date, entries) => openDay(date, entries),
  });
}

// Cada abertura do painel ganha um número: um novo apontamento que termina depois de o painel ser
// fechado ou trocado de dia não reabre o dia antigo por cima.
let panelSeq = 0;
function openDay(date, entries, notice = '') {
  const seq = ++panelSeq;
  openDayPanel({
    dialog: $('dayPanel'),
    date,
    entries,
    tasks,
    epics,
    catalog,
    limit: dailyLimit(),
    notice,
    onSaved: () => { calendar.reload(); },
    onUsePeriod: (d) => location.assign(apontarUrl(d, d)),
    // Novo apontamento: recarrega calendário e tarefas; com a batida gravada, reabre o painel do dia.
    onCreated: async ({ reopen, notice: text } = {}) => {
      await Promise.all([calendar.reload(), loadTasks()]);
      if (reopen && seq === panelSeq && $('dayPanel').open) openDay(date, calendar.entriesOf(date), text);
    },
  });
}

async function init() {
  const config = await api('/api/config').catch(() => ({}));
  $('baseUrl').textContent = config.baseUrl ?? '';
  $('user').textContent = config.email ?? '';
  $('tokenBadge').textContent = config.tokenConfigured ? 'Token OK' : 'Token ausente';
  $('tokenBadge').className = 'badge ' + (config.tokenConfigured ? 'ok' : 'bad');
  $('tokenBanner').hidden = Boolean(config.tokenConfigured);
  setupCalendar();
  $('selGo').addEventListener('click', () => { if (sel.from) location.assign(apontarUrl(sel.from, sel.to)); });
  $('selClear').addEventListener('click', () => { sel.from = ''; sel.to = ''; renderSel(); calendar.render(); });
  if (config.tokenConfigured) await Promise.all([loadTasks(), loadCatalog(), calendar.load()]);
}

init();
