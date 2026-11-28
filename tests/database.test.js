const test = require('node:test');
const assert = require('node:assert/strict');
const { importSnapshot, saveState, readState, listResource, listAudit, listClientQuotations, createInternalOrder, activateInternalOrder } = require('../server/db');
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
    state['nexo-sales-quotations'].push({ id: 'COT-260830-0002', clientId: 'CLI-1', client: 'Cliente Uno', status: 'sent', expiresAtISO: '2099-08-31T23:59:59.000Z', currency: 'MXN', paymentMethod: 'credit', creditDays: 30, paymentTerms: 'Crédito a 30 días.', pricePolicy: 'Precio sujeto a vigencia.', cancellationPolicy: 'No hay cancelación posterior a la aceptación.', items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 2, unitPrice: 120, currency: 'MXN' }] });
    await importSnapshot(db, state);
    const actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    const order = await createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-260830-0001', 'COT-260830-0002'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 3, unitPrice: 120, currency: 'MXN', sources: [{ quotationId: 'COT-260830-0001', quotationLineNo: 1 }, { quotationId: 'COT-260830-0002', quotationLineNo: 1 }] }] }, actor);
    assert.match(order.id, /^PI-\d{6}-\d{4}$/);
    assert.equal(order.clientNumber, 'C-00001');
    assert.equal(order.subtotal, 360);
    assert.equal(order.taxRate, 16);
    assert.equal(order.taxAmount, 57.6);
    assert.equal(order.total, 417.6);
    assert.deepEqual(order.totalsByCurrency, [{ currency: 'MXN', subtotal: 360, discountTotal: 0, taxable: 360, taxAmount: 57.6, total: 417.6 }]);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM internal_order_quotations WHERE internal_order_id=$1', [order.id])).rows[0].total), 2);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM internal_order_item_sources WHERE internal_order_id=$1', [order.id])).rows[0].total), 2);
    assert.equal(order.commercialTerms.find(term => term.quotationId === 'COT-260830-0002').creditDays, 30);
    assert.ok(order.commercialTerms.find(term => term.quotationId === 'COT-260830-0002').paymentDueDate);
    const convertedState = await readState(db), convertedQuotes = convertedState['nexo-sales-quotations'].filter(quotation => ['COT-260830-0001', 'COT-260830-0002'].includes(quotation.id));
    assert.ok(convertedQuotes.every(quotation => quotation.commercialOrderId === order.id && quotation.internalOrderId === order.id));
    assert.deepEqual(await listClientQuotations(db, 'CLI-1', actor), []);
    const activated = await activateInternalOrder(db, order.id, { acceptance: { reference: 'OC-CLIENTE-1' } }, actor);
    assert.equal(activated.activatedSnapshot.totalsByCurrency[0].total, 417.6);
    const activatedState = await readState(db), requiredQuotes = activatedState['nexo-sales-quotations'].filter(quotation => ['COT-260830-0001', 'COT-260830-0002'].includes(quotation.id));
    assert.ok(requiredQuotes.every(quotation => quotation.status === 'required' && quotation.locked === true && quotation.internalOrderId === order.id));
    await assert.rejects(createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-260830-0001'], items: [] }, actor), /ya (?:está requerida|fue convertida)/i);
  } finally { await db.end(); }
});

test('una cantidad distinta a la cotizada exige confirmación y conserva evidencia', async () => {
  const db = await createTestDatabase();
  try {
    const state = fixture(), actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    state['nexo-clients'] = [{ id: 'CLI-1', internalNumber: 'C-00001', name: 'Cliente Uno', ownerId: 'USR-001', ownerName: 'Administrador' }];
    state['nexo-sales-quotations'][0] = { ...state['nexo-sales-quotations'][0], clientId: 'CLI-1', expiresAtISO: '2099-08-31T23:59:59.000Z' };
    await importSnapshot(db, state);
    const input = { clientId: 'CLI-1', quotationIds: ['COT-260830-0001'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 2, unitPrice: 120, currency: 'MXN', sources: [{ quotationId: 'COT-260830-0001', quotationLineNo: 1 }] }] };
    await assert.rejects(createInternalOrder(db, input, actor), /Confirma la diferencia/);
    const order = await createInternalOrder(db, { ...input, quantityVarianceAcknowledgement: { confirmed: true, confirmedAt: '2026-11-10T09:00:00.000Z', confirmedBy: actor.name } }, actor);
    assert.equal(order.quantityVarianceAcknowledgement.variances[0].quotedQuantity, 1);
    assert.equal(order.quantityVarianceAcknowledgement.variances[0].requestedQuantity, 2);
    assert.ok(order.timeline.some(event => event.status === 'quantity_variance_confirmed'));
  } finally { await db.end(); }
});

test('pedido interno conserva IVA cero, precio a centavos y descuento monetario de la cotización', async () => {
  const db = await createTestDatabase();
  try {
    const state = fixture(), actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    state['nexo-clients'] = [{ id: 'CLI-CAD', internalNumber: 'C-00002', name: 'Cliente CAD', ownerId: 'USR-001', ownerName: 'Administrador' }];
    state['nexo-sales-quotations'] = [{ id: 'COT-261027-0002', clientId: 'CLI-CAD', client: 'Cliente CAD', status: 'sent', expiresAtISO: '2099-12-31T23:59:59.000Z', currency: 'CAD', taxRate: 0, subtotal: 501.74, discountTotal: 10, taxable: 491.74, taxAmount: 0, total: 491.74, totalsByCurrency: [{ currency: 'CAD', subtotal: 501.74, discountTotal: 10, taxable: 491.74, taxAmount: 0, total: 491.74 }], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 1, unitPrice: 501.739, discountTotal: 10, currency: 'CAD' }] }];
    await importSnapshot(db, state);
    const order = await createInternalOrder(db, { clientId: 'CLI-CAD', quotationIds: ['COT-261027-0002'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 1, unitPrice: 501.739, currency: 'CAD', sources: [{ quotationId: 'COT-261027-0002', quotationLineNo: 1 }] }] }, actor);
    assert.equal(order.items[0].unitPrice, 501.74);
    assert.equal(order.taxRate, 0);
    assert.equal(order.subtotal, 501.74);
    assert.equal(order.discountTotal, 10);
    assert.equal(order.taxAmount, 0);
    assert.equal(order.total, 491.74);
  } finally { await db.end(); }
});

test('una cotización nueva sin clientId puede convertirse y una asociación explícita incorrecta se rechaza', async () => {
  const db = await createTestDatabase();
  try {
    const state = fixture(), actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    state['nexo-clients'] = [
      { id: 'CLI-ANTERIOR', internalNumber: 'C-00005', name: 'QA Cliente C6', ownerId: 'USR-001', ownerName: 'Administrador' },
      { id: 'CLI-C6', internalNumber: 'C-00006', name: 'QA Cliente C6', ownerId: 'USR-001', ownerName: 'Administrador' }
    ];
    const base = { client: 'QA Cliente C6', status: 'sent', expiresAtISO: '2099-12-31T23:59:59.000Z', currency: 'MXN', taxRate: 16, items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 1, unitPrice: 100, discount: 10, currency: 'MXN' }] };
    state['nexo-sales-quotations'] = [{ ...base, id: 'COT-261110-0001' }, { ...base, id: 'COT-ASOCIADA-A-OTRO', clientId: 'CLI-ANTERIOR' }];
    await importSnapshot(db, state);
    assert.deepEqual((await listClientQuotations(db, 'CLI-C6', actor)).map(quote => quote.id), ['COT-261110-0001']);
    const order = await createInternalOrder(db, { clientId: 'CLI-C6', quotationIds: ['COT-261110-0001'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 1, unitPrice: 100, discount: 10, currency: 'MXN', sources: [{ quotationId: 'COT-261110-0001', quotationLineNo: 1 }] }] }, actor);
    assert.equal(order.clientId, 'CLI-C6');
    assert.equal(order.total, 104.4);
    await assert.rejects(createInternalOrder(db, { clientId: 'CLI-C6', quotationIds: ['COT-ASOCIADA-A-OTRO'], items: [{ productId: 1, quantity: 1, unitPrice: 100, currency: 'MXN', sources: [{ quotationId: 'COT-ASOCIADA-A-OTRO', quotationLineNo: 1 }] }] }, actor), /no pertenece al cliente seleccionado/i);
  } finally { await db.end(); }
});

test('una cotización vencida no se ofrece ni permite crear o activar un pedido interno', async () => {
  const db = await createTestDatabase();
  try {
    const state = fixture(), actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    state['nexo-clients'] = [{ id: 'CLI-1', internalNumber: 'C-00001', name: 'Cliente Uno', ownerId: 'USR-001', ownerName: 'Administrador' }];
    state['nexo-sales-quotations'][0] = { ...state['nexo-sales-quotations'][0], clientId: 'CLI-1', expiresAtISO: '2099-08-31T23:59:59.000Z' };
    state['nexo-sales-quotations'].push({ ...state['nexo-sales-quotations'][0], id: 'COT-VENCIDA', status: 'sent', expiresAtISO: '2025-01-01T23:59:59.000Z' });
    await importSnapshot(db, state);
    assert.deepEqual((await listClientQuotations(db, 'CLI-1', actor)).map(quote => quote.id), ['COT-260830-0001']);
    const item = { productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 1, unitPrice: 120, currency: 'MXN' };
    await assert.rejects(createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-VENCIDA'], items: [{ ...item, sources: [{ quotationId: 'COT-VENCIDA', quotationLineNo: 1 }] }] }, actor), /cotización vencida/i);
    const order = await createInternalOrder(db, { clientId: 'CLI-1', quotationIds: ['COT-260830-0001'], items: [{ ...item, sources: [{ quotationId: 'COT-260830-0001', quotationLineNo: 1 }] }] }, actor);
    const current = await readState(db); current['nexo-sales-quotations'][0].expiresAtISO = '2025-01-01T23:59:59.000Z';
    await saveState(db, 'nexo-sales-quotations', current['nexo-sales-quotations'], actor.name, actor.id);
    await assert.rejects(activateInternalOrder(db, order.id, { acceptance: { reference: 'OC-CLIENTE-VENCIDA' } }, actor), /ya venció/i);
  } finally { await db.end(); }
});

test('dos cotizaciones en monedas distintas y una partida manual conservan importes al activar en Pruebas', async () => {
  const db = await createTestDatabase();
  try {
    const actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    const state = fixture();
    state['nexo-clients'] = [{ id: 'CLI-MULTI', name: 'QA Multimoneda' }];
    state['nexo-sales-quotations'] = [
      { id: 'COT-QA-MXN', clientId: 'CLI-MULTI', client: 'QA Multimoneda', status: 'sent', taxRate: 16, currency: 'MXN', expiresAtISO: '2099-12-31', items: [{ productId: 1, quantity: 2, unitPrice: 100, discount: 10, currency: 'MXN' }] },
      { id: 'COT-QA-USD', clientId: 'CLI-MULTI', client: 'QA Multimoneda', status: 'sent', taxRate: 0, currency: 'USD', expiresAtISO: '2099-12-31', items: [{ productId: 1, quantity: 1, unitPrice: 84.27, currency: 'USD' }] }
    ];
    for (const [key, value] of Object.entries(state)) if (key !== 'nexo-access-v1') await saveState(db, key, value, actor.name, actor.id, 'training');
    const items = [
      { productId: 1, quantity: 2, unitPrice: 100, currency: 'MXN', sources: [{ quotationId: 'COT-QA-MXN', quotationLineNo: 1 }] },
      { productId: 1, quantity: 1, unitPrice: 84.27, currency: 'USD', sources: [{ quotationId: 'COT-QA-USD', quotationLineNo: 1 }] },
      { productId: 1, name: 'Partida manual QA', quantity: 1, unitPrice: 25, currency: 'MXN', sourceType: 'manual', sources: [{ sourceType: 'manual', quotationId: null, quotationLineNo: null }] }
    ];
    const order = await createInternalOrder(db, { clientId: 'CLI-MULTI', quotationIds: ['COT-QA-MXN', 'COT-QA-USD'], items }, actor, 'training');
    assert.equal(order.currency, 'MULTI');
    assert.equal(order.totalsByCurrency.find(row => row.currency === 'MXN').total, 237.8);
    assert.equal(order.totalsByCurrency.find(row => row.currency === 'USD').total, 84.27);
    assert.equal(order.items[2].sourceType, 'manual');
    const active = await activateInternalOrder(db, order.id, { acceptance: { reference: 'QA-MULTI-ACEPT' } }, actor, 'training');
    assert.deepEqual(active.totalsByCurrency, order.totalsByCurrency);
    assert.equal(active.status, 'active');
    assert.equal((await readState(db, 'training'))['nexo-sales-quotations'].filter(q => q.locked).length, 2);
    assert.equal((await readState(db))['nexo-commercial-orders'], undefined);
  } finally { await db.end(); }
});

test('pedidos internos de capacitación se guardan aislados y no materializan la operación', async () => {
  const db = await createTestDatabase();
  try {
    const training = fixture();
    training['nexo-clients'] = [{ id: 'CLI-TRAIN', internalNumber: 'C-T0001', name: 'Cliente capacitación', ownerId: 'USR-001', ownerName: 'Administrador' }];
    training['nexo-sales-quotations'] = [{ id: 'COT-TRAIN-1', clientId: 'CLI-TRAIN', client: 'Cliente capacitación', status: 'sent', currency: 'MXN', items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', quantity: 1, unitPrice: 120, currency: 'MXN' }] }];
    for (const [key, value] of Object.entries(training)) if (key !== 'nexo-access-v1') await saveState(db, key, value, 'Administrador', 'USR-001', 'training');
    const actor = { id: 'USR-001', name: 'Administrador', role: 'administrator' };
    const order = await createInternalOrder(db, { clientId: 'CLI-TRAIN', quotationIds: ['COT-TRAIN-1'], items: [{ productId: 1, sku: 'SKU-1', name: 'Reactivo', unit: 'pieza', quantity: 1, unitPrice: 120, currency: 'MXN', sources: [{ quotationId: 'COT-TRAIN-1', quotationLineNo: 1 }] }] }, actor, 'training');
    await activateInternalOrder(db, order.id, { acceptance: { reference: 'OC-CAPACITACION-1' } }, actor, 'training');
    const trainingState = await readState(db, 'training'), operationalState = await readState(db);
    assert.equal(trainingState['nexo-commercial-orders'][0].status, 'active');
    assert.equal(trainingState['nexo-sales-quotations'][0].status, 'required');
    assert.equal((operationalState['nexo-commercial-orders'] || []).length, 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) total FROM client_orders')).rows[0].total), 0);
  } finally { await db.end(); }
});
