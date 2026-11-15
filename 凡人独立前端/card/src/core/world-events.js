import { parseTimePoint } from './interval.js';
import { cleanVariableWorldEntry } from './character-profile.js';

export const WORLD_LIFECYCLE_FIELDS = ['effect', 'estimatedEnd', 'endCondition', 'endsAt', 'endedAt'];
export const WORLD_EVENT_CLOSURE_RULE = '逐条核对已有进行中的世界大事和实际结束条件，即使本轮没有新增大事也要检查。小说往往用结果、后果或转场交代收束：奖赏已发、人员撤离、名额落实、争夺物已被取走，或后续情节已进入与原活动不能并存的阶段，都可证明相应事件已经结束。依据实际剧情判断，原文无需出现“结束”或“闭幕”字样。沿用原事件编号记录结案和可核查的后果。具体结束时刻未写明时，记录首次能够确认已经收束的叙事时点，保留时间精度。只知个别人离开、原著跳过过程、后续没有提及或预计日期已过，仍须核对是否确有收束依据。资料不足继续保留进行中，冠军、奖励和胜负未知就留未知。';

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
    const expired = now !== null && end !== null && end <= now;
    const active = action !== 'resolve' && !(endedAt && (end === null || now === null)) &&
      !expired &&
      Boolean(action || prior?.active || fields.effect || fields.estimatedEnd || fields.endCondition || fields.endsAt || endedAt);
    events.set(root, {...fields, ...(endedAt ? {endedAt} : {}), id:row.id || String(id), changeId:typeof id==='string'?id:'',
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
  return projectWorldEvents(rows, at).filter(row=>row.active).map(row=>[
    '[事件编号 '+row.id+'] '+row.title, row.scope&&'影响范围 '+row.scope,
    row.description!==row.title&&row.description, row.effect&&'当前影响 '+row.effect,
    row.estimatedEnd&&'预计结束 '+row.estimatedEnd,
    row.endsAt&&'确定结束时间 '+row.endsAt, row.endCondition&&'结束条件 '+row.endCondition,
  ].filter(Boolean).join('｜')).join('\n');
}
export const WORLD_EVENT_OPPORTUNITY_RULE = '重大活动的筹备期也可能是玩家能行动的窗口。原著已确认本届或本轮将举行，门派典籍、执事和知情参与者等正常渠道能让合资格者获知并准备时，就登记为计划或筹备中的大事。写清已知的资格、参与途径、时限及可先做的准备。未公布确切日程或尚未开放时，保留未知和筹备状态。普通地名、旧事、周期制度或某个人的猜测本身不足以新增。后续报名、开场、入场、结案沿用同一条记录。';
