const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');

test('la cotización calcula el precio final desde el precio de venta y la protección', () => {
  assert.match(app, /function quotationProtectedPrice\(salePrice\)/);
  assert.match(app, /base\*\(1\+protectionPercent\/100\)/);
  assert.match(app, /quotationProtectedPrice\(salePrice\)/);
  assert.doesNotMatch(app, /quotationProtectedPrice\(entry\.price\)/);
  assert.match(app, /finalQuotedPrice:item\.unitPrice/);
});

test('la edición de precio y descuento no redibuja la partida al teclear y marca su estado comercial', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /event\.stopImmediatePropagation\(\)/);
  assert.match(app, /quotation-price-protected/);
  assert.match(app, /quotation-price-below/);
  assert.match(app, /quotation-price-above/);
  assert.match(app, /quotation-discount-active/);
});

test('la importación conserva lista y venta separadas y evita duplicar el mismo archivo', () => {
  assert.match(app, /listPrice:Number\(entry\.listPrice\?\?entry\.price\)/);
  assert.match(app, /salePrice:Number\(entry\.salePrice\)>0\?Number\(entry\.salePrice\):null/);
  assert.match(app, /PRECIO\.\*\(VENTA\|COMERCIAL\)/);
  assert.match(app, /fileHash&&load\.fileHash===parsed\.fileHash/);
  assert.match(app, /isCurrent=false/);
});

test('la conciliación previa muestra por separado precio de lista y precio de venta', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<th>PRECIO DE LISTA<\/th><th>PRECIO DE VENTA<\/th>/);
  assert.match(app, /listPrice=Number\.isFinite\(row\.listPrice\)/);
  assert.match(app, /salePrice=Number\.isFinite\(row\.salePrice\)/);
});

test('el visor de listas muestra al proveedor en una columna propia', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<th>CATÁLOGO<\/th><th>PROVEEDOR<\/th><th>DESCRIPCIÓN<\/th>/);
  assert.match(app, /class="price-catalog-supplier"/);
});

test('el visor de listas pagina los artículos en bloques de 20', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /id="priceCatalogPagination"/);
  assert.match(app, /const priceCatalogPageSize=20/);
  assert.match(app, /rows\.slice\(firstRow,firstRow\+priceCatalogPageSize\)/);
});

test('vendedor no recibe ni persiste el precio de lista en cotizaciones', () => {
  assert.match(app, /listPrice:isSeller\?null:Number\(item\.listPrice\)/);
  assert.match(server, /function sanitizeForRole/);
  assert.match(server, /delete copy\.listPrice/);
  assert.match(server, /delete copy\.sourcePrice/);
});

test('las listas sin precio de venta quedan visibles para corrección pero no son cotizables', () => {
  assert.match(app, /No existe un precio de venta vigente/);
  assert.match(app, /status==='missing-sale'/);
  assert.match(app, /if\(!item\.quoteReady\)/);
});
