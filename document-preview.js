(function (root) {
  'use strict';
  const read = (key, fallback = []) => { try { return JSON.parse(root.localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const find = (key, id) => (read(key, []) || []).find(item => String(item.id || item.folio) === String(id));
  const operational = () => read('nexo-order-operations-v1', {});

  function previewMovement(item) {
    if (!item || !root.BioFlowDocs) return;
    const type = item.type === 'entrada' ? 'inventory_entry' : 'inventory_exit';
    const evidence = item.evidence || [], evidenceDetail = evidence.length ? ` Evidencias: ${evidence.length}; huellas SHA-256: ${evidence.map(file => String(file.hash || '').slice(0, 16)).filter(Boolean).join(', ')}.` : '';
    return root.BioFlowDocs.preview(type, { id: item.id, date: item.createdAt, status: 'Registrado', warehouse: 'Inventario Bio', origin: item.title, reference: item.purchaseOrderId || item.detail, related: item.quotationNumber, items: [{ catalog: item.sku || 'Movimiento', description: item.detail || item.title, quantity: Math.abs(Number(String(item.qty || 1).replace(/[^0-9.-]/g, ''))) || 1 }], notes: `${item.note || 'Movimiento registrado con trazabilidad operativa.'}${evidenceDetail}`, auditId: item.id }, { filename: `comprobante-${item.id}.pdf` });
  }

  function previewPurchaseOrder(order) {
    if (!order || !root.BioFlowDocs) return;
    return root.BioFlowDocs.preview('supplier_order', { id: order.id, date: order.createdAt, status: 'Emitida', supplier: order.supplierName, warehouse: `Almacén ${order.warehouse || 1}`, reference: `Cotización ${order.quotationNumber || 'obligatoria'}`, related: order.movementId, items: [{ catalog: order.productSku || order.productId || 'Producto', description: order.productName, quantity: order.quantity }], notes: `Orden interna respaldada por ${order.quotationFileName || 'cotización registrada'}.`, auditId: order.quotationHash || order.id }, { filename: `orden-compra-${order.id}.pdf` });
  }

  function previewPriceLoad(load) {
    if (!load || !root.BioFlowDocs) return;
    return root.BioFlowDocs.preview('audit', { id: load.id, date: load.appliedAt, status: 'Carga aplicada', supplier: load.supplierName, reference: load.fileName, related: (load.sheets || []).join(', '), items: [{ catalog: load.supplierId, description: `${load.present || 0} vigentes · ${load.updated || 0} actualizados · ${load.missing || 0} no incluidos`, quantity: load.present || load.updated || 1 }], notes: `Archivo auditado. Monedas: ${(load.currencies || []).join(', ') || 'Sin identificar'}.`, auditId: load.fileHash || load.id }, { filename: `auditoria-carga-${load.id}.pdf` });
  }

  function previewByKind(kind, id) {
    const store = operational();
    if (kind === 'quotation') return root.downloadSalesQuotationV2?.(find('nexo-sales-quotations', id), true);
    if (kind === 'client_order') return root.downloadCommercialOrderDocument?.(find('nexo-commercial-orders', id), true);
    if (kind === 'purchase_order') return previewPurchaseOrder(find('nexo-purchase-orders', id));
    if (kind === 'price_load') return previewPriceLoad(find('nexo-price-loads', id));
    if (kind === 'movement') return previewMovement(find('nexo-movements', id));
    if (kind === 'supplier_order') return root.BioOrderDocuments?.downloadSupplierOrder(id, true);
    if (kind === 'inventory') return root.BioOrderDocuments?.downloadInventoryDocument(id, true);
    if (kind === 'remision') return root.BioOrderDocuments?.downloadShipmentDocument(id, true);
    const generic = ['supplierInvoices', 'receipts', 'customerInvoices'].flatMap(key => store[key] || []).find(item => String(item.id || item.folio) === String(id));
    if (generic && root.BioFlowDocs) return root.BioFlowDocs.preview('audit', { id: generic.id || generic.folio, date: generic.date || generic.createdAt, status: generic.status || generic.type || 'Registrado', client: generic.customerName || generic.requisitionId, supplier: generic.supplierName, currency: generic.currency || 'MXN', reference: generic.supplierOrderId || generic.requisitionId, total: generic.amount || generic.amountOriginal || generic.total, notes: generic.observations || generic.observation || 'Documento operativo auditable.' }, { filename: `${generic.id || generic.folio}.pdf` });
  }

  async function previewAttachment(orderId) {
    if (typeof root.openDocumentDatabase !== 'function') return;
    try {
      const db = await root.openDocumentDatabase(), record = await new Promise((resolve, reject) => { const request = db.transaction('quotations', 'readonly').objectStore('quotations').get(orderId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close();
      if (!record) return root.showToast?.('El archivo de cotización no está disponible en este equipo.');
      return root.BioFlowDocs?.previewBlob(record.blob, { title: 'COTIZACIÓN ADJUNTA', folio: orderId, filename: record.name });
    } catch { root.showToast?.('No fue posible abrir la cotización adjunta.'); }
  }

  function enhance(scope = root.document) {
    let changed = false;
    scope.querySelectorAll?.('[data-sales-quotation],[data-download-commercial-order],[data-download-supplier-order],.download-record,.download-purchase-order,.download-price-audit,.download-quotation,[data-audit-download],#downloadOrderAudit').forEach(button => {
      if (button.dataset.previewEnhanced) return;
      button.dataset.previewEnhanced = 'true'; changed = true;
      button.title = 'Vista previa y descarga';
      if (button.getAttribute('aria-label')) button.setAttribute('aria-label', button.getAttribute('aria-label').replace(/^Descargar/i, 'Vista previa y descarga'));
      const icon = button.querySelector('[data-lucide]'); if (icon) icon.setAttribute('data-lucide', 'eye');
      if (button.matches('[data-download-commercial-order],[data-download-supplier-order]')) button.innerHTML = '<i data-lucide="eye"></i>Ver PDF';
      if (button.id === 'downloadOrderAudit') button.innerHTML = '<i data-lucide="eye"></i> Previsualizar expediente';
    });
    if (changed) root.lucide?.createIcons();
  }

  root.document.addEventListener('click', event => {
    const button = event.target.closest('[data-sales-quotation],[data-download-commercial-order],[data-download-supplier-order],.download-record,.download-purchase-order,.download-price-audit,.download-quotation,[data-audit-download]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.dataset.salesQuotation) previewByKind('quotation', button.dataset.salesQuotation);
    else if (button.dataset.downloadCommercialOrder) previewByKind('client_order', button.dataset.downloadCommercialOrder);
    else if (button.dataset.downloadSupplierOrder) previewByKind('supplier_order', button.dataset.downloadSupplierOrder);
    else if (button.dataset.movementId) previewByKind('movement', button.dataset.movementId);
    else if (button.classList.contains('download-purchase-order')) previewByKind('purchase_order', button.dataset.orderId);
    else if (button.dataset.priceLoadId) previewByKind('price_load', button.dataset.priceLoadId);
    else if (button.classList.contains('download-quotation')) previewAttachment(button.dataset.orderId);
    else if (button.dataset.auditDownload) root.BioAudit?.preview(button.dataset.auditDownload);
  }, true);

  const observer = new MutationObserver(records => { records.forEach(record => record.addedNodes.forEach(node => { if (node.nodeType === 1) enhance(node); })); });
  observer.observe(root.document.body, { childList: true, subtree: true });
  root.BioDocumentPreview = { previewByKind, previewMovement, previewPurchaseOrder, previewPriceLoad, previewAttachment, enhance };
  enhance();
})(window);
