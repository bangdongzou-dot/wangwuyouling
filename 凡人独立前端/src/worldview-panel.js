// Standalone world guidance settings and rule editor.
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;
  var WV = window.FRWorldview;
  if (!WV) return;

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? String(e.value || '') : ''; }
  function setVal(id, v) { var e = el(id); if (e) e.value = v == null ? '' : String(v); }
  function toast(msg, id) {
    var s = el(id || 'wv-api-status');
    if (!s) {
      // 实在找不到就弹窗，绝不让结果静默消失
      try { window.alert(msg || ''); } catch (e) {}
      return;
    }
    s.textContent = msg || '';
    s.style.color = /❌|失败|错误|缺少|尚未/.test(msg || '') ? '#ff9c9c' : '#9fd08a';
  }

  var API_FIELDS = [
    ['wv-api-url', 'apiUrl'],
    ['wv-api-key', 'apiKey'],
    ['wv-temperature', 'temperature'],
    ['wv-topp', 'top_p'],
    ['wv-maxchars', 'maxChars']
  ];

  function loadCfgToPanel() {
    var cfg = WV.cfgLoad();
    API_FIELDS.forEach(function (p) {
      var e = el(p[0]);
      if (!e) return;
      var v = cfg[p[1]];
      e.value = (v == null || v === '') ? '' : String(v);
    });
    var tog = el('wv-enabled-toggle');
    if (tog) tog.checked = cfg.enabled === true;
    // 模型下拉：保留当前值
    var msel = el('wv-api-model');
    if (msel) {
      if (!Array.from(msel.options).some(function (option) { return option.value === ''; })) {
        msel.prepend(new Option('留空沿用正文模型', ''));
      }
      if (cfg.model && !Array.from(msel.options).some(function (option) { return option.value === cfg.model; })) {
        msel.appendChild(new Option(cfg.model, cfg.model));
      }
      msel.value = cfg.model || '';
    }
    if (typeof window.__frRefreshApiEmbeds === 'function') window.__frRefreshApiEmbeds();
  }

  function persistCfg() {
    var cur = WV.cfgLoad();
    var cfg = {
      enabled: el('wv-enabled-toggle') ? el('wv-enabled-toggle').checked : cur.enabled,
      apiUrl: val('wv-api-url').trim(),
      apiKey: val('wv-api-key').trim(),
      model: el('wv-api-model') ? val('wv-api-model') : (cur.model || ''),
      temperature: val('wv-temperature') === '' ? cur.temperature : parseFloat(val('wv-temperature')),
      top_p: val('wv-topp') === '' ? cur.top_p : parseFloat(val('wv-topp')),
      maxChars: parseInt(val('wv-maxchars'), 10) || cur.maxChars
    };
    WV.cfgSave(cfg);
    return cfg;
  }

  /* --------------------------------------------- 占位符自检（核心） */
  // 卡内资料通道（与 fillPlaceholders 的 map 一一对应）
  var KNOWN_CHANNELS = [
    '玩家输入', '既往正文', '世界状态快照', '物品装备', '灵兽', '在场人物',
    '人物档案', '任务', '世界大事', '世界规则', '地理与小地图', '设定集检索',
    '叙事记忆', '启用的世界规则'
  ];

  function checkPlaceholders() {
    var box = el('wv-ph-report');
    if (!box) return;
    var text = WV.activePrompt();          // 当前生效的（自定义或内置）
    var found = [];
    var re = /\$\{([^}]+)\}/g, m;
    while ((m = re.exec(text)) !== null) {
      var k = m[1].trim();
      if (k && found.indexOf(k) < 0) found.push(k);
    }
    var bad = 0;
    box.textContent = '共 ' + found.length + ' 个占位符：';
    found.forEach(function (name) {
      var known = KNOWN_CHANNELS.includes(name);
      if (!known) bad++;
      var item = document.createElement('span');
      item.style.color = known ? '#7ee787' : '#ff8080';
      item.textContent = ' ${' + name + '}' + (known ? '' : '（卡内无此通道）');
      box.append(item);
    });
    var result = document.createElement('p');
    result.textContent = bad ? '有 ' + bad + ' 个对不上，请核对资料通道名称。' : '全部可对应凡人卡资料通道。';
    box.append(result);
  }

  /* ------------------------------------------------------ 入口绑定 */
  var wired = false;
  function bind() {
    if (wired) return;
    wired = true;


    el('wv-enabled-toggle').addEventListener('change', persistCfg);
    el('save-wv-api-btn').addEventListener('click', function () {
      persistCfg();
      toast('已保存世界观指导配置；下一轮生效', 'wv-api-status');
    });

    const fetchModels = el('wv-fetch-models-btn');
    fetchModels.addEventListener('click', async function () {
      const cfg = WV.resolveApiConfig({ apiUrl: val('wv-api-url'), apiKey: val('wv-api-key') });
      if (!cfg.apiUrl) {
        toast('缺少 API URL', 'wv-api-status');
        return;
      }
      fetchModels.disabled = true;
      try {
        const headers = cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {};
        const response = await fetch(cfg.apiUrl + '/models', { headers });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        const models = Array.isArray(result.data) ? result.data.filter(row => typeof row?.id === 'string' && row.id) : [];
        const select = el('wv-api-model');
        const selected = select.value;
        select.replaceChildren(new Option('留空沿用正文模型', ''));
        for (const model of models) select.appendChild(new Option(model.id, model.id));
        if (selected && !Array.from(select.options).some(option => option.value === selected)) {
          select.appendChild(new Option(selected, selected));
        }
        select.value = selected;
        toast('已获取 ' + models.length + ' 个模型', 'wv-api-status');
      } catch (error) {
        toast('获取模型失败：' + error.message, 'wv-api-status');
      } finally {
        fetchModels.disabled = false;
      }
    });

    const testApi = el('wv-test-btn');
    testApi.addEventListener('click', async function () {
      persistCfg();
      testApi.disabled = true;
      try {
        const response = await WV.requestGuidance('只回复两个字：连通', {});
        if (!response.trim()) throw new Error('模型未返回内容');
        toast('模型连通，返回：' + response.slice(0, 40), 'wv-api-status');
      } catch (error) {
        toast('测试失败：' + error.message, 'wv-api-status');
      } finally {
        testApi.disabled = false;
      }
    });

    /* ---- 提示词：直接放面板里编辑（不再套管理器）----------------------- */
    function loadPromptIntoInline() {
      var ta = el('wv-prompt-inline-text');
      if (!ta) return;
      ta.value = String(WV.activePrompt() || '');
      updatePromptCount();
    }
    function updatePromptCount() {
      var ta = el('wv-prompt-inline-text');
      var c = el('wv-prompt-inline-count');
      if (ta && c) {
        var n = ta.value.length;
        var ph = (ta.value.match(/\$\{[^}]+\}/g) || []).length;
        c.textContent = n + ' 字符 · ' + ph + ' 个占位符引用';
      }
      // 统计条：提示词已改成单一整段（不分条目），这里说明现状而不是报 0/0
      var st = el('wv-prompt-stats');
      if (st) {
        var cur = ta ? String(ta.value || '').length : 0;
        var isBuiltin = true;
        try {
          isBuiltin = WV.activePrompt() === String(window.__FR_WV_PROMPT__ || '');
        } catch (e) { isBuiltin = false; }
        st.innerHTML = '当前提示词：<b style="color:#ffd700">' + (isBuiltin ? '内置《万物有灵·分项裁定版》' : '自定义（已修改）') +
          '</b> · 共 <b>' + cur + '</b> 字符';
      }
    }
    var promptTa = el('wv-prompt-inline-text');
    if (promptTa) promptTa.addEventListener('input', updatePromptCount);

    function savePromptInline() {
      var ta = el('wv-prompt-inline-text');
      if (!ta) return false;
      var d = WV.promptsLoad();
      var ap = d.presets.find(function (p) { return p.id === d.activePresetId; });
      if(!ap&&ta.value===String(window.__FR_WV_PROMPT__||''))return true;
      if (!ap) {
        ap = { id: 'wvp-' + Date.now().toString(36), name: '自定义提示词', text: '' };
        d.presets = d.presets || [];
        d.presets.push(ap);
        d.activePresetId = ap.id;
      }
      ap.text = ta.value;
      return WV.promptsSave(d);
    }

    var savePromptBtn = el('save-wv-prompt-inline-btn');
    if (savePromptBtn) savePromptBtn.addEventListener('click', function () {
      if (savePromptInline()) {
        toast('提示词已保存，下一轮生效', 'wv-prompt-status');
        try { checkPlaceholders(); } catch (e) {}
      } else toast('提示词保存失败，请保留修改后重试','wv-prompt-status');
    });

    var resetPromptBtn = el('reset-wv-prompt-inline-btn');
    if (resetPromptBtn) resetPromptBtn.addEventListener('click', function () {
      if (!window.confirm('恢复成内置《万物有灵·分项裁定版》提示词？当前修改会丢失。')) return;
      var d = WV.promptsLoad();
      d.presets = (d.presets || []).filter(function (p) { return p.id !== d.activePresetId; });
      d.activePresetId = null;
      WV.promptsSave(d);
      loadPromptIntoInline();
      checkPlaceholders();
      toast('已恢复内置提示词', 'wv-prompt-status');
    });

    var impPromptBtn = el('import-wv-prompt-inline-btn');
    var impPromptFile = el('wv-prompt-inline-file');
    if (impPromptBtn && impPromptFile) {
      impPromptBtn.addEventListener('click', function () { impPromptFile.click(); });
      impPromptFile.addEventListener('change', function () {
        var f = impPromptFile.files && impPromptFile.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () {
          var txt = String(r.result || '');
          // 支持 {presets:[...]} / {text:...} / 纯文本
          try {
            var j = JSON.parse(txt);
            if (j && Array.isArray(j.presets) && j.presets.length) {
              var selected = j.presets.find(function (p) { return p && p.id === j.activePresetId; }) || j.presets[0];
              if (typeof selected?.text === 'string') txt = selected.text;
            } else if (j && typeof j.text === 'string') {
              txt = j.text;
            }
          } catch (e) { /* 纯文本，原样用 */ }
          var ta = el('wv-prompt-inline-text');
          if (ta) { ta.value = txt; updatePromptCount(); }
          toast('已载入到编辑框，点「保存提示词」生效', 'wv-prompt-status');
        };
        r.readAsText(f, 'utf-8');
        impPromptFile.value = '';
      });
    }

    var expPromptBtn = el('export-wv-prompt-inline-btn');
    if (expPromptBtn) expPromptBtn.addEventListener('click', function () {
      var ta = el('wv-prompt-inline-text');
      var txt = ta ? ta.value : String(WV.activePrompt() || '');
      var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '世界观指导提示词.txt';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      toast('已导出', 'wv-prompt-status');
    });

    var ruleQuery = '';

    function makeToggle(on, onToggle) {
      var sw = document.createElement('label');
      sw.style.cssText = 'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!on;
      inp.style.cssText = 'opacity:0;width:0;height:0;position:absolute;';
      var track = document.createElement('span');
      track.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;border-radius:22px;' +
        'transition:.25s;box-shadow:inset 0 1px 2px rgba(0,0,0,.3);' +
        'background:' + (on ? '#22c55e' : 'rgba(255,255,255,.13)') + ';';
      var knob = document.createElement('span');
      knob.style.cssText = 'position:absolute;height:18px;width:18px;left:2px;top:2px;background:#fff;' +
        'border-radius:50%;transition:.25s;box-shadow:0 1px 3px rgba(0,0,0,.4);' +
        'transform:' + (on ? 'translateX(18px)' : 'translateX(0)') + ';';
      track.appendChild(knob);
      sw.appendChild(inp);
      sw.appendChild(track);
      inp.addEventListener('change', function () {
        track.style.background = inp.checked ? '#22c55e' : 'rgba(255,255,255,.13)';
        knob.style.transform = inp.checked ? 'translateX(18px)' : 'translateX(0)';
        onToggle(inp.checked);
      });
      return sw;
    }

    function humanLen(n) {
      n = Number(n) || 0;
      if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(n);
    }

    function ruleIconBtn(label, title, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.className = 'fr-wv-rule-action';
      b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
      return b;
    }

    function renderRuleInline() {
      var box = el('wv-rule-inline-list');
      if (!box) return;
      var d = WV.rulesLoad();
      var rules = (d.rules || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

      if (ruleQuery) {
        var q = ruleQuery.toLowerCase();
        rules = rules.filter(function (r) { return String(r.name || '').toLowerCase().indexOf(q) >= 0; });
      }

      box.innerHTML = '';
      if (!rules.length) {
        var tip = document.createElement('p');
        tip.style.cssText = 'text-align:center;opacity:.6;margin:22px 0;font-size:.9em;';
        tip.textContent = '没有匹配的规则';
        box.appendChild(tip);
        updateRuleStats();
        return;
      }

      rules.forEach(function (r) {
        var isGreen = r.triggerMode === 'green';
        var isEmpty = !String(r.content || '').trim();
        var on = r.enabled !== false && !isEmpty;

        var card = document.createElement('div');
        card.className = 'fr-wv-rule-card';

        var head = document.createElement('div');
        head.className = 'fr-wv-rule-head';

        var nameEl = document.createElement('span');
        nameEl.style.cssText = 'flex:1;min-width:0;font-size:.94em;font-weight:500;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;color:' + (on ? '#eaeaea' : '#9a9a9a') + ';';
        nameEl.textContent = r.name || '未命名规则';
        head.appendChild(nameEl);

        // 触发模式标签
        var trig = document.createElement('span');
        trig.style.cssText = 'font-size:.72em;padding:1px 6px;border-radius:4px;flex-shrink:0;' +
          (isGreen
            ? 'background:rgba(102,187,106,.18);color:#7bd88f;'
            : 'background:rgba(79,195,247,.18);color:#6cc6f5;');
        trig.textContent = isGreen ? '关键词' : '每轮参与';
        trig.title = isGreen ? '开启指导后，命中关键词才参与本轮裁定' : '开启指导后，每轮都参与裁定';
        head.appendChild(trig);

        if (isEmpty) {
          var et = document.createElement('span');
          et.style.cssText = 'font-size:.72em;padding:1px 6px;border-radius:4px;flex-shrink:0;' +
            'background:rgba(255,120,120,.15);color:#ff9c9c;';
          et.textContent = '空';
          head.appendChild(et);
        }

        var cl = document.createElement('span');
        cl.style.cssText = 'font-size:.78em;opacity:.5;white-space:nowrap;flex-shrink:0;';
        cl.textContent = humanLen(String(r.content || '').length);
        head.appendChild(cl);

        var ctrls = document.createElement('div');
        ctrls.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
        ctrls.appendChild(ruleIconBtn('上', '上移', function () { moveRule(r.id, -1); }));
        ctrls.appendChild(ruleIconBtn('下', '下移', function () { moveRule(r.id, +1); }));
        ctrls.appendChild(ruleIconBtn('查看 / 编辑', '查看或编辑「'+r.name+'」', function () { editRule(r.id); }));
        ctrls.appendChild(ruleIconBtn('删', '删除', function () { deleteRule(r.id, r.name); }));
        head.appendChild(ctrls);

        head.appendChild(makeToggle(on, function (v) {
          var dd = WV.rulesLoad();
          var rr = (dd.rules || []).find(function (x) { return x.id === r.id; });
          if (!rr) return;
          rr.enabled = v;
          if (!WV.rulesSave(dd)) { renderRuleInline(); toast('规则保存失败', 'wv-rule-status-panel'); return; }
          nameEl.style.color = v ? '#eaeaea' : '#9a9a9a';
          updateRuleStats();
        }));

        card.appendChild(head);

        // 预览
        var pv = document.createElement('div');
        pv.style.cssText = 'margin-top:7px;font-size:.78em;line-height:1.5;opacity:.45;word-break:break-all;' +
          'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
        pv.textContent = isEmpty ? '（空内容）' : String(r.content).replace(/\s+/g, ' ').slice(0, 160);
        card.appendChild(pv);

        // 绿灯关键词提示
        if (isGreen && (r.keywords || []).length) {
          var kw = document.createElement('div');
          kw.style.cssText = 'margin-top:4px;font-size:.74em;opacity:.4;';
          kw.textContent = '关键词：' + r.keywords.join(' / ');
          card.appendChild(kw);
        }

        box.appendChild(card);
      });

      updateRuleStats();
    }

    function updateRuleStats() {
      var st = el('wv-rule-stats');
      if (!st) return;
      var d = WV.rulesLoad();
      var all = d.rules || [];
      var on = all.filter(function (r) { return r.enabled !== false && String(r.content || '').trim(); });
      var blue = on.filter(function (r) { return r.triggerMode !== 'green'; }).length;
      var green = on.length - blue;
      var chars = on.reduce(function (n, r) { return n + String(r.content || '').length; }, 0);
      st.innerHTML = '<b style="color:#ffd700">' + on.length + '/' + all.length + '</b> 个世界规则已启用' +
        '（蓝灯 <b style="color:#6cc6f5">' + blue + '</b> / 绿灯 <b style="color:#7bd88f">' + green + '</b>）' +
        '<div style="opacity:.72;font-size:.94em;margin-top:3px;">启用条目合计 <b>' + humanLen(chars) +
        '</b> 字符 · 改完即时生效</div>';
    }

    function moveRule(id, delta) {
      var d = WV.rulesLoad();
      var arr = d.rules;
      arr.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      var i = arr.findIndex(function (x) { return x.id === id; });
      var j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      arr.forEach(function (x, k) { x.order = k; });
      WV.rulesSave(d);
      renderRuleInline();
    }

    function deleteRule(id, name) {
      if (!window.confirm('确定删除规则「' + (name || id) + '」？')) return;
      var d = WV.rulesLoad();
      d.rules = (d.rules || []).filter(function (x) { return x.id !== id; });
      d.deletedIds=Array.from(new Set([...(d.deletedIds||[]),id]));
      if(!WV.rulesSave(d)){toast('规则删除失败','wv-rule-status-panel');return;}
      renderRuleInline();
    }

    var editor=el('wv-rule-editor'),editId=null,editOrigin=null;
    function syncKeywordField(){var green=val('wv-rule-trigger')==='green';el('wv-rule-keywords').hidden=!green;el('wv-rule-keywords-label').hidden=!green;}
    function closeRuleEditor(restoreFocus){
      if(!editor||editor.hidden)return;
      editor.hidden=true;el('wv-rule-inline-list').hidden=false;
      if(restoreFocus){if(editOrigin?.isConnected)editOrigin.focus();else el('wv-rule-inline-search')?.focus();}
      editId=null;editOrigin=null;
    }
    function editRule(id){
      if(!editor)return;
      var r=(WV.rulesLoad().rules||[]).find(function(row){return row.id===id;});
      if(id&&!r)return;
      editId=id||null;editOrigin=document.activeElement;
      el('wv-rule-editor-title').textContent=r?'查看与编辑规则':'新增规则';
      setVal('wv-rule-name',r?.name||'');setVal('wv-rule-content',r?.content||'');
      setVal('wv-rule-trigger',r?.triggerMode==='green'?'green':'blue');setVal('wv-rule-keywords',(r?.keywords||[]).join('，'));
      syncKeywordField();editor.hidden=false;el('wv-rule-inline-list').hidden=true;
      el(r?'wv-rule-content':'wv-rule-name').focus();editor.scrollIntoView({block:'nearest'});
    }
    if(editor){
      el('wv-rule-trigger').addEventListener('change',syncKeywordField);
      el('wv-rule-editor-cancel').addEventListener('click',function(){closeRuleEditor(true);});
      editor.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeRuleEditor(true);}});
      editor.addEventListener('submit',function(e){
        e.preventDefault();var d=WV.rulesLoad(),name=val('wv-rule-name').trim(),content=val('wv-rule-content');
        var triggerMode=val('wv-rule-trigger'),keywords=Array.from(new Set(val('wv-rule-keywords').split(/[，,\n]/).map(x=>x.trim()).filter(Boolean)));
        if(!name||!content.trim()||triggerMode==='green'&&!keywords.length){toast('缺少名称、内容或关键词','wv-rule-status-panel');return;}
        var row=d.rules.find(x=>x.id===editId);
        if(editId&&!row){toast('规则已不存在，无法保存','wv-rule-status-panel');return;}
        if(!row){row={id:'r-'+(window.crypto?.randomUUID?.()||Date.now().toString(36)),enabled:true,order:d.rules.reduce((m,x)=>Math.max(m,x.order||0),-1)+1,depth:0,role:'system'};d.rules.push(row);}
        Object.assign(row,{name,content,triggerMode,keywords});
        if(!WV.rulesSave(d)){toast('规则保存失败，请保留修改后重试','wv-rule-status-panel');return;}
        closeRuleEditor(false);
        renderRuleInline();
        el('wv-rule-inline-search')?.focus();
        toast('条目已保存，下一轮生效', 'wv-rule-status-panel');
      });
    }

    var ruleSearch = el('wv-rule-inline-search');
    if (ruleSearch) ruleSearch.addEventListener('input', function () {
      ruleQuery = ruleSearch.value.trim();
      renderRuleInline();
    });

    var newRuleBtn = el('new-wv-rule-inline-btn');
    if (newRuleBtn) newRuleBtn.addEventListener('click', function () { if(editor?.hidden)editRule(null); });

    var impRulesBtn = el('import-wv-rules-inline-btn');
    var impRulesFile = el('wv-rules-inline-file');
    if (impRulesBtn && impRulesFile) {
      impRulesBtn.addEventListener('click', function () { impRulesFile.click(); });
      impRulesFile.addEventListener('change', function () {
        var f = impRulesFile.files && impRulesFile.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          try {
            var j = JSON.parse(String(rd.result || ''));
            var d = WV.rulesLoad();
            d.rules = d.rules || [];
            var added = 0;
            // 酒馆世界书 {entries:{uid:{...}}}
            if (j && j.entries && typeof j.entries === 'object') {
              Object.keys(j.entries).forEach(function (uid) {
                var e = j.entries[uid] || {};
                d.rules.push({
                  id: 'r-' + uid + '-' + Date.now().toString(36),
                  name: e.comment || ('导入条目 ' + uid),
                  content: String(e.content || ''),
                  enabled: !e.disable,
                  order: d.rules.length,
                  triggerMode: e.constant ? 'blue' : 'green',
                  keywords: Array.isArray(e.key) ? e.key.slice() : [],
                  depth: Number(e.depth || 0),
                  source: 'worldbook'
                });
                added++;
              });
            } else if (j && Array.isArray(j.rules)) {
              j.rules.forEach(function (r) {
                d.rules.push({
                  id: 'r-' + Date.now().toString(36) + '-' + added,
                  name: r.name || ('导入规则 ' + (added + 1)),
                  content: String(r.content || ''),
                  enabled: r.enabled !== false,
                  order: d.rules.length,
                  triggerMode: r.triggerMode === 'green' ? 'green' : 'blue',
                  keywords: r.keywords || [],
                  depth: Number(r.depth || 0),
                  source: r.source === 'worldbook' ? 'worldbook' : ''
                });
                added++;
              });
            } else {
              throw new Error('既不是酒馆世界书，也不是规则包');
            }
            WV.rulesSave(d);
            renderRuleInline();
            toast('已导入 ' + added + ' 条规则', 'wv-rule-status-panel');
          } catch (e) {
            toast('导入失败：' + (e && e.message ? e.message : e), 'wv-rule-status-panel');
          }
        };
        rd.readAsText(f, 'utf-8');
        impRulesFile.value = '';
      });
    }

    var expRulesBtn = el('export-wv-rules-inline-btn');
    if (expRulesBtn) expRulesBtn.addEventListener('click', function () {
      var d = WV.rulesLoad();
      var blob = new Blob([JSON.stringify({ version: '1.0', rules: d.rules || [] }, null, 2)],
        { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '世界规则包.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      toast('已导出', 'wv-rule-status-panel');
    });

    var resetRulesBtn = el('reset-wv-rules-inline-btn');
    if (resetRulesBtn) resetRulesBtn.addEventListener('click', function () {
      if (!window.confirm('恢复成内置 16 条世界规则？自定义规则会丢失。')) return;
      WV.rulesReset();
      renderRuleInline();
      toast('已恢复内置规则', 'wv-rule-status-panel');
    });

    const overlay = el('worldview-overlay');
    const tabs = Array.from(overlay.querySelectorAll('[role="tab"]'));
    function selectTab(index) {
      tabs.forEach(function (tab, position) {
        var selected = position === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        el(tab.getAttribute('aria-controls')).hidden = !selected;
      });
    }
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { selectTab(index); });
      tab.addEventListener('keydown', function (event) {
        const next = {
          ArrowLeft: (index + tabs.length - 1) % tabs.length,
          ArrowRight: (index + 1) % tabs.length,
          Home: 0,
          End: tabs.length - 1
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        selectTab(next);
        tabs[next].focus();
      });
    });

    function closeWorldview() {
      closeRuleEditor(false);
      overlay.classList.remove('visible');
    }
    el('open-worldview-panel-btn').addEventListener('click', function () {
      loadCfgToPanel();
      loadPromptIntoInline();
      checkPlaceholders();
      renderRuleInline();
      overlay.classList.add('visible');
    });
    el('close-worldview-btn').addEventListener('click', closeWorldview);
    el('wv-close-panel-btn').addEventListener('click', closeWorldview);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeWorldview();
    });
    el('wv-save-all-btn').addEventListener('click', function () {
      persistCfg();
      const saved = savePromptInline();
      toast(saved ? '全部设置已保存，下一轮生效' : '提示词保存失败，请保留修改后重试', 'wv-save-all-status');
      checkPlaceholders();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(bind, 0); });
  } else {
    setTimeout(bind, 0);
  }
})();
