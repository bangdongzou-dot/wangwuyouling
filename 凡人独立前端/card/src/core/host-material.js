// ============================================================
// 宿主资料采集层：原著指导到底要吃什么
//
// 用户 2026-10-21 最后一条指令：
//   「重点在你怎么拿到这些资料，把这件事情做通」
//
// ------------------------------------------------------------
// 为什么单独一层：
//
//   原版 service.ts 的输入契约有 12 项资料（时间地点、玩家输入、近期正文、
//   RAG、叙事记忆、状态快照、人物、物品、灵兽、事件、地图、世界因子）。
//   目标前端里这些资料**分散在十几个不同的全局和函数里**，
//   每个的取法都不一样：
//
//     lastAiStoryText              → 闭包变量
//     generatePrettySnapshotForAI  → 同步函数
//     getWorldFactorsContext       → 异步函数
//     prepareVectorContext         → 异步，还要传 archive
//     currentState['5']            → 存档表
//     log.smallSummary/largeSummary → 存档日志字段
//
//   如果把这些取法写进 guidance.js，核心包就被宿主绑死了，
//   也没法在 Node 里测。所以：
//     **取法归桥接层，核心包只认「能力名」和「降级」**。
//
// ------------------------------------------------------------
// 本文件负责三件事：
//
//   ① 声明有哪些资料源（key / 名字 / 说明 / 属于哪一组）
//   ② 按 profile 去 host 上逐项取，取不到就记一条诊断，不抛错
//   ③ 把取到的资料拼成给模型看的段落，并在诊断里说清「哪几项是空的」
//
//   每项按玩家设置限长；0完整发送，报告保留实际取回与发送字数。
// ============================================================

/** 一般资料项默认上限；关键资料另设预算。 */
export const CE_MATERIAL_MAX_CHARS = 32000;

/** 短项（规则、事件、任务这类）单独给更小的上限 */
export const CE_MATERIAL_SHORT_CHARS = 32000;

/** 玩家以完整轮、条、人选资料；零表示该来源全取。 */
export const CE_MATERIAL_COUNT_DEFAULTS={recentStory:3,narrativeMemory:20,worldEvents:20};
export function normalizeMaterialCounts(value={}){
  value=value && typeof value==='object'?value:{};
  return {...value,...Object.fromEntries(Object.entries(CE_MATERIAL_COUNT_DEFAULTS).map(([key,fallback])=>{
    const n=value[key]===undefined?fallback:Number(value[key]);return [key,Number.isFinite(n)&&n>=0?Math.min(10000,Math.floor(n)):fallback];
  }))};
}

/** 本轮人物与事件先成池；档案总库及数量偏好不能替代相关性。 */
export function buildMaterialRequiredScope(input={}){
  const tags=event=>String(event?.title || '').match(/\[人物[:：]([^\]]+)\]/)?.[1]?.split(/[,，]/).map(name=>name.replace(/[(（][^)）]*[)）]/g,'').replace(/\s+/g,'')).filter(Boolean) || [];
  const timeline=Array.isArray(input.timeline)?input.timeline:[],events=Array.isArray(input.events)?input.events:[];
  const canonical=new Set([...(input.canonicalNames || []),...timeline.flatMap(tags)]),players=new Set(input.playerNames || []);
  const mentionText=[input.playerInput,input.storyText].filter(Boolean).join('\n');
  const names=new Set(events.flatMap(tags));
  for(const name of canonical)if(name.length>=2 && mentionText.includes(name))names.add(name);
  for(const person of input.focus?.people || [])if(person.isCanon && (person.sources || []).some(source=>source!=='已有档案'))names.add(person.name);
  for(const row of input.priorNpcState?.records || [])if(canonical.has(row.name))names.add(row.name);
  return {version:1,characterNames:[...names].filter(name=>name && !players.has(name)),canonicalNames:[...canonical].filter(name=>!players.has(name)),eventCodes:[...new Set(events.map(event=>String(event?.title || '').match(/E-\d+(?:\.\d+)?/i)?.[0]).filter(Boolean))],location:String(input.location || ''),text:[mentionText,...events.map(event=>[event.title,event.content_brief,event.content_original].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n')};
}

/**
 * 全部资料源。
 *
 * hostCapability = 去宿主端口上找哪个能力名（见 host-adapter.js）。
 * 没有 hostCapability 的，由调用方直接传（例如本轮正文、年表）。
 */
export const CE_MATERIAL_SOURCES = {
  scene: {
    label: '时间地点',
    group: 'scene',
    desc: '当前世界时间、玩家所在地',
    hostCapability: '',
    maxChars: 200,
  },
  playerInput: {
    label: '玩家输入',
    group: 'scene',
    desc: '这一轮玩家说了什么、想做什么',
    hostCapability: '',
    maxChars: 0,
  },
  currentStory: {
    label: '本轮正文',
    group: 'story',
    desc: '刚写完的这一轮正文，边界判定的必要输入',
    hostCapability: '',
    maxChars: 0,
  },
  recentStory: {
    label: '既往正文',
    group: 'story',
    desc: '上一轮及之前的正文，用来判断剧情走到哪了',
    hostCapability: 'recentStory',
    maxChars: CE_MATERIAL_MAX_CHARS,
  },
  narrativeMemory: {
    label: '叙事记忆',
    group: 'story',
    desc: '分段记忆的小总结/大总结/深度总结，压缩过的长期记忆',
    hostCapability: 'narrativeMemory',
    maxChars: CE_MATERIAL_MAX_CHARS,
  },
  ragVector: {
    label: '设定集检索',
    group: 'lookup',
    desc: '检索人物、物品、功法、势力、地点与灵兽的设定资料',
    hostCapability: 'vectorContext',
    maxChars: 64000,
  },
  stateSnapshot: {
    label: '世界状态快照',
    group: 'state',
    desc: '当前存档中已确认的人物与世界状态',
    hostCapability: 'stateSnapshot',
    maxChars: 64000,
  },
  characters: {
    // 名字沿用原卡的「人物档案」与 {{人物档案}} 占位符（玩家 2026-11-01 提醒）：
    //   「注意占位符，先考虑凡人卡本身是不是有对应的占位符可以调取资料，
    //     实在没有才自己造」
    // 占位符是原卡对外的接口，不能因为内部实现从文字档案改成快照就改名——
    // 改名会让玩家自定义提示词里的 {{人物档案}} 静默失效，
    // 也会让以后合并上游更新冲突。**内容换了，名字不动。**
    //
    // 范围：**只取本轮涉及的原著人物**。
    label: '人物档案',
    group: 'state',
    desc: '本轮涉及的原著人物的结构化状态（快照形态）：境界/身份/性格/状态/位置/灵根/关系/储物袋/装备/动机/目标/生平',
    hostCapability: 'characters',
    maxChars: 64000,
  },
  // 注意：onScene（在场人物）与 beasts（灵兽）**资料源已彻底删除**（玩家 2026-11-01）。
  //
  // 这两项一度只是「移出 profile」，但源定义和占位符还留着，结果是：
  //   `canonGuidance` 里 `{{在场人物}}` / `{{灵兽}}` 永远渲染成空，
  //   玩家在自定义提示词里写了也用不上，还以为自己写错。
  //
  // 这跟 tasks 是同一个道理——占位符存在不等于资料有用。
  // 「要删当然是彻底删除」：源定义、占位符、映射三处一起清掉。
  //
  // 删的理由：
  //   · onScene 是**上一轮**的在场名单，指导发生在正文之前，
  //     本轮谁在场还没定；上一轮情况已完整写在 recentStory 里。
  //   · beasts 是玩家自己的灵兽栏，属于玩家变量；
  //     补演要的是 NPC 快照（src.characters），不含玩家灵兽。
  // 注意：items（随身物品与装备）**资料源已彻底删除**（玩家 2026-11-01 二次纠正）。
  //
  // 第一次只从 turn 删了它，guidance 保留，理由写成「指导不用快照」——
  // 玩家当场戳破：「指导阶段不是一样的道理吗？有快照了还要随身物品做啥？」
  //
  // 查证属实：guidance 的 profile 里确实有 stateSnapshot，
  // 而快照的 state 已含
  //   state.inventory / state.equipment / state.items
  // 所以 items 在**两个阶段都是同一份数据的第二次读取**。
  //
  // 现在源定义、GUIDES、默认关清单、per-actor 清单、模板占位符、
  // guidance 映射，全部一并删除。跟 tasks / onScene / beasts 同一个处理方式。
  worldEvents: {
    label: '世界大事',
    group: 'state',
    desc: '已经记录的世界大事及其影响',
    hostCapability: 'worldEvents',
    maxChars: CE_MATERIAL_SHORT_CHARS,
  },
  // 注意：这里原来有 tasks（任务栏）。
  //
  // 玩家 2026-11-01：「要删当然是彻底删除」。
  // 两个阶段都已不取用，模板占位符也删了，所以资料源定义一并移除 ——
  // 设置面板的「资料来源」里不会再出现「任务」这个开关，
  // 因为它在任何阶段都不会被读取，留着开关只会让玩家以为它能起作用。
  map: {
    label: '地理与小地图',
    group: 'state',
    desc: '世界地图上的地点与当前场景小地图',
    hostCapability: 'map',
    maxChars: 32000,
  },
  worldFactors: {
    label: '世界规则',
    group: 'state',
    desc: '开局的「世界规则变动」条目，全局铁律',
    hostCapability: 'worldFactors',
    maxChars: CE_MATERIAL_SHORT_CHARS,
  },
  canonNode: {
    label: '原著节点',
    group: 'canon',
    desc: '这一刻世界线卡在哪个年表事件',
    hostCapability: '',
    maxChars: 0,
  },
  canonTimeline: {
    label: '共享年表附录',
    group: 'canon',
    desc: '给人物写作额外附上本轮所有候选年表。边界判定和每个人自己的必要年表照常提供',
    hostCapability: '',
    maxChars: 0,
  },
};

/** 资料分组（面板与诊断按这个分组显示） */
export const CE_MATERIAL_GROUPS = {
  scene: '现场',
  story: '剧情',
  lookup: '检索',
  state: '存档',
  canon: '原著',
};

/**
 * 各阶段取哪些资料。
 *
 * 分开的理由很实际：
 *   · 正文前只拿得到「既往正文」，拿不到「本轮正文」（还没写）
 *   · 正文后要做边界判定，必须拿「本轮正文」，不需要再查一遍设定集
 *
 * 用户 2026-10-21 确认「第二种优先，第一种兜底」指的是边界策略，
 * 这里不是那个——这里只是「哪个阶段该问宿主拿什么」。
 */
export const CE_MATERIAL_PROFILES = {
  /** 原著指导（正文前） */
  guidance: [
    'scene',
    'playerInput',
    'recentStory',
    'narrativeMemory',
    'stateSnapshot',
    'ragVector',
    'characters',
    // 注意：onScene（在场人物）**已删除**。
    //
    // 玩家 2026-11-01：
    //   「在场人物我不是说了吗？正文还没开始写，哪来的本轮在场人物，
    //     而上一轮在场人物没有意义了，有上一轮正文就可以了。这个删除了。」
    //
    // 查证属实：ceBridgeReadOnScene() 读的是宿主运行时留下的
    // surroundingCharacters —— 那是**上一轮**结束时的在场名单。
    // 指导发生在正文之前，本轮谁在场还没定；而上一轮的在场情况
    // 已经完整写在 recentStory（既往正文）里了。
    // 留着它等于拿旧名单冒充新情况，只会误导。
    // 注意：items（随身物品与装备）**两阶段都已删除**。
    //
    // 玩家 2026-11-01：「指导阶段不是一样的道理吗？有快照了还要随身物品做啥？」
    //
    // 这条纠正推翻了我原来的判断。最初我只从 turn 删了 items，
    // 理由写成「指导不用快照」—— **那是错的**，指导的 profile 里
    // 明明有 stateSnapshot。既然指导也读快照，而快照的 state 里已经有
    //   state.inventory / state.equipment / state.items
    // 那 items 就是同一份数据的第二次读取，和补演完全同一个道理。
    //
    // 原先「指导不落变量、不改库存」的说法也只解释了「用不上」，
    // 没解释「重复」。真正该守的是不重复注入。
    //
    // 现在 profile、模板占位符 {{物品装备}}、guidance 映射三处一并删除。
    'worldEvents',
    // 注意：tasks（任务栏）**不在此列**，两阶段都已删除。
    //
    // 玩家 2026-11-01：「要删当然是彻底删除」。
    //
    // 最初只在 turn 删了 tasks、guidance 保留，理由是「模板里有 {{任务}} 占位符」。
    // 但那个理由站不住：指导阶段要做的是「教正文AI怎么写当前这一个年表事件」，
    // 而任务栏是玩家的跑腿/悬赏/支线清单 —— 两者根本对不上。
    // 写「韩立初入七玄门」这一幕，与「去城南找李掌柜交药材」无关。
    // 占位符存在不等于资料有用；留着它只是每次多烧一段字数。
    // 现在 profile 与模板占位符一并删除。
    'worldFactors',
    'map',
    'canonNode',
  ],
  /** 原著补演（正文后） */
  turn: [
    // 注意：scene（时间地点）与 playerInput（玩家输入）**已删除**。
    //
    // 玩家 2026-11-01：
    //   「原著补演这里的现场，时间地点和玩家输入就是刚才误导npc正文写成玩家的最大诱因，
    //     删除掉，玩家的内容早体现在正文里了，不需要再注入这两项」
    //
    // 道理：补演是「正文之后」写幕外人物。这一轮发生了什么、玩家在哪、说了什么，
    // 已经**完整写进 currentStory（本轮正文）**了。再额外注入一遍「时间地点 + 玩家输入」，
    // 等于把玩家视角又强调一次，每个 NPC 拿到 prompt 时最容易把自己写成玩家。
    // 这正是上一轮「韩立正文写成玩家」的诱因之一。
    //
    // 注意：guidance（指导）阶段仍然要这两项 —— 那时候正文还没写，
    // 指导要知道「玩家在哪、想干什么」才能判断这一事件怎么写。
    'ragVector',
    'currentStory',
    'narrativeMemory',
    // ★ 补演要的是**人物快照**，不是人物档案（玩家 2026-11-01）。
    //
    // 玩家原话：「不对，原著指导阶段需要的是档案，补演阶段需要的是快照」
    //
    // 两件事的分工（查证代码后确认，本来就有天然分离）：
    //   · 指导 guidance —— 用 characters 资料项 → 模板占位符 {{人物档案}}
    //     （那是「这个人是谁」的文字档案，供正文AI参考怎么写）
    //   · 补演 turn —— 不用 characters 资料项。
    //     补演走的是 canon-bridge 的 src.characters（结构化人物对象），
    //     每个 NPC 拿自己那份 state/goal/profile 去写幕外经历。
    //     所以这里再拉一份文字档案是**白拉的**，只会重复占字数。
    //
    // 注意：历史上这里曾放 stateSnapshot（世界状态快照）又被删掉，
    // 那是因为当时的快照是 generatePrettySnapshotForAI 的**玩家视角渲染**
    // （[你]、我的灵兽、当前任务，玩家与 NPC 混排）。
    // 玩家现在要的「快照」是**全量人物快照**，即上面说的 src.characters 那条路，
    // 与那个污染版快照不是一回事。
    //
    // 注意：items（随身物品与装备）**已删除**（玩家 2026-11-01）。
    //
    // 玩家：「原著补演阶段我们不是说只采集本轮涉及的原著人物的快照吗？
    //        另一方面说有快照自然就有物品和装备的信息了啊」
    //
    // 对：人物快照的 state 里已经有
    //   state.inventory / state.equipment / state.items
    // 三个字段（见 ceBridgeReadCharacters 的产物）。
    // 再单拉一份 items 资料项，就是同一份数据的第二次读取 —— 纯重复。
    'worldEvents',
    //
    // 玩家 2026-11-01：「要删当然是彻底删除」。
    //
    // 通查全链路后确认它两个阶段都搭不上：
    //   · 补演 —— background = hostMaterial.text 全量拼接，任务栏无任何消费方；
    //   · 指导 —— 要做的是「教正文AI怎么写当前这一个年表事件」，
    //            而任务栏是玩家的跑腿/悬赏/支线清单，与「怎么写这一幕」无关。
    // 最初只在 turn 删、guidance 保留（理由是模板里有 {{任务}} 占位符），
    // 但占位符存在不等于资料有用 —— 现在 profile 与模板占位符一并删除。
    'worldFactors',
    'map',
    'canonTimeline',
  ],
};

/**
 * 资料源清单（面板用）。
 * @returns {Array<{key:string,label:string,group:string,groupLabel:string,desc:string}>}
 */
export function materialSourceList() {
  return Object.entries(CE_MATERIAL_SOURCES).map(([key, spec]) => ({
    key,
    label: spec.label,
    group: spec.group,
    groupLabel: CE_MATERIAL_GROUPS[spec.group] || spec.group,
    desc: spec.desc,
  }));
}

/**
 * 资料开关的**新默认值**（玩家 2026-11-01 定）。
 *
 * 玩家原话：
 *   「新默认直接覆盖掉老档，因为这种问题是属于优化更新，一定更好，不需要给玩家选择」
 *   「我说的不给选择是这轮更新不给选择，不是让你移除选择」
 *
 * 所以口径是：
 *   · **默认值**改掉，老存档也按新默认走（这轮直接生效，不用玩家手动关）；
 *   · **开关全部保留**，玩家想开随时能开回来 —— 不是把人选项删了。
 *
 * 哪些默认关、为什么，逐条见下，每条都是通查消费方定的，不是感觉：
 *
 * 【map 地理与小地图】**已改回默认开**（玩家 2026-11-01 修正）
 *
 * 第一轮我把它默认关了，理由是「5717 字、指导不是走地图」。
 * 玩家纠正：「原著指导阶段收集地理和小地图没有问题，因为需要参考这个
 *             来指导本轮正文关于地理方面的内容」——是我判断错了。
 * 指导要写「这一幕在哪、周围什么环境、人怎么走」，地理正是需要的。
 * 补演侧的问题则是**小地图**（描述玩家脚下那个区域），
 * 那个已由 ceBridgeReadMap(skipSceneMap) 在 turn 阶段单独去掉，
 * 剩下的「世界地图要点」是跨区域地理，两阶段都有用。
 * 所以 map 从默认关名单里移除 —— 两阶段都默认开。
 *
 * 【items 随身物品与装备】默认关
 *   指导阶段不落变量、不改库存，物品细节对「怎么写」帮助有限；
 *   真需要时来自 ragVector 的原著设定。
 *
 * 【narrativeMemory 叙事记忆】默认关
 *   正文长期压缩摘要。补演写的是「正文之外的幕外经历」，与之重叠度低；
 *   而且常年第 1 轮就是空的。
 *
 * 【tasks 任务】不在这张表里 —— 它是**彻底删除**，不是「默认关」
 *   玩家 2026-11-01：「要删当然是彻底删除」。
 *   两个阶段的 profile 都已移除，模板里的 {{任务}} 占位符也一并删掉。
 *   原因：补演无消费方；指导要写「当前事件怎么演」，与玩家任务清单无关。
 *
 * 其余项一律保持开启。
 */
export const CE_MATERIAL_OFF_BY_DEFAULT = ['narrativeMemory'];

/**
 * 资料开关的默认值。
 *
 * 玩家 2026-10-21：「找到的有对应的项目都加进去」——所以基线是**全开**；
 * 玩家 2026-11-01 又指出几项「作用不大」，于是它们默认关。
 * 每项玩家都能自己改回来。
 *
 * @returns {Record<string, boolean>}
 */
export function materialDefaults(profile) {
  const out = {};
  for (const key of Object.keys(CE_MATERIAL_SOURCES)) out[key] = true;
  for (const key of CE_MATERIAL_OFF_BY_DEFAULT) out[key] = false;
  if (profile === 'turn') out.canonTimeline = false;
  return out;
}

/** 这一项是不是「新默认就关」的（面板用来提示玩家） */
export function materialOffByDefault(key) {
  return CE_MATERIAL_OFF_BY_DEFAULT.includes(key);
}

/** 玩家设置按资料源生效；0表示完整发送，未设置沿各源默认值。 */
export function normalizeMaterialLimits(value={}) {
  return Object.fromEntries(Object.entries(CE_MATERIAL_SOURCES).map(([key,spec])=>{
    const n=value[key]===undefined?spec.maxChars:Number(value[key]);
    return [key,Number.isFinite(n)&&n>=0?Math.min(500000,Math.floor(n)):spec.maxChars];
  }));
}

/**
 * 算这一阶段实际要取哪些资料（profile ∩ 玩家开关）。
 *
 * 注意这里**不再有强制关闭**：
 * 玩家开关说了算，默认值由 materialDefaults() 提供（那几项默认关）。
 * 想开就开，不会被代码拦回来。
 *
 * @param {string} profile
 * @param {Record<string, boolean>} [enabled] 已合并默认值的开关表
 * @returns {string[]}
 */
export function resolveMaterialKeys(profile, enabled) {
  if(enabled===false)return [];
  const name = CE_MATERIAL_PROFILES[profile] ? profile : 'guidance';
  const keys = CE_MATERIAL_PROFILES[name].slice();
  const flags = enabled && typeof enabled === 'object' ? enabled : null;
  // 没显式写过的项按「新默认」走，不能因为缺字段就当开。
  const defaults = materialDefaults(name);
  return keys.filter((key) => {
    const v = flags?.[key];
    if (v === undefined) return defaults[key] !== false;
    return v !== false;
  });
}

/**
 * 调一个宿主能力并按上限截断。
 *
 * 任何异常都吞掉并记进 report——**资料取不到不该让整轮停下**。
 *
 * @param {object} host
 * @param {string} capability
 * @param {*} arg
 * @param {number} maxChars
 * @returns {Promise<{text:string, status:string, reason:string}>}
 */
async function callCapability(host, capability, arg, maxChars, queryOptions) {
  if (!capability) {
    return { text: '', status: 'self', reason: '由调用方直接传入' };
  }
  const fn = host && host[capability];
  if (host && host.capabilities && typeof host.capabilities.has === 'function' && !host.capabilities.has(capability)) return {text:'',status:'missing',reason:'宿主没有提供这个能力'};
  if (typeof fn !== 'function') {
    return { text: '', status: 'missing', reason: '宿主没有这个能力' };
  }
  let ownReceipt=null,ownScope=null;
  const vectorOptions={...queryOptions,onReceipt(value){ownReceipt=value;queryOptions?.onReceipt?.(value);},onMaterialRequest(value){ownScope=value;queryOptions?.onMaterialRequest?.(value);}};
  try {
    const raw = arg === undefined ? await fn() : capability==='vectorContext'?await fn(arg,vectorOptions):await fn(arg);
    const text = normalizeText(raw);
    const receipt=capability==='vectorContext'?{...(ownReceipt || fn.lastReceipt || {status:text?'found':'not_found',reason:text?'检索完成并返回资料':'检索完成，未命中资料',attempted:true,completed:true}),requestScope:ownScope || fn.lastMaterialRequest}:{...(fn.lastSelection || {})};
    if (!text) return {text:'',status:'empty',reason:'宿主返回空',...receipt};
    const truncated=maxChars>0 && text.length>maxChars;
    const clipped = truncated ? text.slice(0, maxChars) + '\n（已截断）' : text;
    return {text:clipped,status:'ok',reason:truncated ? '超过玩家设置的单项上限，已截断' : '',...receipt,originalChars:text.length,truncated};
  } catch (error) {
    return {
      text: '',
      status: 'error',
      reason: String(error && error.message ? error.message : error),
      ...(capability==='vectorContext' ? {...(ownReceipt || {}),status:'error',attempted:true,completed:false,requestScope:ownScope} : {}),
      ...Object.fromEntries(['requestStage','errorType','rawError','httpStatus','errorName'].filter(key=>error && error[key]!==undefined).map(key=>[key,error[key]])),
    };
  }
}

/**
 * 把宿主返回的任意形态归一成文本。
 * 允许宿主直接返回字符串（推荐），也容忍数组/对象（调试用）。
 */
function normalizeText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((x) => normalizeText(x))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2).trim();
    } catch {
      return '';
    }
  }
  return String(raw).trim();
}

/**
 * 采集一阶段要用的全部资料。
 *
 * @param {object} input
 * @param {object} input.host CEHost 端口
 * @param {string} input.profile 'guidance' | 'turn'
 * @param {object} [input.direct] 调用方直接给的值 { currentStory, playerInput, onScene, canonNode, canonTimeline, scene }
 * @param {Record<string,boolean>} [input.enabled] 玩家开关
 * @param {string} [input.queryText] 给向量检索用的查询文本
 * @param {boolean} [input.skipVector] 跳过检索（正文后不需要再查一遍）
 * @returns {Promise<{material:Record<string,string>, report:Array<object>, text:string}>}
 */
export async function collectHostMaterial(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const host = src.host || {};
  const profile = CE_MATERIAL_PROFILES[src.profile] ? src.profile : 'guidance';
  const direct = src.direct && typeof src.direct === 'object' ? src.direct : {};
  const keys = resolveMaterialKeys(profile, src.enabled);
  const limits=normalizeMaterialLimits(src.limits);
  const counts=normalizeMaterialCounts(src.counts);
  const requiredScope=src.requiredScope && typeof src.requiredScope==='object'?JSON.parse(JSON.stringify(src.requiredScope)):null;
  const reused=src.reuseState && src.reuseState.version===1?src.reuseState:null;
  if(reused){
    if(reused.profile!==profile || Object.keys(CE_MATERIAL_COUNT_DEFAULTS).some(key=>normalizeMaterialCounts(reused.counts)[key]!==counts[key]))throw new Error('已保存资料的阶段或历史范围与本轮不一致，不能复用。');
    for(const key of Object.keys(reused.direct || {}))if(normalizeText(direct[key])!==normalizeText(reused.direct[key]))throw new Error('本轮直接材料已变化，不能复用此前资料。');
  }

  const material = {};
  const report = [];
  let vectorBatches=null;
  let sourceStamp='';
  if(typeof host.materialSourceStamp==='function'){try{sourceStamp=await host.materialSourceStamp();}catch{/* 缺少原时点校验时仍采集，但不允许事后假读当前状态。 */}}

  for (const key of keys) {
    const spec = CE_MATERIAL_SOURCES[key];
    if (!spec) continue;

    // 单项旧字数设置仅保留兼容数据，不能剪断已选中的完整记录。
    const cap = 0;
    const prior=reused?.report?.find(row=>row.key===key);
    if(prior && !['error','unconfigured'].includes(prior.status)){
      if(reused.material?.[key])material[key]=reused.material[key];report.push(JSON.parse(JSON.stringify(prior)));continue;
    }

    // 调用方直接给的优先（本轮正文、年表节点这些宿主不知道）
    const directValue = normalizeText(direct[key]);
    if (directValue) {
      const truncated=cap>0 && directValue.length>cap;
      material[key] = truncated ? directValue.slice(0, cap) + '\n（已截断）' : directValue;
      report.push({ key, label: spec.label, group: spec.group, status: 'direct', chars: material[key].length, originalChars:directValue.length, limitChars:cap,truncated, reason:truncated ? '超过玩家设置的单项上限，已截断' : '' });
      continue;
    }

    // 向量检索要拿查询文本；没给就让调用方关掉
    if (key === 'ragVector') {
      if (src.skipVector === true) {
        report.push({ key, label: spec.label, group: spec.group, status: 'skipped', chars: 0, reason: '本阶段跳过检索' });
        continue;
      }
      const query = normalizeText(src.queryText);
      if (!query) {
        report.push({ key, label: spec.label, group: spec.group, status: 'skipped', chars: 0, reason: '没有查询文本' });
        continue;
      }
      let res;
      if(Array.isArray(src.queryBatches) && src.queryBatches.length>1){
        vectorBatches=await Promise.all(src.queryBatches.map(async queryText=>{
          const value=await callCapability(host,spec.hostCapability,queryText,0,{referenceTime:src.queryTime,characterNames:src.queryCharacters});
          const {text,...receipt}=value;
          return {queryText,queryTime:src.queryTime,queryCharacters:src.queryCharacters,text,report:receipt,requestScope:receipt.requestScope};
        }));
        const failed=vectorBatches.find(batch=>batch.report.completed!==true && batch.report.status!=='disabled');
        const text=vectorBatches.map(batch=>batch.text).filter(Boolean).join('\n\n');
        res={text,...(failed?failed.report:{status:text?'found':'not_found',attempted:true,completed:true,reason:text?'检索完成并返回资料':'检索完成，未命中资料'}),originalChars:text.length,batches:vectorBatches.length};
      }else res = await callCapability(host, spec.hostCapability, query, cap,{referenceTime:src.queryTime,characterNames:src.queryCharacters});
      if (res.text) material[key] = res.text;
      if(requiredScope){if(res.text)requiredScope.settingText=res.text;requiredScope.requiredCharacterReceipts=Array.isArray(res.requiredCharacters)?res.requiredCharacters:[];}
      const {text:retrievedText,...receipt}=res;
      report.push({...receipt,key,label:spec.label,group:spec.group,status:res.status,chars:res.text.length,limitChars:cap,originalChars:res.originalChars || 0,truncated:res.truncated === true,reason:res.reason,attempted:res.attempted,completed:res.completed});
      continue;
    }

    if (!spec.hostCapability) {
      // 该由调用方给，但没给
      report.push({ key, label: spec.label, group: spec.group, status: 'empty', chars: 0, reason: '调用方未提供' });
      continue;
    }

    // skipSceneMap：补演阶段只要地理，不要「当前场景小地图」。
    //
    // 玩家 2026-11-01：
    //   「原著补演阶段只需要地理信息，小地图没有任何意义，
    //     因为小地图展示的是正文描述的当前的区域情况，
    //     而能进入补演流程的npc，就一定是不在场的。」
    // 指导阶段照旧两样都要（要参考地理来指导本轮正文的地理内容）。
    const res = await callCapability(host, spec.hostCapability, {count:CE_MATERIAL_COUNT_DEFAULTS[key]===undefined?undefined:counts[key],scope:requiredScope,profile,skipSceneMap:profile==='turn',logId:String(src.logId || '')}, cap);
    if (res.text) material[key] = res.text;
    const {text:retrievedText,...receipt}=res;
    report.push({...receipt,key, label: spec.label, group: spec.group, status: res.status, chars: res.text.length, limitChars:cap, originalChars:res.originalChars || 0, truncated:res.truncated === true, reason: res.reason });
  }

  // 只保存可复现资料查询的数据，不保存宿主函数、接口配置或密钥。
  const retryState={version:1,profile,keys:keys.slice(),limits,counts,requiredScope,selectionMode:'records',logId:String(src.logId || ''),sourceStamp,direct:Object.fromEntries(keys.filter(key=>direct[key]!==undefined).map(key=>[key,normalizeText(direct[key])])),queryText:String(src.queryText || ''),queryTime:String(src.queryTime || ''),queryCharacters:Array.isArray(src.queryCharacters)?src.queryCharacters.slice():[],requestScope:report.find(row=>row.key==='ragVector')?.requestScope,skipVector:src.skipVector===true,material,report};
  if(vectorBatches)retryState.vectorBatches=vectorBatches;
  // keys 一并返回：调用方要按「世界共享 / 个人独享」切分资料时，
  // 需要知道这次实际取了哪几项（见 splitMaterialBySharing）。
  return { material, report, keys: keys.slice(), text: renderMaterialForPrompt(material, keys), retryState };
}

/** 缺少能力、主动跳过和正常空项都不是可重试的读取失败。 */
export function retryableMaterialKeys(state) {
  if(!state || state.version!==1)return [];
  return (state.report || []).filter(row=>['error','unconfigured'].includes(row.status) && CE_MATERIAL_SOURCES[row.key]?.hostCapability).map(row=>row.key);
}

/** 仅取失败来源，成功结果与原查询范围逐字保留。 */
export async function retryHostMaterial({host,state,keys,signal}={}) {
  if(!state || state.version!==1)throw new Error('缺少本次资料读取上下文，请重新进行新一轮。');
  const next=JSON.parse(JSON.stringify(state)),wanted=new Set(keys || retryableMaterialKeys(next));
  for(const key of retryableMaterialKeys(next).filter(key=>wanted.has(key))){
    if(signal?.aborted)throw Object.assign(new Error('已停止补取资料'),{name:'AbortError'});
    const old=next.report.find(row=>row.key===key),spec=CE_MATERIAL_SOURCES[key];
    if(next.vectorBatches && key==='ragVector'){
      for(const batch of next.vectorBatches){
        if(!['error','unconfigured'].includes(batch.report.status))continue;
        const res=await callCapability(host,spec.hostCapability,batch.queryText,0,{referenceTime:batch.queryTime,characterNames:batch.queryCharacters,queryBatchSize:batch.queryBatchSize,materialRequestScope:batch.requestScope});
        if(signal?.aborted)throw Object.assign(new Error('已停止补取资料'),{name:'AbortError'});
        const {text:retriedText,...receipt}=res;
        batch.text=res.text;batch.report={...receipt,chars:res.text.length};
      }
      const failed=next.vectorBatches.find(batch=>!['ok','direct','found','empty','not_found'].includes(batch.report.status));
      const fullText=next.vectorBatches.map(batch=>batch.text || '').filter(Boolean).join('\n\n'),limit=next.selectionMode==='records'?0:next.limits[key],truncated=limit>0 && fullText.length>limit;
      next.material[key]=truncated?fullText.slice(0,limit)+'\n（已截断）':fullText;
      for(const field of ['requestStage','errorType','rawError','httpStatus','errorName'])delete old[field];
      Object.assign(old,failed?failed.report:{status:next.material[key]?'found':'not_found',reason:next.material[key]?'检索完成并返回资料':'检索完成，未命中资料',completed:true,attempted:true,chars:next.material[key].length});
      Object.assign(old,{chars:next.material[key].length,originalChars:fullText.length,limitChars:limit,truncated});
      const characterReceipts=new Map();for(const batch of next.vectorBatches)for(const receipt of batch.report.requiredCharacters || [])if(!characterReceipts.has(receipt.name)||receipt.found===true)characterReceipts.set(receipt.name,receipt);old.requiredCharacters=[...characterReceipts.values()];
    }else{
      const limit=next.selectionMode==='records'?0:next.limits[key];
      const res=await callCapability(host,spec.hostCapability,key==='ragVector'?next.queryText:{count:CE_MATERIAL_COUNT_DEFAULTS[key]===undefined?undefined:next.counts?.[key],scope:next.requiredScope,profile:next.profile,logId:next.logId || ''},limit,{referenceTime:next.queryTime,characterNames:next.queryCharacters,materialRequestScope:next.requestScope});
      if(signal?.aborted)throw Object.assign(new Error('已停止补取资料'),{name:'AbortError'});
      if(res.text)next.material[key]=res.text;else delete next.material[key];
      const {text:retriedText,...receipt}=res;
      for(const field of ['requestStage','errorType','rawError','httpStatus','errorName'])delete old[field];
      Object.assign(old,receipt,{chars:res.text.length,limitChars:limit});
    }
    if(key==='ragVector'&&next.requiredScope){next.requiredScope.settingText=next.material.ragVector || '';next.requiredScope.requiredCharacterReceipts=old.requiredCharacters || [];}
  }
  return {material:next.material,report:next.report,text:renderMaterialForPrompt(next.material,next.keys),retryState:next};
}

/**
 * 把取到的资料拼成给模型看的段落。
 *
 * 空项直接不出现——模型看到一堆「无」反而会开始编。
 *
 * @param {Record<string,string>} material
 * @param {string[]} [order] 输出顺序
 * @returns {string}
 */
/**
 * 每个资料项「是什么 / 拿来干什么 / 别拿它干什么」。
 *
 * 玩家 2026-11-01：
 *   「下一步我让你优化的就是资料分区和提示词优化，说大白话就是把资料整理好
 *     并说清楚每一份资料是什么，有什么用，该怎么用，然后再打包交给 ai。」
 *
 * 以前这里是 `### 标签` + 裸内容，模型只看到一堆标题和文本，
 * 不知道哪段能当事实锚点、哪段只是参考。于是出现：
 *   · 拿 RAG 的「第 N 章」当进度锚点
 *   · 把「尚未发生」的剧透写进正文
 *   · 把人物快照里的空字段当成「没有」
 * 现在每项都带上三句话，用 guide 字段承载。
 */
export const CE_MATERIAL_GUIDES = {
  ragVector: {
    what: '从原著设定集里按关键词查到的资料：人物、物品、功法、势力、地点、灵兽的原始设定。',
    use: '查证「这个东西原本是什么来历、什么品阶、归谁所有」。',
    avoid: '里面的「第 N 章」「首次出现」是来源信息，**不是当前进度锚点**。不要按年份把人物倒推回他早年的状态。原著物品的同一性必须有同名或明确对应证据，不能因为名称、用途、气息相似就套用另一件宝物的品阶与归属。',
  },
  currentStory: {
    what: '刚写完的这一轮正文。已经发生的事实。',
    use: '判断谁的幕外经历需要补、补什么；玩家造成的改变都在这里。',
    avoid: '它不是「预定目标」，不要照着它的写法再演一遍。补演写的是正文之外、别人各自的经历。',
  },
  characters: {
    what: '本轮涉及的原著人物的结构化状态：境界/身份/性格/状态/位置/灵根/关系/储物袋/装备/动机/目标/生平。',
    use: '变量落地的**起点**——要准确增减变量，就得先知道他现在到底有什么、是什么状态。',
    avoid: '这是存档里的实际值，不是原著初始设定；两者冲突时以快照为准。空字段是「未记录」，**不是「没有」**，不要当成零值推理。',
  },
  worldEvents: {
    what: '已经记录在案的世界大事及其影响。',
    use: '提供既成的世界级背景，避免写出与已记录大事矛盾的剧情。',
    avoid: '只是背景，不是本轮必须推进的目标。',
  },
  worldFactors: {
    what: '开局的「世界规则变动」条目，是这个世界的**全局铁律**。',
    use: '任何推演都不能违反。它是最高优先级约束。',
    avoid: '不要把它当成剧情材料写进正文，它是规矩不是素材。',
  },
  map: {
    what: '世界地图要点（跨区域地理）。补演阶段不含当前场景小地图。',
    use: '判断人物之间的距离与可达性，避免同一个人瞬间出现在两个地方。',
    avoid: '能进入补演的 NPC 按定义不在场，不要拿它推玩家身边发生了什么。',
  },
  canonTimeline: {
    what: '原著年表条目，分前情 / 当前 / 后续三档。',
    use: '知道原著时间线上这段时间本该推进到哪；「后续」用于约束，不用于剧透。',
    avoid: '不许提前结算。原著该发生但还没发生的事，不算已完成，也不写进幕外经历当既成事实。日期过了不等于事件完成。',
  },
  narrativeMemory: {
    what: '长期记忆的分段压缩摘要（小总结/大总结/深度总结）。',
    use: '回忆更早之前发生过什么，补充近期正文覆盖不到的部分。',
    avoid: '是压缩过的二次信息，与正文冲突时以正文为准。',
  },
  scene: { what: '当前世界时间与玩家所在地。', use: '定位此刻的坐标。', avoid: '禁止把存档年份与年表年份做换算。' },
  playerInput: { what: '玩家这一轮自己打的字。', use: '理解他的意图。', avoid: '不能替他决定路线。' },
  recentStory: { what: '上一轮及之前的正文。', use: '判断剧情走到哪了。', avoid: '既成事实不许推翻，但也不能当成还没发生。' },
  stateSnapshot: { what: '存档的完整渲染，玩家被标成「你」。', use: '看真实变量。', avoid: '是玩家视角的混合渲染，不要当成中立事实。' },
  canonNode: { what: '当前世界线卡在哪个年表事件。', use: '定位当前事件。', avoid: '不许提前结算。' },
};

export function renderMaterialForPrompt(material, order) {
  const map = material && typeof material === 'object' ? material : {};
  const keys = Array.isArray(order) ? order : Object.keys(CE_MATERIAL_SOURCES);

  const blocks = [];
  for (const key of keys) {
    const text = normalizeText(map[key]);
    if (!text) continue;
    const spec = CE_MATERIAL_SOURCES[key];
    const label = spec ? spec.label : key;
    blocks.push(`### ${label}`);
    const guide = CE_MATERIAL_GUIDES[key];
    if (guide) {
      // 三项都写出来，模型才知道边界在哪
      blocks.push(`（是什么）${guide.what}`);
      blocks.push(`（干什么用）${guide.use}`);
      blocks.push(`（别拿它干什么）${guide.avoid}`);
      blocks.push('');
    }
    blocks.push(text);
    blocks.push('');
  }
  return blocks.join('\n').trim();
}

/**
 * 诊断：这一轮哪些资料取到了、哪些没取到、为什么。
 *
 * 玩家看不懂「status: empty」，所以写成句子。
 *
 * @param {Array<object>} report
 * @returns {Array<{level:string, text:string, detail:string}>}
 */
/**
 * 资料归属：世界共享 vs 个人独享。
 *
 * 玩家 2026-11-01（这是本轮最重要的一条架构决定）：
 *   「世界信息共享，个人信息独享。」
 *   「写谁就只参考谁的资料才对。」
 *
 * 背景：原先 supplementBackground 把 6 项资料全量拼成一坨，每个 NPC 都完整收到一遍
 * （prose-prompt.js 的 sharedBackground）。于是 packRequestMaterials 里的
 * sharedChars 变成一个巨无霸，最后被逼到 maxInputChars = 500000。
 *
 * 分清哪些该给所有人、哪些只该给本人：
 *
 *   shared（世界共享）——不属于任何一个人，但每个人都活在里面
 *     · worldFactors 世界规则：铁律
 *     · worldEvents  世界大事：既成事实
 *     · map          地理：人在哪
 *     · currentStory 本轮正文：这段时间发生了什么（公共信息）
 *     · canonTimeline 原著年表：世界线走到哪
 *     · narrativeMemory 叙事记忆：共同的过往
 *
 *   perActor（个人独享）——写谁才给谁
 *     · ragVector 设定集检索：按人查的设定（写韩立才查韩立）
 *     · characters 人物档案：每个人自己的快照
 *     · items 随身物品：某人自己的储物袋
 *
 * 注意：characters/items 虽然已是「按人」结构，但早先被整表塞进 background。
 * 现在它们必须跟着 perActor 走。
 */
export const CE_MATERIAL_SHARED_KEYS = ['worldFactors', 'worldEvents', 'map', 'currentStory', 'canonTimeline', 'narrativeMemory'];
export const CE_MATERIAL_PER_ACTOR_KEYS = ['ragVector', 'characters'];

/**
 * 把一批资料按「共享 / 独享」切开。
 *
 * @param {Record<string,string>} material
 * @param {{keys?:string[], order?:string[]}} [options] 本次实际取到的 key 列表
 * @returns {{shared:string, perActor:string, sharedKeys:string[], perActorKeys:string[]}}
 */
export function splitMaterialBySharing(material, options = {}) {
  const map = material && typeof material === 'object' ? material : {};
  const present = Array.isArray(options.order) && options.order.length
    ? options.order.filter((k) => normalizeText(map[k]))
    : Object.keys(map).filter((k) => normalizeText(map[k]));

  const sharedKeys = present.filter((k) => CE_MATERIAL_SHARED_KEYS.includes(k));
  const perActorKeys = present.filter((k) => CE_MATERIAL_PER_ACTOR_KEYS.includes(k));
  const unknown = present.filter((k) => !sharedKeys.includes(k) && !perActorKeys.includes(k));

  return {
    // 未知归属一律按共享处理：宁可多给共享的，也不能悄悄丢资料
    shared: renderMaterialForPrompt(map, [...sharedKeys, ...unknown]),
    perActor: renderMaterialForPrompt(map, perActorKeys),
    sharedKeys: [...sharedKeys, ...unknown],
    perActorKeys,
    unknownKeys: unknown,
  };
}

/**
 * 判断一段 RAG 文本讲的是「人」还是「非人（物/功法/势力/地点/灵兽）」。
 *
 * 玩家 2026-11-03：
 *   「能独享拆分的只有这个原著 npc 专属的关于人的设定，
 *     但是非人物的设定你打算怎么处理？是共享还是想办法也找关联到对应的人？」
 *   → 结论：**非人物设定放共享**。
 *
 * 为什么不做「物 → 人」关联（我一度提过，被玩家否掉，是对的）：
 * 关键词匹配无法保证关联正确，反例太多——
 *   · 类别词：「灵石」「丹药」无数人都有，归谁都是错
 *   · 否定语境：「韩立没有得到青元剑」含两个关键词，会误判成他持有
 *   · 一句多人多物：「墨居仁把青元剑交给韩立」——这是事件，不归属任何一方
 *   · 时间错位：档案记「当前持有」，RAG 写「原著某时刻谁持有」
 * 误判的代价是**主动制造「NPC 知道不该知道的」**，正是要消灭的问题的反面。
 *
 * 所以只做一件确定性高的事：**按段落区分人 / 非人**。
 *   · 人物段 → 独享（写谁给谁，按主语判定）
 *   · 非人物段 → 共享（客观世界知识，本就不构成信息优势）
 *
 * 「青元剑是低阶法宝」这件事韩立知道、墨居仁看见也知道，对称，不需要隔离。
 * 「韩立其实不想去」只有韩立知道，不对称，必须隔离。
 *
 * @param {string} paragraph 单段文本
 * @param {string[]} knownNames 本轮涉及的人物名（含别名），用于判定
 * @returns {boolean} true = 人物设定
 */
export function isCharacterSettingParagraph(paragraph, knownNames) {
  const text = normalizeText(paragraph);
  if (!text) return false;
  const names = (Array.isArray(knownNames) ? knownNames : [])
    .map((v) => normalizeText(v)).filter((v) => v.length >= 2);
  if (!names.length) return false;

  // 主语区：剥掉【第N章】【xxx】前缀后，取到第一个标点
  const subject = text.replace(/^[【\[][^】\]]*[】\]]\s*/, '').split(/[，,。；;：:]/)[0].trim();
  if (!subject) return false;

  // 主语以人名开头/包含人名 → 人物设定
  return names.some((n) => subject.includes(n));
}

/**
 * 把 RAG 文本按段落切成「人物设定」与「非人物设定」两部分。
 *
 * 优先相信**检索阶段就分好的类**（玩家 2026-11-03「让ai检索的时候就分好类」）：
 * 前端按检索词的 kind 把命中资料写成两段——
 *   `### 来源目录：【人物设定·私人】` / `### 来源目录：【世界设定·公共】`
 * 无标题的旧资料沿用这两个标记；有完整标题记录时再核对明确实体与类型。
 * 来源目录表示检索词分类，不能证明其中每条命中资料都属于同类。
 *
 * 没有标记时（老自定义提示词只给字符串数组 keywords）才退回主语判定。
 * 这样既用上了分类，也不会因为玩家改过提示词就崩。
 *
 * @param {string} rag
 * @param {string[]} knownNames 已知人物及显式别名；标题记录只做精确匹配
 * @param {object} [options] activeNames 当前人物及显式别名，用于保守保留有称谓歧义的资料
 * @returns {{characterText:string, worldText:string, characterParas:number, worldParas:number, byKind:boolean}}
 */
// A record includes every paragraph under its title. Keep original separators so routing is lossless.
export function splitRagTitleRecords(text) {
  return String(text || '').split(/(?=^###\s*(?:来源目录[:：]|标题[:：]))/m).filter(Boolean);
}

export function ragRecordTitleNames(record) {
  const title=String(record || '').match(/^###\s*标题[:：]\s*([^\r\n]+)/m)?.[1]?.trim() || '';
  return [...new Set([title,...title.split(/[（()）]/)].map(value=>value.trim()).filter(Boolean))];
}

function ragRecordIsExplicitWorld(record) {
  const text=String(record || '');
  return /^\[参考资料[^\r\n]*来源:[^\r\n]*非人物篇/m.test(text)
    || /^(?:类别\s*[:：]\s*|【原著设定】\s*[:：]\s*)(?:物品|功法|秘术|术法|势力|宗门|地理位置|地理|地点|灵草|灵药|妖兽|灵兽|商盟|法宝|世界|时间线)(?:[\s/，,。；;]|$)/m.test(text);
}

export function splitRagBySubject(rag, knownNames, options = {}) {
  const text = normalizeText(rag);
  if (!text) return { characterText: '', worldText: '', characterParas: 0, worldParas: 0, byKind: false };

  // Retrieval-directory labels describe the query, not necessarily every returned record.
  // Exact title/parenthesized alias ownership may override a public query bucket; world types win.
  if(/^###\s*标题[:：]/m.test(text)){
    const names=new Set((Array.isArray(knownNames)?knownNames:[]).map(normalizeText).filter(name=>name.length>=2));
    const active=(Array.isArray(options.activeNames)?options.activeNames:[]).map(normalizeText).filter(name=>name.length>=2);
    const character=[],world=[];let privateSource=false;
    for(const record of splitRagTitleRecords(text)){
      if(/^###\s*来源目录[:：]/.test(record)){
        privateSource=record.includes('【人物设定·私人】');
        (privateSource?character:world).push(record);continue;
      }
      const titles=ragRecordTitleNames(record);
      // A shorter title may be related to a compound actor name, but that is not an alias proof.
      // Keep it shared until an exact title or an explicitly supplied alias can identify its owner.
      const ambiguous=!privateSource&&!titles.some(title=>active.includes(title))
        && titles.some(title=>active.some(name=>name!==title&&name.includes(title)));
      const own=!ambiguous&&titles.length&&(privateSource||titles.some(title=>names.has(title)));
      (own&&!ragRecordIsExplicitWorld(record)?character:world).push(record);
    }
    return {characterText:character.join(''),worldText:world.join(''),characterParas:character.length,worldParas:world.length,byKind:/【(?:人物设定·私人|世界设定·公共)】/.test(text)};
  }

  // ① 有分类标记 → 直接按标记切
  const hasCharMark = text.includes('【人物设定·私人】');
  const hasWorldMark = text.includes('【世界设定·公共】');
  if (hasCharMark || hasWorldMark) {
    // 按「### 来源目录：」切块；切块前的杂项（固定注入说明等）也算一块
    const chunks = text.split(/(?=###\s*来源目录：)/).map((c) => c.trim()).filter(Boolean);
    const charChunks = [];
    const worldChunks = [];
    for (const c of chunks) {
      if (c.includes('【人物设定·私人】')) charChunks.push(c);
      // 世界段、以及任何不带分类标记的块（固定注入/索引指定）一律归共享，不丢
      else worldChunks.push(c);
    }
    return {
      characterText: charChunks.join('\n\n'),
      worldText: worldChunks.join('\n\n'),
      characterParas: charChunks.length,
      worldParas: worldChunks.length,
      byKind: true,
    };
  }

  // ② 没有标记 → 退回主语判定（兼容老格式）
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const charParas = [];
  const worldParas = [];
  for (const p of paras) {
    if (isCharacterSettingParagraph(p, knownNames)) charParas.push(p);
    else worldParas.push(p);
  }
  return {
    characterText: charParas.join('\n\n'),
    worldText: worldParas.join('\n\n'),
    characterParas: charParas.length,
    worldParas: worldParas.length,
    byKind: false,
  };
}

export function materialReportLines(report) {
  const rows = Array.isArray(report) ? report : [];
  const out = [];

  const ok = rows.filter((r) => r.status === 'ok' || r.status === 'direct' || r.status === 'found');
  const bad = rows.filter((r) => !ok.includes(r));

  if (ok.length > 0) {
    out.push({
      level: 'info',
      text: `资料：取到 ${ok.length} 项`,
      detail: ok.map((r) => `${r.label}(${r.chars}字)`).join('、'),
    });
  }

  for (const r of ok.filter(row=>row.truncated)) out.push({level:'warn',text:`资料：「${r.label}」已截断`,detail:`原 ${r.originalChars} 字，发送 ${r.chars} 字`});
  for (const r of bad) {
    const label = r.label || r.key;
    if(r.status==='not_found'){
      out.push({level:'info',text:`资料：「${label}」已检索，未命中`,detail:r.reason || ''});
    }else if(r.status==='disabled'){
      out.push({level:'info',text:`资料：「${label}」已关闭，未执行`,detail:r.reason || ''});
    }else if(['unconfigured','unavailable'].includes(r.status)){
      out.push({level:'warn',text:`资料：「${label}」未执行`,detail:r.reason || ''});
    }else if (r.status === 'skipped') {
      out.push({ level: 'info', text: `资料：跳过「${label}」`, detail: r.reason || '' });
    } else if (r.status === 'missing') {
      out.push({ level: 'warn', text: `资料：宿主没有「${label}」`, detail: r.reason || '' });
    } else if (r.status === 'error') {
      out.push({ level: 'warn', text: `资料：「${label}」取失败`, detail: r.reason || '' });
    } else {
      out.push({ level: 'info', text: `资料：「${label}」为空`, detail: r.reason || '' });
    }
  }

  return out;
}

/**
 * 一行摘要，给设置面板和状态气泡用。
 *
 * @param {Array<object>} report
 * @returns {string}
 */
export function summarizeMaterialStatus(report) {
  const rows = Array.isArray(report) ? report : [];
  if (rows.length === 0) return '资料：未采集';
  const ok = rows.filter((r) => r.status === 'ok' || r.status === 'direct' || r.status === 'found').length;
  const chars = rows.reduce((sum, r) => sum + (Number(r.chars) || 0), 0);
  return `资料：${ok}/${rows.length} 项，共 ${chars} 字`;
}
