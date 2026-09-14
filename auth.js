(function (root) {
  'use strict';
  let session = null;
  const loginPath = '/login.html';
  const loginThemeKey = 'bio-login-theme-by-email-v1';
  const isLoginPage = () => root.location.pathname === loginPath;
  const revealApplication = () => root.document.querySelector('#bioAuthGate')?.remove();
  const openApplication = () => root.location.replace('/');
  const normalizeEmail = value => String(value || '').trim().toLowerCase();
  const readLoginThemes = () => { try { return JSON.parse(root.localStorage.getItem(loginThemeKey) || '{}'); } catch { return {}; } };
  const loginThemeForUser = userId => { try { return JSON.parse(root.localStorage.getItem(`nexo-theme-v3:${userId}`) || '{}').mode === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } };
  const applyLoginTheme = mode => { if (!isLoginPage()) return; const theme = mode === 'light' ? 'light' : 'dark'; root.document.documentElement.dataset.loginTheme = theme; root.document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f8fb' : '#07111f'); };
  const rememberLoginTheme = user => {
    const email = normalizeEmail(user?.email); if (!email) return;
    const themes = readLoginThemes(), mode = loginThemeForUser(user.id);
    themes[email] = mode; themes.last = { email, mode }; root.localStorage.setItem(loginThemeKey, JSON.stringify(themes));
  };
  const initializeLoginTheme = dialog => {
    const themes = readLoginThemes(), email = dialog.querySelector('#bioLoginEmail');
    applyLoginTheme(themes.last?.mode);
    email.addEventListener('input', () => applyLoginTheme(themes[normalizeEmail(email.value)] || themes.last?.mode));
  };
  const request = async (path, payload) => {
    const response = await fetch(path, { method: payload ? 'POST' : 'GET', credentials: 'same-origin', headers: payload ? { 'Content-Type': 'application/json' } : undefined, body: payload ? JSON.stringify(payload) : undefined });
    const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error || 'No fue posible validar la sesión.'), { setupReady: body.setupReady }); return body;
  };
  const close = () => root.document.querySelector('#bioLoginDialog')?.remove();
  function promptLogin(setupReady) {
    // El formulario vive en una página independiente: la aplicación no se
    // conserva en el DOM ni queda visible detrás de la autenticación.
    if (!isLoginPage()) { root.location.replace(loginPath); return; }
    close(); const dialog = root.document.createElement('dialog'); dialog.id = 'bioLoginDialog'; dialog.className = 'bio-login-dialog';
    dialog.innerHTML = `<form method="dialog" id="bioLoginForm"><section class="bio-login-visual"><div class="bio-login-brand"><img src="assets/probiolab-logo-transparent.png" alt="" />PROBIOLAB</div><div class="bio-login-copy"><h1>Operación confiable para laboratorio.</h1><p>Centraliza inventario, compras, cotizaciones y evidencia operativa con acceso controlado para cada integrante del equipo.</p></div></section><section class="bio-login-panel"><div class="bio-login-card"><p class="eyebrow">ACCESO RESTRINGIDO</p><h2>${setupReady ? 'Configura tu acceso' : 'Iniciar sesión'}</h2><p class="subtitle">${setupReady ? 'Define una contraseña segura para el administrador existente.' : 'Ingresa con tu correo institucional y contraseña.'}</p><label class="field"><span>CORREO</span><input id="bioLoginEmail" type="email" required autocomplete="email" placeholder="nombre@probiolab.mx" /></label><label class="field"><span>CONTRASEÑA</span><span class="bio-password-control"><input id="bioLoginPassword" type="password" required minlength="12" autocomplete="current-password" placeholder="••••••••••••" /><button id="bioLoginPasswordToggle" type="button" aria-label="Mostrar contraseña" title="Mostrar contraseña"><i data-lucide="eye"></i></button></span></label><p id="bioLoginError" class="bio-login-error" hidden></p><button class="bio-login-submit" type="submit">${setupReady ? 'Configurar y entrar' : 'Ingresar al sistema'}</button><p class="bio-login-security"><i data-lucide="shield-check"></i> CONEXIÓN SEGURA · SESIÓN PROTEGIDA</p></div></section></form>`;
    root.document.body.append(dialog); initializeLoginTheme(dialog); dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const email = dialog.querySelector('#bioLoginEmail').value, password = dialog.querySelector('#bioLoginPassword').value, error = dialog.querySelector('#bioLoginError'); try { const result = await request(setupReady ? '/api/auth/setup' : '/api/auth/login', { email, password }); session = result.user; rememberLoginTheme(session); root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); openApplication(); } catch (failure) { error.textContent = failure.message; error.hidden = false; } }); const passwordInput = dialog.querySelector('#bioLoginPassword'), passwordToggle = dialog.querySelector('#bioLoginPasswordToggle'); passwordToggle.addEventListener('click', () => { const visible = passwordInput.type === 'text'; passwordInput.type = visible ? 'password' : 'text'; const label = visible ? 'Mostrar contraseña' : 'Ocultar contraseña'; passwordToggle.setAttribute('aria-label', label); passwordToggle.title = label; passwordToggle.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`; root.lucide?.createIcons(); passwordInput.focus(); }); dialog.showModal(); root.lucide?.createIcons();
  }
  async function initialize() {
    try { const result = await request('/api/auth/me'); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); if (isLoginPage()) openApplication(); else revealApplication(); }
    catch (error) { root.localStorage.removeItem('bio-authenticated'); promptLogin(Boolean(error.setupReady)); }
  }
  // Mantiene la preferencia usada en el último acceso aun cuando se modifique
  // desde Configuración durante la sesión.
  root.addEventListener('bio:theme-changed', () => { if (session) rememberLoginTheme(session); });
  root.BioAuth = { user: () => session && { ...session }, ready: initialize(), setPassword: async (userId, password) => request(`/api/auth/users/${encodeURIComponent(userId)}/password`, { password }), logout: async () => { await request('/api/auth/logout', {}); root.localStorage.removeItem('bio-authenticated'); root.location.reload(); } };
})(window);
