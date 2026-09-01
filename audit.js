(function (root) {
  'use strict';
  const q = selector => root.document?.querySelector(selector);
  const read = (key, fallback) => { try { return JSON.parse(root.localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const text = value => String(value ?? '').trim();
  const escapeHtml = value => text(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const dateOf = item => item.at || item.createdAtISO || item.createdAt || item.appliedAt || item.updatedAt || item.date || item.deliveredAt || new Date(0).toISOString();
  const displayDate = value => {
    const raw = text(value), dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return { date: `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`, time: 'Sin hora' };
    const parsed = new Date(raw); if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() <= 1970) return { date: 'Registro histórico', time: 'Sin fecha exacta' };
    return { date: parsed.toLocaleDateString('es-MX'), time: parsed.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) };
  };
  const labels = { document: 'Documento', movement: 'Movimiento', operation: 'Operación', currency: 'Divisas', access: 'Acceso' };
  const icons = { document: 'file-check-2', movement: 'arrow-right-left', operation: 'workflow', currency: 'landmark', access: 'key-round' };
  let visible = [];

  const record = (category, origin, item, options = {}) => ({
    id: text(item.id || item.folio || `${origin}-${dateOf(item)}`), category, origin,
    title: text(options.title || item.action || item.event || item.title || item.folio || item.id || origin),
    reference: text(options.reference || item.reference || item.sourceDocumentId || item.quotationId || item.clientOrderId || item.requisitionId || item.entityId || 'Sin referencia'),
    user: text(options.user || item.userName || item.user || item.createdBy || item.confirmedBy || item.actorId || 'Sistema'),
    at: dateOf(item), detail: text(options.detail || item.detail || item.notes || item.observations || item.reason || item.source || origin),
    downloadKind: options.downloadKind || '', downloadId: text(options.downloadId || item.id || item.folio || '')
  });

  function collect() {
    const operational = read('nexo-order-operations-v1', {}), rows = [];
    (operational.auditLog || []).forEach(item => rows.push(record('operation', 'Flujo operativo', item, { reference: item.reference || item.entityId })));
    (operational.inventoryMovements || []).forEach(item => rows.push(record('movement', 'Inventario operativo', item, { title: `${item.type === 'entry' ? 'Entrada' : 'Salida'} de almacén`, reference: item.sourceDocumentId || item.requisitionId, detail: `${item.catalog || 'Producto'} · ${item.quantity || 0} uds. · ${item.reason || ''}`, downloadKind: 'inventory', downloadId: item.id })));
    (read('nexo-movements', []) || []).forEach(item => rows.push(record('movement', 'Movimientos', item, { reference: item.detail, detail: `${item.title || item.type || 'Movimiento'}${item.evidence?.length ? ` · ${item.evidence.length} evidencia${item.evidence.length === 1 ? '' : 's'} con huella SHA-256` : ''}` })));

    const documentSources = [
      ['nexo-sales-quotations', 'Cotizaciones', 'Cotización', 'quotation'],
      ['nexo-commercial-orders', 'OC de clientes', 'Orden de compra del cliente', 'client_order'],
      ['nexo-purchase-orders', 'Compras internas', 'Orden de compra interna', 'purchase_order'],
      ['nexo-price-loads', 'Listas de precios', 'Comprobante de carga de precios', 'price_load']
    ];
    documentSources.forEach(([key, origin, title, kind]) => (read(key, []) || []).forEach(item => rows.push(record('document', origin, item, { title, reference: item.quotationId || item.supplierName || item.movementId, detail: item.client || item.fileName || item.productName || item.status, downloadKind: kind }))));
    const operationalDocuments = [
      ['supplierOrders', 'OC a proveedores', 'Orden de compra a proveedor', 'supplier_order'],
      ['supplierInvoices', 'Facturas de proveedor', 'Factura de proveedor', 'generic_document'],
      ['receipts', 'Recepciones', 'Recepción de almacén', 'generic_document'],
      ['customerInvoices', 'Facturas a clientes', 'Factura al cliente', 'generic_document'],
      ['shipments', 'Remisiones', 'Remisión de entrega', 'remision']
    ];
    operationalDocuments.forEach(([key, origin, title, kind]) => (operational[key] || []).forEach(item => rows.push(record('document', origin, item, { title, reference: item.supplierOrderId || item.requisitionId || (item.supplierOrderIds || []).join(', '), detail: item.supplierName || item.observations || item.type || item.status, downloadKind: kind }))));
    (read('nexo-fx-v1', {}).audit || []).forEach(item => rows.push(record('currency', 'Divisas', item, { title: item.event, reference: item.source || item.reason, user: item.userName })));
    (read('nexo-access-v1', {}).audit || []).forEach(item => rows.push(record('access', 'Seguridad', item, { title: item.type, reference: item.entityId || `${item.before || ''} → ${item.after || ''}` })));
    const seen = new Set();
    return rows.filter(item => { const key = `${item.category}|${item.id}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  function filtered() {
    const term = text(q('#auditSearch')?.value).toLocaleLowerCase('es-MX'), category = q('#auditCategory')?.value || '', from = q('#auditDateFrom')?.value || '', to = q('#auditDateTo')?.value || '';
    return collect().filter(item => (!category || item.category === category) && (!from || text(item.at).slice(0, 10) >= from) && (!to || text(item.at).slice(0, 10) <= to) && (!term || [item.id, item.title, item.origin, item.reference, item.user, item.detail].some(value => text(value).toLocaleLowerCase('es-MX').includes(term))));
  }

  function render() {
    if (!q('#auditList') || !root.BioAccess?.can('audit')) return;
    const all = collect(); visible = filtered();
    q('#auditTotal').textContent = all.length; q('#auditDocuments').textContent = all.filter(item => item.category === 'document').length; q('#auditMovements').textContent = all.filter(item => item.category === 'movement').length; q('#auditUsers').textContent = new Set(all.map(item => item.user).filter(Boolean)).size; q('#auditResultCount').textContent = `${visible.length} de ${all.length} registros`;
    q('#auditList').innerHTML = visible.map(item => { const shown = displayDate(item.at); return `<article class="audit-entry"><div class="audit-entry-main"><span class="audit-entry-icon"><i data-lucide="${icons[item.category]}"></i></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail || item.id)}</small><span class="audit-kind">${labels[item.category]}</span></div></div><div><strong>${escapeHtml(item.origin)}</strong><small>${escapeHtml(item.reference)} · ${escapeHtml(item.id)}</small></div><div><strong>${escapeHtml(item.user)}</strong><small>Responsable registrado</small></div><div><strong>${escapeHtml(shown.date)}</strong><small>${escapeHtml(shown.time)}</small></div>${item.downloadKind ? `<button class="audit-download" data-audit-download="${escapeHtml(item.id)}" title="Descargar documento"><i data-lucide="download"></i></button>` : '<span></span>'}</article>`; }).join('') || '<div class="audit-empty"><i data-lucide="file-search"></i><strong>No hay registros con estos filtros</strong><span>Ajusta la búsqueda o el periodo consultado.</span></div>';
    root.lucide?.createIcons();
  }

  function download(item, preview = false) {
    if (!item || !root.BioAccess?.can('audit')) return;
    const operational = read('nexo-order-operations-v1', {}), find = (key, id) => (read(key, []) || []).find(row => text(row.id || row.folio) === text(id));
    if (preview && root.BioDocumentPreview) return root.BioDocumentPreview.previewByKind(item.downloadKind, item.downloadId);
    if (item.downloadKind === 'quotation') return root.downloadSalesQuotationV2?.(find('nexo-sales-quotations', item.downloadId));
    if (item.downloadKind === 'client_order') return root.downloadCommercialOrderDocument?.(find('nexo-commercial-orders', item.downloadId));
    if (item.downloadKind === 'purchase_order') return root.downloadPurchaseOrderRecord?.(find('nexo-purchase-orders', item.downloadId));
    if (item.downloadKind === 'price_load') return root.downloadPriceLoadRecord?.(find('nexo-price-loads', item.downloadId));
    if (item.downloadKind === 'supplier_order') return root.BioOrderDocuments?.downloadSupplierOrder(item.downloadId);
    if (item.downloadKind === 'inventory') return root.BioOrderDocuments?.downloadInventoryDocument(item.downloadId);
    if (item.downloadKind === 'remision') return root.BioOrderDocuments?.downloadShipmentDocument(item.downloadId);
    const collections = ['supplierInvoices', 'receipts', 'customerInvoices'];
    const source = collections.flatMap(key => operational[key] || []).find(row => text(row.id || row.folio) === item.downloadId);
    if (source && root.BioFlowDocs) return root.BioFlowDocs.download('audit', { id: source.id || source.folio, date: source.date || source.createdAt, status: source.status || source.type || 'Registrado', client: source.customerName || source.requisitionId, supplier: source.supplierName, currency: source.currency || 'MXN', reference: item.reference, description: item.title, total: source.amount || source.amountOriginal || source.total, notes: source.observations || source.observation || item.detail });
  }

  function exportCsv() {
    if (!root.BioAccess?.can('audit')) return;
    const quote = value => `"${text(value).replaceAll('"', '""')}"`, body = [['ID', 'Categoría', 'Registro', 'Origen', 'Referencia', 'Usuario', 'Fecha', 'Detalle'], ...visible.map(item => [item.id, labels[item.category], item.title, item.origin, item.reference, item.user, item.at, item.detail])].map(row => row.map(quote).join(',')).join('\r\n');
    const link = root.document.createElement('a'); link.href = URL.createObjectURL(new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' })); link.download = `auditoria-bio-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  q('#auditList')?.addEventListener('click', event => { const button = event.target.closest('[data-audit-download]'); if (button) download(visible.find(item => item.id === button.dataset.auditDownload)); });
  [['auditTotal', ''], ['auditDocuments', 'document'], ['auditMovements', 'movement'], ['auditUsers', 'access']].forEach(([id, category]) => { const card = q(`#${id}`)?.closest('article'); if (!card) return; card.classList.add('interactive-summary'); card.tabIndex = 0; card.setAttribute('role', 'button'); card.addEventListener('click', () => { q('#auditCategory').value = category; render(); q('#auditList').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } }); });
  ['auditSearch', 'auditDateFrom', 'auditDateTo'].forEach(id => q(`#${id}`)?.addEventListener('input', render)); q('#auditCategory')?.addEventListener('change', render);
  q('#auditReset')?.addEventListener('click', () => { ['auditSearch', 'auditCategory', 'auditDateFrom', 'auditDateTo'].forEach(id => { q(`#${id}`).value = ''; }); render(); });
  q('#exportAudit')?.addEventListener('click', exportCsv); root.document?.querySelectorAll('[data-view="auditView"]').forEach(link => link.addEventListener('click', render)); root.addEventListener?.('bio:access-changed', render); root.addEventListener?.('bio:fx-changed', render);
  root.BioAudit = { collect, render, exportCsv, preview: id => download(collect().find(item => item.id === id), true) }; render();
})(window);
