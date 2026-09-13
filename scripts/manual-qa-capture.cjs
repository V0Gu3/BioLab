const fs = require('node:fs/promises');
const path = require('node:path');
const MODULES = process.env.PROBIOLAB_NODE_MODULES;
if (!MODULES) throw new Error('Falta PROBIOLAB_NODE_MODULES con la ruta de dependencias del espacio de trabajo.');
const { chromium } = require(path.join(MODULES, 'playwright'));
const sharp = require(path.join(MODULES, 'sharp'));

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'manual-probiolab');
const CAPTURES = path.join(OUT, 'capturas');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const results = [];
const consoleErrors = [];

function record(id, status, detail) {
  results.push({ id, status, detail });
}

async function ensure(condition, id, detail) {
  if (!condition) throw new Error(`${id}: ${detail}`);
  record(id, 'Aprobada', detail);
}

async function annotatedCapture(page, filename, selectors = []) {
  await page.mouse.move(1400, 20);
  const image = await page.screenshot({ type: 'png', animations: 'disabled' });
  const overlays = [];
  for (let index = 0; index < selectors.length; index += 1) {
    const locator = page.locator(selectors[index]).first();
    if (!await locator.count() || !await locator.isVisible()) continue;
    const box = await locator.boundingBox();
    if (!box) continue;
    const x = Math.max(18, Math.min(1420, box.x + 18));
    const y = Math.max(18, Math.min(980, box.y + 18));
    const label = index + 1;
    const svg = `<svg width="1440" height="1000" xmlns="http://www.w3.org/2000/svg"><circle cx="${x}" cy="${y}" r="15" fill="#b9fa81" stroke="#17221d" stroke-width="2"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-family="Arial" font-size="14" font-weight="700" fill="#17221d">${label}</text></svg>`;
    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
  }
  const target = path.join(CAPTURES, filename);
  await sharp(image).composite(overlays).png({ compressionLevel: 9 }).toFile(target);
  return target;
}

async function closeDialogs(page) {
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

async function openView(page, view, expectedHeading) {
  await closeDialogs(page);
  const trigger = page.locator(`[data-view="${view}"]`).first();
  await ensure(await trigger.count() > 0, `NAV-${view}`, `Existe un acceso para ${view}`);
  await trigger.evaluate(element => element.click());
  const target = page.locator(`#${view}`);
  await target.waitFor({ state: 'visible' });
  const heading = (await target.locator('h1').first().innerText()).trim();
  await ensure(heading.includes(expectedHeading), `VIEW-${view}`, `La vista muestra el encabezado ${heading}`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function seedQaScenarios(page) {
  await page.evaluate(() => {
    const key = 'nexo-order-operations-v1';
    const store = JSON.parse(localStorage.getItem(key));
    const add = (collection, item) => { if (!store[collection].some(existing => existing.id === item.id)) store[collection].unshift(item); };
    const today = new Date().toISOString().slice(0, 10);
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    add('requisitions', { id: 'QA-REC-001', type: 'customer_order', requestDate: today, customerName: 'Clínica de Pruebas Norte', contactName: 'María Demo', customerReference: 'OC-QA-REC-001', clientOrderId: 'OC-QA-REC-001', clientOrderStatus: 'active', currency: 'MXN', status: 'partially_received', observations: 'Caso aislado para recepción parcial y tratamiento de faltante.', responsible: 'Usuario Supervisor', createdAt: `${today}T09:00:00-06:00`, updatedAt: `${today}T12:00:00-06:00` });
    add('orderLines', { id: 'QA-LINE-REC-001', requisitionId: 'QA-REC-001', productId: 1, catalog: '100001', brandName: 'Café Origen', description: 'Reactivo control para recepción parcial', quantityRequested: 10, quantityPurchased: 10, quantityReceived: 4, quantityAvailableReceived: 4, quantityDelivered: 0, quantityCancelled: 0, quantityInvoiced: 0, unitPrice: 850, currency: 'MXN', total: 8500, supplyOrigin: 'supplier', supplierName: 'Café Origen', committedDate: past, status: 'partially_received' });
    add('supplierOrders', { id: 'OCP-QA-REC-001', supplierId: 'PRV-003', supplierName: 'Café Origen', clientOrderId: 'OC-QA-REC-001', createdAt: today, confirmedAt: today, currency: 'MXN', subtotal: 8500, total: 9860, status: 'partially_received', requisitionIds: ['QA-REC-001'], lineIds: ['QA-LINE-REC-001'], confirmedBy: 'Usuario Supervisor', locked: true, version: 1 });
    add('supplierOrderLines', { id: 'SOL-OCP-QA-REC-001-001', supplierOrderId: 'OCP-QA-REC-001', requisitionId: 'QA-REC-001', orderLineId: 'QA-LINE-REC-001', quantity: 10, unitPrice: 850, currency: 'MXN', allocationType: 'customer_order' });
    add('receipts', { id: 'REC-QA-001', supplierOrderId: 'OCP-QA-REC-001', requisitionId: 'QA-REC-001', date: today, items: [{ orderLineId: 'QA-LINE-REC-001', quantity: 4, quantityAccepted: 4, quantityRejected: 0, lot: 'QA-LOTE-01' }], type: 'partial', user: 'Usuario Supervisor', observations: 'Recepción parcial de prueba.', reference: 'REM-PROV-QA-001', warehouseId: '1', documentType: 'supplier_remission', qualityStatus: 'released', shortageResolution: 'same_order', shortageCommitment: today, evidence: [{ id: 'EVD-REC-QA-001', name: 'remision-proveedor-qa.pdf', type: 'application/pdf', hash: 'QA-RECEIPT-EVIDENCE' }] });
    add('auditLog', { id: 'AUD-QA-REC-001', entityType: 'order_line', entityId: 'QA-LINE-REC-001', action: 'partial_receipt_registered', eventKind: 'formal_operation', user: 'Usuario Supervisor', at: `${today}T12:00:00-06:00`, reference: 'REC-QA-001', notes: 'Faltante de 6 unidades; llegará posteriormente en la misma OC.', nextAction: 'Confirmar segundo embarque', commitmentDate: today, blockers: 'Pendiente de proveedor', responsible: 'Usuario Supervisor' });
    add('requisitions', { id: 'QA-DEL-001', type: 'customer_order', requestDate: today, customerName: 'Hospital de Pruebas Centro', contactName: 'Carlos Demo', customerReference: 'OC-QA-DEL-001', clientOrderId: 'OC-QA-DEL-001', clientOrderStatus: 'active', currency: 'MXN', status: 'partially_delivered', observations: 'Caso aislado para remisión parcial.', responsible: 'Usuario Supervisor', createdAt: `${today}T09:30:00-06:00`, updatedAt: `${today}T15:00:00-06:00` });
    add('orderLines', { id: 'QA-LINE-DEL-001', requisitionId: 'QA-DEL-001', productId: 1, catalog: '100001', brandName: 'Café Origen', description: 'Reactivo control para entrega parcial', quantityRequested: 5, quantityPurchased: 5, quantityReceived: 5, quantityAvailableReceived: 3, quantityDelivered: 2, quantityCancelled: 0, quantityInvoiced: 0, unitPrice: 900, currency: 'MXN', total: 4500, supplyOrigin: 'supplier', supplierName: 'Café Origen', committedDate: today, status: 'partially_delivered' });
    add('shipments', { id: 'REM-QA-001', folio: 'REM-QA-001', date: today, requisitionId: 'QA-DEL-001', items: [{ orderLineId: 'QA-LINE-DEL-001', quantity: 2 }], deliveredAt: `${today}T15:00:00-06:00`, type: 'partial', status: 'delivered', recipient: 'Carlos Demo', evidence: [{ id: 'EVD-REM-QA-001', name: 'remision-parcial-qa.pdf', type: 'application/pdf', hash: 'QA-DELIVERY-EVIDENCE' }], observations: 'Primera entrega parcial de prueba.' });
    add('inventoryMovements', { id: 'INV-OUT-QA-001', requisitionId: 'QA-DEL-001', orderLineId: 'QA-LINE-DEL-001', warehouseId: '1', productId: 1, catalog: '100001', type: 'exit', quantity: 2, reason: 'Salida contra remisión', sourceDocumentType: 'shipment', sourceDocumentId: 'REM-QA-001', user: 'Usuario Supervisor', at: `${today}T15:00:00-06:00`, reconciliationStatus: 'matched' });
    add('auditLog', { id: 'AUD-QA-DEL-001', entityType: 'order_line', entityId: 'QA-LINE-DEL-001', action: 'delivery_registered', eventKind: 'formal_operation', user: 'Usuario Supervisor', at: `${today}T15:00:00-06:00`, reference: 'REM-QA-001', notes: 'Entrega parcial con evidencia.', nextAction: 'Programar entrega restante', commitmentDate: today, responsible: 'Usuario Supervisor' });
    localStorage.setItem(key, JSON.stringify(store));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panel');
}

(async () => {
  await fs.mkdir(CAPTURES, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'es-MX' });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panel');
  await seedQaScenarios(page);

  const views = [
    ['panel', 'Todo está bajo control', '01-resumen-general.png', ['#dashboardPeriod', '#quotationTotalCount', '#orderMetricTotal']],
    ['quotationSummaryView', 'Cotizaciones', '02-resumen-cotizaciones.png', ['#quotationSummaryActive', '#quotationSummaryRecent']],
    ['cotizacionesView', 'Seguimiento comercial', '03-panel-cotizaciones.png', ['#quotationSearch', '#quotationStatusFilter', '#quotationHistory']],
    ['newQuotationView', 'Nueva cotización', '04-nueva-cotizacion.png', ['#quotationClient', '#quotationWorkspace', '#quotationDraft']],
    ['salesOrdersView', 'Órdenes de compra de clientes', '05-oc-clientes.png', ['#commercialOrderSearch', '#commercialOrderStatusFilter', '#commercialOrderList']],
    ['supplierOrdersView', 'Propuestas y OC a proveedores', '06-oc-proveedores.png', ['#supplierOrderSearch', '#supplierOrderStatusFilter', '#supplierOrderList']],
    ['warehouseSummaryView', 'Almacén', '07-resumen-almacen.png', ['#warehouseSummaryTotal', '#warehouseSummaryAlerts']],
    ['inventarioView', 'Inventario', '08-inventario.png', ['#inventorySearch', '#inventoryWarehouseFilter', '#inventoryBody']],
    ['movimientosView', 'Movimientos', '09-movimientos.png', ['#movementDateFilter', '#movementTypeFilter', '#movementHistory']],
    ['conteosView', 'Conteos físicos', '10-conteos.png', ['#countDate', '#countWarehouse', '#countBody']],
    ['trackingSummaryView', 'Seguimiento y remisiones', '11-resumen-seguimiento.png', ['#trackingSummaryOpen', '#trackingSummaryLate']],
    ['ordersView', 'Seguimiento de pedidos', '12-seguimiento-pedidos.png', ['#orderSearch', '#orderStatusFilter', '#orderTrackingList']],
    ['deliveriesView', 'Entregas y remisiones', '13-entregas-remisiones.png', ['#deliverySearch', '#deliveryStatusFilter', '#deliveryTrackingList']],
    ['productSummaryView', 'Productos', '14-resumen-productos.png', ['#productSummaryTotal', '#productSummaryAttention']],
    ['productosView', 'Productos', '15-catalogo-productos.png', ['#productSearch', '#productGrid']],
    ['proveedoresView', 'Proveedores', '16-proveedores.png', ['#supplierSearch', '#supplierList']],
    ['preciosView', 'Carga masiva de precios', '17-listas-precios.png', ['#priceSupplier', '#priceFile', '#priceLoadHistory']],
    ['clientesView', 'Clientes', '18-clientes.png', ['#clientSearch', '#clientList']],
    ['reportesView', 'Reportes', '19-reportes.png', ['.report-list']],
    ['auditView', 'Auditoría', '20-auditoria.png', ['#auditSearch', '#auditCategory', '#auditList']],
    ['settingsView', 'Centro de configuración', '21-configuracion.png', ['.settings-section-nav', '[data-settings-panel="overview"]']],
    ['sandboxView', 'Área de pruebas', '22-area-pruebas.png', ['#sandboxFlow', '#sandboxNext', '#sandboxHistory']]
  ];

  for (const [view, heading, filename, selectors] of views) {
    await openView(page, view, heading);
    await annotatedCapture(page, filename, selectors);
  }

  await page.locator('#openHelpCenter').click();
  await ensure(await page.locator('#sandboxView').isVisible(), 'HELP-SANDBOX', 'El botón de ayuda abre la simulación guiada');
  const beforeOperational = await page.evaluate(() => localStorage.getItem('nexo-order-operations-v1'));
  for (let index = 0; index < 6; index += 1) await page.locator('#sandboxNext').click();
  await ensure((await page.locator('#sandboxStepMetric').innerText()).includes('6 / 6'), 'SANDBOX-FLOW', 'La simulación completa los seis pasos');
  const afterOperational = await page.evaluate(() => localStorage.getItem('nexo-order-operations-v1'));
  await ensure(beforeOperational === afterOperational, 'SANDBOX-ISOLATION', 'El flujo TEST no modifica el expediente operativo');
  await annotatedCapture(page, '23-area-pruebas-completada.png', ['#sandboxStepMetric', '#sandboxDocumentMetric', '#sandboxHistory']);

  await openView(page, 'ordersView', 'Seguimiento de pedidos');
  await page.locator('[data-order-detail="QA-REC-001"]').first().click();
  await page.locator('#orderDetailDialog').waitFor({ state: 'visible' });
  await annotatedCapture(page, '24-expediente-resumen-partidas.png', ['.dossier-kpis', '.dossier-tabs', '.dossier-line-list']);
  for (const [tabName, file, selectors] of [
    ['commercial', '25-expediente-comercial.png', ['.dossier-grid', '.dossier-line-list']],
    ['purchases', '26-expediente-compras.png', ['.dossier-record']],
    ['receipts', '27-expediente-recepciones.png', ['.dossier-record', '.dossier-subsection']],
    ['timeline', '28-expediente-linea-tiempo.png', ['.dossier-timeline']]
  ]) {
    await page.locator(`[data-dossier-tab="${tabName}"]`).click();
    await page.locator('#orderDetailDialog').waitFor({ state: 'visible' });
    await annotatedCapture(page, file, selectors);
  }

  await page.locator('[data-dossier-tab="summary"]').click();
  await page.locator('[data-order-progress="QA-LINE-REC-001"]').click();
  await ensure(await page.locator('#orderProgressDialog').isVisible(), 'TRACKING-MODAL', 'La partida abre Registrar avance');
  await ensure((await page.locator('#orderProgressForm').getAttribute('data-mode')) === 'tracking', 'TRACKING-SEPARATION', 'Registrar avance opera en modo de seguimiento');
  await annotatedCapture(page, '29-registrar-avance.png', ['#orderProgressContext', '#orderProgressType', '#orderProgressNextAction', '#orderProgressCommitmentDate', '#orderProgressEvidence']);
  await page.locator('[data-close-order-dialog="orderProgressDialog"]').first().click();

  await page.locator('[data-order-detail="QA-REC-001"]').first().click();
  await page.locator('[data-formal-progress="receipt"]').click();
  await page.locator('#orderProgressQuantity').fill('3');
  await ensure(await page.locator('#receiptShortageField').isVisible(), 'SHORTAGE-DECISION', 'Una recepción menor al faltante exige tratamiento del saldo');
  await ensure(await page.locator('#receiptShortageResolution option').count() === 8, 'SHORTAGE-OPTIONS', 'El sistema muestra siete alternativas y la opción inicial');
  await annotatedCapture(page, '30-recepcion-parcial-faltante.png', ['#orderProgressQuantity', '#receiptEvidence', '#receiptShortageField']);
  await page.locator('#orderProgressReference').fill('REM-PROV-QA-002');
  await page.locator('#receiptShortageResolution').selectOption('same_order');
  await page.locator('#receiptShortageCommitment').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#receiptShortageNotes').fill('Proveedor confirma el segundo embarque; responsable Usuario Supervisor.');
  await page.locator('#receiptEvidence').setInputFiles(path.join(ROOT, 'assets', 'probiolab-logo.png'));
  await page.locator('#orderProgressForm .submit').click();
  await page.locator('#orderDetailDialog').waitFor({ state: 'visible' });
  const receivedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('nexo-order-operations-v1')).orderLines.find(line => line.id === 'QA-LINE-REC-001').quantityReceived);
  await ensure(receivedAfter === 7, 'RECEIPT-PARTIAL-SAVED', 'La recepción parcial actualiza sólo las tres unidades aceptadas');
  await ensure(await page.locator('.dossier-operation-notice').isVisible(), 'RECEIPT-CONFIRMATION', 'La interfaz confirma la operación formal y vuelve al expediente');
  await closeDialogs(page);

  await openView(page, 'ordersView', 'Seguimiento de pedidos');
  await page.locator('[data-order-detail="QA-DEL-001"]').first().click();
  await page.locator('[data-formal-progress="delivery"]').click();
  await page.locator('#orderProgressQuantity').fill('1');
  await ensure(await page.locator('#deliveryExtraFields').isVisible(), 'DELIVERY-EVIDENCE', 'La remisión formal exige receptor y evidencia');
  await annotatedCapture(page, '31-generar-remision.png', ['#orderProgressReference', '#orderProgressQuantity', '#deliveryRecipient', '#deliveryEvidence']);
  await page.locator('#deliveryRecipient').fill('Carlos Demo');
  await page.locator('#deliveryScheduledAt').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#deliveryEvidence').setInputFiles(path.join(ROOT, 'assets', 'probiolab-logo.png'));
  await page.locator('#orderProgressForm .submit').click();
  await page.locator('#orderDetailDialog').waitFor({ state: 'visible' });
  const deliveredAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('nexo-order-operations-v1')).orderLines.find(line => line.id === 'QA-LINE-DEL-001').quantityDelivered);
  await ensure(deliveredAfter === 3, 'DELIVERY-PARTIAL-SAVED', 'La remisión parcial descuenta y entrega sólo una unidad adicional');
  await ensure(await page.locator('.dossier-operation-notice').isVisible(), 'DELIVERY-CONFIRMATION', 'La interfaz confirma la remisión y vuelve al expediente');
  await closeDialogs(page);

  await openView(page, 'settingsView', 'Centro de configuración');
  await page.locator('[data-settings-section="permissions"]').click();
  await annotatedCapture(page, '32-perfiles-permisos.png', ['#accessRoleCards', '#accessPermissionMatrix']);

  await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('nexo-access-v1')); state.currentUserId = 'USR-003'; localStorage.setItem('nexo-access-v1', JSON.stringify(state)); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensure(await page.locator('[data-access="audit"]').isHidden(), 'ROLE-SELLER-AUDIT', 'El vendedor no ve Auditoría');
  await ensure((await page.locator('#sidebarProfileRole').innerText()).includes('Vendedor'), 'ROLE-SELLER-SESSION', 'La sesión refleja el perfil Vendedor');
  await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('nexo-access-v1')); state.currentUserId = 'USR-001'; localStorage.setItem('nexo-access-v1', JSON.stringify(state)); });

  const filteredConsoleErrors = [...new Set(consoleErrors)].filter(message => !/favicon|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(message));
  if (filteredConsoleErrors.length) console.error(JSON.stringify(filteredConsoleErrors, null, 2));
  await ensure(filteredConsoleErrors.length === 0, 'BROWSER-CONSOLE', 'No se detectaron errores de ejecución en las rutas probadas');
  await fs.writeFile(path.join(OUT, 'resultados-qa-ui.json'), JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE, viewport: '1440x1000', results, consoleErrors: filteredConsoleErrors }, null, 2));
  await browser.close();
  process.stdout.write(`Capturas: ${await fs.readdir(CAPTURES).then(files => files.length)}\nPruebas UI: ${results.length}\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
