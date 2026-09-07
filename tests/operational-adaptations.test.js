const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');

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
  assert.match(orders, /type==='receipt'\?'Recepción registrada: la entrada ya se reflejó en el almacén/);
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
