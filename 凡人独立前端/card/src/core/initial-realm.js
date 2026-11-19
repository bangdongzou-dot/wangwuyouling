import { NUMERIC_REALM_ROWS, NUMERIC_ATTRIBUTE_FACTORS, generateNumericWhiteValues } from './numeric-realms.js';
// Shared realm lifespan scale. This module only transforms the provided values.
const lifespan = realm => {
  if(realm==='道祖')return '近似与天地同寿';
  const family=realm.slice(0,2);
  if(family==='大乘')return {大乘初期:20000,大乘中期:35000,大乘后期:50000}[realm];
  return {凡人:100,炼气:100,筑基:200,结丹:500,元婴:1000,化神:2000,炼虚:5000,合体:10000,渡劫:200000,真仙:1000000,金仙:3000000,太乙:10000000,大罗:100000000}[family];
};
export const INITIAL_REALM_OPTIONS = Object.freeze(NUMERIC_REALM_ROWS.map(row=>Object.freeze({
  realm:row.realm,lifespan:lifespan(row.realm),
  description:row.realm==='凡人'?'尚未踏入修仙门径，沿用原有凡人开局属性。':
    '以'+row.realm+'正式开局，战斗白值按本境界正常档初始化，叠加已分配属性点及出身、种族加成。气运、魅力与灵根修速保持各自规则；不凭空获得功法、装备或经历。',
})));
export function getInitialRealmOption(value) {
  const realm=value===undefined||value===null||value===''?'凡人':value;
  const option=INITIAL_REALM_OPTIONS.find(row=>row.realm===realm);
  if(!option)throw new Error('初始境界无效，请重新选择；开局最高只能选择道祖。');
  return option;
}

export function initialRemainingLifespan(option, age) {
  return typeof option.lifespan === 'number' ? Math.max(0, option.lifespan - Number(age)) : option.lifespan;
}

function lifeYears(value) {
  if (!/^\d+$/u.test(String(value ?? '').trim())) return undefined;
  const years = Number(value);
  return Number.isSafeInteger(years) ? years : undefined;
}

const ordinaryLifeRealm = realm => /^(?:凡人$|炼气|练气)/u.test(String(realm || ''));

export function legacyInitialRemainingLifespan(notes, opening, {openingRealm,realm} = {}) {
  if (!opening || !notes || notes.寿元口径 || opening.寿元口径 || notes.初始境界 !== opening.初始境界 ||
      String(notes.寿元) !== String(opening.寿元)) return;
  const age = Number(opening.年龄);
  const currentAge = lifeYears(notes.年龄);
  const initial = opening.初始境界 || (openingRealm === '凡人' ? openingRealm : undefined);
  const option = INITIAL_REALM_OPTIONS.find(row => row.realm === initial);
  const sameLifeBand = ordinaryLifeRealm(realm) && ordinaryLifeRealm(initial);
  const compatible = realm && (sameLifeBand || realm === openingRealm);
  if (option && Number.isSafeInteger(age) && age > 0 && currentAge >= age &&
      (compatible || (realm === undefined && currentAge === age)) &&
      typeof option.lifespan === 'number' && Number(opening.寿元) === option.lifespan) {
    return initialRemainingLifespan(option, currentAge);
  }
}

export function lifespanRemarksPatch(previous, patch, realm, {useOrdinaryDefault = false, previousRealm} = {}) {
  const age = lifeYears(patch.年龄 ?? previous.年龄);
  if (Object.hasOwn(patch,'寿元')) {
    const years = lifeYears(patch.寿元);
    if (years === undefined) return patch;
    const suppliedTotal = patch.寿元口径 === '总寿命';
    const ordinaryDefault = useOrdinaryDefault && !patch.寿元口径 && age < 100 && years === 100 && ordinaryLifeRealm(realm);
    if (suppliedTotal && age === undefined) return patch;
    const remaining = (suppliedTotal || ordinaryDefault) && age !== undefined ? Math.max(0,years-age) : patch.寿元;
    return {...patch,寿元:remaining,寿元口径:'剩余'};
  }
  const oldAge = lifeYears(previous.年龄), life = lifeYears(previous.寿元);
  if (previous.寿元口径 === '剩余' && life !== undefined) {
    const elapsed = age > oldAge ? age-oldAge : 0;
    const before = lifespan(String(previousRealm || '')), after = lifespan(String(realm || ''));
    const gained = Number.isFinite(before) && Number.isFinite(after) ? Math.max(0,after-before) : 0;
    if (elapsed || gained) return {...patch,寿元:Math.max(0,life-elapsed+gained),寿元口径:'剩余'};
  }
  return patch;
}

export function alignTerminalLifespanWrites(operations, readRemarks = value=>value) {
  if (operations.length < 2) return operations;
  const pending = new Map();
  let aligned = operations;
  for (const [index,op] of operations.entries()) {
    const id = op?.command === 'set' ? op.data?.['0'] || op.id : op?.id;
    if (!/^(?:B1|[CG]\d+(?:_\d+)?)$/u.test(id || '')) continue;
    if (op.command === 'set' || (op.command === 'de' && !op.subCategory && !op.subId)) pending.delete(id);
    if (op.command !== 'add' || !op.data) continue;
    const notes = readRemarks(op.data['9']) || {};
    if (Object.hasOwn(notes,'寿元')) {
      pending.set(id,index);
      continue;
    }
    if (!pending.has(id) || (!Object.hasOwn(notes,'年龄') && !Object.hasOwn(op.data,'2'))) continue;
    const earlierIndex = pending.get(id);
    const earlier = aligned[earlierIndex];
    const {寿元,寿元口径,...otherNotes} = readRemarks(earlier.data['9']);
    const terminal = {...notes,寿元};
    if (寿元口径 !== undefined && !Object.hasOwn(terminal,'寿元口径')) terminal.寿元口径 = 寿元口径;
    if (aligned === operations) aligned = operations.slice();
    aligned[earlierIndex] = {...earlier,data:{...earlier.data,'9':otherNotes}};
    aligned[index] = {...op,data:{...op.data,'9':terminal}};
    pending.set(id,index);
  }
  return aligned;
}
export function initializeRealmAttributes(attributes,realm,character={}) {
  const option=getInitialRealmOption(realm);
  const output=Object.fromEntries(Object.entries(attributes).map(([key,cell])=>[key,{...cell}]));
  if(option.realm==='凡人')return output;
  const generated=generateNumericWhiteValues(option.realm,{character});
  for(const key of Object.keys(NUMERIC_ATTRIBUTE_FACTORS)){
    const allocated=key==='血量'?0:Number(attributes[key]?.max)||0;
    const max=Number((generated[key].max+allocated).toFixed(6));
    output[key]={current:max,max};
  }
  return output;
}
