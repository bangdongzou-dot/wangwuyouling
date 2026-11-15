export const INVENTORY_STOCK_RULE = '本轮使用人物的完整库存和装备。物资套装按原物品逐项结算；库存快照列出子物品编号时，使用对应编号。明确已发生或可由已完成工序和配方核实的投入、服用、遗失才扣除。已有物品赠送、归还或交换，用同一笔转移核对持有人、接收方及数量，不重复创建。来源能确认但件数未载的交付按一批登记，用 quantityDetail 保留原文数量和单位（如十余只瓷瓶，每瓶粒数未载），第5列只计批次数；不从身份不明的其他库存扣减，不能把一批当一粒或虚构可分装件数。已装备物品也属于持有量，转出后清除旧槽。';

export function inventoryQuantityLabel(item) {
  return typeof item?.quantityDetail==='string'&&item.quantityDetail.trim()?
    item.quantityDetail.trim():String(item?.['5']??item?.quantity??'');
}

const inventoryCompressionThreshold = 18;
export const INVENTORY_COMPRESSION_RULE = `储物袋达到 ${inventoryCompressionThreshold} 条实际库存记录时，由程序在本轮结算后检查一次，已有套装按一条计。只合并可按用途归类的普通物资；具名丹药、秘籍、装备、剧情物品、特殊批次和本轮有独立增减的物品保留单列。已有套装可持续吸收新物资，保留每件原始记录及数量、单位、效果、限制和其他结算字段。结算必须指定实际物品，不可消耗整套。压缩不代表获得、消耗或转移。`;

// Kept deliberately narrow: these are supplies, not interchangeable medicines or equipment.
const supplyGroups = new Map([
  ['针包','出诊药箱'], ['药箱','出诊药箱'],
  ['药篓','采药与药材包'], ['采药铲','采药与药材包'], ['药草种子','采药与药材包'],
  ['晒制药材','采药与药材包'], ['沿途采集药材','采药与药材包'], ['墨居仁所赠药材','采药与药材包'],
  ['药锄','采药与药材包'], ['分装药袋','采药与药材包'], ['备用药瓶','出诊药箱'], ['针灸用具','出诊药箱'],
  ['铁铃铛','练功用具包'],
]);
const bundleType = '其他物品';
const contentsPrefix = '物资清单：';
const supplyLabels = new Set(supplyGroups.values());

export function isCompressedInventoryItem(item) {
  return item?.['2']===bundleType&&typeof item['3']==='string'&&item['3'].startsWith(contentsPrefix)&&
    supplyLabels.has(item['1']);
}

export function compressedInventoryContents(item) {
  if(!isCompressedInventoryItem(item))return [];
  if(validStockMembers(item))return item.stockMembers.map(row=>[row['1'],Number(row['5'])]);
  return item['3'].slice(contentsPrefix.length).split('、').flatMap(part=>{
    const [name,quantity]=part.split(' ×');
    const value=Number(quantity);
    return supplyGroups.get(name)===item['1']&&Number.isSafeInteger(value)&&value>0?[[name,value]]:[];
  });
}

export function validStockMembers(bundle) {
  return isCompressedInventoryItem(bundle)&&Array.isArray(bundle.stockMembers)&&bundle.stockMembers.length>0&&
    new Set(bundle.stockMembers.map(row=>row?.['1'])).size===bundle.stockMembers.length&&bundle.stockMembers.every(row=>
      row&&supplyGroups.get(row['1'])===bundle['1']&&row['2']===supplyItemType(row['1'])&&
      typeof row['3']==='string'&&typeof row['4']==='string'&&
      /^[1-9]\d*$/u.test(String(row['5']))&&Number.isSafeInteger(Number(row['5']))&&
      !Object.hasOwn(row,'stockMembers'));
}

function writeStockMembers(bundle,members) {
  return {...bundle,'3':contentsPrefix+members.map(row=>row['1']+' ×'+row['5']).join('、'),stockMembers:members};
}

function hydrateInventoryBundle(bundle,sourceRows) {
  if(!isCompressedInventoryItem(bundle)||validStockMembers(bundle))return bundle;
  const wanted=compressedInventoryContents(bundle);
  const members=wanted.map(([name,count])=>{
    const matches=sourceRows.filter(row=>row?.['1']===name&&row['2']===supplyItemType(name)&&Number(row['5'])===count);
    return matches.length===1?matches[0]:null;
  });
  if(!members.length||members.some(row=>!row))return bundle;
  return writeStockMembers(bundle,members);
}

export function inventoryMemberRoutes(rows) {
  return new Map((rows||[]).filter(bundle=>bundle?.['0']&&validStockMembers(bundle)).flatMap(bundle=>
    bundle.stockMembers.map(member=>[bundle['0']+'_M'+[...member['1']].map(char=>char.codePointAt(0).toString(16)).join('_'),
      {bundle,member}])));
}

export function detachStockMembers(rows,routes) {
  if(!routes.size)return rows;
  const removed=new Set([...routes.values()].map(({member})=>member));
  return rows.flatMap(bundle=>{
    if(!validStockMembers(bundle))return [bundle];
    const rest=bundle.stockMembers.filter(member=>!removed.has(member));
    if(rest.length===bundle.stockMembers.length)return [bundle];
    return [...(rest.length?[writeStockMembers(bundle,rest)]:[]),
      ...[...routes].filter(([,route])=>route.bundle===bundle).map(([id,{member}])=>({...member,'0':id,id}))];
  });
}

export function supplyItemType(name) {
  return name==='药草种子'?'种子':['晒制药材','沿途采集药材','墨居仁所赠药材'].includes(name)?'药材':bundleType;
}

export function restoreInventoryMembers(rows,names) {
  if(!Array.isArray(rows))return rows;
  if(!rows.some(item=>compressedInventoryContents(item).some(([name])=>names.has(name))))return rows;
  return rows.flatMap(item=>{
    const members=compressedInventoryContents(item);
    if(!members.some(([name])=>names.has(name)))return [item];
    if(!validStockMembers(item))return [item];
    return item.stockMembers.map(member=>({...member,0:null}));
  });
}

export function applyInventoryCompressionTemplate(rows,template) {
  if(!Array.isArray(rows)||!Array.isArray(template))return rows;
  let current=rows;
  for(const bundle of template.filter(isCompressedInventoryItem)){
    const wanted=compressedInventoryContents(bundle);
    if(!validStockMembers(bundle))continue;
    const existing=current.filter(item=>item?.['1']===bundle['1']);
    if(existing.length>1||existing.some(item=>!isCompressedInventoryItem(item)))continue;
    const embedded=compressedInventoryContents(existing[0]);
    if(embedded.some(([name,count])=>!wanted.some(([key,value])=>key===name&&count===value)))continue;
    const loose=[];
    for(const [name,count] of wanted){
      const matches=current.filter(item=>item?.['1']===name);
      if(embedded.some(([key])=>key===name)){
        if(matches.length)break;
      }else if(matches.length===1&&matches[0]['2']===supplyItemType(name)&&
        Number(matches[0]['5'])===count&&!matches[0].quantityDetail&&!matches[0].equipmentRole&&
        !matches[0].isNatal&&!matches[0].artifactTier)loose.push(matches[0]);
      else break;
    }
    if(loose.length+embedded.length!==wanted.length)continue;
    if(existing.length&&!validStockMembers(existing[0])){
      const hydrated=hydrateInventoryBundle(existing[0],bundle.stockMembers??[]);
      if(hydrated===existing[0])continue;
      existing[0]=hydrated;
      if(!loose.length){
        current=current.map(item=>item?.['1']===hydrated['1']?hydrated:item);
        continue;
      }
      current=current.map(item=>item?.['1']===hydrated['1']?hydrated:item);
    }
    if(!loose.length)continue;
    const removed=new Set([...existing,...loose]);
    const first=current.find(item=>removed.has(item));
    const row=writeStockMembers({...bundle,0:existing[0]?.['0']??first?.['0']??null},
      [...(existing[0]?.stockMembers??[]),...loose]);
    current=current.flatMap(item=>item===first?[row]:removed.has(item)?[]:[item]);
  }
  return current;
}

export function compressInventory(rows,{protectedNames=new Set(),force=false}={}) {
  if(!Array.isArray(rows)||!force&&rows.filter(Boolean).length<inventoryCompressionThreshold)return rows;
  const byGroup=new Map();
  for(const item of rows){
    const name=item?.['1'],group=supplyGroups.get(name);
    if(!group||item['2']!==supplyItemType(name)||protectedNames.has(name)||item.quantityDetail||item.equipmentRole||
      item.isNatal||item.artifactTier||rows.filter(row=>row?.['1']===name).length!==1||
      !/^[1-9]\d*$/u.test(String(item['5'])))continue;
    if(!byGroup.has(group))byGroup.set(group,[]);
    byGroup.get(group).push(item);
  }
  const replacements=new Map();
  for(const [group,items] of byGroup){
    const existing=rows.filter(item=>item?.['1']===group);
    if(existing.length>1||existing.some(item=>!validStockMembers(item)))continue;
    if(items.length<2&&!existing.length)continue;
    const members=[...(existing[0]?.stockMembers??[]),...items];
    if(new Set(members.map(row=>row['1'])).size!==members.length)continue;
    const bundle=writeStockMembers({0:existing[0]?.['0']??null,1:group,2:bundleType,
      4:group==='出诊药箱'?'用于携带针具和施治用具。':'用于采集、携带或处理普通药材。',5:'1'},
    members);
    const source=[...existing,...items];
    source.forEach((item,index)=>replacements.set(item,index?null:bundle));
  }
  return replacements.size?rows.flatMap(item=>replacements.has(item)?[replacements.get(item)].filter(Boolean):[item]):rows;
}
