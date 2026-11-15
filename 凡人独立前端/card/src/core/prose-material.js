// ============================================================
// NPC 视角正文 · 第 1 件事：资料是否全
//
// 用户定位（2026-10-21）：
//   「散文这里就是最关键的 npc 视角正文，站在每个 npc 的视角写，给全资料，
//     所以最关键的两件事情，资料是否全，怎么写」
//
// 本模块只解决**资料是否全**。写得好不好在 prose-prompt.js。
//
// ------------------------------------------------------------
// 一个 NPC 要写得好，必须拿到五类材料。缺任何一类，写出来就会出问题：
//
//   1. 他是谁        ← 设定集（向量检索）：性格、出身、外貌、称谓
//   2. 他现在什么状态  ← 存档：境界、伤势、所在地、在场与否、是否已死
//   3. 这段时间发生了什么 ← 边界判定的 missing（这才是要补的）
//   4. 正文写了什么    ← 本轮正文（用来避开重复、判断偏离）
//   5. 同一件事还有谁  ← 同事件的其他 [人物:] 标签
//
// 缺 1 → 人物变成工具人，和原著里那个人不是一个人
// 缺 2 → 状态错乱（已经死了还在行动，炼气四层写成筑基）
// 缺 3 → 不知道要写什么，只能瞎编
// 缺 4 → 和正文重复或被正文否定
// 缺 5 → 人际互动编造，出现「原著里这两人没见过面」
//
// ------------------------------------------------------------
// 关键设计：材料**按 NPC 分别组装**，不是全局一份。
//
//   原因：一个事件涉及 5 个人，但每个人「该知道的部分」不同。
//         张铁不知道韩立的小瓶，董萱儿不知道墨大夫的秘密。
//         把所有人的全部资料给每个 NPC，模型会写出上帝视角。
//
//   所以每人一份：他的设定 + 他的状态 + 他卷入的那些 missing 条目。
// ============================================================


/** 一个 NPC 素材包必须凑齐的五类，缺哪类就报哪类 */
import { projectActorProfile } from './character-profile.js';
import {parseTimePoint} from './interval.js';
import {splitProseParagraphs} from './prose-validate.js';

/* ★★★ 2026-11-02 玩家定位的污染源，写在这里供全模块共用：
 *
 *   「玩家的气运天赋又被韩立的npc视角正文写成韩立的了。我自己已经找出问题根因了。
 *     很简单，就是原著补演写npc视角正文的阶段，不能再把玩家的剧情正文当成提示词
 *     资料注入了。原著补演前面的边界判定、进度判定注入正文用来推理可能存在的变异，
 *     这个没问题。但是到具体写npc视角正文阶段，这个剧情正文就会变成误导源和污染源了。」
 *
 * 所以：**玩家主正文原文绝不进写作提示词**。
 * 写作阶段只该知道「已经发生了什么事实」，不该看到玩家怎么叙述的、
 * 更不该看到玩家身上挂着的天赋/法宝/机缘（那些不是这个 NPC 的）。
 *
 * 这个函数负责把「玩家正文」压成「事实摘要」：
 *   ① 只保留判定阶段已经产出的结构化事实（谁·做了什么·结果）
 *   ② 剥离第一人称、剥离玩家专属设定名
 *   ③ 拿不准的一律不写——宁可少给，也不能把污染源带进去
 *
 * 注意：这不是「少给资料」。判定阶段已经把该推理的都推理完了，
 * 写作阶段拿到的是结论，不是原始语料。
 */
export function buildStoryFactDigest(src = {}) {
  const out = [];

  // ① 最高优先级：边界判定已经梳理好的「谁做了什么」。
  //    dossier.pushes 是原著推力的定案，mutated 是被顶掉的，都是结构化结论。
  const dossier = src.dossier && typeof src.dossier === 'object' ? src.dossier : null;
  if (dossier && Array.isArray(dossier.pushes)) {
    for (const p of dossier.pushes) {
      const text = String(p && (p.brief || p.text) || '').trim();
      if (text) out.push('- ' + text);
    }
  }

  // ② 已确认的变异：原本该发生什么、实际变成了什么。
  if (Array.isArray(src.mutated)) {
    for (const m of src.mutated) {
      if (!m || typeof m !== 'object') continue;
      const original = String(m.original || '').trim();
      const actual = String(m.actual || '').trim();
      if (original) out.push('- 本该：' + original + (actual ? '；实际：' + actual : ''));
    }
  }

  // ③ 已覆盖的维度：谁·哪个维度·写到了什么。
  if (Array.isArray(src.covered)) {
    for (const c of src.covered) {
      const text = String(c || '').trim();
      if (text) out.push('- ' + text);
    }
  }

  // ④ 兜底：以上都没有时，才用正文做**极保守**的事实摘要。
  //    只取客观陈述句，剥掉第一人称与对话，绝不整段搬运。
  if (!out.length) {
    const raw = String(src.storyText == null ? '' : src.storyText).trim();
    if (raw) {
      const facts = digestStoryToFacts(raw);
      if (facts.length) out.push(...facts);
    }
  }

  return out.length ? out.join('\n') : '';
}

/**
 * 把玩家正文压成极简事实条目。
 *
 * 原则（宁缺毋滥）：
 *   · 只保留叙述性陈述，丢掉所有对话（引号内容）——对话是最强的视角污染源
 *   · 第一人称「我」替换成中性主语「主角」，避免 NPC 误以为「我」= 自己
 *   · **玩家专属设定（天赋/法宝/机缘名）一律剔除**：
 *     这些名字无法可靠穷举，所以只要一句话里出现「我的X」「脑子里的X」
 *     这类归属表达，就整句丢弃——宁可少一条事实，也不能把污染源带进去。
 *   · 单条过长就截断，不做推断、不做润色
 */
function digestStoryToFacts(raw) {
  const text = String(raw || '');
  const sentences = text
    .replace(/[“"][^”"]*[”"]/g, '')          // 丢掉所有对话
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 120);

  // 归属表达：出现这些说明句子在讲「玩家自己身上挂着什么」，
  // 而那正是把「万界之商」这类玩家专属设定带进 NPC 提示词的入口。
  const OWNSHIP = /我的|我这|脑子里的|身上的|我身上|我这枚|我这件|我的天赋|我的法宝/;

  const out = [];
  for (const s of sentences) {
    if (OWNSHIP.test(s)) continue;                 // ← 关键：整句丢弃
    const neutral = s.replace(/^我(?![们])/, '主角').replace(/(?<!们)我/g, '主角');
    if (!neutral.trim()) continue;
    out.push('- ' + neutral.slice(0, 100));
    if (out.length >= 12) break;   // 上限：够知道发生了什么即可
  }
  return out;
}


/** 只裁剪明确日期，不用时间比例猜事件进度或判断人物实际做了什么。 */
/** 只裁剪明确日期，不用时间比例猜事件进度或判断人物实际做了什么。 */
export function buildProseEventSegments(events,range={}) {  const lower=parseTimePoint(range?.start),upper=parseTimePoint(range?.end);
  const eventSegments=(Array.isArray(events)?events:[]).map((event,index)=>{
    let start=String(event.time || event.time_start || ''),end=String(event.timeEnd || event.time_end || start);
    let a=parseTimePoint(start),b=parseTimePoint(end);
    if(a===null)return null;
    if(b===null){b=a;end=start;}
    if(b<a){[a,b]=[b,a];[start,end]=[end,start];}
    if((upper!==null && a>upper)||(lower!==null && b<lower))return null;
    return {code:String(event.code||''),title:String(event.title||''),start:lower!==null&&a<lower?range.start:start,
      end:upper!==null&&(b>upper||event.pointerInProgress)?range.end:end,
      ongoing:!!event.pointerInProgress||upper!==null&&b>upper,
      material:String(event.materialText || event.text || event.brief || event.original || ''),order:a,index};
  }).filter(Boolean).sort((a,b)=>a.order-b.order||a.index-b.index).map(({order,index,...event})=>event);
  /* ★★★ 2026-11-02 玩家定了「空白期也要成段」的规则（原话）：
   *
   *   「还有一件事情不能遗漏，我们刚才只讨论了这个人物年表涉及的经历怎么写，
   *     那么空白期呢？比如说这一轮经历三个年表，这个人物在第一个年表和第三个年表
   *     出场有细分，这两段我们写了没问题。第二个年表经过的时间就是他自己的故事，
   *     这个刚才我们没考虑到。我的建议就是也当作一段，就是前后年表戏份之间的
   *     空白原创故事，也是当作一段处理，这个也是为什么前面我不支持用年表编号
   *     写生平经历的原因，只能用时间记载」
   *
   *   「这里既然E-002期间，他没戏份，那么只需要一段就行了，只要是前后细分的
   *     中间地带，我们只写一段。原因很简单，这段对于原著一定不是很重要，
   *     这种情况越多，这个角色越边缘，那么我们给的预算也要越少，
   *     等于是一种自然筛选方式了」
   *
   * 段落规则是「按本人出场切」，不是「按年表事件切」：
   *   空白 → 年表戏份 → 空白 → 年表戏份 → 空白
   * 他两次出场之间不管夹了几个他不参与的年表事件，全部合并成**一段**空白。
   * 相邻空白天然不会出现（中间一定隔着一次出场），所以不需要额外合并步骤。
   *
   * 为什么重要：
   *   ① 一段正文 ↔ 一条生平摘要，段落数决定摘要条数，不能碎；
   *   ② proseMaxChars = base × 段数，段数少 → 预算少 → 边缘角色自然写得短，
   *      这就是玩家要的「自然筛选」，不需要另写规则。
   *
   * 空白段标记 gap:true，提示词据此要求「自主原创、不编造原著事件、不凭空升级」。
   */
  const gapSegments=[];
  /* ★★★ 2026-11-02 复盘发现的真 bug：
   * 完全没有原著事件的人，也会被这里造出一个「覆盖整轮」的空白段，
   * 于是 hasTask 变成 true，他被当成原著补演对象拉进名单，taskKind 还是 canon。
   * 但空白期是「前后年表戏份之间的」中间地带 —— **先有原著戏份，才谈得上空白期**。
   * 一次都没出场的人没有空白期，不该因此被拉进补演名单。
   */
  const hasRealEvent = eventSegments.some((seg)=>seg && !seg.gap);
  if(hasRealEvent && (lower!==null || upper!==null)){
    // 游标同时记住「时间数值」和「对应的原始文本」——
    // parseTimePoint 只返回数字，不含原文，所以文本要自己带着走。
    let cursorAt=lower,cursorText=String(range.start||'').trim();
    for(const seg of eventSegments){
      const a=parseTimePoint(seg.start),b=parseTimePoint(seg.end);
      if(a===null)continue;
      if(cursorAt!==null && a>cursorAt){
        const gapStart=cursorText,gapEnd=String(seg.start||'').trim();
        if(gapStart && gapEnd && gapStart!==gapEnd){
          gapSegments.push({code:'',title:'',start:gapStart,end:gapEnd,gap:true,ongoing:false,material:'',order:cursorAt});
        }
      }
      if(b!==null && (cursorAt===null || b>cursorAt)){cursorAt=b;cursorText=String(seg.end||'').trim();}
    }
    if(cursorAt!==null && upper!==null && upper>cursorAt){
      const gapStart=cursorText,gapEnd=String(range.end||'').trim();
      if(gapStart && gapEnd && gapStart!==gapEnd){
        gapSegments.push({code:'',title:'',start:gapStart,end:gapEnd,gap:true,ongoing:false,material:'',order:cursorAt});
      }
    }
  }
  return [...eventSegments,...gapSegments].sort((a,b)=>{
    const ta=parseTimePoint(a.start),tb=parseTimePoint(b.start);
    if(ta!==null&&tb!==null)return ta-tb;
    if(ta!==null)return -1;
    if(tb!==null)return 1;
    return 0;
  });
}

export const CE_PROSE_MATERIAL_PARTS = {
  identity: '人物设定',
  state: '当前状态',
  task: '要补的内容',
  goal: '自主目标',
  story: '本轮正文',
  others: '同场人物',
  dossier: '原著推力与定案',
};

/**
 * 从 missing 条目里找出涉及某 NPC 的那些。
 *
 * 匹配规则（由宽到严，任一命中即算）：
 *   1. 条目里出现该人名或别名（「韩立离开家乡」）
 *   2. 条目里出现该人名的**任一片段**——中文人名常被省略主语
 *      或只用名不用姓（「途中结识张铁」里「张铁」是全名，没问题；
 *      但「二人同行」这种没名字的条目按下面的规则处理）
 *
 * 之所以要宽松：missing 是年表的表述，措辞不等于「全名 + 动作」。
 * 漏分给本人的条目 = 该补的没补，比多分给一个人严重得多。
 *
 * @param {string[]} missing
 * @param {string} name
 * @param {object} [options]
 * @param {string[]} [options.aliases]
 * @param {string[]} [options.coActors] 同批出现的其他人物（用于判断「二人」这类）
 * @returns {string[]}
 */
export function missingForCharacter(missing, name, options = {}) {
  const target = String(name == null ? '' : name).trim();
  if (!target) return [];

  const keys = [target, ...(Array.isArray(options.aliases) ? options.aliases : [])]
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean);

  const list = Array.isArray(missing) ? missing : [];
  return list.filter((item) => {
    const text = String(item == null ? '' : item);
    if (!text) return false;
    return keys.some((k) => text.includes(k));
  });
}

/**
 * 找出「没有被任何候选人物认领」的 missing 条目。
 *
 * 这类条目是最危险的：边界判定说要补，但没人负责写，
 * 结果就是**静默漏补**。调用方必须处理（通常是并入世界块或强制指派）。
 *
 * @param {string[]} missing
 * @param {string[]} candidates
 * @param {object} [lookupOptions] 按人名给的 { aliases }
 * @returns {string[]}
 */
export function findUnownedMissing(missing, candidates, lookupOptions = {}, tasksByActor) {
  const list = Array.isArray(missing) ? missing : [];
  const names = Array.isArray(candidates) ? candidates : [];
  if(tasksByActor && typeof tasksByActor==='object'){
    const owned=new Set(names.flatMap(name=>(tasksByActor[name] || []).map(task=>name+'：'+task)));
    return list.filter(task=>!owned.has(task));
  }

  return list.filter((item) => {
    const text = String(item == null ? '' : item);
    if (!text) return false;
    return !names.some((n) => {
      const opts = lookupOptions[n] || {};
      const keys = [n, ...(Array.isArray(opts.aliases) ? opts.aliases : [])]
        .map((s) => String(s == null ? '' : s).trim())
        .filter(Boolean);
      return keys.some((k) => text.includes(k));
    });
  });
}

/**
 * 在场人物渲染成一段短文字。
 *
 * @param {Array} onScene
 * @returns {string}
 */
export function renderOnSceneText(onScene) {
  const list = Array.isArray(onScene) ? onScene : [];
  if (list.length === 0) return '';
  const lines = [];
  for (const p of list) {
    const name = String(p && p.name || '').trim();
    if (!name) continue;
    const st = p && p.state && typeof p.state === 'object' ? p.state : null;
    const bits = [];
    if (st) {
      if (st.dead === true || st.status === '已故') bits.push('已故');
      else {
        if (st.cultivation) bits.push(`境界${st.cultivation}`);
        if (st.identity) bits.push(st.identity);
        if (st.relation) bits.push(`关系${st.relation}`);
      }
    }
    lines.push(`· ${name}${bits.length ? `（${bits.join('，')}）` : ''}`);
  }
  return lines.join('\n');
}

/**
 * 组装单个 NPC 的素材包。
 *
 * 这是「资料是否全」的落地：**material 齐不齐是显式的**，
 * 缺什么会在 `missingParts` 里列出来，调用方可以直接决定
 * 「资料不全就不写」还是「降级写但标记」。
 *
 * @param {object} input
 * @param {string} input.name NPC 名
 * @param {string[]} [input.aliases]
 * @param {object} [input.profile] 设定集检索结果（性格/出身/外貌等）
 * @param {object} [input.state] 存档里的当前状态
 * @param {object} [input.goal] 自主目标栈 { ambition, progress, next, ties }
 * @param {string[]} [input.missing] 边界判定的未覆盖条目
 * @param {Array} [input.mutated] 边界判定的被替代条目 { original, actual }
 * @param {string[]} [input.taskCodes] 本块覆盖的事件号
 * @param {string} [input.storyText] 本轮正文
 * @param {string[]} [input.coActors] 同事件涉及的其他人物
 * @param {object} [input.timeRange] { start, end }
 * @param {string} [input.background] 全局背景（世界规则、世界大事等），每个 NPC 都要知道
 * @param {boolean} [input.isPlayer] 是否玩家角色（玩家不写 NPC 视角）
 * @returns {{
 *   name:string, material:object, missingParts:string[],
 *   complete:boolean, hasTask:boolean
 * }}
 */
/**
 * 找出「上一回合最后一段」的原文，供本轮续写。
 *
 * 玩家 2026-11-02：「只要把上一轮最后一段的内容原样发给模型。模型肯定能照抄续写啊，
 * 出问题那证明你没有把材料给到位啊，而不是模型的问题。」
 *
 * 什么情况下需要续写：
 *   本轮第一个事件段是 ongoing（跨回合未完成），或者它的起点早于本轮区间起点，
 *   说明这段故事是从上一回合延续过来的 —— 上一回合已经写过前半截。
 *
 * 取哪一段：上一回合该人物 block 的**最后一段**。
 * 因为按规则「未完成事件永远排在最后」，最后一段就是那段跨回合的故事。
 *
 * @param {object} src buildCharacterMaterial 的入参
 * @param {string} name 人物名
 * @param {Array} eventSegments 本轮事件段
 * @returns {{text:string, coveredTo:string, label:string}|null}
 */
function resolveContinuingParagraph(src, name, eventSegments) {
  const segments = Array.isArray(eventSegments) ? eventSegments : [];
  if (!segments.length) return null;
  const first = segments[0];
  /* 判断「这段是不是从上一回合延续过来的」。
   *
   * 注意 ongoing 的含义：它是「事件结束时间超出本轮终点」，
   * 也就是「本轮结束时还没完」，**不是**「从上一回合延续」。
   * 用 ongoing 判断会漏掉最典型的情况：上一回合写到一半、本轮把它写完
   * —— 这时事件在本轮内结束了，ongoing 是 false，但它明明需要续写。
   *
   * 真正可靠的判据是「起点早于或等于本轮区间起点」：
   * 本轮的起点就是上一回合的终点（worldTime），
   * 事件若在起点之前就开始了，说明上一回合已经写过它的前半截。
   */
  const rangeStart = parseTimePoint(src && src.timeRange && src.timeRange.start);
  const firstStart = parseTimePoint(first && first.start);
  /* 判据：这个事件的**起点**落在本轮区间起点之前或之上，
   * 说明它在上一回合就已经开始了，上一回合写过它的前半截。
   *
   * 注意不能用 first.start 直接比 —— buildProseEventSegments 会把
   * 超出本轮区间的段裁掉、并把跨界的起点夹到 range.start，
   * 所以「被夹过的 start」永远等于 range.start，无法区分。
   * 必须回到原始事件列表里看它真实的起点。
   */
  const rawFirst = (Array.isArray(src && src.events) ? src.events : [])[0] || {};
  const rawStart = parseTimePoint(rawFirst.time || rawFirst.time_start || '');
  const continuing = !!(
    first && (
      first.continuedFromPrevious === true ||
      (rangeStart !== null && rawStart !== null && rawStart < rangeStart) ||
      // 原始起点恰好等于本轮起点：这是最典型的「上一回合写到这一刻」
      (rangeStart !== null && rawStart !== null && rawStart === rangeStart)
    )
  );
  if (!continuing) return null;

  // 上一回合该人物的 block：优先用调用方显式给的，其次从 previousProse 里找。
  const prevList = Array.isArray(src.previousProse) ? src.previousProse : [];
  const prevBlock = prevList.find((b) => b && String(b.name || '').trim() === name);
  if (!prevBlock) return null;

  const paragraphs = splitProseParagraphs(prevBlock);
  if (!paragraphs.length) return null;
  const last = paragraphs[paragraphs.length - 1];
  const text = String(last.body || '').trim();
  if (!text) return null;

  /* ★★★ 2026-11-02 玩家补充（原话）：
   *   「不止是原文，还有更重要的时间区间标题，这样模型才知道这是在按照时间断点
   *     进行续写。」
   *
   * 只给正文是不够的：模型看到一段文字，但不知道它覆盖的是哪段时间，
   * 续写起点就模糊（可能以为要从头写，也可能把旧时段又写一遍）。
   * 所以标题必须原样带上 —— 标题里的区间就是「时间断点」，
   * 模型据此知道：旧段写到哪个时刻，本轮从那里接着往后写。
   */
  const label = String(last.label || '').trim();
  // 拆出旧段的「起点 / 终点」两个时间点。
  const labelParts = label.split(/[—–~～]/).map((x) => x.trim()).filter(Boolean);
  const fromTime = labelParts.length ? labelParts[0] : label;
  const toTime = labelParts.length > 1 ? labelParts[labelParts.length - 1] : label;
  // 地点：'0010年04月15日@七玄门' 里 @ 之后的部分。
  const atIndex = toTime.indexOf('@');
  const place = atIndex >= 0 ? toTime.slice(atIndex + 1) : '';
  const cleanTime = (t) => {
    const at = String(t || '').indexOf('@');
    return at >= 0 ? String(t).slice(0, at) : String(t || '');
  };

  return {
    text,
    label,
    // 旧段落的时间断点：起点、终点（去掉 @地点，只留时间）。
    from: cleanTime(fromTime).trim(),
    to: cleanTime(toTime).trim(),
    place: place.trim(),
    // 兼容旧字段：coveredTo = 旧段落写到哪。
    coveredTo: cleanTime(toTime).trim() || label,
  };
}

export function buildCharacterMaterial(input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name == null ? '' : src.name).trim();

  const aliases = Array.isArray(src.aliases) ? src.aliases : [];
  const taskItems = Array.isArray(src.assignedTasks) ? src.assignedTasks.slice() : missingForCharacter(src.missing, name, { aliases });
  const eventSegments = buildProseEventSegments(src.events || src.dossier?.pushes,src.timeRange);
  const parallel = eventSegments.length === 0 && taskItems.length === 0 && src.allowParallel === true && src.isPlayer !== true
    && !/已故|死亡|已死/.test(String(src.state && src.state.status || ''));
  // 自主生活只有显式选中的、已有真实身份和目标的非玩家才可进入。
  // 它不占用原著事件号，也不把长期目标伪装成这一轮必然完成的事实。
  const autonomous = !parallel && taskItems.length === 0 && canWriteAutonomous(src);
  const autonomousGoal = autonomous ? meaningfulGoal(src.goal) : '';
  if (autonomous) taskItems.push(autonomousGoal);

  const material = {
    identity: projectActorProfile(src.profile && typeof src.profile === 'object' ? src.profile : null),
    state: projectActorProfile(src.state && typeof src.state === 'object' ? src.state : null),
    // 自主目标栈：写作起点倒置的前提。缺它就会写成「主角做了什么，于是我……」
    goal: src.goal && typeof src.goal === 'object' ? src.goal : null,
    task: taskItems,
    eventSegments,
    /* ★★★ 2026-11-02 玩家（原话）：
     *   「只要把上一轮最后一段的内容原样发给模型。模型肯定能照抄续写啊，
     *     出问题那证明你没有把材料给到位啊，而不是模型的问题，
     *     哪个模型连抄写都不会呢？」
     *
     * 所以这里必须把**上一回合最后一段的原文**原样送进去，模型才有东西可接。
     * 之前只在提示词里写了「这是续写」，却没把旧段落塞进来，等于让它凭空猜。
     *
     * 只取「跨回合未完成事件」对应的那一段：
     *   本轮 eventSegments 里第一个事件若 ongoing（或 start 早于本轮起点），
     *   说明它从上一回合延续过来，那上一回合 block 的最后一段就是它的前文。
     */
    continuingParagraph: resolveContinuingParagraph(src, name, eventSegments),
    provisionalHistory: Array.isArray(src.provisionalHistory) ? src.provisionalHistory : [],
    savedProgress: (Array.isArray(src.savedProgress)?src.savedProgress:[]).filter(row=>eventSegments.some(event=>event.code===row.eventId)),
    taskKind: parallel ? 'parallel' : autonomous ? 'autonomous' : 'canon',
    parallel,
    autonomous,
    autonomousGoal,
    // 被替代的部分：要明确告诉写作者「不要按原样补」
    mutated: (Array.isArray(src.mutated) ? src.mutated : [])
      .filter((x) => x && (!x.name || x.name===name) && String(x.original || '').trim()),
    // 边界判定梳理出来的完整档案：推力原文 + 定案 + 被顶掉的。
    //
    // 用户 2026-10-21：
    //   「我们把在边界判定这里梳理的资料都整理给npc视角正文ai，
    //     由他根据逻辑推演，根据这个npc的性格，来写他可能会做的事情，
    //     而这里的事实，作为最终定案的本轮原著补演结果」
    //
    // 蝴蝶效应就在这一层解决——不用另建传播机制。
    dossier: src.dossier && typeof src.dossier === 'object' ? {...src.dossier,stateNow:projectActorProfile(src.dossier.stateNow)} : null,
    taskCodes: (autonomous ? [`LIFE-${String(src.id).trim().toUpperCase()}`] : (Array.isArray(src.taskCodes) ? src.taskCodes : []))
      .map((c) => String(c == null ? '' : c).trim())
      .filter(Boolean),
    /* ★★★ 2026-11-02 玩家定位的污染源（原话）：
     *
     *   「玩家的气运天赋又被韩立的npc视角正文写成韩立的了。我自己已经找出问题根因了。
     *     很简单，就是原著补演写npc视角正文的阶段，不能再把玩家的剧情正文当成提示词
     *     资料注入了。原著补演前面的边界判定、进度判定注入正文用来推理可能存在的变异，
     *     这个没问题。但是到具体写npc视角正文阶段，这个剧情正文就会变成误导源和污染源了。
     *     所以一方面需要在写正文阶段禁止再把玩家剧情正文当作提示词内容注入，另一方面，
     *     需要前面的边界判定和人物补演进度判断阶段先做好变异的判断和写好大纲，
     *     等到写npc视角正文阶段就按照年表材料和其他材料以及大纲来写。」
     *
     * 病根就在这里：原来 `story: src.storyText` 把**玩家主正文原文**原样塞进写作材料，
     * 于是提示词里出现大段第一人称「我」和玩家专属设定（气运天赋「万界之商」等）。
     * 模型写韩立时看到「我有个万界之商」，就当成韩立自己也有——正文被污染。
     *
     * 判断依据（边界判定/进度判定）与写作素材是两回事：
     *   · 判定阶段：需要原文才能推理「可能存在的变异」→ 那边继续用 src.storyText，不动。
     *   · 写作阶段：只该知道「已经发生了什么事实」，不需要知道玩家是怎么叙述的。
     *
     * 所以这里把两者拆开：
     *   story    → 只放**结构化事实摘要**（谁·做了什么·结果），写作时使用
     *   storyRaw → 原文保留，仅供确实需要逐字对照的内部逻辑（如交汇判定），不进提示词
     */
    story: buildStoryFactDigest(src),
    storyRaw: String(src.storyText == null ? '' : src.storyText).trim(),
    others: (Array.isArray(src.coActors) ? src.coActors : [])
      .map((n) => String(n == null ? '' : n).trim())
      .filter((n) => n && n !== name),
    // 全局背景：世界规则、世界大事、任务、地理。
    // 这些不属于任何单独人物，但每个人都活在里面。
    background: String(src.background == null ? '' : src.background).trim(),
    // 三档专用：正文已经写过的部分。写之前先让它看一眼，别写重。
    covered: Array.isArray(src.covered) ? src.covered.slice() : [],
    timeRange: src.timeRange && typeof src.timeRange === 'object'
      ? {
        start: String(src.timeRange.start == null ? '' : src.timeRange.start),
        end: String(src.timeRange.end == null ? '' : src.timeRange.end),
      }
      : { start: '', end: '' },
    isPlayer: src.isPlayer === true,
  };

  // 硬缺：有对象但里面是空的，等于没有。
  //
  // 这几种情况实际很常见：
  //   profile = { text: '' }       设定集没查到，但宿主给了个空壳
  //   state = { cultivation: '' }  人物在档，但境界没填
  // 如果只判断「对象存在」，就会形成「审计显示资料完整，写出来却全是编的」，
  // 比直接报缺料更难发现。所以这里往里面看一眼。
  const hasContent = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return false;
    return keys.some((k) => String(obj[k] == null ? '' : obj[k]).trim() !== '');
  };

  const identityFilled = hasContent(material.identity,
    ['text', 'personality', 'name', 'deeds']);
  const stateFilled = hasContent(material.state,
    ['cultivation', 'identity', 'status', 'spiritRoot', 'constitution', 'relation', 'motive']);

  const missingParts = [];
  if (!material.identity) {
    missingParts.push(CE_PROSE_MATERIAL_PARTS.identity);
  } else if (!identityFilled) {
    // 空壳：对象在，但内容全空
    missingParts.push(CE_PROSE_MATERIAL_PARTS.identity + '（空壳）');
  }

  if (!material.state) {
    missingParts.push(CE_PROSE_MATERIAL_PARTS.state);
  } else if (!stateFilled) {
    missingParts.push(CE_PROSE_MATERIAL_PARTS.state + '（空壳）');
  }

  if (material.task.length === 0 && !parallel) missingParts.push(CE_PROSE_MATERIAL_PARTS.task);
  // 自主目标栈缺失不阻止写作，但会显著拉低质量，单独标出来
  if (!material.goal) missingParts.push(CE_PROSE_MATERIAL_PARTS.goal);

  return {
    name,
    aliases: aliases.slice(),
    // 稳定 ID：配角群像要求模型按 id 回填，没有它就是让模型瞎填。
    // 用序号而不是名字，是因为名字可能重名、也可能被玩家改过。
    id: String(src.id == null ? '' : src.id).trim(),
    material,
    missingParts,
    // 只有「硬缺」才算不完整；goal 缺失属于软缺，单独看 missingParts
    complete: missingParts.length === 0,
    // 档案有没有到：这决定这次是「按原著推演」还是「凭空发挥」。
    //
    // 不并进 missingParts——档案是边界判定那条链路才会产出的东西，
    // 脱离那条链路单独组装素材（单测、兜底路径）本来就没有。
    // 并进去会让「完整」这个字段失去意义，所以单独标。
    hasDossier: Boolean(material.dossier),
    hasHardGap: !material.identity || !material.state || (material.task.length === 0 && !parallel),
    // 没有要补的内容 → 这个 NPC 本轮不必写
    hasTask: material.task.length > 0 || parallel || eventSegments.length > 0,
  };
}

function meaningfulGoal(goal) {
  if (!goal || typeof goal !== 'object') return '';
  for (const value of [goal.next, goal.ambition]) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text && !/^(无|暂无|没有|未知|待定|待补充|未设置|不详|none|null|undefined)[。.!！]?$/i.test(text)) return text;
  }
  return '';
}

function canWriteAutonomous(src) {
  const id = String(src.id == null ? '' : src.id).trim();
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  return src.allowAutonomous === true
    && src.isPlayer !== true && id.toUpperCase() !== 'B1'
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
    && state.dead !== true && !/(已故|死亡|已死)/.test(String(state.status || ''))
    && Boolean(meaningfulGoal(src.goal));
}

/**
 * 把天花板并进人物档案。
 *
 * 为什么挂进 dossier 而不另开字段：
 * 散文读档案是一口气读的——下限（必成事实）和上限（天花板）
 * 必须挨着出现，中间隔几千字它就只记得一个。
 *
 * @param {object|null} dossier
 * @param {object|null} ceiling { text, when, title }
 * @returns {object|null}
 */
export function mergeCeiling(dossier, ceiling) {
  const d = dossier && typeof dossier === 'object' ? { ...dossier } : null;
  const text = ceiling && typeof ceiling.text === 'string' ? ceiling.text : '';
  if (!text) return d;
  if (!d) return { ceiling: text };
  d.ceiling = text;
  return d;
}

/**
 * 批量组装：把 missing 条目分给涉及的每个人。
 *
 * @param {object} input
 * @param {string[]} input.missing
 * @param {string[]} input.candidates 候选 NPC 名（通常来自年表 [人物:] 标签并集）
 * @param {object} input.lookup 按人名查 { profile, state, aliases } 的函数或对象
 * @param {string} [input.storyText]
 * @param {object} [input.timeRange]
 * @param {string} [input.background] 全局背景（世界规则、世界大事等）
 * @param {object} [input.dossiers] name -> 边界判定整理的档案（推力原文/定案/被顶掉的）
 * @param {object} [input.ceilings] name -> 天花板材料（下一处原著约束）
 * @param {boolean} [input.allowAutonomous=false] 显式允许候选人物有限自主生活
 * @param {string[]} [input.autonomousCandidates] 自主候选名字；已在 candidates 中的人也可用真实 ID 选中。
 *   不传时只允许当前 candidates；传空数组时不选任何人。不会遍历 lookup 扩张全世界。
 * @returns {Array<ReturnType<typeof buildCharacterMaterial>>}
 */
export function buildAllCharacterMaterials(input) {
  const src = input && typeof input === 'object' ? input : {};
  const missing = Array.isArray(src.missing) ? src.missing : [];
  const candidates = Array.isArray(src.candidates) ? src.candidates : [];
  const autonomousCandidates = src.allowAutonomous === true
    ? (Array.isArray(src.autonomousCandidates) ? src.autonomousCandidates : candidates)
    : [];
  const autonomousSelected = new Set(autonomousCandidates.map(n => String(n == null ? '' : n).trim()).filter(Boolean));
  const selectedNames = [...new Set([...candidates, ...autonomousCandidates].map(n => String(n == null ? '' : n).trim()).filter(Boolean))];

  const lookup = typeof src.lookup === 'function'
    ? src.lookup
    : (name) => (src.lookup && src.lookup[name]) || {};
  const knownOriginal = new Set([...(src.knownOriginalNames || []),...candidates]);
  const mentioned = new Set(src.excludedNames || []); // 仅消费边界AI明确判定的正文人物，不再二次用字串猜测。

  const out = [];
  let seq = 0;
  for (const rawName of selectedNames) {
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name) continue;

    const info = lookup(name) || {};
    if (src.requireOriginalAutonomous === true && (!knownOriginal.has(name) || mentioned.has(name))) continue;
    seq += 1;
    const mat = buildCharacterMaterial({
      name,
      // 稳定 ID：配角群像要求模型按 id 回填，没有它模型只能瞎填。
      // 用 C1/C2… 序号，既短又不含中文，模型不易抄错。
      id: String(info.id || `C${seq}`),
      aliases: info.aliases,
      profile: info.profile,
      state: info.state,
      goal: info.goal,
      allowParallel: src.allowParallel === true && candidates.includes(name),
      // 不接受下方自动补的序号当作自主生活的身份凭据。
      allowAutonomous: src.allowAutonomous === true && Boolean(info.id)
        && (autonomousSelected.has(name) || autonomousSelected.has(String(info.id))),
      missing,
      assignedTasks: src.tasksByActor && typeof src.tasksByActor==='object' ? (src.tasksByActor[name] || []).map(task=>name+'：'+task) : undefined,
      mutated: src.mutated,
      events: src.eventsByActor?.[name],
      /* 2026-11-02 复盘：resolveContinuingParagraph 读的是 previousProse，
       * 但这里从来没传过，导致续写材料永远为空——测试用自己的 fixture 骗过了自己。
       * 这里把调用方的上一回合正文透传进来。 */
      previousProse: src.previousProse || src.previousBlocks,
      provisionalHistory: src.provisionalHistory?.[name],
      savedProgress: src.savedProgress,
      // 边界判定给这个人整理的档案（推力原文 + 定案 + 被顶掉的）
      // 天花板挂在这里，散文才有东西可守——它管的是「别写太快」
      dossier: mergeCeiling(
        src.dossiers && src.dossiers[name] ? src.dossiers[name] : null,
        src.ceilings && src.ceilings[name] ? src.ceilings[name] : null,
      ),
      taskCodes: info.taskCodes || src.taskCodes,
      storyText: src.storyText,
      coActors: candidates,
      background: src.background,
      covered: src.covered,
      timeRange: src.timeRange,
      isPlayer: info.isPlayer === true,
    });

    // 玩家本人不写 NPC 视角；没有要补内容的 NPC 也不写
    if (mat.material.isPlayer) continue;
    if (!mat.hasTask) continue;

    out.push(mat);
  }
  return out;
}

/**
 * 检查一批素材包的整体完整度，给编排器决定要不要继续。
 *
 * @param {Array<ReturnType<typeof buildCharacterMaterial>>} materials
 * @returns {{total:number, complete:number, incomplete:Array<{name:string, missingParts:string[]}>}}
 */
export function auditMaterials(materials) {
  const list = Array.isArray(materials) ? materials : [];
  const incomplete = list
    .filter((m) => !m.complete)
    .map((m) => ({ name: m.name, missingParts: m.missingParts }));

  return {
    total: list.length,
    complete: list.length - incomplete.length,
    incomplete,
  };
}
