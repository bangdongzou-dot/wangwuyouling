/* ============================================================================
 * 版本更新页面
 *
 * 玩家口径：「需要一个在初始页面直接可以点进去查看的版本更新页面吧？
 *           可以看到版本号，更新日志，还能检测是否是最新版本然后进行更新操作。」
 *
 * 【入口】首屏第 4 个主按钮「版本更新」（#splash-update-btn）
 *        另外右下角提示条点开后也走同一个页面。
 *
 * 【页面内容】
 *   · 当前版本号 + 来源（安装包内置 / 热更新）
 *   · 「检查更新」按钮 → 检测是否最新
 *   · 更新日志（从 version.json 的 changelog 字段读，可折叠）
 *   · 「立即更新」按钮 → 下载 → 校验 → 重启
 *
 * 【重要：浏览器版/安卓版也要能用】
 *   没有 window.frUpdate 时（浏览器直接开 html、安卓 WebView）：
 *   页面照样能打开、能看版本号和更新日志，但检查/更新按钮显示为不可用
 *   并提示「当前版本不支持自动更新」。绝不白屏、绝不报错。
 *
 * 【性能】
 *   页面 DOM 在**第一次点开时才创建**，之后复用。平时零开销。
 * ========================================================================== */
(function () {
  'use strict';

  var PANEL_ID = 'fr-version-panel';
  var STYLE_ID = 'fr-version-style';
  var built = false;
  var els = {};
  var state = {
    current: '',
    source: '',
    builtin: '',
    available: null,
    checking: false,
    downloading: false,
    progress: 0,
    error: '',
    /* 主进程 info() 带回来的远端更新日志。
     * 2026-11-01 新增：原来没有这个字段，导致远端日志拿到了也留不住，
     * 面板永远显示构建时烤进来的旧日志（本地已是 1.0.3 却看不到 1.0.3）。 */
    remoteChangelog: null,
    standalone: !(window.frUpdate && typeof window.frUpdate.info === 'function'),
  };

  /* ---------------------------------------------------------------------
   * 更新日志
   *
   * 【为什么代码里是空的】
   *   发版时由 scripts/make-version.mjs 把条目累积进 发布包/CHANGELOG.json，
   *   再写进 version.json 的 changelog；assemble.mjs 构建时又把整份
   *   CHANGELOG.json 烤成 window.__FR_CHANGELOG_BUILTIN__ 塞进产物。
   *   所以运行时有三层来源（见 pickChangelog），这里不需要硬编码。
   *
   * 【历史更新日志必须永远保留】玩家 2026-11-01：
   *   「我希望更新日志能永远保留，玩家一直能看到所有历史更新日志，
   *     但是默认显示最新的一版在更新日志面板那里。」
   *   → 全部版本都渲染，最新的排最上面并默认展开，旧版本默认折叠。
   * ------------------------------------------------------------------- */
  var BUILTIN_CHANGELOG = [];

  /* 从三层来源里挑最好的一份：
   *   ① 远端 version.json 的 changelog（最新，含刚发的版本）
   *   ② 构建时烤进产物的 window.__FR_CHANGELOG_BUILTIN__（离线/浏览器/安卓可用）
   *   ③ 代码内常量（最后兜底，正常情况为空）
   * 三者都按版本号从新到旧排序并去重，保证「历史永不丢失」。
   *
   * ★ 2026-11-01 玩家报「本地已经是 1.0.3 了，更新日志里却没有 1.0.3」：
   *   根因 1（本条修的）：远端日志原先只在 show() 的 info() 回调里判断了一下
   *     `Array.isArray(s.changelog)` 就重渲染，但**没有把它存回任何地方** ——
   *     进而 pickChangelog() 里读的 window.__FR_CHANGELOG__ 谁都没赋过值，
   *     永远走到 ② 那份构建时烤进来的旧日志（比当前版本落后一版）。
   *   根因 2（assemble.mjs 那条修的）：构建顺序是
   *     assemble（烤日志）→ make-dist → make-version（才写入本版日志），
   *     所以烤进去的那份天生少了正在发的这一版。
   *   两层都修：这里把远端日志存进 state.remoteChangelog 并参与合并，
   *     assemble 那边保证烤进去的含本版。
   */
  function pickChangelog() {
    /* 合并顺序：远端 > 构建内置 > 代码常量。
     * 不是「取第一个非空」，而是**取最全的**：
     * 远端通常最新，但若内置那份包含了远端还没有的版本（离线新增/回滚），
     * 两边的版本都要保留，按版本号排序去重即可。 */
    var sources = [
      window.__FR_CHANGELOG__,              // 远端（运行时拉或主进程 info 带回来）
      state && state.remoteChangelog,       // 主进程 info() 返回的远端日志
      window.__FR_CHANGELOG_BUILTIN__,      // 构建时烤进产物
      BUILTIN_CHANGELOG,                    // 代码常量兜底
    ];

    // 归一化 + 过滤脏数据（一条坏数据不能把整块渲染搞挂）
    var list = [];
    sources.forEach(function (src) {
      if (!Array.isArray(src)) return;
      src.forEach(function (rel) {
        if (!rel || !rel.version) return;
        var items = (rel.items || []).map(function (s) { return String(s); });
        if (!items.length) return;
        list.push({ version: String(rel.version), date: String(rel.date || ''), items: items });
      });
    });

    // 按版本号降序（新的在前），同版本去重（先出现的优先 = 远端优先）
    var seen = {};
    list = list.filter(function (r) {
      if (seen[r.version]) return false;
      seen[r.version] = 1;
      return true;
    });
    list.sort(function (a, b) { return cmpVersion(b.version, a.version); });
    return list;
  }

  /* 版本号比较：1.0.10 > 1.0.9（按数字段比，不能直接字符串比） */
  function cmpVersion(a, b) {
    var pa = String(a || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  /* 当前版本号。
   *
   * 【为什么用全局变量】
   *   浏览器版和安卓版没有 window.frUpdate（那是 Electron 的 preload 桥），
   *   但玩家同样需要在这里看到「我现在是哪个版本」。
   *   assemble.mjs 每次构建都会注入 window.__FR_APP_VERSION__。
   *
   * 【为什么不解析 html 注释】
   *   最初想从 document.documentElement.outerHTML 里抠构建标记
   *   `<!-- ... v0.1.2 -->`。实测 **outerHTML 不包含 <html> 之前的注释节点**，
   *   正则永远不命中 → 浏览器版一直显示「—」（踩过）。
   *   全局变量跟 DOM 结构无关，最可靠。
   */
  function readBuiltinVersion() {
    try {
      if (window.__FR_APP_VERSION__) return String(window.__FR_APP_VERSION__);
    } catch (e) {}
    return '';
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      /* 遮罩：和游戏内其他弹窗一致，body 直挂，能被 --panel-scale 缩放 */
      '#fr-version-panel{',
      '  position:fixed;inset:0;z-index:2147483200;',
      '  display:none;justify-content:center;align-items:center;',
      '  background:rgba(6,8,12,.74);backdrop-filter:blur(3px);',
      '  font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;',
      '}',
      '#fr-version-panel.fr-vp-show{display:flex}',

      '#fr-vp-card{',
      '  position:relative;',
      '  width:min(1120px,calc(100vw - 24px));height:calc(100dvh - 24px);box-sizing:border-box;',
      '  display:flex;flex-direction:column;',
      '  background:',
      '    radial-gradient(120% 80% at 50% 0%,rgba(58,48,32,.5) 0%,rgba(0,0,0,0) 58%),',
      '    linear-gradient(168deg,#242019 0%,#1b1814 46%,#141210 100%);',
      '  border:1px solid rgba(214,178,102,.42);border-radius:15px;',
      '  box-shadow:',
      '    0 28px 80px rgba(0,0,0,.8),',
      '    0 0 0 1px rgba(226,190,110,.09) inset,',
      '    0 0 46px rgba(180,142,62,.13),',
      '    inset 0 1px 0 rgba(255,235,180,.09);',
      '  color:#ece4d4;overflow:hidden;',
      '}',
      /* 内嵌一圈细致的金线（回纹框的简化），让卡片有「装裱」感 */
      '#fr-vp-card::before{',
      '  content:"";position:absolute;inset:6px;pointer-events:none;z-index:0;',
      '  border:1px solid rgba(196,160,88,.16);border-radius:10px;',
      '}',
      /* 顶部一抹灵光，像玉牌受光照亮 */
      '#fr-vp-card::after{',
      '  content:"";position:absolute;left:50%;top:-1px;transform:translateX(-50%);',
      '  width:58%;height:1px;pointer-events:none;',
      '  background:linear-gradient(90deg,rgba(226,190,110,0),rgba(255,224,150,.72),rgba(226,190,110,0));',
      '  box-shadow:0 0 16px rgba(255,214,130,.45);',
      '}',

      /* 头部 */
      '#fr-vp-head{',
      '  display:flex;align-items:center;gap:12px;',
      '  padding:21px 26px 16px;',
      '  border-bottom:1px solid rgba(200,164,88,.18);',
      '  flex:0 0 auto;position:relative;z-index:1;',
      '}',
      '#fr-vp-head h3{',
      '  margin:0;font-size:20px;font-weight:600;color:#f0d489;',
      '  letter-spacing:3px;flex:1 1 auto;',
      '  text-shadow:0 0 18px rgba(226,190,110,.32);',
      '}',
      '#fr-vp-close{',
      '  width:32px;height:32px;flex:0 0 auto;cursor:pointer;',
      '  border-radius:7px;border:1px solid rgba(200,164,88,.24);',
      '  background:rgba(255,255,255,.02);color:#a89c84;font-size:17px;line-height:1;',
      '  transition:all .18s ease;display:flex;align-items:center;justify-content:center;',
      '}',
      '#fr-vp-close:hover{',
      '  background:rgba(226,190,110,.14);color:#f0d489;border-color:rgba(226,190,110,.5);',
      '}',

      /* 版本信息区 */
      '#fr-vp-body{padding:22px 26px 26px;overflow-y:auto;flex:1 1 auto;min-height:0;position:relative;z-index:1}',
      /* 版本信息条：**固定在可滚动区之外**，日志再长也始终可见。
       * 2026-11-02 玩家：「容器上这些都应该始终可见」 */
      '#fr-vp-ver-row{',
      '  display:flex;align-items:center;gap:14px;flex-wrap:wrap;',
      '  padding:18px 26px 16px;flex:0 0 auto;',
      '  border-bottom:1px solid rgba(200,164,88,.13);position:relative;z-index:1;',
      '}',
      '#fr-vp-ver{',
      '  font-size:30px;font-weight:700;color:#f0d489;',
      '  text-shadow:0 0 20px rgba(226,190,110,.38);letter-spacing:1px;',
      '}',
      '#fr-vp-ver-tag{',
      '  font-size:12px;padding:3px 10px;border-radius:20px;',
      '  border:1px solid rgba(120,200,255,.4);color:#8fd0ff;',
      '  background:rgba(120,200,255,.1);',
      '}',
      '#fr-vp-ver-tag.fr-vp-hot{border-color:rgba(255,215,0,.45);color:#ffe680;background:rgba(255,215,0,.1)}',
      /* 检查结果条：**放在可滚动区之外**，日志再长也始终可见。
       * 2026-11-02 玩家：「检测结果要放在容器上面，不然当更新日志很长的时候
       *   滚动到下面就还要返回去上面看检测结果」 */
      '#fr-vp-status{',
      '  display:none;flex:0 0 auto;align-items:center;gap:8px;',
      '  padding:11px 26px;font-size:13px;line-height:1.4;font-weight:500;',
      '  border-bottom:1px solid rgba(200,164,88,.14);',
      '  position:relative;z-index:1;',
      '}',
      /* 每种状态给一条左侧竖条 + 淡底，和下面的日志区分开 */
      '#fr-vp-status.fr-vp-ok{',
      '  color:#8fe39b;background:rgba(125,220,138,.07);',
      '  box-shadow:inset 3px 0 0 rgba(125,220,138,.65);',
      '}',
      '#fr-vp-status.fr-vp-new{',
      '  color:#ffe680;background:rgba(255,215,0,.07);',
      '  box-shadow:inset 3px 0 0 rgba(255,215,0,.7);',
      '}',
      '#fr-vp-status.fr-vp-err{',
      '  color:#ff9c9c;background:rgba(255,120,120,.08);',
      '  box-shadow:inset 3px 0 0 rgba(255,120,120,.7);',
      '}',
      '#fr-vp-status .fr-vp-dot{',
      '  width:7px;height:7px;border-radius:50%;background:#5a5a5a;flex:0 0 auto;',
      '}',
      '#fr-vp-status.fr-vp-new .fr-vp-dot{background:#ffd700;box-shadow:0 0 8px rgba(255,215,0,.85)}',
      '#fr-vp-status.fr-vp-new{color:#ffe680}',
      '#fr-vp-status.fr-vp-ok{color:#7ddc8a}',
      '#fr-vp-status.fr-vp-ok .fr-vp-dot{background:#7ddc8a;box-shadow:0 0 8px rgba(125,220,138,.8)}',
      '#fr-vp-status.fr-vp-err{color:#ff8f8f}',
      '#fr-vp-status.fr-vp-err .fr-vp-dot{background:#ff8f8f}',

      /* 更新日志标题：做成「古籍卷首」的样子，两侧云纹收尾 */
      '#fr-vp-log-title{',
      '  margin:22px 0 14px;font-size:14.5px;color:#c8b285;',
      '  display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;',
      '  font-family:"KaiTi","STKaiti","Noto Serif SC",serif;',
      '  letter-spacing:3px;',
      '}',
      '#fr-vp-log-title::after{',
      '  content:"";flex:1 1 auto;height:1px;',
      '  background:linear-gradient(90deg,rgba(200,164,88,.34),rgba(200,164,88,.05) 75%,rgba(200,164,88,0));',
      '}',
      '#fr-vp-log-title .fr-vp-caret{',
      '  transition:transform .2s ease;font-size:10px;color:#8a7d64;',
      '}',
      '#fr-vp-log-title.fr-vp-collapsed .fr-vp-caret{transform:rotate(-90deg)}',
      '#fr-vp-log{display:flex;flex-direction:column;gap:16px}',
      '#fr-vp-log.fr-vp-collapsed{display:none}',
      /* 版本日志内部分类段：优化 → 修复 → 新增
       * 2026-11-02 玩家：「把优化、修复、新增三类分类，按照我说的这个顺序从上到下」 */
      '#fr-vp-log .fr-vp-rel-sec{margin-bottom:14px}',
      '#fr-vp-log .fr-vp-rel-sec:last-child{margin-bottom:0}',
      '#fr-vp-log .fr-vp-rel-sec-t{',
      '  font-size:12.5px;font-weight:700;color:#e2be6e;letter-spacing:3px;',
      '  display:flex;align-items:center;gap:9px;margin:0 0 6px;',
      '  font-family:"KaiTi","STKaiti","Noto Serif SC",serif;',
      '}',
      '#fr-vp-log .fr-vp-rel-sec-t::after{',
      '  content:"";flex:1 1 auto;height:1px;',
      '  background:linear-gradient(90deg,rgba(200,164,88,.3),rgba(200,164,88,0));',
      '}',

      /* ── 玉简卡：更新日志的主体，做成一块温润的青玉简 ──────────────────
       * 玩家 2026-11-01：「ui做好看有质感一些，符合凡人的修仙风格」
       * 取意：修仙界传讯用「玉简」，青玉为底、金丝为纹。
       * 用渐变模拟玉的透光感，内阴影做厚度，外描边一圈淡金。
       * ──────────────────────────────────────────────────────────── */
      '.fr-vp-rel{',
      '  position:relative;border-radius:11px;padding:17px 19px 16px;',
      '  background:',
      '    radial-gradient(140% 90% at 18% 0%,rgba(96,124,112,.3) 0%,rgba(48,66,60,.16) 38%,rgba(0,0,0,0) 72%),',
      '    linear-gradient(158deg,rgba(38,52,48,.96) 0%,rgba(27,38,35,.98) 52%,rgba(20,29,27,1) 100%);',
      '  border:1px solid rgba(196,166,102,.3);',
      '  box-shadow:',
      '    inset 0 1px 0 rgba(255,255,255,.07),',
      '    inset 0 0 24px rgba(120,160,140,.06),',
      '    inset 0 -1px 0 rgba(0,0,0,.45),',
      '    0 3px 16px rgba(0,0,0,.38);',
      '  overflow:hidden;',
      '}',
      /* 玉石上的一层极淡斜光，让平面有「被照亮」的立体感 */
      '.fr-vp-rel::before{',
      '  content:"";position:absolute;inset:0;pointer-events:none;',
      '  background:linear-gradient(118deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,0) 40%);',
      '}',
      /* 左上角一抹金光，像玉简上的灵纹 */
      '.fr-vp-rel::after{',
      '  content:"";position:absolute;left:0;top:0;width:150px;height:150px;pointer-events:none;',
      '  background:radial-gradient(circle at 0% 0%,rgba(255,215,0,.13),rgba(255,215,0,0) 64%);',
      '}',
      /* 最新一版：金边更亮 + 更强的外发光，一眼锁定「这是当前这版」 */
      '.fr-vp-rel-latest{',
      '  border-color:rgba(232,196,116,.58);',
      '  box-shadow:',
      '    inset 0 1px 0 rgba(255,238,186,.13),',
      '    inset 0 0 28px rgba(140,180,158,.08),',
      '    inset 0 -1px 0 rgba(0,0,0,.45),',
      '    0 4px 22px rgba(0,0,0,.46),',
      '    0 0 30px rgba(206,168,84,.14);',
      '}',
      /* 历史版本：玉色压暗偏灰，弱化但永远保留 */
      '.fr-vp-rel-past{',
      '  background:',
      '    linear-gradient(158deg,rgba(28,32,30,.92) 0%,rgba(21,25,23,.96) 58%,rgba(16,19,17,.98) 100%);',
      '  border-color:rgba(150,140,110,.17);',
      '}',
      '.fr-vp-rel-h{',
      '  display:flex;align-items:baseline;gap:10px;margin-bottom:10px;',
      '  position:relative;z-index:1;',
      '}',
      '.fr-vp-rel-h-clickable{cursor:pointer;user-select:none}',
      '.fr-vp-rel-h-clickable:hover .fr-vp-rel-v{color:#ffe680}',
      /* 版本号用楷体，字距拉开，像古籍卷头题签 */
      '.fr-vp-rel-v{',
      '  font-family:"KaiTi","STKaiti","Noto Serif SC",serif;',
      '  font-size:18px;font-weight:700;color:#edcd85;',
      '  letter-spacing:2.5px;',
      '  text-shadow:0 0 14px rgba(220,178,92,.3),0 1px 0 rgba(0,0,0,.5);',
      '}',
      '.fr-vp-rel-past .fr-vp-rel-v{',
      '  color:#9c927e;font-size:16px;text-shadow:none;letter-spacing:2px;',
      '}',
      /* 「最新」小徽章：做成一枚金印 */
      '.fr-vp-rel-badge{',
      '  font-size:10.5px;line-height:1;padding:4px 7px;border-radius:3px;',
      '  background:linear-gradient(180deg,rgba(226,190,110,.22),rgba(180,145,70,.14));',
      '  color:#f0d38a;border:1px solid rgba(226,190,110,.5);',
      '  letter-spacing:1px;box-shadow:0 0 10px rgba(210,172,88,.16);',
      '}',
      '.fr-vp-rel-d{font-size:12px;color:#7a7264;letter-spacing:.3px}',

      /* 条目列表：每条前面加一枚小小的菱形灵纹，替代默认圆点 */
      '.fr-vp-rel ul{',
      '  margin:0;padding-left:2px;list-style:none;position:relative;z-index:1;',
      '}',
      '.fr-vp-rel li{',
      '  position:relative;padding-left:18px;margin-bottom:8px;',
      '  font-family:"KaiTi","STKaiti","Noto Serif SC",serif;',
      '  font-size:14.5px;line-height:1.92;color:#cdc6b6;',
      '  word-break:break-word;letter-spacing:.4px;',
      '}',
      '.fr-vp-rel li::before{',
      '  content:"";position:absolute;left:2px;top:.66em;',
      '  width:5px;height:5px;transform:rotate(45deg);',
      '  background:rgba(200,168,92,.62);',
      '  box-shadow:0 0 5px rgba(200,168,92,.3);',
      '}',
      '.fr-vp-rel li:last-child{margin-bottom:0}',
      '.fr-vp-rel-past li{color:#948d80;font-size:12.8px}',
      '.fr-vp-rel-past li::before{background:rgba(140,132,112,.45);box-shadow:none}',
      '.fr-vp-empty{font-size:13px;color:#7d786e;padding:10px 0}',

      /* ── 翻页控件：‹ 上一版 | 第 1 版 / 共 3 版 | 下一版 › ─────────────
       * 做成「竹简/玉牌」感的按钮，不是普通灰色方块。
       * ──────────────────────────────────────────────────────────── */
      '.fr-vp-nav{',
      '  display:flex;align-items:center;justify-content:space-between;gap:12px;',
      '  margin-top:16px;padding-top:14px;',
      '  border-top:1px solid rgba(200,168,92,.14);',
      '}',
      '.fr-vp-nav-btn{',
      '  font-family:inherit;font-size:12.5px;line-height:1;letter-spacing:.4px;',
      '  padding:8px 14px;border-radius:5px;cursor:pointer;',
      '  background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.02));',
      '  color:#c0ad83;border:1px solid rgba(190,160,95,.28);',
      '  box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 4px rgba(0,0,0,.25);',
      '  transition:all .18s ease;',
      '}',
      '.fr-vp-nav-btn:hover:not(:disabled){',
      '  background:linear-gradient(180deg,rgba(226,190,110,.18),rgba(200,164,80,.1));',
      '  color:#f3da9a;border-color:rgba(226,190,110,.6);',
      '  box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 14px rgba(200,164,80,.2);',
      '}',
      '.fr-vp-nav-btn:active:not(:disabled){transform:translateY(1px)}',
      '.fr-vp-nav-btn:disabled,.fr-vp-nav-off{',
      '  opacity:.26;cursor:default;pointer-events:none;box-shadow:none;',
      '}',
      '.fr-vp-nav-counter{',
      '  font-size:12px;color:#8a8272;flex:1 1 auto;text-align:center;',
      '  user-select:none;letter-spacing:1.2px;font-variant-numeric:tabular-nums;',
      '}',

      /* 条目多时给个滚动上限，避免把面板撑到天上去 */
      '#fr-vp-log{max-height:44vh;overflow-y:auto;padding-right:5px}',
      '#fr-vp-log::-webkit-scrollbar{width:6px}',
      '#fr-vp-log::-webkit-scrollbar-track{background:transparent}',
      '#fr-vp-log::-webkit-scrollbar-thumb{',
      '  background:linear-gradient(180deg,rgba(200,168,92,.3),rgba(200,168,92,.16));',
      '  border-radius:3px;',
      '}',
      '#fr-vp-log::-webkit-scrollbar-thumb:hover{background:rgba(200,168,92,.45)}',

      /* 进度条 */
      '#fr-vp-prog{',
      '  display:none;margin-top:18px;',
      '}',
      '#fr-vp-prog.fr-vp-show{display:block}',
      '#fr-vp-prog-bar{',
      '  height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden;',
      '}',
      '#fr-vp-prog-bar i{',
      '  display:block;height:100%;width:0;background:linear-gradient(90deg,#ffd700,#ffe680);',
      '  transition:width .25s ease;',
      '}',
      '#fr-vp-prog-txt{font-size:12px;color:#a9a294;margin-top:7px}',

      /* 底部按钮 */
      '#fr-vp-foot{',
      '  display:flex;gap:12px;padding:16px 24px 20px;',
      '  border-top:1px solid rgba(255,255,255,.07);flex:0 0 auto;',
      '}',
      '#fr-vp-foot button{',
      '  cursor:pointer;border-radius:9px;padding:10px 20px;font-size:14px;',
      '  font-family:inherit;transition:all .18s ease;border:1px solid transparent;',
      '}',
      '#fr-vp-check{',
      '  background:transparent;border-color:rgba(255,255,255,.18);color:#c4bdb0;',
      '}',
      '#fr-vp-check:hover:not(:disabled){background:rgba(255,255,255,.07);color:#fff}',
      '#fr-vp-apply{',
      '  background:linear-gradient(135deg,#ffd700,#ffbf00);color:#1a1a1a;',
      '  font-weight:600;margin-left:auto;display:none;',
      '}',
      '#fr-vp-apply:hover:not(:disabled){filter:brightness(1.1)}',
      '#fr-vp-apply.fr-vp-show{display:block}',
      '#fr-vp-foot button:disabled{opacity:.45;cursor:default}',
      '#fr-vp-hint{',
      '  font-size:12px;color:#7d786e;margin-right:auto;align-self:center;',
      '}',

      /* 窄屏 */
      '@media(max-width:640px){',
      '  #fr-vp-card{width:calc(100vw - 16px);height:calc(100dvh - 16px)}',
      '  #fr-vp-head{padding:16px 18px 12px}',
      '  #fr-vp-body{padding:18px}',
      '  #fr-vp-foot{padding:14px 18px 16px;flex-wrap:wrap}',
      '  #fr-vp-ver{font-size:24px}',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* 建 DOM。只在第一次打开时调用。 */
  function build() {
    if (built) return;
    injectStyle();

    var panel = el('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    var card = el('div');
    card.id = 'fr-vp-card';

    // --- 头部 ---
    var head = el('div');
    head.id = 'fr-vp-head';
    head.appendChild(el('h3', null, '版本更新'));
    var close = el('button');
    close.id = 'fr-vp-close';
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', hide);
    head.appendChild(close);

    // --- 主体 ---
    var body = el('div');
    body.id = 'fr-vp-body';

    var verRow = el('div');
    verRow.id = 'fr-vp-ver-row';
    els.ver = el('div', null, '—');
    els.ver.id = 'fr-vp-ver';
    els.tag = el('span', null, '');
    els.tag.id = 'fr-vp-ver-tag';
    els.tag.style.display = 'none';
    verRow.appendChild(els.ver);
    verRow.appendChild(els.tag);

    /* ★ 2026-11-02 玩家：「这个已是最新版本的检测结果或者其他检测结果要放在容器上面，
     *   不然当更新日志很长的时候滚动到下面就还要返回去上面看检测结果」
     *
     * 原来 #fr-vp-status 挂在 verRow 里，而 verRow 属于可滚动的 #fr-vp-body ——
     * 日志一长，玩家往下滚，检查结果就滚出视野了，必须滚回顶部才看得到。
     * 现在把状态条移出 body，做成卡片内**不参与滚动**的一条，固定在顶部信息区下方，
     * 无论日志滚到哪里都始终可见。
     * 没有内容时自动隐藏（不占位），避免平时多出一条空白。
     */
    els.status = el('div');
    els.status.id = 'fr-vp-status';
    els.statusDot = el('span', 'fr-vp-dot');
    els.statusTxt = el('span', null, '');
    els.status.appendChild(els.statusDot);
    els.status.appendChild(els.statusTxt);
    els.status.style.display = 'none';   // 有内容才显示

    var logTitle = el('div');
    logTitle.id = 'fr-vp-log-title';
    var caret = el('span', 'fr-vp-caret', '▾');
    logTitle.appendChild(caret);
    logTitle.appendChild(el('span', null, '更新日志'));
    var log = el('div');
    log.id = 'fr-vp-log';
    logTitle.addEventListener('click', function () {
      logTitle.classList.toggle('fr-vp-collapsed');
      log.classList.toggle('fr-vp-collapsed');
    });
    els.log = log;
    els.logTitle = logTitle;

    // 进度
    var prog = el('div');
    prog.id = 'fr-vp-prog';
    var barWrap = el('div');
    barWrap.id = 'fr-vp-prog-bar';
    els.progBar = el('i');
    barWrap.appendChild(els.progBar);
    els.progTxt = el('div');
    els.progTxt.id = 'fr-vp-prog-txt';
    prog.appendChild(barWrap);
    prog.appendChild(els.progTxt);
    els.prog = prog;

    // verRow 已移到 body 外（固定可见），这里只放会滚动的内容
    body.appendChild(logTitle);
    body.appendChild(log);
    body.appendChild(prog);

    // --- 底部 ---
    var foot = el('div');
    foot.id = 'fr-vp-foot';
    els.hint = el('span');
    els.hint.id = 'fr-vp-hint';
    els.checkBtn = el('button');
    els.checkBtn.id = 'fr-vp-check';
    els.checkBtn.type = 'button';
    els.checkBtn.textContent = '检查更新';
    els.checkBtn.addEventListener('click', onCheck);
    els.applyBtn = el('button');
    els.applyBtn.id = 'fr-vp-apply';
    els.applyBtn.type = 'button';
    els.applyBtn.textContent = '立即更新';
    els.applyBtn.addEventListener('click', onApply);
    foot.appendChild(els.hint);
    foot.appendChild(els.checkBtn);
    foot.appendChild(els.applyBtn);

    /* verRow 也移出 body：版本号 / 热更新标记 / 检查结果
     * 都属于「当前状态」，天然该固定在上面，不随日志滚动。
     * 2026-11-02 玩家：「容器上这些都应该始终可见」 */
    card.appendChild(head);
    card.appendChild(verRow);
    card.appendChild(els.status);
    card.appendChild(body);
    card.appendChild(foot);
    panel.appendChild(card);

    // 点遮罩关闭（点卡片内部不关）
    panel.addEventListener('click', function (e) {
      if (e.target === panel) hide();
    });
    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('fr-vp-show')) hide();
    });

    document.body.appendChild(panel);
    els.panel = panel;
    built = true;
  }

  function setStatus(kind, text) {
    if (!els.status) return;
    els.status.className = kind ? 'fr-vp-' + kind : '';
    els.statusTxt.textContent = text || '';
    // 没内容就不占位；有内容才显示（display:flex 由 CSS 类提供，这里只切 none/空）
    els.status.style.display = (text ? 'flex' : 'none');
  }

  /* 更新日志渲染：**一次只显示一版，左右翻页**。
   *
   * 玩家 2026-11-01：「应该用上一篇下一篇左右选择这种方式最好吧？」
   * 理由成立：更新日志每个版本动辄十几条，全部平铺会让面板长到要滚很久，
   * 玩家真正关心的只有「最新这版改了什么」。所以：
   *   · 默认落在最新一版（下标 0）
   *   · 左右按钮翻到更早/更新的版本
   *   · 中间显示「第 1 版 / 共 3 版」，玩家清楚还有多少历史
   *   · 所有版本的数据一直留着，只是不同时渲染 —— 历史永不丢失
   */
  var logRels = [];     // 排好序的全部版本（新→旧）
  var logIndex = 0;     // 当前显示第几版
  var logNav = null;    // 翻页控件缓存

  /* 把条目按「优化 → 修复 → 新增」分组。
   * 条目自带【优化】/【修复】/【新增】前缀，这里只负责分组与顺序；
   * 没有前缀的历史条目归入「修复」，空分组不返回（避免出现空标题）。 */
  function groupItemsByKind(items) {
    var buckets = { '优化': [], '修复': [], '新增': [] };
    (items || []).forEach(function (raw) {
      var text = String(raw == null ? '' : raw).trim();
      if (!text) return;
      var m = text.match(/^【(优化|修复|新增)】\s*/);
      if (m) buckets[m[1]].push(text.slice(m[0].length));
      else buckets['修复'].push(text);
    });
    var out = [];
    ['优化', '修复', '新增'].forEach(function (k) {
      if (buckets[k].length) out.push({ label: k, rows: buckets[k] });
    });
    return out;
  }

  function renderLogPage() {
    if (!els.log) return;
    els.log.textContent = '';

    if (!logRels.length) {
      els.log.appendChild(el('div', 'fr-vp-empty',
        '暂无更新记录。以后有新版本时会显示在这里。'));
      if (logNav && logNav.wrap) logNav.wrap.style.display = 'none';
      return;
    }

    var rel = logRels[logIndex];
    var isLatest = logIndex === 0;

    var box = el('div', 'fr-vp-rel' + (isLatest ? ' fr-vp-rel-latest' : ' fr-vp-rel-past'));
    var h = el('div', 'fr-vp-rel-h');
    h.appendChild(el('span', 'fr-vp-rel-v', 'v' + String(rel.version || '')));
    if (isLatest) h.appendChild(el('span', 'fr-vp-rel-badge', '最新'));
    if (rel.date) h.appendChild(el('span', 'fr-vp-rel-d', String(rel.date)));
    box.appendChild(h);

    /* ★ 2026-11-02 玩家：「更新日志把优化、修复、新增三类分类，
     *   按照我说的这个顺序从上到下，不要混在一起了。」
     *
     * 原来这里把所有条目平铺成一个 ul，优化/修复/新增混在一起。
     * 现在按前缀分成三段渲染，顺序固定为 优化 → 修复 → 新增，
     * 与对外日志文件、以及启动面板的分组口径完全一致。
     * 没有前缀的历史条目（早期版本日志就是这样）归入「修复」，
     * 保证老版本日志也能正常显示、不漏条目。
     */
    var groups = groupItemsByKind(rel.items || []);
    groups.forEach(function (group) {
      var sec = el('div', 'fr-vp-rel-sec');
      var st = el('div', 'fr-vp-rel-sec-t', group.label);
      sec.appendChild(st);
      var ul = el('ul');
      group.rows.forEach(function (it) {
        ul.appendChild(el('li', null, String(it)));
      });
      sec.appendChild(ul);
      box.appendChild(sec);
    });
    els.log.appendChild(box);

    if (logNav && logNav.wrap) {
      logNav.wrap.style.display = logRels.length > 1 ? 'flex' : 'none';
      logNav.counter.textContent = '第 ' + (logIndex + 1) + ' 版 / 共 ' + logRels.length + ' 版';
      // 最新一版时「下一版」是禁用的（没有比它更新的）
      logNav.next.disabled = logIndex <= 0;
      logNav.prev.disabled = logIndex >= logRels.length - 1;
      logNav.next.classList.toggle('fr-vp-nav-off', logIndex <= 0);
      logNav.prev.classList.toggle('fr-vp-nav-off', logIndex >= logRels.length - 1);
    }
  }

  /* 建左右翻页控件（只建一次，复用） */
  function buildLogNav() {
    if (logNav || !els.log || !els.log.parentNode) return;
    var wrap = el('div', 'fr-vp-nav');

    var prev = el('button', 'fr-vp-nav-btn fr-vp-nav-prev');
    prev.type = 'button';
    prev.textContent = '‹ 上一版';
    prev.title = '查看更早的版本';

    var counter = el('span', 'fr-vp-nav-counter', '');

    var next = el('button', 'fr-vp-nav-btn fr-vp-nav-next');
    next.type = 'button';
    next.textContent = '下一版 ›';
    next.title = '回到更新的版本';

    prev.addEventListener('click', function () {
      if (logIndex >= logRels.length - 1) return;
      logIndex++;
      renderLogPage();
    });
    next.addEventListener('click', function () {
      if (logIndex <= 0) return;
      logIndex--;
      renderLogPage();
    });

    wrap.appendChild(prev);
    wrap.appendChild(counter);
    wrap.appendChild(next);
    els.log.parentNode.insertBefore(wrap, els.log.nextSibling);

    logNav = { wrap: wrap, prev: prev, next: next, counter: counter };
  }

  function renderLog(list) {
    logRels = (list || []).filter(function (r) {
      return r && r.version && (r.items || []).length;
    });
    logIndex = 0;           // **每次打开都回到最新一版**
    buildLogNav();
    renderLogPage();
  }

  /* 把更新日志渲染出来。
   *
   * 【为什么不再区分 standalone / PC】
   *   原来 standalone（浏览器/安卓）直接渲染空的 BUILTIN_CHANGELOG 就返回了，
   *   PC 端又要等 info() 回来才有日志 —— 玩家看到的就是「一打开什么都没有」。
   *   现在统一走 pickChangelog()：远端有就用远端，没有就用构建时烤进来的，
   *   **每次打开面板都立刻有最新一版的内容**，不需要先点「检查更新」。
   */
  function loadRemoteChangelog() {
    renderLog(pickChangelog());
  }

  /* 刷新界面状态 */
  function refresh() {
    if (!built) return;
    els.ver.textContent = state.current ? 'v' + state.current : '—';

    if (state.source === 'hot') {
      els.tag.textContent = '热更新';
      els.tag.className = 'fr-vp-hot';
      els.tag.style.display = '';
      els.tag.title = '当前运行的是热更新下载的版本';
    } else if (state.source === 'builtin') {
      els.tag.textContent = '安装包内置';
      els.tag.className = '';
      els.tag.style.display = '';
      els.tag.title = '当前运行的是安装包自带的版本';
    } else {
      els.tag.style.display = 'none';
    }

    // 独立环境（浏览器版/安卓版）没有自动更新能力，
    // 但版本号照样要显示 —— 玩家口径要「可以看到版本号」。
    if (state.standalone) {
      els.checkBtn.disabled = true;
      els.checkBtn.textContent = '检查更新';
      els.applyBtn.classList.remove('fr-vp-show');
      els.hint.textContent = '';
      setStatus('', '当前版本 · 此平台需手动安装新版本');
      return;
    }

    els.hint.textContent = state.builtin && state.builtin !== state.current
      ? '（内置版本 ' + state.builtin + '）' : '';

    if (state.downloading) {
      setStatus('', '正在下载…');
      els.checkBtn.disabled = true;
      els.applyBtn.classList.remove('fr-vp-show');
      return;
    }

    if (state.error) {
      setStatus('err', state.error);
    }

    if (state.available) {
      /* ★ 2026-11-01 玩家定的规则：同一个版本号也可能有内容不同的修正包，
       * 那种情况不能用「发现新版本 v1.0.3」—— 玩家会疑惑「我明明就是 1.0.3」。
       * 主进程 needUpdate() 会给 reason，这里按 reason 说不一样的话。 */
      var reason = state.available.reason || '';
      if (reason === 'same-version-new-content' || reason === 'local-sha-unknown') {
        setStatus('new', '发现同一版本号的修正包（v' + state.available.version + '）');
        els.applyBtn.textContent = '更新到修正版 v' + state.available.version;
      } else {
        setStatus('new', '发现新版本 ' + state.available.version);
        els.applyBtn.textContent = '立即更新到 v' + state.available.version;
      }
      els.applyBtn.classList.add('fr-vp-show');
      els.applyBtn.disabled = false;
      els.checkBtn.disabled = false;
      els.checkBtn.textContent = '重新检查';
    } else if (!state.checking && !state.error) {
      // 检查过且没新版
      if (state._checkedOnce) {
        setStatus('ok', '已是最新版本');
        els.checkBtn.textContent = '重新检查';
      } else {
        setStatus('', '');
        els.checkBtn.textContent = '检查更新';
      }
      els.applyBtn.classList.remove('fr-vp-show');
      els.checkBtn.disabled = false;
    }
  }

  /* 打开页面：先把已有的日志立刻显示出来，再异步补远端信息。
   *
   * 【为什么先渲染再等】
   *   玩家要求「每次打开更新版本界面都自动显示最新的更新日志」。
   *   原来这里是先 loadRemoteChangelog()（PC 端那时还是空）再等 info()，
   *   而 info() 只在主进程成功 check 过之后才带 changelog —— 玩家没点过
   *   「检查更新」就永远看不到日志。现在 pickChangelog() 立刻给内容，
   *   info() 回来后若有更全的远端日志再换掉。
   */
  function show() {
    build();
    els.panel.classList.add('fr-vp-show');
    loadRemoteChangelog();

    if (state.standalone) {
      // 浏览器版/安卓版：从构建标记里读版本号，保证「可以看到版本号」
      state.current = readBuiltinVersion();
      state.source = '';
      refresh();
      return;
    }

    window.frUpdate.info().then(function (s) {
      if (!s) return;
      state.current = s.current || '';
      state.source = s.source || '';
      state.builtin = s.builtin || '';
      state.available = s.available || null;
      state.downloading = !!s.downloading;
      state.progress = s.progress || 0;
      state.error = s.error || '';
      /* 远端带了完整更新日志就存起来并重渲染（更全、更新）。
       * ★ 2026-11-01 修：原来这里只判断了一下就重渲染，
       *   但**没把 s.changelog 存到任何地方** —— pickChangelog() 读的
       *   window.__FR_CHANGELOG__ 谁都没赋过值，所以永远显示构建内置那份旧日志。
       *   现在存进 state.remoteChangelog，并同步挂到 window.__FR_CHANGELOG__，
       *   让后续任何一次 pickChangelog()（重新打开面板等）都能拿到。
       * 注意：**没有远端日志时不要清空**，刚才 pickChangelog() 已经
       *   用构建内置的那份渲染好了 —— 这正是「历史日志永不消失」的关键。 */
      if (Array.isArray(s.changelog) && s.changelog.length) {
        state.remoteChangelog = s.changelog;
        try { window.__FR_CHANGELOG__ = s.changelog; } catch (_) { /* 只读环境忽略 */ }
        renderLog(pickChangelog());
      }
      refresh();
    }).catch(function (e) {
      setStatus('err', '读取版本信息失败：' + ((e && e.message) || e));
    });
  }

  function hide() {
    if (els.panel) els.panel.classList.remove('fr-vp-show');
  }

  function onCheck() {
    if (state.standalone || state.checking) return;
    state.checking = true;
    state.error = '';
    els.checkBtn.disabled = true;
    els.checkBtn.textContent = '检查中…';
    setStatus('', '正在连接更新服务器…');

    window.frUpdate.check({ manual: false }).then(function (r) {
      state.checking = false;
      state._checkedOnce = true;
      if (r && r.ok) {
        if (r.hasUpdate) {
          // 再拉一次 info 拿 available 详情
          return window.frUpdate.info().then(function (s) {
            if (s) {
              state.current = s.current || state.current;
              state.available = s.available || null;
            }
            refresh();
          });
        }
        state.available = null;
        state.error = '';
        refresh();
      } else {
        state.error = '检查失败：' + ((r && r.reason) || '未知错误');
        refresh();
      }
    }).catch(function (e) {
      state.checking = false;
      state.error = '检查失败：' + ((e && e.message) || e);
      refresh();
    });
  }

  function onApply() {
    if (state.standalone || state.downloading || !state.available) return;
    state.downloading = true;
    state.progress = 0;
    els.prog.classList.add('fr-vp-show');
    els.progBar.style.width = '2%';
    els.progTxt.textContent = '准备下载…';
    refresh();

    // 只在下载期间轮询进度，结束立刻停
    var timer = setInterval(function () {
      window.frUpdate.info().then(function (s) {
        if (s && s.downloading) {
          var p = s.progress || 0;
          if (p > state.progress) {
            state.progress = p;
            els.progBar.style.width = Math.max(2, Math.min(100, p)) + '%';
            els.progTxt.textContent = '下载中 ' + Math.round(p) + '%';
          }
        }
      }).catch(function () {});
    }, 350);

    window.frUpdate.apply().then(function (r) {
      clearInterval(timer);
      state.downloading = false;
      if (r && r.ok) {
        els.progBar.style.width = '100%';
        els.progTxt.textContent = '下载完成，重启后生效（存档不受影响）';
        setStatus('ok', '更新已就绪');
        state.available = null;
        els.applyBtn.classList.remove('fr-vp-show');
        els.checkBtn.disabled = false;
        els.checkBtn.textContent = '检查更新';
      } else {
        state.error = '更新失败：' + ((r && r.reason) || '未知错误');
        els.prog.classList.remove('fr-vp-show');
        refresh();
      }
    }).catch(function (e) {
      clearInterval(timer);
      state.downloading = false;
      state.error = '更新失败：' + ((e && e.message) || e);
      els.prog.classList.remove('fr-vp-show');
      refresh();
    });
  }

  /* ---------------------------------------------------------------------
   * 绑入口
   *
   * 两个入口，都走同一个页面：
   *   ① 首屏 #splash-update-btn（开始新人生 / 读取人生 / 创意工坊 旁边）
   *   ② 游戏内 系统控制台 → 数据与管理 → #open-version-panel-btn
   *      （玩家口径：「初始页面还有游戏内系统设置页面都要有」）
   *
   * 都用事件委托 + __frVpBound 标记，避免重复绑定。
   * ------------------------------------------------------------------- */
  var ENTRY_IDS = ['splash-update-btn', 'open-version-panel-btn'];

  function bindEntry() {
    ENTRY_IDS.forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn && !btn.__frVpBound) {
        btn.__frVpBound = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          show();
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntry);
  } else {
    bindEntry();
  }

  // 首屏和系统设置面板都可能被重建/延迟插入，用一次性委托兜底。
  // 只在点击时做一次 getElementById，不轮询、不开观察器。
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.id && ENTRY_IDS.indexOf(t.id) >= 0 && !t.__frVpBound) {
        bindEntry();
        return;
      }
      t = t.parentElement;
    }
  }, true);

  // 系统设置面板打开时顺手绑一次（面板是静态的，点一次就够）
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.id === 'system-settings-button' || (t.closest && t.closest('#system-settings-button'))) {
        bindEntry();
        return;
      }
      t = t.parentElement;
    }
  }, true);

  // 给提示条和其他模块用
  window.frVersionPanel = { show: show, hide: hide };
})();
