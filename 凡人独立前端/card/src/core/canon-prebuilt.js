import { validateCultivationArts, mergeCultivationArts, readCultivationArts, cultivationArtStateEqual, CULTIVATION_ARTS, CULTIVATION_ARTS_RULE } from './cultivation-arts.js';
import { PREBUILT_TERMINAL_TEXT_RULE, PREBUILT_PROFILE_ESTIMATE_RULE, missingPrebuiltProfileFields, patchPrebuiltProfile, prebuiltProfilePlace, isRetiredCharacterColumn, isRetiredCharacterOperation, projectCharacterColumns, projectActorProfile, projectCharacterRecords, projectOrdinarySettlement, splitCharacterRelationshipLines } from './character-profile.js';
import { entrySpan, parseTimePoint, parseTimePrecision, normalizeNodeTiming, nodeTimingWindow } from './interval.js';
import { CHARACTER_STATUS_RULE, carryCharacterStatus } from './character-status.js';
import { characterNamesFromTitle, eventCodeFromTitle } from './vector-input.js';
import { coalesceTreasureSets, equipmentEligibility, getEquipmentSlots, isTreasureSet, SUPPORTED_ITEM_TYPES } from './equipment-layout.js';
import { canonActorId } from './role-roster.js';
import { withRetry } from './retry.js';
import { normalizeRequestLimits } from './request-budget.js';
import { applyEventFieldChanges, eventFieldChanges, eventSourceRecord, isPrebuiltEventField, isPrebuiltSnapshotColumn, isPrebuiltStatusOperation, mergeEventSourceRecords } from './canon-event-details.js';
import { WORLD_EVENT_CLOSURE_RULE, WORLD_EVENT_OPPORTUNITY_RULE } from './world-events.js';
import { repairCarriedBreakthrough, carryAdjustedWhiteValues } from './numeric-realms.js';
import { INVENTORY_STOCK_RULE, validStockMembers } from './inventory-stock.js';

export const PREBUILT_REPAIR_STAGES = {
  boundary: '预制变异边界',
  actor: '预制人物修订',
  variables: '预制人物变量',
  world: '预制世界大事修订',
  tail: '预制人物正文续接',
  commit: '预制成品落地',
};

const text = value => typeof value === 'string' && value.trim().length > 0;
const prebuiltSceneClock=value=>{
  const parts=/^(\d{4})[.年]\s*(\d{1,2})[.月]\s*(\d{1,2})日?\s+(\d{1,2}):(\d{2})/u.exec(String(value||''));
  return parts?parts.slice(1,4).map((p,i)=>i?p.padStart(2,'0'):p).join('.')+' '+parts[4].padStart(2,'0')+':'+parts[5]:'';
};
const codeOf = event => String(event?.eventId || event?.code || event?.id || eventCodeFromTitle(event?.title) || '').trim();
const prebuiltTextFields = ['title','content_brief','content_original'];
const prebuiltTimeFields = ['time_start','time_end'];
const evidenceIn = (value, compactSource) => text(value) && compactSource.includes(value.replace(/\s/g, ''));
const categories = new Set(['realm', 'attribute', 'skill', 'trait', 'item', 'equipment', 'relationship', 'location', 'status', 'identity', 'goal', 'biography', 'beast', 'world','currency']);
const actions = new Set(['gain', 'lose', 'set', 'add', 'remove', 'consume', 'transfer', 'equip', 'unequip', 'append']);
const whiteAttributes = new Set(['血量', '法力', '神识', '物攻', '物防', '法攻', '法防', '物理穿透', '法术穿透', '脚力', '气运', '魅力', '修炼速度']);
const cultivationArtSubjects = new Map(CULTIVATION_ARTS.map(({key})=>['cultivationArts.'+key,key]));
const inventoryTypes = new Set(SUPPORTED_ITEM_TYPES);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equipmentGroups = ['weapon', 'armor', 'technique', 'treasure'];
const playerTarget = value => /^(?:B1|player|user|\{\{user\}\}|玩家|当前玩家|玩家角色|玩家本人|用户|对?你)(?:[（(][^）)]*[）)])?$/iu
  .test(String(value??'').replace(/\s+/g,''));
const playerOperation = op => ['7','15','32','33'].includes(String(op?.column)) || (op?.kind==='relationship'&&playerTarget(op.subject)) ||
  /^(?:对(?:玩家|你)(?:的)?(?:好感(?:度)?|称呼)|好感度|玩家关系)$/u.test(String(op?.subject??'').replace(/\s+/g,'')) ||
  (op?.kind==='item'&&op.action==='transfer'&&playerTarget(op.value));
const isPrebuiltDeltaOperation = op => !isRetiredCharacterOperation(op) && !isPrebuiltStatusOperation(op) &&
  !isPrebuiltSnapshotColumn(String(op?.column??'').trim().split('.')[0]) && op?.kind!=='location' &&
  !(op?.kind==='status' && /^(?:动作|当前动作|所在地|场景位置|位置)$/u.test(String(op.subject??'').trim()));

const prebuiltVariableReply = INVENTORY_STOCK_RULE+'\nvariables 和 ordinaryDelta 都是数组，不是按列号索引的对象。每笔包含 kind、action、column、subject、value、previousValue、terminalValue、evidence。' +
  '\n'+CHARACTER_STATUS_RULE+'\n动作、穿着、实际地点、身段和样貌直接填写第16列终态，不进入 variables 或 ordinaryDelta。' +
  '灵石余额中，下品只写第26列，不写入第9列 inventory，不创建灵石物品。其他品级写第9列备注 spiritStoneGrades 的中品、上品、极品数字余额。收支用 kind=currency，下品写 column="26"、subject="灵石"，从 previousColumns["26"] 读取 previousValue，再计算 terminalValue 写入 columns["26"]；其余写 column="9"、subject="spiritStoneGrades.中品" 或对应品级，同样依据该品级前态计算对应终态。' +
  '百艺实际变化用 attribute/9/set，subject 为 cultivationArts.<项目>，value 和 terminalValue 为同一个完整档位项 {tier,progress,basis}，previousValue 为完整前项或首次确认时的 null。没有实际变化时保留原百艺。' +
  'kind 取 '+[...categories].filter(kind=>kind!=='location').join('、')+'；action 取 '+[...actions].join('、')+'。没有对应变化用 []，ordinaryDelta 无对应变化可省略。' +
  'columns 才按列号索引，沿用 previousColumns 未变化的列。新人物第1列为「姓名|性别」，第2列为「境界|身份」，第16列为「动作|穿着|地点|身段|样貌」。' +
  'columns 用花括号和带引号的列号，例如 {"0":null,"1":"姓名|性别","2":"境界|身份"}。这是结构示意，实际需给全列。' +
  '第9列含年龄、寿元、isBonded=false、inventory 数组、equipment 对象及 skills、traits、gongfa 数组。第11列为属性对象，至少含血量、法力，两者的 current 和 max 均须为数字，沿用可信基准，不随意填数。' + PREBUILT_TERMINAL_TEXT_RULE;

function relationEntries(value) {
  if (isRecord(value)) return Object.entries(value);
  if (typeof value!=='string') return [];
  if (value.trimStart().startsWith('{')) {
    try { const parsed=JSON.parse(value); return isRecord(parsed)?Object.entries(parsed):null; } catch { return null; }
  }
  const lines=splitCharacterRelationshipLines(value);
  const entries=lines.map(line=>line.match(/^([^:：]+)[:：](.+)$/u)).filter(Boolean).map(([,name,relation])=>[name.trim(),relation.trim()]);
  return entries.length===lines.length || /^(?:无|未详|未知)?$/u.test(value.trim())?entries:null;
}

export function guardCanonCharacterDelta(delta,target) {
  const prior=target?.data||{};
  return (delta||[]).flatMap(op=>{
    if (!['add','set'].includes(op?.command)||!isRecord(op.data)||(op.id||op.data['0'])!==target?.id) return [op];
    const data=projectCharacterColumns(op.data);
    delete data['7'];
    delete data['15'];
    delete data['32'];
    delete data['33'];
    if (Object.hasOwn(data,'13')) {
      const incoming=relationEntries(data['13']), known=relationEntries(prior['13']);
      const nonPlayer=incoming?.filter(([name])=>!playerTarget(name));
      const player=known?.filter(([name])=>playerTarget(name));
      if (!nonPlayer?.length||!known) delete data['13'];
      else data['13']=[...nonPlayer,...player].map(([name,value])=>name+':'+value).join('；');
    }
    if (op.command==='set') {
      data['7']=prior['7']??'未识';
      data['15']=prior['15']??0;
      for(const key of ['32','33']) if(Object.hasOwn(prior,key)) data[key]=prior[key];
      if (!Object.hasOwn(data,'13')&&Object.hasOwn(prior,'13')) data['13']=prior['13'];
    }
    return Object.keys(data).some(key=>key!=='0')?[{...op,data}]:[];
  });
}

function withoutPlayerRelations(value) {
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([name])=>!playerTarget(name)));
  if (typeof value!=='string') return value;
  if (value.trimStart().startsWith('{')) {
    try { return JSON.stringify(withoutPlayerRelations(JSON.parse(value))); } catch { return value; }
  }
  return splitCharacterRelationshipLines(value).filter(line=>!playerTarget(line.split(/[:：]/u,1)[0])).join('；');
}

function validPrebuiltVariableValue(op) {
  if (!String(op.subject).startsWith('cultivationArts.'))
    return op.value===null || ['string','boolean'].includes(typeof op.value) || Number.isFinite(op.value);
  const key=cultivationArtSubjects.get(op.subject);
  return Boolean(key && op.kind==='attribute' && String(op.column)==='9' && op.action==='set' &&
    (op.key===undefined || op.key===op.subject) && isRecord(op.value) && !validateCultivationArts({[key]:op.value}).length &&
    (op.previousValue===null || isRecord(op.previousValue) && !validateCultivationArts({[key]:op.previousValue}).length) &&
    (op.beforeValue===undefined || cultivationArtStateEqual(op.beforeValue,op.previousValue)) &&
    cultivationArtStateEqual(op.terminalValue,op.value));
}

function validPeople(people, sharedStories=false) {
  return Array.isArray(people) && new Set(people.map(person => person?.name)).size === people.length &&
    people.every(person => text(person?.name) && !playerTarget(person.name) && Array.isArray(person.biography) &&
      (person.canonActorId===undefined || person.canonActorId===canonActorId(person.name)) &&
      (sharedStories && text(person.storyNodeId) ? person.prose==='' && !person.biography.length :
        text(person.prose) && person.biography.length > 0 && person.biography.every(line => text(line) && /^\[[^\]@\n]+@[^\]\n]+\]\S/u.test(line))) &&
      Array.isArray(person.variables) && person.variables.every(op => categories.has(op?.kind) && actions.has(op.action) &&
        text(op.subject) && text(op.evidence) && validPrebuiltVariableValue(op)));
}

function storyDependencies(nodes,node) {
  return nodes.filter(other=>other.at===node.at && other.npc.some(person=>person.storyNodeId===node.id))
    .map(other=>other.id);
}

function readEvent(event, preferFullStories=false) {
  const data = event.prebuilt;
  const original = event.referenceStart && event.referenceEnd
    ? {...event,time_start:event.referenceStart,time_end:event.referenceEnd}:event;
  const code = codeOf(event), span = entrySpan(original), source = event.content_original || '';
  if (!span || !text(source) || data?.schemaVersion !== 1 || data.eventId !== code ||
    !/^(?:full|ds-full)@\S+$/u.test(data.ruleset || '') || !Array.isArray(data.nodes) || !data.nodes.length ||
    !Array.isArray(data.world?.entries) || (!data.world.entries.length && !text(data.world.reason))) return null;
  const prefix = code + '-N';
  const compactSource = source.replace(/\s/g, '');
  const compactBrief = String(event.content_brief || '').replace(/\s/g, '');
  const seen = new Set(), named = new Set(characterNamesFromTitle(event.title));
  for (const node of data.nodes) {
    if (!node || !text(node.id) || !node.id.startsWith(prefix) || !/^\d+$/u.test(node.id.slice(prefix.length)) ||
      seen.has(node.id) || !text(node.title) || !evidenceIn(node.evidence, compactSource) ||
      !Array.isArray(node.requires) || !node.requires.every(text) || !Array.isArray(node.dependsOn) ||
      !node.dependsOn.every(id => seen.has(id)) || !validPeople(node.npc,data.formatVersion===5) ||
      node.npc.some(person => named.size && !named.has(person.name) &&
        !(data.formatVersion >= 4 && evidenceIn(person.name, compactBrief) && evidenceIn(person.name, compactSource)) ||
        person.variables.some(op => !evidenceIn(op.evidence, compactSource)))) return null;
    if (node.milestones!==undefined && (!Array.isArray(node.milestones) || node.milestones.length<2 ||
      node.milestones.at(-1)?.id!==node.id || node.milestones.some(row=>!text(row?.title)||!evidenceIn(row.evidence,compactSource)))) return null;
    let lastMinute='';
    // The daily node describes settlement. Its time can be the last milestone's time.
    for(const [index,point] of [node,...(node.milestones||[])].entries()){
      if(point.timing==null)continue;
      const timing=normalizeNodeTiming(point.timing);
      if(!timing||!nodeTimingWindow(node.at,timing)||index>0&&timing.to<lastMinute)return null;
      if(index>0)lastMinute=timing.from>lastMinute?timing.from:lastMinute;
    }
    if (node.at !== '') {
      const at = parseTimePoint(node.at);
      if (!/^\d{4}\.\d{2}\.\d{2}$/u.test(node.at) || at === null || at < span.min || at > span.max) return null;
    }
    seen.add(node.id);
  }
  if (data.formatVersion===5) {
    const anchors=new Map();
    for (const node of data.nodes) for (const person of node.npc) anchors.set(JSON.stringify([node.at,person.name]),node.id);
    for (const node of data.nodes) for (const person of node.npc) {
      const anchor=anchors.get(JSON.stringify([node.at,person.name]));
      if (anchor===node.id ? !!person.storyNodeId || person.biography.length!==1 ||
          (person.prose.match(/^### +\[/gm) || []).length!==1 : person.storyNodeId!==anchor) return null;
    }
  }
  if (!data.world.entries.every(row => seen.has(row?.nodeId) && text(row.title) && text(row.scope) && text(row.prose) &&
    evidenceIn(row.evidence, compactSource))) return null;
  if (data.formatVersion===6) {
    const latest=new Map();
    const restoredStories=new Map();
    const restoredFinal=new Map();
    let previous=-Infinity;
    for (const node of data.nodes) {
      const at=parseTimePoint(node.at);
      if (at===null || at<previous) return null;
      previous=at;
    }
    for (const node of data.nodes) for (const person of node.npc) {
      if (person.storyNodeId || !text(node.at) || !text(person.storyThrough)) return null;
      const heading=person.prose.match(/^(### +\[([^@\]\n]+)@([^\]\n]+)\])[ \t]*\r?\n/u);
      if (!heading || parseTimePoint(heading[2])!==parseTimePoint(node.at) ||
          (person.prose.match(/^### +\[/gm)||[]).length!==1) return null;
      const prior=latest.get(person.name);
      const section=heading[1]+'\n'+person.prose.slice(heading[0].length).trim();
      const next=prior ? prior.body+'\n\n'+(prior.at===node.at?section.slice(heading[1].length+1):section) : section;
      if(person.recap!==undefined&&(!cleanText(person.recap)||/^\s*#{1,6}\s/mu.test(person.recap)))return null;
      const prose=[...(prior?.prose||[]),{body:person.prose.slice(heading[0].length).trim(),recap:person.recap?.trim()}];
      const condensed=prose.map(({body,recap},i)=>i<prose.length-1&&recap?recap:body);
      const cumulative=formatPrebuiltStory(original.time_start,node.at,heading[3],condensed);
      const full=formatPrebuiltStory(original.time_start,node.at,heading[3],prose.map(row=>row.body));
      if (person.storyThrough!==next && person.storyThrough!==cumulative && person.storyThrough!==full) return null;
      if(preferFullStories&&person.storyThrough===cumulative&&cumulative!==full)restoredStories.set(JSON.stringify([node.id,person.name]),full);
      latest.set(person.name,{name:person.name,nodeId:node.id,at:node.at,body:next,prose,place:heading[3]});
    }
    if (!Array.isArray(data.finalStories) || data.finalStories.length!==latest.size ||
        new Set(data.finalStories.map(row=>row?.name)).size!==latest.size ||
        data.finalStories.some(row=>{
          const actor=latest.get(row?.name);
          if(!actor||actor.nodeId!==row.nodeId)return true;
          const full=formatPrebuiltStory(original.time_start,original.time_end,actor.place,actor.prose.map(part=>part.body));
          const short=formatPrebuiltStory(original.time_start,original.time_end,actor.place,
            actor.prose.map(({body,recap},i)=>i<actor.prose.length-1&&recap?recap:body));
          if(preferFullStories&&row.body===short&&short!==full)restoredFinal.set(row.name,full);
          return row.body!==actor.body&&row.body!==short&&row.body!==full;
        })) return null;
    if(restoredStories.size||restoredFinal.size){
      return {...data,nodes:data.nodes.map(node=>({...node,npc:node.npc.map(person=>{
        const full=restoredStories.get(JSON.stringify([node.id,person.name]));return full?{...person,storyThrough:full}:person;
      })})),finalStories:data.finalStories.map(row=>{
        const full=restoredFinal.get(row.name);return full?{...row,body:full}:row;
      })};
    }
  }
  return data;
}

export function formatPrebuiltStory(start,end,place,bodies) {
  return '### ['+start+(start===end?'':'—'+end)+'@'+place+']\n'+bodies.join('\n\n');
}

const sourceText=value=>String(value??'').replace(/\s+/gu,'');
const sourceLabel={title:'标题',content_brief:'简略条目',content_original:'原文',time_start:'起始时间',time_end:'结束时间'};

function prebuiltSourceKey(entry) {
  const times=prebuiltTimeFields.map(key=>parseTimePoint(entry[key]));
  if(times.includes(null))return '';
  const data=JSON.stringify([codeOf(entry),...prebuiltTextFields.map(key=>sourceText(entry[key])),...times]);
  // Local content identity, independent of browser origin and available synchronously in both apps.
  let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<data.length;i++){
    const c=data.charCodeAt(i);
    a=Math.imul(a^c,16777619);
    b=Math.imul(b^c,0x85ebca77);
  }
  return 'v1-'+[a,b].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}

function prebuiltSourceDifferences(row,target) {
  if(Object.hasOwn(row,'sourceKey'))return row.sourceKey&&row.sourceKey===prebuiltSourceKey(target)?[]:['来源校验值'];
  return [
    ...prebuiltTextFields.filter(key=>sourceText(row[key])!==sourceText(target[key])),
    ...prebuiltTimeFields.filter(key=>parseTimePoint(row[key])===null||parseTimePoint(row[key])!==parseTimePoint(target[key])),
  ].map(key=>sourceLabel[key]);
}

export function buildPrebuiltExchange(entries,ids = null) {
  const selected=ids===null?null:new Set(ids);
  return entries.flatMap(entry=>{
    const eventId=codeOf(entry);
    if(!eventId||!entry.prebuilt||selected&&!selected.has(eventId)) return [];
    const sourceKey=entry.sourceKey??prebuiltSourceKey(entry);
    return sourceKey?[{eventId,sourceKey,prebuilt:entry.prebuilt}]:[];
  });
}

export function attachPrebuiltProducts(entries,products) {
  const byCode=new Map(products.map(row=>[codeOf(row),row]));
  return entries.map(entry=>{
    const row=byCode.get(codeOf(entry));
    return row&&!prebuiltSourceDifferences(row,entry).length?{...entry,prebuilt:row.prebuilt}:entry;
  });
}

export function matchPrebuiltImports(entries,inputs) {
  const byCode=new Map();
  for (const entry of entries) {
    const code=codeOf(entry);
    byCode.set(code,byCode.has(code)?null:entry);
  }
  const products=new Map();
  for(const input of inputs) {
    const rows=Array.isArray(input)?input:Array.isArray(input?.events)?input.events:input?.prebuilt?[input]:[];
    const candidates=rows.filter(row=>row?.prebuilt);
    if(!candidates.length) throw new Error('文件没有预制成品');
    for(const row of candidates) {
      const code=codeOf(row),target=byCode.get(code);
      if(products.has(code)) throw new Error(code+' 在导入文件中重复');
      if(!target) throw new Error(code+' 在当前年表不存在或编号重复');
      const differences=prebuiltSourceDifferences(row,target);
      if(differences.length) throw new Error(code+' 与当前年表不一致：'+differences.join('、'));
      products.set(code,{id:code,event:target,draft:row.prebuilt});
    }
  }
  return [...products.values()];
}

export function mergePrebuiltImports(entries,inputs) {
  const imports=matchPrebuiltImports(entries,inputs);
  for(const {id,event,draft} of imports) {
    if(!readEvent({...event,prebuilt:draft})) throw new Error(id+' 的预制成品未通过游戏格式校验');
  }
  const products=new Map(imports.map(({id,draft})=>[id,draft]));
  return {count:products.size,ids:[...products.keys()],
    entries:entries.map(entry=>products.has(codeOf(entry))?{...entry,prebuilt:products.get(codeOf(entry))}:entry)};
}

export function prebuiltBoundaryEvents(events,range) {
  const end=parseTimePoint(range?.end),start=parseTimePoint(range?.start);
  const point=(row,day)=>{
    const timing=normalizeNodeTiming(row.timing),window=nodeTimingWindow(day,timing);
    if(!window||end===null)return timing?{timing}:{};
    return {timing,windowPosition:end<window.min?'ahead':start!==null&&start>window.max?'elapsed':'overlaps'};
  };
  return (events || []).flatMap(event => {
    const data = readEvent(event);
    if (!data) return [];
    return [{ code: data.eventId, formatVersion:data.formatVersion, nodes: data.nodes.map(node => ({
      id: node.id, title: node.title, at: node.at, evidence: node.evidence, requires: node.requires,
      ...point(node,node.at),
      ...(node.milestones ? {milestones:node.milestones.map(row=>({id:row.id,title:row.title,requires:row.requires,
        dependsOn:row.dependsOn,actors:row.actors,...point(row,node.at)}))} : {}),
      dependsOn:data.formatVersion===5?[...new Set([...node.dependsOn,...storyDependencies(data.nodes,node)])]:node.dependsOn,
      actors: node.npc.map(person => person.name),
      world:data.world.entries.filter(row=>row.nodeId===node.id).map(row=>row.title),
    })) }];
  });
}

export function activePrebuiltImpacts(progress) {
  const active = new Map();
  const events = (progress || []).slice().sort((a,b)=>(parseTimePoint(a.startAt)??0)-(parseTimePoint(b.startAt)??0));
  for (const event of events) for (const node of event.nodes || []) {
    const unfinished = node.state==='todo'&&node.prebuilt!=='partial';
    // A pending original milestone can already have saved consequences from the live scene.
    // Carry those impacts forward without treating unconsumed product material as fact.
    const liveActors = unfinished ? new Set((node.contributions||[])
      .filter(row=>row.livePrefix&&row.status==='applied').map(row=>row.name)) : null;
    const names = node.impact?.actors || (['repaired','cancelled'].includes(node.prebuilt) || node.state==='mutated' ? node.actors||[] : []);
    for (const name of names) if(!liveActors||liveActors.has(name))
      active.set(name,{name,nodeId:node.nodeId,reason:node.handling||node.cause||node.result});
    for (const name of node.impact?.clearedActors || []) if(!liveActors||liveActors.has(name)) active.delete(name);
  }
  return [...active.values()];
}

function openingElapsedMarkers(boundary, ledger, products) {
  const start=parseTimePoint(prebuiltSceneClock(boundary.range?.start));
  const plan=boundary.turnPlan, analysis=boundary.storyAnalysis;
  if(start===null||ledger.lastTurn||ledger.turnNo>0||!analysis?.prebuiltExceptions||
      plan.turnAdvanceTier==='outsideRange')return {};
  const history={};
  const blockedEvents=new Set([...(ledger.eventWatches||[]),...(plan.eventWatches||[]),...(analysis.eventWatches||[])]
    .filter(row=>['suspected','confirmed'].includes(row.status)).map(row=>row.eventId));
  const affectedNames=new Set((analysis.influences||[]).map(row=>row.name));
  const exceptions=new Set((analysis.prebuiltNodes||[]).filter(row=>row.status!=='ready').map(row=>row.id));
  for(const event of boundary.candidates){
    const code=codeOf(event), span=entrySpan(event), product=products.get(code);
    if(!product||!span||start<=span.min||start>=span.max||event.timingChange||blockedEvents.has(code)||
        ledger.eventProgress?.some(row=>row.eventId===code)||ledger.mutationNotes?.some(row=>row.eventId===code)||
        analysis.eventProgress?.some(row=>row.eventId===code&&
          (row.timingChange||row.status==='changed'||row.nodes?.some(node=>node.state==='mutated'))))continue;
    const reached=new Set();
    for(const node of product.nodes){
      if(exceptions.has(node.id)||node.dependsOn.some(id=>!reached.has(id))||node.actors.some(name=>affectedNames.has(name))||
          (plan.decisions||[]).some(row=>row.canonAdvance==='break'&&row.eventIds?.includes(code)&&node.actors.includes(row.name)))break;
      for(const marker of node.milestones||[node]){
        const window=nodeTimingWindow(node.at,marker.timing??(marker.id===node.id?node.timing:null));
        const last=window?.max??entrySpan({time_start:node.at,time_end:node.at})?.max;
        if(last==null||last>=start||exceptions.has(marker.id))break;
        reached.add(marker.id);
      }
      if(!reached.has(node.id))break;
    }
    if(reached.size)history[code]=[...reached];
  }
  return history;
}

// Eligibility is shared by ordinary and prebuilt replay. A matching product is a delivery method, not a task.
export function routePrebuiltBoundary(boundary, ledger) {
  const candidates=boundary?.candidates || [];
  let plan=boundary?.turnPlan;
  // Older freezes may keep the confirmed tier only in their analysis projection.
  if(candidates.length&&prebuiltBoundaryEvents(candidates).length===candidates.length&&plan&&!plan.turnAdvanceTier&&['crossEvent','sameEventProgress','sameEventNoProgress','outsideRange'].includes(boundary?.storyAnalysis?.turnAdvanceTier)){
    plan={...plan,turnAdvanceTier:boundary.storyAnalysis.turnAdvanceTier};boundary={...boundary,turnPlan:plan};
  }
  // Missing/unknown tiers must be confirmed upstream, never default to applying products.
  const unrouted=()=>{if(!plan?.route)return boundary;const {route,prebuiltMode,prebuiltActorRefs,...common}=plan;return {...boundary,turnPlan:common};};
  if(!['crossEvent','sameEventProgress','sameEventNoProgress','outsideRange'].includes(plan?.turnAdvanceTier) || !Array.isArray(plan.canonJobs) || !Array.isArray(plan.deferredRefs))return unrouted();
  const analysis=boundary.storyAnalysis || {};
  const covered=new Set(plan.coveredEventIds || []);
  const actors=boundary.analysisActors || [];
  const jobs=new Map(plan.canonJobs.map(job=>[job.name,job]));
  const deferred=new Set(plan.deferredRefs);
  const sceneFacts=new Set((analysis.factRecords || []).map(row=>row.subject));
  const heldActors=new Set((analysis.actorDecisions||[]).filter(row=>row.canonAdvance==='none').map(row=>row.name));
  const unreached=new Set(plan.ordinaryUnreachedEventIds||[]);
  const reachedMarkers=new Set(analysis.prebuiltThrough||[]);
  const progressEvents=new Set((analysis.prebuiltReached||[]).map(row=>row.eventId));
  const closedByEvidence=new Set(candidates.filter(event=>(analysis.prebuiltReached||[])
    .some(row=>row.eventId===codeOf(event)&&event.prebuilt?.nodes?.some(node=>node.id===row.id))).map(codeOf));
  const products=prebuiltBoundaryEvents(candidates);
  const matched=candidates.length>0&&products.length===candidates.length;
  const productsById=new Map(products.map(event=>[event.code,event]));
  const openingElapsed=matched?(ledger?openingElapsedMarkers(boundary,ledger,productsById):plan.openingElapsed||{}):{};
  const openingPeople=new Set();
  for(const [code,markers] of Object.entries(openingElapsed)){
    progressEvents.add(code);
    productsById.get(code)?.nodes.filter(node=>markers.includes(node.id)).forEach(node=>node.actors.forEach(name=>openingPeople.add(name)));
  }
  const endClock=prebuiltSceneClock(boundary.range?.end);
  const sameDay=matched&&products.every(event=>event.formatVersion===6)&&/^sameEvent/u.test(plan.turnAdvanceTier)&&!!endClock&&
    parseTimePoint(boundary.range?.start)!==null&&parseTimePoint(boundary.range.start)>=parseTimePoint(endClock.slice(0,10));
  const breakActors=new Set((plan.decisions||[]).filter(row=>row.canonAdvance==='break').map(row=>row.name));
  const hasMutation=(node,name)=>analysis.prebuiltNodes?.some(row=>row.id===node.id&&row.status==='mutated'&&
    ['occurred','pending','cancelled'].includes(row.resolution)&&
    (row.actors?.includes(name)||row.withdrawnActors?.includes(name)||row.resolution==='cancelled'&&node.actors.includes(name)));
  if(sameDay){
    for(const [name,job] of jobs){
      const eventIds=job.eventIds.filter(id=>closedByEvidence.has(id)||breakActors.has(name)||
        productsById.get(id)?.nodes.some(node=>hasMutation(node,name)));
      if(eventIds.length)jobs.set(name,{...job,eventIds});
      else jobs.delete(name);
    }
  }
  const confirmedAdvancingEvents=new Set([
    ...(analysis.eventProgress||[]).filter(row=>row.occurred?.length||row.nodes?.some(n=>n.state==='done'||n.state==='mutated')).map(row=>row.eventId),
    ...candidates.filter(event=>event.prebuilt?.nodes?.some(n=>reachedMarkers.has(n.id)||n.milestones?.some(m=>reachedMarkers.has(m.id)))).map(codeOf),
  ]);
  const advancingEvents=new Set([...(!sameDay&&plan.turnAdvanceTier==='sameEventProgress'?[...covered,...confirmedAdvancingEvents]:closedByEvidence)]
    .filter(id=>!unreached.has(id)));
  const quietActors=new Set((plan.decisions||[]).filter(row=>row.canonAdvance==='none').map(row=>row.actorRef||row.name));
  const involved=actors.filter(actor=>plan.turnAdvanceTier==='outsideRange'?jobs.has(actor.name)||deferred.has(actor.actorRef):
    advancingEvents.size?actor.eventIds.some(id=>advancingEvents.has(id))||jobs.has(actor.name)||deferred.has(actor.actorRef):
    plan.turnAdvanceTier!=='crossEvent'||!covered.size||actor.eventIds.some(id=>covered.has(id))||jobs.has(actor.name));
  for(const actor of involved){
    if(deferred.has(actor.actorRef))continue;
    const eventIds=actor.eventIds.filter(id=>!covered.size||covered.has(id));
    const actualAdvance=actor.eventIds.filter(id=>advancingEvents.has(id)&&(confirmedAdvancingEvents.has(id)||!quietActors.has(actor.actorRef||actor.name)));
    if(plan.turnAdvanceTier==='crossEvent'&&covered.size&&eventIds.length){
      jobs.set(actor.name,{...jobs.get(actor.name),actorRef:actor.actorRef,name:actor.name,eventIds,depth:'full'});
    }else if(actualAdvance.length){
      const existing=jobs.get(actor.name);
      jobs.set(actor.name,{...existing,actorRef:actor.actorRef,name:actor.name,depth:existing?.depth||'incremental',
        eventIds:[...new Set([...(existing?.eventIds||[]),...actualAdvance])]});
    }else if(sameDay){
      const eventIds=actor.eventIds.filter(id=>productsById.get(id)?.nodes.some(node=>hasMutation(node,actor.name)));
      if(eventIds.length&&!jobs.has(actor.name))jobs.set(actor.name,{...actor,eventIds,depth:'incremental'});
    }else if(!jobs.has(actor.name)&&sceneFacts.has(actor.name)&&!heldActors.has(actor.name)&&plan.turnAdvanceTier!=='outsideRange'){
      jobs.set(actor.name,{actorRef:actor.actorRef,name:actor.name,eventIds:actor.eventIds,depth:'incremental'});
    }
  }
  const progressOnly=progressEvents.size&&!jobs.size&&!analysis.worldEvents?.length;
  const refs=new Set([...(sameDay||progressOnly?[]:involved),...jobs.values(),
    ...actors.filter(row=>openingPeople.has(row.name))].flatMap(row=>[row.actorRef,row.name]).concat([...openingPeople],plan.deferredRefs));
  const corridorBranches=(plan.decisions||[]).map(({actorRef,name,canonAdvance,eventIds,sourceRefs,requiredMaterials})=>({
    actorRef,name,eventIds,sourceRefs,requiredMaterials,
    branch:canonAdvance==='needs_context'?'evidence':canonAdvance==='break'?'break':'hold',
  }));
  plan={...plan,openingElapsed,canonJobs:[...jobs.values()],canonOwnedRefs:[...refs],corridorBranches,
    ...(sameDay&&!jobs.size?{mode:progressOnly?'progress_only':'none'}:{}),
    ordinaryTargetRefs:(boundary.ordinaryCandidates||plan.ordinaryTargetRefs||[]).filter(ref=>!refs.has(ref))};
  boundary={...boundary,turnPlan:plan};
  if(plan.deferredRefs.length){
    const deferredBoundary=unrouted();
    return matched?{...deferredBoundary,turnPlan:{...deferredBoundary.turnPlan,prebuiltMode:'evidence'}}:deferredBoundary;
  }
  if(!plan.canonJobs.length && !boundary?.storyAnalysis?.worldEvents?.length&&!progressEvents.size)return unrouted();
  if (!matched) return boundary;
  if(progressOnly&&!Object.keys(openingElapsed).length)return {...boundary,turnPlan:{...plan,route:'prebuilt',mode:'progress_only',prebuiltMode:'direct',prebuiltActorRefs:[]}};
  const prebuiltMode=corridorBranches.some(row=>row.branch==='break')||analysis.influences?.length ||
    analysis.prebuiltNodes?.some(row=>['mutated','uncertain'].includes(row.status))?'repair':'direct';
  return {...boundary,turnPlan:{...plan,route:'prebuilt',mode:'prebuilt',prebuiltMode,prebuiltActorRefs:plan.canonOwnedRefs}};
}

export function samePrebuiltActorBaseline(left,right) {
  if(!isRecord(left)||!isRecord(right))return false;
  const normalize=row=>{
    const result=projectCharacterColumns(row);
    if(typeof result['11']==='string')try{result['11']=JSON.parse(result['11']);}catch{}
    return result;
  };
  return cultivationArtStateEqual(normalize(left),normalize(right));
}

// Settle the new node against the live row. Product before/after are evidence,
// never replacements for the live row.
export function mergeLegacyPrebuiltActorStep(current, {productBefore,productAfter,details,legacyOperations}, playerNames=[], savedDifference) {
  const supported=field=>{
    const key=field.path.join('.');
    if(key==='16')return !!prebuiltProfilePlace(String(field.after||'').split('|')[2]);
    if(key==='9.年龄')return Number.isFinite(field.after);
    return isPrebuiltEventField(field)||isPrebuiltSnapshotColumn(field.path[0]);
  };
  const blocked=new Set();
  const explicit=[];
  const operations=legacyOperations||details.operations||[];
  for(const op of operations){
    if(playerOperation(op)||isRetiredCharacterOperation(op))continue;
    const column=String(op.column??'');
    let path;
    if(op.kind==='currency'&&column==='26')path=['26'];
    const grade=prebuiltSpiritGrade(op);
    if(grade)path=['9','spiritStoneGrades',grade];
    if(op.kind==='attribute'&&column==='11'&&whiteAttributes.has(op.subject))path=['11',op.subject,'current'];
    if(op.kind==='relationship'&&column==='13')path=['13',op.subject];
    if(op.kind==='goal'&&['27','28','29'].includes(column))path=[column];
    if(op.kind==='status'&&['4','31'].includes(column))path=[column];
    if(op.kind==='skill'&&column==='9'&&['gain','set','remove','lose'].includes(op.action)){
      const prior=productBefore?.['9']?.skills?.find(skill=>skill['1']===op.subject);
      const next=productAfter?.['9']?.skills?.find(skill=>skill['1']===op.subject);
      if(next||prior){
        const key='@'+JSON.stringify([op.subject,(next||prior)['2']||'']);
        const path=['9','skills',key],oldValue=op.previousValue,newValue=op.terminalValue;
        if((prior?.['7']??null)===(oldValue??null)&&(next?.['7']??null)===(newValue??null)){
          blocked.add(JSON.stringify(path));
          explicit.push({path,...(prior?{before:prior}:{}),...(next?{after:next}:{})});
        }
      }
      continue;
    }
    if(op.kind==='item'&&column==='9'){
      const inventory=[...(current['9']?.inventory||[]),...(productBefore?.['9']?.inventory||[]),...(productAfter?.['9']?.inventory||[])];
      const type=op.item?.columns?.['2']||op.item?.type;
      const matches=inventory.filter(item=>item['1']===op.subject&&(!type||item['2']===type));
      const types=new Set(matches.map(item=>item['2']));
      if(types.size===1||!types.size&&type)path=['9','inventory','@'+JSON.stringify([op.subject,type||[...types][0]])];
    }
    if(!path)continue;
    const key=JSON.stringify(path);
    const before=op.previousValue,after=op.terminalValue;
    const delta=['add','gain','consume','lose'].includes(op.action)&&Number.isFinite(op.value)?
      (['consume','lose'].includes(op.action)?-op.value:op.value):null;
    if(column==='9'&&op.kind==='item'){
      if(!Number.isSafeInteger(delta)||!delta)continue;
      blocked.add(key);
      explicit.push({path,itemDelta:delta,item:op.item?.columns||productAfter?.['9']?.inventory?.find(item=>item['1']===op.subject&&'@'+JSON.stringify([item['1'],item['2']])===path[2])});
    }else if(delta!==null&&(['26','11'].includes(column)||grade)){
      if(before!=null&&after!=null&&Number(after)-Number(before)!==delta)continue;
      blocked.add(key);
      explicit.push({path,delta});
    }else if(Object.hasOwn(op,'previousValue')&&['set','remove'].includes(op.action)){
      blocked.add(key);
      explicit.push({path,...(before!=null?{before}:{}),...(op.action==='set'?{after:op.value}:{})});
    }
  }
  const audited=(details.fields||[]).filter(supported);
  const inferred=eventFieldChanges(productBefore,productAfter).filter(field=>{
    const [column,key,part]=field.path;
    if(!supported(field)||['4','16'].includes(column)&&!field.before||
      !Object.hasOwn(productBefore||{},column)||!Object.hasOwn(productAfter||{},column))return false;
    if(column==='9'&&key!=='spiritStoneGrades'&&(!Object.hasOwn(productBefore['9']||{},key)||!Object.hasOwn(productAfter['9']||{},key)))return false;
    if(column==='11'&&(!part||!Object.hasOwn(productBefore['11']?.[key]||{},part)||
      !Object.hasOwn(productAfter['11']?.[key]||{},part)))return false;
    return !audited.some(row=>JSON.stringify(row.path)===JSON.stringify(field.path));
  });
  let result=current;
  for(const field of [...explicit,...audited.concat(inferred).filter(field=>!field.path.some((_,i)=>blocked.has(JSON.stringify(field.path.slice(0,i+1))))) ]){
    const [column,key,part]=field.path;
    if(column==='13'&&(playerTarget(key)||playerNames.includes(key)))continue;
    if(field.itemDelta!==undefined){
      const notes=result['9'],items=notes?.inventory;
      if(!Array.isArray(items)||Object.values(notes.equipment||{}).flat().some(item=>item&&'@'+JSON.stringify([item['1'],item['2']])===part))continue;
      const hits=items.filter(item=>'@'+JSON.stringify([item['1'],item['2']])===part);
      if(hits.length>1)continue;
      const old=hits[0],quantity=(old?Number(old['5']):0)+field.itemDelta;
      const item=old||compileNativeItem(field.item);
      if(!Number.isSafeInteger(quantity)||quantity<0||!item)continue;
      const change={path:field.path,...(old?{before:old}:{}),...(quantity?{after:{...item,...(old?{}:{0:null}),5:String(quantity)}}:{})};
      result=applyEventFieldChanges(result,[change],{prebuilt:true})||result;
      continue;
    }
    const recorded=savedDifference?.fields.find(row=>JSON.stringify(row.path)===JSON.stringify(field.path));
    const useRecorded=Number.isFinite(field.delta)&&Number.isFinite(recorded?.delta)&&
      Number.isFinite(Number(field.before))&&Number.isFinite(Number(field.after))&&
      Number(recorded.before)===Number(field.before)&&Number(field.after)-Number(field.before)===field.delta;
    let changed;
    if(useRecorded){
      const live=field.path.reduce((parent,key)=>parent?.[key],result);
      const expected=Number(field.before)+recorded.delta;
      if(live!=null&&Number(live)===expected){
        const total=Number(field.after)+recorded.delta;
        if(total<0)continue;
        changed=applyEventFieldChanges(result,[{path:field.path,before:live,after:typeof live==='string'?String(total):total}],{prebuilt:true});
      }
    }
    if(!changed)changed=applyEventFieldChanges(result,[field],{prebuilt:true});
    if(column==='11'&&changed?.['11']?.[key]?.current>changed['11'][key].max)continue;
    if(changed)result=changed;
  }
  return result;
}

const touchesActor=(operation,id)=>[operation?.id,operation?.data?.['0'],operation?.owner,operation?.from,operation?.to].includes(id);
export function prebuiltOrdinaryActorState(name, context={}) {
  const base=context.ordinarySettlement;
  const exact=Object.entries(base?.afterRows || {}).filter(([,row])=>String(row?.['1']||'').split('|')[0].replace(/<[^>]*>/g,'').trim()===name);
  const id=context.characters?.[name]?.id || (exact.length===1?exact[0][0]:'');
  const row=id&&base?.afterRows?.[id];
  if(!row)return null;
  const records=(base.records || []).filter(record=>touchesActor(record.operation,id));
  if(!records.length)return null;
  const before=context.beforeStateRows?.[id], columns=new Set();
  if(before)for(const key of new Set([...Object.keys(before),...Object.keys(row)])) {
    if(JSON.stringify(before[key])!==JSON.stringify(row[key]))columns.add(key);
  }
  for(const record of records) {
    const op=record.operation || {};
    if(record.kind==='items')columns.add('9');
    else if(op.data&&typeof op.data==='object')Object.keys(op.data).forEach(key=>columns.add(key));
    else if(op.command==='updateAttribute')columns.add('11');
    else if(!before)Object.keys(row).forEach(key=>columns.add(key));
  }
  columns.delete('0');columns.delete('35');
  for(const key of [...columns])if(isRetiredCharacterColumn(key))columns.delete(key);
  return {id,afterRow:structuredClone(projectCharacterColumns(row)),...(before?{beforeRow:structuredClone(projectCharacterColumns(before))}:{}),protectedColumns:[...columns],records:structuredClone(projectCharacterRecords(records))};
}

function applyExactPrebuiltAdjustment(entry, answer, storyAnalysis) {
  const adjustments=answer.adjustments;
  if(!Array.isArray(adjustments)||!adjustments.length||answer.status!=='mutated'||answer.resolution!=='occurred'||
    answer.reviseWorld||answer.withdrawnActors?.length||entry.prior||entry.clipActors?.length||
    parseTimePoint(answer.at)!==parseTimePoint(entry.node.at)||answer.title!==entry.node.title)return null;
  const expected=new Set(answer.actors||[]);
  if(expected.size!==adjustments.length||new Set(adjustments.map(row=>row?.name)).size!==adjustments.length)return null;
  const replacements=new Map();
  for(const row of adjustments){
    if(!expected.has(row.name)||row.column!=='26'||!Number.isSafeInteger(row.beforeAmount)||!Number.isSafeInteger(row.afterAmount)||
      row.beforeAmount<=0||row.afterAmount<0||row.afterAmount===row.beforeAmount)return null;
    const fact=(storyAnalysis.factRecords||[]).find(fact=>fact.id===row.factId&&fact.subject===row.name);
    if(!text(row.originalText)||!text(row.actualText)||!fact?.evidence?.includes(row.actualText))return null;
    const expression=new RegExp('(?<!\\d)'+row.beforeAmount+'(?!\\d)','u');
    if(!expression.test(row.originalText)||row.originalText.replace(expression,String(row.afterAmount))!==row.actualText)return null;
    const person=entry.node.npc.find(person=>person.name===row.name);
    const operation=person?.variables?.find(op=>op.kind==='currency'&&op.action==='add'&&op.value===row.beforeAmount&&
      Number.isSafeInteger(op.previousValue)&&op.previousValue+op.value===op.terminalValue);
    if(!operation||person.columns?.['26']!==operation.terminalValue||
      person.prose.split(row.originalText).length!==2)return null;
    const terminalValue=operation.previousValue+row.afterAmount;
    const updateText=value=>String(value||'').replaceAll(row.originalText,row.actualText);
    if((person.biography||[]).some(line=>expression.test(line)&&!line.includes(row.originalText)))return null;
    const changed={...person,prose:updateText(person.prose),biography:person.biography.map(updateText),
      ...(person.storyThrough?{storyThrough:updateText(person.storyThrough)}:{}),columns:{...person.columns,26:terminalValue},
      variables:person.variables.flatMap(op=>op!==operation?[op]:row.afterAmount?[{...op,value:row.afterAmount,terminalValue,evidence:fact.evidence}]:[])};
    replacements.set(row.name,changed);
  }
  return {...entry,repaired:true,exactAdjustment:true,
    impact:{actors:[...expected],clearedActors:[]},
    node:{...entry.node,npc:entry.node.npc.map(person=>replacements.get(person.name)||person)}};
}

export function planPrebuiltTurn({ boundary, ledger, characters, beforeStateRows={}, timeline=boundary?.candidates||[], onReject=()=>{} }) {
  const eligibility=boundary?.turnPlan;
  const scoped=Boolean(eligibility?.turnAdvanceTier);
  const jobs=scoped?(eligibility.canonJobs || []):null;
  const worldJobs=new Set((boundary?.storyAnalysis?.worldEvents || []).map(row=>row.code));
  const confirmations=new Map((boundary.storyAnalysis.prebuiltReached||[]).map(row=>[row.id,row]));
  const progressEvents=new Set([...confirmations.values()].map(row=>row.eventId));
  const openingPositions=new Map(Object.entries(eligibility?.openingElapsed||{}).map(([code,ids])=>[code,new Set(ids)]));
  for(const code of openingPositions.keys())progressEvents.add(code);
  const crossEvent=eligibility?.turnAdvanceTier==='crossEvent';
  const wantsActor=(name,code,nodeId)=>!scoped||openingPositions.get(code)?.has(nodeId)||
    jobs.some(job=>job.name===name && (job.eventIds || []).includes(code));
  if(scoped && (eligibility.deferredRefs?.length || (!jobs.length&&!worldJobs.size&&!progressEvents.size)))return null;
  const decisions = boundary?.storyAnalysis?.prebuiltNodes;
  const exceptionMode=boundary?.storyAnalysis?.prebuiltExceptions===true;
  const events = (boundary?.candidates || []).filter(event=>!scoped || progressEvents.has(codeOf(event)) || worldJobs.has(codeOf(event)) || jobs.some(job=>job.eventIds?.includes(codeOf(event)))).slice().sort((a,b)=>
    (entrySpan(a)?.min??Infinity)-(entrySpan(b)?.min??Infinity));
  const end = parseTimePoint(boundary?.range?.end);
  const reject=reason=>{onReject(reason);return null;};
  if (!events.length || end === null || !Array.isArray(decisions) || (!exceptionMode&&!decisions.length)) return reject('边界没有返回有效的预制节点判断');
  const knownNodes=new Set((boundary?.candidates||[]).flatMap(event=>event.prebuilt?.nodes?.map(node=>node.id)||[]));
  if(decisions.some(row=>!knownNodes.has(row?.id)))return reject('边界包含未匹配的预制节点');
  const scopedNodes=new Set(events.flatMap(event=>event.prebuilt.nodes.map(node=>node.id)));
  const answers = new Map(decisions.filter(row=>scopedNodes.has(row?.id)).map(row => [row?.id, row]));
  if (new Set(decisions.map(row=>row?.id)).size !== decisions.length) return null;
  const sceneClock=prebuiltSceneClock(boundary.range.end);
  const sceneDay=sceneClock.slice(0,10);
  const sceneDayStart=parseTimePoint(sceneDay||(parseTimePrecision(boundary.range.end)==='day'?boundary.range.end:null));
  const startClock=prebuiltSceneClock(boundary.range.start);
  const rangeStart=startClock?parseTimePoint(startClock):null;
  const impacts=activePrebuiltImpacts(ledger.eventProgress);
  const missingPointerReason='进度指针尚未确认经过本节点';
  const pointerPositions=new Map(openingPositions);
  const inferredHistory=new Set();
  const hasModelPointer=Array.isArray(boundary.storyAnalysis.prebuiltThrough);
  if(hasModelPointer||exceptionMode){
    const reached=new Set([...(hasModelPointer?boundary.storyAnalysis.prebuiltThrough:[]),...confirmations.keys()]);
    const covered=new Set(eligibility?.coveredEventIds||[]);
    const watches=new Map([...(ledger.eventWatches||[]),...(boundary.storyAnalysis.eventWatches||[]),...(eligibility?.eventWatches||[])].map(row=>[row.eventId,row.status]));
    const affectedNames=new Set([...impacts,...(boundary.storyAnalysis.influences||[])].map(row=>row.name));
    const observedByEvent=new Map((boundary.storyAnalysis.eventProgress||[]).map(row=>[row.eventId,row]));
    const lastEnteredSameDay=events.findLastIndex(event=>event.prebuilt.formatVersion===6&&
      event.prebuilt.nodes.some(node=>node.at===sceneDay&&
        (reached.has(node.id)||node.milestones?.some(step=>reached.has(step.id))||
          observedByEvent.get(codeOf(event))?.nodes?.some(row=>row.nodeId===node.id&&row.state==='done'))));
    for(const [index,event] of events.entries()){
      if(event.prebuilt.formatVersion!==6)continue;
      const code=codeOf(event);
      const nodes=event.prebuilt.nodes;
      const markers=nodes.flatMap(node=>node.milestones?.map(step=>step.id)||[node.id]);
      const reachedIndex=markers.findLastIndex(id=>reached.has(id));
      const old=ledger.eventProgress?.find(row=>row.eventId===code);
      const observed=observedByEvent.get(code);
      const eligibleHistory=exceptionMode&&crossEvent&&covered.has(code)&&!event.timingChange&&
        (!observed||observed.resolved===true&&observed.status==='completed')&&
        !['suspected','confirmed'].includes(watches.get(code))&&
        !nodes.some(node=>node.npc.some(person=>affectedNames.has(person.name))||
          answers.has(node.id)&&answers.get(node.id)?.status!=='ready')&&
        !(eligibility.decisions||[]).some(row=>['break','needs_context'].includes(row.canonAdvance)&&row.eventIds?.includes(code));
      const onlyUnconfirmedPointer=old?.status==='ongoing'&&!old.changes?.length&&old.nodes?.some(node=>node.prebuilt==='pending')&&
        old.nodes.every(node=>node.state==='done'&&node.prebuilt==='applied'||node.state==='todo'&&node.prebuilt==='pending'&&
          node.handling===missingPointerReason&&!node.impact&&!node.contributions?.length);
      const cleanHistory=eligibleHistory&&(reachedIndex<0||onlyUnconfirmedPointer)&&sceneDayStart!==null&&
        (entrySpan(event)?.max??Infinity)<sceneDayStart&&(!old||old.resolved===true||onlyUnconfirmedPointer);
      // A settled clock establishes prior history. Within this round, require entry
      // into a later event before using the end clock to settle earlier events.
      const cutoff=index<lastEnteredSameDay?end:rangeStart;
      const sameDayHistory=eligibleHistory&&!!sceneClock&&parseTimePoint(event.time_end)===sceneDayStart&&
        nodes.at(-1).at===sceneDay&&cutoff!==null&&
        (!old||old.resolved===true&&old.status==='completed'||onlyUnconfirmedPointer)&&nodes.every(node=>{
          if(node.at!==sceneDay)return (parseTimePoint(node.at)??Infinity)<sceneDayStart;
          const closing=node.milestones?.at(-1);
          const time=nodeTimingWindow(node.at,closing?.timing??node.timing);
          return time&&time.max<cutoff;
        });
      if(hasModelPointer||reachedIndex>=0||cleanHistory||sameDayHistory)
        pointerPositions.set(code,new Set(cleanHistory||sameDayHistory?markers:
          [...(openingPositions.get(code)||[]),...markers.slice(0,reachedIndex+1)]));
      if((cleanHistory||sameDayHistory)&&reachedIndex<markers.length-1)inferredHistory.add(code);
    }
  }
  const deferredSameDay=new Set();
  let earlierEventPending=false;
  for(const event of events){
    if(!exceptionMode||!sceneDay||event.prebuilt.formatVersion!==6)continue;
    const code=codeOf(event);
    const nodes=event.prebuilt.nodes;
    const observed=boundary.storyAnalysis.eventProgress?.find(row=>row.eventId===code);
    const saved=(ledger.eventProgress||[]).find(row=>row.eventId===code);
    const pointer=pointerPositions.get(code);
    const hasEvidence=pointer?.size||observed?.occurred?.length||observed?.nodes?.some(row=>row.state==='done')||
      observed?.resolved&&observed.status==='completed'||saved?.occurred?.length||
      saved?.nodes?.some(row=>['applied','repaired'].includes(row.prebuilt)||row.reachedMilestoneId)||
      (!pointer&&nodes.some(node=>answers.get(node.id)?.status==='ready'||answers.get(node.id)?.resolution==='occurred'));
    if(earlierEventPending&&parseTimePoint(event.time_start)===parseTimePoint(sceneDay)&&!hasEvidence){
      deferredSameDay.add(code);
      continue;
    }
    if(parseTimePoint(event.time_end)===parseTimePoint(sceneDay)&&nodes.some(node=>{
      const answer=answers.get(node.id);
      return node.at===sceneDay&&(answer?.status==='pending'||answer?.resolution==='pending'||
        pointer&&!pointer.has(node.id)&&!saved?.nodes?.some(row=>row.nodeId===node.id&&['applied','repaired','cancelled'].includes(row.prebuilt)));
    }))earlierEventPending=true;
  }
  const plan = { ready: [], repair: [], pending: [], cancelled: [], events: [], confirmations, deferredEventIds:[...deferredSameDay], seenActors: new Set([
    ...(ledger.lastTurn?.updatedNames || []),
    ...(ledger.eventProgress || []).flatMap(row => (row.nodes || []).filter(node => node.state !== 'todo').flatMap(node => node.actors || [])),
  ]) };
  plan.scenePresence=new Map((boundary.storyAnalysis.handled||[]).filter(row=>typeof row.presentAtEnd==='boolean')
    .map(row=>[row.name,row.presentAtEnd]));
  const handled = new Set((boundary.storyAnalysis.handled || []).map(row => row.name));
  const influenced = new Set([...(boundary.storyAnalysis.influences || []).map(row => row.name),...(boundary.turnPlan.decisions || []).filter(row=>row.canonAdvance==='break').map(row=>row.name)]);
  const changedInScene = new Set((boundary.storyAnalysis.factRecords || []).map(row=>row.subject).filter(name=>handled.has(name)));
  const latestActorNode=new Map();
  for(const event of events)for(const node of event.prebuilt.nodes){
    if(deferredSameDay.has(codeOf(event)))continue;
    const pointer=pointerPositions.get(codeOf(event));
    if(pointer&&!pointer.has(node.id)&&!node.milestones?.some(step=>pointer.has(step.id)))continue;
    const at=parseTimePoint(node.at);
    if(at===null||at>end)continue;
    for(const person of node.npc){
      if(!wantsActor(person.name,codeOf(event),node.id))continue;
      const latest=latestActorNode.get(person.name);
      if(!latest||latest.at<=at)latestActorNode.set(person.name,{id:node.id,at});
    }
  }
  const namedExceptions=new Set(decisions.filter(row=>['mutated','uncertain'].includes(row.status)).flatMap(row=>row.actors||[]));
  const player = new Set(Object.entries(characters || {}).filter(([, value]) => value?.id === 'B1' || value?.isPlayer)
    .flatMap(([name, value]) => [name, ...(value.aliases || [])]));
  plan.playerNames = player;
  plan.impacts = impacts;
  plan.changedActors = new Set(plan.impacts.map(row=>row.name));
  const priorActorNode=new Map(),globalStates=new Map(),partialDependencies=new Map();
  for (const event of events) {
    const data = readEvent(event,true);
    if (!data) return reject(codeOf(event)+' 没有匹配的可用成品');
    const old = (ledger.eventProgress || []).find(row => row.eventId === data.eventId);
    const saved = (old?.nodes || []).filter(node => ['applied', 'repaired', 'cancelled','partial'].includes(node.prebuilt));
    if (old?.occurred?.length && !saved.length) return reject(data.eventId+' 已有常规落地记录，不能直接覆盖');
    const previous = new Map(saved.map(node => [node.nodeId, node.prebuilt]));
    if ([...previous.keys()].some(id => !data.nodes.some(node => node.id === id))) return null;
    const states = globalStates;
    const eventOpen=scoped && parseTimePoint(event.time_start)<=end &&
      (parseTimePoint(event.time_end)>end || (data.formatVersion===6&&/\d{1,2}:\d{2}/.test(boundary.range.end)&&entrySpan(event).max>end));
    for(const [id,status] of previous)states.set(id,status);
    for (const originalNode of data.nodes) {
      const prior=(old?.nodes||[]).find(row=>row.nodeId===originalNode.id);
      const completed=new Set(prior?.prebuilt==='partial'?(prior.actors||[]):[]);
      let answer=answers.get(originalNode.id);
      const revisiting=new Set(answer?.resolution==='cancelled'?(prior?.actors||[]):[
        ...(answer?.actors||[]),...(answer?.withdrawnActors||[]),
      ]);
      const opening=openingPositions.get(data.eventId);
      const elapsedAtOpening=opening?.has(originalNode.id);
      const npc=originalNode.npc.filter(person=>wantsActor(person.name,data.eventId,originalNode.id)&&
        (!completed.has(person.name)||revisiting.has(person.name)));
      const worldAllowed=!scoped || crossEvent || worldJobs.has(data.eventId)||elapsedAtOpening;
      const remaining=originalNode.npc.filter(person=>!completed.has(person.name)&&!npc.some(row=>row.name===person.name)).map(person=>person.name);
      const node={...originalNode,npc};
      const explicit = Boolean(answer);
      answers.delete(node.id);
      const actorDependencies=node.npc.map(person=>priorActorNode.get(person.name)).filter(Boolean);
      for (const person of node.npc) priorActorNode.set(person.name,node.id);
      if (previous.has(node.id)&&prior?.prebuilt!=='partial') {
        if((answer?.status==='mutated'||answer?.status==='uncertain')&&(npc.length||answer?.reviseWorld)){
          plan.repair.push({code:data.eventId,formatVersion:data.formatVersion,reason:answer.reason,prior,
            node,decision:answer,world:answer?.reviseWorld?data.world.entries.filter(row=>row.nodeId===node.id):[],
            remainingActors:remaining,dependencies:node.dependsOn,continuation:true});
        }
        continue;
      }
      if(!npc.length&&!worldAllowed){
        const pointer=pointerPositions.get(data.eventId);
        const reachedMilestoneId=node.milestones?.findLast(step=>pointer?.has(step.id)||step.id===prior?.reachedMilestoneId)?.id;
        if(progressEvents.has(data.eventId)&&!opening&&!reachedMilestoneId&&!confirmations.has(node.id)&&!prior)continue;
        plan.pending.push({code:data.eventId,node:{...originalNode,npc:originalNode.npc.filter(person=>!completed.has(person.name))},world:[],remainingActors:remaining,worldPending:prior?.worldPending===true,
          reason:opening?.has(reachedMilestoneId)?'开局时钟已过该里程碑，节点尚未完成':
            reachedMilestoneId&&confirmations.has(reachedMilestoneId)?'已确认阶段进展，本轮无需新增人物补演':
            answer?.reason||(opening?'尚未确认节点已发生':'本轮没有这些人物的补演任务'),prior,reachedMilestoneId});
        states.set(node.id,prior?.prebuilt==='partial'?'partial':'pending');
        if(prior?.prebuilt==='partial')partialDependencies.set(node.id,{all:originalNode.npc.map(person=>person.name),done:[...completed],worldPending:prior.worldPending===true,mutated:Boolean(prior.impact?.actors?.length)});
        continue;
      }
      const date = parseTimePoint(node.at);
      const future=date===null ? end<entrySpan(event).max : end<date;
      const sameDayGrouped=eventOpen&&data.formatVersion===6&&node.milestones?.length>1&&
        node.at===prebuiltSceneClock(boundary.range.end).slice(0,10);
      const observed=boundary.storyAnalysis.eventProgress?.find(row=>row.eventId===data.eventId);
      const confirmed=observed?.resolved&&observed.status==='completed' ||
        observed?.nodes?.some(row=>row.nodeId===node.id&&row.state==='done');
      const pointer=pointerPositions.get(data.eventId);
      const reached=pointer?.has(node.id)||confirmed;
      const reachedMilestoneId=node.milestones?.findLast(step=>pointer?.has(step.id)||step.id===prior?.reachedMilestoneId)?.id;
      if(deferredSameDay.has(data.eventId))answer={status:'pending',reason:'同日先行事件尚未完成，本事件没有已发生的证据'};
      else if(pointer&&!reached&&answer?.resolution!=='cancelled'&&answer?.resolution!=='pending')
        answer={status:'pending',reason:answer&&answer.status!=='ready'?answer.reason:missingPointerReason};
      if(!answer&&exceptionMode)answer=future||sameDayGrouped&&!reached||node.timing&&!reached&&eventOpen
        ? {status:'pending',reason:future?'尚未到预制节点日期':'同日合并节点的末项尚未确认'}
        : {status:'ready',reason:elapsedAtOpening?'开局时钟已经过本节点，边界未发现偏离':
          inferredHistory.has(data.eventId)?'实际时钟已经过前序预制节点，边界未发现偏离':'时间已到，边界未发现偏离'};
      if (!['ready', 'mutated', 'pending','uncertain'].includes(answer?.status) || !text(answer.reason)) return reject(node.id+' 缺少可执行的预制判断');
      if (answer.status === 'ready' && future) return reject(node.id+' 尚未到期却被标为已发生');
      if (node.npc.some(person => player.has(person.name))) return null;
      const originalWorld=data.world.entries.filter(row=>row.nodeId===node.id);
      const worldPending=originalWorld.length>0&&!prior?.worldApplied&&!worldAllowed;
      const entry = { code: data.eventId, node, formatVersion:data.formatVersion, reason: answer.reason, decision:answer,
        remainingActors:remaining,worldPending,prior,reachedMilestoneId,explicit,
        world: worldAllowed&&!prior?.worldApplied?originalWorld:[] };
      if([...(answer.actors||[]),...(answer.withdrawnActors||[])].some(name=>!npc.some(person=>person.name===name)))
        return reject(node.id+' 的变异人物超出已确认补演任务，须先核对共同边界');
      if (answer.status === 'pending') {
        plan.pending.push(entry);
        states.set(node.id, 'pending');
        continue;
      }
      const dayDependencies=data.formatVersion===5?storyDependencies(data.nodes,node):[];
      const dependencies=[...node.dependsOn,...dayDependencies];
      const sceneActors=node.npc.filter(person=>latestActorNode.get(person.name)?.id===node.id&&
        !namedExceptions.has(person.name)&&(influenced.has(person.name)||!exceptionMode&&changedInScene.has(person.name))).map(person=>person.name);
      if(sceneActors.some(name=>!influenced.has(name))&&answer.status==='ready'&&date!==null)entry.decision={...answer,status:'mutated',resolution:'occurred',
        reason:'最新节点按本轮正文中的实际交汇修订本人视角',at:node.at,title:node.title,actors:sceneActors,reviseWorld:false,worldDependsOn:[]};
      const earlierSlices=(prior?.contributions||[]).filter(row=>row.livePrefix&&row.status==='applied'&&npc.some(person=>person.name===row.name));
      if(earlierSlices.length&&entry.decision.status==='ready'&&date!==null){
        entry.decision={...entry.decision,resolution:'occurred',at:node.at,title:node.title,
          actors:[...new Set(earlierSlices.map(row=>row.name))],reviseWorld:false,worldDependsOn:[]};
      }
      const affected = earlierSlices.length>0||['mutated','uncertain'].includes(answer.status) ||
        sceneActors.length>0 || (exceptionMode&&event.timingChange) ||
        dependencies.some(id => ['repair','repaired','cancelled'].includes(states.get(id)) || partialDependencies.get(id)?.mutated);
      if(earlierSlices.length&&answer.status==='ready'&&!sceneActors.length&&!event.timingChange&&
        !dependencies.some(id=>['repair','repaired','cancelled'].includes(states.get(id))||partialDependencies.get(id)?.mutated)){
        entry.clipOnly=true; // Continue a saved prefix without turning normal progress into a mutation.
      }
      const hasIndependentFields=exceptionMode&&node.npc.every(person=>data.eventDetails?.some(detail=>
        detail.nodeId===node.id&&detail.name===person.name&&detail.knownBaseline&&Array.isArray(detail.fields)));
      const needsRepair = affected || !hasIndependentFields&&(node.npc.some(person=>plan.changedActors.has(person.name)) ||
        actorDependencies.some(id=>['repair','repaired','cancelled'].includes(states.get(id)) || partialDependencies.get(id)?.mutated));
      if (needsRepair && !affected && !explicit && date!==null) entry.decision={...answer,resolution:'occurred',
        at:node.at,title:node.title,actors:[],reviseWorld:false,worldDependsOn:[]};
      if (needsRepair && (dayDependencies.length || node.npc.some(person=>person.storyNodeId))) return null;
      const blockedDependency=id=>{
        if(states.get(id)==='pending')return true;
        if(states.get(id)!=='partial')return false;
        const prior=partialDependencies.get(id),own=node.npc.filter(person=>prior?.all.includes(person.name));
        return !prior || prior.worldPending || entry.world.length>0 || !own.length || own.some(person=>!prior.done.includes(person.name));
      };
      if (dependencies.some(blockedDependency) ||
        (!needsRepair && !exceptionMode && event.timingChange)) return reject(node.id+' 的前提或依赖尚未核定');
      const exact=!eventOpen&&Array.isArray(answer.adjustments)&&
        answer.adjustments.every(item=>latestActorNode.get(item?.name)?.id===node.id)&&
        answer.adjustments.every(item=>data.eventDetails?.some(detail=>detail.nodeId===node.id&&
          detail.name===item?.name&&detail.knownBaseline&&detail.fields?.some(field=>field.path?.join('.')==='26'&&field.delta===item.beforeAmount)))&&
        !dependencies.some(id=>['repair','repaired','cancelled'].includes(states.get(id)))&&
        applyExactPrebuiltAdjustment(entry,answer,boundary.storyAnalysis);
      if(exact){
        states.set(node.id,'applied');
        plan.ready.push(exact);
        continue;
      }
      states.set(node.id, remaining.length||worldPending?'partial':needsRepair?'repair':'applied');
      if(remaining.length||worldPending)partialDependencies.set(node.id,{all:originalNode.npc.map(person=>person.name),done:[...completed,...npc.map(person=>person.name)],worldPending,mutated:needsRepair});
      if(needsRepair)entry.dependencies=dependencies;
      (needsRepair ? plan.repair : plan.ready).push(entry);
    }
    // The current event uses its own draft as an upper bound, including when canon is unchanged.
    // Only the latest reached section for each person is cut to the live scene.
    if(eventOpen){
      for(const entry of [...plan.ready,...plan.repair].filter(row=>row.code===data.eventId&&row.decision?.resolution!=='pending')){
        if(pointerPositions.get(data.eventId)?.has(entry.node.id))continue;
        const clipActors=entry.node.npc.filter(person=>latestActorNode.get(person.name)?.id===entry.node.id).map(person=>person.name);
        if(!clipActors.length)continue;
        entry.clipActors=clipActors;
        if(plan.repair.includes(entry))continue;
        plan.ready.splice(plan.ready.indexOf(entry),1);
        plan.repair.push({...entry,clipOnly:true,dependencies:entry.node.dependsOn,decision:{
          status:'ready',resolution:'occurred',reason:'正在发生，按成品修到玩家正文终点',at:entry.node.at,title:entry.node.title,
          actors:clipActors,reviseWorld:false,worldDependsOn:[],
        }});
      }
    }
    // New semantic work may occur at the same time after a reached node was saved.
    // Revise only that actor's reached product, never replay its old snapshot.
    if(scoped && eligibility.turnAdvanceTier!=='crossEvent'){
      const continuations=new Map();
      for(const job of jobs.filter(job=>job.eventIds?.includes(data.eventId))){
        if([...plan.ready,...plan.repair,...plan.pending.filter(row=>(parseTimePoint(row.node.at)??Infinity)<=end)].some(row=>row.code===data.eventId&&row.node.npc.some(person=>person.name===job.name)))continue;
        const reached=data.nodes.filter(node=>saved.some(prior=>prior.nodeId===node.id&&prior.actors?.includes(job.name))&&node.npc.some(person=>person.name===job.name)).at(-1);
        if(!reached)continue;
        if(!continuations.has(reached.id))continuations.set(reached.id,{node:reached,names:[]});
        continuations.get(reached.id).names.push(job.name);
      }
      for(const {node:original,names} of continuations.values()){
        const at=String(boundary.range.end).slice(0,10);
        const reason='共同边界确认本人新增实际任务，针对已保存节点续修，不重放历史变量';
        const prior=saved.find(row=>row.nodeId===original.id);
        const pending=plan.pending.find(row=>row.code===data.eventId&&row.node.id===original.id);
        if(pending)plan.pending=plan.pending.filter(row=>row!==pending);
        plan.repair.push({code:data.eventId,formatVersion:data.formatVersion,reason,prior,
          effectiveAt:parseTimePoint(boundary.range.end),remainingActors:original.npc.filter(person=>!names.includes(person.name)&&!prior?.actors?.includes(person.name)).map(person=>person.name),worldPending:prior?.worldPending===true,
          node:{...original,at,npc:original.npc.filter(person=>names.includes(person.name))},world:[],
          decision:{status:'mutated',resolution:'occurred',at,title:original.title,reason,actors:names,reviseWorld:false,worldDependsOn:[]},
          continuation:true});
      }
    }
    const coveredTo=parseTimePoint(old?.coveredTo);
    const canContinue=data.formatVersion===6 && (!scoped || jobs.some(job=>job.eventIds?.includes(data.eventId))) && saved.some(node=>node.prebuilt==='applied') && !old?.resolved && coveredTo!==null && coveredTo<end;
    if (canContinue && (event.timingChange || saved.some(node=>node.actors?.some(name=>
      (changedInScene.has(name)||influenced.has(name)||player.has(name))&&!plan.repair.some(row=>row.code===data.eventId&&row.node.npc.some(person=>person.name===name)))))) return null;
    plan.events.push({ event:data===event.prebuilt?event:{...event,prebuilt:data}, previous: saved, code: data.eventId, continueStory:canContinue });
  }
  // An unfinished node only needs a prefix when a confirmed mutation affects that actor.
  if(exceptionMode&&scoped&&sceneClock){
    const active=[...plan.pending,...plan.repair.filter(entry=>entry.decision?.resolution==='pending')]
      .sort((a,b)=>events.findIndex(event=>codeOf(event)===a.code)-events.findIndex(event=>codeOf(event)===b.code))
      .find(entry=>{
      if(deferredSameDay.has(entry.code))return false;
      const event=events.find(row=>codeOf(row)===entry.code),date=parseTimePoint(entry.node.at),span=entrySpan(event);
      const pointer=pointerPositions.get(entry.code);
      const answer=entry.decision;
      const observed=boundary.storyAnalysis.eventProgress?.find(row=>row.eventId===entry.code);
      const established=pointer?.size||entry.prior?.reachedMilestoneId||observed?.occurred?.length||observed?.nodes?.some(n=>n.state==='done'||n.state==='mutated')||
        plan.events.some(row=>row.code===entry.code&&row.previous.some(n=>n.state!=='todo'||n.reachedMilestoneId));
      const onPage=entry.node.npc.some(person=>handled.has(person.name));
      if(!established&&!(onPage&&(!pointer||entry.explicit&&(answer?.status==='pending'||answer?.resolution==='pending'))))return false;
      return span&&span.min<=end&&end<span.max&&date!==null&&date<=end&&
        entry.node.npc.some(person=>wantsActor(person.name,entry.code));
    });
    if(active){
      const event=events.find(row=>codeOf(row)===active.code);
      const date=sceneClock.slice(0,10);
      const id=active.node.id+'-live-'+String(eligibility.turnKey||end);
      const actorData=new Map(active.node.npc.map(person=>[person.name,person]));
      for(const node of event.prebuilt.nodes)for(const person of node.npc)
        if(handled.has(person.name)&&wantsActor(person.name,active.code)&&!actorData.has(person.name))actorData.set(person.name,person);
      for(const entry of plan.ready)for(const person of entry.node.npc)
        if(plan.scenePresence.get(person.name)===true&&!actorData.has(person.name))actorData.set(person.name,person);
      const affected=new Set([...(active.decision?.status==='mutated'?active.decision.actors||[]:[]),
        ...(eligibility.decisions||[]).filter(row=>row.canonAdvance==='break'&&row.eventIds?.includes(active.code)).map(row=>row.name)]);
      const npc=[...actorData.values()].filter(person=>affected.has(person.name)&&wantsActor(person.name,active.code)&&!player.has(person.name)&&
        !plan.repair.some(entry=>entry.code===active.code&&entry.decision?.resolution!=='pending'&&entry.clipActors?.includes(person.name))&&
        !(active.prior?.contributions||[]).some(source=>source.livePrefix&&source.floorId===eligibility.turnKey&&source.name===person.name));
      if(npc.length){
        const reason='节点未完成，只结算人物截至本轮时刻已历的片段';
        plan.repair.push({code:active.code,formatVersion:event.prebuilt.formatVersion,reason,livePrefix:active.node.id,
          floorId:eligibility.turnKey,prior:active.prior,clipOnly:true,clipActors:npc.map(person=>person.name),
          offstageActors:npc.filter(person=>!handled.has(person.name)).map(person=>person.name),
          dependencies:[],world:[],node:{...active.node,id,at:date,npc,dependsOn:[]},
          decision:{status:'ready',resolution:'occurred',reason,at:date,title:active.node.title,actors:npc.map(person=>person.name),reviseWorld:false,worldDependsOn:[]}});
      }
    }
  }
  if (answers.size) return reject('边界包含未匹配的预制节点');
  if (!plan.ready.length && !plan.repair.length && !plan.pending.length && !plan.events.some(row=>row.previous.length || row.continueStory)) return reject('本轮没有可确认的预制节点');
  const coverage = [...plan.ready, ...plan.repair];
  // In exception mode the reviewed product is authoritative for unchanged events;
  // roster membership and the ordinary world's advisory candidates are not new facts.
  if (!exceptionMode && (boundary.storyAnalysis.worldEvents || []).some(event => !coverage.some(row => row.code === event.code && (row.world.length || plan.repair.includes(row))))) return null;
  const contains = (entry, name) => entry.node.npc.some(person => person.name === name);
  if (!exceptionMode && (boundary.turnPlan.canonJobs || []).some(job => (job.eventIds || []).some(code =>
    !coverage.some(row => row.code === code && contains(row, job.name)) &&
    !plan.pending.some(row => row.code === code && contains(row, job.name)) &&
    !plan.events.some(row => row.code === code && row.previous.some(node => node.actors?.includes(job.name)))))) return null;
  plan.eligibleJobs=jobs;
  plan.pointerPositions=pointerPositions;
  plan.eligibility=eligibility;
  plan.beforeColumns=Object.fromEntries(Object.entries(characters||{}).flatMap(([name,row])=>{
    const columns=beforeStateRows?.[row?.id]||row?.data;
    return columns?[[name,columns]]:[];
  }));
  const priorProducts=new Map(), previousByNode=new Map();
  const candidates=new Map(events.map(event=>[codeOf(event),event]));
  const products=new Map(timeline.map(event=>[codeOf(event),candidates.get(codeOf(event))||event]));
  for(const [id,event] of candidates)products.set(id,event);
  const savedActors=new Map((ledger.eventProgress||[]).flatMap(row=>(row.nodes||[])
    .filter(node=>['applied','repaired','partial'].includes(node.prebuilt)).map(node=>[node.nodeId,new Set(node.actors||[])])));
  const reachedActors=new Map([...plan.ready,...plan.repair.filter(row=>row.decision?.resolution!=='pending'&&!row.livePrefix)]
    .map(({node})=>[node.id,new Set(node.npc.map(person=>person.name))]));
  for(const [code,event] of [...products].sort(([,a],[,b])=>(entrySpan(a)?.min??Infinity)-(entrySpan(b)?.min??Infinity))){
    if(!candidates.has(code)&&!event.prebuilt?.nodes?.some(node=>savedActors.has(node.id)))continue;
    const product=readEvent(event);
    if(!product)continue;
    const local=new Map();
    for(const node of product.nodes)for(const person of node.npc){
      const prior=priorProducts.get(person.name);
      const previous=local.get(person.name) ?? (prior?.at<parseTimePoint(node.at)?prior.columns:undefined);
      if(candidates.has(code)&&previous)previousByNode.set(JSON.stringify([node.id,person.name]),previous);
      local.set(person.name,person.columns);
      if(reachedActors.get(node.id)?.has(person.name)||savedActors.get(node.id)?.has(person.name)){
        const at=parseTimePoint(node.at);
        if(at!==null&&(!prior||prior.at<=at))priorProducts.set(person.name,{columns:person.columns,at});
      }
    }
  }
  plan.previousProducts=previousByNode;
  return plan;
}

function validateRepairBoundary(value, rows, context) {
  if (!Array.isArray(value?.nodes) || value.nodes.length !== rows.length) return null;
  const byId = new Map(value.nodes.map(row => [row?.id, row]));
  const unfinished = new Set();
  const start = parseTimePoint(context.start), end = parseTimePoint(context.end);
  const accepted = [];
  for (const old of rows) {
    const row = byId.get(old.node.id);
    if (!['occurred', 'cancelled', 'pending'].includes(row?.status) || !text(row.reason)) return null;
    if (row.status !== 'occurred') {
      unfinished.add(row.id);
      accepted.push({id:row.id,status:row.status,reason:row.reason});
      continue;
    }
    const names = old.node.npc.map(person => person.name);
    const withdrawn=row.withdrawnActors??[];
    const at = parseTimePoint(row.at);
    if ((old.dependencies || old.node.dependsOn).some(id => unfinished.has(id)) ||
        !text(row.title) || !/^\d{4}\.\d{2}\.\d{2}$/u.test(row.at) || at === null || end === null ||
        at > end || (start !== null && at + 1439 < start) ||
        !Array.isArray(row.actors) || new Set(row.actors).size !== row.actors.length ||
        row.actors.some(name => !names.includes(name)) ||
        !Array.isArray(withdrawn)||new Set(withdrawn).size!==withdrawn.length||
        withdrawn.some(name=>!names.includes(name)||row.actors.includes(name)) ||
        typeof row.reviseWorld !== 'boolean' ||
        !Array.isArray(row.worldDependsOn) || row.worldDependsOn.some(name => !row.actors.includes(name))) return null;
    // 日期改变时，旧正文和旧世界消息不能继续沿用旧日期。
    if (at !== parseTimePoint(old.node.at) && (row.actors.length+withdrawn.length !== names.length || old.world.length && !row.reviseWorld)) return null;
    if (row.clearedActors !== undefined && (!Array.isArray(row.clearedActors) ||
        row.clearedActors.some(name => !row.actors.includes(name)))) return null;
    accepted.push({id:row.id,status:row.status,reason:row.reason,at:row.at,title:row.title,
      actors:row.actors,withdrawnActors:withdrawn,reviseWorld:row.reviseWorld,worldDependsOn:row.worldDependsOn,clearedActors:row.clearedActors||[]});
  }
  return accepted;
}

const prebuiltStatusSnapshot=person=>person.columns?.['4']??person.statusSnapshot??
  person.terminal?.findLast(isPrebuiltStatusOperation)?.value??
  person.variables?.findLast(op=>isPrebuiltStatusOperation(op)&&op.action==='set')?.value;

function projectPrebuiltPerson(person) {
  const statusSnapshot=prebuiltStatusSnapshot(person);
  const keep=op=>!isRetiredCharacterOperation(op)&&!isPrebuiltStatusOperation(op);
  const columns=isRecord(person.columns)?coalescePrebuiltSets(projectCharacterColumns(person.columns)):null;
  return {...person,...(columns?{columns}:{}),
    ...(text(statusSnapshot)?{statusSnapshot}:{}),variables:(person.variables || []).filter(keep),
    ...(Array.isArray(person.sourceChanges)?{sourceChanges:person.sourceChanges.filter(keep)}:{}),
    ...(Array.isArray(person.ordinaryDelta)?{ordinaryDelta:person.ordinaryDelta.filter(keep)}:{})};
}

function coalescePrebuiltSets(columns){
  const original=columns?.['9'],remarks=coalesceTreasureSets(original);
  return remarks===original?columns:{...columns,'9':remarks};
}

function projectPrebuiltTaskInput(data) {
  return {...data,...(data.current?{current:projectActorProfile(data.current)}:{}),
    ...(data.ordinarySettlement?{ordinarySettlement:projectOrdinarySettlement(data.ordinarySettlement)}:{}),
    ...(Array.isArray(data.nodes)?{nodes:data.nodes.map(node=>({...node,
      ...(node.original?.name?{original:projectPrebuiltPerson(node.original)}:{})}))}:{})};
}

function prebuiltForced(context, stage, subject) {
  const replay = context.replay;
  if(replay?.prebuiltWasLanded===false&&subject&&
    [PREBUILT_REPAIR_STAGES.actor,PREBUILT_REPAIR_STAGES.variables].includes(stage))return false;
  return replay?.mode !== 'continue' && (replay?.stages?.includes(stage) ||
    replay?.scopes?.includes(subject ? stage + ':' + subject : stage));
}

function prebuiltInput(data, context, forced) {
  return JSON.stringify(forced && context.replay.extra ? {...data,playerRequest:context.replay.extra} : data);
}

export async function runPrebuiltTask(host, context, stage, subject, data, instructions, validate) {
  const actorId=context.characters?.[subject]?.id;
  const ownDifference=actorId&&[PREBUILT_REPAIR_STAGES.actor,PREBUILT_REPAIR_STAGES.variables].includes(stage)
    ?context.prebuiltActorDifferences?.find(row=>row.actorId===actorId&&row.fields?.length):null;
  if(ownDifference){
    const {eventId,nodeId,fields}=ownDifference;
    data={...data,ownLedgerDifference:{eventId,nodeId,fields}};
    instructions+='\n本人物账本差异是当前档案相对所标成品节点已保存的偏差。结合本次成品和现状维持它，只提取本节点新变化，账本差异不得重复当作本轮增减。';
  }
  if (subject && stage === PREBUILT_REPAIR_STAGES.actor) instructions += '\n' + CULTIVATION_ARTS_RULE + '\n按既有预制JSON格式返回，不输出游戏执行命令。';
  const targetKey = subject ? stage + ':' + subject : stage;
  const key = context.groupIds ? targetKey + '/组:' + JSON.stringify(context.groupIds) : targetKey;
  if (!context.targets?.some(row=>row.stage===stage && (row.subject||'')===subject)) context.targets?.push({stage,subject});
  const failures = context.failures;
  const checkpoint = context.checkpoint;
  const nodeIds=context.groupIds||context.diagnosticNodeIds||[];
  const fail = (reason, detail) => {
    failures?.push({stage,subject,reason,...(nodeIds.length?{nodeIds}:{}),...detail});
    return null;
  };
  const replay = context.replay;
  const forced = prebuiltForced(context, stage, subject);
  const modelData=projectPrebuiltTaskInput(data);
  const baseInput = JSON.stringify(modelData);
  const input = forced && replay.extra ? prebuiltInput(modelData, context, forced) : baseInput;
  if (context.signal?.aborted) return fail('已停止，可从本项继续');
  const signedInput=JSON.stringify([instructions,baseInput]);
  const digest = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signedInput))),byte=>byte.toString(16).padStart(2,'0')).join('')
    : signedInput;
  const signature = 'v2:' + digest;
  const saveReceipt=async receipt=>{
    if(!context.saveCheckpoint||receipt.stage)return true;
    try {
      const stageInfo={stage,subject,nodeIds};
      await context.saveCheckpoint(key,receipt,stageInfo);
      if(checkpoint)checkpoint[key]={...receipt,...stageInfo};
      return true;
    } catch (error) {
      fail('回执保存失败：'+String(error.message||error));
      return false;
    }
  };
  if (!forced && checkpoint?.[key]?.signature === signature) {
    const receipt=checkpoint[key];
    return await saveReceipt(receipt)?receipt.value:null;
  }
  const personScopes=replay?.scopes||[];
  const actorStages=[PREBUILT_REPAIR_STAGES.actor,PREBUILT_REPAIR_STAGES.variables,PREBUILT_REPAIR_STAGES.commit];
  if(!replay?.prebuiltWasLanded&&!replay?.stages?.length&&personScopes.length&&
    personScopes.every(scope=>actorStages.some(stage=>scope.startsWith(stage+':')))&&
    !personScopes.includes(targetKey)&&!(stage===PREBUILT_REPAIR_STAGES.variables&&personScopes.includes(PREBUILT_REPAIR_STAGES.actor+':'+subject)))
    return fail('该阶段尚未完成，等待对应人物继续',{code:'not_selected'});
  if (replay?.localOnly && !context.profileCompletion) return fail('没有相符的已验证修订结果，请选择对应的定点修订');
  const {maxInputChars} = normalizeRequestLimits(context.batchLimits);
  const inputChars = input.length + instructions.length + 1;
  const capacityReason = (chars, action) => '材料 ' + chars.toLocaleString('zh-CN') + ' 字符，超过 ' +
    maxInputChars.toLocaleString('zh-CN') + ' 字符上限 · ' + action;
  const capacityDetail = chars => ({code:'input_capacity',inputChars:chars,maxInputChars,
    largestParts:Object.entries(modelData).map(([field,value])=>({field,chars:JSON.stringify(value)?.length||0}))
      .sort((a,b)=>b.chars-a.chars).slice(0,3)});
  if (inputChars > maxInputChars) return fail(capacityReason(inputChars,'尚未发送'),{...capacityDetail(inputChars),sent:false});
  if (checkpoint) checkpoint[key] = null;
  let accepted;
  let retryChars;
  let current;
  const report=(status,reason='')=>{
    if(!current)return;
    const code=status!=='failed'?undefined:
      reason==='无法解析回包 JSON'?'json':
      reason.startsWith('variables 必须')?'variables_array':
      reason.startsWith('ordinaryDelta 必须')?'ordinary_delta_array':
      reason.startsWith('columns ') ? 'columns':
      reason.includes('prose 首行')?'prose_heading':
      reason.startsWith('变量越过')?'scope':
      reason==='模型请求失败'?'model_request':'validation';
    Object.assign(current,{status,reason,code});
    try{context.onAttempt?.({...current});}catch{}
  };
  const result = await withRetry(async ({attempt,correct})=>{
    current=null;
    const request=correct({stage,subject,targetIds:context.groupIds,json:true,messages:[{role:'user',content:instructions+'\n'+input}]});
    const chars=request.messages.reduce((sum,row)=>sum+row.content.length,0);
    if(chars>maxInputChars){
      retryChars=chars;
      throw new Error('CE_REQUEST_CAPACITY');
    }
    const started=Date.now();
    current={stage,subject,nodeIds,attempt,chars,elapsedMs:0};
    context.requests?.push(current);
    try { return await host.llmCall(request); }
    catch(error){current.elapsedMs=Date.now()-started;report('failed','模型请求失败');throw error;}
    finally { current.elapsedMs=Date.now()-started; }
  },{
    signal:context.signal,config:context.retry,validate(raw) {
      let value;
      try {
        value = typeof raw === 'string'
          ? JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/iu,'$1')) : raw;
      } catch {
        const reason='无法解析回包 JSON';
        report('failed',reason);
        return {ok:false,reason};
      }
      let reason='返回内容与所选节点、人物或成品格式不符';
      try { accepted=validate(value,message=>{reason=message;return null;}); } catch { accepted=null; }
      if (accepted != null) {report('accepted');return {ok:true};}
      report('failed',reason);
      return {ok:false,reason};
    },
  });
  if (retryChars) return fail(capacityReason(retryChars,'重试未发送'),{...capacityDetail(retryChars),sent:false});
  if (!result.ok && result.reason?.startsWith('输入超限：')) {
    return fail('模型接口拒绝本次输入 · 上下文超限',{...capacityDetail(inputChars),sent:true});
  }
  if (!result.ok || context.signal?.aborted) return fail(result.reason || '请求或核验未完成',{attempts:result.attempts,code:current?.code});
  const receipt={signature,value:accepted};
  if (checkpoint) checkpoint[key] = receipt;
  return await saveReceipt(receipt)?accepted:null;
}

export async function runPrebuiltBoundaryBatches(host, context, subject, shared, field, units, instructions, validate) {
  const stage=PREBUILT_REPAIR_STAGES.boundary;
  const forced=prebuiltForced(context,stage,subject);
  const {maxInputChars}=normalizeRequestLimits(context.batchLimits);
  const data=group=>({...shared,[field]:group.map(unit=>unit.row)});
  const fits=group=>prebuiltInput(data(group),context,forced).length+instructions.length+1<=maxInputChars;
  const run=(group,groupIds)=>runPrebuiltTask(host,groupIds?{...context,groupIds}:context,stage,subject,
    data(group),instructions,value=>validate(value,group.flatMap(unit=>unit.ids)));
  if(fits(units)||units.length<2)return run(units);

  const groups=groupPrebuiltDependencies(units);
  if(groups.length===1)return run(units);
  const batches=[];
  for(const group of groups){
    const previous=batches.at(-1);
    if(previous&&fits([...previous,...group]))previous.push(...group);
    else batches.push(group);
  }
  const results=await Promise.all(batches.map(group=>run(group,group.flatMap(unit=>unit.ids))));
  return results.some(result=>result===null)?null:results.flat();
}

function groupPrebuiltDependencies(units) {
  const parent=units.map((_,index)=>index);
  const root=index=>{while(index!==parent[index])index=parent[index];return index;};
  const byId=new Map(units.flatMap((unit,index)=>unit.ids.map(id=>[id,index])));
  units.forEach((unit,index)=>unit.dependencies.forEach(id=>{
    const dependency=byId.get(id);
    if(dependency!==undefined)parent[root(dependency)]=root(index);
  }));
  const groups=new Map();
  units.forEach((unit,index)=>{
    const key=root(index);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(unit);
  });
  return [...groups.values()];
}

function prebuiltActorMaterials(nodes, settlement, profile) {
  const storyByEvent=new Map();
  const compactNodes=nodes.map(node=>{
    const original={...node.original};
    const story=original.storyThrough;
    const previous=storyByEvent.get(node.eventId);
    if(text(story)){
      if(story===original.prose){
        delete original.storyThrough;
        original.storyThroughIsProse=true;
      }else if(previous && story.startsWith(previous.story)){
        delete original.storyThrough;
        original.storyThroughFrom={nodeId:previous.id,append:story.slice(previous.story.length)};
      }
      storyByEvent.set(node.eventId,{id:node.id,story});
    }
    const {changeBasis,...scope}=node;
    const biographyBasis=changeBasis?.filter(change=>change.kind==='biography');
    return {...scope,original,...(biographyBasis?.length?{changeBasis:biographyBasis}:{})};
  });
  if(!settlement)return {current:profile,nodes:compactNodes};
  const {afterRow,beforeRow,...receipt}=settlement;
  const changedBefore=Object.fromEntries(receipt.protectedColumns.filter(key=>beforeRow&&Object.hasOwn(beforeRow,key)&&
    JSON.stringify(beforeRow[key])!==JSON.stringify(afterRow[key])).map(key=>[key,beforeRow[key]]));
  return {current:afterRow,ordinarySettlement:{...receipt,
    ...(Object.keys(changedBefore).length?{beforeRow:changedBefore}:{})},nodes:compactNodes};
}

function prebuiltDependencyClosure(ids, dependencies) {
  const reached=new Set(ids);
  for(const id of reached)for(const dependency of dependencies.get(id)||[])reached.add(dependency);
  return [...reached];
}

// A reviewed node dependency affects landing only when its predecessor changed.
// Same-node actors can save independently unless the node has an actual shared withdrawal.
function savePrebuiltActorGroups(plan, jobs, context) {
  const names=[...new Set([...plan.ready.flatMap(row=>row.node.npc.map(person=>person.name)),
    ...(plan.events||[]).filter(row=>row.continueStory).flatMap(row=>row.previous.flatMap(node=>node.actors||[]))])];
  const byNode=new Map(plan.ready.map(row=>[row.node.id,row]));
  const nodeDependencies=new Map(plan.ready.map(row=>[row.node.id,row.dependencies||row.node.dependsOn||[]]));
  const prerequisites=new Map(names.map(name=>[name,new Set()]));
  const deferred=new Set();
  for(const row of [...plan.ready,...plan.cancelled]){
    const own=row.node.npc.map(person=>person.name);
    const withdrawn=(row.withdrawn||[]).map(person=>person.name);
    if(row.prior?.contributions?.some(source=>source.status==='applied'&&withdrawn.includes(source.name))||
      row.withdrawWorld&&row.prior?.worldApplied){
      const affected=new Set([...(row.impact?.actors||own),...withdrawn]);
      for(const name of affected)deferred.add(name);
    }
    for(const id of prebuiltDependencyClosure(row.dependencies||row.node.dependsOn||[],nodeDependencies)){
      const parent=byNode.get(id);
      if(!parent?.repaired)continue;
      if(parent.withdrawWorld)own.forEach(name=>deferred.add(name));
      const impacted=parent.impact?.actors||parent.node.npc.map(person=>person.name);
      for(const name of own)for(const predecessor of impacted)
        if(name!==predecessor&&prerequisites.has(predecessor))prerequisites.get(name)?.add(predecessor);
    }
  }
  const closure=new Map(names.map(name=>[name,prebuiltDependencyClosure(prerequisites.get(name),prerequisites)]));
  const groups=new Map(),groupByName=new Map();
  for(const name of names){
    if(groupByName.has(name))continue;
    const group=[name,...names.filter(other=>other!==name&&closure.get(name).includes(other)&&closure.get(other).includes(name))];
    groups.set(name,group);
    for(const member of group)groupByName.set(member,name);
  }
  const pending=new Map();
  function save(key){
    if(pending.has(key))return pending.get(key);
    const group=groups.get(key);
    const task=(async()=>{
      if(group.some(name=>deferred.has(name)||closure.get(name).some(other=>deferred.has(other))))return true;
      const deps=[...new Set(group.flatMap(name=>[...prerequisites.get(name)].map(other=>groupByName.get(other))))].filter(other=>other!==key);
      const [ready, earlier]=await Promise.all([Promise.all(group.map(name=>jobs.get(name)||[])),Promise.all(deps.map(save))]);
      if(group.some(name=>context.profileFailures?.has(name))||ready.some(rows=>!rows)||earlier.some(saved=>!saved)||context.signal?.aborted)return false;
      const selected=new Set(group);
      const revisions=new Map(ready.flat().map(({id,person})=>[JSON.stringify([id,person.name]),person]));
      const scoped={...plan,
        ready:plan.ready.map(row=>({...row,world:[],withdrawn:[],withdrawWorld:false,node:{...row.node,
          npc:row.node.npc.filter(person=>selected.has(person.name)).map(person=>revisions.get(JSON.stringify([row.node.id,person.name]))||person)}})),
        cancelled:plan.cancelled.map(row=>({...row,withdrawn:[],withdrawWorld:false})),
        eligibleJobs:(plan.eligibleJobs||group.flatMap(name=>plan.events.map(({code})=>({name,eventIds:[code]})))).filter(job=>selected.has(job.name)),
      };
      try {
        const payload=buildPrebuiltPayload(scoped,context.end,{start:context.start,end:context.end});
        if(!payload)throw new Error('成品终态与增减无法安全转换');
        if(payload.actors.length)await context.saveActors({...payload,world:[],withdrawalReceipts:[]});
        return true;
      } catch(error) {
        for(const subject of group)context.failures?.push({stage:PREBUILT_REPAIR_STAGES.commit,subject,reason:String(error.message||error)});
        return false;
      }
    })();
    pending.set(key,task);
    return task;
  }
  return Promise.all([...groups.keys()].map(save)).then(results=>results.every(Boolean));
}

function completeKnownPrebuiltProfile(columns,person,at){
  if(!missingPrebuiltProfileFields(columns).includes('地点'))return columns;
  const raw=columns['16'];
  if(raw!=null&&typeof raw!=='string')return columns;
  const appearance=String(raw||'').split('|');
  if(appearance.length!==5&&text(raw)&&prebuiltProfilePlace(raw))return columns;
  const date=parseTimePoint(at);
  const sameDay=value=>{
    const time=parseTimePoint(value);
    return date!==null&&time!==null&&Math.floor(time/1440)===Math.floor(date/1440);
  };
  const operation=person.variables?.findLast(op=>op.kind==='location'&&text(op.terminalValue));
  const heading=/^###\s+\[([^@\]\n]+)@([^\]\n]+)\]/u.exec(person.prose||'');
  const locations=new Set((person.biography||[]).map(line=>/^\[([^@\]\n]+)@([^\]\n]+)\]/u.exec(line))
    .filter(match=>match&&sameDay(match[1])).map(match=>prebuiltProfilePlace(match[2])).filter(Boolean));
  const place=prebuiltProfilePlace(operation?.terminalValue)||
    (heading&&sameDay(heading[1])?prebuiltProfilePlace(heading[2]):'')||
    (locations.size===1?[...locations][0]:'');
  const fields=appearance.length===5?appearance:['','','','',''];
  fields[2]=place;
  return {...columns,16:fields.join('|')};
}

function retainUnknownPrebuiltDemographics(columns){
  const missing=missingPrebuiltProfileFields(columns).filter(key=>key!=='地点');
  if(!isRecord(columns['9'])||!missing.length)return columns;
  return {...columns,9:{...columns['9'],...Object.fromEntries(missing.map(key=>[key,null]))}};
}

async function completeDirectProfiles(plan, host, context) {
  const previous=new Map(Object.entries(plan.beforeColumns||{}));
  const revised=new Map(), lanes=new Map();
  const sources=new Map((plan.events||[]).map(({code,event})=>[code,event]));
  const entries=plan.ready.slice().sort((a,b)=>(parseTimePoint(a.node.at)??0)-(parseTimePoint(b.node.at)??0));
  for(const entry of entries){
    const {node}=entry;
    for(const person of node.npc){
      if(!person.columns||entry.formatVersion!==6)continue;
      const name=person.name;
      const task=(lanes.get(name)||Promise.resolve(true)).then(async ok=>{
        if(!ok)return false;
        const columns=completeKnownPrebuiltProfile(normalizePrebuiltTerminalColumns(person.columns),person,node.at);
        const missing=missingPrebuiltProfileFields(columns);
        if(!missing.length){
          if(columns!==person.columns)revised.set(person,{...person,columns});
          previous.set(name,columns);
          return true;
        }
        const old=previous.get(name);
        const profile=columns=>{
          if(!columns)return;
          const notes=prebuiltObject(columns['9'])||columns['9'];
          return {identity:columns['2'],background:columns['10'],
            年龄:notes?.年龄,寿元:notes?.寿元,地点:columns['16']?.split('|')[2]};
        };
        const source=sources.get(entry.code);
        const result=await runPrebuiltTask(host,{...context,failures:undefined,profileCompletion:true,groupIds:[node.id+':profile']},
          PREBUILT_REPAIR_STAGES.commit,name,{missing,node:{id:node.id,at:node.at,evidence:node.evidence},
            source:{title:source?.title},person:profile(columns),previous:profile(old),prose:person.prose,biography:person.biography},
          PREBUILT_PROFILE_ESTIMATE_RULE+'只填写 missing 中有依据的字段。资料不足的字段省略。返回 JSON 对象，例如 {"地点":"五里坡"}。沿用已知前态和现有地名。',
          (value,reject)=>{
            if(!isRecord(value)||Object.keys(value).some(key=>!missing.includes(key)))
              return reject('只填写缺失的 '+missing.join('、'));
            return patchPrebuiltProfile(columns,value)||reject('年龄、寿元须为合理整数，地点须为可信地名');
          });
        if(context.signal?.aborted)return false;
        const completed=retainUnknownPrebuiltDemographics(result||columns);
        revised.set(person,{...person,columns:completed});
        previous.set(name,completed);
        return true;
      });
      lanes.set(name,task);
    }
  }
  const results=await Promise.all([...lanes].map(async ([name,task])=>[name,await task]));
  return {failures:new Set(results.filter(([,ok])=>!ok).map(([name])=>name)),
    plan:revised.size?{...plan,ready:plan.ready.map(row=>({...row,node:{...row.node,npc:row.node.npc.map(person=>revised.get(person)||person)}}))}:plan};
}

export async function repairPrebuiltTurn(plan, host, context = {}) {
  const names=[...new Set([...plan.ready,...plan.repair].flatMap(({node})=>node.npc.map(person=>person.name)))];
  plan={...plan,ordinaryActors:Object.fromEntries(names.map(name=>[name,prebuiltOrdinaryActorState(name,context)]).filter(([,value])=>value))};
  const profiles=await completeDirectProfiles(plan,host,context);
  plan=profiles.plan;
  context={...context,profileFailures:profiles.failures};
  if (!plan.repair.length) {
    if(context.saveActors&&!await savePrebuiltActorGroups(plan,new Map(),context))return null;
    return profiles.failures.size?null:plan;
  }
  const changeBasisByActorNode=new Map((plan.events||[]).flatMap(({event})=>(event?.prebuilt?.eventDetails||[])
    .filter(row=>Array.isArray(row.changes)).map(row=>[JSON.stringify([row.nodeId,row.name]),row.changes
      .filter(change=>typeof change?.point==='string'&&change.point.length<=100&&
        (change.paths?.length?change.paths.some(path=>path[0]!=='4'):change.kind!=='status'))
      .map(({kind,subject,point,evidenceRef,biographyIndex,milestoneId})=>({kind,subject,point,evidenceRef,biographyIndex,milestoneId}))])));
  const {boundary,actor,variables,world} = PREBUILT_REPAIR_STAGES;
  const {start,end,storyText} = context;
  const activeWorldEvents=host?.activeWorldEvents ? await host.activeWorldEvents(start) : '';
  const shared = {start,end,story:storyText || '',turnAdvanceTier:plan.eligibility?.turnAdvanceTier,
    ...(activeWorldEvents?{activeWorldEvents}:{})};
  const affected = plan.repair.map(({node,reason,world,dependencies,decision})=>({
    id:node.id,at:node.at,title:node.title,reason,evidence:node.evidence,requires:node.requires,
    dependencies,actors:node.npc.map(person=>person.name),world:world.map(item=>item.title),
    priorDecision:decision,
  }));
  const declared = {nodes:plan.repair.map(({node,decision})=>({...decision,id:node.id,status:decision?.resolution}))};
  const replay = context.replay;
  const selectedBoundary = replay?.mode !== 'continue' && replay?.stages?.includes(boundary);
  const checked = validateRepairBoundary(declared,plan.repair,context);
  const hasBoundaryCheckpoint=Object.keys(context.checkpoint||{}).some(key=>key===boundary||key.startsWith(boundary+'/组:'));
  const repairById=new Map(plan.repair.map(row=>[row.node.id,row]));
  const boundaryUnits=affected.map(row=>({row,ids:[row.id],dependencies:row.dependencies||[]}));
  const batchRows = !selectedBoundary && checked && !hasBoundaryCheckpoint ? checked :
    await runPrebuiltBoundaryBatches(host,context,'',shared,'affected',boundaryUnits,
      '根据正文、原有变异和已确认依赖逐项确定边界。只输出JSON {nodes:[{id,status,reason,at,title,actors,withdrawnActors,reviseWorld,worldDependsOn,clearedActors}]}。status=occurred、cancelled或pending。取消或待定只写id、status和原因。已发生用单日YYYY.MM.DD，actors只列实际需改的原人物，withdrawnActors只列明确未参加的原人物，与actors不重叠。reviseWorld只在世界大事受影响时为true，已有事件确认收束也属于影响。worldDependsOn列大事需要等待的修订人物。clearedActors只列有证据表明该人物偏离已消解者。不得把前提未成立的后续写成已发生。'+WORLD_EVENT_CLOSURE_RULE+"\n"+WORLD_EVENT_OPPORTUNITY_RULE,
      (value,ids)=>validateRepairBoundary(value,ids.map(id=>repairById.get(id)),context));
  if (!batchRows) return null;
  const rows=validateRepairBoundary({nodes:batchRows},plan.repair,context);
  if(!rows){
    context.failures?.push({stage:boundary,subject:'',reason:'分组结果未通过整体节点依赖核对'});
    return null;
  }
  const next = {...plan,ready:plan.ready.slice(),pending:plan.pending.slice(),cancelled:[]};
  const byId = new Map(rows.map(row=>[row.id,row]));
  const actorInputs = new Map();
  const worldInputs = [];
  const invalidated = new Set(plan.changedActors || []);
  const order=new Map((plan.events||[]).flatMap(({event})=>event.prebuilt.nodes.map(node=>node.id)).map((id,index)=>[id,index]));
  const compareNodes=(a,b)=>(parseTimePoint(a.sceneClock||a.at)-parseTimePoint(b.sceneClock||b.at))||
    (order.get(a.id)??Infinity)-(order.get(b.id)??Infinity);
  for (const old of plan.repair) {
    const row = byId.get(old.node.id);
    if (row.status !== 'occurred') {
      const actors = old.node.npc.map(person=>person.name);
      actors.forEach(name=>invalidated.add(name));
      next[row.status].push({...old,reason:row.reason,impact:{actors,clearedActors:[]},world:[],
        ...(row.status==='cancelled'?{withdrawn:old.node.npc,withdrawWorld:true}:{}),
        node:{...old.node,at:row.status==='pending'?old.node.at:''}});
      continue;
    }
    const withdrawn=old.node.npc.filter(person=>row.withdrawnActors.includes(person.name));
    withdrawn.forEach(person=>invalidated.add(person.name));
    const remainingNpc=old.node.npc.filter(person=>!row.withdrawnActors.includes(person.name));
    const names=remainingNpc.map(person=>person.name).filter(name=>row.actors.includes(name)||invalidated.has(name));
    const pointer = {id:row.id,eventId:old.code,at:row.at,title:row.title,reason:row.reason,dependencies:old.dependencies};
    for (const original of remainingNpc) {
      if (!names.includes(original.name)) continue;
      const parent=old.livePrefix&&plan.pending.find(entry=>entry.node.id===old.livePrefix);
      const reached=plan.pointerPositions?.get(old.code);
      const relevantChanges=changeBasisByActorNode.get(JSON.stringify([old.livePrefix||row.id,original.name]));
      const changeBasis=old.livePrefix?relevantChanges?.filter(change=>change.milestoneId&&reached?.has(change.milestoneId)):relevantChanges;
      if (!actorInputs.has(original.name)) actorInputs.set(original.name,[]);
      actorInputs.get(original.name).push({...pointer,formatVersion:old.formatVersion,
        original:old.livePrefix?{...original,variables:original.variables.filter(op=>op.milestoneId&&reached?.has(op.milestoneId))}:original,
        ...(parent?.reachedMilestoneId?{reachedMilestoneId:parent.reachedMilestoneId}:{}),
        ...(old.livePrefix?{livePrefix:true,sceneClock:prebuiltSceneClock(end),offstage:old.offstageActors?.includes(original.name)===true}:{}),
        ...((old.prior?.contributions||[]).some(source=>source.livePrefix&&source.name===original.name)?{
          priorActual:old.prior.contributions.filter(source=>source.livePrefix&&source.name===original.name&&source.status==='applied').slice(-2)
            .map(({at,prose,biography})=>({at,prose,biography})),
        }:{}),
        ...(changeBasis?.length?{changeBasis}:{}),
        ...(old.clipActors?.includes(original.name)?{stopAt:end,clipOnly:old.clipOnly===true}:{} )});
      if (row.clearedActors.includes(original.name)) invalidated.delete(original.name);
      else if(!old.clipOnly)invalidated.add(original.name);
    }
    if (row.reviseWorld) worldInputs.push({...pointer,original:old.world,dependsOn:row.worldDependsOn});
    next.ready.push({...old,reason:row.reason,repaired:!old.clipOnly,withdrawn,withdrawWorld:row.reviseWorld,
      impact:{actors:old.clipOnly?[]:[...names,...row.withdrawnActors],clearedActors:row.clearedActors},
      node:{...old.node,at:row.at,title:row.title,npc:remainingNpc}});
  }
  const jobs = new Map([...actorInputs].map(([name,inputNodes])=>[name,(async ()=>{
    const nodes=inputNodes.slice().sort(compareNodes);
    const profile=context.characters?.[name];
    const settlement=plan.ordinaryActors[name];
    const material=prebuiltActorMaterials(nodes,settlement,profile);
    const headings=nodes.map(node=>node.id+' 用「### ['+(node.sceneClock||node.at)+'@实际地点]」').join('；');
    const prose=await runPrebuiltTask(host,{...context,diagnosticNodeIds:nodes.map(node=>node.id)},actor,name,
      {...shared,name,...material,priorImpact:plan.impacts?.find(row=>row.name===name)},
      '只修订指定NPC的视角正文与生平，不生成变量。只返回 JSON {nodes:[{id,person:{name,prose,biography,storyThrough,presentAtEnd,presenceEvidence}}]}。有 changeBasis 时，只复核变异触及的记录及依据。按节点顺序，基于成品和确认的事实修订；不另补空白期，不把取消或未到的节点写成已发生。带stopAt的进行中事件只写到本轮正文时刻。livePrefix=true 表示节点未完成：在场者以玩家正文确认的交互为准；offstage=true 时按本人的该节点成品裁切到相同时间，只写截至此刻有依据的经历，不补造与玩家的交互，省略presentAtEnd。两者都禁止写未完成的结局及后续。prose是本轮新增片段；若有priorActual，只承接进storyThrough，不再写进prose或本次生平。只有明确还在玩家结束场景时填presentAtEnd=true，明确离开或不在时填false，两者都给presenceEvidence逐字正文，无法确认就省略。v6的storyThrough为该事件单段累计正文，只有一个标题；若与prose相同，可填storyThroughIsProse=true。不得重复更早事件。prose首行按模板填写，将「实际地点」换成此人所在地点：'+headings+'。',
      (value,reject)=>{
        if(!Array.isArray(value?.nodes)||value.nodes.length!==nodes.length)return reject('nodes 必须是数组，每个请求节点各返回一条');
        const results=new Map(value.nodes.map(row=>[row?.id,row?.person]));
        const accepted=new Map();
        for(const node of nodes){
          const {name:owner,prose,biography,presentAtEnd,presenceEvidence}=results.get(node.id)||{};
          const storyThrough=results.get(node.id)?.storyThroughIsProse===true?prose:results.get(node.id)?.storyThrough;
          const exactPresence=node.livePrefix&&!node.offstage&&typeof presentAtEnd==='boolean'&&text(presenceEvidence)&&
            String(storyText||'').includes(presenceEvidence);
          const stamp=value=>node.livePrefix&&typeof value==='string'?value.replace(/^(### +\[)\d{4}\.\d{2}\.\d{2}(?: +\d{1,2}:\d{2})?(?=@)/u,'$1'+node.sceneClock):value;
          const person={name:owner,prose:stamp(prose),biography,variables:[],...(storyThrough?{storyThrough:stamp(storyThrough)}:{}),
            ...(exactPresence?{presentAtEnd}:{})};
          const head=parseTimePoint(String(prose||'').match(/^### +\[([^@\]\n]+)@/u)?.[1]);
          if(owner!==name)return reject(node.id+' 的 person.name 必须为'+name);
          if(!validPeople([person]))return reject(node.id+' 的 prose 必须有正文，biography 必须是非空的「[日期@地点]经历」数组');
          if(node.formatVersion===6){
            if(head!==parseTimePoint(node.at)&&(!node.livePrefix||head!==parseTimePoint(node.sceneClock)))
              return reject(node.id+' 的 prose 首行请写成「### ['+(node.sceneClock||node.at)+'@实际地点]」，填写实际地点和日期');
            if(!text(storyThrough)||(storyThrough.match(/^### +\[/gm)||[]).length!==1)
              return reject(node.id+' 的 storyThrough 必须为本事件累计视角正文，且恰有一个「### [日期@地点]」标题');
          }
          accepted.set(node.id,person);
        }
        return Object.fromEntries(accepted);
      });
    if(!prose)return null;
    const accepted=[];
    const direct=plan.ready.flatMap(entry=>entry.node.npc.filter(person=>person.name===name)
      .map(person=>({id:entry.node.id,at:entry.node.at,person}))).sort(compareNodes);
    let previous=settlement?.afterRow||context.beforeStateRows?.[profile?.id]||profile?.data||profile;
    let previousId='';
    const usedDirect=new Set();
    for(const node of nodes){
      for(const row of direct){
        if(compareNodes(row,node)>=0||usedDirect.has(row.id))continue;
        previous=row.person.columns||previous;
        previousId=row.id;
        usedDirect.add(row.id);
      }
      const story=prose[node.id];
      if(node.clipOnly&&!node.livePrefix&&!node.priorActual?.length&&story.prose===node.original.prose&&
        JSON.stringify(story.biography)===JSON.stringify(node.original.biography)){
        const result=projectPrebuiltPerson({...node.original,...story,variables:node.original.variables});
        accepted.push({id:node.id,person:result});
        previous=result.columns||previous;
        previousId=node.id;
        continue;
      }
      const result=await runPrebuiltTask(host,{...context,groupIds:[node.id]},variables,name,{
        name,formatVersion:node.formatVersion,node:{id:node.id,at:node.at,prose:story.prose},
        ...(node.livePrefix?{livePrefix:true,sceneClock:node.sceneClock,
          staticIdentity:Object.fromEntries(['1','3','5','6','7'].filter(key=>node.original.columns?.[key]!==undefined).map(key=>[key,node.original.columns[key]]))}:{}),
        ...(node.changeBasis?.length?{changeBasis:node.changeBasis.filter(change=>change.kind!=='biography')}:{}),
        previousNodeId:previousId,previousColumns:previous?projectCharacterColumns(previous):undefined,
        previousVariables:accepted.at(-1)?.person.variables,
        ...(material.ordinarySettlement?{ordinarySettlement:material.ordinarySettlement}:{}),
      },'只从已确认的本节点NPC视角正文提取变化，在previousColumns上叠加。previousVariables仅供核对已发生变化，不重发物品、不重算前节点，不从累计正文或原著推断额外变化。livePrefix只保存已亲历片段的变量，禁止提前兑现节点终态；第16列用此人最后实际动作和地点。staticIdentity仅补身份基础，不能引入后来物品、经历或修为。没有变化返回空variables。只返回JSON {variables,columns,ordinaryDelta}，v6必须返回完整继承终态columns；第0列填null，第9及第11列用JSON对象。已有普通结算的字段保留；若本节点确有已结算之后的净变化，按variables格式附ordinaryDelta，前值、终值与档案相符。禁止写入玩家变量。'+prebuiltVariableReply,
      (value,reject)=>{
        if(!Array.isArray(value?.variables))return reject('variables 必须是逐笔变化数组，每项含 kind、action、column、subject、value、previousValue、terminalValue、evidence；无变化返回 []');
        if(value.ordinaryDelta!==undefined&&!Array.isArray(value.ordinaryDelta))
          return reject('ordinaryDelta 必须是同格式的逐笔变化数组；没有与已结算字段重叠的净变化时省略或返回 []');
        let columns=value?.columns;
        // A positional JSON array encodes the same numbered columns. Keep nulls
        // and run every field and operation through the regular validator.
        if(Array.isArray(columns))columns=Object.fromEntries(Object.entries(columns));
        if(isRecord(columns)&&profile?.id&&columns['0']===profile.id)columns={...columns,'0':null};
        if(node.formatVersion===6){
          columns=normalizePrebuiltTerminalColumns(columns,previous);
          if(isRecord(columns))columns=retainUnknownPrebuiltDemographics(
            completeKnownPrebuiltProfile(columns,{...story,variables:value.variables},node.sceneClock||node.at));
        }
        if(value.variables.some(playerOperation)||value.ordinaryDelta?.some(playerOperation))return reject('变量越过 NPC 的写入范围，删除玩家变量、对玩家的关系或受保护的玩家交互列');
        const hasSnapshot=node.formatVersion===6||isRecord(columns)&&text(columns['16']);
        const statusSnapshot=prebuiltStatusSnapshot({...value,columns});
        const person={...story,variables:value.variables.filter(hasSnapshot?isPrebuiltDeltaOperation:op=>!isPrebuiltStatusOperation(op)),columns,
          ...(text(statusSnapshot)?{statusSnapshot}:{}),
          ...(Array.isArray(value.ordinaryDelta)?{ordinaryDelta:value.ordinaryDelta.filter(isPrebuiltDeltaOperation)}:{})};
        if(!validPeople([person]))return reject('variables 包含无效条目。检查 kind、action、subject、value 和本节点正文依据 evidence');
        if(node.formatVersion===6){
          if(!isRecord(columns))return reject('columns 必须是以字符串列号为键的 JSON 对象');
          const identity=String(columns['2']||'').split('|');
          if(identity.length!==2||!text(identity[0])||!text(identity[1])||/^(?:未知|不详|未详|待补全)$/u.test(identity[1].trim()))
            return reject('columns 第 2 列必须是「境界|已知身份」。境界可据实填未知，身份沿用已确认的原著资料或前态');
          for(const resource of ['血量','法力']){
            const pool=columns['11']?.[resource];
            if(!Number.isFinite(pool?.current)||!Number.isFinite(pool?.max)||pool.current<0||pool.max<pool.current)
              return reject('columns 第 11 列的'+resource+'必须包含有效数字 current 和 max，请沿用可信基准');
          }
          const appearance=String(columns['16']||'').split('|');
          if(appearance.length!==5)return reject('columns 第 16 列须为「动作|穿着|实际地点|身段|样貌」');
          let columnIssue;
          if(!compilePrebuiltNewActor('C1',{...person,variables:[],seedColumns:columns,
            allowUnknownDemographics:true,allowMissingLocation:true},reason=>{columnIssue=reason;}))
            return reject('columns '+(columnIssue||'终态与 NPC 列格式不符。核对第 0、1、9 列和物品、技能对象，沿用前态中未变化的列'));
        }
        return projectPrebuiltPerson(repairCarriedBreakthrough(person,previous,op=>
          evidenceIn(op.evidence,story.prose.replace(/\s/g,''))?op.evidence:null));
      });
      if(!result)return null;
      accepted.push({id:node.id,person:result});
      previous=result.columns||previous;
      previousId=node.id;
    }
    return accepted;
  })()]));
  const dependencies=new Map(plan.repair.map(row=>[row.node.id,row.dependencies||row.node.dependsOn||[]]));
  const worldGroups=groupPrebuiltDependencies(worldInputs.map(row=>({
    row,ids:[row.id],dependencies:prebuiltDependencyClosure(dependencies.get(row.id)||[],dependencies),
  })));
  const worldJobs=worldGroups.map(async group=>{
    const nodes=group.map(unit=>unit.row);
    const names=[...new Set(nodes.flatMap(row=>row.dependsOn))];
    const results = await Promise.all(names.map(name=>jobs.get(name)));
    if (results.some(result=>!result)) return null;
    const relevant=group.flatMap(unit=>[unit.row.id,...unit.dependencies].flatMap(id=>
      unit.row.dependsOn.map(name=>JSON.stringify([id,name]))));
    const outcomeKeys=new Set(relevant);
    const outcomes=results.flat().filter(({id,person})=>outcomeKeys.has(JSON.stringify([id,person.name])))
      .map(({id,person})=>({id,name:person.name,prose:person.prose}));
    const groupContext=worldGroups.length>1?{...context,groupIds:nodes.map(row=>row.id)}:context;
    return runPrebuiltTask(host,groupContext,world,'',{...shared,nodes,outcomes},
    '只修改本组节点的世界大事。按每个节点的dependsOn人物、已核验正文及当前世界局势核对实际影响。只输出 JSON {nodes:[{id,world:[{nodeId,title,scope,prose,action,previousId,effect,estimatedEnd,endCondition,endsAt,endedAt,eventCategory,extensionEvidence,extendedAt,extensionUntil}]}]}。已有大事确有进展填 update，确认结束填 resolve，并引用现有编号 previousId。同一场冲突的夺哨、约战、胜负和撤离沿用原编号，撤离等结案补充保留已确认的胜负。独立发生的新局势或玩家确实可参与的重要主线、限时机缘填 add；开放条件与实际关闭时点有据即记录。未变化不给记录。只有明确按时结束的影响才填 endsAt，预计日期用 estimatedEnd；当场结束的单次消息填 endedAt。'+WORLD_EVENT_CLOSURE_RULE+"\n"+WORLD_EVENT_OPPORTUNITY_RULE,
    value=>{
      if (!Array.isArray(value?.nodes) || value.nodes.length!==nodes.length) return null;
      const results=new Map(value.nodes.map(row=>[row?.id,row?.world]));
      const accepted=nodes.map(({id})=>({id,world:results.get(id)}));
      return accepted.every(({id,world})=>Array.isArray(world) && world.every(item=>
        item?.nodeId===id && text(item.title) && text(item.scope) && text(item.prose)))?accepted:null;
    });
  });
  const actorSaves=context.saveActors?savePrebuiltActorGroups(next,jobs,context):true;
  const [people, worlds, saved] = await Promise.all([Promise.all(jobs.values()),Promise.all(worldJobs),actorSaves]);
  if (!saved || profiles.failures.size || people.some(result=>!result) || worlds.some(result=>!result) || context.signal?.aborted) return null;
  const revisions = new Map();
  for (const result of people) for (const {id,person} of result) {
    if (!revisions.has(id)) revisions.set(id,new Map());
    revisions.get(id).set(person.name,person);
  }
  const worldById = new Map(worlds.flat().map(row=>[row.id,row.world]));
  for (const entry of next.ready) {
    if (!entry.repaired && !entry.clipOnly) continue;
    const people = revisions.get(entry.node.id);
    entry.node.npc = entry.node.npc.map(person=>people?.get(person.name)||person);
    entry.world = worldById.get(entry.node.id) || entry.world;
  }
  return next;
}

export function calculatePrebuiltVariableRange(rows, {start, end, appliedNodeIds = [], includeStart = false} = {}) {
  const ordered = rows.map((entry,index)=>({entry,index,at:entry.effectiveAt ?? parseTimePoint(entry.node.at) ?? entry.fallbackAt}));
  if (ordered.some(row=>!Number.isFinite(row.at)) || new Set(ordered.map(row=>row.entry.node.id)).size!==ordered.length) return null;
  const compare = (a,b)=>a.at-b.at || a.index-b.index;
  ordered.sort(compare);
  const point = (value,first)=>{
    if (value===undefined) return first?{at:-Infinity,index:0}:{at:Infinity,index:0};
    if (isRecord(value)) return ordered.find(row=>row.entry.node.id===value.nodeId);
    const at = parseTimePoint(value);
    return at===null?null:{at,index:first&&includeStart?-Infinity:Infinity};
  };
  const from=point(start,true), to=point(end,false);
  if (!from || !to || compare(from,to)>0) return null;
  const applied = new Set(appliedNodeIds);
  const entries = ordered.filter(row=>compare(row,from)>0 && compare(row,to)<=0 && !applied.has(row.entry.node.id)).map(row=>({...row.entry,node:{...row.entry.node,npc:row.entry.node.npc.map(projectPrebuiltPerson)}}));
  const actors = new Map();
  for (const {node} of entries) for (const person of node.npc) {
    if (!actors.has(person.name)) actors.set(person.name,{operations:[],fields:new Map()});
    const actor=actors.get(person.name);
    for (const op of person.variables) {
      if (playerOperation(op) || isRetiredCharacterOperation(op)) continue;
      const key = JSON.stringify([op.kind,String(op.column??''),op.subject]);
      const previous = actor.fields.get(key);
      const before = op.previousValue, after = op.terminalValue;
      if (previous?.terminalValue!==undefined && before!==undefined &&
          !prebuiltFieldEqual(String(op.column??''),previous.terminalValue,before)) return null;
      const numeric = ['item','currency','attribute'].includes(op.kind) &&
        Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(op.value);
      const change = op.action==='add'||op.action==='gain' ? op.value : ['consume','lose'].includes(op.action)?-op.value:null;
      if (numeric && change!==null && Math.abs(before+change-after)>1e-8) return null;
      const initial = previous ? previous.previousValue : before;
      actor.fields.set(key,{kind:op.kind,column:op.column,subject:op.subject,previousValue:initial,terminalValue:after,
        delta:Number.isFinite(initial)&&Number.isFinite(after)?after-initial:null});
      actor.operations.push(op);
    }
  }
  return {entries,actors:new Map([...actors].map(([name,{operations,fields}])=>[name,{operations,
    changes:[...fields.values()].filter(row=>row.previousValue===undefined || row.terminalValue===undefined || row.previousValue!==row.terminalValue)}]))};
}

export function buildPrebuiltPayload(plan, end, range) {
  const actorRows = new Map();
  const cumulativeEvents=new Set(plan.events.filter(({event})=>event.prebuilt?.formatVersion===6).map(({code})=>code));
  const getActor=name=>{
    if (!actorRows.has(name)) actorRows.set(name,{name,paragraphs:[],stories:[],biography:[],variables:[],eventIds:new Set(),repaired:false});
    return actorRows.get(name);
  };
  const baselineEvents = new Set(plan.events.filter(({ event }) => event.prebuilt?.formatVersion >= 2).map(({ code }) => code));
  const nativeEvents = new Set(plan.events.filter(({ event }) => event.prebuilt?.formatVersion >= 3).map(({ code }) => code));
  const unsafeSeeds = new Set([...(plan.seenActors || []),
    ...[...plan.pending.filter(({code})=>!cumulativeEvents.has(code)),...plan.cancelled].flatMap(({node})=>node.npc.map(person=>person.name))]);
  for (const name of plan.changedActors || []) unsafeSeeds.add(name);
  for (const { previous, event } of plan.events) for (const node of previous) {
    for (const name of node.actors || event.prebuilt.nodes.find(row => row.id === node.nodeId)?.npc.map(person => person.name) || []) unsafeSeeds.add(name);
  }
  const eventsByCode = new Map(plan.events.map(row=>[row.code,row.event]));
  const columnsByActor=new Map(Object.entries(plan.beforeColumns||{}).map(([name,columns])=>
    [name,{...columns,11:prebuiltObject(columns['11'])??columns['11']}]));
  const rawByActor=new Map(columnsByActor), repairedFields=new Map();
  const productStatusByActor=new Map();
  for(const {event,previous} of plan.events){
    const reached=new Set(previous.filter(row=>row.prebuilt==='applied').map(row=>row.nodeId));
    for(const node of event.prebuilt.nodes)if(reached.has(node.id))
      for(const person of node.npc)if(typeof person.columns?.['4']==='string')productStatusByActor.set(person.name,person.columns['4']);
  }
  const entries = plan.ready.slice().sort((a, b) => (parseTimePoint(a.node.at) ?? 0) - (parseTimePoint(b.node.at) ?? 0)).map(entry=>{
    const row={...entry,node:{...entry.node,npc:entry.node.npc.map(person=>{
      const columns=coalescePrebuiltSets(person.columns);
      return columns===person.columns?person:{...person,columns};
    })}};
    if(!cumulativeEvents.has(row.code))return row;
    const source=String(eventsByCode.get(row.code)?.content_original??'').replace(/\s/g,'');
    const npc=row.node.npc.map(person=>{
      const base=columnsByActor.get(person.name);
      const carried=carryAdjustedWhiteValues(person,rawByActor.get(person.name),base);
      let adjusted=repairCarriedBreakthrough(carried,base,op=>evidenceIn(op.evidence,source)?op.evidence:null);
      if(adjusted.columns){
        const product=person.columns?.['4'];
        const current=carryCharacterStatus(base?.['4'],row.repaired||row.livePrefix?undefined:
          productStatusByActor.get(person.name)??person.previousStatus,
          adjusted.columns['4'],row.livePrefix?end:row.node.at);
        if(typeof current==='string'&&current!==adjusted.columns['4'])adjusted={...adjusted,columns:{...adjusted.columns,4:current}};
        if(typeof product==='string')productStatusByActor.set(person.name,product);
      }
      if(adjusted!==carried)repairedFields.set(JSON.stringify([row.node.id,person.name]),
        eventSourceRecord(row.code,row.node,adjusted,{before:base}).fields.filter(field=>field.path[0]==='11'));
      if(person.columns)rawByActor.set(person.name,person.columns);
      if(adjusted.columns)columnsByActor.set(person.name,adjusted.columns);
      return adjusted;
    });
    return {...row,node:{...row.node,npc}};
  });
  const canUseTerminal = !plan.repair.length && !plan.cancelled.length;
  for (const { code, node, repaired, impact, exactAdjustment, livePrefix, clipOnly } of entries) for (const person of node.npc) {
    const actor = getActor(person.name);
    if (!cumulativeEvents.has(code) && text(person.prose)) {
      const heading = person.biography[0]?.match(/^\[([^\]]+)\]/u)?.[1] || node.at;
      actor.paragraphs.push(/^### +\[[^\]\r\n]+\]/u.test(person.prose.trim()) ? person.prose.trim() :
        '### [' + heading + ']\n' + person.prose);
    }
    actor.biography.push(...person.biography);
    if(livePrefix&&typeof person.presentAtEnd==='boolean')actor.presentAtEnd=person.presentAtEnd;
    actor.liveScene ||= Boolean(livePrefix);
    actor.eventIds.add(code);
    actor.requireBaseline ||= baselineEvents.has(code);
    const revised = repaired === true && (!impact || impact.actors.includes(person.name));
    actor.repaired ||= revised;
    if(revised&&!exactAdjustment)actor.needsReseedReview=true;
    if(revised&&Array.isArray(person.ordinaryDelta))actor.ordinaryDelta=person.ordinaryDelta.filter(isPrebuiltDeltaOperation);
    actor.seedColumns = nativeEvents.has(code) && isRecord(person.columns) ? {...projectCharacterColumns(person.columns),0:null} : undefined;
    const status=prebuiltStatusSnapshot(person);
    if(text(status))actor.statusSnapshot=status;
    actor.allowUnknownDemographics = cumulativeEvents.has(code);
    actor.allowMissingLocation = actor.allowUnknownDemographics&&
      !prebuiltProfilePlace(String(actor.seedColumns?.['16']||'').split('|')[2]);
    const sourceFields=eventsByCode.get(code)?.prebuilt?.eventDetails?.find(detail=>
      detail.nodeId===node.id&&detail.name===person.name&&detail.knownBaseline&&Array.isArray(detail.fields));
    actor.requiresOperations ||= !actor.seedColumns || (!cumulativeEvents.has(code)&&!canUseTerminal) ||
      (plan.changedActors?.has(person.name)&&!revised&&!clipOnly&&!sourceFields);
    actor.requiresSnapshot ||= eventsByCode.get(code)?.prebuilt?.variablePolicy==='delta-only';
  }
  // New deltas cannot reconstruct overwrite fields when a prebuilt snapshot is unsafe.
  if ([...actorRows.values()].some(actor=>actor.requiresSnapshot&&actor.requiresOperations)) return null;
  const needsOperations=[...actorRows.values()].some(actor=>actor.requiresOperations);
  if (needsOperations) {
    const rows=entries.map(row=>({...row,fallbackAt:entrySpan(eventsByCode.get(row.code))?.max,
      node:{...row.node,npc:row.node.npc.filter(person=>actorRows.get(person.name).requiresOperations)}}));
    const calculated=calculatePrebuiltVariableRange(rows,range?{...range,includeStart:true}:{});
    if (!calculated || calculated.entries.length!==rows.length) return null;
    for (const [name,{operations}] of calculated.actors) actorRows.get(name).variables=operations;
  }
  for (const {event,code,previous,continueStory} of plan.events) {
    if (!cumulativeEvents.has(code)) continue;
    const newNodes=new Map(entries.filter(row=>row.code===code).map(row=>[row.node.id,row]));
    const reached=new Set([...previous.filter(node=>node.prebuilt==='applied').map(node=>node.nodeId),...newNodes.keys()]);
    const latest=new Map();
    for (const original of event.prebuilt.nodes) if (reached.has(original.id)) {
      const node=newNodes.get(original.id)?.node||original;
      const openingHistory=plan.eligibility?.openingElapsed?.[code]?.includes(node.id) && newNodes.has(node.id);
      for (const person of node.npc) if(openingHistory || !plan.eligibleJobs || plan.eligibleJobs.some(job=>job.name===person.name&&job.eventIds?.includes(code)))latest.set(person.name,{node,person});
    }
    for(const row of newNodes.values())if(row.livePrefix)for(const person of row.node.npc)latest.set(person.name,{node:row.node,person});
    const closed=entrySpan(event).max<=parseTimePoint(end) && !plan.pending.some(row=>row.code===code);
    for (const [name,{node,person}] of latest) {
      if (!continueStory && !actorRows.get(name)?.eventIds.has(code)) continue;
      const actor=getActor(name);
      const revised=actor.repaired;
      const final=closed && !revised && event.prebuilt.finalStories.find(row=>row.name===name && row.nodeId===node.id);
      actor.eventIds.add(code);
      const to=closed?event.time_end:end;
      const body=final?.body||person.storyThrough;
      actor.stories.push({code,body,from:node.at,to,singleRange:(body.match(/^### +\[/gm)||[]).length===1,
        needsTail:false});
    }
  }
  const contributions=new Map(), liveContributions=new Map(), withdrawalReceipts=[], sourceSteps=[];
  const before=new Map(Object.entries(plan.beforeColumns||{}));
  for(const row of [...entries,...plan.cancelled].sort((a,b)=>(parseTimePoint(a.node.at)??0)-(parseTimePoint(b.node.at)??0))){
    const {code,node,prior,world=[],withdrawn=[],withdrawWorld}=row;
    const old=prior?.contributions||[];
    const recorded=[];
    for(const person of withdrawn){
      const saved=old.find(item=>item.name===person.name&&item.status==='applied');
      if(prior?.actors?.includes(person.name)&&!saved&&!old.some(item=>item.name===person.name&&item.status==='withdrawn'))return null;
      const receipt=saved||eventSourceRecord(code,node,person,{before:before.get(person.name)});
      const deltaReceipt={...receipt,
        ...(Array.isArray(receipt.operations)?{operations:receipt.operations.filter(isPrebuiltDeltaOperation)}:{}),
        ...(Array.isArray(receipt.fields)?{fields:receipt.fields.filter(field=>field.path?.[0]!=='4')}:{})};
      if(saved)withdrawalReceipts.push(deltaReceipt);
      recorded.push({...deltaReceipt,status:'withdrawn'});
    }
    if(withdrawWorld&&prior?.worldApplied){
      const saved=old.find(item=>item.actor==='@world'&&item.status==='applied');
      if(!saved)return null;
      withdrawalReceipts.push(saved);
      recorded.push({...saved,status:'withdrawn'});
    }
    if(!plan.cancelled.includes(row)){
      for(const person of node.npc){
        const base=before.get(person.name);
        const product=eventsByCode.get(code)?.prebuilt;
        const planned=product?.eventDetails?.find(detail=>detail.nodeId===node.id&&detail.name===person.name);
        const revised=Boolean(row.repaired||row.clipOnly||row.livePrefix);
        const details=eventSourceRecord(code,node,person,{before:revised?base:undefined,
          operations:[...(person.variables||[]),...(person.sourceChanges||[])].filter(isPrebuiltDeltaOperation)});
        if(plan.eligibility?.turnKey)details.floorId=plan.eligibility.turnKey;
        if(row.livePrefix){
          details.livePrefix=true;details.nodeId=row.livePrefix;details.at=prebuiltSceneClock(end)||end;
          if(row.floorId)details.floorId=row.floorId;
        }
        const exact=row.exactAdjustment&&row.impact?.actors?.includes(person.name);
        const bioBasis=!revised||exact?planned?.changes?.find(change=>change.kind==='biography'&&change.biographyIndex===0&&change.point):null;
        if(person.biography?.length===1&&bioBasis)details.biographyBasis={point:bioBasis.point,evidenceRef:bioBasis.evidenceRef};
        const verified=Boolean(row.livePrefix?base&&person.columns:planned?.knownBaseline&&(!revised||exact||base&&person.columns));
        if(verified){
          if(!row.livePrefix&&(!revised||row.exactAdjustment))details.fields=structuredClone(planned.fields);
          if(exact){
            const currency=details.fields.find(field=>field.path.join('.')==='26');
            currency.after=person.columns['26'];
            currency.delta=Number(currency.after)-Number(currency.before);
          }
          details.knownBaseline=true;
        }
        if(!revised&&!verified&&planned?.fields?.length)details.fields=structuredClone(planned.fields);
        const whiteFields=repairedFields.get(JSON.stringify([node.id,person.name]));
        if(whiteFields)details.fields.push(...whiteFields.filter(field=>
          !details.fields.some(existing=>existing.path.join('.')===field.path.join('.'))));
        details.fields=details.fields.filter(isPrebuiltEventField);
        if(!revised&&planned?.unattributed?.length){
          const paths=planned.unattributed.filter(path=>!isPrebuiltSnapshotColumn(path[0])&&
            !(path[0]==='9'&&path[1]==='年龄'));
          if(paths.length)details.unattributed=structuredClone(paths);
        }
        recorded.push(details);
        const productAfter=product?.nodes.find(item=>item.id===(row.livePrefix||node.id))?.npc.find(item=>item.name===person.name)?.columns;
        const legacyOperations=!verified&&!revised?[...new Map([...(person.variables||[]),...(person.sourceChanges||[])]
          .filter(op=>!playerOperation(op)&&!isRetiredCharacterOperation(op))
          .map(op=>[JSON.stringify([op.kind,op.action,op.column,op.subject,op.previousValue,op.terminalValue,op.value]),op])).values()]:[];
        sourceSteps.push({sourceId:details.sourceId,name:person.name,details,verified,
          ...(!verified&&!revised?{legacy:true,productBefore:coalescePrebuiltSets(plan.previousProducts?.get(JSON.stringify([node.id,person.name])))}:{}),
          ...(legacyOperations.length?{legacyOperations}:{}),
          ...(!row.livePrefix&&productAfter?{productAfter:coalescePrebuiltSets(productAfter)}:{}),
          ...(revised&&!row.exactAdjustment&&base?{before:base}:{}),
          ...(person.columns?{columns:person.columns}:{})});
        if(person.columns)before.set(person.name,person.columns);
      }
      if(world.length)recorded.push(eventSourceRecord(code,node,null,{world}));
    }
    if(row.livePrefix)liveContributions.set(row.livePrefix,mergeEventSourceRecords(old,recorded));
    else contributions.set(node.id,mergeEventSourceRecords(old,recorded));
  }
  const nodes = (rows, source, state) => rows.map(({ node, reason, impact, remainingActors=[],worldPending=false,prior,world=[],withdrawn=[],withdrawWorld,reachedMilestoneId }) => ({
    nodeId: node.id, title: node.title, at: state === 'todo' ? '' : node.at,
    ...(node.timing?{timing:node.timing}:{}),
    ...(node.milestones?.length ? {milestones:node.milestones} : {}),
    ...(reachedMilestoneId?{reachedMilestoneId}:{}),
    ...((prior?.milestoneReceipts?.length||(node.milestones||[node]).some(step=>plan.confirmations?.has(step.id)))?{
      milestoneReceipts:[...new Map([...(node.milestones||[node]).map(step=>plan.confirmations?.get(step.id)).filter(Boolean),
        ...(prior?.milestoneReceipts||[])].map(row=>[row.id,row])).values()],
    }:{}),
    ...(state === 'todo' && node.at ? { estimatedAt: node.at } : {}),
    prebuilt: (state!=='todo'&&(remainingActors.length||worldPending))||(state==='todo'&&prior?.prebuilt==='partial')?'partial':source,
    state: state!=='todo'&&(remainingActors.length||worldPending)?'todo':state,
    original: node.evidence, actors: [...new Set([...(prior?.actors||[]),...(state==='todo'?[]:node.npc.map(person => person.name))])]
      .filter(name=>!withdrawn.some(person=>person.name===name)), handling: reason,
    ...((contributions.get(node.id)||liveContributions.get(node.id))?.length?{contributions:contributions.get(node.id)||liveContributions.get(node.id)}:{}),
    ...(remainingActors.length?{pendingActors:remainingActors}:{}),...(worldPending?{worldPending:true}:{}),
    ...(impact||prior?.impact?{impact:impact||prior.impact}:{}),
    ...(prior?.worldApplied||world.length||withdrawWorld?{worldApplied:Boolean(world.length||prior?.worldApplied&&!withdrawWorld)}:{}),
  }));
  const progress = plan.events.filter(({code})=>!plan.deferredEventIds?.includes(code)).map(({ event, code, previous }) => {
    const done = entries.filter(row => row.code === code&&!row.livePrefix), cancelled = plan.cancelled.filter(row => row.code === code);
    const live = entries.filter(row=>row.code===code&&row.livePrefix);
    const pending = plan.pending.filter(row => row.code === code);
    const pointer=plan.pointerPositions?.get(code);
    if(pointer&&!pointer.size&&!previous.length&&!done.length&&!cancelled.length&&!live.length&&
      !pending.some(row=>row.reachedMilestoneId))return null;
    const partial=done.some(row=>row.remainingActors?.length||row.worldPending);
    const pointerReachedEnd=plan.pointerPositions?.get(code)?.has(event.prebuilt.nodes.at(-1)?.id);
    const cancelledNodes=new Set([...cancelled.map(row=>row.node.id),...previous.filter(n=>n.prebuilt==='cancelled').map(n=>n.nodeId)]);
    const closed = !pending.length && !partial && (pointerReachedEnd||event.prebuilt.nodes.every(n=>cancelledNodes.has(n.id))||
      !pointer&&entrySpan(event).max <= parseTimePoint(end));
    const liveChanges=[...new Set(live.map(row=>pending.find(item=>item.node.id===row.livePrefix)).filter(row=>row?.impact?.actors?.length).map(row=>row.reason).filter(Boolean))];
    const changed = done.some(row => row.repaired) || cancelled.length > 0 || liveChanges.length>0 ||
      previous.some(node => ['repaired','cancelled'].includes(node.prebuilt)||node.impact?.actors?.length);
    const status = closed ? (changed ? 'changed' : 'completed') : (changed ? 'changed' : 'ongoing');
    const replaced=new Set([...done,...cancelled,...pending].map(row=>row.node.id));
    const progressNodes=[...previous.filter(row=>!replaced.has(row.nodeId)), ...nodes(done.filter(row => !row.repaired), 'applied', 'done'),
      ...nodes(done.filter(row => row.repaired), 'repaired', 'mutated'), ...nodes(cancelled, 'cancelled', 'mutated'), ...nodes(pending, 'pending', 'todo')];
    const nodeOrder=new Map(event.prebuilt.nodes.map((node,i)=>[node.id,i]));
    progressNodes.sort((a,b)=>(nodeOrder.get(a.nodeId)??Infinity)-(nodeOrder.get(b.nodeId)??Infinity));
    const milestone=progressNodes.map(row=>row.milestones?.find(m=>m.id===row.reachedMilestoneId)?.title).filter(Boolean).at(-1);
    return { eventId: code, title: event.title, startAt: event.time_start, endAt: event.time_end, coveredTo: end,
      status, resolved: closed, current: live.length?(milestone?'已到「'+milestone+'」，当前节点尚未完成':'本轮片段已保存，当前节点尚未完成'):done.at(-1)?.node.title || milestone || previous.filter(n=>n.state!=='todo').at(-1)?.title || '等待后续节点',
      reason: '预制节点按本轮边界确认，随实际存档提交', occurred: done.map(row => row.node.title),
      pending: [...pending.map(row => row.node.title),...done.filter(row=>row.remainingActors?.length||row.worldPending).map(row => row.node.title+'（仍有未补任务）')], changes: [...new Set([...done.filter(row => row.repaired), ...cancelled].map(row => row.reason).concat(liveChanges).filter(Boolean))],
      nodes: progressNodes,
    };
  }).filter(Boolean);
  const compressions = [];
  for(const {event,code} of plan.events) {
    for(const row of Array.isArray(event.prebuilt.biographySnapshots)?event.prebuilt.biographySnapshots:[]) {
      if(!text(row?.name)||!Array.isArray(row.source)||!row.source.every(cleanText)||!Array.isArray(row.entries)||
        !entries.some(entry=>entry.code===code&&entry.node.id===row.nodeId&&!entry.repaired&&entry.node.npc.some(person=>person.name===row.name)))continue;
      compressions.push({name:row.name,source:row.source,entries:row.entries,snapshot:true,...(typeof row.sourceBackground==='string' && typeof row.background==='string'?{sourceBackground:row.sourceBackground,inputBackground:typeof row.inputBackground==='string'?row.inputBackground:row.sourceBackground,background:row.background}:{})});
    }
  }
  for (const {event, code} of plan.events) for (const draft of Array.isArray(event.prebuilt.biographyCompression) ? event.prebuilt.biographyCompression : []) {
    if (!text(draft?.name) || !Array.isArray(draft.entries) || (plan.eligibleJobs&&!plan.eligibleJobs.some(job=>job.name===draft.name&&job.eventIds?.includes(code)))) continue;
    const sources = event.prebuilt.nodes.filter(node => node.npc.some(person => person.name === draft.name));
    if (!sources.length || !sources.every(node => entries.some(row => row.code === code && row.node.id === node.id && !row.repaired))) continue;
    compressions.push({name:draft.name, source:[...new Set(sources.flatMap(node => node.npc.find(person => person.name === draft.name).biography))], entries:draft.entries});
  }
  return {
    actors: [...actorRows.values()].map(actor => ({ name: actor.name, canonActorId:canonActorId(actor.name), body: [...actor.paragraphs,...actor.stories.map(row=>row.body)].join('\n\n'),
      biography: [...new Set(actor.biography)].join('\n'), variables: actor.variables, eventIds: [...actor.eventIds],
      ...(actor.stories.length?{stories:actor.stories,legacyBody:actor.paragraphs.join('\n\n')}:{}),
      requireBaseline: actor.requireBaseline, status: actor.repaired ? '变异' : '正常',
      ...(actor.liveScene?{liveScene:true}:{}),
      ...(typeof (plan.scenePresence?.get(actor.name)??actor.presentAtEnd)==='boolean'?{presentAtEnd:plan.scenePresence?.get(actor.name)??actor.presentAtEnd}:{}),
      ...(actor.repaired&&actor.ordinaryDelta?{ordinaryDelta:actor.ordinaryDelta}:{}),
      ...(plan.ordinaryActors?.[actor.name]?{ordinaryState:plan.ordinaryActors[actor.name]}:{}),
      ...(actor.allowUnknownDemographics?{allowUnknownDemographics:true}:{}),
      ...(actor.allowMissingLocation?{allowMissingLocation:true}:{}),
      ...(!actor.requiresOperations && actor.seedColumns ? {terminalColumns:actor.seedColumns,playerNames:[...(plan.playerNames || [])]} : {}),
      ...(actor.requiresOperations&&actor.statusSnapshot?{statusSnapshot:actor.statusSnapshot}:{}),
      ...((!actor.needsReseedReview||actor.allowUnknownDemographics) && !unsafeSeeds.has(actor.name) && actor.seedColumns ? { seedColumns: actor.seedColumns } : {}) })),
    progress, compressions, withdrawalReceipts, sourceSteps,
    world: entries.flatMap(row => row.world.map((item,index) => ({ ...item,
      sourceId:eventSourceRecord(row.code,row.node,null).sourceId,
      sourceIndex:index,
      at: row.node.at || row.node.npc[0]?.biography[0]?.match(/^\[([^@]+)/u)?.[1] || '' }))),
  };
}

export function findPrebuiltCharacterCompression(name, sourceText, sourceBackground, candidates) {
  const original=sourceText.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
  let history=[...original],background=sourceBackground,hasBackground=false;
  const knownBackgrounds=new Set([sourceBackground]),used=new Set();
  let changed=false;
  // 快照是在编辑器里逐节点生成的：后节点的source含前节点摘要，不能直接拿最后稿匹配原始全量。
  // 只允许精确前缀替换，后续新增经历始终保留；非本轮/未补人物快照已由payload收集范围过滤。
  for(let pass=0;pass<(candidates||[]).length;pass++) {
    let progressed=false;
    for(const candidate of candidates||[]) {
      if(used.has(candidate)||candidate?.name!==name||!Array.isArray(candidate.source)||!Array.isArray(candidate.entries))continue;
      const source=candidate.source.map(line=>typeof line==='string'?line.trim():'');
      if(source.some(line=>!line)||source.length>history.length||!source.every((line,index)=>line===history[index]))continue;
      const entries=candidate.entries;
      if(new Set(entries).size!==entries.length||entries.some(line=>!cleanText(line)||!/^\[[^\]@\n]+@[^\]\n]+\]\S[^\n]*$/u.test(line)))continue;
      const dual=typeof candidate.sourceBackground==='string'&&typeof candidate.background==='string';
      if(dual) {
        const inputBackground=typeof candidate.inputBackground==='string'?candidate.inputBackground:candidate.sourceBackground;
        if(!cleanText(candidate.background)||candidate.background.length>1000||entries.length>5||(source.length&&!entries.length))continue;
        const markers=[...(candidate.sourceBackground.match(/\[出生[:：][^\]\r\n]+\]/gu)||[]),...(inputBackground.match(/\[出生[:：][^\]\r\n]+\]/gu)||[])];
        if(markers.some(marker=>!candidate.background.includes(marker)))continue;
        // 继承前次简介或该节点明确改写背景，不能把不相干的中间摘要串进链里。
        if(hasBackground&&inputBackground!==background&&inputBackground!==candidate.sourceBackground)continue;
        const inputSize=source.join('\n').length+inputBackground.length,resultSize=entries.join('\n').length+candidate.background.length;
        if(resultSize>=inputSize||resultSize>1000)continue;
        knownBackgrounds.add(candidate.sourceBackground);knownBackgrounds.add(inputBackground);knownBackgrounds.add(candidate.background);
        background=candidate.background;hasBackground=true;
      } else {
        // 旧包只整理35，不清空10，也不拿缺失的简介结果宣称背景已整理。
        if((candidate.snapshot?entries.length<1||entries.length>5:entries.length!==5)||entries.join('\n').length>=source.join('\n').length)continue;
      }
      history=[...entries,...history.slice(source.length)];used.add(candidate);changed=true;progressed=true;
    }
    if(!progressed)break;
  }
  if(!changed||!knownBackgrounds.has(sourceBackground))return null;
  // live背景必须是已验证链中的精确值，用户后改的背景不能被旧快照覆盖。
  if(hasBackground&&!Array.from(used).some(candidate=>candidate.sourceBackground===sourceBackground||candidate.inputBackground===sourceBackground||candidate.background===sourceBackground))return null;
  const text=history.join('\n'),size=text.length+background.length;
  const markers=sourceBackground.match(/\[出生[:：][^\]\r\n]+\]/gu)||[];
  if(markers.some(marker=>!background.includes(marker))||size>=sourceText.length+sourceBackground.length||size>1000)return null;
  return {text,...(hasBackground?{background}:{})};
}

export function findPrebuiltBiographyCompression(name, sourceText, candidates) {
  const source = sourceText.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  for (const candidate of candidates || []) {
    if (candidate.name !== name || candidate.source.length !== source.length ||
        !candidate.source.every((line, index) => line.trim() === source[index])) continue;
    const entries = candidate.entries;
    if ((candidate.snapshot?entries.length>=1&&entries.length<=5:entries.length===5) && new Set(entries).size === entries.length &&
        entries.every(line => cleanText(line) && /^\[[^\]@\n]+@[^\]\n]+\]\S[^\n]*$/u.test(line)) &&
        entries.join('\n').length < sourceText.length) return entries.join('\n');
  }
  return null;
}

const cleanText = value => text(value) && !/[<\u0000]/u.test(value);
const coordinateSuffix = /\s+-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/u;
const newActorScalars = new Set(['1', '2', '3', '4', '5', '6', '10', '12', '13', '14', '16', '19', '26', '27', '28', '29', '31', '32', ...Array.from({length: 15}, (_, i) => String(36 + i))]);

function plainNativeValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return true;
  if (typeof value === 'string') return !/[<\u0000]/u.test(value);
  return depth < 5 && (Array.isArray(value) || isRecord(value)) && Object.entries(value).every(([key, entry]) =>
    !/^(?:__proto__|constructor|prototype)$/u.test(key) && plainNativeValue(entry, depth + 1));
}

function compileNativeItem(native) {
  if (!isRecord(native) || native['0'] != null || !inventoryTypes.has(native['2']) ||
      !cleanText(native['1']) || !cleanText(native['3']) || !/^[1-9]\d*$/u.test(String(native['5'])) ||
      !Number.isSafeInteger(Number(native['5']))||native.quantityDetail!=null&&!cleanText(native.quantityDetail)) return null;
  const technique = /功法$/u.test(native['2']);
  if (technique ? ![6, 7, 8].every(key => cleanText(native[key])) : !cleanText(native['4'])) return null;
  const item = { 1: native['1'], 2: native['2'], 3: native['3'], 5: String(native['5']) };
  for (const key of (technique ? [6, 7, 8] : [4])) {
    if (native[key] == null) continue;
    if (!cleanText(native[key])) return null;
    item[key] = native[key];
  }
  for(const key of ['equipmentRole','artifactTier']) if(cleanText(native[key])) item[key]=native[key];
  for(const key of ['inventoryGroup','quantityDetail']) if(cleanText(native[key])) item[key]=native[key];
  if(Object.hasOwn(native,'stockMembers')){
    if(!validStockMembers(native)||!plainNativeValue(native.stockMembers))return null;
    item.stockMembers=structuredClone(native.stockMembers);
  }
  if(typeof native.isNatal==='boolean') item.isNatal=native.isNatal;
  if(native.treasureSet===true)item.treasureSet=true;
  if(cleanText(native.treasureSetId))item.treasureSetId=native.treasureSetId;
  return item;
}

function normalizePrebuiltTerminalColumns(columns, previous) {
  if (!isRecord(columns)) return columns;
  const normalized = {...columns};
  if(normalized['4']==null&&typeof previous?.['4']==='string')normalized['4']=previous['4'];
  for (const key of ['10','12']) {
    const value = columns[key];
    if ((Array.isArray(value) || isRecord(value)) && !Object.keys(value).length) {
      const inherited = previous?.[key];
      normalized[key] = cleanText(inherited) ? inherited : null;
    }
  }
  const notes = columns['9'];
  if (isRecord(notes)) {
    for (const [key, alias] of [['年龄','age'],['寿元','lifespan']]) {
      if (!Object.hasOwn(notes,key) && Object.hasOwn(notes,alias)) {
        if (normalized['9']===notes) normalized['9']={...notes};
        normalized['9'][key]=notes[alias];
        delete normalized['9'][alias];
      }
    }
  }
  if(isRecord(normalized['9']))normalized['9']=coalesceTreasureSets(normalized['9']);
  if (typeof columns['2']==='string') {
    normalized['2']=columns['2'].replace(/^\s*(?:未载|未详|不详)\s*\|/u,'未知|');
  }
  return normalized;
}

export function compilePrebuiltNewActor(id, actor, reportIssue = () => {}) {
  const seed = normalizePrebuiltTerminalColumns(actor?.seedColumns), notes = seed?.['9'];
  const missing=key=>actor?.allowUnknownDemographics===true&&notes?.[key]===null;
  const invalid=message=>{reportIssue(message);return null;};
  if (!isRecord(seed)) return invalid('终态必须是按列号索引的 JSON 对象');
  if (!/^C[1-9]\d*$/u.test(id) || playerTarget(actor?.name) ||
      (actor.canonActorId!==undefined && actor.canonActorId!==canonActorId(actor.name)))
    return invalid('人物标识与 NPC 不符');
  if (seed['0'] !== null) return invalid('第 0 列必须显式填写 null，正式编号由游戏分配');
  if (!isRecord(notes)) return invalid('第 9 列必须是 JSON 对象，请直接保留前态对象中未变化的成员');
  if (notes.isBonded !== false) return invalid('第 9 列 isBonded 必须是布尔值 false');
  if (!Array.isArray(notes.inventory)) return invalid('第 9 列 inventory 必须是数组，空物品栏填写 []');
  if (!isRecord(notes.equipment)) return invalid('第 9 列 equipment 必须是 JSON 对象');
  for (const [key, label] of [['10','背景'],['12','内心想法']]) {
    if (seed[key]!=null && typeof seed[key]!=='string')
      return invalid('第 '+key+' 列「'+label+'」必须是文本或 null，请保留已知内容');
  }
  for (const [key, min] of [['年龄',0],['寿元',Number.MIN_VALUE]]) {
    if (!missing(key) && (!Number.isFinite(notes[key]) || notes[key]<min))
      return invalid('第 9 列「'+key+'」须使用中文键并填写有效数值，确无资料时按本阶段要求处理');
  }
  if (!isRecord(seed['11'])) return invalid('第 11 列必须是 JSON 对象，包含血量和法力的白值');
  const identity = String(seed['1'] || '').split('|'), realm = String(seed['2'] || '').split('|');
  const appearance = String(seed['16'] || '').split('|');
  if (identity.length !== 2 || identity[0] !== actor.name || !text(identity[1]))
    return invalid('第 1 列须为「姓名|性别」，姓名须与当前人物一致');
  if (realm.length !== 2 || !text(realm[0])) return invalid('第 2 列须为「境界|身份」');
  if (appearance.length !== 5 || (!text(appearance[2])&&!actor.allowMissingLocation))
    return invalid('第 16 列须为「动作|穿着|实际地点|身段|样貌」，地点不能为空');
  if (seed['33'] != null && seed['33'] !== false) return invalid('第 33 列只允许省略、null 或 false');
  if (seed['30'] != null && (!Array.isArray(seed['30']) || seed['30'].length))
    return invalid('第 30 列只允许省略、null 或空数组');
  const row = { 0: id, 7: '未识', 15: 0, 32: false, 35: '' }, inventory = [], equipment = {}, white = {};
  for (const key of newActorScalars) {
    if(key==='32') continue;
    const value = seed[key];
    if (value == null) continue;
    if (!plainNativeValue(value) || typeof value === 'object' && !['8', '13'].includes(key))
      return invalid('第 '+key+' 列的数据类型与 NPC 列格式不符');
    const safe = key==='13' ? withoutPlayerRelations(value) : value;
    row[key] = typeof safe === 'object' ? JSON.stringify(safe) : safe;
  }
  for (const [key, value] of Object.entries(seed['11'])) {
    if (value === null && whiteAttributes.has(key)) continue;
    if (!whiteAttributes.has(key)) return invalid('第 11 列包含未定义的白值属性，请沿用可信基准');
    if (!isRecord(value) || !Number.isFinite(value.current) || !Number.isFinite(value.max) ||
        value.current < 0 || value.max < value.current)
      return invalid('第 11 列「'+key+'」须包含有效数字 current 和 max，且 0 ≤ current ≤ max');
    white[key] = { current: value.current, max: value.max };
  }
  if (!white.血量 || !white.法力) return invalid('第 11 列缺少'+(!white.血量?'血量':'法力')+'白值');
  row['11'] = JSON.stringify(white);
  let next = 1;
  function assignItem(raw, item) {
    if (!item || raw?.['0'] !== null) return null;
    return { ...item, 0: 'I_' + id + '_' + String(next++).padStart(2, '0') };
  }
  for (const [index,raw] of notes.inventory.entries()) {
    const item = assignItem(raw, compileNativeItem(raw));
    if (!item) {
      const hint=raw?.name==='灵石'||raw?.['1']==='灵石'
        ? '灵石余额写入第 26 列，请移除此条物品并保留前态库存'
        : '核对标准物品字段及第 0 项编号 null';
      return invalid('第 9 列 inventory['+index+'] 的物品格式不符，'+hint);
    }
    inventory.push(item);
  }
  for (const group of equipmentGroups) {
    const changedEquipment=(actor.variables||[]).some(op=>op.kind==='equipment');
    const slots = Object.hasOwn(notes.equipment,group)?notes.equipment[group]:changedEquipment?null:[], layout = getEquipmentSlots(group);
    if (!Array.isArray(slots) || slots.length > layout.length)
      return invalid('第 9 列 equipment.'+group+' 须为装备槽数组，最多 '+layout.length+' 槽');
    equipment[group] = [];
    for (const { index } of layout) {
      const raw = slots[index];
      if (raw == null) { equipment[group].push(null); continue; }
      const item = assignItem(raw, compileNativeItem(raw));
      const owner = { 2: realm[0].replace(/\s*[（(]\s*\d+(?:\.\d+)?\s*%\s*[）)]\s*$/u, '') };
      if (!item || !equipmentEligibility(owner, group, index, item).allowed)
        return invalid('第 9 列 equipment.'+group+'['+index+'] 的物品格式、数量或槽位不符');
      equipment[group].push(item);
    }
  }
  const remarks = { isBonded: false, inventory, equipment };
  if (notes.spiritStoneGrades!==undefined) {
    if (!isRecord(notes.spiritStoneGrades) || Object.entries(notes.spiritStoneGrades).some(([grade,amount])=>
      !['中品','上品','极品'].includes(grade)||stoneBalance(amount)===null)) return invalid('第 9 列 spiritStoneGrades 须按品级写非负整数余额');
    remarks.spiritStoneGrades=Object.fromEntries(Object.entries(notes.spiritStoneGrades).map(([grade,amount])=>[grade,Number(amount)]));
  }
  if (notes.cultivationArts !== undefined) {
    if (validateCultivationArts(notes.cultivationArts, {requireBasis:false}).length)
      return invalid('第 9 列 cultivationArts 格式不符，请核对百艺档位和进度');
    remarks.cultivationArts = structuredClone(notes.cultivationArts);
    for (const entry of Object.values(remarks.cultivationArts)) delete entry.previous;
  }
  const unknown=[];
  for(const key of ['年龄','寿元'])if(missing(key))unknown.push(key);else remarks[key]=notes[key];
  if(actor.allowUnknownDemographics===true&&actor.canonActorId&&realm[0].trim()==='未知'&&
    text(realm[1])&&!/^(?:未知|不详|未详|待补全|undefined|null|无资料)$/iu.test(realm[1].trim()))unknown.push('境界');
  if(unknown.length)remarks.canonPrebuiltUnknown=unknown.join(',');
  if(actor.canonActorId) remarks.canonActorId=actor.canonActorId;
  for (const key of ['skills', 'traits', 'gongfa']) {
    if (!Array.isArray(notes[key]) || !plainNativeValue(notes[key]))
      return invalid('第 9 列 '+key+' 必须是 JSON 数组，空列表填写 []');
    remarks[key] = structuredClone(notes[key]);
  }
  const invalidSkill=remarks.skills.findIndex(skill=>!isRecord(skill) || skill['0'] != null ||
    !Array.from({length:9},(_,i)=>i+1).every(key=>cleanText(skill[key])));
  if (invalidSkill!==-1) return invalid('第 9 列 skills['+invalidSkill+'] 须为技能对象，第 0 项用 null 或省略，第 1 至 9 项为非空文本');
  if (new Set(remarks.skills.map(skill=>skill['1'])).size!==remarks.skills.length)
    return invalid('第 9 列 skills 存在重复的技能名称');
  remarks.skills.forEach((skill, index) => { skill['0'] = 'S_' + id + '_' + String(index + 1).padStart(2, '0'); });
  row['9'] = remarks;
  // 终态已经包含本人的操作，不可再执行一遍。对不能独立兑现的操作交还常规路线。
  const items = inventory.concat(Object.values(equipment).flat().filter(Boolean));
  const latest = new Map();
  for (const op of actor.variables || []) {
    if (playerOperation(op) || isRetiredCharacterOperation(op) || isPrebuiltStatusOperation(op)) continue;
    if (['world', 'beast'].includes(op.kind) ||
        op.action==='transfer'&&(op.kind!=='item'||!text(op.value)||op.value===actor.name||
          !Number.isSafeInteger(op.previousValue)||!Number.isSafeInteger(op.terminalValue)||
          op.terminalValue<0||op.previousValue<=op.terminalValue)) return null;
    const key = JSON.stringify([op.kind, op.subject]);
    if (latest.has(key) && !cultivationArtStateEqual(latest.get(key).terminalValue,op.previousValue)) return null;
    latest.set(key, op);
  }
  for (const op of latest.values()) {
    const pair = ({ realm: ['2', realm[0]], identity: ['2', realm[1]], location: ['16', appearance[2]],
      status: ['31',row['31']],
      goal:[({'当前动机':'27','短期目标':'28','长期目标':'29'})[op.subject],row[op.column]],
      relationship:['13',relationEntries(row['13'])?.find(([name])=>name===op.subject)?.[1]??null],
      attribute: String(op.column)==='9' && String(op.subject||'').startsWith('cultivationArts.') ? ['9',remarks.cultivationArts?.[op.subject.slice(16)]??null] : ['11', white[op.subject]?.current],
      currency:prebuiltSpiritGrade(op) ? ['9',stoneBalance(remarks.spiritStoneGrades?.[prebuiltSpiritGrade(op)]??0)] : ['26',stoneBalance(row['26'])],
      skill: ['9', remarks.skills.find(skill => skill['1'] === op.subject)?.['7'] ?? null],
      item: ['9', items.filter(item => item['1'] === op.subject).reduce((n, item) => n + Number(item['5']), 0)] })[op.kind];
    if (op.kind === 'location' && text(op.terminalValue) && !coordinateSuffix.test(op.terminalValue) &&
        appearance[2].replace(coordinateSuffix, '') === op.terminalValue) pair[1] = op.terminalValue;
    if (!pair || !matchesPrebuiltBaseline(op, pair[0], op.previousValue, pair[1], true) || !Object.hasOwn(op, 'previousValue')) return null;
  }
  return row;
}

const prebuiltObject=value=>isRecord(value)?value:typeof value==='string'?(()=>{try{const parsed=JSON.parse(value);return isRecord(parsed)?parsed:null;}catch{return null;}})():null;
function prebuiltItemIdentity(row){
  if(!text(row?.['1'])||!text(row?.['2']))return '';
  const parts=[row['1'],row['2']];
  if(isTreasureSet(row))parts.push('treasureSet',row.treasureSetId||'');
  return JSON.stringify(parts);
}
function mergeOrdinaryPrebuiltRemarks(next,after,before,state,allowedItems=new Set(),strict=false,allowedArts=new Set(),allowedGrades=new Set()) {
  const merged=structuredClone(next);
  // A receipt protects changed entities, not an entire inventory or skill collection.
  const key=prebuiltItemIdentity;
  const located=remarks=>[
    ...(Array.isArray(remarks?.inventory)?remarks.inventory:[]).map((row,index)=>({row,kind:'inventory',index})),
    ...Object.entries(remarks?.equipment||{}).flatMap(([slot,rows])=>Array.isArray(rows)?rows.flatMap((row,index)=>row?[{row,kind:'equipment',slot,index}]:[]):[]),
  ];
  const oldItems=new Map(located(before).map(item=>[key(item.row),item]));
  const actualItems=new Map(located(after).map(item=>[key(item.row),item]));
  const protectedItems=new Set();
  for(const identity of new Set([...oldItems.keys(),...actualItems.keys()])) {
    if(!before || JSON.stringify(oldItems.get(identity))!==JSON.stringify(actualItems.get(identity)))protectedItems.add(identity);
  }
  for(const record of state.records || [])if(record.kind==='items') {
    const op=record.operation||{},id=op.itemId||op.item?.['0']||op.itemData?.['0'];
    if(!id)continue;
    const hit=[...oldItems.values(),...actualItems.values()].find(item=>item.row['0']===id);
    if(hit)protectedItems.add(key(hit.row));
    else if(!before)return null; // Cannot prove which consumed item would otherwise be resurrected.
  }
  const proposedItems=new Map(located(next).map(item=>[key(item.row),item]));
  for(const identity of [...protectedItems]){
    const item=actualItems.get(identity)||oldItems.get(identity);
    if(item&&allowedItems.has(item.row['1'])){protectedItems.delete(identity);continue;}
    if(strict){
      const actual=actualItems.get(identity),proposed=proposedItems.get(identity);
      if(Boolean(actual)!==Boolean(proposed)||actual&&Number(actual.row['5'])!==Number(proposed.row['5']))return null;
    }
  }
  merged.inventory=(merged.inventory||[]).filter(row=>!protectedItems.has(key(row)));
  for(const slot of Object.keys(merged.equipment||{}))merged.equipment[slot]=merged.equipment[slot].map(row=>row&&protectedItems.has(key(row))?null:row);
  for(const identity of protectedItems) {
    const actual=actualItems.get(identity);if(!actual)continue;
    if(actual.kind==='inventory')merged.inventory.push(structuredClone(actual.row));
    else {
      const slots=merged.equipment[actual.slot] ||= [];
      const displaced=slots[actual.index];
      if(displaced)merged.inventory.push(displaced);
      slots[actual.index]=structuredClone(actual.row);
    }
  }
  const mergeCollection=(prior,current,proposed)=>{
    const identity=row=>String(row?.['1']||row?.name||row?.['0']||'');
    const a=new Map((Array.isArray(prior)?prior:[]).map(row=>[identity(row),row]));
    const b=new Map((Array.isArray(current)?current:[]).map(row=>[identity(row),row]));
    const protectedKeys=new Set([...new Set([...a.keys(),...b.keys()])].filter(id=>!before||JSON.stringify(a.get(id))!==JSON.stringify(b.get(id))));
    return [...(Array.isArray(proposed)?proposed:[]).filter(row=>!protectedKeys.has(identity(row))),
      ...[...b].filter(([id])=>protectedKeys.has(id)).map(([,row])=>structuredClone(row))];
  };
  for(const name of ['skills','traits','gongfa'])if(Array.isArray(after[name]))merged[name]=mergeCollection(before?.[name],after[name],merged[name]);
  if (after.cultivationArts!==undefined || before?.cultivationArts!==undefined) {
    const actual=prebuiltObject(after.cultivationArts)||{}, prior=prebuiltObject(before?.cultivationArts)||{}, proposed=prebuiltObject(merged.cultivationArts)||{};
    for(const key of new Set([...Object.keys(prior),...Object.keys(actual)])) {
      if(allowedArts.has(key)||before&&cultivationArtStateEqual(prior[key],actual[key]))continue;
      if(strict&&!cultivationArtStateEqual(proposed[key],actual[key]))return null;
      if(Object.hasOwn(actual,key))proposed[key]=structuredClone(actual[key]);else delete proposed[key];
    }
    merged.cultivationArts=proposed;
  }
  if (after.spiritStoneGrades!==undefined || before?.spiritStoneGrades!==undefined || merged.spiritStoneGrades!==undefined) {
    const actual=prebuiltObject(after.spiritStoneGrades)||{}, prior=prebuiltObject(before?.spiritStoneGrades)||{};
    const proposed={...(prebuiltObject(merged.spiritStoneGrades)||{})};
    for(const grade of ['中品','上品','极品']) {
      if(allowedGrades.has(grade)||before&&Number(prior[grade]??0)===Number(actual[grade]??0))continue;
      if(strict&&Number(proposed[grade]??0)!==Number(actual[grade]??0))return null;
      if(Object.hasOwn(actual,grade))proposed[grade]=actual[grade];else delete proposed[grade];
    }
    merged.spiritStoneGrades=proposed;
  }
  for(const name of Object.keys(after))if(!['inventory','equipment','skills','traits','gongfa','cultivationArts','spiritStoneGrades'].includes(name) &&
      (!before||JSON.stringify(before[name])!==JSON.stringify(after[name])))merged[name]=structuredClone(after[name]);
  for(const name of Object.keys(before||{}))if(!Object.hasOwn(after,name)&&!['inventory','equipment','skills','traits','gongfa','cultivationArts','spiritStoneGrades'].includes(name))delete merged[name];
  return merged;
}
function validatePrebuiltOrdinaryDelta(target,actor,fields,remarks,oldRemarks) {
  const allowed={columns:new Set(),attributes:new Set(),items:new Set(),arts:new Set(),grades:new Set()};
  if(actor.status!=='变异'||!Array.isArray(actor.ordinaryDelta))return allowed;
  const itemDelta=actor.ordinaryDelta.filter(op=>op.kind==='item');
  const other=actor.ordinaryDelta.filter(op=>op.kind!=='item');
  const changes=compilePrebuiltActorDelta(target,other,{requireBaseline:true});
  if(!changes)return null;
  const gradeTerminals=new Map(other.filter(prebuiltSpiritGrade).map(op=>[prebuiltSpiritGrade(op),op.terminalValue]));
  for (const [grade,amount] of gradeTerminals) {
    if (stoneBalance(remarks.spiritStoneGrades?.[grade]??0)!==Number(amount)) return null;
    allowed.grades.add(grade);
  }
  const nextAttributes=JSON.parse(fields['11']);
  for(const operation of changes) {
    if(operation.command==='updateAttribute'){
      if(nextAttributes[operation.attribute]?.current!==operation.value.current)return null;
      allowed.attributes.add(operation.attribute);
    }else for(const [key,value] of Object.entries(operation.data||{}))if(key!=='0'){
      if(key==='9'&&isRecord(value?.cultivationArts)){
        for(const [art,terminal]of Object.entries(value.cultivationArts)){
          if(!cultivationArtStateEqual(remarks.cultivationArts?.[art],terminal))return null;
          allowed.arts.add(art);
        }
        continue;
      }
      if(key==='9'&&isRecord(value?.spiritStoneGrades))continue;
      if(fields[key]!==value)return null;
      allowed.columns.add(key);
    }
  }
  if(itemDelta.length){
    const compiled=compilePrebuiltInventory(target.id,itemDelta,oldRemarks.inventory||[],Object.values(oldRemarks.equipment||{}).flat(),{requireBaseline:true});
    if(!compiled)return null;
    const latest=new Map(itemDelta.map(op=>[op.subject,op]));
    const items=(remarks.inventory||[]).concat(Object.values(remarks.equipment||{}).flat().filter(Boolean));
    for(const [name,op] of latest){
      if(!Number.isSafeInteger(op.terminalValue)||items.filter(row=>row['1']===name).reduce((sum,row)=>sum+Number(row['5']),0)!==op.terminalValue)return null;
      allowed.items.add(name);
    }
  }
  return allowed;
}
export function compilePrebuiltTerminalActor(target, actor, oldRemarks, options={}) {
  oldRemarks=coalesceTreasureSets(oldRemarks);
  const snapshot = compilePrebuiltNewActor(target?.id,{name:actor.name,canonActorId:actor.canonActorId,seedColumns:actor.terminalColumns,
    allowUnknownDemographics:actor.allowUnknownDemographics,allowMissingLocation:actor.allowMissingLocation,variables:[]});
  if (!snapshot || !isRecord(target.data) || !isRecord(oldRemarks) ||
      (actor.canonActorId && oldRemarks.canonActorId && oldRemarks.canonActorId!==actor.canonActorId)) return null;
  const {0:unusedId,1:unusedName,7:unusedAddress,9:nextRemarks,15:unusedFavor,32:unusedAlly,35:unusedLife,...fields}=snapshot;
  if(actor.allowMissingLocation)delete fields['16'];
  const playerNames=new Set(actor.playerNames || []);
  const isPlayer=name=>playerTarget(name)||playerNames.has(name);
  if (Object.hasOwn(fields,'13')) {
    const old=relationEntries(target.data['13']), next=relationEntries(fields['13']);
    if (!old||!next) return null;
    fields['13']=[...next.filter(([name])=>!isPlayer(name)),...old.filter(([name])=>isPlayer(name))]
      .map(([name,value])=>name+':'+value).join('；')||'无';
  }
  let oldAttributes;
  try {oldAttributes=typeof target.data['11']==='string'?JSON.parse(target.data['11']):target.data['11'];}
  catch {return null;}
  if (oldAttributes!=null&&!isRecord(oldAttributes)) return null;
  fields['11']=JSON.stringify({...oldAttributes,...JSON.parse(fields['11'])});
  const inventory=oldRemarks.inventory ?? [],equipment=oldRemarks.equipment ?? {},skills=oldRemarks.skills ?? [];
  if (!Array.isArray(inventory)||!isRecord(equipment)||!Object.values(equipment).every(Array.isArray)||!Array.isArray(skills)) return null;
  const reconcile=(oldRows,newRows,key,prefix)=>{
    const old=new Map(), used=new Set(), seen=new Set();
    for (const row of oldRows) {
      const identity=key(row),id=row?.['0'];
      if (!identity||!text(id)||old.has(identity)||used.has(id)) return false;
      old.set(identity,id);
      used.add(id);
    }
    let next=1;
    for (const row of newRows) {
      const identity=key(row);
      if (!identity||seen.has(identity)) return false;
      seen.add(identity);
      let id=old.get(identity);
      if (!id) {
        do {id=prefix+String(next++).padStart(2,'0');} while(used.has(id));
        used.add(id);
      }
      row['0']=id;
    }
    return true;
  };
  const items=(bag,gear)=>bag.concat(Object.values(gear).flat().filter(Boolean));
  if (!reconcile(items(inventory,equipment),items(nextRemarks.inventory,nextRemarks.equipment),
    prebuiltItemIdentity, 'I_'+target.id+'_') ||
    !reconcile(skills,nextRemarks.skills,row=>row?.['1'],'S_'+target.id+'_')) return null;
  const remarks={...oldRemarks,...nextRemarks,isBonded:oldRemarks.isBonded??false};
  if (oldRemarks.spiritStoneGrades!==undefined || nextRemarks.spiritStoneGrades!==undefined) {
    remarks.spiritStoneGrades={...(prebuiltObject(oldRemarks.spiritStoneGrades)||{}),...(nextRemarks.spiritStoneGrades||{})};
  }
  // Old products missing arts cannot erase later learning. Merge changed arts independently.
  if (oldRemarks.cultivationArts !== undefined || nextRemarks.cultivationArts !== undefined) {
    try { remarks.cultivationArts=mergeCultivationArts(oldRemarks.cultivationArts,nextRemarks.cultivationArts||{}); } catch { return null; }
  }
  const knownUnknown=new Set([oldRemarks.canonPrebuiltUnknown,nextRemarks.canonPrebuiltUnknown].flatMap(value=>String(value||'').split(',')));
  const unknown=['年龄','寿元'].filter(key=>remarks[key]==null&&knownUnknown.has(key));
  if(remarks.canonActorId&&knownUnknown.has('境界')&&String(fields['2']||'').split('|')[0].trim()==='未知')unknown.push('境界');
  if(unknown.length)remarks.canonPrebuiltUnknown=unknown.join(',');else delete remarks.canonPrebuiltUnknown;
  // Preserve only actual ordinary changes, while allowing unrelated product changes to land.
  const state=actor.ordinaryState,protectedColumns=new Set([...(state?.protectedColumns || []),...(options.preserveColumns || [])]);
  const allowed=validatePrebuiltOrdinaryDelta(target,actor,fields,remarks,oldRemarks);
  if(!allowed)return null;
  let finalRemarks=remarks;
  if(protectedColumns.has('9')) {
    const before=options.beforeRemarks || prebuiltObject(state?.beforeRow?.['9']);
    finalRemarks=mergeOrdinaryPrebuiltRemarks(remarks,oldRemarks,before,state||{},allowed.items,actor.status==='变异',allowed.arts,allowed.grades);
    if(!finalRemarks)return null;
  }
  if(protectedColumns.has('11')) {
    const before=prebuiltObject(state?.beforeRow?.['11']),actual=oldAttributes||{},next=JSON.parse(fields['11']);
    const protectedAttributes=new Set([...new Set([...Object.keys(before||{}),...Object.keys(actual)])].filter(name=>!before||JSON.stringify(before[name])!==JSON.stringify(actual[name])));
    for(const record of state?.records || [])if(record.operation?.command==='updateAttribute'&&record.operation.attribute)protectedAttributes.add(record.operation.attribute);
    for(const name of protectedAttributes)if(!allowed.attributes.has(name)){
      if(actor.status==='变异'&&JSON.stringify(next[name])!==JSON.stringify(actual[name]))return null;
      if(Object.hasOwn(actual,name))next[name]=structuredClone(actual[name]);else delete next[name];
    }
    fields['11']=JSON.stringify(next);
  }
  for(const key of protectedColumns) {
    if(isRetiredCharacterColumn(key)||key==='9'||key==='11'||!isPrebuiltSnapshotColumn(key)&&allowed.columns.has(key)&&!(options.preserveColumns||[]).includes(key))continue;
    if(!isPrebuiltSnapshotColumn(key)&&actor.status==='变异'&&JSON.stringify(fields[key])!==JSON.stringify(target.data[key]))return null;
    if(Object.hasOwn(target.data,key))fields[key]=structuredClone(target.data[key]);else delete fields[key];
  }
  return {fields,remarks:finalRemarks};
}

function prebuiltFieldEqual(column,left,right) {
  if (left===right) return true;
  if (column==='9' && isRecord(left) && isRecord(right)) return cultivationArtStateEqual(left,right);
  if (column==='31') return /^(?:true|false)$/u.test(String(left))&&String(left)===String(right);
  if (column==='4') return [left,right].every(value=>typeof value==='string'&&/^(?:无|正常|一切正常|无异常|无状态|无持续状态)$/u.test(value.trim()));
  if (column==='16'&&text(left)&&text(right)) {
    const a=left.replace(coordinateSuffix,'').trim(),b=right.replace(coordinateSuffix,'').trim();
    // Two explicit, different coordinates cannot be treated as the same place.
    if(coordinateSuffix.test(left)&&coordinateSuffix.test(right)) return false;
    return a===b || a.split(/[·・/]/u).at(-1)?.trim()===b || b.split(/[·・/]/u).at(-1)?.trim()===a;
  }
  return false;
}

function stoneBalance(value) {
  return /^\d+$/u.test(String(value??''))&&Number.isSafeInteger(Number(value))?Number(value):null;
}

function prebuiltSpiritGrade(op) {
  return op?.kind==='currency'&&String(op.column)==='9' ? /^spiritStoneGrades\.(中品|上品|极品)$/u.exec(op.subject||'')?.[1] : undefined;
}

function matchesPrebuiltBaseline(op, column, before, after, requireBaseline) {
  if (!column) return false;
  if ((requireBaseline || Object.hasOwn(op, 'column')) && String(op.column) !== column) return false;
  if ((requireBaseline || Object.hasOwn(op, 'previousValue')) && !prebuiltFieldEqual(column,op.previousValue,before)) return false;
  return !(requireBaseline || Object.hasOwn(op, 'terminalValue')) || prebuiltFieldEqual(column,op.terminalValue,after);
}

export function compilePrebuiltActorDelta(target, variables, { requireBaseline = false } = {}) {
  if (!/^C\d+$/u.test(target?.id || '')) return null;
  const delta = [];
  const working = structuredClone(target.data);
  let attributes;
  try { attributes = typeof working['11'] === 'string' ? JSON.parse(working['11']) : working['11']; }
  catch { return null; }
  for (const op of variables) {
    if (playerOperation(op) || isRetiredCharacterOperation(op) || isPrebuiltStatusOperation(op)) continue;
    if (op.kind === 'location' && op.action === 'set' && cleanText(op.value) && !/[|\r\n]/u.test(op.value)) {
      const columns = String(working['16'] || '').split('|');
      if (columns.length !== 5 || !matchesPrebuiltBaseline(op, '16', columns[2], op.value, requireBaseline)) return null;
      columns[2] = op.value;
      working['16'] = columns.join('|');
      delta.push({ command: 'add', data: { 0: target.id, 16: working['16'] } });
    } else if (op.kind==='attribute' && op.action==='set' && String(op.column)==='9' && /^cultivationArts\.(talisman|formation|alchemy|artifact|puppet|beastTaming|cooking|planting)$/u.test(op.subject||'')) {
      const key=op.subject.slice(16),notes={cultivationArts:readCultivationArts(working)};
      if(!notes||validateCultivationArts({[key]:op.value}).length)return null;
      const before=notes.cultivationArts?.[key]??null;
      if(!Object.hasOwn(op,'previousValue')||!cultivationArtStateEqual(before,op.previousValue)||!cultivationArtStateEqual(op.terminalValue,op.value))return null;
      try {notes.cultivationArts=mergeCultivationArts(notes.cultivationArts,{[key]:op.value});}catch{return null;}
      working['9']=notes;
      delta.push({command:'add',id:target.id,data:{0:target.id,9:{cultivationArts:{[key]:notes.cultivationArts[key]}}}});
    } else if (op.kind === 'attribute' && op.action === 'add' && whiteAttributes.has(op.subject) && Number.isFinite(op.value)) {
      const attribute = attributes?.[op.subject];
      if (!Number.isFinite(attribute?.current) || !Number.isFinite(attribute?.max)) return null;
      const current = attribute.current + op.value;
      if (current < 0 || current > attribute.max ||
          !matchesPrebuiltBaseline(op, '11', attribute.current, current, requireBaseline)) return null;
      attribute.current = current;
      delta.push({ command: 'updateAttribute', id: target.id, attribute: op.subject, value: { current } });
    } else if(op.kind==='currency'&&op.action==='add'&&Number.isSafeInteger(op.value)&&op.value!==0) {
      const grade=prebuiltSpiritGrade(op);
      if(grade){
        const notes=prebuiltObject(working['9'])||{};
        const balances={...(prebuiltObject(notes.spiritStoneGrades)||{})};
        const before=stoneBalance(balances[grade]??0),after=before===null?null:stoneBalance(before+op.value);
        if(before===null||after===null||!matchesPrebuiltBaseline(op,'9',before,after,true))return null;
        balances[grade]=after;
        working['9']={...notes,spiritStoneGrades:balances};
        delta.push({command:'add',id:target.id,data:{0:target.id,9:{spiritStoneGrades:balances}}});
        continue;
      }
      const before=stoneBalance(working['26']), after=before===null?null:stoneBalance(before+op.value);
      if(before===null||after===null||!matchesPrebuiltBaseline(op,'26',before,after,true)) return null;
      working['26']=String(after);
      delta.push({command:'add',data:{0:target.id,26:working['26']}});
    } else if (op.kind==='relationship' && ['set','remove'].includes(op.action) && cleanText(op.subject) && !/[:：;；\r\n]/u.test(op.subject)) {
      const entries=relationEntries(working['13']);
      if (!entries||new Set(entries.map(([name])=>name)).size!==entries.length) return null;
      const pairs=new Map(entries);
      const value=op.action==='remove'?null:op.value;
      if ((value!==null&&(!cleanText(value)||splitCharacterRelationshipLines(value).length!==1))||
          !matchesPrebuiltBaseline(op,'13',pairs.get(op.subject)??null,value,true)) return null;
      if(value===null) pairs.delete(op.subject); else pairs.set(op.subject,value);
      working['13']=[...pairs].map(([name,relation])=>name+':'+relation).join('；')||'无';
      delta.push({command:'add',data:{0:target.id,13:working['13']}});
    } else if (op.action === 'set' && ['realm', 'identity', 'status', 'goal'].includes(op.kind) &&
        (cleanText(op.value) && !/[|\r\n]/u.test(op.value) || op.kind==='status'&&String(op.column)==='31'&&typeof op.value==='boolean')) {
      const column = op.kind === 'status' ? (String(op.column)==='31'?'31':null) : op.kind === 'goal' ? ({ 当前动机: '27', 短期目标: '28', 长期目标: '29' })[op.subject] : '2';
      if (!column) return null;
      if(column==='31'&&!/^(?:true|false)$/u.test(String(op.value))) return null;
      if (column === '2') {
        const parts = String(working[column] ?? '').split('|');
        const i = op.kind === 'realm' ? 0 : 1;
        if (parts.length !== 2 || !matchesPrebuiltBaseline(op, column, parts[i], op.value, true)) return null;
        parts[i] = op.value;
        working[column] = parts.join('|');
      } else {
        if (!matchesPrebuiltBaseline(op, column, working[column] ?? null, op.value, true)) return null;
        working[column] = op.value;
      }
      delta.push({ command: 'add', data: { 0: target.id, [column]: working[column] } });
    } else return null;
  }
  return delta;
}

export function compilePrebuiltItemGain(owner, op, { requireBaseline = false } = {}) {
  if (!/^C\d+$/u.test(owner) || op?.kind !== 'item' || op.action !== 'gain' ||
      !text(op.subject) || /[<>\r\n]/u.test(op.subject)) return null;
  const native = op.item?.columns;
  if (requireBaseline && native) {
    const item = compileNativeItem(native);
    if (!item || native['0'] !== null || item['1'] !== op.subject || Number(item['5']) !== op.value ||
        !matchesPrebuiltBaseline(op, '9', 0, op.value, true)) return null;
    return { type: 'createItem', owner, item };
  }
  const item = native ? { type: native['2'], description: native['3'], effect: native['4'], quantity: Number(native['5']) } : op.item;
  if (!['消耗品', '丹药', '食物', '符箓', '油料', '材料', '药材', '重要物品', '阵盘', '杂物', '其他物品'].includes(item?.type) ||
      !text(item.description) || !text(item.effect) || !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 || item.quantity !== op.value ||
      !matchesPrebuiltBaseline(op, '9', 0, item.quantity, requireBaseline) ||
      (native && Object.hasOwn(native, '1') && native['1'] !== op.subject)) return null;
  return { type: 'createItem', owner, item: { 1: op.subject, 2: item.type, 3: item.description, 4: item.effect, 5: String(item.quantity),
    ...(text(native?.quantityDetail)?{quantityDetail:native.quantityDetail}:{}),
    ...(text(native?.inventoryGroup)?{inventoryGroup:native.inventoryGroup}:{}) } };
}

export function compilePrebuiltInventory(owner, changes, inventory, equipment, { requireBaseline = false } = {}) {
  if (!/^C\d+$/u.test(owner) || !Array.isArray(inventory) || !Array.isArray(equipment)) return null;
  const itemName = row => String(row?.['1'] || row?.name || '').trim();
  const itemIdOf = row => row?.['0'] || row?.id;
  const stocks = new Map(), remaining = [], operations = [];
  for (const change of changes) {
    if (change?.kind!=='item'||!text(change.subject) || /[<>\r\n]/u.test(change.subject)) return null;
    const name = change.subject.trim();
    if (!stocks.has(name)) {
      if (equipment.some(row => itemName(row) === name)) return null;
      const matches = inventory.filter(row => itemName(row) === name);
      if (matches.length>1) return null;
      const item=matches[0],itemId=itemIdOf(item);
      const rawQuantity=item?.['5']??item?.quantity;
      const initial=item?Number(rawQuantity):0;
      if (item && (!text(itemId)||equipment.some(row=>itemIdOf(row)===itemId)||
          inventory.some(row=>row!==item&&itemIdOf(row)===itemId)||!/^[1-9]\d*$/u.test(String(rawQuantity))||!Number.isSafeInteger(initial))) return null;
      stocks.set(name,{name,itemId,initial,quantity:initial,create:null});
    }
    const stock=stocks.get(name),quantity=change.value;
    if (!Number.isSafeInteger(quantity)||quantity<=0) return null;
    if (change.action==='gain') {
      if (stock.itemId||stock.quantity!==0||change.previousValue!==0) return null;
      stock.create=compilePrebuiltItemGain(owner,change,{requireBaseline});
      if (!stock.create) return null;
      stock.quantity=quantity;
    } else {
      if (!['consume','lose'].includes(change.action)) return null;
      const after=stock.quantity-quantity;
      if (after<0||!matchesPrebuiltBaseline(change,'9',stock.quantity,after,true)) return null;
      stock.quantity=after;
    }
  }
  for (const {name,itemId,initial,quantity,create} of stocks.values()) {
    if (itemId && quantity<initial) {
      operations.push({type:'consumeItem',owner,itemId,quantity:initial-quantity});
      remaining.push({itemId,name,quantity});
    } else if (create && quantity>0) operations.push({...create,item:{...create.item,5:String(quantity)}});
  }
  return {operations,remaining};
}
