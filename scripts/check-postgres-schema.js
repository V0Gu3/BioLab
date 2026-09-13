'use strict';

// Diagnóstico no destructivo para PostgreSQL/Supabase. openDatabase aplica el
// esquema idempotente antes de revisar su estructura.
const { openDatabase } = require('../server/db');

const expectedTables = [
  'app_state', 'users', 'user_credentials', 'user_sessions', 'products', 'suppliers',
  'product_supplier_relations', 'price_catalog_entries', 'movements', 'quotations',
  'quotation_items', 'client_orders', 'client_order_items', 'requisitions', 'order_lines',
  'supplier_orders', 'supplier_order_lines', 'supplier_invoices', 'receipts',
  'customer_invoices', 'shipments', 'price_loads', 'fx_records', 'documents', 'audit_events'
];

const expectedForeignKeys = [
  ['user_credentials', 'users'], ['user_sessions', 'users'],
  ['product_supplier_relations', 'products'], ['product_supplier_relations', 'suppliers'],
  ['quotation_items', 'quotations'], ['client_order_items', 'client_orders']
];

async function main() {
  const db = await openDatabase();
  try {
    const { rows: tableRows } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    const tables = new Set(tableRows.map(row => row.table_name));
    const missingTables = expectedTables.filter(table => !tables.has(table));
    const { rows: foreignKeys } = await db.query("SELECT tc.table_name, ccu.table_name AS referenced_table FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'");
    const relations = new Set(foreignKeys.map(row => `${row.table_name}->${row.referenced_table}`));
    const missingRelations = expectedForeignKeys.filter(([from, to]) => !relations.has(`${from}->${to}`)).map(([from, to]) => `${from}->${to}`);
    const { rows: indexRows } = await db.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'");
    const { rows: sessions } = await db.query('SELECT COUNT(*)::int AS active_sessions FROM user_sessions WHERE expires_at > $1', [new Date().toISOString()]);
    const report = {
      ok: missingTables.length === 0 && missingRelations.length === 0,
      tables: expectedTables.length,
      missingTables,
      missingRelations,
      indexes: indexRows.map(row => row.indexname).sort(),
      activeSessions: Number(sessions[0].active_sessions)
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch(error => { console.error(`No fue posible validar PostgreSQL: ${error.message}`); process.exitCode = 1; });
