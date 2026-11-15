/* ============================================================================
 * 凡人卡独立前端 · 启动引导（boot.js）
 *
 * 职责：
 *   1. 首屏配置界面（接口地址 / Key / 模型 / 玩家名）
 *   2. 配置完成后启动卡片主程序
 *   3. 提供设置入口，随时改配置
 *
 * 关键：必须在主 bundle 之前注入 st-shim.js，否则卡片一启动就会因为
 *      找不到 TavernHelper.generate 而报错。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return; // 酒馆模式下不装

  var CFG = window.FRStandaloneConfig;
  if (!CFG) { console.error('[启动] FRStandaloneConfig 缺失，垫片未加载'); return; }

  // ---- 样式 ---------------------------------------------------------------
  var CSS = `
  #fr-boot{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 50% 0%,#241f18 0%,#121110 60%,#0b0a09 100%);
    font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#f0e6d2}
  #fr-boot .card{width:min(620px,94vw);max-height:92vh;overflow:auto;background:#1c1b18;border:1px solid #6b5c3e;
    border-radius:14px;padding:28px 30px;box-shadow:0 30px 90px #000b}
  #fr-boot h1{margin:0 0 6px;font-size:22px;color:#ffd700;font-weight:600;letter-spacing:1px}
  #fr-boot .sub{margin:0 0 22px;font-size:13px;color:#a99f8b;line-height:1.7}
  #fr-boot label{display:block;margin:16px 0 6px;font-size:13px;color:#d9c9a3}
  #fr-boot input,#fr-boot select{box-sizing:border-box;width:100%;padding:11px 13px;border-radius:8px;
    border:1px solid #5a4e3c;background:#14130f;color:#f0e6d2;font-size:14px;font-family:inherit;outline:none}
  #fr-boot input:focus,#fr-boot select:focus{border-color:#c9a558;box-shadow:0 0 0 2px #c9a55833}
  #fr-boot .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  #fr-boot .hint{margin-top:5px;font-size:12px;color:#8a8070;line-height:1.6}
  #fr-boot .actions{display:flex;gap:12px;align-items:center;margin-top:26px}
  #fr-boot button{padding:12px 22px;border-radius:8px;border:1px solid #8c7853;background:#26231c;
    color:#f0e6d2;font-size:14px;cursor:pointer;font-family:inherit;transition:.15s}
  #fr-boot button:hover{background:#3b301d;border-color:#d0a54f}
  #fr-boot button.primary{background:#d6ac58;color:#211909;border-color:#e5c078;font-weight:600}
  #fr-boot button.primary:hover{background:#e8bf6c}
  #fr-boot button:disabled{opacity:.5;cursor:default}
  #fr-boot .status{flex:1;font-size:13px;color:#a99f8b;line-height:1.6;min-height:20px}
  #fr-boot .status.ok{color:#9fd08a}
  #fr-boot .status.err{color:#e08a7a}
  #fr-boot .adv{margin-top:18px;border-top:1px solid #3a3428;padding-top:14px}
  #fr-boot .adv summary{cursor:pointer;font-size:13px;color:#a99f8b;outline:none}
  #fr-boot .adv summary:hover{color:#d9c9a3}
  #fr-settings-btn{position:fixed;right:14px;bottom:14px;z-index:99990;width:42px;height:42px;border-radius:50%;
    border:1px solid #6b5c3e;background:#1c1b18cc;color:#d9c9a3;font-size:19px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);transition:.15s}
  #fr-settings-btn:hover{background:#3b301d;color:#ffd700;border-color:#d0a54f}
  @media(max-width:560px){#fr-boot .row{grid-template-columns:1fr}}
  `;

  function injectStyle() {
    if (document.getElementById('fr-boot-style')) return;
    var s = document.createElement('style');
    s.id = 'fr-boot-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- 配置界面 -----------------------------------------------------------
  function openBoot(opts) {
    opts = opts || {};
    injectStyle();
    var old = document.getElementById('fr-boot');
    if (old) old.remove();

    var cfg = CFG.load();
    var wrap = document.createElement('div');
    wrap.id = 'fr-boot';
    wrap.innerHTML = [
      '<div class="card">',
      '<h1>凡人修仙传 · 原著补演</h1>',
      '<p class="sub">独立前端版 · 不经过酒馆，性能不受宿主限制。<br>首次使用请填写模型接口，配置只保存在本机。</p>',

      '<label for="fr-api-url">接口地址</label>',
      '<input id="fr-api-url" type="text" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions">',
      '<div class="hint">支持 OpenAI 兼容接口。填 base 地址（如 <code>https://api.x.com/v1</code>）会自动补全路径。</div>',

      '<label for="fr-api-key">API Key</label>',
      '<input id="fr-api-key" type="password" spellcheck="false" placeholder="sk-...">',
      '<div class="hint">只存在本机 localStorage，不会上传。</div>',

      '<div class="row">',
      '<div><label for="fr-model">模型</label><input id="fr-model" type="text" spellcheck="false" placeholder="点下方「获取可用模型」后选择"></div>',
      '<div><label for="fr-player">玩家名</label><input id="fr-player" type="text" placeholder="玩家"></div>',
      '</div>',

      '<details class="adv"><summary>高级设置（可选）</summary>',
      '<div class="row">',
      '<div><label for="fr-temp">温度</label><input id="fr-temp" type="number" step="0.05" min="0" max="2"></div>',
      '</div>',
      '<label for="fr-stream">流式输出</label>',
      '<select id="fr-stream"><option value="1">开启（推荐，逐字显示）</option><option value="0">关闭</option></select>',
      '<div class="hint">若接口不支持流式或出现乱码，可关闭。</div>',
      '</details>',

      '<div class="actions">',
      '<button id="fr-test" type="button">测试连接</button>',
      '<button id="fr-start" type="button" class="primary">' + (opts.firstRun ? '开始游戏' : '保存并关闭') + '</button>',
      '<div class="status" id="fr-status"></div>',
      '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(wrap);

    var $ = function (id) { return wrap.querySelector('#' + id); };
    var elUrl = $('fr-api-url'), elKey = $('fr-api-key'), elModel = $('fr-model'),
        elPlayer = $('fr-player'), elTemp = $('fr-temp'),
        elStream = $('fr-stream'), elStatus = $('fr-status'),
        btnTest = $('fr-test'), btnStart = $('fr-start');

    elUrl.value = cfg.apiUrl || '';
    elKey.value = cfg.apiKey || '';
    elModel.value = cfg.model || '';
    elPlayer.value = cfg.playerName || '玩家';
    elTemp.value = cfg.temperature != null ? cfg.temperature : 0.85;
    elStream.value = cfg.stream === false ? '0' : '1';

    function setStatus(text, kind) {
      elStatus.textContent = text || '';
      elStatus.className = 'status' + (kind ? ' ' + kind : '');
    }

    function collect() {
      return {
        apiUrl: elUrl.value.trim(),
        apiKey: elKey.value.trim(),
        model: elModel.value.trim(),
        playerName: elPlayer.value.trim() || '玩家',
        temperature: Number(elTemp.value) || 0.85,
        stream: elStream.value === '1'
      };
    }

    btnTest.addEventListener('click', async function () {
      var patch = collect();
      if (!patch.apiUrl) return setStatus('请先填写接口地址', 'err');
      if (!patch.model) return setStatus('请先填写模型名', 'err');
      CFG.save(patch);
      btnTest.disabled = true;
      setStatus('正在连接模型…');
      try {
        var text = await window.TavernHelper.generate('请只回复两个字：可用', {
          maxTokens: 16, temperature: 0, stream: false, systemPrompt: '你是一个测试助手。'
        });
        var got = String(text || '').trim();
        setStatus('连接成功，模型返回：' + (got ? got.slice(0, 40) : '（空响应）'), 'ok');
      } catch (e) {
        setStatus('连接失败：' + (e && e.message ? e.message : e), 'err');
      } finally {
        btnTest.disabled = false;
      }
    });

    btnStart.addEventListener('click', function () {
      var patch = collect();
      if (!patch.apiUrl) return setStatus('请先填写接口地址', 'err');
      if (!patch.model) return setStatus('请先填写模型名', 'err');
      CFG.save(patch);
      wrap.remove();
      if (opts.onDone) opts.onDone(CFG.load());
    });

    // 首次启动不允许直接关掉
    if (!opts.firstRun) {
      wrap.addEventListener('keydown', function (e) { if (e.key === 'Escape') { wrap.remove(); } });
    }
    setTimeout(function () { (elUrl.value ? elModel : elUrl).focus(); }, 60);
  }

  // ---- 右下角设置入口（已停用） -------------------------------------------
  // 游戏自己首屏右下角就有 ⚙（缓存管理），系统控制台里也有设置。
  // 再挂一个悬浮按钮会多出重复入口、还挡住游戏 UI，所以这里不挂。
  function ensureSettingsButton() {
    /* 故意不挂悬浮按钮：设置统一走游戏内「系统控制台 → 正文与正则设置」。 */
  }

  // ---- 设置菜单（接口配置 / 玩家设定） ------------------------------------
  var MENU_CSS = `
  #fr-menu{position:fixed;inset:0;z-index:999997;background:#0006;display:flex;align-items:flex-end;justify-content:flex-end}
  #fr-menu .sheet{width:min(360px,92vw);margin:0 14px 70px 0;background:#1c1b18;border:1px solid #6b5c3e;
    border-radius:12px;padding:12px;box-shadow:0 20px 60px #000c;
    font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#f0e6d2}
  #fr-menu button{display:block;width:100%;text-align:left;padding:11px 13px;margin:3px 0;border-radius:8px;
    border:1px solid transparent;background:transparent;color:#e8dcc4;font-size:13.5px;cursor:pointer;
    font-family:inherit;transition:.13s}
  #fr-menu button:hover{background:#3b301d;border-color:#6b5c3e;color:#ffda85}
  #fr-menu .sep{height:1px;background:#3a3428;margin:8px 4px}
  #fr-menu .tip{font-size:11.5px;color:#8a8070;padding:4px 13px 6px;line-height:1.6}
  `;

  function openMenu() {
    if (document.getElementById('fr-menu')) return;
    if (!document.getElementById('fr-menu-style')) {
      var s = document.createElement('style');
      s.id = 'fr-menu-style';
      s.textContent = MENU_CSS;
      document.head.appendChild(s);
    }
    var wrap = document.createElement('div');
    wrap.id = 'fr-menu';
    var personaReady = typeof window.frPlayerPersonaReady === 'function' && window.frPlayerPersonaReady();
    wrap.innerHTML = [
      '<div class="sheet">',
      '<button type="button" data-act="api">接口与模型设置</button>',
      '<button type="button" data-act="persona">玩家设定' +
        (personaReady ? '' : '<span style="color:#e0a06a"> · 未填性格</span>') + '</button>',
      '<div class="sep"></div>',
      '<div class="tip">玩家设定决定模型眼里「你」是什么人，建议先填。</div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) { if (e.target === wrap) wrap.remove(); return; }
      wrap.remove();
      if (act === 'api') openApiLibrary();
      else if (act === 'persona' && typeof window.frPlayerPersonaOpen === 'function') {
        window.frPlayerPersonaOpen({});
      }
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', onEsc); }
    });
  }

  // ---- 启动流程 -----------------------------------------------------------
  // 原则：首屏原样显示，点「开始新人生」就进游戏，**不弹任何配置界面**。
  // 接口/模型/预设/正则全部在游戏内的「系统控制台 → 正文与正则设置」里填。
  //
  // 之前那版会在点「开始新人生」时拦一道、弹配置窗再弹性格窗，玩家反馈
  // 「不是说了进入游戏后再设置吗」——所以拦截整个拆掉。
  // 没配接口时的兜底：游戏内一生成就会报错，而设置页就在系统控制台里，
  // 玩家自己点开就能填。这比开局怼一个弹窗体验好。

  // 兼容外部调用：仍有地方可能调它，保留空实现，不弹窗。
  function guardStartNewLife() {
    /* 故意不做任何拦截：点「开始新人生」直接进游戏。 */
  }

  function openApiLibrary() {
    document.getElementById('open-unified-api-settings-btn')?.click();
  }

  window.FRStandaloneBoot = {
    openSettings: openApiLibrary
  };

  function boot() {
    ensureSettingsButton();
    guardStartNewLife();
    // 首次进入系统控制台的设置页时，把面板绑好
    if (typeof window.frProseApiBind === 'function') {
      setTimeout(function () { try { window.frProseApiBind(); } catch (e) {} }, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
