// ============================================================
// 原著指导（正文前唯一环节）
//
// 依据：
//   总设计 §2.1   「这一刻原著是什么样，这轮该怎么演」→ 正文端约束文字
//                 玩家可见：否　　能否写存档：**否**
//   总设计 §3.1   时序第 ④ 步，在正文之前，模型一次
//   08-13 §6.1    失败降级：正文照常生成，本轮不注入，不推进任何进度
//   原版 service.ts（143KB，权威）
//
// ------------------------------------------------------------
// 最终口径（用户 2026-10-21 看过原版源码后的纠正）：
//
//   **原著指导只针对当前发生的这一个年表事件。**
//
//   不是整段区间，不是全部人物，不是年表大放送。
//   是：这一刻世界线卡在哪个 E-###，这一个事件该怎么写进这一轮正文。
//
// ------------------------------------------------------------
// 原版怎么做的（我照抄的部分，逐条都能在 service.ts 找到）：
//
//   ① 用**少数几条候选**定位，不端全量（593-599）
//   ② 让模型判断「世界线卡在哪个 E-### 的之前/之中/之后」
//   ③ 区分三样：前置背景 / 当前命中 / 后置伏笔
//   ④ 判断能不能引入，看**存档事实有没有让它不可能**，
//      不看原著日期过没过（1365）
//   ⑤ 世界线定位只用事实锚点，**禁止**把存档日期与年表日期做换算（1361-1373）
//
// ------------------------------------------------------------
// 产出（给正文的边界）：
//
//   mainChatInjection 只写「本轮正文立刻要遵守的设定边界」，
//   2-4 条短句，避免人物小传（原版 1408-1413）。
// ============================================================

import { resolvePrompt, fillTemplate } from './prompt-registry.js';
import { withRetry } from './retry.js';
import { parseJsonLoose } from './diff.js';
import {
  pickNodeCandidates,
  resolveCurrentNode,
  renderNodeMaterial,
  CE_NODE_POSITION,
} from './canon-node.js';
import { collectHostMaterial, materialReportLines, buildMaterialRequiredScope } from './host-material.js';
import { renderEventMaterial,parseCharacterTags } from './vector-input.js';
import { packRequestMaterials, normalizeRequestLimits } from './request-budget.js';
import { entrySpan, parseTimePoint, parseTimePrecision } from './interval.js';

/**
 * 取「当前时间点该检索的年表事件」。
 *
 * 玩家 2026-10-30 定的完整口径——原著指导要帮正文衔接原著剧情，
 * 所以四种位置都要有依据：
 *
 *   ① 时间点落在事件内       → 命中的**全部**事件（同一天可能多条，全要）
 *   ② 在所有事件之前         → **最近的那个未来事件**（给正文写铺垫）
 *   ③ 在所有事件之后         → **最后那个已发生的事件**（给正文做延伸）
 *   ④ 落在两条事件之间的空白 → **前后各一条**（给正文做过渡）
 *
 * 一句话：让指导始终有「上一段」和「下一段」可比，而不是一片空白。
 *
 * 精度处理（玩家 2026-10-30 定）：
 *   时间点精度为 day/hour/minute → 按**点**匹配（原生行为）
 *   时间点精度为 month/year      → 按**整月/整年**与事件跨度求相交
 *   这样「大概 8 月」会把 8 月内及跨越 8 月的全部原著事件查出来，
 *   而不是只查 8月20日 那天碰巧命中的那一条。
 *
 * 返回数组按起始时间升序，起始相同保持年表原顺序，保证检索词稳定可复现。
 */
function resolveEventsAtPoint(timeline, worldTime, precision) {
  const now = parseTimePoint(worldTime);
  if (now === null) return [];
  const list = Array.isArray(timeline) ? timeline : [];

  // 按精度把「点」展开成「区间」：月级取整月，年级取整年。
  const probe = monthOrYearWindow(now, precision);

  const hits = [];      // 与该区间相交
  const before = [];    // 完全在区间之后
  const after = [];     // 完全在区间之前

  for (const entry of list) {
    const span = entrySpan(entry);
    if (!span) continue;
    if (span.min <= probe.max && span.max >= probe.min) hits.push({ entry, span });
    else if (span.min > probe.max) before.push({ entry, span });
    else after.push({ entry, span });
  }

  const byStart = (a, b) => a.span.min - b.span.min;

  // ① 相交：全部纳入
  if (hits.length) return hits.sort(byStart);

  // ② 全部事件之前：最近的未来事件（铺垫）
  //    事件跨度可能重叠，取「起点最早」的那条作为下一段。
  if (!after.length && before.length) {
    return [before.sort(byStart)[0]];
  }

  // ③ 全部事件之后：最后那条已结束的事件（延伸）
  //    after 里按结束时间取最晚的一条。
  if (!before.length && after.length) {
    return [after.sort((a, b) => b.span.max - a.span.max)[0]];
  }

  // ④ 落在空白处：前后各一条（过渡）
  const prev = after.sort((a, b) => b.span.max - a.span.max)[0];
  const next = before.sort(byStart)[0];
  return [prev, next].filter(Boolean);
}

/**
 * 把时间点按精度展开成比较区间。
 *
 * 时间刻度沿用 interval.js:71 的口径：
 *   (((year*12 + month-1) * 31 + day-1) * 24 + hour) * 60 + minute
 * 即「每月固定 31 天、每天 24 小时、每小时 60 分」，不是真实日历。
 *
 * 月级：该月 31 天的整段（与 entrySpan 对 month 精度的补尾口径一致）。
 * 年级：该年 12 个整月。
 * 日级及更细：原样返回（min === max === 该点）。
 */
function monthOrYearWindow(now, precision) {
  const p = String(precision || '').trim();
  const MIN_PER_DAY = 24 * 60;
  const PER_MONTH = 31 * MIN_PER_DAY;
  if (p === 'month') {
    const start = Math.floor(now / PER_MONTH) * PER_MONTH;
    return { min: start, max: start + PER_MONTH - 1 };
  }
  if (p === 'year') {
    const PER_YEAR = 12 * PER_MONTH;
    const start = Math.floor(now / PER_YEAR) * PER_YEAR;
    return { min: start, max: start + PER_YEAR - 1 };
  }
  return { min: now, max: now };
}

/** 五类产出的稳定键名（面板与校验都认这个） */
export const CE_GUIDANCE_PARTS = {
  facts: '已成立',
  pending: '本轮该发生',
  notYet: '尚未发生',
  invisible: '玩家看不见',
  doNotForce: '不强拉回',
};

/**
 * 取生效的提示词（玩家改过就用玩家的）。
 *
 * 默认值唯一来源是 prompt-registry 的 canonGuidance.build——
 * 面板展示的默认内容与这里实际发出的是同一份，不会漂移。
 *
 * @param {object} [overrides]
 * @returns {string}
 */
export function guidancePrompt(overrides) {
  return resolvePrompt('canonGuidance', {}, overrides);
}

/**
 * 组装原著指导的输入。
 *
 * **只围绕当前这一个节点**，不塞整段年表。
 *
 * @param {object} input
 * @param {object} [input.node] 当前节点
 * @param {Array} [input.candidates] 候选（用来给前置/后置）
 * @param {string} [input.playerInput]
 * @param {string} [input.worldTime]
 * @param {string} [input.location]
 * @param {Array} [input.onScene] 在场人物
 * @returns {string}
 */
export function buildGuidanceInput(input = {}) {
  return renderNodeMaterial({
    node: input.node,
    candidates: input.candidates,
    worldTime: input.worldTime,
    location: input.location,
    playerInput: input.playerInput,
    onScene: input.onScene,
  });
}

/**
 * 解析模型的五类输出。
 *
 * 宽松：模型漏了一类就当空数组，不因为缺一项整份作废
 * （原著指导失败不该拖停正文）。但**五类全空**视为失败——
 * 那说明它没在干活，注入进去只会误导正文。
 *
 * @param {string} raw
 * @returns {{ok:boolean, guidance:object|null, reason:string}}
 */
export function parseGuidance(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, guidance: null, reason: '没有解析出 JSON 对象' };
  }

  const guidance = {};
  let total = 0;
  for (const [key, label] of Object.entries(CE_GUIDANCE_PARTS)) {
    const list = parsed[label];
    const items = Array.isArray(list)
      ? list.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
      : [];
    guidance[key] = items;
    total += items.length;
  }

  // 原版还要求一个总判断：世界线偏差等级
  if (parsed.世界线偏差 && typeof parsed.世界线偏差 === 'object') {
    guidance.deviation = {
      level: String(parsed.世界线偏差.level || '').trim(),
      conclusion: String(parsed.世界线偏差.conclusion || '').trim(),
    };
  }

  if (total === 0) {
    return { ok: false, guidance: null, reason: '五类全空，等于没给边界' };
  }

  return { ok: true, guidance, reason: '' };
}

/**
 * 把五类渲染成正文端能直接吃的约束文字。
 *
 * 输出为空字符串 = 不注入（调用方据此跳过）。
 *
 * ------------------------------------------------------------
 * 「正文 AI 怎么知道这段是干什么的」（用户 2026-10-21 追问）：
 *
 *   它被追加在正文提示词的**最末尾**，前面是「近期事态回顾」
 *   「世界状态快照」「玩家当前装备」「世界书」，然后才是这一段。
 *
 *   一份提示词里有四五块内容，模型没有一个天然的「这块是规矩」
 *   的认知。所以这一段必须自己把身份说清楚：
 *
 *     ① 开头就声明「这是什么、和刚才那些不一样在哪」
 *        ——前面是资料，这一块是**必须服从的约束**
 *     ② 每一类小标题写成祈使句（「不许…」「必须…」），
 *        不是名词短语。名词短语会被当成资料读懂，祈使句会被当规矩执行
 *     ③ 明确优先级：玩家已经写定的 > 这里的约束 > 模型自己的发挥
 *     ④ 结尾给一句可执行的自查，让它写完能对一遍
 *
 *   这三条是照「怎么让模型把一段文字当规矩而不是当背景」来的：
 *   声明身份、祈使句、优先级、自查——少任何一条，模型都可能把它
 *   当成可参考的世界设定，写的时候随手忽略。
 *
 * 原版要求：**只能 2-4 条短句**，避免人物小传（service.ts:1408-1413）。
 *
 * @param {object|null} guidance
 * @param {object} [options]
 * @param {string} [options.nodeTitle] 当前节点标题（让 AI 知道这一轮在演什么）
 * @returns {string}
 */
export function renderGuidanceForStory(guidance, options = {}) {
  if (!guidance || typeof guidance !== 'object') return '';

  const blocks = [];
  const order = ['facts', 'pending', 'notYet', 'invisible', 'doNotForce'];

  // 小标题写成祈使句：模型会把它当规矩执行，而不是当资料读懂。
  const headers = {
    facts: '下面这些是已经成立的，你不许推翻',
    pending: '这一轮必须写到的',
    notYet: '这些还没到，你不许提前结算、不许剧透',
    invisible: '这些玩家不可能知道，不许写成他知道了',
    doNotForce: '这些玩家已经改了，不许硬拗回原著',
  };

  for (const key of order) {
    const items = Array.isArray(guidance[key]) ? guidance[key] : [];
    if (items.length === 0) continue;
    blocks.push(`【${headers[key]}】`);
    items.forEach((t) => blocks.push(`· ${t}`));
    blocks.push('');
  }

  if (blocks.length === 0) return '';

  const nodeTitle = String(options.nodeTitle == null ? '' : options.nodeTitle).trim();

  const lines = [
    '## 原著边界（这是本轮必须服从的约束，不是资料）',
    '',
    '前面那些段是「世界现在是什么样」的资料，供你参考。',
    '**这一段不一样**：它是原著在这一刻立下的边界，是命令，不是参考。',
    '写的时候按它来；和它冲突时，以它为准。',
    '',
  ];

  if (nodeTitle) {
    lines.push(`这一轮对应的原著事件：${nodeTitle}`);
    lines.push('');
  }

  lines.push('优先级，从高到低：');
  lines.push('  1. 玩家这一轮明确要做的事 —— 最高，不许为了贴合原著去否定玩家');
  lines.push('  2. 下面的边界 —— 写的时候必须守住');
  lines.push('  3. 你自己的发挥 —— 只在前两条不冲突的空白处发挥');
  lines.push('');

  lines.push(...blocks);

  if (guidance.deviation && guidance.deviation.conclusion) {
    lines.push(`【世界线已经偏到：${guidance.deviation.level || '未定'}】`);
    lines.push(guidance.deviation.conclusion);
    lines.push('');
  }

  lines.push('【写完之后对着这几条自查】');
  lines.push('· 有没有写到「不许推翻」里的任何一条？');
  lines.push('· 「必须写到的」碰上了吗？没碰上，是这一轮本来就没到，还是你漏了？');
  lines.push('· 有没有把「不许提前结算」的事提前写出来？');
  lines.push('· 有没有让玩家知道了「他不可能知道」的事？');

  return lines.join('\n').trimEnd();
}

/**
 * 跑一次原著指导。
 *
 * **只针对当前这一个节点**（用户 2026-10-21 最终口径）。
 * 失败一律降级为「不注入」，**绝不停轮**（08-13 §6.1）。
 *
 * ------------------------------------------------------------
 * 资料怎么进提示词（用户 2026-10-21 纠正过）：
 *
 *   **资料段本身就在提示词模板里，用占位符占位。**
 *   不把资料硬拼在模板后面。
 *
 *   原版 service.ts:607-613 就是这么做的：
 *     `【当前时间】\n${tl.currentTime || '未知'}`
 *     `【RAG 检索结果】\n${truncateText(guidanceRagContext || '无', 8000)}`
 *
 *   这样做的好处：
 *     ① 玩家在面板上看得见「哪段资料从哪进」
 *     ② 玩家能调顺序、加自己的话、删掉某一段
 *     ③ 取不到时占位符换成「无」，模型知道「这段是空的」而不是「忘了写」
 * ============================================================
 *
 * @param {object} input
 * @param {object} input.host CEHost（需 llmCall）
 * @param {Array<object>} [input.timeline] 年表
 * @param {string} [input.worldTime]
 * @param {string} [input.playerInput]
 * @param {string} [input.location]
 * @param {Array} [input.onScene]
 * @param {object} [input.options]
 * @param {number} [input.options.maxCandidates=6]
 * @param {object} [input.options.promptOverrides]
 * @param {Record<string,boolean>} [input.options.materials] 资料开关
 * @returns {Promise<{
 *   ok:boolean, text:string, guidance:object|null, node:object|null,
 *   candidates:Array, reason:string, materialReport:Array
 * }>}
 */
export async function runGuidance(input = {}) {
  const host = input.host;
  const options = input.options || {};
  const overrides = options.promptOverrides || null;

  if (!host || typeof host.llmCall !== 'function') {
    return {
      ok: false, text: '', guidance: null, node: null, candidates: [],
      reason: '缺少 llmCall', materialReport: [],
    };
  }

  let capacityContext={};
  try {
  // ---------- 定位：这一刻卡在哪个年表事件 ----------
  const candidates = pickNodeCandidates({
    timeline: input.timeline,
    worldTime: input.worldTime,
    playerInput: input.playerInput,
    maxCandidates: options.maxCandidates,
    // 焦点里的人和事件优先。
    //
    // 光按「离现在多近」排，玩家闭关二十年出来的那一刻，
    // 排在前面的是时间上最近的事，不是**跟他有关**的事。
    // 用户 2026-10-21：「这一轮剧情会涉及的原著相关的人、事、物
    //   才需要指导怎么合理的写在剧情里，本质是这个」
    focus: input.focus,
  });

  const storyTimeline=input.storyTimeline && typeof input.storyTimeline==='object'?input.storyTimeline:null;
  const anchorCode=String(storyTimeline && storyTimeline.currentEventCode || '').trim();
  const anchorEntry=anchorCode && (input.timeline || []).find(entry=>String(entry.title || '').match(/【\s*(E-\d+(?:\.\d+)?)\s*】/i)?.[1].toUpperCase()===anchorCode.toUpperCase());
  const node = anchorEntry?pickNodeCandidates({timeline:[anchorEntry],worldTime:input.worldTime})[0]:resolveCurrentNode(candidates);

  // 一条年表都落不上 → 这一刻不在原著线上，不需要指导
  if (!node) {
    return {
      ok: true, text: '', guidance: null, node: null, candidates: [],
      reason: '这一刻没有落到任何年表事件上，正文照常写',
      materialReport: [],
    };
  }

  // ---------- 取资料 ----------
  // 检索查询用「节点材料 + 玩家输入」，这是原版的做法：
  // 不拿整段正文去查，而是拿「这一刻该核对什么」去查。
  const selectedNode=renderEventMaterial(node.entry,{mode:options.materialMode || 'current_only',isCurrent:node.position===CE_NODE_POSITION.during,maxChars:0});
  const requiredScope=input.materialState?.requiredScope || input.requiredScope || buildMaterialRequiredScope({timeline:input.timeline,canonicalNames:input.canonicalNames,events:[...new Set([node.entry,...(input.storyTimeline?.entries || []),...(input.focus?.events || [])])],focus:input.focus,priorNpcState:input.priorNpcState,playerInput:input.playerInput,location:input.location});
  const nodeMaterial = buildGuidanceInput({
    node:{...node,entry:{...node.entry,content_brief:selectedNode.brief,content_original:selectedNode.primarySource==='original'?selectedNode.original:''}},
    candidates,
    worldTime: input.worldTime,
    location: input.location,
    playerInput: input.playerInput,
    onScene: input.onScene,
  });

  // 检索范围只认「当前时间点命中的全部事件」，不再跟随正文年表的注入批次。
  //
  // 原意见上：不拿整段正文去查，而是拿「这一刻该核对什么」去查。
  // 但先前只要有 storyTimeline.entries 就整批拿来查，而推演本轮时
  // 正文年表会带区间（区间内事件全收），导致指导跟着一起放大到整轮范围，
  // 既和补演阶段重复，又把检索词稀释。
  //
  // 玩家 2026-10-30 定：
  //   ① **只检索当前时间点命中/相邻的那些事件**，不再沿用正文年表的整批注入列表
  //      （推演本轮时那份是整轮区间全收，会把指导范围放大到整轮）
  //   ② 同一天可能有多个事件 → 全部纳入
  //   ③ 一个都没命中时：往前退到最近的未来事件（铺垫）、
  //      往后取最后那条（延伸）、落在空白取前后各一条（过渡）
  //      这是玩家确认要保留的行为，不做「一律不检索」的改动。
  //   ④ 时间点精度只到月/年时（模糊推进「三个多月」），按整月/整年求相交
  const hitEvents=resolveEventsAtPoint(input.timeline,input.worldTime,parseTimePrecision(input.worldTime));
  // 命中就全部纳入；没命中退回当前节点那一条，行为与原来一致。
  const sourceEvents=hitEvents.length
    ? hitEvents.map(hit=>hit.entry)
    : [node.entry].filter(Boolean);
  const queryRows=sourceEvents.map(entry=>({entry,text:[String(entry.title || ''),renderEventMaterial(entry,{mode:options.materialMode || 'current_only',isCurrent:node.position===CE_NODE_POSITION.during && (entry===node.entry || (entry.title && entry.title===node.entry.title)),maxChars:0}).text].filter(Boolean).join('\n')}));
  const queryLimits=normalizeRequestLimits(options.batchLimits);
  const queryGroups=options.materials===false || options.materials?.ragVector===false?[]:packRequestMaterials(queryRows,{...queryLimits,maxItems:queryLimits.timelineBatchEvents,measure:row=>row.text.length,estimateOutput:()=>0});
  // 整批订单直接交给原卡；不再重复加入当前原文、focus材料或逐人查询指令。
  const queries=queryGroups.map(batch=>['【参考时间】'+input.worldTime,...batch.map(row=>row.text)].join('\n\n'));
  const queryText=queries[0] || '';


  let collected;
  try {
    collected = input.materialState ? {material:input.materialState.material,report:input.materialState.report.filter(row=>row.key!=='priorNpcState'),retryState:input.materialState} : await collectHostMaterial({
      host,
      profile: 'guidance',
      limits:options.materialLimits,
      counts:options.materialCounts,requiredScope,logId:input.logId,
      enabled: options.materials,
      queryText,
      queryBatches:queries,
      queryTime:input.worldTime,
      queryCharacters:requiredScope.characterNames,
      direct: {
        scene: [input.worldTime, input.location].filter(Boolean).join(' / '),
        playerInput: String(input.playerInput || ''),
        onScene: renderOnSceneText(input.onScene),
        canonNode: nodeMaterial,
      },
    });
  } catch (error) {
    collected = {material:{},report:[{key:'ragVector',status:'error',attempted:false,completed:false,reason:String(error.message || error)}],text:''};
  }

  const material = collected.material || {};
  const materialReport = collected.report || [];
  const materialState=collected.retryState || null;
  const guidanceContext={...Object.fromEntries(['timeline','canonicalNames','logId','worldTime','location','playerInput','onScene','focus','focusMaterial','storyTimeline','priorNpcState'].filter(key=>input[key]!==undefined).map(key=>[key,JSON.parse(JSON.stringify(input[key]))])),requiredScope:collected.retryState?.requiredScope || requiredScope};
  guidanceContext.options=Object.fromEntries(['promptOverrides','maxCandidates','materialMode','materialMaxChars','batchLimits','requestBatchVersion','materials','materialLimits','materialCounts'].filter(key=>options[key]!==undefined).map(key=>[key,JSON.parse(JSON.stringify(options[key]))]));
  capacityContext={node,candidates,materialState,guidanceContext,materialReport};
  const rag=materialReport.find(row=>row.key==='ragVector');
  const disabled=options.materials===false || options.materials?.ragVector===false;
  const retrievalReceipt=disabled?{status:'disabled',attempted:false,completed:false,reason:'玩家关闭本阶段设定检索'}:rag?{status:rag.status==='missing'?'unavailable':rag.status,attempted:rag.attempted===true,completed:rag.completed===true,reason:rag.reason}: {status:'unavailable',attempted:false,completed:false,reason:'未取得检索执行回信'};
  if(!disabled && !retrievalReceipt.completed && Number(options.requestBatchVersion)>=1)return {ok:false,text:'',guidance:null,node,candidates,reason:'资料检索未完成：'+retrievalReceipt.reason,materialReport,retrievalReceipt,materialState,guidanceContext};

  // ---------- 填占位符 ----------
  const prompt = fillGuidancePlaceholders({
    template: guidancePrompt(overrides),
    material,
    worldTime: input.worldTime,
    location: input.location,
    playerInput: input.playerInput,
    nodeMaterial:material.canonNode || '',
    focusMaterial: input.focusMaterial,
  })+'\n【设定检索回信】'+retrievalReceipt.reason+'。开局没有历史存档和NPC是正常情况；检索完成但未命中只表示资料较少，依据年表与已有正文、存档继续，不编造未知设定。';

  // ---------- 调模型（带重试） ----------
  //
  // 失败不立刻降级：网络抖动、模型抽风、JSON 没吐好都重来一遍。
  // 重试策略来自面板，全流程共用。
  const baseMessages=[{role:'user',content:prompt},...(storyTimeline && storyTimeline.block?[{role:'user',content:'【本轮正文实际注入的年表资料】\n'+storyTimeline.block+'\n【指导职责】指导正文AI如何使用以上这批条目。尊重玩家行动和存档事实，不把原著结局当成已发生，不把离场秘密写成玩家已知。原年表事件定位优先，日期位置只作参考。'}]:[])];
  const previous=input.priorNpcState || {},records=Array.isArray(previous.records)?previous.records:[];
  const eventCodes=new Set([...(storyTimeline?.entries || []),...candidates.map(node=>node.entry)].map(event=>String(event.title || '').match(/【\s*(E-\d+(?:\.\d+)?)\s*】/i)?.[1]));
  const eventProgress=(previous.eventProgress || []).filter(row=>!row.resolved || eventCodes.has(row.eventId));
  const byEventId=new Map((input.timeline||[]).map(event=>[String(event.code||event.title?.match(/E-\d+(?:\.\d+)?/i)?.[0]||''),event]));
  const watched=(previous.eventWatches||[]).map(watch=>({type:'按账本编号定点取得的变异线索，嫌疑不等于已发生',...watch,event:byEventId.has(watch.eventId)?renderEventMaterial(byEventId.get(watch.eventId),{mode:'brief_only',maxChars:0}).brief:'该编号资料当前不可用'}));
  const comparisonRows=[...records,...watched,...eventProgress.map(row=>({type:'已保存事件事实进度',...row}))];
  const feedbackHeader=(eventProgress.length?'【随真实变量保存的事件事实进度】承接当前节点、已发生、未发生与变异。日期不强制收尾，参考事项不是强制目标；不重复已发生内容，不泄露离场秘密。\n':'')+'【已实际落实的人物状态，与当前原著事件对照】\n存档时间：'+String(previous.asOf || '')+'\n'+String(previous.columns || '')+'\n这些是原卡保存后的真实人物变量，生平是已经发生的行为；物品、境界、关系、性格、动机和目标都可能因此前变化而与原著不同。以当前性格为人物选择的首要依据，再结合目的、动机、能力、资源和已知信息推理。对照本轮原著事件原本的前提，判断哪些仍能成立、哪些被此前行为改变、哪些影响现在传递到玩家剧情；不能将已保存的变异重置为原著，不把未来参考、幻境或原著结局当现状，不让人物或玩家凭空全知。\n';
  const limits=normalizeRequestLimits(options.batchLimits),baseChars=baseMessages.reduce((n,m)=>n+m.content.length,0);
  const batches=comparisonRows.length?packRequestMaterials(comparisonRows,{...limits,sharedChars:baseChars+feedbackHeader.length+500,estimateOutput:()=>0}):[[]];
  materialReport.push({key:'priorNpcState',label:'已落实人物状态',status:records.length?'direct':'empty',chars:JSON.stringify(previous).length,originalChars:JSON.stringify(previous).length,truncated:false,reason:records.length?'原卡存档只读；按容量装箱，不按人物逐一检索':'尚无可用人物存档'});
  const request=async(messages,stage)=>{
    if(messages.reduce((n,m)=>n+m.content.length,0)>limits.maxInputChars)return {ok:false,reason:'原著指导材料超过单次输入容量，请提高请求与批量设置的输入容量；人物状态和年表未被截断。',attempts:0,errors:[]};
    return withRetry(({correct})=>host.llmCall(correct({stage,messages,json:true})),{
      signal:options.signal,
      config: options.retry,
      retryDelayMs: options.retryDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
      // 「拿回来了但解析不出五类」也算失败，要重试。
      // 只在 retryOnParseError 开启时生效（withRetry 内部判断）。
      validate: (text) => {
        const p = parseGuidance(text);
        return { ok: p.ok, reason: p.reason };
      },
      onRetry: (attempt, max, reason, delay) => {
        if (typeof options.onRetry === 'function') {
          options.onRetry({
            stage: '原著指导', attempt, max, reason, delay,
          });
        }
      },
    });
  };
  let retryResult,attempts=0,errors=[];
  const comparisons=[];
  for(let i=0;i<batches.length;i++){
    const messages=[...baseMessages];
    if(comparisonRows.length)messages.push({role:'user',content:feedbackHeader+JSON.stringify(batches[i])+(batches.length>1?'\n这是容量分批中的一批。只判断本批人物对当前事件的影响，按同样五类JSON返回；其他批人物尚未知，不可替他们下结论。':'')});
    retryResult=await request(messages,batches.length>1?'原著指导 · 状态对照 '+(i+1)+'/'+batches.length:'当前事件 · 原著指导');
    attempts+=retryResult.attempts || 0;errors.push(...(retryResult.errors || []));
    if(!retryResult.ok)break;
    comparisons.push({names:batches[i].map(row=>row.name),guidance:retryResult.value});
  }
  if(retryResult.ok && batches.length>1){
    retryResult=await request([...baseMessages,{role:'user',content:'【各批人物实际状态与当前事件的对照结论】\n'+JSON.stringify(comparisons)+'\n综合以上全部人物影响，仍按五类JSON输出唯一一份本轮指导。保留因果链和冲突，以实际存档变异优先；不能将已保存的变异重置为原著。各批未涉及不等于不存在，不重复扩写人物小传，不使离场秘密成为玩家已知。'}],'原著指导 · 综合');
    attempts+=retryResult.attempts || 0;errors.push(...(retryResult.errors || []));
  }
  retryResult={...retryResult,attempts,errors};

  if (!retryResult.ok) {
    return {
      ok: false, text: '', guidance: null, node, candidates,
      reason: retryResult.reason,
      materialReport,retrievalReceipt,materialState,guidanceContext,
      retry: {
        attempts: retryResult.attempts,
        errors: retryResult.errors,
      },
    };
  }

  const parsed = parseGuidance(retryResult.value);
  if (!parsed.ok) {
    // 理论上 validate 已经挡住了，这里是最后一道
    return {
      ok: false, text: '', guidance: null, node, candidates,
      reason: parsed.reason,
      materialReport,retrievalReceipt,materialState,guidanceContext,
      retry: { attempts: retryResult.attempts, errors: retryResult.errors },
    };
  }

  return {
    ok: true,
    // 节点标题要一起传：正文 AI 得知道这一轮在演原著哪个事件，
    // 否则那段约束在它眼里就是一堆没有主语的规矩。
    text: renderGuidanceForStory(parsed.guidance, {
      nodeTitle: node
        ? `${node.code || ''} ${node.title || ''}`.trim() + `（世界线${node.position}）`
        : '',
    }),
    guidance: parsed.guidance,
    node,
    candidates,
    reason: '',
    materialReport,retrievalReceipt,materialState,guidanceContext,
    retry: { attempts: retryResult.attempts, errors: retryResult.errors },
  };
  }catch(error){
    if(error?.code==='CE_REQUEST_CAPACITY')return {...capacityContext,ok:false,text:'',guidance:null,reason:error.message,capacityFailure:true};
    throw error;
  }
}

/**
 * 占位符 → 真值。
 *
 * 组装只有一条路：模板留占位符，运行时填。这里只是把
 * 「键名 → 取哪份资料」的映射写出来，替换逻辑本身在
 * prompt-registry.fillTemplate，全流程共用同一份。
 *
 * 取不到的写「无」，与原版 `|| '无'` 一致。
 * 这样模型看得见「这段是空的」，不会以为漏了。
 *
 * @param {object} input
 * @returns {string}
 */
export function fillGuidancePlaceholders(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const material = src.material && typeof src.material === 'object' ? src.material : {};

  return fillTemplate(src.template, {
    '{{当前时间}}': src.worldTime,
    '{{当前地点}}': src.location,
    '{{玩家输入}}': src.playerInput,
    '{{既往正文}}': material.recentStory,
    '{{叙事记忆}}': material.narrativeMemory,
    '{{世界状态快照}}': material.stateSnapshot,
    '{{设定集检索}}': material.ragVector,
    '{{人物档案}}': material.characters,
    /* ★★★ 2026-11-03 玩家定：
     *   「所以提示词要注意完善好，要告诉ai这份资料是做什么的，
     *     又是怎么通过本轮补演所有人的行为来影响和更新的。」
     *   「这个东西的本质也是蝴蝶效应和变异因子传导链之一，
     *     整个原著补演最骨架的设计就是蝴蝶效应和变异因子的积累传导」
     *
     * 原来这里只给一段标题加内容，模型只能猜这份「世界大事」是什么：
     * 背景设定？历史摘要？还是预测？三种理解导出的写法完全不同。
     * 现在把它的来龙去脉和使用方式一起交代清楚。 */
    '{{世界大事}}': withWorldEventGuide(material.worldEvents),
    '{{世界规则}}': material.worldFactors,
    '{{地理与小地图}}': material.map,
    '{{原著节点}}': src.nodeMaterial,
    '{{本轮焦点}}': src.focusMaterial || '',
  });
}

/**
 * 给「世界大事」这份资料套一段说明，讲清它是什么、从哪来、怎么用、怎么被更新。
 *
 * 玩家 2026-11-03：
 *   「要告诉ai这份资料是做什么的，又是怎么通过本轮补演所有人的行为来影响和更新的。」
 *
 * 空值不套说明、原样留空。理由：「这段是空的」本身就是有效信息，
 * 套一段说明反而会让模型以为这里有内容。
 *
 * @param {string} text
 * @returns {string}
 */
export function withWorldEventGuide(text) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return body;
  return [worldEventGuideText(), '【本轮世界大事记录】', body].join('\n');
}

/**
 * 只返回说明文字、不带记录正文。
 *
 * 用在正文已经拼在别处（例如共享资料 sharing.shared 里已含世界大事原文）的场合，
 * 避免同一份记录在提示词里出现两遍。
 *
 * @returns {string}
 */
export function worldEventGuideText() {
  return [
    '【这是什么】',
    '这是这个世界**当前已经成立**的公共状态记录：势力格局、局势走向、地域与资源的归属、',
    '世上广为流传的消息。它不是设定集，不是剧情大纲，也不是对后续的预测。',
    '',
    '【它从哪来】',
    '来自已核对公共影响后登记的世界事件。原著年表只是候选资料，个人拜师、修炼与日常不因带E编号就成为世界大事；玩家和所有角色的实际行为可能改变世界局势，',
    '改变的部分被重新汇总进来。所以它记录的是**这个世界自己走到今天的真实样子**，',
    '可能已经偏离原著——偏离是正常且被允许的，不需要纠正回原著。',
    '',
    '【这一轮怎么用它】',
    '把它当作既定事实、当作本轮所有人行动的既定背景：',
    '· 「当前世界局势」按范围和具体影响约束本轮剧情及原著演变；历史记录仅供追溯。',
    '· 预计结束只供推演，条件真正满足才结束。不要把已结束的影响继续施加。',
    '· 势力、地点、资源、局势以已成立的实际世界状态为准；与原著年表冲突时，以实际状态为准。',
    '· 人物的处境、能拿到什么、遇得到谁，受它约束。',
    '· 不要复述它，也不要为了贴合它而强行编造情节；它只是前提。',
    '',
    '【它怎么被更新】',
    '只有本轮已造成地区、国家或主要势力层面重大影响的行为，才汇总成简短的世界局势新闻并更新相应记录；不是把所有人的经历都汇总进来，',
    '成为下一轮所有人的既定背景。也就是说：',
    '**你这一轮写下的公共变化，会变成下一轮所有角色必须遵守的现实。**',
    '所以——确实发生了公共变化（势力易主、地盘得失、资源易手、局势逆转、消息传开）',
    '就要明确写出来，它会进入这份记录；没有发生的，不要为了让记录好看而虚构。',
  ].join('\n');
}

/**
 * 在场人物渲染成一段短文字。
 *
 * 注意：这里是「玩家身边有谁」，不是全表。
 * 目标前端的 surroundingCharacters 是运行时维护的，比存档更准。
 *
 * @param {Array} onScene
 * @returns {string}
 */
function renderOnSceneText(onScene) {
  const list = Array.isArray(onScene) ? onScene : [];
  if (list.length === 0) return '';
  const lines = [];
  for (const p of list) {
    const name = String(p && p.name || '').trim();
    if (!name) continue;
    const st = p && p.state && typeof p.state === 'object' ? p.state : null;
    const bits = [];
    if (st) {
      if (st.dead === true || st.status === '已故') bits.push('已故');
      else {
        if (st.cultivation) bits.push(`境界${st.cultivation}`);
        if (st.location) bits.push(`在${st.location}`);
      }
    }
    lines.push(`· ${name}${bits.length ? `（${bits.join('，')}）` : ''}`);
  }
  return lines.join('\n');
}
