const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const core = require('../orders-core');

function receiptHarness(admin = true) {
  const store = core.createEmptyStore();
  store.requisitions.push({ id: 'PI-QA', type: 'customer_order', clientOrderStatus: 'active', responsible: 'QA' });
  store.orderLines.push({ id: 'L1', requisitionId: 'PI-QA', productId: 1, catalog: 'QA', quantityRequested: 2, quantityPurchased: 2, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, unitPrice: 10, taxRate: 16 });
  store.supplierOrders.push({ id: 'OCP-QA', status: 'confirmed' });
  store.supplierOrderLines.push({ id: 'LINK', supplierOrderId: 'OCP-QA', orderLineId: 'L1', quantity: 2 });
  const source = fs.readFileSync(require.resolve('../orders.js'), 'utf8'), start = source.indexOf('  async function applyProgress('), end = source.indexOf('  async function fingerprint(', start);
  const notices = [], adjustments = []; let saved;
  const context = vm.createContext({ core, store, actor: { name: 'QA' }, can: permission => permission !== 'admin' || admin, pastBusinessDate: value => Boolean(value && value < '2026-11-28'), notify: value => notices.push(value), window: { BioMediaStore: { store: async () => [{ id: 'MEDIA-QA', hash: 'hash-qa' }] } }, ensureInventoryProductForReceipt: () => ({ id: 1 }), inventoryMovementFolio: () => 'ENT-QA', saveStore: next => { saved = next; return true; }, applyCatalogStockAdjustments: changes => { adjustments.push(...changes); return true; }, returnToDossierAfterOperation() {} });
  vm.runInContext(source.slice(start, end), context);
  const receive = (quantity, data = {}, override = false) => context.applyProgress('L1', 'receipt', quantity, '', 'QA-REM-C7-TEST', '', override, { qualityStatus: 'released', documentType: 'supplier_remission', evidenceFiles: [{ name: 'qa.pdf', type: 'application/pdf', size: 100 }], warehouseId: '2', ...data });
  return { receive, notices, adjustments, saved: () => saved };
}

test('recepción excedente: rechaza sin autorización y conserva las tres unidades autorizadas', async () => {
  const blocked = receiptHarness(false); await blocked.receive(3, {}, true);
  assert.match(blocked.notices[0], /administración/); assert.equal(blocked.saved(), undefined);
  const ordinary = receiptHarness(); await ordinary.receive(3);
  assert.equal(ordinary.saved(), undefined);
  const allowed = receiptHarness(); await allowed.receive(3, {}, true);
  assert.equal(allowed.saved().receipts[0].items[0].quantityAccepted, 3);
  assert.equal(allowed.saved().inventoryMovements[0].quantity, 3);
  assert.equal(allowed.saved().auditLog[0].override, true);
});

test('rechazo parcial conserva lote, caducidad y evidencia; sólo ingresa la unidad aceptada', async () => {
  const h = receiptHarness(); await h.receive(2, { rejectedQuantity: 1, lot: 'QA-LOTE-C7', expiryDate: '2099-12-31', shortageResolution: 'other_supplier', shortageNotes: 'Autorización QA para buscar otro proveedor', shortageCommitment: '2099-12-01' });
  const receipt = h.saved().receipts[0], item = receipt.items[0];
  assert.equal(item.quantityAccepted, 1); assert.equal(item.quantityRejected, 1);
  assert.equal(item.lot, 'QA-LOTE-C7'); assert.equal(item.expiryDate, '2099-12-31');
  assert.equal(receipt.evidence[0].id, 'MEDIA-QA');
  assert.equal(h.saved().inventoryMovements[0].quantity, 1); assert.equal(h.adjustments[0].delta, 1);
  assert.equal(receipt.shortage.resolution, 'other_supplier'); assert.equal(receipt.shortage.status, 'open');
});

test('sustitución requiere autorización y queda pendiente de resolver, no crea un producto sustituto', async () => {
  const blocked = receiptHarness(); await blocked.receive(1, { shortageResolution: 'substitution' });
  assert.equal(blocked.saved(), undefined); assert.match(blocked.notices[0], /motivo|autorización/);
  const h = receiptHarness(); await h.receive(1, { shortageResolution: 'substitution', shortageNotes: 'Autorización QA', shortageCommitment: '2099-12-01' });
  assert.equal(h.saved().receipts[0].shortage.resolution, 'substitution');
  assert.equal(h.saved().receipts[0].shortage.status, 'open');
  assert.equal(h.saved().orderLines.length, 1);
});

test('el lote caducado bloquea la recepción sin generar movimiento ni consumir evidencia', async () => {
  const h = receiptHarness(); await h.receive(2, { expiryDate: '2025-01-01' });
  assert.match(h.notices[0], /caducidad/); assert.equal(h.saved(), undefined); assert.equal(h.adjustments.length, 0);
});

test('saldo a favor reservado por cotización no se vuelve a reservar ni mezcla monedas', () => {
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const client = { name: 'QA', advances: [{ id: 'A', currency: 'MXN', availableAmount: 100, expiresAtISO: '2099-12-31' }, { id: 'B', currency: 'USD', availableAmount: 80, expiresAtISO: '2099-12-31' }] };
  const context = vm.createContext({ clients: [client], clientMatchesName: (c, name) => c.name === name, currentActor: () => ({ name: 'QA' }), money: (n, c) => `${c} ${n}`, registerClientAudit() {} });
  for (const name of ['advanceIsValid', 'reservedAdvanceAmount', 'applyClientAdvancesToQuotation']) {
    const line = source.split('\n').find(line => line.startsWith('function ' + name + '('));
    vm.runInContext(line, context);
  }
  const quote = { id: 'COT-QA', client: 'QA', advanceRequestedByCurrency: { MXN: 30 } };
  context.applyClientAdvancesToQuotation(quote); context.applyClientAdvancesToQuotation(quote);
  assert.equal(quote.advanceReservations.length, 1); assert.equal(quote.advanceReservations[0].amount, 30);
  assert.equal(client.advances[0].availableAmount, 100); assert.equal(client.advances[1].reservations, undefined);
});
