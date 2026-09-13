(function () {
  'use strict';
  const controlSelector = 'input, select, textarea';
  const requiredControlSelector = 'input[required], select[required], textarea[required]';
  const escapeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  const labelFor = field => field.closest('label.field, label') || field.closest('.field') || field.parentElement;
  const fieldName = field => labelFor(field)?.querySelector('span, .field-label')?.textContent?.replace(/\*/g, '').replace(/obligatorio/ig, '').trim() || field.getAttribute('aria-label') || field.name || 'Este campo';
  const errorId = field => `field-error-${escapeId(field.id || field.name || Math.random().toString(36).slice(2))}`;
  const contactKind = field => field?.type === 'email' || /(?:email|correo|mail)/i.test(`${field?.id || ''} ${field?.name || ''}`) ? 'email' : (field?.type === 'tel' || /(?:phone|telefono|teléfono|celular|móvil|movil)/i.test(`${field?.id || ''} ${field?.name || ''}`) ? 'phone' : '');
  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
  const validPhone = value => { const raw = String(value || '').trim(), digits = raw.replace(/\D/g, ''); return (digits.length === 10) || (digits.length === 12 && digits.startsWith('52')) || (/^\+/.test(raw) && digits.length >= 8 && digits.length <= 15); };

  function markRequired(field, required = field.required) {
    if (!field || field.disabled || field.type === 'hidden') return;
    const label = labelFor(field), title = label?.querySelector('span, .field-label');
    field.required = Boolean(required); field.setAttribute('aria-required', String(Boolean(required)));
    if (title) title.classList.toggle('field-required', Boolean(required));
  }
  function messageFor(field) {
    if (field.validity.valueMissing) return `${fieldName(field)} es obligatorio.`;
    if (field.validity.typeMismatch) return field.type === 'email' ? 'Captura un correo válido.' : `${fieldName(field)} no tiene un formato válido.`;
    if (field.validity.rangeUnderflow) return field.min === '0' ? `${fieldName(field)} no puede ser menor que cero.` : `Captura una cantidad mayor que cero.`;
    if (field.validity.rangeOverflow) return `${fieldName(field)} supera el máximo permitido.`;
    if (field.validity.stepMismatch || field.validity.badInput) return `Captura un valor válido para ${fieldName(field).toLowerCase()}.`;
    return field.validationMessage || `${fieldName(field)} requiere revisión.`;
  }
  function clearFieldError(field) {
    if (!field) return;
    const label = labelFor(field), message = label?.querySelector(`#${CSS.escape(errorId(field))}`);
    field.classList.remove('field-invalid'); field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); label?.classList.remove('field-has-error'); message?.remove();
  }
  function setFieldError(field, message) {
    if (!field) return false;
    const label = labelFor(field); if (!label) return false;
    const id = errorId(field); clearFieldError(field);
    field.classList.add('field-invalid'); field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', id); label.classList.add('field-has-error');
    const help = document.createElement('small'), icon = document.createElement('i'); help.id = id; help.className = 'field-error-message'; help.setAttribute('role', 'alert'); icon.dataset.lucide = 'triangle-alert'; help.append(icon, document.createTextNode(message || messageFor(field))); label.append(help); window.lucide?.createIcons(); return false;
  }
  function validateField(field) {
    if (!field || field.disabled || field.type === 'hidden' || field.closest('[hidden]')) { clearFieldError(field); return true; }
    const kind = contactKind(field), value = String(field.value || '').trim();
    if (kind === 'email' && value) { field.value = value.toLowerCase(); if (!validEmail(field.value)) return setFieldError(field, 'Captura un correo válido, por ejemplo: nombre@empresa.com.'); }
    if (kind === 'phone' && value && field.dataset.phoneDigits === '10' && !/^\d{10}$/.test(value)) return setFieldError(field, 'Captura exactamente 10 dígitos numéricos para el teléfono.');
    if (kind === 'phone' && value && !validPhone(value)) return setFieldError(field, 'Captura un teléfono válido: 10 dígitos en México o formato internacional con +.');
    if (field.required && typeof field.value === 'string' && !field.value.trim()) return setFieldError(field, `${fieldName(field)} es obligatorio.`);
    if (!field.checkValidity()) return setFieldError(field, messageFor(field)); clearFieldError(field); return true;
  }
  function validateForm(form, focus = true) {
    const fields = [...form.querySelectorAll(controlSelector)].filter(field => field.willValidate && !field.disabled && !field.closest('[hidden]'));
    const invalid = fields.filter(field => !validateField(field));
    const notice = form.querySelector('.form-validation-notice'); notice?.remove();
    if (!invalid.length) return true;
    const banner = document.createElement('div'); banner.className = 'form-validation-notice'; banner.setAttribute('role', 'alert'); banner.innerHTML = '<i data-lucide="triangle-alert"></i>Revisa los campos obligatorios marcados en rojo.'; form.querySelector('.modal-body, .order-dialog-body, .quotation-builder')?.prepend(banner); window.lucide?.createIcons();
    if (focus) { invalid[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); invalid[0].focus({ preventScroll: true }); }
    return false;
  }
  function hydrate(form) {
    if (form.dataset.validationReady) return; form.dataset.validationReady = 'true'; form.noValidate = true;
    // El selector comercial de movimientos sustituye al select legado oculto.
    // Por eso la regla se aplica al campo que el usuario realmente captura.
    if (form.id === 'movementForm') markRequired(form.querySelector('#movementProductSearch'), true);
    form.querySelectorAll(controlSelector).forEach(field => { const kind = contactKind(field); if (kind === 'email') { field.type = 'email'; field.autocomplete ||= 'email'; } if (kind === 'phone') { field.type = 'tel'; field.inputMode = 'tel'; field.autocomplete ||= 'tel'; } });
    form.querySelectorAll(requiredControlSelector).forEach(field => markRequired(field, true));
    if (form.querySelector(requiredControlSelector)) { const legend = document.createElement('small'); legend.className = 'form-required-legend'; legend.textContent = '* Campos obligatorios'; form.querySelector('.modal-body, .order-dialog-body, .quotation-builder')?.prepend(legend); }
  }
  document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('form').forEach(hydrate));
  document.addEventListener('invalid', event => { if (event.target.matches?.(controlSelector)) { event.preventDefault(); setFieldError(event.target, messageFor(event.target)); } }, true);
  document.addEventListener('blur', event => { if (event.target.matches?.(requiredControlSelector) || contactKind(event.target)) validateField(event.target); }, true);
  document.addEventListener('input', event => { const field = event.target; if (!field.matches?.(controlSelector)) return; if (field.dataset.phoneDigits === '10') field.value = field.value.replace(/\D/g, '').slice(0, 10); if (field.classList.contains('field-invalid')) validateField(field); });
  document.addEventListener('change', event => { if (event.target.matches?.(controlSelector)) validateField(event.target); });
  document.addEventListener('submit', event => { const form = event.target; if (!(form instanceof HTMLFormElement)) return; hydrate(form); if (!validateForm(form)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  window.BioFormValidation = { markRequired, validateField, validateForm, setFieldError, clearFieldError, hydrate, validEmail, validPhone };
})();
