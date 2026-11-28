/* Pedido interno: flujo independiente, trazable y respaldado por la API. */
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const state = { id: null, client: null, quotations: [], selected: new Set(), items: [], conditionsAuto: '', conditionsEdited: false, paymentEdited: false, submitting: false, activationOrderId: null, openingExisting: false };
  const data = key => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
  const actor = () => window.BioAccess?.currentUser?.() || {};
  const toast = message => window.showToast?.(message);
  const clients = () => data('nexo-clients');
  const quotations = () => data('nexo-sales-quotations');
  const products = () => data('nexo-products');
  const inTraining = () => window.__BIO_TRAINING__ === true || document.documentElement.dataset.workspace === 'training';
  const quoteExpired = quote => window.BioQuotationConversion?.isExpired(quote) === true;
  const quoteStatus = quote => quoteExpired(quote) ? 'Vencida' : 'Vigente';
  const quotationAlreadyConverted = quote => data('nexo-commercial-orders').some(order => String(order.status || '').toLowerCase() !== 'cancelled' && (order.quotationIds || [order.quotationId]).filter(Boolean).map(String).includes(String(quote.id)));
  const sameValue = (left, right) => String(left ?? '') === String(right ?? '');
  const normalized = value => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  function availableQuotationsFor(client) {
    return quotations().filter(quote => {
      const belongsToClient = String(quote.clientId || '') === String(client.id) || normalized(quote.client) === normalized(client.name);
      return belongsToClient && !['cancelled', 'required'].includes(normalized(quote.status)) && !quote.locked && !quote.internalOrderId && !quote.commercialOrderId && !quotationAlreadyConverted(quote) && !quoteExpired(quote);
    });
  }

  function reset() {
    state.id = null; state.client = null; state.quotations = []; state.selected.clear(); state.items = []; state.conditionsAuto = ''; state.conditionsEdited = false; state.paymentEdited = false;
    $('#internalOrderClientSearch').value = ''; $('#internalOrderObservations').value = '';
    renderClients(); renderSelectedClient(); renderQuotes(); renderLines();
  }
  function renderClients() {
    const term = $('#internalOrderClientSearch').value.trim().toLowerCase();
    const eligible = clients().map(client => ({ client, availableQuotations: availableQuotationsFor(client) })).filter(({ client, availableQuotations }) => !client.retired && !client.blocked && normalized(client.status) !== 'inactive' && availableQuotations.length > 0);
    const matches = eligible.filter(({ client }) => !term || [client.internalNumber, client.name, client.contact, client.rfc].some(value => normalized(value).includes(normalized(term))));
    const rows = matches.slice(0, 8), total = matches.length;
    const heading = term ? `Coincidencias con cotización (${total})` : `Clientes activos con cotización (${total})`;
    $('#internalOrderClientResults').innerHTML = rows.length ? `<p class="internal-order-client-results-title">${heading}${total > rows.length ? ' · escribe para acotar la búsqueda' : ''}</p>${rows.map(({ client, availableQuotations }) => { const quotationCount = availableQuotations.length; return `<button type="button" data-internal-client="${esc(client.id)}"><strong>${esc(client.internalNumber || 'Sin número')} · ${esc(client.name)}</strong><small>${esc(client.contact || client.rfc || 'Sin contacto')} · ${quotationCount === 1 ? '1 cotización disponible' : `${quotationCount} cotizaciones disponibles`}</small></button>`; }).join('')}` : `<p class="empty-state">${term ? 'No hay clientes activos con cotizaciones que coincidan con la búsqueda.' : 'No hay clientes activos con cotizaciones disponibles.'}</p>`;
  }
  function renderSelectedClient() {
    const box = $('#internalOrderClientSelected'); box.hidden = !state.client;
    box.innerHTML = state.client ? `<i data-lucide="contact-round"></i><div><strong>${esc(state.client.internalNumber || '')} ${esc(state.client.name)}</strong><small>${esc(state.client.contact || '')} ${state.client.rfc ? `· ${esc(state.client.rfc)}` : ''}</small></div><button type="button" data-clear-internal-client aria-label="Cambiar cliente"><i data-lucide="x"></i></button>` : '';
    window.lucide?.createIcons();
  }
  async function selectClient(client) {
    if (state.client && state.client.id !== client.id && state.items.length && !window.confirm('Cambiar de cliente eliminará las cotizaciones y partidas del borrador. ¿Deseas continuar?')) return;
    state.id = null; state.client = client; state.quotations = []; state.selected.clear(); state.items = []; state.conditionsAuto = ''; state.conditionsEdited = false; state.paymentEdited = false; $('#internalOrderClientSearch').value = ''; $('#internalOrderObservations').value = '';
    renderClients(); renderSelectedClient(); $('#internalOrderQuotationResults').innerHTML = '<p class="empty-state">Cargando cotizaciones del cliente…</p>'; renderLines();
    // El contador y el detalle usan la misma colección ya sincronizada. Esto evita
    // discrepancias visuales y una consulta adicional por cada selección de cliente.
    if (inTraining()) {
      state.quotations = availableQuotationsFor(client);
      renderQuotes();
      return;
    }
    state.quotations = availableQuotationsFor(client);
    renderQuotes();
  }
  function renderQuotes() {
    const target = $('#internalOrderQuotationResults');
    if (!state.client) { target.innerHTML = '<p class="empty-state">Primero selecciona un cliente.</p>'; return; }
    if (!state.quotations.length) { target.innerHTML = '<p class="empty-state">Este cliente aún no tiene cotizaciones disponibles.</p>'; return; }
    target.innerHTML = state.quotations.map(quote => { const checked = state.selected.has(String(quote.id)), status = quoteStatus(quote); return `<label class="internal-order-quote ${checked ? 'selected' : ''}"><input type="checkbox" value="${esc(quote.id)}" ${checked ? 'checked' : ''} /><span><strong>${esc(quote.id)}</strong><small>${esc(quote.createdAt || '')} · ${quote.items?.length || 0} ${quote.items?.length === 1 ? 'partida' : 'partidas'}</small></span><b class="status ${status === 'Vencida' ? 'low' : 'ok'}">${status}</b><em>${esc(quote.currency || 'MULTI')}</em></label>`; }).join('');
  }
  function quoteLine(quote, item, position) {
    const currency = String(item.currency || item.sourceCurrency || quote.currency || 'MXN').toUpperCase();
    const discount = Math.max(0, Number(item.discount || 0)), taxRate = window.BioCommercialMoney ? window.BioCommercialMoney.taxRate(quote) : quote.taxRate == null ? 16 : Math.max(0, Number(quote.taxRate || 0));
    const discountTotal = item.discountTotal ?? item.lineDiscount ?? item.discountAmount ?? null;
    return { id: `PIL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, productId: item.productId || null, number: item.number || '', sku: item.sku || '', name: item.name || item.description || 'Producto', description: item.description || item.name || '', unit: item.unit || 'unidad', quantity: Number(item.quantity || 0), unitPrice: Number(Number(item.unitPrice || 0).toFixed(2)), discount, discountTotal, taxRate, purchaseCost: null, currency, supplierId: item.supplierId || null, supplierRelationId: item.supplierRelationId || null, observations: '', sourceType: 'quotation', sources: [{ sourceType: 'quotation', quotationId: quote.id, quotationLineNo: position + 1, originalQuantity: Number(item.quantity || 0), originalUnitPrice: Number(Number(item.unitPrice || 0).toFixed(2)), discount, discountTotal, taxRate, currency }] };
  }
  function compatible(left, right) { return left.sourceType === 'quotation' && right.sourceType === 'quotation' && ['productId', 'sku', 'unit', 'currency', 'unitPrice', 'discount', 'taxRate', 'supplierId'].every(key => sameValue(left[key], right[key])); }
  function localizedDate(date) { return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }); }
  function paymentDateFor(quote, date) { const days = Math.max(0, Number(quote.creditDays || 0)); if (!days) return null; const due = new Date(date); due.setDate(due.getDate() + days); return due; }
  function inheritedConditions() {
    const today = new Date(), orderDate = localizedDate(today), selected = state.quotations.filter(quote => state.selected.has(String(quote.id)));
    if (!selected.length) return '';
    const blocks = selected.map(quote => {
      const due = paymentDateFor(quote, today), payment = String(quote.paymentTerms || '').trim(), policy = String(quote.pricePolicy || '').trim(), cancellation = String(quote.cancellationPolicy || '').trim(), instructions = String(quote.notes || '').trim();
      const lines = [`CONDICIONES HEREDADAS DE ${quote.id}`, `Pedido interno emitido el ${orderDate}.`];
      if (due) { const days = Number(quote.creditDays); lines.push(`Pago: ${quote.paymentMethod === 'credit' || !quote.paymentMethod ? `crédito de ${days} ${days === 1 ? 'día natural' : 'días naturales'}; fecha compromiso ${localizedDate(due)}.` : `fecha compromiso ${localizedDate(due)}.`}`); }
      else if (quote.paymentMethod) lines.push(`Forma de pago: ${quote.paymentMethod === 'cash' ? 'contado / transferencia.' : `${quote.paymentMethod}.`}`);
      if (payment) lines.push(`Condiciones de pago: ${payment}`);
      if (policy) lines.push(`Política de precios: ${policy}`);
      if (cancellation) lines.push(`Política de cancelación: ${cancellation}`);
      if (instructions) lines.push(`Instrucciones de la cotización: ${instructions}`);
      return lines.join('\n');
    });
    return blocks.join('\n\n');
  }
  function syncInheritedConditions() {
    const field = $('#internalOrderObservations'), next = inheritedConditions();
    if (!state.conditionsEdited || !field.value.trim() || field.value === state.conditionsAuto) field.value = next;
    state.conditionsAuto = next;
  }
  function paymentTermsOverride() { return { paymentMethod: $('#internalOrderPaymentMethod').value, creditDays: Number($('#internalOrderCreditDays').value || 0) }; }
  function syncPaymentControls() {
    const selected = state.quotations.filter(quote => state.selected.has(String(quote.id))), first = selected[0];
    if (first && !state.paymentEdited) {
      $('#internalOrderPaymentMethod').value = first.paymentMethod === 'cash' ? 'cash' : 'credit';
      const days = Math.max(0, Number(first.creditDays || 0)), select = $('#internalOrderCreditDays');
      if (![...select.options].some(option => Number(option.value) === days)) select.insertAdjacentHTML('beforeend', `<option value="${days}">${days} ${days === 1 ? 'día' : 'días'}</option>`);
      select.value = String(days);
    }
    const credit = $('#internalOrderPaymentMethod').value === 'credit', field = $('#internalOrderCreditDaysField');
    field.hidden = !credit; field.style.display = credit ? '' : 'none';
  }
  function refreshItemsFromQuotes() {
    const manual = state.items.filter(item => item.sourceType === 'manual'); let next = [...manual];
    state.quotations.filter(quote => state.selected.has(String(quote.id))).forEach(quote => (quote.items || []).forEach((item, index) => {
      const line = quoteLine(quote, item, index), existing = next.find(candidate => compatible(candidate, line));
      if (existing) { existing.quantity += line.quantity;if(existing.discountTotal!=null&&line.discountTotal!=null)existing.discountTotal=Number((Number(existing.discountTotal)+Number(line.discountTotal)).toFixed(2));else existing.discountTotal=null;existing.sources.push(...line.sources); } else next.push(line);
    }));
    state.items = next; syncInheritedConditions(); syncPaymentControls(); renderLines();
  }
  function totals() { const round=value=>Math.round((Number(value||0)+Number.EPSILON)*100)/100,buckets = new Map(); state.items.forEach(item => { const subtotal = round(Number(item.quantity || 0) * round(item.unitPrice)), discountTotal=item.discountTotal==null?round(subtotal*Number(item.discount||0)/100):round(item.discountTotal), taxable = round(subtotal-discountTotal), total = round(taxable+round(taxable*Number(item.taxRate ?? 16)/100)); buckets.set(item.currency, round((buckets.get(item.currency) || 0) + total)); }); return [...buckets].map(([currency, total]) => `${total.toLocaleString('es-MX', { style: 'currency', currency })} con IVA`).join(' · '); }
  function priceDirection(item) { const original = Number(item.sources?.find(source => source.sourceType === 'quotation')?.originalUnitPrice); const current = Number(item.unitPrice); return Number.isFinite(original) && original > 0 ? current > original ? 'price-up' : current < original ? 'price-down' : '' : ''; }
  function quotedQuantity(item) { return (item.sources || []).filter(source => source.sourceType === 'quotation').reduce((sum, source) => sum + Number(source.originalQuantity || 0), 0); }
  function quantityVariance(item) { const quoted = quotedQuantity(item), requested = Number(item.quantity || 0); return quoted > 0 && Math.abs(requested - quoted) > 0.000001 ? { itemId: item.id, productId: item.productId || null, catalog: item.number || item.sku || '', description: item.name || item.description || 'Producto', quotedQuantity: quoted, requestedQuantity: requested } : null; }
  function quantityVariances() { return state.items.map(quantityVariance).filter(Boolean); }
  function quantityVarianceMarkup(item) { const variance = quantityVariance(item); return variance ? `<small class="internal-order-quantity-change">⚠ Cotizada: ${variance.quotedQuantity} · Pedido: ${variance.requestedQuantity}</small>` : '<small class="internal-order-quantity-change"></small>'; }
  function renderLines() {
    const target = $('#internalOrderLines');
    target.innerHTML = state.items.length ? state.items.map((item, index) => `<article class="internal-order-line ${quantityVariance(item) ? 'quantity-changed' : ''}"><div><strong>${esc(item.number || item.sku || 'MANUAL')} · ${esc(item.name)}</strong><small>${esc(item.unit)} · ${esc(item.currency)} · Descuento ${Number(item.discount || 0)}% · ${item.sources.filter(source => source.sourceType === 'quotation').map(source => esc(source.quotationId)).filter((value, position, rows) => rows.indexOf(value) === position).join(', ') || 'Partida manual'}</small>${quantityVarianceMarkup(item)}</div><label>Cantidad<input type="number" min="0.000001" step="any" data-internal-line="${index}" data-internal-field="quantity" value="${Number(item.quantity)}" /></label><label class="internal-order-price ${priceDirection(item)}">Precio venta<input type="number" min="0" step="0.01" data-internal-line="${index}" data-internal-field="unitPrice" value="${Number(item.unitPrice || 0).toFixed(2)}" /><small class="internal-order-price-change">${priceDirection(item) === 'price-up' ? 'Precio aumentado' : priceDirection(item) === 'price-down' ? 'Precio disminuido' : ''}</small></label><button type="button" data-remove-internal-line="${index}" aria-label="Quitar partida"><i data-lucide="trash-2"></i></button></article>`).join('') : '<p class="empty-state">Selecciona cotizaciones para incorporar sus partidas.</p>';
    $('#internalOrderSummary').textContent = state.items.length ? `${state.items.length} partida${state.items.length === 1 ? '' : 's'} · ${totals()}` : 'Sin partidas.';
    window.lucide?.createIcons();
  }
  function renderProducts() {
    const query = $('#internalOrderProductSearch').value.trim().toLowerCase();
    const target = $('#internalOrderProductResults'); if (!query) { target.innerHTML = ''; return; }
    target.innerHTML = products().filter(product => [product.number, product.sku, product.name, product.brand].some(value => String(value || '').toLowerCase().includes(query))).slice(0, 8).map(product => `<button type="button" data-internal-product="${esc(product.id)}"><strong>${esc(product.number || product.sku || '')} · ${esc(product.name)}</strong><small>${esc(product.unit || 'unidad')} · ${esc(product.priceCurrency || product.salePriceCurrency || 'MXN')}</small></button>`).join('') || '<p class="empty-state">No hay coincidencias en el catálogo.</p>';
  }
  function addManual(product) {
    const selectedQuote = state.quotations.find(quote => state.selected.has(String(quote.id))), taxRate = selectedQuote?.taxRate == null ? 16 : Math.max(0, Number(selectedQuote.taxRate || 0));
    state.items.push({ id: `PIL-${Date.now()}-manual`, productId: product.id, number: product.number || '', sku: product.sku || '', name: product.name, description: product.description || product.name, unit: product.unit || 'unidad', quantity: 1, unitPrice: Number(product.salePrice || 0), discount: 0, taxRate, purchaseCost: null, currency: String(product.salePriceCurrency || product.priceCurrency || 'MXN').toUpperCase(), supplierId: product.supplierId || null, supplierRelationId: null, observations: '', sourceType: 'manual', sources: [{ sourceType: 'manual', quotationId: null, quotationLineNo: null, originalQuantity: null, originalUnitPrice: null, discount: 0, taxRate, currency: String(product.priceCurrency || 'MXN').toUpperCase() }] });
    $('#internalOrderProductSearch').value = ''; $('#internalOrderProductResults').innerHTML = ''; renderLines();
  }
  function payload(quantityVarianceAcknowledgement = null) { return { clientId: state.client?.id, quotationIds: [...state.selected], items: state.items, observations: $('#internalOrderObservations').value.trim(), commercialTermsOverride: paymentTermsOverride(), quantityVarianceAcknowledgement }; }
  function confirmQuantityVariances() {
    const variances = quantityVariances(); if (!variances.length) return null;
    const detail = variances.map(item => `• ${item.catalog || item.description}: cotizada ${item.quotedQuantity}, solicitada ${item.requestedQuantity}`).join('\n');
    if (!window.confirm(`Las cantidades del pedido son distintas a las aceptadas en la cotización:\n\n${detail}\n\n¿Confirmas que deseas continuar con estas cantidades?`)) return false;
    return { confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: actor().name || 'Usuario', variances };
  }
  function reflectQuotationConversion(order, required = false) {
    const ids = new Set((order.quotationIds || [order.quotationId]).filter(Boolean).map(String)), saved = quotations(), at = new Date().toISOString();
    const next = saved.map(quote => ids.has(String(quote.id)) ? { ...quote, commercialOrderId: order.id, internalOrderId: order.id, convertedAt: quote.convertedAt || at, ...(required ? { status: 'required', locked: true, requiredAtISO: quote.requiredAtISO || at } : {}) } : quote);
    const reflect = () => localStorage.setItem('nexo-sales-quotations', JSON.stringify(next));
    if (window.BioPersistence?.suspendWrites) window.BioPersistence.suspendWrites(reflect); else reflect();
    window.dispatchEvent(new CustomEvent('bio:quotation-converted', { detail: { orderId: order.id, quotationIds: [...ids], required, at } }));
  }
  function reflectSavedOrder(order) {
    const reflect = () => {
      const saved = data('nexo-commercial-orders'), next = [order, ...saved.filter(item => String(item.id) !== String(order.id))];
      localStorage.setItem('nexo-commercial-orders', JSON.stringify(next));
      try { const index = commercialOrders.findIndex(item => String(item.id) === String(order.id)); if (index >= 0) commercialOrders[index] = order; else commercialOrders.unshift(order); renderCommercialOrders($('#commercialOrderSearch')?.value || ''); } catch { /* La recarga recuperará el estado si la vista aún no se inicializó. */ }
    };
    // Crear/activar ya quedó confirmado por su endpoint transaccional. Reflejar
    // esa respuesta en pantalla no debe generar un segundo PUT de estado total:
    // una respuesta borrador retrasada podría degradar un pedido ya activado.
    return window.BioPersistence?.suspendWrites ? window.BioPersistence.suspendWrites(reflect) : reflect();
  }
  async function continueAfterActivation(order) {
    reflectSavedOrder(order);
    reflectQuotationConversion(order, true);
    await window.BioPersistence?.bootstrap?.();
    // El endpoint asigna las fechas y la bitácora definitivas del bloqueo.
    // Reemplazar la copia aproximada evita reenviarla al emitir otra cotización.
    window.dispatchEvent(new CustomEvent('bio:quotation-converted', { detail: { quotations: quotations() } }));
    window.dispatchEvent(new CustomEvent('bio:client-order-activated', { detail: { orderId: order.id } }));
    const destination = window.BioAccess?.can?.('supplier_order_manage') ? 'supplierOrdersView' : 'salesOrdersView';
    reset();
    document.querySelector(`[data-view="${destination}"]`)?.click();
    toast(destination === 'supplierOrdersView' ? `Pedido ${order.id} activado y enviado a propuestas de OC a proveedores.` : `Pedido ${order.id} activado y enviado al área de compras.`);
  }
  async function persist(activate = false, acceptanceReference = '') {
    if (!state.client || !state.selected.size || !state.items.length) { toast('Selecciona cliente, al menos una cotización y una partida.'); return; }
    if (activate && !acceptanceReference.trim()) { toast('La activación requiere la referencia de aceptación del cliente.'); return; }
    const varianceAcknowledgement = confirmQuantityVariances(); if (varianceAcknowledgement === false) { toast('No se guardó el pedido; revisa las cantidades antes de continuar.'); return; }
    if (state.submitting) return;
    state.submitting = true;
    const controls = [$('#saveInternalOrderDraft'), $('#activateInternalOrder')]; controls.forEach(button => { button.disabled = true; });
    const request = state.id ? { url: `/api/internal-orders/${encodeURIComponent(state.id)}`, method: 'PUT' } : { url: '/api/internal-orders', method: 'POST' };
    try {
      await window.BioPersistence?.flush?.({ throwOnError: true });
      let response = await fetch(request.url, { method: request.method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(varianceAcknowledgement)) });
      let body = await response.json(); if (!response.ok) throw new Error(body.error || 'No fue posible guardar el borrador.'); state.id = body.data.id; reflectSavedOrder(body.data); reflectQuotationConversion(body.data);
      if (!activate) { const savedId = state.id; reset(); toast(`Borrador ${savedId} guardado correctamente. Nuevo pedido interno quedó listo para una captura nueva.`); return; }
      response = await fetch(`/api/internal-orders/${encodeURIComponent(state.id)}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acceptance: { type: 'customer_po', reference: acceptanceReference.trim() } }) });
      body = await response.json(); if (!response.ok) throw new Error(body.error || 'No fue posible activar el pedido.'); await continueAfterActivation(body.data);
    } catch (error) { toast(error.message); }
    finally { state.submitting = false; controls.forEach(button => { button.disabled = false; }); }
  }
  function prefill(detail) { if (!detail?.clientId) return; const client = clients().find(item => String(item.id) === String(detail.clientId)); if (!client) return; selectClient(client).then(() => { (detail.quotationIds || []).forEach(id => state.selected.add(String(id))); refreshItemsFromQuotes(); }); }
  async function activateExisting(orderId, acceptanceReference) {
    if (state.submitting) return;
    state.submitting = true;
    try {
      await window.BioPersistence?.flush?.({ throwOnError: true });
      const response = await fetch(`/api/internal-orders/${encodeURIComponent(orderId)}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acceptance: { type: 'customer_po', reference: acceptanceReference } }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'No fue posible activar el pedido.'); await continueAfterActivation(body.data);
    } catch (error) { toast(error.message); }
    finally { state.submitting = false; }
  }
  function openActivationDialog(orderId = null) { const dialog = $('#internalOrderActivationDialog'), field = $('#internalOrderAcceptanceReference'); state.activationOrderId = orderId; field.value = ''; dialog.showModal(); window.lucide?.createIcons(); setTimeout(() => field.focus(), 40); }
  async function editExisting(order) {
    const client = clients().find(item => String(item.id) === String(order.clientId) || String(item.name || '').toLowerCase() === String(order.client || '').toLowerCase());
    if (!client) { toast('No se encontró el cliente relacionado con este pedido.'); return; }
    await selectClient(client); const linkedIds = new Set((order.quotationIds || [order.quotationId]).filter(Boolean).map(String)), linkedQuotes = quotations().filter(quote => linkedIds.has(String(quote.id))); state.quotations = [...new Map([...state.quotations, ...linkedQuotes].map(quote => [String(quote.id), quote])).values()]; state.id = order.id; state.selected = linkedIds; state.items = structuredClone(order.items || []); $('#internalOrderObservations').value = order.observations || ''; state.conditionsEdited = true; const override = order.commercialTermsOverride || order.commercialTerms?.[0] || {}; $('#internalOrderPaymentMethod').value = override.paymentMethod === 'cash' ? 'cash' : 'credit'; const creditDays = Number(override.creditDays || 0), creditSelect = $('#internalOrderCreditDays'); if (![...creditSelect.options].some(option => Number(option.value) === creditDays)) creditSelect.insertAdjacentHTML('beforeend', `<option value="${creditDays}">${creditDays} días</option>`); creditSelect.value = String(creditDays); state.paymentEdited = true; syncPaymentControls(); renderQuotes(); renderLines(); state.openingExisting = true; document.querySelector('[data-view="newInternalOrderView"]')?.click();
  }
  $('#internalOrderClientSearch').addEventListener('input', renderClients);
  $('#internalOrderClientResults').addEventListener('click', event => { const button = event.target.closest('[data-internal-client]'); if (button) selectClient(clients().find(item => String(item.id) === button.dataset.internalClient)); });
  $('#internalOrderClientSelected').addEventListener('click', event => { if (event.target.closest('[data-clear-internal-client]')) reset(); });
  $('#internalOrderQuotationResults').addEventListener('change', event => { if (!event.target.matches('input[type="checkbox"]')) return; const id = String(event.target.value); event.target.checked ? state.selected.add(id) : state.selected.delete(id); renderQuotes(); refreshItemsFromQuotes(); });
  $('#internalOrderAddManual').addEventListener('click', () => { $('#internalOrderManualPicker').hidden = !$('#internalOrderManualPicker').hidden; $('#internalOrderProductSearch').focus(); });
  $('#internalOrderProductSearch').addEventListener('input', renderProducts);
  $('#internalOrderProductResults').addEventListener('click', event => { const button = event.target.closest('[data-internal-product]'); if (button) addManual(products().find(item => String(item.id) === button.dataset.internalProduct)); });
  $('#internalOrderObservations').addEventListener('input', () => { state.conditionsEdited = $('#internalOrderObservations').value !== state.conditionsAuto; });
  $('#internalOrderLines').addEventListener('input', event => { const input = event.target, index = Number(input.dataset.internalLine); if (!Number.isInteger(index) || !input.dataset.internalField) return; const numericValue=input.value===''?null:Number(input.value);state.items[index][input.dataset.internalField]=input.dataset.internalField==='unitPrice'&&numericValue!==null?Math.round(numericValue*100)/100:numericValue; if (input.dataset.internalField === 'unitPrice') { const label = input.closest('.internal-order-price'), direction = priceDirection(state.items[index]); label.classList.toggle('price-up', direction === 'price-up'); label.classList.toggle('price-down', direction === 'price-down'); label.querySelector('.internal-order-price-change').textContent = direction === 'price-up' ? 'Precio aumentado' : direction === 'price-down' ? 'Precio disminuido' : ''; } if (input.dataset.internalField === 'quantity') { const row = input.closest('.internal-order-line'), variance = quantityVariance(state.items[index]); row.classList.toggle('quantity-changed', Boolean(variance)); row.querySelector('.internal-order-quantity-change').textContent = variance ? `⚠ Cotizada: ${variance.quotedQuantity} · Pedido: ${variance.requestedQuantity}` : ''; } $('#internalOrderSummary').textContent = `${state.items.length} ${state.items.length === 1 ? 'partida' : 'partidas'} · ${totals()}`; });
  ['#internalOrderPaymentMethod', '#internalOrderCreditDays'].forEach(selector => $(selector).addEventListener('change', () => { state.paymentEdited = true; syncPaymentControls(); }));
  $('#internalOrderLines').addEventListener('click', event => { const button = event.target.closest('[data-remove-internal-line]'); if (!button) return; state.items.splice(Number(button.dataset.removeInternalLine), 1); renderLines(); });
  $('#saveInternalOrderDraft').addEventListener('click', () => persist(false));
  $('#activateInternalOrder').addEventListener('click', () => { if (!state.client || !state.selected.size || !state.items.length) { toast('Selecciona cliente, al menos una cotización y una partida.'); return; } openActivationDialog(); });
  $('#internalOrderActivationForm').addEventListener('submit', event => { event.preventDefault(); const field = $('#internalOrderAcceptanceReference'), reference = field.value.trim(); if (!reference) { field.focus(); return; } const orderId = state.activationOrderId; $('#internalOrderActivationDialog').close(); state.activationOrderId = null; if (orderId) activateExisting(orderId, reference); else persist(true, reference); });
  document.querySelectorAll('.internal-order-activation-close').forEach(button => button.addEventListener('click', () => $('#internalOrderActivationDialog').close()));
  $('#backToInternalOrders').addEventListener('click', () => document.querySelector('[data-view="salesOrdersView"]')?.click());
  $('#goToNewQuotation').addEventListener('click', reset);
  $('#commercialOrderList').addEventListener('click', event => { const edit = event.target.closest('[data-edit-internal-order]'), activate = event.target.closest('[data-workflow-activate-internal-order]'); if (!edit && !activate) return; event.stopImmediatePropagation(); const id = (edit || activate).dataset.editInternalOrder || (edit || activate).dataset.workflowActivateInternalOrder, order = data('nexo-commercial-orders').find(item => String(item.id) === String(id)); if (activate && order) openActivationDialog(order.id); else if (edit && order) editExisting(order); }, true);
  window.addEventListener('bio:new-internal-order', event => { reset(); prefill(event.detail); });
  document.querySelectorAll('[data-view="newInternalOrderView"]').forEach(link => link.addEventListener('click', () => { if (state.openingExisting) { state.openingExisting = false; return; } reset(); }));
  renderClients();
  window.BioInternalOrdersWorkflow = { open: detail => { reset(); document.querySelector('[data-view="newInternalOrderView"]')?.click(); prefill(detail); } };
})();
