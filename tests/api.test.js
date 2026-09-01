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
    assert.equal((await fetch(`${base}/api/bootstrap`).then(response => response.json())).empty, true);
    const imported = await fetch(`${base}/api/import-local`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bio-User': 'Administrador' }, body: JSON.stringify({ state: { 'nexo-products': [{ id: 1, sku: 'BIO-1', name: 'Producto API', price: 10 }] } }) }).then(response => response.json());
    assert.equal(imported.imported, 1);
    const products = await fetch(`${base}/api/products`).then(response => response.json()); assert.equal(products.count, 1); assert.equal(products.data[0].name, 'Producto API');
    const update = await fetch(`${base}/api/state/nexo-products`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: [{ id: 1, sku: 'BIO-1', name: 'Producto actualizado', price: 15 }] }) }).then(response => response.json());
    assert.equal(update.revision.revision, 2);
    assert.equal((await fetch(`${base}/api/bootstrap`).then(response => response.json())).state['nexo-products'][0].price, 15);
  } finally { await new Promise(resolve => server.close(resolve)); await server.closeDatabase(); }
});
