// /convite.html?token=...            → cria a conta (POST /api/convite/:token)
// /convite.html?token=...&tipo=redefinir → define nova senha (POST /api/redefinir/:token)
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const redefinir = params.get('tipo') === 'redefinir';

const form = document.getElementById('form');
const msg = document.getElementById('msg');
const sub = document.getElementById('sub');
const botao = document.getElementById('enviar');

function falha(texto) {
  form.hidden = true;
  sub.textContent = '';
  msg.textContent = texto;
}

async function iniciar() {
  if (redefinir) {
    document.getElementById('titulo').textContent = 'Redefinir senha';
    document.getElementById('lblNome').hidden = true;
    document.getElementById('lblEmail').hidden = true;
    sub.textContent = 'Escolha uma nova senha.';
    form.hidden = false;
    return;
  }
  if (!token) return falha('Link de convite incompleto.');
  try {
    const res = await fetch(`/api/convite/${encodeURIComponent(token)}`);
    if (!res.ok) return falha((await res.json().catch(() => ({}))).error || 'Convite inválido.');
  } catch {
    return falha('Não foi possível verificar o convite.');
  }
  document.getElementById('nome').required = true;
  document.getElementById('email').required = true;
  sub.textContent = 'Preencha os dados para criar a sua conta.';
  form.hidden = false;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg.textContent = '';
  botao.disabled = true;
  const url = `/api/${redefinir ? 'redefinir' : 'convite'}/${encodeURIComponent(token)}`;
  const corpo = redefinir
    ? { senha: form.senha.value }
    : { nome: form.nome.value, email: form.email.value, senha: form.senha.value };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Não foi possível concluir.');
    location.assign(redefinir ? '/login.html' : '/conta.html');
  } catch (err) {
    msg.textContent = err.message;
    botao.disabled = false;
  }
});

iniciar();
