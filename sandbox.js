(function (root) {
  'use strict';
  const STORAGE_KEY = 'bio-sandbox-v1';
  const STEPS = [
    { id: 'quotation', label: 'Cotización', short: 'Propuesta', title: 'Emitir cotización de prueba', description: 'Creará el primer documento del expediente simulado.', prefix: 'TEST-COT', icon: 'file-text', kind: 'document', stock: 0 },
    { id: 'client_order', label: 'OC cliente', short: 'Autorización', title: 'Generar OC del cliente', description: 'Congelará precios y vinculará la autorización comercial.', prefix: 'TEST-OC', icon: 'clipboard-list', kind: 'document', stock: 0 },
    { id: 'supplier_order', label: 'OC proveedor', short: 'Compra', title: 'Generar OC al proveedor', description: 'Asignará el producto de entrenamiento al proveedor simulado.', prefix: 'TEST-OCP', icon: 'shopping-cart', kind: 'document', stock: 0 },
    { id: 'entry', label: 'Entrada', short: 'Recepción', title: 'Registrar entrada simulada', description: 'Recibirá 5 unidades sin modificar el almacén real.', prefix: 'TEST-ENT', icon: 'arrow-down-to-line', kind: 'movement', stock: 5 },
    { id: 'exit', label: 'Salida', short: 'Entrega', title: 'Registrar salida simulada', description: 'Descontará 5 unidades únicamente del stock de entrenamiento.', prefix: 'TEST-SAL', icon: 'arrow-up-from-line', kind: 'movement', stock: -5 },
    { id: 'shipment', label: 'Remisión', short: 'Cierre', title: 'Emitir remisión de prueba', description: 'Cerrará el expediente y habilitará la evidencia descargable.', prefix: 'TEST-REM', icon: 'truck', kind: 'document', stock: 0 }
  ];
  const q = selector => root.document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const initialState = () => ({ version: 1, sessionId: `TEST-${Date.now().toString(36).toUpperCase()}`, startedAt: new Date().toISOString(), step: 0, stock: 12, events: [] });
  const load = () => { try { const state = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null'); return state?.version === 1 && Array.isArray(state.events) ? state : initialState(); } catch { return initialState(); } };
  let state = load();
  const persist = () => root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const user = () => root.BioAccess?.currentUser() || { name: 'Usuario de prueba', role: 'seller' };
  const roleName = () => root.BioAccess?.role(user().role)?.name || user().role;
  const folio = (step, index) => `${step.prefix}-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${String(index + 1).padStart(3, '0')}`;
  const documentKind = action => ({ quotation: 'quotation', client_order: 'client_order', supplier_order: 'supplier_order', entry: 'inventory_entry', exit: 'inventory_exit', shipment: 'remision' }[action]);

  function render() {
    if (!q('#sandboxFlow') || !root.BioAccess?.can('sandbox')) return;
    q('#sandboxStepMetric').textContent = `${state.step} / ${STEPS.length}`; q('#sandboxStockMetric').textContent = `${state.stock} uds.`; q('#sandboxDocumentMetric').textContent = state.events.filter(event => event.kind === 'document').length; q('#sandboxRoleMetric').textContent = roleName();
    q('#sandboxFlow').innerHTML = STEPS.map((step, index) => `<div class="sandbox-flow-step ${index < state.step ? 'complete' : index === state.step ? 'active' : ''}"><span>${index < state.step ? '<i data-lucide="check"></i>' : index + 1}</span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.short)}</small></div>`).join('');
    const next = STEPS[state.step]; q('#sandboxNext').disabled = !next; q('#sandboxNext').classList.toggle('complete', !next); q('#sandboxNext').querySelector('span').textContent = next ? 'Ejecutar paso' : 'Prueba completada'; q('#sandboxNextTitle').textContent = next?.title || 'Flujo de prueba completado'; q('#sandboxNextDescription').textContent = next?.description || 'Puedes descargar la evidencia o restablecer el entorno para comenzar de nuevo.';
    q('#sandboxDownload').disabled = !state.events.length;
    q('#sandboxHistory').innerHTML = state.events.length ? [...state.events].reverse().map(event => `<article class="sandbox-history-row"><div><span class="event-icon"><i data-lucide="${escapeHtml(event.icon)}"></i></span><div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.detail)}</small></div></div><div><button type="button" class="sandbox-folio-preview" data-sandbox-preview="${escapeHtml(event.id)}"><strong>${escapeHtml(event.folio)}</strong><small>${event.kind === 'document' ? 'Documento de entrenamiento' : `Movimiento · ${event.quantity > 0 ? '+' : ''}${event.quantity} uds.`}</small></button></div><div><strong>${escapeHtml(event.user)}</strong><small>${escapeHtml(event.role)}</small></div><div><strong>${new Date(event.at).toLocaleDateString('es-MX')}</strong><small>${new Date(event.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</small></div><div class="document-action-pair"><button type="button" class="sandbox-document-download" data-sandbox-preview="${escapeHtml(event.id)}" aria-label="Vista previa del comprobante ${escapeHtml(event.folio)}" title="Vista previa"><i data-lucide="eye"></i><span>Ver</span></button><button type="button" class="sandbox-document-download" data-sandbox-download="${escapeHtml(event.id)}" aria-label="Descargar comprobante ${escapeHtml(event.folio)}" title="Descargar"><i data-lucide="download"></i></button></div></article>`).join('') : '<div class="sandbox-empty"><i data-lucide="flask-conical"></i><strong>Aún no hay movimientos de prueba</strong><span>Ejecuta el primer paso para comenzar la trazabilidad.</span></div>';
    root.lucide?.createIcons();
  }

  function executeStep() {
    if (!root.BioAccess?.can('sandbox')) return;
    const step = STEPS[state.step]; if (!step) return;
    const actor = user(), event = { id: `${state.sessionId}-${step.id}`, step: state.step + 1, action: step.id, title: step.title, detail: `${step.description} Producto TEST-001 · Pedido 5 uds.`, folio: folio(step, state.step), icon: step.icon, kind: step.kind, quantity: step.stock, stockBefore: state.stock, stockAfter: state.stock + step.stock, user: actor.name, role: roleName(), at: new Date().toISOString() };
    state.stock = event.stockAfter; state.step += 1; state.events.push(event); persist(); render(); root.showToast?.(`${event.folio} registrado únicamente en el área de pruebas.`);
  }

  function reset() {
    const apply = () => { state = initialState(); persist(); render(); root.showToast?.('Área de pruebas restablecida. La operación real no fue modificada.'); };
    if (typeof root.showActionConfirmation === 'function') root.showActionConfirmation({ kicker: 'RESTABLECER ENTORNO', title: '¿Eliminar esta simulación?', text: 'Solo se borrarán los folios, movimientos e historial del área de pruebas. La información operativa permanecerá intacta.', summaryTitle: 'DATOS DE ENTRENAMIENTO', items: [{ name: `${state.events.length} eventos de prueba`, detail: `${state.step} de ${STEPS.length} pasos completados · ${state.sessionId}`, value: `${state.stock} uds. simuladas`, delta: 0 }], confirmLabel: 'Restablecer prueba', onConfirm: apply });
    else if (root.confirm('¿Restablecer únicamente el área de pruebas?')) apply();
  }

  function downloadEvidence(preview = false) {
    if (!state.events.length || !root.BioAccess?.can('sandbox')) return;
    if (root.BioFlowDocs) return root.BioFlowDocs[preview ? 'preview' : 'download']('audit', { id: state.sessionId, date: state.startedAt, status: state.step === STEPS.length ? 'Prueba completada' : 'Prueba en curso', client: 'Cliente de entrenamiento', origin: `${user().name} · ${roleName()}`, currency: 'MXN', reference: 'ENTORNO AISLADO · SIN VALIDEZ OPERATIVA', items: state.events.map(event => ({ catalog: event.folio, description: `${event.title} · ${event.detail}`, quantity: event.quantity || 1 })), notes: 'DOCUMENTO DE PRUEBA SIN VALIDEZ. No representa inventario, compras, ventas ni movimientos reales de PROBIOLAB.', auditId: state.sessionId }, { filename: `evidencia-${state.sessionId}.pdf` });
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), link = root.document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `evidencia-${state.sessionId}.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  function downloadEvent(eventId, preview = false) {
    if (!root.BioAccess?.can('sandbox')) return;
    const event = state.events.find(item => item.id === eventId), kind = documentKind(event?.action);
    if (!event || !kind) return;
    const payload = { id: event.folio, date: event.at, status: 'Comprobante de prueba', client: 'Cliente de entrenamiento', supplier: event.action === 'supplier_order' ? 'Proveedor de entrenamiento' : undefined, warehouse: ['entry', 'exit'].includes(event.action) ? 'Almacén simulado' : undefined, origin: `${event.user} · ${event.role}`, currency: 'MXN', reference: `${state.sessionId} · ENTORNO AISLADO`, related: 'Producto TEST-001 · Pedido simulado de 5 uds.', items: [{ catalog: 'TEST-001', description: 'Reactivo control Bio · Producto de entrenamiento', quantity: Math.abs(event.quantity) || 5 }], notes: `DOCUMENTO DE PRUEBA SIN VALIDEZ OPERATIVA. ${event.detail} Stock simulado: ${event.stockBefore} → ${event.stockAfter} uds.`, auditId: event.id };
    if (root.BioFlowDocs) return root.BioFlowDocs[preview ? 'preview' : 'download'](kind, payload, { filename: `${event.folio}.pdf` });
    const blob = new Blob([JSON.stringify({ ...payload, type: kind }, null, 2)], { type: 'application/json' }), link = root.document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${event.folio}.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  q('#sandboxNext')?.addEventListener('click', executeStep); q('#sandboxReset')?.addEventListener('click', reset); q('#sandboxDownload')?.addEventListener('click', () => downloadEvidence(true));
  q('#sandboxHistory')?.addEventListener('click', event => { const preview = event.target.closest('[data-sandbox-preview]'), download = event.target.closest('[data-sandbox-download]'); if (preview) downloadEvent(preview.dataset.sandboxPreview, true); else if (download) downloadEvent(download.dataset.sandboxDownload); });
  root.document.querySelectorAll('[data-view="sandboxView"]').forEach(link => link.addEventListener('click', render)); root.addEventListener('bio:access-changed', render);
  root.BioSandbox = { STORAGE_KEY, STEPS, getState: () => JSON.parse(JSON.stringify(state)), render, executeStep, downloadEvent }; render();
})(window);
