import { numericInterval } from './numeric-realms.js';
import { numericSetting } from './numeric-settings.js';

export const SKILL_REALM_ANCHORS = Object.freeze({
  炼气:'炼气一层', 筑基:'筑基初期', 结丹:'结丹初期', 元婴:'元婴初期',
  化神:'化神初期', 炼虚:'炼虚初期', 合体:'合体初期', 大乘:'大乘初期',
  渡劫:'渡劫', 真仙:'真仙下位', 金仙:'金仙下位', 太乙:'太乙下位', 大罗:'大罗下位', 道祖:'道祖',
});

export const DEFAULT_SKILL_COST_PERCENT = Object.freeze([4,15]);
const qualities = ['下品','中品','上品','顶阶'];

export function skillCost(pricing) {
  const {realm,position} = pricing || {};
  if (typeof realm !== 'string' || !Object.hasOwn(SKILL_REALM_ANCHORS,realm) ||
      !Number.isInteger(position) || position < 0 || position > 100) {
    throw new Error('技能定标须使用有效大阶和 0–100 的整数阶内位置');
  }
  const stage = realm+'阶';
  const anchor = numericInterval(SKILL_REALM_ANCHORS[realm],'法力').min;
  const [lower,upper] = numericSetting('skill-mana-cost',stage) ?? DEFAULT_SKILL_COST_PERCENT;
  const mana = Math.round(anchor*(lower + (upper-lower)*position/100)/100);
  return {grade:stage+'·'+qualities[Math.min(3,Math.floor(position/25))],mana};
}

export function projectSkillCost(skill) {
  if (skill?.skillPricing == null) return skill;
  const {grade,mana} = skillCost(skill.skillPricing);
  const label = mana+' 法力／次';
  return skill['2'] === grade && skill['8'] === label ? skill : {...skill,'2':grade,'8':label};
}

export function paySkillCost(skill, manaPool, uses) {
  if (skill?.skillPricing == null) throw new Error('技能缺少可结算法力定标');
  if (!Number.isSafeInteger(uses) || uses < 1) throw new Error('催发次数须为正整数');
  const total = skillCost(skill.skillPricing).mana*uses;
  if (!Number.isSafeInteger(total)) throw new Error('技能总消耗无效');
  const {current,max} = manaPool || {};
  // 临时状态可以使当前法力高于常驻上限。
  if (!Number.isFinite(current) || !Number.isFinite(max) || current < 0) throw new Error('当前法力无效');
  if (current < total) throw new Error('法力不足，无法结算技能');
  return {current:current-total,max};
}

function skillBonusSpent(cell) {
  const value=cell?.skillBonusSpent;
  return Number.isFinite(value)&&value>0 ? value : 0;
}

export function projectSkillMana(cell, nominal) {
  const bonus = Math.max(0,nominal - Number(cell?.current));
  const spent = Math.min(bonus,skillBonusSpent(cell)) || 0;
  return {current:nominal-spent,spent};
}

export function settleSkillMana(skill, cell, panel, uses, {nominal,scale}) {
  const target = paySkillCost(skill,panel,uses).current;
  const raw = Number(cell.current);
  if (!Number.isFinite(raw) || !Number.isFinite(nominal) || !Number.isFinite(scale)) throw new Error('当前法力无效');
  let current = Math.min(raw,target);
  const nominalAt = value => nominal+(value-raw)*scale;
  // 百分比 Buff 随底层现值变化。若状态压低了底层余额，按原乘区反推需要扣的白值。
  if (nominalAt(current)<target && scale>0) current=Math.min(raw,raw+(target-nominal)/scale);
  // 加成移除时只撤掉该加成。尚未回充的额外法力仍保留消耗记录。
  const inactive = skillBonusSpent(cell)-projectSkillMana(cell,nominal).spent;
  const spent = inactive + Math.max(0,nominalAt(current)-target);
  const result={...cell,current};
  if (spent>=0.0000005) result.skillBonusSpent=spent;
  else delete result.skillBonusSpent;
  return result;
}

export function clearSpentSkillBonusOnFullRecovery(cell, previousCurrent) {
  if (Number(cell.current)>Number(previousCurrent) && Number(cell.current)>=Number(cell.max)) delete cell.skillBonusSpent;
}
