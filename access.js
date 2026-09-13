(function (root) {
  'use strict';
  const STORAGE_KEY = 'nexo-access-v1';
  const PERMISSIONS = Object.freeze({
    dashboard_view: 'Consultar dashboard', inventory_view: 'Consultar inventario', inventory_manage: 'Gestionar inventario y conteos',
    catalog_view: 'Consultar productos', catalog_manage: 'Administrar productos', supplier_view: 'Consultar proveedores', supplier_manage: 'Administrar proveedores y precios',
    quotation_view: 'Consultar cotizaciones', quotation_manage: 'Crear y emitir cotizaciones', client_view: 'Consultar clientes', client_manage: 'Administrar clientes y crédito', client_order_view: 'Consultar OC de clientes', client_order_manage: 'Convertir cotizaciones en OC',
    client_order_activate: 'Activar OC de clientes', supplier_order_view: 'Consultar OC a proveedores', supplier_order_manage: 'Confirmar OC a proveedores',
    receive: 'Registrar recepciones', deliver: 'Registrar entregas y remisiones', invoice: 'Registrar facturación', cancel: 'Cancelar operaciones', reports: 'Consultar reportes',
    audit: 'Consultar auditoría', sandbox: 'Utilizar el área de pruebas', user_manage: 'Administrar usuarios y perfiles', system_config: 'Modificar configuración del sistema'
  });
  const ALL = Object.keys(PERMISSIONS);
  const ROLES = Object.freeze({
    administrator: { id: 'administrator', name: 'Administrador', description: 'Control total del sistema, seguridad, perfiles y operación.', permissions: ALL },
    auditor: { id: 'auditor', name: 'Auditor', description: 'Consulta la trazabilidad, documentos y bitácoras sin modificar la operación.', permissions: ['dashboard_view', 'audit', 'sandbox'] },
    supervisor: { id: 'supervisor', name: 'Supervisor', description: 'Supervisa y confirma la operación completa, sin administrar seguridad ni auditoría.', permissions: ALL.filter(permission => !['audit', 'user_manage', 'system_config'].includes(permission)) },
    seller: { id: 'seller', name: 'Vendedor', description: 'Consulta catálogos, administra sus clientes y sus cotizaciones, sin intervenir inventario o compras.', permissions: ['dashboard_view', 'catalog_view', 'quotation_view', 'quotation_manage', 'client_view', 'client_manage', 'client_order_view', 'client_order_manage', 'sandbox'] }
  });
  const defaults = () => ({
    version: 3,
    currentUserId: 'USR-001',
    users: [
      { id: 'USR-001', name: 'José Velasco', email: 'administracion@probiolab.mx', role: 'administrator', status: 'active', createdAt: new Date().toISOString() },
      { id: 'USR-002', name: 'Usuario Supervisor', email: 'supervision@probiolab.mx', role: 'supervisor', status: 'active', createdAt: new Date().toISOString() },
      { id: 'USR-003', name: 'Usuario Vendedor', email: 'ventas@probiolab.mx', role: 'seller', status: 'active', createdAt: new Date().toISOString() },
      { id: 'USR-004', name: 'Usuario Auditor', email: 'auditoria@probiolab.mx', role: 'auditor', status: 'active', createdAt: new Date().toISOString() }
    ],
    roleOverrides: {},
    workspace: { sandboxEnabled: true, modes: {} },
    audit: []
  });
  const load = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if ([1, 2, 3].includes(parsed?.version) && Array.isArray(parsed.users)) {
        if (!parsed.users.some(user => user.role === 'auditor')) {
          const next = Math.max(0, ...parsed.users.map(user => Number(String(user.id || '').match(/\d+/)?.[0]) || 0)) + 1;
          parsed.users.push({ id: `USR-${String(next).padStart(3, '0')}`, name: 'Usuario Auditor', email: 'auditoria@probiolab.mx', role: 'auditor', status: 'active', createdAt: new Date().toISOString() });
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }
        parsed.version = 3;
        parsed.roleOverrides = parsed.roleOverrides && typeof parsed.roleOverrides === 'object' ? parsed.roleOverrides : {};
        parsed.workspace = parsed.workspace && typeof parsed.workspace === 'object' ? parsed.workspace : {};
        parsed.workspace.sandboxEnabled = parsed.workspace.sandboxEnabled !== false;
        parsed.workspace.modes = parsed.workspace.modes && typeof parsed.workspace.modes === 'object' ? parsed.workspace.modes : {};
        parsed.users = parsed.users.map(user => ({ ...user, permissionGrants: Array.isArray(user.permissionGrants) ? user.permissionGrants.filter(permission => ALL.includes(permission)) : [], permissionDenials: Array.isArray(user.permissionDenials) ? user.permissionDenials.filter(permission => ALL.includes(permission)) : [] }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        return parsed;
      }
    } catch {}
    const state = defaults(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state;
  };
  let state = load();
  const persist = action => {
    if (action) state.audit.push({ id: `ACL-${Date.now()}`, at: new Date().toISOString(), actorId: state.currentUserId, ...action });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    root.dispatchEvent?.(new CustomEvent('bio:access-changed', { detail: { action: action?.type || 'updated' } }));
  };
  const currentUser = () => state.users.find(user => user.id === state.currentUserId && user.status === 'active') || state.users.find(user => user.status === 'active') || null;
  const rolePermissions = roleId => {
    if (!ROLES[roleId]) return [];
    const permissions = new Set(ROLES[roleId].permissions), overrides = state.roleOverrides?.[roleId] || {};
    (overrides.grants || []).filter(permission => ALL.includes(permission)).forEach(permission => permissions.add(permission));
    (overrides.denials || []).filter(permission => ALL.includes(permission)).forEach(permission => permissions.delete(permission));
    if (roleId === 'administrator') permissions.add('user_manage'); else permissions.delete('user_manage');
    return [...permissions];
  };
  const effectivePermissions = user => {
    if (!user || !ROLES[user.role]) return [];
    const permissions = new Set(rolePermissions(user.role));
    (user.permissionGrants || []).filter(permission => ALL.includes(permission)).forEach(permission => permissions.add(permission));
    (user.permissionDenials || []).filter(permission => ALL.includes(permission)).forEach(permission => permissions.delete(permission));
    if (user.role !== 'administrator') permissions.delete('user_manage');
    return [...permissions];
  };
  const can = (permission, user = currentUser()) => Boolean(user && effectivePermissions(user).includes(permission));
  const workspace = () => ({ sandboxEnabled: state.workspace?.sandboxEnabled !== false, mode: state.workspace?.modes?.[currentUser()?.id] === 'training' ? 'training' : 'operational' });
  const setWorkspaceMode = mode => {
    const user = currentUser(), requested = mode === 'training' ? 'training' : 'operational';
    if (!user) return { ok: false, message: 'No hay una sesión activa.' };
    if (requested === 'training' && (!(state.workspace?.sandboxEnabled !== false) || !can('sandbox', user))) return { ok: false, message: 'El área de pruebas no está habilitada para tu perfil.' };
    state.workspace = state.workspace || { sandboxEnabled: true, modes: {} }; state.workspace.modes = state.workspace.modes || {};
    const before = state.workspace.modes[user.id] === 'training' ? 'training' : 'operational';
    state.workspace.modes[user.id] = requested;
    persist({ type: 'workspace_mode_changed', entityId: user.id, before, after: requested });
    return { ok: true, mode: requested };
  };
  const setSandboxEnabled = enabled => {
    if (currentUser()?.role !== 'administrator' || !can('user_manage')) return { ok: false, message: 'Solo el administrador puede habilitar el área de pruebas.' };
    state.workspace = state.workspace || { sandboxEnabled: true, modes: {} }; state.workspace.modes = state.workspace.modes || {};
    const before = state.workspace.sandboxEnabled !== false; state.workspace.sandboxEnabled = Boolean(enabled);
    if (!state.workspace.sandboxEnabled) Object.keys(state.workspace.modes).forEach(userId => { state.workspace.modes[userId] = 'operational'; });
    persist({ type: 'workspace_training_changed', entityId: 'workspace', before, after: state.workspace.sandboxEnabled });
    return { ok: true, enabled: state.workspace.sandboxEnabled };
  };
  const setCurrentUser = userId => {
    if (root.BioAuth?.user?.()?.id && root.BioAuth.user().id !== userId) return false;
    const target = state.users.find(user => user.id === userId && user.status === 'active');
    if (!target) return false;
    const before = state.currentUserId; state.currentUserId = target.id; persist({ type: 'session_user_changed', before, after: target.id }); return true;
  };
  const saveUser = input => {
    if (currentUser()?.role !== 'administrator' || !can('user_manage')) return { ok: false, message: 'Solo un administrador puede administrar usuarios y permisos.' };
    const email = String(input.email || '').trim().toLowerCase(), name = String(input.name || '').trim(), role = input.role;
    if (!name || !email || !ROLES[role]) return { ok: false, message: 'Completa nombre, correo y perfil.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) return { ok: false, message: 'Captura un correo de acceso válido.' };
    if (state.users.some(user => user.email.toLowerCase() === email && user.id !== input.id)) return { ok: false, message: 'El correo ya está asignado a otro usuario.' };
    const existing = state.users.find(user => user.id === input.id), before = existing ? { ...existing } : null;
    if (existing?.id === state.currentUserId && input.status === 'inactive') return { ok: false, message: 'No puedes desactivar el usuario con la sesión actual.' };
    const activeAdministrators = state.users.filter(user => user.status === 'active' && user.role === 'administrator');
    if (existing?.role === 'administrator' && activeAdministrators.length === 1 && (role !== 'administrator' || input.status === 'inactive')) return { ok: false, message: 'Debe permanecer al menos un administrador activo.' };
    const permissionGrants = [...new Set((input.permissionGrants || []).filter(permission => ALL.includes(permission) && permission !== 'user_manage'))];
    const permissionDenials = [...new Set((input.permissionDenials || []).filter(permission => ALL.includes(permission) && permission !== 'user_manage'))];
    if (existing) Object.assign(existing, { name, email, role, status: input.status || 'active', permissionGrants, permissionDenials, updatedAt: new Date().toISOString() });
    else state.users.push({ id: `USR-${String(state.users.length + 1).padStart(3, '0')}`, name, email, role, status: input.status || 'active', permissionGrants, permissionDenials, createdAt: new Date().toISOString() });
    persist({ type: existing ? 'user_updated' : 'user_created', entityId: existing?.id || state.users.at(-1).id, before, after: existing ? { ...existing } : { ...state.users.at(-1) } });
    return { ok: true };
  };
  const saveRolePermissions = (roleId, selected = []) => {
    if (currentUser()?.role !== 'administrator' || !can('user_manage')) return { ok: false, message: 'Solo un administrador puede modificar perfiles.' };
    if (!ROLES[roleId]) return { ok: false, message: 'El perfil indicado no existe.' };
    const before = rolePermissions(roleId), baseline = new Set(ROLES[roleId].permissions), allowed = new Set(selected.filter(permission => ALL.includes(permission)));
    if (roleId === 'administrator') allowed.add('user_manage'); else allowed.delete('user_manage');
    state.roleOverrides[roleId] = { grants: [...allowed].filter(permission => !baseline.has(permission)), denials: [...baseline].filter(permission => !allowed.has(permission)) };
    persist({ type: 'role_permissions_updated', entityId: roleId, before, after: rolePermissions(roleId) });
    return { ok: true };
  };
  root.BioAccess = { PERMISSIONS, ROLES, getState: () => JSON.parse(JSON.stringify(state)), currentUser, rolePermissions, effectivePermissions, can, workspace, setWorkspaceMode, setSandboxEnabled, isSandboxEnabled: () => state.workspace?.sandboxEnabled !== false, setCurrentUser, saveUser, saveRolePermissions, role: id => ROLES[id] || null };
})(window);
