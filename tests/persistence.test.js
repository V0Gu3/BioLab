const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('carga la persistencia antes que acceso y conserva modo local sin API', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8'), source = fs.readFileSync(require.resolve('../persistence.js'), 'utf8');
  assert.ok(html.indexOf('persistence.js') < html.indexOf('access.js'));
  assert.match(source, /\/api\/bootstrap/); assert.match(source, /\/api\/import-local/); assert.match(source, /Storage\.prototype\.setItem/);
  assert.match(source, /Base central conectada/); assert.match(source, /Persistencia local/);
});
