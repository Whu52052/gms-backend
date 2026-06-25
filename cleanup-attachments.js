const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || process.env.MYSQL_HOST || '';
const DB_PORT = parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306');
const DB_USER = process.env.DB_USER || process.env.MYSQL_USER || '';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'gms';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

async function main() {
  if (!DB_HOST || !DB_USER || !DB_PASSWORD) {
    console.error('请设置数据库环境变量: DB_HOST, DB_USER, DB_PASSWORD');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME,
    charset: 'utf8mb4',
    connectionLimit: 5,
  });

  console.log('开始清理无效附件...\n');

  try {
    let totalCleaned = 0;

    // 1. 清理 sn_registry 表
    console.log('=== 清理 sn_registry 表 ===');
    const [snRows] = await pool.execute('SELECT snCode, attachment FROM sn_registry WHERE attachment IS NOT NULL AND attachment != ""');
    console.log(`找到 ${snRows.length} 条有附件的记录`);
    
    let snCleaned = 0;
    for (const row of snRows) {
      const attachment = row.attachment;
      let isInvalid = false;
      
      if (attachment.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, attachment);
        if (!fs.existsSync(filePath)) {
          isInvalid = true;
        }
      } else if (attachment.startsWith('data:')) {
        // base64 data URL，不用清理
      } else if (attachment.startsWith('http://') || attachment.startsWith('https://')) {
        // 外部URL，不用清理
      } else {
        // 其他格式，检查是否是本地文件路径
        const filePath = path.join(__dirname, attachment);
        if (!fs.existsSync(filePath)) {
          isInvalid = true;
        }
      }
      
      if (isInvalid) {
        console.log(`  清理: ${row.snCode} - ${attachment.substring(0, 50)}...`);
        await pool.execute('UPDATE sn_registry SET attachment = NULL WHERE snCode = ?', [row.snCode]);
        snCleaned++;
      }
    }
    console.log(`sn_registry 清理完成: ${snCleaned} 条\n`);
    totalCleaned += snCleaned;

    // 2. 清理 transactions 表
    console.log('=== 清理 transactions 表 ===');
    const [txRows] = await pool.execute("SELECT id, attachment FROM transactions WHERE attachment IS NOT NULL AND attachment != ''");
    console.log(`找到 ${txRows.length} 条有附件的记录`);
    
    let txCleaned = 0;
    for (const row of txRows) {
      const attachment = row.attachment;
      let isInvalid = false;
      
      if (attachment.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, attachment);
        if (!fs.existsSync(filePath)) {
          isInvalid = true;
        }
      } else if (attachment.startsWith('data:')) {
        // base64 data URL，不用清理
      } else if (attachment.startsWith('http://') || attachment.startsWith('https://')) {
        // 外部URL，不用清理
      } else {
        const filePath = path.join(__dirname, attachment);
        if (!fs.existsSync(filePath)) {
          isInvalid = true;
        }
      }
      
      if (isInvalid) {
        console.log(`  清理: 记录 ${row.id}`);
        await pool.execute('UPDATE transactions SET attachment = NULL WHERE id = ?', [row.id]);
        txCleaned++;
      }
    }
    console.log(`transactions 清理完成: ${txCleaned} 条\n`);
    totalCleaned += txCleaned;

    // 3. 清理 tech_support 表（JSON data 字段中的 attachment）
    console.log('=== 清理 tech_support 表 ===');
    const [tsRows] = await pool.execute('SELECT id, data FROM tech_support');
    console.log(`找到 ${tsRows.length} 条技术支持记录`);
    
    let tsCleaned = 0;
    for (const row of tsRows) {
      try {
        const data = JSON.parse(row.data);
        let changed = false;
        
        if (data.attachment) {
          const attachment = data.attachment;
          let isInvalid = false;
          
          if (attachment.startsWith('/uploads/')) {
            const filePath = path.join(__dirname, attachment);
            if (!fs.existsSync(filePath)) {
              isInvalid = true;
            }
          } else if (attachment.startsWith('data:') || attachment.startsWith('http://') || attachment.startsWith('https://')) {
            // 不用清理
          } else {
            const filePath = path.join(__dirname, attachment);
            if (!fs.existsSync(filePath)) {
              isInvalid = true;
            }
          }
          
          if (isInvalid) {
            console.log(`  清理: 技术支持 ${row.id}`);
            delete data.attachment;
            changed = true;
          }
        }
        
        // 检查维修记录中的附件
        if (data.repairLog && Array.isArray(data.repairLog)) {
          for (const entry of data.repairLog) {
            if (entry.attachment) {
              const attachment = entry.attachment;
              let isInvalid = false;
              
              if (attachment.startsWith('/uploads/')) {
                const filePath = path.join(__dirname, attachment);
                if (!fs.existsSync(filePath)) {
                  isInvalid = true;
                }
              } else if (attachment.startsWith('data:') || attachment.startsWith('http://') || attachment.startsWith('https://')) {
                // 不用清理
              } else {
                const filePath = path.join(__dirname, attachment);
                if (!fs.existsSync(filePath)) {
                  isInvalid = true;
                }
              }
              
              if (isInvalid) {
                console.log(`  清理: 技术支持 ${row.id} 维修记录附件`);
                delete entry.attachment;
                changed = true;
              }
            }
          }
        }
        
        if (changed) {
          await pool.execute('UPDATE tech_support SET data = ? WHERE id = ?', [JSON.stringify(data), row.id]);
          tsCleaned++;
        }
      } catch (e) {
        // JSON 解析失败，跳过
      }
    }
    console.log(`tech_support 清理完成: ${tsCleaned} 条\n`);
    totalCleaned += tsCleaned;

    console.log(`\n✅ 全部清理完成! 共清理 ${totalCleaned} 条无效附件`);

  } catch (e) {
    console.error('清理失败:', e.message);
  } finally {
    await pool.end();
  }
}

main();
