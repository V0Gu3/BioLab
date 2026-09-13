const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
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
  assert.match(html, /id="inventoryCurrencyFilter"/);
  assert.match(app, /function inventoryValueBuckets/);
  assert.match(app, /data-dashboard-warehouse/);
});

test('conteos muestra únicamente referencias con existencia', () => {
  assert.match(app, /countableProducts=products\.filter\(product=>Number\(product\.a1\|\|0\)\+Number\(product\.a2\|\|0\)>0\)/);
});

test('recepciones del seguimiento integran almacén y la entrega espera todas las partidas', () => {
  assert.match(orders, /No se puede liberar la entrega/);
  assert.match(orders, /Entrada de almacén generada/);
  assert.match(orders, /returnToDossierAfterOperation/);
  assert.match(orders, /ensureInventoryProductForReceipt/);
  assert.match(orders, /source: 'operational_receipt'/);
  assert.match(orders, /reconcileHistoricalReceiptInventory/);
  assert.match(orders, /inventoryMovementFolio/);
  assert.match(orders, /type === 'entry' \? 'ENT' : 'SAL'/);
  assert.match(orders, /formatMovementDateTime/);
  assert.match(app, /function integratedInventoryMovements/);
});

test('cotizaciones e inventario exportan libros Excel', () => {
  assert.match(app, /function downloadQuotationExcel/);
  assert.match(app, /XLSX\.write\(book,\{bookType:'xlsx',type:'array',compression:true\}\)/);
  assert.match(app, /URL\.createObjectURL\(new Blob\(\[fileData\]/);
  assert.match(app, /inventario-probiolab-\$\{new Date\(\)\.toISOString\(\)\.slice\(0,10\)\}\.xlsx/);
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
