/**
 * 一键导入 WUJI 设备 SN 码（含来源字段）— 直连数据库版
 * 读取 SZX3-WUJI设备流转记录_WUJI设备SN表 (3).xlsx 并批量入库
 *
 * 用法: node import-wuji-sn.js
 * 导入后请重启服务器以触发库存重算（_syncInventoryFromSN）
 */
const XLSX = require('xlsx');
const mysql = require('mysql2/promise');

const XLSX_FILE = 'SZX3-WUJI设备流转记录_WUJI设备SN表 (3).xlsx';
const DB = { host: '127.0.0.1', port: 3306, user: 'Wuzhenyu', password: 'Wh111852', database: 'gms' };

async function main() {
  // 1. 读取 Excel
  const wb = XLSX.readFile(XLSX_FILE);
  const ws = wb.Sheets['WUJI设备SN表'];
  if (!ws) { console.error('未找到工作表: WUJI设备SN表'); process.exit(1); }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  console.log(`读取到 ${rows.length - 1} 条 SN 数据（不含表头）`);

  // 2. 解析 SN 列表，自动识别设备类型和手型
  const snCodes = [];
  for (let i = 1; i < rows.length; i++) {
    const [snCode, deviceType, source] = rows[i];
    if (!snCode || !String(snCode).trim()) continue;

    const code = String(snCode).trim();
    let equipmentType = '';
    let handType = '';

    // 自动识别类型（WG=glove，WH=dexterous_hand）
    if (code.startsWith('WG')) {
      equipmentType = 'glove';
      handType = code[3] === 'J' ? 'left' : code[3] === 'K' ? 'right' : '';
    } else if (code.startsWith('WH')) {
      equipmentType = 'dexterous_hand';
      handType = code[3] === 'J' ? 'left' : code[3] === 'K' ? 'right' : '';
    } else {
      equipmentType = 'glove'; // 默认
    }

    snCodes.push({
      snCode: code,
      equipmentType,
      handType,
      source: String(source || '采购').trim(),
    });
  }

  console.log(`解析完成: 共 ${snCodes.length} 条有效 SN 码`);
  console.log(`  左手手套: ${snCodes.filter(s => s.equipmentType === 'glove' && s.handType === 'left').length} 条`);
  console.log(`  右手手套: ${snCodes.filter(s => s.equipmentType === 'glove' && s.handType === 'right').length} 条`);
  console.log(`  来源分布: ${JSON.stringify(snCodes.reduce((a, s) => { a[s.source] = (a[s.source] || 0) + 1; return a; }, {}))}`);

  // 3. 批量入库（跳过已存在）
  const conn = await mysql.createConnection(DB);
  let inserted = 0, skipped = 0, updatedSource = 0;
  try {
    const now = new Date().toISOString();

    for (const item of snCodes) {
      const [existing] = await conn.execute('SELECT snCode, source FROM sn_registry WHERE snCode = ?', [item.snCode]);
      if (existing.length > 0) {
        // 已存在：若来源为空则将来源补上
        if (!existing[0].source && item.source) {
          await conn.execute('UPDATE sn_registry SET source = ? WHERE snCode = ?', [item.source, item.snCode]);
          updatedSource++;
        } else {
          skipped++;
        }
        continue;
      }

      await conn.execute(
        'INSERT INTO sn_registry (snCode,equipmentType,handType,status,machineNumber,trackingNumber,damageReason,shippedAt,repairedAt,attachment,source,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [item.snCode, item.equipmentType, item.handType, 'available', '', '', '', '', '', '', item.source, now]
      );

      // 入库历史记录
      const historyId = `h-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await conn.execute(
        'INSERT INTO sn_status_history (id, snCode, oldStatus, newStatus, operator, reason, machineNumber, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [historyId, item.snCode, null, 'available', 'import-wuji', 'WUJI设备SN表批量入库（来源: ' + item.source + '）', '', now]
      );

      inserted++;
    }

    console.log(`\n导入完成!`);
    console.log(`  新增: ${inserted}`);
    console.log(`  已存在(跳过): ${skipped}`);
    console.log(`  补充来源: ${updatedSource}`);
    console.log(`  总计: ${snCodes.length}`);
  } finally {
    await conn.end();
  }
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });