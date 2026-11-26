// Painel de batidas de um dia: edita início, duração, comentário, tarefa e data, ou exclui,
// e salva tudo de uma vez (POST /api/worklog/batch). O bloco "Novo apontamento" aponta ali mesmo,
// numa tarefa existente ou numa tarefa nova (POST /api/support/quick). Texto do Jira entra só por textContent.
import { parseDuration, formatDuration, hhmmToMin, minToHhmm } from '/lib/time.js';

const MODEL_LABEL = { analise: 'Análise', implementacao: 'Implementação' };
const STATUS_LABEL = { updated: 'alterada', moved: 'movida', deleted: 'excluída', duplicated: 'duplicada', error: 'erro' };

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

const fmtDate = (date) => date.split('-').reverse().join('/');

// tasks: [{ key, model, label, epicKey }] — destinos possíveis ao mudar a tarefa (tarefas de apoio;
// epicKey vazio = tarefa solta). epics: [{ key, summary }] (épicos do usuário em aberto); catalog: itens
// do catálogo de UST. onCreated({ reopen, notice }): depois de um novo apontamento (reopen = reabrir o
// painel com a batida nova e o aviso notice).
export function openDayPanel({ dialog, date, entries, tasks, limit, onSaved, onUsePeriod, epics = [], catalog = [], onCreated = () => {}, notice = '' }) {
  const rows = entries.map((e) => ({
    orig: e,
    taskKey: e.issueKey,
    date: e.date,
    start: e.start,
    dur: formatDuration(e.minutes),
    comment: e.comment ?? '',
    del: false,
    result: null,
  }));
  let busy = false;
  let quickBusy = false; // novo apontamento gravando: o resto do painel espera

  // Duração sem alteração no texto = minutos originais (sem arredondar batidas de 20m, 1h20m…).
  const durChanged = (r) => r.dur.trim() !== formatDuration(r.orig.minutes);
  const minutesOf = (r) => (durChanged(r) ? parseDuration(r.dur) : r.orig.minutes);
  const changed = (r) => r.del || r.taskKey !== r.orig.issueKey || r.date !== r.orig.date || r.start !== r.orig.start
    || durChanged(r) || r.comment.trim() !== (r.orig.comment ?? '').trim();

  function problems(r, i) {
    if (r.del) return '';
    const m = minutesOf(r);
    if (!m || m > 480) return 'Duração inválida (15 min a 8h).';
    if (!/^\d{2}:\d{2}$/.test(r.start)) return 'Início inválido.';
    if (r.start !== r.orig.start && hhmmToMin(r.start) % 15) return 'Novo início deve ser múltiplo de 15 min.';
    if (hhmmToMin(r.start) + m > 1440) return 'Passa da meia-noite.';
    const a = { s: hhmmToMin(r.start), e: hhmmToMin(r.start) + m };
    const hit = rows.findIndex((o, j) => j !== i && !o.del && o.date === r.date && minutesOf(o)
      && a.s < hhmmToMin(o.start) + minutesOf(o) && hhmmToMin(o.start) < a.e);
    return hit >= 0 ? `Sobrepõe a batida ${rows[hit].orig.issueKey} das ${rows[hit].start}.` : '';
  }

  function taskOptions(r) {
    const opts = [];
    if (!tasks.some((t) => t.key === r.orig.issueKey)) opts.push(el('option', { value: r.orig.issueKey }, `${r.orig.issueKey} (atual)`));
    for (const t of tasks) opts.push(el('option', { value: t.key }, [t.key, t.label ?? MODEL_LABEL[t.model] ?? t.model, t.epicKey || 'sem épico'].join(' · ')));
    const sel = el('select', { disabled: busy || r.del || Boolean(r.result) }, ...opts);
    sel.value = r.taskKey;
    sel.addEventListener('change', () => { r.taskKey = sel.value; render(); });
    return sel;
  }

  function render() {
    const body = dialog.querySelector('.dp-body');
    const total = rows.filter((r) => !r.del && r.date === date).reduce((s, r) => s + (minutesOf(r) ?? 0), 0);
    const pending = rows.filter((r) => !r.result && changed(r));
    const invalid = rows.some((r, i) => !r.result && changed(r) && problems(r, i));
    dialog.querySelector('.dp-title').textContent = `Batidas de ${fmtDate(date)}`;
    dialog.querySelector('.dp-total').textContent = `Total do dia: ${formatDuration(total || 0)} (meta ${formatDuration(limit)})`;
    dialog.querySelector('.dp-total').className = `dp-total ${total > limit ? 'over' : total === limit ? 'ok' : 'under'}`;
    if (!rows.length) {
      body.replaceChildren(el('p', { class: 'muted' }, 'Nenhuma batida neste dia.'));
    } else {
      body.replaceChildren(el('div', { class: 'grid-wrap' }, el('table', { class: 'items dp-table' },
        el('thead', {}, el('tr', {}, ...['Tarefa', 'Data', 'Início', 'Duração', 'Comentário', 'Excluir', 'Situação'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...rows.map((r, i) => {
          const lock = busy || Boolean(r.result);
          const input = (props, key) => {
            const x = el('input', { ...props, value: r[key], disabled: lock || r.del });
            x.addEventListener('change', () => { r[key] = x.value; render(); });
            return x;
          };
          const del = el('input', { type: 'checkbox', checked: r.del, disabled: lock, title: 'Excluir esta batida' });
          del.addEventListener('change', () => { r.del = del.checked; render(); });
          const issue = problems(r, i);
          const situation = r.result
            ? el('span', { class: r.result.status === 'error' || r.result.status === 'duplicated' ? 'bad' : 'ok' }, STATUS_LABEL[r.result.status] ?? r.result.status, r.result.error ? ` — ${r.result.error}` : '')
            : issue ? el('span', { class: 'bad' }, issue) : changed(r) ? el('span', { class: 'muted' }, r.del ? 'será excluída' : 'alterada') : '';
          return el('tr', { class: [r.del ? 'dp-del' : '', !r.result && changed(r) ? 'dp-changed' : ''].filter(Boolean).join(' '), title: r.orig.issueSummary ?? '' },
            el('td', {}, taskOptions(r)),
            el('td', {}, input({ type: 'date', class: 'dp-date' }, 'date')),
            el('td', {}, input({ type: 'time', step: 60, class: 'dp-start' }, 'start')),
            el('td', {}, input({ class: 'short dp-dur' }, 'dur')),
            el('td', { class: 'wrap' }, input({ class: 'comment dp-comment', maxLength: 1000 }, 'comment')),
            el('td', {}, del),
            el('td', { class: 'wrap' }, situation));
        })))));
    }
    const save = dialog.querySelector('.dp-save');
    save.disabled = busy || quickBusy || !pending.length || invalid;
    save.textContent = pending.length ? `Salvar alterações (${pending.length})` : 'Salvar alterações';
    dialog.querySelector('.dp-close').disabled = busy || quickBusy;
    dialog.querySelector('.dp-period').disabled = busy || quickBusy;
  }

  async function save() {
    const pending = rows.filter((r) => !r.result && changed(r));
    if (!pending.length) return;
    const nDel = pending.filter((r) => r.del).length;
    const nMove = pending.filter((r) => !r.del && r.taskKey !== r.orig.issueKey).length;
    const nUpd = pending.length - nDel - nMove;
    const ok = window.confirm(`Aplicar no Jira: ${nUpd} alteração(ões), ${nMove} mudança(s) de tarefa, ${nDel} exclusão(ões)?${nDel || nMove ? '\nExclusões e mudanças de tarefa não podem ser desfeitas.' : ''}`);
    if (!ok) return;
    const changes = pending.map((r) => (r.del
      ? { id: r.orig.id, issueKey: r.orig.issueKey, action: 'delete' }
      : { id: r.orig.id, issueKey: r.orig.issueKey, action: 'update', date: r.date, start: r.start, minutes: minutesOf(r), comment: r.comment, ...(r.orig.updated ? { updated: r.orig.updated } : {}), ...(r.taskKey !== r.orig.issueKey ? { targetKey: r.taskKey } : {}) }));
    busy = true;
    showError('');
    render();
    try {
      const res = await fetch('/api/worklog/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      for (const r of json.results) {
        const row = pending.find((p) => p.orig.id === r.id);
        if (row) row.result = r;
      }
      const moved = (json.transitions ?? []).filter((t) => t.status === 'moved').map((t) => `${t.key}: ${t.from} → ${t.to}`);
      if (moved.length) showInfo(`Status alterado: ${moved.join(' · ')}`);
      onSaved();
    } catch (e) {
      showError(`Nada foi gravado: ${e.message}`);
    } finally {
      busy = false;
      render();
    }
  }

  function showError(msg) {
    const box = dialog.querySelector('.dp-error');
    box.textContent = msg;
    box.hidden = !msg;
  }
  function showInfo(msg) {
    const box = dialog.querySelector('.dp-info');
    box.textContent = msg;
    box.hidden = !msg;
  }

  dialog.querySelector('.dp-save').onclick = save;
  dialog.querySelector('.dp-close').onclick = () => dialog.close();
  // Esc enquanto grava (lote ou novo apontamento) não fecha: o resultado chegaria num painel já trocado.
  dialog.oncancel = (e) => { if (busy || quickBusy) e.preventDefault(); };
  dialog.querySelector('.dp-period').onclick = () => { onUsePeriod(date); dialog.close(); };
  showError('');
  showInfo(notice);
  newEntryForm({
    box: dialog.querySelector('.dp-new'), button: dialog.querySelector('.dp-new-btn'), date, entries,
    tasks: [...tasks], epics: [...epics], catalog, limit, onDone: onCreated,
    setLocked: (v) => { quickBusy = v; render(); },
  });
  render();
  if (!dialog.open) dialog.showModal();
}

// ---------- Novo apontamento (POST /api/support/quick) ----------
// Tarefa existente ou nova (CAT do catálogo de UST, num épico seu, num épico novo ou solta), início e
// duração; valida na tela (sobreposição com as batidas do dia e limite diário), mostra a prévia e
// só grava ao confirmar. Resultado por passo: épico, tarefa e apontamento.
const SIZE_ORDER = ['P', 'M', 'G', 'Hora'];
const LIMITS = { summary: 255, description: 2000, comment: 1000, epicSummary: 255 };
const NO_EPIC = '__none';
const NEW_EPIC = '__new';
const STEP_LABEL = {
  epic: { created: 'criado', existing: 'existente', error: 'erro', skipped: 'não criado' },
  task: { created: 'criada', existing: 'existente', error: 'erro', skipped: 'não criada' },
  worklog: { created: 'gravado', error: 'erro', skipped: 'não feito' },
};

function catalogMap(items) {
  const cats = new Map();
  for (const i of items ?? []) {
    const c = cats.get(i.cat) ?? { task: i.task ?? '', sizes: [] };
    if (!c.sizes.includes(i.size)) c.sizes.push(i.size);
    cats.set(i.cat, c);
  }
  for (const c of cats.values()) c.sizes.sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
  return cats;
}
const catNum = (cat) => Number(String(cat).slice(4));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// box: a seção .dp-new; entries: batidas do dia vindas do Jira; tasks/epics/catalog: listas da tela.
// onDone({ reopen, notice }): recarrega calendário e listas (reopen = reabre o painel com a batida nova).
// setLocked(bool): trava o resto do painel enquanto grava.
function newEntryForm({ box, button, date, entries, tasks, epics, catalog, limit, onDone, setLocked }) {
  const cats = catalogMap(catalog);
  const catTask = (cat) => cats.get(cat)?.task ?? '';
  const day = entries.filter((e) => e.date === date);
  const dayTotal = day.reduce((s, e) => s + (e.minutes || 0), 0);
  const lastEnd = day.reduce((m, e) => Math.max(m, hhmmToMin(e.start) + (e.minutes || 0)), 0);
  const firstStart = day.length ? Math.min(Math.ceil(lastEnd / 15) * 15, 1440 - 15) : 8 * 60;
  const room = limit - dayTotal;
  const st = {
    open: false, stage: 'form', busy: false, error: '', result: null,
    mode: tasks.length ? 'existing' : 'new', taskKey: tasks[0]?.key ?? '',
    epic: '', spaceId: '', epicSummary: '', spaces: null, spacesError: '',
    cat: '', size: '', summary: '', summaryEdited: false, description: '',
    start: minToHhmm(firstStart), dur: formatDuration(room >= 15 && room < 60 ? room : 60), comment: '',
  };
  const epicOf = (key) => epics.find((e) => e.key === key);
  const isLoose = () => st.epic === NO_EPIC;
  const suggestTitle = () => (st.cat ? (isLoose() ? (catTask(st.cat) || st.cat) : `${catTask(st.cat) || st.cat} da demanda {EPICO}`) : '');
  const refreshTitle = () => { if (!st.summaryEdited) st.summary = suggestTitle(); };
  const minutes = () => parseDuration(st.dur);
  const spaceOf = (id) => st.spaces?.find((s) => s.id === id);
  // {EPICO} como o servidor vai gravar: "<chave> - <resumo do épico>".
  function renderedTitle() {
    const text = st.summary.trim();
    if (st.mode !== 'new' || isLoose()) return text;
    const label = st.epic === NEW_EPIC ? `<novo épico> - ${st.epicSummary.trim()}` : `${st.epic} - ${epicOf(st.epic)?.summary ?? ''}`;
    return cut(text.replaceAll('{EPICO}', () => label), LIMITS.summary);
  }

  function problem() {
    if (st.mode === 'existing') {
      if (!st.taskKey) return 'Escolha a tarefa.';
    } else {
      if (!st.epic) return 'Escolha o épico (ou Sem épico).';
      if (st.epic === NEW_EPIC) {
        if (!st.spaceId) return st.spacesError || 'Escolha o espaço do novo épico.';
        if (!st.epicSummary.trim()) return 'Informe o resumo do épico.';
        if (st.epicSummary.trim().length > LIMITS.epicSummary) return `Resumo do épico com até ${LIMITS.epicSummary} caracteres.`;
      }
      if (!st.cat) return 'Escolha o CAT.';
      if (!st.size) return 'Escolha o tamanho.';
      if (!st.summary.trim()) return 'Informe o título.';
      if (st.summary.trim().length > LIMITS.summary) return `Título com até ${LIMITS.summary} caracteres.`;
      if (st.description.length > LIMITS.description) return `Descrição com até ${LIMITS.description} caracteres.`;
      if (isLoose() && /\{EPICO\}/.test(st.summary + st.description)) return 'Tarefa sem épico: tire o {EPICO} do título e da descrição.';
    }
    if (!/^\d{2}:\d{2}$/.test(st.start)) return 'Início inválido.';
    if (hhmmToMin(st.start) % 15) return 'Início deve ser múltiplo de 15 min.';
    const m = minutes();
    if (!m || m < 15 || m > 480 || m % 15) return 'Duração de 15 min a 8h, em blocos de 15 min.';
    const s = hhmmToMin(st.start);
    if (s + m > 1440) return 'Passa da meia-noite.';
    if (st.comment.length > LIMITS.comment) return `Comentário com até ${LIMITS.comment} caracteres.`;
    const hit = day.find((e) => s < hhmmToMin(e.start) + e.minutes && hhmmToMin(e.start) < s + m);
    if (hit) return `Sobrepõe a batida ${hit.issueKey} das ${hit.start} (${formatDuration(hit.minutes)}).`;
    if (dayTotal + m > limit) return `Passa do limite diário de ${formatDuration(limit)}: ${room > 0 ? `ainda cabe ${formatDuration(room)} no dia` : 'o dia já está no limite'}.`;
    return '';
  }

  async function loadSpaces() {
    if (st.spaces) return;
    st.spaces = [];
    try {
      const res = await fetch('/api/support/spaces');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      st.spaces = json.spaces ?? [];
      st.spaceId = json.defaultId ?? (st.spaces.length === 1 ? st.spaces[0].id : '');
      st.spacesError = st.spaces.length ? '' : 'Nenhum espaço do Jira onde você possa criar épico.';
    } catch (e) {
      st.spaces = null;
      st.spacesError = `Espaços do Jira: ${e.message}`;
    }
    render();
  }

  const field = (label, control, cls = '') => el('label', { class: cls }, label, control);
  function input(key, { tag = 'input', ...props } = {}, { onInput } = {}) {
    const x = el(tag, { ...props, value: st[key], disabled: st.busy });
    x.addEventListener('input', () => { st[key] = x.value; onInput?.(); hint(); });
    return x;
  }
  function select(key, options, { onChange } = {}) {
    const x = el('select', { disabled: st.busy }, ...options.map(([v, text]) => el('option', { value: v }, text)));
    x.value = st[key];
    x.addEventListener('change', () => { st[key] = x.value; onChange?.(); render(); });
    return x;
  }

  let hintEl = null;
  let goBtn = null;
  function hint() {
    const p = problem();
    if (hintEl) hintEl.textContent = p;
    if (goBtn) goBtn.disabled = st.busy || Boolean(p);
  }

  function formView() {
    const kind = (value, text) => {
      const r = el('input', { type: 'radio', name: `dp-new-kind-${date}`, value, checked: st.mode === value, disabled: st.busy });
      r.addEventListener('change', () => { st.mode = value; render(); });
      return el('label', { class: 'inline' }, r, text);
    };
    const parts = [el('div', { class: 'actions dp-new-kind' }, el('strong', {}, 'Tarefa'), kind('existing', 'Tarefa existente'), kind('new', 'Nova tarefa'))];
    if (st.mode === 'existing') {
      parts.push(el('div', { class: 'dp-new-grid' }, field('Tarefa existente', select('taskKey', [
        ['', tasks.length ? 'escolha a tarefa' : 'nenhuma tarefa de apoio sua'],
        ...tasks.map((t) => [t.key, `${t.key} · ${t.label ?? MODEL_LABEL[t.model] ?? t.model} · ${t.epicKey || 'sem épico'}`]),
      ]), 'wide')));
    } else {
      const epicSel = select('epic', [
        ['', 'escolha o épico'],
        ...epics.map((e) => [e.key, cut(`${e.key} - ${e.summary}`, 90)]),
        [NO_EPIC, 'Sem épico (tarefa solta)'],
        [NEW_EPIC, 'Criar novo épico'],
      ], { onChange: () => { refreshTitle(); if (st.epic === NEW_EPIC) loadSpaces(); } });
      const grid = [field('Épico', epicSel, 'wide')];
      if (st.epic === NEW_EPIC) {
        const spaceSel = st.spaces?.length
          ? select('spaceId', [['', 'escolha o espaço'], ...st.spaces.map((s) => [s.id, `${s.name} (${s.key})`])])
          : el('select', { disabled: true }, el('option', { value: '' }, st.spacesError || 'carregando espaços…'));
        grid.push(field('Espaço', spaceSel), field('Resumo do épico', input('epicSummary', { maxLength: LIMITS.epicSummary, placeholder: 'resumo do novo épico' }), 'wide'));
      }
      const catSel = select('cat', [['', 'escolha o CAT'], ...[...cats.keys()].sort((a, b) => catNum(a) - catNum(b)).map((c) => [c, catTask(c) ? `${c} · ${catTask(c)}` : c])], {
        onChange: () => { if (!cats.get(st.cat)?.sizes.includes(st.size)) st.size = ''; refreshTitle(); },
      });
      const sizeSel = select('size', [['', 'escolha'], ...(cats.get(st.cat)?.sizes ?? []).map((s) => [s, s])]);
      grid.push(field('CAT', catSel, 'wide'), field('Tamanho', sizeSel),
        field('Título', input('summary', { maxLength: LIMITS.summary, title: '{EPICO} vira "<chave> - <resumo do épico>"' }, { onInput: () => { st.summaryEdited = true; } }), 'wide'),
        field('Descrição (opcional)', input('description', { tag: 'textarea', rows: 2, maxLength: LIMITS.description }), 'wide'));
      if (!cats.size) grid.push(el('p', { class: 'bad wide' }, 'O catálogo de UST está vazio: o administrador precisa importar a planilha na tela Catálogo.'));
      parts.push(el('div', { class: 'dp-new-grid' }, ...grid));
    }
    parts.push(el('div', { class: 'dp-new-grid' },
      field('Início', input('start', { type: 'time', step: 900 })),
      field('Duração', input('dur', { class: 'short', placeholder: '1h30m', title: '15 min a 8h, em blocos de 15 min' })),
      field('Comentário (opcional)', input('comment', { maxLength: LIMITS.comment }), 'wide')));
    hintEl = el('span', { class: 'bad' });
    goBtn = el('button', { class: 'primary' }, 'Continuar');
    goBtn.addEventListener('click', () => {
      if (problem()) return;
      st.stage = st.mode === 'new' && isLoose() ? 'loose' : 'preview';
      render();
    });
    const cancel = el('button', {}, 'Cancelar');
    cancel.addEventListener('click', () => { st.open = false; render(); });
    parts.push(el('div', { class: 'actions' }, hintEl, el('span', { class: 'spacer' }), cancel, goBtn));
    return parts;
  }

  function looseView() {
    const asIs = el('button', { class: 'primary' }, 'Criar sem épico');
    asIs.addEventListener('click', () => { st.stage = 'preview'; render(); });
    const withEpic = el('button', {}, 'Criar um épico');
    withEpic.addEventListener('click', () => { st.epic = NEW_EPIC; st.stage = 'form'; refreshTitle(); loadSpaces(); render(); });
    return [el('p', { class: 'dp-new-warn' }, 'Esta tarefa vai ficar solta, sem épico. Criar assim ou criar um épico?'),
      el('div', { class: 'actions' }, el('span', { class: 'spacer' }), withEpic, asIs)];
  }

  function steps() {
    const out = [];
    const m = minutes();
    if (st.mode === 'new') {
      if (st.epic === NEW_EPIC) {
        const sp = spaceOf(st.spaceId);
        out.push(`Criar o épico “${st.epicSummary.trim()}” no espaço ${sp ? `${sp.name} (${sp.key})` : st.spaceId}.`);
      }
      const parentText = isLoose() ? 'sem épico (tarefa solta)' : st.epic === NEW_EPIC ? 'pai: o épico novo' : `pai: ${st.epic}`;
      out.push(`Criar a tarefa “${renderedTitle()}” (${st.cat}, tamanho ${st.size}, ${parentText}).`);
    }
    const target = st.mode === 'existing' ? ` na tarefa ${st.taskKey}` : '';
    out.push(`Apontar ${formatDuration(m)}${target} em ${fmtDate(date)} às ${st.start}${st.comment.trim() ? `, com o comentário “${cut(st.comment.trim(), 80)}”` : ''}.`);
    return out;
  }

  function previewView() {
    const back = el('button', { disabled: st.busy }, 'Voltar');
    back.addEventListener('click', () => { st.stage = 'form'; render(); });
    const ok = el('button', { class: 'primary', disabled: st.busy }, st.busy ? 'Gravando…' : 'Confirmar');
    ok.addEventListener('click', submit);
    return [el('strong', {}, 'Prévia'), el('p', { class: 'muted' }, 'Nada é gravado antes de confirmar. O que será feito, em ordem:'),
      el('ol', { class: 'dp-new-steps' }, ...steps().map((s) => el('li', {}, s))),
      el('div', { class: 'actions' }, el('span', { class: 'spacer' }), back, ok)];
  }

  function body() {
    const task = st.mode === 'existing' ? { key: st.taskKey } : { cat: st.cat, size: st.size, summary: st.summary.trim(), description: st.description.trim() };
    const epic = st.mode === 'existing' || isLoose() ? null
      : st.epic === NEW_EPIC ? { new: { projectId: st.spaceId, summary: st.epicSummary.trim() } } : { key: st.epic };
    return { epic, task, worklog: { date, start: st.start, minutes: minutes(), comment: st.comment.trim() } };
  }

  async function submit() {
    st.busy = true;
    st.error = '';
    setLocked(true);
    render();
    try {
      const res = await fetch('/api/support/quick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      st.result = json;
      st.stage = 'result';
      if (json.worklog?.status === 'created') {
        const where = json.task?.key ? ` em ${json.task.key}` : '';
        onDone({ reopen: true, notice: `Apontamento gravado${where}: ${formatDuration(minutes())} às ${st.start}.${json.task?.warning ? ` Aviso: ${json.task.warning}` : ''}` });
        return;
      }
      // Falha parcial: o que foi criado passa a valer no formulário, para não criar de novo.
      if (json.epic?.status === 'created') {
        epics.push({ key: json.epic.key, summary: st.epicSummary.trim() });
        st.epic = json.epic.key;
      }
      if (json.task?.status === 'created') {
        tasks.push({ key: json.task.key, label: st.cat, epicKey: json.epic?.key ?? (isLoose() ? '' : st.epic) });
        st.mode = 'existing';
        st.taskKey = json.task.key;
      }
      if (json.epic?.status === 'created' || json.task?.status === 'created') onDone({ reopen: false });
    } catch (e) {
      st.error = `Nada foi gravado: ${e.message}`;
      st.stage = 'form';
    } finally {
      st.busy = false;
      setLocked(false);
      render();
    }
  }

  function resultView() {
    const r = st.result;
    const line = (what, kind, step) => {
      if (!step) return null;
      const ok = step.status === 'created' || step.status === 'existing';
      return el('li', {}, `${what}${step.key ? ` ${step.key}` : ''}: `, el('span', { class: ok ? 'ok' : 'bad' }, STEP_LABEL[kind][step.status] ?? step.status),
        step.error ? ` — ${step.error}` : '', step.warning ? ` (aviso: ${step.warning})` : '');
    };
    const notes = [];
    if (r.task?.status !== 'created' && r.task?.status !== 'existing' && r.epic?.status === 'created') {
      notes.push(`O épico ${r.epic.key} foi criado; ele já está escolhido no formulário para não criar de novo.`);
    }
    if (r.worklog?.status === 'error' && r.task?.status === 'created') {
      notes.push(`A tarefa ${r.task.key} foi criada; aponte nela depois (já aparece em Tarefa existente).`);
    }
    const back = el('button', {}, 'Voltar ao formulário');
    back.addEventListener('click', () => { st.stage = 'form'; st.result = null; render(); });
    return [el('strong', {}, 'Resultado'),
      el('ul', { class: 'dp-new-steps' }, line('Épico', 'epic', r.epic), line('Tarefa', 'task', r.task), line('Apontamento', 'worklog', r.worklog)),
      ...notes.map((n) => el('p', { class: 'help' }, n)),
      el('div', { class: 'actions' }, el('span', { class: 'spacer' }), back)];
  }

  function render() {
    box.hidden = !st.open;
    button.disabled = st.busy;
    hintEl = null;
    goBtn = null;
    if (!st.open) { box.replaceChildren(); return; }
    const view = { form: formView, loose: looseView, preview: previewView, result: resultView }[st.stage]();
    box.replaceChildren(el('h3', {}, 'Novo apontamento'), ...(st.error ? [el('div', { class: 'error' }, st.error)] : []), ...view);
    hint();
  }

  button.onclick = () => {
    st.open = true;
    if (st.stage === 'result' && !st.busy) { st.stage = 'form'; st.result = null; }
    render();
    box.querySelector('input, select')?.focus();
  };
  render();
}

