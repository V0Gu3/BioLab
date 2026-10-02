'use strict';

// Genera la superficie estática que Vercel puede servir. El código de API,
// pruebas, scripts y configuración no se copian al directorio público.
const fs = require('node:fs');
const path = require('node:path');

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

function copyAssets(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) { copyAssets(from, to); continue; }
    if (entry.isFile() && assetExtensions.has(path.extname(entry.name).toLowerCase())) fs.copyFileSync(from, to);
  }
}

copyAssets(path.join(root, 'assets'), path.join(output, 'assets'));
