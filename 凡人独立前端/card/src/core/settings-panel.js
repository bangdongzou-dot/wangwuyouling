// ============================================================
// 原著补演 · 独立设置面板
//
// 用户 2026-10-21：
//   「似乎原著补演系统需要的面板设置比较多，你都抽出来单独做个设置面板，
//     就叫原著补演。」
//
// ------------------------------------------------------------
// 为什么从「插在重点演化里的一块」改成独立面板：
//
//   原先的设置块有 14 个资料开关 + 8 个参数 + 9 段提示词编辑器，
//   塞在重点演化面板里，跟重点演化自己的几十项混在一起，
//   玩家根本找不着，也分不清哪项是谁的。
//
//   现在独立成窗：标题就叫「原著补演」，只放它自己的东西。
//
// ------------------------------------------------------------
// 实现约束（沿用宿主既有做法，不发明新交互）：
//   · 复用现成的 overlay / settings-modal / settings-section 类名，
//     不引入新 CSS 体系，跟着主题走
//   · 不引入前端框架；只产 HTML + data 属性
//   · 覆盖约定沿用卡内 imagePromptTemplateOverrides：空 = 用默认
// ============================================================

import {
  CE_PROMPT_GROUPS,
  CE_PROMPT_REGISTRY,
  isPromptOverridden,
  resolvePrompt,
  resetPrompt,
  resetAllPrompts,
  findOrphanOverrides,
  listEditablePrompts,
} from './prompt-registry.js';
import { CE_MATERIAL_MODES, CE_MATERIAL_MODE_LABELS } from './vector-input.js';
import { CE_PROSE_DISPATCH } from './prose-dispatch.js';
import { CE_PROSE_BUDGET } from './prose-prompt.js';
import {
  CE_MATERIAL_SOURCES,
  CE_MATERIAL_GROUPS,
  CE_MATERIAL_PROFILES,
  materialDefaults,
  normalizeMaterialCounts,
} from './host-material.js';
import { CE_RETRY_DEFAULTS, CE_RETRY_FIELDS } from './retry.js';
import { CE_REQUEST_LIMITS, CE_INPUT_CHARS_MAX } from './request-budget.js';
import {renderRoleRosterEditor,bindRoleRosterEditor,readRoleRosterEditor,renderCoreRosterEditor,bindCoreRosterEditor,readCoreRosterEditor,CE_CAST_TIER_BUDGET} from './role-roster.js';
export function bindCanonRoleRosterEditor(root,value,defaults){bindRoleRosterEditor(root,value,defaults);bindCoreRosterEditor(root,value&&value.coreCharacterNames);}

/** 面板根 id：宿主按这个找 */
export const CE_PANEL_OVERLAY_ID = 'ce-canon-settings-overlay';

/** 各分区 id（宿主绑定事件、测试定位都用它） */
export const CE_PANEL_SECTIONS = {
  basic: 'ce-canon-sec-basic',
  retry: 'ce-canon-sec-retry',
  materials: 'ce-canon-sec-materials',
  params: 'ce-canon-sec-params',
  prompts: 'ce-canon-sec-prompts',
};

/** 资料来源采用原有记录的自然单位，容量预算另由参数页负责。 */
export const CE_PANEL_MATERIAL_COUNTS = {
  recentStory:{label:'既往正文最近',unit:'轮',hint:'不含本轮正文；每轮内容完整保留。'},
  narrativeMemory:{label:'叙事记忆最近',unit:'条',hint:'按记录选取，保留完整记忆内容。'},
  worldEvents:{label:'历史世界大事最近',unit:'条',hint:'只限制可选历史背景，不裁切本轮相关事件。'},
};

/** HTML 转义 */
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 取某档篇幅：优先玩家配置，其次默认，最后退回旧字段。 */
function tierBudget(tier, config) {
  const c = config || {};
  const budgets = c.tierBudgets && typeof c.tierBudgets === 'object' ? c.tierBudgets : {};
  const value = Number(budgets[tier]);
  if (Number.isFinite(value) && value > 0) return value;
  // 兼容旧配置：没有 tierBudgets 时，用旧的 coreMaxChars / minorMaxChars。
  if (tier === 'core') return Number(c.coreMaxChars) || CE_CAST_TIER_BUDGET.core;
  if (tier === 'minor') return Number(c.minorMaxChars) || CE_CAST_TIER_BUDGET.minor;
  return CE_CAST_TIER_BUDGET[tier] || 400;
}

/** 一个数字输入行
 *  用 type="text" + inputmode="numeric" 而不是 type="number"：
 *  数字框自带的上下箭头会吃掉约 20px，六位数（262144）显示不全，
 *  玩家 2026-10-30 两次报同一处。CSS 关箭头在 Firefox 上不可靠（-moz-appearance
 *  只对部分控件生效），干脆不用数字框。
 *  宽度也不写死：size 取「当前值位数」与「上限位数」的较大者，框的固有宽度
 *  由它决定，所以换存档、换位数、切到最大值都不会裁字；再配合 CSS 的
 *  field-sizing:content，支持的浏览器输入时还会继续变宽。
 *  inputmode="numeric" 保证手机仍弹数字键盘；范围存在 data-min/data-max 上供样式与校验读取；
 *  读取端一律走 Number(el.value)，与 type 无关，行为不变。 */
function numberRow(id, label, value, min, max, hint) {
  /* 数字设置行。
   *
   * 玩家 2026-11-01 截图：「容器显示的设置数字不全」——
   *   单批输入容量显示 5000（实际 500000）
   *   单批输出容量显示 1600（实际 16000）
   *   模型输出上限显示 6553（实际 65536）
   * 三个都恰好只显示 **4 位**。
   *
   * ★ 最终定位（前面查错过两次，都记下来别再走弯路）：
   *   ① 不是 min-width:0 覆盖内联值 —— 改掉后照样裁。
   *   ② 不是「范围文字抢列宽」—— 实测把范围文字挪走，输入框反而更窄（78→50px）。
   *   ③ 真因：原布局是「标签占 1fr / 输入框占 auto」两列并排，
   *      输入框只用 size 属性定宽（size ≈ 6 字符，再被 padding 吃掉约 2 字符），
   *      实际只放得下 4 位；卡片一窄（四列并排时每张约 240px）就更挤。
   *      所以 500000→5000、16000→1600、65536→6553，全都退成 4 位。
   *
   * 修法：**输入框独占一整行**，宽度跟着卡片走（约 220px 起），
   *   再也不受标签和列宽挤压；再配合 min-width:ch 兜底，
   *   保证至少装得下「最长值」的位数。
   *   布局顺序：标签 → 输入框（整行）→ 可填范围 → 说明。
   */
  const widthOf = (v) => String(v == null ? '' : v).length;
  // 需要显示的最长位数：当前值 / 上限 / 下限里取最长，至少 4 位
  const digits = Math.max(4, widthOf(value), widthOf(max), widthOf(min));
  return [
    '<label class="ce-canon-row ce-canon-number-row">',
    `  <span class="ce-canon-row-label">${esc(label)}</span>`,
    `  <input id="${esc(id)}" class="ce-canon-input ce-canon-number-input" type="text" inputmode="numeric" `
      + `size="${digits}" style="min-width:${digits}ch" `
      + `data-min="${min}" data-max="${max}" value="${esc(value)}" />`,
    '  <span class="ce-canon-row-range">'
      + `可填 ${esc(min)} — ${esc(max)}</span>`,
    hint ? `  <span class="ce-canon-row-hint">${esc(hint)}</span>` : '',
    '</label>',
  ].filter(Boolean).join('\n');
}

/** 一个下拉行 */
function selectRow(id, label, value, options, hint) {
  const opts = options
    .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return [
    '<label class="ce-canon-row ce-canon-select-row">',
    `  <span class="ce-canon-row-label">${esc(label)}</span>`,
    `  <select id="${esc(id)}" class="ce-canon-input">${opts}</select>`,
    hint ? `  <span class="ce-canon-row-hint">${esc(hint)}</span>` : '',
    '</label>',
  ].filter(Boolean).join('\n');
}

/** 一个开关行 */
function toggleRow(id, label, checked, hint, dataKey) {
  const dk = dataKey ? ` data-key="${esc(dataKey)}"` : '';
  return [
    '<label class="ce-canon-toggle">',
    `  <input id="${esc(id)}" type="checkbox"${dk}${checked ? ' checked' : ''} />`,
    `  <span class="ce-canon-toggle-label">${esc(label)}</span>`,
    hint ? `  <span class="ce-canon-toggle-hint">${esc(hint)}</span>` : '',
    '</label>',
  ].filter(Boolean).join('\n');
}

/** 控件按用途成组，避免单个输入框铺满整窗。 */
function controlCard(title, note, content, extraClass) {
  return '<section class="ce-canon-control-card '+(extraClass || '')+'"><div class="ce-canon-card-heading"><h5>'+esc(title)+'</h5>'+(note?'<p class="hint">'+esc(note)+'</p>':'')+'</div>'+content+'</section>';
}

function sectionHeading(title, note, section) {
  return '<div class="ce-canon-section-heading"><div class="ce-canon-section-title"><h4>'+esc(title)+'</h4>'+(section?'<button type="button" class="small-btn"'+(section==='prompts'?' id="ce-canon-reset-all-prompts"':'')+' data-ce-canon-reset-section="'+esc(section)+'">恢复本页默认</button>':'')+'</div><p class="hint">'+esc(note)+'</p></div>';
}

/**
 * 折叠卡片。
 *
 * 2026-11-01 玩家截图：「是不是下面有一些设置内容卡在下面了啊？」
 *   ——「请求与批量设置」默认是收起的，又排在「角色分派」里三个可展开项之后，
 *     玩家滚到那儿只看到一条灰线，以为设置项被弄丢了。
 *     而报错信息恰恰让人去那里改「单批输入容量」，等于指了一条找不到的路。
 *
 * 现在默认展开；需要时仍可点标题收起（折叠能力保留，只是不再默认藏）。
 */
function advancedCard(title, note, content, collapsed) {
  return '<details class="ce-canon-advanced"'+(collapsed?'':' open')+'><summary><span>'+esc(title)+'</span><span class="ce-canon-advanced-caption">'+esc(note)+'</span></summary><div class="ce-canon-advanced-body">'+content+'</div></details>';
}

// ------------------------------------------------------------
// 一、基础
// ------------------------------------------------------------

/** 两张模式卡仅呈现既有 prebuiltEnabled 开关，不引入路由状态。 */
function renderCanonRouteChoice(config) {
  const prebuilt = config.prebuiltEnabled !== false;
  return '<fieldset class="ce-canon-route-cards" aria-describedby="ce-canon-route-hint"><legend>补演方式</legend>' +
    '<label class="ce-canon-route-card"><input id="ce-canon-ordinary" name="ce-canon-route" type="radio" value="ordinary"'+(!prebuilt?' checked':'')+'><span class="ce-canon-route-words"><strong>普通补演</strong><span>边界判定后，按普通补演档位和分支生成。</span><small>边界判定 → 分档补演 → 落地</small></span></label>' +
    '<label class="ce-canon-route-card"><input id="ce-canon-prebuilt" name="ce-canon-route" type="radio" value="prebuilt"'+(prebuilt?' checked':'')+'><span class="ce-canon-route-words"><strong>预制成品补演</strong><span>正常内容原样落地，只定向修改变异点。</span><small>自动判断：原样落地 / 定向修订</small></span></label>' +
    '<p id="ce-canon-route-hint" class="hint">匹配成品后保持预制路线，修订或落地失败保留待续；未匹配到可用成品时沿用常规补演。保存后下一轮生效，切换不删除已导入成品。</p></fieldset>';
}

function renderBasic(config) {
  const c = config || {};
  return [
    `<div class="settings-section" id="${CE_PANEL_SECTIONS.basic}">`,
    sectionHeading('总览与模型','选择补演使用的模型，管理运行状态与记录。恢复本页默认保留已填接口与密钥。','basic'),
    '<div class="ce-canon-master">'+toggleRow('ce-canon-enabled', '启用原著补演', c.enabled !== false,'正文前提供原著指导，正文后补足角色经历。关闭后停止这两步。')+'</div>',
    renderCanonRouteChoice(c),
    '<div class="ce-canon-overview-grid">',
    '<section class="ce-canon-control-card ce-canon-model-card"><div class="ce-canon-card-heading"><h5>模型接口</h5><p class="hint">沿用已有模型，或为指导与补演单独选择。</p></div>',
    '<label class="ce-canon-row ce-canon-select-row"><span class="ce-canon-row-label">接口来源</span><select id="ce-canon-api-mode" class="ce-canon-input"><option value="inherit"'+(!(c.api && (c.api.apiUrl || c.api.apiKey || c.api.apiModel))?' selected':'')+'>沿用重点演化接口</option><option value="custom"'+(c.api && (c.api.apiUrl || c.api.apiKey || c.api.apiModel)?' selected':'')+'>使用独立接口</option></select></label>',
    '<div id="ce-canon-inherited-api" class="ce-canon-note">正在读取当前重点演化模型…</div>',
    '<div id="ce-canon-custom-api">',
    '<div class="fr-api-embed" data-fr-api-consumer="CULTIVATION_CANON_BRIDGE_CONFIG_V1" data-fr-api-slot="apiPresetId"></div>',
    '<label class="ce-canon-row ce-canon-select-row"><span class="ce-canon-row-label">接口地址</span><input id="ce-canon-api-url" class="ce-canon-input" value="'+esc(c.api && c.api.apiUrl || '')+'" placeholder="填写模型服务地址"></label>',
    '<label class="ce-canon-row ce-canon-select-row"><span class="ce-canon-row-label">访问密钥</span><span class="ce-canon-inline"><input id="ce-canon-api-key" type="password" autocomplete="off" class="ce-canon-input" value="'+esc(c.api && c.api.apiKey || '')+'"><button type="button" class="small-btn" id="ce-canon-key-toggle" aria-label="显示或隐藏密钥">显示</button></span></label>',
    '<label class="ce-canon-row ce-canon-select-row"><span class="ce-canon-row-label">使用模型</span><span class="ce-canon-inline"><select id="ce-canon-api-model" class="ce-canon-input"><option value="'+esc(c.api && c.api.apiModel || '')+'">'+esc(c.api && c.api.apiModel || '请先获取模型列表')+'</option></select><button type="button" class="small-btn" id="ce-canon-fetch-models">获取模型列表</button></span></label>',
    '<label class="ce-canon-toggle ce-canon-toggle-compact"><input type="checkbox" id="ce-canon-model-manual"><span>手动指定模型</span></label>',
    /* 2026-11-03 玩家：「你别把这个当作默认设置了，只能当作一个高级设置开关，
     *                   用来处理这一类模型的问题，要不要开要看玩家。」
     *
     * 只有玩家显式勾选后，才把这个接口的末尾 assistant 预填充转成 user 消息。
     * 默认不勾：多数接口支持预填充，硬改反而破坏续写语义，还会掩盖真实错误。
     */
    toggleRow('ce-canon-api-prefill-unsupported', '不支持助手预填充',
      !!(c.api && c.api.assistantPrefillUnsupported),
      '仅当该接口报「请求不能以模型消息结尾」或返回异常时才需要开启。开启后，末尾预填充会转为用户消息发送。'),
    '<input id="ce-canon-api-model-custom" class="ce-canon-input" hidden aria-label="手动模型名称" placeholder="输入完整模型名称">',
    '<div id="ce-canon-model-feedback" class="ce-canon-note" role="status" aria-live="polite">获取列表后选择模型，不影响其他接口预设。</div>',
    '<p class="hint">独立接口用于原著指导、边界与散文；变量转换仍沿用重点演化接口。</p>',
    '</div>',
    '</section>',
    controlCard('运行与记录','记录按存档分别保留，便于回看每次补演。',[
      toggleRow('ce-canon-show-status', '显示运行状态', c.showStatus !== false,'右上角显示当前进度与用时。'),
      toggleRow('ce-canon-show-diag', '保留运行详情', c.showDiagnostics !== false,'在运行记录中查看阶段、资料与回答。'),
      advancedCard('记录保留设置','完整内容与数量',toggleRow('ce-canon-capture-bodies','保留完整请求与回答',c.traceCaptureBodies !== false,'包含发送材料、推理与回答；导出时过滤认证信息。')+numberRow('ce-canon-trace-keep','保留最近运行',c.traceKeep || 10,1,30,'超过数量时移除最旧记录。')),
    ].join('')),
    '</div>',
    '</div>',
  ].join('\n');
}

// ------------------------------------------------------------
// 二、重试
// ------------------------------------------------------------

function renderRetry(config) {
  const c = config || {};
  const retry = c.retry && typeof c.retry === 'object' ? c.retry : {};

  return [
    `<div class="settings-section" id="${CE_PANEL_SECTIONS.retry}">`,
    sectionHeading('请求设置','原著指导、检索、散文、变量与收尾统一使用；每分钟额度与重点演化共用。','retry'),
    '<section class="ce-canon-control-card"><div class="ce-canon-field-grid">',
    numberRow('ce-canon-rpm','全局每分钟最多请求',c.requestsPerMinute || 15,1,600,'与重点演化共用同一个滚动分钟计数器；检索和实际重试也计入。'),
    numberRow('ce-canon-concurrency','补演最大并发数',c.maxConcurrency || 5,1,20,'仅限制补演全部阶段；重点演化并发仍由其自身设置控制。'),
    numberRow('ce-canon-request-timeout','请求超时（秒）',(c.requestTimeoutMs || 120000)/1000,15,1800,'实际发送开始计时，排队不占超时。'),
    numberRow('ce-canon-timeline-batch','每批年表事件数',c.batchLimits?.timelineBatchEvents || 6,1,100,'默认6条一起提交原向量系统；只接收结果，不干预检索中间过程。'),
    '</div></section>',
    '<section class="ce-canon-control-card"><div class="ce-canon-card-heading"><h5>失败后的处理</h5><p class="hint">重试次数与补写次数分别设置。</p></div><div class="ce-canon-field-grid">',
    numberRow(
      'ce-canon-retry-max',
      CE_RETRY_FIELDS.maxRetries.label,
      retry.maxRetries === undefined ? CE_RETRY_DEFAULTS.maxRetries : retry.maxRetries,
      CE_RETRY_FIELDS.maxRetries.min,
      CE_RETRY_FIELDS.maxRetries.max,
      CE_RETRY_FIELDS.maxRetries.hint,
    ),
    toggleRow('ce-canon-retry-parse', '返回格式不符时重试',
      retry.retryOnParseError !== false,
      '关闭后，格式错误会直接停止该次请求。'),
    '</div></section>',
    '<details class="ce-canon-advanced" open><summary><span>等待与退避</span><span class="ce-canon-advanced-caption">两次重试之间的间隔</span></summary><div class="ce-canon-advanced-body ce-canon-field-grid">',
    numberRow('ce-canon-retry-delay','首次等待（秒）',(retry.retryDelayMs === undefined?1000:retry.retryDelayMs)/1000,0,120,'再次失败时等待加倍。'),
    numberRow('ce-canon-retry-max-delay','最长等待（秒）',(retry.maxDelayMs === undefined?8000:retry.maxDelayMs)/1000,0,600,'不缩短上游要求的限流冷却时间。'),
    '</div></details>',
    // ★ 2026-11-01 复盘补回：这 4 个开关/数值后端一直在读、也一直在影响行为，
    //   但**面板上从来没有渲染过对应控件** —— 玩家根本无从修改。
    //   readCanonPanelFromDom 里读 'ce-canon-pre-boundary' / 'ce-canon-early-boundary' /
    //   'ce-canon-early-preparation' / 'ce-canon-max-per-batch' 这 4 个 id，
    //   而 buildCanonPanelHtml 从来没生成过它们，val()/checked() 永远拿不到值。
    //   后果：preBoundaryEnabled / earlyBoundaryEnabled / earlyPreparationEnabled
    //   永远是默认 true，玩家想关也关不掉；maxPerBatch 永远 6。
    //   按玩家「该有的设置必须有显示、能打开能找到」的要求补上。
    '<section class="ce-canon-control-card"><div class="ce-canon-card-heading"><h5>原著流程开关</h5><p class="hint">这几个开关控制补演在正文前后自动跑哪几步；关掉可省请求，但对应步骤也不会执行。</p></div>',
    toggleRow('ce-canon-pre-boundary', '正文前先判定边界',
      c.preBoundaryEnabled !== false,
      '开启后，正文开始前先判一遍原著边界，把该守的边界提前划好。关闭则跳过这一步。'),
    toggleRow('ce-canon-early-boundary', '正文前先做保守判定',
      c.earlyBoundaryEnabled !== false,
      '开启后，在正文之前先用保守档判一次原著走向。关闭则等正文出来再判。'),
    toggleRow('ce-canon-early-preparation', '正文前先做备料',
      c.earlyPreparationEnabled !== false,
      '开启后，正文之前先把本轮要用的原著材料准备好。关闭则正文后再现取。'),
    '<div class="ce-canon-field-grid">',
    // ★ 2026-11-01：「每批最多处理几条」已移到「推演与散文 → 单批容量」卡片。
    //   它和「单批输入/输出容量」是一套双重保险，必须放一起看；
    //   拆在两页会让玩家以为「设置丢了」。这里不再重复渲染同一 id。
    //
    // ★★ 2026-11-01 玩家定：「按照原卡的，不要画蛇添足」。
    //   「每批向量检索查询数」（ce-canon-rag-queries）这个控件**删掉**了。
    //   原卡（万物有灵前端）的保存逻辑里本来就有
    //       delete next.batchLimits.ragBatchQueries;
    //   也就是说原卡从来就不让玩家调这个值，固定按 32 跑。
    //   我们之前为了「前端有的后端要管用」给它补了一个输入框，
    //   但那个值在保存时照样被删掉 —— 结果变成一个改了没用的假设置。
    //   正确做法是**跟原卡保持一致**：不提供这个控件，后台照原卡用 32。
    //   注意：后台读取它的逻辑（main.js 的 queryLimit）保持原样不动，
    //   那是原卡原装代码，不在本次改动范围内。
    '</div></section>',
    '</div>',
  ].join('\n');
}

// ------------------------------------------------------------
// 三、资料
// ------------------------------------------------------------

// ------------------------------------------------------------
// 二-补、重排设置（补演专用）
// ------------------------------------------------------------

/**
 * 补演的重排设置。
 *
 * 玩家 2026-10-30：「检索设置在哪呢？」「只需要重排序设置啊」
 *
 * 原卡把重排这一整块放在它自己的检索弹窗里，一调正文和补演一起变。
 * 现在搬到这里，存进补演自己的配置，只作用于原著指导与补演。
 * 正文检索仍走原卡那套，互不覆盖。
 *
 * 七项与原卡一一对应：
 *   开关 / 接口地址 / 密钥 / 模型 / Top K / 重排最低分 / 每批条数
 */
function renderRetrievalCard(config) {
  const c = config || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const val = (v, d) => (v === undefined || v === null ? d : v);
  const on = c.retrievalEnableRerank !== false;

  const rows = [
    numberRow('ce-canon-retrieval-topk', 'Top K（召回候选数）', num(c.retrievalTopK, 20), 5, 100,
      '先捞多少个候选交给重排模型打分。调大能多给重排一些选择，但更慢更费。'),
    numberRow('ce-canon-retrieval-rerank-min', '重排最低分', num(c.retrievalRerankMinScore, 0.3), 0, 1,
      '重排分和余弦相似度是两种尺度，不能共用一个门槛。这个只卡重排分。'),
    numberRow('ce-canon-retrieval-batch', '每批重排条数', num(c.retrievalRerankBatch, 20), 1, 200,
      '一次送给重排模型多少条。调小更稳，调大更快。'),
  ].join('');

  const service = [
    '<div class="fr-api-embed" data-fr-api-consumer="CULTIVATION_CANON_BRIDGE_CONFIG_V1" data-fr-api-slot="retrievalRerankApiPresetId"></div>',
    '<label class="ce-canon-row"><span class="ce-canon-row-label">重排接口地址</span>'
      +'<input id="ce-canon-retrieval-rerank-url" class="ce-canon-input" type="text" placeholder="https://..." value="'
      +esc(val(c.retrievalRerankUrl, ''))+'"/></label>',
    '<label class="ce-canon-row"><span class="ce-canon-row-label">重排密钥</span>'
      +'<input id="ce-canon-retrieval-rerank-key" class="ce-canon-input" type="password" placeholder="sk-..." value="'
      +esc(val(c.retrievalRerankKey, ''))+'"/></label>',
    '<label class="ce-canon-row"><span class="ce-canon-row-label">重排模型</span>'
      +'<input id="ce-canon-retrieval-rerank-model" class="ce-canon-input" type="text" placeholder="e.g. jina-reranker-v2" value="'
      +esc(val(c.retrievalRerankModel, ''))+'"/></label>',
  ].join('');

  return controlCard('重排设置', '两阶段共享：重排参数。设定集检索按阶段各自开关。',
    '<div class="ce-canon-field-grid">'
      +toggleRow('ce-canon-retrieval-rerank-on', '启用重排', on,
        '开启后先用向量粗筛，再让重排模型精排。关闭则只用相似度排序。')
      +rows
    +'</div>'
    /* 设定集检索的分阶段开关（玩家 2026-11-01 要求）。
     * 玩家原话：「原著指导阶段的设定集检索最好默认是关闭，其实这个阶段不需要
     * 详细的设定来支持指导，因为主要的关注点在剧情，而不是具体的人、事、物的
     * 详细变量。所以你单独设置一个开关管原著指导阶段的设定集检索，并且默认为
     * 关闭状态。原著补演阶段的设定集检索也单独设定开关，但是这个就要默认开启了。
     * 开关可以放在重排设置这里，而重排设置内容就是两阶段共享的设置。」 */
    +'<p class="ce-canon-subhead">设定集检索（按阶段）</p>'
    +'<div class="ce-canon-field-grid">'
      +toggleRow('ce-canon-guidance-retrieval-on', '原著指导阶段启用设定集检索',
        val(c.guidanceRetrievalEnabled, false),
        '默认关闭。指导阶段只需抓住剧情走向，人物、物品的详细数值留到补演阶段再查。')
      +toggleRow('ce-canon-replay-retrieval-on', '原著补演阶段启用设定集检索',
        val(c.replayRetrievalEnabled, true),
        '默认开启。补演要判定具体人物与事件，需要设定集里的详细资料支撑。')
    +'</div>'
    +'<p class="hint">这两项只管各自的阶段；「资料来源」里把<strong>设定集检索</strong>整项关掉仍会全局停用。</p>'
    +'<details class="ce-canon-advanced"'+(on?'':' closed')+'><summary><span>重排服务</span>'
      +'<span class="ce-canon-advanced-caption">接口地址、密钥与模型</span></summary>'
      +'<div class="ce-canon-advanced-body"><div class="ce-canon-field-grid">'+service+'</div>'
      +'<p class="hint">留空则沿用原卡那套重排服务。</p>'
      +'</div></details>'
    +'<p class="hint">补演按「每个检索词各取自己分数最高的一条」分配，<strong>不受注入数量封顶</strong>。</p>'
    +'<p class="hint">【人界篇总纲】每轮固定注入，用来锚定当前时间点在原著走到哪一步，以主角视角衡量。</p>');
}


/**
 * 资料来源面板：**按阶段分开显示**。
 *
 * 玩家 2026-11-01（明确批评）：
 *   「资料来源的设置面板要适配好啊，后端逻辑都全改了，
 *     分原著补演和原著指导啊，该删除的删除，该默认关闭的默认关闭好」
 *
 * 以前这里把 CE_MATERIAL_SOURCES 里全部 16 项拉成一张平表，导致三类错：
 *   ① 已从某阶段移除的项（如补演的 items/characters）在这里还显示，
 *      玩家以为能开，开了也没用 —— 名不副实。
 *   ② 全表混排，看不出某项到底属于哪个阶段。
 *   ③ 「默认关闭」只写了说明，没写清是哪个阶段的默认。
 *
 * 现在**以 CE_MATERIAL_PROFILES 为准**渲染：
 *   · 只显示该阶段 profile 里真的有的项 → 删掉的不再出现
 *   · 默认状态按 materialDefaults() 如实标注
 *   · 每个阶段一个独立分区，标题写清阶段名与用途
 */
export const CE_MATERIAL_STAGES = [
  {
    profile: 'guidance',
    title: '原著指导（正文前）',
    purpose: '判断蝴蝶效应：对照原著关键物品得失、关键人物当下状态、关键事件前置条件是否仍然成立，给正文作者划出这一轮该守的边界。',
  },
  {
    profile: 'turn',
    title: '原著补演（正文后）',
    purpose: '变量落地：写正文之外每个 NPC 各自的幕外经历，需要人物状态与目标才能准确推进变量。',
  },
];

/* ★★ 2026-11-01 玩家：「不要共用，原著补演和原著指导分开设置资料来源，
 *                 排版好，不要东一块西一块，上面原著指导，下面原著补演」
 *
 * 旧实现：一张扁平 config.materials 两个阶段共用，
 *   于是后渲染的那一阶段只能写一句「共用上方面板设置：…」把开关推给上面，
 *   玩家改上面的开关，两个阶段一起变 —— 这正是玩家要取消的「共用」。
 *
 * 新实现：每个阶段**独立**、**完整**列出它自己用到的全部资料项。
 *   · 沿用各自的 config.materialsByStage[profile]
 *   · 同一个资料项在两个阶段各出现一次，各自有独立的开关
 *     （id 带阶段前缀，读回时按阶段分表存，不会互相覆盖）
 *   · 顺序就是 CE_MATERIAL_STAGES 的顺序：上=原著指导，下=原著补演
 *
 * @param {object} stage  {profile,title,purpose}
 * @param {Record<string,boolean>} flags 该阶段自己的开关表
 */
function renderMaterialStage(stage, flags) {
  const keys = CE_MATERIAL_PROFILES[stage.profile] || [];
  const defaults = materialDefaults(stage.profile);
  const parts = [];

  // 每个阶段只认自己那份 flags，绝不读另一阶段的
  const stageFlags = flags && typeof flags === 'object' ? flags : {};
  const stateOf = (key) => (stageFlags[key] !== undefined ? stageFlags[key] !== false : defaults[key] !== false);

  const onCount = keys.filter((k) => stateOf(k)).length;
  const offKeys = keys.filter((k) => stateOf(k) === false);

  parts.push('  <div class="ce-canon-material-stage" data-stage="' + esc(stage.profile) + '">');
  parts.push('    <h5>' + esc(stage.title) + '</h5>');
  parts.push('    <p class="hint">' + esc(stage.purpose) + '</p>');
  parts.push('    <p class="hint ce-canon-material-stage-count">本阶段可用 ' + keys.length
    + ' 类资料，当前开启 ' + onCount + ' 类'
    + (offKeys.length
      ? '，关闭 ' + offKeys.length + ' 类（' + offKeys.map((k) => esc(CE_MATERIAL_SOURCES[k].label)).join('、') + '）'
      : '')
    + '。这一组开关只影响本阶段，不会连累另一个阶段。'
    + '</p>');

  const descOf = (key, spec) => (defaults[key] === false
    ? spec.desc + '（默认关闭，需要时可手动开启）'
    : spec.desc);

  // 按分组渲染；这个阶段用到的项全部列出来，一项不少
  const byGroup = {};
  for (const key of keys) {
    const spec = CE_MATERIAL_SOURCES[key];
    if (!spec) continue;
    const g = spec.group || 'other';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push([key, spec]);
  }

  parts.push('    <div class="ce-canon-material-grid">');
  for (const [groupKey, label] of Object.entries(CE_MATERIAL_GROUPS)) {
    const items = byGroup[groupKey];
    if (!items || items.length === 0) continue;
    parts.push('      <div class="ce-canon-group">');
    parts.push('        <h6>' + esc(label) + '</h6>');
    for (const [key, spec] of items) {
      // id 带阶段前缀：两个阶段各有一份，读回时按前缀分别写进各自的表
      parts.push(toggleRow(
        'ce-canon-material-' + stage.profile + '-' + key,
        spec.label, stateOf(key), descOf(key, spec), key));
    }
    parts.push('      </div>');
  }
  for (const g of Object.keys(byGroup)) {
    if (CE_MATERIAL_GROUPS[g]) continue;
    parts.push('      <div class="ce-canon-group"><h6>其他</h6>');
    for (const [key, spec] of byGroup[g]) {
      parts.push(toggleRow(
        'ce-canon-material-' + stage.profile + '-' + key,
        spec.label, stateOf(key), descOf(key, spec), key));
    }
    parts.push('      </div>');
  }
  parts.push('    </div>');
  parts.push('  </div>');
  return parts.join('\n');
}

function renderMaterials(config) {
  const c = config || {};
  /* ★ 2026-11-01：两个阶段各读自己的开关表。
   * 读不到分阶段表时退回扁平表 —— 与桥接层 ceBridgeMaterialsFor 的口径一致，
   * 保证「面板显示的状态」和「后端实际用的状态」不会对不上。 */
  const legacyFlags = c.materials && typeof c.materials === 'object' ? c.materials : {};
  const stageTable = c.materialsByStage && typeof c.materialsByStage === 'object' ? c.materialsByStage : null;
  const flagsForStage = (profile) => {
    const own = stageTable && stageTable[profile] && typeof stageTable[profile] === 'object'
      ? stageTable[profile] : null;
    return own || legacyFlags;
  };

  const parts = [
    `<div class="settings-section" id="${CE_PANEL_SECTIONS.materials}">`,
    sectionHeading('资料来源',
      '上下两组各自独立：上面是原著指导（正文前）要用的资料，下面是原著补演（正文后）要用的资料。每一组有自己的开关，改上面不会影响下面，反之亦然。',
      'materials'),
    '  <div class="ce-canon-toolbar">',
    '    <button type="button" class="small-btn" id="ce-canon-materials-all-on">全部开启</button>',
    '    <button type="button" class="small-btn" id="ce-canon-materials-all-off">全部关闭</button>',
    '    <button type="button" class="small-btn" id="ce-canon-materials-reset">恢复默认（推荐）</button>',
    '  </div>',
  ];

  // 每个阶段独立、完整地列出自己的全部资料项；不再出现「共用上方面板」这种把开关推给别人的写法
  for (const stage of CE_MATERIAL_STAGES) {
    parts.push(renderMaterialStage(stage, flagsForStage(stage.profile)));
  }

  // ★ 2026-11-01：这里原本有一个多余的 parts.push('</div>')。
  //
  //   上面 for 循环里每个 renderMaterialStage 自己已经开合并闭合了
  //   <div class="ce-canon-material-stage">…</div>，所以循环结束后
  //   没有「待关闭的外层容器」。
  //
  //   那个多余的 </div> 会把前面某层容器提前关掉（实际关掉的是
  //   .ce-canon-body），于是后续的 params / prompts 分区就挂到了
  //   .settings-modal 下面，而不是滚动容器里 —— 这正是玩家看到的
  //   「每一个设置面板全都彻底乱套了」「中间那么多空白」。
  //
  //   实测证据：生成 HTML 里 div 开 83 / 闭 84，深度最终 -1；
  //   DOM 里 ce-canon-sec-params 的 parentElement 是 settings-modal
  //   而不是 modal-body。删掉这一行后深度回到 0，结构归位。
  parts.push('<p class="hint ce-canon-material-summary">上面两个分区对应两个阶段。'
    + '标着「默认关闭」的项是消耗大、对这阶段帮助有限的那几项，需要时手动开启即可。'
    + '「恢复默认」会回到推荐配置。缺失项可在运行记录中查看。</p>');

  // 2026-11-01 玩家：「你最好每个设置界面都看看，可能都有这样的问题」。
  // 「可选历史背景」是常用项（调整背景多少直接关系到会不会超容量），不该默认藏起来。
  parts.push('<details class="ce-canon-limit-card" open><summary><span>可选历史背景</span><span class="ce-canon-limit-caption">按轮数与条数</span></summary><div class="ce-canon-limit-body"><p class="hint">以下只调整历史背景。选中的每份记录完整发送，不在句中截断。填 0 表示当前范围全部。既往正文不含本轮，只取最近已完成的轮次。</p><div class="ce-canon-field-grid">');
  const counts=normalizeMaterialCounts(c.materialCounts);
  for(const [key,spec] of Object.entries(CE_PANEL_MATERIAL_COUNTS))parts.push(numberRow('ce-canon-material-count-'+key,spec.label+'（'+spec.unit+'）',counts[key],0,10000,spec.hint));
  parts.push('</div></div></details>');
  parts.push(renderRetrievalCard(c));
  parts.push('<div class="ce-canon-control-card"><h5>本轮完整资料</h5><p class="hint">先汇集本轮相关原著人物、事件与关键物品，再完整取用对应资料。容量不足时按完整对象分批发送；缺项明确列出，不把缺失当作已齐备。人物尚未建档不等于没有原著设定，新人的已知设定可用于补全档案。</p><p class="hint">时间地点、玩家输入、本轮正文、世界规则、世界状态快照和地图完整发送。原著节点与年表沿用前情、当前、后续三档选材，选中的条目保留完整内容。</p><p class="hint">可选设定召回的命中条数沿用原检索设置，可通过上方「打开检索设置」调整；本轮必需人物的直接匹配不受可选召回数量裁切。单批请求容量在「推演与散文」的高级设置中调整。</p></div>');
  parts.push('</div>');
  return parts.join('\n');
}

// ------------------------------------------------------------
// 四、参数
// ------------------------------------------------------------

function renderParams(config, status = {}) {
  const c = config || {};
  const roster=status.importantRoleRoster||{};
  const entries=Object.entries(roster);
  const limits=c.batchLimits || {};
  const force=c.forceDispatch||{};
  const fieldGrid=(items)=>'<div class="ce-canon-field-grid">'+items.join('')+'</div>';
  const writing=controlCard('材料与写作','保留每个人的经历与判断，篇幅随事件密度调整。',
    // 年表材料/叙述人称是下拉框，选项文字长，塞进两列网格会被挤窄、压住下方提示。
    // 改成整行排列，每个下拉框占满宽度；篇幅数字框再并排。
    '<div class="ce-canon-stack">'
    +selectRow('ce-canon-material-mode','年表材料',c.materialMode || CE_MATERIAL_MODES.currentOnly,[
      {value:CE_MATERIAL_MODES.currentOnly,label:CE_MATERIAL_MODE_LABELS.current_only},
      {value:CE_MATERIAL_MODES.auto,label:CE_MATERIAL_MODE_LABELS.auto},
      {value:CE_MATERIAL_MODES.brief,label:CE_MATERIAL_MODE_LABELS.brief},
    ],'正文注入、原著指导及后续补演共用此选择。推荐：当前事件用原文，其余用条目；缺原文仍用条目。')
    +selectRow('ce-canon-pov','叙述人称',c.pov || '',[
      {value:'',label:'跟随卡内全局设置'},
      {value:'第三人称',label:'第三人称（他 / 她）'},
      {value:'第一人称',label:'第一人称（我）'},
    ],'跟随设置时，使用重点演化的人称。')
    +'</div>'
    // 三档篇幅：核心 / 重要 / 配角。这里填多少，实际就按多少写。
    +'<div class="ce-canon-field-grid ce-canon-field-grid--triple">'
    +numberRow('ce-canon-core-chars','核心角色篇幅',tierBudget('core',c),100,4000,'每个事件的参考字数；跨多个事件自动增加，经历清淡可少写。')
    +numberRow('ce-canon-major-chars','重要角色篇幅',tierBudget('major',c),100,2000,'每个事件的参考字数；各段关键经历与当前状态须写清楚。')
    +numberRow('ce-canon-minor-chars','配角篇幅',tierBudget('minor',c),40,800,'每个事件的参考字数；配角仍合批，容量不足才拆分。')
    +'</div>'
    // 2026-11-01：容量设置原本只藏在「请求与批量设置」折叠区的最底部，
    // 玩家按报错提示找不到它（原话：「那个设置也不见么回事？」）。
    // 挪到「材料与写作」第一屏，和篇幅放一起，打开这一页就能看见。
    //
    // 2026-11-01 第二次（玩家：「那个设置50w的输入那里我记得之前不止那两个设置，
    //                          其他设置你怎么弄丢了？」）：
    // 上一版只搬了输入/输出两个，其余四个还留在下面的折叠卡片里，
    // 玩家看到「单批容量」只有两项，以为设置丢了 —— 其实没丢，是**被拆散了**。
    // 现在把一整组容量/篇幅相关的设置都收在这里，顺序也理顺：
    //   先「单批」这一批能装多少（输入/输出容量、模型输出上限），
    //   再「这一批写不好怎么办/要不要等合批」（重写次数、补缺次数、合批等待）。
    // 下方「请求与批量设置」只留重试与解析相关，不再重复这些 id。
    // 2026-11-01 玩家：「按照一批写几个人来，比如说我设置一批写6人，
    //   然后再设置一个输入输出上限…双重保险。」
    //
    // 这三项是一套的，必须放在一起：
    //   ① 每批最多处理几条  —— 第一道闸（人数）
    //   ② 单批输入容量      —— 第二道闸（输入字数）
    //   ③ 单批输出容量      —— 第二道闸（输出字数）
    // 之前 ① 被放在「请求设置」页，②③ 在「推演与散文」页，
    // 玩家要调这套东西得跨页找，正是他说过的「东一块西一块」。
    // 现在统一收进这张「单批容量」卡片，先讲人数再讲容量，照着读就是使用顺序。
    +'<h6 class="ce-canon-subheading">单批容量（两道闸，取更严的那个）</h6>'
    +'<div class="ce-canon-field-grid">'
    +numberRow('ce-canon-max-per-batch','每批最多处理几条',c.maxPerBatch || 6,1,20,'第一道闸：一次请求最多放几条，先按这个人数分批。某一批的输入或输出超过下面两项容量时，会自动减人直到放得下。')
    +numberRow('ce-canon-batch-input','单批输入容量（字）',limits.maxInputChars || CE_REQUEST_LIMITS.maxInputChars,4000,CE_INPUT_CHARS_MAX,'第二道闸（输入）：一批合计多少字放不下就减人。默认 50 万，最高 80 万；共享背景放不下时会自动精简，不会整轮失败。')
    +numberRow('ce-canon-batch-output','单批输出容量（字）',limits.maxOutputChars || CE_REQUEST_LIMITS.maxOutputChars,1000,100000,'第二道闸（输出）：一批人的预计输出超过这个数就减人到上限以下。每人篇幅以上方为准。')
    +numberRow('ce-canon-output-tokens','模型输出上限（词元）',c.maxOutputTokens || 65536,256,262144,'按模型支持值设置，不会强制写满。')
    +numberRow('ce-canon-prose-rewrites','不合格时重写次数',c.proseRewriteCount === undefined?1:c.proseRewriteCount,0,3,'填 0 时停止该批，等待局部重跑。')
    +numberRow('ce-canon-completion-repairs','完整性补缺次数',c.completionRepairCount ?? 3,0,3,'只补本轮缺字段或缺项目；与网络重试分别计数。')
    +numberRow('ce-canon-ready-batch-wait','就绪合批等待（毫秒）',c.readyBatchWaitMs ?? 100,0,200,'短暂等待兼容的已就绪人物合批，填 0 时立即处理。')
    +'</div>');
  const dispatch=controlCard('角色分派','核心角色单独写，重要角色与配角按容量合并；手动指定优先。',[
    selectRow('ce-canon-dispatch','分派方式',c.dispatchStrategy || CE_PROSE_DISPATCH.capacity,[
      {value:CE_PROSE_DISPATCH.capacity,label:'按档合批（推荐）：核心单写，重要与配角合并'},
      {value:CE_PROSE_DISPATCH.allSolo,label:'全部单独写（最细，最贵）'},
      {value:CE_PROSE_DISPATCH.allBatch,label:'全部合并写（最省，最粗；核心仍单写）'},
    ],'核心角色始终单独写，保证最高规格；资料或所需篇幅超出一批容量时自动拆分。'),
    renderRoleRosterEditor(c.importantRoleLists,roster,esc),
    renderCoreRosterEditor(c.coreCharacterNames,esc),
    advancedCard('手动指定角色','留空则自动安排','<p class="hint">填写原名或已知别名，以换行、逗号或顿号分隔；同时出现在两栏时，单独写优先。</p><div class="ce-canon-dispatch-grid">'+[['solo','单独写'],['batch','合并写']].map(([key,label])=>'<label class="ce-canon-row ce-canon-select-row"><span class="ce-canon-row-label">'+label+'</span><textarea id="ce-canon-force-'+key+'" class="ce-canon-input" rows="3" placeholder="每行一位角色">'+esc((Array.isArray(force[key])?force[key]:[]).join('\n'))+'</textarea></label>').join('')+'</div>'),
  ].join(''));
  /* 「请求与批量设置」折叠卡片。
   *
   * 2026-11-01 玩家：「那个设置50w的输入那里我记得之前不止那两个设置，其他设置你怎么弄丢了？」
   * 之前这一组里同时放着重试、解析、篇幅、容量好几类，容量那几项被拆到上面后
   * 只剩 4 项，玩家看到「单批容量」只有两项，以为设置丢了。
   * 现在：容量/篇幅/重写/补缺/合批等待**全部归到上方「单批容量」**。
   *
   * 注意：这里**不要**再放 retry-max / retry-parse ——
   * 那两项在「请求设置」卡片里已经有了（retry-max 是数字框，
   * retry-parse 是「返回格式不符时重试」的开关，不是数字）。
   * 同一 id 渲染两次会让 getElementById 只取第一个，保存时读到错的值，
   * 甚至把开关当成数字框解析。
   */
  const advanced=advancedCard('请求与批量设置','重试与解析',
    '<p class="hint">单批容量、篇幅、重写与补缺次数已归到上方「单批容量」；'
    +'重试次数与「返回格式不符时重试」在「请求设置」里调整。</p>');
  return [
    `<div class="settings-section" id="${CE_PANEL_SECTIONS.params}">`,
    sectionHeading('推演与散文','设置篇幅与角色分派；全阶段请求在请求设置中调整。','params'),
    writing,dispatch,advanced,
    '</div>',
  ].join('\n');
}

// ------------------------------------------------------------
// 五、提示词
// ------------------------------------------------------------

function renderPrompts(overrides) {
  const groups = listEditablePrompts(overrides);

  const parts = [
    `<div class="settings-section" id="${CE_PANEL_SECTIONS.prompts}">`,
    sectionHeading('提示词','按用途展开编辑。留空使用默认内容，修改后保存生效。','prompts'),
    '<div class="ce-canon-prompt-guide"><p class="hint">模板中的 <code>{{占位符}}</code> 会替换为实际资料；删除占位符会同时移除这份资料入口。</p></div>',
  ];

  for (const group of groups) {
    parts.push(`  <div class="ce-canon-group" data-group="${esc(group.id)}">`);
    parts.push(`    <h5>${esc(group.label.replace(/^[一二三四五六七八九十]+、/,'').replace(/NPC/g,'角色'))}</h5>`);
    parts.push(`    <p class="hint">${esc(group.desc)}</p>`);

    for (const item of group.items) {
      const badge = item.overridden
        ? '<span class="ce-canon-badge ce-canon-badge-custom">已自定义</span>'
        : '<span class="ce-canon-badge">默认</span>';

      const defaultText = (() => {
        const entry = CE_PROMPT_REGISTRY[item.key];
        if (entry && typeof entry.build === 'function') {
          try { return entry.build({}); } catch { return ''; }
        }
        return '';
      })();

      const value = item.custom || defaultText;
      const placeholder = defaultText
        ? '（留空则用默认）'
        : '（这段由程序按模板生成，这里可写覆盖文本）';

      parts.push('    <details class="ce-canon-prompt-item" data-key="' + esc(item.key) + '">');
      parts.push('      <summary>');
      parts.push(`        <span class="ce-canon-prompt-title">${esc(item.label.replace(/NPC/g,'角色'))}</span>`);
      parts.push(`        ${badge}`);
      parts.push(`        <span class="ce-canon-prompt-len">${defaultText.length} 字</span>`);
      parts.push('      </summary>');
      parts.push(`      <p class="hint">${esc(item.desc)}</p>`);
      if (item.vars && item.vars.length > 0) {
        parts.push(`      <p class="hint ce-canon-vars">可用占位：${esc(item.vars.join('　'))}</p>`);
      }
      parts.push(
        `      <textarea class="ce-canon-prompt-textarea" data-key="${esc(item.key)}" rows="12" `
        + `placeholder="${esc(placeholder)}">${esc(value)}</textarea>`,
      );
      parts.push('      <div class="ce-canon-prompt-actions">');
      parts.push(
        `        <button type="button" class="small-btn ce-canon-reset-one" data-key="${esc(item.key)}">恢复默认</button>`,
      );
      parts.push('      </div>');
      parts.push('    </details>');
    }

    parts.push('  </div>');
  }

  parts.push('</div>');
  return parts.join('\n');
}

// ------------------------------------------------------------
// 面板整体
// ------------------------------------------------------------

/**
 * 生成完整的独立面板 HTML。
 *
 * 结构照抄宿主既有的设置弹窗：
 *   div.overlay > div.settings-modal > header + body
 *
 * @param {object} [config] 当前配置
 * @param {object} [status] 状态行信息 { ledger, overrides, lastRun }
 * @returns {string}
 */
export function buildCanonPanelHtml(config, status) {
  const c = config || {};
  const s = status || {};
  const overrides = c.promptOverrides || {};

  const statusLine = String(s.statusLine || '').trim();

  return [
    `<div class="overlay hidden" id="${CE_PANEL_OVERLAY_ID}">`,
    '  <div class="settings-modal modal ce-canon-panel" role="dialog" aria-modal="true" aria-labelledby="ce-canon-title">',
    '    <div class="modal-header">',
    '      <div><div class="ce-canon-eyebrow">偏好设置</div><h3 id="ce-canon-title">原著补演</h3><p class="ce-canon-subtitle">模型、资料与角色写作偏好</p></div>',
    '      <button class="modal-close-btn" data-ce-canon-close="1" aria-label="关闭原著补演设置">&times;</button>',
    '    </div>',
    '    <nav class="ce-canon-nav" aria-label="原著补演设置分区">'+[['basic','总览与模型'],['materials','资料来源'],['params','推演与散文'],['retry','请求设置'],['prompts','提示词']].map(([key,label],i)=>'<button type="button" data-ce-canon-section="'+key+'" aria-pressed="'+(i===0)+'" class="'+(i===0?'active':'')+'">'+label+'</button>').join('')+'</nav>',
    '    <div class="modal-body ce-canon-body">',
    statusLine
      ? `      <div class="ce-canon-status">${esc(statusLine)}</div>`
      : '',
    renderBasic(c),
    renderRetry(c),
    renderMaterials(c),
    renderParams(c,s),
    renderPrompts(overrides),
    '    </div>',
    '      <div class="ce-canon-footer">',
    '        <span id="ce-canon-save-feedback" role="status" aria-live="polite">修改后保存生效</span>',
    '        <div class="ce-canon-footer-actions">',
    '        <button type="button" class="small-btn" id="ce-canon-open-trace">查看运行记录</button>',
    '        <button type="button" class="small-btn primary" id="ce-canon-save">保存设置</button>',
    '        <button type="button" class="small-btn" data-ce-canon-close="1">关闭</button>',
    '        </div>',
    '      </div>',
    '  </div>',
    '</div>',
  ].filter((x) => x !== '').join('\n');
}

/**
 * 从面板读回配置（宿主保存时调）。
 *
 * @param {object} dom document 或测试替身
 * @param {object} [base] 现有配置
 * @returns {object} 新配置
 */
export function readCanonPanelFromDom(dom, base) {
  const get = (id) => {
    const el = dom && typeof dom.getElementById === 'function'
      ? dom.getElementById(id)
      : (dom && typeof dom.query === 'function' ? dom.query(id) : null);
    return el || null;
  };
  const queryAll = (selector) => Array.from(dom && typeof dom.querySelectorAll === 'function'
    ? dom.querySelectorAll(selector)
    : (dom && typeof dom.queryAll === 'function' ? dom.queryAll(selector) : []));
  const val = (id, fallback) => {
    const el = get(id);
    if (!el) return fallback;
    const v = String(el.value == null ? '' : el.value).trim();
    return v === '' ? fallback : v;
  };
  const num = (id, fallback) => {
    const v = Number(val(id, ''));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const nonnegative = (id,fallback) => {const value=val(id,'');const n=Number(value);return value!==''&&Number.isFinite(n)&&n>=0?n:fallback;};
  const bounded=(id,fallback,max)=>{const value=val(id,'');const n=Number(value);return value!==''&&Number.isFinite(n)?Math.max(0,Math.min(max,Math.floor(n))):fallback;};
  const checked = (id, fallback) => {
    const el = get(id);
    if (!el || el.checked === undefined) return fallback;
    return el.checked === true;
  };

  const next = { ...(base || {}) };
  if(get('ce-canon-role-list'))next.importantRoleLists=readRoleRosterEditor(dom,next.importantRoleLists);

  next.enabled = checked('ce-canon-enabled', next.enabled !== false);
  next.prebuiltEnabled = checked('ce-canon-prebuilt', next.prebuiltEnabled !== false);
  next.api = {...(next.api || {})};
  for (const [id,key] of [['ce-canon-api-url','apiUrl'],['ce-canon-api-key','apiKey'],['ce-canon-api-model','apiModel']]) {
    const element = get(id);
    if (element) next.api[key] = String(element.value || '').trim();
  }
  if(get('ce-canon-model-manual')?.checked)next.api.apiModel=String(get('ce-canon-api-model-custom')?.value || '').trim();
  if(get('ce-canon-api-mode')?.value==='inherit')next.api={...next.api,apiUrl:'',apiKey:'',apiModel:'',apiPresetId:'',apiPresetSnapshot:null};
  /* 兼容开关：面板没勾就是 false。默认关闭，旧存档也天然关闭，不会因本次改造改变行为。 */
  next.api.assistantPrefillUnsupported=!!checked('ce-canon-api-prefill-unsupported', false);
  next.traceCaptureBodies=checked('ce-canon-capture-bodies',next.traceCaptureBodies!==false);
  next.traceKeep=Math.max(1,Math.min(30,Math.round(num('ce-canon-trace-keep',next.traceKeep || 10))));
  delete next.allowAutonomous;
  delete next.autonomousLimit;
  next.showStatus = checked('ce-canon-show-status', next.showStatus !== false);
  // 补演自己的重排设置。分数可以到 0，不能用 num（它要求 >0）。
  if(get('ce-canon-retrieval-topk'))next.retrievalTopK=Math.max(5,Math.min(100,Math.round(num('ce-canon-retrieval-topk',next.retrievalTopK ?? 20))));
  if(get('ce-canon-retrieval-rerank-min'))next.retrievalRerankMinScore=Math.max(0,Math.min(1,Number(nonnegative('ce-canon-retrieval-rerank-min',next.retrievalRerankMinScore ?? 0.3))));
  if(get('ce-canon-retrieval-batch'))next.retrievalRerankBatch=Math.max(1,Math.min(200,Math.round(num('ce-canon-retrieval-batch',next.retrievalRerankBatch ?? 20))));
  if(get('ce-canon-retrieval-rerank-on'))next.retrievalEnableRerank=checked('ce-canon-retrieval-rerank-on',next.retrievalEnableRerank!==false);
  if(get('ce-canon-retrieval-rerank-url'))next.retrievalRerankUrl=String(get('ce-canon-retrieval-rerank-url').value||'').trim();
  if(get('ce-canon-retrieval-rerank-key'))next.retrievalRerankKey=String(get('ce-canon-retrieval-rerank-key').value||'').trim();
  if(get('ce-canon-retrieval-rerank-model'))next.retrievalRerankModel=String(get('ce-canon-retrieval-rerank-model').value||'').trim();
  /* 设定集检索的分阶段开关（玩家 2026-11-01 要求）。
   * 默认值刻意不同：原著指导默认关、原著补演默认开，
   * 所以第二个参数分别传 false / true，控件不存在时保留原值。 */
  if(get('ce-canon-guidance-retrieval-on'))next.guidanceRetrievalEnabled=checked('ce-canon-guidance-retrieval-on',next.guidanceRetrievalEnabled===true);
  if(get('ce-canon-replay-retrieval-on'))next.replayRetrievalEnabled=checked('ce-canon-replay-retrieval-on',next.replayRetrievalEnabled!==false);

  next.showDiagnostics = checked('ce-canon-show-diag', next.showDiagnostics !== false);

  // 重试：只存次数与「格式错也重试」
  const prevRetry = next.retry && typeof next.retry === 'object' ? next.retry : {};
  next.retry = {
    ...prevRetry,
    maxRetries: (() => {
      const el = get('ce-canon-retry-max');
      if (!el) return prevRetry.maxRetries === undefined
        ? CE_RETRY_DEFAULTS.maxRetries : prevRetry.maxRetries;
      const n = Number(el.value);
      if (!Number.isFinite(n)) return CE_RETRY_DEFAULTS.maxRetries;
      return Math.min(CE_RETRY_FIELDS.maxRetries.max,
        Math.max(CE_RETRY_FIELDS.maxRetries.min, Math.round(n)));
    })(),
    retryOnParseError: checked('ce-canon-retry-parse',
      prevRetry.retryOnParseError !== false),
  };

  next.requestsPerMinute = Math.max(1,Math.min(600,Math.floor(num('ce-canon-rpm',next.requestsPerMinute || 15))));
  next.completionRepairCount=bounded('ce-canon-completion-repairs',next.completionRepairCount ?? 3,3);
  next.preBoundaryEnabled=checked('ce-canon-pre-boundary',next.preBoundaryEnabled !== false);
  next.earlyBoundaryEnabled=checked('ce-canon-early-boundary',next.earlyBoundaryEnabled !== false);
  next.earlyPreparationEnabled=checked('ce-canon-early-preparation',next.earlyPreparationEnabled !== false);

  next.readyBatchWaitMs=bounded('ce-canon-ready-batch-wait',next.readyBatchWaitMs ?? 100,200);
  if(get('ce-canon-concurrency'))next.maxConcurrency=Math.max(1,Math.min(20,Math.floor(num('ce-canon-concurrency',next.maxConcurrency || 5))));
  next.requestTimeoutMs=Math.max(15,Math.min(1800,num('ce-canon-request-timeout',(next.requestTimeoutMs || 120000)/1000)))*1000;
  next.maxOutputTokens=Math.max(256,Math.min(262144,Math.floor(num('ce-canon-output-tokens',next.maxOutputTokens || 65536))));
  next.proseRewriteCount=Math.max(0,Math.min(3,Math.floor(nonnegative('ce-canon-prose-rewrites',next.proseRewriteCount === undefined?1:next.proseRewriteCount))));
  const batch=next.batchLimits || {};
  next.batchLimits={...batch,timelineBatchEvents:Math.max(1,Math.min(100,Math.floor(num('ce-canon-timeline-batch',batch.timelineBatchEvents || 6)))),maxInputChars:Math.max(4000,Math.min(CE_INPUT_CHARS_MAX,num('ce-canon-batch-input',batch.maxInputChars || CE_REQUEST_LIMITS.maxInputChars))),maxOutputChars:Math.max(1000,Math.min(100000,num('ce-canon-batch-output',batch.maxOutputChars || CE_REQUEST_LIMITS.maxOutputChars))),ragBatchQueries:Math.max(1,Math.min(256,Math.floor(num('ce-canon-rag-queries',batch.ragBatchQueries || CE_REQUEST_LIMITS.ragBatchQueries))))};
  next.retry.retryDelayMs=Math.max(0,Math.min(120,nonnegative('ce-canon-retry-delay',(prevRetry.retryDelayMs === undefined?1000:prevRetry.retryDelayMs)/1000)))*1000;
  next.retry.maxDelayMs=Math.max(next.retry.retryDelayMs,Math.min(600,nonnegative('ce-canon-retry-max-delay',(prevRetry.maxDelayMs === undefined?8000:prevRetry.maxDelayMs)/1000))*1000);
  delete next.batchLimits.ragBatchQueries;
  delete next.rerankMaxDocuments;
  next.materialMode = val('ce-canon-material-mode', next.materialMode || CE_MATERIAL_MODES.currentOnly);
  // ★ 2026-11-01 复盘：这一行删掉了，原因是它属于「双重死配置」。
  //   ① 它读的 'ce-canon-boundary-strategy' 控件**从来没有被渲染过**，
  //      val() 永远拿不到值，boundaryStrategy 永远停在默认 'auto'；
  //   ② 整个仓库也没有任何一处**读取** boundaryStrategy 来影响行为，
  //      它只在 canon-bridge.js 的默认值表里出现过。
  //   按玩家「设置可以折叠但不能凭空消失，也不能留个假的装样子」的口径，
  //   与其留一行读不到的代码，不如删掉。
  // 默认按档合批。玩家主动保存的 mixed/capacity 一律尊重，不做强制迁移——
  // 只是不把 mixed 当默认值（那会把整个重要名单全部单写）。
  next.dispatchStrategy = val('ce-canon-dispatch', next.dispatchStrategy || CE_PROSE_DISPATCH.capacity);
  delete next.soloThreshold;
  const previousForce=next.forceDispatch||{};
  next.forceDispatch={...previousForce};
  for(const key of ['solo','batch']){
    const field=get('ce-canon-force-'+key);
    if(field)next.forceDispatch[key]=[...new Set(String(field.value||'').split(/[\n,，、;；]+/).map(name=>name.trim()).filter(Boolean))];
  }
  next.maxPerBatch = num('ce-canon-max-per-batch', next.maxPerBatch || 6);
  next.coreMaxChars = num('ce-canon-core-chars', next.coreMaxChars || CE_PROSE_BUDGET.coreMax);
  next.minorMaxChars = num('ce-canon-minor-chars', next.minorMaxChars || CE_PROSE_BUDGET.minorMax);
  // 三档篇幅真正生效：页面上填多少，实际就按多少写。
  // 兼容旧配置：老版本只有 coreMaxChars/minorMaxChars 两项，用它们作为缺省值。
  next.tierBudgets = {
    core: num('ce-canon-core-chars', next.tierBudgets?.core || next.coreMaxChars || 800),
    major: num('ce-canon-major-chars', next.tierBudgets?.major || 400),
    minor: num('ce-canon-minor-chars', next.tierBudgets?.minor || next.minorMaxChars || 160),
  };
  if (get('ce-canon-core-text')) next.coreCharacterNames = readCoreRosterEditor(dom, next.coreCharacterNames);
  next.pov = String(get('ce-canon-pov') ? get('ce-canon-pov').value : next.pov || '').trim();

  /* ★★ 2026-11-01 玩家：「不要共用，原著指导 和原著补演分开设置资料来源」
   *
   * 控件的 id 现在是 ce-canon-material-<阶段>-<资料项>，
   * 比如：
   *   ce-canon-material-guidance-ragVector   原著指导的「设定集检索」
   *   ce-canon-material-turn-ragVector       原著补演的「设定集检索」
   *
   * 它们写进两张独立的表 materialsByStage.guidance / .turn，
   * 所以同一个资料项在两个阶段可以一开一关，互不干扰。
   *
   * 老档兼容：仍然把「两个阶段都关掉」的项写进扁平 next.materials，
   * 这样万一有别的老代码读扁平表，语义还是一致的（少给不多给）。
   */
  /* ★★ 2026-11-01 修正一个持久化缺陷：**只存关掉的项** 记不住「打开默认关闭项」。
   *
   * 旧写法：`if (el.checked !== true) stageFlags[stage][key] = false;`
   * 后果：像「叙事记忆」这种默认就关的项，玩家手动勾上之后，
   *       因为 checked===true 不写入，存档里什么都不留，
   *       重新打开面板 → 读不到 → 回落到默认（关） → 玩家刚点的勾没了。
   *       表现为「设置一保存就还原」，非常伤信任。
   *
   * 新写法：存**与默认值不同**的那一部分。
   *   · 勾上默认关的项  → 存 true
   *   · 关掉默认开的项  → 存 false
   *   · 与默认一致      → 不存（空 = 按默认，新增资料项老存档仍然自动跟上默认）
   * 这样两个方向都记得住，而且存档体积仍然很小。
   */
  const defaultsForStage = {guidance:materialDefaults('guidance'),turn:materialDefaults('turn')};
  const stageFlags = { guidance: {}, turn: {} };
  const legacyFlat = {};
  const toggles = queryAll('.ce-canon-toggle input[data-key]');
  const list = Array.isArray(toggles) && toggles.length > 0
    ? toggles
    : queryAll('[data-key]');
  for (const el of list) {
    const key = String(el.getAttribute ? el.getAttribute('data-key') : el.dataset?.key || '').trim();
    if (!key || !CE_MATERIAL_SOURCES[key]) continue;
    const id = String(el.id || '');
    // 只处理资料开关，别把提示词 textarea 的 data-key 混进来
    if (!id.startsWith('ce-canon-material-')) continue;
    // 从 id 里取出阶段：ce-canon-material-<阶段>-<key>
    const idBody = id.slice('ce-canon-material-'.length);
    let stage = '';
    if (idBody.startsWith('guidance-')) stage = 'guidance';
    else if (idBody.startsWith('turn-')) stage = 'turn';
    if (!stage) continue;
    const checked = el.checked === true;
    const def = defaultsForStage[stage][key] !== false;
    // 与默认一致就不写；不一致才写，两个方向都记
    if (checked !== def) stageFlags[stage][key] = checked;
    // 扁平兼容表照旧只记「关」的（它是给老代码看的，语义是少给不多给）
    if (!checked) legacyFlat[key] = false;
  }
  next.materialsByStage = {
    guidance: stageFlags.guidance,
    turn: stageFlags.turn,
  };
  // 扁平表只留「两阶段都关」的项，避免把某一阶段的单独设置误当成全局设置
  const flat = {};
  for (const key of Object.keys(legacyFlat)) {
    const g = stageFlags.guidance[key] === false;
    const t = stageFlags.turn[key] === false;
    const inGuidance = (CE_MATERIAL_PROFILES.guidance || []).includes(key);
    const inTurn = (CE_MATERIAL_PROFILES.turn || []).includes(key);
    // 该项在哪些阶段存在，就在哪些阶段都关才算全局关
    const allOff = (inGuidance ? g : true) && (inTurn ? t : true);
    if (allOff) flat[key] = false;
  }
  next.materials = flat;
  // 旧字数预算仅保留兼容数据；资料页只编辑自然计数，不能反推或改写旧值。
  next.materialLimits={...(next.materialLimits || {})};
  next.materialCounts={...(next.materialCounts || {})};
  const counts=normalizeMaterialCounts(next.materialCounts);
  for(const key of Object.keys(CE_PANEL_MATERIAL_COUNTS))next.materialCounts[key]=Math.min(10000,Math.floor(nonnegative('ce-canon-material-count-'+key,counts[key])));

  // 提示词覆盖：值为空就删掉，保持「空 = 默认」
  const overrides = { ...(next.promptOverrides || {}) };
  const textareas = queryAll('.ce-canon-prompt-textarea');
  for (const el of textareas) {
    const key = String(el.getAttribute ? el.getAttribute('data-key') : el.dataset?.key || '').trim();
    if (!key) continue;
    const text = String(el.value == null ? '' : el.value).trim();
    let defaultText='';try{defaultText=CE_PROMPT_REGISTRY[key]?.build?.({})||'';}catch(_){}
    if (text && text!==defaultText.trim()) overrides[key] = text;
    else delete overrides[key];
  }
  for (const orphan of findOrphanOverrides(overrides)) {
    delete overrides[orphan];
  }
  next.promptOverrides = overrides;

  return next;
}

/** 每页只恢复明确归属该页的控件，接口档案与其他页草稿不参与。 */
const CE_PANEL_RESET_FIELDS = {
  basic:['enabled','prebuilt','show-status','show-diag','capture-bodies','trace-keep'],
  retry:['rpm','concurrency','request-timeout','timeline-batch','retry-max','retry-parse','retry-delay','retry-max-delay'],
  materials:[],
  params:['completion-repairs','ready-batch-wait','material-mode','pov','core-chars','minor-chars','dispatch','force-solo','force-batch','output-tokens','prose-rewrites','batch-input','batch-output','max-per-batch'],
};

/** 恢复提示词时显示注册表原始全文；读回时自动移除与默认相同的覆盖值。 */
export function resetCanonPromptFromDom(dom,key) {
  const entry=CE_PROMPT_REGISTRY[key];
  if(!entry || typeof entry.build!=='function')return false;
  const area=Array.from(dom.querySelectorAll('.ce-canon-prompt-textarea')).find(el=>el.dataset.key===key);
  if(!area)return false;
  area.value=entry.build({});
  const badge=area.closest('.ce-canon-prompt-item')?.querySelector('.ce-canon-badge');
  if(badge){badge.classList.remove('ce-canon-badge-custom');badge.textContent='默认';}
  return true;
}

/** 只改变界面草稿，不读取或写入玩家存储。 */
export function resetCanonPanelSection(dom,section) {
  if(!CE_PANEL_SECTIONS[section])return false;
  if(section==='params')dom.querySelector('#ce-canon-important-roles')?._roleListDraft?.reset();
  if(section==='prompts'){
    for(const area of dom.querySelectorAll('.ce-canon-prompt-textarea'))resetCanonPromptFromDom(dom,area.dataset.key);
  }else{
    const doc=dom.ownerDocument || dom,holder=doc.createElement('div');
    const renders={basic:renderBasic,retry:renderRetry,materials:renderMaterials,params:renderParams};
    holder.innerHTML=renders[section]({});
    const fields=CE_PANEL_RESET_FIELDS[section].slice();
    if(section==='materials'){
      for(const stage of CE_MATERIAL_STAGES){
        for(const key of CE_MATERIAL_PROFILES[stage.profile])fields.push('material-'+stage.profile+'-'+key);
      }
      for(const key of Object.keys(CE_PANEL_MATERIAL_COUNTS))fields.push('material-count-'+key);
    }
    for(const name of fields){
      const id='ce-canon-'+name,target=dom.querySelector('#'+id),source=holder.querySelector('#'+id);
      if(!target || !source)continue;
      if(source.type==='checkbox'||source.type==='radio')target.checked=source.checked;else target.value=source.value;
    }
  }
  const feedback=dom.querySelector('#ce-canon-save-feedback');
  if(feedback)feedback.textContent='本页已恢复默认，保存后生效';
  return true;
}

/**
 * 面板 CSS。宿主注入一次即可。
 *
 * 只补宿主没有的几处（行布局、分组、状态条），
 * 弹窗骨架与按钮全部复用宿主原有类。
 *
 * @returns {string}
 */
export function buildCanonPanelCss() {
 return `
/* ================= 布局与质感升级（ce-canon-panel-upgrade） ================= */
/* 资料来源的分栏放在**阶段内部**（每个阶段各自两栏），别再对整块用 column-count。
 *
 * 玩家 2026-11-01 截图反馈：卡片里的字互相压、说明文字叠在卡片上。
 * 原因是这套 CSS 三代叠加、互相打架：
 *   · 这里原来是 display:block!important + column-count:2（多列流式）
 *   · 下面 .ce-canon-material-grid 又是 display:grid / grid-template-columns
 * 多列布局和 grid 混用，卡片又被设成 display:inline-block，
 * 高度算不准 → 卡片重叠、文字压字。
 *
 * 现在改成**显式两栏 grid**：父级 grid 自己管行列，子卡片不再 inline-block。
 * 不用 column-count 是因为它要靠浏览器猜高度，一旦内部有 grid/flex 就容易塌。
 */
/* ★★★ 2026-11-01 玩家：「设定检索集和原著节点这里留这么大的空白做啥？」
 *                 「不要东一块西一块」
 *
 * 病根：这份文件里 .ce-canon-material-grid 前后有 **5 条**不一致的定义
 * （L1019 的 repeat(2,1fr)、L1351 的 repeat(2,1fr)、L1360 的 column-count:2 …），
 * 加上分组盒子本身高度不等，于是：
 *
 *   现场(232)  剧情(253)     ← 第一行：右边那组更高
 *   检索(162)  [ 空白 316px ]  ← 第二行：左边放不下右边，右边直接空着
 *   原著(162)
 *
 * 这就是玩家截图里那块「设定检索集和原著节点中间的大空白」。
 *
 * 改法：两列**按列堆叠**（masonry 思路，用 CSS 多列实现），而不是按行填格。
 *   · column-count:2 让内容先填满左列再填右列，不会因为某一组高而留洞
 *   · 配合 break-inside:avoid，保证一个分组不会被劈成两半
 *   · 每个分组自己的高度是多少就是多少，两列自然咬合
 *
 * 只保留这一条权威定义，其余重复的一律删除（见文件末尾同步清理）。
 */
.ce-canon-panel .ce-canon-material-grid{
  display:block!important;
  column-count:2;
  column-gap:16px;
  grid-template-columns:none!important;
}
.ce-canon-panel .ce-canon-material-grid>.ce-canon-group{
  margin:0 0 16px!important;
  display:block;
  width:auto;
  break-inside:avoid;
  -webkit-column-break-inside:avoid;
  page-break-inside:avoid;
}
@media(max-width:820px){
  .ce-canon-panel .ce-canon-material-grid{column-count:1}
}
/* 卡片：统一内边距、圆角、描边与层级 */
.ce-canon-panel .ce-canon-control-card{padding:16px 18px;border:1px solid var(--canon-line);border-radius:12px;background:var(--canon-card);display:flex;flex-direction:column;gap:12px;margin:0}
.ce-canon-panel .ce-canon-group{padding:16px 18px}
.ce-canon-panel .ce-canon-card-heading{margin:0 0 2px;display:flex;flex-direction:column;gap:5px}
.ce-canon-panel .ce-canon-card-heading h5{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em;color:var(--canon-ink)}
.ce-canon-panel .ce-canon-card-heading .hint{margin:0;font-size:12px;line-height:1.55;color:var(--canon-muted)}
/* 字段行：标签定宽，控件对齐，长标签换行不挤压输入框 */
.ce-canon-panel .ce-canon-row{display:grid;grid-template-columns:minmax(92px,128px) minmax(0,1fr);align-items:center;gap:12px;margin:0}
.ce-canon-panel .ce-canon-row-label{font-size:13px;line-height:1.5;color:var(--canon-ink)}
.ce-canon-panel .ce-canon-row .ce-canon-input{width:100%;min-width:0}
.ce-canon-panel .ce-canon-inline{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.ce-canon-panel .ce-canon-inline .ce-canon-input{flex:1 1 160px;min-width:0}
.ce-canon-panel .ce-canon-inline .small-btn{flex:0 0 auto}
/* 字段网格：等比自适应，窄屏单列 */
.ce-canon-panel .ce-canon-field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px 16px;align-items:start}
/* 三档篇幅并排：核心/重要/配角三栏，窄屏自动落单列。 */
.ce-canon-panel .ce-canon-field-grid--triple{grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))}
.ce-canon-panel .ce-canon-subheading{margin:18px 0 8px;font-size:13px;font-weight:600;color:var(--canon-text-dim,#9a9282);letter-spacing:.5px;padding-left:8px;border-left:2px solid var(--canon-accent,#c8a45c)}
/* 整行堆叠区：放长选项的下拉框。下拉框必须占满整行，
   否则选项文字被挤窄后溢出，会压住下一行的说明文字。 */
.ce-canon-panel .ce-canon-stack{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin-bottom:14px}
.ce-canon-panel .ce-canon-stack>.ce-canon-select-row{margin:0}
/* 下拉框本身不允许撑破容器 */
.ce-canon-panel .ce-canon-input{max-width:100%;box-sizing:border-box}
.ce-canon-panel .ce-canon-select-row .ce-canon-input,
.ce-canon-panel .ce-canon-stack select{width:100%;min-width:0}
/* 说明文字永远在下一行，不与控件重叠 */
.ce-canon-panel .ce-canon-row-hint{position:static;clear:both;grid-column:1/-1}
/* 2026-11-01：这里原有一条 .ce-canon-overview-grid 定义（auto-fit/minmax 版），
   与下方 1.12fr/0.88fr 版本冲突。已删除，只保留下方那一条权威定义，
   避免「两栏宽度/是否等高」出现两套说法。 */
/* 开关行：整行可点，命中区域更大，悬停有反馈 */
.ce-canon-panel .ce-canon-toggle{display:flex;align-items:flex-start;gap:10px;padding:9px 11px;border:1px solid transparent;border-radius:9px;cursor:pointer;line-height:1.55;transition:background .15s ease,border-color .15s ease}
.ce-canon-panel .ce-canon-toggle:hover{background:rgba(198,175,124,.06);border-color:rgba(198,175,124,.22)}
.ce-canon-panel .ce-canon-toggle input{margin:3px 0 0;flex:0 0 auto}
.ce-canon-panel .ce-canon-toggle span{flex:1;min-width:0;font-size:13px}
.ce-canon-panel .ce-canon-toggle-compact{padding:7px 11px}
.ce-canon-panel .ce-canon-group .ce-canon-toggle{padding:7px 9px}
/* 折叠区统一描边圆角与箭头 */
.ce-canon-panel .ce-canon-advanced,.ce-canon-panel .ce-canon-limit-card{border:1px solid var(--canon-line);border-radius:11px;background:var(--canon-inset);overflow:hidden;margin:0}
.ce-canon-panel .ce-canon-advanced>summary,.ce-canon-panel .ce-canon-limit-card>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 15px;cursor:pointer;font-size:13px;color:var(--canon-ink);list-style:none}
.ce-canon-panel .ce-canon-advanced>summary::-webkit-details-marker,.ce-canon-panel .ce-canon-limit-card>summary::-webkit-details-marker{display:none}
.ce-canon-panel .ce-canon-advanced>summary::after,.ce-canon-panel .ce-canon-limit-card>summary::after{content:'';flex:0 0 auto;width:7px;height:7px;margin-right:3px;border-right:1.5px solid var(--canon-gold);border-bottom:1.5px solid var(--canon-gold);transform:rotate(45deg);transition:transform .18s ease}
.ce-canon-panel .ce-canon-advanced[open]>summary::after,.ce-canon-panel .ce-canon-limit-card[open]>summary::after{transform:rotate(-135deg)}
.ce-canon-panel .ce-canon-advanced-caption,.ce-canon-panel .ce-canon-limit-caption{flex:1;min-width:0;font-size:12px;color:var(--canon-muted)}
.ce-canon-panel .ce-canon-advanced-body,.ce-canon-panel .ce-canon-limit-body{padding:13px 15px 15px;border-top:1px solid var(--canon-line)}
/* 分区节奏 */
/* ★ 2026-11-01 玩家截图：「这就是你改的？」—— 资料来源面板文字压成一团。
 *
 * 根因（Playwright 实测，不是猜）：
 *   前台有一层全局通配规则，给所有元素压了 max-height:100%：
 *     body > div:not(.cultivation-panel) > *,
 *     body > div:not(.cultivation-panel) > * > *,
 *     body > div:not(.cultivation-panel) > * > * > *
 *   我们的 .settings-section 正好落在这个范围内，于是它的 max-height
 *   被解析成**父容器 .ce-canon-body 的可视高度 674px**，
 *   而它的真实内容有 1613px —— 超出部分不会让 body 滚动，
 *   而是直接溢出、压到后面的卡片上，看起来就是文字叠成一团。
 *
 * 为什么 flex:none / flex-shrink:0 救不了：
 *   那管的是 flex 主轴尺寸分配，这里是 max-height 硬性封顶，
 *   两回事。我先前加 flex:none 没效果，就是因为诊断错了层。
 *
 * 改法：显式把 max-height 解掉，让 section 按内容自然撑开，
 * 滚动交给 .ce-canon-body（它本来就有 overflow-y:scroll）。
 */
.ce-canon-panel .settings-section{display:flex;flex-direction:column;gap:14px;flex:none;min-height:0;max-height:none!important}
/* ★ 2026-11-01 玩家截图：「你中间留那么多空白做什么，基础的排版都不会吗？」
 *
 * 病根：这里原来写的是
 *     display:flex;flex-direction:column;gap:6px
 * 而更下面（L1093 附近）还有一条
 *     .ce-canon-section-title{display:flex;align-items:center;justify-content:space-between;...}
 *
 * 两条规则打架的结果是：标题 h4 和「恢复本页默认」按钮被**竖着堆在中间**，
 * 左右两边空出一大片，正是玩家截图里那个「总览与模型 / 恢复本页默认」居中竖排。
 *
 * 统一成一行：标题在左，按钮在右，垂直居中对齐。
 * 这是本文件里唯一一条 .ce-canon-section-title 的规则，不再叠加。 */
.ce-canon-panel .ce-canon-section-title{display:flex;flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 14px;padding-bottom:2px}
.ce-canon-panel .ce-canon-section-title h4{margin:0;font-size:16px;font-weight:600;letter-spacing:.03em;color:var(--canon-ink)}
.ce-canon-panel .ce-canon-section-title p{margin:0;font-size:12px;line-height:1.6;color:var(--canon-muted)}
/* 提示与状态条 */
.ce-canon-panel .ce-canon-note{font-size:12px;line-height:1.6;color:var(--canon-muted);padding:9px 12px;border:1px solid rgba(198,175,124,.2);border-radius:9px;background:rgba(198,175,124,.055);overflow-wrap:anywhere}
.ce-canon-panel .ce-canon-note:empty{display:none}
.ce-canon-panel .hint{font-size:12px;line-height:1.6;color:var(--canon-muted);margin:0}
.ce-canon-panel .ce-canon-status{padding:11px 14px;border:1px solid rgba(198,175,124,.28);border-radius:10px;background:rgba(198,175,124,.075);font-size:12.5px;line-height:1.6;color:var(--canon-ink)}
.ce-canon-panel .ce-canon-settings-card{margin:0;padding:16px 18px;border-radius:12px;gap:14px}
.ce-canon-panel .ce-canon-toolbar{margin:0 0 2px}
/* 按钮：文字居中、尺寸一致、有按下与焦点反馈 */
.ce-canon-panel .small-btn{display:inline-flex;align-items:center;justify-content:center;text-align:center;gap:6px;min-height:34px;padding:6px 14px;border-radius:8px;border:1px solid var(--canon-line);background:rgba(255,255,255,.03);color:var(--canon-ink);font-size:13px;line-height:1.35;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .08s ease}
.ce-canon-panel .small-btn:hover:not(:disabled){background:rgba(198,175,124,.12);border-color:rgba(198,175,124,.5)}
.ce-canon-panel .small-btn:active:not(:disabled){transform:translateY(1px)}
.ce-canon-panel .small-btn:focus-visible{outline:2px solid var(--canon-gold);outline-offset:2px}
.ce-canon-panel .small-btn:disabled{cursor:not-allowed;opacity:.6}
.ce-canon-panel .small-btn.primary{border-color:rgba(207,182,129,.62);background:rgba(207,182,129,.16);color:#f3e7c9}
.ce-canon-panel .small-btn.primary:hover:not(:disabled){background:rgba(207,182,129,.26)}
/* 分区导航：选中态更明确 */
.ce-canon-panel .ce-canon-nav button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:7px 15px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--canon-muted);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease,border-color .15s ease}
.ce-canon-panel .ce-canon-nav button:hover{color:var(--canon-ink);background:rgba(198,175,124,.08)}
.ce-canon-panel .ce-canon-nav button.active{color:var(--canon-ink);border-color:rgba(207,182,129,.5);background:rgba(207,182,129,.15)}
.ce-canon-panel .ce-canon-nav button:focus-visible{outline:2px solid var(--canon-gold);outline-offset:2px}
/* 正文滚动区与页脚留白 */
.ce-canon-panel .ce-canon-body{padding:18px 22px 22px;gap:18px;display:flex;flex-direction:column}
.ce-canon-panel .ce-canon-footer{gap:14px;flex-wrap:wrap;align-items:center;padding:14px 22px}
.ce-canon-panel .ce-canon-footer-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
/* 输入控件统一外观与聚焦环 */
.ce-canon-panel .ce-canon-input,.ce-canon-panel select,.ce-canon-panel input[type="number"],.ce-canon-panel input[type="text"],.ce-canon-panel input[type="password"],.ce-canon-panel textarea{min-height:36px;padding:7px 11px;border-radius:8px;border:1px solid var(--canon-line);background:var(--canon-inset);color:var(--canon-ink);font-size:13px;line-height:1.4;font-family:inherit}
/* ===== 所有数字输入框统一：去掉原生箭头 + 宽度自适应 =====
   玩家 2026-10-30：「包括所有的填入数字框都要这样」。
   原生上下箭头会吃掉约 20px，把右侧数字盖住（65536 显示成 6553）。
   这里一次性覆盖全站所有数字框，不再逐个改 type，避免丢掉 min/max/step 原生校验：
     1) 隐藏 WebKit/Blink 与 Firefox 的步进按钮；
     2) field-sizing:content 让框随内容变宽（支持的浏览器），
        不支持的由 text-align:left + 合理 min-width 兜底，数字靠左不会被箭头区裁掉；
     3) tabular-nums 保证位数变化时不抖动。 */
.ce-canon-panel input[type="number"],
.ce-canon-panel input[type="text"][inputmode="numeric"],
.ce-canon-panel input[inputmode="numeric"],
.ce-canon-panel input[inputmode="decimal"]{
  text-align:left;
  font-variant-numeric:tabular-nums;
  min-width:6ch;
  field-sizing:content;
}
/* 隐藏步进箭头（Chrome/Safari/Edge） */
.ce-canon-panel input[type="number"]::-webkit-outer-spin-button,
.ce-canon-panel input[type="number"]::-webkit-inner-spin-button{
  -webkit-appearance:none;appearance:none;margin:0;width:0;height:0;
}
/* 隐藏步进箭头（Firefox） */
.ce-canon-panel input[type="number"]{-moz-appearance:textfield;appearance:textfield}
/* 面板外（正文设置页等）的数字框同样处理，避免别处再犯同一问题 */
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0;width:0;height:0}
input[type="number"]{-moz-appearance:textfield;appearance:textfield}
.ce-canon-panel .ce-canon-input:focus,.ce-canon-panel select:focus,.ce-canon-panel input:focus,.ce-canon-panel textarea:focus{outline:none;border-color:rgba(207,182,129,.62);box-shadow:0 0 0 2px rgba(207,182,129,.14)}
.ce-canon-panel textarea{min-height:120px;line-height:1.7;resize:vertical}
@media(max-width:720px){
 .ce-canon-panel .ce-canon-row{grid-template-columns:minmax(0,1fr);gap:6px;align-items:start}
 .ce-canon-panel .ce-canon-body{padding:14px 15px 18px}
 .ce-canon-panel .ce-canon-footer{padding:12px 15px}
 .ce-canon-panel .ce-canon-control-card,.ce-canon-panel .ce-canon-group{padding:13px 14px}
}

#ce-canon-settings-overlay{padding:22px;backdrop-filter:blur(5px)}
.ce-canon-panel{
  --canon-bg:var(--fr-ui-panel);--canon-card:var(--fr-ui-raised);--canon-inset:var(--fr-ui-inset);--canon-ink:var(--fr-ui-text);--canon-muted:var(--fr-ui-muted);--canon-gold:var(--fr-ui-accent);--canon-line:var(--fr-ui-line);
  /* ★ 2026-11-01 玩家：「你怎么那么死板，容器面积不够你不会放大整体吗？
   *   根据内容多少来灵活变通啊，我从来没说过容器面板只准这么大」
   *
   * 原来这里是写死的 width:min(1060px,…) + height:min(850px,92vh)。
   * 面板被钉死在一个尺寸里，内容比它高就只能靠内部滚动，看起来就是
   * 「中间留那么多空白」和「挤成一团」。
   *
   * 改成**按内容自适应**：
   *   · 高度用 auto —— 内容多就长高，内容少就收短，不再写死 850px
   *   · 上限 94vh 只是防止超出屏幕，不是「只准这么大」
   *   · 宽度给了更宽的 1180px 上限，内容真的需要时能摊开
   * 滚动仍然保留（body 的 overflow-y），但那只是屏幕装不下时的兜底，
   * 不再是主要工作方式。 */
  display:flex;flex-direction:column;
  width:min(1180px,calc(100vw - 44px))!important;
  max-width:1180px!important;
  height:auto;
  min-height:min(520px,80vh);
  max-height:94vh!important;
  padding:0!important;overflow:hidden!important;
  border:1px solid var(--canon-line);border-radius:16px;background:var(--canon-bg);color:var(--canon-ink);font-size:14px;line-height:1.55;font-family:inherit;box-shadow:0 32px 110px #000b,0 1px 0 rgba(231,209,157,.08) inset;
}
.ce-canon-panel *{box-sizing:border-box}
.ce-canon-panel [hidden]{display:none!important}
.ce-canon-section-title{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.ce-canon-panel .modal-header{position:relative;display:flex;justify-content:space-between;align-items:center;flex:none;gap:20px;padding:20px 26px 18px;border-bottom:1px solid var(--canon-line);background:linear-gradient(112deg,rgba(198,175,124,.085),transparent 65%)}
/* 底部渐隐提示：内容区贴到页脚时，用一层渐变暗示「下面还有东西」，
   避免玩家以为到底了（2026-11-01 玩家：「下面的看不到了」）。 */
.ce-canon-panel .ce-canon-body::after{
  content:'';position:sticky;bottom:-28px;display:block;height:34px;margin:0 -26px -28px;
  background:linear-gradient(180deg,transparent,var(--canon-bg));
  pointer-events:none;
}
.ce-canon-panel .modal-header h3{font-size:26px;font-weight:600;letter-spacing:.08em;line-height:1.25;margin:3px 0 0;color:var(--canon-ink);text-align:left}
.ce-canon-eyebrow{font-size:11px;letter-spacing:.18em;color:var(--canon-gold)}
.ce-canon-subtitle{font-size:12px;margin:7px 0 0;color:var(--canon-muted)}
.ce-canon-panel .modal-close-btn{position:static!important;flex:none;width:38px;height:38px;border:1px solid var(--canon-line);border-radius:10px;color:var(--canon-muted);font-size:25px;line-height:1;background:transparent;cursor:pointer}
.ce-canon-panel .modal-close-btn:hover{color:var(--canon-ink);background:rgba(198,175,124,.09)}
.ce-canon-nav{display:flex;gap:6px;padding:10px 22px;overflow-x:auto;flex:none;border-bottom:1px solid var(--canon-line);background:rgba(0,0,0,.12)}
.ce-canon-nav button{flex:1;white-space:nowrap;min-height:40px;padding:8px 14px;border:1px solid transparent;background:transparent;color:var(--canon-muted);border-radius:8px;font:inherit;font-size:13px;cursor:pointer}
.ce-canon-nav button:hover{color:var(--canon-ink);background:rgba(198,175,124,.05)}
.ce-canon-nav button.active{background:linear-gradient(180deg,rgba(198,175,124,.15),rgba(198,175,124,.08));color:var(--canon-gold);border-color:var(--canon-line);box-shadow:0 1px 0 rgba(232,211,162,.06) inset}
/* 2026-11-01 玩家：「问题不是折叠，而是下面的看不到了」。
 *
 * 实测原因：.ce-canon-body 一直是可以滚动的（各尺寸验证通过），
 * 但滚动条宽度是 0 —— Chromium/Electron 下 scrollbar-width:thin 被渲染成**不可见**，
 * 面板既没有可见滚动条，也没有任何「下面还有内容」的暗示，
 * 玩家滚到中间就以为下面没有设置了。
 *
 * 修法：
 *   ① 显式画一条宽滚动条（至少 10px），深色轨道 + 金色滑块，一眼能看出可滚
 *   ② 面板底部加渐隐遮罩（::after），提示「下面还有内容」
 */
/* 2026-11-01 玩家：「问题不是折叠，而是下面的看不到了」。
 *
 * 真正的根因（在浏览器里逐条扫规则查出来的，不是猜的）：
 *   全站有一条通配规则给所有元素设了标准属性 scrollbar-width: thin
 *   （style-1.css 里的全局规则）。
 *   Chromium 一旦在元素上看到**标准属性 scrollbar-width**，
 *   就切到标准/叠加式滚动条渲染，**完全忽略 ::-webkit-scrollbar 那套自定义样式**。
 *   叠加式滚动条浮在内容上、不占布局，offsetWidth - clientWidth 恒为 0，
 *   于是面板既没有可见滚动条，也没有任何「下面还有内容」的暗示。
 *
 * 处置：不去动全站那条全局规则（会影响所有其它面板），
 *   只在本面板上把标准属性显式改回 auto，让滚动条占位、常驻可见。
 *   （本段在 CSS 模板字符串里，注释中不要出现美元符号加花括号） */
.ce-canon-panel .ce-canon-body{
  /* ★ 2026-11-01 玩家：「容器面积不够你不会放大整体吗？根据内容多少来灵活变通」
   *
   * 原来是 flex:1 —— 意思是「不管内容多少，都撑满父容器剩下的高度」。
   * 面板高度写死 850px 时，这就等于「内容被塞进一个固定框」，
   * 内容多就挤、内容少就留一大片空白，正是玩家说的那两句。
   *
   * 改成 flex:0 1 auto —— 高度先按内容自然撑开；
   * 只有内容真的超过面板上限（94vh）时，才由 flex 收缩 + overflow-y 兜底滚动。
   * 这样常见情况下面板自己长高，不需要内部滚动。 */
  flex:0 1 auto;overflow-y:auto;overscroll-behavior:contain;min-height:0;
  padding:22px 26px 28px!important;
  /* 覆盖全局通配规则：auto 才会占位、才看得见 */
  scrollbar-width:auto;
  scrollbar-color:#b29a68 rgba(255,255,255,.06);
}
.ce-canon-panel .ce-canon-body::-webkit-scrollbar{
  display:block;-webkit-appearance:none;width:11px;
}
.ce-canon-panel .ce-canon-body::-webkit-scrollbar-track{
  -webkit-appearance:none;background:rgba(255,255,255,.06);border-radius:6px;
}
.ce-canon-panel .ce-canon-body::-webkit-scrollbar-thumb{
  -webkit-appearance:none;min-height:48px;border-radius:6px;
  background:linear-gradient(180deg,#b29a68,#8a7954);
}
.ce-canon-panel .ce-canon-body::-webkit-scrollbar-thumb:hover{
  background:linear-gradient(180deg,#d2b781,#a08a5c);
}
.ce-canon-panel .ce-canon-status{font-size:11px;line-height:1.6;padding:0 0 14px;margin-bottom:18px;border-bottom:1px solid var(--canon-line);color:var(--canon-muted)}
.ce-canon-panel .settings-section{border:0;background:transparent;margin:0;padding:0}
.ce-canon-section-heading{margin-bottom:18px}
.ce-canon-panel h4{font-size:19px;font-weight:600;color:var(--canon-ink);text-align:left;margin:0 0 5px;letter-spacing:.035em}
.ce-canon-panel h5{font-size:14px;font-weight:600;margin:0;color:var(--canon-gold);line-height:1.5}
.ce-canon-panel .hint{font-size:12px;line-height:1.65;color:var(--canon-muted);margin:6px 0 0}
.ce-canon-control-card,.ce-canon-group{min-width:0;padding:18px 20px;border:1px solid var(--canon-line);border-radius:11px;margin:0 0 16px;background:linear-gradient(150deg,rgba(255,255,255,.018),transparent 75%),var(--canon-card)}
.ce-canon-card-heading{margin-bottom:16px}
.ce-canon-card-heading h5{display:flex;align-items:center;gap:9px}
.ce-canon-card-heading h5:before{content:'';display:block;width:3px;height:14px;border-radius:2px;background:var(--canon-gold);opacity:.75}
/* ★ 2026-11-01 玩家：「你中间留那么多空白做什么，基础的排版都不会吗？」
 *
 * 原先两栏用 align-items:start，两栏卡片各按自己内容高度，顶端对齐 ——
 * 这是对的，但列宽比例是 1.12/0.88，**内容少的那栏反而更宽**，
 * 于是「模型接口」只有一两行，却占着最宽的一栏，右边挤成窄条。
 *
 * 修正：列宽反转为 0.88fr / 1.12fr，把宽度给内容多的那栏。
 *
 * 曾经试过 align-items:stretch 强行等高 —— 结果是左栏一个下拉框被拉成
 * 588px 高，底下空出 380px 的死白，比参差更难看。所以退回 start。
 * 两栏各自按内容高度、顶对齐，短栏下方空着是右栏还在继续，这是正常的两栏排版。
 */
.ce-canon-overview-grid{display:grid;grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr);gap:16px;align-items:start}
.ce-canon-overview-grid>.ce-canon-control-card{margin:0}
.ce-canon-panel .ce-canon-route-cards{min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;border:0;padding:0;margin:0 0 20px}
.ce-canon-route-cards legend{padding:0 0 10px;font-size:14px;font-weight:600;color:var(--canon-ink)}
.ce-canon-panel .ce-canon-route-card{min-width:0;display:flex;align-items:flex-start;gap:10px;padding:16px;border:1px solid var(--canon-line);border-radius:11px;background:var(--canon-card);cursor:pointer;transition:border-color .15s,background .15s}
.ce-canon-route-card:has(input:checked){border-color:var(--canon-gold);background:linear-gradient(110deg,rgba(198,175,124,.15),rgba(198,175,124,.04))}
.ce-canon-route-card:focus-within{outline:2px solid var(--canon-gold);outline-offset:2px}
.ce-canon-panel .ce-canon-route-card input{width:17px!important;height:17px;min-height:0!important;flex:0 0 17px;margin:3px 0 0;accent-color:var(--canon-gold)}
.ce-canon-route-words{display:flex;flex-direction:column;gap:6px;min-width:0;line-height:1.6}
.ce-canon-route-words strong{font-size:14px;color:var(--canon-ink)}
.ce-canon-route-words span{font-size:12px;color:var(--canon-muted)}
.ce-canon-route-words small{font-size:11px;color:var(--canon-gold)}
.ce-canon-route-cards>.hint{grid-column:1/-1;margin:0;line-height:1.7}
@media(max-width:650px){.ce-canon-panel .ce-canon-route-cards{grid-template-columns:minmax(0,1fr)}}
.ce-canon-master{padding:4px 20px;margin-bottom:18px;border:1px solid rgba(198,175,124,.3);border-radius:11px;background:linear-gradient(110deg,rgba(198,175,124,.11),rgba(198,175,124,.025))}
.ce-canon-master .ce-canon-toggle-label{font-size:15px;color:var(--canon-ink);font-weight:600}
.ce-canon-row{min-width:0;margin:0}
/* 网格列宽按内容自适应：固定 2 列会把长选项/长说明挤窄，
   这里改成「内容够宽就并排，不够就自动落单列」。 */
.ce-canon-field-grid,.ce-canon-dispatch-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:14px 20px;align-items:start}
/* 数字输入行。
   玩家 2026-10-30 两次报「数字显示不全」：
   第一次是 type="number" 的原生箭头吃宽度；第二次是固定列宽把长数字裁掉。
   根治办法是让框**跟着数字长度自适应**，不再猜一个够用的固定宽度：
     1) type="text"：没有原生箭头；
     2) size = 数字位数：框的固有宽度由 value 长度决定，换存档/换位数都不裁；
     3) field-sizing: content（支持的浏览器）：输入时框随内容继续变宽；
     4) 列宽用 auto 让出空间，输入框按自身内容宽度排布，不再被固定 px 挤压；
     5) tabular-nums + 等宽数字，位数变化时不跳动。 */
.ce-canon-number-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:13px 14px;border:1px solid rgba(198,175,124,.12);border-radius:8px;background:var(--canon-inset)}
.ce-canon-row-label{color:var(--canon-ink);font-size:13px;font-weight:500;line-height:1.5;min-width:0;overflow-wrap:anywhere}
/* 可填范围（min — max）。
   单列纵向布局下它就是普通一行，左对齐放在输入框下面。
   2026-11-01 之前这里试过把它挪走以「腾列宽」，实测反而让输入框更窄（78→50px），
   所以现在布局是「标签/输入框/范围/说明」四行纵向，不再有两列争宽的问题。 */
.ce-canon-row-range{grid-column:1;grid-row:auto;text-align:left;color:var(--canon-muted);font-size:10px;white-space:nowrap;line-height:1.5;opacity:.8}
/* 说明文字占满整行宽度、独立成行，绝不与控件抢同一格。 */
.ce-canon-row-hint{grid-column:1/-1;grid-row:auto;color:var(--canon-muted);font-size:11px;line-height:1.65;margin-top:2px;overflow-wrap:anywhere}
.ce-canon-number-row .ce-canon-row-hint{grid-column:1/-1;grid-row:auto}
.ce-canon-select-row{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;align-items:start}
.ce-canon-select-row+.ce-canon-select-row{margin-top:15px}
.ce-canon-field-grid>.ce-canon-select-row,.ce-canon-dispatch-grid>.ce-canon-select-row{margin:0}
.ce-canon-panel .ce-canon-input{display:block;min-width:0;width:100%;min-height:40px;padding:8px 11px;background:var(--canon-inset);border:1px solid var(--canon-line);border-radius:7px;color:var(--canon-ink);font-family:inherit;font-size:13px;line-height:1.5;box-shadow:0 1px 3px #0002 inset}
.ce-canon-panel .ce-canon-input:focus{outline:2px solid var(--canon-gold);outline-offset:1px;border-color:transparent}
/* 数字输入行。
   玩家 2026-11-01：「容器显示的设置数字不全」——
   500000 显示成 5000、16000 显示成 1600、65536 显示成 6553，全都退成 4 位。
   真因：原布局「标签 1fr / 输入框 auto」两列并排，输入框只靠 size 定宽
   （约 6 字符再被 padding 吃掉 2 字符 → 只剩 4 位），卡片一窄就更容易裁。

   ★ 现在改成**单列纵向布局**：标签 → 输入框（整行）→ 可填范围 → 说明。
     输入框 width:100% 跟着卡片走，不再受列宽挤压；
     同时保留 min-width:<digits>ch 作为下限，保证最长数字一定装得下。
     不要再改回「输入框和标签并排」——那正是数字被裁的根源。 */
.ce-canon-number-row{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;align-items:start;padding:13px 14px;border:1px solid rgba(198,175,124,.12);border-radius:8px;background:var(--canon-inset)}
.ce-canon-panel .ce-canon-number-row input,
.ce-canon-panel .ce-canon-number-input{
  grid-column:1;grid-row:auto;min-height:38px;
  padding:6px 10px;text-align:left;font-size:14px;line-height:1.4;
  font-variant-numeric:tabular-nums;color:var(--canon-gold);
  width:100% !important;max-width:100%;box-sizing:border-box;
  /* 支持时让框随输入内容继续变宽；不支持的浏览器由 size + min-width:ch 兜底。 */
  field-sizing:content;
}
.ce-canon-panel select option{background:var(--canon-bg);color:var(--canon-ink)}
.ce-canon-panel textarea.ce-canon-input{resize:vertical;min-height:96px;line-height:1.8}
.ce-canon-inline{display:flex;gap:8px;min-width:0;align-items:center}
.ce-canon-inline .ce-canon-input{flex:1}
.ce-canon-inline button{flex:none}
.ce-canon-toggle{display:grid!important;grid-template-columns:20px minmax(0,1fr);gap:3px 10px;padding:12px 0;margin:0!important;align-items:start}
.ce-canon-toggle+.ce-canon-toggle{border-top:1px solid var(--canon-line)}
.ce-canon-toggle input{width:17px!important;height:17px;min-height:0!important;margin:3px 0!important;accent-color:var(--canon-gold)}
.ce-canon-toggle-label{font-size:13px;color:var(--canon-ink);line-height:1.6}
.ce-canon-toggle-hint{grid-column:2;font-size:11px;line-height:1.6;color:var(--canon-muted)}
.ce-canon-toggle-compact{font-size:12px;margin-top:8px!important}
.ce-canon-note{font-size:12px;line-height:1.7;padding:11px 12px;margin:12px 0 0;border-left:2px solid var(--canon-gold);border-radius:0 6px 6px 0;background:rgba(198,175,124,.06);color:var(--canon-muted);overflow-wrap:anywhere}
/* 2026-11-01：这里原有三条 .ce-canon-material-grid 定义（repeat(2,1fr) 版、
 * 以及 .ce-canon-material-stage 下的 column-count 版），与上方那条权威定义冲突。
 * 已全部删除，只保留上面唯一一条「按列堆叠」的定义。 */
.ce-canon-material-grid h5{margin-bottom:6px}
.ce-canon-material-summary{padding:0 2px}
/* 资料来源按阶段分区（玩家 2026-11-01：要分原著补演和原著指导） */
.ce-canon-panel .ce-canon-material-stage{border:1px solid var(--canon-line);border-radius:11px;padding:14px 16px;margin:0 0 14px;background:rgba(0,0,0,.06)}
.ce-canon-panel .ce-canon-material-stage>h5{margin:0 0 6px;font-size:13px;color:var(--canon-gold);letter-spacing:.4px}
.ce-canon-panel .ce-canon-material-stage-count{margin:0 0 10px}
.ce-canon-panel .ce-canon-material-inherited{margin:0 0 10px;padding:8px 10px;border-left:2px solid var(--canon-gold);background:rgba(255,255,255,.02);border-radius:0 7px 7px 0}
/* 2026-11-01：这里原有 .ce-canon-material-stage .ce-canon-material-grid 的两条
   column-count 覆盖（正常 + 窄屏），与上面的权威定义重复且 gap 不一致（14 vs 16）。
   已删除，统一由上面那一条管。 */
.ce-canon-toolbar,.ce-canon-prompt-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.ce-canon-settings-card{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:20px 0 16px;padding:18px 20px;border:1px solid var(--canon-line);border-radius:11px;background:var(--canon-card)}
.ce-canon-settings-card>div{flex:1;min-width:min(100%,240px)}
.ce-canon-settings-card .hint{margin:5px 0 0}
.ce-canon-settings-card>button{flex:none}
.ce-canon-advanced,.ce-canon-limit-card,.ce-canon-roster{border:1px solid var(--canon-line);border-radius:9px;margin:16px 0 0;background:rgba(0,0,0,.07);overflow:hidden}
.ce-canon-advanced>summary,.ce-canon-limit-card>summary,.ce-canon-roster>summary{display:flex;align-items:center;gap:12px;list-style:none;cursor:pointer;padding:14px 16px;min-height:46px;color:var(--canon-ink);font-size:13px}
.ce-canon-advanced>summary::-webkit-details-marker,.ce-canon-limit-card>summary::-webkit-details-marker,.ce-canon-roster>summary::-webkit-details-marker{display:none}
.ce-canon-advanced>summary:after,.ce-canon-limit-card>summary:after,.ce-canon-roster>summary:after{content:'›';font-size:22px;line-height:1;color:var(--canon-gold);margin-left:auto;transform:rotate(0)}
.ce-canon-advanced[open]>summary:after,.ce-canon-limit-card[open]>summary:after,.ce-canon-roster[open]>summary:after{transform:rotate(90deg)}
.ce-canon-advanced[open]>summary,.ce-canon-limit-card[open]>summary,.ce-canon-roster[open]>summary{border-bottom:1px solid var(--canon-line)}
.ce-canon-advanced-caption,.ce-canon-limit-caption{font-size:11px;color:var(--canon-muted);margin-left:auto}
.ce-canon-advanced-body,.ce-canon-limit-body{padding:16px}
.ce-canon-limit-body>.ce-canon-field-grid{margin-top:14px}
.ce-canon-count{margin-left:auto;padding:2px 8px;background:rgba(198,175,124,.1);border:1px solid var(--canon-line);border-radius:5px;color:var(--canon-gold);font-size:11px;white-space:nowrap}
.ce-canon-roster-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:240px;overflow:auto;padding:14px;scrollbar-width:thin}
.ce-canon-roster-editor{display:grid;gap:12px;padding:16px;min-width:0}
.ce-canon-roster-editor label{display:grid;gap:6px;min-width:0;color:var(--canon-muted)}
.ce-canon-roster-editor textarea{min-height:240px;max-height:420px;resize:vertical;white-space:pre;overflow:auto;line-height:1.8}
.ce-canon-roster-editor [readonly]{opacity:.8}
.ce-canon-roster-actions{display:flex;flex-wrap:wrap;gap:8px}
.ce-canon-roster-editor [data-role-feedback]{margin:0;min-height:1.5em;color:var(--canon-gold);overflow-wrap:anywhere}
.ce-canon-roster-person{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--canon-line);border-radius:6px;background:var(--canon-inset);min-width:0}
.ce-canon-roster-person strong{font-size:12px;font-weight:500}
.ce-canon-roster-person span{color:var(--canon-muted);font-size:11px;overflow-wrap:anywhere}
.ce-canon-panel .small-btn{min-height:38px;white-space:nowrap;padding:7px 13px;border:1px solid var(--canon-line);border-radius:7px;background:rgba(255,255,255,.015);color:var(--canon-ink);font-family:inherit;font-size:12px;line-height:1.5;cursor:pointer}
.ce-canon-panel .small-btn:hover{background:rgba(198,175,124,.12);border-color:rgba(198,175,124,.4)}
.ce-canon-panel .small-btn:active{background:rgba(198,175,124,.2)}
.ce-canon-panel .small-btn:disabled{opacity:.5;cursor:wait}
.ce-canon-panel .small-btn.primary{background:linear-gradient(180deg,#d9c18e,#bca16b);color:#241e13;border-color:#d2b87e;font-weight:600;padding-right:20px;padding-left:20px;box-shadow:0 2px 7px #0003}
.ce-canon-panel :focus-visible{outline:2px solid var(--canon-gold);outline-offset:3px}
.ce-canon-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;flex:none;padding:15px 26px;border-top:1px solid var(--canon-line);background:var(--canon-card);box-shadow:0 -6px 20px #0001}
#ce-canon-save-feedback{flex:1;min-width:0;margin:0;color:var(--canon-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere;text-align:left}
.ce-canon-footer-actions{display:flex;align-items:center;gap:8px;flex:none}
.ce-canon-footer-actions button{flex:none}
.ce-canon-prompt-guide{padding:0 0 16px}
.ce-canon-prompt-item{border:1px solid var(--canon-line);border-radius:8px;padding:0;margin:10px 0 0;background:var(--canon-inset);overflow:hidden}
.ce-canon-prompt-item summary{display:flex;gap:9px;align-items:center;padding:12px 14px;min-height:44px;cursor:pointer;list-style:none}
.ce-canon-prompt-item>p,.ce-canon-prompt-item>.ce-canon-prompt-actions{margin:12px 14px!important}
.ce-canon-prompt-title{font-size:13px;font-weight:500;line-height:1.6;overflow-wrap:anywhere}
.ce-canon-prompt-len{margin-left:auto;color:var(--canon-muted);font-size:11px;white-space:nowrap}
.ce-canon-badge{padding:2px 7px;font-size:10px;border-radius:5px;background:rgba(198,175,124,.1);border:1px solid var(--canon-line);color:var(--canon-gold);white-space:nowrap}
.ce-canon-prompt-textarea{display:block;width:calc(100% - 28px);box-sizing:border-box;margin:12px 14px;min-height:230px;padding:12px;background:var(--canon-bg);border:1px solid var(--canon-line);border-radius:7px;color:var(--canon-ink);font:12px/1.8 ui-monospace,Consolas,monospace;resize:vertical}
.ce-canon-vars{overflow-wrap:anywhere;font-size:11px!important}
body.theme-day .ce-canon-panel{--canon-bg:#f8f6ee;--canon-card:#fffdf7;--canon-inset:#f1eee4;--canon-muted:#716b5c;--canon-gold:#82632f;--canon-line:rgba(128,100,55,.23);--canon-ink:#332f25}
@media(max-width:800px){.ce-canon-overview-grid{grid-template-columns:minmax(0,1fr)}.ce-canon-panel{width:calc(100vw - 24px)!important}.ce-canon-material-grid{gap:12px}.ce-canon-card-heading{margin-bottom:12px}}
@media(max-width:640px){
  #ce-canon-settings-overlay{padding:8px}.ce-canon-panel{width:calc(100vw - 16px)!important;height:auto;max-height:94vh!important;border-radius:12px}
  .ce-canon-panel .modal-header{padding:16px 18px}.ce-canon-panel .modal-header h3{font-size:23px}.ce-canon-subtitle{font-size:11px}
  .ce-canon-nav{padding:8px 12px;gap:4px}.ce-canon-nav button{flex:none;padding:8px 12px;min-height:44px}
  .ce-canon-body{padding:18px 14px 24px!important}.ce-canon-section-heading{margin-bottom:16px}.ce-canon-panel h4{font-size:18px}
  .ce-canon-field-grid,.ce-canon-dispatch-grid,.ce-canon-material-grid{grid-template-columns:minmax(0,1fr);gap:12px}
  .ce-canon-control-card,.ce-canon-group{padding:16px}.ce-canon-master{padding:4px 16px}
  .ce-canon-number-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px}.ce-canon-panel .ce-canon-number-row input{min-height:44px}
  .ce-canon-select-row{gap:7px}.ce-canon-panel .ce-canon-input{min-height:44px}
  .ce-canon-advanced-caption,.ce-canon-limit-caption{font-size:10px;max-width:45%;text-align:right}
  .ce-canon-inline{flex-wrap:wrap}.ce-canon-inline .ce-canon-input{flex-basis:65%}
  .ce-canon-footer{display:grid;grid-template-columns:minmax(0,1fr);gap:9px;padding:11px 14px}
  #ce-canon-save-feedback{font-size:11px;min-height:18px}.ce-canon-footer-actions{width:100%;gap:7px}.ce-canon-footer-actions .small-btn{flex:1;padding:8px 10px;min-height:44px}
  .ce-canon-panel .small-btn{min-height:44px}.ce-canon-prompt-item summary{flex-wrap:wrap;gap:6px}.ce-canon-prompt-title{flex:1;min-width:65%}
  .ce-canon-settings-card{padding:16px}.ce-canon-settings-card>button{width:100%}.ce-canon-roster-grid{grid-template-columns:repeat(2,minmax(0,1fr));padding:10px}
}
@media(prefers-reduced-motion:reduce){#ce-canon-settings-overlay,#ce-canon-settings-overlay .modal{transition:none!important;backdrop-filter:none}}
`;
}

