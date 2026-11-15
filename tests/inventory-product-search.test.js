const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('el modal de almacén busca coincidencias incrementales en el catálogo de precios', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  for (const field of ['product.number', 'product.sku', 'product.name', 'product.brand', 'product.unit', 'supplier?.name']) assert.match(app, new RegExp(field.replace(/[?.]/g, match => `\\${match}`)));
  assert.match(app, /movementProductSearch'\)\.addEventListener\('input'/);
  assert.match(app, /data-movement-product/);
  assert.match(html, /\.movement-product-results/);
});

test('las entradas usan únicamente productos de inventario y no dependen de una lista de precios', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.doesNotMatch(app, /isEntry&&product\.priceListStatus!=='current'/);
  assert.doesNotMatch(app, /La entrada solo admite productos vigentes/);
  assert.match(app, /Selecciona un producto de las coincidencias del catálogo/);
});

test('nuevo producto conserva y busca las descripciones importadas de las listas', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const css = fs.readFileSync(require.resolve('../modal-theme.css'), 'utf8');
  assert.match(app, /nexo-price-catalog-entries/);
  assert.match(app, /catalogPriceDescriptionSearch/);
  assert.match(app, /availablePriceCatalogEntries/);
  assert.match(app, /description:row\.description/);
  assert.match(app, /data-price-entry/);
  assert.match(css, /\.catalog-price-results/);
});

test('nuevo producto requiere primero proveedor y conserva su nomenclatura secuencial', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(app, /nextSupplierProductIdentifiers/);
  assert.match(app, /applySupplierProductSequence/);
  assert.match(html, /1\. Proveedor del producto/);
  assert.match(html, /catalogNumber" required readonly/);
});

test('aplicar una lista crea producto maestro sin existencias y relación persistente', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /removeLegacyPriceListInventoryProducts/);
  assert.match(app, /stagedEntries\.filter\(entry=>entry\.supplierId===supplierId&&entry\.isCurrent\)/);
  assert.match(app, /source:'price_catalog_master'/);
  assert.match(app, /BioSupplierRelations\.upsert\(stagedRelations/);
  assert.match(app, /a1:0,a2:0/);
  assert.doesNotMatch(app, /activateStoredPriceCatalogEntries/);
});

test('las alertas de inventario solo incluyen artículos con existencias o movimientos reales', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(app, /function isInventoryTracked/);
  assert.match(app, /inventoryHasOperationalHistory/);
  assert.match(app, /trackedInventoryProducts=products\.filter\(isInventoryTracked\)/);
  assert.match(html, /id="inventoryLowCount"/);
});

test('cotizaciones presenta el catálogo vigente de listas sin convertirlo en inventario', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /function quotationCatalogCandidates/);
  assert.match(app, /priceCatalogEntries\.filter\(entry=>entry\.isCurrent/);
  assert.match(app, /priceEntryId:item\.priceEntryId/);
});

test('cotizaciones conserva la moneda de cada artículo de lista sin ocultarlo por la moneda de referencia', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /currency=product\.salePriceCurrency\|\|relation\?\.currency\|\|product\.priceCurrency\|\|'MXN'/);
  assert.match(app, /documentCurrency=totals\.isMultiCurrency\?'MULTI'/);
  assert.match(app, /totalsByCurrency:totals\.byCurrency/);
  assert.match(app, /TOTALES POR MONEDA/);
});

test('el catálogo de listas aplicadas se consulta por proveedor y conserva su moneda', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /priceCatalogSupplierFilter/);
  assert.match(html, /VISOR DE LISTAS Y PRECIOS DE VENTA/);
  assert.match(app, /function renderProviderPriceCatalog/);
  assert.match(app, /entry\.supplierId===selected/);
  assert.match(app, /money\(entry\.listPrice\?\?entry\.price,entry\.currency\)/);
});

test('el catálogo de productos muestra la divisa una sola vez, en su etiqueta', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /const priceAmount=value=>/);
  assert.match(app, /function catalogDisplayPrice\(product,entries=\[\]\)/);
  assert.match(app, /Sin precio de venta/);
});

test('el visor de listas recupera renglones de cargas previas conservados en el catálogo', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /function restorePreviousPriceCatalogEntries/);
  assert.match(app, /product\.priceListStatus==='current'/);
  assert.match(app, /recoveredFromProduct:true/);
  assert.match(app, /nexo-price-catalog-entries/);
});

test('la nueva cotización encuentra clientes frecuentes y completa sus datos editables', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /quotationClientResults/);
  assert.match(app, /function frequentQuotationClients/);
  assert.match(app, /renderFrequentQuotationClients/);
  assert.match(app, /function selectFrequentQuotationClient/);
  assert.match(app, /selectFrequentQuotationClientWithValidation/);
  assert.match(app, /clearFieldError/);
  for (const field of ['client\.client', 'client\.contact', 'client\.location', 'client\.email']) assert.match(app, new RegExp(field));
});
