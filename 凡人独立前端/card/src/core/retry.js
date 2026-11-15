// ============================================================
// 调用重试：模型调用失败时重来，不是一失败就降级
//
// 用户 2026-10-21：
//   「失败了应该重试，重试的那套设置不需要我说吧？加到面板去。」
//
// ------------------------------------------------------------
// 为什么要单独一层，而不是各处自己写 for 循环：
//
//   整个流程有 6 处调模型（名词提取、原著指导、要点压缩、逐条对勾、
//   一步式、NPC 正文单写/合写）。每处如果各写一份重试，
//   会出现「有的重试有的不重试」「有的等 1 秒有的等 5 秒」
//   「有的只重试网络错有的连解析错也重试」这类不一致，
//   玩家在面板上调也没法统一生效。
//
// ------------------------------------------------------------
// 哪些错该重试（这条分错会很难受）：
//
//   该重试：
//     · 网络/超时/限流/5xx —— 换个时刻可能就好了
//     · 空响应 —— 模型偶发抽风
//     · JSON 解析失败 —— 模型偶发吐格式
//
//   不该重试：
//     · 没有可用接口配置 —— 重试 100 次也一样
//     · 401/403 鉴权失败 —— 重试只会让账号更危险
//     · 参数错误 400 —— 是代码或配置问题，重试无用
//
//   分不清的一律按「该重试」处理——
//   多试一次的代价远小于少补一段剧情。
// ============================================================

/** 默认重试配置。次数、解析重试和等待时长可由玩家调整。 */
export const CE_RETRY_DEFAULTS = {
  /** 最多重试几次（不含首次）。面板可调，参考「重试次数 0-5」 */
  maxRetries: 2,
  /** 两次重试之间等多久（毫秒）。 */
  retryDelayMs: 1000,
  /** 每次退避是不是加倍。内部固定。 */
  backoff: true,
  /** 退避上限，防止等到天荒。 */
  maxDelayMs: 8000,
  /** 解析失败要不要重试。面板上是一个开关。 */
  retryOnParseError: true,
};

/**
 * 面板上暴露的字段。
 *
 * 参照目标前端「并发与容错」的做法：**只给重试次数**，
 * 退避曲线由程序定。玩家要管的是「允许试几次」，
 * 不是「第一次等 1 秒第二次等 2 秒」——后者只会让人乱调。
 */
export const CE_RETRY_FIELDS = {
  maxRetries: {
    label: '重试次数',
    min: 0,
    max: 5,
    hint: '单条请求失败后的额外重试次数。设 0 就是失败即放弃。',
  },
};

/**
 * 判断一个错误值不值得重试。
 *
 * @param {*} error
 * @returns {{retry:boolean, reason:string}}
 */
export function shouldRetry(error) {
  const msg = String(
    error && error.message ? error.message : (error == null ? '' : error),
  );
  const lower = msg.toLowerCase();

  // 明确不该重试的
  if (/没有可用接口配置|no.*api.*config|未配置/.test(msg)) {
    return { retry: false, reason: '接口没配置，重试无意义' };
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.*key|鉴权|密钥/.test(lower)) {
    return { retry: false, reason: '鉴权失败，重试无意义' };
  }
  if (/context_length_exceeded|context window.*exceed|maximum context length|上下文.*(?:超出|超过|超限)|ce_request_capacity/.test(lower)) {
    return { retry: false, reason: '输入超限' };
  }
  if (/\b400\b|bad request|参数错误/.test(lower)) {
    return { retry: false, reason: '请求本身有问题，重试无意义' };
  }

  // 明确该重试的
  if (/timeout|timed out|超时|abort/i.test(msg)) {
    return { retry: true, reason: '超时' };
  }
  if (/\b429\b|\b5\d\d\b|rate.?limit|限流|too many/.test(lower)) {
    return { retry: true, reason: '限流或服务端错误' };
  }
  if (/network|fetch|econn|socket|连接/i.test(msg)) {
    return { retry: true, reason: '网络问题' };
  }
  if (/空内容|empty.*response|返回空/.test(msg)) {
    return { retry: true, reason: '模型返回空' };
  }

  // 分不清就重试——多试一次代价小
  return { retry: true, reason: '未知错误，按可重试处理' };
}

/**
 * 把玩家配置规整成可用的重试配置。
 *
 * @param {object} [config]
 * @returns {typeof CE_RETRY_DEFAULTS}
 */
export function normalizeRetryConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  return {
    maxRetries: num(c.maxRetries, CE_RETRY_DEFAULTS.maxRetries, 0, 5),
    // 退避方式保留，等待值遵守玩家配置。
    // 等待值有范围约束；服务端限流冷却仍由发送调度器执行。
    retryDelayMs: num(c.retryDelayMs, CE_RETRY_DEFAULTS.retryDelayMs, 0, 120000),
    backoff: CE_RETRY_DEFAULTS.backoff,
    maxDelayMs: Math.max(num(c.retryDelayMs,CE_RETRY_DEFAULTS.retryDelayMs,0,120000),num(c.maxDelayMs,CE_RETRY_DEFAULTS.maxDelayMs,0,600000)),
    retryOnParseError: c.retryOnParseError !== false,
  };
}

/**
 * 算第 n 次重试该等多久。
 *
 * 退避曲线是**程序策略**，不来自玩家配置——玩家只决定「试几次」。
 * 所以这里直接收退避参数，不从 normalizeRetryConfig 读，
 * 免得玩家填的毫秒值把曲线改坏。
 *
 * @param {number} attempt 第几次重试（从 1 开始）
 * @param {object} [timing] { retryDelayMs, maxDelayMs, backoff }
 * @returns {number} 毫秒
 */
export function retryDelayFor(attempt, timing) {
  const t = timing && typeof timing === 'object' ? timing : {};
  const base0 = Number.isFinite(Number(t.retryDelayMs))
    ? Math.max(0, Number(t.retryDelayMs))
    : CE_RETRY_DEFAULTS.retryDelayMs;
  const cap = Number.isFinite(Number(t.maxDelayMs))
    ? Math.max(0, Number(t.maxDelayMs))
    : CE_RETRY_DEFAULTS.maxDelayMs;
  const backoff = t.backoff !== false;

  const n = Math.max(1, Number(attempt) || 1);
  const base = base0 * (backoff ? (2 ** (n - 1)) : 1);
  return Math.min(cap, Math.max(0, base));
}

/**
 * 把校验失败的原因整理成「模型能照着改」的一段话。
 *
 * 为什么必须统一在这里：
 *   重试是**重新发一次请求**，模型看不到自己上次写了什么。
 *   如果只把「第5项不合格」丢回去，模型没有可执行信息，只能重复同样的错。
 *   过去每个调用点各自拼提示词，有的拼了（diff.js）、有的没拼（canon-runtime.js 直接 throw）、
 *   有的拼了废话（orchestrator.js 旧版说「上次核验的引用」），于是重试形同虚设。
 *
 * 写法沿用重点演化 ceBuildEntryIdValidationRetryBlock / 列35修正块的成功范式：
 *   1. 先给「必须覆盖的完整列表」，让模型知道全集
 *   2. 再给「本次需修正的」子集，让模型知道这次只要动这几处
 *   3. 最后给「修正铁律」，把可执行规则写死
 *   抽象描述（"不合格""不合法"）对模型没有指导意义，必须落到具体取值。
 *
 * @param {{reason?:string, correction?:object|null, value?:*}} input
 * @returns {string} 可直接拼进下一次提示词的纠正段；无有效信息时返回空串
 */
export function formatCorrectionHint(input) {
  const src = input && typeof input === 'object' ? input : {};
  const reason = String(src.reason || '').trim();
  const correction = src.correction && typeof src.correction === 'object' ? src.correction : null;
  if (!reason && !correction) return '';

  const lines = ['', '## 上一次返回不合格，本次必须修正', ''];
  if (reason) lines.push('问题：' + reason);
  lines.push('');

  if (correction) {
    const expected = Array.isArray(correction.expected) ? correction.expected.filter(Boolean) : [];
    const actual = Array.isArray(correction.actual) ? correction.actual.filter(Boolean) : [];
    const items = Array.isArray(correction.items) ? correction.items.filter(Boolean) : [];

    // 对照式：全集 vs 本次需修正，模型据此知道自己漏了什么、多写了什么。
    if (expected.length) lines.push('必须覆盖的完整列表 = [' + expected.join('、') + ']');
    if (items.length) {
      const labels = items.map((item) => (typeof item === 'string'
        ? item
        : String(item.label || item.name || '').trim())).filter(Boolean);
      if (labels.length) lines.push('本次需修正 = [' + labels.join('、') + ']');
      lines.push('');
      lines.push('逐项说明：');
      items.forEach((item, index) => {
        if (typeof item === 'string') { lines.push(`  ${index + 1}. ${item}`); return; }
        const parts = [];
        if (item.actual != null && String(item.actual).trim()) parts.push('你写的是「' + String(item.actual).trim() + '」');
        if (item.expected != null && String(item.expected).trim()) parts.push('应为「' + String(item.expected).trim() + '」');
        if (item.hint) parts.push(String(item.hint).trim());
        lines.push(`  ${index + 1}. ` + String(item.label || item.name || `第${index + 1}项`) + (parts.length ? '：' + parts.join('；') : ''));
      });
    }
    if (actual.length && !items.length) lines.push('你上次给的是 = [' + actual.join('、') + ']');
    if (correction.hint) { lines.push(''); lines.push('修正铁律：' + String(correction.hint).trim()); }
  }

  // 回传上次原文：模型看不到自己上次写了什么，就无法对照纠正。
  // 只截取片段，避免把整份长回复塞回去撑爆输入。
  const previousText = String(src.value == null ? '' : src.value).trim();
  if (previousText) {
    lines.push('');
    lines.push('【你上次返回的内容（仅供对照，按上面要求修正，不必整份重发）】');
    lines.push(previousText.length > 4000 ? previousText.slice(0, 4000) + '\n……（后面已省略）' : previousText);
  }

  lines.push('');
  lines.push('其余已经正确的内容原样保留，不要整篇重写，不要解释。');
  return lines.join('\n');
}

/**
 * 带重试地跑一个异步操作。
 *
 * 这是全流程唯一的重试实现。各模块都通过它调模型，
 * 面板上改一次配置，处处生效。
 *
 * @param {Function} fn 要跑的操作，返回 Promise
 * @param {object} [options]
 * @param {object} [options.config] 重试配置
 * @param {Function} [options.onRetry] (attempt, max, reason, delayMs) => void  记录诊断用
 * @param {Function} [options.validate] (result) => {ok:boolean, reason:string}
 *        用来把「拿回来了但内容不合格」也算成可重试的失败
 * @param {Function} [options.sleep] 测试注入用
 * @returns {Promise<{ok:boolean, value:*, attempts:number, errors:string[], reason:string}>}
 */
export function describeAbort(signal) {
  const reason=signal?.reason,text=String(reason?.message || (typeof reason==='string'?reason:'')).trim();
  if(text&&!/^(?:This operation was aborted|The operation was aborted\.?|signal is aborted without reason)$/i.test(text))return '任务已停止：'+text;
  return '本次任务已停止';
}
/** 纠正只属于当前尝试，显式传入；浏览器并发不能借助模块全局保存异步上下文。 */
export function applyPendingCorrection(messages,correction) {
  if(!correction || !Array.isArray(messages) || !messages.length)return messages;
  const last=messages.at(-1);if(typeof last?.content!=='string'||last.content.includes('上一次返回不合格'))return messages;
  return [...messages.slice(0,-1),{...last,content:last.content+'\n'+correction}];
}

export async function withRetry(fn, options = {}) {
  const src = options && typeof options === 'object' ? options : {};
  const config = normalizeRetryConfig(src.config);
  // 退避参数默认取程序固定值；
  // 但测试要能把它压成 0 才跑得快，所以允许显式覆盖。
  // 玩家的 config 读不到这里——面板上没有这几个字段。
  const timing = {
    retryDelayMs: Number.isFinite(Number(src.retryDelayMs))
      ? Number(src.retryDelayMs) : config.retryDelayMs,
    maxDelayMs: Number.isFinite(Number(src.maxDelayMs))
      ? Number(src.maxDelayMs) : config.maxDelayMs,
    backoff: src.backoff === false ? false : config.backoff,
  };
  const sleep = typeof src.sleep === 'function'
    ? src.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));
  const onRetry = typeof src.onRetry === 'function' ? src.onRetry : () => {};
  const validate = typeof src.validate === 'function' ? src.validate : null;
  // 中止信号：玩家点了停止，就不能再重试、再等待、再发请求。
  //
  // 之前核心包完全不知道这件事，于是「停止」只能拦住宿主那一侧：
  // 已经进到编排器里的重试循环照跑不误，玩家以为停了，
  // 后台还在烧 token，过一会儿还会写库。方案 §19 要求贯穿。
  const signal = src.signal || null;

  const errors = [];
  const maxTotal = 1 + config.maxRetries;
  let lastValue;
  // 上一轮为什么不合格。必须交给下一次 fn()，否则重试等于原样重发：
  // 模型看不到自己错在哪，只能重复同样的错，白白烧请求。
  // 各调用点使用本次重试的纠正上下文，不共享可变状态。
  let previous = null;

  for (let attempt = 1; attempt <= maxTotal; attempt += 1) {
    // 每次重试前先看中止。已经在飞的那一次不强行掐断（由 fn 自己管），
    // 但绝不发起新的一次，也绝不再等退避。
    if (signal && signal.aborted) {
      return {
        ok: false, value: lastValue, attempts: Math.max(0, attempt - 1), errors,
        reason: describeAbort(signal)+'，不再重试',
        aborted: true,
      };
    }

    try {
      const correct=payload=>({...payload,messages:applyPendingCorrection(payload.messages,previous?.text)});
      const value=await fn({attempt,previous,correct});
      lastValue = value;

      // 拿回来了，但内容不合格 → 也算失败，看配置要不要重试
      if (validate) {
        const checked = validate(value) || { ok: true, reason: '' };
        if (!checked.ok) {
          const reason = String(checked.reason || '返回内容不合格');
          errors.push(`第${attempt}次：${reason}`);
          // 把「上次原文 + 具体原因 + 可执行纠正」留给下一次，形成可自愈的重试。
          previous = {
            attempt,
            reason,
            correction: checked.correction || null,
            value,
            text: formatCorrectionHint({ reason, correction: checked.correction || null, value }),
          };
          const isParse = /解析|JSON|格式|不合格|为空/.test(reason);
          const canRetry = isParse ? config.retryOnParseError : true;
          if (!canRetry || attempt >= maxTotal) {
            return {
              ok: false, value: lastValue, attempts: attempt, errors,
              reason: attempt >= maxTotal ? `重试 ${config.maxRetries} 次后仍失败：${reason}` : reason,
              previous,
            };
          }
          const delay = retryDelayFor(attempt, timing);
          onRetry(attempt, maxTotal, reason, delay);
          if (delay > 0) await sleep(delay);
          continue;
        }
      }

      return { ok: true, value, attempts: attempt, errors, reason: '' };
    } catch (error) {
      const msg = String(error && error.message ? error.message : error);
      errors.push(`第${attempt}次：${msg}`);

      if(src.retryThrown===false)return {ok:false,value:lastValue,attempts:attempt,errors,reason:msg};
      const verdict = shouldRetry(error);
      if (!verdict.retry || attempt >= maxTotal) {
        return {
          ok: false, value: lastValue, attempts: attempt, errors,
          reason: verdict.retry
            ? `重试 ${config.maxRetries} 次后仍失败：${msg}`
            : `${verdict.reason}：${msg}`,
        };
      }

      const delay = retryDelayFor(attempt, timing);
      onRetry(attempt, maxTotal, msg, delay);
      if (delay > 0) await sleep(delay);
    }
  }

  return {
    ok: false, value: lastValue, attempts: maxTotal, errors,
    reason: '重试次数用尽',
  };
}

/**
 * 一行摘要，给诊断用。
 *
 * @param {object} result withRetry 的返回值
 * @returns {string}
 */
export function describeRetryResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const n = Number(r.attempts) || 0;
  if (r.ok) {
    return n <= 1 ? '一次成功' : `第 ${n} 次成功`;
  }
  return n <= 1 ? '一次就失败' : `试了 ${n} 次都失败`;
}
