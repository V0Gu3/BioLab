const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../receipt-presentation');
test('una OC consolidada no mezcla las recepciones ni las cantidades de otros pedidos',()=>{
  const receipts=[{id:'R1',supplierOrderId:'OCP',items:[{orderLineId:'A',quantityAccepted:1},{orderLineId:'B',quantityAccepted:5}]},{id:'R2',supplierOrderId:'OCP',items:[{orderLineId:'B',quantity:3}]},{id:'R3',supplierOrderId:'OCP',items:[{orderLineId:'C',quantity:4}]}],before=JSON.stringify(receipts);
  const scoped=view.scope(receipts,'PI-A',new Set(['A']));
  assert.equal(scoped.length,1);assert.equal(scoped[0].items.length,1);
  assert.equal(view.summary(scoped[0]),'Aceptadas 1, rechazadas 0');
  assert.equal(scoped[0].sharedSupplierOrder,true);
  assert.equal(JSON.stringify(receipts),before);
});
test('agrupa eventos por la misma recepción conservando los IDs originales, no solo por hora',()=>{
  const receipts=[{id:'R1',reference:'FAC1',receivedAt:'2026-11-23T15:00:00Z',items:[{orderLineId:'A'},{orderLineId:'B'}]},{id:'R2',reference:'FAC2',receivedAt:'2026-11-23T15:00:00Z',items:[{orderLineId:'A'}]}];
  const base={action:'receipt_total',at:receipts[0].receivedAt,user:'Andrés',reference:'FAC1'},events=[{...base,id:'E1',entityId:'A'},{...base,id:'E2',entityId:'B'},{...base,id:'E3',entityId:'A',reference:'FAC2'}],before=JSON.stringify(events);
  const rows=view.auditEntries(events,receipts);
  assert.equal(rows.length,2);assert.deepEqual(rows[0].eventIds,['E1','E2']);
  assert.equal(rows[1].reference,'FAC2');assert.equal(JSON.stringify(events),before);
});
test('no inventa folios a partir de nombres de archivo ni elimina la evidencia',()=>{
  const receipt={reference:'medusas.jpeg',evidence:[{name:'medusas.jpeg'}]};
  assert.match(view.reference(receipt),/no capturado/);
  assert.equal(view.reference({...receipt,supplierRemission:'QA-REM-C7-001'}),'QA-REM-C7-001');
  assert.equal(receipt.evidence[0].name,'medusas.jpeg');
});
test('eventos de recepciones sin vínculo verificable conservan su individualidad',()=>{
  const entries=[{id:'A',action:'receipt_total',at:'2026-11-23',entityId:'L'},{id:'B',action:'receipt_total',at:'2026-11-23',entityId:'L'}];
  assert.equal(view.auditEntries(entries,[]).length,2);
});
