const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server');
const { createTestDatabase } = require('./helpers/postgres');

test('expone la API REST sobre PostgreSQL', async () => {
  const db = await createTestDatabase(), bootstrapToken = 'bootstrap-test-token', server = await createApp({ db, bootstrapToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then(response => response.json()); assert.equal(health.ok, true); assert.equal(health.database, 'PostgreSQL');
    const anonymousHome = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(anonymousHome.status, 302); assert.equal(anonymousHome.headers.get('location'), '/login.html');
    assert.match(await (await fetch(`${base}/login.html`)).text(), /ACCESO RESTRINGIDO|auth\.js/);
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
    const bootstrapHeaders = { 'Content-Type': 'application/json', 'x-bio-bootstrap-token': bootstrapToken };
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: bootstrapHeaders }).then(response => response.json())).empty, true);
    const initialState = { 'nexo-access-v1': { users: [{ id: 'USR-001', name: 'Administrador', email: 'admin@probiolab.test', role: 'administrator', status: 'active' }] }, 'nexo-products': [{ id: 1, sku: 'BIO-1', name: 'Producto API', price: 10 }] };
    const imported = await fetch(`${base}/api/import-local`, { method: 'POST', headers: bootstrapHeaders, body: JSON.stringify({ state: initialState }) }).then(response => response.json());
    assert.equal(imported.imported, 2);
    assert.equal((await fetch(`${base}/api/products`)).status, 401);
    const setupResponse = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: bootstrapHeaders, body: JSON.stringify({ email: 'admin@probiolab.test', password: 'Contraseña-de-prueba-123' }) }), setup = await setupResponse.json(), cookie = setupResponse.headers.get('set-cookie');
    assert.equal(setup.ok, true); assert.ok(cookie);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rate-limit@probiolab.test', password: 'Contraseña-incorrecta-123' }) });
      assert.equal(failedLogin.status, attempt === 4 ? 429 : 401);
    }
    const lockedLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rate-limit@probiolab.test', password: 'Contraseña-incorrecta-123' }) });
    assert.equal(lockedLogin.status, 429);
    assert.ok(Number(lockedLogin.headers.get('retry-after')) > 0);
    const authenticatedHome = await fetch(`${base}/`, { headers }); assert.equal(authenticatedHome.status, 200); assert.match(await authenticatedHome.text(), /class="shell"/);
    const authenticatedLogin = await fetch(`${base}/login.html`, { headers, redirect: 'manual' }); assert.equal(authenticatedLogin.status, 302); assert.equal(authenticatedLogin.headers.get('location'), '/');
    const products = await fetch(`${base}/api/products`, { headers }).then(response => response.json()); assert.equal(products.count, 1); assert.equal(products.data[0].name, 'Producto API');
    const executiveDashboard = await fetch(`${base}/api/dashboard/executive`, { headers }).then(response => response.json());
    assert.equal(executiveDashboard.ok, true); assert.equal(executiveDashboard.data.inventory.references, 1);
    assert.equal((await fetch(`${base}/api/alerts`, { headers })).status, 200);
    const update = await fetch(`${base}/api/state/nexo-products`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 1, sku: 'BIO-1', name: 'Producto actualizado', price: 15 }] }) }).then(response => response.json());
    assert.equal(update.revision.revision, 2);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-products'][0].price, 15);
    const accessState = (await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-access-v1'];
    accessState.users.push({ id: 'USR-005', name: 'Nuevo usuario', email: 'nuevo@probiolab.test', role: 'seller', status: 'active' }, { id: 'USR-006', name: 'Auditor', email: 'auditor@probiolab.test', role: 'auditor', status: 'active' });
    const savedUser = await fetch(`${base}/api/state/nexo-access-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: accessState }) });
    assert.equal(savedUser.status, 200);
    const password = await fetch(`${base}/api/auth/users/USR-005/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'Contraseña-nueva-123' }) });
    assert.equal(password.status, 200);
    assert.equal((await fetch(`${base}/api/auth/users/USR-006/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'Contraseña-auditor-123' }) })).status, 200);
    assert.equal((await fetch(`${base}/api/state/nexo-fx-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: { records: [], audit: [], banxicoToken: 'token-interno-de-prueba' } }) })).status, 200);
    const clientPortfolio = [
      { id: 'CLI-ADMIN', name: 'Cartera administración', ownerId: 'USR-001', ownerName: 'Administrador' },
      { id: 'CLI-SELLER', name: 'Cartera vendedor', ownerId: 'USR-005', ownerName: 'Nuevo usuario' }
    ];
    assert.equal((await fetch(`${base}/api/state/nexo-clients`, { method: 'PUT', headers, body: JSON.stringify({ payload: clientPortfolio }) })).status, 200);
    assert.equal((await fetch(`${base}/api/state/nexo-sales-quotations`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 'COT-ADMIN', client: 'Cartera administración', ownerId: 'USR-001' }, { id: 'COT-SELLER', client: 'Cartera vendedor', ownerId: 'USR-005' }] }) })).status, 200);
    const sellerLoginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nuevo@probiolab.test', password: 'Contraseña-nueva-123' }) }), newUserLogin = await sellerLoginResponse.json(), sellerHeaders = { Cookie: sellerLoginResponse.headers.get('set-cookie') };
    assert.equal(newUserLogin.ok, true);
    assert.equal(newUserLogin.user.email, 'nuevo@probiolab.test');
    const sellerBootstrap = await fetch(`${base}/api/bootstrap`, { headers: sellerHeaders }).then(response => response.json());
    assert.deepEqual(sellerBootstrap.allowedKeys.sort(), ['nexo-clients', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-sales-quotations'].sort());
    assert.deepEqual(sellerBootstrap.state['nexo-clients'].map(client => client.id), ['CLI-SELLER']);
    assert.deepEqual(sellerBootstrap.state['nexo-sales-quotations'].map(quotation => quotation.id), ['COT-SELLER']);
    assert.deepEqual(sellerBootstrap.state['nexo-access-v1'].users.map(user => user.id), ['USR-005']);
    assert.deepEqual(sellerBootstrap.state['nexo-movements'], []);
    assert.equal((await fetch(`${base}/api/movements`, { headers: sellerHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/audit`, { headers: sellerHeaders })).status, 403);
    const auditorLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auditor@probiolab.test', password: 'Contraseña-auditor-123' }) });
    const auditorHeaders = { Cookie: auditorLogin.headers.get('set-cookie') }, auditorBootstrap = await fetch(`${base}/api/bootstrap`, { headers: auditorHeaders }).then(response => response.json());
    assert.equal(auditorLogin.status, 200);
    assert.deepEqual(auditorBootstrap.state['nexo-products'], []);
    assert.deepEqual(auditorBootstrap.state['nexo-fx-v1'], { records: [], audit: [] });
    assert.equal(auditorBootstrap.state['nexo-fx-v1'].banxicoToken, undefined);
    assert.deepEqual(auditorBootstrap.state['nexo-access-v1'].users.map(user => user.id), ['USR-006']);
    const discountApproval = await fetch(`${base}/api/approvals`, { method: 'POST', headers, body: JSON.stringify({ actionType: 'high_discount', entityType: 'quotation', entityId: 'COT-ADMIN', justification: 'Descuento comercial excepcional por volumen.', payload: { discountPercent: 15 } }) }).then(response => response.json());
    assert.equal(discountApproval.ok, true);
    const ownApproval = await fetch(`${base}/api/approvals/${discountApproval.data.id}/decision`, { method: 'POST', headers, body: JSON.stringify({ status: 'approved', reason: 'Autorización propia no permitida.' }) });
    assert.equal(ownApproval.status, 403);
    assert.equal((await fetch(`${base}/api/approvals`, { headers: sellerHeaders })).status, 200);
    const sellerClientWrite = await fetch(`${base}/api/state/nexo-clients`, { method: 'PUT', headers: { ...sellerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: [{ id: 'CLI-SELLER', name: 'Cartera vendedor actualizada', ownerId: 'USR-001' }, { id: 'CLI-ADMIN', name: 'Intento no autorizado', ownerId: 'USR-005' }] }) });
    assert.equal(sellerClientWrite.status, 200);
    const adminPortfolio = await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json());
    assert.equal(adminPortfolio.state['nexo-clients'].find(client => client.id === 'CLI-ADMIN').name, 'Cartera administración');
    const sellerClient = adminPortfolio.state['nexo-clients'].find(client => client.id === 'CLI-SELLER');
    assert.equal(sellerClient.name, 'Cartera vendedor actualizada');
    assert.equal(sellerClient.ownerId, 'USR-005');
    const deletedUser = await fetch(`${base}/api/auth/users/USR-005`, { method: 'DELETE', headers, body: JSON.stringify({ reason: 'Baja de prueba automatizada.' }) });
    assert.equal(deletedUser.status, 200);
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nuevo@probiolab.test', password: 'Contraseña-nueva-123' }) })).status, 401);
    const accessForReset = (await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-access-v1'];
    accessForReset.roleOverrides = { administrator: { grants: ['system_reset'] } };
    assert.equal((await fetch(`${base}/api/state/nexo-access-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: accessForReset }) })).status, 200);
    const escalatedReset = await fetch(`${base}/api/system/reset`, { method: 'POST', headers, body: JSON.stringify({ confirmation: 'RESTABLECER SISTEMA', reason: 'Prueba de permisos reservados.', password: 'Contraseña-de-prueba-123' }) });
    assert.equal(escalatedReset.status, 403);
    accessForReset.users[0].role = 'developer';
    assert.equal((await fetch(`${base}/api/state/nexo-access-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: accessForReset }) })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); await server.closeDatabase(); }
});
