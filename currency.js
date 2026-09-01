(function (root) {
  'use strict';
  const STORAGE_KEY = 'nexo-fx-v1';
  const BANXICO_URL = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718,SF60632,SF46410/datos/oportuno';
  const OFFICIAL_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+CAD+MXN.EUR.SP00.A?lastNObservations=1&format=csvdata';
  const SECONDARY_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,CAD,MXN';
  const today = () => { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const emptyState = () => ({ version: 1, banxicoToken: '', protectionPercent: 20, records: [], audit: [] });
  const load = () => { try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (parsed?.version === 1) return { ...emptyState(), ...parsed, records: parsed.records || [], audit: parsed.audit || [] }; } catch {} return emptyState(); };
  let state = load(), inFlight = null;
  const save = (event, detail = {}) => {
    state.audit.unshift({ id: `FXA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), userId: root.BioAccess?.currentUser()?.id || 'SYSTEM', userName: root.BioAccess?.currentUser()?.name || 'Sistema', event, ...detail });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    root.dispatchEvent?.(new CustomEvent('bio:fx-changed', { detail: { event } }));
  };
  const normalizeRates = ({ EUR = 1, USD, CAD, MXN }) => {
    const mxn = Number(MXN), usd = Number(USD), cad = Number(CAD);
    if (![mxn, usd, cad].every(value => Number.isFinite(value) && value > 0)) throw new Error('La fuente no devolvió todas las divisas requeridas.');
    return { MXN: 1, USD: Number((mxn / usd).toFixed(6)), CAD: Number((mxn / cad).toFixed(6)), EUR: Number(mxn.toFixed(6)) };
  };
  const banxicoDate = value => { const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return match ? `${match[3]}-${match[2]}-${match[1]}` : value || null; };
  async function fetchBanxico() {
    if (!state.banxicoToken) throw new Error('Token SIE de Banco de México no configurado.');
    const response = await fetch(`${BANXICO_URL}?token=${encodeURIComponent(state.banxicoToken)}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Banco de México respondió ${response.status}`);
    const data = await response.json(), series = data?.bmx?.series || [], seriesMap = { SF43718: 'USD', SF60632: 'CAD', SF46410: 'EUR' }, rates = { MXN: 1 }, rateDates = {};
    series.forEach(serie => { const code = seriesMap[serie.idSerie], observation = serie.datos?.[0], value = Number(String(observation?.dato || '').replaceAll(',', '')); if (code && Number.isFinite(value) && value > 0) { rates[code] = value; rateDates[code] = banxicoDate(observation.fecha); } });
    if (![rates.USD, rates.CAD, rates.EUR].every(value => Number.isFinite(value) && value > 0)) throw new Error('Banco de México no devolvió todas las series requeridas.');
    return { rates, rateDate: rateDates.USD || rateDates.EUR || rateDates.CAD, rateDates, source: 'Banco de México · SIE', sourceType: 'official_primary', method: 'automatic_banxico', endpoint: BANXICO_URL };
  }
  async function fetchOfficial() {
    const response = await fetch(OFFICIAL_URL, { headers: { Accept: 'text/csv' } });
    if (!response.ok) throw new Error(`BCE respondió ${response.status}`);
    const text = await response.text(), rows = text.trim().split(/\r?\n/), headers = rows.shift().split(','), currencyIndex = headers.indexOf('CURRENCY'), dateIndex = headers.indexOf('TIME_PERIOD'), valueIndex = headers.indexOf('OBS_VALUE'), raw = {};
    let rateDate = null;
    rows.forEach(row => { const columns = row.split(','); const code = columns[currencyIndex]; if (['USD', 'CAD', 'MXN'].includes(code)) { raw[code] = Number(columns[valueIndex]); rateDate = columns[dateIndex] || rateDate; } });
    return { rates: normalizeRates(raw), rateDate, source: 'Banco Central Europeo', sourceType: 'official_secondary', method: 'automatic_ecb', endpoint: OFFICIAL_URL };
  }
  async function fetchSecondary() {
    const response = await fetch(SECONDARY_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Frankfurter respondió ${response.status}`);
    const data = await response.json();
    return { rates: normalizeRates(data.rates || {}), rateDate: data.date, source: 'Frankfurter (datos de bancos centrales)', sourceType: 'trusted_tertiary', method: 'automatic_frankfurter', endpoint: SECONDARY_URL };
  }
  const latest = () => state.records[0] || null;
  const todayRecord = () => state.records.find(record => record.consultedDate === today()) || null;
  async function ensureDaily({ force = false } = {}) {
    if (!force && todayRecord()) return todayRecord();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const attempts = [];
      const sources = [{ key: 'banxico', fetcher: fetchBanxico }, { key: 'ecb', fetcher: fetchOfficial }, { key: 'frankfurter', fetcher: fetchSecondary }];
      for (const source of sources) {
        try {
          const result = await source.fetcher(), record = { id: `FX-${Date.now()}`, consultedDate: today(), fetchedAt: new Date().toISOString(), protectionPercent: state.protectionPercent, ...result };
          state.records.unshift(record); save('daily_rates_registered', { recordId: record.id, method: record.method, source: record.source, rateDate: record.rateDate, attempts }); return record;
        } catch (error) { attempts.push({ source: source.key, error: error.message }); save('rate_source_failed', { source: source.key, error: error.message }); }
      }
      save('manual_rates_required', { consultedDate: today(), attempts }); return null;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  function saveManual({ USD, CAD, EUR, reason }) {
    if (!root.BioAccess?.can('system_config')) return { ok: false, message: 'Solo el Administrador puede capturar tasas manuales.' };
    const rates = { MXN: 1, USD: Number(USD), CAD: Number(CAD), EUR: Number(EUR) };
    if (!reason?.trim() || ![rates.USD, rates.CAD, rates.EUR].every(value => Number.isFinite(value) && value > 0)) return { ok: false, message: 'Captura tasas válidas y el motivo obligatorio.' };
    const before = latest()?.rates || null, record = { id: `FX-MAN-${Date.now()}`, consultedDate: today(), rateDate: today(), fetchedAt: new Date().toISOString(), rates, protectionPercent: state.protectionPercent, source: 'Captura administrativa', sourceType: 'manual', method: 'manual', endpoint: null, reason: reason.trim() };
    state.records.unshift(record); save('manual_rates_registered', { recordId: record.id, before, after: rates, reason: record.reason }); return { ok: true, record };
  }
  function setProtection(percent) {
    if (!root.BioAccess?.can('system_config')) return { ok: false, message: 'Solo el Administrador puede modificar la protección cambiaria.' };
    const value = Number(percent); if (!Number.isFinite(value) || value < 0 || value >= 100) return { ok: false, message: 'La protección debe estar entre 0 y 99.99%.' };
    const before = state.protectionPercent; state.protectionPercent = value; save('protection_updated', { before, after: value }); return { ok: true };
  }
  function setBanxicoToken(token) {
    if (!root.BioAccess?.can('system_config')) return { ok: false, message: 'Solo el Administrador puede configurar Banco de México.' };
    const value = String(token || '').trim(); if (value && value.length < 8) return { ok: false, message: 'El token SIE no parece válido.' };
    const before = Boolean(state.banxicoToken); state.banxicoToken = value; save('banxico_token_updated', { beforeConfigured: before, afterConfigured: Boolean(value) }); return { ok: true };
  }
  function protectedPrice(amount, sourceCurrency, targetCurrency = 'MXN') {
    const record = todayRecord(), source = String(sourceCurrency || 'MXN').toUpperCase(), target = String(targetCurrency || 'MXN').toUpperCase(), base = Number(amount);
    if (!record || !Number.isFinite(base) || !record.rates[source] || !record.rates[target]) return null;
    if (source === target) return { unitPrice: base, converted: false, sourceCurrency: source, targetCurrency: target, rate: 1, protectionPercent: 0, rateDate: record.rateDate, consultedDate: record.consultedDate, source: record.source, method: record.method, recordId: record.id };
    const crossRate = record.rates[source] / record.rates[target], protectionPercent = Number(state.protectionPercent || 0), unitPrice = base * crossRate / (1 - protectionPercent / 100);
    return { unitPrice, converted: true, sourceCurrency: source, targetCurrency: target, rate: crossRate, protectionPercent, protectedAmount: unitPrice - base * crossRate, rateDate: record.rateDate, consultedDate: record.consultedDate, source: record.source, method: record.method, recordId: record.id };
  }
  root.BioFX = { BANXICO_URL, OFFICIAL_URL, SECONDARY_URL, getState: () => { const copy = JSON.parse(JSON.stringify(state)); copy.banxicoToken = copy.banxicoToken ? '••••••••' : ''; return copy; }, latest, todayRecord, ensureDaily, saveManual, setProtection, setBanxicoToken, protectedPrice };

  const q = selector => document.querySelector(selector), currencyNames = { USD: 'Dólar estadounidense', CAD: 'Dólar canadiense', MXN: 'Peso mexicano', EUR: 'Euro' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const eventLabels = { daily_rates_registered: 'Consulta diaria registrada', rate_source_failed: 'Fuente no disponible', manual_rates_required: 'Captura manual requerida', manual_rates_registered: 'Tasas manuales registradas', protection_updated: 'Protección cambiaria modificada', banxico_token_updated: 'Conexión de Banco de México actualizada' };
  function renderFxAdmin() {
    if (!q('.fx-admin-card')) return;
    const canConfigure = root.BioAccess?.can('system_config'), current = latest(), daily = todayRecord(), protection = Number(state.protectionPercent || 0);
    q('.fx-admin-card').hidden = !canConfigure;
    q('#openManualFx').hidden = !canConfigure; q('#refreshFxRates').hidden = !canConfigure; q('#saveFxProtection').hidden = !canConfigure; q('#saveFxBanxicoToken').hidden = !canConfigure; q('#fxProtectionPercent').disabled = !canConfigure; q('#fxBanxicoToken').disabled = !canConfigure; q('#fxProtectionPercent').value = protection; q('#fxBanxicoToken').value = ''; q('#fxBanxicoToken').placeholder = state.banxicoToken ? 'Token configurado' : 'Pega el token SIE';
    q('#fxDailyStatus').className = daily ? `ready ${daily.sourceType}` : 'pending';
    q('#fxDailyStatus').innerHTML = daily ? `<i data-lucide="${daily.sourceType === 'official_primary' ? 'landmark' : daily.sourceType === 'official_secondary' ? 'badge-check' : daily.sourceType === 'trusted_tertiary' ? 'cloud-check' : 'pencil-line'}"></i> Consulta de ${daily.consultedDate} · ${escapeHtml(daily.source)} · datos ${escapeHtml(daily.rateDate)}` : '<i data-lucide="triangle-alert"></i> Sin consulta registrada para hoy; los precios con conversión permanecerán bloqueados hasta actualizar o capturar las tasas.';
    q('#fxRateCards').innerHTML = ['USD', 'CAD', 'MXN', 'EUR'].map(code => { const rate = current?.rates?.[code], protectedRate = code === 'MXN' ? 1 : rate && rate / (1 - protection / 100); return `<article class="fx-rate-card ${code.toLowerCase()}"><div><span class="fx-currency-code">${code}</span><div><strong>${currencyNames[code]}</strong><small>1 ${code} en pesos mexicanos</small></div></div><b>${rate ? `$${Number(rate).toFixed(6)}` : 'Sin tasa'}</b><span>${code === 'MXN' ? 'Moneda base' : protectedRate ? `Protegida ${protection}%: $${protectedRate.toFixed(6)}` : 'Protección pendiente'}</span></article>`; }).join('');
    q('#fxAuditCount').textContent = `${state.audit.length} eventos`;
    q('#fxAuditList').innerHTML = state.audit.slice(0, 12).map(entry => `<article><span class="fx-audit-icon"><i data-lucide="${entry.event === 'rate_source_failed' ? 'triangle-alert' : entry.event.includes('manual') ? 'pencil' : entry.event === 'protection_updated' ? 'shield' : 'refresh-cw'}"></i></span><div><strong>${escapeHtml(eventLabels[entry.event] || entry.event)}</strong><small>${escapeHtml(entry.source || entry.reason || entry.error || 'Registro cambiario')}</small></div><time>${new Date(entry.at).toLocaleString('es-MX')}<small>${escapeHtml(entry.userName || 'Sistema')}</small></time></article>`).join('') || '<div class="fx-audit-empty">La primera consulta diaria generará el historial.</div>';
    root.lucide?.createIcons();
  }
  q('#refreshFxRates')?.addEventListener('click', async () => { if (!root.BioAccess?.can('system_config')) return; q('#refreshFxRates').disabled = true; q('#fxDailyStatus').innerHTML = '<i data-lucide="loader-circle"></i> Consultando fuente oficial…'; root.lucide?.createIcons(); await ensureDaily({ force: true }); q('#refreshFxRates').disabled = false; renderFxAdmin(); });
  q('#openManualFx')?.addEventListener('click', () => { if (!root.BioAccess?.can('system_config')) return; const rates = latest()?.rates || {}; q('#manualFxUsd').value = rates.USD || ''; q('#manualFxCad').value = rates.CAD || ''; q('#manualFxEur').value = rates.EUR || ''; q('#manualFxReason').value = ''; q('#manualFxDialog').showModal(); });
  q('#manualFxForm')?.addEventListener('submit', event => { event.preventDefault(); const result = saveManual({ USD: q('#manualFxUsd').value, CAD: q('#manualFxCad').value, EUR: q('#manualFxEur').value, reason: q('#manualFxReason').value }); if (!result.ok) return root.showToast?.(result.message); q('#manualFxDialog').close(); renderFxAdmin(); root.showToast?.('Tipos de cambio manuales registrados con auditoría.'); });
  q('#saveFxProtection')?.addEventListener('click', () => { const result = setProtection(q('#fxProtectionPercent').value); if (!result.ok) return root.showToast?.(result.message); renderFxAdmin(); root.showToast?.('Protección cambiaria actualizada.'); });
  q('#saveFxBanxicoToken')?.addEventListener('click', async () => { const result = setBanxicoToken(q('#fxBanxicoToken').value); if (!result.ok) return root.showToast?.(result.message); renderFxAdmin(); root.showToast?.('Token de Banco de México guardado. Verificando conexión…'); await ensureDaily({ force: true }); renderFxAdmin(); });
  document.querySelectorAll('.fx-dialog-close').forEach(button => button.addEventListener('click', () => q('#manualFxDialog').close()));
  root.addEventListener('bio:fx-changed', renderFxAdmin); root.addEventListener('bio:access-changed', renderFxAdmin); renderFxAdmin();
  setTimeout(() => ensureDaily(), 0);
  root.setInterval?.(() => ensureDaily(), 15 * 60 * 1000);
})(window);
