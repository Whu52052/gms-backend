/**
 * Direct restore from backup ZIP to SQLite database
 * Usage: node restore-from-backup.js <zip-path>
 */
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const ZIP_PATH = process.argv[2] || 'C:\\Users\\24492\\Downloads\\手套管理系统备份-2026-06-09.zip';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'gms.db');

console.log('=== Restoring from backup ===');
console.log('ZIP:', ZIP_PATH);
console.log('DB:', DB_PATH);

// Read ZIP
const zip = new AdmZip(ZIP_PATH);
const jsonEntry = zip.getEntry('backup.json');
if (!jsonEntry) { console.error('No backup.json found!'); process.exit(1); }
const backup = JSON.parse(jsonEntry.getData().toString('utf8'));
console.log('Backup version:', backup.version, 'Exported:', backup.exportedAt);

// Open DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Clear all tables first
console.log('\n--- Clearing tables ---');
const tables = ['inventory', 'machines', 'transactions', 'audit_log', 'sn_registry',
  'ops_orders', 'ops_customers', 'ops_production', 'settings', 'equipment_config', 'inventory_config'];
db.transaction(() => {
  tables.forEach(t => {
    db.prepare('DELETE FROM ' + t).run();
    console.log('  Cleared:', t);
  });
})();

// Restore inventory
console.log('\n--- Restoring inventory ---');
if (Array.isArray(backup.inventory) && backup.inventory.length > 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO inventory (type, quantity, updatedAt, updatedBy) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    backup.inventory.forEach(r => {
      ins.run(r.type, r.quantity, r.updatedAt, r.updatedBy);
      console.log(`  ${r.type}: qty=${r.quantity}`);
    });
  })();
}

// Restore JSON blob tables
console.log('\n--- Restoring JSON blob tables ---');
const jsonTables = {
  machines: 'machines', transactions: 'transactions', auditLog: 'audit_log',
  equipmentConfig: 'equipment_config', inventoryConfig: 'inventory_config',
  opsOrders: 'ops_orders', opsCustomers: 'ops_customers', opsProduction: 'ops_production',
};
Object.entries(jsonTables).forEach(([jsonKey, table]) => {
  if (Array.isArray(backup[jsonKey]) && backup[jsonKey].length > 0) {
    const ins = db.prepare('INSERT OR REPLACE INTO ' + table + ' (id, data) VALUES (?, ?)');
    db.transaction(() => {
      backup[jsonKey].forEach(item => {
        const id = item.id || item.snCode || item.type || ('_' + Math.random().toString(36).slice(2));
        ins.run(id, JSON.stringify(item));
      });
    })();
    console.log(`  ${table}: ${backup[jsonKey].length} rows`);
  } else {
    console.log(`  ${table}: 0 rows (skipped)`);
  }
});

// Restore settings
console.log('\n--- Restoring settings ---');
if (backup.settings && typeof backup.settings === 'object') {
  const ins = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    Object.entries(backup.settings).forEach(([k, v]) => {
      ins.run(k, JSON.stringify(v));
      console.log(`  ${k}`);
    });
  })();
}

// Restore SN registry
console.log('\n--- Restoring sn_registry ---');
if (Array.isArray(backup.snRegistry) && backup.snRegistry.length > 0) {
  const ins = db.prepare('INSERT OR REPLACE INTO sn_registry (snCode, equipmentType, handType, status, machineNumber, damageReason, trackingNumber, attachment, updatedAt, shippedAt, repairedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    backup.snRegistry.forEach(r => {
      ins.run(r.snCode, r.equipmentType || null, r.handType || null, r.status || 'available',
        r.machineNumber || null, r.damageReason || null, r.trackingNumber || null,
        r.attachment || null, r.updatedAt || new Date().toISOString(),
        r.shippedAt || null, r.repairedAt || null);
    });
  })();
  console.log(`  sn_registry: ${backup.snRegistry.length} rows`);
}

// Restore uploaded files
console.log('\n--- Restoring uploads ---');
const entries = zip.getEntries();
let uploadCount = 0;
entries.forEach(e => {
  if (e.entryName.startsWith('uploads/') && !e.isDirectory) {
    const fname = path.basename(e.entryName);
    if (fname) {
      const dest = path.join(UPLOADS_DIR, fname);
      fs.writeFileSync(dest, e.getData());
      uploadCount++;
    }
  }
});
console.log(`  Restored ${uploadCount} files`);

// Verify
console.log('\n--- Verification ---');
tables.forEach(t => {
  const count = db.prepare('SELECT COUNT(*) as c FROM ' + t).get().c;
  console.log(`  ${t}: ${count}`);
});

db.close();
console.log('\n=== Restore complete! ===');
console.log('Please restart the server to apply changes.');
