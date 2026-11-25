// Administração: lista de usuários, convites, links de redefinição e ativação.
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

function aviso(texto, ok) {
  $('msg').textContent = texto;
  $('msg').className = 'msg ' + (ok ? 'ok' : 'err');
}

function mostrarLink(link, info) {
  $('link').value = link;
  $('linkBox').hidden = false;
  $('linkInfo').textContent = info;
  $('link').select();
}

$('copiar').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('link').value);
    aviso('Link copiado.', true);
  } catch {
    $('link').select();
    aviso('Não foi possível copiar automaticamente: selecione o link e copie com Ctrl+C.', false);
  }
});

$('conviteForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const { link } = await api('POST', '/api/admin/convites', { role: $('papel').value });
    mostrarLink(link, 'Convite gerado. Envie este link para a pessoa (uso único, vale 7 dias).');
    aviso('', true);
  } catch (err) {
    aviso(err.message, false);
  }
});

const TOKEN = { ok: 'ok', invalid: 'recusado', missing: 'não configurado' };
const PAPEL = { admin: 'Administrador', user: 'Usuário' };

function celula(tr, texto) {
  const td = document.createElement('td');
  td.textContent = texto;
  tr.append(td);
  return td;
}

function botao(texto, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = texto;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (err) { aviso(err.message, false); } finally { b.disabled = false; }
  });
  return b;
}

async function carregar() {
  const [{ users }, me] = await Promise.all([api('GET', '/api/admin/usuarios'), api('GET', '/api/me')]);
  const tbody = $('usuarios');
  tbody.textContent = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    celula(tr, u.name);
    celula(tr, u.email);
    celula(tr, PAPEL[u.role] ?? u.role);
    celula(tr, TOKEN[u.tokenStatus] ?? u.tokenStatus);
    celula(tr, u.active ? 'ativo' : 'desativado');
    const acoes = celula(tr, '');
    acoes.className = 'row-actions';
    acoes.append(botao('link de nova senha', async () => {
      const { link } = await api('POST', `/api/admin/usuarios/${encodeURIComponent(u.id)}/redefinicao`);
      mostrarLink(link, `Link de redefinição de senha para ${u.name} (uso único, vale 24 horas).`);
      aviso('', true);
    }));
    if (u.id !== me.user.id) {
      acoes.append(botao(u.active ? 'desativar' : 'reativar', async () => {
        if (u.active && !confirm(`Desativar ${u.name}? As sessões dela serão encerradas.`)) return;
        await api('PUT', `/api/admin/usuarios/${encodeURIComponent(u.id)}/ativo`, { ativo: !u.active });
        aviso(u.active ? `${u.name} desativado(a).` : `${u.name} reativado(a).`, true);
        await carregar();
      }));
    }
    tbody.append(tr);
  }
}

carregar().catch((err) => aviso(err.message, false));
