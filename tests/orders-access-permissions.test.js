const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('traduce los permisos históricos de pedidos a BioAccess', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'orders.js'), 'utf8');
  assert.match(source, /edit:\s*'client_order_manage'/);
  assert.match(source, /purchase:\s*'supplier_order_manage'/);
  assert.match(source, /inventory:\s*'inventory_manage'/);
  assert.match(source, /admin:\s*'user_manage'/);
  assert.match(source, /currentAccess\.can\(accessPermission\[permission\]\s*\|\|\s*permission\)/);
});
