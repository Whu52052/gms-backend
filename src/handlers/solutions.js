/**
 * Solutions Domain Handlers
 * 解决方案跟踪系统：解决方案的 CRUD + 搜索 + 统计 + 与技术支持工单关联
 *
 * Factory / Dependency Injection pattern:
 *   module.exports = function createSolutionsHandlers(deps) { ... return handlers }
 */
'use strict';

const { canWrite } = require('./_permissions');

module.exports = function createSolutionsHandlers(deps) {
  const { pool, sendJSON } = deps;

  // 角色权限辅助：写操作（增/改/删）仅 admin/superadmin 或运维管理员
  function _canWrite(authUser) { return canWrite(authUser); }

  async function handleList(req, res, authUser) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const category = url.searchParams.get('category') || '';

      let sql = 'SELECT * FROM solutions';
      const conds = [];
      const params = [];
      if (category) { conds.push('category = ?'); params.push(category); }
      if (q) {
        conds.push('(title LIKE ? OR description LIKE ? OR steps LIKE ? OR tags LIKE ? OR category LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like, like, like);
      }
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY usage_count DESC, updated_at DESC LIMIT 1000'; // 避免一次性返回过多记录

      const [rows] = await pool.execute(sql, params);
      sendJSON(res, rows);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleGet(req, res, authUser, id) {
    try {
      const [rows] = await pool.execute('SELECT * FROM solutions WHERE id = ?', [id]);
      if (rows.length === 0) return sendJSON(res, { error: '解决方案不存在' }, 404);
      sendJSON(res, rows[0]);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleCreate(req, res, authUser, body) {
    if (!_canWrite(authUser)) return sendJSON(res, { error: '仅管理员可创建解决方案' }, 403);
    const { title, description, steps, resources, scenarios, verification, category, tags } = body || {};
    if (!title || !title.trim()) return sendJSON(res, { error: '标题不能为空' }, 400);
    const now = new Date().toISOString();
    const id = `sol-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    try {
      await pool.execute(
        `INSERT INTO solutions (id, title, description, steps, resources, scenarios, verification, category, tags, usage_count, usage_stats, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)`,
        [id, title.trim(), description || '', steps || '', resources || '', scenarios || '', verification || '',
         category || '默认', tagsStr, authUser.username || authUser.userId || null, now, now]
      );
      sendJSON(res, { success: true, id });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleUpdate(req, res, authUser, id, body) {
    if (!_canWrite(authUser)) return sendJSON(res, { error: '仅管理员可编辑解决方案' }, 403);
    const { title, description, steps, resources, scenarios, verification, category, tags } = body || {};
    try {
      const [rows] = await pool.execute('SELECT * FROM solutions WHERE id = ?', [id]);
      if (rows.length === 0) return sendJSON(res, { error: '解决方案不存在' }, 404);
      const cur = rows[0];
      const tagsStr = tags !== undefined ? (Array.isArray(tags) ? tags.join(',') : tags) : cur.tags;
      const now = new Date().toISOString();
      await pool.execute(
        `UPDATE solutions SET title=?, description=?, steps=?, resources=?, scenarios=?, verification=?, category=?, tags=?, updated_at=? WHERE id=?`,
        [title !== undefined ? title : cur.title,
         description !== undefined ? description : cur.description,
         steps !== undefined ? steps : cur.steps,
         resources !== undefined ? resources : cur.resources,
         scenarios !== undefined ? scenarios : cur.scenarios,
         verification !== undefined ? verification : cur.verification,
         category !== undefined ? category : cur.category,
         tagsStr, now, id]
      );
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleDelete(req, res, authUser, id) {
    if (!_canWrite(authUser)) return sendJSON(res, { error: '仅管理员可删除解决方案' }, 403);
    try {
      await pool.execute('DELETE FROM tech_support_solutions WHERE solution_id = ?', [id]);
      await pool.execute('DELETE FROM solutions WHERE id = ?', [id]);
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ---- 与技术支持工单关联 ----
  async function handleGetLinked(req, res, authUser, techSupportId) {
    try {
      const [rows] = await pool.execute(
        `SELECT s.* FROM solutions s
         JOIN tech_support_solutions tss ON tss.solution_id = s.id
         WHERE tss.tech_support_id = ?
         ORDER BY tss.linked_at DESC`,
        [techSupportId]
      );
      sendJSON(res, rows);
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleLink(req, res, authUser, techSupportId, body) {
    const solutionId = body && body.solutionId;
    if (!solutionId) return sendJSON(res, { error: '缺少 solutionId' }, 400);
    try {
      // 校验工单存在
      const [tsRows] = await pool.execute('SELECT id FROM tech_support WHERE id = ?', [techSupportId]);
      if (tsRows.length === 0) return sendJSON(res, { error: '技术支持请求不存在' }, 404);
      const [solRows] = await pool.execute('SELECT id FROM solutions WHERE id = ?', [solutionId]);
      if (solRows.length === 0) return sendJSON(res, { error: '解决方案不存在' }, 404);
      // 防重复
      const [dup] = await pool.execute(
        'SELECT id FROM tech_support_solutions WHERE tech_support_id = ? AND solution_id = ?',
        [techSupportId, solutionId]
      );
      if (dup.length === 0) {
        const now = new Date().toISOString();
        await pool.execute(
          'INSERT INTO tech_support_solutions (tech_support_id, solution_id, linked_by, linked_at) VALUES (?,?,?,?)',
          [techSupportId, solutionId, authUser.username || authUser.userId || null, now]
        );
      }
      // 记录使用：usage_count +1，usage_stats 记录最近使用时间
      await pool.execute(
        'UPDATE solutions SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?',
        [new Date().toISOString(), solutionId]
      );
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  async function handleUnlink(req, res, authUser, techSupportId, solutionId) {
    try {
      await pool.execute(
        'DELETE FROM tech_support_solutions WHERE tech_support_id = ? AND solution_id = ?',
        [techSupportId, solutionId]
      );
      sendJSON(res, { success: true });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  // ---- 统计 / 数据可视化 ----
  async function handleStats(req, res, authUser) {
    try {
      // 1. 解决方案使用频率（按 usage_count 排序）
      const [usageRows] = await pool.execute(
        'SELECT id, title, category, usage_count FROM solutions ORDER BY usage_count DESC LIMIT 20'
      );

      // 2. 解决方案分类分布
      const [catRows] = await pool.execute(
        'SELECT category, COUNT(*) AS cnt FROM solutions GROUP BY category ORDER BY cnt DESC'
      );

      // 3. 技术支持工单分类分布（从 tech_support 冗余列 category 统计）
      const [tsCatRows] = await pool.execute(
        'SELECT category, COUNT(*) AS cnt FROM tech_support GROUP BY category ORDER BY cnt DESC'
      );

      // 4. 问题解决效率：已完成工单的平均维修时长（repairSeconds 存于 JSON，用冗余列无法直接聚合，故拉取已完成工单计算）
      const [doneRows] = await pool.execute(
        `SELECT data FROM tech_support WHERE status_v2 IN ('completed')`
      );
      let totalRepair = 0, totalTotal = 0, count = 0;
      for (const r of doneRows) {
        try {
          const it = JSON.parse(r.data);
          if (it.repairSeconds) totalRepair += it.repairSeconds;
          if (it.totalSeconds) totalTotal += it.totalSeconds;
          count++;
        } catch {}
      }
      const avgRepairSeconds = count ? Math.round(totalRepair / count) : 0;
      const avgTotalSeconds = count ? Math.round(totalTotal / count) : 0;

      // 5. 解决方案-工单关联数（衡量方案被采用情况）
      const [linkRows] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM tech_support_solutions`
      );

      // 6. 各解决方案引发的平均解决时长（关联同工单的维修时长）
      const [linkedTxRows] = await pool.execute(
        `SELECT tss.solution_id, s.title, ts.data
         FROM tech_support_solutions tss
         JOIN tech_support ts ON ts.id = tss.tech_support_id
         JOIN solutions s ON s.id = tss.solution_id
         WHERE ts.status_v2 IN ('completed')`
      );
      const solAvgMap = {};
      for (const r of linkedTxRows) {
        try {
          const it = JSON.parse(r.data);
          const sec = it.repairSeconds || 0;
          if (!solAvgMap[r.solution_id]) solAvgMap[r.solution_id] = { title: r.title, total: 0, cnt: 0 };
          solAvgMap[r.solution_id].total += sec;
          solAvgMap[r.solution_id].cnt++;
        } catch {}
      }
      const linkEfficiency = Object.entries(solAvgMap).map(([id, v]) => ({
        solution_id: id, title: v.title, avgRepairSeconds: v.cnt ? Math.round(v.total / v.cnt) : 0, count: v.cnt,
      })).sort((a, b) => a.avgRepairSeconds - b.avgRepairSeconds).slice(0, 20);

      sendJSON(res, {
        usageFrequency: usageRows,
        categoryDistribution: catRows,
        techSupportCategoryDistribution: tsCatRows,
        efficiency: { avgRepairSeconds, avgTotalSeconds, completedCount: count },
        linkCount: linkRows[0].cnt,
        linkEfficiency,
      });
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
  }

  return {
    handleList,
    handleGet,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleGetLinked,
    handleLink,
    handleUnlink,
    handleStats,
  };
};