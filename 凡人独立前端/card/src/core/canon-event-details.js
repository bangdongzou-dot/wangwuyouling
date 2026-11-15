import { cleanVariableCharacterColumns, cleanVariablePresentationText, splitCharacterRelationshipLines } from './character-profile.js';
import { parseTimePoint, parseTimePrecision } from './interval.js';
import { splitProseParagraphs } from './prose-validate.js';
import { CULTIVATION_ARTS } from './cultivation-arts.js';
import { isCompressedInventoryItem } from './inventory-stock.js';

const eventCode = /^E-\d+(?:\.\d+)?$/u;
export const ordinaryCrossEvent = block => new Set([...(block?.eventIds||[]),
  ...(block?.eventWindows||[]).filter(window=>!window.gap).map(window=>window.code)].filter(id=>eventCode.test(id))).size > 1;
const precisionMinutes = {year:12*31*1440,month:31*1440,day:1440,hour:60,minute:1};
const endOfDate = (date, point) => point === null ? null : point + (precisionMinutes[parseTimePrecision(date)] || 1) - 1;

export function ordinaryEventSegments(block, windows) {
  const body = block.handoffDeclared ? block.variableBody : block.body;
  const biographyLine = block.handoffDeclared ? block.variableBiographyLine : block.biographyLine;
  const sections = splitProseParagraphs({body, biographyLine});
  const allowed = new Set(block.eventIds || []);
  const ranges = (windows || []).map(window => ({...window,
    min: parseTimePoint(window.start), max: endOfDate(window.end,parseTimePoint(window.end))}));
  const fail = label => { throw new Error(`${block.name}的${label}缺少唯一的事件来源`); };
  if ((!sections.length && String(body || '').trim()) || !ranges.length) fail('正文');
  return sections.map(section => {
    const date = section.label.split(/[@＠]/u)[0];
    const [start, end = start] = date.split(/\s*(?:[—–至~～]| - )\s*/u);
    const first = parseTimePoint(start), endPoint = parseTimePoint(end);
    if (first === null || endPoint === null || endPoint < first || !section.biography.startsWith(`[${section.label}]`)) fail(section.label);
    const last = endOfDate(end,endPoint);
    const explicit = section.body.match(/^@@事件[:：]\s*(E-\d+(?:\.\d+)?|GAP)\s*(?:\r?\n|$)/u);
    const hits = ranges.filter(row => row.min !== null && row.max !== null &&
      first <= row.max && last >= row.min && (!explicit || (row.gap ? 'GAP' : row.code) === explicit[1]));
    const contained = hits.filter(row => first >= row.min && last <= row.max);
    const candidates = contained.length ? contained : hits;
    if (candidates.length !== 1 || (!candidates[0].gap && !allowed.has(candidates[0].code))) fail(section.label);
    const window = candidates[0];
    const prose = section.body.slice(explicit?.[0].length || 0).trim();
    if (!prose) fail(section.label);
    return {eventId:window.gap ? null : window.code, at:start, order:first,
      windowStart:window.start, windowEnd:window.end, prose:section.heading+'\n'+prose,
      biography:[section.biography]};
  });
}

export function planOrdinaryEventSteps(entries, splitByDate=false) {
  const byEvent = new Map();
  const orderByActor = new Map();
  for (const {id, name, segments} of entries) for (const segment of segments) {
    const key = segment.eventId ? (splitByDate?`${segment.eventId}:${segment.order}`:segment.eventId) : `GAP:${id}:${segment.order}`;
    if (!orderByActor.has(id)) orderByActor.set(id, []);
    const keys = orderByActor.get(id);
    if (keys.at(-1) !== key) keys.push(key);
    if (!byEvent.has(key)) byEvent.set(key, {key,eventId:segment.eventId,at:segment.at,order:segment.order,actors:[]});
    const step = byEvent.get(key);
    if (segment.order < step.order) Object.assign(step,{at:segment.at,order:segment.order});
    let actor = step.actors.find(row => row.id === id);
    if (!actor) { actor = {id,name,prose:'',biography:[],itemsOnly:true}; step.actors.push(actor); }
    actor.prose = [actor.prose,segment.prose].filter(Boolean).join('\n\n');
    actor.biography.push(...segment.biography);
    actor.itemsOnly &&= segment.itemsOnly === true;
  }
  const steps = [...byEvent.values()].sort((a,b)=>a.order-b.order);
  const indices = new Map(steps.map((step,index)=>[step.key,index]));
  const outOfOrder = [...orderByActor.values()].some(keys=>keys.some((key,index)=>index && indices.get(keys[index-1])>=indices.get(key)));
  if (!outOfOrder) return steps;
  if (!splitByDate) return planOrdinaryEventSteps(entries,true);
  throw new Error('逐事件正文的段落先后冲突，需要明确同日事件的顺序');
}

// Source records are inert data. A field change distinguishes absence from null.
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const unsafe=new Set(['__proto__','prototype','constructor']);
const excluded=new Set(['0','7','15','19','32','33','35']);
const protectedNotes=new Set(['isBonded','canonActorId','canonPrebuiltUnknown']);
const copy=value=>structuredClone(value);
const collectionKeys=new Set(['inventory','skills','traits','gongfa']);
const itemKey=value=>{
  const name=typeof value==='string'?value:value?.['1']||value?.name;
  return name?'@'+JSON.stringify([name,value?.['2']||value?.type||'']):null;
};
const itemFields=value=>{
  if(!object(value))return value;
  const {'0':id,inventoryGroup,...fields}=value;
  return fields;
};
const listMap=value=>{
  if(!Array.isArray(value))return null;
  const entries=value.map(item=>[itemKey(item),item]);
  return entries.every(([key])=>key)&&new Set(entries.map(([key])=>key)).size===entries.length
    ? new Map(entries):null;
};
export function eventRelationshipMap(value){
  if(value==null||typeof value==='string'&&/^(?:无)?$/u.test(value.trim()))return {};
  if(typeof value==='string'&&value.trimStart().startsWith('{')){
    try{value=JSON.parse(value);}catch{return null;}
  }
  let entries;
  if(object(value))entries=Object.entries(value);
  else if(typeof value==='string'){
    const pairs=splitCharacterRelationshipLines(value).map(line=>line.match(/^([^:：]+)[:：](.+)$/u));
    if(!pairs.every(Boolean))return null;
    entries=pairs.map(([,name,relation])=>[name,relation]);
  }else return null;
  const normalized=entries.map(([key,relation])=>[key.trim(),typeof relation==='string'?relation.trim():relation]);
  const keys=normalized.map(([key])=>key);
  if(new Set(keys).size!==keys.length||keys.some(key=>!key||unsafe.has(key)))return null;
  return Object.fromEntries(normalized);
}
export function equivalentPrebuiltRelationship(before,after){
  if(before===after)return true;
  if(typeof before!=='string'||typeof after!=='string')return false;
  const canonical=value=>cleanVariablePresentationText(value).normalize('NFKC').replace(/[\s\p{Cf}]+/gu,'').replace(/[。.!！]+$/u,'');
  return canonical(before)===canonical(after);
}

export function equivalentPrebuiltArt(before,after){
  if(before===after)return true;
  return !!(object(before)&&object(after)&&before.tier===after.tier&&before.progress===after.progress);
}

export function eventComparableRow(row){
  if(!object(row))return row;
  const result=copy(cleanVariableCharacterColumns(row));
  if(Object.hasOwn(result,'13'))result['13']=eventRelationshipMap(result['13'])??result['13'];
  return result;
}

export function eventFieldChanges(before, after) {
  if(!object(before)||!object(after))return [];
  const changes=[];
  const walk=(left,right,path)=>{
    if(same(left,right))return;
    if(path.length===2&&path[0]==='9'&&collectionKeys.has(path[1])){
      const a=listMap(left),b=listMap(right);
      if(a&&b){
        for(const key of new Set([...a.keys(),...b.keys()])){
          const before=a.get(key),after=b.get(key),itemPath=[...path,key];
          if(before&&after&&(isCompressedInventoryItem(before)||isCompressedInventoryItem(after))){
            if(!same(itemFields(before),itemFields(after)))changes.push({path:itemPath,before:copy(before),after:copy(after)});
          }else if(before&&after)walk(itemFields(before),itemFields(after),itemPath);
          else walk(before,after,itemPath);
        }
        return;
      }
    }
    if(object(left)&&object(right)){
      for(const key of new Set([...Object.keys(left),...Object.keys(right)])){
        if(unsafe.has(key)||(!path.length&&excluded.has(key))||
          (path.length===1&&path[0]==='9'&&protectedNotes.has(key)))continue;
        walk(left[key],right[key],[...path,key]);
      }
      return;
    }
    const arithmetic=(path.length===1&&path[0]==='26')||
      (path.length===3&&path[0]==='11'&&path[2]==='current')||
      (path.length===4&&path[0]==='9'&&path[1]==='inventory'&&path[2].startsWith('@')&&path[3]==='5');
    const a=typeof left==='number'||typeof left==='string'&&/^\d+$/.test(left)?Number(left):NaN;
    const b=typeof right==='number'||typeof right==='string'&&/^\d+$/.test(right)?Number(right):NaN;
    changes.push({path,...(left!==undefined?{before:copy(left)}:{}),...(right!==undefined?{after:copy(right)}:{}),
      ...(arithmetic&&Number.isFinite(a)&&Number.isFinite(b)?{delta:b-a}:{})});
  };
  walk(eventComparableRow(before),eventComparableRow(after),[]);
  return changes;
}

const prebuiltSnapshotColumns = new Set(['3','4','10','12','16','19','27','28','29','31','34']);
const prebuiltSourceColumns = new Set(['2','5','6','11','13','26','30']);
const prebuiltSourceNotes = new Set(['寿元','inventory','equipment','skills','traits','gongfa','cultivationArts']);
export function isPrebuiltSnapshotColumn(column) {
  return prebuiltSnapshotColumns.has(String(column));
}

export function isPrebuiltStatusOperation(op) {
  const column=String(op?.column??'').trim().split('.')[0];
  return column==='4'||!column&&['status','状态','当前状态','Buff 与状态'].includes(op?.kind)&&op.subject!=='战斗状态';
}

const equipmentOccupant = item => item == null ? null : [
  item['1'] ?? item.name, item['2'] ?? item.type, String(item['5'] ?? item.quantity ?? 1),
];
const equipmentOccupants = rows => {
  const slots = Array.isArray(rows) ? rows.map(equipmentOccupant) : [];
  while (slots.length && slots.at(-1) == null) slots.pop();
  return slots;
};

export function prebuiltEquipmentSlotChanges(before, after) {
  const a = equipmentOccupants(before), b = equipmentOccupants(after);
  return Array.from({length:Math.max(a.length,b.length)},(_,index)=>index)
    .filter(index=>!same(a[index]??null,b[index]??null));
}

export function isPrebuiltEventField(field) {
  if (!Array.isArray(field?.path)) return false;
  const {path,before,after}=field;
  const [column,key,part,leaf] = path;
  if (column === '13') return path.length === 2 && !equivalentPrebuiltRelationship(before,after);
  if (column !== '9') return prebuiltSourceColumns.has(column) &&
    !(Number.isFinite(before) && typeof after === 'string' && String(before) === after.trim() ||
      Number.isFinite(after) && typeof before === 'string' && String(after) === before.trim());
  if (!prebuiltSourceNotes.has(key)) return false;
  if (key === '寿元' && after == null) return false;
  if (key === 'equipment') {
    if (part) return prebuiltEquipmentSlotChanges(before,after).length > 0;
    const occupied = value => Object.fromEntries(Object.entries(value || {})
      .sort(([a],[b])=>a.localeCompare(b)).map(([slot,rows])=>[slot,equipmentOccupants(rows)]).filter(([,slots])=>slots.length));
    return !same(occupied(before),occupied(after));
  }
  if (key === 'inventory' && leaf && leaf !== '5') return leaf==='3'&&
    [before,after].every(value=>typeof value==='string'&&value.startsWith('物资清单：'));
  if (key === 'cultivationArts') {
    if (leaf) return path.length===4&&['tier','progress'].includes(leaf);
    if (part) return !equivalentPrebuiltArt(before,after);
    const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);
    return [...keys].some(art=>!equivalentPrebuiltArt(before?.[art],after?.[art]));
  }
  const empty = value => value == null || Array.isArray(value) && !value.length || object(value) && !Object.keys(value).length;
  return !(empty(before) && empty(after));
}

export function applyPrebuiltSnapshotColumns(current, terminal, {preservePosition=false}={}) {
  if (!object(terminal)) return current;
  const fields = Object.entries(terminal).filter(([column])=>
    isPrebuiltSnapshotColumn(column) && (!preservePosition || column !== '16'));
  const next = {...current,...Object.fromEntries(fields)};
  if (Number.isFinite(terminal['9']?.年龄) && object(next['9'])) {
    next['9'] = {...next['9'],年龄:terminal['9'].年龄};
  }
  return next;
}

export function prebuiltActorDifferences(baseline, actual) {
  return eventFieldChanges(baseline,actual).filter(field=>{
    const [column,key,part]=field.path;
    if(!Object.hasOwn(baseline||{},column)||!Object.hasOwn(actual||{},column))return false;
    if(column==='9'&&(!Object.hasOwn(baseline['9']||{},key)||!Object.hasOwn(actual['9']||{},key)))return false;
    if(column==='13'&&/^(?:B1|玩家(?:本人|角色)?|用户|你|player|user)$/iu.test(key||''))return false;
    if(column==='4'&&[field.before,field.after].every(value=>typeof value==='string'&&
      /^(?:无|正常|一切正常|无异常|无状态|无持续状态)$/u.test(value.trim())))return false;
    if(column==='9'&&key==='inventory'&&part&&field.path[3]&&field.path[3]!=='5'&&
      ![field.before,field.after].some(value=>typeof value==='string'&&value.startsWith('物资清单：')))return false;
    return isPrebuiltEventField(field)||isPrebuiltSnapshotColumn(column)||field.path.join('.')==='9.年龄';
  });
}

export function applyEventFieldChanges(row, changes, {reverse=false,requireMatch=true,prebuilt=false}={}) {
  if(!object(row)||!Array.isArray(changes))return null;
  const next=eventComparableRow(row);
  for(const change of reverse?changes.slice().reverse():changes){
    const path=change?.path;
    if(!Array.isArray(path)||!path.length||path.some(key=>typeof key!=='string'||unsafe.has(key))||
      excluded.has(path[0])||(path[0]==='9'&&protectedNotes.has(path[1])))return null;
    let target=next;
    for(const key of path.slice(0,-1)){
      if(Array.isArray(target)&&key.startsWith('@')){
        const list=listMap(target);
        target=list?.get(key);
        if(!object(target))return null;
        continue;
      }
      if(target[key]===undefined)target[key]={};
      if(!object(target[key])&&!Array.isArray(target[key]))return null;
      target=target[key];
    }
    const key=path.at(-1);
    const list=Array.isArray(target)&&key.startsWith('@')?listMap(target):null;
    if(Array.isArray(target)&&!list)return null;
    const current=list?list.get(key):target[key];
    const expected=reverse?change.after:change.before;
    let value=reverse?change.before:change.after;
    if (prebuilt&&path.length===3&&path[0]==='9'&&path[1]==='equipment') {
      if (current!=null&&!Array.isArray(current)) return null;
      const slots = Array.isArray(current) ? [...current] : [];
      for (const index of prebuiltEquipmentSlotChanges(expected,value)) {
        const occupant = equipmentOccupant(slots[index]), desired = equipmentOccupant(value?.[index]);
        if (same(occupant,desired)) continue;
        if (requireMatch&&!same(occupant,equipmentOccupant(expected?.[index]))) return null;
        while (slots.length<=index) slots.push(null);
        slots[index] = copy(value?.[index]??null);
      }
      target[key]=slots;
      continue;
    }
    if(Number.isFinite(change.delta)){
      if(typeof current!=='number'&&!(typeof current==='string'&&/^\d+$/.test(current)))return null;
      const number=Number(current)+(reverse?-change.delta:change.delta);
      if(!Number.isFinite(number)||number<0)return null;
      value=typeof current==='string'?String(number):number;
    }else if(requireMatch&&!same(list?itemFields(current):current,list?itemFields(expected):expected)){
      if(same(list?itemFields(current):current,list?itemFields(value):value))continue;
      return null;
    }
    if(list){
      const index=target.indexOf(current);
      if(index>=0&&value===undefined)target.splice(index,1);
      else if(index>=0)target[index]=copy(value);
      else if(value!==undefined)target.push(copy(value));
    }else if(value===undefined)delete target[key];
    else target[key]=copy(value);
  }
  return next;
}

export function eventSourceRecord(eventId,node,person,options={}){
  const {status='applied',before,world=[],operations,knownBaseline=false}=options;
  const name=person?.name||'';
  const actor=person?.canonActorId||name||'@world';
  return {
    sourceId:JSON.stringify([eventId,node.id,actor]),eventId,nodeId:node.id,actor,name,status,
    at:node.at||'',dependsOn:[...(node.dependsOn||[])],evidence:String(node.evidence||''),
    prose:String(person?.prose||''),biography:copy(person?.biography||[]),
    operations:copy(operations||person?.sourceChanges||person?.variables||[]),
    fields:eventFieldChanges(before,person?.columns),world:copy(world),
    ...(knownBaseline?{knownBaseline:true}:{}),
  };
}

export function mergeEventSourceRecords(previous=[],next=[]) {
  return [...new Map([...previous,...next].filter(row=>row&&typeof row.sourceId==='string'&&row.sourceId&&
    typeof row.nodeId==='string'&&['applied','withdrawn','planned'].includes(row.status))
    .map(row=>[row.sourceId,copy(row)])).values()];
}

const savedFieldLabels={'1':'姓名与性别','2':'境界与身份','3':'性格','4':'状态','5':'灵根','6':'体质','7':'称呼',
  '9':'人物备注','10':'背景','11':'属性','12':'内心想法','13':'人际关系','15':'好感度','16':'行动与位置',
  '19':'画像提示','26':'灵石','27':'当前动机','28':'短期目标','29':'长期目标','30':'灵兽','31':'战斗状态',
  '32':'盟友状态','33':'强制演化'};
const savedRemarkLabels={inventory:'储物袋',equipment:'装备',skills:'技能',traits:'气运特质',gongfa:'功法',
  isBonded:'羁绊状态',cultivationArts:'百艺',buffs:'状态'};
const savedArtNames=new Map(CULTIVATION_ARTS.map(({key,name})=>[key,name]));
const compactDisplayText=(value,limit=80)=>{
  const text=typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
  const chars=Array.from(text);
  return chars.length>limit?chars.slice(0,limit).join('')+'…':text;
};
const readableFieldValue=value=>{
  if(value==null||value==='')return '无';
  if(typeof value==='boolean')return value?'是':'否';
  if(typeof value==='number')return String(value);
  if(typeof value==='string')return compactDisplayText(value,38);
  if(object(value))return compactDisplayText(value['1']||value.name||value.tier,38);
  return '';
};
function savedFieldDisplay(field){
  const [column,key,part,leaf]=field.path||[];
  let label=savedFieldLabels[column],subject=label,partLabel='';
  if(!label)return null;
  if(column==='11'&&key){label=subject=key;partLabel=part==='max'?'上限':'';}
  if(column==='13'&&key){label='关系 · '+key;subject=key;}
  if(column==='9'&&key){
    const category=Object.hasOwn(savedRemarkLabels,key)?savedRemarkLabels[key]:/[\p{Script=Han}]/u.test(key)?key:label;
    label=subject=category;
    if(key==='cultivationArts'&&part){
      if(leaf&&!['tier','progress'].includes(leaf))return null;
      label=savedArtNames.get(part)||'百艺';subject='cultivationArts.'+part;
      partLabel=leaf==='tier'?'档位':'';
    }else if(part?.startsWith('@')){
      let name;try{[name]=JSON.parse(part.slice(1));}catch(_){}
      if(name){label=category+' · '+name;subject=name;}
      if(key==='inventory'&&leaf&&leaf!=='5')return null;
    }
  }
  return {label,subject,partLabel};
}
const eventSourceMap=ledger=>new Map((ledger?.eventProgress||[]).flatMap(event=>(event.nodes||[]).flatMap(node=>
  (node.contributions||[]).filter(source=>source?.sourceId).map(source=>[source.sourceId,{event,node,source}]))));

/** Display from the persisted ledger, never from planned event rows or model replies. */
export function committedEventVariables(previous, saved, floorId) {
  const earlier=eventSourceMap(previous),rows=[];
  for(const {event,node,source} of eventSourceMap(saved).values()){
    const old=earlier.get(source.sourceId)?.source;
    const status=source.status;
    if(status==='withdrawn'){if(old?.status!=='applied')continue;}
    else if(status!=='applied'||(source.floorId&&source.floorId!==floorId)||
      (!previous&&source.floorId!==floorId)||(old&&same(old,source)))continue;
    const base={eventId:event.eventId,title:event.title||event.eventId,name:source.name||'',status,
      at:source.at||node.at||'',nodeTitle:node.title||''};
    const basisFor=subject=>{
      const matching=(source.operations||[]).filter(op=>op.subject===subject);
      const points=new Map(matching.map(op=>[compactDisplayText(op.basis||(op.evidenceRef&&op.evidence)),op.evidenceRef]).filter(([point])=>point));
      if(points.size!==1)return {};
      const [point,ref]=points.entries().next().value;
      return {point,...(/^P\d+$/iu.test(ref||'')?{evidenceRef:ref}:{})};
    };
    const grouped=new Map();
    for(const field of source.knownBaseline?(source.fields||[]).filter(field=>source.ordinary||isPrebuiltEventField(field)):[]){
      const display=savedFieldDisplay(field);
      if(!display)continue;
      const before=readableFieldValue(status==='withdrawn'?field.after:field.before);
      const after=readableFieldValue(status==='withdrawn'?field.before:field.after);
      let detail=before&&after&&before!==after?(display.partLabel?display.partLabel+' ':'')+before+' → '+after:'';
      if(!detail&&!grouped.has(display.label))detail=status==='withdrawn'?'已撤回':'已更新';
      const group=grouped.get(display.label)||{...base,label:display.label,...basisFor(display.subject),parts:new Set()};
      if(detail)group.parts.add(detail);
      if(group.parts.size>1){group.parts.delete('已更新');group.parts.delete('已撤回');}
      grouped.set(display.label,group);
    }
    for(const {parts,...row} of grouped.values())rows.push({...row,detail:[...parts].join('；')});
    for(const biography of source.biography||[]){
      const detail=compactDisplayText(biography,76);
      if(!detail)continue;
      const basis=source.biography.length===1?source.biographyBasis:null,point=compactDisplayText(basis?.point);
      rows.push({...base,label:status==='withdrawn'?'撤回生平':'新增生平',detail,
        ...(point?{point,evidenceRef:basis.evidenceRef}:{})});
    }
    for(const world of source.world||[]){
      const detail=compactDisplayText(world.title);
      if(detail)rows.push({...base,label:'世界大事',detail});
    }
  }
  return rows;
}

export function isOrdinarySourceOnlyNode(node) {
  return node?.sourceOnly===true||node?.title==='人物实际落地回执'&&/^E-\d+(?:\.\d+)?(?::\d+)?-F-/u.test(node.nodeId||'');
}

export function eventProgressForModel(rows=[]) {
  return rows.map(row=>({...row,...(Array.isArray(row.nodes)?{nodes:row.nodes.filter(node=>!isOrdinarySourceOnlyNode(node)).map(({contributions,...node})=>node)}:{})}));
}

export function appendPrebuiltBiography(existing, entries) {
  const text=String(existing||'');
  const seen=new Set(text.split(/\r?\n/u).map(line=>line.trim()));
  const added=[];
  for(const entry of entries){
    const line=String(entry||'').trim();
    if(!/^\[[^\]@\r\n]+@[^\]\r\n]+\][^\r\n]+$/u.test(line))
      throw new Error('预制生平须为单行「[日期@地点]经历」');
    if(seen.has(line))continue;
    seen.add(line);
    added.push(line);
  }
  return {text:added.length?text+(text&&!text.endsWith('\n')?'\n':'')+added.join('\n'):text,added};
}

const compareSources=(a,b)=>(parseTimePoint(a.at)??0)-(parseTimePoint(b.at)??0)||
  (String(a.floorId||'')===String(b.floorId||'')?(a.sourceOrder??0)-(b.sourceOrder??0):0);

export function withdrawEventSources(row, sources, retained=[], withdrawingIds=new Set(sources.map(source=>source.sourceId))) {
  const shared=new Set(retained.flatMap(source=>source.biography||[]));
  let result=copy(row);
  const lines=String(row['35']||'').split(/\r?\n/);
  const removed=new Set();
  for(const source of sources.slice().sort((a,b)=>compareSources(b,a))){
    if(source.knownBaseline!==true || source.pairedSourceIds?.some(id=>!withdrawingIds.has(id)))return null;
    if(retained.some(other=>other.dependsOn?.includes(source.nodeId)))return null;
    const changes=source.fields.filter(change=>{
      if (!source.ordinary && !isPrebuiltEventField(change)) return false;
      const slotField=!source.ordinary&&change.path.length===3&&change.path[0]==='9'&&change.path[1]==='equipment';
      const replacement=retained.filter(other=>other.knownBaseline&&compareSources(other,source)>0)
        .sort((a,b)=>compareSources(b,a))
        .flatMap(other=>other.fields).find(field=>same(field.path,change.path)&&!Number.isFinite(field.delta)&&
          (!slotField||prebuiltEquipmentSlotChanges(change.before,change.after)
            .every(index=>prebuiltEquipmentSlotChanges(field.before,field.after).includes(index))));
      if(!replacement)return true;
      if(slotField){
        const actual=result['9']?.equipment?.[change.path[2]];
        return !prebuiltEquipmentSlotChanges(change.before,change.after)
          .every(index=>same(equipmentOccupant(actual?.[index]),equipmentOccupant(replacement.after?.[index])));
      }
      return !applyEventFieldChanges(result,[{path:change.path,before:replacement.after,after:replacement.after}]);
    });
    result=applyEventFieldChanges(result,changes,{reverse:true,prebuilt:!source.ordinary});
    if(!result)return null;
    for(const line of source.biography||[]){
      if(shared.has(line)||removed.has(line))continue;
      const index=lines.findIndex(value=>value.trim()===line.trim());
      if(index<0)return null; // A compressed history needs its original source mapping.
      lines.splice(index,1);removed.add(line);
    }
  }
  result['35']=lines.join('\n');
  return result;
}

export function ordinaryEventWithdrawals(previous, next) {
  const events = new Map((next || []).map(event=>[event.eventId,event]));
  return (previous || []).flatMap(event=>{
    const updated = events.get(event.eventId);
    if (updated?.status !== 'cancelled' || !updated.resolved || updated.occurred?.length ||
        event.status === 'cancelled' || event.occurred?.length) return [];
    return (event.nodes || []).flatMap(node=>(node.contributions || []).filter(source=>
      source.ordinary === true && source.status === 'applied'));
  });
}
