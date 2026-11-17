/* ============================================================================
 * 凡人卡独立前端 · 酒馆垫片（st-shim.js）
 *
 * 作用：在「没有酒馆父窗口」的环境里，把卡片需要的酒馆 API 补出来。
 * 原则：只在独立模式激活；酒馆模式什么都不做，保证同一份代码两用。
 *
 * 依赖的 45 处酒馆 API 中，代码里已带 typeof 守卫的有 41 处（不存在就降级），
 * 唯一会硬报错的是 TavernHelper.generate —— 所以这里是重中之重。
 * ========================================================================== */
(function () {
  'use strict';

  // ---- 判定运行环境 -------------------------------------------------------
  // 酒馆里卡片跑在 iframe 中，父窗口有 SillyTavern。
  // 独立模式下没有，此时才装垫片。
  var parentST = null;
  try { parentST = window.parent && window.parent !== window ? window.parent.SillyTavern : null; } catch (e) { parentST = null; }
  var inTavern = !!(parentST && typeof parentST.getContext === 'function');

  if (inTavern) {
    // 酒馆模式：什么都不做，让原逻辑照常走。
    try { console.log('[独立前端] 检测到酒馆环境，垫片不激活'); } catch (e) {}
    return;
  }

  try { console.log('[独立前端] 独立模式，装垫片'); } catch (e) {}

  // ---- 配置读写（localStorage） -------------------------------------------
  // 参数集的来源：内置预设「哈吉米、鲸鱼通用预设（万物有灵）」里的请求字段。
  // 学全的意思就是这些都要能配，不能只给 url/key/model 三样 ——
  // 少了 top_p / repetition_penalty / max_tokens 这些，出文风格和长度都会跑偏。
  var CFG_KEY = 'FR_STANDALONE_CONFIG_V1';
  var DEFAULTS = {
    // 接口
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    // 模型：**不预设任何默认模型**。
    // 2026-10-31 玩家：「你怎么把模型限定成这个了啊？应该是我选什么模型发什么啊」
    // 上游日志证实此前实际发出的是写死的 gpt-4o-mini，导致中转站报 model_not_found。
    // 现在空值代表「还没选」，发送前会强制校验并提示去下拉里选，绝不会静默兜底成别人的模型。
    model: '',

    // 采样参数（对齐预设）
    temperature: 1,            // 预设值
    top_p: 0.95,               // 预设值
    top_k: 0,                  // 0 = 不启用（多数 OpenAI 兼容接口不支持）
    top_a: 0,
    min_p: 0,
    frequency_penalty: 0,      // 预设值
    presence_penalty: 0,       // 预设值
    repetition_penalty: 1,     // 预设值（=1 即不惩罚）
    seed: -1,                  // -1 = 随机
    n: 1,

    // 长度
    maxContext: 2000000,       // 预设 openai_max_context

    // 行为开关
    stream: true,              // 预设 stream_openai = true
    squashSystemMessages: false,
    continuePrefill: true,
    continuePostfix: ' ',
    // 思考强度（原生思维链）。玩家给的参考口径：
    //   none=关闭原生思维链 / minimal=极低 / low=低 / medium=中
    //   high=高 / xhigh=极高 / max=最高
    // auto 跟随应用的模型默认档位，provider 由接口自行决定。
    reasoningEffort: 'auto',

    // 身份
    playerName: '玩家',
    characterName: '韩立',

    // 正文接口开关 / 正文预设开关（对齐卡内「启用独立API」与预设启用态）
    apiEnabled: true,
    prosePresetEnabled: true,

    // 各阶段的模型覆盖（可选，空则用上面的默认）
    stageModels: {}
  };

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      var saved = JSON.parse(raw);
      var live = Object.assign({}, DEFAULTS, saved || {});
      return typeof window.__frResolveLocalApiConfig === 'function'
        ? window.__frResolveLocalApiConfig(CFG_KEY, live) : live;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveConfig(patch) {
    var next = Object.assign(loadConfig(), patch || {});
    try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (e) {}
    if (typeof window.__frLocalApiConfigChanged === 'function') window.__frLocalApiConfigChanged(CFG_KEY, next);
    return next;
  }
  var config = loadConfig();
  window.FRStandaloneConfig = { load: loadConfig, save: saveConfig, current: function () { return config; } };

  // ---- 事件总线 -----------------------------------------------------------
  // 酒馆用 eventOn/eventEmit/eventRemoveListener，这里用 EventTarget 等价实现。
  var bus = new EventTarget();
  window.eventOn = function (name, handler) {
    if (typeof handler !== 'function') return;
    bus.addEventListener(name, function (ev) { try { handler(ev.detail); } catch (e) { console.error('[事件] ' + name + ' 处理失败:', e); } });
  };
  window.eventOnce = function (name, handler) {
    if (typeof handler !== 'function') return;
    bus.addEventListener(name, function (ev) { try { handler(ev.detail); } catch (e) { console.error(e); } }, { once: true });
  };
  window.eventEmit = function (name, data) {
    bus.dispatchEvent(new CustomEvent(name, { detail: data }));
    return Promise.resolve();
  };
  window.eventRemoveListener = function (name, handler) {
    // EventTarget 不支持按原函数移除包装过的监听，这里用宽松处理：
    // 卡片侧主要是生图监听，独立版暂不启用，移除不到也无害。
    try { bus.dispatchEvent(new CustomEvent('__remove__' + name, { detail: handler })); } catch (e) {}
  };

  // ---- 模型调用（核心） ---------------------------------------------------
  // 酒馆的 TavernHelper.generate(prompt, options) 返回字符串。
  // 独立版直接打 OpenAI 兼容接口。
  var activeControllers = new Set();

  // 2026-10-31 修复（正文发出去变成 [object Object] 的根因）：
  //   卡内 main.js:79168 是这样调的 ——
  //     const params = { user_input: guard.prompt, should_stream: ..., disable_extras: true };
  //     await TavernHelper.generate(params)
  //   酒馆的 TavernHelper.generate 认的是**具名参数对象**（JS-Slash-Runner generate.d.ts
  //   里声明 user_input?: string），而本垫片原先只按位置参数取第一个实参，
  //   于是 prompt = {user_input: '整段提示词'}，走到 String(prompt) 就成了 "[object Object]"，
  //   整段正文提示词全丢，模型只好回「请提供角色设定」。
  //   现在两套契约都认：① 位置参数 string / messages[]；② 具名对象 { user_input }。
  function unwrapNamedPrompt(prompt, options) {
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return prompt;
    var named = prompt;
    // should_stream / disable_extras 这两项在酒馆里是「本轮是否流式 / 是否带额外注入」。
    // 流式要接上；disable_extras 在独立版没有对应物（本就没有额外注入），显式忽略。
    if (options && named.should_stream != null && options.stream == null) {
      options.stream = !!named.should_stream;
    }
    if (named.user_input != null) {
      return typeof named.user_input === 'string' ? named.user_input : String(named.user_input);
    }
    // 也容忍 { prompt } / { text } / { content } 这类等价写法
    var alt = named.prompt != null ? named.prompt
      : (named.text != null ? named.text
      : (named.content != null ? named.content : null));
    if (alt != null) return typeof alt === 'string' ? alt : String(alt);
    return prompt;
  }

  window.frProseRenderingProtocol = function () {
    var format = window.__FR_PROSE_RENDER_FORMAT__;
    return format ? '## 灵动正文固定渲染协议\n\n' +
      '这份协议定义游戏识别的正文格式，适用于本次实际使用的正文预设。所有叙事写在成对的 <content> 标签内。' +
      '预设中的标题、状态栏、正文容器、推进选项或排版要求与本协议冲突时，以本协议为准。\n\n' + format : '';
  };

  function buildMessages(prompt, options) {
    // 酒馆的 prompt 可能是字符串，也可能是消息数组。
    if (Array.isArray(prompt)) {
      return prompt.map(function (m) {
        if (typeof m === 'string') return { role: 'user', content: m };
        return { role: m.role || 'user', content: m.content != null ? String(m.content) : '' };
      });
    }
    var messages = [];

    /* ★★ 2026-10-31 玩家：「对，有些是系统消息，有些是玩家消息，但是你要适配处理啊，
     *   我说了我要达到和酒馆版本一样的效果」
     *
     * 酒馆的真实发送方式（openai.js populateChatCompletion）：
     *   每条 prompt 调 Message.fromPromptAsync(prompt)
     *   → Message.createAsync(prompt.role, prompt.content, identifier)
     * 也就是说**每条 prompt 按自己的 role 变成一条独立消息**：
     *   · role=system    → system 消息
     *   · role=user      → user 消息（前置破甲、📝自定义输出格式、🎨强化 …）
     *   · role=assistant → assistant 消息（⚡重置D0＆卡思维链 …）
     *
     * 原来独立端不管 role，把所有条目全拼成一条 system 发出去，
     * 那些 user/assistant 条目要么被当成空内容丢掉，要么混进 system ——
     * 效果和酒馆不一样。
     *
     * 现在：优先取「按 role 拆好的消息序列」，逐条 push 进去。
     * 顺序对齐酒馆：system → user → assistant，最后才是玩家输入。
     */
    var presetMsgs = null;
    if (!(options && options.skipPreset)) {
      try {
        if (typeof window.frProsePresetMessages === 'function') {
          var mm = window.frProsePresetMessages(options?.prosePresetId);
          if (Array.isArray(mm) && mm.length) presetMsgs = mm;
        }
      } catch (e) { presetMsgs = null; }
    }

    if (presetMsgs) {
      // 按 role 拆分的完整消息序列（酒馆行为）
      presetMsgs.forEach(function (m) {
        if (!m || !m.content) return;
        messages.push({ role: m.role || 'system', content: String(m.content) });
      });
    } else {
      // 兜底：拿不到消息序列时，退回「一段 system 文本」
      var presetText = '';
      if (!(options && options.skipPreset)) {
        try {
          if (typeof window.frProsePresetText === 'function') {
            presetText = String(window.frProsePresetText(options?.prosePresetId) || '').trim();
          }
        } catch (e) { presetText = ''; }
        if (!presetText) {
          try {
            if (typeof window.frBuiltinPresetText === 'function') {
              presetText = String(window.frBuiltinPresetText() || '').trim();
            }
          } catch (e) { presetText = ''; }
        }
      }
      var sys = options && (options.systemPrompt || options.system);
      var sysText = sys ? String(sys) : '';
      var combined = [presetText, sysText].filter(Boolean).join('\n\n');
      if (combined) messages.push({ role: 'system', content: combined });
    }

    // 调用方显式传的 systemPrompt 单独补一条（不覆盖预设里的 system）
    if (presetMsgs) {
      var sys2 = options && (options.systemPrompt || options.system);
      if (sys2) messages.push({ role: 'system', content: String(sys2) });
    }
    if (options?.proseRequest) {
      var protocol = window.frProseRenderingProtocol();
      if (protocol) messages.push({ role: 'system', content: protocol });
    }

    /* ★★ 2026-11-01 玩家：「是快照也被放在 user 这一块了」
     *                    「你看，体检说又是正常的」→ 数字对不上：user 16,953 字符
     *
     * 【问题】原来这里把整个 finalPrompt（快照 + 年表 + 原著指导 + 剧情指导 +
     *   世界书/世界观指导 + 玩家输入 …… 一万六千多字）**整条塞进一条 user 消息**。
     *
     * 【酒馆真实结构】查 C:\xzz\SillyTavern\public\scripts\openai.js：
     *   · chatCompletionDefaultPrompts 里 main / worldInfoBefore / worldInfoAfter /
     *     jailbreak / nsfw 全是 system_prompt:true + role:'system'
     *   · populateChatHistory（第 886 行）新开对话提示 newMainChat 也是 system
     *   · 只有**真正的玩家输入**和**历史里的用户楼层**是 user
     *   → 也就是说：运行时拼装内容在酒馆里属于 worldInfoBefore 位置，是 **system**；
     *     玩家输入才是 user。
     *
     * 【改法】finalPrompt 里「### 玩家输入：」这一段单独拆出来发 user，
     *   前面全部运行时内容发 system。找不到该标记时整条仍发 user（保持旧行为，绝不吞内容）。
     */
    var fullText = String(prompt == null ? '' : prompt);
    var userInputMarker = '### 玩家输入：';
    var markerIdx = fullText.lastIndexOf(userInputMarker);
    if (markerIdx > 0) {
      var sysPart = fullText.slice(0, markerIdx).replace(/\s+$/, '');
      var userPart = fullText.slice(markerIdx).trim();
      if (sysPart) messages.push({ role: 'system', content: sysPart });
      if (userPart) messages.push({ role: 'user', content: userPart });
    } else {
      // 没有玩家输入标记：无法安全拆分，保持原样整条发 user
      messages.push({ role: 'user', content: fullText });
    }
    return messages;
  }

  // 模型选择：优先级 阶段覆盖 > 调用方显式传入 > 玩家在面板选定的模型。
  // 绝不兜底成写死的模型名（2026-10-31 玩家口径：「我选什么模型就发什么」）。
  //
  // 2026-11-01 玩家：「明明我都选了模型了，还是显示说我没有选」
  // 根因：这里原来读的是模块顶部 `var config = loadConfig()` 那次快照。
  //   玩家在设置面板选完模型点保存，saveConfig 只写了 localStorage，
  //   内存里的 config 还是页面加载时那份（model 为空），
  //   于是界面显示选了 gemini-3.0-flash，发请求却报「还没有选择模型」。
  // 修法：每次都重新 loadConfig() 读最新的 localStorage。
  //   本项目其余模块（preset-adapters / prose-api-settings / boot …）
  //   本来就走 FRStandaloneConfig.load() 实时读，只有这里用了陈旧快照。
  function pickModel(options, live) {
    var stage = options && options.stage;
    if (stage && live.stageModels && live.stageModels[stage]) {
      return String(live.stageModels[stage]);
    }
    if (options && options.model) return String(options.model);
    return String(live.model || '');
  }

  // 发送前的硬校验：模型必须是玩家选过的，宁可报错也不静默用别的模型。
  function requireModel(options, cfg) {
    var m = pickModel(options, cfg).trim();
    if (m) return m;
    throw new Error('还没有选择模型。请打开「设置 → 正文生成 API → API 详细配置」，' +
      '先点「获取可用模型」，再从下拉框里选一个站点确实提供的模型，然后保存。');
  }

  function normalizeUrl(url) {
    var u = String(url || '').trim();
    if (!u) return DEFAULTS.apiUrl;
    // 允许用户只填 base（如 https://api.x.com/v1），自动补全路径
    if (!/\/chat\/completions\/?$/i.test(u)) {
      u = u.replace(/\/+$/, '');
      if (/\/v1$/i.test(u)) u += '/chat/completions';
      else if (!/\/v1\//i.test(u)) u += '/v1/chat/completions';
    }
    return u;
  }

  // 组装请求体。
  // 对齐依据：本机酒馆 C:\xzz\SillyTavern\public\scripts\openai.js 的 generate_data
  // （约 97325 行起）与 getReasoningEffort()。核心口径：
  //   ① temperature / frequency_penalty / presence_penalty / top_p 依协议发送
  //   ② top_k / top_a / min_p / repetition_penalty / seed / n 是「非 0/非默认才发」
  //   ③ 思考档位按实际发出的模型 ID 决定
  function buildBody(cfg, prompt, options) {
    var body = {
      // 这里用 requireModel：没选模型就直接抛错，绝不代入任何默认模型。
      model: requireModel(options, cfg),
      messages: buildMessages(prompt, options),
      // 显式传的 stream 优先（测试连接会传 false），否则跟配置
      stream: (options && options.stream != null) ? !!options.stream : (cfg.stream !== false)
    };

    // 数值参数：调用方显式传 > 玩家配置 > 预设默认
    function num(optKey, cfgKey, dflt) {
      if (options && options[optKey] != null) return options[optKey];
      var v = cfg[cfgKey];
      return v != null ? v : dflt;
    }

    // ① 恒发项（对齐酒馆 generate_data）
    body.temperature = num('temperature', 'temperature', 1);
    body.frequency_penalty = num('frequencyPenalty', 'frequency_penalty', 0);
    body.presence_penalty = num('presencePenalty', 'presence_penalty', 0);
    body.top_p = num('topP', 'top_p', 0.95);
    const outputLimit = Number(options?.maxTokens);
    if(Number.isSafeInteger(outputLimit) && outputLimit>0)body.max_tokens=outputLimit;

    // ② 非默认才发（避免站点不认而报错）
    var topK = num('topK', 'top_k', 0);
    if (topK) body.top_k = topK;

    var topA = num('topA', 'top_a', 0);
    if (topA) body.top_a = topA;

    var minP = num('minP', 'min_p', 0);
    if (minP) body.min_p = minP;

    var rp = num('repetitionPenalty', 'repetition_penalty', 1);
    if (rp && rp !== 1) body.repetition_penalty = rp;

    var seed = num('seed', 'seed', -1);
    if (seed != null && seed !== -1) body.seed = seed;

    var n = num('n', 'n', 1);
    if (n && n !== 1) body.n = n;

    const policy = window.FR_CHAT_REQUEST_CORE?.['chat-request-policy'];
    return policy?.chatRequestBody(body,{apiUrl:cfg.apiUrl,profile:options?.requestProfile,
      effort:options?.reasoningEffort ?? cfg.reasoningEffort,purpose:'prose'}) ?? body;
  }

  var latestMainPrompt = null;
  function mainPromptHistory(archiveName) {
    try {
      var rows = JSON.parse(localStorage.getItem('FR_MAIN_PROMPT_HISTORY_V1:' + archiveName) || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }
  window.FRMainPromptHistory = {
    read: function (archiveName, logId) {
      if (!archiveName || !logId) return null;
      if (latestMainPrompt && latestMainPrompt.archiveName === archiveName && latestMainPrompt.logId === logId) return latestMainPrompt;
      return mainPromptHistory(archiveName).find(function (row) {
        return row && row.archiveName === archiveName && row.logId === logId;
      }) || null;
    }
  };
  function recordMainPrompt(identity, body) {
    if (!identity || !identity.archiveName || !identity.logId) return;
    var archiveName = identity.archiveName, logId = identity.logId, messages = body.messages || [];
    var snapshot = { archiveName: archiveName, logId: logId, atText: new Date().toLocaleString(), model: body.model, messages: messages,
      systemLen: 0, userLen: 0, assistantLen: 0, totalLen: 0 };
    messages.forEach(function (message) {
      var size = String(message.content == null ? '' : message.content).length;
      snapshot.totalLen += size;
      if (message.role === 'system') snapshot.systemLen += size;
      else if (message.role === 'assistant') snapshot.assistantLen += size;
      else snapshot.userLen += size;
    });
    latestMainPrompt = snapshot;
    var rows = mainPromptHistory(archiveName).filter(function (row) {
      return row && row.archiveName === archiveName && row.logId && row.logId !== logId;
    }).slice(-4);
    rows.push(snapshot);
    while (rows.length) {
      try { localStorage.setItem('FR_MAIN_PROMPT_HISTORY_V1:' + archiveName, JSON.stringify(rows)); break; }
      catch (_) { rows.shift(); }
    }
  }

  async function callModel(prompt, options) {
    var route = window.__frRunApiRoutes;
    if (typeof route !== 'function' || options?.directConnectionTest) return callModelOnce(prompt, options);
    return route(CFG_KEY, undefined, null, connection => callModelOnce(prompt, options, connection), options?.signal,
      error => !error?.partialOutput);
  }

  // Only structural metadata: never log response text, prompts, URL, model or credentials.
  function recordProseResponseMeta(meta, text) {
    try {
      var value = String(text || '').replace(/<(thinking|think|analysis)>[\s\S]*?<\/\1>/gi, '');
      console.info('[正文回包诊断] ' + JSON.stringify({
        transport:meta.transport, status:meta.status, finishReason:meta.finishReason,
        doneMarker:meta.doneMarker, eof:meta.eof, malformedFrames:meta.malformedFrames,
        chars:String(text || '').length,
        contentOpen:(value.match(/<content>/gi)||[]).length,
        contentClose:(value.match(/<\/content>/gi)||[]).length,
        elapsedMs:Date.now()-meta.started
      }));
    } catch (_) { /* Diagnostics must not change generation behavior. */ }
  }
  function proseFinishReason(value) {
    return value == null ? null : ['stop','length','content_filter','tool_calls','function_call'].includes(value) ? value : 'other';
  }

  function checkProseOutputLength(choice) {
    if (choice?.finish_reason === 'length')
      throw Object.assign(new Error('正文接口达到输出上限，正文未完成。可重新发送本轮'), {code:'FR_PROSE_OUTPUT_LENGTH'});
  }

  async function callModelOnce(prompt, options, connection) {
    options = options || {};
    // ① 先解开酒馆的具名参数对象 { user_input, should_stream, disable_extras }
    prompt = unwrapNamedPrompt(prompt, options);
    // ② 硬校验：宁可报错，也绝不把对象静默发成 "[object Object]"。
    //    历史上就是这里静默降级，导致整段正文提示词丢失、模型回「请提供角色设定」。
    if (typeof prompt !== 'string') {
      if (Array.isArray(prompt)) {
        // 消息数组是合法输入，交给 buildMessages 处理
      } else {
        throw new Error('正文提示词不是字符串（收到 ' + Object.prototype.toString.call(prompt) +
          '）。请检查调用方是否把 { user_input } 这类对象直接当 prompt 传了。');
      }
    }
    var cfg = loadConfig();
    if(connection) cfg = Object.assign({}, cfg, {
      apiUrl:connection.apiUrl, apiKey:connection.apiKey, model:connection.apiModel, stageModels:{}
    });
    var url = window.FR_CHAT_REQUEST_CORE?.['chat-request-policy']?.chatCompletionsEndpoint(cfg.apiUrl) ?? normalizeUrl(cfg.apiUrl);
    var profile=connection?.requestProfile;
    var body = buildBody(cfg, prompt, connection ? {...options,model:connection.apiModel,requestProfile:profile,
      prosePresetId:options.proseRequest ? window.FRProseRoutePresets?.get(connection.id) : undefined} : options);

    const imageTextFilter=window.FR_CHAT_REQUEST_CORE?.['story-image-assets'];
    if(imageTextFilter)body.messages=imageTextFilter.sanitizeStoryImageMessages(body.messages);

    recordMainPrompt(options.promptIdentity, body);

    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

    var controller = new AbortController();
    var emitted = false;
    var responseText = "";
    var responseMeta = {transport:body.stream ? "sse" : "json",status:"failed",finishReason:null,doneMarker:false,eof:false,malformedFrames:0,started:Date.now()};
    var abort = function () { controller.abort(options.signal?.reason); };
    activeControllers.add(controller);
    // 允许外部 signal 联动
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    try {
      var resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!resp.ok) {
        var errText = '';
        try { errText = await resp.text(); } catch (e) {}
        var statusError = new Error('模型接口返回 ' + resp.status + (errText ? '：' + errText.slice(0, 300) : ''));
        statusError.httpStatus = resp.status;
        throw statusError;
      }

      if (!body.stream) {
        var json = await resp.json();
        var choice = json?.choices?.[0];
        responseMeta.finishReason = proseFinishReason(choice?.finish_reason);
        responseText = String(choice?.message?.content || '');
        checkProseOutputLength(choice);
        var text = responseText;
        if(!text.trim())throw new Error('正文接口返回空内容');
        responseMeta.status = "returned";
        return text;
      }

      // ---- 流式 ----
      var reader = resp.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      var full = '';

      while (true) {
        var step = await reader.read();
        buffer += step.done ? decoder.decode() : decoder.decode(step.value, { stream: true });

        // SSE 以空行分隔事件
        var lines = buffer.split('\n');
        buffer = step.done ? '' : lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === '[DONE]') { responseMeta.doneMarker = true; continue; }
          var chunk;
          try { chunk = JSON.parse(payload); } catch (e) { responseMeta.malformedFrames++; continue; }
          var frame = chunk?.choices?.[0];
          if(frame?.finish_reason != null) responseMeta.finishReason = proseFinishReason(frame.finish_reason);
          checkProseOutputLength(frame);
          var piece = frame?.delta?.content;
          if (typeof piece === 'string' && piece) {
            full += piece;
            responseText = full;
            emitted = true;
            // 卡片里监听这个事件做逐字上屏
            window.eventEmit('js_stream_token_received_incrementally', { token: piece, full: full });
          }
        }
        if (step.done) { responseMeta.eof = true; break; }
      }
      if(!full.trim())throw new Error('正文流式接口返回空内容');
      responseMeta.status = "returned";
      return full;
    } catch (error) {
      /* ★★ 2026-11-01 玩家：「这个正文错误又是什么？」（截图：API调用失败: network error）
       *
       * 原来这里只有 finally，没有 catch —— fetch 连不上时抛的
       *   TypeError: Failed to fetch / network error / ERR_CONNECTION_REFUSED
       * 会原样冒出去，被 frMainRequestFailureText 截断后直接显示在聊天里，
       * 玩家只看到 "network error" 这种英文，根本不知道该怎么办。
       *
       * 这里统一翻译成「哪一步挂了 + 可能原因 + 怎么查」，
       * 同时把原始信息附在括号里，方便排查时不丢线索。
       * 注意：不吞异常，翻译完照样抛出去，上层流程该停还是停。
       */
      var failure = shimFriendlyNetworkError(error, url);
      if(emitted) failure.partialOutput = true;
      throw failure;
    } finally {
      if(options.proseRequest) recordProseResponseMeta(responseMeta, responseText);
      options.signal?.removeEventListener('abort',abort);
      activeControllers.delete(controller);
    }
  }

  // 把底层网络异常翻译成玩家能看懂的中文。
  // 输入可能是 TypeError / DOMException / 带 cause 的包装错误，一律尽量挖出根因。
  function shimFriendlyNetworkError(error, url) {
    var raw = String((error && (error.message || error)) || '');
    var causeName = '';
    try { causeName = String(error && error.cause && (error.cause.code || error.cause.message) || ''); } catch (e) {}
    var rawAll = raw + ' ' + causeName;

    // 主动中断不算错误，保持原样，让上层按取消处理
    if (error && (error.name === 'AbortError' || error.code==='FR_PROSE_OUTPUT_LENGTH' || error.httpStatus || /abort/i.test(raw))) return error;

    var hint;
    if (/Failed to fetch|network error|NetworkError|ERR_NETWORK/i.test(rawAll)) {
      hint = '连不上模型接口。请依次检查：'
        + '① 设置里的接口地址是否完整（要以 https:// 开头，不要只填域名）；'
        + '② 电脑能不能正常上网、该站点是否打得开；'
        + '③ 如果开了代理或加速器，Electron 默认不走系统代理，需要在系统里开全局模式；'
        + '④ 接口密钥是否还有效。';
    } else if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(rawAll)) {
      hint = '接口地址拒绝连接（多半是地址或端口填错，或者该服务没在运行）。请核对设置里的接口地址。';
    } else if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(rawAll)) {
      hint = '解析不到这个域名（地址拼写可能错了，或当前网络无法访问该站点）。请核对接口地址。';
    } else if (/ERR_CERT|CERT_|SSL|TLS/i.test(rawAll)) {
      hint = '安全证书校验没通过（常见于自建中转站）。请确认接口地址是 https 且证书有效。';
    } else if (/timeout|ETIMEDOUT|timed out/i.test(rawAll)) {
      hint = '请求超时，接口太久没有响应。可能是网络慢或该站点繁忙，稍后重试。';
    } else {
      hint = '请求没有发出去。请检查接口地址、网络连接与密钥配置。';
    }

    var out = new Error('正文模型请求失败：' + hint + (raw ? '（底层信息：' + raw.slice(0, 160) + '）' : ''));
    out.name = error && error.name ? error.name : 'NetworkError';
    out.cause = error;
    out.frNetworkHint = true;
    try { out.requestUrl = url; } catch (e) {}
    return out;
  }

  // 装到酒馆同名位置：卡片代码读的是 window.parent.TavernHelper.generate。
  // 独立模式下 parent === window，所以挂 window.TavernHelper 即可被读到。
  window.TavernHelper = window.TavernHelper || {};
  window.TavernHelper.generate = function (prompt, options) { return callModel(prompt, options); };
  window.TavernHelper.generateRaw = function (prompt, options) { return callModel(prompt, options); };
  window.TavernHelper.generateQuietPrompt = function (prompt, options) { return callModel(prompt, options); };
  window.TavernHelper.stopAllGeneration = function () {
    activeControllers.forEach(function (c) { try { c.abort(); } catch (e) {} });
    activeControllers.clear();
  };
  window.TavernHelper.getTavernVersion = function () { return '1.12.0-standalone'; };

  // ---- 玩家名 / 上下文 ----------------------------------------------------
  window.SillyTavern = window.SillyTavern || {};
  window.SillyTavern.getContext = function () {
    var cfg = loadConfig();
    return {
      name1: cfg.playerName || DEFAULTS.playerName,
      name2: cfg.characterName || DEFAULTS.characterName,
      chatMetadata: {},
      characters: [],
      chat: [],
      extensionSettings: {},
      powerUserSettings: {},
      getCurrentChatId: function () { return 'standalone'; }
    };
  };

  // ---- 世界书 -------------------------------------------------------------
  // 2026-10-31：内置世界书（旧「万物有灵」16 条）已按玩家决定移除。
  // 世界观设定统一进「世界规则」，由世界观裁定器按需判定后注入正文提示词。
  // 这里保留空实现，只为不打断卡内 getWorldbook / replaceWorldbook 等调用点。
  var WORLD_BOOK_NAME = '万物有灵世界书1.4（凡人定制版）';
  var worldbookEntries = {};

  function readInlineWorldbook() {
    return worldbookEntries;
  }

  // 酒馆的 getWorldbook 返回「条目数组」，每条有 comment/content/keys 等字段。
  // 酒馆原生世界书是 entries 对象（uid → entry），这里转成数组。
  function entriesToArray(entries) {
    if (Array.isArray(entries)) return entries;
    return Object.keys(entries || {}).map(function (uid) {
      var e = entries[uid] || {};
      return {
        uid: Number(uid),
        comment: e.comment || '',
        content: e.content || '',
        keys: e.key || e.keys || [],
        key: e.key || e.keys || [],
        secondaryKeys: e.keysecondary || [],
        constant: !!e.constant,
        selective: e.selective !== false,
        enabled: e.enabled !== false,
        insertionOrder: e.insertion_order || e.order || 0
      };
    }).filter(function (e) { return e.enabled && e.content; });
  }

  window.getWorldbookNames = function () { return [WORLD_BOOK_NAME]; };
  window.getWorldbook = async function (name) {
    var entries = readInlineWorldbook();
    return entriesToArray(entries);
  };
  window.getCharWorldbookNames = function () { return { primary: WORLD_BOOK_NAME, additional: [] }; };
  window.getGlobalWorldbookNames = function () { return [WORLD_BOOK_NAME]; };
  window.replaceWorldbook = async function (name, nextEntries) {
    // 独立版世界书是内置只读的；这里接受写入但不落盘，避免报错。
    try { console.log('[世界书] replaceWorldbook 被调用（独立版不落盘）', name); } catch (e) {}
    return true;
  };

  // ---- 变量写入 -----------------------------------------------------------
  // 卡片里 insertOrAssignVariables 写的是酒馆 chat 变量。
  // 独立版统一落到 IndexedDB，键名保持 'FR_TAVERN_VAR_' 前缀，便于迁移。
  window.getVariables = function () {
    try { return JSON.parse(localStorage.getItem('FR_TAVERN_VARS_V1') || '{}'); } catch (e) { return {}; }
  };
  window.insertOrAssignVariables = async function (vars) {
    var all = window.getVariables();
    Object.keys(vars || {}).forEach(function (k) { all[k] = vars[k]; });
    try { localStorage.setItem('FR_TAVERN_VARS_V1', JSON.stringify(all)); } catch (e) {}
    return all;
  };
  window.replaceVariables = async function (vars) {
    try { localStorage.setItem('FR_TAVERN_VARS_V1', JSON.stringify(vars || {})); } catch (e) {}
    return vars;
  };

  // ---- 扩展设置（酒馆专属，独立版给空对象） --------------------------------
  window.extension_settings = window.extension_settings || {};

  // ---- 消息楼层（卡片会读聊天记录） ---------------------------------------
  // 独立版的「聊天记录」就是 IndexedDB 里的存档，这里提供最小可用桩。
  window.getChatMessages = async function (range) { return []; };
  window.setChatMessages = async function () { return true; };
  window.getLastMessageId = function () { return 0; };
  window.createChatMessages = async function () { return true; };
  window.deleteChatMessages = async function () { return true; };

  // ---- 就绪标记 -----------------------------------------------------------
  window.__FR_STANDALONE__ = true;
  try { console.log('[独立前端] 垫片就绪：TavernHelper.generate / 世界书 / 事件总线 / 变量'); } catch (e) {}

  // 通知宿主（boot.js）垫片已装好
  try { window.eventEmit('fr-standalone-shim-ready', { at: Date.now() }); } catch (e) {}
})();
