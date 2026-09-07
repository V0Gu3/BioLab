(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioFlowDocs = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  const BRAND = root?.PROBIOLAB_BRAND || { name: 'PROBIOLAB', documentName: 'PROBIOLAB', documentSubtitle: 'CONTROL OPERATIVO Y TRAZABILIDAD' };
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
  const currencyCode = value => String(value || 'MXN').trim().toUpperCase();
  // El símbolo "$" por sí solo es ambiguo. En documentos siempre se acompaña
  // del código ISO, incluso cuando el formateador local ya agrega uno.
  const moneyWithCode = (value, currency = 'MXN') => {
    const code = currencyCode(currency);
    return `${code} ${money(value, code).replace(new RegExp(`^${code}\\s*`, 'i'), '')}`;
  };
  function monetaryProfile(data) {
    const supplied = Array.isArray(data?.totalsByCurrency) ? data.totalsByCurrency.filter(entry => entry?.currency) : [];
    const items = Array.isArray(data?.items) ? data.items : [];
    const derived = new Map();
    if (!supplied.length) items.forEach(item => {
      const code = currencyCode(item?.currency || item?.sourceCurrency || data?.currency);
      const current = derived.get(code) || { currency: code, subtotal: 0, taxAmount: 0, total: 0 };
      const quantity = number(item?.quantity ?? item?.qty ?? 0), unitPrice = number(item?.unitPrice);
      const lineTotal = item?.total ?? item?.lineTotal;
      const subtotal = lineTotal == null ? quantity * unitPrice : number(lineTotal);
      current.subtotal += subtotal; current.total += subtotal; derived.set(code, current);
    });
    const totals = (supplied.length ? supplied : [...derived.values()]).map(entry => ({
      ...entry,
      currency: currencyCode(entry.currency),
      subtotal: number(entry.subtotal),
      taxAmount: number(entry.taxAmount),
      total: number(entry.total)
    }));
    const currencies = [...new Set(totals.map(entry => entry.currency))];
    return { totals, currency: currencies.length > 1 ? 'MULTI' : (currencies[0] || currencyCode(data?.currency)) };
  }
  const filename = (kind, id) => `${kind.replaceAll('_', '-')}-${clean(id || 'sin-folio')}.pdf`;
  const DOCUMENT_STYLE = Object.freeze({ headerHeight: 34, margin: 16, headerBackground: [18, 25, 38], secondaryText: [177, 190, 214] });
  let brandLogo;
  function loadBrandLogo() {
    if (brandLogo !== undefined) return Promise.resolve(brandLogo);
    if (!root?.Image) return Promise.resolve(brandLogo = null);
    return new Promise(resolve => { const image = new root.Image(); image.onload = () => { brandLogo = image; resolve(image); }; image.onerror = () => { brandLogo = null; resolve(null); }; image.src = BRAND.logo || 'assets/probiolab-logo-transparent.png'; });
  }
  function drawHeader(doc, { title, folio, legalName, continuation = false, logo = brandLogo } = {}) {
    const { headerHeight, margin, headerBackground, secondaryText } = DOCUMENT_STYLE;
    doc.setFillColor(...headerBackground); doc.rect(0, 0, 210, headerHeight, 'F');
    if (logo) { try { doc.addImage(logo, 'PNG', margin, 5, 30, 22); } catch {} }
    else { doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(BRAND.documentName, margin, 17); }
    const x = logo ? 50 : margin;
    doc.setTextColor(...secondaryText); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.3); doc.text(doc.splitTextToSize(clean(legalName || BRAND.documentSubtitle), 87), x, 15);
    doc.setTextColor(...secondaryText); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); doc.text(continuation ? 'CONTINUACIÓN' : clean(title || 'DOCUMENTO'), 194, 13, { align: 'right' });
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.text(clean(folio || '—'), 194, 21, { align: 'right' });
    return 43;
  }
  if (root?.document) void loadBrandLogo();

  function create(kind, payload, PDFClass) {
    if (!TYPES[kind]) throw new Error(`Tipo documental no soportado: ${kind}`);
    if (!PDFClass) throw new Error('El generador PDF no esta disponible.');
    const data = { currency: 'MXN', status: 'Emitido', items: [], ...payload };
    // `currency` es una conveniencia de cabecera, no la fuente financiera. Los
    // totales por moneda o, en su ausencia, las partidas estructuradas mandan.
    const profile = monetaryProfile(data), singleTotal = profile.totals.length === 1 ? profile.totals[0] : null;
    data.currency = profile.currency; data.totalsByCurrency = profile.totals;
    if (!data.id) throw new Error('El documento requiere folio.');
    const [title, subtitle] = TYPES[kind], doc = new PDFClass({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let y = 0;
    const header = continuation => { y = drawHeader(doc, { title, folio: data.id, legalName: data.issuer?.legalName || data.legalName || BRAND.legalName, continuation }); };
    const addPage = () => { doc.addPage(); header(true); };
    const ensure = height => { if (y + height > 269) addPage(); };
    const field = (label, value, x, width) => {
      doc.setTextColor(112, 121, 137); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.text(clean(label).toUpperCase(), x, y);
      doc.setTextColor(25, 30, 39); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(doc.splitTextToSize(clean(value || '-'), width), x, y + 6);
    };
    header(false);
    doc.setFillColor(247, 249, 252); doc.roundedRect(16, y - 4, 178, 29, 3, 3, 'F');
    field('Folio', data.id, 21, 48); field('Fecha', data.date || 'Sin fecha', 75, 36); field('Estado', data.status, 117, 32); field('Moneda', data.currency === 'MULTI' ? 'Multimoneda (totales separados)' : data.currency, 155, 34); y += 38;
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
      ensure(18); if (y === 43) tableHeader();
      const description = clean(`${item.catalog || 'S/C'} - ${item.description || 'Sin descripcion'}`), lines = doc.splitTextToSize(description, 104), rowHeight = Math.max(kind === 'audit' ? 13 : 15, lines.length * 4 + (kind === 'audit' ? 6 : 8));
      if (index % 2 === 0) { doc.setFillColor(249, 250, 252); doc.rect(16, y - 5, 178, rowHeight, 'F'); }
      doc.setTextColor(30, 37, 48); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(lines, 20, y + 1);
      const itemCurrency = currencyCode(item.currency || item.sourceCurrency || (data.currency === 'MULTI' ? null : data.currency));
      doc.setTextColor(59, 68, 82); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(clean(item.quantity ?? 0), 139, y + 1, { align: 'right' });
      doc.text(item.unitPrice == null ? '-' : moneyWithCode(item.unitPrice, itemCurrency), 164, y + 1, { align: 'right' });
      const lineTotal = item.total ?? item.lineTotal;
      doc.setFont('helvetica', 'bold'); doc.text(lineTotal == null ? '-' : moneyWithCode(lineTotal, itemCurrency), 190, y + 1, { align: 'right' }); y += rowHeight;
    });
    if (Array.isArray(data.totalsByCurrency) && data.totalsByCurrency.length > 1) {
      const totalRows = data.totalsByCurrency.reduce((count, entry) => count + 1 + (entry.subtotal != null ? 1 : 0) + (Number(entry.discountTotal || 0) ? 1 : 0) + (Number(entry.taxAmount || 0) ? 1 : 0), 0);
      ensure(18 + totalRows * 8); doc.setDrawColor(215, 221, 231); doc.line(117, y, 194, y); y += 7;
      doc.setTextColor(98, 108, 124); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('TOTALES POR MONEDA', 121, y); y += 8;
      data.totalsByCurrency.forEach(entry => {
        const totalLine = (label, amount, bold = false) => { doc.setTextColor(98, 108, 124); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 8.5 : 7.5); doc.text(`${label} ${entry.currency}`, 121, y); doc.setTextColor(25, 31, 42); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(moneyWithCode(amount, entry.currency), 190, y, { align: 'right' }); y += bold ? 8 : 7; };
        if (entry.subtotal != null) totalLine('Subtotal', entry.subtotal);
        if (Number(entry.discountTotal || 0)) totalLine('Descuento', -Number(entry.discountTotal));
        if (Number(entry.taxAmount || 0)) totalLine('Impuestos', entry.taxAmount);
        totalLine('TOTAL', entry.total, true);
      });
    } else if (data.total != null) {
      ensure(39); doc.setDrawColor(215, 221, 231); doc.line(117, y, 194, y); y += 7;
      const amountCurrency = singleTotal?.currency || data.currency;
      const totalLine = (label, value, bold) => { doc.setTextColor(98, 108, 124); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 9 : 7.5); doc.text(`${label} ${amountCurrency}`, 121, y); doc.setTextColor(25, 31, 42); doc.text(moneyWithCode(value, amountCurrency), 190, y, { align: 'right' }); y += bold ? 9 : 7; };
      if (data.subtotal != null || singleTotal) totalLine('Subtotal', singleTotal?.subtotal ?? data.subtotal, false);
      if (data.tax != null || singleTotal?.taxAmount) totalLine('Impuestos', singleTotal?.taxAmount ?? data.tax, false);
      totalLine('TOTAL', singleTotal?.total ?? data.total, true);
    }
    ensure(34); y += 3; doc.setFillColor(239, 244, 253); doc.roundedRect(16, y, 178, 24, 3, 3, 'F');
    doc.setTextColor(49, 87, 164); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('TRAZABILIDAD DOCUMENTAL', 21, y + 8);
    doc.setTextColor(76, 88, 108); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(doc.splitTextToSize(clean(data.notes || `${subtitle}. Documento relacionado: ${data.related || data.reference || 'sin referencia adicional'}.`), 165), 21, y + 15);
    const pages = doc.getNumberOfPages(), audit = clean(data.auditHash || data.auditId || `Registro auditable ${BRAND.name}`);
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
    dialog.dataset.objectUrl = objectUrl; title.textContent = options.title || `DOCUMENTO ${BRAND.name}`; folio.textContent = clean(options.folio || 'Vista previa'); downloadButton.onclick = () => { const link = root.document.createElement('a'); link.href = objectUrl; link.download = options.filename || `documento-${BRAND.name.toLowerCase()}.pdf`; link.click(); };
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

  return { TYPES, create, download, preview, previewBlob, present, filename, drawHeader, loadBrandLogo, DOCUMENT_STYLE, monetaryProfile, moneyWithCode };
});
