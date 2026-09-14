const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server');
const { createTestDatabase } = require('./helpers/postgres');

test('expone la API REST sobre PostgreSQL', async () => {
  const db = await createTestDatabase(), server = await createApp({ db });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then(response => response.json()); assert.equal(health.ok, true); assert.equal(health.database, 'PostgreSQL');
    const anonymousHome = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(anonymousHome.status, 302); assert.equal(anonymousHome.headers.get('location'), '/login.html');
    assert.match(await (await fetch(`${base}/login.html`)).text(), /ACCESO RESTRINGIDO|auth\.js/);
    assert.equal((await fetch(`${base}/api/bootstrap`).then(response => response.json())).empty, true);
    const initialState = { 'nexo-access-v1': { users: [{ id: 'USR-001', name: 'Administrador', email: 'admin@probiolab.test', role: 'administrator', status: 'active' }] }, 'nexo-products': [{ id: 1, sku: 'BIO-1', name: 'Producto API', price: 10 }] };
    const imported = await fetch(`${base}/api/import-local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: initialState }) }).then(response => response.json());
    assert.equal(imported.imported, 2);
    assert.equal((await fetch(`${base}/api/products`)).status, 401);
    const setupResponse = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@probiolab.test', password: 'Contraseña-de-prueba-123' }) }), setup = await setupResponse.json(), cookie = setupResponse.headers.get('set-cookie');
    assert.equal(setup.ok, true); assert.ok(cookie);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const authenticatedHome = await fetch(`${base}/`, { headers }); assert.equal(authenticatedHome.status, 200); assert.match(await authenticatedHome.text(), /class="shell"/);
    const authenticatedLogin = await fetch(`${base}/login.html`, { headers, redirect: 'manual' }); assert.equal(authenticatedLogin.status, 302); assert.equal(authenticatedLogin.headers.get('location'), '/');
    const products = await fetch(`${base}/api/products`, { headers }).then(response => response.json()); assert.equal(products.count, 1); assert.equal(products.data[0].name, 'Producto API');
    const update = await fetch(`${base}/api/state/nexo-products`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 1, sku: 'BIO-1', name: 'Producto actualizado', price: 15 }] }) }).then(response => response.json());
    assert.equal(update.revision.revision, 2);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-products'][0].price, 15);
  } finally { await new Promise(resolve => server.close(resolve)); await server.closeDatabase(); }
});
