global.localStorage={_data:{},getItem(k){return this._data[k]||null},setItem(k,v){this._data[k]=v},removeItem(k){delete this._data[k]}};
global.API={online:false};
const fs=require('fs'); let code=fs.readFileSync('js/storage.js','utf8'); code=code.replace('const Storage = {','global.Storage = {'); eval(code); const S=global.Storage;

// helper to compute pairs from app logic
const appCode = fs.readFileSync('js/app.js','utf8');
// implement minimal _getStatusCounts and totalAll calculation using Storage functions
function getStatusCounts(inventoryType) {
  const registry = S.getSNRegistry();
  let eqType, handType;
  if (inventoryType === 'left_glove') { eqType = 'glove'; handType='left'; }
  else if (inventoryType === 'right_glove') { eqType='glove'; handType='right'; }
  else { eqType = inventoryType; handType = null; }
  const relevant = registry.filter(r => {
    if (r.equipmentType === eqType) {
      if (handType) return r.handType === handType;
      return true;
    }
    return r.equipmentType === inventoryType;
  });
  const inv = S.getInventory(inventoryType);
  const regAvailable = relevant.filter(r => r.status === 'available').length;
  const regInUse = relevant.filter(r => r.status === 'in_use').length;
  const regDamaged = relevant.filter(r => r.status === 'damaged').length;
  const regInRepair = relevant.filter(r => r.status === 'in_repair').length;
  return { total: relevant.length, available: inv.quantity, inUse: regInUse, damaged: regDamaged, inRepair: regInRepair };
}

function computeTotals() {
  const gloveTypes = ['left_glove','right_glove'];
  let totalAll=0;
  gloveTypes.forEach(t=>{
    const inv=S.getInventory(t);
    const counts=getStatusCounts(t);
    totalAll += inv.quantity + counts.inUse + counts.damaged;
  });
  return totalAll/2; // convert units to pairs
}

// Init: 5 left, 5 right, create SNs
S.setInventory('left_glove',5,'t'); S.setInventory('right_glove',5,'t');
for(let i=1;i<=5;i++){
  const l='L'+String(i).padStart(2,'0'); const r='R'+String(i).padStart(2,'0');
  S.upsertSNRegistry({snCode:l,equipmentType:'glove',handType:'left',status:'available'});
  S.upsertSNRegistry({snCode:r,equipmentType:'glove',handType:'right',status:'available'});
}
console.log('Initial inventories:', S.getInventory('left_glove').quantity, S.getInventory('right_glove').quantity, 'pairs', computeTotals());
// Use one pair: simulate machine online with SN L01 and R01
const user='u'; const machineNumber='M-01';
const needed=S.getDeviceConsumptionMap('glove');
for(const [invType,qty] of Object.entries(needed)){
  const res=S.adjustInventory(invType, -qty, user, machineNumber);
  S.addTransaction({equipmentType: invType==='left_glove' || invType==='right_glove' ? 'glove':invType, handType: invType.includes('left')? 'left':invType.includes('right')? 'right':null, direction:'out', quantity:qty, snCode: invType==='left_glove'?'L01':'R01', pairId:'p1', machineNumber, updatedBy:user});
}
S.addMachine({machineNumber,deviceType:'glove',status:'online',updatedBy:user,updatedAt: new Date().toISOString()});
S.upsertSNRegistry({snCode:'L01',equipmentType:'glove',handType:'left',status:'in_use',machineNumber});
S.upsertSNRegistry({snCode:'R01',equipmentType:'glove',handType:'right',status:'in_use',machineNumber});
console.log('After use inventories:', S.getInventory('left_glove').quantity, S.getInventory('right_glove').quantity, 'pairs', computeTotals());

// Print registry
console.log('Registry counts left/right inUse:', getStatusCounts('left_glove').inUse, getStatusCounts('right_glove').inUse);
