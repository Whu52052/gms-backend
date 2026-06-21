/**
 * 修复 tech_support 表中因 MySQL 编码设置导致的乱码
 * 用法: node fix-encoding.js
 */
const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || 'sh-cynosdbmysql-grp-pbo2ohcm.sql.tencentcdb.com';
const DB_PORT = parseInt(process.env.DB_PORT || '22387');
const DB_USER = process.env.DB_USER || 'ubuntu';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'gms';

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
      database: DB_NAME, charset: 'utf8mb4',
    });
    console.log('[OK] Connected to MySQL');

    // 1. 先备份
    await conn.execute('CREATE TABLE IF NOT EXISTS tech_support_backup_20260621 AS SELECT * FROM tech_support');
    const [countRows] = await conn.execute('SELECT COUNT(*) as c FROM tech_support_backup_20260621');
    console.log(`[OK] Backup created: ${countRows[0].c} records`);

    // 2. 查看乱码情况
    const [rows] = await conn.execute('SELECT id, data FROM tech_support ORDER BY id DESC');
    let garbledCount = 0;
    for (const row of rows) {
      if (row.data.includes('�') || row.data.includes('Â') || row.data.includes('Ã') || row.data.includes('¬')) {
        garbledCount++;
      }
    }
    console.log(`[INFO] Total: ${rows.length}, Garbled: ${garbledCount}`);

    if (garbledCount === 0) {
      console.log('[OK] No garbled records found, nothing to fix.');
      process.exit(0);
    }

    // 3. 修复: CONVERT(BINARY(CONVERT(data USING latin1)) USING utf8mb4)
    console.log('[FIX] Attempting encoding fix...');
    let fixedCount = 0, failedCount = 0;
    for (const row of rows) {
      if (row.data.includes('�') || row.data.includes('Â') || row.data.includes('Ã') || row.data.includes('¬')) {
        try {
          // 先试 latin1 -> utf8 转码
          const buf = Buffer.from(row.data, 'latin1');
          let fixed = buf.toString('utf8');
          // 验证修复后包含正常中文字符
          if (!/[一-鿿]/.test(fixed)) {
            // 尝试反向: utf8 -> latin1
            const buf2 = Buffer.from(row.data, 'utf8');
            fixed = buf2.toString('latin1');
          }
          if (/[一-鿿]/.test(fixed)) {
            await conn.execute('UPDATE tech_support SET data = ? WHERE id = ?', [fixed, row.id]);
            fixedCount++;
          } else {
            failedCount++;
          }
        } catch (e) {
          failedCount++;
        }
      }
    }
    console.log(`[DONE] Fixed: ${fixedCount}, Failed: ${failedCount}`);

  } catch (e) {
    console.error('[ERROR]', e.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
})();
