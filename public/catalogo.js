// Tela "Catálogo de UST": todos veem; o admin importa a planilha (.xlsx, lida no navegador),
// edita linhas e salva o catálogo inteiro de uma vez. Texto da planilha entra só por textContent/value.
import { readXlsxRows } from '/lib/xlsx.js';
import { catalogFromRows, SIZES } from '/lib/ustCatalog.js';

const $ = (id) => document.getElementById(id);
const state = { saved: [], items: [], canEdit: false, busy: false, filter: '', view: 'cards' };

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

async function api(path, method = 'GET', body) {
  const res = await fetch(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function showError(msg) {
  $('errorBox').textContent = msg ?? '';
  $('errorBox').hidden = !msg;
}

const keyOf = (i) => `${String(i.cat).trim().toUpperCase()} ${i.size}`;
const fmtUst = (n) => (Number.isFinite(Number(n)) ? String(n).replace('.', ',') : '');
const parseUst = (s) => { const t = String(s).trim().replace(',', '.'); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
const clone = (list) => list.map((i) => ({ ...i }));
const dirty = () => JSON.stringify(state.items) !== JSON.stringify(state.saved);

function updateBar() {
  const d = dirty();
  $('btnSave').disabled = !d || state.busy;
  $('btnUndo').disabled = !d || state.busy;
  $('dirty').textContent = d ? 'Há alterações não salvas.' : '';
}

// Visão em cartões: um cartão por CAT, com o valor de cada tamanho; o que não tem linha fica vazio.
function renderCards(shown) {
  $('cards').hidden = state.view !== 'cards';
  $('tableWrap').hidden = state.view === 'cards';
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === state.view);
  if (state.view !== 'cards') return;
  if (!shown.length) {
    $('cards').replaceChildren(el('p', { class: 'muted' }, state.items.length ? 'Nenhuma linha com esse filtro.' : 'Catálogo vazio.'));
    return;
  }
  const groups = new Map();
  for (const { item } of shown) {
    const k = String(item.cat ?? '').trim().toUpperCase() || '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  $('cards').replaceChildren(...[...groups].map(([cat, items]) => {
    const sizes = SIZES.filter((s) => s !== 'Hora' || items.some((i) => i.size === 'Hora'));
    return el('article', { class: 'cat-card' },
      el('div', { class: 'cat-head' }, el('span', { class: 'cat-code' }, cat), el('span', { class: 'cat-task' }, items.find((i) => i.task)?.task ?? '')),
      el('div', { class: 'cat-sizes' }, ...sizes.map((s) => {
        const it = items.find((i) => i.size === s);
        return it
          ? el('div', { class: 'cat-size' }, el('div', { class: 'cat-size-top' }, el('span', {}, s), el('strong', {}, fmtUst(it.ust))), el('span', { class: 'cat-desc' }, it.description ?? ''))
          : el('div', { class: 'cat-size empty' }, el('div', { class: 'cat-size-top' }, el('span', {}, s), el('strong', {}, '—')), el('span', { class: 'cat-desc' }, 'sem linha'));
      })));
  }));
}

function setView(v) { state.view = v; render(); }

function render() {
  const f = state.filter.trim().toLowerCase();
  const shown = state.items.map((item, idx) => ({ item, idx }))
    .filter(({ item }) => !f || [item.cat, item.task, item.description, item.size].some((x) => String(x ?? '').toLowerCase().includes(f)));
  $('count').textContent = `${shown.length} de ${state.items.length} ${state.items.length === 1 ? 'linha' : 'linhas'}`;
  renderCards(shown);
  if (!state.items.length) {
    $('rows').replaceChildren(el('tr', {}, el('td', { colSpan: 6, class: 'muted' }, state.canEdit
      ? 'Catálogo vazio. Use “Importar planilha (.xlsx)” para carregar o catálogo.'
      : 'Catálogo vazio. Peça ao administrador para importar a planilha.')));
    updateBar();
    return;
  }
  $('rows').replaceChildren(...shown.map(({ item, idx }) => {
    if (!state.canEdit) {
      return el('tr', {}, el('td', { class: 'nowrap' }, item.cat), el('td', { class: 'wrap' }, item.task), el('td', {}, item.size),
        el('td', { class: 'wrap' }, item.description), el('td', {}, fmtUst(item.ust)), el('td'));
    }
    const input = (field, props = {}) => {
      const i = el('input', { value: field === 'ust' ? fmtUst(item.ust) : item[field] ?? '', disabled: state.busy, ...props });
      i.addEventListener('input', () => {
        item[field] = field === 'ust' ? parseUst(i.value) : field === 'cat' ? i.value.trim().toUpperCase() : i.value;
        i.classList.toggle('invalid', field === 'ust' && !Number.isFinite(item.ust));
        updateBar();
      });
      return i;
    };
    const size = el('select', { disabled: state.busy }, ...SIZES.map((s) => el('option', { value: s, selected: s === item.size }, s)));
    size.addEventListener('change', () => { item.size = size.value; updateBar(); });
    const del = el('button', { class: 'link', disabled: state.busy, title: 'Remover linha' }, 'remover');
    del.addEventListener('click', () => { state.items.splice(idx, 1); render(); });
    return el('tr', {},
      el('td', {}, input('cat', { class: 'short', placeholder: 'CAT-123', 'aria-label': 'CAT' })),
      el('td', {}, input('task', { 'aria-label': 'Tarefa' })),
      el('td', {}, size),
      el('td', {}, input('description', { 'aria-label': 'Descrição' })),
      el('td', {}, input('ust', { class: 'short', inputMode: 'decimal', 'aria-label': 'UST' })),
      el('td', {}, del));
  }));
  updateBar();
}

async function load() {
  showError('');
  try {
    const r = await api('/api/ust/catalogo');
    state.canEdit = Boolean(r.canEdit);
    state.saved = clone(r.items);
    state.items = clone(r.items);
    $('editBar').hidden = !state.canEdit;
    $('meta').textContent = r.updatedAt
      ? `Atualizado em ${new Date(r.updatedAt).toLocaleString('pt-BR')}${r.updatedBy ? ` por ${r.updatedBy}` : ''}`
      : 'Nunca atualizado';
  } catch (e) {
    showError(`Não foi possível carregar o catálogo: ${e.message}`);
  }
  render();
}

// Importação: compara a planilha com o que está na tela e mostra o resumo; nada é salvo até "Salvar".
async function importFile(file) {
  showError('');
  $('importBox').hidden = true;
  try {
    const { items, warnings } = catalogFromRows(await readXlsxRows(await file.arrayBuffer()));
    if (!items.length) throw new Error('Nenhuma linha com CAT (coluna B), tamanho (coluna D) e UST (coluna G) encontrada.');
    const before = new Map(state.items.map((i) => [keyOf(i), i]));
    const after = new Map(items.map((i) => [keyOf(i), i]));
    const added = items.filter((i) => !before.has(keyOf(i)));
    const changed = items.filter((i) => before.has(keyOf(i)) && before.get(keyOf(i)).ust !== i.ust);
    const removed = state.items.filter((i) => !after.has(keyOf(i)));
    const list = (title, rows, fmt) => (rows.length ? el('details', {}, el('summary', {}, `${title}: ${rows.length}`), el('ul', {}, ...rows.map((r) => el('li', {}, fmt(r))))) : null);
    const apply = el('button', { type: 'button', class: 'primary' }, 'Usar a planilha');
    const cancel = el('button', { type: 'button' }, 'Cancelar');
    apply.addEventListener('click', () => { state.items = clone(items); state.view = 'table'; $('importBox').hidden = true; render(); });
    cancel.addEventListener('click', () => { $('importBox').hidden = true; });
    $('importBox').replaceChildren(...[
      el('p', {}, el('strong', {}, file.name), ` — ${items.length} linhas. Ao usar a planilha, a tabela abaixo é substituída; depois clique em “Salvar alterações”.`),
      list('Novas', added, (r) => `${r.cat} ${r.size}: ${fmtUst(r.ust)} UST — ${r.task}`),
      list('UST alterada', changed, (r) => `${r.cat} ${r.size}: ${fmtUst(before.get(keyOf(r)).ust)} → ${fmtUst(r.ust)} UST`),
      list('Saem do catálogo', removed, (r) => `${r.cat} ${r.size}: ${fmtUst(r.ust)} UST — ${r.task}`),
      !added.length && !changed.length && !removed.length ? el('p', {}, 'Nenhuma diferença de CAT, tamanho ou UST em relação à tabela atual.') : null,
      list('Avisos', warnings, (w) => w),
      el('div', { class: 'actions' }, apply, cancel),
    ].filter(Boolean));
    $('importBox').hidden = false;
  } catch (e) {
    showError(`Não foi possível ler a planilha: ${e.message}`);
  }
}

async function save() {
  showError('');
  const bad = state.items.findIndex((i) => !/^CAT-\d+$/.test(i.cat ?? '') || !Number.isFinite(i.ust));
  if (bad >= 0) { state.view = 'table'; render(); showError(`Linha ${bad + 1}: confira o CAT (ex.: CAT-123) e a UST (número, ex.: 0,5).`); return; }
  if (!state.items.length) { showError('O catálogo não pode ficar vazio.'); return; }
  const seen = new Set();
  const dup = state.items.find((i) => { const k = keyOf(i); if (seen.has(k)) return true; seen.add(k); return false; });
  if (dup) {
    state.filter = dup.cat;
    $('filter').value = dup.cat;
    state.view = 'table';
    render();
    showError(`${keyOf(dup)} aparece mais de uma vez; deixe só uma linha (a tabela foi filtrada por ${dup.cat}).`);
    return;
  }
  const removed = state.saved.filter((s) => !state.items.some((i) => keyOf(i) === keyOf(s))).length;
  if (removed > 10 && !window.confirm(`${removed} linhas do catálogo salvo vão sair. Confirmar?`)) return;
  state.busy = true;
  render();
  try {
    await api('/api/admin/ust/catalogo', 'PUT', { items: state.items });
    state.busy = false;
    await load();
  } catch (e) {
    state.busy = false;
    render();
    showError(`Não foi possível salvar: ${e.message}`);
  }
}

$('file').addEventListener('change', (ev) => { const f = ev.target.files?.[0]; if (f) importFile(f); ev.target.value = ''; });
$('btnAdd').addEventListener('click', () => { state.items.unshift({ cat: '', size: 'P', ust: NaN, task: '', description: '' }); state.filter = ''; $('filter').value = ''; state.view = 'table'; render(); });
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
$('btnSave').addEventListener('click', save);
$('btnUndo').addEventListener('click', () => { state.items = clone(state.saved); render(); });
$('filter').addEventListener('input', () => { state.filter = $('filter').value; render(); });
window.addEventListener('beforeunload', (ev) => { if (dirty()) ev.preventDefault(); });

load();
