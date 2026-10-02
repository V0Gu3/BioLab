const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
const reports = fs.readFileSync(require.resolve('../reports.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const modalTheme = fs.readFileSync(require.resolve('../modal-theme.css'), 'utf8');

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

test('conteos muestra únicamente referencias con existencia', () => {
  assert.match(html, /id="countWarehouseFilter"/);
  assert.match(app, /function countWarehouseStock/);
  assert.match(app, /countableProducts=products\.filter\(product=>countWarehouseStock\(product,selectedCountWarehouse\)>0\)/);
  assert.match(app, /String\(p\.id\)===String\(e\.target\.dataset\.productId\)/);
  assert.match(app, /String\(p\.id\)===String\(input\.dataset\.productId\)/);
  assert.match(app, /product\[countWarehouseField\(warehouseId\)\]=physical/);
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
