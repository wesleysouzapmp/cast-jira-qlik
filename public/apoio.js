// Tela "Tarefas de apoio": lista itens atribuídos, mantém os modelos de tarefas e cria as tarefas
// no QSENSE a partir de um modelo (com ajustes e tarefas avulsas na prévia).
// Texto vindo do Jira ou dos modelos entra sempre por textContent/value.

const $ = (id) => document.getElementById(id);
const MODEL_LABEL = { analise: 'Análise', implementacao: 'Implementação' };
const SIZE_ORDER = ['P', 'M', 'G', 'Hora'];
const LIMITS = { name: 80, items: 20, summary: 255, description: 2000 };
const state = {
  items: [], selected: new Set(), results: new Map(), busy: false, collapsed: new Set(),
  // Catálogo de UST: CAT → { task, sizes }.
  cats: new Map(),
  templates: [], canEdit: false, lastUsedId: null,
  // Prévia: { templateId, epics: [{ epic, label, existing, rows: [{ cat, size, summary, description, checked, loose }] }] }
  preview: null,
};

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

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(path, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) { const e = new Error(json.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}

function showError(msg, id = 'errorBox') {
  $(id).textContent = msg ?? '';
  $(id).hidden = !msg;
}

// ---------- catálogo de UST ----------
const catNum = (cat) => Number(String(cat).slice(4));
function setCatalog(items) {
  state.cats = new Map();
  for (const i of items) {
    const c = state.cats.get(i.cat) ?? { task: i.task ?? '', sizes: [] };
    if (!c.sizes.includes(i.size)) c.sizes.push(i.size);
    state.cats.set(i.cat, c);
  }
  for (const c of state.cats.values()) c.sizes.sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
}
const catTask = (cat) => state.cats.get(cat)?.task ?? '';
// Rótulo de uma tarefa de apoio: "CAT-105 · Realizar diagnóstico" (catálogo do app, senão o texto do Jira).
function taskLabel(t) {
  if (!t.cat) return MODEL_LABEL[t.model] ?? 'Apoio';
  const fromJira = String(t.catLabel ?? '').replace(/^\s*CAT-\d+\s*[-–]\s*/i, '');
  const name = catTask(t.cat) || fromJira || MODEL_LABEL[t.model] || '';
  return name ? `${t.cat} · ${name}` : t.cat;
}
const defaultTitle = (cat) => (cat ? `${catTask(cat) || cat} da demanda {EPICO}` : '');
// {EPICO} já trocado pelo épico, cortado em 255 como no servidor.
function fillEpic(text, label) {
  const s = text.replaceAll('{EPICO}', () => label);
  return s.length > LIMITS.summary ? `${s.slice(0, LIMITS.summary - 1)}…` : s;
}

// Seletores de CAT e tamanho de uma linha (e um aviso); onCat é chamado quando o CAT muda.
// Nunca troca o tamanho sozinho: tamanho que o CAT não tem no catálogo fica vazio até a pessoa escolher
// (a confirmação exige CAT e tamanho).
function catControls(row, { onChange, onCat } = {}) {
  const cats = [...state.cats.keys()].sort((a, b) => catNum(a) - catNum(b));
  const catSel = el('select', { class: 'tk-cat', title: 'Item do Catálogo (CAT)' },
    el('option', { value: '' }, 'escolha o CAT'),
    ...cats.map((c) => el('option', { value: c }, catTask(c) ? `${c} · ${catTask(c)}` : c)));
  if (row.cat && !state.cats.has(row.cat)) catSel.append(el('option', { value: row.cat }, `${row.cat} (fora do catálogo)`));
  catSel.value = row.cat ?? '';
  const sizeSel = el('select', { class: 'tk-size', title: 'Tamanho' });
  const note = el('div', { class: 'tk-note' });
  const fillSizes = (fromModel) => {
    const sizes = state.cats.get(row.cat)?.sizes ?? [];
    sizeSel.replaceChildren(el('option', { value: '' }, 'escolha'), ...sizes.map((s) => el('option', { value: s }, s)));
    if (row.size && !sizes.includes(row.size)) {
      // Guardado na linha: o aviso continua quando a lista é redesenhada.
      if (fromModel && row.cat) row.sizeMissing = row.size;
      row.size = '';
    }
    if (!fromModel) row.sizeMissing = null;
    note.textContent = row.sizeMissing && !row.size ? `tamanho do modelo (${row.sizeMissing}) não existe no catálogo para ${row.cat}; escolha` : '';
    sizeSel.value = row.size ?? '';
  };
  fillSizes(true);
  catSel.addEventListener('change', () => { const old = row.cat; row.cat = catSel.value; fillSizes(false); onCat?.(old); onChange?.(); });
  sizeSel.addEventListener('change', () => { row.size = sizeSel.value; row.sizeMissing = null; note.textContent = ''; onChange?.(); });
  return [catSel, sizeSel, note];
}

// ---------- itens atribuídos ----------
// Todo épico pode receber mais tarefas de apoio; as tarefas são escolhidas na prévia.
const selectable = (i) => i.isEpic;
const defaultTemplate = () => state.templates.find((t) => t.id === state.lastUsedId) ?? state.templates.find((t) => t.usable) ?? null;

// Árvore: o épico na linha de cima e as tarefas de apoio dele logo abaixo, recuadas.
function renderItems() {
  const tbody = $('items');
  $('count').textContent = `${state.items.length} ${state.items.length === 1 ? 'item' : 'itens'}`;
  if (!state.items.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 6, class: 'muted' }, 'Nenhum item atribuído a você.')));
    updateButtons();
    return;
  }
  const planned = defaultTemplate()?.items ?? [];
  const rows = [];
  for (const i of state.items) {
    const box = el('input', { type: 'checkbox', checked: state.selected.has(i.key), disabled: !selectable(i) || state.busy });
    box.title = i.isEpic ? '' : 'Só épicos recebem tarefas de apoio';
    box.addEventListener('change', () => { box.checked ? state.selected.add(i.key) : state.selected.delete(i.key); updateButtons(); });
    const open = !state.collapsed.has(i.key);
    const toggle = i.isEpic
      ? el('button', { class: 'tree-toggle', title: open ? 'Recolher' : 'Expandir', 'aria-expanded': String(open) }, el('span', { class: 'i i-chevron', 'aria-hidden': 'true' }))
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
    // Tarefas de apoio do épico (pelo CAT); tracejado: CAT do modelo padrão que o épico ainda não tem
    // (o texto troca para "será criada" pelo CSS quando o épico está marcado).
    const slot = (t) => el('div', { class: `slot${/conclu/i.test(t.status ?? '') ? ' done' : ''}`, title: t.summary ?? '' },
      el('span', { class: 'slot-label' }, taskLabel(t), t.size ? ` (${t.size})` : ''), link(t.key, t.url), el('span', { class: 'slot-status' }, t.status ?? ''));
    const missing = planned.filter((p, n) => !i.existing.some((t) => t.cat === p.cat) && planned.findIndex((q) => q.cat === p.cat) === n);
    const slots = [
      ...i.existing.map(slot),
      ...missing.map((p) => el('div', { class: 'slot todo' },
        el('span', { class: 'slot-label' }, taskLabel({ cat: p.cat })),
        el('span', { class: 'slot-missing' }, 'sem tarefa'), el('span', { class: 'slot-will' }, 'será criada'))),
    ];
    if (!slots.length) slots.push(el('div', { class: 'slot todo' }, el('span', { class: 'slot-label' }, 'Tarefas de apoio'), el('span', { class: 'slot-missing' }, 'nenhuma'), el('span', { class: 'slot-will' }, 'escolha na prévia')));
    rows.push(el('tr', { class: 'tree-child slots-row' }, el('td'), el('td', { colSpan: 5 }, el('div', { class: 'slots' }, ...slots))));
  }
  tbody.replaceChildren(...rows);
  updateButtons();
}

function renderResult(key) {
  const rs = state.results.get(key);
  if (!rs) return [];
  return rs.flatMap((r, n) => {
    const sep = n ? el('br') : null;
    const label = r.cat ? `${taskLabel({ cat: r.cat })}${r.size ? ` ${r.size}` : ''}: ` : '';
    if (r.status === 'created') return [sep, el('span', { class: 'ok' }, `${label}criada `), link(r.key, r.url), r.warning ? el('span', { class: 'bad' }, ` — ${r.warning}`) : null];
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

// ---------- prévia ----------
async function openPreview() {
  setBusy(true);
  try {
    showError('', 'previewError');
    await loadPreview(state.lastUsedId);
    $('previewDialog').showModal();
  } catch (e) {
    showError(`Não foi possível montar a prévia: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

// keep: avulsas já adicionadas por épico (mantidas ao trocar de modelo).
async function loadPreview(templateId, keep = new Map()) {
  const keys = [...state.selected];
  const p = await api('/api/support/preview', { keys, ...(templateId ? { templateId } : {}) });
  state.preview = {
    templateId: p.templateId,
    rejected: p.rejected,
    epics: p.epics.map((e) => ({
      epic: e.epic, label: e.label, existing: e.existing,
      rows: [
        ...e.tasks.map((t) => ({ cat: t.cat, size: t.size, summary: t.summary, description: t.description, checked: t.checked, loose: false })),
        ...(keep.get(e.epic) ?? []),
      ],
    })),
  };
  const sel = $('previewTemplate');
  // Só os modelos utilizáveis (públicos ou próprios); o admin vê os privados alheios só na lista de Modelos.
  const usable = state.templates.filter((t) => t.usable);
  sel.replaceChildren(...usable.map((t) => el('option', { value: t.id }, t.public ? t.name : `${t.name} (privado)`)));
  sel.value = p.templateId ?? '';
  sel.disabled = !usable.length;
  renderPreview();
}

function renderPreview() {
  const pv = state.preview;
  const summary = el('p');
  const refresh = () => {
    const total = pv.epics.reduce((n, e) => n + e.rows.filter((r) => r.checked).length, 0);
    summary.textContent = `${total} ${total === 1 ? 'tarefa será criada' : 'tarefas serão criadas'}, com você como responsável e o épico como pai.`;
    $('btnConfirm').disabled = total === 0 || state.busy;
  };
  // Recalculado também quando a tela deixa de estar ocupada (ex.: fim da carga da prévia).
  state.refreshPreview = refresh;
  const blocks = pv.epics.map((e) => {
    const list = el('div');
    const draw = () => list.replaceChildren(...e.rows.map((r, n) => previewRow(e, r, n, { refresh, redraw: draw })));
    draw();
    const add = el('button', { type: 'button', class: 'link' }, '+ Adicionar tarefa avulsa');
    add.addEventListener('click', () => {
      // Começa sem CAT: a confirmação só passa depois que a pessoa escolher CAT e tamanho.
      e.rows.push({ cat: '', size: '', summary: '', description: '', checked: true, loose: true, auto: true });
      draw();
      refresh();
    });
    const existing = e.existing.length
      ? el('div', { class: 'muted' }, 'Já existem: ', ...e.existing.flatMap((t, n) => [n ? ', ' : '', link(t.key, t.url), ` ${taskLabel(t)}`]))
      : el('div', { class: 'muted' }, 'O épico ainda não tem tarefas de apoio.');
    return el('section', { class: 'pv' }, el('h3', {}, e.label), existing, list, el('div', { class: 'tk-tools' }, add));
  });
  const rejected = pv.rejected.map((r) => el('div', { class: 'bad' }, `${r.key}: ${r.reason}`));
  const empty = !state.cats.size ? [el('div', { class: 'bad' }, 'O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.')] : [];
  $('previewBody').replaceChildren(summary, ...empty, ...blocks, ...rejected);
  refresh();
}

function previewRow(e, r, n, { refresh, redraw }) {
  const box = el('input', { type: 'checkbox', checked: r.checked, title: 'Criar esta tarefa' });
  const note = el('div', { class: 'tk-note' });
  const wrap = el('div', { class: r.checked ? 'tk-row' : 'tk-row off' });
  const title = el('input', { type: 'text', class: 'tk-title', value: r.summary, maxLength: LIMITS.summary, 'aria-label': 'Título' });
  const updateNote = () => {
    const same = e.existing.filter((t) => t.cat === r.cat).map((t) => t.key);
    note.textContent = same.length ? `já existe: ${same.join(', ')}${r.checked ? ' (será criada mais uma)' : ''}` : '';
  };
  const [catSel, sizeSel, sizeNote] = catControls(r, {
    onCat: () => {
      // Título padrão acompanha o CAT enquanto a pessoa não o editou.
      if (r.auto) { r.summary = r.cat ? fillEpic(defaultTitle(r.cat), e.label) : ''; title.value = r.summary; }
      updateNote();
    },
    onChange: () => { r.edited = true; },
  });
  if (r.loose && !r.cat) title.placeholder = 'escolha o CAT';
  box.addEventListener('change', () => { r.checked = box.checked; r.edited = true; wrap.className = r.checked ? 'tk-row' : 'tk-row off'; updateNote(); refresh(); });
  title.addEventListener('input', () => { r.summary = title.value; r.auto = false; r.edited = true; });
  const head = el('div', { class: 'tk-head' }, box, catSel, sizeSel, title);
  if (r.loose) {
    const remove = el('button', { type: 'button', class: 'link', title: 'Remover tarefa avulsa' }, 'remover');
    remove.addEventListener('click', () => { e.rows.splice(n, 1); redraw(); refresh(); });
    head.append(remove);
  }
  wrap.append(head);
  if (!r.loose) {
    const desc = el('textarea', { rows: 2, value: r.description ?? '', maxLength: LIMITS.description, placeholder: 'Descrição (opcional)', 'aria-label': 'Descrição' });
    desc.addEventListener('input', () => { r.description = desc.value; r.edited = true; });
    wrap.append(desc);
  }
  wrap.append(sizeNote, note);
  updateNote();
  return wrap;
}

async function confirmCreate() {
  const pv = state.preview;
  const keys = pv.epics.map((e) => e.epic);
  showError('', 'previewError');
  const tasks = {};
  for (const e of pv.epics) {
    tasks[e.epic] = e.rows.filter((r) => r.checked).map((r) => ({ cat: r.cat, size: r.size, summary: r.summary.trim(), description: (r.description ?? '').trim() }));
    const bad = tasks[e.epic].find((t) => !t.summary || !t.cat || !t.size);
    if (bad) { showError(`${e.epic}: preencha CAT, tamanho e título de todas as tarefas marcadas.`, 'previewError'); return; }
  }
  $('btnConfirm').disabled = true;
  $('btnCancel').disabled = true;
  setBusy(true);
  try {
    const { results } = await api('/api/support/create', { keys, tasks, ...(pv.templateId ? { templateId: pv.templateId } : {}) });
    state.results.clear();
    for (const r of results) state.results.set(r.epic, [...(state.results.get(r.epic) ?? []), r]);
    state.selected.clear();
    if (pv.templateId) state.lastUsedId = pv.templateId;
    $('previewDialog').close();
    const errors = results.filter((r) => r.status === 'error').length;
    const warnings = results.filter((r) => r.warning).length;
    setBusy(false);
    await load();
    const msgs = [];
    if (errors) msgs.push(`${errors} ${errors === 1 ? 'tarefa não pôde ser criada' : 'tarefas não puderam ser criadas'}.`);
    if (warnings) msgs.push(`${warnings} ${warnings === 1 ? 'tarefa foi criada' : 'tarefas foram criadas'} sem Tamanho; ajuste na tela Tamanhos e UST.`);
    if (msgs.length) showError(`${msgs.join(' ')} Veja a coluna Resultado.`);
  } catch (e) {
    // Pedido recusado pelo app (validação): nada foi criado; a prévia continua aberta para ajustar.
    if (e.status === 400 || e.status === 404) {
      showError(e.message, 'previewError');
      setBusy(false);
      renderPreview();
      $('btnCancel').disabled = false;
      return;
    }
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
  if ($('previewDialog').open) state.refreshPreview?.();
}

// ---------- modelos ----------
async function loadTemplates() {
  showError('', 'templatesError');
  try {
    const r = await api('/api/support/templates');
    state.templates = r.templates;
    state.canEdit = r.canEdit;
    state.lastUsedId = r.lastUsedId;
  } catch (e) {
    state.templates = [];
    showError(`Não foi possível carregar os modelos: ${e.message}`, 'templatesError');
  }
  renderTemplates();
}

function renderTemplates() {
  $('btnNewTemplate').hidden = !state.canEdit;
  $('templatesNote').hidden = state.canEdit;
  const tbody = $('templates');
  if (!state.templates.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 5, class: 'muted' }, 'Nenhum modelo disponível.')));
    return;
  }
  tbody.replaceChildren(...state.templates.map((t) => {
    const actions = el('td', { class: 'row-actions' });
    if (t.canEdit) {
      const edit = el('button', { type: 'button', class: 'link' }, 'editar');
      edit.addEventListener('click', () => openEditor(t));
      const del = el('button', { type: 'button', class: 'link' }, 'excluir');
      del.addEventListener('click', () => removeTemplate(t, del));
      // O modelo do sistema ("Padrão") pode ser editado, não excluído.
      actions.append(edit, ...(t.system ? [] : [del]));
    }
    return el('tr', {},
      el('td', {}, t.name),
      el('td', {}, t.public ? 'público' : 'privado'),
      el('td', {}, t.system ? 'sistema' : (t.mine ? 'você' : (t.ownerName ?? '—'))),
      el('td', { class: 'wrap' }, t.items.map((i) => `${i.cat} ${i.size}`).join(' · ')),
      actions);
  }));
}

async function removeTemplate(t, button) {
  if (!confirm(`Excluir o modelo "${t.name}"? Quem usa este modelo volta para o Padrão.`)) return;
  button.disabled = true;
  try {
    await api(`/api/support/templates/${encodeURIComponent(t.id)}`, undefined, 'DELETE');
    await loadTemplates();
    renderItems();
  } catch (e) {
    showError(`Não foi possível excluir: ${e.message}`, 'templatesError');
    button.disabled = false;
  }
}

const editor = { id: null, rows: [] };
function openEditor(t) {
  editor.id = t?.id ?? null;
  editor.rows = t ? t.items.map((i) => ({ ...i })) : [newEditorRow()];
  $('templateTitle').textContent = t ? `Editar modelo “${t.name}”` : 'Novo modelo';
  $('tplName').value = t?.name ?? '';
  $('tplPublic').checked = Boolean(t?.public);
  showError('', 'tplError');
  renderEditor();
  $('templateDialog').showModal();
}

function newEditorRow() {
  return { cat: '', size: '', summary: '', description: '', auto: true };
}

function renderEditor() {
  $('btnTplAdd').disabled = editor.rows.length >= LIMITS.items || !state.cats.size;
  $('tplItems').replaceChildren(...editor.rows.map((r, n) => {
    const title = el('input', { type: 'text', class: 'tk-title', value: r.summary, maxLength: LIMITS.summary, 'aria-label': 'Título' });
    title.addEventListener('input', () => { r.summary = title.value; r.auto = false; });
    const [catSel, sizeSel, sizeNote] = catControls(r, { onCat: () => { if (r.auto) { r.summary = defaultTitle(r.cat); title.value = r.summary; } } });
    const desc = el('textarea', { rows: 2, value: r.description ?? '', maxLength: LIMITS.description, placeholder: 'Descrição (opcional)', 'aria-label': 'Descrição' });
    desc.addEventListener('input', () => { r.description = desc.value; });
    const move = (d) => { const [x] = editor.rows.splice(n, 1); editor.rows.splice(n + d, 0, x); renderEditor(); };
    const up = el('button', { type: 'button', class: 'link', disabled: n === 0, title: 'Subir' }, 'subir');
    up.addEventListener('click', () => move(-1));
    const down = el('button', { type: 'button', class: 'link', disabled: n === editor.rows.length - 1, title: 'Descer' }, 'descer');
    down.addEventListener('click', () => move(1));
    const remove = el('button', { type: 'button', class: 'link', disabled: editor.rows.length === 1, title: 'Remover tarefa' }, 'remover');
    remove.addEventListener('click', () => { editor.rows.splice(n, 1); renderEditor(); });
    return el('div', { class: 'tk-row' },
      el('div', { class: 'tk-head' }, el('strong', {}, `${n + 1}.`), catSel, sizeSel, title),
      desc,
      sizeNote,
      el('div', { class: 'tk-tools' }, up, down, remove));
  }));
}

async function saveTemplate() {
  const body = {
    name: $('tplName').value.trim(),
    public: $('tplPublic').checked,
    items: editor.rows.map((r) => ({ cat: r.cat, size: r.size, summary: r.summary.trim(), description: (r.description ?? '').trim() })),
  };
  if (!body.name) return showError('Informe o nome do modelo.', 'tplError');
  const missing = body.items.findIndex((i) => !i.cat || !i.size || !i.summary);
  if (missing >= 0) return showError(`Tarefa ${missing + 1}: escolha CAT e tamanho e preencha o título.`, 'tplError');
  $('btnTplSave').disabled = true;
  try {
    if (editor.id) await api(`/api/support/templates/${encodeURIComponent(editor.id)}`, body, 'PUT');
    else await api('/api/support/templates', body);
    $('templateDialog').close();
    await loadTemplates();
    renderItems();
  } catch (e) {
    showError(e.message, 'tplError');
  } finally {
    $('btnTplSave').disabled = false;
  }
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
  $('previewTemplate').addEventListener('change', async () => {
    const sel = $('previewTemplate');
    const pv = state.preview;
    const edited = pv.epics.some((e) => e.rows.some((r) => !r.loose && r.edited));
    if (edited && !confirm('Trocar o modelo descarta as alterações feitas nas tarefas do modelo atual (as tarefas avulsas ficam). Continuar?')) {
      sel.value = pv.templateId ?? '';
      return;
    }
    const keep = new Map(pv.epics.map((e) => [e.epic, e.rows.filter((r) => r.loose)]));
    sel.disabled = true;
    state.busy = true;
    $('btnConfirm').disabled = true;
    showError('', 'previewError');
    try { await loadPreview(sel.value, keep); } catch (e) {
      sel.value = pv.templateId ?? '';
      showError(`Não foi possível trocar o modelo: ${e.message}`, 'previewError');
    } finally {
      sel.disabled = false;
      state.busy = false;
      renderPreview();
    }
  });
  // Esc não fecha a prévia enquanto a criação está em andamento.
  $('previewDialog').addEventListener('cancel', (ev) => { if (state.busy) ev.preventDefault(); });
  $('selectAll').addEventListener('change', (ev) => {
    for (const i of state.items.filter(selectable)) ev.target.checked ? state.selected.add(i.key) : state.selected.delete(i.key);
    renderItems();
  });
  $('btnNewTemplate').addEventListener('click', () => openEditor(null));
  $('btnTplAdd').addEventListener('click', () => { editor.rows.push(newEditorRow()); renderEditor(); });
  $('btnTplCancel').addEventListener('click', () => $('templateDialog').close());
  $('btnTplSave').addEventListener('click', saveTemplate);

  const catalog = await api('/api/ust/catalogo').catch(() => ({ items: [] }));
  setCatalog(catalog.items ?? []);
  await loadTemplates();
  if (config.tokenConfigured) await load();
  else renderItems();
}

init();
