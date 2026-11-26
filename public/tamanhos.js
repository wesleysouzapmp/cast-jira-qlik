// Tela "Tamanhos e UST": analisa o tamanho das tarefas frente às horas apontadas e troca o Item do
// Catálogo (CAT) e o Tamanho em lote, sempre pela escolha do usuário, com prévia e confirmação. Texto do Jira só por textContent.
import { closingPeriod } from '/lib/time.js';

const $ = (id) => document.getElementById(id);
const ALERT = { under: 'Subavaliação', over: 'Acima das horas' };
const state = { tasks: [], cats: [], picks: new Map(), catPicks: new Map(), checked: new Set(), results: new Map(), busy: false };

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
const fmt = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ','));

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function showError(msg) {
  $('errorBox').textContent = msg ?? '';
  $('errorBox').hidden = !msg;
}

// Fechamento atual (21 → 20) a partir de hoje.
function currentClosing() {
  const d = new Date();
  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  if (d.getDate() >= 21) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return closingPeriod(y, m, 21, 20);
}

// CAT e tamanho escolhidos na tela (padrão: os atuais da tarefa).
const catPick = (t) => state.catPicks.get(t.key) ?? t.cat ?? '';
const pickOf = (t) => state.picks.get(t.key) ?? t.size ?? '';
const catOptions = (cat) => state.cats.find((c) => c.cat === cat)?.options ?? [];
const optsFor = (t) => (catPick(t) === (t.cat ?? '') ? t.options : catOptions(catPick(t)));
const editable = (t) => state.cats.length > 0;
const changed = (t) => catPick(t) !== (t.cat ?? '') || pickOf(t) !== (t.size ?? '');
const valid = (t) => Boolean(catPick(t) && pickOf(t) && optsFor(t).some((o) => o.size === pickOf(t)));
// Só as linhas exibidas contam: o filtro "Só com alerta" tira as outras da troca.
const visible = () => state.tasks.filter((t) => !$('onlyAlerts').checked || t.alerts.length);
const marked = () => visible().filter((t) => state.checked.has(t.key) && changed(t));
const pending = () => marked().filter(valid);
// UST de um CAT + tamanho para a tarefa (itens por hora: UST × horas da tarefa).
const ustFor = (t, cat, size) => {
  const o = (cat === (t.cat ?? '') ? t.options : catOptions(cat)).find((x) => x.size === size);
  return o ? (size === 'Hora' ? Math.round(o.ust * t.hours * 100) / 100 : o.ust) : 0;
};
const catLabel = (c) => `${c.cat} · ${c.task}`;

function mark(t) { state.checked.add(t.key); }

function render() {
  const shown = visible();
  const noSize = state.tasks.filter((t) => !t.size).length;
  const withAlert = state.tasks.filter((t) => t.alerts.length).length;
  $('count').textContent = state.tasks.length ? `${shown.length} de ${state.tasks.length} tarefas · ${noSize} sem tamanho · ${withAlert} com alerta` : '';
  const maxHours = Math.max(1, ...shown.map((t) => t.hours || 0));
  if (!shown.length) {
    $('rows').replaceChildren(el('tr', {}, el('td', { colSpan: 9, class: 'muted' }, state.tasks.length ? 'Nenhuma tarefa com alerta.' : 'Nenhuma tarefa com Item do Catálogo no período.')));
  } else {
    $('rows').replaceChildren(...shown.map((t) => {
      const box = el('input', { type: 'checkbox', checked: state.checked.has(t.key), disabled: state.busy || !editable(t), 'aria-label': `Marcar ${t.key}` });
      box.addEventListener('change', () => { box.checked ? state.checked.add(t.key) : state.checked.delete(t.key); update(); });

      // CAT: todos os CATs do catálogo; o atual fora do catálogo ganha opção própria.
      const catSel = el('select', { disabled: state.busy || !state.cats.length, 'aria-label': `CAT de ${t.key}`, class: 'cat-select' },
        ...(state.cats.some((c) => c.cat === t.cat) ? [] : [el('option', { value: t.cat ?? '', selected: catPick(t) === (t.cat ?? '') }, `${t.cat ?? '—'} (atual)`)]),
        ...state.cats.map((c) => el('option', { value: c.cat, selected: c.cat === catPick(t), title: c.task }, catLabel(c))));
      catSel.addEventListener('change', () => {
        state.catPicks.set(t.key, catSel.value);
        // Tamanho que não existe no novo CAT: a pessoa precisa escolher outro.
        if (!optsFor(t).some((o) => o.size === pickOf(t))) state.picks.set(t.key, '');
        if (changed(t)) mark(t);
        render();
      });

      // Tamanho: opções do CAT escolhido; o atual (ou vazio) fora delas ganha opção própria.
      const opts = optsFor(t);
      const sameCat = catPick(t) === (t.cat ?? '');
      const sel = el('select', { disabled: state.busy || !opts.length, 'aria-label': `Novo tamanho de ${t.key}` },
        ...(opts.some((o) => o.size === pickOf(t)) ? [] : [el('option', { value: pickOf(t), selected: true }, sameCat ? `${pickOf(t) || '—'} (atual)` : 'escolha o tamanho')]),
        ...opts.map((o) => el('option', { value: o.size, selected: o.size === pickOf(t), title: o.description }, `${o.size} · ${fmt(o.ust)} UST — ${o.description}`)));
      sel.addEventListener('change', () => {
        state.picks.set(t.key, sel.value);
        if (changed(t)) { mark(t); box.checked = true; }
        update();
      });

      const r = state.results.get(t.key);
      const fromTo = (x) => `${x.fromCat && x.toCat && x.fromCat !== x.toCat ? `${x.fromCat} → ${x.toCat}, ` : ''}${x.from ?? '—'} → ${x.to}`;
      const result = !r ? '' : r.status === 'updated' ? el('span', { class: 'ok' }, `gravado ${fromTo(r)}`)
        : r.status === 'unchanged' ? el('span', { class: 'muted' }, 'sem mudança')
          : el('span', { class: 'bad' }, `${r.status === 'conflict' ? 'não gravado' : 'erro'} — ${r.error}`);
      return el('tr', {},
        el('td', {}, box),
        el('td', { class: 'wrap', title: t.summary }, link(t.key, t.url), ` ${t.summary}`),
        el('td', {}, t.status),
        el('td', {}, catSel),
        el('td', { class: 'hours-cell' }, el('span', { class: 'hours-num' }, `${fmt(t.hours)} h`), el('span', { class: 'hbar' }, el('span', { style: `width:${Math.round((t.hours || 0) / maxHours * 100)}%` }))),
        el('td', {}, t.size ? el('span', { class: 'size-tag' }, `${t.cat ?? '—'} ${t.size} · ${fmt(t.ust)} UST`) : el('span', { class: 'size-tag none' }, t.problem ?? '—')),
        el('td', {}, sel),
        el('td', {}, ...t.alerts.map((a) => el('span', { class: `badge ${a === 'under' ? 'warn' : ''}`.trim() }, ALERT[a])), t.problem && t.size ? el('span', { class: 'bad' }, t.problem) : null),
        el('td', { class: 'wrap' }, result));
    }));
  }
  update();
}

function update() {
  const n = pending().length;
  const missing = marked().length - n;
  $('btnReview').textContent = `Revisar troca (${n})`;
  $('btnReview').disabled = state.busy || n === 0;
  $('btnLoad').disabled = state.busy;
  $('btnBulk').disabled = state.busy || state.checked.size === 0;
  $('pendingMsg').textContent = missing > 0 ? `${missing} marcada(s) sem tamanho válido para o CAT escolhido.` : '';
  const eligible = visible().filter(editable);
  $('selectAll').checked = eligible.length > 0 && eligible.every((t) => state.checked.has(t.key));
  $('selectAll').disabled = state.busy || !eligible.length;
}

function fillBulkCats() {
  $('bulkCat').replaceChildren(el('option', { value: '' }, 'manter o CAT'), ...state.cats.map((c) => el('option', { value: c.cat, title: c.task }, catLabel(c))));
}

async function load() {
  showError('');
  $('bulkMsg').textContent = '';
  state.busy = true;
  update();
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value });
    const r = await api(`/api/worklog/tamanhos?${q}`);
    if (r.error) showError(r.error);
    state.tasks = r.tasks ?? [];
    state.cats = r.cats ?? [];
    state.picks.clear();
    state.catPicks.clear();
    state.checked.clear();
    state.results.clear();
    fillBulkCats();
  } catch (e) {
    showError(`Não foi possível carregar as tarefas: ${e.message}`);
  }
  state.busy = false;
  render();
}

// Aplica CAT e/ou tamanho às marcadas visíveis; tamanho inexistente no CAT de destino fica para escolher.
function applyBulk() {
  const cat = $('bulkCat').value;
  const size = $('bulkSize').value;
  if (!cat && !size) { $('bulkMsg').textContent = 'Escolha um CAT e/ou um tamanho para aplicar.'; return; }
  let applied = 0;
  const skipped = [];
  for (const t of visible()) {
    if (!state.checked.has(t.key)) continue;
    if (cat) state.catPicks.set(t.key, cat);
    const target = size || pickOf(t);
    if (optsFor(t).some((o) => o.size === target)) { state.picks.set(t.key, target); applied++; } else { state.picks.set(t.key, ''); skipped.push(t.key); }
  }
  const what = [cat, size].filter(Boolean).join(' ');
  $('bulkMsg').textContent = `${applied} tarefa(s) com ${what}.` + (skipped.length ? ` Sem esse tamanho no CAT (escolha na linha): ${skipped.join(', ')}.` : '');
  render();
}

function review() {
  const list = pending();
  const delta = list.reduce((s, t) => s + ustFor(t, catPick(t), pickOf(t)) - (t.size ? ustFor(t, t.cat ?? '', t.size) : 0), 0);
  const cats = list.filter((t) => catPick(t) !== (t.cat ?? '')).length;
  $('reviewBody').replaceChildren(
    el('p', {}, `${list.length} tarefa(s) serão alteradas no Jira${cats ? ` (${cats} com troca de Item do Catálogo)` : ''}. Diferença total: ${delta >= 0 ? '+' : ''}${fmt(Math.round(delta * 100) / 100)} UST. Quem acompanha cada tarefa pode receber o e-mail de alteração do Jira.`),
    el('table', { class: 'items small' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Tarefa'), el('th', {}, 'CAT'), el('th', {}, 'Horas'), el('th', {}, 'Tamanho'), el('th', {}, 'UST'), el('th', {}, 'Descrição do novo tamanho'))),
      el('tbody', {}, ...list.map((t) => {
        const to = optsFor(t).find((o) => o.size === pickOf(t));
        const catCell = catPick(t) !== (t.cat ?? '') ? `${t.cat ?? '—'} → ${catPick(t)}` : catPick(t);
        return el('tr', {}, el('td', {}, t.key), el('td', {}, catCell), el('td', {}, `${fmt(t.hours)} h`),
          el('td', {}, `${t.size ?? '—'} → ${to.size}`),
          el('td', {}, `${t.size ? fmt(ustFor(t, t.cat ?? '', t.size)) : '—'} → ${fmt(ustFor(t, catPick(t), to.size))}`),
          el('td', { class: 'wrap' }, to.description));
      }))));
  $('btnConfirm').disabled = list.length === 0;
  $('reviewDialog').showModal();
}

async function confirm() {
  const changes = pending().map((t) => ({
    key: t.key, size: pickOf(t), from: t.size ?? '', fromCat: t.cat ?? '',
    ...(catPick(t) !== (t.cat ?? '') ? { cat: catPick(t) } : {}),
  }));
  $('btnConfirm').disabled = true;
  $('btnCancel').disabled = true;
  state.busy = true;
  render();
  try {
    const { results } = await api('/api/worklog/tamanhos', { changes });
    $('reviewDialog').close();
    const errors = results.filter((r) => r.status === 'error' || r.status === 'conflict').length;
    // O que foi gravado sai da seleção mesmo que a recarga falhe.
    for (const r of results) if (r.status === 'updated' || r.status === 'unchanged') { state.checked.delete(r.key); state.picks.delete(r.key); state.catPicks.delete(r.key); }
    // Recarrega para refletir o Jira e mantém o resultado de cada tarefa na coluna.
    await load();
    for (const r of results) state.results.set(r.key, r);
    render();
    if (errors) showError(`${errors} tarefa(s) não puderam ser alteradas. Veja a coluna Resultado.`);
  } catch (e) {
    $('reviewDialog').close();
    showError(`Falha ao gravar: ${e.message}. Se foi falha de rede, confira as tarefas no Jira e clique em Carregar antes de tentar de novo.`);
    state.busy = false;
    render();
  } finally {
    $('btnCancel').disabled = false;
  }
}

const { from, to } = currentClosing();
$('from').value = from;
$('to').value = to;
$('btnLoad').addEventListener('click', load);
$('onlyAlerts').addEventListener('change', render);
// Esc não fecha a confirmação enquanto grava.
$('reviewDialog').addEventListener('cancel', (ev) => { if (state.busy) ev.preventDefault(); });
$('btnBulk').addEventListener('click', applyBulk);
$('btnReview').addEventListener('click', review);
$('btnCancel').addEventListener('click', () => $('reviewDialog').close());
$('btnConfirm').addEventListener('click', confirm);
$('selectAll').addEventListener('change', (ev) => {
  for (const t of visible().filter(editable)) ev.target.checked ? state.checked.add(t.key) : state.checked.delete(t.key);
  render();
});
load();
