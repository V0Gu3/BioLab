const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../delivery-presentation');
test('una fecha de documento conserva su día y no inventa una hora',()=>{
  assert.match(view.format('2026-11-23'),/23/);
  assert.doesNotMatch(view.format('2026-11-23'),/18:00|6:00/);
  assert.equal(view.dateLabel({date:'2026-11-23'}),view.format('2026-11-23'));
  assert.equal(view.day('2026-11-24T02:00:00Z'),'2026-11-23');
  assert.equal(view.dateLabel({date:'2026-11-23',deliveredAt:'2026-11-23T15:38:00Z'}),view.format('2026-11-23T15:38:00Z'));
});
test('la última remisión cierra el saldo autorizado sin volver totales las entregas anteriores',()=>{
  const lines=[{id:'L',quantityRequested:3,quantityCancelled:1,quantityDelivered:2}],shipments=[{id:'A',requisitionId:'PI',date:'2026-11-22',type:'partial',items:[{orderLineId:'L',quantity:1}]},{id:'B',requisitionId:'PI',date:'2026-11-23',type:'partial',items:[{orderLineId:'L',quantity:1}]}];
  assert.equal(view.label(shipments[0],lines,shipments),'Entrega parcial');
  assert.equal(view.label(shipments[1],lines,shipments),'Entrega completa');
  assert.deepEqual(view.progress(lines),{requested:2,delivered:2,overDelivered:0});
  assert.equal(lines[0].quantityCancelled,1);
});
test('una partida completa no cierra otra pendiente ni oculta excedentes reales',()=>{
  const lines=[{id:'A',quantityRequested:1,quantityDelivered:2},{id:'B',quantityRequested:1,quantityDelivered:0}],shipment={id:'S',requisitionId:'PI',items:[{orderLineId:'A',quantity:2}]};
  assert.equal(view.label(shipment,lines,[shipment]),'Entrega parcial');
  assert.deepEqual(view.progress(lines),{requested:2,delivered:1,overDelivered:1});
});
