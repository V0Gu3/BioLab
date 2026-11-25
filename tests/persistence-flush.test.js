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
