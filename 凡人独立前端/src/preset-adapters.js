/* 正文预设管理器适配；世界规则由正文世界规则面板直接维护。 */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;

  var PM = window.FRPresetManager;
  if (!PM) return;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ======================================================== 正文预设 */
  (function () {
    // 数据模型（2026-10-31 改，对齐方舟/酒馆的「分条目 + 每条带开关」）：
    //   { presets: [{ id, name, entries:[{id,name,content,enabled,role,order}], text? }],
    //     activePresetId }
    // 兼容旧数据：老格式 { id, name, text } 会自动迁移成「单条目预设」。
    // 发送时取 activePreset 里 enabled 的条目按 order 拼成一段（prose-api-settings 的 frProsePresetText）。
    var KEY = 'FR_PROSE_PRESETS_V1';
    var ROUTE_KEY = 'FR_PROSE_ROUTE_PRESETS_V1';
    var BUILTIN_ID = '@builtin';
    var BUILTIN_NAME = 'gemini 万物有灵内置预设';
    var LEGACY_BUILTIN_NAMES = ['正文预设', '哈吉米、鲸鱼通用预设（万物有灵）', BUILTIN_NAME];
    var PLAYER_MACRO_MARKER = '__FR_PROSE_PLAYER_NAME__';

    function uid(p) { return (p || 'pe') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

    function normalizePreset(p, i) {
      if (!p || typeof p !== 'object') return null;
      var out = {
        id: String(p.id || uid('pset')),
        name: String(p.name || ('预设 ' + (i + 1)))
      };
      if (Array.isArray(p.entries)) {
        out.entries = p.entries.filter(function (e) { return e && typeof e === 'object'; }).map(function (e, k) {
          var rawContent = String(e.content == null ? '' : e.content);
          var builtinFormat = window.__FR_BUILTIN_PRESET__?.prompts?.find(function (row) {
            return row.identifier === e.id && ['prompt_1764837454104_zdms0so','c3aff14f-fcce-4e05-818c-8b1ed8da963b'].includes(row.identifier);
          });
          if (builtinFormat && rawContent.trim() === String(builtinFormat.content || '').trim()) return null;
          var oldFormat = window.__FR_PROSE_RENDER_FORMAT__?.split('\n\n## 固定输出外层')[0];
          if (oldFormat && rawContent.startsWith('## 灵动正文 · 万物有灵')) {
            rawContent = rawContent.replace(/\r\n/g, '\n').replace('\n\n' + oldFormat, '');
          }
          var c = window.FRWorldRules?.upgradeProseEntry(String(e.name || ''),rawContent);
          if (c === null) return null; // An untouched retired built-in no longer appears or sends.
          c = c ?? rawContent;
          /* 2026-10-31 玩家：「开关逻辑要能生效啊，我开关哪个条目要真的这个条目开了或者关了才行」
           *
           * 原来看法：enabled 必须是 `e.enabled !== false && !!c.trim()`——
           * 内容为空就强制关闭。这在「普通空条目」上是对的（发空串没意义），
           * 但对**纯宏条目**是灾难：
           *   🌸前置(别关) / 🔴游戏难度 / 🔍中高召回率 / 🔑格式加强 /
           *   ⏱️慢速剧情 / 🌸防抢话 —— 这 6 条内容只有 {{setvar::...}}，
           *   展开后 content 就是空串。
           * 于是玩家把它们拨开 → 下次 normalize 又强制关回去，
           * 表现为「开关点了没用、自己弹回去」，而且这些正是后续条目
           * getvar 取值的来源，关掉它们整套规则就失效。
           *
           * 现在的口径：
           *   · 玩家显式关掉（e.enabled === false）→ 保持关闭，这是玩家的选择
           *   · 玩家显式打开（e.enabled === true）→ 保持打开，哪怕内容为空
           *   · 没记录过（e.enabled == null）→ 有内容才默认开，空则默认关
           * 也就是：**只要玩家动过开关，就完全尊重玩家的选择**，
           * 不再用「内容是否为空」去覆盖它。
           */
          var enabled;
          if (e.enabled === true) enabled = true;
          else if (e.enabled === false) enabled = false;
          else enabled = !!c.trim();
          return {
            id: String(e.id || uid('pe')),
            name: String(e.name || ('条目 ' + (k + 1))),
            content: c,
            enabled: enabled,
            role: String(e.role || 'system'),
            order: Number(e.order == null ? k : e.order),
            empty: !c.trim(),
            // 纯宏标记要保住，否则下游会把「空内容」当垃圾丢掉
            macroOnly: e.macroOnly === true,
            // 宿主槽位标记也要保住：面板靠它显示「酒馆槽位」徽标和说明
            hostSlot: e.hostSlot === true,
            hostNote: String(e.hostNote || ''),
            // inOrder：是否在酒馆 prompt_order 里（= 酒馆会不会发送）。
            // 不在 order 里的条目仍然保留在列表中（玩家要看完整预设），
            // 但面板必须标记出来，否则玩家会以为顺序错乱或漏发。
            inOrder: e.inOrder !== false,
            reason: String(e.reason || (c.trim() ? '' : (e.macroOnly ? '纯宏定义（只设变量，无正文）' : '空内容')))
          };
        }).filter(Boolean);
        out.entries.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      } else {
        // 迁移旧格式：整段 text → 一条
        var t = String(p.text || '');
        out.entries = t.trim() ? [{
          id: uid('pe'), name: out.name, content: t, enabled: true,
          role: 'system', order: 0, empty: false, reason: ''
        }] : [];
      }
      return out;
    }

    function readAll() {
      try {
        var v = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!v || !Array.isArray(v.presets)) return { presets: [], activePresetId: null };
        var presets = v.presets.map(normalizePreset).filter(Boolean);
        var activeId = v.activePresetId && presets.some(function (p) { return p.id === v.activePresetId; })
          ? v.activePresetId : (presets[0] ? presets[0].id : null);
        return { presets: presets, activePresetId: activeId };
      } catch (e) { return { presets: [], activePresetId: null }; }
    }
    function writeAll(d) {
      try { localStorage.setItem(KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
    }

    /** 发送时用：把启用条目按 order 拼成一段 system 文本。
     *
     * ★ 2026-10-31 关键修正（玩家：「开关逻辑要能生效啊，我开关哪个条目要真的
     *   这个条目开了或者关了才行」）：
     *
     *   原来这里是「过滤 enabled + 有 content + 按 order 排序 + join」。
     *   问题在于 entries[].content 是**导入时就已经展开好的死数据**：
     *     · 关掉一条 {{setvar::x::v}} 条目，后面的 {{getvar::x}} 还是旧值 → 开关没生效
     *     · 纯宏条目展开后 content 为空，被"有 content"这一条过滤掉 → 变量根本没设上
     *
     *   现在改为调用 FRStPresetImport.renderEntries()：**每次发送都按当前启用的
     *   条目、按当前 order 顺序，从头重新跑一遍宏**。这才是酒馆的真实行为。
     *   找不到导入器时（比如纯手工建的预设）退回原来的简单拼接。
     */
    /* 把当前预设渲染成**按 role 拆分的消息序列**（酒馆真实行为）。
     *
     * 玩家 2026-10-31：「对，有些是系统消息，有些是玩家消息，但是你要适配处理啊，
     *   我说了我要达到和酒馆版本一样的效果」
     *
     * 酒馆里每条 prompt 有自己的 role，openai.js 里
     *   Message.fromPromptAsync(prompt) → Message.createAsync(prompt.role, ...)
     * 也就是**每条按自己的 role 变成一条消息**。这里复刻这个行为。
     *
     * @returns {Array<{role, content}>} 按 system → user → assistant 排好序的消息数组
     */
    function presetMessages(p) {
      if (!p || !Array.isArray(p.entries)) return [];
      var ctx = (function () {
        try {
          var c = (window.FRStandaloneConfig && window.FRStandaloneConfig.load()) || {};
          return { playerName: c.playerName || '玩家', charName: c.charName || '' };
        } catch (e) { return {}; }
      })();
      if (window.FRStPresetImport && typeof window.FRStPresetImport.renderEntries === 'function') {
        try {
          var r = window.FRStPresetImport.renderEntries(p.entries, ctx);
          if (r && Array.isArray(r.messages) && r.messages.length) return r.messages;
          // 老版本 renderEntries 没有 messages 字段时，退回单条 system
          if (r && r.text) return [{ role: 'system', content: r.text }];
        } catch (e) {
          console.warn('[正文预设] 按 role 渲染失败，退回简单拼接:', e);
        }
      }
      // 兜底：全部当 system 拼一段
      var txt = presetText(p);
      return txt ? [{ role: 'system', content: txt }] : [];
    }

    function presetText(p) {
      if (!p || !Array.isArray(p.entries)) return '';
      var ctx = (function () {
        try {
          var c = (window.FRStandaloneConfig && window.FRStandaloneConfig.load()) || {};
          return { playerName: c.playerName || '玩家', charName: c.charName || '' };
        } catch (e) { return {}; }
      })();
      if (window.FRStPresetImport && typeof window.FRStPresetImport.renderEntries === 'function') {
        try {
          var r = window.FRStPresetImport.renderEntries(p.entries, ctx);
          return r.text;
        } catch (e) {
          console.warn('[正文预设] 重新展开宏失败，退回直接拼接:', e);
        }
      }
      return p.entries
        .filter(function (e) { return e.enabled !== false && String(e.content || '').trim(); })
        .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
        .map(function (e) { return String(e.content).trim(); })
        .join('\n\n');
    }

    // 管理器看到的是「当前预设的条目」——这才是玩家要的逐条开关
    function activePreset() {
      var d = readAll();
      return d.presets.find(function (p) { return p.id === d.activePresetId; }) || d.presets[0] || null;
    }

    function importBuiltin(playerName) {
      if (!window.__FR_BUILTIN_PRESET__ || !window.FRStPresetImport) return null;
      var data = window.FRStandaloneConfig?.load() || {};
      return window.FRStPresetImport.importAny(JSON.stringify(window.__FR_BUILTIN_PRESET__), BUILTIN_NAME + '.json',
        { playerName: playerName || data.playerName || '玩家', charName: data.charName || '主角' });
    }

    function builtinPresetTemplate() {
      var parsed = importBuiltin(PLAYER_MACRO_MARKER);
      return parsed?.ok ? normalizePreset({ id: BUILTIN_ID, name: BUILTIN_NAME, entries: parsed.items }, 0) : null;
    }

    function isBuiltinCopy(preset, builtin) {
      if (!builtin || !LEGACY_BUILTIN_NAMES.includes(preset.name) || preset.entries.length !== builtin.entries.length) return false;
      var importedPlayerName;
      var entryFields = ['name', 'role', 'order', 'enabled', 'inOrder', 'macroOnly', 'hostSlot'];
      return preset.entries.every(function (entry, index) {
        var template = builtin.entries[index];
        if (!entryFields.every(function (key) { return entry[key] === template[key]; })) return false;
        var content = entry.content.trim();
        var templateContent = template.content.trim();
        if (content === templateContent) return true;
        // This macro is expanded to a fresh cache-busting token at import time.
        var cacheToken = /^Nonsense_Test_ID: (?:[a-z]\d+){5}[a-z]$/u;
        if (entry.name === '🌀防429' && cacheToken.test(content) && cacheToken.test(templateContent)) return true;
        var parts = templateContent.split(PLAYER_MACRO_MARKER);
        if (parts.length === 1) return false;
        // Old imports substituted the player name into these exact macro positions.
        if (importedPlayerName === undefined) {
          var escaped = parts.map(function (part) { return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
          var pattern = escaped[0] + '(?<playerName>.*?)' + escaped.slice(1).join('\\k<playerName>');
          importedPlayerName = new RegExp('^' + pattern + '(?![\\s\\S])', 's').exec(content)?.groups.playerName;
        }
        return importedPlayerName !== undefined && parts.join(importedPlayerName) === content;
      });
    }

    function requestPreset(id) {
      if (id === BUILTIN_ID) {
        var parsed = importBuiltin();
        if (parsed?.ok) return {entries:parsed.items};
      }
      return id && readAll().presets.find(function (p) { return p.id === id; }) || activePreset();
    }

    function routeBindings() {
      try { return JSON.parse(localStorage.getItem(ROUTE_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }

    window.FRProseRoutePresets = {
      options: function (routeId) {
        var presets = readAll().presets;
        var selected = window.FRProseRoutePresets.get(routeId);
        var builtin = builtinPresetTemplate();
        var builtinId = BUILTIN_ID;
        var options = [];
        presets.forEach(function (preset) {
          if (isBuiltinCopy(preset, builtin)) {
            // Keep an existing route on the original saved entries and ID.
            if (preset.id === selected) builtinId = selected;
          } else {
            options.push({ id: preset.id, name: preset.name });
          }
        });
        return [{ id: builtinId, name: BUILTIN_NAME }].concat(options);
      },
      get: function (routeId) {
        var bindings = routeBindings();
        return routeId && Object.hasOwn(bindings,routeId) ? bindings[routeId] : '';
      },
      set: function (routeId,id) {
        var bindings = {...routeBindings(),[routeId]:id};
        if (!id) delete bindings[routeId];
        localStorage.setItem(ROUTE_KEY,JSON.stringify(bindings));
      },
    };

    // A preset detail page edits only its own snapshot, never the global active selection.
    window.FRProseRoutePresets.open = function(routeId) {
      var id = window.FRProseRoutePresets.get(routeId), source = id === BUILTIN_ID ? builtinPresetTemplate() :
        id ? readAll().presets.find(function(p){return p.id===id;}) : activePreset();
      if (!source) throw new Error('绑定预设已不存在，请重新选择');
      var draft=JSON.parse(JSON.stringify(source)), locked=id===BUILTIN_ID;
      var dialog=document.createElement('dialog');dialog.className='fr-evo-rule-dialog';
      dialog.setAttribute('aria-label','正文预设编辑与查看');
      dialog.style.cssText='width:min(1000px,92vw);max-height:88vh;background:var(--bg-panel,#20242d);color:var(--text-primary,#eee);border:1px solid var(--border-color,#666);border-radius:12px;padding:24px';
      var heading=document.createElement('h3');heading.textContent='正文预设 · '+source.name;dialog.append(heading);
      var note=document.createElement('p');note.textContent=locked?'内置预设只读，可复制为自定义后编辑。':'保存只更新这份预设，不改变当前默认预设或其他接口的绑定。';dialog.append(note);
      var editor=document.createElement('div');editor.className='fr-evo-rule-editor';editor.style.cssText='display:grid;grid-template-columns:minmax(160px,28%) 1fr;gap:16px;height:55vh';
      var list=document.createElement('div');list.style.overflow='auto';var content=document.createElement('div');content.style.overflow='auto';editor.append(list,content);dialog.append(editor);
      function edit(index){content.replaceChildren();var entry=draft.entries[index];if(!entry)return;
        var title=document.createElement('input');title.value=entry.name;title.disabled=locked;title.setAttribute('aria-label','条目名称');title.style.width='100%';
        var role=document.createElement('select');role.setAttribute('aria-label','消息角色');['system','user','assistant'].forEach(function(value){var option=document.createElement('option');option.value=value;option.textContent=value;role.append(option);});role.value=entry.role||'system';role.disabled=locked;
        var label=document.createElement('label'),enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=entry.enabled!==false;enabled.disabled=locked;label.append(enabled,document.createTextNode('启用此条目'));
        var text=document.createElement('textarea');text.value=entry.content||'';text.readOnly=locked;text.rows=18;text.style.cssText='display:block;width:100%;height:calc(100% - 70px);box-sizing:border-box;margin-top:12px';text.setAttribute('aria-label','提示词内容');
        title.oninput=function(){entry.name=title.value;list.children[index].textContent=title.value;};role.onchange=function(){entry.role=role.value;};enabled.onchange=function(){entry.enabled=enabled.checked;};text.oninput=function(){entry.content=text.value;};content.append(title,role,label,text);
      }
      (draft.entries||[]).forEach(function(entry,index){var btn=document.createElement('button');btn.type='button';btn.className='fr-evo-rule-row';btn.textContent=entry.name||'条目 '+(index+1);btn.style.cssText='display:block;width:100%;text-align:left;margin-bottom:6px';btn.onclick=function(){edit(index);};list.append(btn);});edit(0);
      var footer=document.createElement('div');footer.style.cssText='display:flex;gap:12px;margin-top:18px';dialog.append(footer);
      var saveButton=document.createElement('button');saveButton.type='button';saveButton.className='primary-btn';saveButton.textContent=locked?'复制为自定义并绑定此接口':'保存预设';
      saveButton.onclick=function(){var data=readAll();if(locked){draft.id=uid('pset');draft.name=source.name+' · 自定义';data.presets.push(draft);}else{var index=data.presets.findIndex(function(p){return p.id===draft.id;});if(index<0){note.textContent='预设已删除，无法保存，请重新打开。';return;}data.presets[index]=draft;}
        if(!writeAll(data)){note.textContent='保存失败，请检查浏览器存储空间。';return;}if(locked)window.FRProseRoutePresets.set(routeId,draft.id);window.dispatchEvent(new CustomEvent('fr:prose-presets-changed'));dialog.close();};
      var close=document.createElement('button');close.type='button';close.className='small-btn';close.textContent='关闭';close.onclick=function(){dialog.close();};footer.append(saveButton,close);
      dialog.addEventListener('close',function(){dialog.remove();});document.body.append(dialog);dialog.showModal();
    };

    function load() {
      var p = activePreset();
      return p ? p.entries.slice() : [];
    }

    function save(items) {
      var d = readAll();
      var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
      if (!p) {
        p = { id: uid('pset'), name: '我的正文预设', entries: [] };
        d.presets.push(p);
        d.activePresetId = p.id;
      }
      p.entries = (items || []).map(function (e, i) {
        return {
          id: e.id || uid('pe'),
          name: String(e.name || ('条目 ' + (i + 1))),
          content: String(e.content == null ? '' : e.content),
          enabled: e.enabled !== false,
          // 2026-10-31：role 不能再写死成 system。
          // 酒馆里每条 prompt 有自己的 role（system/user/assistant），
          // 发送时按 role 分别变成对应消息（openai.js Message.fromPromptAsync）。
          // 写死 system 会让「前置破甲」「📝自定义输出格式」这类 user 条目
          // 全被塞进 system 通道，效果和酒馆不一致。
          role: (e.role === 'user' || e.role === 'assistant') ? e.role : 'system',
          order: Number(e.order == null ? i : e.order),
          identifier: e.identifier || '',
          macroOnly: !!e.macroOnly,
          hostSlot: !!e.hostSlot,
          hostNote: e.hostNote || '',
          empty: !String(e.content || '').trim()
        };
      });
      writeAll(d);
      try { window.dispatchEvent(new CustomEvent('fr:prose-presets-changed')); } catch (e) {}
    }

    PM.register('prose', {
      label: '正文条目', itemLabel: '正文条目',
      listId: 'prose-preset-manager-list', statsId: 'prose-preset-stats', statsIdOv: 'prose-preset-stats-ov', statusId: 'prose-preset-manager-status',
      hasTriggerMode: false,
      overlayId: 'prose-preset-manager-overlay',
      openBtnId: null,   // 正文条目已内嵌到面板，不再需要「打开管理器」入口
      closeBtnId: 'close-prose-preset-manager-btn',
      editorOverlayId: 'prose-preset-editor-overlay',
      editorTitleId: 'prose-preset-editor-title',
      fNameId: 'prose-preset-entry-name',
      fContentId: 'prose-preset-entry-text',
      fCountId: 'prose-preset-entry-count',
      newBtnId: 'new-prose-preset-btn',
      importBtnId: 'import-prose-presets-btn',
      exportBtnId: 'export-prose-presets-btn',
      resetBtnId: 'restore-prose-defaults-btn',
      saveBtnId: 'save-prose-preset-btn',
      cancelBtnId: 'cancel-prose-preset-btn',
      editorCloseId: 'close-prose-preset-editor-btn',
      exportName: '正文预设',
      exportPayload: function (items) {
        var d = readAll();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
        if (!p) return { presets: [] };
        return {
          version: '2.0',
          name: p.name,
          entries: (p.entries || []).map(function (e) {
            return { name: e.name, content: e.content, enabled: e.enabled !== false, role: e.role || 'system', order: e.order || 0 };
          })
        };
      },
      /**
       * 正文预设专用导入器（2026-10-31 改：产出**逐条目**，每条带开关）。
       * 酒馆预设 {prompts:[117], prompt_order:[...]} 按方舟 ark-preset-adapter 的口径
       * （byId 映射 → 取最后一个 order 组 → 按 enabled 筛）展开成条目列表，
       * 每条保留 name / enabled / role / order，玩家可逐条开关。
       */
      importer: function (text, filename) {
        var name = String(filename || '导入预设').replace(/\.(json|txt|md)$/i, '');
        var obj = null;
        try { obj = JSON.parse(text); } catch (e) { obj = null; }

        if (window.FRStPresetImport && window.FRStPresetImport.importAny) {
          var isSt = window.FRStPresetImport.isStPreset && window.FRStPresetImport.isStPreset(obj);
          // 酒馆预设或本工程 v2 条目包，都走条目化导入
          if (isSt || (obj && Array.isArray(obj.entries))) {
            var cfg = (window.FRStandaloneConfig ? window.FRStandaloneConfig.load() : {}) || {};
            var res = window.FRStPresetImport.importAny(text, filename, {
              playerName: cfg.playerName || '玩家',
              charName: cfg.charName || '主角'
            });
            if (!res || !res.ok) return { ok: false, items: [], reason: (res && res.reason) || '预设解析失败' };

            /* ★★ 2026-10-31 玩家：「内置初始的那份也要是正确的顺序，
             *   玩家导入的也不要动他的顺序和开关，明白吗？」
             *
             * 原来这里写的是：
             *     enabled: it.enabled !== false && !!String(it.content || '').trim(),
             *     order: Number(it.order == null ? i : it.order),
             *
             * 两个错：
             *   ① enabled 又用「内容是否为空」覆盖了导入器的结果。
             *      纯宏条目（🌸前置(别关) / 🔴游戏难度 / 🔍中高召回率 /
             *      🔑格式加强 / ⏱️慢速剧情 / 🌸防抢话，共 6 条开着）
             *      展开后 content 是空串 → 被强制关掉。
             *      它们是下游 getvar 的数据源，关了整套预设规则就废了。
             *   ② 没把 identifier / macroOnly / hostSlot / reason 传下去，
             *      下游 normalizePreset 拿不到纯宏标记，面板也没法区分。
             *
             * 现在的口径：**导入器给什么就是什么，一个字不改。**
             * 导入器（st-preset-import.js 的 assemble）已经严格按酒馆
             * prompt_order 算好了每条的顺序和开关，这里再加工只会破坏它。
             */
            var items = (res.items || []).map(function (it, i) {
              var c = String(it.content == null ? '' : it.content);
              return {
                name: it.name,
                content: c,
                // 保留导入器算好的开关：纯宏条目也是 true，不能因为内容空就关掉
                enabled: it.enabled !== false,
                // 保留导入器算好的顺序：order 内是 prompt_order 下标，order 外是 1000+
                order: Number(it.order == null ? i : it.order),
                role: it.role || 'system',
                identifier: it.identifier || '',
                macroOnly: !!it.macroOnly,
                hostSlot: !!it.hostSlot,
                hostNote: it.hostNote || '',
                empty: !c.trim(),
                reason: it.reason || ''
              };
            });
            // 按 order 排好，保证下游拿到的数组顺序就是最终顺序
            items.sort(function (a, b) { return a.order - b.order; });

            var onN = items.filter(function (x) { return x.enabled; }).length;
            var note = res.stats
              ? ('酒馆预设已展开：' + res.stats.prompts + ' 条 prompt → ' + items.length + ' 个条目，其中 ' + onN + ' 个默认启用（可逐条开关）')
              : ('已导入 ' + items.length + ' 个条目，其中 ' + onN + ' 个默认启用');
            return { ok: true, items: items, note: note };
          }
        }
        return null;   // 交给通用 importAny
      },
      load: load, save: save,
      reset: function () {
        // 「恢复至空白」：清掉当前预设的条目（对齐方舟「恢复至空白」语义）
        var d = readAll();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
        if (p) p.entries = [];
        writeAll(d);
        try { window.dispatchEvent(new CustomEvent('fr:prose-presets-changed')); } catch (e) {}
      }
    });

    // 暴露给 prose-api-settings.js 的垫片取文本用
    window.frProsePresetText2 = function (presetId) {
      var p = requestPreset(presetId);
      return presetText(p);
    };
    /* 暴露「按 role 拆分的消息序列」给垫片。
     *
     * 玩家 2026-10-31：「有些是系统消息，有些是玩家消息，但是你要适配处理啊，
     *   我说了我要达到和酒馆版本一样的效果」
     *
     * 酒馆里 role=user / assistant 的条目（前置破甲、📝自定义输出格式、
     * 🎨强化、⚡重置D0＆卡思维链 …）会作为**对应角色的消息**发出去，
     * 不是拼进 system。垫片 buildMessages 用这个函数拿到完整消息序列。
     */
    window.frProsePresetMessages = function (presetId) {
      var CFG = window.FRStandaloneConfig;
      if (CFG) {
        try {
          var c = CFG.load();
          if (c && c.prosePresetEnabled === false) return [];
        } catch (e) {}
      }
      var p = requestPreset(presetId);
      return presetMessages(p);
    };
    window.frProseActivePreset2 = activePreset;
    window.frProseEntrySetEnabled = function (entryId, on) {
      var d = readAll();
      var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
      if (!p) return false;
      var e = (p.entries || []).find(function (x) { return x.id === entryId; });
      if (!e) return false;
      e.enabled = !!on;
      writeAll(d);
      return true;
    };

    /* ==================================================================
     * 内嵌条目列表（2026-10-31）
     * 玩家口径：「ui太简陋了，而且没必要放进预设管理器，开关也要在右边」
     * → 条目直接铺在「正文与正则设置」面板里，卡片式，右侧滑动开关。
     * 复用同一份数据（FR_PROSE_PRESETS_V1），和管理器看到的是同一份。
     * ================================================================== */
    var inlineQuery = '';

    function humanLen(n) {
      n = Number(n) || 0;
      if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(n);
    }

    function makeSwitch(name, on, onToggle) {
      var label = document.createElement('label');
      label.className = 'fr-content-switch';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!on;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', '启用条目：' + name);
      var track = document.createElement('span');
      track.setAttribute('aria-hidden', 'true');
      label.appendChild(input);
      label.appendChild(track);
      input.addEventListener('change', function () { onToggle(input.checked); });
      return label;
    }

    function entryAction(label, action, name, onClick) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'fr-prose-card-action';
      button.textContent = label;
      button.title = action;
      button.setAttribute('aria-label', action + '：' + name);
      button.addEventListener('click', onClick);
      return button;
    }

    /* ------------------------------------------------------------------
     * 首次启动自动展开内置预设（玩家口径：「我的意思就是内置开箱就有，
     * 安装好就自动带这个预设」）。
     *
     * 之前的状态：内置 preset.json 确实打进了包体（SHA256 与原始文件一致），
     * 但正文预设面板是空的 —— 必须玩家自己点「导入预设」选一次文件才有条目，
     * 所以玩家看到的还是「内置了但没用上」。
     *
     * 现在的做法：面板第一次渲染时，如果当前预设一个条目都没有，
     * 就用 st-preset-import 的解析器把内置预设展开成逐条目写进去。
     * 三条约束：
     *   ① 只在**完全没有条目**时执行，绝不覆盖玩家已经改过的内容；
     *   ② 执行一次就置标记，之后即使玩家点「恢复至空白」也不再自动灌回；
     *   ③ 解析失败静默跳过，不阻断面板渲染。
     *
     * ★ 2026-10-31 三次修正（玩家：「条目顺序似乎和酒馆看到的不一样」
     *   「反正这里的顺序一定是错的，而且末尾一些条目也没了」
     *   「切记顺序一定不能错，开关生效也一定要正确，条目一个不能少」）：
     *
     *   前面几版把「已经灌过一次」当成「永远不用再灌」。但早期版本的解析器
     *   本身有 bug（开关用反、纯宏条目丢弃、order 乱），玩家机器上留下的
     *   就是那批**错误的旧数据**。修好解析器之后，这些旧数据不会自己变对 ——
     *   于是玩家看到的顺序和条目数依然是错的。
     *
     *   现在加 AUTOSEED_VERSION：只要版本号变了，就重新展开一次。
     *   代价是玩家对内置预设的**手工改动会被覆盖**，但这是必要的：
     *   内置预设是随包更新的权威数据，玩家要改可以复制一份另存。
     *   为降低影响，重建前会把旧数据备份到 FR_PROSE_AUTOSEED_BACKUP_V1。
     * ------------------------------------------------------------------ */
    var AUTOSEED_KEY = 'FR_PROSE_AUTOSEED_V1';
    var AUTOSEED_BACKUP_KEY = 'FR_PROSE_AUTOSEED_BACKUP_V1';
    // 每次修正解析器/内置数据就 +1，强制玩家机器上的旧数据重建。
    //   1 = 初版（开关用反、order 乱、纯宏条目丢）→ 已废弃
    //   2 = 修好 prompt_order 开关 + 保留纯宏条目 + order 严格对齐酒馆
    var AUTOSEED_VERSION = '2';

    function autoSeedBuiltin() {
      try {
        if (localStorage.getItem(AUTOSEED_KEY) === AUTOSEED_VERSION) return false;
        var d = readAll();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
        // 已有条目 → 玩家有数据。
        // 但如果版本号没跟上，说明这是旧版解析器留下的错误数据，必须重建。
        if (p && p.entries && p.entries.length) {
          try {
            localStorage.setItem(AUTOSEED_BACKUP_KEY, JSON.stringify({ at: Date.now(), from: localStorage.getItem(AUTOSEED_KEY) || '(无)', presets: d.presets }));
          } catch (e) {}
          console.log('[正文预设] 检测到旧版内置数据（' + (localStorage.getItem(AUTOSEED_KEY) || '无标记') + '），将按 v' + AUTOSEED_VERSION + ' 重建');
        }
        var builtin = window.__FR_BUILTIN_PRESET__;
        if (!builtin || !window.FRStPresetImport || !window.FRStPresetImport.importAny) return false;

        var cfg = (window.FRStandaloneConfig ? window.FRStandaloneConfig.load() : {}) || {};
        var res = window.FRStPresetImport.importAny(
          JSON.stringify(builtin), BUILTIN_NAME + '.json',
          { playerName: cfg.playerName || '玩家', charName: cfg.charName || '主角' }
        );
        if (!res || !res.ok || !res.items || !res.items.length) return false;

        // ★ 关键：必须**先按 order 排序**再写进去。
        //   res.items 的顺序是「order 内按 prompt_order 顺序 + order 外按 prompts 数组顺序」，
        //   而面板和发送都只认 entries[].order 排序后的结果。
        //   这里排好序，保证写进 localStorage 的数组本身就是最终顺序，
        //   不依赖下游每个消费方都记得再排一次。
        var items = res.items.slice().sort(function (a, b) {
          return (Number(a.order == null ? 0 : a.order)) - (Number(b.order == null ? 0 : b.order));
        }).map(function (it) {
          return {
            name: it.name,
            content: it.content,
            // 纯宏条目（只 setvar，展开后无正文）也必须保留：
            // 它们是后续条目 getvar 的数据来源，也是 order 序列的一部分。
            enabled: it.enabled !== false,
            order: Number(it.order == null ? 0 : it.order),
            role: it.role || 'system',
            identifier: it.identifier || '',
            macroOnly: !!it.macroOnly,
            // inOrder：是否在酒馆 prompt_order 里。
            // 面板靠它区分「会发送」和「酒馆本来就不发」的条目，
            // 不加标记玩家会误以为顺序错了。
            inOrder: it.inOrder !== false,
            hostSlot: !!it.hostSlot,
            hostNote: it.hostNote || '',
            empty: !!it.empty,
            reason: it.reason || ''
          };
        });

        if (!p) {
          p = { id: uid('pset'), name: BUILTIN_NAME, entries: [] };
          d.presets.push(p);
          d.activePresetId = p.id;
        } else if (!p.name || /^预设 \d+$/.test(p.name)) {
          p.name = BUILTIN_NAME;
        }
        p.entries = items;
        // 让 normalizePreset 补全 id / empty / reason 等字段
        var norm = normalizePreset(p, 0);
        var idx = d.presets.findIndex(function (x) { return x.id === p.id; });
        if (idx >= 0) d.presets[idx] = norm;
        writeAll(d);
        localStorage.setItem(AUTOSEED_KEY, AUTOSEED_VERSION);
        try { window.dispatchEvent(new CustomEvent('fr:prose-presets-changed')); } catch (e) {}
        console.log('[正文预设] 已展开内置预设 v' + AUTOSEED_VERSION + '：' + items.length + ' 个条目，其中 ' +
          items.filter(function (x) { return x.enabled; }).length + ' 个启用');
        return true;
      } catch (e) {
        console.warn('[正文预设] 自动展开内置预设失败:', e);
        return false;
      }
    }

    function renderInline() {
      var box = document.getElementById('prose-inline-entries');
      if (!box) return;
      var p = activePreset();
      var deleteBtn = document.getElementById('delete-prose-inline-btn');
      if (deleteBtn) deleteBtn.disabled = !p;
      var picker = document.getElementById('fr-current-prose-preset');
      if (picker) {
        picker.replaceChildren();
        var builtin = builtinPresetTemplate();
        readAll().presets.forEach(function (preset) {
          var opt = document.createElement('option');
          opt.value = preset.id;
          opt.textContent = isBuiltinCopy(preset, builtin) ? BUILTIN_NAME : preset.name;
          picker.append(opt);
        });
        picker.disabled = !p;
        picker.value = p?.id || '';
      }
      var entries = p ? (p.entries || []).slice() : [];
      entries.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

      if (inlineQuery) {
        var q = inlineQuery.toLowerCase();
        entries = entries.filter(function (e) { return String(e.name || '').toLowerCase().indexOf(q) >= 0; });
      }

      box.innerHTML = '';
      if (!entries.length) {
        var tip = document.createElement('p');
        tip.textContent = inlineQuery ? '没有找到匹配的条目。' :
          '当前预设没有条目，可新增条目或导入预设。';
        box.appendChild(tip);
        updateInlineStats();
        return;
      }

      var shownInOrder = false;
      var shownSeparator = false;
      entries.forEach(function (entry) {
        if (entry.inOrder === false && shownInOrder && !shownSeparator) {
          var separator = document.createElement('p');
          separator.className = 'fr-prose-group-separator';
          separator.textContent = '以下条目不在酒馆的发送序列中。';
          box.appendChild(separator);
          shownSeparator = true;
        }
        if (entry.inOrder !== false) shownInOrder = true;

        var name = entry.name || '未命名条目';
        var content = String(entry.content || '');
        var card = document.createElement('div');
        card.className = 'fr-prose-card';
        card.dataset.enabled = String(entry.enabled);
        card.dataset.hostSlot = String(entry.hostSlot);

        var head = document.createElement('div');
        head.className = 'fr-prose-card-head';
        var identity = document.createElement('div');
        var nameEl = document.createElement('span');
        nameEl.className = 'fr-prose-card-name';
        nameEl.textContent = name;
        identity.appendChild(nameEl);

        var meta = document.createElement('div');
        meta.className = 'fr-prose-card-meta';
        var badgeText = '';
        var badgeHint = '';
        if (entry.hostSlot) {
          badgeText = '酒馆槽位';
          badgeHint = entry.hostNote;
        } else if (entry.inOrder === false) {
          badgeText = '不在酒馆发送序列';
          badgeHint = '酒馆不会发送此条目。在独立端开启后可参与生成。';
        } else if (entry.macroOnly) {
          badgeText = '纯宏定义';
          badgeHint = '此条目设置供后续条目读取的变量。';
        }
        if (badgeText) {
          var badge = document.createElement('span');
          badge.className = 'fr-prose-card-badge';
          badge.textContent = badgeText;
          badge.title = badgeHint;
          meta.appendChild(badge);
        }
        var count = document.createElement('span');
        count.textContent = humanLen(content.length) + ' 字符';
        meta.appendChild(count);
        identity.appendChild(meta);

        var tools = document.createElement('div');
        tools.className = 'fr-prose-card-tools';
        tools.appendChild(entryAction('↑', '上移', name, function () { moveInline(entry.id, -1); }));
        tools.appendChild(entryAction('↓', '下移', name, function () { moveInline(entry.id, 1); }));
        tools.appendChild(entryAction('编辑', '编辑', name, function () { openInlineEditor(entry.id); }));
        tools.appendChild(entryAction('删除', '删除', name, function () { deleteInline(entry.id, name); }));
        tools.appendChild(makeSwitch(name, entry.enabled, function (on) {
          if (!window.frProseEntrySetEnabled(entry.id, on)) return;
          card.dataset.enabled = String(on);
          updateInlineStats();
        }));
        head.appendChild(identity);
        head.appendChild(tools);
        card.appendChild(head);

        var display = content.trim();
        var lines = display.split(/\r?\n/, 4);
        if (display.length > 120 || lines.length > 3) {
          var preview = document.createElement('details');
          preview.className = 'fr-prose-card-preview';
          var summary = document.createElement('summary');
          summary.setAttribute('aria-label', '切换全文：' + name);
          var sample = document.createElement('span');
          sample.className = 'fr-prose-card-preview-sample';
          sample.textContent = Array.from(lines.slice(0, 3).join('\n')).slice(0, 120).join('') + '…';
          var collapse = document.createElement('span');
          collapse.className = 'fr-prose-card-preview-collapse';
          collapse.textContent = '收起全文';
          summary.appendChild(sample);
          summary.appendChild(collapse);
          var body = document.createElement('div');
          body.className = 'fr-prose-card-preview-body';
          body.textContent = display;
          preview.appendChild(summary);
          preview.appendChild(body);
          card.appendChild(preview);
        } else {
          var shortPreview = document.createElement('p');
          shortPreview.className = 'fr-prose-card-preview';
          shortPreview.textContent = display || '（空内容）';
          card.appendChild(shortPreview);
        }

        if (entry.hostSlot && entry.hostNote) {
          var note = document.createElement('p');
          note.className = 'fr-prose-card-note';
          note.textContent = '独立端不需要：' + entry.hostNote;
          card.appendChild(note);
        }
        box.appendChild(card);
      });

      updateInlineStats();
    }

    function updateInlineStats() {
      var el = document.getElementById('prose-preset-stats');
      if (!el) return;
      var p = activePreset();
      var entries = p ? (p.entries || []) : [];
      var on = entries.filter(function (e) { return e.enabled !== false && String(e.content || '').trim(); });
      var chars = on.reduce(function (n, e) { return n + String(e.content || '').length; }, 0);
      var hostN = entries.filter(function (e) { return e.hostSlot; }).length;
      var macroN = entries.filter(function (e) { return e.macroOnly; }).length;
      el.innerHTML =
        '<div><b>' + on.length + '/' + entries.length + '</b> 个条目已启用且有内容</div>' +
        '<div>启用内容合计 <b>' + humanLen(chars) + '</b> 字符 · 条目开关即时生效</div>' +
        ((hostN || macroN)
          ? '<div>' + (macroN ? '纯宏定义 ' + macroN + ' 条' : '') +
            (macroN && hostN ? ' · ' : '') +
            (hostN ? '酒馆槽位 ' + hostN + ' 条' : '') + '</div>'
          : '');
    }

    function moveInline(id, delta) {
      var d = readAll();
      var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
      if (!p) return;
      var arr = p.entries;
      arr.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      var i = arr.findIndex(function (x) { return x.id === id; });
      var j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return;
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      arr.forEach(function (x, k) { x.order = k; });
      writeAll(d);
      renderInline();
    }

    function deleteInline(id, name) {
      if (!window.confirm('确定删除条目「' + (name || id) + '」？')) return;
      var d = readAll();
      var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
      if (!p) return;
      p.entries = (p.entries || []).filter(function (x) { return x.id !== id; });
      writeAll(d);
      renderInline();
    }

    function deleteActivePreset() {
      var d = readAll();
      var p = d.presets.find(function (preset) { return preset.id === d.activePresetId; });
      if (!p) return;
      var option = document.getElementById('fr-current-prose-preset')?.selectedOptions[0];
      var name = option?.value === p.id ? option.textContent : p.name;
      var bindings = routeBindings();
      var affectedRoutes = Object.keys(bindings).filter(function (route) { return bindings[route] === p.id; });
      var notice = affectedRoutes.length ? '\n\n绑定它的 ' + affectedRoutes.length + ' 个正文接口将改为「跟随当前正文预设」。' : '';
      if (!window.confirm('确定删除整套正文预设「' + name + '」？' + notice)) return;

      d.presets = d.presets.filter(function (preset) { return preset.id !== p.id; });
      d.activePresetId = d.presets[0]?.id || null;
      var status = document.getElementById('prose-preset-status');
      try {
        if (affectedRoutes.length) {
          var remainingBindings = {...bindings};
          affectedRoutes.forEach(function (route) { delete remainingBindings[route]; });
          localStorage.setItem(ROUTE_KEY, JSON.stringify(remainingBindings));
        }
        if (!writeAll(d)) {
          if (affectedRoutes.length) localStorage.setItem(ROUTE_KEY, JSON.stringify(bindings));
          throw new Error('无法保存正文预设');
        }
      } catch (_) {
        if (status) {
          status.textContent = '删除失败，无法保存正文预设。';
          status.style.color = '#ff9c9c';
        }
        return;
      }
      inlineQuery = '';
      var search = document.getElementById('prose-inline-search');
      if (search) search.value = '';
      window.dispatchEvent(new CustomEvent('fr:prose-presets-changed'));
      if (status) {
        status.textContent = '已删除「' + name + '」。';
        status.style.color = '#9fd08a';
      }
    }

    function openInlineEditor(id) {
      // 复用管理器的编辑器（它已经有完整的名称/内容/保存逻辑）
      if (window.FRPresetManager) {
        window.FRPresetManager.render('prose');
        var btn = document.querySelector('#prose-preset-manager-list [data-pm-edit][data-id="' + id + '"]');
        if (btn) btn.click();
        else {
          var ov = document.getElementById('prose-preset-manager-overlay');
          if (ov) ov.classList.add('visible');
        }
      }
    }

    /** 导入酒馆预设（内嵌入口用）：走同一个 importer，导入后铺进面板 */
    function importInline(text, filename) {
      var A = PM.adapters && PM.adapters.prose;
      if (!window.FRStPresetImport) return { ok: false, reason: '导入器未加载' };
      var res = A.importer ? A.importer(text, filename) : null;
      if (!res) res = { ok: false, reason: '无法识别该文件' };
      if (!res.ok) return res;

      var d = readAll();
      var name = String(filename || '导入预设').replace(/\.(json|txt|md)$/i, '');
      var now = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      /* ★★ 2026-10-31 玩家：「这里看到的条目顺序还是有问题」「我重新导入的啊，
       *   不用猜测那么多，我明确告诉你了这个顺序不对，那就是没做到位」
       *
       * 根因就在这两行：
       *   ① `order: i`  —— 把导入器辛苦算出来的 it.order **扔掉**，
       *      改成数组下标。而 res.items 的顺序是「order 内按 prompt_order 排 +
       *      order 外追加在末尾」，下标和真实 order 完全不是一回事。
       *      后果：面板按下标排序显示，看起来"本来在前面的跑到中间去了"。
       *   ② `enabled: it.enabled !== false && !!content.trim()`
       *      —— 内容为空的纯宏条目（🌸前置(别关) / 🔴游戏难度 / …共 11 条）
       *      被强制关掉。它们是后面 getvar 的数据源，关了整套规则就废了。
       *
       * 现在：**原样保留导入器给的 order 和 enabled**，一个字都不改。
       * 导入器（st-preset-import.js 的 assemble）已经严格按酒馆 prompt_order
       * 算好了每条的顺序和开关，这里再加工只会破坏它。
       */
      var entries = (res.items || []).map(function (it, i) {
        var c = String(it.content == null ? '' : it.content);
        return {
          id: 'pe-' + now + '-' + i,
          name: it.name,
          content: c,
          // 保留导入器算好的开关（纯宏条目也是 true，不能因为内容空就关掉）
          enabled: it.enabled !== false,
          role: it.role || 'system',
          // 保留导入器算好的顺序（order 内是 prompt_order 下标，order 外是 1000+）
          order: Number(it.order == null ? i : it.order),
          identifier: it.identifier || '',
          macroOnly: !!it.macroOnly,
          hostSlot: !!it.hostSlot,
          hostNote: it.hostNote || '',
          // inOrder：是否在酒馆 prompt_order 里。
          // 面板靠它区分「会发送」和「酒馆本来就不发」的条目。
          // 注意：不在 order 里 = 酒馆不发送，这是源码事实
          // （PromptManager.js:1526 getPromptCollection 只遍历 prompt_order）。
          // 但这些条目**必须留在列表里**，玩家要看到完整预设，
          // 只是需要标记清楚，否则会误以为顺序错了或漏了。
          inOrder: it.inOrder !== false,
          empty: !c.trim(),
          reason: it.reason || ''
        };
      });
      // 按 order 排好再存，保证 localStorage 里的数组本身就是正确顺序
      entries.sort(function (a, b) { return a.order - b.order; });

      var preset = {
        id: 'pset-' + now,
        name: name || '导入预设',
        entries: entries
      };
      d.presets.push(preset);
      d.activePresetId = preset.id;
      writeAll(d);
      inlineQuery = '';
      var s = document.getElementById('prose-inline-search');
      if (s) s.value = '';
      renderInline();
      try { window.dispatchEvent(new CustomEvent('fr:prose-presets-changed')); } catch (e) {}
      return res;
    }

    window.frProseInlineRender = renderInline;
    window.frProseInlineImport = importInline;

    // 绑定内嵌面板的事件（DOM 就绪后）
    function bindInline() {
      // 开箱即有：首次进入且没有条目时，自动把内置预设展开成逐条目。
      // 必须在 renderInline 之前跑，否则玩家先看到一次空面板。
      autoSeedBuiltin();
      var picker = document.getElementById('fr-current-prose-preset');
      if (picker) picker.addEventListener('change',function () {
        var d = readAll();
        if (!d.presets.some(function(p) { return p.id === picker.value; })) return;
        d.activePresetId = picker.value;
        if (writeAll(d)) window.dispatchEvent(new CustomEvent('fr:prose-presets-changed'));
      });
      var protocol = document.getElementById('fr-prose-rendering-protocol');
      if (protocol) protocol.textContent = window.frProseRenderingProtocol?.() || '';
      document.getElementById('delete-prose-inline-btn')?.addEventListener('click', deleteActivePreset);
      var search = document.getElementById('prose-inline-search');
      if (search) {
        search.addEventListener('input', function () {
          inlineQuery = search.value.trim();
          renderInline();
        });
      }
      var newBtn = document.getElementById('new-prose-entry-btn');
      if (newBtn) newBtn.addEventListener('click', function () {
        var d = readAll();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
        if (!p) {
          p = { id: 'pset-' + Date.now().toString(36), name: '我的正文预设', entries: [] };
          d.presets = [p]; d.activePresetId = p.id;
        }
        p.entries = p.entries || [];
        p.entries.push({
          id: 'pe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          name: '新条目 ' + (p.entries.length + 1),
          content: '', enabled: true, role: 'system', order: p.entries.length, empty: true
        });
        writeAll(d);
        renderInline();
      });
      var impBtn = document.getElementById('import-prose-inline-btn');
      var impInput = document.getElementById('prose-presets-import-input');
      if (impBtn && impInput) {
        impBtn.addEventListener('click', function () { impInput.click(); });
        impInput.addEventListener('change', function () {
          var f = impInput.files && impInput.files[0];
          if (!f) return;
          var r = new FileReader();
          r.onload = function () {
            var res = importInline(String(r.result || ''), f.name);
            var st = document.getElementById('prose-preset-status');
            if (st) {
              st.textContent = res.ok ? (res.note || '导入完成') : ('导入失败：' + (res.reason || '未知'));
              st.style.color = res.ok ? '#9fd08a' : '#ff9c9c';
            }
          };
          r.readAsText(f, 'utf-8');
          impInput.value = '';
        });
      }
      var expBtn = document.getElementById('export-prose-inline-btn');
      if (expBtn) expBtn.addEventListener('click', function () {
        var p = activePreset();
        if (!p) { alert('还没有预设可导出'); return; }
        var data = {
          version: '2.0', name: p.name,
          entries: (p.entries || []).map(function (e) {
            return { name: e.name, content: e.content, enabled: e.enabled !== false, role: 'system', order: e.order || 0 };
          })
        };
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (p.name || '正文预设') + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      });
      var rstBtn = document.getElementById('reset-prose-inline-btn');
      if (rstBtn) rstBtn.addEventListener('click', function () {
        if (!confirm('清空当前预设的全部条目？（预设本身保留）')) return;
        var d = readAll();
        var p = d.presets.find(function (x) { return x.id === d.activePresetId; }) || d.presets[0];
        if (p) p.entries = [];
        writeAll(d);
        renderInline();
      });

      /* 「恢复默认内置」按钮（2026-10-31 玩家：「加一个恢复默认内置的按钮」）
       *
       * 用途：玩家把条目改乱了、或者不小心「恢复至空白」之后，
       * 一键回到出厂状态 —— 顺序、开关、内容全部按内置预设重新展开一遍。
       *
       * 实现要点：
       *   · 直接复用 autoSeedBuiltin 的展开逻辑，保证和首次安装时**完全一致**
       *     （同一套 order / enabled / macroOnly / hostSlot 字段）。
       *   · 先清掉 AUTOSEED 版本标记，否则 autoSeedBuiltin 会以为"已经灌过了"直接返回。
       *   · 和「恢复至空白」一样要二次确认，避免手滑丢数据。
       */
      var restoreBtn = document.getElementById('restore-prose-inline-btn');
      if (restoreBtn) restoreBtn.addEventListener('click', function () {
        if (!confirm('恢复默认内置预设？\n\n当前预设的条目（顺序、开关、改动过的内容）都会被覆盖。')) return;
        try {
          // 清标记 → 强制 autoSeedBuiltin 重新展开一遍
          localStorage.removeItem(AUTOSEED_KEY);
          var ok = autoSeedBuiltin();
          if (!ok) {
            var st = document.getElementById('prose-preset-status');
            if (st) {
              st.textContent = '恢复失败：内置预设未加载，请重启应用后再试';
              st.style.color = '#ff9c9c';
            }
            return;
          }
          // 清搜索框，避免恢复后列表被旧关键词过滤得只剩几条
          inlineQuery = '';
          var s = document.getElementById('prose-inline-search');
          if (s) s.value = '';
          renderInline();
          var st2 = document.getElementById('prose-preset-status');
          if (st2) {
            var p2 = activePreset();
            var n = p2 ? (p2.entries || []).length : 0;
            st2.textContent = '已恢复默认内置预设：' + n + ' 个条目';
            st2.style.color = '#9fd08a';
          }
        } catch (e) {
          var st3 = document.getElementById('prose-preset-status');
          if (st3) { st3.textContent = '恢复失败：' + (e && e.message ? e.message : '未知错误'); st3.style.color = '#ff9c9c'; }
        }
      });

      renderInline();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(bindInline, 0); });
    } else {
      setTimeout(bindInline, 0);
    }
    // 管理器改了同一份数据时同步刷新
    window.addEventListener('fr:prose-presets-changed', function () {
      renderInline();
      window.__frRefreshApiEmbeds?.();
    });
  })();

  // 其他脚本想刷新某一套时用
  window.frPresetRefresh = function (key) {
    if (window.FRPresetManager) window.FRPresetManager.render(key);
  };
})();
