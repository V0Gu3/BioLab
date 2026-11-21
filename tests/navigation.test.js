const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('los submenús tienen un identificador y un estado expandido accesible', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  for (const group of ['quotations', 'internal-orders', 'inventory', 'orders']) {
    assert.match(html, new RegExp(`data-nav-group="${group}"`));
  }
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 4);
  for (const view of ['warehouseSummaryView', 'trackingSummaryView']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.match(html, /data-view="productosView"/);
  assert.match(html, /id="productSummaryView"/);
  assert.match(html, /data-view="deliveriesView"/);
  assert.match(html, /id="deliveriesView"/);
});

test('el área de pruebas tiene una ruta visible desde ayuda y el selector de espacio', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(html, /data-workspace-guide data-view="sandboxView"/);
  assert.match(app, /#openHelpCenter[^\n]+data-workspace-guide/);
});

test('las flechas contraen y expanden cada submenú y conservan la preferencia', () => {
  const js = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const css = fs.readFileSync(require.resolve('../modal-theme.css'), 'utf8');
  assert.match(js, /NAV_GROUPS_STORAGE_KEY='nexo-nav-groups-v1'/);
  assert.match(js, /closest\('\.nav-chevron'\)/);
  assert.match(js, /querySelectorAll\('\[data-summary-view\]'\)/);
  assert.match(js, /\['ArrowLeft','ArrowRight'\]/);
  assert.match(js, /setNavGroupExpanded\(parentGroup,true\)/);
  assert.match(css, /\.nav-group\.collapsed > \.nav-submenu \{ display: none; \}/);
  assert.match(css, /\.nav-group\.expanded > \.nav-item \.nav-chevron \{ transform: rotate\(180deg\); \}/);
});

test('una recarga conserva la sección activa y la posición de lectura', () => {
  const js = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(js, /NAVIGATION_STATE_STORAGE_KEY='nexo-navigation-state-v1'/);
  assert.match(js, /saveNavigationState\(view,0\)/);
  assert.match(js, /history\.replaceState\(null,'',link\.hash\)/);
  assert.match(js, /window\.addEventListener\('pagehide'/);
  assert.match(js, /restoreNavigationState\(\)/);
  assert.match(js, /window\.scrollTo\(\{top:scrollY,behavior:'auto'\}\)/);
});

test('editar una cotización abre una revisión auditable y la conversión se identifica como pedido interno', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /function openQuotationForEditing\(quotation,reason\)/);
  assert.match(app, /Edición justificada:/);
  assert.match(app, /data-view="newQuotationView"/);
  assert.match(app, /Convertir en pedido interno/);
});

test('los filtros visibles actualizan resultados y los estados permiten profundizar', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  for (const id of ['inventoryStatusFilter', 'movementDateFilter', 'movementTypeFilter', 'quotationStatusFilter', 'orderStageFilter']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /inventoryStatusFilter'\)\.addEventListener\('change',renderInventoryTable\)/);
  assert.match(app, /\['movementDateFilter','movementTypeFilter'\]/);
  assert.match(app, /data-inventory-state/);
  assert.match(app, /applyQuotationStatusFilter/);
  for (const stage of ['purchase', 'receive', 'deliver', 'invoice']) assert.match(orders, new RegExp(`stageFilter === '${stage}'`));
});

test('seguimiento integral usa bandeja paginada y muestra una acción recomendada sin abrir el expediente', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  const styles = fs.readFileSync(require.resolve('../orders.css'), 'utf8');
  const settings = fs.readFileSync(require.resolve('../settings.js'), 'utf8');
  for (const id of ['orderTrackingResultCount', 'orderTrackingPageSize', 'orderTrackingPagination', 'orderTrackingQuickPanel']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(orders, /function trackingRecords\(\)/);
  assert.match(orders, /const trackingStage\s*=/);
  assert.match(orders, /function renderTrackingQuickPanel/);
  assert.match(orders, /openQuickReceipt/);
  assert.match(orders, /data-tracking-page/);
  assert.match(styles, /\.tracking-workbench/);
  assert.match(styles, /\.tracking-quick-panel/);
  assert.match(settings, /deliveriesView: 'deliver'/);
});

test('cotizaciones y OC de clientes separan los totales por moneda y comparten acciones comerciales', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const theme = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(app, /function portfolioTotals\(records=\[\]\)/);
  assert.match(app, /function currencyTotalsMarkup\(totals,field='total',className='currency-total-list'\)/);
  assert.match(app, /commercialOrderValue'\)\.innerHTML=currencyTotalsMarkup\(totals\)/);
  assert.match(app, /quotationValue'\)\.innerHTML=currencyTotalsMarkup\(portfolioTotals\(visible\)\)/);
  assert.match(app, /action-primary"[^>]*data-continue-commercial-order/);
  assert.match(app, /action-secondary"[^>]*data-download-commercial-order/);
  assert.match(html, /id="goToNewQuotation"/);
  assert.match(html, /class="primary-action" id="goToNewQuotation"/);
  assert.match(theme, /\.commercial-order-action\.action-primary/);
  assert.match(theme, /\.commercial-order-action\.action-secondary/);
});

test('los resúmenes y reportes navegan a la vista con el filtro correspondiente', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(app, /openFilteredView/);
  assert.match(app, /openInventoryAttention/);
  assert.match(app, /report==='Mermas y ajustes'/);
  assert.match(app, /makeMetricInteractive\('commercialOrderPending','salesOrdersView','commercialOrderStatusFilter','pending'\)/);
  assert.match(orders, /makeMetricInteractive\('orderMetricPurchase', 'ordersView', 'orderStageFilter', 'purchase'\)/);
  assert.match(orders, /makeMetricInteractive\('deliveryMetricPartial', 'deliveriesView', 'deliveryStatusFilter', 'partial'\)/);
  assert.match(orders, /makeMetricInteractive\('supplierOrderDraftCount', 'supplierOrdersView', 'supplierOrderStatusFilter', 'draft'\)/);
});

test('el expediente Bio concentra la cadena operativa sin duplicar sus registros', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  const styles = fs.readFileSync(require.resolve('../orders.css'), 'utf8');
  assert.match(html, /id="orderDetailDialog"/);
  assert.match(orders, /function dossierData\(request\)/);
  assert.match(orders, /supplierOrderLines\.filter/);
  assert.match(orders, /data-dossier-tab/);
  assert.match(orders, /nextAction: progressMeta\.nextAction/);
  assert.match(html, /Registrar avance documenta el seguimiento/);
  assert.match(styles, /\.dossier-tabs/);
  assert.match(styles, /\.dossier-timeline/);
});

test('cancelar un avance, recepción o remisión regresa al expediente de origen', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(html, /orders\.js\?v=/);
  assert.match(orders, /const rememberProgressOrigin/);
  assert.match(orders, /const restoreProgressOrigin/);
  assert.match(orders, /dialog\.dataset\.originRequestId/);
  assert.match(orders, /renderOrderDetail\(requestId, tab\)/);
  assert.match(orders, /rememberProgressOrigin\(\);q\('#orderDetailDialog'\)\.close\(\);openTotalReceiptProgress/);
  assert.match(orders, /q\('#orderProgressDialog'\)\.addEventListener\('cancel'.*restoreProgressOrigin/);
});

test('cancelar el selector de evidencia conserva abierto el modal de avance', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(orders, /progressFilePickerUntil/);
  assert.match(orders, /Date\.now\(\) < progressFilePickerUntil/);
});

test('la previsualización del expediente carga el generador PDF bajo demanda', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(orders, /async function downloadOrderAudit/);
  assert.match(orders, /const request = resolveOperationalRequest\(requestId\)/);
  assert.match(orders, /activeRequestId = request\.id; activeDossierTab = 'summary'; q\('#downloadOrderAudit'\)\.hidden = false/);
  assert.match(orders, /await window\.BioLibraries\?\.pdf\?\.\(\)/);
  assert.match(orders, /BioFlowDocs\.previewBlob\(doc\.output\('blob'\)/);
  assert.match(orders, /documentPreviewDialog'\)\?\.open/);
  assert.match(orders, /catch \(error\)[\s\S]*?No fue posible preparar el expediente/);
  assert.match(html, /id="downloadOrderAudit"[\s\S]*?Previsualizar expediente/);
});

test('las operaciones dejan pintar el indicador de proceso antes de guardar', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(orders, /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/);
  assert.match(orders, /requestAnimationFrame\(refreshDossier\)/);
  assert.match(orders, /requestIdleCallback\(refreshGlobal/);
});

test('el avance operativo usa un único envío para evitar bloqueos al guardar', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  const handlers = orders.match(/q\('#orderProgressForm'\)\.addEventListener\('submit'/g) || [];
  assert.equal(handlers.length, 1);
  assert.match(orders, /if \(mode === 'tracking'\) return await recordTrackingProgress/);
  assert.match(orders, /No fue posible registrar la operación/);
});

test('las operaciones dentro de un modal muestran progreso directamente en su botón', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(app, /button-operation-spinner/);
  assert.match(app, /button\.replaceChildren\(spinner,text\)/);
  assert.match(app, /button\?\.closest\('dialog\[open\]'\)/);
  assert.match(app, /operation-dialog-progress/);
  assert.match(html, /\.button-operation-spinner/);
  assert.match(html, /\.operation-dialog-progress/);
  assert.match(html, /\.submit\[aria-busy="true"\]/);
});

test('Clientes abre el expediente comercial-operativo consolidado de cada cliente', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(app, /data-client-dossier-row/);
  assert.match(app, /openClientDossierFromRow/);
  assert.match(app, /bio:open-client-dossier/);
  assert.match(orders, /function renderClientDossier\(client\)/);
  assert.match(orders, /data-client-dossier-order/);
});

test('Nuevo cliente usa un modal completo y no una captura emergente', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(html, /id="newClientDialog"/);
  for (const id of ['newClientName', 'newClientContact', 'newClientPhone', 'newClientEmail', 'newClientAddress', 'newClientRfc']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*required`));
  }
  assert.match(app, /\$\('#newClientDialog'\)\.showModal\(\)/);
  assert.match(app, /\$\('#newClientForm'\)\.addEventListener\('submit'/);
  assert.match(app, /address,location:address,rfc/);
  assert.doesNotMatch(app, /Nombre o razón social del cliente:\s*'\)/);
});

test('Nueva cotización separa datos del cliente y asigna un consecutivo interno', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /Datos del cliente/);
  assert.match(app, /Número de cliente interno/);
  assert.match(app, /nextClientInternalNumber/);
  assert.match(app, /internalNumber/);
});

test('Nueva cotización permite RFC y coincidencias por número de cliente', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /Número de Cliente/);
  assert.match(app, /Ej\. C-00001/);
  assert.match(app, /quotationRfc/);
  assert.match(app, /client\.internalNumber,client\.client/);
});

test('Clientes muestra y filtra todos los datos comerciales, incluido el número', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /field\.removeAttribute\('readonly'\)/);
  assert.match(app, /renderFrequentQuotationClients\(event\.target\.value\)/);
  assert.match(app, /client\.internalNumber,client\.name,client\.contact,client\.phone,client\.email,client\.location,client\.rfc/);
  assert.match(app, /RFC \$\{client\.rfc\}/);
});

test('Nueva cotización aclara su vigencia, oculta la tasa diaria y conserva la cuenta de pago', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /Vigencia de la cotización/);
  assert.match(app, /quotationExchangeRate.*hidden=true/);
  assert.match(app, /0112390566/);
  assert.match(app, /012680001123905664/);
});

test('Días de crédito conserva la selección al volver de contado a crédito', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /savedDays=creditSelect\?\.value/);
  assert.match(app, /lastQuotationCreditDays/);
  assert.match(app, /creditSelect\.value=String\(restoredDays\)/);
  assert.match(app, /\['#quotationPaymentMethod','#quotationCreditDays'\].*stopImmediatePropagation/);
});

test('la plantilla de precios conserva sus campos y se entrega como Excel presentado', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const template = require.resolve('../assets/templates/plantilla-lista-precios-probiolab.xlsx');
  assert.ok(fs.statSync(template).size > 5000);
  assert.match(app, /link\.href='assets\/templates\/plantilla-lista-precios-probiolab\.xlsx'/);
  assert.match(app, /link\.download='plantilla-lista-precios-probiolab\.xlsx'/);
  assert.match(app, /downloadPriceTemplate.*downloadPriceTemplateWorkbook/);
});

test('seguimiento separa bitácora manual de recepciones y remisiones formales', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  for (const label of ['Seguimiento realizado', 'Cambio de estado', 'Compromiso o próxima acción', 'Documento recibido', 'Incidencia o bloqueo']) assert.match(orders, new RegExp(label));
  assert.match(orders, /function recordTrackingProgress\(lineId\)/);
  assert.match(orders, /data-formal-progress="receipt"/);
  assert.match(orders, /data-formal-progress="delivery"/);
  assert.match(orders, /Define cómo se resolverá el faltante/);
  assert.match(orders, /La recepción requiere al menos la remisión/);
  assert.match(orders, /La remisión requiere quién recibe y evidencia/);
  assert.match(orders, /Captura el folio impreso en la remisión del proveedor/);
  assert.doesNotMatch(orders, /No se puede liberar la entrega: faltan/);
  assert.doesNotMatch(orders, /reference\.value = file\.name/);
  assert.match(orders, /formalTypes\[type\] \|\| 'Guardar operación'/);
  assert.match(orders, /returnToDossierAfterOperation/);
  assert.match(orders, /dossier-operation-notice/);
  assert.match(orders, /REM-\$\{dateCode\}-/);
  assert.match(orders, /shipmentFolio\(next, (?:documentDate|localDateKey\(\))\)/);
  assert.match(orders, /dateValue instanceof Date/);
});

test('la validación compartida identifica obligatorios y conserva errores accesibles', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const validation = fs.readFileSync(require.resolve('../form-validation.js'), 'utf8');
  assert.match(html, /form-validation\.js/);
  assert.match(validation, /field-required/);
  assert.match(validation, /input\[required\], select\[required\], textarea\[required\]/);
  assert.match(validation, /field-invalid/);
  assert.match(validation, /aria-invalid/);
  assert.match(validation, /Revisa los campos obligatorios marcados en rojo/);
  assert.match(validation, /scrollIntoView/);
});

test('el flujo exige aceptación del cliente y prepara compras consolidadas auditables', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(html, /id="clientAcceptanceDialog"/);
  assert.match(html, /OC emitida por el cliente/);
  assert.match(html, /Comprobante de aceptación/);
  assert.match(html, /Agregar observaciones/);
  assert.match(app, /Registra una referencia o adjunta la evidencia de aceptación/);
  assert.match(app, /status:'accepted'/);
  assert.match(orders, /documentStage: 'purchase_proposal'/);
  assert.match(orders, /consolidated: requisitionIds\.length > 1/);
  assert.match(orders, /purchase_proposal_approved_and_locked/);
  assert.match(orders, /allocationType:/);
  assert.match(orders, /invoiceRequiredLater/);
  assert.match(orders, /qualityStatus/);
});

test('la autorización de una OC usa el permiso vigente de compras a proveedor', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(orders, /can\?\.\('supplier_order_manage'\)/);
  assert.match(orders, /function confirmSupplierOrder\(orderId\)[\s\S]*canManageSupplierOrders\(\)/);
});

test('la recepción total conserva el pedido de origen y su cantidad pendiente', () => {
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(orders, /form\.dataset\.totalReceiptRequestId=requestId/);
  assert.match(orders, /delete q\('#orderProgressQuantity'\)\.dataset\.formalDefaulted/);
  assert.match(orders, /applyTotalReceipt\(form\.dataset\.supplierOrderId, form\.dataset\.totalReceiptRequestId/);
  assert.match(orders, /if\(totalReceipt\)\{quantityInput\.max=quantityInput\.value/);
  assert.match(orders, /quantityInput\.readOnly=true/);
  assert.match(orders, /mark\('orderProgressQuantity', mode === 'formal' && !totalReceipt\)/);
});

test('agregar un producto no deja una notificación de cotización fuera de contexto', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.doesNotMatch(app, /agregado y cotizado en/);
});
