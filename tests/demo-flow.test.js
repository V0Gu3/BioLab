const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadDemo() {
  const values = new Map(), localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const window = { localStorage };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo-flow.js'), 'utf8'), { window });
  return { window, values };
}

test('registra el flujo completo con cadena documental y auditoría', () => {
  const { window } = loadDemo(), result = window.BioDemoFlow.seed({ date: new Date('2026-08-30T12:00:00-06:00') }), ids = result.marker.ids;
  assert.ok(result.quotation);
  assert.equal(result.clientOrder.status, 'active');
  assert.equal(result.clientOrder.acceptance.type, 'customer_po');
  assert.ok(result.clientOrder.acceptance.reference);
  assert.ok(result.clientOrder.acceptance.hash);
  assert.equal(result.store.requisitions.find(item => item.id === ids.clientOrder).status, 'closed');
  assert.ok(result.store.supplierOrders.some(item => item.id === ids.supplierOrder && item.exchangeRate === 17.1));
  assert.ok(result.store.receipts.some(item => item.id === ids.receipt && item.evidence?.length && item.items[0].quantityAccepted === 2));
  assert.ok(result.store.inventoryMovements.some(item => item.id === ids.inventoryEntry));
  assert.ok(result.store.inventoryMovements.some(item => item.id === ids.inventoryExit));
  assert.ok(result.store.shipments.some(item => item.id === ids.shipment && item.recipient === 'Ana Martínez' && item.evidence?.length));
  assert.ok(result.store.customerInvoices.some(item => item.id === ids.customerInvoice));
  assert.equal(result.store.auditLog.filter(item => item.demo).length, 12);
});

test('la guía de entrenamiento describe la recepción que realmente ejecuta', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<strong>Recepción y entrada<\/strong>Movimiento simulado sin afectar almacenes\./);
  assert.doesNotMatch(html, /<strong>Recepción parcial<\/strong>Entrada simulada/);
});

test('el registro es idempotente y no se duplica al recargar', () => {
  const { window } = loadDemo(), first = window.BioDemoFlow.seed(), second = window.BioDemoFlow.seed(), ids = first.marker.ids;
  const count = (list, id) => list.filter(item => String(item.id) === String(id)).length;
  assert.equal(count(second.store.requisitions, ids.clientOrder), 1);
  assert.equal(count(second.store.supplierOrders, ids.supplierOrder), 1);
  assert.equal(count(second.store.shipments, ids.shipment), 1);
  assert.equal(second.store.auditLog.filter(item => item.demo).length, 12);
});
