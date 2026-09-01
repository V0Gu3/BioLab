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
