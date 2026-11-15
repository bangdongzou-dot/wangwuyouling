// ============================================================
// NPC 视角正文 · 怎么写
//
// 依据（全部来自已定结论，不是我的发挥）：
//
//   四条验收标准（用户 2026-10-21 原话，唯一 judge）：
//     1、我是这个原著世界里的人
//     2、我不知道原著会发生什么，但是我一定会做原著写到的那些事情。
//     3、世界发生变化，我会按照我的人设做出合理的反应，
//        影响大到让我没法去做原著那些我本该做的事情，我就不做了，去做其他的。
//     4、没有原著故事剧情的时候，我按照我的人设做着我会做的事情。
//
//   写作骨架（用户 2026-10-21 提供的原版提示词，全部采纳）：
//     · 写作起点倒置：从「这个 NPC 自己在追求什么」起笔
//       自查：抽掉主角后这段若空了，就是写反了
//     · 自主目标栈：自主目标 / 当前进度 / 下一步 / 牵涉的人
//     · 绿黄红三区：绿区放开、黄区只埋钩子、红区禁止
//     · 在场不复述主正文，笔墨配额涉主角不超三成
//     · 离场可补写「上次出场到本轮终点」，不得越过终点
//     · 信息源仅三类：亲见亲闻亲感 / 自己记忆学识 / 档案快照已确立
//     · 未揭示伏笔只写模糊异样感，不给确切结论
//     · 严格限知，NPC 不可全知
//     · 宁可 80 字真实，不要 500 字注水
//
//   补演专属注入（本系统与纯 NPC 视角正文的唯一区别）：
//     · 「该补什么」来自边界判定的 missing
//     · 「已被替代」的部分不许按原样补
//
// 关于人称：沿用卡内全局设置 evolution_pov，可第一人称也可第三人称。
//   本文件默认输出「第二人称对模型说话」（你是韩立），
//   模型写出来的正文再按 evolution_pov 决定用「我」还是「他」。
// ============================================================

/** 三区定义（权限分区，不是写作风格） */
export const CE_PROSE_ZONES = {
  green: '绿区',
  yellow: '黄区',
  red: '红区',
};

/** 默认字数预算（总设计 §10-Q1：核心 300-500 / 边缘 100 内） */
export const CE_PROSE_BUDGET = {
  coreMax: 800,
  coreMin: 0,
  minorMax: 400,
};

/**
 * 组装单个 NPC 的写作提示词。
 *
 * @param {object} material buildCharacterMaterial() 的产物
 * @param {object} [options]
 * @param {number} [options.maxChars=500]
 * @param {boolean} [options.isCore=true]
 * @param {string} [options.pov=''] evolution_pov 全局人称设置
 * @param {object} [options.promptOverrides] 玩家改过的提示词（空 = 用默认）
 * @returns {string}
 */
export function buildProsePrompt(material, options = {}) {
  const m = material && typeof material === 'object' ? material : {};
  const name = String(m.name == null ? '' : m.name).trim() || '（未具名）';
  const mat = m.material || {};
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : CE_PROSE_BUDGET.coreMax;
  const isCore = options.isCore !== false;
  const pov = String(options.pov == null ? '' : options.pov).trim();

  // 玩家改过核心写作提示词 → 用玩家那份当骨架，材料照旧附在后面。
  // 沿用卡内 imagePromptTemplateOverrides 的约定：空 = 用默认。
  const custom = readOverride('proseCore', options.promptOverrides);
  if (mat.taskKind === 'autonomous' || mat.autonomous === true) {
    return [
      ...(custom ? [fillPlaceholders(custom, material, { maxChars, pov, timeText: resolveTimeText(mat.timeRange) }), ''] : []),
      renderAutonomousPrompt(material, { maxChars, pov }),
    ].join('\n').trim();
  }
  if (custom) {
    return [
      fillPlaceholders(custom, material, { maxChars, pov, timeText: resolveTimeText(mat.timeRange) }),
      '',
      renderMaterialAppendix(material),
    ].join('\n').trim();
  }

  const range = mat.timeRange || {};
  const timeText = resolveTimeText(range);

  const taskList = Array.isArray(mat.task) ? mat.task : [];
  const mutated = Array.isArray(mat.mutated) ? mat.mutated : [];
  const others = Array.isArray(mat.others) ? mat.others : [];
  const goal = mat.goal && typeof mat.goal === 'object' ? mat.goal : null;

  const lines = [];
  if(mat.canonDecision)lines.push(renderCanonCorridor(mat));

  // 身份代入是写作立场，不把写作指令变成NPC独白。
  if(mat.handoffRequired)lines.push('【本人物本轮需要交汇】最后用@@交汇开始单独接回当前主正文；交汇段只重述，不新增变量事实。');
  lines.push(`你是${name}。直接写这个人正在经历的事，按其认知、性格和目标行动。`);
  lines.push('不要复述作者指令、进行角色扮演身份假设或向读者解释写作过程。');
  lines.push(`用你的口吻讲：${timeText}。`);
  lines.push('');

  // ── 你是谁 ──
  //
  // 用户 2026-10-21 关于性格的两条：
  //   ①「原著是有对每个原著人物的初始设定的……性格一定会保持原著设定的性格」
  //   ②「但是如果经历发生改变，环境发生改变，这个npc的性格也就应该要发生改变」
  //   ③「快照npc的信息里是包含性格的……只要调取快照档案」
  //
  // 所以这里分两处给：设定集里的底子 + 存档里现在的性格。
  // 存档那一列是重点演化的成果，它可能已经跟原著不一样了——那才准。
  lines.push('【你这个人】');
  lines.push(renderProfile(mat.identity));
  const nowPersonality = String(
    (mat.state && (mat.state.personality || mat.state.性格)) || '',
  ).trim();
  const basePersonality = String(
    (mat.identity && (mat.identity.personality || mat.identity.性格)) || '',
  ).trim();
  lines.push('');
  if (nowPersonality && basePersonality && nowPersonality !== basePersonality) {
    lines.push(`你原本的性子：${basePersonality}`);
    lines.push(`可如今你是：${nowPersonality}`);
    lines.push('后面这个才是现在的你。前一个是你出发的地方，中间隔着这些年的经历。');
  } else if (nowPersonality) {
    lines.push(`你的性子：${nowPersonality}`);
  } else if (basePersonality) {
    lines.push(`你的性子：${basePersonality}`);
  }
  if (nowPersonality || basePersonality) {
    lines.push('性子是会被经历改的。这段日子里要是发生了什么够重的事，你也可能变了一点——');
    lines.push('但得让人看得出是怎么变的，别无缘无故就换了个人。');
  }
  lines.push('');

  // ── 自主目标栈：写作起点倒置的落地 ──
  if (goal) {
    lines.push('【你自己的事，跟主角无关】');
    lines.push(renderGoalStack(goal));
    lines.push('');
    lines.push('这一段从**你自己正在办的事**起笔。主角有没有出现，只是顺带一笔。');
    lines.push('自查：把主角从这段里抽掉，这段仍然要能独立成立。');
    lines.push('');
  }

  // ── 眼下处境 ──
  lines.push('【眼下你的处境】');
  lines.push(renderState(mat.state, name));
  lines.push('');

  // ── 你此刻心里在想什么 ──
  //
  // 用户 2026-10-21：
  //   「不止是性格，你还需要看看npc列里哪些信息是需要的，
  //     对边界判定或者npc视角正文有参考价值或者有影响的，
  //     我记得的就还有当前动机和长期目标两列内容」
  //
  // 所以第 12 列（内心想法）、27 列（当前动机）、15 列（对玩家态度）
  // 都要摆出来——「他会怎么做」全靠这几条定。
  const inner = String((mat.state && (mat.state.innerThought || mat.state.内心想法)) || '').trim();
  const motive = String(
    (mat.state && (mat.state.motive || mat.state.当前动机)) || '',
  ).trim();
  const favor = String((mat.state && (mat.state.favor || mat.state.好感度)) || '').trim();
  if (inner || motive || favor) {
    lines.push('【你现在心里那些事】');
    if (motive) lines.push(`- 你此刻最想办的是：${motive}`);
    if (inner) lines.push(`- 心里头压着的是：${inner}`);
    if (favor) lines.push(`- 你对那个人的态度：${favor}`);
    lines.push('');
    lines.push('这几条是你现在真实的想法，不是给你定的调子。');
    lines.push('要是这段日子发生了什么事，让你改主意了，那就按改过的写。');
    lines.push('');
  }

  // ── 本来要做的事（第 2 条的落点） ──
  if (taskList.length > 0) {
    lines.push('【这段时间你本来要做的事】');
    lines.push('按原著，你这段时间本来会去做这些：');
    lines.push('');
    taskList.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${item}`);
    });
    lines.push('');
    lines.push('你会去做，不是因为有人吩咐你，是因为这就是你这个人会做的事。');
    lines.push('但要是眼下的处境已经让你做不成了——被拦住了、时机过了、人已经不在原处了——');
    lines.push('那就别硬凑。写清楚是什么挡住了你，然后你改去做了什么。');
  } else if (mat.parallel) {
    lines.push('【原著相关人物的当前个人视角】');
    lines.push('本轮没有该人物的原著缺口需要重演，承接现状写正文之外的独立片段。');
  } else {
    lines.push('【这段时间没有原著剧情找到你】');
    lines.push('年表上这段时间没写到你。你照自己的性子过日子就行。');
  }
  lines.push('');

  // ── 原著推力原文（给性格，用来推演） ──
  //
  // 用户 2026-10-21：
  //   「我们把在边界判定这里梳理的资料都整理给npc视角正文ai，
  //     由他根据逻辑推演，根据这个npc的性格，来写他可能会做的事情」
  //
  // 这里给的是**年表 brief 原句**，不是我们改写过的摘要。
  // 摘要会丢掉「怎么发生的」，而那正是性格推演要的原料。
  const dossier = mat.dossier && typeof mat.dossier === 'object' ? mat.dossier : null;
  lines.push(renderStoryInfluence(dossier));
  if (dossier && dossier.biography) lines.push('【设定集检索到的本人过往，须以当前存档和本轮事实校核】',dossier.biography);

  // ── 新人的原著设定：存档里是零，底子只能现查 ──
  //
  // 用户 2026-10-21：
  //   「很多时候都是新建原著npc，当前信息是零，那么初始信息我们怎么找呢？
  //     尤其是性格设定这些，就需要从向量库调取信息」
  //
  // 查到了就用；查不到就明说查不到，不许编。
  const newcomer = dossier && dossier.newcomer ? dossier.newcomer : null;
  if (newcomer) {
    lines.push('【关于你这个人，原著里是这么写的】');
    lines.push('');
    if (newcomer.fromSetting) {
      lines.push(newcomer.fromSetting);
    } else {
      lines.push('（设定集里没查到你这个人。）');
      lines.push('依据已知年表、正文和存档继续叙述。从已知行动保守推断性格和动机，未明确的基础变量沿原重点演化规则处理，推断不能冒充原著明文设定。不得凭空增加师承、法宝、机缘或境界突破。');
      lines.push('资料不足不等于人物无法行动；用已有处境与行为表现人物，不把未知设定写成确定历史。');
    }
    lines.push('');
  }

  if (dossier && Array.isArray(dossier.pushes) && dossier.pushes.length > 0) {
    lines.push('【按原著，你这段时间本来会遇到这些】');
    lines.push('');
    dossier.pushes.forEach((p) => {
      const head = `  ${p.index}. [${p.time || '时间未标'}] ${p.title || ''}`;
      lines.push(head);
      if (p.text || p.brief) lines.push(String(p.text || p.brief));
    });
    lines.push('');
    lines.push('这些是**本来会发生的事**，不是命令。');
    lines.push('你现在是什么处境，你自己最清楚。哪件事还做得成、哪件事已经做不成了，');
    lines.push('按你这个人的性子去想，然后照你想的去做。');
    lines.push('');
  }

  // ── 已经被顶掉的推力（给推演，为什么没法照原著） ──
  if (dossier && Array.isArray(dossier.blocked) && dossier.blocked.length > 0) {
    lines.push('【有些本来该发生的事，已经成不了了】');
    lines.push('');
    dossier.blocked.forEach((b) => {
      const reason = String(b && b.reason || '').trim();
      if (reason) lines.push(`  · ${reason}`);
    });
    lines.push('');
    lines.push('不是你不想，是做不成了。别硬凑，也别假装它还成立。');
    lines.push('写清楚是什么挡住的，然后你改去做了什么。');
    lines.push('');
  }

  // ── 必成事实（给下限，不是给结论） ──
  //
  // 用户 2026-10-21 纠正过一次措辞：
  //   「边界判定不是下最后的结论，只能说哪些事实按照现在的情况看一定会发生了，
  //     而不是最终一定是这样，终态是npc视角正文的事实，才是本轮最后的结果。」
  //
  // 所以这里写的不是「你必须变成这样」，而是「这几件躲不掉，得让它发生」。
  // 他人写成什么样、还做了别的什么、性格有没有因为这轮变了——
  // 全归散文，散文写的才是本轮结果。
  if (!mat.parallel && dossier && Array.isArray(dossier.musts) && dossier.musts.length > 0) {
    lines.push('【按现在的局势，这几件躲不掉】');
    lines.push('');
    dossier.musts.forEach((s) => {
      lines.push(`  · ${s}`);
    });
    if (dossier.basis) {
      lines.push('');
      lines.push(`  （这么推的依据：${dossier.basis}）`);
    }
    lines.push('');
    lines.push('这几件是下限——你得让它们发生，不能当作没发生。');
    lines.push('但它们只是「躲不掉的事」，不是「你这一轮的全部」。');
    lines.push('你还是你，还会做别的、还会想别的、也可能因为这段经历变了点什么。');
    lines.push('**这一轮你最终是什么样，由你写出来的算。**');
    lines.push('');
  }

  // ── 天花板：不许把下一轮的额度提前花掉 ──
  //
  // 下限管「不能少」，天花板管「不能多」。
  //
  // 没有天花板会发生什么：
  //   本轮年表四层，下轮年表六层，散文心想「反正要六层」，
  //   这轮就写她突破到六层 —— 下一轮的额度被提前花掉了，
  //   等真走到那一步，已经没有额度可花，时间线被自己吃掉。
  //
  // 注意这里给的是**材料**，不是判决：
  //   「那条里他是什么状态」要读剧情才判得出来，交给模型自己守。
  //   代码只在能百分百确定的地方动手（找下一条年表）。
  const ceiling = dossier && typeof dossier.ceiling === 'string' ? dossier.ceiling : '';
  if (ceiling) {
    lines.push('【这一步别走太快】');
    lines.push('');
    lines.push(ceiling);
    lines.push('');
    lines.push('先确认下一节点是否真描述本人当期现实，再保留有依据的走廊约束。');
    lines.push('本轮已经确认且足以改变修炼节奏的外力可打破对应约束，不能为了升级自行编造；其余约束继续有效。');
    lines.push('保留现有合法进度；境界内自然推进不因参考资料未知被卡死，不能按经过天数比例生成修为。');
    lines.push('');
  }

  // ── 三档：正文已经写过的部分 ──
  //
  // 不告诉它哪些已经写过，它会把同一件事再写一遍——
  // 而且它不知道那件事已经发生，还会当成「还没发生」去推。
  // 这就是三档那个不能省的额外动作（一档没有，二档整轮跳过）。
  const covered = Array.isArray(mat.covered) ? mat.covered : [];
  if (covered.length > 0) {
    lines.push('【这些正文里已经写过了】');
    lines.push('');
    covered.forEach((c) => {
      lines.push(`  · ${c}`);
    });
    lines.push('');
    lines.push(mat.canonOwnsScene?'按实际先后将这些事实写入本人视角，后续变量按本人各段正文依次结算。':'这些已发生事实可在交汇末段从本人视角简要重述，不把它们再演成新发生的事。');
    lines.push('它们已经发生了，是既定事实。你要接着往下走，不是从头再演一次。');
    lines.push('');
  }
  if(mat.canonOwnsScene&&(!mat.prosePart||mat.prosePart.index===mat.prosePart.total)){
    lines.push('【本人物的交汇由补演结算】在最后日期段以本人视角写入与玩家主正文交汇的实际动作、结果及本人变化。保留已有事实，用同样的日期标题及经历摘要，不使用@@交汇开始，也不把这段写成只读。');
  }

  // ── 已被替代的部分 ──
  if (mutated.length > 0) {
    lines.push('【原著里的事已经变了样】');
    lines.push('下面这些原本该发生，但这世界已经不是那个样子了。**不要按原样补。**');
    lines.push('');
    mutated.forEach((item) => {
      const original = String(item && item.original || '').trim();
      const actual = String(item && item.actual || '').trim();
      if (!original) return;
      lines.push(`  · 本该：${original}`);
      if (actual) lines.push(`    实际：${actual}`);
    });
    lines.push('');
  }

  // ── 外面发生了什么 ──
  if (mat.story) {
    lines.push('【这段时间外面发生了什么】');
    lines.push(mat.story);
    lines.push('');
    lines.push('这些是已经发生的事，是你所处世界的现状。你可能在里面，也可能压根没在场。');
    lines.push('如果里面已经写过你的某个动作，那就不用再讲一遍，接着往下说。');
    lines.push('');
  }

  // ── 相关的人 ──
  if (others.length > 0) {
    lines.push('【这段时间和你有往来的人】');
    lines.push(others.join('、'));
    lines.push('你只知道自己看见的、听见的、自己想到的。别人心里怎么想，你不知道，也不用替他们编。');
    lines.push('');
  }

  // ── 这个世界的规矩和处境 ──
  // 世界规则、世界大事、任务、地理。不属于任何单独一个人，
  // 但每个人都活在里面，写的时候不能违反。
  if (mat.background) {
    lines.push('【这个世界的规矩和最近的处境】');
    lines.push(mat.background);
    lines.push('');
    lines.push('这些是你活着的世界本来的样子，不是你听来的传闻。不必复述，但你不能违反它。');
    lines.push('');
  }

  // ── 四条 ──
  lines.push('【写的时候守住这四条】');
  lines.push('');
  lines.push('一、你就是这个世界里的人。');
  lines.push('   不是旁观者，不是作者，也不是读过这本书的人。');
  lines.push('   你有一身具体的处境：你在哪、什么修为、手里有什么、忌惮谁。');
  lines.push('   写「你的所作所为」，不是站在旁边点评自己。');
  lines.push('');
  lines.push('二、你不知道原著会怎么发展，但原著写着的事，你一定会去做。');
  lines.push('   你没有剧本，也看不见自己的未来。');
  lines.push(`   可上面那 ${taskList.length || '几'} 件事，就是你这段时间本来要走的路——`);
  lines.push('   不是谁安排的，是你这个人自然就会这么做。');
  lines.push('');
  lines.push('三、要是外面的变化影响够大，你按自己的性子做出反应。');
  lines.push('   大到让你做不成上面那些事，那就不做了，转去做别的。');
  lines.push('   但得让人看明白：是什么拦住了你，你想了想，改去做了什么。');
  lines.push('   这种情形，骨架行要标「变异」，后面写「依据：……」。');
  lines.push('');
  lines.push('四、原著没写你的那些时候，你按自己的性子过日子。');
  lines.push('   上面几件事之间是有空档的，那些空档就是你平常的日子。');
  lines.push('   修炼、谋生、跟人打交道、提防着谁——按你的习惯来，不用等剧情来找你。');
  lines.push('');

  // ── 这段是**你写故事**，不是**你做题** ──
  //
  // 用户 2026-10-21：
  //   「边界判定给的是资料，正在写故事的是npc视角正文」
  //
  // 上面给的是资料：推力、定案、别人的变化。
  // 怎么把它们串成一个活人的一段时间，是这一段的活。
  lines.push('【最后一句】');
  lines.push('');
  lines.push('上面都是资料，不是提纲。');
  lines.push('写故事的人是你，不是给你资料的那个系统。');
  lines.push('它只负责告诉你「这段时间本来会怎样」「有些事已经成不了了」「哪几件躲不掉」。');
  lines.push('**它说的都不是最终结果，你写的才是。**');
  lines.push('至于这中间你是熬过来的、混过来的、还是咬着牙撑过来的——那是你的事。');
  lines.push('');
  lines.push('交稿前自己读一遍，就查一件事：');
  lines.push('把上面那些条件当题干，你填进去的这段，读得通吗？');
  lines.push('要是某一条题干在你的答案里根本落不下来，那是你的问题，回去改；');
  lines.push('要是读起来像在一条条翻译题干，那也是你的问题——那就成了答题，不是过日子。');
  lines.push('');

  // ── 能自主到多大：三区 ──
  lines.push('【你能自己推进到多大】');
  lines.push('');
  lines.push('绿区——放开写：');
  lines.push('   纯个人尺度的事。推进自己的目标、修炼有小进展、谈成一笔买卖、');
  lines.push('   结识新的朋友或对头、被同僚刁难又扳回、自己地盘上的经营起伏。');
  lines.push('   越充实越好，这是「你是个活人」的质感来源。');
  lines.push('');
  lines.push('黄区——只埋钩子，不收钩子：');
  lines.push('   有分量、但还不到定局的事。可以写你在冲瓶颈，但成败留白，或只写失败/小成；');
  lines.push('   可以卷入一桩中等事件，但不当场了结；可以起一段深仇或盟约的头，但不推到终局。');
  lines.push('   诀窍是留下后续，不在这段里封死。');
  lines.push('   若新起黄区线索，在正文末另起一行写 @@钩子: 当前人物姓名 | 具体悬而未决的事；不冒领别人线索，不自行宣告旧钩子已收尾。');
  lines.push('');
  lines.push('红区——不许碰：');
  lines.push('   杀死或重伤主线要角、改写势力版图与大势、得到会改变你地位的重宝机缘、');
  lines.push('   跨大境界突破、任何会反过来绑住主线走向的事。这些不归你管。');
  lines.push('');
  lines.push('判断口诀：这件事会不会变成「反过来约束主线的既成事实」？');
  lines.push('会，就是红区，别写；只影响你自己那一小摊、后面能从容接住，就是绿区或黄区。');
  lines.push('');

  // ── 信息边界 ──
  lines.push('【你能知道什么】');
  lines.push('');
  lines.push('信息只有三类来源：');
  lines.push('  一、你当场看见的、听见的、亲身感到的；');
  lines.push('  二、你自己的记忆、学识、过往打听来的消息；');
  lines.push('  三、档案里已经写明的你的事（灵根、常用功法、见过的法宝、性情、公开来历）。');
  lines.push('三类之外，一律不知道。');
  lines.push('');
  lines.push('还没揭开的东西，你只能写出「不对劲」这种感觉：');
  lines.push('  某个东西气机古怪、某个地方透着不寻常、某件事一时参不透。');
  lines.push('  不能当场说出它的确切来历、年代、名号、品级。');
  lines.push('  哪怕你见识广，也只能「辨不真切」「依稀像什么却又说不准」，不能一锤定音。');
  lines.push('');
  lines.push('罗盘、命牌、法盘这类东西只给你粗读数：');
  lines.push('  某个方向有灵气波动、某层级的灵压、带点冷/热/杀伐的气机。');
  lines.push('  它不会告诉你「那是件古宝」「那里镇压着什么」。');
  lines.push('  超出读数的判断，要挂在你自己身上写：「他猜」「他觉得不对劲」。');
  lines.push('');

  // ── 在场 / 离场 ──
  lines.push('【在场和离场，写法不一样】');
  lines.push('');
  lines.push('如果你在场：');
  lines.push('  重点写正文之外的经历；需要接回当前场景时，可在最后交汇段从本人视角重述已发生动作与对话，不改结果。');
  lines.push('  直接写你的反应、你的判断、你身上那点只有你知道的感受。');
  lines.push('  动作留给主正文，你只写「只有你知道」的那一层。');
  lines.push('  涉及主角的内容（他的动作、他的话、你对他评价）合计不超过三成；');
  lines.push('  其余至少七成写你自己的目标推进、你和现场别人的互动、你自己的盘算。');
  lines.push('');
  lines.push('如果你不在场：');
  lines.push('  可以从你上次露面那一刻，一直写到本轮结束。中间空了多久就写多久。');
  lines.push('  但**不许写到本轮终点之后**。');
  lines.push('  主角那边发生了什么，你没有亲见也没人告诉你，你就是不知道。');
  lines.push('');

  // ── 几句提醒 ──
  lines.push('【另外几句】');
  lines.push('');
  lines.push('· 别写 ' + timeText + ' 之后的事。哪怕是「明天打算去……」，也不能写成已经发生。');
  lines.push('· 宁可八十个字是真的，也别写五百个字的水。没发生的人、没说出口的话，一个字都别编。');
  lines.push('  拿不准的地方就写少一点。');
  lines.push('· 多写具体的动作和判断。「把那枚丹药收进袖中，又在洞口压了三块石头」，');
  lines.push('  比「心中充满警惕」有用得多——这些话之后要被拿去还原成状态。');
  lines.push('· 别用「古老」「万载」「上古」「恐怖」「绝望」「莫测」这类词堆气氛，');
  lines.push('  整段合计最多出现一次；同一处气机换个说法分摊。');
  lines.push('· 强烈的情绪用克制的动作承载，不要喊口号、不要煽情独白。');
  lines.push('· 只写叙述。不要输出 <state>、<upstore> 之类的标签。');
  lines.push(`· 本次全文目标 ${maxChars} 字，无下限；通常不超过 ${Math.ceil(maxChars*1.2)} 字，只有必要转折无法压缩时才可再超出。预算在本人各时间段间分配，优先写本段的新经历、决定和结果；前段只用必要的一两句概括，已有正文无需重抄。平淡经历可短。`);
  lines.push('· 简体中文，段落之间直接换行。');
  lines.push('');

  // ── 人称 ──
  if (pov) {
    lines.push('【人称】');
    lines.push(`这一轮统一用「${pov}」的人称，不要中途切换。`);
    lines.push('');
  }

  // ── 格式 ──
  lines.push('【格式】');
  lines.push('第一行，骨架行：');
  lines.push(`## ${renderEventCodes(mat.taskCodes)} | ${name} | 照原著`);
  lines.push('要是偏离了，把「照原著」换成「变异」或「阻断」，再补「 | 依据：……」。');
  lines.push('');
  lines.push('第二行，覆盖声明：');
  lines.push('@@已写: （你写到了哪几条，用 / 隔开，写要点就行）');
  lines.push('@@未写: （有没写的列在这儿；全写了就写「无」）');
  lines.push('@@经历: （每个日期段各写一行，点名本人、写实际动作与结果，每行80字以内）');
  lines.push('');
  lines.push('第三行开始，正文。');
  lines.push('');
  lines.push('关于 @@经历 这一行——它会进这个人的「生平经历」，是要长期留着的：');
  lines.push('  · 写**实际发生了什么**，不是原著的计划。原著说赴约，你没赴成，就写「未能成行」。');
  lines.push('  · 格式照这个来：`[0013年05月@神手谷]独自去了神手谷，没等到人`');
  lines.push('  · 时间和地点用上面材料里给的，别自己编。');
  lines.push('  · 一行80字以内，保留本人动作和结果，不能用全局背景代替；完整个人视角在正文展开。');
  lines.push('');
  lines.push('差不多是这样：');
  lines.push(`## E-044,E-045 | ${name} | 照原著`);
  lines.push('@@已写: 入七玄门 / 结识张铁');
  lines.push('@@未写: 无');
  lines.push('@@经历: [0010年05月@七玄门]入了七玄门，结识张铁');
  lines.push('（正文……）');

  lines.push(renderDiaryContract(),renderEventJourney(material));
  if (mat.parallel) lines.push(renderParallelBoundary(material));
  return lines.join('\n');
}


/** 日记式叙述和生平沿同一日期骨架，生成时一次返回，不增设总结模型。 */
export function renderDiaryContract(format='solo') {
  return [
    '【人物叙述与日期分段】',
    '直接作为这个世界里的人叙述，不自称扮演者，不作身份假设，不写作者分析、任务说明或面向读者的设问。',
    '性格是决定人物选择的首要依据，结合目的和当前动机推演行动；有已确认的性格变化才按变化后的性格行动，不为凑原著结果或制造冲突临时换性格。',
    '若设定集已检索但未命中，依据年表、正文和存档继续；缺少当前性格与动机时，可从已知行为保守推断，基础变量沿原重点演化规则处理。推断不得冒充原著明文设定，不凭空增加师承、宝物、机缘或境界突破。',
    /* 2026-11-02 复盘：这里原来写「按年表事件分段」，和 renderEventJourney 里
     * 「空白期也单独成段」是矛盾的——模型会以为空白期不该出现。
     * 玩家定的规则是按「本人出场」切：空白 → 事件 → 空白 → 事件 → 空白。 */
    '按本人出场分段：本人参与的年表事件各写一组；两次出场之间没有本人戏份的时间（空白期）合并写成一组，不要拆碎；所有组按实际时间先后排列。',
    '每组正文前必须独占一行：### [0010年04月05日@五里沟]；连续时段可写 ### [0010年04月09日—0010年04月10日@彩霞山]。标题后是完整人物视角正文，不用编号冒充日期。',
    '日期精度服从材料：只给到月份就写月份，不臆造具体日时；只叙述本轮允许的经历，不重复以前回合已经保存的段落，不越过本轮终点。本轮刚整理的待保存过往摘要是写作素材，不能误当已写过的正文而跳过。',
    '每组对应一条生平摘要，日期和地点括号须与正文标题逐字一致，摘要只记录该组本人已经发生的行动与结果。摘要不能替代正文；多个事件不能只剩一条笼统经历。',
    format==='batch'?'JSON的story保留上述日期标题和分段；biographyLine是字符串，每个日期段一行[日期@地点]摘要，多行使用\\n。':'正文前可重复多行@@经历: [日期@地点]摘要，每个日期段一行；然后按同样日期标题写正文。',
    '【交汇分段协议】标明需要交汇的人物，先写正文之外的经历，最后独占一行@@交汇开始，再写与玩家主正文交汇的当前末段。story保留此标记供解析，展示时会去除。交汇段只供阅读，不整体解析变量；只由同次AI核验确认普通阶段遗漏的本轮边界应有原著道具，另列最小补齐事实，经原重复过滤兜底再执行。交汇段不得再新增行动、资源变化或需要落变量的心理变化；有新增内容写在前段。前段允许为空，但不能把未写经历藏进交汇段。',
    format==='batch'?'biographyLine只对应前段，handoffBiographyLine对应交汇段；两者均按日期段逐行填写。':'@@经历只对应前段；交汇段摘要在正文前另用@@交汇经历:逐行填写。',
    '无交汇的人物不添加交汇标记，不把无关故事排除解析。篇幅按事件密度分配，写不完如实列未写，不为凑段落发明事件。'
  ].join('\n');
}

export function renderEventJourney(material) {
  const mat=material?.material || {},segments=mat.eventSegments || [];
  if(!segments.length)return '';
  /* ★★★ 2026-11-02 玩家：「原著人物故事最好像我们平常写工作经历一样，时间不要有断层，
   *   上一回合写到哪个日期，下一回合就接着这个日期继续写，目前的逻辑是这样的吗？」
   *
   * 时间轴本身是连续的（本回合起点 = 账本里的世界时间 = 上回合终点），
   * 但提示词里从来没把这件事说清楚，模型就可能只挑「有原著事件的日期」写，
   * 中间空档的日常整段跳过 —— 读起来就像履历中间缺了几个月。
   *
   * 所以这里显式补两条硬约束：
   *   ① 起点必须接住上回合结尾，不能从半路起笔；
   *   ② 两个有事件的日期之间，若有较长空档，必须补上本人那段时间的经历，
   *      让日期串成一条不断的线，而不是只剩几个孤立节点。
   */
  const savedRange = mat.savedProgress?.length ? mat.savedProgress : null;
  // 本轮时间区间：start 就是「上回合写到的时刻」，也是本回合必须接住的起点。
  const span = mat.timeRange && typeof mat.timeRange === 'object' ? mat.timeRange : null;
  const spanStart = String(span?.start == null ? '' : span.start).trim();
  const spanEnd = String(span?.end == null ? '' : span.end).trim();
  return ['【本轮逐事件叙述范围】',
    '下面是同一次写作的时间骨架，不是按日期保证原著结果发生。每个尚未被以前回合保存或被本轮主正文覆盖的事件，按人物性格、边界变异和实际处境写出对应时段的完整个人经历；受阻或改道就写真实过程。不能只写最后时间点，再用一两句回忆替代中间节点。无需逐事件另发请求。',
    /* 日期连续性的两条硬约束 */
    '【日期必须连成一条线，不许断层】',
    (spanStart||spanEnd)?'本轮时间区间：'+(spanStart||'（起点未知）')+' → '+(spanEnd||'（终点未知）')+'。':'' ,
    '· 第一段必须从'+(spanStart?'「'+spanStart+'」':'上回合已经写到的那个日期')+'接着起笔，不能跳过中间的日子从半路开始。',
    /* ★★★ 2026-11-02 复盘发现的活矛盾：
     *
     * 这里原来写「相邻两个日期段之间如果隔了一段空档，也要把本人那段时间在做什么补上」，
     * 而下面「空白期的写法」又要求空白期**单独成段**。
     * 同一份提示词给了两条互斥指令：到底是并进相邻段，还是自己一段？
     * 模型只能二选一，实际会按前者办，空白段永远不出现 —— 
     * 玩家要的「空白期也当一段」就白做了。
     *
     * 现在统一为「独立成段」：空档不并进相邻段，而是自己占一段，
     * 段的切分标准是**本人出场**（见下条），不是按日期硬凑。
     */
    '· 上面列出了本轮的每一个时段（含空白期）。**每个时段各写一段**，一段对应一个 ### 标题，不要把空档并进相邻的段里。',
    '· 空档里写什么：本人那段时间在做什么（日常、赶路、修炼、养伤、人情往来都算），让他这段时间有具体的日子可过，不能只剩几个孤立的节点。',
    '· 相邻两段的首尾时间要咬合：上一段的结束就是下一段的开始，让读者能顺着日期一路读下来，不能出现没交代的日子。',
    '· 每一段的标题日期要真实反映该段内容发生的时段；不要为了凑整把不同时间的事硬塞进同一天。',
    segments.filter(event=>!event.gap).length>1?'· 跨多个年表事件时，在每个日期标题之后、正文之前独占一行写 @@事件: E-001（使用下方对应的实际编号）。空白期写 @@事件: GAP。同日或并行事件也必须标明来源。生平仍只用日期地点标题，不写编号。':'',
    /* 2026-11-02 玩家：「前后年表戏份之间的空白原创故事，也是当作一段处理」。
       空白段是本人自己的日子，不是原著事件，所以必须明确它的边界，
       否则模型会凭空加戏（新法宝/新师承/境界突破），把原著走向带偏。 */
    segments.some(s=>s.gap)
      ? ['【空白期的写法】',
         '标为「空白期」的时段，是原著没有写、但这个人确实在过的时间。写法与其它时段完全一致，不是自由发挥：',
         '· 以本人的性格为首要依据（见上文「当前性格，行动推演的首要依据」），结合本人目标、当前动机和实际处境，站在他的视角推演他这段时间会怎么过。',
         '· 受当前世界形势约束：他所在的地点、身份、周围的人和事、已知的消息，都按本轮终点时的实际状态来，不能跳出这个局面。',
         '· 受走廊壁约束（见上文「本轮原著任务与通用走廊」）：未被打破的约束仍然有效，不因为进了空白期就放开。',
         '· 受各种变异影响（见上文「已被替代，不强推原结果」）：已经被改写的原著结果不得在空白期里被偷偷改回去。',
         '内容上写他自己的日常：修炼、赶路、养伤、人情往来、打探消息、观察环境。',
         '但不许凭空产生改变原著走向的东西：不新得法宝、不新拜师承、不凭空突破境界、不凭空结下新的重要关系。境界和实力只能按既有进度自然推进，不能借空白期越级。',
         '空白期里如果发生了对他有影响的小事，可以写，但只写日常层的影响；涉及原著大事件的内容，只写他在外围的见闻和反应，不替代原著事件本身。'].join('\n')
      : '',
    ...segments.map(event=>event.code+' · '+event.start+' → '+event.end+' · '+event.title+(event.ongoing?'（进行中，只写到本轮终点，不提前完成）':'')+'\n'+event.material),
    mat.provisionalHistory?.length?'【本轮待保存的过往摘要，须在上面各时段展开，不是以前回合已写正文】\n'+JSON.stringify(mat.provisionalHistory):'',
    savedRange?'【以前已保存进度，仅用于判断承接和避免重复；实际覆盖由你结合档案判断】\n'+JSON.stringify(savedRange):'',
    /* ★★★ 2026-11-02 玩家点明了「覆盖」的本质（原话）：
     *   「替换的核心就是上一回合写的内容不允许推翻，那是已发生的客观事实，
     *     虽然是覆盖，实质是续写。这个本质要弄清楚。」
     *
     * 所以这里必须把「续写」这件事讲清楚，而不是靠验收环节拦截。
     * 玩家另一条要求：「我们要做得是优化提示词，让他写得更对，
     * 而不是在验收的时候阻碍他，因为这种很容易就过严格。」
     *
     * 跨回合未完成事件的段落，上一回合已经写出来的内容就是既成事实：
     * 本轮要接着它往后写，不是推倒重来。
     */
    mat.continuingParagraph
      ? ['【这一段是接着上一回合继续写的】',
         '下面这段是上一回合已经写出来的内容，它是**已经发生的客观事实**，不能推翻、不能改写、不能当作没发生过：',
         String(mat.continuingParagraph.text || ''),
         /* 2026-11-02 玩家：「不止是原文，还有更重要的时间区间标题，
          *   这样模型才知道这是在按照时间断点进行续写。」
          * 标题就是时间断点：旧段覆盖哪一段，本轮从哪一刻接上，一目了然。 */
         (mat.continuingParagraph.label
           ? '它的时间区间标题是：### [' + mat.continuingParagraph.label + ']'
             + (mat.continuingParagraph.place ? '（地点：' + mat.continuingParagraph.place + '）' : '')
           : ''),
         (mat.continuingParagraph.from && mat.continuingParagraph.to
           ? (mat.continuingParagraph.from === mat.continuingParagraph.to
             // 单日事件：'04月15日 到 04月15日' 读起来别扭，说成「就在这一刻」。
             ? '也就是说：它写的是 ' + mat.continuingParagraph.from + ' 这一刻发生的事。'
             : '也就是说：它写的是 ' + mat.continuingParagraph.from + ' 到 ' + mat.continuingParagraph.to + ' 这段时间。')
           : ''),
         '本轮要做的是**按时间断点续写**：从 ' + (mat.continuingParagraph.to || '上一回合写到的时刻')
           + ' 这一刻接着往后写，一直到本轮终点' + (spanEnd ? '（' + spanEnd + '）' : '') + '。',
         '写的时候注意：',
         '· 旧内容里已经发生的事、已经说过的话、已经形成的态度，都要当成前提，不能重新安排一遍；',
         '· 不要重复旧内容已经写过的句子，也不要换个说法再讲一遍，直接往下推进；',
         '· 合并后这一段仍然只有一段，标题用覆盖整个时段的时间区间（'
           + (mat.continuingParagraph.from || '旧起点') + '—' + (spanEnd || '本轮终点') + '）。'].join('\n')
      : '',
    '故事保留各时段经过；变量转换以本轮终点的实际状态为准，中途已消耗、失去或归还的物品不得因旧段提及而重新补回。',
    mat.handoffRequired?'此人本轮主正文已涉及：前面按事件补写正文外未覆盖经历，最后另用@@交汇开始接上本轮终点个人视角；交汇末段供阅读，不再整体解析变量。':''
  ].filter(Boolean).join('\n');
}

/** 取玩家覆盖文本；空字符串表示没改过 */
function readOverride(key, overrides) {
  const raw = overrides && overrides[key] != null ? overrides[key] : '';
  return String(raw).trim();
}

/** 统一的时间区间话术 */
function resolveTimeText(range) {
  const r = range && typeof range === 'object' ? range : {};
  const start = String(r.start == null ? '' : r.start).trim();
  const end = String(r.end == null ? '' : r.end).trim();
  if (start && end && start !== end) return `${start} 到 ${end}`;
  return start || end || '这段时间';
}

/**
 * 把玩家提示词里的 {{占位}} 换成真值。
 *
 * 只换认得的；认不得的原样留着——
 * 静默清空会让玩家以为自己写对了，其实是漏了东西。
 */
function fillPlaceholders(template, material, extra) {
  const m = material && typeof material === 'object' ? material : {};
  const mat = m.material || {};
  const goal = mat.goal && typeof mat.goal === 'object' ? mat.goal : null;

  const goalText = goal
    ? renderGoalStack(goal)
    : '（档案里没写你在图什么。按你的性格和处境，就地想一件你最近在办的事。）';

  const taskText = Array.isArray(mat.task) && mat.task.length > 0
    ? mat.task.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : '（这段时间年表没写到你。照自己的性子过日子就行。）';

  const mutatedText = Array.isArray(mat.mutated) && mat.mutated.length > 0
    ? mat.mutated
      .map((x) => {
        const o = String(x && x.original || '').trim();
        const a = String(x && x.actual || '').trim();
        if (!o) return '';
        return a ? `本该：${o}\n实际：${a}` : `本该：${o}`;
      })
      .filter(Boolean)
      .join('\n')
    : '（无。原著的事没有被改写。）';

  const values = {
    '{{人物名}}': String(m.name == null ? '' : m.name).trim() || '（未具名）',
    '{{时间区间}}': extra && extra.timeText ? extra.timeText : resolveTimeText(mat.timeRange),
    '{{人物设定}}': renderProfile(mat.identity),
    '{{当前状态}}': renderState(mat.state, m.name),
    '{{自主目标}}': goalText,
    '{{本来要做的事}}': taskText,
    '{{已被替代的部分}}': mutatedText,
    '{{外面发生了什么}}': String(mat.story == null ? '' : mat.story).trim()
      || '（本轮没有正文。）',
    '{{世界的规矩}}': String(mat.background == null ? '' : mat.background).trim()
      || '（无额外世界规则。）',
    '{{相关的人}}': (Array.isArray(mat.others) ? mat.others : []).join('、') || '（没有特别相关的人。）',
    '{{字数上限}}': String(extra && extra.maxChars ? extra.maxChars : CE_PROSE_BUDGET.coreMax),
    '{{事件编号}}': renderEventCodes(mat.taskCodes),
  };

  let out = String(template);
  for (const [token, value] of Object.entries(values)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * 玩家自定义提示词时，材料另附在末尾。
 *
 * 理由：玩家改的是「怎么写」，材料（设定、状态、要补的事）
 * 是系统按存档和年表现算的，不该让玩家手抄一遍。
 */
function renderMaterialAppendix(material) {
  const m = material && typeof material === 'object' ? material : {};
  const mat = m.material || {};
  if (mat.taskKind === 'autonomous' || mat.autonomous === true) return renderAutonomousPrompt(m);
  const lines = ['', '---', '## 材料（系统附上，不用你抄进提示词）', ''];
  if(mat.handoffRequired)lines.push('【本人物本轮需要交汇】按交汇分段协议接回当前主正文。');
  lines.push(renderNarrativeContext(m));

  // 世界规则与世界大事：正文马上要遵守的世界现状
  if (mat.background) {
    lines.push('【这个世界的规矩和最近的处境】');
    lines.push(mat.background);
    lines.push('');
  }

  lines.push('【格式要求】');
  lines.push(`第一行骨架：## ${renderEventCodes(mat.taskCodes)} | ${String(m.name || '').trim() || '（人物名）'} | 照原著`);
  lines.push('偏离时把「照原著」换成「变异」或「阻断」，并补「 | 依据：……」。');
  lines.push('第二行起：@@已写 / @@未写 覆盖声明 + @@经历，然后正文。');
  lines.push(renderDiaryContract(),renderEventJourney(material));
  lines.push('');
  lines.push('只写叙述，不输出 <state>、<upstore> 之类标签。');

  return lines.join('\n');
}

function renderParallelBoundary(material) {
  const m=material || {}, mat=m.material || {};
  if(mat.eventSegments?.length)return '本人物有本轮逐事件叙述范围，按各时段展开尚未覆盖的经历；无终态缺口不等于中间故事已经写过。';
  return '【原著人物当前视角边界】'+String(m.name || '')+'属于本轮正文未涉及的原著人物；本轮没有其原著缺口要重演。只写本人当前处境、独立目标、判断与克制动作，不重演已覆盖或被改写的原著事件，不把旧账、原著计划或未来结局当成本轮必成结果。原著原文仅作人物和因果参考；已发生正文与当前状态优先。仅用本轮终点前已流逝的时间，在空白中推进个人小事，不能重排既成行程。保持现有骨架/JSON协议，status用变异并在依据说明当前个人视角；@@已写/written只声明正文实际写出的个人动作；生平摘要可至80字，完整正文另写。';
}

function renderNarrativeContext(material) {
  const m=material || {}, mat=m.material || {}, dossier=mat.dossier || {};
  return [renderCanonCorridor(mat),'【当前性格，行动推演的首要依据】\n'+String(mat.state?.personality || mat.state?.性格 || mat.identity?.personality || mat.identity?.性格 || '结构字段尚缺，须从下方本人原著设定核对；缺乏依据时保守行动，不凭剧情需要更换性格。'),dossier.biography?'【设定集检索的本人过往】\n'+dossier.biography:'',dossier.newcomer && dossier.newcomer.fromSetting?'【本人的原著设定】\n'+dossier.newcomer.fromSetting:'',renderProfile(mat.identity),renderState(mat.state,m.name),mat.goal?'【本人目标】\n'+renderGoalStack(mat.goal):'',renderStoryInfluence(dossier),
    '【本轮已发生正文，仅供遵守事实与隔离他人信息】\n'+String(mat.story || ''),
    '【原著参考完整片段，须辨清谁做了什么】\n'+(dossier.pushes || []).map(p=>String(p.text || p.brief || '')).join('\n'),
    mat.covered && mat.covered.length?'【已覆盖，不重演】\n'+mat.covered.join('\n'):'',
    mat.mutated && mat.mutated.length?'【已被替代，不强推原结果】\n'+mat.mutated.map(x=>JSON.stringify(x)).join('\n'):'',
    mat.parallel?renderParallelBoundary(m):''].filter(Boolean).join('\n\n');
}

function renderCanonCorridor(mat){
  if(!mat.canonDecision)return '';
  return '【本轮原著任务与通用走廊】\n'+JSON.stringify({depth:mat.canonTaskDepth,decision:mat.canonDecision})+'\n正常跨节点、跨事件仍须按eventSegments逐段补齐本人尚未覆盖的经历，新人物从实际出场补起；incremental表示从已保存基线接续，不代表只写短时间或最后一个事件，也不缩减经过事件的覆盖。完整与增量都从真实基线自然推演，所需影响不是预定成果；破壁只放开有因果证据的部分，其他未被打破的约束仍有效。不因未来未知冻结境界内进度，不将回忆幻境当真实上限，不自造外力或按日期比例增长。人物性格、动机和实际资源决定行动，最终结果以已确认正文及原执行器回执为准。';
}

function renderStoryInfluence(dossier) {
  if(!dossier || !dossier.storyInfluence)return '';
  const records=(dossier.storyFactRecords || []).map(f=>f.id+' · 主体：'+f.subject+'；'+f.text+'；正文原句：“'+f.evidence+'”').join('\n');
  return '【边界AI已确认的正文影响，保留事实归属】\n'+records+'\n对本人的影响：'+dossier.storyInfluence.reason+'\n联系依据：“'+dossier.storyInfluence.basis+'”\n只据此写本人能够成立的行动与后果，不能把他人物品或行动改成本人的；限知者不能凭空知道场外消息。';
}

/** 与原著补缺分开陈述，避免沿用「必然会发生」的模板误导日常写作。 */
function renderAutonomousPrompt(material, options = {}) {
  const m = material || {};
  const mat = m.material || {};
  const name = String(m.name || '').trim();
  const personality = String((mat.state && (mat.state.personality || mat.state.性格))
    || (mat.identity && (mat.identity.personality || mat.identity.性格)) || '').trim();
  const maxChars = Math.min(Number(options.maxChars) > 0 ? Number(options.maxChars) : CE_PROSE_BUDGET.minorMax, CE_PROSE_BUDGET.minorMax);
  const lines = [
    `你是${name}。本轮只写有限自主生活，非原著必成事实。`,
    `时间仅限${resolveTimeText(mat.timeRange)}；最多 ${maxChars} 字，清淡就更短。`,
    '【既有人物与状态】', renderProfile(mat.identity), renderState(mat.state, name),
    '【已有真实目标】', renderGoalStack(mat.goal),
    '从已有目标里选一件眼下做得了的日常：整理、准备、交谈或常规练习即可；没有条件就如实写停留。',
    '不得额外突破、得宝、预知未来；不得凭空增加资源、重大关系、杀伤人物或改变世界大势。',
    '长期目标只是行动动机，不要求也不宣称这一轮完成。只写已给状态和所知条件支持的小步行动。',
    '严格限知，不知道他人隐秘，不写未来原著。玩家不是行动起点，不替玩家安排结果。',
    renderDiaryContract(options.minor===true?'batch':'solo'),
  ];
  if (personality) lines.push('【当前性格，按此选择日常反应】', personality);
  if (mat.story) lines.push('【本轮正文，仅作已发生背景，避开重复】', mat.story);
  lines.push(renderStoryInfluence(mat.dossier));
  if (mat.background) lines.push('【当前世界处境】', mat.background);
  if (mat.dossier && mat.dossier.ceiling) lines.push('【已有上限，不得提前越过】', String(mat.dossier.ceiling));
  if (options.pov) lines.push(`统一用「${options.pov}」的人称。`);
  if (options.minor === true) {
    lines.push(
      `自主任务编号：${renderEventCodes(mat.taskCodes)}（系统保留，不是原著事件；不要另造 E 编号）。`,
      '本段按本批 JSON 数组格式返回，story 仅填叙述正文，不输出散文骨架或 @@ 行。',
      'status 填「变异」、reason 填「自主生活，非原著必成事实」，written 填正文实际日常动作的字符串数组；做不成可填「阻断」并说明原因。不得填「照原著」。',
    );
    return lines.join('\n');
  }
  lines.push(
    '【沿用既有散文骨架】',
    `## ${renderEventCodes(mat.taskCodes)} | ${name} | 变异 | 依据：自主生活，非原著必成事实`,
    'LIFE 编号仅标识本轮此人的自主任务，不是原著 E 编号；逐字照填，不新增、不混用原著编号。',
    '这里「变异」沿用现有三态格式，仅用于标明自主生活，不表示有一件原著事件被改写。行动做不成可标「阻断」并说明具体依据；不得标「照原著」。',
    '@@已写: （本段实际写出的日常动作，用 / 分隔；不得把长期目标当成已完成）',
    '@@未写: （未做的日常安排；没有则填「无」）',
    '@@经历: （用已给时间和地点写一行实际经历，不编地点，不超过二十字）',
    '然后写正文；声明的日常动作必须在正文出现。只写叙述，不输出 <state>、<upstore> 或执行指令。',
  );
  return lines.join('\n');
}
function renderProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return '（设定集里没有检索到这个人的资料。只写你在这段正文与经历里能确认的部分，不要编造出身、师承、法宝。）';
  }
  const parts = [];
  const fields = [
    ['出身', profile.origin],
    // 性格不在这里出：它单独渲染，因为「原著底子」和「现在的性格」要说清楚区别
    ['外貌', profile.appearance],
    ['境界', profile.cultivation],
    ['擅长', profile.skills],
    ['称谓', profile.titles],
    ['其他', profile.notes],
    ['存档背景', profile.text],
    ['已有生平', profile.deeds],
  ];
  for (const [label, value] of fields) {
    const text = String(value == null ? '' : value).trim();
    if (text) parts.push(`- ${label}：${text}`);
  }
  if (parts.length === 0) {
    const raw = String(profile.text == null ? '' : profile.text).trim();
    if (raw) return raw;
    return '（设定集资料为空。只写能确认的部分，不要编造。）';
  }
  return parts.join('\n');
}

/**
 * 自主目标栈：这是「写作起点倒置」能落地的前提。
 *
 * 用户提供的原版提示词里，这是让 NPC 有自己的事要办的关键字段。
 * 没有它，写出来一定是「主角做了什么，于是我……」。
 */
function renderGoalStack(goal) {
  const parts = [];
  const push = (label, value) => {
    const text = String(value == null ? '' : value).trim();
    if (text) parts.push(`- ${label}：${text}`);
  };

  // 三列是三样东西，不能混：
  //   29 长期目标 → 这辈子在图什么
  //   28 短期目标 → 这一阵要办什么
  //   27 当前动机 → 此刻心里想什么
  // 之前这里把 27 当成「进度」显示，是错的——那会让模型以为进度已经算好了。
  push('你这辈子图的是', goal.ambition || goal.长期目标);
  push('这一阵子要办的是', goal.next || goal.短期目标);
  push('此刻的动机', goal.motive || goal.当前动机);
  push('牵涉到的人和势力', goal.ties);

  if (parts.length === 0) {
    return '（档案里没写你在图什么。按你的性格和处境，就地想一件你最近在办的事，别开无关的新坑。）';
  }
  return parts.join('\n');
}

/** 当前状态：这是防腐烂的关键——已死的不能动，境界不能乱 */
function renderState(state, name) {
  if (!state || typeof state !== 'object') {
    return '（存档里没有这个人的当前状态。默认他活着、状态正常，不要写重伤、突破这类大变化。）';
  }
  const parts = [];
  const push = (label, value) => {
    const text = String(value == null ? '' : value).trim();
    if (text) parts.push(`- ${label}：${text}`);
  };

  if (state.dead === true || state.status === '已故') {
    parts.push('- **这个人已经不在了。** 这段时间的事只能写成生前发生，或由他人转述。');
  } else {
    push('境界', state.cultivation || state.realm);
    push('伤势', state.injury || state.health);
    push('所在地', state.location);
    push('状态', state.status);
    push('年龄', state.age);
  }

  if (parts.length === 0) {
    return `（存档里${name}的状态为空。按正常情况写，不要自行突破或重伤。）`;
  }
  return parts.join('\n');
}

function renderEventCodes(codes) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
  return list.length > 0 ? list.join(',') : '（事件编号）';
}

/**
 * 配角群像提示词：多个小角色合成一次调用。
 *
 * 用户要求（seq 1647）：
 *   「写散文也是一样…很多时候除了重要角色的剧情比较多，
 *     大多数配角的剧情一两句话就搞定」
 *
 * 输出格式沿用原版的 JSON 数组（用户提供的那份提示词就是这么定的），
 * 这样一次调用能稳定拿到多段，也便于程序解析。
 *
 * @param {Array<object>} materials
 * @param {object} [options]
 * @param {number} [options.maxCharsEach=120]
 * @param {string} [options.pov='']
 * @param {object} [options.promptOverrides]
 * @returns {string}
 */
export function buildMinorRolesPrompt(materials, options = {}) {
  const list = Array.isArray(materials) ? materials : [];
  const maxCharsEach = Math.max(Number(options.maxCharsEach)>0?Number(options.maxCharsEach):CE_PROSE_BUDGET.minorMax,...list.map(row=>Number(row.material && row.material.proseMaxChars)||0));
  const pov = String(options.pov == null ? '' : options.pov).trim();

  // 玩家改过配角提示词 → 用玩家那份，配角资料照旧附上
  const custom = readOverride('proseMinor', options.promptOverrides);
  if (custom) {
    const roster = list.map((m, i) => renderMinorEntry(m, i)).join('\n\n');
    const filled = String(custom)
      .split('{{配角列表}}').join(roster)
      .split('{{每人字数}}').join(String(maxCharsEach));
    return [filled, custom.includes('{{配角列表}}') ? '' : roster, renderDiaryContract('batch'),
      `篇幅随真实经历密度决定，上限${maxCharsEach}字：适中200-400字，清淡可更短，纯被动150字内；不为凑数编事。`,
      ...(pov ? [`统一用「${pov}」的人称。`] : [])].join('\n').trim();
  }

  const lines = [];

  lines.push('你是《凡人修仙传》的叙事者。');
  lines.push('');
  lines.push('下面几个配角这段时间各有各的经历。请为每个人写一小段。');
  lines.push('');

  list.forEach((m, i) => {
    lines.push(renderMinorEntry({...m,material:{...m.material,story:'',background:''}}, i));
    lines.push('');
  });

  const sharedStory=String(list[0]?.material?.story || '');
  if(sharedStory)lines.push('【本轮已发生正文，全批共同核对】',sharedStory,'');
  // 世界规则与世界大事：不属于任何一个人，但每个配角都活在里面。
  // 从第一个人的素材里取——同一轮所有人的背景是同一份。
  const sharedBackground = list.length > 0
    ? String((list[0].material || {}).background || '').trim()
    : '';
  if (sharedBackground) {
    lines.push('【这个世界的规矩和最近的处境】');
    lines.push(sharedBackground);
    lines.push('');
    lines.push('这是所有人都活着的世界本来的样子，不必复述，但不能违反。');
    lines.push('');
  }

  lines.push('写法要求（和写主角视角那套一致）：');
  lines.push('1. 每人一段，从**这个人自己的角度**起笔，不要从「主角做了什么」起笔。');
  lines.push(`2. 每人按各自参考篇幅控制全文（未单列时为${maxCharsEach}字），通常不超过参考值的120%，只有必要转折确实无法压缩时才可超出。各时间段独立写本人新经历，前段只概括必要因果，不重抄旧正文；保留多事件各自的关键经过，不为凑字数新编互动。`);
  lines.push('3. 只写这个人能知道的，不写别人的心思，不写未来。');
  lines.push(list.some(m => m && m.material && (m.material.autonomous || m.material.parallel))
    ? '4. 原著补缺按各自清单交代；标为自主生活的角色只写有限日常，非原著必成事实，不要求完成其长期目标。'
    : '4. 上面列的事是他/她必然会去做的；做不成就写清楚是什么挡住了，改做了什么。');
  lines.push('5. 没发生的事不许编造。宁可短，不要注水。');
  lines.push('6. 纯个人尺度的事可以写；会改动大势、杀要角、跨大境界的事不许写。');
  lines.push('7. 简体中文，不输出HTML标签；若新起黄区线索，可在story末尾换行写 @@钩子: 当前人物姓名 | 具体悬而未决的事，不自行宣告收尾。');
  if (pov) lines.push(`8. 统一用「${pov}」的人称。`);
  lines.push('');

  // 格式沿用原版 JSON 数组，一次调用稳定拿多段
  lines.push('【输出格式】');
  lines.push('整个回复只能是一个 JSON 数组，第一个字符是 [，最后一个是 ]。');
  lines.push('不要代码块围栏，不要任何数组之外的文字。');
  lines.push('每个对象含 id、name、story、status、reason、written、unwritten、biographyLine 字段；有交汇时另有handoffBiographyLine。written逐项写正文已完成的内容，unwritten写未完成的；不要虚报完成，biographyLine是一句实际经历。');
  lines.push('[');
  lines.push('  { "id": "C15", "name": "角色名", "status": "照原著", "reason": "", "story": "……", "written": ["正文实际写出的事"], "unwritten": [], "biographyLine": "本轮实际经历" }');
  lines.push(']');
  lines.push('');
  lines.push('status 只填这三种之一：');
  lines.push('  · 照原著：上面列的事照原样发生了');
  lines.push('  · 变异：发生了但被改写了');
  lines.push('  · 阻断：因为处境不允许，没做成');
  if (list.some(m => m && m.material && m.material.autonomous)) {
    lines.push('自主生活角色须填 status="变异"、reason="自主生活，非原著必成事实"；做不成则填"阻断"并给具体reason，禁止填"照原著"。');
    lines.push('自主角色还须返回 written 数组，逐项列出正文实际写出的日常动作；不能把其长期目标照抄成已完成。');
  }
  lines.push('');
  lines.push('注意：');
  lines.push('  · 字符串里不要出现裸的 ASCII 双引号，对话用「」；');
  lines.push('  · 段落换行写成 \\n（反斜杠加 n），不要写成 /n，也不要直接敲回车；');
  lines.push('  · id 照填上面给的那个，正文里不要出现任何编号；');
  lines.push('  · 名单里每个人都必须有对象，一个都不能少。');
  lines.push(renderDiaryContract('batch'));

  return lines.join('\n');
}

/** 配角群像里单个配角的资料块（默认提示词与玩家自定义提示词共用） */
function renderMinorEntry(m, i) {
  const mat = (m && m.material) || {};
  const name = (m && m.name) || `配角${i + 1}`;
  const id = String((m && m.id) || '').trim();

  const lines = [];
  lines.push(renderEventJourney(m));
  if(mat.proseMaxChars)lines.push('【'+String(m.name || '')+'的独立参考篇幅】'+mat.proseMaxChars+'字；已按本人事件段扩展，不因同批而缩成一句，不为凑字数编事，不为卡字数漏节点。');
  lines.push(`--- ${name}${id ? `（${id}）` : ''} ---`);
  if(mat.handoffRequired)lines.push('【本人物本轮需要交汇】最后用@@交汇开始接回主正文，前段与交汇段摘要分别填写。');
  if (mat.taskKind === 'autonomous' || mat.autonomous === true) {
    lines.push(renderAutonomousPrompt(m, { minor: true }));
    return lines.join('\n');
  }
  lines.push(renderNarrativeContext(m));

  if (Array.isArray(mat.task) && mat.task.length > 0) {
    lines.push('这段时间他/她本来要做的事：');
    mat.task.forEach((item) => lines.push(`  · ${item}`));
  } else {
    lines.push('（这段时间没有特别要补的事，写日常即可）');
  }
  return lines.join('\n');
}
