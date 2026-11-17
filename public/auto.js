// Bloco "Apontamentos automáticos" da tela Apontar horas: regras que o servidor executa sozinho
// todo dia útil. Texto vindo do Jira/servidor entra só por textContent.
const $ = (id) => document.getElementById(id);
const STATUS = { created: 'gravado', skipped: 'pulado', conflict: 'conflito', error: 'erro' };
const STATUS_CLASS = { created: 'ok', skipped: 'muted', conflict: 'bad', error: 'bad' };
const state = { rules: [], editing: null, busy: false };

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

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Duração exata (sem arredondar para 15): "15", "15m", "1h", "1h 30m", "0:45".
export function parseMinutes(text) {
  const s = String(text ?? '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+)$/))) return Number(m[1]);
  if ((m = s.match(/^(\d+):([0-5]\d)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/)) && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}
const fmtMin = (n) => [Math.floor(n / 60) ? `${Math.floor(n / 60)}h` : '', n % 60 ? `${n % 60}m` : ''].filter(Boolean).join(' ') || '0m';
const br = (iso) => iso.split('-').reverse().join('/');
const brDateTime = (s) => (s ? `${br(s.slice(0, 10))}${s.length > 10 ? ` ${s.slice(11)}` : ''}` : '—');

function msg(text, bad = false) {
  $('autoMsg').textContent = text;
  $('autoMsg').className = bad ? 'bad' : 'muted';
}

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function resetForm() {
  state.editing = null;
  $('autoKey').value = '';
  $('autoStart').value = '09:00';
  $('autoMinutes').value = '15m';
  $('autoSince').value = todayIso();
  $('autoUntil').value = '';
  $('autoComment').value = '';
  $('autoSave').textContent = 'Adicionar regra';
  $('autoCancel').hidden = true;
}

function fillForm(r) {
  state.editing = r.id;
  $('autoKey').value = r.key;
  $('autoStart').value = r.start;
  $('autoMinutes').value = fmtMin(r.minutes);
  $('autoSince').value = r.since;
  $('autoUntil').value = r.until ?? '';
  $('autoComment').value = r.comment;
  $('autoSave').textContent = 'Salvar regra';
  $('autoCancel').hidden = false;
  $('autoKey').focus();
}

function result(h) {
  if (!h) return el('span', { class: 'muted' }, '—');
  return el('span', { class: STATUS_CLASS[h.status] ?? '', title: h.message ?? '' }, `${br(h.date)}: ${STATUS[h.status] ?? h.status}${h.message ? ` — ${h.message}` : ''}`);
}

function render(st) {
  $('autoPaused').checked = st.paused;
  $('autoPaused').disabled = st.disabled;
  $('autoRun').disabled = st.disabled || state.busy;
  $('autoBanner').hidden = !st.disabled && !st.paused;
  $('autoBanner').textContent = st.disabled
    ? 'Agendador desligado (AUTO_WORKLOG=off no .env ou token ausente): nada é gravado automaticamente.'
    : st.paused ? 'Todas as regras estão pausadas.' : '';
  state.rules = st.rules;
  $('autoRules').replaceChildren(...(st.rules.length ? st.rules.map((r) => {
    const toggle = el('button', { title: r.enabled ? 'Pausar esta regra' : 'Ativar esta regra' }, r.enabled ? 'Pausar' : 'Ativar');
    toggle.addEventListener('click', () => save(r.id, { ...pick(r), enabled: !r.enabled }));
    const edit = el('button', {}, 'Editar');
    edit.addEventListener('click', () => fillForm(r));
    const del = el('button', { title: 'Excluir a regra (os apontamentos já gravados ficam no Jira)' }, 'Excluir');
    del.addEventListener('click', () => remove(r));
    return el('tr', {},
      el('td', { class: 'nowrap' }, r.key),
      el('td', { class: 'nowrap' }, `${r.start} · ${fmtMin(r.minutes)}`),
      el('td', { class: 'wrap' }, r.comment),
      el('td', { class: 'nowrap' }, r.until ? `${br(r.since)} a ${br(r.until)}` : `desde ${br(r.since)}`),
      el('td', {}, situation(r)),
      el('td', { class: 'wrap' }, result(r.lastRun)),
      el('td', { class: 'nowrap' }, brDateTime(r.nextRun)),
      el('td', { class: 'nowrap' }, toggle, ' ', edit, ' ', del));
  }) : [el('tr', {}, el('td', { colSpan: 8, class: 'muted' }, 'Nenhuma regra. Ex.: SIJUD-27633, 09:00, 15m.'))]));
  $('autoHistory').replaceChildren(...(st.history.length ? st.history.map((h) => el('tr', {},
    el('td', { class: 'nowrap' }, new Date(h.at).toLocaleString('pt-BR')),
    el('td', { class: 'nowrap' }, h.key),
    el('td', { class: 'nowrap' }, `${br(h.date)} ${h.start}`),
    el('td', { class: STATUS_CLASS[h.status] ?? '' }, STATUS[h.status] ?? h.status),
    el('td', { class: 'wrap' }, h.message ?? ''))) : [el('tr', {}, el('td', { colSpan: 5, class: 'muted' }, 'Nada executado ainda.'))]));
}

const pick = (r) => ({ key: r.key, start: r.start, minutes: r.minutes, comment: r.comment, since: r.since, until: r.until ?? null, enabled: r.enabled });

function situation(r) {
  if (!r.enabled) return el('span', { class: 'badge' }, 'pausada');
  if (r.until && r.until < todayIso()) return el('span', { class: 'badge' }, 'encerrada');
  return el('span', { class: 'badge ok' }, 'ativa');
}

async function load() {
  try { render(await call('GET', '/api/auto')); } catch (e) { msg(`Não foi possível carregar os agendamentos: ${e.message}`, true); }
}

async function save(id, body) {
  try {
    if (id) await call('PUT', `/api/auto/rules/${encodeURIComponent(id)}`, body);
    else await call('POST', '/api/auto/rules', body);
    msg(id ? 'Regra salva.' : 'Regra criada. Os dias pendentes são gravados no próximo minuto (ou clique em Rodar agora).');
    return true;
  } catch (e) {
    msg(e.message, true);
    return false;
  } finally {
    await load();
  }
}

async function submitForm() {
  const minutes = parseMinutes($('autoMinutes').value);
  if (!minutes) return msg('Duração inválida (ex.: 15m, 1h 30m).', true);
  const body = {
    key: $('autoKey').value.trim().toUpperCase(),
    start: $('autoStart').value,
    minutes,
    since: $('autoSince').value || undefined,
    until: $('autoUntil').value || null,
    comment: $('autoComment').value,
  };
  const current = state.rules.find((r) => r.id === state.editing);
  if (current) body.enabled = current.enabled;
  $('autoSave').disabled = true;
  msg('Conferindo a tarefa no Jira…');
  if (await save(state.editing, body)) resetForm();
  $('autoSave').disabled = false;
}

async function remove(r) {
  if (!confirm(`Excluir a regra ${r.key} às ${r.start}? Os apontamentos já gravados continuam no Jira.`)) return;
  try { await call('DELETE', `/api/auto/rules/${encodeURIComponent(r.id)}`); msg('Regra excluída.'); if (state.editing === r.id) resetForm(); } catch (e) { msg(e.message, true); }
  await load();
}

async function runNow() {
  state.busy = true;
  $('autoRun').disabled = true;
  msg('Executando…');
  try {
    const { results } = await call('POST', '/api/auto/run', {});
    const n = (s) => results.filter((r) => r.status === s).length;
    msg(results.length ? `Gravados: ${n('created')} · pulados: ${n('skipped')} · conflitos: ${n('conflict')} · erros: ${n('error')}` : 'Nada pendente.');
    if (n('created')) window.dispatchEvent(new CustomEvent('auto-logged'));
  } catch (e) {
    msg(e.message, true);
  } finally {
    state.busy = false;
    await load();
  }
}

export function setupAuto() {
  resetForm();
  $('autoSave').addEventListener('click', submitForm);
  $('autoCancel').addEventListener('click', () => { resetForm(); msg(''); });
  $('autoRun').addEventListener('click', runNow);
  $('autoPaused').addEventListener('change', async (ev) => {
    try { await call('POST', '/api/auto/paused', { paused: ev.target.checked }); } catch (e) { msg(e.message, true); }
    await load();
  });
  load();
  // Atualiza a lista a cada minuto (o servidor pode ter gravado algo sozinho).
  setInterval(load, 60000);
}
