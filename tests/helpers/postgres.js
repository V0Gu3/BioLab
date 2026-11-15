const { newDb } = require('pg-mem');
const { openDatabase } = require('../../server/db');

async function createTestDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'octet_length', args: ['text'], returns: 'integer', implementation: value => Buffer.byteLength(String(value || '')) });
  const adapter = memory.adapters.createPg(), pool = new adapter.Pool();
  await openDatabase({ pool });
  return pool;
}

module.exports = { createTestDatabase };
