// 生平经历：把三段拼成一条完整的第 35 列。
//
// ------------------------------------------------------------
// 三个时段，三个出处，不许重叠（这是设计的核心）：
//
//   ① 正文之前那几个月  → 生平旧账（存档 + 原著推力，1 次批量调模型）
//   ② 正文那一刻        → 散文的 @@经历 行（只有它知道这一段发生了什么）
//   ③ 更早的轮次        → 不补，只留一句首次登场标记
//
// 为什么散文那段不能由代码生成：
//   正文写了什么、他怎么过的这一段，代码去正文里抠不准。
//   让散文自己写一行 `@@经历:`，比任何正则都准。
//
// 为什么旧账那段不能让散文写：
//   散文只看到「本轮正文」，它看不到正文之前那几个月。
//   那段的输入是**存档现状 + 原著推力**，正文不能进（时间方向单向）。
// ============================================================

/** 卡里已有的生平压缩阈值：超过它，卡自己会压成 5 条 */
export const CE_BIOGRAPHY_SOFT_LIMIT = 1000;

/**
 * 拼一个人的生平经历。
 *
 * @param {object} input
 * @param {string} [input.name]
 * @param {Array<object>|string[]} [input.backstory] 生平旧账（正文之前那几个月）
 * @param {string} [input.biographyLine] 散文写的 `@@经历` 那一行（正文那一刻）
 * @param {string} [input.firstAppear] 首次登场标记（更早的轮次，只这一句）
 * @returns {string} 已排序、去重、可直接 append 的文本（可能为空串）
 */
export function composeBiography(input) {
  const src = input && typeof input === 'object' ? input : {};

  const rows = [];

  // ① 旧账
  const back = Array.isArray(src.backstory) ? src.backstory : [];
  for (const item of back) {
    const line = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? formatBackstoryRow(item) : '');
    pushLine(rows, line);
  }

  // ③ 首次登场标记（放前面：它是时间最早的）
  //    注意它跟旧账不该同时出现——
  //    有旧账的人说明这一轮他就在场，不是「首次登场」。
  const mark = String(src.firstAppear == null ? '' : src.firstAppear).trim();
  if (mark && rows.length === 0) pushLine(rows, mark);

  // ② 散文这一刻
  pushLine(rows, String(src.biographyLine == null ? '' : src.biographyLine).trim());

  if (rows.length === 0) return '';

  // 按行首时间排序。没有时间的行放最后，别把顺序搞乱。
  rows.sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta && tb) return ta.localeCompare(tb);
    if (ta) return -1;
    if (tb) return 1;
    return 0;
  });

  return rows.join('\n');
}

/**
 * 把旧账对象格式化成一行。
 * 复用 backstory.js 的格式，保持一致。
 *
 * @param {object} row
 * @returns {string}
 */
function formatBackstoryRow(row) {
  const time = String(row.time == null ? '' : row.time).trim();
  const place = String(row.place == null ? '' : row.place).trim();
  const text = String(row.text == null ? '' : row.text).trim();
  if (!text) return '';
  const at = place ? `@${place}` : '';
  const tail = row.fromOriginal ? '（按原著）' : '';
  return `[${time}${at}]${text}${tail}`;
}

/**
 * 收一行，空的和重复的不要。
 *
 * @param {string[]} rows
 * @param {string} line
 */
function pushLine(rows, line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return;
  // 可能是多行（旧账一次给几条），拆开
  for (const one of t.split(/\r?\n/)) {
    const s = one.trim();
    if (!s) continue;
    if (rows.includes(s)) continue;
    rows.push(s);
  }
}

/**
 * 从 `[0013年05月@神手谷]xxx` 里取时间，用来排序。
 *
 * @param {string} line
 * @returns {string} 空串表示没有时间
 */
function timeOf(line) {
  const m = String(line == null ? '' : line).match(/^\[([^\]]+)\]/);
  if (!m) return '';
  // 取 @ 之前那段
  return m[1].split('@')[0].trim();
}

/**
 * 判断这份生平是不是该交给卡去压缩了。
 *
 * 卡里已有机制：超 1000 字压成 5 条。
 * 这里只负责**提醒**，压缩本身不在这里做——
 * 卡内机制会把格式压坏的情况处理得比我们好。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function needsCompress(text) {
  return String(text == null ? '' : text).length > CE_BIOGRAPHY_SOFT_LIMIT;
}

/**
 * 从散文结果里捡出每个人的 @@经历 行。
 *
 * @param {Array<object>} proseResults settleProseResults 的产物
 * @returns {object} name -> 那一行
 */
export function collectProseBiography(proseResults) {
  const list = Array.isArray(proseResults) ? proseResults : [];
  const out = {};
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim();
    if (!name) continue;
    const line = String(r.biographyLine || '').trim();
    if (!line) continue;
    out[name] = line;
  }
  return out;
}
