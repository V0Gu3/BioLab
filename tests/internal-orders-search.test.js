'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importSnapshot } = require('../server/db');
const { searchInternalOrderTargets } = require('../server/internal-orders-search');
const { createTestDatabase } = require('./helpers/postgres');

function state() {
  return {
    'nexo-clients': [
      { id: 'CLI-1', internalNumber: 'CLI-00125', name: 'Laboratorio Águila', contact: 'Juan Pérez', ownerId: 'USR-1', ownerName: 'Vendedora' },
      { id: 'CLI-2', internalNumber: 'CLI-00318', name: 'Laboratorio Águila Norte', contact: 'Otra persona', ownerId: 'USR-2', ownerName: 'Otro vendedor' }
    ],
    'nexo-products': [
      { id: 'PRO-1', number: 'CAT-4583', sku: 'SKU-4583', name: 'Reactivo A' },
      { id: 'PRO-2', number: 'CAT-4584', sku: 'SKU-4584', name: 'Reactivo B' }
    ],
    'nexo-commercial-orders': [
      { id: 'PI-001', clientId: 'CLI-1', client: 'Laboratorio Águila', ownerId: 'USR-1', seller: 'Vendedora' },
      { id: 'PI-002', clientId: 'CLI-2', client: 'Laboratorio Águila Norte', ownerId: 'USR-2', seller: 'Otro vendedor' }
    ],
    'nexo-order-operations-v1': {
      requisitions: [{ id: 'PI-001', clientOrderId: 'PI-001' }, { id: 'PI-002', clientOrderId: 'PI-002' }],
      orderLines: [{ id: 'LIN-1', requisitionId: 'PI-001', productId: 'PRO-1', catalog: 'CAT-4583' }, { id: 'LIN-2', requisitionId: 'PI-001', productId: 'PRO-1', catalog: 'CAT-4583' }, { id: 'LIN-3', requisitionId: 'PI-002', productId: 'PRO-2', catalog: 'CAT-4584' }]
    }
  };
}

test('encuentra clientes y productos de pedidos internos con normalización y cartera', async () => {
  const db = await createTestDatabase();
  try {
    await importSnapshot(db, state());
    const seller = { id: 'USR-1', name: 'Vendedora', role: 'seller' };
    const byClient = await searchInternalOrderTargets(db, seller, 'aguila');
    assert.deepEqual(byClient.clients.map(item => item.id), ['CLI-1']);
    assert.equal((await searchInternalOrderTargets(db, seller, 'juan perez')).clients[0].id, 'CLI-1');
    assert.equal((await searchInternalOrderTargets(db, seller, 'cli 00125')).clients[0].id, 'CLI-1');
    const byProduct = await searchInternalOrderTargets(db, seller, 'CAT 4583');
    assert.deepEqual(byProduct.products.map(item => item.id), ['PRO-1']);
    assert.equal((await searchInternalOrderTargets(db, seller, '458')).products[0].id, 'PRO-1');
    assert.equal((await searchInternalOrderTargets(db, seller, 'CAT-4584')).products.length, 0);
  } finally { await db.end(); }
});
