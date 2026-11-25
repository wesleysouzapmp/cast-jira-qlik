// Cabeçalho de sessão comum às páginas logadas (script clássico, carregado antes dos módulos
// da página para que o tratamento de 401 já valha nas primeiras chamadas):
//  - qualquer resposta 401 de /api/* leva ao login (?next= com a página atual);
//  - mostra o nome do usuário com "Minha conta", "Usuários" (admin) e "Sair";
//  - token do Jira ausente ou recusado: faixa com link para Minha conta.
(function () {
  'use strict';
  const nativeFetch = window.fetch.bind(window);

  function irParaLogin() {
    const next = location.pathname + location.search;
    location.assign('/login.html?next=' + encodeURIComponent(next));
  }

  function caminhoApi(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin !== location.origin) return null;
      return url.pathname;
    } catch {
      return null;
    }
  }

  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const path = caminhoApi(input);
    if (res.status === 401 && path && path.startsWith('/api/') && path !== '/api/login') irParaLogin();
    return res;
  };

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  }

  function montarCabecalho(user) {
    const pagina = location.pathname.replace(/^\//, '') || 'index.html';
    const box = el('div', { class: 'session', id: 'sessionBox' });
    box.append(el('span', { class: 'session-name' }, user.name || user.email));
    const conta = el('a', { href: 'conta.html' }, 'Minha conta');
    if (pagina === 'conta.html') conta.setAttribute('aria-current', 'page');
    box.append(conta);
    if (user.role === 'admin') {
      const adm = el('a', { href: 'admin.html' }, 'Usuários');
      if (pagina === 'admin.html') adm.setAttribute('aria-current', 'page');
      box.append(adm);
    }
    const sair = el('button', { type: 'button', class: 'link' }, 'Sair');
    sair.addEventListener('click', async () => {
      sair.disabled = true;
      try { await nativeFetch('/api/logout', { method: 'POST' }); } catch { /* sai mesmo assim */ }
      location.assign('/login.html');
    });
    box.append(sair);
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.append(box);
    else document.body.prepend(box);
  }

  function mostrarFaixa(status) {
    if (status === 'ok' || location.pathname.endsWith('/conta.html')) return;
    let faixa = document.getElementById('tokenBanner');
    if (!faixa) {
      faixa = el('div', { id: 'tokenBanner', class: 'banner' });
      const topbar = document.querySelector('.topbar');
      if (topbar) topbar.after(faixa); else document.body.prepend(faixa);
    }
    faixa.textContent = '';
    faixa.append(el('strong', {}, status === 'invalid' ? 'O Jira recusou o seu token.' : 'Token do Jira não configurado.'));
    faixa.append(' ');
    faixa.append(el('a', { href: 'conta.html' }, 'Configure em Minha conta'));
    faixa.append('.');
    faixa.hidden = false;
  }

  async function iniciar() {
    let dados;
    try {
      const res = await window.fetch('/api/me');
      if (!res.ok) return;
      dados = await res.json();
    } catch {
      return;
    }
    montarCabecalho(dados.user);
    mostrarFaixa(dados.token && dados.token.status);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
}());
