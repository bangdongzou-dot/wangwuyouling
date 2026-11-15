// 天花板：这一轮的散文不许把下一轮的额度提前花掉。
//
// ------------------------------------------------------------
// 问题（用户 2026-10-21 的「走廊壁」）：
//
//   本轮年表：董萱儿炼气四层
//   下轮年表：董萱儿炼气六层
//   本轮正文：没写她修炼
//
//   → 散文心想「反正下轮要六层，我干脆这轮写她突破到六层」
//   → 下一轮的额度被这轮提前花掉了
//
//   等真走到那一步，已经没有额度可花了，整条时间线被自己吃掉。
//
// ------------------------------------------------------------
// 分工（用户当天提醒过的原则）：
//
//   **代码只做百分百确定的事**：找「这个人下一次出现在哪条年表」，
//   这是字符串比对，不会错。
//
//   **「那条里他是什么状态」需要读中文、需要理解剧情** → 交给模型，
//   代码不猜。
//
//   所以这个模块产出的是**材料**（下一个事件的原文 + 现在状态），
//   不是一个「上限 = 炼气六层」的判决。
// ============================================================

/** 给模型的天花板材料最多多少字（下个事件的 brief 可能很长） */
import {parseTimePoint} from './interval.js';
export const CE_CEILING_MATERIAL_CHARS = 1200;

/**
 * 从年表里找这个人**下一次**出现的事件。
 *
 * 纯字符串比对：标题里带人名，就算出现。
 * 不做语义判断——「提到」和「在场」的区分留给模型。
 *
 * @param {Array<object>} timeline 全部年表条目（按时序）
 * @param {string} name 人名
 * @param {string} afterTime 只找这个时间点之后的
 * @returns {object|null}
 */
export function findNextAppearance(timeline, name, afterTime) {
  const who = String(name == null ? '' : name).trim();
  if (!who) return null;

  const list = Array.isArray(timeline) ? timeline : [];
  const after = String(afterTime == null ? '' : afterTime).trim();

  const afterPoint=parseTimePoint(after);
  for (const entry of list.slice().sort((a,b)=>(parseTimePoint(a.time_start || a.time)||0)-(parseTimePoint(b.time_start || b.time)||0))) {
    const title = String(entry.title || '');
    if (!title.includes(who)) continue;

    // 只要「这一轮之后」的。当前轮的已经用过了。
    const start = String(entry.time_start || entry.time || '').trim();
    const point=parseTimePoint(start);
    if(point===null || afterPoint!==null && point<=afterPoint)continue;

    return entry;
  }
  return null;
}

/**
 * 把「下一次出现」压成给散文看的天花板材料。
 *
 * 为什么给原文而不给结论：
 * 「他下一条里是什么状态」要读剧情才判得出来。
 * 代码强行抽一个数字出来，抽错了比不给还糟。
 *
 * @param {object|null} nextEntry
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {number} [options.maxChars]
 * @returns {string} 空串表示没有天花板（最后一轮，或原著没再提到他）
 */
export function renderCeiling(nextEntry, options = {}) {
  if (!nextEntry || typeof nextEntry !== 'object') return '';

  const name = String(options.name == null ? '' : options.name).trim();
  const max = Number(options.maxChars) > 0
    ? Number(options.maxChars) : CE_CEILING_MATERIAL_CHARS;

  const when = String(nextEntry.time_start || nextEntry.time || '').trim();
  const raw = String(
    nextEntry.content_brief || nextEntry.content_original || nextEntry.title || '',
  ).trim();

  if (!raw) return '';

  let body = raw;
  if (body.length > max) body = `${body.slice(0, max)}…\n（后续材料已按预算截断；未显示内容不得自行推断境界或豁免。）`;

  const lines = [
    `原著下一次提到${name || '他'}是 ${when || '（时间不详）'}：`,
    body,
    '',
    '【条件性走廊参考材料，不是无条件成长上限】先结合轮前真实状态、当前阶段及本轮已确认外力，语义判断下条材料是否描述本人当期真实境界。',
    '走廊壁：在该事件时间点之前，没有明确且足以改变本人修炼节奏或进度的外力，不许超过该事件实际描述的本人境界。普通日常不是突破上限的外力。',
    '只从本人在该时段的真实设定判断上限；回忆、幻境、假设或他人的境界不能冒充本人当期境界。外力例外必须有已确认事实依据，不得为升级自造机缘。',
    '未来资料未知不代表禁止成长；保留已有合法修炼进度和境界内自然进展，不按经过天数比例增加修为。只放开被实际外力打破的约束，其他未被打破的约束继续有效。',
  ];

  return lines.join('\n');
}

/**
 * 判断散文写出来的状态有没有「越过」天花板——这件事**不在这里做**。
 *
 * 为什么不做：
 *   「炼气六层 vs 四层」看着能比，但「重伤将死 vs 修为大进」比不了。
 *   写个比较函数，只会在能比的地方对、不能比的地方错，
 *   而错的那部分恰恰是最需要判断的部分。
 *
 * 所以天花板**做成材料给散文看**，由它自己守着。
 * 模型犯规的时候，下一轮的年表会把它拉回来——年表是硬约束。
 *
 * 这个函数只是为了把「为什么不判」写进代码里，让下一个人别再加判断。
 *
 * @returns {null}
 */
export function compareAgainstCeiling() {
  return null;
}

/**
 * 批量给每个建档的人配天花板材料。
 *
 * @param {object} input
 * @param {Array<object>} input.actors 建档的人
 * @param {Array<object>} input.timeline 全量年表
 * @param {string} input.afterTime 只找这之后的
 * @param {number} [input.maxChars]
 * @returns {object} name -> 天花板材料（没材料的人不出现）
 */
export function buildCeilings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const actors = Array.isArray(src.actors) ? src.actors : [];
  const timeline = Array.isArray(src.timeline) ? src.timeline : [];

  const out = {};
  for (const a of actors) {
    const name = String((a && a.name) || '').trim();
    if (!name) continue;
    const next = findNextAppearance(timeline, name, src.afterTime);
    if (!next) continue;
    const text = renderCeiling(next, { name, maxChars: src.maxChars });
    if (text) {
      out[name] = {
        text,
        when: String(next.time_start || next.time || '').trim(),
        title: String(next.title || '').trim(),
      };
    }
  }
  return out;
}
