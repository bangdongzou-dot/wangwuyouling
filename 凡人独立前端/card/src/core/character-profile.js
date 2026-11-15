// Runtime/model projections only. Never migrate or rewrite stored source rows.
// Numeric columns belong to a schema: do not recurse through inventory, skills or equipment.
export const PREBUILT_PROFILE_ESTIMATE_RULE = '年龄、寿元、地点都须填写。优先使用明确资料及最近已确认前态。原文没有精确数字时，按出生年、亲属辈分、人生阶段和年表时间估算整岁年龄，按种族、实际境界与现行设定估算寿元上限。沿用可信寿元，随剧情时间更新年龄；不得提前套用未来境界、死亡或寿元变化。地点取此人本节点最后可确认的位置，按人物正文、行动、前态或所属地域推断，离场人物不套用玩家地点。无精确地标可写可信的上级地名，无可靠坐标只写地名。三项只更新终态，不登记变量增减或来源。第9列用中文键「年龄」「寿元」，第16列第三段写地点。';
export const PREBUILT_TERMINAL_TEXT_RULE = '所有适用人物列遵循同一顺序：明确事实优先，继承仍适用的前态，再按人物、经历、环境和现行规则合理推断。原文没明说不等于未知。对不影响事实、时序或游戏消费的措辞、估值和细节差异予以通过。无适用内容可留空；真实得失、突破、数量变化仍须核对来源。背景和内心想法填文本，境界与身份按第2列原格式。' + PREBUILT_PROFILE_ESTIMATE_RULE;

export function prebuiltProfilePlace(value) {
  const place=typeof value==='string'?value.replace(/\s*[（(]\s*坐标\s*[:：]?\s*(?:未详|不详|未知|未载)\s*[）)]\s*$/u,'').trim():'';
  if(!place||/[|\r\n]/u.test(place)||!/\p{L}/u.test(place)||
    /^(?:未知|不详|未详|未载|无|无资料|资料未载|待补全|当前位置|当前场景|原著相关地点|undefined|null)(?:$|[（(\s])/iu.test(place))return '';
  return place;
}

export function missingPrebuiltProfileFields(columns) {
  const notes=columns?.['9'], appearance=String(columns?.['16']??'').split('|');
  return [
    ...['年龄','寿元'].filter(key=>!Number.isSafeInteger(notes?.[key])||notes[key]<(key==='年龄'?0:1)),
    ...(appearance.length===5&&prebuiltProfilePlace(appearance[2])?[]:['地点']),
  ];
}

export function patchPrebuiltProfile(columns, patch) {
  if(!characterRecord(columns)||!characterRecord(patch)||
    Object.keys(patch).some(key=>!['年龄','寿元','地点'].includes(key)))return null;
  const next={...columns,'9':{...columns['9']}};
  for(const key of ['年龄','寿元']){
    if(!Object.hasOwn(patch,key))continue;
    if(!Number.isSafeInteger(patch[key])||patch[key]<(key==='年龄'?0:1))return null;
    next['9'][key]=patch[key];
  }
  if(Object.hasOwn(patch,'地点')){
    const place=prebuiltProfilePlace(patch.地点);
    if(!place)return null;
    const appearance=String(next['16']??'').split('|');
    if(appearance.length!==5)return null;
    appearance[2]=place;
    next['16']=appearance.join('|');
  }
  return next;
}

export const RETIRED_CHARACTER_COLUMNS = Object.freeze(['8','17','18','20','21','22','23','24']);
const retiredCharacterKeys = new Set([...RETIRED_CHARACTER_COLUMNS,
  'sexExperience','publicKink','privateKink','sensitiveParts','genitalStatus','eroticValue','pleasureValue','sexualConception',
  '性经验','性经历','表性癖','里性癖','敏感点','敏感部位','生殖器状态','生殖器官状态','情欲值','快感值','性观念']);
const characterRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const variableTextRule = Object.freeze({
  id:'fr-variable-world-text-v1', name:'玩家可见变量采用世界内措辞', enabled:true, role:'system', triggerMode:'always',
  content:'【玩家可见变量采用世界内措辞】技能和功法的介绍、熟练度、效果与限制，物品、装备、特质、百艺描述、人物关系、身份、状态、目标、动作、背景、生平和世界大事，均写成修仙世界里成立的事实和描述。禁止把「本节点」「前节点」「本轮」「本回合」「本次补演」「原文第几段」「模型推定」「待校对」等制作说明写进这些值。涉及先后用真实日期、地点、事情或「此前」「如今」交代。技能要区分读过、掌握和能施展，效果写具体能力或限制，描述物品由来时写实际人物和行为。无必要的资料说明可省略，未知值与原生列格式照原规则处理。校对报告、依据、段号、节点编号和变更归属仍写入各自的结构化字段，逐字引文照录。',
});
export const variableTextPromptTypes = Object.freeze(['player','npc','beast','humanoid_beast','entry_all_focus',
  'item_management','misc_management','misc_without_map','map_management','merged_variables','original_timeline_evolution']);

export function cleanVariableRuleExamples(text) {
  if(typeof text!=='string')return text;
  return text.replaceAll('本轮已确认状态','腿部擦伤，行走略跛')
    .replaceAll('本轮生成的婴儿姓名','韩安')
    .replaceAll('出生于本轮已确认年份和地点','生于越国五里沟');
}

export function cleanVariablePresentationText(value, narrative = false) {
  if(typeof value!=='string')return value;
  const clean=value
    .replace(/[（(]\s*(?:原文(?:未载|未明示|第\s*\d+\s*段)|P\d+|E-\d+-N\d+)\s*[）)]/giu,'')
    .replace(/[；;，,。]\s*原文(?:未载|未说明|未记载|未明确)[^。；;|]*(?:。|(?=$|[；;|]))/gu,'。')
    .replace(/(?:按|据)原文(?:合理)?(?:推断|推定|推测)[：:，,、]?\s*|(?:模型|系统)(?:推断|推定|估算)[：:，,、]\s*/gu,'')
    .replace(narrative ? /(?:在|于)?(?:本节点|当前节点|本次补演)(?:发生时|期间|之)?(前|后|起)?(?:[：:，,、])?/gu :
      /(?:在|于)?(?:本(?:节点|回合|事件|轮(?!回))|当前节点|本次补演)(?:发生时|期间|之)?(前|后|起)?(?:[：:，,、])?/gu,
      (_,direction)=>({前:'此前',后:'此后',起:'如今'})[direction]||'')
    .replace(/(?:在|于)?(?:前一?|上一|前序)节点(?:中|时)?/gu,'此前')
    .replace(/(?:在|于)?(?:下一|后续)节点(?:中|时)?/gu,'此后');
  return clean===value?value:clean.trim();
}
const cleanVariableNarrative = value=>cleanVariablePresentationText(value,true);

function mapVariableFields(row, transforms) {
  if(!characterRecord(row))return row;
  let result=row;
  for(const [key,transform] of Object.entries(transforms)){
    if(!Object.hasOwn(row,key))continue;
    const value=transform(row[key]);
    if(value!==row[key])result={...result,[key]:value};
  }
  return result;
}
const cleanTextFields=(row,keys)=>mapVariableFields(row,Object.fromEntries(keys.map(key=>[key,cleanVariablePresentationText])));
const itemTextKeys=['3','4','6','7','8','9','description','desc','effect','effects','restriction','currentEffect','allEffects','realmEffects','maxRealm'];
const skillTextKeys=['3','4','5','6','7','8','9','description','desc','effect','effects','restriction','currentEffect','allEffects'];
const traitTextKeys=['desc','description','effect','effects'];
export const cleanVariableItem = row=>cleanTextFields(row,itemTextKeys);
export const cleanVariableSkill = row=>cleanTextFields(row,skillTextKeys);
export const cleanVariableTrait = row=>cleanTextFields(row,traitTextKeys);
export const cleanVariableBeast = row=>cleanTextFields(row,['2','3','4','5','6']);
const cleanVariableArt = row=>cleanTextFields(row,['desc','description','notes','effect','effects']);
export const cleanVariableWorldEntry = row=>cleanTextFields(row,['1','2','title','scope','summary','prose',
  'description','effect','estimatedEnd','endCondition']);
export const cleanVariableWorldDraft = world=>mapVariableFields(world,{entries:value=>cleanVariableList(value,cleanVariableWorldEntry)});

function mapVariableCollection(value, project) {
  if(typeof value==='string'&&/^\s*[\[{]/u.test(value)){
    let decoded;
    try { decoded=JSON.parse(value); } catch { return value; }
    const cleaned=project(decoded);
    return cleaned===decoded?value:JSON.stringify(cleaned);
  }
  return project(value);
}
function cleanVariableList(value, project) {
  return mapVariableCollection(value,items=>{
    if(!Array.isArray(items))return items;
    const next=items.map(project);
    return next.some((item,index)=>item!==items[index])?next:items;
  });
}
const cleanVariableEquipment = value=>mapVariableCollection(value,slots=>
  mapVariableFields(slots,Object.fromEntries(Object.keys(slots||{}).map(key=>[key,rows=>cleanVariableList(rows,cleanVariableItem)]))));

export function cleanVariableRemarks(value) {
  return mapVariableCollection(value,row=>mapVariableFields(row,{
    inventory:value=>cleanVariableList(value,cleanVariableItem),
    gongfa:value=>cleanVariableList(value,cleanVariableItem),
    equipment:cleanVariableEquipment,
    skills:value=>cleanVariableList(value,cleanVariableSkill),
    traits:value=>cleanVariableList(value,cleanVariableTrait),
    cultivationArts:value=>mapVariableFields(value,Object.fromEntries(Object.keys(value||{}).map(key=>[key,cleanVariableArt]))),
  }));
}

export function cleanVariableCharacterColumns(row) {
  const textKeys=['2','3','4','5','6','7','10','12','16','19','27','28','29','34'];
  return mapVariableFields(row,{
    ...Object.fromEntries(textKeys.map(key=>[key,cleanVariablePresentationText])),
    '9':cleanVariableRemarks,
    '13':value=>characterRecord(value)?cleanTextFields(value,Object.keys(value)):cleanVariablePresentationText(value),
    '35':cleanVariableNarrative,
  });
}

function cleanVariableOperation(op) {
  if(!characterRecord(op))return op;
  const project = {
    skill:cleanVariableSkill,trait:cleanVariableTrait,item:cleanVariableItem,equipment:cleanVariableItem,
    realm:cleanVariablePresentationText,identity:cleanVariablePresentationText,relationship:cleanVariablePresentationText,
    status:cleanVariablePresentationText,goal:cleanVariablePresentationText,location:cleanVariablePresentationText,
  }[op.kind];
  const cleanValue=value=>typeof value==='string'?cleanVariablePresentationText(value):project?.(value)??value;
  return mapVariableFields(op,{
    ...(project?Object.fromEntries(['value','beforeValue','previousValue','terminalValue'].map(key=>[key,cleanValue])):{}),
    item:value=>mapVariableFields(value,{columns:cleanVariableItem}),
  });
}

export function cleanVariableActor(person) {
  return mapVariableFields(person,{
    columns:cleanVariableCharacterColumns,
    profile:value=>cleanTextFields(value,['realm','identity','personality','status','background','thought','location','action',
      'appearance','attire','clothing','figure','goal','motive','motivation','currentMotive','shortGoal','longGoal','deeds','spiritualRoot','constitution']),
    prose:cleanVariableNarrative, recap:cleanVariableNarrative,
    biography:value=>cleanVariableList(value,cleanVariableNarrative),
    variables:value=>cleanVariableList(value,cleanVariableOperation),
    terminal:value=>cleanVariableList(value,cleanVariableOperation),
    sourceChanges:value=>cleanVariableList(value,cleanVariableOperation),
  });
}

export function cleanVariableCommand(op, projectCharacter=cleanVariableCharacterColumns) {
  const id=String(op?.id||op?.data?.['0']||'');
  switch(op?.command){
    case 'addSkill': return mapVariableFields(op,{skillData:cleanVariableSkill});
    case 'addTrait': return mapVariableFields(op,{traitData:cleanVariableTrait});
    case 'addItem': return mapVariableFields(op,{itemData:cleanVariableItem});
    case 'addGongfa':
    case 'setGongfa': return mapVariableFields(op,{gongfaData:cleanVariableItem});
    case 'appendBiography': return mapVariableFields(op,{biography:cleanVariableNarrative});
    case 'equipItem': return mapVariableFields(op,{
      item:value=>mapVariableFields(cleanVariableItem(value),{data:cleanVariableItem}),
      data:value=>mapVariableCollection(value,cleanVariableItem),
    });
    case 'addWorldEvent': return mapVariableFields(op,{eventData:cleanVariableWorldEntry});
    case 'updateWorldEvent': return mapVariableFields(op,{data:cleanVariableWorldEntry});
    case 'set':
    case 'add': {
      const project=/^(?:[BCG]\d|[CG]_)/u.test(id)?projectCharacter:
        /^I(?:\d|_)/u.test(id)?cleanVariableItem:/^S(?:\d|_)/u.test(id)?cleanVariableSkill:
        /^P(?:\d|_)/u.test(id)?cleanVariableBeast:null;
      return project?mapVariableFields(op,{data:project}):op;
    }
    default: return op;
  }
}

export function cleanVariableItemManagement(op) {
  if(op?.type==='createItem')return mapVariableFields(op,{item:cleanVariableItem});
  if(op?.type==='refreshItemData'||op?.type==='equipItem')
    return mapVariableFields(op,{data:value=>mapVariableCollection(value,cleanVariableItem)});
  return op;
}

export function isRetiredCharacterColumn(column) {
  return RETIRED_CHARACTER_COLUMNS.includes(String(column));
}

export function projectCharacterColumns(row) {
  if (!characterRecord(row)) return row;
  return Object.fromEntries(Object.entries(row).filter(([key])=>!retiredCharacterKeys.has(key)));
}

export function projectActorProfile(profile) {
  if (!characterRecord(profile)) return profile;
  const next = projectCharacterColumns(profile);
  // Only known character wrappers. Column 9 and all nested item/skill schemas stay intact.
  for (const key of ['data','raw','row','columns','state','profile','beforeRow','afterRow']) {
    if (characterRecord(next[key])) next[key] = projectActorProfile(next[key]);
  }
  return next;
}

export function projectCharacterMap(characters) {
  if (!characterRecord(characters)) return characters;
  return Object.fromEntries(Object.entries(characters).map(([name,profile])=>[name,projectActorProfile(profile)]));
}

// A semicolon inside a balanced relationship note belongs to its original entry.
export function splitCharacterRelationshipLines(value) {
  const openings=[],notes=[],separators=[];
  for(const match of value.matchAll(/[()（）;；\r\n]/gu)){
    const token=match[0],index=match.index;
    if(token==='('||token==='（')openings.push(index);
    else if(token===')'||token==='）'){
      if(openings.length)notes.push([openings.pop(),index]);
    }else separators.push(index);
  }
  const rows=[];
  let start=0;
  for(const index of separators){
    if(notes.some(([left,right])=>left<index&&index<right))continue;
    const line=value.slice(start,index).trim();
    if(line)rows.push(line);
    start=index+1;
  }
  const last=value.slice(start).trim();
  if(last)rows.push(last);
  return rows;
}

export function isRetiredCharacterOperation(operation) {
  return ['realm','identity','status','goal','relationship','currency','attribute'].includes(operation?.kind)
    && isRetiredCharacterColumn(operation.column);
}

export function projectCharacterRecords(records) {
  if (!Array.isArray(records)) return records;
  return records.flatMap(record=>{
    const operation=record.operation;
    if (isRetiredCharacterOperation(operation)) return [];
    if (record.kind!=='characters'||!['add','set'].includes(operation?.command)
      || !/^(?:B1|C[1-9]\d*)$/u.test(String(operation.id || operation.data?.['0'] || ''))) return [record];
    const data=projectCharacterColumns(operation.data);
    return Object.keys(data || {}).some(key=>key!=='0')?[{...record,operation:{...operation,data}}]:[];
  });
}

export function projectOrdinarySettlement(settlement) {
  if (!characterRecord(settlement)) return settlement;
  return {...projectActorProfile(settlement),
    ...(settlement.beforeRows?{beforeRows:projectCharacterMap(settlement.beforeRows)}:{}),
    ...(settlement.afterRows?{afterRows:projectCharacterMap(settlement.afterRows)}:{}),
    ...(settlement.records?{records:projectCharacterRecords(settlement.records)}:{}),
    ...(Array.isArray(settlement.protectedColumns)?{protectedColumns:settlement.protectedColumns.filter(key=>!isRetiredCharacterColumn(key))}:{})};
}
