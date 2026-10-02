(function (root) {
  'use strict';
  const KEYS = ['nexo-access-v1', 'nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders', 'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-order-operations-v1', 'nexo-fx-v1'];
  const enabled = /^https?:$/.test(root.location.protocol) && !root.__BIO_TRAINING__, nativeSet = Storage.prototype.setItem, nativeRemove = Storage.prototype.removeItem;
  const status = { connected: false, hydrated: false, migrating: false, lastSync: null, error: null };
  const pending = new Map(); let timer = null, writableKeys = new Set();
  const parse = value => { try { return JSON.parse(value); } catch { return null; } };
  const safePayload = (key, payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    const copy = JSON.parse(JSON.stringify(payload));
    if (key === 'nexo-access-v1') delete copy.currentUserId;
    if (key === 'nexo-fx-v1') delete copy.banxicoToken;
    return copy;
  };
  const renderStatus = () => {
    const element = root.document?.querySelector('#persistenceStatus'); if (!element) return;
    element.classList.toggle('connected', status.connected && !status.error); element.classList.toggle('error', Boolean(status.error));
    element.querySelector('span').textContent = status.error ? 'API sin conexión' : status.connected ? 'Base central conectada' : 'Persistencia local';
    element.title = status.error || (status.lastSync ? `Última sincronización: ${new Date(status.lastSync).toLocaleString('es-MX')}` : 'Datos guardados en este navegador');
  };
  const notify = () => { renderStatus(); root.dispatchEvent?.(new CustomEvent('bio:persistence-changed', { detail: { ...status } })); };
  const actor = () => root.BioAccess?.currentUser()?.name || 'Cliente PROBIOLAB';

  function requestSync(method, url, payload) {
    const xhr = new XMLHttpRequest(); xhr.open(method, url, false); xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Bio-User', actor()); xhr.send(payload == null ? null : JSON.stringify(payload));
    if (xhr.status < 200 || xhr.status >= 300) throw new Error(`API PROBIOLAB respondió ${xhr.status}.`);
    return JSON.parse(xhr.responseText || '{}');
  }

  function bootstrap() {
    if (!enabled) return;
    try {
      const response = requestSync('GET', '/api/bootstrap');
      status.connected = true;
      writableKeys = new Set(Array.isArray(response.allowedKeys) ? response.allowedKeys : []);
      if (response.empty) {
        const state = Object.fromEntries(KEYS.map(key => [key, parse(root.localStorage.getItem(key))]).filter(([, payload]) => payload !== null).map(([key, payload]) => [key, safePayload(key, payload)]));
        if (Object.keys(state).length) { status.migrating = true; requestSync('POST', '/api/import-local', { state, actor: 'Migración inicial del navegador' }); status.migrating = false; }
      } else {
        Object.entries(response.state || {}).forEach(([key, payload]) => {
          if (!KEYS.includes(key)) return;
          if (key === 'nexo-access-v1') payload = { ...payload, currentUserId: root.BioAuth?.user?.()?.id || parse(root.localStorage.getItem(key))?.currentUserId || 'USR-001' };
          if (key === 'nexo-fx-v1') payload = { ...payload, banxicoToken: parse(root.localStorage.getItem(key))?.banxicoToken || '' };
          nativeSet.call(root.localStorage, key, JSON.stringify(payload));
        });
      }
      status.hydrated = true; status.lastSync = new Date().toISOString();
    } catch (error) { status.error = error.message; status.connected = false; }
  }

  async function flush(options = {}) {
    const throwOnError = options.throwOnError === true;
    timer = null;
    if (!status.connected) {
      const error = new Error(status.error || 'No hay conexión con la base central. Verifica la API antes de continuar.');
      if (throwOnError) throw error;
      return false;
    }
    if (!pending.size) return true;
    let entries = [...pending.entries()], lastError = null; pending.clear();
    // Las escrituras ya confirmadas no deben repetirse cuando una sola petición
    // transitoria falla; repetir el lote completo provoca sincronizaciones
    // innecesarias y bloquea el cambio de espacio de trabajo.
    for (let attempt = 0; attempt < 3 && entries.length; attempt += 1) {
      const failed = [];
      for (const [key, payload] of entries) {
        try {
          await fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Bio-User': actor() }, body: JSON.stringify({ payload: safePayload(key, payload) }) }).then(response => { if (!response.ok) throw Object.assign(new Error(`No fue posible sincronizar ${key}.`), { status: response.status }); return response.json(); });
        } catch (error) {
          // Un permiso revocado no es una caída de la API: se descarta la escritura
          // local para evitar reintentos y errores 403 repetidos en la consola.
          if (error.status === 403) { writableKeys.delete(key); continue; }
          failed.push([key, payload]); lastError = error;
        }
      }
      entries = failed;
      if (entries.length && attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (entries.length) {
      entries.forEach(([key, payload]) => pending.set(key, payload));
      status.error = lastError?.message || 'No fue posible sincronizar los cambios.';
      timer = setTimeout(flush, 1800);
      notify();
      if (throwOnError) throw new Error(`Los cambios no se guardaron en la base central. ${status.error}`);
      return false;
    }
    else { status.lastSync = new Date().toISOString(); status.error = null; }
    notify();
    return true;
  }

  function queue(key, serialized) {
    if (!status.connected || !KEYS.includes(key) || !writableKeys.has(key)) return;
    const payload = parse(serialized); if (payload === null) return; pending.set(key, payload); clearTimeout(timer); timer = setTimeout(flush, 80);
  }

  bootstrap();
  root.addEventListener?.('bio:auth-ready', bootstrap);
  if (enabled) {
    Storage.prototype.setItem = function (key, value) { nativeSet.call(this, key, value); if (this === root.localStorage) queue(String(key), String(value)); };
    Storage.prototype.removeItem = function (key) { nativeRemove.call(this, key); };
  }
  root.BioPersistence = { keys: KEYS, status: () => ({ ...status, pending: pending.size }), flush, bootstrap };
  root.addEventListener('DOMContentLoaded', notify);
})(window);
