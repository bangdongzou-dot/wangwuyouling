// ============================================================
// 生平旧账：这一轮时间区间里，那些**已经过去**的原著事
//
// ------------------------------------------------------------
// 用户 2026-10-21 把问题一句话说穿了：
//
//   「这个问题的本质难点就在于怎么处理，在上一轮或者更早轮次
//     就已经出现的玩家的行为造成的对应npc的原著行为偏差
//     导致的本轮历史经历推演问题，对吧？」
//
// 也就是说：年表记的是「如果玩家没出现，他会怎么过这段时间」。
// 但玩家的行为在前几轮已经改了他的处境，年表那条现在可能不成立了。
//
// ------------------------------------------------------------
// 关键：**时间方向是单向的**
//
//   正文发生在本轮区间的**终点**。
//   那之前几个月的经历，正文改不了它——那时候正文还没发生。
//
// 所以这一步的输入只有两样：
//
//   存档现状（前几轮一路攒下来的结果） + 原著推力
//
//   **正文不进这个输入。** 用户 2026-10-21：
//   「存档现状 + 原著推力 才对，正文是当前进行时刻发生的事情，
//     他怎么会影响历史呢？」
//
// ------------------------------------------------------------
// 三个时段，三个出处，不许重叠：
//
//   ① 正文之前那几个月   → **这里**（生平旧账）
//   ② 正文那一刻（终点） → 散文解析（写出来才知道实际发生了什么）
//   ③ 更早的轮次         → 不补，只留一个首次登场标记
//
// 两段拼成一条完整生平。
//
// ------------------------------------------------------------
// 为什么要调模型：绝大多数人答案就是年表原样（前几轮没人动过他），
// 只有被玩家改过的才需要推。所以**一次批量调用所有人**，不是每人一次。
// ============================================================

import { normalizeBiographyTime } from './actor-state.js';

/** 批量处理的单批人数上限（太多会拖长输出、也容易漏行） */
export const CE_BACKSTORY_BATCH = 12;

/** 每条经历的字数上限，对齐卡内已有的生平行长度 */
export const CE_BACKSTORY_MAX_CHARS = 80;

/** 首次登场标记的文案（窗口外不补，只留这一句） */
export const CE_FIRST_APPEAR_NOTE = '首次建档；此前实际经历尚未核实，不据原著默认补成事实';

/**
 * 这一步产出的一行。
 *
 * @typedef {object} BackstoryLine
 * @property {string} name
 * @property {string} time   规范化后的时间，如 `0013年05月`
 * @property {string} text   做了什么
 * @property {string} [place] 地点
 * @property {boolean} [fromOriginal] 模型没推出来、按年表原样记的（要标出来）
 */

/**
 * 把一行拼成第 35 列要的格式：`[0013年05月@神手谷]赴约见韩立`
 *
 * @param {BackstoryLine|object} line
 * @returns {string}
 */
export function formatBackstoryLine(line) {
  const l = line && typeof line === 'object' ? line : {};
  const time = String(l.time || '').trim() || '未知时间';
  const place = String(l.place || '').trim();
  let what = String(l.text || '').trim();
  if (!what) return '';
  if (what.length > CE_BACKSTORY_MAX_CHARS) {
    what = `${what.slice(0, CE_BACKSTORY_MAX_CHARS)}…`;
  }
  const head = place ? `[${time}@${place}]` : `[${time}]`;
  const mark = l.fromOriginal ? '（按原著）' : '';
  return `${head}${what}${mark}`;
}

/**
 * 从年表事件里抠一个地点（「XX谷」「XX门」这类），抠不到返回空。
 *
 * @param {string} brief
 * @returns {string}
 */
export function placeFromBrief(brief) {
  const text = String(brief == null ? '' : brief);
  if (!text) return '';
  const m = text.match(/[\u4e00-\u9fa5]{2,6}(?:谷|门|派|宗|城|镇|村|府|山|洞|殿|阁|坊|州|郡|国)/);
  return m ? m[0] : '';
}

/**
 * 取第一句，去掉后面的铺陈（生平一行只装得下一件事）。
 *
 * @param {string} text
 * @returns {string}
 */
export function firstSentenceOf(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const m = t.match(/^[^。！？!?；;]{1,200}/);
  return (m ? m[0] : t).trim();
}

/**
 * 兜底：按年表原样拼出这个人的经历（模型没跑通时用）。
 *
 * 这是**降级路径**，不是主路径。拼出来的会带「（按原著）」标记，
 * 让玩家一眼看出这不是推出来的实际版本。
 *
 * @param {object} actor { name, events }
 * @param {object} [options]
 * @returns {BackstoryLine[]}
 */
export function fallbackBackstory(actor, options = {}) {
  const a = actor && typeof actor === 'object' ? actor : {};
  const fallbackPlace = String(options.location || '').trim();
  const events = (Array.isArray(a.events) ? a.events.slice() : [])
    .sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));

  const out = [];
  for (const e of events) {
    const text = firstSentenceOf(e && e.brief) || String(e && e.title || '').trim();
    if (!text) continue;
    out.push({
      name: String(a.name || '').trim(),
      time: normalizeBiographyTime(e && e.time),
      place: placeFromBrief(e && e.brief) || fallbackPlace,
      text,
      fromOriginal: true,
    });
  }
  return out;
}

/**
 * 拼「生平旧账」这一步的提示词内容。
 *
 * 输入只有两样：**存档现状 + 原著推力**。正文不在里面。
 *
 * @param {Array<object>} rows 每行 { name, stateText, events:[{time,title,brief}] }
 * @param {object} [options]
 * @param {string} [options.template] 可自定义的提示词
 * @param {string} [options.turnStart] 区间起点
 * @param {string} [options.turnEnd] 区间终点
 * @returns {string}
 */
export function buildBackstoryPrompt(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const tpl = String(options.template || '').trim();
  if (tpl) {
    // 调用方给了自定义模板：只替换两个变量，别的原样
    return tpl
      .replace(/\{\{区间\}\}/g, turnRangeText(options))
      .replace(/\{\{人物表\}\}/g, renderRows(list)) + '\n\n' + (tpl.includes('{{人物表}}') ? '' : renderRows(list)) + '\n\n' + backstoryOwnership();
  }
  // 谁的历史时点状态没取到
  const missing = list
    .filter((r) => r && r.stateMissing)
    .map((r) => String(r.name || '').trim())
    .filter(Boolean);

  return [
    '你在补写一批人的**过往经历**。',
    '',
    '这些人都在《凡人修仙传》的年表里，下面给你两样东西：',
    '',
    '**① 他现在什么样**——存档里的既定事实。',
    '  这是前几轮一路攒下来的结果：他可能已经被玩家杀了、被关起来了、',
    '  被提前带走了。按这个算，不按原著算。',
    '',
    '**② 原著里他这段时间本该做什么**——一条一条列着。',
    '  注意：这是「如果玩家没出现，他会怎么过」。玩家出现过了，所以它可能不成立。',
    '',
    `时间区间：${turnRangeText(options)}`,
    '',
    '---',
    '',
    renderRows(list),
    '',
    // 状态缺失必须明说。
    //
    // 这几个人读不到「正文之前那一刻」的存档，
    // 只能按年表材料保守写。**绝不拿正文之后的状态顶上**——
    // 那正是「终点状态污染历史」。
    missing.length > 0
      ? [
          '',
          '**注意：下面这些人没有可用的「他现在什么样」**',
          `  ${missing.join('、')}`,
          '  对这几个人只按上面的原著材料保守写，**不要假设他们当时还活着、',
          '  还没突破、东西还在手上**。拿不准就写「未能确认」，',
          '  不要编一个看起来完整的经历。',
        ].join('\n')
      : '',
    '',
    '---',
    '',
    '## 你要做什么',
    '',
    '对每个人，逐条看他的原著事，判断**这件事按他现在的处境还成不成立**，',
    '给出他**实际**做了什么的经历。',
    '',
    '四种情况：',
    '',
    '1. **还能成**——照原著走，就用原句改写成经历。',
    '2. **变了样**——事还是发生了，但形式变了。写变了之后的版本。',
    '3. **打折扣**——只成了一半。写成了的那一半。',
    '4. **成不了**——他被杀、被关、被带走，这事根本没发生。',
    '   那就写他实际干了什么，或者写「未能成行」之类。',
    '   **绝对不要**把一件成不了的事写成发生了。',
    '',
    '## 硬规矩',
    '',
    '- **只看「他现在什么样」和原著事。不要猜后面会发生什么，也不要看本轮正文。**',
    '  你要写的是**已经过去的那几个月**，那时候本轮正文还没发生。',
    '- **已经死的人**：他的经历只能写到死之前。死后的原著事一律作废，写「已故，此后无经历」或干脆不写。',
    '- **一条原著事写一行。** 时间和地点尽量照抄我给的原著那条，改的是「做了什么」。',
    '- **不要编原著里没有的事。** 这个人这段时间没有原著记录，就不要给他加戏。',
    backstoryOwnership(),
    '',
    '## 输出格式',
    '',
    '严格 JSON，不要别的字：',
    '',
    '```json',
    '{',
    '  "人物名": [',
    '    { "time": "0013年05月", "place": "神手谷", "text": "赶到谷口，没等到人" }',
    '  ]',
    '}',
    '```',
    '',
    '- 时间用「0013年05月」这种写法，不要 `0013.05`',
    '- 没写地点就留空字符串',
    '- 这个人这轮没有任何经历 → 给他一个空数组 `[]`',
  ].join('\n');
}

function backstoryOwnership() {
  return '【人物经历归属】每条须点名本人并写本人实际动作、选择、受影响的结果；完整原文中各人动作不同，不能把首句世界背景复制为所有人生平。只用当时已成立的事实，不强推原著计划。无本人事实就返回空数组。生平摘要每条可至80字，保留关键动作与因果，不硬压20字；当前完整人物视角由另一阶段单独书写。';
}

/** 把人物表渲染成给模型看的一段 */
function renderRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '（没有要补的人）';
  return list.map((row, i) => {
    const name = String(row && row.name || '').trim();
    // 空状态有两种含义，不能混：
    //   · 真的没有这个人的记录
    //   · 读不到「正文之前那一刻」的存档（本轮才出现的分支）
    // 后者必须说清，否则模型会当成「他本来就没状态」然后放心编。
    const state = String(row && row.stateText || '').trim()
      || (row && row.stateMissing
        ? '（读不到正文之前那一刻的状态，只能按原著材料保守写）'
        : '（存档里没有记录）');
    const events = Array.isArray(row && row.events) ? row.events : [];
    const evLines = events.length > 0
      ? events.map((e) => {
        const t = String(e && e.time || '').trim();
        const b = String(e && e.brief || '').trim() || String(e && e.title || '').trim();
        return `   - ${t} ${b}`;
      }).join('\n')
      : '   - （原著里这段时间没有他的事）';
    return `${i + 1}. **${name}**\n   现状：${state}\n   原著：\n${evLines}`;
  }).join('\n\n');
}

function turnRangeText(options) {
  const start = String(options && options.turnStart || '').trim();
  const end = String(options && options.turnEnd || '').trim();
  if (start && end) return `${start} → ${end}`;
  return start || end || '（未指定）';
}

/**
 * 解析模型返回的经历。
 *
 * 容忍几种常见走样：包了 ```json、时间是 `0013.05`、地点缺失。
 *
 * @param {string} raw
 * @param {string[]} expectedNames
 * @returns {{ok:boolean, byName:object, reason:string}}
 */
export function parseBackstory(raw, expectedNames) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, byName: {}, reason: '空输出' };

  let json = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    // 试着从第一个 { 到最后一个 }
    const a = json.indexOf('{');
    const b = json.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        parsed = JSON.parse(json.slice(a, b + 1));
      } catch (e2) {
        return { ok: false, byName: {}, reason: '不是合法 JSON' };
      }
    } else {
      return { ok: false, byName: {}, reason: '不是合法 JSON' };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, byName: {}, reason: '不是 JSON 对象' };
  }

  const byName = {};
  for (const [name, value] of Object.entries(parsed)) {
    const n = String(name || '').trim();
    if (!n || !Array.isArray(value)) continue;
    const lines = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') return {ok:false,byName,reason:`${n} 的经历条目不是对象`};
      const text2 = String(item.text == null ? '' : item.text).trim();
      if (!text2) return {ok:false,byName,reason:`${n} 的经历条目缺少正文`};
      lines.push({
        name: n,
        time: normalizeBiographyTime(item.time),
        place: String(item.place == null ? '' : item.place).trim(),
        text: text2,
      });
    }
    byName[n] = lines;
  }

  // 期望的人一个都没回来 → 当失败，别拿半截结果去写档案
  const expected = Array.isArray(expectedNames) ? expectedNames.filter(Boolean) : [];
  const owners = new Map();
  for (const [name, lines] of Object.entries(byName)) {
    for (const line of lines) {
      const key = line.text.split(name).join('').replace(/[\s，,。；;：:]/g,'');
      if (owners.has(key) && owners.get(key) !== name) return {ok:false,byName,reason:'多人重复同一条经历，缺少人物实际归属：' + owners.get(key) + '、' + name};
      owners.set(key,name);
    }
  }
  if (expected.length > 0) {
    const got = expected.filter((n) => Object.prototype.hasOwnProperty.call(byName, n));
    if (got.length !== expected.length) {
      return { ok: false, byName, reason: '人物返回不完整：' + expected.filter(n=>!got.includes(n)).join('、') };
    }
  }

  return { ok: true, byName, reason: '' };
}

/**
 * 把批量结果并回人名表：模型漏掉的人走降级（按原著 + 标记）。
 *
 * @param {object} input
 * @param {Array<object>} input.actors 有档案的人（`{name, events}`）
 * @param {object} input.byName parseBackstory 的产出
 * @param {object} [input.options]
 * @returns {object} name -> BackstoryLine[]
 */
export function mergeBackstory(input) {
  const src = input && typeof input === 'object' ? input : {};
  const actors = Array.isArray(src.actors) ? src.actors : [];
  const byName = src.byName && typeof src.byName === 'object' ? src.byName : {};
  const options = src.options || {};
  // 这一批是不是**整批失败**了（模型没调通/解析不出来）。
  // 失败和「模型说这些人没经历」是两回事，不能都走降级。
  const batchFailed = src.batchFailed === true;

  const out = {};
  for (const actor of actors) {
    const name = String(actor && actor.name || '').trim();
    if (!name) continue;

    // ① 模型给了这个人的回答 → 照用（哪怕是空数组，
    //    那是「这轮确实没经历」的明确回答，合法）
    if (Object.prototype.hasOwnProperty.call(byName, name)) {
      out[name] = byName[name];
      continue;
    }

    // ② 整批失败 → **不降级**。
    //
    //    原来这里一律 fallbackBackstory：把年表原句直接当成
    //    「他实际做了什么」。模型没调通的时候，这等于用
    //    「原著本该发生的事」冒充「他真实经历」，会被写进第 35 列
    //    变成既定历史。用户 2026-10-21 明确禁止：
    //    「不能反过去以原著剧情结果推翻」。
    //
    //    正确做法：这批人的旧账标成**未确认**，留待下一轮。
    if (batchFailed) {
      out[name] = [];
      continue;
    }

    // 漏人也不拿原著代替实际经历；完整性由 parseBackstory 校验和重试。
    out[name] = [];
  }
  return out;
}

/**
 * 首次登场标记：窗口外不补，只留一句。
 *
 * @param {string} name
 * @param {string} time 首次登场的时间
 * @returns {string}
 */
export function firstAppearLine(name, time) {
  const t = normalizeBiographyTime(time);
  const n = String(name || '').trim();
  if (!n) return '';
  return `[${t}]${CE_FIRST_APPEAR_NOTE}`;
}
