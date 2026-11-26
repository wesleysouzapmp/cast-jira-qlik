import { flatten } from '/lib/flatten.js';
import { toCsv } from '/lib/csv.js';
import { generateQlikScript } from '/lib/qlikScript.js';

const $ = (id) => document.getElementById(id);
const MAX_GRID_ROWS = 500;
const STOP_LABELS = {
  end: 'Fim dos dados',
  maxPages: 'Parou no limite de páginas',
  error: 'Erro na página',
  loop: 'Token repetido – interrompido',
};

const state = {
  config: null,
  catalog: [],
  endpoint: null, // item do catálogo ou { id: 'custom', ... }
  records: [],
  tables: {},
  lastRequest: null,
  lastEndpoint: null, // endpoint que gerou os dados exibidos
};

// ---------- utilidades ----------
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return n;
}

function extractRecords(data, dataKey) {
  if (dataKey) return Array.isArray(data?.[dataKey]) ? data[dataKey] : [];
  if (Array.isArray(data)) return data;
  return data === undefined || data === null || typeof data !== 'object' ? [] : [data];
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `Resposta inválida do app (HTTP ${res.status})` }));
  return { httpStatus: res.status, json };
}

// ---------- inicialização ----------
async function init() {
  const [{ json: config }, { json: catalog }] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  state.config = config;
  state.catalog = catalog;

  $('baseUrl').textContent = config.baseUrl;
  const badge = $('tokenBadge');
  badge.textContent = config.tokenConfigured ? 'Token OK' : 'Token ausente';
  badge.className = 'badge ' + (config.tokenConfigured ? 'ok' : 'bad');
  $('tokenBanner').hidden = config.tokenConfigured;

  renderCatalog();
  bindUi();
  selectEndpoint(catalog.find((e) => e.id === 'myself'));

  if (config.tokenConfigured) {
    const { json } = await api('/api/call', { endpointId: 'myself' });
    if (json.ok) $('user').textContent = `${json.data.displayName} (${json.data.emailAddress ?? config.email})`;
    else $('user').textContent = `Falha na autenticação (HTTP ${json.status})`;
  }
}

function renderCatalog() {
  const nav = $('catalog');
  nav.replaceChildren();
  const areas = [...new Set(state.catalog.map((e) => e.area))];
  for (const area of areas) {
    nav.append(el('h2', {}, area));
    for (const e of state.catalog.filter((x) => x.area === area)) {
      nav.append(el('button', { 'data-id': e.id, onclick: () => selectEndpoint(e) }, el('span', { class: 'method' }, e.method), e.label));
    }
  }
  nav.append(el('h2', {}, 'Outros'));
  nav.append(el('button', { 'data-id': 'custom', onclick: () => selectEndpoint(customEndpoint()) }, el('span', { class: 'method' }, 'GET'), 'Endpoint livre'));
}

function customEndpoint() {
  return { id: 'custom', area: 'Outros', label: 'Endpoint livre', method: 'GET', path: '', pathParams: [], query: {}, body: null, pagination: 'none', dataKey: null, help: 'Qualquer GET em /rest/... do seu Jira. Escolha a paginação e a chave do array para testar a varredura completa.' };
}

// ---------- formulário ----------
function selectEndpoint(ep) {
  state.endpoint = ep;
  document.querySelectorAll('#catalog button').forEach((b) => b.classList.toggle('active', b.dataset.id === ep.id));
  $('epTitle').textContent = ep.label;
  $('epPath').textContent = ep.id === 'custom' ? '' : `${ep.method} ${ep.path}`;
  $('epHelp').textContent = ep.help || '';
  $('customFields').hidden = ep.id !== 'custom';

  const pp = $('pathParams');
  pp.replaceChildren(...ep.pathParams.map((p) => el('label', {}, p, el('input', { 'data-param': p, class: 'mono', placeholder: p === 'key' ? 'ex.: ABC-123' : 'ex.: 42' }))));

  $('queryRows').replaceChildren();
  for (const [k, v] of Object.entries(ep.query)) addQueryRow(k, v);

  $('bodyWrap').hidden = ep.method !== 'POST';
  $('body').value = ep.method === 'POST' ? JSON.stringify(ep.body ?? {}, null, 2) : '';

  clearResults();
  const ok = state.config?.tokenConfigured === true;
  $('btnCall').disabled = !ok;
  $('btnPaginate').disabled = !ok || ep.pagination === 'none' && ep.id !== 'custom';
}

function addQueryRow(k = '', v = '') {
  const row = el('div', { class: 'qrow' },
    el('input', { class: 'mono qk', value: k, placeholder: 'parâmetro' }),
    el('input', { class: 'mono qv', value: v, placeholder: 'valor' }),
    el('button', { type: 'button', title: 'Remover', 'aria-label': 'Remover parâmetro', class: 'icon ghost', onclick: () => row.remove() }, el('span', { class: 'i i-x', 'aria-hidden': 'true' })),
  );
  $('queryRows').append(row);
}

function readForm() {
  const ep = state.endpoint;
  const query = {};
  for (const row of document.querySelectorAll('#queryRows .qrow')) {
    const k = row.querySelector('.qk').value.trim();
    if (k) query[k] = row.querySelector('.qv').value;
  }
  const pathParams = {};
  document.querySelectorAll('#pathParams input').forEach((i) => { pathParams[i.dataset.param] = i.value; });

  const payload = { query, maxPages: Number($('maxPages').value) || 20 };
  if (ep.id === 'custom') {
    Object.assign(payload, {
      path: $('customPath').value.trim(),
      method: 'GET',
      pagination: $('customPagination').value,
      dataKey: $('customDataKey').value.trim() || null,
    });
  } else {
    Object.assign(payload, { endpointId: ep.id, pathParams });
  }
  if (ep.method === 'POST') {
    try { payload.body = JSON.parse($('body').value || '{}'); } catch (e) { throw new Error(`Body não é um JSON válido: ${e.message}`); }
  }
  return payload;
}

function effectiveEndpoint(payload) {
  const ep = state.endpoint;
  if (ep.id !== 'custom') return ep;
  return { ...ep, path: payload.path, pagination: payload.pagination, dataKey: payload.dataKey };
}

// ---------- ações ----------
async function run(kind) {
  let payload;
  try { payload = readForm(); } catch (e) { return showError(e.message); }
  const ep = effectiveEndpoint(payload);

  setBusy(true);
  showError(null);
  $('status').textContent = kind === 'call' ? 'Chamando…' : 'Paginando… (pode levar alguns segundos)';
  try {
    const { httpStatus, json } = await api(kind === 'call' ? '/api/call' : '/api/paginate', payload);
    if (httpStatus !== 200) {
      $('status').replaceChildren(el('span', { class: 'bad' }, 'Recusado pelo app'));
      return showError(json.error ?? `HTTP ${httpStatus}`);
    }
    state.lastRequest = json.request;
    state.lastEndpoint = ep;
    if (kind === 'call') handleCall(json, ep);
    else handlePaginate(json, ep);
  } catch (e) {
    showError(`Falha ao falar com o servidor local: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

function handleCall(r, ep) {
  const rate = Object.entries(r.headers ?? {}).filter(([k]) => k.startsWith('x-ratelimit')).map(([k, v]) => `${k}: ${v}`).join(' · ');
  $('status').replaceChildren(
    el('span', { class: r.ok ? 'ok' : 'bad' }, r.status === 0 ? 'Erro de rede' : `HTTP ${r.status}`),
    ` · ${r.ms} ms`,
    r.retries ? ` · ${r.retries} nova(s) tentativa(s) por 429` : '',
    rate ? ` · ${rate}` : '',
  );
  $('json').textContent = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
  if (!r.ok) showError(describeError(r.status, r.data, r.request?.path));
  setRecords(r.ok ? extractRecords(r.data, ep.dataKey) : [], ep);
  renderPages(null);
  if (!r.ok) switchTab('json');
}

function handlePaginate(r, ep) {
  const label = STOP_LABELS[r.stoppedBy] + (r.stoppedBy === 'error' ? ` ${r.pages.length}` : '');
  const totalMs = r.pages.reduce((s, p) => s + (p.ms || 0), 0);
  $('status').replaceChildren(
    el('span', { class: r.stoppedBy === 'error' ? 'bad' : 'ok' }, `${r.total} registros`),
    ` · ${r.pages.length} página(s) · ${totalMs} ms · ${label}`,
  );
  $('json').textContent = JSON.stringify(r.records.slice(0, 50), null, 2) + (r.records.length > 50 ? `\n\n… (${r.records.length - 50} registros omitidos; veja a aba Tabela)` : '');
  if (r.stoppedBy === 'error') {
    const last = r.pages[r.pages.length - 1];
    showError(describeError(last.status, r.error, r.request?.path));
  }
  setRecords(r.records, ep);
  renderPages(r, label);
  switchTab(r.stoppedBy === 'error' ? 'pages' : 'table');
}

function describeError(status, data, path) {
  const jiraMsgs = [];
  if (data && typeof data === 'object') {
    if (Array.isArray(data.errorMessages)) jiraMsgs.push(...data.errorMessages);
    if (data.errors && typeof data.errors === 'object') jiraMsgs.push(...Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`));
    if (data.error) jiraMsgs.push(data.error);
    if (data.message) jiraMsgs.push(data.message);
  }
  const detail = jiraMsgs.length ? '\n' + jiraMsgs.join('\n') : '';
  switch (status) {
    case 0: return `Erro de rede ou timeout ao chamar o Jira.${detail}`;
    case 401: return `401 – Não autenticado: confira JIRA_EMAIL e JIRA_API_TOKEN no .env (o token pode ter expirado).${detail}`;
    case 403: return `403 – Sem permissão: o usuário do token não tem acesso a este recurso/projeto.${detail}`;
    case 404: return `404 – Não encontrado: ${path ?? ''}\nConfira a chave/ID informado ou se o usuário tem permissão de ver o item.${detail}`;
    case 429: return `429 – Limite de requisições do Jira esgotado mesmo após 3 novas tentativas. Aguarde e tente de novo.${detail}`;
    case 400: return `400 – Requisição inválida:${detail || ' (sem detalhes)'}`;
    default: return `HTTP ${status}${detail}`;
  }
}

// ---------- resultados ----------
function setRecords(records, ep) {
  state.records = records;
  state.tables = flatten(records);
  const sel = $('tableSelect');
  sel.replaceChildren(...Object.entries(state.tables).map(([name, rows]) => el('option', { value: name }, `${name} (${rows.length})`)));
  renderGrid();
  renderQlik(ep);
}

function renderGrid() {
  const name = $('tableSelect').value;
  const rows = state.tables[name] ?? [];
  const cols = [];
  const seen = new Set();
  for (const r of rows.slice(0, MAX_GRID_ROWS)) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const shown = rows.slice(0, MAX_GRID_ROWS);
  $('grid').replaceChildren(
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { title: c }, c)))),
    el('tbody', {}, shown.map((r) => el('tr', {}, cols.map((c) => {
      const v = r[c] === null || r[c] === undefined ? '' : String(r[c]);
      return el('td', { title: v.length > 60 ? v : null }, v);
    })))),
  );
  $('tableInfo').textContent = rows.length ? `mostrando ${shown.length} de ${rows.length} linhas · ${cols.length} colunas` : 'sem registros';
  $('btnCsv').disabled = rows.length === 0;
}

function renderPages(r, label) {
  if (!r) {
    $('pagesSummary').textContent = 'Use “Paginar tudo” para percorrer todas as páginas.';
    $('pagesTable').replaceChildren();
    return;
  }
  $('pagesSummary').textContent = `${r.total} registros em ${r.pages.length} página(s) — ${label}`;
  $('pagesTable').replaceChildren(
    el('thead', {}, el('tr', {}, ['Página', 'HTTP', 'Registros', 'ms'].map((h) => el('th', {}, h)))),
    el('tbody', {}, r.pages.map((p) => el('tr', {}, [p.n, p.status, p.count, p.ms].map((v) => el('td', {}, v))))),
  );
}

function clearResults() {
  state.records = [];
  state.tables = {};
  state.lastRequest = null;
  state.lastEndpoint = null;
  $('tableSelect').replaceChildren();
  $('grid').replaceChildren();
  $('tableInfo').textContent = '';
  $('btnCsv').disabled = true;
  $('json').textContent = '';
  $('qlik').textContent = 'Faça uma chamada para gerar o script.';
  $('status').textContent = 'Nenhuma chamada ainda.';
  showError(null);
  renderPages(null);
}

function renderQlik(ep = state.lastEndpoint) {
  if (!state.lastRequest || !ep) return;
  $('qlik').textContent = generateQlikScript({
    baseUrl: state.config.baseUrl,
    endpoint: ep,
    request: state.lastRequest,
    sampleRecord: state.records[0],
    connectionName: $('connName').value.trim() || 'Jira_REST',
  });
}

function exportCsv() {
  const name = $('tableSelect').value;
  const blob = new Blob([toCsv(state.tables[name] ?? [])], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${state.lastEndpoint?.id ?? 'dados'}_${name}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- UI ----------
function showError(msg) {
  $('errorBox').hidden = !msg;
  $('errorBox').textContent = msg ?? '';
}

function setBusy(b) {
  const noToken = state.config?.tokenConfigured !== true;
  $('btnCall').disabled = b || noToken;
  $('btnPaginate').disabled = b || noToken || (state.endpoint.pagination === 'none' && state.endpoint.id !== 'custom');
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.dataset.tab !== name; });
}

function bindUi() {
  $('btnCall').addEventListener('click', () => run('call'));
  $('btnPaginate').addEventListener('click', () => run('paginate'));
  $('addQuery').addEventListener('click', () => addQueryRow());
  $('tableSelect').addEventListener('change', renderGrid);
  $('btnCsv').addEventListener('click', exportCsv);
  $('connName').addEventListener('change', () => renderQlik());
  $('btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('qlik').textContent); $('btnCopy').textContent = 'Copiado'; } catch { $('btnCopy').textContent = 'Selecione e copie'; }
    setTimeout(() => { $('btnCopy').textContent = 'Copiar'; }, 1500);
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

init().catch((e) => showError(`Falha ao iniciar: ${e.message}`));
