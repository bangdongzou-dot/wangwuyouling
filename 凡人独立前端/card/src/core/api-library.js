import { chatCompletionsEndpoint, chatRequestBody, normalizeChatRequestProfile } from './chat-request-policy.js';

// ============================================================
// 统一 API 接口配置库
//
// 玩家 2026-11-04，两次澄清后的准确需求：
//   ① 「先做一下统一的api接口配置，在系统设置那里」
//   ② 「统一的api设置是先填好api接口，然后再由玩家到对应的系统api设置那里
//       进行分配，就不用反复填写了，这个意思，
//       并不是说所有地方一定统一一个api」
//
// ------------------------------------------------------------
// 所以它是一座「接口库」，不是「全局唯一接口」
//
//   系统设置 → 统一 API 接口配置
//     ├─ 在这里**先存好若干条**接口（名字 / URL / Key / 模型）
//     │    例：主接口 · DeepSeek、备用 · 硅基流动、生图专用 …
//     └─ 玩家接着到「变量思考 / 正文优化 / 世界演化 / 原著补演 …」
//        各自的设置里，**从库里挑一条**，不用再重复填 URL/Key/模型
//
//   各子系统**互相独立**，可以各挑各的 —— 这是重点。
//
// ------------------------------------------------------------
// 为什么不直接写进各子系统的配置里
//
//   如果"分配"= 把 URL/Key 复制进各子系统的存储，
//   那么以后在库里改了地址/换了 Key，那些已经复制过去的不会跟着变，
//   玩家还得逐个再改一遍 —— 等于没解决问题。
//
//   所以分配保存的是**引用**（接口 id），运行时再取实际值：
//     子系统配置 { apiPresetId: 'p_xxx' }  →  解析成 { apiUrl, apiKey, apiModel }
//   库里一改，所有引用它的子系统立刻生效。
//
//   同时保留「手动填」的老路径：子系统里自己填了 URL/Key/模型就用自己那份，
//   完全不碰库也照旧能用 —— 不破坏任何现有配置。
// ============================================================

/** 接口库存放键（localStorage，同步读取，各子系统读取时不至于都变 async） */
export const UNIFIED_API_LIBRARY_KEY = 'CULTIVATION_API_LIBRARY_V1';
/* 镜像备份键。主键因任何原因读不到时（异常退出未刷盘、
 * 误清、容量问题）用它恢复，避免玩家配了半天的接口凭空消失。 */
export const UNIFIED_API_LIBRARY_BACKUP_KEY = 'CULTIVATION_API_LIBRARY_V1__bak';

/* ============================================================
 * ★★★ 2026-11-04 玩家：
 *   「你两边也不能孤立啊，对应的接口我已经手动填写的你要检测到
 *     然后显示在统一接口配置那里啊，不要我手动填了，你统一配置那里还说是空的」
 *
 * 【真正的根因】不是参数传错，是**两套完全不同的存储**：
 *   · 各子系统设置页里填的配置 → dbSet(depot) → **IndexedDB**
 *   · 统一接口配置读的        → localStorage.getItem → **localStorage**
 *   两者毫无交集，所以接口库永远看不到玩家已经填好的东西。
 *
 * 【为什么要有这层缓存】
 *   dbGet 是 async，而这个模块的读取接口（resolveApiFor / listApiBindings）
 *   必须是同步的（各子系统的请求路径没法都改成 await）。
 *   所以：启动时把 IndexedDB 里的配置**镜像到内存缓存**，
 *   之后的同步读取走缓存；写入时双写 localStorage + IndexedDB。
 *
 *   缓存来源由 main.js 注入（它才有 db 句柄），见 hydrateFromDb。
 * ============================================================ */
const DB_MIRROR = Object.create(null);
const CONFIG_REVISIONS = Object.create(null);
export function apiConfigRevision(key) { return CONFIG_REVISIONS[key] || 0; }
const DIRTY_CONSUMERS = new Set();
const PENDING_DB_WRITES = new Set();

/**
 * 用 IndexedDB 里已存的配置填充内存镜像。
 * main.js 在启动和打开设置面板时会调用；调用前后行为一致，可重复调用。
 *
 * @param {object} snapshot { [storageKey]: configObject }
 */
export function hydrateFromDb(snapshot, expectedRevisions) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  let n = 0;
  for (const k of Object.keys(snapshot)) {
    if (expectedRevisions && expectedRevisions[k] !== apiConfigRevision(k)) continue;
    DB_MIRROR[k] = snapshot[k];
    CONFIG_REVISIONS[k] = apiConfigRevision(k) + 1;
    n++;
  }
  return n;
}

/** 内存镜像是否已有该键（供排查用） */
export function hasMirrored(consumerKey) {
  return Object.prototype.hasOwnProperty.call(DB_MIRROR, consumerKey);
}

/** 默认空库 */
export function emptyApiLibrary() {
  return { presets: [], updatedAt: 0 };
}

function genId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/** 规范化 URL：去首尾空白、去末尾斜杠 */
export function normalizeApiUrl(url) {
  return String(url == null ? '' : url).trim().replace(/\/+$/, '');
}

export function modelEndpoint(apiUrl, operation) {
  const url = new URL(apiUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/' + operation)) {
    url.pathname = pathname;
    return url.href;
  }
  pathname = pathname.replace(/\/(?:chat\/completions|embeddings|rerank|images\/(?:generations|edits)|models)$/i, '');
  if (!/\/v\d+(?:beta\d*)?(?:\/openai)?$/i.test(pathname)) pathname += '/v1';
  url.pathname = pathname + '/' + operation;
  return url.href;
}

export const imageSizes = ['1024x1024', '1536x1024', '1920x1280', '1024x1536', '2048x2048',
  '2048x1152', '2560x1440', '1440x2560', '3840x2160', '2160x3840'];
const imageAttempts = new Map();
const requestKindLabels = {chat:'文本', embeddings:'向量', rerank:'重排序', image:'生图'};
const positiveInteger = (raw, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(Number(raw)) && Number(raw) > 0 && Number(raw) <= max ? Number(raw) : undefined;

export function normalizeImageRequestProfile(value = {}) {
  const size = String(value?.size || '').trim().toLowerCase().replace(/\s*[x×]\s*/g, 'x');
  const { quality, outputFormat } = value || {};
  const timeoutSeconds = positiveInteger(value?.timeoutSeconds, 4294967);
  const rpm = positiveInteger(value?.rpm);
  return {
    ...(/^(?:auto|[1-9]\d*x[1-9]\d*)$/.test(size) ? {size} : {}),
    ...(['auto','low','medium','high','xhigh','max'].includes(quality) ? {quality} : {}),
    ...(['png','jpeg','webp'].includes(outputFormat) ? {outputFormat} : {}),
    ...(timeoutSeconds ? {timeoutSeconds} : {}),
    ...(rpm ? {rpm} : {}),
  };
}

function normalizeEmbeddingProfile(value) {
  const dimensions = positiveInteger(value?.dimensions);
  return dimensions ? {dimensions} : {};
}

function normalizeRerankProfile(value) {
  const maxDocuments = positiveInteger(value?.maxDocuments);
  return maxDocuments ? {maxDocuments} : {};
}

export function embeddingRequestBody(model, input, route) {
  return {model, input, ...normalizeEmbeddingProfile(route?.embeddingProfile)};
}

export function rerankRequestBody(model, query, documents) {
  return {model, query, documents, top_n:documents.length};
}

export function imageRouteConfig(fallback, route) {
  return {
    ...fallback,
    apiUrl:route.apiUrl, apiKey:route.apiKey, apiModel:route.apiModel,
    ...normalizeImageRequestProfile(route.imageRequestProfile),
    imageRouteId:route.id || fallback.imageRouteId,
  };
}

export function takeImageRouteSlot(config) {
  if (!config.imageRouteId || !config.rpm) return;
  const now = Date.now();
  const recent = (imageAttempts.get(config.imageRouteId) || []).filter(time => now - time < 60000);
  if (recent.length >= config.rpm) throw new Error('此生图线路已达每分钟请求上限');
  recent.push(now);
  imageAttempts.set(config.imageRouteId, recent);
}

export function imageRequestSignal(config, signal) {
  if (!config.timeoutSeconds) return signal;
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
  return signal ? AbortSignal.any([signal,timeout]) : timeout;
}

export function gptImageRequestBody(config, prompt) {
  return {model:config.apiModel, prompt:prompt.trim(), size:config.size || '1024x1024',
    quality:config.quality || 'high', background:config.background || 'auto', output_format:config.outputFormat || 'png'};
}

function consumerRequestKind(consumer) {
  const slot = consumer?.slotId || consumer?.idField || '';
  if (slot === 'embeddingApiPresetId') return 'embeddings';
  if (/rerank/i.test(slot)) return 'rerank';
  if (/^(providers|imageProviderConfigs)\./.test(slot)) return 'image';
  return 'chat';
}

function probeKind(consumer, url, model) {
  if (consumer) return consumerRequestKind(consumer);
  let pathname = '';
  try { pathname = new URL(url).pathname.replace(/\/+$/, ''); } catch (_) {}
  if (/\/rerank$/i.test(pathname) || /rerank/i.test(model)) return 'rerank';
  if (/\/embeddings$/i.test(pathname) || /embedding|(?:^|[/-])bge-|(?:^|[/-])m3e-/i.test(model)) return 'embeddings';
  if (/\/images\/(?:generations|edits)$/i.test(pathname) ||
      /(?:gpt-image|chatgpt-image|dall-e|seedream|grok-imagine|nano-banana|gemini.*-image)/i.test(model)) return 'image';
  return 'chat';
}

function presetRequestKind(preset, consumer) {
  if (Object.hasOwn(requestKindLabels,preset?.requestKind)) return preset.requestKind;
  if (consumer) return consumerRequestKind(consumer);
  if (preset?.id) {
    const kinds = new Set(listApiConsumers().filter(row => (savedApiChain(row) || []).includes(preset.id))
      .map(consumerRequestKind));
    if (kinds.size === 1) return [...kinds][0];
  }
  return probeKind(null,preset?.apiUrl,preset?.apiModel);
}

function normalizeTypedFields(value) {
  return {
    ...(Object.hasOwn(requestKindLabels,value?.requestKind)?{requestKind:value.requestKind}:{}),
    ...(value?.imageRequestProfile?{imageRequestProfile:normalizeImageRequestProfile(value.imageRequestProfile)}:{}),
    ...(value?.embeddingProfile?{embeddingProfile:normalizeEmbeddingProfile(value.embeddingProfile)}:{}),
    ...(value?.rerankProfile?{rerankProfile:normalizeRerankProfile(value.rerankProfile)}:{})
  };
}

/** 一条接口是否填完整（URL / Key / 模型 三项都要） */
/**
 * 这条接口是否「填完整、可以直接用」。
 *
 * ★★★ 2026-11-04 修正判断口径。
 *
 * 【原来错在哪】这里要求 apiUrl + apiKey + **apiModel** 三者齐全。
 *   但玩家明确说了：「每个接口具体用哪个设置的模型应该去每个接口那里选」——
 *   模型已经归各子系统自己管了，接口条目上那个 apiModel 只是「推荐值/候选」。
 *   于是出现荒谬结果：一条地址密钥都填好、且已被变量思考正常使用的接口，
 *   列表里却标着「（缺地址或密钥）」，玩家会以为自己配错了。
 *
 * 【现在】接口是否可用，只看**地址 + 密钥**这两样它必须提供的。
 *   模型不参与判断 —— 缺模型不是错误，各子系统各自会选。
 */
export function apiPresetComplete(preset) {
  if (!preset || typeof preset !== 'object') return false;
  return Boolean(
    normalizeApiUrl(preset.apiUrl)
    && String(preset.apiKey || '').trim()
  );
}

/** 读取整个库
 *
 * ★★★ 2026-11-04 玩家：「怎么每次你重新构建我填好的模型都没了，是不是没有做持久化？」
 *
 * 【查到的事实】
 *   · localStorage 本身没问题：测量发现填完立即读得到，优雅关闭重启后也在。
 *   · 真正丢数据的原因是我这边：我每次改动都用 Stop-Process -Force 强杀进程。
 *     Chromium 的 localStorage 是异步刷 leveldb 的，强杀会丢掉末尾未落盘的写入。
 *     （实测对照：强杀 → 丢失；正常退出 → 完好。）
 *
 * 【但仍然要加固】玩家不该因为"我是怎么关的"而丢配置。
 *   所以这里加一层：主键读不到时，自动从镜像备份恢复。
 *   代价只是多占一份体积，换来的是配置不会莫名消失。
 */
export function loadApiLibrary() {
  try {
    let raw = localStorage.getItem(UNIFIED_API_LIBRARY_KEY);
    let fromBackup = false;
    if (!raw) {
      // 主键没了 → 试试镜像备份，并立刻回填主键
      raw = localStorage.getItem(UNIFIED_API_LIBRARY_BACKUP_KEY);
      fromBackup = !!raw;
    }
    if (!raw) return emptyApiLibrary();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyApiLibrary();
    const presets = Array.isArray(parsed.presets) ? parsed.presets : [];
    const result = {
      presets: presets
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          id: String(p.id || genId()),
          name: String(p.name || '未命名接口'),
          // 保留幂等令牌，否则重复保存的防护会失效
          editToken: String(p.editToken || ''),
          apiUrl: normalizeApiUrl(p.apiUrl),
          apiKey: String(p.apiKey || '').trim(),
          apiModel: String(p.apiModel || '').trim(),
          apiModels: Array.isArray(p.apiModels) ? p.apiModels : [],
          ...(p.requestProfile?{requestProfile:normalizeChatRequestProfile(p.requestProfile)}:{}),
          ...normalizeTypedFields(p),
          ...(p.enabled===false?{enabled:false}:{}),
          note: String(p.note || ''),
          updatedAt: Number(p.updatedAt) || 0,
        })),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
    if (fromBackup && result.presets.length) {
      try {
        localStorage.setItem(UNIFIED_API_LIBRARY_KEY, JSON.stringify(result));
        console.warn('[API 接口库] 主存储为空，已从备份恢复 ' + result.presets.length + ' 条接口');
      } catch (_) {}
    }
    return result;
  } catch (_) {
    return emptyApiLibrary();
  }
}

/** 保存整个库 */
export function saveApiLibrary(lib) {
  const next = {
    presets: Array.isArray(lib && lib.presets) ? lib.presets : [],
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(UNIFIED_API_LIBRARY_KEY, JSON.stringify(next));
    // 镜像备份：主键被异常清掉时可恢复（见 loadApiLibrary）
    localStorage.setItem(UNIFIED_API_LIBRARY_BACKUP_KEY, JSON.stringify(next));
  } catch (_) {}
  return next;
}

/** 新增一条接口
 *
 * ★★★ 2026-11-04 玩家：「我就填一个怎么出了四个」
 *
 * 【为什么会出四条】
 *   界面用一个「防重复绑定」标记来保证监听器只挂一次。
 *   一旦这个标记失效（旧版本残留、热更新、测试脚本清理等），
 *   保存按钮上就会挂着多份监听器，点一下执行 N 次 → 存进 N 条。
 *   靠「标记不出错」来保证正确性太脆弱 —— 只要漏一次就坏。
 *
 * 【改法】让保存本身幂等：
 *   同一个编辑器会话内（同一个 editToken），重复保存只更新那一条，
 *   不会再插入新的。哪怕监听器真的挂了三份，结果也还是一条。
 *
 *   这是「机制兜底」而不是「防住重复调用」：
 *   不依赖任何标记是否可靠，才敢说这类问题不会再复发。
 */
export function addApiPreset(patch, editToken) {
  const lib = loadApiLibrary();
  const token = String((patch && patch.editToken) || editToken || '').trim();
  // 同一个编辑器会话已存过 → 直接更新那条，不新增
  if (token) {
    const exist = lib.presets.find((p) => p && p.editToken === token);
    if (exist) return updateApiPreset(exist.id, patch || {});
  }
  const preset = {
    id: genId(),
    // 记下来源会话，供上面的幂等判断用
    editToken: token || '',
    name: String((patch && patch.name) || '').trim() || ('接口 ' + (lib.presets.length + 1)),
    apiUrl: normalizeApiUrl(patch && patch.apiUrl),
    apiKey: String((patch && patch.apiKey) || '').trim(),
    apiModel: String((patch && patch.apiModel) || '').trim(),
    apiModels: Array.isArray(patch && patch.apiModels) ? patch.apiModels : [],
    requestProfile: normalizeChatRequestProfile(patch?.requestProfile),
    ...normalizeTypedFields(patch),
    enabled: patch?.enabled !== false,
    note: String((patch && patch.note) || ''),
    updatedAt: Date.now(),
  };
  lib.presets.push(preset);
  saveApiLibrary(lib);
  return preset;
}

/** 修改一条接口 */
export function updateApiPreset(id, patch) {
  const lib = loadApiLibrary();
  const idx = lib.presets.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const merged = { ...lib.presets[idx], ...(patch || {}), id, updatedAt: Date.now() };
  merged.apiUrl = normalizeApiUrl(merged.apiUrl);
  merged.apiKey = String(merged.apiKey || '').trim();
  merged.apiModel = String(merged.apiModel || '').trim();
  merged.requestProfile = normalizeChatRequestProfile(merged.requestProfile);
  Object.assign(merged,normalizeTypedFields(merged));
  lib.presets[idx] = merged;
  saveApiLibrary(lib);
  for (const consumer of listApiConsumers()) {
    const raw = readConsumerRaw(consumer);
    if (!raw) continue;
    const scope = consumerScope(raw, consumer);
    if (String(scope[consumer.idField] || '') !== String(id)) continue;
    const resolved = resolveConsumerConfig(consumer.key, raw);
    if (resolved !== raw) {
      writeConsumerRaw(consumer, resolved);
      syncConsumerNativeForm(consumer, raw, resolved);
    }
  }
  return merged;
}

/** 删除一条接口；同时返回仍引用它的地方，供界面提示 */
export function removeApiPreset(id) {
  const lib = loadApiLibrary();
  lib.presets = lib.presets.filter((p) => p.id !== id);
  saveApiLibrary(lib);
  return lib;
}

/** 按 id 取一条 */
export function getApiPreset(id) {
  if (!id) return null;
  const lib = loadApiLibrary();
  return lib.presets.find((p) => p.id === id) || null;
}

/**
 * 需要「从库里挑一条」的子系统清单。
 *
 * key      —— 该子系统在 localStorage 里的配置键
 * idField  —— 把选中的接口 id 记在这个字段上
 * nested   —— 少数配置是嵌套的（原著补演的独立接口在 .api 下）
 * urlField / keyField / modelField —— 该子系统自己的字段名
 *   （不同子系统字段名各不相同，必须如实写出来，否则判断「填没填」会错）
 * scope    —— 该配置里是**多套独立接口**时，指定读哪一段
 *   （世界档案 & 向量 就是这种：它内部有 4 套互不相干的接口）
 *
 * ★★★ 2026-11-04 玩家：
 *   「年表系统你都忘了，还有其他所有需要api调用的地方，都复盘一下，
 *     而且向量系统是好几个接口，每个接口你都必须有设置，不能混在一起，
 *     比如向量系统需要三种不同的模型，普通的文本模型，向量模型还有重排序模型」
 *
 * 【之前漏了什么】
 *   · 年表推断（WORLD_EVOLUTION_TIMELINE_CONFIG_V1 的 time_infer_api_*）
 *   · 向量系统其实不是一个接口，是四套：
 *       ① 检索分析用文本模型   ② 向量化 embedding
 *       ③ 入库/检索用文本模型  ④ rerank 重排序
 *     把四套糊成「世界档案 & 向量」一条，等于让玩家没法分别配置 ——
 *     而它们的地址、密钥、模型本来就是分开填的。
 */
const DEFAULT_FIELDS = { urlField: 'apiUrl', keyField: 'apiKey', modelField: 'apiModel' };

export const API_LIBRARY_CONSUMERS = [
  {
    label: '正文生成', key: 'FR_STANDALONE_CONFIG_V1', storage: 'local',
    idField: 'apiPresetId', urlField: 'apiUrl', keyField: 'apiKey', modelField: 'model',
  },
  {
    label: '世界观指导', key: 'FR_WV_CONFIG_V1', storage: 'local',
    fallbackKey: 'FR_STANDALONE_CONFIG_V1',
    idField: 'apiPresetId', urlField: 'apiUrl', keyField: 'apiKey', modelField: 'model',
  },
  {
    label: '小剧场／日报', key: 'FR_THEATER_API_BINDING_V1', storage: 'local',
    storageFields: { apiUrl: 'theater_apiEndpoint', apiKey: 'theater_apiKey', apiModel: 'theater_apiModel' },
    idField: 'apiPresetId', ...DEFAULT_FIELDS,
  },
  {
    label: '肖像提示词生成（文本模型）', key: 'CULTIVATION_PORTRAIT_GEN_CONFIG_V1',
    idField: 'llmApiPresetId', urlField: 'llmApiUrl', keyField: 'llmApiKey', modelField: 'llmApiModel', group: '肖像生成',
  },
  {
    label: '原著资料重排', key: 'CULTIVATION_CANON_BRIDGE_CONFIG_V1',
    idField: 'retrievalRerankApiPresetId', urlField: 'retrievalRerankUrl', keyField: 'retrievalRerankKey', modelField: 'retrievalRerankModel', group: '原著补演',
  },
  {
    label: '变量演化',
    key: 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
  },
  {
    label: '变量演化 · 原著年表摘要',
    key: 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1',
    idField: 'originalTimelineApiPresetId',
    urlField: 'originalTimelineApiUrl', keyField: 'originalTimelineApiKey', modelField: 'originalTimelineApiModel',
  },
  {
    label: '正文插图分镜',
    key: 'FR_STORY_IMAGE_PLANNER_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
  },
  {
    label: '正文优化（图片打标）',
    key: 'CULTIVATION_IMAGE_TAGGING_API_CONFIG_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
  },
  {
    label: '世界演化',
    key: 'CULTIVATION_WORLD_EVOLUTION_API_CONFIG_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
  },
  {
    /* 年表：字段名是 time_infer_api_*，和其他子系统都不同。
     * 这是之前完全漏掉的一处真实 API 调用（用于推断当前该用哪条年表）。
     * ★ 2026-11-04 修正键名：真实存储键是 _PROMPT_CONFIG_ 那个，
     *   我先前写的 WORLD_EVOLUTION_TIMELINE_CONFIG_V1 是另一个键，
     *   玩家填的数据在 PROMPT 键里，所以一直读不到。 */
    label: '世界年表（时间推断）',
    key: 'WORLD_EVOLUTION_TIMELINE_PROMPT_CONFIG_V1',
    idField: 'timeInferApiPresetId',
    urlField: 'time_infer_api_url',
    keyField: 'time_infer_api_key',
    modelField: 'time_infer_api_model',
    group: '世界年表',
  },

  /* ---- 世界档案 & 向量：四套独立接口，分别登记 ---- */
  {
    label: '档案检索分析（文本模型）',
    key: 'CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
    group: '世界档案 & 向量',
  },
  {
    label: '向量化（Embedding 模型）',
    key: 'CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2',
    idField: 'embeddingApiPresetId',
    urlField: 'embeddingUrl',
    keyField: 'embeddingKey',
    modelField: 'embeddingModel',
    group: '世界档案 & 向量',
  },
  {
    label: '档案二次检索（文本模型）',
    key: 'CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2',
    idField: 'vectorSearchApiPresetId',
    urlField: 'vectorSearchApiUrl',
    keyField: 'vectorSearchApiKey',
    modelField: 'vectorSearchApiModel',
    group: '世界档案 & 向量',
  },
  {
    label: '档案入库（文本模型）',
    key: 'CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2',
    idField: 'vectorSaveApiPresetId',
    urlField: 'vectorSaveApiUrl',
    keyField: 'vectorSaveApiKey',
    modelField: 'vectorSaveApiModel',
    group: '世界档案 & 向量',
  },
  {
    label: '重排序（Rerank 模型）',
    key: 'CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2',
    idField: 'rerankApiPresetId',
    urlField: 'rerankUrl',
    keyField: 'rerankKey',
    modelField: 'rerankModel',
    group: '世界档案 & 向量',
  },

  {
    /* 摘要/总结：也是真实发起 API 调用的独立配置。
     * ★ 2026-11-04 盘点时发现玩家已填了它（apiUrl+apiKey+apiModel），
     *   但之前清单里漏了，等于玩家填了却不被识别。 */
    label: '摘要生成',
    key: 'CULTIVATION_SUMMARY_CONFIG_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
    group: '摘要与续写',
  },

  {
    label: '原著补演（独立接口）',
    key: 'CULTIVATION_CANON_BRIDGE_CONFIG_V1',
    idField: 'apiPresetId',
    ...DEFAULT_FIELDS,
    nested: 'api',
    fallbackKey: 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1',
  },
  ...['doubao', 'openai', 'gemini', 'grok', 'custom_openai'].map(provider => ({
    label: '肖像生图 · ' + (provider === 'openai' ? 'GPT Image' : provider),
    key: 'CULTIVATION_PORTRAIT_GEN_CONFIG_V1',
    idField: 'apiPresetId', slotId: 'providers.' + provider,
    path: ['providers', provider], ...DEFAULT_FIELDS, group: '肖像生图（按供应商）',
  })),
  ...['doubao', 'openai', 'gemini', 'custom_openai'].map(provider => ({
    label: '正文插图 · ' + (provider === 'openai' ? 'GPT Image' : provider),
    key: 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1',
    idField: 'apiPresetId', slotId: 'imageProviderConfigs.' + provider,
    path: ['imageProviderConfigs', provider], ...DEFAULT_FIELDS, group: '变量演化生图（按供应商）',
  })),
];

/**
 * 读某个接口位背后那份配置文件。
 *
 * ★★★ 读取顺序（这个顺序是修「统一配置看不到手动填的内容」的关键）：
 *   ① 内存镜像 DB_MIRROR —— 它是从 **IndexedDB** 灌进来的，
 *      才是各子系统设置页真正写的地方，权威来源。
 *   ② localStorage —— 兼容老数据和本模块自己写过的。
 *   ③ localStorage 的 __bak —— 兜底。
 *
 * 【之前错在哪】只读 localStorage。而玩家在子系统设置页里填的东西
 *   走的是 dbSet → IndexedDB，两套存储毫无交集，
 *   于是「我明明填了，统一配置那里还说是空的」。
 */
function readConsumerRaw(consumer) {
  try {
    const fields = API_LIBRARY_CONSUMERS.find(item => item.key === consumer.key)?.storageFields;
    if (fields) {
      const raw = JSON.parse(localStorage.getItem(consumer.key) || '{}');
      for (const [field, key] of Object.entries(fields)) raw[field] = localStorage.getItem(key) || '';
      return raw;
    }
    // ① IndexedDB 镜像优先
    const mirror = DB_MIRROR[consumer.key];
    if (!isLocalConsumer(consumer) && mirror && typeof mirror === 'object') {
      // hydrateFromDb 是 IndexedDB 的最新快照；旧 localStorage 不能盖回已保存/重置的字段。
      return mirror;
    }

    let raw = localStorage.getItem(consumer.key);
    if (!raw) {
      // 主键读不到时尝试镜像备份（见 readConsumerRaw 下方的 writeConsumerRaw）
      raw = localStorage.getItem(consumer.key + '__bak');
      if (raw) {
        try {
          localStorage.setItem(consumer.key, raw);
          console.warn('[API 接口库] ' + consumer.key + ' 主存储为空，已从备份恢复');
        } catch (_) {}
      }
    }
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 写某个接口位的配置。
 *
 * ★★★ 2026-11-04 玩家：「怎么每次你重新构建我填好的模型都没了，是不是没有做持久化？」
 *
 * 【查到的事实】配置是被**强杀进程**丢的：Chromium 的 localStorage
 *   异步刷 leveldb，Stop-Process -Force 会丢掉尚未落盘的尾部写入。
 *   实测对照：强杀→丢；正常退出→完好。也就是说 localStorage 本身没问题。
 *
 * 【但这仍需要防护】玩家不该因为"程序是怎么退出的"而丢配置。
 *   所以每次写入都同时写一份镜像备份；下次读取时主键为空自动从备份恢复。
 *   代价是多一份体积，换来配置不会莫名消失。
 */
function writeConsumerRaw(consumer, raw) {
  const fields = API_LIBRARY_CONSUMERS.find(item => item.key === consumer.key)?.storageFields;
  if (fields) for (const [field, key] of Object.entries(fields)) localStorage.setItem(key, String(raw[field] || ''));
  const json = JSON.stringify(raw);
  // ① 立刻更新内存镜像，保证同一次会话里其它读点立刻看到新值
  DB_MIRROR[consumer.key] = raw;
  CONFIG_REVISIONS[consumer.key] = apiConfigRevision(consumer.key) + 1;
  if (!isLocalConsumer(consumer)) DIRTY_CONSUMERS.add(consumer.key);
  // ② localStorage（同步，兼容旧路径与备份机制）
  localStorage.setItem(consumer.key, json);
  try { localStorage.setItem(consumer.key + '__bak', json); } catch (_) {}
  /* ③ 回写 IndexedDB —— 这才是各子系统真正读配置的地方。
   *    不写回去的话：这里改了，子系统下次从 IndexedDB 读到的还是旧值，
   *    等于改了不生效。异步交给 main.js 注入的写回函数。 */
  try {
    if (!isLocalConsumer(consumer) && typeof DB_WRITER === 'function') {
      const pending = Promise.resolve(DB_WRITER(consumer.key, raw));
      PENDING_DB_WRITES.add(pending);
      pending.then(() => PENDING_DB_WRITES.delete(pending), e => {
        PENDING_DB_WRITES.delete(pending);
        console.warn('[API 接口库] 回写 IndexedDB 失败：' + (e && e.message ? e.message : e));
      });
    }
  } catch (e) {
    console.warn('[API 接口库] 回写 IndexedDB 异常：' + (e && e.message ? e.message : e));
  }
  // 同一份配置文件有多个接口位时会重复写同一个 key，这里幂等，无副作用
}

/* 由 main.js 注入的「写回 IndexedDB」函数 */
let DB_WRITER = null;

function isLocalConsumer(consumer) {
  return consumer.storage === 'local' || API_LIBRARY_CONSUMERS.some(item => item.key === consumer.key && item.storage === 'local');
}

// Each vector/provider/backup slot keeps its own explicit opt-out from automatic adoption.
function manualModeField(consumer) { return (consumer.idField || 'apiPresetId') + 'Manual'; }

function snapshotField(consumer) { return (consumer.idField || 'apiPresetId').replace(/Id$/, 'Snapshot'); }

/**
 * 注入 IndexedDB 写回函数。
 * main.js 里有 db 句柄，它把 (key, value) => dbSet(key, value) 传进来。
 * @param {(key:string, value:any)=>Promise<any>} fn
 */
export function setDbWriter(fn) {
  DB_WRITER = typeof fn === 'function' ? fn : null;
  return !!DB_WRITER;
}

/** Explicit confirmation waits for actual database writes; a failed write stays retryable. */
export async function saveApiSettings() {
  await Promise.allSettled(Array.from(PENDING_DB_WRITES));
  const library = JSON.stringify(loadApiLibrary());
  localStorage.setItem(UNIFIED_API_LIBRARY_KEY, library);
  localStorage.setItem(UNIFIED_API_LIBRARY_BACKUP_KEY, library);
  while (DIRTY_CONSUMERS.size) {
    if (typeof DB_WRITER !== 'function') throw new Error('本地数据库尚未就绪');
    for (const key of Array.from(DIRTY_CONSUMERS)) {
      const current = DB_MIRROR[key];
      const result = await DB_WRITER(key, current);
      if (result === false) throw new Error('本地数据库写入失败');
      localStorage.setItem(key, JSON.stringify(current));
      localStorage.setItem(key + '__bak', JSON.stringify(current));
      if (DB_MIRROR[key] === current) DIRTY_CONSUMERS.delete(key);
    }
  }
  return { ok: true };
}

function consumerScope(raw, consumer) {
  let scope = raw;
  for (const segment of consumer.path || (consumer.nested ? [consumer.nested] : [])) {
    scope = scope && scope[segment];
  }
  return scope && typeof scope === 'object' ? scope : {};
}

function writeScope(raw, consumer, patch) {
  const path = consumer.path || (consumer.nested ? [consumer.nested] : []);
  const clone = value => Array.isArray(value) ? value.slice() : { ...(value || {}) };
  const result = clone(raw);
  let target = result;
  for (let i = 0; i < path.length; i++) {
    const part = path[i];
    target[part] = target[part] ? clone(target[part]) : (typeof path[i + 1] === 'number' ? [] : {});
    target = target[part];
  }
  Object.assign(target, patch);
  return result;
}

// Only replace untouched native form values. A player's unsaved edits win.
function syncConsumerNativeForm(consumer, before, after, explicit = false) {
  if (typeof document === 'undefined') return;
  const fields = nativeConsumerFields(consumer);
  if (!fields) return;
  const old = readOwnTriplet(consumerScope(before, consumer), consumer);
  const next = readOwnTriplet(consumerScope(after, consumer), consumer);
  if (!explicit && fields.some((id, index) => {
    const input = document.getElementById(id);
    return input && String(input.value || '').trim() !== old[['url', 'key', 'model'][index]];
  })) return;
  fields.forEach((id, index) => {
    const input = document.getElementById(id);
    const name = ['url', 'key', 'model'][index];
    if (!input) return;
    if (name === 'model' && input.tagName === 'SELECT' && !Array.from(input.options).some(option => option.value === next.model)) {
      const option = document.createElement('option');option.value = next.model;option.textContent = next.model;input.append(option);
    }
    input.value = next[name];
  });
}

function nativeConsumerFields(consumer) {
  const ids = {
    FR_STANDALONE_CONFIG_V1: ['prose-api-url', 'prose-api-key', 'prose-api-model'],
    FR_WV_CONFIG_V1: ['wv-api-url', 'wv-api-key', 'wv-api-model'],
    FR_THEATER_API_BINDING_V1: ['api-endpoint-input', 'api-key-input', 'api-model-select'],
    CULTIVATION_PORTRAIT_GEN_CONFIG_V1: { llmApiPresetId: ['pg-llm-url', 'pg-llm-key', 'pg-llm-model'] },
    CULTIVATION_IMAGE_TAGGING_API_CONFIG_V1: ['image-tagging-api-url', 'image-tagging-api-key', 'image-tagging-api-model'],
    CULTIVATION_WORLD_EVOLUTION_API_CONFIG_V1: ['world-evolution-api-url', 'world-evolution-api-key', 'world-evolution-api-model'],
    CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2: {
      apiPresetId: ['knowledge-search-api-url', 'knowledge-search-api-key', 'knowledge-search-api-model'],
      embeddingApiPresetId: ['vector-embedding-url', 'vector-embedding-key', 'vector-embedding-model'],
      vectorSearchApiPresetId: ['vector-search-api-url', 'vector-search-api-key', 'vector-search-api-model'],
      vectorSaveApiPresetId: ['vector-save-api-url', 'vector-save-api-key', 'vector-save-api-model'],
      rerankApiPresetId: ['vector-rerank-url-input', 'vector-rerank-key-input', 'vector-rerank-model-input'],
    },
    CULTIVATION_SUMMARY_CONFIG_V1: ['summary-api-url', 'summary-api-key', 'summary-api-model'],
    WORLD_EVOLUTION_TIMELINE_PROMPT_CONFIG_V1: ['world-evolution-timeline-time-infer-api-url', 'world-evolution-timeline-time-infer-api-key', 'world-evolution-timeline-time-infer-api-model'],
    CULTIVATION_CANON_BRIDGE_CONFIG_V1: {
      apiPresetId: ['ce-canon-api-url', 'ce-canon-api-key', 'ce-canon-api-model'],
      retrievalRerankApiPresetId: ['ce-canon-retrieval-rerank-url', 'ce-canon-retrieval-rerank-key', 'ce-canon-retrieval-rerank-model'],
    },
  };
  const entry = ids[consumer.key];
  let fields = Array.isArray(entry) ? entry : entry && entry[consumer.idField];
  if (consumer.key === 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1') {
    if (!consumer.path || consumer.path[0] === 'backupApiConfigs') {
      const index = consumer.path ? Number(consumer.path[1]) + 1 : 0;
      fields = ['backup-api-url-' + index, 'backup-api-key-' + index, 'backup-api-model-' + index];
    } else if (consumer.path[0] === 'imageProviderConfigs' && document.getElementById('concurrent-evo-image-api-provider')?.value === consumer.path[1]) {
      const model = consumer.path[1] === 'doubao' ? 'concurrent-evo-image-api-model' : consumer.path[1] === 'custom_openai' ? 'concurrent-evo-image-api-model-custom-select' : 'concurrent-evo-image-api-model-text';
      fields = ['concurrent-evo-image-api-url', 'concurrent-evo-image-api-key', model];
    }
  }
  if (consumer.key === 'CULTIVATION_PORTRAIT_GEN_CONFIG_V1' && document.getElementById('pg-provider')?.value === consumer.path?.[1]) fields = ['pg-api-url', 'pg-api-key', 'pg-api-model'];
  return fields;
}

/** Enumerate saved backup slots and providers; adding a backup stays on its native page. */
export function listApiConsumers(configKey, config) {
  const consumers = API_LIBRARY_CONSUMERS.slice();
  const evolutionKey = 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1';
  for (const [key, field, label, group] of [
    ['CULTIVATION_PORTRAIT_GEN_CONFIG_V1', 'providers', '肖像生图', '肖像生图（按供应商）'],
    [evolutionKey, 'imageProviderConfigs', '变量演化生图', '变量演化生图（按供应商）'],
  ]) {
    const current = configKey === key && config ? config : readConsumerRaw({ key });
    const providers = current && current[field];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) continue;
    for (const provider of Object.keys(providers)) {
      if (['__proto__', 'prototype', 'constructor'].includes(provider)) continue;
      const slotId = field + '.' + provider;
      if (consumers.some(c => c.key === key && c.slotId === slotId)) continue;
      if (!providers[provider] || typeof providers[provider] !== 'object') continue;
      consumers.push({ key, label: label + ' · ' + provider, idField: 'apiPresetId',
        slotId, path: [field, provider], ...DEFAULT_FIELDS, group });
    }
  }
  const raw = configKey === evolutionKey && config ? config : readConsumerRaw({ key: evolutionKey });
  const backups = raw && Array.isArray(raw.backupApiConfigs) ? raw.backupApiConfigs : [];
  for (let index = 0; index < backups.length; index++) {
    consumers.push({ key: evolutionKey, label: '变量演化备用 ' + (index + 1),
      idField: 'apiPresetId', slotId: 'backupApiConfigs.' + index,
      path: ['backupApiConfigs', index], ...DEFAULT_FIELDS, group: '变量演化备用（按尝试顺序）' });
  }
  return configKey ? consumers.filter(c => c.key === configKey) : consumers;
}

/** Materialize references for legacy request consumers without changing model or provider. */
export function resolveConsumerConfig(key, config) {
  let raw = config && typeof config === 'object' ? config : {};
  for (const consumer of listApiConsumers(key, raw)) {
    const chain = savedApiChain(consumer);
    if (chain) {
      const primary = materializeChain(chain, consumer)[0];
      raw = writeScope(raw, consumer, {
        [consumer.urlField]: primary?.apiUrl || '', [consumer.keyField]: primary?.apiKey || '',
        [consumer.modelField]: primary?.apiModel || '',
      });
      continue;
    }
    const scope = consumerScope(raw, consumer);
    const trio = readOwnTriplet(scope, consumer);
    if (trio.manual || !trio.presetId) continue;
    const preset = getApiPreset(trio.presetId);
    const snapshot = trio.snapshot;
    const matches = snapshot && normalizeApiUrl(trio.url) === normalizeApiUrl(snapshot.apiUrl)
      && trio.key === String(snapshot.apiKey || '').trim();
    if (!preset || (trio.url && trio.key && !matches)) continue;
    raw = writeScope(raw, consumer, {
      [consumer.urlField]: preset.apiUrl, [consumer.keyField]: preset.apiKey,
      [snapshotField(consumer)]: { apiUrl: preset.apiUrl, apiKey: preset.apiKey },
    });
  }
  return raw;
}

/** 从某子系统的 scope 里按它自己的字段名取出 url/key/model */
function readOwnTriplet(scope, consumer) {
  const s = scope || {};
  return {
    url: String(s[consumer.urlField || 'apiUrl'] || '').trim(),
    key: String(s[consumer.keyField || 'apiKey'] || '').trim(),
    model: String(s[consumer.modelField || 'apiModel'] || '').trim(),
    presetId: String(s[consumer.idField || 'apiPresetId'] || '').trim(),
    snapshot: Object.prototype.hasOwnProperty.call(s, snapshotField(consumer)) ? s[snapshotField(consumer)] : s.apiPresetSnapshot || null,
    manual: s[manualModeField(consumer)] === true,
  };
}

/**
 * 核心：解析某个「接口位」最终该用哪套接口。
 *
 * 优先级（故意这样排）：
 *   ① 自己手动填全了地址+密钥 → 用自己那份（玩家显式写的，最高优先，绝不改动）
 *   ② 选了库里的某条 → 地址/密钥用库里那条（实时读，库里改了立刻生效）
 *   ③ 都没有 → 返回空，交给调用方报错
 *
 * ★★★ 2026-11-04 玩家：「每个接口具体用哪个设置的模型应该去每个接口那里选」
 *
 * 【上一版错在哪】我把模型当成接口条目自身的属性（库里填一次，所有用它的
 *   子系统都用同一个模型）。实际上同一个接口下，变量思考想用 flash、
 *   世界演化想用 pro，是完全合理的 —— 模型该由**每个接口位自己**定。
 *
 * 【现在的分工】
 *   · 库只管「地址 + 密钥」（+ 一条可选的推荐模型列表，仅作候选）
 *   · 模型由该接口位自己的 modelField 决定，优先于库里的推荐值
 *   这样同一条 dsh渠道，可以被两个子系统各用不同模型；
 *   向量系统里 embedding 和 rerank 也能各配各的模型。
 *
 * @param {object} ownConfig 该接口位自己的配置（已按 consumer 剥好）
 * @param {object} [consumer] 传入时按其字段名取值；不传则用默认 apiUrl/apiKey/apiModel
 */
/**
 * 给自动生成的配置卡起个合适的名字。
 *
 * ★ 为什么不能直接用接口位的名字：
 *   同一个地址+密钥常被多个接口位共用（实测：变量思考、向量化、重排序
 *   都填同一个 apihub 渠道）。如果按"先扫到谁就用谁的名字"，
 *   会得到「变量演化」这种让人误以为只给变量演化用的卡名。
 *
 * ★ 为什么还要带上模型：
 *   同一个地址下，向量模型和重排序模型是不同的两件事。
 *   不带模型就分不清"哪张是 Embedding、哪张是 Rerank"。
 *
 * 例：apihub.veletis.com · Qwen/Qwen3-Embedding-8B
 */
function suggestPresetName(url, model) {
  let base;
  try {
    const u = new URL(normalizeApiUrl(url));
    const host = u.hostname || '';
    // 本机地址给出更明确的提示，否则一堆 127.0.0.1 分不清
    base = /^(127\.0\.0\.1|localhost)$/i.test(host)
      ? ('本机' + (u.port ? ':' + u.port : ''))
      : host;
  } catch (_) {
    base = normalizeApiUrl(url) || '自动生成的接口';
  }
  const m = String(model || '').trim();
  return m ? (base + ' · ' + m) : base;
}

/**
 * 把某个接口位「手填的」接口收编成库里的一张配置卡。
 *
 * ★★★ 2026-11-04 玩家：「你应该自动把填写的api生成配置卡，
 *   你明白我的意思吗？这样两边才算互通」
 *
 * 【为什么非要这么做】
 *   之前的设计里，"手填"和"库里选的"是两条互不相干的路径：
 *     · 手填 → 值只存在该子系统自己的配置字段里
 *     · 库里选的 → 存一个 presetId 引用
 *   结果玩家在子系统里填完，库里空空如也，两边永远是孤岛。
 *
 * 【现在的做法】
 *   只要某个接口位填全了地址+密钥，就自动：
 *     ① 按「地址+密钥」查库里有没有同样的卡
 *     ② 有 → 复用那张卡（不会每次都新增一张，避免一填就出好几条）
 *     ③ 没有 → 新建一张，名字取该接口位的用途（如「向量化 (Embedding)」）
 *     ④ 让该接口位的 presetId 指向这张卡
 *   此后两边引用的是同一张卡：改卡 = 改所有用它的地方。
 *
 * 【去重口径】★ 2026-11-04 改过一次，原因很实在：
 *
 *   一开始按「地址 + 密钥」去重。结果出问题了 —— 玩家的 apihub 渠道
 *   在同一个配置文件里有三套用法：
 *     Embedding  Qwen/Qwen3-Embedding-8B
 *     Rerank     Qwen/Qwen3-Reranker-8B
 *     文本       gemini-3.5-flash
 *   地址密钥完全一样，只有模型不同。按地址密钥去重会把它们合成一张卡，
 *   于是"向量模型和重排序模型没被识别到" —— 实际是被合并吃掉了。
 *
 *   改成「地址 + 密钥 + 模型」三元组去重：
 *     · 完全相同的（多个接口位填一样的）→ 合成一张，不重复
 *     · 模型不同的 → 各是各的卡（向量模型一张、重排序模型一张）
 *   这才是玩家要的"每个接口都有设置，不能混在一起"。
 *
 * @param {object} consumer 接口位定义
 * @param {{url:string,key:string,model:string}} trio 手里已有的值
 * @returns {string} 命中的 presetId；无法收编时返回 ''
 */
function adoptManualToLibrary(consumer, trio) {
  if (trio.manual) return '';
  const url = normalizeApiUrl(trio.url);
  const key = String(trio.key || '').trim();
  const model = String(trio.model || '').trim();
  if (!url || !key) return '';

  // 已经有绑定且卡还在 → 还要检查它是否"对得上"
  /* ★ 这里不能再直接 return。
   *   旧版本收编时按"地址+密钥"建卡，导致向量化/重排序都指向了
   *   那张 gemini-3.5-flash 的卡 —— 但它们的模型明明是
   *   Qwen3-Embedding / Qwen3-Reranker，是完全不同的两件事。
   *   所以：卡在、且模型也一致 → 才认；模型不一致 → 重新按三元组找/建。 */
  const existingId = String(trio.presetId || '');
  if (existingId) {
    const cur = getApiPreset(existingId);
    if (cur && normalizeApiUrl(cur.apiUrl) === url && String(cur.apiKey || '').trim() === key && String(cur.apiModel || '').trim() === model
      && trio.snapshot) return existingId;
    // 模型不一致（或卡已删）→ 继续往下走，重新匹配到正确的那张卡
  }

  const lib = loadApiLibrary();
  const sameEndpoint = (p) => normalizeApiUrl(p.apiUrl) === url && String(p.apiKey || '').trim() === key;

  /* 先找「地址+密钥+模型」全同的卡 —— 这才是同一个接口的真身 */
  let hit = lib.presets.find((p) => sameEndpoint(p) && String(p.apiModel || '').trim() === model);

  /* 没有全同的，再看有没有「地址+密钥相同但还没有模型」的空卡可用。
   * 这种卡是玩家手工建的、或以前版本自动生成的，
   * 直接复用它并把模型补上，比再建一张更符合玩家预期。 */
  if (!hit && model) {
    const blank = lib.presets.find((p) => sameEndpoint(p) && !String(p.apiModel || '').trim());
    if (blank) {
      updateApiPreset(blank.id, { apiModel: model });
      hit = { ...blank, apiModel: model };
    }
  }

  let presetId;
  if (hit) {
    presetId = hit.id;
    /* 之前版本自动生成的卡用的是"先扫到的接口位名"，会得到「变量演化」
     * 这种误导性名称。这里顺手纠正：只有备注里带"自动生成"标记的才改，
     * 玩家自己命名过的（没有该标记）绝不覆盖。 */
    const autoNote = String(hit.note || '');
    if (autoNote.includes('自动生成')) {
      const better = suggestPresetName(url, model);
      if (hit.name !== better) updateApiPreset(hit.id, { name: better });
    }
    /* 候选模型列表补全：让别的接口位选这条卡时也能挑到它 */
    const models = Array.isArray(hit.apiModels) ? hit.apiModels.slice() : [];
    if (model && !models.includes(model)) {
      models.push(model);
      updateApiPreset(hit.id, { apiModels: models });
    }
  } else {
    /* 新建一张卡。
     * ★ 名字不能直接用某个接口位的用途 —— 同一地址密钥常被好几个接口位共用
     *   （实测：变量思考/向量化/重排序 都填同一个 apihub），
     *   先扫到谁就用谁的名字，会得到「变量演化」这种误导性卡名。
     *   改成按地址 + 模型给名字，一眼看出是哪个渠道的哪类模型；玩家还能改。 */
    const created = addApiPreset({
      name: suggestPresetName(url, model),
      apiUrl: url,
      apiKey: key,
      /* ★ 模型写进卡里：这里和"模型归各接口位自己管"不冲突。
       *   卡上的 apiModel 是这张卡的**身份标识**（同一个地址下区分
       *   向量模型/重排序模型/文本模型），接口位仍然可以在自己那边
       *   填不同的模型来覆盖它。 */
      apiModel: model,
      apiModels: model ? [model] : [],
      note: '由「' + (consumer.label || '') + '」里手填的接口自动生成',
      editToken: 'adopt:' + url + '|' + key + '|' + model,  // 幂等
    });
    presetId = created && created.id ? created.id : '';
  }

  if (!presetId) return '';

  /* 写入前再确认一次：要把接口位的 presetId 指到这张卡，
   * 但如果**别的接口位已经在用这张卡**、且模型不同，说明它们不是同一件事，
   * 不能都指到一张卡上 —— 那样改一个会影响另一个。 */
  try {
    const field = consumer.idField || 'apiPresetId';
    const others = listApiConsumers().filter((c) => c.key === consumer.key && (c.idField || '') !== field);
    let conflict = false;
    for (const o of others) {
      const r2 = readConsumerRaw(o);
      const s2 = consumerScope(r2, o);
      const t2 = readOwnTriplet(s2, o);
      // 同地址同密钥、但模型不同 → 是另一个接口，不能共用卡
      if (t2.url && normalizeApiUrl(t2.url) === url
        && String(t2.key || '').trim() === key
        && String(t2.model || '').trim() !== model
        && String(t2.presetId || '') === presetId) {
        conflict = true;
        break;
      }
    }
    if (conflict) {
      // 说明这张卡是别人先占的（旧版本按地址密钥建的），为当前接口单建一张
      const own = addApiPreset({
        name: suggestPresetName(url, model),
        apiUrl: url,
        apiKey: key,
        apiModel: model,
        apiModels: model ? [model] : [],
        note: '由「' + (consumer.label || '') + '」里手填的接口自动生成',
        editToken: 'adopt:' + url + '|' + key + '|' + model,
      });
      presetId = own && own.id ? own.id : presetId;
    }
  } catch (_) {}

  /* 把接口位的 presetId 指向这张卡。
   * 注意：这里**不删**它自己填的 url/key —— 玩家填的东西原样保留，
   * 万一以后要解除绑定，值还在，不会丢。 */
  try {
    const field = consumer.idField || 'apiPresetId';
    let raw = readConsumerRaw(consumer) || {};
    raw = writeScope(raw, consumer, { [field]: presetId,
      [snapshotField(consumer)]: { apiUrl: trio.url, apiKey: trio.key } });
    writeConsumerRaw(consumer, raw);
  } catch (_) {}

  return presetId;
}

/**
 * 把所有接口位手填的接口一次性收编进库。
 * 打开统一配置面板时调用 —— 这样玩家不用做任何操作就能看到配置卡。
 *
 * @returns {{adopted:number, total:number}}
 */
export function adoptAllManualApis() {
  let adopted = 0;
  const seen = new Set();
  for (const consumer of listApiConsumers()) {
    // 同一个配置文件有多个接口位（向量 4 套），每个都要单独看
    const uid = consumer.key + '::' + (consumer.slotId || consumer.idField || '');
    if (seen.has(uid)) continue;
    seen.add(uid);
    try {
      const raw = readConsumerRaw(consumer);
      const scope = consumerScope(raw, consumer);
      const trio = readOwnTriplet(scope, consumer);
      if (trio.manual || !trio.url || !trio.key) continue;
      if (trio.snapshot && trio.presetId
        && normalizeApiUrl(trio.url) === normalizeApiUrl(trio.snapshot.apiUrl)
        && trio.key === String(trio.snapshot.apiKey || '').trim()) continue;
      const before = trio.presetId;
      const id = adoptManualToLibrary(consumer, trio);
      if (id && id !== before) adopted++;
    } catch (e) {
      console.warn('[API 接口库] 收编 ' + consumer.label + ' 失败：' + (e && e.message ? e.message : e));
    }
  }
  return { adopted, total: API_LIBRARY_CONSUMERS.length };
}

export function resolveApiFor(ownConfig, consumer) {
  const own = ownConfig && typeof ownConfig === 'object' ? ownConfig : {};
  const c = consumer || DEFAULT_FIELDS;
  const trio = readOwnTriplet(own, c);
  const ownModel = trio.model;
  if (c.fallbackKey && (!trio.url || !trio.key || !ownModel)) {
    const baseConsumer = API_LIBRARY_CONSUMERS.find(item => item.key === c.fallbackKey);
    const base = baseConsumer ? resolveApiFor(readConsumerRaw(baseConsumer), baseConsumer) : {};
    const url = trio.url || base.apiUrl || '', key = trio.key || base.apiKey || '', model = ownModel || base.apiModel || '';
    if (url && key) return { apiUrl: url, apiKey: key, apiModel: model, source: 'inherit',
      presetId: trio.presetId, presetName: '', modelSource: ownModel ? 'own' : 'inherit' };
  }
  if (trio.manual) return {
    apiUrl: trio.url, apiKey: trio.key, apiModel: ownModel,
    source: trio.url && trio.key ? 'manual' : 'none', presetId: '', presetName: '',
    modelSource: ownModel ? 'own' : 'none',
  };

  /* ① 自己把地址+密钥都填全了 → 用自己这份
   *
   * ★★★ 2026-11-04 玩家：「你应该自动把填写的api生成配置卡，
   *   你明白我的意思吗？这样两边才算互通」
   *
   * 关键变化：手填的接口**不再是一个孤立的私有值**。
   *   adoptManualToLibrary() 会把它收编成库里的一张配置卡（按地址+密钥去重），
   *   并把这个接口位的 presetId 指向那张卡。
   *   于是：
   *     · 界面列表里出现这张卡，可以改、可以给别的子系统用
   *     · 以后改卡 = 改所有引用它的地方
   *     · 手填的值和库里的值从此是同一份数据，两边真正互通
   *
   *   注意：这里仍然优先返回"自己这份"的**当前值**，
   *   保证玩家刚敲进去的字立刻生效，不会因为收编失败而丢。 */
  const snapshot = trio.snapshot;
  const bound = trio.presetId && snapshot && normalizeApiUrl(trio.url) === normalizeApiUrl(snapshot.apiUrl)
    && trio.key === String(snapshot.apiKey || '').trim();
  if (trio.url && trio.key && !bound) {
    let adoptedPresetId = '';
    try {
      if (c !== DEFAULT_FIELDS && c.key) {
        adoptedPresetId = adoptManualToLibrary(c, trio) || '';
      }
    } catch (e) {
      console.warn('[API 接口库] 收编手填接口失败：' + (e && e.message ? e.message : e));
    }
    return {
      apiUrl: trio.url,
      apiKey: trio.key,
      apiModel: ownModel,
      source: 'manual',
      presetId: adoptedPresetId || trio.presetId || '',
      presetName: '',
      modelSource: ownModel ? 'own' : 'none',
    };
  }

  /* ② 选了库里的某条 → 地址/密钥用库里的，模型仍以自己为准 */
  const presetId = trio.presetId;
  if (presetId) {
    const preset = getApiPreset(presetId);
    if (preset) {
      const url = preset.apiUrl || trio.url || '';
      const key = preset.apiKey || trio.key || '';
      // ★ 模型优先级：自己选的 > 库里的推荐值
      const model = ownModel;
      if (url && key) {
        return {
          apiUrl: url,
          apiKey: key,
          apiModel: model,
          source: 'library',
          presetId: preset.id,
          presetName: preset.name,
          modelSource: ownModel ? 'own' : (model ? 'library' : 'none'),
        };
      }
    }
  }

  // 兜底：自己填了一部分也先返回，让报错信息保留玩家填过的东西
  return {
    apiUrl: trio.url,
    apiKey: trio.key,
    apiModel: ownModel,
    source: 'none',
    presetId,
    presetName: '',
    modelSource: ownModel ? 'own' : 'none',
  };
}

/** 缺配置时给玩家的一句话，指明去哪儿配 */
export function apiMissingHint(label) {
  const who = label ? ('「' + label + '」') : '';
  return who + '还没有可用接口：可以到本设置里手动填写，'
    + '或先到「系统设置 → 统一 API 接口配置」存好一条，再回来从库里选择。';
}

/** 一览：每个接口位当前用的是「手动填的」「库里的某条」还是「未配置」 */
export function listApiBindings() {
  /* ★★★ 2026-11-04 玩家：「你应该自动把填写的api生成配置卡，
   *   你明白我的意思吗？这样两边才算互通」
   *
   * 每次列一览之前，先把所有手填的接口收编成配置卡。
   * 这样玩家一打开这个面板，库里就自动有了对应的卡，
   * 不需要他再手动"再存一遍"。
   * 收编是幂等的（按地址+密钥去重），重复调用不会生成重复卡。 */
  let adoptedInfo = null;
  try {
    adoptedInfo = adoptAllManualApis();
    if (adoptedInfo && adoptedInfo.adopted > 0) {
      console.warn('[API 接口库] 已把 ' + adoptedInfo.adopted + ' 个手填接口自动生成配置卡');
    }
  } catch (e) {
    console.warn('[API 接口库] 自动生成配置卡失败：' + (e && e.message ? e.message : e));
  }

  return listApiConsumers().map((consumer) => {
    const raw = readConsumerRaw(consumer);
    const scope = consumerScope(raw, consumer);
    // ★ 必须把 consumer 传进去：不同接口位的字段名不一样
    //   （年表是 time_infer_api_*，向量是 embeddingUrl / rerankUrl …）
    const resolved = resolveApiFor(scope, consumer);
    // resolveApiFor 内部可能刚收编并回写了 presetId，这里重新读一次才准
    const freshScope = consumerScope(readConsumerRaw(consumer), consumer);
    const presetId = String(
      freshScope[consumer.idField || 'apiPresetId']
      || resolved.presetId
      || ''
    );
    let presetName = '';
    if (presetId) {
      const p = getApiPreset(presetId);
      presetName = p ? p.name : '(已删除的接口)';
    }
    return {
      label: consumer.label,
      key: consumer.key,
      idField: consumer.slotId || consumer.idField,
      group: consumer.group || '',
      urlField: consumer.urlField,
      keyField: consumer.keyField,
      modelField: consumer.modelField,
      source: resolved.source,
      presetId,
      presetName,
      url: resolved.apiUrl,
      model: resolved.apiModel,
      modelSource: resolved.modelSource,
    };
  });
}

/**
 * 把某个「接口位」绑定到库里的一条接口。
 *
 * 写的是**引用**（id），不是复制值 —— 以后库里改了，这里跟着变。
 * ★ 注意匹配的是「key + idField」而不是只 key：
 *   世界档案 & 向量 一个配置文件里有 4 个接口位，
 *   只按 key 找会永远命中第一段。
 */
export function bindConsumerToPreset(consumerKey, presetId, idFieldHint) {
  const consumer = findConsumer(consumerKey, idFieldHint);
  if (!consumer) return { ok: false, reason: '未知的接口位' };
  let raw = readConsumerRaw(consumer) || {};
  const before = raw;
  const field = consumer.idField || 'apiPresetId';
  const selected = presetId ? getApiPreset(presetId) : null;
  if (presetId && !selected) return { ok: false, reason: '接口不存在' };
  const patch = { [field]: String(presetId || ''), [manualModeField(consumer)]: !selected };
  if (selected) {
    patch[consumer.urlField] = selected.apiUrl;
    patch[consumer.keyField] = selected.apiKey;
    patch[snapshotField(consumer)] = { apiUrl: selected.apiUrl, apiKey: selected.apiKey };
    if (String(consumerScope(raw, consumer)[field] || '') !== String(selected.id)) {
      patch[consumer.modelField] = String(selected.apiModel || '').trim();
      if (consumer.modelField === 'apiModel') patch.apiModels = Array.isArray(selected.apiModels) ? selected.apiModels.slice() : [];
    }
  } else patch[snapshotField(consumer)] = null;
  raw = writeScope(raw, consumer, patch);
  try {
    writeConsumerRaw(consumer, raw);
    syncConsumerNativeForm(consumer, before, raw, true);
    /* ★ 绑定变了，所有相关界面都要跟着变。
     *   之前只在中央面板重绘自己那一行，各子系统设置页里的嵌入框
     *   还停在旧值 —— 实测就是「这边选了 dsh渠道，那边设置页还是空的」。
     *   放在这里统一刷新，任何调用方都不用记得手动同步。 */
    try { mountAllApiEmbeds(); } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/**
 * 找出某个接口位。
 * 同一个 localStorage key 可能对应多个接口位（向量系统的 4 套），
 * 所以优先用 idField 精确定位；没给 idField 时才退回「第一个同 key 的」。
 */
function findConsumer(consumerKey, idFieldHint) {
  const byKey = listApiConsumers().filter((c) => c.key === consumerKey);
  if (!byKey.length) return null;
  if (idFieldHint) {
    return byKey.find((c) => (c.slotId || c.idField) === idFieldHint) || null;
  }
  return byKey.find(consumer => consumer.idField === 'apiPresetId') || byKey[0];
}

const API_CHAINS_KEY = 'CULTIVATION_API_CHAINS_V1';
const consumerChainId = consumer => consumer.key + '/' + (consumer.slotId || consumer.idField);
function loadApiChains() {
  try { return JSON.parse(localStorage.getItem(API_CHAINS_KEY) || '{}') || {}; }
  catch { return {}; }
}
function savedApiChain(consumer) {
  const value = loadApiChains()[consumerChainId(consumer)];
  return Array.isArray(value) ? value : null;
}
function routeKindMatches(preset, consumer) {
  return !preset.requestKind || preset.requestKind === consumerRequestKind(consumer);
}
function materializeChain(ids, consumer) {
  return ids.map(getApiPreset).filter(preset => preset?.enabled!==false && preset?.apiUrl && preset.apiModel
    && routeKindMatches(preset,consumer));
}
export function bindConsumerChain(key, ids, slot) {
  const consumer = findConsumer(key, slot);
  if (!consumer) throw new Error('未知的接口位');
  const unique = [...new Set(ids)];
  if (unique.some(id => !getApiPreset(id))) throw new Error('所选接口已删除，请重新选择');
  const bindings = loadApiChains();
  bindings[consumerChainId(consumer)] = unique;
  localStorage.setItem(API_CHAINS_KEY, JSON.stringify(bindings));
  return unique;
}
export function consumerApiChain(key, slot) {
  const consumer = findConsumer(key, slot);
  if (!consumer) return null;
  const saved = savedApiChain(consumer);
  if (saved?.length || saved && !consumer.fallbackKey) return materializeChain(saved,consumer);
  if (consumer.fallbackKey && (!saved || !saved.length)) return consumerApiChain(consumer.fallbackKey);
  return null;
}

function drawConsumerChain(host, consumer, onChange) {
  // One render owns one metadata request; never reuse across redraws or configuration edits.
  let variableOptionsPromise;
  const ids = savedApiChain(consumer) || [];
  const presets = loadApiLibrary().presets;
  const save = async next => {
    bindConsumerChain(consumer.key, next, consumer.slotId || consumer.idField);
    onChange();
    mountAllApiEmbeds();
  };
  const rows = document.createElement('div');
  rows.className = 'fr-api-chain';
  const addRow = (index, id) => {
    const row = document.createElement('div');
    row.className = 'fr-api-chain-item';
    const label = document.createElement('label');
    const caption=document.createElement('span');
    caption.className='fr-api-route-caption';
    caption.textContent = index === 0 ? '主接口' : id ? '备用 ' + index : '添加备用';
    label.append(caption);
    const select = document.createElement('select');
    select.setAttribute('aria-label', consumer.label + ' · ' + caption.textContent);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = index === 0 && consumer.fallbackKey ? '沿用正文' : id ? '移除此项' : index===0?'选择接口':'选择备用接口';
    select.append(empty);
    for (const preset of presets) {
      if (preset.id !== id && ids.includes(preset.id)) continue;
      if (preset.id !== id && !routeKindMatches(preset,consumer)) continue;
      const option = document.createElement('option');
      option.value = preset.id;
      const matches = routeKindMatches(preset,consumer);
      const size = consumerRequestKind(consumer)==='image' && preset.imageRequestProfile?.size;
      option.textContent = preset.name + (preset.apiModel ? ' · ' + preset.apiModel : '（待填写模型）')
        + (size ? ' · ' + size.replace('x',' × ') : '') + (matches ? '' : '（类型不匹配）');
      option.disabled = !preset.apiUrl || !preset.apiModel;
      select.append(option);
    }
    if (id && !presets.some(preset => preset.id === id)) {
      const missing = document.createElement('option');
      missing.value = id;
      missing.textContent = '接口已删除';
      select.append(missing);
    }
    select.value = id || '';
    select.addEventListener('change', () => {
      const next = ids.slice();
      if (select.value) next[index] = select.value; else next.splice(index, 1);
      void save(next.filter(value => getApiPreset(value)));
    });
    label.append(select);
    row.append(label);
    const routePresets = consumer.key === 'FR_STANDALONE_CONFIG_V1' ? window.FRProseRoutePresets :
      consumer.key === 'CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1' && consumer.idField === 'apiPresetId' && !consumer.path && !consumer.slotId ? window.FREvolutionRoutePresets : null;
    if (routePresets && id && presets.some(preset => preset.id === id)) {
      const name = consumer.key === 'FR_STANDALONE_CONFIG_V1' ? '正文预设' : '变量预设';
      const presetLabel = document.createElement('label'); presetLabel.textContent = name;
      const picker = document.createElement('select'); picker.setAttribute('aria-label', caption.textContent+' · '+name);
      picker.disabled = true;
      const optionsRequest = routePresets === window.FREvolutionRoutePresets
        ? (variableOptionsPromise ||= Promise.resolve().then(() => routePresets.options(id)))
        : Promise.resolve().then(() => routePresets.options(id));
      optionsRequest.then(items => {
        picker.replaceChildren();
        const selected = routePresets.get(id);
        const choices = [{id:'',name:'跟随当前'+name},...items];
        if(selected&&!choices.some(item=>item.id===selected))choices.push({id:selected,name:'绑定预设已删除，请重新选择',disabled:true});
        for(const item of choices){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;option.disabled=!!item.disabled;picker.append(option);}
        picker.value=selected;picker.disabled=false;
      }).catch(error => { picker.title=String(error.message||error); });
      picker.addEventListener('change',()=>routePresets.set(id,picker.value));
      presetLabel.append(picker);row.append(presetLabel);
      const presetDetail=document.createElement('button');presetDetail.type='button';presetDetail.textContent='预设详情';presetDetail.className='fr-api-chain-button';
      presetDetail.setAttribute('aria-label',caption.textContent+' · '+name+'编辑与查看');
      presetDetail.addEventListener('click',async()=>{presetDetail.disabled=true;try{await routePresets.open(id);}catch(error){window.alert(String(error.message||error));}finally{presetDetail.disabled=false;}});
      row.append(presetDetail);
    }
    if(id&&presets.some(preset=>preset.id===id)){
      const detail=document.createElement('button');
      detail.type='button';detail.textContent=routePresets?'接口详情':'详情';
      detail.className='fr-api-chain-button';
      detail.setAttribute('aria-label',consumer.label+' · '+caption.textContent+'详情');
      detail.addEventListener('click',()=>{
        const panel=document.getElementById('unified-api-settings-overlay');
        if(!panel)return;
        const preset=getApiPreset(id);
        if(!preset)return;
        const api=bindApiLibraryPanel(panel);
        // The shared editor can be opened from a feature dialog that appears later in the DOM.
        panel.style.zIndex=String(Math.max(2000,...[...document.querySelectorAll('.overlay.visible')]
          .map(overlay=>Number.parseInt(window.getComputedStyle(overlay).zIndex,10)||0))+1);
        panel.classList.add('visible');
        api?.openEditor(preset, consumer);
        el(panel,'api-library-editor')?.scrollIntoView?.({block:'nearest'});
      });
      row.append(detail);
    }
    if (id && index > 0) {
      const up = document.createElement('button');
      up.type = 'button';up.textContent = '↑';up.setAttribute('aria-label', '将备用 '+index+' 上移');
      up.className='fr-api-chain-button';
      up.addEventListener('click', () => {
        const next = ids.filter(value => getApiPreset(value));
        const at = next.indexOf(id);
        if (at > 0) [next[at-1],next[at]] = [next[at],next[at-1]];
        void save(next);
      });
      row.append(up);
    }
    rows.append(row);
  };
  ids.forEach((id,index) => addRow(index,id));
  if (!ids.length || presets.some(preset => preset.apiModel && !ids.includes(preset.id))) addRow(ids.length,'');
  host.append(rows);
}

export function mountConsumerChain(key, host, slot) {
  const consumer = findConsumer(key, slot);
  if (!consumer || !host) return;
  const draw = () => {
    host.replaceChildren();
    drawConsumerChain(host, consumer, draw);
  };
  draw();
}

export function hideLegacyApiFields() {
  if (typeof document === 'undefined') return;
  const extraIds=['ce-canon-api-model-custom','concurrent-evo-image-api-model-text','concurrent-evo-image-api-model-custom-select',
    'concurrent-evo-image-api-model','fr-api-url','fr-api-key','fr-model',
    'fetch-summary-models-btn',
    'concurrent-evo-original-timeline-api-url','concurrent-evo-original-timeline-api-key','concurrent-evo-original-timeline-api-model'];
  const fields=[...listApiConsumers().flatMap(consumer=>nativeConsumerFields(consumer)||[]),...extraIds];
  for (const id of fields) {
    const input=document.getElementById(id);
    if(!input)continue;
    input.dataset.frLibraryOnly='';
    // Some legacy labels live outside the model-picker flex row.
    // Hide by association as well, so the centralized picker leaves no orphan label.
    for (const linkedLabel of document.querySelectorAll('label[for]')) {
      if (linkedLabel.htmlFor === id) linkedLabel.dataset.frLibraryOnly='';
    }
    const label=input.previousElementSibling;
    if(label?.tagName==='LABEL')label.dataset.frLibraryOnly='';
    const parent=input.parentElement;
    if(parent?.matches('.pg-form-row,.input-group')&&!parent.querySelector('.fr-api-embed'))parent.dataset.frLibraryOnly='';
  }
}

export async function runApiChain(routes, attempt, signal, onSwitch, canRetry) {
  if (!routes.length) throw new Error('请在统一 API 接口配置中为此功能选择可用接口');
  for (const [index, route] of routes.entries()) {
    signal?.throwIfAborted();
    try { return await attempt(route, index); }
    catch (error) {
      signal?.throwIfAborted();
      if (index === routes.length - 1 || error?.name === 'AbortError' || canRetry?.(error) === false) throw error;
      onSwitch?.(routes[index + 1], index + 1, error);
    }
  }
}

export function migrateApiChains(legacyThinkingConfig) {
  const bindings = loadApiChains();
  const lib = loadApiLibrary();
  let changed = false, libraryChanged = false;
  const migrate = (consumer, scope) => {
    const uid = consumerChainId(consumer);
    if (Array.isArray(bindings[uid])) return;
    const trio = readOwnTriplet(scope, consumer);
    const bound = lib.presets.find(row => row.id === trio.presetId);
    const matches = trio.snapshot && normalizeApiUrl(trio.snapshot.apiUrl) === normalizeApiUrl(trio.url)
      && String(trio.snapshot.apiKey || '').trim() === trio.key;
    const useBound = bound && !trio.manual && (matches || !trio.url);
    const url = normalizeApiUrl(useBound ? bound.apiUrl : trio.url);
    const key = useBound ? bound.apiKey : trio.key;
    const model = trio.model || bound?.apiModel || '';
    if (!url || !model) return;
    let card = useBound && bound.apiModel === model ? bound : lib.presets.find(row =>
      normalizeApiUrl(row.apiUrl) === url && row.apiKey === key && row.apiModel === model);
    if (!card) {
      card = {id:genId(),name:consumer.label+' · '+model,apiUrl:url,apiKey:key,apiModel:model,apiModels:[model],updatedAt:Date.now()};
      lib.presets.push(card);
      libraryChanged = true;
    }
    bindings[uid] = [card.id];
    changed = true;
  };
  for (const consumer of listApiConsumers()) migrate(consumer, consumerScope(readConsumerRaw(consumer), consumer));
  const evolution = findConsumer('CULTIVATION_CONCURRENT_EVOLUTION_CONFIG_V1');
  const evolutionId = consumerChainId(evolution);
  if (changed && bindings[evolutionId]?.length === 1 && !savedApiChain(evolution)) {
    const backups = listApiConsumers(evolution.key).filter(row => row.path?.[0] === 'backupApiConfigs');
    bindings[evolutionId] = [...new Set([...bindings[evolutionId], ...backups.flatMap(row => bindings[consumerChainId(row)] || [])])];
  }
  const legacyId = 'CULTIVATION_THINKING_API_CONFIG_V1/apiPresetId';
  if (!Array.isArray(bindings[evolutionId]) && Array.isArray(bindings[legacyId])) {
    const legacy = bindings[legacyId].filter(id => lib.presets.some(preset => preset.id === id));
    if (legacy.length) { bindings[evolutionId] = [...new Set(legacy)]; changed = true; }
  }
  if (legacyThinkingConfig) migrate(evolution, legacyThinkingConfig);
  if (libraryChanged) saveApiLibrary(lib);
  if (changed) localStorage.setItem(API_CHAINS_KEY, JSON.stringify(bindings));
}

/** 有多少接口位正在引用某条接口（删除前提示用） */
export function countPresetReferences(presetId) {
  if (!presetId) return [];
  const hits = [];
  for (const consumer of listApiConsumers()) {
    const raw = readConsumerRaw(consumer);
    const scope = consumerScope(raw, consumer);
    const field = consumer.idField || 'apiPresetId';
    if (String(scope[field] || '') === String(presetId)) hits.push(consumer.label);
  }
  return hits;
}

/** Saved choices for an endpoint; actual per-function models remain independent. */
export function getSavedApiModelOptions(presetId, currentModel = '') {
  const preset = presetId ? getApiPreset(presetId) : null;
  return Array.from(new Set([currentModel, preset?.apiModel, ...(preset?.apiModels || [])].map(value => String(value || '').trim()).filter(Boolean)));
}

/** Remember an explicitly saved model on its bound endpoint without changing its default. */
export function rememberApiModels(configKey, config) {
  const lib = loadApiLibrary(); let changed = false;
  for (const consumer of listApiConsumers(configKey, config).filter(item => item.key === configKey)) {
    const trio = readOwnTriplet(consumerScope(config, consumer), consumer);
    const preset = lib.presets.find(item => item.id === trio.presetId);
    if (!preset || !trio.model) continue;
    if ((trio.url && normalizeApiUrl(trio.url) !== normalizeApiUrl(preset.apiUrl)) || (trio.key && trio.key !== preset.apiKey)) continue;
    const models = Array.isArray(preset.apiModels) ? preset.apiModels : [];
    if (!models.includes(trio.model)) { preset.apiModels = [...models, trio.model]; changed = true; }
  }
  if (changed) saveApiLibrary(lib);
  return changed;
}

/**
 * 给某个「接口位」单独指定它要用的模型。
 *
 * ★★★ 2026-11-04 玩家：「每个接口具体用哪个设置的模型应该去每个接口那里选」
 *   + 「向量系统是好几个接口，每个接口你都必须有设置，不能混在一起，
 *      比如向量系统需要三种不同的模型，普通的文本模型，向量模型还有重排序模型」
 *
 * 同一条接口（比如 dsh渠道），变量思考可能要 flash、世界演化要 pro；
 * 向量系统里 embedding 要用向量模型、rerank 要用重排序模型。
 * 所以模型必须存在**各个接口位自己的字段里**，而不是接口条目上。
 * 这里只写那一个接口位的字段，绝不碰别人。
 *
 * @param {string} consumerKey 接口位所属的 localStorage key
 * @param {string} model 模型名；空字符串清掉本功能指定的模型
 * @param {string} [idFieldHint] 同一 key 有多个接口位时用来精确定位（如 rerankModel 的位）
 */
export function setConsumerModel(consumerKey, model, idFieldHint) {
  const consumer = findConsumer(consumerKey, idFieldHint);
  if (!consumer) return { ok: false, reason: '未知的接口位' };
  const next = String(model == null ? '' : model).trim();
  const field = consumer.modelField || 'apiModel';
  let raw = readConsumerRaw(consumer) || {};
  const before = raw;
  raw = writeScope(raw, consumer, { [field]: next });
  try {
    writeConsumerRaw(consumer, raw);
    rememberApiModels(consumerKey, raw);
    syncConsumerNativeForm(consumer, before, raw, true);
    // 同上：模型变了，各设置页里的显示也要跟着变
    try { mountAllApiEmbeds(); } catch (_) {}
    return { ok: true, model: next };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/**
 * 在各子系统自己的 API 设置页里，嵌入一个「从接口库选择」的下拉。
 *
 * ★★★ 2026-11-04 玩家两步要求：
 *   ① 「先填好api接口」    → 系统设置里的统一 API 接口配置（库里存若干条）
 *   ② 「再由玩家到对应的系统api设置那里进行分配」→ 就是这里
 *   「每个接口具体用哪个设置的模型应该去每个接口那里选」
 *
 * 【为什么放这里而不是只在中央面板里分配】
 *   玩家是在某个子系统的设置里配 API 的，就地能选库里的接口最顺手；
 *   让他切到系统设置里去分配，再切回来，是多绕一趟。
 *
 * 【它只做什么】
 *   把子系统的 apiPresetId 指向库里某条（写引用，不复制地址密码）。
 *   显式换卡时带入新卡模型；同卡个人覆盖不变，库里只改地址密钥也不改个人模型。
 *
 * @param {string} consumerKey API_LIBRARY_CONSUMERS 里的 key
 * @param {HTMLElement|string} mount 挂载点元素或其 id
 */
export function mountApiEmbed(consumerKey, mount, slotHint) {
  const host = typeof mount === 'string' ? document.getElementById(mount) : mount;
  if (!host) return null;
  if (!slotHint && listApiConsumers(consumerKey).length > 1) {
    const refresh = () => {
      host.innerHTML = '';
      for (const slot of listApiConsumers(consumerKey)) {
        const child = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = slot.label;
        const picker = document.createElement('div');
        child.append(title, picker);
        host.appendChild(child);
        mountApiEmbed(consumerKey, picker, slot.slotId || slot.idField);
      }
    };
    refresh();
    return { refresh };
  }
  const consumer = findConsumer(consumerKey, slotHint);
  if (!consumer) return null;

  const draw = () => {
    host.replaceChildren();
    const box = document.createElement('div');
    box.className = 'fr-api-embed-box';
    const title = document.createElement('strong');
    title.textContent = '接口优先顺序';
    box.append(title);
    drawConsumerChain(box, consumer, draw);
    host.append(box);
  };

  draw();
  return { refresh: draw };
}

/**
 * 扫描页面上所有带 data-fr-api-consumer 的占位元素，自动挂上选择框。
 * 这样各设置页只要放一个空 div，不用每个页面各写一遍绑定代码。
 */
export function mountAllApiEmbeds() {
  hideLegacyApiFields();
  const nodes = document.querySelectorAll('[data-fr-api-consumer]');
  for (const node of nodes) {
    const key = node.getAttribute('data-fr-api-consumer');
    if (!key) continue;
    // 已挂过就只重绘，不重复建 DOM
    if (node.__frApiEmbed && typeof node.__frApiEmbed.refresh === 'function') {
      node.__frApiEmbed.refresh();
      continue;
    }
    const api = mountApiEmbed(key, node, node.getAttribute('data-fr-api-slot') || undefined);
    if (api) {
      try { node.__frApiEmbed = api; } catch (_) {}
    }
  }
}

// ============================================================
// 界面绑定
// ============================================================

function el(root, id) {
  return (root && root.querySelector && root.querySelector('#' + id)) || document.getElementById(id);
}

// Only this panel owns these layout rules; keep global CE settings styles untouched.
function prepareApiLibraryPanel(listBox, bindBox) {
  const doc = listBox.ownerDocument;
  if (!doc.getElementById('fr-api-library-panel-style')) {
    const style = doc.createElement('style');
    style.id = 'fr-api-library-panel-style';
    style.textContent = `
body:has(#unified-api-settings-overlay.visible) #chat-view>:is(#variable-diff-btn,#thinking-log-btn,#world-evolution-diff-btn,#fr-canon-story-btn){visibility:hidden;pointer-events:none}
#unified-api-settings-overlay{--api-bg:var(--fr-ui-panel);--api-card:var(--fr-ui-raised);--api-field:var(--fr-ui-inset);--api-line:var(--fr-ui-line);--api-gold:var(--fr-ui-accent);--api-text:var(--fr-ui-text);--api-muted:var(--fr-ui-muted);padding:20px;box-sizing:border-box;color-scheme:dark}
body.theme-day #unified-api-settings-overlay{color-scheme:light}
#unified-api-settings-overlay *{box-sizing:border-box}
#unified-api-settings-overlay .settings-modal{width:min(1120px,100%);max-width:1120px;max-height:calc(100dvh - 40px);padding:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--api-line);border-radius:16px;background:var(--api-bg);color:var(--api-text);box-shadow:0 24px 90px #0008}
#unified-api-settings-overlay .settings-modal>h4{flex:none;padding:24px 78px 24px 28px;margin:0;text-align:left;font-size:22px;color:var(--api-gold);border-bottom:1px solid var(--api-line)}
#unified-api-settings-overlay .modal-close-btn{top:16px;right:20px;width:44px;height:44px;min-width:44px;margin:0}
#unified-api-settings-overlay .modal-content{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;padding:24px 28px;scrollbar-color:#9b7c4b var(--api-bg);overscroll-behavior:contain}
#unified-api-settings-overlay .modal-content>.settings-section{flex:none;min-width:0;max-height:none!important;padding:22px;margin:0 0 16px;border:1px solid var(--api-line);border-radius:12px;background:var(--api-card)}
#unified-api-settings-overlay h5{font-size:17px;color:var(--api-gold);margin:0 0 16px;text-align:left}
#unified-api-settings-overlay .settings-section>p{color:var(--api-muted)!important;font-size:14px!important;line-height:1.75!important}
#unified-api-settings-overlay #api-library-list,
#unified-api-settings-overlay #api-library-binding-list{max-height:none!important;overflow:visible!important;background:transparent!important;padding:0!important}
#unified-api-settings-overlay .fr-api-lib-row{display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--fr-ui-divider)}
#unified-api-settings-overlay .fr-api-lib-main{flex:1;min-width:0}
#unified-api-settings-overlay .fr-api-lib-title{color:var(--api-text);font-size:16px;font-weight:600}
#unified-api-settings-overlay .fr-api-lib-detail{color:var(--api-muted);font-size:13px;line-height:1.7;margin-top:6px}
#unified-api-settings-overlay .fr-api-lib-title,
#unified-api-settings-overlay .fr-api-lib-detail{white-space:normal;overflow:visible;overflow-wrap:anywhere}
#unified-api-settings-overlay :is(input:not([type=checkbox]),select){width:100%;min-width:0;max-width:100%;min-height:44px;padding:10px 12px;margin:0;background:var(--api-field);border:1px solid var(--api-line);border-radius:7px;color:var(--api-text);font-size:14px}
#unified-api-settings-overlay input[type=hidden]{display:none}
#unified-api-settings-overlay .fr-api-editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
#unified-api-settings-overlay .fr-api-editor-head h5{margin:0;border:0;padding:0;overflow-wrap:anywhere}
#unified-api-settings-overlay .fr-api-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
#unified-api-settings-overlay .fr-api-form-grid label{display:grid;gap:6px;margin:0;min-width:0;color:var(--api-muted);font-size:14px;line-height:1.45}
#unified-api-settings-overlay .fr-api-span{grid-column:1/-1}
#unified-api-settings-overlay .fr-api-field>label{margin-bottom:6px}
#unified-api-settings-overlay .fr-api-request{margin:16px 0 0;border-block:1px solid var(--fr-ui-divider)}
#unified-api-settings-overlay .fr-api-request>summary{min-height:46px;cursor:pointer;padding:12px 14px;border-radius:9px;color:var(--api-gold);font-weight:600}
#unified-api-settings-overlay .fr-api-request-body{padding:8px 14px 16px}
#unified-api-settings-overlay .fr-api-request-body>.fr-api-hint{margin:10px 0 14px;color:var(--api-muted)}
#unified-api-settings-overlay .fr-api-switches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
#unified-api-settings-overlay .fr-api-switch{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;margin:0;padding:8px 10px;border-bottom:1px solid var(--fr-ui-divider);color:var(--api-text);font-size:13px;line-height:1.5;cursor:pointer}
#unified-api-settings-overlay .fr-api-switch input{display:grid;place-items:center start;appearance:none;flex:0 0 38px;width:38px;height:22px;min-width:0;min-height:0;margin:0;padding:2px;border:1px solid var(--api-line);border-radius:20px;background:var(--api-field);cursor:pointer}
#unified-api-settings-overlay .fr-api-switch input::before{content:"";width:14px;height:14px;border-radius:50%;background:var(--api-muted)}
#unified-api-settings-overlay .fr-api-switch input:checked{background:var(--fr-ui-action);border-color:var(--fr-ui-action)}
#unified-api-settings-overlay .fr-api-switch input:checked::before{justify-self:end;background:var(--fr-ui-action-text)}
#unified-api-settings-overlay #api-library-status:empty{display:none}
#unified-api-settings-overlay button{min-height:44px;min-width:44px;cursor:pointer;font-size:14px}
#unified-api-settings-overlay .fr-api-lib-btn,#unified-api-settings-overlay .major-action-button{width:auto;flex:0 0 auto;padding:10px 14px;margin:0;border:1px solid var(--api-line);border-radius:7px;background:var(--fr-ui-selected);color:var(--api-text)}
#unified-api-settings-overlay .fr-api-lib-btn.is-danger{color:var(--fr-ui-danger)}
:is(.fr-api-chain,#unified-api-settings-overlay) .fr-api-chain-button{background:transparent;color:var(--fr-ui-accent);border:0;border-radius:6px;padding:0 10px;min-height:44px;min-width:44px;font:inherit;cursor:pointer}
:is(.fr-api-chain,#unified-api-settings-overlay) .fr-api-chain-button:hover{background:var(--fr-ui-selected)}
.fr-api-chain .fr-api-chain-button:focus-visible{outline:2px solid var(--fr-ui-accent);outline-offset:2px}
#unified-api-settings-overlay .modal-content>.fr-api-routing{padding:8px 0 12px;border:0;border-radius:0;background:none}
#unified-api-settings-overlay .fr-api-routing-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px 8px}
#unified-api-settings-overlay .fr-api-routing-head h5{border:0;padding:0;margin:0}
#unified-api-settings-overlay #api-library-binding-list{border-top:1px solid var(--fr-ui-divider)}
#unified-api-settings-overlay .fr-api-chain-binding{border-bottom:1px solid var(--fr-ui-divider)}
#unified-api-settings-overlay .fr-api-route-summary{list-style:none;display:grid;grid-template-columns:minmax(125px,1fr) minmax(0,2.2fr) 64px 16px;align-items:center;gap:12px;min-height:58px;padding:9px 14px;cursor:pointer;line-height:1.4}
#unified-api-settings-overlay .fr-api-route-summary::-webkit-details-marker{display:none}
#unified-api-settings-overlay .fr-api-route-summary::after{content:"";width:7px;height:7px;border-right:1.5px solid var(--api-muted);border-bottom:1.5px solid var(--api-muted);transform:rotate(45deg);justify-self:center}
#unified-api-settings-overlay .fr-api-chain-binding[open] .fr-api-route-summary::after{transform:rotate(225deg)}
#unified-api-settings-overlay .fr-api-route-summary:hover,#unified-api-settings-overlay .fr-api-chain-binding[open] .fr-api-route-summary{background:var(--api-card)}
#unified-api-settings-overlay .fr-api-route-summary strong{font-size:15px;color:var(--api-text);overflow-wrap:anywhere}
#unified-api-settings-overlay .fr-api-route-model{min-width:0;color:var(--api-text);overflow-wrap:anywhere;font-size:14px}
#unified-api-settings-overlay .fr-api-route-model small{display:block;color:var(--api-muted);font-size:12px}
#unified-api-settings-overlay .fr-api-route-count{color:var(--api-muted);font-size:12px;text-align:right;white-space:nowrap}
#unified-api-settings-overlay .fr-api-chain{padding:5px 14px 10px;gap:0}
#unified-api-settings-overlay .fr-api-chain-item{display:flex;flex-wrap:wrap;padding:6px 0;gap:6px;background:none;border:0;border-radius:0}
#unified-api-settings-overlay .fr-api-chain-item+.fr-api-chain-item{border-top:1px solid var(--fr-ui-divider)}
#unified-api-settings-overlay .fr-api-chain-item label{flex:1 1 12rem;width:auto;min-width:0;grid-template-columns:minmax(0,92px) minmax(0,1fr);align-items:center;gap:10px;margin:0;color:var(--api-muted);font-size:13px}
#unified-api-settings-overlay .fr-api-chain-item button{flex:0 0 auto;width:auto;white-space:nowrap}
#unified-api-settings-overlay #api-library-save-btn{background:var(--fr-ui-action);color:var(--fr-ui-action-text)}
#unified-api-settings-overlay #api-library-save-btn i{color:inherit}
#unified-api-settings-overlay .button-group{display:flex;flex-wrap:wrap}
#unified-api-settings-overlay button:disabled{opacity:.55;cursor:wait}
#unified-api-settings-overlay :is(input,select,button,summary):focus-visible{outline:2px solid var(--api-gold);outline-offset:3px}
#unified-api-settings-overlay .fr-api-model-dropdown{top:calc(100% + 4px)}
#unified-api-settings-overlay .fr-api-binding-model .fr-api-model-options{max-height:none;overflow:visible}
#unified-api-settings-overlay .fr-api-lib-group{color:var(--api-gold);font-size:13px;margin:18px 0 2px;padding:5px 14px;border:0}
#unified-api-settings-overlay .fr-api-library-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:8px 0 16px}
#unified-api-settings-overlay .fr-api-library-tools button{width:auto;flex:0 0 auto;transition:none}
#unified-api-settings-overlay .fr-api-library-count{font-size:12px;flex-basis:100%;color:var(--api-muted)}
#unified-api-settings-overlay .fr-api-savebar{flex:none;display:flex;gap:20px;align-items:center;justify-content:space-between;padding:16px 28px;border-top:1px solid var(--fr-ui-divider);background:var(--api-card)}
#unified-api-settings-overlay .fr-api-savebar p{margin:0;color:var(--api-muted);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
#unified-api-settings-overlay #api-library-save-all-btn{flex:none;background:var(--fr-ui-action);color:var(--fr-ui-action-text);border:1px solid var(--fr-ui-action);border-radius:7px;padding:10px 22px;font-weight:600}
@media(max-width:600px){
 #unified-api-settings-overlay{padding:10px}
 #unified-api-settings-overlay .settings-modal{max-height:calc(100dvh - 20px)}
 #unified-api-settings-overlay .settings-modal>h4{padding:20px 66px 20px 16px;font-size:19px}
 #unified-api-settings-overlay .modal-close-btn{top:12px;right:12px}
 #unified-api-settings-overlay .modal-content{padding:16px 12px}
 #unified-api-settings-overlay .modal-content>.settings-section{padding:16px 12px}
 #unified-api-settings-overlay :is(.fr-api-form-grid,.fr-api-switches){grid-template-columns:minmax(0,1fr)}
 #unified-api-settings-overlay .fr-api-request-body{padding:12px}
 #unified-api-settings-overlay .fr-api-editor-head{flex-wrap:wrap}
 #unified-api-settings-overlay .fr-api-route-summary{grid-template-columns:minmax(0,1fr) auto 12px;gap:4px 8px;padding:10px 8px}
 #unified-api-settings-overlay .fr-api-route-model{grid-row:2;grid-column:1/-1}
 #unified-api-settings-overlay .fr-api-route-summary::after{grid-row:1;grid-column:3}
 #unified-api-settings-overlay .fr-api-chain{padding-inline:8px}
 #unified-api-settings-overlay .fr-api-chain-item label{grid-template-columns:minmax(0,1fr);gap:4px}
 #unified-api-settings-overlay .fr-api-chain-button{padding-inline:8px}
 #unified-api-settings-overlay .fr-api-lib-row{flex-wrap:wrap}
 #unified-api-settings-overlay .fr-api-lib-main{flex-basis:100%}
 #unified-api-settings-overlay .fr-api-savebar{padding:12px;gap:12px}
 #unified-api-settings-overlay #api-library-save-all-btn{padding:10px 14px}
}
`;
    doc.head.appendChild(style);
  }
  const intro = listBox.parentElement.querySelector('p');
  if (intro) intro.textContent = '把常用接口保存在这里，再为各功能分配。不同功能可以使用不同的接口和模型。';
  const legend = bindBox && bindBox.parentElement.querySelector('p');
  if (legend) legend.textContent = '切换接口会带入该卡模型，你也可以单独调整。完成后点击底部保存。';
  let tools = doc.getElementById('api-library-tools');
  if (!tools) {
    tools = doc.createElement('div');
    tools.id = 'api-library-tools';
    tools.className = 'fr-api-library-tools';
    const search = doc.createElement('input');
    search.id = 'api-library-search'; search.type = 'search';
    search.placeholder = '搜索名称、地址或推荐模型';
    search.setAttribute('aria-label', '搜索已保存接口（名称、地址或推荐模型）');
    tools.appendChild(search);
    const typeFilter = doc.createElement('select');
    typeFilter.id = 'api-library-type-filter';
    typeFilter.setAttribute('aria-label','按模型类型筛选');
    for (const [value,label] of [['','全部模型类型'],...Object.entries(requestKindLabels).map(([key,text])=>[key,text+'模型'])]) {
      const option=doc.createElement('option');
      option.value=value; option.textContent=label; typeFilter.append(option);
    }
    tools.append(typeFilter);
    const clear = doc.createElement('button'); clear.type = 'button';
    clear.id = 'api-library-search-clear'; clear.textContent = '清空搜索';
    clear.className = 'fr-api-lib-btn'; tools.appendChild(clear);
    const count = doc.createElement('span'); count.id = 'api-library-result-count';
    count.className = 'fr-api-library-count'; count.setAttribute('aria-live', 'polite');
    tools.appendChild(count); listBox.before(tools);
  }
  return tools;
}

/**
 * 绑定「统一 API 接口配置」面板。
 *
 * ★ 必须可重复调用而不叠加监听器。
 *   入口按钮每点一次就会调用一次本函数；如果每次都 addEventListener，
 *   监听器会越积越多 —— 点一次「保存」实际执行两遍、三遍，
 *   表现为「保存后出现两条一模一样的接口」。这是实测到的真实故障，
 *   不是理论风险。所以第一次绑定后打标记，之后只做重绘。
 */
export function bindApiLibraryPanel(root, options) {
  const host = root || document;
  const listBox = el(host, 'api-library-list');
  const editor = el(host, 'api-library-editor');
  const editorTitle = el(host, 'api-library-editor-title');
  const fId = el(host, 'api-library-edit-id');
  const fName = el(host, 'api-library-name');
  const fUrl = el(host, 'api-library-url');
  const fKey = el(host, 'api-library-key');
  const fModel = el(host, 'api-library-model');
  const fNote = el(host, 'api-library-note');
  const fEnabled=el(host,'api-library-enabled');
  const fNonstream=el(host,'api-library-nonstream');
  const fKind=el(host,'api-library-request-kind');
  const imageSize=el(host,'api-library-image-size');
  const customImageSize=el(host,'api-library-image-custom-size');
  const customImageWrap=el(host,'api-library-image-custom-wrap');
  const imageQuality=el(host,'api-library-image-quality');
  const imageFormat=el(host,'api-library-image-format');
  const imageTimeout=el(host,'api-library-image-timeout');
  const imageRpm=el(host,'api-library-image-rpm');
  const embeddingDimensions=el(host,'api-library-embedding-dimensions');
  const rerankDocuments=el(host,'api-library-rerank-documents');
  let kindEdited=false;
  const updateRequestPane=() => {
    for (const [kind,suffix] of Object.entries({chat:'chat',embeddings:'embedding',rerank:'rerank',image:'image'})) {
      const pane=el(host,'api-library-'+suffix+'-request');
      if (pane) { pane.hidden=fKind?.value !== kind; if (!pane.hidden) pane.open=true; }
    }
  };
  const updateCustomImageSize=() => { if (customImageWrap) customImageWrap.hidden=imageSize.value!=='custom'; };
  const readImageProfile=() => {
    const profile=normalizeImageRequestProfile({size:imageSize?.value==='custom'?customImageSize?.value:imageSize?.value,
      quality:imageQuality?.value,outputFormat:imageFormat?.value,timeoutSeconds:imageTimeout?.value,rpm:imageRpm?.value});
    if (imageSize?.value==='custom' && (!profile.size || profile.size==='auto')) throw new Error('请输入有效的自定义尺寸，例如 1920x1280。');
    if ((imageTimeout?.value && !profile.timeoutSeconds) || (imageRpm?.value && !profile.rpm)) throw new Error('图像超时和 RPM 需要填写有效的正整数。');
    return profile;
  };
  const readTypedProfile=kind=>{
    if (kind==='image' && imageSize) return {imageRequestProfile:readImageProfile()};
    if (kind==='embeddings' && embeddingDimensions) {
      const embeddingProfile=normalizeEmbeddingProfile({dimensions:embeddingDimensions.value});
      if (embeddingDimensions.value && !embeddingProfile.dimensions) throw new Error('输出维度需填写正整数。');
      return {embeddingProfile};
    }
    if (kind==='rerank' && rerankDocuments) {
      const rerankProfile=normalizeRerankProfile({maxDocuments:rerankDocuments.value});
      if (rerankDocuments.value && !rerankProfile.maxDocuments) throw new Error('每批文档数需填写正整数。');
      return {rerankProfile};
    }
    return {};
  };
  const requestFields = {
    reasoningEffort:'reasoning',noPrefill:'no-prefill',systemAsUser:'system-user',
    modelFamily:'model-family',jsonMode:'json-mode'
  };
  const requestInputs=Object.fromEntries(Object.entries(requestFields).map(([key,id])=>[key,el(host,'api-library-'+id)]));
  const readRequestProfile=()=>normalizeChatRequestProfile({...Object.fromEntries(Object.entries(requestInputs)
    .filter(([,input])=>input).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value])),
    ...(fNonstream?.checked?{stream:false}:{})});
  /* 模型下拉：自己画的那套（限高 + 搜索 + 滚动），不再用 datalist。
   * 原因见 layout.html 里那段注释和 style-1.css 的 .fr-api-model-dropdown。 */
  const modelToggle = el(host, 'api-library-model-toggle');
  const modelDropdown = el(host, 'api-library-model-dropdown');
  const modelSearch = el(host, 'api-library-model-search');
  const modelOptions = el(host, 'api-library-model-options');
  const modelCount = el(host, 'api-library-model-count');
  const modelClear = el(host, 'api-library-model-clear');
  const statusEl = el(host, 'api-library-status');
  const bindBox = el(host, 'api-library-binding-list');
  if (!listBox || !editor) return null;
  const panelTools = prepareApiLibraryPanel(listBox, bindBox);

  /* 已绑过就只重绘，不重复挂监听器。
   * 标记挂在 overlay 元素上，随 DOM 生命周期走，不会跨页面残留。
   *
   * ★★★ 2026-11-04 这个「防重复」标记自己咬了我一口。
   *
   * 加了下拉功能之后实测：点「▾」完全没反应，连不冒泡的点击也没反应。
   * 查了半天 —— overlay 上带着**上一版代码**留下的标记，
   * 于是新代码直接走「已绑过，只重绘」分支就 return 了，
   * 新加的监听器永远没机会挂上去。
   *
   * 这在真实玩家身上同样会发生：热更新替换 index.html 后，
   * 内存里旧的 overlay 元素还在，新逻辑就永远不生效 ——
   * 表现就是「更新了但没变化」，比不修还糟。
   *
   * 【修法】标记带版本号。版本一变，标记自动失效，重新完整绑定。
   * 以后每次改这个面板记得把 BIND_VERSION 加一。 */
  const BIND_VERSION = 10;
  const boundFlag = host || document;
  if (boundFlag.__frApiLibraryBound && boundFlag.__frApiLibraryBound.version === BIND_VERSION) {
    const api = boundFlag.__frApiLibraryBound;
    if (options?.probeImage) api.probeImage = options.probeImage;
    try {
      api.renderList();
      api.renderBindings();
    } catch (_) {}
    /* ★ 早退时也必须刷新各子系统里的嵌入选择框。
     *   之前只重绘本面板的列表，嵌入框一直停在第一次打开时的快照，
     *   于是出现「明明已经改成 A 接口，设置页里还显示旧的 B 接口」。 */
    try { mountAllApiEmbeds(); } catch (_) {}
    return api;
  }

  const say = (text, color) => {
    if (statusEl) { statusEl.textContent = text || ''; statusEl.style.color = color || '#9ecf9e'; }
    const visibleStatus = el(host, 'api-library-save-status');
    if (visibleStatus) { visibleStatus.textContent = text || '修改即时应用，点击保存确认写入本地。'; visibleStatus.style.color = color || ''; }
  };
  if (imageSize) {
    imageSize.replaceChildren(...[['','沿用现有设置'],['auto','自动'],...imageSizes.map(size=>[size,size.replace('x',' × ')]),
      ['custom','自定义…']].map(([value,label])=>{
        const option=document.createElement('option');
        option.value=value; option.textContent=label; return option;
      }));
    imageSize.addEventListener('change',updateCustomImageSize);
  }
  if (fKind) {
    fKind.addEventListener('change',() => { kindEdited=true; updateRequestPane(); });
    const inferDraftKind=() => {
      if (kindEdited || fId.value) return;
      fKind.value=probeKind(null,fUrl.value,fModel.value);
      updateRequestPane();
    };
    for (const input of [fUrl,fModel]) {
      input?.addEventListener('input',inferDraftKind);
      input?.addEventListener('change',inferDraftKind);
    }
  }

  /** 当前这条接口探测到的模型列表（画下拉用） */
  let availableModels = [];
  let modelsEndpoint = { url: '', key: '' };
  const modelsMatchEndpoint = (url, key) => modelsEndpoint.url === url && modelsEndpoint.key === key;
  let editorSession = 0;
  let currentPage = 'routes';
  let editorReturnFocus = null;
  const pageTabs = [...(host.querySelectorAll?.('[data-api-page]') || [])];
  const switchPage = (page, focusTab = false) => {
    currentPage = page === 'library' ? 'library' : 'routes';
    for (const tab of pageTabs) {
      const selected = tab.dataset.apiPage === currentPage;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    }
    const libraryPage = el(host, 'api-library-page');
    const routesPage = el(host, 'api-routes-page');
    if (libraryPage) libraryPage.hidden = currentPage !== 'library';
    if (routesPage) routesPage.hidden = currentPage !== 'routes';
    const scroller = editor.closest('.modal-content');
    if (scroller) scroller.scrollTop = 0;
  };
  let modelRequest = 0;
  const isCurrentEditor = (session, url, key) => editorSession === session
    && editor.style.display !== 'none'
    && normalizeApiUrl(fUrl.value) === url && String(fKey.value || '').trim() === key;

  /**
   * 画模型下拉。
   * ★ 全部自己画，不用 datalist —— datalist 的高度 CSS 管不到，
   *   模型一多就会拉成长条盖住整个弹窗（玩家实测反馈）。
   *   这里给的是固定 max-height + 内部滚动 + 搜索框，永远不跑出容器。
   */
  const renderModelDropdown = (keyword) => {
    if (!modelOptions) return;
    const kw = String(keyword || '').trim().toLowerCase();
    const list = kw
      ? availableModels.filter((m) => String(m).toLowerCase().includes(kw))
      : availableModels;
    modelOptions.innerHTML = '';
    if (modelCount) {
      modelCount.textContent = kw
        ? ('匹配 ' + list.length + ' / ' + availableModels.length)
        : ('共 ' + availableModels.length + ' 个');
    }
    if (!availableModels.length) {
      const p = document.createElement('p');
      p.textContent = '还没有模型列表。点「获取可用模型」拉取，或直接在输入框手填。';
      modelOptions.appendChild(p);
      return;
    }
    if (!list.length) {
      const p = document.createElement('p');
      p.textContent = '没有匹配「' + kw + '」的模型。';
      modelOptions.appendChild(p);
      return;
    }
    const current = String(fModel.value || '').trim();
    for (const m of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = m;
      if (m === current) btn.className = 'is-selected';
      btn.addEventListener('click', () => {
        fModel.value = m;
        try { fModel.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        hideModelDropdown();
      });
      modelOptions.appendChild(btn);
    }
  };

  const showModelDropdown = () => {
    if (!modelDropdown) return;
    modelDropdown.hidden = false;
    modelDropdown.classList.remove('is-above');
    /* 自适应方向：下拉在弹窗里，如果下方空间不够就向上弹，
     * 免得盖住「备注 / 保存」这些还得用到的控件。
     * 判据用真实几何，不猜：算下方剩余空间够不够放下下拉的期望高度。 */
    try {
      const modal = host.querySelector ? host.querySelector('.settings-modal') : null;
      const box = modelDropdown.getBoundingClientRect();
      const limit = modal ? modal.getBoundingClientRect().bottom : window.innerHeight;
      const spaceBelow = limit - box.top;
      const wantH = Math.min(window.innerHeight * 0.46, 320);
      if (spaceBelow < wantH + 24) {
        const picker = modelDropdown.parentElement;
        const pbox = picker ? picker.getBoundingClientRect() : null;
        if (pbox && pbox.top > wantH + 24) modelDropdown.classList.add('is-above');
      }
    } catch (_) {}
    if (modelSearch) {
      modelSearch.value = '';
      renderModelDropdown('');
      try { modelSearch.focus(); } catch (_) {}
    } else {
      renderModelDropdown('');
    }
  };

  const hideModelDropdown = () => {
    if (modelDropdown) modelDropdown.hidden = true;
  };

  let editorConsumer;
  const openEditor = (preset, consumer) => {
    editorConsumer = consumer;
    editorSession++;
    editorReturnFocus = document.activeElement;
    const panel = editor.closest('#unified-api-settings-overlay');
    panel?.classList.add('fr-api-editing');
    // 每次打开都是独立编辑会话；不能把上一张卡的防重令牌带进新增。
    // 卡片身份只由 ID 决定，同地址、同模型也允许按用途分别保存。
    fId.dataset.editToken = preset ? String(preset.editToken || '') : genId();
    editor.style.display = '';
    const requestDetails=editor.querySelector('#api-library-chat-request') || editor.querySelector('.fr-api-request');
    if(requestDetails)requestDetails.open=false;
    editorTitle.textContent = preset ? ('编辑：' + preset.name) : '新增接口';
    fId.value = preset ? preset.id : '';
    fName.value = preset ? preset.name : '';
    fUrl.value = preset ? preset.apiUrl : '';
    fKey.value = preset ? preset.apiKey : '';
    fModel.value = preset ? preset.apiModel : '';
    fNote.value = preset ? preset.note : '';
    kindEdited=false;
    if (fKind) { fKind.value=presetRequestKind(preset,consumer); updateRequestPane(); }
    if (imageSize) {
      const profile=preset?.imageRequestProfile || {};
      const custom=profile.size && profile.size!=='auto' && !imageSizes.includes(profile.size);
      imageSize.value=custom?'custom':profile.size || '';
      customImageSize.value=custom?profile.size:'';
      imageQuality.value=profile.quality || '';
      imageFormat.value=profile.outputFormat || '';
      imageTimeout.value=profile.timeoutSeconds || '';
      imageRpm.value=profile.rpm || '';
      updateCustomImageSize();
    }
    if (embeddingDimensions) embeddingDimensions.value=preset?.embeddingProfile?.dimensions || '';
    if (rerankDocuments) rerankDocuments.value=preset?.rerankProfile?.maxDocuments || '';
    if(fEnabled)fEnabled.checked=preset?.enabled!==false;
    if(fNonstream)fNonstream.checked=preset?.requestProfile?.stream===false;
    for(const [key,input] of Object.entries(requestInputs)){
      if(!input)continue;
      if(input.type==='checkbox')input.checked=preset?.requestProfile?.[key]===true;
      else input.value=preset?.requestProfile?.[key]??(['reasoningEffort','modelFamily'].includes(key)?'auto':'');
    }
    availableModels = Array.isArray(preset && preset.apiModels) ? preset.apiModels.slice() : [];
    modelsEndpoint = { url: normalizeApiUrl(fUrl.value), key: String(fKey.value || '').trim() };
    hideModelDropdown();
    say('');
    // 只滚动表单区域；scrollIntoView 会连带滚动弹窗外壳，使标题和关闭键离开视口。
    const scroller = editor.closest('.modal-content');
    if (scroller) scroller.scrollTop = 0;
    try { fName.focus({preventScroll:true}); } catch (_) {}
  };

  const closeEditor = () => {
    editorSession++; // 取消/保存后到达的旧请求不能污染下一张卡。
    hideModelDropdown();
    editor.style.display = 'none';
    editor.closest('#unified-api-settings-overlay')?.classList.remove('fr-api-editing');
    switchPage(currentPage);
    if (editorReturnFocus?.isConnected) editorReturnFocus.focus?.({preventScroll:true});
    else pageTabs.find(tab => tab.dataset.apiPage === currentPage)?.focus();
    say('');
  };

  for (const [index, tab] of pageTabs.entries()) {
    tab.addEventListener('click', () => switchPage(tab.dataset.apiPage));
    tab.addEventListener('keydown', event => {
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? pageTabs.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % pageTabs.length
        : event.key === 'ArrowLeft' ? (index + pageTabs.length - 1) % pageTabs.length : -1;
      if (target < 0) return;
      event.preventDefault();
      switchPage(pageTabs[target].dataset.apiPage, true);
    });
  }
  switchPage('routes');

  /** 画库列表 */
  const renderList = () => {
    const lib = loadApiLibrary();
    const query = String(panelTools.querySelector('input').value || '').trim().toLocaleLowerCase();
    const type=panelTools.querySelector('#api-library-type-filter')?.value;
    const presets = lib.presets.filter(p => (!type || presetRequestKind(p)===type) && (!query || [p.name,p.apiUrl,p.apiModel]
      .some(value=>String(value || '').toLocaleLowerCase().includes(query))));
    panelTools.querySelector('#api-library-result-count').textContent = '显示 ' + presets.length + ' / ' + lib.presets.length + ' 条接口';
    panelTools.querySelector('#api-library-search-clear').disabled = !query;
    listBox.innerHTML = '';
    if (!presets.length) {
      const empty = document.createElement('p');
      empty.textContent = lib.presets.length ? '没有匹配的接口。可修改关键词或清空搜索。' : '还没有保存任何接口。点下面「新增接口」开始。';
      empty.style.cssText = 'color:#8f8b80;margin:6px 0';
      listBox.appendChild(empty);
      return;
    }
    for (const preset of presets) {
      const row = document.createElement('div');
      /* ★★★ 2026-11-04 玩家截图：「保存后怎么这样了」—— 名字被挤成一字一行。
       *
       * 【根因】这一行用了 flex 布局，文字块是 flex:1 1 auto，
       *   但按钮用的是全局类 .major-action-button，那个类带 width:100%。
       *   width 优先于 flex 的伸缩，于是按钮各占满一整行宽，
       *   把文字块挤成 0 宽 —— 实测 main 宽 0、高 1049，所以每个字都换行。
       *
       * 【修法】不用会吃掉整行的全局按钮类，改用本组件自己的类，
       *   并显式 width:auto，永远不跟文字抢宽度。 */
      row.className = 'fr-api-lib-row';

      const main = document.createElement('div');
      main.className = 'fr-api-lib-main';
      const title = document.createElement('div');
      title.textContent = preset.name + (apiPresetComplete(preset) ? '' : '（未填完整）');
      title.className = apiPresetComplete(preset) ? 'fr-api-lib-title' : 'fr-api-lib-title is-incomplete';
      const detail = document.createElement('div');
      detail.textContent = (preset.apiUrl || '(无地址)')
        + ' · ' + requestKindLabels[presetRequestKind(preset)] + (preset.apiModel ? ' · ' + preset.apiModel : '')
        + (preset.note ? '　· ' + preset.note : '');
      detail.className = 'fr-api-lib-detail';
      main.append(title, detail);

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.className = 'fr-api-lib-btn';
      btnEdit.textContent = '编辑';
      btnEdit.addEventListener('click', () => openEditor(preset));

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'fr-api-lib-btn is-danger';
      btnDel.textContent = '删除';
      btnDel.addEventListener('click', () => {
        const used = countPresetReferences(preset.id);
        if (used.length && !window.confirm('这些子系统正在用它：' + used.join('、') + '。删除后它们会变成「未配置」，确定删除？')) return;
        removeApiPreset(preset.id);
        renderList();
        renderBindings();
      });

      row.append(main, btnEdit, btnDel);
      listBox.appendChild(row);
    }
  };

  /** 画「各子系统用了哪条」 */
  const renderBindings = () => {
    if (!bindBox) return;
    migrateApiChains();
    renderList();
    const openKeys=new Set([...bindBox.querySelectorAll('details[open]')].map(row=>row.dataset.consumer));
    const focused=bindBox.ownerDocument.activeElement;
    const focusRow=focused?.closest('.fr-api-chain-binding');
    const focusLabel=focusRow?.contains(focused)?focused.getAttribute('aria-label'):null;
    const presets=new Map(loadApiLibrary().presets.map(card=>[card.id,card]));
    bindBox.replaceChildren();
    let lastGroup = null;
    for (const consumer of listApiConsumers()) {
      const path = consumer.path || [];
      if (path[0] === 'backupApiConfigs') continue;
      if (['providers', 'imageProviderConfigs'].includes(path[0]) && path[1] !== 'openai') continue;
      if (consumer.key === 'CULTIVATION_PORTRAIT_GEN_CONFIG_V1' && consumer.idField === 'llmApiPresetId') continue;
      if (consumer.group && consumer.group !== lastGroup) {
        lastGroup = consumer.group;
        const group = document.createElement('div');
        group.className = 'fr-api-lib-group';
        group.textContent = lastGroup;
        bindBox.append(group);
      }
      const line = document.createElement('details');
      line.className = 'fr-api-binding-row fr-api-chain-binding';
      line.dataset.consumer=consumerChainId(consumer);
      line.dataset.consumerLabel=consumer.label;
      line.open=openKeys.has(line.dataset.consumer);
      const summary=document.createElement('summary');
      summary.className='fr-api-route-summary';
      const name = document.createElement('strong');
      name.textContent = consumer.label;
      const ids=savedApiChain(consumer)||[];
      const primary=presets.get(ids[0]);
      const model=document.createElement('span');
      model.className='fr-api-route-model';
      model.textContent=primary?.name || (ids.length?'接口已删除':consumer.fallbackKey?'沿用正文':'未配置');
      if(primary?.apiModel){
        const modelId=document.createElement('small');
        modelId.textContent=primary.apiModel;
        model.append(modelId);
      }
      if(primary?.enabled===false)model.append(' · 已停用');
      const count=document.createElement('span');
      count.className='fr-api-route-count';
      count.textContent=ids.length>1?'备用 '+(ids.length-1):'';
      summary.append(name,model,count);
      line.append(summary);
      drawConsumerChain(line, consumer, renderBindings);
      bindBox.append(line);
      if(focusRow?.dataset.consumer===line.dataset.consumer&&focusLabel){
        const control=[...line.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===focusLabel);
        (control||summary).focus({preventScroll:true});
      }
    }
  };

  // ---- 事件 ----
  const librarySearch = panelTools.querySelector('input');
  librarySearch.addEventListener('input', renderList);
  const clearLibrarySearch = () => { librarySearch.value = ''; renderList(); librarySearch.focus(); };
  panelTools.querySelector('#api-library-search-clear').addEventListener('click', clearLibrarySearch);
  panelTools.querySelector('#api-library-type-filter')?.addEventListener('change',renderList);
  librarySearch.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); clearLibrarySearch(); }
  });
  /* 模型下拉的交互：
   * · 点右侧 ▾ 展开/收起
   * · 搜索框实时过滤
   * · 选中某项后回填输入框并收起
   * · 点页面别处 / 按 Esc 收起（否则会一直浮在上面挡视线） */
  if (modelToggle) {
    modelToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (modelDropdown && !modelDropdown.hidden) hideModelDropdown();
      else showModelDropdown();
    });
  }
  if (modelSearch) {
    modelSearch.addEventListener('input', () => renderModelDropdown(modelSearch.value));
    modelSearch.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); hideModelDropdown(); }
    });
  }
  if (modelClear) {
    modelClear.addEventListener('click', () => {
      fModel.value = '';
      renderModelDropdown(modelSearch ? modelSearch.value : '');
      say('已清空模型选择。', '#d8c399');
    });
  }
  if (modelDropdown) {
    modelDropdown.addEventListener('click', (ev) => ev.stopPropagation());
  }
  // 点别处收起：只挂一次，靠标记防重复
  /* ★ 这里的判定必须排除「点在下拉内部或开关按钮上」。
   * 第一版只写 dd.hidden=true，结果点 ▾ 展开时 click 冒泡到 document，
   * 刚展开就又被关掉 —— 实测 dropdownHidden 一直是 true、高度 0。
   * 现在按事件目标判断：来自 picker 内部的点击一律不处理。 */
  if (!host.__frApiModelOutsideBound) {
    host.__frApiModelOutsideBound = true;
    document.addEventListener('click', (ev) => {
      const target = ev && ev.target;
      if (target && target.closest && target.closest('.fr-api-model-picker')) return;
      const dd = document.getElementById('api-library-model-dropdown');
      if (dd && !dd.hidden) dd.hidden = true;
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const dd = document.getElementById('api-library-model-dropdown');
      if (dd && !dd.hidden) dd.hidden = true;
    });
  }

  const newBtn = el(host, 'api-library-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => openEditor(null));

  const refreshBtn = el(host, 'api-library-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => { renderList(); renderBindings(); });

  const refreshBindingsBtn = el(host, 'api-library-refresh-bindings-btn');
  if (refreshBindingsBtn) refreshBindingsBtn.addEventListener('click', () => renderBindings());

  const cancelBtn = el(host, 'api-library-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

  const saveBtn = el(host, 'api-library-save-btn');
  for (const input of [fName, fUrl, fKey, fModel, fNote]) {
    if (input) input.addEventListener('input', () => say('接口正在编辑，完成后点击保存。'));
  }
  for (const input of [fUrl, fKey]) {
    if (input) input.addEventListener('input', () => {
      if (!modelsMatchEndpoint(normalizeApiUrl(fUrl.value), String(fKey.value || '').trim())) {
        availableModels = [];
        hideModelDropdown();
      }
    });
  }
  const saveAllBtn = el(host, 'api-library-save-all-btn');
  if (saveAllBtn) saveAllBtn.addEventListener('click', async () => {
    if (saveAllBtn.disabled) return;
    if (editor.style.display !== 'none') {
      if (saveBtn) saveBtn.click();
      if (editor.style.display !== 'none') return;
    }
    saveAllBtn.disabled = true; saveAllBtn.textContent = '正在保存…'; say('正在写入本地数据库…');
    try { await saveApiSettings(); say('已保存到本地，关闭或重开后仍保留。'); }
    catch (error) { say('保存失败：' + (error && error.message || error) + '。请重试。', '#edb1a4'); }
    finally { saveAllBtn.disabled = false; saveAllBtn.textContent = '保存全部配置'; }
  });
  if (saveBtn) {
    /* ★★★ 2026-11-04 玩家：「我就填一个怎么出了四个」
     *
     * 【为什么会出四条】保存按钮上挂了多份监听器（旧版本残留 / 热更新 /
     *   任何让「防重复绑定标记」失效的情况），点一下执行 N 次。
     *   靠「标记一定不出错」来保证正确性太脆弱 —— 漏一次就坏。
     *
     * 【改法 · 机制兜底，不靠标记】
     *   ① 保存锁：进入处理先把按钮锁上，处理完再解锁。
     *      同一瞬间的重复触发会被直接挡掉，跟挂几个监听器无关。
     *   ② 令牌幂等：同一次编辑会话（同一个 editToken）重复保存只更新那一条，
     *      绝不插入第二条。哪怕锁也被绕过，数据层仍然只有一条。
     *   两层都不依赖「防重复绑定」是否可靠。 */
    saveBtn.addEventListener('click', () => {
      if (saveBtn.__frSaving || editor.style.display === 'none') return; // ① 保存锁
      const name = String(fName.value || '').trim();
      const url = normalizeApiUrl(fUrl.value);
      const key = String(fKey.value || '').trim();
      const model = String(fModel.value || '').trim();
      if (!name) return say('请填写名称，方便以后辨认。', '#e0a3a3');
      if (!url) return say('请填写 API URL。', '#e0a3a3');
      if (!/^https?:\/\//i.test(url)) return say('API URL 需要以 http:// 或 https:// 开头。', '#e0a3a3');
      let typedProfile;
      try { typedProfile=readTypedProfile(fKind?.value); } catch (error) { return say(error.message,'#e0a3a3'); }
      saveBtn.__frSaving = true;
      const done = () => { saveBtn.__frSaving = false; };
      try {
        const patch = { name, apiUrl: url, apiKey: key, apiModel: model, apiModels: modelsMatchEndpoint(url, key) ? availableModels.slice() : [], note: String(fNote.value || '').trim(),
          enabled:fEnabled?.checked!==false,requestProfile:readRequestProfile(), ...typedProfile };
        const editingId = String(fId.value || '').trim();
        if (fKind && (!editingId || kindEdited || getApiPreset(editingId)?.requestKind)) patch.requestKind=fKind.value;
        if (editingId) {
          updateApiPreset(editingId, patch);
        } else {
          // ② 令牌幂等：初次保存生成本次会话令牌，重复保存认这个令牌
          let token = String(fId.dataset.editToken || '').trim();
          if (!token) {
            token = 'tok_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            fId.dataset.editToken = token;
          }
          const created = addApiPreset(patch, token);
          if (created) fId.value = created.id;
        }
        renderList();
        renderBindings();
        closeEditor();
      } finally {
        // 解锁放到下一个宏任务，确保同一批次的重复触发都被挡掉
        setTimeout(done, 0);
      }
    });
  }

  // 获取模型列表
  const fetchBtn = el(host, 'api-library-fetch-models-btn');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      const url = normalizeApiUrl(fUrl.value);
      const key = String(fKey.value || '').trim();
      if (!url) return say('请先填写 API URL。', '#e0a3a3');
      if (!key) return say('请先填写 API Key。', '#e0a3a3');
      const session = editorSession;
      const request = ++modelRequest;
      const isCurrentRequest = () => request === modelRequest && isCurrentEditor(session, url, key);
      say('正在获取模型列表…', '#d8c399');
      try {
        const resp = await fetch(modelEndpoint(url, 'models'), {
          headers: { Authorization: 'Bearer ' + key },
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!isCurrentRequest()) return;
        const ids = (data.data || []).map((m) => m && m.id).filter(Boolean);
        if (!ids.length) throw new Error('返回里没有模型');
        availableModels = ids.slice();
        modelsEndpoint = { url, key };
        // 候选模型先留在当前草稿，保存时一起写入；取消不改已保存的卡。
        // 拉完直接把列表展开，省一次点击；列表本身限高，不会撑爆容器
        showModelDropdown();
        say('已获取 ' + ids.length + ' 个模型，从下面的列表里选一个。');
      } catch (e) {
        if (isCurrentRequest()) say('获取模型失败：' + (e && e.message ? e.message : e), '#e0a3a3');
      }
    });
  }

  // 测试连接
  const testBtn = el(host, 'api-library-test-btn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const url = normalizeApiUrl(fUrl.value);
      const key = String(fKey.value || '').trim();
      const model = String(fModel.value || '').trim();
      if (!url || !key || !model) return say('URL、Key、模型三项都要填，才能测试。', '#e0a3a3');
      say('正在测试连接…', '#d8c399');
      try {
        const consumer = editorConsumer || (fId.value && listApiConsumers().find(row =>
          (savedApiChain(row) || []).includes(fId.value) && probeKind(row, url, model) === 'image' && row.path));
        const kind = fKind?.value || probeKind(consumer, url, model);
        const typedProfile=readTypedProfile(kind);
        const sample = '接口连接测试';
        const imagePrompt = '一张简单的蓝色方块图';
        const profile = readRequestProfile();
        const imageConfig = kind==='image' && imageRouteConfig({}, {id:fId.value,apiUrl:url,apiKey:key,apiModel:model,...typedProfile});
        const signal = kind==='image' ? imageRequestSignal(imageConfig) : AbortSignal.timeout(30000);
        if (kind === 'image' && api.probeImage) {
          const typedConsumer = !consumer || consumerRequestKind(consumer)==='image' ? consumer : undefined;
          const route = {id:fId.value, apiUrl:url,apiKey:key,apiModel:model,...typedProfile};
          await api.probeImage(typedConsumer, route, imagePrompt);
          return say('连接成功，这条接口已返回图片。');
        }
        const endpoint = kind === 'chat' ? chatCompletionsEndpoint(url) :
          modelEndpoint(url, kind === 'image' ? 'images/generations' : kind);
        const body = kind === 'embeddings' ? embeddingRequestBody(model,sample,typedProfile) :
          kind === 'rerank' ? rerankRequestBody(model,sample,[sample]) :
          kind === 'image' ? (Object.keys(typedProfile.imageRequestProfile || {}).length || /gpt-image|chatgpt-image/i.test(model)
            ? gptImageRequestBody(imageConfig,imagePrompt) : {model,prompt:imagePrompt}) :
          chatRequestBody({model,messages:[{role:'user',content:profile.jsonMode ?
            '请返回 JSON 对象 {"ok":true}。' : '请简短回复「连接成功」。'}],stream:false},
          {apiUrl:url,profile,purpose:'test'});
        if (imageConfig) takeImageRouteSlot(imageConfig);
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) throw new Error('HTTP '+resp.status);
        const data=await resp.json();
        const vector = data?.data?.[0]?.embedding;
        const result = data?.results?.[0];
        const image = data?.data?.[0];
        const valid = kind === 'embeddings' ? Array.isArray(vector) && vector.length && vector.every(Number.isFinite) :
          kind === 'rerank' ? result?.index === 0 && Number.isFinite(result.relevance_score) :
          kind === 'image' ? image?.b64_json || image?.url : String(data?.choices?.[0]?.message?.content||'').trim();
        if(data?.error || !valid)
          throw new Error(data?.choices?.[0]?.finish_reason==='length'?'达到输出上限，未收到回复':'未收到有效回复');
        say('连接成功，这条接口可以使用。');
      } catch (e) {
        say('连接失败：' + (e && e.message ? e.message : e), '#e0a3a3');
      }
    });
  }

  renderList();
  renderBindings();
  const api = { renderList, renderBindings, openEditor, probeImage: options?.probeImage, version: BIND_VERSION };
  try { boundFlag.__frApiLibraryBound = api; } catch (_) {}
  // 顺手把各子系统设置页里留下的占位挂上（幂等，重复调用只重绘）
  try { mountAllApiEmbeds(); } catch (_) {}
  return api;
}

/**
 * 重绘本面板（列表 + 各接口位一览）。
 *
 * 给 main.js 用：打开面板时它先从 IndexedDB 重新拉一遍数据，
 * 拉完调这个函数把界面刷新到最新，避免显示的还是上一次的旧状态。
 *
 * @param {HTMLElement} [host] 面板容器；不传则用已绑定的那个
 * @returns {boolean} 是否真的重绘了
 */
export function refreshPanel(host) {
  const flagHost = host || document;
  let api = null;
  try { api = flagHost.__frApiLibraryBound || document.__frApiLibraryBound; } catch (_) {}
  if (!api) {
    // 还没绑定过，就地绑一次
    if (host) {
      try { bindApiLibraryPanel(host); return true; } catch (_) { return false; }
    }
    return false;
  }
  try {
    if (typeof api.renderList === 'function') api.renderList();
    if (typeof api.renderBindings === 'function') api.renderBindings();
    try { mountAllApiEmbeds(); } catch (_) {}
    return true;
  } catch (e) {
    console.warn('[API 接口库] 刷新面板失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

