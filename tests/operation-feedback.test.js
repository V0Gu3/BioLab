const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('las confirmaciones son temporales y no dejan texto flotante entre pantallas', () => {
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(source, /bio-operation-feedback-v1/);
  assert.match(source, /hideCrossScreenOperationFeedback/);
  assert.match(source, /sessionStorage\.removeItem\(OPERATION_FEEDBACK_KEY\)/);
  assert.match(source, /feedbackKind/);
});
