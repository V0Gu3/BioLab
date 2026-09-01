const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = file => fs.readFileSync(require.resolve(`../${file}`), 'utf8');

test('productos incorpora fotografías persistentes y etiquetas individuales o múltiples', () => {
  const html = read('index.html'), app = read('app.js');
  assert.match(html, /id="catalogImages"[^>]+multiple/);
  assert.match(html, /id="productMediaDialog"/);
  assert.match(html, /id="printVisibleLabels"/);
  assert.match(html, /id="printSelectedLabels"/);
  assert.match(app, /createObjectStore\('productMedia'/);
  assert.match(app, /function previewProductLabels/);
  assert.match(app, /const CODE39=/);
  assert.match(app, /BioFlowDocs\?\.present/);
});

test('movimientos conserva evidencias auditables y las incorpora al comprobante', () => {
  const html = read('index.html'), app = read('app.js'), audit = read('audit.js'), preview = read('document-preview.js');
  assert.match(html, /id="movementEvidence"[^>]+multiple/);
  assert.match(html, /id="evidenceDialog"/);
  assert.match(app, /createObjectStore\('movementEvidence'/);
  assert.match(app, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(audit, /evidencia.*huella SHA-256/);
  assert.match(preview, /huellas SHA-256/);
});

test('la selección rechaza más de cinco archivos en vez de omitirlos silenciosamente', () => {
  const app = read('app.js');
  assert.match(app, /incoming\.length<=5&&allowed/);
});
