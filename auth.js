(function (root) {
  'use strict';
  let session = null;
  const loginPath = '/login.html';
  const loginSuccessDelayMs = 180;
  const loginThemeKey = 'bio-login-theme-by-email-v1';
  const isLoginPage = () => root.location.pathname === loginPath;
  const revealApplication = () => root.document.querySelector('#bioAuthGate')?.remove();
  const openApplication = async () => { await root.__bioPasskeyEnrollment; root.location.replace('/'); };
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
    const isJson = response.headers.get('content-type')?.includes('application/json'), body = isJson ? await response.json() : {};
    if (!response.ok) throw Object.assign(new Error(body.error || `El servicio de acceso respondió ${response.status}. Inténtalo de nuevo.`), { setupReady: body.setupReady });
    if (!isJson) throw new Error('El servicio de acceso devolvió una respuesta inesperada.'); return body;
  };
  const passkeySupported = () => root.isSecureContext && !!root.PublicKeyCredential;
  const passkeyEnrollmentKey = userId => `bio-passkey-enrolled-v1:${userId}`;
  const bytes = value => Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const toBase64Url = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const passkeyOptions = options => ({ ...options, challenge: bytes(options.challenge), user: options.user ? { ...options.user, id: bytes(options.user.id) } : undefined, allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: bytes(item.id) })), excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: bytes(item.id) })) });
  const passkeyPayload = credential => { const response=credential.response,encode=value=>value instanceof ArrayBuffer?toBase64Url(value):undefined; return { id:credential.id,rawId:toBase64Url(credential.rawId),type:credential.type,response:{clientDataJSON:encode(response.clientDataJSON),attestationObject:encode(response.attestationObject),authenticatorData:encode(response.authenticatorData),signature:encode(response.signature),userHandle:encode(response.userHandle),transports:response.getTransports?.()||[]},clientExtensionResults:credential.getClientExtensionResults?.()||{} }; };
  const close = () => root.document.querySelector('#bioLoginDialog')?.remove();
  function promptLogin(setupReady) {
    // El formulario vive en una página independiente: la aplicación no se
    // conserva en el DOM ni queda visible detrás de la autenticación.
    if (!isLoginPage()) { root.location.replace(loginPath); return; }
    close(); const dialog = root.document.createElement('dialog'); dialog.id = 'bioLoginDialog'; dialog.className = 'bio-login-dialog';
    dialog.innerHTML = `<form method="dialog" id="bioLoginForm"><section class="bio-login-visual"><div class="bio-login-brand"><img src="assets/probiolab-logo-transparent.png" alt="" /></div><div class="bio-login-copy"><h1>Operación confiable para laboratorio.</h1><p>Centraliza inventario, compras, cotizaciones y evidencia operativa con acceso controlado para cada integrante del equipo.</p></div></section><section class="bio-login-panel"><div class="bio-login-card"><p class="eyebrow">ACCESO RESTRINGIDO</p><h2>${setupReady ? 'Configura tu acceso' : 'Iniciar sesión'}</h2><p class="subtitle">${setupReady ? 'Define una contraseña segura para el administrador existente.' : 'Ingresa con tu correo institucional y contraseña.'}</p><label class="field"><span>CORREO</span><input id="bioLoginEmail" type="email" required autocomplete="email" placeholder="nombre@empresa.com" /></label><label class="field"><span>CONTRASEÑA</span><span class="bio-password-control"><input id="bioLoginPassword" type="password" required minlength="12" autocomplete="current-password" placeholder="••••••••••••" /><button id="bioLoginPasswordToggle" type="button" aria-label="Mostrar contraseña" title="Mostrar contraseña"><i data-lucide="eye"></i></button></span></label><p id="bioLoginError" class="bio-login-error" hidden style="display:none"></p><button class="bio-login-submit" type="submit">${setupReady ? 'Configurar y entrar' : 'Ingresar al sistema'}</button><p class="bio-login-security"><i data-lucide="shield-check"></i> CONEXIÓN SEGURA · SESIÓN PROTEGIDA</p></div></section></form>`;
    root.document.body.append(dialog); initializeLoginTheme(dialog); const form = dialog.querySelector('form'), emailInput = dialog.querySelector('#bioLoginEmail'), passwordInput = dialog.querySelector('#bioLoginPassword'), error = dialog.querySelector('#bioLoginError'), submit = dialog.querySelector('.bio-login-submit');
    if (!setupReady && passkeySupported()) { const passkey = root.document.createElement('button'); passkey.type='button'; passkey.className='bio-passkey-login'; passkey.innerHTML='<i data-lucide="scan-face"></i> Entrar con biometría'; submit.after(passkey); passkey.addEventListener('click', async () => { try { passkey.disabled=true; const start=await request('/api/auth/passkey/login/options',{}), credential=await root.navigator.credentials.get({publicKey:passkeyOptions(start.options)}), result=await request('/api/auth/passkey/login/verify',{response:passkeyPayload(credential)}); session=result.user; rememberLoginTheme(session); root.localStorage.setItem('bio-authenticated','true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready',{detail:session})); openApplication(); } catch (failure) { error.textContent=failure.message||'No fue posible validar la biometría.'; error.hidden=false; error.style.display='flex'; passkey.disabled=false; } }); }
    const resetAttemptFeedback = () => { form.classList.remove('is-error'); error.hidden = true; error.style.display = 'none'; submit.disabled = false; submit.textContent = setupReady ? 'Configurar y entrar' : 'Ingresar al sistema'; };
    [emailInput, passwordInput].forEach(input => input.addEventListener('input', resetAttemptFeedback));
    form.addEventListener('submit', async event => { event.preventDefault(); if (submit.disabled) return; const email = emailInput.value, password = passwordInput.value; form.classList.remove('is-error'); form.classList.add('is-loading'); submit.disabled = true; submit.textContent = 'Validando acceso…'; try { const result = await request(setupReady ? '/api/auth/setup' : '/api/auth/login', { email, password }); session = result.user; form.classList.remove('is-loading'); form.classList.add('is-success'); submit.textContent = 'Acceso validado'; rememberLoginTheme(session); root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); await new Promise(resolve => root.setTimeout(resolve, loginSuccessDelayMs)); openApplication(); } catch (failure) { form.classList.remove('is-loading'); form.classList.add('is-error'); error.textContent = failure.message; error.hidden = false; error.style.display = 'flex'; passwordInput.value = ''; submit.disabled = false; submit.textContent = 'Intentar nuevamente'; passwordInput.focus(); } }); const passwordToggle = dialog.querySelector('#bioLoginPasswordToggle'); passwordToggle.addEventListener('click', () => { const visible = passwordInput.type === 'text'; passwordInput.type = visible ? 'password' : 'text'; const label = visible ? 'Mostrar contraseña' : 'Ocultar contraseña'; passwordToggle.setAttribute('aria-label', label); passwordToggle.title = label; passwordToggle.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`; root.lucide?.createIcons(); passwordInput.focus(); }); dialog.showModal(); root.lucide?.createIcons();
  }
  async function initialize() {
    try { const result = await request('/api/auth/me'); session = result.user; root.localStorage.setItem('bio-authenticated', 'true'); root.BioAccess?.setCurrentUser?.(session.id); root.dispatchEvent(new CustomEvent('bio:auth-ready', { detail: session })); if (isLoginPage()) openApplication(); else revealApplication(); }
    catch (error) { root.localStorage.removeItem('bio-authenticated'); promptLogin(Boolean(error.setupReady)); }
  }
  root.addEventListener('bio:auth-ready', () => {
    const enrollmentKey = passkeyEnrollmentKey(session?.id);
    if (!isLoginPage() || !session?.id || !passkeySupported() || root.sessionStorage.getItem('bio-passkey-offered-v2') || root.localStorage.getItem(enrollmentKey)) return;
    root.__bioPasskeyEnrollment = (async () => {
      try { const status = await request('/api/auth/passkey/status'); if (status.registered) { root.localStorage.setItem(enrollmentKey, 'true'); root.sessionStorage.setItem('bio-passkey-offered-v2', 'true'); return; } } catch { /* Si no se puede consultar, se conserva la opción de registro. */ }
      if (!root.confirm('¿Deseas registrar Face ID, Touch ID o huella en este dispositivo para entrar sin contraseña?')) { root.localStorage.setItem(enrollmentKey, 'declined'); root.sessionStorage.setItem('bio-passkey-offered-v2', 'true'); return; }
      try {
        const start = await request('/api/auth/passkey/register/options', {});
        const credential = await root.navigator.credentials.create({ publicKey: passkeyOptions(start.options) });
        await request('/api/auth/passkey/register/verify', { response: passkeyPayload(credential) });
        root.localStorage.setItem(enrollmentKey, 'true'); root.sessionStorage.setItem('bio-passkey-offered-v2', 'true'); root.alert('Biometría registrada. En tu próximo acceso podrás usar “Entrar con biometría”.');
      } catch (failure) { root.alert(failure.message || 'No fue posible registrar la biometría. Puedes continuar usando tu contraseña.'); }
    })();
  });
  // Mantiene la preferencia usada en el último acceso aun cuando se modifique
  // desde Configuración durante la sesión.
  root.addEventListener('bio:theme-changed', () => { if (session) rememberLoginTheme(session); });
  const deleteUser = async (userId, reason) => {
    const response = await fetch(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'No fue posible eliminar el usuario.'); return body;
  };
  root.BioAuth = { user: () => session && { ...session }, ready: initialize(), setPassword: async (userId, password) => request(`/api/auth/users/${encodeURIComponent(userId)}/password`, { password }), deleteUser, logout: async () => { await request('/api/auth/logout', {}); root.localStorage.removeItem('bio-authenticated'); root.location.reload(); } };
})(window);
