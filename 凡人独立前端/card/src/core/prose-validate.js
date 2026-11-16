// ============================================================
// NPC 视角正文 · 稳定性四道防线中的「校验」与「记账」
//
// 依据：总设计 §4.6
//
//   三种不稳，只有一种是新风险：
//     漏写  —— 散文写了心情，没写他拿到了筑基丹。这条事实永远不进变量，且**静默**
//     写歪  —— 写到了但细节错。现有四阶段本来就在防
//     编造  —— 写了原著没有的事。现有四阶段本来就在防
//
//   **真正的新风险是漏写。** 所以四道防线全是为了抓漏写：
//     ① 写之前给清单        —— 见 prose-prompt.js（把 missing 列给它）
//     ② 散文带覆盖声明       —— @@已写 / @@未写
//     ③ 代码校验            —— 本文件
//     ④ 失败的去处          —— 本文件
//
// ------------------------------------------------------------
// 校验分三层（总设计 §4.6.4）：
//
//   ① 完整性校验（免费）  —— 纯集合运算，零成本，能挡掉绝大部分漏写
//   ② 存在性粗校验（便宜）—— 声明写了的东西，正文里得真能找到
//   ③ **不校验具体细节**  —— 「是不是真的写了一枚而不是两枚」是四阶段的活
//
//   校验层不要越权。这是明确写着的。
//
// ------------------------------------------------------------
// 失败处置（总设计 §4.6.5）：
//
//   **重试只 1 次。** 重写更可能变好，但没必要为一句话反复烧钱。
//   还不合格 → 记账，不勉强落地。
//   本轮照常落地合格的块（不能因为一个块失败就整轮作废）。
// ============================================================

/** 散文三态 */
export const CE_PROSE_STATUS = {
  canon: '照原著',
  mutated: '变异',
  blocked: '阻断',
};

/** 稳定校验通道 */
export const CE_CHECK_TYPES = {
  parse: '骨架解析',
  coverage: '覆盖完整性',
  existence: '存在性',
  body: '正文存在',
};

/** 允许的重试次数：只 1 次（用户定，不是我的选择） */
export const CE_MAX_RETRY = 1;

/**
 * 解析一块散文的骨架。
 *
 * 骨架形如：
 *   ## E-045,E-046 | 韩立 | 照原著
 *   @@已写: 获得筑基丹 / 前往太南
 *   @@未写: 无
 *   @@经历: [0013年05月@神手谷]独自去了神手谷，没等到人
 *   （正文）
 *
 * @param {string} raw
 * @returns {{
 *   eventIds:string[], name:string, status:string, reason:string,
 *   declaredWritten:string[], declaredUnwritten:string[],
 *   biographyLine:string, body:string
 * }}
 */
export function parseProseBlock(raw) {
  const text = String(raw == null ? '' : raw).trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const lines = text.split(/\r?\n/);
  let header = '';
  let written = [];
  let unwritten = [];
  let biographyLine = '';
  let handoffBiographyLine = '';
  let biographySection = '';
  const bodyLines = [];
  let seenBody = false;

  for (const line of lines) {
    const t = line.trim();

    if (!seenBody && /^##\s+/.test(t)) {
      header = t.replace(/^##\s+/, '');
      continue;
    }
    if (!seenBody && /^@@\s*已写\s*[:：]/.test(t)) {
      written = splitItems(t.replace(/^@@\s*已写\s*[:：]/, ''));
      continue;
    }
    if (!seenBody && /^@@\s*未写\s*[:：]/.test(t)) {
      unwritten = splitItems(t.replace(/^@@\s*未写\s*[:：]/, ''));
      continue;
    }
    // 本轮这一段的经历，一行，会拼进第 35 列「生平经历」。
    //
    // 为什么让散文自己写这一行：
    //   生平旧账管的是**正文之前**那几个月（存档 + 原著推力）；
    //   正文那一刻发生了什么，只有散文知道。
    //   代码去正文里抠这个，抠不准。
    if (!seenBody && /^@@\s*经历\s*[:：]/.test(t)) {
      biographyLine = [biographyLine,t.replace(/^@@\s*经历\s*[:：]/, '').trim()].filter(Boolean).join('\n');
      biographySection = 'biography';
      continue;
    }
    if(!seenBody && /^@@\s*交汇经历\s*[:：]/.test(t)){
      handoffBiographyLine=[handoffBiographyLine,t.replace(/^@@\s*交汇经历\s*[:：]/,'').trim()].filter(Boolean).join('\n');biographySection='handoff';continue;
    }
    // A single explicit marker may introduce several dated summary lines.
    // Only absorb dated, nonempty entries before prose starts; never manufacture
    // summaries or move arbitrary narration to bypass diary validation.
    if(!seenBody && biographySection && /^\[\d+(?:年|\.)[^\]\r\n]*\]\s*\S/.test(t)){
      if(biographySection==='handoff')handoffBiographyLine=[handoffBiographyLine,t].filter(Boolean).join('\n');
      else biographyLine=[biographyLine,t].filter(Boolean).join('\n');
      continue;
    }
    if (!seenBody && !t) continue;

    seenBody = true;
    bodyLines.push(line);
  }

  const parts = header.split('|').map((p) => p.trim());
  // 事件号可以用逗号或顿号分隔
  const eventIds = splitItems(parts[0] || '', /[\s,，、]+/)
    .map((s) => s.toUpperCase());
  const name = parts[1] || '';
  const status = parts[2] || CE_PROSE_STATUS.canon;

  let reason = '';
  for (let i = 3; i < parts.length; i += 1) {
    if (/^依据\s*[:：]/.test(parts[i])) {
      reason = parts[i].replace(/^依据\s*[:：]/, '').trim();
    }
  }

  return {
    eventIds,
    taskKind: eventIds.length > 0 && eventIds.every(id => /^LIFE-[A-Z0-9][A-Z0-9_-]*$/.test(id)) ? 'autonomous' : 'canon',
    name,
    status,
    reason,
    declaredWritten: written,
    declaredUnwritten: unwritten,
    ...splitHandoffStory(bodyLines.join('\n').trim(),biographyLine,handoffBiographyLine),
  };
}

/** 交汇是明确协议，绝不靠最后一个自然段猜。 */
/**
 * 把一篇人物正文拆成「段落」，每段自带对应的生平摘要条目。
 *
 * ★★★ 2026-11-02 玩家定的规则（原话）：
 *   「我没说删掉上一篇啊，我的意思是删掉最后一个段落的故事，因为我们的规则是
 *     覆盖重写啊。所以这才是分段的意义，可拆卸，可标记单独段落啊。」
 *
 * 分段的意义就在这里：跨回合未完成的年表事件只占**最后一段**，
 * 新一轮把它覆盖重写之后，只需要把上一回合那一段（连同它对应的一条生平摘要）
 * 换掉，前面的段落原样保留 —— 已完成的事件不会被连带删除。
 *
 * 正文格式（由 renderDiaryContract 约束）：
 *   ### [0010年04月05日@五里沟]
 *   正文……
 *   ### [0010年04月09日—0010年04月10日@彩霞山]
 *   正文……
 * 生平摘要按行给，一行对应一段，顺序一致（validateProseBlock 已强制这一点）。
 *
 * @param {object} block {body, biographyLine}
 * @returns {Array<{label:string, heading:string, body:string, biography:string}>}
 */
export function splitProseParagraphs(block){
  const src=block && typeof block==='object'?block:{};
  const body=String(src.body==null?'':src.body);
  const entries=String(src.biographyLine==null?'':src.biographyLine).split(/\r?\n/).filter(line=>line.trim());
  const marks=[...body.matchAll(/^###\s+\[([^\]\r\n]+)\]\s*$/gm)];
  if(!marks.length)return [];
  return marks.map((mark,index)=>{
    const from=mark.index+mark[0].length;
    const to=index+1<marks.length?marks[index+1].index:body.length;
    return {
      label:String(mark[1]||'').trim(),
      heading:String(mark[0]||'').trim(),
      body:String(body.slice(from,to)).trim(),
      biography:String(entries[index]==null?'':entries[index]).trim(),
    };
  });
}

/**
 * 把「上一回合最后一段」和「本轮新写的这一段」合并成一段。
 *
 * ★★★ 2026-11-02 玩家点明了本质（原话）：
 *   「替换的核心就是上一回合写的内容不允许推翻，那是已发生的客观事实，
 *     虽然是覆盖，实质是续写。这个本质要弄清楚。」
 *
 * 所以这里的「覆盖」**不是**丢掉旧段落重新写一遍，而是：
 *   · 旧段落写的是已经发生的客观事实，一个字都不许推翻；
 *   · 本轮要做的是在旧段落的基础上**往后延展**，补上旧终点→新终点的经过；
 *   · 合并后的段落 = 旧段落的全部事实 + 后续新发生的事，仍然只有一段。
 *
 * 旧事实不丢由**结构**保证：旧段落正文原样放在前面，新写的接在后面，
 * 代码层面就不存在「旧事实被删掉」的可能。
 * 「接得自不自然」由**提示词**负责，不做验收拦截——玩家明确要求过
 * 「优化提示词让他写得更对，而不是在验收的时候阻碍他」。
 *
 * 若旧 block 只有一段，等价于整篇续写。
 * 若新正文有多段落，只取**最后一段**——未完成事件按规则永远排在最后。
 *
 * @param {object} oldBlock 上一回合的 block
 * @param {object} newBlock 本轮新写的 block
 * @returns {{block:object, replaced:boolean, kept:number, note:string}}
 */
export function overwriteLastParagraph(oldBlock,newBlock){
  const oldParas=splitProseParagraphs(oldBlock);
  const newParas=splitProseParagraphs(newBlock);
  if(!oldParas.length||!newParas.length){
    return {block:newBlock,replaced:false,kept:0,note:'段落无法切分，退回整篇替换'};
  }
  const kept=oldParas.slice(0,-1);
  const oldTail=oldParas[oldParas.length-1];
  const newTail=newParas[newParas.length-1];
  // 续写的合并段：旧段事实在前，本轮新发生的事在后，仍是一段。
  const mergedTailBody=[oldTail.body,newTail.body].filter(Boolean).join('\n');
  const mergedBody=[...kept.map(p=>p.heading+'\n'+p.body),newTail.heading+'\n'+mergedTailBody].join('\n');
  // 摘要同理：旧的那条事实保留，后面接本轮新增的事实，仍是一条。
  const mergedBio=[...kept.map(p=>p.biography).filter(Boolean),mergeBiographyLine(oldTail.biography,newTail.biography)].filter(Boolean).join('\n');
  return {
    block:{...newBlock,body:mergedBody,biographyLine:mergedBio},
    replaced:true,
    kept:kept.length,
    note:'保留前 '+kept.length+' 段，最后一段在旧事实基础上续写',
  };
}

/**
 * 合并两段之间的生平摘要：旧事实在前，新事实在后，仍是一条。
 * 旧摘要的 [日期@地点] 前缀保留（那是已发生事实的锚点）。
 */
function mergeBiographyLine(oldLine,newLine){
  const oldText=String(oldLine==null?'':oldLine).trim();
  const newText=String(newLine==null?'':newLine).trim();
  if(!oldText)return newText;
  if(!newText)return oldText;
  // 摘要形如 [0010年04月15日@七玄门]正文；方括号里是「时间@地点」。
  const parse=(line)=>{
    const m=line.match(/^\[([^\]]*)\]\s*/);
    const inner=m?m[1]:'';
    const body=m?line.slice(m[0].length).trim():line;
    const at=inner.indexOf('@');
    return {time:at>=0?inner.slice(0,at):inner, place:at>=0?inner.slice(at+1):'', body};
  };
  const a=parse(oldText), b=parse(newText);
  /* 时间段取两者的并：旧起点 → 新终点。
   *
   * 坑：新摘要的 time 本身可能已经是区间（'0010年04月15日—0010年04月18日'），
   * 直接 a.time+'—'+b.time 会拼成三重区间
   * '0010年04月15日—0010年04月15日—0010年04月18日'。
   * 所以先各自拆出「起点/终点」，再取 旧起点 → 新终点。
   */
  const splitSpan=(time)=>{
    const t=String(time==null?'':time).trim();
    const parts=t.split(/[—–~～]/).map(x=>x.trim()).filter(Boolean);
    if(!parts.length)return {start:'',end:''};
    return {start:parts[0],end:parts[parts.length-1]};
  };
  const spanA=splitSpan(a.time), spanB=splitSpan(b.time);
  const from=spanA.start||spanB.start;
  const to=spanB.end||spanA.end||from;
  /* ★★★ 2026-11-02 复盘发现的真冲突（生平列会重复）：
   *
   * 卡里保存生平用的是 mergeAppendBiographyForAdd →
   * ceMergeBiographyEntriesPreferBestPerTime，它按「时间键」判断是不是同一条。
   * 时间键 = 方括号里 @ 之前的完整时间串（见 ceExtractBiographyEntryTimeKey）。
   *
   * 如果这里把时间从「0010年04月15日」扩成「0010年04月15日—0010年04月18日」，
   * 时间键就变了，卡会认为这是**另一条新经历**，于是旧条目留着、新条目追加，
   * 同一段经历在生平里出现两遍。
   *
   * 所以：合并后的摘要**沿用旧条目的时间键**，只把新事实接在后面。
   * 时间区间在正文标题里已经写清楚了，生平这里不需要再扩。
   */
  const time=a.time||b.time;
  // 地点以旧的为准（旧事实发生地不变），旧的没有才用新的。
  const place=a.place||b.place;
  /* 拼接正文时清掉接缝处的重复标点：
   * 旧句以「。」结尾、新句又以「；」开头，会拼成「……见争执。；争执被劝散」。
   * 先去掉旧句尾部的句读，再用「；」接。
   */
  const trimTail=(t)=>String(t||'').replace(/[。；;，,、\s]+$/,'');
  const trimHead=(t)=>String(t||'').replace(/^[。；;，,、\s]+/,'');
  /* ★★★ 2026-11-02 复盘发现的真 bug：接缝**不能用分号**。
   *
   * 卡里 ceSplitColumn35Entries() 在只有一个时间标记时会**按分号切条**
   * （见 main.js:76012 的兜底分支）。合并后的摘要是单行、只有一个
   * [时间@地点] 标记，于是「；」会被当成**条目分隔符**：
   *   [0010年04月15日@七玄门]岩武守试炼场外，见争执；争执被劝散…
   * 被切成两条 —— 第一条带时间，第二条变成「[未知时间@未知地点]」，
   * 生平列里就多出一条时间地点全丢的垃圾记录。
   *
   * 所以接缝改用逗号（中文顿开），不触发按分号切条的逻辑。
   */
  const body=[trimTail(a.body),trimHead(b.body)].filter(Boolean).join('，');
  const label=time+(place?'@'+place:'');
  return (label?'['+label+']':'')+body;
}

/* ★★★ 2026-11-02 玩家否掉了「承接校验器」这个做法（原话）：
 *   「这个校验器不是成为新的阻碍吧？我之前记得说过我们要做得是优化提示词，
 *     让他写得更对，而不是在验收的时候阻碍他，因为这种很容易就过严格。」
 *
 * 所以这里**没有**承接校验器。理由：
 *   · 正文是自然语言，任何「旧要素出现比例」的阈值都会误伤同义改写，
 *     好续写被反复打回，最后变成玩家最讨厌的「卡在验收」；
 *   · 玩家定的原则是「小错自己重试，大错修不好才报告」，
 *     文字层面的承接不够漂亮属于小错，不该拦截流程。
 *
 * 旧事实不丢靠的是**结构**，不是校验：
 *   overwriteLastParagraph() 把旧段落正文原样放在前面，新写的接在后面，
 *   代码层面就不存在「旧事实被删掉」的可能。
 * 写得对不对靠**提示词**：把旧段落作为续写起点交给模型，
 * 明确要求「接着写，不重复、不推翻」。见 prose-prompt.js 的续写段。
 */

export function splitHandoffStory(body,biographyLine='',handoffBiographyLine=''){
  const source=String(body||''),pieces=source.split(/^\s*@@交汇开始\s*$/m);
  if(pieces.length===1)return {body:source,biographyLine,...handoffBiographyLine?{handoffError:'有交汇摘要却没有交汇分段标记'}:{}};
  const variableBody=pieces[0].trim(),readOnlyBody=pieces.slice(1).join('\n').trim();
  return {body:[variableBody,readOnlyBody].filter(Boolean).join('\n\n'),biographyLine:[biographyLine,handoffBiographyLine].filter(Boolean).join('\n'),variableBody,readOnlyBody,variableBiographyLine:biographyLine,readOnlyBiographyLine:handoffBiographyLine,handoffDeclared:true,handoffError:pieces.length!==2?'交汇分段标记重复':!readOnlyBody?'交汇末段没有正文':''};
}

export function validateHandoffReview(block,verdict,context={}){
  if(!context.handoffRequired&&!block.handoffDeclared)return {ok:true,value:null};
  const fail=reason=>({ok:false,reason:'交汇段核验：'+reason});
  if(!block.handoffDeclared||!block.readOnlyBody||block.handoffError)return fail(block.handoffError||'缺少明确交汇末段');
  if(!verdict||typeof verdict.excluded!=='boolean'||!Array.isArray(verdict.recordIds)||!String(verdict.reason||'').trim())return fail('缺少结算判定与理由');
  if(typeof verdict.mainEvidence!=='string'||!verdict.mainEvidence.trim()||!String(context.mainStory||'').includes(verdict.mainEvidence))return fail('主正文原句无效');
  const ids=new Set((context.ordinaryRecords||[]).map(row=>row.id));
  if(verdict.policy==='read_only_terminal'){
    if(verdict.excluded!==true||!Array.isArray(verdict.missingCanonItems))return fail('交汇末段必须保持只读，漏项另列');
    if(verdict.recordIds.some(id=>!ids.has(id)))return fail('引用的普通阶段回执不存在');
    const sourceText=value=>typeof value==='string'?value:Array.isArray(value)?value.map(sourceText).join('\n'):value&&typeof value==='object'?Object.values(value).map(sourceText).join('\n'):'';
    const canon=sourceText(context.events)+'\n'+sourceText(context.eventSegments);
    const boundary=sourceText(context.mustWrite)+'\n'+sourceText(context.boundary);
    for(const item of verdict.missingCanonItems){
      if(!item||!['inventory','equipment'].includes(item.kind)||!String(item.name||'').trim()||!String(item.text||'').trim())return fail('漏项必须是AI明确判定的原著道具或装备事实');
      if(!String(item.evidence||'').trim()||!block.readOnlyBody.includes(item.evidence))return fail('漏项缺少本人交汇段原句');
      if(!String(item.canonEvidence||'').trim()||!canon.includes(item.canonEvidence))return fail('漏项缺少原著资料依据');
      if(!String(item.boundaryEvidence||'').trim()||!boundary.includes(item.boundaryEvidence))return fail('漏项缺少本轮边界判定依据');
    }
    return {ok:true,value:verdict};
  }
  if(verdict.recordIds.some(id=>!ids.has(id))||verdict.excluded&&!verdict.recordIds.length)return fail('不能把失败或缺失回执当成已结算');
  return {ok:true,value:verdict};
}

/** 「无」当作空；默认按斜杠拆，可传入自定义分隔 */
function splitItems(text, separator) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s === '无' || s === '沒有' || s === '没有') return [];
  const re = separator instanceof RegExp ? separator : /\s*[/／]\s*/;
  return s.split(re).map((x) => x.trim()).filter(Boolean);
}

/**
 * 校验一块散文。三层，越权的事不做。
 *
 * @param {object} block parseProseBlock() 的产物
 * @param {object} ctx
 * @param {string} [ctx.expectedName] 应该是谁
 * @param {string[]} [ctx.expectedEvents] 本轮可以引用的事件号
 * @param {string[]} [ctx.mustWrite] 必写清单（= missing 条目）
 * @returns {{ok:boolean, gaps:Array<{type:string, detail:string}>}}
 */
export function validateProseBlock(block, ctx = {}) {
  const gaps = [];
  const push = (type, detail) => gaps.push({ type, detail });

  if (!block || typeof block !== 'object') {
    push(CE_CHECK_TYPES.parse, '没有解析出骨架行');
    return { ok: false, gaps };
  }

  // ---- 层一：完整性（免费，纯集合运算） ----
  const eventIds = Array.isArray(block.eventIds) ? block.eventIds : [];
  const expected = Array.isArray(ctx.expectedEvents) ? ctx.expectedEvents : [];
  const autonomous = ctx.taskKind === 'autonomous' || block.taskKind === 'autonomous'
    || eventIds.some(id => /^LIFE-/i.test(String(id)))
    || expected.some(id => /^LIFE-/i.test(String(id)));
  if (autonomous) {
    const permitted = ctx.taskKind === 'autonomous' || Boolean(ctx.autonomousCode)
      || expected.some(id => /^LIFE-/i.test(String(id)));
    if (!permitted) push(CE_CHECK_TYPES.parse, '本轮未授权自主生活任务，不能自行声明 LIFE 编号绕过原著补缺');
    if (eventIds.length !== 1 || !/^LIFE-[A-Z0-9][A-Z0-9_-]*$/i.test(String(eventIds[0] || ''))) {
      push(CE_CHECK_TYPES.parse, '自主生活只能使用一个 LIFE 人物任务编号，不得伪造或混入原著 E 编号');
    }
    if (ctx.autonomousCode && String(eventIds[0] || '').toUpperCase() !== String(ctx.autonomousCode).toUpperCase()) {
      push(CE_CHECK_TYPES.parse, '自主生活任务编号与本轮指定人物不一致');
    }
    if (block.status === CE_PROSE_STATUS.canon) push(CE_CHECK_TYPES.parse, '自主生活非原著必成事实，不得标为照原著');
  }

  if (!block.name) push(CE_CHECK_TYPES.parse, '骨架行缺人物名');
  else if (ctx.expectedName && block.name !== ctx.expectedName) {
    push(CE_CHECK_TYPES.parse, `骨架行人物名是「${block.name}」，应为「${ctx.expectedName}」`);
  }

  if (!Array.isArray(block.eventIds) || block.eventIds.length === 0) {
    push(CE_CHECK_TYPES.parse, '骨架行缺事件编号');
  } else if (Array.isArray(ctx.expectedEvents) && ctx.expectedEvents.length > 0) {
    const allowed = new Set(ctx.expectedEvents.map((e) => String(e).toUpperCase()));
    const bad = block.eventIds.filter((id) => !allowed.has(id));
    if (bad.length > 0) {
      // 只说「不在范围内」模型无从纠正：它看到整条年表，不知道本批只允许哪几个。
      push(CE_CHECK_TYPES.parse, `事件编号 ${bad.join('、')} 不在本轮范围内；本轮只能引用 ${[...allowed].join('、')}`);
    }
  }

  const validStatus = new Set(Object.values(CE_PROSE_STATUS));
  if (!validStatus.has(block.status)) {
    push(CE_CHECK_TYPES.parse, `三态「${block.status}」不合法`);
  } else if (block.status !== CE_PROSE_STATUS.canon && !block.reason) {
    push(CE_CHECK_TYPES.parse, `三态是「${block.status}」但没写依据`);
  }

  if (!block.body) push(CE_CHECK_TYPES.body, '没有正文');
  if(block.handoffError)push(CE_CHECK_TYPES.parse,block.handoffError);

  // 覆盖声明必须有
  const declared = [...(block.declaredWritten || []), ...(block.declaredUnwritten || [])];
  if (declared.length === 0) {
    push(CE_CHECK_TYPES.coverage, '没有写覆盖声明（@@已写 / @@未写）');
  }
  // 生产流程只在这里校验格式；自然语言的覆盖与同义表达交由批量AI核验。
  if(ctx.diary===true){
    const body=String(block.body || ''),headings=[...body.matchAll(/^###\s+\[([^\]\r\n]+)\]\s*$/gm)];
    const entries=String(block.biographyLine || '').split(/\r?\n/).filter(line=>line.trim());
    const labels=entries.map(line=>(line.match(/^\[([^\]]+)\]\s*\S/) || [])[1]);
    if(!headings.length || body.slice(0,headings[0]?.index || 0).trim())push(CE_CHECK_TYPES.parse,'正文须直接从日期分段标题开始');
    const expectedLabels=headings.map(h=>h[1]);
    if(entries.length!==headings.length || labels.some(label=>!label) || JSON.stringify(labels)!==JSON.stringify(expectedLabels)){
      const differences=Array.from({length:Math.max(expectedLabels.length,labels.length)},(_,index)=>{
        if(labels[index]===expectedLabels[index])return '';
        return '第'+(index+1)+'段：正文'+(expectedLabels[index]?'['+expectedLabels[index]+']':'（无对应日期段）')+'，生平'+(labels[index]?'['+labels[index]+']':'（缺少有效条目）');
      }).filter(Boolean);
      gaps.push({type:CE_CHECK_TYPES.parse,field:'biographyLine',repairable:headings.length>0&&entries.length===headings.length&&labels.every(Boolean),
        expectedLabels,actualLabels:labels,
        detail:'每个正文日期段须有日期地点一致、顺序对应的生平条目；正文'+headings.length+'段，生平'+entries.length+'条。'+differences.join('；')});
    }
    headings.forEach((h,i)=>{if(!/^\d+(?:年|\.)/.test(h[1]) || !body.slice(h.index+h[0].length,headings[i+1]?.index || body.length).trim())push(CE_CHECK_TYPES.parse,'日期分段缺少日期或叙述正文');});
  }
  if(ctx.structureOnly===true)return {ok:gaps.length===0,gaps};

  // 必写清单里每一条，**必须出现在「已写」里**才算覆盖。
  //
  // ---- 这一段改过一次，说清楚为什么 ----
  //
  // 旧规则（错的，已修）：
  //   ① 把 @@已写 和 @@未写 并成一个池子，只要必写项的实体能在池子里
  //      找到就算「交代了」。于是「@@未写: 韩立突破至炼气九层」这句
  //      自己就证明了「韩立突破」被交代了 —— **声明没做，反而算做了**。
  //   ② 变异/阻断 + 任意理由 → 整块必成事实全部豁免。
  //      理由只写「改为独自赴约」，却连「突破」也一起免了。
  //
  // 现在：
  //   · 只有 @@已写 算覆盖。@@未写 是「我没做」的声明，不是完成证明。
  //   · 变异/阻断不再自动豁免，理由解释不了的事项照样要交代。
  //
  // 匹配仍用**实体交集**而不是整句：
  //   清单「韩立入了七玄门」→ 实体 {七玄门, 韩立入了}
  //   声明「入七玄门」      → 实体 {七玄门, 入七玄}
  //   有交集就算说过。整句比对在中文里几乎必然误判。
  const mustWrite = Array.isArray(ctx.mustWrite) ? ctx.mustWrite : [];
  // 自主目标是动机，不是本轮必须完成的原著事实；仍检查覆盖声明和正文存在性。
  if (!autonomous && mustWrite.length > 0) {
    const writtenEntities = (block.declaredWritten || []).flatMap((d) => extractEntities(d));

    const uncovered = mustWrite.filter((item) => {
      const need = extractEntities(item);
      if (need.length === 0) return false;
      // 在「已写」里能找到 → 真覆盖了
      return !need.some((n) => writtenEntities.some((g) => g.includes(n) || n.includes(g)));
    });

    if (uncovered.length > 0) {
      push(CE_CHECK_TYPES.coverage, `这些必写内容没交代：${uncovered.join('；')}`);
    }
  }

  // ---- 层二：存在性粗校验（便宜） ----
  // 「已写」里提到的实体，正文里得真能找到，防谎报。
  //
  // 但这是个**粗**校验，不能因为措辞不同就冤枉人：
  //   声明「董萱儿赴约」，正文「董萱儿独自去了」——同义改写，不算谎报。
  //   声明「筑基成功」，正文「扫了三年地」——完全不同，算谎报。
  //
  // 判据：声明里的实体，只要能有一个在正文里出现，就算说了。
  // 一个都找不到，才判谎报。
  const bodyNorm = normalizeForMatch(block.body);
  const missingInBody = (block.declaredWritten || []).filter((item) => {
    const entities = extractEntities(item);
    if (entities.length === 0) return false;
    return !entities.some((e) => bodyNorm.includes(e));
  });
  if (missingInBody.length > 0) {
    push(
      CE_CHECK_TYPES.existence,
      `声明写了「${missingInBody.join('、')}」但正文里找不到`,
    );
  }

  // ---- 层三：不校验具体细节 ----
  // 「是不是真写了一枚而不是两枚」是四阶段的活，这里不碰。

  return { ok: gaps.length === 0, gaps };
}

/** 归一化，用于宽松包含判断（去空白、去标点） */
function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .replace(/[\s，。、；：！？「」『』（）()【】\[\]…—\-·]/g, '')
    .trim();
}

/**
 * 从一句声明里取出**可用于比对的实体片段**。
 *
 * 「董萱儿赴约」  → ['董萱儿', '赴约']
 * 「获得筑基丹」  → ['获得筑基丹', '筑基丹']
 * 「入七玄门」    → ['七玄门']
 *
 * 做法：
 *   1. 归一化
 *   2. 剥掉常见动词前缀，得到一个候选
 *   3. 再去掉动词本身，留下宾语候选
 *
 * 返回多个候选是为了放宽匹配——只要有一个能在正文找到就算说了。
 * 这是**粗校验**，宁可放过不可错杀。
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractEntities(text) {
  const s = normalizeForMatch(text);
  if (!s) return [];

  const VERB_PREFIXES = [
    '成功', '顺利', '终于', '已经',
    '获得', '得到', '取得', '拿到', '捡到', '收下',
    '失去', '丢失', '损毁', '毁掉',
    '离开', '抵达', '前往', '来到', '进入', '回到', '赶往', '奔赴', '赴',
    '结识', '遇见', '遇到', '拜入', '收为',
    '突破', '晋级', '晋升',
    '入', '出', '去', '来', '到',
  ];

  const out = new Set();

  // 候选一：剥掉动词前缀后的宾语
  let stripped = s;
  for (const verb of VERB_PREFIXES) {
    if (stripped.startsWith(verb) && stripped.length > verb.length) {
      stripped = stripped.slice(verb.length);
      break;
    }
  }
  if (stripped.length >= 2) out.add(stripped);

  // 候选二：开头的短实体名（中文人名/物名通常 2-4 字）
  // 「董萱儿赴约」→ 试「董萱」「董萱儿」「董萱儿赴」
  // 「筑基成功」  → 试「筑基」「筑基成」「筑基成功」
  for (const len of [2, 3, 4]) {
    if (s.length > len) out.add(s.slice(0, len));
  }
  if (s.length <= 4) out.add(s);

  return [...out];
}

/**
 * 生成重试时附带的「为什么失败」说明。
 *
 * 依据 seq 1951 用户原话：
 *   「每一次失败的下一次请求，都会同时将为什么失败的原因发送过去」
 *
 * @param {Array<{type:string, detail:string}>} gaps
 * @returns {string}
 */
export function buildRetryHint(gaps) {
  const list = Array.isArray(gaps) ? gaps : [];
  if (list.length === 0) return '';

  const lines = [
    '',
    '## 上一版不合格，这次必须只修正下面这些',
    '',
  ];
  list.forEach((g, i) => {
    lines.push(`${i + 1}. ${g.detail}`);
  });
  lines.push('');
  lines.push('其余内容照原样写，不要重写整篇，也不要解释。');

  return lines.join('\n');
}

/**
 * 一轮散文的处置结果：合格就留，不合格就记欠账。
 *
 * 依据总设计 §4.6.5：
 *   · 本轮照常落地合格的块（不能因为一个块失败就整轮作废）
 *   · 账本记下这条欠账，下一轮重新塞进候选
 *   · 玩家能看到
 *
 * @param {Array<{name:string, ok:boolean, block:object|null, gaps:Array}>} results
 * @param {object} [context]
 * @param {string} [context.timeRange]
 * @param {string} [context.eventCode]
 * @returns {{
 *   accepted: Array<object>,
 *   debts: Array<{name:string, reason:string, eventCode:string, timeRange:string}>,
 *   summary: string
 * }}
 */
export function settleProseResults(results, context = {}) {
  const list = Array.isArray(results) ? results : [];
  const accepted = [];
  const debts = [];

  for (const r of list) {
    if (!r) continue;
    if (r.ok && r.block) {
      accepted.push({
        name: r.name,
        eventIds: r.block.eventIds || [],
        status: r.block.status,
        reason: r.block.reason || '',
        body: r.block.body || '',
        declaredWritten: r.block.declaredWritten || [],
        declaredUnwritten: r.block.declaredUnwritten || [],
        // 散文写的「这一段实际怎么过的」，拼进第 35 列。
        // 只有散文知道正文那一刻发生了什么，代码抠不准。
        biographyLine: r.block.biographyLine || '',
        ...(r.block.handoffDeclared?{handoffDeclared:true,variableBody:r.block.variableBody,readOnlyBody:r.block.readOnlyBody,variableBiographyLine:r.block.variableBiographyLine,readOnlyBiographyLine:r.block.readOnlyBiographyLine,handoffReview:r.block.handoffReview}:{}),
      });
      continue;
    }

    const gaps = Array.isArray(r.gaps) ? r.gaps : [];
    debts.push({
      name: String(r.name || '').trim(),
      reason: gaps.map((g) => g.detail).join('；') || '未知原因',
      eventCode: String(context.eventCode || '').trim(),
      timeRange: String(context.timeRange || '').trim(),
    });
  }

  const total = accepted.length + debts.length;
  const summary = total === 0
    ? '本轮没有需要撰写的 NPC 视角正文。'
    : `本轮 NPC 视角正文：成 ${accepted.length} 段，欠账 ${debts.length} 段。`;

  return { accepted, debts, summary };
}

/**
 * 把欠账渲染成给玩家看的提示。
 * 依据：「玩家能看到」「静默漏补才是最危险的」。
 *
 * @param {Array<object>} debts
 * @returns {string}
 */
export function formatDebtsForPlayer(debts) {
  const list = Array.isArray(debts) ? debts : [];
  if (list.length === 0) return '';

  const lines = ['以下原著内容本轮尚未完成，须在本轮继续补演：'];
  list.forEach((d) => {
    lines.push(`· ${d.name}：${d.reason}`);
  });
  return lines.join('\n');
}
