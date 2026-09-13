(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioOrdersCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const ORDER_STATUSES = Object.freeze([
    'draft', 'confirmed', 'purchasing', 'partially_purchased', 'purchased',
    'partially_received', 'received', 'inventory_reserved', 'ready_to_deliver',
    'partially_delivered', 'delivered', 'partially_invoiced', 'invoiced', 'closed', 'cancelled',
  ]);
  const STATUS_LABELS = Object.freeze({
    draft: 'Borrador', confirmed: 'Confirmado', purchasing: 'En compra',
    partially_purchased: 'Parcialmente comprado', purchased: 'Comprado',
    partially_received: 'Parcialmente recibido', received: 'Recibido',
    inventory_reserved: 'Reservado en inventario', ready_to_deliver: 'Listo para entregar',
    partially_delivered: 'Parcialmente entregado', delivered: 'Entregado',
    partially_invoiced: 'Parcialmente facturado', invoiced: 'Facturado', closed: 'Cerrado',
    cancelled: 'Cancelado',
  });
  const ROLE_PERMISSIONS = Object.freeze({
    viewer: ['read'], capture: ['read', 'edit'], purchasing: ['read', 'purchase'],
    receiving: ['read', 'receive'], inventory: ['read', 'inventory'], billing: ['read', 'invoice'],
    delivery: ['read', 'deliver'], cancellation: ['read', 'cancel'],
    admin: ['read', 'edit', 'purchase', 'receive', 'inventory', 'invoice', 'deliver', 'cancel', 'admin'],
    administrator: ['read', 'edit', 'purchase', 'receive', 'inventory', 'invoice', 'deliver', 'cancel', 'admin'],
    supervisor: ['read', 'edit', 'purchase', 'receive', 'inventory', 'invoice', 'deliver', 'cancel'],
    seller: ['read', 'edit'],
  });
  const hasPermission = (role, permission) => (ROLE_PERMISSIONS[role] || []).includes(permission);

  const normalizeText = value => String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const present = value => value !== null && value !== undefined && String(value).trim() !== '';
  const numberValue = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!present(value)) return 0;
    const normalized = String(value).replace(/[^0-9.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const hashString = value => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const excelDateToISO = value => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 30000 || value > 70000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return date.toISOString().slice(0, 10);
  };
  const dateResult = value => {
    if (!present(value)) return { value: null, valid: true, raw: null };
    const parsed = excelDateToISO(value);
    return { value: parsed, valid: Boolean(parsed), raw: value };
  };
  const parseSupplierAmount = value => {
    if (!present(value)) return { amountOriginal: null, currency: null };
    const text = String(value);
    const currency = /USD|US\$|DOLAR/i.test(text) ? 'USD'
      : /CAD|C\$|CANAD/i.test(text) ? 'CAD'
        : /EUR|EURO|€/i.test(text) ? 'EUR' : 'MXN';
    return { amountOriginal: numberValue(value), currency };
  };
  const classifyBilling = value => {
    const raw = cleanText(value);
    const normalized = normalizeText(raw);
    if (!raw || normalized === 'STOCK') return { type: null, folio: null, accountReference: null, observation: raw || null };
    if (/\b(MC|MANEJO DE CUENTA|CARGO|CARGAR|DESCARGO)\b/.test(normalized)) {
      const match = normalized.match(/MC\s*[-#:]?\s*(\d+)/);
      return { type: 'account_charge', folio: null, accountReference: match ? `MC-${match[1]}` : null, observation: raw };
    }
    return { type: 'standard', folio: raw, accountReference: null, observation: null };
  };
  const calculateLineTotals = ({ quantity = 0, unitPrice = 0, taxRate = 0 }) => {
    const subtotal = Math.round(numberValue(quantity) * numberValue(unitPrice) * 100) / 100;
    const taxAmount = Math.round(subtotal * numberValue(taxRate) / 100 * 100) / 100;
    return { subtotal, taxAmount, total: Math.round((subtotal + taxAmount) * 100) / 100 };
  };
  const validateProgress = ({ authorized, current = 0, amount, allowOverride = false }) => {
    const max = numberValue(authorized);
    const before = numberValue(current);
    const delta = numberValue(amount);
    if (delta <= 0) return { valid: false, code: 'INVALID_AMOUNT', message: 'La cantidad debe ser mayor que cero.' };
    if (!allowOverride && before + delta > max) return { valid: false, code: 'EXCEEDS_AUTHORIZED', message: `La operación excede la cantidad autorizada (${max}).` };
    return { valid: true, before, after: before + delta, remaining: Math.max(0, max - before - delta), overridden: before + delta > max };
  };

  const validateSupplierPurchaseGate = ({ requestType, clientOrderStatus }) => {
    if (requestType !== 'customer_order') return { valid: true, code: 'NOT_CUSTOMER_ORDER' };
    if (clientOrderStatus !== 'active') return { valid: false, code: 'CLIENT_ORDER_NOT_ACTIVE', message: 'Activa primero la OC del cliente vinculada a la cotización.' };
    return { valid: true, code: 'CLIENT_ORDER_ACTIVE' };
  };

  const planMixedFulfillment = ({ requested = 0, available = 0, alreadyReserved = 0 }) => {
    const demand = Math.max(0, numberValue(requested)), freeStock = Math.max(0, numberValue(available) - numberValue(alreadyReserved));
    const reservedQuantity = Math.min(demand, freeStock), quantityToPurchase = Math.max(0, demand - reservedQuantity);
    return { requested: demand, freeStock, reservedQuantity, quantityToPurchase, supplyOrigin: reservedQuantity > 0 && quantityToPurchase > 0 ? 'mixed' : reservedQuantity > 0 ? 'inventory' : 'supplier' };
  };

  const planWarehouseFulfillment = ({ requested = 0, warehouses = {}, reservedByWarehouse = {}, preferredWarehouse = '1' }) => {
    const demand = Math.max(0, numberValue(requested));
    const order = [...new Set([String(preferredWarehouse || '1'), '1', '2'])];
    let remaining = demand;
    const allocations = order.map(warehouseId => {
      const freeStock = Math.max(0, numberValue(warehouses[warehouseId]) - numberValue(reservedByWarehouse[warehouseId]));
      const quantity = Math.min(remaining, freeStock);
      remaining -= quantity;
      return { warehouseId, quantity, freeStock };
    }).filter(allocation => allocation.quantity > 0);
    const reservedQuantity = allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    const quantityToPurchase = Math.max(0, demand - reservedQuantity);
    return { requested: demand, allocations, reservedQuantity, quantityToPurchase, supplyOrigin: reservedQuantity > 0 && quantityToPurchase > 0 ? 'mixed' : reservedQuantity > 0 ? 'inventory' : 'supplier' };
  };

  const reconcileSupplierPurchase = ({ order, links = [], receipts = [], invoices = [] }) => {
    if (!order) return { status: 'missing_order', orderedQuantity: 0, receivedQuantity: 0, orderedAmount: 0, invoicedAmount: 0 };
    const scopedLinks = links.filter(link => String(link.supplierOrderId) === String(order.id));
    const lineIds = new Set(scopedLinks.map(link => String(link.orderLineId)));
    const scopedReceipts = receipts.filter(receipt => String(receipt.supplierOrderId) === String(order.id));
    const scopedInvoices = invoices.filter(invoice => (invoice.supplierOrderIds || []).map(String).includes(String(order.id)));
    const orderedQuantity = scopedLinks.reduce((sum, link) => sum + numberValue(link.quantity), 0);
    const receivedQuantity = scopedReceipts.flatMap(receipt => receipt.items || []).filter(item => lineIds.has(String(item.orderLineId))).reduce((sum, item) => sum + Math.max(0, numberValue(item.quantity) - numberValue(item.quantityRejected)), 0);
    const orderedAmount = Math.round(scopedLinks.reduce((sum, link) => sum + numberValue(link.quantity) * numberValue(link.unitPrice), 0) * 100) / 100;
    const invoicedAmount = Math.round(scopedInvoices.reduce((sum, invoice) => sum + numberValue(invoice.amountOriginal ?? invoice.amount ?? invoice.total), 0) * 100) / 100;
    const quantityStatus = receivedQuantity === 0 ? 'pending_receipt' : receivedQuantity < orderedQuantity ? 'partial' : receivedQuantity === orderedQuantity ? 'matched' : 'over_received';
    const invoiceStatus = !scopedInvoices.length ? 'pending_invoice' : Math.abs(invoicedAmount - orderedAmount) < 0.01 ? 'matched' : 'amount_mismatch';
    return { status: ['over_received', 'amount_mismatch'].includes(quantityStatus) || invoiceStatus === 'amount_mismatch' ? 'review' : quantityStatus === 'matched' && invoiceStatus === 'matched' ? 'matched' : 'pending', quantityStatus, invoiceStatus, orderedQuantity, receivedQuantity, pendingQuantity: Math.max(0, orderedQuantity - receivedQuantity), orderedAmount, invoicedAmount, amountDifference: Math.round((invoicedAmount - orderedAmount) * 100) / 100, receiptIds: scopedReceipts.map(receipt => receipt.id), invoiceIds: scopedInvoices.map(invoice => invoice.id || invoice.folio) };
  };

  const groupSupplierPurchaseLines = ({ lines = [], products = [], suppliers = [], relations = [], existingLineIds = [] }) => {
    const linked = new Set(existingLineIds.map(String)), grouped = new Map(), missing = [];
    lines.filter(line => !linked.has(String(line.id))).forEach(line => {
      const product = products.find(item => String(item.id) === String(line.productId)) || products.find(item => [item.number, item.sku].some(value => normalizeText(value) === normalizeText(line.catalog)));
      let relation = null;
      if (product && relations.length) {
        let candidates = relations.filter(item => String(item.productId) === String(product.id) && item.active !== false);
        if (line.supplierRelationId) candidates = candidates.filter(item => String(item.id) === String(line.supplierRelationId));
        if (line.supplierId) candidates = candidates.filter(item => String(item.supplierId) === String(line.supplierId));
        if (!line.supplierRelationId && !line.supplierId && line.catalog) { const exact = candidates.filter(item => normalizeText(item.supplierSku) === normalizeText(line.catalog)); if (exact.length) candidates = exact; }
        relation = candidates.find(item => item.preferred) || (candidates.length === 1 ? candidates[0] : null);
      }
      const supplierId = relation?.supplierId || (!relations.length ? product?.supplierId : null);
      const supplier = supplierId && suppliers.find(item => String(item.id) === String(supplierId) && item.active !== false && String(item.status || '').toLowerCase() !== 'inactive');
      if (!product || !supplier || (relations.length && !relation)) { missing.push({ line, product: product || null, supplier: supplier || null, relation, reason: !product ? 'PRODUCT_NOT_FOUND' : !relation ? 'RELATION_NOT_FOUND' : 'SUPPLIER_NOT_FOUND' }); return; }
      const currency = relation?.currency || product.priceCurrency || 'MXN';
      const warehouse = cleanText(line.deliveryWarehouse || line.warehouseId || '1') || '1';
      const requiredDate = cleanText(line.requiredDate || line.committedDate || 'sin-fecha') || 'sin-fecha';
      const paymentTerms = cleanText(line.purchasePaymentTerms || relation?.purchasePaymentTerms || product.purchasePaymentTerms || 'estandar') || 'estandar';
      const key = `${supplier.id}|${currency}|${warehouse}|${requiredDate}|${normalizeText(paymentTerms)}`;
      if (!grouped.has(key)) grouped.set(key, { key, supplier, currency, warehouse, requiredDate, paymentTerms, rows: [] });
      grouped.get(key).rows.push({ line, product, relation });
    });
    return { groups: [...grouped.values()], missing };
  };
  const deriveLineStatus = line => {
    const requested = numberValue(line.quantityRequested);
    const cancelled = numberValue(line.quantityCancelled);
    const authorized = Math.max(0, requested - cancelled);
    if (cancelled >= requested && requested > 0) return 'cancelled';
    const delivered = numberValue(line.quantityDelivered);
    const received = numberValue(line.quantityReceived), availableReceived = line.quantityAvailableReceived == null ? received : numberValue(line.quantityAvailableReceived), reserved = numberValue(line.reservedQuantity);
    const purchased = numberValue(line.quantityPurchased), covered = purchased + reserved, available = availableReceived + reserved;
    const invoiced = numberValue(line.quantityInvoiced);
    if (delivered >= authorized && authorized > 0 && invoiced >= authorized) return 'closed';
    if (invoiced >= authorized && authorized > 0) return 'invoiced';
    if (invoiced > 0) return 'partially_invoiced';
    if (delivered >= authorized && authorized > 0) return 'delivered';
    if (delivered > 0) return 'partially_delivered';
    if (reserved > 0 && available >= authorized && authorized > 0) return 'inventory_reserved';
    if (available >= authorized && authorized > 0) return 'ready_to_deliver';
    if (availableReceived > 0 && purchased >= Math.max(0, authorized - reserved)) return 'partially_received';
    if (covered >= authorized && authorized > 0) return 'purchased';
    if (covered > 0) return 'partially_purchased';
    return line.supplyOrigin === 'inventory' ? 'confirmed' : 'purchasing';
  };
  const deriveRequisitionStatus = lines => {
    if (!lines.length) return 'draft';
    const requested = lines.reduce((sum, line) => sum + numberValue(line.quantityRequested), 0);
    const cancelled = lines.reduce((sum, line) => sum + numberValue(line.quantityCancelled), 0);
    const authorized = Math.max(0, requested - cancelled);
    if (authorized === 0 && requested > 0) return 'cancelled';
    const reserved = lines.reduce((sum, line) => sum + Math.min(numberValue(line.reservedQuantity), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled))), 0);
    const purchased = lines.reduce((sum, line) => sum + Math.min(numberValue(line.quantityPurchased), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled) - numberValue(line.reservedQuantity))), 0);
    const received = lines.reduce((sum, line) => sum + Math.min(numberValue(line.quantityReceived), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled) - numberValue(line.reservedQuantity))), 0), availableReceived = lines.reduce((sum, line) => sum + Math.min(line.quantityAvailableReceived == null ? numberValue(line.quantityReceived) : numberValue(line.quantityAvailableReceived), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled) - numberValue(line.reservedQuantity))), 0), available = availableReceived + reserved, covered = purchased + reserved;
    const delivered = lines.reduce((sum, line) => sum + Math.min(numberValue(line.quantityDelivered), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled))), 0);
    const invoiced = lines.reduce((sum, line) => sum + Math.min(numberValue(line.quantityInvoiced), Math.max(0, numberValue(line.quantityRequested) - numberValue(line.quantityCancelled))), 0);
    if (delivered >= authorized && invoiced >= authorized) return 'closed';
    if (invoiced >= authorized) return 'invoiced';
    if (invoiced > 0) return 'partially_invoiced';
    if (delivered >= authorized) return 'delivered';
    if (delivered > 0) return 'partially_delivered';
    if (available >= authorized && reserved > 0) return 'inventory_reserved';
    if (available >= authorized) return 'ready_to_deliver';
    if (availableReceived > 0 && purchased >= Math.max(0, authorized - reserved)) return 'partially_received';
    if (covered >= authorized) return 'purchased';
    if (covered > 0) return 'partially_purchased';
    return lines.every(line => line.supplyOrigin === 'inventory') ? 'confirmed' : 'purchasing';
  };
  const isStockRow = values => [values[16], values[17], values[18], values[19]].some(value => normalizeText(value) === 'STOCK');
  const containsMarker = (values, marker) => values.some(value => normalizeText(value).includes(marker));
  const sourceCanonical = values => JSON.stringify(values.slice(0, 23).map(value => typeof value === 'string' ? cleanText(value) : value ?? null));

  const DEFAULT_MAPPING = Object.freeze({
    requestDate: 0, purchaseOrder: 1, purchaseOrderConfirmedAt: 2,
    supplierInvoice: 3, supplierInvoiceDate: 4, supplierInvoiceAmount: 5,
    supplierDeliveryDate: 6, supplier: 7, brand: 8, catalog: 9,
    product: 10, quantity: 11, unitPrice: 12, subtotal: 13, taxAmount: 14,
    total: 15, requisition: 16, contact: 17, institution: 18,
    customerInvoice: 19, customerInvoiceDate: 20, remision: 21, remisionDate: 22,
  });

  function simulateImport({ rows, fileHash, sheetName = 'SURTIR', mapping = DEFAULT_MAPPING, existingSourceHashes = [], defaultTaxRate = 16, exchangeRateMap = {} }) {
    const priorHashes = new Set(existingSourceHashes);
    const currentHashes = new Set();
    const results = [];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const values = rows[offset] || [];
      if (!values.slice(0, 23).some(present)) continue;
      const sourceRow = offset + 2;
      const sourceHash = hashString(`${sheetName}|${sourceCanonical(values)}`);
      const issues = [];
      const stock = isStockRow(values);
      const cancelled = containsMarker(values, 'CANCELADO');
      const deposit = containsMarker([values[mapping.purchaseOrder], values[mapping.supplierInvoice], values[mapping.supplier]], 'DEPOSITO');
      const requestDate = dateResult(values[mapping.requestDate]);
      const confirmedAt = dateResult(values[mapping.purchaseOrderConfirmedAt]);
      const supplierInvoiceDate = dateResult(values[mapping.supplierInvoiceDate]);
      const deliveryDate = dateResult(values[mapping.supplierDeliveryDate]);
      const customerInvoiceDate = dateResult(values[mapping.customerInvoiceDate]);
      const remisionDate = dateResult(values[mapping.remisionDate]);
      const invalidDates = [
        ['Fecha de solicitud', requestDate], ['Confirmación de OC', confirmedAt],
        ['Fecha factura proveedor', supplierInvoiceDate], ['Recepción/entrega proveedor', deliveryDate],
        ['Fecha factura cliente', customerInvoiceDate], ['Fecha de remisión', remisionDate],
      ].filter(([, result]) => !result.valid);
      invalidDates.forEach(([field, result]) => issues.push({ level: 'warning', code: 'INVALID_DATE', field, message: `“${result.raw}” no es una fecha válida.` }));
      const rawRequisition = cleanText(values[mapping.requisition]);
      const rawOrder = cleanText(values[mapping.purchaseOrder]);
      const rawSupplier = cleanText(values[mapping.supplier]);
      const catalog = cleanText(values[mapping.catalog]);
      const product = cleanText(values[mapping.product]);
      const institution = cleanText(values[mapping.institution]);
      const quantity = numberValue(values[mapping.quantity]);
      const requestCode = requestDate.value ? requestDate.value.replaceAll('-', '').slice(2) : 'SINFECHA';
      const requisitionFolio = stock
        ? `STK-${requestCode}-${rawOrder && normalizeText(rawOrder) !== 'DEPOSITO' ? rawOrder : sourceHash.slice(0, 4).toUpperCase()}`
        : rawRequisition;
      if (!product) issues.push({ level: 'error', code: 'MISSING_PRODUCT', field: 'Producto', message: 'La descripción del producto es obligatoria.' });
      if (quantity <= 0) issues.push({ level: 'error', code: 'INVALID_QUANTITY', field: 'Cantidad', message: 'La cantidad solicitada debe ser mayor que cero.' });
      if (!stock && !rawRequisition) issues.push({ level: 'error', code: 'MISSING_REQUISITION', field: 'Requisición', message: 'La fila no tiene folio de requisición.' });
      if (!stock && !institution) issues.push({ level: 'error', code: 'MISSING_CUSTOMER', field: 'Institución', message: 'La institución es obligatoria para pedidos de cliente.' });
      if (!rawSupplier || normalizeText(rawSupplier) === 'DEPOSITO') issues.push({ level: 'warning', code: 'MISSING_REAL_SUPPLIER', field: 'Proveedor', message: deposit ? 'DEPÓSITO se clasificó como modalidad; falta identificar el proveedor real.' : 'Falta proveedor.' });
      if (!rawOrder || normalizeText(rawOrder) === 'DEPOSITO') issues.push({ level: 'warning', code: 'MISSING_PURCHASE_ORDER', field: 'Orden de compra', message: 'No existe un folio de OC a proveedor.' });
      if (cancelled) issues.push({ level: 'warning', code: 'LEGACY_CANCELLED', field: 'Estado', message: 'Se importará cancelado y requerirá motivo de depuración.' });
      const unitPrice = numberValue(values[mapping.unitPrice]);
      const sourceSubtotal = numberValue(values[mapping.subtotal]);
      const sourceTaxAmount = numberValue(values[mapping.taxAmount]);
      const sourceTotal = numberValue(values[mapping.total]);
      const derivedTaxRate = sourceSubtotal > 0 && sourceTaxAmount >= 0 ? Math.round(sourceTaxAmount / sourceSubtotal * 10000) / 100 : numberValue(defaultTaxRate);
      const calculated = calculateLineTotals({ quantity, unitPrice, taxRate: derivedTaxRate });
      if (sourceTotal > 0 && Math.abs(sourceTotal - calculated.total) > 1) issues.push({ level: 'warning', code: 'TOTAL_MISMATCH', field: 'Total', message: `El total capturado (${sourceTotal}) no coincide con el calculado (${calculated.total}).` });
      const deliveredByLegacy = Boolean(remisionDate.value && present(values[mapping.remision]));
      const receivedByLegacy = Boolean(deliveryDate.value || normalizeText(values[mapping.supplierDeliveryDate]) === 'ENTREGADO');
      const purchasedByLegacy = Boolean(rawOrder && normalizeText(rawOrder) !== 'DEPOSITO') || deposit;
      const billing = classifyBilling(values[mapping.customerInvoice]);
      const supplierAmount = parseSupplierAmount(values[mapping.supplierInvoiceAmount]);
      const exchangeSnapshot = rawOrder ? exchangeRateMap[normalizeText(rawOrder)] || null : null;
      if (supplierAmount.currency === 'USD' && !exchangeSnapshot) issues.push({ level: 'warning', code: 'MISSING_EXCHANGE_RATE', field: 'Tipo de cambio', message: 'La factura está en USD y no se encontró una tasa histórica para esta OC.' });
      const duplicate = priorHashes.has(sourceHash) || currentHashes.has(sourceHash);
      currentHashes.add(sourceHash);
      if (duplicate) issues.unshift({ level: 'info', code: 'DUPLICATE', field: 'Origen', message: 'Esta fila ya fue importada anteriormente.' });
      const errorCount = issues.filter(issue => issue.level === 'error').length;
      const warningCount = issues.filter(issue => issue.level === 'warning').length;
      results.push({
        sourceRow, sourceHash, sourceFileHash: fileHash, sourceSheet: sheetName,
        status: duplicate ? 'duplicate' : errorCount ? 'error' : warningCount ? 'warning' : 'ready',
        issues,
        record: {
          requisitionFolio, requestType: stock ? 'internal_stock' : 'customer_order', requestDate: requestDate.value,
          customer: stock ? null : institution, contact: stock ? null : cleanText(values[mapping.contact]), customerReference: stock ? null : null,
          purchaseOrderFolio: rawOrder && normalizeText(rawOrder) !== 'DEPOSITO' ? rawOrder : null,
          purchaseMode: deposit ? 'deposit' : 'standard', purchaseOrderConfirmedAt: confirmedAt.value,
          supplier: rawSupplier && normalizeText(rawSupplier) !== 'DEPOSITO' ? rawSupplier : null,
          supplierInvoiceFolio: cleanText(values[mapping.supplierInvoice]) && !['DEPOSITO', 'CANCELADO'].some(marker => normalizeText(values[mapping.supplierInvoice]).startsWith(marker)) ? cleanText(values[mapping.supplierInvoice]) : null,
          supplierInvoiceDate: supplierInvoiceDate.value, supplierInvoiceAmount: supplierAmount.amountOriginal,
          supplierInvoiceCurrency: supplierAmount.currency, supplierInvoiceExchangeRate: exchangeSnapshot?.rate || null,
          supplierInvoiceExchangeRateDate: exchangeSnapshot?.date || null,
          supplierInvoiceTotalMXN: supplierAmount.currency === 'MXN' ? supplierAmount.amountOriginal : exchangeSnapshot?.rate ? Math.round(supplierAmount.amountOriginal * exchangeSnapshot.rate * 100) / 100 : null,
          supplierDeliveryDate: deliveryDate.value,
          productCatalog: catalog, productDescription: product, brand: cleanText(values[mapping.brand]),
          quantityRequested: quantity, quantityPurchased: purchasedByLegacy && !cancelled ? quantity : 0,
          quantityReceived: receivedByLegacy && !cancelled ? quantity : 0, quantityDelivered: deliveredByLegacy && !cancelled ? quantity : 0,
          quantityCancelled: cancelled ? quantity : 0, quantityInvoiced: billing.type && customerInvoiceDate.value && !cancelled ? quantity : 0,
          supplyOrigin: stock ? 'inventory_stock' : deposit ? 'direct_purchase' : 'supplier',
          unitPrice, taxRate: derivedTaxRate, subtotal: sourceSubtotal || calculated.subtotal,
          taxAmount: sourceTaxAmount || calculated.taxAmount, total: sourceTotal || calculated.total,
          billingType: billing.type, customerInvoiceFolio: billing.folio, accountReference: billing.accountReference,
          billingObservation: billing.observation, customerInvoiceDate: customerInvoiceDate.value,
          remisionFolio: cleanText(values[mapping.remision]), remisionDate: remisionDate.value,
          cancelled, cancellationReason: cancelled ? 'Marcado como CANCELADO en el archivo legado; motivo por validar.' : null,
          originalRow: values.slice(0, 26),
        },
      });
    }
    const counts = results.reduce((totals, row) => ({ ...totals, [row.status]: (totals[row.status] || 0) + 1 }), { ready: 0, warning: 0, error: 0, duplicate: 0, skipped: 0 });
    return { fileHash, sheetName, mapping: { ...mapping }, rows: results, counts };
  }

  function createEmptyStore() {
    return {
      version: 1, requisitions: [], orderLines: [], supplierOrders: [], supplierOrderLines: [],
      supplierInvoices: [], receipts: [], inventoryReservations: [], inventoryMovements: [], customerInvoices: [],
      shipments: [], auditLog: [], imports: [],
      settings: { defaultTaxRate: 16, taxRates: [0, 8, 16] },
    };
  }

  function materializeImport(storeInput, simulation, actor = 'Usuario') {
    const store = JSON.parse(JSON.stringify(storeInput || createEmptyStore()));
    const importedAt = new Date().toISOString();
    const accepted = simulation.rows.filter(row => ['ready', 'warning'].includes(row.status));
    const existingHashes = new Set(store.imports.flatMap(entry => entry.sourceHashes || []));
    const rows = accepted.filter(row => !existingHashes.has(row.sourceHash));
    const requestMap = new Map(store.requisitions.map(item => [normalizeText(item.id), item]));
    const supplierOrderMap = new Map(store.supplierOrders.map(item => [normalizeText(item.id), item]));
    const supplierInvoiceMap = new Map(store.supplierInvoices.map(item => [`${normalizeText(item.folio)}|${normalizeText(item.supplierName)}`, item]));
    const lineIds = new Set(store.orderLines.map(item => item.id));
    for (const source of rows) {
      const record = source.record;
      const requestKey = normalizeText(record.requisitionFolio);
      let requisition = requestMap.get(requestKey);
      if (!requisition) {
        requisition = {
          id: record.requisitionFolio, type: record.requestType, requestDate: record.requestDate,
          customerName: record.customer, contactName: record.contact, customerReference: record.customerReference,
          status: record.cancelled ? 'cancelled' : 'purchasing', observations: 'Importado desde PEDIDOS PROBIOLAB 2026.xlsx',
          responsible: actor, createdAt: importedAt, updatedAt: importedAt, source: 'excel_legacy',
        };
        store.requisitions.push(requisition);
        requestMap.set(requestKey, requisition);
      }
      const lineId = `LIN-${source.sourceHash.toUpperCase()}`;
      if (lineIds.has(lineId)) continue;
      const line = {
        id: lineId, requisitionId: requisition.id, productId: null, catalog: record.productCatalog,
        brandName: record.brand, description: record.productDescription, quantityRequested: record.quantityRequested,
        quantityPurchased: record.quantityPurchased, quantityReceived: record.quantityReceived,
        quantityDelivered: record.quantityDelivered, quantityCancelled: record.quantityCancelled,
        quantityInvoiced: record.quantityInvoiced, unitPrice: record.unitPrice, subtotal: record.subtotal,
        taxRate: record.taxRate, taxAmount: record.taxAmount, total: record.total,
        supplyOrigin: record.supplyOrigin, purchaseMode: record.purchaseMode, reserved: false,
        status: null, sourceHash: source.sourceHash, sourceRow: source.sourceRow, sourceFileHash: source.sourceFileHash,
      };
      line.status = deriveLineStatus(line);
      store.orderLines.push(line);
      lineIds.add(lineId);
      if (record.purchaseOrderFolio) {
        const key = normalizeText(record.purchaseOrderFolio);
        let order = supplierOrderMap.get(key);
        if (!order) {
          order = { id: record.purchaseOrderFolio, supplierName: record.supplier, createdAt: record.requestDate, confirmedAt: record.purchaseOrderConfirmedAt, currency: record.supplierInvoiceCurrency || 'MXN', exchangeRate: null, exchangeRateDate: null, status: record.quantityReceived ? 'received' : 'confirmed', requisitionIds: [], lineIds: [] };
          store.supplierOrders.push(order);
          supplierOrderMap.set(key, order);
        }
        if (!order.requisitionIds.includes(requisition.id)) order.requisitionIds.push(requisition.id);
        if (!order.lineIds.includes(line.id)) order.lineIds.push(line.id);
        store.supplierOrderLines.push({ id: `SOL-${source.sourceHash.toUpperCase()}`, supplierOrderId: order.id, requisitionId: requisition.id, orderLineId: line.id, quantity: record.quantityPurchased || record.quantityRequested });
      }
      if (record.supplierInvoiceFolio) {
        const key = `${normalizeText(record.supplierInvoiceFolio)}|${normalizeText(record.supplier)}`;
        let invoice = supplierInvoiceMap.get(key);
        if (!invoice) {
          invoice = { id: `FPR-${hashString(key).toUpperCase()}`, folio: record.supplierInvoiceFolio, date: record.supplierInvoiceDate, amountOriginal: record.supplierInvoiceAmount, currency: record.supplierInvoiceCurrency || 'MXN', exchangeRate: record.supplierInvoiceExchangeRate, exchangeRateDate: record.supplierInvoiceExchangeRateDate, totalMXN: record.supplierInvoiceTotalMXN, supplierName: record.supplier, supplierOrderIds: [], evidenceId: null };
          store.supplierInvoices.push(invoice);
          supplierInvoiceMap.set(key, invoice);
        }
        if (record.purchaseOrderFolio && !invoice.supplierOrderIds.includes(record.purchaseOrderFolio)) invoice.supplierOrderIds.push(record.purchaseOrderFolio);
      }
      if (record.quantityReceived > 0) store.receipts.push({ id: `REC-${source.sourceHash.toUpperCase()}`, supplierOrderId: record.purchaseOrderFolio, requisitionId: requisition.id, items: [{ orderLineId: line.id, quantity: record.quantityReceived }], date: record.supplierDeliveryDate, type: record.quantityReceived >= record.quantityRequested ? 'total' : 'partial', user: actor, observations: 'Recepción inferida del archivo legado; requiere validación.' });
      if (record.requestType === 'internal_stock' && record.quantityReceived > 0) store.inventoryMovements.push({ id: `INV-${source.sourceHash.toUpperCase()}`, productId: null, catalog: record.productCatalog, type: 'entry', quantity: record.quantityReceived, reason: 'Abastecimiento de stock importado', sourceDocumentType: 'legacy_requisition', sourceDocumentId: requisition.id, user: actor, at: record.supplierDeliveryDate || importedAt, reconciliationStatus: 'pending_product_match' });
      if (record.billingType) store.customerInvoices.push({ id: `FCL-${source.sourceHash.toUpperCase()}`, folio: record.customerInvoiceFolio, date: record.customerInvoiceDate, amount: record.total, requisitionId: requisition.id, items: [{ orderLineId: line.id, quantity: record.quantityInvoiced }], type: record.billingType, accountReference: record.accountReference, observation: record.billingObservation });
      if (record.remisionFolio) store.shipments.push({ id: `REM-${source.sourceHash.toUpperCase()}`, folio: record.remisionFolio, date: record.remisionDate, requisitionId: requisition.id, items: [{ orderLineId: line.id, quantity: record.quantityDelivered }], deliveredAt: record.remisionDate, type: record.quantityDelivered >= record.quantityRequested ? 'total' : 'partial', evidenceId: null, observations: 'Remisión importada del archivo legado.' });
      store.auditLog.push({ id: `AUD-${source.sourceHash.toUpperCase()}`, entityType: 'order_line', entityId: line.id, action: 'legacy_import', user: actor, at: importedAt, before: null, after: { ...line }, source: { fileHash: source.sourceFileHash, sheet: source.sourceSheet, row: source.sourceRow } });
    }
    for (const requisition of store.requisitions) {
      const lines = store.orderLines.filter(line => line.requisitionId === requisition.id);
      requisition.status = deriveRequisitionStatus(lines);
      requisition.updatedAt = importedAt;
    }
    const importRecord = {
      id: `IMP-${Date.now()}`, fileHash: simulation.fileHash, sheetName: simulation.sheetName,
      createdAt: importedAt, createdBy: actor, mode: 'confirmed_after_preview',
      sourceHashes: rows.map(row => row.sourceHash), imported: rows.length,
      omitted: simulation.rows.filter(row => row.status === 'duplicate').length,
      rejected: simulation.rows.filter(row => row.status === 'error').length,
      warnings: simulation.rows.filter(row => row.status === 'warning').length,
    };
    store.imports.push(importRecord);
    store.auditLog.push({ id: `AUD-${importRecord.id}`, entityType: 'import', entityId: importRecord.id, action: 'import_confirmed', user: actor, at: importedAt, before: null, after: { ...importRecord } });
    return { store, importRecord };
  }

  return {
    ORDER_STATUSES, STATUS_LABELS, ROLE_PERMISSIONS, hasPermission, DEFAULT_MAPPING, normalizeText, cleanText, numberValue,
    hashString, excelDateToISO, parseSupplierAmount, classifyBilling, calculateLineTotals,
    validateProgress, validateSupplierPurchaseGate, planMixedFulfillment, planWarehouseFulfillment, reconcileSupplierPurchase, groupSupplierPurchaseLines, deriveLineStatus, deriveRequisitionStatus, simulateImport,
    createEmptyStore, materializeImport,
  };
});
