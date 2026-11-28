const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const source = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  const wrapper = source.slice(source.indexOf('  let flushPromise = null;'), source.indexOf('  async function flushPending'));
  const pending = new Map(), operations = [];
  const context = vm.createContext({ pending, status: { error: 'Sin conexión' }, timer: null, clearTimeout() {}, flushPending() {
    pending.clear();
    return new Promise(resolve => operations.push(resolve));
  } });
  vm.runInContext(`${wrapper}\nthis.flush = flush;`, context);
  return { pending, operations, flush: context.flush };
}

test('reconciliar un 409 no confirma escrituras rechazadas ni permite continuar después', async () => {
  const source = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  const code = source.slice(source.indexOf('  async function flushPending('), source.indexOf('  function queue('));
  const pending = new Map([['quotes', []], ['orders', []]]), status = { connected: true, error: null };
  let requests = 0, reconciliations = 0;
  const context = vm.createContext({ pending, status, timer: null, actor: () => 'QA', workspaceHeaders: () => ({}), safePayload: (_key, value) => value, writableKeys: new Set(), notify() {}, bootstrapMeta: () => null, saveBootstrapMeta() {}, bootstrap: async () => { reconciliations++; status.error = null; }, console: { warn() {} }, fetch: async () => { requests++; return { ok: false, status: 409, json: async () => ({ error: 'El pedido está protegido' }) }; } });
  vm.runInContext(code, context);
  await assert.rejects(context.flushPending({ throwOnError: true }), /pedido está protegido/);
  assert.equal(requests, 1); assert.equal(reconciliations, 1);
  await assert.rejects(context.flushPending({ throwOnError: true }), /pedido está protegido/);
  assert.equal(requests, 1);
});

test('guardar pedido espera la sincronización en curso y los cambios recibidos durante ella', async () => {
  const h = harness();
  h.pending.set('quotations', ['COT-1']);
  const background = h.flush();
  let finished = false;
  const beforeOrder = h.flush({ throwOnError: true }).then(() => { finished = true; });
  assert.equal(h.operations.length, 1);
  h.pending.set('quotations', ['COT-1', 'COT-2']);
  h.operations[0](true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(h.operations.length, 2);
  h.operations[1](true);
  await Promise.all([background, beforeOrder]);
  assert.equal(finished, true);
});

test('un fallo de guardado en segundo plano impide continuar con el pedido', async () => {
  const h = harness();
  const background = h.flush();
  const beforeOrder = h.flush({ throwOnError: true });
  const rejection = assert.rejects(beforeOrder, /Sin conexión/);
  h.operations[0](false);
  assert.equal(await background, false);
  await rejection;
});

test('después de activar, otra cotización conserva el bloqueo exacto confirmado por el servidor', () => {
  const { enforceRequiredQuotationLock } = require('../server/server');
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const listener = source.split('\n').find(line => line.startsWith("window.addEventListener('bio:quotation-converted'"));
  let receive;
  const confirmed = { id: 'Q1', status: 'required', locked: true, lockedAtISO: '2026-11-28T18:00:00Z', lockedBy: 'QA', requiredAtISO: '2026-11-28T18:00:00Z', statusHistory: [{ status: 'required', at: '2026-11-28T18:00:00Z' }] };
  const context = vm.createContext({ quotations: [{ id: 'Q1', status: 'required', locked: true }], window: { addEventListener: (_type, fn) => { receive = fn; } }, structuredClone, renderQuotationHistory() {}, $: () => ({ value: '' }) });
  vm.runInContext(listener, context);
  receive({ detail: { quotations: [confirmed] } });
  const next = [...context.quotations, { id: 'Q2', status: 'sent', items: [] }];
  assert.doesNotThrow(() => enforceRequiredQuotationLock({ 'nexo-sales-quotations': [confirmed] }, next));
  assert.equal(next[0].lockedBy, 'QA');
  assert.notEqual(next[0], confirmed);
});
