const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const calculation = app.match(/function roundQuotationMoney[\s\S]*?(?=function currencyAmountLabel)/);

function quotationTotals(items, taxRate) {
  assert.ok(calculation, 'No se encontró el cálculo monetario de cotizaciones.');
  const context = {};
  vm.runInNewContext(`${calculation[0]} globalThis.calculateQuotationTotals=quotationTotals;`, context);
  return context.calculateQuotationTotals(items, taxRate);
}

test('aceptación: una cotización con tres decimales redondea partida, IVA y total a dos decimales', () => {
  const totals = quotationTotals([
    { quantity: 1, unitPrice: 14376.647, discount: 0, currency: 'MXN' }
  ], 16);

  assert.equal(totals.subtotal, 14376.65);
  assert.equal(totals.taxAmount, 2300.26);
  assert.equal(totals.total, 16676.91);
});

test('aceptación: el total conserva la suma de partidas ya redondeadas', () => {
  const totals = quotationTotals([
    { quantity: 1, unitPrice: 0.335, discount: 0, currency: 'MXN' },
    { quantity: 1, unitPrice: 0.335, discount: 0, currency: 'MXN' }
  ], 0);

  assert.equal(totals.subtotal, 0.68);
  assert.equal(totals.total, 0.68);
});

test('aceptación: un descuento monetario se conserva y el IVA se calcula sobre la base descontada', () => {
  const totals = quotationTotals([
    { quantity: 2, unitPrice: 667.484, discountAmount: 100, currency: 'CAD' }
  ], 16);

  assert.equal(totals.subtotal, 1334.96);
  assert.equal(totals.discountTotal, 100);
  assert.equal(totals.taxable, 1234.96);
  assert.equal(totals.taxAmount, 197.59);
  assert.equal(totals.total, 1432.55);
});
