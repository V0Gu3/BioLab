'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, readState, saveState, importSnapshot, listResource, listAudit, STATE_KEYS } = require('./db');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BIO_PORT || 8787);
const HOST = process.env.BIO_HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
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

async function createApp(options = {}) {
  const db = options.db || await openDatabase({ connectionString: options.connectionString });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`), pathname = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'PROBIOLAB API', database: 'PostgreSQL', time: new Date().toISOString() });
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        const state = await readState(db), revisionRows = await db.query('SELECT state_key,revision,updated_at,updated_by FROM app_state'), revisions = Object.fromEntries(revisionRows.rows.map(row => [row.state_key, row]));
        return sendJson(response, 200, { ok: true, empty: Object.keys(state).length === 0, state, revisions, allowedKeys: STATE_KEYS });
      }
      if (request.method === 'PUT' && pathname.startsWith('/api/state/')) {
        const stateKey = pathname.slice('/api/state/'.length), body = await readJson(request), actor = String(request.headers['x-bio-user'] || body.actor || 'Sistema');
        const revision = await saveState(db, stateKey, body.payload, actor); return sendJson(response, 200, { ok: true, revision });
      }
      if (request.method === 'POST' && pathname === '/api/import-local') {
        const body = await readJson(request), result = await importSnapshot(db, body.state || {}, String(request.headers['x-bio-user'] || body.actor || 'Migración local'));
        return sendJson(response, 201, { ok: true, ...result });
      }
      if (request.method === 'GET' && pathname === '/api/audit') return sendJson(response, 200, { ok: true, data: await listAudit(db, url.searchParams.get('limit')) });
      if (request.method === 'GET' && pathname.startsWith('/api/')) {
        const resource = pathname.slice('/api/'.length), data = await listResource(db, resource);
        if (data) return sendJson(response, 200, { ok: true, data, count: data.length });
        return sendJson(response, 404, { ok: false, error: 'Recurso no encontrado.' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { ok: false, error: 'Método no permitido.' });
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''), file = path.resolve(ROOT, relative);
      if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(response, 404, { ok: false, error: 'Archivo no encontrado.' });
      response.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': options.noCache === false ? 'public, max-age=300' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
