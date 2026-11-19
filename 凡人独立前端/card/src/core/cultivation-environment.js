import { numericSetting } from './numeric-settings.js';

export const SPIRIT_BANDS = Object.freeze({
  '绝灵':0, '枯竭':10, '极稀':25, '稀薄':65, '普通':100, '充沛':120, '灵眼':140, '灵脉核心':180, '高浓秘境':240,
});
export const SPIRIT_SOURCE_RATINGS = Object.freeze({
  vein: {'断脉':0, '重损':.4, '中损':.7, '轻损':.9, '完好':1},
  eye: {'微型':5, '普通':12, '优质':20, '上佳':30},
  emitter: {'低':25, '中':60, '高':120},
  array: {'小型':1.1, '常规':1.25, '强力':1.5, '大型':2},
  barrier: {'通透':1, '轻阻':.75, '强阻':.4, '隔断':0},
  range: {'中心':1, '近缘':.6, '外围':.25, '范围外':0},
  tide: {'低谷':.8, '常态':1, '高峰':1.2, '大潮':1.4},
  drain: {'轻':.1, '中':.3, '重':.6, '耗尽':1},
  convert: {'轻':.25, '中':.5, '重':.75, '完全':1},
  quality: {'纯净':1, '混杂':.85, '驳杂':.6},
  stability: {'稳定':1, '轻紊乱':.75, '强紊乱':.5, '剧烈':.25, '禁止吐纳':0},
});
const SPIRIT_SOURCE_LABELS = {
  vein:'灵脉完好率', eye:'灵眼供给点', emitter:'独立灵源供给点', array:'聚灵倍率', barrier:'屏障通透率',
  range:'距离折算', tide:'灵潮供给倍率', drain:'抽取消耗率', convert:'气息转换率', quality:'气息品质', stability:'环境稳定性',
};
export const CULTIVATION_RARITY = Object.freeze({ '人阶':1, '玄阶':1.15, '地阶':1.35, '天阶':1.6 });
const AID_PARAMETERS = {
  '直增丹同品阶基准进度点':1, '直增丹品阶差上限':8, '直增丹负品阶差绝对值上限':4,
  '辅材原始效率上限参数':24, '辅材基准原始效率':4, '辅材每品阶原始效率':1.5,
  '辅材原始效率品阶差除数':3, '辅材原始效率品阶差下限倍率':.25,
  '辅材原始效率品阶差上限倍率':2, '辅材递减效率参考值':60,
};
export const SPIRIT_RULE_TEXT = [
  '地图底值按密室或准确地点、子区、大区依次读取。自然灵眼已含于底值时只计一次。缺值以普通浓度计，明确零值保留。',
  '每条供给乘灵脉或灵源状态、灵潮、作用范围和跨界通透，再按所供灵源选择同源最高聚灵倍率，最后扣减抽取并计算气息转化。',
  '环境原始浓度为所有气息总量。角色可用浓度只取可吸收组分，逐项折算品质后乘稳定性。普通吐纳乘可用浓度÷100。',
  '阵法或阵盘须设于具体地点且实际启用。可移动阵盘未布设时不增加灵气。阵停、灵源移走或限期届满从生效时刻恢复相应供给。',
  '修炼实际发生后按时间、位置、环境和修速分段。丹药直增单算，独立辅材乘吐纳效率。灵脉、阵法、灵眼已纳入环境时不再乘旧倍率。',
].join('\n');

const POINT_DEFAULTS = {
  '黄枫谷':'充沛', '青云山':'普通', '小寰岛':'稀薄', '云梦山':'灵脉核心', '落云宗':'灵脉核心',
  '天门峰':300, '天宵峰':300, '天柱峰':350,
};
const REGION_DEFAULTS = { '越国':'稀薄', '魁星岛':'普通', '云梦山':'灵脉核心', '灵界大陆':'灵脉核心', '人界大陆':'普通' };
const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const bound = (value, fallback=1) => Math.min(1, number(value, fallback));
const setting = (id, name, fallback) => number(numericSetting(id,name)?.[0], fallback);
const sourceRating = (kind, tier) => setting('spirit-sources', SPIRIT_SOURCE_LABELS[kind]+'·'+tier, SPIRIT_SOURCE_RATINGS[kind]?.[tier]);
const aidParameter = name => setting('cultivation-aids',name,AID_PARAMETERS[name]);
const ambient = value => typeof value === 'string' && Object.hasOwn(SPIRIT_BANDS,value)
  ? setting('spirit-concentration',value,SPIRIT_BANDS[value])
  : number(value);

export function spiritNumericTables() {
  return [
    { id:'spirit-concentration', name:'环境灵气浓度', content:['地点档位 | 基础浓度',
      ...Object.entries(SPIRIT_BANDS).map(([label,value])=>label+' | '+value), '', SPIRIT_RULE_TEXT].join('\n') },
    { id:'spirit-sources', name:'灵源、阵法与环境变化', content:['影响项 | 数值',
      ...Object.entries(SPIRIT_SOURCE_RATINGS).flatMap(([kind,tiers])=>Object.entries(tiers)
        .map(([label,value])=>SPIRIT_SOURCE_LABELS[kind]+'·'+label+' | '+value)), '', SPIRIT_RULE_TEXT].join('\n') },
    { id:'cultivation-aids', name:'修炼丹药与辅材', content:['丹药稀有度 | 倍率',
      ...Object.entries(CULTIVATION_RARITY).map(([label,value])=>label+' | '+value),
      '', '计算参数 | 数值', ...Object.entries(AID_PARAMETERS).map(([label,value])=>label+' | '+value),
      '直增丹药按实际炼化数量×同品阶基准进度点×2^限制(丹药小品阶−修士小品阶,−负品阶差绝对值上限,品阶差上限)×稀有度倍率。',
      '辅材原始效率为数量×min(上限参数,基准原始效率+每品阶原始效率×小品阶)×稀有度倍率×限制(2^(品阶差÷除数),下限倍率,上限倍率)。同段合计R，效率系数为1+参考值÷100×(1−exp(−R÷参考值))。',
      '聚灵阵盘使用灵源、阵法与环境变化规则。环境倍率只进普通吐纳，丹药直增单算。'].join('\n') },
  ];
}

function contains(point, polygon) {
  let inside = false;
  for (let i=0,j=polygon.length-1; i<polygon.length; j=i++) {
    const [x1,y1]=polygon[j], [x2,y2]=polygon[i];
    const cross=(point.x-x1)*(y2-y1)-(point.y-y1)*(x2-x1);
    if (cross===0 && point.x>=Math.min(x1,x2) && point.x<=Math.max(x1,x2) && point.y>=Math.min(y1,y2) && point.y<=Math.max(y1,y2)) return true;
    if ((y1>point.y)!==(y2>point.y) && point.x<(x2-x1)*(point.y-y1)/(y2-y1)+x1) inside=!inside;
  }
  return inside;
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum,[x,y],i)=>{
    const [nextX,nextY]=points[(i+1)%points.length];
    return sum+x*nextY-y*nextX;
  },0));
}

export function resolveSpiritLocation(map, point={}) {
  if ((!Number.isFinite(point.x)||!Number.isFinite(point.y)) && point.name) {
    const matches=[...(map?.rooms||[]),...(map?.points_of_interest||[])].filter(entry=>
      entry.name===point.name && (!point.mapId||!entry.mapId||entry.mapId===point.mapId) &&
      Number.isFinite(entry.x)&&Number.isFinite(entry.y));
    if (matches.length===1) point={ ...point, x:matches[0].x, y:matches[0].y };
  }
  const validCoordinates=Number.isFinite(point.x)&&Number.isFinite(point.y);
  const layers = [];
  for (const key of ['terrains','main_regions','sub_regions','points_of_interest','rooms']) {
    const isPoint=key==='points_of_interest'||key==='rooms';
    const match=(map?.[key]||[]).filter(entry=>{
      if (point.mapId && entry.mapId && entry.mapId!==point.mapId) return false;
      if (validCoordinates && Array.isArray(entry.points) && entry.points.length>=3 && contains(point,entry.points)) return true;
      if (isPoint && validCoordinates && entry.x===point.x && entry.y===point.y) return !point.name || point.name===entry.name || key!=='rooms';
      return (!validCoordinates || !isPoint) && point.name && entry.name===point.name;
    }).sort((a,b)=>Number(a.name===point.name)-Number(b.name===point.name) ||
      polygonArea(b.points||[])-polygonArea(a.points||[]));
    if (match.length) layers.push(match.at(-1));
  }
  let base;
  const sources=new Map();
  for (const layer of layers) {
    const explicit=ambient(layer.spiritConcentration);
    const value=explicit ?? ambient(POINT_DEFAULTS[layer.name] ?? REGION_DEFAULTS[layer.name]);
    if (value!==undefined) base=value;
    for (const source of Array.isArray(layer.spiritSources)?layer.spiritSources:[]) if (source?.id) sources.set(source.id,source);
  }
  if (!validCoordinates) base??=ambient(POINT_DEFAULTS[point.name]??REGION_DEFAULTS[point.name]);
  const known=base!==undefined;
  return { base:base ?? 100, known, name:layers.at(-1)?.name || point.name || '', sources:[...sources.values()] };
}

export function spiritClock(text) {
  if (typeof text==='number' && Number.isFinite(text)) return text;
  const match=String(text??'').trim().match(/^(\d+)(?:\s*年\s*|[.-])(\d{1,2})(?:\s*月\s*|[.-])(\d{1,2})(?:\s*[日号])?(?:\s*(\d{1,2})[:：](\d{2}))?$/u);
  if (!match) return null;
  const [,y,m,d,h='0',min='0']=match.map((part,i)=>i===0||part===undefined?part:Number(part));
  if (!Number.isSafeInteger(y*535680)||m<1||m>12||d<1||d>31||h>23||min>59) return null;
  return ((y*12+(m-1))*31+d-1)*1440+Number(h)*60+Number(min);
}

export function formatSpiritClock(value) {
  const day=Math.floor(value/1440), month=Math.floor(day/31), at=value%1440;
  return String(Math.floor(month/12)).padStart(4,'0')+'年'+(month%12+1)+'月'+(day%31+1)+'日 '+
    String(Math.floor(at/60)).padStart(2,'0')+':'+String(at%60).padStart(2,'0');
}

function activeSource(source, at) {
  const hasTime=source.start!=null||source.end!=null;
  if (hasTime && at==null) return false;
  const start=source.start==null?-Infinity:spiritClock(source.start);
  const end=source.end==null?Infinity:spiritClock(source.end);
  return source.enabled!==false && start!==null && end!==null && (!hasTime || (at>=start && at<end));
}

function targets(effect, supply) {
  if (effect.target==='all') return true;
  if (effect.target!=null) return effect.target===supply.id || effect.target===supply.origin;
  if (effect.kind==='barrier') return supply.crossing===true;
  return ['array','quality','stability'].includes(effect.kind);
}

const effectRate=(effect, fallback=1)=>number(effect.rate, sourceRating(effect.kind,effect.tier) ?? fallback);

export function calculateSpiritConcentration(site, options={}) {
  const at=spiritClock(options.at);
  const allSources=[...new Map((site.sources||[]).filter(source=>source?.id).map(source=>[source.id,source])).values()];
  const sources=allSources.filter(source=>activeSource(source,at));
  const effects=sources.filter(source=>!['eye','emitter','vein','transfer'].includes(source.kind));
  let background=number(site.base,ambient('普通'));
  const contributions=[];
  for (const source of allSources) {
    if (!['eye','emitter','vein','transfer'].includes(source.kind)) continue;
    const rated=number(source.amount,sourceRating(source.kind,source.tier)??0);
    const included=source.included===true || source.kind==='vein';
    const amount=included?Math.min(rated,background):rated;
    background-=included?amount:0;
    if (activeSource(source,at)) contributions.push({ ...source, amount });
  }
  contributions.unshift({ id:'background', amount:background });
  let parts=contributions.map(supply=>{
    const matching=kind=>effects.filter(effect=>effect.kind===kind&&targets(effect,supply));
    let amount=supply.amount*bound(supply.power);
    if (supply.kind==='vein') amount*=bound(effectRate(supply));
    amount*=number(supply.tide,1)*bound(supply.range)*bound(supply.transmission);
    for (const effect of matching('tide')) amount*=effectRate(effect);
    for (const kind of ['range','barrier']) for (const effect of matching(kind)) amount*=bound(effectRate(effect));
    const gathering=Math.max(1,...matching('array').map(effect=>1+(effectRate(effect)-1)*bound(effect.power)));
    amount*=gathering;
    for (const effect of matching('drain')) amount*=1-bound(effectRate(effect,0),0);
    const quality=Math.min(bound(supply.quality),...matching('quality').map(effect=>bound(effectRate(effect))));
    return { id:supply.id, origin:supply.id, amount, qi:supply.qi||'普通', quality, eligibleActorIds:supply.eligibleActorIds };
  });
  for (const effect of effects.filter(source=>source.kind==='convert'&&source.to)) {
    const converted=[];
    parts=parts.map(part=>{
      if (!targets(effect,part)||part.qi===effect.to||(effect.from&&part.qi!==effect.from)) return part;
      const amount=part.amount*bound(effectRate(effect,0),0);
      converted.push({ ...part, qi:effect.to, amount });
      return { ...part, amount:part.amount-amount };
    }).concat(converted);
  }
  const channels=Object.create(null);
  for (const part of parts) channels[part.qi]=(channels[part.qi]||0)+part.amount;
  const allowed=new Set(options.compatible??['普通']);
  const stability=Math.min(1,...effects.filter(source=>source.kind==='stability').map(effect=>bound(effectRate(effect))));
  const raw=parts.reduce((sum,part)=>sum+part.amount,0);
  const usable=parts.reduce((sum,part)=>sum+(allowed.has(part.qi) &&
    (!Array.isArray(part.eligibleActorIds)||part.eligibleActorIds.includes(options.actorId))?part.amount*part.quality:0),0)*stability;
  return { raw, usable, channels, stability, multiplier:usable/100, sources:parts };
}

export function cultivationAidValues(item, actorRank) {
  const aid=readCultivationAid(item);
  if (!aid) return null;
  if (aid.kind==='array'&&sourceRating('array',aid.tier)!==undefined) {
    return { kind:'array', tier:aid.tier, multiplier:sourceRating('array',aid.tier) };
  }
  if (!['elixir','material'].includes(aid.kind)) return null;
  const itemRank=number(aid.itemRank), count=number(item.count,1);
  const rarity=setting('cultivation-aids',aid.rarity,CULTIVATION_RARITY[aid.rarity]);
  if (!Number.isInteger(itemRank)||itemRank<1||!Number.isInteger(count)||!Number.isInteger(actorRank)||actorRank<1||rarity===undefined) return null;
  const difference=itemRank-actorRank;
  if (aid.kind==='elixir') {
    const exponent=Math.max(-aidParameter('直增丹负品阶差绝对值上限'),Math.min(aidParameter('直增丹品阶差上限'),difference));
    return { kind:'elixir', gain:count*aidParameter('直增丹同品阶基准进度点')*2**exponent*rarity };
  }
  const scale=2**(difference/(aidParameter('辅材原始效率品阶差除数')||3));
  const bounded=Math.max(aidParameter('辅材原始效率品阶差下限倍率'),Math.min(aidParameter('辅材原始效率品阶差上限倍率'),scale));
  const rate=Math.min(aidParameter('辅材原始效率上限参数'),aidParameter('辅材基准原始效率')+aidParameter('辅材每品阶原始效率')*itemRank);
  const rawEfficiency=count*rate*rarity*bounded;
  return { kind:'material', rawEfficiency };
}

export function readCultivationAid(item) {
  if (!item || typeof item!=='object') return null;
  if (item.cultivationAid && typeof item.cultivationAid==='object') return item.cultivationAid;
  const type=item.type||item['2']||'';
  const name=item.name||item['1']||'';
  const effect=item.effect||item['4']||'';
  const grade=String(item.grade||item.tier||'')+' '+name+' '+effect;
  if (/阵盘|阵旗|阵法|阵具/u.test(type+' '+name) && /聚灵|汇聚.*灵气/u.test(name+' '+effect)) {
    const tier=grade.match(/小型|常规|强力|大型/u)?.[0] ??
      ({ 下品:'小型', 中品:'常规', 上品:'强力', 极品:'大型', 顶阶:'大型' })[grade.match(/下品|中品|上品|极品|顶阶/u)?.[0]];
    if (tier) return { kind:'array', tier };
  }
  if (!/丹药|灵膳|辅材|灵药/u.test(type)) return null;
  const rarity=grade.match(/人阶|玄阶|地阶|天阶/u)?.[0];
  const rank=grade.match(/([1-9]\d*|[一二三四五六七八九十]{1,3})品/u)?.[1];
  const digits='一二三四五六七八九';
  const digit=character=>digits.indexOf(character)+1;
  const itemRank=rank?.includes('十')?(digit(rank[0])||1)*10+digit(rank.split('十')[1]?.[0]??' '):Number(rank)||digit(rank??' ');
  if (!rarity||!itemRank) return null;
  if (/提高.*(?:吐纳|修炼)(?:速度|效率)|吐纳增幅|闭关效率/u.test(effect)) return { kind:'material', itemRank, rarity };
  if (/增进修为|增长修为|直接(?:增加|提升)修为/u.test(effect)) return { kind:'elixir', itemRank, rarity };
  return null;
}

export function cultivationItemRank(realm) {
  const text=String(realm||'').trim().replace(/^练气/u,'炼气').replace(/^金丹/u,'结丹');
  if (text.startsWith('炼气')) return 1;
  const stage=['筑基','结丹','元婴','化神','炼虚','合体','大乘'].findIndex(name=>text.startsWith(name));
  if (stage<0) return text.startsWith('渡劫')?23:null;
  if (!/初期|中期|后期|圆满|巅峰/u.test(text)) return null;
  return 2+stage*3+(/中期/u.test(text)?1:/后期|圆满|巅峰/u.test(text)?2:0);
}

export function splitSpiritPeriod(from, to, records) {
  const times=new Set([from,to]);
  for (const record of records) {
    for (const value of [record.start,record.end]) {
      const time=spiritClock(value);
      if (time!==null&&time>from&&time<to) times.add(time);
    }
  }
  const ordered=[...times].sort((a,b)=>a-b);
  return ordered.slice(1).map((end,i)=>({ from:ordered[i], to:end }));
}

export function materialEfficiencyMultiplier(rawEfficiency) {
  const reference=aidParameter('辅材递减效率参考值');
  return reference>0 ? 1+reference/100*(1-Math.exp(-rawEfficiency/reference)) : 1;
}

export function cultivationAidSummary(item, actorRank) {
  const aid=readCultivationAid(item);
  if (!aid) return '';
  const value=cultivationAidValues(item,actorRank);
  if (value?.kind==='array') return '聚灵 '+value.multiplier+'×（实际启用时）';
  if (value?.kind==='elixir') return '炼化增加 '+Number(value.gain.toFixed(4))+' 个进度点';
  if (value?.kind==='material') return '吐纳增幅 '+Number(((materialEfficiencyMultiplier(value.rawEfficiency)-1)*100).toFixed(2))+'%';
  return ['elixir','material'].includes(aid.kind) && number(aid.itemRank)!==undefined && Object.hasOwn(CULTIVATION_RARITY,aid.rarity)
    ? (aid.kind==='elixir'?'炼化直增':'吐纳辅材')+' · '+aid.itemRank+'品 · '+aid.rarity : '';
}
