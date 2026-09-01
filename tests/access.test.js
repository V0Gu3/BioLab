const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAccess() {
  const values = new Map();
  const window = { dispatchEvent() {} };
  const context = { window, CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../access.js'), 'utf8'), context);
  return window.BioAccess;
}

test('genera los perfiles principales con permisos separados', () => {
  const access = loadAccess();
  assert.deepEqual(Object.keys(access.ROLES), ['administrator', 'auditor', 'supervisor', 'seller']);
  assert.equal(access.ROLES.administrator.permissions.includes('user_manage'), true);
  assert.equal(access.ROLES.supervisor.permissions.includes('supplier_order_manage'), true);
  assert.equal(access.ROLES.supervisor.permissions.includes('user_manage'), false);
  assert.equal(access.ROLES.supervisor.permissions.includes('audit'), false);
  assert.equal(access.ROLES.auditor.permissions.includes('audit'), true);
  assert.equal(access.ROLES.auditor.permissions.includes('inventory_manage'), false);
  assert.equal(access.ROLES.auditor.permissions.includes('sandbox'), true);
  assert.equal(access.ROLES.seller.permissions.includes('quotation_manage'), true);
  assert.equal(access.ROLES.seller.permissions.includes('inventory_manage'), false);
  assert.equal(access.ROLES.seller.permissions.includes('sandbox'), true);
  assert.equal(access.getState().users.length, 4);
});

test('solo el administrador gestiona usuarios y siempre queda uno activo', () => {
  const access = loadAccess();
  assert.equal(access.saveUser({ name: 'Vendedor Dos', email: 'ventas2@probiolab.mx', role: 'seller', status: 'active' }).ok, true);
  assert.equal(access.saveUser({ id: 'USR-001', name: 'José Velasco', email: 'administracion@probiolab.mx', role: 'supervisor', status: 'active' }).ok, false);
  access.setCurrentUser('USR-003');
  assert.equal(access.saveUser({ name: 'Sin permiso', email: 'x@probiolab.mx', role: 'seller', status: 'active' }).ok, false);
});

test('combina permisos predefinidos con excepciones auditables por usuario', () => {
  const access = loadAccess();
  assert.equal(access.saveUser({ name: 'Vendedor Especial', email: 'especial@probiolab.mx', role: 'seller', status: 'active', permissionGrants: ['inventory_manage', 'audit', 'user_manage'], permissionDenials: ['quotation_manage'] }).ok, true);
  const user = access.getState().users.find(item => item.email === 'especial@probiolab.mx');
  assert.equal(user.permissionGrants.join(','), 'inventory_manage,audit');
  assert.equal(user.permissionDenials.join(','), 'quotation_manage');
  access.setCurrentUser(user.id);
  assert.equal(access.can('inventory_manage'), true);
  assert.equal(access.can('audit'), true);
  assert.equal(access.can('quotation_manage'), false);
  assert.equal(access.can('user_manage'), false);
  assert.equal(access.effectivePermissions(access.currentUser()).includes('catalog_view'), true);
});

test('el administrador modifica la plantilla del perfil antes de aplicar excepciones individuales', () => {
  const access = loadAccess();
  const sellerTemplate = [...access.rolePermissions('seller'), 'inventory_view', 'user_manage'];
  assert.equal(access.saveRolePermissions('seller', sellerTemplate).ok, true);
  assert.equal(access.rolePermissions('seller').includes('inventory_view'), true);
  assert.equal(access.rolePermissions('seller').includes('user_manage'), false);
  access.setCurrentUser('USR-003');
  assert.equal(access.can('inventory_view'), true);
  assert.equal(access.can('user_manage'), false);
  assert.equal(access.getState().audit.some(item => item.type === 'role_permissions_updated' && item.entityId === 'seller'), true);
});
