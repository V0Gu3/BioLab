const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createApp, parseDofUsdIndicator, dofUsdHistoryUrl, dofPublicationMetadata, enforceActivatedOrderLock, enforceRequiredQuotationLock, assertDocumentHistoryStable } = require('../server/server');
const { createTestDatabase } = require('./helpers/postgres');
const { saveState } = require('../server/db');

test('identifica el USD y la fecha publicados por el Diario Oficial', () => {
  const result = parseDofUsdIndicator('<section>Tipo de Cambio y Tasas al 15/10/2026 <span class="texto">DOLAR</span> <br /> 18.4888</section>');
  assert.deepEqual(result, { usd: 18.4888, rateDate: '2026-10-15' });
});

test('identifica el último USD publicado en el historial del Diario Oficial', () => {
  const result = parseDofUsdIndicator('<td>DOLAR</td><tr><td>05-11-2026</td><td>18.628500</td></tr><tr><td>06-11-2026</td><td>18.714700</td></tr>');
  assert.deepEqual(result, { usd: 18.7147, rateDate: '2026-11-06' });
  assert.match(dofUsdHistoryUrl(new Date('2026-11-07T18:00:00Z')), /cod_tipo_indicador=158/);
  assert.deepEqual(dofPublicationMetadata(result.rateDate, new Date('2026-11-07T18:00:00Z')), {
    publicationId: 'DOF-USD-2026-11-06', publicationStatus: 'latest_official_published', publicationLabel: 'Último valor oficial publicado · 2026-11-06', operationalDate: '2026-11-07', isPreviousPublication: true
  });
});

test('Vercel dirige el tablero ejecutivo a una función existente', () => {
  const config = JSON.parse(fs.readFileSync(require.resolve('../vercel.json'), 'utf8'));
  const faviconRewrite = config.rewrites.find((item) => item.source === '/favicon.ico');
  const rewrite = config.rewrites.find((item) => item.source === '/api/dashboard/executive');
  assert.equal(faviconRewrite?.destination, '/assets/probiolab-logo-transparent.png');
  assert.equal(rewrite?.destination, '/api/internal-orders-handler?__forward_path=dashboard/executive');
});

test('un estado obsoleto no puede regresar un pedido activo a borrador', () => {
  const active = { id: 'PI-261102-0002', status: 'active', activatedAtISO: '2026-11-02T22:13:55.025Z' };
  assert.doesNotThrow(() => enforceActivatedOrderLock({ 'nexo-commercial-orders': [active] }, [active]));
  assert.throws(() => enforceActivatedOrderLock({ 'nexo-commercial-orders': [active] }, [{ ...active, status: 'draft', activatedAtISO: null }]), error => error.status === 409 && /ya fue activado/.test(error.message));
  assert.throws(() => enforceActivatedOrderLock({ 'nexo-commercial-orders': [active] }, []), error => error.status === 409);
});

test('la identidad del vendedor se completa sin desbloquear documentos comerciales', () => {
  const active = { id: 'PI-261102-0002', status: 'active', total: 1200, ownerId: '', ownerName: '' };
  assert.doesNotThrow(() => enforceActivatedOrderLock({ 'nexo-commercial-orders': [active] }, [{ ...active, ownerId: 'USR-10', ownerName: 'Ana', ownerSellerNumber: 'V-010' }]));
  assert.throws(() => enforceActivatedOrderLock({ 'nexo-commercial-orders': [active] }, [{ ...active, total: 1 }]), error => error.status === 409);
  const required = { id: 'COT-261102-0002', status: 'required', locked: true, total: 1200, ownerId: '' };
  assert.doesNotThrow(() => enforceRequiredQuotationLock({ 'nexo-sales-quotations': [required] }, [{ ...required, ownerId: 'USR-10', ownerName: 'Ana', ownerSellerNumber: 'V-010' }]));
  assert.throws(() => enforceRequiredQuotationLock({ 'nexo-sales-quotations': [required] }, [{ ...required, total: 1 }]), error => error.status === 409);
});

test('remisiones y órdenes históricas conservan folio, relación y fecha', () => {
  const current = {
    shipments: [{ id: 'DEL-1', folio: 'REM-261108-0003', requisitionId: 'PI-1', date: '2026-11-08' }],
    supplierOrders: [{ id: 'OCP-261106-0001', createdAt: '2026-11-06', status: 'confirmed' }]
  };
  assert.doesNotThrow(() => assertDocumentHistoryStable(current, structuredClone(current)));
  assert.throws(() => assertDocumentHistoryStable(current, { ...structuredClone(current), shipments: [] }), error => error.status === 409 && /no puede desaparecer/.test(error.message));
  assert.throws(() => assertDocumentHistoryStable(current, { ...structuredClone(current), shipments: [{ ...current.shipments[0], date: '2026-11-09' }] }), error => error.status === 409 && /fecha original/.test(error.message));
  assert.throws(() => assertDocumentHistoryStable(current, { ...structuredClone(current), supplierOrders: [{ ...current.supplierOrders[0], createdAt: '2026-11-09' }] }), error => error.status === 409);
  const legacy = { shipments: [{ ...current.shipments[0], date: '2026-11-09' }], supplierOrders: [{ ...current.supplierOrders[0], createdAt: '2026-11-09' }] };
  assert.doesNotThrow(() => assertDocumentHistoryStable(legacy, current));
  const evidencedRepair = { ...structuredClone(current), shipments: [{ ...current.shipments[0], folio: 'REM-261106-0001', date: '2026-11-06', identityReconciliation: { originalFolio: 'REM-261108-0003', source: 'audit_and_inventory_movement' } }] };
  assert.doesNotThrow(() => assertDocumentHistoryStable(current, evidencedRepair));
  assert.throws(() => assertDocumentHistoryStable({ shipments: [], supplierOrders: [] }, { shipments: [{ id: 'DEL-2', folio: 'REM-261108-0004', requisitionId: 'PI-1', date: '2026-11-09' }], supplierOrders: [] }), error => error.status === 400);
});

test('expone la API REST sobre PostgreSQL', async () => {
  const db = await createTestDatabase(), bootstrapToken = 'bootstrap-test-token', server = await createApp({ db, bootstrapToken, deltaBootstrapRoles: 'administrator,developer,supervisor,seller,auditor' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`).then(response => response.json()); assert.equal(health.ok, true); assert.equal(health.database, 'PostgreSQL');
    const anonymousSession = await fetch(`${base}/api/auth/me`);
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json()).authenticated, false);
    const anonymousHome = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(anonymousHome.status, 302); assert.equal(anonymousHome.headers.get('location'), '/login.html');
    assert.match(await (await fetch(`${base}/login.html`)).text(), /ACCESO RESTRINGIDO|auth\.js/);
    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 200); assert.equal(favicon.headers.get('content-type'), 'image/png');
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
    const firstBootstrap = await fetch(`${base}/api/bootstrap`, { headers });
    const bootstrapEtag = firstBootstrap.headers.get('etag');
    assert.equal(firstBootstrap.status, 200); assert.ok(bootstrapEtag);
    assert.match(firstBootstrap.headers.get('cache-control'), /private, no-cache/);
    assert.ok(Number(firstBootstrap.headers.get('x-bio-payload-bytes')) > 0);
    const firstPayload = await firstBootstrap.json(); assert.equal(firstPayload.partial, false); assert.ok(firstPayload.revisions['nexo-products']);
    const cachedBootstrap = await fetch(`${base}/api/bootstrap`, { headers: { ...headers, 'If-None-Match': bootstrapEtag } });
    assert.equal(cachedBootstrap.status, 304); assert.equal(cachedBootstrap.headers.get('x-bio-payload-bytes'), '0');
    const egressDiagnostics = await fetch(`${base}/api/system/egress-diagnostics`, { headers }).then(response => response.json());
    assert.equal(egressDiagnostics.ok, true); assert.ok(egressDiagnostics.data.operational.bytes > 0); assert.ok(egressDiagnostics.data.operational.blocks.some(block => block.key === 'nexo-products'));
    const products = await fetch(`${base}/api/products`, { headers }).then(response => response.json()); assert.equal(products.count, 1); assert.equal(products.data[0].name, 'Producto API');
    const executiveDashboard = await fetch(`${base}/api/dashboard/executive`, { headers }).then(response => response.json());
    assert.equal(executiveDashboard.ok, true); assert.equal(executiveDashboard.data.inventory.references, 1);
    assert.equal((await fetch(`${base}/api/alerts`, { headers })).status, 200);
    const update = await fetch(`${base}/api/state/nexo-products`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 1, sku: 'BIO-1', name: 'Producto actualizado', price: 15 }] }) }).then(response => response.json());
    assert.equal(update.revision.revision, 2);
    const deltaBootstrap = await fetch(`${base}/api/bootstrap`, { headers: { ...headers, 'If-None-Match': bootstrapEtag, 'X-Bio-State-Revisions': JSON.stringify(firstPayload.revisions), 'X-Bio-State-Keys': JSON.stringify(firstPayload.readableKeys) } }).then(response => response.json());
    assert.equal(deltaBootstrap.partial, true); assert.deepEqual(Object.keys(deltaBootstrap.state), ['nexo-products']); assert.equal(deltaBootstrap.state['nexo-products'][0].price, 15);
    const batchUpdate = await fetch(`${base}/api/state-batch`, { method: 'PUT', headers, body: JSON.stringify({ state: { 'nexo-products': [{ id: 1, sku: 'BIO-1', name: 'Producto por lote', price: 18 }], 'nexo-product-supplier-relations': [] } }) });
    const batchPayload = await batchUpdate.json();
    assert.equal(batchUpdate.status, 200); assert.ok(batchPayload.revisions['nexo-products']); assert.ok(batchPayload.revisions['nexo-product-supplier-relations']);
    assert.equal((await fetch(`${base}/api/products`, { headers }).then(response => response.json())).data[0].price, 18);
    const trainingHeaders = { ...headers, 'X-Bio-Workspace': 'training' }, firstTrainingResponse = await fetch(`${base}/api/bootstrap`, { headers: trainingHeaders }), firstTrainingEtag = firstTrainingResponse.headers.get('etag'), firstTraining = await firstTrainingResponse.json();
    assert.equal(firstTraining.partial, false); assert.ok(firstTraining.revisions['nexo-access-v1']);
    assert.equal((await fetch(`${base}/api/state/nexo-products`, { method: 'PUT', headers: trainingHeaders, body: JSON.stringify({ payload: [{ id: 'QA-1', sku: 'QA-1', name: 'Producto capacitación', price: 20 }] }) })).status, 200);
    const trainingDelta = await fetch(`${base}/api/bootstrap`, { headers: { ...trainingHeaders, 'If-None-Match': firstTrainingEtag, 'X-Bio-State-Revisions': JSON.stringify(firstTraining.revisions), 'X-Bio-State-Keys': JSON.stringify(firstTraining.readableKeys) } }).then(response => response.json());
    assert.equal(trainingDelta.partial, true); assert.deepEqual(Object.keys(trainingDelta.state), ['nexo-products']); assert.equal(trainingDelta.state['nexo-products'][0].id, 'QA-1');
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-products'][0].price, 18);
    const accessState = (await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json())).state['nexo-access-v1'];
    accessState.users.push({ id: 'USR-005', name: 'Nuevo usuario', email: 'nuevo@probiolab.test', role: 'seller', status: 'active' }, { id: 'USR-006', name: 'Auditor', email: 'auditor@probiolab.test', role: 'auditor', status: 'active' }, { id: 'USR-007', name: 'Recepción limitada', email: 'recepcion@probiolab.test', role: 'supervisor', permissionDenials: ['supplier_order_manage', 'deliver', 'cancel'], status: 'active' });
    const savedUser = await fetch(`${base}/api/state/nexo-access-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: accessState }) });
    assert.equal(savedUser.status, 200);
    const password = await fetch(`${base}/api/auth/users/USR-005/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'Contraseña-nueva-123' }) });
    assert.equal(password.status, 200);
    assert.equal((await fetch(`${base}/api/auth/users/USR-006/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'Contraseña-auditor-123' }) })).status, 200);
    assert.equal((await fetch(`${base}/api/auth/users/USR-007/password`, { method: 'POST', headers, body: JSON.stringify({ password: 'Contraseña-recepcion-123' }) })).status, 200);
    assert.equal((await fetch(`${base}/api/state/nexo-fx-v1`, { method: 'PUT', headers, body: JSON.stringify({ payload: { records: [], audit: [], banxicoToken: 'token-interno-de-prueba' } }) })).status, 200);
    const clientPortfolio = [
      { id: 'CLI-ADMIN', name: 'Cartera administración', ownerId: 'USR-001', ownerName: 'Administrador' },
      { id: 'CLI-SELLER', name: 'Cartera vendedor', ownerId: 'USR-005', ownerName: 'Nuevo usuario' }
    ];
    assert.equal((await fetch(`${base}/api/state/nexo-clients`, { method: 'PUT', headers, body: JSON.stringify({ payload: clientPortfolio }) })).status, 200);
    assert.equal((await fetch(`${base}/api/state/nexo-sales-quotations`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 'COT-BLOCKED', client: 'Cartera administración' }] }) })).status, 409);
    // El histórico sigue visible aunque su responsable anterior sea administrador.
    await saveState(db, 'nexo-sales-quotations', [{ id: 'COT-ADMIN', client: 'Cartera administración', ownerId: 'USR-001' }]);
    const pendingTrainingClient={id:'CLI-PENDING',name:'Cliente pendiente',rfc:''};
    assert.equal((await fetch(`${base}/api/state/nexo-clients`,{method:'PUT',headers:trainingHeaders,body:JSON.stringify({payload:[pendingTrainingClient]})})).status,200);
    const newTrainingQuote={id:'COT-TRAINING',clientId:pendingTrainingClient.id,client:pendingTrainingClient.name};
    assert.equal((await fetch(`${base}/api/state/nexo-sales-quotations`,{method:'PUT',headers:trainingHeaders,body:JSON.stringify({payload:[newTrainingQuote]})})).status,409);
    assert.equal((await fetch(`${base}/api/state-batch`,{method:'PUT',headers:trainingHeaders,body:JSON.stringify({state:{'nexo-clients':[{...pendingTrainingClient,ownerId:'USR-005'}],'nexo-sales-quotations':[newTrainingQuote]}})})).status,200);
    assert.equal((await fetch(`${base}/api/state/nexo-sales-quotations`, { method: 'PUT', headers, body: JSON.stringify({ payload: [{ id: 'COT-ADMIN', client: 'Cartera administración', ownerId: 'USR-001' }, { id: 'COT-SELLER', client: 'Cartera vendedor', ownerId: 'USR-005' }] }) })).status, 200);
    const receiverLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'recepcion@probiolab.test', password: 'Contraseña-recepcion-123' }) });
    const receiverHeaders = { Cookie: receiverLogin.headers.get('set-cookie'), 'Content-Type': 'application/json' }, receiverBootstrapResponse = await fetch(`${base}/api/bootstrap`, { headers: receiverHeaders }), receiverBootstrapEtag = receiverBootstrapResponse.headers.get('etag'), receiverBootstrap = await receiverBootstrapResponse.json();
    assert.equal(receiverLogin.status, 200);
    assert.ok(receiverBootstrap.allowedKeys.includes('nexo-order-operations-v1'));
    const receiptOperation = { ...receiverBootstrap.state['nexo-order-operations-v1'], receipts: [{ id: 'REC-PERM-1', reference: 'REM-PERM-1' }] };
    assert.equal((await fetch(`${base}/api/state/nexo-order-operations-v1`, { method: 'PUT', headers: receiverHeaders, body: JSON.stringify({ payload: receiptOperation }) })).status, 200);
    const receiverDelta = await fetch(`${base}/api/bootstrap`, { headers: { ...receiverHeaders, 'If-None-Match': receiverBootstrapEtag, 'X-Bio-State-Revisions': JSON.stringify(receiverBootstrap.revisions), 'X-Bio-State-Keys': JSON.stringify(receiverBootstrap.readableKeys) } }).then(response => response.json());
    assert.equal(receiverDelta.partial, true); assert.deepEqual(Object.keys(receiverDelta.state), ['nexo-order-operations-v1']); assert.equal(receiverDelta.state['nexo-order-operations-v1'].receipts[0].id, 'REC-PERM-1');
    const deniedDelivery = { ...receiptOperation, shipments: [{ id: 'REM-PERM-1', folio: 'REM-PERM-1' }] };
    assert.equal((await fetch(`${base}/api/state/nexo-order-operations-v1`, { method: 'PUT', headers: receiverHeaders, body: JSON.stringify({ payload: deniedDelivery }) })).status, 403);
    const deniedCancellation = { ...receiptOperation, orderLines: [{ id: 'LINE-PERM-1', quantityCancelled: 1 }], auditLog: [{ id: 'AUD-PERM-1', action: 'cancel' }] };
    assert.equal((await fetch(`${base}/api/state/nexo-order-operations-v1`, { method: 'PUT', headers: receiverHeaders, body: JSON.stringify({ payload: deniedCancellation }) })).status, 403);
    const sellerLoginResponse = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nuevo@probiolab.test', password: 'Contraseña-nueva-123' }) }), newUserLogin = await sellerLoginResponse.json(), sellerHeaders = { Cookie: sellerLoginResponse.headers.get('set-cookie') };
    assert.equal(newUserLogin.ok, true);
    assert.equal(newUserLogin.user.email, 'nuevo@probiolab.test');
    const sellerBootstrapResponse = await fetch(`${base}/api/bootstrap`, { headers: sellerHeaders }), sellerBootstrapEtag = sellerBootstrapResponse.headers.get('etag'), sellerBootstrap = await sellerBootstrapResponse.json();
    assert.deepEqual(sellerBootstrap.allowedKeys.sort(), ['nexo-clients', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-sales-quotations'].sort());
    assert.deepEqual(sellerBootstrap.state['nexo-clients'].map(client => client.id), ['CLI-SELLER']);
    assert.deepEqual(sellerBootstrap.state['nexo-sales-quotations'].map(quotation => quotation.id), ['COT-ADMIN', 'COT-SELLER']);
    assert.deepEqual(sellerBootstrap.state['nexo-access-v1'].users.map(user => user.id), ['USR-005']);
    assert.deepEqual(sellerBootstrap.state['nexo-movements'], []);
    assert.equal((await fetch(`${base}/api/movements`, { headers: sellerHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/audit`, { headers: sellerHeaders })).status, 403);
    const auditorLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auditor@probiolab.test', password: 'Contraseña-auditor-123' }) });
    const auditorHeaders = { Cookie: auditorLogin.headers.get('set-cookie') }, auditorBootstrapResponse = await fetch(`${base}/api/bootstrap`, { headers: auditorHeaders }), auditorBootstrapEtag = auditorBootstrapResponse.headers.get('etag'), auditorBootstrap = await auditorBootstrapResponse.json();
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
    const sellerDelta = await fetch(`${base}/api/bootstrap`, { headers: { ...sellerHeaders, 'If-None-Match': sellerBootstrapEtag, 'X-Bio-State-Revisions': JSON.stringify(sellerBootstrap.revisions), 'X-Bio-State-Keys': JSON.stringify(sellerBootstrap.readableKeys) } }).then(response => response.json());
    assert.equal(sellerDelta.partial, true); assert.deepEqual(Object.keys(sellerDelta.state), ['nexo-clients']); assert.deepEqual(sellerDelta.state['nexo-clients'].map(client => client.id), ['CLI-SELLER']);
    const adminPortfolio = await fetch(`${base}/api/bootstrap`, { headers }).then(response => response.json());
    assert.equal(adminPortfolio.state['nexo-clients'].find(client => client.id === 'CLI-ADMIN').name, 'Cartera administración');
    const sellerClient = adminPortfolio.state['nexo-clients'].find(client => client.id === 'CLI-SELLER');
    assert.equal(sellerClient.name, 'Cartera vendedor actualizada');
    assert.equal(sellerClient.ownerId, 'USR-005');
    const deletedUser = await fetch(`${base}/api/auth/users/USR-005`, { method: 'DELETE', headers, body: JSON.stringify({ reason: 'Baja de prueba automatizada.' }) });
    assert.equal(deletedUser.status, 200);
    const auditorDelta = await fetch(`${base}/api/bootstrap`, { headers: { ...auditorHeaders, 'If-None-Match': auditorBootstrapEtag, 'X-Bio-State-Revisions': JSON.stringify(auditorBootstrap.revisions), 'X-Bio-State-Keys': JSON.stringify(auditorBootstrap.readableKeys) } }).then(response => response.json());
    assert.equal(auditorDelta.partial, true); assert.deepEqual(Object.keys(auditorDelta.state), ['nexo-access-v1']); assert.deepEqual(auditorDelta.state['nexo-access-v1'].users.map(user => user.id), ['USR-006']);
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
