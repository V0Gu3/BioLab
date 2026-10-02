'use strict';

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 96);

function scopeFor(user, alias = 'co', offset = 1) {
  if (user?.role !== 'seller') return { sql: '', params: [] };
  const id = String(user.id || ''), name = String(user.name || '').trim().toLowerCase();
  return {
    sql: ` AND (${alias}.owner_id = $${offset} OR (coalesce(${alias}.owner_id, '') = '' AND (lower(coalesce(${alias}.owner_name, '')) = $${offset + 1} OR lower(coalesce(${alias}.seller, '')) = $${offset + 1} OR lower(coalesce(${alias}.created_by, '')) = $${offset + 1})))`,
    params: [id, name]
  };
}

async function searchInternalOrderTargets(db, user, input, limit = 6) {
  const term = normalize(input);
  if (!term) return { clients: [], products: [] };
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 6));
  const clientScope = scopeFor(user, 'co', 2), productScope = scopeFor(user, 'co', 2);
  const clients = await db.query(`
    SELECT c.id, c.internal_number, c.name, c.contact
      FROM clients c
      JOIN client_orders co ON co.client_id = c.id
      JOIN requisitions r ON r.client_order_id = co.id
     WHERE c.search_key LIKE '%' || $1 || '%'${clientScope.sql}
     GROUP BY c.id, c.internal_number, c.name, c.contact, c.search_key
     ORDER BY CASE WHEN c.search_key = $1 THEN 0 ELSE 1 END, c.name ASC
     LIMIT $${clientScope.params.length + 2}
  `, [term, ...clientScope.params, safeLimit]);
  const products = await db.query(`
    SELECT p.id, p.product_number, p.sku, p.name
      FROM products p
      JOIN order_lines line ON line.product_id = p.id
      JOIN requisitions r ON r.id = line.requisition_id
      JOIN client_orders co ON co.id = r.client_order_id
     WHERE p.search_key LIKE '%' || $1 || '%'${productScope.sql}
     GROUP BY p.id, p.product_number, p.sku, p.name, p.search_key
     ORDER BY CASE WHEN p.search_key = $1 THEN 0 ELSE 1 END, p.name ASC
     LIMIT $${productScope.params.length + 2}
  `, [term, ...productScope.params, safeLimit]);
  return {
    clients: clients.rows.map(row => ({ id: row.id, number: row.internal_number || '', name: row.name, contact: row.contact || '' })),
    products: products.rows.map(row => ({ id: row.id, number: row.product_number || '', sku: row.sku || '', name: row.name }))
  };
}

module.exports = { searchInternalOrderTargets, normalize };
