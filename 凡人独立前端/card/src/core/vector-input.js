// ============================================================
// 向量检索输入构造器
//
// 核心认识（2026-10-21 用户纠正）：
//
//   卡里**已经有一整套**向量检索系统，入口是：
//       getVectorContext(inputText) → Promise<string>
//
//   它内部走完：LLM 提关键词 → fetchEmbedding → 余弦比对
//   → 标题加权 → 文件夹 metadataFilter → 可选 rerank → 可选时间过滤。
//
//   之前它被喂的是**正文**：
//       `【前情提要】${historyText}\n【当前玩家行动】${cleanMessageText}`
//
//   我们要做的**不是造第二套检索**，而是：
//   **把年表原著材料整理成同样格式的一段输入，喂给同一个入口。**
//
//   所以本文件只负责一件事：**年表事件 → 检索输入文本**。
//   不做 embedding、不做余弦、不做打分、不碰 Dexie。
//
// ------------------------------------------------------------
// 材料构成（用户 2026-10-21 第三次澄清，重要）
//
//   年表 = **动漫版**剧情。字段分工是：
//     content_brief    → 年表事件描述（当前用户新版1201条均有）
//     content_original → 用户提供的原著参考（当前新版1201条均有；旧表仅部分条目有）
//
//   为什么有些条目没有 content_original：
//     动漫与小说原著**存在剧情出入**，那 660 条属于
//     「动漫里有、原著里对不上」的部分，所以没有对应原文。
//
//   ⇒ **没有原文不是材料缺陷，是两种改编版本差异的正常结果。**
//     绝不能把它当「降级」或「薄材料」处理，否则会错误地
//     对那些条目降低质量、或者去原著里硬找不存在的段落。
//
//   检索材料优先级：
//     动漫版描述（brief，全覆盖）为主
//     + 原著原文（original，有则补充）
//     两者是**互补**关系，不是主备关系。
// ------------------------------------------------------------

/**
 * 解析标题里的人物标签，拆出人名与状态标注。
 *
 * 标签形态（实测）：
 *   「韩立,曲魂,墨居仁,张铁(已故)」
 *   「韩立,巨剑门弟子(尸),黄枫谷弟子(尸)」
 *   「韩立,黄衫女子 (黄枫谷),紫色宫裙女子」
 *
 * @param {string} title
 * @returns {{name:string, status:string, raw:string}[]}
 */
export function parseCharacterTags(title) {
  const m = String(title == null ? '' : title).match(/\[人物[:：]([^\]]+)\]/);
  if (!m) return [];

  const out = [];
  const seen = new Set();

  for (const piece of m[1].split(/[,，]/)) {
    const raw = piece.trim();
    if (!raw) continue;

    const statusMatch = raw.match(/[(（]([^)）]*)[)）]/);
    const status = statusMatch ? statusMatch[1].trim() : '';
    // 括号里的可能是状态（已故/尸），也可能是所属（黄枫谷），都保留到 status
    const name = raw.replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '').trim();
    if (!name || seen.has(name)) continue;

    seen.add(name);
    out.push({ name, status, raw });
  }
  return out;
}

/**
 * 从标题标签取干净人名（用于检索）。
 * @param {string} title
 * @returns {string[]}
 */
export function characterNamesFromTitle(title) {
  return parseCharacterTags(title).map((c) => c.name);
}

/**
 * 材料提供策略。玩家可选，因为**很多时候动漫版简单条目就够了**。
 *
 * 存在意义（用户 2026-10-21）：
 *   原著原文动辄数千字，喂进去会拉高 embedding 成本与噪声；
 *   而年表条目本身就足以支撑绝大多数补演。
 *   所以「要不要带原文」交给玩家决定，不写死。
 */
export const CE_MATERIAL_MODES = {
  /** 有原文用原文，没有用条目（默认） */
  auto: 'auto',
  /** 只用动漫版简单条目，忽略原著原文——最省 */
  brief: 'brief',
  /** 优先原文，没有则条目（等同 auto，语义更明确） */
  preferOriginal: 'prefer_original',
  /**
   * **当前事件用原文，其余用条目**（用户 2026-10-21 定的口径）
   *
   * 为什么这条最合理（实测数据说话）：
   *   content_brief    1225 条全有，平均 538 字
   *   content_original  565 条有，平均 6469 字、最长 25244 字
   *
   *   原文是**小说叙事**，不是「该发生什么事」。判定差集要的是后者，
   *   brief 本来就是干这个的。把每条的原文都塞进去，等于：
   *     闭关半年    3 条 →  8,020 字
   *     闭关十一年  68 条 → 187,793 字
   *     闭关百年   105 条 → 313,275 字（一次请求，必炸）
   *
   *   只有「此刻正在发生的那一条」值得给原文——
   *   因为这一条是玩家真正要落进去的事件，细节有用。
   */
  currentOnly: 'current_only',
};

export const CE_MATERIAL_MODE_LABELS = {
  auto: '原文优先（有原文用原文，没有用条目）',
  brief: '只用条目（最省，适合大多数情况）',
  prefer_original: '原文优先（同「原文优先」）',
  current_only: '当前事件用原文，其余用条目（推荐）',
};

/**
 * 把玩家配置的 mode 归一成上表里的某个值。
 *
 * 接受三种写法，都当成同一个意思：
 *   'current_only'（值）、'currentOnly'（键）、'prefer_original' 之类
 * 认不出来的一律当 auto，不抛错——材料策略不该让整轮停下。
 *
 * @param {string} mode
 * @returns {string}
 */
export function normalizeMaterialMode(mode) {
  const raw = String(mode == null ? '' : mode).trim();
  if (!raw) return CE_MATERIAL_MODES.auto;

  const values = Object.values(CE_MATERIAL_MODES);
  if (values.includes(raw)) return raw;

  // 再试驼峰键
  const byKey = CE_MATERIAL_MODES[raw];
  if (byKey) return byKey;

  // 下划线/驼峰互转再试一次
  const camel = raw.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (CE_MATERIAL_MODES[camel]) return CE_MATERIAL_MODES[camel];

  return CE_MATERIAL_MODES.auto;
}

/**
 * 取事件材料。
 *
 * 用户确认的优先级（2026-10-21）：
 *   有原著原文 → 用原著原文检索
 *   没有原著原文 → 用动漫版简单条目，**这就够了**
 *   并且**由玩家决定用哪种**，因为很多时候条目就够。
 *
 * 后来补定的口径（同日，看过真实数据体量后）：
 *   **只有当前事件点上的那一条用原文，其余一律 brief。**
 *   由 `options.isCurrent` 标记哪一条是当前事件。
 *
 * 660 条没有原著原文的原因：
 *   年表是**动漫版**剧情，小说原著与动漫存在剧情出入，
 *   那 660 条属于「动漫里有、原著里对不上」的部分。
 *   这是版本差异，不是数据缺陷，不能当降级。
 *
 * @param {object} entry 年表条目
 * @param {object} [options]
 * @param {'auto'|'brief'|'prefer_original'|'current_only'} [options.mode='auto'] 材料策略
 * @param {boolean} [options.isCurrent] 这条是不是「此刻正在发生」的那一条
 * @param {number} [options.maxChars=0] 完整实体容量，0 表示不限制；超出时明确拒绝
 * @returns {{
 *   primary:string, primarySource:'original'|'brief'|'none',
 *   brief:string, original:string, hasOriginal:boolean, mode:string
 * }}
 */
export function eventMaterialText(entry, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 0;
  // 归一化 mode。
  //
  // 注意别用 CE_MATERIAL_MODES[options.mode] 查表——
  // 那张表的**键是驼峰、值是下划线**（currentOnly: 'current_only'），
  // 拿值当键去查永远是 undefined，会静默回退成 auto，
  // 于是「只用简单版」这种策略看着配了、其实没生效。
  const mode = normalizeMaterialMode(options.mode);

  if (!entry || typeof entry !== 'object') {
    return {
      primary: '', primarySource: 'none', brief: '', original: '', hasOriginal: false, mode,
    };
  }

  const full = (s) => String(s == null ? '' : s).trim();

  const brief = full(
    entry.content_brief !== undefined ? entry.content_brief : entry.brief,
  );
  const original = full(
    entry.content_original !== undefined ? entry.content_original : entry.original,
  );

  let useOriginal;
  if (mode === CE_MATERIAL_MODES.brief) {
    // 玩家强制「只用条目」
    useOriginal = false;
  } else if (mode === CE_MATERIAL_MODES.currentOnly) {
    // 默认只给当前事件原文；年表明确仅供原文时，不把历史事件的唯一材料丢空。
    useOriginal = (options.isCurrent === true || !brief) && Boolean(original);
  } else {
    // auto / prefer_original：有原文就用
    useOriginal = Boolean(original);
  }

  const primary = useOriginal ? original : brief;
  if(maxChars>0 && primary.length>maxChars)throw Object.assign(new Error('单条事件资料超过处理容量；请按完整对象分批或提高请求容量，不可截断事件。'),{code:'CE_REQUEST_CAPACITY'});
  const primarySource = useOriginal ? 'original' : (brief ? 'brief' : 'none');

  return {
    primary,
    primarySource,
    brief,
    original,
    hasOriginal: Boolean(original),
    mode,
  };
}

/** 选中的事件完整发送；容量不足须交上层按完整对象拆批，不能截半条。 */
export function renderEventMaterial(entry, options = {}) {
  const cap = Number(options.maxChars)>0?Number(options.maxChars):0;
  const selected = eventMaterialText(entry,{...options,maxChars:0});
  const rawBrief=String(entry && (entry.content_brief ?? entry.brief) || '').trim();
  const rawOriginal=selected.primarySource==='original' ? String(entry && (entry.content_original ?? entry.original) || '').trim() : '';
  const brief=rawBrief,original=rawOriginal;
  const text=[brief?'【年表条目】\n'+brief:'',original?'【对应原著原文，仅作参考】\n'+original:''].filter(Boolean).join('\n\n');
  if(cap>0 && text.length>cap)throw Object.assign(new Error('单条事件完整资料超过处理容量；请按完整对象分批或提高请求容量，不可截断事件。'),{code:'CE_REQUEST_CAPACITY'});
  return {...selected,brief,original,text,truncated:false,originalChars:rawBrief.length+rawOriginal.length};
}

/**
 * 从标题取事件号。
 * @param {string} title
 * @returns {string}
 */
export function eventCodeFromTitle(title) {
  const m = String(title == null ? '' : title).match(/【\s*(E-\d+(?:\.\d+)?)\s*】/i);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 清洗标题：去掉事件号、年月、人物标签，只留事件名（仅用于展示）。
 *
 * 年表的标题有几种写法（实测）：
 *   `【E-001】0010年04月 赤绳系腕别亲闱 [人物:…]`
 *   `【E-004】0010-0011年11月 幽谷采药逢故交 [人物:…]`   ← 年份区间
 *   `【E-045】墨大夫收徒 [人物:…]`                        ← 干脆没时间
 *
 * 年份区间那种最容易漏：只写 `\d+年` 的正则会把 `0010-` 剩在标题里，
 * 清洗完变成 `0010- 幽谷采药逢故交`，材料可读性就废了。
 *
 * @param {string} title
 * @returns {string}
 */
export function cleanEventTitle(title) {
  return String(title == null ? '' : title)
    .replace(/【\s*E-\d+(?:\.\d+)?\s*】/gi, ' ')
    // 人物标签：标准写法是 `[人物:甲,乙]`，
    // 但实测也有 `[韩立]` 这种省掉「人物:」的写法，两种都要吃
    .replace(/\[人物[:：][^\]]*\]/g, ' ')
    .replace(/\[(?!E-)[^\]]*\]/g, ' ')
    // 先吃掉「年份区间 + 年月日」的整体，例如 `0010-0011年11月`、`0010年04月05日`
    .replace(/\d+\s*[-—~～至到]\s*\d+\s*年(?:(?:\s*\d{1,2}\s*[-—~～至到]\s*)?\s*\d{1,2}\s*月)?(?:(?:\s*\d{1,2}\s*[-—~～至到]\s*)?\s*\d{1,2}\s*日)?/g, ' ')
    // 再吃单个年月日（月份也可能是区间，如 `0021-0022年11-04月` 的后半段）
    .replace(/\d+\s*年(?:(?:\s*\d{1,2}\s*[-—~～至到]\s*)?\s*\d{1,2}\s*月)?(?:(?:\s*\d{1,2}\s*[-—~～至到]\s*)?\s*\d{1,2}\s*日)?/g, ' ')
    // 剩下只带月份的（如 `月` 前面残留的空白 + 月）
    .replace(/^[\s\d\-—~～至到]*月\s*/g, ' ')
    // 剩下的裸区间（如 `0010-0011`）也吃掉
    .replace(/^\s*\d+\s*[-—~～至到]\s*\d+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一条年表事件整理成**向量检索的输入文本**。
 *
 * 这就是「按检索正文的工作流程来检索年表原著内容」的落地：
 * 输出格式对齐卡内原有的 `【前情提要】…【当前…】…` 风格，
 * 让同一个 LLM 关键词生成提示词能正常工作。
 *
 * @param {object} entry 年表条目
 * @param {object} [options]
 * @param {'auto'|'brief'|'prefer_original'|'current_only'} [options.materialMode='auto']
 * @param {boolean} [options.isCurrent] 这条是不是当前正在发生的那一条
 * @param {string} [options.currentTime] 当前游戏时间
 * @param {string} [options.location] 当前地点
 * @param {number} [options.maxChars=0] 完整事件容量，0 表示不限制
 * @returns {object}
 */
export function buildVectorQueryInput(entry, options = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const title = String(e.title == null ? '' : e.title);
  const material = renderEventMaterial(e, {
    maxChars: options.maxChars,
    mode: options.materialMode,
    isCurrent: options.isCurrent === true,
  });

  const eventCode = eventCodeFromTitle(title);
  const eventTitle = cleanEventTitle(title);
  const tags = parseCharacterTags(title);
  const characters = tags.map((c) => c.name);
  const existence = tags
    .filter((c) => c.status)
    .map((c) => ({ name: c.name, status: c.status }));

  const timeRange = {
    start: String(e.time_start == null ? '' : e.time_start),
    end: String(e.time_end == null ? '' : e.time_end),
  };

  const lines = [];

  lines.push('【原著事件】');
  const head = [eventCode, eventTitle].filter(Boolean).join(' ');
  if (head) lines.push(head);

  if (timeRange.start || timeRange.end) {
    const range = timeRange.start && timeRange.end && timeRange.start !== timeRange.end
      ? `${timeRange.start} 至 ${timeRange.end}`
      : (timeRange.start || timeRange.end);
    lines.push(`时间：${range}`);
  }

  if (characters.length > 0) {
    lines.push(`涉及人物：${characters.join('、')}`);
    for(const name of characters){const aliases=options.characterAliases?.[name];if(Array.isArray(aliases) && aliases.length)lines.push('已确认称谓/别名：'+name+' = '+Array.from(new Set(aliases)).join('、'));}
  }
  if (existence.length > 0) {
    lines.push(`状态标注：${existence.map((x) => `${x.name}（${x.status}）`).join('、')}`);
  }

  const ctxParts = [];
  if (options.currentTime) ctxParts.push(`当前时间：${options.currentTime}`);
  if (options.location) ctxParts.push(`当前地点：${options.location}`);
  if (ctxParts.length > 0) {
    lines.push('');
    lines.push('【当前处境】');
    lines.push(...ctxParts);
  }

  if (material.text) {
    lines.push('');
    lines.push(material.text);
  }

  lines.push('');
  lines.push('请从上面这段年表材料里，找出需要去设定集中核对的人物、物品、功法、灵兽与地点。');
  lines.push('事件起止覆盖一段时间，当前日期之后的细节尚未发生，检索到的未来状态仅作参考，不能当作当前存档事实。人物称谓、本名和组合写法须结合原文识别，不按同姓或字串包含猜同一个人；同一人可用已确认的别名检索，不把称谓另建成新人。');

  return {
    inputText: lines.join('\n'),
    eventCode,
    eventTitle,
    characters,
    existence,
    material,
    timeRange,
    // 两份材料都缺才是真降级（实测 0 条，保留防御）
    degraded: material.primarySource === 'none',
    // 该条是否有原著原文。false 不代表材料不足——
    // 660 条没有原文是动漫与小说版本差异，用动漫版条目即可。
    hasOriginal: material.hasOriginal,
    materialMode: material.mode,
  };
}

/**
 * 批量构造（按时间顺序）。
 *
 * @param {Array<object>} entries
 * @param {object} [options]
 * @returns {Array<ReturnType<typeof buildVectorQueryInput>>}
 */
export function buildVectorQueryInputs(entries, options = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => buildVectorQueryInput(entry, options));
}
