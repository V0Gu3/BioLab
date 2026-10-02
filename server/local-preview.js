'use strict';

// Vista local temporal: permite revisar PROBIOLAB cuando PostgreSQL/Supabase aún no está configurado.
// La interfaz detecta que no hay API y conserva sus datos exclusivamente en el navegador.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BIO_PORT || 8787);
const HOST = process.env.BIO_HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
const PUBLIC_ROOT_EXTENSIONS = new Set(['.js', '.css']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.pdf']);
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://www.banxico.org.mx https://data-api.ecb.europa.eu https://api.frankfurter.dev; font-src 'self' data:; worker-src 'self' blob:"
});

function isPublicFile(relative) {
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => part.startsWith('.'))) return false;
  if (relative === 'index.html' || relative === 'login.html') return true;
  const extension = path.extname(relative).toLowerCase();
  return parts.length === 1 ? PUBLIC_ROOT_EXTENSIONS.has(extension) : parts[0] === 'assets' && PUBLIC_ASSET_EXTENSIONS.has(extension);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ ok: false, error: 'La vista local es de solo lectura para API.' }));
  }
  if (url.pathname.startsWith('/api/')) {
    response.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ ok: false, error: 'Vista local: PostgreSQL no está conectado.' }));
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if (!isPublicFile(relative) || !file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end('Archivo no encontrado');
  }
  response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(file).pipe(response);
});

server.listen(PORT, HOST, () => console.log(`PROBIOLAB local disponible en http://${HOST}:${PORT} · datos solo en este navegador`));
