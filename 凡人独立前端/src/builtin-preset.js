/* ============================================================================
 * 凡人卡独立前端 · 内置预设与正则（builtin-preset.js）
 *
 * 内置三样，玩家不用自己找、自己导：
 *   ① 正文预设：gemini 万物有灵内置预设
 *   ② 正文正则：万物有灵适配正文正则（199 条常规 + 1 条思维链）
 *   ③ 世界书：万物有灵世界书 1.4（凡人定制版）
 *
 * 做法（对齐方舟）：整包导入，不做逐条翻译。
 *   卡本身没有「前置协议」这一层，所以预设包里的 system prompt 直接按原顺序
 *   整段拼进 system 消息就是最终效果，不需要另做一套预设引擎。
 *
 * 唯一必须处理的：少量 ST 宏。
 *   实测启用中的 44 条里只有 12 条带宏：
 *     {{user}} ×10  → 玩家名
 *     {{setvar::x:: v}} / {{getvar::x}}  约 10 处 → 变量占位
 *   这几个不处理就会被原样喂给模型（模型会当成待填模板，越写越乱）。
 *   其余认不出的宏直接删掉——宁可少半句，也不要留 `{{...}}` 在提示词里。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;

  var BUILTIN_PRESET = window.__FR_BUILTIN_PRESET__ || null;
  var BUILTIN_REGEX = window.__FR_BUILTIN_REGEX__ || null;

  var REGEX_APPLIED_KEY = 'FR_BUILTIN_REGEX_APPLIED_V1';

  // ---- 最小必要的宏处理 ---------------------------------------------------
  function expand(text, vars, ctx) {
    if (!text) return '';
    var s = String(text);
    var guard = 0;

    // {{setvar::name:: value}} —— 记下来并从文本抹掉，供后面 getvar 引用
    while (guard++ < 500) {
      var m = /\{\{\s*setvar::([^:}]+)::([\s\S]*?)\}\}/i.exec(s);
      if (!m) break;
      vars[String(m[1]).trim()] = String(m[2]).trim();
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
    }

    // {{getvar::name}}
    s = s.replace(/\{\{\s*getvar::([^}]+?)\s*\}\}/gi, function (_, n) {
      var v = vars[String(n).trim()];
      return v != null ? v : '';
    });

    // 玩家名 / 角色名
    s = s.replace(/\{\{\s*user\s*\}\}/gi, ctx.playerName || '玩家');
    s = s.replace(/\{\{\s*char\s*\}\}/gi, ctx.charName || '');

    // {{random::a,b,c}}
    s = s.replace(/\{\{\s*random::([\s\S]*?)\}\}/gi, function (_, body) {
      var parts = String(body).split(/::|,/).map(function (x) { return x.trim(); }).filter(Boolean);
      return parts.length ? parts[Math.floor(Math.random() * parts.length)] : '';
    });

    // {{roll 1dN}}
    s = s.replace(/\{\{\s*roll[:\s]*(\d+)d(\d+)\s*\}\}/gi, function (_, cnt, sides) {
      var t = 0, n = Math.max(1, Math.min(20, Number(cnt) || 1)), mx = Math.max(1, Number(sides) || 100);
      for (var i = 0; i < n; i++) t += Math.floor(Math.random() * mx) + 1;
      return String(t);
    });

    s = s.replace(/\{\{\s*newline\s*\}\}/gi, '\n');

    // 兜底：认不出的宏一律清空
    s = s.replace(/\{\{[\s\S]*?\}\}/g, '');

    // 收拾多余空行
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function cfg() {
    try {
      if (window.FRStandaloneConfig && typeof window.FRStandaloneConfig.load === 'function') {
        return window.FRStandaloneConfig.load();
      }
    } catch (e) {}
    return {};
  }

  // ---- 预设整包展开 -------------------------------------------------------
  var cache = null;

  function buildPresetText() {
    if (cache != null) return cache;
    if (!BUILTIN_PRESET || !Array.isArray(BUILTIN_PRESET.prompts)) { cache = ''; return cache; }

    var c = cfg();
    var ctx = {
      playerName: String(c.playerName || '玩家'),
      charName: String(c.characterName || '')
    };

    // 启用状态**只认 prompt_order**（酒馆权威口径）。
    // 2026-10-31 修正：此前 isOn() 在 order 里找不到时会回退到 p.enabled，
    // 导致「不在 order 里但 prompts.enabled=true」的条目被发出去（多发了
    // ⚔️战斗系统 7117 字、🐉NPC与世界逻辑 6569 字等 8 条共 2 万多字），
    // 同时 order 里 enabled=true 但 prompts.enabled=false 的条目（如
    // 思维链📚️(原著) 15333 字）反而被漏掉。玩家实测「发送和生效的内容
    // 完全不一致」，根因就在这里。现在严格对齐酒馆：order 里没有 = 不发。
    var orderEnabled = null;
    try {
      var o = BUILTIN_PRESET.prompt_order;
      if (Array.isArray(o) && o.length && Array.isArray(o[0] && o[0].order)) {
        orderEnabled = {};
        o[0].order.forEach(function (r) { orderEnabled[r.identifier] = r.enabled === true; });
      }
    } catch (e) {}

    var byId = {};
    (BUILTIN_PRESET.prompts || []).forEach(function (p) {
      if (p && p.identifier) byId[p.identifier] = p;
    });

    function isOn(p) {
      // 有 order 时严格按 order；order 里没有这条 = 酒馆不会发 = 不发。
      // 没有 order 的极端情况下才退回 prompt 自身字段。
      if (orderEnabled) return orderEnabled[p.identifier] === true;
      return p.enabled === true;
    }

    // 按 prompt_order 顺序取；order 外但启用的接在后面
    var picked = [], seen = {};
    if (orderEnabled) {
      (BUILTIN_PRESET.prompt_order[0].order || []).forEach(function (r) {
        var p = byId[r.identifier];
        if (!p || seen[p.identifier]) return;
        seen[p.identifier] = true;
        if (isOn(p)) picked.push(p);
      });
    }
    (BUILTIN_PRESET.prompts || []).forEach(function (p) {
      if (!p || seen[p.identifier]) return;
      if (isOn(p)) picked.push(p);
    });

    var vars = {}, blocks = [];
    picked.forEach(function (p) {
      if (['prompt_1764837454104_zdms0so','c3aff14f-fcce-4e05-818c-8b1ed8da963b'].includes(p.identifier)) return;
      var raw = String(p.content || '');
      if (!raw.trim()) return;
      // 只取 system 角色的；user/assistant 示例塞进系统提示会让模型把示例当对话，容易跑偏
      if (p.role && String(p.role) !== 'system') return;
      var t = expand(raw, vars, ctx);
      if (t) blocks.push(t);
    });

    // =======================================================================
    // 2026-10-31：把酒馆宿主的注入槽位在这里复刻。
    // -----------------------------------------------------------------------
    // 依据本机酒馆源码（权威）：
    //   public/scripts/world-info.js  convertCharacterBook()
    //       position: entry.extensions?.position ??
    //                 (entry.position === 'before_char' ? world_info_position.before
    //                                                   : world_info_position.after)
    //   public/scripts/openai.js      populateChatCompletion()  L1112-1120
    //       await addToChatCompletion('worldInfoBefore');
    //       await addToChatCompletion('main');
    //       await addToChatCompletion('worldInfoAfter');
    //       await addToChatCompletion('charDescription');
    //       await addToChatCompletion('charPersonality');
    //       await addToChatCompletion('scenario');
    //       await addToChatCompletion('personaDescription');
    //
    // 即两条硬事实：
    //   ① 卡内 character_book 里 position=before_char 的条目 → 填进 preset 的
    //      worldInfoBefore 槽位；after_char → 填进 worldInfoAfter 槽位。
    //      （这两条都 constant:true，所以每轮必进，不受关键词影响）
    //   ② 这些槽位在 preset 里的位置是固定的（本卡 order#34 与 order#38），
    //      不能简单地把它们前置/后置到整段之外 —— 那样「📦修炼与因果系统」
    //      等条目就会跑到世界书前面，与酒馆不一致。
    //
    // 所以这里改成：**按槽位就地填充**，而不是在整段文本前后拼接。
    // =======================================================================
    function buildCardBookSlots() {
      var out = { before: [], after: [] };
      var cardBook = window.__FR_CARD_BOOK__;
      if (!Array.isArray(cardBook) || !cardBook.length) return out;
      // 酒馆的排序规则（world-info.js:88）：const sortFn = (a, b) => b.order - a.order;
      // order 即 character_book 的 insertion_order，**降序**排列。
      var mapped = cardBook
        .filter(function (e) { return e && e.disable !== true && String(e.content || '').trim(); })
        .map(function (e) {
          return {
            order: Number(e.order == null ? 0 : e.order) || 0,
            position: String(e.position || 'before_char'),
            text: expand(String(e.content || ''), {}, ctx).trim()
          };
        })
        .filter(function (e) { return e.text; })
        .sort(function (a, b) { return b.order - a.order; });
      mapped.forEach(function (e) {
        if (e.position === 'after_char') out.after.push(e.text);
        else out.before.push(e.text);
      });
      return out;
    }

    var slotText = buildCardBookSlots();

    // 占位符槽位 → 该填什么（None 表示本卡该槽位上游本来就没有内容）
    var card = window.__FR_CARD__ || {};
    var placeholders = {
      // ★ 世界书槽位：由卡内 character_book 填充（酒馆里就是这两处）
      worldInfoBefore: slotText.before.join('\n\n'),
      worldInfoAfter: slotText.after.join('\n\n'),
      // ○ 角色卡字段槽位：本卡 description/personality/scenario 本来就是空的，
      //   设定全在预设条目里，所以这里通常为空 —— 保持原样即为「与酒馆一致」。
      charDescription: String(card.description || ''),
      charPersonality: String(card.personality || ''),
      scenario: String(card.scenario || ''),
      dialogueExamples: String(card.mes_example || ''),
      personaDescription: ''
    };

    // 按 prompt_order 顺序逐条装配；空 content 的槽位就地替换为实际内容。
    if (orderEnabled) {
      var seq = [];
      var filled = 0;
      (BUILTIN_PRESET.prompt_order[0].order || []).forEach(function (r) {
        var p = byId[r.identifier];
        if (!p || !isOn(p)) return;
        if (p.role && String(p.role) !== 'system') return;
        var raw = String(p.content || '');
        if (raw.trim()) { seq.push(expand(raw, {}, ctx)); return; }
        var ph = placeholders[r.identifier];
        if (ph && ph.trim()) { seq.push(ph.trim()); filled++; }
      });
      // 命中槽位就用这条装配结果（这是酒馆的真实顺序）
      if (filled > 0) {
        cache = seq.filter(Boolean).join('\n\n---\n\n');
        return cache;
      }
    }

    // 没有 prompt_order 或没有槽位可填时的兜底：保持历史行为
    cache = blocks.join('\n\n---\n\n');
    return cache;
  }

  // ---- 对外接口 -----------------------------------------------------------
  window.frBuiltinPresetText = function () { return buildPresetText(); };

  window.frBuiltinPresetInfo = function () {
    var t = buildPresetText();
    var arr = (BUILTIN_PRESET && Array.isArray(BUILTIN_PRESET.prompts)) ? BUILTIN_PRESET.prompts : [];
    var enabled = arr.filter(function (p) { return p && p.enabled === true; }).length;
    return {
      sourceName: 'gemini 万物有灵内置预设',
      promptCount: arr.length,
      enabledCount: enabled,
      textLength: t.length,
      bytes: Math.round(t.length / 1024),
      preview: t.slice(0, 180)
    };
  };

  window.frBuiltinRegexConfig = function () {
    if (!BUILTIN_REGEX) return null;
    return JSON.parse(JSON.stringify(BUILTIN_REGEX));
  };

  window.frBuiltinRegexInfo = function () {
    if (!BUILTIN_REGEX) return { rules: 0, chainRules: 0 };
    return {
      sourceName: '万物有灵适配正文正则',
      rules: (BUILTIN_REGEX.rules || []).length,
      chainRules: (BUILTIN_REGEX.chainRules || []).length
    };
  };

  // ---- 内置正则：状态自检 --------------------------------------------------
  // 2026-10-31 修正：原先这里设了个 window.__FR_BUILTIN_REGEX_PENDING__，
  // 注释写「卡片初始化时会读取这个待应用配置（见 assemble.mjs 注入的桥）」，
  // 但那个桥**从来没有被实现**，也没有任何代码消费这个变量 —— 于是 199 条
  // 正则虽然被内联进包体，却从未真正装进卡片的 regexConfig，玩家必须在界面
  // 里手动导入才有效（玩家实际遇到的就是这个情况）。
  //
  // 现在真正的内置发生在卡片唯一初始化入口：
  //   card/src/frontend/main.js  正则初始化处（regexConfig = await dbGet(...) 之后）
  // 那里会把 window.__FR_BUILTIN_REGEX__ 的 rules / chainRules 合并进 regexConfig，
  // 且规则「玩家已导入/改过」时以玩家为准，不覆盖。
  //
  // 这里只做状态汇报，不再设无用的 PENDING 变量。
  function reportRegexState() {
    if (!BUILTIN_REGEX) return false;
    try {
      var hasBuiltin = !!(window.__FR_BUILTIN_REGEX__ &&
        Array.isArray(window.__FR_BUILTIN_REGEX__.rules) &&
        window.__FR_BUILTIN_REGEX__.rules.length);
      return hasBuiltin;
    } catch (e) { return false; }
  }

  function init() {
    var p = window.frBuiltinPresetInfo();
    var r = window.frBuiltinRegexInfo();
    var ready = reportRegexState();
    console.log('[内置] 正文预设: ' + p.sourceName + '，' + p.promptCount + ' 条（启用 ' + p.enabledCount +
      '），整包 ' + p.bytes + ' KB');
    console.log('[内置] 正文正则: ' + r.sourceName + '，' + r.rules + ' 条常规 + ' + r.chainRules + ' 条思维链' +
      (ready ? '（已随包内置，卡片初始化时自动装入）' : '（未内联，异常）'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
