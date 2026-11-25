const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../commercial-money');
const { buildInternalOrdersReport } = require('../internal-orders-report-core');

test('el reporte histórico respeta IVA cero de origen aunque el pedido tenga IVA heredado incorrecto', () => {
  const quote = { id: 'COT', taxRate: 0, currency: 'CAD', items: [{ sku: 'A', quantity: 1, unitPrice: 491.74 }] };
  const order = { id: 'PI', quotationId: 'COT', currency: 'CAD', total: 570.41, items: [{ sku: 'A', quantity: 1, unitPrice: 491.74, taxRate: 16, total: 570.41 }] };
  const state = { 'nexo-sales-quotations': [quote], 'nexo-commercial-orders': [order], 'nexo-order-operations-v1': { requisitions: [{ id: 'PI', type: 'customer_order' }], orderLines: [{ id: 'L1', requisitionId: 'PI', quantityRequested: 1, total: 570.41 }] } };
  const report = buildInternalOrdersReport(state);
  assert.equal(report.records[0].amount, 491.74);
  assert.equal(report.records[0].financialTotals[0].taxAmount, 0);
  assert.equal(report.records[0].products[0].total, 491.74);
  assert.equal(order.total, 570.41); // La presentación no reescribe el histórico.
});

test('redondea el precio publicado antes de multiplicar y separa monedas y descuento', () => {
  const result = money.snapshot({ taxRate: 16, items: [{ quantity: 2, unitPrice: 667.483, currency: 'MXN' }, { quantity: 3, unitPrice: 1118.7333, discount: 10, currency: 'CAD', taxRate: 0 }] });
  assert.equal(result.items[0].unitPrice, 667.48);
  assert.equal(result.items[0].subtotal, 1334.96);
  assert.equal(result.items[1].subtotal, 3356.19);
  assert.equal(result.items[1].discountTotal, 335.62);
  assert.equal(result.items[1].taxAmount, 0);
  assert.equal(result.currency, 'MULTI');
  assert.deepEqual(money.snapshot(result).totalsByCurrency, result.totalsByCurrency);
});

test('conserva descuentos monetarios explícitos y toma IVA cero aun si el pedido guarda 16%', () => {
  const result = money.snapshot({ quotationId: 'Q', items: [{ quantity: 1, unitPrice: 100, discountTotal: 10, taxRate: 16 }] }, [{ id: 'Q', taxRate: 0 }]);
  assert.equal(result.total, 90);
  assert.equal(result.discountTotal, 10);
  assert.equal(result.taxAmount, 0);
});
