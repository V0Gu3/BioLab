const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('la interfaz usa una sola familia tipográfica en todas las vistas', () => {
  const css = fs.readFileSync(require.resolve('../typography.css'), 'utf8');
  const app = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const login = fs.readFileSync(require.resolve('../login.html'), 'utf8');
  assert.match(css, /body \*/);
  assert.match(css, /font-family: var\(--bio-interface-font\) !important/);
  assert.match(app, /typography\.css/);
  assert.match(login, /typography\.css/);
});
