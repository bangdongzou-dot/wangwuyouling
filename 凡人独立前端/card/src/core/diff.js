// ============================================================
// 差集判定：原著补演的核心
//
// 用户定义（2026-10-21 原话）：
//   「按原著年表本该发生的事情，有多少被正文剧情覆盖或者替代了，
//     剩下的，就需要补，这就叫原著补演。」
//
// 后来又补了一条，把「被替代」的处理定死了：
//   「正文已经覆盖或是影响改变的部分我们就不补，这才对。」
//
// 所以这一步**不是**「生成一张必写事实表」，而是算一个减法：
//
//   年表本该发生：A、B、C
//   正文实际写了：A 完整写到；B 被改写成 B'；C 完全没提
//
//   A → 已覆盖 covered  → 不补
//   B → 被替代 mutated  → **也不补**（正文是玩家造的事实，比原著大）
//   C → 未覆盖 missing  → **要补，这就是原著补演**
//
// ------------------------------------------------------------
// 「被替代」为什么不补，容易搞反，写清楚：
//
//   玩家把「董萱儿赴约见韩立」改成「韩立已死，她独自赴约」。
//   这个改变发生在**推演终态**那一步就已经算进去了——
//   推出来的终态本来就是「独自赴约」，不是「见到韩立」。
//
//   所以走到「对正文」这一步还是「被替代」，只可能是一种情况：
//   **正文自己又把它写成了别的样子**（比如她根本没去）。
//   那是玩家最新的创造，谁都不许盖回去。
//
//   换句话说：偏离要补的是「偏离后的版本」，不是「原著版本」。
//   而偏离后的版本在推演阶段就已经产出了，走的还是 missing 这条路。
//
// ------------------------------------------------------------
// 两种做法（用户定：**第二种优先，第一种兜底**）
//
//   做法二·先压要点再对勾（优先）
//     年表 → 压成几条「该发生的事」（可缓存）
//     正文 → 逐条打勾
//     优点：判断粒度小，漏的概率低
//
//   做法一·一步做差集（兜底）
//     年表材料 + 正文 一起给，直接要三分类
//     风险：年表原文可达 6000+ 字，一次读不完容易漏
//
//   兜底触发：要点压缩失败 / 条数异常 / 玩家强制走一步式
// ------------------------------------------------------------

import { projectActorProfile } from './character-profile.js';
import {parseEventProgressRows,renderEventProgress,EVENT_PROGRESS_PROTOCOL} from './ledger.js';
import {
  resolvePrompt,
  CE_PROMPT_REGISTRY,
  fillTemplate,
} from './prompt-registry.js';
import { withRetry } from './retry.js';
import { packRequestMaterials } from './request-budget.js';
import {parseTimePoint} from './interval.js';

/** 单条要点的三种判定结果 */
export const CE_POINT_STATUS = {
  covered: '已覆盖',
  mutated: '被替代',
  missing: '未覆盖',
};

/** 压缩出来的要点条数上限：太多说明年表没被压缩好 */
export const CE_MAX_POINTS = 12;

/**
 * 取一段提示词的最终文本：玩家改过就用玩家的，否则用默认。
 *
 * @param {string} key 注册表 ID
 * @param {object} [overrides] 玩家覆盖表
 * @returns {string}
 */
function promptText(key, overrides) {
  const entry = CE_PROMPT_REGISTRY[key];
  return resolvePrompt(key, { defaultText: entry && typeof entry.build === 'function' ? entry.build({}) : '' }, overrides);
}

/** 终态里允许出现的维度（多一个都不收，防止模型自由发挥） */
export const CE_MUST_KEYS = ['修为', '随身物品', '所在位置', '存在性'];

/** 正文硬事实的条数上限（太多说明它在复述正文，不是在抽事实） */
export const CE_MAX_STORY_FACTS = 24;

/**
 * 事件节点登记协议。
 *
 * 玩家 2026-10-29 定下的三条：
 *   1. 节点数不固定——「没法固定，因为确实每个年表内容包含的节点不确定，
 *      但是我认为是不会太多的，你可以抽样调查，自己看看实际年表内容。」
 *      实测 1201 条年表，content_brief 357–843 字，自然节点 3–6 个。
 *   2. created 的判定标准——「玩家自己搞出来的能实质影响这条年表原著事件
 *      走向和结果的事情。」
 *   3. 新增变异不另开通道——「当然是和其他变异点一个地位啊。
 *      它实质已经变成这个年表的事件了。」
 *
 * 所以节点全部挂在事件下，created 与 mutated 并列在同一个 nodes 数组里，
 * 不设 worldMutations 那种平行结构。
 */
export const NODE_MILESTONE_RULES = '\n主轴只登记实际重要转折，通常不超过6个，不设最低数量。不按NPC正文的时间段写节点。\n'
  + '\n【怎么拆节点】\n'
  + '先提醒一点：事件内容（content_brief）多为自动抽取，句子常被逗号切碎，'
  + '一句话里可能塞了几件事，也可能几句话说同一件事。所以**不要数句子**，'
  + '按「局势是否跨过关键转折」来切。换地点、换动作或多次重复尝试本身都不足以成为新节点。'
  + '有完整原文（content_original）时以原文为准，摘要只作索引。\n'
  + '\n只登记改变阶段、重要关系、机会是否成立、造成实质变异或决定结果的事。occurred/pending记细节，与nodes不必一一对应。\n'
  + '例如「收徒、进谷、授口诀、夜间练习、首次练出气息、日常照料药圃、取得独立诊治的资格」：'
  + '可提炼为「拜师入谷、初成气息、独立诊治」，日常练习和进谷动作留在详情。只有资格确实改变故事走向才列最后一项。\n';

export const NODE_REGISTRY_PROTOCOL = '\n【第三步：事件节点登记】事件进度行还要带 nodes 数组，把本事件内的关键节点逐个登记。'
  + '玩家要看的是「这件事推进到哪一步了」，每个节点都能点开看细节。\n'
  + '字段：\n'
  + '- nodeId：稳定编号，格式「事件编号-N序号」，如 E-003-N1。同一节点跨轮必须始终同一个编号。\n'
  + '- title：节点名，六个字以内说清是什么事。\n'
  + '- kind：canon＝年表里本来就有的节点；created＝年表里没有、玩家自己造出来的节点。\n'
  + '- state：done＝已实际发生；todo＝尚未发生（按原著推力等着）；mutated＝原著节点被改变；created＝新增节点。\n'
  + '- at：仅填已经确认发生的一个日期/时刻（如 0010.04.09）；estimatedAt：日期未知或尚未发生时，根据本轮因果、当前时间与前后锚点推算一个日期（如 0010.08.10），与 at 分开。任何一个字段都禁止填写日期区间、持续时间或整段起止；确实无依据时留空。\n'
  + '- actors：实际涉及人物姓名数组，供节点详情展示；不确定留空数组，不编造人物。\n'
  + '- original：canon 节点的原著内容；todo 写参考事项，mutated 写原节点本来是什么。created 不填。\n'
  + '- cause：todo 写当前状态或尚缺前提；mutated 和 created 写变异原因。\n'
  + '- result：done 写实际阶段结果，mutated 和 created 写实际变成了什么。\n'
  + '- handling：本轮补演打算怎么处理。mutated 和 created 必填。\n'
  /* ── 2026-11-01 玩家报：正文时间已到首个年表节点起始时间，进度指针仍显示
   *    「实际阶段：原著暂未启动」、节点「尚未触发」。
   *    玩家点明这是提示词没教清楚，并给出一条关键设定：
   *      「我推测是因为玩家没有主动去参与原著，就是原著完全当作背景故事在发生。」
   *    也就是说，玩家不介入 ≠ 原著停摆；原著本身按时间在推进。
   *    这里把判定口径写成可执行的三条，避免模型把「玩家没参与」误当成「尚未发生」。 */
  + '\n【state 怎么判：时间到了就算启动，别把「玩家没参与」当成「没发生」】\n'
  + '原著是**按自己的节奏在走的背景世界**，不是等玩家触发的任务列表。'
  + '玩家完全不去参与某个事件，该事件仍然会按年表时间发生——只是玩家没介入而已。'
  + '所以判定 state 时按这个顺序想：\n'
  + '1. 当前正文时间已经到达或越过该节点的起始时间 → 只要没有明确证据表明它被改变、取消或受阻，'
  + '就应当登记为 done（已发生），或在事件进行中时登记为 done 的「已启动」阶段，**不得写成 todo**。\n'
  + '2. 只有「当前时间还没到它的起始时间」，或者「已经写明的因果使它确实不可能发生」时，才写 todo。\n'
  + '3. 判断依据是**时间 + 文本里已确认的因果**；不能因为「玩家没参与」「正文没细写」就判 todo。'
  + '正文没细写只是细节缺失，不等于事情没发生。\n'
  + '同理，事件级的 current（当下实际剧情节点）也不能因为玩家没参与就写「尚未启动」，'
  + '要写它按原著时间实际走到了哪一步。\n'
  + NODE_MILESTONE_RULES
  + '\n硬规则：\n'
  + '1. done 节点必须有 occurred 里的对应内容支撑，不能凭日期推定已完成。\n'
  + '2. todo 节点的 estimatedAt 是按本轮剧情和原著因果推算的一个日期，不是承诺；at 留空。\n'
  + '3. mutated 与 created 的区别：年表里有的节点被改变了用 mutated；年表里压根没有这件事用 created。\n'
  + '4. created 只收「玩家自己搞出来的、且实质影响这条年表事件走向或结果」的事——'
  + '改了走向、改了条件、改了结果都算。只是热闹、没改走向的琐事（吃饭、买书、闲聊）不算；'
  + '年表里能对上的事也不算 created，那是 canon。\n'
  + '5. 自查每个节点：去掉它会不会看不懂事件如何推进？不会就留在详情；若此前已有稳定ID的关键节点，沿用原ID。\n'
  + '6. nodes 只登记本事件内的节点，不跨事件；事件编号必须与 eventId 一致。\n';

/**
 * 校验「正文硬事实」。
 *
 * 用户 2026-10-21：
 *   「正文真正的作用是成为第二个推进因子」
 *
 * 这一步捞的是**力的作用点**：谁死了、什么没了、关系断了。
 * 不是「正文写了什么」，所以情绪、气氛、打算一律不收。
 *
 * @param {string} raw 模型原始输出
 * @returns {{ok:boolean, facts:string[], reason:string}}
 */
export function parseStoryFacts(raw, context = {}) {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, facts: [], reason: '没有解析出 JSON 对象' };
  }
  const list = Array.isArray(parsed.facts) ? parsed.facts : null;
  if (!list) {
    return { ok: false, facts: [], reason: '没有 facts 数组' };
  }
  if(list.length>CE_MAX_STORY_FACTS)return {ok:false,facts:[],reason:'正文事实超出协议上限，需合并后返回，不能静默截断'};

  const facts = [];
  const factRecords = [];
  const seen = new Set();
  for (const item of list) {
    const record = item && typeof item === 'object' ? item : null;
    const label='正文事实「'+String(record?.id || '第'+(factRecords.length+1)+'条')+'」';
    const text = String(record ? record.text || '' : item == null ? '' : item).trim();
    if (!text) return {ok:false,facts:[],reason:'正文事实内容为空'};
    var subject = String(record && record.subject || '').trim();
    var evidence = String(record && record.evidence || '').trim();
    const story = String(context.storyText || '');
    if (story) {
      if(!record || Array.isArray(record))return {ok:false,facts:[],reason:label+'须为包含事实、主体和正文证据的对象，不能仅返回一句概括'};
      if(typeof record.text!=='string')return {ok:false,facts:[],reason:label+'的事实内容（text）须为字符串'};
      if(typeof record.subject!=='string' || !subject)return {ok:false,facts:[],reason:label+'缺少明确主体（subject），须由模型结合正文确认，不能由代码猜测'};
      if(typeof record.evidence!=='string')return {ok:false,facts:[],reason:label+'的正文证据（evidence）须为非空字符串'};
      if(!evidence)return {ok:false,facts:[],reason:label+'缺少正文证据（evidence），请逐字摘录本轮正文原句'};
      if(!story.includes(evidence))return {ok:false,facts:[],reason:label+'的证据不在本轮正文中；请摘录连续原句，不引用年表、存档、示例或改写概括；正文无法证实的判断应撤回并记入uncertain'};
    }
    if (seen.has(text)) continue;
    seen.add(text);
    facts.push(text);
    factRecords.push({id:String(record && record.id || 'F'+facts.length),text,subject,evidence});
    if (facts.length >= CE_MAX_STORY_FACTS) break;
  }
  const resolvedHooks = [];
  if (parsed.resolvedHooks !== undefined && !Array.isArray(parsed.resolvedHooks)) return {ok:false,facts:[],reason:'钩子收尾不是数组'};
  for (const claim of parsed.resolvedHooks || []) {
    const who = String(claim && claim.who || '').trim();
    const hook = String(claim && claim.hook || '').trim();
    const evidence = String(claim && claim.evidence || '').trim();
    if (!who || !hook || !evidence || !String(context.storyText || '').includes(evidence)
      || !(context.hooks || []).some(h=>h.who===who && h.hook===hook)) {
      return {ok:false,facts:[],reason:'钩子收尾缺少正文原句或不对应现有钩子'};
    }
    resolvedHooks.push({who,hook,evidence});
  }
  // 空数组是合法输出：这轮玩家什么都没改变。
  return { ok: true, facts, factRecords, resolvedHooks, reason: '' };
}

// 代码只核验协议、引用和出处；人物身份、事实归属与因果联系由同一次边界AI判断。
export function parseStoryBoundary(raw, context = {}) {
  /* ★★ 2026-11-02 玩家定：「小错自己重试，大错修不好才报告，谁错修谁不影响其他人」
   *
   * rejected 收集「单个人物没通过」的原因。放在函数最外层，
   * 因为人物循环可能在多个分支里跑，而分级返回在函数末尾统一做。
   */
  const rejected=[];
  const parsed=parseJsonLoose(raw),facts=parseStoryFacts(raw,context);
  if(!facts.ok)return facts;
  /* ★★ 2026-11-02 全面复盘「合并报错」：原来 3 种情况挤成一句。
   * 玩家分不清是「没写」「写了个不是时间的词」还是「早于起点」。逐个拆开。 */
  if(context.bodyTimeKnown===false){
    if(typeof parsed.bodyEndTime!=='string' || !parsed.bodyEndTime.trim())return {ok:false,reason:'正文时间终点（bodyEndTime）没有给出：本轮已判定正文有明确时间，必须写出终点时间，实际是 '+JSON.stringify(parsed.bodyEndTime)+'；不能把指导计划或未更新世界时间当结果'};
    if(parseTimePoint(parsed.bodyEndTime)===null)return {ok:false,reason:'正文时间终点（bodyEndTime）不是可识别的时间：写成了「'+String(parsed.bodyEndTime)+'」；请按正文里的时间写法给出，如「0022年08月17日」'};
    if(parseTimePoint(parsed.bodyEndTime)<parseTimePoint(context.range?.start))return {ok:false,reason:'正文时间终点早于本轮起点：终点是「'+String(parsed.bodyEndTime)+'」，起点是「'+String(context.range?.start||'')+'」；终点不能早于起点'};
  }
  /* ★★ 2026-11-02 全面复盘：原来「条数不一致」和「id 缺失」挤成一句。拆开。 */
  if(parsed.facts.length!==facts.factRecords.length)return {ok:false,reason:'边界事实条数对不上：模型给了 '+parsed.facts.length+' 条，但只解析出 '+facts.factRecords.length+' 条有效事实；说明有条目缺少必要字段被丢弃，不能按无事继续'};
  {
    const badFactRow=parsed.facts.findIndex(row=>!row || typeof row.id!=='string' || !row.id.trim());
    if(badFactRow>=0){
      const bad=parsed.facts[badFactRow];
      return {ok:false,reason:'边界事实缺少合法 id：第 '+(badFactRow+1)+' 条的 id 是 '+JSON.stringify(bad&&bad.id)+'；每条事实都必须有非空字符串 id'};
    }
  }
  /* ★★ 2026-11-02 全面复盘「合并报错」：原来缺两个字段挤成一句。拆开，指出缺哪个。 */
  if(!Array.isArray(parsed.handled))return {ok:false,reason:'缺少 handled（正文已处理人物）数组：实际是 '+JSON.stringify(parsed.handled&&typeof parsed.handled)+'；不能用代码猜人物'};
  const impactScope=context.prebuiltOnly?null:parsed.impactScope;
  if(impactScope!==undefined&&impactScope!==null&&(!Array.isArray(impactScope.names)||
    typeof impactScope.hasImpact!=='boolean'||impactScope.hasImpact!==Boolean(impactScope.names.length)||
    new Set(impactScope.names).size!==impactScope.names.length||impactScope.names.some(name=>typeof name!=='string'||!name.trim())))
    return {ok:false,reason:'人物影响范围不合法：先判定有无影响，有影响才列受影响的人物姓名'};
  const checkInfluences=!context.prebuiltOnly&&impactScope?.hasImpact!==false;
  if(checkInfluences&&!Array.isArray(parsed.influences))return {ok:false,reason:'缺少已确认受影响人物的 influences 数组'};
  if(parsed.uncertain!==undefined && !Array.isArray(parsed.uncertain))return {ok:false,reason:'uncertain必须为数组'};
  const eventCodes=new Set((context.events || []).map(e=>String(e.code || e.eventId || '').toUpperCase()).filter(Boolean));
  if(eventCodes.size && !Array.isArray(parsed.worldEvents))return {ok:false,reason:'缺少worldEvents判定，不能用关键词猜世界事件'};
  const worldEvents=parsed.worldEvents || [];
  /* ★★ 2026-11-02 全面复盘：原来 4 种情况挤成一句「编号或理由无效」。逐个拆开。 */
  {
    const badWorldRow=worldEvents.findIndex(row=>!row);
    if(badWorldRow>=0)return {ok:false,reason:'世界事件判定第 '+(badWorldRow+1)+' 条是空的；每条都要给出 code 和 reason'};
    const badCode=worldEvents.find(row=>!eventCodes.has(row.code));
    if(badCode)return {ok:false,reason:'世界事件判定的编号不存在：写的是「'+String(badCode.code)+'」，但本轮没有这个事件编号。可用的有：'+(eventCodes.size?[...eventCodes].slice(0,8).map(c=>'「'+c+'」').join('、')+'…':'（本轮无可用事件编号）')};
    const noReason=worldEvents.find(row=>!String(row.reason || '').trim());
    if(noReason)return {ok:false,reason:'世界事件判定没有写理由（reason）：事件「'+String(noReason.code)+'」必须说明为什么这样判定'};
    const codes=worldEvents.map(e=>e.code);
    const dupCode=codes.find((c,i)=>codes.indexOf(c)!==i);
    if(dupCode)return {ok:false,reason:'世界事件判定重复列出了同一个编号：「'+String(dupCode)+'」出现了多次；每个事件只能判定一次'};
  }
  const names=new Set((context.people || []).map(p=>p.name));
  const actors=new Map((context.actors || []).map(p=>[p.name,p]));
  const ids=new Set(facts.factRecords.map(f=>f.id));
  const watchIds=new Set([...(context.events||[]),...(context.referenceEvents||[])].map(row=>row.code));
  const eventWatches=(Array.isArray(parsed.eventWatches)?parsed.eventWatches:[]).filter(row=>watchIds.has(row?.eventId)&&['suspected','confirmed','dismissed'].includes(row.status)&&String(row.reason||'').trim()).map(row=>({eventId:row.eventId,status:row.status,reason:String(row.reason),recordedAt:context.currentTime}));
  const activatedEvents=[];
  for(const claim of Array.isArray(parsed.activatedEvents)?parsed.activatedEvents:[]){
    const event=(context.referenceEvents||[]).find(event=>event.code===claim?.eventId);
    if(!event||!String(claim.reason||'').trim())return {ok:false,reason:'提前事件必须引用提供的真实年表编号并说明实际因果'};
    activatedEvents.push({eventId:claim.eventId,reason:String(claim.reason),actualStart:parseTimePoint(claim.actualStart)!==null&&parseTimePoint(claim.actualStart)<=parseTimePoint(context.currentTime)?String(claim.actualStart):'',kind:claim.kind==='delayed'?'delayed':'early',recordedAt:context.currentTime,referenceStart:event.time_start||'',referenceEnd:event.time_end||''});
  }
  if(ids.size!==facts.factRecords.length)return {ok:false,reason:'正文事实编号重复'};
  const handled=[],influences=[];
  for(const row of parsed.handled){
    const person=(context.people || []).find(person=>person.name===row?.name);
    if(person && (person.isPlayer || person.id==='B1' || person.isCanon===false))continue;
    const label=String(row?.name || '未提供姓名');
    /* ★★ 2026-11-02 全面复盘：原来「条目是空的」和「人物不在名单」挤成一句。拆开。 */
    if(!row)return {ok:false,reason:'正文人物判定里有一条空记录；每条都要给出 name 和 evidence'};
    if(!names.has(row.name))return {ok:false,reason:'正文人物判定出现了不在名单的人物：「'+String(row.name||'(空)')+'」；本轮名单为：'+[...names].join('、')};
    if(!String(row.reason || '').trim())return {ok:false,reason:'正文人物判定「'+label+'」缺少理由'};
    /* ★★ 2026-11-02 全面复盘：原来「没写原句」和「原句在正文里找不到」挤成一句。拆开。 */
    if(!String(row.evidence || '').trim())return {ok:false,reason:'正文人物判定「'+label+'」没有摘录正文原句（evidence）；必须从实际正文逐字摘录，不能从年表引用'};
    if(!String(context.storyText || '').includes(row.evidence))return {ok:false,reason:'正文人物判定「'+label+'」摘录的原句在正文里找不到：写的是「'+String(row.evidence).slice(0,60)+(String(row.evidence).length>60?'…':'')+'」；请逐字复制正文原文'};
    if(handled.some(x=>x.name===row.name))return {ok:false,reason:'正文人物判定重复'};
    const presence=typeof row.presentAtEnd==='boolean'&&typeof row.presenceEvidence==='string'&&
      row.presenceEvidence.trim()&&String(context.storyText||'').includes(row.presenceEvidence)
      ?{presentAtEnd:row.presentAtEnd,presenceEvidence:row.presenceEvidence}:{};
    handled.push({name:row.name,reason:row.reason,evidence:row.evidence,...presence});
  }
  const scopedNames=impactScope?.hasImpact?new Set(impactScope.names):null;
  if(scopedNames&&[...scopedNames].some(name=>!actors.has(name)))return {ok:false,reason:'影响范围包含本轮候选之外的人物'};
  for(const row of checkInfluences?parsed.influences:[]){
    if(scopedNames&&!scopedNames.has(row?.name))continue;
    const person=(context.people || []).find(person=>person.name===row?.name);
    if(person && (person.isPlayer || person.id==='B1' || person.isCanon===false))continue;
    const actor=row && actors.get(row.name);
    const source=actor ? String(context.storyText || '')+'\n'+String(actor.material || '')+'\n'+JSON.stringify(projectActorProfile(actor.state) || {})+'\n'+String(context.background || '')+'\n'+(context.events || []).map(event=>String(event.text || '')).join('\n') : '';
    /* ★★ 2026-11-02：同「合并报错」病根的第三个入口。
     * 原来 7 个条件挤成一句「人物影响判定缺少有效事实编号、联系理由或材料原句」，
     * 玩家无法判断是缺编号、编号错、没写理由、还是引用的原句在正文里找不到。
     * 逐个拆开，每条带出实际值。 */
    /* ★★★ 2026-11-03 玩家报：「补演在这一步就出问题了 / 重试 3 次后仍失败：expected is not defined」
     *
     * 【病根】这里用了 `expected`，但本函数里 `expected` 要到下面第 411 行才声明。
     * 也就是说：**正常运行走不到这行**，只有真的返回了「不在本轮名单的人物」这个
     * 异常路径时才会执行到这里，才抛 ReferenceError。
     * 所以它是一个只在「模型返回了错误内容」时才炸的错误 —— 平时看不出来，
     * 一旦模型出错，本该给玩家一句清楚的原因，却变成一句看不懂的
     * `expected is not defined`，还把真正的失败原因盖掉了。
     *
     * 【修法】用本函数此时已经存在的 `actors`（Map）取名单，
     * 不再依赖后面的 `expected`。这样这句话在任何时候都能正确拼出来。 */
    if(!actor)return {ok:false,reason:'人物影响判定引用了不在本轮名单的人物：'+String(row?.actorRef||row?.name||'(空)')+'；本轮名单为：'+[...actors.values()].map(a=>a.actorRef||a.name).join('、')};
    if(!Array.isArray(row.factIds))return {ok:false,reason:'人物影响判定的 factIds（事实编号）不是数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.factIds)+'；应为字符串数组'};
    if(!row.factIds.length)return {ok:false,reason:'人物影响判定的 factIds（事实编号）是空的：人物'+row.actorRef+'没有引用任何事实；至少要引用本轮已提取的事实编号'};
    {
      const badFactIds=row.factIds.filter(id=>!ids.has(id));
      if(badFactIds.length)return {ok:false,reason:'人物影响判定引用了不存在的事实编号：人物'+row.actorRef+'写的是 '+badFactIds.map(i=>'「'+String(i)+'」').join('、')+'，但本轮没有这些事实编号。可用的有：'+(ids.size?[...ids].slice(0,8).map(i=>'「'+i+'」').join('、')+'…':'（本轮无可用事实编号）')};
    }
    if(!String(row.reason || '').trim())return {ok:false,reason:'人物影响判定没有写联系理由（reason）：人物'+row.actorRef+'必须说明这条事实为什么会影响他'};
    if(!String(row.basis || '').trim())return {ok:false,reason:'人物影响判定没有给出材料原句（basis）：人物'+row.actorRef+'需要引用正文里能证明该影响的原句'};
    if(!source.includes(row.basis))return {ok:false,reason:'人物影响判定的原句不在本次材料中：'+actor.name+'。请逐字引用本轮正文或已提供的人物、年表材料'};
    if(influences.some(x=>x.name===row.name))return {ok:false,reason:'人物影响判定重复'};
    influences.push({name:row.name,factIds:row.factIds.slice(),reason:row.reason,basis:row.basis});
  }
  if(scopedNames&&influences.length!==scopedNames.size)return {ok:false,reason:'影响说明只需覆盖已确认受影响的人物：'+[...scopedNames].join('、')};
  const progress=Number(context.eventProgressVersion)>=1?parseEventProgressRows(parsed.eventProgress,context.events || [],context.eventProgress || [],context.bodyTimeKnown===false?parsed.bodyEndTime:context.currentTime):{ok:true,rows:[]};
  // 事件进度：区分「没有事件要判断」和「有事件但进度不合格」。
  //
  // 原来这里写 if(!progress.ok) return {ok:false,...}，把整个补演边界判定一起判死，
  // 补演连第一步都进不去。但这一阶段自己的提示词（见本文件下方「本轮事件进度判断」）
  // 已明确写着「进度由最终世界阶段确认，不预定结局」——既然最终阶段还会再确认一次，
  // 这里就没必要卡死整条补演。
  //
  // 但也不能当成成功：漏掉事件判断就是没判断，不能因为不阻塞就假装已经完成。
  // 所以改成第三态——边界判定照常给出（补演能继续），同时把进度标成未确认，
  // 让上层知道这一轮的事件进度没有落定，最终世界/进度阶段必须重新确认。
  const hasEvents=(context.events || []).length>0;
  const progressRows=progress.ok?progress.rows:[];
  const progressPending=!progress.ok&&hasEvents;
  const progressNote=progressPending?String(progress.reason || '事件进度未确认'):'';
  let actorDecisions,additionalAffectedRefs=[],turnAdvanceTier='',coveredTurnEventIds=[],crossEventActors=[],tierCoveredEventIds=[],tierInvolvedActors=[];
  if(Number(context.canonPushBoundaryVersion)>=1){
    // 先解析本轮时间推进档位，再按档位决定要逐人说到什么程度。
    // 档位是整轮一个值：跨事件全员完整补演、同事件无进展收工、
    // 只有同事件有进展才需要逐人说明补什么。
    // 但破壁是三档之外独立叠加的逐人升级：任何档位下出现真实重大变异，
    // 实际受影响者都立刻转完整补演，所以档②③ 仍然要逐人过一遍走廊。
    const TIERS=['crossEvent','sameEventProgress','sameEventNoProgress','outsideRange'];
    const tier=TIERS.includes(parsed.turnAdvanceTier)?parsed.turnAdvanceTier:'';
    // 没有档位字段时退回旧行为：要求逐人 actorDecisions，全套校验照旧。
    // 缺的是本轮新引入的字段，回退到旧逻辑（更严），不是放宽检查。
    if(!tier)return {ok:false,reason:'须先确认本轮时间推进档位，再决定是否补演及采用普通或预制方式'};
    if(!tier){
      actorDecisions=undefined;
      // 落到下面的旧分支（expected / 全量校验）执行。
    }else{
    const coveredEventIds=tierCoveredEventIds=Array.isArray(parsed.coveredEventIds)?parsed.coveredEventIds.filter(id=>typeof id==='string'&&id.trim()):[];
    // 区间外档本来就不落在任何事件内，不能要求它列覆盖事件；
    // 同事件无进展档同理（它只列破壁者，不列覆盖范围）。
    if(tier!=='sameEventNoProgress'&&tier!=='outsideRange'&&!coveredEventIds.length)return {ok:false,reason:'须列出本轮时间跨度覆盖到的年表事件编号'};
    if(coveredEventIds.some(id=>!eventCodes.has(id)))return {ok:false,reason:'本轮覆盖事件编号不属于候选范围'};
    // 跨事件档要给出涉及人物：该档全员完整补演，逐人细节留给人物补演阶段。
    let involvedActors=[];
    /* ★★ 2026-11-01 玩家说清了这套设计的理由：
     *
     *   「不管是年表系统的判定，还是原著指导的判定，都是只判定当前这个点，就只考虑
     *     眼前；而原著补演判定的是一个区间，且能看账本和前因后果，对原著发展情况
     *     全面了解，所以必须让他独立确定一次目前实际情况，尤其是看是否存在走廊壁
     *     被打破的特殊情形。」
     *
     * 所以「跨事件档不逐人推演」这个优化本身没错（该档全员都要完整补演，破壁不额外
     * 升级），但它不该连**破壁检查**一起跳过 —— 跨事件档恰恰是最可能出破壁的档位：
     * 时间跨度最大、正文改动机会最多，最需要回头看「谁把走廊壁撞破了」。
     *
     * 原来 crossEvent 分支无条件 return，把 actorDecisions 置空，导致下面那条
     * 「破壁须明确本人实际受影响及有因果的破壁理由」的校验永远执行不到。
     *
     * 现在：仍然不强制逐人覆盖（该档不需要），但只要模型**主动报了人**，
     * 就必须按同一套走廊规则校验通过。一个人都没报 → 视为本轮无破壁，照旧直接返回。
     *
     * 注意：expected / refs 原来声明在下面（档位分支结束之后），跨事件档走到
     * 逐人校验时它们已在作用域内，本来不需要移动 —— 上一版我把它们提前，反而
     * 让「未启用档位逻辑」的旧分支取不到，报 expected is not defined。已还原原位。
     */
    if(tier==='crossEvent'){
      const names=(context.actors || []).map(actor=>actor.name);
      const listed=Array.isArray(parsed.involvedActors)?parsed.involvedActors.filter(name=>typeof name==='string'&&name.trim()):[];
      if(!listed.length)return {ok:false,reason:'跨年表事件档须列出本轮涉及的全部原著人物'};
      const outside=listed.filter(name=>!names.includes(name));
      if(outside.length)return {ok:false,reason:'跨年表事件档涉及人物超出本轮候选范围：'+outside.join('、')};
      involvedActors=listed;
      /* ★★ 2026-11-01 玩家说清了这套设计的理由：
       *
       *   「不管是年表系统的判定，还是原著指导的判定，都是只判定当前这个点，就只考虑
       *     眼前；而原著补演判定的是一个区间，且能看账本和前因后果，对原著发展情况
       *     全面了解，所以必须让他独立判定一次目前实际情况，尤其是看是否存在走廊壁
       *     被打破的特殊情形。」
       *
       * 所以「跨事件档不逐人推演」这个优化本身没错（全员都要完整补演，破壁不额外升级），
       * 但它不该连**破壁检查**一起跳过 —— 跨事件档恰恰是最可能出破壁的档位：
       * 时间跨度最大、正文改动机会最多，最需要回头看「谁把走廊壁撞破了」。
       *
       * 原来这里是无条件 return，把 actorDecisions 置空，导致下面第 348 行那条
       * 「破壁须明确本人实际受影响及有因果的破壁理由」的校验永远执行不到。
       *
       * 现在：仍然不强制逐人覆盖（该档不需要），但只要模型**主动报了人**，
       * 就必须按同一套走廊规则校验通过，不许蒙混过关。
       * 模型一个人都没报 → 视为本轮无破壁，照旧直接返回（省 token，行为不变）。
       */
      const crossRows=Array.isArray(parsed.actorDecisions)?parsed.actorDecisions.filter(row=>row&&typeof row==='object'):[];
      if(!crossRows.length){
        return {...facts,handled,influences,worldEvents,eventProgress:progressRows,...(progressNote?{eventProgressPending:progressPending,eventProgressNote:progressNote,eventProgressDetail:{missing:progress.missing||[],unexpected:progress.unexpected||[],invalid:progress.invalid||[]}}:{}),activatedEvents,eventWatches,uncertain:parsed.uncertain || [],turnAdvanceTier:tier,coveredEventIds,involvedActors,actorDecisions:[],additionalAffectedRefs:[],...(context.bodyTimeKnown===false?{bodyEndTime:parsed.bodyEndTime}:{})};
      }
      // 报了人就走完整的走廊/破壁校验（与其它档同一套规则）。
      parsed.actorDecisions=crossRows;
    }
    turnAdvanceTier=tier;coveredTurnEventIds=coveredEventIds;crossEventActors=involvedActors;tierInvolvedActors=involvedActors;
    }
    const expected=context.actors || [];
    const refs=new Set([...expected.map(actor=>actor.actorRef || actor.name),...(context.affectedActorRefs || [])]);
    // 同事件无进展档：允许只列破壁者（其余人本来就不补演），
    // 但列出来的必须合法——尤其 break 必须带破壁理由与实际受影响者。
    // 有进展档和旧路径仍要求逐人完整覆盖。
    const strictCoverage=!['sameEventNoProgress','outsideRange','crossEvent'].includes(turnAdvanceTier);
    if(!Array.isArray(parsed.actorDecisions))parsed.actorDecisions=[];
    /* ★★ 2026-11-01 玩家：「补演这个是什么原因？重试 3 次后仍失败」
     *
     * 原来这里是硬校验：
     *   if(strictCoverage && parsed.actorDecisions.length!==expected.length) return {ok:false,...}
     *
     * 两个毛病：
     *   ① 只数条数、不看是谁。模型列 5 条但其中一条重复、真漏了另一个人时，
     *      length 相等照样放行 —— 该拦的没拦住。
     *   ② 把「模型漏写某人」当成整轮致命错误。可漏写某人只说明「这人本轮没动静」，
     *      是最常见的情况。整轮打回重试 3 次再失败，玩家就只能看到「未完成」卡死。
     *
     * 改成按 actorRef 认人：
     *   · 列出的人重复 / 不在候选里 → 仍然报错（这是模型乱编，必须拦）。
     *   · 少列了人 → 自动补一条 canonAdvance:'none'（本轮无原著推进），继续往下走。
     *     'none' 是安全的默认语义：不下任何推进结论，不会凭空给某人生成剧情。
     */
    if(strictCoverage && Array.isArray(parsed.actorDecisions)){
      const seenRefs=new Set();
      for(const row of parsed.actorDecisions){
        const ref=row&&row.actorRef;
        if(!ref)continue;
        if(seenRefs.has(ref)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力人物重复出现：'+ref});continue;}
        seenRefs.add(ref);
      }
      for(const actor of expected){
        const ref=actor.actorRef || actor.name;
        if(seenRefs.has(ref))continue;
        // 缺项补「无推进」。corridor 用最保守的值：走廊完整、无破壁理由。
        parsed.actorDecisions.push({actorRef:ref,eventIds:[...(actor.eventIds||[])],canonAdvance:'none',reason:'模型未列出此人，按本轮无原著推进补默认值',requiredInfluences:[],sourceRefs:[],corridor:{baselineRef:'before:'+ref,currentStage:'维持现状',nextReferenceIds:[],intact:true,breakReasons:[]},affectedRefs:[],requiredMaterials:[],autoFilled:true});
      }
    }
    actorDecisions=[];
    /* ★★ 2026-11-02 玩家定：「小错自己重试，大错修不好才报告，谁错修谁不影响其他人」
     *
     * 原来这个循环里任何一条校验不过就 return {ok:false}，整轮补演全部作废——
     * 某个人物的一个 sourceRefs 写错，会让其余所有人物的正确结果一起白跑。
     *
     * 现在改成「谁错剔谁」：单个人物的数据问题只把他记进 rejected，
     * 跳过此人继续处理其余人物；只要还有人物通过，本轮就不算失败。
     * 被剔的人物由上层单独报告并支持针对性重跑，不波及其他人。
     */
    for(const row of parsed.actorDecisions){
      const actor=expected.find(actor=>(actor.actorRef || actor.name)===row?.actorRef),corridor=row?.corridor;
      const strings=value=>Array.isArray(value)&&value.every(item=>typeof item==='string'&&item.trim());
      /* ★★ 2026-11-01 玩家截图：重试 2 次后仍失败，面板只有一句
       *     「原著推力人物引用、枚举或理由无效」。
       *
       * 病根：这一条 if 把**四种性质完全不同的情况**挤进了同一个 reason：
       *   ① 这个 actorRef 根本不在本次名单里（模型编了个人 / 引用了别人的 id）
       *   ② 同一个人被列了两次（重复）
       *   ③ canonAdvance 不是那四个合法枚举（模型写了别的词）
       *   ④ reason 是空的（模型偷懒没写理由）
       * 玩家看到的是同一句话，完全不知道是哪一种，也无从下手——
       * 重试两次还是同样结果，就卡死在这里。
       *
       * 现在拆成四条，每条都把**实际值**带出来：
       *   是哪个人、写的是什么枚举、原始值长什么样。
       * 这样重试失败时面板上至少能看出问题在哪，不用再猜。
       */
      if(!actor){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力里出现了不在本轮名单的人物引用：'+String(row?.actorRef||'(空)')+'；本轮名单为：'+expected.map(a=>a.actorRef||a.name).join('、')});continue;}
      if(actorDecisions.some(item=>item.actorRef===row.actorRef)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力里同一个人物被列出了两次：'+row.actorRef});continue;}
      /* ★ 2026-11-01：枚举值写成同义词/带空格/大小写不一致，属于**写法问题**，
       * 不是判断错误。把它当成致命错误让玩家重试两次，纯属浪费——
       * 模型的意思很清楚，归一化就能继续。只认那些语义等价、不会改变结论的写法：
       *   none/无/没有/无推进 → none      push/推进/有推进 → push
       *   break/破壁/突破      → break     needs_context/需上下文/待定 → needs_context
       * 认不出来的才报错（那种才是模型真的写乱了）。
       */
      const canonAdvanceAliases={
        none:['none','无','没有','无推进','不推进','无原著推进'],
        push:['push','推进','有推进','原著推进'],
        break:['break','破壁','突破','破壁推进'],
        needs_context:['needs_context','needscontext','需上下文','待定','需要上下文','需要更多上下文'],
      };
      const rawAdvance=String(row.canonAdvance==null?'':row.canonAdvance).trim().toLowerCase();
      const canonAdvance=Object.keys(canonAdvanceAliases).find(key=>canonAdvanceAliases[key].some(alias=>alias.toLowerCase()===rawAdvance));
      if(!canonAdvance){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力枚举值不合法：人物'+row.actorRef+'的 canonAdvance 写成了「'+String(row.canonAdvance)+'」，只能是 none / push / break / needs_context 之一'});continue;}
      if(canonAdvance!==row.canonAdvance){
        // 归一化成功：记录真实写法，便于排查模型输出质量；结论不变。
        row.rawCanonAdvance=row.canonAdvance;row.canonAdvance=canonAdvance;row.canonAdvanceNormalized=true;
      }
      /* 理由为空：模型偶尔会漏写 reason，但**判定本身可能是对的**。
       * 原来这里直接判死，玩家重试两次照样失败。
       * 现在补一条明确标注的理由（写明是系统补的，不是模型说的），
       * 继续往下走——如果判断本身有问题，后面走廊/引用校验会拦住它。
       */
      if(['sameEventNoProgress','outsideRange'].includes(turnAdvanceTier)&&canonAdvance==='push'){
        rejected.push({actorRef:row.actorRef,reason:'无进展或年表外档只能按真实破壁追加任务；有实际常规进展须先修正本轮档位'});continue;
      }
      if(!String(row.reason || '').trim()){
        row.reason='（模型未给出理由，系统按其判定『'+canonAdvance+'』继续；若该判定不当，请在诊断里查看原始返回）';
        row.reasonAutoFilled=true;
      }
      const ownEvents=actor.eventIds || [...eventCodes];
      /* ★★ 2026-11-02 全面复盘「合并报错」：原来 3 种情况挤成一句。拆开。 */
      if(!strings(row.eventIds)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 eventIds（事件编号）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.eventIds)+'；应为字符串数组'});continue;}
      if(!row.eventIds.length){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 eventIds（事件编号）是空的：人物'+row.actorRef+'至少要引用一个本轮事件编号'});continue;}
      {
        const badEventIds=row.eventIds.filter(id=>!eventCodes.has(id)||!ownEvents.includes(id));
        if(badEventIds.length){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力引用了不属于该人物本轮范围的事件：人物'+row.actorRef+'写了 '+badEventIds.map(i=>'「'+String(i)+'」').join('、')
          +'；该人物本轮可引用的事件只有：'+(ownEvents.length?ownEvents.map(i=>'「'+i+'」').join('、'):'（无）')});continue;}
      }
      /* ★★ 2026-11-02 玩家截图：又出现「重试 2 次后仍失败：原著推力依据、材料或实际影响引用无效」。
       *
       * 这就是 1.0.4 修过的那类病的**第二个入口**：上一轮只拆了上面
       * 「人物引用 / 枚举 / 理由」那一条，把这条漏了。
       *
       * 原来这一条 if 把 **7 种完全不同的校验**挤进同一句 reason：
       *   ① requiredInfluences 不是字符串数组
       *   ② sourceRefs 不是字符串数组
       *   ③ sourceRefs 为空
       *   ④ sourceRefs 里引用了不存在的东西
       *   ⑤ affectedRefs 不是字符串数组
       *   ⑥ affectedRefs 里引用了不存在的人物
       *   ⑦ requiredMaterials 不是字符串数组
       * 玩家看到同一句话，根本不知道是哪一种，重试多少次都是同一个结果。
       *
       * 现在逐个拆开，每条都带出**实际值**和**合法取值**，
       * 让玩家一眼看出是哪个字段、写成了什么、应该是什么。
       */
      if(!strings(row.requiredInfluences)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 requiredInfluences（实际影响）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.requiredInfluences)+'；应为字符串数组，如 []'});continue;}
      if(!strings(row.requiredMaterials)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 requiredMaterials（所需材料）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.requiredMaterials)+'；应为字符串数组，如 []'});continue;}
      if(!strings(row.sourceRefs)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 sourceRefs（依据引用）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.sourceRefs)+'；应为字符串数组'});continue;}
      if(!row.sourceRefs.length){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 sourceRefs（依据引用）是空的：人物'+row.actorRef+'没有给出任何依据；至少要引用本轮事件、事实或「before:'+row.actorRef+'」'});continue;}
      {
        // 逐个引用检查，指出**具体哪一个**不合法，而不是笼统说「无效」。
        const allowedFor=(ref)=>eventCodes.has(ref)||ids.has(ref)||context.extraSourceRefs?.includes(ref)||ref===('before:'+row.actorRef)||actor.nextReferenceIds?.includes(ref);
        const badRefs=row.sourceRefs.filter(ref=>!allowedFor(ref));
        if(badRefs.length){
          const samples=[...eventCodes].slice(0,4).map(c=>'「'+c+'」').join('、');
          const factSamples=[...ids].slice(0,4).map(c=>'「'+c+'」').join('、');
          rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的依据引用不存在：人物'+row.actorRef+'引用了 '+badRefs.map(r=>'「'+String(r)+'」').join('、')
            +'，但本轮没有这些编号。可引用的是：本轮事件'+(samples?'（'+samples+'…）':'')+'、事实'+(factSamples?'（'+factSamples+'…）':'')
            +'、或「before:'+row.actorRef+'」'});continue;
        }
      }
      if(!strings(row.affectedRefs)){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的 affectedRefs（受影响对象）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(row.affectedRefs)+'；应为字符串数组，如 []'});continue;}
      {
        const badAffected=row.affectedRefs.filter(ref=>!refs.has(ref));
        if(badAffected.length){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力的受影响对象不存在：人物'+row.actorRef+'写的是 '+badAffected.map(r=>'「'+String(r)+'」').join('、')
          +'，但本轮可影响的人物只有：'+[...refs].join('、')});continue;}
      }
      /* ★★ 2026-11-02 全面复盘：原来 7 种情况挤成一句「走廊缺少…」。
       * 走廊是最容易卡死的地方，玩家必须知道到底缺哪一项。逐个拆开。 */
      if(!corridor){rejected.push({actorRef:row&&row.actorRef,reason:'原著推力缺少走廊（corridor）对象：人物'+row.actorRef+'没有给出 corridor；必须包含 baselineRef、currentStage、nextReferenceIds、intact、breakReasons'});continue;}
      if(corridor.baselineRef!==('before:'+row.actorRef)){rejected.push({actorRef:row&&row.actorRef,reason:'走廊起点不合法：人物'+row.actorRef+'的 baselineRef 是「'+String(corridor.baselineRef)+'」，必须是「before:'+row.actorRef+'」'});continue;}
      if(!String(corridor.currentStage || '').trim()){rejected.push({actorRef:row&&row.actorRef,reason:'走廊缺少当前阶段（currentStage）：人物'+row.actorRef+'必须写出他当前处于原著的哪个阶段'});continue;}
      if(!strings(corridor.nextReferenceIds)){rejected.push({actorRef:row&&row.actorRef,reason:'走廊的 nextReferenceIds（下一节点引用）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(corridor.nextReferenceIds)+'；应为字符串数组'});continue;}
      {
        const badNext=corridor.nextReferenceIds.filter(ref=>!actor.nextReferenceIds?.includes(ref));
        if(badNext.length){rejected.push({actorRef:row&&row.actorRef,reason:'走廊的下一节点引用不存在：人物'+row.actorRef+'写了 '+badNext.map(r=>'「'+String(r)+'」').join('、')
          +'，但该人物可用的下一节点只有：'+(actor.nextReferenceIds?.length?actor.nextReferenceIds.map(r=>'「'+r+'」').join('、'):'（无）')});continue;}
      }
      if(![true,false,null].includes(corridor.intact)){rejected.push({actorRef:row&&row.actorRef,reason:'走廊的 intact（是否完好）取值不合法：人物'+row.actorRef+'写成了 '+JSON.stringify(corridor.intact)+'；只能是 true / false / null'});continue;}
      if(!strings(corridor.breakReasons)){rejected.push({actorRef:row&&row.actorRef,reason:'走廊的 breakReasons（破壁理由）不是字符串数组：人物'+row.actorRef+'写成了 '+JSON.stringify(corridor.breakReasons)+'；应为字符串数组，如 []'});continue;}
      /* ★★ 2026-11-02 全面复盘：原来 3 种情况挤成一句。拆开。 */
      if(row.canonAdvance==='break'){
        if(corridor.intact!==false){rejected.push({actorRef:row&&row.actorRef,reason:'标了破壁（break）但走廊仍标为完好：人物'+row.actorRef+'的 corridor.intact 是 '+JSON.stringify(corridor.intact)+'；破壁必须把 intact 设为 false'});continue;}
        if(!corridor.breakReasons.length){rejected.push({actorRef:row&&row.actorRef,reason:'标了破壁（break）但没有给破壁理由：人物'+row.actorRef+'的 breakReasons 是空的；必须写明破壁的因果关系'});continue;}
        if(!row.affectedRefs.includes(row.actorRef)){rejected.push({actorRef:row&&row.actorRef,reason:'标了破壁（break）但没把本人列为受影响对象：人物'+row.actorRef+'的 affectedRefs 是 '+JSON.stringify(row.affectedRefs)+'；破壁必须包含他本人'});continue;}
      }
      if(row.canonAdvance==='none'&&corridor.intact===false){rejected.push({actorRef:row&&row.actorRef,reason:'已确认破壁不能继续标为无原著推进'});continue;}
      actorDecisions.push({...row,name:actor.name});
    }
    const brokenRefs=new Set(actorDecisions.filter(row=>row.canonAdvance==='break').flatMap(row=>row.affectedRefs));
    additionalAffectedRefs=[...brokenRefs].filter(ref=>!actorDecisions.some(row=>row.actorRef===ref));
    if(actorDecisions.some(row=>brokenRefs.has(row.actorRef)&&row.canonAdvance!=='break')){
      /* ★★★ 2026-11-03 玩家反复撞上的：
       *   「补演前置准备：重试 2 次后仍失败：破壁须明确本人实际受影响及有因果的破壁理由。」
       *
       * 【原来的行为】这里直接 return {ok:false}，**整轮补演当场中止**：
       * 只要 A 被 B 判为破壁受影响、而 A 自己写成 none，
       * 哪怕其它 20 个人全都写对了，也一个都不推进，
       * 玩家只能看着「重试 2 次后仍失败」干瞪眼。
       *
       * 【为什么这是错的】玩家 2026-11-01 就定过原则：
       *   「一个人物出错不再拖垮整轮，写对的照常推进，出错的单独标出可重跑」
       *   「谁错剔谁」
       * 上面 569-576 行（缺理由、缺 intact、没列本人…）早就已经是「剔掉这一个人」，
       * 只有这条跨人物一致性还在整轮硬失败 —— 明显是漏改。
       *
       * 【现在】把「本人写成非 break」的这一方**当作出错方剔掉**，
       * 其余人物照常推进；被剔的人进 rejected，上层会自动只重跑他们。
       *
       * 为什么剔「本人」而不是剔「判他破壁的人」：
       *   · 破壁是 B 说 A 卷进了原著推进，B 给出了 break + 理由，B 的声明是完整的；
       *   · A 自己写 none 且没有任何破壁说明 —— 缺证据的是 A 这一侧。
       *   剔 A 不会让 B 的判断失效（B 的 affectedRefs 里仍然记着 A，
       *   下一轮重跑 A 时它必须补齐 break 与因果依据）。
       */
      const inconsistent=actorDecisions.filter(row=>brokenRefs.has(row.actorRef)&&row.canonAdvance!=='break');
      const inconsistentRefs=inconsistent.map(row=>row.actorRef);
      inconsistent.forEach(row=>{
        rejected.push({actorRef:row.actorRef,reason:'破壁因果关系不一致：「'+row.actorRef+'」被其他人列为破壁受影响对象，但本人却写成 '+row.canonAdvance+'；本人也必须给 break 与因果依据（这一条只影响他本人，其余人物照常推进）'});
      });
      /* 从已通过的名单里摘掉他们，让上层按「这部分人要重跑」处理。 */
      const keep=actorDecisions.filter(row=>!inconsistentRefs.includes(row.actorRef));
      actorDecisions.length=0;
      keep.forEach(row=>actorDecisions.push(row));
      /* ★ 剔除之后必须**重算** brokenRefs / additionalAffectedRefs。
       * 上面 579-580 行那份是按「还没剔除」的人数算的，
       * 被剔掉的人如果本身标了 break，他声明的影响对象还挂在 additionalAffectedRefs 里，
       * 会让下游以为「有个外部人物被破壁影响了」，而那个人其实已经不在本轮结果里。
       * 这类残留会造成世界/人物指令凭空多出一条，属于必须清掉的脏数据。 */
      brokenRefs.clear();
      actorDecisions.filter(row=>row.canonAdvance==='break').forEach(row=>(row.affectedRefs||[]).forEach(ref=>brokenRefs.add(ref)));
      additionalAffectedRefs=[...brokenRefs].filter(ref=>!actorDecisions.some(row=>row.actorRef===ref));
    }
    turnAdvanceTier=tier;crossEventActors=tierInvolvedActors;
  }
  if(!turnAdvanceTier&&['crossEvent','sameEventProgress','sameEventNoProgress','outsideRange'].includes(parsed.turnAdvanceTier))turnAdvanceTier=parsed.turnAdvanceTier;
  /* ★★ 2026-11-02 玩家定：「小错自己重试，大错修不好才报告，谁错修谁不影响其他人」
   *
   * 到这里，被剔掉的单个人物问题都在 rejected 里，其余人物已经正常通过。
   * 分级返回：
   *   · 一个人都没通过  → 真失败（ok:false），因为是整体性错误
   *   · 部分被剔        → 照常通过（ok:true），但带上 rejectedActors，
   *                       让上层能只重跑这一个人，不波及其他人
   */
  if(rejected.length && !actorDecisions.length){
    return {ok:false,reason:'本轮人物边界判定全部未通过：'+rejected.map(r=>'「'+(r.actorRef||'?')+'」'+r.reason).join('；')};
  }
  return {...(rejected.length?{rejectedActors:rejected}:{}),...facts,handled,influences,worldEvents,eventProgress:progressRows,...(progressNote?{eventProgressPending:progressPending,eventProgressNote:progressNote,eventProgressDetail:{missing:progress.missing||[],unexpected:progress.unexpected||[],invalid:progress.invalid||[]}}:{}),activatedEvents,eventWatches,uncertain:parsed.uncertain || [],...(turnAdvanceTier?{turnAdvanceTier,coveredEventIds:coveredTurnEventIds,involvedActors:tierInvolvedActors}:{}),...(actorDecisions?{actorDecisions,additionalAffectedRefs}:{}),...(context.bodyTimeKnown===false?{bodyEndTime:parsed.bodyEndTime}:{})};
}

/** 只兼容确定的字段/排版差异；不猜事实主体、不制造引文或人物影响。 */
export function normalizeStoryBoundary(raw,context={}) {
  const parsed=parseJsonLoose(raw);
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))return raw;
  const pick=(value,keys)=>{for(const key of keys)if(value && value[key]!==undefined)return value[key];};
  const quote=(source,value)=>{
    if(typeof value!=='string')return value;
    const text=value.trim();if(!text || source.includes(text))return text;
    const fold=s=>String(s).normalize('NFKC').replace(/\s/g,'').replace(/[“”„‟]/g,'"').replace(/[‘’]/g,"'");
    let compact='';const positions=[];
    for(let i=0;i<source.length;i++){const part=fold(source[i]);compact+=part;for(let j=0;j<part.length;j++)positions.push(i);}
    const wanted=fold(text),index=compact.indexOf(wanted);
    return wanted && index>=0?source.slice(positions[index],positions[index+wanted.length-1]+1):text;
  };
  const out={...parsed},groups={facts:['facts','事实'],handled:['handled','正文人物','已处理人物'],influences:['influences','人物影响'],worldEvents:['worldEvents','世界事件'],eventProgress:['eventProgress','事件进度'],uncertain:['uncertain','不确定项'],resolvedHooks:['resolvedHooks','已收尾钩子']};
  for(const [key,aliases] of Object.entries(groups)){const value=pick(parsed,aliases);if(value!==undefined)out[key]=value;}
  const used=new Set((Array.isArray(out.facts)?out.facts:[]).filter(row=>row && typeof row==='object').map(row=>pick(row,['id','factId','编号'])).filter(id=>id!==undefined).map(String));
  if(Array.isArray(out.facts))out.facts=out.facts.map((row,i)=>{
    if(!row || typeof row!=='object')return row;
    let id=pick(row,['id','factId','编号']);if(id===undefined){let n=i+1;while(used.has('F'+n))n++;id='F'+n;used.add(id);}
    return {...row,id:String(id),text:pick(row,['text','描述','事实','description','content']),subject:pick(row,['subject','主体','主体人物','事实主体','owner','actor']),evidence:quote(String(context.storyText || ''),pick(row,['evidence','原句','正文原句','证据','quote','依据原文']))};
  });
  const canonicalName=value=>{
    const text=String(value || '').trim(),people=context.people || [];
    if(people.some(person=>person.name===text))return text;
    const matches=people.filter(person=>(person.aliases || []).includes(text) || (person.isPlayer || person.id==='B1') && ['玩家','主角','我','B1'].includes(text));
    return matches.length===1?matches[0].name:text;
  };
  if(Array.isArray(out.handled))out.handled=out.handled.map(row=>row && typeof row==='object'?{...row,name:canonicalName(pick(row,['name','姓名'])),reason:pick(row,['reason','理由']),evidence:quote(String(context.storyText || ''),pick(row,['evidence','原句','quote']))}:row);
  if(Array.isArray(out.impactScope?.names))out.impactScope={...out.impactScope,names:out.impactScope.names.map(canonicalName)};
  if(!context.prebuiltOnly&&out.impactScope?.hasImpact!==false&&Array.isArray(out.influences))out.influences=out.influences.map(row=>{
    if(!row || typeof row!=='object')return row;
    const name=pick(row,['name','姓名']),actor=(context.actors || []).find(a=>a.name===name),source=actor?String(context.storyText || '')+'\n'+String(actor.material || '')+'\n'+JSON.stringify(projectActorProfile(actor.state) || {}):'';
    return {...row,name:canonicalName(name),reason:pick(row,['reason','理由']),factIds:pick(row,['factIds','事实编号']),basis:quote(source+'\n'+String(context.background || ''),pick(row,['basis','依据','原句']))};
  });
  if(Array.isArray(out.actorDecisions))out.actorDecisions=out.actorDecisions.map(row=>{
    if(!row || typeof row!=='object')return row;
    const supplied=row.actorRef ?? row.id ?? row.name;
    const matches=(context.actors || []).filter(actor=>[actor.actorRef,actor.name].includes(supplied));
    if(matches.length!==1)return row;
    const actorRef=matches[0].actorRef || matches[0].name;
    return {...row,actorRef,...(row.corridor?.baselineRef===('before:'+supplied)?{corridor:{...row.corridor,baselineRef:'before:'+actorRef}}:{})};
  });
  return JSON.stringify(out);
}

export async function analyzeStoryBoundary(input = {}) {
  const {host,storyText='',people=[],hooks=[],events=[],background='',options={}}=input;
  const actors=(input.actors || []).map(actor=>({...actor,state:projectActorProfile(actor.state)}));
  const prebuilt = Array.isArray(input.prebuilt) ? input.prebuilt : [];
  const pointerEvents=new Map(prebuilt.filter(event=>event.formatVersion===6)
    .flatMap(event=>event.nodes.flatMap(node=>(node.milestones||[node]).map(marker=>
      [marker.id,{eventId:event.code,windowPosition:marker.windowPosition}]))));
  const savedPointers=new Set((input.eventProgress||[]).flatMap(event=>event.nodes||[]).flatMap(node=>{
    const markers=node.milestones||[];
    const last=markers.findIndex(marker=>marker.id===node.reachedMilestoneId);
    const settled=['applied','repaired'].includes(node.prebuilt);
    return [...(node.milestoneReceipts||[]).map(row=>row.id),node.reachedMilestoneId,
      ...(settled?[node.nodeId,...markers.map(row=>row.id)]:markers.slice(0,last+1).map(row=>row.id))];
  }));
  const prebuiltOnly=options.prebuiltOnly===true && events.length>0 && prebuilt.length===events.length;
  const ordinaryBoundary=Number(options.canonPushBoundaryVersion)>=1 || prebuiltOnly;
  if(!host || typeof host.llmCall!=='function')return {ok:false,reason:'缺少llmCall'};
  const context={storyText,actors,people,hooks,events,background,eventProgress:input.eventProgress || [],currentTime:input.currentTime || '',eventProgressVersion:options.eventProgressVersion,canonPushBoundaryVersion:options.canonPushBoundaryVersion};
  context.bodyTimeKnown=options.bodyTimeKnown;context.range=input.range;context.prebuiltOnly=prebuiltOnly;
  if(prebuiltOnly)context.canonPushBoundaryVersion=1;
  if(prebuiltOnly)context.eventProgressVersion=0;
  context.extraSourceRefs=input.extraSourceRefs || [];
  context.referenceEvents=input.referenceEvents || [];
  context.affectedActorRefs=input.affectedActorRefs || [];
  // Keep every name and alias for unexpected appearances, without repeating
  // empty arrays and false player flags for the entire canon roster.
  const scopedNames=new Set(actors.map(actor=>actor.name));
  const referenceText=prebuiltOnly?storyText+'\n'+(input.referenceEvents||[]).map(event=>[event.title,event.summary].join(' ')).join('\n'):'';
  const rosterPeople=prebuiltOnly?people.filter(person=>person.isPlayer||scopedNames.has(person.name)||
    [person.name,...(person.aliases||[])].some(name=>name&&referenceText.includes(name))):people;
  const roster=rosterPeople.map(person=>({
    name:person.name,
    ...(person.id?{id:person.id}:{}),
    ...(person.aliases?.length?{aliases:person.aliases}:{}),
    ...(person.isCanon===false?{isCanon:false}:{}),
    ...(person.isPlayer===true?{isPlayer:true}:{}),
  }));
  // 权威正文由程序独立附在末尾；旧自定义提示词漏占位符也不能漏发或串源。
  const content=(prebuiltOnly?'用现有预制指针判断本轮档位与是否存在必须处理的节点例外。先判断有无例外。有例外才定位受影响节点及必要的人物。原样取用的节点不逐个复核。\n待收尾钩子：'+JSON.stringify(hooks):fillTemplate(promptText('storyFacts',options.promptOverrides),{'{{本轮正文}}':'请读取末尾【本轮实际正文，唯一正文事实证据来源】。','{{待收尾钩子}}':JSON.stringify(hooks)}))
    +(prebuiltOnly?'\n【预制成品独立路线】本轮全部候选已有已匹配成品，但成品存在不代表本轮需要补演。必须先完成下方共同档位及逐人走廊判定；无实际补演任务就结束，不落变量、不修订成品。确有任务才在任务范围内判原样取用或定向变异。保留turnAdvanceTier、coveredEventIds、involvedActors和actorDecisions，不要求普通节点登记。正常且本轮实际需要的节点直接复用；只有真实因果变化及依赖进入prebuiltNodes。handled只表示正文涉及，不能据此认定节点变异；有实际因果影响须在prebuiltNodes精确列出受影响节点和人物。\n':'')
    +(ordinaryBoundary?'\n【第一步：先判本轮时间推进档位】同一次请求先返回turnAdvanceTier，再按档位决定要不要逐人细说。判的是「本轮时间跨度覆盖了几个年表事件区间」，不是「候选年表里有几条提到了这个人」。\n'
      +'· crossEvent（跨年表事件）：本轮起终点覆盖两个及以上年表事件区间，或从开局/断点续跑起把此前多个事件一次性补起。此时全员完整补演，不要求你逐人说明补什么——补什么由后续人物补演阶段按年表自然展开。只需返回coveredEventIds和involvedActors（这些事件区间内出现的全部原著人物）。\n'
      +'· sameEventProgress（同事件内有实际进展）：本轮只落在同一年表事件区间内，且该事件内产生了新的原著要求（进入新阶段、关键条件实质改变、应有经历尚未落实）。这是唯一需要逐人细说的档位。\n'
      +'· sameEventNoProgress（同事件内无实际进展）：本轮只落在同一年表事件区间内，没有产生新的原著要求。此时补演流程到此结束，不补演，也不要求逐人说明。\n'
      +'· outsideRange（年表之外 · 无需补演）：本轮时间不落在任何候选年表事件区间内——在原著第一件事之前，或已过最后一件事的参考终点。这一档没有可用的原著推力：不补演，也不逐人推演，coveredEventIds留空数组。只有真实破壁者仍需上报。\n'
      +'先按实际起终点和事件区间判断范围，再结合正文、账本、阶段前提与人物实际状态判断进展。不以日期经过多少、候选条目数量或活跃名单决定；同一个年表事件内天数再多也仍是同事件档，同一时间有实质变化仍可为sameEventProgress。\n【实际起终点】'+JSON.stringify(input.range || {end:input.currentTime})+'\n':'')
    +(ordinaryBoundary?'\n【第二步：逐人走廊与破壁检查】破壁独立于档位、优先级最高：任何档位下出现真实重大变异打破走廊，实际受影响者都立刻转完整补演。\n'
      +'· crossEvent档：不要求逐人返回actorDecisions——全员已经完整补演，破壁不再带来额外升级，逐人细节交给人物补演阶段。\n'
      +'· sameEventProgress档：返回actorDecisions，覆盖全部actors。handled仅表示玩家正文涉及；本人未落实的年表任务及交互变化仍由补演处理。不引入其他人物。\n'
      +'· sameEventNoProgress档：只列出被真实变异打破走廊的人（canonAdvance用break），其余人可以不出现；确实一个都没有就返回空数组。\n'
      +'· outsideRange档：与sameEventNoProgress相同——只列出被真实变异打破走廊的人，其余人不需要出现。\n'
      +'每项{actorRef,eventIds,canonAdvance:"none|push|break|needs_context",reason,requiredInfluences:[],sourceRefs:[],corridor:{baselineRef:"before:人物引用",currentStage,nextReferenceIds:[],intact:true或false或null,breakReasons:[]},affectedRefs:[],requiredMaterials:[]}。sourceRefs只能使用候选事件code、facts的id、本人before引用或本人nextReferenceIds。逐人判断原著本阶段是否有新要求，不以日期经过、姓名、已有道具或普通心情判推进；同事件十天无新要求用none，实际授功节点等用push，确认关键资源毁坏等真实外力打破走廊用break并只列实际受影响者，缺必要资料用needs_context。活跃名单不得影响语义结论。所有时段、新旧档案都须考虑走廊：从轮前真实状态、当前阶段与下一节点材料判断；未来资料是条件性参考，回忆、幻境、假设和他人境界不是上限；未知未来不冻结境界内进度，不按经过天数比例增长，不自造机缘豁免。break只使有证据的约束失效，其余约束保留；所需影响是推演材料，不是锁定故事成果。\n':'')
    +(ordinaryBoundary?'\n【正常跨节点、跨事件推进】push也包含正常跨节点、跨事件推进，不只代表同事件短时间增量。本轮经过且尚未保存的本人经历都须纳入，不能只取最后事件；新建档人物与已有档案人物都判断，不要求先有重大变异才补演。进行中事件只推到实际终点，已经确认的过去不重复。none仅在本人确无尚需补的实际原著进展时使用，不因推进正常、未破壁或没有玩家影响而省略任务。\n':'')
    // nodes 跟 canonPushBoundaryVersion 走，不跟 eventProgressVersion。
    // 旧路径（只开 eventProgressVersion）刻意只要展示档位，不引入节点登记这套重协议，
    // 见 tests/progress-nodes-tier.test.mjs「旧路径只请求展示档位」。
    // 两条协议的自查关系只在两者同时开启时成立——实际运行两个开关默认都是 1。
    +(ordinaryBoundary&&!prebuiltOnly?NODE_REGISTRY_PROTOCOL:'')
    +(options.bodyTimeKnown===false?'\n【实际正文终点待语义确认】同一次回信必须增加bodyEndTime字符串。以轮前真实起点和本轮已采用正文确定终点；范围end仅是候选检索锚点，不是正文实际终点。不得以指导计划、未来年表或旧世界行替代已发生事实，无法确定须明确返回null而不能假成功。事件推进、走廊和eventProgress也必须以此实际终点为准；代码不按天数替人物增加修为。\n':'')
    +'\n\n【同一次正文边界判定，以下协议优先】\n'
    +(prebuiltOnly?'只识别正文实际涉及的原著人物和与既有节点例外有关的硬事实。人物影响直接归入对应节点的例外，不分析、不返回普通补演的 influences。':'先用已确认事实判断有无实质人物影响，再在 impactScope.names 圈出确实受影响的人。无影响时 hasImpact=false、names=[]、influences=[]。有影响时只为圈中人物判断具体影响。出场、日期经过或资料中提及都不能单独构成影响。')
    +'姓名、别名、颜色、身体描述和职业称呼须结合上下文辨认，不能仅因字串重合就认同一个人。'
    +'正文实际处理过的人物才列handled；只是提示词例子、年表材料或无关的同名词不能算正文已写。'
    +'handled只收原著NPC；名单标注isPlayer/B1的是玩家，isCanon=false的是普通剧情人物，均不列handled、不补档、不写NPC补演。玩家和普通NPC的正文事实仍可放facts，只有存在实际因果联系才影响原著NPC。第一轮没有原著NPC被正文处理时handled=[]完全正常。'
    +(prebuiltOnly?'没有影响节点的硬事实时 facts=[]。':'influences也只能指向下方actors内的原著NPC；普通NPC之间的吃饭、送东西等变化由普通重点演化负责，不填这里。facts只保留会改变原著事件、原著NPC或其现实前提的实际变化；抹炭灰、普通烤肉口感等无关琐事不用列入。没有原著关联时facts/handled/influences均可为空。')
    +'第一人称我家和我的消耗属于玩家，不是年表韩家。人物只是旁观不等于发生了相同变化。'
    +(prebuiltOnly?'':'保留蝴蝶影响：玩家封路、关键人物死亡、资源毁坏可能影响离场人物，但必须结合其材料说明因果；事实所有者仍保持原主体。')
    +'同时判定候选事件中哪些还有正文之外的独立世界变化，列worldEvents编号与理由；有名字不等于没有世界影响，泛称或已故也不能靠词表一概归类。仅个人经历不能凑成世界事件。'
    +'worldEvents不是“日期已过的事件清单”：拜师、离家等个人经历不能因此再列世界事件；绝不凭当前日期推定事件发生完毕。候选日期仅表示原著参考，实际发生和收尾要等本轮NPC故事及变量落实确认。'
    +'没有影响不要硬连；不能确定的情况必须放入uncertain说明原因，不能伪装成未涉及或无影响。不得虚构正文原句或材料依据。'
    +'开局没有历史存档或NPC档案是正常情况。设定检索已执行但无命中也属于正常回信，只代表资料较少：依据已有正文、年表和存档继续判断，未知设定写明未知，不得捏造；uncertain用于记录信息局限，不意味着必须停止后续流程。'
    +'仅输出JSON：{"facts":[{"id":"F1","text":"谁发生什么变化","subject":"真实主体","evidence":"完整正文原句"}],'
    +'"handled":[{"name":"名单中的规范姓名","reason":"为何确认是本人且正文实际处理过","evidence":"正文原句","presentAtEnd":true,"presenceEvidence":"证明正文结束时仍在当前场景的逐字原句"}],'
    +(prebuiltOnly?'':'"impactScope":{"hasImpact":false,"names":[]},"influences":[{"name":"候选人物规范姓名","factIds":["F1"],"reason":"这条变化对他的具体影响，区分自身与间接影响","basis":"该人物材料或正文中的逐字联系依据"}],')+'"worldEvents":[{"code":"候选事件编号","reason":"未被正文覆盖的世界影响"}],"uncertain":[],"resolvedHooks":[]'+(!prebuiltOnly && Number(options.eventProgressVersion)>=1?',"eventProgress":[]':'')
    +(ordinaryBoundary?',"turnAdvanceTier":"crossEvent|sameEventProgress|sameEventNoProgress|outsideRange","coveredEventIds":["本轮时间跨度覆盖到的候选事件编号"],"involvedActors":["crossEvent档下的全部相关原著人物规范姓名"],"actorDecisions":[{"actorRef":"候选稳定引用","eventIds":["本人的候选事件编号"],"canonAdvance":"none|push|break|needs_context","reason":"具体语义理由","requiredInfluences":[],"sourceRefs":["合法依据编号"],"corridor":{"baselineRef":"before:候选稳定引用","currentStage":"当前实际阶段","nextReferenceIds":[],"intact":true,"breakReasons":[]},"affectedRefs":[],"requiredMaterials":[]}]':'')+(options.bodyTimeKnown===false?',"bodyEndTime":"依据实际正文确认的终点"':'')+'}。'
    +(ordinaryBoundary || prebuiltOnly?'':'\n【本轮档位】同次返回turnAdvanceTier：crossEvent=跨越多个事件；sameEventProgress=同事件内有实际原著进展；sameEventNoProgress=同事件内没有新增原著要求；outsideRange=年表之外且无已启动或有效延期的事件。依据本轮起终点、实际正文与账本判定，不以候选数量或日期比例代替。该字段不要求额外逐人分工。')
    +(prebuiltOnly?'facts、handled始终返回，编号不能重复。':'facts、handled、influences始终返回，编号不能重复。')+'presentAtEnd只在正文证明该人结束时仍在玩家当前场景（包括能直接交互的近处）或已明确离开时填写；一度出场、被提及或远处同时活动不能当作仍在场。不确定省略，不猜。钩子规则保持上文。\n【人物姓名与已有别名：未标 isCanon=false 的是原著人物，只有 isPlayer=true 的是玩家】\n'+JSON.stringify(roster)
    +'\n【正文后共享资料：存档现状与叙事记忆供核对，不得倒写正文前历史；原著参考不等于已发生事实】\n'+background+'\n【待判定人物各自的原著材料与当前状态】\n'+JSON.stringify(actors)+'\n【候选事件，仅作判断材料，不代表正文已经发生】\n'+JSON.stringify(events)
    +'\n【账本已保存的实际进度，始终供本次边界参考】\n'+renderEventProgress(context.eventProgress)+'\n当前实际时间：'+context.currentTime
    +(context.referenceEvents.length?'\n【时间之外的相关年表参考，不默认启动】\n'+JSON.stringify(context.referenceEvents)+'\n可附eventWatches:[{eventId,status:suspected或confirmed或dismissed,reason}]，按提供的真实编号记变异嫌疑、确认或排除；嫌疑不得当作启动。若真实正文、已保存变异或人物行为足以让未来事件提前启动，或过去事件有真实原因延期且机会仍成立，附activatedEvents:[{eventId,kind:early或delayed,reason,actualStart}]，说明因果，实际起点未知留空。这次仍只按当前候选给分工；系统会仅在确有提前启动时把该真实事件和相关人物加入同轮再确认范围。不可因资料出现、只提姓名或未来必然发生就激活。':'')
    +'\n【过去与未来的机会性质】过去未完成不等于可以延期：限时试炼、秘境窗口自然关闭后可能彻底错过。只有客观变异、NPC或玩家的真实介入且条件仍有效，才能延期；前提破坏可取消/替代。区分系统尚未补写的历史与人物实际错过机会，不能把前者当后者跳过。未来事件也不能仅因未到日期硬排除，真实提前必须明确因果。'
    +(!prebuiltOnly && Number(options.eventProgressVersion)>=1?'\n【本轮事件进度判断，合并在同一请求】\n'+EVENT_PROGRESS_PROTOCOL+'\n这一阶段只记录正文及已存档事实，尚未写出的NPC行为不能算已发生。若同日先行事件尚未完成，后续事件有实际启动、变异或破壁证据才登记，进度行的 evidence 逐字引用本轮正文证明该事已发生或确实被改变；已入账的事实沿用存档。未开始则 occurred=[]，节点全为 todo，并在 current 写明尚未开始。后续NPC自由推演，进度由最终世界阶段确认，不预定结局。':'')
    +(prebuilt.length?'\n【现有预制进度指针 · 只读】\n'+JSON.stringify(prebuilt)
      +'\n预制事件以这里的既有节点、前提和已保存进度为准。只判原样取用或列出例外，不生成或重写事件进度、节点编号及原定里程碑。'
      +(pointerEvents.size?'\n同一回复附 prebuiltThrough 数组。每个事件最多引用一个已有编号，表示本轮确认经过的最后一项。合并节点引用实际经过的子里程碑。尚未经过任何一项就不列。跨事件时，已纳入 coveredEventIds、于本轮正文日期之前结束且无例外的历史成品由程序原样取用，可不复述其节点编号。延期、变异、受阻或未完成须列为例外。结合本轮边界、存档和原著前提判断正常背景进度，玩家无需目击。时间窗只是参考，不能单凭日期或人物出场判定经过。只写已有编号，例如 ["E-001-N2"]。': '')
      +'\n在同一个 JSON 根对象中必须返回 prebuiltNodes:[{id,status,reason,resolution,at,title,actors,withdrawnActors,reviseWorld,worldDependsOn,clearedActors}]。只列真实因果改变（mutated）、本应到期但前提未满足（pending）、确实无法核定（uncertain）的节点。说明依据和仍待观察的影响；时间相邻、同一人物或未目击都不构成因果。mutated须同次锁定resolution（occurred、cancelled、pending）。occurred返回实际日期at（YYYY.MM.DD）、title、需要修改的原人物actors、明确未参加的原人物withdrawnActors（两组不得重叠），以及世界大事是否受影响reviseWorld（布尔）、需要等待哪些修订人物worldDependsOn（数组）；clearedActors只列有依据证明对应变异影响已经解除的人物。取消或待定可省略这些字段。仅当事件已完成且只是单人灵石获得量变化、成品与正文证据中有可逐字替换的同一短语时，可附 adjustments:[{name,column:"26",beforeAmount,afterAmount,originalText,actualText,factId}]。两条短语只允许数字不同，actualText须在factId原句内。其他变异走定点修订。没有例外返回prebuiltNodes:[]。账本impact记录前次变异影响，延续或解除须有依据；若节点含milestones，其中任一项受影响则登记该节点。若合并节点与当前同日且还在事件时间内，只有正文确认最后一项已完成才用原编号返回 ready；未完只写到现场，由本地接续，不提前兑现终态。':'')
    +(pointerEvents.size?'\n本轮正文确认新经过的里程碑可附 prebuiltReached:[{id:"既有里程碑编号",evidence:"本轮正文逐字原句",at:"正文中明确记载的实际时间，可省略"}]，id 必须与 prebuiltThrough 中该事件确认的最远进度一致。时间窗的 ahead/overlaps/elapsed 只是参考，只凭时间不能触发。短回合中，尚未到结算节点的普通推进仅登记确认过的子里程碑；正文内的动作、短时伤势、位置和世界大事对人物的即时影响由普通变量演化承接。只有真正到达新结算节点，或有证据证明原著走向、前提或预定后果已改变，才安排实际受影响的预制人物或世界修订。':'')
    +'\n【本轮实际正文，唯一正文事实证据来源】\n'+storyText+'\n【本轮实际正文结束】\nfacts和handled的evidence只能逐字摘录以上正文中的连续原句，保留原标点，不用省略号拼接，不引用年表、共享资料或格式示例。subject填写该事实的实际主体；第一人称我只代表玩家。无法从正文确认的判断移入uncertain并说明局限，不伪造证据，不为凑条数制造事实。没有可证实且与原著相关的变化时facts=[]是正常结果。';
  let accepted=null;
  // 事件进度漏项要把「具体缺哪几个编号」写进纠正段；只重复通用话术等于原样重发，模型无从纠正。
  // 结构化 correction 交给 withRetry 统一格式化。
  //
  // 这条重试是**基线本来就有的**，不是本轮新增，别把它当性能问题删掉。
  // 但本轮把「进度漏项」从 ok:false 改成了 ok:true + eventProgressPending，
  // 所以这里不能再用 value.ok 判断——否则 pending 时永远返回 null，重试就不会发生。
  // 缺项细节从 eventProgressDetail 取（pending 时才有）。
  const progressCorrection=value=>{
    if(!value)return null;
    const detail=value.eventProgressDetail||{};
    const pending=value.eventProgressPending===true;
    // 边界本身不合格时，value 里直接带 missing/unexpected/invalid。
    if(!pending && value.ok)return null;
    const items=[];
    const invalid=detail.invalid||value.invalid;
    const missing=detail.missing||value.missing;
    const unexpected=detail.unexpected||value.unexpected;
    if(invalid?.length)items.push({label:'编号或status不合法',actual:invalid.join('、'),hint:'eventId 用候选事件的 code，status 用 ongoing/changed/blocked/completed/replaced/expired/cancelled'});
    if(missing?.length)items.push({label:'缺少这些事件的进度',actual:'未返回',expected:missing.join('、'),hint:'每个候选事件都必须返回且只返回一次'});
    if(unexpected?.length)items.push({label:'这些编号不属于本次事件',actual:unexpected.join('、'),hint:'编号只能用候选事件里的 code'});
    if(!items.length)return null;
    return {items,hint:'本轮尚未开始或未推进的事件也要显式返回一行，status 用 ongoing/pending 写明尚未发生事项，不能省略。'};
  };
  const run=await withRetry(({correct,previous})=>host.llmCall(correct({stage:previous?'补演边界格式整理':'正文硬事实提取',priority:'foreground',messages:[{role:'user',content:content+(previous?.text?'\n'+previous.text:'')}],json:true})),{
    config:options.retry,signal:options.signal,retryDelayMs:options.retryDelayMs,maxDelayMs:options.retryMaxDelayMs,
    validate:raw=>{
      const normalized = normalizeStoryBoundary(raw,context);
      const value = parseStoryBoundary(normalized,context);
      let prebuiltCorrection='';
      if (value.ok && prebuilt.length) {
        const reply=parseJsonLoose(normalized);
        const nodes=reply?.prebuiltNodes;
        const through=reply?.prebuiltThrough;
        const pointerOk=!pointerEvents.size||(Array.isArray(through)&&through.every(id=>pointerEvents.has(id))&&
          new Set(through.map(id=>pointerEvents.get(id).eventId)).size===through.length);
        const ids=new Set(prebuilt.flatMap(event=>event.nodes.map(node=>node.id)));
        if (Array.isArray(nodes) && new Set(nodes.map(row=>row?.id)).size===nodes.length &&
            pointerOk&&nodes.every(row=>ids.has(row?.id)&&['ready','mutated','pending','uncertain'].includes(row.status)&&typeof row.reason==='string'&&row.reason.trim())){
          value.prebuiltNodes=nodes;
          if(pointerEvents.size){
            const end=context.bodyTimeKnown===false?value.bodyEndTime:input.range?.end||input.currentTime;
            const startPoint=parseTimePoint(input.range?.start), endPoint=parseTimePoint(end);
            const claims=Array.isArray(reply.prebuiltReached)?reply.prebuiltReached:[];
            const cited=new Map(claims.filter(row=>typeof row?.evidence==='string'&&row.evidence.trim()&&storyText.includes(row.evidence))
              .map(row=>[row.id,row]));
            value.prebuiltThrough=through.filter(id=>pointerEvents.get(id).windowPosition!=='ahead'||savedPointers.has(id)||cited.has(id));
            value.prebuiltReached=value.prebuiltThrough.filter(id=>!savedPointers.has(id)).map(id=>{
              const claim=cited.get(id),at=parseTimePoint(claim?.at);
              const knownAt=typeof claim?.at==='string'&&/\d{1,2}:\d{2}/u.test(claim.at)&&storyText.includes(claim.at)&&
                at!==null&&endPoint!==null&&at<=endPoint&&(startPoint===null||at>=startPoint);
              return {id,eventId:pointerEvents.get(id).eventId,confirmedAt:end||'',
                ...(claim?{evidence:claim.evidence}:{}),...(knownAt?{at:claim.at}:{})};
            });
          }
          value.prebuiltExceptions=true;
        } else {
          prebuiltCorrection=pointerOk?'请在原 JSON 根对象中补上合法的 prebuiltNodes 例外数组，编号只用本次提供的预制节点，未发现例外时必须写 prebuiltNodes:[]。'
            :'prebuiltThrough 只能引用本次提供的已有节点或子里程碑，每个事件最多一个，没有确认经过的编号写 []。';
          value.prebuiltUnavailable=true;
        }
      }
      accepted=value;
      const correction=progressCorrection(value);
      if(prebuiltCorrection&&!correction&&!value.rejectedActors?.length)return {ok:false,reason:prebuiltCorrection,correction:prebuiltCorrection};
      /* ★★ 2026-11-02 玩家定：「小错误就自己针对性重试补足」
       *
       * 被剔除的人物不是「整轮失败」，而是「这个人需要再试一次」。
       * 所以这里对 rejectedActors 也触发一次带明确纠正提示的重试——
       * 纠正提示里逐条写清「是谁、错在哪、正确写法」，模型照着改。
       *
       * 注意：这不是把错误藏起来。重试成功后 rejectedActors 自然消失；
       * 重试用尽仍有 rejectedActors，就会一路传到面板，明确显示「谁没过、为什么」，
       * 其余人物照常推进——既不是整轮作废，也不是静默丢弃。
       */
      if(value.ok && Array.isArray(value.rejectedActors) && value.rejectedActors.length){
        return {
          ok:false,
          reason:'这些人物未通过：'+value.rejectedActors.map(r=>'「'+String(r.actorRef||'?')+'」'+String(r.reason||'')).join('；'),
          correction:{
            items:value.rejectedActors.map(r=>({label:'人物 '+String(r.actorRef||'?')+' 未通过',actual:String(r.reason||''),hint:'只重写这个人物这一条，其余人物保持原样'})),
            hint:'只需要修正上面列出的人物条目，其他人物的判定不用动。',
          },
        };
      }
      // 边界本身不合格 → 硬失败，走既有纠正重试。
      if(!value.ok)return {ok:false,reason:value.reason||'边界判断不合格',correction};
      // 进度漏项：基线在这里也是 ok:false 触发一次带缺失编号的重试，保持同样次数。
      // 区别只在于重试用尽后的收尾——基线判死，现在按未确认放行（见函数末尾）。
      if(value.eventProgressPending&&correction)return {ok:false,reason:String(value.eventProgressNote||'事件进度未确认'),correction};
      return {ok:true};
    },
    // 重试时已经进入格式整理，用 attempt 判断，不引用已删除的历史报错临时变量。
    onRetry:(attempt,max,reason,delay)=>{if(typeof options.onRetry==='function')options.onRetry({stage:attempt>1?'补演边界格式整理':'补演边界判定',attempt,max,reason,delay});}
  });
  // 重试只为补齐事件进度时，用尽后不判死：边界与人物分工已经成立，
  // 只是事件进度没落定，按「未确认」放行，由最终世界/进度阶段重新确认。
  // 原来的硬失败会让一条进度漏项把整条补演挡住。
  if(!run.ok && accepted && accepted.ok && (accepted.eventProgressPending||accepted.prebuiltUnavailable))return accepted;
  /* ★★ 2026-11-02 玩家定：「出现实质性影响原著核心结论结果的错误且重试次数耗尽后
   * 还没有解决才单独报告错误原因让玩家可以继续针对性重跑，而不该波及整个补演流程」
   *
   * 这里就是那句话的落点：
   *   重试用尽后，如果**还有人物正常通过**（accepted.ok 且有 actorDecisions），
   *   就不能整轮判死——那是「一个人错了，所有人跟着白跑」。
   *   放行，并把 rejectedActors 带上去，让面板明确显示谁没过、为什么、可单独重跑。
   *
   * 只有当一个人物都没通过时，才算整体性失败（上面 parseStoryBoundary 已处理）。
   */
  if(!run.ok && accepted && accepted.ok && Array.isArray(accepted.rejectedActors) && accepted.rejectedActors.length
     && Array.isArray(accepted.actorDecisions) && accepted.actorDecisions.length){
    return accepted;
  }
  return run.ok ? accepted : {ok:false,reason:run.reason};
}

/**
 * 把「这个人在存档里现在什么样」渲染成一段，给推演用。
 *
 * 这是**既定事实**，推演时不许推翻它。
 *
 * 性格（第 3 列）也在这里：用户 2026-10-21
 *   「快照npc的信息里是包含性格的……所以不管是边界判定还是npc视角正文的
 *     材料里应该都是能看到人物性格的，只要调取快照档案。」
 *
 * 而且性格不是常量：
 *   「人的性格不可能一成不变，完全按照原著的经历来走，性格一定会保持原著设定的
 *     性格，但是如果经历发生改变，环境发生改变，这个npc的性格也就应该要发生改变。」
 *
 * 所以这里给的是**当前**的性格（存档里那一列），不是原著初始设定。
 *
 * @param {object|null} info { cultivation, items, location, alive, status, identity, personality }
 * @returns {string}
 */
/**
 * 把世界背景渲染成一段话。
 *
 * 为什么单个 NPC 推演需要这个：
 *   同一个弟子，门派正被围攻、和宗门安稳，他「躲不掉什么」完全不同。
 *   只给年表和存档，模型只能凭年表硬推，推出来的人像活在自己的真空里。
 *
 * 拿不到的不写空行——空行模型会当「此处无事」，
 * 反而给了它一个错误的安心。
 */
/**
 * 他这会儿在不在场、隔了多久。
 *
 * onScene 传 null 表示「名单没给」——这时候要明说不知道，
 * 不能悄悄当成「不在场」。这两件事对推演的影响是反的。
 */
export function renderPresence(onScene, sinceText) {
  const lines = [];

  if (onScene === true) {
    lines.push('他在场。这轮的事就发生在他眼前，他躲不掉的是眼前这件事本身。');
  } else if (onScene === false) {
    lines.push('他不在场。这轮他没亲眼看见，躲不掉的是别处同时在发生的事——');
    lines.push('  消息会传到他耳朵里，或者他那边的事情照样在推进。');
  } else {
    lines.push('（这一层没给在场名单，不知道他当时在不在。别替他假设，也别写成他看见了。）');
  }

  const since = String(sinceText || '').trim();
  if (since) lines.push('', `时间上：${since}`);

  return lines.join('\n');
}

export function renderWorldContext(ctx, fallbackTime) {
  const w = ctx && typeof ctx === 'object' ? ctx : {};
  const time = String(w.time || fallbackTime || '').trim();
  const location = String(w.location || '').trim();
  const events = String(w.events || '').trim();
  const factors = String(w.factors || '').trim();

  const lines = [];
  if (time) lines.push(`现在：${time}${location ? `，玩家在${location}` : ''}`);
  else if (location) lines.push(`玩家在${location}`);
  if (factors) lines.push(``, `这个世界的规矩和势力：`, factors);
  if (events) lines.push(``, `最近世上出了这些事：`, events);

  if (lines.length === 0) {
    return '（这一层的存档里没有世界背景，只有年表和他自己的状态可用。不要把不知道的事当没有。）';
  }
  return lines.join('\n');
}

export function renderActorState(info) {
  const s = info && typeof info === 'object' ? info : {};
  const bits = [];
  const push = (label, value) => {
    const v = String(value == null ? '' : value).trim();
    if (v) bits.push(`${label}：${v}`);
  };

  push('修为', s.cultivation || s.修为);
  if(s.inventoryKnown===true)bits.push('储物袋：'+JSON.stringify(s.inventory || []));
  else if(s.inventoryKnown===false)bits.push('储物袋：未记录，不能视为空');
  if(s.equipmentKnown===true)bits.push('装备：'+JSON.stringify(s.equipment || {}));
  else if(s.equipmentKnown===false)bits.push('装备：未记录，不能视为空');
  if (Array.isArray(s.items)) {
    bits.push(`随身物品：${s.items.length > 0 ? s.items.join('、') : '无'}`);
  } else {
    push('随身物品', s.随身物品);
  }
  push('所在位置', s.location || s.所在位置);
  push('存在性', s.alive || s.存在性);
  push('身份', s.identity);
  push('当前状态', s.status || s.状态);
  push('关系', s.relation);
  // 以下几条是「他会怎么做」的依据，推演时必须看到
  push('对玩家态度', s.favor || s.好感度);
  push('性子', s.personality || s.性格);
  push('此刻在想', s.innerThought || s.内心想法);
  push('当前动机', s.motive || s.当前动机);
  push('战斗状态', s.combat || s.战斗状态);

  return bits.length > 0 ? bits.join('　｜　') : '（存档里没有这个人的状态记录）';
}

/**
 * 校验并规范化「人物终态」。
 *
 * 用户 2026-10-21 定的口径：
 *   压的是**这个人走到最后的终态**，不是事件摘要。
 *   所以只收四个维度，其余字段一律丢掉。
 *
 * 宽松：一个维度都没有也算失败（那说明它没在干活）；
 * 有维度但值不合法，只丢那一个维度，不作废整份——
 * 这个人还能拿去对勾，总比整轮失败好。
 *
 * @param {string} raw 模型原始输出
 * @returns {{ok:boolean, must:object|null, reason:string}}
 */
// 必成事实的五个维度（模型回的是中文维度名）
export const CE_MUST_DIMENSIONS = ['修为', '随身物品', '所在位置', '存在性', '身份'];

/**
 * 解析「必成事实」输出，转成内部统一的形状。
 *
 * 模型回：
 *   { "必成": [ { "维度": "修为", "变成": "炼气九层", "依据": "..." } ] }
 *
 * 内部转成：
 *   { 修为: "炼气九层", 依据: "..." }
 *
 * 为什么转：**减法那一步、对正文那一步全都不用改**。
 * 它们只关心「哪个维度变成什么」，不关心模型怎么组织的输出。
 *
 * 空数组是合法答案——这个人这轮没有非发生不可的事。
 *
 * @param {string} raw
 * @returns {{ok:boolean, musts:object|null, reason:string}}
 */
export function parseMusts(raw) {
  const parsed = parseJsonLoose(raw);
  // 空对象 {} 也认：等于「一条必成事实都没有」
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, musts: null, reason: "没有解析出 JSON 对象" };
  }

  if (Object.keys(parsed).length && !Array.isArray(parsed.必成)) {
    return {ok:false,musts:null,reason:'缺少必成数组；只有明确的空对象可表示无变化'};
  }
  const list = Array.isArray(parsed.必成) ? parsed.必成 : [];
  const out = {};
  const reasons = [];

  for (const item of list) {
    if (!item || typeof item !== "object") return {ok:false,musts:null,reason:'必成条目不是对象'};
    const dim = String(item.维度 == null ? "" : item.维度).trim();
    if (!CE_MUST_DIMENSIONS.includes(dim)) return {ok:false,musts:null,reason:'不支持的必成维度：'+dim};

    const to = item.变成;
    if (dim === "随身物品") {
      // 物品既可能给数组，也可能给一句话，都收
      if (Array.isArray(to)) {
        out.随身物品 = to.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
      } else {
        const t = String(to == null ? "" : to).trim();
        if (!t) return {ok:false,musts:null,reason:'随身物品缺少变成值'};
        out.随身物品 = t.split(/[、,，\/]/).map((x) => x.trim()).filter(Boolean);
      }
    } else {
      const t = String(to == null ? "" : to).trim();
      if (!t) return {ok:false,musts:null,reason:dim+'缺少变成值'};
      out[dim] = t;
    }

    const why = String(item.依据 == null ? "" : item.依据).trim();
    if (why) reasons.push(`${dim}：${why}`);
  }

  if (reasons.length > 0) out.依据 = reasons.join("；");

  // 一条都没有也算成功：这轮确实可能没有躲不掉的事
  return { ok: true, musts: out, reason: "" };
}

export function parseMustsLegacy(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, must: null, reason: '没有解析出 JSON 对象' };
  }

  const out = {};
  let filled = 0;

  // 修为：一段短文字
  const cultivation = String(parsed.修为 == null ? '' : parsed.修为).trim();
  if (cultivation) { out.修为 = cultivation; filled += 1; }

  // 随身物品：数组，空数组也算「明确没有」
  if (Array.isArray(parsed.随身物品)) {
    const items = parsed.随身物品
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean);
    out.随身物品 = items;
    filled += 1;
  }

  // 所在位置
  const location = String(parsed.所在位置 == null ? '' : parsed.所在位置).trim();
  if (location) { out.所在位置 = location; filled += 1; }

  // 存在性
  const alive = String(parsed.存在性 == null ? '' : parsed.存在性).trim();
  if (alive) { out.存在性 = alive; filled += 1; }

  // 依据：不参与判定，但诊断里有用
  const basis = String(parsed.依据 == null ? '' : parsed.依据).trim();
  if (basis) out.依据 = basis;

  if (filled === 0) {
    return { ok: false, must: null, reason: '四个维度全空，等于没给终态' };
  }

  return { ok: true, must: out, reason: '' };
}

/**
 * 把终态渲染成一行人话，给对勾那步看。
 *
 * @param {string} name
 * @param {object} must
 * @param {string} [statusTag]
 * @returns {string}
 */
export function renderMustLine(name, must, statusTag) {
  const n = String(name == null ? '' : name).trim();
  const tag = String(statusTag == null ? '' : statusTag).trim();
  const s = must && typeof must === 'object' ? must : {};

  const bits = [];
  if (s.修为) bits.push(`修为：${s.修为}`);
  if (Array.isArray(s.随身物品)) {
    bits.push(s.随身物品.length > 0
      ? `随身物品：${s.随身物品.join('、')}`
      : '随身物品：无');
  }
  if (s.所在位置) bits.push(`所在位置：${s.所在位置}`);
  if (s.存在性) bits.push(`存在性：${s.存在性}`);

  return `· ${n}${tag ? `（${tag}）` : ''}\n  ${bits.join('　｜　')}`;
}

/**
 * 校验并规范化「终态对正文」的判定结果。
 *
 * 判定对象是**人**，不是事件。每人三种状态之一，缺失的维度列进 missing。
 *
 * @param {string} raw
 * @param {string[]} expectedNames 名单，用来校验有没有漏人
 * @returns {{ok:boolean, results:Array, reason:string}}
 */
export function parseActorChecks(raw, expectedNames) {
  const parsed = parseJsonLoose(raw);
  const list = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  if (!list) {
    return { ok: false, results: [], reason: '没有解析出 results 数组' };
  }

  const valid = new Set(['到位', '被替代', '没到']);
  const names = (Array.isArray(expectedNames) ? expectedNames : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);
  const want = new Set(names);

  const results = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name == null ? '' : item.name).trim();
    const status = String(item.status == null ? '' : item.status).trim();
    if (!name || !valid.has(status)) continue;
    if (seen.has(name)) continue;
    // 名单外的名字不收：模型自己编的人不能进结果
    if (want.size > 0 && !want.has(name)) continue;

    seen.add(name);
    const missing = Array.isArray(item.missing)
      ? item.missing.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
      : [];

    results.push({
      name,
      status,
      missing: status === '到位' ? [] : missing,
      reason: String(item.reason == null ? '' : item.reason).trim(),
    });
  }

  if (want.size > 0) {
    const absent = names.filter((n) => !seen.has(n));
    if (absent.length > 0) {
      return {
        ok: false,
        results,
        reason: `判定漏了 ${absent.length} 人：${absent.slice(0, 5).join('、')}${absent.length > 5 ? '…' : ''}`,
      };
    }
  }

  return { ok: true, results, reason: '' };
}

/**
 * 推演终态 − 存档现状 = 这一轮**真正变了**的维度。
 *
 * 用户 2026-10-21 挠头的那个问题，靠这个函数兜死：
 *
 *   「本来就九层，原著这一轮写他又是应该在修炼，那按理层数会更高。
 *     但是另一方面说，如果他的目标就是九层，已经达到目标了也可能不修炼了」
 *
 * 两条都成立，原著也没写。既然原著没写，就不该拿模型的一句话去决定。
 * 所以这里加一道**跟模型无关的数学保险**：
 *
 *   推出来的终态「炼气九层」 == 存档现状「炼气九层」 → 差是空的 → 不补。
 *
 * 这样一来，「本来就有的东西被当成缺口去补」在代码上不可能发生，
 * 不管提示词写得多含糊、模型判得多离谱。
 *
 * 只比能比的：存档里没这个维度就比不了，保留（那是真缺口）。
 *
 * @param {object|null} must 推演出来的终态
 * @param {object|null} current 存档现状
 * @returns {object} 只含真正变化的维度
 */
export function subtractMusts(must, current) {
  const end = must && typeof must === 'object' ? must : {};
  const now = current && typeof current === 'object' ? current : {};
  const out = {};

  const norm = (v) => String(v == null ? '' : v).trim();

  // 修为：字面相同就是没变
  if (end.修为) {
    const before = norm(now.修为 || now.cultivation);
    if (before !== norm(end.修为)) out.修为 = end.修为;
  }

  // 随身物品：按集合比。给了又丢 / 丢了又得，都算变
  if (Array.isArray(end.随身物品)) {
    const endItems = end.随身物品.map(norm).filter(Boolean).sort();
    const rawNow = Array.isArray(now.随身物品) ? now.随身物品
      : Array.isArray(now.items) ? now.items : null;
    if (!rawNow) {
      // 存档没有物品栏：比不了。空数组不算缺口（「本来就没有」没什么可补的），
      // 有东西才保留。
      if (endItems.length > 0) out.随身物品 = end.随身物品;
    } else {
      const nowItems = rawNow.map(norm).filter(Boolean).sort();
      if (endItems.join('|') !== nowItems.join('|')) out.随身物品 = end.随身物品;
    }
  }

  // 所在位置：相同就是没动
  if (end.所在位置) {
    const before = norm(now.所在位置 || now.location);
    if (before !== norm(end.所在位置)) out.所在位置 = end.所在位置;
  }

  // 存在性：默认就是「在世」，说了在世等于没变
  if (end.存在性) {
    const before = norm(now.存在性 || now.alive);
    const after = norm(end.存在性);
    const isAlive = /在世|活着|存活|生还/.test(after);
    if (before) {
      if (before !== after) out.存在性 = end.存在性;
    } else if (!isAlive) {
      out.存在性 = end.存在性;
    }
  }

  // 依据原样留着，诊断时要看它是怎么推出来的
  if (end.依据) out.依据 = end.依据;

  return out;
}

/**
 * 把边界判定这一段梳理出来的东西，整理成**每人一份的档案**，交给散文阶段。
 *
 * 用户 2026-10-21 定的分工（这一条把蝴蝶效应的落点讲清楚了）：
 *
 *   「这种其实也属于蝴蝶效应，蝴蝶效应应该在npc视角正文解决。
 *     我们把在边界判定这里梳理的资料都整理给npc视角正文ai，
 *     由他根据逻辑推演，根据这个npc的性格，来写他可能会做的事情，
 *     而这里的事实，作为最终定案的本轮原著补演结果」
 *
 * 所以档案里要装三样，一样都不能少：
 *
 *   ① **原著推力原文** —— 这段时间本该发生什么（brief 原句，不是我们的转述）
 *   ② **必成事实** —— 按现在的局势躲不掉的是哪几件（下限，不是结论）
 *   ③ **被顶掉的推力** —— 哪几条原著事情没成，为什么
 *
 * ①③ 是给**性格**用的：他是这么个人，碰上这局面会怎么办。
 * ② 是给**下限**用的：这几件得让它发生，别的散文自己发挥。
 *
 * 少了 ①，散文只能编；少了 ③，散文会按原著硬演；
 * 少了 ②，该发生的事可能被写丢。
 *
 * ⚠️ ② 不是「最终结论」。用户 2026-10-21 纠过一次：
 *   「边界判定不是下最后的结论，只能说哪些事实按照现在的情况看一定会发生了，
 *     而不是最终一定是这样，终态是npc视角正文的事实，才是本轮最后的结果。」
 *
 * @param {object} input
 * @param {Array} input.actors collectActorBundles 的 actors
 * @param {object} [input.currentStates] name -> 存档现状
 * @param {object} [input.changedStates] name -> 真正变了的维度（必成事实）
 * @param {object} [input.musts] name -> 推演出的完整终态（含依据）
 * @param {string[]} [input.storyFacts] 正文带来的改变
 * @param {object} [input.checks] 终态对正文的判定结果
 * @param {object} [input.newcomers] name -> 新人档案（存档里没有的人）
 * @returns {object} name -> dossier
 */
export function buildActorDossiers(input) {
  const src = input && typeof input === 'object' ? input : {};
  const actors = Array.isArray(src.actors) ? src.actors : [];
  const currentStates = src.currentStates && typeof src.currentStates === 'object'
    ? src.currentStates : {};
  const changedStates = src.changedStates && typeof src.changedStates === 'object'
    ? src.changedStates : {};
  const musts = src.musts && typeof src.musts === 'object' ? src.musts : {};
  const storyFacts = Array.isArray(src.storyFacts) ? src.storyFacts : [];
  const checks = Array.isArray(src.checks) ? src.checks : [];
  const newcomers = src.newcomers && typeof src.newcomers === 'object' ? src.newcomers : {};

  const checkByName = {};
  for (const c of checks) {
    if (c && c.name) checkByName[c.name] = c;
  }

  const out = {};
  for (const bundle of actors) {
    const name = String(bundle && bundle.name || '').trim();
    if (!name) continue;

    const influence=(src.influences || []).find(row=>row.name===name) || null;
    const factRecords=(src.factRecords || []).filter(f=>influence && influence.factIds.includes(f.id));
    const events = Array.isArray(bundle.events) ? bundle.events.slice() : [];
    events.sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));

    const pushes = events.map((e, i) => ({
      index: i + 1,
      code: String(e.code || ''),
      time: String(e.time || ''),
      title: String(e.title || ''),
      // 用 brief 原句，不用我们改写过的转述——
      // 转述会丢掉「怎么发生的」，而那正是性格推演要的东西
      brief: String(e.brief || '').trim(),
      text: String(e.materialText || e.brief || '').trim(),
      source: String(e.primarySource || 'brief'),
      truncated: e.sourceTruncated === true,
    }));

    const settled = changedStates[name]
      ? Object.entries(changedStates[name])
        .filter(([k]) => k !== '依据')
        .map(([k, v]) => `${k}：${Array.isArray(v) ? (v.join('、') || '无') : v}`)
      : [];

    const check = checkByName[name] || null;
    const status = check ? String(check.status || '') : '';

    // 被顶掉的推力：正文自己写了别的样子（被替代）时，那几条就是没按原著走
    const blocked = status === '被替代'
      ? [{ reason: String(check.reason || '正文写成了别的样子') }]
      : [];

    out[name] = {
      name,
      statusTag: String(bundle.statusTag || ''),
      // ① 推力（给性格）
      pushes,
      pushCount: pushes.length,
      // ② 必成事实（给下限约束）
      //
      // 用户 2026-10-21 纠正过一次，这里必须说准：
      //   「边界判定不是下最后的结论，只能说哪些事实按照现在的情况看一定会发生了，
      //     而不是最终一定是这样，终态是npc视角正文的事实，才是本轮最后的结果。」
      //
      // 所以这是**下限**：这几件按现在的局势躲不掉，得让它们发生。
      // 但「他是个什么样的人、他接下来变成什么样、他还做了别的什么」——
      // 那是散文写的，散文写的才是本轮结果。
      //
      // 用「必成」而不是「定案」，就是为了不让人读成「照这个写就完事」。
      musts: settled,
      mustsRaw: changedStates[name] || null,
      must: musts[name] || null,
      basis: String((musts[name] && musts[name].依据) || ''),
      // ③ 顶掉（给推演）
      blocked,
      // 他自己现在什么样——推演的起点（含性格）
      stateNow: projectActorProfile(currentStates[name] || bundle.state || null),
      // 新人的原著设定：存档里没有这个人时，底子靠现查
      newcomer: newcomers[name] || null,
      biography: String(src.biographies && src.biographies[name] || '').trim(),
      // 正文这轮造成的改变，跟全局一致
      storyFacts: src.factsByActor && Object.prototype.hasOwnProperty.call(src.factsByActor,name) ? src.factsByActor[name] : storyFacts,
      storyFactRecords: factRecords,
      storyInfluence: influence,
      // 判定结论（到位/被替代/没到），散文要知道自己这轮是哪种活
      verdict: status,
      verdictReason: check ? String(check.reason || '') : '',
    };
  }
  return out;
}

/**
 * 把「人物判定结果」组装成差集。
 *
 * 用户 2026-10-21 定的语义（这一条推翻了「被替代也要补」）：
 *
 *   「正文已经覆盖或是影响改变的部分我们就不补，这才对。」
 *
 * 所以三种判定里，**只有「没到」进 missing**：
 *   covered  = 到位的人      → 正文写了，不补
 *   mutated  = 被替代的人    → 正文写了但结果不同，**也不补**（正文是事实，最大）
 *   missing  = 没到的人缺的维度 → 这才是要补的
 *
 * 注意「被替代」不等于「按原著补」。玩家造成的偏离已经在推演终态时算进去了，
 * 推演出来的就是偏离后的版本；正文如果没写，它是以「没到」的身份进 missing 的。
 * 走到这里仍是「被替代」，说明正文自己已经把事情写成了别的样子——
 * 那是玩家最新的创造，不能再拿任何版本盖回去。
 *
 * 每一条 missing 都带人名，散文阶段直接按人取，不用再猜归属。
 *
 * @param {Array} results parseActorChecks 的产物
 * @param {object} [musts] name -> must，用来补全 mutated 的 original
 * @returns {{covered:string[], mutated:Array, missing:string[], perActor:object, total:number}}
 */
export function buildDiffFromActorChecks(results, musts) {
  const list = Array.isArray(results) ? results : [];
  const states = musts && typeof musts === 'object' ? musts : {};

  const covered = [];
  const mutated = [];
  const missing = [];
  const perActor = {};

  for (const r of list) {
    if (!r || !r.name) continue;

    if (r.status === '到位') {
      covered.push(r.name);
      continue;
    }

    if (r.status === '被替代') {
      // 正文写了，但写成了别的样子。这是玩家造的既定事实，不补、不改。
      mutated.push({
        name: r.name,
        original: summarizeMusts(states[r.name]),
        actual: r.reason || '',
      });
      continue;
    }

    // 没到：正文完全没碰，这才是要补的
    const gaps = Array.isArray(r.missing) && r.missing.length > 0
      ? r.missing.slice()
      : // 模型只说了「没到」但没列缺口：把整个终态当成缺口
        Object.entries(states[r.name] || {})
          .filter(([k]) => k !== '依据')
          .map(([k, v]) => `${k}：${Array.isArray(v) ? (v.join('、') || '无') : v}`);
    if (gaps.length === 0) continue;

    perActor[r.name] = gaps;
    gaps.forEach((g) => missing.push(`${r.name}：${g}`));
  }

  return {
    covered,
    mutated,
    missing,
    perActor,
    total: covered.length + mutated.length + Object.keys(perActor).length,
  };
}

/** 把终态压成一句话，给 mutated.original 用 */
function summarizeMusts(state) {
  const s = state && typeof state === 'object' ? state : {};
  const bits = [];
  if (s.修为) bits.push(`修为 ${s.修为}`);
  if (Array.isArray(s.随身物品) && s.随身物品.length > 0) bits.push(`持 ${s.随身物品.join('、')}`);
  if (s.所在位置) bits.push(`在${s.所在位置}`);
  if (s.存在性) bits.push(s.存在性);
  return bits.join('；') || '（终态未明）';
}

/**
 * 要点压缩提示词（**默认值**；玩家可在面板里改）。
 * 实际使用时请走 resolvePrompt('boundaryPoints')。
 */
export const CE_COMPRESS_PROMPT = CE_PROMPT_REGISTRY.boundaryPoints.build({});

/**
 * 逐条对勾提示词（默认值）。
 */
export const CE_CHECK_PROMPT = CE_PROMPT_REGISTRY.boundaryCheck.build({});

/**
 * 一步式差集提示词（默认值）。
 */
export const CE_ONE_SHOT_PROMPT = CE_PROMPT_REGISTRY.boundaryOneShot.build({});

/** 宽松 JSON 解析：容忍 <think>、代码围栏、前后说明文字 */
export function parseJsonLoose(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* 继续 */ } }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

/**
 * 校验并规范化压缩出来的要点列表。
 *
 * @param {string} raw 模型原始输出
 * @returns {{ok:boolean, points:string[], reason:string}}
 */
export function parsePoints(raw) {
  const parsed = parseJsonLoose(raw);
  const list = parsed && Array.isArray(parsed.points) ? parsed.points : null;
  if (!list) {
    return { ok: false, points: [], reason: '没有解析出 points 数组' };
  }

  const points = list
    .map((p) => String(p == null ? '' : p).trim())
    .filter((p) => p.length > 0);

  if (points.length === 0) {
    return { ok: false, points: [], reason: 'points 为空' };
  }
  if (points.length > CE_MAX_POINTS) {
    // 条数过多说明没压缩好，让调用方走兜底
    return { ok: false, points: points.slice(0, CE_MAX_POINTS), reason: `要点过多（${points.length}）` };
  }

  return { ok: true, points, reason: '' };
}

/**
 * 校验并规范化逐条判定结果。
 *
 * @deprecated 旧口径（按事件打勾）。新流程用 parseActorChecks（按人判终态）。
 *             保留是因为旧测试与一步式兜底还在用。
 *
 * @param {string} raw 模型原始输出
 * @param {number} expectedCount 应当覆盖的要点数
 * @returns {{ok:boolean, results:Array, reason:string}}
 */
export function parseCheckResults(raw, expectedCount) {
  const parsed = parseJsonLoose(raw);
  const list = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  if (!list) {
    return { ok: false, results: [], reason: '没有解析出 results 数组' };
  }

  const validStatus = new Set(Object.values(CE_POINT_STATUS));
  const results = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const index = Number(item.index);
    const status = String(item.status == null ? '' : item.status).trim();
    if (!Number.isFinite(index) || index < 1) continue;
    if (!validStatus.has(status)) continue;
    if (seen.has(index)) continue;

    seen.add(index);
    results.push({
      index,
      status,
      actual: String(item.actual == null ? '' : item.actual).trim(),
    });
  }

  const expected = Number(expectedCount) > 0 ? Number(expectedCount) : 0;
  if (expected > 0 && results.length !== expected) {
    return {
      ok: false,
      results,
      reason: `判定条数不符：应 ${expected} 条，实 ${results.length} 条`,
    };
  }

  // 「被替代」必须给出实际改写内容
  const mutatedWithoutActual = results.filter(
    (r) => r.status === CE_POINT_STATUS.mutated && !r.actual,
  );
  if (mutatedWithoutActual.length > 0) {
    return {
      ok: false,
      results,
      reason: '「被替代」缺少实际改写内容',
    };
  }

  return { ok: true, results, reason: '' };
}

/**
 * 把「要点 + 逐条判定」组装成差集结果。
 *
 * @param {string[]} points
 * @param {Array<{index:number,status:string,actual:string}>} results
 * @returns {{
 *   covered:string[], mutated:Array<{original:string,actual:string}>,
 *   missing:string[], total:number
 * }}
 */
export function buildDiffFromPoints(points, results) {
  const list = Array.isArray(points) ? points : [];
  const byIndex = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    byIndex.set(Number(r.index), r);
  }

  const covered = [];
  const mutated = [];
  const missing = [];

  list.forEach((point, i) => {
    const r = byIndex.get(i + 1);
    if (!r) {
      // 没有判定结果的要点，宁可当未覆盖（宁可补，不可漏）
      missing.push(point);
      return;
    }
    if (r.status === CE_POINT_STATUS.covered) covered.push(point);
    else if (r.status === CE_POINT_STATUS.mutated) {
      mutated.push({ original: point, actual: r.actual || '' });
    } else missing.push(point);
  });

  return { covered, mutated, missing, total: list.length };
}

/**
 * 把一步式输出规范成同样的差集结构。
 *
 * @param {string} raw
 * @returns {{ok:boolean, diff:object|null, reason:string}}
 */
export function parseOneShotDiff(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, diff: null, reason: '没有解析出 JSON' };
  }

  const covered = Array.isArray(parsed.covered)
    ? parsed.covered.map((s) => String(s == null ? '' : s).trim()).filter(Boolean)
    : [];
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.map((s) => String(s == null ? '' : s).trim()).filter(Boolean)
    : [];
  const mutated = Array.isArray(parsed.mutated)
    ? parsed.mutated
      .map((m) => ({
        original: String(m && m.original == null ? '' : m.original).trim(),
        actual: String(m && m.actual == null ? '' : m.actual).trim(),
      }))
      .filter((m) => m.original)
    : [];

  if (covered.length === 0 && missing.length === 0 && mutated.length === 0) {
    return { ok: false, diff: null, reason: '三个分类全为空' };
  }

  return {
    ok: true,
    diff: {
      covered,
      mutated,
      missing,
      total: covered.length + mutated.length + missing.length,
    },
    reason: '',
  };
}

/**
 * 判断差集结果是否「有东西要补」。
 *
 * 这是整套系统唯一的分支：差集为空 → 跳过；非空 → 补。
 *
 * @param {object|null} diff
 * @returns {boolean}
 */
// 三档：同一个差集运算的三种结果，不是三条流程。
//
//   一档 玩家完全没参与   → 差集 = 全集 → 全部补
//   二档 玩家完整体验     → 差集 = 空   → 跳过，不补
//   三档 玩家部分参与     → 差集 = 一部分 → 补剩下的，并把已覆盖的当背景
//
// 代码里仍然只有一个分支（差集空不空），但把档位**显式说出来**，
// 因为三档那个额外动作不能省：不告诉散文「哪些已经写过了」，
// 它会把同一件事再写一遍。
export const CE_TIER = {
  all: '一档',   // 全集待补
  none: '二档',  // 什么都不用补
  some: '三档',  // 补一部分
};

/**
 * 判断这一轮属于哪一档。
 *
 * 二档为什么能跳过：边界判定跑在**普通重点演化之后**。
 * 玩家和董萱儿一起闯机关、杀妖兽，那些早就在普通演化里落地成她的状态了。
 * 边界判定拿到的是一个**已经演化过一轮的存档**，补的是还没演化到的部分。
 * 差集为空 = 该演的都已经演了 = 没有缺口。
 *
 * @param {object|null} diff
 * @returns {string} CE_TIER 里的值
 */
export function tierOf(diff) {
  if (!diff || typeof diff !== "object") return CE_TIER.none;
  const missing = Array.isArray(diff.missing) ? diff.missing.length : 0;
  if (missing === 0) return CE_TIER.none;

  // 全集还是部分：看有没有人被判定成「到位」或「被替代」。
  // 有 = 玩家参与了 = 三档；没有 = 一个都没接住 = 一档。
  const per = diff.perActor && typeof diff.perActor === "object" ? diff.perActor : {};
  const touched = Object.values(per).some((a) => {
    const list = a && Array.isArray(a.items) ? a.items : [];
    return list.some((it) => it && (it.status === "到位" || it.status === "被替代"));
  });

  return touched ? CE_TIER.some : CE_TIER.all;
}

export function needsSupplement(diff) {
  return tierOf(diff) !== CE_TIER.none;
}

/**
 * 第三档专用：把「正文已经写过的部分」整理成背景，防写重。
 *
 * 不告诉散文哪些已经写过，它会把同一件事再写一遍——
 * 而且它不知道那件事已经发生，还会当成「还没发生」去推。
 *
 * 一档没有这个（本来什么都没写）；二档整轮跳过，也不会走到这里。
 *
 * @param {object|null} diff
 * @returns {string[]}
 */
export function coveredForProse(diff) {
  if (tierOf(diff) !== CE_TIER.some) return [];
  const per = diff && diff.perActor && typeof diff.perActor === "object"
    ? diff.perActor : {};

  const out = [];
  for (const [name, a] of Object.entries(per)) {
    const list = a && Array.isArray(a.items) ? a.items : [];
    for (const it of list) {
      if (!it || !it.dimension) continue;
      const who = name ? `${name}·` : "";
      if (it.status === "到位") {
        out.push(`${who}${it.dimension}（正文已写到${it.actual ? `：${it.actual}` : ""}）`);
      } else if (it.status === "被替代") {
        out.push(`${who}${it.dimension}（正文自己写成了另一版，以正文为准）`);
      }
    }
  }
  return out;
}

/**
 * 把差集渲染成给散文写作者的「要补什么」清单。
 *
 * 注意：这里给的原文是**年表里的表述**，不是我们新造的事实表。
 *
 * @param {object|null} diff
 * @returns {string}
 */
export function formatMissingForProse(diff) {
  if (!needsSupplement(diff)) return '';

  const lines = [
    '## 本轮需要补的原著内容',
    '- 下面这些是年表里本该发生、但正文没有写到的部分。',
    '- 补的是这些事**发生了**，不是复述年表原句。',
    '',
  ];

  diff.missing.forEach((item, i) => {
    lines.push(`${i + 1}. ${item}`);
  });

  if (Array.isArray(diff.mutated) && diff.mutated.length > 0) {
    lines.push('');
    lines.push('## 已被正文替代的部分（不要按原样补）');
    diff.mutated.forEach((m) => {
      lines.push(`- 本该：${m.original}`);
      lines.push(`  实际：${m.actual}`);
    });
  }

  return lines.join('\n');
}

// ============================================================
// 边界判定：编排两种做法，第二种优先、第一种兜底
// ============================================================

/** 边界判定策略 */
export const CE_BOUNDARY_STRATEGY = {
  /** 先压要点再逐条对勾（优先） */
  points: 'points',
  /** 年表 + 正文 一步做差集（兜底） */
  oneShot: 'one_shot',
};

/**
 * @deprecated 没有调用方，**不要用**。
 *
 * 这是早先的另一种判法（先压要点 / 一次性判 / 再分批合并），
 * 现在整条链走的是 evaluateBoundaryByActor（按人判），
 * 生产代码里这几个人一个引用都没有，只有测试还在喂它们。
 *
 * 留着是因为删它们要连带改四个测试文件，一次手抖就会
 * 把主链一起删掉——那比留着风险大。
 *
 * 但它们**不再是活代码**：新增功能一律不要往这儿加，
 * 看到它被调用，就说明有人走错门了。
 */
/**
 * 方法二：先压要点，再逐条对勾。
 *
 * @param {object} input
 * @param {string} input.entryMaterial 年表材料（原文或条目）
 * @param {string} input.storyText 本轮正文
 * @param {object} input.host CEHost 端口（需要 llmCall）
 * @param {object} [input.options]
 * @returns {Promise<{ok:boolean, diff:object|null, strategy:string, reason:string, points?:string[]}>}
 */
export async function boundaryByPoints(input) {
  const host = input && input.host;
  const material = String(input && input.entryMaterial || '').trim();
  const storyText = String(input && input.storyText || '').trim();
  const options = (input && input.options) || {};
  const overrides = options.promptOverrides || null;

  if (!host || typeof host.llmCall !== 'function') {
    return { ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.points, reason: '缺少 llmCall' };
  }
  if (!material) {
    return { ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.points, reason: '缺少年表材料' };
  }

  // 第一步：把年表压成几条「该发生的事」
  let points;
  {
    const r = await withRetry(
      ({correct}) => host.llmCall(correct({
        messages: [{
          role: 'user',
          content: fillTemplate(promptText('boundaryPoints', overrides), {
            '{{年表材料}}': material,
          }),
        }],
        json: true,
      })),
      {
        config: options.retry,
        signal: options.signal,
      retryDelayMs: options.retryDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
        retryDelayMs: options.retryDelayMs,
        maxDelayMs: options.retryMaxDelayMs,
        validate: (text) => {
          const p = parsePoints(text);
          return { ok: p.ok, reason: p.reason };
        },
        onRetry: (attempt, max, reason, delay) => {
          if (typeof options.onRetry === 'function') {
            options.onRetry({ stage: '要点压缩', attempt, max, reason, delay });
          }
        },
      },
    );
    if (!r.ok) {
      return {
        ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.points,
        reason: `要点压缩失败：${r.reason}`,
      };
    }
    points = parsePoints(r.value).points;
  }

  // 正文为空：全部要点都算未覆盖（这一段确实什么都没写）
  if (!storyText) {
    return {
      ok: true,
      strategy: CE_BOUNDARY_STRATEGY.points,
      points,
      diff: buildDiffFromPoints(points, []),
      reason: '正文为空，全部要点记为未覆盖',
    };
  }

  // 第二步：逐条对勾
  {
    const pointLines = points.map((p, i) => `${i + 1}. ${p}`).join('\n');
    const r = await withRetry(
      ({correct}) => host.llmCall(correct({
        messages: [{
          role: 'user',
          content: fillTemplate(promptText('boundaryCheck', overrides), {
            '{{必成事实}}': pointLines,
            '{{本轮正文}}': storyText,
          }),
        }],
        json: true,
      })),
      {
        config: options.retry,
        signal: options.signal,
      retryDelayMs: options.retryDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
        retryDelayMs: options.retryDelayMs,
        maxDelayMs: options.retryMaxDelayMs,
        validate: (text) => {
          const c = parseCheckResults(text, points.length);
          return { ok: c.ok, reason: c.reason };
        },
        onRetry: (attempt, max, reason, delay) => {
          if (typeof options.onRetry === 'function') {
            options.onRetry({ stage: '逐条对勾', attempt, max, reason, delay });
          }
        },
      },
    );

    if (!r.ok) {
      return {
        ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.points,
        points,
        reason: `逐条判定失败：${r.reason}`,
      };
    }

    const checked = parseCheckResults(r.value, points.length);
    return {
      ok: true,
      strategy: CE_BOUNDARY_STRATEGY.points,
      points,
      diff: buildDiffFromPoints(points, checked.results),
      reason: '',
    };
  }
}

/**
 * @deprecated 没有调用方，**不要用**。
 *
 * 这是早先的另一种判法（先压要点 / 一次性判 / 再分批合并），
 * 现在整条链走的是 evaluateBoundaryByActor（按人判），
 * 生产代码里这几个人一个引用都没有，只有测试还在喂它们。
 *
 * 留着是因为删它们要连带改四个测试文件，一次手抖就会
 * 把主链一起删掉——那比留着风险大。
 *
 * 但它们**不再是活代码**：新增功能一律不要往这儿加，
 * 看到它被调用，就说明有人走错门了。
 */
/**
 * 方法一：一步做差集（兜底）。
 *
 * @param {object} input
 * @param {string} input.entryMaterial
 * @param {string} input.storyText
 * @param {object} input.host
 * @returns {Promise<{ok:boolean, diff:object|null, strategy:string, reason:string}>}
 */
export async function boundaryOneShot(input) {
  const host = input && input.host;
  const material = String(input && input.entryMaterial || '').trim();
  const storyText = String(input && input.storyText || '').trim();
  const options = (input && input.options) || {};
  const overrides = options.promptOverrides || null;

  if (!host || typeof host.llmCall !== 'function') {
    return { ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.oneShot, reason: '缺少 llmCall' };
  }
  if (!material) {
    return { ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.oneShot, reason: '缺少年表材料' };
  }

  const r = await withRetry(
    ({correct}) => host.llmCall(correct({
      messages: [{
        role: 'user',
        content: fillTemplate(promptText('boundaryOneShot', overrides), {
          '{{年表材料}}': material,
          '{{本轮正文}}': storyText || '（本轮没有正文）',
        }),
      }],
      json: true,
    })),
    {
      config: options.retry,
      retryDelayMs: options.retryDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
      validate: (text) => {
        const p = parseOneShotDiff(text);
        return { ok: p.ok, reason: p.reason };
      },
      onRetry: (attempt, max, reason, delay) => {
        if (typeof options.onRetry === 'function') {
          options.onRetry({ stage: '一步式差集', attempt, max, reason, delay });
        }
      },
    },
  );

  if (!r.ok) {
    return {
      ok: false, diff: null, strategy: CE_BOUNDARY_STRATEGY.oneShot,
      reason: `一步式失败：${r.reason}`,
    };
  }

  const parsed = parseOneShotDiff(r.value);
  return {
    ok: true, diff: parsed.diff, strategy: CE_BOUNDARY_STRATEGY.oneShot, reason: '',
  };
}

/** 单批材料的字数上限。超过就切开分批判定。 */
export const CE_BOUNDARY_BATCH_CHARS = 12000;

/** 最多切几批。再多说明这一轮跨度不合理，宁可让玩家知道。 */
export const CE_BOUNDARY_MAX_BATCHES = 12;

/**
 * 把材料按「——分隔线」切成若干块，再按字数上限分包。
 *
 * 材料本身就是一条条事件拼起来的，分隔线是 `\n\n—\n\n`。
 * 先按事件切，再装箱到不超上限的批次——不能从中间硬切，
 * 那会把一条事件切成两半，两批都读不懂。
 *
 * @param {string} material
 * @param {number} [maxChars]
 * @returns {string[]} 每批的材料
 */
export function splitMaterialIntoBatches(material, maxChars) {
  const text = String(material == null ? '' : material).trim();
  if (!text) return [];
  const limit = Number(maxChars) > 0 ? Number(maxChars) : CE_BOUNDARY_BATCH_CHARS;

  // 单批就够，不切
  if (text.length <= limit) return [text];

  const blocks = text.split(/\n\n—\n\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    // 只有一整块且超长：只能硬切（保底，说明材料本身有问题）
    const out = [];
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
    return out.slice(0, CE_BOUNDARY_MAX_BATCHES);
  }

  const batches = [];
  let current = [];
  let currentLen = 0;
  const joiner = '\n\n—\n\n';

  for (const block of blocks) {
    // 单块就超限：自己成一批（不再细分，硬切会把事件切断）
    if (block.length > limit) {
      if (current.length > 0) {
        batches.push(current.join(joiner));
        current = [];
        currentLen = 0;
      }
      batches.push(block);
      continue;
    }

    const addLen = currentLen === 0 ? block.length : block.length + joiner.length;
    if (currentLen + addLen > limit && current.length > 0) {
      batches.push(current.join(joiner));
      current = [block];
      currentLen = block.length;
    } else {
      current.push(block);
      currentLen += addLen;
    }
  }
  if (current.length > 0) batches.push(current.join(joiner));

  return batches.slice(0, CE_BOUNDARY_MAX_BATCHES);
}

/** 把多批的差集合并成一份 */
function mergeDiffs(diffs) {
  const covered = [];
  const mutated = [];
  const missing = [];
  const seenC = new Set();
  const seenM = new Set();
  const seenX = new Set();

  for (const d of (Array.isArray(diffs) ? diffs : [])) {
    if (!d) continue;
    for (const x of (Array.isArray(d.covered) ? d.covered : [])) {
      const k = String(x).trim();
      if (k && !seenC.has(k)) { seenC.add(k); covered.push(x); }
    }
    for (const m of (Array.isArray(d.mutated) ? d.mutated : [])) {
      const k = `${m && m.original}||${m && m.actual}`;
      if (!seenM.has(k)) { seenM.add(k); mutated.push(m); }
    }
    for (const x of (Array.isArray(d.missing) ? d.missing : [])) {
      const k = String(x).trim();
      if (k && !seenX.has(k)) { seenX.add(k); missing.push(x); }
    }
  }

  return {
    covered,
    mutated,
    missing,
    total: covered.length + mutated.length + missing.length,
  };
}

/**
 * @deprecated 没有调用方，**不要用**。
 *
 * 这是早先的另一种判法（先压要点 / 一次性判 / 再分批合并），
 * 现在整条链走的是 evaluateBoundaryByActor（按人判），
 * 生产代码里这几个人一个引用都没有，只有测试还在喂它们。
 *
 * 留着是因为删它们要连带改四个测试文件，一次手抖就会
 * 把主链一起删掉——那比留着风险大。
 *
 * 但它们**不再是活代码**：新增功能一律不要往这儿加，
 * 看到它被调用，就说明有人走错门了。
 */
/**
 * 边界判定主入口（按人）：**正文事实 → 推演终态 → 对正文 → 出差集**。
 *
 * ------------------------------------------------------------
 * 这一版把「终态」的来源换了（用户 2026-10-21 定）：
 *
 *   **不是**「原著说他该是什么样」，
 *   **是**「存档现状 + 原著推力 + 正文改写」三者叠加之后，他实际是什么样」。
 *
 *   用户原话：
 *     「不能为原著剧情为单一标准。因为可能之前某件事情带来的影响已经让原著
 *       剧情产生偏差了，我们必须认为当前这个时间点原著npc的初始快照，
 *       这是当下的既定事实，不能反过去以原著剧情结果推翻。」
 *     「正文真正的作用是成为第二个推进因子」
 *
 *   所以推演出来的终态，**起点是存档，不是原著**。
 *   原著只是「往哪个方向推」，能不能推得动看前提还在不在。
 *
 * ------------------------------------------------------------
 * 然后拿这个终态去问正文：**这件事写出来了没**。
 *   到位   → 写了，不补
 *   被替代 → 写了但结果不同，也不补（正文是玩家造的事实，最大）
 *   没到   → 完全没碰，这才补
 *
 *   用户原话：「正文已经覆盖或是影响改变的部分我们就不补，这才对。」
 *
 * ------------------------------------------------------------
 * 顺带产出「经历流水」：年表里写到的事，无条件记进生平。
 * 那部分不用模型，纯代码拼。
 *
 * ------------------------------------------------------------
 * 调用次数（实测闭关百年）：
 *   正文硬事实：1 次（正文很短）
 *   推演终态：  按人，约 9 批
 *   对勾：      1 次（终态表本身很短）
 *   经历：      0 次（纯代码）
 *
 * @param {object} input
 * @param {object} input.host
 * @param {Array} input.actors collectActorBundles 的 actors
 * @param {string} input.storyText
 * @param {Function} [input.resolveActorState] (name, bundle) => 存档里的现状
 * @param {object} [input.newcomers] name -> 新人档案（存档里没有的人，现查出来的）
 * @param {object} [input.options]
 * @returns {Promise<object>}
 */
// Same source and exact text may be shared. Each person's event heading and
// ownership remain in their packet, as do revisions with different wording.
function shareBoundaryEventPassages(group) {
  const sources = new Map();
  for (const row of group) {
    for (const event of row.events) {
      const text = String(event.materialText || event.brief || '').trim();
      if (!event.code || text.length < 160) continue;
      const key = JSON.stringify([event.code, text]);
      const passage = '\n   ' + text;
      const index = row.content.indexOf(passage);
      if (index < 0 || !/^\n|^$/.test(row.content.slice(index + passage.length))) continue;
      if (!sources.has(key)) sources.set(key, {code:event.code, text, passage, rows:new Set()});
      sources.get(key).rows.add(row);
    }
  }
  const shared = [];
  const contents = new Map(group.map(row => [row, row.content]));
  for (const source of sources.values()) {
    if (source.rows.size < 2) continue;
    const ref = '年表原文 ' + (shared.length + 1) + ' · ' + source.code;
    shared.push('【' + ref + '】\n' + source.text);
    for (const row of source.rows) contents.set(row, contents.get(row).replace(source.passage, '\n   见【' + ref + '】'));
  }
  return {
    shared:shared.length ? '\n【同批共享原著原文，只按本人引用读取】\n' + shared.join('\n\n') : '',
    actors:group.map(row => '【独立人物：' + row.name + '】\n' + contents.get(row)).join('\n\n'),
  };
}

export async function evaluateBoundaryByActor(input) {
  const src = input && typeof input === 'object' ? input : {};
  const host = src.host;
  const options = src.options || {};
  const overrides = options.promptOverrides || null;
  const actors = Array.isArray(src.actors) ? src.actors : [];
  const storyText = String(src.storyText || '').trim();

  if (!host || typeof host.llmCall !== 'function') {
    return { ok: false, diff: null, strategy: 'actor', reason: '缺少 llmCall' };
  }
  if (actors.length === 0 && !(src.hooks && src.hooks.length) && !src.storyAnalysis) {
    return {
      ok: true,
      diff: { covered: [], mutated: [], missing: [], perActor: {}, total: 0 },
      strategy: 'actor',
      musts: {},
      reason: '这一轮没有需要跟踪的人物',
    };
  }

  // ---------- 第零步：从正文里捞硬事实（1 次） ----------
  //
  // 用户 2026-10-21：
  //   「正文真正的作用是成为第二个推进因子，原著是这段时间本该发生什么，
  //     正文带来的影响是一些本该发生的事情被其他事情替代或者影响导致偏离
  //     或者影响导致直接失败」
  //
  // 所以看正文不是在核对「哪条写了」，而是捞出**力的作用点**：
  // 谁死了、什么没了、关系断了。后面推演终态就靠它去撞原著。
  //
  // 复用已完成的边界AI结果；失败必须中断，不能按没有正文改变继续。
  const report = (stage) => (attempt, max, reason, delay) => {
    if (typeof options.onRetry === 'function') {
      options.onRetry({ stage, attempt, max, reason, delay });
    }
  };

  const dossierActors=[...new Map([...(src.storyActors || []),...actors].map(actor=>[actor.name,actor])).values()];
  const analysis = src.storyAnalysis || await analyzeStoryBoundary({
    host, storyText, actors:actors.map(bundle=>({...bundle,material:src.renderActorMaterial ? src.renderActorMaterial(bundle) : bundle.material,
      state:typeof src.resolveActorState==='function' ? src.resolveActorState(bundle.name,bundle) : null})),
    people:src.storyPeople || actors, hooks:src.hooks || [], options
  });
  if(!analysis.ok)return {ok:false,diff:null,strategy:'actor',reason:'正文边界AI判定失败：'+analysis.reason};
  const storyFacts=analysis.facts || [],factRecords=analysis.factRecords || [],resolvedHooks=analysis.resolvedHooks || [];
  const factsReason='';
  if (!actors.length) return {ok:true,diff:{covered:[],mutated:[],missing:[],perActor:{},total:0},strategy:'actor',musts:{},storyFacts,resolvedHooks,dossiers:buildActorDossiers({actors:dossierActors,factRecords,influences:analysis.influences})};

  // ---------- 第一步：逐人推演终态（可分批） ----------
  //
  // 三样材料一起给：
  //   ① 他现在什么样（存档，既定事实，不许推翻）
  //   ② 原著本该发生什么（推力）
  //   ③ 正文改变了什么（第二个推力）
  const musts = {};
  const factsByActor = {};
  const stateFailures = [];
  const pendingActors=[];
  const mergedActorChecks=[];
  const notifiedActors=new Set();
  function notifyActor(name,checks){
    if(typeof options.onActorReady!=='function' || notifiedActors.has(name) || options.signal?.aborted)return;
    const bundle=actors.find(actor=>actor.name===name),current=typeof src.resolveActorState==='function'?src.resolveActorState(name,bundle):null;
    const changed=subtractMusts(musts[name],current),hasChanges=Object.keys(changed).some(key=>key!=='依据');
    const ownMusts={[name]:musts[name]},ownStates={[name]:current},ownChanged=hasChanges?{[name]:changed}:{};
    const ownChecks=(checks || []).filter(row=>row.name===name);
    const diff=hasChanges?buildDiffFromActorChecks(ownChecks,ownChanged):{covered:[],mutated:[],missing:[],perActor:{},total:0};
    const dossiers=buildActorDossiers({actors:[bundle],currentStates:ownStates,changedStates:ownChanged,musts:ownMusts,storyFacts,factsByActor:{[name]:factsByActor[name] || []},factRecords,influences:analysis.influences,checks:ownChecks,newcomers:src.newcomers || {},biographies:src.biographies || {}});
    notifiedActors.add(name);options.onActorReady({name,ok:true,diff,musts:ownMusts,dossiers,storyFacts,resolvedHooks});
  }

  for (const bundle of actors) {
    const name = String(bundle && bundle.name || '').trim();
    if (!name) continue;

    const material = src.renderActorMaterial
      ? src.renderActorMaterial(bundle)
      : String(bundle.material || '').trim();
    if (!material) {
      stateFailures.push(`${name}：没有材料`);
      continue;
    }

    const stateNow = typeof src.resolveActorState === 'function'
      ? src.resolveActorState(name, bundle)
      : null;
    const influence=(analysis.influences || []).find(row=>row.name===name);
    const actorFacts=influence ? factRecords.filter(f=>influence.factIds.includes(f.id)) : [];
    factsByActor[name]=actorFacts.map(f=>f.text);
    const factsText=actorFacts.length ? actorFacts.map(f=>'主体：'+f.subject+'；'+f.text+'；正文原句：'+f.evidence).join('\n')
      +'\n边界AI判定的联系：'+influence.reason+'\n联系依据：'+influence.basis : '（边界AI未判定有影响此人的正文变化）';

    // 新人：存档里没有，用现查出来的设定补上前提。
    // 用户 2026-10-21：
    //   「很多时候都是新建原著npc，当前信息是零，那么初始信息我们怎么找呢？
    //     尤其是性格设定这些，就需要从向量库调取信息」
    //
    // 注意：新人档案是**原著设定**（他从哪儿出发），不是「现在什么样」。
    // 现在什么样仍然要按存档算——新人存档是零，那就只能写「不知道」。
    const newcomer = src.newcomers && src.newcomers[name] ? src.newcomers[name] : null;

    const content = fillTemplate(promptText('boundaryPoints', overrides), {
      '{{人物现状}}': stateNow
        ? renderActorState(stateNow)
        : (newcomer
          ? '（这个是新人，存档里还没有他的记录，所以不知道他现在什么样。'
            + '只能按原著设定和这段时间的事来推。）'
          : renderActorState(null)),
      '{{人物材料}}': newcomer && newcomer.fromSetting
        // 有设定集资料就一起给，性格才推得动
        ? `${material}\n\n【原著对他的设定】\n${newcomer.fromSetting}`
        : material,
      '{{正文事实}}': factsText,
      '{{世界背景}}': actors.length>1||options.batchBoundary?'（见本批共用背景，不重复逐人粘贴）':[renderWorldContext(src.worldContext),src.background].filter(Boolean).join('\n\n'),
      '{{他这会儿}}': renderPresence(
        typeof src.isOnSceneNow === 'function' ? src.isOnSceneNow(name) : null,
        typeof src.sinceLastTurn === 'function' ? src.sinceLastTurn() : '',
      ),
      '{{他的过往}}': (() => {
        const b = src.biographies && src.biographies[name];
        if (b) return b;
        // 新人已经拿设定集顶上了，这里说清楚免得模型以为查漏了
        return newcomer && newcomer.fromSetting
          ? '（上面【原著对他的设定】就是他现有的全部记载。）'
          : '（设定集里没查到这个人。只按年表里他做过的事推，不要给他编出身和师承。）';
      })(),
    }) + '\n\n【当前推演对象】'+name+'。正文事实中的物品、身份和亲属关系只属于标明的主体；第三方变化只能作为有材料证明的间接影响，禁止挪成此人自己的物品消耗或身份变化。';

    pendingActors.push({name,content,events:bundle.events || []});
  }

  if(pendingActors.length===1 && !options.batchBoundary){
    const {name,content}=pendingActors[0];
    const r = await withRetry(
      ({correct}) => host.llmCall(correct({stage:'人物终态推演',subject:name, messages: [{ role: 'user', content }], json: true })),
      {
        config: options.retry,
        signal: options.signal,
        retryDelayMs: options.retryDelayMs,
        maxDelayMs: options.retryMaxDelayMs,
        validate: (text) => {
          const p = parseMusts(text);
          return {ok:p.ok,reason:p.reason};
        },
        onRetry: report(`推演终态·${name}`),
      },
    );

    if (!r.ok) {
      stateFailures.push(`${name}：${r.reason}`);
      return {ok:false,diff:null,strategy:'actor',reason:name+'：'+r.reason,failedActors:stateFailures};
    }

    const parsed = parseMusts(r.value);
    // 全空不算失败：这个人这一轮确实可能什么状态都没变
    if (parsed.ok) musts[name] = parsed.musts;
    else stateFailures.push(name+'：'+parsed.reason);
  } else {
    const worldBackground=[renderWorldContext(src.worldContext),src.background].filter(Boolean).join('\n\n');
    const groups=packRequestMaterials(pendingActors,{...options.batchLimits,retryStage:'人物边界批量判定',measure:row=>row.content.length,estimateOutput:()=>1200,sharedChars:storyText.length+worldBackground.length+560}).flatMap(group=>group.some(row=>(options.replayScopes||[]).includes('人物边界批量判定:'+row.name))?group.map(row=>[row]):[group]);
    await Promise.all(groups.map(async group=>{
      const names=group.map(row=>row.name);
      const evidence=shareBoundaryEventPassages(group);
      const content='【全批共同正文】\n'+storyText+'\n【全批共同世界背景与存档材料】\n'+worldBackground+evidence.shared+'\n\n'+evidence.actors
        +'\n【本批统一输出协议，优先于各人物模板的单人格式】\n一次完成每人的必成推演和正文覆盖核对。先推必成，再排除与其已有状态相同的维度，核对本轮正文是否已经覆盖或改写；正文实际涉及者仍推其未覆盖经历；当前交汇是已发生约束，不代表整个人本轮无需补演。保持每人独立，不把他人动作/资源挪到此人。只输出JSON：{"results":[{"name":"逐字名单姓名","必成":[{"维度":"修为/随身物品/所在位置/存在性/身份","变成":"对应值","依据":"材料依据"}],"status":"到位/被替代/没到","missing":["尚未被正文覆盖的本人物事实"],"reason":"具体核对理由"}]}。没有必成返回空数组。每人恰好一条，禁止漏人、重复或添加其他人。';
      const parseBatch=raw=>{const parsed=parseJsonLoose(raw),checks=parseActorChecks(raw,names);if(!checks.ok)return checks;const rows=parsed.results;if(rows.length!==names.length||new Set(rows.map(row=>row.name)).size!==names.length)return {ok:false,reason:'批量边界人数/重复项不符'};for(const row of rows){if(!names.includes(row.name))return {ok:false,reason:'批量边界含名单外人物'};const must=parseMusts(JSON.stringify({必成:row.必成}));if(!Array.isArray(row.必成)||!must.ok)return {ok:false,reason:row.name+'：'+(must.reason || '缺少必成数组')};}return {ok:true,rows,checks:checks.results};};
      const run=await withRetry(({correct})=>host.llmCall(correct({stage:'人物边界批量判定',subject:names.join('、'),messages:[{role:'user',content}],json:true})),{config:options.retry,signal:options.signal,retryDelayMs:options.retryDelayMs,retryMaxDelayMs:options.retryMaxDelayMs,validate:raw=>parseBatch(raw),onRetry:report('人物边界批量判定')});
      if(!run.ok){stateFailures.push(...names.map(name=>name+'：'+run.reason));return;}
      const result=parseBatch(run.value);for(const row of result.rows)musts[row.name]=parseMusts(JSON.stringify({必成:row.必成})).musts;mergedActorChecks.push(...result.checks);
      result.rows.forEach(row=>notifyActor(row.name,result.checks));
    }));
  }

  // 一个人都没压出来 → 整轮失败，不能拿空终态去判
  if (stateFailures.length || Object.keys(musts).length === 0) {
    return {
      ok: false,
      diff: null,
      strategy: 'actor',
      reason: `人物终态不完整，不能按全员成功处理：${stateFailures.slice(0, 3).join('；')}`,
      failedActors: stateFailures,
    };
  }

  // ---------- 第 1.5 步：减掉存档现状，只留**真正变了**的维度 ----------
  //
  // 用户 2026-10-21 的挠头点，就靠这一步兜死：
  //   「本来就九层」的人，推演出来还是九层 → 差是空的 → 不会变成待办。
  //
  // 这跟模型判得准不准无关，是数学上不可能：
  // 没变的东西进不了缺口清单。
  const changedStates = {};
  const unchanged = [];
  const currentStates = {};
  for (const [name, st] of Object.entries(musts)) {
    const current = typeof src.resolveActorState === 'function'
      ? src.resolveActorState(name, null)
      : null;
    currentStates[name] = current;
    const delta = subtractMusts(st, current);
    const dims = Object.keys(delta).filter((k) => k !== '依据');
    if (dims.length > 0) changedStates[name] = delta;
    else unchanged.push(name);
  }

  // ---------- 第二步：拿「真正变了的终态」对正文（1 次） ----------
  const stateLines = [];
  for (const bundle of actors) {
    const name = String(bundle && bundle.name || '').trim();
    if (!name) continue;
    const st = changedStates[name];
    // 跟存档现状一样的人不参与对勾——他这轮没有任何东西变了，没什么可交代的
    if (!st) continue;
    stateLines.push(renderMustLine(name, st, bundle.statusTag));
  }

  if (stateLines.length === 0) {
    actors.forEach(actor=>notifyActor(actor.name,[]));
    return {
      ok: true,
      diff: { covered: [], mutated: [], missing: [], perActor: {}, total: 0 },
      strategy: 'actor',
      musts,
      dossiers: buildActorDossiers({actors:dossierActors,currentStates,musts,factsByActor,factRecords,influences:analysis.influences,newcomers:src.newcomers || {},biographies:src.biographies || {}}),
      unchangedActors: unchanged,
      storyFacts,
      resolvedHooks,
      reason: '这一轮没有任何人的状态发生变化，不需要补',
    };
  }

  const expectedNames = actors
    .map((b) => String(b && b.name || '').trim())
    .filter((n) => n && changedStates[n]);

  const checkContent = fillTemplate(promptText('boundaryCheck', overrides), {
    '{{必成事实}}': stateLines.join('\n\n'),
    '{{本轮正文}}': storyText || '（本轮没有正文）',
  });

  const checkRun = mergedActorChecks.length ? {ok:true,value:JSON.stringify({results:mergedActorChecks.filter(row=>expectedNames.includes(row.name))})} : await withRetry(
    ({correct}) => host.llmCall(correct({ stage:'差集与正文覆盖核对',
      messages: [{ role: 'user', content: checkContent }],
      json: true,
    })),
    {
      config: options.retry,
      retryDelayMs: options.retryDelayMs,
      maxDelayMs: options.retryMaxDelayMs,
      validate: (text) => {
        const c = parseActorChecks(text, expectedNames);
        return { ok: c.ok, reason: c.reason };
      },
      onRetry: report('终态对正文'),
    },
  );

  if (!checkRun.ok) {
    return {
      ok: false,
      diff: null,
      strategy: 'actor',
      musts,
      reason: `终态对正文失败：${checkRun.reason}`,
      failedActors: stateFailures,
    };
  }

  const checked = parseActorChecks(checkRun.value, expectedNames);
  const diff = buildDiffFromActorChecks(checked.results, changedStates);

  // 每人一份档案：把这里梳理出来的东西整理好交给散文阶段。
  // 散文怎么写、为什么偏离，靠这份档案；蝴蝶效应在那边解决。
  const dossiers = buildActorDossiers({
    actors: dossierActors,
    currentStates,
    changedStates,
    musts,
    storyFacts,
    factsByActor,
    factRecords,
    influences: analysis.influences,
    checks: checked.results,
    newcomers: src.newcomers || {},
    biographies: src.biographies || {},
  });
  actors.forEach(actor=>notifyActor(actor.name,checked.results));

  return {
    ok: true,
    diff,
    strategy: 'actor',
    musts,
    // 只含真正变化维度的终态：散文阶段要按这个写，不是按全量终态
    changedStates,
    unchangedActors: unchanged,
    // 每人一份档案（推力原文 + 定案 + 被顶掉的），散文阶段的输入
    dossiers,
    checks: checked.results,
    // 正文硬事实：诊断里要能看到「这轮玩家到底改了什么」，
    // 它决定了每个人推演出来的终态是原著版还是偏离版
    storyFacts,
    factsFailed: factsReason || '',
    resolvedHooks,
    failedActors: stateFailures,
    reason: stateFailures.length > 0
      ? `有 ${stateFailures.length} 人的终态没推演出来：${stateFailures.slice(0, 3).join('；')}`
      : '',
  };
}

/**
 * 边界判定主入口：**第二种优先，第一种兜底**。
 *
 * 用户定的设计思路（2026-10-21）：
 *   先试「压要点 → 逐条对勾」；
 *   任一步不合格就退回「一步做差集」。
 *
 * 材料过大时（实测闭关百年 brief 就有 9.4 万字）自动分批：
 *   每批独立压要点、独立打勾，最后合并差集。
 *   不分批的话这一个请求必然超时，然后整轮什么都补不了。
 *
 * @param {object} input
 * @param {string} input.entryMaterial
 * @param {string} input.storyText
 * @param {object} input.host
 * @param {object} [input.options]
 * @param {'points'|'one_shot'|'auto'} [input.options.strategy='auto']
 *        玩家可在设置里强制某一种
 * @param {number} [input.options.batchChars] 单批字数上限
 * @returns {Promise<{
 *   ok:boolean, diff:object|null, strategy:string,
 *   fallbackUsed:boolean, reason:string, points?:string[],
 *   batches?:number
 * }>}
 */
/**
 * @deprecated 没有调用方，**不要用**。
 *
 * 早先的判法（分批 + 合并差集）。现在整条链走 evaluateBoundaryByActor，
 * 生产代码里没人引用它，只有测试还在喂。
 * 留着是因为删它要连带改测试，手抖就会把主链一起删掉。
 * 但它**不是活代码**：新增功能一律不要往这儿加。
 */
export async function evaluateBoundary(input) {
  const src = input && typeof input === 'object' ? input : {};
  const options = src.options || {};
  const strategy = String(options.strategy || 'auto');

  const batches = splitMaterialIntoBatches(
    src.entryMaterial,
    options.batchChars,
  );

  // 0 批 = 没材料，交给下面的单批逻辑去报「缺少年表材料」
  if (batches.length <= 1) {
    return evaluateOneBatch({ ...src, entryMaterial: batches[0] || src.entryMaterial }, strategy);
  }

  // 多批：逐批判定，合并差集
  const diffs = [];
  const points = [];
  const failures = [];

  for (let i = 0; i < batches.length; i += 1) {
    const r = await evaluateOneBatch({ ...src, entryMaterial: batches[i] }, strategy);
    if (r.ok && r.diff) {
      diffs.push(r.diff);
      if (Array.isArray(r.points)) points.push(...r.points);
    } else {
      failures.push(`第 ${i + 1} 批：${r.reason}`);
    }
  }

  // 一批都没成功 → 整轮失败（不能拿半份差集当全份）
  if (diffs.length === 0) {
    return {
      ok: false,
      diff: null,
      strategy,
      fallbackUsed: false,
      reason: `全部分批都失败（共 ${batches.length} 批）：${failures.join('；')}`,
      batches: batches.length,
    };
  }

  const merged = mergeDiffs(diffs);
  const partial = failures.length > 0;

  return {
    ok: true,
    diff: merged,
    strategy,
    fallbackUsed: partial,
    // 部分批次失败要如实说，别让玩家以为整段都判完了
    reason: partial
      ? `分批判定：${diffs.length}/${batches.length} 批成功，失败的是 ${failures.join('；')}`
      : `分批判定：${batches.length} 批全部成功`,
    points,
    batches: batches.length,
    failedBatches: failures,
  };
}

/** 单批的判定：要点式优先，失败兜底一步式 */
async function evaluateOneBatch(input, strategy) {
  // 玩家强制一步式
  if (strategy === CE_BOUNDARY_STRATEGY.oneShot) {
    const r = await boundaryOneShot(input);
    return { ...r, fallbackUsed: false };
  }

  // 玩家强制要点式：失败就失败，不兜底
  if (strategy === CE_BOUNDARY_STRATEGY.points) {
    const r = await boundaryByPoints(input);
    return { ...r, fallbackUsed: false };
  }

  // 默认：要点式优先，失败兜底到一步式
  const primary = await boundaryByPoints(input);
  if (primary.ok) {
    return { ...primary, fallbackUsed: false };
  }

  const fallback = await boundaryOneShot(input);
  return {
    ...fallback,
    fallbackUsed: true,
    reason: `要点式失败（${primary.reason}）→ 已退回一步式${fallback.ok ? '' : `，同样失败（${fallback.reason}）`}`,
  };
}

