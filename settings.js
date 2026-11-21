(function () {
  'use strict';
  const access = window.BioAccess;
  if (!access) return;
  const q = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const toast = message => typeof window.showToast === 'function' ? window.showToast(message) : alert(message);
  const initials = name => String(name || 'U').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  let activeSettingsSection = 'overview';
  const viewPermissions = {
    inventarioView: 'inventory_view', movimientosView: 'inventory_view', conteosView: 'inventory_manage', reportesView: 'reports',
    productosView: 'catalog_view', proveedoresView: 'supplier_view', preciosView: 'supplier_manage', clientesView: 'client_view', quotationSummaryView: 'quotation_view', cotizacionesView: 'quotation_view', newQuotationView: 'quotation_manage',
    salesOrdersView: 'client_order_view', ordersView: 'client_order_view', supplierOrdersView: 'supplier_order_view', auditView: 'audit', sandboxView: 'sandbox'
  };
  const actionPermissions = [
    ['#newProduct, #newCatalogProduct, [data-open="entrada"], [data-open="salida"], [data-open="traspaso"], [data-open="merma"], #applyCount', 'inventory_manage'],
    ['#newSupplier', 'supplier_manage'], ['#selectPriceFile, #applyPrices, #skipSelectedPrices, #deleteSelectedPrices', 'supplier_manage'],
    ['#newQuotation, #emitQuotation, #cancelQuotation, [data-quotation-product], [data-edit-quotation], [data-delete-quotation]', 'quotation_manage'], ['#newClient, [data-toggle-client-block], [data-edit-client], [data-retire-client], [data-add-advance]', 'client_manage'], ['[data-convert-quotation]', 'client_order_manage'],
    ['[data-activate-commercial-order]', 'client_order_activate'], ['[data-continue-commercial-order]', 'supplier_order_view'], ['[data-confirm-supplier-order]', 'supplier_order_manage'], ['#newSystemUser, [data-edit-system-user]', 'user_manage'], ['#refreshFxRates, #openManualFx, #saveFxProtection, #saveFxBanxicoToken, #quotationTermsSettingsForm', 'system_config']
  ];
  const formPermissions = { movementForm: 'inventory_manage', newProductForm: 'catalog_manage', catalogProductForm: 'catalog_manage', supplierForm: 'supplier_manage', quotationForm: 'quotation_manage', clientEditorForm: 'client_manage', clientAdvanceForm: 'client_manage', systemUserForm: 'user_manage', manualFxForm: 'system_config', quotationTermsSettingsForm: 'system_config' };

  function applyNavigationAccess() {
    Object.entries(viewPermissions).forEach(([view, permission]) => document.querySelectorAll(`[data-view="${view}"]`).forEach(link => { link.hidden = !access.can(permission) || (view === 'sandboxView' && !access.isSandboxEnabled?.()); }));
    document.querySelectorAll('.nav-group').forEach(group => { group.hidden = ![...group.querySelectorAll('[data-view]')].some(link => !link.hidden); });
    const active = document.querySelector('.nav-item.active[data-view], .nav-subitem.active[data-view]');
    if (active?.hidden) document.querySelector('[data-view="panel"]')?.click();
  }

  function updateSidebarProfile() {
    const user = access.currentUser(), role = access.role(user?.role);
    q('#sidebarProfileName').textContent = user?.name || 'Sin usuario'; q('#sidebarProfileRole').textContent = role?.name || 'Sin perfil'; q('#sidebarProfileAvatar').textContent = initials(user?.name);
  }

  function setSettingsSection(section) {
    const securityManager = ['administrator', 'developer'].includes(access.currentUser()?.role);
    const allowed = candidate => candidate === 'themes' || (['users', 'permissions'].includes(candidate) ? securityManager : access.can('system_config'));
    document.querySelectorAll('[data-settings-section]').forEach(button => { button.hidden = !allowed(button.dataset.settingsSection); });
    const requested = q(`[data-settings-panel="${section}"]`) ? section : (access.can('system_config') ? 'overview' : 'themes');
    const target = allowed(requested) ? requested : 'themes';
    activeSettingsSection = target;
    document.querySelectorAll('[data-settings-section]').forEach(button => {
      const active = button.dataset.settingsSection === target;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => {
      const active = panel.dataset.settingsPanel === target;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
    q('#newSystemUser').hidden = target !== 'users' || !access.can('user_manage');
    window.lucide?.createIcons();
  }

  function renderSettings() {
    const state = access.getState(), current = access.currentUser(), authority = window.BioAuth?.user?.() || current, canManage = ['administrator', 'developer'].includes(authority?.role) && access.can('user_manage', authority);
    q('#newSystemUser').hidden = !canManage || activeSettingsSection !== 'users';
    q('#accessUserCount').textContent = state.users.length; q('#accessActiveCount').textContent = state.users.filter(user => user.status === 'active').length; q('#accessCurrentRole').textContent = access.role(current?.role)?.name || '—';
    const sessionOptions = state.users.filter(user => user.status === 'active').map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(access.role(user.role)?.name)}</option>`).join('');
    q('#accessCurrentUser').innerHTML = sessionOptions; q('#accessCurrentUser').value = current?.id || ''; q('#accessCurrentUser').disabled = !canManage; q('#accessCurrentUser').title = q('#accessCurrentUser').disabled ? 'Disponible únicamente para Desarrollo y Administración.' : 'Simula el perfil en pantalla; la sesión y auditoría del servidor conservan la cuenta autenticada.';
    q('#themeSessionUser').innerHTML = sessionOptions; q('#themeSessionUser').value = current?.id || '';
    // Desarrollo y Administración pueden simular la interfaz; la identidad de servidor no cambia.
    q('#themeSessionUser').closest('.access-session-select').hidden = !canManage;
    q('#accessUserList').innerHTML = state.users.map(user => `<article class="access-user-row"><div class="access-user-identity"><span>${escapeHtml(initials(user.name))}</span><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role === 'seller' ? `${user.sellerNumber || 'Sin número'} · ` : '')}${escapeHtml(user.email)} · ${escapeHtml(user.id)}</small></div></div><span class="access-role-pill ${escapeHtml(user.role)}">${escapeHtml(access.role(user.role)?.name || user.role)}</span><span class="access-user-status ${user.status}"><i></i>${user.status === 'active' ? 'Activo' : 'Inactivo'}</span><small>${user.updatedAt ? new Date(user.updatedAt).toLocaleString('es-MX') : 'Registro inicial'}</small><div class="access-user-actions" ${canManage ? '' : 'hidden'}><button data-edit-system-user="${escapeHtml(user.id)}" title="Editar usuario" aria-label="Editar usuario"><i data-lucide="pencil"></i></button><button data-reset-system-user="${escapeHtml(user.id)}" title="Restablecer contraseña" aria-label="Restablecer contraseña"><i data-lucide="key-round"></i></button><button data-toggle-system-user="${escapeHtml(user.id)}" title="${user.status === 'active' ? 'Bloquear usuario' : 'Reactivar usuario'}" aria-label="${user.status === 'active' ? 'Bloquear usuario' : 'Reactivar usuario'}"><i data-lucide="${user.status === 'active' ? 'lock-keyhole' : 'user-check'}"></i></button><button data-delete-system-user="${escapeHtml(user.id)}" title="Eliminar usuario" aria-label="Eliminar usuario"><i data-lucide="trash-2"></i></button></div></article>`).join('');
    q('#accessRoleCards').innerHTML = Object.values(access.ROLES).map(role => { const permissions = access.rolePermissions(role.id); return `<article class="access-role-card ${role.id}"><div><span><i data-lucide="${role.id === 'administrator' ? 'crown' : role.id === 'auditor' ? 'scan-eye' : role.id === 'supervisor' ? 'shield-check' : 'briefcase-business'}"></i></span><div><strong>${escapeHtml(role.name)}</strong><small>${permissions.length} permisos en la plantilla</small></div></div><p>${escapeHtml(role.description)}</p><ul>${permissions.slice(0, 6).map(permission => `<li><i data-lucide="check"></i>${escapeHtml(access.PERMISSIONS[permission])}</li>`).join('')}${permissions.length > 6 ? `<li class="more">+ ${permissions.length - 6} permisos adicionales</li>` : ''}</ul></article>`; }).join('');
    q('#accessPermissionMatrix').innerHTML = Object.entries(access.PERMISSIONS).map(([permission, label]) => `<tr><td>${escapeHtml(label)}</td>${Object.keys(access.ROLES).map(role => { const allowed = access.rolePermissions(role).includes(permission), locked = permission === 'user_manage' || permission === 'system_reset'; return `<td><label class="role-permission-toggle ${allowed ? 'allowed' : 'denied'} ${locked ? 'locked' : ''}" title="${locked ? 'Permiso reservado' : 'Modificar plantilla del perfil'}"><input type="checkbox" data-role-permission="${role}" value="${permission}" ${allowed ? 'checked' : ''} ${locked ? 'disabled' : ''} /><i data-lucide="${allowed ? 'check' : 'minus'}"></i></label></td>`; }).join('')}</tr>`).join('');
    q('.access-matrix-card .card-top > small').textContent = 'Los cambios ajustan la plantilla del perfil y quedan auditados.';
    renderSystemResetControl();
    window.lucide?.createIcons();
  }

  function renderUserPermissionEditor(user = null) {
    const roleId = q('#systemUserRole').value, baseline = new Set(access.rolePermissions(roleId)), grants = new Set(user?.permissionGrants || []), denials = new Set(user?.permissionDenials || []);
    q('#systemUserPermissions').innerHTML = Object.entries(access.PERMISSIONS).map(([permission, label]) => {
      const base = baseline.has(permission), checked = denials.has(permission) ? false : grants.has(permission) || base, locked = permission === 'user_manage' || permission === 'system_reset';
      return `<label class="user-permission-option ${base ? 'baseline' : 'optional'} ${locked ? 'locked' : ''}"><input type="checkbox" value="${escapeHtml(permission)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span><strong>${escapeHtml(label)}</strong><small>${locked ? 'Facultad reservada por perfil de seguridad' : base ? 'Incluido por el perfil' : 'Permiso especial opcional'}</small></span></label>`;
    }).join('');
  }

  function renderSystemResetControl() {
    const overview = q('[data-settings-panel="overview"]'), current = access.currentUser();
    if (!overview) return;
    let control = q('#systemResetControl');
    if (!control) {
      control = document.createElement('section');
      control.id = 'systemResetControl'; control.className = 'module-card system-reset-card';
      control.innerHTML = '<div class="system-reset-head"><span class="system-reset-icon"><i data-lucide="shield-alert"></i></span><div class="system-reset-copy"><p class="eyebrow">RECUPERACIÓN CONTROLADA</p><h2>Restablecer datos operativos</h2><p>Elimina la operación para iniciar de nuevo, conservando cuentas, configuración y evidencia de auditoría.</p></div><button type="button" class="system-reset-trigger" data-open-system-reset><i data-lucide="rotate-ccw"></i><span>Restablecer sistema</span></button></div><div class="system-reset-guard"><i data-lucide="lock-keyhole"></i><span>Protección reforzada: se requiere contraseña actual, aprobación de emergencia y confirmación explícita.</span></div>';
      overview.append(control);
    }
    control.hidden = !(current?.role === 'developer' && access.can('system_reset'));
  }

  function openSystemResetDialog() {
    const current = access.currentUser();
    if (current?.role !== 'developer' || !access.can('system_reset')) return toast('Solo el perfil de Desarrollo puede restablecer los datos operativos.');
    q('#systemResetDialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'systemResetDialog'; dialog.className = 'system-dialog access-user-dialog';
    dialog.innerHTML = `<form autocomplete="off" data-form-type="other"><input type="email" name="resetUsername" value="${escapeHtml(current.email || '')}" autocomplete="username" tabindex="-1" aria-hidden="true" style="position:fixed;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none" /><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="shield-alert"></i></span><div><p class="eyebrow">ACCIÓN DE EMERGENCIA</p><h2>Restablecer datos operativos</h2></div></div><button type="button" class="close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="modal-body"><p class="subtitle">Esta acción borra la operación y no puede deshacerse. Las cuentas, la configuración y la auditoría se conservan.</p><label class="field wide"><span>Justificación <em>obligatoria</em></span><textarea name="reason" rows="3" required minlength="8" placeholder="Describe por qué se requiere el restablecimiento"></textarea></label><label class="field wide"><span>Confirmación <em>obligatoria</em></span><input name="resetPhrase" type="text" required readonly autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" data-lpignore="true" data-1p-ignore placeholder="Escribe RESTABLECER SISTEMA" aria-describedby="systemResetPhraseHelp" /><small id="systemResetPhraseHelp">Escribe aquí exactamente <b>RESTABLECER SISTEMA</b>.</small></label><label class="field wide"><span>Tu contraseña actual <em>obligatoria</em></span><input name="password" type="password" required autocomplete="current-password" /></label><label class="field wide"><span>Aprobación de emergencia <em>obligatoria</em></span><input name="approvalToken" type="password" required autocomplete="one-time-code" data-lpignore="true" data-1p-ignore placeholder="Token configurado para contingencias" /></label><p class="confirm-note" id="systemResetFeedback" hidden role="status"></p></div><div class="modal-actions"><button type="button" class="cancel">Cancelar</button><button class="submit danger" type="submit">Restablecer sistema <i data-lucide="shield-alert"></i></button></div></form>`;
    document.body.append(dialog);
    const tokenField=dialog.querySelector('[name="approvalToken"]'),confirmationField=dialog.querySelector('[name="resetPhrase"]'),generate=document.createElement('button');const unlockConfirmation=()=>{if(!confirmationField.readOnly)return;confirmationField.readOnly=false;confirmationField.value='';};confirmationField.addEventListener('pointerdown',unlockConfirmation,{once:true});confirmationField.addEventListener('focus',unlockConfirmation,{once:true});generate.type='button';generate.className='filter';generate.textContent='Generar aprobación de un solo uso';tokenField.before(generate);generate.addEventListener('click',async()=>{try{const response=await fetch('/api/system/reset',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'generate-approval'})}),result=await response.json();if(!response.ok)throw new Error(result.error||'No fue posible generar la aprobación.');tokenField.value=result.token;tokenField.type='text';toast('Aprobación creada; vence en 15 minutos y se usará una sola vez.');}catch(error){toast(error.message||'No fue posible generar la aprobación.')}});
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget), feedback = q('#systemResetFeedback'), submit = dialog.querySelector('.submit');
      const body = Object.fromEntries(form.entries()); body.confirmation = body.resetPhrase; delete body.resetPhrase; delete body.resetUsername;
      if (body.confirmation !== 'RESTABLECER SISTEMA') { feedback.textContent = 'Escribe exactamente RESTABLECER SISTEMA para continuar.'; feedback.hidden = false; return; }
      submit.disabled = true; submit.innerHTML = 'Restableciendo…'; feedback.hidden = true;
      try {
        const response = await fetch('/api/system/reset', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'No fue posible restablecer el sistema.');
        close();
        window.BioPersistence?.suspendWrites?.(() => window.BioAccess?.setWorkspaceMode?.('operational'));
        window.BioPersistence?.clearLocalState?.({ keepAccess: true });
        toast(result.message || 'Los datos operativos fueron restablecidos.');
        window.setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        submit.disabled = false; submit.innerHTML = 'Restablecer sistema <i data-lucide="shield-alert"></i>'; window.lucide?.createIcons(); feedback.textContent = error.message || 'No fue posible restablecer el sistema.'; feedback.hidden = false;
      }
    });
    dialog.showModal(); window.lucide?.createIcons(); dialog.querySelector('[name="reason"]').focus();
  }

  function openUserDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede modificar usuarios y perfiles.');
    const user = access.getState().users.find(item => item.id === userId);
    let password = q('#systemUserPassword');
    if (!password) { const label = document.createElement('label'); label.id = 'systemUserPasswordField'; label.className = 'field wide'; label.innerHTML = '<span>Contraseña de acceso</span><span class="password-control"><input id="systemUserPassword" type="password" minlength="12" autocomplete="new-password" placeholder="Mínimo 12 caracteres" /><button type="button" class="password-toggle" data-password-toggle="systemUserPassword" aria-label="Mostrar contraseña" title="Mostrar contraseña"><i data-lucide="eye"></i></button></span><small>Se guarda con hash y nunca se muestra de nuevo.</small>'; q('#systemUserForm .form-grid').append(label); password = q('#systemUserPassword'); }
    q('#systemUserForm').reset(); q('#systemUserPasswordField').hidden = Boolean(user); password.required = !user;
    if (!q('#systemUserRole').querySelector('option[value=""]')) q('#systemUserRole').insertAdjacentHTML('afterbegin', '<option value="" disabled>Selecciona un perfil</option>');
    q('#systemUserId').value = user?.id || ''; q('#systemUserDialogTitle').textContent = user ? 'Editar usuario' : 'Nuevo usuario';
    q('#systemUserName').value = user?.name || ''; q('#systemUserEmail').value = user?.email || ''; q('#systemUserRole').value = user?.role || ''; q('#systemUserStatus').value = user?.status || 'active'; q('#systemUserSellerNumber').value = user?.sellerNumber || 'Se asignará automáticamente al guardar'; q('#systemUserSellerNumberField').hidden = q('#systemUserRole').value !== 'seller'; q('#systemUserSellerNumber').disabled = q('#systemUserRole').value !== 'seller'; renderUserPermissionEditor(user); q('#systemUserDialog').showModal(); window.lucide?.createIcons();
  }

  function openPasswordResetDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede restablecer contraseñas.');
    const user = access.getState().users.find(item => item.id === userId && item.status === 'active');
    if (!user) return toast('El usuario activo no está disponible.');
    const existing = q('#systemPasswordResetDialog'); existing?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'systemPasswordResetDialog'; dialog.className = 'system-dialog access-user-dialog';
    dialog.innerHTML = '<form id="systemPasswordResetForm"><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="key-round"></i></span><div><p class="eyebrow">RECUPERACIÓN DE ACCESO</p><h2>Restablecer contraseña</h2></div></div><button type="button" class="close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="modal-body"><p class="subtitle">Define una nueva contraseña para el usuario seleccionado. La anterior dejará de funcionar.</p><p id="systemPasswordResetUser" class="confirm-note"></p><div class="form-grid"><label class="field wide"><span>Nueva contraseña</span><span class="password-control"><input id="systemPasswordResetValue" type="password" required minlength="12" autocomplete="new-password" placeholder="Mínimo 12 caracteres" /><button type="button" class="password-toggle" data-password-toggle="systemPasswordResetValue" aria-label="Mostrar contraseña" title="Mostrar contraseña"><i data-lucide="eye"></i></button></span></label><label class="field wide"><span>Confirmar contraseña</span><span class="password-control"><input id="systemPasswordResetConfirm" type="password" required minlength="12" autocomplete="new-password" placeholder="Repite la contraseña" /><button type="button" class="password-toggle" data-password-toggle="systemPasswordResetConfirm" aria-label="Mostrar contraseña" title="Mostrar contraseña"><i data-lucide="eye"></i></button></span></label></div></div><div class="modal-actions"><button type="button" class="cancel">Cancelar</button><button class="submit" type="submit">Restablecer contraseña <i data-lucide="check"></i></button></div></form>';
    document.body.append(dialog); q('#systemPasswordResetUser').textContent = `${user.name} · ${user.email}`;
    const feedback = document.createElement('p'); feedback.id = 'systemPasswordResetFeedback'; feedback.className = 'confirm-note'; feedback.hidden = true; feedback.setAttribute('role', 'status'); dialog.querySelector('.form-grid').before(feedback);
    const close = () => { dialog.close(); dialog.remove(); }; dialog.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); const password = q('#systemPasswordResetValue').value, confirmation = q('#systemPasswordResetConfirm').value, submit = dialog.querySelector('.submit');
      const report = message => { feedback.textContent = message; feedback.hidden = false; };
      if (password !== confirmation) { report('La confirmación de la contraseña no coincide.'); return; }
      submit.disabled = true; submit.innerHTML = 'Guardando cambio…'; feedback.hidden = true;
      try {
        if (!window.BioAuth?.setPassword) throw new Error('El servicio de acceso no está disponible. Recarga la página e inténtalo de nuevo.');
        await window.BioAuth.setPassword(user.id, password);
        close(); window.setTimeout(() => toast(`Contraseña restablecida correctamente para ${user.name}.`), 0);
      } catch (error) {
        submit.disabled = false; submit.innerHTML = 'Restablecer contraseña <i data-lucide="check"></i>'; window.lucide?.createIcons();
        report(error.message || 'No fue posible restablecer la contraseña.');
      }
    });
    dialog.showModal(); window.lucide?.createIcons(); q('#systemPasswordResetValue').focus();
  }

  function openUserStatusDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede cambiar el estado de un usuario.');
    const user = access.getState().users.find(item => item.id === userId);
    if (!user) return toast('El usuario ya no está disponible.');
    const nextStatus = user.status === 'active' ? 'inactive' : 'active', action = nextStatus === 'inactive' ? 'Bloquear usuario' : 'Reactivar usuario';
    const dialog = document.createElement('dialog'); dialog.className = 'system-dialog access-user-dialog';
    dialog.innerHTML = `<form><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="${nextStatus === 'inactive' ? 'lock-keyhole' : 'user-check'}"></i></span><div><p class="eyebrow">CONTROL DE ACCESO</p><h2>${action}</h2></div></div><button type="button" class="close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="modal-body"><p class="subtitle">${nextStatus === 'inactive' ? 'El usuario no podrá iniciar sesión mientras permanezca bloqueado.' : 'El usuario podrá volver a iniciar sesión con su contraseña actual.'}</p><p class="confirm-note">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</p><label class="field wide"><span>Justificación <em>obligatoria</em></span><textarea required rows="3" placeholder="Indica el motivo de esta acción"></textarea></label></div><div class="modal-actions"><button type="button" class="cancel">Cancelar</button><button class="submit" type="submit">${action} <i data-lucide="check"></i></button></div></form>`;
    document.body.append(dialog); const close = () => { dialog.close(); dialog.remove(); }; dialog.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const reason = dialog.querySelector('textarea').value.trim(); if (!reason) return toast('La justificación es obligatoria.'); const result = access.saveUser({ ...user, status: nextStatus, reason }); if (!result.ok) return toast(result.message); try { await window.BioPersistence?.flush({ throwOnError: true }); close(); toast(`${user.name} fue ${nextStatus === 'inactive' ? 'bloqueado' : 'reactivado'} correctamente.`); } catch (error) { toast(error.message || 'No fue posible guardar el cambio en la base central.'); } });
    dialog.showModal(); window.lucide?.createIcons(); dialog.querySelector('textarea').focus();
  }

  function openUserDeleteDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede eliminar usuarios.');
    const user = access.getState().users.find(item => item.id === userId);
    if (!user) return toast('El usuario ya no está disponible.');
    const dialog = document.createElement('dialog'); dialog.className = 'system-dialog access-user-dialog';
    dialog.innerHTML = `<form><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="trash-2"></i></span><div><p class="eyebrow">ELIMINACIÓN DE USUARIO</p><h2>Eliminar usuario</h2></div></div><button type="button" class="close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="modal-body"><p class="subtitle">Esta acción elimina el acceso, contraseña y sesiones activas del usuario. No se puede deshacer.</p><p class="confirm-note">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</p><label class="field wide"><span>Justificación <em>obligatoria</em></span><textarea required rows="3" placeholder="Indica el motivo de la eliminación"></textarea></label></div><div class="modal-actions"><button type="button" class="cancel">Cancelar</button><button class="submit danger" type="submit">Eliminar usuario <i data-lucide="trash-2"></i></button></div></form>`;
    document.body.append(dialog); const close = () => { dialog.close(); dialog.remove(); }; dialog.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const reason = dialog.querySelector('textarea').value.trim(); if (!reason) return toast('La justificación es obligatoria.'); try { await window.BioAuth?.deleteUser(user.id, reason); const result = access.deleteUser(user.id, reason); if (!result.ok) throw new Error(result.message); await window.BioPersistence?.flush({ throwOnError: true }); close(); toast(`${user.name} fue eliminado correctamente.`); } catch (error) { toast(error.message || 'No fue posible eliminar el usuario.'); } });
    dialog.showModal(); window.lucide?.createIcons(); dialog.querySelector('textarea').focus();
  }

  document.addEventListener('click', event => {
    const passwordToggle = event.target.closest('[data-password-toggle]');
    if (passwordToggle) {
      const input = q(`#${passwordToggle.dataset.passwordToggle}`);
      if (!input) return;
      const visible = input.type === 'text'; input.type = visible ? 'password' : 'text';
      const label = visible ? 'Mostrar contraseña' : 'Ocultar contraseña';
      passwordToggle.setAttribute('aria-label', label); passwordToggle.title = label;
      passwordToggle.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`;
      window.lucide?.createIcons(); input.focus(); return;
    }
    const viewLink = event.target.closest('[data-view]');
    if (viewLink && viewPermissions[viewLink.dataset.view] && (!access.can(viewPermissions[viewLink.dataset.view]) || (viewLink.dataset.view === 'sandboxView' && !access.isSandboxEnabled?.()))) {
      event.preventDefault(); event.stopImmediatePropagation(); toast('Este módulo está restringido para tu perfil.'); return;
    }
    const sectionButton = event.target.closest('[data-settings-section], [data-settings-target]');
    if (sectionButton) setSettingsSection(sectionButton.dataset.settingsSection || sectionButton.dataset.settingsTarget);
    if (event.target.closest('[data-open-system-reset]')) { event.preventDefault(); openSystemResetDialog(); return; }
    for (const [selector, permission] of actionPermissions) {
      if (event.target.closest(selector) && !access.can(permission)) { event.preventDefault(); event.stopImmediatePropagation(); toast(`Tu perfil de ${access.role(access.currentUser()?.role)?.name || 'usuario'} no tiene permiso para esta acción.`); return; }
    }
  }, true);
  document.addEventListener('submit', event => {
    const permission = formPermissions[event.target.id];
    if (permission && !access.can(permission)) { event.preventDefault(); event.stopImmediatePropagation(); toast('Tu perfil no tiene permiso para guardar esta operación.'); }
  }, true);
  q('#newSystemUser').addEventListener('click', () => openUserDialog());
  q('#accessUserList').addEventListener('click', event => { const edit = event.target.closest('[data-edit-system-user]'), reset = event.target.closest('[data-reset-system-user]'), toggle = event.target.closest('[data-toggle-system-user]'), remove = event.target.closest('[data-delete-system-user]'); if (edit) openUserDialog(edit.dataset.editSystemUser); if (reset) openPasswordResetDialog(reset.dataset.resetSystemUser); if (toggle) openUserStatusDialog(toggle.dataset.toggleSystemUser); if (remove) openUserDeleteDialog(remove.dataset.deleteSystemUser); });
  q('#accessPermissionMatrix').addEventListener('change', event => { const input = event.target.closest('[data-role-permission]'); if (!input) return; const role = input.dataset.rolePermission, selected = [...q('#accessPermissionMatrix').querySelectorAll(`[data-role-permission="${role}"]:checked`)].map(item => item.value), result = access.saveRolePermissions(role, selected); if (!result.ok) return toast(result.message); toast(`Plantilla de ${access.role(role).name} actualizada.`); });
  q('#accessCurrentUser').addEventListener('change', event => { if (access.setCurrentUser(event.target.value)) { renderSettings(); toast(`Vista local cambiada a ${access.currentUser().name}. La auditoría conserva tu cuenta autenticada.`); } else { event.target.value = access.currentUser()?.id || ''; toast('Tu perfil no puede cambiar esta vista.'); } });
  q('#themeSessionUser').addEventListener('change', event => { if (access.setCurrentUser(event.target.value)) { setSettingsSection('themes'); toast(`Perfil de prueba cambiado a ${access.currentUser().name}.`); } });
  const profileMenu = q('#sidebarProfileMenu'), profileMenuToggle = q('#sidebarProfileMenuToggle');
  const closeProfileMenu = () => { profileMenu.hidden = true; profileMenuToggle.setAttribute('aria-expanded', 'false'); };
  profileMenuToggle.addEventListener('click', event => { event.stopPropagation(); profileMenu.hidden = !profileMenu.hidden; profileMenuToggle.setAttribute('aria-expanded', String(!profileMenu.hidden)); });
  q('#sidebarLogout').addEventListener('click', async () => {
    const button = q('#sidebarLogout'); button.disabled = true;
    try { await window.BioAuth?.logout?.(); }
    catch (error) { button.disabled = false; toast(error.message || 'No fue posible cerrar la sesión.'); }
  });
  document.addEventListener('click', event => { if (!q('#sidebarProfile')?.contains(event.target)) closeProfileMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeProfileMenu(); });
  q('#systemUserRole').addEventListener('change', () => { const isSeller = q('#systemUserRole').value === 'seller'; q('#systemUserSellerNumberField').hidden = !isSeller; q('#systemUserSellerNumber').disabled = !isSeller; q('#systemUserSellerNumber').value = isSeller ? (access.getState().users.find(user => user.id === q('#systemUserId').value && user.role === 'seller')?.sellerNumber || 'Se asignará automáticamente al guardar') : ''; renderUserPermissionEditor(); });
  q('#systemUserForm').addEventListener('submit', async event => { event.preventDefault(); const role = q('#systemUserRole').value, baseline = new Set(access.rolePermissions(role)), checked = new Set([...q('#systemUserPermissions').querySelectorAll('input:checked')].map(input => input.value)), permissionGrants = [...checked].filter(permission => !baseline.has(permission)), permissionDenials = [...baseline].filter(permission => !checked.has(permission)), email = q('#systemUserEmail').value.trim().toLowerCase(), password = q('#systemUserPassword').value, originalId = q('#systemUserId').value || null; const result = access.saveUser({ id: originalId, name: q('#systemUserName').value, email, role, sellerNumber: q('#systemUserSellerNumber').value, status: q('#systemUserStatus').value, permissionGrants, permissionDenials }); if (!result.ok) return toast(result.message); const user = access.getState().users.find(item => item.email.toLowerCase() === email); try { if (password) { await window.BioPersistence?.flush({ throwOnError: true }); await window.BioAuth?.setPassword(user?.id, password); } } catch (error) { return toast(error.message || 'No fue posible guardar el usuario en la base central.'); } q('#systemUserDialog').close(); toast(password ? `Usuario ${originalId ? 'actualizado' : 'creado'} y contraseña asignada correctamente.` : 'Usuario y permisos actualizados correctamente.'); });
  document.querySelectorAll('.access-dialog-close').forEach(button => button.addEventListener('click', () => q('#systemUserDialog').close()));
  window.addEventListener('bio:access-changed', () => { updateSidebarProfile(); applyNavigationAccess(); renderSettings(); setSettingsSection(activeSettingsSection); });
  updateSidebarProfile(); applyNavigationAccess(); renderSettings(); setSettingsSection(activeSettingsSection);
})();
