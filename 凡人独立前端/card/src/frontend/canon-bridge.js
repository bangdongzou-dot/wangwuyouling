// ============================================================
// 宿主桥接层：CE_CORE ←→ 万物有灵前端
//
// 这是新系统**唯一**需要进入 main.js 的接缝。
//
// 为什么单独一个文件：
//   核心包（CE_CORE）是纯逻辑，不知道酒馆、不知道 dbGet、不知道 showDanmaku。
//   这个文件负责把宿主真实能力递进去，并负责把结果送回玩家看得到的地方。
//   换落地形态（注入器 / 直改正则）时，只改这一个文件。
//
// ------------------------------------------------------------
// 三件事，全部照抄宿主既有做法：
//
//   ① 看得到在运行  → showDanmaku(text, 'status', controller, true)
//   ② 看得到过程    → ceRenderThinkingToStreamTab / thinking-stream-content
//   ③ 找得到在哪配置 → 既有设置面板里插一块
//
// ------------------------------------------------------------
// 依赖（全部由宿主同一闭包提供，缺哪个就降级，不崩）：
//   dbGet / dbSet、genericApiCall、currentState、showDanmaku、
//   ceRenderThinkingToStreamTab、ceExtractOriginalTimelineEventList、
//   wtResolveTimelineTurnRange、manageConcurrentEvolutionSettings、
//   getVectorContext
// ============================================================

var CE_BRIDGE_CONFIG_KEY = 'CULTIVATION_CANON_BRIDGE_CONFIG_V1';

var ceBridgeStatusItem = null;
var ceBridgeActorStatusItems = new Map();
var ceBridgeActorStatusGroup = null;
var ceBridgeLastResult = null;

/**
 * 正文之前那一刻的人物行快照。
 *
 * ============================================================
 * 为什么需要这个东西
 * ============================================================
 *
 * 补演在**正文之后**才跑，那时候 currentState 已经是正文造成的状态了。
 * 可是「旧账」要补的是**正文之前那几个月**——那几个月里这个人还活着、
 * 还没突破、东西还在手上。
 *
 * 如果拿正文后的状态去喂历史，就会出现：
 *   · 本轮正文末尾把人写死了 → 历史里他「已经死了」→
 *     前面几个月的经历全被抹掉（用户 2026-10-21 明确禁止）
 *   · 本轮正文里他突破了 → 历史里写成他早就突破了
 *
 * 这就是方案里的 R01「终点状态污染历史」。
 *
 * 所以 main.js 在 `runConcurrentEvolution` 一进来（还没应用正文和普通演化）
 * 就调 ceBridgeCaptureBeforeState() 存一份。历史模块只用这一份。
 *
 * 注意：这是**只读的历史材料**，绝不用来回写存档。
 */
var ceBridgeBeforeState = null;
var ceBridgeBeforeTime = '';
var ceBridgeBeforeArchive = '';

/**
 * 在正文与普通演化应用之前调用，存一份行快照。
 * 由 scripts/lib/canon-integration-patches.mjs 的 patch 接进 runConcurrentEvolution。
 *
 * @returns {boolean} 有没有真的存到
 */
async function ceBridgeCaptureBeforeState(options) {
  try {
    var opts = options || {};
    if(typeof frOrdinarySettlementPending!=='undefined')frOrdinarySettlementPending=null;
    var state = opts.state || currentState;
    ceBridgeBeforeArchive = currentArchiveName;
    ceBridgeBeforeTime = opts.state ? ceGetAuthoritativeTimeLocationInfo(state).timeText : ceBridgeReadWorldTime();
    if (!state) {
      ceBridgeBeforeState = null;
      return false;
    }
    var rows;
    if (opts.state) {
      rows = {};
      (opts.worldBookEntries || []).forEach(function(entry) {
        try { var row = JSON.parse(entry.content); if (row && (row['0'] || entry.key)) rows[row['0'] || entry.key] = row; } catch (_) {}
      });
      Object.assign(rows,state['0'] || {});
    } else {
      rows = await ceBridgeReadStoredRows();
    }
    if (currentArchiveName !== ceBridgeBeforeArchive) throw new Error('捕获轮前状态时已切换存档');
    if (!rows || typeof rows !== 'object') {
      ceBridgeBeforeState = null;
      return false;
    }
    // 深拷贝：后面 currentState 会被就地改，不能存引用
    ceBridgeBeforeState = JSON.parse(JSON.stringify(rows));
    return true;
  } catch (e) {
    console.warn('[原著补演] 正文前快照捕获失败:', e);
    ceBridgeBeforeState = null;
    ceBridgeBeforeTime = '';
    return false;
  }
}

/**
 * 取正文前的人物行快照。没捕获到就返回 null——
 * 调用方必须据此明确降级（历史用不了就标未确认），
 * 不许默默拿正文后的状态顶上。
 *
 * @returns {object|null}
 */
function ceBridgeGetBeforeState() {
  return ceBridgeBeforeArchive === currentArchiveName ? ceBridgeBeforeState : null;
}
// 最近一次读到的配置。设置面板保存时拿它当 base，
// 避免「面板上没显示的字段被覆盖成默认值」。
var ceBridgeLastConfig = null;

// 共用原年表编辑器；普通模式直注正文，高级模式按供料设置交给独立补演。
var frTimelineUISequence = 0;
async function frTimelineCanonEnabled() {
  var config=await ceBridgeLoadConfig();
  return config.enabled!==false;
}


function frTimelineShowTab(key) {
  var box=document.getElementById('fr-timeline-collaboration');if(!box)return;
  if(!['data','prebuilt','settings'].includes(key))key='data';
  box.querySelectorAll('[data-fr-timeline-panel]').forEach(function(panel){panel.hidden=panel.dataset.frTimelinePanel!==key;});
  box.querySelectorAll('[data-fr-timeline-tab]').forEach(function(tab){var selected=tab.dataset.frTimelineTab===key;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
  if(key==='prebuilt')wtRenderPrebuiltLibrary();
}
async function frTimelineSetCanonEnabled(enabled) {
  if(!frTimelineCanSave())throw new Error('本轮正在运行，请结束后切换协作模式；停止当前补演请使用其停止按钮');
  var config=await ceBridgeLoadConfig();
  config=Object.assign({},config,{enabled:!!enabled});
  if(!await ceBridgeSaveConfig(config))throw new Error('原著补演开关保存失败，仍沿用之前配置');
  ceBridgeLastConfig=config;
  _wtCachedTimelinePromptBlock=null;_wtCachedConcurrentEvolutionTimelinePromptBlock=null;
  if(typeof frCanonRefreshSidebar==='function')frCanonRefreshSidebar();
  return config;
}
function frTimelineCanSave() {
  return !(typeof isMainApiGenerating!=='undefined'&& isMainApiGenerating ||
    typeof concurrentEvolutionRunning!=='undefined'&& concurrentEvolutionRunning ||
    typeof frReplayBusy!=='undefined'&& frReplayBusy ||
    typeof frCanonTraceActive==='object'&& frCanonTraceActive&& frCanonTraceActive.status==='running');
}
function frTimelineFillMaterialUI(){
  var group=document.getElementById('fr-timeline-shared-material');if(!group)return;
  var config=ceBridgeLastConfig||{},mode=['brief','auto','prefer_original'].includes(config.materialMode)?config.materialMode:'current_only',locked=config.enabled!==false;
  group.disabled=locked;group.setAttribute('aria-disabled',String(locked));
  group.querySelectorAll('input[name="fr-timeline-material"]').forEach(function(input){input.checked=input.value===(mode==='prefer_original'?'auto':mode);});
  var status=document.getElementById('fr-timeline-material-status');if(status)status.textContent=locked?'已锁定：由原著补演的年表材料设置自动控制。':'可直接选择；简略＋当前原文：仅进行中事件带原文，其余用条目。保存后生效。';
}
async function frTimelineMaterialMode(){
  var config=await ceBridgeLoadConfig();
  return ['brief','auto','prefer_original','current_only'].includes(config.materialMode)?config.materialMode:'current_only';
}
function frTimelineMaterialForEntry(entry,time,mode){
  var core=ceBridgeCore(),span=core.interval.entrySpan(entry),now=core.interval.parseTimePoint(time);
  return core['vector-input'].renderEventMaterial(entry,{mode:mode || 'current_only',isCurrent:now!==null&&span&&span.min<=now&&now<=span.max,maxChars:0});
}
async function frTimelineReadSource(){
  var loaded=await loadWorldEvolutionTimelineConfig();
  if(!loaded||!Array.isArray(loaded.entries))throw new Error('年表资料无效');
  var config=await ceBridgeLoadConfig(),mode=config.materialMode;
  var entries=frTimelineForPrebuiltSetting(loaded.entries,config);
  return {entries,enabled:true,mode:['brief','auto','prefer_original','current_only'].includes(mode)?mode:'current_only'};
}
function frTimelineForPrebuiltSetting(entries,config){
  return config.prebuiltEnabled===false?entries.map(({prebuilt,...entry})=>entry):entries;
}
async function frTimelineLoadForCanon(phase,traceRun){
  var source=await frTimelineReadSource();
  var entries=source.entries.map(function(entry){return {...entry,content_brief:String(entry.content_brief||entry.brief||''),content_original:String(entry.content_original||entry.original||'')};}).filter(function(row){return row.content_brief.trim()||row.content_original.trim();});
  if(traceRun){Object.defineProperty(traceRun,'_timelineSource',{value:JSON.stringify(source),configurable:true,enumerable:false});frCanonTraceEvent(traceRun,'material','年表 → '+phase,{enabled:true,mode:source.mode,available:source.entries.length,provided:entries.length,source:'已保存年表；统一材料策略',brief:entries.filter(e=>e.content_brief.trim()).length,original:entries.filter(e=>e.content_original.trim()).length});}
  return entries;
}
async function frTimelineAssertSource(expected){
  if(typeof expected!=='string')return;
  if(JSON.stringify(await frTimelineReadSource())!==expected)throw new Error('补演期间已保存年表或补演供料设置变化，拒绝提交旧资料结果');
}
async function frTimelineRefreshUI(){
  var box=document.getElementById('fr-timeline-collaboration');if(!box)return;
  var sequence=++frTimelineUISequence,name=typeof currentArchiveName==='string'?currentArchiveName:'';
  var status=box.querySelector('[data-fr-timeline-status]');status.textContent='读取中…';
  try{
    var enabled=await frTimelineCanonEnabled(),data=await loadWorldEvolutionTimelineConfig();await wtEnsurePromptConfigLoaded();
    var ledger=await ceBridgeLoadLedger({worldTime:ceBridgeReadWorldTime()});
    if(sequence!==frTimelineUISequence||name!==(typeof currentArchiveName==='string'?currentArchiveName:''))return;
    status.textContent=enabled?'当前：正文注入＋原著补演':'当前：普通正文注入';
    var entries=data.entries||[];box.querySelector('[data-fr-timeline-counts]').textContent='年表 '+entries.length+' 条 · 原文 '+entries.filter(e=>String(e.content_original||'').trim()).length+' 条';
    frTimelineFillMaterialUI();
    var classic=box.querySelector('[data-fr-timeline-classic-status]');if(classic)classic.textContent='年表正文注入独立生效；材料方式与原著补演共用一份设置。';
    var promptTip=document.getElementById('fr-timeline-prompt-status');if(promptTip)promptTip.textContent='正文年表注入设置，两种模式共用。';
  }catch(error){status.textContent='读取失败：'+error.message;}
  if(!box.dataset.bound){box.dataset.bound='1';
    box.addEventListener('click',function(event){var tab=event.target.closest('[data-fr-timeline-tab]');if(tab){frTimelineShowTab(tab.dataset.frTimelineTab);return;}var b=event.target.closest('[data-fr-timeline-action]');if(!b)return;var action=b.dataset.frTimelineAction,work=action==='refresh'?frTimelineRefreshUI():null;if(action==='settings'){hideWorldEvolutionTimelineOverlay();work=ceBridgeOpenSettings();}if(action==='records'){hideWorldEvolutionTimelineOverlay();work=frCanonOpenTrace();}if(work&& work.catch)work.catch(e=>{status.textContent=e.message;});});
    
    box.addEventListener('keydown',function(event){var tab=event.target.closest('[data-fr-timeline-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;var tabs=Array.from(box.querySelectorAll('[data-fr-timeline-tab]')),index=tabs.indexOf(tab);index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;event.preventDefault();frTimelineShowTab(tabs[index].dataset.frTimelineTab);tabs[index].focus();});
  }
}

/** 默认配置 */
function ceBridgeDefaultConfig() {
  return {
    enabled: true,
    prebuiltEnabled: true,
    requestsPerMinute: 15,
    maxConcurrency:5,
    materialLimits:{},
    materialCounts:{recentStory:3,narrativeMemory:20,worldEvents:20},
    materialMaxChars:32000,
    requestTimeoutMs: 120000,
    maxOutputTokens:65536,
    proseRewriteCount:1,
    completionRepairCount:3,
    preBoundaryEnabled:true,
    earlyPreparationEnabled:true,
    earlyBoundaryEnabled:true,

    // 补演自己的重排设置（玩家 2026-10-30 要求搬回本面板）。
    // 只影响原著指导与补演这条链路，正文检索仍用原卡那套，互不覆盖。
    // 注意：补演的注入数量仍是「每个检索词各取自己分数最高的一条」，
    // 不受注入数量封顶——那项是给正文用的，这里不再搬。
    retrievalEnableRerank:true,
    retrievalTopK:10,
    retrievalRerankMinScore:0.3,
    retrievalRerankBatch:25,
    retrievalRerankUrl:'',
    retrievalRerankKey:'',
    retrievalRerankModel:'',
    // 检索资料跨轮保留几层楼。
    //
    // ★ 2026-11-02 玩家定：「我的意思是只保留在本回合，因为不存在玩家回退
    //   回合后还打算用旧资料重跑的情况，这是个伪命题。」
    //
    // 所以这里从 3 改成 1：只保留**本回合**那一层检索资料。
    // 理由就是玩家说的——重跑永远是针对「当前这一轮」的，
    // 没人会回退到上一轮之后再用上一轮的检索结果去跑。
    // 留着旧楼层除了误导玩家「是不是能用上」，没有任何实际用处，
    // 还会白占存档空间。改成 1 后：
    //   · 存：只留当前层
    //   · 读：只读当前层
    //   · 面板：不再有「选楼层」这个多余动作
    // 三处口径完全一致，不存在「能看不能用」的歧义。
    materialsKeep:1,
    readyBatchWaitMs:100,
    importantRoleLists:{activeId:'default',lists:[]},
    // 三档待遇：核心名单（A）/ 重要名单（B，即 importantRoleLists）/ 其余原著人物（C）。
    // 核心名单默认四人，玩家可自行增删；上名单只决定待遇，不代表每轮都要演。
    coreCharacterNames:['韩立','南宫婉','紫灵','银月'],
    tierBudgets:{core:800,major:400,minor:160},
    tierBatchSizes:{core:1,major:4,minor:6},
    batchLimits: {maxInputChars:120000,maxOutputChars:16000,timelineBatchEvents:6},
    /* 2026-11-03 玩家：「你别把这个当作默认设置了，只能当作一个高级设置开关，
     *                   用来处理这一类模型的问题，要不要开要看玩家。」
     *
     * assistantPrefillUnsupported：该接口不支持 assistant 预填充。
     *   · 默认 false —— 不做任何额外改写，请求按原样发送；
     *   · 玩家在接口高级参数里打开后，才把末尾 assistant 预填充转为 user 消息；
     *   · 只对「真的不支持」的接口开（例如部分 Gemini 中转），别当成默认行为。
     *   · 字段挂在下属 api 对象上，将来接入统一接口中心时可直接搬过去。
     */
    api: {apiUrl:'',apiKey:'',apiModel:'',assistantPrefillUnsupported:false},
    // 材料策略。默认「当前事件用原文，其余用条目」——
    // 「auto（有原文就用）」会把每条原文都塞进去，闭关百年要 31 万字。
    materialMode: 'current_only',
    boundaryStrategy: 'auto',
    // 分派默认「按档合批」：核心单写、重要与配角按容量合并。
    // 不默认 mixed —— 那会把整个重要名单（几百人）全部单写，请求数失控。
    dispatchStrategy: 'capacity',
    requestBatchVersion: 1,
    eventProgressVersion: 1,
    maxPerBatch: 6,
    coreMaxChars: 800,
    minorMaxChars: 400,
    pov: '',
    promptOverrides: {},
    // 资料开关：空对象 = 全开。
    // 只存玩家显式关掉的项，这样以后新增资料项老存档自动就是开的。
    materials: {},
  /* ★★ 2026-11-01 玩家：「不要共用，原著补演和原著指导分开设置资料来源」
   *
   * materials 那张扁平表只作为**老存档兼容**保留。
   * 新口径走 materialsByStage，两个阶段各存自己一份：
   *   guidance —— 原著指导（正文前）
   *   turn     —— 原著补演（正文后）
   *
   * 为什么必须分开：
   *   指导阶段要「玩家输入、既往正文、原著节点」来判断边界；
   *   补演阶段要「本轮正文、原著年表」来落地变量。
   *   这两套需求重叠不多，用一张表就是让一个阶段的设置去干扰另一个。
   *
   * 空对象 = 该阶段全按默认值。只存关掉的项。
   */
  materialsByStage: { guidance: {}, turn: {} },
    /* 设定集检索按阶段分开关（玩家 2026-11-01 要求）。
     *
     * 玩家的判断：「原著指导阶段不需要详细的设定来支持指导，因为主要的关注点
     * 在剧情，而不是具体的人、事、物的详细变量」；「原著补演的设定集检索
     * 单独设定开关，但是这个就要默认开启了」。
     *
     * 所以两个阶段各有一个独立开关，互不影响：
     *   guidanceRetrievalEnabled —— 原著指导阶段，默认**关**
     *   replayRetrievalEnabled   —— 原著补演阶段，默认**开**
     *
     * 注意别和上面的 materials.ragVector 重复：
     *   materials.ragVector 是「资料清单里这一项要不要」，属于全局总闸；
     *   这两个是按阶段细分的闸门，在总闸打开的前提下再细分。
     * 实际生效 = 总闸开 && 该阶段开关开。
     */
    guidanceRetrievalEnabled: false,
    replayRetrievalEnabled: true,
    // 重试：调用失败时重来几次。
    // 退避曲线不在这里——那是程序策略，玩家只决定试几次。
    retry: { maxRetries: 2, retryOnParseError: true },
    showStatus: true,
    showDiagnostics: true
  };
}

/** 读配置 */
async function ceBridgeLoadConfig() {
  var defaults = ceBridgeDefaultConfig();
  try {
    if (typeof dbGet !== 'function') { ceBridgeLastConfig = defaults; return defaults; }
    var saved = await dbGet(CE_BRIDGE_CONFIG_KEY);
    if (!saved || typeof saved !== 'object') saved = {};
    var merged = Object.assign({}, defaults, saved);
    [['completionRepairCount',3,3],['readyBatchWaitMs',100,200]].forEach(function(field){var raw=merged[field[0]],n=raw===null||raw===''?NaN:Number(raw);merged[field[0]]=Number.isFinite(n)?Math.max(0,Math.min(field[2],Math.floor(n))):field[1];});
    merged.earlyBoundaryEnabled=![false,0,'false','0'].includes(merged.earlyBoundaryEnabled);
    merged.preBoundaryEnabled=![false,0,'false','0'].includes(merged.preBoundaryEnabled);
    merged.earlyPreparationEnabled=![false,0,'false','0'].includes(merged.earlyPreparationEnabled);
    /* 设定集检索的分阶段开关：玩家要的是「默认关 / 默认开」的明确语义。
     * 老存档里没有这两个字段时，必须落到各自默认值上，不能被 undefined 带偏。 */
    merged.guidanceRetrievalEnabled=merged.guidanceRetrievalEnabled===undefined
      ? defaults.guidanceRetrievalEnabled
      : ![false,0,'false','0'].includes(merged.guidanceRetrievalEnabled);
    merged.replayRetrievalEnabled=merged.replayRetrievalEnabled===undefined
      ? defaults.replayRetrievalEnabled
      : ![false,0,'false','0'].includes(merged.replayRetrievalEnabled);
    merged.batchLimits=Object.assign({},defaults.batchLimits,saved.batchLimits || {});
    /* ★★ 2026-11-01：老存档的单批输入容量还是旧默认 12 万，必须迁到新默认 50 万。
     *
     * 玩家两次强调过：「之前让你默认到高数值」。
     * 但 defaults 只在**没有存档**时生效；老存档里写死了 120000，
     * 于是升级后玩家看到的还是 12 万，一遇到大背景就报「容量不足」，
     * 看着像「让你调高你怎么没调」。
     *
     * 迁移规则（只在「还是旧默认值」时才动，绝不覆盖玩家自己填过的数字）：
     *   120000（唯一的旧默认） → 500000（新默认）
     *   80000 / 60000 这类其它值一律不动——那可能是玩家特意调的。
     */
    if (Number(merged.batchLimits.maxInputChars) === 120000) {
      merged.batchLimits.maxInputChars = 500000;
    }
    // 旧字符预算不换算成轮数或条数；自然计数逐字段补默认，显式零值保留。
    merged.materialCounts=Object.assign({},defaults.materialCounts,saved.materialCounts && typeof saved.materialCounts==='object'?saved.materialCounts:{});
    merged.requestBatchVersion=1;
    merged.eventProgressVersion=1;
    delete merged.backgroundPreparationConcurrency;
    delete merged.rerankMaxDocuments;
    delete merged.batchLimits.ragBatchQueries;
    delete merged.allowAutonomous;
    delete merged.autonomousLimit;
    delete merged.soloThreshold;
    // 仅迁移旧版固定预算；其他用户自定义数值保留。
    if (Number(saved.coreMaxChars) === 500) merged.coreMaxChars = 800;
    if (Number(saved.minorMaxChars) === 120) merged.minorMaxChars = 400;
    merged.api = Object.assign({},defaults.api,saved.api || {});
  /* 兼容开关按真布尔归一：只有显式 true / 'true' / 1 才算开启，其余一律关闭。
   * 这样旧存档里没有这个字段时天然是关闭的，不会因为改造而突然改变行为。 */
  merged.api.assistantPrefillUnsupported=merged.api.assistantPrefillUnsupported===true||merged.api.assistantPrefillUnsupported===1||merged.api.assistantPrefillUnsupported==='true'||merged.api.assistantPrefillUnsupported==='1';
    if (!Object.prototype.hasOwnProperty.call(saved,'api') && typeof loadConcurrentEvolutionConfig === 'function') {
      var legacy = await loadConcurrentEvolutionConfig();
      var previousApi = ceResolveOriginalTimelineApiConfig(legacy);
      merged.api = {apiUrl:previousApi.apiUrl,apiKey:previousApi.apiKey,apiModel:previousApi.apiModel};
    }
    merged.promptOverrides = (saved.promptOverrides && typeof saved.promptOverrides === 'object')
      ? saved.promptOverrides : {};
    // 嵌套对象要单独规整：Object.assign 是浅合并，
    // 老存档里若有 materials 但缺 retry，直接覆盖会把新字段丢掉。
    merged.materials = (saved.materials && typeof saved.materials === 'object')
      ? saved.materials : {};
    /* ★★ 2026-11-01：把老存档的扁平 materials 自动升级成「分阶段」结构。
     *
     * 老存档里只有一张扁平表（比如 {narrativeMemory:false}）。
     * 如果不迁移，玩家升级后进面板会看到两个阶段全是空的，
     * 而他的旧设置其实还在——看起来像「设置被抹掉了」。
     *
     * 迁移规则：老档的扁平值原样铺给**两个阶段**。
     *   老档没关的项 → 两阶段都按默认（开）
     *   老档关过的项 → 两阶段都关（尊重玩家原来的意思）
     * 之后玩家再分别调，两份就各自独立了。
     *
     * 已经有 materialsByStage 的（新版存档）就原样用，不覆盖玩家的分阶段设置。
     */
    var savedStage = (saved.materialsByStage && typeof saved.materialsByStage === 'object')
      ? saved.materialsByStage : null;
    if (savedStage) {
      merged.materialsByStage = {
        guidance: (savedStage.guidance && typeof savedStage.guidance === 'object') ? savedStage.guidance : {},
        turn: (savedStage.turn && typeof savedStage.turn === 'object') ? savedStage.turn : {},
      };
    } else {
      // 老档：扁平表按两阶段各铺一份
      merged.materialsByStage = {
        guidance: Object.assign({}, merged.materials),
        turn: Object.assign({}, merged.materials),
      };
    }
    merged.retry = Object.assign(
      {},
      defaults.retry,
      (saved.retry && typeof saved.retry === 'object') ? saved.retry : {}
    );
    ceBridgeLastConfig = merged;
    return merged;
  } catch (e) {
    console.warn('[原著补演] 配置读取失败，用默认值:', e);
    ceBridgeLastConfig = defaults;
    return defaults;
  }
}

/** 存配置 */
async function ceBridgeSaveConfig(config) {
  try {
    if (typeof dbSet !== 'function') return false;
    var next = Object.assign({},config);
    if(typeof CE_CORE==='object'&&CE_CORE['role-roster'])next.importantRoleLists=CE_CORE['role-roster'].normalizeRoleLists(next.importantRoleLists);
    [['completionRepairCount',3,3],['readyBatchWaitMs',100,200]].forEach(function(field){var raw=next[field[0]],n=raw===null||raw===''?NaN:Number(raw);next[field[0]]=Number.isFinite(n)?Math.max(0,Math.min(field[2],Math.floor(n))):field[1];});
    next.earlyBoundaryEnabled=![false,0,'false','0'].includes(next.earlyBoundaryEnabled);
    next.preBoundaryEnabled=![false,0,'false','0'].includes(next.preBoundaryEnabled);
    next.earlyPreparationEnabled=![false,0,'false','0'].includes(next.earlyPreparationEnabled);
    /* 2026-11-01：分阶段资料开关必须有合法的两段结构再入库。
     * 缺了就当空对象（= 该阶段全按默认值），避免存档里留下 undefined
     * 让下次读取时误判成「老存档」而把玩家的分阶段设置又铺成扁平的。 */
    var stageFlags = (next.materialsByStage && typeof next.materialsByStage === 'object')
      ? next.materialsByStage : {};
    next.materialsByStage = {
      guidance: (stageFlags.guidance && typeof stageFlags.guidance === 'object') ? stageFlags.guidance : {},
      turn: (stageFlags.turn && typeof stageFlags.turn === 'object') ? stageFlags.turn : {},
    };
    delete next.backgroundPreparationConcurrency;
    delete next.rerankMaxDocuments;
    if(next.batchLimits)delete next.batchLimits.ragBatchQueries;
    delete next.allowAutonomous;
    delete next.autonomousLimit;
    await dbSet(CE_BRIDGE_CONFIG_KEY, next);
    ceBridgeLastConfig=next;
    return true;
  } catch (e) {
    console.warn('[原著补演] 配置保存失败:', e);
    return false;
  }
}

/** 取核心包；没打进产物就明确报错，不静默 */
function ceBridgeActiveRoleRoster(config) {
  var saved=config || (typeof ceBridgeLastConfig==='object'?ceBridgeLastConfig:null),defaults=typeof CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP==='object'?CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP:{};
  var module=typeof CE_CORE==='object'?CE_CORE['role-roster']:null;
  return module?module.activeRoleRoster(saved?.importantRoleLists,defaults):defaults;
}
/**
 * 归一化叙述人称。
 *
 * 接受三种写法，统一成 prose-prompt.js 认的「第一人称」/「第三人称」：
 *   · 中文全称   '第一人称' / '第三人称'
 *   · 卡内枚举   'first' / 'third'（详细演化正文的下拉框存的就是这个）
 *   · 简写       '1' / '3'、'第一' / '第三'
 * 认不出的一律返回 ''，让调用方继续走下一级兜底 —— 不猜。
 */
function ceBridgeNormalizePov(value) {
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return '';
  if (/第一|first|^1$/.test(text)) return '第一人称';
  if (/第三|third|^3$/.test(text)) return '第三人称';
  return '';
}

/**
 * 从卡内「详细演化正文」的叙述视角设置里取人称。
 *
 * 这个设置存在 CULTIVATION_WORLD_EVOLUTION_API_CONFIG_V1，
 * 字段名 detailedEvolutionPerspective，取值 'first' / 'third'，默认 'first'。
 *
 * 注意：**必须同步读**（localStorage），因为 ceBridgeProseDispatchConfig 是同步函数。
 * 老存档可能只在内存里有值，所以内存变量 worldEvolutionConfig 优先。
 */
function ceBridgeResolveProsePov() {
  try {
    if (typeof worldEvolutionConfig === 'object' && worldEvolutionConfig) {
      var fromMemory = ceBridgeNormalizePov(worldEvolutionConfig.detailedEvolutionPerspective);
      if (fromMemory) return fromMemory;
    }
  } catch (_) {}
  try {
    var raw = localStorage.getItem('CULTIVATION_WORLD_EVOLUTION_API_CONFIG_V1');
    if (raw) {
      var parsed = JSON.parse(raw);
      var fromStore = ceBridgeNormalizePov(parsed && parsed.detailedEvolutionPerspective);
      if (fromStore) return fromStore;
    }
  } catch (_) {}
  return '';
}

function ceBridgeProseDispatchConfig(config) {
  if(typeof ceResolveImportantOriginalRoleName!=='function')throw new Error('原卡原著重要角色名单识别不可用');
  var roster=typeof ceBridgeActiveRoleRoster==='function'?ceBridgeActiveRoleRoster(config):typeof CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP==='object'?CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP:{};
  var module=typeof CE_CORE==='object'?CE_CORE['role-roster']:null;
  var result=Object.assign({},config,{resolveImportantRole:module?function(name){return module.resolveRoleName(roster,name);}:ceResolveImportantOriginalRoleName,originalCharacterNames:Array.from(new Set(Object.entries(roster).flatMap(function(pair){return [pair[0]].concat(pair[1]||[]);}))) });
  // 三档待遇：核心名单与篇幅预算随 config 一起下发，orchestrator 据此分档。
  // 名单只决定待遇；检索资格与待遇分开，不因为进了核心名单就跳过检索。
  result.canonPushBoundaryVersion=config?.preBoundaryEnabled===true?1:0;
  result.coreCharacterNames=Array.isArray(config?.coreCharacterNames)?config.coreCharacterNames.slice():['韩立','南宫婉','紫灵','银月'];
  result.tierBudgets=config?.tierBudgets&&typeof config.tierBudgets==='object'?{...config.tierBudgets}:{core:800,major:400,minor:160};
  result.tierBatchSizes=config?.tierBatchSizes&&typeof config.tierBatchSizes==='object'?{...config.tierBatchSizes}:{core:1,major:4,minor:6};
  result.castTierResolver=module&&typeof module.assignCastTiers==='function'?function(names){
    return module.assignCastTiers(names,{roster,coreNames:result.coreCharacterNames,resolve:function(value){return module.resolveRoleName(roster,value)||String(value||'').trim();}});
  }:null;
  result.resolveOriginalAliases=typeof ceGetImportantOriginalRoleAliases==='function'?ceGetImportantOriginalRoleAliases:function(){return [];};
  if(module)result.resolveOriginalAliases=function(name){return (roster[module.resolveRoleName(roster,name)||name]||[]).slice();};
  // 人称：三级兜底，绝不允许留空。
  //
  // 玩家 2026-11-01 报：「韩立的 NPC 视角正文写成玩家了」——
  // 正文里韩立全用「我」写（破木屋、长满茧子的手、神秘玉石），
  // 玩家一读就以为那是自己。
  //
  // 根因：pov 默认 ''，而 prose-prompt.js 的人称是 `if (pov) {...}` 才下发。
  // 空字符串 = 整段【人称】不出现 → 模型自由发挥 → 中文叙事默认写「我」。
  // 提示词本身又是第二人称写的（「你是韩立。直接写这个人正在经历的事」），
  // 模型顺着「你」往下写，自然就落到「我」。所以这是必然复发，不是偶发。
  //
  // 二级来源：卡内「详细演化正文」的叙述视角 detailedEvolutionPerspective，
  // 存在 CULTIVATION_WORLD_EVOLUTION_API_CONFIG_V1 里，取值 'first' / 'third'。
  // 它以**异步**方式读（ceBridgeLoadConfig 是 async），故此处只做同步兜底，
  // 真实合并见 ceBridgeResolveProsePov()。
  result.pov = ceBridgeNormalizePov(config?.pov) || ceBridgeResolveProsePov() || '第三人称';
  delete result.allowAutonomous;
  delete result.autonomousLimit;
  delete result.soloThreshold;
  return result;
}
function ceBridgeCore() {
  if (typeof CE_CORE === 'undefined' || !CE_CORE) {
    throw new Error('核心包 CE_CORE 未加载：检查构建是否把 src/core 打进产物');
  }
  return CE_CORE;
}

/**
 * 按阶段解析「设定集检索」是否启用（玩家 2026-11-01 要求分阶段）。
 *
 * 两个前提同时成立才真的检索：
 *   ① 资料总闸 materials.ragVector !== false（资料清单里勾了这一项）
 *   ② 该阶段自己的开关为开
 *      stage='guidance' → config.guidanceRetrievalEnabled（默认 false，原著指导）
 *      stage='replay'   → config.replayRetrievalEnabled  （默认 true ，原著补演）
 *
 * 返回一个新的 materials 对象，不修改传入的 config，避免污染其它阶段。
 * 关闭时给 ragVector 置 false —— 这正是 orchestrator/guidance/canon-turn-plan
 * 已有的判断方式，不需要在核心层加新分支。
 */

/**
 * 「新默认就关」的资料项（玩家 2026-11-01）。
 *
 * ⚠ 必须与 core/host-material.js 的 CE_MATERIAL_OFF_BY_DEFAULT 保持一致。
 *   这个文件是前端独立脚本、没有 import，只能本地再写一份；
 *   scripts/verify-material-defaults.cjs 会核对两处是否相同，防止改了一边忘另一边。
 */
var CE_BRIDGE_MATERIAL_OFF_BY_DEFAULT = ['narrativeMemory'];

function ceBridgeMaterialsFor(stage, config) {
  /* ★★ 2026-11-01 玩家：「不要共用，原著补演和原著指导分开设置资料来源」
   *
   * 原来的问题是：config.materials 只是一张**扁平的 key→bool 表**，
   * 两个阶段从同一张表取开关，于是「设定了检索」这种话根本分不开——
   * 玩家在指导阶段关掉某项，补演阶段也跟着关掉。
   *
   * 新结构：config.materialsByStage = { guidance:{...}, turn:{...} }
   *   · 每个阶段读自己那一份；
   *   · 读不到该阶段的分表 → 退回旧的扁平表（老存档自动兼容，不用迁移）。
   *
   * 注意 stage 的命名：调用方传的是 'guidance' / 'replay'，
   * 而 profile 里叫的是 'guidance' / 'turn'。这里统一映射成 profile 名，
   * 免得再出现「名字对不上所以读不到」这类事。
   */
  var profile = stage === 'guidance' ? 'guidance' : 'turn';
  var byStage = config && typeof config.materialsByStage === 'object' && config.materialsByStage
    ? config.materialsByStage[profile] : undefined;
  var base;
  if (byStage && typeof byStage === 'object') {
    // 有分阶段设置：只取这一份，绝不和另一阶段混。
    base = Object.assign({}, byStage);
  } else {
    // 老存档：退回扁平表
    base = config && typeof config.materials === 'object' && config.materials
      ? Object.assign({}, config.materials) : {};
  }
  /* 2026-11-01 玩家：几项资料「作用不大」，要默认关掉，并且
   *   「新默认直接覆盖掉老档，因为这种问题是属于优化更新」
   *   「我说的不给选择是这轮更新不给选择，不是让你移除选择」
   *
   * 这里必须处理老存档：
   * 旧存储口径是「只存玩家关掉的项，空 = 全开」，
   * 所以老档里 materials 是 {}，直接 Object.assign 就什么也没有，
   * 新默认根本落不下去 —— 玩家升级后看起来像没改。
   *
   * 做法：把「新默认关」的项先铺上 false，
   * 再用老档里玩家**真正存过的值**覆盖。
   *   · 玩家没碰过 → 落新默认（关）
   *   · 玩家显式开过（存了 true）→ 尊重，开
   *   · 玩家显式关过（存了 false）→ 尊重，关
   * 这样既满足「这轮直接生效」，又不删玩家选项。
   *
   * 注意：本文件是前端独立脚本，没有 import，拿不到 core 的常量，
   * 所以这里本地再写一份。两处必须一致 —— verify 脚本会核对。
   */
  for (var i = 0; i < CE_BRIDGE_MATERIAL_OFF_BY_DEFAULT.length; i++) {
    var key = CE_BRIDGE_MATERIAL_OFF_BY_DEFAULT[i];
    if (base[key] === undefined) base[key] = false;
  }
  /* 2026-11-01 玩家：「这个是不是没生效？为什么还是在检索，这是原著指导阶段」
   *
   * 旧写法是 `config.guidanceRetrievalEnabled !== false`，
   * 语义是「只要不是 false 就当开着」——
   * 而字段缺失时值是 undefined，`undefined !== false` 为 true，
   * 于是「默认关」变成了「默认开」：玩家没勾选这个开关，
   * 原著指导阶段照样在检索。注释写的是默认关，代码做的是默认开。
   *
   * 改成显式判断「只有明确为 true 才开」，默认才真的是关：
   *   undefined / false / 0 / 'false' / '0'  → 关
   *   true                                   → 开
   * 原著补演阶段保持旧的宽松语义（默认开），只修指导阶段这一个坑，
   * 避免顺手改坏玩家已经习惯的补演行为。
   */
  var enabled;
  if (stage === 'guidance') {
    var raw = config ? config.guidanceRetrievalEnabled : undefined;
    enabled = raw === true || raw === 1 || raw === 'true' || raw === '1';
  } else {
    enabled = config ? config.replayRetrievalEnabled !== false : true;    // 默认开
  }
  if (!enabled) base.ragVector = false;
  return base;
}

// ---------- ① 看得到在运行 ----------

function ceBridgeStatusLabel(item,label){
  var dedicated=item.querySelector('.fr-canon-actor-label');if(dedicated){dedicated.textContent=label;return;}
  var node=Array.from(item.childNodes).find(function(value){return value.nodeType===3;});
  if(node)node.nodeValue=' '+label;else item.textContent=label;
}
function ceBridgeCloseActorStatus(ownerRun){
  if(typeof ceBridgeActorStatusItems==='undefined')return;
  var own=arguments.length>0;
  ceBridgeActorStatusItems.forEach(function(item,name){if(own&&item._frCanonRun!==ownerRun)return;item.aborted=true;item.remove();ceBridgeActorStatusItems.delete(name);});
  if(typeof ceBridgeActorStatusGroup!=='undefined'&&ceBridgeActorStatusGroup&&(!own||ceBridgeActorStatusGroup.run===ownerRun)){
    var group=ceBridgeActorStatusGroup;if(group.detach)group.detach();group.node.remove();ceBridgeActorStatusGroup=null;
    var container=document.getElementById('status-indicator-container');if(container&&!container.childElementCount)container.remove();
  }
}
function ceBridgeActorStatus(rows,run,progressState){
  if(run!==frCanonTraceActive||run.archiveName!==currentArchiveName||run._controller?.signal.aborted||run.status!=='running'){ceBridgeCloseStatus(run);return;}
  if(ceBridgeActorStatusGroup&&ceBridgeActorStatusGroup.run!==run)ceBridgeCloseActorStatus();
  if(ceBridgeStatusItem){ceBridgeStatusItem.aborted=true;ceBridgeStatusItem.remove();ceBridgeStatusItem=null;}
  // 合并请求只出一个气泡。
  // 原来这里给 rows 里每个人都建一个气泡，9 个人同属一次「核对人物正文」请求时
  // 屏幕上会同时挂 9 个「原著补演 · 某某 · 核对人物正文」——这正是玩家说的「太吓人」。
  // 判据：同一阶段的人本来就在同一次请求里，合并成一条「阶段 · 甲、乙等9人」即可；
  // 只有阶段确实不同（比如正文生成和变量结算并行）才分开显示。
  var byStage=new Map();
  for(var row of rows){
    if(!row||(!row.name&&!row.work))continue;
    var stageKey=String(row.requestId||row.stage||row.work||'');
    if(!byStage.has(stageKey))byStage.set(stageKey,{work:row.work,stage:row.stage,names:[],waiting:false});
    var bucket=byStage.get(stageKey);
    var rowNames=String(row.name||row.subject||'').split('、').filter(Boolean);
    for(var name of rowNames)if(bucket.names.indexOf(name)<0)bucket.names.push(name);
    if(row.waiting)bucket.waiting=true;
  }
  var status=progressState||frCanonBubbleProgress(run),displayed=Array.from(byStage.entries());
  var stageText=frCanonBubbleText(run,true);
  if(!displayed.length&&status.summary?.total&&stageText)displayed.push(['stage:'+run.currentStage,{work:stageText,names:[]}]);
  var wanted=new Set();
  displayed.forEach(function(pair){var stageKey=pair[0],bucket=pair[1];
    var people=bucket.names;
    // 两人及以下全列，超过两人列前两名并标总数，和变量演化的口径一致。
    var shown=people.slice(0,2).join('、')+(people.length>2?'等'+people.length+'人':'');
    if(!bucket.work)return;
    var label=frCanonBubblePhase(run)+' · '+bucket.work+(people.length>1?' · '+shown:people[0]?' · '+people[0]:'')+(bucket.waiting?'（等待额度）':'');
    var key='stage:'+stageKey;
    wanted.add(key);
    var item=ceBridgeActorStatusItems.get(key);
    if(!item){
      item=showDanmaku(label,'status',run._controller,true);if(!item)return;
      if(!ceBridgeActorStatusGroup){
        var group=document.createElement('div');group.className='fr-canon-actor-status-group';group.setAttribute('aria-label','原著补演当前任务与完成情况');item.parentElement.appendChild(group);
        var stop=function(){ceBridgeCloseStatus(run);};run._controller.signal.addEventListener('abort',stop,{once:true});
        ceBridgeActorStatusGroup={node:group,run:run,detach:function(){run._controller.signal.removeEventListener('abort',stop);}};
      }
      var text=Array.from(item.childNodes).find(function(value){return value.nodeType===3;});
      var span=document.createElement('span');span.className='fr-canon-actor-label';span.textContent=label;if(text)text.replaceWith(span);else item.appendChild(span);
      item.classList.add('fr-canon-actor-status');item.dataset.frCanonActorStatus=people.join('、');item._frCanonRun=run;item.originalText=label;
      ceBridgeActorStatusGroup.node.appendChild(item);ceBridgeActorStatusItems.set(key,item);
    }else{
      ceBridgeStatusLabel(item,label);
      item.dataset.frCanonActorStatus=people.join('、');
    }
    item.title=label+'；点击停止本轮原著任务';
  });
  // 已经不在本轮任务里的旧气泡要收掉。
  ceBridgeActorStatusItems.forEach(function(item,name){if(!wanted.has(name)){item.aborted=true;item.remove();ceBridgeActorStatusItems.delete(name);}});
  if(ceBridgeActorStatusGroup){
    var progress=ceBridgeActorStatusGroup.node.querySelector('.fr-canon-actor-progress');
    if(!run._prebuiltBubble&&status.summary?.text){if(!progress){progress=document.createElement('div');progress.className='fr-canon-actor-progress';ceBridgeActorStatusGroup.node.prepend(progress);}progress.textContent=status.summary.text;progress.title='NPC 视角正文返回后先核验，再保存变量。登记人数来自本轮已知名单；复用已核验的 NPC 视角正文计入已核验人数。';}else if(progress)progress.remove();
  }
}

function ceBridgeStatus(text, controller, ownerRun) {
  try {
    if (typeof showDanmaku !== 'function') return;
    var label = String(text == null ? '' : text);
    var activeRun = typeof frCanonTraceActive==='object' && frCanonTraceActive || null;
    var run = arguments.length>2 ? ownerRun : activeRun;
    if(run!==activeRun || run && (run.archiveName!==currentArchiveName||run._controller?.signal.aborted)){if(run)ceBridgeCloseStatus(run);return;}
    if(!label.trim()){ceBridgeCloseStatus(run);return;}
    if(typeof ceBridgeCloseActorStatus==='function')ceBridgeCloseActorStatus();
    if(ceBridgeStatusItem && ceBridgeStatusItem._frCanonRun!==run)ceBridgeCloseStatus();
    if (ceBridgeStatusItem && ceBridgeStatusItem.parentElement) {
      var node = null;
      for (var i = 0; i < ceBridgeStatusItem.childNodes.length; i++) {
        var n = ceBridgeStatusItem.childNodes[i];
        if (n && n.nodeType === 3) { node = n; break; }
      }
      if (node) node.nodeValue = ' ' + label;
      else ceBridgeStatusItem.textContent = label;
      return;
    }
    // 第四个参数 true = 带秒表，玩家能看到已经跑了多久
    ceBridgeStatusItem = showDanmaku(label, 'status', controller || (run && run._controller) || null, true);
    if (ceBridgeStatusItem) {
      ceBridgeStatusItem.originalText = run && typeof frCanonBubblePhase==='function'?frCanonBubblePhase(run):label;
      ceBridgeStatusItem._frCanonRun = run;
      ceBridgeStatusItem.title = '点击停止本次原著任务';
    }
  } catch (e) { /* 气泡失败不影响主流程 */ }
}

function ceBridgeCloseStatus(ownerRun) {
  if(typeof ceBridgeCloseActorStatus==='function'){if(arguments.length)ceBridgeCloseActorStatus(ownerRun);else ceBridgeCloseActorStatus();}
  if(arguments.length && ceBridgeStatusItem && ceBridgeStatusItem._frCanonRun!==ownerRun)return;
  try {
    if (ceBridgeStatusItem && typeof ceBridgeStatusItem.remove === 'function') {
      var run=ceBridgeStatusItem._frCanonRun;
      if(run && !['done','saved'].includes(run.status))ceBridgeStatusItem.aborted=true;
      ceBridgeStatusItem.remove();
    }
  } catch (e) {}
  ceBridgeStatusItem = null;
}

// ---------- ② 看得到过程（诊断） ----------

/**
 * 把诊断写进变量思维 tab。
 *
 * 原著诊断统一回到原著补演页，避免污染普通变量思维结果。
 */
function ceBridgePushDiagnostics(html) {
  // 专页是唯一展示入口，旧变量思维不再追加原著资料列表。
  if(typeof frCanonTraceRenderSoon==='function')frCanonTraceRenderSoon();
  return true;
}

/**
 * 说明保存在原著记录中，沿当前回合持久化和回退。
 */
function ceBridgeRememberDiag(items) {
  if(typeof frCanonTraceActive==='object' && frCanonTraceActive && typeof frCanonTraceEvent==='function')frCanonTraceEvent(frCanonTraceActive,'diagnostic','本阶段说明',items || []);
}

/**
 * 单独推一条诊断（main.js 里落地失败之类的地方用）。
 *
 * @param {'info'|'warn'|'error'|'done'} level
 * @param {string} text
 * @param {string} [detail]
 */
function ceBridgePushCanonDiag(level, text, detail) {
  try {
    var core = ceBridgeCore();
    var rec = core.visibility.createDiagRecorder();
    var lv = String(level || 'info');
    if (lv === 'error') rec.error(text, detail);
    else if (lv === 'warn') rec.warn(text, detail);
    else if (lv === 'done') rec.done(text, detail);
    else rec.step(text, detail);

    var html = core.visibility.renderDiagHtml(rec.items());
    ceBridgePushDiagnostics(html);
    ceBridgeRememberDiag(rec.items());
    return true;
  } catch (e) {
    console.warn('[原著补演] 诊断推送失败:', e);
    return false;
  }
}

// ---------- 宿主端口 ----------

/**
 * 造一个 CEHost 交给核心包。
 *
 * 缺哪项能力就让它降级：核心包自己会处理空值，
 * 但**不会**因为宿主缺东西而静默算出错误结果。
 */
function ceBridgeHost(signal, traceRun) {
  var boundArchiveName = currentArchiveName;
  var configs = {
    storageGet: async function (key) {
      if (typeof dbGet !== 'function') throw new Error('dbGet 不可用');
      return dbGet(key);
    },
    storageSet: async function (key, value) {
      if (typeof dbSet !== 'function') throw new Error('dbSet 不可用');
      return dbSet(key, value);
    },
    llmCall: async function (payload) {
      if (currentArchiveName !== boundArchiveName) { var stopped = new Error('已切换存档，丢弃旧补演请求'); stopped.name = 'AbortError'; throw stopped; }
      // 每次调用在异步读配置之前冻结人物归属，避免并发改写同一个父信号。
      var parentSignal=signal || (payload&&payload.signal),taskController=new AbortController(),task=null;
      var forward=function(){taskController.abort(parentSignal.reason);};
      if(parentSignal){if(parentSignal.aborted)forward();else parentSignal.addEventListener('abort',forward,{once:true});}
      if(typeof frCanonTraceLinkSignal==='function')frCanonTraceLinkSignal(parentSignal,taskController.signal,{
        stageKey:payload?.stage||'',subject:payload?.subject||'',targetId:payload?.targetId||'',
        ...(Array.isArray(payload?.targetIds)?{targetIds:payload.targetIds}:{}),
      });
      if(traceRun && payload && payload.stage){frCanonTraceEvent(traceRun,'stage',payload.stage+(payload.subject?' · '+payload.subject:''));if(typeof frCanonProgressStart==='function')task=frCanonProgressStart(taskController.signal,payload.stage,payload.subject||'');}
      try{
        var text = await ceBridgeCallModel(Object.assign({},payload,{signal:taskController.signal}));
        if (currentArchiveName !== boundArchiveName || taskController.signal.aborted) { var invalid = new Error('存档已变化或本轮已停止，丢弃旧补演响应'); invalid.name='AbortError'; throw invalid; }
        return text;
      }finally{if(parentSignal)parentSignal.removeEventListener('abort',forward);if(typeof frCanonProgressEnd==='function')frCanonProgressEnd(task);}
    },
    stateRead: function () {
      try { return typeof currentState !== 'undefined' ? currentState : null; } catch (e) { return null; }
    },
    vectorContext: async function (inputText, requestOptions) {
      // 直接调卡里现成的检索，不重造
      configs.vectorContext.lastReceipt=null;
      configs.vectorContext.lastMaterialRequest=null;
      if (typeof getVectorContext !== 'function') throw new Error('资料检索未执行：原卡getVectorContext能力不存在');
      var settings=typeof ceBridgeLoadConfig==='function'?await ceBridgeLoadConfig():{};
      var receipt=null;
      // 补演只提交年表材料、时间与取消信号，不替原向量系统生成查询或指定重排批次。
      var requestScope={referenceTime:requestOptions && requestOptions.referenceTime};
      configs.vectorContext.lastMaterialRequest=requestScope;
      if(requestOptions && typeof requestOptions.onMaterialRequest==='function')requestOptions.onMaterialRequest(requestScope);

      // ===== 2026-10-31 修复：资料持久化挂在真正的检索入口 =====
      // 玩家口径：「原著补演阶段检索的设定资料本轮内必须保存下来，随时可复用；
      //            本层必须一直在，推进到下一层就可以清理。」
      //
      // 为什么必须挂在这里：
      //   补演走的是 frRunRequiredCanonPreparation → prepareCanonTurnBoundary → 本函数。
      //   之前在 canon-early.js 的 host 上套的 cache.wrap 根本没被调用到
      //   （那条是 earlyBoundaryEnabled===false 的另一条路径），所以：
      //   真机库 FR_CANON_MATERIALS_V1 恒为 0，面板永远「无匹配资料」。
      //   本文件第 584 行直调原始 getVectorContext，绕过一切外层包装，
      //   因此持久化只能落在这一层的调用前后。
      var persistArchive=String(boundArchiveName||currentArchiveName||'');
      // 本层 logId：优先用 traceRun 记下的那一层（补演一定是针对某一层跑的），
      // 取不到再退回存档里最新的 ai 楼层。两者的口径与 frCanonMaterialsFloors 一致。
      var persistLogId=String((traceRun&&traceRun.logId)||'').trim();
      if(!persistLogId && typeof db!=='undefined' && db.archives){
        try{
          var _a=await db.archives.get(persistArchive);
          var _latest=typeof frReplayLatestLog==='function'?frReplayLatestLog(_a):((_a?.data?.logs||[]).filter(function(row){return row.type==='ai'&&!row.isGhost;}).at(-1));
          persistLogId=String(_latest?.id||'');
        }catch(_e){}
      }
      var queryKey=(typeof frCanonMaterialQueryKey==='function')
        ? frCanonMaterialQueryKey(inputText,requestScope) : '';
      // ① 先试复用：本层同一查询已经查过就直接用，不再重复检索。
      if(typeof frCanonMaterialsTake==='function' && queryKey && persistLogId){
        try{
          var cached=await frCanonMaterialsTake(persistArchive,persistLogId,queryKey);
          if(cached && typeof cached.text==='string' && cached.text.trim() && !cached.stale){
            configs.vectorContext.lastReceipt=cached.receipt||null;
            configs.vectorContext.lastMaterialRequest=cached.materialRequest||requestScope;
            try{ if(requestOptions && typeof requestOptions.onReceipt==='function' && cached.receipt) requestOptions.onReceipt(cached.receipt); }catch(_e){}
            if(traceRun)frCanonTraceEvent(traceRun,'material','资料 · vectorContext（复用本层已存）',{chars:String(cached.text||'').length});
            console.log('[资料快照] 复用本层已存资料，跳过检索（'+persistLogId+'）');
            return cached.text;
          }
        }catch(_e){ /* 复用失败就照常检索，不影响主流程 */ }
      }

      var call=await core.retry.withRetry(async function(){
        receipt=null;
        // 年表标题里点名的原著人物透传给原检索，用来在提示词后追加「这些人物设定优先检索」，
        // 并在分析没给出检索词时作为兜底查询。只是把已知的关键人物告诉向量系统，
        // 查询怎么生成、资料怎么取舍仍全部由原卡规则决定。
        var canonPriorityCharacters=Array.isArray(requestOptions && requestOptions.canonPriorityCharacters)?requestOptions.canonPriorityCharacters.filter(Boolean):[];
        var value=await getVectorContext(inputText,{canonLookup:true,silentStatus:true,signal:signal,referenceTime:requestScope.referenceTime,canonPriorityCharacters:canonPriorityCharacters,onSearchProgress:function(value){if(traceRun)frCanonTraceEvent(traceRun,'material','原检索请求状态',value);},onSearchReceipt:function(value){receipt=value;if(requestOptions && typeof requestOptions.onReceipt==='function')requestOptions.onReceipt(value);}});
        signal?.throwIfAborted();
        if(!receipt)throw new Error('原检索未返回执行回信，不能将空串当作已查无资料');
        if(!receipt.completed && receipt.status!=='disabled')throw new Error('资料检索未完成：'+receipt.reason);
        return value;
      },{config:settings.retry,signal:signal});
      configs.vectorContext.lastReceipt=receipt;
      signal?.throwIfAborted();
      if(!call.ok)throw new Error(call.reason);
      var text=call.value;

      // ② 落库：本轮查到的资料立刻存进本层，重跑/结束前都不用再查一遍。
      if(typeof frCanonMaterialsSave==='function' && queryKey && persistLogId && typeof text==='string' && text.trim()){
        try{
          await frCanonMaterialsSave(persistArchive,persistLogId,{ [queryKey]: {
            key:queryKey, text:text, receipt:receipt, materialRequest:requestScope,
            queryText:String(inputText||''), queryKey:queryKey,
            configStamp:(typeof frCanonMaterialsConfigStamp==='function'?frCanonMaterialsConfigStamp():''),
            at:Date.now()
          }});
          if(traceRun)frCanonTraceEvent(traceRun,'material','资料已存入本层',{chars:String(text).length,logId:persistLogId});
          console.log('[资料快照] 已存入本层 '+persistLogId+'（'+String(text).length+' 字符）');
          try{ if(typeof window!=='undefined' && typeof window.frCanonMaterialsChanged==='function') window.frCanonMaterialsChanged(persistLogId); }catch(_e){}
        }catch(_e){
          console.warn('[资料快照] 保存失败：'+String(_e&&_e.message||_e),_e);
        }
      } else if(typeof frCanonMaterialsSave==='function' && !persistLogId){
        console.warn('[资料快照] 未保存：取不到本层 logId');
      }
      return text;
    },

    // ---- 资料源（用户 2026-10-21：有对应的都加进去） ----
    recentStory: ceBridgeReadRecentStory,
    narrativeMemory: ceBridgeReadNarrativeMemory,
    stateSnapshot: ceBridgeReadStateSnapshot,
    characters: ceBridgeReadCharacterDossiers,
    items: ceBridgeReadItems,
    beasts: ceBridgeReadBeasts,
    worldEvents: ceBridgeReadWorldEvents,
    activeWorldEvents: function(at){return ceBridgeCore()['world-events'].formatActiveWorldEvents(Array.isArray(currentState?.['5'])?currentState['5']:[],at||ceBridgeReadWorldTime());},
    tasks: ceBridgeReadTasks,
    map: ceBridgeReadMap,
    worldFactors: ceBridgeReadWorldFactors,

    uiStatus: function (text) { ceBridgeStatus(text); },
    uiThinking: function (items) { ceBridgeRememberDiag(items); }
  };

  var core = ceBridgeCore();
  if(traceRun){
    ['recentStory','narrativeMemory','stateSnapshot','characters','worldEvents','tasks','map','worldFactors','worldbookNames','worldbookEntries','vectorContext'].forEach(function(key){
      if(typeof configs[key]!=='function')return;
      var original=configs[key];configs[key]=async function(){frCanonTraceEvent(traceRun,'stage','采集资料 · '+key);try{var value=await original.apply(this,arguments);frCanonTraceEvent(traceRun,'material','资料 · '+key,traceRun._capture?value:{chars:String(value||'').length});return value;}catch(error){frCanonTraceEvent(traceRun,'error','资料读取失败 · '+key,{error:String(error.message||error)});throw error;}finally{if(original.lastSelection)configs[key].lastSelection=original.lastSelection;if(key==='vectorContext'){configs[key].lastReceipt=original.lastReceipt || configs[key].lastReceipt;configs[key].lastMaterialRequest=original.lastMaterialRequest || configs[key].lastMaterialRequest;}}};
    });
  }
  var port=core['host-adapter'].createHost(configs);
  port.vectorContext.handlesRetries=true;
  port.materialSourceStamp=async function(){return typeof frCanonMaterialSourceStamp==='function'?await frCanonMaterialSourceStamp():'';};
  return port;
}

// ============================================================
// 资料源实现
//
// 每一段都写清了「从宿主的哪里取」。目标前端把这些资料散在
// 闭包变量、同步函数、异步函数、存档表四种位置，所以取法不统一，
// 但对外都是「无参 → 字符串」。
//
// 统一原则：
//   ① 取不到就返回空串，不抛错（采集层会记一条诊断）
//   ② 不自己造数据，宿主有多少给多少
//   ③ 忠实反映宿主现状（例如在场人物就是 surroundingCharacters）
// ============================================================

/**
 * 既往正文。
 *
 * 目标前端有两个变量：
 *   lastAiStoryText            经过清洗的上一轮正文
 *   lastUnoptimizedAiStoryText 未清洗的原文
 *
 * 优先用未清洗的（信息更全），没有才退回清洗过的。
 */
function ceBridgeMaterialPick(records,request,fallback,tail){
  var raw=request&&request.count,count=raw===undefined?fallback:Number(raw);if(!Number.isFinite(count)||count<0)count=fallback;count=Math.floor(count);
  return {rows:count>0?(tail?records.slice(-count):records.slice(0,count)):records.slice(),totalCount:records.length,selectedCount:count>0?Math.min(count,records.length):records.length,selectionCount:count};
}
function ceBridgeMaterialLogWindow(logs,request){
  var id=String(request&&request.logId||'');if(!id){if(request&&request.profile==='turn')throw new Error('缺少本轮正文楼层，不能把当前正文误作既往正文。');return logs.slice();}
  var index=logs.findIndex(function(log){return log&&log.id===id;});if(index<0)throw new Error('当前正文楼层不在有效存档分支中，不能读取旧边界。');return logs.slice(0,index);
}
async function ceBridgeReadRecentStory(request) {
  ceBridgeReadRecentStory.lastSelection={};
  var logs=null;
  if(typeof db!=='undefined' && db && db.archives && typeof currentArchiveName==='string' && currentArchiveName){var archive=await db.archives.get(currentArchiveName);if(!Array.isArray(archive?.data?.logs))throw new Error('存档历史不可读取，不能用当前正文冒充既往正文。');logs=archive.data.logs;}
  if(logs){
    var valid=ceBridgeMaterialLogWindow(logs,request).filter(function(log){return log&&log.type==='ai'&&!log.isGhost&&!log.isDeepSummary&&!log.isSummary&&!log.isSnapshot&&!String(log.content||'').includes('<h4>天道初启</h4>')&&String(log.unoptimizedContent||log.content||'').trim();});
    var picked=ceBridgeMaterialPick(valid,request,3,true);ceBridgeReadRecentStory.lastSelection={selectedCount:picked.selectedCount,totalCount:picked.totalCount,unit:'轮',reason:picked.totalCount?'按有效存档分支读取此前完整正文':'当前有效分支没有既往正文'};
    return picked.rows.map(function(log,index){return '【既往正文 '+(index+1)+'】\n'+String(log.unoptimizedContent||log.content||'').trim();}).join('\n\n');
  }
  if(request&&request.profile==='turn')throw new Error('没有可校验的存档历史，正文后不使用单段缓存冒充既往轮次。');
  var fallback=typeof lastUnoptimizedAiStoryText==='string'&&lastUnoptimizedAiStoryText||typeof lastAiStoryText==='string'&&lastAiStoryText||'';
  ceBridgeReadRecentStory.lastSelection={selectedCount:fallback?1:0,totalCount:fallback?1:0,unit:'轮',compatibilityFallback:!!fallback,reason:fallback?'没有存档历史，仅兼容读取宿主上一段正文，不能代表多轮':'没有存档历史或上一段正文'};
  return fallback;
}

/**
 * 叙事记忆：分段记忆的小总结 / 大总结 / 深度总结。
 *
 * 目标前端把它存在**日志对象**上（log.smallSummary / log.largeSummary），
 * 深度总结是 isDeepSummary === true 的独立一层。
 * 这些日志在 db.archives 里，所以要异步读。
 *
 * 取最近 20 条有总结的层，按时间顺序拼。
 * 这是原版 narrativeMemoryContext 的对应物。
 */
async function ceBridgeReadNarrativeMemory(request) {
  ceBridgeReadNarrativeMemory.lastSelection={};
  var logs = null;
  try {
    if (typeof db !== 'undefined' && db && db.archives && typeof currentArchiveName !== 'undefined' && currentArchiveName) {
      var archive = await db.archives.get(currentArchiveName);
      if (archive && archive.data && Array.isArray(archive.data.logs)) {
        logs = archive.data.logs;
      }
    }
  } catch (e) {
    throw new Error('叙事记忆读取失败：'+String(e.message||e));
  }

  // 读库失败就退回宿主内存里的聊天数组（至少还有最近几层）
  if (!logs) {
    try {
      if (typeof chat !== 'undefined' && Array.isArray(chat)) logs = chat;
    } catch (e) {}
  }
  if (!Array.isArray(logs) || logs.length === 0) return '';

  try {
    var picked = [];
    var source=ceBridgeMaterialLogWindow(logs,request);
    for (var i = 0; i < source.length; i++) {
      var log = source[i] || {};if(log.isGhost||log.isSnapshot)continue;
      var small = String(log.smallSummary == null ? '' : log.smallSummary).trim();
      var large = String(log.largeSummary == null ? '' : log.largeSummary).trim();
      if (!small && !large) continue;
      picked.push({
        deep: log.isDeepSummary === true,
        large: large,
        small: small
      });
    }
    if (picked.length === 0) return '';

    // 只留最近 20 层，避免把整局记忆全端出来
    var selected=ceBridgeMaterialPick(picked,request,20,true),tail=selected.rows;ceBridgeReadNarrativeMemory.lastSelection={selectedCount:selected.selectedCount,totalCount:selected.totalCount,unit:'条',reason:'按完整记忆条目选择，零表示全部'};
    var lines = [];
    for (var j = 0; j < tail.length; j++) {
      var item = tail[j];
      var head = item.deep ? ('【深度记忆 ' + (j + 1) + '】') : ('【第 ' + (j + 1) + ' 层】');
      lines.push(head);
      if (item.large) lines.push('概述：' + item.large);
      if (item.small) lines.push('细节：' + item.small);
      lines.push('');
    }
    return lines.join('\n').trim();
  } catch (e) {
    throw new Error('叙事记忆解析失败：'+String(e.message||e));
  }
}

/**
 * 世界状态快照。
 *
 * 目标前端的 generatePrettySnapshotForAI() 把整份 currentState
 * 转成 TOON 文本（时间地点 + 每个人物的面板/关系/动机/目标/生平）。
 * 这就是原版 stateSnapshot 的对应物，比我们自己拼的强，直接用它。
 */
function ceBridgeReadStateSnapshot() {
  try {
    if (typeof generatePrettySnapshotForAI === 'function') {
      return String(generatePrettySnapshotForAI() || '');
    }
  } catch (e) {
    console.warn('[原著补演] 生成状态快照失败:', e);
  }
  try {
    if (typeof generateFullStateSnapshotString === 'function') {
      return String(generateFullStateSnapshotString() || '');
    }
  } catch (e) {}
  return '';
}

/**
 * 人物档案。
 *
 * 目标前端人物表 currentState['0'] 的列定义（实测 TABLE_DEFINITIONS）：
 *   1 名称/性别  2 境界/身份  3 性格  4 Buffs/状态  5 灵根  6 特殊体质
 *   7 对玩家的称呼  9 备注  10 背景/简介  12 内心想法/动机
 *   13 人际关系  26 当前灵石  27 当前动机  28 短期目标  29 长期目标
 *   35 生平经历
 *
 * 快照里已经包含大部分，但这里**单独再给一份**，
 * 因为原著指导里「这个人是谁、什么身份、什么动机」是最关键的一条，
 * 不能因为快照被截断就丢掉。
 */
function ceBridgeMaterialNameKey(name){var value=String(name||'').split('|')[0].replace(/<[^>]*>/g,'').trim();return typeof ceResolveImportantOriginalRoleName==='function'?ceResolveImportantOriginalRoleName(value)||value:value;}
function ceBridgeMaterialNameIncluded(name,scope){return !scope || (scope.characterNames||[]).some(function(expected){return ceBridgeMaterialNameKey(expected)===ceBridgeMaterialNameKey(name);});}
function ceBridgeMaterialExplicitEntity(name,scope){var value=ceBridgeMaterialNameKey(name);if(!scope||!value||value.length<2||['灵石','药草','丹药','武器','装备','材料','道具','灵兽','功法','储物袋'].includes(value))return !scope;return [scope.text,scope.settingText].filter(Boolean).join('\n').includes(value);}
async function ceBridgeReadCharacterDossiers(request) {
  try {
    ceBridgeReadCharacterDossiers.lastSelection={};
    if (typeof currentState === 'undefined' || !currentState) return '';
    var scope=request&&request.scope,rows=scope&&typeof ceBridgeReadStoredRows==='function'?await ceBridgeReadStoredRows():currentState['0'];
    if (!rows || typeof rows !== 'object') return '';
    /* 玩家 B1 行按阶段区分（玩家 2026-11-01）。
     *
     * 【指导 guidance】—— **要**玩家档案。
     *   玩家原话：「这里的人物档案我反而觉得需要加上玩家的。」
     *   对：指导发生在正文之前，正文AI要知道玩家自己是什么境界、什么身份、
     *   什么性格、跟谁是什么关系，才能判断这一轮该怎么演。
     *
     * 【补演 turn】—— **不要**玩家档案。
     *   「原著补演阶段，不要混入玩家的任何变量信息或者快照信息，
     *     因为玩家与原著补演的关联正文就足够处理…
     *     所以没有除了正文以外的任何注入玩家相关信息和资料的理由。」
     *   补演是给 NPC 写幕外经历，玩家这轮做了什么已在「本轮正文」里；
     *   同一张表里既有 NPC 又有玩家，模型很容易把「我」写成玩家。
     */
    var profile = request && request.profile;
    var skipPlayer = profile === 'turn';
    var lines = [],found=[];
    for (var id in rows) {
      if (!Object.prototype.hasOwnProperty.call(rows, id)) continue;
      if (id === 'TIME_LOCATION_ROW') continue;
      if (id === 'B1' && skipPlayer) continue;
      var row = rows[id] || {};

      var nameGender = String(row['1'] || '').split('|');
      var name = String(nameGender[0] || '').trim();
      if (!name) continue;
      // 玩家行不参与「原著人物池」的 scope 过滤，否则会被当成缺档
      if (id !== 'B1' && scope && !ceBridgeMaterialNameIncluded(name,scope)) continue;
      if (id !== 'B1') found.push(ceBridgeMaterialNameKey(name));
      var gender = String(nameGender[1] || '').trim();

      var realmIdentity = String(row['2'] || '').split('|');
      var realm = String(realmIdentity[0] || '').trim();
      var identity = String(realmIdentity[1] || '').trim();

      var bits = [];
      if (gender) bits.push(gender);
      if (realm) bits.push(realm);
      if (identity) bits.push(identity);

      var parts = ['- ' + id + ' ' + name + (bits.length ? '（' + bits.join('/') + '）' : '')];

      var personality = String(row['3'] || '').trim();
      if (personality) parts.push('性格：' + personality);

      var buffs = String(row['4'] || '').trim();
      if (buffs) parts.push('状态：' + buffs);

      var call = String(row['7'] || '').trim();
      if (call) parts.push('称呼玩家：' + call);

      var relation = String(row['13'] || '').trim();
      if (relation) parts.push('关系：' + relation);

      var motive = String(row['27'] || '').trim();
      if (motive) parts.push('当前动机：' + motive);

      var shortGoal = String(row['28'] || '').trim();
      if (shortGoal) parts.push('短期目标：' + shortGoal);

      var longGoal = String(row['29'] || '').trim();
      if (longGoal) parts.push('长期目标：' + longGoal);

      var background = String(row['10'] || '').trim();
      if (background && background !== '待定') parts.push('背景：' + background);
      if(row['35'])parts.push('已发生生平：'+String(row['35']));
      /* ★ 玩家 2026-11-01：档案改成**快照**，并去掉列号原始 JSON。
       *
       * 玩家先说了「原著指导阶段需要的是档案，补演阶段需要的是快照」，
       * 后来又补充「快照只采集本轮涉及的原著人物的快照」。
       * 但看完两个阶段的职责描述后，结论收敛到：**两阶段都需要快照**——
       *   指导要判断蝴蝶效应（关键物品得失、关键人物当下状态、事件前置条件是否还在）
       *   补演要判断变量增减
       * 这两件事依赖的都是结构化字段，不是叙述性文字。
       *
       * 旧实现有两个浪费：
       *   ① 末尾 `完整档案记录：{整行JSON}` 用的是列号键（"0"/"1"/"2"/"27"），
       *      模型拿不到列名映射，基本读不懂，纯占字数；
       *   ② 缺 location / spiritRoot / constitution / isPlayer 这些快照有的字段。
       *
       * 现在：复用 ceBridgeReadCharacters 生成同构快照，但**只补旧输出缺的字段**，
       * 已经有的（性格/状态/称呼/关系/动机/目标/背景/生平）不重复输出。
       * 第一版把整个 state 块 JSON.stringify 进来，字数从 933 涨到 1318，
       * 涨的全是重复内容 —— 那是错的，已改。
       */
      var snap = (typeof ceBridgeReadCharacters === 'function')
        ? (ceBridgeReadCharacters([name], rows)[name] || null)
        : null;
      if (snap) {
        var st = snap.state || {};
        // 旧输出完全没有的字段
        if (st.location) parts.push('位置：' + st.location);
        if (st.spiritRoot) parts.push('灵根：' + st.spiritRoot);
        if (st.constitution && st.constitution !== '无') parts.push('体质：' + st.constitution);
        if (st.combat) parts.push('战力状态：' + st.combat);
        if (st.innerThought) parts.push('内心想法：' + st.innerThought);
        if (st.attributes) parts.push('属性：' + st.attributes);
        // 物品装备：用**可读名**，不用带列号键的原始对象
        var itemNames = (st.items || []).filter(Boolean);
        if (itemNames.length) parts.push('随身物品：' + itemNames.join('、'));
        var equipNames = [];
        Object.keys(st.equipment || {}).forEach(function (slot) {
          var v = st.equipment[slot];
          var list = Array.isArray(v) ? v : [v];
          list.forEach(function (it) {
            if (it && it['1']) equipNames.push(slot + ':' + String(it['1']).split('|')[0]);
          });
        });
        if (equipNames.length) parts.push('装备：' + equipNames.join('、'));
        if (st.inventoryKnown === false) parts.push('储物袋：未记录（不能视为空）');
        if (st.equipmentKnown === false) parts.push('装备：未记录（不能视为空）');
        if (snap.isPlayer) parts.push('身份：玩家本人');
        if (snap.aliases && snap.aliases.length) parts.push('别名：' + snap.aliases.join('、'));
      }

      lines.push(parts.join('｜'));
    }

    var missing=scope?(scope.characterNames||[]).filter(function(name){return !found.includes(ceBridgeMaterialNameKey(name));}):[],receipts=scope&&scope.requiredCharacterReceipts||[],withSetting=missing.filter(function(name){return receipts.some(function(receipt){return receipt.found===true&&ceBridgeMaterialNameKey(receipt.name)===ceBridgeMaterialNameKey(name);});}),missingSetting=scope?(scope.characterNames||[]).filter(function(name){return !receipts.some(function(receipt){return receipt.found===true&&ceBridgeMaterialNameKey(receipt.name)===ceBridgeMaterialNameKey(name);});}):[];
    ceBridgeReadCharacterDossiers.lastSelection={selectedCount:found.length,totalCount:found.length,unit:'人',archiveAvailableNames:found,missingArchives:missing,settingAvailableNames:withSetting,missingSettingNames:missingSetting,reason:missing.length?'本轮相关人物中 '+missing.join('、')+' 尚未建档；其中 '+(withSetting.length?withSetting.join('、')+' 已取得原著设定':'尚无对应原著设定命中')+'，不能把档案缺失视为人物不存在':'本轮相关原著人物档案及玩家共享背景完整读取'};
    return lines.join('\n');
  } catch (e) {
    throw new Error('人物档案读取失败：'+String(e.message||e));
  }
}

/** 只读原卡本账：玩家库存取物品表，其他人物库存与装备取本人第九列。 */
function ceBridgeActorPossessions(row,charId,state){
  function parse(value,fallback){if(value===undefined||value===null||value==='')return {known:false,value:fallback};try{var result=value;for(var i=0;i<3&&typeof result==='string';i++)result=JSON.parse(result);return {known:true,value:result};}catch(_){return {known:false,value:fallback};}}
  var remarks={};
  if(typeof parseRemarksString==='function')remarks=parseRemarksString(row&&row['9']||'')||{};
  else remarks=parse(row&&row['9'],{}).value||{};
  var bag=charId==='B1'?{known:!!(state&&state['1']),value:Object.values(state&&state['1']||{})}:parse(remarks.inventory,[]);
  var equip=parse(remarks.equipment,{});
  if(!Array.isArray(bag.value)){bag.known=false;bag.value=[];}
  if(!equip.value||typeof equip.value!=='object'||Array.isArray(equip.value)){equip.known=false;equip.value={};}
  function itemText(item){if(!item||typeof item!=='object')return '';var name=String(item['1']||item.name||'').replace(/<[^>]*>/g,'').trim();if(!name)return '';var id=String(item['0']||item.id||''),qty=item['5']!=null?item['5']:item.quantity;return (id?id+' ':'')+name+(qty!=null?' ×'+qty:'');}
  var inventory=JSON.parse(JSON.stringify(bag.value)),equipment=JSON.parse(JSON.stringify(equip.value)),itemNames=inventory.map(itemText).filter(Boolean);
  Object.keys(equipment).forEach(function(slot){var value=equipment[slot];(Array.isArray(value)?value:[value]).forEach(function(item){var text=itemText(item);if(text&&itemNames.indexOf(text)<0)itemNames.push(text);});});
  return {inventory:inventory,equipment:equipment,inventoryKnown:bag.known,equipmentKnown:equip.known,items:itemNames};
}
/** 物品材料保留所有权、原字段和用途；储物袋先于装备，不能用装备代替库存。 */
async function ceBridgeReadItems(request) {
  try {
    ceBridgeReadItems.lastSelection={};
    if (typeof currentState === 'undefined' || !currentState) return '';
    var scope=request&&request.scope,lines=[],rows=scope&&typeof ceBridgeReadStoredRows==='function'?await ceBridgeReadStoredRows():currentState['0']||{},count=0,owners=[];
    /* 物品表里**不再包含玩家 B1**（玩家 2026-11-01）。
     *
     * 「原著补演阶段，不要混入玩家的任何变量信息或者快照信息…
     *   所以没有除了正文以外的任何注入玩家相关信息和资料的理由。」
     *
     * 原来这里会 unshift('B1') 强行把玩家塞进来。但那属于典型的玩家变量：
     * 玩家储物袋里有什么、装备了什么，跟 NPC 写自己的幕外经历无关。
     * 玩家对剧情的影响已经由「本轮正文」承载；玩家与 NPC 的变量交互
     * 由解析正文的普通变量演化接管。
     * 现在只保留**相关原著人物**自己的库存与装备。
     */
    var ids=Object.keys(rows).filter(function(id){return id!=='TIME_LOCATION_ROW'&&id!=='B1';});
    ids.forEach(function(id){var row=rows[id]||{},name=String(row['1']||id).split('|')[0].replace(/<[^>]*>/g,'').trim();if(!name)return;var possessions=ceBridgeActorPossessions(row,id,currentState),requiredOwner=id==='B1'||ceBridgeMaterialNameIncluded(name,scope);
      if(!requiredOwner){possessions.inventory=possessions.inventory.filter(function(item){return ceBridgeMaterialExplicitEntity(item['1']||item.name,scope);});var equipment={};Object.keys(possessions.equipment).forEach(function(slot){var value=possessions.equipment[slot],list=(Array.isArray(value)?value:[value]).filter(function(item){return item&&ceBridgeMaterialExplicitEntity(item['1']||item.name,scope);});if(list.length)equipment[slot]=Array.isArray(value)?list:list[0];});possessions.equipment=equipment;if(!possessions.inventory.length&&!Object.keys(equipment).length)return;}
      count+=possessions.inventory.length;Object.values(possessions.equipment).forEach(function(value){count+=Array.isArray(value)?value.filter(Boolean).length:value?1:0;});owners.push(name);
      lines.push('【'+name+' · '+id+'】');
      lines.push('储物袋：'+(possessions.inventoryKnown?JSON.stringify(possessions.inventory):'未记录，不能视为空'));
      lines.push('装备：'+(possessions.equipmentKnown?JSON.stringify(possessions.equipment):'未记录，不能视为空'));
    });
    ceBridgeReadItems.lastSelection={selectedCount:count,totalCount:count,unit:'件',owners:owners,reason:'相关原著人物与玩家的储物袋、装备按完整对象读取；其他归属只收明确点名的具体物品'};
    return lines.join('\n');
  } catch (e) {
    throw new Error('随身物品读取失败：'+String(e.message||e));
  }
}

/** 灵兽栏 currentState['7'] */
function ceBridgeReadBeasts(request) {
  try {
    ceBridgeReadBeasts.lastSelection={};
    if (typeof currentState === 'undefined' || !currentState) return '';
    var table = currentState['7'];
    if (!table || typeof table !== 'object') return '';

    var lines = [];
    for (var id in table) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
      var row = table[id] || {};
      var name = String(row['1'] || '').trim();
      if (!name) continue;
      var level = String(row['2'] || '').trim();
      var personality = String(row['4'] || '').trim();
      var skill = String(row['5'] || '').trim();
      var bits = [name];
      if (level) bits.push('等级' + level);
      if (personality) bits.push('性格' + personality);
      if (skill) bits.push('技能' + skill);
      lines.push('- ' + id+' '+bits.join('｜')+'\n完整灵兽记录：'+JSON.stringify(row));
    }
    ceBridgeReadBeasts.lastSelection={selectedCount:lines.length,totalCount:lines.length,unit:'只',reason:'宿主灵兽表属于玩家共同背景，完整保留，不按数量截断'};
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

/** 世界事件供料只读表5。人物年表进度继续走独立年表/指针通道，
 * E编号不证明世界级影响，不把拜师修炼等个人经历冒充局势事实。 */
function ceBridgeReadWorldEvents(request) {
  try {
    ceBridgeReadWorldEvents.lastSelection={};
    if (typeof currentState === 'undefined' || !currentState) return '';
    var list = currentState['5'];
    var playerRows = Array.isArray(list) ? list : [];
    var lifecycle=ceBridgeCore()['world-events'], at=ceBridgeReadWorldTime();
    var active=lifecycle.formatActiveWorldEvents(playerRows,at);
    var valid=lifecycle.splitWorldDigest(lifecycle.projectWorldEvents(playerRows,at)).history
      .sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    var scope=request&&request.scope,picked=ceBridgeMaterialPick(valid,request,20,true),required=scope?valid.filter(function(ev){var text=JSON.stringify(ev);return (scope.characterNames||[]).some(function(name){return name.length>=2&&text.includes(name);})||scope.location&&ev.scope===scope.location;}):[],tail=valid.filter(function(ev){return required.includes(ev)||picked.rows.includes(ev);});
    var lines = [];
    for (var i = 0; i < tail.length; i++) {
      var ev = tail[i] || {};
      var time = String(ev.endedAt || ev.endsAt || ev.at || '').trim();
      var place = String(ev.scope || '').trim();
      var desc = [ev.title,ev.description!==ev.title?ev.description:'',ev.effect].filter(Boolean).join('｜');
      if (!desc) continue;
      var head = [time, place].filter(Boolean).join(' / ');
      lines.push('- ' + (ev.id ? '[事件编号 '+ev.id+'] ' : '') + (head ? head + '：' : '') + desc);
    }

    ceBridgeReadWorldEvents.lastSelection={selectedCount:tail.length,canonCount:0,totalCount:valid.length,requiredCount:required.length,backgroundCount:picked.rows.filter(function(ev){return !required.includes(ev);}).length,unit:'条',reason:'只读取已落地世界事件；人物年表进度不作为世界大事供料，直接相关事实完整保留'};
    return [active && '【当前世界局势】\n'+active,lines.length&&'【历史大事记录】\n'+lines.join('\n')].filter(Boolean).join('\n\n');
  } catch (e) {
    return '';
  }
}

/** 任务栏 currentState['6'] */
function ceBridgeReadTasks(request) {
  try {
    ceBridgeReadTasks.lastSelection={};
    if (typeof currentState === 'undefined' || !currentState) return '';
    var table = currentState['6'];
    if (!table || typeof table !== 'object') return '';

    var lines = [];
    for (var id in table) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
      var row = table[id] || {};
      var title = String(row['1'] || '').trim();
      if (!title) continue;
      var desc = String(row['2'] || '').trim();
      var difficulty = String(row['5'] || '').trim();
      var bits = [id, title];
      if (difficulty) bits.push('难度' + difficulty);
      if (desc) bits.push(desc);
      lines.push('- ' + bits.join('｜')+'\n完整任务记录：'+JSON.stringify(row));
    }
    ceBridgeReadTasks.lastSelection={selectedCount:lines.length,totalCount:lines.length,unit:'条',reason:'当前玩家任务完整读取，不按数量截断'};
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

/** 地理与小地图：直接用宿主现成的两个构造函数 */
/**
 * 地理与小地图。
 *
 * 这一项里其实是**两样东西**，用途完全不同：
 *   ① 【世界地图要点】buildWorldMapPoiSummary() —— 地理信息（有哪些地方、在哪）
 *   ② 【当前场景小地图】buildCurrentSceneMapSummary() —— 正文描述的那个区域此刻的情况
 *
 * 玩家 2026-11-01：
 *   「原著指导阶段收集地理和小地图没有问题，因为需要参考这个来指导本轮正文
 *     关于地理方面的内容，但是原著补演阶段只需要地理信息，小地图没有任何意义，
 *     因为小地图展示的是正文描述的当前的区域情况，
 *     而能进入补演流程的npc，就一定是不在场的。」
 *
 * 这个判断是对的：补演写的是**不在场**的 NPC 的幕外经历，
 * 当前场景小地图描述的是玩家所在的那个区域，对不在场的人毫无意义，
 * 反而会把他往「玩家这边正在发生什么」上带。
 * 所以 turn 阶段只要地理，不要小地图。
 *
 * @param {{scope?:object, skipSceneMap?:boolean}} [request]
 *        skipSceneMap=true 时只给世界地图要点，不拼当前场景小地图。
 */
function ceBridgeReadMap(request) {
  var skipSceneMap = Boolean(request && request.skipSceneMap);
  var lines = [];
  try {
    if (typeof buildWorldMapPoiSummary === 'function') {
      var poi = String(buildWorldMapPoiSummary() || '').trim();
      if (poi) { lines.push('【世界地图要点】'); lines.push(poi); }
    }
  } catch (e) {}
  if (!skipSceneMap) {
    try {
      if (typeof buildCurrentSceneMapSummary === 'function') {
        var scene = String(buildCurrentSceneMapSummary() || '').trim();
        if (scene) { lines.push('【当前场景小地图】'); lines.push(scene); }
      }
    } catch (e) {}
  }
  return lines.join('\n');
}

/**
 * 世界规则。
 *
 * 目标前端的 getWorldFactorsContext() 是异步的，从存档第 0 层的
 * 「世界规则变动」details 里解析 ul>li。这是整局的铁律，
 * 不随轮次变，但**原著指导不能违反它**。
 */
async function ceBridgeReadWorldFactors() {
  try {
    if (typeof getWorldFactorsContext === 'function') {
      var ctx = await getWorldFactorsContext();
      var text = String(ctx == null ? '' : ctx).trim();
      if (text && text !== '无世界因子') return text;
    }
  } catch (e) {
    console.warn('[原著补演] 读世界规则失败:', e);
  }
  return '';
}


/**
 * 调模型。优先用原著补演专用接口，没有就沿用变量演化主接口。
 *
 * 复用宿主已有的取接口逻辑，不自己读配置。
 */
async function ceBridgeCallModel(payload) {
  var messages = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
  var wantJson = Boolean(payload && payload.json);

  var apiConfigs = await ceBridgeGetApiConfigs();
  if(typeof frAiPrioritizeRoutes==='function')apiConfigs=frAiPrioritizeRoutes(apiConfigs);
  if (apiConfigs.length === 0) throw new Error('没有可用接口配置');

  var routeRunner=typeof CE_CORE!=='undefined'?CE_CORE?.['api-library']?.runApiChain:null;
  return routeRunner?routeRunner(apiConfigs,(api,index)=>ceBridgeCallModelOnRoute(payload,messages,wantJson,api,index<apiConfigs.length-1),payload?.signal):
    ceBridgeCallModelOnRoute(payload,messages,wantJson,apiConfigs[0]);
}

async function ceBridgeCallModelOnRoute(payload,messages,wantJson,api,hasNextRoute) {
  var caller = (typeof genericApiCall === 'function' && genericApiCall.__ceOriginal)
    ? genericApiCall.__ceOriginal : genericApiCall;
  if (typeof caller !== 'function') throw new Error('genericApiCall 不可用');

  var controller = new AbortController();
  var outerSignal = payload && payload.signal;
  if(typeof frCanonTraceLinkSignal==='function')frCanonTraceLinkSignal(outerSignal,controller.signal);
  var forwardAbort = function() { controller.abort(outerSignal.reason); };
  if (outerSignal && outerSignal.aborted) controller.abort(outerSignal.reason);
  if (outerSignal) outerSignal.addEventListener('abort',forwardAbort,{once:true});
  var requestSettings=await ceBridgeLoadConfig();
  var timeoutMs=Math.max(15000,Math.min(1800000,Number(requestSettings.requestTimeoutMs)||120000));
  var onTimeout = function(){var error=new Error('原著补演模型接口请求超时（'+Math.round(timeoutMs/1000)+'秒），请检查接口或调整请求超时');error.name='TimeoutError';controller.abort(error);};
  var timeoutId = typeof frAiQueueTimeout==='function'?frAiQueueTimeout(controller,timeoutMs,onTimeout):setTimeout(onTimeout,timeoutMs);
  var rejectAbort;
  var interrupted=new Promise(function(_resolve,reject){rejectAbort=function(){reject(controller.signal.reason);};controller.signal.addEventListener('abort',rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort();});
  var boundaryStage=['正文硬事实提取','补演边界格式整理','预制变异边界'].includes(payload?.stage)?payload.stage:'';
  var sentAt=Date.now(), lastRequestState='';
  var noteBoundary=function(state,extra={}){
    if(boundaryStage)console.info('[补演边界耗时]',JSON.stringify({stage:boundaryStage,state,elapsedMs:Date.now()-sentAt,...extra}));
  };
  if(boundaryStage)noteBoundary('开始',{chars:messages.reduce((sum,message)=>sum+String(message.content||'').length,0),timeoutMs});
  try {
    var raw = await Promise.race([Promise.resolve().then(function(){controller.signal.throwIfAborted();return caller(api.apiUrl, api.apiKey, api.apiModel, messages, controller.signal,{route:api,hasNextRoute,purpose:wantJson?'json':undefined,max_tokens:Math.max(256,Math.min(262144,Number(requestSettings.maxOutputTokens)||65536)),
      ...(boundaryStage?{onRequestProgress:function(row){if(row?.state&&row.state!==lastRequestState){lastRequestState=row.state;noteBoundary(row.state);}}}:{})});}),interrupted]);
    var text = String(raw == null ? '' : raw);
    // 去掉思维标签，避免污染 JSON 解析
    text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    if (wantJson && !text) throw new Error('模型返回空内容');
    noteBoundary('回包',{chars:text.length});
    return text;
  } catch (error) {
    noteBoundary('失败',{errorType:controller.signal.reason?.name||error?.name||'Error'});
    // 队列可能返回自己的通用取消文案；本请求已有明确原因时保留它。
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    controller.signal.removeEventListener('abort',rejectAbort);
    if (timeoutId && typeof timeoutId.cancel==='function')timeoutId.cancel();else if(timeoutId)clearTimeout(timeoutId);
    if (outerSignal) outerSignal.removeEventListener('abort',forwardAbort);
  }
}

async function ceBridgeGetApiConfigs() {
  var routes = typeof frApiRoutes === 'function' && frApiRoutes('CULTIVATION_CANON_BRIDGE_CONFIG_V1','apiPresetId');
  if(routes?.length)return routes;
  var own = await ceBridgeLoadConfig();
  var api = own.api || {};
  if (api.apiUrl || api.apiKey || api.apiModel) {
    if (!api.apiUrl || !api.apiKey || !api.apiModel) throw new Error('原著补演专用接口配置不完整，请补齐或全部留空');
    return [api];
  }
  return getApiConfigsToTry(await loadConcurrentEvolutionConfig());
}

// ---------- 从宿主读年表与人 ----------

/** 从存档读当前世界时间 */
function ceBridgeReadWorldTime() {
  try {
    if (typeof currentState === 'undefined' || !currentState) return '';
    var row = currentState['4'];
    if (row && row[0] && typeof row[0] === 'object' && row[0]['0'] !== undefined) {
      return String(row[0]['0'] || '').trim();
    }
    if (row && row['0'] !== undefined && typeof row['0'] !== 'object') {
      return String(row['0'] || '').trim();
    }
  } catch (e) {}
  return '';
}

/** 把宿主的年表事件转成核心包要的形态 */
function ceBridgeReadTimeline(sharedContext) {
  var out = [];
  try {
    if (typeof ceExtractOriginalTimelineEventList !== 'function') return out;
    var list = ceExtractOriginalTimelineEventList(sharedContext || {}) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var start = e.timeStart || e.time_start || '';
      var end = e.timeEnd || e.time_end || start;
      var title = String(e.title || e.text || '');
      if (!title) continue;
      out.push({
        title: title,
        time_start: start,
        time_end: end,
        content_brief: e.contentBrief || e.content_brief || e.text || '',
        content_original: e.contentOriginal || e.content_original || ''
      });
    }
  } catch (e) {
    console.warn('[原著补演] 读年表失败:', e);
  }
  return out;
}

/**
 * 把宿主的人物表转成核心包要的形态。
 *
 * 列定义按目标前端 TABLE_DEFINITIONS（实测）：
 *   1 名称/性别  2 境界/身份  3 性格  4 Buffs/状态  5 灵根  6 特殊体质
 *   7 对玩家的称呼  9 备注  10 背景/简介  12 内心想法/动机
 *   13 人际关系  27 当前动机  28 短期目标  29 长期目标  35 生平经历
 *
 * 之前读的是 5=境界、6=所在地、7=状态，全错位：
 *   5 其实是灵根 → 境界被写成「木灵根」
 *   7 其实是对玩家的称呼 → 状态被写成「师尊」
 * 错位的后果不是报错，是**散文里的人物状态全不对**，
 * 而且材料审计还会显示「资料完整」，更难发现。
 */
function ceBridgeReadCharacters(names, archivedRows, canonIds) {
  var map = {};
  /* 2026-11-03：本轮没能解析出唯一行的人名。原来遇到这种名字会 throw
   * 直接掐死整轮补演（玩家看到「重跑永远无用」）；现在只跳过这些人，
   * 记在这里供上层诊断展示「谁没对上」，不让它们默默消失。 */
  var unresolvedNames = [];
  try {
    if (typeof currentState === 'undefined' || !currentState) return map;
    var rows = Object.assign({},archivedRows || {},currentState['0'] || {});
    // B1是边界识别所需的真实主体；即使不在年表里也提供身份，绝不据此圈成NPC。
    var playerLabel=String(rows.B1 && rows.B1['1'] || '').split('|')[0].replace(/<[^>]*>/g,'').trim();
    names=Array.from(new Set([...(names || []),...(playerLabel?[playerLabel]:[])]));

    // 先建「名字 → 行」索引，避免每个人名都把全表扫一遍
    var byName = {}, byCanonId = new Map();
    for (var id in rows) {
      if (!Object.prototype.hasOwnProperty.call(rows, id)) continue;
      if (id === 'TIME_LOCATION_ROW') continue;
      var row = rows[id] || {};
      var label = String(row['1'] || '').split('|')[0].replace(/<[^>]*>/g, '').trim();
      if (!label) continue;
      var boundId = canonIds?.size && id !== 'B1' && typeof parseRemarksString === 'function'
        ? parseRemarksString(row['9'] || '')?.canonActorId : '';
      var hit = {id:id,row:row,canonActorId:boundId};
      if(boundId){
        if(!byCanonId.has(boundId))byCanonId.set(boundId,[]);
        byCanonId.get(boundId).push(hit);
      }
      var labels = [label];
      if (typeof ceExtractOriginalTimelineAliasList === 'function') labels = labels.concat(Array.from(ceExtractOriginalTimelineAliasList(row,{name:label}) || []));
      Array.from(new Set(labels)).forEach(function(alias) {
        if (!byName[alias]) byName[alias] = [];
        byName[alias].push(hit);
      });
    }

    for (var i = 0; i < names.length; i++) {
      var name = String(names[i] || '').trim();
      if (!name) continue;

      // 复用原卡明确别名；名字包含关系不能作为同一人的证据。
      var canonId = canonIds?.get(name);
      var boundHits = canonId && byCanonId.get(canonId);
      var hits = boundHits || (byName[name] || []).filter(hit=>!canonId || !hit.canonActorId || hit.canonActorId===canonId);
      /* ★★★ 2026-11-03 玩家两次点破，才定位到真因：
       *   「原著补演的智能重跑和局部重跑依然无用」
       *   「但是我这个三个年表事件起码测试补演了上百次，如果有问题，为什么今天才出现？」
       *   「为什么该清理的数据一直没清理，也是个问题」
       *
       * 【真机事实（CDP 读玩家真实 IndexedDB，不是推测）】
       *   · 存档列表只有 1 个：「测试」
       *   · settings 里却有另一存档「我的修仙路」的 8 个 key，其中
       *       FR_CANON_TRACE_V1:我的修仙路  =  328.25 MB     ← 单条孤儿数据
       *     这个存档早已删除，它的数据永远没人清（清理只认当前存档名）。
       *   · FR_CANON_TURN_ARTIFACTS_V1:测试:<非当前楼层> 还留着 10.59 MB
       *
       * 【为什么「今天才出现」】不是今天才有 bug，是今天才**攒到爆点**。
       * 上百次补演每跑一次都往里写一份，从没清过；直到某次同一个角色
       * 在 rows 里出现两个不同 id（档案条目 id 与人物表 id 两套 id 空间
       * 由 ceBridgeReadStoredRows 合并而来），byName 里 hits.length>1 成立，
       * 这句 throw 让**整轮补演当场中止** —— 表现就是重跑永远失败。
       *
       * 【原来那句 throw 的根本错误】它是**致命**的：
       * 一个名字对不上，整轮补演全废，玩家看到的是「重跑没用」。
       * 而名字解析本质只是一次查表，查表失败不该演变成整轮失败。
       *
       * 【修法】三层收敛 + 失败降级，绝不擅自猜人、也绝不掐死整轮：
       *   ① 同一个 id 的多条命中 → 同一角色的不同写法，取第一条。
       *   ② 仍有多个 id 时，若恰好一个的主名（col1 label）等于 name，就是它
       *      —— 精确主名优先于「别人的别名恰好同名」，这是查表不是猜。
       *   ③ 仍不唯一 → **不再 throw**：记一条可读诊断，本轮跳过这个人，
       *      其余角色照常补演。少一个人好过整轮报废。
       * 真正两个不同人都精确同名的情况没有被「猜」掉，只是从「致命」降成「跳过」。 */
      if(hits.length>1){
        var uniqHits=[], seenHit={};
        hits.forEach(function(h){if(!seenHit[h.id]){seenHit[h.id]=true;uniqHits.push(h);}});
        hits=uniqHits;
        if(hits.length>1&&!boundHits){
          var exact=hits.filter(function(h){
            var lab=String(h.row && h.row['1'] || '').split('|')[0].replace(/<[^>]*>/g,'').trim();
            return lab===name;
          });
          if(exact.length===1)hits=exact;
        }
        /* 诊断：把真实命中详情写进日志，便于以后核对到底是哪几行撞名。 */
        try{
          console.warn('[原著补演] 同名命中诊断: name='+name
            +' | rows总数='+Object.keys(rows).length
            +' | 命中='+JSON.stringify(hits.map(function(h){
                var lab=String(h.row && h.row['1'] || '').split('|')[0].replace(/<[^>]*>/g,'').trim();
                var als=Array.from(ceExtractOriginalTimelineAliasList(h.row,{name:lab}) || []);
                return {id:h.id,label:lab,aliases:als.slice(0,8),byMain:lab===name};
              })));
        }catch(_){}
      }
      /* ★★★ 2026-11-03 玩家：「原著补演的智能重跑和局部重跑依然无用」。
       *
       * 这里原来是： if(hits.length>1) throw new Error('人物姓名或别名不唯一：'+name);
       *
       * 那一句是**致命**的：只要有一个名字在人物表里撞车，整轮补演直接中止，
       * 玩家看到的现象就是「不管点智能重跑还是局部重跑都没用」——
       * 真机 render.log 里连着一轮两次都是：
       *   [原著补演] 读人物表失败: Error: 人物姓名或别名不唯一：张铁
       *   [原著补演] 一轮补演失败: Error: 人物姓名或别名不唯一：张铁
       *
       * 但名字解析只是一次查表，查表失败不该演变成整轮失败。
       * 现在改成**降级**：
       *   · 命中 0 条 → 本来就不参与，继续；
       *   · 命中 1 条 → 正常处理；
       *   · 命中多条且收敛不了 → 把名字记进 unresolved，**跳过这一个**，
       *     其余角色照常补演，整轮继续。
       * 少解析一个人好过整轮报废；而且这些没解析的人会出现在结果诊断里，
       * 玩家能看到「谁没对上」，不是默默消失。 */
      if (hits.length > 1){
        try{ unresolvedNames.push(name); }catch(_){}
        continue;
      }
      var hit = hits[0] || null;
      if (!hit) continue;

      var found = hit.row;
      var realmIdentity = String(found['2'] || '').split('|');
      var realm = String(realmIdentity[0] || '').trim();
      var identity = String(realmIdentity[1] || '').trim();

      // 位置在第 16 列的第 3 段：动作|穿着|位置|身段|样貌
      // 之前这里是空字符串，等于「补演看不到这个人在哪」——
      // 终态四维少了位置，推演就只能瞎猜。
      var posBits = String(found['16'] || '').split('|');
      var posNow = String(posBits[2] || '').replace(/<[^>]*>/g, '').trim();
      var possessions=ceBridgeActorPossessions(found,hit.id,currentState);

      // 人物表里哪些列对「推演这个人会怎么做」有用，逐列说清：
      //
      //   3  性格      他会怎么反应
      //   4  当前状态   伤病/中毒/Buff，直接影响他做不做得成事
      //   12 内心想法   这会儿心里在想什么
      //   27 当前动机   此刻的即时目标
      //   28 短期目标   这一阵要办的事
      //   29 长期目标   这辈子在图什么
      //   31 战斗状态   打起来了没、余力多少
      //   32 盟友状态   身边有谁可用
      //   15 好感度     对玩家什么态度（写 NPC 视角时最要紧的一条）
      //
      // 用户 2026-10-21：
      //   「不止是性格，你还需要看看npc列里哪些信息是需要的，
      //     对边界判定或者npc视角正文有参考价值或者有影响的，
      //     我记得的就还有当前动机和长期目标两列内容」
      map[name] = {
        id: hit.id,
        aliases: typeof ceExtractOriginalTimelineAliasList === 'function' ? Array.from(ceExtractOriginalTimelineAliasList(found,{name:String(found['1'] || '').split('|')[0]}) || []) : [],
        state: {
          cultivation: realm,
          inventory: possessions.inventory,
          equipment: possessions.equipment,
          inventoryKnown: possessions.inventoryKnown,
          equipmentKnown: possessions.equipmentKnown,
          items: possessions.inventoryKnown?possessions.items:null,
          identity: identity,
          // 状态在 4 列（Buffs/状态），不是 7 列；7 列是对玩家的称呼
          status: String(found['4'] || '').trim(),
          location: posNow,
          spiritRoot: String(found['5'] || '').trim(),
          constitution: String(found['6'] || '').trim(),
          call: String(found['7'] || '').trim(),
          relation: String(found['13'] || '').trim(),
          // 好感度：他对玩家是什么态度。写 NPC 视角时最要紧的一列，
          // 缺了它就只能写「我看着他」，写不出「我忍着不发作」。
          favor: String(found['15'] || '').trim(),
          // 当前动机 / 内心想法：这会儿他心里想的是什么
          motive: String(found['27'] || '').trim(),
          innerThought: String(found['12'] || '').trim(),
          // 性格：会被经历改，所以读的是**现在**这一列
          personality: String(found['3'] || '').trim(),
          // 战斗与盟友：打起来了没、身边有谁可用，都影响他做不做得成事
          combat: String(found['31'] || '').trim(),
          allies: String(found['32'] || '').trim(),
          // 详细属性：换算战力时要用
          attributes: String(found['11'] || '').trim()
        },
        // 设定集里拿不到的部分由存档补齐：背景、生平
        profile: {
          name: String(found['1'] || '').split('|')[0].trim(),
          text: String(found['10'] || '').trim(),
          deeds: String(found['35'] || '').trim()
        },
        // 自主目标栈：写作起点倒置的前提，缺它就会写成「主角做了什么，于是我……」
        //
        // 注意：27 / 28 / 29 是三列不同的东西，不能混：
        //   29 长期目标 → 这辈子在图什么
        //   28 短期目标 → 这一阵要办什么
        //   27 当前动机 → 此刻心里想什么（**不是「进度」**）
        // 之前这里把 27 当成 progress（进度），是错的——
        // 进度没有对应的列，是算出来的，本来就不该从表里读。
        goal: {
          ambition: String(found['29'] || '').trim(),
          next: String(found['28'] || '').trim(),
          motive: String(found['27'] || '').trim(),
          ties: String(found['32'] || '').trim()
        },
        isPlayer: hit.id === 'B1'
      };
    }
  } catch (e) {
    console.warn('[原著补演] 读人物表失败:', e);
    throw e;
  }
  /* 把「本轮没能唯一解析、已跳过」的人名带出去，供上层诊断展示。
   * 不挂在 map 的键上，避免污染「人名 → 人物」的语义；
   * 用不可枚举属性，遍历 map 时不会被当成角色。 */
  try{
    Object.defineProperty(map,'__unresolvedNames',{value:unresolvedNames,enumerable:false,configurable:true});
  }catch(_){}
  return map;
}

async function ceBridgeReadGuidanceNpcState(timeline){
  var ledger=typeof currentState==='object' && currentState && currentState.canonLedger || {},last=ledger.lastTurn || {};
  var previousNames=new Set([...(last.updatedNames || last.wroteNames || []),...(last.biographyNames || [])]);
  var previousIds=new Set(last.updatedIds || []),eventNames=ceBridgeKnownPeople([...(timeline || []),...(ledger.eventProgress || []).filter(row=>!row.resolved).map(row=>({title:row.title}))]).canonNames;
  var rows=await ceBridgeReadStoredRows(),records=[];
  Object.keys(rows).forEach(function(id){if(id==='B1'||id==='TIME_LOCATION_ROW')return;var row=rows[id],name=String(row && row['1'] || '').replace(/<[^>]*>/g,'').split('|')[0].trim();if(!name)return;
    var aliases=typeof ceExtractOriginalTimelineAliasList==='function'?Array.from(ceExtractOriginalTimelineAliasList(row,{name:name}) || []):[];
    var names=[name,...aliases],previous=previousIds.has(id)||names.some(function(n){return previousNames.has(n);});
    if(!previous && !names.some(function(n){return eventNames.has(n);}))return;
    records.push({id:id,name:name,source:previous?'上一轮实际落实的人物':'当前年表涉及的已存档人物',state:typeof ceBuildPromptCharacterSnapshotData==='function'?ceBuildPromptCharacterSnapshotData({id:id,name:name,type:'npc',data:row}):JSON.parse(JSON.stringify(row))});
  });
  return {asOf:String(ledger.worldTime || ceBridgeReadWorldTime()),records:records,eventProgress:JSON.parse(JSON.stringify(ledger.eventProgress || [])),eventWatches:JSON.parse(JSON.stringify(ledger.eventWatches || [])),columns:'沿原卡列：1名称/性别，2境界/身份，3性格，4状态，5灵根，6体质，9备注（物品装备与资源），10背景，11属性，12内心，13关系，16行为|衣着|位置|身形|外貌，26灵石，27当前动机，28短期目标，29长期目标，31战斗，32盟友，35生平经历；其余沿原卡定义。'};
}

async function ceBridgeReadStoredRows() {
  var index = await ceBuildOriginalTimelineNpcArchiveIndex({sharedContext:{},strict:true});
  var rows = {};
  (index.records || []).forEach(function(record) {
    if (record && record.id && record.data) rows[record.id] = JSON.parse(JSON.stringify(record.data));
  });
  var merged=Object.assign(rows,JSON.parse(JSON.stringify(currentState['0'] || {}))),deleted=typeof ceGetDeletedWorldBookIdSet==='function'?ceGetDeletedWorldBookIdSet():null;
  if(deleted)Object.keys(merged).forEach(function(id){var normalized=typeof ceNormalizeWorldBookId==='function'?ceNormalizeWorldBookId(id):String(id);if(deleted.has(normalized))delete merged[id];});
  return merged;
}

// ---------- 对外入口 ----------

/**
 * 【正文前】跑原著指导。
 *
 * **围绕玩家**：只指导「这一轮会碰到的原著人、事、物怎么写进剧情」，
 * 不是把整段年表端给模型（用户 2026-10-21 纠正过两次）。
 *
 * 在正文生成之前调用；返回的文字由调用方注入正文提示词。
 * 失败不抛错，正文照常。
 */
function frResolveCanonGuidanceTime(playerInput,worldTime) {
  var current=wtExtractTimeCandidatesFromText(String(worldTime||'').split('/')[0])[0]||null;
  var fallback={time:current?wtFormatTimelinePoint(current):'',point:current,precision:current?.precision||'',source:'world',reason:'本轮未指定时间，沿用当前世界时间'};
  var clauses=String(playerInput||'').split(/[。；;\n，,]/).map(function(t){return t.trim();}).filter(Boolean);
  for(var clause of clauses){
    if(/回忆|想起|忆起|记得|曾经|当年|信中|书中|出生|打算|计划|明年.*闭关/.test(clause))continue;
    var explicit=clause.match(/(?:^|(?:当前|现在|世界|游戏|剧情|开局|起始)(?:时间|年份|年月)?(?:是|为)?[:：]?|时间(?:调整为|改为|设为|校对到|校准到)|到了|来到|(?:剧情|故事|本轮|本段|本章)从|从|我在|我于)(\s*\d{1,6}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?(?:\s*\d{1,2}:\d{1,2})?|\s*\d{1,6}\.\d{1,2}(?:\.\d{1,2})?(?:\s+\d{1,2}:\d{1,2})?)/);
    var monthDay=clause.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    var raw=explicit&& explicit[1]||monthDay && current &&(current.year+'年'+monthDay[1]+'月'+monthDay[2]+'日');
    if(raw){var point=wtParseTimelinePointStrict(raw.trim());return point?{time:wtFormatTimelinePoint(point),point:point,precision:point.precision,source:'player',reason:'玩家输入明确指定本轮日期'}:{time:'',source:'invalid',reason:'玩家指定的日期无效，请检查年月日。'};}
    var relative=wtDetectExplicitTimeOverride(clause,current);
    if(relative?.type==='relative'&& relative.point){return {time:wtFormatTimelinePoint(relative.point),point:relative.point,precision:relative.point.precision,source:'player',reason:'按玩家指定的相对时间推进'};}
    if(/闭关|潜修|苦修|等待|赶路|疗伤|时间快进|跳过/.test(clause)){
      // 与正文年表同一条口径：模糊时长（「三个多月」「一百天」）落点是估算的，
      // 精度降为月，不假装精确到日。否则指导时间会比正文年表更精确，两处对不上。
      var advance=typeof wtDetectPlannedTimeAdvance==='function'
        ? wtDetectPlannedTimeAdvance(clause)
        : {months:wtDetectPlannedTimeAdvanceMonths(clause),approximate:false};
      var months=advance.months;
      if(months>0&& current){
        var shifted=wtShiftTimelinePointByMonths(current,months);
        if(advance.approximate)shifted=Object.assign({},shifted,{hasDay:false,hasHour:false,hasMinute:false,precision:'month'});
        return {time:wtFormatTimelinePoint(shifted),point:shifted,precision:shifted.precision,source:'player',reason:'按本轮行动持续时间推进'};
      }
    }
  }
  // 分句回退：玩家常把行为和时长用逗号隔开（「闭关，三个多月」「我闭关了，三个多月后出关」），
  // 逐句找会两半都凑不齐（一句有关键词没时长，一句有时长没关键词）而漏判。
  // 故分句都没结论时，再拿整句试一次。
  var wholeAdvance=typeof wtDetectPlannedTimeAdvance==='function'
    ? wtDetectPlannedTimeAdvance(String(playerInput||''))
    : {months:0,approximate:false};
  if(wholeAdvance.months>0&& current){
    var wholeShifted=wtShiftTimelinePointByMonths(current,wholeAdvance.months);
    if(wholeAdvance.approximate)wholeShifted=Object.assign({},wholeShifted,{hasDay:false,hasHour:false,hasMinute:false,precision:'month'});
    return {time:wtFormatTimelinePoint(wholeShifted),point:wholeShifted,precision:wholeShifted.precision,source:'player',reason:'按本轮行动持续时间推进'};
  }
  return fallback;
}
async function ceBridgeRunGuidance(options) {
  var opts = options || {};
  var config = opts.config || await ceBridgeLoadConfig();
  if (config.enabled === false) return { ok: false, text: '', injectable: false, reason: '未启用' };
  /* ★★ 2026-11-01 玩家：「原著指导是我必须要的流程」「要的是解决问题」
   *
   * 原来这里是：
   *     if(opts.storyTimeline && !String(opts.storyTimeline.block||'').trim())
   *       return {ok:true,text:'',injectable:false,reason:'本轮未注入年表资料，不生成脱离资料的指导'};
   *
   * 后果：年表块为空 → 直接 return，而且在 frCanonTraceBegin 之前，
   * 连观测记录都不建 → 面板完全空白 → 玩家看到「压根没有跑原著指导」。
   *
   * 现在：年表为空**照常跑**。指导自己会取资料（frTimelineLoadForCanon 等），
   * 年表只是其中一条参考线。真正跑不出东西时由后续逻辑给出具体原因。
   */
  var storyTimelineMissing = !!(opts.storyTimeline && !String(opts.storyTimeline.block || '').trim());

  var core;
  try { core = ceBridgeCore(); } catch (e) {
    console.error('[原著补演]', e.message);
    return { ok: false, text: '', injectable: false, reason: e.message };
  }

  var traceRun=null;
  if(typeof frCanonTraceBegin==='function'){await frCanonTraceLoad();traceRun=frCanonTraceBegin('原著指导',{signal:opts.signal});}
  if(!traceRun && config.showStatus!==false)ceBridgeStatus('原著指导 · 准备资料');
  if(storyTimelineMissing && traceRun && typeof frCanonTraceEvent==='function'){
    frCanonTraceEvent(traceRun,'stage','本轮无年表注入，改用资料库直接取时',{reason:'年表注入为空，指导照常运行'});
  }
  try {
    var guidanceTime=frResolveCanonGuidanceTime(opts.playerInput||'',opts.worldTime||ceBridgeReadWorldTime());
    if(guidanceTime.source==='invalid'||!guidanceTime.time)throw new Error(guidanceTime.reason||'没有可用的指导时间');
    var storyTimeline=opts.storyTimeline && String(opts.storyTimeline.block || '').trim()?opts.storyTimeline:null;
    var timeline = storyTimeline && Array.isArray(storyTimeline.entries)?storyTimeline.entries:opts.timeline || await frTimelineLoadForCanon('正文前原著指导',traceRun);
    timeline=frTimelineForPrebuiltSetting(timeline,config);
    var storyPoint=storyTimeline && wtParseTimelinePointStrict(storyTimeline.time || '');
    if(storyPoint && guidanceTime.source!=='player')guidanceTime={time:storyTimeline.time,point:storyPoint,precision:storyPoint.precision,source:'story_timeline',reason:'沿用本轮正文年表注入锚点'};
    if(traceRun){traceRun.guidanceTime={time:guidanceTime.time,source:guidanceTime.source,precision:guidanceTime.precision,reason:guidanceTime.reason};frCanonTraceEvent(traceRun,'stage','判断本轮时间',traceRun.guidanceTime);}
    if(storyTimeline && traceRun)frCanonTraceEvent(traceRun,'material','正文年表与原著指导共用',{entries:timeline.length,chars:storyTimeline.block.length,currentEventCode:storyTimeline.currentEventCode || '',source:'本轮正文实际注入资料'});
    var host = opts.host || ceBridgeHost(traceRun?traceRun._controller.signal:opts.signal,traceRun);

    // 在场人物与已建档人物：
    // 这是「围绕玩家」的数据基础——只有这一轮碰得到的人才进指导。
    var onScene = ceBridgeReadOnScene();
    var priorNpcState=typeof ceBridgeReadGuidanceNpcState==='function'?await ceBridgeReadGuidanceNpcState(timeline):{records:[]};
    var archived = Array.from(new Set([...(opts.archived || []),...(priorNpcState.records || []).map(function(row){return row.name;})]));
    if(traceRun)frCanonTraceEvent(traceRun,'material','上一轮落实状态与当前事件人物',priorNpcState);

    var result = await core.orchestrator.runCanonGuidance({
      host: host,
      worldTime: guidanceTime.time,
      targetTime: guidanceTime.time,
      timeline: timeline,
      storyTimeline:storyTimeline,priorNpcState:priorNpcState,
      playerInput: opts.playerInput || '',
      location: opts.location || ceBridgeReadLocation(),
      onScene: onScene,
      archived: archived,
      knownPeople: ceBridgeKnownPeople(timeline),
      canonicalNames:ceBridgeCanonSearchScope(timeline,[]).allowlist,logId:traceRun&&traceRun.logId||'',
      options: Object.assign({},config,
        /* ★★ 2026-11-01 玩家第二次报：「还是在检索怎么回事？」
         *
         * 上一次只修了 ceBridgeMaterialsFor 的判断逻辑，但**这条路径根本没调它**。
         * 原来这里是 Object.assign({},config,...)，直接把整个 config 当 options 传，
         * options.materials 是 undefined，
         * 于是 guidance.js 里 `options.materials?.ragVector===false` 永远不成立 → 照常检索。
         *
         * 补演那条路（canon-early.js）调了 ceBridgeMaterialsFor('replay',...)，所以那边有效；
         * 原著指导这条唯一入口漏了，玩家看到的就是「关了分阶段开关还在检索」。
         * 这里补上同样的阶段过滤，两边的口径才一致。
         */
        {materials:ceBridgeMaterialsFor('guidance',config)},
        traceRun?{onStage:function(name,detail,view){frCanonTraceEvent(traceRun,'stage',name,detail);if(view)frCanonTracePublish(traceRun,view.kind==='prose'?'人物正文 · '+view.block.name:name,view);},onRetry:function(info){frCanonTraceEvent(traceRun,'retry','重试 · '+info.stage,info);}}:{})
    });

    result.guidanceTime={time:guidanceTime.time,source:guidanceTime.source,precision:guidanceTime.precision,reason:guidanceTime.reason};
    if (config.showDiagnostics !== false) {
      var rec = core.visibility.createDiagRecorder();

      // 资料采集情况放最前面：玩家最先要知道的是「系统到底看见了多少东西」
      var matCore = core['host-material'];
      if (matCore && Array.isArray(result.materialReport) && result.materialReport.length > 0) {
        var matLines = matCore.materialReportLines(result.materialReport);
        for (var m = 0; m < matLines.length; m++) {
          var ml = matLines[m] || {};
          if (ml.level === 'warn') rec.warn(ml.text, ml.detail);
          else rec.step(ml.text, ml.detail);
        }
        rec.step('资料合计', matCore.summarizeMaterialStatus(result.materialReport));
      }

      for (var i = 0; i < (result.trace || []).length; i++) {
        var s = result.trace[i] || {};
        var detail = String(s.detail || '');
        if (/失败|未生效/.test(detail)) rec.warn('原著指导·' + String(s.step || ''), detail);
        else rec.step('原著指导·' + String(s.step || ''), detail);
      }
      if (result.injectable) rec.done('原著指导已生效');
      else rec.done('原著指导未注入：' + (result.reason || '无内容'));
      ceBridgePushDiagnostics(core.visibility.renderDiagHtml(rec.items()));
    }

    if(traceRun && typeof frCanonMaterialAttach==='function')await frCanonMaterialAttach(traceRun,result);
    if(traceRun)await frCanonTraceFinish(traceRun,traceRun._controller.signal.aborted?'cancelled':result.ok===false?'error':'done',result);
    return result;
  } catch (e) {
    console.error('[原著补演] 原著指导失败:', e);
    if(traceRun)await frCanonTraceFinish(traceRun,e.name==='AbortError'?'cancelled':'error',{reason:e.message});
    return { ok: false, text: '', injectable: false, reason: String(e && e.message || e) };
  } finally {
    if (config.showStatus !== false && !opts.deferCloseStatus) ceBridgeCloseStatus(traceRun);
  }
}

/** 玩家当前所在地 */
function ceBridgeReadLocation() {
  try {
    if (typeof currentPlayerData !== 'undefined' && currentPlayerData) {
      var loc = String(currentPlayerData.location || '').trim();
      if (loc) return loc;
    }
  } catch (e) {}
  try {
    if (typeof currentState !== 'undefined' && currentState && currentState['4']) {
      var row = currentState['4'];
      var t = row && row[0] ? row[0] : row;
      var loc2 = String((t && (t['1'] || t.location)) || '').trim();
      if (loc2) return loc2;
    }
  } catch (e) {}
  return '';
}

/**
 * 读在场人物。
 *
 * 这是「围绕玩家」最重要的一条：玩家身边有谁，才需要指导谁。
 *
 * 两个来源，优先用宿主运行时维护的那个：
 *   ① surroundingCharacters —— 登场判定跑完就更新，是本轮真实在场名单
 *   ② 存档人物表里未标离场/死亡的 —— 兜底
 *
 * 只读存档会把「刚入场的人」漏掉、把「刚离场的人」算进来，
 * 所以运行时数组优先。
 */
function ceBridgeReadOnScene() {
  var out = [];
  var seen = {};

  var push = function (id, name, cultivation, location, status) {
    var label = String(name || '').replace(/<[^>]*>/g, '').trim();
    if (!label) return;
    var key = String(id || label);
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      name: label,
      aliases: [],
      state: {
        cultivation: String(cultivation || '').trim(),
        location: String(location || '').trim(),
        status: String(status || '').trim()
      }
    });
  };

  // ① 运行时在场名单
  try {
    var runtimeList = [];
    if (typeof surroundingCharacters !== 'undefined' && Array.isArray(surroundingCharacters)) {
      runtimeList = surroundingCharacters;
    } else if (typeof window !== 'undefined' && Array.isArray(window.surroundingCharacters)) {
      runtimeList = window.surroundingCharacters;
    }
    for (var i = 0; i < runtimeList.length; i++) {
      var c = runtimeList[i] || {};
      var cid = String(c.id || c.key || c.characterId || c['0'] || '').trim();
      if (!cid || cid === 'B1') continue;
      var cname = String(c['1'] || c.name || c.title || '').split('|')[0];
      var realm = String(c['2'] || '').split('|')[0];
      push(cid, cname, realm, '', '');
    }
  } catch (e) {
    console.warn('[原著补演] 读运行时在场名单失败:', e);
  }

  // ② 存档人物表兜底
  try {
    if (typeof currentState !== 'undefined' && currentState) {
      var rows = currentState['0'] || {};
      for (var id in rows) {
        if (!Object.prototype.hasOwnProperty.call(rows, id)) continue;
        if (id === 'B1' || id === 'TIME_LOCATION_ROW') continue;
        var row = rows[id];
        if (!row) continue;
        var status = String(row['4'] || '').trim();
        if (/离场|退场|死亡/.test(status)) continue;
        var label = String(row['1'] || '').split('|')[0].trim();
        var realm2 = String(row['2'] || '').split('|')[0].trim();
        push(id, label, realm2, '', status);
      }
    }
  } catch (e) {}

  return out;
}

/**
 * 判断「谁是原著人物」的依据。
 *
 * 两条，任一成立即可：
 *   ① 原著重要人物名单与其明确别名
 *   ② 年表标题的人物标签里出现过
 *
 * 按两份现有名单合并，不从普通NPC存档扩张名单。
 */
function ceBridgeCanonSearchScope(timeline,targets) {
  var canon=ceBridgeKnownPeople(timeline).canonNames;
  var playerRow=typeof currentState!=='undefined' && currentState && currentState['0'] && currentState['0']['B1'];
  var playerNames=new Set(['B1','玩家','主角','我']);
  if(playerRow){
    var name=String(playerRow['1']||'').split('|')[0].replace(/<[^>]*>/g,'').trim();if(name)playerNames.add(name);
    if(typeof ceExtractOriginalTimelineAliasList==='function')Array.from(ceExtractOriginalTimelineAliasList(playerRow,{name:name})||[]).forEach(function(alias){playerNames.add(alias);});
    if(typeof ceGetImportantOriginalRoleAliases==='function')ceGetImportantOriginalRoleAliases(name).forEach(function(alias){playerNames.add(alias);});
  }
  var allowlist=Array.from(canon).filter(function(name){return !playerNames.has(name);}),allowed=new Set(allowlist);
  return {allowlist:allowlist,targets:(Array.isArray(targets)?targets:[]).filter(function(name){return allowed.has(name);})};
}

function ceBridgeKnownPeople(timeline) {
  var canonNames = new Set();
  var roster=typeof ceBridgeActiveRoleRoster==='function'?ceBridgeActiveRoleRoster():typeof CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP==='object'?CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP:{};
  Object.entries(roster).forEach(function(pair){canonNames.add(pair[0]);(pair[1] || []).forEach(function(alias){canonNames.add(alias);});});
  for (var i = 0; i < (timeline || []).length; i++) {
    var m = String((timeline[i] || {}).title || '').match(/\[人物[:：]([^\]]+)\]/);
    if (!m) continue;
    var pieces = m[1].split(/[,，]/);
    for (var j = 0; j < pieces.length; j++) {
      var n = pieces[j].replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '').trim();
      if (n) canonNames.add(n);
    }
  }
  return { canonNames: canonNames };
}

/**
 * 【正文后】跑一轮原著补演。
 *
 * 返回里带 diagHtml（写思维 tab）与 playerFeedback（给玩家看的总结），
 * 以及 ledgerPlan（**不自动写**，等变量落地成功后再提交）。
 */
async function ceBridgeRunTurn(options) {
  var opts = options || {};
  var config = opts.config || await ceBridgeLoadConfig();
  if (config.enabled === false) return { status: 'disabled', ok: false };

  var core;
  try { core = ceBridgeCore(); } catch (e) {
    console.error('[原著补演]', e.message);
    return { status: 'error', ok: false, reason: e.message };
  }

  if (config.showStatus !== false && !opts.traceRun) ceBridgeStatus('原著补演 · 准备资料');
  var traceRun=opts.traceRun||null;
  try {
    var timeline = opts.timeline || await frTimelineLoadForCanon('正文后补演',traceRun);
    timeline=frTimelineForPrebuiltSetting(timeline,config);
    var host = opts.host || ceBridgeHost(opts.signal,traceRun);

    // 上一轮的账本：从最近快照读，这样跨轮/回退都对得上
    var prevLedger = null;
    try {
      prevLedger = await ceBridgeLoadLedger({ worldTime: opts.worldTime || ceBridgeReadWorldTime() });
    } catch (e) {
      console.warn('[原著补演] 读上一轮账本失败:', e);
    }

    // ---- 补演区间的起点 ----
    //
    // 这里原来传的是「现在几点」（opts.worldTime / ceBridgeReadWorldTime()），
    // 于是编排器看到 worldTime 有值就不去读账本，区间退化成
    // 「此刻 → 此刻」。玩家从 0010 闭关到 0013，账本明明记着 0010.04，
    // 却从 0013.04 开始补 —— 中间这三年一次都没补过。
    //
    // 现在：起点优先取账本水位（上一次真正结算到的地方）。
    // 没有账本时（第一次启用）才退回当前时间，那是唯一合法的兜底。
    //
    // 注意 worldTime 和 targetTime 的分工：
    //   worldTime  = 补演起点（上次结算到哪）
    //   targetTime = 补演终点（正文之后确认到哪）
    var worldTimeNow = String(opts.worldTime || ceBridgeReadWorldTime() || '').trim();
    /* 账本水位不能盲目当补演起点。
     *
     * 2026-11-02 玩家报：「本轮时间跨度 0001年01月01日 08:00 → 0010年06月20日 13:30，
     * 这个时间不对劲」。开局指令写的是「故事从10年6月20日开始」。
     *
     * 根因：原卡创角时会把这个写死的初始时间塞进 TIME_LOCATION_ROW
     * （main.js: `0001年 01月 01日 08:00/${creationState.birthLocation}`），
     * 账本第一次 normalize 时把它当成 worldTime 存了下来。
     * 于是补演看到「上次结算到 0001 年」，就真的从 0001 年补起 ——
     * 跨了整整十年，既浪费 token，也把大段与当前剧情无关的原著事件卷进来。
     *
     * 判定口径：账本水位 == 创角默认值 → 这一档还没真正结算过，不是有效水位。
     * 这种情况退回当前时间（也就是开局设定的那一刻），跨度自然就是本轮该补的范围。
     */
    var FR_CREATION_DEFAULT_TIME = '0001年 01月 01日 08:00';
    var ledgerWater = String((prevLedger && prevLedger.worldTime) || '').trim();
    var ledgerIsCreationDefault = false;
    if (ledgerWater) {
      // 只比时间部分，地点是创角时选的出生地，不参与判定。
      var ledgerDatePart = ledgerWater.split('/')[0].replace(/\s+/g, ' ').trim();
      ledgerIsCreationDefault = ledgerDatePart === FR_CREATION_DEFAULT_TIME;
      if (ledgerIsCreationDefault) {
        console.log('[原著补演] 账本水位仍是创角默认时间（' + ledgerDatePart
          + '），说明这一档还没真正结算过；本轮补演起点改用当前时间 ' + worldTimeNow);
      }
    }
    var rangeStart = String(
      (ledgerWater && !ledgerIsCreationDefault ? ledgerWater : '') || worldTimeNow || ''
    ).trim();

    // 上一楼层已保存的人物正文：本轮续写的起点材料。
    // 玩家 2026-11-02：「把上一轮最后一段的内容原样发给模型。」
    //
    // ★ 2026-11-02 修：「原著补演未完成：ceBridgePreviousProseBlocks is not defined」
    //   ceBridgePreviousProseBlocks 在**整个代码库里都不存在**（只有这一处调用，
    //   从来没有定义）。走到这里的每一条补演都会在发请求前直接抛 ReferenceError，
    //   玩家看到的就是「原著补演未完成：xxx is not defined」。
    //   这里补上实现：从上一个已提交的补演记录里取回各人物已确认的正文块。
    var previousProseBlocks = (typeof ceBridgePreviousProseBlocks === 'function')
      ? await ceBridgePreviousProseBlocks(traceRun && traceRun.logId || opts.logId || '')
      : (function () {
          try {
            if (typeof frCanonTraceHistory !== 'object' || !frCanonTraceHistory.length) return [];
            var wantLogId = String((traceRun && traceRun.logId) || opts.logId || '');
            // 只认当前存档、已落地、未回滚的「正文后补演」记录，取最近一条。
            var rows = (frCanonTraceHistory || []).filter(function (run) {
              if (!run || run.archiveName !== currentArchiveName) return false;
              if (run.phase !== '正文后补演') return false;
              if (run.result && run.result.rolledBack) return false;
              if (wantLogId && run.logId && String(run.logId) === wantLogId) return false; // 本轮自己不算
              return true;
            });
            if (!rows.length) return [];
            var latest = rows[rows.length - 1];
            // 正文块来自 view 事件：kind='prose' 且被接受。
            var blocks = (latest.events || [])
              .filter(function (e) { return e && e.type === 'view' && e.data && e.data.kind === 'prose' && e.data.block; })
              .filter(function (e) { return e.data.accepted !== false; })
              .map(function (e) { return e.data.block; });
            return blocks;
          } catch (err) {
            console.warn('[原著补演] 读取上一轮人物正文失败，按无前情继续:', err);
            return [];
          }
        })();
    if (Array.isArray(previousProseBlocks) && previousProseBlocks.length) {
      console.log('[原著补演] 带上上一轮人物正文 '+previousProseBlocks.length+' 段作为续写起点');
    }

    const landingInput={logId:opts.logId,archiveName:opts.archiveName||currentArchiveName,signal:opts.signal,
      awaitOrdinaryWrite:opts.awaitOrdinaryWrite,floorContent:opts.floorContent,storyText:opts.storyText,
      timelineSource:traceRun?._timelineSource,ordinarySettlement:opts.ordinarySettlement};
    let settlement;
    const awaitPrebuiltSettlement=typeof frAwaitCanonPrebuiltSettlement==='function'?
      ()=>settlement ||= frAwaitCanonPrebuiltSettlement(landingInput):undefined;
    const prebuiltLanding=typeof frCreatePrebuiltLanding==='function'?
      frCreatePrebuiltLanding({...landingInput,awaitSettlement:awaitPrebuiltSettlement}):undefined;
    var result = await core.orchestrator.runCanonTurn({
      host: host,
      previousProse: previousProseBlocks,
      // 中止信号：玩家点停止后，核心包不能再发请求、不能再重试、
      // 也不能把本轮结果当成成功推进账本。
      signal: opts.signal || null,
      // 起点：账本水位优先
      worldTime: opts.replay?.boundary?.start || rangeStart,
      // 终点：正文之后的真实时间；没给就沿用当前时间
      targetTime: String(opts.replay?.boundary?.end || opts.targetTime || worldTimeNow || '').trim(),
      timeline: timeline,
      storyText: typeof frCanonMainStoryText==='function'?frCanonMainStoryText(opts.storyText):opts.storyText||'',
      archiveName:currentArchiveName,
      logId:traceRun&&traceRun.logId||opts.logId||'',canonicalNames:ceBridgeCanonSearchScope(timeline,[]).allowlist,
      materialState:opts.replay&&opts.replay.materialState||opts.materialState||null,
      playerInput: opts.playerInput || '',
      characters: ceBridgeReadCharacters(collectTitleNames(timeline), await ceBridgeReadStoredRows()),
      // 正文前那一刻的人物行快照。
      //
      // 历史（旧账）要补的是正文之前那几个月，那时候的状态跟现在不一样：
      // 正文可能刚把人写死、刚让他突破。拿正文后的状态去写历史，
      // 会把后面才发生的事当成一直如此——这就是 R01「终点状态污染历史」。
      //
      // 这里传的是 main.js 在正文应用之前存下的只读副本。
      // 没捕获到就是 null，编排器必须据此明确降级，不许拿现状顶上。
      beforeStateRows: ceBridgeGetBeforeState(),
      // 在场名单：推演时要分清「他在场」和「他不在场」，
      // 同一个人的「躲不掉的事」是两回事
      onScene: ceBridgeReadOnScene(),
      location: opts.location || ceBridgeReadLocation(),
      // 账本：欠账、跨轮半截事件、上一轮记录
      debts: prevLedger ? prevLedger.debts : undefined,
      openEvents: prevLedger ? prevLedger.openEvents : [],
      eventProgress:prevLedger ? prevLedger.eventProgress : [],
      prebuiltActorDifferences:prevLedger?.prebuiltActorDifferences || [],
      eventWatches:prevLedger ? prevLedger.eventWatches || [] : [],
      mutationNotes:prevLedger?.mutationNotes || [],
      previousTurn: prevLedger ? prevLedger.lastTurn : null,
      // 黄区钩子：跨轮伏笔。存在账本的 openEvents 之外、
      // 必须随快照一起回退的那份「起了头还没收尾」的记录。
      //
      // 这里原来一个字都没传，于是 orchestrator 里的 src.hooks
      // 永远是 undefined，钩子每轮都从空开始，
      // 「三轮寿命」这条规则从来没生效过。
      hooks: (prevLedger && Array.isArray(prevLedger.hooks)) ? prevLedger.hooks : undefined,
      // 轮次：钩子年龄要用它。宿主给多少就用多少，
      // 不给才退回 0（那是第一轮，合法）。
      turnNo: Number(opts.turnNo) > 0
        ? Number(opts.turnNo)
        : (prevLedger && Number(prevLedger.turnNo) > 0 ? Number(prevLedger.turnNo) + 1 : 1),
      options: Object.assign({},ceBridgeProseDispatchConfig(config),{
        /* 玩家 2026-11-01：设定集检索按阶段分开控制。
         * 这里是**原著补演**的主入口，用 replay 这一档（默认开）。
         * 漏掉这处的话，补演走总闸默认值，玩家的开关就不生效了。 */
        materials:ceBridgeMaterialsFor('replay',config),
        ordinarySettlement:opts.ordinarySettlement||null,savedActorCommits:opts.savedActorCommits,replay:opts.replay||null,onProseReady:opts.onProseReady,
        awaitPrebuiltSettlement,prebuiltLanding,
        preparePrebuiltProposal:prebuiltLanding?.prepare || (typeof frPrepareCanonPrebuiltProposal==='function'?
          payload=>frPrepareCanonPrebuiltProposal(payload,landingInput):undefined),
        turnNo:Number(opts.turnNo) || (prevLedger && Number(prevLedger.turnNo) || 0) + 1,
        /* ★★★ 2026-11-03 玩家定：局部重跑不该从「补演边界判定」重跑整轮。
         *
         * core 是独立模块、不碰前端落库能力，所以由这里注入一个回调：
         * orchestrator 算完前置分工后调它，把**完整对象**（含 storyAnalysis 的
         * handled / worldEvents / factRecords）原样存进本轮产物，
         * 供下一次局部重跑直接取回来复用（见 canon-replay.js 的 frCanonBoundaryLoad）。
         *
         * 存档名和 logId 从 opts 里取；取不到就不存（本轮照常，只是下次重跑要重算边界）。 */
        freezeBoundary:(typeof frCanonBoundarySave==='function')?async function(frozen){
          var archiveName=currentArchiveName,logId=opts.logId;
          if(!archiveName||!logId)return null;
          var row=await frCanonBoundarySave(archiveName,logId,frozen,'canon');
          if(typeof frCanonBoundaryPrune==='function')await frCanonBoundaryPrune(archiveName,logId,'canon');
          return row;
        }:undefined},traceRun?{onStage:function(name,detail,view){frCanonTraceEvent(traceRun,'stage',name,detail);if(view)frCanonTracePublish(traceRun,view.kind==='prose'?'人物正文 · '+view.block.name:name,view);},onRetry:function(info){frCanonTraceEvent(traceRun,'retry','重试 · '+info.stage,info);}}:{})
    });

    // 诊断写进思维 tab
    if (config.showDiagnostics !== false) {
      // 资料明细放前面：NPC 视角正文写得对不对，先看资料全不全
      var matCore = core['host-material'];
      if (matCore && Array.isArray(result.materialReport) && result.materialReport.length > 0) {
        var rec0 = core.visibility.createDiagRecorder();
        var matLines0 = matCore.materialReportLines(result.materialReport);
        for (var k = 0; k < matLines0.length; k++) {
          var ml0 = matLines0[k] || {};
          if (ml0.level === 'warn') rec0.warn(ml0.text, ml0.detail);
          else rec0.step(ml0.text, ml0.detail);
        }
        rec0.step('资料合计', matCore.summarizeMaterialStatus(result.materialReport));
        ceBridgePushDiagnostics(core.visibility.renderDiagHtml(rec0.items()));
      }
      ceBridgePushDiagnostics(result.diagHtml || '');
      ceBridgeRememberDiag(result.diagItems || []);
    }

    ceBridgeLastResult = result;
    if(traceRun && typeof frCanonMaterialAttach==='function')await frCanonMaterialAttach(traceRun,result);
    if(traceRun)frCanonTraceEvent(traceRun,'parsed','补演解析与账本计划',result);
    return result;
  } catch (e) {
    console.error('[原著补演] 一轮补演失败:', e);
    if (config.showDiagnostics !== false) {
      ceBridgePushDiagnostics(
        '<div class="ce-thinking-section"><div class="ce-thinking-section-header">原著补演</div>'
        + '<div class="ce-thinking-section-body"><div style="color:#e57373">✖ 运行出错：'
        + ceBridgeEsc(String(e && e.message || e)) + '</div></div></div>'
      );
    }
    return { status: 'error', ok: false, reason: String(e && e.message || e),retry:e.retry||null };
  } finally {
    if (config.showStatus !== false && !opts.deferCloseStatus) ceBridgeCloseStatus(traceRun);
  }
}

/**
 * 把账本提交计划真正写下去。
 *
 * **只有调用方确认变量落地成功 + 快照保存成功之后才能调这个。**
 * 这是总设计 §4.3.6 硬规定的：账本由代码写，模型不能写。
 */
async function ceBridgeCommitLedger(ledgerPlan, host) {
  if (!ledgerPlan || ledgerPlan.changed !== true) {
    return { ok: false, reason: '账本无需变更' };
  }
  var core;
  try { core = ceBridgeCore(); } catch (e) {
    return { ok: false, reason: e.message };
  }
  var h = host || ceBridgeHost();
  return core.ledger.saveLedger(h, ledgerPlan.next);
}

/** 从年表标题里收集人名（[人物:...] 标签）
 *
 * ★ 2026-11-03 我一度以为「张铁（心神已灭）」剥括号后会与「张铁」重复，
 * 想改这里。用真实年表（1201 条）跑过后发现**这个推测是错的**：
 * 本函数有 `!names[n]` 去重，旧实现名单里「张铁」只出现 **1** 次，无任何重复项。
 * 改了反而让名单从 1363 涨到 1539（多 176 个带括号的伪名字），
 * 属于没有证据的行为变更，已回退。真正的重复来源在 ceBridgeReadCharacters 的 byName。
 * 这里保持原样，不再动。 */
function collectTitleNames(timeline) {
  var names = {};
  var out = [];
  for (var i = 0; i < (timeline || []).length; i++) {
    var m = String((timeline[i] || {}).title || '').match(/\[人物[:：]([^\]]+)\]/);
    if (!m) continue;
    var pieces = m[1].split(/[,，]/);
    for (var j = 0; j < pieces.length; j++) {
      var n = pieces[j].replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '').trim();
      if (n && !names[n]) { names[n] = true; out.push(n); }
    }
  }
  return out;
}

function ceBridgeEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- ③ 设置入口 ----------

/**
 * 在既有设置面板里插入原著补演配置块。
 *
 * 由宿主在打开设置面板时调用（manageConcurrentEvolutionSettings 里）。
 * 不新开窗口。
 */
/**
 * 打开「原著补演」设置面板（独立窗口）。
 *
 * 用户 2026-10-21：
 *   「似乎原著补演系统需要的面板设置比较多，你都抽出来单独做个设置面板，
 *     就叫原著补演。」
 *
 * 之前是塞在变量演化面板里的一块，和那边几十项混着，
 * 玩家找不着也分不清。现在独立成窗。
 *
 * 打开流程：造 HTML → 挂到 body → 绑定关闭/保存 → 显示。
 * 只造一次，之后复用同一个 DOM（避免每次打开都重建 14 个资料开关 + 9 段提示词）。
 */
async function ceBridgeOpenSettings() {
  var core;
  try { core = ceBridgeCore(); } catch (e) {
    console.error('[原著补演]', e.message);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('原著补演核心包没加载：' + e.message, '原著补演');
    }
    return { opened: false, reason: e.message };
  }

  var panel = core['settings-panel'];
  var config = await ceBridgeLoadConfig();

  var ledger = { worldTime: '', debts: [], openEvents: [], lastTurn: null };
  try {
    ledger = await ceBridgeLoadLedger({ worldTime: ceBridgeReadWorldTime() });
  } catch (e) {}

  var statusLine = core.visibility.renderSettingsStatusLine({
    enabled: config.enabled !== false,
    ledger: ledger,
    overrides: config.promptOverrides
  });

  var overlayId = panel.CE_PANEL_OVERLAY_ID;

  // 每次打开都读真实配置与账本；旧节点的监听随节点释放。
  var existing = document.getElementById(overlayId);
  if (existing) {
    existing.remove();
  }

  var html = panel.buildCanonPanelHtml(config, { statusLine: statusLine,importantRoleRoster:CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP || 5 });

  try {
    var holder = document.createElement('div');
    holder.innerHTML = html;
    var node = holder.firstElementChild;
    if (!node) throw new Error('面板 HTML 生成失败');
    document.body.appendChild(node);
  } catch (e) {
    console.error('[原著补演] 面板挂载失败:', e);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('原著补演面板挂载失败：' + (e && e.message), '原著补演');
    }
    return { opened: false, reason: String(e && e.message || e) };
  }

  /* ★★ 2026-11-01 找到面板「彻底乱套」的真根因了。
   *
   * 这里原来是一个**空的 catch**：
   *     try { if(!已有) 注入 } catch (e) {}
   *
   * buildCanonPanelCss() 一旦抛异常，就被这个空 catch 吞掉，
   * 结果：面板一条样式都没有，视觉全靠游戏全局 CSS 勉强拼，
   * 于是「文字压字 / 中间大片空白 / 东一块西一块」。
   * 而且**永远不报错** —— 这就是我前面几次改 CSS 都「看不出效果」的原因：
   * 改的是 buildCanonPanelCss()，它生成的东西根本没进页面。
   *
   * 现在改三件事：
   *   ① 失败要吼出来（console.error + 面板上直接标红），不再静默；
   *   ② 每次打开都重新写入样式，不再「只注入一次」——
   *      否则面板代码改了，页面里还挂着一份旧 CSS；
   *   ③ 空内容当失败处理，不允许静默留一个空 style 标签。
   */
  try {
    var st = document.getElementById('ce-canon-panel-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'ce-canon-panel-style';
      document.head.appendChild(st);
    }
    var cssText = panel.buildCanonPanelCss();
    if (typeof cssText !== 'string' || !cssText.trim()) {
      throw new Error('buildCanonPanelCss() 返回空内容');
    }
    st.textContent = cssText;
  } catch (e) {
    console.error('[原著补演] 面板样式注入失败，面板将以无样式状态显示：', e);
  }

  var overlay = document.getElementById(overlayId);
  panel.bindCanonRoleRosterEditor(overlay,config.importantRoleLists,CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP);
  if(typeof frCanonBindSettings==='function')frCanonBindSettings(overlay);

  // 关闭：点 × / 点关闭按钮 / 点遮罩空白处
  var close = function () { ceBridgeCloseSettings(); };
  try {
    overlay.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t === overlay) { close(); return; }
      if (t && t.getAttribute && t.getAttribute('data-ce-canon-close')) { close(); return; }
    });
  } catch (e) {}

  // 资料开关全开/全关
  // 统一的按钮反馈：点了必须有可见结果，不能静默生效。
  var canonFlash = function (message, ok) {
    var feedback = document.getElementById('ce-canon-save-feedback');
    if (feedback) { feedback.textContent = message; feedback.dataset.state = ok === false ? 'error' : 'ok'; }
    if (typeof showDanmaku === 'function' && ok !== false) showDanmaku(message, 'info');
  };
  try {
    var allOn = document.getElementById('ce-canon-materials-all-on');
    var allOff = document.getElementById('ce-canon-materials-all-off');
    var setAll = function (on) {
      // 2026-11-01：两个阶段各有自己的开关，这里对**两个阶段一起**操作，
      // 但每个开关仍然写各自那一格，不会把两阶段互相同化成一个值。
      var boxes = overlay.querySelectorAll('.ce-canon-toggle input[data-key]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = on;
      canonFlash(on ? '已把两个阶段的 ' + boxes.length + ' 项资料全部打开，保存后生效' : '已把两个阶段的 ' + boxes.length + ' 项资料全部关闭，保存后生效');
    };
    if (allOn) allOn.addEventListener('click', function () { setAll(true); });
    if (allOff) allOff.addEventListener('click', function () { setAll(false); });

    var resetBtn = document.getElementById('ce-canon-materials-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        panel.resetCanonPanelSection(overlay,'materials');
        canonFlash('已恢复两个阶段各自的资料默认设置，保存后生效');
      });
    }
  } catch (e) {}

  // 提示词逐条恢复默认
  try {
    var resets = overlay.querySelectorAll('.ce-canon-reset-one');
    for (var r = 0; r < resets.length; r++) {
      resets[r].addEventListener('click', function (ev) {
        var key = ev.currentTarget.getAttribute('data-key');
        panel.resetCanonPromptFromDom(overlay,key);
        canonFlash('已恢复该项默认提示词，保存后生效');
      });
    }
  } catch (e) {}

  // 分页恢复只更新本页草稿，保存按钮仍是唯一写回入口。
  try {
    var pageResets = overlay.querySelectorAll('[data-ce-canon-reset-section]');
    for(var p=0;p<pageResets.length;p++){
      pageResets[p].addEventListener('click', function (ev) {
        panel.resetCanonPanelSection(overlay,ev.currentTarget.getAttribute('data-ce-canon-reset-section'));
        canonFlash('已恢复本页默认值，保存后生效');
      });
    }
  } catch (e) {}

  // 保存
  try {
    var saveBtn = document.getElementById('ce-canon-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var feedback=document.getElementById('ce-canon-save-feedback');
        saveBtn.disabled=true;if(feedback)feedback.textContent='正在保存…';
        var saved;
        try{saved=await ceBridgeSaveSettingsFromDom(await ceBridgeLoadConfig());}catch(error){saved={ok:false,reason:String(error.message||error)};}
        saveBtn.disabled=false;
        if (saved && saved.ok) {
          ceBridgeLastConfig=saved.config;
          if(feedback)feedback.textContent='已保存，后续运行使用新配置';
          if (typeof showDanmaku === 'function') showDanmaku('原著补演设置已保存', 'success');
        } else {
          if(feedback)feedback.textContent='保存失败：'+((saved&& saved.reason)||'存储不可用');
        }
      });
    }
  } catch (e) {}

  try {
    overlay.classList.remove('hidden');
    overlay.classList.add('visible');
    var focusControl=overlay.querySelector('#ce-canon-api-mode');if(focusControl)focusControl.focus();
  } catch (e) {}

  return { opened: true, reused: false };
}

/** 关掉面板 */
function ceBridgeCloseSettings() {
  try {
    var core = ceBridgeCore();
    var id = core['settings-panel'].CE_PANEL_OVERLAY_ID;
    var overlay = document.getElementById(id);
    if (!overlay) return false;
    overlay.classList.remove('visible');
    overlay.classList.add('hidden');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 兼容旧接口：宿主在打开变量演化设置时会调它。
 *
 * 现在不再往那个面板里塞内容——改成什么都不做，
 * 由「原著补演」按钮单独打开。保留函数是为了不断宿主已有调用。
 */
async function ceBridgeEnsureSettings() {
  return { inserted: false, reason: '已改为独立面板，用 ceBridgeOpenSettings 打开' };
}

/** 从面板读回配置并保存 */
async function ceBridgeSaveSettingsFromDom(base) {
  var core;
  try { core = ceBridgeCore(); } catch (e) {
    return { ok: false, reason: e.message };
  }
  var next = core['settings-panel'].readCanonPanelFromDom(document, base || {});
  if(JSON.stringify(next.importantRoleLists||{})!==JSON.stringify(base?.importantRoleLists||{})&&typeof frTimelineCanSave==='function'&&!frTimelineCanSave())return {ok:false,reason:'本轮仍在运行，名单草稿已保留；结束后再保存，避免中途改变人物范围。'};
  var api=next.api||{};
  if((api.apiUrl||api.apiKey||api.apiModel)&&(!api.apiUrl||!api.apiKey||!api.apiModel))return {ok:false,reason:'独立接口需要完整的URL、密钥和模型；或选择沿用变量演化。'};
  if(api.apiUrl&&!/^https?:\/\//i.test(api.apiUrl))return {ok:false,reason:'API URL需要以http://或https://开头。'};
  var ok = await ceBridgeSaveConfig(next);
  return { ok: ok, config: next };
}

// ---------- 账本读写 ----------

/**
 * 读账本。
 *
 * **优先从最近一层快照里读**（回退到历史层时，账本自动是那一层的），
 * 快照里没有才退回旧全局键（迁移老存档）。
 *
 * @param {object} [options]
 * @returns {Promise<object>} 账本
 */
async function ceBridgeLoadLedger(options) {
  var opts = options || {};
  var core = ceBridgeCore();

  // 当前状态由原卡的读档/回退机制维护。优先且只读其楼层账本，
  // 不能用“数据库最新日志”或跨存档全局键覆盖玩家恢复的较早状态。
  if (typeof currentState !== 'undefined' && currentState) {
    return core.ledger.normalizeLedger(currentState.canonLedger || null, {
      worldTime: (ceBridgeBeforeArchive === currentArchiveName && ceBridgeBeforeTime) || opts.worldTime || ceBridgeReadWorldTime()
    }).ledger;
  }

  var snapshot = null;
  try {
    snapshot = await ceBridgeLatestSnapshot();
  } catch (e) {
    console.warn('[原著补演] 读最近快照失败，账本按空处理:', e);
  }

  try {
    var loaded = await core.ledger.loadLedger(ceBridgeHost(), {
      worldTime: opts.worldTime || ceBridgeReadWorldTime(),
      snapshot: snapshot
    });
    if (loaded && loaded.migrated) {
      console.log('[原著补演] 账本已从旧全局键迁移到快照');
    }
    return loaded.ledger;
  } catch (e) {
    console.warn('[原著补演] 读账本失败，用空账本:', e);
    return { version: 2, worldTime: '', debts: [], openEvents: [], lastTurn: null };
  }
}

/**
 * 取最近一层存档快照。
 *
 * 这是「回退友好」的关键：读的是**当前指向那一层**的快照，
 * 玩家回退到哪一层，读到就是哪一层的账本。
 *
 * @returns {Promise<object|null>}
 */
async function ceBridgeLatestSnapshot() {
  try {
    if (typeof db === 'undefined' || !db || !db.archives) return null;
    if (typeof currentArchiveName === 'undefined' || !currentArchiveName) return null;

    var archive = await db.archives.get(currentArchiveName);
    var logs = archive && archive.data && Array.isArray(archive.data.logs)
      ? archive.data.logs : null;
    if (!logs || logs.length === 0) return null;

    for (var i = logs.length - 1; i >= 0; i -= 1) {
      var snap = logs[i] && logs[i].stateSnapshot;
      if (typeof snap === 'string' && snap && snap !== 'null') {
        try { return JSON.parse(snap); } catch (e) { continue; }
      }
      if (snap && typeof snap === 'object') return snap;
    }
  } catch (e) {
    console.warn('[原著补演] 取快照失败:', e);
  }
  return null;
}

// ---------- 挂载 ----------

(function () {
  try {
    if (typeof window === 'undefined') return;

    window.__canon = {
      version: 'v1-bridge',
      runGuidance: ceBridgeRunGuidance,
      runTurn: ceBridgeRunTurn,
      commitLedger: ceBridgeCommitLedger,
      ensureSettings: ceBridgeEnsureSettings,
      openSettings: ceBridgeOpenSettings,
      closeSettings: ceBridgeCloseSettings,
      saveSettings: ceBridgeSaveSettingsFromDom,
      loadConfig: ceBridgeLoadConfig,
      saveConfig: ceBridgeSaveConfig,
      defaultConfig: ceBridgeDefaultConfig,
      host: ceBridgeHost,
      lastResult: function () { return ceBridgeLastResult; },
      status: ceBridgeStatus,
      closeStatus: ceBridgeCloseStatus,
      pushDiag: ceBridgePushCanonDiag,
      // 让玩家能在控制台自检：核心包到没到、配置长什么样
      diagnose: async function () {
        var core;
        try { core = ceBridgeCore(); } catch (e) {
          console.error('[原著补演] 核心包缺失:', e.message);
          return { coreLoaded: false, reason: e.message };
        }
        var config = await ceBridgeLoadConfig();
        var ledger = await ceBridgeLoadLedger({ worldTime: ceBridgeReadWorldTime() });
        var report = {
          coreLoaded: true,
          modules: Object.keys(core),
          enabled: config.enabled !== false,
          ledger: ledger,
          ledgerRepaired: false,
          statusLine: core.visibility.renderSettingsStatusLine({
            enabled: config.enabled !== false,
            ledger: ledger,
            overrides: config.promptOverrides
          }),
          // 正文前快照：历史（旧账）靠它才不会被终点状态污染。
          // 没捕获到的时候必须让玩家看见，不能悄悄降级。
          beforeStateCaptured: ceBridgeGetBeforeState() != null,
          // 旧 NPC 自主生活链路的真实状态。
          //
          // 它有完整实现，但**没有任何生产入口调用它**，
          // 而且它只往 currentState.state.npcPovLatest 挂一个字符串，
          // 那个字段没有外部读者 —— 接上去等于造一个新的「只写不读」。
          //
          // 所以本轮明确不接，并把这件事写进自检，
          // 免得玩家以为它在跑。
          npcPov: {
            available: typeof ceNpcPovRun === 'function',
            wired: false,
            note: '旧 NPC POV 链路未接入。自主日常由主补演路径承担；'
              + '它的产出 npcPovLatest 目前没有任何外部消费者，'
              + '接上去只会多一个只写不读的字段（与已修的 F02 同形）。'
          }
        };
        console.log('[原著补演] 自检:', report);
        return report;
      }
    };

    console.log('[原著补演] 桥接层已加载，控制台可用 window.__canon.diagnose() 自检');
  } catch (e) {
    console.warn('[原著补演] 桥接层挂载失败:', e);
  }
})();
