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
    ['[data-activate-commercial-order]', 'client_order_activate'], ['[data-continue-commercial-order]', 'supplier_order_view'], ['[data-confirm-supplier-order]', 'supplier_order_manage'], ['#newSystemUser, [data-edit-system-user]', 'user_manage'], ['#refreshFxRates, #openManualFx, #saveFxProtection, #saveFxBanxicoToken', 'system_config']
  ];
  const formPermissions = { movementForm: 'inventory_manage', newProductForm: 'catalog_manage', catalogProductForm: 'catalog_manage', supplierForm: 'supplier_manage', quotationForm: 'quotation_manage', clientEditorForm: 'client_manage', clientAdvanceForm: 'client_manage', systemUserForm: 'user_manage', manualFxForm: 'system_config' };

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
    const administrator = access.currentUser()?.role === 'administrator';
    const allowed = candidate => candidate === 'themes' || (['users', 'permissions'].includes(candidate) ? administrator : access.can('system_config'));
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
    const state = access.getState(), current = access.currentUser(), canManage = current?.role === 'administrator' && access.can('user_manage');
    q('#newSystemUser').hidden = !canManage || activeSettingsSection !== 'users';
    q('#accessUserCount').textContent = state.users.length; q('#accessActiveCount').textContent = state.users.filter(user => user.status === 'active').length; q('#accessCurrentRole').textContent = access.role(current?.role)?.name || '—';
    const sessionOptions = state.users.filter(user => user.status === 'active').map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(access.role(user.role)?.name)}</option>`).join('');
    q('#accessCurrentUser').innerHTML = sessionOptions; q('#accessCurrentUser').value = current?.id || '';
    q('#themeSessionUser').innerHTML = sessionOptions; q('#themeSessionUser').value = current?.id || '';
    q('#accessUserList').innerHTML = state.users.map(user => `<article class="access-user-row"><div class="access-user-identity"><span>${escapeHtml(initials(user.name))}</span><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)} · ${escapeHtml(user.id)}</small></div></div><span class="access-role-pill ${escapeHtml(user.role)}">${escapeHtml(access.role(user.role)?.name || user.role)}</span><span class="access-user-status ${user.status}"><i></i>${user.status === 'active' ? 'Activo' : 'Inactivo'}</span><small>${user.updatedAt ? new Date(user.updatedAt).toLocaleString('es-MX') : 'Registro inicial'}</small><div class="access-user-actions" ${canManage ? '' : 'hidden'}><button data-edit-system-user="${escapeHtml(user.id)}" title="Editar usuario"><i data-lucide="pencil"></i></button><button data-reset-system-user="${escapeHtml(user.id)}" title="Restablecer contraseña"><i data-lucide="key-round"></i></button></div></article>`).join('');
    q('#accessRoleCards').innerHTML = Object.values(access.ROLES).map(role => { const permissions = access.rolePermissions(role.id); return `<article class="access-role-card ${role.id}"><div><span><i data-lucide="${role.id === 'administrator' ? 'crown' : role.id === 'auditor' ? 'scan-eye' : role.id === 'supervisor' ? 'shield-check' : 'briefcase-business'}"></i></span><div><strong>${escapeHtml(role.name)}</strong><small>${permissions.length} permisos en la plantilla</small></div></div><p>${escapeHtml(role.description)}</p><ul>${permissions.slice(0, 6).map(permission => `<li><i data-lucide="check"></i>${escapeHtml(access.PERMISSIONS[permission])}</li>`).join('')}${permissions.length > 6 ? `<li class="more">+ ${permissions.length - 6} permisos adicionales</li>` : ''}</ul></article>`; }).join('');
    q('#accessPermissionMatrix').innerHTML = Object.entries(access.PERMISSIONS).map(([permission, label]) => `<tr><td>${escapeHtml(label)}</td>${['administrator', 'auditor', 'supervisor', 'seller'].map(role => { const allowed = access.rolePermissions(role).includes(permission), locked = permission === 'user_manage'; return `<td><label class="role-permission-toggle ${allowed ? 'allowed' : 'denied'} ${locked ? 'locked' : ''}" title="${locked ? 'Reservado al Administrador' : 'Modificar plantilla del perfil'}"><input type="checkbox" data-role-permission="${role}" value="${permission}" ${allowed ? 'checked' : ''} ${locked ? 'disabled' : ''} /><i data-lucide="${allowed ? 'check' : 'minus'}"></i></label></td>`; }).join('')}</tr>`).join('');
    q('.access-matrix-card .card-top > small').textContent = 'Los cambios ajustan la plantilla del perfil y quedan auditados.';
    window.lucide?.createIcons();
  }

  function renderUserPermissionEditor(user = null) {
    const roleId = q('#systemUserRole').value || 'seller', baseline = new Set(access.rolePermissions(roleId)), grants = new Set(user?.permissionGrants || []), denials = new Set(user?.permissionDenials || []);
    q('#systemUserPermissions').innerHTML = Object.entries(access.PERMISSIONS).map(([permission, label]) => {
      const base = baseline.has(permission), checked = denials.has(permission) ? false : grants.has(permission) || base, locked = permission === 'user_manage';
      return `<label class="user-permission-option ${base ? 'baseline' : 'optional'} ${locked ? 'locked' : ''}"><input type="checkbox" value="${escapeHtml(permission)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span><strong>${escapeHtml(label)}</strong><small>${locked ? 'Reservado al perfil Administrador' : base ? 'Incluido por el perfil' : 'Permiso especial opcional'}</small></span></label>`;
    }).join('');
  }

  function openUserDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede modificar usuarios y perfiles.');
    const user = access.getState().users.find(item => item.id === userId);
    let password = q('#systemUserPassword');
    if (!password) { const label = document.createElement('label'); label.id = 'systemUserPasswordField'; label.className = 'field wide'; label.innerHTML = '<span>Contraseña de acceso</span><input id="systemUserPassword" type="password" minlength="12" autocomplete="new-password" placeholder="Mínimo 12 caracteres" /><small>Se guarda con hash y nunca se muestra de nuevo.</small>'; q('#systemUserForm .form-grid').append(label); password = q('#systemUserPassword'); }
    q('#systemUserForm').reset(); q('#systemUserPasswordField').hidden = Boolean(user); password.required = !user;
    q('#systemUserId').value = user?.id || ''; q('#systemUserDialogTitle').textContent = user ? 'Editar usuario' : 'Nuevo usuario';
    q('#systemUserName').value = user?.name || ''; q('#systemUserEmail').value = user?.email || ''; q('#systemUserRole').value = user?.role || 'seller'; q('#systemUserStatus').value = user?.status || 'active'; renderUserPermissionEditor(user); q('#systemUserDialog').showModal(); window.lucide?.createIcons();
  }

  function openPasswordResetDialog(userId) {
    if (!access.can('user_manage')) return toast('Solo el administrador puede restablecer contraseñas.');
    const user = access.getState().users.find(item => item.id === userId && item.status === 'active');
    if (!user) return toast('El usuario activo no está disponible.');
    const existing = q('#systemPasswordResetDialog'); existing?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'systemPasswordResetDialog'; dialog.className = 'system-dialog access-user-dialog';
    dialog.innerHTML = '<form id="systemPasswordResetForm"><div class="modal-title"><div class="modal-heading"><span class="modal-icon"><i data-lucide="key-round"></i></span><div><p class="eyebrow">RECUPERACIÓN DE ACCESO</p><h2>Restablecer contraseña</h2></div></div><button type="button" class="close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="modal-body"><p class="subtitle">Define una nueva contraseña para el usuario seleccionado. La anterior dejará de funcionar.</p><p id="systemPasswordResetUser" class="confirm-note"></p><div class="form-grid"><label class="field wide"><span>Nueva contraseña</span><input id="systemPasswordResetValue" type="password" required minlength="12" autocomplete="new-password" placeholder="Mínimo 12 caracteres" /></label><label class="field wide"><span>Confirmar contraseña</span><input id="systemPasswordResetConfirm" type="password" required minlength="12" autocomplete="new-password" placeholder="Repite la contraseña" /></label></div></div><div class="modal-actions"><button type="button" class="cancel">Cancelar</button><button class="submit" type="submit">Restablecer contraseña <i data-lucide="check"></i></button></div></form>';
    document.body.append(dialog); q('#systemPasswordResetUser').textContent = `${user.name} · ${user.email}`;
    const close = () => dialog.close(); dialog.querySelectorAll('.close,.cancel').forEach(button => button.addEventListener('click', close));
    dialog.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const password = q('#systemPasswordResetValue').value, confirmation = q('#systemPasswordResetConfirm').value; if (password !== confirmation) return toast('La confirmación de la contraseña no coincide.'); try { await window.BioAuth?.setPassword(user.id, password); dialog.close(); toast(`Contraseña restablecida para ${user.name}.`); } catch (error) { toast(error.message || 'No fue posible restablecer la contraseña.'); } });
    dialog.showModal(); window.lucide?.createIcons(); q('#systemPasswordResetValue').focus();
  }

  document.addEventListener('click', event => {
    const viewLink = event.target.closest('[data-view]');
    if (viewLink && viewPermissions[viewLink.dataset.view] && (!access.can(viewPermissions[viewLink.dataset.view]) || (viewLink.dataset.view === 'sandboxView' && !access.isSandboxEnabled?.()))) {
      event.preventDefault(); event.stopImmediatePropagation(); toast('Este módulo está restringido para tu perfil.'); return;
    }
    const sectionButton = event.target.closest('[data-settings-section], [data-settings-target]');
    if (sectionButton) setSettingsSection(sectionButton.dataset.settingsSection || sectionButton.dataset.settingsTarget);
    for (const [selector, permission] of actionPermissions) {
      if (event.target.closest(selector) && !access.can(permission)) { event.preventDefault(); event.stopImmediatePropagation(); toast(`Tu perfil de ${access.role(access.currentUser()?.role)?.name || 'usuario'} no tiene permiso para esta acción.`); return; }
    }
  }, true);
  document.addEventListener('submit', event => {
    const permission = formPermissions[event.target.id];
    if (permission && !access.can(permission)) { event.preventDefault(); event.stopImmediatePropagation(); toast('Tu perfil no tiene permiso para guardar esta operación.'); }
  }, true);
  q('#newSystemUser').addEventListener('click', () => openUserDialog());
  q('#accessUserList').addEventListener('click', event => { const edit = event.target.closest('[data-edit-system-user]'), reset = event.target.closest('[data-reset-system-user]'); if (edit) openUserDialog(edit.dataset.editSystemUser); if (reset) openPasswordResetDialog(reset.dataset.resetSystemUser); });
  q('#accessPermissionMatrix').addEventListener('change', event => { const input = event.target.closest('[data-role-permission]'); if (!input) return; const role = input.dataset.rolePermission, selected = [...q('#accessPermissionMatrix').querySelectorAll(`[data-role-permission="${role}"]:checked`)].map(item => item.value), result = access.saveRolePermissions(role, selected); if (!result.ok) return toast(result.message); toast(`Plantilla de ${access.role(role).name} actualizada.`); });
  q('#accessCurrentUser').addEventListener('change', event => { if (access.setCurrentUser(event.target.value)) toast(`Sesión local cambiada a ${access.currentUser().name}.`); });
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
  q('#systemUserRole').addEventListener('change', () => renderUserPermissionEditor());
  q('#systemUserForm').addEventListener('submit', async event => { event.preventDefault(); const role = q('#systemUserRole').value, baseline = new Set(access.rolePermissions(role)), checked = new Set([...q('#systemUserPermissions').querySelectorAll('input:checked')].map(input => input.value)), permissionGrants = [...checked].filter(permission => !baseline.has(permission)), permissionDenials = [...baseline].filter(permission => !checked.has(permission)), email = q('#systemUserEmail').value.trim().toLowerCase(), password = q('#systemUserPassword').value; const result = access.saveUser({ id: q('#systemUserId').value || null, name: q('#systemUserName').value, email, role, status: q('#systemUserStatus').value, permissionGrants, permissionDenials }); if (!result.ok) return toast(result.message); const user = access.getState().users.find(item => item.email.toLowerCase() === email); try { if (password) { await window.BioPersistence?.flush(); await window.BioAuth?.setPassword(user?.id, password); } } catch (error) { return toast(error.message); } q('#systemUserDialog').close(); toast(password ? 'Usuario y contraseña creados.' : 'Usuario y permisos actualizados.'); });
  document.querySelectorAll('.access-dialog-close').forEach(button => button.addEventListener('click', () => q('#systemUserDialog').close()));
  window.addEventListener('bio:access-changed', () => { updateSidebarProfile(); applyNavigationAccess(); renderSettings(); setSettingsSection(activeSettingsSection); });
  updateSidebarProfile(); applyNavigationAccess(); renderSettings(); setSettingsSection(activeSettingsSection);
})();
