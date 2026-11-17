import { resolveCultivationSpeedCell, resolveTechniqueSpeed, splitTechniqueEffectStages, techniqueImmortalRealmRank } from './cultivation-speed.js';
import { classifyItem, equipmentEligibility, equipmentRealmName, isTreasureSet } from './equipment-layout.js';
import { NUMERIC_REALM_ROWS, resolveNumericRealm } from './numeric-realms.js';
import { numericSetting } from './numeric-settings.js';
// Pure, single-item container contract. No character totals, storage, or migration.
const ATTRIBUTES = new Set([
  '血量', '法力', '神识', '物攻', '物防', '法攻', '法防',
  '物理穿透', '法术穿透', '脚力', '气运', '魅力', '修炼速度',
]);
// [minimum rate, maximum rate, minimum consciousness, perfect consciousness]
const RULES = {
  凡器: { 下品: [0.01, 0.03, 0, 5], 中品: [0.03, 0.05, 0, 10] },
  法器: {
    下品: [0.05, 0.08, 2, 8], 中品: [0.08, 0.12, 5, 15],
    上品: [0.12, 0.16, 10, 30], 顶阶: [0.16, 0.20, 20, 50],
  },
  法宝: {
    下品: [0.18, 0.22, 100, 250], 中品: [0.22, 0.28, 200, 500],
    上品: [0.28, 0.34, 400, 900], 顶阶: [0.34, 0.40, 700, 1500],
  },
  灵宝: {
    下品: [0.38, 0.44, 2000, 5000], 中品: [0.44, 0.50, 4000, 9000],
    上品: [0.50, 0.56, 7000, 15000], 顶阶: [0.56, 0.62, 12000, 25000],
  },
  通天灵宝: {
    下品: [0.60, 0.68, 40000, 100000], 中品: [0.68, 0.76, 80000, 200000],
    上品: [0.76, 0.84, 150000, 350000], 顶阶: [0.84, 0.92, 250000, 600000],
  },
  玄天之宝: {
    下品: [0.90, 0.94, 500000, 1500000], 中品: [0.94, 0.97, 1000000, 3000000],
    上品: [0.97, 0.99, 2000000, 6000000], 顶阶: [0.99, 1.00, 4000000, 10000000],
  },
  混沌之宝: {
    下品: [10, 10, 10_000_000, 30_000_000], 中品: [50, 50, 50_000_000, 150_000_000],
    上品: [100, 100, 100_000_000, 300_000_000], 顶阶: [500, 500, 500_000_000, 1_500_000_000],
    至高: [1000, 1000, 1_000_000_000, 3_000_000_000],
  },
};
/** Shared, immutable class/quality contract for parsing, rendering and preset generation. */
export const CONTAINER_LIMITS = Object.freeze(Object.fromEntries(Object.entries(RULES).map(([type, qualities]) => [
  type, Object.freeze(Object.fromEntries(Object.entries(qualities).map(([quality, values]) => [quality, Object.freeze({
    minRate: values[0], maxRate: values[1], minConsciousness: values[2], perfectConsciousness: values[3],
  })]))),
])));

// The original attack/defense/mind caps remain the sole base for the approved extension.
const REALM_CAPS = {
  凡人: [30, 25, 10], 炼气: [300, 250, 200], 筑基: [1000, 850, 600],
  结丹: [3500, 3000, 2000], 元婴: [12000, 10000, 7000], 化神: [45000, 38000, 25000],
  炼虚: [150000, 130000, 90000], 合体: [550000, 470000, 320000],
  大乘: [1800000, 1500000, 1000000], 渡劫: [3000000, 2500000, 1800000],
};
/** Approved 10 realms × 13 attributes. Each cell caps one item's addition. */
export const CONTAINER_HARD_CAPS = Object.freeze(Object.fromEntries(Object.entries(REALM_CAPS).map(([realm, [attack, defense, mind]]) => [
  realm, Object.freeze({
    血量: attack * 25, 法力: attack * 4, 神识: mind,
    物攻: attack, 物防: defense, 法攻: attack, 法防: defense,
    物理穿透: attack, 法术穿透: attack, 脚力: attack * 0.3,
    气运: 100, 魅力: 100, 修炼速度: 100,
  }),
])));

export const CONTAINER_CLASS_COLORS = Object.freeze({
  凡器: '#bdbdbd', 法器: '#69f0ae', 法宝: '#448aff',
  灵宝: '#ab47bc', 通天灵宝: '#ffd700', 玄天之宝: '#ef5350', 混沌之宝: '#ffe4ab',
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const nonnegativeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const LEGACY_CHAOS = {
  下品: [0.96, 2400000, 6000000], 中品: [0.97, 2800000, 7000000],
  上品: [0.98, 3200000, 8000000], 顶阶: [0.99, 3600000, 9000000], 至高: [1, 4000000, 10000000],
};

function equipmentLimits(type, quality) {
  const override = numericSetting('equipment-transmission', type+'·'+quality);
  return override ? {minRate:override[0], maxRate:override[1], minConsciousness:override[2], perfectConsciousness:override[3]} : CONTAINER_LIMITS[type][quality];
}

function validateParts(parts) {
  if (!own(CONTAINER_LIMITS, parts.type)) return 'invalid_type';
  if (!own(CONTAINER_LIMITS[parts.type], parts.quality)) return 'invalid_quality';
  if (!ATTRIBUTES.has(parts.attribute)) return 'invalid_attribute';
  if (parts.type === '混沌之宝' && parts.quality === '至高' && parts.attribute !== '神识') return 'invalid_attribute';
  const { minRate: low, maxRate: high, minConsciousness: minimum, perfectConsciousness: perfect } = equipmentLimits(parts.type,parts.quality);
  if (!nonnegativeNumber(parts.rate) || parts.rate < low || parts.rate > high) return 'rate_out_of_range';
  if (parts.minConsciousness !== minimum || parts.perfectConsciousness !== perfect) return 'threshold_mismatch';
  return null;
}

function thresholdNumber(text) {
  const match = text.trim().match(/^((?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)(?:\s*([万亿]))?$/);
  if (!match) return NaN;
  const scale = match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1;
  return Number(match[1].replace(/[,，]/g, '')) * scale;
}

/**
 * Recognized means legacy fallback must stop, even when a container is invalid.
 * All four fields must be present once, in the delivery-note order; no mixed text.
 */
export function parseContainerEquipment(effect) {
  const recognized = typeof effect === 'string' && effect.includes('容器');
  const result = {
    recognized, ok: false, type: null, quality: null, attribute: null,
    rate: null, minConsciousness: null, perfectConsciousness: null,
    reason: recognized ? 'invalid_format' : 'not_container',
  };
  if (!recognized) return result;
  const fields = effect.trim().split(/[|｜]/).map(field => field.trim());
  if (fields.length !== 4) return result;
  const header = fields[0].match(/^容器\s*[:：]\s*([^·•・]+?)\s*[·•・]\s*(\S+)$/);
  const attribute = fields[1].match(/^加成\s*[:：]\s*(\S+)$/);
  const rate = fields[2].match(/^传导率\s*[:：]\s*(\d+\.\d{2})$/);
  const thresholds = fields[3].match(/^门槛\s*[:：]\s*([^/]+)\s*\/\s*([^/]+)$/);
  if (!header || !attribute || !rate || !thresholds) return result;
  Object.assign(result, {
    type: header[1].trim(), quality: header[2], attribute: attribute[1], rate: Number(rate[1]),
    minConsciousness: thresholdNumber(thresholds[1]), perfectConsciousness: thresholdNumber(thresholds[2]),
  });
  const old = result.type === '混沌之宝' && own(LEGACY_CHAOS, result.quality) && LEGACY_CHAOS[result.quality];
  if (old && old[0] === result.rate && old[1] === result.minConsciousness && old[2] === result.perfectConsciousness) {
    const {minRate, minConsciousness, perfectConsciousness} = CONTAINER_LIMITS.混沌之宝[result.quality];
    Object.assign(result, {rate:minRate, minConsciousness, perfectConsciousness});
  }
  const base = own(CONTAINER_LIMITS,result.type) && own(CONTAINER_LIMITS[result.type],result.quality) && CONTAINER_LIMITS[result.type][result.quality];
  if (base && result.minConsciousness===base.minConsciousness && result.perfectConsciousness===base.perfectConsciousness &&
      result.rate>=base.minRate && result.rate<=base.maxRate) {
    const active=equipmentLimits(result.type,result.quality);
    if(active!==base){
      const position=base.minRate===base.maxRate?0:(result.rate-base.minRate)/(base.maxRate-base.minRate);
      const rate=Number((active.minRate+position*(active.maxRate-active.minRate)).toFixed(2));
      Object.assign(result,{rate,minConsciousness:active.minConsciousness,perfectConsciousness:active.perfectConsciousness});
    }
  }
  result.reason = validateParts(result);
  result.ok = result.reason === null;
  return result;
}

const supremeChaos = CONTAINER_LIMITS.混沌之宝.至高;
const chaosBottleEffect = `容器: 混沌之宝·至高 | 加成: 神识 | 传导率: ${supremeChaos.minRate.toFixed(2)} | 门槛: ${supremeChaos.minConsciousness}/${supremeChaos.perfectConsciousness}`;
const legacyChaosBottleEffect = '容器: 混沌之宝·至高 | 加成: 神识 | 传导率: 1.00 | 门槛: 4000000/10000000';
const previousBottleEffect = '容器: 玄天之宝·顶阶 | 加成: 神识 | 传导率: 1.00 | 门槛: 4000000/10000000';
const bottleOrigin = '传闻仙界之上，有混沌初生之绝秘神物。';
const bottleBinding = '【认主】唯主可用，不可夺取。';

function isMiracleBottle(item) {
  return (item?.['1'] || item?.name) === '混沌造化瓶' && (item['2'] || item.type) === '法宝';
}

export function removeLegacyRedSeal(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/不死不灭，全盛时期位阶与境界超脱天道之上，但目前被封印至道祖境界。/gu, '她始终是全盛姿态的超脱者，凌驾天道与一切法则之上。全属性无限，不死不灭。')
    .replace(/不死不灭；当前封印于道祖境界，全盛位阶超脱天道之上。/gu, '全盛超脱者，全属性无限，凌驾天道，不死不灭。')
    .replace(/，但目前被封印至道祖境界。/gu, '。');
}

export function projectMiracleBottle(item) {
  if (!isMiracleBottle(item)) return item;
  const description = item['3'] || item.description || '';
  const effect = item['4'] || item.effect || '';
  if (typeof description !== 'string' || typeof effect !== 'string') return item;
  let adaptedDescription;
  if (item.artifactTier === '幻彩神物' && effect === previousBottleEffect &&
      description.startsWith('幻彩神物。' + bottleOrigin) && description.includes(bottleBinding)) {
    adaptedDescription = description
      .replace(/^幻彩神物。/u, '混沌之宝·至高。')
      .replace('装备后按玄天之宝顶阶的现行神识门槛结算。', '装备后按混沌之宝至高品阶的神识门槛结算。');
  } else if (!item.artifactTier && description.startsWith(bottleOrigin) &&
      effect.startsWith('催熟灵药，变废为宝，感悟法则，赋予生命，演化万法。') &&
      effect.includes(bottleBinding) &&
      (effect.includes('目前被封印至道祖境界。') || effect.includes('本体为超脱者，凌驾天道与一切法则之上。'))) {
    const abilities = effect.replace(/(?=【(?:万道之基|造化|生命|烘炉|认主|蕴灵)】)/gu, '\n');
    adaptedDescription = '混沌之宝·至高。' + description + '\n\n【器物能力】' + abilities +
      '\n【神识传导】装备后按混沌之宝至高品阶的神识门槛结算。';
  } else if (item.artifactTier === '混沌之宝' && [chaosBottleEffect,legacyChaosBottleEffect].includes(effect) &&
      description.startsWith('混沌之宝·至高。' + bottleOrigin) && description.includes(bottleBinding)) {
    adaptedDescription = removeLegacyRedSeal(description);
    if (effect === chaosBottleEffect && adaptedDescription === description) return item;
  } else {
    return item;
  }
  adaptedDescription = removeLegacyRedSeal(adaptedDescription);
  return {
    ...item, artifactTier: '混沌之宝',
    '3': adaptedDescription, description: adaptedDescription,
    '4': chaosBottleEffect, effect: chaosBottleEffect,
  };
}

export function parseItemContainerEquipment(item) {
  const projected = projectMiracleBottle(item);
  const parsed = parseContainerEquipment(projected?.['4'] || projected?.effect || '');
  if (parsed.ok && parsed.type === '混沌之宝' && parsed.quality === '至高' &&
      (!isMiracleBottle(projected) || projected.artifactTier !== '混沌之宝')) {
    return { ...parsed, ok: false, reason: 'reserved_chaos_tier' };
  }
  return parsed;
}

function smallChineseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (own(digits, text)) return digits[text];
  if (text === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(text)) return 10 + digits[text[1]];
  return NaN;
}

function realmGroup(value) {
  if (typeof value !== 'string') return null;
  const realm = value.trim().replace(/\s+/g, '').replace(/^练气/, '炼气');
  if (realm === '凡人') return '凡人';
  const qi = realm.match(/^炼气(?:期)?(?:(\d{1,3}|[一二两三四五六七八九十]{1,3})层|初期|中期|后期|大圆满|圆满|巅峰|全期)?(?:妖修|妖兽|妖族|灵兽)?$/);
  if (qi) return !qi[1] || (smallChineseNumber(qi[1]) >= 1 && smallChineseNumber(qi[1]) <= 13) ? '炼气' : null;
  const human = realm.match(/^(筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?(?:初期|中期|后期|大圆满|圆满|巅峰)?(?:妖修|妖兽|妖族|灵兽)?$/);
  if (human) return human[1];
  const beast = realm.match(/^(?:妖兽|妖族|灵兽)?(\d{1,3}|[一二两三四五六七八九十]{1,2})(?:级|阶)(?:妖兽|妖族|灵兽)?$/);
  if (!beast) return null;
  const level = smallChineseNumber(beast[1]);
  if (level === 1) return '炼气';
  if (level >= 2 && level <= 4) return '筑基';
  if (level >= 5 && level <= 7) return '结丹';
  if (level >= 8 && level <= 10) return '元婴';
  return null;
}

function resolveCap(realm, attribute, overrides) {
  let value;
  if (overrides && typeof overrides === 'object' && own(overrides, realm)) {
    const row = overrides[realm];
    if (row === null) return { reason: 'hard_cap_missing', cap: null };
    if (typeof row !== 'object') return { reason: 'hard_cap_invalid', cap: null };
    if (own(row, attribute)) {
      value = row[attribute];
      if (value == null) return { reason: 'hard_cap_missing', cap: null };
      return nonnegativeNumber(value) ? { reason: null, cap: value } : { reason: 'hard_cap_invalid', cap: null };
    }
  }
  if (!own(CONTAINER_HARD_CAPS[realm], attribute)) return { reason: 'hard_cap_missing', cap: null };
  const configured = numericSetting('equipment-hard-caps',realm);
  value = configured?.[Object.keys(CONTAINER_HARD_CAPS[realm]).indexOf(attribute)]??CONTAINER_HARD_CAPS[realm][attribute];
  return { reason: null, cap: value };
}

/**
 * whiteValues contains finite nonnegative NUMBERS from one raw white-value snapshot.
 * Caller supplies raw max/capacity before this boundary; never current reserves or totals.
 * hardCaps: { [majorRealmChinese]: { [attributeChinese]: number | null } }.
 * Per-attribute overrides; explicit null disables that cell. Defaults are approved.
 */
export function evaluateContainerEquipment(parsed, { whiteValues, realm, hardCaps } = {}) {
  const result = {
    ok: false, value: 0, rawValue: 0, sourceAttribute: null, sourceValue: 0,
    consciousness: 0, factor: 0, cap: null, clamped: false, reason: null,
  };
  if (!parsed || parsed.recognized !== true || parsed.ok !== true) {
    return { ...result, reason: parsed?.reason || 'invalid_container' };
  }
  const invalid = validateParts(parsed);
  if (invalid) return { ...result, reason: invalid };
  const majorRealm = realmGroup(realm);
  if (!majorRealm) return { ...result, reason: 'unknown_realm' };
  result.sourceAttribute = parsed.attribute === '法攻' ? '法力' : parsed.attribute;
  if (!whiteValues || typeof whiteValues !== 'object' || !own(whiteValues, result.sourceAttribute) || whiteValues[result.sourceAttribute] === undefined) {
    return { ...result, reason: 'white_value_missing' };
  }
  if (!nonnegativeNumber(whiteValues[result.sourceAttribute])) return { ...result, reason: 'white_value_invalid' };
  result.sourceValue = whiteValues[result.sourceAttribute];
  if (!own(whiteValues, '神识') || whiteValues.神识 === undefined) return { ...result, reason: 'consciousness_missing' };
  if (!nonnegativeNumber(whiteValues.神识)) return { ...result, reason: 'consciousness_invalid' };
  result.consciousness = whiteValues.神识;
  result.factor = result.consciousness < parsed.minConsciousness ? 0 : result.consciousness < parsed.perfectConsciousness ? 0.7 : 1;
  result.rawValue = result.sourceValue * parsed.rate * result.factor;
  if (!Number.isFinite(result.rawValue)) return { ...result, rawValue: 0, reason: 'numeric_overflow' };
  const capResult = resolveCap(majorRealm, parsed.attribute, hardCaps);
  if (capResult.reason) return { ...result, reason: capResult.reason };
  result.cap = capResult.cap * (parsed.type === '混沌之宝' ? parsed.rate : 1);
  if (!Number.isFinite(result.cap)) return { ...result, cap: null, reason: 'numeric_overflow' };
  result.value = Math.min(result.rawValue, result.cap);
  result.clamped = result.rawValue > result.cap;
  result.ok = true;
  result.reason = result.factor === 0 ? 'consciousness_below_minimum' : null;
  return result;
}

// Only compare like-for-like bonuses; different attributes have no universal exchange rate.
export function compareContainerEquipment(candidate, current, columns) {
  const parsed = parseItemContainerEquipment(candidate);
  if (!parsed.ok) return null;
  const equipped = current && parseItemContainerEquipment(current);
  if (current && (!equipped?.ok || equipped.attribute !== parsed.attribute)) return null;
  const realm = equipmentRealmName(columns);
  let attrs = columns?.['11'];
  if (typeof attrs === 'string') {
    try { attrs = JSON.parse(attrs); } catch (_) { return null; }
  }
  const whiteValues = Object.fromEntries(Object.entries(attrs || {}).flatMap(([key, entry]) => {
    const raw = typeof entry === 'object' && entry ? entry.max : entry;
    const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    return nonnegativeNumber(value) ? [[key, value]] : [];
  }));
  if (!own(attrs || {}, '修炼速度')) whiteValues.修炼速度 = resolveCultivationSpeedCell(undefined, columns).max;
  const options = {realm, whiteValues};
  const a = evaluateContainerEquipment(parsed, options);
  const b = equipped ? evaluateContainerEquipment(equipped, options) : {ok:true,value:0};
  return a.ok && b.ok ? a.value - b.value : null;
}

function changchunEdition(item){
  const name=String(item?.['1']??item?.name??'').replace(/[《》\s]/gu,'');
  if(/^(?:引气口诀|长春功入门口诀)$/u.test(name)&&
    /长春功/u.test(String(item?.['3']??item?.description??'')))return 1;
  return /^长春功[（(](?:完整|全本)[）)]$/u.test(name)?2:0;
}

function techniqueRealmOrder(text, ceiling = false) {
  const name = String(text || '').split('|')[0].replace(/\s+/gu, '').replace(/[（(][^）)]*[）)]$/u, '');
  const immortal = techniqueImmortalRealmRank(name);
  if (immortal !== null) return immortal;
  const realm = resolveNumericRealm(name);
  if (realm) return NUMERIC_REALM_ROWS.findIndex(row => row.realm === realm);
  const major = name.match(/^(炼气|练气|筑基|结丹|元婴|化神|炼虚|合体|大乘)期?$/u)?.[1]?.replace('练气', '炼气');
  if (!major) return null;
  const match = row => row.realm.startsWith(major);
  return ceiling ? NUMERIC_REALM_ROWS.findLastIndex(match) : NUMERIC_REALM_ROWS.findIndex(match);
}

function techniqueComparableSpeed(item, columns) {
  const ownerRank = techniqueRealmOrder(equipmentRealmName(columns));
  const active = splitTechniqueEffectStages(item['8'] ?? item.realmEffects).filter(entry => {
    const rank = techniqueRealmOrder(entry.realm);
    return /^(?:入门|基础|通用)$/u.test(entry.realm) || (rank !== null && ownerRank !== null && rank <= ownerRank);
  });
  const speed = resolveTechniqueSpeed(item, active);
  if (speed.source !== 'record' && !speed.tier) return null;
  const base = resolveCultivationSpeedCell(columns?.['11']?.修炼速度, columns).max;
  return speed.flat + speed.percent * base / 100;
}

export function techniqueUnavailable(item) {
  const description = String(item?.['3'] ?? item?.description ?? '');
  return /(?:不能|无法|不得|禁止|尚不能)(?:修习|修炼|修练|学习|转修|改修)|封印[^。；\n]{0,10}(?:未解|未破|不可读)|替[^。；\n]{0,8}保管|仅供转交/u.test(description);
}

function techniqueStoryDecision(item, columns, story, actorScoped) {
  const name = String(item?.['1'] ?? item?.name ?? '').replace(/[《》]/gu, '');
  if (!name || typeof story !== 'string' || !story) return null;
  const owner = String(columns?.['1'] ?? columns?.name ?? '').split('|')[0].replace(/<[^>]*>/gu, '').trim();
  const escape = value => value.replace(/[.*+?^\x24{}()|[\]\\]/gu, '\\$&');
  const baseName = name.replace(/[（(](?:完整|全本)[）)]$/u, '');
  const title = [name, baseName].map(escape).join('|');
  const action = '(暂不(?:修习|修炼|修练|改修)|(?:没有|并未|尚未|未曾|未)(?:修习|修炼|修练|改修|转修)|停止(?:修习|修炼|修练)|放弃(?:修习|修炼|修练)?|(?:继续|仍旧?|开始|正式|已经)(?:在)?(?:修习|修炼|修练|主修)|改修|转修|主修)';
  const re = new RegExp(action + '\\s*《?(?:' + title + ')(?:》|(?=[，。；、！？\\s]|$))', 'gu');
  let decision = null;
  let start = 0;
  for (const line of story.split(/[。；！？\n]/u)) {
    for (const match of line.matchAll(re)) {
      const prefix = line.slice(0, match.index);
      if (!actorScoped && (!owner || !prefix.includes(owner))) continue;
      const before = prefix.slice(-16);
      if (/(?:打算|准备|将来|考虑|想要|若要|若能|如果|是否|建议|劝|让|能否|计划)[^，、]{0,9}$/u.test(before)) continue;
      decision = {index:start + match.index, use:!/^(?:暂不|没有|并未|尚未|未|停止|放弃)/u.test(match[1])};
    }
    start += line.length + 1;
  }
  return decision;
}

export function compareNpcEquipment(candidate,current,columns,{techniqueStory,actorScoped=false}={}){
  if(classifyItem(candidate).slotKey!=='technique')return compareContainerEquipment(candidate,current,columns);
  const wanted = techniqueStoryDecision(candidate, columns, techniqueStory, actorScoped);
  const prior = techniqueStoryDecision(current, columns, techniqueStory, actorScoped);
  if (wanted?.use === false) return -1;
  if (wanted?.use && (!prior?.use || wanted.index >= prior.index)) return 1;
  if (prior?.use || techniqueUnavailable(candidate)) return -1;
  if(!current)return 1;
  if (prior?.use === false) return 1;
  const nextEdition=changchunEdition(candidate),oldEdition=changchunEdition(current);
  if(nextEdition&&oldEdition&&nextEdition!==oldEdition)return nextEdition-oldEdition;
  const next = techniqueComparableSpeed(candidate, columns), old = techniqueComparableSpeed(current, columns);
  if (next !== null && old !== null && next !== old) return next - old;
  const maxNext = techniqueRealmOrder(candidate['7'] ?? candidate.maxRealm, true);
  const maxOld = techniqueRealmOrder(current['7'] ?? current.maxRealm, true);
  if (maxNext !== null && maxOld !== null) return maxNext - maxOld;
  return next !== null && old !== null ? 0 : null;
}

export function npcEquipmentUpgrade(item,equipment,columns,options){
  const {slotKey,indices}=classifyItem(item);
  if(!slotKey)return null;
  const equipped=equipment?.[slotKey]??[];
  const candidate=isTreasureSet(item)?item:{...item,5:'1'};
  const eligible=indices.filter(index=>!options?.protectedSlots?.has(slotKey+'['+index+']')&&equipmentEligibility(columns,slotKey,index,candidate).allowed);
  const empty=eligible.find(index=>!equipped[index]&&compareNpcEquipment(item,null,columns,options)>0);
  if(empty!==undefined)return {slotKey,index:empty};
  const best=eligible.map(index=>({index,gain:compareNpcEquipment(item,equipped[index],columns,options)}))
    .filter(row=>equipped[row.index]&&row.gain>0).sort((a,b)=>b.gain-a.gain)[0];
  return best?{slotKey,index:best.index}:null;
}

export function planNpcLoadout(inventory,equipment,columns,options){
  if(!Array.isArray(inventory))return [];
  const slots=Object.fromEntries(Object.entries(equipment??{}).filter(([,items])=>Array.isArray(items))
    .map(([group,items])=>[group,[...items]]));
  const upgrades=new Map();
  for(const item of inventory){
    if(!item||!Number.isSafeInteger(Number(item['5']??item.quantity))||Number(item['5']??item.quantity)<1)continue;
    const candidate=isTreasureSet(item)?item:{...item,5:'1'},upgrade=npcEquipmentUpgrade(candidate,slots,columns,options);
    if(!upgrade)continue;
    const {slotKey,index}=upgrade;
    (slots[slotKey]??=[])[index]=candidate;
    upgrades.set(slotKey+'['+index+']',{...upgrade,item});
  }
  return [...upgrades.values()];
}
