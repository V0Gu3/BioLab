(function (root) {
  'use strict';
  let session = null;
  const revealApplication = () => root.document.querySelector('#bioAuthGate')?.remove();
  const request = async (path, payload) => {
    const response = await fetch(path, { method: payload ? 'POST' : 'GET', credentials: 'same-origin', headers: payload ? { 'Content-Type': 'application/json' } : undefined, body: payload ? JSON.stringify(payload) : undefined });
    const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error || 'No fue posible validar la sesión.'), { setupReady: body.setupReady }); return body;
  };
  const close = () => root.document.querySelector('#bioLoginDialog')?.remove();
  function promptLogin(setupReady) {
    close(); const dialog = root.document.createElement('dialog'); dialog.id = 'bioLoginDialog'; dialog.className = 'bio-login-dialog';
    dialog.innerHTML = `<form method="dialog" id="bioLoginForm"><section class="bio-login-visual"><div class="bio-login-brand"><img src="assets/probiolab-logo-transparent.png" alt="" />PROBIOLAB</div><div class="bio-login-copy"><h1>Operación confiable para laboratorio.</h1><p>Centraliza inventario, compras, cotizaciones y evidencia operativa con acceso controlado para cada integrante del equipo.</p></div></section><section class="bio-login-panel"><div class="bio-login-card"><p class="eyebrow">ACCESO RESTRINGIDO</p><h2>${setupReady ? 'Configura tu acceso' : 'Iniciar sesión'}</h2><p class="subtitle">${setupReady ? 'Define una contraseña segura para el administrador existente.' : 'Ingresa con tu correo institucional y contraseña.'}</p><label class="field"><span>CORREO</span><input id="bioLoginEmail" type="email" required autocomplete="email" placeholder="nombre@probiolab.mx" /></label><label class="field"><span>CONTRASEÑA</span><input id="bioLoginPassword" type="password" required minlength="12" autocomplete="current-password" placeholder="••••••••••••" /></label><p id="bioLoginError" class="bio-login-error" hidden></p><button class="bio-login-submit" type="submit">${setupReady ? 'Configurar y entrar' : 'Ingresar al sistema'}</button><p class="bio-login-security"><i data-lucide="shield-check"></i> CONEXIÓN SEGURA · SESIÓN PROTEGIDA</p></div></section></form>`;
    root.document.body.append(dialog); dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const email = dialog.querySelector('#bioLoginEmail').value, password = dialog.querySelector('#bioLoginPassword').value, error = dialog.querySelector('#bioLoginError'); try { const result = await request(setupReady ? '/api/auth/setup' : '/api/auth/login', { email, password }); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); root.location.reload(); } catch (failure) { error.textContent = failure.message; error.hidden = false; } }); dialog.showModal(); revealApplication(); root.lucide?.createIcons();
  }
  async function initialize() {
    try { const result = await request('/api/auth/me'); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); revealApplication(); }
    catch (error) { root.localStorage.removeItem('bio-authenticated'); promptLogin(Boolean(error.setupReady)); }
  }
  root.BioAuth = { user: () => session && { ...session }, ready: initialize(), setPassword: async (userId, password) => request(`/api/auth/users/${encodeURIComponent(userId)}/password`, { password }), logout: async () => { await request('/api/auth/logout', {}); root.localStorage.removeItem('bio-authenticated'); root.location.reload(); } };
})(window);
