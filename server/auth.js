'use strict';
const crypto = require('node:crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
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
const loginScope = (email, clientAddress) => crypto.createHash('sha256').update(`${normalizeEmail(email)}|${String(clientAddress || 'unknown')}`).digest('hex');

async function loginAllowance(db, scope) {
  const { rows } = await db.query('SELECT failed_attempts,window_started_at,locked_until FROM auth_login_attempts WHERE scope=$1', [scope]);
  const attempt = rows[0], now = Date.now();
  if (!attempt) return { allowed: true };
  const lockedUntil = Date.parse(attempt.locked_until || '');
  if (Number.isFinite(lockedUntil) && lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
  return { allowed: true };
}

async function recordFailedLogin(db, scope) {
  const { rows } = await db.query('SELECT failed_attempts,window_started_at FROM auth_login_attempts WHERE scope=$1', [scope]);
  const now = Date.now(), prior = rows[0], startedAt = Date.parse(prior?.window_started_at || ''), failures = Number.isFinite(startedAt) && now - startedAt < LOGIN_WINDOW_MS ? Number(prior.failed_attempts || 0) + 1 : 1;
  const lockedUntil = failures >= LOGIN_MAX_FAILURES ? new Date(now + LOGIN_LOCK_MS).toISOString() : null;
  await db.query('INSERT INTO auth_login_attempts(scope,failed_attempts,window_started_at,locked_until,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope) DO UPDATE SET failed_attempts=EXCLUDED.failed_attempts,window_started_at=EXCLUDED.window_started_at,locked_until=EXCLUDED.locked_until,updated_at=EXCLUDED.updated_at', [scope, failures, new Date(now).toISOString(), lockedUntil, new Date(now).toISOString()]);
  return lockedUntil ? { allowed: false, retryAfter: Math.ceil(LOGIN_LOCK_MS / 1000) } : { allowed: true };
}

async function clearFailedLogins(db, scope) { await db.query('DELETE FROM auth_login_attempts WHERE scope=$1', [scope]); }

function sessionCookie(token) {
  return `bio_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.BIO_COOKIE_SECURE === 'true' || process.env.VERCEL === '1' ? '; Secure' : ''}`;
}

async function currentUser(db, request) {
  const token = cookieValue(request).bio_session;
  if (!token) return null;
  const now = new Date(), { rows } = await db.query('SELECT u.id,u.name,u.email,u.role,u.status,u.payload_json FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.last_seen_at>$3', [tokenHash(token), now.toISOString(), new Date(now.getTime() - SESSION_IDLE_MS).toISOString()]);
  const user = rows[0];
  if (!user || user.status !== 'active') return null;
  await db.query('UPDATE user_sessions SET last_seen_at=$2 WHERE token_hash=$1', [tokenHash(token), now.toISOString()]);
  return user;
}
async function createSessionForUser(db, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM user_sessions WHERE expires_at<=$1 OR user_id=$2', [new Date().toISOString(), user.id]);
  await db.query('INSERT INTO user_sessions(token_hash,user_id,expires_at,last_seen_at) VALUES($1,$2,$3,$4)', [tokenHash(token), user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString(), new Date().toISOString()]);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

async function login(db, email, password, clientAddress) {
  // Se controla la combinación correo/IP y también el correo por sí solo,
  // evitando elusión al rotar o falsear la IP de origen.
  const scopes = [loginScope(email, clientAddress), loginScope(email, 'email')];
  const allowances = await Promise.all(scopes.map(scope => loginAllowance(db, scope)));
  const blocked = allowances.find(allowance => !allowance.allowed);
  if (blocked) return { blocked: true, retryAfter: blocked.retryAfter };
  const normalized = normalizeEmail(email);
  const { rows } = await db.query('SELECT u.id,u.name,u.email,u.role,u.status,u.payload_json,c.password_hash FROM users u JOIN user_credentials c ON c.user_id=u.id WHERE LOWER(u.email)=LOWER($1)', [normalized]);
  const user = rows[0];
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    const results = await Promise.all(scopes.map(scope => recordFailedLogin(db, scope)));
    const failureBlock = results.find(result => !result.allowed);
    return failureBlock ? { blocked: true, retryAfter: failureBlock.retryAfter } : null;
  }
  await Promise.all(scopes.map(scope => clearFailedLogins(db, scope)));
  return createSessionForUser(db, user);
}

async function verifyUserPassword(db, userId, password) {
  const { rows } = await db.query('SELECT c.password_hash FROM users u JOIN user_credentials c ON c.user_id=u.id WHERE u.id=$1 AND u.status=$2', [userId, 'active']);
  return Boolean(rows[0] && verifyPassword(password, rows[0].password_hash));
}

async function setupReady(db) {
  const { rows } = await db.query("SELECT EXISTS(SELECT 1 FROM users WHERE role='administrator' AND status='active') AS has_administrator, EXISTS(SELECT 1 FROM user_credentials) AS has_credentials");
  return Boolean(rows[0]?.has_administrator) && !Boolean(rows[0]?.has_credentials);
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
  await db.query('DELETE FROM user_sessions WHERE user_id=$1', [userId]);
}

async function clearSession(db, request) { const token = cookieValue(request).bio_session; if (token) await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [tokenHash(token)]); }
async function clearUserSessions(db, userId) { await db.query('DELETE FROM user_sessions WHERE user_id=$1', [userId]); }
module.exports = { currentUser, login, createSessionForUser, setupReady, setupAdministrator, setPassword, sessionCookie, clearSession, clearUserSessions, validPassword, verifyUserPassword };
