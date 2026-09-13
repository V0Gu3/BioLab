(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioSupplierRelations = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const token = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const active = record => { if (!record || record.active === false || ['inactive', 'disabled', 'deleted'].includes(String(record.status || '').toLowerCase())) return false; const now = Date.now(), from = record.validFrom ? Date.parse(record.validFrom) : null, to = record.validTo ? Date.parse(record.validTo) : null; return !(Number.isFinite(from) && from > now) && !(Number.isFinite(to) && to < now); };
  const hash = value => {
    let result = 2166136261;
    for (const char of String(value)) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(36).toUpperCase();
  };
  const relationKey = relation => [relation.productId, relation.supplierId, token(relation.supplierSku)].map(String).join('|');
  const relationId = ({ productId, supplierId, supplierSku }) => `PSR-${hash(`${productId}|${supplierId}|${token(supplierSku)}`)}`;
  const productMatches = (products, value) => {
    const expected = token(value);
    if (!expected) return [];
    return products.filter(product => [product.id, product.number, product.sku, product.productNumber].some(candidate => token(candidate) === expected));
  };
  const normalizeRelation = (relation, now = new Date().toISOString()) => ({
    id: clean(relation.id) || relationId(relation),
    productId: relation.productId,
    supplierId: clean(relation.supplierId),
    supplierSku: clean(relation.supplierSku || relation.supplierCode),
    supplierDescription: clean(relation.supplierDescription || relation.description),
    purchaseUnit: clean(relation.purchaseUnit || relation.unit) || 'unidad',
    purchasePrice: number(relation.purchasePrice ?? relation.price),
    currency: clean(relation.currency || relation.priceCurrency || 'MXN').toUpperCase(),
    leadTimeDays: Math.max(0, number(relation.leadTimeDays)),
    minimumOrderQuantity: Math.max(0, number(relation.minimumOrderQuantity || 1)) || 1,
    active: relation.active !== false,
    preferred: Boolean(relation.preferred),
    validFrom: relation.validFrom || null,
    validTo: relation.validTo || null,
    source: clean(relation.source || 'manual'),
    sourceBatchId: relation.sourceBatchId || null,
    createdBy: clean(relation.createdBy || 'Sistema'),
    createdAt: relation.createdAt || now,
    updatedBy: clean(relation.updatedBy || relation.createdBy || 'Sistema'),
    updatedAt: relation.updatedAt || now,
  });

  function upsert(relations, candidate, actor = 'Sistema', now = new Date().toISOString()) {
    const normalized = normalizeRelation({ ...candidate, createdBy: candidate.createdBy || actor, updatedBy: actor, updatedAt: now }, now);
    if (!normalized.productId || !normalized.supplierId || !normalized.supplierSku) throw new Error('La relación requiere producto, proveedor y SKU del proveedor.');
    const existing = relations.find(item => item.id === normalized.id || relationKey(item) === relationKey(normalized));
    if (existing) {
      if (normalized.preferred) relations.forEach(item => { if (String(item.productId) === String(normalized.productId) && item !== existing) item.preferred = false; });
      Object.assign(existing, normalized, { id: existing.id, createdAt: existing.createdAt, createdBy: existing.createdBy });
      return { relation: existing, action: 'updated' };
    }
    if (normalized.preferred) relations.forEach(item => { if (String(item.productId) === String(normalized.productId)) item.preferred = false; });
    relations.push(normalized);
    return { relation: normalized, action: 'created' };
  }

  function migrate({ products = [], suppliers = [], priceEntries = [], relations = [], actor = 'Migración de relaciones', now = new Date().toISOString() }) {
    const nextRelations = relations.map(item => normalizeRelation(item, now));
    const nextEntries = priceEntries.map(item => ({ ...item }));
    const report = [];
    products.forEach(product => {
      if (!product.supplierId || !suppliers.some(item => String(item.id) === String(product.supplierId))) return;
      const supplierSku = product.supplierSku || product.sku || product.number;
      if (!clean(supplierSku)) return;
      const key = relationKey({ productId: product.id, supplierId: product.supplierId, supplierSku }), prior = nextRelations.find(item => relationKey(item) === key), hasPreferred = nextRelations.some(item => String(item.productId) === String(product.id) && item.preferred);
      const result = upsert(nextRelations, { productId: product.id, supplierId: product.supplierId, supplierSku, supplierDescription: product.name, purchaseUnit: product.unit, purchasePrice: product.price, currency: product.priceCurrency, active: true, preferred: prior ? prior.preferred : !hasPreferred, source: prior?.source || 'legacy_product' }, actor, now);
      report.push({ source: 'product', sourceId: product.id, productId: product.id, supplierId: product.supplierId, status: result.action });
    });
    [...nextEntries].sort((a, b) => Number(a.isCurrent !== false) - Number(b.isCurrent !== false)).forEach(entry => {
      const supplier = suppliers.find(item => String(item.id) === String(entry.supplierId));
      if (!supplier) { report.push({ source: 'price_entry', sourceId: entry.id, status: 'rejected', reason: 'Proveedor inexistente' }); return; }
      let matches = entry.linkedProductId ? products.filter(item => String(item.id) === String(entry.linkedProductId)) : productMatches(products, entry.code);
      if (matches.length !== 1) { report.push({ source: 'price_entry', sourceId: entry.id, supplierId: entry.supplierId, status: matches.length > 1 ? 'manual_review' : 'unlinked', reason: matches.length > 1 ? 'Coincidencia ambigua' : 'Producto interno inexistente' }); return; }
      const product = matches[0];
      const key = relationKey({ productId: product.id, supplierId: entry.supplierId, supplierSku: entry.code }), prior = nextRelations.find(item => relationKey(item) === key), hasPreferred = nextRelations.some(item => String(item.productId) === String(product.id) && item.preferred);
      const result = upsert(nextRelations, { productId: product.id, supplierId: entry.supplierId, supplierSku: entry.code, supplierDescription: entry.description || product.name, purchaseUnit: entry.unit || product.unit, purchasePrice: entry.price, currency: entry.currency, active: entry.isCurrent !== false, preferred: prior ? prior.preferred : (!hasPreferred && product.supplierId ? String(product.supplierId) === String(entry.supplierId) : false), validFrom: entry.appliedAt || null, source: prior?.source || 'price_import', sourceBatchId: entry.batchId }, actor, now);
      entry.linkedProductId = product.id; entry.supplierRelationId = result.relation.id;
      report.push({ source: 'price_entry', sourceId: entry.id, productId: product.id, supplierId: entry.supplierId, relationId: result.relation.id, status: result.action });
    });
    return { relations: nextRelations, priceEntries: nextEntries, report };
  }

  function resolve({ line = {}, products = [], suppliers = [], relations = [] }) {
    let product = products.find(item => String(item.id) === String(line.productId));
    if (!product) {
      const matches = productMatches(products, line.catalog || line.sku || line.number);
      if (matches.length === 1) product = matches[0];
      else return { product: null, supplier: null, relation: null, valid: false, reasonCode: matches.length > 1 ? 'AMBIGUOUS_PRODUCT' : 'PRODUCT_NOT_FOUND', reason: matches.length > 1 ? 'El código coincide con más de un producto interno.' : 'No existe un producto interno relacionado.' };
    }
    let candidates = relations.filter(item => String(item.productId) === String(product.id));
    if (line.supplierRelationId) candidates = candidates.filter(item => String(item.id) === String(line.supplierRelationId));
    if (line.supplierId) candidates = candidates.filter(item => String(item.supplierId) === String(line.supplierId));
    if (!line.supplierRelationId && !line.supplierId && line.catalog) {
      const bySku = candidates.filter(item => token(item.supplierSku) === token(line.catalog));
      if (bySku.length) candidates = bySku;
    }
    if (!candidates.length) return { product, supplier: null, relation: null, valid: false, reasonCode: 'RELATION_NOT_FOUND', reason: 'El producto no tiene relación persistente con el proveedor esperado.' };
    const enabled = candidates.filter(active);
    if (!enabled.length) return { product, supplier: null, relation: candidates[0], valid: false, reasonCode: 'RELATION_INACTIVE', reason: 'La relación producto–proveedor está inactiva o fuera de vigencia.' };
    const preferred = enabled.filter(item => item.preferred);
    const relation = preferred.length === 1 ? preferred[0] : enabled.length === 1 ? enabled[0] : null;
    if (!relation) return { product, supplier: null, relation: null, valid: false, reasonCode: 'AMBIGUOUS_RELATION', reason: 'Hay varias relaciones activas; selecciona el proveedor para esta partida.' };
    const supplier = suppliers.find(item => String(item.id) === String(relation.supplierId));
    if (!supplier) return { product, supplier: null, relation, valid: false, reasonCode: 'SUPPLIER_NOT_FOUND', reason: 'El proveedor relacionado ya no existe.' };
    if (!active(supplier)) return { product, supplier, relation, valid: false, reasonCode: 'SUPPLIER_INACTIVE', reason: 'El proveedor relacionado está inactivo.' };
    return { product, supplier, relation, valid: true, reasonCode: 'OK', reason: 'Relación válida.' };
  }

  return { active, clean, token, relationId, relationKey, productMatches, normalizeRelation, upsert, migrate, resolve };
});
