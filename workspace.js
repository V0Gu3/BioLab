(function () {
  'use strict';
  const access = window.BioAccess;
  if (!access) return;
  const q = selector => document.querySelector(selector);
  const toast = message => window.showToast?.(message) || window.alert(message);
  const menu = q('#workspaceMenu'), toggle = q('#workspaceToggle');
  const TRAINING_DATA_KEY = 'bio-workspace-training-data-v1';
  const OPERATIONAL_BACKUP_KEY = 'bio-workspace-operational-backup-v1';
  const excluded = key => key === 'nexo-access-v1' || key === 'nexo-nav-groups' || key.startsWith('nexo-theme-');
  const dataKey = key => key.startsWith('nexo-') && !excluded(key);

  function captureData() {
    const snapshot = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && dataKey(key)) snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  }
  function restoreData(snapshot = {}) {
    const current = captureData();
    Object.keys(current).filter(key => !(key in snapshot)).forEach(key => localStorage.removeItem(key));
    Object.entries(snapshot).forEach(([key, value]) => localStorage.setItem(key, value));
  }
  const stored = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const saveStored = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  function renderWorkspace() {
    const state = access.workspace(), user = access.currentUser(), canTrain = access.can('sandbox', user), isAdmin = user?.role === 'administrator';
    q('#workspaceCurrentLabel').textContent = state.mode === 'training' ? 'Pruebas' : 'Operativo';
    q('#workspaceSwitcher').classList.toggle('training-active', state.mode === 'training');
    document.documentElement.dataset.workspace = state.mode;
    q('#trainingWorkspaceNotice').hidden = state.mode !== 'training';
    q('#workspaceSandboxEnabled').checked = state.sandboxEnabled;
    q('#workspaceAdminToggle').hidden = !isAdmin;
    q('[data-workspace-guide]').hidden = !canTrain;
    document.querySelectorAll('[data-view="auditView"], [data-access="audit"]').forEach(link => { link.hidden = state.mode === 'training' || !access.can('audit', user); });
    menu.querySelectorAll('[data-workspace-mode]').forEach(button => {
      const training = button.dataset.workspaceMode === 'training', active = state.mode === button.dataset.workspaceMode;
      button.hidden = training && (!state.sandboxEnabled || !canTrain);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    window.lucide?.createIcons();
  }

  function closeMenu() { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  async function synchronizeAndReload() {
    await window.BioPersistence?.flush?.();
    const sync = window.BioPersistence?.status?.();
    if (sync?.error || sync?.pending) {
      toast('No fue posible confirmar el cambio de espacio con la base central. Inténtalo nuevamente.');
      renderWorkspace();
      return false;
    }
    window.location.reload();
    return true;
  }
  async function switchMode(mode) {
    const current = access.workspace().mode;
    if (mode === current) return closeMenu();
    if (mode === 'training') {
      const result = access.setWorkspaceMode('training'); if (!result.ok) return toast(result.message);
      saveStored(OPERATIONAL_BACKUP_KEY, captureData());
      const savedTraining = stored(TRAINING_DATA_KEY);
      if (savedTraining) restoreData(savedTraining); else saveStored(TRAINING_DATA_KEY, captureData());
      await synchronizeAndReload();
      return;
    }
    saveStored(TRAINING_DATA_KEY, captureData());
    const operational = stored(OPERATIONAL_BACKUP_KEY);
    if (operational) restoreData(operational);
    localStorage.removeItem(OPERATIONAL_BACKUP_KEY);
    const result = access.setWorkspaceMode('operational'); if (!result.ok) return toast(result.message);
    document.documentElement.dataset.workspace = 'operational';
    q('#trainingWorkspaceNotice').hidden = true;
    await synchronizeAndReload();
  }

  toggle.addEventListener('click', () => { menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) renderWorkspace(); });
  menu.addEventListener('click', event => { const option = event.target.closest('[data-workspace-mode]'); if (option) void switchMode(option.dataset.workspaceMode); else if (event.target.closest('[data-workspace-guide]')) closeMenu(); });
  q('#leaveTrainingWorkspace').addEventListener('click', event => { event.preventDefault(); void switchMode('operational'); });
  q('#workspaceSandboxEnabled').addEventListener('change', event => {
    const wasTraining = access.workspace().mode === 'training';
    const result = access.setSandboxEnabled(event.target.checked);
    if (!result.ok) { event.target.checked = !event.target.checked; return toast(result.message); }
    if (!result.enabled && wasTraining) {
      saveStored(TRAINING_DATA_KEY, captureData());
      const operational = stored(OPERATIONAL_BACKUP_KEY); if (operational) restoreData(operational);
      localStorage.removeItem(OPERATIONAL_BACKUP_KEY);
      access.setWorkspaceMode('operational');
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
