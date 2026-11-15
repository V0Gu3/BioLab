const assert = require('node:assert/strict');
const core = require('../orders-core.js');

const row = overrides => {
  const values = Array(26).fill(null);
  Object.entries({
    0: 46028, 1: '1001', 2: 46029, 3: 'FP-100', 4: 46030, 5: 1160,
    6: null, 7: 'PROVEEDOR UNO', 8: 'MARCA UNO', 9: 'CAT-001', 10: 'Producto de prueba',
    11: 2, 12: 100, 13: 200, 14: 32, 15: 232, 16: 'REQ-001', 17: 'Contacto Uno',
    18: 'Institución Uno', 19: null, 20: null, 21: null, 22: null,
  }).forEach(([index, value]) => { values[Number(index)] = value; });
  Object.entries(overrides || {}).forEach(([index, value]) => { values[Number(index)] = value; });
  return values;
};

const simulate = (rows, options = {}) => core.simulateImport({ rows, fileHash: options.fileHash || 'FILE-A', exchangeRateMap: options.exchangeRateMap || {}, existingSourceHashes: options.existingSourceHashes || [] });

function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}`); throw error; }
}

test('calcula subtotal, IVA configurable y total', () => {
  assert.deepEqual(core.calculateLineTotals({ quantity: 3, unitPrice: 100, taxRate: 8 }), { subtotal: 300, discountTotal: 0, taxable: 300, taxAmount: 24, total: 324 });
});

test('redondea el precio unitario y aplica descuento antes del IVA', () => {
  assert.deepEqual(core.calculateLineTotals({ quantity: 2, unitPrice: 667.484, discountAmount: 100, taxRate: 16 }), { subtotal: 1334.96, discountTotal: 100, taxable: 1234.96, taxAmount: 197.59, total: 1432.55 });
});

test('agrupa una requisición con una y varias partidas', () => {
  const simulation = simulate([row(), row({ 9: 'CAT-002', 10: 'Segundo producto' })]);
  const { store } = core.materializeImport(core.createEmptyStore(), simulation, 'Tester');
  assert.equal(store.requisitions.length, 1);
  assert.equal(store.orderLines.length, 2);
  assert.equal(store.orderLines.every(line => line.requisitionId === 'REQ-001'), true);
});

test('clasifica STOCK como abastecimiento interno, no como cliente', () => {
  const simulation = simulate([row({ 6: 46031, 16: 'STOCK', 17: 'STOCK', 18: 'STOCK', 19: 'STOCK' })]);
  const { store } = core.materializeImport(core.createEmptyStore(), simulation, 'Tester');
  assert.equal(store.requisitions[0].type, 'internal_stock');
  assert.equal(store.requisitions[0].customerName, null);
  assert.equal(store.inventoryMovements.length, 1);
  assert.equal(store.inventoryMovements[0].type, 'entry');
});

test('clasifica DEPÓSITO como modalidad y no como proveedor', () => {
  const simulation = simulate([row({ 1: 'DEPOSITO', 3: 'DEPOSITO', 7: 'DEPOSITO' })]);
  const imported = simulation.rows[0].record;
  assert.equal(imported.purchaseMode, 'deposit');
  assert.equal(imported.supplier, null);
  assert.equal(imported.purchaseOrderFolio, null);
});

test('permite varias órdenes de proveedor para una requisición', () => {
  const simulation = simulate([row({ 1: 'OC-01' }), row({ 1: 'OC-02', 9: 'CAT-002' })]);
  const { store } = core.materializeImport(core.createEmptyStore(), simulation, 'Tester');
  assert.deepEqual(store.supplierOrders.map(order => order.id).sort(), ['OC-01', 'OC-02']);
  assert.equal(store.supplierOrders.every(order => order.requisitionIds.includes('REQ-001')), true);
});

test('distingue recepción parcial y total', () => {
  const line = { quantityRequested: 10, quantityPurchased: 10, quantityReceived: 4, quantityDelivered: 0, quantityCancelled: 0, quantityInvoiced: 0, supplyOrigin: 'supplier' };
  assert.equal(core.deriveLineStatus(line), 'partially_received');
  line.quantityReceived = 10;
  assert.equal(core.deriveLineStatus(line), 'ready_to_deliver');
});

test('una requisición con partidas mezcladas queda parcialmente comprada', () => {
  const lines = [
    { quantityRequested: 5, quantityPurchased: 5, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, quantityInvoiced: 0, supplyOrigin: 'supplier' },
    { quantityRequested: 5, quantityPurchased: 0, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, quantityInvoiced: 0, supplyOrigin: 'supplier' },
  ];
  assert.equal(core.deriveRequisitionStatus(lines), 'partially_purchased');
});

test('distingue entrega parcial y total', () => {
  const line = { quantityRequested: 10, quantityPurchased: 10, quantityReceived: 10, quantityDelivered: 3, quantityCancelled: 0, quantityInvoiced: 0, supplyOrigin: 'supplier' };
  assert.equal(core.deriveLineStatus(line), 'partially_delivered');
  line.quantityDelivered = 10;
  assert.equal(core.deriveLineStatus(line), 'delivered');
});

test('distingue cancelación parcial y total', () => {
  const line = { quantityRequested: 10, quantityPurchased: 0, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 2, quantityInvoiced: 0, supplyOrigin: 'supplier' };
  assert.notEqual(core.deriveLineStatus(line), 'cancelled');
  line.quantityCancelled = 10;
  assert.equal(core.deriveLineStatus(line), 'cancelled');
});

test('conserva factura USD, tipo de cambio histórico, fecha y total MXN', () => {
  const simulation = simulate([row({ 1: '1402', 5: '241.08 USD' })], { exchangeRateMap: { '1402': { rate: 19.4, date: '2025-05-29' } } });
  const { store } = core.materializeImport(core.createEmptyStore(), simulation, 'Tester');
  const invoice = store.supplierInvoices[0];
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.exchangeRate, 19.4);
  assert.equal(invoice.exchangeRateDate, '2025-05-29');
  assert.equal(invoice.totalMXN, 4676.95);
});

test('separa facturación normal y cargo a manejo de cuenta', () => {
  assert.deepEqual(core.classifyBilling('F-722').type, 'standard');
  const charge = core.classifyBilling('CARGAR AL MC-29');
  assert.equal(charge.type, 'account_charge');
  assert.equal(charge.accountReference, 'MC-29');
});

test('impide exceder cantidades sin permiso especial', () => {
  assert.equal(core.validateProgress({ authorized: 10, current: 8, amount: 3 }).code, 'EXCEEDS_AUTHORIZED');
  assert.equal(core.validateProgress({ authorized: 10, current: 8, amount: 3, allowOverride: true }).overridden, true);
});

test('exige una OC de cliente activa antes de generar la OC al proveedor', () => {
  assert.equal(core.validateSupplierPurchaseGate({ requestType: 'customer_order', clientOrderStatus: 'pending' }).code, 'CLIENT_ORDER_NOT_ACTIVE');
  assert.equal(core.validateSupplierPurchaseGate({ requestType: 'customer_order', clientOrderStatus: 'active' }).valid, true);
  assert.equal(core.validateSupplierPurchaseGate({ requestType: 'internal_stock', clientOrderStatus: null }).valid, true);
});

test('agrupa artículos de una OC de cliente por proveedor y moneda', () => {
  const lines = [
    { id: 'L1', productId: 1, catalog: 'A-1' },
    { id: 'L2', productId: 2, catalog: 'B-1' },
    { id: 'L3', productId: 3, catalog: 'C-1' },
    { id: 'L4', productId: 4, catalog: 'SIN-PROVEEDOR' },
  ];
  const products = [
    { id: 1, supplierId: 'S1', priceCurrency: 'MXN' },
    { id: 2, supplierId: 'S2', priceCurrency: 'USD' },
    { id: 3, supplierId: 'S1', priceCurrency: 'MXN' },
    { id: 4, supplierId: null, priceCurrency: 'MXN' },
  ];
  const suppliers = [{ id: 'S1', name: 'Proveedor Uno' }, { id: 'S2', name: 'Proveedor Dos' }];
  const result = core.groupSupplierPurchaseLines({ lines, products, suppliers });
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(group => group.rows.length).sort(), [1, 2]);
  assert.equal(result.missing.length, 1);
  assert.equal(result.groups.find(group => group.supplier.id === 'S2').currency, 'USD');
});

test('reserva 5 piezas disponibles y manda a compra solo 10 de una solicitud de 15', () => {
  const plan = core.planMixedFulfillment({ requested: 15, available: 5, alreadyReserved: 0 });
  assert.equal(plan.reservedQuantity, 5);
  assert.equal(plan.quantityToPurchase, 10);
  assert.equal(plan.supplyOrigin, 'mixed');
});

test('distribuye la reserva entre almacenes sin comprometer existencias ya reservadas', () => {
  const plan = core.planWarehouseFulfillment({ requested: 15, warehouses: { 1: 3, 2: 7 }, reservedByWarehouse: { 2: 5 }, preferredWarehouse: '2' });
  assert.deepEqual(plan.allocations, [
    { warehouseId: '2', quantity: 2, freeStock: 2 },
    { warehouseId: '1', quantity: 3, freeStock: 3 },
  ]);
  assert.equal(plan.reservedQuantity, 5);
  assert.equal(plan.quantityToPurchase, 10);
  assert.equal(plan.supplyOrigin, 'mixed');
});

test('una recepción comprometida para otro pedido no queda libre para una reserva nueva', () => {
  const plan = core.reconcileWarehouseReservations({ available: 1, committed: 1, reservations: [{ id: 'RES-PI-NUEVO', quantity: 1, quantityConsumed: 0, at: '2026-11-10T09:00:00Z' }] });
  assert.equal(plan.releasedQuantity, 1);
  assert.deepEqual(plan.allocations, [{ id: 'RES-PI-NUEVO', previous: 1, kept: 0, released: 1 }]);
  const afterEarlierDelivery = core.reconcileWarehouseReservations({ available: 0, committed: 0, reservations: [{ id: 'RES-PI-NUEVO', quantity: 1, quantityConsumed: 0, at: '2026-11-10T09:00:00Z' }] });
  assert.equal(afterEarlierDelivery.releasedQuantity, 1);
});

test('si dos pedidos compiten por stock libre se conserva la reserva más antigua', () => {
  const plan = core.reconcileWarehouseReservations({ available: 1, committed: 0, reservations: [{ id: 'RES-NUEVA', quantity: 1, at: '2026-11-10T10:00:00Z' }, { id: 'RES-ANTIGUA', quantity: 1, at: '2026-11-10T08:00:00Z' }] });
  assert.deepEqual(plan.allocations.map(item => [item.id, item.kept, item.released]), [['RES-ANTIGUA', 1, 0], ['RES-NUEVA', 0, 1]]);
});

test('el surtido mixto queda comprado cuando se cubre únicamente el faltante', () => {
  const line = { quantityRequested: 15, quantityCancelled: 0, reservedQuantity: 5, quantityPurchased: 10, quantityReceived: 0, quantityDelivered: 0, quantityInvoiced: 0, supplyOrigin: 'mixed' };
  assert.equal(core.deriveLineStatus(line), 'purchased');
  assert.equal(core.deriveRequisitionStatus([line]), 'purchased');
});

test('consolida necesidades compatibles sin perder su pedido de origen', () => {
  const lines = [
    { id: 'L1', requisitionId: 'PED-201', productId: 1, deliveryWarehouse: '2', committedDate: '2026-09-15', purchasePaymentTerms: '30 días' },
    { id: 'L2', requisitionId: 'PED-205', productId: 1, deliveryWarehouse: '2', committedDate: '2026-09-15', purchasePaymentTerms: '30 días' },
    { id: 'L3', requisitionId: 'STOCK', productId: 1, deliveryWarehouse: '1', committedDate: '2026-09-15', purchasePaymentTerms: '30 días' },
  ];
  const products = [{ id: 1, supplierId: 'S1', priceCurrency: 'USD' }], suppliers = [{ id: 'S1', name: 'Proveedor Uno' }];
  const result = core.groupSupplierPurchaseLines({ lines, products, suppliers });
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups.find(group => group.warehouse === '2').rows.length, 2);
  assert.deepEqual(result.groups.find(group => group.warehouse === '2').rows.map(row => row.line.requisitionId), ['PED-201', 'PED-205']);
});

test('concilia OC, recepción y factura sin exigir factura para recibir', () => {
  const order = { id: 'OCP-105' }, links = [{ supplierOrderId: 'OCP-105', orderLineId: 'L1', quantity: 10, unitPrice: 100 }];
  const pendingInvoice = core.reconcileSupplierPurchase({ order, links, receipts: [{ id: 'REC-1', supplierOrderId: 'OCP-105', items: [{ orderLineId: 'L1', quantity: 10, quantityRejected: 0 }] }], invoices: [] });
  assert.equal(pendingInvoice.quantityStatus, 'matched');
  assert.equal(pendingInvoice.invoiceStatus, 'pending_invoice');
  assert.equal(pendingInvoice.status, 'pending');
  const matched = core.reconcileSupplierPurchase({ order, links, receipts: [{ id: 'REC-1', supplierOrderId: 'OCP-105', items: [{ orderLineId: 'L1', quantity: 10, quantityRejected: 0 }] }], invoices: [{ id: 'FAC-1', supplierOrderIds: ['OCP-105'], amountOriginal: 1000 }] });
  assert.equal(matched.status, 'matched');
  const mismatch = core.reconcileSupplierPurchase({ order, links, receipts: [{ id: 'REC-1', supplierOrderId: 'OCP-105', items: [{ orderLineId: 'L1', quantity: 11, quantityRejected: 0 }] }], invoices: [{ id: 'FAC-1', supplierOrderIds: ['OCP-105'], amountOriginal: 1100 }] });
  assert.equal(mismatch.status, 'review');
});

test('calcula el pendiente de recepción por OC aunque una partida esté dividida entre proveedores', () => {
  const linkA = { supplierOrderId: 'OCP-A', orderLineId: 'L1', quantity: 2 };
  const linkB = { supplierOrderId: 'OCP-B', orderLineId: 'L1', quantity: 3 };
  const receipts = [
    { supplierOrderId: 'OCP-A', items: [{ orderLineId: 'L1', quantityAccepted: 2 }] },
    { supplierOrderId: 'OCP-B', items: [{ orderLineId: 'L1', quantityAccepted: 1 }] },
    { supplierOrderId: 'OCP-B', items: [{ orderLineId: 'L1', quantityAccepted: 0 }] },
  ];
  assert.equal(core.supplierOrderLinePending({ supplierOrderId: 'OCP-A', link: linkA, receipts }), 0);
  assert.equal(core.supplierOrderLinePending({ supplierOrderId: 'OCP-B', link: linkB, receipts }), 2);
});

test('el saldo cancelado de una OC deja de contarse como pendiente de recepción', () => {
  const link = { supplierOrderId: 'OCP-CANCEL', orderLineId: 'LINE-CANCEL', quantity: 2, quantityCancelled: 1, unitPrice: 100 };
  const receipts = [{ supplierOrderId: 'OCP-CANCEL', items: [{ orderLineId: 'LINE-CANCEL', quantityAccepted: 1 }] }];
  assert.equal(core.supplierOrderLinePending({ supplierOrderId: 'OCP-CANCEL', link, receipts }), 0);
  const reconciliation = core.reconcileSupplierPurchase({ order: { id: 'OCP-CANCEL' }, links: [link], receipts, invoices: [] });
  assert.equal(reconciliation.orderedQuantity, 1);
  assert.equal(reconciliation.receivedQuantity, 1);
  assert.equal(reconciliation.quantityStatus, 'matched');
});

test('concilia la compra desde una OC confirmada aunque la partida histórica conserve cero', () => {
  const line = { id: 'LINE-HIST', quantityRequested: 2, quantityPurchased: 0, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, reservedQuantity: 0 };
  const links = [{ supplierOrderId: 'OCP-HIST', orderLineId: 'LINE-HIST', quantity: 2 }];
  const supplierOrders = [{ id: 'OCP-HIST', status: 'confirmed', confirmedAt: '2026-11-06' }];
  const supply = core.effectiveLineSupply({ line, links, supplierOrders, receipts: [] });
  assert.equal(supply.purchased, 2);
  assert.equal(supply.pendingPurchase, 0);
  assert.equal(core.effectiveLineSupply({ line, links, supplierOrders: [{ id: 'OCP-HIST', status: 'draft' }], receipts: [] }).purchased, 0);
});

test('una recepción conciliada como duplicada no vuelve a sumar unidades', () => {
  const line = { id: 'LINE-REC', quantityRequested: 2, quantityPurchased: 0, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, reservedQuantity: 0 };
  const links = [{ supplierOrderId: 'OCP-REC', orderLineId: 'LINE-REC', quantity: 2 }], supplierOrders = [{ id: 'OCP-REC', status: 'received', confirmedAt: '2026-11-06' }];
  const receipts = [{ id: 'REC-1', supplierOrderId: 'OCP-REC', items: [{ orderLineId: 'LINE-REC', quantityAccepted: 2 }] }, { id: 'REC-2', supplierOrderId: 'OCP-REC', duplicateOf: 'REC-1', status: 'duplicate_ignored', items: [{ orderLineId: 'LINE-REC', quantityAccepted: 2 }] }];
  const supply = core.effectiveLineSupply({ line, links, supplierOrders, receipts });
  assert.equal(supply.received, 2);
  assert.equal(supply.purchased, 2);
  assert.equal(core.supplierOrderLinePending({ supplierOrderId: 'OCP-REC', link: links[0], receipts }), 0);
});

test('la importación repetida marca filas como duplicadas', () => {
  const first = simulate([row()]);
  const repeated = simulate([row()], { existingSourceHashes: [first.rows[0].sourceHash] });
  assert.equal(repeated.rows[0].status, 'duplicate');
});

test('dos filas idénticas dentro del mismo archivo no se duplican', () => {
  const simulation = simulate([row(), row()]);
  assert.equal(simulation.rows[0].status === 'duplicate', false);
  assert.equal(simulation.rows[1].status, 'duplicate');
});

test('rechaza registros incompletos y advierte fechas mal ubicadas', () => {
  const simulation = simulate([row({ 6: 'ENTREGADO', 10: null, 11: 0 })]);
  assert.equal(simulation.rows[0].status, 'error');
  assert.equal(simulation.rows[0].issues.some(issue => issue.code === 'INVALID_DATE'), true);
  assert.equal(simulation.rows[0].issues.some(issue => issue.code === 'MISSING_PRODUCT'), true);
});

test('aplica permisos mínimos por rol', () => {
  assert.equal(core.hasPermission('viewer', 'receive'), false);
  assert.equal(core.hasPermission('receiving', 'receive'), true);
  assert.equal(core.hasPermission('admin', 'cancel'), true);
  assert.equal(core.hasPermission('administrator', 'admin'), true);
  assert.equal(core.hasPermission('developer', 'edit'), true);
  assert.equal(core.hasPermission('supervisor', 'purchase'), true);
  assert.equal(core.hasPermission('supervisor', 'admin'), false);
  assert.equal(core.hasPermission('seller', 'edit'), true);
  assert.equal(core.hasPermission('seller', 'receive'), false);
});

console.log('Todas las pruebas del núcleo operativo finalizaron correctamente.');
