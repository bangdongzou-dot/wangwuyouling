// ============================================================
// 玩家可见层：反馈、诊断、设置入口
//
// 用户要求（原话）：
//   「反馈机制，诊断查看机制，设置自定义内容。这些都要好好想想怎么落实，
//     要让玩家看得到在运行，找得到在哪配置和自定义，
//     看得到运行的过程发生了什么可以据此来诊断问题，
//     这些你都可以看看目标前端原有的系统是怎么做的」
//
// ------------------------------------------------------------
// 三件事，全部照抄宿主已有的做法，不发明新交互：
//
//   ① 正在运行   → showDanmaku(text, 'status', controller, true)
//                   右上角气泡，带秒表。玩家立刻知道「系统在动」。
//
//   ② 过程发生了什么 → ceRenderThinkingToStreamTab(...)
//                   变量思维 tab。宿主原有链路就在往这里写，
//                   我们的记录插进同一处，玩家不用学第二个地方。
//
//   ③ 在哪配置     → manageConcurrentEvolutionSettings 的面板里
//                   沿用 ceEnsureOriginalTimelineSettingsControls 的做法：
//                   在既有设置块旁边插一块，不新开窗口。
//
// ------------------------------------------------------------
// 诊断为什么必须做（不是锦上添花）：
//
//   这套系统的失败大多是**静默**的：
//     差集算错 → 少补了几条，玩家看不出来
//     散文不合格 → 记欠账，但如果玩家看不到，等于没发生
//     边界判定降级到一步式 → 结果照出，但质量掉了
//
//   所以每一次运行都要留下「这次做了什么、卡在哪、退到了什么」，
//   而且要留在玩家本来就会看的地方。
// ============================================================

import { CE_PROMPT_GROUPS, listEditablePrompts, isPromptOverridden } from './prompt-registry.js';
import { formatAbandonedDebts } from './ledger.js';
import { formatDebtsForPlayer } from './prose-validate.js';

/** 思维 tab 里我们这一块的标题 */
export const CE_DIAG_TITLE = '原著补演';

/** 一次运行最多保留多少条诊断（防止思维 tab 被刷爆） */
export const CE_DIAG_MAX_ITEMS = 40;

/**
 * 运行记录器：把一轮里发生的事按顺序存下来。
 *
 * 它只记录，不判断。判断留给各步骤自己。
 *
 * @returns {object}
 */
export function createDiagRecorder() {
  const items = [];
  let closed = false;

  const push = (level, text, detail) => {
    if (closed) return;
    if (items.length >= CE_DIAG_MAX_ITEMS) return;
    items.push({
      level: String(level || 'info'),
      text: String(text == null ? '' : text),
      detail: detail == null ? '' : String(detail),
    });
  };

  return {
    /** 正常推进 */
    step(text, detail) { push('info', text, detail); },
    /** 值得注意但不算错（降级、跳过、兜底） */
    warn(text, detail) { push('warn', text, detail); },
    /** 真出错了 */
    error(text, detail) { push('error', text, detail); },
    /** 成功收尾 */
    done(text, detail) { push('done', text, detail); },

    /** 取全部记录（返回副本，外部改不影响内部） */
    items() { return items.map((x) => ({ ...x })); },
    count() { return items.length; },
    /** 收尾后不再接收（防止异步晚到的写入串到下一轮） */
    close() { closed = true; },
    isClosed() { return closed; },
  };
}

/**
 * 把诊断记录渲染成思维 tab 的 HTML 片段。
 *
 * 结构照抄宿主既有做法：ce-thinking-section + header + body。
 *
 * @param {Array} items
 * @returns {string}
 */
export function renderDiagHtml(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const icon = { info: '·', warn: '⚠', error: '✖', done: '✔' };
  const color = { info: 'inherit', warn: '#e0a030', error: '#e57373', done: '#66bb6a' };

  const body = list.map((item) => {
    const lv = String(item.level || 'info');
    const mark = icon[lv] || '·';
    const c = color[lv] || 'inherit';
    const detail = item.detail
      ? `<div style="opacity:0.7;font-size:12px;padding-left:16px;white-space:pre-wrap">${esc(item.detail)}</div>`
      : '';
    return `<div style="color:${c};line-height:1.7">${mark} ${esc(item.text)}</div>${detail}`;
  }).join('');

  return [
    '<div class="ce-thinking-section ce-canon-diag">',
    `<div class="ce-thinking-section-header">${esc(CE_DIAG_TITLE)}</div>`,
    `<div class="ce-thinking-section-body">${body}</div>`,
    '</div>',
  ].join('');
}

/**
 * 把一轮编排器的 trace 转成诊断记录。
 *
 * 编排器本来就产出 trace，这里只是换个更人话的说法。
 *
 * @param {object} result runCanonTurn / runCanonGuidance 的返回值
 * @param {object} [recorder]
 * @returns {object} recorder
 */
export function recordTurnResult(result, recorder) {
  const rec = recorder || createDiagRecorder();
  const r = result && typeof result === 'object' ? result : {};

  const trace = Array.isArray(r.trace) ? r.trace : [];
  for (const step of trace) {
    const name = String(step && step.step || '');
    const detail = String(step && step.detail || '');
    // 失败相关的步骤标黄/标红，让玩家一眼看到卡在哪
    if (/失败|已兜底|无人认领/.test(detail)) rec.warn(`${name}：${detail}`);
    else rec.step(`${name}，${detail}`.replace(/，$/, ''));
  }

  const status = String(r.status || '');
  if (status === 'ok') {
    rec.done(`本轮完成：写了 ${(r.prose || []).length} 段`);
  } else if (status === 'nothing_to_do') {
    rec.done(`本轮无需补演${r.reason ? `（${r.reason}）` : ''}`);
  } else if (status) {
    rec.error(`本轮未完成：${r.reason || status}`);
  }

  const debts = Array.isArray(r.debts) ? r.debts : [];
  if (debts.length > 0) {
    rec.warn(`${debts.length} 段没写出来，已记欠账`, formatDebtsForPlayer(debts));
  }

  const abandoned = Array.isArray(r.abandonedDebts) ? r.abandonedDebts : [];
  if (abandoned.length > 0) {
    rec.error(`${abandoned.length} 个时段反复失败已放弃`, formatAbandonedDebts(abandoned));
  }

  return rec;
}

/**
 * 反馈五块（总设计 §6）：给玩家看的总结。
 *
 * 只渲染有内容的块，空的不占地方。
 *
 * @param {object} input
 * @param {object} [input.range] { start, end }
 * @param {number} [input.eventCount]
 * @param {Array<string>} [input.writtenNames]
 * @param {Array} [input.mutated]
 * @param {Array} [input.blocked]
 * @param {Array} [input.debts]
 * @param {boolean} [input.wroteWorld] 本轮有没有写世界块
 * @param {Array} [input.staleHooks] 烂尾的线索
 * @param {Array} [input.openHooks] 还开着的线索
 * @returns {string}
 */
export function renderPlayerFeedback(input) {
  const src = input && typeof input === 'object' ? input : {};
  const blocks = [];

  // ① 世界走了多远
  const range = src.range || {};
  if (range.start || range.end) {
    const count = Number(src.eventCount) || 0;
    blocks.push(`📅 ${range.start || '?'} → ${range.end || range.start || '?'}｜区间内 ${count} 条原著事件`);
  }

  // ② 谁的故事被写了
  const names = Array.isArray(src.writtenNames) ? src.writtenNames.filter(Boolean) : [];
  if (names.length > 0) {
    blocks.push(`✍️ ${names.join('、')}（${names.length} 个视角）`);
  }
  // 世界块也算「写了」，但它没有视角，单独说明
  if (src.wroteWorld === true) {
    blocks.push('🌐 世界（没有具体角色可代入的那部分）');
  }

  // ③ 因为你而没有发生
  const blocked = Array.isArray(src.blocked) ? src.blocked.filter(Boolean) : [];
  for (const b of blocked) blocks.push(`🚫 ${b}`);

  // ④ 被你改变的
  const mutated = Array.isArray(src.mutated) ? src.mutated : [];
  for (const m of mutated) {
    const original = String(m && m.original || '').trim();
    const actual = String(m && m.actual || '').trim();
    if (!original) continue;
    blocks.push(`🔀 本该：${original}${actual ? `｜实际：${actual}` : ''}`);
  }

  // 还开着的线索：告诉玩家这些会延续到下一轮
  const open = Array.isArray(src.openHooks) ? src.openHooks : [];
  for (const h of open) {
    const who = String(h && h.who || '').trim();
    const hook = String(h && h.hook || '').trim();
    if (!who || !hook) continue;
    blocks.push(`🔗 ${who}：${hook}（未完）`);
  }

  // 烂尾的线索：必须让玩家知道，不能静静消失
  const stale = Array.isArray(src.staleHooks) ? src.staleHooks : [];
  for (const h of stale) {
    const who = String(h && h.who || '').trim();
    const hook = String(h && h.hook || '').trim();
    if (!who || !hook) continue;
    blocks.push(`💤 ${who}：${hook}（起了头没收，已放掉）`);
  }

  // 欠账也算反馈（静默漏补是最危险的）
  const debts = Array.isArray(src.debts) ? src.debts : [];
  if (debts.length > 0) {
    blocks.push(`⏳ ${debts.length} 段尚未完成，待本轮继续补演`);
  }

  return blocks.join('\n');
}

// ============================================================
// 设置区：插进既有设置面板，不新开窗口
// ============================================================

/** 设置块 DOM id */
export const CE_SETTINGS_BLOCK_ID = 'ce-canon-settings-block';

/**
 * 在宿主既有设置面板里插入「原著补演」配置块。
 *
 * 做法照抄 ceEnsureOriginalTimelineSettingsControls：
 * 找既有控件当锚点，插在它旁边；找不到就退到面板主体。
 *
 * @param {object} dom document 或测试替身
 * @param {object} [options]
 * @param {string} [options.html] 由 settings-panel.buildCanonSettingsHtml 生成的片段
 * @param {string} [options.anchorSelector]
 * @returns {{block:object|null, inserted:boolean, reason:string}}
 */
export function ensureSettingsBlock(dom, options = {}) {
  if (!dom || typeof dom.getElementById !== 'function') {
    return { block: null, inserted: false, reason: '没有可用的 document' };
  }

  const existing = dom.getElementById(CE_SETTINGS_BLOCK_ID);
  if (existing) return { block: existing, inserted: false, reason: '已经在了' };

  const html = String(options.html == null ? '' : options.html);
  if (!html) return { block: null, inserted: false, reason: '没有要插入的内容' };

  const anchorSelector = options.anchorSelector || '#ce-original-timeline-settings-block';
  const anchor = typeof dom.querySelector === 'function' ? dom.querySelector(anchorSelector) : null;
  const container = (anchor && anchor.parentElement)
    || (typeof dom.querySelector === 'function' ? dom.querySelector('.modal-body') : null)
    || (typeof dom.querySelector === 'function' ? dom.querySelector('.modal-content') : null);

  if (!container || typeof dom.createElement !== 'function') {
    return { block: null, inserted: false, reason: '找不到可以插入位置的容器' };
  }

  const block = dom.createElement('div');
  block.id = CE_SETTINGS_BLOCK_ID;
  block.className = 'input-group';
  block.innerHTML = html;

  if (typeof container.appendChild === 'function') container.appendChild(block);

  return { block, inserted: true, reason: '' };
}

/**
 * 面板打开时回填覆盖状态。
 *
 * @param {object} overrides 玩家覆盖表
 * @returns {Array<{key:string, label:string, overridden:boolean, length:number}>}
 */
export function summarizePromptState(overrides) {
  const groups = listEditablePrompts(overrides);
  const out = [];
  for (const g of groups) {
    for (const item of g.items) {
      const custom = String(overrides && overrides[item.key] != null ? overrides[item.key] : '');
      out.push({
        key: item.key,
        label: item.label,
        group: g.label,
        overridden: isPromptOverridden(item.key, overrides),
        length: custom.trim().length,
      });
    }
  }
  return out;
}

/**
 * 生成设置块顶部的一句状态说明，让玩家一眼知道现在的状态。
 *
 * @param {object} input
 * @param {boolean} [input.enabled]
 * @param {object} [input.ledger]
 * @param {object} [input.overrides]
 * @returns {string}
 */
export function renderSettingsStatusLine(input) {
  const src = input && typeof input === 'object' ? input : {};
  const parts = [];

  parts.push(src.enabled === false ? '状态：已关闭' : '状态：已开启');

  const ledger = src.ledger && typeof src.ledger === 'object' ? src.ledger : null;
  if (ledger && ledger.worldTime) parts.push(`世界时间 ${ledger.worldTime}`);
  if (ledger && Array.isArray(ledger.debts)) {
    parts.push(ledger.debts.length > 0 ? `欠账 ${ledger.debts.length} 段` : '无欠账');
  }

  const state = summarizePromptState(src.overrides);
  const changed = state.filter((x) => x.overridden).length;
  parts.push(changed > 0 ? `${changed} 段提示词已自定义` : '提示词全部默认');

  return parts.join('｜');
}
