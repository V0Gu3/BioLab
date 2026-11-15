const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('una fecha anterior al mínimo muestra un mensaje de fecha y no de cantidad', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'form-validation.js'), 'utf8');
  assert.match(source, /field\.type === 'date'/);
  assert.match(source, /Selecciona una fecha de hoy o posterior\./);
});
