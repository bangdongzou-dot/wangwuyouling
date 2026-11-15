/* ============================================================================
 * 凡人卡独立前端 · 玩家性格 + 玩家姓名（player-persona.js）
 *
 * 玩家 2026-10-30 补：「原卡是直接读取酒馆的玩家姓名+性格的」——两样都缺。
 *   ① 姓名：原卡走 window.parent.SillyTavern.getContext().name1，独立版没有酒馆，
 *      所有地方都退化成「你」。这里让玩家在向导里填，并由 frResolveUserName 读。
 *   ② 性格：B1 行的列3 永远空（创建流程没有输入，模型又被禁止写 B1 内心），
 *      酒馆里靠 Persona 补，独立版这里补。
 *
 * 两个输入框都在开局向导「性别与种族」页（姓名在最上面，性格紧随其后）。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return; // 酒馆模式下不装

  var KEY = 'FR_PLAYER_PERSONA_V1';
  var NAME_KEY = 'FR_PLAYER_NAME_V1';

  // ---- 玩家姓名 -----------------------------------------------------------
  // frResolveUserName 会优先读这里，替代酒馆的 name1。
  function nameRead() {
    try {
      var v = localStorage.getItem(NAME_KEY);
      return v ? String(v) : '';
    } catch (e) { return ''; }
  }
  function nameSave(v) {
    try {
      var s = String(v == null ? '' : v).trim();
      if (s) localStorage.setItem(NAME_KEY, s);
      else localStorage.removeItem(NAME_KEY);
      return s;
    } catch (e) { return ''; }
  }

  window.frPlayerNameGet = nameRead;
  window.frPlayerNameSave = nameSave;

  // ---- 玩家性格 -----------------------------------------------------------

  // 提示词模板：{persona} 是玩家写的内容
  var TEMPLATE =
    '[性格校验·最高优先级] 主角性格设定：\n{persona}\n' +
    '以上是主角本人的性格，必须严格照此演绎。' +
    '严禁在正文中直接使用上面这些词去形容主角，' +
    '必须通过具体对话、动作、选择来体现，让读者自己感受到。';

  var cache = null;

  function readRaw() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }

  function writeRaw(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); return true; }
    catch (e) { console.warn('[玩家性格] 保存失败：' + (e && e.message ? e.message : e)); return false; }
  }

  function normalize(data) {
    var out = { enabled: false, text: '', updatedAt: 0 };
    if (!data || typeof data !== 'object') return out;
    out.enabled = data.enabled === true;
    out.text = typeof data.text === 'string' ? data.text : '';
    out.updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
    return out;
  }

  // ---- 对外接口 -----------------------------------------------------------
  window.frPlayerPersonaGet = function () {
    if (!cache) cache = normalize(readRaw());
    return cache;
  };

  window.frPlayerPersonaSave = function (patch) {
    var next = normalize(Object.assign({}, window.frPlayerPersonaGet(), patch || {}));
    next.updatedAt = Date.now();
    cache = next;
    writeRaw(next);
    return next;
  };

  window.frPlayerPersonaReady = function () {
    var p = window.frPlayerPersonaGet();
    return p.enabled && !!String(p.text || '').trim();
  };

  /**
   * 组装成可注入 prompt 的文本。桥接层在 B1 列3 为空时调它。
   * 没开 / 没填 → 返回空串，调用方就不插入任何东西。
   */
  window.frPlayerPersonaToPrompt = function () {
    var p = window.frPlayerPersonaGet();
    if (!p.enabled) return '';
    var text = String(p.text || '').trim();
    if (!text) return '';
    return TEMPLATE.replace('{persona}', text);
  };

  // ---- 界面（一个文本框） -------------------------------------------------
  var CSS = `
  #fr-persona{position:fixed;inset:0;z-index:999998;display:flex;align-items:center;justify-content:center;
    background:#0b0a09e0;backdrop-filter:blur(3px);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif}
  #fr-persona .box{width:min(600px,94vw);max-height:90vh;display:flex;flex-direction:column;
    background:#1c1b18;border:1px solid #6b5c3e;border-radius:14px;color:#f0e6d2;box-shadow:0 30px 90px #000c}
  #fr-persona .hd{padding:16px 22px 12px;border-bottom:1px solid #3a3428;flex:none}
  #fr-persona .hd h2{margin:0 0 3px;font-size:18px;color:#ffd700;font-weight:600}
  #fr-persona .hd p{margin:0;font-size:12px;color:#a99f8b;line-height:1.65}
  #fr-persona .bd{padding:14px 22px 6px;overflow:auto;flex:1}
  #fr-persona .sw{display:flex;align-items:center;gap:9px;padding:9px 11px;background:#14130f;
    border:1px solid #5a4e3c;border-radius:8px;margin:0 0 12px;cursor:pointer;font-size:13px;color:#d9c9a3}
  #fr-persona .sw input{width:15px;height:15px;accent-color:#d6ac58;margin:0;cursor:pointer}
  #fr-persona textarea{box-sizing:border-box;width:100%;padding:10px 12px;border-radius:8px;border:1px solid #5a4e3c;
    background:#14130f;color:#f0e6d2;font-size:13px;font-family:inherit;line-height:1.75;resize:vertical;outline:none}
  #fr-persona textarea:focus{border-color:#c9a558;box-shadow:0 0 0 2px #c9a55833}
  #fr-persona .hint{margin:6px 0 0;font-size:11.5px;color:#8a8070;line-height:1.65}
  #fr-persona .ft{padding:12px 22px 16px;border-top:1px solid #3a3428;display:flex;gap:9px;align-items:center;flex:none}
  #fr-persona .ft button{padding:8px 18px;border-radius:7px;border:1px solid #8c7853;background:#26231c;
    color:#f0e6d2;font-size:13px;cursor:pointer;font-family:inherit;transition:.15s}
  #fr-persona .ft button:hover{background:#3b301d;border-color:#d0a54f}
  #fr-persona .ft button.primary{background:#d6ac58;color:#211909;border-color:#e5c078;font-weight:600}
  #fr-persona .ft button.primary:hover{background:#e8bf6c}
  #fr-persona .ft .msg{flex:1;font-size:11.5px;color:#9fd08a;min-height:16px}
  #fr-persona .ft .msg.err{color:#e08a7a}
  `;

  window.frPlayerPersonaOpen = function (opts) {
    opts = opts || {};
    if (!document.getElementById('fr-persona-style')) {
      var st = document.createElement('style');
      st.id = 'fr-persona-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var old = document.getElementById('fr-persona');
    if (old) old.remove();

    var cfg = window.frPlayerPersonaGet();

    var wrap = document.createElement('div');
    wrap.id = 'fr-persona';
    wrap.innerHTML =
      '<div class="box">' +
      '<div class="hd"><h2>玩家性格</h2>' +
      '<p>写清楚「你」是个什么样的人，每轮会带进提示词。</p></div>' +
      '<div class="bd">' +
      '<label class="sw"><input type="checkbox" id="fp-on">启用性格注入</label>' +
      '<textarea id="fp-text" rows="8" placeholder="例：谨慎、隐忍，不轻易表态；遇事先想退路，但认定的事九头牛拉不回。话少，短句，不喜解释。重情义，但不为情义送命；不主动害人，被算计必还。怕水，对丹药有本能的不信任。"></textarea>' +
      '<p class="hint">随便写，写得越具体，模型演得越像你。不用分条列项，一段话就行。</p>' +
      '</div>' +
      '<div class="ft"><button type="button" class="primary" id="fp-save">保存</button>' +
      '<button type="button" id="fp-cancel">取消</button>' +
      '<div class="msg" id="fp-msg"></div></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var $ = function (id) { return wrap.querySelector('#' + id); };
    var msgEl = $('fp-msg');
    function setMsg(t, err) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (err ? ' err' : ''); }

    $('fp-on').checked = cfg.enabled === true;
    $('fp-text').value = String(cfg.text || '');

    $('fp-save').addEventListener('click', function () {
      var text = String($('fp-text').value || '').trim();
      var enabled = $('fp-on').checked;
      if (enabled && !text) {
        setMsg('开了注入但没写内容，等于没设。', true);
      } else {
        setMsg('已保存，下一轮生效');
      }
      window.frPlayerPersonaSave({ enabled: enabled, text: text });
      setTimeout(function () {
        wrap.remove();
        if (opts.onDone) opts.onDone(window.frPlayerPersonaGet());
      }, 450);
    });

    $('fp-cancel').addEventListener('click', function () {
      wrap.remove();
      if (opts.onCancel) opts.onCancel();
    });

    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { wrap.remove(); if (opts.onCancel) opts.onCancel(); }
    });

    setTimeout(function () { $('fp-text').focus(); }, 60);
  };

  console.log('[玩家性格] 就绪');
})();
