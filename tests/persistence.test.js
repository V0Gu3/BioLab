const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('carga la persistencia antes que acceso y conserva modo local sin API', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8'), source = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.ok(html.indexOf('persistence.js') < html.indexOf('access.js'));
  assert.match(source, /\/api\/bootstrap/); assert.match(source, /\/api\/import-local/); assert.match(source, /Storage\.prototype\.setItem/);
  assert.match(source, /If-None-Match/); assert.match(source, /nexo-bootstrap-cache-v2/);
  assert.match(source, /X-Bio-State-Revisions/); assert.match(source, /X-Bio-State-Keys/);
  assert.match(source, /nexo-bootstrap-active-workspace-v1/); assert.match(source, /response\.removedKeys/);
  assert.match(source, /AbortController/); assert.match(source, /bootstrapPromise/); assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.match(source, /BioAuth\?\.user\?\.\(\)/);
  assert.match(source, /const unchanged = [\s\S]*?this\.getItem\(normalizedKey\) === normalizedValue/);
  assert.match(source, /!unchanged\) queue\(normalizedKey, normalizedValue\)/);
  assert.match(source, /error\.status === 409[\s\S]*?needsReconciliation = true/);
  assert.match(source, /\/api\/state-batch/);
  assert.match(source, /Object\.fromEntries\(entries\.map/);
  assert.doesNotMatch(source, /timer = setTimeout\(flush, 1800\)/);
  assert.match(source, /if \(needsReconciliation\)[\s\S]*?await bootstrap\(\)/);
  assert.doesNotMatch(source, /error\.status === 409[\s\S]{0,240}nativeRemove\.call\(root\.localStorage, activeWorkspaceKey\(\)\)/);
  assert.match(source, /cached\?\.revisions && result\?\.revision/);
  assert.match(source, /root\.BioAuth\?\.user/);
  assert.match(source, /return \{ changed \}/);
  assert.match(source, /Base central conectada/); assert.match(source, /Persistencia local/);
});

test('una hidratación distinta recarga una sola vez para descartar variables locales obsoletas', () => {
  const auth = fs.readFileSync(require.resolve('../auth.js'), 'utf8');
  assert.match(auth, /bio-hydration-reload-v1/);
  assert.match(auth, /result\?\.changed/);
  assert.match(auth, /sessionStorage\.setItem[\s\S]*?location\.reload/);
  assert.match(auth, /sessionStorage\.removeItem/);
});

test('activar un pedido refleja la respuesta sin reenviar un estado completo obsoleto', () => {
  const source = fs.readFileSync(require.resolve('../internal-orders.js'), 'utf8');
  assert.match(source, /BioPersistence\?\.suspendWrites/);
  assert.match(source, /suspendWrites\(reflect\)/);
});

test('los guardados y permisos evitan descargar estados completos innecesarios', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const db = fs.readFileSync(require.resolve('../server/db.js'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');
  const batchRoute = server.slice(server.indexOf("pathname === '/api/state-batch'"), server.indexOf("pathname.startsWith('/api/state/')"));
  const stateRoute = server.slice(server.indexOf("pathname.startsWith('/api/state/')"), server.indexOf("pathname.startsWith('/api/auth/users/')"));
  assert.match(server, /async function readPermissionState[\s\S]*?readStateKeys\(db, \['nexo-access-v1'\]\)/);
  assert.match(batchRoute, /readWriteContext/); assert.doesNotMatch(batchRoute, /readState\(db/);
  assert.match(stateRoute, /readWriteContext/); assert.doesNotMatch(stateRoute, /readState\(db/);
  assert.match(db, /listClientQuotations[\s\S]*?readStateKeys/);
  assert.match(db, /createInternalOrder[\s\S]*?readStateKeys/);
  assert.doesNotMatch(app, /bio:persistence-changed[^\n]*refreshOperationalInsights/);
  assert.match(app, /operationalInsightsLastRefresh<30000/);
  assert.match(app, /view==='panel'\)refreshOperationalInsights/);
});

test('las condiciones comerciales predeterminadas se sincronizan y se versionan sin alterar cotizaciones previas', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const db = fs.readFileSync(require.resolve('../server/db.js'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');
  const persistence = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.match(app, /quotationTermsStateKey='nexo-quotation-terms-v1'/);
  assert.match(app, /termsVersion:quotationTermsSettings\.version/);
  assert.match(app, /Afecta solo cotizaciones nuevas/);
  assert.match(app, /quotation-terms-required-note/);
  assert.match(app, /payment-condition-token/);
  assert.match(app, /contentEditable='false'/);
  assert.match(app, /paymentTermsEditorValue/);
  assert.doesNotMatch(app, /Condiciones de pago <em>obligatorio<\/em>/);
  assert.match(app, /quotationTermsEditingExisting/);
  assert.match(persistence, /nexo-quotation-terms-v1/);
  assert.match(db, /nexo-quotation-terms-v1/);
  assert.match(server, /'nexo-quotation-terms-v1': 'system_config'/);
});
