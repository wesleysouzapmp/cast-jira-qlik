// Tela "Tarefas de apoio": lista itens atribuídos e cria as tarefas no QSENSE.
// Texto vindo do Jira entra sempre por textContent.

const $ = (id) => document.getElementById(id);
const MODEL_LABEL = { analise: 'Análise', implementacao: 'Implementação' };
const state = { items: [], selected: new Set(), results: new Map(), busy: false, collapsed: new Set(), picks: new Map() };

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
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function showError(msg) {
  $('errorBox').textContent = msg ?? '';
  $('errorBox').hidden = !msg;
}

// Todo épico pode receber mais tarefas de apoio; os modelos são escolhidos na prévia.
const selectable = (i) => i.isEpic;

// Árvore: o épico na linha de cima e as tarefas de apoio dele logo abaixo, recuadas.
function renderItems() {
  const tbody = $('items');
  $('count').textContent = `${state.items.length} ${state.items.length === 1 ? 'item' : 'itens'}`;
  if (!state.items.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 6, class: 'muted' }, 'Nenhum item atribuído a você.')));
    updateButtons();
    return;
  }
  const rows = [];
  for (const i of state.items) {
    const box = el('input', { type: 'checkbox', checked: state.selected.has(i.key), disabled: !selectable(i) || state.busy });
    box.title = i.isEpic ? '' : 'Só épicos recebem tarefas de apoio';
    box.addEventListener('change', () => { box.checked ? state.selected.add(i.key) : state.selected.delete(i.key); updateButtons(); });
    const open = !state.collapsed.has(i.key);
    const toggle = i.isEpic
      ? el('button', { class: 'tree-toggle', title: open ? 'Recolher' : 'Expandir', 'aria-expanded': String(open) }, open ? '▾' : '▸')
      : el('span', { class: 'tree-toggle' });
    if (i.isEpic) toggle.addEventListener('click', () => { open ? state.collapsed.add(i.key) : state.collapsed.delete(i.key); renderItems(); });
    rows.push(el('tr', { class: i.isEpic ? 'tree-root' : 'tree-root dim' },
      el('td', {}, box),
      el('td', { class: 'nowrap' }, toggle, link(i.key, i.url)),
      el('td', {}, i.type),
      el('td', {}, i.status),
      el('td', { class: 'wrap', title: i.summary }, i.summary),
      el('td', { class: 'wrap' }, ...renderResult(i.key))));
    if (!i.isEpic || !open) continue;
    if (!i.existing.length) {
      rows.push(el('tr', { class: 'tree-child' }, el('td'), el('td', { class: 'nowrap muted' }, el('span', { class: 'tree-branch' }, '└─'), 'sem tarefas de apoio'), el('td'), el('td'), el('td'), el('td')));
      continue;
    }
    i.existing.forEach((t, n) => {
      const last = n === i.existing.length - 1;
      rows.push(el('tr', { class: 'tree-child' },
        el('td'),
        el('td', { class: 'nowrap' }, el('span', { class: 'tree-branch' }, last ? '└─' : '├─'), link(t.key, t.url)),
        el('td', {}, MODEL_LABEL[t.model]),
        el('td', {}, t.status ?? ''),
        el('td', { class: 'wrap', title: t.summary ?? '' }, t.summary ?? ''),
        el('td')));
    });
  }
  tbody.replaceChildren(...rows);
  updateButtons();
}

function renderResult(key) {
  const rs = state.results.get(key);
  if (!rs) return [];
  return rs.flatMap((r, n) => {
    const sep = n ? el('br') : null;
    const label = r.model ? `${MODEL_LABEL[r.model]}: ` : '';
    if (r.status === 'created') return [sep, el('span', { class: 'ok' }, `${label}criada `), link(r.key, r.url)];
    if (r.status === 'skipped') return [sep, el('span', { class: 'muted' }, `${label}já existia `), link(r.key, r.url)];
    return [sep, el('span', { class: 'bad' }, `${label}erro — ${r.error}`)];
  });
}

function updateButtons() {
  // Seleções que deixaram de ser válidas (ex.: após recarregar) saem do conjunto.
  for (const k of state.selected) if (!state.items.some((i) => i.key === k && selectable(i))) state.selected.delete(k);
  const n = state.selected.size;
  $('btnCreate').textContent = `Criar tarefas de apoio (${n})`;
  $('btnCreate').disabled = n === 0 || state.busy;
  $('btnRefresh').disabled = state.busy;
  const epicCount = state.items.filter((i) => i.isEpic).length;
  $('btnToggleAll').textContent = epicCount && state.collapsed.size >= epicCount ? 'Expandir tudo' : 'Recolher tudo';
  const eligible = state.items.filter(selectable);
  $('selectAll').disabled = !eligible.length || state.busy;
  $('selectAll').checked = eligible.length > 0 && eligible.every((i) => state.selected.has(i.key));
}

async function load() {
  showError('');
  try {
    const r = await api(`/api/support/items?includeDone=1&onlyEpics=${$('onlyEpics').checked ? 1 : 0}`);
    state.items = r.items;
    $('truncatedNote').hidden = !r.truncated;
  } catch (e) {
    state.items = [];
    showError(`Não foi possível carregar os itens: ${e.message}`);
  }
  renderItems();
}

async function openPreview() {
  const keys = [...state.selected];
  setBusy(true);
  try {
    const p = await api('/api/support/preview', { keys });
    const body = $('previewBody');
    // Escolha por épico: vêm marcados os modelos que o épico ainda não tem.
    state.picks = new Map(p.epics.map((e) => [e.epic, new Set(e.models.filter((m) => m.checked).map((m) => m.model))]));
    const summary = el('p');
    const refresh = () => {
      const total = [...state.picks.values()].reduce((n, set) => n + set.size, 0);
      summary.textContent = `${total} ${total === 1 ? 'tarefa será criada' : 'tarefas serão criadas'}, com você como responsável e o épico como pai.`;
      $('btnConfirm').disabled = total === 0;
    };
    const blocks = p.epics.map((e) => el('section', { class: 'pv' },
      el('h3', {}, `${e.epic} - ${e.summary}`),
      ...e.models.map((t) => {
        const pick = el('input', { type: 'checkbox', checked: t.checked });
        pick.addEventListener('change', () => { const set = state.picks.get(e.epic); pick.checked ? set.add(t.model) : set.delete(t.model); refresh(); });
        return el('label', { class: 'pv-task' },
          el('div', {}, pick, ' ', el('strong', {}, t.summary)),
          el('div', {}, t.description),
          el('div', { class: 'muted' }, `Item do Catálogo: ${t.catalog}`),
          t.existing.length ? el('div', { class: 'muted' }, `Já existe${t.existing.length > 1 ? 'm' : ''}: ${t.existing.join(', ')}. Marque para criar mais uma.`) : null);
      })));
    const rejected = p.rejected.map((r) => el('div', { class: 'bad' }, `${r.key}: ${r.reason}`));
    body.replaceChildren(summary, ...blocks, ...rejected);
    refresh();
    $('previewDialog').showModal();
  } catch (e) {
    showError(`Não foi possível montar a prévia: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function confirmCreate() {
  const keys = [...state.selected];
  $('btnConfirm').disabled = true;
  $('btnCancel').disabled = true;
  setBusy(true);
  try {
    const models = Object.fromEntries([...state.picks].filter(([k]) => keys.includes(k)).map(([k, set]) => [k, [...set]]));
    const { results } = await api('/api/support/create', { keys, models });
    state.results.clear();
    for (const r of results) state.results.set(r.epic, [...(state.results.get(r.epic) ?? []), r]);
    state.selected.clear();
    $('previewDialog').close();
    const errors = results.filter((r) => r.status === 'error').length;
    setBusy(false);
    await load();
    if (errors) showError(`${errors} ${errors === 1 ? 'tarefa não pôde ser criada' : 'tarefas não puderam ser criadas'}. Veja a coluna Resultado.`);
  } catch (e) {
    $('previewDialog').close();
    showError(`Falha ao criar: ${e.message}. Se foi falha de rede, o Jira pode ter criado parte das tarefas: confira o épico no Jira e clique em Atualizar antes de tentar de novo.`);
    setBusy(false);
    renderItems();
  } finally {
    $('btnCancel').disabled = false;
  }
}

function setBusy(b) {
  state.busy = b;
  renderItems();
}

async function init() {
  const config = await api('/api/config').catch(() => ({}));
  $('baseUrl').textContent = config.baseUrl ?? '';
  $('tokenBadge').textContent = config.tokenConfigured ? 'Token OK' : 'Token ausente';
  $('tokenBadge').className = 'badge ' + (config.tokenConfigured ? 'ok' : 'bad');
  $('tokenBanner').hidden = Boolean(config.tokenConfigured);
  $('user').textContent = config.email ?? '';

  $('onlyEpics').addEventListener('change', load);
  $('btnRefresh').addEventListener('click', () => { state.results.clear(); load(); });
  $('btnToggleAll').addEventListener('click', () => {
    const epics = state.items.filter((i) => i.isEpic).map((i) => i.key);
    if (state.collapsed.size < epics.length) epics.forEach((k) => state.collapsed.add(k));
    else state.collapsed.clear();
    renderItems();
  });
  $('btnCreate').addEventListener('click', openPreview);
  $('btnCancel').addEventListener('click', () => $('previewDialog').close());
  $('btnConfirm').addEventListener('click', confirmCreate);
  $('selectAll').addEventListener('change', (ev) => {
    for (const i of state.items.filter(selectable)) ev.target.checked ? state.selected.add(i.key) : state.selected.delete(i.key);
    renderItems();
  });

  if (config.tokenConfigured) await load();
  else renderItems();
}

init();
