// ============================================================
// 黄区钩子记账
//
// 依据（总设计 §4.9）：
//
//   NPC 视角正文的三区设计（绿 / 黄 / 红）不是写作风格建议，
//   是**权限分区**：
//
//     绿区（纯个人尺度）  ：NPC 视角正文的领地，放开写。写完就完了。
//     黄区（可发生不定死）：NPC 正文起头，后续交主线。**必须记账。**
//     红区（杀要角/改版图/得重宝/跨大境界）：补演与主线的专属领地，
//                           NPC 正文不许碰。补演会管，不用记。
//
//   **黄区是唯一需要跨轮记忆的区。**
//   绿区的事完了就完了，红区的事补演会管，黄区起的头没人管就会烂尾——
//   下一轮 NPC 视角正文不记得「董萱儿正在打听筑基丹份额」，
//   会给她编一段全新的生活。
//
// ------------------------------------------------------------
// 所以要记三件事，缺一不可：
//
//   谁起的头   who
//   起的是什么 hook
//   什么时候该收（寿命 3 轮，§10-Q7）
//
//   超时 → 记「烂尾」并提示玩家。静默丢失是最坏的结果。
//
// ------------------------------------------------------------
// 存哪里（§4.12.2 铁律）：
//
//   黄区钩子必须在 currentState 里，不能单独存。
//   否则回退时它不跟着回去——玩家回退到三轮前，
//   却还记着「正在打听筑基丹份额」，那是个已经不存在的世界。
// ============================================================

/** 黄区钩子默认寿命（轮） */
export const CE_HOOK_LIFETIME = 3;

/** 钩子状态 */
export const CE_HOOK_STATUS = {
  /** 还开着，下一轮要带上 */
  open: '待收尾',
  /** 已经收掉了 */
  closed: '已收尾',
  /** 超时没收，烂尾了 */
  stale: '烂尾',
};

/**
 * 规范化一条钩子。
 *
 * @param {any} item
 * @returns {object|null}
 */
export function normalizeHook(item) {
  if (!item || typeof item !== 'object') return null;

  const who = String(item.who == null ? '' : item.who).trim();
  const hook = String(item.hook == null ? '' : item.hook).trim();
  if (!who || !hook) return null;

  const born = Number(item.bornTurn);
  const closedAt = Number(item.closedTurn);

  return {
    who,
    hook,
    // 哪一轮起的头。没有就记 0，意思是「不知道，按最早的算」
    bornTurn: Number.isFinite(born) && born > 0 ? Math.floor(born) : 0,
    closedTurn: Number.isFinite(closedAt) && closedAt > 0 ? Math.floor(closedAt) : 0,
    status: normalizeStatus(item.status),
    note: String(item.note == null ? '' : item.note).trim(),
  };
}

function normalizeStatus(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === CE_HOOK_STATUS.closed) return CE_HOOK_STATUS.closed;
  if (s === CE_HOOK_STATUS.stale) return CE_HOOK_STATUS.stale;
  return CE_HOOK_STATUS.open;
}

/**
 * 从散文块里捡黄区钩子。
 *
 * 散文本身不区分「这是黄区钩子」，所以要靠写作者显式标记。
 * 约定：正文里出现 `@@钩子: 人物 | 内容` 这样一行。
 *
 * 为什么用显式标记而不是让模型自己判断：
 *   三区判定权在写作者（§10-Q6），但**记账**必须能被代码抓到。
 *   没有显式标记就抓不到，抓不到就会烂尾。
 *
 * @param {string} body 散文正文
 * @returns {Array<{who:string, hook:string}>}
 */
export function extractHooks(body) {
  const text = String(body == null ? '' : body);
  const out = [];
  const re = /^@@\s*钩子\s*[:：]\s*(.+)$/gm;

  let m = re.exec(text);
  while (m) {
    const line = String(m[1] || '').trim();
    if (line) {
      const parts = line.split('|').map((p) => p.trim());
      const who = parts[0] || '';
      const hook = parts.slice(1).join('|').trim() || parts[0] || '';
      if (who && hook) out.push({ who, hook });
    }
    m = re.exec(text);
  }

  return out;
}

/**
 * 把这一轮新起的钩子并入账。
 *
 * @param {Array} hooks 现有钩子
 * @param {Array<{who:string, hook:string}>} fresh 本轮新起的
 * @param {number} turnNo 当前轮号
 * @returns {{hooks:Array, added:number}}
 */
export function addHooks(hooks, fresh, turnNo) {
  const list = (Array.isArray(hooks) ? hooks : [])
    .map((h) => normalizeHook(h))
    .filter(Boolean);

  const turn = Number(turnNo) > 0 ? Math.floor(Number(turnNo)) : 0;
  let added = 0;

  for (const raw of Array.isArray(fresh) ? fresh : []) {
    const norm = normalizeHook({
      who: raw && raw.who,
      hook: raw && raw.hook,
      bornTurn: turn,
    });
    if (!norm) continue;

    // 同一个人同一件事已经记过就不重复记
    const dup = list.some(
      (h) => h.status === CE_HOOK_STATUS.open
        && h.who === norm.who
        && h.hook === norm.hook,
    );
    if (dup) continue;

    list.push(norm);
    added += 1;
  }

  return { hooks: list, added };
}

/**
 * 收掉钩子（主线把它接了）。
 *
 * @param {Array} hooks
 * @param {Array<{who:string, hook:string}>} resolved
 * @param {number} turnNo
 * @returns {{hooks:Array, closed:number}}
 */
export function closeHooks(hooks, resolved, turnNo) {
  const list = (Array.isArray(hooks) ? hooks : [])
    .map((h) => normalizeHook(h))
    .filter(Boolean);
  const turn = Number(turnNo) > 0 ? Math.floor(Number(turnNo)) : 0;

  let closed = 0;
  for (const target of Array.isArray(resolved) ? resolved : []) {
    const who = String(target && target.who || '').trim();
    const hook = String(target && target.hook || '').trim();
    if (!who) continue;

    for (const h of list) {
      if (h.status !== CE_HOOK_STATUS.open) continue;
      if (h.who !== who) continue;
      // 给了内容就要求匹配；只给人名就收掉这人的所有开口钩子
      if (hook && h.hook !== hook) continue;
      h.status = CE_HOOK_STATUS.closed;
      h.closedTurn = turn;
      closed += 1;
    }
  }

  return { hooks: list, closed };
}

/**
 * 超时未收的钩子标「烂尾」。
 *
 * §10-Q7：寿命 3 轮。超了要**告诉玩家**，不能静静留着——
 * 留下的钩子会让下一轮 NPC 正文以为这事还在推进。
 *
 * @param {Array} hooks
 * @param {number} turnNo 当前轮号
 * @param {number} [lifetime=3]
 * @returns {{hooks:Array, stale:Array}}
 */
export function expireHooks(hooks, turnNo, lifetime = CE_HOOK_LIFETIME) {
  const list = (Array.isArray(hooks) ? hooks : [])
    .map((h) => normalizeHook(h))
    .filter(Boolean);

  const turn = Number(turnNo) > 0 ? Math.floor(Number(turnNo)) : 0;
  const life = Number(lifetime) > 0 ? Math.floor(Number(lifetime)) : CE_HOOK_LIFETIME;
  const stale = [];

  for (const h of list) {
    if (h.status !== CE_HOOK_STATUS.open) continue;
    // bornTurn=0 说明不知道什么时候起的，不贸然判烂尾
    if (h.bornTurn <= 0) continue;
    if (turn - h.bornTurn >= life) {
      h.status = CE_HOOK_STATUS.stale;
      stale.push(h);
    }
  }

  return { hooks: list, stale };
}

/**
 * 取还开着的钩子（下一轮 NPC 正文要带上它们，否则会烂尾）。
 *
 * @param {Array} hooks
 * @returns {Array}
 */
export function openHooks(hooks) {
  return (Array.isArray(hooks) ? hooks : [])
    .map((h) => normalizeHook(h))
    .filter((h) => h && h.status === CE_HOOK_STATUS.open);
}

/**
 * 渲染成给 NPC 正文写作者看的「你手上还有这些没收尾的事」。
 *
 * 这段话的作用很具体：让下一轮写作者知道
 * 「董萱儿正在打听筑基丹份额」，而不是给她编一段全新的生活。
 *
 * @param {Array} hooks
 * @param {string} [who] 只取某个人的
 * @returns {string}
 */
export function renderHooksForProse(hooks, who) {
  const target = String(who == null ? '' : who).trim();
  const list = openHooks(hooks).filter((h) => !target || h.who === target);

  if (list.length === 0) return '';

  const lines = ['【你手上还没了结的事】'];
  for (const h of list) {
    lines.push(`· ${h.who}：${h.hook}`);
  }
  lines.push('');
  lines.push('这些是上一轮你自己起的头。接着往下推，别开无关的新坑；');
  lines.push('要是这轮能了结，就在正文里写清怎么了的。');

  return lines.join('\n');
}

/**
 * 渲染烂尾提示（给玩家看）。
 *
 * @param {Array} stale
 * @returns {string}
 */
export function formatStaleHooks(stale) {
  const list = Array.isArray(stale) ? stale : [];
  if (list.length === 0) return '';

  const lines = ['下面这些线索起了头后来没收，已经放掉了：'];
  for (const h of list) {
    lines.push(`· ${h.who}：${h.hook}`);
  }
  return lines.join('\n');
}

/**
 * 一轮结束后钩子的完整流转（用一次调用做完三件事）。
 *
 * 顺序有意义：先收掉主线接了的，再加新起的，最后判超时。
 * 反过来会把「这轮刚起又立刻收掉」的误判成烂尾。
 *
 * @param {object} input
 * @param {Array} input.hooks 现有钩子
 * @param {number} input.turnNo 当前轮号
 * @param {Array<{who:string, hook:string}>} [input.fresh] 本轮新起的
 * @param {Array<{who:string, hook:string}>} [input.resolved] 本轮被主线收掉的
 * @param {number} [input.lifetime]
 * @returns {{hooks:Array, added:number, closed:number, stale:Array, staleText:string}}
 */
export function advanceHooks(input) {
  const src = input && typeof input === 'object' ? input : {};
  const turn = Number(src.turnNo) > 0 ? Math.floor(Number(src.turnNo)) : 0;

  let hooks = src.hooks;

  const closedResult = closeHooks(hooks, src.resolved, turn);
  hooks = closedResult.hooks;

  const addResult = addHooks(hooks, src.fresh, turn);
  hooks = addResult.hooks;

  const expireResult = expireHooks(hooks, turn, src.lifetime);
  hooks = expireResult.hooks;

  return {
    hooks,
    added: addResult.added,
    closed: closedResult.closed,
    stale: expireResult.stale,
    staleText: formatStaleHooks(expireResult.stale),
  };
}
