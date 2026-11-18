import { resolveCultivationRootBase, buildCultivationSpeedRules } from './cultivation-speed.js';
import { numericSetting } from './numeric-settings.js';
// Shared compressed white-value scale. Pure/read-only: no storage writes or migration.
// The historical 07 proposal supplies anchors, not an approved save-conversion policy.
export const NUMERIC_RULE_VERSION = 'compressed-container-20261111-v1';
export const NUMERIC_TIERS = Object.freeze(['偏弱', '正常', '超常']);
export const NUMERIC_ATTRIBUTE_FACTORS = Object.freeze({ 血量:25, 法力:4, 神识:1, 物攻:1, 法攻:1, 物防:0.8, 法防:0.8, 脚力:0.3, 物理穿透:0.1, 法术穿透:0.1 });
export const NUMERIC_SCALAR_RANGES = Object.freeze({ 气运:Object.freeze([0,100]), 魅力:Object.freeze([0,100]), 修炼速度:Object.freeze([0,200]) });
export function isRedBottleCompanion(name, identity, notes = {}) {
  return name === '红宝' && (identity === '混沌造化瓶化形器灵·先天真灵' ||
    notes.sourceItem === '混沌造化瓶' || (notes.完整位格 === '超脱者' && notes.sourceTrait === '混沌造化瓶（小红瓶）'));
}
const qiNames = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三'];
const anchors = [['凡人',10], ...qiNames.map((n,i)=>['炼气'+n+'层',40+i*5]),
  ['筑基初期',200],['筑基中期',275],['筑基后期',350],
  ['结丹初期',600],['结丹中期',900],['结丹后期',1200],
  ['元婴初期',2000],['元婴中期',3000],['元婴后期',4000],
  ['化神初期',7000],['化神中期',10000],['化神后期',15000],
  ['炼虚初期',25000],['炼虚中期',35000],['炼虚后期',50000],
  ['合体初期',90000],['合体中期',130000],['合体后期',180000],
  ['大乘初期',300000],['大乘中期',450000],['大乘后期',600000],['渡劫',1000000]];
// Anchors are the LOWER boundaries. Each full interval is split into equal thirds.
// Last finite interval is explicit: do not silently invent immortals or flatten overflow.
export const NUMERIC_MORTAL_REALM_ROWS = Object.freeze(anchors.map(([realm,min],i)=>Object.freeze({
  realm,min,max:anchors[i+1]?.[1] ?? 1500000,upperInclusive:i===anchors.length-1,
})));
// 1.1.6 暂定仙界压缩白值：连续承接渡劫，不迁移任何既有角色。
export const NUMERIC_IMMORTAL_REALM_ROWS = Object.freeze([
  ['真仙下位',1500000],['真仙中位',2250000],['真仙上位',3000000],
  ['金仙下位',5000000],['金仙中位',7500000],['金仙上位',10000000],
  ['太乙下位',18000000],['太乙中位',26000000],['太乙上位',36000000],
  ['大罗下位',60000000],['大罗中位',90000000],['大罗上位',120000000],['道祖',200000000],
].map(([realm,min],i,rows)=>Object.freeze({realm,min,max:rows[i+1]?.[1]??300000000,upperInclusive:i===rows.length-1})));
export const NUMERIC_REALM_ROWS = Object.freeze([
  ...NUMERIC_MORTAL_REALM_ROWS.map(row=>Object.freeze({...row,upperInclusive:false})),...NUMERIC_IMMORTAL_REALM_ROWS,
]);
const resources = new Set(['血量','法力']);
const own = (o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const finite = v => (typeof v==='number'||(typeof v==='string'&&v.trim()!==''))&&Number.isFinite(Number(v));
const number = v => finite(v)?Number(v):NaN;
const round = v => Math.round(v*1e6)/1e6;
const format = v => Number.isFinite(v)?String(round(v)):'未知';
const tierAt = (interval,value) => NUMERIC_TIERS[value>=numericThirds(interval)[2].min?2:value>=numericThirds(interval)[1].min?1:0];
const factorFor=attribute=>numericSetting('attribute-factors',attribute)?.[0]??NUMERIC_ATTRIBUTE_FACTORS[attribute];
const scalarRange=attribute=>numericSetting('scalar-ranges',attribute)??NUMERIC_SCALAR_RANGES[attribute];
const realmRow=row=>{
  const range=numericSetting('attribute-baseline',row.realm);
  return range?{...row,min:range[0],max:range[1]}:row;
};
export function resolveNumericRealm(raw) {
  let realm=String(raw??'').split('|')[0].trim().replace(/\s+/g,'').replace(/[（(]\d+(?:\.\d+)?%[）)]$/u,'').replace(/^练气/u,'炼气').replace(/^金丹/u,'结丹');
  realm=realm.replace(/(?:妖修|妖族|妖兽|灵兽)$/u,'');
  if(NUMERIC_REALM_ROWS.some(row=>row.realm===realm))return realm;
  const immortal=realm.match(/^(真仙|金仙|太乙(?:玉仙)?|大罗(?:金仙)?|道祖)(?:期|境)?(下位|中位|上位|初期|中期|后期|圆满|大圆满|巅峰)?$/u);
  if(immortal){const family=immortal[1].slice(0,2),phase={初期:'下位',中期:'中位',后期:'上位',圆满:'上位',大圆满:'上位',巅峰:'上位'};return family==='道祖'?'道祖':immortal[2]?family+(phase[immortal[2]]||immortal[2]):null;}
  const qi=realm.match(/^炼气(?:期)?([一二两三四五六七八九十\d]+)层$/u);
  const chinese=n=>/^\d+$/u.test(n)?Number(n):qiNames.indexOf(n==='两'?'二':n)+1;
  if(qi){const n=chinese(qi[1]);return n>=1&&n<=13?'炼气'+qiNames[n-1]+'层':null;}
  const beast=realm.match(/^(?:妖兽|灵兽|妖族)?([一二三四五六七八九十\d]+)级(?:([一二三四五六七八九十\d]+)层)?$/u);
  if(beast){const n=chinese(beast[1]);if(n===1&&beast[2]){const l=chinese(beast[2]);return l>=1&&l<=13?'炼气'+qiNames[l-1]+'层':null;} if(n>=2&&n<=10&&!beast[2])return NUMERIC_REALM_ROWS[14+n-2].realm;return null;}
  const late=realm.match(/^(筑基|结丹|元婴|化神|炼虚|合体|大乘)(?:期)?(?:圆满|大圆满|巅峰)$/u);
  if(late)return late[1]+'后期';
  const phase=realm.match(/^(筑基|结丹|元婴|化神|炼虚|合体|大乘)期?(初期|中期|后期)$/u);
  return phase?phase[1]+phase[2]:null;
}
export function numericInterval(realm,attribute) {
  if(own(NUMERIC_SCALAR_RANGES,attribute)){const [min,max]=scalarRange(attribute);return {realm:null,min,max,upperInclusive:true,scalar:true};}
  const original=NUMERIC_REALM_ROWS.find(r=>r.realm===resolveNumericRealm(realm)),row=original&&realmRow(original),factor=factorFor(attribute);
  return row&&factor?{...row,min:round(row.min*factor),max:round(row.max*factor),scalar:false}:null;
}
export function numericThirds(interval) {
  if(!interval)return [];
  return NUMERIC_TIERS.map((tier,i)=>({tier,min:interval.min+(interval.max-interval.min)*i/3,max:interval.min+(interval.max-interval.min)*(i+1)/3,upperInclusive:i===2&&interval.upperInclusive}));
}
export function numericRealmRanges(realm) {
  return [...Object.keys(NUMERIC_ATTRIBUTE_FACTORS),...Object.keys(NUMERIC_SCALAR_RANGES)].map(attribute=>({
    attribute,...numericInterval(realm,attribute),
  }));
}
export function classifyNumericAttribute(attribute,raw) {
  const value=number(raw);
  const basic={attribute,value:Number.isFinite(value)?value:null,realm:null,tier:null,status:'unknown',label:'数据缺失',version:NUMERIC_RULE_VERSION};
  if(!Number.isFinite(value))return raw===undefined||raw===null||(typeof raw==='string'&&raw.trim()==='')?basic:{...basic,status:'invalid',label:'非法值待核对'};
  if(value<0)return {...basic,status:'invalid',label:'负值待核对'};
  if(own(NUMERIC_SCALAR_RANGES,attribute)){
    const interval=numericInterval(null,attribute),[,b]=scalarRange(attribute);
    if(value>b)return {...basic,status:'above',label:'超常（超出常规参考，非战力）'};
    const tier=tierAt(interval,value);
    return {...basic,status:'scalar',tier,label:tier+'（非战力）',interval};
  }
  const factor=factorFor(attribute);
  if(!factor)return {...basic,label:'未定义属性'};
  if(value===0)return {...basic,status:'zero',label:resources.has(attribute)?'当前耗尽／未具备':'无有效'+attribute};
  const rows=NUMERIC_REALM_ROWS.map(realmRow),first=rows[0],last=rows.at(-1);
  
  if(value<round(first.min*factor))return {...basic,status:'below',label:'低于凡人常规下限'};
  if(value>round(last.max*factor))return {...basic,status:'above',label:'超出道祖标尺（待扩表）'};
  const row=rows.find(r=>value>=round(r.min*factor)&&(value<round(r.max*factor)||(r.upperInclusive&&value<=round(r.max*factor))));
  if(!row)return basic;
  const tier=tierAt(numericInterval(row.realm,attribute),value);
  return {...basic,status:'rated',realm:row.realm,tier,interval:numericInterval(row.realm,attribute),label:'等效'+row.realm+'·'+tier};
}
export function describeNumericAttribute(attribute,cell,{missing=false}={}) {
  const classifyPart=part=>{const status=cell?.numericValidity?.[part];const result=classifyNumericAttribute(attribute,missing||(status&&status!=='valid')?undefined:cell?.[part]);return status==='invalid'?{...result,status:'invalid',label:'非法值待核对'}:result;};
  const current=classifyPart('current');
  const maximum=classifyPart('max');
  let label=current.label;
  if(!missing&&resources.has(attribute))label='现有'+current.label+'；容量'+maximum.label;
  else if(!missing&&current.status==='rated'&&number(cell?.current)!==number(cell?.max))label+='；常态'+maximum.label;
  return {current,maximum,label};
}
export function describeNumericPanel(attributes) {
  return Object.entries(attributes||{}).filter(([a])=>own(NUMERIC_ATTRIBUTE_FACTORS,a)||own(NUMERIC_SCALAR_RANGES,a)).map(([a,cell])=>({attribute:a,...describeNumericAttribute(a,cell,{missing:cell?.numericMissing===true})}));
}
export function numericPanelNarrative(attributes) {
  return describeNumericPanel(attributes).map(x=>x.attribute+'：'+x.label).join('；');
}
// Explicit new-value generation only. Caller supplies evidence for departures/zero or current resource ratio.
// No function in this module mutates a character, reads a save, or normalizes existing numbers.
export function generateNumericWhiteValues(realm,{tiers={},position=0.5,zeroAttributes=[],resourceRatios={},character={}}={}) {
  const resolved=resolveNumericRealm(realm);if(!resolved)throw new Error('境界不明确，不猜测数值：'+String(realm));
  if(!finite(position)||Number(position)<0||Number(position)>1)throw new Error('position 必须在0至1之间');
  const result={};
  for(const attribute of [...Object.keys(NUMERIC_ATTRIBUTE_FACTORS),...Object.keys(NUMERIC_SCALAR_RANGES)]){
    const interval=numericInterval(resolved,attribute),tier=tiers[attribute]??'正常',ti=NUMERIC_TIERS.indexOf(tier);
    if(ti<0)throw new Error('只允许偏弱、正常、超常');
    const third=numericThirds(interval)[ti];
    // Half-open upper edge: position=1 still belongs to the requested tier, never leaks upward.
    let value=round(third.min+(third.max-third.min)*Math.min(Number(position),0.999999));
    value=Math.max(value,Math.ceil((third.min+Number.EPSILON)*1e6)/1e6);
    if(value>=third.max&&!third.upperInclusive)value=Math.floor((third.max-0.000001)*1e6)/1e6;
    if(resolved==='凡人'&&['法力','法攻','神识','法术穿透'].includes(attribute))value=0;
    if(zeroAttributes.includes(attribute))value=0;
    if(attribute==='修炼速度')value=resolveCultivationRootBase(character).value;
    const ratio=own(resourceRatios,attribute)?number(resourceRatios[attribute]):1;
    if(!Number.isFinite(ratio)||ratio<0||ratio>1)throw new Error('资源比例必须在0至1之间');
    result[attribute]={current:resources.has(attribute)?round(value*ratio):value,max:value};
  }
  return result;
}

export function repairCarriedBreakthrough(person, previous, evidenceFor) {
  const columns=person?.columns, old=previous?.['11'], next=columns?.['11'];
  const from=resolveNumericRealm(previous?.['2']), to=resolveNumericRealm(columns?.['2']);
  if(!from||!to||from===to||numericInterval(to,'物攻').min<=numericInterval(from,'物攻').min||!old||!next)return person;
  const attributes=Object.keys(NUMERIC_ATTRIBUTE_FACTORS);
  if(!attributes.every(key=>typeof old[key]?.max==='number'&&Number.isFinite(old[key].max)&&old[key].max>=0&&
    old[key].max===next[key]?.max&&Number.isFinite(next[key].current)&&next[key].current>=0&&next[key].current<=next[key].max))return person;
  const receipt=[...(person.sourceChanges??[]),...(person.variables??[])].find(row=>
    row.kind==='realm'&&String(row.column)==='2'&&row.action==='set'&&
    resolveNumericRealm(row.previousValue)===from&&resolveNumericRealm(row.terminalValue??row.value)===to);
  const evidence=receipt&&evidenceFor(receipt);
  if(!evidence)return person;
  const ratios=Object.fromEntries([...resources].filter(key=>next[key].max>0).map(key=>[key,next[key].current/next[key].max]));
  const expected=generateNumericWhiteValues(to,{resourceRatios:ratios,character:columns});
  const adjusted={...next}, sourceChanges=[...(person.sourceChanges??[])];
  for(const key of attributes){
    const {min}=numericInterval(to,key);
    if(next[key].max>=min)continue;
    const updated=expected[key];
    adjusted[key]=updated;
    const before=old[key].current===updated.current?old[key].max:old[key].current;
    const after=old[key].current===updated.current?updated.max:updated.current;
    sourceChanges.push({kind:'attribute',column:'11',subject:key,action:'set',value:after,previousValue:before,terminalValue:after,
      basis:'已证实由'+from+'突破至'+to+'，按本地白值标尺补齐沿用的前境界数值。',
      ...(typeof evidence==='string'?{evidence}:{}),...(receipt.evidenceRef?{evidenceRef:receipt.evidenceRef}:{})});
  }
  if(sourceChanges.length===(person.sourceChanges?.length??0))return person;
  const terminal=person.terminal?.map(row=>row.kind==='attribute'&&String(row.column)==='11'&&adjusted[row.subject]!==next[row.subject]&&adjusted[row.subject]
    ?{...row,value:adjusted[row.subject].current}:row);
  return {...person,columns:{...columns,11:adjusted},sourceChanges,...(terminal?{terminal}:{})};
}

export function carryAdjustedWhiteValues(person, previous, adjusted) {
  const raw=previous?.['11'], fixed=adjusted?.['11'], next=person?.columns?.['11'];
  if(!raw||!fixed||!next||raw===fixed||resolveNumericRealm(previous['2'])!==resolveNumericRealm(person.columns['2']))return person;
  const replacements=Object.fromEntries(Object.keys(NUMERIC_ATTRIBUTE_FACTORS).flatMap(key=>{
    const [a,b,c]=[raw[key],fixed[key],next[key]];
    return a&&b&&c&&a.current===c.current&&a.max===c.max&&(a.current!==b.current||a.max!==b.max)?[[key,b]]:[];
  }));
  if(!Object.keys(replacements).length)return person;
  const terminal=person.terminal?.map(row=>row.kind==='attribute'&&String(row.column)==='11'&&replacements[row.subject]
    ?{...row,value:replacements[row.subject].current}:row);
  return {...person,columns:{...person.columns,11:{...next,...replacements}},...(terminal?{terminal}:{})};
}
export function legacyMortalNumericRulesText(options) {
  const lines=[
    '【压缩白值与等效实力规则表 '+NUMERIC_RULE_VERSION+'】',
    '这是本轮容器体系的可调整规则，不是旧存档迁移指令。数值用于单项比较与叙事，不自动判胜负，不存在综合战力求和。',
    '第11列只写白值（无装备、功法、特质、临时Buff加成）。容器继续只读白值上限，法攻容器读法力白值；不拿最终值递归放大。最终值由本地calculateTotalAttributes结算一次。',
    '表内基准是区间下界，区间左闭右开，最后渡劫上界1500000可取。相邻区间共边、无空档无重叠。每个属性区间等长分三份：下1/3偏弱，中1/3正常，上1/3超常；恰在分界归更高一档。',
    '基准区间乘下列系数得到各属性白值区间：'+Object.entries(NUMERIC_ATTRIBUTE_FACTORS).map(([k,v])=>k+'×'+v).join('，')+'。穿透是独立绝对值标尺，不是伤害百分比。',
    '境界 | 基准下界 | 基准上界（不含，渡劫末端含）',
    ...NUMERIC_MORTAL_REALM_ROWS.map(r=>r.realm+' | '+r.min+' | '+r.max),
    '气运、魅力单独用[0,100]三等分；修炼速度以[0,200]作为常规效率参考三等分，不是上限；白值按灵根合同初始化，未知100，200为双倍效率，混沌灵根2000为天灵根十倍。三者不是战斗境界，超过常规上界保留实际值并标超范围。',
    '新建人物或确有依据补齐缺失白值时，先确定真实小境界，再逐属性选偏弱/正常/超常，未明确偏科默认正常段中点；不得把一项强弱复制到全属性，不额外随机刷强度。凡人没有修仙法力/法攻/神识/法穿时为0，不为凑表生造。',
    '血量/法力保存current与max：无损耗current=max，已有损耗或恢复遵守事实。当前为0不当成缺失，不自动补满；缺字段写未知，负数/非法数据待核对。沿用当前与上限同加常驻增益的伤势差额模型，例如0/160加法力40得到40/200，不是恢复至满值；临时Buff仅改当前。修为改变不自动重置资源。',
    '只在真实新建、缺失补齐或本轮已经完成的永久成长/突破等事实需要变更时产生对应白值命令；沿用原有命令白名单和B1控制边界。旧档、旧草稿、已存在高数值及自定义白值保持，不按境界覆盖、不一刀切缩放、不每轮重采样。无明确数值体系的旧值不能冒充已迁移新表。',
    '一级妖兽只有明确一至十三层才对应炼气同层；二至十级依次对应筑基初/中/后、结丹初/中/后、元婴初/中/后；化神以上妖修按同名境界。不明确的炼气期、一级或未收录境界不猜层数。',
    '本地把最终当前值逐属性转换为等效某境界·偏弱/正常/超常，血蓝同时说明现有储量与上限容量。标签只代表这一属性，不授予修为、神通、境界威压或必胜结论；战斗仍结合短板、术法克制、消耗、距离和实际条件。',
    '低于凡人下界、零值、负值、数据缺失、超出渡劫上界均显式说明，不伪造新境界。模型只读等效描述，不把标签回写第2列或第11列，不把装备或临时增益再次记成白值。',
    buildCultivationSpeedRules(options)
  ];
  return lines.join('\n');
}

export function numericRulesText(options) {
  return legacyMortalNumericRulesText(options)
    .replace('最后渡劫上界1500000可取','最后道祖上界300000000可取')
    .replace('不含，渡劫末端含','不含，道祖末端含')
    .replace('渡劫 | 1000000 | 1500000','渡劫 | 1000000 | 1500000\n'+NUMERIC_IMMORTAL_REALM_ROWS.map(r=>r.realm+' | '+r.min+' | '+r.max).join('\n')+'\n仙界扩表为1.1.6暂定设计，承接原压缩增长与容器系数，可在数值规则中调整；不是原著定量结论。只用于新建/有依据成长及只读等效标签，旧档白值不重算。超脱者不在可选或有限数值表内。')
    .replace('超出渡劫上界均','超出道祖上界均');
}
