import { parseTimePoint, parseTimePrecision } from './interval.js';

export const CHARACTER_STATUS_LIFECYCLE = [
  '沿用万物有灵的覆盖顺序：逐条核对前态，先移除到期、解除、消退或结束条件已满足的状态，再新增当前仍在起作用的独立状态。',
  '跨日或跳时优先核对已经到期的效果。脱战、离开术法范围、解除禁制、归还维持效果的宝物等行为已经满足结束条件时，本轮就删除旧状态。',
  '毒已清、伤已愈、阵术散去、药效耗尽或临时来源失效时，删除对应状态。疗愈归正文、生平或摘要，恢复正常不另记增益，例如拔尽寒毒后不新写「寒毒尽清」。',
  '仍有残毒、伤后虚弱、真实临时加成或本人正在承受的术法时，按当前影响继承或更新。沿用原截止时点与实际结束条件，不以「再次中毒」「状态变化」给已结束的效果续期。重新受伤、中毒或施法须有当期事实。',
  '只记录本人当前承受的实际效果。修为、技能、物品状态、日常情绪、任务、守秘、盟约、他人遭遇和历史经历写各自字段。暂不能判断结束的实际状态沿用原记录和结束条件。',
].join('\n');

export const CHARACTER_STATUS_RULE = [
  '第4列「Buff 与状态」是终态快照。写入时整列覆盖，只留当前仍生效的状态和已有明确激活条件的待生效状态；已结束的删掉，同名更新用新条目替换。无状态写「一切正常」。',
  '先承接上一份人物快照的第4列，再用本节点实际发生的事更新。未变化的状态沿用原名、效果和结束条件；确实解除或到期才删除。旧节点的描述用于辨别实际新增，不能代替刚核验的前态。打算、疑虑、守秘和已知事实各归原字段。',
  '一条一项，分号分隔。格式：状态名(简短效果|生效中或自YYYY.MM.DD HH:mm|至YYYY.MM.DD HH:mm或至明确条件)。可用状态名:Emoji，来源可省略，需区分时只补一两个词。示例：药力(修炼速度+10%|生效中|至0017.05.16 08:00)；腿伤(行走跛足|生效中|至伤口愈合)。',
  '数值效果只用实际属性名加正负数或百分比，如脚力-2、神识+5%，多项用逗号分隔。已有确定数值才写数值，无数值时写一句当下可感知的影响。绝对时间用游戏内时间，只有日期可用 YYYY.MM.DD；明确条件如伤口愈合由剧情确认后删除，触发型待生效写「待激活」并附触发条件，触发后改「生效中」。已知到期时间沿用原值，勿重设倒计时。',
  '历史经历、已知规律、物品库存、修为突破成果、临场情绪和姿态各归其原字段；只有仍在影响人物的临时效果才进第4列。第4列不写入白值、变量增减、原文变更依据或抽离操作。',
  CHARACTER_STATUS_LIFECYCLE,
].join('\n');

const statusDate = /^(?:\d{1,6}[-.]\d{1,2}[-.]\d{1,2}|\d{1,6}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号])(?:\s*\d{1,2}[:：]\d{2})?$/u;
const statusSeparator = /^[\s;；]+/u;
const endedStatus = /^(?:已结束|已失效|已过期|已消退|已解除|结束|失效|消退)$/u;

function statusTime(value) {
  if (!statusDate.test(value)) return null;
  const text = value.replace('：', ':').replaceAll('-', '.').replace('号', '日').replace(/\s+(?=年|月|日)/gu, '');
  return parseTimePoint(text);
}

function statusEndTime(ending) {
  const legacy = /(?:^|[,，]\s*)届\s*([^,，]+)$/u.exec(ending);
  return statusTime(legacy?.[1].trim() ?? ending.replace(/^(?:直至|截至|至)\s*/u, ''));
}

function statusEntries(value) {
  let input = typeof value === 'string' ? value.trim() : '';
  if (!input || /^(?:无|正常|一切正常|无异常|无状态|无持续状态)$/u.test(input)) return [];
  const entries = new Map();
  while (input) {
    input = input.replace(statusSeparator, '');
    if (!input) break;
    const lead = /^(?:[①-⑳]|\d+[.、])?\s*([^()（）:：;；\r\n]+?)(?:[:：]\s*([^()（）;；\r\n]+?))?\s*[(（]/u.exec(input);
    let end = lead?.[0].length ?? 0;
    let depth = end ? 1 : 0;
    while (depth && end < input.length) {
      const ch = input[end++];
      if (ch === '(' || ch === '（') depth++;
      if (ch === ')' || ch === '）') depth--;
    }
    const parts = end && !depth ? input.slice(lead[0].length, end - 1).split(/[|｜]/u).map(part => part.trim()) : [];
    if (parts.length < 3 || !parts[0]) {
      const separator = input.search(/[;；\r\n]/u);
      const raw = (separator < 0 ? input : input.slice(0, separator)).trim();
      entries.set('raw:' + raw, { raw });
      input = separator < 0 ? '' : input.slice(separator + 1);
      continue;
    }
    const name = lead[1].trim();
    const icon = lead[2]?.trim() || '';
    const [effectText, activation, ending, source] = parts;
    entries.set(name.normalize('NFKC').replace(/\s+/gu, ''), { name, icon, effectText, activation, ending, source });
    input = input.slice(end);
  }
  return [...entries.values()];
}

function statusLifecycle(entry, at) {
  if (entry.raw) return 'text';
  const { activation, ending } = entry;
  if (endedStatus.test(activation) || endedStatus.test(ending) || completedStatus(entry)) return 'ended';
  const now = statusTime(at);
  const start = activation.startsWith('自') ? statusTime(activation.slice(1).trim()) : null;
  const endText = ending.replace(/^(?:直至|截至|至)\s*/u, '');
  const end = statusEndTime(ending);
  if (end !== null && ((start !== null && end <= start) || (now !== null && now >= end))) return 'ended';
  if (activation !== '生效中' && (start === null || now === null || now < start)) return 'pending';
  if (end !== null) {
    if (now === null || (parseTimePrecision(at) === 'day' && end - now < 1440 && end > now)) return 'pending';
    return 'active';
  }
  // Legacy remaining-time text has no saved start time. Leave it readable until a node can resolve it.
  const condition = /^(?:直至|直到|至)\s*[^\d\s]/u.test(ending) &&
    !/^(?:持续|剩余|永久|未知|不明|到|\d)/u.test(endText.replace(/^直到\s*/u,''));
  return condition ? 'active' : 'text';
}

function completedStatus({ name='', effectText='', ending='' }) {
  const clearlyResolved=/(?:毒|伤|病|眩晕|麻痹|疲劳|诅咒|封禁)[^，。]{0,8}(?:尽清|全消|已清|已消|已解|清除|解除|痊愈|已愈|复原|尽退|已退)$/u.test(name);
  const effectEnded=/(?:拔尽|驱尽|驱除干净|清除干净|已清除|已解除|已痊愈|完全恢复|全消|尽消|尽褪|已归还)/u.test(effectText);
  const artificialEnd=/^(?:直至|直到|至)\s*(?:再中|再次|重新|下次|状态变化|状态改变)/u.test(ending);
  const continuedEffect=/(?:仍有|仍在|依然|尚未|并未|残余|残留|残毒|未愈|未清|暂未|持续|药力未尽|额外增益|免疫|抗性|抗寒|抗毒|抵御|护体|[+＋][0-9])/u.test(effectText);
  return clearlyResolved && (effectEnded || artificialEnd) && !continuedEffect;
}

function serializeStatus(entry) {
  return entry.raw || entry.name + (entry.icon ? ':' + entry.icon : '') + '(' +
    [entry.effectText, entry.activation, entry.ending, ...(entry.source ? [entry.source] : [])].join('|') + ')';
}

export function pruneCompletedCharacterStatuses(value) {
  if (typeof value !== 'string') return value;
  const entries = statusEntries(value);
  const kept = entries.filter(entry => !completedStatus(entry));
  return kept.length === entries.length ? value : kept.map(serializeStatus).join('；') || '一切正常';
}

export function normalizeCharacterStatus(value, worldTime = '') {
  const at = String(worldTime || '').trim();
  const entries = statusEntries(value);
  if (entries.every(entry => entry.raw) && entries.length === 1) return entries[0].raw;
  return entries.filter(entry => statusLifecycle(entry, at) !== 'ended').map(serializeStatus).join('；') || '一切正常';
}

export function carryCharacterStatus(actual, previousProduct, nextProduct, worldTime) {
  if (typeof nextProduct !== 'string') return typeof actual==='string'?normalizeCharacterStatus(actual,worldTime):nextProduct;
  if (typeof actual !== 'string' || typeof previousProduct !== 'string') return normalizeCharacterStatus(nextProduct,worldTime);
  const entries=value=>new Map(statusEntries(normalizeCharacterStatus(value,worldTime)).map(row=>
    [row.name||row.raw,row.raw||normalizeCharacterStatus(row.name+(row.icon?':'+row.icon:'')+'('+
      [row.effectText,row.activation,row.ending,...(row.source?[row.source]:[])].join('|')+')',worldTime)]));
  const current=entries(actual), before=entries(previousProduct), after=entries(nextProduct);
  for(const [name,value] of before)if(!after.has(name)&&current.get(name)===value)current.delete(name);
  for(const [name,value] of after)if(value!==before.get(name))current.set(name,value);
  return normalizeCharacterStatus([...current.values()].join('；'),worldTime);
}

export function activeCharacterStatuses(value, worldTime = '') {
  const at = String(worldTime || '').trim();
  return statusEntries(value).filter(entry => statusLifecycle(entry, at) === 'active');
}

export function cultivationStatusPeriods(value) {
  return statusEntries(value).filter(entry=>entry.effectText?.includes('修炼速度')).map(entry=>({
    start: entry.activation?.replace(/^自\s*/u,''),
    end: entry.ending?.replace(/^(?:直至|截至|至)\s*/u,''),
  }));
}

export function characterStatusCards(value, worldTime = '') {
  const at = String(worldTime || '').trim();
  return statusEntries(value).flatMap(entry => {
    const state = statusLifecycle(entry, at);
    if (state === 'ended') return [];
    if (entry.raw) return [{ name: entry.raw, state: 'text' }];
    const scheduled = entry.activation.startsWith('自') && statusTime(entry.activation.slice(1).trim()) !== null;
    return [{ ...entry, state, pending: state === 'pending' && (scheduled || entry.activation !== '生效中'),
      negative: /(?:毒|伤|痛|晕|力竭|封禁|[\p{Script=Han}]\s*-\s*\d)/u.test(entry.name + ' ' + entry.effectText) }];
  });
}

export function validCharacterStatusSnapshot(value) {
  if (value === '一切正常') return true;
  const entries = statusEntries(value);
  return entries.length > 0 && entries.every(entry => !entry.raw && entry.activation && entry.ending &&
    (entry.activation === '生效中' || /^待激活[：:]\s*\S/u.test(entry.activation) ||
      entry.activation.startsWith('自') && statusTime(entry.activation.slice(1).trim()) !== null) &&
    (/^(?:直至|至)\s*[^\d\s]/u.test(entry.ending) ||
      statusTime(entry.ending.replace(/^(?:截至|至)\s*/u,'')) !== null));
}
