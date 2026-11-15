'use strict';

// Genera la superficie estática que Vercel puede servir. El código de API,
// pruebas, scripts y configuración no se copian al directorio público.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const staticExtensions = new Set(['.js', '.css', '.webmanifest']);
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico', '.pdf', '.js', '.mjs', '.xlsx']);

fs.mkdirSync(output, { recursive: true });
for (const file of fs.readdirSync(root, { withFileTypes: true })) {
  if (!file.isFile()) continue;
  const extension = path.extname(file.name).toLowerCase();
  if (file.name === 'index.html' || file.name === 'login.html' || staticExtensions.has(extension)) {
    fs.copyFileSync(path.join(root, file.name), path.join(output, file.name));
  }
}

// Los módulos operativos usan una versión derivada de su contenido. Así, una
// corrección llega de inmediato pero un despliegue sin cambios no obliga a los
// navegadores a descargar otra vez los mismos bytes.
const publicIndex = path.join(output, 'index.html');
if (fs.existsSync(publicIndex)) {
  let html = fs.readFileSync(publicIndex, 'utf8');
  const versionedAssets = [...html.matchAll(/(?:^|["'])((?:[a-z0-9-]+)\.js)\?v=[^"']+/gi)].map(match => match[1]);
  for (const asset of new Set(versionedAssets)) {
    const source = path.join(root, asset);
    if (!fs.existsSync(source)) continue;
    const version = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
    html = html.replace(new RegExp(`${asset.replace('.', '\\.')}\\?v=[^"']+`, 'g'), `${asset}?v=${version}`);
  }
  fs.writeFileSync(publicIndex, html);
}

function copyAssets(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) { copyAssets(from, to); continue; }
    if (entry.isFile() && assetExtensions.has(path.extname(entry.name).toLowerCase())) fs.copyFileSync(from, to);
  }
}

copyAssets(path.join(root, 'assets'), path.join(output, 'assets'));
