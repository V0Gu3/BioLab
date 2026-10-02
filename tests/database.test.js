const test = require('node:test');
const assert = require('node:assert/strict');
const { importSnapshot, saveState, readState, listResource, listAudit, createInternalOrder, activateInternalOrder } = require('../server/db');
const { createTestDatabase } = require('./helpers/postgres');

const fixture = () => ({
  'nexo-access-v1': { version: 1, users: [{ id: 'USR-001', name: 'Administrador', email: 'admin@bio.local', role: 'administrator', status: 'active' }], audit: [{ id: 'ACL-1', type: 'user_created', at: '2026-08-30T10:00:00Z' }] },
  'nexo-products': [{ id: 1, number: '100001', sku: 'SKU-1', name: 'Reactivo', supplierId: 'PRV-1', unit: 'pieza', price: 120, currency: 'MXN', a1: 4, a2: 2 }],
  'nexo-suppliers': [{ id: 'PRV-1', code: 'PRV-1', name: 'Proveedor Uno' }],
  'nexo-product-supplier-relations': [{ id: 'PSR-1', productId: 1, supplierId: 'PRV-1', supplierSku: 'CAT-1', supplierDescription: 'Reactivo', purchaseUnit: 'pieza', purchasePrice: 100, currency: 'MXN', leadTimeDays: 3, minimumOrderQuantity: 1, active: true, preferred: true, createdBy: 'Administrador', createdAt: '2026-08-30T09:00:00Z', updatedBy: 'Administrador', updatedAt: '2026-08-30T09:00:00Z' }],
  'nexo-price-catalog-entries': [{ id: 'PLE-1', supplierId: 'PRV-1', linkedProductId: 1, supplierRelationId: 'PSR-1', code: 'CAT-1', description: 'Reactivo', unit: 'pieza', price: 100, currency: 'MXN', batchId: 'PRE-1', isCurrent: true }],
  'nexo-sales-quotations': [{ id: 'COT-260830-0001', client: 'Cliente Uno', status: 'Emitida', currency: 'MXN', total: 139.2, items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 1, unitPrice: 120, lineTotal: 120 }] }],
  'nexo-order-operations-v1': { version: 1, requisitions: [{ id: 'OC-260830-0001', quotationId: 'COT-260830-0001', customerName: 'Cliente Uno', status: 'confirmed' }], orderLines: [], supplierOrders: [], supplierOrderLines: [], supplierInvoices: [], receipts: [], inventoryMovements: [], customerInvoices: [], shipments: [], auditLog: [{ id: 'AUD-1', action: 'Pedido confirmado', entityType: 'requisition', entityId: 'OC-260830-0001', at: '2026-08-30T11:00:00Z' }] }
});

test('migra el estado local a PostgreSQL y materializa entidades', async () => {
  const db = await createTestDatabase();
  try {
    assert.equal((await importSnapshot(db, fixture())).imported, 7);
    assert.equal((await listResource(db, 'products')).length, 1);
    assert.equal((await listResource(db, 'quotations')).length, 1);
    assert.equal((await listResource(db, 'documents')).some(item => item.id === 'COT-260830-0001'), true);
    const audit = await listAudit(db);
    assert.equal(audit.filter(item => item.immutable).length, 7);
    assert.equal(audit.some(item => item.action === 'state_committed' && item.entity_id === 'nexo-products'), true);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM quotation_items')).rows[0].total), 1);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM product_supplier_relations')).rows[0].total), 1);
    assert.equal((await db.query('SELECT relation_id FROM price_catalog_entries WHERE id=$1', ['PLE-1'])).rows[0].relation_id, 'PSR-1');
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

test('protege relaciones operativas con llaves foráneas', async () => {
  const db = await createTestDatabase();
  try {
    await assert.rejects(
      db.query("INSERT INTO client_orders(id,client_id,payload_json,updated_at) VALUES('OC-HUERFANA','CLI-INEXISTENTE','{}',CURRENT_TIMESTAMP)"),
      /foreign key|referential/i
    );
  } finally { await db.end(); }
});

test('pedido interno conserva relaciones N:N y el origen de cada partida', async () => {
  const db = await createTestDatabase();
  try {
    const state = fixture();
    state['nexo-clients'] = [{ id: 'CLI-1', internalNumber: 'C-00001', name: 'Cliente Uno', ownerId: 'USR-001', ownerName: 'Administrador' }];
    state['nexo-sales-quotations'].push({ id: 'COT-260830-0002', clientId: 'CLI-1', client: 'Cliente Uno', status: 'expired', currency: 'MXN', paymentMethod: 'credit', creditDays: 30, paymentTerms: 'Crédito a 30 días.', pricePolicy: 'Precio sujeto a vigencia.', cancellationPolicy: 'No hay cancelación posterior a la aceptación.', items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 2, unitPrice: 120, currency: 'MXN' }] });
    await importSnapshot(db, state);
    const actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    const order = await createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-260830-0001', 'COT-260830-0002'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 3, unitPrice: 120, currency: 'MXN', sources: [{ quotationId: 'COT-260830-0001', quotationLineNo: 1 }, { quotationId: 'COT-260830-0002', quotationLineNo: 1 }] }] }, actor);
    assert.match(order.id, /^PI-\d{6}-\d{4}$/);
    assert.equal(order.clientNumber, 'C-00001');
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM internal_order_quotations WHERE internal_order_id=$1', [order.id])).rows[0].total), 2);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM internal_order_item_sources WHERE internal_order_id=$1', [order.id])).rows[0].total), 2);
    assert.equal(order.commercialTerms.find(term => term.quotationId === 'COT-260830-0002').creditDays, 30);
    assert.ok(order.commercialTerms.find(term => term.quotationId === 'COT-260830-0002').paymentDueDate);
    await activateInternalOrder(db, order.id, { acceptance: { reference: 'OC-CLIENTE-1' } }, actor);
    const activatedState = await readState(db), requiredQuotes = activatedState['nexo-sales-quotations'].filter(quotation => ['COT-260830-0001', 'COT-260830-0002'].includes(quotation.id));
    assert.ok(requiredQuotes.every(quotation => quotation.status === 'required' && quotation.locked === true && quotation.internalOrderId === order.id));
    await assert.rejects(createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-260830-0001'], items: [] }, actor), /no estar requeridas/i);
  } finally { await db.end(); }
});
