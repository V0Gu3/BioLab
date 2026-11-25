(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioCommercialMoney = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const round = value => Math.round((n(value) + Number.EPSILON) * 100) / 100;
  function taxRate(record) {
    if (record.taxRate != null && record.taxRate !== '') return Math.max(0, n(record.taxRate));
    const buckets = record.totalsByCurrency || record.byCurrency || [];
    const taxable = buckets.reduce((sum, row) => sum + n(row.taxable ?? (n(row.subtotal) - n(row.discountTotal))), 0);
    if (taxable > 0) return round(buckets.reduce((sum, row) => sum + n(row.taxAmount), 0) / taxable * 100);
    const base = (record.items || []).reduce((sum, item) => sum + n(item.quantity) * n(item.unitPrice) * (1 - n(item.discount) / 100), 0);
    if (base > 0 && record.total != null && n(record.total) >= base - 0.01) return Math.max(0, Math.round((n(record.total) / base - 1) * 100));
    return 16;
  }
  function snapshot(record = {}, quotations = []) {
    const ids = (record.quotationIds || [record.quotationId]).filter(Boolean).map(String);
    const origins = quotations.filter(quote => ids.includes(String(quote.id)));
    const buckets = new Map();
    const items = (record.items || []).map(item => {
      const source = (item.sources || []).find(source => source.quotationId);
      const quote = origins.find(quote => String(quote.id) === String(source?.quotationId)) || (origins.length === 1 ? origins[0] : null);
      const original = quote?.items?.[n(source?.quotationLineNo) - 1] || quote?.items?.find(line => (item.productId && String(line.productId) === String(item.productId)) || (item.sku && line.sku === item.sku) || (item.number && line.number === item.number));
      const quantity = Math.max(0, n(item.quantity)), unitPrice = round(item.unitPrice ?? item.price), discount = Math.min(100, Math.max(0, n(item.discount ?? original?.discount))), rate = quote ? taxRate(quote) : item.taxRate == null ? taxRate(record) : n(item.taxRate);
      const explicitDiscount = item.discountTotal ?? item.lineDiscount ?? item.discountAmount;
      const subtotal = round(quantity * unitPrice), discountTotal = round(Math.min(subtotal, Math.max(0, explicitDiscount == null ? subtotal * discount / 100 : n(explicitDiscount)))), taxable = round(subtotal - discountTotal), taxAmount = round(taxable * rate / 100), total = round(taxable + taxAmount), currency = String(item.currency || item.sourceCurrency || quote?.currency || record.currency || 'MXN').toUpperCase();
      const row = buckets.get(currency) || { currency, subtotal: 0, discountTotal: 0, taxable: 0, taxAmount: 0, total: 0 };
      for (const [key, amount] of Object.entries({ subtotal, discountTotal, taxable, taxAmount, total })) row[key] = round(row[key] + amount);
      buckets.set(currency, row);
      return { ...item, quantity, unitPrice, discount, discountTotal, subtotal, taxable, taxRate: rate, taxAmount, total, lineTotal: total, currency };
    });
    const totalsByCurrency = [...buckets.values()], single = totalsByCurrency.length === 1 ? totalsByCurrency[0] : null;
    return { ...record, items, totalsByCurrency, currency: single?.currency || (totalsByCurrency.length > 1 ? 'MULTI' : record.currency || 'MXN'), ...(single || {}), taxRate: items.length && items.every(item => item.taxRate === items[0].taxRate) ? items[0].taxRate : null };
  }
  return { round, taxRate, snapshot };
});
