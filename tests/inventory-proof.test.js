const test = require('node:test');
const assert = require('node:assert/strict');
const proof = require('../inventory-proof');
const valid = { reason: 'Daño identificado en revisión', reference: 'ACTA-01', evidence: [{ id: 'EV-1', hash: 'sha256' }] };
test('los ajustes manuales exigen motivo, referencia y evidencia conservada', () => {
  for (const type of ['salida', 'merma', 'traspaso']) {
    assert.throws(() => proof.assertNewMovements([], [{ id: 'MOV-1', type }]), /requiere respaldo/);
    assert.doesNotThrow(() => proof.assertNewMovements([], [{ id: 'MOV-1', type, ...valid }]));
  }
  for (const source of ['initial_stock', 'physical_count']) {
    assert.throws(() => proof.assertNewMovements([], [{ id: 'MOV-2', type: 'entrada', source }]), /requiere respaldo/);
    assert.doesNotThrow(() => proof.assertNewMovements([], [{ id: 'MOV-2', type: 'entrada', source, ...valid }]));
  }
});
test('no exige inventar respaldos para movimientos históricos ya almacenados', () => {
  const old = { id: 'HIST', type: 'merma' };
  assert.doesNotThrow(() => proof.assertNewMovements([old], [old]));
  assert.ok(proof.validate({ ...valid, evidence: [{ id: 'EV-1' }] }));
  assert.ok(proof.validate({ ...valid, reference: ' ' }));
});
