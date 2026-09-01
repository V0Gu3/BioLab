const test = require('node:test');
const assert = require('node:assert/strict');
const { importSnapshot, saveState, readState, listResource, listAudit } = require('../server/db');
const { createTestDatabase } = require('./helpers/postgres');

const fixture = () => ({
  'nexo-access-v1': { version: 1, users: [{ id: 'USR-001', name: 'Administrador', email: 'admin@bio.local', role: 'administrator', status: 'active' }], audit: [{ id: 'ACL-1', type: 'user_created', at: '2026-08-30T10:00:00Z' }] },
  'nexo-products': [{ id: 1, number: '100001', sku: 'SKU-1', name: 'Reactivo', supplierId: 'PRV-1', unit: 'pieza', price: 120, currency: 'MXN', a1: 4, a2: 2 }],
  'nexo-suppliers': [{ id: 'PRV-1', code: 'PRV-1', name: 'Proveedor Uno' }],
  'nexo-sales-quotations': [{ id: 'COT-260830-0001', client: 'Cliente Uno', status: 'Emitida', currency: 'MXN', total: 139.2, items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 1, unitPrice: 120, lineTotal: 120 }] }],
  'nexo-order-operations-v1': { version: 1, requisitions: [{ id: 'OC-260830-0001', quotationId: 'COT-260830-0001', customerName: 'Cliente Uno', status: 'confirmed' }], orderLines: [], supplierOrders: [], supplierOrderLines: [], supplierInvoices: [], receipts: [], inventoryMovements: [], customerInvoices: [], shipments: [], auditLog: [{ id: 'AUD-1', action: 'Pedido confirmado', entityType: 'requisition', entityId: 'OC-260830-0001', at: '2026-08-30T11:00:00Z' }] }
});

test('migra el estado local a PostgreSQL y materializa entidades', async () => {
  const db = await createTestDatabase();
  try {
    assert.equal((await importSnapshot(db, fixture())).imported, 5);
    assert.equal((await listResource(db, 'products')).length, 1);
    assert.equal((await listResource(db, 'quotations')).length, 1);
    assert.equal((await listResource(db, 'documents')).some(item => item.id === 'COT-260830-0001'), true);
    assert.equal((await listAudit(db)).length, 2);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM quotation_items')).rows[0].total), 1);
  } finally { await db.end(); }
});

test('actualiza revisiones transaccionales en PostgreSQL', async () => {
  const db = await createTestDatabase();
  try {
    const first = await saveState(db, 'nexo-products', fixture()['nexo-products'], 'Administrador');
    const second = await saveState(db, 'nexo-products', [{ ...fixture()['nexo-products'][0], price: 150 }], 'Supervisor');
    assert.equal(first.revision, 1); assert.equal(second.revision, 2);
    assert.equal((await readState(db))['nexo-products'][0].price, 150);
    assert.equal(Number((await db.query('SELECT price FROM products WHERE id=$1', ['1'])).rows[0].price), 150);
  } finally { await db.end(); }
});
