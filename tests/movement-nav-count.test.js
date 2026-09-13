const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('el menú muestra el número real de movimientos integrados', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(html, /id="navMovementCount">0</);
  assert.match(app, /\$\('#navMovementCount'\)\.textContent=integratedMovements\.length/);
  assert.doesNotMatch(html, /nav-badge">8</);
});
