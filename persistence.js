(function (root) {
  'use strict';
  const KEYS = ['nexo-access-v1', 'nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders', 'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-order-operations-v1', 'nexo-fx-v1', 'nexo-quotation-terms-v1'];
  const enabled = /^https?:$/.test(root.location.protocol), nativeSet = Storage.prototype.setItem, nativeRemove = Storage.prototype.removeItem;
  const status = { connected: false, hydrated: false, migrating: false, lastSync: null, error: null };
  const pending = new Map(); let timer = null, writableKeys = new Set(), suspendedWrites = 0, bootstrapPromise = null;
  const parse = value => { try { return JSON.parse(value); } catch { return null; } };
  const workspace = () => root.__BIO_TRAINING__ ? 'training' : 'operational';
  const workspaceHeaders = () => ({ 'X-Bio-Workspace': workspace() });
  // v2 invalida una sola vez las revisiones locales generadas durante la falla
  // de esquema del 8 de noviembre. Así no se conserva como válida una remisión
  // que sólo alcanzó localStorage pero nunca fue confirmada por PostgreSQL.
  const bootstrapMetaKey = () => `nexo-bootstrap-cache-v2:${root.BioAuth?.user?.()?.id || 'anonymous'}:${workspace()}`;
  const activeWorkspaceKey = () => `nexo-bootstrap-active-workspace-v1:${root.BioAuth?.user?.()?.id || 'anonymous'}`;
  const bootstrapMeta = () => parse(root.localStorage.getItem(bootstrapMetaKey())) || null;
  const saveBootstrapMeta = value => nativeSet.call(root.localStorage, bootstrapMetaKey(), JSON.stringify(value));
  const ARRAY_KEYS = new Set(['nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders', 'nexo-sales-quotations', 'nexo-commercial-orders']);
  const emptyPayload = key => ARRAY_KEYS.has(key) ? [] : key === 'nexo-fx-v1' ? { records: [], audit: [] } : {};
  const safePayload = (key, payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    // La mayoría de los estados no requiere saneamiento. Evitar una copia JSON
    // completa aquí ahorra una segunda serialización de catálogos y expedientes.
    if (key !== 'nexo-access-v1' && key !== 'nexo-fx-v1') return payload;
    const copy = JSON.parse(JSON.stringify(payload));
    if (key === 'nexo-access-v1') { delete copy.currentUserId; copy.workspace = { sandboxEnabled: copy.workspace?.sandboxEnabled !== false, modes: {} }; copy.audit = Array.isArray(copy.audit) ? copy.audit.filter(item => item?.type !== 'workspace_mode_changed') : []; }
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

  async function request(method, url, payload, headers = {}) {
    const controller = new AbortController(), timeout = root.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await nativeFetch(url, { method, credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Bio-User': actor(), ...headers }, body: payload == null ? undefined : JSON.stringify(payload) });
      if (response.status === 304) return { notModified: true, etag: response.headers.get('ETag') || headers['If-None-Match'] || '' };
      if (!response.ok) throw new Error(`API PROBIOLAB respondió ${response.status}.`);
      return { ...await response.json(), etag: response.headers.get('ETag') || '' };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('La carga inicial tardó demasiado. Se conservaron los datos disponibles y puedes volver a intentarlo.');
      throw error;
    } finally { root.clearTimeout(timeout); }
  }

  // Todos los llamados de la aplicación llevan el espacio explícitamente.
  // Así una ruta operativa adicional no puede terminar modificando datos reales
  // mientras la persona practica en el entorno de pruebas.
  const nativeFetch = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
  if (nativeFetch) {
    root.fetch = (input, options = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (!/^\/api(?:\/|$)/.test(url)) return nativeFetch(input, options);
      return nativeFetch(input, { ...options, headers: { ...(options.headers || {}), ...workspaceHeaders() } });
    };
  }

  async function bootstrap() {
    // persistence.js se carga antes de auth.js; esperar la sesión confirmada
    // evita una descarga inicial sin perfil y mantiene la caché aislada por usuario.
    if (!enabled || !root.BioAuth?.user?.()) return false;
    if (status.hydrated && root.localStorage.getItem(activeWorkspaceKey()) === workspace()) return { changed: false };
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => { let changed = false; try {
      // localStorage contiene únicamente el espacio actualmente activo. No se
      // reutiliza la firma de otro espacio porque podría validar datos de
      // capacitación mientras el navegador aún conserva datos operativos.
      const ownsLocalState = root.localStorage.getItem(activeWorkspaceKey()) === workspace();
      const cached = ownsLocalState ? bootstrapMeta() : null;
      const cacheHeaders = cached?.etag && Array.isArray(cached.allowedKeys) ? {
        'If-None-Match': cached.etag,
        ...(cached.revisions && Array.isArray(cached.readableKeys) ? { 'X-Bio-State-Revisions': JSON.stringify(cached.revisions), 'X-Bio-State-Keys': JSON.stringify(cached.readableKeys) } : {})
      } : {};
      const response = await request('GET', '/api/bootstrap', null, { ...workspaceHeaders(), ...cacheHeaders });
      status.connected = true;
      if (response.notModified && cached) {
        writableKeys = new Set(cached.allowedKeys);
      } else if (response.empty) {
        writableKeys = new Set(Array.isArray(response.allowedKeys) ? response.allowedKeys : []);
        const state = Object.fromEntries(KEYS.map(key => [key, parse(root.localStorage.getItem(key))]).filter(([, payload]) => payload !== null).map(([key, payload]) => [key, safePayload(key, payload)]));
        if (workspace() === 'operational' && Object.keys(state).length) { status.migrating = true; await request('POST', '/api/import-local', { state, actor: 'Migración inicial del navegador' }, workspaceHeaders()); status.migrating = false; }
      } else {
        writableKeys = new Set(Array.isArray(response.allowedKeys) ? response.allowedKeys : []);
        (response.removedKeys || []).filter(key => KEYS.includes(key)).forEach(key => { const serialized = JSON.stringify(emptyPayload(key)); if (root.localStorage.getItem(key) !== serialized) changed = true; nativeSet.call(root.localStorage, key, serialized); });
        Object.entries(response.state || {}).forEach(([key, payload]) => {
          if (!KEYS.includes(key)) return;
          if (key === 'nexo-access-v1') { const localAccess = parse(root.localStorage.getItem(key)) || {}; payload = { ...payload, currentUserId: root.BioAuth?.user?.()?.id || localAccess.currentUserId || 'USR-001', workspace: localAccess.workspace || payload.workspace }; }
          if (key === 'nexo-fx-v1') payload = { ...payload, banxicoToken: parse(root.localStorage.getItem(key))?.banxicoToken || '' };
          const serialized = JSON.stringify(payload); if (root.localStorage.getItem(key) !== serialized) changed = true; nativeSet.call(root.localStorage, key, serialized);
        });
        if (response.etag) saveBootstrapMeta({ etag: response.etag, allowedKeys: [...writableKeys], readableKeys: Array.isArray(response.readableKeys) ? response.readableKeys : KEYS, revisions: response.revisions || {}, storedAt: new Date().toISOString() });
      }
      nativeSet.call(root.localStorage, activeWorkspaceKey(), workspace());
      status.hydrated = true; status.lastSync = new Date().toISOString();
      status.error = null; notify(); return { changed };
    } catch (error) { status.error = error.message; status.connected = false; status.migrating = false; notify(); return false; }
    finally { bootstrapPromise = null; } })();
    return bootstrapPromise;
  }

  let flushPromise = null;
  async function flush(options = {}) {
    if (flushPromise) {
      const result = await flushPromise;
      if (!result && options.throwOnError) throw new Error(status.error || 'No fue posible sincronizar los cambios.');
      return result && (flushPromise || pending.size) ? flush(options) : result;
    }
    clearTimeout(timer);
    const operation = flushPending(options);
    flushPromise = operation;
    let result;
    try { result = await operation; }
    finally { if (flushPromise === operation) flushPromise = null; }
    return result && pending.size ? flush(options) : result;
  }
  async function flushPending(options = {}) {
    const throwOnError = options.throwOnError === true;
    timer = null;
    if (!status.connected) {
      const error = new Error(status.error || 'No hay conexión con la base central. Verifica la API antes de continuar.');
      if (throwOnError) throw error;
      return false;
    }
    if (!pending.size) return true;
    let entries = [...pending.entries()], lastError = null, needsReconciliation = false, deferRetry = false; pending.clear();
    // Las escrituras ya confirmadas no deben repetirse cuando una sola petición
    // transitoria falla; repetir el lote completo provoca sincronizaciones
    // innecesarias y bloquea el cambio de espacio de trabajo.
    for (let attempt = 0; attempt < 3 && entries.length; attempt += 1) {
      const failed = [], results = [];
      if (entries.length > 1) {
        try {
          const response = await fetch('/api/state-batch', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Bio-User': actor(), ...workspaceHeaders() }, body: JSON.stringify({ state: Object.fromEntries(entries.map(([key, payload]) => [key, safePayload(key, payload)])) }) });
          const detail = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(new Error(detail.error || 'No fue posible sincronizar el lote de cambios.'), { status: response.status });
          entries.forEach(([key, payload]) => results.push({ key, payload, result: { revision: detail.revisions?.[key] } }));
        } catch (error) { entries.forEach(([key, payload]) => results.push({ key, payload, error })); }
      } else {
        const [key, payload] = entries[0];
        try {
          const response = await fetch(`/api/state/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Bio-User': actor(), ...workspaceHeaders() }, body: JSON.stringify({ payload: safePayload(key, payload) }) });
          const detail = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(new Error(detail.error || `No fue posible sincronizar ${key}.`), { status: response.status });
          results.push({ key, payload, result: detail });
        } catch (error) { results.push({ key, payload, error }); }
      }
      for (const { key, payload, error, result } of results) {
        if (!error) {
          const cached = bootstrapMeta();
          if (cached?.revisions && result?.revision) saveBootstrapMeta({ ...cached, revisions: { ...cached.revisions, [key]: result.revision }, storedAt: new Date().toISOString() });
          continue;
        }
          // Un permiso revocado no es una caída de la API: se descarta la escritura
          // local para evitar reintentos y errores 403 repetidos en la consola.
          if (error.status === 403) { writableKeys.delete(key); continue; }
          // Un 409 significa que otra pestaña o un endpoint transaccional guardó
          // una versión más reciente. No insistir con el estado obsoleto: recuperar
          // una sola vez la verdad central evita regresiones y tráfico repetido.
          if (error.status === 409) {
            needsReconciliation = true;
            lastError = error;
            continue;
          }
          // Un timeout de la función ya consumió 30 segundos y puede conservar
          // temporalmente el bloqueo transaccional. Reintentarlo de inmediato
          // sólo forma una cola de 504; se conserva para el siguiente flush.
          if (error.status === 504) deferRetry = true;
          failed.push([key, payload]); lastError = error;
      }
      entries = failed;
      if (deferRetry) break;
      if (entries.length && attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (needsReconciliation) {
      // Conservar la marca del espacio permite enviar revisiones conocidas y
      // recibir sólo las claves en conflicto, no otro bootstrap completo.
      status.hydrated = false;
      await bootstrap();
      // Recuperar la verdad central no confirma las escrituras rechazadas.
      // El pedido debe detenerse y mostrar la causa real del conflicto.
      status.error = lastError?.message || 'Los cambios entraron en conflicto con la versión central.';
      notify();
      console.warn('Sincronización rechazada:', status.error);
      if (throwOnError) throw new Error(status.error);
      return false;
    }
    if (entries.length) {
      entries.forEach(([key, payload]) => pending.set(key, payload));
      status.error = lastError?.message || 'No fue posible sincronizar los cambios.';
      // Conservar el lote pendiente sin crear un bucle de errores que aumente
      // egress y carga en la base. El siguiente cambio o flush lo reintentará.
      timer = null;
      notify();
      if (throwOnError) throw new Error(`Los cambios no se guardaron en la base central. ${status.error}`);
      return false;
    }
    else { status.lastSync = new Date().toISOString(); status.error = null; }
    notify();
    return true;
  }

  function queue(key, serialized) {
    if (suspendedWrites || !status.connected || !KEYS.includes(key) || !writableKeys.has(key)) return;
    const payload = parse(serialized); if (payload === null) return; pending.set(key, payload); clearTimeout(timer); timer = setTimeout(flush, 80);
  }

  function clearLocalState(options = {}) {
    const keepAccess = options.keepAccess !== false;
    suspendedWrites += 1;
    try {
      KEYS.forEach(key => { if (!keepAccess || key !== 'nexo-access-v1') nativeRemove.call(root.localStorage, key); });
      for (let index = root.localStorage.length - 1; index >= 0; index -= 1) {
        const key = root.localStorage.key(index);
        if (key?.startsWith('nexo-bootstrap-cache-v2:') || key?.startsWith('nexo-bootstrap-active-workspace-v1:')) nativeRemove.call(root.localStorage, key);
      }
      pending.clear(); clearTimeout(timer); timer = null; status.hydrated = false;
    } finally { suspendedWrites = Math.max(0, suspendedWrites - 1); }
  }

  bootstrap();
  root.addEventListener?.('bio:auth-ready', bootstrap);
  if (enabled) {
    Storage.prototype.setItem = function (key, value) {
      const normalizedKey = String(key), normalizedValue = String(value);
      // Varias pantallas ejecutan save() sobre todos los módulos aunque sólo
      // uno haya cambiado. Conservar el setItem local, pero no generar una
      // petición ni una reconstrucción central para contenido idéntico.
      const unchanged = this === root.localStorage && KEYS.includes(normalizedKey) && this.getItem(normalizedKey) === normalizedValue;
      nativeSet.call(this, normalizedKey, normalizedValue);
      if (this === root.localStorage && !unchanged) queue(normalizedKey, normalizedValue);
    };
    Storage.prototype.removeItem = function (key) { nativeRemove.call(this, key); };
  }
  const suspendWrites = callback => { suspendedWrites += 1; try { return callback?.(); } finally { suspendedWrites = Math.max(0, suspendedWrites - 1); } };
  root.BioPersistence = { keys: KEYS, status: () => ({ ...status, pending: pending.size }), flush, bootstrap, suspendWrites, clearLocalState };
  root.addEventListener('DOMContentLoaded', notify);
})(window);
