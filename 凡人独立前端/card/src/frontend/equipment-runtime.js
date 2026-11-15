// 命名槽位的拥有者适配。读取只做投影；写入随原装备/保存事务落地，不另写整档。
var FrEquipmentRuntime=(function(){
  var keys=['weapon','armor','technique','treasure'];
  function core(){var modules=typeof CE_CORE==='object'&&CE_CORE?CE_CORE:window.CE_CORE;var value=modules?.['equipment-layout'];if(!value)throw new Error('装备布局模块未装配');return value;}
  function unpack(value,label){
    for(var depth=0;depth<3&&typeof value==='string';depth++){if(!value.trim())return null;try{value=JSON.parse(value);}catch(error){throw new Error(label+' JSON无效：'+error.message);}}
    if(typeof value==='string')throw new Error(label+' JSON嵌套过深');return value;
  }
  function idOf(item){return String(item?.id||item?.['0']||'');}
  function tableItem(item,slot){var converted=typeof toTableStorageItem==='function'?toTableStorageItem(item,{weapon:'武器',armor:'护甲',technique:'功法',treasure:'法宝'}[slot]):null;return structuredClone({...item,...(converted||{})});}
  function addInventory(inventory,item){
    var id=idOf(item),index=id?inventory.findIndex(row=>idOf(row)===id):-1;
    if(index<0)inventory.push(structuredClone(item));else inventory[index]={...inventory[index],...structuredClone(item)};
  }
  function readLayout(row){
    var remarks=parseRemarksString(row?.['9']||''),raw=unpack(remarks.equipment,'装备')||{};
    if(typeof raw!=='object'||Array.isArray(raw))throw new Error('装备必须是JSON对象');
    var known={},extras={};Object.entries(raw).forEach(([key,value])=>{(keys.includes(key)?known:extras)[key]=value;});
    if(Object.keys(extras).length)remarks.equipmentLegacyExtras={...(unpack(remarks.equipmentLegacyExtras,'旧装备辅助字段')||{}),...structuredClone(extras)};
    var result=core().normalizeEquipmentLayout(known,{version:remarks.equipmentLayoutVersion,owner:row});
    return {remarks:remarks,result:result};
  }
  function project(row){
    var read=readLayout(row),remarks=read.remarks,result=read.result;
    var inventory=unpack(remarks.inventory,'背包')||[];if(!Array.isArray(inventory))throw new Error('背包必须是JSON数组');
    inventory=structuredClone(inventory);
    if(row?.['0']!=='B1')for(var overflow of result.overflow)addInventory(inventory,tableItem(overflow.item,overflow.slotKey));
    var base={inventory:row?.['0']==='B1'?[]:inventory,equipment:result.equipment};
    var grouped=core().coalesceTreasureSets(base);
    remarks.inventory=row?.['0']==='B1'?inventory:grouped.inventory;
    remarks.equipment=grouped.equipment;remarks.equipmentLayoutVersion=1;
    return {...result,equipment:grouped.equipment,remarks:remarks,treasureSetsChanged:grouped!==base};
  }
  function adopt(row,projection,state){
    if(projection.overflow.some(entry=>!idOf(entry.item)))throw new Error('旧装备缺少物品ID，保留原数据，不能自动迁移到背包');
    var remarks=projection.remarks;remarks.equipment=projection.equipment;remarks.equipmentLayoutVersion=1;
    if(row['0']==='B1'){
      if(!state)throw new Error('玩家装备迁移缺少物品表');
      state['1']=state['1']||{};
      var equipped=new Set(keys.flatMap(key=>projection.equipment[key]).filter(Boolean).map(idOf));
      for(var overflow of projection.overflow){var id=idOf(overflow.item);if(id&&!equipped.has(id))state['1'][id]=tableItem(overflow.item,overflow.slotKey);}
    }
    row['9']=serializeRemarksObject(remarks);return remarks;
  }
  function write(state,row,slot,index,item){
    var slots=core().getEquipmentSlots(slot);
    if(!Number.isInteger(index)||index<0||index>=slots.length)throw new Error('装备槽位索引越界');
    var eligibility=core().equipmentEligibility(row,slot,index,item);if(!eligibility.allowed)throw new Error(eligibility.reason);
    var p=project(row),old=p.equipment[slot][index],incoming=idOf(item),owner=row['0'];
    if(item&&!incoming)throw new Error('装备缺少物品ID');
    if((old&&!idOf(old))||p.overflow.some(entry=>!idOf(entry.item)))throw new Error('旧装备缺少物品ID，保留原数据，不能覆盖');
    if(old&&idOf(old)!==incoming){var returned=tableItem(old,slot);if(owner==='B1'){state['1']=state['1']||{};state['1'][idOf(old)]=returned;}else addInventory(p.remarks.inventory,returned);}
    if(incoming){
      for(var key of keys)for(var n=0;n<p.equipment[key].length;n++)if(idOf(p.equipment[key][n])===incoming)p.equipment[key][n]=null;
      if(owner==='B1')delete (state['1']||{})[incoming];else p.remarks.inventory=p.remarks.inventory.filter(row=>idOf(row)!==incoming);
    }
    p.equipment[slot][index]=item?structuredClone(item):null;adopt(row,p,state);return {oldItem:old,equipment:p.equipment};
  }
  function consolidate(row,state){
    var p=project(row);
    if(row['0']==='B1'){
      const table=state['1']||{}, all=Object.entries(table);
      if(all.every(([id,item])=>id===idOf(item))){
        const base={inventory:all.map(([,item])=>item),equipment:p.equipment};
        const grouped=core().coalesceTreasureSets(base);
        if(grouped!==base){
          state['1']=Object.fromEntries(grouped.inventory.map(item=>[idOf(item),item]));
          p.equipment=grouped.equipment;
          p.treasureSetsChanged=true;
        }
      }
    }
    if(p.treasureSetsChanged)adopt(row,p,state);
    return p;
  }
  function adjustEquippedSet(state,row,itemId,newQuantity){
    if(!row)return null;
    const p=project(row),index=p.equipment.treasure.findIndex(item=>idOf(item)===itemId);
    const item=p.equipment.treasure[index];
    if(!core().isTreasureSet(item))return null;
    const before=Number(item['5']??item.quantity),after=newQuantity(before);
    if(!Number.isSafeInteger(after)||after<=0)return null;
    const next={...item,5:String(after),treasureSet:true};
    if(Object.hasOwn(next,'quantity'))next.quantity=after;
    p.equipment.treasure[index]=next;
    adopt(row,p,state);
    return {success:true,itemId,itemName:item['1']??item.name,oldQuantity:String(before),newQuantity:after,remaining:after};
  }
  return {core:core,classify:item=>core().classifyItem(item),eligibility:(row,slot,index,item)=>core().equipmentEligibility(row,slot,index,item),lockedSlots:(row,slot)=>slot==='treasure'&&!core().canEquipNatalTreasure(row)?{0:'结丹期开放'}:{},slots:slot=>core().getEquipmentSlots(slot),allowed:(slot,item)=>core().allowedEquipmentIndices(slot,item),readEquipment:row=>project(row).equipment,project:project,adopt:adopt,write:write,consolidate:consolidate,adjustEquippedSet:adjustEquippedSet,tableItem:tableItem};
})();
window.FrEquipmentRuntime=FrEquipmentRuntime;
