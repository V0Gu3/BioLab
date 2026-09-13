CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  payload_json JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'Sistema'
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('administrator','auditor','supervisor','seller')),
  status TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(LOWER(email));

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT, product_number TEXT, name TEXT NOT NULL, supplier_id TEXT, unit TEXT, currency TEXT,
  price NUMERIC(18,6) NOT NULL DEFAULT 0, warehouse_1 NUMERIC(18,6) NOT NULL DEFAULT 0, warehouse_2 NUMERIC(18,6) NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_search ON products(LOWER(sku), LOWER(product_number), LOWER(name));

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, email TEXT, phone TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(LOWER(name));

CREATE TABLE IF NOT EXISTS product_supplier_relations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  supplier_sku TEXT NOT NULL,
  supplier_description TEXT,
  purchase_unit TEXT,
  purchase_price NUMERIC(18,6) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'MXN',
  lead_time_days NUMERIC(18,6) NOT NULL DEFAULT 0,
  minimum_order_quantity NUMERIC(18,6) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_preferred BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from TEXT,
  valid_to TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(product_id, supplier_id, supplier_sku)
);
CREATE INDEX IF NOT EXISTS idx_product_supplier_product ON product_supplier_relations(product_id, is_active);
CREATE INDEX IF NOT EXISTS idx_product_supplier_supplier ON product_supplier_relations(supplier_id, is_active);

CREATE TABLE IF NOT EXISTS price_catalog_entries (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  product_id TEXT,
  relation_id TEXT,
  supplier_sku TEXT NOT NULL,
  description TEXT,
  purchase_unit TEXT,
  purchase_price NUMERIC(18,6) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'MXN',
  batch_id TEXT,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_catalog_supplier ON price_catalog_entries(supplier_id, is_current);
CREATE INDEX IF NOT EXISTS idx_price_catalog_relation ON price_catalog_entries(relation_id);

CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY, movement_type TEXT NOT NULL, product_id TEXT, reference TEXT, quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
  warehouse_id TEXT, occurred_at TEXT, user_name TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_reference ON movements(reference, occurred_at);

CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY, client_name TEXT, status TEXT, currency TEXT, subtotal NUMERIC(18,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,6) NOT NULL DEFAULT 0, total NUMERIC(18,6) NOT NULL DEFAULT 0, created_at TEXT, created_by TEXT,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS quotation_items (
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, product_id TEXT, sku TEXT,
  description TEXT, quantity NUMERIC(18,6) NOT NULL DEFAULT 0, unit_price NUMERIC(18,6) NOT NULL DEFAULT 0,
  total NUMERIC(18,6) NOT NULL DEFAULT 0, payload_json JSONB NOT NULL, PRIMARY KEY (quotation_id, line_no)
);

CREATE TABLE IF NOT EXISTS client_orders (
  id TEXT PRIMARY KEY, quotation_id TEXT, client_name TEXT, status TEXT, currency TEXT, total NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS client_order_items (
  client_order_id TEXT NOT NULL REFERENCES client_orders(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, product_id TEXT, sku TEXT,
  description TEXT, quantity NUMERIC(18,6) NOT NULL DEFAULT 0, payload_json JSONB NOT NULL, PRIMARY KEY (client_order_id, line_no)
);

CREATE TABLE IF NOT EXISTS requisitions (
  id TEXT PRIMARY KEY, quotation_id TEXT, client_order_id TEXT, customer_name TEXT, status TEXT, request_date TEXT, responsible TEXT,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY, requisition_id TEXT NOT NULL, product_id TEXT, sku TEXT, description TEXT,
  requested NUMERIC(18,6) NOT NULL DEFAULT 0, purchased NUMERIC(18,6) NOT NULL DEFAULT 0,
  received NUMERIC(18,6) NOT NULL DEFAULT 0, delivered NUMERIC(18,6) NOT NULL DEFAULT 0,
  cancelled NUMERIC(18,6) NOT NULL DEFAULT 0, status TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_orders (
  id TEXT PRIMARY KEY, client_order_id TEXT, quotation_id TEXT, supplier_id TEXT, supplier_name TEXT, status TEXT, currency TEXT,
  total NUMERIC(18,6) NOT NULL DEFAULT 0, created_at TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_order_lines (
  id TEXT PRIMARY KEY, supplier_order_id TEXT NOT NULL, requisition_id TEXT, order_line_id TEXT,
  quantity NUMERIC(18,6) NOT NULL DEFAULT 0, unit_price NUMERIC(18,6) NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY, folio TEXT, supplier_name TEXT, currency TEXT, amount_original NUMERIC(18,6) NOT NULL DEFAULT 0,
  exchange_rate NUMERIC(18,6), total_mxn NUMERIC(18,6), invoice_date TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, supplier_order_id TEXT, requisition_id TEXT, receipt_type TEXT, receipt_date TEXT, user_name TEXT,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_invoices (
  id TEXT PRIMARY KEY, folio TEXT, requisition_id TEXT, invoice_type TEXT, currency TEXT, amount NUMERIC(18,6) NOT NULL DEFAULT 0,
  invoice_date TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, folio TEXT, requisition_id TEXT, shipment_type TEXT, shipment_date TEXT, delivered_at TEXT,
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS price_loads (
  id TEXT PRIMARY KEY, supplier_id TEXT, supplier_name TEXT, file_name TEXT, file_hash TEXT, currencies JSONB,
  applied_at TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS fx_records (
  id TEXT PRIMARY KEY, rate_date TEXT, source TEXT, method TEXT, usd NUMERIC(18,6), cad NUMERIC(18,6), eur NUMERIC(18,6),
  payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL, document_type TEXT NOT NULL, folio TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, related_id TEXT, status TEXT, issued_at TEXT, payload_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_folio ON documents(folio);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
  reference TEXT, actor_id TEXT, actor_name TEXT, before_json JSONB, after_json JSONB, detail_json JSONB NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT (version) DO NOTHING;
