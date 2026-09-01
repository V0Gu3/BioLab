const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadHelp() {
  const window = {}, document = { body: null };
  vm.runInNewContext(fs.readFileSync(require.resolve('../money-help.js'), 'utf8'), { window, document });
  return window.BioMoneyHelp;
}

test('interpreta montos en los formatos utilizados por Bio', () => {
  const help = loadHelp();
  assert.equal(help.parseAmount('$1,250.50'), 1250.5);
  assert.equal(help.parseAmount('EUR 1.250,50'), 1250.5);
  assert.equal(help.parseAmount('− $320.00'), -320);
  assert.equal(help.amountFromText('USD $100.00 → MXN $1,700.00'), 1700);
});

test('convierte un monto a todas las divisas con la tasa congelada', () => {
  const help = loadHelp(), record = { rates: { MXN: 1, USD: 17, CAD: 12.5, EUR: 20 } };
  const values = help.convert(100, 'USD', record);
  assert.equal(values.MXN, 1700);
  assert.equal(values.USD, 100);
  assert.equal(values.CAD, 136);
  assert.equal(values.EUR, 85);
  const details = help.conversionDetails(100, 'USD', record);
  assert.equal(details.MXN.amount, 1700);
  assert.equal(details.MXN.percentage, 1700);
  assert.equal(details.EUR.percentage, 85);
});
