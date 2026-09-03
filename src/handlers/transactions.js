/**
 * src/handlers/transactions.js
 * Transaction-domain HTTP handlers — extracted from server.js (Phase 2.1 step3).
 *
 * Same factory / dependency-injection pattern as auth/users. Handler bodies
 * are copied verbatim; the factory scope destructures deps so bare identifiers
 * (pool / _insertTransaction / readJSONArray / ...) resolve to the injected
 * values.
 *
 * Handlers in this domain (URL → handler):
 *   GET    /api/transactions         → handleGetTransactions
 *   POST   /api/transactions         → handleAddTransaction
 *   DELETE /api/transactions/:id      → handleDeleteTransaction
 *
 * Deps: pool, _insertTransaction (lib/db-helpers alias), readJSONArray,
 * readJSONById, deleteJSON (inline JSON file helpers in server.js), sendJSON,
 * broadcastSSE.
 *
 * Note on mixed storage: transactions are double-written — structured columns
 * in MySQL (for indexed ref_type/ref_id/inv_type queries) AND a JSON blob in
 * the `data` column / transactions.json file (legacy read path). handleGetTrans-
 * actions uses pool.query when filtering by ref/inv type, else reads the JSON
 * file. handleDeleteTransaction deletes from the JSON file only (legacy).
 */
'use strict';

const { requireAdmin } = require('./_permissions');

module.exports = function createTransactionsHandlers(deps) {
  const {
    pool,
    _insertTransaction,
    readJSONArray,
    readJSONById,
    deleteJSON,
    sendJSON,
    broadcastSSE,
  } = deps;

  // ==================== TRANSACTION HANDLERS ====================
  // _insertTransaction: extracted to lib/db-helpers.js (alias defined at top of server.js).
  // Writes BOTH JSON data column AND structured columns for indexes.

  async function handleGetTransactions(req, res, user) {
    const url = new URL(req.url, 'http://localhost');
    const refType = url.searchParams.get('ref_type');
    const refId = url.searchParams.get('ref_id');
    const invType = url.searchParams.get('inv_type');
    const direction = url.searchParams.get('direction');
    const limit = Math.max(1, parseInt(url.searchParams.get('limit')) || 10000);

    // Always use database for consistency (DB is the authoritative source)
    const conditions = [];
    const params = [];
    if (refType) { conditions.push('ref_type = ?'); params.push(refType); }
    if (refId) { conditions.push('ref_id = ?'); params.push(refId); }
    if (invType) { conditions.push('inv_type = ?'); params.push(invType); }
    if (direction) { conditions.push('direction = ?'); params.push(direction); }
    const whereClause = conditions.length > 0 ? `WHERE ${  conditions.join(' AND ')}` : '';
    const [rows] = await pool.execute(`SELECT * FROM transactions ${whereClause} ORDER BY id DESC LIMIT ${limit}`, params);
    sendJSON(res, rows);
  }

  async function handleAddTransaction(req, res, user, body) {
    // 普通用户可添加交易记录（含损坏/调用/上下线等操作）
    const id = body.id || (`tx-${  Date.now().toString(36)  }${Math.random().toString(36).slice(2, 6)}`);
    const timestamp = body.timestamp || new Date().toISOString();
    await _insertTransaction(null, { ...body, id, timestamp });
    broadcastSSE('transactions_updated', {});
    sendJSON(res, { success: true, transaction: { ...body, id, timestamp } });
  }

  async function handleDeleteTransaction(req, res, user, txId) {
    if (!requireAdmin(user, res, sendJSON, '无删除权限')) return;
    const item = await readJSONById('transactions', txId);
    if (!item) return sendJSON(res, { error: '交易记录不存在' }, 404);
    // deleteJSON handles DB deletion internally (DELETE FROM transactions WHERE id = ?)
    await deleteJSON('transactions', txId);
    broadcastSSE('transactions_updated', {});
    sendJSON(res, { success: true });
  }

  return {
    handleGetTransactions,
    handleAddTransaction,
    handleDeleteTransaction,
  };
};
