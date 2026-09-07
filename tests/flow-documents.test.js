const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const docs = require('../flow-documents.js');

test('cubre todos los documentos del flujo operativo', () => {
  assert.deepEqual(Object.keys(docs.TYPES), ['quotation', 'client_order', 'supplier_order', 'inventory_entry', 'inventory_exit', 'remision', 'audit']);
  assert.equal(docs.filename('client_order', 'OC-260829-0001'), 'client-order-OC-260829-0001.pdf');
});

test('la interfaz expone descargas en cada etapa documental', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.match(html, /flow-documents\.js\?v=/);
  assert.match(app, /downloadCommercialOrderDocument/);
  for (const type of ['supplier_order', 'inventory', 'remision', 'quotation', 'client_order']) assert.match(orders, new RegExp(`kind === '${type}'`));
});

test('todos los documentos admiten vista previa y descarga desde el mismo visor', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const preview = fs.readFileSync(require.resolve('../document-preview.js'), 'utf8');
  const orders = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  assert.equal(typeof docs.preview, 'function'); assert.equal(typeof docs.previewBlob, 'function'); assert.equal(typeof docs.present, 'function');
  assert.match(html, /id="documentPreviewDialog"/); assert.match(html, /id="documentPreviewDownload"/); assert.match(html, /document-preview\.js/);
  for (const kind of ['quotation', 'client_order', 'purchase_order', 'price_load', 'movement', 'supplier_order', 'inventory', 'remision']) assert.match(preview, new RegExp(`kind === '${kind}'`));
  assert.match(orders, /downloadSupplierOrder\(id, true\)/); assert.match(orders, /downloadInventoryDocument\(id, true\)/); assert.match(orders, /downloadShipmentDocument\(id, true\)/);
});

test('la identidad visual de los PDF no depende del tema personal', () => {
  const sources = ['../flow-documents.js', '../orders.js', '../app.js'].map(file => fs.readFileSync(require.resolve(file), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /BioTheme|getComputedStyle\s*\(|--bio-primary/);
  assert.match(sources, /setFillColor\(23,\s*34,\s*29\)/);
  assert.match(sources, /setTextColor\(255,\s*255,\s*255\)/);
});

test('la moneda documental se deriva de los importes estructurados y nunca del texto libre', () => {
  const usd = docs.monetaryProfile({
    currency: 'MXN',
    totalsByCurrency: [{ currency: 'USD', subtotal: 8500, taxAmount: 1360, total: 9860 }],
    items: [{ description: 'Reactivo con texto USD', currency: 'USD', quantity: 1, unitPrice: 8500, lineTotal: 8500 }]
  });
  const multi = docs.monetaryProfile({ items: [{ currency: 'MXN', quantity: 1, unitPrice: 100 }, { currency: 'USD', quantity: 1, unitPrice: 20 }] });
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.totals[0].total, 9860);
  assert.equal(multi.currency, 'MULTI');
  assert.match(docs.moneyWithCode(1250, 'USD'), /^USD\s/);
});

test('la OC muestra ISO en cabecera, partidas y total cuando el campo heredado es contradictorio', () => {
  class PdfCapture {
    constructor() { this.texts = []; }
    setFillColor() {} rect() {} setTextColor() {} setFont() {} setFontSize() {} roundedRect() {} setDrawColor() {} line() {} addPage() {} setPage() {}
    getNumberOfPages() { return 1; }
    splitTextToSize(text) { return [String(text)]; }
    text(text) { this.texts.push(Array.isArray(text) ? text.join(' ') : String(text)); }
  }
  const doc = docs.create('client_order', {
    id: 'OC-260830-0001', currency: 'MXN', total: 9860, subtotal: 8500, tax: 1360,
    totalsByCurrency: [{ currency: 'USD', subtotal: 8500, taxAmount: 1360, total: 9860 }],
    items: [{ catalog: '100001', description: 'Reactivo comercial', quantity: 2, unitPrice: 4250, total: 8500, currency: 'USD' }]
  }, PdfCapture);
  assert.ok(doc.texts.includes('USD'));
  assert.ok(doc.texts.includes('TOTAL USD'));
  assert.ok(doc.texts.some(text => /^USD\s/.test(text)));
});
