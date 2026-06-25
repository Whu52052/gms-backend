const mysql = require('mysql2/promise');
const fs = require('fs');

const REMOTE_CONFIG = {
  host: 'sh-cynosdbmysql-grp-pbo2ohcm.sql.tencentcdb.com',
  port: 22387,
  user: 'Wuzhenyu',
  password: 'Wh1111852',
  database: 'gms'
};

async function main() {
  console.log('Connecting to remote MySQL...');
  const conn = await mysql.createConnection(REMOTE_CONFIG);
  
  console.log('Getting tables...');
  const [tables] = await conn.execute("SHOW TABLES");
  const tableNames = tables.map(t => Object.values(t)[0]);
  
  console.log(`Found ${tableNames.length} tables: ${tableNames.join(', ')}`);
  
  const dump = { tables: {}, schema: {} };
  
  for (const table of tableNames) {
    console.log(`Exporting ${table}...`);
    
    const [columns] = await conn.execute(`DESCRIBE ${table}`);
    dump.schema[table] = columns;
    
    const [rows] = await conn.execute(`SELECT * FROM ${table}`);
    dump.tables[table] = rows;
    
    console.log(`  ${rows.length} rows exported`);
  }
  
  await conn.end();
  
  const dumpPath = './data/database_dump.json';
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  
  console.log(`\nDump saved to ${dumpPath}`);
  console.log('Database export completed!');
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});