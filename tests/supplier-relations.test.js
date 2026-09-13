const test = require('node:test');
const assert = require('node:assert/strict');
const relationsApi = require('../supplier-relations');
const ordersCore = require('../orders-core');

const products = [{ id: 'P1', number: 'CAT-1', sku: 'SKU-1', name: 'Reactivo', supplierId: 'S1', unit: 'caja', price: 100, priceCurrency: 'MXN' }];
const suppliers = [{ id: 'S1', name: 'Proveedor Uno', active: true }, { id: 'S2', name: 'Proveedor Dos', active: true }];
const baseRelation = changes => ({ id: 'PSR-1', productId: 'P1', supplierId: 'S1', supplierSku: 'CAT-1', purchaseUnit: 'caja', purchasePrice: 80, currency: 'MXN', active: true, preferred: true, ...changes });

test('1. proveedor nuevo: crea una relación persistente completa', () => {
  const list = [], result = relationsApi.upsert(list, baseRelation({ id: null }), 'Compras', '2026-09-09T10:00:00.000Z');
  assert.equal(result.action, 'created'); assert.equal(list[0].createdBy, 'Compras'); assert.equal(list[0].minimumOrderQuantity, 1);
});

test('2. producto existente con segundo proveedor conserva ambas relaciones', () => {
  const list = [relationsApi.normalizeRelation(baseRelation())];
  relationsApi.upsert(list, baseRelation({ id: null, supplierId: 'S2', supplierSku: 'ALT-1', preferred: false }));
  assert.equal(list.length, 2); assert.deepEqual(new Set(list.map(item => item.supplierId)), new Set(['S1', 'S2']));
});

test('3. reimportar la misma clave actualiza sin duplicar', () => {
  const list = []; relationsApi.upsert(list, baseRelation({ id: null, purchasePrice: 80 }));
  const result = relationsApi.upsert(list, baseRelation({ id: null, purchasePrice: 75 }));
  assert.equal(result.action, 'updated'); assert.equal(list.length, 1); assert.equal(list[0].purchasePrice, 75);
});

test('4. proveedor inválido se rechaza en migración', () => {
  const result = relationsApi.migrate({ products, suppliers, priceEntries: [{ id: 'E1', supplierId: 'NO-EXISTE', code: 'CAT-1', price: 10 }] });
  assert.equal(result.report.find(item => item.sourceId === 'E1').status, 'rejected');
});

test('5. entrada enlazada por productId genera relación y conserva auditoría', () => {
  const result = relationsApi.migrate({ products, suppliers, priceEntries: [{ id: 'E1', supplierId: 'S2', code: 'ALT-1', linkedProductId: 'P1', price: 70, currency: 'USD', batchId: 'PRE-1' }], actor: 'Auditor' });
  const entry = result.priceEntries[0], relation = result.relations.find(item => item.id === entry.supplierRelationId);
  assert.equal(entry.linkedProductId, 'P1'); assert.equal(relation.sourceBatchId, 'PRE-1'); assert.equal(relation.createdBy, 'Auditor');
});

test('6. coincidencia exacta por catálogo enlaza de forma segura', () => {
  const result = relationsApi.migrate({ products, suppliers, priceEntries: [{ id: 'E1', supplierId: 'S2', code: 'CAT-1', price: 70 }] });
  assert.equal(result.priceEntries[0].linkedProductId, 'P1');
});

test('7. coincidencia ambigua exige revisión manual', () => {
  const duplicated = [...products, { ...products[0], id: 'P2', sku: 'CAT-1', number: 'OTRO' }];
  const result = relationsApi.migrate({ products: duplicated, suppliers, priceEntries: [{ id: 'E1', supplierId: 'S2', code: 'CAT-1', price: 70 }] });
  assert.equal(result.report.find(item => item.sourceId === 'E1').status, 'manual_review'); assert.equal(result.priceEntries[0].linkedProductId, undefined);
});

test('8. relación inactiva bloquea compras con motivo explícito', () => {
  const result = relationsApi.resolve({ line: { productId: 'P1', supplierRelationId: 'PSR-1' }, products, suppliers, relations: [baseRelation({ active: false })] });
  assert.equal(result.valid, false); assert.equal(result.reasonCode, 'RELATION_INACTIVE');
});

test('9. proveedor inactivo bloquea compras', () => {
  const result = relationsApi.resolve({ line: { productId: 'P1' }, products, suppliers: [{ ...suppliers[0], active: false }], relations: [baseRelation()] });
  assert.equal(result.valid, false); assert.equal(result.reasonCode, 'SUPPLIER_INACTIVE');
});

test('10. producto sin relación no puede generar OC', () => {
  const result = relationsApi.resolve({ line: { productId: 'P1' }, products, suppliers, relations: [] });
  assert.equal(result.valid, false); assert.equal(result.reasonCode, 'RELATION_NOT_FOUND');
});

test('11. relación inválida no deja registro parcial', () => {
  const list = [];
  assert.throws(() => relationsApi.upsert(list, baseRelation({ supplierSku: '' })), /requiere producto/i); assert.equal(list.length, 0);
});

test('12. la agrupación usa proveedor, precio y moneda de la relación', () => {
  const result = ordersCore.groupSupplierPurchaseLines({ lines: [{ id: 'L1', productId: 'P1', quantityRequested: 1 }], products, suppliers, relations: [baseRelation({ supplierId: 'S2', purchasePrice: 72, currency: 'USD' })] });
  assert.equal(result.missing.length, 0); assert.equal(result.groups[0].supplier.id, 'S2'); assert.equal(result.groups[0].currency, 'USD'); assert.equal(result.groups[0].rows[0].relation.purchasePrice, 72);
});

test('13. OC-260908-0002 resuelve sus tres partidas y puede agruparse por proveedor', () => {
  const caseProducts = ['A', 'B', 'C'].map((code, index) => ({ id: `P${index + 1}`, number: code, sku: code, name: `Artículo ${code}`, price: 999, priceCurrency: 'MXN' }));
  const caseRelations = caseProducts.map((product, index) => baseRelation({ id: `PSR-${index + 1}`, productId: product.id, supplierId: 'S2', supplierSku: product.sku, purchasePrice: 10 + index, currency: 'USD', preferred: true }));
  const lines = caseProducts.map((product, index) => ({ id: `LIN-OC-260908-0002-${index + 1}`, requisitionId: 'OC-260908-0002', productId: product.id, supplierRelationId: caseRelations[index].id, supplierId: 'S2', catalog: product.sku }));
  const result = ordersCore.groupSupplierPurchaseLines({ lines, products: caseProducts, suppliers, relations: caseRelations });
  assert.equal(result.missing.length, 0); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].rows.length, 3);
});
