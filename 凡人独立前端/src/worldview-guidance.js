// Local rule selection and storage for the main prose request.
(function () {
  'use strict';

  if (window.__FR_STANDALONE__ !== true) return;

  var RULES_KEY = 'FR_WV_RULES_V1';

  function builtinRules() {
    var d = window.__FR_WR_DEFAULT__;
    if (!d || !Array.isArray(d.rules)) return [];
    return d.rules.map(function (r) {
      return {
        id: String(r.id || ''),
        name: String(r.name || r.id || ''),
        domain: Array.isArray(r.domain) ? r.domain : [],
        enabled: r.enabled !== false,
        order: Number(r.order || 0),
        // 深度：对齐世界书「搜索深度」，0 = 全部历史
        depth: Number(r.depth == null ? 0 : r.depth),
        // 消息归属：规则统一以 system 身份注入
        role: String(r.role || 'system'),
        // 默认设定在内置索引中；自定义条目可选择常驻。
        triggerMode: String(r.triggerMode || 'blue') === 'green' ? 'green' : 'blue',
        keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [],
        content: String(r.content || ''),
        builtin: true
      };
    });
  }

  // 玩家规则：与内置合并（同 id 以玩家为准，支持玩家新增自定义规则）
  //
  // ★ 旧发布默认内容的受控升级（T-WORLD-RULES-022）
  //   问题：玩家的 FR_WV_RULES_V1 一旦写入，content 就完全盖住内置正文。
  //         只改 card/src/canon/world-rules/ 的默认资产，老玩家永远看不到新口径。
  //   约束：不能用"新默认"全量覆盖玩家数据 —— 那样玩家自己改的规则会被吞掉。
  //   做法：只认「精确等于旧发布默认」这一种情况。比对内容 sha256，
  //         命中迁移表才替换成新默认；玩家改过一个字（哈希就变）一律保留原样。
  function rulesMigrationTable() {
    const manifest = window.__FR_WR_MIGRATION__;
    return Array.isArray(manifest?.rules) ? manifest.rules : [];
  }
  function sha256Hex(s) {
    // 纯 JS 实现，避免依赖 crypto.subtle（file:// 与旧 Electron 下不可靠）
    var str = String(s == null ? '' : s);
    var utf8 = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) utf8.push(c);
      else if (c < 0x800) utf8.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0xd800 || c >= 0xe000) utf8.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else {
        i++;
        var cc = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        utf8.push(0xf0 | (cc >> 18), 0x80 | ((cc >> 12) & 0x3f), 0x80 | ((cc >> 6) & 0x3f), 0x80 | (cc & 0x3f));
      }
    }
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = utf8.length;
    utf8.push(0x80);
    while (utf8.length % 64 !== 56) utf8.push(0);
    var bitLen = len * 8;
    utf8.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
    var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    for (var off = 0; off < utf8.length; off += 64) {
      var w = new Array(64);
      for (var t = 0; t < 16; t++) {
        w[t] = (utf8[off + t * 4] << 24) | (utf8[off + t * 4 + 1] << 16) | (utf8[off + t * 4 + 2] << 8) | utf8[off + t * 4 + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], cc = H[2], dd = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ ((~e) & g);
        var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & cc) ^ (b & cc);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (dd + t1) | 0;
        dd = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + dd) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (var k = 0; k < 8; k++) hex += ('00000000' + (H[k] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  /**
   * 把旧发布默认内容升级成当前默认正文。
   * 只动 content；enabled / order / 自定义条目 / deletedIds 一律不碰。
   * @returns {number} 实际升级条数
   */
  function upgradeLegacyContents(rules, base) {
    var table = rulesMigrationTable();
    if (!table.length) return 0;
    var byId = {};
    for (var i = 0; i < table.length; i++) {
      if (table[i] && table[i].id) byId[table[i].id] = table[i];
    }
    var baseById = {};
    for (var j = 0; j < base.length; j++) {
      if (base[j] && base[j].id) baseById[base[j].id] = base[j];
    }
    var upgraded = 0;
    for (var k = 0; k < rules.length; k++) {
      var r = rules[k];
      var m = byId[r.id];
      if (!m || !m.legacySha256) continue;
      // 只升级内置规则；玩家自建的 rules[id] 若不在 base 里也不该走这条
      var b = baseById[r.id];
      if (!b) continue;
      var cur = String(r.content == null ? '' : r.content);
      if (cur === b.content) continue;              // 本来就是新默认
      if (![m.legacySha256,...(m.additionalLegacySha256||[])].includes(sha256Hex(cur))) continue; // 玩家改过 → 保留
      const previousDefaultTrigger = r.triggerMode === 'blue' && r.keywords.length === 0;
      rules[k] = {...r, content:b.content, ...(previousDefaultTrigger ? {
        triggerMode:b.triggerMode, keywords:b.keywords,
      } : {})};
      upgraded++;
    }
    return upgraded;
  }

  function rulesLoad() {
    var base = builtinRules();
    var custom;
    try { custom = JSON.parse(localStorage.getItem(RULES_KEY) || 'null'); } catch (e) { custom = null; }
    if (!custom || !Array.isArray(custom.rules)) {
      return { version: '1.0', rules: base };
    }
    var byId = {};
    base.forEach(function (r) { byId[r.id] = Object.assign({}, r); });
    custom.rules.forEach(function (r) {
      if (!r || !r.id) return;
      var prev = byId[r.id] || {};
      byId[r.id] = {
        id: String(r.id),
        name: String(r.name || r.id),
        domain: Array.isArray(r.domain) ? r.domain : [],
        enabled: r.enabled !== false,
        order: Number(r.order == null ? (prev.order == null ? 99 : prev.order) : r.order),
        // ★ 两个世界书字段必须带过来：以前这里漏了，导致绿灯规则被当成蓝灯恒注入。
        triggerMode: (r.triggerMode ?? prev.triggerMode) === 'green' ? 'green' : 'blue',
        keywords: Array.isArray(r.keywords) ? r.keywords.map(String).filter(Boolean)
          : (Array.isArray(prev.keywords) ? prev.keywords : []),
        depth: Number(r.depth == null ? (prev.depth == null ? 0 : prev.depth) : r.depth),
        role: String(r.role || prev.role || 'system'),
        content: String(r.content == null ? (prev.content == null ? '' : prev.content) : r.content),
        builtin: !!prev.builtin,
        source: r.source === 'worldbook' ? 'worldbook' : ''
      };
    });
    // 玩家显式删除的内置规则用 deletedIds 记录
    var deleted = Array.isArray(custom.deletedIds) ? custom.deletedIds : [];
    var out = Object.keys(byId).map(function (k) { return byId[k]; })
      .filter(function (r) { return deleted.indexOf(r.id) < 0; });
    // 旧发布默认内容受控升级（只认精确哈希，玩家改写不动）
    var upgraded = upgradeLegacyContents(out, base);
    out.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    return { version: '1.0', rules: out, deletedIds: deleted, upgradedCount: upgraded };
  }
  function rulesSave(d) {
    try { localStorage.setItem(RULES_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
  }
  function rulesReset() {
    try { localStorage.removeItem(RULES_KEY); return true; } catch (e) { return false; }
  }

  /**
   * 拼「本轮参与裁定的世界规则」块。
   *
   * 对齐凡人卡世界书的触发语义（玩家 2026-10-30 口径：
   * 「世界书不是无脑注入的，而是需要的条目才选择性注入的」）：
   *   · 蓝灯(blue)  = 时刻抛出，本轮的检定里始终参与
   *   · 绿灯(green) = 关键词触发，只有本轮输入/近期正文**命中 keywords** 才参与
   * depth 对齐世界书「搜索深度」：0 = 全部历史；>0 = 只看最近 N 轮。
   *
   * 命中判据取本轮上下文文本（玩家输入 + 近期正文），由调用方传入。
   * 超 maxChars 时按 order 截断并记录，绝不静默丢弃。
   *
   * @param {number} limitChars
   * @param {string} contextText 用于绿灯关键词匹配的文本（玩家输入+近期正文）
   */
  function buildRulesBlock(limitChars, contextText, options) {
    var d = rulesLoad();
    var ctx = String(contextText == null ? '' : contextText).toLowerCase();

    var candidates = d.rules.filter(function (r) {
      if (!r.enabled) return false;
      if (!String(r.content || '').trim()) return false;
      // 蓝灯：时刻参与
      if (r.triggerMode !== 'green') return true;
      // 绿灯：必须命中关键词；没设关键词的绿灯不参与（对齐卡内校验「至少一个关键词」）
      var kw = (r.keywords || []).filter(Boolean);
      if (!kw.length) return false;
      var history = options?.history || [];
      var search = options && r.source === 'worldbook'
        ? [options.userInput, ...(r.depth > 0 ? history.slice(-r.depth) : history)].join('\n').toLowerCase() : ctx;
      for (var i = 0; i < kw.length; i++) {
        if (search.indexOf(String(kw[i]).toLowerCase()) >= 0) return true;
      }
      return false;
    });

    // 按 order 排序，保证截断时优先保住靠前的规则
    candidates.sort(function (a, b) {
      return (options ? Number(b.source === 'worldbook') - Number(a.source === 'worldbook') : 0)
        || (a.order || 0) - (b.order || 0);
    });

    var limit = Number(limitChars || 60000);
    var parts = [], worldbook = [], general = [], used = 0, dropped = [], items = [];
    for (var j = 0; j < candidates.length; j++) {
      var r = candidates[j];
      var block = '### ' + r.name + '\n' + r.content.trim();
      var exceedsLimit = used + block.length > limit;
      items.push({ name: r.name, chars: r.content.length, trigger: r.triggerMode, dropped: exceedsLimit });
      if (exceedsLimit) { dropped.push(r.name); continue; }
      used += block.length;
      parts.push(block);
      (options && r.source === 'worldbook' ? worldbook : general).push(block);
    }
    return {
      text: parts.join('\n\n'),
      worldbookText: worldbook.join('\n\n'),
      generalText: general.join('\n\n'),
      count: parts.length,
      totalRules: candidates.length,
      enabledTotal: d.rules.filter(function (r) { return r.enabled && r.content.trim(); }).length,
      triggerMode: 'blue+green',
      chars: used,
      dropped: dropped,
      items: items
    };
  }

  function forProse(contextText) {
    const selected = buildRulesBlock(60000, contextText);
    const core = String(window.__FR_WR_PROSE__ || '').trim();
    if (selected.dropped.length) console.warn('[世界规则] 本轮超出容量:', selected.dropped.join('、'));
    return ['## 万物有灵·正文世界规则', core, selected.text].filter(Boolean).join('\n\n');
  }

  function upgradeProseEntry(name, content) {
    const legacy=window.__FR_WR_MIGRATION__?.prose;
    const exact=legacy?.exactBuiltins?.find(item=>item.name.trim()===name.trim());
    if(exact){
      const replacement=window.__FR_BUILTIN_PRESET__?.prompts?.find(item=>item.identifier===exact.identifier);
      const next=exact.retired?null:replacement?.content??content;
      if(exact.previousHashes?.includes(sha256Hex(content)))return next;
      // Saved ST imports expand the player name before storage. Compare the entire expanded text.
      const expand=window.FRStPresetImport?.expand;
      const marker='__FR_LEGACY_PLAYER__';
      const matched=[exact.previous,...(exact.previousRevisions||[])].some(previous=>{
        if(typeof previous!=='string')return false;
        if(content===previous)return true;
        const expanded=expand?.(previous,{}, {playerName:marker});
        if(content===expanded)return true;
        const parts=expanded?.split(marker);
        if(!parts||parts.length<2||!content.startsWith(parts[0]))return false;
        const end=content.indexOf(parts[1],parts[0].length);
        const player=end<0?'':content.slice(parts[0].length,end);
        return Boolean(player)&&parts.join(player)===content;
      });
      if(matched)return next;
      if(!exact.retired)return content;
    }
    if(!legacy?.names.includes(name))return content;
    // Match only the actual legacy paragraphs. Unrelated player edits and entry settings are retained.
    return legacy.replacements.reduce((text,[before,after])=>text.replaceAll(before,()=>after),content);
  }

  window.FRWorldRules = Object.freeze({rulesLoad, rulesSave, rulesReset, buildRulesBlock, forProse, upgradeProseEntry});

  // Independent world guidance shares the same rule data as the direct prose path.
  var CFG_KEY = 'FR_WV_CONFIG_V1';
  var PROMPT_KEY = 'FR_WV_PROMPTS_V1';

  var DEFAULTS = {
    enabled: false,
    apiUrl: '',                // 空 = 复用正文 API 配置
    apiKey: '',
    model: '',                 // 空 = 复用正文模型
    temperature: 0.3,          // 裁定要稳定，低温度
    top_p: 1,
    maxChars: 60000
  };

  /* ---------------------------------------------------------------- 存储 */
  function cfgLoad() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      var live = Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
      delete live.maxTokens;
      return typeof window.__frResolveLocalApiConfig === 'function' ? window.__frResolveLocalApiConfig(CFG_KEY, live) : live;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function cfgSave(patch) {
    var next = Object.assign(cfgLoad(), patch || {});
    try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (e) {}
    if (typeof window.__frLocalApiConfigChanged === 'function') window.__frLocalApiConfigChanged(CFG_KEY, next);
    return next;
  }

  function promptsLoad() {
    try {
      var v = JSON.parse(localStorage.getItem(PROMPT_KEY) || 'null');
      if (!v || !Array.isArray(v.presets)) return { presets: [], activePresetId: null };
      return { presets: v.presets.filter(function (p) { return p && p.name; }), activePresetId: v.activePresetId || null };
    } catch (e) { return { presets: [], activePresetId: null }; }
  }
  function promptsSave(d) {
    try { localStorage.setItem(PROMPT_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
  }


  function resolveApiConfig(config, fallback = window.FRStandaloneConfig?.load() || {}) {
    var url = String(config.apiUrl || fallback.apiUrl || '').trim().replace(/\/+$/, '');
    var route = /\/(?:models|chat\/completions)$/i;
    if (route.test(url)) url = url.replace(route, '');
    else if (url && !/\/v\d+(?:[a-z][\w.-]*)?$/i.test(url)) url += '/v1';
    return { apiUrl: url, apiKey: config.apiKey || fallback.apiKey || '', model: config.model || fallback.model || '' };
  }
  /* ------------------------------------------------------------ 提示词 */
  function activePrompt() {
    var d = promptsLoad();
    var p = d.presets.find(function (x) { return x.id === d.activePresetId; });
    // 老界面的“保存全部”会把未改的内置模板也写为自定义；只识别那份精确发布文本。
    var oldBuiltins = ['8d2b7450a58c4863aa50c5b641977927b9904119b4c2af40341dc3d1af7960f5',
      'c72cac57ed9e2b6f25b1c90488a47ad1ea56a5d0fbd9fe9fea19e229993cf840',
      'b4c497e3ce33f6b1768635a50c71abd2479c140966018daf49ae1a6c36c1699c',
      'f0baa29f1a4cbdd8c0ae96817599d6932754798bfa09e12b2227bd31726e01af',
      '70a90ac8739529709d95551c9b230d47023781ece163dc94b9ec21395e5963dc'];
    if (p && typeof p.text === 'string' && p.text.trim() && !oldBuiltins.includes(sha256Hex(p.text.replace(/\r\n/g,'\n')))) return p.text;
    // 退回内置：构建时内联 window.__FR_WV_PROMPT__
    return String(window.__FR_WV_PROMPT__ || '');
  }

  /* ------------------------------------------------- 占位符替换（核心） */
  // 输入资料由调用方（main.js）从卡内 material 通道取，键名与提示词占位符一一对应
  function fillPlaceholders(template, data, rulesText, worldbookText) {
    var t = String(template || '');
    var map = {
      '玩家输入': data.userInput,
      '既往正文': data.recentStory,
      '世界状态快照': data.stateSnapshot,
      '物品装备': data.items,
      '玩家功法': data.techniques,
      '玩家修炼效率': data.cultivation,
      '人物关系': data.relations,
      '离场人物': data.offScene,
      '命中世界书': worldbookText,
      '灵兽': data.beasts,
      '在场人物': data.onScene,
      '人物档案': data.characters,
      '任务': data.tasks,
      '世界大事': data.worldEvents,
      '世界规则': data.worldFactors,
      '地理与小地图': data.map,
      '设定集检索': data.ragVector,
      '叙事记忆': data.narrativeMemory,
      '启用的世界规则': rulesText
    };
    return t.replace(/\$\{([^}]+)\}/g, function (_, key) {
      return Object.hasOwn(map, key) ? String(map[key] ?? '').trim() || '无' : '无';
    });
  }

  /* ------------------------------------------------------ 模型请求 */
  async function requestGuidance(promptText, options) {
    var run=window.__frRunApiRoutes;
    return typeof run==='function'?run(CFG_KEY,undefined,null,route=>requestGuidanceOnce(promptText,options,route),options?.signal):
      requestGuidanceOnce(promptText,options);
  }

  async function requestGuidanceOnce(promptText, options, route) {
    var cfg = cfgLoad();
    var baseCfg = (window.FRStandaloneConfig && window.FRStandaloneConfig.load()) || {};
    var { apiUrl: url, apiKey: key, model } = resolveApiConfig(route?{...cfg,apiUrl:route.apiUrl,apiKey:route.apiKey,model:route.apiModel}:cfg,route?{}:baseCfg);
    if (!url) throw new Error('世界观指导未配置 API URL');
    if (!model) throw new Error('世界观指导未配置模型');

    var profile=route?.requestProfile;
    var payload = {
      model: model,
      messages: [{ role: 'user', content: promptText }],
      temperature: Number(cfg.temperature),
      top_p: Number(cfg.top_p),
      stream: false
    };
    var body=window.FR_CHAT_REQUEST_CORE?.['chat-request-policy']?.chatRequestBody(payload,{
      apiUrl:url,profile,purpose:'worldview'
    }) ?? payload;
    var controller = new AbortController();
    var abort = function () { controller.abort(signal.reason); };
    var signal = options?.signal;
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;
    var endpoint=window.FR_CHAT_REQUEST_CORE?.['chat-request-policy']?.chatCompletionsEndpoint(
      route?.apiUrl||cfg.apiUrl||baseCfg.apiUrl||url)??url+'/chat/completions';
    var resp = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: controller.signal });
      if (!resp.ok) throw new Error('世界观指导请求失败 HTTP ' + resp.status);
      var json = await resp.json();
      var choice = json?.choices?.[0];
      var msg = choice?.message;
      var raw = typeof msg?.content === 'string' ? msg.content : '';
      options?.onReply?.({
        rawChars: raw.length,
        reasoningChars: typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
        completionTokens: json?.usage?.completion_tokens ?? null
      });
      return raw;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async function requestProseGuidance(promptText, options) {
    const parent=options.signal;
    parent?.throwIfAborted();
    if(typeof options.showStatus!=='function')return requestGuidance(promptText,options);
    const controller=new AbortController();
    const abort=()=>controller.abort(parent.reason);
    let status;
    const clear=()=>{
      if(!status)return;
      status.aborted=true;
      if(status.parentElement!==null)status.remove();
      status=null;
    };
    parent?.addEventListener('abort',abort,{once:true});
    controller.signal.addEventListener('abort',clear,{once:true});
    try {
      try { status=options.showStatus('世界观指导 · 正在裁定',controller); } catch (_) { /* 裁定仍可继续 */ }
      controller.signal.throwIfAborted();
      const raw=await requestGuidance(promptText,{...options,signal:controller.signal});
      controller.signal.throwIfAborted();
      return raw;
    } finally {
      parent?.removeEventListener('abort',abort);
      controller.signal.removeEventListener('abort',clear);
      clear();
    }
  }

  /* ------------------------------------------------- 裁定结果后处理 */
  // 模型会先输出 <thinking>…</thinking>（COT 表），正文只要 thinking 之后的部分
  function stripThinking(raw) {
    var s = String(raw || '').trim();
    return s.replace(/<(thinking|think|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').trim();
  }

  /** 把裁定结果渲染成「带作用声明」的注入块（玩家要求：说明这段指导的作用） */
  function renderForPrompt(rawText) {
    var body = stripThinking(rawText);
    if (!body) return '';
    var head = [
      '## 本轮世界观指导（只约束世界尺度，不决定剧情胜负）',
      '',
      '下面这段是「世界观裁定器」根据本轮输入、当前存档状态和启用的世界规则算出来的。',
      '它的作用：约束本轮正文怎么写境界、称呼、经济、门派、妖兽、突破动静、移动耗时、炼制这些**世界尺度**。',
      '玩家输入决定本轮意图，存档确定现状，原著指导管节点和原著知识边界。本段只约束世界尺度与写法，不替任何一方决定行动结果。',
      ''
    ].join('\n');
    return '\n\n' + head + body + '\n';
  }

  /* ------------------------------------------------------- 主入口 */
  /**
   * 跑一次世界观指导。
   * @param {object} data 卡内资料（键名对应占位符）
   * @param {object} options { signal, log }
   * @returns {{ok, block, raw, reason, rulesInfo}}
   */
  async function run(data, options) {
    var cfg = cfgLoad();
    if (cfg.enabled !== true) {
      return { ok: false, block: '', raw: '', reason: '未启用', rulesInfo: null };
    }
    var opts = options || {};
    var turn = opts.traceTurn || traceBegin('', '', '');
    var d = data || {};

    // 绿灯关键词的命中文本 = 本轮玩家输入 + 近期正文（对齐世界书「关键词触发」的检索面）
    var hitText = [d.userInput, d.recentStory].filter(Boolean).join('\n');

    // ---------------------------------------------------------------
    // 采集记录（2026-10-31 新增，供「世界观指导」面板展示）
    //
    // 玩家要求：「世界观指导的思维链采集和结果展示也做一下…信息要归纳整理排版好」
    // 所以在 run() 里把每一步真实发生了什么记下来：
    //   · 输入资料各段各多少字（谁提供了什么）
    //   · 规则命中情况（绿灯/蓝灯、命中哪几条、各多少字、是否被 maxChars 截断）
    //   · 提示词拼装结果（模板名、占位符填充后的长度）
    //   · 模型请求与返回（耗时、原始输出长度、thinking 段长度）
    //   · 最终注入块（长度、是否成功、失败原因）
    // 只记录**摘要与长度**，不记录完整正文，避免把整份存档再复制一遍。
    // ---------------------------------------------------------------
    var trace = {
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      enabled: true,
      inputParts: [],
      rules: null,
      prompt: null,
      request: null,
      result: null
    };
    function markTrace(step, detail) {
      trace.steps = trace.steps || [];
      trace.steps.push({ step: step, at: Date.now(), detail: detail || '' });
    }

    // 输入资料：键名 → 中文名，只记长度
    var inputNames = {
      userInput: '玩家输入', recentStory: '近期正文', stateSnapshot: '世界状态快照',
      items: '玩家物品与装备', techniques: '玩家功法', cultivation: '玩家修炼效率',
      relations: '人物关系', beasts: '灵兽', onScene: '在场人物', characters: '人物档案', offScene: '离场人物索引',
      tasks: '任务记录', worldEvents: '世界大事', worldFactors: '世界背景',
      map: '地理信息', ragVector: '向量引用', narrativeMemory: '叙事记忆'
    };
    Object.keys(inputNames).forEach(function (k) {
      var v = String(d[k] == null ? '' : d[k]);
      trace.inputParts.push({ key: k, name: inputNames[k], chars: v.length, filled: !!v.trim() });
    });
    trace.inputTotal = trace.inputParts.reduce(function (a, x) { return a + x.chars; }, 0);

    try {
      markTrace('收集输入', '共 ' + trace.inputTotal + ' 字');
      var rules = buildRulesBlock(cfg.maxChars, hitText, { userInput: d.userInput, history: d.worldbookHistory });
      trace.rules = {
        count: rules.count,
        totalRules: rules.totalRules,
        enabledTotal: rules.enabledTotal,
        chars: rules.chars,
        maxChars: Number(cfg.maxChars) || 0,
        droppedCount: rules.dropped.length,
        droppedNames: rules.dropped.slice(0, 12),
        items: rules.items
      };
      markTrace('匹配世界规则', trace.rules.count + ' 条命中，共 ' + trace.rules.chars + ' 字');
      trace.inputParts.push({ key: 'worldbook', name: '命中世界书', chars: rules.worldbookText.length, filled: !!rules.worldbookText });
      trace.inputTotal += rules.worldbookText.length;

      if (!rules.count) {
        var reason = '本轮没有命中可参与裁定的世界规则';
        trace.status = 'skipped';
        trace.endedAt = Date.now();
        trace.result = { ok: false, reason: reason };
        rememberTrace(turn, trace);
        return { ok: false, block: '', raw: '', reason: reason, rulesInfo: rules, trace: trace };
      }
      var template = activePrompt();
      if (!template.trim()) {
        trace.status = 'failed';
        trace.endedAt = Date.now();
        trace.result = { ok: false, reason: '没有可用的提示词' };
        rememberTrace(turn, trace);
        return { ok: false, block: '', raw: '', reason: '没有可用的提示词', rulesInfo: rules, trace: trace };
      }
      var promptText = fillPlaceholders(template, d, template.includes('${命中世界书}') ? rules.generalText : rules.text, rules.worldbookText);
      trace.prompt = {
        templateChars: template.length,
        promptChars: promptText.length,
        // 模板里用到哪些占位符（玩家可据此判断资料有没有喂进去）
        placeholders: (function () {
          var out = [], re = /\$\{([^{}]+)\}/g, m;
          while ((m = re.exec(template))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
          return out;
        })()
      };
      markTrace('拼装提示词', trace.prompt.promptChars + ' 字，占位符 ' + trace.prompt.placeholders.length + ' 个');

      var reqStartedAt = Date.now();
      markTrace('请求模型', '');
      var reply = {}, replies = [];
      var requestOptions = {...opts, onReply: details => { reply = details; replies.push(details); }};
      var raw = await requestProseGuidance(promptText, requestOptions);
      if (!stripThinking(raw) || reply.finishReason === 'length') {
        markTrace('重取裁定正文', reply.finishReason === 'length' ? '上次输出被接口截断' :
          reply.rawChars || reply.reasoningChars ? '上次未给出裁定正文' : '上次返回空正文');
        raw = await requestProseGuidance(promptText + '\n\n【返回修正】请直接输出《修仙世界观指导》正文。省去分析和重复引用，保留每个实际触发域的裁定、依据与正文写法。', requestOptions);
      }
      var reqEndedAt = Date.now();
      trace.request = { ...reply, attempts: replies, durationMs: reqEndedAt - reqStartedAt, rawChars: String(raw || '').length };
      markTrace('模型返回', trace.request.rawChars + ' 字，耗时 ' + Math.round(trace.request.durationMs / 100) / 10 + ' 秒');

      var block = renderForPrompt(raw);
      if (reply.finishReason === 'length') throw new Error('世界观接口截断了裁定输出');
      if (!block) throw new Error(reply.rawChars || reply.reasoningChars
        ? '世界观指导只返回分析，缺少裁定正文' : '世界观接口返回空正文');
      var thinkingMatch = /<thinking>([\s\S]*?)<\/thinking>/i.exec(String(raw || ''));
      trace.result = {
        ok: true,
        blockChars: block.length,
        thinkingChars: thinkingMatch ? thinkingMatch[1].length : 0,
        // thinking 原文与正文分开存：面板里要能分别看「怎么想的」和「裁定成什么」
        thinking: thinkingMatch ? thinkingMatch[1].trim() : '',
        body: stripThinking(raw)
      };
      trace.status = 'done';
      trace.endedAt = Date.now();
      markTrace('生成裁定', block.length + ' 字');
      rememberTrace(turn, trace);

      return {
        ok: true,
        block: block,
        raw: raw,
        reason: '',
        rulesInfo: rules,
        promptChars: promptText.length,
        trace: trace
      };
    } catch (e) {
      // 失败降级：正文照常，不注入（与原著指导同口径）
      trace.status = opts.signal?.aborted || e?.name==='AbortError' ? 'cancelled' : 'failed';
      trace.endedAt = Date.now();
      trace.result = { ok: false, reason: String(e && e.message ? e.message : e) };
      markTrace(trace.status==='cancelled'?'已取消':'失败', trace.result.reason);
      rememberTrace(turn, trace);
      return { ok: false, block: '', raw: '', reason: String(e && e.message ? e.message : e), rulesInfo: null, trace: trace };
    }
  }

  /* ------------------------------------------------- 采集记录存取 */
  // Only the active turn can publish here. The game persists its result with the current floor.
  var currentTurn = null;
  function notifyTraceChanged() {
    try { window.dispatchEvent(new CustomEvent('fr:wv-trace-changed')); } catch (_) {}
  }
  function traceBegin(archive, logId, previousFloor, restoredTrace = null) {
    currentTurn = {archive, logId, previousFloor, trace:restoredTrace};
    notifyTraceChanged();
    return currentTurn;
  }
  function traceCurrent(archive, floor) {
    return currentTurn?.archive === archive &&
      (currentTurn.logId === floor || currentTurn.previousFloor === floor) ? currentTurn : null;
  }
  function traceAdopted(archive, floor) {
    if (currentTurn?.archive !== archive || currentTurn.logId !== floor) return null;
    currentTurn.previousFloor = null;
    return currentTurn.trace;
  }
  function rememberTrace(turn, trace) {
    if (turn !== currentTurn) return;
    trace.id = 'wv-' + trace.startedAt;
    turn.trace = trace;
    notifyTraceChanged();
  }
  function traceClear() {
    currentTurn = null;
    notifyTraceChanged();
  }


  async function guideProse(data, options) {
    if (cfgLoad().enabled !== true) return '';
    var result = await run(data, options);
    return result.ok ? result.block.trim() : '';
  }

  window.FRWorldview = {
    cfgLoad, cfgSave, promptsLoad, promptsSave, activePrompt,
    rulesLoad, rulesSave, rulesReset, buildRulesBlock,
    run, guideProse, resolveApiConfig, fillPlaceholders, stripThinking, renderForPrompt, requestGuidance,
    traceBegin, traceCurrent, traceAdopted, traceClear,
    traceLoad: () => currentTurn?.trace ? [currentTurn.trace] : []
  };
})();
