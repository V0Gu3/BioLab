const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAudit(seed, allowed = true) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  const window = { localStorage: { getItem: key => values.get(key) ?? null }, BioAccess: { can: permission => permission === 'audit' && allowed }, addEventListener() {} };
  const context = { window, URL, Blob, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../audit.js'), 'utf8'), context);
  return window.BioAudit;
}

test('consolida documentos, movimientos, operación, divisas y accesos', () => {
  const audit = loadAudit({
    'nexo-order-operations-v1': { auditLog: [{ id: 'AUD-1', action: 'Pedido confirmado', at: '2026-08-30T10:00:00Z' }], inventoryMovements: [{ id: 'INV-1', type: 'entry', quantity: 2, at: '2026-08-30T11:00:00Z' }], supplierOrders: [{ id: 'OCP-1', createdAt: '2026-08-30' }], supplierInvoices: [], receipts: [], customerInvoices: [], shipments: [{ id: 'REM-1', date: '2026-08-30' }] },
    'nexo-sales-quotations': [{ id: 'COT-1', createdAtISO: '2026-08-30T09:00:00Z' }],
    'nexo-commercial-orders': [{ id: 'OC-1', createdAtISO: '2026-08-30T09:30:00Z' }],
    'nexo-fx-v1': { audit: [{ id: 'FXA-1', event: 'rates_updated', at: '2026-08-30T07:00:00Z' }] },
    'nexo-access-v1': { audit: [{ id: 'ACL-1', type: 'user_updated', at: '2026-08-30T08:00:00Z' }] }
  });
  const rows = audit.collect();
  assert.deepEqual([...new Set(rows.map(row => row.category))].sort(), ['access', 'currency', 'document', 'movement', 'operation']);
  assert.equal(rows.some(row => row.id === 'OCP-1' && row.downloadKind === 'supplier_order'), true);
  assert.equal(rows.some(row => row.id === 'REM-1' && row.downloadKind === 'remision'), true);
});

test('la API conserva la comprobación del permiso de auditoría', () => {
  const audit = loadAudit({}, false);
  assert.equal(typeof audit.collect, 'function');
  assert.equal(typeof audit.render, 'function');
  assert.match(fs.readFileSync(require.resolve('../audit.js'), 'utf8'), /BioAccess\?\.can\('audit'\)/);
});
