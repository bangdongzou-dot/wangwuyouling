/* ============================================================================
 * 热更新界面提示条（注入到 dist/index.html 里）
 *
 * 玩家口径：
 *   · 「后台检查 + 提示，玩家自选」→ 不自动下载，只在角落轻提示，玩家点才更新
 *   · 「以玩家体验为主，越流畅越好，没必要的内容都不要」
 *     → 纯事件驱动，零轮询、零 MutationObserver、零 setInterval。
 *       没更新时**连 DOM 都不创建**，对游戏零开销。
 *
 * 【为什么不做成游戏内的面板】
 *   游戏面板都在 .cultivation-panel 里，会被 zoom 缩放，且弹窗样式各自不同。
 *   更新提示是「系统级」的，应该挂在最外层、独立于游戏 UI，玩家在任何界面
 *   都能看到，也不会被游戏的缩放/主题影响。
 *
 * 【只在 Electron 里工作】
 *   浏览器版（file:// 直接打开 html）没有 window.frUpdate，本模块静默退出，
 *   不报错、不占资源。
 * ========================================================================== */
(function () {
  'use strict';

  // 浏览器版 / 安卓版没有 preload 桥，直接不干活
  if (!window.frUpdate || typeof window.frUpdate.info !== 'function') return;

  var STYLE_ID = 'fr-update-style';
  var BAR_ID = 'fr-update-bar';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#fr-update-bar{',
      '  position:fixed;right:18px;bottom:18px;z-index:2147483000;',
      '  display:flex;align-items:center;gap:10px;',
      '  padding:10px 14px;border-radius:10px;',
      '  background:linear-gradient(135deg,rgba(38,34,28,.97),rgba(24,22,18,.97));',
      '  border:1px solid rgba(255,215,0,.42);',
      '  box-shadow:0 8px 26px rgba(0,0,0,.55),0 0 0 1px rgba(255,215,0,.08) inset;',
      '  color:#f0e6d2;font-size:14px;line-height:1.4;',
      '  font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;',
      '  opacity:0;transform:translateY(10px);',
      '  transition:opacity .28s ease,transform .28s ease;',
      '  pointer-events:none;max-width:min(560px,92vw);',
      '}',
      '#fr-update-bar.fr-up-show{opacity:1;transform:translateY(0);pointer-events:auto}',
      '#fr-update-bar .fr-up-dot{',
      '  width:7px;height:7px;border-radius:50%;background:#ffd700;flex:0 0 auto;',
      '  box-shadow:0 0 8px rgba(255,215,0,.85);',
      '}',
      '#fr-update-bar .fr-up-text{flex:1 1 auto;min-width:0}',
      '#fr-update-bar .fr-up-text b{color:#ffd700;font-weight:600}',
      '#fr-update-bar .fr-up-note{',
      '  display:block;color:#a9a294;font-size:12px;margin-top:2px;',
      '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;',
      '}',
      '#fr-update-bar button{',
      '  flex:0 0 auto;cursor:pointer;border-radius:7px;padding:6px 13px;',
      '  font-size:13px;font-family:inherit;border:1px solid rgba(255,215,0,.45);',
      '  background:rgba(255,215,0,.14);color:#ffe680;transition:background .18s ease;',
      '}',
      '#fr-update-bar button:hover{background:rgba(255,215,0,.26)}',
      '#fr-update-bar button:disabled{opacity:.55;cursor:default}',
      '#fr-update-bar .fr-up-later{',
      '  background:transparent;border-color:rgba(255,255,255,.16);color:#9c968a;',
      '}',
      '#fr-update-bar .fr-up-later:hover{background:rgba(255,255,255,.07)}',
      '#fr-update-bar .fr-up-progress{',
      '  height:3px;border-radius:2px;background:rgba(255,255,255,.12);',
      '  overflow:hidden;margin-top:6px;',
      '}',
      '#fr-update-bar .fr-up-progress i{',
      '  display:block;height:100%;width:0;background:#ffd700;',
      '  transition:width .2s ease;',
      '}',
      /* 下载中的详细数据行：已下载/总大小 · 速度 · 剩余时间
         2026-11-01 玩家：「能让玩家直观看到更新下载进度而已，不然没反馈都不知道在不在
         下载和更新。」——光有个百分比不够，玩家还想知道「多大、多快、还要多久」。 */
      '#fr-update-bar .fr-up-stats{',
      '  display:flex;gap:10px;margin-top:5px;font-size:11.5px;color:#8f887a;',
      '  font-variant-numeric:tabular-nums;white-space:nowrap;',
      '}',
      '#fr-update-bar .fr-up-stats span{flex:0 0 auto}',
      '#fr-update-bar .fr-up-pct{color:#ffd700;font-weight:600}',
      /* ── 本版更新日志：优化 → 修复 → 新增 三段 ──────────────────────
       * 2026-11-02 玩家：「检查更新检测到新版本就应该先把版本更新日志显示出来」
       *                 「优化、修复、新增三类分类，按照我说的这个顺序从上到下」
       * 条目多时整块可滚动，提示条本身不会被撑出屏幕。 */
      '#fr-update-bar{flex-wrap:wrap}',
      '#fr-update-bar .fr-up-dot{align-self:flex-start;margin-top:6px}',
      '#fr-update-bar .fr-up-changelog{',
      '  margin-top:8px;max-height:min(46vh,380px);overflow-y:auto;',
      '  padding-right:4px;',
      '  overscroll-behavior:contain;scrollbar-width:thin;',
      '}',
      '#fr-update-bar .fr-up-changelog::-webkit-scrollbar{width:6px}',
      '#fr-update-bar .fr-up-changelog::-webkit-scrollbar-thumb{',
      '  background:rgba(255,215,0,.3);border-radius:3px;',
      '}',
      '#fr-update-bar .fr-up-sec{margin-bottom:10px}',
      '#fr-update-bar .fr-up-sec:last-child{margin-bottom:0}',
      '#fr-update-bar .fr-up-sec-t{',
      '  font-size:12px;font-weight:700;color:#ffd700;letter-spacing:2px;',
      '  margin-bottom:4px;display:flex;align-items:center;gap:8px;',
      '}',
      '#fr-update-bar .fr-up-sec-t::after{',
      '  content:"";flex:1 1 auto;height:1px;',
      '  background:linear-gradient(90deg,rgba(255,215,0,.28),rgba(255,215,0,0));',
      '}',
      '#fr-update-bar .fr-up-sec-list{display:flex;flex-direction:column;gap:4px}',
      '#fr-update-bar .fr-up-line{',
      '  position:relative;padding-left:13px;font-size:12.5px;line-height:1.62;',
      '  color:#ded6c6;overflow-wrap:anywhere;',
      '}',
      '#fr-update-bar .fr-up-line::before{',
      '  content:"";position:absolute;left:2px;top:8px;',
      '  width:4px;height:4px;border-radius:50%;background:rgba(255,215,0,.6);',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  var bar = null;
  var noteEl = null;
  var textEl = null;
  var changLogEl = null;   // 本版更新日志（优化/修复/新增 三组）
  var btnUpdate = null;
  var btnLater = null;
  /* 2026-11-03 玩家要求「新版本提示做一个忽略按钮」：按钮 + 当前提示的版本号 */
  var btnIgnore = null;
  var barRelease = '';
  var progWrap = null;
  var progBar = null;
  var progsWrap2 = null;   // 统计行容器
  var statPct = null;
  var statSize = null;
  var statSpeed = null;
  var statEta = null;
  var hideTimer = null;
  var busy = false;
  /* 记住最近一次提示过的「本版日志」，供下载完成后就地渲染用。
   * 不存 localStorage：它只服务于「这一轮提示 → 下载完成」这条内存链路，
   * 跨重启没有意义（重启后版本页面自己会从远端拉最新日志）。 */
  var lastChangelog = null;
  var lastNotifiedRelease = '';

  /* 记录已提示的补丁，避免同一次运行里重复提醒。
   * 用 sessionStorage 而不是 localStorage：关掉游戏再开，若还没更新，
   * 玩家仍应被再提醒一次（否则他会一直不知道有新版本）。 */
  function updateReleaseKey(version, sha256) {
    var v = String(version || '').trim();
    var hash = String(sha256 || '').trim().toLowerCase();
    return v && (/^[a-f0-9]{64}$/.test(hash) ? v + ':' + hash : v);
  }
  function rememberShownRelease(release) {
    if (!release) return;
    lastNotifiedRelease = release;
    try { sessionStorage.setItem('fr-up-shown-release', release); } catch (e) {}
  }
  function alreadyShownRelease(release) {
    if (!release) return false;
    if (lastNotifiedRelease === release) return true;
    try { return sessionStorage.getItem('fr-up-shown-release') === release; } catch (e) { return false; }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtEta(sec) {
    sec = Number(sec);
    if (!(sec >= 0)) return '';
    if (sec < 60) return '约 ' + Math.max(1, Math.round(sec)) + ' 秒';
    return '约 ' + Math.round(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒';
  }

  function buildBar() {
    if (bar) return bar;
    injectStyle();

    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');

    var dot = document.createElement('span');
    dot.className = 'fr-up-dot';

    var txt = document.createElement('div');
    txt.className = 'fr-up-text';
    textEl = document.createElement('span');
    textEl.textContent = '';
    noteEl = document.createElement('span');
    noteEl.className = 'fr-up-note';
    noteEl.textContent = '';
    var prog = document.createElement('div');
    prog.className = 'fr-up-progress';
    progBar = document.createElement('i');
    prog.appendChild(progBar);
    progWrap = prog;

    // 统计行：百分比 · 已下载/总大小 · 速度 · 剩余时间
    var stats = document.createElement('div');
    stats.className = 'fr-up-stats';
    statPct = document.createElement('span');
    statPct.className = 'fr-up-pct';
    statSize = document.createElement('span');
    statSpeed = document.createElement('span');
    statEta = document.createElement('span');
    stats.appendChild(statPct);
    stats.appendChild(statSize);
    stats.appendChild(statSpeed);
    stats.appendChild(statEta);
    progsWrap2 = stats;

    // 本版更新日志容器：按 优化 → 修复 → 新增 三段渲染
    changLogEl = document.createElement('div');
    changLogEl.className = 'fr-up-changelog';
    changLogEl.style.display = 'none';

    txt.appendChild(textEl);
    txt.appendChild(noteEl);
    txt.appendChild(changLogEl);
    txt.appendChild(prog);
    txt.appendChild(stats);
    progWrap.style.display = 'none';
    stats.style.display = 'none';

    btnUpdate = document.createElement('button');
    btnUpdate.type = 'button';
    btnUpdate.textContent = '立即更新';
    btnUpdate.addEventListener('click', onUpdate);

    btnLater = document.createElement('button');
    btnLater.type = 'button';
    btnLater.className = 'fr-up-later';
    btnLater.textContent = '详情';
    btnLater.addEventListener('click', function () {
      // 「详情」打开完整的版本更新页面（版本号 + 更新日志 + 检查/更新）
      hideBar();
      try {
        if (window.frVersionPanel && typeof window.frVersionPanel.show === 'function') {
          window.frVersionPanel.show();
        }
      } catch (e) { /* 打开失败不影响游戏 */ }
    });

    /* ★★★ 2026-11-03 玩家：「这个新版本提示做一个忽略按钮，可以暂时关闭提示。」
     *
     * 「暂时」是要害：玩家不想每次进游戏都被这条提示挡一下，
     * 但也不希望永久关闭（以后真出问题还得能看到）。
     *
     * 所以做成**按版本号忽略**：
     *   · 忽略当前这个版本 → 记下版本号，同一版本不再弹提示条
     *   · 以后检测到**更新的版本**（版本号不同）→ 重新提示
     * 而不是写一个永久的「已读」开关 —— 那样以后的新版本提示也会被一起吞掉。
     *
     * 存储用 localStorage（跨启动保留），键名带版本号，
     * 这样 1.0.7 被忽略不影响 1.0.8 弹出来。 */
    btnIgnore = document.createElement('button');
    btnIgnore.type = 'button';
    btnIgnore.className = 'fr-up-later';
    btnIgnore.textContent = '忽略';
    btnIgnore.title = '忽略这份补丁，后续新补丁仍会提醒';
    btnIgnore.addEventListener('click', function () {
      try { rememberIgnored(barRelease); } catch (e) { }
      hideBar();
    });

    bar.appendChild(dot);
    bar.appendChild(txt);
    bar.appendChild(btnUpdate);
    bar.appendChild(btnLater);
    bar.appendChild(btnIgnore);
    document.body.appendChild(bar);
    return bar;
  }

  /* 忽略只作用于本次提示的补丁，下一份同版本补丁仍可提醒。 */
  var IGNORE_KEY = 'FR_UPDATE_IGNORED_RELEASE_V2';
  function rememberIgnored(version) {
    var v = String(version || '').trim();
    if (!v) return;
    try { localStorage.setItem(IGNORE_KEY, v); } catch (e) { }
  }
  function isIgnored(version) {
    var v = String(version || '').trim();
    if (!v) return false;
    try { return String(localStorage.getItem(IGNORE_KEY) || '') === v; } catch (e) { return false; }
  }

  /* ==========================================================================
   * 居中更新面板（启动时检测到新版本用）
   *
   * 玩家 2026-11-02：「检查更新检测到新版本就应该先把版本更新日志显示出来给玩家看」
   *                「优化、修复、新增三类分类，按照我说的这个顺序从上到下」
   *
   * 为什么单独做面板而不是把日志塞进角落提示条：
   *   1.0.6 有 20+ 条，塞角落就是一大坨字，既挡视线又不好读；
   *   而且角落提示条的心理预期是「小通知，可以不管」，把整屏正文塞进去
   *   两头不讨好。启动时玩家还没进正文，弹居中面板是自然时机，不打断任何事。
   * ========================================================================== */
  var PANEL_ID = 'fr-update-panel';

  function injectPanelStyle() {
    if (document.getElementById('fr-update-panel-style')) return;
    var st = document.createElement('style');
    st.id = 'fr-update-panel-style';
    st.textContent = [
      '#fr-update-panel-mask{',
      '  position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.62);',
      '  display:flex;align-items:center;justify-content:center;padding:24px;',
      '  opacity:0;transition:opacity .22s ease;',
      '}',
      '#fr-update-panel-mask.fr-up-p-show{opacity:1}',
      '#fr-update-panel{',
      '  width:min(660px,100%);max-height:min(84vh,780px);display:flex;flex-direction:column;',
      '  border-radius:14px;border:1px solid rgba(255,215,0,.42);',
      '  background:linear-gradient(160deg,rgba(40,36,29,.99),rgba(22,20,17,.99));',
      '  box-shadow:0 24px 70px rgba(0,0,0,.7),0 0 0 1px rgba(255,215,0,.06) inset;',
      '  color:#f0e6d2;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;',
      '  transform:translateY(14px) scale(.985);transition:transform .24s ease;',
      '}',
      '#fr-update-panel-mask.fr-up-p-show #fr-update-panel{transform:translateY(0) scale(1)}',
      '#fr-update-panel .fr-up-p-head{',
      '  display:flex;align-items:center;gap:12px;padding:20px 24px 15px;',
      '  border-bottom:1px solid rgba(255,215,0,.16);flex:0 0 auto;',
      '}',
      '#fr-update-panel .fr-up-p-title{',
      '  flex:1 1 auto;font-size:19px;font-weight:600;color:#ffd700;letter-spacing:2px;',
      '}',
      '#fr-update-panel .fr-up-p-ver{font-size:15px;color:#ffe680;font-weight:600}',
      '#fr-update-panel .fr-up-p-x{',
      '  width:30px;height:30px;flex:0 0 auto;cursor:pointer;border-radius:7px;',
      '  border:1px solid rgba(255,215,0,.28);background:rgba(255,255,255,.02);',
      '  color:#a89c84;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;',
      '}',
      '#fr-update-panel .fr-up-p-x:hover{background:rgba(255,215,0,.14);color:#ffd700}',
      '#fr-update-panel .fr-up-p-body{',
      '  padding:18px 24px 8px;overflow-y:auto;flex:1 1 auto;min-height:0;',
      '  overscroll-behavior:contain;scrollbar-width:thin;',
      '}',
      '#fr-update-panel .fr-up-p-body::-webkit-scrollbar{width:7px}',
      '#fr-update-panel .fr-up-p-body::-webkit-scrollbar-thumb{',
      '  background:rgba(255,215,0,.3);border-radius:4px;',
      '}',
      '#fr-update-panel .fr-up-p-sec{margin-bottom:16px}',
      '#fr-update-panel .fr-up-p-sec:last-child{margin-bottom:4px}',
      '#fr-update-panel .fr-up-p-sec-t{',
      '  font-size:13px;font-weight:700;color:#ffd700;letter-spacing:3px;',
      '  display:flex;align-items:center;gap:10px;margin-bottom:8px;',
      '}',
      '#fr-update-panel .fr-up-p-sec-t::after{',
      '  content:"";flex:1 1 auto;height:1px;',
      '  background:linear-gradient(90deg,rgba(255,215,0,.3),rgba(255,215,0,0));',
      '}',
      '#fr-update-panel .fr-up-p-list{display:flex;flex-direction:column;gap:7px}',
      '#fr-update-panel .fr-up-p-line{',
      '  position:relative;padding-left:15px;font-size:13.5px;line-height:1.72;',
      '  color:#ded6c6;overflow-wrap:anywhere;',
      '}',
      '#fr-update-panel .fr-up-p-line::before{',
      '  content:"";position:absolute;left:3px;top:9px;width:5px;height:5px;',
      '  border-radius:50%;background:rgba(255,215,0,.62);',
      '}',
      '#fr-update-panel .fr-up-p-foot{',
      '  display:flex;gap:10px;justify-content:flex-end;align-items:center;',
      '  padding:15px 24px 19px;border-top:1px solid rgba(255,215,0,.14);flex:0 0 auto;',
      '}',
      '#fr-update-panel .fr-up-p-foot button{',
      '  cursor:pointer;border-radius:8px;padding:8px 18px;font-size:13.5px;',
      '  font-family:inherit;border:1px solid rgba(255,215,0,.45);',
      '  background:rgba(255,215,0,.14);color:#ffe680;',
      '}',
      '#fr-update-panel .fr-up-p-foot button:hover{background:rgba(255,215,0,.26)}',
      '#fr-update-panel .fr-up-p-foot .fr-up-p-later{',
      '  background:transparent;border-color:rgba(255,255,255,.16);color:#9c968a;',
      '}',
      '#fr-update-panel .fr-up-p-foot .fr-up-p-later:hover{background:rgba(255,255,255,.07)}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* 面板按钮要接的三件事：立即更新 / 稍后 / 关闭 */
  function showPanel(version, changelog) {
    if (document.getElementById(PANEL_ID + '-mask')) return;   // 已开着
    injectPanelStyle();
    var mask = document.createElement('div');
    mask.id = PANEL_ID + '-mask';

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '版本更新');

    // 头
    var head = document.createElement('div');
    head.className = 'fr-up-p-head';
    var title = document.createElement('div');
    title.className = 'fr-up-p-title';
    title.textContent = '版本更新';
    var ver = document.createElement('span');
    ver.className = 'fr-up-p-ver';
    ver.textContent = 'v' + String(version);
    head.appendChild(title);
    head.appendChild(ver);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'fr-up-p-x';
    x.textContent = '×';
    x.title = '关掉';
    head.appendChild(x);
    panel.appendChild(head);

    // 体：优化 → 修复 → 新增
    var body = document.createElement('div');
    body.className = 'fr-up-p-body';
    var groups = bucketItems(changelog);
    if (!groups.length) {
      var empty = document.createElement('div');
      empty.className = 'fr-up-p-line';
      empty.textContent = '这一版没有可显示的更新条目。';
      body.appendChild(empty);
    } else {
      groups.forEach(function (g) {
        var sec = document.createElement('div');
        sec.className = 'fr-up-p-sec';
        var t = document.createElement('div');
        t.className = 'fr-up-p-sec-t';
        t.textContent = g.label;
        sec.appendChild(t);
        var list = document.createElement('div');
        list.className = 'fr-up-p-list';
        g.rows.forEach(function (line) {
          var d = document.createElement('div');
          d.className = 'fr-up-p-line';
          d.textContent = line;
          list.appendChild(d);
        });
        sec.appendChild(list);
        body.appendChild(sec);
      });
    }
    panel.appendChild(body);

    // 脚
    var foot = document.createElement('div');
    foot.className = 'fr-up-p-foot';
    var later = document.createElement('button');
    later.type = 'button';
    later.className = 'fr-up-p-later';
    later.textContent = '稍后再说';
    var now = document.createElement('button');
    now.type = 'button';
    now.textContent = '立即更新';
    foot.appendChild(later);
    foot.appendChild(now);
    panel.appendChild(foot);
    mask.appendChild(panel);

    function closePanel() {
      mask.classList.remove('fr-up-p-show');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }, 240);
    }
    x.addEventListener('click', closePanel);
    later.addEventListener('click', closePanel);
    mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', esc); }
    });
    // 「立即更新」直接复用提示条那套下载逻辑：先确保提示条存在，再触发
    now.addEventListener('click', function () {
      closePanel();
      try {
        buildBar();
        bar.classList.add('fr-up-show');
        onUpdate();
      } catch (e) { /* 触发失败不影响玩家手动去版本页面更新 */ }
    });

    document.body.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add('fr-up-p-show'); });
  }

  function showBar(version, notes, changelog, opts) {
    var o = opts || {};
    if (isIgnored(o.release)) return;
    buildBar();
    barRelease = o.release;
    var versionLabel = document.createElement('b');
    versionLabel.textContent = String(version);
    textEl.replaceChildren(o.sameVersion ? '发现同版本补充更新 ' : '发现新版本 ', versionLabel);
    /* ★ 2026-11-02 玩家：「检查更新检测到新版本就应该先把版本更新日志显示出来给玩家看才对」
     *                 「更新日志把优化、修复、新增三类分类，按照我说的这个顺序从上到下」
     *
     * 设计（玩家认可：「按照你的来」）：
     *   · 启动时检测到新版 → 直接弹**居中面板**展示分类更新日志；
     *   · 游戏进行中检测到新版 → 角落只留**一行**摘要，不打断阅读；
     *     想看详细内容点「看更新内容」再展开面板。
     */
    var counts = countByKind(changelog);
    var summary = formatCounts(counts);

    if (o.startup && changelog && (changelog.items || []).length) {
      // 启动时机：先弹面板（玩家还没进正文，不会被打断）
      noteEl.textContent = summary;
      noteEl.style.display = summary ? '' : 'none';
      if (changLogEl) changLogEl.style.display = 'none';
      showPanel(version, changelog);
    } else {
      // 游戏进行中：只留一行
      noteEl.textContent = summary || (notes ? String(notes) : '');
      noteEl.style.display = (summary || notes) ? '' : 'none';
      if (changLogEl) changLogEl.style.display = 'none';
    }

    progWrap.style.display = 'none';
    if (progsWrap2) progsWrap2.style.display = 'none';
    btnUpdate.disabled = false;
    btnUpdate.textContent = '立即更新';
    btnLater.textContent = '看更新内容';
    btnLater.style.display = '';
    clearTimeout(hideTimer);
    // 记下本版日志：下载完成后要就地展开，让「更新完」和「看到日志」发生在同一刻
    lastChangelog = (changelog && (changelog.items || []).length) ? changelog : null;
    rememberShownRelease(o.release);
    // 下一帧加类，保证 transition 生效
    requestAnimationFrame(function () { bar.classList.add('fr-up-show'); });
  }

  /* 统计条目分类数量：优化 / 修复 / 新增 */
  function countByKind(changelog) {
    var out = { '优化': 0, '修复': 0, '新增': 0 };
    var items = (changelog && changelog.items) || [];
    items.forEach(function (raw) {
      var text = String(raw == null ? '' : raw).trim();
      if (!text) return;
      var m = text.match(/^【(优化|修复|新增)】/);
      out[m ? m[1] : '修复']++;   // 无前缀的历史条目按修复归
    });
    return out;
  }

  /* 「优化 3 · 修复 20」——只列有内容的分类，顺序固定 */
  function formatCounts(c) {
    var parts = [];
    ['优化', '修复', '新增'].forEach(function (k) {
      if (c[k] > 0) parts.push(k + ' ' + c[k]);
    });
    return parts.join(' · ');
  }

  /* 把条目按「优化 → 修复 → 新增」分成三桶，返回 [{label, rows}]，空桶不返回 */
  function bucketItems(changelog) {
    var buckets = { '优化': [], '修复': [], '新增': [] };
    var items = (changelog && changelog.items) || [];
    items.forEach(function (raw) {
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

  /* renderLogInBar：保留给「展开后的内联日志」使用（当前设计走居中面板，此函数备用） */
  function renderLogInBar(changelog) {
    if (!changLogEl) return;
    changLogEl.textContent = '';
    var groups = bucketItems(changelog);
    if (!groups.length) { changLogEl.style.display = 'none'; return; }
    groups.forEach(function (g) {
      var sec = document.createElement('div');
      sec.className = 'fr-up-sec';
      var title = document.createElement('div');
      title.className = 'fr-up-sec-t';
      title.textContent = g.label;
      sec.appendChild(title);
      var list = document.createElement('div');
      list.className = 'fr-up-sec-list';
      g.rows.forEach(function (t) {
        var line = document.createElement('div');
        line.className = 'fr-up-line';
        line.textContent = t;
        list.appendChild(line);
      });
      sec.appendChild(list);
      changLogEl.appendChild(sec);
    });
    changLogEl.style.display = changLogEl.children.length ? 'block' : 'none';
  }

  function hideBar() {
    if (!bar) return;
    bar.classList.remove('fr-up-show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      // 真正移除 DOM，没更新时不留任何元素
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      bar = null; textEl = null; noteEl = null; btnUpdate = null; btnLater = null;
      progWrap = null; progBar = null;
      progsWrap2 = null; statPct = null; statSize = null; statSpeed = null; statEta = null;
    }, 400);
  }

  function setProgress(pct) {
    if (!progWrap) return;
    progWrap.style.display = 'block';
    progBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  /* 用主进程推来的真实数据刷新进度条与统计行。
   * data: { progress, received, total, speed, eta, done } */
  function applyProgress(data) {
    if (!data) return;
    var pct = Math.max(0, Math.min(100, Math.round(Number(data.progress) || 0)));
    setProgress(pct);
    if (!progsWrap2) return;
    progsWrap2.style.display = 'flex';
    if (statPct) statPct.textContent = pct + '%';
    var total = Number(data.total) || 0;
    var received = Number(data.received) || 0;
    if (statSize) {
      // 不知道总大小时只显示已下载，别编一个假的总量出来
      statSize.textContent = total > 0
        ? fmtBytes(received) + ' / ' + fmtBytes(total)
        : '已下载 ' + fmtBytes(received);
    }
    if (statSpeed) {
      var sp = Number(data.speed) || 0;
      statSpeed.textContent = sp > 0 ? fmtBytes(sp) + '/s' : '';
    }
    if (statEta) {
      // 没有总量或速度还没稳定时，说「计算中」，别显示 0 秒骗人
      statEta.textContent = (total > 0 && Number(data.eta) >= 0) ? fmtEta(data.eta) : '';
    }
  }

  function resetProgressUi() {
    if (progsWrap2) progsWrap2.style.display = 'none';
    if (statPct) statPct.textContent = '';
    if (statSize) statSize.textContent = '';
    if (statSpeed) statSpeed.textContent = '';
    if (statEta) statEta.textContent = '';
    setProgress(0);
  }

  function onUpdate() {
    if (busy) return;
    busy = true;
    btnUpdate.disabled = true;
    btnLater.style.display = 'none';
    textEl.textContent = '正在下载更新…';
    noteEl.style.display = 'none';
    setProgress(1);
    if (progsWrap2) { progsWrap2.style.display = 'flex'; }
    if (statPct) statPct.textContent = '0%';

    /* 2026-11-01 玩家：「能让玩家直观看到更新下载进度而已，不然没反馈都不知道
     * 在不在下载和更新。」
     *
     * 原来这里是 setInterval 每 400ms 问一次 info()，而主进程 progress 只有
     * 0 和 100 两个值 —— 进度条基本一直停在 3%，等于没有反馈，还白白起了个轮询。
     *
     * 现在改成订阅主进程推来的真实字节进度，零轮询。 */
    var offProgress = null;
    try {
      if (typeof window.frUpdate.onProgress === 'function') {
        offProgress = window.frUpdate.onProgress(function (d) { applyProgress(d); });
      }
    } catch (e) { /* 订阅失败就退回下面的一次性 info() 兜底 */ }

    function stopWatching() {
      if (typeof offProgress === 'function') {
        try { offProgress(); } catch (e) {}
        offProgress = null;
      }
    }

    window.frUpdate.apply().then(function (r) {
      stopWatching();
      busy = false;
      if (r && r.ok) {
        setProgress(100);
        if (statPct) statPct.textContent = '100%';
        if (statSpeed) statSpeed.textContent = '';
        if (statEta) statEta.textContent = '';
        textEl.textContent = '更新完成，重启后生效';
        noteEl.textContent = '存档不受影响';
        noteEl.style.display = 'block';
        /* ★ 2026-11-02 玩家：「更新完后这里就要显示最新版本的更新日志了」
         *
         * 原来下载完只说一句「重启后生效」，玩家在重启前根本不知道这版改了什么。
         * 现在下载完成就地把本版日志展开在提示条里（按 优化/修复/新增 分组），
         * 让玩家「更新完」和「看到日志」是同一个时刻，不必等重启。
         * 同时把版本号也记下来 —— 重启后面板会默认停在这一版。
         */
        try {
          if (lastChangelog && (lastChangelog.items || []).length) {
            renderLogInBar(lastChangelog);
          }
        } catch (e) { /* 渲染失败不影响「更新成功」这个结果 */ }
        // 已经成功，不再自动收起，留给玩家看完日志自己关
        btnLater.textContent = '知道了';
        btnLater.style.display = '';
      } else {
        textEl.textContent = '更新失败';
        noteEl.textContent = String((r && r.reason) || '未知错误');
        noteEl.style.display = 'block';
        resetProgressUi();
        btnUpdate.disabled = false;
        btnUpdate.textContent = '重试';
        btnLater.style.display = '';
      }
    }).catch(function (e) {
      stopWatching();
      busy = false;
      textEl.textContent = '更新失败';
      noteEl.textContent = String((e && e.message) || e);
      noteEl.style.display = 'block';
      resetProgressUi();
      btnUpdate.disabled = false;
      btnUpdate.textContent = '重试';
      btnLater.style.display = '';
    });
  }

  // 主进程后台检查到新版 → 推事件过来
  try {
    window.frUpdate.onAvailable(function (data) {
      if (!data || !data.version) return;
      if (busy) return;
      var release = updateReleaseKey(data.version, data.sha256);
      if (alreadyShownRelease(release)) return;
      /* data.startup === true 表示「启动时那一次检查」，弹居中面板展示完整日志；
       * 否则是游戏进行中的 30 分钟巡检，只弹一行摘要，不打断玩家。 */
      showBar(data.version, data.notes, data.changelog, {
        startup: data.startup === true,
        release: release,
        sameVersion: data.reason === 'same-version-new-content' || data.reason === 'local-sha-unknown'
      });
    });
  } catch (e) { /* 订阅失败不影响游戏 */ }
})();
