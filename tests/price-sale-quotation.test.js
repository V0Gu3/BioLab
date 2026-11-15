const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const server = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');

test('la cotización calcula el precio final desde el precio de venta y la protección', () => {
  assert.match(app, /function quotationProtectedPrice\(salePrice\)/);
  assert.match(app, /base\*\(1\+protectionPercent\/100\)/);
  assert.match(app, /quotationProtectedPrice\(salePrice\)/);
  assert.doesNotMatch(app, /quotationProtectedPrice\(entry\.price\)/);
  assert.match(app, /finalQuotedPrice:line\.unitPrice/);
  assert.match(app, /quotation\.clientId=record\.id/);
});

test('la edición de precio y descuento no redibuja la partida al teclear y marca su estado comercial', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /event\.stopImmediatePropagation\(\)/);
  assert.match(app, /quotation-price-protected/);
  assert.match(app, /quotation-price-below/);
  assert.match(app, /quotation-price-above/);
  assert.match(app, /quotation-discount-active/);
});

test('la cotización muestra el proveedor y catálogo sin exponer la leyenda de protección', () => {
  assert.match(app, /quotation-product-brand-chip/);
  assert.match(app, /supplierName=suppliers\.find/);
  assert.match(app, /brand,supplierName,unit:detail\.unit/);
  assert.match(app, /Proveedor: \$\{item\.supplierName\|\|item\.brand/);
  assert.doesNotMatch(app, /Precio de venta \+\$\{item\.protectionPercent\}/);
});

test('la importación conserva lista y venta separadas y evita duplicar el mismo archivo', () => {
  assert.match(app, /listPrice:Number\(entry\.listPrice\?\?entry\.price\)/);
  assert.match(app, /salePrice=Number\(entry\.salePrice\)>0\?Math\.round/);
  assert.match(app, /originalSalePrice/);
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
  assert.match(server, /new Set\(\['price', 'listPrice', 'purchasePrice', 'cost', 'sourcePrice'\]\)/);
  assert.match(server, /\['products', 'quotations', 'client-orders'\]\.includes\(resource\)/);
  assert.match(server, /copy\['nexo-commercial-orders'\].*map\(withoutListPrice\)/);
});

test('las listas sin precio de venta quedan visibles para corrección pero no son cotizables', () => {
  assert.match(app, /No existe un precio de venta vigente/);
  assert.match(app, /status==='missing-sale'/);
  assert.match(app, /if\(!item\.quoteReady\)/);
});

test('las listas sin unidad conservan el dato pendiente como guiones y permiten corregirlo', () => {
  const relations = fs.readFileSync(require.resolve('../supplier-relations.js'), 'utf8');
  assert.match(app, /unitNeedsReview:!row\.unit/);
  assert.match(app, /autoFilledUnit=String\(entry\.unit\|\|''\)\.trim\(\)\.toLowerCase\(\)==='unidad'/);
  assert.match(app, /unitWasAutoFilled=storedUnit\.toLowerCase\(\)==='unidad'/);
  assert.match(app, /entry\.unit\|\|'--'/);
  assert.match(app, /data-unit-entry/);
  assert.match(app, /Unidad de medida actualizada/);
  assert.doesNotMatch(relations, /purchaseUnit: clean\(relation\.purchaseUnit \|\| relation\.unit\) \|\| 'unidad'/);
});

test('los precios y descuentos de una cotización aceptan precisión decimal sin alertas de paso', () => {
  assert.match(app, /data-field="unitPrice" type="number" min="0" step="any" inputmode="decimal"/);
  assert.match(app, /data-field="discount" type="number" min="0" max="100" step="any" inputmode="decimal"/);
});

test('el color del precio compara la referencia ya convertida cuando cambia la moneda', () => {
  assert.match(app, /storedConvertedPrice=Number\(item\.fx\?\.unitPrice\)/);
  assert.match(app, /if\(source!==target&&Number\.isFinite\(storedConvertedPrice\)&&storedConvertedPrice>0\)return storedConvertedPrice/);
  assert.match(app, /quotationProductPrice\(\{\.\.\.item,sourceCurrency:source,sourcePrice\},target\)/);
});

test('la conversión de la cotización conserva el precio unitario a tres decimales', () => {
  assert.match(app, /const quotedPrice=Number\(Number\(conversion\.unitPrice\)\.toFixed\(3\)\)/);
  assert.match(app, /unitPrice:quotedPrice,finalQuotedPrice:quotedPrice/);
});

test('los importes de cotización se redondean de forma consistente en cada partida y total', () => {
  assert.match(app, /function roundQuotationMoney\(value\)/);
  assert.match(app, /function quotationLineAmounts\(item\)/);
  assert.match(app, /const subtotal=roundQuotationMoney/);
  assert.match(app, /discountTotal=roundQuotationMoney/);
  assert.match(app, /taxAmount=roundQuotationMoney\(taxable\*taxRate\/100\)/);
  assert.match(app, /total:roundQuotationMoney\(taxable\+taxAmount\)/);
  assert.match(app, /quotationLineAmounts\(item\)\.total/);
  assert.match(app, /toLocaleString\('en-US',\{minimumFractionDigits:2,maximumFractionDigits:2\}\)/);
  assert.match(app, /parseQuotationNumericInput=value=>Number\(String\(value\?\?''\)\.replace\(\/,\/g,''\)\)\|\|0/);
});

test('los precios manuales rechazan ceros iniciales y separadores ambiguos', () => {
  assert.match(app, /function validateManualPrice\(value/);
  assert.match(app, /sin ceros iniciales y punto decimal/);
  assert.match(app, /validateManualPriceField\(\$\('#catalogPrice'\)/);
  assert.match(app, /validateManualPriceField\(\$\('#productEditPrice'\)/);
  assert.match(app, /\['catalogPrice','productEditPrice','productEditSalePrice'\]/);
});

test('la captura muestra precios de cotización a dos decimales sin perder precisión interna', () => {
  assert.match(app, /formatQuotationUnitPrice=value=>[\s\S]*minimumFractionDigits:2,maximumFractionDigits:2/);
  assert.match(app, /const quotedPrice=Number\(Number\(conversion\.unitPrice\)\.toFixed\(3\)\)/);
});

test('cancelar un movimiento iniciado desde producto restaura la edición y sus cambios', () => {
  assert.match(app, /let productEditMovementContext=null/);
  assert.match(app, /Regresaste a la edición del producto; tus cambios se conservaron/);
  assert.match(app, /productEditMovementCompleted='true'/);
});

test('el resumen solo muestra descuento cuando hay un importe descontado', () => {
  assert.match(app, /function syncQuotationDiscountSummary/);
  assert.match(app, /hasDiscount=.*discountTotal/);
  assert.match(app, /row\.hidden=!hasDiscount/);
});

test('la partida identifica el descuento como porcentaje', () => {
  assert.match(html, /DESC\. \(%\)/);
  assert.match(app, /Descuento porcentual \(%\)/);
});
