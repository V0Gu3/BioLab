const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('conserva confirmaciones visuales y revisables de las operaciones', () => {
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(source, /bio-operation-feedback-v1/);
  assert.match(source, /operationFeedbackButton/);
  assert.match(source, /Confirmaciones de esta sesión/);
  assert.match(source, /feedbackKind/);
});
