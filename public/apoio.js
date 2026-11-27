// Tela "Tarefas de apoio": lista itens atribuídos (com a agrupadora e as subtarefas de cada épico),
// mantém os rascunhos de atividades e cria, pelo assistente, a agrupadora do épico, as subtarefas e
// os apontamentos. Texto vindo do Jira ou dos rascunhos entra sempre por textContent/value.
import { parseDuration, formatDuration } from '/lib/time.js';
import {
  PHASES, DEFAULT_PERCENT, GROUP_LIMITS, GROUP_TITLE, subtaskCount, shortageMessage, proposeSubtasks, describeBlock,
  moveActivity, isValidPartition, splitByPercent, hoursProblems, fmtHours, activityLine,
} from '/lib/groupPlan.js';

const $ = (id) => document.getElementById(id);
const MODEL_LABEL = { analise: 'Análise', implementacao: 'Implementação' };
const SIZE_ORDER = ['P', 'M', 'G', 'Hora'];
const LIMITS = { name: 80 };
const PHASE_LABEL = Object.fromEntries(PHASES.map((p) => [p.id, p.label]));
const STORE_KEY = 'apontar.schedule'; // expediente salvo em "Apontar horas" (limite diário)
const STEPS = ['Agrupadora', 'Atividades', 'Horas', 'Subtarefas', 'Apontamento', 'Prévia'];
const state = {
  items: [], selected: null, results: new Map(), busy: false, collapsed: new Set(),
  cats: new Map(), // catálogo de UST: CAT → { task, sizes }
  actions: [], // [{ action, phase }]
  templates: [], canEdit: false, lastUsedId: null,
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

const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDate = (d) => d.split('-').reverse().join('/');
function dailyLimit() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
    return Number.isInteger(saved.dailyLimit) && saved.dailyLimit >= 15 && saved.dailyLimit <= 1440 ? saved.dailyLimit : 480;
  } catch { return 480; }
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

// ---------- itens atribuídos ----------
const selectable = (i) => i.isEpic;

// Árvore: o épico na linha de cima e, abaixo, as tarefas de apoio antigas, a agrupadora e as subtarefas dela.
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
    const box = el('input', { type: 'radio', name: 'epicPick', checked: state.selected === i.key, disabled: !selectable(i) || state.busy, 'aria-label': `Escolher ${i.key}` });
    box.title = i.isEpic ? '' : 'Só épicos recebem tarefas de apoio';
    box.addEventListener('change', () => { state.selected = box.checked ? i.key : null; updateButtons(); });
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
    const slot = (t, extra = '') => el('div', { class: `slot${/conclu/i.test(t.status ?? '') ? ' done' : ''}${extra}`, title: t.summary ?? '' },
      el('span', { class: 'slot-label' }, t.group ? 'Agrupadora (CAT-87)' : taskLabel(t), t.size ? ` (${t.size})` : '', t.subtaskOf ? ` · subtarefa de ${t.subtaskOf}` : ''),
      link(t.key, t.url), el('span', { class: 'slot-status' }, t.status ?? ''));
    const groups = i.existing.filter((t) => t.group);
    const slots = [
      ...i.existing.filter((t) => !t.group).map((t) => slot(t)),
      ...groups.flatMap((g) => [slot(g, ' group'), ...(g.subtasks ?? []).map((s) => slot({ ...s, subtaskOf: g.key }, ' sub'))]),
    ];
    if (!groups.length) {
      slots.push(el('div', { class: 'slot todo' }, el('span', { class: 'slot-label' }, 'Agrupadora (CAT-87)'),
        el('span', { class: 'slot-missing' }, 'ainda não existe'), el('span', { class: 'slot-will' }, 'será criada')));
    }
    rows.push(el('tr', { class: 'tree-child slots-row' }, el('td'), el('td', { colSpan: 5 }, el('div', { class: 'slots' }, ...slots))));
  }
  tbody.replaceChildren(...rows);
  updateButtons();
}

function renderResult(key) {
  const r = state.results.get(key);
  if (!r) return [];
  const out = [];
  const line = (label, step) => {
    if (out.length) out.push(el('br'));
    if (step.status === 'created' || step.status === 'existing') out.push(el('span', { class: 'ok' }, `${label}: ${step.status === 'created' ? 'criada' : 'usada'} `), link(step.key, step.url), step.warning ? el('span', { class: 'bad' }, ` — ${step.warning}`) : null);
    else if (step.status === 'skipped') out.push(el('span', { class: 'muted' }, `${label}: não feita`));
    else out.push(el('span', { class: 'bad' }, `${label}: erro — ${step.error}`));
  };
  line('Agrupadora', r.group);
  r.subtasks.forEach((s, n) => line(`Subtarefa ${n + 1}`, s));
  const ok = r.worklogs.filter((w) => w.status === 'created').length;
  out.push(el('br'), el('span', { class: ok === r.worklogs.length ? 'ok' : 'bad' }, `Apontamentos: ${ok} de ${r.worklogs.length} gravados`));
  return out;
}

function updateButtons() {
  if (state.selected && !state.items.some((i) => i.key === state.selected && selectable(i))) state.selected = null;
  $('btnCreate').disabled = !state.selected || state.busy;
  $('btnCreate').textContent = state.selected ? `Criar tarefa de apoio em ${state.selected}` : 'Criar tarefa de apoio';
  $('btnRefresh').disabled = state.busy;
  const epicCount = state.items.filter((i) => i.isEpic).length;
  $('btnToggleAll').textContent = epicCount && state.collapsed.size >= epicCount ? 'Expandir tudo' : 'Recolher tudo';
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

// ---------- assistente ----------
// wz: estado do assistente; step 0–5 (Agrupadora … Prévia).
let wz = null;
const phaseOf = (action) => state.actions.find((a) => a.action === action)?.phase ?? null;
const withPhase = (list) => list.map((a) => ({ ...a, phase: phaseOf(a.action) }));
const totalMin = () => parseDuration(wz.totalText);

function newWizard(epicKey) {
  return {
    epicKey, step: 0, status: null, epic: null, groupSummary: GROUP_TITLE,
    activities: [{ action: '', text: '' }], totalText: '', blocks: null, subs: [],
    mode: 'percent', percents: { ...DEFAULT_PERCENT }, manual: [], startDate: isoLocal(new Date()), startTime: '08:00', limit: dailyLimit(),
    worklogs: null, preview: null, templateId: null, busy: false, draftName: '', draftPublic: false,
  };
}

async function openWizard() {
  wz = newWizard(state.selected);
  showError('', 'wzError');
  $('wizardDialog').showModal();
  renderWizard();
  await loadGroup();
}

async function loadGroup() {
  wz.busy = true;
  renderWizard();
  try {
    const r = await api(`/api/support/group?epic=${encodeURIComponent(wz.epicKey)}`);
    wz.status = r.group;
    wz.epic = r.epic;
  } catch (e) {
    wz.status = { status: 'error', error: e.message };
  } finally {
    wz.busy = false;
    renderWizard();
  }
}

// Problema que impede avançar do passo atual ('' = pode).
function stepProblem() {
  if (wz.busy) return 'Aguarde…';
  switch (wz.step) {
    case 0:
      if (!wz.status) return 'Carregando a agrupadora…';
      if (wz.status.status === 'error') return wz.status.error;
      if (wz.status.status === 'conflict') return 'Corrija no Jira: o épico tem mais de uma agrupadora.';
      if (wz.status.status === 'new' && !wz.groupSummary.trim()) return 'Informe o título da agrupadora.';
      if (wz.groupSummary.trim().length > GROUP_LIMITS.title) return `Título com até ${GROUP_LIMITS.title} caracteres.`;
      return '';
    case 1: {
      if (!wz.activities.length) return 'Descreva ao menos uma atividade.';
      if (wz.activities.length > GROUP_LIMITS.activities) return `No máximo ${GROUP_LIMITS.activities} atividades.`;
      const k = wz.activities.findIndex((a) => !phaseOf(a.action));
      if (k >= 0) return `Atividade ${k + 1}: escolha a ação.`;
      const t = wz.activities.findIndex((a) => a.text.trim().length < GROUP_LIMITS.activityMin || a.text.trim().length > GROUP_LIMITS.activityMax);
      if (t >= 0) return `Atividade ${t + 1}: de ${GROUP_LIMITS.activityMin} a ${GROUP_LIMITS.activityMax} caracteres.`;
      return '';
    }
    case 2: {
      const m = totalMin();
      if (!m || m < GROUP_LIMITS.totalMin) return 'Informe o total de horas (0h15 a 200h, em blocos de 15 min).';
      return shortageMessage(m, wz.activities.length);
    }
    case 3: {
      const k = wz.subs.findIndex((s) => !s.cat || !s.size);
      if (k >= 0) return `Subtarefa ${k + 1}: escolha CAT e tamanho.`;
      const t = wz.subs.findIndex((s) => !s.summary.trim() || s.summary.trim().length > GROUP_LIMITS.title);
      if (t >= 0) return `Subtarefa ${t + 1}: título de 1 a ${GROUP_LIMITS.title} caracteres.`;
      const d = wz.subs.findIndex((s) => s.description.length > GROUP_LIMITS.description);
      if (d >= 0) return `Subtarefa ${d + 1}: descrição com até ${GROUP_LIMITS.description} caracteres.`;
      return '';
    }
    case 4: {
      const hp = hoursProblems(subMinutes(), totalMin());
      if (hp.length) return hp[0];
      if (wz.mode === 'percent' && PHASES.reduce((s, p) => s + (Number(wz.percents[p.id]) || 0), 0) !== 100) return 'Os percentuais precisam somar 100%.';
      if (!wz.worklogs) return 'Clique em Montar datas.';
      return gridProblem();
    }
    default:
      return wz.preview ? '' : 'Montando a prévia…';
  }
}

// Horas por subtarefa no modo escolhido.
function percentSplit() {
  return splitByPercent(totalMin(), wz.subs.map((s) => s.phase), wz.percents);
}
function subMinutes() {
  if (wz.mode === 'percent') return percentSplit().minutes;
  return wz.subs.map((_, i) => parseDuration(wz.manual[i] ?? '') ?? 0);
}

function gridProblem() {
  const sums = wz.subs.map(() => 0);
  for (const [k, w] of wz.worklogs.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) return `Apontamento ${k + 1}: data inválida.`;
    if (!/^\d{2}:\d{2}$/.test(w.start) || (Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3))) % 15) return `Apontamento ${k + 1}: início múltiplo de 15 min.`;
    const m = parseDuration(w.dur);
    if (!m || m > GROUP_LIMITS.entryMax) return `Apontamento ${k + 1}: duração de 15 min a 8h.`;
    if (Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3)) + m > 1440) return `Apontamento ${k + 1}: passa da meia-noite.`;
    if (w.comment.length > GROUP_LIMITS.comment) return `Apontamento ${k + 1}: comentário com até ${GROUP_LIMITS.comment} caracteres.`;
    sums[w.sub] += m;
  }
  const mins = subMinutes();
  const bad = sums.findIndex((s, i) => s !== mins[i]);
  if (bad >= 0) return `Subtarefa ${bad + 1}: os apontamentos somam ${fmtHours(sums[bad])}, mas ela tem ${fmtHours(mins[bad])}.`;
  return '';
}

// Proposta das subtarefas a partir das atividades (refeita quando a contagem ou as atividades mudam).
function ensureSubtasks() {
  const acts = withPhase(wz.activities);
  const n = subtaskCount(totalMin());
  const key = JSON.stringify([acts.map((a) => [a.action, a.text]), n]);
  if (wz.subsKey === key && wz.blocks && isValidPartition(wz.blocks, acts.length)) return;
  const prop = proposeSubtasks(acts, totalMin());
  if (prop.error) return;
  const old = wz.subs;
  wz.blocks = prop.subtasks.map((s) => s.activities);
  wz.subs = prop.subtasks.map((s, i) => ({ ...s, cat: old[i]?.cat ?? '', size: old[i]?.size ?? '', summaryEdited: false, descEdited: false }));
  wz.subsKey = key;
  wz.worklogs = null;
}

// Fase, título e descrição de uma subtarefa depois de mover atividades (textos editados ficam).
function refreshBlock(i) {
  const d = describeBlock(withPhase(wz.activities), wz.blocks[i]);
  const s = wz.subs[i];
  s.activities = wz.blocks[i];
  s.phase = d.phase;
  if (!s.summaryEdited) s.summary = d.summary;
  if (!s.descEdited) s.description = d.description;
}

function renderWizard() {
  if (!wz) return;
  $('wzTitle').textContent = `Criar tarefa de apoio${wz.epic ? ` — ${wz.epic.label}` : ` — ${wz.epicKey}`}`;
  $('wzSteps').replaceChildren(...STEPS.map((s, i) => el('li', { class: i === wz.step ? 'on' : i < wz.step ? 'done' : '' }, `${i + 1}. ${s}`)));
  const view = [stepGroup, stepActivities, stepHours, stepSubtasks, stepWorklogs, stepPreview][wz.step]();
  if (wz.result) $('wzBody').replaceChildren(...resultView());
  else $('wzBody').replaceChildren(...view);
  refreshNav();
}

function refreshNav() {
  const p = wz.result ? '' : stepProblem();
  $('wzHint').textContent = wz.result ? '' : p;
  $('wzBack').hidden = wz.step === 0 || Boolean(wz.result);
  $('wzBack').disabled = wz.busy;
  $('wzCancel').textContent = wz.result ? 'Fechar' : 'Cancelar';
  $('wzCancel').disabled = wz.busy;
  $('wzNext').hidden = Boolean(wz.result);
  $('wzNext').textContent = wz.step === 5 ? (wz.busy ? 'Gravando…' : 'Confirmar') : 'Continuar';
  $('wzNext').disabled = Boolean(p);
}

const field = (label, control, cls = '') => el('label', { class: cls }, label, control);
function textInput(value, props, onInput) {
  const x = el(props.tag ?? 'input', { ...props, value });
  x.addEventListener('input', () => { onInput(x.value); refreshNav(); });
  return x;
}

// Passo 1: agrupadora (criar ou usar).
function stepGroup() {
  const st = wz.status;
  if (!st) return [el('p', { class: 'muted' }, 'Verificando a agrupadora do épico…')];
  if (st.status === 'error') return [el('p', { class: 'bad' }, `Não foi possível verificar a agrupadora: ${st.error}`)];
  if (st.status === 'conflict') {
    return [el('p', { class: 'bad' }, `O épico ${wz.epicKey} tem mais de uma tarefa agrupadora: ${st.keys.join(', ')}. É um erro de cadastro: deixe só uma no Jira e abra o assistente de novo.`)];
  }
  if (st.status === 'existing') {
    return [el('p', {}, 'Usará ', link(st.key, st.url), ` — ${st.summary}. As novas subtarefas entram nela.`),
      st.subtasks.length ? el('p', { class: 'muted' }, `Já tem ${st.subtasks.length} ${st.subtasks.length === 1 ? 'subtarefa' : 'subtarefas'}: ${st.subtasks.map((s) => s.key).join(', ')}.`) : null];
  }
  return [el('p', {}, 'Será criada a tarefa agrupadora (Apoio › CAT-87, não contabilizada), com você como responsável e o épico como pai:'),
    field('Título', textInput(wz.groupSummary, { maxLength: GROUP_LIMITS.title, class: 'wide-input' }, (v) => { wz.groupSummary = v; }), 'wide'),
    el('p', { class: 'help' }, `{EPICO} vira “${wz.epic?.label ?? wz.epicKey}”.`)];
}

function actionSelect(a, onChange) {
  const sel = el('select', { 'aria-label': 'Ação' }, el('option', { value: '' }, 'ação'),
    ...PHASES.map((p) => el('optgroup', { label: p.label }, ...state.actions.filter((x) => x.phase === p.id).map((x) => el('option', { value: x.action }, x.action)))));
  sel.value = a.action;
  sel.addEventListener('change', () => { a.action = sel.value; onChange?.(); refreshNav(); });
  return sel;
}

// Linhas Ação + Atividade (usadas no assistente e no editor de rascunhos).
function activityRows(list, redraw) {
  return list.map((a, n) => {
    const text = textInput(a.text, { maxLength: GROUP_LIMITS.activityMax, class: 'tk-title', placeholder: 'atividade executada (10 a 300 caracteres)', 'aria-label': 'Atividade executada' }, (v) => { a.text = v; preview.textContent = activityLine(a); });
    const preview = el('div', { class: 'tk-note muted' }, a.action && a.text ? activityLine(a) : '');
    const move = (d) => { const [x] = list.splice(n, 1); list.splice(n + d, 0, x); redraw(); };
    const up = el('button', { type: 'button', class: 'link', disabled: n === 0 }, 'subir');
    up.addEventListener('click', () => move(-1));
    const down = el('button', { type: 'button', class: 'link', disabled: n === list.length - 1 }, 'descer');
    down.addEventListener('click', () => move(1));
    const remove = el('button', { type: 'button', class: 'link', disabled: list.length === 1 }, 'remover');
    remove.addEventListener('click', () => { list.splice(n, 1); redraw(); });
    return el('div', { class: 'tk-row' },
      el('div', { class: 'tk-head' }, el('strong', {}, `${n + 1}.`), actionSelect(a, () => { preview.textContent = activityLine(a); }), text),
      preview, el('div', { class: 'tk-tools' }, up, down, remove));
  });
}

// Passo 2: atividades, rascunhos.
function stepActivities() {
  const redraw = () => renderWizard();
  const add = el('button', { type: 'button', disabled: wz.activities.length >= GROUP_LIMITS.activities }, 'Adicionar atividade');
  add.addEventListener('click', () => { wz.activities.push({ action: '', text: '' }); redraw(); });
  const usable = state.templates.filter((t) => t.usable);
  const pick = el('select', { 'aria-label': 'Rascunho' }, el('option', { value: '' }, usable.length ? 'escolha um rascunho' : 'nenhum rascunho'),
    ...usable.map((t) => el('option', { value: t.id }, `${t.name}${t.public ? '' : ' (privado)'} · ${t.activities.length} atividades`)));
  pick.value = wz.templateId ?? state.lastUsedId ?? '';
  const loadBtn = el('button', { type: 'button', disabled: !usable.length }, 'Carregar rascunho');
  loadBtn.addEventListener('click', () => {
    const t = usable.find((x) => x.id === pick.value);
    if (!t) return;
    const hasText = wz.activities.some((a) => a.text.trim());
    if (hasText && !confirm('Carregar o rascunho substitui as atividades atuais. Continuar?')) return;
    wz.activities = t.activities.map((a) => ({ action: a.action, text: a.text }));
    wz.templateId = t.id;
    redraw();
  });
  const tools = [el('div', { class: 'tk-tools' }, add, el('span', { class: 'spacer' }), pick, loadBtn)];
  if (state.canEdit) {
    const name = textInput(wz.draftName, { maxLength: LIMITS.name, placeholder: 'nome do rascunho', 'aria-label': 'Nome do rascunho' }, (v) => { wz.draftName = v; });
    const pub = el('input', { type: 'checkbox', checked: wz.draftPublic });
    pub.addEventListener('change', () => { wz.draftPublic = pub.checked; });
    const save = el('button', { type: 'button' }, 'Salvar como rascunho');
    const note = el('span', { class: 'muted' });
    save.addEventListener('click', async () => {
      if (!wz.draftName.trim()) { note.textContent = 'Informe o nome do rascunho.'; return; }
      save.disabled = true;
      try {
        const { template } = await api('/api/support/templates', { name: wz.draftName.trim(), public: wz.draftPublic, activities: wz.activities.map((a) => ({ action: a.action, text: a.text.trim() })) });
        note.textContent = `Rascunho “${template.name}” salvo.`;
        wz.templateId = template.id;
        await loadTemplates();
      } catch (e) {
        note.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    });
    tools.push(el('div', { class: 'tk-tools' }, name, el('label', { class: 'inline' }, pub, 'Público'), save, note));
  }
  return [el('p', { class: 'help' }, 'Cada linha vira uma linha da descrição: a ação com a atividade, por exemplo “Analisar o script SQL e o documento de negócio”. A ação define a fase (Análise, Execução, Testes ou Produção).'),
    ...activityRows(wz.activities, redraw), ...tools];
}

// Passo 3: total de horas.
function stepHours() {
  const info = el('p');
  const update = () => {
    const m = totalMin();
    if (!m) { info.textContent = wz.totalText ? 'Total inválido (0h15 a 200h, em blocos de 15 min).' : ''; info.className = 'bad'; return; }
    const n = subtaskCount(m);
    const short = shortageMessage(m, wz.activities.length);
    info.className = short ? 'bad' : '';
    info.textContent = short || `${fmtHours(m)} = ${n} ${n === 1 ? 'subtarefa' : 'subtarefas'} (uma a cada 7h30).`;
  };
  const total = textInput(wz.totalText, { class: 'short', placeholder: 'ex.: 40h', 'aria-label': 'Total de horas' }, (v) => { wz.totalText = v; update(); });
  update();
  return [field('Total de horas ', total), info, el('p', { class: 'help' }, 'De 0h15 a 200h, em blocos de 15 min. Exemplos: 7h30 dá 1 subtarefa; 8h dá 2; 40h dá 6.')];
}

// Passo 4: subtarefas propostas (CAT, tamanho, título, descrição; mover atividades entre vizinhas).
function stepSubtasks() {
  ensureSubtasks();
  const acts = withPhase(wz.activities);
  const cats = [...state.cats.keys()].sort((a, b) => catNum(a) - catNum(b));
  const cards = wz.subs.map((s, i) => {
    const catSel = el('select', { class: 'tk-cat', 'aria-label': 'CAT' }, el('option', { value: '' }, 'escolha o CAT'),
      ...cats.map((c) => el('option', { value: c }, catTask(c) ? `${c} · ${catTask(c)}` : c)));
    catSel.value = s.cat;
    const sizeSel = el('select', { class: 'tk-size', 'aria-label': 'Tamanho' });
    const fillSizes = () => {
      const sizes = state.cats.get(s.cat)?.sizes ?? [];
      if (!sizes.includes(s.size)) s.size = '';
      sizeSel.replaceChildren(el('option', { value: '' }, 'tamanho'), ...sizes.map((z) => el('option', { value: z }, z)));
      sizeSel.value = s.size;
    };
    fillSizes();
    catSel.addEventListener('change', () => { s.cat = catSel.value; fillSizes(); refreshNav(); });
    sizeSel.addEventListener('change', () => { s.size = sizeSel.value; refreshNav(); });
    const title = textInput(s.summary, { class: 'tk-title', maxLength: GROUP_LIMITS.title, 'aria-label': 'Título' }, (v) => { s.summary = v; s.summaryEdited = true; });
    const desc = textInput(s.description, { tag: 'textarea', rows: 3, maxLength: GROUP_LIMITS.description, 'aria-label': 'Descrição' }, (v) => { s.description = v; s.descEdited = true; });
    const moves = [];
    if (i > 0) {
      const b = el('button', { type: 'button', class: 'link', disabled: s.activities.length < 2 }, '← 1ª atividade para a anterior');
      b.addEventListener('click', () => { wz.blocks = moveActivity(wz.blocks, i, -1) ?? wz.blocks; refreshBlock(i); refreshBlock(i - 1); wz.worklogs = null; renderWizard(); });
      moves.push(b);
    }
    if (i < wz.subs.length - 1) {
      const b = el('button', { type: 'button', class: 'link', disabled: s.activities.length < 2 }, 'última atividade para a próxima →');
      b.addEventListener('click', () => { wz.blocks = moveActivity(wz.blocks, i, 1) ?? wz.blocks; refreshBlock(i); refreshBlock(i + 1); wz.worklogs = null; renderWizard(); });
      moves.push(b);
    }
    return el('div', { class: 'tk-row' },
      el('div', { class: 'tk-head' }, el('strong', {}, `Subtarefa ${i + 1}`), el('span', { class: 'badge' }, PHASE_LABEL[s.phase]), catSel, sizeSel),
      el('ol', { class: 'wz-acts', start: s.activities[0] + 1 }, ...s.activities.map((k) => el('li', {}, activityLine(acts[k])))),
      field('Título', title, 'wide'), field('Descrição', desc, 'wide'),
      el('div', { class: 'tk-tools' }, ...moves));
  });
  const empty = state.cats.size ? [] : [el('p', { class: 'bad' }, 'O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.')];
  return [el('p', { class: 'help' }, 'As atividades foram distribuídas em ordem entre as subtarefas; cada uma fica com a fase da maioria das suas ações. Escolha CAT e tamanho de cada subtarefa (só os do catálogo de UST).'), ...empty, ...cards];
}

// Passo 5: divisão das horas e grade de datas.
function stepWorklogs() {
  const total = totalMin();
  // Horas, data ou início mudaram: a grade de datas deixa de valer e some da tela na hora.
  const gridHolder = el('div');
  let build = null;
  const invalidate = () => {
    if (!wz.worklogs) return;
    wz.worklogs = null;
    gridHolder.replaceChildren(el('p', { class: 'tk-note' }, 'As horas ou as datas mudaram: clique em Montar datas para refazer a grade.'));
    if (build) build.textContent = 'Montar datas';
  };
  const mode = (value, text) => {
    const r = el('input', { type: 'radio', name: 'wzMode', value, checked: wz.mode === value });
    r.addEventListener('change', () => { wz.mode = value; if (value === 'manual' && !wz.manual.length) wz.manual = percentSplit().minutes.map(formatDuration); invalidate(); renderWizard(); });
    return el('label', { class: 'inline' }, r, text);
  };
  const parts = [el('div', { class: 'tk-tools' }, el('strong', {}, 'Modo de divisão'), mode('percent', 'Dividir por percentual'), mode('manual', 'Uma a uma'))];
  const hoursInfo = el('div', { class: 'muted' });
  const showHours = () => {
    const mins = subMinutes();
    hoursInfo.textContent = wz.subs.map((s, i) => `Subtarefa ${i + 1} (${PHASE_LABEL[s.phase]}): ${mins[i] ? fmtHours(mins[i]) : '—'}`).join(' · ');
    if (wz.mode === 'percent' && percentSplit().adjusted) hoursInfo.textContent += ' — ajustado para o máximo de 7h30 por subtarefa.';
  };
  if (wz.mode === 'percent') {
    const present = new Set(wz.subs.map((s) => s.phase));
    parts.push(el('div', { class: 'tk-tools' }, ...PHASES.map((p) => {
      const x = textInput(String(wz.percents[p.id]), { type: 'number', min: 0, max: 100, step: 5, class: 'short', 'aria-label': `% ${p.label}` }, (v) => { wz.percents[p.id] = Number(v) || 0; invalidate(); showHours(); });
      return el('label', { class: `inline${present.has(p.id) ? '' : ' muted'}`, title: present.has(p.id) ? '' : 'Sem subtarefa nesta fase: o percentual é redistribuído' }, `${p.label} `, x, '%');
    })));
  } else {
    parts.push(el('div', { class: 'tk-tools' }, ...wz.subs.map((s, i) => el('label', { class: 'inline' }, `Subtarefa ${i + 1} `,
      textInput(wz.manual[i] ?? '', { class: 'short', placeholder: 'ex.: 7h30', 'aria-label': `Horas da subtarefa ${i + 1}` }, (v) => { wz.manual[i] = v; invalidate(); showHours(); })))));
  }
  showHours();
  parts.push(hoursInfo, el('p', { class: 'help' }, `A soma tem que fechar ${fmtHours(total)}, com no máximo 7h30 por subtarefa.`));
  const date = textInput(wz.startDate, { type: 'date', 'aria-label': 'Data inicial' }, (v) => { wz.startDate = v; invalidate(); });
  const start = textInput(wz.startTime, { type: 'time', step: 900, 'aria-label': 'Hora de início' }, (v) => { wz.startTime = v; invalidate(); });
  build = el('button', { type: 'button', disabled: wz.busy }, wz.worklogs ? 'Montar datas de novo' : 'Montar datas');
  build.addEventListener('click', buildGrid);
  parts.push(el('div', { class: 'tk-tools' }, field('Data inicial ', date), field('Início ', start), el('span', { class: 'muted' }, `limite diário ${fmtHours(wz.limit)} (de Apontar horas)`), build));
  if (wz.worklogs) gridHolder.append(gridView());
  parts.push(gridHolder);
  return parts;
}

async function buildGrid() {
  showError('', 'wzError');
  const hp = hoursProblems(subMinutes(), totalMin());
  if (hp.length) { showError(hp[0], 'wzError'); return; }
  wz.busy = true;
  renderWizard();
  let err = null;
  try {
    const r = await api('/api/support/group/preview', requestBody({ withGrid: false }));
    wz.worklogs = r.worklogs.map((w) => ({ sub: w.sub, date: w.date, start: w.start, dur: formatDuration(w.minutes), comment: w.comment }));
    if (r.unallocated) showError(`Não coube ${fmtHours(r.unallocated)} na distribuição; ajuste a grade.`, 'wzError');
  } catch (e) {
    err = e;
    showError(e.message, 'wzError');
  } finally {
    wz.busy = false;
    renderWizard();
  }
  if (err) await recheckGroup(err);
}

function gridView() {
  const rows = wz.worklogs.map((w, k) => {
    const sub = el('select', { 'aria-label': 'Subtarefa' }, ...wz.subs.map((_, i) => el('option', { value: String(i) }, `Subtarefa ${i + 1}`)));
    sub.value = String(w.sub);
    sub.addEventListener('change', () => { w.sub = Number(sub.value); refreshNav(); });
    const remove = el('button', { type: 'button', class: 'link' }, 'remover');
    remove.addEventListener('click', () => { wz.worklogs.splice(k, 1); renderWizard(); });
    return el('tr', {},
      el('td', {}, sub),
      el('td', {}, textInput(w.date, { type: 'date', 'aria-label': 'Data' }, (v) => { w.date = v; })),
      el('td', {}, textInput(w.start, { type: 'time', step: 900, 'aria-label': 'Início' }, (v) => { w.start = v; })),
      el('td', {}, textInput(w.dur, { class: 'short', 'aria-label': 'Duração' }, (v) => { w.dur = v; })),
      el('td', {}, textInput(w.comment, { maxLength: GROUP_LIMITS.comment, 'aria-label': 'Comentário' }, (v) => { w.comment = v; })),
      el('td', {}, remove));
  });
  const add = el('button', { type: 'button', class: 'link' }, '+ Adicionar apontamento');
  add.addEventListener('click', () => { const last = wz.worklogs.at(-1); wz.worklogs.push({ sub: last?.sub ?? 0, date: last?.date ?? wz.startDate, start: '08:00', dur: '1h', comment: wz.subs[last?.sub ?? 0].summary }); renderWizard(); });
  return el('div', {},
    el('table', { class: 'small' }, el('thead', {}, el('tr', {}, ...['Subtarefa', 'Data', 'Início', 'Duração', 'Comentário', ''].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows)),
    el('div', { class: 'tk-tools' }, add));
}

// Corpo da prévia/criação (o servidor revalida tudo).
function requestBody({ withGrid = true } = {}) {
  const mins = subMinutes();
  const toMin = (s) => parseDuration(s) ?? 0;
  return {
    epicKey: wz.epicKey,
    group: wz.status.status === 'existing' ? { key: wz.status.key } : { summary: wz.groupSummary.trim() },
    activities: wz.activities.map((a) => ({ action: a.action, text: a.text.trim() })),
    totalMinutes: totalMin(),
    subtasks: wz.subs.map((s, i) => ({ activities: s.activities, cat: s.cat, size: s.size, summary: s.summary.trim(), description: s.description.trim(), minutes: mins[i] })),
    mode: wz.mode,
    ...(wz.mode === 'percent' ? { percents: Object.fromEntries(PHASES.map((p) => [p.id, Number(wz.percents[p.id]) || 0])) } : {}),
    startDate: wz.startDate, startTime: wz.startTime, dailyLimit: wz.limit,
    ...(withGrid && wz.worklogs ? { worklogs: wz.worklogs.map((w) => ({ sub: w.sub, date: w.date, start: w.start, minutes: toMin(w.dur), comment: w.comment.trim() })) } : {}),
    ...(wz.templateId ? { templateId: wz.templateId } : {}),
  };
}

// Depois de um 409 (ou falha de rede), relê a agrupadora: se mudou (criada em outro lugar ou pela
// tentativa anterior), volta ao passo 1 mostrando a nova situação, sem perder o resto do assistente.
async function recheckGroup(e) {
  if (!wz || (e.status !== 409 && e.status !== undefined && e.status < 500)) return;
  const before = JSON.stringify([wz.status?.status, wz.status?.key]);
  await loadGroup();
  if (JSON.stringify([wz.status?.status, wz.status?.key]) === before) return;
  wz.step = 0;
  wz.preview = null;
  const now = wz.status.status === 'existing' ? `agora usará ${wz.status.key}` : wz.status.status === 'conflict' ? `o épico tem mais de uma agrupadora (${wz.status.keys.join(', ')})` : 'será criada';
  showError(`${e.message} A agrupadora foi relida: ${now}. Confira e continue; o resto do que você preencheu foi mantido.`, 'wzError');
  renderWizard();
}

async function loadPreview() {
  wz.preview = null;
  wz.busy = true;
  renderWizard();
  let err = null;
  try {
    wz.preview = await api('/api/support/group/preview', requestBody());
  } catch (e) {
    err = e;
    showError(e.message, 'wzError');
    wz.step = 4;
  } finally {
    wz.busy = false;
    renderWizard();
  }
  if (err) await recheckGroup(err);
}

// Passo 6: prévia.
function stepPreview() {
  const p = wz.preview;
  if (!p) return [el('p', { class: 'muted' }, 'Conferindo com o Jira…')];
  const g = p.group.status === 'existing'
    ? el('li', {}, 'Usar a agrupadora ', link(p.group.key, p.group.url), ` — ${p.group.summary}`)
    : el('li', {}, `Criar a agrupadora “${p.group.summary.replaceAll('{EPICO}', () => p.epic.label)}” (Apoio › CAT-87), pai ${p.epic.key}.`);
  const byDay = new Map();
  for (const w of p.worklogs) byDay.set(w.date, [...(byDay.get(w.date) ?? []), w]);
  return [el('p', { class: 'muted' }, 'Nada é gravado antes de confirmar. Ordem: agrupadora → subtarefas, uma por vez → apontamentos.'),
    el('ol', { class: 'dp-new-steps' }, g,
      ...p.subtasks.map((s, i) => el('li', {}, `Subtarefa ${i + 1}: “${s.summary}” — ${s.cat}, tamanho ${s.size}, ${PHASE_LABEL[s.phase]}, ${fmtHours(s.minutes)}.`))),
    el('strong', {}, 'Apontamentos por dia'),
    el('ul', { class: 'dp-new-steps' }, ...[...byDay].map(([d, list]) => el('li', {}, `${fmtDate(d)}: `,
      list.map((w) => `${w.start} ${fmtHours(w.minutes)} (subtarefa ${w.sub + 1})`).join(' · '))))];
}

async function confirmCreate() {
  showError('', 'wzError');
  let err = null;
  wz.busy = true;
  renderWizard();
  try {
    const r = await api('/api/support/group', requestBody());
    wz.result = r;
    state.results.set(wz.epicKey, r);
    if (wz.templateId) state.lastUsedId = wz.templateId;
  } catch (e) {
    err = e;
    // Recusado pelo app (validação ou sobreposição): nada foi gravado.
    if ([400, 404, 409].includes(e.status)) showError(`Nada foi gravado: ${e.message}`, 'wzError');
    else showError(`Falha ao criar: ${e.message}. Se foi falha de rede, o Jira pode ter criado parte: confira o épico no Jira antes de tentar de novo.`, 'wzError');
  } finally {
    wz.busy = false;
    renderWizard();
  }
  if (err) await recheckGroup(err);
  if (wz?.result) load();
}

// Nova tentativa depois de falha parcial, mantendo o que foi preenchido:
// - agrupadora falhou: volta ao passo 1 e relê a situação (se o Jira chegou a criá-la, passa a usá-la);
// - subtarefas falharam: cria só elas (com os apontamentos delas) na agrupadora já criada, uma por pedido.
async function retryFailed() {
  const r = wz.result;
  showError('', 'wzError');
  if (r.group.status !== 'created' && r.group.status !== 'existing') {
    wz.result = null;
    wz.preview = null;
    wz.step = 0;
    renderWizard();
    await loadGroup();
    return;
  }
  await loadGroup();
  if (wz.status.status !== 'existing') {
    showError(wz.status.status === 'conflict' ? `O épico tem mais de uma agrupadora (${wz.status.keys.join(', ')}); corrija no Jira.` : 'Não foi possível achar a agrupadora criada; atualize a tela e confira no Jira.', 'wzError');
    return;
  }
  const base = requestBody();
  wz.busy = true;
  renderWizard();
  for (const s of r.subtasks) {
    if (s.status === 'created') continue;
    const i = s.index;
    const sub = base.subtasks[i];
    const mine = base.worklogs.map((w, k) => ({ w, k })).filter(({ w }) => w.sub === i);
    const { percents, ...rest } = base;
    const req = {
      ...rest, group: { key: wz.status.key }, mode: 'manual',
      activities: sub.activities.map((k) => base.activities[k]), totalMinutes: sub.minutes,
      subtasks: [{ ...sub, activities: sub.activities.map((_, j) => j) }],
      worklogs: mine.map(({ w }) => ({ ...w, sub: 0 })),
    };
    try {
      const out = await api('/api/support/group', req);
      r.subtasks[i] = { ...out.subtasks[0], index: i };
      out.worklogs.forEach((w, j) => { r.worklogs[mine[j].k] = { ...w, index: mine[j].k, sub: i }; });
    } catch (e) {
      r.subtasks[i] = { index: i, status: 'error', error: e.message };
    }
  }
  r.group = { status: r.group.status, key: wz.status.key, url: wz.status.url };
  state.results.set(wz.epicKey, r);
  wz.busy = false;
  renderWizard();
  load();
}

function resultView() {
  const r = wz.result;
  const line = (label, step) => el('li', {}, `${label}${step.key ? ` ${step.key}` : ''}: `,
    el('span', { class: step.status === 'created' || step.status === 'existing' ? 'ok' : step.status === 'skipped' ? 'muted' : 'bad' },
      { created: 'criada', existing: 'usada', skipped: 'não feita', error: 'erro' }[step.status] ?? step.status),
    step.error ? ` — ${step.error}` : '', step.warning ? ` (aviso: ${step.warning})` : '');
  const wl = (w) => {
    const g = wz.preview.worklogs[w.index];
    return el('li', {}, `${fmtDate(g.date)} ${g.start} ${fmtHours(g.minutes)} (subtarefa ${w.sub + 1}): `,
      el('span', { class: w.status === 'created' ? 'ok' : w.status === 'skipped' ? 'muted' : 'bad' }, { created: 'gravado', skipped: 'não feito', error: 'erro' }[w.status] ?? w.status),
      w.error ? ` — ${w.error}` : '');
  };
  const failed = !['created', 'existing'].includes(r.group.status) || r.subtasks.some((s) => s.status !== 'created');
  const extra = [];
  if (failed) {
    const retry = el('button', { type: 'button', class: 'primary', disabled: wz.busy }, 'Tentar de novo o que falhou');
    retry.addEventListener('click', retryFailed);
    extra.push(el('div', { class: 'tk-tools' }, retry, el('span', { class: 'muted' }, 'O que já foi criado não é criado de novo; o resto do assistente fica como está.')));
  }
  if (r.worklogs.some((w) => w.status === 'error') && !failed) extra.push(el('p', { class: 'help' }, 'Os apontamentos com erro podem ser lançados nas subtarefas pela tela Apontar horas.'));
  return [el('strong', {}, 'Resultado'),
    el('ul', { class: 'dp-new-steps' }, line('Agrupadora', r.group), ...r.subtasks.map((s, i) => line(`Subtarefa ${i + 1}`, s))),
    el('strong', {}, 'Apontamentos'),
    el('ul', { class: 'dp-new-steps' }, ...r.worklogs.map(wl)), ...extra];
}

async function next() {
  if (stepProblem()) return;
  showError('', 'wzError');
  if (wz.step === 5) return confirmCreate();
  wz.step++;
  if (wz.step === 4 && wz.mode === 'manual' && wz.manual.length !== wz.subs.length) wz.manual = percentSplit().minutes.map(formatDuration);
  if (wz.step === 5) return loadPreview();
  renderWizard();
}

// ---------- rascunhos ----------
async function loadTemplates() {
  showError('', 'templatesError');
  try {
    const r = await api('/api/support/templates');
    state.templates = r.templates;
    state.canEdit = r.canEdit;
    state.lastUsedId = r.lastUsedId;
  } catch (e) {
    state.templates = [];
    showError(`Não foi possível carregar os rascunhos: ${e.message}`, 'templatesError');
  }
  renderTemplates();
}

function renderTemplates() {
  $('btnNewTemplate').hidden = !state.canEdit;
  $('templatesNote').hidden = state.canEdit;
  const tbody = $('templates');
  if (!state.templates.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 5, class: 'muted' }, 'Nenhum rascunho disponível.')));
    return;
  }
  tbody.replaceChildren(...state.templates.map((t) => {
    const actions = el('td', { class: 'row-actions' });
    if (t.canEdit) {
      const edit = el('button', { type: 'button', class: 'link' }, 'editar');
      edit.addEventListener('click', () => openEditor(t));
      const del = el('button', { type: 'button', class: 'link' }, 'excluir');
      del.addEventListener('click', () => removeTemplate(t, del));
      actions.append(edit, ...(t.system ? [] : [del]));
    }
    return el('tr', {},
      el('td', {}, t.name),
      el('td', {}, t.public ? 'público' : 'privado'),
      el('td', {}, t.system ? 'sistema' : (t.mine ? 'você' : (t.ownerName ?? '—'))),
      el('td', { class: 'wrap', title: t.activities.map(activityLine).join('\n') }, `${t.activities.length} · ${t.activities.slice(0, 3).map((a) => a.action).join(', ')}${t.activities.length > 3 ? '…' : ''}`),
      actions);
  }));
}

async function removeTemplate(t, button) {
  if (!confirm(`Excluir o rascunho "${t.name}"?`)) return;
  button.disabled = true;
  try {
    await api(`/api/support/templates/${encodeURIComponent(t.id)}`, undefined, 'DELETE');
    await loadTemplates();
  } catch (e) {
    showError(`Não foi possível excluir: ${e.message}`, 'templatesError');
    button.disabled = false;
  }
}

const editor = { id: null, rows: [] };
function openEditor(t) {
  editor.id = t?.id ?? null;
  editor.rows = t ? t.activities.map((a) => ({ ...a })) : [{ action: '', text: '' }];
  $('templateTitle').textContent = t ? `Editar rascunho “${t.name}”` : 'Novo rascunho';
  $('tplName').value = t?.name ?? '';
  $('tplPublic').checked = Boolean(t?.public);
  showError('', 'tplError');
  renderEditor();
  $('templateDialog').showModal();
}

function renderEditor() {
  $('btnTplAdd').disabled = editor.rows.length >= GROUP_LIMITS.activities;
  $('tplItems').replaceChildren(...activityRows(editor.rows, renderEditor));
}

async function saveTemplate() {
  const body = { name: $('tplName').value.trim(), public: $('tplPublic').checked, activities: editor.rows.map((a) => ({ action: a.action, text: a.text.trim() })) };
  if (!body.name) return showError('Informe o nome do rascunho.', 'tplError');
  const bad = body.activities.findIndex((a) => !a.action || a.text.length < GROUP_LIMITS.activityMin);
  if (bad >= 0) return showError(`Atividade ${bad + 1}: escolha a ação e descreva com ${GROUP_LIMITS.activityMin} a ${GROUP_LIMITS.activityMax} caracteres.`, 'tplError');
  $('btnTplSave').disabled = true;
  try {
    if (editor.id) await api(`/api/support/templates/${encodeURIComponent(editor.id)}`, body, 'PUT');
    else await api('/api/support/templates', body);
    $('templateDialog').close();
    await loadTemplates();
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
  $('btnCreate').addEventListener('click', openWizard);
  $('wzCancel').addEventListener('click', () => $('wizardDialog').close());
  // Voltar ao passo 1 relê a agrupadora (pode ter sido criada em outro lugar); o resto do assistente fica.
  $('wzBack').addEventListener('click', () => { if (wz && wz.step > 0) { wz.step--; showError('', 'wzError'); renderWizard(); if (wz.step === 0) loadGroup(); } });
  $('wzNext').addEventListener('click', next);
  // Esc não fecha o assistente enquanto grava.
  $('wizardDialog').addEventListener('cancel', (ev) => { if (wz?.busy) ev.preventDefault(); });
  $('wizardDialog').addEventListener('close', () => { if (wz?.result) renderItems(); wz = null; });
  $('btnNewTemplate').addEventListener('click', () => openEditor(null));
  $('btnTplAdd').addEventListener('click', () => { editor.rows.push({ action: '', text: '' }); renderEditor(); });
  $('btnTplCancel').addEventListener('click', () => $('templateDialog').close());
  $('btnTplSave').addEventListener('click', saveTemplate);

  const [catalog, actions] = await Promise.all([
    api('/api/ust/catalogo').catch(() => ({ items: [] })),
    api('/api/support/actions').catch(() => ({ actions: [] })),
  ]);
  setCatalog(catalog.items ?? []);
  state.actions = actions.actions ?? [];
  await loadTemplates();
  if (config.tokenConfigured) await load();
  else renderItems();
}

init();
