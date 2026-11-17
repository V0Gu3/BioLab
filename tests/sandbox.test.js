const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('el área de pruebas usa los módulos reales con datos aislados de la operación', () => {
  const workspace = fs.readFileSync(require.resolve('../workspace.js'), 'utf8');
  const bootstrap = fs.readFileSync(require.resolve('../workspace-bootstrap.js'), 'utf8');
  const persistence = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.doesNotMatch(workspace, /bio-workspace-training-data-v1/);
  assert.doesNotMatch(workspace, /bio-workspace-operational-backup-v1/);
  assert.match(bootstrap, /__BIO_TRAINING__/);
  assert.match(persistence, /root\.__BIO_TRAINING__ \? 'training' : 'operational'/);
  assert.match(workspace, /conjunto central independiente/);
  assert.match(persistence, /X-Bio-Workspace/);
  assert.match(persistence, /ownsLocalState/);
  assert.match(persistence, /workspace\(\) === 'operational'/);
  assert.match(persistence, /const suspendWrites/);
});

test('la interfaz identifica claramente el entorno de entrenamiento', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const bootstrap = fs.readFileSync(require.resolve('../workspace-bootstrap.js'), 'utf8');
  const workspace = fs.readFileSync(require.resolve('../workspace.js'), 'utf8');
  assert.match(html, /id="workspaceSwitcher"/); assert.match(html, /data-workspace-mode="training"/);
  assert.match(html, /id="workspaceSwitcher" aria-busy="true"/);
  assert.match(html, /id="workspaceCurrentLabel">Cargando…/);
  assert.match(bootstrap, /document\.documentElement\.dataset\.workspace/);
  assert.match(workspace, /removeAttribute\('aria-busy'\)/);
  assert.match(html, /id="trainingWorkspaceNotice"/);
  assert.doesNotMatch(html, /class="nav-item sandbox-nav"/);
  assert.match(html, /Nada se registra en la operación ni en auditoría/);
});

test('el selector mantiene el control de habilitación únicamente para el administrador', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const workspace = fs.readFileSync(require.resolve('../workspace.js'), 'utf8');
  assert.match(html, /id="workspaceSandboxEnabled"/);
  assert.match(workspace, /\['administrator', 'developer'\]\.includes\(user\?\.role\)/);
  assert.match(workspace, /access\.can\('sandbox', user\)/);
  assert.match(workspace, /\[data-view="auditView"\]/);
});

test('el pedido interno de pruebas selecciona cotizaciones de capacitación sin consultar operación', () => {
  const workflow = fs.readFileSync(require.resolve('../internal-orders.js'), 'utf8');
  assert.match(workflow, /const inTraining/);
  assert.match(workflow, /BioQuotationConversion\?\.isExpired/);
  assert.match(workflow, /!quoteExpired\(quote\)/);
  assert.match(workflow, /function availableQuotationsFor/);
  assert.match(workflow, /if \(inTraining\(\)\) \{[\s\S]*?state\.quotations = availableQuotationsFor\(client\)/);
});

test('la API permite pedidos internos en capacitación sin abrir consultas operativas', () => {
  const server = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');
  const database = fs.readFileSync(require.resolve('../server/db.js'), 'utf8');
  assert.doesNotMatch(server, /\(\?:internal-orders\|search\\\/internal-orders/);
  assert.match(server, /createInternalOrder\(db, await readJson\(request\), authenticated, workspace\)/);
  assert.match(database, /createInternalOrder\(db, input, user, workspace = 'operational'\)/);
  assert.match(database, /if \(workspace !== 'training'\) await rebuildMaterialized/);
});

test('pruebas no consulta paneles operativos y el service worker nunca cachea la API', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const reports = fs.readFileSync(require.resolve('../reports.js'), 'utf8');
  const worker = fs.readFileSync(require.resolve('../service-worker.js'), 'utf8');
  assert.match(app, /refreshOperationalInsights\(options=\{\}\)[\s\S]*?window\.__BIO_TRAINING__/);
  assert.match(reports, /if \(inTraining\(\)\) \{[\s\S]*?buildInternalOrdersReport\(trainingState\(\)/);
  assert.match(reports, /async function reportData[\s\S]*?if \(inTraining\(\)\)[\s\S]*?return core\.paginateReport/);
  assert.doesNotMatch(reports, /reporte consolidado consulta exclusivamente la operación real/);
  assert.doesNotMatch(reports, /exportación consolidada está disponible en el espacio Operativo/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /probiolab-shell-v2/);
  assert.doesNotMatch(worker, /cached\|\|caches\.match\('\/index\.html'\)/);
});

test('el arranque retira el service worker anterior antes de validar la sesión', () => {
  const auth = fs.readFileSync(require.resolve('../auth.js'), 'utf8');
  const cleanup = fs.readFileSync(require.resolve('../service-worker-cleanup.js'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const login = fs.readFileSync(require.resolve('../login.html'), 'utf8');
  const vercel = fs.readFileSync(require.resolve('../vercel.json'), 'utf8');
  assert.match(auth, /await root\.__bioServiceWorkerCleanup/);
  assert.match(cleanup, /getRegistrations\(\)/);
  assert.match(cleanup, /registration => registration\.unregister\(\)/);
  assert.match(cleanup, /key\.startsWith\('probiolab-'\)/);
  assert.doesNotMatch(app, /serviceWorker\.register/);
  assert.match(login, /service-worker-cleanup\.js\?v=20261107-1/);
  assert.match(login, /auth\.js\?v=20261107-1/);
  assert.match(vercel, /"source": "\/login\.html"[\s\S]*?"value": "no-store/);
});
