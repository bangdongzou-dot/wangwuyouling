// ============================================================
// C3 · 区间与完成集（纯函数，不依赖模型，不依赖宿主）
//
// 设计依据（总设计 §4.3）：
//   时间单调递增 ⇒ 完成集是 worldTime 的纯函数。
//   已完成 = { e : e.time_end   <= worldTime }
//   进行中 = { e : e.time_start <= worldTime < e.time_end }
//   未来   = { e : e.time_start >  worldTime }
//
// 为什么不能用前缀压缩（实测数据，总设计 §4.3.3）：
//   按编号顺序 time_start 有 46 次回退、time_end 有 54 次回退；
//   同一时刻最多 17 条并行；0150 年那一刻前缀压缩会误标 35 条。
//   ⇒ 禁止用 E-001~E-050 这种区间表示完成集。
// ============================================================

/** 年表时间点精度（由粗到细） */
export const CE_TIME_PRECISION = ['year', 'month', 'day', 'hour', 'minute'];

/** Optional in-day reference window. It never proves occurrence. */
export function normalizeNodeTiming(value) {
  if (!value || typeof value !== 'object') return null;
  const {from, to=from, basis}=value;
  const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if(typeof from!=='string'||typeof to!=='string'||!clock.test(from)||!clock.test(to)||
    from>to||typeof basis!=='string'||!basis.trim())return null;
  return {from,to,basis:basis.trim()};
}

export function nodeTimingWindow(day,timing) {
  const clock=normalizeNodeTiming(timing);
  if(!clock||!/^\d{4}\.\d{2}\.\d{2}$/u.test(day))return null;
  const min=parseTimePoint(day+' '+clock.from),max=parseTimePoint(day+' '+clock.to);
  return min===null||max===null?null:{min,max};
}

/**
 * 把 'YYYY' / 'YYYY.MM' / 'YYYY.MM.DD' / 'YYYY.MM.DD HH:mm' 解析成可比较的整数序号。
 * 采用定长进位，保证跨精度比较单调：
 *   minute = ((year * 12 + month) * 31 + day) * 24 * 60 + hour * 60 + minute
 *
 * 缺省填充：月=1、日=1、时=0、分=0。
 * 注意：月按 12 进位、日按 31 进位（不按真实历法），
 * 因为年表只要求「先后可比」，不要求真实日期运算。
 *
 * @param {string} text
 * @returns {number|null} 不可解析时返回 null
 */
export function parseTimePoint(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  // 存档与年表的时间写法不统一，这里都要吃下：
  //   '0010.04'                 年表
  //   '0010.04.05'              年表
  //   '0010年04月05日 14:30'    一种写法
  //   '0010年 04月 01日 08:15'  目标前端 TIME_LOCATION_ROW 的真实写法（**带空格**）
  //
  // 关键点：先把「年月日时分」之间的空白全部去掉再切分。
  // 否则 '0010年 04月 01日 08:15' 会变成 '0010. 04. 01 08:15'，
  // 正则的 \d{1,2} 匹配不上空格，月和日被当成缺失，
  // 整条时间塌缩成「0010年1月1日0点」——相差好几个月，
  // 原著指导就会定位到错误的年表事件上去。
  const normalized = raw
    .replace(/(\d)\s*年\s*/g, '$1.')
    .replace(/(\d)\s*月\s*/g, '$1.')
    .replace(/(\d)\s*日\s*/g, '$1 ')
    .replace(/[./]/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/\.\s+/g, '.')
    .replace(/\s+\./g, '.')
    .trim();

  const m = normalized.match(/^(\d+)(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?(?:\s*(\d{1,2}):(\d{1,2}))?/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = m[2] === undefined ? 1 : Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);

  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(year*12*31*24*60)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  return (((year * 12 + (month - 1)) * 31 + (day - 1)) * 24 + hour) * 60 + minute;
}

/**
 * 解析时间点的精度（用于判断「锚点是否精确到日」这类问题）。
 * @param {string} text
 * @returns {'year'|'month'|'day'|'hour'|'minute'|null}
 */
export function parseTimePrecision(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  if (/\d{1,2}:\d{1,2}/.test(raw)) return 'minute';
  const hasHour = /\d{1,2}\s*[时点]|\b\d{1,2}:\d{2}\b/.test(raw);
  if (hasHour) return 'hour';
  if (/日/.test(raw)) return 'day';
  if (/月/.test(raw)) return 'month';
  if (/\./.test(raw)) {
    const parts = raw.split('.');
    if (parts.length >= 4) return 'hour';
    if (parts.length === 3) return 'day';
    if (parts.length === 2) return 'month';
  }
  return 'year';
}

/**
 * 取条目的时间跨度（min/max 均为可比较序号）。
 * 起止倒置时自动纠正（年表存在 time_start > time_end 的旧条目）。
 *
 * @param {{time_start?:string, time_end?:string}} entry
 * @returns {{min:number,max:number}|null}
 */
export function entrySpan(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const start = parseTimePoint(entry.time_start !== undefined ? entry.time_start : entry.year_start);
  const end = parseTimePoint(entry.time_end !== undefined ? entry.time_end : entry.year_end);
  if (start === null && end === null) return null;
  const a = start === null ? end : start;
  const endText=entry.time_end !== undefined ? entry.time_end : entry.year_end;
  const precision=parseTimePrecision(endText);
  const extra=precision==='year'?12*31*24*60-1:precision==='month'?31*24*60-1:precision==='day'?24*60-1:precision==='hour'?59:0;
  const b = end === null ? start : end+extra;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * 计算完成集 / 进行中 / 未来。**全部现算，不持久化。**
 *
 * @param {Array<object>} entries 年表条目
 * @param {string} worldTimeText 世界时间
 * @returns {{completed:Array, inProgress:Array, future:Array, unknown:Array, worldTimeIndex:number|null}}
 */
export function classifyEntries(entries, worldTimeText) {
  const list = Array.isArray(entries) ? entries : [];
  const now = parseTimePoint(worldTimeText);

  const completed = [];
  const inProgress = [];
  const future = [];
  const unknown = [];

  if (now === null) {
    // 世界时间不可解析时，不猜测：全部归入 unknown，由调用方决定降级策略。
    return { completed, inProgress, future, unknown: list.slice(), worldTimeIndex: null };
  }

  for (const entry of list) {
    const span = entrySpan(entry);
    if (!span) {
      unknown.push(entry);
      continue;
    }
    if (span.max <= now) {
      completed.push(entry);
    } else if (span.min <= now && now < span.max) {
      inProgress.push(entry);
    } else if (span.min > now) {
      future.push(entry);
    } else {
      // span.min <= now 且 now < span.max 之外的边界：span.min <= now 且 span.max > now 已被上面覆盖
      unknown.push(entry);
    }
  }

  return { completed, inProgress, future, unknown, worldTimeIndex: now };
}

/**
 * 区间相交筛选。
 * 区间 [startText, endText] 与条目 [min,max] 相交即入选。
 *
 * @param {Array<object>} entries
 * @param {string} startText
 * @param {string} endText
 * @returns {Array<object>} 保持原顺序
 */
export function entriesInRange(entries, startText, endText) {
  const list = Array.isArray(entries) ? entries : [];
  const start = parseTimePoint(startText);
  const end = parseTimePoint(endText);
  if (start === null || end === null) {
    throw new Error(`区间格式无效：${startText} → ${endText}`);
  }
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  return list.filter((entry) => {
    const span = entrySpan(entry);
    if (!span) return false;
    return !(span.max < lo || span.min > hi);
  });
}

/**
 * 把欠账区间并入本轮区间（总设计 §4.3.5）。
 *
 * 欠账记的是时间区间，不是事件列表；具体事件现算。
 *
 * @param {{start:string, end:string}} turnRange 本轮区间
 * @param {Array<{from:string,to:string}>} debts 欠账
 * @returns {{start:string, end:string, mergedDebts:Array, applied:boolean}}
 */
export function mergeDebtsIntoRange(turnRange, debts) {
  const range = turnRange || {};
  let start = range.start;
  let end = range.end;
  const startIdx = parseTimePoint(start);
  const endIdx = parseTimePoint(end);

  const list = Array.isArray(debts) ? debts : [];
  const mergedDebts = [];
  let applied = false;

  if (startIdx === null || endIdx === null) {
    return { start, end, mergedDebts, applied: false };
  }

  let lo = Math.min(startIdx, endIdx);
  let hi = Math.max(startIdx, endIdx);
  let loText = lo <= startIdx ? start : end;
  let hiText = hi >= endIdx ? end : start;

  for (const debt of list) {
    const dFrom = parseTimePoint(debt && debt.from);
    const dTo = parseTimePoint(debt && debt.to);
    if (dFrom === null && dTo === null) continue;

    const dLo = dFrom === null ? dTo : dFrom;
    const dHi = dTo === null ? dFrom : dTo;
    const dMin = Math.min(dLo, dHi);
    const dMax = Math.max(dLo, dHi);

    // 欠账区间与当前区间有交集才合并；完全在过去且未覆盖则整体扩展
    if (dMin < lo) {
      lo = dMin;
      loText = String(debt.from || debt.to || '').trim() || loText;
      applied = true;
    }
    if (dMax > hi) {
      hi = dMax;
      hiText = String(debt.to || debt.from || '').trim() || hiText;
      applied = true;
    }
    mergedDebts.push(debt);
  }

  return {
    start: loText,
    end: hiText,
    mergedDebts,
    applied,
  };
}

/**
 * 事件码排序比较器（支持 E-670.5 这种小数插号）。
 * 注意：这是**叙事顺序**，不是时间顺序。不要用它判断完成集。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareEventCode(a, b) {
  const pa = parseEventCode(a);
  const pb = parseEventCode(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa - pb;
}

/**
 * 把 'E-670.5' 转成可比较数值 670.5。
 * @param {string} code
 * @returns {number|null}
 */
export function parseEventCode(code) {
  const m = String(code == null ? '' : code).match(/E-(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// The world's clock can predate canon. Only the replay window is clipped.
export function canonReplayRange(turnRange, debts, timeline) {
  const range = mergeDebtsIntoRange(turnRange, debts);
  let first = null, firstText = '';
  for (const row of timeline || []) {
    const value = row.time_start ?? row.year_start ?? row.time_end ?? row.year_end;
    const at = parseTimePoint(value);
    if (at !== null && (first === null || at < first)) { first = at; firstText = String(value); }
  }
  const start = parseTimePoint(range.start), end = parseTimePoint(range.end);
  if (first === null || start === null || end === null) return range;
  if (end < first) return { ...range, beforeTimeline: true };
  return start < first ? { ...range, start: firstText } : range;
}
