// ============================================================
// 本轮焦点：这一轮玩家会碰到哪些原著的人、事、物
//
// 用户原话（2026-10-21，这是本模块存在的唯一理由）：
//   「原著指导的核心目的是围绕玩家来指导，
//     这一轮的剧情应该怎么体验原著对剧情的影响。」
//   「这一轮剧情会涉及的原著相关的人、事、物
//     才需要指导怎么合理的写在剧情里，本质是这个」
//
// ------------------------------------------------------------
// 为什么必须先算焦点，而不是把区间内事件全塞给模型：
//
//   玩家闭关 20 年，区间内 73 个人、68 条事件。
//   把这些全塞进去，会犯三个错：
//
//     ① 贵：token 爆掉
//     ② 散：正文作者被无关信息淹没，反而写不出重点
//     ③ 假：那 73 个人里绝大多数这一刻跟玩家毫无关系
//
//   玩家闭关出关那一刻，真正有关系的是：
//     「我现在在哪、身边有谁、我这趟出来想办什么、
//       这段时间原著在我这个位置上正发生什么」
//
// ------------------------------------------------------------
// 焦点由四条取并集（用户 2026-10-21 确认「围绕玩家」）：
//
//   ① 在场：玩家当前所在地/身边的人
//   ② 提及：玩家这句话里点到的人、物、地
//   ③ 进行中：跨过当前时间点、还在进行中的原著事件
//   ④ 已在档：存档里已建档、且属于原著人物的人
//
//   注意 ③ 用的是「**进行中**」（time_start <= now < time_end），
//   不是「区间内」。这是关键区别：
//     「这三年里发生过」≠「这一刻正在发生」
//   前者是补演要处理的，后者才是指导正文要用的。
// ============================================================

import { parseTimePoint, entrySpan } from './interval.js';
import { parseCharacterTags, eventCodeFromTitle, cleanEventTitle } from './vector-input.js';

/** 焦点来源，用于诊断时说明「为什么这个人进来了」 */
export const CE_FOCUS_SOURCES = {
  onScene: '在场',
  mentioned: '玩家提到',
  ongoing: '正在发生',
  archived: '已有档案',
};

/** 单次指导最多带多少人（**不是截断，是分批的依据**） */
export const CE_FOCUS_MAX_NAMES = 40;

/**
 * 取出所有可匹配的名字键（本名 + 别名）。
 *
 * @param {object} entry 人物条目 { name, aliases }
 * @returns {string[]}
 */
function nameKeys(entry) {
  if (!entry) return [];
  const keys = [];
  const push = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (t) keys.push(t);
  };
  push(entry.name);
  for (const a of Array.isArray(entry.aliases) ? entry.aliases : []) push(a);
  return keys;
}

/**
 * 从一段文字里找出提到了哪些已知名字。
 *
 * 用于「玩家这句话提到谁」和「当前地点在哪」。
 *
 * @param {string} text
 * @param {Array<{name:string, aliases?:string[]}>} known
 * @returns {string[]} 本名列表
 */
export function findMentioned(text, known) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const hits = [];
  for (const entry of Array.isArray(known) ? known : []) {
    const keys = nameKeys(entry);
    if (keys.some(k => s.includes(k))) hits.push(String(entry.name || '').trim());
  }
  // 这里只收集指导候选线索，不能用来判定正文已处理或排除补演。
  return hits.filter(Boolean);
}

/**
 * 取「这一刻正在进行中」的原著事件。
 *
 * 关键区别：**进行中** ≠ **区间内**。
 *   区间内：这三年里发生过的（补演要处理的）
 *   进行中：跨过此刻还没结束的（指导正文要用的）
 *
 * @param {Array<object>} entries 年表
 * @param {string} nowText 当前世界时间
 * @returns {Array<object>}
 */
export function pickOngoingEntries(entries, nowText) {
  const list = Array.isArray(entries) ? entries : [];
  const now = parseTimePoint(nowText);
  if (now === null) return [];

  return list.filter((e) => {
    const span = entrySpan(e);
    if (!span) return false;
    return span.min <= now && now <= span.max;
  });
}

/**
 * 算这一轮的焦点。
 *
 * @param {object} input
 * @param {string} [input.worldTime] 当前世界时间
 * @param {string} [input.playerInput] 玩家这一轮输入
 * @param {Array<object>} [input.timeline] 年表（全量或已裁剪）
 * @param {Array<object>} [input.onScene] 在场人物 [{ name, aliases?, state? }]
 * @param {Array<object>} [input.archived] 已建档的原著人物 [{ name, aliases?, state? }]
 * @param {object} [input.knownPeople] 判定「这个名字是不是原著人物」的名单
 * @param {object} [input.options]
 * @param {number} [input.options.maxNames=40] 超过就分组的依据（不丢人）
 * @returns {{
 *   people: Array<{name:string, sources:string[], state:object|null, isCanon:boolean}>,
 *   events: Array<object>,
 *   overflow: boolean,
 *   groups: number,
 *   reason: string
 * }}
 */
export function resolveTurnFocus(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const maxNames = Number(src.options && src.options.maxNames) > 0
    ? Number(src.options.maxNames)
    : CE_FOCUS_MAX_NAMES;

  /** name → { sources:Set, state } */
  const bucket = new Map();
  const add = (name, source, state) => {
    const n = String(name == null ? '' : name).trim();
    if (!n) return;
    if (!bucket.has(n)) bucket.set(n, { sources: new Set(), state: null });
    const rec = bucket.get(n);
    rec.sources.add(source);
    if (!rec.state && state) rec.state = state;
  };

  // ① 在场
  for (const p of Array.isArray(src.onScene) ? src.onScene : []) {
    add(p && p.name, CE_FOCUS_SOURCES.onScene, p && p.state);
  }

  // ② 玩家提到
  const knownList = [
    ...(Array.isArray(src.onScene) ? src.onScene : []),
    ...(Array.isArray(src.archived) ? src.archived : []),
  ];
  for (const name of findMentioned(src.playerInput, knownList)) {
    add(name, CE_FOCUS_SOURCES.mentioned);
  }

  // ③ 正在进行的原著事件
  const ongoing = pickOngoingEntries(src.timeline, src.worldTime);
  for (const e of ongoing) {
    for (const tag of parseCharacterTags(String(e && e.title || ''))) {
      add(tag.name, CE_FOCUS_SOURCES.ongoing);
    }
  }

  // ④ 已建档的原著人物（这一轮不一定出现，但如果玩家提到或在场就已经在上面了；
  //    这里补的是「已建档但既不在场也没被提」的，用于让模型知道他们此刻的状态）
  for (const p of Array.isArray(src.archived) ? src.archived : []) {
    add(p && p.name, CE_FOCUS_SOURCES.archived, p && p.state);
  }

  const people = [...bucket.entries()].map(([name, rec]) => ({
    name,
    sources: [...rec.sources],
    state: rec.state || null,
    isCanon: isCanonName(name, src.knownPeople),
  }));

  // 超上限不丢人，改成「要分几组」
  const groups = people.length > maxNames ? Math.ceil(people.length / maxNames) : 1;

  return {
    people,
    events: ongoing,
    overflow: people.length > maxNames,
    groups,
    reason: describeFocus(people, ongoing),
  };
}

/**
 * 判断这个名字是不是原著人物。
 *
 * 判据两条，任一成立即可：
 *   ① 内置原著人物名单里有（用户内置的别名表）
 *   ② 年表标题的人物标签里出现过
 *
 * @param {string} name
 * @param {object} knownPeople { canonNames?: Set|Array, aliases?: object }
 * @returns {boolean}
 */
export function isCanonName(name, knownPeople) {
  const n = String(name == null ? '' : name).trim();
  if (!n || !knownPeople || typeof knownPeople !== 'object') return false;
  return hasInKnownList(n, knownPeople);
}

function hasInKnownList(name, known) {
  const canon = known.canonNames;
  if (canon instanceof Set && canon.has(name)) return true;
  if (Array.isArray(canon) && canon.includes(name)) return true;

  const aliases = known.aliases;
  if (aliases && typeof aliases === 'object') {
    if (Object.prototype.hasOwnProperty.call(aliases, name)) return true;
    for (const list of Object.values(aliases)) {
      if (Array.isArray(list) && list.includes(name)) return true;
    }
  }
  return false;
}

/** 一句话说明这轮焦点是怎么来的（写进诊断，玩家能看懂） */
function describeFocus(people, events) {
  const list = Array.isArray(people) ? people : [];
  const evts = Array.isArray(events) ? events : [];
  if (list.length === 0 && evts.length === 0) {
    return '这一轮没有碰到原著的人或事，正文照常写';
  }
  const parts = [];
  if (evts.length > 0) parts.push(`正在发生的原著事件 ${evts.length} 条`);
  if (list.length > 0) parts.push(`相关人物 ${list.length} 人`);
  return parts.join('，');
}

/**
 * 把焦点整理成给正文作者看的材料。
 *
 * **只写这一轮会碰到的**，不写整段时间的年表。
 *
 * @param {object} focus resolveTurnFocus 的产物
 * @param {object} [options]
 * @param {string} [options.playerInput]
 * @param {string} [options.worldTime]
 * @param {string} [options.location]
 * @returns {string}
 */
export function renderFocusMaterial(focus, options = {}) {
  const f = focus && typeof focus === 'object' ? focus : {};
  const people = Array.isArray(f.people) ? f.people : [];
  const events = Array.isArray(f.events) ? f.events : [];

  const lines = [];

  const loc = String(options.location == null ? '' : options.location).trim();
  if (loc) lines.push(`玩家当前位置：${loc}`);
  const now = String(options.worldTime == null ? '' : options.worldTime).trim();
  if (now) lines.push(`当前世界时间：${now}`);
  lines.push('');

  if (events.length > 0) {
    lines.push('### 这一刻原著里正在发生的事');
    for (const e of events) {
      const code = eventCodeFromTitle(String(e && e.title || ''));
      const name = cleanEventTitle(String(e && e.title || ''));
      lines.push(`· ${code}${name ? ` ${name}` : ''}`);
      const brief = String(e && (e.content_brief || e.brief) || '').trim();
      if (brief) lines.push(`  ${brief.slice(0, 300)}`);
    }
    lines.push('');
  }

  if (people.length > 0) {
    lines.push('### 这一轮会碰到的原著人物');
    for (const p of people) {
      const marks = [];
      if (p.isCanon) marks.push('原著人物');
      else marks.push('非原著');
      if (p.sources && p.sources.length > 0) marks.push(p.sources.join('、'));
      lines.push(`· ${p.name}（${marks.join('｜')}）`);
      const st = renderOneState(p.state);
      if (st) lines.push(`  ${st}`);
    }
    lines.push('');
  }

  if (events.length === 0 && people.length === 0) {
    lines.push('（这一轮没有碰到原著的人或事。正文照常写，不必强行塞原著内容。）');
  }

  return lines.join('\n');
}

function renderOneState(state) {
  if (!state || typeof state !== 'object') return '';
  if (state.dead === true || state.status === '已故') return '已故。';
  const parts = [];
  const push = (label, v) => {
    const t = String(v == null ? '' : v).trim();
    if (t) parts.push(`${label}${t}`);
  };
  push('境界', state.cultivation || state.realm);
  push('所在', state.location);
  push('状态', state.status);
  return parts.length > 0 ? parts.join('，') : '';
}
