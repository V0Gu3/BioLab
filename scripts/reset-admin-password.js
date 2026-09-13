'use strict';

// Recuperación local para el propietario de la base. Requiere una confirmación
// literal para evitar sobrescribir una contraseña por accidente.
const { openDatabase } = require('../server/db');
const { setPassword } = require('../server/auth');

const email = String(process.env.BIO_ADMIN_RESET_EMAIL || '').trim().toLowerCase();
const password = String(process.env.BIO_ADMIN_RESET_PASSWORD || '');

async function main() {
  if (process.env.BIO_ADMIN_RESET_CONFIRM !== 'YES') throw new Error('Agrega BIO_ADMIN_RESET_CONFIRM=YES en .env para confirmar el restablecimiento.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Configura BIO_ADMIN_RESET_EMAIL con un correo válido en .env.');
  if (password.length < 12) throw new Error('Configura BIO_ADMIN_RESET_PASSWORD con al menos 12 caracteres en .env.');
  const db = await openDatabase();
  try {
    const { rows } = await db.query("SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role='administrator' AND status='active'", [email]);
    if (!rows[0]) throw new Error('No existe un administrador activo con ese correo.');
    await setPassword(db, rows[0].id, password);
    console.log(`Contraseña restablecida para ${email}. Elimina las tres variables BIO_ADMIN_RESET de .env ahora.`);
  } finally {
    await db.end();
  }
}

main().catch(error => { console.error(`No fue posible restablecer la contraseña: ${error.message}`); process.exitCode = 1; });
