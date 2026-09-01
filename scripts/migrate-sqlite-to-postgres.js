'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, importSnapshot, readState } = require('../server/db');

async function main() {
  const source = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'bio.db'));
  if (!fs.existsSync(source)) throw new Error(`No existe la base SQLite de origen: ${source}`);
  if (!process.env.DATABASE_URL && !process.env.BIO_DATABASE_URL) throw new Error('Define DATABASE_URL con la conexión PostgreSQL de destino.');
  const sqlite = new DatabaseSync(source, { readOnly: true });
  let snapshot;
  try { snapshot = Object.fromEntries(sqlite.prepare('SELECT state_key,payload_json FROM app_state').all().map(row => [row.state_key, JSON.parse(row.payload_json)])); }
  finally { sqlite.close(); }
  const postgres = await openDatabase();
  try {
    const result = await importSnapshot(postgres, snapshot, 'Migración SQLite → PostgreSQL'), state = await readState(postgres);
    console.log(JSON.stringify({ ok: true, source, importedKeys: result.imported, verifiedKeys: Object.keys(state).length }, null, 2));
  } finally { await postgres.end(); }
}

main().catch(error => { console.error(`Migración cancelada: ${error.message}`); process.exitCode = 1; });
