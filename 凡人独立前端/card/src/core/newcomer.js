// ============================================================
// 新人建档：存档里没有这个人，他的初始信息从哪来
//
// 用户 2026-10-21：
//   「这是已有的npc的处理方式，但是很多时候都是新建原著npc，当前信息是零，
//     那么初始信息我们怎么找呢？尤其是性格设定这些，就需要从向量库调取信息」
//
// ------------------------------------------------------------
// 两条线，泾渭分明：
//
//   **已建档的人**（存档里有）→ 读存档，第 3/4/12/15/16/27/28/29/31/32 列
//   **没建档的人**（新人）    → 存档是零，只能现查
//
// 新人能查的只有两个地方，而且必须按顺序：
//
//   ① **设定集**（向量库里的《凡人修仙设定集—人物篇》）
//      性格、出身、外貌、境界、师承、称谓——这些是「原著设定」，
//      只有这里有。查不到就没有，不能编。
//
//   ② **年表本身**（这个人在这段时间涉及的事件 brief）
//      他这几个月在干什么、身边有谁、遇上什么事。
//      这是**当下**的信息，设定集里没有。
//
// 两个都拿到，才够写一段 NPC 视角正文。缺 ①，人物是空壳；
// 缺 ②，不知道这段时间他该干嘛。
//
// ------------------------------------------------------------
// 为什么不用「让模型编一个合理的」：
//
//   原著人物是有既定人设的。编出来的性格，跟后面几十轮的演化对不上，
//   而且一旦落了档，后面所有轮都按这个错的走。
//   宁可写「设定集里没查到，只写能确认的部分」，也不要编。
// ============================================================

/** 从设定集检索结果里，认出「这是谁的资料」 */
export const CE_DOSSIER_SECTIONS = {
  identity: '人物设定',
  events: '年表里的事',
  missing: '查不到的',
};

/** 设定集里必须有的字段（缺了要报，不悄悄降级） */
export const CE_NEWCOMER_REQUIRED = ['性格', '出身', '境界'];

/** 向量检索返回的段落标题前缀（卡内格式） */
const SECTION_HEAD_RE = /^###\s*标题[:：]\s*/;

/**
 * 判断这个人是不是新人。
 *
 * @param {string} name
 * @param {object} characters bridge 读出的人物表 { [name]: {...} }
 * @returns {boolean}
 */
export function isNewcomer(name, characters) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return false;
  const table = characters && typeof characters === 'object' ? characters : {};
  const hit = table[n];
  if (!hit) return true;
  // 有档案行但全空，等于没有：只能算新人
  const st = hit.state && typeof hit.state === 'object' ? hit.state : {};
  const pf = hit.profile && typeof hit.profile === 'object' ? hit.profile : {};
  const hasAny = ['cultivation', 'identity', 'status', 'personality']
    .some((k) => String(st[k] == null ? '' : st[k]).trim() !== '')
    || String(pf.text == null ? '' : pf.text).trim() !== '';
  return !hasAny;
}

/**
 * 给新人拼检索输入。
 *
 * 关键：**只用这个人名和他在年表里的事**，不要把整段年表丢进去。
 * 整段丢进去，检索到的是「这段时间发生了什么」，不是「这个人是谁」——
 * 性格查不出来，全是剧情。
 *
 * @param {object} input
 * @param {string} input.name
 * @param {Array<{code?:string,title?:string,time?:string,brief?:string}>} [input.events]
 * @returns {string}
 */
export function buildNewcomerQuery(input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name || '').trim();
  if (!name) return '';

  const events = Array.isArray(src.events) ? src.events : [];
  const lines = [];

  lines.push(`【人物】${name}`);
  lines.push('');
  lines.push('请找出这个人的人物设定：性格、出身、外貌、境界、师承、称谓、经历。');

  if (events.length > 0) {
    lines.push('');
    lines.push('【他在这段时间里出现在这些事里】');
    for (const e of events.slice(0, 8)) {
      const head = [e.time, e.code, e.title].filter(Boolean).join(' ');
      if (head) lines.push(`· ${head}`);
      const brief = String(e.brief || '').trim();
      if (brief) lines.push(`  ${brief.length > 160 ? `${brief.slice(0, 160)}……` : brief}`);
    }
  }

  return lines.join('\n');
}

/**
 * 把设定集检索结果切成段，只留跟这个人有关的。
 *
 * 卡内的检索会返回多段（每段一个 `### 标题: ...`）。
 * 可能带回别人的资料——必须按人名筛，否则张铁的性格会写进韩立身上。
 *
 * @param {string} raw getVectorContext 的返回
 * @param {string} name
 * @returns {{sections:Array<{title:string,body:string}>, related:string, all:string}}
 */
export function pickNewcomerSections(raw, name, aliases=[]) {
  const text = String(raw == null ? '' : raw);
  const n = String(name == null ? '' : name).trim();
  const names=Array.from(new Set([n,...(Array.isArray(aliases)?aliases:[])].map(value=>String(value || '').trim()).filter(Boolean)));
  if (!text) return { sections: [], related: '', all: '' };

  const chunks = text.split(/\n(?=###\s)/).map((s) => s.trim()).filter(Boolean);
  const sections = chunks.map((chunk) => {
    const firstLine = chunk.split('\n')[0] || '';
    const title = sectionTitle(firstLine);
    return { title, body: chunk, chunk };
  });

  // 标题里带这个人名 → 一定是他的
  // 标题不带但正文频繁提到 → 也算（有些条目是「七玄门弟子」这种泛称）
  const related = sections.filter((s) => {
    if (!n) return false;
    return names.some(token=>s.title.includes(token) || countOccurrences(s.chunk,token)>=2);
  });

  const relatedText = related.map((s) => s.chunk).join('\n\n');
  return {
    sections: sections.map((s) => ({ title: s.title, body: s.body })),
    // 筛完是空的，调用方要当「查不到」处理，不能退回全文——
    // 退回全文等于把别人的设定塞给他
    related: relatedText,
    all: text,
  };
}

/** 从 `### 标题: XXX [...]` 里取 XXX */
function sectionTitle(line) {
  const s = String(line == null ? '' : line).trim();
  const m = SECTION_HEAD_RE.exec(s);
  if (!m) return s.replace(/^###\s*/, '').slice(0, 60);
  return s.slice(m[0].length).split('[')[0].trim();
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = text.indexOf(needle, i);
    if (at < 0) break;
    n += 1;
    i = at + needle.length;
  }
  return n;
}

/**
 * 拼新人档案。
 *
 * 输出直接进 dossier.pushes 之外的另一个字段 `newcomer`，
 * 让散文和边界判定都知道「这个人的底子是查来的，不是存档里的」。
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.settingText] 设定集检索结果（已经筛过）
 * @param {Array} [input.events] 年表里他的事
 * @param {boolean} [input.fetchFailed] 检索本身失败了
 * @returns {{name:string, fromSetting:string, fromTimeline:string, missing:string[], degraded:boolean}}
 */
export function buildNewcomerProfile(input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = String(src.name || '').trim();
  const setting = String(src.settingText || '').trim();
  const events = Array.isArray(src.events) ? src.events : [];

  const fromTimeline = events.map((e) => {
    const head = [e.time, e.code, e.title].filter(Boolean).join(' ');
    const brief = String(e.brief || '').trim();
    return brief ? `${head}：${brief}` : head;
  }).filter(Boolean).join('\n');

  const missing = [];
  if (!setting) missing.push('设定集');
  if (!fromTimeline) missing.push('年表');

  // 设定集到了，但关键字段没提到 → 也算缺，只是缺得轻一点
  const lacks = [];
  if (setting) {
    for (const field of CE_NEWCOMER_REQUIRED) {
      if (!mentionsField(setting, field)) lacks.push(field);
    }
  }

  return {
    name,
    fromSetting: setting,
    fromTimeline,
    missing: missing.concat(lacks.map((f) => `设定集里的${f}`)),
    // 设定集没查到就是降级：写出来的人物是薄的，得让人知道
    degraded: !setting,
    fetchFailed: src.fetchFailed === true,
  };
}

/** 粗略判断一段设定资料里提没提到某个字段 */
function mentionsField(text, field) {
  const t = String(text || '');
  if (!field) return false;
  if (t.includes(field)) return true;
  // 同义写法
  const alias = {
    性格: ['性性', '性子', '为人', '秉性', '天性'],
    出身: ['出身', '来历', '籍贯', '家世'],
    境界: ['境界', '修为', '炼气', '筑基', '金丹'],
  };
  return (alias[field] || []).some((a) => t.includes(a));
}

/**
 * 把新人档案渲染成给模型看的一段（推演和散文都用）。
 *
 * @param {object|null} profile
 * @returns {string}
 */
export function renderNewcomerProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : null;
  if (!p) return '';
  const lines = [];

  if (p.fromSetting) {
    lines.push('【原著里关于他这个人的设定】');
    lines.push(p.fromSetting);
  } else {
    lines.push('【设定集里没查到这个人】');
    lines.push('按已有年表、正文和存档继续。可从已知行为保守推断性格和动机，未明确的基础变量沿原重点演化规则填写；推断不能冒充原著明文设定。不得凭空新增师承、宝物、机缘或境界突破。');
  }

  if (p.fromTimeline) {
    lines.push('');
    lines.push('【年表里这段时间他的事】');
    lines.push(p.fromTimeline);
  }

  if (Array.isArray(p.missing) && p.missing.length > 0) {
    lines.push('');
    lines.push(`（缺：${p.missing.join('、')}）`);
  }

  return lines.join('\n');
}
