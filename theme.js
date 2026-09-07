(function (root) {
  'use strict';

  const STORAGE_KEY = 'nexo-theme-v3';
  const LEGACY_KEY = 'nexo-theme-v2';
  const OLDER_KEY = 'nexo-theme-v1';
  const DEFAULTS = Object.freeze({ mode: 'light', primaryColor: '#359bd3', fontScale: 1.1 });
  const FONT_SCALES = Object.freeze([1, 1.1, 1.2, 1.3]);
  const CONTENT_TEXT_BASE = 1.2;
  const PRESETS = Object.freeze([
    { color: '#359bd3', secondary: '#9bc53d', name: 'Institucional' },
    { color: '#52715b', secondary: '#a2c94b', name: 'Bosque' },
    { color: '#3157a4', secondary: '#55b9d9', name: 'Océano' },
    { color: '#6d4bb5', secondary: '#b67ad5', name: 'Amatista' },
    { color: '#a45b32', secondary: '#d8a445', name: 'Terracota' },
    { color: '#0f8c86', secondary: '#78c98e', name: 'Laguna' },
    { color: '#c64f78', secondary: '#e69b63', name: 'Frambuesa' },
    { color: '#169a72', secondary: '#9bc53d', name: 'Esmeralda' },
    { color: '#d55659', secondary: '#ed9b66', name: 'Coral' },
    { color: '#d48a22', secondary: '#efd05c', name: 'Ámbar' },
    { color: '#596579', secondary: '#93bad0', name: 'Grafito' }
  ]);

  const currentUserId = () => root.BioAccess?.currentUser?.()?.id || 'local';
  const storageKey = (base = STORAGE_KEY) => `${base}:${currentUserId()}`;
  const validColor = value => /^#[0-9a-f]{6}$/i.test(String(value || ''));
  const clamp = value => Math.max(0, Math.min(255, value));
  const channels = hex => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [value >> 16, (value >> 8) & 255, value & 255];
  };
  const hex = values => `#${values.map(value => Math.round(clamp(value)).toString(16).padStart(2, '0')).join('')}`;
  const shade = (color, amount) => hex(channels(color).map(value => value + amount));
  const mix = (color, target, amount) => hex(channels(color).map((value, index) => value + (channels(target)[index] - value) * amount));
  const rgba = (color, alpha) => { const [red, green, blue] = channels(color); return `rgba(${red}, ${green}, ${blue}, ${alpha})`; };
  const luminance = color => {
    const normalized = channels(color).map(value => { const channel = value / 255; return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
    return .2126 * normalized[0] + .7152 * normalized[1] + .0722 * normalized[2];
  };
  const contrastRatio = (first, second) => { const lighter = Math.max(luminance(first), luminance(second)); const darker = Math.min(luminance(first), luminance(second)); return (lighter + .05) / (darker + .05); };
  const contrast = color => contrastRatio(color, '#ffffff') >= contrastRatio(color, '#15181d') ? '#ffffff' : '#15181d';
  const ensureContrast = (color, background, target, minimum) => {
    let adjusted = color;
    for (let step = 0; step < 16 && contrastRatio(adjusted, background) < minimum; step += 1) adjusted = mix(adjusted, target, .14);
    return adjusted;
  };
  const pairedAccent = primary => PRESETS.find(item => item.color === primary.toLowerCase())?.secondary || mix(primary, '#9bc53d', .34);
  const derivePalette = (primary, mode = 'light') => {
    const secondary = pairedAccent(primary);
    const sidebar = ensureContrast(primary, '#ffffff', '#07101d', 8);
    const sidebarRaised = ensureContrast(mix(sidebar, primary, .12), '#ffffff', '#07101d', 7);
    const readableBackground = mode === 'dark' ? '#171a20' : '#ffffff';
    const readableTarget = mode === 'dark' ? '#ffffff' : '#101827';
    return {
      sidebar,
      sidebarRaised,
      sidebarBorder: mix(sidebar, '#ffffff', .18),
      sidebarText: ensureContrast('#ffffff', sidebarRaised, '#ffffff', 7),
      sidebarMuted: ensureContrast(mix('#ffffff', primary, .22), sidebarRaised, '#ffffff', 4.5),
      primaryStrong: ensureContrast(primary, '#ffffff', '#101827', 5),
      primaryReadable: ensureContrast(primary, readableBackground, readableTarget, 4.5),
      onPrimary: contrast(primary),
      secondary,
      secondaryReadable: ensureContrast(secondary, readableBackground, readableTarget, 4.5)
    };
  };

  function normalize(settings = {}) {
    const requestedScale = Number(settings.fontScale);
    return {
      mode: settings.mode === 'dark' ? 'dark' : 'light',
      primaryColor: validColor(settings.primaryColor) ? settings.primaryColor.toLowerCase() : DEFAULTS.primaryColor,
      fontScale: FONT_SCALES.includes(requestedScale) ? requestedScale : DEFAULTS.fontScale
    };
  }

  function load() {
    try {
      const stored = localStorage.getItem(storageKey());
      if (stored) { const parsed = JSON.parse(stored); return normalize({ ...DEFAULTS, ...parsed, primaryColor: String(parsed.primaryColor || '').toLowerCase() === '#52715b' ? DEFAULTS.primaryColor : parsed.primaryColor }); }
      const legacy = JSON.parse(localStorage.getItem(storageKey(LEGACY_KEY)) || localStorage.getItem(storageKey(OLDER_KEY)) || '{}');
      const previousScale = Number(legacy.fontScale);
      const migratedScale = Number.isFinite(previousScale) ? Math.min(1.3, Math.round((previousScale + .1) * 10) / 10) : DEFAULTS.fontScale;
      return normalize({ ...DEFAULTS, ...legacy, fontScale: migratedScale });
    } catch {
      return { ...DEFAULTS };
    }
  }

  let state = load();
  let textObserver = null;

  function scaleContentText(container = document.querySelector('main')) {
    if (!container || typeof root.getComputedStyle !== 'function') return;
    const candidates = [container, ...container.querySelectorAll('*')].filter(element => element.matches?.('input, select, textarea, button, option') || [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()));
    const pending = candidates.filter(element => !element.dataset.bioBaseFontSize).map(element => ({ element, size: Number.parseFloat(root.getComputedStyle(element).fontSize) })).filter(item => Number.isFinite(item.size) && item.size > 0);
    pending.forEach(({ element, size }) => { element.dataset.bioBaseFontSize = String(size); });
    candidates.forEach(element => { const base = Number(element.dataset.bioBaseFontSize); if (Number.isFinite(base)) element.style.fontSize = `${Math.round(base * CONTENT_TEXT_BASE * state.fontScale * 100) / 100}px`; });
  }

  function observeContentText() {
    const main = document.querySelector('main');
    if (!main || textObserver || typeof MutationObserver === 'undefined') return scaleContentText(main);
    scaleContentText(main);
    textObserver = new MutationObserver(records => {
      if (records.some(record => record.addedNodes.length)) root.requestAnimationFrame?.(() => scaleContentText(main));
    });
    textObserver.observe(main, { childList: true, subtree: true });
  }

  function apply(next = state) {
    state = normalize(next);
    const element = document.documentElement;
    const primary = state.primaryColor;
    const palette = derivePalette(primary, state.mode);

    element.dataset.theme = state.mode;
    element.style.setProperty('--bio-primary', primary);
    element.style.setProperty('--bio-primary-strong', palette.primaryStrong);
    element.style.setProperty('--bio-primary-readable', palette.primaryReadable);
    element.style.setProperty('--bio-primary-soft', rgba(primary, state.mode === 'dark' ? .18 : .11));
    element.style.setProperty('--bio-primary-glow', rgba(primary, .25));
    element.style.setProperty('--bio-secondary', palette.secondary);
    element.style.setProperty('--bio-secondary-readable', palette.secondaryReadable);
    element.style.setProperty('--bio-secondary-soft', rgba(palette.secondary, state.mode === 'dark' ? .19 : .13));
    element.style.setProperty('--bio-on-primary', palette.onPrimary);
    element.style.setProperty('--bio-sidebar', palette.sidebar);
    element.style.setProperty('--bio-sidebar-elevated', palette.sidebarRaised);
    element.style.setProperty('--bio-sidebar-border', palette.sidebarBorder);
    element.style.setProperty('--bio-sidebar-text', palette.sidebarText);
    element.style.setProperty('--bio-sidebar-muted', palette.sidebarMuted);
    element.style.setProperty('--bio-font-scale', String(state.fontScale));
    element.dataset.fontScale = String(Math.round(state.fontScale * 100));
    element.style.setProperty('--violet', primary);
    element.style.setProperty('--teal', primary);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.sidebar);
    root.requestAnimationFrame?.(() => scaleContentText());
  }

  function renderControls() {
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
      const active = button.dataset.themeMode === state.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-theme-color]').forEach(button => {
      const active = button.dataset.themeColor.toLowerCase() === state.primaryColor;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-theme-font]').forEach(button => {
      const active = Number(button.dataset.themeFont) === state.fontScale;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const colorInput = document.querySelector('#themeCustomColor');
    if (colorInput) colorInput.value = state.primaryColor;
    const label = document.querySelector('#themeCurrentLabel');
    if (label) label.textContent = `${state.mode === 'dark' ? 'Oscuro' : 'Claro'} · ${PRESETS.find(item => item.color.toLowerCase() === state.primaryColor)?.name || state.primaryColor} · ${Math.round(state.fontScale * 100)}%`;
  }

  function persist(next, detail = {}) {
    const before = { ...state };
    state = normalize(next);
    localStorage.setItem(storageKey(), JSON.stringify(state));
    apply();
    renderControls();
    root.dispatchEvent(new CustomEvent('bio:theme-changed', { detail: { before, after: { ...state }, ...detail } }));
    return { ...state };
  }

  const save = patch => persist({ ...state, ...patch });
  const reset = () => persist({ ...DEFAULTS }, { reset: true });

  apply();
  document.addEventListener('DOMContentLoaded', () => { renderControls(); observeContentText(); });
  document.addEventListener('click', event => {
    const mode = event.target.closest?.('[data-theme-mode]');
    const color = event.target.closest?.('[data-theme-color]');
    const font = event.target.closest?.('[data-theme-font]');
    if (mode) save({ mode: mode.dataset.themeMode });
    if (color) save({ primaryColor: color.dataset.themeColor });
    if (font) save({ fontScale: Number(font.dataset.themeFont) });
    if (event.target.closest?.('#resetTheme')) reset();
  });
  document.addEventListener('input', event => {
    if (event.target.matches?.('#themeCustomColor')) save({ primaryColor: event.target.value });
  });
  root.addEventListener('bio:access-changed', () => {
    state = load();
    apply();
    renderControls();
  });

  root.BioTheme = { PRESETS, FONT_SCALES, contrastRatio, derivePalette, getState: () => ({ ...state }), save, reset, apply };
})(window);
