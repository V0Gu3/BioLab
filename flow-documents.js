(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioFlowDocs = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  const TYPES = {
    quotation: ['COTIZACION', 'Propuesta comercial'],
    client_order: ['ORDEN DE COMPRA DEL CLIENTE', 'Autorizacion comercial para surtido'],
    supplier_order: ['ORDEN DE COMPRA A PROVEEDOR', 'Abastecimiento relacionado por partida'],
    inventory_entry: ['ENTRADA DE ALMACEN', 'Recepcion auditable de mercancia'],
    inventory_exit: ['SALIDA DE ALMACEN', 'Egreso auditable contra entrega'],
    remision: ['REMISION', 'Comprobante de entrega al cliente'],
    audit: ['EXPEDIENTE OPERATIVO', 'Cadena documental y trazabilidad completa']
  };
  const clean = value => String(value ?? '').replace(/[→]/g, '->').replace(/[−–—]/g, '-').replace(/Â·/g, '-').replace(/Ã³/g, 'ó').replace(/Ã©/g, 'é').replace(/Ã­a/g, 'ía');
  const number = value => Number(value || 0);
  const money = (value, currency = 'MXN') => {
    try { return number(value).toLocaleString('es-MX', { style: 'currency', currency }); }
    catch { return `${number(value).toFixed(2)} ${currency}`; }
  };
  const filename = (kind, id) => `${kind.replaceAll('_', '-')}-${clean(id || 'sin-folio')}.pdf`;

  function create(kind, payload, PDFClass) {
    if (!TYPES[kind]) throw new Error(`Tipo documental no soportado: ${kind}`);
    if (!PDFClass) throw new Error('El generador PDF no esta disponible.');
    const data = { currency: 'MXN', status: 'Emitido', items: [], ...payload };
    if (!data.id) throw new Error('El documento requiere folio.');
    const [title, subtitle] = TYPES[kind], doc = new PDFClass({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let y = 0;
    const header = continuation => {
      doc.setFillColor(18, 25, 38); doc.rect(0, 0, 210, 41, 'F');
      doc.setFillColor(49, 87, 164); doc.roundedRect(16, 12, 16, 16, 3, 3, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('B', 24, 22.7, { align: 'center' });
      doc.setFontSize(15); doc.text('BIO', 38, 18.5); doc.setTextColor(177, 190, 214); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text('CONTROL OPERATIVO Y TRAZABILIDAD', 38, 25);
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(continuation ? 8 : 10); doc.text(continuation ? `${title} - CONTINUACION` : title, 194, 18, { align: 'right' });
      doc.setTextColor(177, 190, 214); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(clean(data.id), 194, 25, { align: 'right' });
      y = 51;
    };
    const addPage = () => { doc.addPage(); header(true); };
    const ensure = height => { if (y + height > 269) addPage(); };
    const field = (label, value, x, width) => {
      doc.setTextColor(112, 121, 137); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(clean(label).toUpperCase(), x, y);
      doc.setTextColor(25, 30, 39); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(doc.splitTextToSize(clean(value || '-'), width), x, y + 6);
    };
    header(false);
    doc.setFillColor(247, 249, 252); doc.roundedRect(16, y - 4, 178, 29, 3, 3, 'F');
    field('Folio', data.id, 21, 48); field('Fecha', data.date || 'Sin fecha', 75, 36); field('Estado', data.status, 117, 32); field('Moneda', data.currency, 155, 34); y += 38;
    doc.setFillColor(250, 251, 253); doc.setDrawColor(226, 230, 237); doc.roundedRect(16, y - 4, 178, 34, 3, 3, 'FD');
    field('Cliente / destino', data.client || data.warehouse || '-', 21, 77); field('Proveedor / origen', data.supplier || data.origin || '-', 105, 80);
    doc.setTextColor(104, 114, 130); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(doc.splitTextToSize(clean([data.reference, data.related].filter(Boolean).join(' - ') || subtitle), 166), 21, y + 21); y += 43;
    const tableHeader = () => {
      doc.setFillColor(49, 87, 164); doc.roundedRect(16, y - 5, 178, 10, 2, 2, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
      doc.text('CATALOGO / DESCRIPCION', 20, y + 1); doc.text('CANT.', 139, y + 1, { align: 'right' }); doc.text('P. UNIT.', 164, y + 1, { align: 'right' }); doc.text('IMPORTE', 190, y + 1, { align: 'right' }); y += 12;
    };
    doc.setTextColor(32, 39, 51); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text('PARTIDAS / OPERACIONES', 16, y); y += 8; tableHeader();
    const items = data.items.length ? data.items : [{ catalog: data.reference || data.id, description: data.description || subtitle, quantity: data.quantity || 1, unitPrice: data.unitPrice, total: data.total }];
    items.forEach((item, index) => {
      ensure(18); if (y === 51) tableHeader();
      const description = clean(`${item.catalog || 'S/C'} - ${item.description || 'Sin descripcion'}`), lines = doc.splitTextToSize(description, 104), rowHeight = Math.max(kind === 'audit' ? 13 : 15, lines.length * 4 + (kind === 'audit' ? 6 : 8));
      if (index % 2 === 0) { doc.setFillColor(249, 250, 252); doc.rect(16, y - 5, 178, rowHeight, 'F'); }
      doc.setTextColor(30, 37, 48); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(lines, 20, y + 1);
      doc.setTextColor(59, 68, 82); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(clean(item.quantity ?? 0), 139, y + 1, { align: 'right' });
      doc.text(item.unitPrice == null ? '-' : money(item.unitPrice, data.currency), 164, y + 1, { align: 'right' });
      doc.setFont('helvetica', 'bold'); doc.text(item.total == null ? '-' : money(item.total, data.currency), 190, y + 1, { align: 'right' }); y += rowHeight;
    });
    if (data.total != null) {
      ensure(39); doc.setDrawColor(215, 221, 231); doc.line(117, y, 194, y); y += 7;
      const totalLine = (label, value, bold) => { doc.setTextColor(98, 108, 124); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 9 : 7.5); doc.text(label, 121, y); doc.setTextColor(25, 31, 42); doc.text(money(value, data.currency), 190, y, { align: 'right' }); y += bold ? 9 : 7; };
      if (data.subtotal != null) totalLine('Subtotal', data.subtotal, false);
      if (data.tax != null) totalLine('Impuestos', data.tax, false);
      totalLine('TOTAL', data.total, true);
    }
    ensure(34); y += 3; doc.setFillColor(239, 244, 253); doc.roundedRect(16, y, 178, 24, 3, 3, 'F');
    doc.setTextColor(49, 87, 164); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('TRAZABILIDAD DOCUMENTAL', 21, y + 8);
    doc.setTextColor(76, 88, 108); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(doc.splitTextToSize(clean(data.notes || `${subtitle}. Documento relacionado: ${data.related || data.reference || 'sin referencia adicional'}.`), 165), 21, y + 15);
    const pages = doc.getNumberOfPages(), audit = clean(data.auditHash || data.auditId || 'Registro auditable Bio');
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page); doc.setDrawColor(224, 228, 235); doc.line(16, 281, 194, 281); doc.setTextColor(117, 126, 141); doc.setFont('courier', 'normal'); doc.setFontSize(5.8); doc.text(`Auditoria: ${audit.slice(0, 72)}`, 16, 287); doc.setFont('helvetica', 'normal'); doc.text(`Pagina ${page} de ${pages}`, 194, 287, { align: 'right' });
    }
    return doc;
  }

  function download(kind, payload, options = {}) {
    const PDFClass = options.PDFClass || (typeof window !== 'undefined' && window.jspdf?.jsPDF);
    const doc = create(kind, payload, PDFClass);
    doc.save(options.filename || filename(kind, payload.id));
    return doc;
  }

  function previewBlob(blob, options = {}) {
    if (!root?.document) return blob;
    const dialog = root.document.querySelector('#documentPreviewDialog'), frame = root.document.querySelector('#documentPreviewFrame'), title = root.document.querySelector('#documentPreviewTitle'), folio = root.document.querySelector('#documentPreviewFolio'), downloadButton = root.document.querySelector('#documentPreviewDownload');
    if (!dialog || !frame || !downloadButton) return blob;
    if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(blob), canvasArea = root.document.createElement('div');
    canvasArea.id = 'documentPreviewPages'; canvasArea.className = 'document-preview-pages'; canvasArea.innerHTML = '<span class="document-preview-loading">Preparando vista previa…</span>'; frame.hidden = true; frame.before(canvasArea);
    dialog.dataset.objectUrl = objectUrl; title.textContent = options.title || 'DOCUMENTO BIO'; folio.textContent = clean(options.folio || 'Vista previa'); downloadButton.onclick = () => { const link = root.document.createElement('a'); link.href = objectUrl; link.download = options.filename || 'documento-bio.pdf'; link.click(); };
    if (blob.type === 'application/pdf' && root.pdfjsLib) {
      root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      blob.arrayBuffer().then(data => root.pdfjsLib.getDocument({ data }).promise).then(async pdf => { canvasArea.innerHTML = ''; for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) { const page = await pdf.getPage(pageNumber), viewport = page.getViewport({ scale: 1.45 }), canvas = root.document.createElement('canvas'), context = canvas.getContext('2d'); canvas.width = viewport.width; canvas.height = viewport.height; canvas.setAttribute('aria-label', `Página ${pageNumber} de ${pdf.numPages}`); canvasArea.appendChild(canvas); await page.render({ canvasContext: context, viewport }).promise; } }).catch(() => { canvasArea.remove(); frame.hidden = false; frame.src = objectUrl; });
    } else { canvasArea.remove(); frame.hidden = false; frame.src = objectUrl; }
    dialog.showModal(); root.lucide?.createIcons();
    return blob;
  }

  function present(doc, options = {}) {
    previewBlob(doc.output('blob'), options);
    return doc;
  }

  function preview(kind, payload, options = {}) {
    const PDFClass = options.PDFClass || root?.jspdf?.jsPDF;
    const doc = create(kind, payload, PDFClass);
    return present(doc, { ...options, title: TYPES[kind][0], folio: payload.id, filename: options.filename || filename(kind, payload.id) });
  }

  if (root?.document) {
    root.document.addEventListener('click', event => { const close = event.target.closest('[data-close-document-preview]'); if (close) root.document.querySelector('#documentPreviewDialog')?.close(); });
    root.document.addEventListener('cancel', event => { if (event.target?.id === 'documentPreviewDialog') { event.preventDefault(); event.target.close(); } }, true);
    root.document.addEventListener('close', event => { if (event.target?.id !== 'documentPreviewDialog') return; const dialog = event.target, frame = root.document.querySelector('#documentPreviewFrame'); root.document.querySelector('#documentPreviewPages')?.remove(); if (frame) { frame.removeAttribute('src'); frame.hidden = false; } if (dialog.dataset.objectUrl) URL.revokeObjectURL(dialog.dataset.objectUrl); delete dialog.dataset.objectUrl; }, true);
  }

  return { TYPES, create, download, preview, previewBlob, present, filename };
});
