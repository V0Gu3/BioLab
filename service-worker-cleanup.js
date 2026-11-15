(function (root) {
  'use strict';
  const reloadKey = 'bio-service-worker-cleanup-reload-v1';
  root.__bioServiceWorkerCleanup = (async () => {
    if (!('serviceWorker' in navigator)) return true;
    const controlled = Boolean(navigator.serviceWorker.controller);
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
    if ('caches' in root) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith('probiolab-')).map(key => caches.delete(key)));
    }
    // El worker que controlaba la pestaña deja de intervenir al terminar esta
    // navegación. Una sola recarga controlada abre el sitio directamente desde
    // la red; la marca evita cualquier ciclo si el navegador tarda en liberarlo.
    if (controlled && !root.sessionStorage.getItem(reloadKey)) {
      root.sessionStorage.setItem(reloadKey, '1');
      root.location.reload();
      return false;
    }
    root.sessionStorage.removeItem(reloadKey);
    return true;
  })().catch(() => true);
})(window);
