// 仅拆分已约定的 JSON 外壳；所有变量语义仍由调用方传入的原生解析器处理。
var FrMergedEvolution = (function () {
  var items = new Set(['createItem','transferItem','transferSpiritStones','consumeItem','destroyItem','equipItem','unequipItem','refreshItemData','updateItemQuantity']);
  var people = new Set(['add','set','de','updateAttribute','useSkill','addSkill','deSkill','addTrait','deTrait']);
  var world = new Set(['addSmallSummary','addLargeSummary','addWorldEvent','updateWorldEvent','deleteWorldEvent','createLocation','updateRegion','deleteLocation']);
  function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  /* ★★ 2026-11-06 玩家实测：「变量演化完全没跑就跳过了」。
   *
   * 现场日志只有一句：
   *   [ERR] [并发演化] 执行失败: Error: 合并演化：命令参数必须为完整 JSON
   * 然后就整轮终止、一个变量都没落地，而补演那边跑得很顺。
   *
   * 问题不在「模型写错了」这件事本身 —— 模型偶尔写坏一条命令很正常。
   * 问题在于这里的失败方式：
   *   ① 抛错时不带任何上下文，看不出是哪条命令、坏在哪、原文长什么样；
   *   ② 一抛就直接冒泡到 runConcurrentEvolution，整包作废，连重试都没有。
   * 于是一条写坏的命令 = 整轮归零。
   *
   * 现在：失败时把「命令名 + 截断位置 + 原始文本 + JSON 报错」一并带出，
   * 上层据此给出可执行纠正并重试；仍然失败才终止，且日志里能直接看到病根。
   */
  function preview(text, limit) {
    var s = String(text == null ? '' : text);
    var cap = limit || 160;
    if (s.length <= cap) return s;
    return s.slice(0, cap) + '…（共 ' + s.length + ' 字符）';
  }
  function failure(message, detail, envelopeFailure) {
    var error = new Error('合并演化：' + message);
    if (detail) error.mergedDetail = detail;
    error.mergedParseFailure = true;
    if (envelopeFailure) error.mergedEnvelopeFailure = true;
    throw error;
  }
  function call(text) {
    if (typeof text !== 'string') failure('commands 每项必须是原生命令字符串', { received: typeof text });
    var source = text.trim().replace(/^灵石变动(?=\s*\()/u,'transferSpiritStones'), match = source.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (!match) failure('只接受原生函数调用，不接受短指令或状态路径', { got: preview(source) });
    var depth = 1, quoted = false, escaped = false, end = match[0].length;
    for (; end < source.length; end++) {
      var ch = source[end];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth || quoted || !/^;?$/.test(source.slice(end + 1).trim())) failure('每项必须是完整单条原生命令', {
      name: match[1],
      unclosedParens: depth,
      unclosedQuote: quoted,
      trailing: preview(source.slice(end + 1).trim()),
      got: preview(source)
    });
    var args;
    var argText = source.slice(match[0].length, end);
    try { args = JSON.parse('[' + argText + ']'); }
    catch (error) {
      /* 把 JSON.parse 的真实报错、参数原文、及其首尾片段一并留下。
       * 常见成因：单引号、尾逗号、中文引号、未转义换行、字符串被截断。 */
      failure('命令参数必须为完整 JSON', {
        name: match[1],
        jsonError: String(error && error.message || error),
        argLength: argText.length,
        argHead: preview(argText, 300),
        argTail: argText.length > 300 ? preview(argText.slice(-300), 300) : '',
        whole: preview(source, 400)
      });
    }
    // 原角色入口用正则抽upstore，转义JSON字符串中的<防止内容提前截断标签。
    function finite(value) {
      if (typeof value === 'number' && !Number.isFinite(value)) failure('命令参数含非有限数值，不能规范化为 null', {name: match[1]});
      if (Array.isArray(value)) value.forEach(finite);
      else if (value && typeof value === 'object') Object.keys(value).forEach(function(key) { finite(value[key]); });
    }
    finite(args);
    var canonical = match[1] + '(' + args.map(function (arg) { return JSON.stringify(arg).replace(/</g, '\\u003c'); }).join(',') + ')';
    return { name: match[1], args: args, text: canonical };
  }
  function errors(result) { return result && (result.error || (result.errorMessages || []).map(function (e) { return e.details || e.title; }).join('；')); }
  function envelope(commands) { return '<upstore>' + commands.join('\n') + '</upstore>'; }

  function commandRepairPrompt(issues) {
    return '修复以下原生变量指令的格式，保留动作、对象和数值。只返回 JSON {"repairs":[{"index":0,"command":"修好的单条原生函数调用"}]}。index 沿用待修序号，允许先修其中几条。参数使用标准 JSON。\n'+JSON.stringify(issues);
  }
  function repairCommands(commands,issues,text) {
    const reply=JSON.parse(String(text).trim().replace(/^`{3}(?:json)?\s*([\s\S]*?)\s*`{3}$/i,'$1'));
    const pending=new Map(issues.map(issue=>[issue.index,issue]));
    if(!Array.isArray(reply?.repairs)||!reply.repairs.length)throw new Error('指令补缺须返回 repairs');
    const result=commands.slice();
    for(const row of reply.repairs){
      const issue=pending.get(row?.index);
      if(!issue)throw new Error('指令补缺序号无效或重复');
      const fixed=call(row.command);
      const original=String(commands[row.index]).match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
      if(original&&original[1]!==fixed.name)throw new Error('指令补缺不能改动原指令类型');
      const owner=String(commands[row.index]).match(/^\s*\w+\(\s*"([A-Za-z][\w-]*)"\s*,/);
      if(owner&&fixed.args[0]!==owner[1])throw new Error('指令补缺不能改动原对象');
      const objectIds=[...String(commands[row.index]).matchAll(/"(owner|from|to|0)"\s*:\s*"([A-Za-z][\w-]*)"/g)]
        .filter(([,key])=>key!=='0'||fixed.name==='set');
      if(objectIds.some(([,key,id])=>fixed.args[0]?.[key]!==id))throw new Error('指令补缺不能换绑原对象');
      if(issue.targetId&&String(object(fixed.args[0])?fixed.args[0]['0']:fixed.args[0])!==issue.targetId)
        throw new Error('人物指令补缺超出目标范围');
      result[row.index]=fixed.text;
      pending.delete(row.index);
    }
    return result;
  }
  function characterCommandRepair(body,targetId,parse,resolve) {
    const commands=body.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(commands.some(line=>!/^\w+\s*\(/.test(line)||/;\s*\w+\s*\(/.test(line)))return null;
    const issues=[];
    for(const [index,command] of commands.entries()){
      try{
        const parsed=parse(call(command).text);
        if(errors(parsed)||!parsed.delta?.length)throw new Error(errors(parsed)||'未被人物解析器识别');
        if(parsed.delta.some(op=>String(resolve(op)||'')!==targetId))return null;
      }catch(error){
        issues.push({index,targetId,command:preview(command,1200),reason:error.message});
      }
    }
    return issues.length?{commands,issues}:null;
  }

  /* 2026-11-06：把「哪条命令坏了、坏成什么样」翻译成模型能照着改的一句话。
   * withRetry 会把它塞进下一次请求的纠正提示里，形成可自愈的重试。 */
  function describeFailure(error) {
    if (!error || !error.mergedParseFailure) return '';
    var d = error.mergedDetail || {};
    var bits = [];
    if (d.stage) bits.push('校验位置：' + d.stage);
    if (d.targetId) bits.push('目标ID：' + d.targetId);
    if (Array.isArray(d.allowedIds)) bits.push('本阶段允许ID：' + JSON.stringify(d.allowedIds));
    if (d.correction) bits.push(d.correction);
    if (Number.isFinite(d.responseChars)) bits.push('响应共 ' + d.responseChars + ' 字符');
    if (d.name) bits.push('出错的命令是 ' + d.name + '(...)');
    if (d.jsonError) bits.push('JSON 解析器报：' + d.jsonError);
    if (d.argLength) bits.push('参数共 ' + d.argLength + ' 字符');
    if (d.unclosedParens) bits.push('括号没有闭合');
    if (d.unclosedQuote) bits.push('字符串引号没有闭合');
    if (d.trailing) bits.push('函数调用后面还跟了多余内容：' + d.trailing);
    if (d.argHead) bits.push('参数开头：' + d.argHead);
    if (d.argTail) bits.push('参数结尾：' + d.argTail);
    if (d.got) bits.push('命令原文：' + d.got);
    return bits.join('；');
  }
  function parseResponse(text, options) {
    var opts = options || {}, value;
    if (typeof text !== 'string') failure('响应必须为 JSON 文本', { responseChars: 0 }, true);
    var source = text.trim();
    if (opts.canonCompletion) source = source.replace(/^<(think|thinking)>(?:[\s\S]*?)<\/\1>\s*/i, '');
    var fence = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    try { value = JSON.parse(fence ? fence[1] : source); }
    catch (_) { failure('响应不是完整 JSON', { responseChars: text.length }, true); }
    if (opts.eventSteps) {
      var eventCommands = value?.eventCommands;
      if (!Array.isArray(eventCommands) || eventCommands.length !== opts.eventSteps.length ||
          !Array.isArray(value.commands) || value.commands.length) failure('逐事件结算须按原顺序返回 eventCommands，整轮 commands 留空');
      var base = {...value}; delete base.eventCommands;
      var pack = parseResponse(JSON.stringify(base), {...opts, eventSteps:null});
      pack.eventPacks = opts.eventSteps.map(function (step, index) {
        var row = eventCommands[index];
        if (!object(row) || row.key !== step.key || !Array.isArray(row.commands) ||
            Object.keys(row).some(key=>!['key','commands','absoluteBalances','dependencies'].includes(key))) {
          failure('逐事件结算缺少、重复或错序：'+step.key);
        }
        var ids = step.actors.map(actor=>actor.id);
        var overrides = row.absoluteBalances ?? [];
        if (!Array.isArray(overrides) || overrides.some(entry=>!ids.includes(entry?.id) || typeof entry.evidence !== 'string' ||
            !entry.evidence.trim() || !step.actors.find(actor=>actor.id===entry.id)?.prose.includes(entry.evidence))) failure('独立余额定值缺少本段原文依据：'+step.key);
        var dependencies = row.dependencies ?? [];
        if (!Array.isArray(dependencies) || dependencies.some(entry=>!ids.includes(entry?.id) ||
            typeof entry.evidence !== 'string' || !entry.evidence.trim() ||
            !step.actors.find(actor=>actor.id===entry.id)?.prose.includes(entry.evidence) ||
            !opts.eventSteps.slice(0,index).some(earlier=>earlier.key===entry.previous && earlier.actors.some(actor=>actor.id===entry.id)))) {
          failure('事件依赖须引用本人已结算前段和当前原句：'+step.key);
        }
        var result = parseResponse(JSON.stringify({...base,commands:row.commands,completion:{actors:base.completion.actors.filter(actor=>ids.includes(actor.id))}}),
          {...opts,eventSteps:null,allowedTargetIds:ids,entryTargetIds:ids,reentryTargetIds:[]});
        result.absoluteBalances = overrides.map(entry=>entry.id);
        result.dependencies = dependencies;
        return result;
      });
      return pack;
    }
    var keys = opts.canonCompletion ? 'commands|completion|entry|think' : 'commands|entry|think';
    if (!object(value) || Object.keys(value).sort().join('|') !== keys || typeof value.think !== 'string' || !object(value.entry) || !Array.isArray(value.commands)) failure(opts.canonCompletion ? '补演合并必须返回 think、entry、commands、completion 四个键' : '只接受 think、entry对象、commands数组三个键');
    if (typeof opts.parseCharacters !== 'function' || typeof opts.parseItems !== 'function' || typeof opts.parseMisc !== 'function' || typeof opts.resolveTarget !== 'function') failure('原生解析器未就绪');
    var allowed = new Set((opts.allowedTargetIds || []).map(String));
    var independent = new Set((opts.independentTargetIds || []).map(String));
    if (opts.canonCompletion) {
      if (!object(value.completion) || !Array.isArray(value.completion.actors)) failure('completion 必须包含 actors 核对数组');
      var reported = new Set();
      value.completion.actors.forEach(function (row) {
        var id = object(row) && typeof row.id === 'string' ? row.id : '';
        if (!id || !allowed.has(id) || independent.has(id)) failure('核对人物超出本批范围：' + id);
        if (reported.has(id)) failure('核对人物重复：' + id);
        reported.add(id);
      });
      allowed.forEach(function (id) { if (!independent.has(id) && !reported.has(id)) failure('completion 缺少本批人物核对：' + id); });
    }
    var disabled = new Set((opts.disabledTargetIds || []).map(String));
    var disabledTypes = new Set(opts.disabledTargetTypes || []);
    var entryAllowed = new Set((opts.entryTargetIds || opts.allowedTargetIds || []).map(String));
    var reentryAllowed = new Set((opts.reentryTargetIds || opts.entryTargetIds || opts.allowedTargetIds || []).map(String));
    var entry = JSON.parse(JSON.stringify(value.entry));
    var entryKeys = new Set(['thinking','entries','exits','globalCommands','deedsUpdates','noEntry','noExit']);
    Object.keys(entry).forEach(function (key) {
      if (entryKeys.has(key)) return;
      if (['factionDiscoveries','factionEvents','factionExposureReviews'].includes(key) && Array.isArray(entry[key]) && !entry[key].length) { delete entry[key]; return; }
      failure('entry 字段没有既有消费者：' + key);
    });
    if (!Array.isArray(entry.entries) || !Array.isArray(entry.exits) || !Array.isArray(entry.globalCommands) || !object(entry.deedsUpdates || {})) failure('entry 缺少合法的登退场、全局或事迹结构');
    var phases = opts.enabledPhases || {};
    if (phases.entry === false && (entry.entries.length || entry.exits.length || entry.globalCommands.length || Object.keys(entry.deedsUpdates || {}).length)) failure('登场阶段关闭，本轮登退场、全局命令与事迹应为空');
    if (entry.thinking !== undefined && typeof entry.thinking !== 'string') failure('entry.thinking 必须是字符串');
    entry.entries.forEach(function (row) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || ['__proto__','constructor','prototype'].includes(row.id)) failure('登场目标无效');
      if (row.stateCommands !== undefined) failure('登场必须使用原生 setCommand');
      if (Object.keys(row).some(function (key) { return !['id','name','type','reason','setCommand'].includes(key); })) failure('登场字段没有既有消费者');
      if (row.type !== 'reentry') {
        if (typeof row.setCommand !== 'string' || row.stateCommands !== undefined) failure('新人物必须提供原生 setCommand');
        var parsedCall = call(row.setCommand);
        if (parsedCall.name !== 'set' || parsedCall.args.length !== 1 || !object(parsedCall.args[0]) || parsedCall.args[0]['0'] !== row.id) failure('新人物 setCommand 必须含同一ID的完整set骨架');
        var parsed = opts.parseCharacters(parsedCall.text);
        if (errors(parsed) || !(parsed.delta || []).some(function (op) { return op.command === 'set'; })) failure('登场骨架未被原生解析器消费');
        row.setCommand = parsedCall.text;
      } else if (!reentryAllowed.has(row.id)) failure('返场人物超出本轮离场候选范围：' + row.id, { stage: 'entry.entries', targetId: row.id, allowedIds: Array.from(reentryAllowed), correction: '沿用明确列出的返场候选，不把后台目标名单当完整身份索引，也不把旧人重建为new。' });
      allowed.add(row.id);
      // 本包已通过身份/命令校验的登场者可以在同段剧情中再次离场。
      entryAllowed.add(row.id);
      var type = row.id === 'B1' ? 'player' : /^P(?:_|\d)/.test(row.id) ? 'beast' : 'npc';
      if (disabledTypes.has(type)) disabled.add(row.id);
    });
    entry.exits.forEach(function (row) { if (!object(row) || !entryAllowed.has(String(row.id || ''))) failure('退场人物超出本轮范围', { stage: 'entry.exits', targetId: row?.id, allowedIds: Array.from(entryAllowed), correction: '只能退出本轮可退场名单或本包合法登场者；先核对entries身份与最终场景。' }); });
    Object.keys(entry.deedsUpdates || {}).forEach(function (id) { if (!allowed.has(id)) failure('事迹人物超出本轮范围：' + id); });
    if (opts.timeLocationOwner === 'misc' && entry.globalCommands.length) failure('本轮时间地点由杂项接管，登场不得写入');
    entry.globalCommands = entry.globalCommands.map(function (text) {
      var parsedCall = call(text), parsed = opts.parseCharacters(parsedCall.text);
      if (errors(parsed) || !(parsed.delta || []).length || (parsed.delta || []).some(function (op) { return op.command !== 'add' || opts.resolveTarget(op) !== 'TIME_LOCATION_ROW'; })) failure('登场全局命令只允许原生时间地点行');
      return parsedCall.text;
    });
    var itemCommands = [], personal = Object.create(null), miscCommands = [];
    allowed.forEach(function (id) { if (!opts.sharedOnly && !independent.has(id) && !disabled.has(id)) personal[id] = []; });
    const commandIssues=[];
    value.commands.forEach(function (text,index) {
      let parsedCall;
      try{parsedCall=call(text);}
      catch(error){
        if(!opts.repairableCommands)throw error;
        commandIssues.push({index,command:preview(text,1200),reason:error.message});
        return;
      }
      var name = parsedCall.name, domain, parsed, target;
      if (items.has(name)) {
        domain = 0; parsed = opts.parseItems(parsedCall.text);
        if (errors(parsed) || !(parsed.operations || []).length) {
          if(!opts.repairableCommands)failure('物品命令未被完整消费：' + name);
          commandIssues.push({index,command:preview(text,1200),reason:'物品命令未被完整消费：'+(errors(parsed)||name)});
          return;
        }
        (parsed.operations || []).forEach(function (op) {
          if (!['transferItem','transferSpiritStones'].includes(op.type) && (typeof op.owner !== 'string' || !op.owner)) failure('物品命令必须提供明确 owner');
          if (op.type === 'transferItem' && (!op.from || !op.to)) failure('转移物品必须提供from/to');
          ['owner','from','to'].forEach(function (key) { if (op[key] && !allowed.has(String(op[key]))) failure('物品人物超出范围：' + op[key]); });
        });
        itemCommands.push(parsedCall.text);
      } else if (world.has(name)) { domain = 2; miscCommands.push(parsedCall.text); }
      else if (people.has(name)) {
        parsed = opts.parseCharacters(parsedCall.text);
        if (errors(parsed) || !(parsed.delta || []).length) {
          if(!opts.repairableCommands)failure('个人命令未被完整消费：' + name);
          commandIssues.push({index,command:preview(text,1200),reason:'个人命令未被完整消费：'+(errors(parsed)||name)});
          return;
        }
        var targets = Array.from(new Set(parsed.delta.map(function (op) { return String(opts.resolveTarget(op) || ''); })));
        if (targets.length !== 1 || !targets[0]) failure('单条命令缺少唯一明确目标');
        target = targets[0];
        if (target !== 'TIME_LOCATION_ROW' && parsed.delta.some(function (op) { return op.data && op.data['0'] !== undefined && String(op.data['0']) !== target; })) failure('命令第0列ID与目标不一致');
        if (target === 'TIME_LOCATION_ROW') {
          if (opts.timeLocationOwner !== 'misc' || name !== 'add') failure('时间地点只允许由本轮负责的登场或杂项阶段写入');
          domain = 2; miscCommands.push(parsedCall.text);
        }
        else if (target === 'SCENE_MAP' || /^T(?:_|\d)/.test(target)) { domain = 2; miscCommands.push(parsedCall.text); }
        else {
          domain = 1;
          if (opts.sharedOnly) failure('个人变量由人物批次负责');
          if (independent.has(target)) failure('合并命令不得写独立人物的个人变量：' + target);
          if (disabled.has(target)) failure('人物提示组未启用：' + target);
          if (!allowed.has(target)) failure('个人目标超出本轮范围：' + target, {
            stage: 'commands[' + index + ']', targetId: target, allowedIds: [...allowed].filter(id => !disabled.has(id) && !independent.has(id)),
            correction: '移除发给清单外角色的个人命令；保留清单内有正文依据的变更，不把越界变更套给其他人。'
          });
          personal[target].push(parsedCall.text);
        }
      } else failure('不支持的命令：' + name);
      if (domain === 0 && phases.items === false) failure('物品阶段关闭，本轮不得返回物品命令');
      if (domain === 2 && phases.misc === false) failure('杂项阶段关闭，本轮不得返回杂项命令');
    });
    if(commandIssues.length){
      const error=new Error(commandIssues[0].reason);
      error.mergedParseFailure=true;
      error.commandRepair={value,issues:commandIssues};
      throw error;
    }
    var miscText = miscCommands.join('\n'), misc = opts.parseMisc(miscText);
    if (errors(misc)) failure('杂项命令未通过原生解析：' + errors(misc));
    var responses = Object.create(null);
    Object.keys(personal).forEach(function (id) { responses[id] = envelope(personal[id]); });
    return { think: value.think, entryResponse: JSON.stringify(entry), itemResponse: envelope(itemCommands), characterResponses: responses, miscResponse: envelope(miscCommands), targetIds: Array.from(allowed), ...(opts.canonCompletion ? { completion: value.completion } : {}) };
  }
  function buildPrompt(template, values) {
    var prompt = String(template || '').replace(/\$\{([^}]+)\}/g, function (match, key) { return Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key] == null ? '' : values[key]) : match; });
    var missing = prompt.match(/\$\{[^}]+\}|\{\{template:[^}]+\}\}/g);
    if (missing) failure('提示词有未解析占位符：' + Array.from(new Set(missing)).join('、'));
    if (!prompt.trim()) failure('合并预设为空');
    return prompt;
  }
  function npcBatchLimit(value) {
    var size = Number(value);
    return Number.isInteger(size) && size >= 1 && size <= 100 ? size : 6;
  }
  function characterBatches(targets, limit) {
    var max = npcBatchLimit(limit), batches = [[]], npcCount = 0;
    for (var target of targets) {
      if (target.type === 'npc' && npcCount === max) {
        batches.push([]);
        npcCount = 0;
      }
      batches.at(-1).push(target);
      if (target.type === 'npc') npcCount++;
    }
    return batches;
  }
  function itemsForBatch(response, targets) {
    var ids = new Set(targets.map(target => target.id));
    var body = /^<upstore>([\s\S]*)<\/upstore>$/.exec(response)?.[1];
    if (!body) return envelope([]);
    return envelope(body.split('\n').filter(text => {
      var [data] = call(text).args;
      return [data?.owner,data?.from,data?.to].some(id => ids.has(id));
    }));
  }
  return { parseResponse, buildPrompt, describeFailure, npcBatchLimit, characterBatches, itemsForBatch, commandRepairPrompt, repairCommands, characterCommandRepair };
})();
