/**
 * lib/db-helpers.js
 * Reusable DB-layer business logic extracted from server.js.
 * Each function takes its DB connection explicitly (pool or conn) — no globals,
 * making them testable and decoupled from server.js module state.
 *
 * Dependencies: only `./mappings` (pure functions) + mysql2 pool/conn.
 */
const { snToInvType } = require('./mappings');

// Returns a map: invType -> { available, inUse, damaged, inRepair, transferred }
// from a single sn_registry query. Enriches inventory API responses with a status
// breakdown so the UI can show "总库存 (可用/在用/损坏/维修/调拨)" while keeping
// `quantity` (= available+inUse+damaged+inRepair, the total owned) unchanged for backward compat.
async function getInventoryBreakdowns(pool) {
  const [rows] = await pool.execute(
    'SELECT equipmentType, handType, status, COUNT(*) as cnt FROM sn_registry GROUP BY equipmentType, handType, status'
  );
  const map = {};
  const zero = () => ({ available: 0, inUse: 0, damaged: 0, inRepair: 0, transferred: 0 });
  for (const r of rows) {
    const invType = snToInvType(r.equipmentType, r.handType);
    if (!invType) continue;
    if (!map[invType]) map[invType] = zero();
    if (r.status === 'available') map[invType].available += r.cnt;
    else if (r.status === 'in_use') map[invType].inUse += r.cnt;
    else if (r.status === 'damaged') map[invType].damaged += r.cnt;
    else if (r.status === 'in_repair') map[invType].inRepair += r.cnt;
    else if (r.status === 'transferred') map[invType].transferred += r.cnt;
  }
  return map;
}

// Unified transaction writer: writes BOTH JSON data column (backward compat) AND
// structured columns (for indexes). Reuses the 9-column INSERT pattern already used
// by stocktaking/inbound/outbound.
// NOTE: caller must pass a valid conn or pool — no internal fallback (keeps it pure).
async function insertTransaction(conn, tx) {
  const id = tx.id || (`tx-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`);
  const data = { ...tx, id };
  // Map object fields to structured columns (prefer explicit, fall back to common alternative field names)
  const refType = tx.refType || tx.type || null;
  const refId = tx.refId || tx.relatedOrderId || null;
  const invType = tx.invType || snToInvType(tx.equipmentType, tx.handType) || tx.equipmentType || null;
  const direction = tx.direction || null;
  const quantity = tx.quantity != null ? parseInt(tx.quantity) : 0;
  const operator = tx.operator || tx.updatedBy || null;
  const createdAt = tx.timestamp || tx.createdAt || new Date().toISOString();
  await conn.execute(
    'INSERT INTO transactions (id, data, ref_type, ref_id, inv_type, direction, quantity, operator, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, JSON.stringify(data), refType, refId, invType, direction, quantity, operator, createdAt]
  );
  return id;
}

module.exports = { getInventoryBreakdowns, insertTransaction };
