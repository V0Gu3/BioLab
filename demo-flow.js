(function (root) {
  'use strict';

  const MARKER_KEY = 'bio-demo-flow-v1';
  const ORDER_STORE_KEY = 'nexo-order-operations-v1';
  const read = (key, fallback) => {
    try { return JSON.parse(root.localStorage.getItem(key) || 'null') ?? fallback; }
    catch { return fallback; }
  };
  const write = (key, value) => root.localStorage.setItem(key, JSON.stringify(value));
  const addOnce = (list, record) => {
    if (!list.some(item => String(item.id || item.folio) === String(record.id || record.folio))) list.unshift(record);
  };
  const localDate = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const dateCode = date => localDate(date).replaceAll('-', '').slice(2);
  const nextSequence = (code, collections) => collections.flat().reduce((highest, item) => {
    const match = String(item?.id || '').match(new RegExp(`^(?:COT|OC|OCP)-${code}-(\\d{4,})$`));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;

  function seed(options = {}) {
    const now = options.date instanceof Date ? options.date : new Date(options.date || Date.now());
    let day = localDate(now), code = dateCode(now);
    const quotations = read('nexo-sales-quotations', []), clientOrders = read('nexo-commercial-orders', []);
    const orderStore = read(ORDER_STORE_KEY, null) || {
      version: 1, requisitions: [], orderLines: [], supplierOrders: [], supplierOrderLines: [], supplierInvoices: [], receipts: [],
      inventoryReservations: [], inventoryMovements: [], customerInvoices: [], shipments: [], auditLog: [], imports: [],
      settings: { defaultTaxRate: 16, taxRates: [0, 8, 16] }
    };
    const arrays = ['requisitions', 'orderLines', 'supplierOrders', 'supplierOrderLines', 'supplierInvoices', 'receipts', 'inventoryReservations', 'inventoryMovements', 'customerInvoices', 'shipments', 'auditLog', 'imports'];
    arrays.forEach(key => { if (!Array.isArray(orderStore[key])) orderStore[key] = []; });

    let marker = read(MARKER_KEY, null);
    if (!marker?.ids) {
      const sequence = String(nextSequence(code, [quotations, clientOrders, orderStore.supplierOrders])).padStart(4, '0');
      marker = { version: 1, createdAt: now.toISOString(), ids: {
        quotation: `COT-${code}-${sequence}`, clientOrder: `OC-${code}-${sequence}`, supplierOrder: `OCP-${code}-${sequence}`,
        line: `LIN-OC-${code}-${sequence}-001`, supplierLine: `SOL-OCP-${code}-${sequence}-001`, supplierInvoice: `FPR-${code}-${sequence}`,
        receipt: `REC-${code}-${sequence}`, inventoryEntry: `INV-IN-${code}-${sequence}`, customerInvoice: `FAC-${code}-${sequence}`,
        inventoryExit: `INV-OUT-${code}-${sequence}`, shipment: `REM-${code}-${sequence}`
      } };
    } else if (marker.createdAt) {
      const markerDate = new Date(marker.createdAt);
      if (!Number.isNaN(markerDate.getTime())) { day = localDate(markerDate); code = dateCode(markerDate); }
    }
    const ids = marker.ids, at = hour => `${day}T${hour}:00-06:00`, quantity = 2, saleUnit = 4250, subtotal = 8500, tax = 1360, total = 9860;
    const item = { productId: 1, number: '100001', sku: 'CAF-AR-001', name: 'Café Arábica 1 kg', brand: 'Café Origen', unit: 'kg', quantity, deliveryDate: day, unitPrice: saleUnit, discount: 0, lineSubtotal: subtotal, lineDiscount: 0, lineTotal: subtotal, sourcePrice: 150, sourceCurrency: 'USD', priceListBatch: 'DEMO-FX-2026', fx: { converted: true, sourceCurrency: 'USD', targetCurrency: 'MXN', rate: 17.1, protectionPercent: 20, rateDate: day, consultedDate: day, source: 'Banco de México · SIE', method: 'automatic_banxico', recordId: `FX-DEMO-${code}` } };

    addOnce(quotations, { id: ids.quotation, client: 'Laboratorio Demostración Bio', location: 'Querétaro, Qro.', contact: 'Ana Martínez', email: 'demo@bio.local', validityDays: 30, currency: 'MXN', taxRate: 16, paymentDate: day, paymentTerms: 'Crédito de 30 días.', pricePolicy: 'Precio protegido con tipo de cambio histórico.', cancellationPolicy: 'Cancelación mediante reverso auditable.', exchangeRate: 17.1, exchangeProtection: 20, exchangeRateDate: day, exchangeRateConsultedDate: day, exchangeRateSource: 'Banco de México · SIE', exchangeRateMethod: 'automatic_banxico', exchangeRateRecordId: `FX-DEMO-${code}`, seller: 'José Velasco', notes: 'CASO DEMOSTRATIVO · Flujo completo para revisión de trazabilidad.', items: [item], subtotal, discountTotal: 0, taxable: subtotal, taxAmount: tax, total, createdAtISO: at('09:00'), createdAt: `${day} 09:00`, expiresAtISO: at('23:59'), expiresAt: day, createdBy: 'José Velasco', status: 'Emitida', commercialOrderId: ids.clientOrder, convertedAt: `${day} 09:10`, auditHash: `DEMO-${ids.quotation}-AUDIT` });
    addOnce(clientOrders, { id: ids.clientOrder, quotationId: ids.quotation, quotationAuditHash: `DEMO-${ids.quotation}-AUDIT`, client: 'Laboratorio Demostración Bio', location: 'Querétaro, Qro.', contact: 'Ana Martínez', email: 'demo@bio.local', currency: 'MXN', items: [item], subtotal, discountTotal: 0, taxRate: 16, taxAmount: tax, total, paymentDate: day, paymentTerms: 'Crédito de 30 días.', pricePolicy: 'Precio protegido con tipo de cambio histórico.', cancellationPolicy: 'Cancelación mediante reverso auditable.', seller: 'José Velasco', status: 'active', createdAtISO: at('09:10'), createdAt: `${day} 09:10`, createdBy: 'José Velasco', activatedAtISO: at('09:20'), activatedAt: `${day} 09:20`, activatedBy: 'José Velasco', auditHash: `DEMO-${ids.clientOrder}-AUDIT`, timeline: [{ status: 'pending', label: 'Orden generada desde cotización', at: at('09:10'), by: 'José Velasco' }, { status: 'active', label: 'Orden activada para surtido', at: at('09:20'), by: 'José Velasco' }] });

    addOnce(orderStore.requisitions, { id: ids.clientOrder, type: 'customer_order', requestDate: day, customerName: 'Laboratorio Demostración Bio', contactName: 'Ana Martínez', customerReference: ids.clientOrder, quotationId: ids.quotation, clientOrderId: ids.clientOrder, clientOrderStatus: 'active', currency: 'MXN', status: 'closed', observations: 'CASO DEMOSTRATIVO · Expediente completo y auditable.', responsible: 'José Velasco', createdAt: at('09:10'), updatedAt: at('17:10'), source: 'demo_complete_flow' });
    addOnce(orderStore.orderLines, { id: ids.line, requisitionId: ids.clientOrder, productId: 1, catalog: '100001', brandName: 'Café Origen', description: 'Café Arábica 1 kg', quantityRequested: quantity, quantityPurchased: quantity, quantityReceived: quantity, quantityDelivered: quantity, quantityCancelled: 0, quantityInvoiced: quantity, unitPrice: saleUnit, currency: 'MXN', subtotal, taxRate: 16, taxAmount: tax, total, supplyOrigin: 'supplier', purchaseMode: 'standard', reserved: false, status: 'closed', source: 'demo_complete_flow' });
    addOnce(orderStore.supplierOrders, { id: ids.supplierOrder, supplierId: 'PRV-003', supplierName: 'Café Origen', clientOrderId: ids.clientOrder, quotationId: ids.quotation, createdAt: day, confirmedAt: day, confirmedBy: 'José Velasco', currency: 'USD', exchangeRate: 17.1, exchangeRateDate: day, exchangeRateSource: 'Banco de México · SIE', amountOriginal: 300, totalMXN: 5130, subtotal: 300, total: 300, status: 'received', requisitionIds: [ids.clientOrder], lineIds: [ids.line], autoGenerated: true, createdBy: 'José Velasco' });
    addOnce(orderStore.supplierOrderLines, { id: ids.supplierLine, supplierOrderId: ids.supplierOrder, requisitionId: ids.clientOrder, orderLineId: ids.line, quantity, unitPrice: 150, currency: 'USD' });
    addOnce(orderStore.supplierInvoices, { id: ids.supplierInvoice, folio: ids.supplierInvoice, date: day, amountOriginal: 348, currency: 'USD', exchangeRate: 17.1, exchangeRateDate: day, totalMXN: 5950.8, supplierName: 'Café Origen', supplierOrderIds: [ids.supplierOrder], evidenceId: null });
    addOnce(orderStore.receipts, { id: ids.receipt, supplierOrderId: ids.supplierOrder, requisitionId: ids.clientOrder, date: day, items: [{ orderLineId: ids.line, quantity }], type: 'total', user: 'José Velasco', observations: 'Recepción total validada contra OC del proveedor.', reference: ids.supplierInvoice });
    addOnce(orderStore.inventoryMovements, { id: ids.inventoryEntry, requisitionId: ids.clientOrder, orderLineId: ids.line, warehouseId: '1', productId: 1, catalog: '100001', type: 'entry', quantity, reason: 'Entrada contra OC a proveedor', sourceDocumentType: 'receipt', sourceDocumentId: ids.receipt, user: 'José Velasco', at: at('14:01'), reconciliationStatus: 'matched' });
    addOnce(orderStore.customerInvoices, { id: ids.customerInvoice, folio: ids.customerInvoice, date: day, amount: total, currency: 'MXN', requisitionId: ids.clientOrder, items: [{ orderLineId: ids.line, quantity }], type: 'standard', accountReference: null, observation: 'Factura normal vinculada al pedido.' });
    addOnce(orderStore.inventoryMovements, { id: ids.inventoryExit, requisitionId: ids.clientOrder, orderLineId: ids.line, warehouseId: '1', productId: 1, catalog: '100001', type: 'exit', quantity, reason: 'Salida contra remisión', sourceDocumentType: 'shipment', sourceDocumentId: ids.shipment, user: 'José Velasco', at: at('17:00'), reconciliationStatus: 'matched' });
    addOnce(orderStore.shipments, { id: ids.shipment, folio: ids.shipment, date: day, requisitionId: ids.clientOrder, items: [{ orderLineId: ids.line, quantity }], deliveredAt: at('17:05'), type: 'total', evidenceId: null, observations: 'Entrega total confirmada al cliente.' });

    const events = [
      [at('09:00'), 'Cotización emitida', ids.quotation], [at('09:10'), 'OC del cliente generada', ids.clientOrder],
      [at('09:20'), 'OC del cliente activada', ids.clientOrder], [at('09:25'), 'OC a proveedor generada', ids.supplierOrder],
      [at('09:30'), 'OC a proveedor confirmada', ids.supplierOrder], [at('12:00'), 'Factura de proveedor registrada', ids.supplierInvoice],
      [at('14:00'), 'Recepción total registrada', ids.receipt], [at('14:01'), 'Entrada de almacén registrada', ids.inventoryEntry],
      [at('16:30'), 'Factura al cliente registrada', ids.customerInvoice], [at('17:00'), 'Salida de almacén registrada', ids.inventoryExit],
      [at('17:05'), 'Remisión entregada', ids.shipment], [at('17:10'), 'Expediente cerrado', ids.clientOrder]
    ];
    events.forEach(([eventAt, action, reference], index) => addOnce(orderStore.auditLog, { id: `AUD-DEMO-${code}-${String(index + 1).padStart(2, '0')}`, entityType: index < 3 || index === events.length - 1 ? 'requisition' : 'order_line', entityId: index < 3 || index === events.length - 1 ? ids.clientOrder : ids.line, action, user: 'José Velasco', at: eventAt, before: index ? { stage: events[index - 1][1] } : null, after: { stage: action, document: reference }, reference, notes: 'Caso demostrativo auditable', demo: true }));

    const movements = read('nexo-movements', []);
    addOnce(movements, { id: ids.inventoryEntry, type: 'entrada', title: 'Entrada de flujo demostrativo', detail: `${ids.supplierOrder} · Almacén 01 · ${ids.receipt}`, qty: `+ ${quantity} uds.`, time: `${day} 14:01`, createdAt: at('14:01') });
    addOnce(movements, { id: ids.inventoryExit, type: 'salida', title: 'Salida de flujo demostrativo', detail: `${ids.shipment} · Laboratorio Demostración Bio`, qty: `− ${quantity} uds.`, time: `${day} 17:00`, createdAt: at('17:00') });

    write('nexo-sales-quotations', quotations); write('nexo-commercial-orders', clientOrders); write(ORDER_STORE_KEY, orderStore); write('nexo-movements', movements); write(MARKER_KEY, marker);
    return { marker, quotation: quotations.find(item => item.id === ids.quotation), clientOrder: clientOrders.find(item => item.id === ids.clientOrder), store: orderStore };
  }

  root.BioDemoFlow = { seed, MARKER_KEY };
  seed();
})(window);
