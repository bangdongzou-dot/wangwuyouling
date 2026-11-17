import { NUMERIC_REALM_ROWS, NUMERIC_ATTRIBUTE_FACTORS, generateNumericWhiteValues } from './numeric-realms.js';
// New-character choice only. Never reads or rewrites an archive.
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
