(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioInternalOrdersReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = value => String(value ?? '').trim();
const key = value => text(value).toLocaleLowerCase('es-MX');
const dateKey = value => text(value).slice(0, 10);
const cancelled = record => record?.cancelled === true || ['cancelled', 'canceled', 'annulled', 'void'].includes(key(record?.status));

function deliveryStatus(requested, delivered, isCancelled) {
  if (isCancelled) return 'cancelled';
  if (requested <= 0 || delivered <= 0) return 'none';
  return delivered >= requested ? 'complete' : 'partial';
}

function ownsRecord() { return true; }

function buildInternalOrdersReport(state = {}, user, filters = {}) {
  const operations = state['nexo-order-operations-v1'] || {};
  const requisitions = Array.isArray(operations.requisitions) ? operations.requisitions : [];
  const lines = Array.isArray(operations.orderLines) ? operations.orderLines : [];
  const supplierOrders = Array.isArray(operations.supplierOrders) ? operations.supplierOrders : [];
  const supplierLines = Array.isArray(operations.supplierOrderLines) ? operations.supplierOrderLines : [];
  const shipments = Array.isArray(operations.shipments) ? operations.shipments : [];
  const clientOrders = Array.isArray(state['nexo-commercial-orders']) ? state['nexo-commercial-orders'] : [];
  const clients = Array.isArray(state['nexo-clients']) ? state['nexo-clients'] : [];
  const clientById = new Map(clientOrders.map(order => [String(order.id), order]));
  const supplierById = new Map(supplierOrders.map(order => [String(order.id), order]));
  const lineById = new Map(lines.map(line => [String(line.id), line]));
  const query = key(filters.query);
  const from = dateKey(filters.from), to = dateKey(filters.to), month = text(filters.month), year = text(filters.year);
  const matches = value => !query || key(value).includes(query);

  const records = requisitions.filter(request => request?.source === 'quotation_client_order' || request?.type === 'customer_order').map(request => {
    const clientOrder = clientById.get(String(request.clientOrderId || request.id)) || {};
    const client = clients.find(item => String(item.id) === String(clientOrder.clientId || request.clientId)) || clients.find(item => key(item.name) === key(request.customerName || clientOrder.client));
    const requestLines = lines.filter(line => String(line.requisitionId) === String(request.id));
    const savedTotals = Array.isArray(clientOrder.totalsByCurrency) ? clientOrder.totalsByCurrency.filter(entry => entry?.currency) : [], lineCurrencies = [...new Set(requestLines.map(line => text(line.currency)).filter(Boolean))], reportCurrency = clientOrder.currency || (savedTotals.length === 1 ? savedTotals[0].currency : lineCurrencies.length === 1 ? lineCurrencies[0] : lineCurrencies.length > 1 ? 'MULTI' : 'MXN'), reportAmount = clientOrder.total != null && reportCurrency !== 'MULTI' ? n(clientOrder.total) : savedTotals.length === 1 ? n(savedTotals[0].total) : reportCurrency !== 'MULTI' ? requestLines.reduce((sum, line) => sum + n(line.total), 0) : 0;
    const lineIds = new Set(requestLines.map(line => String(line.id)));
    const relatedSupplierLines = supplierLines.filter(link => { const order = supplierById.get(String(link.supplierOrderId)); return lineIds.has(String(link.orderLineId)) && order && !cancelled(order) && order.status !== 'draft' && (order.locked || order.confirmedAt || ['confirmed', 'partially_received', 'received', 'purchased'].includes(order.status)); });
    const purchasedByLine = new Map();
    relatedSupplierLines.forEach(link => purchasedByLine.set(String(link.orderLineId), (purchasedByLine.get(String(link.orderLineId)) || 0) + Math.max(0, n(link.quantity) - n(link.quantityCancelled))));
    const relatedShipments = shipments.filter(shipment => String(shipment.requisitionId) === String(request.id) && !cancelled(shipment));
    const deliveredByLine = new Map();
    relatedShipments.forEach(shipment => (shipment.items || []).forEach(item => {
      if (!lineIds.has(String(item.orderLineId))) return;
      deliveredByLine.set(String(item.orderLineId), (deliveredByLine.get(String(item.orderLineId)) || 0) + Math.max(0, n(item.quantity)));
    }));
    const products = requestLines.map(line => {
      const requested = Math.max(0, n(line.quantityRequested) - n(line.quantityCancelled));
      const delivered = deliveredByLine.get(String(line.id)) || 0;
      const purchaseRequired = Math.max(0, requested - n(line.reservedQuantity)), purchased = Math.min(purchaseRequired, Math.max(purchasedByLine.get(String(line.id)) || 0, n(line.quantityPurchased), n(line.quantityReceived), Math.max(0, delivered - n(line.reservedQuantity))));
      return { lineId: line.id, productId: line.productId || null, sku: line.catalog || line.sku || '', product: line.description || 'Producto sin descripción', unit: line.unit || 'unidad', requested, purchased, delivered, pending: Math.max(0, requested - delivered), overDelivery: Math.max(0, delivered - requested), deliveryStatus: deliveryStatus(requested, delivered, cancelled(request)) };
    });
    const supplierOrderIds = [...new Set(relatedSupplierLines.map(link => String(link.supplierOrderId)))];
    const purchaseOrders = supplierOrderIds.map(id => {
      const order = supplierById.get(id) || {};
      const lineItems = relatedSupplierLines.filter(link => String(link.supplierOrderId) === id).map(link => ({ ...link, product: products.find(product => String(product.lineId) === String(link.orderLineId)) }));
      return { id, supplier: order.supplierName || 'Sin proveedor', date: order.confirmedAt || order.createdAt || '', status: order.status || 'draft', items: lineItems };
    });
    const remissions = relatedShipments.map(shipment => ({ id: shipment.folio || shipment.id, date: shipment.deliveredAt || shipment.date || '', status: shipment.status || shipment.type || 'registered', evidenceId: shipment.evidenceId || null, items: (shipment.items || []).filter(item => lineIds.has(String(item.orderLineId))).map(item => ({ ...item, product: products.find(product => String(product.lineId) === String(item.orderLineId)) })) }));
    const requested = products.reduce((total, product) => total + product.requested, 0), delivered = products.reduce((total, product) => total + product.delivered, 0);
    const delivery = deliveryStatus(requested, delivered, cancelled(request));
    return { id: request.id, date: request.requestDate || dateKey(request.createdAt), quotationId: request.quotationId || clientOrder.quotationId || '', clientOrderId: request.clientOrderId || clientOrder.id || '', clientNumber: client?.internalNumber || client?.number || '', client: request.customerName || clientOrder.client || client?.name || 'Sin cliente', seller: request.responsible || clientOrder.seller || clientOrder.createdBy || '', amount: reportAmount, currency: reportCurrency, amountLabel: reportCurrency === 'MULTI' ? 'Totales por divisa' : 'Total con IVA', status: request.status || 'draft', deliveryStatus: delivery, requested, delivered, pending: Math.max(0, requested - delivered), overDelivery: Math.max(0, delivered - requested), products, purchaseOrders, remissions, owner: clientOrder };
  }).filter(record => ownsRecord(record.owner, user));

  const filtered = records.filter(record => {
    const date = dateKey(record.date);
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (!from && !to && month && date.slice(5, 7) !== month.padStart(2, '0')) return false;
    if (!from && !to && year && date.slice(0, 4) !== year) return false;
    if (filters.status && record.status !== filters.status) return false;
    if (filters.deliveryStatus && record.deliveryStatus !== filters.deliveryStatus) return false;
    if (filters.client && ![record.clientNumber, record.client].some(matches)) return false;
    if (filters.product && !record.products.some(product => String(product.productId || '') === String(filters.product))) return false;
    if (filters.seller && !matches(record.seller)) return false;
    if (filters.order && !matches(record.id)) return false;
    if (filters.supplierOrder && !record.purchaseOrders.some(order => matches(order.id))) return false;
    return !query || [record.id, record.quotationId, record.clientNumber, record.client, record.seller, ...record.purchaseOrders.map(order => order.id), ...record.products.flatMap(product => [product.sku, product.product])].some(matches);
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  const summary = { total: filtered.length, inProgress: filtered.filter(record => !['closed', 'cancelled', 'delivered', 'invoiced'].includes(record.status)).length, partial: filtered.filter(record => record.deliveryStatus === 'partial').length, complete: filtered.filter(record => record.deliveryStatus === 'complete').length, none: filtered.filter(record => record.deliveryStatus === 'none').length };
  return { records: filtered, summary };
}

function paginateReport(report, page = 1, pageSize = 50) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 50)), total = report.records.length, pages = Math.max(1, Math.ceil(total / size)), current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { ...report, records: report.records.slice((current - 1) * size, current * size), pagination: { page: current, pageSize: size, total, pages } };
}

  return { buildInternalOrdersReport, paginateReport };
});
