const form = document.getElementById('form');
const msg = document.getElementById('msg');
const botao = document.getElementById('enviar');

// Só aceita caminhos internos em ?next= (evita redirecionamento para outro site).
function destino() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\') ? next : '/index.html';
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  msg.textContent = '';
  botao.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value, senha: form.senha.value }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Não foi possível entrar.');
    location.assign(destino());
  } catch (err) {
    msg.textContent = err.message;
    botao.disabled = false;
  }
});
