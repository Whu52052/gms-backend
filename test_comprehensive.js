global.localStorage = { _data: {}, getItem(k) { return this._data[k] || null; }, setItem(k,v) { this._data[k] = v; }, removeItem(k) { delete this._data[k]; } };
global.API = { online: false, token: null, _fetch() { return Promise.resolve({success:true}); },
    addMachine(){}, addTransaction(){}, adjustInventory(){}, upsertSNRegistry(){},
    shipSN(){}, repairCompleteSN(){}, clearAllData(){}, saveSettings(){},
    saveEquipmentConfig(){}, saveInventoryConfig(){}, deleteUpload(){},
    getSNRegistry(){}, getTransactions(){}, getMachines(){}, getAuditLog(){},
    getSettings(){}, getEquipmentConfig(){}, getInventoryConfig(){}, getAllInventory(){}
};
const fs = require('fs');
let code = fs.readFileSync('js/storage.js', 'utf8');
code = code.replace('const Storage = {', 'global.Storage = {');
eval(code);
const S = global.Storage;

let pass = 0, fail = 0;
function check(name, ok) { if (ok) pass++; else { fail++; console.log('  ✗ ' + name); } }
S.getEquipmentConfig(); S.getInventoryConfig();

console.log('=== TEST 1: Equipment Config ===');
const eq = S.getEquipmentConfig();
check('eq config exists', eq && eq.length >= 3);
check('glove config', eq.find(c=>c.id==='glove') !== undefined);
check('dexterous config', eq.find(c=>c.id==='dexterous') !== undefined);
check('gripper config', eq.find(c=>c.id==='gripper') !== undefined);

console.log('=== TEST 2: Inventory Config ===');
const ic = S.getInventoryConfig();
check('inv config exists', ic && ic.length >= 4);

console.log('=== TEST 3: Settings ===');
check('default settings', S.getSettings().lowStockThreshold !== undefined);
S.saveSettings({ lowStockThreshold: 3, dashboardCards: ['left_glove','right_glove'] });
check('save/load settings', S.getSettings().lowStockThreshold === 3);

console.log('=== TEST 4: Users & Permissions ===');
const users = S.getUsers();
check('default users exist', users.length > 0);
S.saveUsers([...users, { username: 'test2', role: 'admin', permissions: { canDeleteSN: true } }]);
const updated = S.getUsers();
check('add user', updated.length > users.length);
check('permissions saved', updated.find(u=>u.username==='test2').permissions.canDeleteSN === true);

console.log('=== TEST 5: Audit Log ===');
check('audit log exists', S.getAuditLog().length > 0);

console.log('=== TEST 6: Machine CRUD ===');
S.addMachine({ machineNumber: 'TEST-001', deviceType: 'glove', status: 'online', updatedBy: 't' });
check('add machine', S.getMachines().length === 1);
const mid = S.getMachines()[0].id;
S.addMachine({ machineNumber: 'TEST-001', deviceType: 'glove', status: 'offline', updatedBy: 't' });
check('add same machine (new record)', S.getMachines().length === 2);
check('online count', S.getOnlineMachineCount() === 0);

console.log('=== TEST 7: Undo System ===');
S.pushUndo('test', { type: 'left_glove', previousQuantity: 5, updatedBy: 't' });
const undo = S.popUndo();
check('push/pop undo', undo && undo.type === 'test' && undo.previousQuantity === 5);
check('empty undo', S.popUndo() === null);

console.log('=== TEST 8: Consumption Maps ===');
check('glove map', JSON.stringify(S.getDeviceConsumptionMap('glove')) === '{"left_glove":1,"right_glove":1}');
check('dex map', Object.keys(S.getDeviceConsumptionMap('dexterous')).length === 4);
check('gripper map', JSON.stringify(S.getDeviceConsumptionMap('gripper')) === '{"gripper":2}');

console.log('=== TEST 9: Data Integrity ===');
// Clear, import, verify
S.clearAllData();
check('clear txs', S.getTransactions().length === 0);
const testData = {
  version: '2.0',
  left_glove: { quantity: 5, updatedAt: new Date().toISOString(), updatedBy: 't' },
  right_glove: { quantity: 3, updatedAt: new Date().toISOString(), updatedBy: 't' },
  left_dexterous_hand: { quantity: 0 }, right_dexterous_hand: { quantity: 0 }, gripper: { quantity: 0 },
  machines: [{ machineNumber: 'IMP-001', deviceType: 'glove', status: 'online' }],
  transactions: [{ equipmentType: 'glove', handType: 'left', direction: 'in', quantity: 1, snCode: 'SN-IMP', updatedBy: 't' }],
  snRegistry: [{ snCode: 'SN-IMP', equipmentType: 'glove', handType: 'left', status: 'available' }],
  auditLog: [], settings: { lowStockThreshold: 10 },
};
const json = JSON.stringify(testData);
check('import success', S.importAllData(json).success);
check('import txs', S.getTransactions().length === 1);
check('import machines', S.getMachines().length === 1);
check('import registry', S.getSNRegistry().length === 1);
check('import inv', S.getInventory('left_glove').quantity === 5);

console.log('=== TEST 10: Export/Import Roundtrip ===');
// Isolate roundtrip verification from the previous import test data.
S.clearAllData();
S.setInventory('left_glove', 10, 't');
S.addTransaction({equipmentType:'glove',handType:'left',direction:'in',quantity:10,snCode:'RT-001',updatedBy:'t'});
S.upsertSNRegistry({snCode:'RT-001',equipmentType:'glove',handType:'left',status:'available'});
const exportJson = S.exportAllData();
check('export has version', exportJson.includes('version'));
S.clearAllData();
check('after clear', S.getTransactions().length === 0);
S.importAllData(exportJson);
check('roundtrip txs', S.getTransactions().length === 1);
check('roundtrip registry', S.getSNRegistry().length === 1);
check('roundtrip inv', S.getInventory('left_glove').quantity === 10);

console.log('=== TEST 11: SN Registry Operations ===');
S.upsertSNRegistry({snCode:'UPD-001',equipmentType:'glove',handType:'left',status:'available'});
S.upsertSNRegistry({snCode:'UPD-001',status:'damaged',damageReason:'test'});
const upd = S.getSNByCode('UPD-001');
check('upsert preserves fields', upd.status === 'damaged' && upd.equipmentType === 'glove');

console.log('=== TEST 12: Transaction Capping ===');
S.clearAllData();
for (let i = 0; i < 10001; i++) {
  S.addTransaction({equipmentType:'glove',direction:'in',quantity:1,snCode:'CAP'+i,updatedBy:'t'});
}
check('cap at 10000', S.getTransactions().length === 10000);
check('newest first (first entry is CAP10000)', S.getTransactions()[0].snCode === 'CAP10000');

console.log('\n=== TOTAL:', pass, 'PASS,', fail, 'FAIL ===');
if (fail > 0) process.exit(1);
