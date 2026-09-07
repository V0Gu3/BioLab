const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('los submenús tienen un identificador y un estado expandido accesible', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  for (const group of ['quotations', 'inventory', 'orders', 'products']) {
    assert.match(html, new RegExp(`data-nav-group="${group}"`));
  }
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 4);
  for (const view of ['warehouseSummaryView', 'trackingSummaryView', 'productSummaryView']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.match(html, /data-view="deliveriesView"/);
  assert.match(html, /id="deliveriesView"/);
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

test('el flujo exige aceptación del cliente y prepara compras consolidadas auditables', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(html, /id="clientAcceptanceDialog"/);
  assert.match(html, /OC emitida por el cliente/);
  assert.match(app, /Registra una referencia o adjunta la evidencia de aceptación/);
  assert.match(app, /status:'accepted'/);
  assert.match(orders, /documentStage: 'purchase_proposal'/);
  assert.match(orders, /consolidated: requisitionIds\.length > 1/);
  assert.match(orders, /purchase_proposal_approved_and_locked/);
  assert.match(orders, /allocationType:/);
  assert.match(orders, /invoiceRequiredLater/);
  assert.match(orders, /qualityStatus/);
});
