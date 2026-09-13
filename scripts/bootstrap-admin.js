'use strict';

// Crea una única cuenta inicial de forma explícita. Las credenciales se leen
// exclusivamente del .env local y no se imprimen ni se guardan en Git.
const { openDatabase, saveState } = require('../server/db');
const { setPassword } = require('../server/auth');

const email = String(process.env.BIO_INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.BIO_INITIAL_ADMIN_PASSWORD || '');
const name = String(process.env.BIO_INITIAL_ADMIN_NAME || 'Administrador PROBIOLAB').trim();

async function main() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Configura BIO_INITIAL_ADMIN_EMAIL con un correo válido en .env.');
  if (password.length < 12) throw new Error('Configura BIO_INITIAL_ADMIN_PASSWORD con al menos 12 caracteres en .env.');
  const db = await openDatabase();
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM users');
    if (Number(rows[0].count) > 0) throw new Error('La base ya tiene usuarios. El arranque inicial solo se permite en una base nueva.');
    const state = {
      version: 3,
      currentUserId: 'USR-001',
      users: [{ id: 'USR-001', name, email, role: 'administrator', status: 'active', createdAt: new Date().toISOString() }],
      roleOverrides: {}, workspace: { sandboxEnabled: true, modes: {} }, audit: []
    };
    await saveState(db, 'nexo-access-v1', state, 'Configuración inicial segura');
    await setPassword(db, 'USR-001', password);
    console.log(`Administrador inicial creado para ${email}. Elimina BIO_INITIAL_ADMIN_PASSWORD de .env ahora.`);
  } finally {
    await db.end();
  }
}

main().catch(error => { console.error(`No fue posible crear el administrador inicial: ${error.message}`); process.exitCode = 1; });
