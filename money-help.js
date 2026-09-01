(function (root) {
  'use strict';
  const CURRENCIES = ['MXN', 'USD', 'CAD', 'EUR'];
  const moneyWords = /precio|monto|importe|subtotal|total|costo|valor|tarifa|pago|factura|cotizaci[oó]n/i;
  const moneyClasses = /price|money|amount|subtotal|grand-total|history-total|order-total|line-total/i;

  function parseAmount(value) {
    const raw = String(value ?? '').trim(), negative = /^\s*[-−]/.test(raw) || /^\s*\(/.test(raw);
    let clean = raw.replace(/[A-Z]{3}|[$€£¥]|\s|[()−-]/gi, '').replace(/[^\d.,]/g, '');
    if (!clean) return null;
    const comma = clean.lastIndexOf(','), dot = clean.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? ',' : '.';
      clean = decimal === ',' ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
    } else if (comma >= 0) {
      clean = /,\d{1,2}$/.test(clean) ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
    } else if (dot >= 0 && !/\.\d{1,6}$/.test(clean)) clean = clean.replace(/\./g, '');
    const amount = Number(clean);
    return Number.isFinite(amount) ? (negative ? -amount : amount) : null;
  }

  function convert(amount, sourceCurrency, record) {
    const source = String(sourceCurrency || 'MXN').toUpperCase(), rates = record?.rates;
    if (!Number.isFinite(Number(amount)) || !rates?.[source]) return null;
    return Object.fromEntries(CURRENCIES.map(code => [code, Number(amount) * rates[source] / rates[code]]));
  }

  function conversionDetails(amount, sourceCurrency, record) {
    const source = String(sourceCurrency || 'MXN').toUpperCase(), rates = record?.rates;
    if (!Number.isFinite(Number(amount)) || !rates?.[source]) return null;
    return Object.fromEntries(CURRENCIES.map(code => {
      const factor = rates[source] / rates[code];
      return [code, { amount: Number(amount) * factor, factor, percentage: factor * 100 }];
    }));
  }

  function amountFromText(value) {
    const tokens = String(value || '').match(/[-−]?\s*(?:(?:MXN|USD|CAD|EUR)\s*)?[$€]?\s*\d[\d,.]*(?:\s*(?:MXN|USD|CAD|EUR))?/gi) || [];
    return tokens.length ? parseAmount(tokens[tokens.length - 1]) : null;
  }

  function format(value, currency) {
    return Number(value).toLocaleString('es-MX', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function explicitCurrency(text) {
    const matches = [...String(text || '').toUpperCase().matchAll(/(?:^|[^A-Z])(MXN|USD|CAD|EUR)(?=$|[^A-Z])/g)];
    if (matches.length) return matches[matches.length - 1][1];
    return String(text || '').includes('€') ? 'EUR' : null;
  }

  function tableColumnIsMoney(cell) {
    if (!cell || cell.tagName !== 'TD') return false;
    const table = cell.closest('table'), index = [...cell.parentElement.children].indexOf(cell);
    return moneyWords.test(table?.querySelector(`thead th:nth-child(${index + 1})`)?.textContent || '');
  }

  function resolveTarget(origin) {
    const element = origin?.closest?.('[data-money-amount],input[type="number"],strong,b,em,td,[class*="price"],[class*="total"],[class*="amount"],[class*="money"]');
    if (!element || element.closest('#bioMoneyTooltip') || element.matches('[disabled]')) return null;
    if (element.matches('input[type="number"]')) {
      const context = `${element.id} ${element.name} ${element.dataset.field || ''} ${element.getAttribute('aria-label') || ''} ${element.closest('label')?.textContent || ''}`;
      if (!moneyWords.test(context)) return null;
      const amount = parseAmount(element.value);
      return Number.isFinite(amount) ? { element, amount } : null;
    }
    const text = element.dataset.moneyAmount || element.textContent || '';
    const moneyLike = element.dataset.moneyAmount != null || /[$€]|\b(?:MXN|USD|CAD|EUR)\b/i.test(text) || moneyClasses.test(element.className || '') || tableColumnIsMoney(element);
    if (!moneyLike || text.length > 160) return null;
    const amount = element.dataset.moneyAmount != null ? parseAmount(element.dataset.moneyAmount) : amountFromText(text);
    return Number.isFinite(amount) ? { element, amount } : null;
  }

  function inferCurrency(element) {
    const attributed = element.closest('[data-money-currency]')?.dataset.moneyCurrency;
    if (CURRENCIES.includes(String(attributed || '').toUpperCase())) return attributed.toUpperCase();
    const own = explicitCurrency(element.textContent);
    if (own) return own;
    if (element.closest('.quotation-workspace,.quotation-history-row,.commercial-order-row')) {
      const quoteCurrency = document.querySelector('#quotationCurrency')?.value;
      if (CURRENCIES.includes(quoteCurrency)) return quoteCurrency;
    }
    const rowCurrency = explicitCurrency(element.closest('tr,article,[class*="row"]')?.textContent);
    return rowCurrency || 'MXN';
  }

  if (typeof document === 'undefined' || !document.body) {
    root.BioMoneyHelp = { parseAmount, amountFromText, convert, conversionDetails };
    return;
  }

  const tooltip = document.createElement('aside');
  tooltip.id = 'bioMoneyTooltip'; tooltip.className = 'bio-money-tooltip'; tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);
  let activeElement = null;

  function position(element) {
    const rect = element.getBoundingClientRect(), box = tooltip.getBoundingClientRect(), gap = 10;
    let left = rect.left + rect.width / 2 - box.width / 2, top = rect.top - box.height - gap;
    left = Math.max(10, Math.min(left, window.innerWidth - box.width - 10));
    if (top < 10) top = Math.min(window.innerHeight - box.height - 10, rect.bottom + gap);
    tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
  }

  function show(origin) {
    const resolved = resolveTarget(origin); if (!resolved) return hide();
    const currency = inferCurrency(resolved.element), record = root.BioFX?.todayRecord?.() || root.BioFX?.latest?.(), details = conversionDetails(resolved.amount, currency, record);
    activeElement?.classList.remove('bio-money-active'); activeElement = resolved.element; activeElement.classList.add('bio-money-active'); activeElement.setAttribute('aria-describedby', tooltip.id);
    tooltip.innerHTML = details ? `<div class="bio-money-title"><span>${format(resolved.amount, currency)}</span><small>Conversión de referencia</small></div><div class="bio-money-grid">${CURRENCIES.filter(code => code !== currency).map(code => `<div><span>${code}</span><span class="bio-money-result"><strong>${format(details[code].amount, code)}</strong><small>${details[code].percentage.toLocaleString('es-MX', { maximumFractionDigits: 4 })}% del monto · factor ${details[code].factor.toLocaleString('es-MX', { maximumFractionDigits: 6 })}</small></span></div>`).join('')}</div><footer>Porcentajes respecto al monto en ${currency} · Tasa ${record.rateDate || record.consultedDate || 'vigente'} · ${record.source || 'registro diario'}</footer>` : `<div class="bio-money-unavailable"><strong>Conversión no disponible</strong><span>Actualiza las tasas en Configuración → Divisas.</span></div>`;
    tooltip.hidden = false; requestAnimationFrame(() => position(resolved.element));
  }

  function hide() {
    if (!activeElement) return;
    activeElement.classList.remove('bio-money-active'); activeElement.removeAttribute('aria-describedby'); activeElement = null; tooltip.hidden = true;
  }

  document.addEventListener('pointerover', event => show(event.target));
  document.addEventListener('pointerout', event => { if (activeElement && !activeElement.contains(event.relatedTarget)) hide(); });
  document.addEventListener('focusin', event => show(event.target));
  document.addEventListener('focusout', event => { if (activeElement === event.target) hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  root.BioMoneyHelp = { parseAmount, amountFromText, convert, conversionDetails, show, hide };
})(window);
