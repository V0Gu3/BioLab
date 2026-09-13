'use strict';
const crypto = require('node:crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const hashPassword = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
};
const verifyPassword = (password, stored) => {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return candidate.length === digest.length && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(digest, 'hex'));
};
const cookieValue = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
const validPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 256;
const tokenHash = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');

function sessionCookie(token) {
  return `bio_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.BIO_COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
}

async function currentUser(db, request) {
  const token = cookieValue(request).bio_session;
  if (!token) return null;
  const { rows } = await db.query('SELECT u.id,u.name,u.email,u.role,u.status,u.payload_json FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2', [tokenHash(token), new Date().toISOString()]);
  const user = rows[0];
  if (!user || user.status !== 'active') return null;
  return user;
}

async function login(db, email, password) {
  const normalized = normalizeEmail(email);
  const { rows } = await db.query('SELECT u.id,u.name,u.email,u.role,u.status,u.payload_json,c.password_hash FROM users u JOIN user_credentials c ON c.user_id=u.id WHERE LOWER(u.email)=LOWER($1)', [normalized]);
  const user = rows[0];
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM user_sessions WHERE expires_at<=$1 OR user_id=$2', [new Date().toISOString(), user.id]);
  await db.query('INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString()]);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

async function setupReady(db) {
  const users = await db.query("SELECT COUNT(*)::int AS count FROM users WHERE role='administrator' AND status='active'");
  const credentials = await db.query('SELECT COUNT(*)::int AS count FROM user_credentials');
  return Number(users.rows[0].count) > 0 && Number(credentials.rows[0].count) === 0;
}

async function setupAdministrator(db, email, password) {
  if (!validPassword(password)) throw Object.assign(new Error('La contraseña debe tener al menos 12 caracteres.'), { status: 400 });
  if (!await setupReady(db)) throw Object.assign(new Error('La configuración inicial no está disponible.'), { status: 409 });
  const { rows } = await db.query("SELECT id,name,email,role FROM users WHERE LOWER(email)=LOWER($1) AND role='administrator' AND status='active'", [normalizeEmail(email)]);
  const user = rows[0];
  if (!user) throw Object.assign(new Error('El correo no corresponde a un administrador activo.'), { status: 403 });
  await db.query('INSERT INTO user_credentials(user_id,password_hash,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP)', [user.id, hashPassword(password)]);
  return login(db, email, password);
}

async function setPassword(db, userId, password) {
  if (!validPassword(password)) throw Object.assign(new Error('La contraseña debe tener al menos 12 caracteres.'), { status: 400 });
  const { rows } = await db.query('SELECT id FROM users WHERE id=$1 AND status=$2', [userId, 'active']);
  if (!rows[0]) throw Object.assign(new Error('El usuario activo no existe.'), { status: 404 });
  await db.query('INSERT INTO user_credentials(user_id,password_hash,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=EXCLUDED.updated_at', [userId, hashPassword(password)]);
}

async function clearSession(db, request) { const token = cookieValue(request).bio_session; if (token) await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash(token)]); }
module.exports = { currentUser, login, setupReady, setupAdministrator, setPassword, sessionCookie, clearSession, validPassword };
