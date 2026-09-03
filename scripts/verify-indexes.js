/**
 * 临时验证脚本：检查 shift_inspections 新索引是否创建成功
 * 用法: node scripts/verify-indexes.js
 */
'use strict';
require('dotenv').config?.();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306'),
    user: process.env.DB_USER || process.env.MYSQL_USER,
    password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.DB_NAME || 'gms',
  });
  const [rows] = await conn.execute(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shift_inspections'
     GROUP BY INDEX_NAME ORDER BY INDEX_NAME`
  );
  console.log('shift_inspections 索引:');
  rows.forEach(r => console.log(' -', r.INDEX_NAME));
  await conn.end();
})().catch(e => { console.error('验证失败:', e.message); process.exit(1); });