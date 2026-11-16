/* ============================================================
 * 全站自适应层（mobile-adaptive.js）
 *
 * 设计目标（玩家原话）：
 *   「任何情况，打开任何窗口，不管横屏还是竖屏，
 *     永远要以最舒适最合适的方式显示内容。」
 *
 * 为什么不用「逐个弹窗打补丁」：
 *   全站有 95+ 个 position:fixed 浮层，且大量是脚本动态创建的。
 *   逐个写 max-width 既写不完，也会不断漏。
 *
 * 所以这里做**两层**，合在一个模块里：
 *   第一层 CSS   ：按结构特征用宽选择器统一兜底（不认具体类名）
 *   第二层 运行时：持续监测，发现溢出就当场纠正；转屏/新建弹窗自动接管
 *
 * 安全边界（很重要）：
 *   · CSS 规则全部限定在「触屏 / 小屏 / 矮屏」，桌面端零影响。
 *   · 运行时只做「收窄到装得下」，绝不放大、不改颜色、不改字体语义。
 *   · 出错静默（try/catch），绝不因为适配而影响游戏本身。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__frMobileAdaptiveInstalled) return;
  window.__frMobileAdaptiveInstalled = true;

  /* ══════════════════════════════════════════════════════════════════
   * 第 0 层：手机端缺失 API 兜底（实机致命问题）
   *
   * 玩家实机报错「创建存档失败: crypto.randomUUID is not a function」。
   * 原因：crypto.randomUUID / crypto.subtle / navigator.clipboard 这些
   *      **只在安全上下文**（https / localhost）可用；
   *      安卓 WebView 以 file:// 或 http:// 加载页面时它们是 undefined。
   *      而 main.js 有 61 处直接调用 crypto.randomUUID()，
   *      创建存档第一步就抛异常，整个流程中断。
   *
   * 只补缺失的方法，绝不覆盖原生实现。
   * ══════════════════════════════════════════════════════════════════ */
  (function patchMissingApis() {
    /* ---- 1. crypto.randomUUID ---- */
    try {
      var c = window.crypto || (window.crypto = {});
      if (typeof c.randomUUID !== 'function') {
        var uuidv4 = function () {
          var bytes = null;
          try {
            if (typeof c.getRandomValues === 'function') {
              bytes = new Uint8Array(16);
              c.getRandomValues(bytes);
            }
          } catch (e) { bytes = null; }

          if (!bytes) {
            // 极端兜底：无任何 CSPRNG 时也让流程能跑完（仅用于本地存档 id）
            bytes = new Uint8Array(16);
            for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
          }

          // RFC 4122：置版本位 v4 与变体位
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;

          var hex = [];
          for (var j = 0; j < 16; j++) hex.push((bytes[j] + 0x100).toString(16).slice(1));
          return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
                 hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
                 hex.slice(10, 16).join('');
        };
        try {
          Object.defineProperty(c, 'randomUUID', {
            value: uuidv4, writable: true, configurable: true, enumerable: false,
          });
        } catch (e) { c.randomUUID = uuidv4; }
      }
    } catch (e) {}

    /* ---- 2. navigator.clipboard（复制按钮在手机上会静默失效）---- */
    try {
      if (!navigator.clipboard) {
        var legacyCopy = function (text) {
          try {
            var ta = document.createElement('textarea');
            ta.value = text == null ? '' : String(text);
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            (document.body || document.documentElement).appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
            ta.remove();
            return ok;
          } catch (e3) { return false; }
        };
        var readTextFallback = function () {
          return new Promise(function (resolve, reject) {
            try {
              var ta = document.createElement('textarea');
              ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
              (document.body || document.documentElement).appendChild(ta);
              ta.focus();
              ta.select();
              var ok = false;
              try { ok = document.execCommand('paste'); } catch (e4) { ok = false; }
              var val = ta.value;
              ta.remove();
              if (ok && val) resolve(val);
              else reject(new Error('paste not supported'));
            } catch (e5) { reject(e5); }
          });
        };
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: function (t) { return Promise.resolve(legacyCopy(t)); },
              readText: readTextFallback,
            },
          });
        } catch (e) {}
      }
    } catch (e) {}

    /* ---- 3. structuredClone（老 WebView 无，深拷贝用得上）---- */
    try {
      if (typeof window.structuredClone !== 'function') {
        window.structuredClone = function (obj) {
          try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
        };
      }
    } catch (e) {}

    /* ---- 4. Object.hasOwn / Array.prototype.at / findLast（老内核兜底）---- */
    try {
      if (typeof Object.hasOwn !== 'function') {
        Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
      }
      if (typeof Array.prototype.at !== 'function') {
        Object.defineProperty(Array.prototype, 'at', {
          value: function (n) {
            n = Math.trunc(n) || 0;
            if (n < 0) n += this.length;
            return (n < 0 || n >= this.length) ? undefined : this[n];
          },
          writable: true, configurable: true,
        });
      }
      if (typeof Array.prototype.findLast !== 'function') {
        Object.defineProperty(Array.prototype, 'findLast', {
          value: function (fn, thisArg) {
            for (var i = this.length - 1; i >= 0; i--) {
              if (fn.call(thisArg, this[i], i, this)) return this[i];
            }
            return undefined;
          },
          writable: true, configurable: true,
        });
      }
    } catch (e) {}
  })();

  /* ──────────────────────────────────────────────────────────────
   * 第一层：注入自适应 CSS
   * ────────────────────────────────────────────────────────────── */
  var CSS = [
/* ===== 触屏通用（不区分方向）===== */
'@media (pointer: coarse){',
  '.overlay,[id$="-overlay"],[class*="overlay"]{',
    'overflow-y:auto!important;overflow-x:hidden!important;',
    '-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
  '.overlay,[id$="-overlay"]{align-items:flex-start!important;',
    'padding:max(8px,env(safe-area-inset-top,0px)) 8px max(8px,env(safe-area-inset-bottom,0px)) 8px!important;',
    'box-sizing:border-box}',
  '.modal,.modal-content,.modal-beautified,[class*="-modal"],[class*="-dialog"]{',
    'max-width:min(96vw,100%)!important;max-height:92dvh;max-height:92vh!important;',
    'overflow-y:auto!important;box-sizing:border-box}',
  'button,[role="button"],.splash-btn,.major-action-button,.small-btn,.modal-btn,',
    'input[type="button"],input[type="submit"]{min-height:40px}',
  'input,textarea,select{font-size:max(16px,1em);max-width:100%;box-sizing:border-box}',
  'h1,h2,h3,h4,h5,.modal-title,[class*="-title"],[class*="-header"]{',
    'word-break:break-word;overflow-wrap:anywhere}',
  'table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
  'img,video,canvas,svg{max-width:100%;height:auto}',
  '*{overflow-wrap:break-word}',

  /* ── 创建流程：卡片网格 & 头部（玩家反馈「性别与种族页文字重叠」）──
   * 这条必须放在「触屏通用」里，横竖屏都要命中。
   *
   * 实测数据（393×851 竖屏，创建流程第 3 步「性别与种族」）：
   *   .creation-grid  rect y=-90  高 443px
   *   gridTemplateRows = 119.781px × 4 行 + gap 15×3 = 524px（内容实际需要 524px）
   *   → grid 被父级 flex 压矮了 81px，且 overflow:visible，
   *     第 4 张卡「扶她」的下半截溢出，压住下方「初始年龄」区块：
   *     「体质特殊，可能引来觊觎」y=394 vs「初始年龄:」y=397 → 重叠 79%。
   *
   * 病根：.creation-content 是 flex 子项（flex-shrink:1）+ max-height:100%，
   *       会把内部块级子元素一起压扁；而 grid / card 本身不该参与这个收缩。
   * 修法：grid 与 card 设为 flex:none + height:auto，按内容撑开，
   *       溢出统一交给 .creation-content 的 overflow-y:auto 滚动。 */
  '.creation-grid{grid-template-columns:1fr!important;gap:15px!important;width:100%!important;',
    'display:grid!important;flex:0 0 auto!important;height:auto!important;max-height:none!important;',
    'overflow:visible!important;align-content:start!important}',
  '.creation-grid > .creation-card{min-width:0!important;height:auto!important;',
    'max-height:none!important;flex:0 0 auto!important;align-self:start!important;',
    'overflow:visible!important;padding:14px!important;gap:6px!important;box-sizing:border-box!important}',
  '.creation-card h4{margin:0!important;line-height:1.35!important}',
  '.creation-card p{margin:0!important;line-height:1.5!important;overflow-wrap:anywhere!important}',
  '.creation-card .bonus,.creation-card .penalty{line-height:1.45!important}',
  '.creation-content .custom-input-group{padding:12px!important;margin-top:14px!important;',
    'margin-bottom:14px!important;box-sizing:border-box!important;width:100%!important;',
    'flex:0 0 auto!important;height:auto!important;max-height:none!important}',
  '.creation-options-group{gap:8px!important;margin-top:8px!important}',
  '.creation-options-group:first-child{margin-top:0!important}',

  /* ── 创建流程头部：标题与右侧「剩余点数」角标争空间 ──
   * .creation-step-header 是 flex，标题 div 被 .points-badge 挤到 189px 宽后换行成两行，
   * 与 68px 高的角标贴在一起，视觉上就是"文字压字"。
   * 修法：窄屏下换行排布，标题占满一行、角标另起一行右对齐。 */
  '.creation-step-header{flex-wrap:wrap!important;gap:8px!important;align-items:flex-start!important}',
  '.creation-step-header > div:not(.points-badge){flex:1 1 auto!important;min-width:0!important}',
  '.creation-step-header .points-badge,',
  '.creation-step-header [class*="badge"]{flex:0 0 auto!important;margin-left:auto!important;',
    'min-width:0!important;max-width:100%!important;white-space:nowrap!important}',
  '.points-badge{font-size:0.9em!important;padding:6px 12px!important;gap:6px!important;',
    'box-sizing:border-box!important}',
  '.points-badge .cost{white-space:nowrap!important}',

  /* ── 地图弹窗头部按钮防挤压（玩家反馈"放大缩小关闭按钮挤在一起"）──
   * 根因：.modal-close-btn 是 position:absolute; top:20px; right:20px，
   * 而 .map-zoom-controls 又有 margin-right:20px —— 两者都往右上角挤，
   * 窄屏/横屏下直接叠在一起；#mini-map-toggle-container 还是绝对定位悬浮。
   * 修法：header 内所有控件改为正常 flex 流式排布，关闭键不再绝对定位。 */
  '.map-modal-header{display:flex!important;align-items:center!important;gap:8px!important;',
    'flex-wrap:nowrap!important;position:relative!important;padding-right:0!important;',
    'min-height:38px!important}',
  '.map-modal-header h4{flex:1 1 auto!important;min-width:0!important;text-align:left!important;',
    'margin:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
  '.map-zoom-controls{flex:0 0 auto!important;margin:0!important;gap:6px!important;display:flex!important}',
  '.map-modal-header .modal-close-btn{position:static!important;flex:0 0 auto!important;',
    'top:auto!important;right:auto!important;margin:0!important}',
  '#mini-map-toggle-container{position:static!important;left:auto!important;flex:0 0 auto!important;',
    'display:flex!important;align-items:center!important;gap:6px!important}',
  '.map-zoom-btn{width:34px!important;height:34px!important;font-size:17px!important;flex:0 0 auto!important}',
  '.map-modal-header .modal-close-btn{width:34px!important;height:34px!important}',
'}',

/* ===== 竖屏窄屏 ===== */
'@media (max-width:820px){',
  /* 全局放开滚动 —— 桌面版是「恒等于视口永不滚动」，小屏必须允许滚 */
  'html{overflow-y:auto!important;overflow-x:hidden!important;',
    '-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{overflow:visible!important;height:auto!important;min-height:100%}',

  /* 注意：这里**不再**用 [class*="-layout"] / [class*="-body"] 这类宽泛选择器
   * 去强制 flex-direction:column。教训：它们会命中 .creation-content 之类
   * 的既有 flex 容器，把子项高度压成十几像素，标题直接被裁掉。
   * 只处理明确知道的、确实需要堆叠的那几个（白名单），其余交给
   * 第二层运行时引擎按实际溢出情况处理，更安全。 */
  '.fr-replay-body{grid-template-columns:1fr!important;min-width:0!important}',

  /* 固定列网格降列 —— 只认明确 id，安全 */
  '#weapon-grid,#armor-grid,#technique-grid,#treasure-grid,#player-traits-grid{',
    'grid-template-columns:repeat(auto-fill,minmax(62px,1fr))!important;gap:8px!important}',
  '.status-grid,.status-grid.npc-grid{',
    'grid-template-columns:repeat(auto-fit,minmax(110px,1fr))!important;width:100%!important}',
  '.status-pill{min-width:0!important;max-width:100%!important;padding:6px 10px!important}',
  '.item-slot{min-width:0!important}',

  /* 欢迎页 */
  '#splash-screen{justify-content:flex-start;overflow-y:auto!important;',
    'padding:14px 12px calc(14px + env(safe-area-inset-bottom,0px));box-sizing:border-box}',
  '#splash-content{margin:auto 0;padding:20px 16px;width:100%;max-width:560px;box-sizing:border-box}',
  '#splash-title{font-size:clamp(26px,min(8.6vw,11vh),52px);line-height:1.18;word-break:keep-all}',
  '#splash-info{font-size:12.5px;line-height:1.6}',
  '#splash-buttons{display:grid!important;',
    'grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;width:100%;margin-top:20px}',
  '.splash-btn{width:100%;box-sizing:border-box;padding:11px 8px;',
    'font-size:15px;line-height:1.35;white-space:nowrap}',
  '.splash-corner-btn{width:44px!important;height:44px!important;font-size:1.15em!important}',

  /* 补演工作台：左右两栏 → 上下堆叠（明确 id，安全） */
  '#fr-replay-overlay .fr-replay-body{display:flex!important;flex-direction:column!important;',
    'overflow-y:auto!important;min-height:0}',
  '#fr-replay-overlay .fr-replay-stages{flex:none!important;max-height:34vh;',
    'overflow-y:auto!important;border-right:0!important;border-bottom:1px solid #4b4232;padding:12px 14px}',
  '#fr-replay-overlay .fr-replay-targets{flex:1 1 auto!important;min-height:0;overflow-y:auto!important}',
  '#fr-replay-overlay .fr-replay-panel{width:96vw!important;height:94dvh;height:94vh}',
  '#fr-replay-overlay .fr-replay-selection-tools{flex-wrap:wrap}',
  '#fr-replay-overlay .fr-replay-target-tools{grid-template-columns:1fr!important}',

  /* ── 大画面窗口必须给足面积（玩家反馈「地图窗口特别小」）──
   * 根因（实测数据）：
   *   1) 同一个小屏媒体查询里有通用规则
   *        .modal:not(.character-detail-modal):not(.creation-container){
   *          width:95vw!important; max-width:500px!important; max-height:80vh!important }
   *      把**所有**弹窗钉死在 500px 宽 → 横屏地图只有 475px 宽。
   *   2) 地图画布尺寸由 JS 按容器 rect 实时计算
   *        canvas.width = rect.width * dpr  (main.js:82374)
   *      所以「容器多高，地图就多大」。而 .map-container 只是 flex:1 撑剩余空间，
   *      弹窗本身高度又由内容决定 → 竖屏画布仅 285×143，横屏仅 245×123。
   *
   * 修法：把这类窗口的高度直接钉到视口高度（不是 height:auto，
   *       那样会退回内容高度反而更小 —— 我第一版就踩了这个坑），
   *       画布容器 flex:1 自然吃满剩余空间。 */
  '#world-map-modal,#map-selection-modal,#map-editor-modal,#map-management-modal,',
  '#character-detail-modal,#fr-replay-overlay .fr-replay-panel,',
  '#traits-overlay .modal,#linggen-overlay .modal,#world-factor-overlay .modal{',
    'max-width:min(1200px,98vw)!important;width:98vw!important;',
    'height:94dvh!important;height:94vh!important;max-height:94dvh!important;max-height:94vh!important}',
  /* 图片/地图类弹窗内部分栏：竖排 + 画布吃满剩余高度 */
  '#world-map-modal,#map-selection-modal{display:flex!important;flex-direction:column!important;',
    'gap:8px!important;padding:12px!important}',
  /* 关键（实测）：canvas 是 position:absolute 且原本没有宽高，
   * 而 main.js:82371 用 canvas.getBoundingClientRect() 算画布尺寸，
   * 于是永远读到旧的 300×150 —— 弹窗变大了地图也不变。
   * 必须让 canvas 铺满容器，rect 才有正确值，JS 重绘后地图才会跟着变大。 */
  '#map-container,#world-map-container{flex:1 1 auto!important;min-height:200px!important;',
    'width:100%!important;position:relative!important}',
  '#map-canvas,#world-map-canvas{position:absolute!important;top:0!important;left:0!important;',
    'width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important}',
  '.map-modal-header,.map-modal-controls{flex:0 0 auto!important}',
  '#map-info-panel,#world-map-info-panel{flex:0 0 auto!important;max-height:34vh;overflow-y:auto!important}',
'}',

/* ===== 横屏矮屏（高度只有 380~430px）===== */
/* 原则：横屏只放开滚动 + 让弹窗吃满高度，绝不动内部 flex 结构。 */
'@media (orientation:landscape) and (max-height:540px){',
  'html{overflow-y:auto!important;overflow-x:hidden!important}',
  'body{height:auto!important;min-height:100%;overflow:visible!important}',
  '.overlay,[id$="-overlay"]{align-items:flex-start!important;',
    'padding:max(4px,env(safe-area-inset-top,0px)) 6px max(4px,env(safe-area-inset-bottom,0px)) 6px!important}',
  '.modal,.modal-content,.modal-beautified,[class*="-modal"],[class*="-dialog"]{',
    'max-height:96dvh;max-height:96vh!important;max-width:98vw!important}',

  /* ── 角色创建界面（开辟鸿蒙）在横屏下的塌陷修复 ──
   * 原样：.creation-container{height:100%} + padding:30px，横屏只有 393px 高，
   * 减去 padding 与 header 后，.creation-content 的 flex 高度被压到 15px，
   * 标题、难度卡全被裁掉（玩家看到的"文字重叠"就是这个）。
   * 修法：横屏下不再锁死 100% 高度，让容器随内容撑开、页面整体可滚。 */
  '.creation-container{height:auto!important;max-height:none!important;padding:14px!important;',
    'gap:10px!important;width:100%!important;max-width:100vw!important;border-radius:0!important}',
  '.creation-content{overflow:visible!important;min-height:auto!important;padding-right:0!important}',
  '.creation-step-header{margin-bottom:12px!important;padding-bottom:8px!important}',
  '.creation-step-title{line-height:1.3!important}',

  /* ── 横屏下大画面窗口也必须给足面积 ──
   * 注意：横屏 851×393 时宽度 851 > 820，所以上面那个 max-width:820px 的块
   * **根本不会命中**（第一版就漏了这点，横屏地图一直没变）。
   * 横屏最缺的是"高度"：总高才 393px，地图容器只剩 125px 高。
   * 所以这里让弹窗吃满整个视口高度，画布随之撑开。 */
  '#world-map-modal,#map-selection-modal,#map-editor-modal,#map-management-modal,',
  '#character-detail-modal,#fr-replay-overlay .fr-replay-panel{',
    'width:98vw!important;max-width:98vw!important;',
    'height:96dvh!important;height:96vh!important;max-height:96dvh!important;max-height:96vh!important;',
    'padding:8px!important;gap:6px!important}',
  '#world-map-modal,#map-selection-modal{display:flex!important;flex-direction:column!important}',
  '#map-container,#world-map-container{flex:1 1 auto!important;min-height:120px!important;',
    'width:100%!important;position:relative!important}',
  '#map-canvas,#world-map-canvas{position:absolute!important;top:0!important;left:0!important;',
    'width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important}',
  '.map-modal-header{flex:0 0 auto!important;margin-bottom:4px!important}',
  '#map-info-panel,#world-map-info-panel{flex:0 0 auto!important;max-height:26vh;overflow-y:auto!important}',

  /* ── 地图弹窗头部按钮防挤压（玩家反馈"放大缩小关闭按钮挤在一起"）──
   * 根因：.modal-close-btn 是 position:absolute; top:20px; right:20px，
   * 而 .map-zoom-controls 又有 margin-right:20px —— 两者都往右上角挤，
   * 窄屏/横屏下直接叠在一起；#mini-map-toggle-container 还是绝对定位悬浮，
   * 再挤掉一块空间。
   * 修法：header 内所有控件改为正常 flex 流式排布，关闭键不再绝对定位。 */
  '.map-modal-header{display:flex!important;align-items:center!important;gap:8px!important;',
    'flex-wrap:nowrap!important;position:relative!important;padding-right:0!important;',
    'min-height:38px!important}',
  '.map-modal-header h4{flex:1 1 auto!important;min-width:0!important;text-align:left!important;',
    'margin:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
  '.map-zoom-controls{flex:0 0 auto!important;margin:0!important;gap:6px!important;display:flex!important}',
  '.map-modal-header .modal-close-btn{position:static!important;flex:0 0 auto!important;',
    'top:auto!important;right:auto!important;margin:0!important}',
  '#mini-map-toggle-container{position:static!important;left:auto!important;flex:0 0 auto!important;',
    'display:flex!important;align-items:center!important;gap:6px!important}',
  /* 触屏放大点击热区 */
  '.map-zoom-btn{width:34px!important;height:34px!important;font-size:17px!important;flex:0 0 auto!important}',
  '.map-modal-header .modal-close-btn{width:34px!important;height:34px!important}',

  /* ── 角色创建头部：标题与右侧「剩余点数」角标互相挤压（玩家反馈的重叠）──
   * 实测病根：
   *   .creation-step-header 是 flex，左侧标题 div 被 .points-badge 挤到仅 189px 宽，
   *   「属性与出身」+ 下方描述被迫换行成两行（高度 62px）；
   *   而 .points-badge 高 68px、align-items:center，两者贴在一起看着像重叠。
   * 修法：窄屏下把 header 改成上下两段——标题占满一整行，角标另起一行右对齐，
   *       彻底消除争抢横向空间；角标本身允许收缩、数字不换行。 */
  '.creation-step-header{flex-wrap:wrap!important;gap:8px!important;align-items:flex-start!important}',
  '.creation-step-header > div:not(.points-badge){flex:1 1 auto!important;min-width:0!important}',
  '.creation-step-header .points-badge,',
  '.creation-step-header [class*="badge"]{flex:0 0 auto!important;margin-left:auto!important;',
    'min-width:0!important;max-width:100%!important;white-space:nowrap!important}',
  '.points-badge{font-size:0.9em!important;padding:6px 12px!important;gap:6px!important;',
    'box-sizing:border-box!important}',
  '.points-badge .cost{white-space:nowrap!important}',

  /* ── 创建流程卡片网格（玩家反馈「性别与种族页文字重叠」的真凶）──
   * 实测数据（393×851 竖屏）：
   *   .creation-grid  rect y=-90 高 443px
   *   gridRows = 119.781px × 4 行 + gap 15×3 = 524px  ← 内容实际需要 524px
   *   即 grid 容器被父级 flex 压到 443px（矮了 81px），而 overflow 是 visible，
   *   于是第 4 张卡片「扶她」的下半截直接溢出，压住下方「初始年龄」区块 ——
   *   「体质特殊，可能引来觊觎」y=394 与「初始年龄:」y=397 重叠 79%。
   * 病根：.creation-content 是 flex 子项（flex-shrink:1）且 max-height:100%，
   *       会把内部块级子元素一起压缩；grid 本身不该参与收缩。
   * 修法：grid 及卡片设为 flex:none / height:auto，让它们按内容撑开，
   *       溢出交给 .creation-content 自己的 overflow-y:auto 去滚动。 */
  '.creation-grid{grid-template-columns:1fr!important;gap:15px!important;width:100%!important;',
    'flex:0 0 auto!important;height:auto!important;max-height:none!important;',
    'overflow:visible!important;align-content:start!important}',
  '.creation-grid > .creation-card{min-width:0!important;height:auto!important;',
    'max-height:none!important;flex:0 0 auto!important;align-self:start!important;',
    'overflow:visible!important;padding:14px!important;gap:6px!important;box-sizing:border-box!important}',
  '.creation-card h4{margin:0!important;line-height:1.35!important}',
  '.creation-card p{margin:0!important;line-height:1.5!important;overflow-wrap:anywhere!important}',
  '.creation-card .bonus,.creation-card .penalty{line-height:1.45!important}',
  /* 卡片下方那块「初始年龄 / 法相外观 / 人称」的自定义输入组 */
  '.creation-content .custom-input-group{padding:12px!important;margin-top:14px!important;',
    'margin-bottom:14px!important;box-sizing:border-box!important;width:100%!important;',
    'flex:0 0 auto!important;height:auto!important;max-height:none!important}',
  '.creation-options-group{gap:8px!important;margin-top:8px!important}',
  '.creation-options-group:first-child{margin-top:0!important}',

  '#splash-screen{padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px))}',
  '#splash-content{padding:12px 16px;max-width:100%}',
  '#splash-title{font-size:clamp(22px,min(5.4vw,15vh),40px)}',
  '#splash-info{margin-top:4px;font-size:11.5px}',
  '#splash-buttons{margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}',
  '.splash-btn{padding:8px 6px;font-size:13.5px}',
'}',

/* ===== 超窄 / 超矮兜底 ===== */
'@media (max-width:400px){',
  '#splash-content{padding:16px 12px}',
  '#splash-buttons{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.splash-btn{font-size:14px;padding:10px 6px}',
  '.modal-content,.modal-beautified{padding:14px!important;width:98vw;max-width:98vw}',
'}',
'@media (max-height:360px){',
  '.overlay,[id$="-overlay"]{padding-top:2px!important;padding-bottom:2px!important}',
  '.modal,.modal-content,.modal-beautified,[class*="-modal"]{',
    'max-height:98vh!important;padding:8px!important}',
  '#splash-title{font-size:clamp(18px,4.6vw,30px)}',
  '#splash-info{display:none}',
'}',
  ].join('\n');

  function injectCss() {
    try {
      if (document.getElementById('fr-mobile-adaptive-style')) return;
      var st = document.createElement('style');
      st.id = 'fr-mobile-adaptive-style';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  var MARK = 'data-fr-adapted';
  var MAX_FIX_PER_PASS = 60;     // 单次最多纠正多少个，防止首屏卡顿
  var PASS_THROTTLE = 320;       // 两次全量扫描最小间隔(ms)

  function vw() { return window.innerWidth || document.documentElement.clientWidth || 0; }
  function vh() { return window.innerHeight || document.documentElement.clientHeight || 0; }

  function visible(el) {
    try {
      var st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      var b = el.getBoundingClientRect();
      return b.width > 4 && b.height > 4;
    } catch (e) { return false; }
  }

  /* 判断祖先里有没有已经能滚动的容器 —— 有的话不算问题 */
  function hasScrollableAncestor(el) {
    var p = el.parentElement;
    var n = 0;
    while (p && p !== document.body && n < 12) {
      try {
        var st = getComputedStyle(p);
        if (/auto|scroll/.test(st.overflowX) || /auto|scroll/.test(st.overflowY)) return true;
      } catch (e) {}
      p = p.parentElement; n++;
    }
    return false;
  }

  /* 纠正单个元素：让它回到视口内 */
  function fixElement(el) {
    try {
      if (el.getAttribute(MARK) === '1') return false;
      var b = el.getBoundingClientRect();
      var W = vw(), H = vh();
      var changed = false;

      // 横向溢出：限制最大宽度 + 允许内部滚动
      if (b.right > W + 2 || b.left < -2 || b.width > W + 2) {
        el.style.setProperty('max-width', 'calc(100vw - 12px)', 'important');
        el.style.setProperty('box-sizing', 'border-box', 'important');
        // 如果它是浮层/弹窗，允许它自己滚
        var st = getComputedStyle(el);
        if (st.position === 'fixed' || st.position === 'absolute') {
          el.style.setProperty('overflow-x', 'auto', 'important');
          el.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
        }
        // 居中定位造成的越界：把 left/right 归位
        if (st.position === 'fixed' || st.position === 'absolute') {
          if (b.left < -2) { el.style.setProperty('left', '6px', 'important'); }
          if (b.right > W + 2) { el.style.setProperty('right', '6px', 'important'); }
        }
        changed = true;
      }

      // 纵向溢出：可滚动 + 顶部对齐（保证标题/关闭键点得到）
      if (b.top < -2 || b.bottom > H + 2 || b.height > H + 2) {
        var st2 = getComputedStyle(el);
        if (st2.position === 'fixed' || st2.position === 'absolute') {
          if (b.top < -2) el.style.setProperty('top', '4px', 'important');
          if (b.height > H + 2 || b.bottom > H + 2) {
            el.style.setProperty('max-height', 'calc(100vh - 8px)', 'important');
            el.style.setProperty('overflow-y', 'auto', 'important');
            el.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
          }
          changed = true;
        }
      }

      if (changed) el.setAttribute(MARK, '1');
      return changed;
    } catch (e) { return false; }
  }

  // Temporary, bounded numeric-only attribution; never inspects/logs page contents.
  var frAdaptTimingStart = performance.now(), frAdaptTimingCount = 0;
  function frAdaptTimed(label, fn) {
    return function() {
      if (performance.now()-frAdaptTimingStart > 60000 || frAdaptTimingCount >= 36) return fn.apply(this,arguments);
      var began = performance.now();
      try { return fn.apply(this,arguments); }
      finally {
        var duration=performance.now()-began;
        if (duration>=20 || frAdaptTimingCount<6) {
          frAdaptTimingCount++;
          console.log('[适配计时] '+JSON.stringify({stage:label,ms:Math.round(duration),sinceStartMs:Math.round(performance.now()-frAdaptTimingStart)}));
        }
      }
    };
  }

  /* 全量扫描一遍 */
  function pass() {
    var fixed = 0;
    try {
      var W = vw(), H = vh();

      // 只扫"可能是浮层/容器"的元素，避免遍历几万个节点
      var nodes = document.querySelectorAll(
        'body > div, body > section, ' +
        '[id$="-overlay"], [class*="overlay"], [class*="modal"], [class*="-panel"], ' +
        '[class*="-dialog"], [class*="-window"], [class*="popup"], [class*="drawer"]'
      );

      for (var i = 0; i < nodes.length && fixed < MAX_FIX_PER_PASS; i++) {
        var el = nodes[i];
        if (el.getAttribute(MARK) === '1') continue;
        if (!visible(el)) continue;
        var b = el.getBoundingClientRect();

        // 完全在视口内 → 跳过
        if (b.left >= -2 && b.right <= W + 2 && b.top >= -2 && b.bottom <= H + 2) continue;

        // 祖先能滚 → 玩家自己滚得到，不算硬伤
        if (hasScrollableAncestor(el)) continue;

        if (fixElement(el)) fixed++;
      }
    } catch (e) {}
    return fixed;
  }

  /* 节流执行 */
  var lastPass = 0, timer = null;
  function schedule(force) {
    var now = Date.now();
    var wait = Math.max(0, PASS_THROTTLE - (now - lastPass));
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      lastPass = Date.now();
      pass();
    }, force ? 0 : wait);
  }

  /* 定向扫描：查找当前最高优先级的可见浮层，只处理它 */
  function passTopmost() {
    try {
      var overlays = document.querySelectorAll(
        '[id$="-overlay"].visible, .overlay.visible, [class*="overlay"].visible, [class*="modal"].visible'
      );
      var best = null, bestZ = -1;
      for (var i = 0; i < overlays.length; i++) {
        var el = overlays[i];
        if (!visible(el)) continue;
        var z = parseInt(getComputedStyle(el).zIndex, 10);
        if (isNaN(z)) z = 0;
        if (z >= bestZ) { bestZ = z; best = el; }
      }
      if (best) {
        // 同时修正它内部的弹窗盒子
        var inner = best.querySelector('[class*="modal"], [class*="-panel"], [class*="-dialog"]');
        if (inner && visible(inner)) fixElement(inner);
        fixElement(best);
      }
    } catch (e) {}
  }

  /* 屏幕旋转 / 尺寸变化：清掉旧标记重新算 */
  function resetAll() {
    try {
      var marked = document.querySelectorAll('[' + MARK + ']');
      for (var i = 0; i < marked.length; i++) {
        var el = marked[i];
        el.removeAttribute(MARK);
        // 只清掉我们加的那几条，不动其它样式
        el.style.removeProperty('max-width');
        el.style.removeProperty('max-height');
        el.style.removeProperty('overflow-x');
        el.style.removeProperty('overflow-y');
        el.style.removeProperty('box-sizing');
        el.style.removeProperty('-webkit-overflow-scrolling');
      }
    } catch (e) {}
  }

  function onResize() {
    resetAll();
    schedule(true);
    // 旋转后布局要等一帧才稳定，补两次
    setTimeout(passTopmost, 120);
    setTimeout(function () { schedule(true); }, 400);
  }

  /* 安装 */
  function install() {
    // 0. 先把自适应 CSS 打进页面（第一层：静态兜底）
    injectCss();

    // 1. 首次 + 延迟补扫（很多弹窗是异步插入的）
    schedule(true);
    setTimeout(function () { schedule(true); }, 600);
    setTimeout(function () { schedule(true); }, 1800);
    setTimeout(passTopmost, 2600);

    // 2. 尺寸/旋转
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { schedule(true); }, { passive: true });
    }

    // 3. 动态插入的弹窗
    try {
      var mo = new MutationObserver(function (muts) {
        var hit = false;
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') {
            var t = m.target;
            if (t && t.classList && (t.classList.contains('visible') || /overlay|modal/i.test(t.className || ''))) {
              hit = true; break;
            }
          } else if (m.addedNodes && m.addedNodes.length) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1) { hit = true; break; }
            }
          }
          if (hit) break;
        }
        if (hit) { schedule(false); passTopmost(); }
      });
      mo.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'style'],
      });
    } catch (e) {}

    // 4. 打开浮层时（点击按钮）补一枪，覆盖"点开才创建"的场景
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t) return;
      // 只关心可能打开弹窗的点击
      setTimeout(function () { schedule(false); passTopmost(); }, 80);
      setTimeout(passTopmost, 350);
    }, true);

    // 5. 触摸滚动开始时也校验一次（横屏最容易在这里出问题）
    document.addEventListener('touchstart', function () {
      if (!modalOpen()) return;
      schedule(false);
    }, { passive: true, capture: true });
  }

  function modalOpen() {
    try {
      var ov = document.querySelectorAll('.overlay.visible, [id$="-overlay"].visible');
      for (var i = 0; i < ov.length; i++) if (visible(ov[i])) return true;
    } catch (e) {}
    return false;
  }

  pass = frAdaptTimed('layout-pass', pass);
  passTopmost = frAdaptTimed('layout-topmost', passTopmost);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
