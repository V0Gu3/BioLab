const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTestDatabase } = require('./helpers/postgres');
const { saveState, readState } = require('../server/db');
const { setPassword } = require('../server/auth');

test('el alta desde Pruebas actualiza el directorio para credenciales sin tocar inventario operativo', async () => {
  const db = await createTestDatabase();
  try {
    await saveState(db, 'nexo-products', [{ id: 'P1', name: 'Producto operativo', a1: 7 }]);
    const productBefore = (await db.query('SELECT * FROM products')).rows;
    const access = { users: [{ id: 'USR-QA', name: 'Vendedor QA', email: 'qa@example.test', role: 'seller', status: 'active', sellerNumber: 'V-001' }], audit: [{ id: 'QA-CREATE', type: 'user_created', entityId: 'USR-QA' }] };
    await saveState(db, 'nexo-access-v1', access, 'Desarrollo', null, 'training');
    assert.equal((await db.query('SELECT role FROM users WHERE id=$1', ['USR-QA'])).rows[0].role, 'seller');
    await setPassword(db, 'USR-QA', 'Fixture-only!password-29');
    assert.equal((await db.query('SELECT user_id FROM user_credentials')).rows[0].user_id, 'USR-QA');
    await saveState(db, 'nexo-access-v1', access, 'Desarrollo', null, 'training');
    assert.equal((await db.query("SELECT id FROM audit_events WHERE source_key='nexo-access-v1'")).rows.length, 1);
    assert.deepEqual((await db.query('SELECT * FROM products')).rows, productBefore);
    assert.equal((await readState(db))['nexo-products'][0].a1, 7);
  } finally { await db.end(); }
});

function harness({ flush = async () => {}, password = async () => {} } = {}) {
  const source = fs.readFileSync(require.resolve('../settings.js'), 'utf8');
  const start = source.indexOf('  let systemUserSaving = false;'), end = source.indexOf("  q('#systemUserForm').addEventListener('submit', saveSystemUser);", start);
  const button = { disabled: false }, form = { querySelector: () => button, setAttribute() {}, removeAttribute() {} };
  const dialog = { closes: 0, close() { this.closes++; } }, messages = [], inputs = {};
  for (const [name, value] of Object.entries({ Role: 'seller', Email: 'qa@example.test', Password: '', Id: '', Name: 'QA', SellerNumber: '', Status: 'active' })) inputs['#systemUser' + name] = { value };
  let saves = 0;
  const access = { rolePermissions: () => [], saveUser() { saves++; return { ok: true }; }, getState: () => ({ users: [{ id: 'USR-QA', email: 'qa@example.test' }] }) };
  const nodes = { ...inputs, '#systemUserForm': form, '#systemUserDialog': dialog, '#systemUserPermissions': { querySelectorAll: () => [] } };
  const context = vm.createContext({ q: selector => nodes[selector], access, toast: message => messages.push(message), window: { BioPersistence: { flush }, BioAuth: { setPassword: password } } });
  vm.runInContext(source.slice(start, end), context);
  return { submit: () => context.saveSystemUser({ preventDefault() {} }), button, dialog, inputs, messages, saves: () => saves };
}

test('edición sin contraseña espera confirmación central y cierra; bloquea doble clic', async () => {
  let resolve;
  const h = harness({ flush: () => new Promise(done => { resolve = done; }) });
  const saving = h.submit();
  assert.equal(h.dialog.closes, 0); assert.equal(h.button.disabled, true);
  await h.submit(); assert.equal(h.saves(), 1);
  resolve(); await saving;
  assert.equal(h.dialog.closes, 1); assert.equal(h.button.disabled, false);
});

test('un error conserva el formulario y el ID; éxito posterior limpia contraseña y cierra', async () => {
  let fail = true;
  const h = harness({ password: async () => { if (fail) throw new Error('Error de credenciales'); } });
  h.inputs['#systemUserPassword'].value = 'Fixture-only!password';
  await h.submit();
  assert.equal(h.dialog.closes, 0); assert.equal(h.inputs['#systemUserId'].value, 'USR-QA');
  assert.equal(h.messages[0], 'Error de credenciales'); assert.equal(h.button.disabled, false);
  fail = false; await h.submit();
  assert.equal(h.dialog.closes, 1); assert.equal(h.inputs['#systemUserPassword'].value, '');
});
