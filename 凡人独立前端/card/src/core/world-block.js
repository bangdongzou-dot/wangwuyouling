// ============================================================
// 世界块：模型确认已经发生的公共世界变化
//
// 世界模型结合实际材料判断公共影响，可以有具体人物参与。
// 个人经历归本人；确实无公共变化时返回有理由的独立成功结果。
// 代码核验输出结构与来源，不按人名数量或关键词重新判定世界范围。
// 杂项阶段只消费已确认的世界正文，不消费人物正文或无变化说明。
// ============================================================

import { parseCharacterTags } from './vector-input.js';
import { resolvePrompt, fillTemplate } from './prompt-registry.js';
import { WORLD_EVENT_CLOSURE_RULE, WORLD_EVENT_OPPORTUNITY_RULE } from './world-events.js';

const WORLD_MACRO_RULES = [
    '提取宏观事件：逐条阅读候选的实际材料，包括具名人物事件正文内的战争、宗门政策、势力消长、秩序与商路、公共资源及群体处境；标题和人物标签不能代替内容判断。按本轮截止时点与变异因果辨别原定、进行中、已成立和未发生，不因原著写过就全部兑现。',
    '记事标准：只报道影响一个地区、国家、修仙界主要势力格局或大量群体共同处境的重大变化，如国战与宗门大战、势力兴衰、跨区域商路与资源格局、影响广大修士的大会或秘境开放。不是一切公共活动都算世界大事：村落抢粮、普通门派招生考核、个人拜师入谷、药园日常和私人冲突不录入；不能添加“局势紧张”等套话把微观经历拔高。按实际后果判断，不凭事件编号、主角身份或出现“宗门”二字认定。',
    '对玩家可获知且确实可参与的重要主线或限时机缘，登记实际开放、参与方式和实际关闭条件；即使影响范围小也可登记。播报写法：采用简短、客观的局势新闻，不写NPC视角正文。每件事用一句短标题和60至120字概况，说明时间、地区/主要势力、已经发生的变化及影响范围；没有材料支持的伤亡、规模、因果与传闻不补造。只写实质新进展，无符合尺度的大事时明确无变化，不能凑数。',
    '对照已有世界记事：同一局势未变化不重复新增，发展、逆转或纠错应承接原记录与实际进度。原著宏观事件是参考，NPC故事产生的新公共后果也要核对。交代何时、何地、什么发生了变化及持续影响；不把密谋变成公开传闻，不无因推演玩家知晓。',
];

/** 世界块的人物名（固定，用于骨架行） */
export const CE_WORLD_NAME = '世界';

/** 一个世界块最多容纳多少条事件 */
export const CE_WORLD_MAX_EVENTS = 12;

/**
 * 旧候选分类辅助。仅保留兼容入口，不能作为实际世界范围判据。
 *
 * 判据是「有没有人可代入」：
 *   有具体 NPC → 该走 NPC 块（那边写得深）
 *   没人或只有泛称 → 走世界块
 *
 * 注意：不是「有没有主角」，是「有没有任何一个能代入的人」。
 * 「七玄门弟子(尸)」这种泛称不算可代入。
 *
 * @param {object} entry 年表条目
 * @param {object} [options]
 * @param {string[]} [options.knownNames] 有档案的人物名（这些算可代入）
 * @param {number} [options.minNamed=1] 至少几个可代入的人才走 NPC 块
 * @returns {{belongs:boolean, reason:string, named:string[], generic:string[]}}
 */
export function shouldBelongToWorld(entry, options = {}) {
  const title = String(entry && entry.title || '');
  const tags = parseCharacterTags(title);

  const known = Array.isArray(options.knownNames)
    ? options.knownNames.map((n) => String(n || '').trim()).filter(Boolean)
    : null;

  const named = [];
  const generic = [];

  for (const tag of tags) {
    const name = String(tag.name || '').trim();
    if (!name) continue;

    // 泛称：弟子、长老、众人、路人、某个 + 身份
    const isGeneric = /^(某|一|众|路|旁|有)|弟子|长老|修士|凡人|众人|手下|侍卫|侍女|客卿|散修|妖|兽/.test(name)
      && !(known && known.includes(name));

    // 已故/尸体这类状态标注，说明这条不靠他推进
    const isDead = /已故|尸|死|亡/.test(String(tag.status || ''));

    if (known && known.includes(name)) named.push(name);
    else if (isGeneric || isDead) generic.push(name);
    else named.push(name);
  }

  const minNamed = Number(options.minNamed) > 0 ? Number(options.minNamed) : 1;
  const belongs = named.length < minNamed;

  let reason = '';
  if (belongs) {
    reason = named.length === 0
      ? (generic.length > 0 ? '只有泛称人物，没有可代入的具体角色' : '没有人物标签，是无主角的全局变化')
      : `可代入人物不足（${named.length} < ${minNamed}）`;
  }

  return { belongs, reason, named, generic };
}

/**
 * 旧候选分类批处理。生产写作入口不依赖此启发式筛选。
 *
 * @param {Array<object>} candidates
 * @param {object} [options]
 * @returns {{entries:Array<object>, skipped:Array<{entry:object, reason:string}>}}
 */
export function pickWorldEntries(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const entries = [];
  const skipped = [];

  for (const entry of list) {
    const verdict = shouldBelongToWorld(entry, options);
    if (verdict.belongs) entries.push(entry);
    else skipped.push({ entry, reason: verdict.reason || '有人可代入，走 NPC 块' });
  }

  // 一个区间一块，超了就截断（§10-Q4）
  //
  // ⚠️ 截断可以，**静默**截断不行。
  //
  // 原来是 `entries.slice(0, 12)`，超出的那些直接从返回值里消失，
  // 调用方拿到的 `skipped` 里也没有它们 —— 等于没发生。
  // 玩家推进三年，25 条世界事件只写 12 条，剩下 13 条无声蒸发。
  //
  // 现在：超上限的部分显式记进 `overflow`，调用方必须消费它
  // （下一批继续，或记成欠账），不许当没看见。
  const capped = entries.slice(0, CE_WORLD_MAX_EVENTS);
  const overflow = entries.slice(CE_WORLD_MAX_EVENTS);

  return {
    entries: capped,
    skipped,
    overflow,
    overflowCount: overflow.length,
  };
}

/**
 * 默认提示词。玩家可在设置面板里改（注册表 key = 'worldBlock'）。
 * @returns {string}
 */
function defaultWorldPrompt() {
  return [
    '你在为一段《凡人修仙传》的文字游戏补写「世界在别处发生了什么」。',
    '',
    '世界范围统一判据：根据候选原著材料、本轮已成立正文与已保存事实，判断是否已经改变势力、地域、公共秩序、群体处境、公共资源或共同可知的消息。',
    '具体人物可以是世界变化的参与者或原因；不能仅凭出现人名或没有人名分类。只有人物自己的修炼、采药、疗伤、行程等个人经历，且没有上述公共影响时，归本人记录。',
    '候选只表示需要核查，不保证已经产生世界变化。世界范围由你结合实际因果判断；不得为凑世界大事而夸大个人经历或把未来计划写成既成事实。',
    ...WORLD_MACRO_RULES,
    '',
    '写法（这是硬要求）：',
    '1. 当前局势新闻简报：从整体世界格局概括已成立事实，不代入任何NPC，也不写多年后的回忆录。',
    '2. 只写**结果与规模**：「两派打了一仗，死伤两百余人」「那一带从此荒了」。',
    '   不把个人内心或对话冒充世界结果。',
    '3. 用客观第三人称，不写「你」。玩家是否在场或知情只认实际正文；远方世界变化不能自动变成玩家已经知晓。',
    '4. 只写后来会被人知道的部分。无人知晓的密室之事，不要写成公开消息。',
    '5. 不给确切数字之外的花哨形容，不堆「古老」「万载」这类词。',
    '6. 宁可六十个字是真的，不要两百个字的水。',
    '',
    '输出格式：',
    '有实际世界变化：第一行骨架为 ## 本次事件号 | 世界 | 照原著（发生自然变异时写变异），第二行起是已成立世界正文。不要输出 <state>、<upstore> 之类指令标签。',
    '确实没有世界变化：只输出 JSON：{"noChange":true,"reason":"结合材料说明为什么只有个人经历、尚未发生或公共局势没有改变"}。reason必须是明确、非空的判断理由。',
    '无变化是正常成功结果，不要编正文。调用错误、资料不足而无法判断或不遵守协议不能冒充无变化。',
    '',
    /* ★★★ 2026-11-03 玩家：「不要生成重复事件了，所以这也是为什么需要把两者都放进去的原因，
     *   刚好也会成为原著补演生成原著相关大事件的提示词，避免重复生成。」
     *
     * 【为什么必须有这一条】世界大事有两个来源，它们在资料里已经合并成同一份清单：
     *   · 玩家原创剧情打出来的大事（addWorldEvent 落库）
     *   · 原著年表里的大事（带 E-n 编号、带开放态）
     * 这份合并清单既给玩家看，也**作为已有台账喂给模型**。
     * 如果不说清「先查台账」，模型很容易把同一件事换个说法再记一遍 ——
     * 尤其原著年表事件：模型看到候选年表条目，会以为「还没记过」，
     * 于是把太南小会、虚天殿开启这些已经在上面的东西重新写成新世界事件，
     * 大事记里就出现两条几乎一样的记录。
     *
     * 【所以这里明确三件事】
     *   ① 台账里有同一件事 → 不要再新增，最多在原条目上推进状态（开始→进行中→结束/变异）；
     *   ② 同一件事的不同阶段不算重复 —— 那是同一件的推进，要写就写推进，不要另起一条；
     *   ③ 判断「同一件事」看的是**因果与参与方**，不是字面是否完全一样；
     *      换个措辞、换个视角重述同一场大会/大战，依然算重复。 */
    '【先查已有大事台账，不要重复生成】',
    '材料中的【世界大事】就是当前已登记的全部大事（玩家原创 + 原著年表，两者地位相同）。',
    '新增前必须先比对：因果、参与方、地点、时间指向的是同一件事，就**不要新增一条**。',
    '同一事件的不同阶段沿用原编号。冲突中的决战胜负、联军撤离和冲突平息都是原冲突的进展或结案，写入原记录并保留已经确认的结案事实。',
    '判断是否同一件事看因果与参与方，不看字面是否相同；换个措辞重述同一场大会或大战，仍然算重复。',
    '原著年表事件若已在台账里（带 E- 编号），不要再把它当成新的世界事件写一遍；',
    '只有它确实发生了新的公共变化时，才写这次推进，并沿用同一个事件号。',
  ].join('\n');
}

/**
 * 取生效的世界块提示词。
 * @param {object} [overrides]
 * @returns {string}
 */
export function worldPrompt(overrides) {
  return resolvePrompt('worldBlock', { defaultText: defaultWorldPrompt() }, overrides);
}

/**
 * 组装世界块的写作提示词。
 *
 * @param {object} input
 * @param {Array<object>} input.entries 该进世界块的事件
 * @param {string[]} [input.missing] 差集里未覆盖的条目
 * @param {string} [input.storyText] 本轮正文（用来避免重复）
 * @param {object} [input.timeRange] { start, end }
 * @param {object} [input.options]
 * @param {number} [input.options.maxChars=200]
 * @param {object} [input.options.promptOverrides]
 * @returns {string}
 */
export function buildWorldBlockPrompt(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const missing = Array.isArray(input.missing) ? input.missing : [];
  const options = input.options || {};
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 200;

  const range = input.timeRange || {};
  const timeText = range.start && range.end && range.start !== range.end
    ? `${range.start} 到 ${range.end}`
    : (range.start || range.end || '这段时间');

  const codes = entries
    .map((e) => String(e && e.eventCode || '').trim())
    .filter(Boolean);

  // 事件列表：每条「编号 标题」+ 材料正文
  const entryLines = [];
  if (entries.length === 0) {
    entryLines.push('（没有）');
  } else {
    for (const e of entries) {
      const code = String(e && e.eventCode || '').trim();
      const title = String(e && e.eventTitle || '').trim();
      const text = String(e && e.material || '').trim();
      entryLines.push(`· ${code}${title ? ` ${title}` : ''}`);
      if (text) entryLines.push(`  ${text}`);
    }
  }

  const missingText = missing.length > 0
    ? missing.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '无';

  const story = String(input.storyText || '').trim();

  // 文风模板可以覆盖；候选来源、范围和结果协议仍必须随请求传入。
  const template = worldPrompt(options.promptOverrides);
  const body = fillTemplate(template, {
    '{{时间区间}}': timeText,
    '{{事件列表}}': entryLines.join('\n'),
    '{{没写到的}}': missingText,
    '{{本轮正文}}': story || '（本轮正文还没写到这些事）',
    '{{字数上限}}': String(maxChars),
  });

  // 范围与输出契约是执行协议，不能被自定义文风模板省略。
  const codeHint = '骨架行第一段仅从以下候选编号中选择实际支撑本次世界新闻的编号，逐个用逗号分隔：' + (codes.length > 0 ? codes.join(',') : '（事件编号）');
  const evidence = [];
  if (!template.includes('{{事件列表}}')) evidence.push('【本次候选材料】',entryLines.join('\n'));
  if (!template.includes('{{本轮正文}}')) evidence.push('【本轮已成立正文，仅供判断公共影响，不能把个人经历直接写成世界大事】',story || '（无）');
  return [body, '', '---', '', '【本轮实际时间区间】', timeText, '', ...evidence, '', '【已保存世界局势、世界规则与本轮设定，仅供依据核对；设定和未来参考不等于既成事实】', String(input.background || '').trim() || '（未取得额外世界背景，以本次实际材料继续，不补造设定）', '',
    '【统一世界判据与结果协议】',
    ...WORLD_MACRO_RULES,
    WORLD_EVENT_CLOSURE_RULE,
    WORLD_EVENT_OPPORTUNITY_RULE,
    '由你按实际因果判断势力、地域、公共秩序、群体处境、公共资源或共同消息是否已经改变；具体人物可参与世界变化，单纯个人经历归本人。候选不是必成目标，不重演已成立事实，不新增来源以外的因果。',
    '有变化输出含完整骨架行的世界正文；骨架严格是“事件号|世界|状态”，中间必须逐字写“世界”，地区写在正文。多个事件号用英文逗号逐个列出，禁止E-001～E-003范围写法；只列确实支撑本次宏观变化的候选编号，不要求把全部候选写进世界新闻。无变化只输出 {"noChange":true,"reason":"明确判断理由"}。不得把缺字段、解析失败或调用失败当成无变化。',
    codeHint].join('\n');
}

/**
 * 解析世界块输出。
 *
 * 与 NPC 块不同的地方：**不要求覆盖声明**。
 * 理由是这块没有「我写没写到我自己的事」这层自评，
 * 硬要它写只会变成走过场。
 *
 * @param {string} raw
 * @returns {{ok:boolean, block:object|null, reason:string}}
 */
export function parseWorldBlock(raw) {
  let text = String(raw == null ? '' : raw).trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  if (!text) return { ok: false, block: null, reason: '空输出' };

  let payload = raw && typeof raw === 'object' ? raw : null;
  if (!payload && /^\{/.test(text)) {
    try { payload = JSON.parse(text); }
    catch (_) { return {ok:false,block:null,reason:'世界结果不是合法 JSON'}; }
  }
  if (payload) {
    if (Array.isArray(payload)) return {ok:false,block:null,reason:'世界结果必须是对象'};
    /* ★★ 2026-11-02 全面复盘：原来「有 error 字段」和「success===false」挤成一句。拆开。 */
    if (payload.error) return {ok:false,block:null,reason:'世界结果里带着执行错误：' + String(payload.error).slice(0, 120) + '；不能按无变化成功处理'};
    if (payload.success === false) return {ok:false,block:null,reason:'世界结果标记了 success=false，说明本次世界演化没有成功；不能按无变化成功处理'};
    if (Object.prototype.hasOwnProperty.call(payload,'noChange') && typeof payload.noChange !== 'boolean') return {ok:false,block:null,reason:'无变化声明必须是布尔值'};
    if (payload.noChange === true) {
      const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
      if (!reason) return {ok:false,block:null,reason:'无变化缺少明确判断理由'};
      if ([payload.block,payload.story,payload.body].some(value => value != null && String(value).trim())) return {ok:false,block:null,reason:'无变化声明与世界正文矛盾'};
      return {ok:true,block:null,noChange:true,reason};
    }
    const value = payload.block !== undefined ? payload.block : payload.story;
    if (typeof value !== 'string' || !value.trim()) return {ok:false,block:null,reason:'世界结果缺少正文或明确无变化声明'};
    text = value.trim();
  }
  if (!/^##\s*[^\r\n]+\n/.test(text.replace(/\r\n/g,'\n'))) return {ok:false,block:null,reason:'世界正文缺少完整骨架行'};

  const lines = text.split(/\r?\n/);
  let header = '';
  const bodyLines = [];
  let seenBody = false;

  for (const line of lines) {
    const t = line.trim();
    if (!seenBody && /^##\s*/.test(t)) {
      header = t.replace(/^##\s*/, '');
      continue;
    }
    if (!seenBody && !t) continue;
    seenBody = true;
    bodyLines.push(line);
  }

  const body = bodyLines.join('\n').trim();
  if (!body) return { ok: false, block: null, reason: '只有骨架行，没有正文' };

  const parts = header.split('|').map((p) => p.trim());
  const eventIds = String(parts[0] || '')
    .split(/[\s,，、]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const name = parts[1];
  const status = parts[2];
  /* ★★ 2026-11-02 全面复盘「合并报错」：原来 4 种情况挤成一句。拆开。 */
  if (parts.length !== 3) return {ok:false,block:null,reason:'世界正文的骨架行格式不对：应该用「|」分成 3 段（事件号|世界|状态），实际分成了 '+parts.length+' 段'};
  if (!eventIds.length) return {ok:false,block:null,reason:'世界正文的骨架行没有事件号：至少要写一个形如 E-001 的事件编号'};
  {
    const badId = eventIds.find(id => !/^E-\d+$/.test(id));
    if (badId) return {ok:false,block:null,reason:'世界正文的骨架行事件号格式不对：写成了「'+String(badId)+'」；应为 E-数字，如 E-001'};
  }
  if (!status) return {ok:false,block:null,reason:'世界正文的骨架行缺少状态：三段中的第三段不能为空，需要写出照原著或变异'};

  if (name !== CE_WORLD_NAME) {
    return {
      ok: false, block: null,
      reason: `骨架行的人物名应是「${CE_WORLD_NAME}」，实际是「${name}」`,
    };
  }

  return {
    ok: true,
    block: {
      eventIds,
      name: CE_WORLD_NAME,
      status,
      body,
    },
    reason: '',
  };
}

/**
 * 世界块的结构自查。世界语义由世界模型判断，不能用人名计数推翻。
 *
 * @param {string} body
 * @param {string[]} [knownNames] 已知人物名
 * @returns {{ok:boolean, hits:string[], reason:string}}
 */
export function auditWorldBlock(body, knownNames) {
  const text = String(body || '');
  if (!text.trim()) return { ok: false, hits: [], reason: '没有正文' };

  const names = Array.isArray(knownNames) ? knownNames.filter(Boolean) : [];
  const hits = [];
  for (const name of names) {
    if (name && text.includes(name)) hits.push(name);
  }

  return { ok: true, hits, reason: '' };
}

/**
 * 把世界块渲染成给杂项阶段吃的样子（§4.8：消费方是杂项管理阶段）。
 *
 * @param {object|null} block
 * @returns {string}
 */
export function renderWorldBlockForMisc(block) {
  if (!block || typeof block !== 'object') return '';
  const codes = Array.isArray(block.eventIds) ? block.eventIds.join(',') : '';
  const body = String(block.body || '').trim();
  if (!body) return '';

  return [
    `## ${codes || '（事件编号）'} | ${CE_WORLD_NAME} | ${block.status || '照原著'}`,
    body,
  ].join('\n');
}
