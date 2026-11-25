// Minha conta: token do Jira, chave Anthropic, senha e sessões.
const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Falha (HTTP ${res.status}).`);
  return json;
}

function aviso(id, texto, ok) {
  const el = $(id);
  el.textContent = texto;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

const quando = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR') : '—');
const STATUS_JIRA = {
  ok: ['Token conferido e funcionando.', 'ok'],
  invalid: ['O Jira recusou o token salvo (expirado ou revogado). Envie um novo.', 'bad'],
  missing: ['Nenhum token configurado.', 'bad'],
};

function render(conta) {
  $('nome').textContent = conta.name;
  $('emailConta').textContent = conta.email;

  const [texto, cls] = STATUS_JIRA[conta.jira.status] ?? STATUS_JIRA.missing;
  const st = $('jiraStatus');
  st.textContent = '';
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = texto;
  st.append(span);
  if (conta.jira.checkedAt) st.append(` Última verificação: ${quando(conta.jira.checkedAt)}.`);
  if (!$('jiraEmail').value) $('jiraEmail').value = conta.jira.email || conta.email;

  $('aiStatus').textContent = conta.anthropic.configured ? 'Chave configurada.' : 'Nenhuma chave configurada.';
  $('aiRemove').hidden = !conta.anthropic.configured;

  const tbody = $('sessoes');
  tbody.textContent = '';
  for (const s of conta.sessions) {
    const tr = document.createElement('tr');
    for (const v of [s.userAgent || '—', quando(s.createdAt), quando(s.expiresAt), s.current ? 'esta sessão' : '']) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    tbody.append(tr);
  }
  $('encerrar').disabled = conta.sessions.length <= 1;
}

async function carregar() {
  try { render(await api('GET', '/api/conta')); } catch (err) { aviso('jiraMsg', err.message, false); }
}

function enviar(form, msgId, fn) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const botoes = form.querySelectorAll('button');
    botoes.forEach((b) => { b.disabled = true; });
    aviso(msgId, 'Enviando…', true);
    try {
      aviso(msgId, await fn(), true);
      await carregar();
    } catch (err) {
      aviso(msgId, err.message, false);
    } finally {
      botoes.forEach((b) => { b.disabled = false; });
    }
  });
}

enviar($('jiraForm'), 'jiraMsg', async () => {
  await api('PUT', '/api/conta/jira', { email: $('jiraEmail').value, token: $('jiraToken').value });
  $('jiraToken').value = '';
  return 'Token salvo. O Jira aceitou as credenciais.';
});

enviar($('aiForm'), 'aiMsg', async () => {
  await api('PUT', '/api/conta/anthropic', { key: $('aiKey').value });
  $('aiKey').value = '';
  return 'Chave salva.';
});

$('aiRemove').addEventListener('click', async () => {
  if (!confirm('Remover a chave da Anthropic?')) return;
  try {
    await api('PUT', '/api/conta/anthropic', { key: null });
    aviso('aiMsg', 'Chave removida.', true);
    await carregar();
  } catch (err) {
    aviso('aiMsg', err.message, false);
  }
});

enviar($('senhaForm'), 'senhaMsg', async () => {
  await api('PUT', '/api/conta/senha', { atual: $('senhaAtual').value, nova: $('senhaNova').value });
  $('senhaAtual').value = '';
  $('senhaNova').value = '';
  return 'Senha trocada. As outras sessões foram encerradas.';
});

$('encerrar').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/conta/sessoes');
    aviso('sessoesMsg', 'Outras sessões encerradas.', true);
    await carregar();
  } catch (err) {
    aviso('sessoesMsg', err.message, false);
  }
});

carregar();
