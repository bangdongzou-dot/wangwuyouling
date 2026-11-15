// ============================================================
// 账本：这套系统里唯一必须记住「上一轮补到哪了」的东西
//
// 用户 2026-10-21 定的两条需求：
//   「账本能跟着每一轮快照回退」
//   「账本的作用是下一轮能知道上一轮补到哪了？方方面面」
//
// ------------------------------------------------------------
// 一、为什么必须挂在快照上，不能放全局键
//
//   旧做法：账本存 `dbGet('CULTIVATION_CANON_LEDGER_V1')`，
//   是个**全局单值**。玩家回退到之前某一层（读旧快照），
//   存档回去了，账本却还停在最新那一轮。
//   → 时间倒回去、欠账没倒回去，下一次跑就彻底错位。
//
//   现在：账本随快照一起存、一起读。
//   快照在哪一层，账本就在哪一层，天然同步，不需要任何「撤销」逻辑。
//
// ------------------------------------------------------------
// 二、账本里存什么
//
//   ① worldTime   世界走到哪了
//   ② debts       欠着什么（带事件号和处理到哪）
//   ③ openEvents  进行中的事件续到哪（跨轮的那半截）
//   ④ lastTurn    上一轮做了什么（下一轮据此接上）
//
//   这四样都是**事实**，不是派生结果，所以该存。
//   时间分类等派生结果现算；剧情是否收尾是语义事实，保存于eventProgress。
//
// ------------------------------------------------------------
// 三、为什么 openEvents 必须存
//
//   E-007 从 0011 跨到 0015。这一轮走到 0013，
//   这条事件只走了一半。下一轮从 0013 起算，
//   它当然还在候选里——但它**已经处理过的那半截**不能再处理一遍。
//
//   所以得记住：这条事件已经处理到哪个时间点，
//   哪些人的哪些维度已经补过了。下次从那个点接着走。
//
// ------------------------------------------------------------
// 四、谁写账本：模型给出故事进度判断，代码在原事务里确认提交
//
//   代码在「变量落地成功 + 快照保存成功」之后才更新。
//   任何一步失败：worldTime 不动、debts 不动、变量不动，这轮等于没发生。
// ============================================================

import { parseTimePoint, normalizeNodeTiming } from './interval.js';
import { withRetry } from './retry.js';

export const CANON_LEDGER_REPLAY_STAGE = '补演账本';

function ledgerNoteKey(row){return `${row.eventId}:${row.nodeId||''}`;}

export async function reviewCanonLedgerMutations({before,ledger,call,signal,retry,extra}){
  const current=ledger||{}, previous=new Map((before?.eventProgress||[]).map(row=>[row.eventId,row]));
  const earlierWatches=new Map((before?.eventWatches||[]).map(row=>[row.eventId,row]));
  const facts=[];
  for(const row of current.eventProgress||[]){
    const old=previous.get(row.eventId), nodes=new Map((old?.nodes||[]).map(node=>[node.nodeId,node]));
    for(const node of row.nodes||[]){
      if(!['mutated','created'].includes(node.state)||!node.nodeId||!node.cause&&!node.result&&!node.handling)continue;
      const pick=n=>[n?.state,n?.cause,n?.result,n?.handling];
      if(JSON.stringify(pick(node))===JSON.stringify(pick(nodes.get(node.nodeId))))continue;
      facts.push({eventId:row.eventId,nodeId:node.nodeId,title:node.title,at:node.at,state:node.state,cause:node.cause,result:node.result,handling:node.handling,actors:node.actors});
    }
    const timing=r=>[r?.timingChange?.kind,r?.timingChange?.reason,r?.timingChange?.actualStart];
    const changes=(row.changes||[]).filter(change=>!(old?.changes||[]).includes(change));
    const statusChanged=row.status!==old?.status&&['changed','blocked','replaced','expired','cancelled'].includes(row.status);
    const timingChanged=Boolean(row.timingChange)&&JSON.stringify(timing(row))!==JSON.stringify(timing(old));
    if(changes.length||statusChanged&&row.reason||timingChanged&&row.timingChange.reason){
      facts.push({eventId:row.eventId,title:row.title,status:row.status,reason:row.reason,changes,timing:timingChanged?row.timingChange:undefined});
    }
  }
  for(const row of current.eventWatches||[]){
    const old=earlierWatches.get(row.eventId);
    if(!row.reason||old?.status===row.status&&old?.reason===row.reason)continue;
    const fact=facts.find(item=>item.eventId===row.eventId&&!item.nodeId);
    if(fact)fact.watch={status:row.status,reason:row.reason};
    else facts.push({eventId:row.eventId,watch:{status:row.status,reason:row.reason}});
  }
  if(!facts.length)return {status:'not_needed',ledger:current};
  const input=JSON.stringify({through:current.worldTime,facts,request:String(extra||'').slice(0,1000)});
  if(input.length>45000)throw new Error('账本变异证据过多，未提交模型整理。');
  const allowed=new Set(facts.map(ledgerNoteKey));
  let notes;
  const result=await withRetry(({correct})=>call(correct({stage:CANON_LEDGER_REPLAY_STAGE,json:true,messages:[{role:'user',content:
    '整理本轮原著补演账本。以下是已经核验的变异事实。只为每项简洁记下改变了什么、后续还要确认什么；保留已确认与仅怀疑的区别，不能新增事件、人物、结论、日期或推测成事实。每项恰好返回一条，事件和节点编号照抄；没有节点时省略 nodeId。只返回 JSON：{"notes":[{"eventId":"事件编号","nodeId":"可选节点编号","note":"简要记录"}]}。\n'+input}]})),{
    signal,config:retry,validate(raw){
      try{
        const value=typeof raw==='string'?JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/iu,'$1')):raw;
        const seen=new Set();
        if(!Array.isArray(value?.notes)||value.notes.length!==allowed.size)throw new Error();
        notes=value.notes.map(row=>{
          const key=ledgerNoteKey(row),note=typeof row.note==='string'?row.note.trim():'';
          if(!allowed.has(key)||seen.has(key)||!note||note.length>360)throw new Error();
          seen.add(key);
          return {eventId:row.eventId,...(row.nodeId?{nodeId:row.nodeId}:{}),note};
        });
        return {ok:true};
      }catch{return {ok:false,reason:'变异说明缺项、编号不匹配或格式不符'};}
    },
  });
  signal?.throwIfAborted();
  if(!result.ok)throw new Error('账本变异整理未完成：'+result.reason);
  const merged=new Map((current.mutationNotes||[]).map(row=>[ledgerNoteKey(row),row]));
  for(const row of notes){merged.delete(ledgerNoteKey(row));merged.set(ledgerNoteKey(row),row);}
  return {status:'done',ledger:{...current,mutationNotes:[...merged.values()].slice(-160)}};
}

/** 账本在快照里的字段名（宿主把整个账本塞进 stateSnapshot） */
export const CE_LEDGER_SNAPSHOT_KEY = 'canonLedger';

/**
 * 兼容旧版全局键。只用于**迁移**：读到旧账本就搬到快照里，
 * 之后不再写这个键。
 */
export const CE_LEDGER_LEGACY_KEY = 'CULTIVATION_CANON_LEDGER_V1';

/** 欠账连续失败多少次算「放弃」 */
export const CE_DEBT_MAX_ATTEMPTS = 3;

/** 账本结构版本。改结构时 +1，读的时候按版本迁移。 */
export const CE_LEDGER_VERSION = 3;

/**
 * 空账本。
 * @param {string} [worldTime]
 * @returns {object}
 */
export function createEmptyLedger(worldTime = '') {
  return {
    version: CE_LEDGER_VERSION,
    worldTime: String(worldTime || '').trim(),
    debts: [],
    openEvents: [],
    eventProgress: [],
    // 黄区钩子：跨轮伏笔，跟账本同生共死
    hooks: [],
    lastTurn: null,
  };
}

/**
 * 把任何来源的账本读成规范形态。
 *
 * 宽容原则：账本坏了不能把游戏卡死，但**绝不能假装它是好的**——
 * 解析不出来的项丢弃并记录，让调用方知道丢了什么。
 *
 * @param {any} raw
 * @param {object} [fallback] { worldTime }
 * @returns {{ledger:object, repaired:boolean, dropped:Array<string>}}
 */
export function normalizeLedger(raw, fallback = {}) {
  const dropped = [];
  let repaired = false;

  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    repaired = true;
  }

  let worldTime = String(source.worldTime == null ? '' : source.worldTime).trim();
  if (!worldTime) {
    worldTime = String(fallback.worldTime == null ? '' : fallback.worldTime).trim();
    if (raw != null) repaired = true;
  }

  // ---- 欠账 ----
  const rawDebts = Array.isArray(source.debts) ? source.debts : [];
  if (source.debts !== undefined && !Array.isArray(source.debts)) repaired = true;

  const debts = [];
  for (const item of rawDebts) {
    const norm = normalizeDebt(item);
    if (!norm) {
      dropped.push(JSON.stringify(item));
      repaired = true;
      continue;
    }
    debts.push(norm);
  }

  // ---- 进行中的事件 ----
  const rawOpen = Array.isArray(source.openEvents) ? source.openEvents : [];
  if (source.openEvents !== undefined && !Array.isArray(source.openEvents)) repaired = true;

  const openEvents = [];
  for (const item of rawOpen) {
    const norm = normalizeOpenEvent(item);
    if (!norm) {
      dropped.push(JSON.stringify(item));
      repaired = true;
      continue;
    }
    openEvents.push(norm);
  }

  // ---- 上一轮记录 ----
  let lastTurn = null;
  if (source.lastTurn && typeof source.lastTurn === 'object') {
    lastTurn = normalizeLastTurn(source.lastTurn);
  } else if (source.lastTurn !== undefined && source.lastTurn !== null) {
    repaired = true;
  }

  const version = Number(source.version);
  if (!Number.isFinite(version) || version < CE_LEDGER_VERSION) {
    // 旧版账本（只有 worldTime + debts）：结构能兼容，不算损坏
    if (source.version !== undefined) repaired = true;
  }

  // ---- 黄区钩子（跨轮伏笔）----
  //
  // 这套字段原来根本不存在，钩子在账本里没地方存 →
  // 每轮都从空数组开始 → 「三轮寿命」从来没生效过。
  //
  // 它必须跟账本同生共死：玩家回退到起钩之前，钩子也要跟着消失。
  // 所以放这里，不放全局变量。
  //
  // 形状：{ id, eventId, who, text, bornTurn, lastTurn, status }
  const rawHooks = Array.isArray(source.hooks) ? source.hooks : [];
  if (source.hooks !== undefined && !Array.isArray(source.hooks)) repaired = true;
  const hooks = rawHooks
    .map((h) => normalizeHookRow(h))
    .filter(Boolean);

  return {
    ledger: {
      version: CE_LEDGER_VERSION,
      worldTime,
      turnNo: Math.max(0, Math.floor(Number(source.turnNo || (source.lastTurn && source.lastTurn.turnNo)) || 0)),
      debts,
      openEvents,
      eventProgress: mergeEventProgress([],source.eventProgress),
      ...(Array.isArray(source.prebuiltActorDifferences)&&source.prebuiltActorDifferences.length?
        {prebuiltActorDifferences:structuredClone(source.prebuiltActorDifferences)}:{}),
      ...(source.eventWatches?.length?{eventWatches:mergeEventWatches([],source.eventWatches)}:{}),
      ...(Array.isArray(source.mutationNotes)&&source.mutationNotes.length?{mutationNotes:source.mutationNotes.slice(-160)}:{}),
      hooks,
      lastTurn,
    },
    repaired,
    dropped,
  };
}

/**
 * 规范化一条黄区钩子。坏行直接丢掉（由调用方决定要不要报警）。
 *
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeHookRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = String(raw.hook == null ? (raw.text || '') : raw.hook).trim();
  const who = String(raw.who == null ? '' : raw.who).trim();
  // 没写「谁」也没写「什么事」的钩子没有续写价值
  if (!text && !who) return null;

  const bornTurn = Number(raw.bornTurn);
  const lastTurn = Number(raw.lastTurn);

  return {
    id: String(raw.id == null ? '' : raw.id).trim()
      || `${who || '?'}·${String(raw.eventId || '?')}·${Number.isFinite(bornTurn) ? bornTurn : 0}`,
    eventId: String(raw.eventId == null ? '' : raw.eventId).trim(),
    who,
    text,
    hook: text,
    closedTurn: Math.max(0,Math.floor(Number(raw.closedTurn) || 0)),
    note: String(raw.note || ''),
    bornTurn: Number.isFinite(bornTurn) ? bornTurn : 0,
    lastTurn: Number.isFinite(lastTurn) ? lastTurn : 0,
    status: String(raw.status == null ? 'open' : raw.status).trim() || 'open',
  };
}

/**
 * 规范化单条欠账。
 *
 * 除了时间区间，还要记**欠的是谁、欠什么维度**——
 * 否则下一轮只知道「这段时间欠着」，不知道具体还差什么，
 * 只能把整段重跑一遍。
 *
 * @param {any} item
 * @returns {object|null}
 */
export function normalizeDebt(item) {
  if (!item || typeof item !== 'object') return null;

  const from = String(item.from == null ? '' : item.from).trim();
  const to = String(item.to == null ? '' : item.to).trim();
  if (!from && !to) return null;

  const a = parseTimePoint(from);
  const b = parseTimePoint(to);

  // 两端都解析不了 = 这条欠账没法用来筛区间，丢掉
  if (a === null && b === null) return null;

  let loText = from;
  let hiText = to;
  if (a !== null && b !== null && a > b) {
    loText = to;
    hiText = from;
  }

  // 欠了哪些人的哪些维度
  const actors = {};
  if (item.actors && typeof item.actors === 'object' && !Array.isArray(item.actors)) {
    for (const [name, gaps] of Object.entries(item.actors)) {
      const n = String(name == null ? '' : name).trim();
      if (!n) continue;
      const list = Array.isArray(gaps)
        ? gaps.map((g) => String(g == null ? '' : g).trim()).filter(Boolean)
        : [];
      if (list.length > 0) actors[n] = list;
    }
  }

  const eventIds = Array.isArray(item.eventIds)
    ? item.eventIds.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    : [];

  const attempts = Number(item.attempts);
  return {
    from: loText || hiText,
    to: hiText || loText,
    eventIds,
    actors,
    reason: String(item.reason == null ? '' : item.reason).trim(),
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
  };
}

/**
 * 规范化「进行中的事件」。
 *
 * 记的是：这条事件处理到哪儿了、哪些人哪些维度已经补过。
 *
 * @param {any} item
 * @returns {object|null}
 */
export function normalizeOpenEvent(item) {
  if (!item || typeof item !== 'object') return null;

  const eventId = String(item.eventId == null ? '' : item.eventId).trim();
  if (!eventId) return null;

  const coveredTo = String(item.coveredTo == null ? '' : item.coveredTo).trim();
  if (!coveredTo) return null;
  const at = parseTimePoint(coveredTo);
  if (at === null) return null;

  const endAt = String(item.endAt == null ? '' : item.endAt).trim();

  const doneActors = {};
  if (item.doneActors && typeof item.doneActors === 'object' && !Array.isArray(item.doneActors)) {
    for (const [name, gaps] of Object.entries(item.doneActors)) {
      const n = String(name == null ? '' : name).trim();
      if (!n) continue;
      const list = Array.isArray(gaps)
        ? gaps.map((g) => String(g == null ? '' : g).trim()).filter(Boolean)
        : [];
      if (list.length > 0) doneActors[n] = list;
    }
  }

  return { eventId, coveredTo, endAt, doneActors };
}

/** 原账本内的事件事实；日期只作参考，是否收尾由已落实故事的语义判断给出。 */
// 按真实事件编号承接变异线索；嫌疑不等于事件已经启动。
export function mergeEventWatches(previous=[],updates=[]){
  const map=new Map();
  for(const row of [...(previous||[]),...(updates||[])]){
    if(!row || !/^E-\d+(?:\.\d+)?$/i.test(String(row.eventId||'')) || !['suspected','confirmed','dismissed'].includes(row.status))continue;
    if(row.status==='dismissed'){map.delete(row.eventId);continue;}
    map.set(row.eventId,{eventId:row.eventId,status:row.status,reason:String(row.reason||''),recordedAt:String(row.recordedAt||'')});
  }
  return [...map.values()];
}
/**
 * 规范化单个事件节点。
 *
 * 节点字段全部来自模型回信，残缺是常态——缺字段就留空，不整条丢弃：
 * 玩家要看的是「这件事推进到哪」，掉一个节点比显示一个字段为空更糟。
 * 但 nodeId 和 title 是识别锚点，缺了没法定位，才丢。
 */
export function normalizeEventNode(item,eventId='') {
  if(!item || typeof item!=='object')return null;
  const title=String(item.title || item.name || '').trim();
  if(!title)return null;
  const kind=item.kind==='created'||['created','新增'].includes(String(item.state||'').trim())?'created':'canon';
  const rawState=String(item.state || '').trim();
  const stateAliases={'已完成':'done','已发生':'done','完成':'done','done':'done','todo':'todo','未发生':'todo','待发生':'todo',
    'mutated':'mutated','变异':'mutated','changed':'mutated','created':'created','新增':'created'};
  const state=stateAliases[rawState] || rawState;
  // 新增节点必然是 created 状态；反过来 created 状态必然属于新增节点。
  const finalState=kind==='created'?'created':(['done','todo','mutated'].includes(state)?state:'todo');
  const prefix=String(eventId || '').trim().toUpperCase();
  const nodeId=String(item.nodeId || item.id || '').trim() || (prefix?prefix+'-N?':'');
  const timing=normalizeNodeTiming(item.timing);
  const markers=new Set((Array.isArray(item.milestones)?item.milestones:[]).map(row=>row?.id));
  markers.add(nodeId);
  return {nodeId,title:title.slice(0,24),kind,state:finalState,
    ...(item.prebuilt&&timing?{timing}:{}),
    ...(item.prebuilt&&Array.isArray(item.milestoneReceipts)?{milestoneReceipts:item.milestoneReceipts
      .filter(row=>markers.has(row?.id)&&row.eventId===eventId&&parseTimePoint(row.confirmedAt)!==null)
      .map(({id,eventId,evidence,confirmedAt,at})=>({id,eventId,confirmedAt,
        ...(typeof evidence==='string'&&evidence.trim()?{evidence,...(parseTimePoint(at)!==null?{at}:{})}:{})}))}:{}),
    ...(item.sourceOnly===true?{sourceOnly:true}:{}),
    ...(['applied','repaired','cancelled','pending','partial'].includes(item.prebuilt)?{prebuilt:item.prebuilt}:{}),
    ...(Array.isArray(item.contributions)?{contributions:structuredClone(item.contributions.filter(row=>
      row?.nodeId===nodeId&&row.eventId===eventId&&typeof row.sourceId==='string'&&['applied','withdrawn'].includes(row.status)))}:{}),
    ...(Array.isArray(item.pendingActors)?{pendingActors:item.pendingActors.map(String)}:{}),
    ...(typeof item.worldApplied==='boolean'?{worldApplied:item.worldApplied}:{}),
    ...(typeof item.worldPending==='boolean'?{worldPending:item.worldPending}:{}),
    ...(item.prebuilt && Array.isArray(item.impact?.actors) && Array.isArray(item.impact?.clearedActors)?{
      impact:{actors:item.impact.actors.filter(name=>typeof name==='string'),
        clearedActors:item.impact.clearedActors.filter(name=>item.impact.actors.includes(name))},
    }:{}),
    ...(Array.isArray(item.milestones)&&item.prebuilt?{milestones:item.milestones.filter(row=>row?.id&&row?.title).slice(0,24)
      .map(row=>({id:String(row.id),title:String(row.title),evidence:String(row.evidence||''),
        ...(normalizeNodeTiming(row.timing)?{timing:normalizeNodeTiming(row.timing)}:{}),
        ...(typeof row.dateBasis==='string'?{dateBasis:row.dateBasis}:{}),
        ...(Array.isArray(row.actors)?{actors:row.actors.map(String)}:{})}))}:{}),
    ...(item.prebuilt&&Array.isArray(item.milestones)&&item.milestones.some(row=>row?.id===item.reachedMilestoneId)?{reachedMilestoneId:item.reachedMilestoneId}:{}),
    at:String(item.at || item.time || '').trim(),
    ...(typeof item.estimatedAt==='string'&&item.estimatedAt.trim()?{estimatedAt:item.estimatedAt.trim()}:{}),
    ...(Array.isArray(item.actors)?{actors:item.actors.map(String).filter(Boolean)}:{}),
    original:String(item.original || '').trim(),
    cause:String(item.cause || item.reason || '').trim(),
    result:String(item.result || item.effect || '').trim(),
    handling:String(item.handling || item.handle || '').trim()};
}

/** 节点列表去重：同一 nodeId 只留一条，没编号的按标题去重。 */
export function normalizeEventNodes(value,eventId='') {
  const rows=Array.isArray(value)?value:[];
  const seen=new Set(),out=[];
  for(const raw of rows){
    const row=normalizeEventNode(raw,eventId);
    if(!row)continue;
    const key=row.nodeId && !row.nodeId.endsWith('-N?') ? row.nodeId : 'title:'+row.title;
    if(seen.has(key))continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function normalizeEventProgress(item) {
  if(!item || typeof item!=='object')return null;
  const eventId=String(item.eventId || item.code || '').trim();
  if(!/^E-\d+(?:\.\d+)?$/i.test(eventId))return null;
  // 未开始/待续属于「事件存在但本轮没有推进」，是合法判断，必须显式落成 ongoing 行；
  // 静默丢弃会被误报成漏项，把「状态词不合法」错说成「模型没判断」。
  const aliases={'进行中':'ongoing','已完成':'completed','变异':'changed','变异进行中':'changed','受阻':'blocked','已替代':'replaced',
    '已错过':'expired','机会已过':'expired','已取消':'cancelled','已失效':'cancelled','未开始':'ongoing','未发生':'ongoing','待续':'ongoing','未推进':'ongoing','尚未开始':'ongoing','pending':'ongoing','future':'ongoing','not_started':'ongoing'};
  const status=aliases[item.status] || item.status;
  if(!['ongoing','completed','changed','blocked','replaced','expired','cancelled'].includes(status))return null;
  const list=value=>Array.from(new Set((Array.isArray(value)?value:[]).map(x=>String(x || '').trim()).filter(Boolean)));
  const nodes=normalizeEventNodes(item.nodes,eventId);
  return {eventId:eventId.toUpperCase(),title:String(item.title || ''),startAt:String(item.startAt || ''),endAt:String(item.endAt || ''),coveredTo:String(item.coveredTo || ''),status,
    ...(typeof item.evidence==='string'&&item.evidence.trim()?{evidence:item.evidence.trim()}:{}),
    ...(Array.isArray(item.timingHistory)&&item.timingHistory.length?{timingHistory:item.timingHistory.filter(row=>row&&typeof row==='object').map(row=>({...row}))}:{}),
    resolved:typeof item.resolved==='boolean'?item.resolved:['completed','replaced','expired','cancelled'].includes(status),current:String(item.current || item.node || '').trim(),occurred:list(item.occurred),pending:list(item.pending),changes:list(item.changes),...(nodes.length?{nodes}:{}),reason:String(item.reason || item.basis || '').trim(),...(item.timingChange&&typeof item.timingChange==='object'?{timingChange:{kind:String(item.timingChange.kind||''),reason:String(item.timingChange.reason||''),actualStart:String(item.timingChange.actualStart||''),recordedAt:String(item.timingChange.recordedAt||''),referenceStart:String(item.timingChange.referenceStart||''),referenceEnd:String(item.timingChange.referenceEnd||'')}}:{})};
}
export function mergeEventProgress(previous,updates) {
  const map=new Map();
  for(const raw of [...(Array.isArray(previous)?previous:[]),...(Array.isArray(updates)?updates:[])]){
    const row=normalizeEventProgress(raw);if(!row)continue;const old=map.get(row.eventId);
    const history=[...(old?.timingHistory||[]),...(old?.timingChange?[old.timingChange]:[]),...(row.timingHistory||[]),...(row.timingChange?[row.timingChange]:[])];
    const timingHistory=[...new Map(history.map(entry=>[JSON.stringify(entry),entry])).values()];
    // 节点按 nodeId 合并：本轮给了新版本就覆盖旧版本，没提到的旧节点原样保留，
    // 否则每轮只回几个节点就会把前面已登记的节点冲掉，时间轴会往回缩。
    const mergedNodes=mergeEventNodes(old?.nodes,row.nodes);
    map.set(row.eventId,{...old,...row,title:row.title || old?.title || '',startAt:row.startAt || old?.startAt || '',endAt:row.endAt || old?.endAt || '',coveredTo:row.coveredTo || old?.coveredTo || '',current:row.current||old?.current||'',reason:row.reason||old?.reason||'',pending:Array.isArray(raw.pending)?row.pending:old?.pending||[],occurred:Array.from(new Set([...(old?.occurred || []),...row.occurred])),changes:Array.from(new Set([...(old?.changes || []),...row.changes])),...(mergedNodes.length?{nodes:mergedNodes}:{}),...(timingHistory.length?{timingHistory}:{} )});
  }
  return [...map.values()];
}

/**
 * 合并两轮的事件节点。
 *
 * 同一 nodeId 以新版本为准（进度只进不退），旧版本里有而新版本没提的节点保留。
 * 新增节点追加在后面，保持时间轴从左到右的阅读顺序。
 */
export function mergeEventNodes(previous,updates){
  const map=new Map();
  const keyOf=row=>row.nodeId && !String(row.nodeId).endsWith('-N?') ? row.nodeId : 'title:'+row.title;
  for(const row of [...(Array.isArray(previous)?previous:[]),...(Array.isArray(updates)?updates:[])]){
    if(!row || typeof row!=='object')continue;
    const key=keyOf(row);
    const old=map.get(key);
    // 新版本覆盖旧版本，但空字段不覆盖已有内容——模型这轮没写结果不该把上轮写的抹掉。
    const receipts=old?.milestoneReceipts||row.milestoneReceipts;
    map.set(key,old?{...old,...Object.fromEntries(Object.entries(row).filter(([,v])=>v!=='')),
      ...(receipts?{milestoneReceipts:[...new Map([...(row.milestoneReceipts||[]),...(old.milestoneReceipts||[])]
        .map(receipt=>[receipt.id,receipt])).values()]}:{})}:{...row});
  }
  return [...map.values()];
}
export function parseEventProgressRows(rows,events,previous=[],time='',confirmation=null) {
  // 同一事件重复出现只算一个；空编号不参与核对，否则模型无法回出对应行，会稳定误判为漏项。
  const codes=Array.from(new Set((events || []).map(e=>String(e.code || e.eventId || '').toUpperCase()).filter(Boolean)));
  // 有候选却一个可用编号都没有，等于无法核对；不能当成「本次没有事件」直接放行（那是把未判断当成已完成）。
  if(!codes.length && (events || []).length)return {ok:false,reason:'本次候选事件缺少可用编号（标题须含【E-xxx】或条目须带eventId），无法核对事件进度'};
  if(!codes.length && (rows===undefined || rows===null))return {ok:true,rows:[]};
  // 漏项/多项要能指出具体是哪几个事件，供同一请求纠正后重发；不把未判断当成已完成。
  if(!Array.isArray(rows))return {ok:false,reason:'事件进度须覆盖本次全部事件；未判断不能当作已完成',missing:codes.slice(),unexpected:[]};
  // 区分「模型根本没给这一行」与「给了但字段不合法」：后者若报成漏项，回喂给模型的纠正信息就是错的。
  const returned=new Set(),invalid=[];
  for(const raw of rows){
    const row=normalizeEventProgress(raw);
    if(row){returned.add(row.eventId);continue;}
    const rawId=String(raw && (raw.eventId || raw.code) || '').trim().toUpperCase();
    invalid.push(rawId || '（无编号）');
  }
  const missing=codes.filter(code=>!returned.has(code)),unexpected=[...returned].filter(code=>!codes.includes(code));
  if(invalid.length)return {ok:false,reason:'事件进度的编号或status不合法：'+invalid.join('、')+'；status只能用ongoing、changed、blocked、completed、replaced、expired、cancelled，未开始的事件也须显式返回一行',missing,unexpected,invalid};
  if(missing.length || unexpected.length)return {ok:false,reason:'事件进度须覆盖本次全部事件；未判断不能当作已完成',missing,unexpected};
  const result=[];
  for(const raw of rows){const row=normalizeEventProgress(raw),event=row && events.find(e=>String(e.code || e.eventId || '').toUpperCase()===row.eventId);
    /* ★★ 2026-11-02 全面复盘：原来 5 种情况挤成一句「不完整」。逐个拆开。 */
    if(!row)return {ok:false,reason:'事件进度里有一条空记录；每条都要给出 eventId、current、reason'};
    if(!event)return {ok:false,reason:'事件进度引用了不存在的事件编号：「'+String(row.eventId)+'」；本轮没有这个事件'};
    if(result.some(e=>e.eventId===row.eventId))return {ok:false,reason:'事件进度重复列出了同一个事件：「'+String(row.eventId)+'」出现了多次；每个事件只能判定一次'};
    if(!row.current)return {ok:false,reason:'事件进度缺少当前节点（current）：事件「'+String(row.eventId)+'」必须写明它现在推进到哪'};
    if(!row.reason)return {ok:false,reason:'事件进度缺少判断说明（reason）：事件「'+String(row.eventId)+'」必须说明为什么这样判定'};
    /* ★★ 2026-11-02 全面复盘：原来 3 个字段挤成一句。逐个指出缺哪个。 */
    if(!Array.isArray(raw.occurred))return {ok:false,reason:'事件进度缺少 occurred（已发生）数组：写成了 '+JSON.stringify(raw.occurred)+'；应为数组'};
    if(!Array.isArray(raw.pending))return {ok:false,reason:'事件进度缺少 pending（尚未发生）数组：写成了 '+JSON.stringify(raw.pending)+'；应为数组'};
    if(!Array.isArray(raw.changes))return {ok:false,reason:'事件进度缺少 changes（变异内容）数组：写成了 '+JSON.stringify(raw.changes)+'；应为数组'};
    if(row.resolved && row.pending.length)return {ok:false,reason:'仍有本事件未发生事项，不能同时标为已经收尾'};
    if(row.resolved && row.status==='ongoing')return {ok:false,reason:'进行中事件不能同时标为已经收尾'};
    if(row.status==='completed'&&row.nodes?.some(node=>node.state==='todo'))
      return {ok:false,reason:'事件「'+row.eventId+'」仍有进度指针未经过的节点，不能标为完成'};
    if(confirmation){
      const observed=confirmation.observed.find(item=>item.eventId===row.eventId);
      for(const node of observed?.nodes||[]){
        if(node.state!=='todo')continue;
        const update=Array.isArray(raw.nodes)?raw.nodes.find(item=>(item?.nodeId||item?.id)===node.nodeId):null;
        if(row.status==='completed'&&!update)return {ok:false,reason:node.nodeId+' 仍待确认，不能省略后关闭事件'};
        if(['done','mutated'].includes(update?.state)){
          const quote=typeof update.evidence==='string'?update.evidence.trim():'';
          if(!quote||!confirmation.evidence.some(body=>body.includes(quote)))
            return {ok:false,reason:node.nodeId+' 要从未发生改为已发生，须引用本轮玩家正文或已验收NPC视角正文中的实际完成原句'};
        }
      }
    }
    // 收尾必须有已发生事实；occurred 为空却标已完成，等于把「没有判断」当成「已经完成」。
    if(['expired','cancelled'].includes(row.status)&&!row.resolved)return {ok:false,reason:'已错过或取消的原路线应关闭，不能同时当作仍可续补'};
    if(row.resolved && !row.occurred.length&&!['expired','cancelled'].includes(row.status))return {ok:false,reason:'事件标为已收尾但occurred为空；没有实际发生的经历不能当作已经完成'};
    result.push({...row,title:event.title || row.title,startAt:String(event.referenceStart || event.time_start || event.startAt || ''),endAt:String(event.referenceEnd || event.time_end || event.endAt || ''),coveredTo:String(time || row.coveredTo),...(row.timingChange||event.timingChange?{timingChange:row.timingChange||event.timingChange}:{})});
  }
  // 节点登记暂不设任何校验，一律放行。
  // 玩家 2026-10-30：「关于这个点我们先不限制了。先记在方案里，
  // 我们目前不管他写得怎么样我们都直接放行。」
  // 原因：content_brief 是机翻抽取值，句子被逗号切碎，同样 4 句的事件复杂度可能差 5 倍，
  // 任何按数量判断的阈值都会误伤。节点是否写全，留给未来的「预制变量」机制彻底解决
  // （见 测试版优化方案/28-预制变量与节点方案.md）。
  return {ok:true,rows:mergeEventProgress(previous,result).filter(row=>codes.includes(row.eventId))};
}
export function renderEventProgress(rows) {
  if(!rows?.length)return '';
  return '【原账本已保存的事件事实进度】\n'+JSON.stringify(rows)+'\n原日期不是强制完成日期，不按时间百分比推剧情；承接实际节点和变异，不重复已发生内容。尚未发生项是参考与前提，不是必须照单完成的命令，NPC按当前性格、动机和处境自然行动，真实结果再记账。';
}
export const EVENT_PROGRESS_PROTOCOL='事件进度按实际故事判断，禁止按日期比例、原结束日期或预定目标推算结果。返回eventProgress数组，每个本次事件一次：{"eventId":"E-001","status":"ongoing","resolved":false,"current":"当下实际剧情节点","occurred":["实际已发生的事"],"pending":["尚未发生的参考事项及前提"],"changes":["实际变异及影响"],"nodes":[{"nodeId":"E-001-N1","title":"节点名（六个字以内）","kind":"canon","state":"done","at":"已确认的单一日期或空","estimatedAt":"推算的单一日期或空","actors":["实际涉及人物"],"original":"","cause":"","result":"","handling":""}],"reason":"结合所给真实故事与存档的判断依据"}。status可选ongoing、changed、blocked、completed、replaced、expired、cancelled；expired为机会窗口确已关闭且本路线错过，cancelled为前提破坏、取消或不再可能发生；后二者resolved=true，pending=[]，occurred可以为空，必须解释性质与真实依据，不能把系统欠写/欠落地当成世界中真的错过。仅日期过去不等于事件已完成，也不等于必可延期；有客观因果且机会仍成立才继续，限时机会正常结束可错过。原著正常过去且本应发生的历史仍应按实际轨迹补演，玩家没参与不等于整个事件取消。可附timingChange:{kind:early或delayed或expired或cancelled,reason,actualStart,recordedAt,referenceStart,referenceEnd}；实际日期未知留空，recordedAt是观察/记账时间，不伪造精确发生时刻。ongoing进行中，changed已经变异但仍可继续，blocked受阻，completed实际完成，replaced已被实际替代。resolved表示该事件是否真正收尾；受阻也可能仍待后续。已收尾时pending为空。不能把准备演出的动作当作已经发生；人物按其性格动机自由选择，偏离原著不是不合格，不许为满足事件进度强改故事。'
  +'nodes是给玩家看全貌的关键事件点，数量随事件实际转折决定，通常不超过6个，没有最低数。只登记能说清「这一刻改变了什么」的转折，例如关键关系成立、突破、出现或错过重要机会、局势实质改变。收徒、穿洞入谷、授入门功法若同属一个转折，只留「墨师收徒」；药圃日常、苦练未成只留叙事/occurred/pending。不要按NPC正文分段标点，不逐项复写occurred或pending。每个节点只有一个日期/时刻：at仅填已确认发生的点；estimatedAt填根据当前时间、因果和相邻节点推算的单日；无依据留空。两个字段都不能填起止范围；预计不得当作已发生。保留仍有意义的已有nodeId和已知日期。未来关键转折用state=todo，在original保留参考原文和成立前提，不当必然任务。已完成/取消事件不编未来节点。登记与时间估计不推动实际故事，节点不足不触发整轮重写。'
  /* ── 2026-11-01 玩家报：正文时间已到首个年表节点起始时间，进度指针仍显示
   *    「实际阶段：原著暂未启动」、节点「尚未触发」。
   *    玩家的判断：这是提示词没教清楚，不是代码 bug；并给出关键设定——
   *    「玩家没有主动去参与原著，就是原著完全当作背景故事在发生」。
   *
   *    所以补上「启动」与「完成」的区分：日期到了 → 算启动；做没做完 → 另说。
   *    之前只有「仅日期过去不等于已完成」这一句，模型就容易过度保守，
   *    把「时间已到但玩家没参与」误判成「尚未触发」。 */
  +'【启动和完成分开】参考日期只说明具备时间条件。同一天有前后两个事件时，未越过前一事件的进度不能启动后续事件，除非已有实际发生的依据。只将进度指针已经过或本轮实际结果证实完成的节点登记为done；部分发生仍为todo，可在current说明已确认的阶段。玩家不在场不等于原著停摆，普通补演可用已验收的NPC视角证明离场经历。';

/**
 * 规范化「上一轮做了什么」，供下一轮接上。
 *
 * @param {any} item
 * @returns {object|null}
 */
export function normalizeLastTurn(item) {
  if (!item || typeof item !== 'object') return null;

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };

  const names = (v) => (Array.isArray(v)
    ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    : []);

  return {
    at: String(item.at == null ? '' : item.at).trim(),
    rangeStart: String(item.rangeStart == null ? '' : item.rangeStart).trim(),
    rangeEnd: String(item.rangeEnd == null ? '' : item.rangeEnd).trim(),
    status: String(item.status == null ? '' : item.status).trim(),
    eventCount: num(item.eventCount),
    actorCount: num(item.actorCount),
    turnNo: num(item.turnNo),
    // 补成了谁
    wroteNames: names(item.wroteNames),
    ...(Array.isArray(item.updatedNames)?{updatedNames:names(item.updatedNames)}:{}),
    ...(Array.isArray(item.updatedIds)?{updatedIds:names(item.updatedIds)}:{}),
    ...(Array.isArray(item.biographyNames)?{biographyNames:names(item.biographyNames)}:{}),
    // 谁的哪些维度没补成
    gaps: item.gaps && typeof item.gaps === 'object' && !Array.isArray(item.gaps)
      ? { ...item.gaps }
      : {},
    // 进行中的事件续到哪
    openEventIds: names(item.openEventIds),
  };
}

/**
 * 记录一笔欠账。
 *
 * 同一段已经记过就累加 attempts，合并缺失维度，不重复记两条——
 * 否则连续失败会堆出一串一样的东西。
 *
 * @param {Array} debts 现有欠账
 * @param {object} debt
 * @returns {{debts:Array, added:boolean, gaveUp:boolean}}
 */
export function pushDebt(debts, debt) {
  const list = Array.isArray(debts) ? debts.map(cloneDebt) : [];
  const norm = normalizeDebt(debt);
  if (!norm) return { debts: list, added: false, gaveUp: false };

  const idx = list.findIndex((d) => sameRange(d, norm));
  if (idx >= 0) {
    list[idx].attempts = (Number(list[idx].attempts) || 0) + 1;
    if (norm.reason) list[idx].reason = norm.reason;
    // 合并缺失维度：之前欠的和这次欠的取并集
    list[idx].actors = mergeActorGaps(list[idx].actors, norm.actors);
    list[idx].eventIds = unionList(list[idx].eventIds, norm.eventIds);
    return { debts: list, added: false, gaveUp: list[idx].attempts >= CE_DEBT_MAX_ATTEMPTS };
  }

  const next = { ...norm, attempts: Math.max(1, norm.attempts) };
  list.push(next);
  return { debts: list, added: true, gaveUp: next.attempts >= CE_DEBT_MAX_ATTEMPTS };
}

/** 深拷一条欠账 */
function cloneDebt(d) {
  const src = d && typeof d === 'object' ? d : {};
  return {
    ...src,
    eventIds: Array.isArray(src.eventIds) ? src.eventIds.slice() : [],
    actors: { ...(src.actors || {}) },
  };
}

/** 合并两组「谁的什么维度」 */
function mergeActorGaps(a, b) {
  const out = { ...(a && typeof a === 'object' ? a : {}) };
  for (const [name, gaps] of Object.entries(b && typeof b === 'object' ? b : {})) {
    const prev = Array.isArray(out[name]) ? out[name] : [];
    out[name] = unionList(prev, gaps);
  }
  return out;
}

/** 两个数组取并集（保持顺序、去重） */
function unionList(a, b) {
  const out = [];
  const seen = new Set();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const t = String(x == null ? '' : x).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 两段欠账是否同一区间 */
function sameRange(a, b) {
  const aFrom = parseTimePoint(a && a.from);
  const aTo = parseTimePoint(a && a.to);
  const bFrom = parseTimePoint(b && b.from);
  const bTo = parseTimePoint(b && b.to);
  return aFrom === bFrom && aTo === bTo;
}

/**
 * 一段欠账补成之后清掉它。
 *
 * @param {Array} debts
 * @param {{start:string, end:string}} range
 * @returns {{debts:Array, cleared:Array}}
 */
export function clearCoveredDebts(debts, range) {
  const list = Array.isArray(debts) ? debts : [];
  const r = range && typeof range === 'object' ? range : {};
  const lo = parseTimePoint(r.start);
  const hi = parseTimePoint(r.end);
  // 区间解析不出来：不动欠账（保守，宁可留着让人看见，也不要误清）
  if (lo === null || hi === null) return { debts: list.map(cloneDebt), cleared: [] };

  const cleared = [];
  const kept = [];
  for (const d of list) {
    const from = parseTimePoint(d && d.from);
    const to = parseTimePoint(d && d.to);
    // 欠账自己解析不出来：留着
    if (from === null || to === null) {
      kept.push(cloneDebt(d));
      continue;
    }
    // 欠账区间被本轮完整覆盖 → 清掉
    const covered = from >= lo && to <= hi;
    if (covered) cleared.push(d);
    else kept.push(cloneDebt(d));
  }
  return { debts: kept, cleared };
}

/**
 * 拆出放弃的欠账（试太多次了，暂时不管）。
 * @param {Array} debts
 * @returns {{active:Array, abandoned:Array}}
 */
export function splitAbandonedDebts(debts) {
  const list = Array.isArray(debts) ? debts : [];
  const active = [];
  const abandoned = [];
  for (const d of list) {
    const attempts = Number(d && d.attempts) || 0;
    if (attempts >= CE_DEBT_MAX_ATTEMPTS) abandoned.push(d);
    else active.push(d);
  }
  return { active, abandoned };
}

/**
 * 把放弃的欠账渲染成给玩家看的话。
 * @param {Array} abandoned
 * @returns {string}
 */
export function formatAbandonedDebts(abandoned) {
  const list = Array.isArray(abandoned) ? abandoned : [];
  if (list.length === 0) return '';
  const lines = ['下面这些时段反复没补上，暂时放弃了（可稍后手动重试）：'];
  for (const d of list) {
    const who = Object.keys(d.actors || {});
    lines.push(`· ${d.from} → ${d.to}`
      + `${who.length > 0 ? `（${who.slice(0, 3).join('、')}${who.length > 3 ? '…' : ''}）` : ''}`
      + `${d.reason ? `：${d.reason}` : ''}，已尝试 ${d.attempts} 次`);
  }
  return lines.join('\n');
}

/**
 * 判断世界时间是否可以推进到目标值。
 *
 * 铁律：时间单调递增。倒退说明状态坏了，不能默默接受。
 *
 * @param {string} current
 * @param {string} target
 * @returns {{ok:boolean, reason:string}}
 */
export function checkTimeForward(current, target) {
  const a = parseTimePoint(current);
  const b = parseTimePoint(target);

  if (a === null) return { ok: false, reason: `当前世界时间无法解析：${current}` };
  if (b === null) return { ok: false, reason: `目标时间无法解析：${target}` };
  if (b < a) {
    return { ok: false, reason: `目标时间 ${target} 早于当前 ${current}，时间不许倒退` };
  }
  return { ok: true, reason: '' };
}

/**
 * 一轮结束后的账本提交计划。
 *
 * **这是「谁能写账本」的唯一入口**：只有走到这里、并且全部成功，
 * 才产出新账本。任何一步失败就不调用它，账本原样不动。
 *
 * @param {object} input
 * @param {object} input.ledger 当前账本
 * @param {string} input.confirmedTime 正文确认后的世界时间
 * @param {{start:string, end:string}} [input.handledRange] 本轮实际处理到的区间
 * @param {boolean} input.succeeded 本轮是否真的成功了
 * @param {object} [input.failure] 失败信息 { reason }
 * @param {object} [input.turn] 本轮做了什么 { status, eventCount, actorCount, wroteNames, gaps, openEvents }
 * @returns {object}
 */
export function planLedgerCommit(input) {
  const src = input && typeof input === 'object' ? input : {};
  const current = normalizeLedger(src.ledger).ledger;

  const refusedBase = {
    next: current,
    changed: false,
    cleared: [],
    added: [],
    abandoned: [],
    keptOpen: current.openEvents,
    refused: '',
  };

  if (!src.succeeded) {
    // 没成功：账本一个字都不能动
    const why = String(src.failure && src.failure.reason || '').trim();
    return {
      ...refusedBase,
      refused: why ? `本轮未成功，账本不动：${why}` : '本轮未成功，账本不动',
    };
  }

  const range = src.handledRange && typeof src.handledRange === 'object'
    ? src.handledRange
    : null;
  const confirmedTime = String(src.confirmedTime == null ? '' : src.confirmedTime).trim();

  if (!confirmedTime) {
    return { ...refusedBase, refused: '没有确认的世界时间，账本不动' };
  }

  const forward = checkTimeForward(current.worldTime, confirmedTime);
  if (!forward.ok) {
    return { ...refusedBase, refused: forward.reason };
  }

  // ---- 清掉已被覆盖的欠账 ----
  const clearResult = range
    ? clearCoveredDebts(current.debts, range)
    : { debts: current.debts.map(cloneDebt), cleared: [] };

  // ---- 本轮又欠了什么 ----
  const turn = src.turn && typeof src.turn === 'object' ? src.turn : {};
  const gaps = turn.gaps && typeof turn.gaps === 'object' ? turn.gaps : {};
  const hasGaps = Object.keys(gaps).length > 0;
  if(hasGaps)return {...refusedBase,pending:gaps,refused:'本轮补演仍有未完成内容，须在本轮继续处理；账本仅监督，不推进水位或转成下一轮欠账。'};

  let debts = clearResult.debts;
  let added = [];
  let abandoned = [];

  if (hasGaps && range) {
    const r = pushDebt(debts, {
      from: range.start,
      to: range.end,
      eventIds: Array.isArray(turn.unfinishedEventIds) ? turn.unfinishedEventIds : [],
      actors: gaps,
      reason: String(turn.gapReason || '部分人物状态没补成'),
      attempts: Math.max(0, ...clearResult.cleared.filter(d => sameRange(d, {from:range.start,to:range.end})).map(d => Number(d.attempts) || 0)) + 1,
    });
    debts = r.debts;
    if (r.added) added.push(debts[debts.length - 1]);
  }

  // ---- 进行中的事件续到哪 ----
  // 时间水位与剧情收尾分开；仅实际故事确认收尾的事件移出进行中清单。
  const excluded=new Set(turn.unreachedEventIds||[]);
  const eventProgress=mergeEventProgress(current.eventProgress,turn.eventProgress).filter(row=>!excluded.has(row.eventId)||
    row.resolved||row.occurred?.length||row.nodes?.some(node=>node.state!=='todo'||node.reachedMilestoneId||node.contributions?.some(entry=>entry.status==='applied')));
  const openEvents = normalizeOpenEventsList(
    (Array.isArray(turn.openEvents)?turn.openEvents:[]).filter(row=>!excluded.has(row?.eventId)),
    (current.openEvents||[]).filter(row=>!excluded.has(row.eventId)),
    confirmedTime,
    eventProgress,
  );

  // ---- 上一轮记录 ----
  const lastTurn = normalizeLastTurn({
    at: new Date().toISOString(),
    rangeStart: range ? range.start : '',
    rangeEnd: range ? range.end : '',
    status: String(turn.status || ''),
    eventCount: turn.eventCount,
    actorCount: turn.actorCount,
    turnNo: Number(turn.turnNo) || current.turnNo + 1,
    wroteNames: turn.wroteNames,
    gaps,
    openEventIds: openEvents.map((e) => e.eventId),
  });

  // 黄区钩子：跟账本一起存。
  //
  // turn 里带了本轮结束后的钩子快照（起头/推进/收尾/失效都算过之后），
  // 没带就沿用账本里原有的，不能凭空清空。
  const nextHooks = Array.isArray(turn.hooks)
    ? turn.hooks.map((h) => normalizeHookRow(h)).filter(Boolean)
    : (Array.isArray(current.hooks) ? current.hooks : []);

  const next = {
    version: CE_LEDGER_VERSION,
    worldTime: confirmedTime,
    turnNo: Number(turn.turnNo) || current.turnNo + 1,
    debts,
    openEvents,
    eventProgress,
    ...(current.prebuiltActorDifferences?.length?{prebuiltActorDifferences:current.prebuiltActorDifferences}:{}),
    ...((current.eventWatches?.length||turn.eventWatches?.length)?{eventWatches:mergeEventWatches(current.eventWatches,turn.eventWatches).filter(row=>!eventProgress.some(p=>p.eventId===row.eventId&&p.resolved))}:{}),
    hooks: nextHooks,
    ...(current.mutationNotes?.length?{mutationNotes:current.mutationNotes}:{}),
    lastTurn,
  };

  return {
    next,
    changed: true,
    cleared: clearResult.cleared,
    added,
    abandoned,
    keptOpen: openEvents,
    refused: '',
  };
}

/**
 * 把「本轮进行中的事件」与「账本里原有的」合成一份。
 *
 * 规则：
 *   · 本轮提到的事件 → 用本轮的（coverTo 更靠后）
 *   · 原有待核事项继续带给本轮判断，不代表机会必然仍然存在
 *   · 仅实际判断收尾、错过、取消或替代 → 移出待续；参考日期不自动决定结果
 *
 * @param {Array} turnOpen 本轮产出的
 * @param {Array} prevOpen 账本里原有的
 * @param {string} [turnEndTime] 本轮终点。给了就能判断「本轮有没有越过某条事件的结束时间」
 * @returns {Array}
 */
export function normalizeOpenEventsList(turnOpen, prevOpen, turnEndTime,eventProgress=[]) {
  const map = new Map();

  for (const item of (Array.isArray(prevOpen) ? prevOpen : [])) {
    const n = normalizeOpenEvent(item);
    if (n) map.set(n.eventId, n);
  }
  for (const item of (Array.isArray(turnOpen) ? turnOpen : [])) {
    const n = normalizeOpenEvent(item);
    if (!n) continue;
    const prev = map.get(n.eventId);
    // 取更靠后的覆盖点（走得更远的那个）
    if (prev) {
      const a = parseTimePoint(prev.coveredTo);
      const b = parseTimePoint(n.coveredTo);
      if (a !== null && b !== null && a > b) continue;
    }
    map.set(n.eventId, n);
  }

  const closed=new Set((eventProgress || []).filter(row=>row.resolved===true).map(row=>row.eventId));
  for(const row of eventProgress || [])if(!row.resolved && row.coveredTo)map.set(row.eventId,{...(map.get(row.eventId) || {doneActors:{}}),eventId:row.eventId,coveredTo:row.coveredTo,endAt:row.endAt || map.get(row.eventId)?.endAt || ''});
  // 时间经过不证明剧情完成，只有实际故事确认收尾才能移出。
  const out = [];
  for (const n of map.values()) {
    if(closed.has(n.eventId))continue;

    out.push(n);
  }
  return out;
}

/**
 * 用账本里记的「进行中到哪儿了」，判断一条事件还剩多少没处理。
 *
 * @param {object} ledger
 * @param {string} eventId
 * @returns {{open:boolean, coveredTo:string, endAt:string, doneActors:object}|null}
 */
export function readOpenEvent(ledger, eventId) {
  const id = String(eventId == null ? '' : eventId).trim();
  if (!id) return null;
  const list = Array.isArray(ledger && ledger.openEvents) ? ledger.openEvents : [];
  const found = list.find((e) => e && e.eventId === id);
  if (!found) return null;
  return {
    open: true,
    coveredTo: found.coveredTo,
    endAt: found.endAt,
    doneActors: { ...(found.doneActors || {}) },
  };
}

/**
 * 把账本渲染成一段给模型看的「上一轮补到哪了」。
 *
 * 这是玩家和模型都能读的形态。空账本返回空串。
 *
 * @param {object} ledger
 * @returns {string}
 */
export function renderLedgerBrief(ledger) {
  const l = normalizeLedger(ledger).ledger;
  const lines = [];

  if (l.worldTime) lines.push(`世界时间：${l.worldTime}`);

  if (Array.isArray(l.openEvents) && l.openEvents.length > 0) {
    lines.push('');
    lines.push('还在进行中的原著事件（只处理到 midway，别当成已经走完）：');
    for (const e of l.openEvents) {
      lines.push(`· ${e.eventId}：已处理到 ${e.coveredTo}`
        + `${e.endAt ? `，整条到 ${e.endAt}` : ''}`);
      const done = Object.keys(e.doneActors || {});
      if (done.length > 0) lines.push(`  已补过：${done.join('、')}`);
    }
  }

  if (Array.isArray(l.debts) && l.debts.length > 0) {
    lines.push('');
    lines.push('欠着的（下一轮要补）：');
    for (const d of l.debts) {
      const who = Object.entries(d.actors || {})
        .map(([n, gaps]) => `${n}（${gaps.join('、')}）`)
        .join('；');
      lines.push(`· ${d.from} → ${d.to}`
        + `${who ? `：${who}` : ''}`
        + `${d.attempts > 0 ? `，已试 ${d.attempts} 次` : ''}`);
    }
  }

  if (l.lastTurn) {
    const t = l.lastTurn;
    lines.push('');
    lines.push(`上一轮：${t.rangeStart || '?'} → ${t.rangeEnd || '?'}`
      + `${t.status ? `（${t.status}）` : ''}`);
    if (Array.isArray(t.wroteNames) && t.wroteNames.length > 0) {
      lines.push(`  补成了：${t.wroteNames.join('、')}`);
    }
    const gapNames = Object.keys(t.gaps || {});
    if (gapNames.length > 0) {
      lines.push(`  没补成：${gapNames.join('、')}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// 宿主读写
// ============================================================

/**
 * 从宿主读账本。
 *
 * **优先从快照读**（跟着回退走）。
 * 快照里没有，才去读旧版全局键做一次性迁移。
 * 都没有就按 fallback 建空账本——冷启动本来就没有，不是错误。
 *
 * @param {object} host CEHost（需 storageGet / stateRead）
 * @param {object} [fallback] { worldTime, snapshot }
 * @returns {Promise<{ledger:object, repaired:boolean, dropped:Array, migrated:boolean}>}
 */
export async function loadLedger(host, fallback = {}) {
  const fromSnapshot = readLedgerFromSnapshot(fallback.snapshot);
  if (fromSnapshot) {
    const norm = normalizeLedger(fromSnapshot, fallback);
    return { ...norm, migrated: false };
  }

  // 快照里没有 → 试旧版全局键（迁移）
  if (host && typeof host.storageGet === 'function') {
    let raw = null;
    try {
      raw = await host.storageGet(CE_LEDGER_LEGACY_KEY);
    } catch {
      raw = null;
    }
    if (raw && typeof raw === 'object') {
      const norm = normalizeLedger(raw, fallback);
      return { ...norm, migrated: true };
    }
  }

  // 从宿主当前状态里再找一次（有的快照形态是整包）
  const fromState = readLedgerFromSnapshot(safeStateRead(host));
  if (fromState) {
    const norm = normalizeLedger(fromState, fallback);
    return { ...norm, migrated: false };
  }

  return { ...normalizeLedger(null, fallback), migrated: false };
}

/** 从快照对象里抠出账本 */
export function readLedgerFromSnapshot(snapshot) {
  if (!snapshot) return null;
  let obj = snapshot;

  // 快照可能是 JSON 字符串
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  // 常见形态：{ currentState, canonLedger, ... }
  if (obj[CE_LEDGER_SNAPSHOT_KEY] && typeof obj[CE_LEDGER_SNAPSHOT_KEY] === 'object') {
    return obj[CE_LEDGER_SNAPSHOT_KEY];
  }
  if(obj.currentState && typeof obj.currentState[CE_LEDGER_SNAPSHOT_KEY]==='object')return obj.currentState[CE_LEDGER_SNAPSHOT_KEY];
  if(obj.state && obj.state.currentState && typeof obj.state.currentState[CE_LEDGER_SNAPSHOT_KEY]==='object')return obj.state.currentState[CE_LEDGER_SNAPSHOT_KEY];
  // 也可能直接就是账本
  if (obj.worldTime !== undefined && (obj.debts !== undefined || obj.version !== undefined)) {
    return obj;
  }
  // 或者挂在 state 下
  if (obj.state && typeof obj.state === 'object'
    && obj.state[CE_LEDGER_SNAPSHOT_KEY]) {
    return obj.state[CE_LEDGER_SNAPSHOT_KEY];
  }
  return null;
}

/** 安全地取宿主当前状态 */
function safeStateRead(host) {
  try {
    return host && typeof host.stateRead === 'function' ? host.stateRead() : null;
  } catch {
    return null;
  }
}

/**
 * 把账本写进「即将保存的快照」。
 *
 * **注意：这不是「存到某个全局键」，是把账本挂到快照对象上。**
 * 调用方拿到返回值后，把它随同 stateSnapshot 一起落库，
 * 账本就会跟着这一层快照走，回退时自动跟着回去。
 *
 * @param {object} snapshot 即将保存的快照对象（会被浅拷一份，不改原对象）
 * @param {object} ledger
 * @returns {object} 挂好账本的快照
 */
export function attachLedgerToSnapshot(snapshot, ledger) {
  const base = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
  const norm = normalizeLedger(ledger).ledger;
  base[CE_LEDGER_SNAPSHOT_KEY] = norm;
  return base;
}

/**
 * 旧接口：把账本写到全局键。
 *
 * **已弃用**。留着只为了不打断既有调用；新代码请用 attachLedgerToSnapshot。
 *
 * @deprecated
 */
export async function saveLedger(host, ledger) {
  if (!host || typeof host.storageSet !== 'function') {
    return { ok: false, reason: '宿主不支持存储' };
  }
  try {
    await host.storageSet(CE_LEDGER_LEGACY_KEY, normalizeLedger(ledger).ledger);
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: String(error && error.message || error) };
  }
}

/**
 * 从「还没成功的计划」确认提交。
 *
 * 编排器只算计划（succeeded=false），调用方在变量落地 + 快照保存
 * 都成功之后，用真实结果重算一次，才写。
 *
 * @param {object} input
 * @param {object} input.pendingPlan 编排器给的 next
 * @param {string} input.confirmedTime
 * @param {object} [input.handledRange]
 * @param {object} [input.turn]
 * @returns {object}
 */
export function confirmLedgerCommit(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return planLedgerCommit({
    ledger: src.pendingPlan || src.ledger || createEmptyLedger(),
    confirmedTime: src.confirmedTime,
    handledRange: src.handledRange,
    succeeded: true,
    turn: src.turn || {},
  });
}
