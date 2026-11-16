const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
const internalOrders = fs.readFileSync(require.resolve('../internal-orders.js'), 'utf8');
const reports = fs.readFileSync(require.resolve('../reports.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const modalTheme = fs.readFileSync(require.resolve('../modal-theme.css'), 'utf8');
const styles = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
const orderStyles = fs.readFileSync(require.resolve('../orders.css'), 'utf8');

test('el resumen permite consultar hoy y el último mes cerrado por día', () => {
  assert.match(html, /id="dashboardPeriod"/);
  assert.match(html, /value="closed-month"/);
  assert.match(html, /id="dashboardDailyRows"/);
  assert.match(app, /function renderDashboardPeriod/);
});

test('inventario se valoriza y filtra por almacén y divisa', () => {
  assert.match(html, /id="dashboardInventoryValueCard"/);
  assert.match(html, /id="inventoryCurrentValue"/);
  assert.match(html, /VALOR EN ALMACÉN/);
  assert.match(html, /id="inventoryCurrencyFilter"/);
  assert.match(app, /function inventoryValueBuckets/);
  assert.match(app, /currentInventoryValues=inventoryValueBuckets\(\)/);
  assert.match(app, /data-dashboard-warehouse/);
});

test('el traspaso ofrece únicamente productos con existencia en el almacén de salida', () => {
  assert.match(app, /type!=='traspaso'\|\|hasSourceStock/);
  assert.match(app, /No hay productos con existencia en Almacén/);
  assert.match(app, /\['from','to'\]\.forEach/);
  assert.match(app, /products\.find\(x=>String\(x\.id\)===String\(\$\('#product'\)\.value\)\)/);
  assert.match(html, /quantity-field\{grid-column:1\/-1;width:250px/);
});

test('las salidas, mermas y traspasos explican la falta de existencia antes de guardar', () => {
  assert.match(app, /function movementStockCheck/);
  assert.match(app, /id="movementStockFeedback"/);
  assert.match(app, /No hay existencia suficiente en \$\{movementWarehouseLabel\(warehouseId\)\}/);
  assert.match(app, /No hay existencia suficiente en \$\{movementWarehouseLabel\(from\)\}/);
  assert.match(app, /\$\('#quantity'\)\.addEventListener\('input',updateMovementStockFeedback\)/);
});

test('conteos incluye existencia disponible y en cuarentena sin liberarla para entrega', () => {
  assert.match(html, /id="countWarehouseFilter"/);
  assert.match(app, /function countWarehouseStock/);
  assert.match(app, /function countWarehouseQuarantine/);
  assert.match(app, /countableProducts=products\.filter\(product=>countWarehouseStock\(product,selectedCountWarehouse\)>0\)/);
  assert.match(app, /String\(p\.id\)===String\(e\.target\.dataset\.productId\)/);
  assert.match(app, /String\(p\.id\)===String\(input\.dataset\.productId\)/);
  assert.match(app, /product\[countWarehouseQuarantineField\(warehouseId\)\]=quarantineAfter/);
  assert.match(app, /product\[countWarehouseField\(warehouseId\)\]=physical-quarantineAfter/);
});

test('recepciones del seguimiento integran almacén y permite remisiones parciales por partida', () => {
  assert.match(orders, /Cada partida se puede remitir parcialmente cuando tiene existencia disponible/);
  assert.doesNotMatch(orders, /No se puede liberar la entrega: faltan/);
  assert.match(orders, /Entrada de almacén generada/);
  assert.match(orders, /returnToDossierAfterOperation/);
  assert.match(orders, /ensureInventoryProductForReceipt/);
  assert.match(orders, /source: 'operational_receipt'/);
  assert.match(orders, /reconcileHistoricalReceiptInventory/);
  assert.match(orders, /inventoryMovementFolio/);
  assert.match(orders, /type === 'entry' \? 'ENT' : 'SAL'/);
  assert.match(orders, /formatMovementDateTime/);
  assert.match(app, /function integratedInventoryMovements/);
  assert.match(orders, /function openTotalReceiptProgress/);
  assert.match(orders, /function applyTotalReceipt/);
  assert.match(orders, /data-formal-total-receipt/);
  assert.match(orders, /function openTotalDeliveryProgress/);
  assert.match(orders, /function applyTotalDelivery/);
  assert.match(orders, /data-formal-total-delivery/);
  assert.match(app, /window\.BioOperationProgress=\{start:startOperationProgress\}/);
  assert.match(orders, /Generando remisión…/);
  assert.match(orders, /await applyProgress/);
});

test('la cuarentena conserva existencia física separada, visible y no entregable', () => {
  assert.match(orders, /inventoryState === 'quarantine'/);
  assert.match(orders, /field = `\$\{quarantine \? 'q' : 'a'\}/);
  assert.match(orders, /reconcileHistoricalQuarantineInventory/);
  assert.match(orders, /sourceMovementId: movementId/);
  assert.match(orders, /En cuarentena · no disponible para entrega/);
  assert.match(app, /uds\. físicas/);
  assert.match(app, /en cuarentena/);
  assert.match(app, /Cuarentena_Almacén_02/);
});

test('cancelar saldo autorizado cierra el faltante y deja trazabilidad', () => {
  assert.match(orders, /shortage_authorized_cancellation/);
  assert.match(orders, /supplierLink\.quantityCancelled = core\.numberValue\(supplierLink\.quantityCancelled\) \+ shortageQuantity/);
  assert.match(orders, /status: authorizedCancellation \? 'cancelled' : 'open'/);
  assert.match(orders, /receipt\.type = 'partial'/);
  assert.match(orders, /reconcileHistoricalAuthorizedShortages/);
  assert.match(orders, /Saldo faltante cancelado con autorización/);
});

test('Ciclo 5 punto 9 muestra el tratamiento de una recepción parcial fuera de Datos adicionales', () => {
  assert.match(orders, /id="receiptShortageField" class="receipt-shortage-required" hidden/);
  assert.match(orders, /Recepción parcial: indica cómo se atenderá el faltante/);
  assert.doesNotMatch(orders, /\['receiptDocumentType'[\s\S]*?'receiptShortageResolution'\]\.forEach/);
  assert.doesNotMatch(orders, /details\.append\(shortage\)/);
  assert.match(orders, /q\('#receiptShortageField'\)\.hidden = !receipt/);
  assert.match(orderStyles, /\.receipt-shortage-required\[hidden\]\{display:none!important\}/);
});

test('las reservas futuras excluyen recepciones comprometidas y liberan faltantes hacia compras', () => {
  assert.match(orders, /const committedReceiptsByWarehouse/);
  assert.match(orders, /occupied\[warehouseId\].*reservations\[warehouseId\].*commitments\[warehouseId\]/);
  assert.match(orders, /const reconcileInventoryReservations/);
  assert.match(orders, /line\.quantityToPurchase = Math\.max/);
  assert.match(orders, /action: 'inventory_reservation_released'/);
  assert.match(orders, /let changed = reconcileInventoryReservations\(next, products\)/);
});

test('los pedidos internos en borrador no entran a seguimiento ni a entregas', () => {
  assert.match(orders, /if \(!request && clientOrder\.status !== 'active'\) return/);
  assert.match(orders, /const isOperationalRequest = request => request\?\.source !== 'quotation_client_order' \|\| request\?\.clientOrderStatus === 'active'/);
  assert.match(orders, /store\.requisitions\.filter\(isOperationalRequest\)\.map/);
  assert.match(orders, /request\.status !== 'cancelled' && isOperationalRequest\(request\)/);
});

test('cotizaciones e inventario exportan libros Excel', () => {
  assert.match(app, /function downloadQuotationExcel/);
  assert.match(app, /XLSX\.write\(book,\{bookType:'xlsx',type:'array',compression:true\}\)/);
  assert.match(app, /URL\.createObjectURL\(new Blob\(\[fileData\]/);
  assert.match(app, /inventario-probiolab-\$\{new Date\(\)\.toISOString\(\)\.slice\(0,10\)\}\.xlsx/);
});

test('el reporte de pedidos se descarga como libro presentado y filtrable', () => {
  assert.match(reports, /function reportSheet/);
  assert.match(reports, /Reporte general de pedidos internos/);
  assert.match(reports, /sheet\['!autofilter'\]/);
  assert.match(reports, /sheet\['!freeze'\]/);
  assert.match(reports, /UNIDADES SOLICITADAS/);
});

test('la importación de precios permite secciones de monedas dentro de una misma hoja', () => {
  assert.match(app, /function detectPriceSectionCurrency/);
  assert.match(app, /PRECIO\|PRECIOS\|MONEDA\|DIVISA\|COSTO\|TARIFA/);
  assert.match(app, /DOLAR\(\?:ES\)\?/);
  assert.match(app, /let activeSectionCurrency=defaultCurrency/);
  assert.match(app, /cells\.map\(detectPriceSectionCurrency\)\.find\(Boolean\)/);
  assert.match(app, /activeSectionCurrency\|\|defaultCurrency/);
});

test('la carga de listas de precios acepta clic y arrastrar un archivo válido', () => {
  assert.match(app, /function installPriceFileDropZone/);
  assert.match(app, /Haz clic o arrastra aquí tu archivo/);
  assert.match(app, /zone\.addEventListener\('drop'/);
  assert.match(app, /async function loadPriceFile/);
  assert.match(app, /isSupportedPriceFile/);
});

test('la conciliación previa pagina cargas masivas en bloques de 100 resultados', () => {
  assert.match(app, /const priceReviewPageSize=100/);
  assert.match(app, /function installPriceReviewPagination/);
  assert.match(app, /visibleRows\.slice\(firstRow,firstRow\+priceReviewPageSize\)/);
  assert.match(app, /Mostrando \$\{firstRow\+1\}–\$\{lastRow\} de \$\{visibleRows\.length\}/);
  assert.match(app, /id="priceReviewPrevious"/);
  assert.match(app, /id="priceReviewNext"/);
  assert.match(modalTheme, /\.price-preview>\.table-wrap\{max-height:620px;overflow:auto\}/);
  assert.match(modalTheme, /table-layout:fixed/);
  assert.match(modalTheme, /position:sticky;top:0/);
});

test('los conflictos de una lista explican el SKU, las filas, precios y monedas involucradas', () => {
  assert.match(app, /conflict:\['SKU repetido','low'\]/);
  assert.match(app, /Precio o moneda diferente/);
  assert.match(app, /conflictDetail=!same\?/);
  assert.match(app, /previous\.sheetName/);
  assert.match(app, /previous\.listPrice/);
  assert.match(app, /current\.sheetName/);
  assert.match(app, /current\.listPrice/);
  assert.match(app, /SKU repetido con precio o moneda diferente/);
  assert.match(modalTheme, /\.price-conflict-detail/);
  assert.match(modalTheme, /\.price-review-state/);
  assert.match(modalTheme, /background-image:linear-gradient\(color-mix/);
});

test('el resumen y el botón de una carga usan el mismo total realmente aplicable', () => {
  assert.match(app, /blockedRows=batch\.rows\.filter\(row=>!row\.skipped&&!row\.valid&&!row\.activatable\)/);
  assert.match(app, /<b>\$\{validRows\.length\} listo/);
  assert.match(app, /\$\{blockedRows\.length\} por revisar/);
  assert.match(app, /catalogCount=validRows\.length/);
  assert.match(app, /applyPrices'\)\.disabled=!catalogCount/);
  assert.doesNotMatch(app, /catalogCount=batch\.rows\.filter\(row=>!row\.skipped&&row\.validCurrency&&!row\.conflict\)/);
});

test('proveedores se editan o eliminan con justificación y hay panel administrativo', () => {
  assert.match(html, /id="supplierReason"/);
  assert.match(app, /Justificación obligatoria para eliminar al proveedor/);
  assert.match(html, /id="notificationDialog"/);
  assert.match(app, /function notificationProcesses/);
});

test('la clave de un nuevo proveedor se asigna de forma consecutiva', () => {
  assert.match(html, /id="supplierCode" required readonly/);
  assert.match(app, /function nextSupplierCode/);
  assert.match(app, /PRV-\$\{String\(highest\+1\)\.padStart\(3,'0'\)\}/);
});

test('la justificación del proveedor se oculta al agregar y se reserva para edición', () => {
  assert.match(app, /supplierReasonField'\)\.hidden=!supplier/);
  assert.match(modalTheme, /#supplierReasonField\[hidden\]\{display:none!important\}/);
});

test('Ciclo 4 conserva fechas locales, mensajes visibles y traspasos sin signo de salida', () => {
  assert.match(app, /const BUSINESS_TIME_ZONE='America\/Mexico_City'/);
  assert.match(app, /businessDateTime\(order\.createdAtISO,order\.createdAt\)/);
  assert.match(app, /type==='traspaso'\?`\$\{q\} uds\.`:`− \$\{q\} uds\.`/);
  assert.match(app, /function movementQuantityLabel/);
  assert.match(app, /if\(type==='traspaso'\)return `\$\{formatted\} uds\.`/);
  assert.match(app, /movementQuantityLabel\(m\)/);
  assert.match(app, /function signedUnitsLabel/);
  assert.match(app, /if\(!value\)return '0 uds\.'/);
  assert.doesNotMatch(app, /dashboardExitCount'\)\.textContent=`−\$\{exits/);
  assert.match(styles, /#toast\{position:fixed!important/);
  assert.match(styles, /visibility:hidden!important/);
});

test('Ciclo 5 conserva la fecha real de los movimientos y no convierte Ahora en hoy', () => {
  assert.match(app, /createdAtISO,createdAt:shown,time:shown/);
  assert.match(app, /function parseMovementDate/);
  assert.match(app, /function movementDisplayDate/);
  assert.doesNotMatch(app, /if\(\/hace\|hoy\|ahora\/i\.test\(movement\.time/);
  assert.match(app, /Fecha:movementDisplayDate\(m\)/);
});

test('Ciclo 5 punto 12 corrige detalles visuales, duplicados y bloqueo de remisión', () => {
  assert.doesNotMatch(html, /id="averagePrice"|id="withoutSupplier"/);
  assert.doesNotMatch(app, /\$\('#averagePrice'\)|\$\('#withoutSupplier'\)/);
  assert.match(internalOrders, /Number\(item\.unitPrice \|\| 0\)\.toFixed\(2\)/);
  assert.match(internalOrders, /step="0\.01" data-internal-line/);
  assert.match(app, /hasCatalogProductDuplicate\(name,supplierId\)/);
  assert.match(app, /hasCatalogProductDuplicate\(name,product\.supplierId,product\.id\)/);
  assert.match(orders, /localStorage\.setItem\(STORAGE_KEY, serialized\)/);
  assert.doesNotMatch(orders, /localStorage\.setItem\(`\$\{STORAGE_KEY\}-transaction`, serialized\)/);
  assert.match(orders, /Generando remisión total…/);
  assert.match(orders, /applyCatalogStockAdjustments\(catalogAdjustments, null, \{ notify: false \}\)/);
  assert.match(orders, /applyCatalogStockAdjustments\(catalogPlan\.adjustments, catalogPlan\.staged, \{ notify: false \}\)/);
});

test('el seguimiento reconcilia compras históricas y distingue etapas no aplicables', () => {
  assert.match(orders, /core\.effectiveLineSupply/);
  assert.match(orders, /reconcileHistoricalPurchaseReceipts/);
  assert.match(orders, /duplicate_receipt_reconciled/);
  assert.match(orders, /supply\.pendingPurchase/);
  assert.match(orders, /<strong>Surtido desde almacén<\/strong>/);
  assert.match(orders, /Sin compra externa/);
  assert.match(orders, /Sin recepción externa/);
  assert.match(orders, /const purchaseRequired = lines\.reduce/);
});

test('Ciclo 5 punto 7 conserva folios y una fecha local única en Pruebas', () => {
  assert.match(orders, /function reconcileHistoricalDocumentDates/);
  assert.match(orders, /identityReconciliation/);
  assert.match(orders, /date: documentDate/);
  assert.match(orders, /date: shipment\.date \|\| String\(shipment\.deliveredAt/);
  assert.match(orders, /createdAt: documentDate, createdAtTimestamp: at/);
  assert.match(orders, /bio:persistence-changed/);
  assert.match(orders, /store = loadStore\(\)/);
});

test('Ciclo 4 bloquea calendarios pasados y traduce la bitácora operativa', () => {
  assert.match(orders, /pastBusinessDate\(commitmentDate\)/);
  assert.match(orders, /pastBusinessDate\(receiptData\.expiryDate\)/);
  assert.match(orders, /setAttribute\('min', minimumDate\)/);
  assert.match(orders, /tracking_incident: 'Incidencia registrada'/);
  assert.match(orders, /purchase_proposal_approved_and_locked: 'Compra autorizada y emitida'/);
  assert.match(orders, /auditActionLabel\(entry\.action\)/);
});
