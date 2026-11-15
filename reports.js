(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const date = value => value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('es-MX', { dateStyle: 'medium' }) : 'Sin fecha';
  const money = (value, currency = 'MXN') => new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency === 'MULTI' ? 'MXN' : currency, maximumFractionDigits: 2 }).format(Number(value || 0));
  const label = value => ({ draft: 'Borrador', confirmed: 'Activado', purchasing: 'En compra', partially_purchased: 'Compra parcial', partially_received: 'Recepción parcial', received: 'Recibido', ready_to_deliver: 'Listo para entregar', partially_delivered: 'Parcial', delivered: 'Entregado', closed: 'Finalizado', cancelled: 'Cancelado', none: 'Sin entrega', partial: 'Entrega parcial', complete: 'Entrega completa' }[value] || value || 'Sin estado');
  const className = value => value === 'complete' || ['delivered', 'closed'].includes(value) ? 'ok' : value === 'cancelled' ? 'out' : value === 'partial' ? 'warning' : 'neutral';
  const toast = message => window.showToast?.(message);
  const inTraining = () => window.__BIO_TRAINING__ === true;
  let page = 1, latest = { records: [], pagination: { page: 1, pages: 1 } }, timer;
  const currentMonth = new Date().toISOString().slice(0, 7);

  function setupPeriod() {
    const year = $('#internalOrdersYear'); if (!year) return;
    const now = Math.max(2026, new Date().getFullYear()); year.innerHTML = Array.from({ length: 6 }, (_, index) => `<option value="${now + index}">${now + index}</option>`).join('');
    $('#internalOrdersMonth').value = currentMonth;
    updatePeriodFields();
  }
  function updatePeriodFields() {
    const value = $('#internalOrdersPeriod').value;
    $('#internalOrdersMonthField').hidden = value !== 'month';
    $('#internalOrdersYearField').hidden = value !== 'year';
    $('#internalOrdersFromField').hidden = value !== 'range';
    $('#internalOrdersToField').hidden = value !== 'range';
  }
  function params(includePaging = true) {
    const query = new URLSearchParams(), period = $('#internalOrdersPeriod').value;
    if (period === 'month') { const [year, month] = ($('#internalOrdersMonth').value || currentMonth).split('-'); query.set('year', year); query.set('month', month); }
    if (period === 'year') query.set('year', $('#internalOrdersYear').value);
    if (period === 'range') { if ($('#internalOrdersFrom').value) query.set('from', $('#internalOrdersFrom').value); if ($('#internalOrdersTo').value) query.set('to', $('#internalOrdersTo').value); }
    [['client', '#internalOrdersClient'], ['order', '#internalOrdersOrder'], ['supplierOrder', '#internalOrdersSupplierOrder'], ['seller', '#internalOrdersSeller'], ['status', '#internalOrdersStatus'], ['deliveryStatus', '#internalOrdersDelivery']].forEach(([key, selector]) => { const value = $(selector).value.trim(); if (value) query.set(key, value); });
    const productId = $('#internalOrdersProduct').dataset.productId || ''; if (productId) query.set('product', productId);
    if (includePaging) { query.set('page', String(page)); query.set('pageSize', '50'); }
    return query;
  }
  function trainingState() {
    const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
    return Object.fromEntries(['nexo-order-operations-v1', 'nexo-commercial-orders', 'nexo-clients'].map(key => [key, read(key)]).filter(([, value]) => value !== null));
  }
  async function reportData(includePaging = true) {
    if (inTraining()) {
      const core = window.BioInternalOrdersReport;
      if (!core) throw new Error('No fue posible preparar el reporte local de capacitación. Actualiza la página e inténtalo nuevamente.');
      const filters = Object.fromEntries(params(false));
      const report = core.buildInternalOrdersReport(trainingState(), null, filters);
      if (!includePaging) return { ...report, pagination: { page: 1, pageSize: report.records.length, total: report.records.length, pages: 1 } };
      return core.paginateReport(report, page, 50);
    }
    const query = params(includePaging); if (!includePaging) query.set('export', 'all');
    const response = await fetch(`/api/reports/internal-orders?${query}`, { credentials: 'same-origin' }), raw = await response.text(); let body;
    try { body = JSON.parse(raw); } catch { throw new Error('El servicio de reportes no respondió en el formato esperado. Actualiza la página e inténtalo nuevamente.'); }
    if (!response.ok) throw new Error(body.error || 'No fue posible consultar el reporte.');
    return body;
  }
  function render() {
    const summary = latest.summary || {};
    $('#internalOrdersTotal').textContent = summary.total || 0; $('#internalOrdersInProgress').textContent = summary.inProgress || 0; $('#internalOrdersPartial').textContent = summary.partial || 0; $('#internalOrdersComplete').textContent = summary.complete || 0; $('#internalOrdersNone').textContent = summary.none || 0;
    const pagination = latest.pagination || { page: 1, pages: 1, total: 0 };
    $('#internalOrdersCount').textContent = `${pagination.total || 0} pedido${pagination.total === 1 ? '' : 's'}`;
    $('#internalOrdersPage').textContent = `Página ${pagination.page} de ${pagination.pages}`;
    $('#internalOrdersPrevious').disabled = pagination.page <= 1; $('#internalOrdersNext').disabled = pagination.page >= pagination.pages;
    $('#internalOrdersList').innerHTML = latest.records.map(record => `<article class="internal-orders-row"><div><strong>${escapeHtml(record.id)}</strong><small>${date(record.date)} · ${escapeHtml(record.quotationId || 'Sin cotización')}</small></div><div><strong>${escapeHtml(record.clientNumber ? `${record.clientNumber} · ${record.client}` : record.client)}</strong><small>${escapeHtml(record.seller || 'Sin vendedor')} · ${escapeHtml(record.amountLabel || 'Total con IVA')} ${record.currency === 'MULTI' ? 'por divisa' : money(record.amount, record.currency)}</small></div><span>${record.products.length} producto${record.products.length === 1 ? '' : 's'}</span><span>${record.purchaseOrders.map(order => escapeHtml(order.id)).join('<br>') || 'Sin OC'}</span><span>${record.delivered} de ${record.requested}<small>${record.pending} pendiente${record.pending === 1 ? '' : 's'}</small></span><span>${record.remissions.map(remission => escapeHtml(remission.id)).join('<br>') || 'Sin remisión'}</span><span><b class="status ${className(record.deliveryStatus)}">${label(record.deliveryStatus)}</b><small>${escapeHtml(label(record.status))}</small></span><button class="quotation-download" data-internal-order-detail="${escapeHtml(record.id)}" title="Ver detalle"><i data-lucide="eye"></i></button></article>`).join('') || '<div class="quotation-history-empty">No hay pedidos internos que coincidan con los filtros.</div>';
    window.lucide?.createIcons();
  }
  async function load() {
    const list = $('#internalOrdersList'); if (!list) return;
    list.setAttribute('aria-busy', 'true');
    try { latest = await reportData(true); render(); }
    catch (error) { list.innerHTML = `<div class="quotation-history-empty">${escapeHtml(error.message)}</div>`; }
    finally { list.removeAttribute('aria-busy'); }
  }
  function queueLoad() { clearTimeout(timer); timer = setTimeout(() => { page = 1; load(); }, 250); }
  function setSearchContext(message = '') { const context = $('#internalOrdersSearchContext'); context.textContent = message; context.hidden = !message; }
  function applyGlobalSearch(target) {
    if (!target || !$('#internalOrdersList')) return;
    $('#internalOrdersPeriod').value = 'all'; updatePeriodFields();
    $('#internalOrdersClient').value = ''; $('#internalOrdersProduct').value = ''; delete $('#internalOrdersProduct').dataset.productId;
    if (target.kind === 'client') {
      $('#internalOrdersClient').value = target.number || target.name;
      setSearchContext(`Mostrando pedidos internos del cliente: ${target.name}`);
    } else if (target.kind === 'product') {
      $('#internalOrdersProduct').value = `${target.number || target.sku} — ${target.name}`;
      $('#internalOrdersProduct').dataset.productId = target.id;
      setSearchContext(`Mostrando pedidos internos que contienen: ${target.number || target.sku} — ${target.name}`);
    }
    const url = new URL(window.location.href); url.searchParams.delete('internalClient'); url.searchParams.delete('internalProduct');
    url.searchParams.set(target.kind === 'client' ? 'internalClient' : 'internalProduct', target.id);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    page = 1; load();
  }
  window.BioInternalOrders = { applyGlobalSearch };
  function showDetail(record) {
    if (!record) return; $('#internalOrderReportTitle').textContent = `${record.id} · ${record.client}`;
    const selectedProduct = $('#internalOrdersProduct').dataset.productId || '';
    const productRows = record.products.map(product => `<tr class="${selectedProduct && String(product.productId) === selectedProduct ? 'is-search-match' : ''}"><td>${escapeHtml(product.sku)}</td><td>${escapeHtml(product.product)}</td><td>${product.requested}</td><td>${product.purchased}</td><td>${product.delivered}</td><td>${product.pending}${product.overDelivery ? ` <small>Sobreentrega +${product.overDelivery}</small>` : ''}</td></tr>`).join('');
    const purchaseRows = record.purchaseOrders.map(order => `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.supplier)}</td><td>${date(order.date)}</td><td>${escapeHtml(label(order.status))}</td><td>${order.items.map(item => `${escapeHtml(item.product?.sku || '')} · ${item.quantity}`).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="5">Sin OC de proveedor relacionada.</td></tr>';
    const remissionRows = record.remissions.flatMap(remission => remission.items.map(item => `<tr><td>${escapeHtml(remission.id)}</td><td>${date(remission.date)}</td><td>${escapeHtml(item.product?.sku || '')} · ${escapeHtml(item.product?.product || '')}</td><td>${item.quantity}</td><td>${remission.evidenceId ? escapeHtml(remission.evidenceId) : 'Sin evidencia'}</td></tr>`)).join('') || '<tr><td colspan="5">Sin remisiones válidas.</td></tr>';
    $('#internalOrderReportBody').innerHTML = `<section class="report-detail-summary"><strong>${escapeHtml(record.clientNumber ? `${record.clientNumber} — ${record.client}` : record.client)}</strong><span>${date(record.date)} · Vendedor: ${escapeHtml(record.seller || 'Sin asignar')}</span><span>Estado: ${escapeHtml(label(record.status))} · Entrega: ${escapeHtml(label(record.deliveryStatus))}</span></section><h3>Productos del pedido</h3><div class="report-detail-table"><table><thead><tr><th>SKU</th><th>Producto</th><th>Solicitado</th><th>Comprado</th><th>Entregado</th><th>Pendiente</th></tr></thead><tbody>${productRows}</tbody></table></div><h3>OC proveedor relacionadas</h3><div class="report-detail-table"><table><thead><tr><th>OC</th><th>Proveedor</th><th>Fecha</th><th>Estado</th><th>Partidas de este pedido</th></tr></thead><tbody>${purchaseRows}</tbody></table></div><h3>Remisiones válidas</h3><div class="report-detail-table"><table><thead><tr><th>Remisión</th><th>Fecha</th><th>Producto</th><th>Entregado</th><th>Evidencia</th></tr></thead><tbody>${remissionRows}</tbody></table></div>`;
    $('#internalOrderReportDetail').showModal(); window.lucide?.createIcons();
  }
  const reportPalette = { ink: '17221D', blue: '3157A4', lime: 'B9FA81', soft: 'EEF5F0', pale: 'F7F9FC', line: 'DCE6DF', text: '1F2C23', muted: '68766D', white: 'FFFFFF' };
  const reportFill = rgb => ({ patternType: 'solid', fgColor: { rgb } });
  const reportFont = (color = reportPalette.text, bold = false, size = 10) => ({ name: 'Aptos', sz: size, bold, color: { rgb: color } });
  const reportAlign = (horizontal = 'left', wrapText = false) => ({ horizontal, vertical: 'center', wrapText });
  const reportBorder = { style: 'thin', color: { rgb: reportPalette.line } };
  const reportStyles = {
    title: { fill: reportFill(reportPalette.ink), font: reportFont(reportPalette.white, true, 15), alignment: reportAlign() },
    subtitle: { fill: reportFill(reportPalette.ink), font: reportFont('C9D4E5', false, 9), alignment: reportAlign() },
    generated: { fill: reportFill(reportPalette.ink), font: reportFont('AFC0B6', false, 8), alignment: reportAlign() },
    metricLabel: { fill: reportFill(reportPalette.soft), font: reportFont(reportPalette.muted, true, 8), alignment: reportAlign('center'), border: { top: reportBorder, left: reportBorder, right: reportBorder } },
    metricValue: { fill: reportFill('FFFFFF'), font: reportFont(reportPalette.ink, true, 15), alignment: reportAlign('center'), border: { bottom: reportBorder, left: reportBorder, right: reportBorder } },
    header: { fill: reportFill(reportPalette.blue), font: reportFont(reportPalette.white, true, 8), alignment: reportAlign('center', true), border: { top: reportBorder, bottom: reportBorder, left: reportBorder, right: reportBorder } },
    text: { font: reportFont(reportPalette.text, false, 9), alignment: reportAlign('left', true), border: { bottom: reportBorder } },
    number: { font: reportFont(reportPalette.text, true, 9), alignment: reportAlign('right'), border: { bottom: reportBorder } },
    center: { font: reportFont(reportPalette.text, false, 9), alignment: reportAlign('center', true), border: { bottom: reportBorder } }
  };
  function exportDate(value) { if (!value) return ''; const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`); return Number.isNaN(parsed.getTime()) ? String(value) : parsed; }
  function exportScope() { const period = $('#internalOrdersPeriod').value, detail = period === 'month' ? ($('#internalOrdersMonth').value || currentMonth) : period === 'year' ? $('#internalOrdersYear').value : period === 'range' ? `${$('#internalOrdersFrom').value || 'inicio'} a ${$('#internalOrdersTo').value || 'hoy'}` : 'Todo el histórico'; return `Periodo: ${detail}`; }
  function reportSheet(rows, name, title, metrics = []) {
    const headers = Object.keys(rows[0] || { Información: 'Sin registros para los filtros seleccionados.' });
    const tableRows = rows.length ? rows.map(row => headers.map(key => /fecha/i.test(key) ? exportDate(row[key]) : row[key] ?? '')) : [['Sin registros para los filtros seleccionados.', ...headers.slice(1).map(() => '')]];
    const sheet = XLSX.utils.aoa_to_sheet([[title], [exportScope()], [`Generado el ${new Date().toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })}`], []]);
    const metricStart = metrics.length ? 4 : 4, headerRow = metrics.length ? 7 : 4, lastCol = Math.max(0, headers.length - 1), endRow = headerRow + tableRows.length;
    if (metrics.length) { XLSX.utils.sheet_add_aoa(sheet, [metrics.map(metric => metric.label), metrics.map(metric => metric.value), []], { origin: { r: metricStart, c: 0 } }); }
    XLSX.utils.sheet_add_aoa(sheet, [headers, ...tableRows], { origin: { r: headerRow, c: 0 } });
    sheet['!merges'] = [XLSX.utils.decode_range(`A1:${XLSX.utils.encode_col(lastCol)}1`), XLSX.utils.decode_range(`A2:${XLSX.utils.encode_col(lastCol)}2`), XLSX.utils.decode_range(`A3:${XLSX.utils.encode_col(lastCol)}3`)];
    sheet['!rows'] = [{ hpt: 27 }, { hpt: 18 }, { hpt: 16 }];
    ['A1', 'A2', 'A3'].forEach((address, index) => { if (sheet[address]) sheet[address].s = [reportStyles.title, reportStyles.subtitle, reportStyles.generated][index]; });
    if (metrics.length) metrics.forEach((_, column) => { const labelCell = sheet[XLSX.utils.encode_cell({ r: metricStart, c: column })], valueCell = sheet[XLSX.utils.encode_cell({ r: metricStart + 1, c: column })]; if (labelCell) labelCell.s = reportStyles.metricLabel; if (valueCell) valueCell.s = reportStyles.metricValue; });
    headers.forEach((header, column) => { const address = XLSX.utils.encode_cell({ r: headerRow, c: column }); if (sheet[address]) sheet[address].s = reportStyles.header; });
    tableRows.forEach((row, rowIndex) => row.forEach((value, column) => { const key = headers[column], address = XLSX.utils.encode_cell({ r: headerRow + 1 + rowIndex, c: column }), cell = sheet[address]; if (!cell) return; const numeric = typeof value === 'number', centered = /fecha|estado|unidad|cantidad|unidades|pendiente|sobreentrega/i.test(key); cell.s = numeric ? reportStyles.number : centered ? reportStyles.center : reportStyles.text; if (/fecha/i.test(key) && value instanceof Date) cell.z = 'yyyy-mm-dd'; if (/cantidad|unidades|pendiente|sobreentrega/i.test(key) && numeric) cell.z = '#,##0'; if (rowIndex % 2 === 1) cell.s = { ...cell.s, fill: reportFill(reportPalette.pale) }; }));
    sheet['!cols'] = headers.map((header, column) => { const longest = Math.max(header.length, ...tableRows.map(row => String(row[column] ?? '').length)); return { wch: /producto|cliente|proveedor/i.test(header) ? Math.min(44, Math.max(20, longest + 2)) : Math.min(30, Math.max(12, longest + 2)) }; });
    sheet['!autofilter'] = { ref: `A${headerRow + 1}:${XLSX.utils.encode_col(lastCol)}${endRow + 1}` };
    sheet['!freeze'] = { xSplit: 1, ySplit: headerRow + 1 };
    sheet['!margins'] = { left: .25, right: .25, top: .35, bottom: .35, header: .15, footer: .15 };
    sheet['!pageSetup'] = { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    return sheet;
  }
  async function exportReport() {
    if (!window.XLSX) return toast('No fue posible cargar el generador de Excel.');
    const button = $('#internalOrdersExport'), finish = window.BioOperationProgress?.start('Preparando reporte de pedidos internos…', button);
    try { const body = await reportData(false), records = body.records || [];
      const summary = records.map(record => ({ 'Pedido Interno': record.id, 'Fecha Pedido': record.date, 'Cotización origen': record.quotationId, 'Número Cliente': record.clientNumber, Cliente: record.client, Vendedor: record.seller, 'Estado Pedido': label(record.status), 'Estado Entrega': label(record.deliveryStatus), 'Cantidad Productos': record.products.length, 'Unidades solicitadas': record.requested, 'Unidades entregadas': record.delivered, 'Unidades pendientes': record.pending, 'OC Proveedor relacionadas': record.purchaseOrders.map(order => order.id).join(' / '), Remisiones: record.remissions.map(remission => remission.id).join(' / ') }));
      const products = records.flatMap(record => record.products.map(product => ({ 'Pedido Interno': record.id, 'Número Cliente': record.clientNumber, Cliente: record.client, SKU: product.sku, Producto: product.product, Unidad: product.unit, 'Cantidad solicitada': product.requested, 'Cantidad comprada': product.purchased, 'Cantidad entregada': product.delivered, Pendiente: product.pending, 'Estado entrega': label(product.deliveryStatus), Sobreentrega: product.overDelivery })));
      const purchases = records.flatMap(record => record.purchaseOrders.flatMap(order => order.items.map(item => ({ 'Pedido Interno': record.id, 'OC Proveedor': order.id, Proveedor: order.supplier, SKU: item.product?.sku || '', Producto: item.product?.product || '', 'Cantidad comprada': item.quantity, 'Fecha OC': order.date, 'Estado OC': label(order.status) }))));
      const remissions = records.flatMap(record => record.remissions.flatMap(remission => remission.items.map(item => ({ 'Pedido Interno': record.id, Remisión: remission.id, 'Fecha remisión': remission.date, 'Número Cliente': record.clientNumber, Cliente: record.client, SKU: item.product?.sku || '', Producto: item.product?.product || '', 'Cantidad entregada': item.quantity, 'Estado remisión': label(remission.status), Evidencia: remission.evidenceId || '' }))));
      const complete = records.filter(record => record.deliveryStatus === 'complete').length, metrics = [{ label: 'PEDIDOS INTERNOS', value: records.length }, { label: 'UNIDADES SOLICITADAS', value: records.reduce((sum, record) => sum + Number(record.requested || 0), 0) }, { label: 'UNIDADES ENTREGADAS', value: records.reduce((sum, record) => sum + Number(record.delivered || 0), 0) }, { label: 'UNIDADES PENDIENTES', value: records.reduce((sum, record) => sum + Number(record.pending || 0), 0) }, { label: 'ENTREGA COMPLETA', value: complete }];
      const book = XLSX.utils.book_new(); [[summary, 'Resumen pedidos', 'Reporte general de pedidos internos', metrics], [products, 'Detalle productos', 'Detalle de productos solicitados'], [purchases, 'OC proveedores', 'Órdenes de compra relacionadas'], [remissions, 'Remisiones', 'Remisiones y evidencias de entrega']].forEach(([rows, name, title, sheetMetrics]) => XLSX.utils.book_append_sheet(book, reportSheet(rows, name, title, sheetMetrics), name)); XLSX.writeFile(book, `reporte-pedidos-internos-${new Date().toISOString().slice(0, 10)}.xlsx`); toast(`Reporte descargado con ${records.length} pedidos.`);
    } catch (error) { toast(error.message || 'No fue posible descargar el reporte.'); } finally { finish?.(); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!$('#internalOrdersList')) return; setupPeriod();
    ['#internalOrdersClient', '#internalOrdersOrder', '#internalOrdersSupplierOrder', '#internalOrdersSeller'].forEach(selector => $(selector).addEventListener('input', queueLoad));
    ['#internalOrdersPeriod', '#internalOrdersMonth', '#internalOrdersYear', '#internalOrdersFrom', '#internalOrdersTo', '#internalOrdersStatus', '#internalOrdersDelivery'].forEach(selector => $(selector).addEventListener('change', () => { if (selector === '#internalOrdersPeriod') updatePeriodFields(); page = 1; load(); }));
    $('#internalOrdersClear').addEventListener('click', () => { $('#internalOrdersClient').value = ''; $('#internalOrdersProduct').value = ''; delete $('#internalOrdersProduct').dataset.productId; $('#internalOrdersOrder').value = ''; $('#internalOrdersSupplierOrder').value = ''; $('#internalOrdersSeller').value = ''; $('#internalOrdersStatus').value = ''; $('#internalOrdersDelivery').value = ''; $('#internalOrdersPeriod').value = 'month'; $('#internalOrdersMonth').value = currentMonth; $('#internalOrdersFrom').value = ''; $('#internalOrdersTo').value = ''; setSearchContext(); const url = new URL(window.location.href); url.searchParams.delete('internalClient'); url.searchParams.delete('internalProduct'); window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`); updatePeriodFields(); page = 1; load(); });
    $('#internalOrdersPrevious').addEventListener('click', () => { page--; load(); }); $('#internalOrdersNext').addEventListener('click', () => { page++; load(); }); $('#internalOrdersExport').addEventListener('click', exportReport);
    $('#internalOrdersList').addEventListener('click', event => showDetail(latest.records.find(record => record.id === event.target.closest('[data-internal-order-detail]')?.dataset.internalOrderDetail)));
    ['#internalOrderReportClose', '#internalOrderReportCloseFooter'].forEach(selector => $(selector).addEventListener('click', () => $('#internalOrderReportDetail').close()));
    load();
  });
})();
