'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { isExpired: quotationIsExpired } = require('../quotation-conversion');

const STATE_KEYS = Object.freeze([
  'nexo-access-v1', 'nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders',
  'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-order-operations-v1', 'nexo-fx-v1', 'nexo-quotation-terms-v1'
]);
const ROOT = path.resolve(__dirname, '..');
const number = input => Number.isFinite(Number(input)) ? Number(input) : 0;
const value = (item, ...keys) => keys.map(key => item?.[key]).find(candidate => candidate !== undefined && candidate !== null && candidate !== '') ?? null;
const timestamp = () => new Date().toISOString();
const searchKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const parseJson = input => typeof input === 'string' ? JSON.parse(input) : input;
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const approvalTypes = new Set(['high_discount', 'sale_price_change', 'cancellation', 'client_transfer', 'warehouse_exit']);
const ARRAY_STATE_KEYS = new Set(['nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders', 'nexo-sales-quotations', 'nexo-commercial-orders']);
const OBJECT_STATE_KEYS = new Set(['nexo-access-v1', 'nexo-quotation-sequences', 'nexo-order-operations-v1', 'nexo-fx-v1', 'nexo-quotation-terms-v1']);
const USER_ROLES = new Set(['administrator', 'developer', 'auditor', 'supervisor', 'seller']);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function invalidState(message) { throw Object.assign(new Error(message), { status: 400 }); }
function validateStatePayload(stateKey, payload) {
  if (ARRAY_STATE_KEYS.has(stateKey)) {
    if (!Array.isArray(payload)) invalidState(`El estado ${stateKey} debe ser una lista.`);
    if (payload.length > 20000 || payload.some(item => !isObject(item))) invalidState(`El estado ${stateKey} contiene registros inválidos o excede el límite.`);
  }
  if (OBJECT_STATE_KEYS.has(stateKey) && !isObject(payload)) invalidState(`El estado ${stateKey} debe ser un objeto.`);
  if (stateKey === 'nexo-access-v1') {
    if (!Array.isArray(payload.users) || payload.users.length > 1000) invalidState('La configuración de usuarios no es válida.');
    for (const user of payload.users) {
      if (!isObject(user) || !String(user.id || '').trim() || !String(user.name || '').trim() || !String(user.email || '').trim() || !USER_ROLES.has(user.role) || !['active', 'inactive'].includes(user.status)) invalidState('La configuración de usuarios contiene un perfil inválido.');
      if ('password' in user || 'passwordHash' in user || 'password_hash' in user) invalidState('Las contraseñas no se almacenan dentro del estado operativo.');
    }
  }
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > 10 * 1024 * 1024) invalidState('El estado excede el tamaño máximo permitido.');
}
function validateFxState(payload) {
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('El estado de divisas no es válido.'), { status: 400 });
  const records = Array.isArray(payload.records) ? payload.records : [], dates = new Set();
  for (const record of records) {
    const date = String(record.operationalDate || record.consultedDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dates.has(date)) throw Object.assign(new Error('Solo puede existir un registro de divisas por fecha operativa.'), { status: 400 });
    dates.add(date);
    if (record.validated !== false && !['USD', 'CAD', 'EUR'].every(code => Number.isFinite(Number(record.rates?.[code])) && Number(record.rates[code]) > 0)) throw Object.assign(new Error('Un registro validado requiere valores positivos para USD, CAD y EUR.'), { status: 400 });
  }
}
// La columna materializada de moneda debe reflejar los importes estructurados,
// no una etiqueta heredada que pudo quedar desactualizada en el documento.
function documentCurrency(item) {
  const totals = Array.isArray(item?.totalsByCurrency) ? item.totalsByCurrency : [];
  const fromTotals = totals.map(entry => entry?.currency).filter(Boolean);
  const fromItems = (item?.items || []).map(line => line?.currency || line?.sourceCurrency).filter(Boolean);
  const currencies = [...new Set((fromTotals.length ? fromTotals : fromItems).map(code => String(code).trim().toUpperCase()))];
  return currencies.length > 1 ? 'MULTI' : (currencies[0] || String(value(item, 'currency') || 'MXN').toUpperCase());
}

async function openDatabase(options = {}) {
  const connectionString = options.connectionString || process.env.DATABASE_URL || process.env.BIO_DATABASE_URL;
  if (!options.pool && !connectionString) throw new Error('Falta DATABASE_URL. Configura la conexión PostgreSQL antes de iniciar PROBIOLAB.');
  // Supabase exige TLS para sus conexiones remotas. La detección conserva la
  // experiencia local sin TLS y evita depender de una variable adicional en Vercel.
  const supabaseConnection = /(?:^|\.)supabase\.co(?::|\/|$)/i.test(connectionString);
  const ssl = process.env.PGSSL === 'require' || supabaseConnection
    ? { rejectUnauthorized: false }
    : undefined;
  const pool = options.pool || new Pool({ connectionString, max: Number(process.env.BIO_DB_POOL_SIZE || 10), ssl });
  // En Vercel varias funciones pueden arrancar al mismo tiempo. El bloqueo
  // asesor serializa la única ruta que puede ejecutar DDL. Antes se ejecutaba
  // schema.sql en cada arranque, aun con el esquema listo; esas sentencias
  // concurrentes eran la causa de los deadlocks en las consultas de pedidos.
  const migrationDb = typeof pool.connect === 'function' ? await pool.connect() : pool;
  let migrationLock = false;
  try {
    try {
      const lock = await migrationDb.query('SELECT pg_try_advisory_lock($1) AS locked', [90226001]);
      migrationLock = lock.rows[0]?.locked === true;
    } catch (error) {
      // pg-mem no implementa advisory locks; las pruebas usan una sola conexión.
      if (!/pg-mem|advisory_lock|does not exist|not supported/i.test(error?.message || '')) throw error;
    }
    let schemaExists = true;
    try { await migrationDb.query('SELECT 1 FROM schema_migrations LIMIT 1'); }
    catch (error) {
      if (error?.code === '42P01' || /schema_migrations.*does not exist|relation.*does not exist/i.test(error?.message || '')) schemaExists = false;
      else throw error;
    }
    // Si otra función conserva el bloqueo pero el esquema ya existe, ésta es
    // una consulta normal: no debe esperar ni intentar DDL. En una base nueva
    // el primer arranque mantiene el bloqueo y termina la inicialización.
    if (!migrationLock && schemaExists) { await backfillRequiredQuotationLocks(pool); return pool; }
    if (!migrationLock && !schemaExists && !options.pool) throw Object.assign(new Error('La base de datos se está inicializando; intenta de nuevo en unos segundos.'), { status: 503 });
    if (!schemaExists) await migrationDb.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const migration = await migrationDb.query('SELECT 1 FROM schema_migrations WHERE version=3');
    if (!migration.rows.length) {
      await rebuildMaterialized(migrationDb);
      await migrateRelationalModel(migrationDb);
      await migrationDb.query('INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT (version) DO NOTHING');
    }
    const transitionMigration = await migrationDb.query('SELECT 1 FROM schema_migrations WHERE version=4');
    if (!transitionMigration.rows.length) {
      // El esquema ya contiene las tablas; esta migración marca el inicio del
      // diario relacional sin reescribir ni perder el historial operativo.
      await enforceAppendOnlyLedger(migrationDb);
      await migrationDb.query('INSERT INTO schema_migrations(version) VALUES (4) ON CONFLICT (version) DO NOTHING');
    }
    const dashboardHistoryMigration = await migrationDb.query('SELECT 1 FROM schema_migrations WHERE version=5');
    if (!dashboardHistoryMigration.rows.length) {
      await migrationDb.query("CREATE TABLE IF NOT EXISTS dashboard_monthly_snapshots (period_key TEXT PRIMARY KEY, orders_count INTEGER NOT NULL DEFAULT 0, order_totals JSONB NOT NULL DEFAULT '[]'::jsonb, quotations_count INTEGER NOT NULL DEFAULT 0, quotation_totals JSONB NOT NULL DEFAULT '[]'::jsonb, captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      await migrationDb.query('INSERT INTO schema_migrations(version) VALUES (5) ON CONFLICT (version) DO NOTHING');
    }
    const additiveColumnsMigration = await migrationDb.query('SELECT 1 FROM schema_migrations WHERE version=6');
    if (!additiveColumnsMigration.rows.length) {
      // Las bases creadas antes de la numeración de vendedores ya tenían el
      // esquema principal y por eso no volvían a ejecutar schema.sql. Mantener
      // aquí las adiciones idempotentes permite actualizar producción sin
      // reconstruir ni eliminar información existente.
      const statements = [
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_number TEXT',
        'ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP',
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS search_key TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN IF NOT EXISTS search_key TEXT NOT NULL DEFAULT ''",
        'ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_seller_number TEXT',
        'ALTER TABLE quotations ADD COLUMN IF NOT EXISTS client_id TEXT',
        'ALTER TABLE quotations ADD COLUMN IF NOT EXISTS owner_id TEXT',
        'ALTER TABLE quotations ADD COLUMN IF NOT EXISTS owner_name TEXT',
        'ALTER TABLE quotations ADD COLUMN IF NOT EXISTS owner_seller_number TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS client_id TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS owner_id TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS owner_name TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS owner_seller_number TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS seller TEXT',
        'ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS created_by TEXT',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_seller_number_unique ON users(seller_number) WHERE seller_number IS NOT NULL'
      ];
      for (const statement of statements) await migrationDb.query(statement);
      await migrationDb.query('INSERT INTO schema_migrations(version) VALUES (6) ON CONFLICT (version) DO NOTHING');
    }
  } finally {
    if (migrationLock) await migrationDb.query('SELECT pg_advisory_unlock($1)', [90226001]);
    migrationDb.release?.();
  }
  await backfillRequiredQuotationLocks(pool);
  return pool;
}

async function enforceAppendOnlyLedger(db) {
  // PostgreSQL impide cambios o borrados incluso si una futura ruta de la API
  // los intentara. pg-mem no implementa PL/pgSQL; allí la cadena hash sigue
  // cubierta por las pruebas de integración.
  try {
    await db.query("CREATE OR REPLACE FUNCTION bio_prevent_ledger_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'El diario de auditoría es inmutable'; END; $$ LANGUAGE plpgsql");
    for (const table of ['audit_ledger', 'state_commits']) {
      await db.query(`DROP TRIGGER IF EXISTS bio_${table}_immutable ON ${table}`);
      await db.query(`CREATE TRIGGER bio_${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION bio_prevent_ledger_mutation()`);
    }
  } catch (error) {
    if (!/pg-mem|plpgsql|language.*not supported/i.test(error?.message || '')) throw error;
  }
}

async function migrateRelationalModel(db) {
  const constraints = [
    ['fk_client_orders_client', 'ALTER TABLE client_orders ADD CONSTRAINT fk_client_orders_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL'],
    ['fk_client_orders_quotation', 'ALTER TABLE client_orders ADD CONSTRAINT fk_client_orders_quotation FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL'],
    ['fk_requisitions_client_order', 'ALTER TABLE requisitions ADD CONSTRAINT fk_requisitions_client_order FOREIGN KEY (client_order_id) REFERENCES client_orders(id) ON DELETE SET NULL'],
    ['fk_order_lines_requisition', 'ALTER TABLE order_lines ADD CONSTRAINT fk_order_lines_requisition FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE CASCADE'],
    ['fk_order_lines_product', 'ALTER TABLE order_lines ADD CONSTRAINT fk_order_lines_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL'],
    ['fk_quotation_items_product', 'ALTER TABLE quotation_items ADD CONSTRAINT fk_quotation_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL'],
    ['fk_client_order_items_product', 'ALTER TABLE client_order_items ADD CONSTRAINT fk_client_order_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL'],
    ['fk_supplier_orders_client_order', 'ALTER TABLE supplier_orders ADD CONSTRAINT fk_supplier_orders_client_order FOREIGN KEY (client_order_id) REFERENCES client_orders(id) ON DELETE SET NULL'],
    ['fk_supplier_orders_quotation', 'ALTER TABLE supplier_orders ADD CONSTRAINT fk_supplier_orders_quotation FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL'],
    ['fk_supplier_orders_supplier', 'ALTER TABLE supplier_orders ADD CONSTRAINT fk_supplier_orders_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL'],
    ['fk_supplier_lines_supplier_order', 'ALTER TABLE supplier_order_lines ADD CONSTRAINT fk_supplier_lines_supplier_order FOREIGN KEY (supplier_order_id) REFERENCES supplier_orders(id) ON DELETE CASCADE'],
    ['fk_supplier_lines_order_line', 'ALTER TABLE supplier_order_lines ADD CONSTRAINT fk_supplier_lines_order_line FOREIGN KEY (order_line_id) REFERENCES order_lines(id) ON DELETE SET NULL'],
    ['fk_shipments_requisition', 'ALTER TABLE shipments ADD CONSTRAINT fk_shipments_requisition FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE SET NULL'],
    ['fk_receipts_requisition', 'ALTER TABLE receipts ADD CONSTRAINT fk_receipts_requisition FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE SET NULL'],
    ['fk_receipts_supplier_order', 'ALTER TABLE receipts ADD CONSTRAINT fk_receipts_supplier_order FOREIGN KEY (supplier_order_id) REFERENCES supplier_orders(id) ON DELETE SET NULL'],
    ['fk_customer_invoices_requisition', 'ALTER TABLE customer_invoices ADD CONSTRAINT fk_customer_invoices_requisition FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE SET NULL']
  ];
  for (const [, statement] of constraints) {
    try { await db.query(statement); }
    catch (error) { if (!/already exists|duplicate|exists/i.test(error.message || '')) throw error; }
  }
}

const workspaceStateKey = (workspace, stateKey) => workspace === 'training' && stateKey !== 'nexo-access-v1' ? `training:${stateKey}` : stateKey;

async function readState(db, workspace = 'operational') {
  const prefix = workspace === 'training' ? 'training:' : '';
  const query = workspace === 'training'
    ? "SELECT state_key, payload_json FROM app_state WHERE state_key LIKE 'training:%'"
    : "SELECT state_key, payload_json FROM app_state WHERE state_key NOT LIKE 'training:%'";
  const { rows } = await db.query(query);
  return Object.fromEntries(rows.map(row => [prefix && row.state_key.startsWith(prefix) ? row.state_key.slice(prefix.length) : row.state_key, parseJson(row.payload_json)]));
}

// Lectura dirigida para comprobaciones de permisos y revalidaciones. Evita
// transferir todos los JSON operativos cuando sólo se necesita, por ejemplo,
// la configuración de acceso antes de responder un 304.
async function readStateKeys(db, stateKeys, workspace = 'operational') {
  const keys = [...new Set((stateKeys || []).filter(key => STATE_KEYS.includes(key)))];
  if (!keys.length) return {};
  const storageKeys = keys.map(key => workspaceStateKey(workspace, key));
  const placeholders = storageKeys.map((_, index) => `$${index + 1}`).join(',');
  const { rows } = await db.query(`SELECT state_key,payload_json FROM app_state WHERE state_key IN (${placeholders})`, storageKeys);
  const prefix = workspace === 'training' ? 'training:' : '';
  return Object.fromEntries(rows.map(row => [prefix && row.state_key.startsWith(prefix) ? row.state_key.slice(prefix.length) : row.state_key, parseJson(row.payload_json)]));
}

// PostgreSQL calcula los tamaños sin devolver los JSON completos. La propia
// medición no debe convertirse en otra descarga costosa desde Supabase.
async function stateEgressDiagnostics(db) {
  const { rows } = await db.query(`
    SELECT state_key, revision, updated_at, updated_by,
           OCTET_LENGTH(CAST(payload_json AS TEXT)) AS payload_bytes
      FROM app_state
     ORDER BY payload_bytes DESC, state_key ASC
  `);
  const summarize = training => {
    const selected = rows.filter(row => String(row.state_key).startsWith('training:') === training);
    const blocks = selected.map(row => ({
      key: training ? String(row.state_key).replace(/^training:/, '') : row.state_key,
      bytes: Number(row.payload_bytes || 0), revision: Number(row.revision || 0),
      updatedAt: row.updated_at || null, updatedBy: row.updated_by || null
    }));
    return { bytes: blocks.reduce((total, block) => total + block.bytes, 0), blocks };
  };
  return { generatedAt: timestamp(), operational: summarize(false), training: summarize(true) };
}

// Corrige pedidos creados antes de que la transición "requerida" existiera.
// Una vez que el pedido ya está activo, sus cotizaciones deben permanecer
// congeladas aunque el flujo haya avanzado hasta compra, recepción o remisión.
async function backfillRequiredQuotationLocks(db) {
  const state = await readState(db), orders = Array.isArray(state['nexo-commercial-orders']) ? state['nexo-commercial-orders'] : [], quotations = Array.isArray(state['nexo-sales-quotations']) ? state['nexo-sales-quotations'] : [];
  const progressed = orders.filter(order => ['active', 'confirmed', 'purchasing', 'partially_purchased', 'purchased', 'partially_received', 'received', 'delivered', 'completed'].includes(String(order?.status || '').toLowerCase()));
  const origins = new Map();
  for (const order of progressed) for (const quotationId of [...new Set((order.quotationIds || [order.quotationId]).filter(Boolean).map(String))]) origins.set(quotationId, order);
  if (!origins.size) return false;
  const at = timestamp(), next = quotations.map(quotation => {
    const order = origins.get(String(quotation.id));
    if (!order || (quotation.locked && String(quotation.status || '').toLowerCase() === 'required')) return quotation;
    const reason = `Conciliación: pedido interno ${order.id} ya avanzado a compras.`;
    return { ...quotation, status: 'required', locked: true, lockedAtISO: quotation.lockedAtISO || at, lockedBy: quotation.lockedBy || 'Sistema', lockedReason: quotation.lockedReason || reason, requiredAtISO: quotation.requiredAtISO || at, requiredBy: quotation.requiredBy || 'Sistema', internalOrderId: quotation.internalOrderId || order.id, statusHistory: [...(quotation.statusHistory || []), { status: 'required', at, by: 'Sistema', reason, internalOrderId: order.id }] };
  });
  if (next.every((quotation, index) => quotation === quotations[index])) return false;
  await transaction(db, async client => { await writeState(client, 'nexo-sales-quotations', next, 'Sistema · conciliación histórica'); await rebuildMaterialized(client); });
  return true;
}

async function insert(db, table, row) {
  const columns = Object.keys(row), placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
  const jsonColumns = new Set(['payload_json', 'before_json', 'after_json', 'detail_json', 'currencies']);
  await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, columns.map(column => jsonColumns.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column]));
}

async function upsert(db, table, row, conflictColumn = 'id') {
  const columns = Object.keys(row), placeholders = columns.map((_, index) => `$${index + 1}`).join(','), updates = columns.filter(column => column !== conflictColumn).map(column => `${column}=EXCLUDED.${column}`).join(','), jsonColumns = new Set(['payload_json', 'before_json', 'after_json', 'detail_json', 'currencies']);
  await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`, columns.map(column => jsonColumns.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column]));
}

function documentRow(sourceKey, type, item, entityType, relatedId) {
  const folio = String(value(item, 'folio', 'id') || 'SIN-FOLIO');
  return { id: `${type}:${folio}`, source_key: sourceKey, document_type: type, folio, entity_type: entityType, entity_id: String(value(item, 'id', 'folio') || folio), related_id: relatedId ? String(relatedId) : null, status: String(value(item, 'status', 'type') || 'registrado'), issued_at: value(item, 'createdAtISO', 'createdAt', 'date', 'appliedAt', 'deliveredAt'), payload_json: item, updated_at: timestamp() };
}

function auditRow(sourceKey, category, item, index = 0) {
  const rawId = value(item, 'id') || `${category}-${index}`;
  return { id: `${sourceKey}:${rawId}`, source_key: sourceKey, category, action: String(value(item, 'action', 'event', 'type', 'title') || 'actualización'), entity_type: value(item, 'entityType', 'entity_type'), entity_id: value(item, 'entityId', 'entity_id'), reference: value(item, 'reference', 'sourceDocumentId'), actor_id: value(item, 'actorId', 'userId'), actor_name: value(item, 'user', 'userName', 'createdBy'), before_json: item?.before ?? null, after_json: item?.after ?? null, detail_json: item, occurred_at: String(value(item, 'at', 'createdAtISO', 'createdAt', 'updatedAt', 'date') || timestamp()) };
}

async function rebuildMaterialized(db) {
  // Cada actualización reconstruye las tablas de consulta a partir del estado
  // completo. En producción varias peticiones pueden llegar a la vez (por
  // ejemplo, al cambiar de espacio), así que se serializa la reconstrucción
  // dentro de la misma transacción para evitar bloqueos cruzados en PostgreSQL.
  try {
    await db.query('SELECT pg_advisory_xact_lock(8042601)');
  } catch (error) {
    // pg-mem, usado exclusivamente por las pruebas, no implementa esta
    // función nativa de PostgreSQL.
    if (!(/pg_advisory_xact_lock/.test(error?.message || '') && /pg-mem/i.test(error?.message || ''))) throw error;
  }
  const state = await readState(db), updated = timestamp();
  const ids = {
    products: new Set((state['nexo-products'] || []).map(item => String(value(item, 'id', 'sku', 'number')))),
    quotations: new Set((state['nexo-sales-quotations'] || []).map(item => String(item.id))),
    clientOrders: new Set((state['nexo-commercial-orders'] || []).map(item => String(item.id))),
    requisitions: new Set(((state['nexo-order-operations-v1'] || {}).requisitions || []).map(item => String(item.id))),
    supplierOrders: new Set(((state['nexo-order-operations-v1'] || {}).supplierOrders || []).map(item => String(item.id))),
    suppliers: new Set((state['nexo-suppliers'] || []).map(item => String(value(item, 'id', 'code'))))
  };
  const linked = (id, collection) => id != null && collection.has(String(id)) ? String(id) : null;
  // Los eventos de auditoría son históricos: nunca se reconstruyen borrando la
  // tabla, incluso si una instantánea de estado ya no contiene el evento.
  const materializedTables = ['internal_order_item_sources', 'internal_order_quotations', 'quotation_items', 'client_order_items', 'supplier_order_lines', 'documents', 'movements', 'order_lines', 'supplier_invoices', 'receipts', 'customer_invoices', 'shipments', 'supplier_orders', 'requisitions', 'client_orders', 'quotations', 'price_loads', 'price_catalog_entries', 'product_supplier_relations', 'fx_records', 'clients', 'products', 'suppliers'];
  for (const table of materializedTables) await db.query(`DELETE FROM ${table}`);
  const put = (table, row) => insert(db, table, row);

  const access = state['nexo-access-v1'] || {};
  for (const item of access.users || []) await db.query('INSERT INTO users(id,name,email,role,status,seller_number,payload_json,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,role=EXCLUDED.role,status=EXCLUDED.status,seller_number=EXCLUDED.seller_number,payload_json=EXCLUDED.payload_json,updated_at=EXCLUDED.updated_at', [String(item.id), String(item.name || ''), String(item.email || ''), String(item.role || 'seller'), String(item.status || 'active'), item.sellerNumber || null, JSON.stringify(item), item.updatedAt || item.createdAt || updated]);
  for (const [index, item] of (access.audit || []).entries()) await put('audit_events', auditRow('nexo-access-v1', 'access', item, index));

  for (const item of state['nexo-products'] || []) { const sku = value(item, 'sku'), productNumber = value(item, 'number', 'productNumber'), name = String(value(item, 'name', 'description') || 'Sin nombre'); await put('products', { id: String(value(item, 'id', 'sku', 'number')), sku, product_number: productNumber, name, search_key: searchKey([productNumber, sku, name].join(' ')), supplier_id: value(item, 'supplierId'), unit: value(item, 'unit'), currency: String(value(item, 'currency', 'priceCurrency') || 'MXN'), price: number(item.price), warehouse_1: number(value(item, 'a1', 'warehouse1')), warehouse_2: number(value(item, 'a2', 'warehouse2')), payload_json: item, updated_at: updated }); }
  for (const item of state['nexo-clients'] || []) { const internalNumber = value(item, 'internalNumber', 'number'), name = String(value(item, 'name', 'businessName') || 'Sin nombre'), contact = value(item, 'contact'); await put('clients', { id: String(value(item, 'id', 'internalNumber')), internal_number: internalNumber, name, contact, email: value(item, 'email'), phone: value(item, 'phone'), search_key: searchKey([internalNumber, name, contact].join(' ')), owner_id: value(item, 'ownerId'), owner_name: value(item, 'ownerName'), owner_seller_number: value(item, 'ownerSellerNumber'), payload_json: item, updated_at: value(item, 'updatedAt', 'createdAt') || updated }); }
  for (const item of state['nexo-suppliers'] || []) await put('suppliers', { id: String(value(item, 'id', 'code')), code: value(item, 'code'), name: String(value(item, 'name', 'businessName') || 'Sin nombre'), email: value(item, 'email'), phone: value(item, 'phone'), payload_json: item, updated_at: updated });
  for (const item of state['nexo-product-supplier-relations'] || []) await put('product_supplier_relations', { id: String(item.id), product_id: String(item.productId), supplier_id: String(item.supplierId), supplier_sku: String(item.supplierSku), supplier_description: value(item, 'supplierDescription'), purchase_unit: value(item, 'purchaseUnit'), purchase_price: number(item.purchasePrice), currency: String(item.currency || 'MXN'), lead_time_days: number(item.leadTimeDays), minimum_order_quantity: number(item.minimumOrderQuantity), is_active: item.active !== false, is_preferred: Boolean(item.preferred), valid_from: value(item, 'validFrom'), valid_to: value(item, 'validTo'), created_by: value(item, 'createdBy'), created_at: value(item, 'createdAt') || updated, updated_by: value(item, 'updatedBy'), payload_json: item, updated_at: value(item, 'updatedAt') || updated });
  for (const item of state['nexo-price-catalog-entries'] || []) await put('price_catalog_entries', { id: String(item.id), supplier_id: String(item.supplierId), product_id: value(item, 'linkedProductId'), relation_id: value(item, 'supplierRelationId'), supplier_sku: value(item, 'code'), description: value(item, 'description'), purchase_unit: value(item, 'unit'), purchase_price: number(item.price), currency: String(item.currency || 'MXN'), batch_id: value(item, 'batchId'), is_current: item.isCurrent !== false, payload_json: item, updated_at: updated });
  for (const [index, item] of (state['nexo-movements'] || []).entries()) await put('movements', { id: String(value(item, 'id') || `MOV-${index}`), movement_type: String(value(item, 'type') || 'movimiento'), product_id: value(item, 'productId'), reference: value(item, 'reference', 'detail'), quantity: number(value(item, 'quantity', 'qty')), warehouse_id: value(item, 'warehouseId', 'warehouse'), occurred_at: value(item, 'createdAt', 'at', 'time'), user_name: value(item, 'user', 'createdBy'), payload_json: item, updated_at: updated });

  for (const item of state['nexo-price-loads'] || []) { await put('price_loads', { id: String(item.id), supplier_id: value(item, 'supplierId'), supplier_name: value(item, 'supplierName'), file_name: value(item, 'fileName'), file_hash: value(item, 'fileHash'), currencies: item.currencies || [], applied_at: value(item, 'appliedAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-price-loads', 'price_list_load', item, 'price_load', item.supplierId)); }
  for (const item of state['nexo-purchase-orders'] || []) await put('documents', documentRow('nexo-purchase-orders', 'internal_purchase_order', item, 'purchase_order', item.movementId));

  for (const item of state['nexo-sales-quotations'] || []) {
    const clientId = value(item, 'clientId') || (state['nexo-clients'] || []).find(client => String(client?.name || '').trim().toLowerCase() === String(item?.client || '').trim().toLowerCase())?.id || null;
    await put('quotations', { id: String(item.id), client_id: clientId, client_name: value(item, 'client'), status: value(item, 'status'), currency: documentCurrency(item), subtotal: number(item.subtotal), tax_amount: number(item.taxAmount), total: number(item.total), created_at: value(item, 'createdAtISO', 'createdAt'), created_by: value(item, 'createdBy', 'seller'), owner_id: value(item, 'ownerId'), owner_name: value(item, 'ownerName'), owner_seller_number: value(item, 'ownerSellerNumber'), payload_json: item, updated_at: updated });
    for (const [index, line] of (item.items || []).entries()) await put('quotation_items', { quotation_id: String(item.id), line_no: index + 1, product_id: linked(value(line, 'productId'), ids.products), sku: value(line, 'sku', 'number'), description: value(line, 'name', 'description'), quantity: number(line.quantity), unit_price: number(line.unitPrice), total: number(value(line, 'lineTotal', 'total')), payload_json: line });
    await put('documents', documentRow('nexo-sales-quotations', 'quotation', item, 'quotation', item.commercialOrderId));
  }
  for (const item of state['nexo-commercial-orders'] || []) {
    const clientId = value(item, 'clientId') || (state['nexo-clients'] || []).find(client => String(client?.name || '').trim().toLowerCase() === String(item?.client || '').trim().toLowerCase())?.id || null;
    await put('client_orders', { id: String(item.id), quotation_id: linked(value(item, 'quotationId'), ids.quotations), client_id: clientId, client_name: value(item, 'client'), owner_id: value(item, 'ownerId'), owner_name: value(item, 'ownerName'), owner_seller_number: value(item, 'ownerSellerNumber'), seller: value(item, 'seller'), created_by: value(item, 'createdBy'), status: value(item, 'status'), currency: documentCurrency(item), total: number(item.total), created_at: value(item, 'createdAtISO', 'createdAt'), payload_json: item, updated_at: updated });
    for (const quotationId of [...new Set(item.quotationIds || item.sourceQuotations?.map(source => source.quotationId) || [item.quotationId].filter(Boolean))]) if (ids.quotations.has(String(quotationId))) await put('internal_order_quotations', { internal_order_id: String(item.id), quotation_id: String(quotationId) });
    for (const [index, line] of (item.items || []).entries()) { await put('client_order_items', { client_order_id: String(item.id), line_no: index + 1, product_id: linked(value(line, 'productId'), ids.products), sku: value(line, 'sku', 'number'), description: value(line, 'name', 'description'), quantity: number(line.quantity), payload_json: line }); for (const [sourceIndex, source] of (line.sources || [{ sourceType: line.sourceType || 'manual', quotationId: line.quotationId || null, quotationLineNo: line.quotationLineNo || null, originalQuantity: line.originalQuantity || null, originalUnitPrice: line.originalUnitPrice || null, currency: line.currency || null }]).entries()) await put('internal_order_item_sources', { id: `${item.id}:${index + 1}:${sourceIndex + 1}`, internal_order_id: String(item.id), line_no: index + 1, quotation_id: source.quotationId && ids.quotations.has(String(source.quotationId)) ? String(source.quotationId) : null, quotation_line_no: source.quotationLineNo == null ? null : Number(source.quotationLineNo), source_type: source.sourceType === 'quotation' && source.quotationId ? 'quotation' : 'manual', original_quantity: source.originalQuantity == null ? null : number(source.originalQuantity), original_unit_price: source.originalUnitPrice == null ? null : number(source.originalUnitPrice), currency: source.currency || line.currency || null }); }
    await put('documents', documentRow('nexo-commercial-orders', 'client_order', item, 'client_order', item.quotationId));
  }

  const operations = state['nexo-order-operations-v1'] || {};
  for (const item of operations.requisitions || []) await put('requisitions', { id: String(item.id), quotation_id: linked(value(item, 'quotationId'), ids.quotations), client_order_id: linked(value(item, 'clientOrderId'), ids.clientOrders), customer_name: value(item, 'customerName'), status: value(item, 'status'), request_date: value(item, 'requestDate'), responsible: value(item, 'responsible'), payload_json: item, updated_at: value(item, 'updatedAt', 'createdAt') || updated });
  const lineIds = new Set((operations.orderLines || []).filter(item => ids.requisitions.has(String(item.requisitionId))).map(item => String(item.id)));
  for (const item of operations.orderLines || []) { if (!ids.requisitions.has(String(item.requisitionId))) continue; await put('order_lines', { id: String(item.id), requisition_id: String(item.requisitionId), product_id: linked(value(item, 'productId'), ids.products), sku: value(item, 'catalog', 'sku'), description: value(item, 'description'), requested: number(item.quantityRequested), purchased: number(item.quantityPurchased), received: number(item.quantityReceived), delivered: number(item.quantityDelivered), cancelled: number(item.quantityCancelled), status: value(item, 'status'), payload_json: item, updated_at: updated }); }
  for (const item of operations.supplierOrders || []) { await put('supplier_orders', { id: String(item.id), client_order_id: linked(value(item, 'clientOrderId'), ids.clientOrders), quotation_id: linked(value(item, 'quotationId'), ids.quotations), supplier_id: linked(value(item, 'supplierId'), ids.suppliers), supplier_name: value(item, 'supplierName'), status: value(item, 'status'), currency: String(value(item, 'currency') || 'MXN'), total: number(item.total), created_at: value(item, 'createdAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'supplier_order', item, 'supplier_order', item.clientOrderId)); }
  for (const item of operations.supplierOrderLines || []) { if (!ids.supplierOrders.has(String(item.supplierOrderId))) continue; await put('supplier_order_lines', { id: String(item.id), supplier_order_id: String(item.supplierOrderId), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), order_line_id: linked(value(item, 'orderLineId'), lineIds), quantity: number(item.quantity), unit_price: number(item.unitPrice), payload_json: item, updated_at: updated }); }
  for (const item of operations.supplierInvoices || []) { await put('supplier_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), supplier_name: value(item, 'supplierName'), currency: String(value(item, 'currency') || 'MXN'), amount_original: number(value(item, 'amountOriginal', 'amount')), exchange_rate: number(item.exchangeRate), total_mxn: number(item.totalMXN), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'supplier_invoice', item, 'supplier_invoice', (item.supplierOrderIds || [])[0])); }
  for (const item of operations.receipts || []) { await put('receipts', { id: String(item.id), supplier_order_id: linked(value(item, 'supplierOrderId'), ids.supplierOrders), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), receipt_type: value(item, 'type'), receipt_date: value(item, 'date'), user_name: value(item, 'user'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'receipt', item, 'receipt', item.supplierOrderId)); }
  for (const item of operations.inventoryMovements || []) await put('movements', { id: String(item.id), movement_type: String(value(item, 'type') || 'movimiento'), product_id: value(item, 'productId'), reference: value(item, 'sourceDocumentId', 'requisitionId'), quantity: number(item.quantity), warehouse_id: value(item, 'warehouseId'), occurred_at: value(item, 'at'), user_name: value(item, 'user'), payload_json: item, updated_at: updated });
  for (const item of operations.customerInvoices || []) { await put('customer_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), invoice_type: value(item, 'type'), currency: String(value(item, 'currency') || 'MXN'), amount: number(item.amount), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'customer_invoice', item, 'customer_invoice', item.requisitionId)); }
  for (const item of operations.shipments || []) { await put('shipments', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), shipment_type: value(item, 'type'), shipment_date: value(item, 'date'), delivered_at: value(item, 'deliveredAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'shipment', item, 'shipment', item.requisitionId)); }
  for (const [index, item] of (operations.auditLog || []).entries()) await put('audit_events', auditRow('nexo-order-operations-v1', 'operation', item, index));

  const fx = state['nexo-fx-v1'] || {};
  for (const [index, item] of (fx.records || []).entries()) await put('fx_records', { id: String(value(item, 'id') || `FX-${index}`), rate_date: value(item, 'rateDate', 'date'), source: value(item, 'source'), method: value(item, 'method'), usd: number(item.rates?.USD ?? item.USD), cad: number(item.rates?.CAD ?? item.CAD), eur: number(item.rates?.EUR ?? item.EUR), payload_json: item, updated_at: updated });
  for (const [index, item] of (fx.audit || []).entries()) await put('audit_events', auditRow('nexo-fx-v1', 'currency', item, index));
}

// Las divisas cambian con frecuencia y sólo alimentan su propia vista
// materializada. Reconstruir inventario, pedidos y catálogos completos al
// confirmar una tasa no aporta nada y podía impedir guardar la actualización
// si algún dato histórico ajeno requería conciliación.
async function rebuildFxMaterialized(db, fxState) {
  const fx = fxState || {}, updated = timestamp();
  await db.query('DELETE FROM fx_records');
  for (const [index, item] of (fx.records || []).entries()) {
    await insert(db, 'fx_records', {
      id: String(value(item, 'id') || `FX-${index}`),
      rate_date: value(item, 'rateDate', 'date'),
      source: value(item, 'source'),
      method: value(item, 'method'),
      usd: number(item.rates?.USD ?? item.USD),
      cad: number(item.rates?.CAD ?? item.CAD),
      eur: number(item.rates?.EUR ?? item.EUR),
      payload_json: item,
      updated_at: updated
    });
  }
  // La bitácora es acumulativa; insert() conserva los eventos ya existentes.
  for (const [index, item] of (fx.audit || []).entries()) await insert(db, 'audit_events', auditRow('nexo-fx-v1', 'currency', item, index));
}

async function lockMaterialized(db) {
  try { await db.query('SELECT pg_advisory_xact_lock(8042601)'); }
  catch (error) { if (!(/pg_advisory_xact_lock/.test(error?.message || '') && /pg-mem/i.test(error?.message || ''))) throw error; }
}

async function materializeProductsIncrementally(db, state) {
  const items = state['nexo-products'] || [], updated = timestamp(), existing = new Map((await db.query('SELECT id,payload_json FROM products')).rows.map(row => [String(row.id), parseJson(row.payload_json)]));
  for (const item of items) {
    const id = String(value(item, 'id', 'sku', 'number'));
    if (canonicalJson(existing.get(id)) === canonicalJson(item)) continue;
    const sku = value(item, 'sku'), productNumber = value(item, 'number', 'productNumber'), name = String(value(item, 'name', 'description') || 'Sin nombre');
    await upsert(db, 'products', { id, sku, product_number: productNumber, name, search_key: searchKey([productNumber, sku, name].join(' ')), supplier_id: value(item, 'supplierId'), unit: value(item, 'unit'), currency: String(value(item, 'currency', 'priceCurrency') || 'MXN'), price: number(item.price), warehouse_1: number(value(item, 'a1', 'warehouse1')), warehouse_2: number(value(item, 'a2', 'warehouse2')), payload_json: item, updated_at: updated });
  }
  const ids = items.map(item => String(value(item, 'id', 'sku', 'number')));
  if (ids.length) await db.query('DELETE FROM products WHERE NOT (id = ANY($1::text[])) AND id NOT IN (SELECT product_id FROM product_supplier_relations)', [ids]);
}

async function materializeRelationsIncrementally(db, state) {
  const items = state['nexo-product-supplier-relations'] || [], updated = timestamp(), existing = new Map((await db.query('SELECT id,payload_json FROM product_supplier_relations')).rows.map(row => [String(row.id), parseJson(row.payload_json)]));
  for (const item of items) {
    const id = String(item.id);
    if (canonicalJson(existing.get(id)) === canonicalJson(item)) continue;
    await upsert(db, 'product_supplier_relations', { id, product_id: String(item.productId), supplier_id: String(item.supplierId), supplier_sku: String(item.supplierSku), supplier_description: value(item, 'supplierDescription'), purchase_unit: value(item, 'purchaseUnit'), purchase_price: number(item.purchasePrice), currency: String(item.currency || 'MXN'), lead_time_days: number(item.leadTimeDays), minimum_order_quantity: number(item.minimumOrderQuantity), is_active: item.active !== false, is_preferred: Boolean(item.preferred), valid_from: value(item, 'validFrom'), valid_to: value(item, 'validTo'), created_by: value(item, 'createdBy'), created_at: value(item, 'createdAt') || updated, updated_by: value(item, 'updatedBy'), payload_json: item, updated_at: value(item, 'updatedAt') || updated });
  }
  const ids = items.map(item => String(item.id));
  if (ids.length) await db.query('DELETE FROM product_supplier_relations WHERE NOT (id = ANY($1::text[]))', [ids]);
  else await db.query('DELETE FROM product_supplier_relations');
}

async function materializeOperationsIncrementally(db, state) {
  const operations = state['nexo-order-operations-v1'] || {}, updated = timestamp();
  const ids = {
    products: new Set((state['nexo-products'] || []).map(item => String(value(item, 'id', 'sku', 'number')))),
    quotations: new Set((state['nexo-sales-quotations'] || []).map(item => String(item.id))),
    clientOrders: new Set((state['nexo-commercial-orders'] || []).map(item => String(item.id))),
    requisitions: new Set((operations.requisitions || []).map(item => String(item.id))),
    supplierOrders: new Set((operations.supplierOrders || []).map(item => String(item.id))),
    suppliers: new Set((state['nexo-suppliers'] || []).map(item => String(value(item, 'id', 'code'))))
  };
  const linked = (id, collection) => id != null && collection.has(String(id)) ? String(id) : null;
  const mutableTables = ['requisitions', 'order_lines', 'supplier_orders', 'supplier_order_lines', 'supplier_invoices', 'receipts', 'customer_invoices', 'shipments'];
  const existing = {};
  for (const table of mutableTables) existing[table] = new Map((await db.query(`SELECT id,payload_json FROM ${table}`)).rows.map(row => [String(row.id), parseJson(row.payload_json)]));
  existing.documents = new Map((await db.query("SELECT id,payload_json FROM documents WHERE source_key='nexo-order-operations-v1'")).rows.map(row => [String(row.id), parseJson(row.payload_json)]));
  existing.movements = new Map((await db.query('SELECT id,payload_json FROM movements')).rows.map(row => [String(row.id), parseJson(row.payload_json)]));
  const existingAudit = new Set((await db.query("SELECT id FROM audit_events WHERE source_key='nexo-order-operations-v1'")).rows.map(row => String(row.id)));
  const currentIds = Object.fromEntries(mutableTables.map(table => [table, new Set()]));
  const documentIds = new Set();
  const sync = async (table, row) => {
    const id = String(row.id); currentIds[table].add(id);
    if (canonicalJson(existing[table].get(id)) !== canonicalJson(row.payload_json)) await upsert(db, table, row);
  };
  const syncDocument = async row => {
    const id = String(row.id); documentIds.add(id);
    if (canonicalJson(existing.documents.get(id)) !== canonicalJson(row.payload_json)) await upsert(db, 'documents', row);
  };
  const removeMissing = async (table, values, condition = '') => {
    const list = [...values];
    const prefix = condition ? `${condition} AND ` : '';
    if (list.length) await db.query(`DELETE FROM ${table} WHERE ${prefix}NOT (id = ANY($1::text[]))`, [list]);
    else await db.query(`DELETE FROM ${table}${condition ? ` WHERE ${condition}` : ''}`);
  };
  for (const item of operations.requisitions || []) await sync('requisitions', { id: String(item.id), quotation_id: linked(value(item, 'quotationId'), ids.quotations), client_order_id: linked(value(item, 'clientOrderId'), ids.clientOrders), customer_name: value(item, 'customerName'), status: value(item, 'status'), request_date: value(item, 'requestDate'), responsible: value(item, 'responsible'), payload_json: item, updated_at: value(item, 'updatedAt', 'createdAt') || updated });
  const lineIds = new Set((operations.orderLines || []).filter(item => ids.requisitions.has(String(item.requisitionId))).map(item => String(item.id)));
  for (const item of operations.orderLines || []) if (ids.requisitions.has(String(item.requisitionId))) await sync('order_lines', { id: String(item.id), requisition_id: String(item.requisitionId), product_id: linked(value(item, 'productId'), ids.products), sku: value(item, 'catalog', 'sku'), description: value(item, 'description'), requested: number(item.quantityRequested), purchased: number(item.quantityPurchased), received: number(item.quantityReceived), delivered: number(item.quantityDelivered), cancelled: number(item.quantityCancelled), status: value(item, 'status'), payload_json: item, updated_at: updated });
  for (const item of operations.supplierOrders || []) { await sync('supplier_orders', { id: String(item.id), client_order_id: linked(value(item, 'clientOrderId'), ids.clientOrders), quotation_id: linked(value(item, 'quotationId'), ids.quotations), supplier_id: linked(value(item, 'supplierId'), ids.suppliers), supplier_name: value(item, 'supplierName'), status: value(item, 'status'), currency: String(value(item, 'currency') || 'MXN'), total: number(item.total), created_at: value(item, 'createdAt'), payload_json: item, updated_at: updated }); await syncDocument(documentRow('nexo-order-operations-v1', 'supplier_order', item, 'supplier_order', item.clientOrderId)); }
  for (const item of operations.supplierOrderLines || []) if (ids.supplierOrders.has(String(item.supplierOrderId))) await sync('supplier_order_lines', { id: String(item.id), supplier_order_id: String(item.supplierOrderId), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), order_line_id: linked(value(item, 'orderLineId'), lineIds), quantity: number(item.quantity), unit_price: number(item.unitPrice), payload_json: item, updated_at: updated });
  for (const item of operations.supplierInvoices || []) { await sync('supplier_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), supplier_name: value(item, 'supplierName'), currency: String(value(item, 'currency') || 'MXN'), amount_original: number(value(item, 'amountOriginal', 'amount')), exchange_rate: number(item.exchangeRate), total_mxn: number(item.totalMXN), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await syncDocument(documentRow('nexo-order-operations-v1', 'supplier_invoice', item, 'supplier_invoice', (item.supplierOrderIds || [])[0])); }
  for (const item of operations.receipts || []) { await sync('receipts', { id: String(item.id), supplier_order_id: linked(value(item, 'supplierOrderId'), ids.supplierOrders), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), receipt_type: value(item, 'type'), receipt_date: value(item, 'date'), user_name: value(item, 'user'), payload_json: item, updated_at: updated }); await syncDocument(documentRow('nexo-order-operations-v1', 'receipt', item, 'receipt', item.supplierOrderId)); }
  for (const item of operations.inventoryMovements || []) { const row = { id: String(item.id), movement_type: String(value(item, 'type') || 'movimiento'), product_id: value(item, 'productId'), reference: value(item, 'sourceDocumentId', 'requisitionId'), quantity: number(item.quantity), warehouse_id: value(item, 'warehouseId'), occurred_at: value(item, 'at'), user_name: value(item, 'user'), payload_json: item, updated_at: updated }; if (canonicalJson(existing.movements.get(row.id)) !== canonicalJson(item)) await upsert(db, 'movements', row); }
  for (const item of operations.customerInvoices || []) { await sync('customer_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), invoice_type: value(item, 'type'), currency: String(value(item, 'currency') || 'MXN'), amount: number(item.amount), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await syncDocument(documentRow('nexo-order-operations-v1', 'customer_invoice', item, 'customer_invoice', item.requisitionId)); }
  for (const item of operations.shipments || []) { await sync('shipments', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: linked(value(item, 'requisitionId'), ids.requisitions), shipment_type: value(item, 'type'), shipment_date: value(item, 'date'), delivered_at: value(item, 'deliveredAt'), payload_json: item, updated_at: updated }); await syncDocument(documentRow('nexo-order-operations-v1', 'shipment', item, 'shipment', item.requisitionId)); }
  for (const [index, item] of (operations.auditLog || []).entries()) { const row = auditRow('nexo-order-operations-v1', 'operation', item, index); if (!existingAudit.has(String(row.id))) await insert(db, 'audit_events', row); }
  for (const table of mutableTables) await removeMissing(table, currentIds[table]);
  await removeMissing('documents', documentIds, "source_key='nexo-order-operations-v1'");
}

async function materializeChangedStates(db, stateKeys) {
  const keys = new Set(stateKeys), supported = new Set(['nexo-products', 'nexo-product-supplier-relations', 'nexo-order-operations-v1']);
  if (![...keys].every(key => supported.has(key))) return false;
  await lockMaterialized(db);
  // No descargar todo app_state para una remisión. Las listas de precios y sus
  // cargas masivas son, con diferencia, los estados más grandes y no participan
  // en la salida de almacén. Leer sólo las dependencias reales reduce tiempo y
  // egress entre PostgreSQL y la función serverless.
  const requiredKeys = new Set(keys);
  if (keys.has('nexo-order-operations-v1')) {
    ['nexo-products', 'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-suppliers'].forEach(key => requiredKeys.add(key));
  }
  const state = await readStateKeys(db, [...requiredKeys]);
  if (keys.has('nexo-products')) await materializeProductsIncrementally(db, state);
  if (keys.has('nexo-product-supplier-relations')) await materializeRelationsIncrementally(db, state);
  if (keys.has('nexo-order-operations-v1')) await materializeOperationsIncrementally(db, state);
  return true;
}

async function transaction(db, task) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try { await client.query('BEGIN'); const result = await task(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release?.(); }
}

async function appendLedger(db, event) {
  const { rows } = await db.query('SELECT event_hash FROM audit_ledger ORDER BY occurred_at DESC, id DESC LIMIT 1');
  const previousHash = rows[0]?.event_hash || null, occurredAt = event.occurredAt || timestamp();
  const detail = event.detail || {};
  const eventHash = digest(canonicalJson({ id: event.id, eventType: event.eventType, entityType: event.entityType || null, entityId: event.entityId || null, actorId: event.actorId || null, actorName: event.actorName, detail, previousHash, occurredAt }));
  await db.query('INSERT INTO audit_ledger(id,event_type,entity_type,entity_id,actor_id,actor_name,detail_json,previous_hash,event_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [event.id, event.eventType, event.entityType || null, event.entityId || null, event.actorId || null, event.actorName || 'Sistema', JSON.stringify(detail), previousHash, eventHash, occurredAt]);
  return { ...event, previousHash, eventHash, occurredAt };
}

async function writeState(client, stateKey, payload, actor = 'Sistema', actorId = null, workspace = 'operational') {
  if (!STATE_KEYS.includes(stateKey)) throw new Error(`Estado no permitido: ${stateKey}`);
  validateStatePayload(stateKey, payload);
  if (stateKey === 'nexo-fx-v1') validateFxState(payload);
  const storageKey = workspaceStateKey(workspace, stateKey), updated = timestamp(), result = await client.query(`INSERT INTO app_state(state_key,payload_json,revision,updated_at,updated_by) VALUES($1,$2,1,$3,$4) ON CONFLICT(state_key) DO UPDATE SET payload_json=EXCLUDED.payload_json,revision=app_state.revision+1,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by RETURNING state_key,revision,updated_at,updated_by`, [storageKey, JSON.stringify(payload), updated, actor]);
  const revision = result.rows[0], payloadHash = digest(canonicalJson(payload)), commitId = `STATE:${storageKey}:${revision.revision}`;
  await client.query('INSERT INTO state_commits(id,state_key,revision,payload_hash,previous_hash,actor_name,committed_at) VALUES($1,$2,$3,$4,(SELECT payload_hash FROM state_commits WHERE state_key=$2 ORDER BY revision DESC LIMIT 1),$5,$6) ON CONFLICT(state_key,revision) DO NOTHING', [commitId, storageKey, revision.revision, payloadHash, actor, updated]);
  await appendLedger(client, { id: commitId, eventType: workspace === 'training' ? 'training_state_committed' : 'state_committed', entityType: 'state', entityId: storageKey, actorId, actorName: actor, detail: { revision: revision.revision, payloadHash, workspace } });
  return revision;
}

async function saveState(db, stateKey, payload, actor = 'Sistema', actorId = null, workspace = 'operational') {
  const revisions = await saveStates(db, [[stateKey, payload]], actor, actorId, workspace);
  return revisions[stateKey];
}

async function saveStates(db, entries, actor = 'Sistema', actorId = null, workspace = 'operational') {
  const normalized = [...new Map((entries || []).map(([key, payload]) => [key, payload])).entries()];
  if (!normalized.length) throw Object.assign(new Error('No hay cambios para guardar.'), { status: 400 });
  return transaction(db, async client => {
    const revisions = {};
    for (const [stateKey, payload] of normalized) revisions[stateKey] = await writeState(client, stateKey, payload, actor, actorId, workspace);
    // Pruebas es una partición central aislada. Nunca reconstruye ni altera
    // las tablas materializadas de la operación real.
    if (workspace !== 'training') {
      if (normalized.length === 1 && normalized[0][0] === 'nexo-fx-v1') await rebuildFxMaterialized(client, normalized[0][1]);
      else if (!await materializeChangedStates(client, normalized.map(([key]) => key))) await rebuildMaterialized(client);
    }
    return revisions;
  });
}

async function importSnapshot(db, snapshot, actor = 'Migración local') {
  return transaction(db, async client => {
    const entries = Object.entries(snapshot || {}).filter(([key]) => STATE_KEYS.includes(key));
    for (const [key, payload] of entries) await writeState(client, key, payload, actor);
    await rebuildMaterialized(client); return { imported: entries.length };
  });
}

function emptyStateForReset(actor) {
  const user = { id: actor.id, name: actor.name, email: actor.email, role: 'developer', status: 'active', createdAt: timestamp() };
  return {
    'nexo-access-v1': { version: 3, currentUserId: actor.id, users: [user], roleOverrides: {}, workspace: { sandboxEnabled: true, modes: {} }, audit: [] },
    'nexo-products': [], 'nexo-suppliers': [], 'nexo-clients': [], 'nexo-movements': [], 'nexo-price-loads': [], 'nexo-price-catalog-entries': [], 'nexo-product-supplier-relations': [], 'nexo-purchase-orders': [],
    'nexo-sales-quotations': [], 'nexo-commercial-orders': [], 'nexo-quotation-sequences': {},
    'nexo-order-operations-v1': { version: 1, requisitions: [], orderLines: [], supplierOrders: [], supplierOrderLines: [], supplierInvoices: [], receipts: [], inventoryMovements: [], customerInvoices: [], shipments: [], auditLog: [] },
    'nexo-fx-v1': { records: [], audit: [] },
    'nexo-quotation-terms-v1': { version: 1, paymentTemplate: '{paymentCondition}. El pago se realizará conforme a esta condición.', pricePolicy: '', cancellationPolicy: '', audit: [] }
  };
}

// Estructura base del espacio compartido de capacitación. Deliberadamente no
// contiene información operativa ni usuarios; éstos se consultan del espacio
// operativo exclusivamente para autenticar y aplicar permisos.
function emptyTrainingState() {
  const state = emptyStateForReset({ id: 'TRAINING', name: 'Área de pruebas', email: 'training@probiolab.local' });
  delete state['nexo-access-v1'];
  return state;
}

async function resetOperationalData(db, actor, reason) {
  const justification = String(reason || '').trim();
  if (justification.length < 8) throw Object.assign(new Error('La justificación del restablecimiento debe tener al menos 8 caracteres.'), { status: 400 });
  return transaction(db, async client => {
    const state = emptyStateForReset(actor);
    for (const key of STATE_KEYS) await writeState(client, key, state[key], actor.name, actor.id);
    // El perfil de Desarrollo que ejecuta el restablecimiento permanece para
    // evitar una base inaccesible; las demás cuentas y sesiones se eliminan.
    await client.query('DELETE FROM users WHERE id<>$1', [actor.id]);
    await rebuildMaterialized(client);
    const event = await appendLedger(client, { id: `RESET:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`, eventType: 'operational_data_reset', entityType: 'system', entityId: 'operational-data', actorId: actor.id, actorName: actor.name, detail: { reason: justification, preserved: ['audit_ledger', 'state_commits', 'audit_events'], cleared: 'operational_data_and_non_developer_accounts' } });
    return { resetAt: event.occurredAt, preservedAuditTrail: true };
  });
}

async function listResource(db, resource) {
  const tables = { products: 'products', suppliers: 'suppliers', movements: 'movements', quotations: 'quotations', 'client-orders': 'client_orders', requisitions: 'requisitions', 'supplier-orders': 'supplier_orders', receipts: 'receipts', shipments: 'shipments', documents: 'documents' };
  const table = tables[resource]; if (!table) return null;
  const { rows } = await db.query(`SELECT payload_json FROM ${table} ORDER BY updated_at DESC`); return rows.map(row => parseJson(row.payload_json));
}

async function listAudit(db, limit = 500) {
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  const [legacy, ledger] = await Promise.all([db.query('SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT $1', [safeLimit]), db.query('SELECT * FROM audit_ledger ORDER BY occurred_at DESC LIMIT $1', [safeLimit])]);
  return [...legacy.rows.map(row => ({ ...row, before: parseJson(row.before_json), after: parseJson(row.after_json), detail: parseJson(row.detail_json), immutable: false })), ...ledger.rows.map(row => ({ ...row, category: 'ledger', action: row.event_type, detail: parseJson(row.detail_json), immutable: true, occurred_at: row.occurred_at }))].sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at))).slice(0, safeLimit);
}

function readApproval(row) { return { ...row, payload: parseJson(row.payload_json) }; }
async function createApproval(db, input) {
  if (!approvalTypes.has(input.actionType)) throw Object.assign(new Error('El tipo de aprobación no es válido.'), { status: 400 });
  const justification = String(input.justification || '').trim();
  if (justification.length < 8) throw Object.assign(new Error('La justificación debe explicar la solicitud (mínimo 8 caracteres).'), { status: 400 });
  const id = `APR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, requestedAt = timestamp();
  const row = { id, actionType: input.actionType, entityType: String(input.entityType || 'operation'), entityId: input.entityId == null ? null : String(input.entityId), justification, payload: input.payload && typeof input.payload === 'object' ? input.payload : {}, status: 'pending', requestedById: input.actor.id, requestedByName: input.actor.name, requestedAt };
  await transaction(db, async client => { await client.query('INSERT INTO approval_requests(id,action_type,entity_type,entity_id,justification,payload_json,status,requested_by_id,requested_by_name,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [row.id, row.actionType, row.entityType, row.entityId, row.justification, JSON.stringify(row.payload), row.status, row.requestedById, row.requestedByName, row.requestedAt]); await appendLedger(client, { id: `LEDGER:${id}:requested`, eventType: 'approval_requested', entityType: row.entityType, entityId: row.entityId || id, actorId: row.requestedById, actorName: row.requestedByName, detail: { approvalId: id, actionType: row.actionType, justification, payload: row.payload } }); });
  return row;
}
async function listApprovals(db, options = {}) {
  const values = [], clauses = [];
  if (options.status) { values.push(options.status); clauses.push(`status=$${values.length}`); }
  if (options.requestedById) { values.push(options.requestedById); clauses.push(`requested_by_id=$${values.length}`); }
  const { rows } = await db.query(`SELECT * FROM approval_requests ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY requested_at DESC`, values);
  return rows.map(readApproval);
}
async function executiveDashboard(db, user, period = 'today') {
  const seller = false, scope = [];
  const [productsResult, ordersResult, quotationsResult, approvalsResult] = await Promise.all([
    db.query('SELECT id,name,price,warehouse_1,warehouse_2,payload_json FROM products'),
    db.query(`SELECT id,status,total,currency,owner_id,created_at,payload_json FROM client_orders${seller ? ' WHERE owner_id=$1' : ''}`, scope),
    db.query('SELECT id,status,total,currency,created_at,payload_json FROM quotations'),
    db.query(`SELECT status FROM approval_requests${['administrator','supervisor'].includes(user?.role) ? '' : ' WHERE requested_by_id=$1'}`, ['administrator','supervisor'].includes(user?.role) ? [] : [user?.id])
  ]);
  const products = productsResult.rows.map(row => ({ ...row, payload: parseJson(row.payload_json) })), orders = ordersResult.rows, quotations = quotationsResult.rows;
  const today = new Date(), annual = period === 'year', periodDate = period === 'closed-month' ? new Date(today.getFullYear(), today.getMonth() - 1, 1) : today, month = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, '0')}`;
  const dateMonth = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '').slice(0, 7) : date.toISOString().slice(0, 7); };
  const belongsToSeller = () => true;
  const scopedOrders = orders.map(order => ({ ...order, payload: parseJson(order.payload_json) })).filter(belongsToSeller), scopedQuotations = quotations.map(quotation => ({ ...quotation, payload: parseJson(quotation.payload_json) })).filter(belongsToSeller);
  const withinPeriod = record => annual ? dateMonth(record.created_at).startsWith(String(periodDate.getFullYear())) : dateMonth(record.created_at) === month;
  const ordersInPeriod = scopedOrders.filter(withinPeriod), quotationsInPeriod = scopedQuotations.filter(withinPeriod);
  const totalsFor = records => {
    const totals = new Map();
    for (const record of records) {
      const structured = Array.isArray(record.payload?.totalsByCurrency) ? record.payload.totalsByCurrency : [];
      const rows = structured.length ? structured.map(entry => ({ currency: String(entry.currency || record.currency || 'MXN').toUpperCase(), total: number(entry.total) })) : (() => {
        const items = Array.isArray(record.payload?.items) ? record.payload.items : [];
        if (items.length && !number(record.total)) return items.reduce((rows, item) => { const currency = String(item.currency || item.sourceCurrency || record.currency || 'MXN').toUpperCase(), total = number(item.lineTotal ?? item.total ?? (number(item.quantity) * number(item.unitPrice))); const found = rows.find(row => row.currency === currency); if (found) found.total += total; else rows.push({ currency, total }); return rows; }, []);
        return [{ currency: String(record.currency || record.payload?.currency || 'MXN').toUpperCase(), total: number(record.total) }];
      })();
      rows.forEach(row => totals.set(row.currency, number(totals.get(row.currency)) + number(row.total)));
    }
    return { byCurrency: [...totals.entries()].map(([currency, total]) => ({ currency, total: Math.round(total * 1000000) / 1000000 })) };
  };
  const orderTotals = totalsFor(ordersInPeriod), quotationTotals = totalsFor(quotationsInPeriod);
  if (period === 'closed-month') await db.query('INSERT INTO dashboard_monthly_snapshots(period_key,orders_count,order_totals,quotations_count,quotation_totals) VALUES($1,$2,$3,$4,$5) ON CONFLICT(period_key) DO NOTHING', [month, ordersInPeriod.length, JSON.stringify(orderTotals.byCurrency), quotationsInPeriod.length, JSON.stringify(quotationTotals.byCurrency)]);
  const lowStock = products.filter(product => Number(product.payload?.min || 0) > 0 && Number(product.warehouse_1) + Number(product.warehouse_2) <= Number(product.payload.min));
  return { inventory: { references: products.length, units: products.reduce((sum, product) => sum + Number(product.warehouse_1) + Number(product.warehouse_2), 0), lowStock: lowStock.length }, commercial: { period: annual ? String(periodDate.getFullYear()) : month, periodLabel: annual ? String(periodDate.getFullYear()) : periodDate.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }), openOrders: scopedOrders.filter(order => !['completed', 'cancelled'].includes(String(order.status || '').toLowerCase())).length, orders: ordersInPeriod.length, orderTotals, quotations: quotationsInPeriod.length, quotationTotals }, approvals: { pending: approvalsResult.rows.filter(row => row.status === 'pending').length } };
}
async function operationalAlerts(db, user) {
  const seller = user?.role === 'seller', scope = seller ? [user.id] : [];
  const [productsResult, ordersResult, approvals] = await Promise.all([
    db.query('SELECT id,name,warehouse_1,warehouse_2,payload_json FROM products'),
    db.query(`SELECT id,client_name,status,owner_id FROM client_orders${seller ? ' WHERE owner_id=$1' : ''}`, scope),
    listApprovals(db, ['administrator','supervisor'].includes(user?.role) ? { status: 'pending' } : { requestedById: user?.id, status: 'pending' })
  ]), alerts = [];
  for (const product of productsResult.rows) { const payload = parseJson(product.payload_json), stock = Number(product.warehouse_1) + Number(product.warehouse_2), minimum = Number(payload?.min || 0); if (minimum > 0 && stock <= minimum) alerts.push({ id: `stock:${product.id}`, severity: stock <= 0 ? 'critical' : 'warning', title: stock <= 0 ? 'Sin existencia' : 'Inventario mínimo', detail: `${product.name}: ${stock} uds. disponibles de mínimo ${minimum}.`, entityType: 'product', entityId: product.id }); }
  for (const order of ordersResult.rows.filter(row => ['pending','draft'].includes(String(row.status || '').toLowerCase()))) alerts.push({ id: `order:${order.id}`, severity: 'warning', title: 'Pedido pendiente de activar', detail: `${order.id} · ${order.client_name || 'Cliente por definir'}.`, entityType: 'client_order', entityId: order.id });
  for (const approval of approvals) alerts.push({ id: `approval:${approval.id}`, severity: 'info', title: 'Aprobación pendiente', detail: `${approval.action_type} · ${approval.justification}`, entityType: approval.entity_type, entityId: approval.entity_id, approvalId: approval.id });
  return alerts.slice(0, 40);
}
function quotationBelongsToClient(quotation, client) {
  const quotationClientId = String(quotation?.clientId || '').trim();
  if (quotationClientId) return quotationClientId === String(client?.id || '').trim();
  return String(quotation?.client || '').trim().toLowerCase() === String(client?.name || '').trim().toLowerCase();
}
function validateInternalOrderQuotations(selectedIds, quotations, client, allowedOrderId = null) {
  if (!selectedIds.length) throw Object.assign(new Error('Selecciona al menos una cotización para crear el pedido interno.'), { status: 400 });
  if (quotations.length !== selectedIds.length) throw Object.assign(new Error('Una o más cotizaciones seleccionadas ya no están disponibles. Actualiza la lista e inténtalo nuevamente.'), { status: 404 });
  const unavailable = quotations.find(quotation => quotation.locked || String(quotation.status || '').toLowerCase() === 'required');
  if (unavailable) throw Object.assign(new Error(`La cotización ${unavailable.id} ya está requerida o vinculada a otro pedido interno.`), { status: 409 });
  const associated = quotations.find(quotation => {
    const orderId = quotation.internalOrderId || quotation.commercialOrderId;
    return orderId && String(orderId) !== String(allowedOrderId || '');
  });
  if (associated) throw Object.assign(new Error(`La cotización ${associated.id} ya fue convertida al pedido interno ${associated.internalOrderId || associated.commercialOrderId}.`), { status: 409 });
  const foreign = quotations.find(quotation => !quotationBelongsToClient(quotation, client));
  if (foreign) throw Object.assign(new Error(`La cotización ${foreign.id} no pertenece al cliente seleccionado.`), { status: 400 });
}
function internalOrderQuantityVariances(items) {
  return (items || []).map(item => {
    const quotedQuantity = (item.sources || []).filter(source => source.sourceType === 'quotation').reduce((sum, source) => sum + number(source.originalQuantity), 0), requestedQuantity = number(item.quantity);
    return quotedQuantity > 0 && Math.abs(requestedQuantity - quotedQuantity) > 0.000001 ? { itemId: item.id, productId: item.productId || null, catalog: item.number || item.sku || '', description: item.name || item.description || 'Producto', quotedQuantity, requestedQuantity } : null;
  }).filter(Boolean);
}
function validateInternalOrderQuantityAcknowledgement(items, acknowledgement, user) {
  const variances = internalOrderQuantityVariances(items);
  if (variances.length && acknowledgement?.confirmed !== true) throw Object.assign(new Error('Confirma la diferencia entre las cantidades cotizadas y las solicitadas antes de guardar el pedido.'), { status: 409, variances });
  return variances.length ? { confirmed: true, confirmedAt: timestamp(), confirmedBy: user?.name || 'Usuario', confirmedById: user?.id || null, variances } : null;
}
function userOwnsClient(client, user) { return user?.role !== 'seller' || (String(client?.ownerId || '') === String(user?.id || '') || (!client?.ownerId && String(client?.ownerName || '').trim().toLowerCase() === String(user?.name || '').trim().toLowerCase())); }
function internalOrderFolio(orders, date = new Date()) { const code = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`, pattern = new RegExp(`^PI-${code}-(\\d{4,})$`), last = orders.reduce((highest, order) => Math.max(highest, Number(String(order?.id || '').match(pattern)?.[1] || 0)), 0); return `PI-${code}-${String(last + 1).padStart(4, '0')}`; }
function internalOrderPaymentOverride(input) { const raw = input && typeof input === 'object' ? input : {}, paymentMethod = raw.paymentMethod === 'cash' ? 'cash' : raw.paymentMethod === 'credit' ? 'credit' : null, creditDays = Math.max(0, number(raw.creditDays)); return paymentMethod ? { paymentMethod, creditDays: paymentMethod === 'credit' ? creditDays : 0 } : null; }
function internalOrderTerms(quotations, date = new Date(), override = null) { return quotations.map(quotation => { const paymentMethod = override?.paymentMethod || quotation.paymentMethod || null, creditDays = paymentMethod === 'credit' ? (override ? override.creditDays : Math.max(0, number(quotation.creditDays))) : 0, due = creditDays ? new Date(date) : null; if (due) due.setDate(due.getDate() + creditDays); return { quotationId: quotation.id, orderDate: date.toISOString(), paymentMethod, creditDays: creditDays || null, paymentDueDate: due?.toISOString() || null, paymentTerms: String(quotation.paymentTerms || '').trim(), pricePolicy: String(quotation.pricePolicy || '').trim(), cancellationPolicy: String(quotation.cancellationPolicy || '').trim(), instructions: String(quotation.notes || '').trim() }; }); }
const roundInternalOrderMoney = value => Math.round((number(value) + Number.EPSILON) * 100) / 100;
function quotationTaxRate(quotation) {
  if (quotation?.taxRate != null && quotation.taxRate !== '') return Math.max(0, number(quotation.taxRate));
  const saved = Array.isArray(quotation?.totalsByCurrency) ? quotation.totalsByCurrency : [];
  const taxable = saved.reduce((sum, entry) => sum + number(entry.taxable ?? (number(entry.subtotal) - number(entry.discountTotal))), 0), taxAmount = saved.reduce((sum, entry) => sum + number(entry.taxAmount), 0);
  if (taxable > 0 && taxAmount >= 0) return roundInternalOrderMoney(taxAmount / taxable * 100);
  const itemSubtotal = (quotation?.items || []).reduce((sum, item) => { const gross = number(item.quantity) * number(item.unitPrice), discount = gross * number(item.discount) / 100; return sum + gross - discount; }, 0);
  if (itemSubtotal > 0 && number(quotation?.total) >= itemSubtotal) return roundInternalOrderMoney((number(quotation.total) / itemSubtotal - 1) * 100);
  return 16;
}
function internalOrderFinancialSnapshot(items, quotations) {
  const quoteMap = new Map((quotations || []).map(quotation => [String(quotation.id), quotation])), fallbackTaxRate = quotationTaxRate(quotations?.[0]), buckets = new Map();
  const financialItems = (items || []).map(item => {
    const sourceQuote = (item.sources || []).map(source => quoteMap.get(String(source.quotationId))).find(Boolean), inheritedTaxRate = sourceQuote ? quotationTaxRate(sourceQuote) : fallbackTaxRate, taxRate = item.taxRate == null || item.taxRate === '' ? inheritedTaxRate : Math.max(0, number(item.taxRate));
    const quantity = Math.max(0, number(item.quantity)), unitPrice = roundInternalOrderMoney(Math.max(0, number(item.unitPrice))), discount = Math.min(100, Math.max(0, number(item.discount))), subtotal = roundInternalOrderMoney(quantity * unitPrice), explicitDiscount = item.discountTotal ?? item.lineDiscount ?? item.discountAmount, discountTotal = explicitDiscount == null ? roundInternalOrderMoney(subtotal * discount / 100) : roundInternalOrderMoney(Math.min(subtotal, Math.max(0, number(explicitDiscount)))), taxable = roundInternalOrderMoney(subtotal - discountTotal), taxAmount = roundInternalOrderMoney(taxable * taxRate / 100), total = roundInternalOrderMoney(taxable + taxAmount), currency = String(item.currency || 'MXN').toUpperCase();
    const current = buckets.get(currency) || { currency, subtotal: 0, discountTotal: 0, taxable: 0, taxAmount: 0, total: 0 };
    for (const [field, value] of Object.entries({ subtotal, discountTotal, taxable, taxAmount, total })) current[field] = roundInternalOrderMoney(current[field] + value);
    buckets.set(currency, current);
    return { ...item, currency, discount, taxRate, subtotal, discountTotal, taxable, taxAmount, total, lineTotal: total };
  });
  const totalsByCurrency = [...buckets.values()], rates = [...new Set(financialItems.map(item => item.taxRate))], single = totalsByCurrency.length === 1 ? totalsByCurrency[0] : null;
  return { items: financialItems, totalsByCurrency, currency: totalsByCurrency.length > 1 ? 'MULTI' : (single?.currency || 'MXN'), subtotal: single?.subtotal || 0, discountTotal: single?.discountTotal || 0, taxable: single?.taxable || 0, taxAmount: single?.taxAmount || 0, total: single?.total || 0, taxRate: rates.length === 1 ? rates[0] : null };
}
function normalizeInternalOrderItems(items, quotations, products, relations) {
  const quoteMap = new Map(quotations.map(quotation => [String(quotation.id), quotation]));
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const product = products.find(candidate => String(candidate.id) === String(item.productId)) || products.find(candidate => String(candidate.sku || '') === String(item.sku || '')) || null;
    const sources = (Array.isArray(item.sources) ? item.sources : []).map(source => {
      const quote = quoteMap.get(String(source.quotationId)), sourceLine = quote?.items?.[Number(source.quotationLineNo) - 1];
      if (!quote || !sourceLine) throw Object.assign(new Error('Una partida referencia una cotización o renglón que no fue seleccionado.'), { status: 400 });
      return { sourceType: 'quotation', quotationId: quote.id, quotationLineNo: Number(source.quotationLineNo), originalQuantity: number(sourceLine.quantity), originalUnitPrice: roundInternalOrderMoney(sourceLine.unitPrice), discount: Math.max(0, number(sourceLine.discount)), discountTotal: sourceLine.discountTotal ?? sourceLine.lineDiscount ?? sourceLine.discountAmount ?? null, taxRate: quotationTaxRate(quote), currency: sourceLine.currency || quote.currency || 'MXN' };
    });
    const activeRelations = relations.filter(candidate => String(candidate.productId) === String(product?.id) && candidate.active !== false);
    const relation = activeRelations.find(candidate => item.supplierRelationId && String(candidate.id) === String(item.supplierRelationId))
      || activeRelations.find(candidate => item.supplierId && String(candidate.supplierId) === String(item.supplierId))
      || activeRelations.find(candidate => candidate.preferred)
      || (activeRelations.length === 1 ? activeRelations[0] : null);
    const inheritedDiscountTotal = sources.length && sources.every(source => source.discountTotal != null) ? roundInternalOrderMoney(sources.reduce((sum, source) => sum + number(source.discountTotal), 0)) : null;
    return { id: item.id || `PIL-${index + 1}`, productId: product?.id || item.productId || null, number: item.number || product?.number || '', sku: item.sku || product?.sku || '', name: item.name || product?.name || 'Producto manual', description: item.description || item.name || product?.name || 'Producto manual', unit: item.unit || product?.unit || 'unidad', quantity: Math.max(0, number(item.quantity)), unitPrice: roundInternalOrderMoney(Math.max(0, number(item.unitPrice))), discount: item.discount == null ? Math.max(0, number(sources[0]?.discount)) : Math.max(0, number(item.discount)), discountTotal: item.discountTotal ?? item.lineDiscount ?? item.discountAmount ?? inheritedDiscountTotal, taxRate: item.taxRate == null ? (sources[0]?.taxRate ?? quotationTaxRate(quotations[0])) : Math.max(0, number(item.taxRate)), purchaseCost: item.purchaseCost == null || item.purchaseCost === '' ? (relation ? number(relation.purchasePrice) : null) : Math.max(0, number(item.purchaseCost)), currency: String(item.currency || sources[0]?.currency || product?.salePriceCurrency || product?.priceCurrency || 'MXN').toUpperCase(), supplierId: item.supplierId || relation?.supplierId || null, supplierRelationId: item.supplierRelationId || relation?.id || null, observations: String(item.observations || '').trim(), sourceType: sources.length ? 'quotation' : 'manual', sources: sources.length ? sources : [{ sourceType: 'manual', quotationId: null, quotationLineNo: null, originalQuantity: null, originalUnitPrice: null, discount: 0, discountTotal: null, taxRate: quotationTaxRate(quotations[0]), currency: String(item.currency || product?.priceCurrency || 'MXN').toUpperCase() }] };
  }).filter(item => item.quantity > 0);
}
async function listClientQuotations(db, clientId, user, workspace = 'operational') {
  const state = await readStateKeys(db, ['nexo-clients', 'nexo-commercial-orders', 'nexo-sales-quotations'], workspace), client = (state['nexo-clients'] || []).find(item => String(item.id) === String(clientId));
  if (!client || !userOwnsClient(client, user)) throw Object.assign(new Error('El cliente no está disponible para tu cartera.'), { status: 404 });
  const convertedIds = new Set((state['nexo-commercial-orders'] || []).filter(order => String(order.status || '').toLowerCase() !== 'cancelled').flatMap(order => (order.quotationIds || [order.quotationId]).filter(Boolean).map(String)));
  return (state['nexo-sales-quotations'] || []).filter(quotation => !['cancelled', 'required'].includes(String(quotation.status || '').toLowerCase()) && !quotation.locked && !quotation.internalOrderId && !quotation.commercialOrderId && !convertedIds.has(String(quotation.id)) && !quotationIsExpired(quotation) && quotationBelongsToClient(quotation, client)).map(quotation => ({ ...quotation, clientId: client.id }));
}
async function createInternalOrder(db, input, user, workspace = 'operational') {
  const state = await readStateKeys(db, ['nexo-clients', 'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-products', 'nexo-product-supplier-relations'], workspace), client = (state['nexo-clients'] || []).find(item => String(item.id) === String(input.clientId));
  if (!client || !userOwnsClient(client, user)) throw Object.assign(new Error('Selecciona un cliente de tu cartera.'), { status: 400 });
  const selectedIds = [...new Set(Array.isArray(input.quotationIds) ? input.quotationIds.map(String) : [])], quotations = (state['nexo-sales-quotations'] || []).filter(quotation => selectedIds.includes(String(quotation.id)));
  const previousOrder = (state['nexo-commercial-orders'] || []).find(order => String(order.status || '').toLowerCase() !== 'cancelled' && (order.quotationIds || [order.quotationId]).filter(Boolean).map(String).some(id => selectedIds.includes(id)));
  if (previousOrder) throw Object.assign(new Error(`Una cotización seleccionada ya fue convertida al pedido interno ${previousOrder.id}.`), { status: 409 });
  validateInternalOrderQuotations(selectedIds, quotations, client);
  if (quotations.some(quotation => quotationIsExpired(quotation))) throw Object.assign(new Error('No puedes crear un pedido con una cotización vencida. Genera una nueva versión vigente.'), { status: 409 });
  const items = normalizeInternalOrderItems(input.items, quotations, state['nexo-products'] || [], state['nexo-product-supplier-relations'] || []);
  if (!items.length) throw Object.assign(new Error('El pedido interno requiere al menos una partida con cantidad positiva.'), { status: 400 });
  const quantityVarianceAcknowledgement = validateInternalOrderQuantityAcknowledgement(items, input.quantityVarianceAcknowledgement, user), now = new Date(), orders = Array.isArray(state['nexo-commercial-orders']) ? state['nexo-commercial-orders'] : [], id = internalOrderFolio(orders, now), commercialTermsOverride = internalOrderPaymentOverride(input.commercialTermsOverride), financial = internalOrderFinancialSnapshot(items, quotations);
  const order = { id, clientId: client.id, client: client.name, clientNumber: client.internalNumber || '', ownerId: client.ownerId || user.id, ownerName: client.ownerName || user.name, ownerSellerNumber: client.ownerSellerNumber || user.sellerNumber || '', seller: user.name, quotationId: selectedIds[0], quotationIds: selectedIds, sourceQuotations: quotations.map(quotation => ({ quotationId: quotation.id, status: 'converted', linkedAt: now.toISOString() })), commercialTerms: internalOrderTerms(quotations, now, commercialTermsOverride), commercialTermsOverride, ...financial, status: 'draft', observations: String(input.observations || '').trim(), quantityVarianceAcknowledgement, createdAtISO: now.toISOString(), createdAt: now.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' }), createdBy: user.name, timeline: [{ status: 'draft', label: 'Pedido interno creado; cotizaciones marcadas como convertidas', at: now.toISOString(), by: user.name }, ...(quantityVarianceAcknowledgement ? [{ status: 'quantity_variance_confirmed', label: 'Diferencia de cantidades contra cotización confirmada', at: quantityVarianceAcknowledgement.confirmedAt, by: quantityVarianceAcknowledgement.confirmedBy, variances: quantityVarianceAcknowledgement.variances }] : [])] };
  const convertedQuotations = (state['nexo-sales-quotations'] || []).map(quotation => selectedIds.includes(String(quotation.id)) ? { ...quotation, commercialOrderId: id, internalOrderId: id, convertedAt: now.toISOString(), statusHistory: [...(quotation.statusHistory || []), { status: 'converted', at: now.toISOString(), by: user.name, reference: id }] } : quotation);
  await saveStates(db, [['nexo-commercial-orders', [order, ...orders]], ['nexo-sales-quotations', convertedQuotations]], user.name, user.id, workspace); return order;
}
async function updateInternalOrder(db, id, input, user, workspace = 'operational') {
  const state = await readStateKeys(db, ['nexo-clients', 'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-products', 'nexo-product-supplier-relations'], workspace), orders = Array.isArray(state['nexo-commercial-orders']) ? state['nexo-commercial-orders'] : [], current = orders.find(order => String(order.id) === String(id));
  if (!current || !userOwnsClient({ ownerId: current.ownerId, ownerName: current.ownerName }, user)) throw Object.assign(new Error('El pedido interno no está disponible.'), { status: 404 });
  if (current.status !== 'draft') throw Object.assign(new Error('Un pedido interno activado no puede editarse.'), { status: 409 });
  const selectedIds = [...new Set(Array.isArray(input.quotationIds) ? input.quotationIds.map(String) : current.quotationIds || [current.quotationId])], quotations = (state['nexo-sales-quotations'] || []).filter(quotation => selectedIds.includes(String(quotation.id))), client = (state['nexo-clients'] || []).find(item => String(item.id) === String(current.clientId));
  if (!client) throw Object.assign(new Error('El cliente del pedido interno ya no está disponible.'), { status: 404 });
  validateInternalOrderQuotations(selectedIds, quotations, client, current.id);
  if (quotations.some(quotation => quotationIsExpired(quotation))) throw Object.assign(new Error('No puedes guardar el pedido con una cotización vencida. Genera una nueva versión vigente.'), { status: 409 });
  const items = normalizeInternalOrderItems(input.items, quotations, state['nexo-products'] || [], state['nexo-product-supplier-relations'] || []); if (!items.length) throw Object.assign(new Error('El pedido interno requiere al menos una partida.'), { status: 400 });
  const quantityVarianceAcknowledgement = validateInternalOrderQuantityAcknowledgement(items, input.quantityVarianceAcknowledgement, user), now = new Date().toISOString(), commercialTermsOverride = internalOrderPaymentOverride(input.commercialTermsOverride), financial = internalOrderFinancialSnapshot(items, quotations), next = { ...current, quotationIds: selectedIds, quotationId: selectedIds[0], sourceQuotations: quotations.map(quotation => ({ quotationId: quotation.id, status: 'converted', linkedAt: now })), commercialTerms: internalOrderTerms(quotations, new Date(now), commercialTermsOverride), commercialTermsOverride, ...financial, observations: String(input.observations || '').trim(), quantityVarianceAcknowledgement, updatedAt: now, timeline: [...(current.timeline || []), { status: 'draft', label: 'Pedido interno actualizado', at: now, by: user.name }, ...(quantityVarianceAcknowledgement ? [{ status: 'quantity_variance_confirmed', label: 'Diferencia de cantidades contra cotización confirmada', at: quantityVarianceAcknowledgement.confirmedAt, by: quantityVarianceAcknowledgement.confirmedBy, variances: quantityVarianceAcknowledgement.variances }] : [])] };
  const linkedQuotations = (state['nexo-sales-quotations'] || []).map(quotation => { const linkedId = quotation.internalOrderId || quotation.commercialOrderId, selected = selectedIds.includes(String(quotation.id)); if (String(linkedId || '') === String(current.id) && !selected) { const released = { ...quotation }; delete released.internalOrderId; delete released.commercialOrderId; delete released.convertedAt; return { ...released, statusHistory: [...(released.statusHistory || []), { status: 'conversion_released', at: now, by: user.name, reference: current.id }] }; } return selected ? { ...quotation, internalOrderId: current.id, commercialOrderId: current.id, convertedAt: quotation.convertedAt || now } : quotation; });
  await saveStates(db, [['nexo-commercial-orders', orders.map(order => String(order.id) === String(id) ? next : order)], ['nexo-sales-quotations', linkedQuotations]], user.name, user.id, workspace); return next;
}
async function activateInternalOrder(db, id, input, user, workspace = 'operational') {
  const state = await readStateKeys(db, ['nexo-sales-quotations', 'nexo-commercial-orders'], workspace), orders = Array.isArray(state['nexo-commercial-orders']) ? state['nexo-commercial-orders'] : [], current = orders.find(order => String(order.id) === String(id));
  if (!current || !userOwnsClient({ ownerId: current.ownerId, ownerName: current.ownerName }, user)) throw Object.assign(new Error('El pedido interno no está disponible.'), { status: 404 });
  if (current.status !== 'draft') throw Object.assign(new Error('El pedido interno ya fue activado.'), { status: 409 });
  const now = new Date().toISOString(), acceptance = input.acceptance && typeof input.acceptance === 'object' ? input.acceptance : null;
  if (!acceptance?.reference && !acceptance?.fileName) throw Object.assign(new Error('Registra una referencia o evidencia para activar el pedido interno.'), { status: 400 });
  const quotationIds = [...new Set((current.quotationIds || [current.quotationId]).filter(Boolean).map(String))], quotations = Array.isArray(state['nexo-sales-quotations']) ? state['nexo-sales-quotations'] : [];
  const sourceQuotations = quotations.filter(quotation => quotationIds.includes(String(quotation.id)));
  if (!quotationIds.length || sourceQuotations.length !== quotationIds.length) throw Object.assign(new Error('No se encontraron todas las cotizaciones origen del pedido interno.'), { status: 409 });
  if (sourceQuotations.some(quotation => quotationIsExpired(quotation))) throw Object.assign(new Error('No puedes activar el pedido porque una cotización origen ya venció. Genera una nueva versión vigente.'), { status: 409 });
  const lockReason = `Pedido interno ${current.id} activado y enviado a OC a proveedores.`, requiredQuotations = quotations.map(quotation => {
    if (!quotationIds.includes(String(quotation.id))) return quotation;
    return { ...quotation, status: 'required', locked: true, lockedAtISO: now, lockedBy: user.name, lockedReason: lockReason, requiredAtISO: now, requiredBy: user.name, internalOrderId: current.id, statusHistory: [...(quotation.statusHistory || []), { status: 'required', at: now, by: user.name, reason: lockReason, internalOrderId: current.id }] };
  });
  const financial = internalOrderFinancialSnapshot(current.items, sourceQuotations), next = { ...current, ...financial, status: 'active', acceptance, activatedAtISO: now, activatedBy: user.name, sourceQuotations: (current.sourceQuotations || []).map(source => quotationIds.includes(String(source.quotationId)) ? { ...source, status: 'required', requiredAtISO: now } : source), activatedSnapshot: { items: financial.items, totalsByCurrency: financial.totalsByCurrency, quotationIds: current.quotationIds, observations: current.observations }, timeline: [...(current.timeline || []), { status: 'active', label: 'Pedido interno activado; cotizaciones requeridas y bloqueadas', at: now, by: user.name }] };
  await transaction(db, async client => {
    await writeState(client, 'nexo-sales-quotations', requiredQuotations, user.name, user.id, workspace);
    await writeState(client, 'nexo-commercial-orders', orders.map(order => String(order.id) === String(id) ? next : order), user.name, user.id, workspace);
    if (workspace !== 'training') await rebuildMaterialized(client);
  });
  return next;
}
async function decideApproval(db, id, decision, reviewer) {
  if (!['approved', 'rejected'].includes(decision.status)) throw Object.assign(new Error('La decisión no es válida.'), { status: 400 });
  const reason = String(decision.reason || '').trim(); if (reason.length < 8) throw Object.assign(new Error('La decisión requiere una justificación de al menos 8 caracteres.'), { status: 400 });
  return transaction(db, async client => {
    const { rows } = await client.query('SELECT * FROM approval_requests WHERE id=$1', [id]); const approval = rows[0] && readApproval(rows[0]);
    if (!approval) throw Object.assign(new Error('La solicitud no existe.'), { status: 404 });
    if (approval.status !== 'pending') throw Object.assign(new Error('La solicitud ya fue resuelta.'), { status: 409 });
    if (String(approval.requested_by_id) === String(reviewer.id)) throw Object.assign(new Error('Quien solicita no puede aprobar su propia operación.'), { status: 403 });
    const reviewedAt = timestamp();
    await client.query('UPDATE approval_requests SET status=$2,reviewed_by_id=$3,reviewed_by_name=$4,reviewed_at=$5,decision_reason=$6 WHERE id=$1', [id, decision.status, reviewer.id, reviewer.name, reviewedAt, reason]);
    await appendLedger(client, { id: `LEDGER:${id}:${decision.status}`, eventType: `approval_${decision.status}`, entityType: approval.entity_type, entityId: approval.entity_id || id, actorId: reviewer.id, actorName: reviewer.name, detail: { approvalId: id, actionType: approval.action_type, reason } });
    return { ...approval, status: decision.status, reviewedById: reviewer.id, reviewedByName: reviewer.name, reviewedAt, decisionReason: reason };
  });
}

module.exports = { STATE_KEYS, openDatabase, readState, readStateKeys, stateEgressDiagnostics, saveState, saveStates, importSnapshot, resetOperationalData, emptyTrainingState, listResource, listAudit, rebuildMaterialized, createApproval, listApprovals, decideApproval, executiveDashboard, operationalAlerts, listClientQuotations, createInternalOrder, updateInternalOrder, activateInternalOrder };
