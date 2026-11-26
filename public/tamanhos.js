// Tela "Tamanhos e UST": analisa o tamanho das tarefas frente às horas apontadas e troca o campo
// Tamanho em lote, sempre pela escolha do usuário, com prévia e confirmação. Texto do Jira só por textContent.
import { closingPeriod } from '/lib/time.js';

const $ = (id) => document.getElementById(id);
const ALERT = { under: 'Subavaliação', over: 'Acima das horas' };
const state = { tasks: [], picks: new Map(), checked: new Set(), results: new Map(), busy: false };

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

const editable = (t) => !t.problem || t.options.length > 0;
const pickOf = (t) => state.picks.get(t.key) ?? t.size ?? '';
// Só as linhas exibidas contam: o filtro "Só com alerta" tira as outras da troca.
const visible = () => state.tasks.filter((t) => !$('onlyAlerts').checked || t.alerts.length);
const pending = () => visible().filter((t) => state.checked.has(t.key) && pickOf(t) && pickOf(t) !== t.size);
// UST de um tamanho para a tarefa (itens por hora: UST × horas da tarefa).
const ustFor = (t, size) => { const o = t.options.find((x) => x.size === size); return o ? (size === 'Hora' ? Math.round(o.ust * t.hours * 100) / 100 : o.ust) : 0; };

function render() {
  const shown = visible();
  $('count').textContent = state.tasks.length ? `${shown.length} de ${state.tasks.length} tarefas` : '';
  if (!shown.length) {
    $('rows').replaceChildren(el('tr', {}, el('td', { colSpan: 9, class: 'muted' }, state.tasks.length ? 'Nenhuma tarefa com alerta.' : 'Nenhuma tarefa com Item do Catálogo no período.')));
  } else {
    $('rows').replaceChildren(...shown.map((t) => {
      const box = el('input', { type: 'checkbox', checked: state.checked.has(t.key), disabled: state.busy || !editable(t), 'aria-label': `Marcar ${t.key}` });
      box.addEventListener('change', () => { box.checked ? state.checked.add(t.key) : state.checked.delete(t.key); update(); });
      const sel = el('select', { disabled: state.busy || !t.options.length, 'aria-label': `Novo tamanho de ${t.key}` },
        // Tamanho atual fora das opções do catálogo (ou vazio): opção própria, para o seletor mostrar a verdade.
        ...(t.options.some((o) => o.size === t.size) ? [] : [el('option', { value: t.size ?? '', selected: pickOf(t) === (t.size ?? '') }, `${t.size ?? '—'} (atual)`)]),
        ...t.options.map((o) => el('option', { value: o.size, selected: o.size === pickOf(t), title: o.description }, `${o.size} · ${fmt(o.ust)} UST — ${o.description}`)));
      sel.addEventListener('change', () => {
        state.picks.set(t.key, sel.value);
        if (sel.value && sel.value !== t.size) { state.checked.add(t.key); box.checked = true; }
        update();
      });
      const r = state.results.get(t.key);
      const result = !r ? '' : r.status === 'updated' ? el('span', { class: 'ok' }, `gravado ${r.from ?? '—'} → ${r.to}`)
        : r.status === 'unchanged' ? el('span', { class: 'muted' }, 'sem mudança')
          : el('span', { class: 'bad' }, `${r.status === 'conflict' ? 'não gravado' : 'erro'} — ${r.error}`);
      return el('tr', {},
        el('td', {}, box),
        el('td', { class: 'wrap', title: t.summary }, link(t.key, t.url), ` ${t.summary}`),
        el('td', {}, t.status),
        el('td', {}, t.cat ?? '—'),
        el('td', {}, `${fmt(t.hours)} h`),
        el('td', {}, t.size ? `${t.size} · ${fmt(t.ust)} UST` : el('span', { class: 'bad' }, t.problem ?? '—')),
        el('td', {}, sel),
        el('td', {}, ...t.alerts.map((a) => el('span', { class: `badge ${a === 'under' ? 'warn' : ''}`.trim() }, ALERT[a])), t.problem && t.size ? el('span', { class: 'bad' }, t.problem) : null),
        el('td', { class: 'wrap' }, result));
    }));
  }
  update();
}

function update() {
  const n = pending().length;
  $('btnReview').textContent = `Revisar troca (${n})`;
  $('btnReview').disabled = state.busy || n === 0;
  $('btnLoad').disabled = state.busy;
  $('btnBulk').disabled = state.busy || state.checked.size === 0;
  const eligible = visible().filter(editable);
  $('selectAll').checked = eligible.length > 0 && eligible.every((t) => state.checked.has(t.key));
  $('selectAll').disabled = state.busy || !eligible.length;
}

async function load() {
  showError('');
  $('bulkMsg').textContent = '';
  state.busy = true;
  update();
  try {
    const q = new URLSearchParams({ from: $('from').value, to: $('to').value, ...($('includeDone').checked ? { concluidas: '1' } : {}) });
    const r = await api(`/api/worklog/tamanhos?${q}`);
    if (r.error) showError(r.error);
    state.tasks = r.tasks ?? [];
    state.picks.clear();
    state.checked.clear();
    state.results.clear();
  } catch (e) {
    showError(`Não foi possível carregar as tarefas: ${e.message}`);
  }
  state.busy = false;
  render();
}

function applyBulk() {
  const size = $('bulkSize').value;
  let applied = 0;
  const skipped = [];
  for (const t of visible()) {
    if (!state.checked.has(t.key)) continue;
    if (t.options.some((o) => o.size === size)) { state.picks.set(t.key, size); applied++; } else skipped.push(t.key);
  }
  $('bulkMsg').textContent = `${applied} tarefa(s) com ${size}.` + (skipped.length ? ` Sem ${size} no catálogo do CAT: ${skipped.join(', ')}.` : '');
  render();
}

function review() {
  const list = pending();
  const delta = list.reduce((s, t) => s + ustFor(t, pickOf(t)) - (t.size ? ustFor(t, t.size) : 0), 0);
  $('reviewBody').replaceChildren(
    el('p', {}, `${list.length} tarefa(s) terão o campo Tamanho alterado no Jira. Diferença total: ${delta >= 0 ? '+' : ''}${fmt(Math.round(delta * 100) / 100)} UST. Quem acompanha cada tarefa pode receber o e-mail de alteração do Jira.`),
    el('table', { class: 'items small' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Tarefa'), el('th', {}, 'CAT'), el('th', {}, 'Horas'), el('th', {}, 'Tamanho'), el('th', {}, 'UST'), el('th', {}, 'Descrição do novo tamanho'))),
      el('tbody', {}, ...list.map((t) => {
        const to = t.options.find((o) => o.size === pickOf(t));
        return el('tr', {}, el('td', {}, t.key), el('td', {}, t.cat), el('td', {}, `${fmt(t.hours)} h`),
          el('td', {}, `${t.size ?? '—'} → ${to.size}`), el('td', {}, `${t.size ? fmt(ustFor(t, t.size)) : '—'} → ${fmt(ustFor(t, to.size))}`), el('td', { class: 'wrap' }, to.description));
      }))));
  $('btnConfirm').disabled = list.length === 0;
  $('reviewDialog').showModal();
}

async function confirm() {
  const changes = pending().map((t) => ({ key: t.key, size: pickOf(t), from: t.size ?? '' }));
  $('btnConfirm').disabled = true;
  $('btnCancel').disabled = true;
  state.busy = true;
  render();
  try {
    const { results } = await api('/api/worklog/tamanhos', { changes });
    $('reviewDialog').close();
    const errors = results.filter((r) => r.status === 'error' || r.status === 'conflict').length;
    // O que foi gravado sai da seleção mesmo que a recarga falhe.
    for (const r of results) if (r.status === 'updated' || r.status === 'unchanged') { state.checked.delete(r.key); state.picks.delete(r.key); }
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
