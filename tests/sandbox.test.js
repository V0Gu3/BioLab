const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('el área de pruebas está aislada de la persistencia operativa', () => {
  const sandbox = fs.readFileSync(require.resolve('../sandbox.js'), 'utf8'), persistence = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.match(sandbox, /bio-sandbox-v1/);
  assert.doesNotMatch(persistence, /bio-sandbox-v1/);
  assert.match(sandbox, /TEST-COT/); assert.match(sandbox, /TEST-OC/); assert.match(sandbox, /TEST-OCP/); assert.match(sandbox, /TEST-REM/);
});

test('la interfaz identifica claramente el entorno de entrenamiento', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8'), css = fs.readFileSync(require.resolve('../sandbox.css'), 'utf8');
  assert.match(html, /id="sandboxView"/); assert.match(html, /ENTORNO AISLADO/); assert.match(html, /MODO PRUEBA/); assert.match(fs.readFileSync(require.resolve('../sandbox.js'), 'utf8'), /SIN VALIDEZ/);
  assert.match(css, /--bio-primary/); assert.match(css, /--bio-surface/); assert.match(css, /--bio-border/);
});

test('cada evento de prueba ofrece un comprobante descargable individual', () => {
  const sandbox = fs.readFileSync(require.resolve('../sandbox.js'), 'utf8'), html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(sandbox, /data-sandbox-download/);
  assert.match(sandbox, /inventory_entry/); assert.match(sandbox, /inventory_exit/);
  assert.match(sandbox, /BioFlowDocs\[preview \? 'preview' : 'download'\]\(kind/);
  assert.match(sandbox, /downloadEvent/);
  assert.match(sandbox, /data-sandbox-preview/); assert.match(sandbox, /preview \? 'preview' : 'download'/);
  assert.match(html, /COMPROBANTE/); assert.match(html, /Previsualizar expediente completo/);
});
