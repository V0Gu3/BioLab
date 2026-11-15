'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, readState, readStateKeys, stateEgressDiagnostics, saveState, saveStates, importSnapshot, resetOperationalData, emptyTrainingState, listResource, listAudit, createApproval, listApprovals, decideApproval, executiveDashboard, operationalAlerts, listClientQuotations, createInternalOrder, updateInternalOrder, activateInternalOrder, STATE_KEYS } = require('./db');
const { assess: assessQuotationConversion } = require('../quotation-conversion');
const { currentUser, login, createSessionForUser, setupReady, setupAdministrator, setPassword, sessionCookie, clearSession, clearUserSessions, verifyUserPassword } = require('./auth');
const { registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication, hasPasskey } = require('./passkeys');
const { buildInternalOrdersReport, paginateReport } = require('./internal-orders-report');
const { searchInternalOrderTargets } = require('./internal-orders-search');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.BIO_PORT || 8787);
const HOST = process.env.BIO_HOST || '127.0.0.1';
const DOF_INDICATORS_URL = 'https://dof.gob.mx/indicadores_detalle.php';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
const PUBLIC_ROOT_EXTENSIONS = new Set(['.js', '.css']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.pdf']);
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-create=(self), publickey-credentials-get=(self)',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://www.banxico.org.mx https://data-api.ecb.europa.eu https://api.frankfurter.dev; font-src 'self' data:; worker-src 'self' blob:"
});

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload), bytes = Buffer.byteLength(body);
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Content-Length': bytes, 'X-Bio-Payload-Bytes': bytes });
  response.end(body);
}

function parseDofUsdIndicator(html) {
  const content = String(html || '').replace(/&nbsp;/gi, ' ');
  const detailRows = [...content.matchAll(/<td[^>]*>\s*(\d{2})-(\d{2})-(\d{4})\s*<\/td>\s*<td[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)\s*<\/td>/gi)];
  const latest = detailRows.at(-1);
  const value = latest?.[4] || content.match(/<span[^>]*>\s*DOLAR\s*<\/span>\s*<br\s*\/?\s*>\s*([0-9]+(?:[.,][0-9]+)?)/i)?.[1];
  const usd = Number(String(value || '').replaceAll(',', ''));
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('No fue posible identificar el valor DOLAR publicado por el Diario Oficial.');
  const date = latest || content.match(/Tipo\s+de\s+Cambio\s+y\s+Tasas\s+al\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  return { usd, rateDate: date ? `${date[3]}-${date[2]}-${date[1]}` : null };
}

function dofUsdHistoryUrl(now = new Date()) {
  const format = date => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.day}/${parts.month}/${parts.year}`;
  };
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const query = new URLSearchParams({ cod_tipo_indicador: '158', dfecha: format(start), hfecha: format(now) });
  return `${DOF_INDICATORS_URL}?${query}`;
}

function dofPublicationMetadata(rateDate, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const operationalDate = `${parts.year}-${parts.month}-${parts.day}`;
  const isPreviousPublication = Boolean(rateDate && rateDate !== operationalDate);
  return {
    publicationId: `DOF-USD-${rateDate || operationalDate}`,
    publicationStatus: isPreviousPublication ? 'latest_official_published' : 'official_for_operational_date',
    publicationLabel: isPreviousPublication ? `Último valor oficial publicado · ${rateDate}` : `Valor oficial publicado hoy · ${operationalDate}`,
    operationalDate,
    isPreviousPublication
  };
}

// El estado de inicio contiene datos privados y filtrados por perfil. Se puede
// reutilizar únicamente dentro del navegador de esa sesión, siempre validándolo
// contra el servidor antes de usarlo de nuevo.
function bootstrapEtag(user, revisions, readableKeys, allowedKeys) {
  const revisionSignature = readableKeys.slice().sort().map(key => {
    const revision = revisions[key] || {};
    return `${key}:${revision.revision || 0}:${revision.updated_at || ''}`;
  }).join('|');
  const scope = [user?.id || 'bootstrap', user?.role || 'bootstrap', ...allowedKeys.slice().sort(), revisionSignature].join('|');
  return `\"${crypto.createHash('sha256').update(scope).digest('base64url')}\"`;
}

function acceptsEtag(request, etag) {
  return String(request.headers['if-none-match'] || '').split(',').map(value => value.trim()).includes(etag);
}

function bootstrapClientCache(request) {
  const parseHeader = name => {
    const raw = String(request.headers[name] || '');
    if (!raw || raw.length > 8192) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const rawRevisions = parseHeader('x-bio-state-revisions'), rawKeys = parseHeader('x-bio-state-keys');
  if (!rawRevisions || typeof rawRevisions !== 'object' || !Array.isArray(rawKeys)) return null;
  const revisions = Object.fromEntries(STATE_KEYS.filter(key => rawRevisions[key] != null).map(key => [key, Number(rawRevisions[key]?.revision ?? rawRevisions[key]) || 0]));
  const keys = [...new Set(rawKeys.filter(key => STATE_KEYS.includes(key)))];
  return Object.keys(revisions).length ? { revisions, keys } : null;
}

const requestedWorkspace = request => String(request.headers['x-bio-workspace'] || 'operational').toLowerCase() === 'training' ? 'training' : 'operational';

function sendBootstrap(response, request, payload, etag) {
  const headers = { ...SECURITY_HEADERS, ETag: etag, Vary: 'Cookie', 'Cache-Control': 'private, no-cache, must-revalidate' };
  if (acceptsEtag(request, etag)) {
    response.writeHead(304, { ...headers, 'X-Bio-Payload-Bytes': '0' });
    return response.end();
  }
  const body = JSON.stringify(payload), bytes = Buffer.byteLength(body);
  response.writeHead(200, { ...headers, 'Content-Type': MIME['.json'], 'Content-Length': bytes, 'X-Bio-Payload-Bytes': bytes });
  response.end(body);
}

const clientAddress = request => String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim();
const secureEqual = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

function isPublicFile(relative) {
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => part.startsWith('.'))) return false;
  if (relative === 'index.html' || relative === 'login.html') return true;
  const extension = path.extname(relative).toLowerCase();
  return parts.length === 1 ? PUBLIC_ROOT_EXTENSIONS.has(extension) : parts[0] === 'assets' && PUBLIC_ASSET_EXTENSIONS.has(extension);
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
  if (!record || typeof record !== 'object') return record;
  const hidden = new Set(['price', 'listPrice', 'purchasePrice', 'cost', 'sourcePrice']);
  const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key)).map(([key, nested]) => [key, redact(nested)])) : value;
  return redact(record);
}

const sellerOwns = (record, user) => String(record?.ownerId || '') === String(user?.id || '') || (!record?.ownerId && String(record?.ownerName || '').trim().toLowerCase() === String(user?.name || '').trim().toLowerCase());
const SELLER_OWNED_KEYS = new Set(['nexo-clients']);
const SELLER_WRITE_OWNED_KEYS = new Set(['nexo-clients', 'nexo-sales-quotations', 'nexo-commercial-orders']);
const SELLER_HIDDEN_ARRAY_KEYS = new Set(['nexo-suppliers', 'nexo-movements', 'nexo-price-loads', 'nexo-purchase-orders']);

function mergeSellerPortfolio(current = [], incoming = [], user, key) {
  const prior = Array.isArray(current) ? current : [], submitted = Array.isArray(incoming) ? incoming : [];
  const currentById = new Map(prior.map(record => [String(record?.id || ''), record]));
  const approved = new Map();
  for (const submittedRecord of submitted) {
    if (!submittedRecord || typeof submittedRecord !== 'object') continue;
    const id = String(submittedRecord.id || '');
    const existing = currentById.get(id);
    if (existing && !sellerOwns(existing, user)) continue;
    const ownership = existing ? { ownerId: existing.ownerId || user.id, ownerName: existing.ownerName || user.name } : { ownerId: user.id, ownerName: user.name };
    approved.set(id, { ...submittedRecord, ...ownership });
  }
  const protectedRecords = prior.filter(record => !sellerOwns(record, user));
  return [...protectedRecords, ...approved.values()];
}

const LOCKED_IDENTITY_FIELDS = new Set(['ownerId', 'ownerName', 'ownerSellerNumber']);
function lockedBusinessSnapshot(record) {
  return Object.fromEntries(Object.entries(record || {}).filter(([key]) => !LOCKED_IDENTITY_FIELDS.has(key)));
}
function sameLockedBusinessData(before, after) {
  return JSON.stringify(lockedBusinessSnapshot(before)) === JSON.stringify(lockedBusinessSnapshot(after));
}

function enforceRequiredQuotationLock(currentState, nextQuotations) {
  const before = Array.isArray(currentState['nexo-sales-quotations']) ? currentState['nexo-sales-quotations'] : [], after = Array.isArray(nextQuotations) ? nextQuotations : [];
  const submitted = new Map(after.map(quotation => [String(quotation?.id || ''), quotation]));
  for (const quotation of before.filter(item => item?.locked || String(item?.status || '').toLowerCase() === 'required')) {
    const proposed = submitted.get(String(quotation.id));
    if (!proposed || !sameLockedBusinessData(proposed, quotation)) throw Object.assign(new Error(`La cotización ${quotation.id} está requerida para compras y ya no puede editarse.`), { status: 409 });
  }
}

function enforceActivatedOrderLock(currentState, nextOrders) {
  const before = Array.isArray(currentState?.['nexo-commercial-orders']) ? currentState['nexo-commercial-orders'] : [], after = Array.isArray(nextOrders) ? nextOrders : [];
  const submitted = new Map(after.map(order => [String(order?.id || ''), order]));
  for (const order of before.filter(item => String(item?.status || '').toLowerCase() === 'active')) {
    const proposed = submitted.get(String(order.id));
    if (!proposed || !sameLockedBusinessData(proposed, order)) throw Object.assign(new Error(`El pedido ${order.id} ya fue activado y una sincronización anterior no puede modificarlo.`), { status: 409 });
  }
}

function sanitizeForRole(state, role) {
  if (role !== 'seller') return state;
  const copy = JSON.parse(JSON.stringify(state));
  copy['nexo-products'] = (copy['nexo-products'] || []).map(withoutListPrice);
  copy['nexo-price-catalog-entries'] = (copy['nexo-price-catalog-entries'] || []).map(withoutListPrice);
  copy['nexo-product-supplier-relations'] = (copy['nexo-product-supplier-relations'] || []).map(withoutListPrice);
  copy['nexo-sales-quotations'] = (copy['nexo-sales-quotations'] || []).map(withoutListPrice);
  copy['nexo-commercial-orders'] = (copy['nexo-commercial-orders'] || []).map(withoutListPrice);
  return copy;
}

function portfolioForUser(state, user) {
  const copy = sanitizeForRole(state, user?.role);
  const access = copy['nexo-access-v1'] || {}, safeUser = (access.users || []).find(item => String(item.id) === String(user?.id)) || user;
  if (user?.role === 'seller') {
    for (const key of SELLER_OWNED_KEYS) copy[key] = (copy[key] || []).filter(record => sellerOwns(record, user));
    for (const key of SELLER_HIDDEN_ARRAY_KEYS) copy[key] = [];
    copy['nexo-order-operations-v1'] = {};
    if (copy['nexo-fx-v1']) delete copy['nexo-fx-v1'].banxicoToken;
    copy['nexo-access-v1'] = { version: access.version || 4, currentUserId: user.id, users: safeUser ? [{ id: safeUser.id, name: safeUser.name, email: safeUser.email, role: safeUser.role, sellerNumber: safeUser.sellerNumber || '', status: safeUser.status }] : [], roleOverrides: {}, workspace: { sandboxEnabled: true, modes: {} }, audit: [] };
    return copy;
  }
  if (user?.role === 'supervisor') {
    const users = (access.users || []).filter(item => item.status === 'active' && (item.role === 'seller' || String(item.id) === String(user.id))).map(item => ({ id: item.id, name: item.name, email: item.email, role: item.role, status: item.status }));
    copy['nexo-access-v1'] = { version: access.version || 3, currentUserId: user.id, users, roleOverrides: {}, workspace: { sandboxEnabled: true, modes: {} }, audit: [] };
  }
  return copy;
}

const STATE_PERMISSIONS = Object.freeze({
  'nexo-access-v1': 'user_manage', 'nexo-fx-v1': 'system_config', 'nexo-quotation-terms-v1': 'system_config', 'nexo-products': 'catalog_manage', 'nexo-suppliers': 'supplier_manage', 'nexo-price-loads': 'supplier_manage', 'nexo-price-catalog-entries': 'supplier_manage', 'nexo-product-supplier-relations': 'supplier_manage', 'nexo-movements': 'inventory_manage', 'nexo-clients': 'client_manage', 'nexo-sales-quotations': 'quotation_manage', 'nexo-commercial-orders': 'client_order_manage', 'nexo-quotation-sequences': 'quotation_manage', 'nexo-purchase-orders': 'supplier_order_manage', 'nexo-order-operations-v1': 'supplier_order_manage'
});
const STATE_READ_PERMISSIONS = Object.freeze({
  'nexo-access-v1': 'user_manage', 'nexo-fx-v1': 'system_config', 'nexo-quotation-terms-v1': 'system_config', 'nexo-products': 'catalog_view', 'nexo-suppliers': 'supplier_view', 'nexo-price-loads': 'supplier_manage', 'nexo-price-catalog-entries': 'quotation_view', 'nexo-product-supplier-relations': 'supplier_order_view', 'nexo-movements': 'inventory_manage', 'nexo-clients': 'client_view', 'nexo-sales-quotations': 'quotation_view', 'nexo-commercial-orders': 'client_order_view', 'nexo-quotation-sequences': 'quotation_manage', 'nexo-purchase-orders': 'supplier_order_view', 'nexo-order-operations-v1': 'supplier_order_view'
});
const OPERATIONAL_PERMISSIONS = Object.freeze(['receive', 'deliver', 'invoice', 'cancel']);

// El expediente operativo agrupa varias entidades relacionadas. Los permisos
// de recepción, entrega, facturación y cancelación se revisan también en el
// servidor; no sólo al mostrar u ocultar un botón en el navegador.
function canReadState(user, state, stateKey) {
  if (stateKey === 'nexo-order-operations-v1') return can(user, state, 'supplier_order_view') || OPERATIONAL_PERMISSIONS.some(permission => can(user, state, permission));
  return can(user, state, STATE_READ_PERMISSIONS[stateKey]);
}

function canWriteState(user, state, stateKey) {
  if (stateKey === 'nexo-order-operations-v1') return can(user, state, 'supplier_order_manage') || OPERATIONAL_PERMISSIONS.some(permission => can(user, state, permission));
  return can(user, state, STATE_PERMISSIONS[stateKey]);
}

const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const stateSectionChanged = (current, next, key) => !sameValue(current?.[key], next?.[key]);
const folioDate = (value, prefix) => {
  const match = String(value || '').match(new RegExp(`^${prefix}-(\\d{2})(\\d{2})(\\d{2})-\\d{4,}$`));
  return match ? `20${match[1]}-${match[2]}-${match[3]}` : '';
};

function assertDocumentHistoryStable(current = {}, next = {}) {
  const conflict = message => { throw Object.assign(new Error(message), { status: 409 }); };
  const assertCollection = ({ key, prefix, dateKey, relationKey }) => {
    const currentRows = Array.isArray(current[key]) ? current[key] : [], nextRows = Array.isArray(next[key]) ? next[key] : [];
    const nextById = new Map(nextRows.map(item => [String(item?.id || item?.folio || ''), item]));
    for (const prior of currentRows) {
      const id = String(prior?.id || prior?.folio || ''), candidate = nextById.get(id);
      if (!candidate) conflict(`${id || 'Un documento histórico'} no puede desaparecer del expediente. Consérvalo y registra su cancelación si corresponde.`);
      const priorFolio = String(prior.folio || prior.id || ''), candidateFolio = String(candidate.folio || candidate.id || '');
      const identityRepair = candidate.identityReconciliation?.source === 'audit_and_inventory_movement' && String(candidate.identityReconciliation?.originalFolio || priorFolio) === priorFolio;
      if (candidateFolio !== priorFolio && !identityRepair) conflict(`El folio ${id} es inmutable.`);
      if (relationKey && String(candidate[relationKey] || '') !== String(prior[relationKey] || '')) conflict(`La relación de ${id} con su pedido es inmutable.`);
      const canonical = folioDate(candidateFolio, prefix), priorDate = String(prior[dateKey] || '').slice(0, 10), nextDate = String(candidate[dateKey] || '').slice(0, 10);
      const canonicalRepair = canonical && nextDate === canonical && (priorDate !== canonical || identityRepair);
      if (priorDate !== nextDate && !canonicalRepair) conflict(`La fecha original de ${id} no puede modificarse.`);
    }
    const currentIds = new Set(currentRows.map(item => String(item?.id || item?.folio || '')));
    for (const candidate of nextRows) {
      if (currentIds.has(String(candidate?.id || candidate?.folio || ''))) continue;
      const canonical = folioDate(candidate.folio || candidate.id, prefix), candidateDate = String(candidate[dateKey] || '').slice(0, 10);
      if (canonical && candidateDate !== canonical) throw Object.assign(new Error(`La fecha de ${candidate.folio || candidate.id} debe coincidir con su folio (${canonical}).`), { status: 400 });
    }
  };
  assertCollection({ key: 'shipments', prefix: 'REM', dateKey: 'date', relationKey: 'requisitionId' });
  assertCollection({ key: 'supplierOrders', prefix: 'OCP', dateKey: 'createdAt' });
}

function assertOperationalWriteAllowed(current = {}, next = {}, user, state) {
  assertDocumentHistoryStable(current, next);
  const changed = key => stateSectionChanged(current, next, key);
  const requirePermission = (permission, label) => {
    if (!can(user, state, permission)) throw Object.assign(new Error(`Tu perfil no tiene permiso para ${label}.`), { status: 403 });
  };
  const needsReceipt = changed('receipts'), needsDelivery = changed('shipments'), needsInvoice = changed('customerInvoices') || changed('supplierInvoices');
  const existingAuditIds = new Set((current.auditLog || []).map(item => String(item?.id || '')));
  const newAuditActions = (next.auditLog || []).filter(item => !existingAuditIds.has(String(item?.id || ''))).map(item => String(item?.action || '').toLowerCase());
  const needsCancellation = newAuditActions.includes('cancel');
  const needsTracking = newAuditActions.some(action => action.startsWith('tracking_'));
  if (needsReceipt) requirePermission('receive', 'registrar recepciones');
  if (needsDelivery) requirePermission('deliver', 'generar remisiones y entregas');
  if (needsInvoice) requirePermission('invoice', 'registrar facturación');
  if (needsCancellation) requirePermission('cancel', 'cancelar operaciones');
  if (needsTracking && !(['supplier_order_manage', ...OPERATIONAL_PERMISSIONS].some(permission => can(user, state, permission)))) throw Object.assign(new Error('Tu perfil no tiene permiso para registrar seguimiento operativo.'), { status: 403 });

  const currentMovements = new Map((current.inventoryMovements || []).map(item => [String(item?.id || ''), item]));
  for (const movement of next.inventoryMovements || []) {
    const prior = currentMovements.get(String(movement?.id || ''));
    if (prior && sameValue(prior, movement)) continue;
    const source = String(movement?.sourceDocumentType || '').toLowerCase();
    if (source === 'receipt') requirePermission('receive', 'registrar entradas de recepción');
    else if (source === 'shipment') requirePermission('deliver', 'registrar salidas de entrega');
    else requirePermission('inventory_manage', 'modificar movimientos de almacén');
  }
  if (['supplierOrders', 'supplierOrderLines', 'imports'].some(changed)) requirePermission('supplier_order_manage', 'confirmar o modificar órdenes de compra');
  const auxiliaryChanged = ['requisitions', 'orderLines', 'inventoryReservations', 'auditLog'].some(changed);
  if (auxiliaryChanged && !(needsReceipt || needsDelivery || needsInvoice || needsCancellation || needsTracking)) requirePermission('supplier_order_manage', 'modificar el expediente operativo');
}

function can(user, state, permission) {
  const readPermissions = ['dashboard_view', 'inventory_view', 'catalog_view', 'supplier_view', 'quotation_view', 'client_view', 'client_order_view', 'supplier_order_view', ...OPERATIONAL_PERMISSIONS, 'reports'];
  const roles = { administrator: [...Object.values(STATE_PERMISSIONS), ...readPermissions, 'audit', 'client_order_activate'], developer: [...Object.values(STATE_PERMISSIONS), ...readPermissions, 'audit', 'client_order_activate', 'system_reset'], auditor: ['audit'], supervisor: [...Object.values(STATE_PERMISSIONS).filter(item => !['user_manage', 'system_config'].includes(item)), ...readPermissions, 'client_order_activate'], seller: ['dashboard_view', 'inventory_view', 'catalog_view', 'quotation_view', 'quotation_manage', 'client_view', 'client_manage', 'client_order_view', 'client_order_manage', 'client_order_activate', 'reports'] };
  const access = state?.['nexo-access-v1'] || {}, record = (access.users || []).find(item => item.id === user?.id) || {}, overrides = access.roleOverrides?.[user?.role] || {};
  const granted = new Set([...(roles[user?.role] || []), ...(overrides.grants || []), ...(record.permissionGrants || [])]);
  [...(overrides.denials || []), ...(record.permissionDenials || [])].forEach(item => granted.delete(item));
  // Son facultades reservadas: una edición de perfiles nunca puede elevar a
  // otro rol a administrar cuentas o ejecutar un restablecimiento total.
  const reservedRole = permission === 'system_reset' ? 'developer' : permission === 'user_manage' ? ['administrator', 'developer'] : null;
  if (permission === 'system_reset' && user?.role !== reservedRole) return false;
  if (permission === 'user_manage' && !reservedRole.includes(user?.role)) return false;
  return granted.has(permission);
}

function safeAccessState(access, user) {
  const users = Array.isArray(access?.users) ? access.users : [], own = users.find(item => String(item.id) === String(user?.id)) || user;
  const visible = user?.role === 'supervisor' ? users.filter(item => item.status === 'active' && (item.role === 'seller' || String(item.id) === String(user.id))) : own ? [own] : [];
  return { version: access?.version || 3, currentUserId: user?.id || null, users: visible.map(item => ({ id: item.id, name: item.name, email: item.email, role: item.role, status: item.status })), roleOverrides: {}, workspace: { sandboxEnabled: access?.workspace?.sandboxEnabled !== false, modes: {} }, audit: [] };
}

function stateForUser(sourceState, user) {
  const scoped = portfolioForUser(sourceState, user), result = {};
  for (const key of STATE_KEYS) if (canReadState(user, sourceState, key)) result[key] = scoped[key];
  for (const key of STATE_KEYS) if (!(key in result)) result[key] = Array.isArray(scoped[key]) ? [] : key === 'nexo-fx-v1' ? { records: [], audit: [] } : {};
  if (!can(user, sourceState, 'user_manage')) result['nexo-access-v1'] = safeAccessState(scoped['nexo-access-v1'], user);
  return result;
}

function enforceAccessStatePolicy(currentState, nextAccess, actor) {
  if (actor?.role === 'developer') return;
  const previous = new Map((currentState?.['nexo-access-v1']?.users || []).map(user => [String(user.id), user]));
  for (const candidate of nextAccess?.users || []) {
    const prior = previous.get(String(candidate?.id));
    if (candidate?.role === 'developer' && prior?.role !== 'developer') throw Object.assign(new Error('Solo Desarrollo puede crear o asignar el perfil de Desarrollo.'), { status: 403 });
    if (prior?.role === 'developer' && JSON.stringify(candidate) !== JSON.stringify(prior)) throw Object.assign(new Error('Solo Desarrollo puede modificar una cuenta de Desarrollo.'), { status: 403 });
    if (String(candidate?.id) === String(actor?.id) && candidate?.role !== actor.role) throw Object.assign(new Error('No puedes cambiar tu propio perfil de seguridad.'), { status: 403 });
  }
}

async function createApp(options = {}) {
  const db = options.db || await openDatabase({ connectionString: options.connectionString });
  const bootstrapToken = options.bootstrapToken || process.env.BIO_BOOTSTRAP_TOKEN || '';
  const resetApprovalToken = options.resetApprovalToken || process.env.BIO_SYSTEM_RESET_APPROVAL_TOKEN || '';
  const deltaBootstrapRoles = new Set(String(options.deltaBootstrapRoles ?? process.env.BIO_DELTA_BOOTSTRAP_ROLES ?? 'developer,administrator,supervisor,seller,auditor').split(',').map(value => value.trim()).filter(Boolean));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`), pathname = decodeURIComponent(url.pathname);
    try {
      if (request.method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'PROBIOLAB API', database: 'PostgreSQL', time: new Date().toISOString() });
      if (request.method === 'GET' && pathname === '/api/auth/me') {
        const user = await currentUser(db, request);
        // Consultar si existe una sesión es parte normal del arranque y del
        // cierre de sesión. No es un intento de acceso no autorizado, por lo
        // que se expresa como estado explícito y no como un 401 en monitoreo.
        return user
          ? sendJson(response, 200, { ok: true, authenticated: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
          : sendJson(response, 200, { ok: true, authenticated: false, setupReady: await setupReady(db) });
      }
      if (request.method === 'POST' && pathname === '/api/auth/login') {
        const passkeyRoute=url.searchParams.get('__passkey');
        if(passkeyRoute==='login-options') return sendJson(response,200,{ok:true,options:await authenticationOptions(db,request)});
        if(passkeyRoute==='login-verify') { const body=await readJson(request),user=await verifyAuthentication(db,request,body.response),result=await createSessionForUser(db,user); response.setHeader('Set-Cookie',sessionCookie(result.token)); return sendJson(response,200,{ok:true,user:result.user}); }
        const body = await readJson(request), result = await login(db, body.email, body.password, clientAddress(request));
        if (result?.blocked) {
          response.setHeader('Retry-After', String(result.retryAfter));
          return sendJson(response, 429, { ok: false, error: 'Demasiados intentos. Espera antes de volver a intentar.' });
        }
        if (!result) return sendJson(response, 401, { ok: false, error: 'Correo o contraseña incorrectos.' });
        response.setHeader('Set-Cookie', sessionCookie(result.token)); return sendJson(response, 200, { ok: true, user: result.user });
      }
      if (request.method === 'POST' && pathname === '/api/auth/passkey/login/options') return sendJson(response,200,{ok:true,options:await authenticationOptions(db,request)});
      if (request.method === 'POST' && pathname === '/api/auth/passkey/login/verify') { const body=await readJson(request),user=await verifyAuthentication(db,request,body.response),result=await createSessionForUser(db,user); response.setHeader('Set-Cookie',sessionCookie(result.token)); return sendJson(response,200,{ok:true,user:result.user}); }
      if (request.method === 'POST' && pathname === '/api/auth/setup') {
        if (!secureEqual(request.headers['x-bio-bootstrap-token'], bootstrapToken)) return sendJson(response, 403, { ok: false, error: 'La inicialización requiere una credencial de despliegue.' });
        const body = await readJson(request), result = await setupAdministrator(db, body.email, body.password);
        response.setHeader('Set-Cookie', sessionCookie(result.token)); return sendJson(response, 201, { ok: true, user: result.user });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        await clearSession(db, request); response.setHeader('Set-Cookie', 'bio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && pathname === '/api/fx/dof-usd') {
        const endpoint = dofUsdHistoryUrl();
        const dofResponse = await fetch(endpoint, { headers: { Accept: 'text/html', 'User-Agent': 'PROBIOLAB/1.0 exchange-rate-sync' } });
        if (!dofResponse.ok) { const error = new Error(`El Diario Oficial respondió ${dofResponse.status}.`); error.status = 502; throw error; }
        const value = parseDofUsdIndicator(await dofResponse.text());
        return sendJson(response, 200, { ok: true, ...value, ...dofPublicationMetadata(value.rateDate), source: 'Diario Oficial de la Federación', endpoint });
      }
      const authenticated = await currentUser(db, request), rawState = authenticated ? null : await readState(db), initialBootstrap = !authenticated && Object.keys(rawState).length === 0, bootstrapAuthorized = initialBootstrap && secureEqual(request.headers['x-bio-bootstrap-token'], bootstrapToken);
      if (request.method === 'GET' && pathname === '/api/auth/passkey/status') { if (!authenticated) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para consultar tu biometría.' }); return sendJson(response, 200, { ok: true, registered: await hasPasskey(db, authenticated.id) }); }
      if (request.method === 'POST' && pathname === '/api/auth/passkey/register/options') { if(!authenticated) return sendJson(response,401,{ok:false,error:'Inicia sesión para registrar tu biometría.'}); return sendJson(response,200,{ok:true,options:await registrationOptions(db,authenticated,request)}); }
      if (request.method === 'POST' && pathname === '/api/auth/passkey/register/verify') { if(!authenticated) return sendJson(response,401,{ok:false,error:'Inicia sesión para registrar tu biometría.'}); const body=await readJson(request); await verifyRegistration(db,authenticated,request,body.response); return sendJson(response,201,{ok:true}); }
      const passkeyRoute=url.searchParams.get('__passkey');
      if (request.method === 'POST' && passkeyRoute==='register-options') { if(!authenticated) return sendJson(response,401,{ok:false,error:'Inicia sesión para registrar tu biometría.'}); return sendJson(response,200,{ok:true,options:await registrationOptions(db,authenticated,request)}); }
      if (request.method === 'POST' && passkeyRoute==='register-verify') { if(!authenticated) return sendJson(response,401,{ok:false,error:'Inicia sesión para registrar tu biometría.'}); const body=await readJson(request); await verifyRegistration(db,authenticated,request,body.response); return sendJson(response,201,{ok:true}); }
      if (!authenticated && pathname.startsWith('/api/') && !bootstrapAuthorized) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para usar la API.' });
      if (!authenticated && bootstrapAuthorized && !['/api/bootstrap', '/api/import-local'].includes(pathname)) return sendJson(response, 401, { ok: false, error: 'La credencial de despliegue solo permite inicializar el sistema.' });
      // Estas rutas consultan o actualizan tablas materializadas de la operación.
      // En capacitación sólo se permite el estado particionado; bloquearlas aquí
      // evita una fuga incluso si se agrega una pantalla que las invoque.
      if (authenticated && requestedWorkspace(request) === 'training' && (/^\/api\/(?:search\/internal-orders|reports\/internal-orders|dashboard\/|alerts$|audit$|approvals|system\/reset|auth\/users\/)/.test(pathname) || ['products', 'suppliers', 'movements', 'quotations', 'client-orders', 'requisitions', 'supplier-orders', 'receipts', 'shipments', 'documents'].includes(pathname.slice('/api/'.length)))) return sendJson(response, 409, { ok: false, error: 'Esta consulta pertenece al espacio operativo. En Pruebas usa únicamente los datos de capacitación.' });
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        const workspace = requestedWorkspace(request);
        // Una revalidación no debe descargar el estado completo desde la base.
        // Se leen únicamente permisos y revisiones; si nada cambió devolvemos
        // 304 sin mover los JSON operativos hacia la función ni al navegador.
        const accessState = authenticated ? await readStateKeys(db, ['nexo-access-v1']) : rawState;
        const permissionState = authenticated ? { 'nexo-access-v1': accessState['nexo-access-v1'] || {} } : (rawState || {});
        const allowedKeys = authenticated ? STATE_KEYS.filter(key => (workspace !== 'training' || key !== 'nexo-access-v1') && canWriteState(authenticated, permissionState, key)) : initialBootstrap ? STATE_KEYS : [];
        const readableKeys = authenticated ? STATE_KEYS.filter(key => canReadState(authenticated, permissionState, key)) : STATE_KEYS;
        const effectiveReadableKeys = [...new Set([...readableKeys, 'nexo-access-v1'])];
        const revisionRows = await db.query(workspace === 'training' ? "SELECT state_key,revision,updated_at,updated_by FROM app_state WHERE state_key LIKE 'training:%' OR state_key='nexo-access-v1'" : "SELECT state_key,revision,updated_at,updated_by FROM app_state WHERE state_key NOT LIKE 'training:%'");
        const revisions = Object.fromEntries(revisionRows.rows.map(row => [workspace === 'training' ? row.state_key.replace(/^training:/, '') : row.state_key, row]));
        const etag = bootstrapEtag(authenticated, revisions, effectiveReadableKeys, allowedKeys);
        if (authenticated && acceptsEtag(request, etag)) return sendBootstrap(response, request, null, etag);
        const clientCache = authenticated && deltaBootstrapRoles.has(authenticated.role) ? bootstrapClientCache(request) : null;
        if (clientCache) {
          const newlyReadable = effectiveReadableKeys.filter(key => !clientCache.keys.includes(key));
          const changedKeys = effectiveReadableKeys.filter(key => Number(revisions[key]?.revision || 0) !== Number(clientCache.revisions[key] || 0) || newlyReadable.includes(key));
          const removedKeys = clientCache.keys.filter(key => !effectiveReadableKeys.includes(key));
          const stateKeys = [...new Set([...changedKeys, 'nexo-access-v1'])];
          const partialSource = workspace === 'training'
            ? { ...(await readStateKeys(db, stateKeys.filter(key => key !== 'nexo-access-v1'), 'training')), 'nexo-access-v1': accessState['nexo-access-v1'] || {} }
            : await readStateKeys(db, stateKeys);
          const scoped = stateForUser(partialSource, authenticated);
          const state = Object.fromEntries(changedKeys.map(key => [key, scoped[key]]));
          return sendBootstrap(response, request, { ok: true, empty: false, partial: true, state, removedKeys, revisions, readableKeys: effectiveReadableKeys, allowedKeys }, etag);
        }
        // En Pruebas sólo se necesita el acceso operativo; leer además todo el
        // estado real sumaba otra descarga completa sin aportar datos al área
        // aislada.
        const operationalState = rawState || (workspace === 'training' ? { 'nexo-access-v1': accessState['nexo-access-v1'] || {} } : await readState(db)), trainingState = workspace === 'training' ? { ...emptyTrainingState(), ...(await readState(db, 'training')) } : null, sourceState = workspace === 'training' ? { ...trainingState, 'nexo-access-v1': operationalState['nexo-access-v1'] } : operationalState, state = authenticated ? stateForUser(sourceState, authenticated) : sourceState;
        return sendBootstrap(response, request, { ok: true, empty: Object.keys(state).length === 0, partial: false, state, revisions, readableKeys: effectiveReadableKeys, allowedKeys }, etag);
      }
      if (request.method === 'PUT' && pathname === '/api/state-batch') {
        if (!authenticated) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para guardar cambios.' });
        const workspace = requestedWorkspace(request), body = await readJson(request), entries = Object.entries(body.state || {});
        if (!entries.length || entries.length > STATE_KEYS.length || entries.some(([key]) => !STATE_KEYS.includes(key))) return sendJson(response, 400, { ok: false, error: 'El lote de cambios no es válido.' });
        const operationalState = await readState(db), currentState = workspace === 'training' ? { ...emptyTrainingState(), ...(await readState(db, 'training')), 'nexo-access-v1': operationalState['nexo-access-v1'] } : operationalState, prepared = [];
        for (const [stateKey, candidate] of entries) {
          const permission = STATE_PERMISSIONS[stateKey];
          if (!permission || (workspace === 'training' && stateKey === 'nexo-access-v1') || !canWriteState(authenticated, operationalState, stateKey)) return sendJson(response, 403, { ok: false, error: `Tu perfil no tiene permiso para modificar ${stateKey}.` });
          if (stateKey === 'nexo-order-operations-v1') assertOperationalWriteAllowed(currentState[stateKey], candidate, authenticated, operationalState);
          if (stateKey === 'nexo-access-v1') enforceAccessStatePolicy(currentState, candidate, authenticated);
          const payload = authenticated.role === 'seller' && SELLER_WRITE_OWNED_KEYS.has(stateKey) ? mergeSellerPortfolio(currentState[stateKey], candidate, authenticated, stateKey) : candidate;
          if (stateKey === 'nexo-sales-quotations') enforceRequiredQuotationLock(currentState, payload);
          if (stateKey === 'nexo-commercial-orders') enforceActivatedOrderLock(currentState, payload);
          prepared.push([stateKey, payload]);
        }
        const revisions = await saveStates(db, prepared, authenticated.name, authenticated.id, workspace);
        if (revisions['nexo-access-v1']) for (const user of prepared.find(([key]) => key === 'nexo-access-v1')?.[1]?.users || []) if (user.status !== 'active') await clearUserSessions(db, user.id);
        return sendJson(response, 200, { ok: true, revisions });
      }
      if (request.method === 'PUT' && pathname.startsWith('/api/state/')) {
        if (!authenticated) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para guardar cambios.' });
        const workspace = requestedWorkspace(request), stateKey = pathname.slice('/api/state/'.length), operationalState = await readState(db), currentState = workspace === 'training' ? { ...emptyTrainingState(), ...(await readState(db, 'training')), 'nexo-access-v1': operationalState['nexo-access-v1'] } : operationalState, permission = STATE_PERMISSIONS[stateKey];
        if (!permission || (workspace === 'training' && stateKey === 'nexo-access-v1') || !canWriteState(authenticated, operationalState, stateKey)) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para modificar esta información.' });
        const body = await readJson(request);
        if (stateKey === 'nexo-order-operations-v1') assertOperationalWriteAllowed(currentState[stateKey], body.payload, authenticated, operationalState);
        if (stateKey === 'nexo-access-v1') enforceAccessStatePolicy(currentState, body.payload, authenticated);
        const payload = authenticated.role === 'seller' && SELLER_WRITE_OWNED_KEYS.has(stateKey) ? mergeSellerPortfolio(currentState[stateKey], body.payload, authenticated, stateKey) : body.payload;
        if (stateKey === 'nexo-sales-quotations') enforceRequiredQuotationLock(currentState, payload);
        if (stateKey === 'nexo-commercial-orders') enforceActivatedOrderLock(currentState, payload);
        const revision = await saveState(db, stateKey, payload, authenticated.name, authenticated.id, workspace);
        if (stateKey === 'nexo-access-v1') for (const user of payload.users || []) if (user.status !== 'active') await clearUserSessions(db, user.id);
        return sendJson(response, 200, { ok: true, revision });
      }
      if (request.method === 'POST' && pathname.startsWith('/api/auth/users/') && pathname.endsWith('/password')) {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'user_manage')) return sendJson(response, 403, { ok: false, error: 'Solo un administrador puede asignar contraseñas.' });
        const userId = pathname.slice('/api/auth/users/'.length, -'/password'.length), target = (currentState['nexo-access-v1']?.users || []).find(user => String(user.id) === String(userId));
        if (target?.role === 'developer' && authenticated.role !== 'developer') return sendJson(response, 403, { ok: false, error: 'Solo Desarrollo puede restablecer una cuenta de Desarrollo.' });
        const body = await readJson(request); await setPassword(db, userId, body.password); return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'DELETE' && /^\/api\/auth\/users\/[^/]+$/.test(pathname)) {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'user_manage')) return sendJson(response, 403, { ok: false, error: 'Solo un administrador puede eliminar usuarios.' });
        const userId = pathname.slice('/api/auth/users/'.length), body = await readJson(request), reason = String(body.reason || '').trim(), access = currentState['nexo-access-v1'] || {}, users = Array.isArray(access.users) ? access.users : [], target = users.find(user => user.id === userId);
        if (!reason) return sendJson(response, 400, { ok: false, error: 'La justificación de la eliminación es obligatoria.' });
        if (!target) return sendJson(response, 404, { ok: false, error: 'El usuario no existe.' });
        if (target.id === authenticated.id) return sendJson(response, 400, { ok: false, error: 'No puedes eliminar el usuario con la sesión actual.' });
        if (target.role === 'developer' && authenticated.role !== 'developer') return sendJson(response, 403, { ok: false, error: 'Solo Desarrollo puede eliminar una cuenta de Desarrollo.' });
        const activeAdmins = users.filter(user => user.status === 'active' && user.role === 'administrator');
        if (target.role === 'administrator' && target.status === 'active' && activeAdmins.length === 1) return sendJson(response, 400, { ok: false, error: 'Debe permanecer al menos un administrador activo.' });
        const nextAccess = { ...access, users: users.filter(user => user.id !== userId), audit: [...(access.audit || []), { id: `ACL-${Date.now()}`, type: 'user_deleted', entityId: userId, actorId: authenticated.id, at: new Date().toISOString(), before: target, reason }] };
        await saveState(db, 'nexo-access-v1', nextAccess, authenticated.name);
        await db.query('DELETE FROM users WHERE id=$1', [userId]);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/import-local') {
        if (!initialBootstrap || !bootstrapAuthorized) return sendJson(response, 403, { ok: false, error: 'La importación inicial requiere una base vacía y una credencial de despliegue.' });
        const body = await readJson(request), result = await importSnapshot(db, body.state || {}, authenticated?.name || 'Migración inicial local');
        return sendJson(response, 201, { ok: true, ...result });
      }
      if (request.method === 'POST' && pathname === '/api/system/reset') {
        const currentState = await readState(db);
        if (!can(authenticated, currentState, 'system_reset')) return sendJson(response, 403, { ok: false, error: 'Solo el perfil de Desarrollo puede restablecer datos operativos.' });
        const body = await readJson(request);
        if (body.mode === 'generate-approval') { const token=crypto.randomBytes(18).toString('base64url'), hash=crypto.createHash('sha256').update(token).digest('hex'), id=`RESET-${Date.now()}`; await db.query('INSERT INTO approval_requests(id,action_type,entity_type,justification,payload_json,status,requested_by_id,requested_by_name,requested_at,reviewed_by_id,reviewed_by_name,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,$7,$8,CURRENT_TIMESTAMP)',[id,'system_reset','system','Aprobación de emergencia generada por Desarrollo.',JSON.stringify({hash,expiresAt:new Date(Date.now()+15*60*1000).toISOString()}),'approved',authenticated.id,authenticated.name]); return sendJson(response,201,{ok:true,token,expiresAt:new Date(Date.now()+15*60*1000).toISOString()}); }
        if (body.confirmation !== 'RESTABLECER SISTEMA') return sendJson(response, 400, { ok: false, error: 'Confirma la acción con RESTABLECER SISTEMA.' });
        if (!await verifyUserPassword(db, authenticated.id, body.password)) return sendJson(response, 401, { ok: false, error: 'Confirma tu contraseña actual para restablecer el sistema.' });
        const hash=crypto.createHash('sha256').update(String(body.approvalToken||'')).digest('hex'), approvals=await db.query("SELECT id FROM approval_requests WHERE action_type='system_reset' AND status='approved' AND payload_json->>'hash'=$1 AND (payload_json->>'expiresAt')::timestamptz>CURRENT_TIMESTAMP ORDER BY requested_at DESC LIMIT 1",[hash]);
        if (!secureEqual(body.approvalToken, resetApprovalToken) && !approvals.rows[0]) return sendJson(response, 403, { ok: false, error: 'La aprobación de emergencia es obligatoria o expiró.' });
        if(approvals.rows[0]) await db.query("UPDATE approval_requests SET status='cancelled',applied_at=CURRENT_TIMESTAMP WHERE id=$1",[approvals.rows[0].id]);
        const result = await resetOperationalData(db, authenticated, body.reason);
        return sendJson(response, 200, { ok: true, ...result, message: 'Los datos operativos fueron restablecidos. La evidencia de auditoría se conserva.' });
      }
      if (request.method === 'GET' && pathname === '/api/system/egress-diagnostics') {
        if (!['administrator', 'developer'].includes(authenticated?.role)) return sendJson(response, 403, { ok: false, error: 'Solo administración puede consultar el diagnóstico de transferencia.' });
        return sendJson(response, 200, { ok: true, data: await stateEgressDiagnostics(db) });
      }
      if (request.method === 'POST' && pathname === '/api/quotation-conversion/validate') {
        const body = await readJson(request), assessment = assessQuotationConversion(body.quotation, { canConvert: body.canConvert !== false, now: body.now ? new Date(body.now) : new Date() });
        return sendJson(response, assessment.ok ? 200 : 422, { ok: assessment.ok, assessment });
      }
      if (request.method === 'GET' && pathname === '/api/audit') {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'audit')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para consultar auditoría.' });
        return sendJson(response, 200, { ok: true, data: await listAudit(db, url.searchParams.get('limit')) });
      }
      if (request.method === 'GET' && pathname === '/api/dashboard/executive') {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'reports')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para consultar el tablero.' });
        return sendJson(response, 200, { ok: true, data: await executiveDashboard(db, authenticated, url.searchParams.get('period') || 'today') });
      }
      if (request.method === 'GET' && pathname === '/api/alerts') {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'dashboard_view')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para consultar alertas.' });
        return sendJson(response, 200, { ok: true, data: await operationalAlerts(db, authenticated) });
      }
      if (request.method === 'GET' && pathname === '/api/approvals') {
        const currentState = await readState(db), isReviewer = ['administrator', 'supervisor'].includes(authenticated?.role);
        if (!authenticated) return sendJson(response, 401, { ok: false, error: 'Inicia sesión para consultar aprobaciones.' });
        const data = await listApprovals(db, isReviewer ? { status: url.searchParams.get('status') || '' } : { requestedById: authenticated.id, status: url.searchParams.get('status') || '' });
        return sendJson(response, 200, { ok: true, data });
      }
      if (request.method === 'POST' && pathname === '/api/approvals') {
        const currentState = await readState(db), body = await readJson(request);
        const permissions = { high_discount: 'quotation_manage', sale_price_change: 'system_config', cancellation: 'client_order_manage', client_transfer: 'client_manage', warehouse_exit: 'inventory_manage' }, needed = permissions[body.actionType];
        if (!needed || !can(authenticated, currentState, needed)) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para solicitar esta aprobación.' });
        return sendJson(response, 201, { ok: true, data: await createApproval(db, { ...body, actor: authenticated }) });
      }
      if (request.method === 'POST' && /^\/api\/approvals\/[^/]+\/decision$/.test(pathname)) {
        if (!['administrator', 'supervisor'].includes(authenticated?.role)) return sendJson(response, 403, { ok: false, error: 'Solo administrador o supervisor pueden decidir aprobaciones.' });
        const id = pathname.slice('/api/approvals/'.length, -'/decision'.length), body = await readJson(request);
        return sendJson(response, 200, { ok: true, data: await decideApproval(db, id, body, authenticated) });
      }
      if (request.method === 'GET' && /^\/api\/internal-orders\/clients\/[^/]+\/quotations$/.test(pathname)) {
        const currentState = await readState(db), workspace = requestedWorkspace(request);
        if (!can(authenticated, currentState, 'client_order_manage') || !can(authenticated, currentState, 'quotation_view')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para preparar pedidos internos.' });
        const clientId = pathname.slice('/api/internal-orders/clients/'.length, -'/quotations'.length);
        return sendJson(response, 200, { ok: true, data: await listClientQuotations(db, clientId, authenticated, workspace) });
      }
      if (request.method === 'POST' && pathname === '/api/internal-orders') {
        const currentState = await readState(db), workspace = requestedWorkspace(request);
        if (!can(authenticated, currentState, 'client_order_manage')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para crear pedidos internos.' });
        return sendJson(response, 201, { ok: true, data: await createInternalOrder(db, await readJson(request), authenticated, workspace) });
      }
      if (request.method === 'PUT' && /^\/api\/internal-orders\/[^/]+$/.test(pathname)) {
        const currentState = await readState(db), workspace = requestedWorkspace(request);
        if (!can(authenticated, currentState, 'client_order_manage')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para editar pedidos internos.' });
        const id = pathname.slice('/api/internal-orders/'.length);
        return sendJson(response, 200, { ok: true, data: await updateInternalOrder(db, id, await readJson(request), authenticated, workspace) });
      }
      if (request.method === 'POST' && /^\/api\/internal-orders\/[^/]+\/activate$/.test(pathname)) {
        const currentState = await readState(db), workspace = requestedWorkspace(request);
        if (!can(authenticated, currentState, 'client_order_activate')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para activar pedidos internos.' });
        const id = pathname.slice('/api/internal-orders/'.length, -'/activate'.length);
        return sendJson(response, 200, { ok: true, data: await activateInternalOrder(db, id, await readJson(request), authenticated, workspace) });
      }
      if (request.method === 'GET' && pathname === '/api/search/internal-orders') {
        const currentState = await readState(db);
        if (!can(authenticated, currentState, 'client_view') || !can(authenticated, currentState, 'catalog_view')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para buscar pedidos internos.' });
        const data = await searchInternalOrderTargets(db, authenticated, url.searchParams.get('q'), url.searchParams.get('limit'));
        return sendJson(response, 200, { ok: true, data });
      }
      if (request.method === 'GET' && pathname === '/api/reports/internal-orders') {
        const currentState = await readState(db); if (!can(authenticated, currentState, 'reports')) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para consultar reportes.' });
        const filters = Object.fromEntries(['from', 'to', 'month', 'year', 'client', 'product', 'order', 'supplierOrder', 'seller', 'status', 'deliveryStatus', 'query'].map(key => [key, url.searchParams.get(key) || '']));
        const report = buildInternalOrdersReport(currentState, authenticated, filters);
        if (url.searchParams.get('export') === 'all') return sendJson(response, 200, { ok: true, ...report, pagination: { page: 1, pageSize: report.records.length, total: report.records.length, pages: 1 } });
        return sendJson(response, 200, { ok: true, ...paginateReport(report, url.searchParams.get('page'), url.searchParams.get('pageSize')) });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/')) {
        const resource = pathname.slice('/api/'.length), resourcePermissions = { products: 'catalog_view', suppliers: 'supplier_view', movements: 'inventory_manage', quotations: 'quotation_view', 'client-orders': 'client_order_view', requisitions: 'supplier_order_view', 'supplier-orders': 'supplier_order_view', receipts: 'receive', shipments: 'deliver', documents: 'audit' }, permission = resourcePermissions[resource], currentState = await readState(db);
        if (!permission || !can(authenticated, currentState, permission)) return sendJson(response, 403, { ok: false, error: 'Tu perfil no tiene permiso para consultar este recurso.' });
        const data = await listResource(db, resource), safeData = authenticated?.role === 'seller' && ['products', 'quotations', 'client-orders'].includes(resource) ? data.map(withoutListPrice) : data;
        if (safeData) return sendJson(response, 200, { ok: true, data: safeData, count: safeData.length });
        return sendJson(response, 404, { ok: false, error: 'Recurso no encontrado.' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { ok: false, error: 'Método no permitido.' });
      if ((pathname === '/' || pathname === '/index.html') && !authenticated) {
        response.writeHead(302, { ...SECURITY_HEADERS, Location: '/login.html', 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (pathname === '/login.html' && authenticated) {
        response.writeHead(302, { ...SECURITY_HEADERS, Location: '/', 'Cache-Control': 'no-store' });
        return response.end();
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''), file = path.resolve(ROOT, relative);
      if (!isPublicFile(relative) || !file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(response, 404, { ok: false, error: 'Archivo no encontrado.' });
      const staticAsset = /\.(?:js|css|png|jpe?g|svg|ico|webmanifest|pdf|xlsx|mjs)$/i.test(relative);
      // Los documentos HTML y las respuestas de sesión nunca se almacenan.
      // Los recursos versionados sí pueden reutilizarse entre pantallas y
      // visitas, reduciendo notablemente las cargas repetidas.
      const cacheControl = staticAsset ? 'public, max-age=3600, stale-while-revalidate=86400' : (options.noCache === false ? 'public, max-age=300' : 'no-store');
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cacheControl });
      if (request.method === 'HEAD') return response.end(); fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (pathname.startsWith('/api/auth/passkey/')) console.error('Passkey error', { path: pathname, message: error.message, stack: error.stack });
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

module.exports = { createApp, parseDofUsdIndicator, dofUsdHistoryUrl, dofPublicationMetadata, enforceActivatedOrderLock, enforceRequiredQuotationLock, assertDocumentHistoryStable };
