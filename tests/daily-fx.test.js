const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { saveState } = require('../server/db');
const { createTestDatabase } = require('./helpers/postgres');

function loadFx({ user, can = true, initialState = null } = {}) {
  const values = new Map(initialState ? [['nexo-fx-v1', JSON.stringify(initialState)]] : []);
  const window = { BioAccess: { can: () => can, currentUser: () => user || { id: 'USR-001', name: 'Admin', role: 'administrator' } }, dispatchEvent() {}, addEventListener() {}, lucide: null };
  const document = { querySelector: () => null, querySelectorAll: () => [] };
  const context = { window, document, fetch: async () => { throw new Error('Sin red'); }, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }, setTimeout() {}, Intl, Date };
  vm.runInNewContext(fs.readFileSync(require.resolve('../currency.js'), 'utf8'), context);
  return window.BioFX;
}

test('el administrador confirma una sola actualización diaria con trazabilidad por divisa', () => {
  const fx = loadFx(), first = fx.confirmDaily({ rates: { USD: 18.2, CAD: 13.4, EUR: 21.1 }, source: 'Validación administrativa', evidence: 'SIE/SF43718', observations: 'Consulta inicial' });
  assert.equal(first.ok, true);
  const second = fx.confirmDaily({ rates: { USD: 18.3, CAD: 13.5, EUR: 21.2 }, source: 'Validación administrativa', observations: 'Corrección autorizada' });
  assert.equal(second.ok, true);
  const state = fx.getState();
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].validated, true);
  assert.deepEqual(Array.from(state.records[0].currencyEntries, entry => entry.currency), ['USD', 'CAD', 'EUR']);
  assert.equal(state.audit.some(entry => entry.event === 'daily_rates_confirmed'), true);
});

test('un vendedor no puede actualizar y usa el último día validado con marca de contingencia', () => {
  const localDate = value => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value); return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`; };
  const yesterday = localDate(new Date(Date.now() - 36 * 60 * 60 * 1000));
  const fx = loadFx({ user: { id: 'USR-003', name: 'Vendedor', role: 'seller' }, can: false, initialState: { version: 2, records: [{ id: 'FX-OLD', operationalDate: yesterday, consultedDate: yesterday, validated: true, rates: { MXN: 1, USD: 18, CAD: 13, EUR: 21 }, source: 'Banco de México', method: 'automatic_banxico' }], audit: [] } });
  assert.equal(fx.confirmDaily({ rates: { USD: 19, CAD: 14, EUR: 22 }, source: 'No permitido' }).ok, false);
  assert.equal(fx.dailyState().usingFallback, true);
  assert.equal(fx.protectedPrice(100, 'USD', 'MXN').fallback, true);
  assert.equal(fx.quotationSnapshot(['USD']).usedPreviousDay, true);
});

test('la API rechaza registros duplicados de la misma fecha operativa', async () => {
  const db = await createTestDatabase();
  try {
    const record = date => ({ id: `FX-${date}`, operationalDate: date, validated: true, rates: { MXN: 1, USD: 18, CAD: 13, EUR: 21 } });
    await assert.rejects(() => saveState(db, 'nexo-fx-v1', { records: [record('2026-09-10'), record('2026-09-10')], audit: [] }), /un registro de divisas por fecha operativa/);
  } finally { await db.end(); }
});
