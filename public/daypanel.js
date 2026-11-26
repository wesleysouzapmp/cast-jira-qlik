// Painel de batidas de um dia: edita início, duração, comentário, tarefa e data, ou exclui,
// e salva tudo de uma vez (POST /api/worklog/batch). Texto do Jira entra só por textContent.
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

// tasks: [{ key, model, label, epicKey }] — destinos possíveis ao mudar a tarefa (tarefas de apoio).
export function openDayPanel({ dialog, date, entries, tasks, limit, onSaved, onUsePeriod }) {
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
    for (const t of tasks) opts.push(el('option', { value: t.key }, `${t.key} · ${t.label ?? MODEL_LABEL[t.model] ?? t.model} · ${t.epicKey}`));
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
    save.disabled = busy || !pending.length || invalid;
    save.textContent = pending.length ? `Salvar alterações (${pending.length})` : 'Salvar alterações';
    dialog.querySelector('.dp-close').disabled = busy;
    dialog.querySelector('.dp-period').disabled = busy;
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
  dialog.querySelector('.dp-period').onclick = () => { onUsePeriod(date); dialog.close(); };
  showError('');
  showInfo('');
  render();
  if (!dialog.open) dialog.showModal();
}
