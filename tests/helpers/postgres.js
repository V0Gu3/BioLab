const { newDb } = require('pg-mem');
const { openDatabase } = require('../../server/db');

async function createTestDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg(), pool = new adapter.Pool();
  await openDatabase({ pool });
  return pool;
}

module.exports = { createTestDatabase };
