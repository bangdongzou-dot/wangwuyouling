// ============================================================
// C1 · 宿主适配层
//
//
// 目的：把「新系统需要宿主给什么」收成一个显式契约。
//
// 为什么必须先做这一层：
//   1. 落地形态未定（直改正则 / 注入器 / 其他）。有了这一层，
//      换落地方式只改一处实现，不动业务代码。
//   2. 旧 npc-pov.js 直接引用 8 个宿主全局（dbGet/dbSet/genericApiCall/
//      currentState/showDanmaku/ceResolveOffscreenActiveRoster/
//      ceExtractOriginalTimelineEventList/wtResolveTimelineTurnRange）。
//      其中任一在目标卡里不存在或改名，模块就静默失效——
//      上一轮「散文没进四阶段」迟迟没被发现，就是这类静默失败。
//   3. 测试可以在 Node 里注入假宿主，不需要浏览器。
//
// 设计约束：
//   - 缺任何必需能力，在 createHost() 阶段就抛错，不等到运行中途。
//   - 业务代码只认 CEPort，不碰宿主全局。
// ============================================================

/**
 * 宿主必须提供的能力清单。
 * required=true 的缺失直接抛错；required=false 的缺失会降级并记录。
 */
export const CE_HOST_CAPABILITIES = {
  // 存储：读写持久化配置（清单库缓存、配置项）
  storageGet: { required: true, desc: '读取持久化配置' },
  storageSet: { required: true, desc: '写入持久化配置' },

  // LLM：单次调用。json=true 时要求返回 JSON
  llmCall: { required: true, desc: '调用语言模型' },

  // 存档状态：读当前存档快照
  stateRead: { required: true, desc: '读取当前存档状态' },

  // 世界书：读条目（酒馆 Tavern Helper 原生能力）
  worldbookNames: { required: false, desc: '列出世界书名称' },
  worldbookEntries: { required: false, desc: '读取某本世界书的条目' },

  // 年表：区间筛选
  timelineEntriesInRange: { required: false, desc: '按区间筛选年表条目' },

  // 向量检索：**直接调用卡内现成的 getVectorContext**
  // 契约：vectorContext(inputText) → Promise<string>
  //       内部已含 LLM 提关键词、embedding、余弦、标题加权、
  //       metadataFilter、rerank、时间过滤。本系统不重复实现任何一步。
  vectorContext: { required: false, desc: '卡内向量检索（getVectorContext）' },

  // ---------- 原著指导要吃的资料（用户 2026-10-21：有对应的都加进去） ----------
  // 契约统一：无参（或只收一个查询串）→ Promise<string> | string
  // 缺哪项就降级为「这一项没有」，不崩、不编。
  recentStory: { required: false, desc: '既往正文（lastAiStoryText 等）' },
  narrativeMemory: { required: false, desc: '分段记忆（smallSummary/largeSummary/deep）' },
  stateSnapshot: { required: false, desc: '世界状态快照（generatePrettySnapshotForAI）' },
  characters: { required: false, desc: '人物档案（境界/身份/性格/关系/动机/目标/生平）' },
  worldEvents: { required: false, desc: '世界大事记' },
  activeWorldEvents: { required: false, desc: '当前生效的世界局势' },
  map: { required: false, desc: '世界地图 POI 与当前小地图' },
  worldFactors: { required: false, desc: '世界规则（世界规则变动）' },

  // UI：状态提示与思维链
  uiStatus: { required: false, desc: '显示状态气泡' },
  uiThinking: { required: false, desc: '写入思维链' },
};

export class CEHostError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CEHostError';
    this.details = details || {};
  }
}

/**
 * 创建一个宿主端口。
 *
 * @param {object} raw 原始宿主实现（允许部分缺失）
 * @param {object} [options]
 * @param {boolean} [options.strict=true] 缺必需能力时是否抛错
 * @returns {object} CEPort
 */
export function createHost(raw = {}, options = {}) {
  const strict = options.strict !== false;
  const missingRequired = [];
  const missingOptional = [];

  for (const [name, spec] of Object.entries(CE_HOST_CAPABILITIES)) {
    const impl = raw[name];
    if (typeof impl !== 'function') {
      if (spec.required) missingRequired.push(name);
      else missingOptional.push(name);
    }
  }

  if (missingRequired.length > 0 && strict) {
    throw new CEHostError(
      `宿主缺少必需能力：${missingRequired.join('、')}。`
      + '拒绝在运行中途才失败，请在构造期补齐。',
      { missingRequired, missingOptional },
    );
  }

  const noop = () => {};

  const llmCall = raw.llmCall;

  return {
    // --- 必需 ---
    storageGet: raw.storageGet,
    storageSet: raw.storageSet,
    llmCall,
    stateRead: raw.stateRead,

    // --- 可选（缺失时降级为安全默认） ---
    worldbookNames: typeof raw.worldbookNames === 'function'
      ? raw.worldbookNames
      : () => [],
    worldbookEntries: typeof raw.worldbookEntries === 'function'
      ? raw.worldbookEntries
      : async () => [],
    timelineEntriesInRange: typeof raw.timelineEntriesInRange === 'function'
      ? raw.timelineEntriesInRange
      : async () => [],
    vectorContext: typeof raw.vectorContext === 'function'
      ? raw.vectorContext
      : async () => '',

    // --- 资料源（缺失时返回空串，采集层会记一条「宿主没有」） ---
    recentStory: typeof raw.recentStory === 'function' ? raw.recentStory : async () => '',
    narrativeMemory: typeof raw.narrativeMemory === 'function' ? raw.narrativeMemory : async () => '',
    stateSnapshot: typeof raw.stateSnapshot === 'function' ? raw.stateSnapshot : async () => '',
    characters: typeof raw.characters === 'function' ? raw.characters : async () => '',
    worldEvents: typeof raw.worldEvents === 'function' ? raw.worldEvents : async () => '',
    activeWorldEvents: typeof raw.activeWorldEvents === 'function' ? raw.activeWorldEvents : async () => '',
    map: typeof raw.map === 'function' ? raw.map : async () => '',
    worldFactors: typeof raw.worldFactors === 'function' ? raw.worldFactors : async () => '',

    uiStatus: typeof raw.uiStatus === 'function' ? raw.uiStatus : noop,
    uiThinking: typeof raw.uiThinking === 'function' ? raw.uiThinking : noop,

    // --- 诊断信息 ---
    capabilities: {
      missingRequired,
      missingOptional,
      has(name) {
        return typeof raw[name] === 'function';
      },
    },
  };
}

/**
 * 从酒馆/Tavern Helper 环境构造端口。
 * 落地形态确定后，只需替换这个函数。
 *
 * @param {object} globals 宿主全局对象（window 或等价物）
 */
export function createHostFromGlobals(globals = {}) {
  const g = globals || {};
  return createHost({
    storageGet: typeof g.dbGet === 'function' ? g.dbGet : undefined,
    storageSet: typeof g.dbSet === 'function' ? g.dbSet : undefined,
    llmCall: typeof g.genericApiCall === 'function'
      ? (payload) => g.genericApiCall(payload)
      : undefined,
    stateRead: typeof g.currentState !== 'undefined'
      ? () => g.currentState
      : undefined,

    // 酒馆原生世界书能力（实测卡内已在用 getWorldbookNames / getWorldbook）
    worldbookNames: typeof g.getWorldbookNames === 'function'
      ? () => g.getWorldbookNames()
      : undefined,
    worldbookEntries: typeof g.getWorldbook === 'function'
      ? (name) => g.getWorldbook(name)
      : undefined,

    timelineEntriesInRange: typeof g.wtSelectTimelineEntriesForRange === 'function'
      ? (entries, start, end) => g.wtSelectTimelineEntriesForRange(entries, start, end)
      : undefined,

    // 卡内现成的向量检索：整条流水线一行调用，不重复实现
    vectorContext: typeof g.getVectorContext === 'function'
      ? (inputText) => g.getVectorContext(inputText)
      : undefined,

    uiStatus: typeof g.showDanmaku === 'function'
      ? (text) => g.showDanmaku(text, 'status')
      : undefined,
    uiThinking: typeof g.ceRenderThinkingToStreamTab === 'function'
      ? (title, lines) => g.ceRenderThinkingToStreamTab(title, lines)
      : undefined,
  });
}
