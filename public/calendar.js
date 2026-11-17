// Calendário "Meus apontamentos" (Dia / Semana / Mês / Fechamento) da tela Apontar horas.
// Mostra os worklogs do usuário (os mesmos do My Work Overview do Clockwork), o total de cada
// dia comparado à meta e, por padrão, só os dias úteis (fins de semana e feriados são opcionais).
// Clique num dia abre o painel de batidas; Shift+clique estende o período do apontamento.
import { addDays, weekRange, monthGrid, closingPeriod, formatDuration, hhmmToMin, minToHhmm } from '/lib/time.js';

const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DAY_START = 7 * 60; // régua da semana: 07:00–19:00
const DAY_END = 19 * 60;
const OPTS_KEY = 'apontar.calendar';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const weekdayIdx = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = segunda
const isWeekend = (date) => weekdayIdx(date) >= 5;
const fmtDate = (date) => date.split('-').reverse().join('/');

const DEFAULT_OPTS = { showWeekends: false, showHolidays: false, closingStart: 21, closingEnd: 20 };
const validDay = (n) => Number.isInteger(n) && n >= 1 && n <= 31;
function loadOpts() {
  try {
    const o = { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') };
    if (!validDay(o.closingStart)) o.closingStart = DEFAULT_OPTS.closingStart;
    if (!validDay(o.closingEnd)) o.closingEnd = DEFAULT_OPTS.closingEnd;
    return o;
  } catch { return { ...DEFAULT_OPTS }; }
}
function saveOpts(o) { try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch { /* sem storage */ } }

// onChange({ from, to, entries, holidays }) é chamado a cada render com dados carregados:
// período inteiro da visão (semana de segunda a domingo), batidas e feriados (Set de datas).
export function createCalendar({ els, getLimit, getPeriod, onPick, onOpenDay, onChange = () => {} }) {
  const st = { view: 'month', anchor: todayIso(), closingRef: '', entries: [], loadedKey: '', loading: false, opts: loadOpts(), holidays: new Map(), holidayYears: new Set() };
  els.showWeekends.checked = st.opts.showWeekends;
  els.showHolidays.checked = st.opts.showHolidays;
  els.closeStart.value = st.opts.closingStart;
  els.closeEnd.value = st.opts.closingEnd;

  // Fechamento de referência (AAAA-MM): do dia inicial do mês anterior ao dia final deste mês.
  const closingOf = (ref) => { const [y, m] = ref.split('-').map(Number); return closingPeriod(y, m, st.opts.closingStart, st.opts.closingEnd); };
  const shiftMonth = (ref, n) => { const [y, m] = ref.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
  // Fechamento que contém a data; se ela já passou do dia final, é o do mês seguinte.
  function closingRefFor(date) {
    const ref = date.slice(0, 7);
    return date > closingOf(ref).to ? shiftMonth(ref, 1) : ref;
  }

  const holidayName = (date) => st.holidays.get(date);
  // Dia visível: fim de semana só com a opção; feriado só com a opção (fim de semana prevalece).
  const visible = (date) => (isWeekend(date) ? st.opts.showWeekends : true) && (holidayName(date) ? st.opts.showHolidays : true);

  async function ensureHolidays(from, to) {
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      if (st.holidayYears.has(y)) continue;
      const res = await fetch(`/api/holidays?from=${y}-01-01&to=${y}-12-31`);
      if (!res.ok) continue;
      for (const h of (await res.json()).holidays) st.holidays.set(h.date, h.name);
      st.holidayYears.add(y);
    }
  }

  function range() {
    if (st.view === 'day') return { from: st.anchor, to: st.anchor };
    if (st.view === 'closing') return closingOf(st.closingRef);
    if (st.view === 'week') return weekRange(st.anchor);
    const [y, m] = st.anchor.split('-').map(Number);
    const g = monthGrid(y, m);
    return { from: g[0], to: g[41] };
  }

  function label() {
    const [y, m] = st.anchor.split('-').map(Number);
    if (st.view === 'month') return `${MONTHS[m - 1]} de ${y}`;
    if (st.view === 'closing') {
      const [cy, cm] = st.closingRef.split('-').map(Number);
      const p = closingOf(st.closingRef);
      return `Fechamento de ${MONTHS[cm - 1]} de ${cy} (${fmtDate(p.from).slice(0, 5)} a ${fmtDate(p.to).slice(0, 5)})`;
    }
    if (st.view === 'week') { const r = weekRange(st.anchor); return `${fmtDate(r.from)} a ${fmtDate(r.to)}`; }
    const h = holidayName(st.anchor);
    return `${WEEKDAYS[weekdayIdx(st.anchor)]}, ${fmtDate(st.anchor)}${h ? ` — ${h}` : ''}`;
  }

  const byDay = () => {
    const map = new Map();
    for (const e of st.entries) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  };

  function statusOf(date, total) {
    if (holidayName(date) || isWeekend(date)) return total > getLimit() ? 'over' : '';
    const limit = getLimit();
    if (total > limit) return 'over';
    if (total > 0 && total === limit) return 'ok';
    if (date <= todayIso() && limit) return total ? 'under' : 'under empty';
    return '';
  }

  function inPeriod(date) {
    const { from, to } = getPeriod();
    return from && to && date >= from && date <= to;
  }

  function clickHandler(date) {
    return (ev) => {
      ev.preventDefault();
      if (ev.shiftKey) { onPick(date, true); render(); return; }
      st.anchor = date;
      load();
      onOpenDay(date, byDay().get(date) ?? []);
    };
  }

  const columns = () => (st.opts.showWeekends ? WEEKDAYS : WEEKDAYS.slice(0, 5));

  // Mês: grade de 6 semanas do mês. Fechamento: semanas que cobrem o período; o resto fica esmaecido.
  function gridDates() {
    if (st.view === 'closing') {
      const p = closingOf(st.closingRef);
      const end = weekRange(p.to).to;
      const out = [];
      for (let d = weekRange(p.from).from; d <= end; d = addDays(d, 1)) out.push(d);
      return { dates: out, inside: (d) => d >= p.from && d <= p.to };
    }
    const [y, m] = st.anchor.split('-').map(Number);
    const month = st.anchor.slice(0, 7);
    return { dates: monthGrid(y, m), inside: (d) => d.slice(0, 7) === month };
  }

  function renderMonth(days) {
    const cols = columns();
    const grid = el('div', { class: 'cal-month', style: `grid-template-columns:repeat(${cols.length},minmax(0,1fr))` }, ...cols.map((d) => el('div', { class: 'cal-head' }, d)));
    const { dates, inside } = gridDates();
    for (const date of dates) {
      if (isWeekend(date) && !st.opts.showWeekends) continue;
      const hol = holidayName(date);
      if (hol && !st.opts.showHolidays) {
        grid.append(el('div', { class: `cal-day holiday-hidden${!inside(date) ? ' out' : ''}`, title: `${fmtDate(date)} — ${hol}` }, el('span', { class: 'cal-num' }, Number(date.slice(8))), el('span', { class: 'cal-hol' }, hol)));
        continue;
      }
      const list = days.get(date) ?? [];
      const total = list.reduce((s, e) => s + e.minutes, 0);
      const cell = el('button', {
        class: ['cal-day', !inside(date) ? 'out' : '', isWeekend(date) ? 'weekend' : '', hol ? 'holiday' : '', date === todayIso() ? 'today' : '', inPeriod(date) ? 'in-period' : '', statusOf(date, total)].filter(Boolean).join(' '),
        title: `${fmtDate(date)}${hol ? ` — ${hol}` : ''} — ${total ? formatDuration(total) : 'sem apontamentos'}. Clique para ver as batidas; Shift+clique estende o período.`,
      },
      el('span', { class: 'cal-num' }, Number(date.slice(8))),
      hol ? el('span', { class: 'cal-hol' }, hol) : null,
      total ? el('span', { class: 'cal-total' }, formatDuration(total)) : null,
      ...list.slice(0, 3).map((e) => el('span', { class: 'cal-chip' }, `${e.issueKey} · ${formatDuration(e.minutes)}`)),
      list.length > 3 ? el('span', { class: 'cal-more' }, `+${list.length - 3}`) : null);
      cell.addEventListener('click', clickHandler(date));
      grid.append(cell);
    }
    return grid;
  }

  function renderWeek(days) {
    const { from } = weekRange(st.anchor);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i)).filter((d) => !isWeekend(d) || st.opts.showWeekends);
    const span = DAY_END - DAY_START;
    const axis = el('div', { class: 'cal-axis' }, ...Array.from({ length: (span / 60) + 1 }, (_, i) => el('span', { style: `top:${(i * 60 / span) * 100}%` }, minToHhmm(DAY_START + i * 60))));
    const tracks = ['48px'];
    const cols = dates.map((date) => {
      const hol = holidayName(date);
      if (hol && !st.opts.showHolidays) {
        tracks.push('minmax(44px,.35fr)');
        return el('div', { class: 'cal-wcol hidden-holiday', title: `${fmtDate(date)} — ${hol}` }, el('div', { class: 'cal-whead' }, el('span', {}, `${date.slice(8)}/${date.slice(5, 7)}`)), el('div', { class: 'cal-wbody holiday-strip' }, el('span', {}, hol)));
      }
      tracks.push('minmax(110px,1fr)');
      const list = days.get(date) ?? [];
      const total = list.reduce((s, e) => s + e.minutes, 0);
      const head = el('button', { class: ['cal-whead', isWeekend(date) ? 'weekend' : '', hol ? 'holiday' : '', inPeriod(date) ? 'in-period' : '', statusOf(date, total)].filter(Boolean).join(' ') },
        el('span', {}, `${WEEKDAYS[weekdayIdx(date)]} ${date.slice(8)}/${date.slice(5, 7)}${hol ? ` · ${hol}` : ''}`),
        el('strong', {}, total ? formatDuration(total) : '—'));
      head.addEventListener('click', clickHandler(date));
      const body = el('div', { class: `cal-wbody${isWeekend(date) || hol ? ' weekend' : ''}` }, ...list.map((e) => {
        const s = Math.max(hhmmToMin(e.start), DAY_START);
        const end = Math.min(hhmmToMin(e.start) + e.minutes, DAY_END);
        if (end <= s) return null;
        return el('a', { class: 'cal-block', href: e.url, target: '_blank', rel: 'noopener', style: `top:${((s - DAY_START) / span) * 100}%;height:${((end - s) / span) * 100}%`, title: `${e.start}–${minToHhmm(hhmmToMin(e.start) + e.minutes)} ${e.issueKey} ${e.issueSummary}\n${e.comment}` },
          el('strong', {}, e.issueKey), ` ${formatDuration(e.minutes)}`);
      }));
      body.addEventListener('dblclick', clickHandler(date));
      return el('div', { class: 'cal-wcol' }, head, body);
    });
    const week = el('div', { class: 'cal-week', style: `grid-template-columns:${tracks.join(' ')}` }, el('div', { class: 'cal-wcol axis' }, el('div', { class: 'cal-whead' }), axis), ...cols);
    return el('div', { class: 'cal-week-wrap' }, week);
  }

  function renderDay(days) {
    const list = days.get(st.anchor) ?? [];
    const total = list.reduce((s, e) => s + e.minutes, 0);
    const head = el('div', { class: `cal-dayhead ${statusOf(st.anchor, total)}` }, `Total do dia: ${total ? formatDuration(total) : '0'} (meta ${formatDuration(getLimit())})`);
    const open = el('button', {}, 'Editar batidas deste dia');
    open.addEventListener('click', () => onOpenDay(st.anchor, list));
    if (!list.length) return el('div', {}, head, el('p', { class: 'muted' }, 'Nenhum apontamento neste dia.'));
    return el('div', {}, el('div', { class: 'actions' }, head, open), el('div', { class: 'grid-wrap' }, el('table', { class: 'items' },
      el('thead', {}, el('tr', {}, ...['Horário', 'Tarefa', 'Resumo', 'Duração', 'Comentário'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...list.map((e) => el('tr', {},
        el('td', { class: 'nowrap' }, `${e.start}–${minToHhmm(hhmmToMin(e.start) + e.minutes)}`),
        el('td', {}, el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.issueKey)),
        el('td', { class: 'wrap' }, e.issueSummary),
        el('td', {}, formatDuration(e.minutes)),
        el('td', { class: 'wrap' }, e.comment)))))));
  }

  function render() {
    els.label.textContent = label();
    els.views.forEach((b) => b.classList.toggle('active', b.dataset.view === st.view));
    const days = byDay();
    const body = st.view === 'month' || st.view === 'closing' ? renderMonth(days) : st.view === 'week' ? renderWeek(days) : renderDay(days);
    els.body.replaceChildren(body);
    els.closingOpts.hidden = st.view !== 'closing';
    if (st.loading) els.body.prepend(el('p', { class: 'muted' }, 'Carregando apontamentos…'));
    else if (st.loadedKey === rangeKey()) onChange({ ...fullPeriod(), entries: st.entries, holidays: new Set(st.holidays.keys()) });
  }

  const rangeKey = () => { const r = range(); return `${r.from}|${r.to}`; };

  // Período inteiro da visão, para os indicadores (a semana vai de segunda a domingo).
  const fullPeriod = () => (st.view === 'week' ? weekRange(st.anchor) : shownPeriod());

  async function load(force = false) {
    const { from, to } = range();
    const key = rangeKey();
    if (!force && key === st.loadedKey) return render();
    st.loading = true;
    render();
    els.error.hidden = true;
    try {
      const [res] = await Promise.all([fetch(`/api/worklog/calendar?from=${from}&to=${to}`), ensureHolidays(from, to)]);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      st.entries = json.entries;
      st.loadedKey = key;
    } catch (e) {
      els.error.textContent = `Não foi possível carregar os apontamentos: ${e.message}`;
      els.error.hidden = false;
    } finally {
      st.loading = false;
      render();
    }
  }

  async function move(dir) {
    if (st.view === 'day') {
      let d = st.anchor;
      for (let i = 0; i < 60; i++) {
        d = addDays(d, dir);
        await ensureHolidays(d, d);
        if (visible(d)) break;
      }
      st.anchor = d;
    } else if (st.view === 'week') st.anchor = addDays(st.anchor, 7 * dir);
    else if (st.view === 'closing') st.closingRef = shiftMonth(st.closingRef, dir);
    else {
      const [y, m] = st.anchor.split('-').map(Number);
      st.anchor = new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
    }
    load();
  }

  // Período exibido em dias úteis: semana → segunda a sexta; mês → 1º ao último dia; fechamento → início a fim.
  function shownPeriod() {
    if (st.view === 'day') return { from: st.anchor, to: st.anchor };
    if (st.view === 'closing') return closingOf(st.closingRef);
    if (st.view === 'week') { const r = weekRange(st.anchor); return { from: r.from, to: addDays(r.from, 4) }; }
    const [y, m] = st.anchor.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: `${st.anchor.slice(0, 7)}-01`, to: last };
  }

  els.prev.addEventListener('click', () => move(-1));
  els.next.addEventListener('click', () => move(1));
  els.today.addEventListener('click', () => { st.anchor = todayIso(); st.closingRef = closingRefFor(st.anchor); load(); });
  els.views.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === 'closing' && st.view !== 'closing') st.closingRef = closingRefFor(st.anchor);
    st.view = b.dataset.view;
    load();
  }));
  const onClosingDays = () => {
    const a = Number(els.closeStart.value);
    const b = Number(els.closeEnd.value);
    els.closeStart.classList.toggle('invalid', !validDay(a));
    els.closeEnd.classList.toggle('invalid', !validDay(b));
    if (!validDay(a) || !validDay(b)) return;
    st.opts.closingStart = a;
    st.opts.closingEnd = b;
    saveOpts(st.opts);
    load();
  };
  els.closeStart.addEventListener('change', onClosingDays);
  els.closeEnd.addEventListener('change', onClosingDays);
  els.use.addEventListener('click', () => { const p = shownPeriod(); onPick(p.from, false, p.to); render(); });
  els.showWeekends.addEventListener('change', () => { st.opts.showWeekends = els.showWeekends.checked; saveOpts(st.opts); render(); });
  els.showHolidays.addEventListener('change', () => { st.opts.showHolidays = els.showHolidays.checked; saveOpts(st.opts); render(); });

  return { load, reload: () => load(true), render, entriesOf: (date) => byDay().get(date) ?? [] };
}
