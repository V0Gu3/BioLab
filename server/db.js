'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const STATE_KEYS = Object.freeze([
  'nexo-access-v1', 'nexo-products', 'nexo-suppliers', 'nexo-clients', 'nexo-movements', 'nexo-price-loads', 'nexo-price-catalog-entries', 'nexo-product-supplier-relations', 'nexo-purchase-orders',
  'nexo-sales-quotations', 'nexo-commercial-orders', 'nexo-quotation-sequences', 'nexo-order-operations-v1', 'nexo-fx-v1'
]);
const ROOT = path.resolve(__dirname, '..');
const number = input => Number.isFinite(Number(input)) ? Number(input) : 0;
const value = (item, ...keys) => keys.map(key => item?.[key]).find(candidate => candidate !== undefined && candidate !== null && candidate !== '') ?? null;
const timestamp = () => new Date().toISOString();
const parseJson = input => typeof input === 'string' ? JSON.parse(input) : input;
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
  const pool = options.pool || new Pool({ connectionString, max: Number(process.env.BIO_DB_POOL_SIZE || 10), ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return pool;
}

async function readState(db) {
  const { rows } = await db.query('SELECT state_key, payload_json FROM app_state');
  return Object.fromEntries(rows.map(row => [row.state_key, parseJson(row.payload_json)]));
}

async function insert(db, table, row) {
  const columns = Object.keys(row), placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
  const jsonColumns = new Set(['payload_json', 'before_json', 'after_json', 'detail_json', 'currencies']);
  await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, columns.map(column => jsonColumns.has(column) && row[column] != null ? JSON.stringify(row[column]) : row[column]));
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
  const state = await readState(db), updated = timestamp();
  const materializedTables = ['quotation_items', 'client_order_items', 'supplier_order_lines', 'documents', 'audit_events', 'movements', 'order_lines', 'supplier_invoices', 'receipts', 'customer_invoices', 'shipments', 'supplier_orders', 'requisitions', 'client_orders', 'quotations', 'price_loads', 'price_catalog_entries', 'product_supplier_relations', 'fx_records', 'products', 'suppliers'];
  for (const table of materializedTables) await db.query(`DELETE FROM ${table}`);
  const put = (table, row) => insert(db, table, row);

  const access = state['nexo-access-v1'] || {};
  for (const item of access.users || []) await db.query('INSERT INTO users(id,name,email,role,status,payload_json,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,role=EXCLUDED.role,status=EXCLUDED.status,payload_json=EXCLUDED.payload_json,updated_at=EXCLUDED.updated_at', [String(item.id), String(item.name || ''), String(item.email || ''), String(item.role || 'seller'), String(item.status || 'active'), JSON.stringify(item), item.updatedAt || item.createdAt || updated]);
  for (const [index, item] of (access.audit || []).entries()) await put('audit_events', auditRow('nexo-access-v1', 'access', item, index));

  for (const item of state['nexo-products'] || []) await put('products', { id: String(value(item, 'id', 'sku', 'number')), sku: value(item, 'sku'), product_number: value(item, 'number', 'productNumber'), name: String(value(item, 'name', 'description') || 'Sin nombre'), supplier_id: value(item, 'supplierId'), unit: value(item, 'unit'), currency: String(value(item, 'currency', 'priceCurrency') || 'MXN'), price: number(item.price), warehouse_1: number(value(item, 'a1', 'warehouse1')), warehouse_2: number(value(item, 'a2', 'warehouse2')), payload_json: item, updated_at: updated });
  for (const item of state['nexo-suppliers'] || []) await put('suppliers', { id: String(value(item, 'id', 'code')), code: value(item, 'code'), name: String(value(item, 'name', 'businessName') || 'Sin nombre'), email: value(item, 'email'), phone: value(item, 'phone'), payload_json: item, updated_at: updated });
  for (const item of state['nexo-product-supplier-relations'] || []) await put('product_supplier_relations', { id: String(item.id), product_id: String(item.productId), supplier_id: String(item.supplierId), supplier_sku: String(item.supplierSku), supplier_description: value(item, 'supplierDescription'), purchase_unit: value(item, 'purchaseUnit'), purchase_price: number(item.purchasePrice), currency: String(item.currency || 'MXN'), lead_time_days: number(item.leadTimeDays), minimum_order_quantity: number(item.minimumOrderQuantity), is_active: item.active !== false, is_preferred: Boolean(item.preferred), valid_from: value(item, 'validFrom'), valid_to: value(item, 'validTo'), created_by: value(item, 'createdBy'), created_at: value(item, 'createdAt') || updated, updated_by: value(item, 'updatedBy'), payload_json: item, updated_at: value(item, 'updatedAt') || updated });
  for (const item of state['nexo-price-catalog-entries'] || []) await put('price_catalog_entries', { id: String(item.id), supplier_id: String(item.supplierId), product_id: value(item, 'linkedProductId'), relation_id: value(item, 'supplierRelationId'), supplier_sku: value(item, 'code'), description: value(item, 'description'), purchase_unit: value(item, 'unit'), purchase_price: number(item.price), currency: String(item.currency || 'MXN'), batch_id: value(item, 'batchId'), is_current: item.isCurrent !== false, payload_json: item, updated_at: updated });
  for (const [index, item] of (state['nexo-movements'] || []).entries()) await put('movements', { id: String(value(item, 'id') || `MOV-${index}`), movement_type: String(value(item, 'type') || 'movimiento'), product_id: value(item, 'productId'), reference: value(item, 'reference', 'detail'), quantity: number(value(item, 'quantity', 'qty')), warehouse_id: value(item, 'warehouseId', 'warehouse'), occurred_at: value(item, 'createdAt', 'at', 'time'), user_name: value(item, 'user', 'createdBy'), payload_json: item, updated_at: updated });

  for (const item of state['nexo-price-loads'] || []) { await put('price_loads', { id: String(item.id), supplier_id: value(item, 'supplierId'), supplier_name: value(item, 'supplierName'), file_name: value(item, 'fileName'), file_hash: value(item, 'fileHash'), currencies: item.currencies || [], applied_at: value(item, 'appliedAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-price-loads', 'price_list_load', item, 'price_load', item.supplierId)); }
  for (const item of state['nexo-purchase-orders'] || []) await put('documents', documentRow('nexo-purchase-orders', 'internal_purchase_order', item, 'purchase_order', item.movementId));

  for (const item of state['nexo-sales-quotations'] || []) {
    await put('quotations', { id: String(item.id), client_name: value(item, 'client'), status: value(item, 'status'), currency: documentCurrency(item), subtotal: number(item.subtotal), tax_amount: number(item.taxAmount), total: number(item.total), created_at: value(item, 'createdAtISO', 'createdAt'), created_by: value(item, 'createdBy', 'seller'), payload_json: item, updated_at: updated });
    for (const [index, line] of (item.items || []).entries()) await put('quotation_items', { quotation_id: String(item.id), line_no: index + 1, product_id: value(line, 'productId'), sku: value(line, 'sku', 'number'), description: value(line, 'name', 'description'), quantity: number(line.quantity), unit_price: number(line.unitPrice), total: number(value(line, 'lineTotal', 'total')), payload_json: line });
    await put('documents', documentRow('nexo-sales-quotations', 'quotation', item, 'quotation', item.commercialOrderId));
  }
  for (const item of state['nexo-commercial-orders'] || []) {
    await put('client_orders', { id: String(item.id), quotation_id: value(item, 'quotationId'), client_name: value(item, 'client'), status: value(item, 'status'), currency: documentCurrency(item), total: number(item.total), created_at: value(item, 'createdAtISO', 'createdAt'), payload_json: item, updated_at: updated });
    for (const [index, line] of (item.items || []).entries()) await put('client_order_items', { client_order_id: String(item.id), line_no: index + 1, product_id: value(line, 'productId'), sku: value(line, 'sku', 'number'), description: value(line, 'name', 'description'), quantity: number(line.quantity), payload_json: line });
    await put('documents', documentRow('nexo-commercial-orders', 'client_order', item, 'client_order', item.quotationId));
  }

  const operations = state['nexo-order-operations-v1'] || {};
  for (const item of operations.requisitions || []) await put('requisitions', { id: String(item.id), quotation_id: value(item, 'quotationId'), client_order_id: value(item, 'clientOrderId'), customer_name: value(item, 'customerName'), status: value(item, 'status'), request_date: value(item, 'requestDate'), responsible: value(item, 'responsible'), payload_json: item, updated_at: value(item, 'updatedAt', 'createdAt') || updated });
  for (const item of operations.orderLines || []) await put('order_lines', { id: String(item.id), requisition_id: String(item.requisitionId), product_id: value(item, 'productId'), sku: value(item, 'catalog', 'sku'), description: value(item, 'description'), requested: number(item.quantityRequested), purchased: number(item.quantityPurchased), received: number(item.quantityReceived), delivered: number(item.quantityDelivered), cancelled: number(item.quantityCancelled), status: value(item, 'status'), payload_json: item, updated_at: updated });
  for (const item of operations.supplierOrders || []) { await put('supplier_orders', { id: String(item.id), client_order_id: value(item, 'clientOrderId'), quotation_id: value(item, 'quotationId'), supplier_id: value(item, 'supplierId'), supplier_name: value(item, 'supplierName'), status: value(item, 'status'), currency: String(value(item, 'currency') || 'MXN'), total: number(item.total), created_at: value(item, 'createdAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'supplier_order', item, 'supplier_order', item.clientOrderId)); }
  for (const item of operations.supplierOrderLines || []) await put('supplier_order_lines', { id: String(item.id), supplier_order_id: String(item.supplierOrderId), requisition_id: value(item, 'requisitionId'), order_line_id: value(item, 'orderLineId'), quantity: number(item.quantity), unit_price: number(item.unitPrice), payload_json: item, updated_at: updated });
  for (const item of operations.supplierInvoices || []) { await put('supplier_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), supplier_name: value(item, 'supplierName'), currency: String(value(item, 'currency') || 'MXN'), amount_original: number(value(item, 'amountOriginal', 'amount')), exchange_rate: number(item.exchangeRate), total_mxn: number(item.totalMXN), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'supplier_invoice', item, 'supplier_invoice', (item.supplierOrderIds || [])[0])); }
  for (const item of operations.receipts || []) { await put('receipts', { id: String(item.id), supplier_order_id: value(item, 'supplierOrderId'), requisition_id: value(item, 'requisitionId'), receipt_type: value(item, 'type'), receipt_date: value(item, 'date'), user_name: value(item, 'user'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'receipt', item, 'receipt', item.supplierOrderId)); }
  for (const item of operations.inventoryMovements || []) await put('movements', { id: String(item.id), movement_type: String(value(item, 'type') || 'movimiento'), product_id: value(item, 'productId'), reference: value(item, 'sourceDocumentId', 'requisitionId'), quantity: number(item.quantity), warehouse_id: value(item, 'warehouseId'), occurred_at: value(item, 'at'), user_name: value(item, 'user'), payload_json: item, updated_at: updated });
  for (const item of operations.customerInvoices || []) { await put('customer_invoices', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: value(item, 'requisitionId'), invoice_type: value(item, 'type'), currency: String(value(item, 'currency') || 'MXN'), amount: number(item.amount), invoice_date: value(item, 'date'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'customer_invoice', item, 'customer_invoice', item.requisitionId)); }
  for (const item of operations.shipments || []) { await put('shipments', { id: String(value(item, 'id', 'folio')), folio: value(item, 'folio', 'id'), requisition_id: value(item, 'requisitionId'), shipment_type: value(item, 'type'), shipment_date: value(item, 'date'), delivered_at: value(item, 'deliveredAt'), payload_json: item, updated_at: updated }); await put('documents', documentRow('nexo-order-operations-v1', 'shipment', item, 'shipment', item.requisitionId)); }
  for (const [index, item] of (operations.auditLog || []).entries()) await put('audit_events', auditRow('nexo-order-operations-v1', 'operation', item, index));

  const fx = state['nexo-fx-v1'] || {};
  for (const [index, item] of (fx.records || []).entries()) await put('fx_records', { id: String(value(item, 'id') || `FX-${index}`), rate_date: value(item, 'rateDate', 'date'), source: value(item, 'source'), method: value(item, 'method'), usd: number(item.rates?.USD ?? item.USD), cad: number(item.rates?.CAD ?? item.CAD), eur: number(item.rates?.EUR ?? item.EUR), payload_json: item, updated_at: updated });
  for (const [index, item] of (fx.audit || []).entries()) await put('audit_events', auditRow('nexo-fx-v1', 'currency', item, index));
}

async function transaction(db, task) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try { await client.query('BEGIN'); const result = await task(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release?.(); }
}

async function saveState(db, stateKey, payload, actor = 'Sistema') {
  if (!STATE_KEYS.includes(stateKey)) throw new Error(`Estado no permitido: ${stateKey}`);
  if (stateKey === 'nexo-fx-v1') validateFxState(payload);
  return transaction(db, async client => {
    const updated = timestamp(), result = await client.query(`INSERT INTO app_state(state_key,payload_json,revision,updated_at,updated_by) VALUES($1,$2,1,$3,$4) ON CONFLICT(state_key) DO UPDATE SET payload_json=EXCLUDED.payload_json,revision=app_state.revision+1,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by RETURNING state_key,revision,updated_at,updated_by`, [stateKey, JSON.stringify(payload), updated, actor]);
    await rebuildMaterialized(client); return result.rows[0];
  });
}

async function importSnapshot(db, snapshot, actor = 'Migración local') {
  return transaction(db, async client => {
    const entries = Object.entries(snapshot || {}).filter(([key]) => STATE_KEYS.includes(key));
    for (const [key, payload] of entries) await client.query(`INSERT INTO app_state(state_key,payload_json,revision,updated_at,updated_by) VALUES($1,$2,1,$3,$4) ON CONFLICT(state_key) DO UPDATE SET payload_json=EXCLUDED.payload_json,revision=app_state.revision+1,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`, [key, JSON.stringify(payload), timestamp(), actor]);
    await rebuildMaterialized(client); return { imported: entries.length };
  });
}

async function listResource(db, resource) {
  const tables = { products: 'products', suppliers: 'suppliers', movements: 'movements', quotations: 'quotations', 'client-orders': 'client_orders', requisitions: 'requisitions', 'supplier-orders': 'supplier_orders', receipts: 'receipts', shipments: 'shipments', documents: 'documents' };
  const table = tables[resource]; if (!table) return null;
  const { rows } = await db.query(`SELECT payload_json FROM ${table} ORDER BY updated_at DESC`); return rows.map(row => parseJson(row.payload_json));
}

async function listAudit(db, limit = 500) {
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500)), { rows } = await db.query('SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT $1', [safeLimit]);
  return rows.map(row => ({ ...row, before: parseJson(row.before_json), after: parseJson(row.after_json), detail: parseJson(row.detail_json) }));
}

module.exports = { STATE_KEYS, openDatabase, readState, saveState, importSnapshot, listResource, listAudit, rebuildMaterialized };
