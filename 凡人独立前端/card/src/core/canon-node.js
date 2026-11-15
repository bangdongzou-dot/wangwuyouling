// ============================================================
// 当前原著节点：这一刻世界线卡在哪一个年表事件上
//
// 用户 2026-10-21（看过原版源码后的纠正，这是最终口径）：
//   「原著指导只针对当前发生的这个年表事件而已」
//
// 原版的做法（service.ts:593-599）：
//   用向量检索挑出**少数几条候选**（maxCandidateEntries），
//   让模型判断「当前世界线卡在哪个 E-### 事件（之前/之中/之后）」，
//   并且区分「前置背景 / 当前命中 / 后置伏笔」。
//
//   **不是**把区间内所有事件都端出来，也**不是**按时间区间筛。
//
// ------------------------------------------------------------
// 三条硬规矩（全部来自原版源码，逐条抄的）：
//
//   ① 判断能不能引入，看存档事实有没有让它不可能，
//      **不看原著日期过没过**（service.ts:1365）
//
//   ② 世界线定位只能依据人物、地点、婚约、到访、已发生/未发生
//      等**事实锚点**；禁止把存档日期与原著年表日期做换算（1361-1373）
//
//   ③ 原著时序上该发生但还没发生的桥段，**不算已被改写**（1363-1366）
// ============================================================

import { parseTimePoint, entrySpan, parseEventCode } from './interval.js';
import { eventCodeFromTitle, cleanEventTitle, parseCharacterTags } from './vector-input.js';

/** 当前节点相对世界线的位置 */
export const CE_NODE_POSITION = {
  /** 这个事件还没开始 */
  before: '之前',
  /** 正卡在这个事件中间 */
  during: '之中',
  /** 这个事件已经过去了 */
  after: '之后',
};

/**
 * 取候选事件：这一刻最相关的少数几条。
 *
 * 用**时间位置 + 玩家输入相关性**挑，不用区间扫全量。
 *
 * 挑法（对应原版 limitTimelineEntriesForInjection）：
 *   ① 覆盖当前时间点的事件（正在进行）——最优先
 *   ② 刚过去不久的（给「前置背景」）
 *   ③ 马上要来的（给「后置伏笔」）
 *
 * @param {object} input
 * @param {Array<object>} input.timeline 年表
 * @param {string} input.worldTime 当前世界时间
 * @param {string} [input.playerInput] 玩家输入（用来提相关性）
 * @param {number} [input.maxCandidates=6] 最多几条候选
 * @returns {Array<{entry:object, position:string, code:string, title:string, span:object}>}
 */
export function pickNodeCandidates(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(src.timeline) ? src.timeline : [];
  const now = parseTimePoint(src.worldTime);
  const max = Number(src.maxCandidates) > 0 ? Number(src.maxCandidates) : 6;

  if (now === null) return [];

  const during = [];
  const before = [];
  const after = [];

  for (const entry of list) {
    const span = entrySpan(entry);
    if (!span) continue;
    const item = {
      entry,
      code: eventCodeFromTitle(String(entry && entry.title || '')),
      title: cleanEventTitle(String(entry && entry.title || '')),
      span,
      position: '',
    };

    if (span.min <= now && now <= span.max) {
      item.position = CE_NODE_POSITION.during;
      during.push(item);
    } else if (span.min > now) {
      item.position = CE_NODE_POSITION.before;
      before.push(item);
    } else {
      item.position = CE_NODE_POSITION.after;
      after.push(item);
    }
  }

  // 正在进行的最优先；其次是最近的将来（后置伏笔）；再次是刚过去的（前置背景）
  before.sort((a, b) => a.span.min - b.span.min);
  after.sort((a, b) => b.span.max - a.span.max);

  const ordered = [...during, ...before, ...after];

  // 相关性重排。两路输入合起来算，不再各排一遍：
  //
  //   ① 玩家这句话里点到的人（原来就有）
  //   ② 焦点名单里的人、事（turn-focus 算出来的）
  //
  // ② 是 ① 的超集——焦点里的「玩家提到的」就是 ①，
  // 另外还多了「在场的」「正在进行的」「已建档的」。
  // 所以这里用同一个权重函数，把 ② 的名字并进去一起算，
  // 而不是先按 ① 排一遍、再按 ② 排一遍（那样后一次会盖掉前一次）。
  const mentioned = new Set(extractMentionedNames(src.playerInput));

  const focus = src.focus && typeof src.focus === 'object' ? src.focus : null;
  if (focus) {
    for (const p of Array.isArray(focus.people) ? focus.people : []) {
      const n = String(p && p.name || '').trim();
      if (n) mentioned.add(n);
    }
  }

  if (mentioned.size > 0) {
    ordered.sort((a, b) => {
      const sa = relevance(a.entry, mentioned);
      const sb = relevance(b.entry, mentioned);
      if (sa !== sb) return sb - sa;
      return 0;
    });
  }

  return ordered.slice(0, max);
}

/** 从玩家输入里抓可能的人名（2-4 字中文片段，够用即可） */
function extractMentionedNames(text) {
  const s = String(text == null ? '' : text);
  const out = new Set();
  // 不猜分词，只把「看起来像人名」的连续汉字抓出来做包含判断
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,4}/g)) out.add(m[0]);
  return out;
}

/** 这条事件跟玩家输入的相关度 */
function relevance(entry, mentioned) {
  const title = String(entry && entry.title || '');
  const brief = String(entry && (entry.content_brief || entry.brief) || '');
  let score = 0;
  for (const name of mentioned) {
    if (title.includes(name)) score += 2;
    if (brief.includes(name)) score += 1;
  }
  return score;
}

/**
 * 判断「这一刻世界线卡在哪」。
 *
 * 优先「正在进行中」的那条；没有正在进行的就是最近的下一条。
 *
 * @param {Array} candidates pickNodeCandidates 的产物
 * @returns {object|null}
 */
export function resolveCurrentNode(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return null;

  const during = list.filter((c) => c.position === CE_NODE_POSITION.during);
  if (during.length > 0) return during[0];

  const upcoming = list.filter((c) => c.position === CE_NODE_POSITION.before);
  if (upcoming.length > 0) return upcoming[0];

  return list[0];
}

/**
 * 判断一个原著桥段**能不能**引入。
 *
 * 原版铁律（service.ts:1365）：
 *   判断依据是**存档事实有没有让它不可能**，
 *   不是原著日期过没过，也不是原著主角叙事位是否被占。
 *
 * @param {object} input
 * @param {Array<object>} [input.blockers] 已死的、已离开的人 [{ name, dead, left }]
 * @param {Array<string>} [input.names] 这条桥段涉及的人
 * @returns {{introducible:boolean, reason:string}}
 */
export function canIntroduce(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const names = Array.isArray(src.names) ? src.names.filter(Boolean) : [];
  const blockers = Array.isArray(src.blockers) ? src.blockers : [];

  if (names.length === 0) {
    return { introducible: true, reason: '没有指定主体，按可引入处理' };
  }

  const dead = blockers.filter((b) => b && b.dead === true && names.includes(b.name));
  if (dead.length > 0 && dead.length === names.length) {
    return {
      introducible: false,
      reason: `涉及的人已全部不在：${dead.map((d) => d.name).join('、')}`,
    };
  }

  return { introducible: true, reason: '' };
}

/**
 * 组装给模型的「当前节点」材料。
 *
 * 给的是：当前卡在哪、之前发生过什么、之后还有什么。
 * 这三样正好对应原版的「前置背景 / 当前命中 / 后置伏笔」。
 *
 * @param {object} input
 * @param {object} [input.node] resolveCurrentNode 的产物
 * @param {Array} [input.candidates] 全部候选
 * @param {string} [input.worldTime]
 * @param {string} [input.location]
 * @param {string} [input.playerInput]
 * @param {Array} [input.onScene] 在场人物
 * @returns {string}
 */
export function renderNodeMaterial(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const node = src.node;
  const candidates = Array.isArray(src.candidates) ? src.candidates : [];

  const lines = [];

  if (src.worldTime) lines.push(`当前世界时间：${src.worldTime}`);
  if (src.location) lines.push(`玩家当前位置：${src.location}`);
  lines.push('');

  if (src.playerInput) {
    lines.push('## 玩家这一轮想做什么');
    lines.push(String(src.playerInput).trim());
    lines.push('');
  }

  if (!node) {
    lines.push('## 当前原著节点');
    lines.push('（这一刻没有落到任何一条年表事件上。）');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`## 当前原著候选节点：${node.code || '（无编号）'} ${node.title || ''}（按年表日期：${node.position}；实际进度须核对存档事实）`);
  const brief = String(node.entry && (node.entry.content_brief || node.entry.brief) || '').trim();
  if (brief) lines.push(brief);
  const original = String(node.entry && (node.entry.content_original || node.entry.original) || '').trim();
  if (original && node.position === CE_NODE_POSITION.during) {
    lines.push('### 当前事件原著原文（用于细节与条件判断，不代表结局已发生）');
    lines.push(original);
    lines.push('本轮只承接事实锚点所处的一小步；后段结局不得提前兑现，玩家既有事实优先。');
  }
  lines.push('');

  // 前置背景
  const prev = candidates.filter((c) => c.position === CE_NODE_POSITION.after).slice(0, 2);
  if (prev.length > 0) {
    lines.push('### 前置背景候选（年表日期已过，不代表本存档已经发生；须核对既定事实）');
    for (const c of prev) {
      lines.push(`· ${c.code} ${c.title}：${String(c.entry && (c.entry.content_brief || c.entry.brief) || '').slice(0,800)}`);
    }
    lines.push('');
  }

  // 后置伏笔
  const next = candidates.filter((c) => c.position === CE_NODE_POSITION.before).slice(0, 2);
  if (next.length > 0) {
    lines.push('### 后置伏笔（还没到，不许提前结算）');
    for (const c of next) {
      lines.push(`· ${c.code} ${c.title}：${String(c.entry && (c.entry.content_brief || c.entry.brief) || '').slice(0,800)}`);
    }
    lines.push('');
  }

  // 在场人物
  const onScene = Array.isArray(src.onScene) ? src.onScene : [];
  if (onScene.length > 0) {
    lines.push('### 玩家身边现在的人');
    for (const p of onScene) {
      const name = String(p && p.name || '').trim();
      if (!name) continue;
      const st = p && p.state && typeof p.state === 'object' ? p.state : null;
      const dead = st && (st.dead === true || st.status === '已故');
      const bits = [];
      if (dead) bits.push('已故');
      else {
        if (st && st.cultivation) bits.push(`境界${st.cultivation}`);
        if (st && st.location) bits.push(`在${st.location}`);
      }
      lines.push(`· ${name}${bits.length ? `（${bits.join('，')}）` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
