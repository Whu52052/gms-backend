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
// Run through tests 1-9 simplified
S.getEquipmentConfig(); S.getInventoryConfig();
S.getSettings();
const users = S.getUsers();
S.saveUsers([...users, { username: 'test2', role: 'admin', permissions: { canDeleteSN: true } }]);
S.getAuditLog();
// Machine CRUD
S.addMachine({ machineNumber: 'TEST-001', deviceType: 'glove', status: 'online', updatedBy: 't' });
S.addMachine({ machineNumber: 'TEST-001', deviceType: 'glove', status: 'offline', updatedBy: 't' });
// Data integrity import
S.clearAllData();
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
S.importAllData(json);
// Now run Test 10 sequence
S.setInventory('left_glove', 10, 't');
S.addTransaction({equipmentType:'glove',handType:'left',direction:'in',quantity:10,snCode:'RT-001',updatedBy:'t'});
S.upsertSNRegistry({snCode:'RT-001',equipmentType:'glove',handType:'left',status:'available'});
const exportJson = S.exportAllData();
console.log('EXPORT TRANSACTIONS TYPE:', typeof JSON.parse(exportJson).transactions, 'LEN:', JSON.parse(exportJson).transactions.length);
console.log('EXPORT SNREG TYPE:', typeof JSON.parse(exportJson).snRegistry, 'LEN:', JSON.parse(exportJson).snRegistry.length);
S.clearAllData();
console.log('AFTER CLEAR txs', S.getTransactions().length, 'sn', S.getSNRegistry().length);
S.importAllData(exportJson);
console.log('AFTER IMPORT txs', S.getTransactions().length, 'sn', S.getSNRegistry().length);
