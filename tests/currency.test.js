const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const officialCsv = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
EXR.D.CAD.EUR.SP00.A,D,CAD,EUR,SP00,A,2026-08-28,4
EXR.D.MXN.EUR.SP00.A,D,MXN,EUR,SP00,A,2026-08-28,20
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-08-28,2`;

function loadFx(fetch) {
  const values = new Map(), window = { BioAccess: { can: () => true, currentUser: () => ({ id: 'USR-001', name: 'Admin' }) }, dispatchEvent() {}, addEventListener() {}, lucide: null };
  const document = { querySelector: () => null, querySelectorAll: () => [] };
  const context = { window, document, fetch, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }, setTimeout() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../currency.js'), 'utf8'), context);
  return window.BioFX;
}

test('consulta Banco de México como fuente principal y calcula tasas contra MXN', async () => {
  const fx = loadFx(async () => ({ ok: true, json: async () => ({ bmx: { series: [
    { idSerie: 'SF43718', datos: [{ fecha: '28/08/2026', dato: '17.0000' }] },
    { idSerie: 'SF60632', datos: [{ fecha: '28/08/2026', dato: '12.5000' }] },
    { idSerie: 'SF46410', datos: [{ fecha: '28/08/2026', dato: '20.0000' }] }
  ] } }) }));
  assert.equal(fx.setBanxicoToken('TOKEN-VALIDO-123').ok, true);
  const record = await fx.ensureDaily();
  assert.equal(record.sourceType, 'official_primary');
  assert.equal(record.rates.USD, 17);
  assert.equal(record.rates.CAD, 12.5);
  assert.equal(record.rates.EUR, 20);
  assert.equal(fx.protectedPrice(100, 'USD', 'MXN').unitPrice, 2125);
});

test('usa el Banco Central Europeo cuando Banxico no tiene token', async () => {
  const fx = loadFx(async () => ({ ok: true, text: async () => officialCsv }));
  const record = await fx.ensureDaily();
  assert.equal(record.sourceType, 'official_secondary');
  assert.equal(record.rates.USD, 10);
  assert.equal(record.rates.CAD, 5);
  assert.equal(record.rates.EUR, 20);
  assert.equal(fx.getState().audit.some(entry => entry.event === 'rate_source_failed' && entry.source === 'banxico'), true);
});

test('usa Frankfurter cuando falla también la fuente oficial secundaria', async () => {
  let attempt = 0;
  const fx = loadFx(async () => { attempt += 1; if (attempt === 1) throw new Error('Sin fuente oficial'); return { ok: true, json: async () => ({ date: '2026-08-28', rates: { USD: 2, CAD: 4, MXN: 20 } }) }; });
  const record = await fx.ensureDaily();
  assert.equal(record.sourceType, 'trusted_tertiary');
  assert.equal(attempt, 2);
  assert.equal(fx.getState().audit.some(entry => entry.event === 'rate_source_failed'), true);
});

test('la captura manual exige motivo y conserva auditoría', () => {
  const fx = loadFx(async () => { throw new Error('Sin red'); });
  assert.equal(fx.saveManual({ USD: 18, CAD: 13, EUR: 21, reason: '' }).ok, false);
  assert.equal(fx.saveManual({ USD: 18, CAD: 13, EUR: 21, reason: 'Fuentes no disponibles' }).ok, true);
  assert.equal(fx.todayRecord().method, 'manual');
  assert.equal(fx.getState().audit[0].event, 'manual_rates_registered');
});
