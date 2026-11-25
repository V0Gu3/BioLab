(function () {
  'use strict';
  const core = window.BioOrdersCore;
  if (!core) return;
  const q = selector => document.querySelector(selector);
  const qa = selector => [...document.querySelectorAll(selector)];
  const BRAND = window.PROBIOLAB_BRAND || { name: 'PROBIOLAB', documentName: 'PROBIOLAB' };
  const STORAGE_KEY = 'nexo-order-operations-v1';
  let actor = window.BioAccess?.currentUser() || { id: 'USR-001', name: 'José Velasco', role: 'administrator' };
  // El núcleo histórico usa nombres breves; BioAccess emplea permisos de negocio.
  // Resolverlos aquí evita que un permiso válido se interprete como denegado.
  const accessPermission = Object.freeze({
    edit: 'client_order_manage',
    purchase: 'supplier_order_manage',
    inventory: 'inventory_manage',
    admin: 'user_manage'
  });
  const can = permission => {
    const currentAccess = window.BioAccess;
    if (typeof currentAccess?.can === 'function') return currentAccess.can(accessPermission[permission] || permission);
    return core.hasPermission(actor.role, permission);
  };
  // El módulo de acceso usa permisos específicos; el núcleo histórico conserva
  // "purchase" para instalaciones que aún no han migrado a BioAccess.
  const canManageSupplierOrders = () => window.BioAccess?.can?.('supplier_order_manage') ?? core.hasPermission(actor.role, 'purchase');
  const entityArrays = ['requisitions', 'orderLines', 'supplierOrders', 'supplierOrderLines', 'supplierInvoices', 'receipts', 'inventoryReservations', 'inventoryMovements', 'customerInvoices', 'shipments', 'auditLog', 'imports'];
  const loadStore = () => {
    let parsed;
    try {
      const pending = localStorage.getItem(`${STORAGE_KEY}-transaction`);
      parsed = JSON.parse(pending || localStorage.getItem(STORAGE_KEY) || 'null');
      if (pending && parsed?.version === 1) { localStorage.setItem(STORAGE_KEY, pending); localStorage.removeItem(`${STORAGE_KEY}-transaction`); }
    } catch { parsed = null; }
    const store = parsed && parsed.version === 1 ? parsed : core.createEmptyStore();
    entityArrays.forEach(key => { if (!Array.isArray(store[key])) store[key] = []; });
    store.settings ||= { defaultTaxRate: 16, taxRates: [0, 8, 16] };
    return store;
  };
  let store = loadStore();
  let importSimulation = null;
  let activeRequestId = null;
  let activeDossierTab = 'summary';
  let trackingPage = 1;
  let trackingPageSize = 25;
  let trackingSelectedRequestId = null;
  let deliveryPage = 1;
  let deliveryPageSize = 25;
  let deliverySelectedRequestId = null;
  let orderDraftLines = [];
  let processedOperationNotice = null;
  const saveStore = nextStore => {
    const serialized = JSON.stringify(nextStore);
    try {
      // setItem es atómico. Escribir el mismo almacén dos veces duplicaba el
      // bloqueo del hilo principal en operaciones grandes como una remisión total.
      localStorage.setItem(STORAGE_KEY, serialized);
      localStorage.removeItem(`${STORAGE_KEY}-transaction`);
      store = nextStore;
      return true;
    } catch {
      localStorage.removeItem(`${STORAGE_KEY}-transaction`);
      notify('No hay espacio local suficiente. No se guardó ningún cambio.');
      return false;
    }
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const searchKey = core.normalizeText;
  const formatDate = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Sin fecha';
  const localDateKey = (value = new Date()) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    return window.BioDeliveryPresentation.day(value);
  };
  const documentDateFromFolio = (value, prefix) => {
    const match = String(value || '').match(new RegExp(`^${prefix}-(\\d{2})(\\d{2})(\\d{2})-\\d{4,}$`));
    return match ? `20${match[1]}-${match[2]}-${match[3]}` : '';
  };
  const formatMovementDateTime = value => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }) : 'Sin fecha y hora';
  };
  const notify = (message, kind) => {
    if (typeof window.showToast === 'function') return window.showToast(message, kind);
    const toast = q('#toast');
    toast.textContent = `${kind === 'error' ? '⚠ ' : ''}${message}`; toast.className = `show ${kind || ''}`; setTimeout(() => toast.classList.remove('show'), 3000);
  };
  const operationLabel = type => ({ receipt: 'Recepción', delivery: 'Remisión y salida', invoice: 'Factura al cliente', account_charge: 'Cargo a manejo de cuenta', cancel: 'Cancelación', purchase: 'Compra a proveedor', reserve: 'Reserva de inventario', tracking: 'Seguimiento' }[type] || 'Operación');
  const supplierOrderStatusLabel=status=>({draft:'Propuesta',confirmed:'Confirmada',partially_purchased:'Compra parcial',purchased:'Comprada',partially_received:'Recepción parcial',received:'Recibida',cancelled:'Cancelada'}[status]||'Estado por revisar');
  const receiptDocumentTypeLabel=type=>({supplier_remission:'Remisión del proveedor',supplier_invoice:'Factura del proveedor',other:'Otro documento'}[type]||'Documento de llegada');
  const receiptTypeLabel=receipt=>receipt?.type==='partial'||receipt?.shortage||(receipt?.items||[]).some(item=>core.numberValue(item.quantityRejected)>0)?'Recepción parcial':'Recepción total';
  const auditActionLabel = action => ({
    tracking_follow_up: 'Seguimiento registrado',
    tracking_status_change: 'Cambio de estado registrado',
    tracking_commitment: 'Compromiso registrado',
    tracking_document: 'Documento recibido',
    tracking_incident: 'Incidencia registrada',
    tracking_other: 'Otro seguimiento registrado',
    purchase_proposal_generated: 'Propuesta de compra generada',
    purchase_proposal_approved_and_locked: 'Compra autorizada y emitida',
    client_order_linked: 'Pedido interno relacionado',
    client_order_acceptance_registered: 'Aceptación del cliente registrada',
    mixed_fulfillment_planned: 'Abastecimiento de inventario planificado',
    created_with_fulfillment_plan: 'Pedido creado con plan de abastecimiento',
    receipt_total: 'Recepción total registrada',
    receipt_partial: 'Recepción parcial registrada',
    shortage_authorized_cancellation: 'Saldo faltante cancelado con autorización',
    duplicate_receipt_reconciled: 'Recepción duplicada conciliada',
    historical_purchase_receipt_reconciled: 'Compras y recepciones históricas conciliadas',
    historical_document_date_reconciled: 'Fecha documental histórica conciliada',
    delivery_total: 'Remisión total generada',
    receipt: 'Recepción registrada',
    delivery: 'Remisión generada',
    invoice: 'Factura registrada',
    cancel: 'Cancelación registrada',
    legacy_import: 'Registro histórico importado',
    import_confirmed: 'Importación confirmada'
  }[action] || (String(action || '').startsWith('relation_') ? 'Relación producto–proveedor actualizada' : String(action || 'Actualización operativa').replaceAll('_', ' ')));
  window.BioOrderLabels = { auditActionLabel };
  const acceptanceTypeLabel = type => ({customer_po:'Orden de compra del cliente',signed_quotation:'Cotización firmada',authorization_email:'Correo de autorización',deposit:'Anticipo / depósito'})[type] || 'Evidencia de aceptación';
  const BUSINESS_TIME_ZONE = 'America/Mexico_City';
  const businessToday = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  const pastBusinessDate = value => Boolean(value && String(value).slice(0, 10) < businessToday());
  const returnToDossierAfterOperation = (requestId, { type, quantity = null, reference = '', detail = '', warning = '' }) => {
    const label = operationLabel(type);
    processedOperationNotice = { requestId, label, quantity, reference, detail, warning };
    q('#orderProgressDialog')?.close();
    activeDossierTab = 'summary';
    notify(warning || `${label} procesada correctamente${reference ? ` · ${reference}` : ''}.`);
    // El movimiento ya quedó guardado. Liberar primero el indicador y repartir
    // los renderizados evita que un expediente grande prolongue la espera visual.
    const refreshDossier = () => {
      renderOrderDashboard();
      renderDeliveries();
      renderOrderDetail(requestId, 'summary');
      const refreshGlobal = () => { if (typeof render === 'function') render(); };
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(refreshGlobal, { timeout: 350 });
      else window.setTimeout(refreshGlobal, 0);
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(refreshDossier);
    else window.setTimeout(refreshDossier, 0);
  };
  const requestLines = requestId => store.orderLines.filter(line => line.requisitionId === requestId);
  const resolveOperationalRequest = requestId => store.requisitions.find(item => [item.id, item.clientOrderId].some(value => String(value || '') === String(requestId || '')));
  const sum = (lines, field) => lines.reduce((total, line) => total + core.numberValue(line[field]), 0);
  const requestStatusClass = status => status === 'cancelled' ? 'cancelled' : ['purchasing', 'partially_purchased', 'partially_received', 'partially_delivered', 'partially_invoiced'].includes(status) ? 'warning' : ['closed', 'delivered', 'invoiced', 'ready_to_deliver', 'inventory_reserved'].includes(status) ? 'active' : '';
  const linkedText = request => {
    const lines = requestLines(request.id), lineIds = new Set(lines.map(line => line.id));
    const orders = store.supplierOrders.filter(order => order.requisitionIds?.includes(request.id));
    const orderIds = new Set(orders.map(order => order.id));
    const invoices = store.supplierInvoices.filter(invoice => invoice.supplierOrderIds?.some(id => orderIds.has(id)));
    const customerInvoices = store.customerInvoices.filter(invoice => invoice.requisitionId === request.id);
    const shipments = store.shipments.filter(shipment => shipment.requisitionId === request.id);
    return [request.id, request.quotationId, request.clientOrderId, request.customerName, request.contactName, request.customerReference, request.responsible,
      ...lines.flatMap(line => [line.catalog, line.brandName, line.description]),
      ...orders.flatMap(order => [order.id, order.supplierName]),
      ...invoices.flatMap(invoice => [invoice.folio, invoice.supplierName]),
      ...customerInvoices.flatMap(invoice => [invoice.folio, invoice.accountReference]),
      ...shipments.map(shipment => shipment.folio), ...lineIds].map(searchKey).join(' ');
  };

  function syncClientOrders() {
    let clientOrders = [];
    try { clientOrders = JSON.parse(localStorage.getItem('nexo-commercial-orders') || '[]'); } catch {}
    if (!Array.isArray(clientOrders) || !clientOrders.length) return false;
    const next = JSON.parse(JSON.stringify(store));let products=[];try{products=JSON.parse(localStorage.getItem('nexo-products')||'[]')}catch{}
    let changed = false;
    clientOrders.forEach((clientOrder, orderIndex) => {
      if (window.BioCommercialMoney) clientOrder = window.BioCommercialMoney.snapshot(clientOrder, quotations());
      if (!clientOrder?.id || !(clientOrder?.quotationId || clientOrder?.quotationIds?.length)) return;
      const createdAt = clientOrder.createdAtISO || new Date().toISOString();
      let request = next.requisitions.find(item => item.clientOrderId === clientOrder.id || (item.id === clientOrder.id && item.source === 'quotation_client_order'));
      if (!request && clientOrder.status !== 'active') return;
      if (!request) {
        request = {
          id: clientOrder.id,
          type: 'customer_order',
          requestDate: createdAt.slice(0, 10),
          customerName: clientOrder.client || null,
          contactName: clientOrder.contact || null,
          customerReference: clientOrder.id,
          quotationId: clientOrder.quotationId,
          clientOrderId: clientOrder.id,
          clientOrderStatus: clientOrder.status || 'pending',
          customerAcceptance: clientOrder.acceptance ? JSON.parse(JSON.stringify(clientOrder.acceptance)) : null,
          status: clientOrder.status === 'active' ? 'confirmed' : 'draft',
          observations: clientOrder.location ? `Destino: ${clientOrder.location}` : null,
          responsible: clientOrder.seller || clientOrder.createdBy || actor.name,
          createdAt,
          updatedAt: createdAt,
          source: 'quotation_client_order'
        };
        next.requisitions.unshift(request);
        (clientOrder.items || []).forEach((item, index) => {
          const quantityRequested = Math.max(0, core.numberValue(item.quantity));
          const unitPrice = core.numberValue(item.unitPrice ?? item.price);
          const taxRate = core.numberValue(item.taxRate ?? clientOrder.taxRate ?? next.settings.defaultTaxRate);
          const calculated = core.calculateLineTotals({ quantity: quantityRequested, unitPrice, taxRate }), subtotal = item.subtotal == null ? calculated.subtotal : core.numberValue(item.subtotal), discountTotal = core.numberValue(item.discountTotal), taxable = item.taxable == null ? Math.max(0, subtotal - discountTotal) : core.numberValue(item.taxable), taxAmount = item.taxAmount == null ? Math.round(taxable * taxRate) / 100 : core.numberValue(item.taxAmount), total = item.total == null && item.lineTotal == null ? Math.round((taxable + taxAmount) * 100) / 100 : core.numberValue(item.total ?? item.lineTotal);
          const product = products.find(candidate => String(candidate.id) === String(item.productId)) || products.find(candidate => [candidate.number, candidate.sku].some(value => searchKey(value) === searchKey(item.number || item.sku)));
          const fulfillment = clientOrder.status === 'active' ? warehousePlan(next, product, quantityRequested, item.deliveryWarehouse || '1') : { allocations: [], reservedQuantity: 0, quantityToPurchase: quantityRequested, supplyOrigin: 'supplier' };
          const line = {
            id: `LIN-${clientOrder.id}-${String(index + 1).padStart(3, '0')}`,
            requisitionId: clientOrder.id,
            productId: item.productId ?? null,
            supplierRelationId: item.supplierRelationId ?? null,
            supplierId: item.supplierId ?? null,
            catalog: item.number || item.sku || null,
            unit: item.unit || null,
            currency: item.currency || item.sourceCurrency || clientOrder.currency || 'MXN',
            brandName: item.brand || null,
            description: item.name || 'Producto sin descripción',
            quantityRequested,
            quantityPurchased: 0,
            quantityReceived: 0,
            quantityDelivered: 0,
            quantityCancelled: 0,
            quantityInvoiced: 0,
            unitPrice,
            discount: core.numberValue(item.discount),
            subtotal,
            discountTotal,
            taxable,
            taxRate,
            taxAmount,
            total,
            supplyOrigin: fulfillment.supplyOrigin,
            purchaseMode: 'standard',
            deliveryWarehouse: item.deliveryWarehouse || '1',
            committedDate: item.deliveryDate || null,
            purchasePaymentTerms: item.purchasePaymentTerms || 'Estándar',
            reserved: fulfillment.reservedQuantity>0,
            reservedQuantity: fulfillment.reservedQuantity,
            quantityToPurchase: fulfillment.quantityToPurchase,
            status: clientOrder.status === 'active' ? 'confirmed' : 'draft',
            source: 'quotation_client_order'
          };
          line.status = core.deriveLineStatus(line);
          next.orderLines.push(line);
          fulfillment.allocations.forEach((allocation, allocationIndex) => next.inventoryReservations.push({ id: `RES-${line.id}-${allocation.warehouseId}-${allocationIndex + 1}`, requisitionId: clientOrder.id, orderLineId: line.id, productId: line.productId, warehouseId: allocation.warehouseId, quantity: allocation.quantity, quantityConsumed: 0, status: 'active', reason: 'Reserva automática al confirmar pedido', reference: clientOrder.id, user: clientOrder.activatedBy || actor.name, at: clientOrder.activatedAtISO || createdAt }));
          if (fulfillment.reservedQuantity > 0) next.auditLog.push({ id: `AUD-RES-${line.id}`, entityType: 'order_line', entityId: line.id, action: 'mixed_fulfillment_planned', user: clientOrder.activatedBy || actor.name, at: clientOrder.activatedAtISO || createdAt, before: null, after: { requested: quantityRequested, reservedQuantity: fulfillment.reservedQuantity, quantityToPurchase: fulfillment.quantityToPurchase, warehouseAllocations: fulfillment.allocations }, reference: clientOrder.id });
        });
        next.auditLog.push({ id: `AUD-CLIENT-${Date.now()}-${orderIndex}`, entityType: 'requisition', entityId: clientOrder.id, action: 'client_order_linked', user: actor.name, at: createdAt, before: null, after: { quotationId: clientOrder.quotationId, clientOrderId: clientOrder.id, status: clientOrder.status, customerAcceptance: clientOrder.acceptance || null }, reference: clientOrder.quotationId });
        changed = true;
      } else if (request.clientOrderStatus !== clientOrder.status) {
        const before = { clientOrderStatus: request.clientOrderStatus, status: request.status };
        request.clientOrderStatus = clientOrder.status || 'pending';
        request.customerAcceptance = clientOrder.acceptance ? JSON.parse(JSON.stringify(clientOrder.acceptance)) : request.customerAcceptance || null;
        request.quotationId = clientOrder.quotationId;
        request.clientOrderId = clientOrder.id;
        const lines = next.orderLines.filter(line => line.requisitionId === request.id);
        const hasOperationalProgress = lines.some(line => core.numberValue(line.quantityPurchased) || core.numberValue(line.quantityReceived) || core.numberValue(line.quantityDelivered));
        if (clientOrder.status === 'active' && !hasOperationalProgress) lines.forEach((line, lineIndex) => {
          const product = products.find(candidate => String(candidate.id) === String(line.productId)) || products.find(candidate => [candidate.number, candidate.sku].some(value => searchKey(value) === searchKey(line.catalog)));
          const fulfillment = warehousePlan(next, product, Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled)), line.deliveryWarehouse || '1');
          line.reserved = fulfillment.reservedQuantity > 0; line.reservedQuantity = fulfillment.reservedQuantity; line.quantityToPurchase = fulfillment.quantityToPurchase; line.supplyOrigin = fulfillment.supplyOrigin; line.status = core.deriveLineStatus(line);
          fulfillment.allocations.forEach((allocation, allocationIndex) => next.inventoryReservations.push({ id: `RES-${line.id}-${allocation.warehouseId}-${allocationIndex + 1}`, requisitionId: request.id, orderLineId: line.id, productId: line.productId, warehouseId: allocation.warehouseId, quantity: allocation.quantity, quantityConsumed: 0, status: 'active', reason: 'Reserva automática al activar pedido interno', reference: clientOrder.id, user: clientOrder.activatedBy || actor.name, at: clientOrder.activatedAtISO || new Date().toISOString() }));
          next.auditLog.push({ id: `AUD-RES-${line.id}-${lineIndex}`, entityType: 'order_line', entityId: line.id, action: 'mixed_fulfillment_planned', user: clientOrder.activatedBy || actor.name, at: clientOrder.activatedAtISO || new Date().toISOString(), before: null, after: { requested: line.quantityRequested, reservedQuantity: fulfillment.reservedQuantity, quantityToPurchase: fulfillment.quantityToPurchase, warehouseAllocations: fulfillment.allocations }, reference: clientOrder.id });
        });
        if (!hasOperationalProgress) request.status = clientOrder.status === 'active' ? 'confirmed' : 'draft';
        request.updatedAt = clientOrder.activatedAtISO || new Date().toISOString();
        next.auditLog.push({ id: `AUD-CLIENT-STATUS-${Date.now()}-${orderIndex}`, entityType: 'requisition', entityId: request.id, action: 'client_order_acceptance_registered', user: clientOrder.activatedBy || actor.name, at: request.updatedAt, before, after: { clientOrderStatus: request.clientOrderStatus, status: request.status, customerAcceptance: request.customerAcceptance }, reference: clientOrder.id });
        changed = true;
      }
    });
    return changed ? saveStore(next) : false;
  }

  const catalogProducts = () => {
    try { return JSON.parse(localStorage.getItem('nexo-products') || '[]'); } catch { return []; }
  };
  const catalogSuppliers = () => {
    try { return JSON.parse(localStorage.getItem('nexo-suppliers') || '[]'); } catch { return []; }
  };
  const catalogRelations = () => {
    try { return JSON.parse(localStorage.getItem('nexo-product-supplier-relations') || '[]'); } catch { return []; }
  };
  const activeReservationsByWarehouse = (targetStore, productId) => targetStore.inventoryReservations.filter(reservation => reservation.status === 'active' && String(reservation.productId) === String(productId)).reduce((result, reservation) => {
    const warehouseId = String(reservation.warehouseId || '1');
    result[warehouseId] = core.numberValue(result[warehouseId]) + Math.max(0, core.numberValue(reservation.quantity) - core.numberValue(reservation.quantityConsumed));
    return result;
  }, {});
  const committedReceiptsByWarehouse = (targetStore, productId) => {
    const lines = new Map(targetStore.orderLines.map(line => [String(line.id), line])), requests = new Map(targetStore.requisitions.map(request => [String(request.id), request])), result = {};
    targetStore.receipts.forEach(receipt => (receipt.items || []).forEach(item => {
      const line = lines.get(String(item.orderLineId)), request = line && requests.get(String(line.requisitionId));
      if (!line || String(line.productId) !== String(productId) || request?.type !== 'customer_order' || request.status === 'cancelled') return;
      const quality = item.qualityStatus || receipt.qualityStatus || 'released'; if (quality !== 'released') return;
      const warehouseId = String(receipt.warehouseId || line.deliveryWarehouse || '1');
      result[warehouseId] = core.numberValue(result[warehouseId]) + Math.max(0, core.numberValue(item.quantityAccepted ?? item.quantity));
    }));
    targetStore.inventoryMovements.filter(movement => movement.type === 'exit' && String(movement.productId) === String(productId)).forEach(movement => {
      const line = lines.get(String(movement.orderLineId)), request = line && requests.get(String(line.requisitionId));
      if (!line || request?.type !== 'customer_order') return;
      const warehouseId = String(movement.warehouseId || line.deliveryWarehouse || '1'), purchasedUsed = movement.purchasedQuantityUsed == null ? Math.max(0, core.numberValue(movement.quantity) - core.numberValue(movement.reservedQuantityUsed)) : Math.max(0, core.numberValue(movement.purchasedQuantityUsed));
      result[warehouseId] = Math.max(0, core.numberValue(result[warehouseId]) - purchasedUsed);
    });
    return result;
  };
  const warehousePlan = (targetStore, product, requested, preferredWarehouse) => {
    const reservations = activeReservationsByWarehouse(targetStore, product?.id), commitments = committedReceiptsByWarehouse(targetStore, product?.id), occupied = {};
    [...new Set([...Object.keys(reservations), ...Object.keys(commitments)])].forEach(warehouseId => { occupied[warehouseId] = core.numberValue(reservations[warehouseId]) + core.numberValue(commitments[warehouseId]); });
    return core.planWarehouseFulfillment({ requested, warehouses: { 1: core.numberValue(product?.a1), 2: core.numberValue(product?.a2) }, reservedByWarehouse: occupied, preferredWarehouse });
  };
  const reconcileInventoryReservations = (targetStore, products = catalogProducts()) => {
    const productMap = new Map(products.map(product => [String(product.id), product])), groups = new Map(), at = new Date().toISOString(); let changed = false;
    targetStore.inventoryReservations.filter(reservation => reservation.status === 'active').forEach(reservation => { const key = `${reservation.productId}|${reservation.warehouseId || '1'}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(reservation); });
    groups.forEach((reservations, key) => {
      const [productId, warehouseId] = key.split('|'), product = productMap.get(String(productId)), commitments = committedReceiptsByWarehouse(targetStore, productId), physical = core.numberValue(warehouseId === '2' ? product?.a2 : product?.a1), plan = core.reconcileWarehouseReservations({ available: physical, committed: commitments[warehouseId], reservations });
      plan.allocations.filter(allocation => allocation.released > 0).forEach(allocation => {
        const reservation = reservations.find(item => String(item.id) === String(allocation.id)), line = targetStore.orderLines.find(item => String(item.id) === String(reservation?.orderLineId)); if (!reservation || !line) return;
        reservation.originalQuantity ??= reservation.quantity; reservation.quantity = core.numberValue(reservation.quantityConsumed) + allocation.kept; reservation.releasedQuantity = core.numberValue(reservation.releasedQuantity) + allocation.released; reservation.releasedAt = at; reservation.releaseReason = 'Existencia libre insuficiente; se envía el faltante a compra.'; if (allocation.kept <= 0) reservation.status = 'released';
        line.reservedQuantity = Math.max(0, core.numberValue(line.reservedQuantity) - allocation.released); line.reserved = line.reservedQuantity > 0; line.quantityToPurchase = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased)); line.supplyOrigin = line.reservedQuantity > 0 && line.quantityToPurchase > 0 ? 'mixed' : line.reservedQuantity > 0 ? 'inventory' : 'supplier'; line.status = core.deriveLineStatus(line);
        const request = targetStore.requisitions.find(item => String(item.id) === String(line.requisitionId)); if (request) { request.status = core.deriveRequisitionStatus(targetStore.orderLines.filter(item => item.requisitionId === request.id)); request.updatedAt = at; }
        targetStore.auditLog.push({ id: `AUD-RES-RELEASE-${Date.now()}-${allocation.id}`, entityType: 'order_line', entityId: line.id, action: 'inventory_reservation_released', user: actor.name, at, before: { reservedQuantity: core.numberValue(line.reservedQuantity) + allocation.released }, after: { reservedQuantity: line.reservedQuantity, quantityToPurchase: line.quantityToPurchase }, reference: request?.id || line.requisitionId, notes: reservation.releaseReason }); changed = true;
      });
    });
    return changed;
  };
  const planCatalogDeduction = (productId, quantity, preferredWarehouses = []) => {
    const product = catalogProducts().find(item => String(item.id) === String(productId));
    if (!product) return null;
    let remaining = Math.max(0, core.numberValue(quantity));
    const allocations = [...new Set([...preferredWarehouses.map(String), '1', '2'])].map(warehouseId => {
      const field = warehouseId === '2' ? 'a2' : 'a1', used = Math.min(remaining, Math.max(0, core.numberValue(product[field])));
      remaining -= used;
      return { productId, warehouseId, delta: -used };
    }).filter(allocation => allocation.delta < 0);
    return remaining > 0 ? null : allocations;
  };
  const planCatalogDeductions = planned => {
    const staged = JSON.parse(JSON.stringify(catalogProducts()));
    const productsById = new Map(staged.map(product => [String(product.id), product]));
    const adjustments = [], byLine = new Map();
    for (const item of planned) {
      const product = productsById.get(String(item.line.productId));
      if (!product) return null;
      let remaining = Math.max(0, core.numberValue(item.quantity));
      const preferredWarehouses = (item.reservations || []).map(reservation => String(reservation.warehouseId || '1'));
      const lineAdjustments = [...new Set([...preferredWarehouses, String(item.line.deliveryWarehouse || '1'), '1', '2'])].map(warehouseId => {
        const field = warehouseId === '2' ? 'a2' : 'a1';
        const used = Math.min(remaining, Math.max(0, core.numberValue(product[field])));
        remaining -= used;
        product[field] = core.numberValue(product[field]) - used;
        return { productId: item.line.productId, warehouseId, delta: -used };
      }).filter(adjustment => adjustment.delta < 0);
      if (remaining > 0) return null;
      byLine.set(item.line.id, lineAdjustments);
      adjustments.push(...lineAdjustments);
    }
    return { staged, adjustments, byLine };
  };
  const applyCatalogStockAdjustments = (adjustments, preparedCatalog = null, options = {}) => {
    if (!adjustments.length) return true;
    const staged = preparedCatalog || JSON.parse(JSON.stringify(catalogProducts()));
    if (!preparedCatalog) {
      const productsById = new Map(staged.map(product => [String(product.id), product]));
      for (const adjustment of adjustments) {
        const product = productsById.get(String(adjustment.productId));
        if (!product) return false;
        const quarantine = adjustment.inventoryState === 'quarantine';
        const field = `${quarantine ? 'q' : 'a'}${String(adjustment.warehouseId) === '2' ? '2' : '1'}`, nextValue = core.numberValue(product[field]) + core.numberValue(adjustment.delta);
        if (nextValue < 0) return false;
        product[field] = nextValue;
        if (quarantine && adjustment.sourceMovementId) product.quarantineMovementIds = [...new Set([...(product.quarantineMovementIds || []), adjustment.sourceMovementId])];
      }
    }
    localStorage.setItem('nexo-products', JSON.stringify(staged));
    if(typeof products!=='undefined'&&Array.isArray(products))products.splice(0,products.length,...staged);
    if (options.notify !== false) window.dispatchEvent(new CustomEvent('bio:inventory-stock-changed', { detail: { adjustments } }));
    return true;
  };
  const ensureInventoryProductForReceipt = (line, supplierOrder) => {
    const catalog = catalogProducts();
    const existing = catalog.find(product => String(product.id) === String(line.productId)) || catalog.find(product => [product.number, product.sku].some(value => searchKey(value) === searchKey(line.catalog)));
    if (existing) return existing;
    const suffix = String(Date.now()), currency = supplierOrder?.currency || line.currency || 'MXN';
    const product = {
      id: `INV-${suffix}`,
      number: String(line.catalog || `REC-${suffix.slice(-6)}`),
      sku: String(line.catalog || `REC-${suffix.slice(-6)}`).replace(/\s+/g, '-').toUpperCase(),
      name: line.description || 'Producto recibido sin descripción',
      supplierId: supplierOrder?.supplierId || line.supplierId || '',
      unit: line.unit || 'Unidad',
      brand: line.brandName || '',
      price: core.numberValue(line.unitPrice),
      priceCurrency: currency,
      min: 0,
      a1: 0,
      a2: 0,
      q1: 0,
      q2: 0,
      quarantineMovementIds: [],
      color: '#4d9c98',
      images: [],
      source: 'operational_receipt',
      receivedFromOrderLineId: line.id,
      createdAt: new Date().toISOString()
    };
    catalog.push(product);
    localStorage.setItem('nexo-products', JSON.stringify(catalog));
    if (typeof products !== 'undefined' && Array.isArray(products)) products.splice(0, products.length, ...catalog);
    window.dispatchEvent(new CustomEvent('bio:inventory-product-created', { detail: product }));
    return product;
  };
  const reconcileHistoricalReceiptInventory = () => {
    let repaired = false;
    (store.receipts || []).forEach(receipt => {
      (receipt.items || []).forEach(item => {
        const line = store.orderLines.find(candidate => candidate.id === item.orderLineId);
        const movement = store.inventoryMovements.find(candidate => candidate.sourceDocumentId === receipt.id && candidate.orderLineId === item.orderLineId);
        if (!line || !movement || movement.productId) return;
        const supplierOrder = store.supplierOrders.find(order => order.id === receipt.supplierOrderId);
        const product = ensureInventoryProductForReceipt(line, supplierOrder);
        line.productId = product.id;
        movement.productId = product.id;
        if ((receipt.qualityStatus || item.qualityStatus || 'released') === 'released') {
          const catalog = catalogProducts(), storedProduct = catalog.find(candidate => String(candidate.id) === String(product.id));
          const field = String(receipt.warehouseId || movement.warehouseId || '1') === '2' ? 'a2' : 'a1';
          if (storedProduct) {
            storedProduct[field] = core.numberValue(storedProduct[field]) + core.numberValue(item.quantityAccepted ?? item.quantity);
            localStorage.setItem('nexo-products', JSON.stringify(catalog));
            if (typeof products !== 'undefined' && Array.isArray(products)) products.splice(0, products.length, ...catalog);
          }
        }
        repaired = true;
      });
    });
    if (repaired) saveStore(store);
    return repaired;
  };
  const reconcileHistoricalQuarantineInventory = () => {
    const catalog = catalogProducts(), productsById = new Map(catalog.map(product => [String(product.id), product]));
    let repaired = false;
    (store.inventoryMovements || []).filter(movement => movement.type === 'entry' && movement.inventoryState === 'quarantine' && movement.productId).forEach(movement => {
      const product = productsById.get(String(movement.productId)), applied = product?.quarantineMovementIds || [];
      if (!product || applied.includes(movement.id)) return;
      const field = String(movement.warehouseId || '1') === '2' ? 'q2' : 'q1';
      product[field] = core.numberValue(product[field]) + core.numberValue(movement.quantity);
      product.quarantineMovementIds = [...applied, movement.id];
      repaired = true;
    });
    if (!repaired) return false;
    localStorage.setItem('nexo-products', JSON.stringify(catalog));
    if (typeof products !== 'undefined' && Array.isArray(products)) products.splice(0, products.length, ...catalog);
    window.dispatchEvent(new CustomEvent('bio:inventory-stock-changed', { detail: { reason: 'historical_quarantine_reconciliation' } }));
    return true;
  };
  const reconcileHistoricalAuthorizedShortages = () => {
    const affectedAudits = [...(store.auditLog || [])].filter(entry => entry.action === 'receipt' && entry.receipt?.shortageResolution === 'authorized_cancellation');
    let repaired = false;
    affectedAudits.forEach(entry => {
      const line = store.orderLines.find(item => item.id === entry.entityId), receipt = store.receipts.find(item => item.reference === entry.reference && (item.items || []).some(receiptItem => receiptItem.orderLineId === entry.entityId));
      if (!line || !receipt || receipt.shortage?.status === 'cancelled') return;
      const link = store.supplierOrderLines.find(item => item.orderLineId === line.id && item.supplierOrderId === receipt.supplierOrderId), supplierOrder = link && store.supplierOrders.find(item => item.id === link.supplierOrderId);
      if (!link || !supplierOrder) return;
      const pending = core.supplierOrderLinePending({ supplierOrderId: supplierOrder.id, link, receipts: store.receipts });
      if (pending <= 0) return;
      const cancellable = Math.min(pending, Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)));
      line.quantityCancelled = core.numberValue(line.quantityCancelled) + cancellable;
      line.quantityToPurchase = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
      line.cancellationReason = entry.notes || entry.receipt?.notes || 'Saldo faltante cancelado con autorización';
      line.cancelledAt = entry.at;
      line.cancelledBy = entry.user || 'Sistema';
      line.status = core.deriveLineStatus(line);
      link.quantityCancelled = core.numberValue(link.quantityCancelled) + pending;
      link.cancellationReason = line.cancellationReason;
      link.cancelledAt = entry.at;
      link.cancelledBy = line.cancelledBy;
      receipt.type = 'partial';
      receipt.shortage = { quantity: pending, resolution: 'authorized_cancellation', notes: line.cancellationReason, responsible: entry.user || 'Sistema', status: 'cancelled', closedAt: entry.at, closedBy: entry.user || 'Sistema', repairedFromHistoricalRecord: true };
      const effectiveOrdered = store.supplierOrderLines.filter(item => item.supplierOrderId === supplierOrder.id).reduce((sum, item) => sum + Math.max(0, core.numberValue(item.quantity) - core.numberValue(item.quantityCancelled)), 0), received = store.receipts.filter(item => item.supplierOrderId === supplierOrder.id).flatMap(item => item.items || []).reduce((sum, item) => sum + core.numberValue(item.quantityAccepted ?? item.quantity), 0);
      supplierOrder.status = received >= effectiveOrdered ? 'received' : 'partially_received';
      supplierOrder.reconciliation = core.reconcileSupplierPurchase({ order: supplierOrder, links: store.supplierOrderLines, receipts: store.receipts, invoices: store.supplierInvoices });
      const request = store.requisitions.find(item => item.id === line.requisitionId);
      if (request) { request.status = core.deriveRequisitionStatus(store.orderLines.filter(item => item.requisitionId === request.id)); request.updatedAt = entry.at; }
      store.auditLog.push({ id: `AUD-SHORTAGE-REPAIR-${receipt.id}`, entityType: 'order_line', entityId: line.id, action: 'shortage_authorized_cancellation', eventKind: 'formal_operation', user: entry.user || 'Sistema', at: entry.at, before: entry.before || null, after: JSON.parse(JSON.stringify(line)), reference: receipt.id, notes: `${pending} unidad(es) del saldo de ${supplierOrder.id} canceladas con autorización. Registro histórico conciliado.`, shortage: { quantity: pending, supplierOrderId: supplierOrder.id, receiptId: receipt.id, repaired: true } });
      repaired = true;
    });
    if (repaired) saveStore(store);
    return repaired;
  };
  const supplierOrderFolio = (targetStore, dateValue) => {
    const dateCode = String(dateValue || new Date().toISOString().slice(0, 10)).replaceAll('-', '').slice(2);
    const pattern = new RegExp(`^OCP-${dateCode}-(\\d{4,})$`);
    const sequence = targetStore.supplierOrders.reduce((highest, order) => {
      const match = String(order.id || '').match(pattern);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    return `OCP-${dateCode}-${String(sequence).padStart(4, '0')}`;
  };
  const shipmentFolio = (targetStore, dateValue) => {
    const rawDate = dateValue instanceof Date ? dateValue : null;
    const isoMatch = rawDate ? null : String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const dateCode = rawDate
      ? localDateKey(rawDate).replaceAll('-', '').slice(2)
      : isoMatch
        ? `${isoMatch[1].slice(-2)}${isoMatch[2]}${isoMatch[3]}`
        : localDateKey().replaceAll('-', '').slice(2);
    const pattern = new RegExp(`^REM-${dateCode}-(\\d{4,})$`);
    const sequence = targetStore.shipments.reduce((highest, shipment) => {
      const match = String(shipment.folio || shipment.id || '').match(pattern);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    return `REM-${dateCode}-${String(sequence).padStart(4, '0')}`;
  };
  const inventoryMovementFolio = (targetStore, type, dateValue) => {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
    const dateCode = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const prefix = type === 'entry' ? 'ENT' : 'SAL';
    const pattern = new RegExp(`^${prefix}-${dateCode}-(\\d{4,})$`);
    const sequence = targetStore.inventoryMovements.reduce((highest, movement) => {
      const match = String(movement.folio || movement.id || '').match(pattern);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    return `${prefix}-${dateCode}-${String(sequence).padStart(4, '0')}`;
  };
  const inventoryMovementDisplayFolio = movement => movement?.folio || movement?.id || 'Movimiento sin folio';
  function reconcileOperationalMovementFolios(){let changed=false;[...store.inventoryMovements].sort((a,b)=>String(a.at||'').localeCompare(String(b.at||''))).forEach(movement=>{if(movement.folio)return;const readable=/^(?:ENT|SAL)-\d{6}-\d{4,}$/.test(String(movement.id||''));movement.folio=readable?movement.id:inventoryMovementFolio(store,movement.type,movement.at);changed=true});if(!changed)return false;const saved=saveStore(store);if(saved)window.dispatchEvent(new CustomEvent('bio:operational-movement-folios'));return saved}

  function resolveLineSupplier(line, products = catalogProducts(), suppliers = catalogSuppliers(), relations = catalogRelations()) {
    if (window.BioSupplierRelations) return window.BioSupplierRelations.resolve({ line, products, suppliers, relations });
    const product = products.find(item => String(item.id) === String(line.productId)) || products.find(item => [item.number, item.sku].some(value => searchKey(value) === searchKey(line.catalog)));
    const supplier = product && suppliers.find(item => String(item.id) === String(product.supplierId));
    return { product, supplier, relation: null, valid: Boolean(product && supplier), reason: product && supplier ? 'Relación heredada.' : 'No existe relación producto–proveedor.' };
  }

  // Los movimientos no guardan el precio nuevamente: la fuente de verdad es la
  // partida de la OC. Esta lectura conserva proveedor y costo aun después de
  // que la partida ya fue recibida, entregada o cambió de estado.
  function documentSupplyContext(line) {
    const links = store.supplierOrderLines.filter(link => link.orderLineId === line?.id);
    const link = links.find(candidate => core.numberValue(candidate.quantity) > 0) || links[0] || null;
    const supplierOrder = link && store.supplierOrders.find(order => order.id === link.supplierOrderId);
    const resolved = resolveLineSupplier(line);
    const supplier = supplierOrder?.supplierName || line?.supplierName || resolved.supplier?.name || null;
    const unitCost = link?.unitPrice ?? resolved.relation?.purchasePrice ?? line?.purchaseCost ?? null;
    const currency = link?.currency || supplierOrder?.currency || resolved.relation?.currency || resolved.product?.priceCurrency || line?.currency || 'MXN';
    return { supplier, unitCost, currency, supplierOrderId: supplierOrder?.id || null };
  }

  const lineSupply = (line, targetStore = store) => core.effectiveLineSupply({ line, links: targetStore.supplierOrderLines, supplierOrders: targetStore.supplierOrders, receipts: targetStore.receipts });

  function reconcileHistoricalDocumentDates() {
    const next = JSON.parse(JSON.stringify(store)), repairs = [];
    const knownFolios = new Set(next.shipments.map(shipment => String(shipment.folio || shipment.id)));
    const deliveryAudits = next.auditLog.filter(entry => /^delivery_(total|partial)$/.test(String(entry.action || '')) && /^REM-\d{6}-\d{4,}$/.test(String(entry.reference || '')));
    [...new Map(deliveryAudits.map(entry => [String(entry.reference), entry])).values()].forEach(entry => {
      const folio = String(entry.reference);
      if (knownFolios.has(folio)) return;
      const line = next.orderLines.find(item => String(item.id) === String(entry.entityId)), requisitionId = line?.requisitionId;
      const movements = next.inventoryMovements.filter(movement => movement.type === 'exit' && movement.sourceDocumentType === 'shipment' && movement.at === entry.at && (!requisitionId || movement.requisitionId === requisitionId));
      if (!movements.length) return;
      const sourceId = movements[0].sourceDocumentId, matching = next.shipments.filter(shipment => shipment.deliveredAt === entry.at && (!requisitionId || shipment.requisitionId === requisitionId));
      if (matching.length === 1) {
        const shipment = matching[0], originalFolio = shipment.folio || shipment.id;
        shipment.identityReconciliation = { originalFolio, source: 'audit_and_inventory_movement', repairedAt: new Date().toISOString() };
        shipment.folio = folio;
        repairs.push({ entityType: 'shipment', entityId: shipment.id, before: originalFolio, after: folio, field: 'folio' });
      } else if (sourceId && !next.shipments.some(shipment => String(shipment.id) === String(sourceId))) {
        const items = [...new Map(movements.map(movement => [movement.orderLineId, movement])).values()].map(movement => ({ orderLineId: movement.orderLineId, quantity: core.numberValue(movement.quantity) }));
        next.shipments.push({ id: sourceId, folio, date: documentDateFromFolio(folio, 'REM'), requisitionId: requisitionId || movements[0].requisitionId, items, deliveredAt: entry.at, recipient: 'Registro histórico recuperado', type: 'total', status: 'recovered', observations: 'Remisión recuperada desde auditoría y movimientos de salida existentes.', identityReconciliation: { source: 'audit_and_inventory_movement', repairedAt: new Date().toISOString() } });
        repairs.push({ entityType: 'shipment', entityId: sourceId, before: null, after: folio, field: 'folio' });
      }
      knownFolios.add(folio);
    });
    next.shipments.forEach(shipment => {
      const canonical = documentDateFromFolio(shipment.folio || shipment.id, 'REM');
      if (!canonical || shipment.date === canonical) return;
      repairs.push({ entityType: 'shipment', entityId: shipment.id, before: shipment.date || null, after: canonical });
      shipment.dateReconciliation = { originalDate: shipment.date || null, source: 'folio', repairedAt: new Date().toISOString() };
      shipment.date = canonical;
    });
    next.supplierOrders.forEach(order => {
      const canonical = documentDateFromFolio(order.id, 'OCP');
      if (!canonical || String(order.createdAt || '').slice(0, 10) === canonical) return;
      repairs.push({ entityType: 'supplier_order', entityId: order.id, before: order.createdAt || null, after: canonical });
      order.dateReconciliation = { originalDate: order.createdAt || null, source: 'folio', repairedAt: new Date().toISOString() };
      order.createdAt = canonical;
    });
    if (!repairs.length) return false;
    const at = new Date().toISOString();
    repairs.forEach((repair, index) => next.auditLog.push({ id: `AUD-DOCUMENT-REPAIR-${repair.entityId}-${index + 1}`, entityType: repair.entityType, entityId: repair.entityId, action: 'historical_document_date_reconciled', eventKind: 'system_reconciliation', user: 'Sistema', at, before: { [repair.field || 'date']: repair.before }, after: { [repair.field || 'date']: repair.after }, reference: repair.entityId, notes: repair.field === 'folio' ? 'El folio histórico se recuperó a partir de auditoría y movimientos de salida existentes.' : 'La fecha visible se alineó con el folio original sin regenerar ni sustituir el documento.' }));
    return saveStore(next);
  }

  function reconcileHistoricalPurchaseReceipts() {
    const next = JSON.parse(JSON.stringify(store)), receiptKeys = new Map(); let changed = false, repairedLines = 0, duplicateReceipts = 0;
    [...next.receipts].sort((left, right) => String(left.receivedAt || left.date || left.id).localeCompare(String(right.receivedAt || right.date || right.id))).forEach(receipt => {
      if (receipt.duplicateOf || receipt.status === 'duplicate_ignored') return;
      const reference = core.normalizeText(receipt.reference || receipt.supplierRemission || receipt.supplierInvoiceReference);
      if (!reference) return;
      const items = (receipt.items || []).map(item => `${item.orderLineId}:${core.numberValue(item.quantityAccepted ?? item.quantity)}:${core.numberValue(item.quantityRejected)}:${core.normalizeText(item.lot || '')}:${core.normalizeText(item.serial || '')}`).sort().join('|');
      const key = [receipt.supplierOrderId, receipt.documentType || 'supplier_remission', reference, receipt.warehouseId || '1', items].map(value => String(value || '')).join('::'), original = receiptKeys.get(key);
      if (!original) { receiptKeys.set(key, receipt); return; }
      receipt.duplicateOf = original.id;
      receipt.status = 'duplicate_ignored';
      receipt.duplicateReason = 'Mismo documento, OC, almacén y partidas que una recepción anterior.';
      next.auditLog.push({ id: `AUD-RECEIPT-DUP-${receipt.id}`, entityType: 'receipt', entityId: receipt.id, action: 'duplicate_receipt_reconciled', eventKind: 'system_reconciliation', user: 'Sistema', at: new Date().toISOString(), before: { duplicateOf: null }, after: { duplicateOf: original.id, status: receipt.status }, reference: original.id, notes: receipt.duplicateReason });
      duplicateReceipts += 1; changed = true;
    });
    next.orderLines.forEach(line => {
      const supply = lineSupply(line, next), before = { purchased: core.numberValue(line.quantityPurchased), received: core.numberValue(line.quantityReceived), pending: core.numberValue(line.quantityToPurchase), status: line.status };
      line.quantityPurchased = supply.purchased;
      line.quantityReceived = supply.received;
      if (line.quantityAvailableReceived == null) line.quantityAvailableReceived = supply.received;
      line.quantityToPurchase = supply.pendingPurchase;
      line.status = core.deriveLineStatus(line);
      if (before.purchased !== line.quantityPurchased || before.received !== line.quantityReceived || before.pending !== line.quantityToPurchase || before.status !== line.status) { repairedLines += 1; changed = true; }
    });
    next.supplierOrders.forEach(order => {
      const beforeStatus = order.status, beforeReconciliation = JSON.stringify(order.reconciliation || null);
      const reconciliation = core.reconcileSupplierPurchase({ order, links: next.supplierOrderLines, receipts: next.receipts, invoices: next.supplierInvoices });
      order.reconciliation = reconciliation;
      if (order.status !== 'draft' && order.status !== 'cancelled') order.status = reconciliation.pendingQuantity > 0 ? (reconciliation.receivedQuantity > 0 ? 'partially_received' : 'confirmed') : 'received';
      if (beforeStatus !== order.status || beforeReconciliation !== JSON.stringify(order.reconciliation)) changed = true;
    });
    next.requisitions.filter(request => request.source !== 'quotation_client_order' || request.clientOrderStatus === 'active').forEach(request => { const status = core.deriveRequisitionStatus(next.orderLines.filter(line => line.requisitionId === request.id)); if (request.status !== status) { request.status = status; changed = true; } });
    if (!changed) return false;
    next.auditLog.push({ id: `AUD-HISTORICAL-SUPPLY-${Date.now()}`, entityType: 'system', entityId: 'purchase_receipt_reconciliation', action: 'historical_purchase_receipt_reconciled', eventKind: 'system_reconciliation', user: 'Sistema', at: new Date().toISOString(), before: null, after: { repairedLines, duplicateReceipts }, reference: 'Conciliación automática', notes: `${repairedLines} partida(s) conciliadas y ${duplicateReceipts} recepción(es) duplicadas excluidas del avance sin eliminar su evidencia.` });
    return saveStore(next);
  }

  function syncSupplierPurchaseOrders() {
    const products = catalogProducts(), suppliers = catalogSuppliers(), relations = catalogRelations(), next = JSON.parse(JSON.stringify(store));
    let changed = reconcileInventoryReservations(next, products);
    const validSupplierOrderIds = new Set(next.supplierOrders.map(order => String(order.id)));
    const validLinks = next.supplierOrderLines.filter(link => validSupplierOrderIds.has(String(link.supplierOrderId)));
    if (validLinks.length !== next.supplierOrderLines.length) { next.supplierOrderLines = validLinks; changed = true; }
    const eligibleRequests = next.requisitions.filter(request => (request.source === 'quotation_client_order' || request.type === 'internal_stock') && (request.type === 'internal_stock' || request.clientOrderStatus === 'active') && request.status !== 'cancelled');
    const requestIds = new Set(eligibleRequests.map(request => request.id));
    const unlinked = next.orderLines.filter(line => requestIds.has(line.requisitionId) && core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased) > 0 && !next.supplierOrderLines.some(link => link.orderLineId === line.id));
    const { groups } = core.groupSupplierPurchaseLines({ lines: unlinked, products, suppliers, relations });
    groups.forEach(group => {
      const firstRequest = eligibleRequests.find(request => request.id === group.rows[0]?.line.requisitionId), at = new Date().toISOString(), documentDate = localDateKey(), id = supplierOrderFolio(next, documentDate);
      const links = group.rows.map(({ line, product, relation }, index) => {
        const quantity = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
        return { id: `SOL-${id}-${String(index + 1).padStart(3, '0')}`, supplierOrderId: id, requisitionId: line.requisitionId, orderLineId: line.id, productId: product.id, supplierRelationId: relation?.id || line.supplierRelationId || null, supplierSku: relation?.supplierSku || line.catalog, purchaseUnit: relation?.purchaseUnit || line.unit, quantity, unitPrice: core.numberValue(relation?.purchasePrice ?? product.price), currency: group.currency, allocationType: eligibleRequests.find(request => request.id === line.requisitionId)?.type === 'internal_stock' ? 'stock' : 'customer_order' };
      }).filter(link => link.quantity > 0);
      if (!links.length) return;
      const requisitionIds = [...new Set(links.map(link => link.requisitionId))], requests = requisitionIds.map(requestId => eligibleRequests.find(request => request.id === requestId)).filter(Boolean), subtotal = links.reduce((total, link) => total + link.quantity * link.unitPrice, 0);
      const order = { id, supplierId: group.supplier.id, supplierName: group.supplier.name, clientOrderId: requests.length === 1 ? requests[0].clientOrderId || requests[0].id : null, clientOrderIds: requests.map(request => request.clientOrderId || request.id), quotationId: requests.length === 1 ? requests[0].quotationId : null, quotationIds: [...new Set(requests.map(request => request.quotationId).filter(Boolean))], createdAt: documentDate, createdAtTimestamp: at, confirmedAt: null, currency: group.currency, exchangeRate: null, exchangeRateDate: null, warehouseId: group.warehouse, requiredDate: group.requiredDate === 'sin-fecha' ? null : group.requiredDate, paymentTerms: group.paymentTerms, subtotal: Math.round(subtotal * 100) / 100, total: Math.round(subtotal * 100) / 100, status: 'draft', documentStage: 'purchase_proposal', version: 1, locked: false, requisitionIds, lineIds: links.map(link => link.orderLineId), autoGenerated: true, consolidated: requisitionIds.length > 1, createdBy: actor.name };
      next.supplierOrders.unshift(order); next.supplierOrderLines.push(...links);
      group.rows.forEach(({ line, relation }) => { line.supplierId = group.supplier.id; line.supplierName = group.supplier.name; line.supplierRelationId = relation?.id || line.supplierRelationId || null; });
      next.auditLog.push({ id: `AUD-${id}`, entityType: 'supplier_order', entityId: id, action: 'purchase_proposal_generated', user: actor.name, at, before: null, after: order, reference: requisitionIds.join(', ') });
      changed = true;
    });
    return changed ? saveStore(next) : false;
  }

  function supplierOrderMissingLines() {
    const products = catalogProducts(), suppliers = catalogSuppliers(), relations = catalogRelations();
    return store.requisitions.filter(request => request.source === 'quotation_client_order' && request.clientOrderStatus === 'active').flatMap(request => store.orderLines.filter(line => line.requisitionId === request.id && core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.reservedQuantity)-core.numberValue(line.quantityPurchased)>0 && !store.supplierOrderLines.some(link => link.orderLineId === line.id)).map(line => ({ request, line, ...resolveLineSupplier(line, products, suppliers, relations) }))).filter(item => !item.valid);
  }

  const supplierOrderMoney = (value, currency) => {
    try { return Number(value || 0).toLocaleString('es-MX', { style: 'currency', currency: currency || 'MXN' }); } catch { return `$${Number(value || 0).toFixed(2)} ${currency || 'MXN'}`; }
  };

  function openSupplierRelationDialog(issue) {
    if (!issue || !canManageSupplierOrders()) { notify('No tienes permiso para relacionar proveedores.'); return; }
    let dialog = q('#supplierRelationDialog');
    if (!dialog) {
      document.body.insertAdjacentHTML('beforeend', '<dialog id="supplierRelationDialog" class="system-dialog"><form method="dialog" id="supplierRelationForm"><div class="dialog-heading"><div><p class="eyebrow">RELACIÓN DE COMPRA</p><h2>Relacionar producto y proveedor</h2></div><button type="button" class="dialog-close" aria-label="Cerrar"><i data-lucide="x"></i></button></div><div class="form-grid"><label class="field wide"><span>Producto interno</span><select id="relationProduct" required></select></label><label class="field wide"><span>Proveedor</span><select id="relationSupplier" required></select></label><label class="field"><span>SKU del proveedor</span><input id="relationSupplierSku" required /></label><label class="field"><span>Unidad de compra</span><input id="relationPurchaseUnit" required /></label><label class="field"><span>Precio de compra</span><input id="relationPurchasePrice" type="number" min="0" step="0.000001" required /></label><label class="field"><span>Moneda</span><select id="relationCurrency"><option>MXN</option><option>USD</option><option>CAD</option><option>EUR</option></select></label><label class="field"><span>Tiempo de entrega (días)</span><input id="relationLeadTime" type="number" min="0" step="1" value="0" /></label><label class="field"><span>Pedido mínimo</span><input id="relationMinimum" type="number" min="0.000001" step="0.000001" value="1" /></label></div><div class="dialog-actions"><button type="button" class="secondary-action dialog-close">Cancelar</button><button class="primary-action" value="default"><i data-lucide="link"></i>Guardar relación</button></div></form></dialog>');
      dialog = q('#supplierRelationDialog');
      dialog.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => dialog.close()));
    }
    const products = catalogProducts(), suppliers = catalogSuppliers().filter(item => window.BioSupplierRelations?.active(item) ?? item.active !== false);
    q('#relationProduct').innerHTML = products.map(product => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.number || product.sku || product.id)} · ${escapeHtml(product.name)}</option>`).join('');
    q('#relationSupplier').innerHTML = suppliers.map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.id)} · ${escapeHtml(supplier.name)}</option>`).join('');
    q('#relationProduct').value = issue.product?.id ?? products.find(product => [product.number, product.sku].some(value => searchKey(value) === searchKey(issue.line.catalog)))?.id ?? '';
    q('#relationSupplier').value = issue.line.supplierId || issue.relation?.supplierId || suppliers[0]?.id || '';
    q('#relationSupplierSku').value = issue.line.catalog || issue.product?.sku || '';
    q('#relationPurchaseUnit').value = issue.line.unit || issue.product?.unit || 'unidad';
    q('#relationPurchasePrice').value = issue.line.unitPrice || issue.product?.price || 0;
    q('#relationCurrency').value = issue.line.currency || issue.product?.priceCurrency || 'MXN';
    const form = q('#supplierRelationForm');
    form.onsubmit = event => {
      event.preventDefault();
      const relations = catalogRelations(), at = new Date().toISOString(), result = window.BioSupplierRelations.upsert(relations, { productId: q('#relationProduct').value, supplierId: q('#relationSupplier').value, supplierSku: q('#relationSupplierSku').value, supplierDescription: issue.line.description, purchaseUnit: q('#relationPurchaseUnit').value, purchasePrice: q('#relationPurchasePrice').value, currency: q('#relationCurrency').value, leadTimeDays: q('#relationLeadTime').value, minimumOrderQuantity: q('#relationMinimum').value, active: true, preferred: true, source: 'manual_purchase_resolution' }, actor.name, at);
      localStorage.setItem('nexo-product-supplier-relations', JSON.stringify(relations));
      const next = JSON.parse(JSON.stringify(store)), line = next.orderLines.find(item => item.id === issue.line.id); if (line) { line.productId = q('#relationProduct').value; line.supplierId = q('#relationSupplier').value; line.supplierRelationId = result.relation.id; }
      next.auditLog.push({ id: `AUD-REL-${Date.now()}`, entityType: 'product_supplier_relation', entityId: result.relation.id, action: `relation_${result.action}`, user: actor.name, at, before: null, after: result.relation, reference: issue.request.id });
      saveStore(next); dialog.close(); syncSupplierPurchaseOrders(); renderSupplierPurchaseOrders(); notify('Relación guardada; la OC a proveedor fue recalculada.');
    };
    dialog.showModal(); window.lucide?.createIcons();
  }

  function renderSupplierPurchaseOrders() {
    const search = searchKey(q('#supplierOrderSearch').value), status = q('#supplierOrderStatusFilter').value;
    const missing = supplierOrderMissingLines(), suppliers = new Set(store.supplierOrders.map(order => order.supplierId || order.supplierName).filter(Boolean));
    q('#supplierOrderDraftCount').textContent = store.supplierOrders.filter(order => order.status === 'draft').length;
    q('#supplierOrderConfirmedCount').textContent = store.supplierOrders.filter(order => ['confirmed', 'partially_received', 'received'].includes(order.status)).length;
    q('#supplierOrderSupplierCount').textContent = suppliers.size;
    q('#supplierOrderMissingCount').textContent = missing.length;
    q('#supplierOrderIssues').hidden = !missing.length;
    q('#supplierOrderIssues').innerHTML = missing.length ? `<i data-lucide="circle-alert"></i><div><strong>${missing.length} artículo${missing.length === 1 ? '' : 's'} sin relación válida de proveedor</strong><span>${missing.slice(0, 8).map(item => `<span class="supplier-relation-issue"><b>${escapeHtml(item.line.catalog || 'Sin catálogo')} · ${escapeHtml(item.line.description)}</b><small>${escapeHtml(item.request.id)} · Proveedor esperado: ${escapeHtml(item.line.supplierId || item.relation?.supplierId || 'sin definir')} · ${escapeHtml(item.reason || 'No existe relación producto–proveedor activa.')}</small><span><button type="button" data-relate-supplier="${escapeHtml(item.line.id)}">Relacionar proveedor</button><button type="button" data-open-relation-product="${escapeHtml(item.line.id)}">Abrir producto</button><button type="button" data-open-relation-supplier="${escapeHtml(item.line.id)}">Abrir proveedor</button></span></span>`).join('')}${missing.length > 8 ? `<small>y ${missing.length - 8} más…</small>` : ''}</span></div>` : '';
    const validSupplierOrders=store.supplierOrders.filter(order=>order.supplierId&&order.supplierName),matches = validSupplierOrders.filter(order => {
      const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id), lines = links.map(link => store.orderLines.find(line => line.id === link.orderLineId)).filter(Boolean);
      const requests = store.requisitions.filter(item => order.requisitionIds?.includes(item.id));
      const text = [order.id, order.supplierName, order.clientOrderId, ...(order.clientOrderIds || []), order.quotationId, ...(order.quotationIds || []), ...requests.flatMap(request => [request.id, request.customerName]), ...lines.flatMap(line => [line.catalog, line.description, line.brandName])].map(searchKey).join(' ');
      return (!search || text.includes(search)) && (!status || order.status === status);
    });
    q('#supplierOrderResultCount').textContent = `${matches.length} de ${validSupplierOrders.length}`;
    q('#supplierOrderList').innerHTML = matches.map(order => {
      const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id), lines = links.map(link => ({ link, line: store.orderLines.find(line => line.id === link.orderLineId) })).filter(item => item.line);
      const statusLabel = supplierOrderStatusLabel(order.status), reconciliation = core.reconcileSupplierPurchase({ order, links: store.supplierOrderLines, receipts: store.receipts, invoices: store.supplierInvoices }), reconciliationLabel = { matched: '3 vías conciliadas', review: 'Diferencia por revisar', pending: reconciliation.invoiceStatus === 'pending_invoice' ? 'Factura pendiente' : 'Conciliación pendiente', missing_order: 'Sin OC' }[reconciliation.status] || 'Conciliación pendiente';
      const items = lines.map(({ link, line }) => { const request = store.requisitions.find(item => item.id === link.requisitionId), cancelled = core.numberValue(link.quantityCancelled), effective = Math.max(0, core.numberValue(link.quantity) - cancelled); return `<li><b>${escapeHtml(line.catalog || 'Sin catálogo')}</b><span>${escapeHtml(line.description)}<small>${escapeHtml(link.allocationType === 'stock' ? 'Stock general' : request?.clientOrderId || request?.id || 'Sin pedido')} · asignadas ${link.quantity}${cancelled ? ` · canceladas ${cancelled}` : ''}</small></span><em>${effective} ${escapeHtml(line.unit || 'uds.')} vigentes · ${supplierOrderMoney(link.unitPrice, link.currency)}</em></li>`; }).join('');
      const originLabel = order.requisitionIds?.length > 1 ? `${order.requisitionIds.length} pedidos consolidados` : order.clientOrderId || order.requisitionIds?.[0] || 'Stock general';
      return `<article class="supplier-order-row"><div class="supplier-order-origin"><strong>${escapeHtml(order.id)} · v${order.version || 1}</strong><small>Origen: ${escapeHtml(originLabel)}</small><small>${order.locked || order.status !== 'draft' ? 'Documento bloqueado' : 'Propuesta por autorizar'}</small></div><div><strong>${escapeHtml(order.supplierName || 'Proveedor pendiente')}</strong><small>${escapeHtml(order.currency || 'MXN')} · ${formatDate(order.createdAt)} · A${escapeHtml(order.warehouseId || '1')}</small></div><ul class="supplier-order-items">${items}</ul><div class="supplier-order-money" aria-label="Total de la orden ${supplierOrderMoney(order.total, order.currency)}"><span class="supplier-order-money-label">Total de la orden</span><strong class="supplier-order-total">${supplierOrderMoney(order.total, order.currency)}</strong><small class="supplier-order-currency">${escapeHtml(order.currency || 'MXN')}</small><small class="reconciliation-state ${reconciliation.status}">${escapeHtml(reconciliationLabel)}</small></div><span class="order-status-badge ${order.status === 'draft' ? 'warning' : 'active'}">${escapeHtml(statusLabel)}</span><div class="supplier-order-actions">${order.status === 'draft' ? `<button data-confirm-supplier-order="${escapeHtml(order.id)}"><i data-lucide="shield-check"></i>Autorizar y emitir</button>` : ''}<button data-download-supplier-order="${escapeHtml(order.id)}"><i data-lucide="download"></i>PDF</button></div></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="shopping-bag"></i><strong>No hay OC a proveedor para este filtro</strong><span>Al activar un pedido interno, ${BRAND.name} preparará las órdenes según el proveedor de cada artículo.</span></div>';
    window.lucide?.createIcons();
  }

  function confirmSupplierOrder(orderId) {
    if (!canManageSupplierOrders()) return notify('Tu perfil no permite confirmar órdenes a proveedor.');
    const order = store.supplierOrders.find(item => item.id === orderId);
    if (!order || order.status !== 'draft') return;
    const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id);
    const proceed = () => {
      const next = JSON.parse(JSON.stringify(store)), target = next.supplierOrders.find(item => item.id === orderId), at = new Date().toISOString();
      target.status = 'confirmed'; target.documentStage = 'supplier_purchase_order'; target.confirmedAt = at.slice(0, 10); target.confirmedBy = actor.name; target.approvedAt = at; target.approvedBy = actor.name; target.locked = true; target.version = target.version || 1; target.approvedSnapshot = { version: target.version, supplierId: target.supplierId, currency: target.currency, warehouseId: target.warehouseId, requiredDate: target.requiredDate, paymentTerms: target.paymentTerms, total: target.total, allocationIds: next.supplierOrderLines.filter(link => link.supplierOrderId === orderId).map(link => link.id) };
      next.supplierOrderLines.filter(link => link.supplierOrderId === orderId).forEach(link => {
        const line = next.orderLines.find(item => item.id === link.orderLineId);
        if (!line) return;
        const authorized = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled));
        line.quantityPurchased = Math.min(authorized, core.numberValue(line.quantityPurchased) + core.numberValue(link.quantity));
        line.quantityToPurchase = Math.max(0, authorized - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
        line.status = core.deriveLineStatus(line);
      });
      target.requisitionIds.forEach(requestId => { const request = next.requisitions.find(item => item.id === requestId); if (request) { request.status = core.deriveRequisitionStatus(next.orderLines.filter(line => line.requisitionId === requestId)); request.updatedAt = at; } });
      next.auditLog.push({ id: `AUD-CONF-${orderId}-${Date.now()}`, entityType: 'supplier_order', entityId: orderId, action: 'purchase_proposal_approved_and_locked', user: actor.name, at, before: { status: 'draft', documentStage: 'purchase_proposal', locked: false }, after: { status: 'confirmed', documentStage: target.documentStage, confirmedAt: target.confirmedAt, approvedBy: target.approvedBy, locked: true, version: target.version, snapshot: target.approvedSnapshot }, reference: target.requisitionIds.join(', ') });
      if (!saveStore(next)) return; renderSupplierPurchaseOrders(); renderOrderDashboard(); notify(`OC ${orderId} confirmada y lista para recepción.`);
    };
    const summaryItems = links.map(link => { const line = store.orderLines.find(item => item.id === link.orderLineId); return { name: `${line?.catalog || 'Sin catálogo'} · ${line?.description || 'Artículo'}`, detail: `${link.quantity} ${Number(link.quantity) === 1 ? 'unidad' : 'unidades'} · ${order.supplierName}`, value: supplierOrderMoney(link.quantity * link.unitPrice, link.currency), delta: link.quantity }; });
    if (typeof window.showActionConfirmation === 'function') { const requestCount = order.requisitionIds.length; window.showActionConfirmation({ kicker: 'AUTORIZAR PROPUESTA CONSOLIDADA', title: `¿Emitir ${order.id}?`, text: `La versión ${order.version || 1} quedará bloqueada. ${requestCount === 1 ? 'Su pedido conservará' : `Sus ${requestCount} pedidos conservarán`} la asignación original por partida.`, summaryTitle: 'ARTÍCULOS Y ASIGNACIONES', items: summaryItems, confirmLabel: 'Autorizar y emitir OC', onConfirm: proceed }); }
    else if (confirm(`¿Confirmar ${order.id}?`)) proceed();
  }

  function downloadSupplierOrder(orderId, preview = false) {
    const order = store.supplierOrders.find(item => item.id === orderId), PDF = window.jspdf?.jsPDF;
    if (!order || !PDF) return notify('No fue posible generar el PDF de la orden.');
    const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id);
    if (window.BioFlowDocs) return window.BioFlowDocs[preview ? 'preview' : 'download']('supplier_order', { id: order.id, date: order.confirmedAt || order.createdAt, status: `${supplierOrderStatusLabel(order.status)} · v${order.version || 1}${order.locked ? ' · BLOQUEADA' : ''}`, supplier: order.supplierName, client: (order.clientOrderIds || [order.clientOrderId]).filter(Boolean).join(', ') || 'Stock general', currency: order.currency, reference: `Cotizaciones ${(order.quotationIds || [order.quotationId]).filter(Boolean).join(', ') || 'sin vínculo'}`, related: `Pedidos ${(order.requisitionIds || []).join(', ')}`, items: links.map(link => { const line = store.orderLines.find(item => item.id === link.orderLineId), request = store.requisitions.find(item => item.id === link.requisitionId); return { catalog: line?.catalog, description: `${line?.description || 'Artículo'} · Asignación: ${link.allocationType === 'stock' ? 'Stock general' : request?.clientOrderId || request?.id}`, supplier: order.supplierName, quantity: link.quantity, unitPrice: link.unitPrice, unitCost: link.unitPrice, costCurrency: link.currency || order.currency, total: link.quantity * link.unitPrice, currency: link.currency || order.currency }; }), subtotal: order.subtotal, total: order.total, auditId: `AUD-${order.id}`, notes: `OC consolidada por proveedor, moneda, destino y fecha requerida. ${links.length} asignaciones preservan la huella de cada pedido.` }, { filename: `${order.id}.pdf` });
    const doc = new PDF({ unit: 'mm', format: 'a4' });
    doc.setFillColor(23, 34, 29); doc.rect(0, 0, 210, 44, 'F'); doc.setFillColor(185, 250, 129); doc.roundedRect(16, 13, 16, 16, 3, 3, 'F');
    doc.setTextColor(18, 30, 23); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('P', 24, 23.7, { align: 'center' });
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.text(BRAND.documentName, 38, 20); doc.setFontSize(11); doc.text('ORDEN DE COMPRA A PROVEEDOR', 194, 20, { align: 'right' });
    doc.setTextColor(164, 179, 168); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(`Estado: ${order.status === 'draft' ? 'BORRADOR' : 'CONFIRMADA'}`, 194, 27, { align: 'right' });
    const field = (label, value, x, y) => { doc.setTextColor(125, 137, 128); doc.setFontSize(7); doc.text(label, x, y); doc.setTextColor(30, 43, 34); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(String(value || '—'), x, y + 6); doc.setFont('helvetica', 'normal'); };
    field('FOLIO', order.id, 17, 57); field('FECHA', order.createdAt, 78, 57); field('MONEDA', order.currency, 136, 57); field('PROVEEDOR', order.supplierName, 17, 78); field('OC DEL CLIENTE', order.clientOrderId, 17, 99); field('COTIZACION ORIGEN', order.quotationId, 108, 99);
    let y = 122; doc.setFillColor(239, 243, 238); doc.rect(16, y - 7, 178, 9, 'F'); doc.setTextColor(82, 96, 87); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('CATALOGO / ARTICULO', 19, y - 1); doc.text('CANT.', 139, y - 1); doc.text('P. UNIT.', 158, y - 1); doc.text('IMPORTE', 190, y - 1, { align: 'right' });
    y += 8; links.forEach(link => { const line = store.orderLines.find(item => item.id === link.orderLineId); if (y > 265) { doc.addPage(); y = 25; } doc.setTextColor(32, 45, 36); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(String(line?.catalog || '—'), 19, y); doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(String(line?.description || 'Artículo'), 90), 45, y); doc.text(String(link.quantity), 143, y, { align: 'right' }); doc.text(Number(link.unitPrice || 0).toFixed(2), 171, y, { align: 'right' }); doc.text((link.quantity * link.unitPrice).toFixed(2), 190, y, { align: 'right' }); y += 12; });
    doc.setDrawColor(220, 226, 219); doc.line(126, y, 194, y); doc.setTextColor(26, 39, 31); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`TOTAL ${order.currency}: ${Number(order.total || 0).toFixed(2)}`, 194, y + 9, { align: 'right' });
    doc.setTextColor(125, 138, 129); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(`Trazabilidad: ${order.quotationId} -> ${order.clientOrderId} -> ${order.id}`, 17, 283); doc.save(`${order.id}.pdf`);
  }

  async function downloadInventoryDocument(movementId, preview = false) {
    const movement = store.inventoryMovements.find(item => item.id === movementId), line = movement && store.orderLines.find(item => item.id === movement.orderLineId), request = line && store.requisitions.find(item => item.id === line.requisitionId);
    if (!movement || !line || !window.BioFlowDocs) return notify('No fue posible generar el comprobante de almacén.');
    const kind = movement.type === 'entry' ? 'inventory_entry' : 'inventory_exit', supply = documentSupplyContext(line), lineTotal = supply.unitCost == null ? null : core.numberValue(movement.quantity) * core.numberValue(supply.unitCost);
    await window.BioFlowDocs.loadBrandLogo?.();
    const visibleFolio=inventoryMovementDisplayFolio(movement),reason=movementReasonLabel(movement.reason);return window.BioFlowDocs[preview ? 'preview' : 'download'](kind, { id: visibleFolio, date: formatMovementDateTime(movement.at), status: 'Registrado', client: request?.customerName, warehouse: `Almacén ${movement.warehouseId}`, supplier: supply.supplier, origin: reason, currency: supply.currency, reference: `${movementSourceLabel(movement.sourceDocumentType)}: ${movement.sourceDocumentId}`, related: [request?.id, supply.supplierOrderId].filter(Boolean).join(' · '), items: [{ catalog: line.catalog, description: line.description, supplier: supply.supplier, quantity: movement.quantity, unitCost: supply.unitCost, costCurrency: supply.currency, total: lineTotal, currency: supply.currency }], subtotal: lineTotal, total: lineTotal, auditId: `${movement.user} - ${reconciliationStatusLabel(movement.reconciliationStatus)}`, notes: `${reason}. Identificador interno: ${movement.id}. Usuario: ${movement.user}. Fecha y hora del movimiento: ${formatMovementDateTime(movement.at)}. ${supply.supplierOrderId ? `Costo y origen conservados desde ${supply.supplierOrderId}.` : 'Origen de proveedor pendiente de relacionar.'}` }, { filename: `${kind === 'inventory_entry' ? 'entrada' : 'salida'}-${visibleFolio}.pdf` });
  }

  function downloadShipmentDocument(shipmentId, preview = false) {
    const shipment = store.shipments.find(item => item.id === shipmentId), request = shipment && store.requisitions.find(item => item.id === shipment.requisitionId);
    if (!shipment || !request || !window.BioFlowDocs) return notify('No fue posible generar la remisión.');
    const items = shipment.items.map(item => { const line = store.orderLines.find(candidate => candidate.id === item.orderLineId), supply = documentSupplyContext(line); return { catalog: line?.catalog, description: line?.description, supplier: supply.supplier, quantity: item.quantity, unitPrice: line?.unitPrice, total: line?.unitPrice == null ? null : core.numberValue(item.quantity) * core.numberValue(line.unitPrice), currency: line?.currency || supply.currency }; });
    const suppliers = [...new Set(items.map(item => item.supplier).filter(Boolean))];
    return window.BioFlowDocs[preview ? 'preview' : 'download']('remision', { id: shipment.folio || shipment.id, date: shipment.date || String(shipment.deliveredAt || '').slice(0, 10), status: shipmentTypeLabel(shipment), client: request.customerName, recipient: shipment.recipient || shipment.receivedBy || shipment.deliveredTo || 'No registrado', supplier: suppliers.join(' · ') || null, origin: 'Almacén 1', reference: request.clientOrderId || request.id, related: `${request.quotationId || ''} - ${request.id}`, items, auditId: shipment.id, notes: shipment.observations || 'Entrega registrada con salida de inventario. El proveedor de origen se identifica por partida; los costos de compra se resguardan en los comprobantes internos.' }, { filename: `remision-${shipment.folio || shipment.id}.pdf` });
  }
  const nextRequisitionFolio = dateValue => {
    const code = String(dateValue || new Date().toISOString().slice(0, 10)).replaceAll('-', '').slice(2);
    const pattern = new RegExp(`^REQ-${code}-(\\d{4,})$`);
    const sequence = store.requisitions.reduce((highest, request) => {
      const match = String(request.id || '').match(pattern);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    return `REQ-${code}-${String(sequence).padStart(4, '0')}`;
  };

  function renderCreateProductResults(query = '') {
    const term = searchKey(query), products = catalogProducts().filter(product => term && [product.number, product.sku, product.name, product.brand].some(value => searchKey(value).includes(term))).slice(0, 8);
    q('#orderCreateProductResults').innerHTML = products.map(product => `<button type="button" class="quotation-product-result" data-create-order-product="${product.id}"><span class="product-image" style="background:${escapeHtml(product.color || '#698679')}">${escapeHtml(String(product.name || 'P').slice(0, 1))}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.number || 'Sin número')} · ${escapeHtml(product.sku || 'Sin SKU')} · ${escapeHtml(product.brand || 'Sin marca')}</small></span><b>${Number(product.price || 0).toLocaleString('es-MX', { style: 'currency', currency: product.priceCurrency || 'MXN' })}</b><i data-lucide="plus"></i></button>`).join('') || (term ? '<div class="quotation-search-message"><i data-lucide="search-x"></i>No hay productos coincidentes en el catálogo.</div>' : '');
    window.lucide?.createIcons();
  }

  function renderCreateLines() {
    q('#orderCreateLines').innerHTML = orderDraftLines.map(line => `<article class="order-create-line" data-create-line="${line.productId}"><div><strong>${escapeHtml(line.catalog || 'Sin catálogo')} · ${escapeHtml(line.description)}</strong><small>${escapeHtml(line.brandName || 'Sin marca')}</small></div><label><span>CANTIDAD</span><input class="order-create-line-field" data-field="quantityRequested" type="number" min="1" step="1" value="${line.quantityRequested}"></label><label><span>PRECIO UNIT.</span><input class="order-create-line-field" data-field="unitPrice" type="number" min="0" step="0.01" value="${line.unitPrice}"></label><label><span>IVA</span><select class="order-create-line-field" data-field="taxRate">${store.settings.taxRates.map(rate => `<option value="${rate}" ${rate === line.taxRate ? 'selected' : ''}>${rate}%</option>`).join('')}</select></label><label><span>ORIGEN DE SURTIDO</span><select class="order-create-line-field" data-field="supplyOrigin"><option value="supplier" ${line.supplyOrigin === 'supplier' ? 'selected' : ''}>Proveedor</option><option value="inventory" ${line.supplyOrigin === 'inventory' ? 'selected' : ''}>Inventario</option><option value="direct_purchase" ${line.supplyOrigin === 'direct_purchase' ? 'selected' : ''}>Compra directa</option></select></label><button type="button" class="order-create-remove" data-remove-create-line="${line.productId}" aria-label="Quitar producto"><i data-lucide="trash-2"></i></button></article>`).join('') || '<div class="order-create-empty">Busca y agrega al menos un producto del catálogo.</div>';
    window.lucide?.createIcons();
  }

  function openCreateOrder() {
    orderDraftLines = [];
    q('#orderCreateForm').reset();
    q('#orderCreateType').value = 'customer_order';
    q('#orderCreateDate').value = new Date().toISOString().slice(0, 10);
    q('#orderCreateResponsible').value = actor.name;
    q('#orderCreateCustomer').disabled = false; q('#orderCreateContact').disabled = false; q('#orderCreateCustomer').required = true; q('#orderCreateContact').required = true;
    renderCreateProductResults(''); renderCreateLines();
    q('#orderCreateDialog').showModal();
    setTimeout(() => q('#orderCreateCustomer').focus(), 100);
  }

  function createManualRequisition() {
    if (!can('edit')) return notify('Tu perfil no permite crear requisiciones.');
    if (!orderDraftLines.length) { window.BioFormValidation?.setFieldError(q('#orderCreateProductSearch'), 'Selecciona al menos un producto para la requisición.'); return notify('Agrega al menos una partida.'); }
    if (orderDraftLines.some(line => core.numberValue(line.quantityRequested) <= 0)) { window.BioFormValidation?.setFieldError(q('#orderCreateProductSearch'), 'Cada partida requiere una cantidad mayor que cero.'); return notify('Todas las partidas requieren una cantidad mayor que cero.'); }
    const type = q('#orderCreateType').value, createdAt = new Date().toISOString(), id = nextRequisitionFolio(q('#orderCreateDate').value), next = JSON.parse(JSON.stringify(store)), products = catalogProducts();
    const request = { id, type, requestDate: q('#orderCreateDate').value, customerName: type === 'internal_stock' ? null : q('#orderCreateCustomer').value.trim(), contactName: type === 'internal_stock' ? null : q('#orderCreateContact').value.trim(), customerReference: q('#orderCreateReference').value.trim() || null, status: 'draft', observations: q('#orderCreateNotes').value.trim() || null, responsible: q('#orderCreateResponsible').value.trim(), createdAt, updatedAt: createdAt, source: 'manual' };
    const lines = orderDraftLines.map((draft, index) => {
      const totals = core.calculateLineTotals(draft);
      const product = products.find(item => String(item.id) === String(draft.productId)), fulfillment = draft.supplyOrigin === 'direct_purchase' ? { allocations: [], reservedQuantity: 0, quantityToPurchase: core.numberValue(draft.quantityRequested), supplyOrigin: 'direct_purchase' } : warehousePlan(next, product, draft.quantityRequested, draft.deliveryWarehouse || '1');
      const line = { id: `LIN-${id}-${String(index + 1).padStart(3, '0')}`, requisitionId: id, productId: draft.productId, catalog: draft.catalog, brandName: draft.brandName, description: draft.description, quantityRequested: core.numberValue(draft.quantityRequested), quantityPurchased: 0, quantityReceived: 0, quantityDelivered: 0, quantityCancelled: 0, quantityInvoiced: 0, unitPrice: core.numberValue(draft.unitPrice), subtotal: totals.subtotal, taxRate: core.numberValue(draft.taxRate), taxAmount: totals.taxAmount, total: totals.total, supplyOrigin: fulfillment.supplyOrigin, purchaseMode: draft.supplyOrigin === 'direct_purchase' ? 'deposit' : 'standard', reserved: fulfillment.reservedQuantity > 0, reservedQuantity: fulfillment.reservedQuantity, quantityToPurchase: fulfillment.quantityToPurchase, deliveryWarehouse: draft.deliveryWarehouse || '1', status: null, source: 'manual' };
      line.status = core.deriveLineStatus(line);
      fulfillment.allocations.forEach((allocation, allocationIndex) => next.inventoryReservations.push({ id: `RES-${line.id}-${allocation.warehouseId}-${allocationIndex + 1}`, requisitionId: id, orderLineId: line.id, productId: line.productId, warehouseId: allocation.warehouseId, quantity: allocation.quantity, quantityConsumed: 0, status: 'active', reason: 'Reserva automática al crear requisición', reference: id, user: actor.name, at: createdAt }));
      return line;
    });
    request.status = core.deriveRequisitionStatus(lines);
    next.requisitions.unshift(request); next.orderLines.unshift(...lines);
    next.auditLog.push({ id: `AUD-${Date.now()}`, entityType: 'requisition', entityId: id, action: 'created_with_fulfillment_plan', user: actor.name, at: createdAt, before: null, after: { request, lines, reservations: next.inventoryReservations.filter(reservation => reservation.requisitionId === id) }, reference: request.customerReference });
    if (!saveStore(next)) return; q('#orderCreateDialog').close(); renderOrderDashboard(); notify(`Requisición ${id} creada.`);
  }

  function populateOrderFilters() {
    const status = q('#orderStatusFilter').value;
    q('#orderStatusFilter').innerHTML = '<option value="">Todos los estados</option>' + core.ORDER_STATUSES.map(value => `<option value="${value}">${core.STATUS_LABELS[value]}</option>`).join('');
    q('#orderStatusFilter').value = status;
    const responsible = q('#orderResponsibleFilter').value;
    const people = [...new Set(store.requisitions.map(request => request.responsible).filter(Boolean))].sort();
    q('#orderResponsibleFilter').innerHTML = '<option value="">Todos los responsables</option>' + people.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    q('#orderResponsibleFilter').value = responsible;
  }

  function requestProgress(request) {
    const lines = requestLines(request.id), deliveryProgress = window.BioDeliveryPresentation.progress(lines), requested = deliveryProgress.requested;
    const lineRequirement = line => {
      const authorized = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled));
      const reservedForLine = Math.min(authorized, core.numberValue(line.reservedQuantity));
      return { authorized, reservedForLine, purchaseRequired: Math.max(0, authorized - reservedForLine) };
    };
    const reserved = Math.min(requested, lines.reduce((total, line) => total + lineRequirement(line).reservedForLine, 0));
    const purchaseRequired = lines.reduce((total, line) => total + lineRequirement(line).purchaseRequired, 0);
    const supplyByLine = new Map(lines.map(line => [line.id, lineSupply(line)]));
    // OC confirmada, recepción y entrega comparten una sola lectura conciliada.
    // Así los datos históricos no regresan a compra ni duplican recepciones.
    const purchased = Math.min(purchaseRequired, lines.reduce((total, line) => total + supplyByLine.get(line.id).purchased, 0));
    const received = Math.min(purchaseRequired, lines.reduce((total, line) => total + supplyByLine.get(line.id).received, 0)), availableReceived = Math.min(purchaseRequired, lines.reduce((total,line)=>total+core.numberValue(line.quantityAvailableReceived==null?supplyByLine.get(line.id).received:line.quantityAvailableReceived),0)), available = Math.min(requested, reserved + availableReceived);
    const delivered = deliveryProgress.delivered;
    const invoiced = Math.min(requested, sum(lines, 'quantityInvoiced'));
    const percent = value => requested > 0 ? Math.round(value / requested * 100) : 0, purchasePercent = purchaseRequired > 0 ? Math.round(purchased / purchaseRequired * 100) : 100, receivePercent = purchaseRequired > 0 ? Math.round(received / purchaseRequired * 100) : 100;
    return { lines, requested, reserved, purchaseRequired, purchased, received, availableReceived, available, delivered, overDelivered: deliveryProgress.overDelivered, invoiced, purchasePercent, receivePercent, deliverPercent: percent(delivered), invoicePercent: percent(invoiced) };
  }

  const isOperationalRequest = request => request?.source !== 'quotation_client_order' || request?.clientOrderStatus === 'active';

  const trackingStage = ({ request, progress }) => {
    if (request.status === 'cancelled') return { id: 'cancelled', label: 'Cancelado', next: 'Sin acción pendiente' };
    if (progress.purchased < progress.purchaseRequired) return { id: 'purchase', label: 'Pendiente de comprar', next: 'Completar compra a proveedor' };
    if (progress.received < progress.purchased) return { id: 'receive', label: 'Pendiente de recibir', next: 'Registrar recepción de proveedor' };
    if (request.type === 'customer_order' && progress.delivered < progress.requested) return { id: 'deliver', label: 'Pendiente de entregar', next: 'Generar remisión al cliente' };
    if (request.type === 'customer_order' && progress.invoiced < progress.requested) return { id: 'invoice', label: 'Pendiente de facturar', next: 'Registrar facturación al cliente' };
    return { id: 'complete', label: 'Al día', next: 'Validar cierre administrativo' };
  };

  function trackingRecords() {
    return store.requisitions.filter(isOperationalRequest).map(request => {
      const progress = requestProgress(request);
      return { request, progress, stage: trackingStage({ request, progress }), search: linkedText(request) };
    });
  }

  function renderTrackingQuickPanel(record) {
    const panel = q('#orderTrackingQuickPanel'); if (!panel) return;
    if (!record) {
      panel.innerHTML = '<div class="tracking-quick-empty"><i data-lucide="mouse-pointer-2"></i><strong>Selecciona un pedido</strong><span>Verás la siguiente acción, el avance y los documentos relacionados sin abrir todo el expediente.</span></div>';
      return;
    }
    const { request, progress, stage } = record, canReceive = stage.id === 'receive' && can('receive'), canDeliver = stage.id === 'deliver' && can('deliver');
    const action = canReceive ? `<button class="tracking-quick-primary" data-tracking-formal-total-receipt="${escapeHtml(request.id)}"><i data-lucide="package-check"></i> Registrar recepción</button>` : canDeliver ? `<button class="tracking-quick-primary" data-tracking-formal-total-delivery="${escapeHtml(request.id)}"><i data-lucide="truck-check"></i> Generar remisión</button>` : '';
    const deliveryLink = stage.id === 'deliver' && can('deliver') ? `<button class="tracking-quick-secondary" data-open-delivery-workbench="${escapeHtml(request.id)}"><i data-lucide="truck"></i> Ver disponibilidad de entrega</button>` : '';
    panel.innerHTML = `<div class="tracking-quick-head"><small>PEDIDO SELECCIONADO</small><strong>${escapeHtml(request.id)}</strong><span>${escapeHtml(request.customerName || 'Abastecimiento interno')}</span></div><div class="tracking-quick-next"><small>PRÓXIMA ACCIÓN</small><strong>${escapeHtml(stage.next)}</strong><span class="order-status-badge ${stage.id === 'complete' ? 'active' : stage.id === 'cancelled' ? 'cancelled' : 'warning'}">${escapeHtml(stage.label)}</span></div><dl class="tracking-quick-metrics"><div><dt>Comprado</dt><dd>${progress.purchased} / ${progress.purchaseRequired}</dd></div><div><dt>Recibido</dt><dd>${progress.received} / ${progress.purchaseRequired}</dd></div><div><dt>Entregado</dt><dd>${progress.delivered} / ${progress.requested}</dd></div><div><dt>Partidas</dt><dd>${progress.lines.length}</dd></div></dl>${action}${deliveryLink}<button class="tracking-quick-secondary" data-order-detail="${escapeHtml(request.id)}"><i data-lucide="folder-open"></i> Ver expediente completo</button>`;
  }

  function openQuickReceipt(requestId) {
    const supplierOrderId = store.supplierOrderLines.find(link => {
      const line = store.orderLines.find(item => item.id === link.orderLineId);
      return line?.requisitionId === requestId && core.supplierOrderLinePending({ supplierOrderId: link.supplierOrderId, link, receipts: store.receipts }) > 0;
    })?.supplierOrderId;
    if (!supplierOrderId) return notify('No hay una recepción pendiente para este pedido.');
    rememberProgressOrigin(requestId, 'summary'); openTotalReceiptProgress(supplierOrderId, requestId);
  }

  function renderOrderDashboard() {
    populateOrderFilters();
    const states = trackingRecords();
    // El seguimiento se cierra logísticamente al remitir todas las partidas. No dependemos
    // sólo del estado almacenado, pues pedidos históricos pueden conservar "activo".
    q('#trackingSummaryOpen').textContent = states.filter(({ request, progress }) => request.status !== 'cancelled' && progress.delivered < progress.requested).length;
    q('#trackingSummaryReceive').textContent = states.filter(({ request, progress }) => request.status !== 'cancelled' && progress.received < progress.purchased).length;
    q('#trackingSummaryDeliver').textContent = states.filter(({ request, progress }) => request.type === 'customer_order' && request.status !== 'cancelled' && progress.delivered < progress.requested).length;
    q('#trackingSummaryShipments').textContent = store.shipments.length;
    q('#orderMetricPurchase').textContent = states.filter(({ request, progress }) => request.status !== 'cancelled' && progress.purchased < progress.purchaseRequired).length;
    q('#orderMetricReceive').textContent = states.filter(({ request, progress }) => request.status !== 'cancelled' && progress.received < progress.purchased).length;
    q('#orderMetricDeliver').textContent = states.filter(({ request, progress }) => request.type === 'customer_order' && request.status !== 'cancelled' && progress.delivered < progress.requested).length;
    q('#orderMetricInvoice').textContent = states.filter(({ request, progress }) => request.type === 'customer_order' && request.status !== 'cancelled' && progress.invoiced < progress.requested).length;
    const term = searchKey(q('#orderSearch').value), status = q('#orderStatusFilter').value, stageFilter = q('#orderStageFilter').value, responsible = q('#orderResponsibleFilter').value;
    const from = q('#orderDateFrom').value, to = q('#orderDateTo').value;
    const stageMatches = ({ request, progress }) => !stageFilter || (stageFilter === 'purchase' && request.status !== 'cancelled' && progress.purchased < progress.purchaseRequired) || (stageFilter === 'receive' && request.status !== 'cancelled' && progress.received < progress.purchased) || (stageFilter === 'deliver' && request.type === 'customer_order' && request.status !== 'cancelled' && progress.delivered < progress.requested) || (stageFilter === 'invoice' && request.type === 'customer_order' && request.status !== 'cancelled' && progress.invoiced < progress.requested);
    const matches = states.filter(state => stageMatches(state) && (!term || state.search.includes(term)) && (!status || state.request.status === status) && (!responsible || state.request.responsible === responsible) && (!from || state.request.requestDate >= from) && (!to || state.request.requestDate <= to));
    const pageSize = Math.max(1, Number(q('#orderTrackingPageSize')?.value || trackingPageSize)); trackingPageSize = pageSize;
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize)); trackingPage = Math.min(Math.max(1, trackingPage), totalPages);
    const start = (trackingPage - 1) * pageSize, visible = matches.slice(start, start + pageSize);
    q('#orderTrackingResultCount').textContent = matches.length ? `${start + 1}–${Math.min(start + pageSize, matches.length)} de ${matches.length} pedidos` : 'Sin pedidos para los filtros actuales';
    const selected = matches.find(item => item.request.id === trackingSelectedRequestId) || visible[0] || null;
    trackingSelectedRequestId = selected?.request.id || null;
    q('#orderTrackingList').innerHTML = visible.map(record => {
      const { request, progress, stage } = record, overdue = request.requestDate && request.status !== 'closed' && request.status !== 'cancelled' && (Date.now() - new Date(`${request.requestDate}T12:00:00`).getTime()) > 30 * 86400000;
      const stageDisplay = (value, max, label, extra = '') => {
        if (max <= 0) {
          const detail = label === 'compradas' ? 'Sin compra externa' : label === 'recibidas' ? 'Sin recepción externa' : label;
          return `<div class="order-stage-progress not-applicable"><strong>Surtido desde almacén</strong><small>${detail}</small></div>`;
        }
        return `<div class="order-stage-progress ${overdue && value < max ? 'overdue' : ''}"><strong>${value} / ${max}</strong><small>${label}${extra}</small></div>`;
      };
      return `<article class="order-tracking-row ${request.id === trackingSelectedRequestId ? 'selected' : ''}" data-tracking-select="${escapeHtml(request.id)}"><div class="order-request"><strong>${escapeHtml(request.id)} · ${escapeHtml(request.customerName || 'Abastecimiento interno')}</strong><small>${formatDate(request.requestDate)} · ${escapeHtml(request.responsible || 'Sin responsable')}</small><small class="order-request-type">${request.type === 'internal_stock' ? 'STOCK INTERNO' : 'PEDIDO DE CLIENTE'}</small></div><div><div class="order-progress-bar"><i style="width:${Math.max(progress.purchasePercent, progress.receivePercent, progress.deliverPercent, progress.invoicePercent)}%"></i></div><small style="display:block;margin-top:5px;color:#879189;font-size:7px">${progress.lines.length} partida${progress.lines.length === 1 ? '' : 's'} · ${progress.requested} autorizadas · ${progress.reserved} reservadas</small></div>${stageDisplay(progress.purchased, progress.purchaseRequired, 'compradas')}${stageDisplay(progress.received, progress.purchaseRequired, 'recibidas')}${stageDisplay(progress.delivered, progress.requested, request.type === 'internal_stock' ? 'a stock' : 'entregadas')}<span class="order-status-badge ${stage.id === 'complete' ? 'active' : stage.id === 'cancelled' ? 'cancelled' : 'warning'}">${escapeHtml(stage.label)}</span><button class="order-row-action" data-order-detail="${escapeHtml(request.id)}" title="Abrir expediente"><i data-lucide="arrow-up-right"></i></button></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="route-off"></i><strong>No hay órdenes que coincidan</strong><span>Activa un pedido interno derivado de cotización o cambia los filtros.</span></div>';
    q('#orderTrackingPagination').innerHTML = matches.length > pageSize ? `<button type="button" data-tracking-page="${trackingPage - 1}" ${trackingPage === 1 ? 'disabled' : ''}>Anterior</button><span>Página ${trackingPage} de ${totalPages}</span><button type="button" data-tracking-page="${trackingPage + 1}" ${trackingPage === totalPages ? 'disabled' : ''}>Siguiente</button>` : '';
    renderTrackingQuickPanel(selected);
    window.lucide?.createIcons();
  }

  const deliveryState = progress => progress.delivered <= 0 ? 'pending' : progress.delivered < progress.requested ? 'partial' : 'completed';
  const deliveryStateLabel = (state, availability = null, needsSupplierRelation = false) => ({ pending: needsSupplierRelation ? 'Proveedor pendiente' : availability && availability.available <= 0 ? 'Pendiente de surtir' : 'Pendiente de entrega', partial: 'Entrega parcial', completed: 'Entrega completa' }[state] || 'Por revisar');
  function deliveryAvailability(progress) {
    const pending = progress.lines.map(line => ({ line, quantity: Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)) })).filter(item => item.quantity > 0);
    const available = pending.reduce((total, { line }) => total + Math.max(0, core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityDelivered) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived)), 0);
    return { pending, available, requested: pending.reduce((total, item) => total + item.quantity, 0), ready: Boolean(pending.length) && pending.every(({ line, quantity }) => core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityDelivered) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived) >= quantity) };
  }
  function deliveryRecords() {
    return store.requisitions.filter(request => request.type === 'customer_order' && request.status !== 'cancelled' && isOperationalRequest(request)).map(request => {
      const progress = requestProgress(request), shipments = store.shipments.filter(item => item.requisitionId === request.id), state = deliveryState(progress);
      return { request, progress, shipments, state, availability: deliveryAvailability(progress), search: linkedText(request) };
    });
  }
  function renderDeliveryQuickPanel(record) {
    const panel = q('#deliveryQuickPanel'); if (!panel) return;
    if (!record) { panel.innerHTML = '<div class="delivery-quick-empty"><i data-lucide="truck"></i><strong>Selecciona un pedido</strong><span>Consulta la disponibilidad, la siguiente salida y sus remisiones sin abrir todo el expediente.</span></div>'; return; }
    const { request, progress, shipments, state, availability } = record, latest = [...shipments].sort((a, b) => String(b.deliveredAt || b.date).localeCompare(String(a.deliveredAt || a.date)))[0], needsSupplierRelation = availability.available <= 0 && progress.lines.some(line => core.numberValue(line.quantityToPurchase) > 0 && !store.supplierOrderLines.some(link => link.orderLineId === line.id) && !resolveLineSupplier(line).valid);
    const documents = shipments.slice().sort((a, b) => String(b.deliveredAt || b.date).localeCompare(String(a.deliveredAt || a.date))).slice(0, 3).map(shipment => `<button class="delivery-document" data-delivery-document="${escapeHtml(shipment.id)}"><i data-lucide="file-text"></i>${escapeHtml(shipment.folio || 'Remisión')}</button>`).join('') || '<small class="delivery-no-document">Aún no hay remisiones emitidas.</small>';
    const action = state !== 'completed' && availability.ready && can('deliver') ? `<button class="delivery-quick-primary" data-delivery-formal-total="${escapeHtml(request.id)}"><i data-lucide="truck-check"></i> Generar remisión total</button>` : availability.available <= 0 ? `<button class="delivery-quick-primary" data-open-supply-resolution="${escapeHtml(request.id)}"><i data-lucide="shopping-bag"></i>${needsSupplierRelation ? 'Relacionar proveedor' : 'Revisar abastecimiento'}</button>` : '';
    const readiness = state === 'completed' ? 'Entrega completa; conserva sus documentos y acuse.' : availability.ready ? `${availability.requested} unidad(es) disponibles para la salida pendiente.` : needsSupplierRelation ? 'No se puede generar la OC: esta partida no tiene una relación activa con proveedor. Relaciónala antes de continuar.' : availability.available <= 0 ? 'Sin existencia disponible. Primero genera o confirma la compra y registra su recepción; después podrás emitir la remisión.' : `${availability.available} de ${availability.requested} unidad(es) disponibles; abre el expediente para una entrega parcial.`;
    panel.innerHTML = `<div class="delivery-quick-head"><small>PEDIDO SELECCIONADO</small><strong>${escapeHtml(request.clientOrderId || request.id)}</strong><span>${escapeHtml(request.customerName || 'Cliente')}</span></div><div class="delivery-quick-next"><small>SITUACIÓN DE ENTREGA</small><strong>${escapeHtml(readiness)}</strong><span class="order-status-badge ${state === 'completed' ? 'active' : state === 'partial' ? 'warning' : ''}">${deliveryStateLabel(state, availability, needsSupplierRelation)}</span></div><dl class="delivery-quick-metrics"><div><dt>Entregado</dt><dd>${progress.delivered} / ${progress.requested}</dd></div><div><dt>Pendiente</dt><dd>${availability.requested}</dd></div><div><dt>Remisiones</dt><dd>${shipments.length}</dd></div><div><dt>Última salida</dt><dd>${escapeHtml(latest?.folio || 'Sin emitir')}</dd></div></dl><div class="delivery-quick-documents"><small>DOCUMENTOS RECIENTES</small><div>${documents}</div></div>${action}<button class="delivery-quick-secondary" data-open-tracking-workbench="${escapeHtml(request.id)}"><i data-lucide="list-tree"></i> Ver seguimiento integral</button><button class="delivery-quick-secondary" data-order-detail="${escapeHtml(request.id)}"><i data-lucide="folder-open"></i> Ver expediente completo</button>`;
  }
  function renderDeliveries() {
    const states = deliveryRecords();
    q('#deliveryMetricPending').textContent = states.filter(({ state }) => state === 'pending').length;
    q('#deliveryMetricPartial').textContent = states.filter(({ state }) => state === 'partial').length;
    q('#deliveryMetricCompleted').textContent = states.filter(({ state }) => state === 'completed').length;
    q('#deliveryMetricDocuments').textContent = states.reduce((total, record) => total + record.shipments.length, 0);
    const term = searchKey(q('#deliverySearch').value), status = q('#deliveryStatusFilter').value;
    const matches = states.filter(record => (!term || record.search.includes(term)) && (!status || record.state === status));
    const pageSize = Math.max(1, Number(q('#deliveryPageSize')?.value || deliveryPageSize)); deliveryPageSize = pageSize;
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize)); deliveryPage = Math.min(Math.max(1, deliveryPage), totalPages);
    const start = (deliveryPage - 1) * pageSize, visible = matches.slice(start, start + pageSize);
    q('#deliveryResultCount').textContent = matches.length ? `${start + 1}–${Math.min(start + pageSize, matches.length)} de ${matches.length} pedidos` : 'Sin entregas para los filtros actuales';
    const selected = matches.find(item => item.request.id === deliverySelectedRequestId) || visible[0] || null; deliverySelectedRequestId = selected?.request.id || null;
    q('#deliveryTrackingList').innerHTML = visible.map(record => {
      const { request, progress, shipments, state, availability } = record, latest = [...shipments].sort((a, b) => String(b.deliveredAt || b.date).localeCompare(String(a.deliveredAt || a.date)))[0], needsSupplierRelation = availability.available <= 0 && progress.lines.some(line => core.numberValue(line.quantityToPurchase) > 0 && !store.supplierOrderLines.some(link => link.orderLineId === line.id) && !resolveLineSupplier(line).valid);
      const documents = latest ? `<button class="delivery-document" data-delivery-document="${escapeHtml(latest.id)}" title="Previsualizar ${escapeHtml(latest.folio || 'remisión')}"><i data-lucide="file-text"></i>${escapeHtml(latest.folio || 'Remisión')}</button>${shipments.length > 1 ? `<small>+${shipments.length - 1}</small>` : ''}` : '<small class="delivery-no-document">Sin remisión</small>';
      return `<article class="delivery-tracking-row ${request.id === deliverySelectedRequestId ? 'selected' : ''}" data-delivery-select="${escapeHtml(request.id)}"><div class="order-request"><strong>${escapeHtml(request.clientOrderId || request.id)} · ${escapeHtml(request.customerName || 'Cliente')}</strong><small>${progress.lines.length} partida${progress.lines.length === 1 ? '' : 's'} · ${progress.requested} ${progress.requested === 1 ? 'unidad' : 'unidades'}</small></div><div class="delivery-progress"><div class="order-progress-bar"><i style="width:${progress.deliverPercent}%"></i></div><small>${progress.delivered} de ${progress.requested} ${progress.requested === 1 ? 'entregada' : 'entregadas'}</small></div><div class="delivery-latest"><strong>${escapeHtml(latest?.folio || 'Sin remisión')}</strong><small>${latest ? formatDate(latest.date || String(latest.deliveredAt || '').slice(0, 10)) : 'Aún no emitida'}</small></div><span class="order-status-badge ${state === 'completed' ? 'active' : state === 'partial' ? 'warning' : ''}">${deliveryStateLabel(state, availability, needsSupplierRelation)}</span><div class="delivery-documents">${documents}</div><button class="order-row-action" data-order-detail="${escapeHtml(request.id)}" title="Abrir expediente"><i data-lucide="arrow-up-right"></i></button></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="package-search"></i><strong>No hay entregas que coincidan</strong><span>Cambia el filtro o activa un pedido interno para iniciar el seguimiento.</span></div>';
    q('#deliveryPagination').innerHTML = matches.length > pageSize ? `<button type="button" data-delivery-page="${deliveryPage - 1}" ${deliveryPage === 1 ? 'disabled' : ''}>Anterior</button><span>Página ${deliveryPage} de ${totalPages}</span><button type="button" data-delivery-page="${deliveryPage + 1}" ${deliveryPage === totalPages ? 'disabled' : ''}>Siguiente</button>` : '';
    renderDeliveryQuickPanel(selected); window.lucide?.createIcons();
  }

  function renderLegacyOrderDetail(requestId) {
    const request = store.requisitions.find(item => item.id === requestId);
    if (!request) return;
    activeRequestId = requestId;
    const lines = requestLines(request.id), progress = requestProgress(request);
    const audits = store.auditLog.filter(entry => entry.entityId === request.id || lines.some(line => line.id === entry.entityId)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const supplierOrders = store.supplierOrders.filter(order => order.requisitionIds?.includes(request.id));
    const supplierOrderIds = new Set(supplierOrders.map(order => order.id));
    const supplierInvoices = store.supplierInvoices.filter(invoice => invoice.supplierOrderIds?.some(id => supplierOrderIds.has(id)));
    const customerInvoices = store.customerInvoices.filter(invoice => invoice.requisitionId === request.id);
    const shipments = store.shipments.filter(shipment => shipment.requisitionId === request.id);
    const inventoryDocuments = store.inventoryMovements.filter(movement => movement.requisitionId === request.id);
    const documentActions = `<div class="flow-document-actions">${request.quotationId ? `<button data-flow-document="quotation" data-flow-id="${escapeHtml(request.quotationId)}"><i data-lucide="file-text"></i>Cotización</button>` : ''}${request.clientOrderId ? `<button data-flow-document="client_order" data-flow-id="${escapeHtml(request.clientOrderId)}"><i data-lucide="clipboard-check"></i>Pedido interno</button>` : ''}${supplierOrders.map(order => `<button data-flow-document="supplier_order" data-flow-id="${escapeHtml(order.id)}"><i data-lucide="shopping-bag"></i>${escapeHtml(order.id)}</button>`).join('')}${inventoryDocuments.map(movement => `<button data-flow-document="inventory" data-flow-id="${escapeHtml(movement.id)}"><i data-lucide="${movement.type === 'entry' ? 'arrow-down-to-line' : 'arrow-up-from-line'}"></i>${movement.type === 'entry' ? 'Entrada' : 'Salida'}</button>`).join('')}${shipments.map(shipment => `<button data-flow-document="remision" data-flow-id="${escapeHtml(shipment.id)}"><i data-lucide="truck"></i>${escapeHtml(shipment.folio || 'Remisión')}</button>`).join('')}</div>`;
    const documentsHtml = `<section class="order-detail-section"><h3>Cadena documental</h3><div class="order-detail-summary"><div><span>COTIZACIÓN</span><strong>${request.quotationId ? '1' : '0'}</strong><small>${escapeHtml(request.quotationId || 'Sin cotización vinculada')}</small></div><div><span>PEDIDO INTERNO</span><strong>${request.clientOrderId ? '1' : '0'}</strong><small>${escapeHtml(request.clientOrderId ? `${request.clientOrderId} · ${request.clientOrderStatus === 'active' ? 'Activo' : 'Por activar'}` : 'Sin pedido interno')}</small></div><div><span>OC A PROVEEDOR</span><strong>${supplierOrders.length}</strong><small>${escapeHtml(supplierOrders.map(order => order.id).join(', ') || 'Sin OC')}</small></div><div><span>ENTRADAS DE ALMACÉN</span><strong>${inventoryDocuments.filter(movement => movement.type === 'entry').length}</strong><small>Recepciones documentadas</small></div><div><span>SALIDAS / REMISIONES</span><strong>${shipments.length}</strong><small>${escapeHtml(shipments.map(shipment => shipment.folio).filter(Boolean).join(', ') || 'Sin remisión')}</small></div><div><span>FACTURAS CLIENTE</span><strong>${customerInvoices.length}</strong><small>${escapeHtml(customerInvoices.map(invoice => invoice.accountReference || invoice.folio).filter(Boolean).join(', ') || 'Sin factura')}</small></div></div>${documentActions}</section>`;
    q('#orderDetailTitle').textContent = `${request.id} · ${request.customerName || 'Abastecimiento de stock'}`;
    q('#orderDetailBody').innerHTML = `<div class="order-detail-summary"><div><span>ESTADO</span><strong>${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</strong></div><div><span>RESPONSABLE</span><strong>${escapeHtml(request.responsible || 'Sin asignar')}</strong></div><div><span>FECHA DE SOLICITUD</span><strong>${formatDate(request.requestDate)}</strong></div><div><span>AVANCE</span><strong>${progress.delivered} entregadas / ${progress.requested}</strong></div></div><section class="order-detail-section"><h3>Partidas y cantidades</h3>${lines.map(line => {
      const authorized = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled));
      const completion = authorized ? Math.round(core.numberValue(line.quantityDelivered) / authorized * 100) : 0;
      const supply = lineSupply(line);
      return `<div class="order-detail-line"><div><strong>${escapeHtml(line.catalog || 'Sin catálogo')} · ${escapeHtml(line.description)}</strong><small>${escapeHtml(line.brandName || 'Sin marca')} · ${escapeHtml(core.STATUS_LABELS[line.status] || line.status)}</small><div class="order-line-progress"><i style="width:${Math.min(100, completion)}%"></i></div></div><span>Sol. ${line.quantityRequested}</span><span>Res. ${core.numberValue(line.reservedQuantity)}</span><span>Comprar ${supply.pendingPurchase}</span><span>Rec. ${supply.received}</span><span>Ent. ${line.quantityDelivered}</span><span>${Number(line.total || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}</span><button class="order-line-action" data-order-progress="${line.id}" ${request.status === 'cancelled' ? 'disabled' : ''}>Registrar avance</button></div>`;
    }).join('')}</section>${documentsHtml}<section class="order-detail-section"><h3>Historial auditable</h3>${audits.map(entry => `<div class="order-audit-item"><small>${new Date(entry.at).toLocaleString('es-MX', { timeZone: BUSINESS_TIME_ZONE })}</small><span><strong>${escapeHtml(auditActionLabel(entry.action))}</strong><br>${escapeHtml(entry.reference || entry.source?.fileHash || 'Sin referencia documental')}</span><small>${escapeHtml(entry.user || 'Sistema')}</small></div>`).join('') || '<p class="subtitle">Sin eventos registrados.</p>'}</section>`;
    q('#orderDetailDialog').showModal();
    window.lucide?.createIcons();
  }

  async function downloadOrderAudit(requestId, preview = false) {
    const request = resolveOperationalRequest(requestId);
    const button = preview ? q('#downloadOrderAudit') : null, finish = preview ? window.BioOperationProgress?.start('Preparando expediente…', button) : null;
    try {
    if (!request) throw new Error('No se encontró el pedido relacionado con este expediente.');
    if (!window.jspdf?.jsPDF) await window.BioLibraries?.pdf?.();
    const PDF = window.jspdf?.jsPDF;
    if (!PDF) throw new Error('No fue posible cargar el generador del expediente PDF.');
    const lines = requestLines(request.id), audits = store.auditLog.filter(entry => entry.entityId === request.id || lines.some(line => line.id === entry.entityId)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const doc = new PDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const header = () => { doc.setFillColor(23, 34, 29); doc.rect(0, 0, 210, 38, 'F'); doc.setFillColor(185, 250, 129); doc.roundedRect(16, 11, 15, 15, 3, 3, 'F'); doc.setTextColor(19, 32, 25); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('P', 23.5, 20.5, { align: 'center' }); doc.setTextColor(255, 255, 255); doc.setFontSize(15); doc.text(`${BRAND.name} · EXPEDIENTE OPERATIVO`, 38, 18); doc.setTextColor(166, 181, 171); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text('PEDIDOS, COMPRAS, RECEPCIONES, FACTURACIÓN Y ENTREGAS', 38, 25); };
    header();
    doc.setFillColor(247, 249, 246); doc.roundedRect(16, 47, 178, 34, 3, 3, 'F'); doc.setTextColor(35, 49, 39); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(request.id, 22, 58); doc.setFontSize(9); doc.text(doc.splitTextToSize(request.customerName || 'Abastecimiento interno de stock', 100), 22, 67); doc.setTextColor(112, 126, 116); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(`Estado: ${core.STATUS_LABELS[request.status] || request.status}`, 142, 57); doc.text(`Solicitud: ${formatDate(request.requestDate)}`, 142, 65); doc.text(`Responsable: ${request.responsible || 'Sin asignar'}`, 142, 73);
    let y = 94;
    doc.setTextColor(36, 50, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('PARTIDAS', 16, y); y += 7;
    lines.forEach((line, index) => { const supply = lineSupply(line); if (y > 248) { doc.addPage(); header(); y = 50; } doc.setFillColor(index % 2 ? 250 : 246, index % 2 ? 251 : 248, index % 2 ? 249 : 245); doc.roundedRect(16, y - 4, 178, 15, 2, 2, 'F'); doc.setTextColor(37, 51, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(doc.splitTextToSize(`${line.catalog || 'S/C'} · ${line.description}`, 92), 21, y + 1); doc.setTextColor(101, 115, 105); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(`Sol. ${line.quantityRequested} · Res. ${core.numberValue(line.reservedQuantity)} · Comp. ${supply.purchased} · Rec. ${supply.received}`, 116, y + 1); doc.text(`Ent. ${line.quantityDelivered} · Pend. compra ${supply.pendingPurchase} · Estado: ${core.STATUS_LABELS[line.status] || line.status}`, 116, y + 7); y += 18; });
    if (y > 225) { doc.addPage(); header(); y = 50; }
    doc.setTextColor(36, 50, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('BITÁCORA', 16, y); y += 7;
    audits.forEach(entry => { if (y > 265) { doc.addPage(); header(); y = 50; } doc.setTextColor(45, 59, 49); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text(`${new Date(entry.at).toLocaleString('es-MX', { timeZone: BUSINESS_TIME_ZONE })} · ${auditActionLabel(entry.action)}`, 18, y); doc.setTextColor(111, 124, 114); doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(`${entry.user || 'Sistema'} · ${entry.reference || entry.source?.fileHash || 'Sin referencia'}`, 165), 18, y + 5); y += 11; });
    const pages = doc.getNumberOfPages(), fingerprint = core.hashString(JSON.stringify({ request, lines, audits }));
    for (let page = 1; page <= pages; page += 1) { doc.setPage(page); doc.setDrawColor(226, 231, 226); doc.line(16, 281, 194, 281); doc.setTextColor(130, 142, 133); doc.setFont('courier', 'normal'); doc.setFontSize(6); doc.text(`Huella de expediente: ${fingerprint}`, 16, 287); doc.setFont('helvetica', 'normal'); doc.text(`Página ${page} de ${pages}`, 194, 287, { align: 'right' }); }
    if (preview) {
      if (!window.BioFlowDocs?.previewBlob) throw new Error('El visor de documentos no está disponible.');
      window.BioFlowDocs.previewBlob(doc.output('blob'), { title: 'EXPEDIENTE OPERATIVO', folio: request.id, filename: `expediente-${request.id}.pdf` });
      if (!q('#documentPreviewDialog')?.open) throw new Error('No fue posible abrir la vista previa del expediente.');
      return doc;
    }
    doc.save(`expediente-${request.id}.pdf`);
    return doc;
    } catch (error) {
      console.error('No fue posible preparar el expediente:', error);
      notify(error?.message || 'No fue posible generar el expediente PDF.');
      return null;
    } finally { finish?.(); }
  }

  const progressGrid = q('#orderProgressForm .order-progress-grid');
  progressGrid?.insertAdjacentHTML('afterbegin', `<section id="trackingExtraFields" class="receipt-extra-fields wide"><div class="receipt-extra-heading"><strong id="trackingFieldsTitle">Resultado del seguimiento</strong><small>El sistema conserva automáticamente usuario, fecha, pedido, responsable actual y estado operativo.</small></div><div class="receipt-extra-grid"><label class="field" id="trackingResultField"><span>Resultado</span><select id="orderProgressResult"><option value="contacted">Contacto realizado</option><option value="confirmed">Confirmado</option><option value="pending">Pendiente</option><option value="blocked">Bloqueado</option></select></label><label class="field" id="trackingStatusField" hidden><span>Nuevo estado de seguimiento</span><select id="orderProgressStatus"><option value="pending">Pendiente</option><option value="in_progress">En proceso</option><option value="waiting_supplier">En espera de proveedor</option><option value="waiting_client">En espera de cliente</option><option value="resolved">Resuelto</option></select></label><label class="field" id="trackingDocumentField" hidden><span>Tipo de documento</span><select id="orderProgressDocumentType"><option value="supplier_confirmation">Confirmación de proveedor</option><option value="customer_authorization">Autorización del cliente</option><option value="price_change_authorization">Autorización de cambio</option><option value="other">Otro</option></select></label><label class="field" id="trackingPriorityField" hidden><span>Prioridad</span><select id="orderProgressPriority"><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label><label class="field"><span>Próximo responsable</span><input id="orderProgressAssignee" placeholder="Se asigna automáticamente" /></label><label class="field wide"><span>Evidencia <em id="orderProgressEvidenceHint">opcional</em></span><input id="orderProgressEvidence" type="file" accept="image/*,.pdf,.eml,.msg" multiple /><small>Máximo cinco archivos; se guardan con huella y sin eliminación física.</small></label></div></section>`);
  progressGrid?.insertAdjacentHTML('beforeend', `<section id="receiptExtraFields" class="receipt-extra-fields wide"><div class="receipt-extra-heading"><strong>Recepción física</strong><small>Requiere remisión del proveedor y evidencia; la factura se concilia después.</small></div><div class="receipt-extra-grid"><label class="field"><span>Documento de llegada</span><select id="receiptDocumentType"><option value="supplier_remission">Remisión del proveedor</option><option value="supplier_invoice">Factura del proveedor</option><option value="other">Otro documento</option></select></label><label class="field"><span>Almacén receptor</span><select id="receiptWarehouse"><option value="1">Almacén 01</option><option value="2">Almacén 02</option></select></label><label class="field"><span>Cantidad rechazada</span><input id="receiptRejectedQuantity" type="number" min="0" step="1" value="0" /></label><label class="field"><span>Estado de calidad</span><select id="receiptQualityStatus"><option value="released">Liberada / disponible</option><option value="quarantine">Inspección / cuarentena</option><option value="rejected">Rechazada</option></select></label><label class="field"><span>Lote</span><input id="receiptLot" placeholder="Opcional" /></label><label class="field"><span>Serie</span><input id="receiptSerial" placeholder="Opcional" /></label><label class="field"><span>Caducidad</span><input id="receiptExpiry" type="date" /></label><label class="field"><span>Remisión y evidencia <em>obligatoria</em></span><input id="receiptEvidence" type="file" accept="image/*,.pdf" multiple /></label><section id="receiptShortageField" class="receipt-shortage-required" hidden><div class="receipt-shortage-heading"><strong>Recepción parcial: indica cómo se atenderá el faltante</strong><small>Esta información es obligatoria porque la cantidad recibida es menor a la pendiente.</small></div><label class="field"><span>Tratamiento del faltante</span><select id="receiptShortageResolution"><option value="">Selecciona cómo se resolverá</option><option value="same_order">Llegará posteriormente en la misma OC</option><option value="new_shipment">Llegará en otro embarque</option><option value="new_supplier_order">Se relacionará con otra OC</option><option value="other_supplier">Se comprará con otro proveedor</option><option value="substitution">Se sustituirá con autorización</option><option value="supplier_unavailable">El proveedor no puede entregar</option><option value="authorized_cancellation">Cancelar saldo autorizado</option></select></label><label class="field"><span>Fecha compromiso del faltante</span><input id="receiptShortageCommitment" type="date" /></label><label class="field wide"><span>Motivo, autorización o referencia</span><textarea id="receiptShortageNotes" rows="2" placeholder="Requerido para cambio de proveedor, sustitución, indisponibilidad o cancelación"></textarea></label></section></div></section>`);
  progressGrid?.insertAdjacentHTML('beforeend', `<section id="deliveryExtraFields" class="receipt-extra-fields wide" hidden><div class="receipt-extra-heading"><strong>Confirmación de entrega</strong><small>La salida se genera con esta remisión y requiere evidencia del cliente.</small></div><div class="receipt-extra-grid"><label class="field"><span>Recibió</span><input id="deliveryRecipient" placeholder="Nombre de quien recibe" required /></label><label class="field"><span>Fecha programada</span><input id="deliveryScheduledAt" type="date" /></label><label class="field wide"><span>Remisión firmada, foto o firma <em>obligatoria</em></span><input id="deliveryEvidence" type="file" accept="image/*,.pdf" multiple /></label></div></section>`);
  const trackingTypes = { follow_up: 'Seguimiento realizado', status_change: 'Cambio de estado', commitment: 'Compromiso o próxima acción', document: 'Documento recibido', incident: 'Incidencia o bloqueo', other: 'Otro' };
  const formalTypes = { receipt: 'Registrar recepción', delivery: 'Generar remisión', invoice: 'Registrar factura', cancel: 'Cancelar partida' };
  const formField = id => q(`#${id}`)?.closest('.field');
  const trackingFieldSlots = new Map();
  function showRequiredTrackingFields(mode) {
    const optional = q('#trackingOptionalFields'), grid = q('.order-progress-grid');
    if (!optional || !grid) return;
    let visible = q('#trackingRequiredFields');
    if (!visible) {
      visible = document.createElement('section'); visible.id = 'trackingRequiredFields'; visible.className = 'receipt-extra-fields wide';
      visible.innerHTML = '<div class="receipt-extra-heading"><strong>Datos obligatorios del seguimiento</strong></div><div class="receipt-extra-grid"></div>';
      optional.before(visible);
    }
    trackingFieldSlots.forEach((slot, field) => slot.after(field));
    if (mode === 'tracking') optional.querySelectorAll('input[required],select[required],textarea[required]').forEach(input => {
      const field = input.closest('.field'); if (!field || field.hidden) return;
      if (!trackingFieldSlots.has(field)) { const slot = document.createComment('Ubicación del campo opcional'); field.before(slot); trackingFieldSlots.set(field, slot); }
      visible.querySelector('.receipt-extra-grid').append(field);
    });
    visible.hidden = mode !== 'tracking' || !visible.querySelector('input,select,textarea');
    ['orderProgressNotes','orderProgressBlockers'].forEach(id => {
      const input = q(`#${id}`), label = formField(id)?.querySelector('span'); if (!input || !label) return;
      const name = id === 'orderProgressNotes' ? 'Descripción del avance' : 'Bloqueos u observaciones';
      label.innerHTML = `${name} <em>${input.required ? 'obligatorio' : 'opcional'}</em>`;
    });
  }
  const toggleReceiptFields = () => {
    const storedMode=q('#orderProgressForm').dataset.mode||'tracking',mode=storedMode.startsWith('formal-total-')?'formal':storedMode,totalReceipt=storedMode==='formal-total-receipt',type = q('#orderProgressType').value, receipt = mode === 'formal' && type === 'receipt', delivery = mode === 'formal' && type === 'delivery';
    q('#receiptExtraFields').hidden = !receipt; q('#deliveryExtraFields').hidden = !delivery; q('#deliveryRecipient').required = delivery; q('#trackingExtraFields').hidden = mode === 'formal'; q('#trackingOptionalFields').hidden = mode === 'formal';
    [formField('orderProgressQuantity'), q('#orderProgressSupplierField'), formField('orderProgressReference'), formField('orderProgressOverride')].filter(Boolean).forEach(field => field.hidden = mode !== 'formal');
    q('#orderProgressOverride')?.closest('.order-override')?.toggleAttribute('hidden', mode !== 'formal'); formField('orderProgressNotes').hidden = false; formField('deliveryScheduledAt').hidden = false;
    if (delivery) { q('#orderProgressSupplierField').hidden = true; formField('orderProgressNotes').hidden = true; q('#orderProgressOverride')?.closest('.order-override')?.setAttribute('hidden',''); formField('deliveryScheduledAt').hidden = true; }
    [formField('orderProgressNextAction'), formField('orderProgressCommitmentDate'), formField('orderProgressBlockers')].filter(Boolean).forEach(field => field.hidden = mode === 'formal');
    const needsStatus = type === 'status_change', needsDocument = type === 'document', needsIncident = type === 'incident';
    q('#trackingStatusField').hidden = !needsStatus; q('#trackingDocumentField').hidden = !needsDocument; q('#trackingPriorityField').hidden = !needsIncident;
    q('#orderProgressEvidenceHint').textContent = needsDocument || needsIncident ? 'obligatoria' : 'opcional';
    const validation = window.BioFormValidation; const mark = (id, required) => { const field = q(`#${id}`); if (!field) return; validation?.markRequired(field, required); if (!required) validation?.clearFieldError(field); };
    mark('orderProgressNotes', mode === 'tracking'); mark('orderProgressNextAction', mode === 'tracking' && type === 'commitment'); mark('orderProgressCommitmentDate', mode === 'tracking' && type === 'commitment'); mark('orderProgressBlockers', mode === 'tracking' && type === 'incident'); mark('orderProgressAssignee', mode === 'tracking' && ['commitment', 'incident'].includes(type)); mark('orderProgressEvidence', mode === 'tracking' && ['document', 'incident'].includes(type)); mark('orderProgressStatus', mode === 'tracking' && needsStatus); mark('orderProgressQuantity', mode === 'formal' && !totalReceipt); mark('orderProgressReference', mode === 'formal' && ['receipt', 'invoice', 'account_charge'].includes(type));
    mark('receiptEvidence', receipt); mark('receiptShortageResolution', !q('#receiptShortageField').hidden); mark('receiptShortageCommitment', !q('#receiptShortageField').hidden); mark('receiptShortageNotes', !q('#receiptShortageField').hidden && ['other_supplier', 'substitution', 'supplier_unavailable', 'authorized_cancellation'].includes(q('#receiptShortageResolution').value)); mark('deliveryRecipient', mode === 'formal' && type === 'delivery'); mark('deliveryEvidence', mode === 'formal' && type === 'delivery');
    showRequiredTrackingFields(mode);
    q('#orderProgressReferenceLabel').textContent = ({ receipt: 'Remisión del proveedor', delivery: 'Folio de remisión generado por PROBIOLAB', invoice: 'Folio de factura', cancel: 'Motivo / autorización' })[type] || 'Documento / referencia';
    q('#orderProgressReference').placeholder = ({ receipt: 'Captura el folio impreso en la remisión del proveedor', delivery: 'Se genera automáticamente al emitir la remisión', invoice: 'Folio de factura', account_charge: 'Referencia de manejo de cuenta', cancel: 'Motivo o autorización' })[type] || 'Documento o referencia';
    q('#orderProgressReference').readOnly = mode === 'formal' && type === 'delivery';
    const line = store.orderLines.find(item => item.id === q('#orderProgressLineId').value); if (!line || mode !== 'formal') return;
    const remaining = type === 'receipt' ? Math.max(0, core.numberValue(line.quantityPurchased) - core.numberValue(line.quantityReceived)) : type === 'delivery' ? Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)) : type === 'invoice' ? Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityInvoiced)) : Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled));
    const deliveryAvailable = delivery ? Math.max(0, core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityDelivered) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived)) : remaining;
    const formalLimit = delivery ? Math.min(remaining, deliveryAvailable) : remaining;
    const quantityInput=q('#orderProgressQuantity'),quantityLabel=formField('orderProgressQuantity')?.querySelector('span');
    if(totalReceipt){quantityInput.max=quantityInput.value||Math.max(1,remaining);quantityInput.readOnly=true;quantityInput.setAttribute('aria-readonly','true');if(quantityLabel)quantityLabel.textContent='Cantidad total a recibir';q('#orderProgressRemaining').textContent='La recepción incluirá todas las partidas pendientes.';}else{quantityInput.readOnly=false;quantityInput.removeAttribute('aria-readonly');if(quantityLabel)quantityLabel.textContent=delivery?'Cantidad disponible para entregar':'Cantidad de este avance';quantityInput.max=Math.max(0,formalLimit);if(!quantityInput.dataset.formalDefaulted){quantityInput.value=formalLimit;quantityInput.dataset.formalDefaulted='true';}q('#orderProgressRemaining').textContent=delivery?`Pendiente: ${remaining} uds. · Disponible para entregar: ${formalLimit} uds.`:`Pendiente formal: ${remaining} uds.`;}
    const rejectedForForm=q('#receiptQualityStatus').value==='rejected'?Number(q('#orderProgressQuantity').value||0):Number(q('#receiptRejectedQuantity').value||0);q('#receiptShortageField').hidden = !receipt || (totalReceipt?rejectedForForm<=0:Math.max(0,Number(q('#orderProgressQuantity').value||0)-rejectedForForm)>=remaining);
    mark('receiptShortageResolution', !q('#receiptShortageField').hidden); mark('receiptShortageCommitment', !q('#receiptShortageField').hidden); mark('receiptShortageNotes', !q('#receiptShortageField').hidden && ['other_supplier', 'substitution', 'supplier_unavailable', 'authorized_cancellation'].includes(q('#receiptShortageResolution').value));
  };

  function simplifyProgressForm() {
    const minimumDate = businessToday();
    ['orderProgressCommitmentDate', 'receiptExpiry', 'receiptShortageCommitment', 'deliveryScheduledAt'].forEach(id => q(`#${id}`)?.setAttribute('min', minimumDate));
    const grid = q('.order-progress-grid'), tracking = q('#trackingExtraFields');
    const typeLabel = formField('orderProgressType')?.querySelector('span');
    if (typeLabel && !typeLabel.dataset.tooltip) { typeLabel.classList.add('progress-field-help'); typeLabel.dataset.tooltip = 'Selecciona el tipo de actualización que estás registrando en el pedido.'; typeLabel.tabIndex = 0; }
    if (grid && tracking && !q('#trackingOptionalFields')) {
      const details = document.createElement('details'); details.id = 'trackingOptionalFields'; details.className = 'order-progress-optional wide'; details.innerHTML = '<summary>Más opciones de seguimiento</summary>';
      tracking.parentNode.insertBefore(details, tracking); details.append(tracking);
      const blockers = formField('orderProgressBlockers'); if (blockers) details.append(blockers);
    }
    const receiptGrid = q('#receiptExtraFields .receipt-extra-grid');
    if (receiptGrid && !q('#receiptOptionalFields')) {
      const details = document.createElement('details'); details.id = 'receiptOptionalFields'; details.className = 'order-progress-optional receipt-optional-fields'; details.innerHTML = '<summary>Datos adicionales: almacén, calidad, lote y caducidad</summary>';
      receiptGrid.append(details);
      ['receiptDocumentType','receiptWarehouse','receiptRejectedQuantity','receiptQualityStatus','receiptLot','receiptSerial','receiptExpiry'].forEach(id => { const field = formField(id); if (field) details.append(field); });
    }
  }

  function updateProgressTypeHint() {
    const select = q('#orderProgressType'), label = formField('orderProgressType')?.querySelector('.progress-field-help'); if (!select || !label) return;
    const hints = { follow_up: 'Registra una llamada, correo o contacto realizado, sin cambiar el estado del pedido.', status_change: 'Usa esta opción cuando cambie la situación actual del pedido.', commitment: 'Registra una acción o fecha acordada para dar continuidad al pedido.', document: 'Registra un documento o evidencia recibida para este pedido.', incident: 'Registra un bloqueo, retraso o problema que requiere atención.', other: 'Registra una actualización que no corresponde a las opciones anteriores.', receipt: 'Registra la recepción física y genera el movimiento de entrada.', delivery: 'Genera la remisión y registra la entrega al cliente.', invoice: 'Registra la factura relacionada con esta partida.', cancel: 'Cancela la partida y conserva la justificación en el historial.' };
    label.dataset.tooltip = hints[select.value] || 'Selecciona el tipo de actualización que estás registrando en el pedido.';
  }

  function updateProgressResultHint() {
    const select = q('#orderProgressResult'), label = formField('orderProgressResult')?.querySelector('span'); if (!select || !label) return;
    label.classList.add('progress-field-help'); label.tabIndex = 0;
    const hints = { contacted: 'Indica que se realizó el contacto, pero aún no hay una confirmación final.', confirmed: 'Indica que la información, fecha o acción ya fue confirmada.', pending: 'Indica que el seguimiento continúa pendiente de respuesta o ejecución.', blocked: 'Indica que existe un bloqueo que impide avanzar y debe documentarse.' };
    label.dataset.tooltip = hints[select.value] || 'Selecciona el resultado actual del seguimiento.';
  }

  function openProgress(lineId) {
    const line = store.orderLines.find(item => item.id === lineId), request = line && store.requisitions.find(item => item.id === line.requisitionId);
    if (!line || !request) return;
    simplifyProgressForm(); q('#orderProgressForm').dataset.mode = 'tracking'; q('#orderProgressDialog .eyebrow').textContent = 'ACTUALIZACIÓN DEL PEDIDO'; q('#orderProgressDialog h2').textContent = 'Registrar avance'; q('#orderProgressDialog .confirm-note span').textContent = 'Completa solo los campos marcados con *.'; q('#orderProgressForm .submit').innerHTML = 'Guardar avance <i data-lucide="arrow-right"></i>'; formField('orderProgressNotes').querySelector('span').innerHTML = 'Descripción breve <em>obligatoria</em>'; q('#orderProgressLineId').value = line.id;
    q('#orderProgressContext').innerHTML = `<strong>${escapeHtml(request.id)} · ${escapeHtml(line.catalog || 'Sin catálogo')}</strong><br>${escapeHtml(request.customerName || 'Stock interno')} · ${escapeHtml(core.STATUS_LABELS[request.status] || request.status)} · Responsable: ${escapeHtml(request.responsible || actor.name)} · Compromiso: ${escapeHtml(line.committedDate || 'Por definir')}<br><small>${escapeHtml(line.description)} · Solicitadas ${line.quantityRequested} · Recibidas ${line.quantityReceived} · Entregadas ${line.quantityDelivered}</small>`;
    q('#orderProgressType').innerHTML = Object.entries(trackingTypes).map(([value, label]) => `<option value="${value}">${label}</option>`).join(''); q('#orderProgressType').value = 'follow_up'; updateProgressTypeHint(); q('#orderProgressNotes').value = ''; q('#orderProgressNextAction').value = ''; q('#orderProgressCommitmentDate').value = line.committedDate || ''; q('#orderProgressAssignee').value = request.responsible || actor.name; q('#orderProgressEvidence').value = ''; q('#orderProgressResult').value = 'contacted'; updateProgressResultHint(); toggleReceiptFields();
    let supplierCatalog = [];
    try { supplierCatalog = JSON.parse(localStorage.getItem('nexo-suppliers') || '[]'); } catch {}
    q('#orderSupplierOptions').innerHTML = supplierCatalog.map(supplier => `<option value="${escapeHtml(supplier.name)}"></option>`).join('');
    q('#orderProgressDialog').showModal();
  }

  function openFormalProgress(lineId, type) {
    const line = store.orderLines.find(item => item.id === lineId), request = line && store.requisitions.find(item => item.id === line.requisitionId); if (!line || !request) return;
    simplifyProgressForm(); q('#orderProgressForm').dataset.mode = 'formal'; formField('orderProgressQuantity').hidden=false; q('#orderProgressDialog .eyebrow').textContent = 'OPERACIÓN FORMAL'; q('#orderProgressDialog h2').textContent = formalTypes[type] || 'Registrar operación'; q('#orderProgressDialog .confirm-note span').textContent = 'Completa solo los campos marcados con *.'; q('#orderProgressForm .submit').innerHTML = `${formalTypes[type] || 'Guardar operación'} <i data-lucide="arrow-right"></i>`; formField('orderProgressNotes').querySelector('span').innerHTML = 'Observaciones <em>opcional</em>'; q('#orderProgressLineId').value = line.id; q('#orderProgressType').innerHTML = `<option value="${type}">${formalTypes[type] || type}</option>`; q('#orderProgressType').value = type; updateProgressTypeHint();
    q('#orderProgressContext').innerHTML = `<strong>${escapeHtml(request.id)} · ${escapeHtml(line.catalog || 'Sin catálogo')}</strong><br>${escapeHtml(request.customerName || 'Stock interno')} · ${escapeHtml(line.description)}<br><small>Esta operación genera el documento y movimiento formal correspondiente; no es un seguimiento manual.</small>`;
    q('#orderProgressSupplier').value = line.supplierName || ''; q('#orderProgressReference').value = type === 'delivery' ? shipmentFolio(store, new Date()) : ''; q('#orderProgressNotes').value = ''; q('#orderProgressOverride').checked = false; delete q('#orderProgressQuantity').dataset.formalDefaulted; q('#receiptDocumentType').value = 'supplier_remission'; q('#receiptWarehouse').value = line.deliveryWarehouse || '1'; q('#receiptRejectedQuantity').value = 0; q('#receiptQualityStatus').value = 'released'; q('#receiptLot').value = ''; q('#receiptSerial').value = ''; q('#receiptExpiry').value = ''; q('#receiptEvidence').value = ''; q('#receiptShortageResolution').value = ''; q('#receiptShortageCommitment').value = ''; q('#receiptShortageNotes').value = ''; q('#deliveryRecipient').value = ''; q('#deliveryScheduledAt').value = ''; q('#deliveryEvidence').value = ''; toggleReceiptFields();
    q('#orderProgressDialog').showModal(); window.lucide?.createIcons();
  }

  function openTotalReceiptProgress(supplierOrderId,requestId) {
    const supplierOrder=store.supplierOrders.find(order=>order.id===supplierOrderId),links=store.supplierOrderLines.filter(link=>link.supplierOrderId===supplierOrderId),pending=links.map(link=>({link,line:store.orderLines.find(line=>line.id===link.orderLineId),quantity:core.supplierOrderLinePending({supplierOrderId,link,receipts:store.receipts})})).filter(item=>item.line&&item.line.requisitionId===requestId&&item.quantity>0),lines=pending.map(item=>item.line),request=lines[0]&&store.requisitions.find(item=>item.id===lines[0].requisitionId);if(!supplierOrder||!lines.length||!request)return;
    simplifyProgressForm();const total=pending.reduce((sum,item)=>sum+item.quantity,0),form=q('#orderProgressForm');form.dataset.mode='formal-total-receipt';form.dataset.supplierOrderId=supplierOrderId;form.dataset.totalReceiptRequestId=requestId;delete q('#orderProgressQuantity').dataset.formalDefaulted;formField('orderProgressQuantity').hidden=true;q('#orderProgressDialog .eyebrow').textContent='OPERACIÓN FORMAL';q('#orderProgressDialog h2').textContent='Registrar recepción total';q('#orderProgressDialog .confirm-note span').textContent='Se recibirá una sola vez cada partida pendiente de esta OC.';q('#orderProgressForm .submit').innerHTML='Registrar recepción total <i data-lucide="arrow-right"></i>';formField('orderProgressNotes').querySelector('span').innerHTML='Observaciones <em>opcional</em>';q('#orderProgressLineId').value=lines[0].id;q('#orderProgressType').innerHTML='<option value="receipt">Recepción total de OC</option>';q('#orderProgressType').value='receipt';q('#orderProgressQuantity').value=total;q('#orderProgressContext').innerHTML=`<strong>${escapeHtml(supplierOrder.id)} · ${escapeHtml(supplierOrder.supplierName||'Proveedor')}</strong><br>${lines.length} partida(s) pendientes · ${total} unidad(es) por recibir.<br><small>La recepción generará un único documento, con un movimiento de entrada por cada artículo.</small>`;q('#orderProgressSupplier').value=supplierOrder.supplierName||'';q('#orderProgressReference').value='';q('#orderProgressNotes').value='';q('#orderProgressOverride').checked=false;q('#receiptDocumentType').value='supplier_remission';q('#receiptWarehouse').value=lines[0].deliveryWarehouse||supplierOrder.warehouseId||'1';q('#receiptRejectedQuantity').value=0;q('#receiptQualityStatus').value='released';q('#receiptLot').value='';q('#receiptSerial').value='';q('#receiptExpiry').value='';q('#receiptEvidence').value='';q('#receiptShortageResolution').value='';q('#receiptShortageCommitment').value='';q('#receiptShortageNotes').value='';toggleReceiptFields();q('#orderProgressDialog').showModal();window.lucide?.createIcons();
  }

  async function applyTotalReceiptLegacy(supplierOrderId,requestId,reference,notes,receiptData={}) {
    if(!can('receive'))return notify('Tu perfil no tiene permiso para registrar recepciones.');const next=JSON.parse(JSON.stringify(store)),supplierOrder=next.supplierOrders.find(order=>order.id===supplierOrderId),links=next.supplierOrderLines.filter(link=>link.supplierOrderId===supplierOrderId),lines=links.map(link=>next.orderLines.find(line=>line.id===link.orderLineId)).filter(line=>line&&line.requisitionId===requestId&&Math.max(0,core.numberValue(line.quantityPurchased)-core.numberValue(line.quantityReceived))>0),request=lines[0]&&next.requisitions.find(item=>item.id===lines[0].requisitionId);if(!supplierOrder||!lines.length||!request)return notify('No hay partidas pendientes para una recepción total.');if(!reference)return notify('La recepción requiere la OC, remisión u otro documento de llegada.');const evidenceFiles=[...(receiptData.evidenceFiles||[])];if(!evidenceFiles.length)return notify('La recepción requiere al menos la remisión del proveedor o evidencia de recepción.');if(evidenceFiles.length>5||!evidenceFiles.every(file=>(file.type==='application/pdf'||file.type.startsWith('image/'))&&file.size<=5*1024*1024))return notify('Las evidencias deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');const at=new Date().toISOString(),id=`RECEIPT-${Date.now()}`,evidence=evidenceFiles.map(file=>({name:file.name,size:file.size,type:file.type,version:1,origin:'supplier_receipt'}));if(window.BioMediaStore){try{const stored=await window.BioMediaStore.store('movementEvidence','movementId',id,evidenceFiles);stored.forEach((record,index)=>{evidence[index].id=record.id;evidence[index].hash=record.hash})}catch{return notify('No fue posible conservar la evidencia; la recepción no se registró.')}}const warehouseId=receiptData.warehouseId||supplierOrder.warehouseId||'1',catalogAdjustments=[],items=[];lines.forEach((line,index)=>{const quantity=Math.max(0,core.numberValue(line.quantityPurchased)-core.numberValue(line.quantityReceived)),before=JSON.parse(JSON.stringify(line)),inventoryProduct=ensureInventoryProductForReceipt(line,supplierOrder);line.productId=inventoryProduct.id;line.quantityReceived=core.numberValue(line.quantityReceived)+quantity;if((receiptData.qualityStatus||'released')==='released'){line.quantityAvailableReceived=core.numberValue(line.quantityAvailableReceived==null?before.quantityReceived:line.quantityAvailableReceived)+quantity;catalogAdjustments.push({productId:line.productId,warehouseId,delta:quantity})}line.status=core.deriveLineStatus(line);items.push({orderLineId:line.id,quantity,quantityAccepted:quantity,quantityRejected:0,lot:receiptData.lot||null,serial:receiptData.serial||null,expiryDate:receiptData.expiryDate||null,qualityStatus:receiptData.qualityStatus||'released'});next.inventoryMovements.push({id:`INV-IN-${Date.now()}-${index+1}`,requisitionId:line.requisitionId,orderLineId:line.id,warehouseId,productId:line.productId,catalog:line.catalog,type:'entry',quantity,inventoryState:(receiptData.qualityStatus||'released')==='released'?'available':'quarantine',reason:'Recepción total contra OC a proveedor',sourceDocumentType:'receipt',sourceDocumentId:id,user:actor.name,at,reconciliationStatus:'pending_invoice'});next.auditLog.push({id:`AUD-${Date.now()}-${index+1}`,entityType:'order_line',entityId:line.id,action:'receipt_total',eventKind:'formal_operation',user:actor.name,at,before,after:JSON.parse(JSON.stringify(line)),reference,notes,receipt:{documentType:receiptData.documentType,warehouseId,qualityStatus:receiptData.qualityStatus||'released'}})});next.receipts.push({id,supplierOrderId,requisitionId:request.id,date:at.slice(0,10),receivedAt:at,warehouseId,items,type:'total',documentType:receiptData.documentType||'supplier_remission',supplierRemission:receiptData.documentType==='supplier_remission'?reference:null,supplierInvoiceReference:receiptData.documentType==='supplier_invoice'?reference:null,invoiceRequiredLater:receiptData.documentType!=='supplier_invoice',qualityStatus:receiptData.qualityStatus||'released',inspectionStatus:(receiptData.qualityStatus||'released')==='released'?'released':'pending',evidence,user:actor.name,observations:notes,reference});const ordered=links.reduce((sum,link)=>sum+core.numberValue(link.quantity),0),received=next.receipts.filter(item=>item.supplierOrderId===supplierOrderId).flatMap(item=>item.items||[]).reduce((sum,item)=>sum+core.numberValue(item.quantityAccepted??item.quantity),0);supplierOrder.status=received>=ordered?'received':'partially_received';supplierOrder.reconciliation=core.reconcileSupplierPurchase({order:supplierOrder,links:next.supplierOrderLines,receipts:next.receipts,invoices:next.supplierInvoices});next.requisitions.filter(item=>lines.some(line=>line.requisitionId===item.id)).forEach(item=>{item.status=core.deriveRequisitionStatus(next.orderLines.filter(line=>line.requisitionId===item.id));item.updatedAt=at});if(!saveStore(next))return;const inventoryWarning=catalogAdjustments.length&&!applyCatalogStockAdjustments(catalogAdjustments)?'La recepción quedó registrada, pero la existencia del catálogo requiere conciliación manual.':'';returnToDossierAfterOperation(request.id,{type:'receipt',quantity:items.reduce((sum,item)=>sum+item.quantityAccepted,0),reference,detail:`Recepción total de ${items.length} partida(s) · entradas de almacén generadas.`,warning:inventoryWarning});
  }

  async function applyTotalReceipt(supplierOrderId, requestId, reference, notes, receiptData = {}) {
    if (!can('receive')) return notify('Tu perfil no tiene permiso para registrar recepciones.');
    const next = JSON.parse(JSON.stringify(store));
    const supplierOrder = next.supplierOrders.find(order => order.id === supplierOrderId);
    const links = next.supplierOrderLines.filter(link => link.supplierOrderId === supplierOrderId);
    const pending = links.map(link => ({
      link,
      line: next.orderLines.find(line => line.id === link.orderLineId),
      quantity: core.supplierOrderLinePending({ supplierOrderId, link, receipts: next.receipts })
    })).filter(item => item.line && item.line.requisitionId === requestId && item.quantity > 0);
    const request = pending[0] && next.requisitions.find(item => item.id === pending[0].line.requisitionId);
    if (!supplierOrder || !pending.length || !request) return notify('No hay partidas pendientes para una recepción total.');
    if (!reference) return notify('La recepción requiere la OC, remisión u otro documento de llegada.');
    const physicalTotal=pending.reduce((sum,item)=>sum+item.quantity,0),rejectedTotal=Math.min(physicalTotal,receiptData.qualityStatus==='rejected'?physicalTotal:Math.max(0,core.numberValue(receiptData.rejectedQuantity))),receiptAction=rejectedTotal>0?'receipt_partial':'receipt_total';
    if(rejectedTotal>0&&!receiptData.shortageResolution)return notify('Define cómo se resolverá el faltante antes de registrar una recepción parcial.');
    if(rejectedTotal>0&&['other_supplier','substitution','supplier_unavailable','authorized_cancellation'].includes(receiptData.shortageResolution)&&!receiptData.shortageNotes)return notify('El tratamiento seleccionado requiere motivo, autorización o referencia.');
    if (next.receipts.some(receipt => receipt.supplierOrderId === supplierOrderId && core.normalizeText(receipt.reference || receipt.supplierRemission || receipt.supplierInvoiceReference) === core.normalizeText(reference) && !receipt.duplicateOf)) return notify('Este documento de recepción ya fue registrado para la orden de compra.');
    if (pastBusinessDate(receiptData.expiryDate)) return notify('La fecha de caducidad no puede ser anterior a hoy.');
    const evidenceFiles = [...(receiptData.evidenceFiles || [])];
    if (!evidenceFiles.length) return notify('La recepción requiere al menos la remisión del proveedor o evidencia de recepción.');
    if (evidenceFiles.length > 5 || !evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/')) && file.size <= 5 * 1024 * 1024)) return notify('Las evidencias deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');
    const at = new Date().toISOString(), id = `RECEIPT-${Date.now()}`;
    const evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type, version: 1, origin: 'supplier_receipt' }));
    if (window.BioMediaStore) {
      try {
        const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', id, evidenceFiles);
        stored.forEach((record, index) => { evidence[index].id = record.id; evidence[index].hash = record.hash; });
      } catch { return notify('No fue posible conservar la evidencia; la recepción no se registró.'); }
    }
    const warehouseId = receiptData.warehouseId || supplierOrder.warehouseId || '1', catalogAdjustments = [], items = [];let rejectedRemaining=rejectedTotal;
    pending.forEach(({ line, quantity }, index) => {
      const before = JSON.parse(JSON.stringify(line)), inventoryProduct = ensureInventoryProductForReceipt(line, supplierOrder), qualityStatus = receiptData.qualityStatus || 'released', rejectedQuantity=Math.min(quantity,rejectedRemaining),acceptedQuantity=Math.max(0,quantity-rejectedQuantity),movementId = inventoryMovementFolio(next,'entry',at);rejectedRemaining-=rejectedQuantity;
      line.productId = inventoryProduct.id;
      line.quantityReceived = core.numberValue(line.quantityReceived) + acceptedQuantity;
      if (qualityStatus === 'released'&&acceptedQuantity>0) {
        line.quantityAvailableReceived = core.numberValue(line.quantityAvailableReceived == null ? before.quantityReceived : line.quantityAvailableReceived) + acceptedQuantity;
        catalogAdjustments.push({ productId: line.productId, warehouseId, delta: acceptedQuantity });
      } else if (qualityStatus === 'quarantine'&&acceptedQuantity>0) {
        catalogAdjustments.push({ productId: line.productId, warehouseId, delta: acceptedQuantity, inventoryState: 'quarantine', sourceMovementId: movementId });
      }
      line.status = core.deriveLineStatus(line);
      items.push({ orderLineId: line.id, quantity, quantityAccepted: acceptedQuantity, quantityRejected: rejectedQuantity, lot: receiptData.lot || null, serial: receiptData.serial || null, expiryDate: receiptData.expiryDate || null, qualityStatus });
      if(acceptedQuantity>0)next.inventoryMovements.push({ id: movementId,folio:movementId,requisitionId: line.requisitionId, orderLineId: line.id, warehouseId, productId: line.productId, catalog: line.catalog, type: 'entry', quantity:acceptedQuantity, inventoryState: qualityStatus === 'released' ? 'available' : qualityStatus, reason: receiptAction==='receipt_partial'?'Recepción parcial contra OC a proveedor':'Recepción total contra OC a proveedor', sourceDocumentType: 'receipt', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: 'pending_invoice' });
      next.auditLog.push({ id: `AUD-${Date.now()}-${index + 1}`, entityType: 'order_line', entityId: line.id, action: receiptAction, eventKind: 'formal_operation', user: actor.name, at, before, after: JSON.parse(JSON.stringify(line)), reference, notes, receipt: { documentType: receiptData.documentType, warehouseId, qualityStatus: receiptData.qualityStatus || 'released',quantityAccepted:acceptedQuantity,quantityRejected:rejectedQuantity } });
    });
    const acceptedTotal=items.reduce((sum,item)=>sum+item.quantityAccepted,0);next.receipts.push({ id, supplierOrderId, requisitionId: request.id, date: at.slice(0, 10), receivedAt: at, warehouseId, items, type: rejectedTotal>0?'partial':'total', documentType: receiptData.documentType || 'supplier_remission', supplierRemission: receiptData.documentType === 'supplier_remission' ? reference : null, supplierInvoiceReference: receiptData.documentType === 'supplier_invoice' ? reference : null, invoiceRequiredLater: receiptData.documentType !== 'supplier_invoice', qualityStatus: receiptData.qualityStatus || 'released', inspectionStatus: (receiptData.qualityStatus || 'released') === 'released' ? 'released' : (receiptData.qualityStatus==='rejected'?'rejected':'pending'), evidence,shortage:rejectedTotal?{quantity:rejectedTotal,resolution:receiptData.shortageResolution,commitmentDate:receiptData.shortageCommitment||null,notes:receiptData.shortageNotes||null,responsible:request.responsible||actor.name,status:'open'}:null,user:actor.name, observations: notes, reference });
    const ordered = links.reduce((sum, link) => sum + Math.max(0, core.numberValue(link.quantity) - core.numberValue(link.quantityCancelled)), 0);
    const received = next.receipts.filter(item => item.supplierOrderId === supplierOrderId).flatMap(item => item.items || []).reduce((sum, item) => sum + core.numberValue(item.quantityAccepted ?? item.quantity), 0);
    supplierOrder.status = received >= ordered ? 'received' : 'partially_received';
    supplierOrder.reconciliation = core.reconcileSupplierPurchase({ order: supplierOrder, links: next.supplierOrderLines, receipts: next.receipts, invoices: next.supplierInvoices });
    request.status = core.deriveRequisitionStatus(next.orderLines.filter(line => line.requisitionId === request.id)); request.updatedAt = at;
    if (!saveStore(next)) return;
    // El expediente ya programa el render global al siguiente cuadro. Evitar
    // dispararlo aquí mantiene la recepción atómica, pero libera el modal antes
    // de volver a pintar catálogos y tableros de gran tamaño.
    const inventoryWarning = catalogAdjustments.length && !applyCatalogStockAdjustments(catalogAdjustments, null, { notify: false }) ? 'La recepción quedó registrada, pero la existencia del catálogo requiere conciliación manual.' : '';
    const quarantined = items.some(item => item.qualityStatus === 'quarantine');
    const receiptKind=rejectedTotal>0?'Recepción parcial':'Recepción total',entryDetail=acceptedTotal>0?(quarantined?'existencia aceptada separada en cuarentena':`${acceptedTotal} unidad(es) aceptada(s) y entrada(s) de almacén generada(s)`):'sin unidades aceptadas y sin entrada de almacén';returnToDossierAfterOperation(request.id, { type: 'receipt', quantity: acceptedTotal, reference, detail: `${receiptKind} de ${items.length} partida(s) · ${rejectedTotal} rechazada(s) · ${entryDetail}.`, warning: inventoryWarning });
  }

  function openTotalDeliveryProgress(requestId) {
    const request=store.requisitions.find(item=>item.id===requestId),lines=store.orderLines.filter(line=>line.requisitionId===requestId&&Math.max(0,core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.quantityDelivered))>0),pending=lines.map(line=>({line,quantity:Math.max(0,core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.quantityDelivered)),available:core.numberValue(line.reservedQuantity)-core.numberValue(line.quantityDelivered)+core.numberValue(line.quantityAvailableReceived==null?line.quantityReceived:line.quantityAvailableReceived)}));if(!request||!pending.length)return;if(pending.some(item=>item.available<item.quantity))return notify('Aún hay partidas sin existencia disponible para generar la remisión total.');simplifyProgressForm();const total=pending.reduce((sum,item)=>sum+item.quantity,0),form=q('#orderProgressForm');form.dataset.mode='formal-total-delivery';form.dataset.totalDeliveryRequestId=requestId;q('#orderProgressDialog .eyebrow').textContent='OPERACIÓN FORMAL';q('#orderProgressDialog h2').textContent='Generar remisión total';q('#orderProgressDialog .confirm-note span').textContent='Se entregará una sola vez cada partida pendiente de este pedido.';q('#orderProgressForm .submit').innerHTML='Generar remisión total <i data-lucide="arrow-right"></i>';q('#orderProgressLineId').value=lines[0].id;q('#orderProgressType').innerHTML='<option value="delivery">Remisión total del pedido</option>';q('#orderProgressType').value='delivery';q('#orderProgressQuantity').value=total;q('#orderProgressContext').innerHTML=`<strong>${escapeHtml(request.id)} · ${escapeHtml(request.customerName||'Cliente')}</strong><br>${pending.length} partida(s) disponibles · ${total} unidad(es) por entregar.<br><small>Se generará una sola remisión con todas las partidas y un movimiento de salida por cada artículo.</small>`;q('#orderProgressReference').value=shipmentFolio(store,new Date());q('#orderProgressNotes').value='';q('#deliveryRecipient').value='';q('#deliveryScheduledAt').value='';q('#deliveryEvidence').value='';toggleReceiptFields();formField('orderProgressQuantity').hidden=true;q('#orderProgressDialog').showModal();window.lucide?.createIcons();
  }

  async function applyTotalDelivery(requestId, notes, deliveryData = {}) {
    if (!can('deliver')) return notify('Tu perfil no tiene permiso para generar remisiones.');
    if (pastBusinessDate(deliveryData.scheduledAt)) return notify('La fecha programada no puede ser anterior a hoy.');
    const next = JSON.parse(JSON.stringify(store));
    const request = next.requisitions.find(item => item.id === requestId);
    const lines = next.orderLines.filter(line => line.requisitionId === requestId && Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)) > 0);
    if (!request || !lines.length) return notify('No hay partidas pendientes para una remisión total.');
    if (!deliveryData.recipient || !(deliveryData.evidenceFiles || []).length) return notify('La remisión requiere quién recibe y evidencia de entrega.');
    const evidenceFiles = [...(deliveryData.evidenceFiles || [])];
    if (evidenceFiles.length > 5 || !evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/')) && file.size <= 5 * 1024 * 1024)) return notify('Las evidencias deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');
    const planned = lines.map(line => ({
      line,
      quantity: Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)),
      available: core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityDelivered) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived),
      reservations: next.inventoryReservations.filter(item => item.orderLineId === line.id && item.status === 'active')
    }));
    if (planned.some(item => item.available < item.quantity)) return notify('Una o más partidas ya no tienen disponibilidad suficiente para la remisión total.');
    const catalogPlan = planCatalogDeductions(planned);
    if (!catalogPlan) return notify('La existencia física de los almacenes no alcanza para registrar esta remisión total.');
    const at = new Date().toISOString(), documentDate = localDateKey(), stamp = Date.now(), id = `DELIVERY-${stamp}`, folio = shipmentFolio(next, documentDate);
    const evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type, version: 1, origin: 'delivery_confirmation' }));
    if (window.BioMediaStore) {
      try {
        const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', id, evidenceFiles);
        stored.forEach((record, index) => { evidence[index].id = record.id; evidence[index].hash = record.hash; });
      } catch { return notify('No fue posible conservar la evidencia; la remisión no se generó.'); }
    }
    const shipmentItems = [];
    for (const { line, quantity, reservations } of planned) {
      const adjustments = catalogPlan.byLine.get(line.id) || [];
      shipmentItems.push({ orderLineId: line.id, quantity });
      let remainingToConsume = quantity;
      const reservedByWarehouse = {};
      reservations.forEach(reservation => {
        const availableReservation = Math.max(0, core.numberValue(reservation.quantity) - core.numberValue(reservation.quantityConsumed));
        const used = Math.min(remainingToConsume, availableReservation), warehouseId = String(reservation.warehouseId || '1');
        reservation.quantityConsumed = core.numberValue(reservation.quantityConsumed) + used;
        remainingToConsume -= used;
        reservedByWarehouse[warehouseId] = core.numberValue(reservedByWarehouse[warehouseId]) + used;
        if (reservation.quantityConsumed >= core.numberValue(reservation.quantity)) reservation.status = 'consumed';
      });
      line.quantityDelivered = core.numberValue(line.quantityDelivered) + quantity;
      line.status = core.deriveLineStatus(line);
      adjustments.forEach((adjustment, index) => {
        const warehouseId = String(adjustment.warehouseId), movementQuantity = Math.abs(adjustment.delta);
        const reservedQuantityUsed = Math.min(movementQuantity, core.numberValue(reservedByWarehouse[warehouseId]));
        reservedByWarehouse[warehouseId] = Math.max(0, core.numberValue(reservedByWarehouse[warehouseId]) - reservedQuantityUsed);
        const movementFolio=inventoryMovementFolio(next,'exit',at);next.inventoryMovements.push({ id:movementFolio,folio:movementFolio,requisitionId: request.id, orderLineId: line.id, warehouseId, productId: line.productId, catalog: line.catalog, type: 'exit', quantity: movementQuantity, reservedQuantityUsed, purchasedQuantityUsed: movementQuantity - reservedQuantityUsed, reason: 'Salida contra remisión total', sourceDocumentType: 'shipment', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: 'matched' });
      });
      next.auditLog.push({ id: `AUD-${stamp}-${line.id}`, entityType: 'order_line', entityId: line.id, action: 'delivery_total', eventKind: 'formal_operation', user: actor.name, at, before: null, after: { quantityDelivered: line.quantityDelivered }, reference: folio, notes });
    }
    next.shipments.push({ id, folio, date: documentDate, scheduledAt: deliveryData.scheduledAt || null, requisitionId: request.id, items: shipmentItems, deliveredAt: at, recipient: deliveryData.recipient, type: 'total', evidenceId: evidence[0]?.id || null, evidence, observations: notes });
    request.deliveryReleasedAt ||= at;
    request.deliveryReleasedBy ||= actor.name;
    request.status = core.deriveRequisitionStatus(next.orderLines.filter(line => line.requisitionId === request.id));
    request.updatedAt = at;
    if (!saveStore(next)) return;
    const warning = !applyCatalogStockAdjustments(catalogPlan.adjustments, catalogPlan.staged, { notify: false }) ? 'La remisión quedó registrada, pero la existencia del catálogo requiere conciliación manual.' : '';
    returnToDossierAfterOperation(request.id, { type: 'delivery', quantity: shipmentItems.reduce((sum, item) => sum + item.quantity, 0), reference: folio, detail: `Remisión total de ${shipmentItems.length} partida(s) generada.`, warning });
  }

  async function recordTrackingProgress(lineId) {
    const next = JSON.parse(JSON.stringify(store)), line = next.orderLines.find(item => item.id === lineId), request = line && next.requisitions.find(item => item.id === line.requisitionId);
    if (!line || !request || !can('edit')) return notify('Tu perfil no tiene permiso para registrar seguimiento.');
    const type = q('#orderProgressType').value, notes = q('#orderProgressNotes').value.trim(), result = q('#orderProgressResult').value, nextAction = q('#orderProgressNextAction').value.trim(), commitmentDate = q('#orderProgressCommitmentDate').value || null, blockers = q('#orderProgressBlockers').value.trim(), assignee = q('#orderProgressAssignee').value.trim() || request.responsible || actor.name, evidenceFiles = [...q('#orderProgressEvidence').files];
    if (!notes) return notify('Describe brevemente el avance realizado.');
    if (['document', 'incident'].includes(type) && !evidenceFiles.length) return notify('Este tipo de avance requiere una evidencia.');
    if (type === 'commitment' && (!nextAction || !commitmentDate)) return notify('El compromiso requiere próxima acción y fecha.');
    if (commitmentDate && pastBusinessDate(commitmentDate)) return notify('La fecha compromiso no puede ser anterior a hoy.');
    if (type === 'incident' && !blockers) return notify('La incidencia requiere el motivo o bloqueo.');
    if (assignee !== actor.name && !canManageSupplierOrders()) return notify('Solo supervisión o administración puede reasignar responsables.');
    if (evidenceFiles.length && (evidenceFiles.length > 5 || !evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/') || ['message/rfc822', 'application/vnd.ms-outlook'].includes(file.type)) && file.size <= 5 * 1024 * 1024))) return notify('Adjunta hasta cinco evidencias PDF, correo o imagen de máximo 5 MB.');
    const at = new Date().toISOString(), evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type, version: 1, origin: 'manual_tracking' }));
    if (evidenceFiles.length && window.BioMediaStore) { try { const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', `TRACK-${Date.now()}`, evidenceFiles); stored.forEach((record, index) => Object.assign(evidence[index], { id: record.id, hash: record.hash })); } catch { return notify('No fue posible conservar la evidencia; el seguimiento no se registró.'); } }
    const before = { followUpStatus: request.followUpStatus || null, nextResponsible: request.nextResponsible || request.responsible || null, commitmentDate: line.committedDate || null };
    request.followUpStatus = type === 'status_change' ? q('#orderProgressStatus').value : (type === 'incident' ? 'blocked' : result); request.nextResponsible = assignee; request.updatedAt = at;
    if (commitmentDate) line.committedDate = commitmentDate;
    next.auditLog.push({ id: `AUD-TRACK-${Date.now()}`, entityType: 'order_line', entityId: line.id, action: `tracking_${type}`, eventKind: 'manual_tracking', user: actor.name, at, before, after: { followUpStatus: request.followUpStatus, nextResponsible: assignee, commitmentDate: line.committedDate || null }, reference: request.id, notes, result, nextAction: nextAction || null, commitmentDate, blockers: blockers || null, responsible: assignee, priority: type === 'incident' ? q('#orderProgressPriority').value : null, documentType: type === 'document' ? q('#orderProgressDocumentType').value : null, evidence });
    if (!saveStore(next)) return;
    returnToDossierAfterOperation(request.id, { type: 'tracking', reference: request.id, detail: `Resultado: ${trackingTypes[type] || type}${nextAction ? ` · Próxima acción: ${nextAction}` : ''}${commitmentDate ? ` · Compromiso: ${commitmentDate}` : ''}` });
  }

  async function applyProgress(lineId, type, quantity, supplier, reference, notes, override, receiptData = {}, progressMeta = {}, deliveryData = {}) {
    const next = JSON.parse(JSON.stringify(store)), line = next.orderLines.find(item => item.id === lineId), request = line && next.requisitions.find(item => item.id === line.requisitionId);
    let catalogAdjustments = [], shortageCancellationAudit = null;
    if (!line || !request) return;
    const permission = { purchase: 'purchase', receipt: 'receive', delivery: 'deliver', invoice: 'invoice', account_charge: 'invoice', reserve: 'inventory', cancel: 'cancel' }[type];
    if (!can(permission)) return notify('Tu perfil no tiene permiso para esta operación.');
    if (type === 'receipt' && pastBusinessDate(receiptData.expiryDate)) return notify('La fecha de caducidad no puede ser anterior a hoy.');
    if (type === 'receipt' && pastBusinessDate(receiptData.shortageCommitment)) return notify('La fecha compromiso del faltante no puede ser anterior a hoy.');
    if (type === 'delivery' && pastBusinessDate(deliveryData.scheduledAt)) return notify('La fecha programada no puede ser anterior a hoy.');
    // La remisión es un documento interno: su folio no puede depender de una captura manual.
    if (type === 'delivery') reference = shipmentFolio(next, localDateKey());
    if (type === 'cancel' && !notes.trim()) return notify('La cancelación requiere un motivo.');
    if (type === 'purchase') {
      const gate = core.validateSupplierPurchaseGate({ requestType: request.type, clientOrderStatus: request.clientOrderStatus });
      if (!gate.valid) return notify(gate.message);
    }
    if (type === 'purchase' && (!reference || !supplier)) return notify('La compra requiere folio de OC y proveedor.');
    if (type === 'account_charge' && !reference) return notify('El cargo requiere una referencia de manejo de cuenta.');
    if (type === 'receipt' && !reference) return notify('La recepción requiere la OC, remisión u otro documento de llegada; la factura puede registrarse después.');
    if (type === 'delivery' && !reference) return notify('La entrega requiere un folio de remisión.');
    if (type === 'delivery' && (!deliveryData.recipient || !(deliveryData.evidenceFiles || []).length)) return notify('La remisión requiere quién recibe y evidencia de entrega.');
    // Cada partida se puede remitir parcialmente cuando tiene existencia disponible.
    // No se bloquea la salida de un artículo por pendientes de otras partidas del pedido.
    if (type === 'delivery' && !request.deliveryReleasedAt) {
      request.deliveryReleasedAt = new Date().toISOString(); request.deliveryReleasedBy = actor.name;
    }
    if (type === 'invoice' && !reference) return notify('La facturación requiere el folio de la factura.');
    if (override && !can('admin')) return notify('El excedente requiere permiso de administración.');
    if (type === 'receipt') {
      const supplierLink = next.supplierOrderLines.find(item => item.orderLineId === line.id), supplierOrder = supplierLink && next.supplierOrders.find(order => order.id === supplierLink.supplierOrderId);
      if (!supplierOrder || !['confirmed', 'partially_received', 'received'].includes(supplierOrder.status)) return notify('Confirma primero la OC a proveedor correspondiente.');
      if (next.receipts.some(receipt => receipt.supplierOrderId === supplierOrder.id && core.normalizeText(receipt.reference || receipt.supplierRemission || receipt.supplierInvoiceReference) === core.normalizeText(reference) && !receipt.duplicateOf && (receipt.items || []).some(item => item.orderLineId === line.id))) return notify('Este documento de recepción ya fue registrado para la partida seleccionada.');
      const rejected = receiptData.qualityStatus==='rejected'?quantity:core.numberValue(receiptData.rejectedQuantity);receiptData.rejectedQuantity=rejected;
      if (rejected < 0 || rejected > quantity) return notify('La cantidad rechazada no puede superar lo recibido físicamente.');
      const pendingBefore = core.supplierOrderLinePending({ supplierOrderId: supplierOrder.id, link: supplierLink, receipts: next.receipts }), acceptedForPlan = Math.max(0, quantity - rejected);
      if (acceptedForPlan < pendingBefore && !receiptData.shortageResolution) return notify('Define cómo se resolverá el faltante antes de registrar una recepción parcial.');
      if (acceptedForPlan < pendingBefore && receiptData.shortageResolution === 'authorized_cancellation' && !can('cancel')) return notify('Tu perfil no tiene permiso para cancelar el saldo faltante.');
      if (acceptedForPlan < pendingBefore && ['other_supplier', 'substitution', 'supplier_unavailable', 'authorized_cancellation'].includes(receiptData.shortageResolution) && !receiptData.shortageNotes) return notify('El tratamiento seleccionado requiere motivo, autorización o referencia.');
    }
    const before = JSON.parse(JSON.stringify(line));
    const field = { purchase: 'quantityPurchased', receipt: 'quantityReceived', delivery: 'quantityDelivered', invoice: 'quantityInvoiced', account_charge: 'quantityInvoiced', cancel: 'quantityCancelled' }[type];
    if (type !== 'reserve') {
      const authorized = type === 'purchase' ? Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity)) : type === 'receipt' ? line.quantityPurchased : type === 'delivery' ? core.numberValue(line.reservedQuantity) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived) : line.quantityRequested;
      const effectiveQuantity = type === 'receipt' ? Math.max(0, quantity - core.numberValue(receiptData.rejectedQuantity)) : quantity;
      if (effectiveQuantity > 0) { const validation = core.validateProgress({ authorized, current: line[field], amount: effectiveQuantity, allowOverride: override }); if (!validation.valid) return notify(validation.message); line[field] = validation.after; }
      else if (type !== 'receipt') return notify('La cantidad debe ser mayor que cero.');
    } else {
      const reserved = next.inventoryReservations.filter(item => item.orderLineId === line.id && item.status === 'active').reduce((total, item) => total + Math.max(0, core.numberValue(item.quantity) - core.numberValue(item.quantityConsumed)), 0);
      const remaining = Math.max(0, line.quantityRequested - line.quantityCancelled - line.quantityDelivered);
      const validation = core.validateProgress({ authorized: remaining, current: reserved, amount: quantity, allowOverride: override });
      if (!validation.valid) return notify(validation.message);
      const product = catalogProducts().find(item => String(item.id) === String(line.productId)), plan = warehousePlan(next, product, quantity, line.deliveryWarehouse || '1');
      if (plan.reservedQuantity < quantity && !override) return notify(`Solo hay ${plan.reservedQuantity} piezas disponibles para reservar; las ${quantity - plan.reservedQuantity} restantes deben comprarse.`);
      line.reserved = plan.reservedQuantity > 0;
      line.reservedQuantity = core.numberValue(line.reservedQuantity) + plan.reservedQuantity;
      line.quantityToPurchase = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
      line.supplyOrigin = line.reservedQuantity > 0 && line.quantityToPurchase > 0 ? 'mixed' : line.reservedQuantity > 0 ? 'inventory' : 'supplier';
      plan.allocations.forEach((allocation, index) => next.inventoryReservations.push({ id: `RES-${Date.now()}-${allocation.warehouseId}-${index + 1}`, requisitionId: request.id, orderLineId: line.id, productId: line.productId, warehouseId: allocation.warehouseId, quantity: allocation.quantity, quantityConsumed: 0, status: 'active', user: actor.name, at: new Date().toISOString(), reference, notes }));
    }
    const at = new Date().toISOString(), id = `${type.toUpperCase()}-${Date.now()}`;
    if (type === 'purchase') {
      let supplierOrder = next.supplierOrders.find(order => core.normalizeText(order.id) === core.normalizeText(reference));
      if (!supplierOrder) {
        supplierOrder = { id: reference, supplierName: supplier, createdAt: at.slice(0, 10), confirmedAt: at.slice(0, 10), currency: 'MXN', exchangeRate: null, exchangeRateDate: null, status: line.quantityPurchased >= Math.max(0, line.quantityRequested - core.numberValue(line.reservedQuantity)) ? 'purchased' : 'partially_purchased', requisitionIds: [request.id], lineIds: [line.id] };
        next.supplierOrders.push(supplierOrder);
      } else {
        if (!supplierOrder.requisitionIds.includes(request.id)) supplierOrder.requisitionIds.push(request.id);
        if (!supplierOrder.lineIds.includes(line.id)) supplierOrder.lineIds.push(line.id);
        supplierOrder.status = line.quantityPurchased >= Math.max(0, line.quantityRequested - core.numberValue(line.reservedQuantity)) ? 'purchased' : 'partially_purchased';
      }
      const link = next.supplierOrderLines.find(item => item.supplierOrderId === supplierOrder.id && item.orderLineId === line.id);
      if (link) link.quantity = core.numberValue(link.quantity) + quantity;
      else next.supplierOrderLines.push({ id: `SOL-${Date.now()}`, supplierOrderId: supplierOrder.id, requisitionId: request.id, orderLineId: line.id, quantity });
    }
    if (type === 'receipt') {
      const supplierLink = next.supplierOrderLines.find(item => item.orderLineId === line.id), rejectedQuantity = receiptData.qualityStatus==='rejected'?quantity:core.numberValue(receiptData.rejectedQuantity), acceptedQuantity = Math.max(0, quantity - rejectedQuantity), evidenceFiles = [...(receiptData.evidenceFiles || [])], evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type, version: 1, origin: 'supplier_receipt' }));
      const supplierOrder = supplierLink && next.supplierOrders.find(order => order.id === supplierLink.supplierOrderId);
      if (!evidenceFiles.length) return notify('La recepción requiere al menos la remisión del proveedor o evidencia de recepción.');
      if (evidenceFiles.length && (!evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/')) && file.size <= 5 * 1024 * 1024) || evidenceFiles.length > 5)) return notify('Las evidencias deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');
      if (evidenceFiles.length && window.BioMediaStore) { try { const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', id, evidenceFiles); stored.forEach((record, index) => { evidence[index].id = record.id; evidence[index].hash = record.hash; }); } catch { return notify('No fue posible conservar la evidencia; la recepción no se registró.'); } }
      const inventoryProduct = ensureInventoryProductForReceipt(line, supplierOrder);
      line.productId = inventoryProduct.id;
      const shortageQuantity = Math.max(0, core.supplierOrderLinePending({ supplierOrderId: supplierOrder?.id, link: supplierLink, receipts: next.receipts }) - acceptedQuantity), authorizedCancellation = shortageQuantity > 0 && receiptData.shortageResolution === 'authorized_cancellation';
      const receipt = { id, supplierOrderId: supplierLink?.supplierOrderId || null, requisitionId: request.id, date: at.slice(0, 10), receivedAt: at, warehouseId: receiptData.warehouseId || line.deliveryWarehouse || '1', items: [{ orderLineId: line.id, quantity, quantityAccepted: acceptedQuantity, quantityRejected: rejectedQuantity, lot: receiptData.lot || null, serial: receiptData.serial || null, expiryDate: receiptData.expiryDate || null, qualityStatus: receiptData.qualityStatus || 'released' }], type: shortageQuantity === 0 ? 'total' : 'partial', documentType: receiptData.documentType || 'supplier_remission', supplierRemission: receiptData.documentType === 'supplier_remission' ? reference : null, supplierInvoiceReference: receiptData.documentType === 'supplier_invoice' ? reference : null, invoiceRequiredLater: receiptData.documentType !== 'supplier_invoice', qualityStatus: receiptData.qualityStatus || 'released', inspectionStatus: receiptData.qualityStatus === 'quarantine' ? 'pending' : receiptData.qualityStatus === 'rejected' ? 'rejected' : 'released', evidence, shortage: shortageQuantity ? { quantity: shortageQuantity, resolution: receiptData.shortageResolution, commitmentDate: receiptData.shortageCommitment || null, notes: receiptData.shortageNotes || null, responsible: request.responsible || actor.name, status: authorizedCancellation ? 'cancelled' : 'open', closedAt: authorizedCancellation ? at : null, closedBy: authorizedCancellation ? actor.name : null } : null, user: actor.name, observations: notes, reference };
      const receiptMovementId = inventoryMovementFolio(next,'entry',at);
      if(receipt.qualityStatus==='released'){line.quantityAvailableReceived=core.numberValue(line.quantityAvailableReceived==null?before.quantityReceived:line.quantityAvailableReceived)+acceptedQuantity;catalogAdjustments.push({productId:line.productId,warehouseId:receipt.warehouseId,delta:acceptedQuantity})}
      else if(receipt.qualityStatus==='quarantine'&&acceptedQuantity>0)catalogAdjustments.push({productId:line.productId,warehouseId:receipt.warehouseId,delta:acceptedQuantity,inventoryState:'quarantine',sourceMovementId:receiptMovementId});
      next.receipts.push(receipt);
      if (receipt.shortage) line.shortagePlan = { ...receipt.shortage, receiptId: receipt.id };
      if (authorizedCancellation) {
        const cancellable = Math.min(shortageQuantity, Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)));
        line.quantityCancelled = core.numberValue(line.quantityCancelled) + cancellable;
        line.quantityToPurchase = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
        line.cancellationReason = receiptData.shortageNotes;
        line.cancelledAt = at;
        line.cancelledBy = actor.name;
        supplierLink.quantityCancelled = core.numberValue(supplierLink.quantityCancelled) + shortageQuantity;
        supplierLink.cancellationReason = receiptData.shortageNotes;
        supplierLink.cancelledAt = at;
        supplierLink.cancelledBy = actor.name;
        shortageCancellationAudit = { quantity: shortageQuantity, supplierOrderId: supplierOrder.id, receiptId: receipt.id, notes: receiptData.shortageNotes };
      }
      if (supplierOrder) { const orderLinks = next.supplierOrderLines.filter(link => link.supplierOrderId === supplierOrder.id), ordered = orderLinks.reduce((sum, link) => sum + Math.max(0, core.numberValue(link.quantity) - core.numberValue(link.quantityCancelled)), 0), received = next.receipts.filter(item => item.supplierOrderId === supplierOrder.id).flatMap(item => item.items || []).reduce((sum, item) => sum + core.numberValue(item.quantityAccepted ?? item.quantity) , 0); supplierOrder.status = received >= ordered ? 'received' : 'partially_received'; supplierOrder.reconciliation = core.reconcileSupplierPurchase({ order: supplierOrder, links: next.supplierOrderLines, receipts: next.receipts, invoices: next.supplierInvoices }); }
      if (acceptedQuantity > 0) next.inventoryMovements.push({ id: receiptMovementId,folio:receiptMovementId,requisitionId: request.id, orderLineId: line.id, warehouseId: receipt.warehouseId, productId: line.productId, catalog: line.catalog, type: 'entry', quantity: acceptedQuantity, inventoryState: receipt.qualityStatus === 'released' ? 'available' : receipt.qualityStatus, reason: request.type === 'internal_stock' ? 'Recepción para stock' : 'Entrada contra OC a proveedor', sourceDocumentType: 'receipt', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: supplierOrder?.reconciliation?.status || (line.productId ? 'pending_invoice' : 'pending_product_match') });
    }
    if (type === 'delivery') {
      const reservations = next.inventoryReservations.filter(item => item.orderLineId === line.id && item.status === 'active'), preferredWarehouses = reservations.map(item => String(item.warehouseId || '1'));
      catalogAdjustments = planCatalogDeduction(line.productId, quantity, [...preferredWarehouses, line.deliveryWarehouse || '1']);
      if (!catalogAdjustments) return notify('La existencia física de los almacenes no alcanza para registrar esta salida. Revisa recepciones y reservas.', 'error');
      const evidenceFiles = [...(deliveryData.evidenceFiles || [])], evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type, version: 1, origin: 'delivery_confirmation' }));
      if (evidenceFiles.length > 5 || !evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/')) && file.size <= 5 * 1024 * 1024)) return notify('Las evidencias de entrega deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');
      if (window.BioMediaStore) { try { const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', id, evidenceFiles); stored.forEach((record, index) => { evidence[index].id = record.id; evidence[index].hash = record.hash; }); } catch { return notify('No fue posible conservar la evidencia; la remisión no se generó.'); } }
      next.shipments.push({ id, folio: reference || id, date: localDateKey(), scheduledAt: deliveryData.scheduledAt || null, requisitionId: request.id, items: [{ orderLineId: line.id, quantity }], deliveredAt: at, recipient: deliveryData.recipient, type: next.orderLines.filter(item => item.requisitionId === request.id).every(item => core.numberValue(item.quantityDelivered) >= Math.max(0, core.numberValue(item.quantityRequested) - core.numberValue(item.quantityCancelled))) ? 'total' : 'partial', evidenceId: evidence[0]?.id || null, evidence, observations: notes });
      let remainingToConsume = quantity; const reservedByWarehouse = {};
      reservations.forEach(reservation => { const availableReservation = Math.max(0, core.numberValue(reservation.quantity) - core.numberValue(reservation.quantityConsumed)), used = Math.min(remainingToConsume, availableReservation), warehouseId = String(reservation.warehouseId || '1'); reservation.quantityConsumed = core.numberValue(reservation.quantityConsumed) + used; remainingToConsume -= used; reservedByWarehouse[warehouseId] = core.numberValue(reservedByWarehouse[warehouseId]) + used; if (reservation.quantityConsumed >= core.numberValue(reservation.quantity)) reservation.status = 'consumed'; });
      catalogAdjustments.forEach((adjustment) => { const warehouseId = String(adjustment.warehouseId), movementQuantity = Math.abs(adjustment.delta), reservedQuantityUsed = Math.min(movementQuantity, core.numberValue(reservedByWarehouse[warehouseId])); reservedByWarehouse[warehouseId] = Math.max(0, core.numberValue(reservedByWarehouse[warehouseId]) - reservedQuantityUsed); next.inventoryMovements.push({ id: inventoryMovementFolio(next, 'exit', at), requisitionId: request.id, orderLineId: line.id, warehouseId, productId: line.productId, catalog: line.catalog, type: 'exit', quantity: movementQuantity, reservedQuantityUsed, purchasedQuantityUsed: movementQuantity - reservedQuantityUsed, reason: 'Salida contra remisión', sourceDocumentType: 'shipment', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: line.productId ? 'matched' : 'pending_product_match' }); });
    }
    if (['invoice', 'account_charge'].includes(type)) next.customerInvoices.push({ id, folio: type === 'invoice' ? reference || id : null, date: at.slice(0, 10), amount: line.unitPrice * quantity * (1 + line.taxRate / 100), requisitionId: request.id, items: [{ orderLineId: line.id, quantity }], type: type === 'account_charge' ? 'account_charge' : 'standard', accountReference: type === 'account_charge' ? reference : null, observation: notes });
    if (type === 'cancel') { line.cancellationReason = notes; line.cancelledBy = actor.name; line.cancelledAt = at; }
    line.status = core.deriveLineStatus(line);
    request.status = core.deriveRequisitionStatus(next.orderLines.filter(item => item.requisitionId === request.id));
    request.updatedAt = at;
    next.auditLog.push({ id: `AUD-${Date.now()}`, entityType: 'order_line', entityId: line.id, action: type, eventKind: 'formal_operation', user: actor.name, at, before, after: JSON.parse(JSON.stringify(line)), supplier: supplier || null, reference, notes, nextAction: progressMeta.nextAction || null, commitmentDate: progressMeta.commitmentDate || null, blockers: progressMeta.blockers || null, override: Boolean(override), receipt: type === 'receipt' ? { documentType: receiptData.documentType, warehouseId: receiptData.warehouseId, rejectedQuantity: core.numberValue(receiptData.rejectedQuantity), lot: receiptData.lot || null, serial: receiptData.serial || null, expiryDate: receiptData.expiryDate || null, qualityStatus: receiptData.qualityStatus || 'released', shortageResolution: receiptData.shortageResolution || null, shortageNotes: receiptData.shortageNotes || null } : null, evidence: type === 'delivery' ? (next.shipments.find(shipment => shipment.id === id)?.evidence || []) : [] });
    if (shortageCancellationAudit) next.auditLog.push({ id: `AUD-SHORTAGE-CANCEL-${Date.now()}`, entityType: 'order_line', entityId: line.id, action: 'shortage_authorized_cancellation', eventKind: 'formal_operation', user: actor.name, at, before: { quantityCancelled: core.numberValue(before.quantityCancelled) }, after: { quantityCancelled: core.numberValue(line.quantityCancelled) }, reference: shortageCancellationAudit.receiptId, notes: `${shortageCancellationAudit.quantity} unidad(es) del saldo de ${shortageCancellationAudit.supplierOrderId} canceladas con autorización. ${shortageCancellationAudit.notes}`, shortage: shortageCancellationAudit });
    if (!saveStore(next)) return;
    const inventoryWarning = catalogAdjustments.length && !applyCatalogStockAdjustments(catalogAdjustments) ? 'La operación quedó registrada, pero la existencia del catálogo requiere conciliación manual.' : '';
    const acceptedReceiptQuantity=type==='receipt'?Math.max(0,quantity-core.numberValue(receiptData.rejectedQuantity)):0,receiptDetail = type === 'receipt' ? `${acceptedReceiptQuantity} unidad(es) aceptada(s)${receiptData.rejectedQuantity ? ` · ${receiptData.rejectedQuantity} rechazada(s)` : ''}${shortageCancellationAudit ? ` · ${shortageCancellationAudit.quantity} del saldo cancelada(s) con autorización` : ''} · ${acceptedReceiptQuantity>0?'Entrada de almacén generada.':'Sin entrada de almacén.'}` : '';
    const deliveryDetail = type === 'delivery' ? `${quantity} unidad(es) entregada(s) · Remisión y salida de almacén generadas.` : '';
    returnToDossierAfterOperation(request.id, { type, quantity, reference, detail: receiptDetail || deliveryDetail || 'Movimiento formal registrado en la bitácora.', warning: inventoryWarning });
  }

  async function fingerprint(buffer) {
    if (!crypto?.subtle) return core.hashString(String(buffer.byteLength));
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function filteredImportRows() {
    if (!importSimulation) return [];
    const term = searchKey(q('#orderImportSearch').value), status = q('#orderImportStatus').value;
    return importSimulation.rows.filter(row => (!status || row.status === status) && (!term || searchKey([row.sourceRow, row.record.requisitionFolio, row.record.productCatalog, row.record.productDescription, row.record.customer, row.record.supplier].join(' ')).includes(term)));
  }

  function renderImportSimulation() {
    const counts = importSimulation ? importSimulation.rows.reduce((totals, row) => ({ ...totals, [row.status]: (totals[row.status] || 0) + 1 }), { ready: 0, warning: 0, error: 0, duplicate: 0, skipped: 0 }) : { ready: 0, warning: 0, error: 0, duplicate: 0, skipped: 0 };
    q('#orderImportReady').textContent = counts.ready; q('#orderImportWarnings').textContent = counts.warning; q('#orderImportErrors').textContent = counts.error; q('#orderImportDuplicates').textContent = counts.duplicate;
    const rows = filteredImportRows(); q('#orderImportResultCount').textContent = `${rows.length} resultado${rows.length === 1 ? '' : 's'}`;
    q('#confirmOrdersImport').disabled = !importSimulation || !(counts.ready + counts.warning);
    q('#orderImportRows').innerHTML = rows.map(row => `<article class="order-import-row ${row.status}"><input type="checkbox" class="order-import-check" data-import-row="${row.sourceRow}" ${['ready', 'warning'].includes(row.status) ? 'checked' : ''} ${['error', 'duplicate'].includes(row.status) ? 'disabled' : ''}><div class="order-import-result"><strong>Fila ${row.sourceRow}</strong><span class="order-result-pill ${row.status}">${{ ready: 'LISTA', warning: 'ADVERTENCIA', error: 'RECHAZADA', duplicate: 'DUPLICADA', skipped: 'OMITIDA' }[row.status]}</span></div><span><strong>${escapeHtml(row.record.requisitionFolio || 'Sin folio')}</strong><br>${row.record.requestType === 'internal_stock' ? 'Stock interno' : escapeHtml(row.record.customer || 'Sin institución')}</span><div class="order-import-product"><strong>${escapeHtml(row.record.productCatalog || 'Sin catálogo')} · ${escapeHtml(row.record.productDescription || 'Sin producto')}</strong><small>${row.record.quantityRequested} uds. · ${escapeHtml(row.record.brand || 'Sin marca')}</small></div><span>${escapeHtml(row.record.supplier || 'Proveedor pendiente')}<br><small>${row.record.purchaseMode === 'deposit' ? 'Compra por depósito' : escapeHtml(row.record.purchaseOrderFolio || 'Sin OC')}</small></span><div class="order-issue-stack">${row.issues.slice(0, 3).map(issue => `<span class="order-issue ${issue.level}">${escapeHtml(issue.message)}</span>`).join('') || '<span class="order-issue">Sin incidencias</span>'}${row.issues.length > 3 ? `<small>+${row.issues.length - 3} incidencias</small>` : ''}</div><button class="order-import-skip" data-skip-import-row="${row.sourceRow}" ${['error', 'duplicate'].includes(row.status) ? 'disabled' : ''}>${row.status === 'skipped' ? 'Incluir' : 'Omitir'}</button></article>`).join('') || '<div class="order-import-empty"><i data-lucide="search-x"></i><strong>Sin resultados para este filtro</strong><span>Cambia la búsqueda o el estado seleccionado.</span></div>';
    window.lucide?.createIcons();
  }

  async function analyzeOrdersFile(file) {
    q('#ordersFileStatus').textContent = 'Leyendo y validando…';
    const buffer = await file.arrayBuffer(), fileHash = await fingerprint(buffer), workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
    const sheetName = workbook.SheetNames.find(name => searchKey(name) === 'SURTIR');
    if (!sheetName) throw new Error('El archivo no contiene la hoja SURTIR.');
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const exchangeSheetName = workbook.SheetNames.find(name => searchKey(name) === 'CALCULO USD X MX');
    const exchangeRateMap = {};
    if (exchangeSheetName) {
      const exchangeRows = XLSX.utils.sheet_to_json(workbook.Sheets[exchangeSheetName], { header: 1, raw: true, defval: null });
      const exchangeRateDate = core.excelDateToISO(exchangeRows[3]?.[4]);
      exchangeRows.forEach(row => {
        const order = core.cleanText(row[2]), rate = core.numberValue(row[4]);
        if (order && rate > 0) exchangeRateMap[searchKey(order)] = { rate, date: exchangeRateDate };
      });
    }
    const headers = matrix[0] || [], required = ['FECHA', 'ORDENES DE COMPRA', 'NO FAC PROVEEDOR', 'PROVEEDOR', 'PRODUCTOS', 'REQUISICION DE PEDIDO'];
    const normalizedHeaders = headers.map(searchKey);
    const missing = required.filter(header => !normalizedHeaders.includes(header));
    if (missing.length) throw new Error(`Faltan columnas requeridas: ${missing.join(', ')}.`);
    const existingHashes = store.imports.flatMap(entry => entry.sourceHashes || []);
    importSimulation = core.simulateImport({ rows: matrix.slice(1), fileHash, sheetName, existingSourceHashes: existingHashes, defaultTaxRate: store.settings.defaultTaxRate, exchangeRateMap });
    importSimulation.fileName = file.name; importSimulation.fileSize = file.size;
    q('#ordersFileStatus').textContent = `${file.name} · ${importSimulation.rows.length} filas analizadas`;
    renderImportSimulation();
  }

  function confirmImport() {
    if (!importSimulation) return;
    const accepted = importSimulation.rows.filter(row => ['ready', 'warning'].includes(row.status));
    const proceed = () => {
      const result = core.materializeImport(store, importSimulation, actor.name);
      if (!saveStore(result.store)) return; renderOrderDashboard();
      q('#ordersFileStatus').textContent = `${result.importRecord.id} · ${result.importRecord.imported} filas incorporadas`;
      importSimulation.rows.forEach(row => { if (['ready', 'warning'].includes(row.status)) row.status = 'duplicate'; });
      renderImportSimulation(); notify(`Importación ${result.importRecord.id} confirmada sin duplicados.`);
    };
    if (typeof window.showActionConfirmation === 'function') window.showActionConfirmation({ kicker: 'CONFIRMAR MIGRACIÓN', title: '¿Incorporar la vista previa?', text: 'Los registros válidos se crearán en una sola transacción local. Los rechazados, duplicados y omitidos no se modificarán.', summaryTitle: 'RESUMEN DE IMPORTACIÓN', items: [{ name: importSimulation.fileName || 'Archivo de pedidos', detail: `${accepted.length} filas aceptadas · ${importSimulation.rows.filter(row => row.status === 'error').length} rechazadas`, value: `${accepted.length} registros`, delta: accepted.length }], confirmLabel: 'Confirmar importación', onConfirm: proceed });
    else if (confirm('¿Confirmar la importación revisada?')) proceed();
  }

  window.BioOrderDocuments = { downloadSupplierOrder, downloadInventoryDocument, downloadShipmentDocument, downloadOrderAudit };

  const openViewWithFilter = (view, filterId = '', value = '') => {
    const link = document.querySelector(`.nav-item[data-view="${view}"], .nav-subitem[data-view="${view}"]`);
    if (!link || link.hidden) return notify('Tu perfil no tiene acceso a esta vista.');
    link.click();
    if (filterId) { const control = q(`#${filterId}`); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  function openTrackingWorkbench(requestId) {
    const link = document.querySelector('.nav-item[data-view="ordersView"], .nav-subitem[data-view="ordersView"]');
    if (!link || link.hidden) return notify('Tu perfil no tiene acceso al seguimiento integral.');
    trackingSelectedRequestId = requestId; trackingPage = 1;
    ['orderSearch', 'orderStatusFilter', 'orderStageFilter', 'orderResponsibleFilter', 'orderDateFrom', 'orderDateTo'].forEach(id => { q(`#${id}`).value = ''; });
    link.click(); renderOrderDashboard();
  }
  function openDeliveryWorkbench(requestId) {
    const link = document.querySelector('.nav-item[data-view="deliveriesView"], .nav-subitem[data-view="deliveriesView"]');
    if (!link || link.hidden) return notify('Tu perfil no tiene acceso a entregas y remisiones.');
    deliverySelectedRequestId = requestId; deliveryPage = 1; q('#deliverySearch').value = ''; q('#deliveryStatusFilter').value = '';
    link.click(); renderDeliveries();
  }
  const makeMetricInteractive = (valueId, view, filterId = '', value = '', afterOpen) => {
    const card = q(`#${valueId}`)?.closest('article'); if (!card) return;
    card.classList.add('interactive-summary'); card.tabIndex = 0; card.setAttribute('role', 'button');
    card.addEventListener('click', () => { openViewWithFilter(view, filterId, value); afterOpen?.(); });
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } });
  };
  makeMetricInteractive('trackingSummaryOpen', 'ordersView', 'orderStageFilter', '');
  makeMetricInteractive('trackingSummaryReceive', 'ordersView', 'orderStageFilter', 'receive');
  makeMetricInteractive('trackingSummaryDeliver', 'ordersView', 'orderStageFilter', 'deliver');
  makeMetricInteractive('trackingSummaryShipments', 'deliveriesView', 'deliveryStatusFilter', '');
  makeMetricInteractive('orderMetricPurchase', 'ordersView', 'orderStageFilter', 'purchase');
  makeMetricInteractive('orderMetricReceive', 'ordersView', 'orderStageFilter', 'receive');
  makeMetricInteractive('orderMetricDeliver', 'ordersView', 'orderStageFilter', 'deliver');
  makeMetricInteractive('orderMetricInvoice', 'ordersView', 'orderStageFilter', 'invoice');
  makeMetricInteractive('deliveryMetricPending', 'deliveriesView', 'deliveryStatusFilter', 'pending');
  makeMetricInteractive('deliveryMetricPartial', 'deliveriesView', 'deliveryStatusFilter', 'partial');
  makeMetricInteractive('deliveryMetricCompleted', 'deliveriesView', 'deliveryStatusFilter', 'completed');
  makeMetricInteractive('deliveryMetricDocuments', 'deliveriesView', 'deliveryStatusFilter', '');
  makeMetricInteractive('supplierOrderDraftCount', 'supplierOrdersView', 'supplierOrderStatusFilter', 'draft');
  makeMetricInteractive('supplierOrderConfirmedCount', 'supplierOrdersView', 'supplierOrderStatusFilter', '');
  makeMetricInteractive('supplierOrderSupplierCount', 'supplierOrdersView', 'supplierOrderStatusFilter', '');
  makeMetricInteractive('supplierOrderMissingCount', 'supplierOrdersView', 'supplierOrderStatusFilter', '', () => setTimeout(() => q('#supplierOrderIssues')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 160));

  q('#backToOrders').addEventListener('click', () => document.querySelector('.orders-group [data-view="ordersView"]')?.click());
  ['orderSearch', 'orderDateFrom', 'orderDateTo'].forEach(id => q(`#${id}`).addEventListener('input', () => { trackingPage = 1; renderOrderDashboard(); }));
  ['orderStatusFilter', 'orderStageFilter', 'orderResponsibleFilter'].forEach(id => q(`#${id}`).addEventListener('change', () => { trackingPage = 1; renderOrderDashboard(); }));
  q('#orderFilterReset').addEventListener('click', () => { ['orderSearch', 'orderStatusFilter', 'orderStageFilter', 'orderResponsibleFilter', 'orderDateFrom', 'orderDateTo'].forEach(id => { q(`#${id}`).value = ''; }); trackingPage = 1; renderOrderDashboard(); });
  q('#supplierOrderSearch').addEventListener('input', renderSupplierPurchaseOrders);
  q('#supplierOrderStatusFilter').addEventListener('change', renderSupplierPurchaseOrders);
  q('#supplierOrderIssues').addEventListener('click', event => {
    const button = event.target.closest('[data-relate-supplier],[data-open-relation-product],[data-open-relation-supplier]'); if (!button) return;
    const lineId = button.dataset.relateSupplier || button.dataset.openRelationProduct || button.dataset.openRelationSupplier, issue = supplierOrderMissingLines().find(item => item.line.id === lineId); if (!issue) return;
    if (button.dataset.relateSupplier) { openSupplierRelationDialog(issue); return; }
    if (button.dataset.openRelationProduct) { location.hash = '#productos'; const input = q('#productSearch'); if (input) { input.value = issue.line.catalog || issue.line.description || ''; input.dispatchEvent(new Event('input')); } return; }
    location.hash = '#proveedores';
  });
  q('#supplierOrderList').addEventListener('click', event => {
    const confirmButton = event.target.closest('[data-confirm-supplier-order]'), downloadButton = event.target.closest('[data-download-supplier-order]'), statusBadge = event.target.closest('.order-status-badge');
    if (statusBadge) { const label = statusBadge.textContent.trim(), match = { 'Propuesta': 'draft', 'Borrador': 'draft', 'Confirmada': 'confirmed', 'Recepción parcial': 'partially_received', 'Recibida': 'received' }[label]; if (match) { q('#supplierOrderStatusFilter').value = match; renderSupplierPurchaseOrders(); } }
    if (confirmButton) confirmSupplierOrder(confirmButton.dataset.confirmSupplierOrder);
    if (downloadButton) downloadSupplierOrder(downloadButton.dataset.downloadSupplierOrder);
  });
  // Expediente Bio: adapta el patrón de expediente de CapitalPL al flujo de
  // abastecimiento, sin crear un registro paralelo a las entidades operativas.
  const commercialOrders = () => { try { return JSON.parse(localStorage.getItem('nexo-commercial-orders') || '[]'); } catch { return []; } };
  const quotations = () => { try { return JSON.parse(localStorage.getItem('nexo-sales-quotations') || '[]'); } catch { return []; } };
  const canDossierProgress = () => ['purchase', 'receive', 'inventory', 'deliver', 'invoice', 'cancel'].some(permission => window.BioAccess?.can?.(permission) ?? can(permission));
  const dossierCurrency = (request, lines, supplierOrders) => {
    const order = commercialOrders().find(item => item.id === request.clientOrderId);
    const currencies = [...new Set([order?.currency, ...supplierOrders.map(item => item.currency), ...lines.map(item => item.currency)].filter(Boolean).map(String))];
    return currencies.length > 1 ? 'MULTI' : (currencies[0] || 'MXN');
  };
  const dossierMoney = (value, currency) => currency === 'MULTI' ? 'Importe por divisa' : `${currency} ${Number(value || 0).toLocaleString('es-MX', { style: 'currency', currency }).replace(new RegExp(`^${currency}\\s*`, 'i'), '')}`;
  const dossierDate = value => window.BioDeliveryPresentation.format(value);
  const shipmentTypeLabel = shipment => window.BioDeliveryPresentation.label(shipment, requestLines(shipment.requisitionId), store.shipments);
  const shipmentDateLabel = shipment => window.BioDeliveryPresentation.dateLabel(shipment);
  const inventoryStateLabel = value => ({ available: 'Disponible para entrega', released: 'Disponible para entrega', quarantine: 'En cuarentena · no disponible para entrega', rejected: 'Rechazada · fuera de existencias' })[value] || 'Estado por revisar';
  const movementTypeLabel = value => ({ entry: 'Entrada', exit: 'Salida', transfer: 'Traspaso', adjustment: 'Ajuste' })[value] || 'Movimiento';
  const movementReasonLabel = value => ({ historical_quarantine_reconciliation: 'Conciliación histórica de mercancía en cuarentena', inventory_reconciliation: 'Conciliación de existencias', supplier_receipt: 'Recepción de proveedor', order_delivery: 'Salida por remisión', internal_transfer: 'Traspaso entre almacenes' })[value] || value || 'Movimiento operativo';
  const movementSourceLabel = value => ({ receipt: 'Recepción', shipment: 'Remisión', supplier_order: 'Orden de compra', inventory: 'Movimiento de almacén' })[value] || 'Documento';
  const reconciliationStatusLabel = value => ({ matched: 'Conciliada', pending_invoice: 'Factura pendiente', pending_product_match: 'Producto pendiente de vincular', pending: 'Pendiente de conciliación' })[value] || 'Por revisar';
  const reservationStatusLabel = value => ({ active: 'Activa', consumed: 'Consumida', released: 'Liberada', cancelled: 'Cancelada' })[value] || 'Por revisar';
  function financialRequestLines(request) {
    const order = commercialOrders().find(order => order.id === request.clientOrderId || order.id === request.id);
    const financial = order && window.BioCommercialMoney?.snapshot(order, quotations());
    return requestLines(request.id).map((line, index) => {
      const item = financial?.items?.[index];
      if (!item) return line;
      const { unitPrice, discount, discountTotal, subtotal, taxable, taxRate, taxAmount, total, currency } = item;
      return { ...line, unitPrice, discount, discountTotal, subtotal, taxable, taxRate, taxAmount, total, currency };
    });
  }
  function dossierData(request) {
    const lines = financialRequestLines(request), lineIds = new Set(lines.map(line => line.id));
    const supplierLinks = store.supplierOrderLines.filter(link => lineIds.has(link.orderLineId));
    const supplierOrderIds = new Set(supplierLinks.map(link => link.supplierOrderId));
    const supplierOrders = store.supplierOrders.filter(order => supplierOrderIds.has(order.id) || order.requisitionIds?.includes(request.id));
    supplierOrders.forEach(order => supplierOrderIds.add(order.id));
    const receipts = store.receipts.filter(item => (item.requisitionId === request.id || supplierOrderIds.has(item.supplierOrderId)) && !item.duplicateOf && item.status !== 'duplicate_ignored');
    const movements = store.inventoryMovements.filter(item => item.requisitionId === request.id || lineIds.has(item.orderLineId));
    const shipments = store.shipments.filter(item => item.requisitionId === request.id);
    const supplierInvoices = store.supplierInvoices.filter(invoice => invoice.supplierOrderIds?.some(id => supplierOrderIds.has(id)));
    const customerInvoices = store.customerInvoices.filter(invoice => invoice.requisitionId === request.id);
    const audits = store.auditLog.filter(entry => lineIds.has(entry.entityId) || entry.entityId === request.id || supplierOrderIds.has(entry.entityId)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const progress = requestProgress(request), authorized = Math.max(0, progress.requested);
    const percent = authorized ? Math.min(100, Math.round(progress.delivered / authorized * 100)) : 0;
    const latest = audits[0], committed = lines.map(line => line.committedDate).filter(Boolean).sort()[0] || null;
    const late = committed ? new Date(`${committed}T23:59:59`).getTime() < Date.now() && progress.delivered < authorized : false;
    const currency = dossierCurrency(request, lines, supplierOrders);
    return { lines, supplierLinks, supplierOrders, receipts, movements, shipments, supplierInvoices, customerInvoices, audits, progress, authorized, percent, latest, committed, late, currency };
  }
  const dossierTab = (id, label, count, active) => `<button type="button" class="dossier-tab ${active === id ? 'active' : ''}" data-dossier-tab="${id}" aria-selected="${active === id}">${label}<b>${count}</b></button>`;
  const dossierDocumentButton = (kind, id, label, icon = 'file-text') => `<button type="button" data-flow-document="${kind}" data-flow-id="${escapeHtml(id)}"><i data-lucide="${icon}"></i>${escapeHtml(label)}</button>`;
  function renderOrderDetail(requestId, selectedTab = activeDossierTab) {
    const request = store.requisitions.find(item => item.id === requestId); if (!request) return;
    activeRequestId = request.id; activeDossierTab = selectedTab; q('#downloadOrderAudit').hidden = false;
    const data = dossierData(request), quote = quotations().find(item => item.id === request.quotationId), clientOrder = commercialOrders().find(item => item.id === request.clientOrderId);
    const total = data.lines.reduce((sum, line) => sum + core.numberValue(line.total), 0), blockers = data.audits.filter(entry => entry.blockers).map(entry => entry.blockers), nextAction = data.latest?.nextAction || (data.progress.delivered < data.authorized ? 'Completar surtido y registrar entrega' : data.customerInvoices.length ? 'Validar cierre administrativo' : 'Emitir factura al cliente');
    const alerts = [data.late ? 'Fecha comprometida vencida' : '', blockers[0] || '', request.customerAcceptance ? '' : 'Falta aceptación del cliente', data.progress.overDelivered > 0 ? `Revisar entregas: ${data.progress.overDelivered} unidad(es) registradas por encima del saldo autorizado.` : ''].filter(Boolean);
    const operationNotice = processedOperationNotice?.requestId === request.id ? processedOperationNotice : null;
    const lineRows = data.lines.map(line => { const pending = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered)), supply = lineSupply(line); return `<article class="dossier-line"><div><strong>${escapeHtml(line.catalog || 'S/C')} · ${escapeHtml(line.description)}</strong><small>${escapeHtml(line.brandName || 'Sin marca')} · ${escapeHtml(core.STATUS_LABELS[line.status] || line.status)}</small><div class="order-line-progress"><i style="width:${Math.min(100, line.quantityRequested ? core.numberValue(line.quantityDelivered) / line.quantityRequested * 100 : 0)}%"></i></div></div><span>Sol. <b>${line.quantityRequested}</b></span><span>Res. <b>${core.numberValue(line.reservedQuantity)}</b></span><span>Comp. <b>${supply.purchased}</b></span><span>Rec. <b>${supply.received}</b></span><span>Ent. <b>${line.quantityDelivered}</b></span><span>Pend. <b>${pending}</b></span><strong>${dossierMoney(line.total, data.currency)}</strong>${canDossierProgress() && request.status !== 'cancelled' ? `<button class="order-line-action" data-order-progress="${line.id}">Registrar avance</button>` : ''}</article>`; }).join('') || '<p class="subtitle">Sin partidas relacionadas.</p>';
    const documents = [
      quote && dossierDocumentButton('quotation', quote.id, `Cotización ${quote.id}`, 'file-signature'),
      clientOrder && dossierDocumentButton('client_order', clientOrder.id, `Pedido interno ${clientOrder.id}`, 'clipboard-check'),
      ...data.supplierOrders.map(order => dossierDocumentButton('supplier_order', order.id, `OC proveedor ${order.id}`, 'shopping-bag')),
      ...data.movements.map(movement => dossierDocumentButton('inventory', movement.id, `${movement.type === 'entry' ? 'Entrada' : 'Salida'} ${inventoryMovementDisplayFolio(movement)}`, movement.type === 'entry' ? 'arrow-down-to-line' : 'arrow-up-from-line')),
      ...data.shipments.map(shipment => dossierDocumentButton('remision', shipment.id, `Remisión ${shipment.folio || shipment.id}`, 'truck'))
    ].filter(Boolean).join('');
    const totalReceiptActions=[...new Set(data.supplierLinks.map(link=>link.supplierOrderId).filter(Boolean))].map(supplierOrderId=>{const supplierOrder=data.supplierOrders.find(order=>order.id===supplierOrderId),pending=data.supplierLinks.map(link=>({link,line:data.lines.find(line=>line.id===link.orderLineId),quantity:core.supplierOrderLinePending({supplierOrderId,link,receipts:store.receipts})})).filter(item=>item.link.supplierOrderId===supplierOrderId&&item.line&&item.quantity>0),units=pending.reduce((sum,item)=>sum+item.quantity,0);return pending.length&&can('receive')?`<button type="button" class="dossier-formal-primary-action receipt" data-formal-total-receipt="${escapeHtml(supplierOrderId)}" data-formal-total-request="${escapeHtml(request.id)}"><i data-lucide="package-check"></i><span><strong>Recepción total · ${escapeHtml(supplierOrderId)}</strong><small>${escapeHtml(supplierOrder?.supplierName || 'Proveedor')} · ${pending.length} partidas · ${units} uds.</small></span><i class="formal-action-arrow" data-lucide="arrow-right"></i></button>`:''}).join(''),deliveryPending=data.lines.filter(line=>Math.max(0,core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.quantityDelivered))>0),canDeliverTotal=deliveryPending.length&&deliveryPending.every(line=>core.numberValue(line.reservedQuantity)-core.numberValue(line.quantityDelivered)+core.numberValue(line.quantityAvailableReceived==null?line.quantityReceived:line.quantityAvailableReceived)>=Math.max(0,core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.quantityDelivered))),totalDeliveryAction=canDeliverTotal&&can('deliver')?`<button type="button" class="dossier-formal-primary-action delivery" data-formal-total-delivery="${escapeHtml(request.id)}"><i data-lucide="truck-check"></i><span><strong>Generar remisión total</strong><small>${deliveryPending.length} partidas listas para entregar</small></span><i class="formal-action-arrow" data-lucide="arrow-right"></i></button>`:'';
    const formalProcessRows = data.lines.map(line => {
      const receiptPendingQuantity = data.supplierLinks.filter(link => link.orderLineId === line.id).reduce((sum, link) => sum + core.supplierOrderLinePending({ supplierOrderId: link.supplierOrderId, link, receipts: store.receipts }), 0), receiptPending = receiptPendingQuantity > 0, deliveryPending = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled)) > core.numberValue(line.quantityDelivered), available = core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityDelivered) + core.numberValue(line.quantityAvailableReceived == null ? line.quantityReceived : line.quantityAvailableReceived);
      return `<article class="dossier-record compact"><div><strong>${escapeHtml(line.catalog || 'S/C')} · ${escapeHtml(line.description)}</strong><small>${receiptPending ? `${receiptPendingQuantity} pendiente(s) de recepción` : 'Recepción al día'} · ${deliveryPending ? `${Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.quantityDelivered))} pendiente(s) de entrega` : 'Entrega al día'}</small></div><div class="dossier-formal-actions">${receiptPending && can('receive') ? `<button type="button" class="order-line-action" data-formal-progress="receipt" data-order-line="${escapeHtml(line.id)}">Registrar recepción</button>` : ''}${deliveryPending && available > 0 && can('deliver') ? `<button type="button" class="order-line-action" data-formal-progress="delivery" data-order-line="${escapeHtml(line.id)}">Generar remisión</button>` : ''}</div></article>`;
    }).join('');
    const timelineEntries = data.audits;
    const tabContent = {
      summary: `<section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">AVANCE POR PARTIDA</p><h3>Resumen operativo</h3></div><b class="dossier-progress">${data.percent}%</b></div><div class="dossier-progress-track"><i style="width:${data.percent}%"></i></div><p class="dossier-summary-help">Consulta el detalle comercial, compras, recepciones o almacén en sus pestañas. Aquí se muestran solo las cantidades necesarias para continuar.</p><div class="dossier-line-list dossier-summary-lines">${lineRows}</div></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">OPERACIONES FORMALES</p><h3>Recepciones y remisiones</h3></div><small>Selecciona una OC para recibir todo su pendiente; usa la acción por partida únicamente para una operación parcial.</small></div>${totalReceiptActions||totalDeliveryAction?`<div class="dossier-formal-bulk-actions">${totalReceiptActions}${totalDeliveryAction}</div>`:''}<div class="dossier-line-list">${formalProcessRows}</div></section>`,
      commercial: `<section class="dossier-section"><h3>Comercial y pedido de venta</h3><div class="dossier-grid"><article><span>COTIZACIÓN</span><strong>${escapeHtml(quote?.id || request.quotationId || 'Sin cotización')}</strong><small>${quote ? `${quote.items?.length || 0} partida(s) · ${dossierMoney(quote.total, quote.currency || data.currency)}` : 'Sin registro comercial vinculado'}</small></article><article><span>ACEPTACIÓN</span><strong>${escapeHtml(clientOrder?.acceptance?.reference || request.customerAcceptance?.reference || 'Pendiente')}</strong><small>${escapeHtml(clientOrder?.acceptance?.type || request.customerAcceptance?.type ? acceptanceTypeLabel(clientOrder?.acceptance?.type || request.customerAcceptance?.type) : 'Se requiere evidencia de aceptación')}</small></article><article><span>OC DEL CLIENTE</span><strong>${escapeHtml(clientOrder?.id || request.clientOrderId || 'Pendiente')}</strong><small>${escapeHtml(clientOrder?.status === 'active' ? 'Activa para abastecimiento' : 'Pendiente de activar')}</small></article><article><span>RESPONSABLE</span><strong>${escapeHtml(request.responsible || 'Sin asignar')}</strong><small>Cliente: ${escapeHtml(request.customerName || 'Stock interno')}</small></article></div>${lineRows}</section>`,
      purchases: `<section class="dossier-section"><h3>Compras y consolidación</h3>${data.supplierOrders.map(order => { const links = data.supplierLinks.filter(link => link.supplierOrderId === order.id), assigned = links.reduce((sum, link) => sum + Math.max(0, core.numberValue(link.quantity) - core.numberValue(link.quantityCancelled)), 0), cancelled = links.reduce((sum, link) => sum + core.numberValue(link.quantityCancelled), 0); return `<article class="dossier-record"><div><strong>${escapeHtml(order.id)} · ${escapeHtml(order.supplierName || 'Proveedor por confirmar')}</strong><small>${escapeHtml(supplierOrderStatusLabel(order.status))} · ${escapeHtml(order.currency || data.currency)} · ${assigned} unidades vigentes${cancelled ? ` · ${cancelled} canceladas con autorización` : ''}</small></div><span>${dossierMoney(order.total, order.currency || data.currency)}</span></article>`; }).join('') || '<p class="subtitle">Aún no hay OC a proveedor. La requisición conserva las cantidades pendientes de compra.</p>'}</section>`,
      receipts: `<section class="dossier-section"><h3>Recepciones y factura de proveedor</h3>${data.receipts.map(receipt => `<article class="dossier-record"><div><strong>${escapeHtml(receipt.id)} · ${receiptTypeLabel(receipt)}</strong><small>Almacén ${escapeHtml(receipt.warehouseId || '1')} · ${escapeHtml(receiptDocumentTypeLabel(receipt.documentType))} · ${escapeHtml(receipt.reference || receipt.supplierRemission || 'Sin referencia')}</small><small><b>${escapeHtml(inventoryStateLabel(receipt.qualityStatus || 'released'))}</b></small><small>${(receipt.items || []).map(item => `Aceptadas ${item.quantityAccepted ?? item.quantity}, rechazadas ${item.quantityRejected || 0}${item.lot ? ` · Lote ${item.lot}` : ''}${item.serial ? ` · Serie ${item.serial}` : ''}${item.expiryDate ? ` · Cad. ${item.expiryDate}` : ''}`).join('')}</small>${receipt.shortage ? `<small><b>Faltante: ${receipt.shortage.quantity} uds. · ${receipt.shortage.status === 'cancelled' ? 'Saldo cancelado con autorización' : 'Seguimiento pendiente'}</b>${receipt.shortage.notes ? ` · ${escapeHtml(receipt.shortage.notes)}` : ''}</small>` : ''}</div><span>${receipt.evidence?.length || 0} evidencia(s)</span></article>`).join('') || '<p class="subtitle">No hay recepciones registradas.</p>'}<div class="dossier-subsection"><strong>Facturas de proveedor</strong>${data.supplierInvoices.map(invoice => `<article class="dossier-record compact"><div><strong>${escapeHtml(invoice.folio || invoice.id)}</strong><small>${escapeHtml(invoice.supplierName || 'Proveedor')} · ${escapeHtml(invoice.currency || 'MXN')} · ${dossierDate(invoice.date)}</small></div><span>${dossierMoney(invoice.amountOriginal ?? invoice.amount, invoice.currency || 'MXN')}</span></article>`).join('') || '<small>Factura pendiente o sin relación registrada. La recepción física puede existir sin factura.</small>'}</div></section>`,
      inventory: `<section class="dossier-section"><h3>Almacén, reservas y movimientos</h3>${data.movements.map(movement => `<article class="dossier-record"><div><strong>${movementTypeLabel(movement.type)} ${escapeHtml(inventoryMovementDisplayFolio(movement))}</strong><small>Almacén ${escapeHtml(movement.warehouseId || '1')} · ${escapeHtml(movementReasonLabel(movement.reason))} · ${escapeHtml(movement.sourceDocumentId || 'Sin documento')}</small>${movement.type === 'entry' ? `<small><b>${escapeHtml(inventoryStateLabel(movement.inventoryState || 'available'))}</b></small>` : ''}</div><span>${movement.type === 'entry' ? '+' : '−'}${movement.quantity} uds.</span></article>`).join('') || '<p class="subtitle">Sin movimientos de almacén todavía.</p>'}<div class="dossier-subsection"><strong>Reservas vigentes</strong>${store.inventoryReservations.filter(item => item.requisitionId === request.id).map(reservation => `<small>Almacén ${escapeHtml(reservation.warehouseId)} · ${reservation.quantity - core.numberValue(reservation.quantityConsumed)} uds. · ${escapeHtml(reservationStatusLabel(reservation.status))}</small>`).join('<br>') || '<small>Sin reservas activas.</small>'}</div></section>`,
      deliveries: `<section class="dossier-section"><h3>Entregas, remisiones y facturación</h3>${data.shipments.map(shipment => `<article class="dossier-record"><div><strong>${escapeHtml(shipment.folio || shipment.id)}</strong><small>${shipmentTypeLabel(shipment)} · ${shipmentDateLabel(shipment)} · ${escapeHtml(shipment.observations || 'Sin observaciones')}</small></div><span>${(shipment.items || []).reduce((sum, item) => sum + core.numberValue(item.quantity), 0)} uds.</span></article>`).join('') || '<p class="subtitle">No hay remisiones o entregas registradas.</p>'}<div class="dossier-subsection"><strong>Facturación al cliente</strong>${data.customerInvoices.map(invoice => `<article class="dossier-record compact"><div><strong>${escapeHtml(invoice.folio || invoice.accountReference || invoice.id)}</strong><small>${invoice.type === 'account_charge' ? 'Cargo a manejo de cuenta' : 'Factura al cliente'} · ${dossierDate(invoice.date)}</small></div><span>${dossierMoney(invoice.amount, invoice.currency || data.currency)}</span></article>`).join('') || '<small>Factura pendiente.</small>'}</div></section>`,
      documents: `<section class="dossier-section"><h3>Documentos y evidencias</h3><div class="flow-document-actions">${documents || '<small>No hay documentos emitidos todavía.</small>'}</div><div class="dossier-subsection"><strong>Evidencias de recepción</strong>${data.receipts.flatMap(receipt => (receipt.evidence || []).map(evidence => `<article class="dossier-record compact"><div><strong>${escapeHtml(evidence.name || 'Archivo')}</strong><small>${escapeHtml(receipt.id)} · SHA-256 ${escapeHtml((evidence.hash || 'pendiente').slice(0, 18))}</small></div><span>${escapeHtml(evidence.type || 'Archivo')}</span></article>`)).join('') || '<small>Sin evidencias adjuntas.</small>'}</div><div class="dossier-subsection"><strong>Evidencias de entrega y acuses del cliente</strong>${data.shipments.flatMap(shipment => (shipment.evidence || []).map(evidence => `<article class="dossier-record compact"><div><strong>${escapeHtml(evidence.name || 'Acuse de entrega')}</strong><small>${escapeHtml(shipment.folio || shipment.id)} · Recibió: ${escapeHtml(shipment.recipient || 'No especificado')} · SHA-256 ${escapeHtml((evidence.hash || 'pendiente').slice(0, 18))}</small></div><div><span>${escapeHtml(evidence.type || 'Archivo')}</span>${evidence.id?`<button type="button" class="order-line-action" data-dossier-evidence-owner="${escapeHtml(shipment.id)}" data-dossier-evidence-id="${escapeHtml(evidence.id)}">Previsualizar</button>`:''}</div></article>`)).join('') || '<small>Sin evidencias de entrega adjuntas.</small>'}</div></section>`,
      timeline: `<section class="dossier-section"><h3>Línea de tiempo auditable</h3><div class="dossier-timeline">${timelineEntries.map(entry => `<article><time>${dossierDate(entry.at)}</time><div><strong>${escapeHtml(auditActionLabel(entry.action))}</strong><small>${escapeHtml(entry.user || 'Sistema')} · ${escapeHtml(entry.reference || 'Sin documento relacionado')}</small>${entry.notes ? `<p>${escapeHtml(entry.notes)}</p>` : ''}${entry.nextAction ? `<p>Próxima acción: ${escapeHtml(entry.nextAction)}${entry.commitmentDate ? ` · ${escapeHtml(dossierDate(entry.commitmentDate))}` : ''}</p>` : ''}</div></article>`).join('') || '<p class="subtitle">Sin eventos en la bitácora.</p>'}</div></section>`
    };
    q('#orderDetailTitle').textContent = `${request.id} · ${request.customerName || 'Abastecimiento de stock'}`;
    const dossierTotal = data.currency === 'MULTI' ? 'Multidivisa' : dossierMoney(total, data.currency);
    q('#orderDetailBody').innerHTML = `<section class="dossier-hero"><div><p class="eyebrow">EXPEDIENTE BIO</p><h3>${escapeHtml(request.customerName || 'Abastecimiento interno')}</h3><small>${escapeHtml(request.responsible || 'Sin responsable')} · creado ${formatDate(request.requestDate)}</small></div><div class="dossier-hero-state"><b class="order-status-badge ${requestStatusClass(request.status)}">${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</b><strong>${dossierTotal}</strong><small>${data.currency === 'MULTI' ? 'Importes con IVA en la pestaña Comercial' : `Total con IVA · ${escapeHtml(data.currency)}`}</small></div></section>${alerts.length ? `<div class="dossier-alerts">${alerts.map(alert => `<span><i data-lucide="triangle-alert"></i>${escapeHtml(alert)}</span>`).join('')}</div>` : ''}<section class="dossier-kpis"><article><span>AVANCE</span><strong>${data.percent}%</strong><small>${data.progress.delivered} de ${data.authorized} ${data.authorized === 1 ? 'entregada' : 'entregadas'}</small></article><article><span>FECHA COMPROMISO</span><strong>${escapeHtml(data.committed ? dossierDate(data.committed) : 'Por definir')}</strong><small>${data.late ? 'Con atraso' : 'Sin alerta de atraso'}</small></article><article><span>PRÓXIMA ACCIÓN</span><strong>${escapeHtml(nextAction)}</strong><small>${escapeHtml(data.latest?.user || request.responsible || 'Sin responsable')}</small></article><article><span>CIERRE</span><strong>${data.progress.delivered >= data.authorized ? 'Logístico listo' : 'En proceso'}</strong><small>${data.customerInvoices.length ? 'Administrativo en revisión' : 'Factura pendiente'}</small></article></section><nav class="dossier-tabs" aria-label="Secciones del expediente">${dossierTab('summary','Resumen',data.lines.length,activeDossierTab)}${dossierTab('commercial','Comercial',quote || clientOrder ? 1 : 0,activeDossierTab)}${dossierTab('purchases','Compras',data.supplierOrders.length,activeDossierTab)}${dossierTab('receipts','Recepciones',data.receipts.length,activeDossierTab)}${dossierTab('inventory','Almacén',data.movements.length,activeDossierTab)}${dossierTab('deliveries','Entregas',data.shipments.length,activeDossierTab)}${dossierTab('documents','Documentos',documents ? documents.split('data-flow-document').length - 1 : 0,activeDossierTab)}${dossierTab('timeline','Línea de tiempo',timelineEntries.length,activeDossierTab)}</nav>${tabContent[activeDossierTab] || tabContent.summary}`;
    if (operationNotice) {
      q('#orderDetailBody').insertAdjacentHTML('afterbegin', `<div class="dossier-operation-notice ${operationNotice.warning ? 'warning' : ''}" role="status"><i data-lucide="${operationNotice.warning ? 'triangle-alert' : 'circle-check'}"></i><div><strong>${escapeHtml(operationNotice.warning ? 'Operación registrada con atención requerida' : `${operationNotice.label} procesada correctamente`)}</strong><span>${escapeHtml(operationNotice.detail || `La operación quedó registrada en la bitácora.${operationNotice.reference ? ` Referencia: ${operationNotice.reference}.` : ''}`)}</span></div>${operationNotice.reference ? `<b>${escapeHtml(operationNotice.reference)}</b>` : ''}</div>`);
      processedOperationNotice = null;
    }
    q('#orderDetailDialog').showModal(); window.lucide?.createIcons();
  }
  function renderSellerOrderTrace(clientOrderId) {
    const current = window.BioAccess?.currentUser?.() || actor;
    const commercialOrder = commercialOrders().find(order => String(order.id) === String(clientOrderId));
    const belongsToSeller = current.role !== 'seller' || String(commercialOrder?.ownerId || '') === String(current.id || '') || (!commercialOrder?.ownerId && [commercialOrder?.ownerName, commercialOrder?.seller, commercialOrder?.createdBy].some(value => String(value || '').trim().toLowerCase() === String(current.name || '').trim().toLowerCase()));
    if (!commercialOrder || !belongsToSeller) { notify('No tienes acceso a la trazabilidad de este pedido interno.'); return; }
    const request = resolveOperationalRequest(clientOrderId);
    if (!request) { notify('El pedido todavía no tiene trazabilidad operativa disponible.'); return; }
    const data = dossierData(request);
    const lineTrace = data.lines.map(line => {
      const requested = core.numberValue(line.quantityRequested), cancelled = core.numberValue(line.quantityCancelled), supply = lineSupply(line), purchased = supply.purchased, received = supply.received, delivered = core.numberValue(line.quantityDelivered), pending = Math.max(0, requested - cancelled - delivered), percent = requested > 0 ? Math.min(100, Math.round(delivered / Math.max(1, requested - cancelled) * 100)) : 0;
      return `<article class="dossier-line seller-order-trace-line"><div><strong>${escapeHtml(line.catalog || 'S/C')} · ${escapeHtml(line.description || 'Artículo')}</strong><small>${escapeHtml(line.brandName || 'Sin marca')} · ${escapeHtml(core.STATUS_LABELS[line.status] || line.status || 'En proceso')}</small><div class="order-line-progress"><i style="width:${percent}%"></i></div></div><span>Sol.<b>${requested}</b></span><span>Comp.<b>${purchased}</b></span><span>Rec.<b>${received}</b></span><span>Ent.<b>${delivered}</b></span><span>Pend.<b>${pending}</b></span></article>`;
    }).join('') || '<p class="subtitle">Sin partidas vinculadas.</p>';
    const receipts = data.receipts.map(receipt => `<article class="dossier-record compact"><div><strong>${escapeHtml(receiptTypeLabel(receipt))}</strong><small>Almacén ${escapeHtml(receipt.warehouseId || '—')} · ${escapeHtml(receipt.reference || receipt.supplierRemission || receipt.id)}</small></div><span>${(receipt.items || []).reduce((total, item) => total + core.numberValue(item.quantityAccepted ?? item.quantity), 0)} uds.</span></article>`).join('') || '<small>Sin recepciones registradas.</small>';
    const shipments = data.shipments.map(shipment => `<article class="dossier-record compact"><div><strong>${escapeHtml(shipment.folio || shipment.id)}</strong><small>${shipmentTypeLabel(shipment)} · ${shipmentDateLabel(shipment)}</small></div><span>${(shipment.items || []).reduce((total, item) => total + core.numberValue(item.quantity), 0)} uds.</span></article>`).join('') || '<small>Sin remisiones registradas.</small>';
    const timeline = data.audits.slice(0, 8).map(entry => `<article><time>${dossierDate(entry.at)}</time><div><strong>${escapeHtml(auditActionLabel(entry.action))}</strong><small>${escapeHtml(entry.reference || 'Actualización operativa')}</small></div></article>`).join('') || '<p class="subtitle">Aún no hay eventos operativos registrados.</p>';
    activeRequestId = request.id; activeDossierTab = 'summary'; q('#downloadOrderAudit').hidden = false;
    q('#orderDetailTitle').textContent = `${commercialOrder.id} · Trazabilidad`;
    q('#orderDetailBody').innerHTML = `<section class="dossier-hero seller-order-trace-hero"><div><p class="eyebrow">SEGUIMIENTO DE PEDIDO</p><h3>${escapeHtml(commercialOrder.client || request.customerName || 'Cliente')}</h3><small>Vista de solo lectura. No muestra costos, precios de compra ni acciones operativas.</small></div><div class="dossier-hero-state"><b class="order-status-badge ${requestStatusClass(request.status)}">${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</b><strong>${data.percent}%</strong><small>entregado</small></div></section><section class="dossier-kpis"><article><span>PARTIDAS</span><strong>${data.lines.length}</strong><small>Del pedido interno</small></article><article><span>RECIBIDO</span><strong>${data.progress.received}</strong><small>Unidades en recepción</small></article><article><span>ENTREGADO</span><strong>${data.progress.delivered}</strong><small>Unidades al cliente</small></article><article><span>PENDIENTE</span><strong>${Math.max(0, data.authorized - data.progress.delivered)}</strong><small>Unidades por entregar</small></article></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">AVANCE POR PRODUCTO</p><h3>Partidas del pedido</h3></div><b class="dossier-progress">${data.percent}%</b></div><div class="dossier-progress-track"><i style="width:${data.percent}%"></i></div><div class="dossier-line-list">${lineTrace}</div></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">RECEPCIONES</p><h3>Entrada a almacén</h3></div></div><div class="dossier-line-list">${receipts}</div></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">REMISIONES</p><h3>Entrega al cliente</h3></div></div><div class="dossier-line-list">${shipments}</div></section><section class="dossier-section"><h3>Últimos eventos</h3><div class="dossier-timeline">${timeline}</div></section>`;
    q('#orderDetailDialog').showModal(); window.lucide?.createIcons();
  }
  function renderClientDossier(client) {
    const profile = client?.client || {}, clientName = String(client?.clientName || profile.name || '').trim();
    const requests = store.requisitions.filter(request => clientName && searchKey(request.customerName) === searchKey(clientName)).sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')));
    activeRequestId = null; activeDossierTab = 'summary'; q('#downloadOrderAudit').hidden = true;
    const records = requests.map(request => {
      const data = dossierData(request), commercial = commercialOrders().find(order => order.id === request.clientOrderId || order.id === request.id), financial = commercial && window.BioCommercialMoney?.snapshot(commercial, quotations()), amount = financial?.total ?? data.lines.reduce((sum, line) => sum + core.numberValue(line.total), 0);
      const nextAction = data.latest?.nextAction || (data.progress.delivered < data.authorized ? 'Completar surtido y registrar entrega' : 'Validar cierre administrativo');
      return `<article class="dossier-record"><div><strong>${escapeHtml(request.id)} · ${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</strong><small>${escapeHtml(request.customerReference || request.clientOrderId || request.quotationId || 'Sin referencia comercial')} · ${data.percent}% completado · ${escapeHtml(nextAction)}</small></div><span>${dossierMoney(amount, data.currency)}</span><button type="button" class="order-line-action" data-client-dossier-order="${escapeHtml(request.id)}">Abrir</button></article>`;
    }).join('');
    const active = requests.filter(request => !['closed', 'cancelled'].includes(request.status)).length;
    q('#orderDetailTitle').textContent = `Expediente · ${clientName}`;
    const details = [['NÚMERO DE CLIENTE', profile.internalNumber || '—'], ['CONTACTO', profile.contact || '—'], ['TELÉFONO', profile.phone || '—'], ['CORREO', profile.email || '—'], ['POBLACIÓN / DIRECCIÓN', profile.location || profile.address || '—'], ['RFC', profile.rfc || '—']];
    q('#orderDetailBody').innerHTML = `<section class="dossier-hero"><div><p class="eyebrow">EXPEDIENTE DEL CLIENTE</p><h3>${escapeHtml(clientName)}</h3><small>${escapeHtml(window.BioClientReadiness?.issue(profile,window.BioAccess?.getState?.().users||[])||'Cliente activo para cotizar.')}</small>${window.canManageClient?.(profile)?`<button type="button" class="order-line-action" data-client-profile-edit="${escapeHtml(profile.id)}">Editar datos</button>`:''}${['administrator','developer','supervisor'].includes(actor.role)?`<button type="button" class="order-line-action" data-client-profile-assign="${escapeHtml(profile.id)}">Asignar vendedor</button>`:''}</div><div class="dossier-hero-state"><strong>${requests.length}</strong><small>${requests.length === 1 ? 'operación' : 'operaciones'} vinculada${requests.length === 1 ? '' : 's'}</small></div></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">DATOS DEL CLIENTE</p><h3>Información comercial</h3></div></div><div class="dossier-grid">${details.map(([label,value])=>`<article><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join('')}</div></section><section class="dossier-kpis"><article><span>OPERACIONES ABIERTAS</span><strong>${active}</strong><small>Con seguimiento operativo</small></article><article><span>OPERACIONES CERRADAS</span><strong>${requests.filter(request => request.status === 'closed').length}</strong><small>Con cadena documental finalizada</small></article><article><span>ÚLTIMA ACTIVIDAD</span><strong>${escapeHtml(requests.length ? dossierDate(requests[0]?.updatedAt || requests[0]?.createdAt) : 'Sin operaciones')}</strong><small>${escapeHtml(requests[0]?.responsible || 'Sin responsable')}</small></article></section><section class="dossier-section"><div class="dossier-section-head"><div><p class="eyebrow">OPERACIONES DEL CLIENTE</p><h3>Expedientes relacionados</h3></div><small>Selecciona una operación para ver Comercial, Compras, Recepciones, Almacén, Entregas, Documentos y Línea de tiempo.</small></div><div class="dossier-line-list">${records || '<p class="subtitle">Este cliente aún no tiene operaciones vinculadas.</p>'}</div></section>`;
    q('#orderDetailDialog').showModal(); window.lucide?.createIcons();
  }

  q('#backToClientOrders').addEventListener('click', () => document.querySelector('[data-view="salesOrdersView"]')?.click());
  window.BioOrders = { ...(window.BioOrders || {}), openSellerOrderTrace: renderSellerOrderTrace, openTrackingWorkbench, openDeliveryWorkbench };
  q('#orderTrackingList').addEventListener('click', event => { const button = event.target.closest('[data-order-detail]'), row = event.target.closest('[data-tracking-select]'), statusBadge = event.target.closest('.order-status-badge'); if (button) { renderOrderDetail(button.dataset.orderDetail); return; } if (row) { trackingSelectedRequestId = row.dataset.trackingSelect; renderOrderDashboard(); return; } if (statusBadge) { const label = statusBadge.textContent.trim(), match = Object.entries(core.STATUS_LABELS).find(([, shown]) => shown === label)?.[0]; if (match) { q('#orderStatusFilter').value = match; renderOrderDashboard(); } } });
  q('#orderTrackingPagination').addEventListener('click', event => { const button = event.target.closest('[data-tracking-page]'); if (!button || button.disabled) return; trackingPage = Number(button.dataset.trackingPage); renderOrderDashboard(); });
  q('#orderTrackingPageSize').addEventListener('change', event => { trackingPageSize = Number(event.target.value) || 25; trackingPage = 1; renderOrderDashboard(); });
  q('#orderTrackingQuickPanel').addEventListener('click', event => { const detail = event.target.closest('[data-order-detail]'), receipt = event.target.closest('[data-tracking-formal-total-receipt]'), delivery = event.target.closest('[data-tracking-formal-total-delivery]'), workbench = event.target.closest('[data-open-delivery-workbench]'); if (detail) return renderOrderDetail(detail.dataset.orderDetail); if (receipt) return openQuickReceipt(receipt.dataset.trackingFormalTotalReceipt); if (delivery) return openTotalDeliveryProgress(delivery.dataset.trackingFormalTotalDelivery); if (workbench) return openDeliveryWorkbench(workbench.dataset.openDeliveryWorkbench); });
  q('#deliverySearch').addEventListener('input', () => { deliveryPage = 1; renderDeliveries(); });
  q('#deliveryStatusFilter').addEventListener('change', () => { deliveryPage = 1; renderDeliveries(); });
  q('#deliveryPageSize').addEventListener('change', event => { deliveryPageSize = Number(event.target.value) || 25; deliveryPage = 1; renderDeliveries(); });
  q('#deliveryPagination').addEventListener('click', event => { const button = event.target.closest('[data-delivery-page]'); if (!button || button.disabled) return; deliveryPage = Number(button.dataset.deliveryPage); renderDeliveries(); });
  q('#deliveryTrackingList').addEventListener('click', event => { const detail = event.target.closest('[data-order-detail]'), documentButton = event.target.closest('[data-delivery-document]'), row = event.target.closest('[data-delivery-select]'); if (detail) return renderOrderDetail(detail.dataset.orderDetail); if (documentButton) return downloadShipmentDocument(documentButton.dataset.deliveryDocument, true); if (row) { deliverySelectedRequestId = row.dataset.deliverySelect; renderDeliveries(); } });
  q('#deliveryQuickPanel').addEventListener('click', event => { const detail = event.target.closest('[data-order-detail]'), documentButton = event.target.closest('[data-delivery-document]'), delivery = event.target.closest('[data-delivery-formal-total]'), supply = event.target.closest('[data-open-supply-resolution]'), workbench = event.target.closest('[data-open-tracking-workbench]'); if (detail) return renderOrderDetail(detail.dataset.orderDetail); if (documentButton) return downloadShipmentDocument(documentButton.dataset.deliveryDocument, true); if (delivery) { activeRequestId = delivery.dataset.deliveryFormalTotal; activeDossierTab = 'summary'; return openTotalDeliveryProgress(delivery.dataset.deliveryFormalTotal); } if (supply) { q('[data-view="supplierOrdersView"]')?.click(); return; } if (workbench) return openTrackingWorkbench(workbench.dataset.openTrackingWorkbench); });
  const rememberProgressOrigin = (requestId = activeRequestId, tab = activeDossierTab) => {
    const dialog = q('#orderProgressDialog');
    if (!dialog || !requestId) return;
    dialog.dataset.originRequestId = requestId;
    dialog.dataset.originTab = tab || 'summary';
  };
  const restoreProgressOrigin = () => {
    const dialog = q('#orderProgressDialog'), requestId = dialog?.dataset.originRequestId || activeRequestId, tab = dialog?.dataset.originTab || activeDossierTab || 'summary';
    dialog?.close();
    if (!requestId || !store.requisitions.some(request => String(request.id) === String(requestId))) return;
    activeRequestId = requestId; activeDossierTab = tab;
    window.setTimeout(() => renderOrderDetail(requestId, tab), 0);
  };
  async function previewDossierEvidence(ownerId,evidenceId){const records=await window.BioMediaStore?.get?.('movementEvidence','movementId',ownerId),record=(records||[]).find(item=>String(item.id)===String(evidenceId));if(!record)return notify('La referencia del acuse existe, pero el archivo no está disponible en este equipo.');window.BioFlowDocs?.previewBlob(record.blob,{title:'EVIDENCIA DE ENTREGA',folio:record.name,filename:record.name})}
  qa('[data-close-order-dialog]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.closeOrderDialog === 'orderProgressDialog') return restoreProgressOrigin();
    q(`#${button.dataset.closeOrderDialog}`).close();
  }));
  q('#orderDetailBody').addEventListener('click', event => {
    const clientRequest = event.target.closest('[data-client-dossier-order]'), evidenceButton=event.target.closest('[data-dossier-evidence-id]'),totalReceiptButton=event.target.closest('[data-formal-total-receipt]'),totalDeliveryButton=event.target.closest('[data-formal-total-delivery]'), formalButton = event.target.closest('[data-formal-progress]'), tab = event.target.closest('[data-dossier-tab]'), button = event.target.closest('[data-order-progress]'), documentButton = event.target.closest('[data-flow-document]');
    if (clientRequest) { renderOrderDetail(clientRequest.dataset.clientDossierOrder, 'summary'); return; }
    if(evidenceButton){void previewDossierEvidence(evidenceButton.dataset.dossierEvidenceOwner,evidenceButton.dataset.dossierEvidenceId);return;}
    if(totalReceiptButton){rememberProgressOrigin();q('#orderDetailDialog').close();openTotalReceiptProgress(totalReceiptButton.dataset.formalTotalReceipt,totalReceiptButton.dataset.formalTotalRequest);return;}
    if(totalDeliveryButton){rememberProgressOrigin();q('#orderDetailDialog').close();openTotalDeliveryProgress(totalDeliveryButton.dataset.formalTotalDelivery);return;}
    if (formalButton) { rememberProgressOrigin(); q('#orderDetailDialog').close(); openFormalProgress(formalButton.dataset.orderLine, formalButton.dataset.formalProgress); return; }
    if (tab) { activeDossierTab = tab.dataset.dossierTab; renderOrderDetail(activeRequestId); return; }
    if (button) { rememberProgressOrigin(); q('#orderDetailDialog').close(); openProgress(button.dataset.orderProgress); }
    if (!documentButton) return;
    const kind = documentButton.dataset.flowDocument, id = documentButton.dataset.flowId;
    if (kind === 'supplier_order') downloadSupplierOrder(id, true);
    if (kind === 'inventory') downloadInventoryDocument(id, true);
    if (kind === 'remision') downloadShipmentDocument(id, true);
    if (kind === 'quotation') { let list = []; try { list = JSON.parse(localStorage.getItem('nexo-sales-quotations') || '[]'); } catch {} window.downloadSalesQuotationV2?.(list.find(item => item.id === id), true); }
    if (kind === 'client_order') { let list = []; try { list = JSON.parse(localStorage.getItem('nexo-commercial-orders') || '[]'); } catch {} window.downloadCommercialOrderDocument?.(list.find(item => item.id === id), true); }
  });
  q('#downloadOrderAudit').addEventListener('click', () => { void downloadOrderAudit(activeRequestId, true); });
  q('#orderProgressType').addEventListener('change', () => { toggleReceiptFields(); updateProgressTypeHint(); });
  q('#orderProgressResult').addEventListener('change', updateProgressResultHint);
  q('#orderProgressQuantity').addEventListener('input', toggleReceiptFields);
  q('#receiptRejectedQuantity').addEventListener('input', toggleReceiptFields);
  q('#receiptQualityStatus').addEventListener('change',toggleReceiptFields);
  q('#receiptShortageResolution').addEventListener('change', toggleReceiptFields);
  q('#orderProgressForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = q('#orderProgressForm'), mode = form.dataset.mode || 'tracking', type = q('#orderProgressType').value, lineId = q('#orderProgressLineId').value;
    const receiptData = { documentType: q('#receiptDocumentType').value, warehouseId: q('#receiptWarehouse').value, rejectedQuantity: Number(q('#receiptRejectedQuantity').value || 0), qualityStatus: q('#receiptQualityStatus').value, lot: q('#receiptLot').value.trim(), serial: q('#receiptSerial').value.trim(), expiryDate: q('#receiptExpiry').value || null, evidenceFiles: q('#receiptEvidence').files, shortageResolution: q('#receiptShortageResolution').value, shortageCommitment: q('#receiptShortageCommitment').value || null, shortageNotes: q('#receiptShortageNotes').value.trim() };
    const deliveryData = { recipient: q('#deliveryRecipient').value.trim(), scheduledAt: q('#deliveryScheduledAt').value || null, evidenceFiles: q('#deliveryEvidence').files };
    const action = mode === 'tracking' ? 'Guardando avance…' : mode === 'formal-total-receipt' ? 'Registrando recepción total…' : mode === 'formal-total-delivery' ? 'Generando remisión total…' : type === 'delivery' ? 'Generando remisión…' : 'Registrando operación…';
    const finish = window.BioOperationProgress?.start(action, form.querySelector('.submit'));
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (mode === 'tracking') return await recordTrackingProgress(lineId);
      if (mode === 'formal-total-receipt') return await applyTotalReceipt(form.dataset.supplierOrderId, form.dataset.totalReceiptRequestId, q('#orderProgressReference').value.trim(), q('#orderProgressNotes').value.trim(), receiptData);
      if (mode === 'formal-total-delivery') return await applyTotalDelivery(form.dataset.totalDeliveryRequestId, q('#orderProgressNotes').value.trim(), deliveryData);
      return await applyProgress(lineId, type, Number(q('#orderProgressQuantity').value), q('#orderProgressSupplier').value.trim(), q('#orderProgressReference').value.trim(), q('#orderProgressNotes').value.trim(), q('#orderProgressOverride').checked, receiptData, {}, deliveryData);
    } catch (error) {
      console.error('No fue posible registrar la operación.', error);
      notify(error?.message || 'No fue posible registrar la operación. Intenta nuevamente.');
    } finally { finish?.(); }
  });
  q('#orderCreateType').addEventListener('change', event => { const customerOrder = event.target.value === 'customer_order'; q('#orderCreateCustomer').required = customerOrder; q('#orderCreateContact').required = customerOrder; q('#orderCreateCustomer').disabled = !customerOrder; q('#orderCreateContact').disabled = !customerOrder; if (!customerOrder) { q('#orderCreateCustomer').value = ''; q('#orderCreateContact').value = ''; } });
  q('#orderCreateProductSearch').addEventListener('input', event => renderCreateProductResults(event.target.value));
  q('#orderCreateProductResults').addEventListener('click', event => { const button = event.target.closest('[data-create-order-product]'); if (!button) return; const product = catalogProducts().find(item => String(item.id) === button.dataset.createOrderProduct); if (!product) return; const existing = orderDraftLines.find(line => String(line.productId) === String(product.id)); if (existing) existing.quantityRequested += 1; else orderDraftLines.push({ productId: product.id, catalog: product.number || product.sku, brandName: product.brand || '', description: product.name, quantityRequested: 1, unitPrice: core.numberValue(product.price), taxRate: store.settings.defaultTaxRate, supplyOrigin: core.numberValue(product.a1) + core.numberValue(product.a2) > 0 ? 'inventory' : 'supplier' }); q('#orderCreateProductSearch').value = ''; renderCreateProductResults(''); renderCreateLines(); });
  q('#orderCreateLines').addEventListener('input', event => { const input = event.target.closest('.order-create-line-field'); if (!input) return; const line = orderDraftLines.find(item => String(item.productId) === input.closest('[data-create-line]').dataset.createLine); if (!line) return; line[input.dataset.field] = ['quantityRequested', 'unitPrice', 'taxRate'].includes(input.dataset.field) ? core.numberValue(input.value) : input.value; });
  q('#orderCreateLines').addEventListener('change', event => { const input = event.target.closest('.order-create-line-field'); if (!input) return; const line = orderDraftLines.find(item => String(item.productId) === input.closest('[data-create-line]').dataset.createLine); if (line) line[input.dataset.field] = ['quantityRequested', 'unitPrice', 'taxRate'].includes(input.dataset.field) ? core.numberValue(input.value) : input.value; });
  q('#orderCreateLines').addEventListener('click', event => { const button = event.target.closest('[data-remove-create-line]'); if (!button) return; orderDraftLines = orderDraftLines.filter(line => String(line.productId) !== button.dataset.removeCreateLine); renderCreateLines(); });
  q('#orderCreateForm').addEventListener('submit', event => { event.preventDefault(); createManualRequisition(); });
  q('#ordersFile').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { await analyzeOrdersFile(file); } catch (error) { importSimulation = null; q('#ordersFileStatus').textContent = error.message; renderImportSimulation(); notify(error.message); } });
  ['orderImportSearch'].forEach(id => q(`#${id}`).addEventListener('input', renderImportSimulation));
  q('#orderImportStatus').addEventListener('change', renderImportSimulation);
  q('#orderImportRows').addEventListener('click', event => { const button = event.target.closest('[data-skip-import-row]'); if (!button || !importSimulation) return; const row = importSimulation.rows.find(item => item.sourceRow === Number(button.dataset.skipImportRow)); if (!row) return; if (row.status === 'skipped') row.status = row.previousStatus || 'warning'; else { row.previousStatus = row.status; row.status = 'skipped'; } renderImportSimulation(); });
  q('#orderImportRows').addEventListener('change', event => { const input = event.target.closest('[data-import-row]'); if (!input || !importSimulation) return; const row = importSimulation.rows.find(item => item.sourceRow === Number(input.dataset.importRow)); if (!row) return; if (input.checked && row.status === 'skipped') row.status = row.previousStatus || 'warning'; if (!input.checked && ['ready', 'warning'].includes(row.status)) { row.previousStatus = row.status; row.status = 'skipped'; } renderImportSimulation(); });
  q('#confirmOrdersImport').addEventListener('click', confirmImport);
  q('#orderDetailDialog').addEventListener('cancel', event => { event.preventDefault(); q('#orderDetailDialog').close(); });
  let progressFilePickerUntil = 0;
  q('#orderProgressDialog').addEventListener('click', event => { if (event.target.matches('input[type="file"]')) progressFilePickerUntil = Date.now() + 3000; });
  q('#orderProgressDialog').addEventListener('change', event => { if (event.target.matches('input[type="file"]')) progressFilePickerUntil = 0; });
  window.addEventListener('focus', () => { if (progressFilePickerUntil) progressFilePickerUntil = Date.now() + 750; });
  q('#orderProgressDialog').addEventListener('cancel', event => { event.preventDefault(); if (Date.now() < progressFilePickerUntil) { progressFilePickerUntil = 0; return; } restoreProgressOrigin(); });

  qa('[data-view="ordersView"], [data-view="deliveriesView"], [data-view="supplierOrdersView"]').forEach(link => link.addEventListener('click', () => { syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); }));
  window.addEventListener('bio:client-order-activated', () => { syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); });
  window.addEventListener('bio:open-client-dossier', event => { syncClientOrders(); syncSupplierPurchaseOrders(); renderClientDossier(event.detail); });
  window.addEventListener('bio:access-changed', () => { actor = window.BioAccess?.currentUser() || actor; renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); });
  let workspaceStateInitialized = false;
  const initializeWorkspaceState = () => {
    if (workspaceStateInitialized) return;
    workspaceStateInitialized = true;
    store = loadStore();
    reconcileHistoricalDocumentDates(); reconcileHistoricalReceiptInventory(); reconcileHistoricalQuarantineInventory(); reconcileHistoricalAuthorizedShortages(); reconcileHistoricalPurchaseReceipts();reconcileOperationalMovementFolios();
    syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); renderImportSimulation();
  };
  const persistenceState = window.BioPersistence?.status?.();
  if (!window.BioPersistence || persistenceState?.hydrated) initializeWorkspaceState();
  else {
    renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); renderImportSimulation();
    window.addEventListener('bio:persistence-changed', event => {
      if (event.detail?.hydrated || event.detail?.error) initializeWorkspaceState();
    });
  }
})();
