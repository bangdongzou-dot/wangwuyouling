// ============================================================
// 按人压缩：这一轮每个 NPC 的终态是什么
//
// 用户 2026-10-21（这一条推翻了之前所有做法）：
//
//   「比如说这一轮有10个年表事件，1到10每个都涉及角色a的事情，
//     比如说修为，在1事件他的修为是炼气三层，在10事件他的修为是炼气九层，
//     那压缩什么？这一轮需要补的是他炼气九层这个终极状态。
//     物品也是同理的，1事件他做了一个法宝，10事件法宝损坏了，
//     压缩的是什么。这个法宝的最终状态，不需要生成了不需要补了，没了。」
//
//   「原著年表里写到的发生的事情，都应该成为这个npc的重要经历被记录下来，
//     xx年xx月xx日，这个人做了xx。」
//
// ------------------------------------------------------------
// 两件事，必须分开：
//
//   ① **终态**（要模型）
//      这个人走到这一轮末尾，是什么样：修为、物品、位置、存在性。
//      中间过程全丢掉——炼气三层→炼气九层，只留「炼气九层」。
//      压成「事件摘要」是错的：摘要里全是过程，对勾那一步没法用。
//
//   ② **经历流水**（不要模型）
//      年表里写到的事，一条一条记进第 35 列「生平经历」，
//      格式 `[0011年01月@神手谷]随墨大夫采药`。
//      时间在标题里、事情在 brief 里，直接拼就行，调模型是浪费。
//      卡里已有生平压缩机制（超 1000 字压成 5 条），会自动收着。
//
// ------------------------------------------------------------
// 为什么必须先筛人（用户 2026-10-21 定）：
//
//   「玩家根本不在意那些路人，玩家不在意的地方，不做，这就是游戏优化思路」
//
//   实测：
//     闭关十一年  73 人 →  筛后 26 人
//     闭关百年   144 人 →  筛后 42 人
//
//   筛掉的多是「野狼帮帮众」「巨剑门弟子(尸)」这种被打的、围观的。
//   他们有经历流水就够了，不需要终态。
// ============================================================

import { parseCharacterTags, cleanEventTitle, eventCodeFromTitle, renderEventMaterial } from './vector-input.js';
import { entrySpan, parseTimePoint } from './interval.js';

/** 筛人标准：在多少个事件里出现过，才算「有戏」 */
export const CE_ACTOR_MIN_EVENTS = 3;

/** 终态里有哪些维度（只有这几个，多一个都不压） */
export const CE_MUST_FIELDS = {
  cultivation: '修为',
  items: '随身物品',
  location: '所在位置',
  alive: '存在性',
  identity: '身份',
};

/**
 * 一个人在这一轮里涉及的所有事件。
 *
 * @typedef {object} ActorBundle
 * @property {string} name
 * @property {string[]} aliases
 * @property {string} statusTag 标题里带的标注（已故/尸/某门派），可能为空
 * @property {Array<{code:string,title:string,time:string,brief:string}>} events
 * @property {number} eventCount
 */

/**
 * 从候选事件里抽出「这一轮有戏的人」，并按人把事件归堆。
 *
 * 筛人三条，任一成立就留：
 *   ① 在 ≥ CE_ACTOR_MIN_EVENTS 条事件里出现过（有连续性，值得跟踪）
 *   ② 标题带状态标注（已故 / 尸 / 某门派），说明原著明确交代了他的处境
 *   ③ 调用方传了已建档名单，他在里面（玩家已经认识的人，不能不管）
 *
 * 剩下的进「路人」，只给经历流水，不压终态。
 *
 * @param {object} input
 * @param {Array<object>} input.events 候选事件（原始年表条目）
 * @param {string[]} [input.archivedNames] 存档里已建档的人名
 * @param {boolean} [input.includePlayer] 玩家要不要算（默认不算）
 * @param {number} [input.minEvents] 覆盖默认门槛
 * @returns {{actors:ActorBundle[], extras:ActorBundle[], filtered:object}}
 */
export function collectActorBundles(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const events = Array.isArray(src.events) ? src.events : [];
  const archived = new Set(
    (Array.isArray(src.archivedNames) ? src.archivedNames : [])
      .map((n) => String(n == null ? '' : n).trim())
      .filter(Boolean),
  );
  const minEvents = Number(src.minEvents) > 0 ? Number(src.minEvents) : CE_ACTOR_MIN_EVENTS;
  // 传进来的候选事件本身就该是「这一轮时间窗内」的（由调用方按区间筛好）。
  // 打开 windowOnly 就表示：进来的都建档，不再拿人考核。
  const windowOnly = src.windowOnly === true;

  /** name -> { aliases:Set, statusTag, events:[] } */
  const byName = new Map();

  for (const ev of events) {
    const title = String(ev && ev.title || '');
    const code = eventCodeFromTitle(title);
    const eventTitle = cleanEventTitle(title);
    const time = String(ev && (ev.time_start || ev.year_start) || '').trim();
    const span = entrySpan(ev), now = parseTimePoint(src.currentTime);
    const selected = renderEventMaterial(ev, {mode:src.materialMode || 'current_only',isCurrent:now !== null && span && span.min <= now && now <= span.max,maxChars:src.materialMaxChars === undefined?0:Number(src.materialMaxChars)});


    for (const tag of parseCharacterTags(title)) {
      const name = String(tag.name || '').trim();
      if (!name) continue;

      let item = byName.get(name);
      if (!item) {
        item = { name, aliases: new Set(), statusTag: '', events: [] };
        byName.set(name, item);
      }
      if (tag.status) item.statusTag = tag.status;
      if (tag.raw && tag.raw !== name) item.aliases.add(tag.raw);

      // 同一事件里同一个人只记一次（标签可能重复）
      if (!item.events.some((e) => e.code === code && e.title === eventTitle)) {
        item.events.push({ code, title: eventTitle, time, timeEnd:String(ev.time_end || ev.year_end || ''), brief:selected.brief, original:selected.original, materialText:selected.text, primarySource:selected.primarySource, sourceTruncated:selected.truncated,
          ...(ev.pointerInProgress?{pointerInProgress:true}:{}) });
      }
    }
  }

  const actors = [];
  const extras = [];
  let dropped = 0;

  for (const item of byName.values()) {
    const bundle = {
      name: item.name,
      aliases: [...item.aliases],
      statusTag: item.statusTag,
      events: item.events,
      eventCount: item.events.length,
    };

    // 玩家自己不压终态（玩家状态由正文和变量系统管）
    // 传了 playerName 就跳过这个人
    const playerName = String(src.playerName || '').trim();
    if ((playerName && item.name === playerName) || (src.playerNames || []).includes(item.name)) continue;

    // ---------- 圈人：拿时间窗筛，不拿人筛 ----------
    //
    // 用户 2026-10-21：
    //   「能进原著年表简略条目的npc，就几乎不存在路人，即使存在，
    //     除了当下这一轮正在进行中的年表事件以外，根本没有落地成npc档案的必要，
    //     已经经过的原著年表事件中，这些角色几乎都是作为龙套和炮灰的存在，用完即弃。」
    //
    // 所以早先那三条准入（≥N 条 / 带状态标注 / 已在档）是错的：
    // 年表是原著提炼过的，被点名的都是原著里真有分量的人，不需要再考一遍。
    //
    // 真正要筛的只有一件事：谁现在需要一份档案。
    //   窗口内（这一轮正在进行的年表事件里的人）→ 建档
    //   窗口外                                     → 用完即弃，不碰
    //
    // windowOnly 打开时走这条新规则；不打开时退回旧行为（兼容老调用）。
    if (windowOnly) {
      actors.push(bundle);
      continue;
    }

    const isArchived = archived.has(item.name);
    // 注意用 bundle.eventCount，不是 item.eventCount ——
    // item 上根本没这个字段，之前写成 item.eventCount 永远是 undefined，
    // 于是 isFrequent 恒为 false，**所有人都被当路人筛掉**。
    const isFrequent = bundle.eventCount >= minEvents;
    const hasStatus = Boolean(item.statusTag);

    if (isArchived || isFrequent || hasStatus) {
      // 已建档的排前面：玩家认识的人优先
      if (isArchived) actors.unshift(bundle);
      else actors.push(bundle);
    } else {
      extras.push(bundle);
      dropped += 1;
    }
  }

  return {
    actors,
    extras,
    filtered: {
      total: byName.size,
      kept: actors.length,
      extras: extras.length,
      dropped,
      minEvents: windowOnly ? 0 : minEvents,
      windowOnly,
      archivedKnown: archived.size,
    },
  };
}

/**
 * 把一个人涉及的事件压成给模型看的材料。
 *
 * 按时间排序，让模型自己看出「后者覆盖前者」——
 * 这是它判断终态的唯一依据，顺序错了终态就错了。
 *
 * @param {ActorBundle} bundle
 * @param {object} [options]
 * @param {number} [options.maxCharsPerEvent=0] 完整事件容量，0 表示不限制
 * @returns {string}
 */
export function renderActorMaterial(bundle, options = {}) {
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const maxPer = Number(options.maxCharsPerEvent) > 0
    ? Number(options.maxCharsPerEvent) : 0;

  const lines = [];
  const name = String(b.name || '').trim();
  lines.push(`人物：${name}${b.statusTag ? `（${b.statusTag}）` : ''}`);
  if (Array.isArray(b.aliases) && b.aliases.length > 0) {
    lines.push(`别名/称谓：${b.aliases.join('、')}`);
  }
  lines.push(`本轮涉及 ${Array.isArray(b.events) ? b.events.length : 0} 条原著事件，按时间先后排列：`);
  lines.push('');

  const events = (Array.isArray(b.events) ? b.events.slice() : [])
    .sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));

  // 核心必需材料默认完整；显式容量不足时拒绝，不省略中段事件。
  const maxTotal = Number(options.maxCharsTotal) > 0
    ? Number(options.maxCharsTotal) : CE_ACTOR_MATERIAL_MAX_CHARS;

  const rendered = events.map((e, i) => {
    const brief = String(e.materialText || e.brief || '').trim();
    if(maxPer>0 && brief.length>maxPer)throw Object.assign(new Error('人物的单条事件超过处理容量；请按完整对象分批或提高请求容量，不可截断事件。'),{code:'CE_REQUEST_CAPACITY'});
    const head = `${i + 1}. [${e.time || '时间未标'}] ${e.code ? e.code + ' ' : ''}${e.title || ''}`;
    return brief ? `${head}\n   ${brief}` : head;
  });

  if(maxTotal>0 && rendered.reduce((n,text)=>n+text.length+1,0)>maxTotal)throw Object.assign(new Error('单个人物的完整材料超过处理容量；请按完整对象分批或提高请求容量，不可省略中间事件。'),{code:'CE_REQUEST_CAPACITY'});
  lines.push(...rendered);

  return lines.join('\n');
}

/** 单人核心材料默认完整，0 表示不限制。 */
export const CE_ACTOR_MATERIAL_MAX_CHARS = 0;

/**
 * 把一个人涉及的每条事件拼成「生平经历」的一行。
 *
 * 格式对齐卡内已有的生平格式：`[时间@地点]事件`
 * 这样既有的生平压缩机制（超 1000 字压 5 条）能直接吃。
 *
 * 不需要模型：时间在标题里、事情在 brief 里。
 *
 * @param {ActorBundle} bundle
 * @param {object} [options]
 * @param {string} [options.location] 这一轮的主要地点（标题里没地点时兜底）
 * @param {number} [options.maxCharsPerEntry=80] 每条经历的字数上限
 * @returns {string[]} 每行一条，可直接 appendBiography
 */
export function renderBiographyLines(bundle, options = {}) {
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const fallbackLoc = String(options.location || '').trim() || '未知地点';
  const maxPer = Number(options.maxCharsPerEntry) > 0
    ? Number(options.maxCharsPerEntry) : 80;

  const name = String(b.name || '').trim();
  const events = (Array.isArray(b.events) ? b.events.slice() : [])
    .sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));

  const out = [];
  const seen = new Set();

  for (const e of events) {
    const time = normalizeBiographyTime(e.time);
    const loc = extractLocationFromBrief(e.brief) || fallbackLoc;
    let what = String(e.brief || '').trim() || String(e.title || '').trim();
    // brief 是一段话，取第一句就够写经历了
    what = firstSentence(what);
    if (what.length > maxPer) what = what.slice(0, maxPer) + '…';
    if (!what) continue;

    const line = `[${time}@${loc}]${what}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }

  return out;
}

/**
 * 把年表的时间写法规范成生平用的人话时间。
 *
 * `0011.01` → `0011年01月`
 * `0011-0015年11月` → `0015年11月`（取末尾，经历记的是发生的那一刻）
 * `0010.04.05` → `0010年04月05日`
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBiographyTime(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '未知时间';

  // 区间写法：取后段（这一轮走到的那一刻）
  const rangeTail = text.split(/[-—~～至到]/).pop().trim();

  const m = rangeTail.match(/(\d{3,4})(?:[.年](\d{1,2}))?(?:[.月](\d{1,2}))?/);
  if (!m) return text;

  const year = m[1];
  const month = m[2];
  const day = m[3];
  if (!month) return `${year}年`;
  if (!day) return `${year}年${String(month).padStart(2, '0')}月`;
  return `${year}年${String(month).padStart(2, '0')}月${String(day).padStart(2, '0')}日`;
}

/** 从 brief 里抠一个地点（「XX谷」「XX门」这类），抠不到返回空 */
function extractLocationFromBrief(brief) {
  const text = String(brief == null ? '' : brief);
  if (!text) return '';
  const m = text.match(/[\u4e00-\u9fa5]{2,6}(?:谷|门|派|宗|城|镇|村|府|山|洞|殿|阁|坊|州|郡|国)/);
  return m ? m[0] : '';
}

/** 取第一句，去掉后面的铺陈 */
function firstSentence(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const m = t.match(/^[^。！？!?；;]{1,200}/);
  return (m ? m[0] : t).trim();
}

/**
 * 把一个人这一轮的经历和「他之前已有的生平」合并说明，给压缩用。
 *
 * 只做提示，不写档案——写档案的地方在落地阶段。
 *
 * @param {ActorBundle} bundle
 * @param {object} [options]
 * @returns {{name:string, biographyLines:string[], text:string}}
 */
export function buildBiographyPatch(bundle, options = {}) {
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const lines = renderBiographyLines(b, options);
  return {
    name: String(b.name || '').trim(),
    biographyLines: lines,
    text: lines.join('\n'),
  };
}
