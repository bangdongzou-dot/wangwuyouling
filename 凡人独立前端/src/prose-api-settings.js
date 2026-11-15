/* ============================================================================
 * 凡人卡独立前端 · 正文 API / 正文预设（prose-api-settings.js）
 *
 * 玩家 2026-10-30：「说了对标其他的设置和导入啊，照抄都不会吗？」
 * 所以这里完全照抄卡内「变量思考 API 设置」那一套：
 *   · 启用开关 + 可折叠「API 详细配置」+ 获取可用模型
 *   · 预设管理：列表（加载/更新/删除） + 创建/导入/导出/恢复至空白
 * 不再是我自己拍的平铺表单。
 *
 * 存储：
 *   接口配置 → FR_STANDALONE_CONFIG_V1（垫片同一份，不会「填了没生效」）
 *   预设列表 → FR_PROSE_PRESETS_V1（结构与卡内 thinking presets 一致）
 *              { presets: [{id,name,text}], activePresetId }
 *   选中的预设正文由垫片读：activePreset.text 优先，空则用内置预设。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;

  var PRESETS_KEY = 'FR_PROSE_PRESETS_V1';
  var MODELS_CACHE_KEY = 'FR_MODEL_LIST_V1';

  // ---- 预设存储（照抄卡内 {presets, activePresetId} 结构） ----------------
  function presetsLoad() {
    try {
      var raw = localStorage.getItem(PRESETS_KEY);
      var v = raw ? JSON.parse(raw) : null;
      if (!v || !Array.isArray(v.presets)) {
        return { presets: [], activePresetId: null };
      }
      return { presets: v.presets.filter(function (p) { return p && p.name; }), activePresetId: v.activePresetId || null };
    } catch (e) {
      return { presets: [], activePresetId: null };
    }
  }

  function presetsSave(data) {
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('[正文预设] 保存失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  function activePreset() {
    var d = presetsLoad();
    return d.presets.find(function (p) { return p.id === d.activePresetId; }) || null;
  }

  /** 垫片用：启用且有正文 → 用玩家的；否则返回空串，垫片退回内置预设 */
  window.frProsePresetText = function () {
    var CFG = window.FRStandaloneConfig;
    if (CFG) {
      var c = CFG.load();
      if (c.prosePresetEnabled === false) return '';
    }
    // 2026-10-31 起正文预设是「分条目 + 每条开关」，
    // 真正拼文本的逻辑在 preset-adapters.js 里（按 order 拼接启用条目）。
    if (typeof window.frProsePresetText2 === 'function') {
      return String(window.frProsePresetText2() || '').trim();
    }
    var p = activePreset();
    return p && typeof p.text === 'string' ? p.text.trim() : '';
  };
  window.frProsePresetsLoad = presetsLoad;
  window.frProsePresetsSave = presetsSave;
  window.frProseActivePreset = activePreset;

  // ---- 模型列表（照抄卡内 normalize / extract / render） ------------------
  function normalizeModelsUrl(apiUrl) {
    var u = String(apiUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/models$/i.test(u)) return u;
    if (/\/chat\/completions$/i.test(u)) u = u.replace(/\/chat\/completions$/i, '');
    if (!/\/v1$/i.test(u)) u += '/v1';
    return u + '/models';
  }

  function extractModels(data) {
    var arr = [];
    if (data && Array.isArray(data.models)) arr = data.models;
    else if (data && Array.isArray(data.data)) arr = data.data;
    else if (Array.isArray(data)) arr = data;
    var out = [];
    arr.forEach(function (m) {
      var s = m ? (typeof m === 'string' ? m : (m.id || m.name || '')) : '';
      s = String(s || '').trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    out.sort();
    return out;
  }

  async function fetchModels(apiUrl, apiKey) {
    var url = normalizeModelsUrl(apiUrl);
    if (!url) throw new Error('请先填写接口地址');
    var headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    var resp = await fetch(url, { method: 'GET', headers: headers });
    if (!resp.ok) {
      var detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
      throw new Error('HTTP ' + resp.status + (detail ? '：' + detail : ''));
    }
    var text = await resp.text();
    var models = extractModels(text ? JSON.parse(text) : []);
    if (!models.length) throw new Error('接口返回成功，但没解析出模型列表');
    return models;
  }

  function modelsCacheLoad() {
    try {
      var v = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || 'null');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function modelsCacheSave(list) {
    try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function renderModelOptions(select, models, selected) {
    if (!select) return;
    select.innerHTML = '';
    var list = models && models.length ? models.slice() : [];
    if (selected && list.indexOf(selected) < 0) list.push(selected);
    if (!list.length) {
      select.add(new Option('请先获取可用模型', '', true, true));
      return;
    }
    list.forEach(function (m) { select.add(new Option(m, m)); });
    if (selected) select.value = selected;
  }

  // ---- 面板 ---------------------------------------------------------------
  var NUM_FIELDS = [
    ['prose-api-temperature', 'temperature'],
    ['prose-api-topp', 'top_p'],
    ['prose-api-topk', 'top_k'],
    ['prose-api-minp', 'min_p'],
    ['prose-api-freq', 'frequency_penalty'],
    ['prose-api-pres', 'presence_penalty'],
    ['prose-api-repp', 'repetition_penalty'],
    ['prose-api-seed', 'seed'],
    ['prose-api-maxtokens', 'maxTokens']
  ];

  var uiWired = false;
  var apiWired = false;

  function status(text, ok) {
    var el = document.getElementById('prose-api-status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#9fd08a' : '#e08a7a';
  }

  // 导入来源的中文说明，让玩家一眼看出「这次是当成什么格式进来的」
  function formatImportKind(kind) {
    var map = {
      'st-object': '酒馆预设对象，已按 prompt_order 装配',
      'presets-pack': '预设整包',
      'array': '预设数组',
      'object': '单个预设对象',
      'text': '纯文本提示词'
    };
    return map[String(kind || '')] || String(kind || '未知格式');
  }

  // 把上游报错翻译成「下一步该点什么」，而不是把 JSON 原样怼给玩家。
  // 依据凡人卡 genericApiCall 的错误处理口径（它会取 errorJson.error.message，
  // 并区分 AbortError / finish_reason / 空响应）。
  // 模型名只能有一个真源（FR_STANDALONE_CONFIG_V1.model）。
  // 启动引导面板里的 #fr-model 是另一处输入框，必须同步，否则两处会各说各话
  // —— 2026-10-31 上游日志里发出去的 gpt-4o-mini 就是这么来的。
  function syncModelToBoot() {
    var CFG = window.FRStandaloneConfig;
    if (!CFG) return;
    var m = String(CFG.load().model || '').trim();
    var boot = document.getElementById('fr-model');
    if (boot && boot.value.trim() !== m) boot.value = m;
  }

  function explainApiError(e, cfg) {
    var msg = String((e && e.message) || e || '');
    var model = String((cfg && cfg.model) || '').trim();
    var low = msg.toLowerCase();

    // 中转站最常见的三种：模型未启用 / 模型不存在 / key 无效
    if (/model_not_found|model not found|未由站点启用|模型未启用|no available channel/i.test(low) ||
        /invalid_request_error/i.test(low) && /model/i.test(low)) {
      return '连接失败：该站点没有启用模型「' + (model || '（空）') + '」。' +
        '请点上方「获取可用模型」重新拉列表，从下拉里选一个站点确实提供的模型，再保存重测。' +
        '（原始信息：' + msg.slice(0, 120) + '）';
    }
    if (/401|invalid_api_key|incorrect api key|unauthorized/i.test(low)) {
      return '连接失败：API Key 无效或过期。请核对 Key（注意是否多了空格、是否被截断）。';
    }
    if (/403|forbidden|permission/i.test(low)) {
      return '连接失败：Key 没有调用该模型的权限，或该分组被禁用。';
    }
    if (/404|not found/i.test(low)) {
      return '连接失败：接口地址不对（404）。多数兼容站应填到 /v1 为止，例如 https://api.x.com/v1，' +
        '不要自己拼 /chat/completions。';
    }
    if (/abort|timeout|timed out/i.test(low)) {
      return '连接超时：网络到不了该站点，或站点响应过慢。可先调大「超时」或换线路。';
    }
    if (/insufficient|quota|余额|额度/i.test(low)) {
      return '连接失败：账户额度不足。';
    }
    if (/429|rate limit|too many/i.test(low)) {
      return '连接失败：请求过于频繁（429），稍等再试。';
    }
    return '连接失败：' + msg;
  }

  function pStatus(text, ok) {
    var el = document.getElementById('prose-preset-status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#9fd08a' : '#e08a7a';
  }

  // 读面板 → 正文 API 配置。流式开关由游戏设置保存。
  function persistApi() {
    var CFG = window.FRStandaloneConfig;
    if (!CFG) return;
    var patch = {
      apiUrl: String((document.getElementById('prose-api-url') || {}).value || '').trim(),
      apiKey: String((document.getElementById('prose-api-key') || {}).value || '').trim(),
      model: String((document.getElementById('prose-api-model') || {}).value || '').trim(),
      apiEnabled: true
    };
    var re = document.getElementById('prose-api-reasoning');
    if (re) patch.reasoningEffort = re.value;
    NUM_FIELDS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      var raw = String(el.value || '').trim();
      if (!raw) return;                 // 留空不覆盖默认
      var n = Number(raw);
      if (isFinite(n)) patch[pair[1]] = n;
    });
    CFG.save(patch);
  }

  // 配置 → 面板
  function loadApiToPanel() {
    var CFG = window.FRStandaloneConfig;
    if (!CFG) return;
    var c = CFG.load();
    var set = function (id, v) { var el = document.getElementById(id); if (el && v != null) el.value = String(v); };

    set('prose-api-url', c.apiUrl || '');
    set('prose-api-key', c.apiKey || '');
    NUM_FIELDS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      var v = c[pair[1]];
      el.value = (v == null || v === '') ? '' : String(v);
      el.placeholder = (v == null) ? '' : String(v);
    });
    var re = document.getElementById('prose-api-reasoning');
    if (re) re.value = (c.reasoningEffort == null ? 'auto' : String(c.reasoningEffort));

    var sel = document.getElementById('prose-api-model');
    var cur = String(c.model || '').trim();
    if (sel && sel.tagName === 'SELECT') {
      var cached = modelsCacheLoad();
      if (cached.length) renderModelOptions(sel, cached, cur);
      else renderModelOptions(sel, [], cur);
    }
    if (typeof window.__frRefreshApiEmbeds === 'function') window.__frRefreshApiEmbeds();
  }

  // 预设列表渲染（照抄卡内 rule-name / rule-actions 结构）
  function renderPresetList() {
    var listEl = document.getElementById('prose-presets-list');
    if (!listEl) return;
    var d = presetsLoad();
    listEl.innerHTML = '';
    if (!d.presets.length) {
      listEl.innerHTML = '<p style="text-align:center; opacity:0.7; margin:8px 0;">暂无预设（不启用则走内置预设）</p>';
      return;
    }
    d.presets.forEach(function (preset) {
      var isActive = preset.id === d.activePresetId;
      var item = document.createElement('div');
      item.className = 'regex-rule-item';
      item.innerHTML =
        '<span class="rule-name" style="flex-grow:1; font-weight:' + (isActive ? 'bold' : 'normal') +
        '; color:' + (isActive ? '#ffd700' : 'inherit') + ';">' +
        (isActive ? '<i class="fas fa-check-circle" style="margin-right:8px;"> </i>' : '') +
        preset.name + '</span>' +
        '<div class="rule-actions">' +
        '<button class="load-prose-preset-btn" data-id="' + preset.id + '" title="加载此预设"><i class="fas fa-check"></i></button>' +
        '<button class="update-prose-preset-btn" data-id="' + preset.id + '" title="更新此预设"><i class="fas fa-sync-alt"></i></button>' +
        '<button class="delete-prose-preset-btn" data-id="' + preset.id + '" title="删除此预设"><i class="fas fa-trash"></i></button>' +
        '</div>';
      listEl.appendChild(item);
    });
  }

  function editPreset(id) {
    var d = presetsLoad();
    var p = d.presets.find(function (x) { return x.id === id; });
    var editor = document.getElementById('prose-preset-editor');
    if (!editor || !p) return;
    editor.style.display = 'block';
    var n = document.getElementById('prose-preset-name');
    var t = document.getElementById('prose-preset-text');
    if (n) n.value = p.name || '';
    if (t) t.value = p.text || '';
    editor.dataset.editingId = p.id;
  }

  function wireApi() {
    if (apiWired) return;
    var CFG = window.FRStandaloneConfig;
    if (!CFG) return;
    // 流式传输由正文预设页的游戏设置保存，API 配置继续独立存储。
    var ids = ['prose-api-url', 'prose-api-key', 'prose-api-reasoning'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.addEventListener('change', persistApi); el.addEventListener('blur', persistApi); }
    });
    NUM_FIELDS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el) { el.addEventListener('change', persistApi); el.addEventListener('blur', persistApi); }
    });
    var sel = document.getElementById('prose-api-model');
    if (sel) sel.addEventListener('change', persistApi);

    // 获取可用模型（卡内同款）
    var fetchBtn = document.getElementById('fetch-prose-models-btn');
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async function () {
        var url = String((document.getElementById('prose-api-url') || {}).value || '').trim();
        var key = String((document.getElementById('prose-api-key') || {}).value || '').trim();
        if (!url) { status('请先填接口地址', false); return; }
        var old = fetchBtn.innerHTML;
        fetchBtn.disabled = true;
        fetchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"> </i> 获取中…';
        status('正在获取模型列表…', true);
        try {
          var models = await fetchModels(url, key);
          modelsCacheSave(models);
          var cur = String((document.getElementById('prose-api-model') || {}).value || '');
          renderModelOptions(document.getElementById('prose-api-model'), models, cur || models[0]);
          persistApi();
          // 2026-10-31：把下拉里选中的值同时写进「启动引导」那个模型文本框，
          // 否则两处模型来源会各说各话（上游日志已证明发出去的是旧默认值）。
          syncModelToBoot();
          status('成功获取 ' + models.length + ' 个模型，已选中「' +
            String((document.getElementById('prose-api-model') || {}).value || '') + '」', true);
        } catch (e) {
          status(explainApiError(e, CFG.load()), false);
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.innerHTML = old;
        }
      });
    }

    // 下拉变更 → 立即落盘并同步到启动引导的模型框
    var modelSel = document.getElementById('prose-api-model');
    if (modelSel) {
      modelSel.addEventListener('change', function () {
        var m = String(modelSel.value || '').trim();
        if (!m) return;
        CFG.save({ model: m });
        syncModelToBoot();
        status('已选择模型「' + m + '」', true);
      });
    }

    // 测试连接
    var testBtn = document.getElementById('test-prose-api-btn');
    if (testBtn) {
      testBtn.addEventListener('click', async function () {
        persistApi();
        var cc = CFG.load();
        if (!cc.apiUrl) { status('请先填接口地址', false); return; }
        if (!cc.model) { status('请先选模型', false); return; }
        testBtn.disabled = true;
        status('正在连接…', true);
        try {
          var r = await window.TavernHelper.generate('请只回复两个字：可用', {
            stream: false,
            systemPrompt: '你是一个测试助手。', skipPreset: true
          });
          status('连接成功：' + (String(r || '').trim() || '（空响应）'), true);
        } catch (e) {
          status(explainApiError(e, cc), false);
        } finally {
          testBtn.disabled = false;
        }
      });
    }

    // 保存并关闭（卡内同款）
    var saveBtn = document.getElementById('save-prose-api-settings-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        persistApi();
        var ov = document.getElementById('regex-settings-overlay') || document.getElementById('settings-overlay');
        if (ov) ov.querySelector('.modal-close-btn')?.click();
      });
    }

    apiWired = true;
  }

  function wirePresets() {
    if (uiWired) return;
    var listEl = document.getElementById('prose-presets-list');
    var importInput = document.getElementById('prose-presets-import-input');

    if (listEl) {
      listEl.addEventListener('click', async function (e) {
        var button = e.target.closest('button');
        if (!button) return;
        var id = button.dataset.id;
        var d = presetsLoad();

        if (button.classList.contains('load-prose-preset-btn')) {
          d.activePresetId = id;
          presetsSave(d);
          renderPresetList();
          editPreset(id);
          pStatus('已切换预设，下一轮生效', true);
        } else if (button.classList.contains('update-prose-preset-btn')) {
          var p = d.presets.find(function (x) { return x.id === id; });
          if (p && window.showCustomConfirm) {
            if (!(await window.showCustomConfirm('确定要用当前编辑器内容覆盖预设「' + p.name + '」吗？'))) return;
          }
          var text = String((document.getElementById('prose-preset-text') || {}).value || '');
          var name = String((document.getElementById('prose-preset-name') || {}).value || '').trim() || p.name;
          if (p) { p.text = text; p.name = name; }
          presetsSave(d);
          renderPresetList();
          pStatus('预设「' + name + '」已更新', true);
        } else if (button.classList.contains('delete-prose-preset-btn')) {
          if (d.presets.length <= 1) { pStatus('无法删除最后一个预设', false); return; }
          var del = d.presets.find(function (x) { return x.id === id; });
          if (window.showCustomConfirm) {
            if (!(await window.showCustomConfirm('确定要删除预设「' + (del ? del.name : '') + '」吗？'))) return;
          }
          d.presets = d.presets.filter(function (x) { return x.id !== id; });
          if (d.activePresetId === id) d.activePresetId = d.presets[0] ? d.presets[0].id : null;
          presetsSave(d);
          renderPresetList();
          var ed = document.getElementById('prose-preset-editor');
          if (ed) ed.style.display = 'none';
          pStatus('已删除', true);
        }
      });
    }

    var createBtn = document.getElementById('create-prose-preset-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var d = presetsLoad();
        var base = d.presets.find(function (p) { return p.id === d.activePresetId; });
        var name = '正文预设 ' + (d.presets.length + 1);
        var preset = {
          id: (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now()),
          name: name,
          text: base ? String(base.text || '') : ''
        };
        d.presets.push(preset);
        d.activePresetId = preset.id;
        presetsSave(d);
        renderPresetList();
        editPreset(preset.id);
        pStatus('已创建「' + name + '」，改个名字和正文再保存', true);
        var n = document.getElementById('prose-preset-name');
        if (n) { n.focus(); n.select(); }
      });
    }

    var importBtn = document.getElementById('import-prose-presets-btn');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', function () { importInput.click(); });
      importInput.addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (ev) {
          try {
            // 2026-10-30 玩家：「依然无法导入预设，参考方舟看看怎么搞的」
            // 根因：这里以前硬校验 Array.isArray，而酒馆预设是对象 → 必报格式错。
            // 现在交给 st-preset-import.js（照方舟 loadPreset 思路）统一识别 5 种格式。
            if (!window.FRStPresetImport || typeof window.FRStPresetImport.importAny !== 'function') {
              throw new Error('预设导入适配器未加载（st-preset-import.js）');
            }
            var cfg = (window.FRStandaloneConfig && window.FRStandaloneConfig.load()) || {};
            var result = window.FRStPresetImport.importAny(String(ev.target.result || ''), file.name, {
              playerName: cfg.playerName || '玩家',
              charName: cfg.characterName || ''
            });
            if (!result || result.ok !== true) {
              pStatus('导入失败：' + ((result && result.reason) || '无法识别该文件格式'), false);
              return;
            }
            var d = presetsLoad();
            var pname = String(result.name || file.name).trim() || ('导入的预设 ' + (d.presets.length + 1));
            var body = String(result.text || '');
            var idx = d.presets.findIndex(function (x) { return x.name === pname; });
            if (idx > -1) {
              d.presets[idx] = { id: d.presets[idx].id, name: pname, text: body };
            } else {
              d.presets.push({
                id: (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now()),
                name: pname, text: body
              });
              idx = d.presets.length - 1;
            }
            d.activePresetId = d.presets[idx].id;
            presetsSave(d);
            renderPresetList();
            editPreset(d.presets[idx].id);

            // 按来源给出可核对的统计，不再只说「导入完成」
            var msg = '导入成功「' + pname + '」（' + formatImportKind(result.kind) + '）';
            var st = result.stats;
            if (st && result.kind === 'st-object') {
              msg += '：识别 ' + st.prompts + ' 条 → 启用 ' + st.orderIds +
                ' 条 → 实注入 ' + st.injected + ' 条 system 块，' + st.chars + ' 字符';
              if (st.skippedRole) msg += '；跳过非 system ' + st.skippedRole + ' 条';
              if (st.empty) msg += '；跳过空内容 ' + st.empty + ' 条';
            } else {
              msg += '：' + body.length + ' 字符';
            }
            pStatus(msg, true);
          } catch (err) {
            pStatus('导入失败：' + (err && err.message ? err.message : err), false);
          } finally {
            e.target.value = '';
          }
        };
        reader.readAsText(file);
      });
    }

    var exportBtn = document.getElementById('export-prose-presets-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        var p = activePreset();
        if (!p) { pStatus('没有可导出的预设', false); return; }
        var blob = new Blob([JSON.stringify([p], null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '正文预设_' + p.name + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        pStatus('已导出「' + p.name + '」', true);
      });
    }

    var restoreBtn = document.getElementById('restore-prose-defaults-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async function () {
        if (window.showCustomConfirm) {
          if (!(await window.showCustomConfirm('确定要把当前预设清空吗？\n清空后完全走内置预设《哈吉米、鲸鱼通用预设（万物有灵）》。此操作不可逆！'))) return;
        }
        var d = presetsLoad();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; });
        if (p) {
          p.text = '';
          presetsSave(d);
          var t = document.getElementById('prose-preset-text');
          if (t) t.value = '';
          renderPresetList();
          pStatus('当前预设已清空，回到内置预设', true);
        }
      });
    }

    var savePresetBtn = document.getElementById('save-prose-preset-btn');
    if (savePresetBtn) {
      savePresetBtn.addEventListener('click', function () {
        var d = presetsLoad();
        var editor = document.getElementById('prose-preset-editor');
        var editingId = editor && editor.dataset.editingId ? editor.dataset.editingId : d.activePresetId;
        var p = d.presets.find(function (x) { return x.id === editingId; });
        if (!p) { pStatus('请先点「创建预设」', false); return; }
        var name = String((document.getElementById('prose-preset-name') || {}).value || '').trim() || p.name;
        var text = String((document.getElementById('prose-preset-text') || {}).value || '');
        p.name = name;
        p.text = text;
        d.activePresetId = p.id;
        presetsSave(d);
        renderPresetList();
        pStatus('已保存「' + name + '」，下一轮生效', true);
      });
    }

    uiWired = true;
  }

  function bind() {
    var CFG = window.FRStandaloneConfig;
    if (!CFG || !document.getElementById('prose-api-section')) return false;
    loadApiToPanel();
    renderPresetList();
    wireApi();
    wirePresets();
    // 打开时把当前激活预设填进编辑器
    var ap = activePreset();
    if (ap) editPreset(ap.id);
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(bind, 50); });
  } else {
    setTimeout(bind, 50);
  }

  // 每次打开设置页重新回填
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#open-regex-settings-btn')) setTimeout(bind, 220);
  }, true);

  window.frProseApiBind = bind;
  window.frProseFetchModels = fetchModels;
  window.frProseNormalizeModelsUrl = normalizeModelsUrl;
})();
