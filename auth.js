(function (root) {
  'use strict';
  let session = null;
  const request = async (path, payload) => {
    const response = await fetch(path, { method: payload ? 'POST' : 'GET', credentials: 'same-origin', headers: payload ? { 'Content-Type': 'application/json' } : undefined, body: payload ? JSON.stringify(payload) : undefined });
    const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error || 'No fue posible validar la sesión.'), { setupReady: body.setupReady }); return body;
  };
  const close = () => root.document.querySelector('#bioLoginDialog')?.remove();
  function promptLogin(setupReady) {
    close(); const dialog = root.document.createElement('dialog'); dialog.id = 'bioLoginDialog'; dialog.className = 'system-dialog';
    dialog.innerHTML = `<form method="dialog" id="bioLoginForm"><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="lock-keyhole"></i></span><div><p class="eyebrow">ACCESO SEGURO</p><h2>${setupReady ? 'Configura la cuenta administradora' : 'Inicia sesión'}</h2></div></div></div><div class="modal-body"><p class="confirm-note">${setupReady ? 'Define una contraseña segura para el administrador existente.' : 'Usa tu correo y contraseña para acceder a PROBIOLAB.'}</p><label class="field"><span>Correo</span><input id="bioLoginEmail" type="email" required autocomplete="email" /></label><label class="field"><span>Contraseña</span><input id="bioLoginPassword" type="password" required minlength="12" autocomplete="current-password" /></label><p id="bioLoginError" class="field-error-message" hidden></p></div><div class="modal-actions"><button class="submit" type="submit">${setupReady ? 'Configurar y entrar' : 'Entrar'}</button></div></form>`;
    root.document.body.append(dialog); dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const email = dialog.querySelector('#bioLoginEmail').value, password = dialog.querySelector('#bioLoginPassword').value, error = dialog.querySelector('#bioLoginError'); try { const result = await request(setupReady ? '/api/auth/setup' : '/api/auth/login', { email, password }); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); root.location.reload(); } catch (failure) { error.textContent = failure.message; error.hidden = false; } }); dialog.showModal(); root.lucide?.createIcons();
  }
  async function initialize() {
    try { const result = await request('/api/auth/me'); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); }
    catch (error) { root.localStorage.removeItem('bio-authenticated'); promptLogin(Boolean(error.setupReady)); }
  }
  root.BioAuth = { user: () => session && { ...session }, ready: initialize(), setPassword: async (userId, password) => request(`/api/auth/users/${encodeURIComponent(userId)}/password`, { password }), logout: async () => { await request('/api/auth/logout', {}); root.localStorage.removeItem('bio-authenticated'); root.location.reload(); } };
})(window);
