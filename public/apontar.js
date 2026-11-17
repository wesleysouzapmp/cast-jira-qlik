// Tela "Apontar horas": monta as horas por tarefa, gera a prévia das batidas no servidor,
// permite editar comentários e grava os worklogs. Texto do Jira/IA entra só por textContent.
import { parseDuration, formatDuration, splitTotal, periodIndicators, businessDays, DEFAULT_SCHEDULE } from '/lib/time.js';
import { createCalendar } from './calendar.js';
import { openDayPanel } from './daypanel.js';
import { setupAuto } from './auto.js';

const $ = (id) => document.getElementById(id);
const MODEL_LABEL = { analise: 'Análise', implementacao: 'Implementação', avulsa: 'Avulsa' };
const STORE_KEY = 'apontar.schedule';
const state = { epics: [], aiEnabled: false, entries: [], ui: new Map(), busy: false, loose: [], looseUi: { hours: {}, checked: {}, perDay: {} } };

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

function showError(msg) {
  $('errorBox').textContent = msg ?? '';
  $('errorBox').hidden = !msg;
}

// ---------- período e expediente ----------
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function thisWeek() {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const friday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4);
  return [isoLocal(monday), isoLocal(friday)];
}

function loadSchedule() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {}; } catch { /* sem storage */ }
  const s = { ...DEFAULT_SCHEDULE, ...saved };
  for (const k of ['start', 'lunchStart', 'lunchEnd', 'end']) $(k).value = s[k];
  $('dailyLimit').value = formatDuration(s.dailyLimit);
  const [from, to] = thisWeek();
  $('from').value = from;
  $('to').value = to;
}

function readSchedule() {
  const dailyLimit = parseDuration($('dailyLimit').value);
  if (!dailyLimit) throw new Error('Limite por dia inválido (ex.: 8h).');
  const s = { start: $('start').value, lunchStart: $('lunchStart').value, lunchEnd: $('lunchEnd').value, end: $('end').value, dailyLimit };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* sem storage */ }
  return s;
}

// ---------- seleção de horas ----------
// Feriados do período do passo 2, para estimar as horas "por dia útil".
const hol = { key: '', set: new Set() };
async function refreshHolidays() {
  const from = $('from').value;
  const to = $('to').value;
  const key = `${from}|${to}`;
  if (!from || !to || to < from || key === hol.key) return;
  try {
    const res = await fetch(`/api/holidays?from=${from}&to=${to}`);
    if (!res.ok) return;
    hol.set = new Set((await res.json()).holidays.map((h) => h.date));
    hol.key = key;
    renderEpics();
  } catch { /* estimativa sem feriados */ }
}
function periodBusinessDays() {
  const from = $('from').value;
  const to = $('to').value;
  return from && to && to >= from ? businessDays(from, to, hol.key === `${from}|${to}` ? hol.set : new Set()).length : 0;
}

// Marcar, horas, modo (no total / por dia útil) e estimativa de uma tarefa.
function hoursControls(ui, key) {
  const check = el('input', { type: 'checkbox', checked: Boolean(ui.checked[key]) });
  const hours = el('input', { value: ui.hours[key] ?? '', placeholder: 'ex.: 1h 30m', class: 'short', id: `hours-${key}` });
  const mode = el('select', { title: 'No total: as horas são distribuídas no período. Por dia útil: as horas se repetem em cada dia útil.' },
    el('option', { value: 'total' }, 'no total'), el('option', { value: 'day' }, 'por dia útil'));
  mode.value = ui.perDay[key] ? 'day' : 'total';
  const est = el('span', { class: 'muted' });
  const estimate = () => {
    const m = parseDuration(hours.value);
    const n = periodBusinessDays();
    est.textContent = ui.perDay[key] && m ? `${formatDuration(m)} × ${n} dia(s) útil(eis) ≈ ${formatDuration(m * n) || '0'}` : '';
  };
  check.addEventListener('change', () => { ui.checked[key] = check.checked; });
  hours.addEventListener('input', () => { ui.hours[key] = hours.value; if (hours.value) { ui.checked[key] = true; check.checked = true; } estimate(); });
  mode.addEventListener('change', () => { ui.perDay[key] = mode.value === 'day'; estimate(); });
  estimate();
  return { check, rest: [hours, mode, est] };
}

function renderEpics() {
  renderLoose();
  const box = $('epics');
  if (!state.epics.length) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Nenhum épico em aberto com tarefas de apoio. Crie as tarefas na página “Tarefas de apoio”.'));
    return;
  }
  box.replaceChildren(...state.epics.map((e) => {
    const ui = state.ui.get(e.key) ?? { split: false, total: '', pct: 30, hours: {}, checked: {}, perDay: {} };
    state.ui.set(e.key, ui);
    const head = el('div', { class: 'ep-row' },
      el('strong', {}, link(e.key, e.url), ` - ${e.summary}`),
      el('span', { class: 'badge' }, e.status));
    const splitBox = el('input', { type: 'checkbox', checked: ui.split, disabled: e.tasks.length < 2 });
    splitBox.addEventListener('change', () => { ui.split = splitBox.checked; renderEpics(); });

    let body;
    if (ui.split) {
      const total = el('input', { value: ui.total, placeholder: 'ex.: 4h', class: 'short' });
      const pct = el('input', { type: 'number', min: 0, max: 100, step: 5, value: ui.pct, class: 'short' });
      const info = el('span', { class: 'muted' });
      const update = () => {
        ui.total = total.value; ui.pct = Number(pct.value);
        const t = parseDuration(total.value);
        if (!t) { info.textContent = total.value ? 'total inválido' : ''; return; }
        const p = Math.min(Math.max(Number(pct.value) || 0, 0), 100);
        const r = splitTotal(t, p);
        info.textContent = `Análise ${formatDuration(r.analise || 0)} · Implementação ${formatDuration(r.implementacao || 0)}`;
      };
      total.addEventListener('input', update);
      pct.addEventListener('input', update);
      update();
      body = el('div', { class: 'task-row' }, el('label', { class: 'inline' }, 'Total', total), el('label', { class: 'inline' }, '% Análise', pct), info);
    } else {
      body = el('div', {}, ...e.tasks.map((t) => {
        const c = hoursControls(ui, t.key);
        return el('div', { class: 'task-row' },
          c.check,
          el('span', { class: 'task-name' }, link(t.key, t.url), ` ${MODEL_LABEL[t.model]}`),
          el('span', { class: 'badge' }, t.status),
          el('span', { class: 'muted' }, `apontado: ${t.timeSpentMin ? formatDuration(t.timeSpentMin) : '0'}`),
          ...c.rest);
      }));
    }
    return el('div', { class: 'epic-block' }, head, el('label', { class: 'inline' }, splitBox, 'Dividir total entre as tarefas'), body);
  }));
}

function readItems() {
  const items = [];
  for (const e of state.epics) {
    const ui = state.ui.get(e.key);
    if (ui.split) {
      if (!ui.total) continue;
      const t = parseDuration(ui.total);
      if (!t) throw new Error(`${e.key}: total de horas inválido.`);
      const r = splitTotal(t, Math.min(Math.max(Number(ui.pct) || 0, 0), 100));
      const byModel = Object.fromEntries(e.tasks.map((x) => [x.model, x.key]));
      if (r.analise && byModel.analise) items.push({ taskKey: byModel.analise, minutes: r.analise });
      if (r.implementacao && byModel.implementacao) items.push({ taskKey: byModel.implementacao, minutes: r.implementacao });
    } else {
      for (const t of e.tasks) {
        if (!ui.checked[t.key]) continue;
        const m = parseDuration(ui.hours[t.key]);
        if (!m) throw new Error(`${t.key}: informe as horas (ex.: 1h 30m).`);
        if (ui.perDay[t.key] && m > 480) throw new Error(`${t.key}: no máximo 8h por dia útil.`);
        items.push({ taskKey: t.key, minutes: m, ...(ui.perDay[t.key] ? { perDay: true } : {}) });
      }
    }
  }
  const lu = state.looseUi;
  for (const t of state.loose) {
    if (!lu.checked[t.key]) continue;
    if (!t.available) throw new Error(`${t.key}: ${t.error}`);
    const m = parseDuration(lu.hours[t.key]);
    if (!m) throw new Error(`${t.key}: informe as horas (ex.: 1h 30m).`);
    if (lu.perDay[t.key] && m > 480) throw new Error(`${t.key}: no máximo 8h por dia útil.`);
    items.push({ taskKey: t.key, minutes: m, ...(lu.perDay[t.key] ? { perDay: true } : {}) });
  }
  if (!items.length) throw new Error('Marque ao menos uma tarefa e informe as horas.');
  return items;
}

// ---------- prévia ----------
function taskInfo(key) {
  for (const e of state.epics) for (const t of e.tasks) if (t.key === key) return { task: t, epic: e };
  const l = state.loose.find((t) => t.key === key);
  if (l) return { task: { ...l, model: 'avulsa' }, epic: null };
  return null;
}

function renderPreview(extra = {}) {
  $('previewPanel').hidden = false;
  $('btnAi').hidden = !state.aiEnabled;
  const totals = new Map();
  for (const x of state.entries) totals.set(x.taskKey, (totals.get(x.taskKey) ?? 0) + x.minutes);
  $('summary').textContent = state.entries.length
    ? `${state.entries.length} lançamento(s): ` + [...totals].map(([k, m]) => `${k} ${formatDuration(m)}`).join(' · ')
    : 'Nenhum lançamento na prévia.';
  if (extra.unallocated !== undefined) {
    $('unallocated').hidden = !extra.unallocated.length;
    $('unallocated').textContent = extra.unallocated.length
      ? 'Sem horário livre no período para: ' + extra.unallocated.map((u) => (u.date ? `${u.taskKey} faltaram ${formatDuration(u.minutes)} em ${u.date.split('-').reverse().join('/')}` : `${u.taskKey} ${formatDuration(u.minutes)}`)).join(', ') + '. Aumente o período ou o expediente, ou ajuste as batidas desses dias.'
      : '';
  }
  if (extra.transitions !== undefined) {
    $('transitions').textContent = extra.transitions.length
      ? 'Mudança de status ao confirmar: ' + extra.transitions.map((t) => `${t.key}: ${t.from} → ${t.to}`).join(' · ')
      : 'Nenhuma mudança de status prevista.';
  }
  $('previewRows').replaceChildren(...state.entries.map((x, i) => {
    const info = taskInfo(x.taskKey);
    const comment = el('input', { value: x.comment ?? '', maxLength: 1000, class: 'comment', disabled: state.busy || x.result });
    comment.addEventListener('input', () => { x.comment = comment.value; });
    const remove = el('button', { class: 'link', disabled: state.busy || Boolean(x.result), title: 'Remover lançamento' }, 'remover');
    remove.addEventListener('click', () => { state.entries.splice(i, 1); renderPreview(); });
    const result = x.result
      ? (x.result.status === 'created' ? el('span', { class: 'ok' }, 'gravado') : el('span', { class: 'bad' }, `erro — ${x.result.error}`))
      : '';
    return el('tr', {},
      el('td', {}, info ? link(x.taskKey, info.task.url) : x.taskKey, info ? ` ${MODEL_LABEL[info.task.model]}` : ''),
      el('td', {}, x.date.split('-').reverse().join('/')),
      el('td', {}, x.start),
      el('td', {}, formatDuration(x.minutes)),
      el('td', { class: 'wrap' }, comment),
      el('td', {}, remove),
      el('td', { class: 'wrap' }, result));
  }));
  $('btnSubmit').disabled = state.busy || !state.entries.some((x) => !x.result);
  $('btnAi').disabled = state.busy || !state.entries.length;
}

function setBusy(b) {
  state.busy = b;
  $('btnPreview').disabled = b;
  if (!$('previewPanel').hidden) renderPreview();
}

async function preview() {
  showError('');
  let body;
  try { body = { items: readItems(), from: $('from').value, to: $('to').value, schedule: readSchedule() }; } catch (e) { return showError(e.message); }
  setBusy(true);
  try {
    const r = await api('/api/worklog/preview', body);
    state.entries = r.entries.map((x) => ({ ...x }));
    state.busy = false;
    renderPreview({ unallocated: r.unallocated, transitions: r.transitions });
  } catch (e) {
    showError(`Não foi possível gerar a prévia: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function aiComments() {
  showError('');
  setBusy(true);
  try {
    const pending = state.entries.filter((x) => !x.result);
    const r = await api('/api/worklog/ai-comments', { entries: pending.map(({ taskKey, date, start, minutes, comment }) => ({ taskKey, date, start, minutes, comment })) });
    pending.forEach((x, i) => { x.comment = r.comments[i]; });
  } catch (e) {
    showError(`IA indisponível — mantidas as frases-modelo. ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function submit() {
  showError('');
  const pending = state.entries.filter((x) => !x.result);
  if (!pending.length) return;
  setBusy(true);
  try {
    const r = await api('/api/worklog/submit', { entries: pending.map(({ taskKey, date, start, minutes, comment }) => ({ taskKey, date, start, minutes, comment })) });
    r.results.forEach((res) => { pending[res.index].result = res; });
    // As horas já gravadas saem dos campos: gerar nova prévia (para refazer o que falhou)
    // não pode apontar de novo o que já está no Jira.
    const savedTasks = new Set(r.results.filter((x) => x.status === 'created').map((x) => pending[x.index].taskKey));
    for (const e of state.epics) {
      const ui = state.ui.get(e.key);
      if (!ui || !e.tasks.some((t) => savedTasks.has(t.key))) continue;
      if (ui.split) ui.total = '';
      for (const t of e.tasks) if (savedTasks.has(t.key)) { ui.hours[t.key] = ''; ui.checked[t.key] = false; }
    }
    const moved = r.transitions.filter((t) => t.status === 'moved').map((t) => `${t.key}: ${t.from} → ${t.to}`);
    const failed = r.transitions.filter((t) => t.status === 'error').map((t) => `${t.key}: ${t.error}`);
    $('transitions').textContent = [moved.length ? `Status alterado: ${moved.join(' · ')}` : 'Nenhum status alterado.', failed.length ? `Falha ao mudar status: ${failed.join(' · ')}` : ''].filter(Boolean).join(' ');
    const errors = r.results.filter((x) => x.status === 'error').length;
    if (errors) showError(`${errors} lançamento(s) não foram gravados. Veja a coluna Resultado. As horas já gravadas foram retiradas dos campos; para refazer só o que falhou, informe essas horas e gere a prévia de novo.`);
    await loadTasks();
    calendar?.reload();
  } catch (e) {
    showError(e.status === 409 ? `${e.message}` : `Falha ao gravar: ${e.message}. Se foi falha de rede, confira no Jira antes de tentar de novo.`);
  } finally {
    setBusy(false);
  }
}

async function loadTasks() {
  try {
    const r = await api('/api/worklog/tasks');
    state.epics = r.epics.filter((e) => e.tasks.length);
    state.aiEnabled = r.aiEnabled;
  } catch (e) {
    state.epics = [];
    showError(`Não foi possível carregar as tarefas: ${e.message}`);
  }
  renderEpics();
}

// ---------- outras tarefas (avulsas) e favoritos ----------
function looseMsg(text, bad = false) {
  $('looseMsg').textContent = text;
  $('looseMsg').className = bad ? 'bad' : 'muted';
}

function renderLoose() {
  const box = $('looseList');
  if (!state.loose.length) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Nenhuma tarefa avulsa. Informe a chave acima; marque ★ para guardar nos favoritos.'));
    return;
  }
  box.replaceChildren(...state.loose.map((t) => {
    const c = hoursControls(state.looseUi, t.key);
    const star = el('button', { class: 'icon', title: t.favorite ? 'Tirar dos favoritos' : 'Guardar nos favoritos', 'aria-pressed': String(Boolean(t.favorite)) }, t.favorite ? '★' : '☆');
    star.addEventListener('click', () => toggleFavorite(t));
    const remove = el('button', { class: 'icon', title: 'Tirar da lista (não mexe nos favoritos)' }, '✕');
    remove.addEventListener('click', () => { state.loose = state.loose.filter((x) => x !== t); delete state.looseUi.checked[t.key]; renderLoose(); });
    if (!t.available) c.check.disabled = true;
    return el('div', { class: `task-row${t.available ? '' : ' unavailable'}` },
      c.check,
      el('span', { class: 'task-name' }, t.url ? link(t.key, t.url) : t.key, t.summary ? ` - ${t.summary}` : ''),
      t.status ? el('span', { class: 'badge' }, t.status) : null,
      ...(t.available ? c.rest : [el('span', { class: 'bad' }, t.error)]),
      star, remove);
  }));
}

async function addLoose() {
  const key = $('looseKey').value.trim().toUpperCase();
  if (!key) return;
  if (state.loose.some((t) => t.key === key)) { looseMsg(`${key} já está na lista.`); return; }
  if (state.epics.some((e) => e.tasks.some((t) => t.key === key))) { looseMsg(`${key} é uma tarefa de apoio; use a lista acima.`, true); return; }
  $('looseAdd').disabled = true;
  looseMsg('Consultando o Jira…');
  try {
    const { task } = await api(`/api/worklog/lookup?key=${encodeURIComponent(key)}`);
    if (!task.available) { looseMsg(task.error, true); return; }
    state.loose.push({ ...task, favorite: false });
    state.looseUi.checked[key] = true;
    $('looseKey').value = '';
    looseMsg('');
    renderLoose();
    document.getElementById(`hours-${key}`)?.focus();
  } catch (e) {
    looseMsg(e.message, true);
  } finally {
    $('looseAdd').disabled = false;
  }
}

async function toggleFavorite(t) {
  try {
    if (t.favorite) {
      const res = await fetch(`/api/worklog/favorites/${encodeURIComponent(t.key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    } else await api('/api/worklog/favorites', { key: t.key });
    t.favorite = !t.favorite;
    looseMsg(t.favorite ? `${t.key} guardada nos favoritos.` : `${t.key} saiu dos favoritos.`);
  } catch (e) {
    looseMsg(`Favoritos: ${e.message}`, true);
  }
  renderLoose();
}

async function loadFavorites() {
  try {
    const { favorites } = await api('/api/worklog/favorites');
    for (const f of favorites) if (!state.loose.some((t) => t.key === f.key)) state.loose.push({ ...f, favorite: true });
  } catch (e) {
    looseMsg(`Não foi possível carregar os favoritos: ${e.message}`, true);
  }
  renderLoose();
}

let calendar = null;
let lastShown = null;

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtShort = (date) => date.split('-').reverse().join('/');
const hours = (min) => (min ? formatDuration(min) : '0h');

// Faixa de indicadores do período exibido no calendário.
function renderKpis() {
  if (!lastShown) return;
  const dailyLimit = parseDuration($('dailyLimit').value) ?? DEFAULT_SCHEDULE.dailyLimit;
  const k = periodIndicators({ ...lastShown, today: todayLocal(), dailyLimit });
  const card = (label, value, cls = '', title = '') => {
    const div = document.createElement('div');
    div.className = `kpi ${cls}`.trim();
    if (title) div.title = title;
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    div.append(v, l);
    return div;
  };
  const balance = k.balanceMin > 0 ? `faltam ${hours(k.balanceMin)}` : k.balanceMin < 0 ? `excedeu ${hours(-k.balanceMin)}` : 'na meta';
  $('kpiPeriod').textContent = lastShown.from === lastShown.to ? fmtShort(lastShown.from) : `${fmtShort(lastShown.from)} a ${fmtShort(lastShown.to)}`;
  $('kpis').replaceChildren(
    card('Dias úteis no período', String(k.businessDays)),
    card('Dias trabalhados', String(k.worked), '', 'Dias úteis com pelo menos uma batida'),
    card('Dias a trabalhar', String(k.toWork), '', 'Dias úteis de hoje até o fim do período ainda sem batida'),
    card('Horas previstas', hours(k.expectedMin), '', `${k.businessDays} dias × ${hours(dailyLimit)}`),
    card('Horas executadas', hours(k.executedMin)),
    card('Saldo', balance, k.balanceMin > 0 ? 'under' : k.balanceMin < 0 ? 'over' : 'ok', 'Previstas − executadas'),
  );
}

function setupCalendar() {
  calendar = createCalendar({
    els: { body: $('calBody'), label: $('calLabel'), error: $('calError'), prev: $('calPrev'), next: $('calNext'), today: $('calToday'), use: $('calUse'), showWeekends: $('calWeekends'), showHolidays: $('calHolidays'), closingOpts: $('calClosingOpts'), closeStart: $('calCloseStart'), closeEnd: $('calCloseEnd'), views: [...document.querySelectorAll('#calPanel [data-view]')] },
    getLimit: () => parseDuration($('dailyLimit').value) ?? DEFAULT_SCHEDULE.dailyLimit,
    getPeriod: () => ({ from: $('from').value, to: $('to').value }),
    onChange: (shown) => { lastShown = shown; renderKpis(); },
    // Clique: o período vira o dia. Shift+clique: estende até o dia. Botão: período exibido.
    onPick: (date, extend, to) => {
      if (to) { $('from').value = date; $('to').value = to; } else if (!extend || !$('from').value) { $('from').value = date; $('to').value = date; } else if (date < $('from').value) $('from').value = date; else $('to').value = date;
      refreshHolidays();
      renderEpics();
    },
    onOpenDay: (date, entries) => openDayPanel({
      dialog: $('dayPanel'),
      date,
      entries,
      tasks: state.epics.flatMap((e) => e.tasks.map((t) => ({ key: t.key, model: t.model, epicKey: e.key }))),
      limit: parseDuration($('dailyLimit').value) ?? DEFAULT_SCHEDULE.dailyLimit,
      onSaved: () => { calendar.reload(); loadTasks(); },
      onUsePeriod: (d) => { $('from').value = d; $('to').value = d; calendar.render(); },
    }),
  });
  for (const id of ['from', 'to', 'dailyLimit']) $(id).addEventListener('input', () => calendar.render());
  for (const id of ['from', 'to']) $(id).addEventListener('change', () => { refreshHolidays(); renderEpics(); });
}

async function init() {
  const config = await api('/api/config').catch(() => ({}));
  $('baseUrl').textContent = config.baseUrl ?? '';
  $('user').textContent = config.email ?? '';
  $('tokenBadge').textContent = config.tokenConfigured ? 'Token OK' : 'Token ausente';
  $('tokenBadge').className = 'badge ' + (config.tokenConfigured ? 'ok' : 'bad');
  $('tokenBanner').hidden = Boolean(config.tokenConfigured);
  loadSchedule();
  $('btnPreview').addEventListener('click', preview);
  $('btnAi').addEventListener('click', aiComments);
  $('btnSubmit').addEventListener('click', submit);
  setupCalendar();
  $('looseAdd').addEventListener('click', addLoose);
  $('looseKey').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addLoose(); });
  window.addEventListener('auto-logged', () => calendar.reload());
  if (config.tokenConfigured) setupAuto();
  if (config.tokenConfigured) await Promise.all([loadTasks(), loadFavorites(), calendar.load()]);
}

init();
