const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),acorn=require('../node_modules/acorn');
const front=path.join(__dirname,'../card/src/frontend'),src=fs.readFileSync(path.join(front,'main.js'),'utf8'),defs=[];
function walk(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&['executeEquipItem','executeUnequipItem','executeCreateItem','ceRemoveRetiredItemColumns','executeConsumeItem','executeItemOperations','reorderItemOperations','unequipIfEquipped','createCharacterObjectFromWorldBookEntry','applyConcurrentEvolutionBioChanges'].includes(n.id.name))defs.push(src.slice(n.start,n.end));for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}}walk(acorn.parse(src,{ecmaVersion:'latest'}));
async function fixture(owner='C1'){
 const core=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(__dirname,'../card/src/core/equipment-layout.js')).toString('base64'));
 const containers=await import(require('node:url').pathToFileURL(path.join(__dirname,'../card/src/core/container-equipment.js')).href);
 const view=item=>({...item,id:item.id||item['0'],name:item.name||item['1'],type:item.type||item['2']});
 const row={'0':owner,'9':{equipment:{},inventory:[{id:'A',name:'青玉佩',type:'护甲',score:10},{id:'W',name:'长剑',type:'武器',score:10}]}};
 const state={'0':{[owner]:row},'1':Object.fromEntries(row['9'].inventory.map(x=>[x.id,{...x}]))};
 const ctx=vm.createContext({console,structuredClone,currentState:state,window:{CE_CORE:{'equipment-layout':core}},parseRemarksString:v=>typeof v==='object'?structuredClone(v):JSON.parse(v||'{}'),serializeRemarksObject:JSON.stringify,parseNestedJsonString:(v,d)=>typeof v==='string'?JSON.parse(v):v||d,toEquipmentViewItem:view,toTableStorageItem:view,getManagedItemId:item=>item?.id||item?.['0'],getManagedItemName:item=>item?.name||item?.['1'],getItemManagementCharacterRow:id=>state['0'][id],ceValidateEquipmentSlotAssignment:()=>({valid:true}),ceScoreEquipmentCandidate:item=>item.score||1,ceFindWeakestEquipmentIndex:arr=>({index:0,score:arr[0]?.score||1}),ceSyncCharacterTechniqueEffects(){},ceUpdateTechniqueItemCurrentEffect(){},ceGetCharacterRealmText:()=>''});
 ctx.frContainerCore=()=>containers;
 ctx.ceParseItemManagementNested=ctx.parseNestedJsonString;
 ctx.frCleanVariableCharacter=row=>row;
 vm.runInContext(fs.readFileSync(path.join(front,'equipment-runtime.js'),'utf8')+'\n'+defs.join('\n'),ctx);return{ctx,row,state};
}


async function setup(){const f=await fixture();Object.assign(f.ctx,{prepareItemManagementFallbackRows:async()=>{},ceCreateItemTransferAliases:()=>({resolve:x=>x,record(){}}),ceItemOwnerHasManagedId:()=>true,ceNormalizeManagedCharacterItemContainers(){},ceReadItemManagementRemarks:r=>f.ctx.parseRemarksString(r['9']),updateConcurrentEvolutionArchiveEntry:async()=>true});
Object.assign(f.row,{'1':'韩立','2':'筑基期','11':{神识:{max:500},脚力:{max:100}}});
const high={0:'HIGH',1:'神风舟',2:'法宝',4:'容器: 法器·顶阶 | 加成: 脚力 | 传导率: 0.18 | 门槛: 20/50',5:'1',equipmentRole:'flying'},low={0:'LOW',1:'青叶法器',2:'法宝',4:'容器: 法器·下品 | 加成: 脚力 | 传导率: 0.06 | 门槛: 2/8',5:'1',equipmentRole:'flying'};
f.row['9']={equipment:{treasure:[null,high]},inventory:[low]};return {...f,high,low};}
test('explicit lower equipment survives post-loadout; no phantom re-equip',async()=>{const f=await setup();const results=await f.ctx.executeItemOperations([{type:'equipItem',owner:'C1',slot:'treasure',index:1,itemId:'LOW',reason:'收起神风舟，换青叶掩饰身份'}]);const p=f.ctx.FrEquipmentRuntime.project(f.row);assert.equal(p.equipment.treasure[1]['0'],'LOW');assert.equal(p.remarks.inventory.filter(x=>x['0']==='HIGH').length,1);assert.equal(p.equipment.treasure.filter(x=>x?.['0']==='HIGH').length,0);assert.equal(results.length,1);assert.equal(results[0].skipped,undefined);});
test('explicit unequip without itemId stays unequipped; replacement is not invented',async()=>{const f=await setup();const results=await f.ctx.executeItemOperations([{type:'unequipItem',owner:'C1',slot:'treasure',index:1}]);const p=f.ctx.FrEquipmentRuntime.project(f.row);assert.equal(p.equipment.treasure[1],null);assert.equal(p.equipment.treasure.some(x=>x?.['0']==='HIGH'),false);assert.equal(results.filter(r=>r.itemId==='HIGH').length,1);});
test('no explicit choice retains original automatic upgrade and B1 exclusion',async()=>{const f=await setup();const r=await f.ctx.executeItemOperations([],{npcLoadoutIds:['C1','B1']});assert.ok(r.every(x=>x.owner==='C1'));assert.equal(f.ctx.FrEquipmentRuntime.project(f.row).equipment.treasure[1]['0'],'HIGH');});
