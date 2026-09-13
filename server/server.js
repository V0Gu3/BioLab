'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, readState, saveState, importSnapshot, listResource, listAudit, STATE_KEYS } = require('./db');
const { assess: assessQuotationConversion } = require('../quotation-conversion');
const { currentUser, login, setupReady, setupAdministrator, setPassword, sessionCookie, clearSession } = require('./auth');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BIO_PORT || 8787);
const HOST = process.env.BIO_HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
const BANXICO_URL = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718,SF60632,SF46410/datos/oportuno';
const PUBLIC_ROOT_EXTENSIONS = new Set(['.js', '.css']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.ico', '.pdf']);
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://www.banxico.org.mx https://data-api.ecb.europa.eu https://api.frankfurter.dev; font-src 'self' data:; worker-src 'self' blob: https://cdnjs.cloudflare.com"
});

function sendJson(response, status, payload) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function isPublicFile(relative) {
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => part.startsWith('.'))) return false;
  if (relative === 'index.html') return true;
  const extension = path.extname(relative).toLowerCase();
  return parts.length === 1 ? PUBLIC_ROOT_EXTENSIONS.has(extension) : parts[0] === 'assets' && PUBLIC_ASSET_EXTENSIONS.has(extension);
}

async function proxyBanxico(request, response) {
  const token = String(request.headers['x-bio-banxico-token'] || '').trim();
  if (!token) return sendJson(response, 400, { ok: false, error: 'No se recibió el token SIE de Banco de México.' });
  const upstream = await fetch(`${BANXICO_URL}?token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  const body = await upstream.text();
  if (!upstream.ok) return sendJson(response, upstream.status, { ok: false, error: `Banco de México respondió ${upstream.status}. Verifica que el token SIE esté activo.` });
  response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  response.end(body);
}

function readJson(request, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > maxBytes) { reject(Object.assign(new Error('La solicitud supera el límite permitido.'), { status: 413 })); request.destroy(); } else body += chunk; });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('El cuerpo JSON no es válido.'), { status: 400 })); } });
    request.on('error', reject);
  });
}

function roleForActor(state, actor) {
  const users = state?.['nexo-access-v1']?.users || [], match = users.find(user => String(user.name || '').trim().toLowerCase() === String(actor || '').trim().toLowerCase());
  return match?.role || null;
}

function withoutListPrice(record) {
  const copy = JSON.parse(JSON.stringify(record));
  delete copy.price; delete copy.listPrice; delete copy.purchasePrice; delete copy.cost; delete copy.sourcePrice; return copy;
}

function sanitizeForRole(state, role) {
  if (role !== 'seller') return state;
  const copy = JSON.parse(JSON.stringify(state));
  copy['nexo-products'] = (copy['nexo-products'] || []).map(withoutListPrice);
  copy['nexo-price-catalog-entries'] = (copy['nexo-price-catalog-entries'] || []).map(withoutListPrice);
  copy['nexo-product-supplier-relations'] = (copy['nexo-product-supplier-relations'] || []).map(withoutListPrice);
  copy['nexo-sales-quotations'] = (copy['nexo-sales-quotations'] || []).map(quotation => ({ ...quotation, items: (quotation.items || []).map(withoutListPrice) }));
  return copy;
}

const STATE_PERMISSIONS = Object.freeze({
  'nexo-access-v1': 'user_manage', 'nexo-fx-v1': 'system_config', 'nexo-products': 'catalog_manage', 'nexo-suppliers': 'supplier_manage', 'nexo-price-loads': 'supplier_manage', 'nexo-price-catalog-entries': 'supplier_manage', 'nexo-product-supplier-relations': 'supplier_manage', 'nexo-movements': 'inventory_manage', 'nexo-clients': 'client_manage', 'nexo-sales-quotations': 'quotation_manage', 'nexo-commercial-orders': 'client_order_manage', 'nexo-quotation-sequences': 'quotation_manage', 'nexo-purchase-orders': 'supplier_order_manage', 'nexo-order-operations-v1': 'supplier_order_manage'
});
function can(user, state, permission) {
  const roles = { administrator: Object.values(STATE_PERMISSIONS), auditor: ['audit'], supervisor: Object.values(STATE_PERMISSIONS).filter(item => !['user_manage', 'system_config'].includes(item)), seller: ['quotation_manage', 'client_manage', 'client_order_manage'] };
  const access = state?.['nexo-access-v1'] || {}, record = (access.users || []).find(item => item.id === user?.id) || {}, overrides = access.roleOverrides?.[user?.role] || {};
  const granted = new Set([...(roles[user?.role] || []), ...(overrides.grants || []), ...(record.permissionGrants || [])]);
  [...(overrides.denials || []), ...(record.permissionDenials || [])].forEach(item => granted.delete(item));
  return granted.has(permission);
}

async function createApp(options = {}) {
  const db = options.db || await openDatabase({ connectionString: options.connectionString });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`), pathname = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'PROBIOLAB API', database: 'PostgreSQL', time: new Date().toISOString() });
      if (request.method === 'GET' && pathname === '/api/auth/me') {
        const user = await currentUser(db, request);
        return user ? sendJson(response, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } }) : sendJson(response, 401, { ok: false, setupReady: await setupReady(db), error: 'Inicia sesión para continuar.' });
      }
      if (request.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJson(request), result = await login(db, body.email, body.password);
        if (!result) return sendJson(response, 401, { ok: false, error: 'Correo o contraseña incorrectos.' });
        response.setHeader('Set-Cookie', sessionCookie(result.token)); return sendJson(response, 200, { ok: true, user: result.user });
      }
      if (request.method === 'POST' && pathname === '/api/auth/setup') {
        const body = await readJson(request), result = await setupAdministrator(db, body.email, body.password);
        response.setHeader('Set-Cookie', sessionCookie(result.token)); return sendJson(response, 201, { ok: true, user: result.user });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        clearSession(request); response.setHeader('Set-Cookie', 'bio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return sendJson(response, 200, { ok: true });
      }
      const authenticated = await currentUser(db, request), rawState = authenticated ? null : await readState(db), initialBootstrap = !authenticated && Object.keys(rawState).length === 0;
      if (!authenticated && !initialBootstrap && pathname.startsWith('/api/')) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para usar la API.' });
      if (request.method === 'GET' && pathname === '/api/fx/banxico') return proxyBanxico(request, response);
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        const sourceState = rawState || await readState(db), state = sanitizeForRole(sourceState, authenticated?.role), revisionRows = await db.query('SELECT state_key,revision,updated_at,updated_by FROM app_state'), revisions = Object.fromEntries(revisionRows.rows.map(row => [row.state_key, row]));
        return sendJson(response, 200, { ok: true, empty: Object.keys(state).length === 0, state, revisions, allowedKeys: STATE_KEYS });
      }
      if (request.method === 'PUT' && pathname.startsWith('/api/state/')) {
        if (!authenticated) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para guardar cambios.' });
        const stateKey = pathname.slice('/api/state/'.length), currentState = await readState(db), permission = STATE_PERMISSIONS[stateKey];
        if (!permission || !can(authenticated, currentState, permission)) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para modificar esta información.' });
        const body = await readJson(request), revision = await saveState(db, stateKey, body.payload, authenticated.name); return sendJson(response, 200, { ok: true, revision });
      }
      if (request.method === 'POST' && pathname.startsWith('/api/auth/users/') && pathname.endsWith('/password')) {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'user_manage')) return sendJson(response, 403, { ok: false, error: 'Solo un administrador puede asignar contraseñas.' });
        const userId = pathname.slice('/api/auth/users/'.length, -'/password'.length), body = await readJson(request); await setPassword(db, userId, body.password); return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/import-local') {
        const body = await readJson(request), result = await importSnapshot(db, body.state || {}, authenticated?.name || 'Migración inicial local');
        return sendJson(response, 201, { ok: true, ...result });
      }
      if (request.method === 'POST' && pathname === '/api/quotation-conversion/validate') {
        const body = await readJson(request), assessment = assessQuotationConversion(body.quotation, { canConvert: body.canConvert !== false, now: body.now ? new Date(body.now) : new Date() });
        return sendJson(response, assessment.ok ? 200 : 422, { ok: assessment.ok, assessment });
      }
      if (request.method === 'GET' && pathname === '/api/audit') return sendJson(response, 200, { ok: true, data: await listAudit(db, url.searchParams.get('limit')) });
      if (request.method === 'GET' && pathname.startsWith('/api/')) {
        const resource = pathname.slice('/api/'.length), data = await listResource(db, resource), safeData = authenticated?.role === 'seller' && resource === 'products' ? data.map(withoutListPrice) : data;
        if (safeData) return sendJson(response, 200, { ok: true, data: safeData, count: safeData.length });
        return sendJson(response, 404, { ok: false, error: 'Recurso no encontrado.' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { ok: false, error: 'Método no permitido.' });
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''), file = path.resolve(ROOT, relative);
      if (!isPublicFile(relative) || !file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(response, 404, { ok: false, error: 'Archivo no encontrado.' });
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': options.noCache === false ? 'public, max-age=300' : 'no-store' });
      if (request.method === 'HEAD') return response.end(); fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, { ok: false, error: error.message || 'Error interno.' }); else response.end();
    }
  });
  server.db = db;
  server.closeDatabase = () => db.end?.();
  return server;
}

if (require.main === module) {
  openDatabase().then(db => {
    return createApp({ db }).then(server => {
      server.listen(PORT, HOST, () => console.log(`PROBIOLAB disponible en http://${HOST}:${PORT} · PostgreSQL conectado`));
      const shutdown = () => server.close(async () => { await server.closeDatabase(); process.exit(0); });
      process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    });
  }).catch(error => { console.error(`No fue posible iniciar PROBIOLAB: ${error.message}`); process.exit(1); });
}

module.exports = { createApp };
