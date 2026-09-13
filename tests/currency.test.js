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
  let request;
  const fx = loadFx(async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ bmx: { series: [
    { idSerie: 'SF43718', datos: [{ fecha: '28/08/2026', dato: '17.0000' }] },
    { idSerie: 'SF60632', datos: [{ fecha: '28/08/2026', dato: '12.5000' }] },
    { idSerie: 'SF46410', datos: [{ fecha: '28/08/2026', dato: '20.0000' }] }
  ] } }) }; });
  assert.equal(fx.setBanxicoToken('TOKEN-VALIDO-123').ok, true);
  const record = await fx.ensureDaily();
  assert.equal(record.sourceType, 'official_primary');
  assert.equal(record.rates.USD, 17);
  assert.equal(record.rates.CAD, 12.5);
  assert.equal(record.rates.EUR, 20);
  assert.match(request.url, /^https:\/\/www\.banxico\.org\.mx\/SieAPIRest\/service\/v1\/series\/SF43718,SF60632,SF46410\/datos\/oportuno\?token=TOKEN-VALIDO-123$/);
  assert.equal(fx.protectedPrice(100, 'USD', 'MXN').unitPrice, 2125);
  const refreshed = await fx.ensureDaily({ force: true, confirmationRequired: false });
  assert.equal(refreshed.validated, true);
  assert.equal(fx.getState().audit.some(entry => entry.event === 'daily_rates_registered'), true);
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

test('las tasas se guardan y se exponen con cuatro decimales', () => {
  const fx = loadFx(async () => { throw new Error('Sin red'); });
  const result = fx.saveManual({ USD: 18.123456, CAD: 13.987654, EUR: 21.00009, reason: 'Prueba de precisión' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fx.todayRecord().rates)), { MXN: 1, USD: 18.1235, CAD: 13.9877, EUR: 21.0001 });
});

test('la solicitud diaria se programa para el primer segundo del siguiente día operativo', () => {
  const source = fs.readFileSync(require.resolve('../currency.js'), 'utf8');
  assert.match(source, /millisecondsUntilNextOperationalDay/);
  assert.match(source, /high \+ 1000/);
  assert.match(source, /scheduleDailyAdministratorPrompt\(\)/);
  assert.match(source, /bio:access-changed[\s\S]*?checkDailyAdministratorPrompt/);
  assert.match(source, /visibilitychange[\s\S]*?checkDailyAdministratorPrompt/);
  assert.match(source, /id="openDailyFxSelection"/);
  assert.match(source, /promptDailyAdministrator\(\{ force: true \}\)/);
});

test('la solicitud diaria consulta las tres fuentes y conserva la fuente elegida', async () => {
  const calls = [];
  const fx = loadFx(async url => {
    calls.push(url);
    if (url.includes('banxico.org.mx')) return { ok: true, json: async () => ({ bmx: { series: [
      { idSerie: 'SF43718', datos: [{ fecha: '12/09/2026', dato: '18.1000' }] },
      { idSerie: 'SF60632', datos: [{ fecha: '12/09/2026', dato: '13.2000' }] },
      { idSerie: 'SF46410', datos: [{ fecha: '12/09/2026', dato: '21.3000' }] }
    ] } }) };
    if (url.includes('ecb.europa.eu')) return { ok: true, text: async () => officialCsv };
    return { ok: true, json: async () => ({ date: '2026-09-12', rates: { USD: 2, CAD: 4, MXN: 20 } }) };
  });
  assert.equal(fx.setBanxicoToken('TOKEN-VALIDO-123').ok, true);
  const candidates = await fx.consultDailySources();
  assert.deepEqual(Array.from(candidates, candidate => candidate.key), ['banxico', 'ecb', 'frankfurter']);
  assert.equal(calls.length, 3);
  const selected = candidates[1];
  const result = fx.confirmDaily({ rates: selected.rates, source: selected.source, sourceType: selected.sourceType, method: selected.method, endpoint: selected.endpoint, selectedSourceKey: selected.key, sourceCandidates: candidates });
  assert.equal(result.ok, true);
  assert.equal(fx.todayRecord().selectedSourceKey, 'ecb');
  assert.equal(fx.todayRecord().sourceCandidates.length, 3);
});

test('la tasa protegida aplica el porcentaje comercial sobre la tasa confirmada', () => {
  const fx = loadFx(async () => { throw new Error('Sin red'); });
  assert.equal(fx.setProtection(20).ok, true);
  assert.equal(fx.saveManual({ USD: 18, CAD: 13, EUR: 21, reason: 'Prueba de protección' }).ok, true);
  assert.equal(fx.protectedPrice(1, 'USD', 'MXN').unitPrice, 22.5);
});

test('una sincronización fallida conserva el último registro válido y deja el detalle de las fuentes', async () => {
  const fx = loadFx(async () => { throw new Error('Sin conexión'); });
  assert.equal(fx.saveManual({ USD: 18, CAD: 13, EUR: 21, reason: 'Base validada' }).ok, true);
  const prior = fx.todayRecord().id;
  assert.equal(await fx.ensureDaily({ force: true }), null);
  assert.equal(fx.todayRecord().id, prior);
  const failures = fx.getState().audit.filter(entry => entry.event === 'rate_source_failed');
  assert.deepEqual(Array.from(failures, entry => entry.source), ['frankfurter', 'ecb', 'banxico']);
});
