const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('el área de pruebas usa los módulos reales con datos aislados de la operación', () => {
  const workspace = fs.readFileSync(require.resolve('../workspace.js'), 'utf8');
  const bootstrap = fs.readFileSync(require.resolve('../workspace-bootstrap.js'), 'utf8');
  const persistence = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.match(workspace, /bio-workspace-training-data-v1/);
  assert.match(workspace, /bio-workspace-operational-backup-v1/);
  assert.match(workspace, /captureData\(\)/); assert.match(workspace, /restoreData\(/);
  assert.match(bootstrap, /__BIO_TRAINING__/);
  assert.match(persistence, /!root\.__BIO_TRAINING__/);
});

test('la interfaz identifica claramente el entorno de entrenamiento', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /id="workspaceSwitcher"/); assert.match(html, /data-workspace-mode="training"/);
  assert.match(html, /id="trainingWorkspaceNotice"/);
  assert.doesNotMatch(html, /class="nav-item sandbox-nav"/);
  assert.match(html, /Nada se registra en la operación ni en auditoría/);
});

test('el selector mantiene el control de habilitación únicamente para el administrador', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const workspace = fs.readFileSync(require.resolve('../workspace.js'), 'utf8');
  assert.match(html, /id="workspaceSandboxEnabled"/);
  assert.match(workspace, /user\?\.role === 'administrator'/);
  assert.match(workspace, /access\.can\('sandbox', user\)/);
  assert.match(workspace, /\[data-view="auditView"\]/);
});
