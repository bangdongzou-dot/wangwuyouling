import { numericSetting } from './numeric-settings.js';
import { parseTimePrecision, parseTimePoint } from './interval.js';
import { cleanVariableWorldEntry } from './character-profile.js';

export const WORLD_EVENT_GRANULARITY_RULE = "【世界大事按连续事件归并】先按事件的核心冲突或活动、主要参与方、作用对象和时间连续性归并本轮事实，再输出指令；一件事不是一句话、一个人物动作、一个地点镜头或一个年表编号。同一场战争、同一届盛会或同一次争夺的筹备、交锋、胜负、撤离和直接余波，归在同一事件的完整简报，不拆成多个新增。已有对应事件时沿用真实事件ID，用 updateWorldEvent 承接进展，不只用于纠错；同批尚无记录时合并为一次 addWorldEvent，不先逐碎片新增再删除。保留关键时间顺序、主体、影响范围、资源归属、关键数值与价格、参与条件、实际转折与已确认结果；更新不能只剩最后一步而丢失理解当前局势所需的前因和既有结案事实。独立起因、独立作用对象或可以独立持续/结束的重大变化可另立事件，已结束后新一届或新一轮也可另立，不因同势力、同地点、同日就强行合并；重要转折可在原事件内分句写清，不以压缩条数抹掉。只记录当前正文与已保存事实已成立的状态，进行中就保持进行中，不为凑成完整故事提前兑现结局，也不把秘密自动公开。无实质新变化不重复写，既有历史不按标题相似度批量删除。";

export const WORLD_EVENT_LIFECYCLE_REFERENCE = '${numeric_rule:world-event-lifecycle}';
export const WORLD_EVENT_DURATION_DAYS = Object.freeze({
  '突发冲突':[3,3], '集会竞赛':[7,7], '交易拍卖':[30,30], '招募征召':[90,90],
  '灾变封锁':[30,30], '悬赏通缉':[180,180], '势力变局':[90,90], '秘境开放':[30,30],
  '探索远征':[180,180], '战役阶段':[365,365], '长期秩序':[730,730], '未分类':[30,30],
});
export const WORLD_EVENT_LIFECYCLE_RULE_TEXT = [
  "通用判定顺序：内容资料明确时依明确事实；未明说时主动结合完整设定、前后因果和后续结果合理推理，标明推断依据，不因缺“结束”字样就停工或要求人工。资料通常足以判断，未知/无仅在确实无法合理推理时才用兜底规则；“无变化/无需延期/无此事件”也是有效结果，不能为了填满字段编造。",
  '类别 | 默认持续日数 | 单次延期窗口日数',
  ...Object.entries(WORLD_EVENT_DURATION_DAYS).map(([name,days])=>[name,...days].join(' | ')),
  '剧情明确的 endsAt / endedAt 优先。默认时长只是当前事件影响窗口，不是胜负、奖励、撤令或战争结束的证据；到期转历史，标为期限届满且结果未确认，不虚构结案事实。',
  '新增或复核用 eventCategory 明确选择表内类别；按实际内容分类，不按标题关键词机械归类。战争分阶段、长期秩序分当前观察阶段，期限届满不等于整个战争结束或政策撤销。',
  '续期须用同一事件 update，提供 extensionEvidence（本轮可核查的持续事实）、extendedAt（该证据已成立的时间）、extensionUntil（新的截止）。新截止须晚于原截止且不超过证据时间加本类单次延期窗口；有剧情明确截止则用 endsAt。普通改写、被再次提及或时间跳跃不能自动续命。',
  '每轮批量复核全部待分类旧事件，补 eventCategory 及真实原起点，不能改起点为今天以续命。未知类别暂用未分类窗口，过期条目保留在待复核历史，不永久占进行中。',
  '同一时点可提前确认事实结束；没有胜负信息就保持未知。年份或月份精度的起点从该精度末尾保守计时，计算沿用现有年表31日进位。日期缺失或无法解析时保留待复核，先补可信日期，不臆造结案。',
].join('\n');

function lifecycleDate(index) {
  const days=Math.floor(index/1440), year=Math.floor(days/372), rest=days-year*372;
  return String(year).padStart(4,'0')+'.'+String(Math.floor(rest/31)+1).padStart(2,'0')+'.'+String(rest%31+1).padStart(2,'0')+' '+String(Math.floor(index%1440/60)).padStart(2,'0')+':'+String(index%60).padStart(2,'0');
}
export function worldEventDeadline(fields,start,at,prior={}) {
  const known=Object.hasOwn(WORLD_EVENT_DURATION_DAYS,fields.eventCategory||'');
  const category=known?fields.eventCategory:'未分类';
  const [days,extensionDays]=numericSetting('world-event-lifecycle',category)||WORLD_EVENT_DURATION_DAYS[category];
  let anchor=parseTimePoint(start);
  const precision=parseTimePrecision(start);
  if(anchor!==null)anchor+=precision==='year'?372*1440-1:precision==='month'?31*1440-1:precision==='day'?1439:0;
  const explicit=parseTimePoint(fields.endsAt), now=parseTimePoint(at);
  let deadline=explicit!==null?explicit:anchor===null?null:anchor+days*1440;
  const accepted=parseTimePoint(prior.acceptedExtensionUntil);
  if(explicit===null&&deadline!==null&&accepted!==null)deadline=Math.max(deadline,accepted);
  const extension=parseTimePoint(fields.extensionUntil), evidenceAt=parseTimePoint(fields.extendedAt);
  const extended=explicit===null&&deadline!==null&&extension!==null&&evidenceAt!==null&&
    Boolean(fields.extensionEvidence?.trim())&&evidenceAt>=(parseTimePoint(start)??Infinity)&&
    (now===null||evidenceAt<=now)&&extension>deadline&&extension<=evidenceAt+extensionDays*1440;
  if(extended)deadline=extension;
  return {eventCategory:category,expiresAt:deadline===null?'':lifecycleDate(deadline),deadline,
    deadlineExpired:now!==null&&deadline!==null&&now>=deadline,
    acceptedExtensionUntil:extended?fields.extensionUntil:prior.acceptedExtensionUntil||'',
    lifecycleReviewNeeded:!known||category==='未分类'||anchor===null,extensionAccepted:extended};
}

export const WORLD_LIFECYCLE_FIELDS = ['effect', 'estimatedEnd', 'endCondition', 'endsAt', 'endedAt', 'eventCategory', 'extensionEvidence', 'extendedAt', 'extensionUntil'];
export const WORLD_EVENT_CLOSURE_RULE = '逐条核对已有进行中的世界大事和实际结束条件，即使本轮没有新增大事也要检查。小说往往用结果、后果或转场交代收束：奖赏已发、人员撤离、名额落实、争夺物已被取走，或后续情节已进入与原活动不能并存的阶段，都可证明相应事件已经结束。依据实际剧情判断，原文无需出现“结束”或“闭幕”字样。沿用原事件编号记录结案和可核查的后果。具体结束时刻未写明时，记录首次能够确认已经收束的叙事时点，保留时间精度。只知个别人离开、后续未提及不能推导具体结局。按数值规则的默认窗口到期仅失活归档，不写事实结案；有证据才延期，冠军、奖励和胜负未知就留未知。' + '\n' + WORLD_EVENT_LIFECYCLE_REFERENCE + '';

export function worldLifecycleFields(row) {
  return Object.fromEntries(WORLD_LIFECYCLE_FIELDS.filter(key => typeof row?.[key] === 'string')
    .map(key => [key, row[key].trim()]));
}

const caixiaConflictId = 'E-009-N5:0';
const caixiaConflictTitle = '七玄门与野狼帮在彩霞山的冲突';
const caixiaConflictStages = new Map([
  ['E-009-N5:0', ['add', '野狼帮与七玄门冲突增多']],
  ['E-022-N6:0', ['update', '野狼帮袭扰加剧']],
  ['E-026-N1:0', ['update', '七玄门与野狼帮冲突扩至粮道']],
  ['E-027-N6:0', ['update', '野狼帮假和谈袭占七玄门外围哨站']],
  ['E-032-N6:0', ['update', '七玄门与野狼帮签死契']],
  ['E-033-N6:0', ['resolve', '落日峰死契血斗七玄门胜']],
  ['E-034-N1:0', ['resolve', '野狼帮残部与断水门、铁枪会退出彩霞山']],
  ['E-034-N1:1', ['resolve', '七玄门与野狼帮在彩霞山一带的袭扰冲突平息']],
]);

// Legacy canon products assigned separate IDs to successive stages of this conflict.
// Verify both source ID and title so variant and unrelated records keep their own lifecycle.
export function caixiaConflictLink(row) {
  const key = row.prebuiltChangeId || row.changeId || String(row.id || '').replace(/^prebuilt:/u, '');
  const stage = caixiaConflictStages.get(key);
  const title = row.title || String(row[2] || '').split('｜', 1)[0];
  if (!stage || !(title.startsWith(stage[1]) || title === caixiaConflictTitle)) return null;
  const [action] = stage;
  return { title:caixiaConflictTitle, action, previousId:action==='add'?'':caixiaConflictId, root:caixiaConflictId };
}

export function splitWorldDigest(events) {
  return { current:events.filter(event=>event.active), history:events.filter(event=>!event.active) };
}

// Rows remain append-only for source withdrawal and replay. This is their state at a given time.
export function projectWorldEvents(rows, at) {
  const now = parseTimePoint(at);
  const ordered = (rows || []).filter(row => row && String(row[2] || row.prose || row.summary || '').trim())
    .map(raw => ({row:cleanVariableWorldEntry(raw), time:parseTimePoint(raw[0] || raw.at)}))
    .filter(({time}) => now === null || time === null || time <= now)
    .sort((a,b) => (a.time ?? -Infinity) - (b.time ?? -Infinity));
  const events = new Map(), aliases = new Map();
  for (const {row} of ordered) {
    const id = row.prebuiltChangeId || row.changeId || row.id || Symbol();
    const knownConflict = caixiaConflictLink(row);
    const previous = row.prebuiltPreviousId || row.previousId;
    const action = knownConflict?.action || row.prebuiltChange || row.action;
    const root = knownConflict?.root ?? ((action==='update'||action==='resolve') ? aliases.get(previous) ?? previous ?? id : id);
    const prior = events.get(root);
    const fields = {...worldLifecycleFields(prior), ...worldLifecycleFields(row)};
    const desc = String(row[2] || row.prose || row.summary).trim();
    const [heading] = desc.split('｜',1);
    const detail = row.title || heading===desc ? desc : desc.slice(heading.length+1);
    const description = action==='resolve'&&prior?.ended
      ? [...new Set([...prior.description.split('\n'), detail])].join('\n') : detail;
    const start = prior?.start || row.start || row[0] || row.at || '';
    const endedAt = prior?.endedAt || (action === 'resolve' ? row[0] || row.at || '' : fields.endedAt);
    const end = parseTimePoint(endedAt || fields.endsAt);
    const eligible=Boolean(action||prior?.active||fields.effect||fields.estimatedEnd||fields.endCondition||fields.endsAt||endedAt);
    const timing=worldEventDeadline(fields,start,at,prior);
    if(!eligible){timing.lifecycleReviewNeeded=false;timing.deadlineExpired=false;timing.expiresAt='';}
    const expired = (now !== null && end !== null && end <= now)||timing.deadlineExpired;
    const confirmed=action==='resolve'||Boolean(endedAt)||(now!==null&&parseTimePoint(fields.endsAt)!==null&&parseTimePoint(fields.endsAt)<=now);
    if(confirmed)timing.lifecycleReviewNeeded=false;
    const active = action !== 'resolve' && !(endedAt && (end === null || now === null)) &&
      !expired &&
      Boolean(action || prior?.active || fields.effect || fields.estimatedEnd || fields.endCondition || fields.endsAt || endedAt);
    events.set(root, {...fields, ...timing, expired, closureKind:confirmed?'confirmed':expired?'deadline':'', ...(endedAt ? {endedAt} : {}), id:row.id || String(id), changeId:typeof id==='string'?id:'',
      rootChangeId:typeof root==='string'?root:'',
      title:knownConflict?.title || row.title || heading, description,
      scope:row[1] || row.scope || prior?.scope || '', start, at:row[0] || row.at || '',
      active, ended:action==='resolve'||expired||Boolean(endedAt&&(end===null||now===null))});
    aliases.set(id,root);
    if (row.id) aliases.set(row.id,root);
  }
  return [...events.values()];
}

export function formatActiveWorldEvents(rows, at) {
  return projectWorldEvents(rows, at).filter(row=>row.active||row.lifecycleReviewNeeded).map(row=>[
    row.lifecycleReviewNeeded&&'[待分类/时间复核；保留历史原条目]',
    row.closureKind==='deadline'&&'[期限届满；结果未确认；非事实结案]',
    row.expiresAt&&'当前窗口截止 '+row.expiresAt,
    '[事件编号 '+row.id+'] '+row.title, row.scope&&'影响范围 '+row.scope,
    row.description!==row.title&&row.description, row.effect&&(row.active?'当前影响 ':'最近已知影响 ')+row.effect,
    row.estimatedEnd&&'预计结束 '+row.estimatedEnd,
    row.endsAt&&'确定结束时间 '+row.endsAt, row.endCondition&&'结束条件 '+row.endCondition,
  ].filter(Boolean).join('｜')).join('\n');
}
export const WORLD_EVENT_OPPORTUNITY_RULE = '重大活动的筹备期也可能是玩家能行动的窗口。原著已确认本届或本轮将举行，门派典籍、执事和知情参与者等正常渠道能让合资格者获知并准备时，就登记为计划或筹备中的大事。写清已知的资格、参与途径、时限及可先做的准备。未公布确切日程或尚未开放时，保留未知和筹备状态。普通地名、旧事、周期制度或某个人的猜测本身不足以新增。后续报名、开场、入场、结案沿用同一条记录。';
