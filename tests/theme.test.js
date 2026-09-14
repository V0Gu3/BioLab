const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('la interfaz conserva sus funciones si la biblioteca remota de iconos no carga', () => {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /window\.lucide = window\.lucide \|\| \{ createIcons\(\) \{\} \};/);
});

test('persiste tema y paleta por usuario', () => {
  const values = new Map(), style = new Map(), rootElement = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  const document = { documentElement: rootElement, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const window = { BioAccess: { currentUser: () => ({ id: 'USR-001' }) }, addEventListener() {}, dispatchEvent() {} };
  const context = { window, document, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../theme.js'), 'utf8'), context);
  window.BioTheme.save({ mode: 'dark', primaryColor: '#3157a4', fontScale: 1.1 });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(style.get('--bio-primary'), '#3157a4');
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-sidebar'), '#ffffff') >= 8);
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-sidebar-elevated'), '#ffffff') >= 7);
  assert.equal(style.get('--bio-font-scale'), '1.1');
  assert.equal(document.documentElement.dataset.fontScale, '110');
  assert.equal(JSON.parse(values.get('nexo-theme-v3:USR-001')).mode, 'dark');
  assert.equal(JSON.parse(values.get('nexo-theme-v3:USR-001')).fontScale, 1.1);
});

test('cambiar entre claro y oscuro conserva la tipografía y su escala', () => {
  const values = new Map(), style = new Map();
  const rootElement = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  const textElement = { dataset: { bioBaseFontSize: '12' }, style: {}, matches: () => true, childNodes: [{ nodeType: 3, textContent: 'Texto' }] };
  const main = { childNodes: [], querySelectorAll: () => [textElement] };
  const document = { documentElement: rootElement, querySelector: selector => selector === 'main' ? main : null, querySelectorAll: () => [], addEventListener() {} };
  const window = { BioAccess: { currentUser: () => ({ id: 'USR-001' }) }, addEventListener() {}, dispatchEvent() {}, requestAnimationFrame: callback => callback(), getComputedStyle: () => ({ fontSize: '12px' }) };
  const context = { window, document, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../theme.js'), 'utf8'), context);
  window.BioTheme.save({ fontScale: 1.2 });
  const sizeBeforeModeChange = textElement.style.fontSize;
  window.BioTheme.save({ mode: 'dark' });
  assert.equal(window.BioTheme.getState().fontScale, 1.2);
  assert.equal(textElement.style.fontSize, sizeBeforeModeChange);
  assert.equal(rootElement.dataset.theme, 'dark');
});

test('el login recupera en forma local el modo del último usuario identificado', () => {
  const auth = fs.readFileSync(require.resolve('../auth.js'), 'utf8');
  const loginCss = fs.readFileSync(require.resolve('../login.css'), 'utf8');
  const loginHtml = fs.readFileSync(require.resolve('../login.html'), 'utf8');
  assert.match(auth, /bio-login-theme-by-email-v1/);
  assert.match(auth, /nexo-theme-v3:\$\{userId\}/);
  assert.match(auth, /initializeLoginTheme\(dialog\)/);
  assert.match(auth, /root\.addEventListener\('bio:theme-changed'/);
  assert.match(loginCss, /:root\[data-login-theme="light"\] \.bio-login-panel/);
  assert.match(loginHtml, /login\.css\?v=20260913-3/);
  assert.match(loginHtml, /auth\.js\?v=20260913-3/);
});

test('carga el tema antes de pintar y usa superficies oscuras neutrales', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.ok(html.indexOf('theme.js?v=20260831-11') < html.indexOf('<body>'));
  assert.equal((html.match(/theme\.js\?v=/g) || []).length, 1);
  assert.match(css, /--bio-bg:\s*#0f1115/);
  assert.match(css, /--bio-surface:\s*#171a20/);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});

test('deriva el fondo, los estados del menú y la navegación activa desde la paleta', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /--bio-bg:\s*color-mix\(in srgb, var\(--bio-primary\) 3%, #fff\)/);
  assert.match(css, /\.nav-subitem:hover:not\(\.active\)/);
  assert.match(css, /var\(--bio-primary\) 68%, #fff/);
  assert.match(css, /:root\[data-theme="dark"\] \.settings-section-nav button\.active/);
  assert.match(css, /var\(--bio-primary\) 18%, var\(--bio-surface-soft\)/);
});

test('integra la paleta en inventario, movimientos, conteos, productos y reportes', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  for (const view of ['inventarioView', 'movimientosView', 'conteosView', 'productosView', 'reportesView']) {
    assert.match(css, new RegExp(`#${view}`));
  }
  assert.match(css, /\.settings-section-nav button > svg \{ color: var\(--bio-text-muted\) !important; \}/);
  assert.match(css, /#conteosView \.count-intro/);
  assert.match(css, /#reportesView \.report-bars i:nth-child\(3n\)/);
  assert.match(css, /:is\(#inventarioView, #productosView\) \.product-image/);
  assert.match(css, /\.settings-section-nav button \{ color: var\(--bio-text-muted\) !important; \}/);
});

test('las existencias en cero no conservan fondos blancos en el tema oscuro', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /#inventarioView \.warehouse-stock\.no-stock/);
  assert.match(css, /background: color-mix\(in srgb, var\(--bio-primary\) 4%, var\(--bio-surface-soft\)\) !important/);
  assert.match(css, /color: var\(--bio-text-muted\) !important/);
});

test('aplica la paleta a scrollbars y valores del catálogo de productos', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\*::-webkit-scrollbar-thumb/);
  assert.match(css, /\.sidebar > nav \{ scrollbar-color:/);
  assert.match(css, /#productosView td:nth-child\(6\) > strong/);
  assert.match(css, /#productosView td:nth-child\(8\)/);
  assert.match(css, /#productosView \.price-never/);
});

test('integra la barra de configuración, el espacio de trabajo y el perfil de sesión', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\.settings-section-nav \{[\s\S]*?background: var\(--bio-surface-soft\) !important;/);
  assert.match(css, /\.workspace \{[\s\S]*?var\(--bio-primary\) 16%/);
  assert.match(css, /body \.sidebar :is\(\.workspace, \.profile\) strong/);
  assert.match(css, /\.profile \.avatar \{[\s\S]*?background: var\(--bio-primary\) !important;/);
});

test('integra todo el módulo de divisas con la paleta activa', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\[data-settings-panel="currency"\] \.fx-status-strip \{/);
  assert.match(css, /\[data-settings-panel="currency"\] :is\([\s\S]*?\.fx-source-icon\.banxico/);
  assert.match(css, /\.fx-status-strip button \{[\s\S]*?background: var\(--bio-primary-strong\) !important;/);
  assert.match(css, /#manualFxDialog :is\(\.modal-title, \.submit\)/);
  assert.match(css, /:root\[data-theme="dark"\] #settingsView \[data-settings-panel="currency"\]/);
});

test('la auditoría cambiaria no conserva filas blancas en modo oscuro', () => {
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\[data-theme="dark"\][\s\S]*?\.fx-audit-list article[\s\S]*?background:\s*var\(--bio-surface-raised\)\s*!important/);
});

test('temas vive dentro de configuración y permanece disponible para todos', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /data-view="settingsView"/);
  assert.doesNotMatch(html, /data-view="settingsView"[^>]+data-access=/);
  assert.match(html, /data-settings-section="themes"/);
  assert.match(html, /data-settings-panel="themes"/);
  assert.match(html, /id="themeSessionUser"/);
  assert.match(html, /Esta elección no modifica los documentos emitidos/);
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\.settings-section-nav \{[\s\S]*?grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('el globo de conversión sigue la paleta activa sin verdes fijos', () => {
  const css = fs.readFileSync(require.resolve('../money-help.css'), 'utf8');
  assert.match(css, /background: color-mix\(in srgb, var\(--bio-primary\) 7%, var\(--bio-surface-raised\)\)/);
  assert.match(css, /color: var\(--bio-primary-readable\)/);
  assert.doesNotMatch(css, /#b9fa81|rgba\(23, 34, 29/);
});

test('permite cambiar y persistir la escala de lectura', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  const script = fs.readFileSync(require.resolve('../theme.js'), 'utf8');
  for (const scale of ['1', '1.1', '1.2', '1.3']) assert.match(html, new RegExp(`data-theme-font="${scale.replace('.', '\\.')}"`));
  assert.doesNotMatch(css, /\bzoom\s*:/);
  assert.match(script, /function scaleContentText/);
  assert.match(script, /document\.querySelector\('main'\)/);
  assert.match(script, /element\.style\.fontSize/);
  assert.match(script, /const CONTENT_TEXT_BASE = 1\.2/);
  assert.match(script, /base \* CONTENT_TEXT_BASE \* state\.fontScale/);
  assert.match(css, /\.theme-font-grid button\.active/);
  assert.match(script, /fontScale: 1\.1/);
  assert.match(script, /save\(\{ fontScale: Number\(font\.dataset\.themeFont\) \}\)/);
});

test('migra la escala anterior y aumenta el tamaño general al 110 por ciento', () => {
  const values = new Map([['nexo-theme-v2:USR-001', JSON.stringify({ mode: 'dark', primaryColor: '#3157a4', fontScale: 1 })]]), style = new Map();
  const rootElement = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  const document = { documentElement: rootElement, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const window = { BioAccess: { currentUser: () => ({ id: 'USR-001' }) }, addEventListener() {}, dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../theme.js'), 'utf8'), { window, document, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } });
  assert.equal(window.BioTheme.getState().fontScale, 1.1);
  assert.equal(style.get('--bio-font-scale'), '1.1');
});

test('una paleta muy clara conserva contraste legible en menú y textos activos', () => {
  const values = new Map(), style = new Map(), rootElement = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  const document = { documentElement: rootElement, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const window = { BioAccess: { currentUser: () => ({ id: 'USR-001' }) }, addEventListener() {}, dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../theme.js'), 'utf8'), { window, document, CustomEvent: class CustomEvent {}, localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } });
  window.BioTheme.save({ primaryColor: '#fff3a6', mode: 'light' });
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-sidebar'), '#ffffff') >= 8);
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-primary-readable'), '#ffffff') >= 4.5);
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-sidebar-text'), style.get('--bio-sidebar-elevated')) >= 7);
  assert.ok(window.BioTheme.contrastRatio(style.get('--bio-sidebar-muted'), style.get('--bio-sidebar-elevated')) >= 4.5);
  assert.equal(style.get('--bio-on-primary'), '#15181d');
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  assert.match(css, /\.sidebar :is\(\.nav-item, \.nav-subitem\)/);
  assert.match(css, /\.nav-subitem\.active svg \{ color: var\(--bio-on-primary\) !important; \}/);
  assert.match(css, /body \.sidebar :is\(\.workspace, \.profile\) small \{[\s\S]*?var\(--bio-sidebar-muted\)/);
  assert.match(css, /body \.sidebar :is\(\.workspace, \.profile\) strong \{[\s\S]*?var\(--bio-sidebar-text\)/);
});

test('cotizaciones separa el resumen del panel operativo', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /class="nav-item" href="#resumen-cotizaciones" data-view="quotationSummaryView"/);
  assert.match(html, /class="nav-subitem" href="#cotizaciones" data-view="cotizacionesView"/);
  assert.match(html, /id="quotationSummaryView"/);
  assert.match(html, /id="quotationSummaryRecent"/);
  assert.match(html, /id="cotizacionesView"/);
  assert.match(html, /PANEL DE COTIZACIONES/);
});

test('todos los modales y menús auxiliares usan la identidad de la paleta activa', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../theme.css'), 'utf8');
  const dialogs = [...html.matchAll(/<dialog\s+id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(dialogs.length, 18);
  assert.match(css, /Capa unificada para ventanas y menús de apoyo/);
  assert.match(css, /#movementDialog, #newProductDialog, #actionConfirmDialog, \.system-dialog, \.order-dialog, \.document-preview-dialog/);
  assert.match(css, /Contrato visual de diálogos/);
  assert.match(css, /\.system-dialog, \.order-dialog\)\[open\][\s\S]*?max-height: calc\(100dvh - var\(--app-dialog-inset\)\)/);
  assert.match(css, /\.document-preview-head > div > #documentPreviewFolio[\s\S]*?#ffffff/);
  assert.match(css, /\.document-preview-head small[\s\S]*?#ffffff/);
  assert.match(css, /:focus-visible[\s\S]*?outline: 3px solid var\(--app-dialog-focus\)/);
  assert.match(css, /\.order-dialog-body[\s\S]*?overscroll-behavior: contain/);
  assert.match(css, /var\(--bio-primary-glow\)/);
  assert.match(css, /\.global-search-results, \.movement-product-results, \.quotation-search-results/);
  assert.match(css, /\.workspace-menu \{[\s\S]*?var\(--bio-sidebar\)/);
  assert.match(css, /\.nav-submenu::before \{ background: var\(--bio-sidebar-border\) !important; \}/);
  assert.match(css, /\.document-preview-actions \.preview-download \{[\s\S]*?var\(--bio-primary\) 13%, var\(--bio-surface\)/);
  assert.match(css, /\.document-preview-actions \.preview-cancel \{[\s\S]*?var\(--bio-primary-readable\)/);
  assert.match(css, /#movementDialog \.operation-option\[data-type="salida"\]\.selected[\s\S]*?var\(--bio-danger\) 11%, var\(--bio-surface\)/);
  assert.match(css, /#movementDialog \.operation-option\.selected:hover \{ transform: none !important; filter: none !important; \}/);
  assert.match(css, /#clientList \[data-add-advance\][\s\S]*?var\(--bio-success\) 32%, var\(--bio-surface\)/);
  assert.match(css, /#clientList \[data-edit-client\][\s\S]*?var\(--bio-primary\) 35%, var\(--bio-surface\)/);
  assert.match(css, /#clientList \[data-toggle-client-block\][\s\S]*?var\(--bio-warning\) 32%, var\(--bio-surface\)/);
  assert.match(css, /#clientList \[data-retire-client\][\s\S]*?var\(--bio-danger\) 31%, var\(--bio-surface\)/);
  assert.match(css, /#clientList button\[data-add-advance\][\s\S]*?var\(--bio-success\) 38%, var\(--bio-surface\)/);
  assert.match(css, /#clientList button\[data-edit-client\][\s\S]*?var\(--bio-primary\) 38%, var\(--bio-surface\)/);
  assert.match(css, /#clientList button\[data-toggle-client-block\][\s\S]*?var\(--bio-warning\) 38%, var\(--bio-surface\)/);
  assert.match(css, /#clientList button\[data-retire-client\][\s\S]*?var\(--bio-danger\) 38%, var\(--bio-surface\)/);
  assert.match(html, /client-action-colors/);
  assert.match(html, /\[data-add-advance\].*?#d9f3e5/);
  assert.match(html, /\[data-edit-client\].*?#dceffd/);
  assert.match(html, /\[data-toggle-client-block\].*?#ffedc9/);
  assert.match(html, /\[data-retire-client\].*?#ffe0e4/);
});
