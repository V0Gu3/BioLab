'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInternalOrdersReport, paginateReport } = require('../server/internal-orders-report');

function state() {
  return {
    'nexo-clients': [{ id: 'CLI-1', internalNumber: 'C-00001', name: 'Laboratorios ABC', ownerId: 'USR-SELLER', ownerName: 'Vendedora' }],
    'nexo-commercial-orders': [{ id: 'PI-001', quotationId: 'COT-001', client: 'Laboratorios ABC', ownerId: 'USR-SELLER', seller: 'Vendedora' }],
    'nexo-order-operations-v1': {
      requisitions: [{ id: 'PI-001', source: 'quotation_client_order', type: 'customer_order', requestDate: '2026-04-15', clientOrderId: 'PI-001', customerName: 'Laboratorios ABC', responsible: 'Vendedora', status: 'partially_delivered' }],
      orderLines: [{ id: 'LIN-A', requisitionId: 'PI-001', productId: 'PRO-A', catalog: 'SKU-A', description: 'Reactivo A', unit: 'pza', quantityRequested: 10, quantityCancelled: 0, quantityPurchased: 10 }, { id: 'LIN-B', requisitionId: 'PI-001', productId: 'PRO-B', catalog: 'SKU-B', description: 'Reactivo B', unit: 'pza', quantityRequested: 5, quantityCancelled: 0, quantityPurchased: 5 }],
      supplierOrders: [{ id: 'OC-P-1', supplierName: 'Proveedor Uno', createdAt: '2026-04-16', status: 'confirmed' }, { id: 'OC-P-2', supplierName: 'Proveedor Dos', createdAt: '2026-04-17', status: 'confirmed' }],
      supplierOrderLines: [{ id: 'SOL-1', supplierOrderId: 'OC-P-1', requisitionId: 'PI-001', orderLineId: 'LIN-A', quantity: 6 }, { id: 'SOL-2', supplierOrderId: 'OC-P-2', requisitionId: 'PI-001', orderLineId: 'LIN-A', quantity: 4 }, { id: 'SOL-3', supplierOrderId: 'OC-P-2', requisitionId: 'PI-001', orderLineId: 'LIN-B', quantity: 5 }],
      shipments: [{ id: 'REM-1', folio: 'REM-1', requisitionId: 'PI-001', date: '2026-04-20', items: [{ orderLineId: 'LIN-A', quantity: 4 }] }, { id: 'REM-2', folio: 'REM-2', requisitionId: 'PI-001', date: '2026-04-21', items: [{ orderLineId: 'LIN-A', quantity: 6 }, { orderLineId: 'LIN-B', quantity: 5 }] }, { id: 'REM-X', folio: 'REM-X', requisitionId: 'PI-001', status: 'cancelled', items: [{ orderLineId: 'LIN-A', quantity: 20 }] }]
    }
  };
}

test('consolida remisiones, varias OC y no duplica cantidades por relaciones N:N', () => {
  const report = buildInternalOrdersReport(state(), { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' });
  assert.equal(report.records.length, 1);
  const [record] = report.records;
  assert.equal(record.requested, 15); assert.equal(record.delivered, 15); assert.equal(record.pending, 0); assert.equal(record.deliveryStatus, 'complete');
  assert.equal(record.purchaseOrders.length, 2); assert.equal(record.remissions.length, 2);
  assert.deepEqual(record.products.map(product => [product.sku, product.purchased, product.delivered, product.pending]), [['SKU-A', 10, 10, 0], ['SKU-B', 5, 5, 0]]);
});

test('el reporte cuenta compras confirmadas, descuenta saldos cancelados e ignora propuestas', () => {
  const input = state(), operations = input['nexo-order-operations-v1'];
  operations.orderLines[0].quantityPurchased = 0;
  operations.orderLines[0].quantityReceived = 0;
  operations.shipments = [];
  operations.supplierOrderLines[0].quantityCancelled = 1;
  operations.supplierOrders.push({ id: 'OC-DRAFT', supplierName: 'Proveedor borrador', status: 'draft' });
  operations.supplierOrderLines.push({ id: 'SOL-DRAFT', supplierOrderId: 'OC-DRAFT', requisitionId: 'PI-001', orderLineId: 'LIN-A', quantity: 25 });
  const [record] = buildInternalOrdersReport(input, { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }).records;
  assert.equal(record.products.find(product => product.lineId === 'LIN-A').purchased, 9);
  assert.equal(record.purchaseOrders.some(order => order.id === 'OC-DRAFT'), false);
});

test('reporta el mismo total con IVA congelado en el pedido interno', () => {
  const input = state();
  input['nexo-commercial-orders'][0] = { ...input['nexo-commercial-orders'][0], currency: 'EUR', subtotal: 47.15, taxRate: 16, taxAmount: 7.54, total: 54.69, totalsByCurrency: [{ currency: 'EUR', subtotal: 47.15, discountTotal: 0, taxable: 47.15, taxAmount: 7.54, total: 54.69 }] };
  const [record] = buildInternalOrdersReport(input, { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }).records;
  assert.equal(record.amount, 54.69);
  assert.equal(record.currency, 'EUR');
  assert.equal(record.amountLabel, 'Total con IVA');
});

test('el reporte no vuelve a sumar partidas ni altera un centavo del total congelado', () => {
  const input = state();
  input['nexo-commercial-orders'][0] = { ...input['nexo-commercial-orders'][0], currency: 'MXN', subtotal: 11950.62, taxRate: 16, taxAmount: 1912.1, total: 13862.72, totalsByCurrency: [{ currency: 'MXN', subtotal: 11950.62, discountTotal: 0, taxable: 11950.62, taxAmount: 1912.1, total: 13862.72 }] };
  const [record] = buildInternalOrdersReport(input, { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }).records;
  assert.equal(record.amount, 13862.72);
});

test('filtra por periodo y permite consultar pedidos internos de toda la operación', () => {
  const report = buildInternalOrdersReport(state(), { id: 'USR-SELLER', role: 'seller', name: 'Vendedora' }, { month: '04', year: '2026' });
  assert.equal(report.records.length, 1);
  assert.equal(buildInternalOrdersReport(state(), { id: 'USR-OTHER', role: 'seller', name: 'Otro' }).records.length, 1);
  assert.equal(buildInternalOrdersReport(state(), { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }, { month: '03', year: '2026' }).records.length, 0);
  assert.equal(buildInternalOrdersReport(state(), { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }, { product: 'PRO-A' }).records.length, 1);
  assert.equal(buildInternalOrdersReport(state(), { id: 'USR-ADMIN', role: 'administrator', name: 'Admin' }, { product: 'PRO-X' }).records.length, 0);
  assert.equal(paginateReport({ ...report, records: [...report.records, ...report.records] }, 2, 1).records.length, 1);
});
