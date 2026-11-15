// NPC视角正文：默认按输入/输出容量合并，逐人保留材料与篇幅。
// 玩家可选择重要人物单写或指定单写；所有合写路径按容量拆批。
//
// 三档待遇（core/major/minor）决定篇幅预算与是否单写。
// 「单独写/合并写」是请求形式，「核心/重要/配角」是规格，两者不是一回事：
// 单写一个配角，不意味着它自动获得核心的全部额外核验。

import { packRequestMaterials } from './request-budget.js';
import { CE_CAST_TIER, castTierBudget, assignCastTiers } from './role-roster.js';
import {withProseBudget} from './prose-budget.js';

/** 分派策略 */
export const CE_PROSE_DISPATCH = {
  /** 全部逐个单独写（最细，最贵） */
  allSolo: 'all_solo',
  capacity: 'capacity',
  /** 全部合并成一次数组（最省，最粗） */
  allBatch: 'all_batch',
  /** 重要人物单独、配角合并（可选） */
  mixed: 'mixed',
};

/**
 * 把一批 NPC 分派到「单独写」与「合并写」两条路。
 *
 * @param {Array<object>} materials buildCharacterMaterial() 的产物
 * @param {object} [options]
 * @param {string} [options.strategy='mixed']
 * @param {number} [options.maxPerBatch=6] 每次数组调用最多塞几个
 * @param {object} [options.force] 玩家强制指定 { solo: string[], batch: string[] }
 * @param {Function} [options.resolveImportantRole] 复用原卡识别，(名字或别名) => 名单中的规范姓名或空串
 * @returns {{
 *   solo: Array<object>,
 *   batches: Array<Array<object>>,
 *   strategy: string
 * }}
 */
export function planProseDispatch(materials, options = {}) {
  const list = Array.isArray(materials) ? materials : [];
  const strategy = options.strategy || CE_PROSE_DISPATCH.mixed;

  const force = options.force && typeof options.force === 'object' ? options.force : {};
  const resolve = typeof options.resolveImportantRole === 'function' ? options.resolveImportantRole : () => '';
  const normalize = value => resolve(String(value || '').trim()) || String(value || '').trim();
  const forceSolo = new Set((Array.isArray(force.solo) ? force.solo : []).map(normalize).filter(Boolean));
  const forceBatch = new Set((Array.isArray(force.batch) ? force.batch : []).map(normalize).filter(Boolean));

  // 当前默认：每个人仍有独立材料、预算和结果，只有容量不够才拆批。
  if(strategy===CE_PROSE_DISPATCH.capacity || strategy===CE_PROSE_DISPATCH.allBatch){
    const pool=[],solo=[];
    // 三档只在调用方真的给了分档信息时才生效；否则完全保持旧的「重要/其余」两档行为，
    // 避免没有配置的调用方被悄悄降级。
    const tiers=options.castTiers instanceof Map?options.castTiers:null;
    const coreNames=new Set((Array.isArray(options.coreNames)?options.coreNames:[]).map(value=>String(value||'').trim()).filter(Boolean));
    const tiered=Boolean(tiers&&tiers.size)||coreNames.size>0;
    for(const item of list){
      const important=[item.name,...(item.aliases || [])].some(token=>Boolean(resolve(token)));
      const tier=tiers&&tiers.get(item.name)||(coreNames.has(item.name)?CE_CAST_TIER.core:important?CE_CAST_TIER.major:CE_CAST_TIER.minor);
      const fallback=important?(Number(options.coreMaxChars)||800):(Number(options.minorMaxChars)||400);
      // 只有真的分了三档才按档取预算，否则沿用旧的两档预算。
      const maxChars=tiered?castTierBudget(tier,options.tierBudgets):fallback;
      const row=withProseBudget({...item,material:{...item.material,important,...(tiered?{tier}:{})}},maxChars);
      const forcedSolo=[item.name,...(item.aliases || [])].map(normalize).some(key=>forceSolo.has(key));
      /* ★★ 2026-11-01 修正「请求数暴涨」。
       *
       * 旧判断：`row.material.proseMaxChars+500 > maxOutputChars` 就直接单写。
       * 问题：proseMaxChars 是 **base × 事件数**，一个人跨 5 个事件就是 800×5=4000；
       *       玩家若把「单批输出容量」调到 1000，几乎人人都会命中这条，
       *       于是每个人都变成一次单独请求 —— 以为是省，实际是最贵。
       *
       * 而且「单人预计输出超过单批上限」本来就不该由这里判死：
       * 那个人确实放不进任何一批，但这是**容量配置问题**，应该由
       * packRequestMaterials 明确报错并提示「调高单批输出容量」，
       * 而不是悄悄把他拆成一次独立请求，把问题变成请求数爆炸。
       *
       * 现在只有两种真正的「必须单写」：
       *   ① 玩家强制指定单写（forcedSolo）
       *   ② 核心档默认单写（避免最高规格被合批稀释）
       * 其余全部交给容量去合批、拆批 —— 这正是玩家要的「双重保险」。
       */
      if(forcedSolo||(tiered&&tier===CE_CAST_TIER.core&&options.coreSolo!==false))solo.push(row);else pool.push(row);
    }
    const first=pool[0]?.material || {};
    const bgChars=String(first.background || '').length,storyChars=String(first.story || '').length;
    /* ★★ 2026-11-01 玩家：「正确的逻辑是按照一批写几个人来，比如说我设置一批写6人，
     *   然后再设置一个输入输出上限，如果六个人的输入或者输出超过我设置的上限，
     *   那就减人数到上限下面，明白这个逻辑吗？双重保险。」
     *
     * 在此之前，maxPerBatch 一路传到这个函数，然后**谁也没用它**：
     *   面板上那个「每批最多处理几条」的输入框改了等于没改，
     *   实际每批人数完全由容量算，玩家设的 6 人根本不生效。
     *
     * 现在把它当作 packRequestMaterials 的 maxItems（该函数早就支持这个参数，
     * 时间线/向量那条路一直在用），于是「双重保险」成立：
     *   ① 先按人数：每批最多 maxPerBatch 人
     *   ② 再按容量：某一批的输入或输出超上限，就减人（packRequestMaterials 的
     *      group 满或超限即开新批），直到放得下
     * 两道闸都生效，人数少的时候由容量说了算，容量宽裕的时候由人数说了算。
     */
    const maxPerBatch = Number(options.maxPerBatch);
    const perBatchCap = Number.isFinite(maxPerBatch) && maxPerBatch > 0 ? Math.floor(maxPerBatch) : undefined;
    const batches=packRequestMaterials(pool,{sharedChars:bgChars+storyChars,
      // 2026-10-31：重跑时每批都要带全量世界背景，容易超容量。这里标明这是重跑，
      // 让 request-budget 用更高的上限，并把字数构成带出去，报错时能看出是哪块大。
      replay:Boolean(options.replay),
      sharedBreakdown:{世界背景:bgChars,本轮正文:storyChars},
      onSharedTrimmed:typeof options.onSharedTrimmed==='function'?options.onSharedTrimmed:undefined,
      // 人数上限（第一道闸）
      maxItems:perBatchCap,
      measure:row=>JSON.stringify({...row,material:{...row.material,background:'',story:''}}).length,estimateOutput:row=>(row.material.proseMaxChars || 400)+500,maxInputChars:options.maxInputChars,maxOutputChars:options.maxOutputChars});
    return {solo,batches,strategy};
  }
  // 全部逐个写：请求形式全单写，但篇幅仍按档取——
  // 单写不等于核心待遇，配角单写也只有配角预算。
  if (strategy === CE_PROSE_DISPATCH.allSolo) {
    const tiers=options.castTiers instanceof Map?options.castTiers:null;
    const coreNames=new Set((Array.isArray(options.coreNames)?options.coreNames:[]).map(value=>String(value||'').trim()).filter(Boolean));
    const tiered=Boolean(tiers&&tiers.size)||coreNames.size>0;
    const solo=list.map(item=>{
      const important=[item.name,...(item.aliases || [])].some(token=>Boolean(resolve(token)));
      const tier=tiers&&tiers.get(item.name)||(coreNames.has(item.name)?CE_CAST_TIER.core:important?CE_CAST_TIER.major:CE_CAST_TIER.minor);
      const fallback=important?(Number(options.coreMaxChars)||800):(Number(options.minorMaxChars)||400);
      const maxChars=tiered?castTierBudget(tier,options.tierBudgets):fallback;
      return withProseBudget({...item,material:{...item.material,important,...(tiered?{tier}:{})}},maxChars);
    });
    return { solo, batches: [], strategy };
  }

  // 混合：手动指定优先，再按原卡的重要角色名单分流
  const solo = [];
  const batchPool = [];
  const tiers=options.castTiers instanceof Map?options.castTiers:null;
  const coreNames=new Set((Array.isArray(options.coreNames)?options.coreNames:[]).map(value=>String(value||'').trim()).filter(Boolean));

  for (const item of list) {
    if (!item || !item.name) continue;
    const name = String(item.name).trim();

    const tokens = [name,...(Array.isArray(item.aliases) ? item.aliases : [])];
    const keys = tokens.map(normalize);
    const important = tokens.some(token => Boolean(resolve(token)));
    const tier=tiers&&tiers.get(name)||(coreNames.has(name)?CE_CAST_TIER.core:important?CE_CAST_TIER.major:CE_CAST_TIER.minor);
    const budget=castTierBudget(tier,options.tierBudgets);
    const fallback=tier===CE_CAST_TIER.core?(Number(options.coreMaxChars)||800):(Number(options.minorMaxChars)||400);
    const row=withProseBudget({...item,material:{...item.material,important,tier}},Number(options.tierBudgets?.[tier])>0?budget:fallback);
    /* 核心档无论玩家怎么勾选都必须单写：这是三档规格的底线，
     * 不能因为手动「合并写」把最高规格稀释掉。
     *
     * ★ 2026-11-01：这里原来还有一条
     *     || row.material.proseMaxChars+500 > maxOutputChars
     *   会把人推到单写，导致「跨事件多的人」几乎人人单写、请求数暴涨。
     *   已删除：单人预计输出超上限属于容量配置问题，交给 packRequestMaterials
     *   明确报错并提示调高「单批输出容量」，不该悄悄变成一次独立请求。
     */
    if (tier===CE_CAST_TIER.core && options.coreSolo!==false) solo.push(row);
    else if (keys.some(key => forceSolo.has(key))) solo.push(row);
    else if (keys.some(key => forceBatch.has(key))) batchPool.push(row);
    else if (important && !tiers && !coreNames.size) solo.push(row);
    else batchPool.push(row);
  }

  const shared=batchPool[0]?.material || {};
  const bgChars=String(shared.background || '').length,storyChars=String(shared.story || '').length;
  // 同 capacity 路径：人数上限要一路传到 packRequestMaterials 才真的生效。
  const maxPerBatchMixed = Number(options.maxPerBatch);
  const perBatchCapMixed = Number.isFinite(maxPerBatchMixed) && maxPerBatchMixed > 0 ? Math.floor(maxPerBatchMixed) : undefined;
  return {solo,batches:packRequestMaterials(batchPool,{...options,sharedChars:bgChars+storyChars,
    // 同上一处：重跑时放宽输入上限，并带上字数构成供报错说明。
    replay:Boolean(options.replay),
    sharedBreakdown:{世界背景:bgChars,本轮正文:storyChars},
    // 人数上限（第一道闸）
    maxItems:perBatchCapMixed,
    measure:row=>JSON.stringify({...row,material:{...row.material,background:'',story:''}}).length,estimateOutput:row=>(row.material.proseMaxChars||400)+500}),strategy};
}

/* 2026-11-01：这里原来有一个 chunk(list,size) 辅助函数，但本文件所有分派路径
 * 都走 packRequestMaterials，从来没调用过它。已删除，避免「看着像在切片其实没切」。 */

/**
 * 估算一次分派会产生多少次模型调用。
 * 面板上可以直接显示给玩家，避免「以为很省结果炸了」。
 *
 * @param {{solo:Array, batches:Array}} plan
 * @returns {{soloCalls:number, batchCalls:number, total:number, people:number}}
 */
export function estimateDispatchCost(plan) {
  const solo = Array.isArray(plan && plan.solo) ? plan.solo : [];
  const batches = Array.isArray(plan && plan.batches) ? plan.batches : [];
  const inBatches = batches.reduce((s, b) => s + (Array.isArray(b) ? b.length : 0), 0);

  return {
    soloCalls: solo.length,
    batchCalls: batches.length,
    total: solo.length + batches.length,
    people: solo.length + inBatches,
  };
}

/**
 * 把分派结果渲染成一句人话，给日志和面板用。
 *
 * @param {object} plan
 * @returns {string}
 */
export function describeDispatch(plan) {
  const cost = estimateDispatchCost(plan);
  if (cost.total === 0) return '本轮无需撰写 NPC 视角正文。';

  const parts = [];
  if (cost.soloCalls > 0) {
    const names = (plan.solo || []).map((m) => m.name).join('、');
    parts.push(`${cost.soloCalls} 人单独写（${names}）`);
  }
  if (cost.batchCalls > 0) {
    const groups = (plan.batches || []).map((b, i) => `第${i + 1}批 ${b.length} 人`);
    parts.push(`${cost.batchCalls} 次合并写（${groups.join('，')}）`);
  }
  parts.push(`共 ${cost.total} 次调用、${cost.people} 人`);

  return parts.join('；') + '。';
}

