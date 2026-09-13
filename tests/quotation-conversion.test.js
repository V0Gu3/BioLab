const test = require('node:test');
const assert = require('node:assert/strict');
const conversion = require('../quotation-conversion');

const quotation = (changes = {}) => ({
  id: 'COT-260908-0001', client: 'Cliente de prueba', contact: 'Ana', email: 'ana@cliente.mx',
  expiresAtISO: '2026-10-08T23:59:59.000Z', expiresAt: '08 oct 2026',
  items: [{ name: 'Reactivo A', quantity: 2, unitPrice: 125 }], ...changes
});

test('explica los bloqueos reales antes de convertir una cotización', () => {
  const result = conversion.assess(quotation({ expiresAtISO: '2026-09-01T00:00:00.000Z', expiresAt: '01 sep 2026', items: [] }), { now: new Date('2026-09-08T12:00:00.000Z') });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter(check => check.state === 'blocking').map(check => check.code), ['quotation_expired', 'missing_items']);
  assert.match(result.checks.find(check => check.code === 'quotation_expired').message, /venció/i);
});

test('distingue permiso, conversión duplicada y aceptación posterior', () => {
  const denied = conversion.assess(quotation(), { canConvert: false, now: new Date('2026-09-08T12:00:00.000Z') });
  assert.equal(denied.ok, false);
  assert.equal(denied.checks.find(check => check.code === 'permission_denied').role, 'Supervisor o administrador');
  const duplicate = conversion.assess(quotation({ commercialOrderId: 'OC-260908-0001' }), { now: new Date('2026-09-08T12:00:00.000Z') });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.checks.find(check => check.code === 'already_converted').message, /OC-260908-0001/);
  const ready = conversion.assess(quotation(), { now: new Date('2026-09-08T12:00:00.000Z') });
  assert.equal(ready.ok, true);
  assert.equal(ready.checks.some(check => check.code === 'acceptance_pending' && check.state === 'warning'), true);
});
