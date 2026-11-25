// Consentimento do conector MCP: mostra quem pede acesso e devolve a decisão ao servidor,
// que responde com a URL de retorno (redirect_uri registrada, com code ou access_denied).
const $ = (id) => document.getElementById(id);
const pedido = new URLSearchParams(location.search).get('pedido') || '';
const url = `/api/consentimento/${encodeURIComponent(pedido)}`;

function irParaLogin() {
  location.assign('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
}

async function api(method, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { irParaLogin(); throw new Error('Faça login para continuar.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Falha (HTTP ${res.status}).`);
  return json;
}

function botoes(ativos) {
  $('permitir').disabled = !ativos;
  $('negar').disabled = !ativos;
}

function mostrar(info) {
  const p = $('pedido');
  p.textContent = '';
  p.className = '';
  const nome = document.createElement('strong');
  nome.textContent = info.cliente;
  p.append(nome, ' quer acessar e gravar seus apontamentos no Jira.');
  // Destino em destaque: só aprove se for o Claude (claude.ai / claude.com).
  const d = $('destino');
  d.textContent = '';
  d.className = '';
  const host = document.createElement('strong');
  host.textContent = info.destino;
  d.append('Depois da sua resposta você volta para ', host, '. Só permita se for o Claude.');
  botoes(true);
}

async function decidir(permitir) {
  botoes(false);
  $('msg').textContent = '';
  try {
    const { redirect } = await api('POST', { permitir });
    location.assign(redirect);
  } catch (err) {
    $('msg').textContent = err.message;
  }
}

$('permitir').addEventListener('click', () => decidir(true));
$('negar').addEventListener('click', () => decidir(false));

api('GET').then(mostrar).catch((err) => {
  $('pedido').textContent = '';
  $('msg').textContent = err.message;
});
