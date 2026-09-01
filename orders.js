(function () {
  'use strict';
  const core = window.BioOrdersCore;
  if (!core) return;
  const q = selector => document.querySelector(selector);
  const qa = selector => [...document.querySelectorAll(selector)];
  const STORAGE_KEY = 'nexo-order-operations-v1';
  let actor = window.BioAccess?.currentUser() || { id: 'USR-001', name: 'José Velasco', role: 'administrator' };
  const can = permission => core.hasPermission(actor.role, permission);
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
  let orderDraftLines = [];
  const saveStore = nextStore => {
    const serialized = JSON.stringify(nextStore);
    try {
      localStorage.setItem(`${STORAGE_KEY}-transaction`, serialized);
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
  const notify = message => {
    if (typeof window.showToast === 'function') return window.showToast(message);
    const toast = q('#toast');
    toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3000);
  };
  const requestLines = requestId => store.orderLines.filter(line => line.requisitionId === requestId);
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
      if (!clientOrder?.id || !clientOrder?.quotationId) return;
      const createdAt = clientOrder.createdAtISO || new Date().toISOString();
      let request = next.requisitions.find(item => item.clientOrderId === clientOrder.id || (item.id === clientOrder.id && item.source === 'quotation_client_order'));
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
          const taxRate = core.numberValue(clientOrder.taxRate ?? next.settings.defaultTaxRate);
          const totals = core.calculateLineTotals({ quantity: quantityRequested, unitPrice, taxRate });
          const product = products.find(candidate => String(candidate.id) === String(item.productId)) || products.find(candidate => [candidate.number, candidate.sku].some(value => searchKey(value) === searchKey(item.number || item.sku)));
          const fulfillment = clientOrder.status === 'active' ? warehousePlan(next, product, quantityRequested, item.deliveryWarehouse || '1') : { allocations: [], reservedQuantity: 0, quantityToPurchase: quantityRequested, supplyOrigin: 'supplier' };
          const line = {
            id: `LIN-${clientOrder.id}-${String(index + 1).padStart(3, '0')}`,
            requisitionId: clientOrder.id,
            productId: item.productId ?? null,
            catalog: item.number || item.sku || null,
            brandName: item.brand || null,
            description: item.name || 'Producto sin descripción',
            quantityRequested,
            quantityPurchased: 0,
            quantityReceived: 0,
            quantityDelivered: 0,
            quantityCancelled: 0,
            quantityInvoiced: 0,
            unitPrice,
            subtotal: totals.subtotal,
            taxRate,
            taxAmount: totals.taxAmount,
            total: totals.total,
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
          fulfillment.allocations.forEach((allocation, allocationIndex) => next.inventoryReservations.push({ id: `RES-${line.id}-${allocation.warehouseId}-${allocationIndex + 1}`, requisitionId: request.id, orderLineId: line.id, productId: line.productId, warehouseId: allocation.warehouseId, quantity: allocation.quantity, quantityConsumed: 0, status: 'active', reason: 'Reserva automática al activar OC de cliente', reference: clientOrder.id, user: clientOrder.activatedBy || actor.name, at: clientOrder.activatedAtISO || new Date().toISOString() }));
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
  const activeReservationsByWarehouse = (targetStore, productId) => targetStore.inventoryReservations.filter(reservation => reservation.status === 'active' && String(reservation.productId) === String(productId)).reduce((result, reservation) => {
    const warehouseId = String(reservation.warehouseId || '1');
    result[warehouseId] = core.numberValue(result[warehouseId]) + Math.max(0, core.numberValue(reservation.quantity) - core.numberValue(reservation.quantityConsumed));
    return result;
  }, {});
  const warehousePlan = (targetStore, product, requested, preferredWarehouse) => core.planWarehouseFulfillment({
    requested,
    warehouses: { 1: core.numberValue(product?.a1), 2: core.numberValue(product?.a2) },
    reservedByWarehouse: activeReservationsByWarehouse(targetStore, product?.id),
    preferredWarehouse
  });
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
  const applyCatalogStockAdjustments = adjustments => {
    if (!adjustments.length) return true;
    const products = catalogProducts(), staged = JSON.parse(JSON.stringify(products));
    for (const adjustment of adjustments) {
      const product = staged.find(item => String(item.id) === String(adjustment.productId));
      if (!product) return false;
      const field = String(adjustment.warehouseId) === '2' ? 'a2' : 'a1', nextValue = core.numberValue(product[field]) + core.numberValue(adjustment.delta);
      if (nextValue < 0) return false;
      product[field] = nextValue;
    }
    localStorage.setItem('nexo-products', JSON.stringify(staged));
    adjustments.forEach(adjustment => window.dispatchEvent(new CustomEvent('bio:inventory-stock-changed', { detail: adjustment })));
    return true;
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

  function resolveLineSupplier(line, products = catalogProducts(), suppliers = catalogSuppliers()) {
    const product = products.find(item => String(item.id) === String(line.productId)) || products.find(item => [item.number, item.sku].some(value => searchKey(value) === searchKey(line.catalog)));
    const supplier = product && suppliers.find(item => String(item.id) === String(product.supplierId));
    return { product, supplier };
  }

  function syncSupplierPurchaseOrders() {
    const products = catalogProducts(), suppliers = catalogSuppliers(), next = JSON.parse(JSON.stringify(store));
    let changed = false;
    const eligibleRequests = next.requisitions.filter(request => (request.source === 'quotation_client_order' || request.type === 'internal_stock') && (request.type === 'internal_stock' || request.clientOrderStatus === 'active') && request.status !== 'cancelled');
    const requestIds = new Set(eligibleRequests.map(request => request.id));
    const unlinked = next.orderLines.filter(line => requestIds.has(line.requisitionId) && core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased) > 0 && !next.supplierOrderLines.some(link => link.orderLineId === line.id));
    const { groups } = core.groupSupplierPurchaseLines({ lines: unlinked, products, suppliers });
    groups.forEach(group => {
      const firstRequest = eligibleRequests.find(request => request.id === group.rows[0]?.line.requisitionId), id = supplierOrderFolio(next, firstRequest?.requestDate), at = new Date().toISOString();
      const links = group.rows.map(({ line, product }, index) => {
        const quantity = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased));
        return { id: `SOL-${id}-${String(index + 1).padStart(3, '0')}`, supplierOrderId: id, requisitionId: line.requisitionId, orderLineId: line.id, quantity, unitPrice: core.numberValue(product.price), currency: group.currency, allocationType: eligibleRequests.find(request => request.id === line.requisitionId)?.type === 'internal_stock' ? 'stock' : 'customer_order' };
      }).filter(link => link.quantity > 0);
      if (!links.length) return;
      const requisitionIds = [...new Set(links.map(link => link.requisitionId))], requests = requisitionIds.map(requestId => eligibleRequests.find(request => request.id === requestId)).filter(Boolean), subtotal = links.reduce((total, link) => total + link.quantity * link.unitPrice, 0);
      const order = { id, supplierId: group.supplier.id, supplierName: group.supplier.name, clientOrderId: requests.length === 1 ? requests[0].clientOrderId || requests[0].id : null, clientOrderIds: requests.map(request => request.clientOrderId || request.id), quotationId: requests.length === 1 ? requests[0].quotationId : null, quotationIds: [...new Set(requests.map(request => request.quotationId).filter(Boolean))], createdAt: at.slice(0, 10), confirmedAt: null, currency: group.currency, exchangeRate: null, exchangeRateDate: null, warehouseId: group.warehouse, requiredDate: group.requiredDate === 'sin-fecha' ? null : group.requiredDate, paymentTerms: group.paymentTerms, subtotal: Math.round(subtotal * 100) / 100, total: Math.round(subtotal * 100) / 100, status: 'draft', documentStage: 'purchase_proposal', version: 1, locked: false, requisitionIds, lineIds: links.map(link => link.orderLineId), autoGenerated: true, consolidated: requisitionIds.length > 1, createdBy: actor.name };
      next.supplierOrders.unshift(order); next.supplierOrderLines.push(...links);
      group.rows.forEach(({ line }) => { line.supplierId = group.supplier.id; line.supplierName = group.supplier.name; });
      next.auditLog.push({ id: `AUD-${id}`, entityType: 'supplier_order', entityId: id, action: 'purchase_proposal_generated', user: actor.name, at, before: null, after: order, reference: requisitionIds.join(', ') });
      changed = true;
    });
    return changed ? saveStore(next) : false;
  }

  function supplierOrderMissingLines() {
    const products = catalogProducts(), suppliers = catalogSuppliers();
    return store.requisitions.filter(request => request.source === 'quotation_client_order' && request.clientOrderStatus === 'active').flatMap(request => store.orderLines.filter(line => line.requisitionId === request.id && core.numberValue(line.quantityRequested)-core.numberValue(line.quantityCancelled)-core.numberValue(line.reservedQuantity)-core.numberValue(line.quantityPurchased)>0 && !store.supplierOrderLines.some(link => link.orderLineId === line.id)).map(line => ({ request, line, ...resolveLineSupplier(line, products, suppliers) }))).filter(item => !item.product || !item.supplier);
  }

  const supplierOrderMoney = (value, currency) => {
    try { return Number(value || 0).toLocaleString('es-MX', { style: 'currency', currency: currency || 'MXN' }); } catch { return `$${Number(value || 0).toFixed(2)} ${currency || 'MXN'}`; }
  };

  function renderSupplierPurchaseOrders() {
    const search = searchKey(q('#supplierOrderSearch').value), status = q('#supplierOrderStatusFilter').value;
    const missing = supplierOrderMissingLines(), suppliers = new Set(store.supplierOrders.map(order => order.supplierId || order.supplierName).filter(Boolean));
    q('#supplierOrderDraftCount').textContent = store.supplierOrders.filter(order => order.status === 'draft').length;
    q('#supplierOrderConfirmedCount').textContent = store.supplierOrders.filter(order => ['confirmed', 'partially_received', 'received'].includes(order.status)).length;
    q('#supplierOrderSupplierCount').textContent = suppliers.size;
    q('#supplierOrderMissingCount').textContent = missing.length;
    q('#supplierOrderIssues').hidden = !missing.length;
    q('#supplierOrderIssues').innerHTML = missing.length ? `<i data-lucide="circle-alert"></i><div><strong>${missing.length} artículo${missing.length === 1 ? '' : 's'} sin proveedor relacionado</strong><span>${missing.slice(0, 5).map(item => `${escapeHtml(item.line.catalog || 'Sin catálogo')} · ${escapeHtml(item.line.description)} (${escapeHtml(item.request.id)})`).join('<br>')}${missing.length > 5 ? `<br>y ${missing.length - 5} más…` : ''}</span><small>Relaciona estos productos con un proveedor desde el catálogo para que Bio genere sus OC.</small></div>` : '';
    const matches = store.supplierOrders.filter(order => {
      const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id), lines = links.map(link => store.orderLines.find(line => line.id === link.orderLineId)).filter(Boolean);
      const requests = store.requisitions.filter(item => order.requisitionIds?.includes(item.id));
      const text = [order.id, order.supplierName, order.clientOrderId, ...(order.clientOrderIds || []), order.quotationId, ...(order.quotationIds || []), ...requests.flatMap(request => [request.id, request.customerName]), ...lines.flatMap(line => [line.catalog, line.description, line.brandName])].map(searchKey).join(' ');
      return (!search || text.includes(search)) && (!status || order.status === status);
    });
    q('#supplierOrderResultCount').textContent = `${matches.length} de ${store.supplierOrders.length}`;
    q('#supplierOrderList').innerHTML = matches.map(order => {
      const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id), lines = links.map(link => ({ link, line: store.orderLines.find(line => line.id === link.orderLineId) })).filter(item => item.line);
      const statusLabel = { draft: 'Propuesta', confirmed: 'Confirmada', partially_received: 'Recepción parcial', received: 'Recibida', cancelled: 'Cancelada' }[order.status] || order.status, reconciliation = core.reconcileSupplierPurchase({ order, links: store.supplierOrderLines, receipts: store.receipts, invoices: store.supplierInvoices }), reconciliationLabel = { matched: '3 vías conciliadas', review: 'Diferencia por revisar', pending: reconciliation.invoiceStatus === 'pending_invoice' ? 'Factura pendiente' : 'Conciliación pendiente', missing_order: 'Sin OC' }[reconciliation.status] || 'Conciliación pendiente';
      const items = lines.map(({ link, line }) => { const request = store.requisitions.find(item => item.id === link.requisitionId); return `<li><b>${escapeHtml(line.catalog || 'Sin catálogo')}</b><span>${escapeHtml(line.description)}<small>${escapeHtml(link.allocationType === 'stock' ? 'Stock general' : request?.clientOrderId || request?.id || 'Sin pedido')} · asignadas ${link.quantity}</small></span><em>${link.quantity} ${escapeHtml(line.unit || 'uds.')} · ${supplierOrderMoney(link.unitPrice, link.currency)}</em></li>`; }).join('');
      const originLabel = order.requisitionIds?.length > 1 ? `${order.requisitionIds.length} pedidos consolidados` : order.clientOrderId || order.requisitionIds?.[0] || 'Stock general';
      return `<article class="supplier-order-row"><div class="supplier-order-origin"><strong>${escapeHtml(order.id)} · v${order.version || 1}</strong><small>Origen: ${escapeHtml(originLabel)}</small><small>${order.locked || order.status !== 'draft' ? 'Documento bloqueado' : 'Propuesta por autorizar'}</small></div><div><strong>${escapeHtml(order.supplierName || 'Proveedor pendiente')}</strong><small>${escapeHtml(order.currency || 'MXN')} · ${formatDate(order.createdAt)} · A${escapeHtml(order.warehouseId || '1')}</small></div><ul class="supplier-order-items">${items}</ul><div class="supplier-order-money"><strong class="supplier-order-total">${supplierOrderMoney(order.total, order.currency)}</strong><small class="reconciliation-state ${reconciliation.status}">${escapeHtml(reconciliationLabel)}</small></div><span class="order-status-badge ${order.status === 'draft' ? 'warning' : 'active'}">${escapeHtml(statusLabel)}</span><div class="supplier-order-actions">${order.status === 'draft' ? `<button data-confirm-supplier-order="${escapeHtml(order.id)}"><i data-lucide="shield-check"></i>Autorizar y emitir</button>` : ''}<button data-download-supplier-order="${escapeHtml(order.id)}"><i data-lucide="download"></i>PDF</button></div></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="shopping-bag"></i><strong>No hay OC a proveedor para este filtro</strong><span>Al activar una OC de cliente, Bio preparará las órdenes según el proveedor de cada artículo.</span></div>';
    window.lucide?.createIcons();
  }

  function confirmSupplierOrder(orderId) {
    if (!can('purchase')) return notify('Tu perfil no permite confirmar órdenes a proveedor.');
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
    const summaryItems = links.map(link => { const line = store.orderLines.find(item => item.id === link.orderLineId); return { name: `${line?.catalog || 'Sin catálogo'} · ${line?.description || 'Artículo'}`, detail: `${link.quantity} unidades · ${order.supplierName}`, value: supplierOrderMoney(link.quantity * link.unitPrice, link.currency), delta: link.quantity }; });
    if (typeof window.showActionConfirmation === 'function') window.showActionConfirmation({ kicker: 'AUTORIZAR PROPUESTA CONSOLIDADA', title: `¿Emitir ${order.id}?`, text: `La versión ${order.version || 1} quedará bloqueada. Sus ${order.requisitionIds.length} pedido${order.requisitionIds.length === 1 ? '' : 's'} conservarán la asignación original por partida.`, summaryTitle: 'ARTÍCULOS Y ASIGNACIONES', items: summaryItems, confirmLabel: 'Autorizar y emitir OC', onConfirm: proceed });
    else if (confirm(`¿Confirmar ${order.id}?`)) proceed();
  }

  function downloadSupplierOrder(orderId, preview = false) {
    const order = store.supplierOrders.find(item => item.id === orderId), PDF = window.jspdf?.jsPDF;
    if (!order || !PDF) return notify('No fue posible generar el PDF de la orden.');
    const links = store.supplierOrderLines.filter(link => link.supplierOrderId === order.id);
    if (window.BioFlowDocs) return window.BioFlowDocs[preview ? 'preview' : 'download']('supplier_order', { id: order.id, date: order.confirmedAt || order.createdAt, status: `${order.status} · v${order.version || 1}${order.locked ? ' · BLOQUEADA' : ''}`, supplier: order.supplierName, client: (order.clientOrderIds || [order.clientOrderId]).filter(Boolean).join(', ') || 'Stock general', currency: order.currency, reference: `Cotizaciones ${(order.quotationIds || [order.quotationId]).filter(Boolean).join(', ') || 'sin vínculo'}`, related: `Pedidos ${(order.requisitionIds || []).join(', ')}`, items: links.map(link => { const line = store.orderLines.find(item => item.id === link.orderLineId), request = store.requisitions.find(item => item.id === link.requisitionId); return { catalog: line?.catalog, description: `${line?.description || 'Artículo'} · Asignación: ${link.allocationType === 'stock' ? 'Stock general' : request?.clientOrderId || request?.id}`, quantity: link.quantity, unitPrice: link.unitPrice, total: link.quantity * link.unitPrice }; }), subtotal: order.subtotal, total: order.total, auditId: `AUD-${order.id}`, notes: `OC consolidada por proveedor, moneda, destino y fecha requerida. ${links.length} asignaciones preservan la huella de cada pedido.` }, { filename: `${order.id}.pdf` });
    const doc = new PDF({ unit: 'mm', format: 'a4' });
    doc.setFillColor(23, 34, 29); doc.rect(0, 0, 210, 44, 'F'); doc.setFillColor(185, 250, 129); doc.roundedRect(16, 13, 16, 16, 3, 3, 'F');
    doc.setTextColor(18, 30, 23); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('N', 24, 23.7, { align: 'center' });
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.text('NEXO', 38, 20); doc.setFontSize(11); doc.text('ORDEN DE COMPRA A PROVEEDOR', 194, 20, { align: 'right' });
    doc.setTextColor(164, 179, 168); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(`Estado: ${order.status === 'draft' ? 'BORRADOR' : 'CONFIRMADA'}`, 194, 27, { align: 'right' });
    const field = (label, value, x, y) => { doc.setTextColor(125, 137, 128); doc.setFontSize(7); doc.text(label, x, y); doc.setTextColor(30, 43, 34); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(String(value || '—'), x, y + 6); doc.setFont('helvetica', 'normal'); };
    field('FOLIO', order.id, 17, 57); field('FECHA', order.createdAt, 78, 57); field('MONEDA', order.currency, 136, 57); field('PROVEEDOR', order.supplierName, 17, 78); field('OC DEL CLIENTE', order.clientOrderId, 17, 99); field('COTIZACION ORIGEN', order.quotationId, 108, 99);
    let y = 122; doc.setFillColor(239, 243, 238); doc.rect(16, y - 7, 178, 9, 'F'); doc.setTextColor(82, 96, 87); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('CATALOGO / ARTICULO', 19, y - 1); doc.text('CANT.', 139, y - 1); doc.text('P. UNIT.', 158, y - 1); doc.text('IMPORTE', 190, y - 1, { align: 'right' });
    y += 8; links.forEach(link => { const line = store.orderLines.find(item => item.id === link.orderLineId); if (y > 265) { doc.addPage(); y = 25; } doc.setTextColor(32, 45, 36); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(String(line?.catalog || '—'), 19, y); doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(String(line?.description || 'Artículo'), 90), 45, y); doc.text(String(link.quantity), 143, y, { align: 'right' }); doc.text(Number(link.unitPrice || 0).toFixed(2), 171, y, { align: 'right' }); doc.text((link.quantity * link.unitPrice).toFixed(2), 190, y, { align: 'right' }); y += 12; });
    doc.setDrawColor(220, 226, 219); doc.line(126, y, 194, y); doc.setTextColor(26, 39, 31); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`TOTAL ${order.currency}: ${Number(order.total || 0).toFixed(2)}`, 194, y + 9, { align: 'right' });
    doc.setTextColor(125, 138, 129); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(`Trazabilidad: ${order.quotationId} -> ${order.clientOrderId} -> ${order.id}`, 17, 283); doc.save(`${order.id}.pdf`);
  }

  function downloadInventoryDocument(movementId, preview = false) {
    const movement = store.inventoryMovements.find(item => item.id === movementId), line = movement && store.orderLines.find(item => item.id === movement.orderLineId), request = line && store.requisitions.find(item => item.id === line.requisitionId);
    if (!movement || !line || !window.BioFlowDocs) return notify('No fue posible generar el comprobante de almacén.');
    const kind = movement.type === 'entry' ? 'inventory_entry' : 'inventory_exit';
    return window.BioFlowDocs[preview ? 'preview' : 'download'](kind, { id: movement.id, date: formatDate(movement.at), status: 'Registrado', client: request?.customerName, warehouse: `Almacen ${movement.warehouseId}`, origin: movement.reason, reference: `${movement.sourceDocumentType}: ${movement.sourceDocumentId}`, related: request?.id, items: [{ catalog: line.catalog, description: line.description, quantity: movement.quantity }], auditId: `${movement.user} - ${movement.reconciliationStatus}`, notes: `${movement.reason}. Usuario: ${movement.user}.` }, { filename: `${kind === 'inventory_entry' ? 'entrada' : 'salida'}-${movement.id}.pdf` });
  }

  function downloadShipmentDocument(shipmentId, preview = false) {
    const shipment = store.shipments.find(item => item.id === shipmentId), request = shipment && store.requisitions.find(item => item.id === shipment.requisitionId);
    if (!shipment || !request || !window.BioFlowDocs) return notify('No fue posible generar la remisión.');
    return window.BioFlowDocs[preview ? 'preview' : 'download']('remision', { id: shipment.folio || shipment.id, date: formatDate(shipment.deliveredAt || shipment.date), status: shipment.type === 'total' ? 'Entrega total' : 'Entrega parcial', client: request.customerName, origin: 'Almacen 1', reference: request.clientOrderId || request.id, related: `${request.quotationId || ''} - ${request.id}`, items: shipment.items.map(item => { const line = store.orderLines.find(candidate => candidate.id === item.orderLineId); return { catalog: line?.catalog, description: line?.description, quantity: item.quantity }; }), auditId: shipment.id, notes: shipment.observations || 'Entrega registrada con salida de inventario.' }, { filename: `remision-${shipment.folio || shipment.id}.pdf` });
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
    if (!orderDraftLines.length) return notify('Agrega al menos una partida.');
    if (orderDraftLines.some(line => core.numberValue(line.quantityRequested) <= 0)) return notify('Todas las partidas requieren una cantidad mayor que cero.');
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
    const lines = requestLines(request.id), requested = sum(lines, 'quantityRequested') - sum(lines, 'quantityCancelled');
    const reserved = Math.min(requested, sum(lines, 'reservedQuantity')), purchaseRequired = Math.max(0, requested - reserved);
    const purchased = Math.min(purchaseRequired, sum(lines, 'quantityPurchased'));
    const received = Math.min(purchaseRequired, sum(lines, 'quantityReceived')), availableReceived = Math.min(purchaseRequired, lines.reduce((total,line)=>total+core.numberValue(line.quantityAvailableReceived==null?line.quantityReceived:line.quantityAvailableReceived),0)), available = Math.min(requested, reserved + availableReceived);
    const delivered = Math.min(requested, sum(lines, 'quantityDelivered'));
    const invoiced = Math.min(requested, sum(lines, 'quantityInvoiced'));
    const percent = value => requested > 0 ? Math.round(value / requested * 100) : 0, purchasePercent = purchaseRequired > 0 ? Math.round(purchased / purchaseRequired * 100) : 100, receivePercent = purchaseRequired > 0 ? Math.round(received / purchaseRequired * 100) : 100;
    return { lines, requested, reserved, purchaseRequired, purchased, received, availableReceived, available, delivered, invoiced, purchasePercent, receivePercent, deliverPercent: percent(delivered), invoicePercent: percent(invoiced) };
  }

  function renderOrderDashboard() {
    populateOrderFilters();
    const states = store.requisitions.map(request => ({ request, progress: requestProgress(request) }));
    q('#trackingSummaryOpen').textContent = states.filter(({ request }) => !['closed', 'cancelled'].includes(request.status)).length;
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
    const matches = states.filter(state => stageMatches(state) && (!term || linkedText(state.request).includes(term)) && (!status || state.request.status === status) && (!responsible || state.request.responsible === responsible) && (!from || state.request.requestDate >= from) && (!to || state.request.requestDate <= to)).map(state => state.request);
    q('#orderTrackingList').innerHTML = matches.map(request => {
      const progress = requestProgress(request), overdue = request.requestDate && request.status !== 'closed' && request.status !== 'cancelled' && (Date.now() - new Date(`${request.requestDate}T12:00:00`).getTime()) > 30 * 86400000;
      const stage = (value, max, label, extra = '') => `<div class="order-stage-progress ${overdue && value < max ? 'overdue' : ''}"><strong>${value} / ${max}</strong><small>${label}${extra}</small></div>`;
      return `<article class="order-tracking-row"><div class="order-request"><strong>${escapeHtml(request.id)} · ${escapeHtml(request.customerName || 'Abastecimiento interno')}</strong><small>${formatDate(request.requestDate)} · ${escapeHtml(request.responsible || 'Sin responsable')}</small><small class="order-request-type">${request.type === 'internal_stock' ? 'STOCK INTERNO' : 'PEDIDO DE CLIENTE'}</small></div><div><div class="order-progress-bar"><i style="width:${Math.max(progress.purchasePercent, progress.receivePercent, progress.deliverPercent, progress.invoicePercent)}%"></i></div><small style="display:block;margin-top:5px;color:#879189;font-size:7px">${progress.lines.length} partida${progress.lines.length === 1 ? '' : 's'} · ${progress.requested} autorizadas · ${progress.reserved} reservadas</small></div>${stage(progress.purchased, progress.purchaseRequired, 'compradas')}${stage(progress.received, progress.purchaseRequired, 'recibidas')}${stage(progress.delivered, progress.requested, request.type === 'internal_stock' ? 'a stock' : 'entregadas')}<span class="order-status-badge ${requestStatusClass(request.status)}">${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</span><button class="order-row-action" data-order-detail="${escapeHtml(request.id)}" title="Abrir expediente"><i data-lucide="arrow-up-right"></i></button></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="route-off"></i><strong>No hay órdenes que coincidan</strong><span>Activa una OC de cliente derivada de cotización o cambia los filtros.</span></div>';
    window.lucide?.createIcons();
  }

  function renderDeliveries() {
    const requests = store.requisitions.filter(request => request.type === 'customer_order' && request.status !== 'cancelled');
    const states = requests.map(request => ({ request, progress: requestProgress(request), shipments: store.shipments.filter(item => item.requisitionId === request.id) }));
    const deliveryState = progress => progress.delivered <= 0 ? 'pending' : progress.delivered < progress.requested ? 'partial' : 'completed';
    q('#deliveryMetricPending').textContent = states.filter(({ progress }) => deliveryState(progress) === 'pending').length;
    q('#deliveryMetricPartial').textContent = states.filter(({ progress }) => deliveryState(progress) === 'partial').length;
    q('#deliveryMetricCompleted').textContent = states.filter(({ progress }) => deliveryState(progress) === 'completed').length;
    q('#deliveryMetricDocuments').textContent = store.shipments.length;
    const term = searchKey(q('#deliverySearch').value), status = q('#deliveryStatusFilter').value;
    const matches = states.filter(({ request, progress }) => (!term || linkedText(request).includes(term)) && (!status || deliveryState(progress) === status));
    q('#deliveryResultCount').textContent = `${matches.length} de ${states.length}`;
    q('#deliveryTrackingList').innerHTML = matches.map(({ request, progress, shipments }) => {
      const state = deliveryState(progress), latest = [...shipments].sort((a, b) => String(b.deliveredAt || b.date).localeCompare(String(a.deliveredAt || a.date)))[0];
      const label = state === 'completed' ? 'Entrega completa' : state === 'partial' ? 'Entrega parcial' : 'Pendiente de entrega';
      const documents = shipments.map(shipment => `<button class="delivery-document" data-delivery-document="${escapeHtml(shipment.id)}" title="Previsualizar ${escapeHtml(shipment.folio || 'remisión')}"><i data-lucide="file-text"></i>${escapeHtml(shipment.folio || 'Remisión')}</button>`).join('') || '<small class="delivery-no-document">Sin remisión</small>';
      return `<article class="delivery-tracking-row"><div class="order-request"><strong>${escapeHtml(request.clientOrderId || request.id)} · ${escapeHtml(request.customerName || 'Cliente')}</strong><small>${progress.lines.length} partida${progress.lines.length === 1 ? '' : 's'} · ${progress.requested} unidades</small></div><div class="delivery-progress"><div class="order-progress-bar"><i style="width:${progress.deliverPercent}%"></i></div><small>${progress.delivered} de ${progress.requested} entregadas</small></div><div class="delivery-latest"><strong>${escapeHtml(latest?.folio || 'Sin remisión')}</strong><small>${latest ? formatDate(latest.deliveredAt?.slice(0, 10) || latest.date) : 'Aún no emitida'}</small></div><span class="order-status-badge ${state === 'completed' ? 'active' : state === 'partial' ? 'warning' : ''}">${label}</span><div class="delivery-documents">${documents}</div><button class="order-row-action" data-order-detail="${escapeHtml(request.id)}" title="Abrir expediente"><i data-lucide="arrow-up-right"></i></button></article>`;
    }).join('') || '<div class="order-tracking-empty"><i data-lucide="package-search"></i><strong>No hay entregas que coincidan</strong><span>Cambia el filtro o activa una OC de cliente para iniciar el seguimiento.</span></div>';
    window.lucide?.createIcons();
  }

  function renderOrderDetail(requestId) {
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
    const documentActions = `<div class="flow-document-actions">${request.quotationId ? `<button data-flow-document="quotation" data-flow-id="${escapeHtml(request.quotationId)}"><i data-lucide="file-text"></i>Cotización</button>` : ''}${request.clientOrderId ? `<button data-flow-document="client_order" data-flow-id="${escapeHtml(request.clientOrderId)}"><i data-lucide="clipboard-check"></i>OC cliente</button>` : ''}${supplierOrders.map(order => `<button data-flow-document="supplier_order" data-flow-id="${escapeHtml(order.id)}"><i data-lucide="shopping-bag"></i>${escapeHtml(order.id)}</button>`).join('')}${inventoryDocuments.map(movement => `<button data-flow-document="inventory" data-flow-id="${escapeHtml(movement.id)}"><i data-lucide="${movement.type === 'entry' ? 'arrow-down-to-line' : 'arrow-up-from-line'}"></i>${movement.type === 'entry' ? 'Entrada' : 'Salida'}</button>`).join('')}${shipments.map(shipment => `<button data-flow-document="remision" data-flow-id="${escapeHtml(shipment.id)}"><i data-lucide="truck"></i>${escapeHtml(shipment.folio || 'Remisión')}</button>`).join('')}</div>`;
    const documentsHtml = `<section class="order-detail-section"><h3>Cadena documental</h3><div class="order-detail-summary"><div><span>COTIZACIÓN</span><strong>${request.quotationId ? '1' : '0'}</strong><small>${escapeHtml(request.quotationId || 'Sin cotización vinculada')}</small></div><div><span>OC DEL CLIENTE</span><strong>${request.clientOrderId ? '1' : '0'}</strong><small>${escapeHtml(request.clientOrderId ? `${request.clientOrderId} · ${request.clientOrderStatus === 'active' ? 'Activa' : 'Por activar'}` : 'Sin OC de cliente')}</small></div><div><span>OC A PROVEEDOR</span><strong>${supplierOrders.length}</strong><small>${escapeHtml(supplierOrders.map(order => order.id).join(', ') || 'Sin OC')}</small></div><div><span>ENTRADAS DE ALMACÉN</span><strong>${inventoryDocuments.filter(movement => movement.type === 'entry').length}</strong><small>Recepciones documentadas</small></div><div><span>SALIDAS / REMISIONES</span><strong>${shipments.length}</strong><small>${escapeHtml(shipments.map(shipment => shipment.folio).filter(Boolean).join(', ') || 'Sin remisión')}</small></div><div><span>FACTURAS CLIENTE</span><strong>${customerInvoices.length}</strong><small>${escapeHtml(customerInvoices.map(invoice => invoice.accountReference || invoice.folio).filter(Boolean).join(', ') || 'Sin factura')}</small></div></div>${documentActions}</section>`;
    q('#orderDetailTitle').textContent = `${request.id} · ${request.customerName || 'Abastecimiento de stock'}`;
    q('#orderDetailBody').innerHTML = `<div class="order-detail-summary"><div><span>ESTADO</span><strong>${escapeHtml(core.STATUS_LABELS[request.status] || request.status)}</strong></div><div><span>RESPONSABLE</span><strong>${escapeHtml(request.responsible || 'Sin asignar')}</strong></div><div><span>FECHA DE SOLICITUD</span><strong>${formatDate(request.requestDate)}</strong></div><div><span>AVANCE</span><strong>${progress.delivered} entregadas / ${progress.requested}</strong></div></div><section class="order-detail-section"><h3>Partidas y cantidades</h3>${lines.map(line => {
      const authorized = Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled));
      const completion = authorized ? Math.round(core.numberValue(line.quantityDelivered) / authorized * 100) : 0;
      return `<div class="order-detail-line"><div><strong>${escapeHtml(line.catalog || 'Sin catálogo')} · ${escapeHtml(line.description)}</strong><small>${escapeHtml(line.brandName || 'Sin marca')} · ${escapeHtml(core.STATUS_LABELS[line.status] || line.status)}</small><div class="order-line-progress"><i style="width:${Math.min(100, completion)}%"></i></div></div><span>Sol. ${line.quantityRequested}</span><span>Res. ${core.numberValue(line.reservedQuantity)}</span><span>Comprar ${Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased))}</span><span>Rec. ${line.quantityReceived}</span><span>Ent. ${line.quantityDelivered}</span><span>${Number(line.total || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}</span><button class="order-line-action" data-order-progress="${line.id}" ${request.status === 'cancelled' ? 'disabled' : ''}>Registrar avance</button></div>`;
    }).join('')}</section>${documentsHtml}<section class="order-detail-section"><h3>Historial auditable</h3>${audits.map(entry => `<div class="order-audit-item"><small>${new Date(entry.at).toLocaleString('es-MX')}</small><span><strong>${escapeHtml(entry.action)}</strong><br>${escapeHtml(entry.reference || entry.source?.fileHash || 'Sin referencia documental')}</span><small>${escapeHtml(entry.user || 'Sistema')}</small></div>`).join('') || '<p class="subtitle">Sin eventos registrados.</p>'}</section>`;
    q('#orderDetailDialog').showModal();
    window.lucide?.createIcons();
  }

  function downloadOrderAudit(requestId, preview = false) {
    const request = store.requisitions.find(item => item.id === requestId), PDF = window.jspdf?.jsPDF;
    if (!request || !PDF) return notify('No fue posible generar el expediente PDF.');
    const lines = requestLines(request.id), audits = store.auditLog.filter(entry => entry.entityId === request.id || lines.some(line => line.id === entry.entityId)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const doc = new PDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const header = () => { doc.setFillColor(23, 34, 29); doc.rect(0, 0, 210, 38, 'F'); doc.setFillColor(185, 250, 129); doc.roundedRect(16, 11, 15, 15, 3, 3, 'F'); doc.setTextColor(19, 32, 25); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('N', 23.5, 20.5, { align: 'center' }); doc.setTextColor(255, 255, 255); doc.setFontSize(15); doc.text('BIO · EXPEDIENTE OPERATIVO', 38, 18); doc.setTextColor(166, 181, 171); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text('PEDIDOS, COMPRAS, RECEPCIONES, FACTURACIÓN Y ENTREGAS', 38, 25); };
    header();
    doc.setFillColor(247, 249, 246); doc.roundedRect(16, 47, 178, 34, 3, 3, 'F'); doc.setTextColor(35, 49, 39); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(request.id, 22, 58); doc.setFontSize(9); doc.text(doc.splitTextToSize(request.customerName || 'Abastecimiento interno de stock', 100), 22, 67); doc.setTextColor(112, 126, 116); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(`Estado: ${core.STATUS_LABELS[request.status] || request.status}`, 142, 57); doc.text(`Solicitud: ${formatDate(request.requestDate)}`, 142, 65); doc.text(`Responsable: ${request.responsible || 'Sin asignar'}`, 142, 73);
    let y = 94;
    doc.setTextColor(36, 50, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('PARTIDAS', 16, y); y += 7;
    lines.forEach((line, index) => { if (y > 248) { doc.addPage(); header(); y = 50; } doc.setFillColor(index % 2 ? 250 : 246, index % 2 ? 251 : 248, index % 2 ? 249 : 245); doc.roundedRect(16, y - 4, 178, 15, 2, 2, 'F'); doc.setTextColor(37, 51, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(doc.splitTextToSize(`${line.catalog || 'S/C'} · ${line.description}`, 92), 21, y + 1); doc.setTextColor(101, 115, 105); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(`Sol. ${line.quantityRequested} · Res. ${core.numberValue(line.reservedQuantity)} · Comp. ${line.quantityPurchased} · Rec. ${line.quantityReceived}`, 116, y + 1); doc.text(`Ent. ${line.quantityDelivered} · Pend. compra ${Math.max(0, core.numberValue(line.quantityRequested) - core.numberValue(line.quantityCancelled) - core.numberValue(line.reservedQuantity) - core.numberValue(line.quantityPurchased))} · Estado: ${core.STATUS_LABELS[line.status] || line.status}`, 116, y + 7); y += 18; });
    if (y > 225) { doc.addPage(); header(); y = 50; }
    doc.setTextColor(36, 50, 41); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('BITÁCORA', 16, y); y += 7;
    audits.forEach(entry => { if (y > 265) { doc.addPage(); header(); y = 50; } doc.setTextColor(45, 59, 49); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text(`${new Date(entry.at).toLocaleString('es-MX')} · ${entry.action}`, 18, y); doc.setTextColor(111, 124, 114); doc.setFont('helvetica', 'normal'); doc.text(doc.splitTextToSize(`${entry.user || 'Sistema'} · ${entry.reference || entry.source?.fileHash || 'Sin referencia'}`, 165), 18, y + 5); y += 11; });
    const pages = doc.getNumberOfPages(), fingerprint = core.hashString(JSON.stringify({ request, lines, audits }));
    for (let page = 1; page <= pages; page += 1) { doc.setPage(page); doc.setDrawColor(226, 231, 226); doc.line(16, 281, 194, 281); doc.setTextColor(130, 142, 133); doc.setFont('courier', 'normal'); doc.setFontSize(6); doc.text(`Huella de expediente: ${fingerprint}`, 16, 287); doc.setFont('helvetica', 'normal'); doc.text(`Página ${page} de ${pages}`, 194, 287, { align: 'right' }); }
    if (preview && window.BioFlowDocs) return window.BioFlowDocs.present(doc, { title: 'EXPEDIENTE OPERATIVO', folio: request.id, filename: `expediente-${request.id}.pdf` });
    doc.save(`expediente-${request.id}.pdf`);
  }

  const progressGrid = q('#orderProgressForm .order-progress-grid');
  progressGrid?.insertAdjacentHTML('beforeend', `<section id="receiptExtraFields" class="receipt-extra-fields wide"><div class="receipt-extra-heading"><strong>Datos de recepción física</strong><small>La factura del proveedor es opcional y se conciliará cuando sea registrada.</small></div><div class="receipt-extra-grid"><label class="field"><span>Documento de llegada</span><select id="receiptDocumentType"><option value="supplier_remission">Remisión del proveedor</option><option value="supplier_invoice">Factura del proveedor</option><option value="other">Otro documento</option></select></label><label class="field"><span>Almacén receptor</span><select id="receiptWarehouse"><option value="1">Almacén 01</option><option value="2">Almacén 02</option></select></label><label class="field"><span>Cantidad rechazada</span><input id="receiptRejectedQuantity" type="number" min="0" step="1" value="0" /></label><label class="field"><span>Estado de calidad</span><select id="receiptQualityStatus"><option value="released">Liberada / disponible</option><option value="quarantine">Inspección / cuarentena</option><option value="rejected">Rechazada</option></select></label><label class="field"><span>Lote</span><input id="receiptLot" placeholder="Opcional" /></label><label class="field"><span>Serie</span><input id="receiptSerial" placeholder="Opcional" /></label><label class="field"><span>Caducidad</span><input id="receiptExpiry" type="date" /></label><label class="field"><span>Evidencia</span><input id="receiptEvidence" type="file" accept="image/*,.pdf" multiple /></label></div></section>`);
  const toggleReceiptFields = () => { const receipt = q('#orderProgressType').value === 'receipt'; q('#receiptExtraFields').hidden = !receipt; q('#orderProgressReference').placeholder = receipt ? 'Folio de remisión, OC o documento de llegada' : 'Factura, remisión, OC o referencia MC'; };

  function openProgress(lineId) {
    const line = store.orderLines.find(item => item.id === lineId), request = line && store.requisitions.find(item => item.id === line.requisitionId);
    if (!line || !request) return;
    q('#orderProgressLineId').value = line.id;
    q('#orderProgressContext').innerHTML = `<strong>${escapeHtml(line.catalog || 'Sin catálogo')} · ${escapeHtml(line.description)}</strong><br>${escapeHtml(request.id)} · Solicitadas ${line.quantityRequested} · Recibidas ${line.quantityReceived} · Entregadas ${line.quantityDelivered}`;
    q('#orderProgressType').value = 'receipt'; q('#orderProgressQuantity').value = 1; q('#orderProgressSupplier').value = line.supplierName || ''; q('#orderProgressReference').value = ''; q('#orderProgressNotes').value = ''; q('#orderProgressOverride').checked = false;q('#receiptDocumentType').value='supplier_remission';q('#receiptWarehouse').value=line.deliveryWarehouse||'1';q('#receiptRejectedQuantity').value=0;q('#receiptQualityStatus').value='released';q('#receiptLot').value='';q('#receiptSerial').value='';q('#receiptExpiry').value='';q('#receiptEvidence').value='';toggleReceiptFields();
    let supplierCatalog = [];
    try { supplierCatalog = JSON.parse(localStorage.getItem('nexo-suppliers') || '[]'); } catch {}
    q('#orderSupplierOptions').innerHTML = supplierCatalog.map(supplier => `<option value="${escapeHtml(supplier.name)}"></option>`).join('');
    q('#orderProgressDialog').showModal();
  }

  async function applyProgress(lineId, type, quantity, supplier, reference, notes, override, receiptData = {}) {
    const next = JSON.parse(JSON.stringify(store)), line = next.orderLines.find(item => item.id === lineId), request = line && next.requisitions.find(item => item.id === line.requisitionId);
    let catalogAdjustments = [];
    if (!line || !request) return;
    const permission = { purchase: 'purchase', receipt: 'receive', delivery: 'deliver', invoice: 'invoice', account_charge: 'invoice', reserve: 'inventory', cancel: 'cancel' }[type];
    if (!can(permission)) return notify('Tu perfil no tiene permiso para esta operación.');
    if (type === 'cancel' && !notes.trim()) return notify('La cancelación requiere un motivo.');
    if (type === 'purchase') {
      const gate = core.validateSupplierPurchaseGate({ requestType: request.type, clientOrderStatus: request.clientOrderStatus });
      if (!gate.valid) return notify(gate.message);
    }
    if (type === 'purchase' && (!reference || !supplier)) return notify('La compra requiere folio de OC y proveedor.');
    if (type === 'account_charge' && !reference) return notify('El cargo requiere una referencia de manejo de cuenta.');
    if (type === 'receipt' && !reference) return notify('La recepción requiere la OC, remisión u otro documento de llegada; la factura puede registrarse después.');
    if (type === 'delivery' && !reference) return notify('La entrega requiere un folio de remisión.');
    if (type === 'invoice' && !reference) return notify('La facturación requiere el folio de la factura.');
    if (override && !can('admin')) return notify('El excedente requiere permiso de administración.');
    if (type === 'receipt') {
      const supplierLink = next.supplierOrderLines.find(item => item.orderLineId === line.id), supplierOrder = supplierLink && next.supplierOrders.find(order => order.id === supplierLink.supplierOrderId);
      if (!supplierOrder || !['confirmed', 'partially_received', 'received'].includes(supplierOrder.status)) return notify('Confirma primero la OC a proveedor correspondiente.');
      const rejected = core.numberValue(receiptData.rejectedQuantity);
      if (rejected < 0 || rejected > quantity) return notify('La cantidad rechazada no puede superar lo recibido físicamente.');
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
      const supplierLink = next.supplierOrderLines.find(item => item.orderLineId === line.id), rejectedQuantity = core.numberValue(receiptData.rejectedQuantity), acceptedQuantity = Math.max(0, quantity - rejectedQuantity), evidenceFiles = [...(receiptData.evidenceFiles || [])], evidence = evidenceFiles.map(file => ({ name: file.name, size: file.size, type: file.type }));
      if (evidenceFiles.length && (!evidenceFiles.every(file => (file.type === 'application/pdf' || file.type.startsWith('image/')) && file.size <= 5 * 1024 * 1024) || evidenceFiles.length > 5)) return notify('Las evidencias deben ser imágenes o PDF de máximo 5 MB y hasta cinco archivos.');
      if (evidenceFiles.length && window.BioMediaStore) { try { const stored = await window.BioMediaStore.store('movementEvidence', 'movementId', id, evidenceFiles); stored.forEach((record, index) => { evidence[index].id = record.id; evidence[index].hash = record.hash; }); } catch { return notify('No fue posible conservar la evidencia; la recepción no se registró.'); } }
      const receipt = { id, supplierOrderId: supplierLink?.supplierOrderId || null, requisitionId: request.id, date: at.slice(0, 10), receivedAt: at, warehouseId: receiptData.warehouseId || line.deliveryWarehouse || '1', items: [{ orderLineId: line.id, quantity, quantityAccepted: acceptedQuantity, quantityRejected: rejectedQuantity, lot: receiptData.lot || null, serial: receiptData.serial || null, expiryDate: receiptData.expiryDate || null, qualityStatus: receiptData.qualityStatus || 'released' }], type: acceptedQuantity >= line.quantityPurchased ? 'total' : 'partial', documentType: receiptData.documentType || 'supplier_remission', supplierRemission: receiptData.documentType === 'supplier_remission' ? reference : null, supplierInvoiceReference: receiptData.documentType === 'supplier_invoice' ? reference : null, invoiceRequiredLater: receiptData.documentType !== 'supplier_invoice', qualityStatus: receiptData.qualityStatus || 'released', inspectionStatus: receiptData.qualityStatus === 'quarantine' ? 'pending' : receiptData.qualityStatus === 'rejected' ? 'rejected' : 'released', evidence, user: actor.name, observations: notes, reference };
      if(receipt.qualityStatus==='released'){line.quantityAvailableReceived=core.numberValue(line.quantityAvailableReceived==null?before.quantityReceived:line.quantityAvailableReceived)+acceptedQuantity;catalogAdjustments.push({productId:line.productId,warehouseId:receipt.warehouseId,delta:acceptedQuantity})}
      next.receipts.push(receipt);
      const supplierOrder = supplierLink && next.supplierOrders.find(order => order.id === supplierLink.supplierOrderId);
      if (supplierOrder) { const orderLinks = next.supplierOrderLines.filter(link => link.supplierOrderId === supplierOrder.id), ordered = orderLinks.reduce((sum, link) => sum + core.numberValue(link.quantity), 0), received = next.receipts.filter(item => item.supplierOrderId === supplierOrder.id).flatMap(item => item.items || []).reduce((sum, item) => sum + core.numberValue(item.quantityAccepted ?? item.quantity) , 0); supplierOrder.status = received >= ordered ? 'received' : 'partially_received'; supplierOrder.reconciliation = core.reconcileSupplierPurchase({ order: supplierOrder, links: next.supplierOrderLines, receipts: next.receipts, invoices: next.supplierInvoices }); }
      if (acceptedQuantity > 0) next.inventoryMovements.push({ id: `INV-IN-${Date.now()}`, requisitionId: request.id, orderLineId: line.id, warehouseId: receipt.warehouseId, productId: line.productId, catalog: line.catalog, type: 'entry', quantity: acceptedQuantity, inventoryState: receipt.qualityStatus === 'released' ? 'available' : 'quarantine', reason: request.type === 'internal_stock' ? 'Recepción para stock' : 'Entrada contra OC a proveedor', sourceDocumentType: 'receipt', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: supplierOrder?.reconciliation?.status || (line.productId ? 'pending_invoice' : 'pending_product_match') });
    }
    if (type === 'delivery') {
      const reservations = next.inventoryReservations.filter(item => item.orderLineId === line.id && item.status === 'active'), preferredWarehouses = reservations.map(item => String(item.warehouseId || '1'));
      catalogAdjustments = planCatalogDeduction(line.productId, quantity, [...preferredWarehouses, line.deliveryWarehouse || '1']);
      if (!catalogAdjustments) return notify('La existencia física de los almacenes no alcanza para registrar esta salida. Revisa recepciones y reservas.');
      next.shipments.push({ id, folio: reference || id, date: at.slice(0, 10), requisitionId: request.id, items: [{ orderLineId: line.id, quantity }], deliveredAt: at, type: line.quantityDelivered >= line.quantityRequested ? 'total' : 'partial', evidenceId: null, observations: notes });
      let remainingToConsume = quantity; const reservedByWarehouse = {};
      reservations.forEach(reservation => { const availableReservation = Math.max(0, core.numberValue(reservation.quantity) - core.numberValue(reservation.quantityConsumed)), used = Math.min(remainingToConsume, availableReservation), warehouseId = String(reservation.warehouseId || '1'); reservation.quantityConsumed = core.numberValue(reservation.quantityConsumed) + used; remainingToConsume -= used; reservedByWarehouse[warehouseId] = core.numberValue(reservedByWarehouse[warehouseId]) + used; if (reservation.quantityConsumed >= core.numberValue(reservation.quantity)) reservation.status = 'consumed'; });
      catalogAdjustments.forEach((adjustment, index) => { const warehouseId = String(adjustment.warehouseId), movementQuantity = Math.abs(adjustment.delta), reservedQuantityUsed = Math.min(movementQuantity, core.numberValue(reservedByWarehouse[warehouseId])); reservedByWarehouse[warehouseId] = Math.max(0, core.numberValue(reservedByWarehouse[warehouseId]) - reservedQuantityUsed); next.inventoryMovements.push({ id: `INV-OUT-${Date.now()}-${index + 1}`, requisitionId: request.id, orderLineId: line.id, warehouseId, productId: line.productId, catalog: line.catalog, type: 'exit', quantity: movementQuantity, reservedQuantityUsed, purchasedQuantityUsed: movementQuantity - reservedQuantityUsed, reason: 'Salida contra remisión', sourceDocumentType: 'shipment', sourceDocumentId: id, user: actor.name, at, reconciliationStatus: line.productId ? 'matched' : 'pending_product_match' }); });
    }
    if (['invoice', 'account_charge'].includes(type)) next.customerInvoices.push({ id, folio: type === 'invoice' ? reference || id : null, date: at.slice(0, 10), amount: line.unitPrice * quantity * (1 + line.taxRate / 100), requisitionId: request.id, items: [{ orderLineId: line.id, quantity }], type: type === 'account_charge' ? 'account_charge' : 'standard', accountReference: type === 'account_charge' ? reference : null, observation: notes });
    if (type === 'cancel') { line.cancellationReason = notes; line.cancelledBy = actor.name; line.cancelledAt = at; }
    line.status = core.deriveLineStatus(line);
    request.status = core.deriveRequisitionStatus(next.orderLines.filter(item => item.requisitionId === request.id));
    request.updatedAt = at;
    next.auditLog.push({ id: `AUD-${Date.now()}`, entityType: 'order_line', entityId: line.id, action: type, user: actor.name, at, before, after: JSON.parse(JSON.stringify(line)), supplier: supplier || null, reference, notes, override: Boolean(override), receipt: type === 'receipt' ? { documentType: receiptData.documentType, warehouseId: receiptData.warehouseId, rejectedQuantity: core.numberValue(receiptData.rejectedQuantity), lot: receiptData.lot || null, serial: receiptData.serial || null, expiryDate: receiptData.expiryDate || null, qualityStatus: receiptData.qualityStatus || 'released' } : null });
    if (!saveStore(next)) return;if(catalogAdjustments.length&&!applyCatalogStockAdjustments(catalogAdjustments))return notify('El avance se registró, pero la existencia del catálogo requiere conciliación manual.'); q('#orderProgressDialog').close(); renderOrderDashboard(); renderOrderDetail(request.id); notify('Avance registrado con trazabilidad.');
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
  ['orderSearch', 'orderDateFrom', 'orderDateTo'].forEach(id => q(`#${id}`).addEventListener('input', renderOrderDashboard));
  ['orderStatusFilter', 'orderStageFilter', 'orderResponsibleFilter'].forEach(id => q(`#${id}`).addEventListener('change', renderOrderDashboard));
  q('#orderFilterReset').addEventListener('click', () => { ['orderSearch', 'orderStatusFilter', 'orderStageFilter', 'orderResponsibleFilter', 'orderDateFrom', 'orderDateTo'].forEach(id => { q(`#${id}`).value = ''; }); renderOrderDashboard(); });
  q('#supplierOrderSearch').addEventListener('input', renderSupplierPurchaseOrders);
  q('#supplierOrderStatusFilter').addEventListener('change', renderSupplierPurchaseOrders);
  q('#supplierOrderList').addEventListener('click', event => {
    const confirmButton = event.target.closest('[data-confirm-supplier-order]'), downloadButton = event.target.closest('[data-download-supplier-order]'), statusBadge = event.target.closest('.order-status-badge');
    if (statusBadge) { const label = statusBadge.textContent.trim(), match = { 'Propuesta': 'draft', 'Borrador': 'draft', 'Confirmada': 'confirmed', 'Recepción parcial': 'partially_received', 'Recibida': 'received' }[label]; if (match) { q('#supplierOrderStatusFilter').value = match; renderSupplierPurchaseOrders(); } }
    if (confirmButton) confirmSupplierOrder(confirmButton.dataset.confirmSupplierOrder);
    if (downloadButton) downloadSupplierOrder(downloadButton.dataset.downloadSupplierOrder);
  });
  q('#backToClientOrders').addEventListener('click', () => document.querySelector('[data-view="salesOrdersView"]')?.click());
  q('#orderTrackingList').addEventListener('click', event => { const button = event.target.closest('[data-order-detail]'), statusBadge = event.target.closest('.order-status-badge'); if (button) renderOrderDetail(button.dataset.orderDetail); if (statusBadge) { const label = statusBadge.textContent.trim(), match = Object.entries(core.STATUS_LABELS).find(([, shown]) => shown === label)?.[0]; if (match) { q('#orderStatusFilter').value = match; renderOrderDashboard(); } } });
  q('#deliverySearch').addEventListener('input', renderDeliveries);
  q('#deliveryStatusFilter').addEventListener('change', renderDeliveries);
  q('#deliveryTrackingList').addEventListener('click', event => { const detail = event.target.closest('[data-order-detail]'), documentButton = event.target.closest('[data-delivery-document]'), statusBadge = event.target.closest('.order-status-badge'); if (detail) renderOrderDetail(detail.dataset.orderDetail); if (documentButton) downloadShipmentDocument(documentButton.dataset.deliveryDocument, true); if (statusBadge) { const label = statusBadge.textContent.trim(), match = label.includes('completa') ? 'completed' : label.includes('parcial') ? 'partial' : 'pending'; q('#deliveryStatusFilter').value = match; renderDeliveries(); } });
  qa('[data-close-order-dialog]').forEach(button => button.addEventListener('click', () => q(`#${button.dataset.closeOrderDialog}`).close()));
  q('#orderDetailBody').addEventListener('click', event => {
    const button = event.target.closest('[data-order-progress]'), documentButton = event.target.closest('[data-flow-document]');
    if (button) { q('#orderDetailDialog').close(); openProgress(button.dataset.orderProgress); }
    if (!documentButton) return;
    const kind = documentButton.dataset.flowDocument, id = documentButton.dataset.flowId;
    if (kind === 'supplier_order') downloadSupplierOrder(id, true);
    if (kind === 'inventory') downloadInventoryDocument(id, true);
    if (kind === 'remision') downloadShipmentDocument(id, true);
    if (kind === 'quotation') { let list = []; try { list = JSON.parse(localStorage.getItem('nexo-sales-quotations') || '[]'); } catch {} window.downloadSalesQuotationV2?.(list.find(item => item.id === id), true); }
    if (kind === 'client_order') { let list = []; try { list = JSON.parse(localStorage.getItem('nexo-commercial-orders') || '[]'); } catch {} window.downloadCommercialOrderDocument?.(list.find(item => item.id === id), true); }
  });
  q('#downloadOrderAudit').addEventListener('click', () => downloadOrderAudit(activeRequestId, true));
  q('#orderProgressType').addEventListener('change', toggleReceiptFields);
  q('#orderProgressForm').addEventListener('submit', event => { event.preventDefault(); const type = q('#orderProgressType').value, lineId = q('#orderProgressLineId').value, quantity = Number(q('#orderProgressQuantity').value), supplier = q('#orderProgressSupplier').value.trim(), reference = q('#orderProgressReference').value.trim(), notes = q('#orderProgressNotes').value.trim(), override = q('#orderProgressOverride').checked, receiptData = { documentType: q('#receiptDocumentType').value, warehouseId: q('#receiptWarehouse').value, rejectedQuantity: Number(q('#receiptRejectedQuantity').value || 0), qualityStatus: q('#receiptQualityStatus').value, lot: q('#receiptLot').value.trim(), serial: q('#receiptSerial').value.trim(), expiryDate: q('#receiptExpiry').value || null, evidenceFiles: q('#receiptEvidence').files }; applyProgress(lineId, type, quantity, supplier, reference, notes, override, receiptData); });
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
  ['orderDetailDialog', 'orderProgressDialog'].forEach(id => q(`#${id}`).addEventListener('cancel', event => { event.preventDefault(); q(`#${id}`).close(); }));

  qa('[data-view="ordersView"], [data-view="deliveriesView"], [data-view="supplierOrdersView"]').forEach(link => link.addEventListener('click', () => { syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); }));
  window.addEventListener('bio:client-order-activated', () => { syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); });
  window.addEventListener('bio:access-changed', () => { actor = window.BioAccess?.currentUser() || actor; renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); });
  syncClientOrders(); syncSupplierPurchaseOrders(); renderOrderDashboard(); renderDeliveries(); renderSupplierPurchaseOrders(); renderImportSimulation();
})();
