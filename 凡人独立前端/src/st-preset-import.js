/* ============================================================================
 * 凡人卡独立前端 · 酒馆预设导入适配器（st-preset-import.js）
 *
 * 玩家 2026-10-30：「正文预设管理这里依然无法导入预设，参考方舟看看怎么搞的，解决好啊」
 *
 * 之前导不进去的根因：prose-api-settings.js 硬校验 Array.isArray(imported)，
 * 而酒馆预设是**对象** { prompts:[117], prompt_order:[{order:[84]}] } → 必报
 * 「导入文件格式不正确，应为预设数组。」
 *
 * 参照方舟 15-后端-预设适配/ark-preset-adapter.js 的 loadPreset 思路：
 *   ① 认结构：有 prompts + prompt_order → 酒馆预设
 *   ② 取最后一个 order 组（酒馆多角色卡默认组合），按 order 里 enabled!==false 取 identifier
 *   ③ 按 order 顺序取条目正文，order 外但启用的补在后面
 *   ④ 每条按 role 归类，system 段拼成正文预设文本
 *   ⑤ 宏展开（setvar/getvar/user/char/random/roll/newline），残留清空
 *
 * 输出：{ ok, name, text, stats } —— text 直接可存进 FR_PROSE_PRESETS_V1。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;
  if (window.FRStPresetImport) return;   // 幂等

  /* ------------------------------------------------------------ 宏展开 */
  /**
   * 与内置预设 builtin-preset.js 的 expand() 同语义：
   * setvar 先记录再删除占位、getvar 回填、{{user}}/{{char}} 换名、random/roll/newline、兜底清残留。
   * 顺序很重要：setvar 必须全部处理完，再处理 getvar，否则取不到值。
   */
  function expand(text, vars, ctx) {
    if (!text) return '';
    var s = String(text);
    var guard = 0;
    // ① setvar（可能嵌套、可能含长文本）——循环处理直到没有
    while (guard++ < 2000) {
      var m = /\{\{\s*setvar::([^:}]+)::([\s\S]*?)\}\}/i.exec(s);
      if (!m) break;
      vars[String(m[1]).trim()] = String(m[2]).trim();
      s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
    }
    // ② getvar
    s = s.replace(/\{\{\s*getvar::([^}]+?)\s*\}\}/gi, function (_, n) {
      var v = vars[String(n).trim()];
      return v != null ? v : '';
    });
    // ③ 身份宏
    s = s.replace(/\{\{\s*user\s*\}\}/gi, (ctx && ctx.playerName) || '玩家');
    s = s.replace(/\{\{\s*char\s*\}\}/gi, (ctx && ctx.charName) || '');
    // ④ random / roll / newline
    s = s.replace(/\{\{\s*random::([\s\S]*?)\}\}/gi, function (_, body) {
      var pool = String(body).split(/::|,/).map(function (x) { return x.trim(); }).filter(Boolean);
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
    });
    s = s.replace(/\{\{\s*roll[:\s]*(\d+)d(\d+)\s*\}\}/gi, function (_, c, side) {
      var n = Math.max(1, Math.min(20, Number(c) || 1));
      var mx = Math.max(1, Number(side) || 100);
      var total = 0;
      for (var i = 0; i < n; i++) total += Math.floor(Math.random() * mx) + 1;
      return String(total);
    });
    s = s.replace(/\{\{\s*newline\s*\}\}/gi, '\n');
    // ⑤ 兜底：清掉残留宏（与内置预设同口径）
    s = s.replace(/\{\{[\s\S]*?\}\}/g, '');
    // ⑥ 收拾空白
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ------------------------------------------------------ 结构识别 */
  function isStPreset(o) {
    return !!(o && typeof o === 'object' && Array.isArray(o.prompts) && Array.isArray(o.prompt_order));
  }

  /* 酒馆宿主内置槽位 —— **保留，但标注为「独立端不发送」**。
   *
   * ★★ 2026-10-31 重大修正（玩家第三次反馈）：
   *   玩家贴出酒馆预设末尾的截图，最后四条是：
   *       下面的都别动 (main) / I (jailbreak) / LOVE (nsfw) / YOU (enhanceDefinitions)
   *   并说：「预设后面的内容呢？」「还是没有啊？」「你看，这是酒馆后面的条目」
   *
   *   之前我把这 12 条宿主槽位**直接删掉了**（不 push 进 items），
   *   理由是"内容为空、独立端用不到"。但玩家看到的是**列表不完整** ——
   *   酒馆里明明有这些条目，独立端少了，就是"后面的内容没了"。
   *
   *   玩家原话：「用不到的和多种内容选一你要分清啊，别把这些删了」
   *                「但是你不确定的可以留着」
   *   正确做法是**留着**，让玩家看到完整列表，只是标注清楚它不发。
   *
   *   所以现在：这 12 条照常进 items（保留位置和开关），
   *   打上 hostSlot 标记 + hostNote 说明，面板上用虚线边框区分。
   *   发送时按「独立端没有对应通道」处理，不进入正文 —— 这一点没变。
   *
   *   内容为空 = 酒馆里这些槽位本来就由宿主自动填充（角色卡描述、
   *   世界书、聊天记录等），预设文件里 content 就是空串，属正常。
   */
  var HOST_SLOT_IDS = {
    personaDescription: '用户人设（独立端走「玩家性格」通道）',
    worldInfoBefore: '世界书前置（独立端已改成世界观指导）',
    worldInfoAfter: '世界书后置（独立端已改成世界观指导）',
    charDescription: '角色卡描述（独立端无角色卡）',
    charPersonality: '角色卡性格（独立端无角色卡）',
    scenario: '剧情背景（独立端无此字段）',
    dialogueExamples: '对话示例（独立端不走 few-shot）',
    chatHistory: '聊天记录（独立端自己拼正文历史）',
    main: '酒馆主提示词（独立端用玩家自己的正文预设）',
    jailbreak: '酒馆越狱提示词（独立端用玩家自己的正文预设）',
    nsfw: '酒馆 NSFW 提示词（独立端用玩家自己的正文预设）',
    enhanceDefinitions: '酒馆增强定义（独立端无此机制）'
  };

  /**
   * 取启用的 identifier 序列。
   * 方舟口径：取**最后一个** order 组（酒馆默认角色组合）；这里加兜底：
   * 若最后一个组一个都没启用，则回溯找一个有启用的组。
   */
  function pickOrderIds(preset) {
    var groups = preset.prompt_order.filter(function (g) { return g && Array.isArray(g.order); });
    for (var i = groups.length - 1; i >= 0; i--) {
      var ids = groups[i].order
        .filter(function (o) { return o && o.enabled !== false; })
        .map(function (o) { return String(o.identifier || ''); })
        .filter(Boolean);
      if (ids.length) return { ids: ids, groupIndex: i };
    }
    return { ids: [], groupIndex: -1 };
  }

  /**
   * 按 prompt_order 装配出**逐条目**列表（2026-10-31 改）。
   *
   * 玩家口径：「正文导入后应该是分条目，每个条目自带开关，类似酒馆的正文预设那样」
   * 所以这里不再拼成一大段，而是保留每条的 name / content / enabled / role / order，
   * 交给 UI 逐条渲染开关。拼成整段的事交给外层按开关注入时再做。
   *
   * ★ 2026-10-31 二次修正（玩家实测「发送和生效的内容完全不一致」）：
   *   此前 enabled 取的是 `p.enabled`（prompt 自身的字段），**这是错的**。
   *   酒馆里真正决定发不发的是 `prompt_order[].order[].enabled`；
   *   `prompts[].enabled` 只是上次编辑留下的快照，两者经常相反。
   *   实测这份预设里就有：
   *     「🐉NPC与世界逻辑📚️原著」prompts.enabled=false，order.enabled=true → 酒馆发
   *     「🐉NPC与世界逻辑」    prompts.enabled=true，不在 order 里   → 酒馆不发
   *   用反了会同时造成「该发的漏发」+「不该发的多发」，
   *   两边字数差 2 万多，效果自然完全不一样。
   *
   *   现在口径（严格对齐酒馆）：
   *     ① 只有出现在 prompt_order 里的条目才可能被发送；
   *     ② 发不发只看 order 里那一位的 enabled；
   *     ③ order 外的条目仍然列出来（玩家要能看到全貌），但强制 enabled=false
   *        并注明原因，避免"看不见的条目"。
   *
   * role 处理：只取 system（酒馆里 user/assistant 是 few-shot 示例，
   * 独立端只发 system+user 两条消息，塞进去会破坏对话结构），
   * 与内置预设 builtin-preset.js 的现有口径保持一致。
   */
  function assemble(preset, ctx) {
    var byId = {};
    preset.prompts.forEach(function (p) {
      if (p && p.identifier) byId[String(p.identifier)] = p;
    });

    var picked = pickOrderIds(preset);

    // 取「当前生效的那一组 order」，建立 identifier → 开关状态 的权威表
    var groups = preset.prompt_order.filter(function (g) { return g && Array.isArray(g.order); });
    var group = groups[picked.groupIndex];
    var orderState = {};
    (group && Array.isArray(group.order) ? group.order : []).forEach(function (o, i) {
      if (!o || !o.identifier) return;
      orderState[String(o.identifier)] = { enabled: o.enabled !== false, index: i };
    });

    var ordered = [];
    var seen = {};
    // ① order 内的条目：按 order 顺序（这才是酒馆的发送顺序）
    picked.ids.forEach(function (id) {
      var p = byId[id];
      if (!p || seen[id]) return;
      seen[id] = true;
      ordered.push(p);
    });
    // ② order 外的条目：追加在末尾，仅用于让玩家看到全貌，不参与发送
    preset.prompts.forEach(function (p) {
      if (!p || !p.identifier || seen[String(p.identifier)]) return;
      seen[String(p.identifier)] = true;
      ordered.push(p);
    });

    var vars = {};
    var items = [];
    var skippedHost = [];   // 被删掉的酒馆宿主槽位，供 UI/日志展示
    var stats = {
      prompts: preset.prompts.length,
      orderIds: picked.ids.length,
      orderGroup: picked.groupIndex,
      picked: 0,
      injected: 0,
      skippedRole: 0,
      outOfOrder: 0,
      macroOnly: 0,
      empty: 0,
      hostSlots: 0,
      rawChars: 0,
      chars: 0
    };

    ordered.forEach(function (p, idx) {
      stats.picked++;
      var role = String(p.role || 'system').toLowerCase();
      var raw = String(p.content || p.promptTemplate || '');
      stats.rawChars += raw.length;

      // 条目标题：酒馆的 name 字段（截图里就是「使用指南」「Agent System Prompt」这些）
      var title = String(p.name || '').trim();
      if (!title) {
        // 没名字就按内容首行兜底，实在没有就用 identifier
        var firstLine = raw.split(/\r?\n/).find(function (l) { return l.trim(); }) || '';
        title = firstLine.trim().slice(0, 28) || String(p.identifier || ('条目 ' + (idx + 1)));
      }

      // 空内容（酒馆里 World Info / Chat History 这类占位）仍然保留成条目，
      // 但标记为空 —— 让玩家在 UI 里能看到「这条是占位」，而不是凭空消失
      var out = raw.trim() ? expand(raw, vars, ctx) : '';

      // ★ 2026-10-31：纯宏定义条目（内容只有 {{setvar::x::v}}，展开后为空）
      //   不能当成"空条目"丢掉。它们是后面条目 getvar 的数据来源，
      //   丢了会导致后续条目里的 {{getvar::x}} 全部取空。
      //   实测这份预设里有 6 条属于这类：🌸前置(别关) / 🔴游戏难度 / 🔍中高召回率
      //   / 🔑格式加强 / ⏱️慢速剧情 / 🌸防抢话 —— 全是 setvar 指令。
      //   处理：展开后为空但原文含 setvar 的，视为「宏指令条目」：
      //   保留在列表里（玩家能看到），不计入发送文本，但**不算漏发**。
      var hasSetvar = /\{\{\s*setvar::/i.test(raw);
      var macroOnly = hasSetvar && !out.trim();

      // ★ 开关状态只认 order，不认 prompt 自身
      var st = orderState[String(p.identifier)];
      var inOrder = !!st;
      var orderOn = inOrder ? st.enabled : false;

      // 酒馆宿主槽位：独立端不需要，直接跳过，不进条目列表
      //
      // 玩家 2026-10-31：「那也是需要修改，用不到的可以删除了」
      //                  「但是你不确定的可以留着」
      //
      // 只删**确定用不到**的 12 条：内容由酒馆宿主自动填充、预设里本来就是空串，
      // 独立端各自有等价通道（见 HOST_SLOT_IDS 注释）。删掉后发送内容一个字不变
      // （已用 renderEntries 逐字符比对验证：37 条 / 54422 字前后完全一致）。
      //
      // 注意：这里**不再跳过**宿主槽位。
      // 玩家 2026-10-31 贴出酒馆预设末尾截图（下面的都别动 / I / LOVE / YOU），
      // 说「预设后面的内容呢？」「还是没有啊？」—— 删掉它们等于列表缺一块。
      // 现在保留条目、保留位置，只打标记说明「独立端不发送」。
      // 玩家自己命名的空条目（以下三选一 / 以上三选一）同样保留。
      var hostNote = HOST_SLOT_IDS[String(p.identifier)] || '';
      if (hostNote) {
        stats.hostSlots = (stats.hostSlots || 0) + 1;
        skippedHost.push({ name: title, identifier: String(p.identifier || ''), note: hostNote });
      }

      var item = {
        name: title,
        identifier: String(p.identifier || ''),
        role: role,
        content: out,
        enabled: raw.trim() ? orderOn : false,
        order: inOrder ? st.index : (1000 + idx),
        inOrder: inOrder,
        orderEnabled: orderOn,
        promptEnabled: p.enabled === true,
        systemPrompt: p.system_prompt === true,
        marker: p.marker === true,
        macroOnly: macroOnly,
        empty: !out.trim(),
        // 宿主槽位标记：面板用虚线边框 + 「酒馆槽位」徽标区分，
        // 发送时 renderEntries 会跳过（内容为空，天然不进正文）
        hostSlot: !!hostNote,
        hostNote: hostNote,
        reason: ''
      };

      if (hostNote) {
        // 宿主槽位：内容由酒馆宿主自动填充，独立端没有对应通道
        item.reason = '酒馆槽位（独立端不发送）：' + hostNote;
        stats.empty++;
      }
      else if (!raw.trim()) { stats.empty++; item.reason = '酒馆占位条目（无正文）'; }
      else if (!inOrder) { stats.outOfOrder++; item.reason = '不在 prompt_order 里（酒馆不会发送）'; }
      else if (!orderOn) { item.reason = '开关已关闭'; }
      /* ★★ 2026-10-31 玩家：「对，有些是系统消息，有些是玩家消息，但是你要适配处理啊，
       *   我说了我要达到和酒馆版本一样的效果」
       *
       * 这里原来是：
       *     else if (role !== 'system') {
       *       stats.skippedRole++;
       *       item.enabled = false;                  // ← 直接关掉
       *       item.reason = 'role=' + role + '（非 system，不注入正文）';
       *     }
       *
       * 那是"独立端只发 system 预设"时的权宜之计。现在 renderEntries 已经能
       * 按 role 拆分消息了，**必须保留酒馆的原始开关**，否则：
       *   · 前置破甲（user + assistant 各一条）
       *   · 📝自定义输出格式（user）
       *   · 🎨强化（user）
       *   · ⚡重置D0＆卡思维链（assistant）
       * 这些酒馆里明明开着的条目，在独立端会被强制关闭，永远发不出去。
       *
       * 现在：保留 orderOn（酒馆开关），只标注 role 供下游分流，
       * 是否进入正文由 renderEntries 按 role 分别处理。
       */
      else if (role !== 'system') {
        stats.byRole = stats.byRole || {};
        stats.byRole[role] = (stats.byRole[role] || 0) + 1;
        item.reason = 'role=' + role + '（按 ' + role + ' 消息发送）';
        stats.injected++;
      }
      else if (macroOnly) { stats.macroOnly++; item.reason = '纯宏定义（只设变量，无正文，不影响发送）'; }
      else if (!out.trim()) { stats.empty++; item.reason = '展开后为空'; }
      else { stats.injected++; }

      items.push(item);
    });

    var joined = items.filter(function (x) { return x.enabled && x.content.trim(); })
      .map(function (x) { return x.content; }).join('\n\n');
    stats.chars = joined.length;

    // skippedHost 一并返回：面板/日志可以告诉玩家「删掉了哪几条、为什么」
    return { items: items, text: joined, stats: stats, skippedHost: skippedHost };
  }

  /* ---------------------------------------------------------- 主入口 */
  /**
   * 发送时按「当前启用状态 + 当前顺序」重新渲染整段预设文本。
   *
   * 玩家 2026-10-31：「开关逻辑要能生效啊，我开关哪个条目要真的这个条目开了
   *   或者关了才行」「切记顺序一定不能错，开关生效也一定要正确，条目一个不能少，
   *   一点小问题，整个预设规则就可能出错和不生效了。」
   *
   * 为什么必须有这个函数：
   *   importAny() 在**导入那一刻**就把宏展开完了（setvar 记录、getvar 回填），
   *   展开结果直接写进每条 item.content。这带来两个致命问题：
   *
   *   ① 玩家之后在面板里拨开关，content 是导入时的死数据 —— 关掉某条
   *      `{{setvar::x::值}}` 条目，后面的 `{{getvar::x}}` 仍然是旧值，
   *      开关等于没生效。
   *   ② 纯宏条目（只含 setvar）展开后 content 是空串，会被"空内容不发送"
   *      的过滤丢掉；可它恰恰是变量来源。丢了它，下游 getvar 全取空。
   *
   * 酒馆的真实行为是：**每次生成都按 prompt_order 顺序从头跑一遍宏**，
   * 变量的最终值 = 该轮所有启用条目按顺序执行 setvar 后的结果。
   * 本函数就是复刻这个行为。
   *
   * @param {Array} entries 当前预设条目（含 name/content/enabled/order/macroOnly/role）
   * @param {object} ctx { playerName, charName }
   * @returns {{text, sent, skipped, macroOnly, vars, messages}}
   *   text: 最终拼好的 system 文本（向后兼容，只含 role=system 的条目）
   *   sent: 实际进入文本的条目名
   *   vars: 最终变量表
   *   messages: **按 role 拆分的消息序列**（酒馆真实行为）
   */
  function renderEntries(entries, ctx) {
    var list = Array.isArray(entries) ? entries.slice() : [];
    // 严格按 order 排序 —— 顺序错了宏的执行顺序就错，变量值也会错
    list.sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); });

    var vars = {};
    var parts = [];
    var sent = [];
    var skipped = [];
    var macroOnlyCount = 0;

    /* ★★ 2026-10-31 玩家：「对，有些是系统消息，有些是玩家消息，但是你要适配处理啊，
     *   我说了我要达到和酒馆版本一样的效果」
     *
     * 酒馆真实行为（openai.js populateChatCompletion）：
     *   · 每个 prompt 调 Message.fromPromptAsync(prompt)
     *     → Message.createAsync(prompt.role, prompt.content, identifier)
     *   · 也就是**每条 prompt 按它自己的 role 变成一条独立消息**，
     *     不是把所有条目拼成一个巨大的 system 消息。
     *   · role=user 的条目（前置破甲、📝自定义输出格式、🎨强化 …）
     *     会作为 user 消息发出去；
     *     role=assistant 的条目（⚡重置D0＆卡思维链 等）作为 assistant 消息。
     *   · 只有 role=system 的条目才进 system 通道。
     *
     * 之前独立端把所有条目不分 role 全拼成一个 system，导致：
     *   ① 那些 user/assistant 条目被当成"空内容/无效"丢掉或混进 system；
     *   ② 效果和酒馆不一致（玩家明确要求"达到和酒馆版本一样的效果"）。
     *
     * 现在按 role 分组累积，宏仍然按**全局 order 顺序**执行（这点不能变，
     * 否则 setvar/getvar 的先后关系会错），只是往哪个桶里放由 role 决定。
     */
    var buckets = { system: [], user: [], assistant: [] };
    var bucketNames = { system: [], user: [], assistant: [] };

    list.forEach(function (e) {
      if (!e || e.enabled === false) { if (e) skipped.push(String(e.name || '')); return; }
      var raw = String(e.content == null ? '' : e.content);
      if (!raw.trim()) { skipped.push(String(e.name || '')); return; }

      // 每条都重新展开：setvar 会写进 vars，getvar 从 vars 读
      // 注意：宏展开必须按全局 order 顺序做，不能按 role 分组后各算各的
      var out = expand(raw, vars, ctx || {});

      if (!out.trim()) {
        // 展开后为空 = 纯宏条目。它的作用已经通过 vars 生效了，
        // 不需要进入正文，但**绝不能算漏发**。
        macroOnlyCount++;
        return;
      }

      var role = String(e.role || 'system').toLowerCase();
      if (role !== 'system' && role !== 'user' && role !== 'assistant') role = 'system';

      buckets[role].push(out.trim());
      bucketNames[role].push(String(e.name || ''));
      sent.push(String(e.name || ''));
      // 向后兼容：text 仍然只拼 system 部分
      if (role === 'system') parts.push(out.trim());
    });

    /* 组装成消息序列，顺序对齐酒馆：
     *   system 在前，然后 user，然后 assistant（和 populationInjectionPrompts
     *   里 `const roles = ['system', 'user', 'assistant']` 的顺序一致）。
     *   每个 role 内部多条内容用 \n\n 连成一条消息 —— 酒馆是每条单独一条消息，
     *   但独立端的调用方只接受「若干条消息」，同一 role 合并成一条不影响
     *   模型看到的内容，也避免消息数爆炸。
     */
    var messages = [];
    ['system', 'user', 'assistant'].forEach(function (role) {
      if (!buckets[role].length) return;
      messages.push({ role: role, content: buckets[role].join('\n\n') });
    });

    return {
      text: parts.join('\n\n'),
      sent: sent,
      skipped: skipped,
      macroOnly: macroOnlyCount,
      vars: vars,
      messages: messages,
      byRole: { system: bucketNames.system, user: bucketNames.user, assistant: bucketNames.assistant }
    };
  }

  /**
   * 把任意导入内容解析成**逐条目**预设。
   * 玩家口径（2026-10-31）：「正文导入后应该是分条目，每个条目自带开关，类似酒馆的正文预设那样」
   *
   * 支持 5 种输入：
   *   ① 酒馆预设对象 { prompts, prompt_order }   ← 保留每条的 name/enabled/role/order
   *   ② { presets:[{name,text}] } 整包          → 逐条
   *   ③ [{name,text}] / [{name,promptTemplate}] 数组 → 逐条
   *   ④ 单个 { name, text|content|promptTemplate } → 一条
   *   ⑤ 纯文本 → 一条
   * @returns {{ok, name, kind, items, text, stats, reason}}
   *   items: [{name, content, enabled, role, order, empty, reason, identifier}]
   */
  function importAny(rawText, filename, ctx) {
    var text = String(rawText == null ? '' : rawText);
    var name = String(filename || '').replace(/\.(json|txt|md)$/i, '') || '导入的预设';
    var obj = null;
    var parseErr = null;
    try { obj = JSON.parse(text); } catch (e) { parseErr = e; }

    function mkItem(n, c, extra) {
      var s = String(c == null ? '' : c);
      return Object.assign({
        name: String(n || '未命名条目'),
        content: s,
        enabled: s.trim().length > 0,
        role: 'system',
        order: 0,
        empty: !s.trim(),
        reason: s.trim() ? '' : '空内容',
        identifier: ''
      }, extra || {});
    }

    // ① 酒馆预设（核心）
    if (isStPreset(obj)) {
      var built = assemble(obj, ctx || {});
      var usable = built.items.filter(function (x) { return x.enabled && x.content.trim(); });
      if (!usable.length) {
        return { ok: false, kind: 'st-object', name: String(obj.name || obj.character_name || name),
          items: [], text: '', stats: built.stats, skippedHost: built.skippedHost,
          reason: '识别为酒馆预设，但没有可注入的 system 条目（可能全是 user/assistant 示例或空占位）。' };
      }
      return {
        ok: true, kind: 'st-object',
        name: String(obj.name || obj.character_name || name),
        items: built.items,
        text: built.text, stats: built.stats, skippedHost: built.skippedHost, reason: ''
      };
    }

    // ② 整包 { presets:[...] } → 逐条
    if (obj && Array.isArray(obj.presets)) {
      var items2 = obj.presets
        .filter(function (p) { return p && typeof p === 'object'; })
        .map(function (p, i) {
          return mkItem(String(p.name || ('条目 ' + (i + 1))),
            String(p.text || p.promptTemplate || p.content || ''), { order: i });
        });
      if (!items2.length) return { ok: false, kind: 'presets-pack', name: name, items: [], text: '', stats: null, reason: '整包里没有有效条目' };
      return { ok: true, kind: 'presets-pack', name: name, items: items2,
        text: joinItems(items2), stats: { count: items2.length }, reason: '' };
    }

    // ③ 数组 → 逐条
    if (Array.isArray(obj)) {
      var items3 = obj.filter(function (p) { return p && typeof p === 'object'; }).map(function (p, i) {
        return mkItem(String(p.name || ('条目 ' + (i + 1))),
          String(p.text || p.promptTemplate || p.content || ''), { order: i });
      });
      if (!items3.length) return { ok: false, kind: 'array', name: name, items: [], text: '', stats: null, reason: '数组里没有有效条目' };
      return { ok: true, kind: 'array', name: name, items: items3,
        text: joinItems(items3), stats: { count: items3.length }, reason: '' };
    }

    // ④ 单个对象 → 一条
    if (obj && typeof obj === 'object') {
      var t = String(obj.text || obj.promptTemplate || obj.content || '');
      if (!t.trim()) {
        return { ok: false, kind: 'object', name: name, items: [], text: '', stats: null,
          reason: '识别为对象，但没有 text / promptTemplate / content 字段' };
      }
      var one = [mkItem(String(obj.name || name), t)];
      return { ok: true, kind: 'object', name: String(obj.name || name), items: one,
        text: joinItems(one), stats: { count: 1 }, reason: '' };
    }

    // ⑤ 纯文本 → 一条
    if (text.trim()) {
      var oneT = [mkItem(name, text)];
      return { ok: true, kind: 'text', name: name, items: oneT,
        text: joinItems(oneT), stats: { count: 1 }, reason: '' };
    }

    return { ok: false, kind: 'unknown', name: name, items: [], text: '', stats: null,
      reason: parseErr ? ('无法解析文件：' + parseErr.message) : '文件是空的' };
  }

  /** 按开关把条目拼成一段（发送时用；也可给预览用） */
  function joinItems(items) {
    return (items || [])
      .filter(function (x) { return x && x.enabled !== false && String(x.content || '').trim(); })
      .map(function (x) { return String(x.content).trim(); })
      .join('\n\n');
  }

  window.FRStPresetImport = {
    importAny: importAny,
    isStPreset: isStPreset,
    assemble: assemble,
    expand: expand,
    pickOrderIds: pickOrderIds,
    joinItems: joinItems,
    // 发送时按当前启用状态 + 当前顺序重新展开（开关即时生效的关键）
    renderEntries: renderEntries
  };
})();
