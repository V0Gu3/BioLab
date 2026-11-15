(function () {
  'use strict';
  const access = window.BioAccess;
  if (!access) return;
  const q = selector => document.querySelector(selector);
  const toast = message => window.showToast?.(message) || window.alert(message);
  const switcher = q('#workspaceSwitcher'), menu = q('#workspaceMenu'), toggle = q('#workspaceToggle');

  function renderWorkspace() {
    const state = access.workspace(), user = access.currentUser(), canTrain = access.can('sandbox', user), isAdmin = ['administrator', 'developer'].includes(user?.role);
    q('#workspaceCurrentLabel').textContent = state.mode === 'training' ? 'Pruebas' : 'Operativo';
    q('#workspaceSwitcher').classList.toggle('training-active', state.mode === 'training');
    q('#workspaceSwitcher').removeAttribute('aria-busy');
    document.documentElement.dataset.workspace = state.mode;
    q('#trainingWorkspaceNotice').hidden = state.mode !== 'training';
    q('#workspaceSandboxEnabled').checked = state.sandboxEnabled;
    q('#workspaceAdminToggle').hidden = !isAdmin;
    q('[data-workspace-guide]').hidden = !canTrain;
    document.querySelectorAll('[data-view="auditView"], [data-access="audit"]').forEach(link => { link.hidden = state.mode === 'training' || !access.can('audit', user); });
    const canManageInventory = access.can('inventory_manage', user), canManageCatalog = access.can('catalog_manage', user), canSeeSuppliers = access.can('supplier_view', user), canSeeSupplierOrders = access.can('supplier_order_view', user), canReceive = access.can('receive', user), canDeliver = access.can('deliver', user), canInvoice = access.can('invoice', user), canCancel = access.can('cancel', user), canManageSupplierOrders = access.can('supplier_order_manage', user), canTrackOrders = canSeeSupplierOrders || canReceive || canDeliver || canInvoice || canCancel || canManageSupplierOrders, canSeeReports = access.can('reports', user);
    document.querySelectorAll('[data-view="movimientosView"], [data-view="conteosView"], [data-summary-view="movimientosView"], [data-summary-view="conteosView"], .warehouse-quick-access, #movementDialog').forEach(element => { element.hidden = !canManageInventory; });
    document.querySelectorAll('[data-view="supplierOrdersView"], [data-view="proveedoresView"], [data-view="preciosView"]').forEach(element => { element.hidden = element.dataset.view === 'supplierOrdersView' ? !canSeeSupplierOrders : element.dataset.view === 'preciosView' ? !access.can('supplier_manage', user) : !canSeeSuppliers; });
    document.querySelectorAll('[data-view="trackingSummaryView"], [data-view="ordersView"]').forEach(element => { element.hidden = !canTrackOrders; });
    document.querySelectorAll('[data-view="deliveriesView"]').forEach(element => { element.hidden = !(canSeeSupplierOrders || canDeliver || canManageSupplierOrders); });
    document.querySelectorAll('[data-view="reportesView"], #newProduct, #newCatalogProduct').forEach(element => { element.hidden = element.id === 'newProduct' || element.id === 'newCatalogProduct' ? !canManageCatalog : !canSeeReports; });
    const warehouseLink = q('.inventory-group > [data-view]'), productLink = q('.products-group > [data-view]');
    if (warehouseLink && !canManageInventory && access.can('inventory_view', user)) { warehouseLink.dataset.view = 'inventarioView'; warehouseLink.setAttribute('href', '#inventario'); }
    if (productLink && !canSeeSuppliers && access.can('catalog_view', user)) { productLink.dataset.view = 'productosView'; productLink.setAttribute('href', '#productos'); }
    menu.querySelectorAll('[data-workspace-mode]').forEach(button => {
      const training = button.dataset.workspaceMode === 'training', active = state.mode === button.dataset.workspaceMode;
      button.hidden = training && (!state.sandboxEnabled || !canTrain);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    window.lucide?.createIcons();
  }

  function setMenuOpen(open) {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) renderWorkspace();
  }
  function closeMenu() { setMenuOpen(false); }
  const withoutCentralPersistence = callback => {
    const suspend = window.BioPersistence?.suspendWrites;
    return typeof suspend === 'function' ? suspend(callback) : callback();
  };
  async function synchronizeAndReload() {
    // El selector se conserva por usuario, pero cada espacio descarga y guarda
    // su conjunto central independiente al recargar.
    closeMenu();
    window.location.reload();
    return true;
  }
  async function switchMode(mode) {
    const current = access.workspace().mode;
    if (mode === current) return closeMenu();
    if (mode === 'training') {
      const result = withoutCentralPersistence(() => access.setWorkspaceMode('training')); if (!result.ok) return toast(result.message);
      await synchronizeAndReload();
      return;
    }
    const result = withoutCentralPersistence(() => access.setWorkspaceMode('operational')); if (!result.ok) return toast(result.message);
    document.documentElement.dataset.workspace = 'operational';
    q('#trainingWorkspaceNotice').hidden = true;
    await synchronizeAndReload();
  }

  // El icono de la flecha forma parte del botón; atender el evento desde el
  // botón evita que el SVG intercepte el clic en navegadores táctiles.
  toggle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setMenuOpen(menu.hidden); });
  // La banda completa sigue siendo interactiva si una capa decorativa del tema
  // queda sobre la flecha. Las opciones del menú se excluyen explícitamente.
  switcher.addEventListener('click', event => { if (!menu.contains(event.target) && !toggle.contains(event.target)) setMenuOpen(menu.hidden); });
  menu.addEventListener('click', event => { const option = event.target.closest('[data-workspace-mode]'); if (option) void switchMode(option.dataset.workspaceMode); else if (event.target.closest('[data-workspace-guide]')) closeMenu(); });
  q('#leaveTrainingWorkspace').addEventListener('click', event => { event.preventDefault(); void switchMode('operational'); });
  q('#workspaceSandboxEnabled').addEventListener('change', event => {
    const wasTraining = access.workspace().mode === 'training';
    const result = access.setSandboxEnabled(event.target.checked);
    if (!result.ok) { event.target.checked = !event.target.checked; return toast(result.message); }
    if (!result.enabled && wasTraining) {
      withoutCentralPersistence(() => access.setWorkspaceMode('operational'));
      void synchronizeAndReload();
      return;
    }
    if (!result.enabled) closeMenu();
    toast(result.enabled ? 'Área de pruebas habilitada para los perfiles autorizados.' : 'Área de pruebas deshabilitada.');
  });
  document.addEventListener('click', event => { if (!q('#workspaceSwitcher').contains(event.target)) closeMenu(); });
  window.addEventListener('bio:access-changed', renderWorkspace);
  renderWorkspace();
})();
