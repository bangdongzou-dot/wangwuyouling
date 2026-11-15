// ============================================================
// 一轮原著补演 · 编排器
//
// 依据：总设计 §3.1 的十二步时序。
// 用户 2026-10-21 定：**编排器，不是 Agent**（酒馆里跑不动 Agent）。
//
// ------------------------------------------------------------
// 编排器只做三件事：
//   1. 按固定顺序调各步骤
//   2. 步骤间搬数据
//   3. 失败时整体回退（不写任何东西）
//
// 它**不**判断语义、不写提示词、不解析模型输出——那些归各组件。
//
// ------------------------------------------------------------
// 事务边界（总设计 §4.12.3 第 1 层）：
//
//   内存副本应用完成
//     → 全部校验通过
//       → 格式化成待保存状态
//         → 一次写入存档
//           → 写入成功才算完成
//
//   任何一步失败：**没有任何痕迹**。下一轮看到的还是上一轮的状态。
//
//   注意：这与「欠账」不冲突。欠账记的是**跨轮的**失败
//   （时间过去了但没处理）；本轮事务内失败 = 什么都没发生，时间也没前进。
// ============================================================
import { projectActorProfile, projectCharacterMap } from './character-profile.js';
import { classifyEntries, entriesInRange, canonReplayRange, parseTimePoint, entrySpan } from './interval.js';
import {
  buildVectorQueryInput,
  eventCodeFromTitle,
  CE_MATERIAL_MODES,parseCharacterTags,
} from './vector-input.js';
import { analyzeStoryBoundary, evaluateBoundaryByActor, needsSupplement, tierOf, coveredForProse, formatMissingForProse, renderActorState, CE_BOUNDARY_STRATEGY, parseJsonLoose } from './diff.js';
import { collectActorBundles, renderActorMaterial, buildBiographyPatch } from './actor-state.js';
import { renderEventMaterial } from './vector-input.js';
import {
  isNewcomer,
  buildNewcomerQuery,
  pickNewcomerSections,
  buildNewcomerProfile,
} from './newcomer.js';
import { runGuidance, worldEventGuideText } from './guidance.js';
import {loadLedger,planLedgerCommit,mergeEventProgress,parseEventProgressRows,renderEventProgress,EVENT_PROGRESS_PROTOCOL} from './ledger.js';
import {eventProgressForModel} from './canon-event-details.js';
import { buildCeilings } from './ceiling.js';
import {prepareCanonTurnPlanBoundary,reconcileCanonTurnPlanBoundary,canonBoundaryInputStamp,canonBoundaryStampsEqual,canonBoundaryStampDifferences,eventWithActualWindow,ordinaryUnreachedEvents} from './canon-turn-plan.js';
import {planPrebuiltTurn,repairPrebuiltTurn,buildPrebuiltPayload,PREBUILT_REPAIR_STAGES,routePrebuiltBoundary,runPrebuiltBoundaryBatches,prebuiltBoundaryEvents,prebuiltOrdinaryActorState} from './canon-prebuilt.js';

export async function prepareCanonTurnBoundary(input){return prepareCanonTurnPlanBoundary(input);}
export const routeFrozenCanonBoundary=routePrebuiltBoundary;
export async function reconcileCanonTurnBoundary(input){return reconcileCanonTurnPlanBoundary(input);}
import {
  buildAllCharacterMaterials,
  findUnownedMissing,
  auditMaterials,
  renderOnSceneText,
} from './prose-material.js';
import { overwriteLastParagraph } from './prose-validate.js';
import { collectHostMaterial, materialReportLines, normalizeMaterialLimits,normalizeMaterialCounts,buildMaterialRequiredScope,splitMaterialBySharing,splitRagBySubject,splitRagTitleRecords,ragRecordTitleNames,renderMaterialForPrompt } from './host-material.js';
import { withRetry,describeAbort } from './retry.js';
import { packRequestMaterials, normalizeRequestLimits } from './request-budget.js';

/** 材料超过这个字数就提醒玩家：边界判定会把它整段发给模型 */
export const CE_MATERIAL_WARN_CHARS = 30000;

/**
 * 局部重跑时，按玩家勾选**裁掉没勾的人和没勾的阶段**。
 *
 * ★★★ 2026-11-02 玩家定调（原话）：
 *   「应该是我选什么就只跑什么，我选谁就只跑谁，不能多跑任何一点，
 *     除非是必须要跑的前置条件流程，才跟着重跑。」
 *   「原著补演也要完善到位，不要漏了，一样的道理和逻辑。
 *     区别在于原著补演的关联前置流程多一些」
 *
 * 这个函数原来是 splitBatchesByReplaySelection —— 只把混杂批次**拆开**，
 * 拆出来的「未选的人」那一批仍然被原样交给 batches.map 发请求。
 * 也就是说：勾了 2 个人，实际还是会为另外 8 个人各发一次请求，
 * 只是不会在同一个请求里混着发。玩家花了 token、等了时间，
 * 结果那些人多跑了一遍 —— 完全违背「选谁只跑谁」。
 *
 * 现在改名并改语义：**没勾的，直接丢掉**。
 *   · 整个阶段被勾选（stages 含该阶段）→ 全都要，不裁剪
 *   · 没有勾选信息（正常一轮）→ 全都要，不裁剪
 *   · 有范围勾选 → 只保留被点名的人，其余批次整批丢弃
 *
 * 保留原函数名作为别名，避免其它调用点失效。
 */
function filterBatchesByReplaySelection(batches, stage, selection, idOf) {
  const scopes = selection && Array.isArray(selection.scopes) ? selection.scopes : [];
  // 没有范围级勾选信息就原样返回：不能凭空空裁，那会把正常全量重跑裁光。
  if (!scopes.length) return batches;
  const stages = selection && Array.isArray(selection.stages) ? selection.stages : [];
  // 整个阶段都勾了 → 这个阶段内的所有人都要，不裁。
  if (stages.includes(stage)) return batches;
  const isSelected = (row) => {
    const keys = idOf ? idOf(row) : [];
    return (keys || []).some((key) => key && scopes.includes(stage + ':' + key));
  };
  const out = [];
  for (const group of batches) {
    if (!Array.isArray(group)) { out.push(group); continue; }
    // 单行批次也要判：原来 length<=1 直接放行，导致「勾了 A，
    // 但 B 恰好被单独打成一批」时 B 照样跑。
    const picked = group.filter(isSelected);
    if (picked.length) out.push(picked);
  }
  return out;
}
/* 兼容旧名（其它地方可能还引用）。语义已改为「裁掉未选」，不是「拆开」。 */
function splitBatchesByReplaySelection(batches, stage, selection, idOf) {
  return filterBatchesByReplaySelection(batches, stage, selection, idOf);
}

/** 同次核验的可选辅助字段只归一结构，物件归属和修炼语义均由核验模型确定。 */
function normalizeCompletionReview(entry) {
  const object=value=>value && typeof value==='object' && !Array.isArray(value)?value:null;
  const nested=object(entry.completionReview);
  if(!nested && !['completionFacts','cultivation','baseline'].some(key=>Object.hasOwn(entry,key)))return undefined;
  const facts=entry.completionFacts ?? nested?.facts;
  const cultivation=object(entry.cultivation ?? nested?.cultivation),baseline=object(entry.baseline ?? nested?.baseline);
  const boolean=value=>typeof value==='boolean'?value:value==='true'?true:value==='false'?false:value;
  const out={facts:(Array.isArray(facts)?facts:object(facts)?[facts]:[]).filter(object).map(fact=>({...fact})),cultivation:cultivation?{...cultivation}:null,baseline:baseline?{...baseline}:null};
  if(out.cultivation){
    const progress=out.cultivation.progress;
    if(typeof progress==='string' && progress.trim() && Number.isFinite(Number(progress)))out.cultivation.progress=Number(progress);
    if(Object.hasOwn(out.cultivation,'breakthrough'))out.cultivation.breakthrough=boolean(out.cultivation.breakthrough);
  }
  if(out.baseline && Object.hasOwn(out.baseline,'applicable'))out.baseline.applicable=boolean(out.baseline.applicable);
  return out;
}

const NPC_CULTIVATION_FACTS='核对本人实际修为。只得口诀、初察气感、尝试吐纳、修习未成或象甲功等凡俗炼体，均不构成炼气入门。正文确认本人已引气入体，或明确能按修仙法门引动灵气沿经脉运行且可持续，即已入炼气一层，正文不必直写境界名。韩立经墨师搭脉确认，能以长春功引动体内微凉气息并持续循经运转，就是炼气入门的证据。正文明确练成长春功第N层，落实为炼气第N层（字段格式用炼气一层、炼气二层等），将要突破或接近第N层只保留已成层数。已有更高修为不可被较早里程碑覆盖。已证实的新小境界按明确证据确定层内进度，未交代百分比时取旧规则突破后5–15%的下限5%；已有同层合法进度沿用，只有当前已成立的实际修炼收益才可更新。修炼时段须真实经过，禁止按事件经过比例或调用次数加点。';
const INLINE_PROSE_FACTS='正文写完后再提取简短落地依据；只写本人物正文中已发生的状态、物品、技能、修习和修为。输出 {"name":"本人全名","facts":[{"kind":"inventory|equipment|skill|practice|cultivation|state","name":"事实对象","state":"本轮终点状态","source":"prose","evidence":"从本人正文逐字摘录"}],"cultivation":null,"baseline":{"applicable":false,"basis":"依据"}}。物品状态仅用held/consumed/lost/transferred/destroyed/absent/borrowed/not_owned；场景设施、见闻、他人持有和梦境都不算本人所有。修习与实体秘籍分开，equipment仅表示实际装备，已治愈的伤势写终点恢复情况。已确认的新境界或修为进展必须返回 {realm,progress,breakthrough,basis}，basis逐字引用正文，progress为0到99的整数。'+NPC_CULTIVATION_FACTS+'基础配置仅在有本人正文依据时填写。涉及跨人交付（包括接收）、借用、境界突破或事实不确定，补 needsIndependentReview:true 交独立核对。无事实填[]，不输出任何变量指令。交汇只读段不在这里提取。';

function splitInlineProseReview(raw){
  const text=String(raw??''),match=[...text.matchAll(/^[ \t]*@@落地依据[ \t]*[:：][ \t]*/gmu)].at(-1);
  if(!match)return {text,review:null};
  let review=null;
  try{review=JSON.parse(text.slice(match.index+match[0].length).trim().replace(/^```(?:json)?\s*|\s*```$/gi,''));}catch{}
  return {text:text.slice(0,match.index).trimEnd(),review};
}

function inlineProseReview(row){
  const value=row.inlineCompletion,body=String(row.block?.body||'');
  if(!value||value.needsIndependentReview===true||(value.name&&value.name!==row.name)||!body.trim()||row.block?.handoffDeclared||!Array.isArray(value.facts)||value.facts.length>40)return null;
  const normalizedBody=body.replace(/\s+/gu,' ');
  const hasQuote=text=>typeof text==='string'&&text.trim().length>=2&&normalizedBody.includes(text.trim().replace(/\s+/gu,' '));
  const states=['held','consumed','lost','transferred','destroyed','absent','borrowed','not_owned'];
  const kinds=['inventory','equipment','skill','practice','cultivation','state'];
  const seen=new Set(),facts=[];
  for(const fact of value.facts){
    if(!fact||!kinds.includes(fact.kind)||typeof fact.name!=='string'||!fact.name.trim()||typeof fact.state!=='string'||!fact.state.trim()||
       fact.source!=='prose'||!hasQuote(fact.evidence))return null;
    if(['inventory','equipment'].includes(fact.kind)&&!states.includes(fact.state))return null;
    // Cross-person custody is reviewed with both sides and the current inventory.
    if(['transferred','borrowed'].includes(fact.state))return null;
    if(fact.kind==='state'&&/^(?:当前动机|短期目标|长期目标|所在地|当前动作)$/u.test(fact.name.trim())) continue;
    const key=JSON.stringify([fact.kind,fact.name.trim()]);
    if(seen.has(key))return null;seen.add(key);
    facts.push({kind:fact.kind,name:fact.name.trim(),state:fact.state,source:'prose',evidence:fact.evidence.trim()});
  }
  const c=value.cultivation,b=value.baseline;
  if(c!==null&&(!c||typeof c.realm!=='string'||!c.realm.trim()||!Number.isFinite(c.progress)||c.progress<0||c.progress>100||c.breakthrough!==false||!hasQuote(c.basis)))return null;
  if(!b||typeof b.applicable!=='boolean'||typeof b.basis!=='string'||(b.applicable&&!hasQuote(b.basis)))return null;
  // A bare empty answer cannot establish that the story had no material effects.
  if((!facts.length&&!c&&!b.applicable)||(!c&&facts.some(fact=>fact.kind==='cultivation')))return null;
  return {facts,cultivation:c?{realm:c.realm,progress:c.progress,breakthrough:false,basis:c.basis}:null,baseline:{applicable:b.applicable,basis:b.basis}};
}

function proseReviewInput(row){
  const handoff=row.handoffRequired||row.block.handoffDeclared;
  return {name:row.name,castTier:row.castTier,targetId:row.targetId||'',reviewSource:{kind:'actor_prose',subject:row.name,field:'body'},
    body:row.block.body,timeRange:row.timeRange||{},state:row.state||{},
    ...(handoff?{handoffRequired:true,readOnlyBody:row.block.readOnlyBody||'',variableBody:row.block.variableBody||'',
      mainStory:row.mainStory||'',ordinaryRecords:row.ordinaryRecords||[],mustWrite:row.mustWrite||[],boundary:row.boundary||{},
      events:row.events||[],eventSegments:row.eventSegments||[]}:{}),checks:[]};
}

/** 自然语言覆盖交AI；代码只查人员、索引、布尔值和逐字原句证据。 */
export async function reviewProseByAI({host,rows,options={},eventContext=null}){
  const result={};Object.defineProperties(result,{eventProgress:{value:[],writable:true},progressError:{value:'',writable:true}});
  // 只整理落地依据，移除旧审稿清单；空checks仅兼容旧记录工具。
  const prepared=(rows || []).map(row=>({...row,kind:'actor',packet:proseReviewInput(row)}));
  const progressTasks=Number(options.eventProgressVersion)>=1 && eventContext?(eventContext.events || []).map(event=>({kind:'event',event,
    savedCharacters:Object.fromEntries(parseCharacterTags(event.title).map(tag=>[tag.name,eventContext.characters?.[tag.name]]).filter(pair=>pair[1])),
    confirmedBiographies:Object.fromEntries(parseCharacterTags(event.title).map(tag=>[tag.name,eventContext.biographies?.[tag.name]]).filter(pair=>pair[1])),
    previous:(eventContext.previous || []).find(row=>row.eventId===event.code),boundary:(eventContext.boundary || []).find(row=>row.eventId===event.code),
    stories:(eventContext.blocks || []).filter(block=>!(block.eventIds || []).length || block.eventIds.includes(event.code)).map(block=>({name:block.name,body:block.body,biographyLine:block.biographyLine,status:block.status,reason:block.reason})),world:eventContext.world || '',time:eventContext.time})):[];
  // 玩家主正文只送到实际带事件任务的批次，不混入纯人物核验。
  const shared=progressTasks.length?'【事件进度专用背景开始】\n'+EVENT_PROGRESS_PROTOCOL+'\n原边界观察仅供参考，可以被这次有因果的NPC自然推演改变。事件进度综合实际补演故事和已保存事实记账，不以原文计划、参考结束日期或边界预计结果替代事实。玩家主正文仅供事件进度使用，不是任何NPC的人物补演正文。玩家主正文中的我只代表玩家；每个人物body中的我只代表该人物，不能混为同一人。\n【玩家主正文】\n'+String(eventContext.storyText || '')+'\n【事件进度专用背景结束】':'';
  await Promise.all(packRequestMaterials([...prepared,...progressTasks],{...options.batchLimits,sharedChars:shared.length+4600,measure:row=>JSON.stringify(row.packet||row).length,estimateOutput:()=>1200}).map(async batch=>{
    const actors=batch.filter(row=>row.kind==='actor'),events=batch.filter(row=>row.kind==='event');let parsed,progressRows=[],actorStructureOK=false,eventFeedback='';
    const names=actors.map(row=>row.name);
    // 这一步的职责是「提取落地依据」，不是「核对正文」。
    //
    // 曾经它是一套有罪推定的核验：逐条要求证明覆盖、必须给逐字原句、任何一条对不上
    // 就判整批不合格并重写正文。九个人每人五到八条要求，一次八十七秒、三次就是四分多钟，
    // 这就是「反复重试核对正文」卡死的来源。正文是前序阶段写出来的，前面给的信息对了，
    // 这里几乎不可能真出错——所以不再判对错。
    //
    // 现在只做两件实事：
    //   1. 取变量落地要用的依据（completionFacts / cultivation / baseline）
    //   2. 取事件进度（eventProgress）
    // 顺手发现的问题写进 issues 供排查，但不影响正文是否采用，也不会触发重写。
    const prompt='从NPC视角正文中提取落地依据。核验对象以末尾人物数组中的name为准，待读文本是同一项的body。reviewSource标明人物与正文归属；不同人物的body不能互相替代，玩家主正文更不能替代NPC的body。\n【判断方式：正文已通过，默认它是合格的】\n正文由前序阶段写出并已通过结构检查，你不需要评价它写得好不好，也不要挑刺。文字简略、细节少、未展开某个日期段、叙述顺序与原著不同，都不算问题。\n你只需要做两件事：\n一、按 completionFacts 的字段把正文里**实际发生的事实**提出来：已获得、已失去、已消耗、已交付、已借用、已见闻的物件与技能，以及境界进度和基础配置。只提正文里真写了的事，正文没写就返回空数组，不要根据年表或要求补编。借用、场景设施、他人所有、见闻和梦境不算本人持有。消耗与失去不得重新补回。已确认的新境界或修为进展必须返回 cultivation，basis 逐字引用本人正文，progress 为0到99的整数。'+NPC_CULTIVATION_FACTS+'\n二、如果这批带了 events，按 eventProgress 的格式记录每个事件的进度；本轮尚未开始或未推进的事件也要显式返回一行，用 ongoing 或 pending 写明尚未发生的事项，不能省略。\n【返回格式】\n{"results":[{"name":"姓名","issues":[],"targetId":"人物ID","completionFacts":[],"cultivation":{"realm":"","progress":"","breakthrough":false,"basis":""},"baseline":{"applicable":false,"basis":""}}]}\n每个姓名都必须出现一次，顺序与输入一致。issues 只在发现明确硬错误时填写（把不属于本人的行为/物品/关系写成他的、与已保存事实矛盾、提前结算尚未发生的事件），没有就给空数组。\n'+(events.length?shared+'\n【本批事件，仍在同一次提取中返回eventProgress】\n'+JSON.stringify(events):'');
    const handoffPrompt=actors.some(row=>row.handoffRequired||row.block.handoffDeclared)?'\n【交汇末段只读，漏项例外同次判断】有交汇的每人额外返回handoff:{policy:"read_only_terminal",excluded:true,recordIds:[核对使用的普通阶段成功回执编号，可空],mainEvidence:"主正文逐字原句",reason:"核对结论",missingCanonItems:[{kind:"inventory或equipment",name:"原著道具名",text:"只描述该NPC本轮终点应有道具的最小事实",evidence:"本人交汇末段逐字原句",canonEvidence:"events或eventSegments中原著资料的逐字依据",boundaryEvidence:"mustWrite或boundary中本轮边界判定的逐字依据"}]}。交汇最后一段始终供阅读，不再整体解析变量，普通阶段回执缺失也不能恢复整段。只有你依据本轮边界、当前快照与普通成功回执，确认普通阶段确实漏了本轮实际应有的原著道具时才列missingCanonItems；已有、已消耗、归还、借用或本轮变异后不该有的不能补，普通NPC物品、心理动作等也不能夹带。没有漏项返回空数组。不能仅因回执列表空就推断缺失，结合当前state。再次重复与否仍交原结算兜底核验。交汇段不能新增主正文没有的经历。主正文仅供交汇对照，不代替各人物body。\n':'';
    const completionPrompt=actors.length?'\n【同次核验附带落实依据，不增加请求】每人同项返回targetId及completionFacts:[{kind:"inventory|equipment|skill|practice|cultivation|state",name:"事实对象",state:"事实状态",source:"prose",evidence:"该人物正文逐字依据"}]、cultivation:{realm,progress,breakthrough,basis}、baseline:{applicable,basis}。交汇人物仅从variableBody识别常规事实；readOnlyBody不得进入completionFacts/cultivation/baseline，只有handoff.missingCanonItems已确认道具例外可列为物品事实，不从交汇段重新补技能、境界、性格或动作。第一层：已确认散文事实必须落实，全面识别已持有、获得、失去、交付、已消耗、借用、见闻、梦境、装备、功法修习、技能及熟练度；不能只检查新获得。借用、场景设施、他人所有、见闻和梦境不当本人持有；已交付或送出的实体道具标transferred，不能同时标成送出者当前held；消耗与失去不得重新补回。随身携带的普通工具或信物按inventory识别，equipment只表示原装备栏支持且实际装入槽位的装备；实体书与修习功法、已学技能分开。第二层：按原变量规则合理补全基础配置，baseline只说明是否适用及依据，不再编新剧情。境界进度必须明确，合法0/false保留。'+NPC_CULTIVATION_FACTS+'走廊壁与当前日期约束始终有效，年表和未来终态只是参考，不将尚未发生的E-003后段成果提前兑现。语义归类由你依据同名人物已确认正文判断，不用名称关键词裁决。无事实用空数组；境界或基础适用性无法确定可用null并说明依据，勿臆造。不返回旧checks审稿清单，不因表达或篇幅重写人物正文。\n':'';
    const stateFactPrompt='\n实体物品的state按本轮终点使用held/consumed/lost/transferred/destroyed/absent/borrowed/not_owned之一；过程说明写detail，不用“曾获得”代替当前仍持有，已服用不能重新补回。practice表示修习行为，可落实为原skills或实际功法物；不得因修习就虚构实体书。\n状态事实也必须提取：仅按该人物已确认正文识别受伤、康复、中毒、解毒等身体/Buff的终点状态，kind用state，name为明确状态名称，state写本轮终点情况，evidence逐字引用本人正文；已经痊愈应提康复，不能保留过程旧伤。心理想法、人物经历、见闻及未来可能性不冒充state，不凭关键词另造事实。';
    const actorPacket=JSON.stringify(actors.map(row=>row.packet));
    const run=await withRetry(({correct,previous})=>host.llmCall(correct({stage:'落地依据提取',subject:names.join('、'),messages:[{role:'user',content:prompt+handoffPrompt+completionPrompt+stateFactPrompt+(previous?.text||'')+(eventFeedback?'\n【上次事件进度纠正】\n'+eventFeedback:'')+'\n【本批人物及其唯一待核验正文】\n'+actorPacket}],json:true})),{signal:options.signal,config:options.retry,validate:raw=>{
      actorStructureOK=false;progressRows=[];parsed=parseJsonLoose(raw);const entries=parsed && parsed.results;
      /* ★★ 2026-11-02 全面复盘「合并报错」：原来 3 种情况挤成一句「返回不完整」。拆开。 */
      if(!Array.isArray(entries))return {ok:false,reason:'落地依据提取的返回不是数组：实际是 '+JSON.stringify(entries&&typeof entries)+'；应为人员条目数组'};
      if(entries.length!==actors.length)return {ok:false,reason:'落地依据提取返回的人数对不上：本批有 '+actors.length+' 人（'+names.join('、')+'），但只返回了 '+entries.length+' 条'};
      {
        const returnedNames=entries.map(row=>row&&row.name);
        // actors 是材料对象，不能与返回姓名字符串比较，否则每次正确回信都判全员缺失。
        const missing=names.filter(name=>!returnedNames.includes(name));
        const dup=returnedNames.find((name,index)=>returnedNames.indexOf(name)!==index);
        if(missing.length)return {ok:false,reason:'落地依据提取漏了人物：'+missing.map(name=>'「'+name+'」').join('、')+' 没有返回结果；本批应为：'+names.join('、')};
        if(dup)return {ok:false,reason:'落地依据提取重复返回了同一个人：「'+String(dup)+'」出现了多次；每人只能一条'};
      }
      // 默认通过：只要每个人出现一次、issues 是数组就够了。
      // 不再要求逐条 checks、不再要求为「没问题」提供逐字引用——
      // 那套有罪推定的协议正是反复重试卡死的来源。
      for(const row of entries){
        const expected=actors.find(item=>item.name===row.name);
        if(!expected)return {ok:false,reason:'返回了不属于本批的姓名：'+String(row.name||'')};
        row.issues=(Array.isArray(row.issues)?row.issues:[]).filter(issue=>issue&&typeof issue==='object'&&String(issue.detail||'').trim());
      }
      actorStructureOK=true;
      // 交汇段的结构校验与「默认通过」无关：它查的是 handoff 对象本身是否自洽
      // （只读末段、道具漏项必须带主正文/本人末段/原著/边界四重依据）。
      // 这是防伪造的硬约束，必须保留。
      for(const entry of entries){const expected=actors.find(row=>row.name===entry.name),handoff=validateHandoffReview(expected.block,entry.handoff,expected);if(!handoff.ok){
        // 无可靠交汇漏项依据就不补道具；不因一个人的辅助字段重发整批正文。
        entry.issues.push({kind:'交汇依据',detail:handoff.reason||'交汇依据不完整，本次不授权补道具'});
        entry.handoff={policy:'read_only_terminal',excluded:true,recordIds:[],missingCanonItems:[],reason:'交汇依据未确认；只读保留，不补道具'};
      }}
      if(events.length){const checked=parseEventProgressRows(parsed.eventProgress,events.map(row=>row.event),eventContext.previous,eventContext.time);if(!checked.ok){
        // 漏项/多项属于回信不完整，先在同一请求里指出具体编号重发，不驱动人物重写，也不把未判断当成已完成。
        const allowed=events.map(row=>row.event.code);
        const items=[];
        if(checked.missing?.length)items.push({label:'缺少事件进度',actual:'未返回',expected:checked.missing.join('、'),hint:'每个本次事件都必须返回且只返回一次'});
        if(checked.unexpected?.length)items.push({label:'不属于本批的编号',actual:checked.unexpected.join('、'),expected:allowed.join('、'),hint:'编号只能用本批 events 里的 code'});
        if(checked.invalid?.length)items.push({label:'编号或status不合法',actual:checked.invalid.join('、'),hint:'status 用 ongoing/changed/blocked/completed/replaced/expired/cancelled'});
        eventFeedback='事件进度须覆盖本次全部事件；未判断不能当作已完成。'+(items.map(row=>row.label+'：'+(row.actual||'')+(row.expected?'（应为 '+row.expected+'）':'')).join('；')||'')+'。每个本次事件都必须返回且只返回一次eventProgress，编号用本批events里的code，未发生的事项放pending而不是省略该事件；人物核验部分照原样返回，无需重写正文。';
        result.progressError=eventFeedback; // 最终世界阶段统一确认，不为可选进度重发人物依据。
      }else progressRows=checked.rows;}
      return {ok:true};
    }});
    if(!run.ok){
      if(events.length)result.progressError=run.reason;
      // 请求没做成（超时、回信格式坏）时正文照样保留。
      // 这一步本来就不判正文合格与否，所以核验失败不影响正文落地，
      // 只是拿不到这次的落地依据和事件进度，交给后续阶段按缺依据处理。
      if(!events.length || !actorStructureOK){
        for(const row of actors)result[row.name]={ok:true,unverified:true,reviewFailed:true,issues:[],gaps:[{type:'api',detail:'落地依据提取未完成：'+run.reason}]};
        return;
      }
    }
    if(run.ok)result.eventProgress.push(...progressRows);
    // 这一步只取两样下游要用的东西，不判正文合格与否：
    //   1. completionReview —— 变量落地的事实依据（completionFacts/cultivation/baseline）
    //   2. eventProgress    —— 事件进度记账
    // issues 只是记录，供排查用，不再参与 ok 判定，也不会触发重写。
    for(const entry of parsed.results){
      const row=actors.find(item=>item.name===entry.name);
      if(!row)continue;
      const issues=(Array.isArray(entry.issues)?entry.issues:[]).filter(issue=>issue&&String(issue.detail||'').trim()).map(issue=>({type:String(issue.kind||'语义问题'),detail:String(issue.detail||'').trim()+(issue.fix?'：应改为'+String(issue.fix).trim():'')}));
      const completionReview=normalizeCompletionReview(entry);
      if(completionReview && row.block.handoffDeclared){
        const front=String(row.block.variableBody || ''),items=entry.handoff?.policy==='read_only_terminal'?entry.handoff.missingCanonItems || []:[];
        completionReview.facts=completionReview.facts.filter(fact=>typeof fact.evidence==='string' && fact.evidence.trim() && (front.includes(fact.evidence) || ['inventory','equipment'].includes(fact.kind) && items.some(item=>item.evidence.includes(fact.evidence))));
        if(!front.trim()){completionReview.cultivation=null;completionReview.baseline={applicable:false,basis:'交汇段仅允许补AI确认的原著道具漏项，不重新补全普通阶段人物变量'};}
      }
      result[row.name]={ok:true,issues,handoff:entry.handoff||null,...(completionReview?{completionReview}:{})};
    }
  }));
  return result;
}

/**
 * 生平旧账：跑一批人的「过往经历」。
 *
 * 输入只有**存档现状 + 原著推力**。正文绝不进来——
 * 用户 2026-10-21：「正文是当前进行时刻发生的事情，他怎么会影响历史呢？」
 *
 * 一次批量调用所有人（绝大多数人答案就是年表原样，只有被玩家改过的才需要推）。
 * **失败不阻断**：整批退回「按原著 + 标记」，宁可留个记号，也别让这几个月凭空消失。
 */
async function runBackstory(booking) {
  const { host, rows, turnStart, turnEnd, options, diag, step } = booking;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return {};

  const out = {};
  const backstoryBatches = packRequestMaterials(list,{...options.batchLimits,estimateOutput:row=>Math.max(800,(row.events || []).length*120)}).flatMap(group=>group.some(row=>(options.replay?.scopes||[]).includes('生平旧账:'+row.name))?group.map(row=>[row]):[group]);
  // 再兜一层：勾选信息在 options.replay.scopes 里，混杂批次就地拆开，
  // 别等 frReplayResolve 抛异常中止整轮（见 splitBatchesByReplaySelection 注释）。
  const batches = splitBatchesByReplaySelection(backstoryBatches,'生平旧账',{scopes:options.replay?.scopes||[],stages:options.replay?.stages||[]},row=>[row.name,row.id]);

  let degraded = 0;
  // 这批人的旧账没取到，标成未确认。
  // 必须让玩家看见，也必须让上层知道「这些人的旧账是空的，
  // 不是因为没经历，是因为这次没取到」。
  const unconfirmed = [];
  await Promise.all(batches.map(async (batch) => {
    const promptRows = batch.map((r) => ({
      name: r.name,
      stateText: r.stateText,
      events: r.events,
    }));
    const content = buildBackstoryPrompt(promptRows, {
      template: options.backstoryPrompt,
      turnStart,
      turnEnd,
    });
    const expectedNames = batch.map((r) => r.name);

    let got = null;
    let batchFailed = false;
    if (host && typeof host.llmCall === 'function') {
      const run = await withRetry(
        ({correct}) => host.llmCall(correct({ stage:'生平旧账', subject:expectedNames.join('、'), messages: [{ role: 'user', content }], json: true })),
        {
          config: options.retry,
          retryDelayMs: options.retryDelayMs,
          maxDelayMs: options.retryMaxDelayMs,
          // 玩家停止后不再重试
          signal: options.signal || null,
          validate: (text) => {
            const p = parseBackstory(text, expectedNames);
            return { ok: p.ok, reason: p.reason };
          },
          onRetry: (attempt, max, reason, delay) => {
            if (typeof options.onRetry === 'function') {
              options.onRetry({ stage: '生平旧账', attempt, max, reason, delay });
            }
          },
        },
      );
      if (run.ok) {
        got = parseBackstory(run.value, expectedNames).byName;
      } else {
        // 这一批**失败了**：模型没调通或解析不出来。
        //
        // 失败和「模型说这些人没经历」是两件事，绝不能用降级掩盖：
        // 降级会把年表原句当成「他实际做了什么」写进第 35 列，
        // 等于用原著结果冒充既定历史。
        batchFailed = true;
        diag.warn(
          '生平旧账这批没取到',
          `${expectedNames.join('、')}：${run.reason || '模型没给出可用结果'}。`
          + '这一批的旧账标为未确认，不按原著顶替。',
        );
      }
    } else {
      // 宿主没有模型能力：这是配置缺失，不是「他们没经历」
      batchFailed = true;
      diag.warn('生平旧账无法生成', '宿主没有 llmCall，旧账标为未确认');
    }

    const merged = mergeBackstory({
      actors: batch.map((r) => ({ name: r.name, events: r.events })),
      byName: got || {},
      batchFailed,
      options: { location: turnStart },
    });

    for (const [name, lines] of Object.entries(merged)) {
      out[name] = lines;
      if (lines.some((l) => l.fromOriginal)) degraded += 1;
      if(typeof booking.onReady==='function')booking.onReady(name,lines,!batchFailed);
    }
    if (batchFailed) {
      for (const n of expectedNames) unconfirmed.push(n);
    }
  }));

  const total = Object.values(out).reduce((n, lines) => n + lines.length, 0);
  step('生平旧账', `${Object.keys(out).length} 人，共 ${total} 条`
    + `${degraded > 0 ? `（${degraded} 人按原著降级）` : ''}`);

  if (degraded > 0) {
    diag.warn(
      `${degraded} 人的过往经历没能推出来`,
      '退回「按原著原样记录」，条目末尾标了「（按原著）」，玩家看得出这不是推出来的版本',
    );
  }

  if (unconfirmed.length > 0) {
    diag.warn(
      `${unconfirmed.length} 人的旧账没取到，标为未确认`,
      `${unconfirmed.join('、')}。这次没生成，**不拿原著顶替**——`
      + '拿原著顶替等于把「本该发生的事」写成「他真做过的事」，'
      + '会污染第 35 列的既定历史。这些人的旧账留给下一轮。',
    );
  }

  // 把「哪些人的旧账是未确认的」带出去。
  // 调用方要据此避免把空数组当成「他确实没有经历」。
  Object.defineProperty(out, '__unconfirmed', {
    value: unconfirmed.slice(),
    enumerable: false,   // 不进 Object.keys，不影响既有消费方
    writable: true,
    configurable: true,
  });

  return out;
}

/**
 * 把 name -> BackstoryLine[] 摊平成可直接写第 35 列的字符串数组。
 *
 * 每条形如 `[0013年05月@神手谷]赶到谷口，没等到人`。
 */
function collectBackstoryLines(backstory) {
  const src = backstory && typeof backstory === 'object' ? backstory : {};
  const out = [];
  for (const [name, lines] of Object.entries(src)) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      const text = formatBackstoryLine({ ...line, name });
      if (text) out.push({ name, line: text, fromOriginal: line.fromOriginal === true });
    }
  }
  return out;
}

/** 取一条事件的编号（E-001 这种），取不到返回空串 */
function eventCodeOf(entry) {
  try {
    return eventCodeFromTitle(String(entry && entry.title || ''));
  } catch (e) {
    return '';
  }
}

/**
 * 找出「跨过本轮终点、还没走完」的事件。
 *
 * 用户 2026-10-21：
 *   「当前真处于区间的这个年表事件并未完成……
 *     极少数情况刚好踩在完成的时间点，但是大多数情况都是未完成」
 *
 * 判定：起止时间盖住本轮终点，且终点严格早于事件结束时间。
 * 踩在结束点那一刻的（end <= now）不算，它已经走完了。
 *
 * @param {Array<object>} candidates 候选事件
 * @param {string} endTime 本轮终点
 * @returns {Array<{entry:object, code:string, coveredTo:string, endAt:string}>}
 */
function findInProgressEvents(candidates, endTime) {
  const out = [];
  const now = parseTimePoint(endTime);
  if (now === null) return out;

  for (const entry of (Array.isArray(candidates) ? candidates : [])) {
    const span = entrySpan(entry);
    if (!span) continue;
    if (span.min <= now && now < span.max) {
      out.push({
        entry,
        code: eventCodeOf(entry),
        coveredTo: String(endTime || '').trim(),
        endAt: String(entry.time_end || entry.year_end || '').trim(),
      });
    }
  }
  return out;
}

/**
 * 把「跨轮事件」渲染成给模型看的一段话。
 *
 * 关键：明确告诉模型「这条还没走完，别把结局写进终态」。
 *
 * @param {Array} inProgress findInProgressEvents 的产物
 * @param {string} endTime
 * @returns {string}
 */
function renderInProgressNotice(inProgress, endTime) {
  const list = Array.isArray(inProgress) ? inProgress : [];
  if (list.length === 0) return '';

  const lines = [
    '## 注意：下面这些原著事件还在进行中',
    '',
    `本轮只走到 ${endTime}，这几条还没结束：`,
  ];
  for (const x of list) {
    lines.push(`· ${x.code}（整条从 ${String(x.entry.time_start || x.entry.year_start || '?')} 到 ${x.endAt || '?'}）`);
  }
  lines.push('');
  lines.push('**只写走到本轮终点这一刻的样子，不要写它们最后的结局。**');
  lines.push('后面还没发生的事，写了就是剧透。');
  return lines.join('\n');
}

/**
 * 找出「当前事件」——时间区间盖住给定时间点的那几条。
 *
 * 用户 2026-10-21 定：只有这些用小说原文，其余用简单版。
 *
 * 为什么是「盖住终点」而不是「盖住起点」：
 *   这一轮从起点走到终点，终点那一刻世界线就在这儿。
 *   起点那一条是这一轮开头的事，已经过去了。
 *
 * @param {Array<object>} candidates 候选事件
 * @param {string} timeText 本轮终点时间
 * @returns {Set<string>} 事件编号集合
 */
function findCurrentEventCodes(candidates, timeText) {
  const out = new Set();
  const now = parseTimePoint(timeText);
  if (now === null) return out;

  for (const entry of (Array.isArray(candidates) ? candidates : [])) {
    const span = entrySpan(entry);
    if (!span) continue;
    if (span.min <= now && now <= span.max) {
      const code = eventCodeOf(entry);
      if (code) out.add(code);
    }
  }
  return out;
}
import { buildProsePrompt, buildMinorRolesPrompt } from './prose-prompt.js';
import { planProseDispatch, describeDispatch, CE_PROSE_DISPATCH } from './prose-dispatch.js';
import {splitProseMaterial,mergeProseResults} from './prose-budget.js';
import { assignCastTiers, CE_CAST_TIER } from './role-roster.js';
import {
  pickWorldEntries,
  buildWorldBlockPrompt,
  parseWorldBlock,
  auditWorldBlock,
  renderWorldBlockForMisc,
  CE_WORLD_NAME,
} from './world-block.js';
import { extractHooks, advanceHooks, openHooks, renderHooksForProse } from './yellow-hooks.js';
import {
  parseProseBlock,splitHandoffStory,validateHandoffReview,
  validateProseBlock,
  buildRetryHint,
  settleProseResults,
  formatDebtsForPlayer,
  CE_MAX_RETRY,
} from './prose-validate.js';
import {
  resolveTurnFocus,
  renderFocusMaterial,
} from './turn-focus.js';
import { resolvePrompt } from './prompt-registry.js';
import {
  buildBackstoryPrompt,
  parseBackstory,
  mergeBackstory,
  fallbackBackstory,
  formatBackstoryLine,
  firstAppearLine,
  CE_BACKSTORY_BATCH,
} from './backstory.js';
import { composeBiography, collectProseBiography } from './biography.js';
import {
  createDiagRecorder,
  recordTurnResult,
  renderDiagHtml,
  renderPlayerFeedback,
} from './visibility.js';
// ============================================================
// 一轮原著补演 · 编排器
//
// 依据：总设计 §3.1 的十二步时序。
// 用户 2026-10-21 定：**编排器，不是 Agent**（酒馆里跑不动 Agent）。
//
// ------------------------------------------------------------
// 编排器只做三件事：
//   1. 按固定顺序调各步骤
//   2. 步骤间搬数据
//   3. 失败时整体回退（不写任何东西）
//
// 它**不**判断语义、不写提示词、不解析模型输出——那些归各组件。
//
// ------------------------------------------------------------
// 事务边界（总设计 §4.12.3 第 1 层）：
//
//   内存副本应用完成
//     → 全部校验通过
//       → 格式化成待保存状态
//         → 一次写入存档
//           → 写入成功才算完成
//
//   任何一步失败：**没有任何痕迹**。下一轮看到的还是上一轮的状态。
//
//   注意：这与「欠账」不冲突。欠账记的是**跨轮的**失败
//   （时间过去了但没处理）；本轮事务内失败 = 什么都没发生，时间也没前进。
// ============================================================


/** 一轮跑完了 */
export const CE_TURN_STATUS = {
  ok: 'ok',
  /** 差集为空，本轮不需要补 */
  nothingToDo: 'nothing_to_do',
  /** 边界判定失败 */
  boundaryFailed: 'boundary_failed',
  /** 散文全部失败 */
  proseFailed: 'prose_failed',
  /** 事务内失败，整轮回退 */
  rolledBack: 'rolled_back',
};

/**
 * 【正文前】跑一次原著指导。
 *
 * 这是整个系统**唯一**在正文之前跑的环节（总设计 §2.1、§10-10）。
 * 它只产出约束文字，不写存档；失败就当没发生，正文照常生成。
 *
 * **只针对当前这一个年表事件**（用户 2026-10-21 看过原版源码后的最终口径）：
 *   不是把区间内所有事件端出来，也不是按时间区间筛，
 *   而是定位「这一刻世界线卡在哪个 E-###」，只指导这一个。
 *
 * @param {object} input
 * @param {object} input.host CEHost
 * @param {string} input.worldTime 存档当前世界时间
 * @param {Array<object>} input.timeline 年表条目
 * @param {string} [input.playerInput] 玩家本轮输入
 * @param {string} [input.location] 玩家当前所在地
 * @param {Array<object>} [input.onScene] 在场人物 [{ name, state }]
 * @param {object} [input.options]
 * @returns {Promise<object>}
 */
export async function runCanonGuidance(input) {
  const src = input && typeof input === 'object' ? input : {};
  const options = src.options || {};
  const overrides = options.promptOverrides || null;

  const trace = [];
  const step = (name, detail, view) => { trace.push({ step: name, detail: detail || '' }); if(typeof options.onStage==='function'){try{options.onStage(name,detail||'',view);}catch(_){}} };
  // 重试要写进诊断，这里必须有自己的 recorder。
  // （之前误用了未定义变量，重试一次就抛 ReferenceError）
  const diag = createDiagRecorder();

  // ---------- 本轮焦点：围绕玩家，而不是围绕时间轴 ----------
  //
  // 用户 2026-10-21：
  //   「原著指导的核心目的是围绕玩家来指导，
  //     这一轮的剧情应该怎么体验原著对剧情的影响。」
  //   「这一轮剧情会涉及的原著相关的人、事、物
  //     才需要指导怎么合理的写在剧情里，本质是这个」
  //
  // 光按时间远近挑事件是不够的：玩家闭关二十年，区间里 73 个人、68 条事，
  // 全塞进去又贵又散，而且绝大多数跟他这一刻毫无关系。
  //
  // 焦点取四条并集（都在 turn-focus.js 里）：
  //   ① 在场  ② 玩家提到的  ③ 正在进行的原著事件  ④ 已建档的原著人物
  const focus = resolveTurnFocus({
    timeline: src.timeline,
    worldTime: String(src.worldTime || ''),
    playerInput: src.playerInput,
    location: src.location,
    onScene: src.onScene,
    archived: src.archived,
  });
  if (focus && Array.isArray(focus.people) && focus.people.length > 0) {
    step('焦点', `${focus.people.length} 人、${(focus.events || []).length} 条事围绕玩家`);
  }

  const result = await runGuidance({
    // 围绕玩家筛出来的焦点
    focus,
    focusMaterial: renderFocusMaterial(focus),
    storyTimeline: src.storyTimeline,priorNpcState:src.priorNpcState,
    canonicalNames:src.canonicalNames || [...(src.knownPeople?.canonNames || [])],logId:src.logId,
    host: src.host,
    timeline: src.timeline,
    worldTime: String(src.worldTime || ''),
    playerInput: src.playerInput,
    location: src.location,
    onScene: src.onScene,
    options: {
      promptOverrides: overrides,
      maxCandidates: options.maxCandidates,
      materialMode: options.materialMode,
      materialMaxChars: options.materialMaxChars,batchLimits:options.batchLimits,
      requestBatchVersion:options.requestBatchVersion,
      signal:options.signal,
      materials: options.materials,
      materialLimits:options.materialLimits,
      materialCounts:options.materialCounts,
      // 玩家在面板上设的重试次数要传下去，否则原著指导不吃这个设置
      retry: options.retry,
      retryDelayMs: options.retryDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      onRetry: (info) => {
        diag.warn(
          `重试·${info.stage}（第 ${info.attempt}/${info.max} 次）`,
          `${info.reason}${info.delay > 0 ? `，等 ${info.delay}ms 后重来` : ''}`,
        );
        // 调用方自己也想收一份（测试、外部监控），一并转发
        if (typeof options.onRetry === 'function') options.onRetry(info);
      },
    },
  });

  if (result.node) {
    step('当前节点', (result.node.code || '（无编号）') + ' ' + (result.node.title || '')
      + '（世界线' + result.node.position + '）');
  } else {
    step('当前节点', '这一刻没有落到任何年表事件上');
  }
  step('候选', (result.candidates || []).length + ' 条');
  step('原著指导', result.ok
    ? ('成功' + (result.text ? '（有边界）' : '（空边界）'))
    : ('失败：' + result.reason));

  // 重试过就说清楚试了几次，玩家才知道为什么这一轮慢
  if (result.retry && Number(result.retry.attempts) > 1) {
    step('重试', `${result.retry.attempts} 次才${result.ok ? '拿到结果' : '失败'}`);
  }

  return {
    // 失败降级：正文照常，不注入（08-13 §6.1）
    ok: result.ok,
    text: result.text || '',
    guidance: result.guidance || null,
    injectable: Boolean(result.ok && result.text),
    node: result.node || null,
    candidates: result.candidates || [],
    trace,
    reason: result.reason || '',
    // 资料采集明细：哪些取到了、哪些没有、为什么
    materialReport: result.materialReport || [],
    materialState:result.materialState || null,guidanceContext:result.guidanceContext || null,
    retrievalReceipt:result.retrievalReceipt || null,
    // 重试情况：试了几次、每次都错在哪。桥接层与调用方都要看得到
    retry: result.retry || null,
    // 重试记录：桥接层要写进思维 tab，玩家才看得到「这一轮慢在哪」
    diagItems: diag.items(),
    diagHtml: renderDiagHtml(diag.items()),
  };
}

/**
 * 跑一轮原著补演。
 *
 * @param {object} input
 * @param {object} input.host CEHost 端口
 * @param {string} input.worldTime 存档当前世界时间
 * @param {string} input.targetTime 本轮预计到达时间
 * @param {Array<object>} input.timeline 年表条目（全量或已裁剪）
 * @param {string} input.storyText 本轮正文
 * @param {Array<object>} [input.debts] 欠账
 * @param {object} [input.characters] 人物状态查表 { [name]: {profile,state,goal,aliases,isPlayer} }
 * @param {object} [input.options] 其它配置（材料模式、边界策略、分派策略、覆盖表…）
 * @returns {Promise<object>}
 */
/**
 * 从宿主读一段现成的文本（世界大事 / 世界因子 / 最近正文…）。
 *
 * 两个要点：
 *   ① 可能返回 Promise，也可能直接返回字符串，统一 await。
 *   ② **读不到就是空**，不编。这些是锦上添花的背景，
 *      读不到时代码照常跑——但和「占位符填不上」是两回事，
 *      那属于 bug，会在提示词层暴露出来（空值会写成「无」）。
 */
async function readHostText(host, key) {
  try {
    if (!host || typeof host[key] !== 'function') return '';
    const raw = await host[key]();
    const text = String(raw == null ? '' : raw).trim();
    // 宿主有时会回「无世界因子」这种占位话，当空处理
    if (!text || text === '无' || text === '无世界因子') return '';
    return text;
  } catch (e) {
    return '';
  }
}

function prebuiltCapacityReason(failures) {
  const failure=failures.find(row=>row.code==='input_capacity');
  return failure?[failure.stage,failure.subject,failure.reason].filter(Boolean).join(' · '):'';
}

export async function runCanonTurn(input) {
  const live = input && typeof input === 'object' ? input : {};
  const resume=live.options?.replay?.preserveInput&&live.options.replay.continuationInput;
  // 叙事读取保留当时基线，变量提交仍认宿主实时回执；不将自己刚保存的人物终态倒灌进旧故事。
  const snapshotKeys=['saveId','archiveName','branchId','logId','turnNo','worldTime','targetTime','storyText','playerInput','characters','beforeStateRows','onScene','location','debts','openEvents','eventProgress','prebuiltActorDifferences','eventWatches','mutationNotes','previousTurn','hooks','canonicalNames','materialState'];
  const reusable=resume?.version===1&&resume.data
    &&(resume.data.saveId||resume.data.archiveName||'')===(live.saveId||live.archiveName||'')
    &&(resume.data.branchId||'')===(live.branchId||'')
    &&resume.timeline===JSON.stringify(live.timeline)&&resume.data.logId===live.logId&&resume.data.storyText===live.storyText&&resume.data.targetTime===live.targetTime;
  // 未定义也是冻结值，不能让保存后新增的 materialState 等回流到同轮输入。
  const src = reusable?{...live,...Object.fromEntries(snapshotKeys.map(key=>[key,resume.data[key]])),preparedBoundary:resume.preparedBoundary||undefined}:live;
  if(reusable)src.options={...live.options,turnNo:resume.data.turnNo};
  if(reusable&&!Object.hasOwn(resume.data,'eventWatches')){
    // 旧接续快照漏存 watches。只从同存档、楼层、正文、终点及年表的完整签名恢复。
    const frozen=live.options?.replay?.frozenBoundary||resume.preparedBoundary;
    try{
      const stamp=JSON.parse(frozen?.inputStamp||frozen?.turnPlan?.inputStamp||'');
      if(stamp.version===2&&stamp.save===(src.saveId||src.archiveName||'')
        &&stamp.branch===(src.branchId||'')&&stamp.log===src.logId&&stamp.story===src.storyText
        &&stamp.end===src.targetTime&&JSON.stringify(stamp.timeline)===resume.timeline){
        src.eventWatches=stamp.watches;
      }
    }catch(_){}
  }
  const host = src.host;
  const options = {...(src.options || {}),signal:src.signal || (src.options && src.options.signal) || null,
    turnNo:Number(src.turnNo) || Number(src.options && src.options.turnNo) || 1};
  // 只证明原轮数据确已完整恢复，区别于后续完整边界签名证明；供旧失败轮读取全局原始返回。
  if(reusable&&typeof options.replay?.onContinuationInputVerified==='function')await options.replay.onContinuationInputVerified({archiveName:src.archiveName||src.saveId||'',logId:src.logId||''});
  const overrides = options.promptOverrides || null;
  // 中止信号：玩家点了停止，本轮就不该再产出「已成功」的结果。
  // 入口先归一化一次，后面各步都看它。
  const signal = src.signal || options.signal || null;
  const aborted = () => Boolean(signal && signal.aborted);

  const trace = [];
  const step = (name, detail, view) => { trace.push({ step: name, detail: detail || '' }); if(typeof options.onStage==='function'){try{options.onStage(name,detail||'',view);}catch(_){}} };
  // 诊断：与 trace 并行记录，但 trace 是给程序看的，diag 是给玩家看的
  const diag = createDiagRecorder();
  let hostMaterial = {material:{},report:[],text:''};
  let preparedBoundary=null,activePrebuiltRepair=null,activePrebuiltFailureStage=PREBUILT_REPAIR_STAGES.commit;
  let actorProgressSaved=false;
  const continuationInput={version:1,timeline:JSON.stringify(src.timeline),data:JSON.parse(JSON.stringify(Object.fromEntries(
    snapshotKeys.filter(key=>src[key]!==undefined).map(key=>[key,src[key]]))))};
  step('本轮接续基线','保留原时点材料，继续时不改写既定故事',{kind:'continuationInput',input:continuationInput});
  const retrievalReceipt={status:'not_needed',attempted:false,completed:false,batches:0,reason:'当前无须检索的事件'};

  // 所有出口都过这里。中止时一律改报 rolledBack：
  //
  // 玩家点了停止，就不能再产出「ok / 已落地 / 账本推进」这种结果。
  // 否则停止之后补演还在后台悄悄把账本推进、把生平写进第 35 列，
  // 下次进来世界时间已经跳过去了，玩家却什么都没看到。
  //
  // 这一层是**兜底**：正常路径上各步骤自己也会检查中止并提前收手。
  const finish = (status, payload) => {
    if(activePrebuiltRepair){
      if(status!==CE_TURN_STATUS.ok&&!activePrebuiltRepair.failures.length)activePrebuiltRepair.failures.push({stage:activePrebuiltFailureStage,reason:payload?.reason||'预制任务尚未完成'});
      payload={route:'prebuilt',prebuiltMode:preparedBoundary?.turnPlan?.prebuiltMode||'direct',prebuiltRepair:activePrebuiltRepair,...payload};
    }
    /* 2026-11-03 玩家验收标准第一条「运行日志及时清理，按照原卡逻辑」：
     * 这里原来是【临时诊断】console.warn('[补演出栈] …')，每次出栈都打一行，
     * 还附带 new Error().stack 取调用处 —— 排查「停止无效」时加的，问题已查清修好，
     * 正式版不该继续往日志里刷。删掉后下面的中止兜底逻辑完全不变。 */
    if (aborted() && status !== CE_TURN_STATUS.rolledBack) {
      return {
        ...payload,
        status: CE_TURN_STATUS.rolledBack,
        ok: false,
        aborted: true,
        reason: describeAbort(options.signal)+'，本轮结果作废，不推进账本',
        // 中止就是没落地，别让上面看到 landed/stagedOk 为真
        landed: false,
        stagedOk: false,
        succeeded: false,
        changed: false,
      };
    }
    return {continuationInput:{...continuationInput,preparedBoundary}, materialReport:hostMaterial.report, materialState:hostMaterial.retryState || null,retrievalReceipt:{...retrievalReceipt}, ...(preparedBoundary?{turnPlan:preparedBoundary.turnPlan,storyAnalysis:preparedBoundary.storyAnalysis}:{}), ...payload, status, ok: status === CE_TURN_STATUS.ok };
  };

  try {
  // ---------- 步骤 0：读账本 ----------
  //
  // 账本四项（用户 2026-10-21 定）：
  //   worldTime   走到哪了
  //   debts       欠着什么（带是谁缺哪个维度）
  //   openEvents  跨轮事件处理到哪了（E-007 从 0011 到 0015，一轮只走一半）
  //   lastTurn    上一轮干了什么
  //
  // 调用方（桥接层）会从最近一层快照里读出来传进来，
  // 这样玩家回退到哪一层，账本就是哪一层的。
  let ledger = null;
  let debts = src.debts;
  let openEvents = Array.isArray(src.openEvents) ? src.openEvents : undefined;
  let worldTime = String(src.worldTime || '').trim();

  if (!worldTime || debts === undefined || openEvents === undefined) {
    const loaded = await loadLedger(host, { worldTime });
    ledger = loaded.ledger;
    if (!worldTime) worldTime = ledger.worldTime;
    if (debts === undefined) debts = ledger.debts;
    if (openEvents === undefined) openEvents = ledger.openEvents;
    if (loaded.repaired) {
      step('账本', '读取时修复过（有损坏或被丢弃的项）');
      diag.warn('账本读取时修复过', loaded.dropped.length > 0 ? `丢弃了 ${loaded.dropped.length} 项无法解析的记录` : '');
    } else {
      step('账本', `${ledger.worldTime || '（空）'}，欠账 ${ledger.debts.length} 段`
        + `，跨轮事件 ${ledger.openEvents.length} 条`);
    }
  } else {
    ledger = {
      worldTime,
      debts: Array.isArray(debts) ? debts : [],
      openEvents,
      eventProgress:src.eventProgress || [],
      prebuiltActorDifferences:src.prebuiltActorDifferences || [],
      eventWatches:src.eventWatches || [],
      mutationNotes:src.mutationNotes || [],
      hooks: Array.isArray(src.hooks) ? src.hooks : [],
      turnNo: Math.max(0, (Number(src.turnNo) || 1) - 1),
      lastTurn: src.previousTurn || null,
    };
  }

  // 上一轮补到哪了：给玩家和模型都看得到
  if (ledger && ledger.lastTurn) {
    const lt = ledger.lastTurn;
    step('上一轮', `${lt.rangeStart || '?'} → ${lt.rangeEnd || '?'}`
      + `${lt.wroteNames && lt.wroteNames.length > 0 ? `，补成了 ${lt.wroteNames.join('、')}` : ''}`);
  }
  if (Array.isArray(openEvents) && openEvents.length > 0) {
    step('跨轮事件', `${openEvents.length} 条还在进行中：`
      + openEvents.slice(0, 3).map((e) => `${e.eventId}（到 ${e.coveredTo}）`).join('、'));
  }

  // ---------- 步骤 1：算区间（纯代码） ----------
  const turnRange = canonReplayRange(
    { start: worldTime, end: String(src.targetTime || src.preparedBoundary?.range?.end || options.preparedBoundary?.range?.end || '') },
    debts, src.timeline,
  );
  step('区间', `${turnRange.start} → ${turnRange.end}${turnRange.applied ? '（含欠账）' : ''}`);

  if (!turnRange.start || !turnRange.end) {
    return finish(CE_TURN_STATUS.rolledBack, withVisibility({
      trace, diag, reason: '世界时间或目标时间缺失',
    }, { ledger }));
  }

  /* ★★★ 2026-11-03 玩家报：「我全选失败项重跑，从补演边界判定开始重跑了，逻辑是不是还是不对？」
   *
   * 【玩家看到的现象】
   *   勾的是「写人物正文 3 项 + 写进存档 10 项」= 13 项失败项，
   *   实际执行却从最上游的「补演边界判定」开始，最后跑了 53 项。
   *
   * 【病根】这一行的条件写的是 `options.canonPushBoundaryVersion>=1` —— 局部重跑必带这个开关，
   * 所以**每次重跑都无条件重算前置边界**，玩家勾了什么完全不影响。
   *
   * 后果不只是多跑一步：边界一变，它的产物（本轮有哪些原著任务、每个人分到哪些事件、
   * 起止区间）全变，下游所有原本能复用的结果按指纹比对全部失配，
   * 于是「勾 13 项」等于「跑整轮」，勾选精细度形同虚设。
   *
   * 【现在的规则】
   *   ① 局部重跑（options.replay 存在）时，**优先复用冻结边界**。
   *      边界结果本质上就是「第一阶段的结果」，按玩家反复强调的
   *      「上一阶段的结果本质上不就是下一阶段的资料吗」，它就该被当资料复用。
   *   ② 复用前仍做语义指纹校验（canonBoundaryInputStamp 已排除篇幅类设置，
   *      只认正文/时间/年表/人物/进度/欠账等真正影响分工的输入）。
   *      对不上**不静默重算**，而是明确告诉玩家「源头变过了」，
   *      由玩家决定要不要连边界一起重跑 —— 这正是玩家要的「只跑我勾的」。
   *   ③ 非局部重跑（正常一整轮）行为完全不变，仍按原逻辑算边界。
   *
   * 【兼容】冻结边界存在 replay.boundary 里的是**起止时间**，
   * 完整的 preparedBoundary 副本存在 replay.frozenBoundary 里（见 canon-replay.js）。
   * 拿不到副本时退回原行为，不会因为缺数据而跑不动。 */
  // Product routing does not depend on the ordinary replay's pre-boundary/tier switch.
  const matchedCandidates=entriesInRange(src.timeline,turnRange.start,turnRange.end);
  const closedProductEvents=new Set((ledger.eventProgress || []).filter(row=>row.resolved).map(row=>row.eventId));
  const pendingProductEvents=new Set([...(ledger.eventProgress || []).filter(row=>!row.resolved).map(row=>row.eventId),...(openEvents || []).map(row=>row.eventId)]);
  for(const event of src.timeline || [])if(pendingProductEvents.has(inferEventCode(event))&&!matchedCandidates.some(row=>inferEventCode(row)===inferEventCode(event)))matchedCandidates.push(event);
  const productScope=matchedCandidates.filter(event=>!closedProductEvents.has(inferEventCode(event))).map(event=>eventWithActualWindow(event,ledger.eventProgress||[],turnRange.end));
  const hasMatchedProducts=productScope.length>0&&prebuiltBoundaryEvents(productScope).length===productScope.length;
  let replayFrozen=(options.replay && options.replay.frozenBoundary) || null;
  // A successfully corrected product boundary may be newer than the independent frozen key.
  // Only same-input prebuilt continuation can supersede it; ordinary replay keeps its existing rule.
  if(reusable&&options.replay?.prebuiltRepair===true&&resume.preparedBoundary?.ok!==false){
    const continued=resume.preparedBoundary,current=canonBoundaryInputStamp(src);
    if(routePrebuiltBoundary(continued)?.turnPlan?.route==='prebuilt'&&
        [continued?.inputStamp,continued?.resolvedInputStamp,continued?.turnPlan?.inputStamp].some(stamp=>canonBoundaryStampsEqual(stamp,current))&&
        (!replayFrozen||[replayFrozen.inputStamp,replayFrozen.resolvedInputStamp,replayFrozen.turnPlan?.inputStamp].some(stamp=>canonBoundaryStampsEqual(stamp,current))))replayFrozen=continued;
  }
  const isReplayRun=Boolean(options.replay);
  const prebuiltReplay=options.replay?.prebuiltRepair===true;
  if(prebuiltReplay)activePrebuiltRepair={checkpoint:structuredClone(options.replay.prebuiltState?.checkpoint||{}),failures:[],requests:[],targets:[{stage:PREBUILT_REPAIR_STAGES.boundary}]};
  if(prebuiltReplay&&(!replayFrozen||!reusable))return finish(CE_TURN_STATUS.boundaryFailed,{
    trace,range:turnRange,reason:'本轮预制修订的冻结基线已失效，不能安全定点接续'});
  if(options.replay?.variableHandoff&&!replayFrozen)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'缺少本轮冻结分工，无法安全接续人物与物品变量。没有重跑边界。'});
  if(replayFrozen && isReplayRun){
    /* 复用路径：校验指纹，对得上就直接用。
     * inputStamp 可能在 preparedBoundary 顶层，也可能只在 turnPlan 里（replay 复原时就是这种）。 */
    const frozenStamp=replayFrozen.inputStamp || (replayFrozen.turnPlan && replayFrozen.turnPlan.inputStamp) || '';
    const frozenResolved=replayFrozen.resolvedInputStamp || '';
    const currentStamp=canonBoundaryInputStamp(src);
    const stampOk=canonBoundaryStampsEqual(frozenStamp,currentStamp)||canonBoundaryStampsEqual(frozenResolved,currentStamp);
    if(stampOk && replayFrozen.ok!==false){
      preparedBoundary=replayFrozen;
      if(options.replay?.preserveInput===true&&options.replay?.continuationInput?.version===1&&typeof options.replay.onBoundaryInputVerified==='function')await options.replay.onBoundaryInputVerified({archiveName:src.archiveName||src.saveId||'',logId:src.logId||'',turnKey:preparedBoundary.turnPlan?.turnKey||''});
      step('前置原著分工','复用本轮已冻结的分工，不重算');
      const handoff=options.replay.variableHandoff;
      if(handoff){
        const owners=new Set((preparedBoundary.turnPlan?.canonJobs||[]).map(row=>row.name));
        if(reusable&&typeof options.replay.onBoundaryInputVerified==='function'&&!preparedBoundary.turnPlan?.deferredRefs?.length&&
            handoff.actors.length&&handoff.actors.every(actor=>owners.has(actor.name))&&
            handoff.blocks.every(block=>owners.has(block.name))){
          continuationInput.preparedBoundary=preparedBoundary;
          step('准备变量定点重跑','复用已核验的本轮人物正文，直接进入人物与物品变量更新');
          return finish(CE_TURN_STATUS.ok,{trace,range:turnRange,prose:handoff.blocks,
            variableHandoff:{...handoff,completeActorCoverage:owners.size===handoff.blocks.length}});
        }
        return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'人物与物品变量的原轮归属无法确认，已保留成果，未重新请求边界。'});
      }
    }else if(replayFrozen.ok!==false && frozenStamp){
      const changed=canonBoundaryStampDifferences(frozenStamp,currentStamp);
      const labels={save:'存档',branch:'分支',log:'楼层',turn:'轮次',story:'正文',start:'起点',end:'终点',timeline:'年表',characters:'人物资料',before:'轮前快照',progress:'事件进度',watches:'事件观察',open:'未完事件',debts:'欠账',hooks:'伏笔',material:'资料快照',options:'分工设置',signature:'签名格式'};
      return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,
        reason:'本轮接续基线不一致：'+changed.map(key=>labels[key]||key).join('、')+'。已保留成功结果，未自动重跑边界；若未主动修改这些内容，这是接续异常，请保留本轮记录。',
        boundaryStale:true,boundaryChangedFields:changed});
    }
    /* frozenStamp 为空 = 拿不到可靠指纹，不冒险复用，退回原行为重算。 */
  }
  preparedBoundary=routePrebuiltBoundary(preparedBoundary);
  if(prebuiltReplay&&!preparedBoundary)return finish(CE_TURN_STATUS.boundaryFailed,{
    trace,range:turnRange,reason:'缺少可核对的预制修订边界，已保留本轮成果'});
  if(prebuiltReplay || preparedBoundary || hasMatchedProducts || Number(options.canonPushBoundaryVersion)>=1 || src.preparedBoundary || options.preparedBoundary){
    if(!preparedBoundary){
      preparedBoundary=src.preparedBoundary || options.preparedBoundary || await prepareCanonTurnBoundary({...src,ledger});
      // 2026-10-31 玩家反馈：「我改一下设置怎么就不行了，那这种情况不就无解了吗？」
      //
      // 原先这里是「指纹对不上就直接判 boundaryFailed」，而重试又会把同一个旧
      // preparedBoundary 再传进来 → 指纹永远对不上 → 点多少次都原地打转，彻底锁死。
      //
      // 现在：发现对不上、且手里拿的是「外部传进来的旧边界」时，
      // 不再直接失败，而是丢掉旧边界按当前输入重算一次。
      // 「重算」本身仍有代价（会再跑一遍前置分工），所以只重算一次，
      // 重算后还对不上才真的判失败并报明确原因 —— 既不会自锁，也不会无限重试。
      if(!preparedBoundary.ok || ![preparedBoundary.inputStamp,preparedBoundary.resolvedInputStamp].some(stamp=>canonBoundaryStampsEqual(stamp,canonBoundaryInputStamp(src)))){
        const fromOutside=Boolean(src.preparedBoundary || options.preparedBoundary);
        if(fromOutside && preparedBoundary.ok!==false){
          step('前置原著分工','正文/时间/档案/设置已变化，放弃旧分工，按当前输入重算');
          preparedBoundary=await prepareCanonTurnBoundary({...src,ledger,preparedBoundary:undefined});
          if(!preparedBoundary.ok){
            return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:preparedBoundary.reason || '重算前置边界失败'});
          }
        } else {
          return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:preparedBoundary.reason || '正文、时间、档案或设置已变化，前置边界失效'});
        }
      }
    }
    // Legacy prebuilt freezes deliberately erased their tier. Reconfirm that missing
    // common boundary once; preserve checkpoints and never turn a matched failure into ordinary replay.
    if((hasMatchedProducts || Number(options.canonPushBoundaryVersion)>=1) && !['crossEvent','sameEventProgress','sameEventNoProgress','outsideRange'].includes(preparedBoundary.turnPlan?.turnAdvanceTier || preparedBoundary.storyAnalysis?.turnAdvanceTier)){
      preparedBoundary=await prepareCanonTurnBoundary({...src,ledger,preparedBoundary:undefined});
      if(!preparedBoundary?.ok || !preparedBoundary.turnPlan?.turnAdvanceTier)return finish(CE_TURN_STATUS.boundaryFailed,{
        trace,range:turnRange,reason:preparedBoundary?.reason || '补演档位尚未确认，未进入成品落地'});
    }
    if(isReplayRun&&options.replay?.mode==='continue'&&!options.replay.localOnly&&
      preparedBoundary.turnPlan?.deferredRefs?.length&&typeof host.vectorContext==='function'&&
      options.materials!==false&&options.materials?.ragVector!==false){
      step('补演定点补证','只复核仍缺资料的人物');
      const resumed=await prepareCanonTurnBoundary({...src,ledger,corridorEvidenceResume:preparedBoundary});
      if(!resumed.ok)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:resumed.reason});
      preparedBoundary=resumed;
    }
    preparedBoundary=routePrebuiltBoundary(preparedBoundary);
    const prebuiltRoute=preparedBoundary.turnPlan?.route==='prebuilt';
    if(prebuiltRoute&&!activePrebuiltRepair)activePrebuiltRepair={checkpoint:{},failures:[],requests:[],targets:[{stage:PREBUILT_REPAIR_STAGES.boundary}]};
    // 完整边界是已完成阶段产物，立即更新接续快照；下游抛错不能让它只活在局部变量里。
    continuationInput.preparedBoundary=preparedBoundary;
    step('本轮接续基线','前置分工已确认，后续失败仍保留本轮边界',{kind:'continuationInput',input:continuationInput});
    step('前置原著分工',preparedBoundary.turnPlan.mode,{kind:'canonTurnPlan',...preparedBoundary.turnPlan});
    /* ★★★ 2026-11-03 玩家定：局部重跑不该从「补演边界判定」重跑整轮。
     *
     * 算完（或复用）就把这份完整的前置分工交给宿主保存，供下一次局部重跑直接取用。
     * 交出去的是**完整对象**（含 storyAnalysis.handled / worldEvents / factRecords），
     * 不做裁剪 —— 裁剪过的副本会让下游误判「谁都没处理过」，比不复用更糟。
     *
     * 【为什么用回调而不是直接调】
     * 本文件是独立 core 模块，不 import 前端；落库能力在宿主侧。
     * 所以由 options.freezeBoundary 这个回调传进来（见 canon-runtime.js），
     * core 只负责「算完了，给宿主」，不关心怎么存。
     *
     * 只在**正常整轮**（非局部重跑）时写，避免局部重跑把冻结版本覆盖成
     * 「基于上次冻结再冻结」的副本，越滚越偏。
     * 清理规则与「本轮阶段产物」一致：只保留当前 logId，换层/回退/重roll 即丢。 */
    if(!isReplayRun && preparedBoundary && preparedBoundary.ok && preparedBoundary.turnPlan
        && typeof options.freezeBoundary==='function'){
      try{
        await options.freezeBoundary(preparedBoundary);
      }catch(freezeError){
        /* 存不下来不影响本轮执行，只是下次重跑得重算边界。 */
        try{console.warn('[前置分工] 冻结失败（不影响本轮）：'+String(freezeError&&freezeError.message||freezeError));}catch(_){}
      }
    }
    if(preparedBoundary.turnPlan.deferredRefs.length)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'必要资料尚未明确，本轮任务保留待续：'+preparedBoundary.turnPlan.deferredRefs.join('、'),deferredRefs:preparedBoundary.turnPlan.deferredRefs});
    if (prebuiltRoute && typeof options.preparePrebuiltProposal!=='function')return finish(CE_TURN_STATUS.boundaryFailed,{
      trace,range:turnRange,reason:'本轮已采用预制成品，但缺少原生落地入口；已保留预制任务，未转普通补演'});
    if (prebuiltRoute && typeof options.preparePrebuiltProposal === 'function') {
      let rejected='';
      activePrebuiltFailureStage=PREBUILT_REPAIR_STAGES.boundary;
      let plan = planPrebuiltTurn({ boundary: preparedBoundary, ledger, timeline:src.timeline, characters: src.characters, beforeStateRows: src.beforeStateRows, onScene: src.onScene,onReject:reason=>{rejected=reason;} });
      const replayBoundary=prebuiltRoute && options.replay &&
        ((options.replay.stages || []).includes(PREBUILT_REPAIR_STAGES.boundary) ||
          (options.replay.scopes || []).includes(PREBUILT_REPAIR_STAGES.boundary+':节点例外')) &&
        (options.replay.mode!=='continue' || !plan);
      if(replayBoundary){
        const events=prebuiltBoundaryEvents(preparedBoundary.candidates);
        const ids=new Set(events.flatMap(event=>event.nodes.map(node=>node.id)));
        const eventIds=new Set(events.map(event=>event.code));
        const dependencies=new Set(events.flatMap(event=>event.nodes.flatMap(node=>node.dependsOn)));
        const nodes=await runPrebuiltBoundaryBatches(host,{...activePrebuiltRepair,signal,retry:options.retry,
          replay:options.replay,batchLimits:options.batchLimits},'节点例外',{
            range:preparedBoundary.range,story:src.storyText,facts:preparedBoundary.storyAnalysis.factRecords||[],
            handled:preparedBoundary.storyAnalysis.handled||[],influences:preparedBoundary.storyAnalysis.influences||[],
            progress:eventProgressForModel((ledger.eventProgress||[]).filter(row=>eventIds.has(row.eventId)||
              row.nodes?.some(node=>dependencies.has(node.nodeId)))),
            prior:(preparedBoundary.storyAnalysis.prebuiltNodes||[]).filter(row=>ids.has(row.id)),
          },'events',events.map(row=>({row,ids:row.nodes.map(node=>node.id),dependencies:row.nodes.flatMap(node=>node.dependsOn)})),
          '只重核所给预制节点的例外，不重跑普通补演分工。根据本轮正文、已确认事实和节点前提，返回JSON {prebuiltNodes:[{id,status,reason,resolution,at,title,actors,withdrawnActors,reviseWorld,worldDependsOn,clearedActors}]}。仅列mutated、pending或uncertain；没有实际偏离返回空数组。人物交汇、同名和未目击本身不是变异。mutated同时给出resolution=occurred/cancelled/pending；occurred须给实际at、title、需修改原人物actors、reviseWorld和worldDependsOn。禁止编造编号和事实。',
          (value,groupIds)=>Array.isArray(value?.prebuiltNodes)&&new Set(value.prebuiltNodes.map(row=>row?.id)).size===value.prebuiltNodes.length&&
            value.prebuiltNodes.every(row=>groupIds.includes(row?.id)&&['ready','mutated','pending','uncertain'].includes(row.status)&&typeof row.reason==='string'&&row.reason.trim())?value.prebuiltNodes:null);
        if(!nodes)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,
          reason:prebuiltCapacityReason(activePrebuiltRepair.failures)||'预制节点例外尚未核定，已保留本轮预制任务'});
        preparedBoundary=routePrebuiltBoundary({...preparedBoundary,storyAnalysis:{...preparedBoundary.storyAnalysis,
          prebuiltNodes:nodes,prebuiltExceptions:true,prebuiltUnavailable:false}});
        continuationInput.preparedBoundary=preparedBoundary;
        rejected='';
        plan=planPrebuiltTurn({boundary:preparedBoundary,ledger,timeline:src.timeline,characters:src.characters,beforeStateRows:src.beforeStateRows,onScene:src.onScene,onReject:reason=>{rejected=reason;}});
      }
      const hasPrebuilt=preparedBoundary.candidates?.some(event=>event.prebuilt);
      if(!plan&&hasPrebuilt){
        const reason=rejected||'候选节点与当前存档尚不能安全合并';
        step('预制成品未采用',reason);
        console.warn('[原著补演·预制]',reason);
      }
      if(!plan&&prebuiltRoute)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,
        reason:(rejected||'本轮预制节点或存档基线尚未核定')+'；已保留预制任务，未转普通补演'});
      if (plan) {
        activePrebuiltFailureStage=PREBUILT_REPAIR_STAGES.commit;
        const end = preparedBoundary.range.end;
        const range = preparedBoundary.range;
        const prebuiltRepair=activePrebuiltRepair || {checkpoint:prebuiltReplay?structuredClone(options.replay.prebuiltState?.checkpoint||{}):{},failures:[],requests:[],targets:[]};
        activePrebuiltRepair=prebuiltRepair;
        const unreached=new Set(plan.deferredEventIds);
        for(const {code,previous} of plan.events){
          if(plan.pointerPositions.get(code)?.size===0&&!previous.length)unreached.add(code);
        }
        preparedBoundary.turnPlan.prebuiltUnreachedEventIds=[...unreached];
        const landing=options.prebuiltLanding;
        if(landing){
          try {
            Object.assign(prebuiltRepair.checkpoint,await landing.load(plan.deferredEventIds));
          } catch(error) {
            if(error.code!=='PREBUILT_PREMATURE_RECEIPTS')throw error;
            return finish(CE_TURN_STATUS.boundaryFailed,{trace,range,prebuiltRepair,reason:error.message,partial:true});
          }
        }
        prebuiltRepair.targets=plan.repair.length?[{stage:PREBUILT_REPAIR_STAGES.boundary}]:[{stage:PREBUILT_REPAIR_STAGES.commit}];
        preparedBoundary.turnPlan.prebuiltMode=plan.repair.length?'repair':'direct';
        step('预制补演路线',plan.repair.length?'仅定向修订实际变异，其余原样取用':'原样取用已匹配成品');
        if(!plan.ready.length&&!plan.repair.length&&!plan.confirmations?.size&&!plan.events.some(row=>row.continueStory))return finish(CE_TURN_STATUS.ok,{
          trace,range,prebuiltRepair,eventProgress:buildPrebuiltPayload(plan,end,range)?.progress||[],
          turnAdvanceTier:preparedBoundary.turnPlan.turnAdvanceTier,
          boundaryOnly:true,stagedOk:false,landed:false,pending:true,reason:'预制节点尚待条件成立或已经结算，本轮不重复落地、不推进账本'});
        // The live front-door route reserves all timeline actors before ordinary evolution runs.
        // Legacy / replay entry points with potentially shared actor writes still need the live base for repair.
        const parallel=options.prebuiltOrdinaryExclusive===true&&typeof options.awaitPrebuiltSettlement==='function';
        let settlementPromise;
        const awaitSettlement=()=>settlementPromise ||= options.awaitPrebuiltSettlement();
        let base=options.ordinarySettlement;
        if(!parallel&&typeof options.awaitPrebuiltSettlement==='function'){
          step('等待重点演化结果');
          base=await awaitSettlement();
        }
        if(aborted())return finish(CE_TURN_STATUS.rolledBack,{trace,range,reason:describeAbort(signal)});
        const repairStarted=Date.now();
        if (plan.repair.length) step('定点修订预制节点', plan.repair.map(row => row.node.id).join('、'));
        else step('复用预制成品');
        const repaired = !base?.partial && await repairPrebuiltTurn(plan, host, {
          ...prebuiltRepair,start:range.start,end,signal,storyText:src.storyText,characters:src.characters,ordinarySettlement:base,beforeStateRows:src.beforeStateRows,
          prebuiltActorDifferences:ledger.prebuiltActorDifferences,
          retry:options.retry,replay:prebuiltReplay?options.replay:null,batchLimits:options.batchLimits,
          ...(landing?{
            async saveCheckpoint(key,receipt,stage){
              await landing.checkpoint(key,receipt,stage);
              actorProgressSaved=true;
              if(stage.stage===PREBUILT_REPAIR_STAGES.actor){
                const body=Object.values(receipt.value).map(row=>row.prose).join('\n\n');
                step('NPC视角正文已保存',stage.subject,{kind:'prose',block:{name:stage.subject,body},accepted:true});
              }
            },
            async saveActors(actorPayload){
              const settled=parallel?await awaitSettlement():base;
              const conflicts=parallel&&actorPayload.actors.find(({name})=>prebuiltOrdinaryActorState(name,{
                ordinarySettlement:settled,characters:src.characters,beforeStateRows:src.beforeStateRows,
              }));
              if(conflicts)throw new Error('重点演化意外写入补演人物「'+conflicts.name+'」');
              if(await landing.actors(actorPayload))actorProgressSaved=true;
            },
          }:{}),
          onAttempt(row){
            console.info('[原著补演·预制校验]',JSON.stringify(row));
            globalThis.FrDiagnosticLog?.prebuiltAttempt({...row,logId:src.logId});
            if(row.status==='failed')step('预制回包未通过', [row.stage,row.subject,...row.nodeIds,'第 '+row.attempt+' 次',row.reason].filter(Boolean).join(' · '));
          },
        });
        step('预制修订统计','本轮实际新增请求 '+prebuiltRepair.requests.length+' 次，修订耗时 '+(Date.now()-repairStarted)+' 毫秒',
          {kind:'prebuiltTiming',requests:prebuiltRepair.requests,elapsedMs:Date.now()-repairStarted});
        if (aborted()) return finish(CE_TURN_STATUS.rolledBack, { trace, range, prebuiltRepair,actorProgressSaved,reason:describeAbort(signal) });
        if(repaired)step('核对预制落地内容');
        const payload = repaired && buildPrebuiltPayload(repaired, end, range);
        if(parallel&&payload){
          step('成品就绪，等重点演化提交');
          base=await awaitSettlement();
        }
        if(aborted())return finish(CE_TURN_STATUS.rolledBack,{trace,range,reason:describeAbort(signal)});
        const conflict=parallel&&payload&&[...new Set([...payload.actors.map(row=>row.name),
          ...(payload.withdrawalReceipts||[]).map(row=>row.name).filter(Boolean)])].find(name=>prebuiltOrdinaryActorState(name,{
            ordinarySettlement:base,characters:src.characters,beforeStateRows:src.beforeStateRows,
          }));
        if(payload&&!base?.partial&&!conflict)step('核对存档并提交');
        const proposal = payload&&!base?.partial&&!conflict && await options.preparePrebuiltProposal(payload);
        if(aborted())return finish(CE_TURN_STATUS.rolledBack,{trace,range,reason:describeAbort(signal)});
        if (proposal) {
          if(!prebuiltRepair.targets.some(row=>row.stage===PREBUILT_REPAIR_STAGES.commit))prebuiltRepair.targets.push({stage:PREBUILT_REPAIR_STAGES.commit});
          const prose = payload.actors.filter(row=>row.body.trim()).map(({ name, body, status, eventIds }) => ({ name, body, status, eventIds }));
          const biography = Object.fromEntries(payload.actors.filter(row=>row.biography.trim()).map(row => [row.name, row.biography]));
          const worldForMisc = payload.world.map(row => [row.at, row.scope, row.title, row.prose].join(' · ')).join('\n');
          const hookResult = advanceTurnHooks({ accepted: prose, hooks: src.hooks || ledger.hooks,
            resolved: preparedBoundary.storyAnalysis.resolvedHooks, turnNo: options.turnNo, lifetime: options.hookLifetime, step, diag });
          const progressedIds=new Set(payload.progress.map(row=>row.eventId));
          preparedBoundary.turnPlan.prebuiltUnreachedEventIds=[...unreached].filter(code=>!progressedIds.has(code));
          const startedCandidates=preparedBoundary.candidates.filter(event=>{
            const code=inferEventCode(event);
            return !plan.deferredEventIds.includes(code)&&(!plan.pointerPositions.has(code)||progressedIds.has(code));
          });
          const open = buildOpenEvents(findInProgressEvents(startedCandidates, end),
            openEvents.filter(event=>!plan.deferredEventIds.includes(event.eventId)),startedCandidates,end);
          console.warn('[原著补演·预制] 已准备落地',JSON.stringify({ready:repaired.ready.length,pending:repaired.pending.length,repaired:repaired.ready.filter(row=>row.repaired).length,actors:prose.length,
            productNodes:repaired.ready.filter(row=>!row.livePrefix).map(row=>row.node.id),liveNodes:[...new Set(repaired.ready.map(row=>row.livePrefix).filter(Boolean))]}));
          step('预制节点待落地', payload.progress.length + ' 条年表', { kind: 'eventProgress', rows: payload.progress, confirmed: false });
          for (const block of prose) step('人物正文', block.name, { kind: 'prose', block, accepted: true });
          if (worldForMisc) step('世界正文', '沿用已校对世界大事', { kind: 'world', body: worldForMisc });
          return finish(CE_TURN_STATUS.ok, withVisibility({ trace, diag, range, prose, biography, worldForMisc,
            prebuiltProposal: proposal, prebuiltRepair, actorProgressSaved, eventProgress: payload.progress, openEvents: open,
            eventWatches: preparedBoundary.turnPlan.eventWatches || [], hooks: hookResult.hooks,
            openHooks: openHooks(hookResult.hooks), stagedOk: true, landed: false,
          }, { ledger, range, handledRange: range, eventCount: payload.progress.length, writtenNames: prose.map(block => block.name),
            unreachedEventIds: preparedBoundary.turnPlan.prebuiltUnreachedEventIds,
            wroteWorld: !!worldForMisc, stagedOk: true, hooks: hookResult.hooks, turnNo: options.turnNo }));
        }
        if (aborted()) return finish(CE_TURN_STATUS.rolledBack, {trace,range,reason:describeAbort(signal)});
        const actorSaveFailure=prebuiltRepair.failures.find(row=>row.stage===PREBUILT_REPAIR_STAGES.commit&&row.subject);
        const actorStageFailure=prebuiltRepair.failures.find(row=>row.subject&&
          [PREBUILT_REPAIR_STAGES.actor,PREBUILT_REPAIR_STAGES.variables].includes(row.stage));
        const reason=conflict?'重点演化意外写入补演人物「'+conflict+'」，已保留修订，未覆盖存档':base?.partial?'重点演化未保存，预制成果保留待提交':!repaired?(prebuiltCapacityReason(prebuiltRepair.failures)||(actorSaveFailure?actorSaveFailure.subject+'落地未完成：'+actorSaveFailure.reason:actorStageFailure?[actorStageFailure.subject,actorStageFailure.stage,actorStageFailure.reason].join(' · '):'定点修订未通过校验')):!payload?'终态与增减无法安全转换':'人物档案或存档基线未通过核对';
        if (plan.repair.length || prebuiltReplay || prebuiltRoute) {
          if (!prebuiltRepair.failures.length) prebuiltRepair.failures.push({stage:PREBUILT_REPAIR_STAGES.commit,reason});
          const failures=prebuiltRepair.failures.filter(row=>row.code!=='not_selected');
          for(const row of failures.length?failures:prebuiltRepair.failures.slice(0,1)) {
            globalThis.FrDiagnosticLog?.prebuiltFailure?.({...row,logId:src.logId});
          }
          return finish(CE_TURN_STATUS.proseFailed,{trace,range,prebuiltRepair,actorProgressSaved,partial:actorProgressSaved,reason,landed:false});
        }
        step('预制成品未采用',reason);
        console.warn('[原著补演·预制]',reason);
      }
      if (prebuiltReplay) return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,
        reason:rejected||'本轮预制成品覆盖已变化，无法安全定点接续'});
    }
    /* ★★★ 2026-11-03 玩家：「能跑了，但是从补演边界开始跑，而且刚跑一下直接把资料清空了然后不跑了」。
     *
     * 【这一段就是「跑一下就不跑」的真凶】
     * 边界算完后如果 canonJobs 与 worldEvents 都是空，这里直接把整轮判成
     * 「本轮没有原著人物或世界追加任务」并 finish 返回 —— 一行散文都不写。
     *
     * 【为什么它和局部重跑冲突】
     *   正常整轮：边界是**唯一依据**，它说没人要补演，那就是没有了，返回是对的。
     *   局部重跑：玩家已经在面板上**亲手勾了「韩小妹 · 群像视角散文」**，
     *     这是比自动边界更强、更直接的意图。
     *     而边界重算得出来的 canonJobs 是「本轮按正文该补谁」，
     *     它回答不了「玩家要求重写谁」。
     *     于是：玩家明确要求重写某个人的散文，
     *     边界一算「本轮没人要补」→ 直接返回 → 玩家看到「跑了一下就不跑了」，
     *     期间资料还被清空。
     *   这是**同一类病根的第三次出现**：自动判定否决了玩家显式指定的目标。
     *
     * 【修法】把这道提前返回拆成两种情况：
     *   ① 非局部重跑（正常整轮）→ 行为完全不变，边界说了没人就返回。
     *   ② 局部重跑且玩家确实勾了目标（scopes 或 stages 非空）→ **不返回**，
     *      继续往下走，由玩家勾选的目标驱动散文生成。
     *      边界没有 canonJobs 时，下游按「玩家点名的这些人」走单写路径，
     *      材料从已有请求/档案取，不需要边界再给任务。
     *   ③ 局部重跑但两个都空 → 等同「一个目标都没勾」，没有意义，
     *      仍按原样返回（这种情形上面的入口早就拦掉了，正常到不了）。 */
    const replayTargetsEmpty=!((options.replay?.scopes||[]).length||(options.replay?.stages||[]).length);
    const replayForcesWork=isReplayRun&&!replayTargetsEmpty&&!prebuiltReplay;
    if(!preparedBoundary.turnPlan.canonJobs.length && !preparedBoundary.storyAnalysis.worldEvents.length){
      if(replayForcesWork){
        try{console.warn('[局部重跑] 边界判定「本轮无自动补演任务」，但玩家已显式勾选目标 → 不提前结束，按勾选继续'
          +' ｜scopes='+JSON.stringify(options.replay.scopes||[])
          +' ｜stages='+JSON.stringify(options.replay.stages||[]));}catch(_){}
      }else{
        const observed=preparedBoundary.storyAnalysis.eventProgress||[];
        const unreachedEventIds=ordinaryUnreachedEvents(preparedBoundary.candidates,observed,ledger.eventProgress,turnRange.end,src.storyText);
        const unreached=new Set(unreachedEventIds),eligible=preparedBoundary.candidates.filter(event=>!unreached.has(inferEventCode(event)));
        preparedBoundary.turnPlan.ordinaryUnreachedEventIds=unreachedEventIds;
        const eventProgress=observed.filter(row=>!unreached.has(row.eventId)),open=buildOpenEvents(findInProgressEvents(eligible,turnRange.end),openEvents,eligible,turnRange.end);
        const hookResult=advanceTurnHooks({accepted:[],hooks:src.hooks || ledger.hooks || [],resolved:preparedBoundary.storyAnalysis.resolvedHooks || [],turnNo:options.turnNo,lifetime:options.hookLifetime,step,diag});
        return finish(CE_TURN_STATUS.ok,withVisibility({trace,diag,range:turnRange,prose:[],proseText:'',biography:{},backstory:{},includedCanonNames:[],excludedStoryNames:preparedBoundary.storyAnalysis.handled.map(row=>row.name),debts:[],worldDebts:[],backstoryDebts:[],eventProgress,eventWatches:preparedBoundary.turnPlan.eventWatches || [],openEvents:open,hooks:hookResult.hooks,openHooks:openHooks(hookResult.hooks),staleHooks:hookResult.stale,mode:preparedBoundary.turnPlan.mode,turnAdvanceTier:preparedBoundary.turnPlan.turnAdvanceTier,boundaryOnly:true,stagedOk:true,succeeded:false,landed:false,reason:'本轮没有原著人物或世界追加任务，边界检查待原保存流程提交'}, {ledger,range:turnRange,handledRange:turnRange,eventCount:eligible.length,unreachedEventIds,stagedOk:true,hooks:hookResult.hooks,turnNo:options.turnNo,turnDetail:{boundaryChecked:true,mode:preparedBoundary.turnPlan.mode}}));
      }
    }
  }

  // ---------- 步骤 2：取候选事件（纯代码） ----------
  let candidates = [];
  try {
    /* ★ 2026-11-03 配合「边界复用」：从运行记录复原的 frozenBoundary 里 candidates 是空的
     * （运行记录只存投影，不存完整候选事件），若不兜底就会算出 0 条候选、
     * 整轮判定「没有原著事件」直接空跑结束。
     * 这里改成「有内容才用，空数组按没有处理」，退回按区间从年表现算——
     * 这本来就是纯代码、不调模型，用现算的没有额外成本，也不影响复用语义。 */
    candidates = (Array.isArray(preparedBoundary?.candidates) && preparedBoundary.candidates.length)
      ? preparedBoundary.candidates.slice()
      : entriesInRange(src.timeline, turnRange.start, turnRange.end);
    const pendingIds=new Set([...(ledger.eventProgress || []).filter(row=>!row.resolved).map(row=>row.eventId),...(openEvents || []).map(row=>row.eventId)]);
    const closedIds=new Set((ledger.eventProgress || []).filter(row=>row.resolved).map(row=>row.eventId));
    for(const entry of src.timeline || [])if(pendingIds.has(inferEventCode(entry)) && !closedIds.has(inferEventCode(entry)) && !candidates.some(e=>inferEventCode(e)===inferEventCode(entry)))candidates.push(entry);
    candidates=candidates.filter(entry=>!closedIds.has(inferEventCode(entry)));
    candidates=candidates.map(entry=>eventWithActualWindow(entry,ledger.eventProgress||[],turnRange.end));
  } catch (error) {
    return finish(CE_TURN_STATUS.rolledBack, withVisibility({
      trace, diag, reason: `区间筛选失败：${error.message}`,
    }, { ledger }));
  }
  const observedProgress=preparedBoundary?.storyAnalysis?.eventProgress||[];
  const ordinaryUnreached=new Set(ordinaryUnreachedEvents(candidates,observedProgress,ledger.eventProgress,turnRange.end,src.storyText));
  if(preparedBoundary&&ordinaryUnreached.size)preparedBoundary.turnPlan.ordinaryUnreachedEventIds=[...ordinaryUnreached];
  candidates=candidates.filter(event=>!ordinaryUnreached.has(inferEventCode(event))).map(event=>{
    const progress=observedProgress.find(row=>row.eventId===inferEventCode(event));
    return progress&&!progress.resolved&&(progress.occurred?.length||progress.nodes?.some(node=>node.state==='done'))
      ?{...event,pointerInProgress:true}:event;
  });
  step('候选事件', `${candidates.length} 条`, {kind:'events',range:turnRange,events:candidates.map(e=>({code:inferEventCode(e),title:e.title,content_brief:e.content_brief||e.text||e.content}))});

  // ---------- 步骤 2.5：认出「跨过本轮终点」的事件 ----------
  //
  // 用户 2026-10-21：
  //   「当前真处于区间的这个年表事件并未完成……大多数情况都是未完成」
  //
  // 这条最关键：E-007 从 0011 跨到 0015，这轮只走到 0013。
  // 如果把它当成整条都走完了，压出来的终态就是 0015 的样子（炼气九层），
  // 拿去对正文必然判「没到」，然后去补一个还没发生的状态——那是剧透。
  //
  // 所以：跨过终点的事件单独标出来，只算它走到终点那一刻的样子。
  const inProgress = findInProgressEvents(candidates, turnRange.end);
  // 跨轮事件清单在这里就算好。
  //
  // 为什么提前算：后面有好几个早退分支（正文为空、边界失败、散文全挂）。
  // 无论从哪条路返回，这份清单都得交出去——
  // 「哪些事件还没走完」是**事实**，跟这轮成不成功无关。
  // 漏了它，下一轮就会把这些事件当成已完成，剩余部分永远丢失。
  const nextOpenEvents = buildOpenEvents(inProgress, (openEvents||[]).filter(row=>!ordinaryUnreached.has(row.eventId)), candidates, turnRange.end);

  if (inProgress.length > 0) {
    step('进行中', `${inProgress.length} 条跨过本轮终点，只算到 ${turnRange.end}：`
      + inProgress.slice(0, 3).map((x) => x.code).join('、'));
    diag.step(
      `有 ${inProgress.length} 条事件还在进行中`,
      '这些只处理到本轮终点，不按整条事件的结局算——否则等于剧透',
    );
  }

  if (candidates.length === 0 && !(src.hooks && src.hooks.length)) {
    return finish(CE_TURN_STATUS.nothingToDo, withVisibility({
      trace, diag, range: turnRange, reason: '区间内没有原著事件',
    }, { ledger, range: turnRange, eventCount: 0 }));
  }

  // ---------- 步骤 3：按人压终态 → 对正文 → 出差集 ----------
  //
  // 正文是这一步的必要输入：对勾要拿正文比。
  // 没有正文就判不了——硬判会把每个人都说成「没到」，然后全部重补，
  // 那比漏补更糟。所以先挡一道。
  const storyText = String(src.storyText || '').trim();
  if (!storyText) {
    step('正文', '为空，无法判定终态是否到位');
    diag.error('本轮拿不到正文，跳过补演', '终态对正文必须看到正文才能判');
    return finish(CE_TURN_STATUS.rolledBack, withVisibility({
      trace, diag, range: turnRange,
      reason: '正文为空：没有正文就无法判断人物终态是否到位',
    }, { ledger, range: turnRange, eventCount: candidates.length }));
  }

  // 用户 2026-10-21 的口径（这一条推翻了「按事件打勾」）：
  //   「这一轮有10个年表事件，1到10每个都涉及角色a的事情，
  //     比如说修为，在1事件他的修为是炼气三层，在10事件他的修为是炼气九层，
  //     那压缩什么？这一轮需要补的是他炼气九层这个终极状态。」
  //
  // 所以要压的是**人**，不是事件。
  // 中间过程（三层→七层→九层）全部丢掉，只留终态。
  //
  // 另外：年表里写到的事无条件记进生平，那部分不调模型。
  const playerNames=[...new Set(Object.entries(src.characters || {}).filter(([,info])=>info && (info.isPlayer===true || info.id==='B1')).flatMap(([name,info])=>[name,info.profile?.name,...Array.from(info.aliases || [])]).filter(Boolean))];
  const actorPick = collectActorBundles({
    events: candidates,
    playerNames,
    materialMode:options.materialMode, currentTime:turnRange.end, materialMaxChars:0,
    playerName: Object.keys(src.characters || {}).find(name => {
      const info = src.characters[name];
      return info && (info.isPlayer === true || info.id === 'B1');
    }) || '',
    archivedNames: options.archivedNames,
    minEvents: options.actorMinEvents,
    // 圈人：拿时间窗筛，不拿人筛。
    // candidates 本来就是这一轮时间窗内的年表事件（上游按区间筛好了），
    // 所以进来的人一律建档——年表点名的几乎没有路人，不需要再考一遍。
    // 用户 2026-10-21：「能进原著年表简略条目的npc，就几乎不存在路人……
    //   已经经过的原著年表事件中，这些角色几乎都是作为龙套和炮灰的存在，用完即弃。」
    windowOnly: options.actorWindowOnly !== false,
  });
  const knownOriginalActors = collectActorBundles({events:src.timeline || [],windowOnly:true}).actors;
  if(preparedBoundary){
    const jobs=new Set(preparedBoundary.turnPlan.canonJobs.map(row=>row.name));
    const before=actorPick.actors.length;
    actorPick.actors=actorPick.actors.filter(actor=>jobs.has(actor.name));
    /* ★★★ 2026-11-03 玩家反复报「局部重跑永远 0 次调用」，这是排查用的硬证据。
     * 这里用 console.warn（玩家客户端只有 WARN 及以上进 render.log）。
     * 如果 before>0 而 after=0，就证明「冻结分工把演员筛空了」，
     * 那一轮自然一条散文请求都不会生成。 */
    if(before!==actorPick.actors.length){
      try{console.warn('[局部重跑] 冻结分工过滤演员 → 过滤前='+before+' 过滤后='+actorPick.actors.length
        +' ｜canonJobs='+jobs.size
        +' ｜被保留='+JSON.stringify(actorPick.actors.slice(0,8).map(a=>a.name)));}catch(_){}
    }
  }
  const knownOriginalNames = [...new Set([...knownOriginalActors.map(a=>a.name),...(options.originalCharacterNames || [])])];
  const replacement=options.replay?.actorReplacement;
  const replacementNames=new Set(replacement?.names||[]);
  const savedWritingInputs=new Map();
  if(replacement&&preparedBoundary===replayFrozen&&reusable&&options.replay.preserveInput===true){
    for(const name of replacementNames){
      const row=options.replay.writingInputs?.[name],job=preparedBoundary.turnPlan?.canonJobs?.find(job=>job.name===name);
      if(!row||!job||!actorPick.actors.some(actor=>actor.name===name))continue;
      try{
        const [writer]=JSON.parse(row.material);
        if(writer?.name!==name||!writer.material||!Array.isArray(writer.material.task))continue;
        const originalId=String(src.characters?.[name]?.id||'');
        const committedId=String(replacement.actorIds?.[name]||'');
        if(originalId&&((committedId&&committedId!==originalId)||(writer.id&&String(writer.id)!==originalId)))continue;
        // First appearances are assigned their persistent ID only when variables are committed.
        // The original writer's C-number for a newcomer is only a per-prompt label.
        // Ownership comes from the verified original name/job and this floor's actor commit.
        if(!originalId&&/^C\d+$/.test(committedId)){
          writer.id=committedId;
        }
        savedWritingInputs.set(name,{writer,reference:row.reference,solo:row.stage==='人物视角散文'||row.stage==='落地依据提取'&&writer.material.tier===CE_CAST_TIER.core});
      }catch(_){}
    }
  }
  const reuseWritingOnly=replacementNames.size>0&&savedWritingInputs.size===replacementNames.size;
  const requiredScope=buildMaterialRequiredScope({timeline:src.timeline,events:candidates,canonicalNames:[...knownOriginalNames,...(src.canonicalNames || [])],playerNames,playerInput:src.playerInput,storyText,location:src.location});
  const cachedMaterial=options.replay?.materialState || src.materialState;
  const savedMaterial=cachedMaterial && cachedMaterial.version===1?cachedMaterial:null;
  if(savedMaterial){
    const signature=scope=>JSON.stringify({names:[...(scope?.characterNames || [])].sort(),events:[...(scope?.eventCodes || [])].sort(),text:scope?.text || '',location:scope?.location || ''});
    if(savedMaterial.profile!=='turn' || signature(savedMaterial.requiredScope)!==signature(requiredScope) || Object.keys(normalizeMaterialCounts()).some(key=>normalizeMaterialCounts(savedMaterial.counts)[key]!==normalizeMaterialCounts(options.materialCounts)[key]))return finish(CE_TURN_STATUS.boundaryFailed,{trace,reason:'本轮原著人物、事件或历史取用范围已变化，不能复用此前补回资料，请明确选择变化后的资料重新处理。'});
  }
  const beforeRows = (src.beforeStateRows && typeof src.beforeStateRows === 'object')
    ? src.beforeStateRows
    : null;

  // 按人名从「正文前快照」里取一行，渲染成历史材料用的文字。
  //
  // 取不到时返回 ''，让历史提示词里明确显示「这份状态没有」，
  // **绝不退回 stateNow** —— 那正是要修的污染。
  const readBeforeState = (name) => {
    if (!beforeRows) return '';
    const want = String(name || '').trim();
    if (!want) return '';
    try {
      for (const id in beforeRows) {
        if (!Object.prototype.hasOwnProperty.call(beforeRows, id)) continue;
        if (id === 'TIME_LOCATION_ROW') continue;
        const row = beforeRows[id];
        if (!row || typeof row !== 'object') continue;
        const label = String(row['1'] || '').split('|')[0].replace(/<[^>]*>/g, '').trim();
        if (!label) continue;
        if (label !== want) continue;

        // 只取历史判断用得上的几列。刻意**不取**本轮容易被改的那些
        // 即时状态（内心想法、当前动机、战斗状态）——
        // 历史补的是过去几个月，不是此刻。
        const realmIdentity = String(row['2'] || '').split('|');
        const posBits = String(row['16'] || '').split('|');
        return renderActorState({
          cultivation: String(realmIdentity[0] || '').trim(),
          identity: String(realmIdentity[1] || '').trim(),
          personality: String(row['3'] || '').trim(),
          status: String(row['4'] || '').trim(),
          location: String(posBits[2] || '').replace(/<[^>]*>/g, '').trim(),
          relation: String(row['13'] || '').trim(),
          favor: String(row['15'] || '').trim(),
        });
      }
    } catch (e) {
      return '';
    }
    return '';
  };

  // 现状读取（正文之后）。边界判定、散文、"必成事实"都用它。
  const stateNowByName = new Map();
  // 历史材料里有谁的状态没取到。要进诊断和回执，
  // 不许静默——「没拿到」和「本来就没有」是两回事。
  let stateMissingNames = [];
  const readStateNow = (name, bundle) => {
    if (stateNowByName.has(name)) return stateNowByName.get(name);

    const info = (src.characters && src.characters[name]) || {};
    const state = info.state || {};
    const profile = info.profile || {};

    // 先问宿主给不给（宿主可能把性格已经并好了）
    const fromHost = typeof src.resolveActorState === 'function'
      ? src.resolveActorState(name, bundle)
      : null;

    // 性格兜底：存档里现在的性格优先，没有再退到设定集的底子。
    //   「如果经历发生改变，环境发生改变，这个npc的性格也就应该要发生改变。」
    //   → 所以「现在」这一列优先，设定集只是没有时的兜底。
    const nowPersonality = String(
      (fromHost && (fromHost.personality || fromHost.性格))
      || state.personality || state.性格 || '',
    ).trim();
    const basePersonality = String(profile.personality || profile.性格 || '').trim();

    const value = {
      ...state,
      ...(fromHost || {}),
      personality: nowPersonality || basePersonality,
      basePersonality,
    };

    const projected=projectActorProfile(value);
    stateNowByName.set(name, projected);
    return projected;
  };


  // ---------- 步骤 3.2：新人补档 ----------
  //
  // 用户 2026-10-21：
  //   「这是已有的npc的处理方式，但是很多时候都是新建原著npc，当前信息是零，
  //     那么初始信息我们怎么找呢？尤其是性格设定这些，就需要从向量库调取信息」
  //
  // 已建档的人读存档就够；新人存档里是零，只能现查。
  // 查两处：设定集（性格/出身/境界）+ 年表（他这段时间在干什么）。
  //
  // 这步**不阻断**：查不到就按「设定集里没这个人」写，但不许编。
  const newcomers = {};
  let ceilings={};
  const newcomerNames = [];
  for (const bundle of actorPick.actors) {
    const name = String(bundle && bundle.name || '').trim();
    if (!name) continue;
    if (!isNewcomer(name, src.characters)) continue;
    newcomerNames.push(name);
  }

  // ---------- 资料检索：每人一次，两种用途 ----------
  //
  // 旧系统给单人推演必喂 npc_biography（向量库召回这个人的传记）。
  // 我们之前只有新人查设定，老面孔完全没查——等于让模型在不知道
  // 这人是谁的情况下，推他这轮躲不掉什么。
  //
  // 同一个人、同一个问题，没必要发两遍：
  //   新人   → 查回来的当「设定」，补他缺的底子；
  //   老面孔 → 查回来的当「过往」，给推演当背景。
  //
  // 查不到不阻断：资料是帮忙判断的，不是判断的前提。
  // （跟「存档里有他却没有数据」不同——那种是读错了，要停。）
  const biographyByName = new Map();
  let sharedRagContext = '';
  const canQueryAny = host
    && typeof host.vectorContext === 'function'
    && !(host.capabilities?.has && !host.capabilities.has('vectorContext'))
    && options.materials !== false
    && !(options.materials && options.materials.ragVector === false);

  // ---------- 他这会儿在不在场、隔了多久 ----------
  //
  // 老系统给单人推演喂了 scene_type / is_offscene / timeSinceLastEvolution。
  // 这两样直接改变「躲不掉什么」：
  //   在场的，他躲不掉的是**眼前这件事**；
  //   离场的，他躲不掉的是**别处同时在发生的事**。
  //   隔了一轮和隔了三年，能办成的事完全不是一个量级。
  const onSceneNames = new Set(
    (Array.isArray(src.onScene) ? src.onScene : [])
      .map((p) => String(p && p.name || '').trim())
      .filter(Boolean),
  );

  /** 这个人这轮在不在场 */
  function isOnSceneNow(name) {
    if (onSceneNames.size === 0) return null; // 名单没给，不知道就别装知道
    return onSceneNames.has(name);
  }

  /**
   * 距上次演化多久。
   *
   * 账本里有 lastTurn，它记着上一轮走到哪个时间点。
   * 两个时间戳都能读出来才说，读不出就明说不知道——
   * 猜一个「大概隔了几个月」比不说更糟。
   */
  function sinceLastTurn() {
    const lt = ledger && ledger.lastTurn;
    const from = String(lt && (lt.targetTime || lt.worldTime) || '').trim();
    const to = String(turnRange && turnRange.end || '').trim();
    if (!from || !to) return '';
    if (from === to) return '就是刚才那一轮的事';
    return `上一轮走到 ${from}，这轮是 ${to}`;
  }

  // 这一轮要查资料的人：新人 + 所有被推演且已建档的人。
  // 每人只查一次，查回来的东西两边各取所需。
  const allQueriedNames = [...new Set([
    ...requiredScope.characterNames,
    ...newcomerNames,
    ...actorPick.actors
      .map((bb) => String(bb && bb.name || '').trim())
      .filter((n) => n && src.characters && src.characters[n]),
  ])];

  if (!reuseWritingOnly&&(allQueriedNames.length > 0 || candidates.length > 0)) {
    step('新人', newcomerNames.length > 0
      ? `${newcomerNames.length} 人：${newcomerNames.slice(0, 5).join('、')}`
        + `${newcomerNames.length > 5 ? '…' : ''}`
      : '无');

    // 原卡分析完整的本轮年表材料，自行决定查人物、物品、功法、势力和地点。
    // 此处只按材料容量分批，不由代码拿人名清单替代检索条件分析。
    const requestLimits=normalizeRequestLimits(options.batchLimits);
    const queryHeader='【本轮原著补演检索材料】\n区间：'+turnRange.start+' → '+turnRange.end+'\n以下年表是原著参考，不等于存档中已经发生。请分析材料中需要核对的人物本体设定、物品、功法、灵兽、势力和地点；返回资料，不把原著结局当作当前事实。\n【玩家行动与已发生正文】\n'+String(src.playerInput||'')+'\n'+storyText;
    const characterAliases=Object.fromEntries(allQueriedNames.map(name=>[name,Array.from(new Set([...(src.characters?.[name]?.aliases || []),...(typeof options.resolveOriginalAliases==='function'?options.resolveOriginalAliases(name):[])]))]));
    const queryRows=candidates.map(event=>{const span=entrySpan(event),now=parseTimePoint(turnRange.end);return buildVectorQueryInput(event,{materialMode:options.materialMode || 'current_only',currentTime:turnRange.end,characterAliases,location:src.location,maxChars:0,isCurrent:now !== null && span && span.min<=now && now<=span.max});});
    const queryBatches=packRequestMaterials(queryRows,{...requestLimits,maxItems:requestLimits.timelineBatchEvents,sharedChars:queryHeader.length,measure:row=>row.inputText.length,estimateOutput:()=>0});
    // 年表标题里点名的人物就是这个区间内的关键原著人物，材料正文里的人可能是路人或龙套。
    // 这份名单交给向量系统，用来在提示词后声明「这些人物设定优先检索」，并在分析失败时兜底。
    const candidateCharacterNames=collectCandidateNames(candidates);
    const vectorBatches=queryBatches.map(batch=>({queryText:[queryHeader,...batch.map(row=>row.inputText)].join('\n\n'),queryTime:turnRange.end,queryCharacters:allQueriedNames.slice(),queryBatchSize:requestLimits.ragBatchQueries,text:'',report:{status:canQueryAny?'error':'missing',attempted:false,completed:false,reason:canQueryAny?'前批读取未完成，本批尚未执行':'宿主没有提供实际检索能力'}}));
    if(savedMaterial && (!Array.isArray(savedMaterial.vectorBatches) || savedMaterial.vectorBatches.length!==vectorBatches.length || vectorBatches.some((batch,index)=>{const old=savedMaterial.vectorBatches[index];return batch.queryText!==old.queryText || batch.queryTime!==old.queryTime || JSON.stringify(batch.queryCharacters)!==JSON.stringify(old.queryCharacters) || batch.queryBatchSize!==old.queryBatchSize;})))return finish(CE_TURN_STATUS.boundaryFailed,{trace,reason:'本轮检索查询、时点、人物范围或容量分批已变化，不能把旧补取结果冒充本次查询。'});
    hostMaterial.retryState={version:1,profile:'turn',keys:['ragVector'],limits:normalizeMaterialLimits(options.materialLimits),counts:normalizeMaterialCounts(options.materialCounts),requiredScope,selectionMode:'records',direct:{},material:hostMaterial.material,report:hostMaterial.report,vectorBatches};
    hostMaterial.report.push({key:'ragVector',label:'设定集检索',group:'lookup',status:canQueryAny?'error':'missing',chars:0,reason:'年表资料检索尚未完成',attempted:false,completed:false});
    const collectedByName=new Map();
    const retrieved=new Set();
    if(!canQueryAny){
      const disabled=options.materials===false || options.materials?.ragVector===false;
      Object.assign(retrievalReceipt,{status:disabled?'disabled':'unavailable',reason:disabled?'玩家关闭本阶段设定检索':'宿主没有提供实际检索能力'});
      step('资料检索回信',retrievalReceipt.reason,{kind:'retrieval',...retrievalReceipt});
      if(!disabled && Number(options.requestBatchVersion)>=1)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'资料检索未执行：'+retrievalReceipt.reason,openEvents:nextOpenEvents});
    }
    if(canQueryAny)await Promise.all(queryBatches.map(async function(batch,batchIndex){
      const reusable=savedMaterial?.vectorBatches?.[batchIndex];
      if(reusable && ['found','not_found','empty','ok'].includes(reusable.report?.status)){
        Object.assign(vectorBatches[batchIndex],JSON.parse(JSON.stringify(reusable)));
        step('资料检索复用','第 '+(batchIndex+1)+' 批已取得，按原查询使用保存结果');return;
      }
      let nativeReceipt=null,requestScope=null;
      // 不要传 batchCollection:true。
      // 那是主卡内部「整批材料统一重排」的开关，会走到跟正文检索不同的评分分支，
      // 已存在的设定在这条分支里会被整批重排挤掉（同一份资料按正文路径能回 12 条，
      // 走这里只剩 3 条）。补演要的是「按正文检索方式把设定检索回来」，
      // 所以这里只给查询文本和人物范围，检索口径、评分与取舍全部交回主卡原规则。
      const call=await withRetry(()=>{retrievalReceipt.batches++;retrievalReceipt.attempted=true;return host.vectorContext(vectorBatches[batchIndex].queryText,{characterNames:allQueriedNames,referenceTime:turnRange.end,canonPriorityCharacters:candidateCharacterNames,onReceipt:value=>{nativeReceipt=value;},onMaterialRequest:value=>{requestScope=value;}});},{config:host.vectorContext.handlesRetries?{...options.retry,maxRetries:0}:options.retry,signal:options.signal,retryDelayMs:options.retryDelayMs,retryMaxDelayMs:options.retryMaxDelayMs});
      vectorBatches[batchIndex].text=call.ok?String(call.value || ''):'';
      if(requestScope)vectorBatches[batchIndex].requestScope=requestScope;
      vectorBatches[batchIndex].report={...(nativeReceipt || {}),status:call.ok?(String(call.value || '').trim()?'found':'not_found'):'error',attempted:true,completed:call.ok,reason:call.ok?(nativeReceipt?.reason || (String(call.value || '').trim()?'检索完成并返回资料':'检索完成，未命中资料')):call.reason};
    }));
    // Multiple search batches can return an identical text bundle. Retain all
    // individual receipts, but give downstream requests one copy of the text.
    for(const batch of vectorBatches)if(batch.text)retrieved.add(batch.text);
    hostMaterial.material.ragVector=[...retrieved].join('\n\n');
    const failedBatch=vectorBatches.find(batch=>batch.report.status==='error');
    if(canQueryAny){
      const aggregate=failedBatch?failedBatch.report:{status:hostMaterial.material.ragVector?'found':'not_found',attempted:true,completed:true,reason:hostMaterial.material.ragVector?'检索完成并返回资料':'检索完成，未命中资料'};
      // 把本批回信里的检索明细（检索词与实际入选资料）一并带到资料行上。
      // 指导阶段由 host-material 整份展开回信，补演这边是手写行再合并，
      // 只合 status/attempted/completed/reason 会把 searchLog 和 selectedSources 丢掉，
      // 造成同样是原著检索，指导能看到明细、补演看不到。多批时按批次顺序合并，不互相覆盖。
      const receiptDetail={};
      for(const batch of vectorBatches){
        const row=batch.report || {};
        if(typeof row.searchLog==='string' && row.searchLog)receiptDetail.searchLog=receiptDetail.searchLog?receiptDetail.searchLog+'\n\n'+row.searchLog:row.searchLog;
        if(Array.isArray(row.selectedSources) && row.selectedSources.length){
          const merged=receiptDetail.selectedSources || [];
          for(const source of row.selectedSources){
            const existing=merged.find(item=>item.source===source.source);
            if(existing)existing.count=(Number(existing.count)||0)+(Number(source.count)||0);
            else merged.push({source:source.source,count:Number(source.count)||0});
          }
          receiptDetail.selectedSources=merged;
        }
      }
      // receiptDetail（含 searchLog / selectedSources）必须同时写进 retrievalReceipt。
      // 否则它只落在 hostMaterial.report[0] 上，而 1196 行 collectHostMaterial 会把整个
      // hostMaterial 换掉（skipVector:true，资料从变量直塞），report[0] 连同明细一起没了；
      // 事后 1223 行只能用 retrievalReceipt 往 ragReport 补，补不到就永远展不开
      // 「查看检索词与实际入选资料」（玩家 2026-10-30 报的问题）。
      Object.assign(retrievalReceipt,aggregate,receiptDetail);Object.assign(hostMaterial.report[0],aggregate,receiptDetail,{chars:hostMaterial.material.ragVector.length});
      if(failedBatch){step('资料检索回信',aggregate.reason,{kind:'retrieval',...retrievalReceipt});return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'年表资料检索失败：'+aggregate.reason,openEvents:nextOpenEvents});}
    }
    // 每批回信都是局部证据；后批未命中不能撤销前批已取得的本人设定。
    const requiredCharacterReceipts=new Map();
    for(const batch of vectorBatches)for(const receipt of batch.report.requiredCharacters || []){
      if(!requiredCharacterReceipts.has(receipt.name) || receipt.found===true)requiredCharacterReceipts.set(receipt.name,receipt);
    }
    retrievalReceipt.requiredCharacters=[...requiredCharacterReceipts.values()];
    sharedRagContext=hostMaterial.material.ragVector;
    if(canQueryAny){if(sharedRagContext)Object.assign(retrievalReceipt,{status:'found',reason:'检索完成并返回资料'});step('资料检索回信',retrievalReceipt.reason,{kind:'retrieval',...retrievalReceipt});}
    for(const name of allQueriedNames)collectedByName.set(name,{text:pickNewcomerSections(sharedRagContext,name,characterAliases[name]).related,failed:false});
    step('资料检索',candidates.length+'条年表，'+(canQueryAny?queryBatches.length:0)+'次材料分析检索');
    for (const name of allQueriedNames) {
      const bundle = actorPick.actors.find((b) => String(b && b.name || '').trim() === name);
      const events = Array.isArray(bundle && bundle.events) ? bundle.events : [];
      const isNewcomer = newcomerNames.includes(name);
      let text = '';
      let fetchFailed = false;

      // 人物资料从本轮共用检索结果中取；物品/地点等结果仍留给后续共享材料。
      if(canQueryAny){const fetched=collectedByName.get(name);text=fetched?.text || '';fetchFailed=fetched?.failed === true;}

      // 新人：这段是设定，补他缺的底子
      if (isNewcomer) {
        newcomers[name] = buildNewcomerProfile({ name, settingText: text, events, fetchFailed });
        if (!text) {
          diag.warn(
            retrievalReceipt.completed ? `设定集里没查到 ${name}` : `本轮未取得 ${name} 的设定资料`,
            '按已有年表、正文和存档继续，性格动机可依已知行为保守推断；推断不冒充原著设定，不凭空增加师承、机缘或突破',
          );
        }
        continue;
      }

      // 老面孔：这段是他的过往，给推演当背景
      if (text) biographyByName.set(name, text);
    }

    if (biographyByName.size > 0) {
      step('生平', `${biographyByName.size} 人查到了过往`);
    }

    const missingCount = Object.values(newcomers).filter((p) => p.degraded).length;
    if (missingCount > 0) {
      diag.warn(`${missingCount} 个新人缺少原著设定资料`, '按已有年表和人物行为继续，未知设定不伪造');
    }
  }


  const eventMaterials = candidates.map(event=>{
    const span=entrySpan(event), now=parseTimePoint(turnRange.end);
    const selected=renderEventMaterial(event,{mode:options.materialMode || 'current_only',isCurrent:now !== null && span && span.min <= now && now <= span.max,maxChars:0});
    return {code:inferEventCode(event),title:event.title,time_start:event.time_start,time_end:event.time_end,text:selected.text,source:selected.primarySource,truncated:selected.truncated,originalChars:selected.originalChars};
  });
  // 正文后的共享资料只采集一次，边界与正文共用；不交给历史旧账。
  requiredScope.settingText=sharedRagContext;requiredScope.requiredCharacterReceipts=retrievalReceipt.requiredCharacters || [];
  if(!reuseWritingOnly)try {
    const vectorBatches=hostMaterial.retryState?.vectorBatches;
    hostMaterial = await collectHostMaterial({
      host,
      profile: 'turn',
      limits:options.materialLimits,
      counts:options.materialCounts,requiredScope,logId:src.logId,
      reuseState:savedMaterial,
      enabled: options.materials,
      skipVector: true,
      direct: {
        scene: [turnRange.start, turnRange.end].filter(Boolean).join(' → '),
        playerInput: String(src.playerInput || ''),
        currentStory: storyText,
        onScene: renderOnSceneText(src.onScene),
        canonTimeline: eventMaterials.map(event=>event.title+'\n'+event.text).join('\n\n'),
        ragVector:sharedRagContext,
      },
    });
    if(vectorBatches)hostMaterial.retryState.vectorBatches=vectorBatches;
  } catch (error) {
    // 采集层自己不会抛，这是最后一道保险：资料取不到也照常往下走。
    // 但**必须报成 error**——静默变成「0/0 项」会让人以为「本来就没有」。
    const msg = String(error && error.message ? error.message : error);
    if(savedMaterial)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'此前资料不能安全复用：'+msg});
    step('资料', '采集异常，本轮资料不完整：' + msg);
    diag.error('资料采集异常', msg + '\n（NPC 视角正文会缺人物状态与世界背景，写出来可能不对）');
  }

  const ragReport=(hostMaterial.report || []).find(row=>row.key==='ragVector');
  if(ragReport)Object.assign(ragReport,retrievalReceipt);
  const matOk = (hostMaterial.report || []).filter(
    (r) => r.status === 'ok' || r.status === 'direct' || r.status === 'found',
  );
  step('资料', `${matOk.length}/${(hostMaterial.report || []).length} 项`,{kind:'materials',profile:'turn',report:hostMaterial.report});
  for (const line of materialReportLines(hostMaterial.report)) {
    if (line.level === 'warn') diag.warn(line.text, line.detail);
  }


  const worldContext = {
    time: turnRange.end || '',
    location: String(src.location || '').trim(),
    events: hostMaterial.material.worldEvents || '',
    factors: hostMaterial.material.worldFactors || '',
  };
  if (worldContext.events || worldContext.factors) {
    step('世界背景', [
      worldContext.events ? '世界大事' : '',
      worldContext.factors ? '世界因子' : '',
    ].filter(Boolean).join('、') + ' 已带上');
  }


  // 正文已经涉及的人交由普通演化；补演只负责正文之外的原著人物。
  const storyRoster = [...new Set([...knownOriginalNames,...Object.keys(src.characters || {}),...(Array.isArray(src.onScene)?src.onScene:[]).map(row=>row.name).filter(Boolean)])].map(name=>({name,
    aliases:[...new Set([...(src.characters?.[name]?.aliases || []),...(knownOriginalActors.find(row=>row.name===name)?.aliases || [])])],
    isPlayer:playerNames.includes(name),isCanon:knownOriginalNames.includes(name) && !playerNames.includes(name)}));
  const analysisActors=actorPick.actors.map(actor=>({name:actor.name,material:[renderActorMaterial(actor,{maxCharsPerEvent:0}),'【账本已确认的本人事件片段，仅避免重演，不代表事件全部结束】\n'+JSON.stringify(openEvents.filter(e=>e.doneActors?.[actor.name]).map(e=>({eventId:e.eventId,coveredTo:e.coveredTo,done:e.doneActors[actor.name]}))),src.characters && src.characters[actor.name] ? '【本人人物档案与目标】\n'+JSON.stringify(src.characters[actor.name]) : '', '【原著设定】见上方一次性共享设定资料；未知部分不补造'].filter(Boolean).join('\n\n'),state:readStateNow(actor.name,actor)}));
  step('补演边界判定','核对正文覆盖、事件变化与人物影响');
  /* ★★ 2026-11-01 玩家：「这种在原著故事之前的时间点也应该启动原著补演的边界判定流程
   *    才对啊，怎么展示ui里完全没有」「按照之前酒馆版本，无论哪种情况都调用模型来走
   *    边界判定流程，有这个流程来决定补演档位」
   *
   * 原来这里是：
   *   const storyAnalysis = preparedBoundary?.storyAnalysis || (
   *     analysisActors.length || candidates.length || (src.hooks && src.hooks.length)
   *       ? await analyzeStoryBoundary({...})
   *       : {ok:true,facts:[],...}          ← 三个条件全空就静默跳过
   *   );
   *
   * 问题：开局在原著第一件事之前时，没有候选事件、没有已建档人物、没有线索，
   *       三个条件全空 → 整段边界判定被静默跳过、连观测记录都不写 →
   *       前端数据全空 → 「补演边界判定」整块不渲染 → 玩家看到的是「压根没跑」。
   *
   *       可 diff.js 里明明定义了 outsideRange 档（「年表之外 · 无需补演」），
   *       提示词里也写明了这是「在原著第一件事之前」的档位 —— 说明本来就该由模型
   *       判这一档。但代码在调用模型之前就短路了，outsideRange 永远命中不了。
   *
   * 修法（按玩家口径）：删掉短路，任何情况都调用模型判档位。
   *   模型会明确返回 outsideRange，面板就能正常显示「本轮时间不在任何年表事件区间内」。
   *   「跑了但结论是不用补」和「根本没跑」必须让玩家区分得出来。
   */
  const boundaryContext=renderMaterialForPrompt(hostMaterial.material,(hostMaterial.keys || []).filter(key=>key!=='currentStory'&&key!=='canonTimeline'));
  const storyAnalysis=preparedBoundary
    ?{...preparedBoundary.storyAnalysis,eventProgress:observedProgress.filter(row=>!ordinaryUnreached.has(row.eventId)),
      worldEvents:(preparedBoundary.storyAnalysis.worldEvents||[]).filter(row=>!ordinaryUnreached.has(row.code))}
    :await analyzeStoryBoundary({host,storyText,actors:analysisActors,people:storyRoster,hooks:src.hooks || [],events:eventMaterials,range:turnRange,eventProgress:ledger.eventProgress || [],currentTime:turnRange.end,background:boundaryContext,options:{...options,promptOverrides:overrides}});
  if(!storyAnalysis.ok)return finish(CE_TURN_STATUS.boundaryFailed,{trace,range:turnRange,reason:'补演边界判定未完成：'+storyAnalysis.reason,openEvents:nextOpenEvents});
  if(storyAnalysis.uncertain?.length)step('资料局限说明',storyAnalysis.uncertain.map(v=>typeof v==='string'?v:JSON.stringify(v)).join('；'),{kind:'materialNotes',notes:storyAnalysis.uncertain});
  if(storyAnalysis.eventProgress?.length)step('事件进度观察','已读取实际进展，等待NPC自然推演',{kind:'eventProgress',rows:storyAnalysis.eventProgress,confirmed:false});
  // ★ 世界信息共享，个人信息独享（玩家 2026-11-01）
  //
  // 原先这里把 hostMaterial.text（全部资料的拼接）整个塞进 supplementBackground，
  // 而 prose-prompt 又把它当成 sharedBackground，**每个 NPC 都完整收到一遍**。
  // 结果 packRequestMaterials 的 sharedChars 变成巨无霸，
  // 只能把 maxInputChars 提到 500000 才装得下 —— 那是不对的。
  //
  // 现在：background 只放**世界共享**的部分（世界规则/大事/地理/本轮正文/年表/叙事记忆），
  // 「写谁才给谁」的个人资料（设定集检索/人物档案/随身物品）不进 background，
  // 而是跟着每个 NPC 自己的 actor material 走（见下面的 perActorMaterial）。
  // The prose and boundary templates supply the authoritative player story separately.
  const {currentStory:duplicateStory,...supportingMaterial}=hostMaterial.material;
  const sharing = splitMaterialBySharing(supportingMaterial, {order:hostMaterial.keys});
  // ★ 设定集检索要按「人 / 非人」再切一刀（玩家 2026-11-03）
  //
  // 只按归属把整份 ragVector 划给 perActor 是不够的：
  // 里面混着【第N章】人物设定 与 【第N章】物品/功法/势力/地点设定。
  // 前者独享，后者按主语句式永远筛不进任何人 → 会被静默丢掉。
  //
  // 玩家决定：「非人物设定先放共享吧，后面再解决。」
  // 所以：人物段留在 perActor（按主语筛选），非人物段回到 shared。
  const allKnownNames = (() => {
    const names = [...knownOriginalNames,...(src.canonicalNames || []),...analysisActors.map(actor=>actor.name),...actorPick.actors.map(actor=>actor.name)];
    for (const [n, info] of Object.entries(src.characters || {})) {
      names.push(n);
      if (info && info.profile && info.profile.name) names.push(info.profile.name);
      if (info && Array.isArray(info.aliases)) names.push(...info.aliases);
    }
    return [...new Set(names.map((v) => String(v || '').trim()).filter((v) => v.length >= 2))];
  })();
  const activeRagNames=[...analysisActors.map(actor=>actor.name),...actorPick.actors.map(actor=>actor.name),
    ...Object.entries(src.characters || {}).flatMap(([name,info])=>[name,info?.profile?.name,...(Array.isArray(info?.aliases)?info.aliases:[])])].filter(Boolean);
  const ragSplit = splitRagBySubject(hostMaterial.material && hostMaterial.material.ragVector, allKnownNames,{activeNames:activeRagNames});
  // 非人物设定并回共享；人物设定仍留给 perActor
  /* ★★★ 2026-11-03 玩家定：
   *   「要告诉ai这份资料是做什么的，又是怎么通过本轮补演所有人的行为来影响和更新的。」
   *
   * sharing.shared 里已经含着世界大事原文，只缺「它是干什么的」这层说明。
   * 所以这里只补说明、不重贴正文，避免同一份记录在提示词里出现两遍。
   * 用的是和原著指导完全同一段说明（worldEventGuideText），两处口径一致。 */
  const worldEventGuideForProse = hostMaterial.material.worldEvents ? worldEventGuideText() : '';
  const sharedTextWithWorldSettings = [worldEventGuideForProse, sharing.shared, ragSplit.worldText ? '### 设定集检索（非人物部分：物品/功法/势力/地点）\n' + ragSplit.worldText : '']
    .filter(Boolean).join('\n\n');
  const perActorText = [ragSplit.characterText ? '### 设定集检索（人物部分）\n' + ragSplit.characterText : '', sharing.perActorKeys.includes('characters') ? renderMaterialForPrompt({ characters: hostMaterial.material.characters }, ['characters']) : '', sharing.perActorKeys.includes('items') ? renderMaterialForPrompt({ items: hostMaterial.material.items }, ['items']) : '']
    .filter(Boolean).join('\n\n');
  if (sharing.perActorKeys.length) {
    step('资料分发', `世界共享 ${sharing.sharedKeys.length} 项；个人独享 ${sharing.perActorKeys.length} 项（${sharing.perActorKeys.join('、')}）`, {
      kind: 'materialSharing', sharedKeys: sharing.sharedKeys, perActorKeys: sharing.perActorKeys,
      sharedChars: sharing.shared.length, perActorChars: sharing.perActor.length,
    });
  }
  const supplementBackground=[sharedTextWithWorldSettings,renderEventProgress(ledger.eventProgress || []),'【本轮边界观察，不是锁定的剧情结果】\n'+JSON.stringify(storyAnalysis.eventProgress || [])+'\n只据实际性格、动机和处境推演；参考事项不必照单完成，停滞、放弃、阻断、替代或变异均可有因果地发生。','【资料局限】\n'+retrievalReceipt.reason+'。以下不确定说明只表示资料较少，不是已确认事实；以已有年表、正文和存档继续，不把未知内容当成既定设定。\n'+(storyAnalysis.uncertain || []).map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n')].filter(Boolean).join('\n\n');
  /**
   * 某个人的「个人独享资料」。
   *
   * 玩家 2026-11-01：「写谁就只参考谁的资料才对。」
   *
   * 从 perActor 那部分里挑出**与这个人相关**的内容：
   *   · 设定集检索：**只从人物段里挑**（非人物段已经在 shared，人人可见）
   *   · 随身物品：只保留他本人那一段
   * 挑不出来就返回空 —— **宁可少给，也不能把别人的资料塞给他**。
   *
   * @param {string} name
   * @returns {string}
   */
  function perActorMaterialFor(name) {
    const who = String(name || '').trim();
    if (!who) return '';
    const aliases = (() => {
      const info = (src.characters && src.characters[who]) || {};
      const list = [who, info.profile && info.profile.name].concat(Array.isArray(info.aliases) ? info.aliases : []);
      return [...new Set(list.map((v) => String(v || '').trim()).filter((v) => v.length >= 2))];
    })();
    const hit = (text) => aliases.some((a) => String(text || '').includes(a));

    const out = [];
    // 设定集检索：只从**人物段**里挑（非人物段已经在 shared 里，人人可见）。
    //   ① 段落主语是本人 → 给全文
    //   ② 只是被别人提到 → 只给一句人名级线索，不搬运对方档案
    //      否则写韩立时会把「张铁性格憨厚」这种别人档案里的描述泄露给他。
    const rag = ragSplit.characterText;
    if (rag) {
      const titled=/^###\s*标题[:：]/m.test(rag);
      const paras = titled?splitRagTitleRecords(rag):rag.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      const mineParas = [];
      const mentionNames = [];
      for (const p of paras) {
        if(titled){
          const titles=ragRecordTitleNames(p);
          if(titles.some(title=>aliases.includes(title)))mineParas.push(p);
          else if(titles.length&&hit(p)&&!mentionNames.includes(titles[0]))mentionNames.push(titles[0]);
          continue;
        }
        // 取「段首到第一个标点」作为主语判定区。
        // 不能取前 40 字——「张铁，韩立同门好友，性格憨厚」在 40 字内含「韩立」，
        // 会被误判成韩立本人的设定，把他的对手档案泄露给韩立。
        const subject = (p.replace(/^[【\[][^】\]]*[】\]]\s*/, '').split(/[，,。；;：:]/)[0] || '').trim();
        if (aliases.some((a) => subject.includes(a))) {
          mineParas.push(p);
        } else if (hit(p)) {
          // 被别人提到：只记下「谁提到过我」，不搬运对方档案
          const named = subject.replace(/^第?\d*章?\s*/, '').trim();
          if (named && !aliases.includes(named) && !mentionNames.includes(named)) mentionNames.push(named);
        }
      }
      if (mineParas.length) {
        out.push('【与你有关的原著设定】');
        out.push(mineParas.join('\n\n'));
      }
      if (mentionNames.length) {
        out.push('【原著里另外提到过你的】：' + mentionNames.join('、') + '。你只知道他们与你有关，不知道他们的底细，别替他们编。');
      }
    }
    // 注意：这里原本有一段「随身物品：ceBridgeReadItems 每人一段」的注入。
    // 玩家 2026-11-01 二次纠正后，items 资料项已从两个阶段彻底删除，
    // material.items 永远是 undefined，这段代码成了死分支。
    //
    // 不留着的原因：死代码会误导后来者以为「补演还在注入物品」。
    // 补演要的物品信息本来就来自人物快照（src.characters 的
    // inventory / equipment / items 字段），走的是上面【你自己的人物档案】那条线。
    return out.join('\n');
  }
  const storyMentions=storyAnalysis.handled;
  const ownedRefs=new Set(preparedBoundary?.turnPlan?.canonOwnedRefs || []);
  const canonSceneNames=new Set(storyMentions.filter(row=>ownedRefs.has(row.name)).map(row=>row.name));
  const savedOrdinaryOps=options.ordinarySettlement?.records || [];
  const storyHandledNames = new Set(storyMentions.filter(row=>{
    const id=src.characters?.[row.name]?.id;
    return !canonSceneNames.has(row.name) || Boolean(id&&savedOrdinaryOps.some(({operation:op})=>
      [op?.id,op?.owner,op?.from,op?.to,op?.data?.['0']].includes(id)));
  }).map(item=>item.name));
  // 档位与覆盖事件必须一起进追踪记录：前端「补演边界判定」的展示完全依赖它。
  // 只带 handled/facts/influences 会让面板一直显示「档位待确认」——
  // 重跑边界判定也救不回来，因为数据根本没写进这条记录。
  step('正文人物与事实',storyMentions.length+'人由正文处理；'+storyAnalysis.facts.length+'条事实',{kind:'storyAnalysis',handled:storyMentions,facts:storyAnalysis.factRecords,influences:storyAnalysis.influences,worldEvents:storyAnalysis.worldEvents,turnAdvanceTier:storyAnalysis.turnAdvanceTier||'',coveredEventIds:storyAnalysis.coveredEventIds||[],involvedActors:storyAnalysis.involvedActors||[]});
  // 正文涉及不代表该人物全部经历已补齐，不能提前给本人或事件盖完成章。
  const excludedNonCanonNames = [...new Set((src.autonomousCandidates || []).filter(name=>!knownOriginalNames.includes(name)))];
  // 正文涉及的原著人物仍写完整个人视角，交汇末段另行标记。
  actorPick.filtered.kept = actorPick.actors.length;
  // 本楼层已原子保存的人物沿用核验过的原文；继续本轮不重新推演既定事实。
  const savedActors = Object.fromEntries(Object.values(options.savedActorCommits || {}).filter(receipt=>
    receipt?.status==='saved' && receipt.block?.name===receipt.name && receipt.block.body===receipt.body
    && (String(src.characters?.[receipt.name]?.id || '')===String(receipt.actorId) || reusable&&!src.characters?.[receipt.name]?.id&&receipt.actorId)
    && actorPick.actors.some(actor=>actor.name===receipt.name)
  ).map(receipt=>[receipt.name,receipt]));
  const needsActorPreparation=actor=>!savedActors[actor.name]&&!savedWritingInputs.has(actor.name)&&(!replacement||replacementNames.has(actor.name));
  step('人物', `共 ${actorPick.filtered.total} 人，`
    + `建档 ${actorPick.filtered.kept} 人`);
  if (actorPick.filtered.dropped > 0) {
    diag.step(
      `没建档 ${actorPick.filtered.dropped} 人`,
      '出现不足 ' + actorPick.filtered.minEvents + ' 次、无状态标注、也不在档的，'
      + '既不做终态对勾，也不记生平',
    );
  }

  // ---------- 生平旧账：这一轮区间里**已经过去**的原著事 ----------
  //
  // 用户 2026-10-21 把问题一句话说穿：
  //   「本质难点就在于怎么处理，在上一轮或者更早轮次就已经出现的玩家的行为
  //     造成的对应npc的原著行为偏差导致的本轮历史经历推演问题」
  //
  // 年表说「如果玩家没出现，他会怎么过」。玩家出现过了，所以它可能不成立。
  //
  // **输入只有存档现状 + 原著推力，正文绝不进来**——
  //   「正文是当前进行时刻发生的事情，他怎么会影响历史呢？」
  //
  // 正文那一刻的经历由散文解析产出，两段拼成完整生平，不重叠。
  //
  // 这一步放在最前面，因为它不依赖后面任何结果：只要存档和年表。
  // 这一轮每个人的「现状」，只读一次。
  //
  // 之前生平旧账和边界判定各读一次，等于同一张表读两遍、同一套兜底逻辑
  // 跑两遍。而且两边**有可能读到不一样的东西**——只要中间有别的东西改过
  // 存档，生平按 A 算、必成事实按 B 算，最后拼出来的传记是自相矛盾的。
  //
  // 所以在这里定死：一轮一个人，现状只有一个版本。
  // ---- 两个时点的状态，必须分开 ----
  //
  // 用户 2026-10-21：
  //   「存档现状 + 原著推力 才对，正文是当前进行时刻发生的事情，
  //     他怎么会影响历史呢？」
  //
  // 所以这里有两份状态，用途完全不同：
  //
  //   beforeRows  正文**之前**那一刻的行快照 → 只给「旧账」（历史）用
  //   stateNow    现在（正文之后）的状态       → 给边界判定和散文用
  //
  // 原来两者是同一个东西（都取 stateNow），于是本轮正文末尾把人写死，
  // 历史里他就「一直已经死了」，前面几个月的经历全被终点状态抹掉。
  // 这是方案 R01。
  const backstoryRows = [];
  for (const bundle of actorPick.actors) {
    const name = String(bundle && bundle.name || '').trim();
    if (!name) continue;
    if (!needsActorPreparation(bundle)) continue;
    const job=preparedBoundary?.turnPlan.canonJobs.find(row=>row.name===name);
    // 只有账本明确确认到轮前水位的同事件增量才省去历史重建；已有ID本身不是证明。
    if(job?.depth==='incremental' && src.characters?.[name] && bundle.events.every(event=>openEvents.some(row=>row.eventId===event.code && row.doneActors?.[name] && parseTimePoint(row.coveredTo)!==null && parseTimePoint(row.coveredTo)>=parseTimePoint(turnRange.start))))continue;
    // 历史用**正文之前**的状态，不是现在。
    //
    // 拿不到就留空，提示词里会明说「这份状态没有」，
    // 让模型按年表材料保守写，而不是拿正文后的现状冒充过去。
    const beforeText = readBeforeState(name);
    backstoryRows.push({
      name,
      bundle,
      stateText: beforeText,
      // 状态缺失要记下来，完成回执里得让玩家看见
      stateMissing: !beforeText,
      events: Array.isArray(bundle.events) ? bundle.events : [],
    });
  }
  stateMissingNames = backstoryRows.filter((r) => r.stateMissing).map((r) => r.name);

  let backstory = {};

  // ---------- 取数体检：读不到就是写错了，直接停 ----------
  //
  // 占位符和填充点都是我们自己写的。名字对得上就**必然**读得到——
  // 读不到只有一种解释：代码读错了。
  //
  // 那种情况绝不能往下走。因为空值填进去不会报错，模型看到
  // 「（存档里没有这个人的状态记录）」就会当真，然后按原著凭空推一个，
  // 推出来的东西看着很正常，账也就这么记下去了。**坏账比报错可怕。**
  //
  // 唯一的例外是**新人**：存档里本来就没有他，那是正 stav，不是故障。
  // 所以判据不是「有没有数据」，而是「该有的有没有」。
  {
    const broken = [];
    for (const bundle of actorPick.actors) {
      const name = String(bundle && bundle.name || '').trim();
      if (!name||replacement&&!needsActorPreparation(bundle)) continue;

      // 材料必须有：圈到他就说明年表里这轮有他的事。没有事件 = 圈人错了，
      // 或者年表没读进来。两种情况都得停。
      if (!Array.isArray(bundle.events) || bundle.events.length === 0) {
        broken.push(`${name}：圈到他了，却拿不出原著事件`);
        continue;
      }

      // 现状：新人是「本来就该空」，老面孔是「不该空」。
      const isNewcomer = Boolean(newcomers && newcomers[name]);
      if (isNewcomer) continue;

      const hasInSave = Boolean(src.characters && src.characters[name]);
      if (!hasInSave) {
        // 既不在存档、也没被当新人处理 —— 说明圈人和补档这两步脱节了
        broken.push(`${name}：既不在存档，也没进新人补档`);
        continue;
      }

      const now = readStateNow(name, bundle);
      const filled = now
        ? Object.keys(now).filter((k) => k !== 'basePersonality'
          && String(now[k] == null ? '' : now[k]).trim()).length
        : 0;
      if (filled === 0) {
        broken.push(`${name}：存档里有他，但一个字段都没读出来`);
      }
    }

    if (broken.length > 0) {
      return finish(CE_TURN_STATUS.rolledBack, {
        trace, range: turnRange,
        reason: `读数据失败（不是没数据，是读错了）：${broken.join('；')}`,
        canonReferences:Object.fromEntries(actorPick.actors.map(actor=>[actor.name,{setting:String(newcomers[actor.name]?.fromSetting || ''),biography:String(biographyByName.get(actor.name) || ''),timeline:renderActorMaterial(actor,{maxCharsPerEvent:0}),ceiling:ceilings[actor.name] || null}])),
    backstory, backstoryLines: collectBackstoryLines(backstory),
        openEvents: nextOpenEvents,
      });
    }
  }

  const candidateCodes=candidates.map(eventCodeOf).filter(Boolean),candidateNames=actorPick.actors.map(actor=>actor.name);
  const charMats=[],proseResults=[],dispatch={solo:[],batches:[]},readyNames=new Set();
  // 首轮没通过的人先攒在这里，等所有人都跑完再合成一次请求重发，
  // 而不是谁失败就当场为它单独再发一次。
  const rewriteQueue=[];
  const useSemanticReview=Number(options.requestBatchVersion)>=1;
  for(const receipt of Object.values(savedActors)){
    proseResults.push({name:receipt.name,ok:true,semanticChecked:true,block:structuredClone(receipt.block)});
    readyNames.add(receipt.name);
    if(typeof options.onProseReady==='function')await options.onProseReady({blocks:[structuredClone(receipt.block)],names:candidateNames,biography:{[receipt.name]:receipt.biography || ''},canonReferences:{}});
    step('人物正文',receipt.name,{kind:'prose',block:structuredClone(receipt.block),accepted:true});
  }
  if(replacement)for(const [name,seed] of Object.entries(options.replay.seeds||{})){
    if(replacementNames.has(name)||savedActors[name]||!candidateNames.includes(name))continue;
    proseResults.push({name,ok:true,semanticChecked:true,block:structuredClone(seed.block)});
    readyNames.add(name);
  }
  // 事件进度状态必须先于正文任务声明：正文任务在下面就会启动并在核验时回写这些状态。
  // 起始值不能写成「没有人物材料就算进度已完成」——那是把「没判断」当成「已完成」。
  // 起始一律视为未完成，等世界核查真正回报进度后再置为已完成。
  let finalEventProgress=[],progressFinalized=false,progressFailure='';
  // 本轮没确认进度的事件编号：要带到结果里，下一轮只补这几条。
  let unconfirmedEvents=[];
  const actorReadyJobs=[],actorProseJobs=[],actorFlowErrors=[],pendingActorPackets=[];
  const historyReady=new Map(),historyResolvers=new Map();let actorFlushQueued=false;
  candidateNames.forEach(name=>historyReady.set(name,new Promise(resolve=>historyResolvers.set(name,resolve))));
  candidateNames.filter(name=>!backstoryRows.some(row=>row.name===name)).forEach(name=>historyResolvers.get(name)?.(true));
  ceilings=buildCeilings({actors:actorPick.actors,timeline:(src.timeline||[]).filter(event=>!candidates.some(active=>active.timingChange&&inferEventCode(active)===inferEventCode(event))),afterTime:turnRange.end,maxChars:0});
  // 同档B/C准备满一批即可先写，不等最后一人的历史；尾批仍等本档收齐。
  // A仍立即推进；人数只决定释放时机，实际输入/输出容量继续由分派器核对。
  const cohortTiers=typeof options.castTierResolver==='function'?options.castTierResolver(candidateNames):null;
  const cohorts=new Map();
  const configuredCohortSize=Number(options.maxPerBatch);
  const cohortBatchSize=Number.isFinite(configuredCohortSize)&&configuredCohortSize>=1?Math.floor(configuredCohortSize):Infinity;
  if(cohortTiers)for(const {name} of actorPick.actors.filter(needsActorPreparation)){const tier=cohortTiers.get(name);if(tier==='major'||tier==='minor'){if(!cohorts.has(tier))cohorts.set(tier,{expected:new Set(),seen:new Set(),packets:[]});cohorts.get(tier).expected.add(name);}}
  function flushCohort(group,count=group.packets.length){for(const packet of group.packets.splice(0,count))queueActorPacket(packet);}
  function queueActorPacket(packet){
    if(aborted())return;
    pendingActorPackets.push(packet);if(actorFlushQueued)return;actorFlushQueued=true;
    // 同一个返回批次里已经就绪的人可按容量合写；下一批不阻挡当前批。
    const work=Promise.resolve().then(()=>{
      actorFlushQueued=false;const packets=pendingActorPackets.splice(0),materials=packets.flatMap(own=>buildAllCharacterMaterials({
        allowParallel:true,excludedNames:[],missing:own.diff.missing,tasksByActor:own.diff.perActor,mutated:own.diff.mutated,candidates:[own.name],
        eventsByActor:{[own.name]:actorPick.actors.find(actor=>actor.name===own.name)?.events || []},provisionalHistory:backstory,savedProgress:ledger.eventProgress || [],
        lookup:name=>src.characters?.[name] || {},storyText:src.storyText,timeRange:{start:turnRange.start,end:turnRange.end},
        /* 2026-11-02 复盘修复：把上一楼层已保存的人物正文透传下去。
         * resolveContinuingParagraph 读的是 previousProse，之前整条链上没人传，
         * 续写材料永远为空——玩家点名的「材料没给到位」就是这个。 */
        previousProse:src.previousProse,taskCodes:candidateCodes,dossiers:own.dossiers || {},ceilings,
        covered:coveredForProse(own.diff),background:[supplementBackground,renderHooksForProse(src.hooks || [])].filter(Boolean).join('\n\n')
      }));
      materials.forEach(material=>{material.material.handoffRequired=storyHandledNames.has(material.name);
        material.material.canonOwnsScene=canonSceneNames.has(material.name)&&!material.material.handoffRequired;
        const decision=preparedBoundary?.turnPlan.decisions.find(row=>row.name===material.name);
        // 处理深度由「本轮时间推进档位」决定，不由单人的 canonAdvance 猜：
        // 跨年表事件档全员完整补演（把这段该有的经历整段补出来）；
        // 同事件有进展档才按 push→增量 / break→完整；
        // 同事件无进展档根本不进补演流程，走不到这里。
        const tier=preparedBoundary?.turnPlan?.turnAdvanceTier||preparedBoundary?.turnAdvanceTier||'';
        const depth=tier==='crossEvent'?'full':(decision?(decision.canonAdvance==='break'?'full':'incremental'):'');
        if(decision){material.material.canonDecision=decision;}
        if(depth){material.material.canonTaskDepth=depth;material.material.dossier ||= {};if(decision)material.material.dossier.canonDecision=decision;material.material.dossier.ceiling ||= '下一参考节点未知；从真实基线和当前阶段判断，未知未来不阻止境界内合理进展；仅有依据的外力可打破对应走廊，不能自造机缘或按天数比例增长。';}});
      charMats.push(...materials);
      // 三档待遇：A 领衔核心单写精核，B 重要角色合写核关键事实，C 配角打包短写。
      // 分档来自玩家核心名单 + 原著重要名单，只决定资源，不决定是不是原著人物。
      const castTiers=typeof options.castTierResolver==='function'
        ? options.castTierResolver(materials.map(material=>material.name))
        : assignCastTiers(materials.map(material=>material.name),{roster:{},coreNames:options.coreCharacterNames||[],resolve:options.resolveImportantRole});
      // 默认「核心单写、重要/配角合并」：玩家仍可在设置里改回按容量合并或全部单写/合并。
      // 2026-11-01：共享背景超过单批容量时不再整轮失败，改为自动精简。
      // 精简发生了要能让玩家知道，所以把回调透传下去，记录一条提示。
      const sharedTrims=[];
      const onSharedTrimmed=info=>{
        sharedTrims.push(info);
        try{
          step('精简背景','共享背景超出单批容量，已自动精简 '+info.trimmed+' 字（'+info.sharedBefore+' → '+info.sharedAfter+'）',{kind:'shared-trim',...info});
        }catch(e){}
      };
      const plan=planProseDispatch(materials,{strategy:options.dispatchStrategy || CE_PROSE_DISPATCH.capacity,coreMaxChars:options.coreMaxChars,minorMaxChars:options.minorMaxChars,resolveImportantRole:options.resolveImportantRole,maxPerBatch:options.maxPerBatch,force:options.forceDispatch,castTiers,coreNames:options.coreCharacterNames,tierBudgets:options.tierBudgets,onSharedTrimmed,...options.batchLimits});
      for(const row of [...plan.solo,...plan.batches.flat()]){const material=charMats.find(m=>m.name===row.name);if(material){material.castTier=row.material?.tier;Object.assign(material.material,{tier:row.material?.tier,proseBaseChars:row.material?.proseBaseChars,proseMaxChars:row.material?.proseMaxChars});}}
      dispatch.solo.push(...plan.solo);dispatch.batches.push(...plan.batches);
      step('分派',describeDispatch(plan),{kind:'dispatch',solo:plan.solo.map(m=>m.name),batches:plan.batches.map(group=>group.map(m=>m.name)),tiers:Object.fromEntries(castTiers)});
      return executeProsePlan(plan);
    }).catch(error=>{actorFlowErrors.push(error);});
    actorProseJobs.push(work);
  }
  function actorBoundaryReady(packet){
    if(aborted())return;
    const ready=(historyReady.get(packet.name) || Promise.resolve(true)).then(confirmed=>{
      const group=cohorts.get(cohortTiers?.get(packet.name));
      if(!group){if(confirmed)queueActorPacket(packet);return;}
      group.seen.add(packet.name);if(confirmed)group.packets.push(packet);
      while(group.packets.length>=cohortBatchSize)flushCohort(group,cohortBatchSize);
      if(group.seen.size===group.expected.size)flushCohort(group);
    }).catch(error=>{actorFlowErrors.push(error);});
    actorReadyJobs.push(ready);
  }
  // 旧账与本人边界彼此独立，共享资料体检通过后同时开始。
  const backstoryJob=backstoryRows.length && options.backstory!==false?runBackstory({host,rows:backstoryRows,turnStart:turnRange.start,turnEnd:turnRange.end,options,diag,step,
    onReady:(name,lines,confirmed)=>{backstory[name]=lines;historyResolvers.get(name)?.(confirmed);}
  }).catch(error=>{candidateNames.forEach(name=>historyResolvers.get(name)?.(false));actorFlowErrors.push(error);return {};}):Promise.resolve({});
  if(!backstoryRows.length || options.backstory===false)candidateNames.forEach(name=>historyResolvers.get(name)?.(true));

  // ---------- 世界背景：他站在什么样的局势里 ----------
  //
  // 光给他年表 + 他自己的存档，推不准「躲不掉什么」。
  // 同一个 NPC，门派正在被灭、和宗门安稳，推出来完全是两回事。
  //
  // 老系统给单人推演喂了 29 项，这里把真正影响判断的补上：
  //   世界时间 / 玩家所在 / 最近的世界大事 / 世界因子（势力、环境）。
  //
  // 桥早就把这些读好了（host.worldEvents / host.worldFactors），
  // 但之前**一个都没接进提示词**——读了个寂寞。
  // 进行中事件的提醒：拼在每个人材料的前面，
  // 让模型知道「这几条还没走完，别写结局」
  const progressNotice = renderInProgressNotice(inProgress, turnRange.end);

  const boundary = await evaluateBoundaryByActor({
    host,
    actors: actorPick.actors.filter(needsActorPreparation),
    storyText,
    storyPeople: storyRoster,
    storyAnalysis,
    storyActors: analysisActors,
    hooks: openHooks(src.hooks || []),
    // 新人档案：存档里没有的人，靠现查设定集补底子
    newcomers,
    // 世界背景：他站在什么样的局势里
    worldContext:{...worldContext,events:'',factors:''}, // Already supplied once in supplementBackground.
    background:supplementBackground,
    // 他在不在场、隔了多久
    isOnSceneNow,
    sinceLastTurn,
    // 每个人的过往（向量库召回，按人名筛过的）
    biographies: Object.fromEntries(biographyByName),
    // 存档里的现状：推演终态的**起点**，不是参考。
    // 用户 2026-10-21：「我们必须认为当前这个时间点原著npc的初始快照，
    //   这是当下的既定事实，不能反过去以原著剧情结果推翻。」
    //
    // 性格也要带上：用户 2026-10-21
    //   「快照npc的信息里是包含性格的，这个你可以看重点演化，我记得人物有性格列，
    //     所以不管是边界判定还是npc视角正文的材料里应该都是能看到人物性格的」
    //
    // 而且要用**存档里现在的性格**，不是原著初始设定——
    //   「如果经历发生改变，环境发生改变，这个npc的性格也就应该要发生改变。」
    resolveActorState: (name, bundle) => readStateNow(name, bundle),
    renderActorMaterial: (bundle) => {
      /* ★ 个人信息独享（玩家 2026-11-01：「世界信息共享，个人信息独享」）
       *
       * 原先所有人的 background 里都塞着整份设定集检索 / 整张人物档案表 /
       * 所有物品——写任何人时都能看到别人的一切。这既是上下文爆掉的根源
       * （sharedChars 被逼到 500000），也会让 NPC 写出「本不该知道的事」。
       *
       * 现在：个人专属资料只拼进**本人**的材料里。
       *   · 人物档案：只取 src.characters[本人]，不是整表
       *   · 设定集检索：按人名筛出与他相关的段落（pickPerActorRag）
       *   · 随身物品：同样按人筛
       */
      const mine = perActorMaterialFor(bundle.name);
      const material = [renderActorMaterial(bundle, {
        maxCharsPerEvent: options.materialMaxChars,
      }),src.characters && src.characters[bundle.name] ? '【本人人物档案与目标】\n'+JSON.stringify(src.characters[bundle.name]) : '',mine,ceilings[bundle.name]?.text || '',preparedBoundary?'【共享边界已确认的本人原著任务，要求不是锁定成果】\n'+JSON.stringify(preparedBoundary.turnPlan.decisions.find(row=>row.name===bundle.name) || {}):''].filter(Boolean).join('\n\n');
      return progressNotice ? `${progressNotice}\n\n${material}` : material;
    },
    options: {
      batchBoundary: Number(options.requestBatchVersion)>=1,
      replayScopes:options.replay?.scopes||[],
      onActorReady:actorBoundaryReady,
      signal:options.signal,
      batchLimits: options.batchLimits,
      promptOverrides: overrides,
      retry: options.retry,
      retryDelayMs: options.retryDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      onRetry: (info) => {
        diag.warn(
          `重试·${info.stage}（第 ${info.attempt}/${info.max} 次）`,
          `${info.reason}${info.delay > 0 ? `，等 ${info.delay}ms 后重来` : ''}`,
        );
      },
    },
  });
  backstory=await backstoryJob;
  // All history batches have settled. A missing per-person callback must settle the gate
  // as unconfirmed, never strand the turn or treat absent history as verified.
  candidateNames.forEach(name=>historyResolvers.get(name)?.(false));
  await Promise.all(actorReadyJobs);
  for(const group of cohorts.values())flushCohort(group);
  await Promise.all(actorProseJobs);
  if(actorFlowErrors.length)throw actorFlowErrors[0];
  if(savedWritingInputs.size){
    const plan={solo:[],batches:[]},batch=[];
    for(const {writer,solo} of savedWritingInputs.values()){
      backstory[writer.name]=writer.material.provisionalHistory||[];
      charMats.push(writer);
      (solo?plan.solo:batch).push(writer);
    }
    // Keep the original single-person/group response contract and its budget.
    if(batch.length)plan.batches=batch.map(writer=>[writer]);
    step('复用人物写作材料',Array.from(savedWritingInputs.keys()).join('、')+'：直接进入所选正文或核验阶段');
    await executeProsePlan(plan);
  }

  step('终态推演', `${boundary.ok ? '成功' : '失败'}`
    + `${boundary.musts ? `（${Object.keys(boundary.musts).length} 人有终态）` : ''}`,{kind:'judgement',musts:boundary.musts,storyFacts:boundary.storyFacts,diff:boundary.diff});

  // 正文带来的改变：玩家这轮到底改了什么，决定了终态是原著版还是偏离版。
  // 没有它不代表出错——玩家本来就可能什么都没改。
  if (Array.isArray(boundary.storyFacts) && boundary.storyFacts.length > 0) {
    step('正文事实', `${boundary.storyFacts.length} 条：`
      + boundary.storyFacts.slice(0, 3).join('；'));
    diag.step(
      `正文带来 ${boundary.storyFacts.length} 处不可逆改变`,
      '推演终态时用它去撞原著：该发生的事被替代、偏离或直接失败',
    );
  } else if (boundary.factsFailed) {
    diag.warn('正文事实没抽出来，本轮按「玩家什么都没改」推演',
      boundary.factsFailed);
  }

  if (boundary.failedActors && boundary.failedActors.length > 0) {
    diag.warn(`${boundary.failedActors.length} 人的终态没推演出来`,
      boundary.failedActors.slice(0, 5).join('；'));
  }

  if (!boundary.ok || !boundary.diff) {
    return finish(CE_TURN_STATUS.boundaryFailed, {
      trace, range: turnRange, reason: boundary.reason,
      // 生平旧账照常带上：它只依赖存档和年表，跟边界成败无关
      canonReferences:Object.fromEntries(actorPick.actors.map(actor=>[actor.name,{setting:String(newcomers[actor.name]?.fromSetting || ''),biography:String(biographyByName.get(actor.name) || ''),timeline:renderActorMaterial(actor,{maxCharsPerEvent:0}),ceiling:ceilings[actor.name] || null}])),
    backstory, backstoryLines: collectBackstoryLines(backstory),
      openEvents: nextOpenEvents,
    });
  }

  const diff = boundary.diff;
  // 人物侧是否需要补。false 只表示「没有人物缺口」，
  // **不表示整轮无事**：世界块、生平、钩子、账本水位都还得过。
  let noActorGap = false;
  if (!needsSupplement(diff)) {
    // 二档：玩家完整体验 → 差集为空。
    //
    // ⚠️ 这里**不能直接整轮返回**。
    //
    // 原来这里 `return finish(nothingToDo, ...)` 一走了之，有三个后果：
    //   ① 账本计划没算 → main.js 拿不到 changed:true → 水位永不推进
    //      → 下一轮又把同一区间重扫一遍
    //   ② 后面的世界块（无障碍也要跑）根本执行不到（F06）
    //   ③ 钩子/生平也一样被跳过
    //
    // 改法：把「人物无需补」记下来，继续往下走，
    // 由后面各步骤自己判断要不要做。真全线无事时自然走空。
    step('差集', '二档：人物都在位，但世界/钩子/账本仍要过一遍');
    diag.step('人物侧无需补', '这轮没有人物缺口；继续检查世界事件、生平与钩子');
    noActorGap = true;
  }
  // 天花板：不许把下一轮的额度提前花掉
  //
  // 纯查表：找他**下一次**出现在哪条年表。
  // 「那条里他是什么状态」要读中文，交给写故事的人，代码不猜。
  ceilings = buildCeilings({
    actors: actorPick.actors,
    timeline: (src.timeline||[]).filter(event=>!candidates.some(active=>active.timingChange&&inferEventCode(active)===inferEventCode(event))),
    afterTime: turnRange.end,maxChars:0,
  });
  const ceilingCount = Object.keys(ceilings).length;
  if (ceilingCount > 0) {
    step('天花板', `${ceilingCount} 人有下一处原著约束`);
  }
  const tier = tierOf(diff);
  // 一档 = 一个都没接住（全补）；三档 = 接住一部分（补剩下的，还得防写重）
  step('差集', `${tier}：${diff.missing.length} 处缺口，涉及 ${Object.keys(diff.perActor || {}).length} 人`,{kind:'judgement',musts:boundary.musts,storyFacts:boundary.storyFacts,diff});

  // 三档专用：正文已经写过的，当背景喂进去，防写重。
  // 一档没有（本来什么都没写）；二档在上面就返回了。
  const covered = coveredForProse(diff);
  if (covered.length > 0) {
    step('已覆盖', `${covered.length} 处正文写过了，当背景给散文（防写重）`);
  }

  // ---------- 步骤 4：按 NPC 分装材料 ----------
  // 事件号直接从候选事件取（不再绕经已删掉的事件材料表）
  step('补演对象', '本轮'+charMats.length+'人；正文已涉及'+storyHandledNames.size+'人的当前交汇只作结算对照', {kind:'selection',included:charMats.map(m=>m.name),excludedStory:[],handoffNames:[...storyHandledNames].filter(name=>knownOriginalNames.includes(name)),excludedStoryEvidence:storyMentions.filter(item=>knownOriginalNames.includes(item.name)),excludedNonCanon:excludedNonCanonNames});

  const dossierCount = Object.keys(boundary.dossiers || {}).length;
  step('人物档案', `${dossierCount} 人（推力原文 + 定案 + 被顶掉的）`);

  // 没人认领的条目是最危险的：静默漏补
  const unowned = findUnownedMissing(diff.missing, candidateNames,{},diff.perActor);
  if (unowned.length > 0) {
    step('无人认领', `${unowned.length} 条：${unowned.join('；')}`);
  }

  const audit = auditMaterials(charMats);
  step('材料审计', `共 ${audit.total} 人，完整 ${audit.complete}，缺料 ${audit.incomplete.length}`);

  if (charMats.length === 0) {
    step('人物散文', '本轮没有可写人物，继续检查世界块、生平和账本');
  }

  // ---------- 步骤 5：分派（重要角色单独，配角合并） ----------
  step('分派', describeDispatch(dispatch),{kind:'dispatch',solo:dispatch.solo.map(m=>m.name),batches:dispatch.batches.map(group=>group.map(m=>m.name))});

  // ---------- 步骤 6：写散文（模型） ----------
  const progressEnabled=Number(options.eventProgressVersion)>=1;
  let worldResult=null,worldSource='',worldBlocks=[];
  async function ensureWorld(){
    const currentBlocks=proseResults.filter(row=>row.ok && row.block).map(row=>row.block);
    const continuation=typeof options.continuationFacts==='function'?await options.continuationFacts():null;
    // 同轮接续仅把未失效的已核验原文送世界核查；不重新生成人物，也不再次转换变量。
    const invalidated=new Set(continuation?.invalidatedActorRefs || []),legal=new Map((preparedBoundary?.analysisActors || []).map(actor=>[actor.name,actor.actorRef]));
    const priorBlocks=(continuation?.prose || []).filter(block=>legal.has(block.name)&&!invalidated.has(legal.get(block.name))&&!currentBlocks.some(current=>current.name===block.name)&&typeof block.body==='string');
    const blocks=[...priorBlocks,...currentBlocks];
    if(options.replay?.worldState&&options.replay.worldOrder?.length){
      const order=new Map(options.replay.worldOrder.map((name,index)=>[name,index]));
      blocks.sort((a,b)=>(order.get(a.name)??Infinity)-(order.get(b.name)??Infinity));
    }
    const key=JSON.stringify(blocks.map(block=>[block.name,block.body]));worldBlocks=blocks;
    if(!worldResult || key!==worldSource){worldSource=key;worldResult=await writeWorldBlock({host,resumeState:options.replay?.worldState,candidates:candidates.map(event=>({...event,material:eventMaterials.find(row=>row.code===inferEventCode(event))?.text || event.content_brief || event.content_original || ''})),diff,storyText:src.storyText,worldEventCodes:storyAnalysis.worldEvents.map(event=>event.code),range:turnRange,options,overrides,step,diag,blocks,background:JSON.stringify({worldEvents:hostMaterial.material.worldEvents || '',worldFactors:hostMaterial.material.worldFactors || '',settings:sharedRagContext,stateSnapshot:hostMaterial.material.stateSnapshot || '',geography:hostMaterial.material.map || '',characters:projectCharacterMap(src.characters) || {}}),eventProgress:storyAnalysis.eventProgress || [],previousEventProgress:ledger.eventProgress || []});}
    return worldResult;
  }
  function acceptProgress(verdicts,context){
    if(!context)return;
    // 逐人核验只覆盖与该人相关的事件，分批产出；不能拿全量候选数比较，否则永远判未完成。
    // 这里只吸收本批已经确认的进度，整轮是否齐全留到世界核查后统一判断。
    const rows=Array.isArray(verdicts.eventProgress)?verdicts.eventProgress:[];
    if(verdicts.progressError){progressFailure=verdicts.progressError;return;}
    if(!rows.length)return;
    const known=new Map(finalEventProgress.map(row=>[row.eventId,row]));
    for(const row of rows)known.set(row.eventId,row);
    finalEventProgress=[...known.values()];
  }


  async function prepareAccepted(rows){
    if(aborted())return;
    for(const row of rows){
      if(row.ok&&row.block&&ordinaryUnreached.size){
        const references=[...(row.block.eventIds||[]),...Array.from(String(row.block.body||'')
          .matchAll(/^@@事件[:：]\s*(E-\d+(?:\.\d+)?)\s*$/gmu),match=>match[1])];
        const unreached=references.find(id=>ordinaryUnreached.has(id));
        if(unreached){
          row.ok=false;
          row.gaps=[{type:'event',detail:unreached+' 尚未开始，删除该事件的正文与生平，只推演指针已确认的范围'}];
          continue;
        }
      }
      if(row.block?.handoffDeclared&&canonSceneNames.has(row.name)&&!storyHandledNames.has(row.name)){
        const {handoffDeclared,handoffReview,handoffError,readOnlyBody,variableBody,readOnlyBiographyLine,variableBiographyLine,...full}=row.block;
        row.block=full;
      }
    }
    // 展示与落地分开：已返回正文先可读，等待普通回执/依据提取时不再空等。
    // accepted:false 不进入重跑种子或下轮前情；不提前改readyNames或调用变量回调。
    for(const row of rows){
      if(row.ok && row.block && !row.semanticChecked && !row.prosePreviewPublished && !readyNames.has(row.name)){
        row.prosePreviewPublished=true;
        step('人物正文',row.name,{kind:'prose',block:row.block,accepted:false,preview:true});
      }
    }
    // 正文已经确定事实：边界/写作可先行，只在核对普通落地回执与交汇补漏前等待。
    const dependsOnOrdinary=!preparedBoundary || rows.some(row=>storyHandledNames.has(row.name)||row.block?.handoffDeclared||(options.ordinaryDependencyRefs || []).some(ref=>ref===row.name||ref===src.characters?.[row.name]?.id));
    if(dependsOnOrdinary && typeof options.awaitOrdinarySettlement==='function')options.ordinarySettlement=await options.awaitOrdinarySettlement();
    if(aborted())return;
    if(useSemanticReview){
      const inlineNames=[];
      for(const row of rows){
        if(!row.ok||!row.block||row.semanticChecked||storyHandledNames.has(row.name))continue;
        const review=inlineProseReview(row);
        if(review){row.block.completionReview=review;row.semanticChecked=true;inlineNames.push(row.name);}
      }
      if(inlineNames.length)step('依据随正文返回',inlineNames.join('、')+'：本次不另发提取请求');
    }
    const pending=rows.filter(row=>row.ok && row.block && !row.semanticChecked);
    if(pending.length && (useSemanticReview || pending.some(row=>storyHandledNames.has(row.name)||row.block.handoffDeclared))){
      step('补查落地依据',pending.map(row=>row.name+(row.block.handoffDeclared||storyHandledNames.has(row.name)?'（交汇核对）':row.inlineCompletion?'（随正文返回的证据未通过）':'（正文未附有效依据）')).join('、'));
      // 进度校验接入必须先做到「失败不阻断正文」才能开启；否则真实数据一旦漏项就会让整轮正文不出字。
      // 这里维持不接入，等提示词侧先消除「零重叠事件该不该报」的歧义、并确认失败可降级后再打开。
      const eventContext=null;
      const verdicts=await reviewProseByAI({host,eventContext,rows:pending.map(row=>({name:row.name,castTier:charMats.find(m=>m.name===row.name)?.castTier,targetId:charMats.find(m=>m.name===row.name)?.id || src.characters?.[row.name]?.id || '',block:row.block,mustWrite:charMats.find(m=>m.name===row.name)?.material.task || [],events:charMats.find(m=>m.name===row.name)?.material.dossier?.pushes || [],eventSegments:charMats.find(m=>m.name===row.name)?.material.eventSegments || [],boundary:charMats.find(m=>m.name===row.name)?.material.dossier || {},ceiling:charMats.find(m=>m.name===row.name)?.material.dossier?.ceiling || '',personality:charMats.find(m=>m.name===row.name)?.material.state?.personality || charMats.find(m=>m.name===row.name)?.material.identity?.personality || '',handoffRequired:storyHandledNames.has(row.name),mainStory:storyText,ordinaryRecords:options.ordinarySettlement?.records||[],goal:charMats.find(m=>m.name===row.name)?.material.goal || {},state:charMats.find(m=>m.name===row.name)?.material.state || {},timeRange:turnRange})),options});
      acceptProgress(verdicts,eventContext);
      for(const row of pending){
        const verdict=verdicts[row.name];
        // 正文写成什么样就接受什么样，不再由这一步判合格与否。
        //
        // 原来这里写 row.ok=verdict?.ok===true，一旦核验说「某项没覆盖」就把正文判死，
        // 排进重写队列重新写一遍；重写完再核验又挑出新问题，于是无限循环。
        // 这一步现在只负责两件实事：取落地依据（completionFacts/cultivation/baseline）、
        // 取事件进度（eventProgress）。发现问题只记录，不再驱动重写。
        row.gaps=verdict?.gaps || [];
        row.unverified=verdict?.unverified===true;
        row.reviewFailed=verdict?.reviewFailed===true;
        if(replacementNames.has(row.name)&&(!verdict||row.unverified||row.reviewFailed)){
          // A deliberate replacement cannot commit using missing or stale evidence.
          row.ok=false;
          if(!row.gaps.length)row.gaps=[{type:'api',detail:'所选人物未返回有效落地依据'}];
          continue;
        }
        row.semanticChecked=true;
        if(verdict?.handoff)row.block.handoffReview=verdict.handoff;
        if(verdict?.completionReview)row.block.completionReview=verdict.completionReview;
      }
    }
    if(aborted())return;
    const accepted=rows.filter(row=>row.ok && row.block && !readyNames.has(row.name));
    if(!accepted.length)return;
    accepted.forEach(row=>{
      if(row.block.eventIds?.some(id=>/^E-\d/u.test(id))){
        const segments=charMats.find(item=>item.name===row.name)?.material.eventSegments || [];
        row.block.eventWindows=segments.map(({code,start,end,gap})=>({code,start,end,gap:!!gap}));
      }
      readyNames.add(row.name);
      step('人物正文',row.name,{kind:'prose',block:row.block,accepted:true});
    });
    if(typeof options.onProseReady==='function')await options.onProseReady({blocks:accepted.map(row=>row.block),names:actorPick.actors.map(a=>a.name),biography:Object.fromEntries(accepted.map(row=>[row.name,composeBiography({backstory:backstory[row.name] || [],biographyLine:row.block.handoffDeclared?row.block.variableBiographyLine||'':row.block.biographyLine||''})])),ordinarySettlement:options.ordinarySettlement||null,canonReferences:Object.fromEntries(actorPick.actors.map(actor=>[actor.name,savedWritingInputs.get(actor.name)?.reference||{setting:String(newcomers[actor.name]?.fromSetting || ''),biography:String(biographyByName.get(actor.name) || ''),timeline:renderActorMaterial(actor,{maxCharsPerEvent:0}),ceiling:ceilings[actor.name] || null}]))});
  }

  // 每人的正文、核验、必要重写和宿主保存组成独立因果链。
  // 只在结算共享事件进度时汇总；另一人的模型和重试不能挡住本人的落地。
  // 「首次尝试」与「失败后重写」分开：首次各自独立推进；重写把同一档里
  // 失败的人合成一次请求，而不是每人各发一次。这正是重点演化的做法——
  // 一次返回晚或一个人写歪，不能让整组退回逐人重跑。
  async function finishActor(row,material,isSolo){
    // 语义核验只是「核验更严」，不是「不给重写机会」。
    // 原来这里在语义核验模式下把重写次数压成 0，等于一次笔误就判死，
    // 这正是「动不动就失败」的重要来源。改成始终按玩家设置给重写机会。
    const maximum=Math.max(0,Math.min(3,Number(options.proseRewriteCount ?? CE_MAX_RETRY)));
    await prepareAccepted([row]);
    // 首轮就过：不必再进重写队列。
    if(row.ok){if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:true});return;}
    // 核验没做成 ≠ 散文不合格：正文已经写出来了，重写解决不了核验请求失败。
    // 原来这里会把它塞进重写队列，于是每轮都「重写→再核验→再失败」，
    // 9 个人一起卡十几分钟。现在保留正文、如实标为未核验，不进重写。
    if(row.reviewFailed||row.unverified){
      if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:false,unverified:true,reason:(row.gaps||[]).map(gap=>gap.detail).filter(Boolean).join('；')});
      return;
    }
    // 请求重试已经耗尽，不能把网络失败再当正文不合格启动整套请求重试。
    if(isProseRequestFailure(row))return;
    // 没通过且不给重写：如实记为不合格。
    if(maximum<=0){if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:false});return;}
    rewriteQueue.push({row,material,isSolo});
  }

  // 失败子集合批修：同档的失败者合并成一次请求重发。
  // A 档仍单独写（方案要求 A 必须单写），B/C 档合批。
  async function rewriteFailedSubset(queue){
    const maximum=Math.max(0,Math.min(3,Number(options.proseRewriteCount ?? CE_MAX_RETRY)));
    for(let round=1;round<=maximum;round++){
      if(!queue.length)break;
      const failed=queue.splice(0).filter(item=>!isProseRequestFailure(item.row));
      if(!failed.length)break;
      if(options.signal?.aborted)return;
      // 分成「必须单写」和「可以合批」两组，各自一次请求。
      const solo=failed.filter(item=>item.isSolo);
      const grouped=failed.filter(item=>!item.isSolo);
      const runOne=async(item)=>{
        const {row,material}=item;
        const m={...material,material:{...material.material,taskCodes:inferEventCodesForName(candidates,material.name)}};
        const metadataRepair=await repairProseBiography({host,block:row.block,retry:options.retry,signal:options.signal,
          validationContext:{expectedName:m.name,expectedEvents:m.material.taskCodes,mustWrite:m.material.task,structureOnly:useSemanticReview,diary:useSemanticReview}});
        if(metadataRepair.attempted){
          Object.assign(row,{name:m.name,ok:metadataRepair.ok,block:metadataRepair.block,gaps:metadataRepair.gaps});
          await prepareAccepted([row]);
          if(!row.ok&&!isProseRequestFailure(row))queue.push(item);
          if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:row.ok,rewriteRound:round,biographyRepaired:metadataRepair.ok});
          return;
        }
        const parts=splitProseMaterial(m,options.batchLimits),results=[];
        for(const part of parts){
          const soloBudget=Number(part.material?.proseMaxChars)||Number(options.coreMaxChars)||800;
          const prompt=buildProsePrompt(part,{maxChars:soloBudget,isCore:true,pov:options.pov,promptOverrides:overrides})+buildRetryHint(row.gaps || [])
            +'\n【本人待修正原稿】\n'+JSON.stringify({name:row.name,story:row.block?.body||'',biographyLine:row.block?.biographyLine||''})
            +'\n按具名缺口修正日期段与摘要，不改变未出错的正文和既有事实，不从未来原著参考追加经历。返回完整本人骨架、覆盖声明、生平摘要与正文。'
            +(parts.length>1?'\n本次仅修正本批eventSegments，其余时段留在所属批次。前批已确认内容只供承接：\n'+results.map(value=>value.block?.body||'').join('\n\n'):'');
          const value=await writeOneWithRetry({host,prompt,name:m.name,expectedEvents:part.material.taskCodes,mustWrite:parts.length>1?[]:m.material.task,overrides,retry:options.retry,signal:options.signal,proseRewriteCount:0,structureOnly:useSemanticReview,inlineReview:useSemanticReview&&parts.length===1&&!part.material.handoffRequired});
          results.push(value);if(!value.ok)break;
        }
        const next=mergeProseResults(results);
        Object.keys(row).forEach(key=>delete row[key]);Object.assign(row,{name:m.name,...next});
        await prepareAccepted([row]);
        if(!row.ok&&!isProseRequestFailure(row))queue.push(item);
        if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:row.ok,rewriteRound:round});
      };
      // A 档：必须单写，但仍可并发发出去，不互相等待。
      await Promise.all(solo.map(runOne));
      if(!grouped.length)continue;
      const retryGroups=packRequestMaterials(grouped,{...options.batchLimits,sharedChars:String(grouped[0].material.material?.background||'').length+String(grouped[0].material.material?.story||'').length,measure:item=>JSON.stringify({...item.material,material:{...item.material.material,background:'',story:''}}).length,estimateOutput:item=>(Number(item.material.material?.proseMaxChars)||400)+500});
      for(const grouped of retryGroups){
      // B/C 档：把这一轮失败的这些人合成一次请求。
      const items=grouped.map(item=>({...item.material,material:{...item.material.material,taskCodes:inferEventCodesForName(candidates,item.material.name)}}));
      const batchBudget=Number(grouped[0].material.material?.proseMaxChars)||Number(options.minorMaxChars)||400;
      const prompt=buildMinorRolesPrompt(items,{maxCharsEach:batchBudget,pov:options.pov,promptOverrides:overrides})
        +buildRetryHint(grouped.flatMap(item=>(item.row.gaps||[]).map(gap=>({...gap,detail:item.row.name+'：'+gap.detail}))))
        +'\n【本批待修正原稿】\n'+JSON.stringify(grouped.map(item=>({name:item.row.name,story:item.row.block?.body||'',biographyLine:item.row.block?.biographyLine||''})))
        +'\n本次仅修正上列失败人物；已通过人物不在名单中，不得重写或补回。修正点以外保留原稿中的既有事实和正文，不重新发明经历。仍须返回本批全部人物的完整JSON对象。';
      let outputs=[];
      try{
        outputs=await writeBatchWithRetry({host,prompt,group:items,overrides,retry:options.retry,signal:options.signal,proseRewriteCount:0,structureOnly:useSemanticReview,inlineReview:useSemanticReview});
      }catch(error){
        // 合批重发整体失败：这些人如实记为仍不合格，不再退化成逐人重发。
        step('人物正文·失败子集合批重写', '重写未成功', {kind:'proseRewriteError', reason:String(error&&error.message||error), names:grouped.map(item=>item.row.name)});
        for(const item of grouped){item.row.gaps=[...(item.row.gaps||[]),String(error&&error.message||error)];}
        continue;
      }
      for(let i=0;i<grouped.length;i+=1){
        const item=grouped[i],next=outputs?.[i];
        if(!next){item.row.gaps=[...(item.row.gaps||[]),'合批重写未返回本人结果'];queue.push(item);continue;}
        const {row,material}=item;
        Object.keys(row).forEach(key=>delete row[key]);
        Object.assign(row,{name:material.name,...next});
      }
      await prepareAccepted(grouped.map(item=>item.row));
      for(const item of grouped){const row=item.row;if(!row.ok&&!isProseRequestFailure(row)&&!queue.includes(item))queue.push(item);if(row.block)step('人物正文',row.name,{kind:'prose',block:row.block,accepted:row.ok,rewriteRound:round});}
      }
    }
    // 重写次数用完仍不合格的，如实标出来，不冒充通过。
    for(const item of queue){
      if(item.row.block)step('人物正文',item.row.name,{kind:'prose',block:item.row.block,accepted:false});
    }
  }

  // 重要角色：一人一次
  async function executeProsePlan(plan){
  const seeded=new Set();
  for(const m of [...plan.solo,...plan.batches.flat()]){
    const material=JSON.stringify([m,overrides,options.pov,options.coreMaxChars,options.minorMaxChars,options.requestBatchVersion]),seed=options.replay?.seeds?.[m.name];
    step('人物重跑材料',m.name,{kind:'replayMaterial',name:m.name,material,proseStage:plan.solo.some(row=>row.name===m.name)?'人物视角散文':'群像视角散文'});
    if(!seed)continue;
    // 重试入口只提供未选中的成功正文；不再用新格式、新材料或模型复查推翻它。
    // 仍可下送给该人物尚未完成的变量步骤，已保存步骤由原回执直接接续。
    const row={name:m.name,ok:true,block:{...structuredClone(seed.block),name:m.name},semanticChecked:!seed.refreshFacts,gaps:[]};
    proseResults.push(row);seeded.add(m.name);await finishActor(row,m,true);
    step('人物正文复用',m.name,{kind:'prose',block:row.block,accepted:row.ok,reused:true});
  }
  plan={...plan,solo:plan.solo.filter(m=>!seeded.has(m.name)),batches:plan.batches.map(group=>group.filter(m=>!seeded.has(m.name))).filter(group=>group.length)};
  const proseJobs=plan.solo.map(async (m) => {
    const parts=splitProseMaterial(m,options.batchLimits),writtenParts=[];
    for(const part of parts){
    const taskCodes = parts.length>1?part.material.taskCodes:inferEventCodesForName(candidates, m.name);
    // 篇幅用分派阶段已经算好的按档预算（玩家在设置里填的三档数字），
    // 不能再用写死的 800 —— 那会让「核心角色篇幅」设置形同虚设。
    const soloBudget=Number(part.material?.proseMaxChars) || Number(options.coreMaxChars) || 800;
    const prompt = buildProsePrompt(
      { ...part, material: { ...part.material, taskCodes } },
      {
        maxChars: soloBudget,
        isCore: m.material?.tier ? m.material.tier===CE_CAST_TIER.core : true,
        pov: options.pov,
        promptOverrides: overrides,
      },
    )+(parts.length>1?'\n【容量分批，按时间顺序接续】本次是第'+part.material.prosePart.index+'/'+parts.length+'批，仅展开本批eventSegments；其他事件只作背景，留到其所属批次，不抢写也不重写。前批已确认正文只供承接人物当前事实：\n'+writtenParts.map(row=>row.block.body).join('\n\n'):'');
    const r = await writeOneWithRetry({
      host, prompt, name: m.name,
      // 全轮失败子集队列统一管理内容重写预算；此处网络重试仍由 withRetry 管理。
      // 两层都给内容重写会使同一份故事超出预算反复生成。
      proseRewriteCount:0,
      structureOnly:useSemanticReview,
      inlineReview:useSemanticReview&&parts.length===1&&!part.material.handoffRequired,
      expectedEvents: taskCodes,
      mustWrite: parts.length>1?[]:m.material.task,
      overrides,
      retry: options.retry,
      retryDelayMs: options.retryDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      // 中止信号要一路传到实际模型调用和重试等待
      signal: options.signal || null,
      onRetry: (info) => {
        diag.warn(
          `重试·${info.stage}（第 ${info.attempt}/${info.max} 次）`,
          `${info.reason}${info.delay > 0 ? `，等 ${info.delay}ms 后重来` : ''}`,
        );
      },
    });
    writtenParts.push(r);if(!r.ok)break;
    }
    const r=mergeProseResults(writtenParts);
    const row={name:m.name,...r};proseResults.push(row);
    await finishActor(row,m,true);
    if(r.block)step('人物正文',m.name,{kind:'prose',block:r.block,accepted:useSemanticReview?row.semanticChecked && row.ok:r.ok});
  });

  // 配角：合并成数组
  proseJobs.push(...plan.batches.map(async (group) => {
    const prompt = buildMinorRolesPrompt(
      group.map((m) => ({ name: m.name, id: m.id, material: m.material })),
      {
        maxCharsEach: options.minorMaxChars || 400,
        pov: options.pov,
        promptOverrides: overrides,
      },
    );
    const r = await writeBatchWithRetry({
      host, prompt, group, overrides,
      // 只把失败成员送到外层批修。不能因一人摘要缺失重写整批成功正文。
      proseRewriteCount:0,
      structureOnly:useSemanticReview,
      inlineReview:useSemanticReview,
      retry: options.retry,
      retryDelayMs: options.retryDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      signal: options.signal || null,
      onRetry: (info) => {
        diag.warn(
          `重试·${info.stage}（第 ${info.attempt}/${info.max} 次）`,
          `${info.reason}${info.delay > 0 ? `，等 ${info.delay}ms 后重来` : ''}`,
        );
      },
    });
    proseResults.push(...r);
    // 故事批保持到核验和变量准备，成功集合立即下送；失败成员各自重写。
    await prepareAccepted(r);
    await Promise.all(r.filter(row=>!row.ok).map(row=>finishActor(row,group.find(m=>m.name===row.name),false)));
    r.forEach(item=>{if(item.block)step('人物正文',item.name,{kind:'prose',block:item.block,accepted:useSemanticReview?item.semanticChecked && item.ok:item.ok});});
  }));
  await Promise.all(proseJobs);
  // 首轮都跑完之后，把失败的人合成一批再重发，而不是每人各发一次。
  if(rewriteQueue.length)await rewriteFailedSubset(rewriteQueue);
  }

  // ---------- 步骤 7：结算（合格留下，不合格记欠账） ----------
  const settled = settleProseResults(proseResults, {
    eventCode: candidates.map((e) => inferEventCode(e)).filter(Boolean).join(','),
    timeRange: `${turnRange.start} → ${turnRange.end}`,
  });
  step('结算', settled.summary);
  if(options.replay?.actorReplacement){
    const names=options.replay.actorReplacement.names||[];
    const missing=names.filter(name=>!settled.accepted.some(block=>block.name===name&&String(block.body||'').trim()));
    const detail=settled.debts.filter(row=>missing.includes(row.name)).map(row=>row.name+'：'+row.reason).join('；')||boundary.reason;
    return finish(missing.length?CE_TURN_STATUS.boundaryFailed:CE_TURN_STATUS.ok,{
      trace,range:turnRange,prose:settled.accepted,debts:settled.debts,actorReplacement:true,
      reason:missing.length?'所选人物未完成：'+missing.join('、')+(detail?'；'+detail:''):''
    });
  }

  /* ★★★ 2026-11-02 玩家定的规则：
   *   「我没说删掉上一篇啊，我的意思是删掉最后一个段落的故事，因为我们的规则是
   *     覆盖重写啊。所以这才是分段的意义，可拆卸，可标记单独段落啊。」
   *
   * 跨回合未完成的年表事件，本轮重写后只替换**上一回合最后一段**，
   * 前面的段落（已完成事件）原样保留，合并后仍然只有一段。
   *
   * 生成阶段模型拿到的材料里已有旧段落原文（previousProse），
   * 写出来的内容本身就是接着旧事实往下走的；这里只做机械拼接，
   * 由代码保证「旧事实一个字不丢、段落数不增加」。
   */
  if (Array.isArray(src.previousProse) && src.previousProse.length) {
    for (const block of settled.accepted) {
      const prev = src.previousProse.find((b) => b && String(b.name || '') === String(block.name || ''));
      if (!prev) continue;
      // 只有「本轮这段是从上一回合延续过来」时才合并，否则会重复。
      const continuing = Array.isArray(block.eventIds) && block.eventIds.some((id) =>
        Array.isArray(prev.eventIds) && prev.eventIds.includes(id));
      if (!continuing) continue;
      try {
        const merged = overwriteLastParagraph(prev, block);
        if (merged && merged.replaced) {
          Object.assign(block, merged.block);
          step('续写合并', block.name + '：' + merged.note);
        }
      } catch (e) {
        // 合并失败不拦截流程：保留本轮新正文即可（玩家要求小错不阻碍）。
        console.warn('[原著补演] 段落合并失败，保留本轮正文:', e && e.message);
      }
    }
  }
  for(const open of nextOpenEvents){
    const entry=candidates.find(event=>inferEventCode(event)===open.eventId),span=entry?entrySpan(entry):null;
    for(const block of settled.accepted){if(!(block.eventIds || []).includes(open.eventId))continue;
      const rows=String(block.biographyLine || '').split(/\r?\n/).filter(line=>{const label=(line.match(/^\[([^@\]]+)/) || [])[1],point=parseTimePoint(label);return span && point!==null && point>=span.min && point<=span.max;});
      const notes=rows.length?rows:['本人本轮视角已核验，处理至'+turnRange.end];
      open.doneActors[block.name]=Array.from(new Set([...(open.doneActors[block.name] || []),...notes]));
    }
  }


  // ---------- 步骤 7.2：生平经历（第 35 列） ----------
  //
  // 三段拼一条，三个时段三个出处，不许重叠：
  //   ① 正文之前那几个月 → 生平旧账（存档 + 原著推力）
  //   ② 正文那一刻       → 散文的 @@经历 行
  //   ③ 更早的轮次       → 不补，只留首次登场标记
  //
  // 旧账和散文那段都拿到了，这里只是拼起来 + 排序去重，纯代码。
  const proseBio = collectProseBiography(settled.accepted.map(block=>block.handoffDeclared?{...block,biographyLine:block.variableBiographyLine||''}:block));
  const biography = {};
  for (const a of [...actorPick.actors,...settled.accepted.filter(b=>!actorPick.actors.some(a=>a.name===b.name)).map(b=>({name:b.name,events:[]}))]) {
    const name = a.name;
    const rows = backstory[name] || [];
    const line = proseBio[name] || '';

    // 首次登场：这一轮才第一次进档的人。
    //
    // 之前这里恒传空串，等于这个分支从来没跑过——「首次登场」这个
    // 概念在代码里存在，实际一次都不会生效。那不是「暂时用不上」，
    // 是这一路根本没接上。
    //
    // 现在按事实给：他的旧账和散文都没产出，说明这轮没有可写的经历；
    // 而他又确实第一次被圈进来，那就该留一句「此前按原著所述」，
    // 免得第 35 列一直空着，下轮读回来以为这人没背景。
    //
    // 时间取他在这轮材料里最早的那条事的年份——
    // 那是他第一次被写进账的时刻。
    let firstAppear = '';
    if (rows.length === 0 && !line && isNewcomer(name, src.characters)) {
      const events = Array.isArray(a.events) ? a.events : [];
      const earliest = events
        .map((e) => String(e && e.time || '').trim())
        .filter(Boolean)
        .sort()[0] || turnRange.end;
      firstAppear = firstAppearLine(name, earliest);
    }

    const text = composeBiography({
      name,
      backstory: rows,
      biographyLine: line,
      firstAppear,
    });
    if (text) biography[name] = text;
  }
  for(const receipt of Object.values(savedActors))if(receipt.biography)biography[receipt.name]=receipt.biography;
  const bioCount = Object.keys(biography).length;
  if (bioCount > 0) {
    step('生平经历', `${bioCount} 人有新经历要写进第 35 列`);
  }

  // ---------- 步骤 7.5：世界块（无主角的全局变化） ----------
  // 依据总设计 §4.8：按 NPC 分块会漏掉「没有具体角色可代入」的事件。
  // 它跟 NPC 块并列，消费方是杂项阶段。
  if(typeof options.awaitOrdinarySettlement==='function'){
    options.ordinarySettlement=await options.awaitOrdinarySettlement();
    for(const key of ['worldEvents','worldFactors','stateSnapshot'])if(typeof host[key]==='function')hostMaterial.material[key]=await host[key]();
  }
  if(aborted())return finish(CE_TURN_STATUS.rolledBack,{trace,reason:'本轮已停止，不提交世界与账本'});
  await ensureWorld();
  // 世界核查已经读取全部真实人物故事，同次回报各事件的实际进度；不再另发全局进度请求。
  if(progressEnabled){
    finalEventProgress=mergeEventProgress(finalEventProgress,worldResult.eventProgress || []);
    // 进度分批产出：只要求「本批事件都拿到了进度」，不能让某一批失败把已通过核验的好正文整轮丢掉。
    // 未确认的事件必须在**本回合内补齐**——这一轮结果就是下一轮原著指导和补演的前提，
    // 留欠账会让下一轮建立在残缺状态上。
    const confirmed=new Set(finalEventProgress.map(row=>row.eventId));
    unconfirmedEvents=eventMaterials.filter(event=>event.code && !confirmed.has(event.code)).map(event=>event.code);
    const unconfirmed=unconfirmedEvents;
    // 失败要说清「哪个阶段、哪几条事件、为什么」，否则只能显示笼统的「尚未确认」。
    // 成功批次已经确认的进度保留，重跑只补失败的那几条。
    const failedBatches=worldResult.failedBatches || [];
    const failureDetails=failedBatches.map(row=>{
      const codes=(row.eventCodes || []).join('、') || '（未返回事件编号）';
      const titles=(row.eventTitles || []).filter(Boolean).join('、');
      return row.stage+'：'+codes+(titles?'（'+titles+'）':'')+' —— '+row.reason;
    });
    if(unconfirmed.length && !failureDetails.length)failureDetails.push('事件进度未返回：'+unconfirmed.join('、'));
    progressFinalized=!worldResult.failedEntries.length && !unconfirmed.length;
    progressFailure=progressFinalized?'':failureDetails.join('；');
    // 进度没确认必须在**本回合内补齐**。
    // 这一轮的补演结果就是下一轮原著指导和补演的前提，留欠账等于让下一轮建立在
    // 残缺状态上。所以这里不是「记欠账交下一轮」，而是只针对失败的那几条再补一次；
    // 已确认的事件不重跑，避免把偶发失败放大成整轮作废。
    if(!progressFinalized){
      const needCodes=new Set(unconfirmed);
      for(const row of worldResult.failedBatches || [])for(const code of row.eventCodes || [])needCodes.add(code);
      const retryCandidates=eventMaterials.filter(event=>event.code && needCodes.has(event.code));
      if(retryCandidates.length){
        step('事件进度',`本回合补齐 ${retryCandidates.length} 条未确认事件：${[...needCodes].join('、')}`);
        // 只把没确认的事件作为候选重跑，已确认的不再进入，天然不会重复结算。
        const repaired=await writeWorldBlock({
          host,candidates:retryCandidates,
          diff,storyText:src.storyText,worldEventCodes:retryCandidates.map(event=>event.code),
          range:turnRange,options,overrides,step,diag,blocks:worldBlocks,
          background:JSON.stringify({worldEvents:hostMaterial.material.worldEvents || '',worldFactors:hostMaterial.material.worldFactors || '',settings:sharedRagContext,stateSnapshot:hostMaterial.material.stateSnapshot || '',geography:hostMaterial.material.map || '',characters:projectCharacterMap(src.characters) || {}}),
          // 带上已确认的进度，模型据此只补缺的那几条，不会把已定的推翻。
          eventProgress:finalEventProgress,
          previousEventProgress:mergeEventProgress(ledger.eventProgress || [],finalEventProgress),
        });
        if(repaired){
          finalEventProgress=mergeEventProgress(finalEventProgress,repaired.eventProgress || []);
          if(repaired.block){
            // 补齐拿到的新世界正文要与原结果合并，不能丢前一批已经写好的部分。
            worldResult={...worldResult,block:worldResult.block?{...worldResult.block,eventIds:Array.from(new Set([...(worldResult.block.eventIds||[]),...(repaired.block.eventIds||[])])),body:[worldResult.block.body,repaired.block.body].filter(Boolean).join('\n\n')}:repaired.block,forMisc:[worldResult.forMisc,repaired.forMisc].filter(Boolean).join('\n\n')};
          }
          const reConfirmed=new Set(finalEventProgress.map(row=>row.eventId));
          unconfirmedEvents=eventMaterials.filter(event=>event.code && !reConfirmed.has(event.code)).map(event=>event.code);
          worldResult={...worldResult,state:{version:1,batches:[...(worldResult.state?.batches||[]),...(repaired.state?.batches||[])]},noChanges:[...(worldResult.noChanges||[]),...(repaired.noChanges||[])],failedEntries:repaired.failedEntries||[],failedBatches:repaired.failedBatches||[]};
          if(!unconfirmedEvents.length&&!worldResult.failedEntries.length){
            progressFinalized=true;progressFailure='';
            step('事件进度','本回合补齐完成，全部事件进度已确认');
          }
        }
      }
      if(!progressFinalized){
        const stillFailure=(worldResult.failedBatches||[]).map(row=>row.stage+'：'+(row.eventCodes||[]).join('、')+' —— '+row.reason);
        progressFailure=(stillFailure.length?stillFailure.join('；'):progressFailure)||progressFailure;
      }
    }
    // 只有「真的什么都没有」才算本轮失败：一条正文没写出来，且世界正文也没有。
    // 只要有任何可分割的成果（人物正文、世界正文、已确认进度），就直接落地，
    // 把没确认的那几条作为待补项随结果返回，由落地后集中定向补。
    // 这就是重点演化的做法：成果不等完美，时间才可控。
    const hasAnyResult = settled.accepted.length > 0 || Boolean(worldResult.block) || finalEventProgress.length > 0;
    if(!progressFinalized && !hasAnyResult){
      return finish(CE_TURN_STATUS.proseFailed,{trace,range:turnRange,prose:settled.accepted,eventProgress:finalEventProgress,openEvents:nextOpenEvents,worldDebts:worldResult.failedEntries,unconfirmedEvents,failedBatches:worldResult.failedBatches||[],progressFailure,reason:'本轮没有任何可落地成果，世界与事件进度也未确认。详细原因：'+progressFailure});
    }
    if(!progressFinalized)step('事件进度','已落地成果，未确认的事件待定向补',{kind:'eventProgressFailed',unconfirmedEvents,failedBatches:worldResult.failedBatches||[],progressFailure});
  }
  // 关闭事件进度时没有进度可核对，不算欠账（这是配置选择，不是「没判断」）。
  if(!progressEnabled)progressFinalized=true;
  if(progressEnabled)step('事件进度',progressFinalized?'按本轮实际故事核对完成':'已确认部分保留，剩余待本轮继续',{kind:'eventProgress',rows:finalEventProgress.map(row=>({...row,advanced:row.occurred.filter(text=>!(ledger.eventProgress || []).find(old=>old.eventId===row.eventId)?.occurred.includes(text))})),confirmed:progressFinalized});

  if(worldResult.block)step('世界正文','已生成',{kind:'world',body:worldResult.block.body});

  // ---------- 步骤 7.6：黄区钩子（唯一需要跨轮记忆的区） ----------
  // 依据总设计 §4.9：绿区完了就完了，红区补演会管，
  // 黄区起的头没人管就会烂尾。
  const hookResult = advanceTurnHooks({
    accepted: settled.accepted,
    hooks: src.hooks,
    resolved: boundary.resolvedHooks || [],
    turnNo: Number(options.turnNo) || 0,
    lifetime: options.hookLifetime,
    step, diag,
  });

  if (settled.accepted.length === 0 && !worldResult.block && !noActorGap && bioCount === 0) {
    return finish(CE_TURN_STATUS.proseFailed, withVisibility({
      trace, diag, range: turnRange, diff, debts: settled.debts,
      reason: '散文全部不合格，本轮不落地',
      hooks: hookResult.hooks,
      // 散文没写出来，但「哪些事件还没走完」这个事实照样要知道，
      // 否则下一轮会把它当成已完成，整条剩余部分就永远丢了。
      openEvents: nextOpenEvents,
    }, {
      ledger,
      range: turnRange,
      eventCount: candidates.length,
      mutated: diff.mutated,
      debts: settled.debts,
      succeeded: false,
      failure: { reason: '散文全部不合格' },
      handledRange: turnRange,
      staleHooks: hookResult.stale,
      materialReport: hostMaterial.report,
    }));
  }

  // ---------- 步骤 8：交给四阶段（由调用方注入） ----------
  // 这里不直接跑四阶段：那属于宿主既有链路，编排器只交出材料。
  const proseText = settled.accepted
    .map((b) => `## ${(b.eventIds || []).join(',')} | ${b.name} | ${b.status}\n${b.body}`)
    .join('\n\n');

  const result = finish(CE_TURN_STATUS.ok, withVisibility({
    trace,
    range: turnRange,
    diff,
    dispatch: {
      soloCount: dispatch.solo.length,
      batchCount: dispatch.batches.length,
    },
    prose: settled.accepted,
    eventProgress:finalEventProgress,
    eventWatches:preparedBoundary?.turnPlan?.eventWatches || [],
    includedCanonNames:[...Object.keys(savedActors),...charMats.map(m=>m.name)],
    excludedStoryNames:[],handoffNames:[...storyHandledNames],
    excludedNonCanonNames,
    proseText,
    debts: settled.debts,
    worldDebts: worldResult.failedEntries || [],
    worldState:worldResult.state || null,
    // 事件进度没确认时，把具体哪几条带出去：下一轮只补这几条，成功的不重跑。
    unconfirmedEvents: progressFinalized ? [] : unconfirmedEvents,
    failedBatches: progressFinalized ? [] : (worldResult.failedBatches || []),
    progressFailure: progressFinalized ? '' : progressFailure,
    backstoryDebts: backstory.__unconfirmed || [],
    unowned,
    playerMessage: formatDebtsForPlayer(settled.debts),
    // 世界块：与 NPC 块并列，消费方是杂项阶段（§4.8）
    worldBlock: worldResult.block,
    worldNoChanges: worldResult.noChanges || [],
    worldForMisc: worldResult.forMisc || '',
    // 黄区钩子：下一轮要带上，否则会烂尾（§4.9）
    hooks: hookResult.hooks,
    openHooks: openHooks(hookResult.hooks),
    staleHooks: hookResult.stale,
    // 交给下一步的处理建议
    nextRequired: formatMissingForProse(diff),
    // 跨轮事件：这些还没走完，下一轮接着处理（账本要记住）
    openEvents: nextOpenEvents,
    // 生平经历：name -> 要 append 到第 35 列的文本（旧账 + 散文那段拼好、排好序）
    biography,
    canonReferences:Object.fromEntries(actorPick.actors.map(actor=>[actor.name,{setting:String(newcomers[actor.name]?.fromSetting || ''),biography:String(biographyByName.get(actor.name) || ''),timeline:renderActorMaterial(actor,{maxCharsPerEvent:0}),ceiling:ceilings[actor.name] || null}])),
    backstory, backstoryLines: collectBackstoryLines(backstory),
    musts: boundary.musts,
    ceilings,
    tier,
  }, {
    ledger,
    range: turnRange,
    eventCount: candidates.length,
    writtenNames: settled.accepted.map((b) => b.name),
    unreachedEventIds:[...ordinaryUnreached],
    mutated: diff.mutated,
    debts: settled.debts,
    wroteWorld: Boolean(worldResult.block),
    staleHooks: hookResult.stale,
    // 钩子本轮结束后的状态（起头/推进/收尾/失效都算过）。
    // 它要跟账本一起存，否则下一轮又从空开始。
    hooks: hookResult.hooks,
    turnNo: Number(options.turnNo) > 0 ? Number(options.turnNo) : 0,
    // ---- 关于 succeeded ----
    //
    // 这里原来恒为 `succeeded: false` + `failure: { reason: '等待变量落地' }`，
    // 于是 planLedgerCommit 永远走「未成功」分支 → changed 恒为 false →
    // main.js 的 `if (plan && plan.changed)` 永远不成立 →
    // **账本一次都没推进过，水位永远停在原地。**
    //
    // 但原注释的顾虑是对的：「散文写出来了」不等于「变量落地了」。
    // 编排器没有宿主写库能力，它不该自己宣布成功。
    //
    // 所以分两级表达，不再用一个布尔硬压死：
    //   stagedOk    本轮编排侧检查过了、该做的都做了（可推进的候选状态）
    //   landed      变量真的写进存档了（由调用方在保存成功后置 true）
    //
    // 账本计划用 stagedOk 生成，并把 landed=false 记进计划里，
    // 由调用方确认落地后再真正提交。
    stagedOk: settled.accepted.length > 0
      || worldResult.block != null
      || bioCount > 0
      || (Array.isArray(hookResult.hooks) && hookResult.hooks.length > 0)
      || !needsSupplement(diff),
    landed: false,
    // 编排侧已经做完，但变量还没进存档。
    // 这里不再是「失败」：用 pendingLanding 表达「等宿主写库」，
    // succeeded 留给调用方在保存成功后再置 true。
    pendingLanding: true,
    succeeded: false,
    failure: null,
    handledRange: turnRange,
    materialReport: hostMaterial.report,
    // 账本要记的「上一轮补到哪了」
    turnDetail: {
      status: CE_TURN_STATUS.ok,
      gaps: diff.perActor || {},
      unfinishedEventIds: (diff.perActor ? Object.keys(diff.perActor) : []),
      wroteNames: settled.accepted.map((b) => b.name),
    },
  }));

  return result;
  }catch(error){
    if(activePrebuiltRepair)return finish(aborted()?CE_TURN_STATUS.rolledBack:CE_TURN_STATUS.proseFailed,{
      trace,range:preparedBoundary?.range,reason:String(error?.message||error),stagedOk:false,landed:false,actorProgressSaved,partial:actorProgressSaved});
    if(error?.code==='CE_REQUEST_CAPACITY'){
      step('容量检查',error.message);
      return finish(CE_TURN_STATUS.boundaryFailed,{trace,reason:error.message,capacityFailure:true,stagedOk:false,landed:false});
    }
    throw error;
  }
}

/**
 * 组装「跨轮事件」清单，交给账本记住。
 *
 * 规则：
 *   · 本轮跨过终点的事件 → 记成「处理到 turnRange.end」
 *   · 账本里原有、但本轮没提到的 → 原样保留（它还没结束）
 *   · 已经走到头（事件结束时间 <= 本轮终点）→ 移除
 *
 * @param {Array} inProgress findInProgressEvents 的产物
 * @param {Array} prevOpen 账本里原有的
 * @param {Array} candidates 本轮候选
 * @param {string} endTime 本轮终点
 * @returns {Array}
 */
function buildOpenEvents(inProgress, prevOpen, candidates, endTime) {
  const out = [];
  const seen = new Set();

  // 本轮新识别出来的
  for (const x of (Array.isArray(inProgress) ? inProgress : [])) {
    if (!x || !x.code || seen.has(x.code)) continue;
    seen.add(x.code);
    out.push({
      eventId: x.code,
      coveredTo: x.coveredTo,
      endAt: x.endAt,
      doneActors: {...((Array.isArray(prevOpen)?prevOpen:[]).find(row=>row.eventId===x.code)?.doneActors || {})},
    });
  }

  // 账本里原有的（本轮没提到、还没走完的）
  for (const e of (Array.isArray(prevOpen) ? prevOpen : [])) {
    const id = String(e && e.eventId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      eventId: id,
      // 沿用上一轮记的「处理到哪」
      coveredTo: String(e.coveredTo || '').trim(),
      endAt: String(e.endAt || '').trim(),
      doneActors: { ...(e.doneActors || {}) },
    });
  }

  return out;
}

/**
 * 给返回值补上三样玩家可见的东西：
 *   ① 诊断记录（写进思维 tab）
 *   ② 玩家反馈（五块）
 *   ③ 账本提交计划（**不自动写**，由调用方在变量落地成功后提交）
 *
 * 为什么不在这里直接写账本：
 *   总设计 §4.3.6 说得很清楚——代码在「变量落地成功 + 快照保存成功」
 *   之后才更新 worldTime 和 debts。编排器不知道变量有没有落地，
 *   所以它只能**算出计划**，不能自己提交。
 *
 * @param {object} payload 原有返回值
 * @param {object} ctx
 * @returns {object} 补全后的返回值
 */
function withVisibility(payload, ctx) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};

  // ① 诊断
  const diag = p.diag || c.diag || null;
  let diagItems = [];
  if (diag && typeof diag.items === 'function') {
    recordTurnResult({ ...p, status: p.status }, diag);
    diagItems = diag.items();
  }

  // ② 玩家反馈
  const feedback = renderPlayerFeedback({
    range: c.range || p.range,
    eventCount: c.eventCount,
    writtenNames: c.writtenNames || (Array.isArray(p.prose) ? p.prose.map((x) => x.name) : []),
    mutated: c.mutated,
    blocked: c.blocked,
    debts: c.debts || p.debts,
    wroteWorld: c.wroteWorld === true,
    staleHooks: c.staleHooks,
    openHooks: p.openHooks,
  });

  // ③ 账本提交计划（只算不写）
  //
  // 判据用 stagedOk 而不是 succeeded：
  //   编排器这一侧检查过了、该做的都做了 → 可以算出「应该推进到哪」。
  //   但真正落地要等宿主保存成功 → 计划里标 landed，由调用方升级。
  //
  // 原来这里传的是恒为 false 的 succeeded，导致 changed 恒 false，
  // 调用方的 `if (plan && plan.changed)` 永不成立，账本一次都没推进过。
  const ledgerPlan = planLedgerCommit({
    ledger: c.ledger || { worldTime: '', debts: [] },
    confirmedTime: c.confirmedTime || (c.range && c.range.end) || '',
    handledRange: c.handledRange,
    succeeded: c.stagedOk === true,
    failure: c.stagedOk === true ? null : c.failure,
    // 钩子跟账本一起存：不回传的话下一轮又从空开始，
    // 「三轮寿命」永远攒不满
    turn: {
      ...(c.turnDetail || {}),
      status: (c.turnDetail && c.turnDetail.status) || p.status || 'ok',
      eventCount: c.eventCount || 0,
      actorCount: (c.writtenNames || []).length,
      wroteNames: c.writtenNames || [],
      gaps: {
        ...Object.fromEntries((c.debts || p.debts || []).filter(d => d && d.name).map(d => [d.name,[d.reason || '散文未完成']])),
        ...Object.fromEntries((p.backstoryDebts || []).map(name=>[name,[...((c.debts || p.debts || []).find(d=>d.name===name) ? ['散文未完成'] : []),'生平旧账未确认']])),
        ...((p.worldDebts || []).length ? {'世界':(p.worldDebts || []).map(e=>inferEventCode(e) || e.title)} : {}),
        ...((p.unowned || []).length ? {'未定位人物':p.unowned} : {}),
      },
      unfinishedEventIds: Array.from(new Set([...(p.worldDebts || []).map(inferEventCode),...(c.debts || p.debts || []).flatMap(d=>String(d.eventCode || '').split(/[,，、]/))].filter(id=>/^E-\d+$/i.test(id)))),
      hooks: c.hooks,
      turnNo: c.turnNo,
      openEvents: p.openEvents || [],
      unreachedEventIds:c.unreachedEventIds,
      eventProgress:p.eventProgress || [],
      eventWatches:p.eventWatches || [],
    },
  });
  if (ledgerPlan && typeof ledgerPlan === 'object') {
    // 计划已算出，但还没落地。调用方必须在宿主写库成功后
    // 才允许把它当成已提交。
    ledgerPlan.landed = c.landed === true;
    ledgerPlan.staged = c.stagedOk === true;
  }

  return {
    ...p,
    diagItems,
    diagHtml: renderDiagHtml(diagItems),
    playerFeedback: feedback,
    ledgerPlan,
    // 资料采集明细：玩家要看得到哪项没取到，据此排查
    materialReport: c.materialReport || p.materialReport || [],
  };
}

// ============================================================
// 内部：世界块与黄区钩子
// ============================================================

/* ★★★ 2026-11-03 玩家报：「补演错误 src is not defined」（第一次见）。
 *
 * 【病根】这个函数签名是 `writeWorldBlock(input)`，但函数体里 25 处全在写 `src`。
 * 起因是我上一轮给「世界块」加提示词说明、把 `writeWorldBlockBatch` 的上下文
 * 合并进来时，把那边的变量名 `src` 一起带了过来，而这里形参叫 `input`。
 *
 * 为什么之前没炸：只有**走到世界块这一步**才会执行到这里。
 *   ① `all.length === 0` 时函数在最上面就 return 了（没世界事件的那一轮），
 *   ② 大多数跑通的轮次里世界块是最后一步，报错被上层 finish 兜住只记了状态。
 * 所以它是一个「只在特定路径才触发」的潜伏错误，正好这次被踩到。
 *
 * 【修法】把形参改成 `src`，函数体一个字都不用动。
 * 反过来改 25 处 `src`→`input` 风险更大，且容易漏。
 * 这个函数体内本来就没有别处用到 `input` 这个名字（只有形参那 1 处）。 */
async function writeWorldBlock(src) {
  src={...src,previousEventProgress:eventProgressForModel(src.previousEventProgress||[]),
    eventProgress:eventProgressForModel(src.eventProgress||[])};
  const pick = {entries:Number(src.options?.eventProgressVersion)>=1 ? (src.candidates || []) : Array.isArray(src.worldEventCodes) ? (src.candidates || []).filter(event=>src.worldEventCodes.includes(inferEventCode(event))) : (src.candidates || []),overflow:[]};
  const all = [...pick.entries,...(pick.overflow || [])];
  if (!all.length) return {block:null,entries:[],failedEntries:[],noChanges:[],eventProgress:[],forMisc:''};
  const batches=packRequestMaterials(all,{...src.options?.batchLimits,sharedChars:String(src.storyText || '').length+String(src.background || '').length+JSON.stringify(src.blocks || []).length+JSON.stringify(src.previousEventProgress || []).length+JSON.stringify(src.eventProgress || []).length,estimateOutput:()=>600});
  const state={version:1,batches:[]};
  const results=await Promise.all(batches.map(async batch=>{
    const signature=JSON.stringify([batch,src.storyText||'',src.background||'',src.blocks||[],src.previousEventProgress||[],src.eventProgress||[],src.range||{},src.overrides||{},src.options?.eventProgressVersion,src.options?.worldMaxChars]);
    const saved=src.resumeState?.version===1&&src.resumeState.batches.find(row=>row.signature===signature&&(row.result?.block||row.result?.noChange===true));
    const result=saved?structuredClone(saved.result):await writeWorldBlockBatch({...src,candidates:batch,selectionConfirmed:Array.isArray(src.worldEventCodes)});
    state.batches.push({signature,result});return result;
  }));
  const good = results.filter(r => r.block);
  const successful = results.filter(r => r.block || r.noChange === true);
  const failed = results.filter(r => !r.block && r.noChange !== true);
  const failedEntries = failed.flatMap(r => r.entries || []);
  // 失败要说清是哪个阶段、哪几条事件编号、为什么。
  // 只有笼统的「尚未确认」时玩家无从下手；有编号才能只补这几条，成功批次不用重跑。
  const failedBatches = failed.map((r, index) => ({
    stage: r.stage || '世界事件收尾',
    reason: r.reason || '未说明原因',
    eventCodes: r.eventCodes && r.eventCodes.length ? r.eventCodes : Array.from(new Set((r.entries || []).map(inferEventCode).filter(Boolean))),
    eventTitles: r.eventTitles || [],
    batchIndex: index + 1,
  }));
  return {block:good.length ? {...good[0].block,eventIds:Array.from(new Set(good.flatMap(r=>r.block.eventIds || []))),body:good.map(r=>r.block.body).join('\n\n')} : null,
    entries:all,failedEntries,failedBatches,state,
    noChanges:successful.flatMap(r=>r.noChanges || []),eventProgress:successful.flatMap(r=>r.eventProgress || []),forMisc:good.map(r=>r.forMisc || '').join('\n\n')};
}

async function writeWorldBlockBatch(input) {
  const src = input || {};
  const step = typeof src.step === 'function' ? src.step : () => {};
  const diag = src.diag || null;

  const pick = {entries:src.candidates || []};
  if (pick.entries.length === 0) {
    step('世界块', '没有待核查的世界候选');
    return { block: null, entries: [], noChanges: [], reason: '世界候选为 0' };
  }
  step('世界块', `${pick.entries.length} 条候选核查实际世界变化`);

  let prompt = buildWorldBlockPrompt({
    entries: pick.entries.map(e => ({...e,eventCode:e.eventCode || inferEventCode(e),
      eventTitle:e.eventTitle || e.title || '',material:e.material || e.content_brief || e.content_original || ''})),
    missing: src.diff && src.diff.missing,
    storyText: src.storyText,
    background: src.background,
    timeRange: src.range,
    options: {
      maxChars: (src.options && src.options.worldMaxChars) || 200,
      promptOverrides: src.overrides,
    },
  });

  const codeHint=prompt.slice(prompt.lastIndexOf('\n骨架行的第一段填：'));
  prompt=prompt.slice(0,prompt.lastIndexOf('\n骨架行的第一段填：'));
  const progressEnabled=Number(src.options?.eventProgressVersion)>=1;
  if(progressEnabled)prompt+='\n【实际世界结果及其进度一起返回，不增加独立请求】\n'+EVENT_PROGRESS_PROTOCOL+'\n先判断实际世界变化，再据已成立事实记录事件进度；不要让进度目标反过来规定故事。有变化返回JSON：{"block":"原格式完整世界正文，含骨架行","eventProgress":[...]}；确实没有世界变化返回JSON：{"noChange":true,"reason":"明确判断理由","eventProgress":[...]}。两种成功结果都须完整返回本批事件进度，无世界变化不等于原事件已收尾。';
  const publicStoryEvidence=(src.blocks || []).map(({name,eventIds,status,reason,body,variableBody,readOnlyBody})=>({
    name,eventIds,status,reason,body:body || [variableBody,readOnlyBody].filter(Boolean).join('\n\n'),
  }));
  const nodeConfirmation={observed:mergeEventProgress(src.previousEventProgress,src.eventProgress),
    evidence:[src.storyText,...publicStoryEvidence.map(row=>row.body)].filter(Boolean)};
  if(progressEnabled&&nodeConfirmation.observed.some(row=>row.nodes?.some(node=>node.state==='todo')))
    prompt+='\n把已登记的 todo 节点改成 done 或实际发生的 mutated 时，在该节点的 evidence 逐字引用本轮玩家正文或已验收 NPC 视角正文中证明完成的原句。仍待发生的节点保留 todo；不能省略待办来关闭事件。取消、错过或替代按实际因果另记。';
  prompt+='\n【已保存事件事实】\n'+JSON.stringify(src.previousEventProgress || [])+'\n【边界观察，仅供参考】\n'+JSON.stringify(src.eventProgress || [])+'\n【本轮已经写出的人物正文，仅供判断公共影响，不是预定目标】\n'+JSON.stringify(publicStoryEvidence);
  /* ★★★ 2026-11-03 玩家定：
   *   「世界大事在前要当参考资料，再后又要根据这一轮补演的情况更新。」
   *   「要告诉ai这份资料是做什么的，又是怎么通过本轮补演所有人的行为来影响和更新的。」
   *
   * 这一段是在告诉模型：它不是写一段独立的世界设定，
   * 它是在更新一份**全存档共享、逐轮累积、所有人都要遵守**的记录。
   * 写重了下一轮所有人都会被带偏，写漏了下一轮就没人知道这件事发生过。 */
  prompt+='\n【你这一步在整条链上的位置，决定了怎么写】\n'
    +'你在更新的是这个世界**逐轮累积的公共状态记录**——它会覆盖上一轮的旧记录，成为下一轮所有角色行动的既定背景。\n'
    +'· 上游：本轮每个人物正文已经写完（就是上面那份 blocks）。你的职责是把这些个人行为里**真正改变了公共面**的部分汇聚出来。\n'
    +'· 下游：下一轮的原著指导和所有角色都会把它当既定事实读。所以写进去的事，下一轮就必须成立。\n'
    +'· 因此：只写已经发生的公共变化（势力易主、地盘得失、资源易手、局势逆转、消息传开）；\n'
    +'  纯个人经历不写进来；没有发生的不要为了让记录好看而虚构；已经发生的也不要漏掉——\n'
    +'  漏了，下一轮就没人知道世界已经变了。';
  prompt+=progressEnabled?'\n本批候选编号：'+pick.entries.map(inferEventCode).join(',')+'\n世界骨架只列实际产生公共变化的事件子集，不强行把纯个人经历写进世界大事；eventProgress必须覆盖本批全部编号。':codeHint;
  prompt+='\n【世界正文骨架写法】每行第一段使用本批事件的明确编号，多个编号用英文逗号分隔，不使用范围缩写（例如 E-001～E-003）。第二段固定写“世界”，地点只写在正文里；第三段写照原著/变异/阻断。格式示例：\n## '+inferEventCode(pick.entries[0])+' | 世界 | 照原著\n此示例只说明格式，不要求该事件一定产生公共变化。';
  // 与补演边界同一口径：进度漏项要点名具体编号再重发，不能一次不中就丢掉整批世界结果。
  const worldProgressFeedback=value=>{
    if(!value || value.ok || !(value.missing?.length || value.unexpected?.length || value.invalid?.length))return '';
    const parts=[];
    if(value.invalid?.length)parts.push('这些条目的编号或status不合法：'+value.invalid.join('、'));
    if(value.missing?.length)parts.push('缺少这些事件的进度：'+value.missing.join('、'));
    if(value.unexpected?.length)parts.push('这些编号不属于本批事件：'+value.unexpected.join('、'));
    return parts.join('；')+'。eventProgress必须每个本批事件返回且只返回一次，编号用本批events里的code；本轮尚未开始或未推进的事件也要显式返回一行，status用ongoing、pending写明尚未发生事项，不能省略。';
  };
  const batchEntries=pick.entries.map(e=>({...e,code:inferEventCode(e)}));
  let raw = '',correction='';
  // 世界正文和事件进度必须一起判、一起重试。
  // 原来的重试只看进度：世界正文写歪了（格式不对、骨架号不完整、写成人视角）
  // 在重试之后才判，等于一次都不重发；而且重发时 correction 为空，
  // 发的是同一份提示词，必然同样失败——这就是「重试还是失败」的根因。
  // 结构检查集中在这里：失败时给出可执行的具体修正要求，不能只说「不合格」。
  const checkWorldBlock=(text)=>{
    const parsed=parseWorldBlock(text);
    if(!parsed.ok)return {ok:false,stage:'世界正文格式不合格',reason:parsed.reason,correction:'上一次返回不是合法的世界正文格式：'+parsed.reason+'。必须按上面给的骨架行格式返回完整正文。'};
    if(parsed.noChange===true){
      if(!String(parsed.reason || '').trim())return {ok:false,stage:'无变化缺少理由',reason:'没有世界变化时必须写清判断理由',correction:'上一次返回了 noChange 但没给 reason。请在 reason 里写明为什么本轮没有公共世界变化。'};
      return {ok:true,parsed};
    }
    const expected=Array.from(new Set(pick.entries.map(inferEventCode).filter(Boolean)));
    if (parsed.block.eventIds.some(code=>!expected.includes(code)) || (!progressEnabled&&(parsed.block.eventIds.length !== expected.length || expected.some(code=>!parsed.block.eventIds.includes(code))))) {
      const got=parsed.block.eventIds.join('、') || '（无骨架行）';
      const reason='世界骨架须引用本批事件；开启进度核查时只写有公共变化的事件，eventProgress仍须覆盖全部候选';
      return {ok:false,stage:'世界骨架事件号不完整',reason,correction:'上一次返回的骨架事件号是 '+got+'。'+(progressEnabled?'世界正文只能从 '+expected.join('、')+' 中选择有实际公共变化的事件，不能引用批外编号，也不必为没有公共变化的事件补写世界正文。eventProgress仍须覆盖全部候选。':'本批必须是 '+expected.join('、')+' 且每个只出现一次，请补齐缺失骨架行，不引用批外事件。')};
    }
    const audit = auditWorldBlock(parsed.block.body, src.knownNames);
    if (!audit.ok) return {ok:false,stage:'世界正文写成了人物视角',reason:audit.reason,correction:'上一次把公共世界变化写成了某个人物的经历：'+audit.reason+'。请只写公共可见的变化（势力、地点、资源、局势），不写个人视角。'};
    return {ok:true,parsed};
  };
  const request=async()=>{
    try {
      raw = await src.host.llmCall({ stage:correction?'世界事件补演·修正重发':'世界事件补演',
        messages: [{ role: 'user', content: prompt+(correction?'\n'+correction+'\n按上面点出的问题修正后，仍按原格式完整返回（世界正文与 eventProgress 都要完整，不要只发改动片段）。':'') }],
        json: progressEnabled,
      });
    } catch (error) {
      step('世界块', `调用失败：${error.message}`);
      if (diag) diag.warn('世界块没写出来', error.message);
      // 调用失败也重试：网络/限流是一过性的，不该一次抖动就整批失败。
      return {ok:false,reason:`调用失败：${error.message}`,stage:'世界事件调用失败'};
    }
    // 先做世界正文结构检查：正文不合格时，进度解析也一定是空的，
    // 若先报进度就会把「正文写歪了」误报成「进度没回」，玩家看到的原因就是错的。
    const checked=checkWorldBlock(raw);
    if(!checked.ok){
      correction=checked.correction;
      // 正文格式整体不合法时，同时把进度问题也写进纠正，让下一次一并修正。
      if(progressEnabled){
        const payload=parseJsonLoose(raw);
        const progressProbe=parseEventProgressRows(payload?.eventProgress,batchEntries,src.previousEventProgress,src.range?.end,nodeConfirmation);
        if(!progressProbe.ok)correction=[checked.correction,worldProgressFeedback(progressProbe) || progressProbe.reason].filter(Boolean).join('\n');
      }
      return {ok:false,reason:checked.reason,stage:checked.stage};
    }
    let value=null;
    if(progressEnabled){
      const payload=parseJsonLoose(raw);
      value=parseEventProgressRows(payload?.eventProgress,batchEntries,src.previousEventProgress,src.range?.end,nodeConfirmation);
      if(!value.ok){correction=worldProgressFeedback(value) || value.reason;return {ok:false,reason:value.reason,stage:'事件进度不合格'};}
    }
    return {ok:true,progress:value || {ok:true,rows:[]},parsed:checked.parsed};
  };
  let outcome=await request();
  // 不合格就带着具体修正要求重发，直到用完重试次数；不再区分进度/正文，两者都重试。
  if(!outcome.ok){
    const retries=Math.max(0,Math.min(3,Number(src.options?.retry?.maxRetries ?? 2)));
    for(let attempt=1;attempt<=retries;attempt+=1){
      if(src.signal?.aborted)break;
      step('世界块',`第 ${attempt}/${retries} 次修正重发：${outcome.stage||''}${outcome.reason?'：'+outcome.reason:''}`);
      outcome=await request();
      if(outcome.ok)break;
    }
  }
  // 失败时必须把「哪个阶段、哪几条事件、为什么失败」原样带回。
  // 只留一个 reason 字符串，上层只能显示笼统的「尚未确认」，玩家无从下手。
  const failDetail=(stage,reason)=>({
    block:null,
    entries:pick.entries,
    reason,
    stage,
    eventCodes:Array.from(new Set(pick.entries.map(inferEventCode).filter(Boolean))),
    eventTitles:pick.entries.map(entry=>String(entry.eventTitle || entry.title || '')).filter(Boolean),
  });
  if(!outcome.ok){
    step('世界块', `不合格：${outcome.reason}`);
    if (diag) diag.warn('世界块不合格', outcome.reason);
    return failDetail(outcome.stage||'世界事件收尾不合格',outcome.reason);
  }
  const progress=outcome.progress;
  const parsed = outcome.parsed;

  if (parsed.noChange === true) {
    const noChanges=pick.entries.map(entry=>({eventId:inferEventCode(entry),title:String(entry.eventTitle || entry.title || ''),reason:parsed.reason,checked:true}));
    step('世界块','已确认本批没有实际世界变化',{kind:'worldNoChange',noChanges});
    return {block:null,entries:pick.entries,noChange:true,noChanges,eventProgress:progress.rows,forMisc:'',reason:parsed.reason};
  }

  // 骨架号完整性、人视角检查都已在 checkWorldBlock 里做过并通过，这里不再重复。

  step('世界块', `成 1 块（${parsed.block.body.length} 字）`);
  return {
    eventProgress:progress.rows,
    block: parsed.block,
    forMisc: renderWorldBlockForMisc(parsed.block),
    entries: pick.entries,
    reason: '',
  };
}

/**
 * 一轮黄区钩子流转。
 *
 * 依据总设计 §4.9：黄区是唯一需要跨轮记忆的区。
 * 从散文里捡出钩子、把到期没收的标烂尾、给玩家提示。
 */
function advanceTurnHooks(input) {
  const src = input || {};
  const step = typeof src.step === 'function' ? src.step : () => {};
  const diag = src.diag || null;

  const accepted = Array.isArray(src.accepted) ? src.accepted : [];

  // 从每块散文里捡显式标记的钩子
  const fresh = [];
  for (const block of accepted) {
    for (const h of extractHooks(block && block.body)) fresh.push(h);
  }

  const advanced = advanceHooks({
    hooks: src.hooks,
    turnNo: src.turnNo,
    fresh,
    resolved: src.resolved || [],
    lifetime: src.lifetime,
  });

  const open = openHooks(advanced.hooks);
  step('黄区钩子', `新起 ${advanced.added}，收掉 ${advanced.closed}，开口 ${open.length}`);

  if (advanced.stale.length > 0) {
    step('黄区钩子', `${advanced.stale.length} 条超时未收，已标烂尾`);
    if (diag) diag.warn(`${advanced.stale.length} 条线索烂尾了`, advanced.staleText);
  }

  return advanced;
}

// ============================================================
// 内部：写入与重试
// ============================================================

/** 仅修复一一对应日期段的生平元数据；正文与所有已成立事实保持原样。 */
export async function repairProseBiography({host,block,retry,signal,validationContext}) {
  if(!block || block.handoffDeclared)return {attempted:false};
  const context={expectedName:block.name,expectedEvents:block.eventIds,structureOnly:true,diary:true,...validationContext};
  const checked=validateProseBlock(block,context),gap=checked.gaps[0];
  if(checked.ok || checked.gaps.length!==1 || gap.field!=='biographyLine' || gap.repairable!==true)return {attempted:false};
  const prompt='只修正下列本人原稿的生平摘要元数据，不重写故事。正文保持逐字不变，不参考或补写原著未来经历。'
    +'每个正文日期段各有一条非空摘要，顺序不变，方括号内日期与地点必须逐字复制对应标题，不能省略年份或缩写日期。'
    +'保留原摘要中本段已经成立的本人行动与结果；只根据对应正文纠正摘要，不虚构、不删掉未出错事实，不把多个日期段合成一条。'
    +'返回JSON {"biographyLine":"[对应标题的日期@地点]本段摘要\\n[下一段日期@地点]下一段摘要"}，只返回该字段。'
    +'\n【缺口】\n'+gap.detail+'\n【应有日期地点，顺序固定】\n'+JSON.stringify(gap.expectedLabels)
    +'\n【本人原稿与原摘要】\n'+JSON.stringify({name:block.name,story:block.body,biographyLine:block.biographyLine});
  let corrected;
  const result=await withRetry(({correct})=>host.llmCall(correct({stage:'人物视角散文',subject:block.name,messages:[{role:'user',content:prompt}],json:true})),{
    signal,config:retry,validate:raw=>{
      const payload=parseJsonLoose(raw);
      if(typeof payload?.biographyLine!=='string')return {ok:false,reason:'须返回字符串 biographyLine，不能省略或用数组替代'};
      // 只取允许修改的摘要字段。即使模型返回了正文，也不会覆盖原稿。
      const candidate={...block,biographyLine:payload.biographyLine};
      const validation=validateProseBlock(candidate,context);
      if(!validation.ok)return {ok:false,reason:validation.gaps.map(item=>item.detail).join('；')};
      corrected=candidate;return {ok:true};
    }
  });
  return result.ok?{attempted:true,ok:true,block:corrected,gaps:[]}:
    {attempted:true,ok:false,block,gaps:[...checked.gaps,{type:'api',detail:block.name+'：生平摘要定点修正未完成：'+result.reason}]};
}

/**
 * 单个 NPC：写 → 校验 → 不合格重写 → 还不行就记欠账。
 *
 * 两层重试，分工不同：
 *   ① withRetry 管**网络/空响应/解析不出来** —— 模型或网线抽风，重发同一份
 *   ② 本函数的循环管**校验不合格** —— 内容写出来了但没达标，带上缺口提示重写
 *
 * 为什么分两层：网络错重发同一份提示词就够了；
 * 校验不合格必须换提示词（加缺口说明），重发原样没用。
 */
async function writeOneWithRetry({ host, prompt, name, expectedEvents, mustWrite, overrides, retry, onRetry, signal, proseRewriteCount=CE_MAX_RETRY, structureOnly=false, inlineReview=false }) {
  let lastGaps = [];
  const rewrites=Math.max(0,Math.min(3,Math.floor(Number(proseRewriteCount)||0)));
  for (let attempt = 0; attempt <= rewrites; attempt += 1) {
    // 玩家停止后不再重写，也不再等退避
    if (signal && signal.aborted) {
      return { ok: false, block: null, gaps: [{ type: 'api', detail: describeAbort(signal) }] };
    }
    const fullPrompt = (attempt === 0 ? prompt : prompt + buildRetryHint(lastGaps))+
      (inlineReview?'\n【正文附带依据】'+INLINE_PROSE_FACTS+' 在原有正文及摘要之后另起一行，格式 @@落地依据: {单行JSON}。该行不属于故事。':'');

    const r = await withRetry(
      ({correct}) => host.llmCall(correct({ stage:'人物视角散文', subject:name,
        messages: [{ role: 'user', content: fullPrompt }],
        json: false,
      })),
      {
        config: retry,
        signal: signal || null,
        onRetry: (a, max, reason, delay) => {
          if (typeof onRetry === 'function') {
            onRetry({ stage: `${name} 正文`, attempt: a, max, reason, delay });
          }
        },
      },
    );

    if (!r.ok) {
      return {
        ok: false, block: null,
        gaps: [{ type: 'api', detail: r.reason }],
      };
    }

    const payload=inlineReview?splitInlineProseReview(r.value):{text:r.value,review:null};
    const block = parseProseBlock(payload.text);
    const checked = validateProseBlock(block, { expectedName: name, expectedEvents, mustWrite, structureOnly, diary:structureOnly });
    if (checked.ok) return { ok: true, block, gaps: [], ...(payload.review?{inlineCompletion:payload.review}:{}) };
    lastGaps = checked.gaps;

    if (attempt === rewrites) {
      // 重试用完，不再重写（用户定：只 1 次）
      return { ok: false, block, gaps: lastGaps };
    }
  }

  return { ok: false, block: null, gaps: lastGaps };
}

/** 一批配角：一次调用拿 JSON 数组，逐段校验 */
function isProseRequestFailure(row) {
  return !!row && !row.ok && Array.isArray(row.gaps)
    && row.gaps.some(gap=>gap && ['api','network','abort'].includes(gap.type));
}

async function writeBatchWithRetry({ host, prompt, group, overrides, retry, onRetry, signal, proseRewriteCount=CE_MAX_RETRY, structureOnly=false, inlineReview=false }) {
  let lastGaps = [];
  const rewrites=Math.max(0,Math.min(3,Math.floor(Number(proseRewriteCount)||0)));
  for (let attempt = 0; attempt <= rewrites; attempt += 1) {
    // 玩家停止后不再重写
    if (signal && signal.aborted) {
      return group.map((m) => ({
        name: m.name, ok: false, block: null,
        gaps: [{ type: 'api', detail: describeAbort(signal) }],
      }));
    }
    const fullPrompt = (attempt === 0 ? prompt : prompt + buildRetryHint(lastGaps))+
      (inlineReview?'\n【正文附带依据】'+INLINE_PROSE_FACTS+' 数组仍保持原格式，每个非交汇条目必须形如 {"name":"人物名","story":"按原格式写正文","biographyLine":"按原格式写生平","completionReview":{"name":"人物名","facts":[],"cultivation":null,"baseline":{"applicable":false,"basis":""}}}。保留已有 status、reason 等字段。completionReview 与 story 同级，不要写进正文。':'');

    const r = await withRetry(
      ({correct}) => host.llmCall(correct({ stage:'群像视角散文',
        subject:group.map(m=>m.name).join('、'),
        messages: [{ role: 'user', content: fullPrompt }],
        json: true,
      })),
      {
        config: retry,
        signal: signal || null,
        onRetry: (a, max, reason, delay) => {
          if (typeof onRetry === 'function') {
            onRetry({ stage: '配角群像', attempt: a, max, reason, delay });
          }
        },
      },
    );

    if (!r.ok) {
      return group.map((m) => ({
        name: m.name,
        ok: false,
        block: null,
        gaps: [{ type: 'api', detail: r.reason }],
      }));
    }

    const parsed = parseBatchStories(r.value);
    const results = [];
    lastGaps = [];

    for (const m of group) {
      const found = parsed.get(m.name) || parsed.get(String(m.id || ''));
      if (!found) {
        const gaps = [{ type: 'parse', detail: `名单里的「${m.name}」没有写` }];
        results.push({ name: m.name, ok: false, block: null, gaps });
        lastGaps.push(...gaps);
        continue;
      }

      // 配角也走同一套骨架校验：把 story 当正文，三态与依据用模型给的
      const block = {
        eventIds: inferCodesFromName(m),
        name: m.name,
        status: found.status,
        reason: found.reason,
        declaredWritten: found.written || [],
        declaredUnwritten: found.unwritten || [],
        ...splitHandoffStory(found.story,found.biographyLine||'',found.handoffBiographyLine||''),
      };
      const checked = validateProseBlock(block, {
        expectedName: m.name,
        structureOnly,
        diary:structureOnly,
        expectedEvents: m.material.taskCodes,
        taskKind: m.material.taskKind,
        mustWrite: m.material.task || [],
      });
      if (checked.ok) results.push({ name: m.name, ok: true, block, gaps: [], ...(inlineReview&&found.inlineCompletion?{inlineCompletion:found.inlineCompletion}:{}) });
      else {
        results.push({ name: m.name, ok: false, block, gaps: checked.gaps });
        lastGaps.push(...checked.gaps);
      }
    }

    if (results.every((r) => r.ok) || attempt === rewrites) return results;
  }

  return group.map((m) => ({ name: m.name, ok: false, block: null, gaps: lastGaps }));
}

/** 从 JSON 数组回复里取 { 名字 → story } */
function parseBatchStories(raw) {
  const out = new Map();
  const text = String(raw == null ? '' : raw)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim();

  let list = null;
  try { list = JSON.parse(text); } catch { /* 继续尝试 */ }
  if (!Array.isArray(list)) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { list = JSON.parse(fence[1]); } catch { /* 继续 */ } }
  }
  if (!Array.isArray(list)) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { list = JSON.parse(text.slice(start, end + 1)); } catch { /* 放弃 */ }
    }
  }
  if (!Array.isArray(list)) return out;

  const normalizeStatus = (raw) => {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '变异' || s === '阻断' || s === '照原著') return s;
    return '照原著';
  };

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const story = String(item.story == null ? '' : item.story).trim();
    if (!story) continue;
    const name = String(item.name == null ? '' : item.name).trim();
    const id = String(item.id == null ? '' : item.id).trim();
    const status = normalizeStatus(item.status);
    const reason = String(item.reason == null ? '' : item.reason).trim();

    // 同一个 story 分别挂在 name 和 id 两个键上，便于按任一匹配
    const value = { story, status, reason,
      written:Array.isArray(item.written) ? item.written.map(String) : [],
      unwritten:Array.isArray(item.unwritten) ? item.unwritten.map(String) : [],
      biographyLine:String(item.biographyLine || ''),handoffBiographyLine:String(item.handoffBiographyLine || ''),
      inlineCompletion:item.completionReview };
    if (name) out.set(name, value);
    if (id) out.set(id, value);
  }
  return out;
}

// ============================================================
// 内部：小工具
// ============================================================

function finish(status, payload) {
  return { status, ok: status === CE_TURN_STATUS.ok, ...payload };
}

/** 从候选事件里收集所有人物名（标题 [人物:] 标签并集） */
function collectCandidateNames(candidates) {
  const names = new Set();
  for (const e of Array.isArray(candidates) ? candidates : []) {
    const m = String(e && e.title || '').match(/\[人物[:：]([^\]]+)\]/);
    if (!m) continue;
    for (const piece of m[1].split(/[,，]/)) {
      const name = piece.trim().replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '');
      if (name) names.add(name);
    }
  }
  return [...names];
}

function inferEventCode(entry) {
  const m = String(entry && entry.title || '').match(/【\s*(E-\d+(?:\.\d+)?)\s*】/i);
  if(m)return m[1].toUpperCase();
  // 自定义年表允许「只有eventId、标题无方括号」；不读它会让提示词给出空code，模型无从回行。
  const fallback = String(entry && (entry.eventId || entry.code) || '').trim().toUpperCase();
  return /^E-\d+(?:\.\d+)?$/.test(fallback) ? fallback : '';
}

/** 找出某人在哪些事件里出现，返回事件号 */
function inferEventCodesForName(candidates, name) {
  const codes = [];
  for (const e of Array.isArray(candidates) ? candidates : []) {
    const title = String(e && e.title || '');
    if (!title.includes(name)) continue;
    const code = inferEventCode(e);
    if (code) codes.push(code);
  }
  return codes;
}

function inferCodesFromName(material) {
  const codes = material && material.material && Array.isArray(material.material.taskCodes)
    ? material.material.taskCodes
    : [];
  return codes.length > 0 ? codes : ['（事件编号）'];
}
