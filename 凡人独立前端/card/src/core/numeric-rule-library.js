import { numericRulesText, legacyMortalNumericRulesText, NUMERIC_IMMORTAL_REALM_ROWS, NUMERIC_ATTRIBUTE_FACTORS, NUMERIC_SCALAR_RANGES } from './numeric-realms.js';
import { techniqueSpeedContract, buildCultivationSpeedRules, CULTIVATION_ROOT_BASES, CULTIVATION_BASE_YEARS,
  CULTIVATION_DAYS_PER_YEAR, TECHNIQUE_SPEED_BY_GRADE, CULTIVATION_ROOT_LABELS, CULTIVATION_ROOT_TRAITS } from './cultivation-speed.js';
import { CONTAINER_LIMITS, CONTAINER_HARD_CAPS } from './container-equipment.js';
import { applyNumericSettings } from './numeric-settings.js';

const baselineRules = () => numericRulesText({includeTechniqueSpeed:false}).split('\n【修炼速度生成与消费合同')[0]
  .split('\n').filter(line=>!line.startsWith('基准区间乘下列系数')&&!line.startsWith('气运、魅力单独用')).join('\n');
const rootRules = () => buildCultivationSpeedRules({includeTechniqueSpeed:false}).split('\n');
const techniqueTable = () => [
  '功法品阶 | 下品 | 中品 | 上品 | 极品',
  ...Object.entries(TECHNIQUE_SPEED_BY_GRADE).map(([key,values])=>[key,...values.map(x=>'+'+x+'%')].join(' | ')),
  techniqueSpeedContract().replace(/：黄阶 [^。]+。/u,'，具体倍率见上表。'),
].join('\n');

export const NUMERIC_BASELINE_REFERENCES = '${numeric_rule:attribute-baseline}\n${numeric_rule:attribute-factors}\n${numeric_rule:scalar-ranges}\n${numeric_rule:root-speed}\n${numeric_rule:cultivation-progress}\n${numeric_rule:technique-speed}';

export function numericRuleDefaults() {
  const transmission = Object.entries(CONTAINER_LIMITS).flatMap(([tier, qualities]) =>
    Object.entries(qualities).map(([quality, rule]) => {
      const rate = rule.minRate === rule.maxRate ? rule.minRate.toFixed(2) : `${rule.minRate}–${rule.maxRate}`;
      return `${tier}·${quality} | ${rate} | ${rule.minConsciousness} / ${rule.perfectConsciousness}`;
    }));
  return [
    { id: 'attribute-baseline', name: '境界白值', content: baselineRules() },
    { id: 'attribute-factors', name: '白值换算系数', content: ['属性 | 基准倍率',
      ...Object.entries(NUMERIC_ATTRIBUTE_FACTORS).map(([key,value])=>`${key} | ${value}`),
      '境界区间分别乘对应系数，穿透为独立绝对值。'].join('\n') },
    { id: 'scalar-ranges', name: '气运、魅力与修速', content: ['属性 | 常规下界 | 常规上界',
      ...Object.entries(NUMERIC_SCALAR_RANGES).map(([key,value])=>[key,...value].join(' | ')),
      '这三项使用独立参考区间，不换算战斗境界。修炼速度超过常规上界时保留实际值。'].join('\n') },
    { id: 'root-speed', name: '灵根类型与修速', content: ['五行灵根类型 | 修炼速度白值',
      ...Object.entries(CULTIVATION_ROOT_BASES).map(([key,value])=>`${CULTIVATION_ROOT_LABELS[key]} | ${value}`),
      '', '特殊灵根 | 白值算法',
      '单属性异灵根（风、雷、冰、暗） | 沿用天灵根',
      '双属性混合异灵根（如土、雷） | 沿用双灵根',
      '混沌灵根（万物有灵） | 天灵根 × 10',
      '', ...CULTIVATION_ROOT_TRAITS,
      ...rootRules().slice(1,7).map((line,index)=>index===1?
        '新建与真正缺失时，按已确认灵根取表内白值。混沌灵根为天灵根十倍，单属性异灵根取单灵根，双属性混合异灵根取双灵根。无灵根为0；未明真灵根与伪灵根分别取三灵根和四灵根。未知或自定义未明暂100。':line)].join('\n') },
    { id: 'cultivation-progress', name: '修炼时间与进度', content: ['境界 | 每小境界基准年数',
      ...Object.entries(CULTIVATION_BASE_YEARS).map(([key,value])=>`${key} | ${value}`),
      '', '历法参数 | 数值', `每年天数 | ${CULTIVATION_DAYS_PER_YEAR}`,
      ...rootRules().slice(7).map(line=>line.startsWith('每日进度点')?
        '每日进度点＝100÷（基准年数×每年天数）×最终修速÷100。高阶未定义不得外推。':line)].join('\n') },
    { id: 'technique-speed', name: '功法修炼速度', content: techniqueTable() },
    { id: 'sect-income', name: '宗门供给与差事收入', content: [
      '黄枫谷炼气弟子完成普通杂务，每年约得20–30块下品灵石。按实际履职月份折算，全年范围供校准。',
      '持续照管药园等收入较高的低级差事，每月约2–5块下品灵石。首次任职从低端估起，涨报酬须符合职责和表现。',
      '黄枫谷筑基弟子每年可领一块中品灵石，并有额外材料和供给。不同宗门、身份及职务按当地制度估算。',
      '按实际已任职时间或已有资格的供给周期合计过账，入门当天不预发未来俸禄。同一份供给与同一段差事不重复记，已结算的期间不再计入。来源、品类和实发数有原文时优先用原文。',
    ].join('\n') },
    { id: 'equipment-transmission', name: '装备容器与神识门槛', content: [
      '器类·品质 | 传导率 | 启动 / 完整传导神识',
      ...transmission,
      '传导读取无加成白值，法攻读取法力白值。启动前不传导，启动后按七成，达到完整门槛后按全部传导，并受单件硬锁约束。',
      '混沌之宝的单件硬锁乘本档传导倍率。至高档专属混沌造化瓶。',
    ].join('\n') },
    { id: 'equipment-hard-caps', name: '装备单件硬锁', content: [
      ['大境界',...Object.keys(CONTAINER_HARD_CAPS.凡人)].join(' | '),
      ...Object.entries(CONTAINER_HARD_CAPS).map(([realm,values])=>[realm,...Object.values(values)].join(' | ')),
      '单件只提供一项加成。混沌之宝按传导倍率放大本表上限。',
      '仙界单件硬锁为1.1.6暂定扩展，按各大境界白值下界相对渡劫同比增长；原十档与独立气运/魅力/修速上限不变。',
    ].join('\n') },
  ];
}

export function readNumericRulePack(pack) {
  if (pack?.kind !== 'numeric-rules' || pack.version !== 1 || !Array.isArray(pack.rules) || !pack.rules.length) {
    throw new Error('请选择数值规则设定导出的 JSON 规则包');
  }
  const seen = new Set();
  return pack.rules.map(rule => {
    const {id, name, content} = rule || {};
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(id) || seen.has(id) ||
        typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        typeof content !== 'string' || !content.trim()) throw new Error('规则编号、名称或正文无效');
    seen.add(id);
    return {id, name:name.trim(), content};
  });
}

export function mergeNumericRules(defaults, replacements) {
  const rules = new Map(defaults.map(rule => [rule.id,rule]));
  for (const rule of replacements) rules.set(rule.id,rule);
  return [...rules.values()];
}

function tableRows(content) {
  return new Map(content.split(/\r?\n/u).flatMap(line=>{
    const [key,...cells]=line.trim().replace(/^\||\|$/gu,'').split('|').map(cell=>cell.trim());
    return cells.length?[[key,cells]]:[];
  }));
}

function parseCell(cell) {
  const parts=cell.replace(/[,，%％]/gu,'').split(/\s*[–—/／]\s*/u);
  if(parts.some(part=>!/^\+?\d+(?:\.\d+)?$/u.test(part)))return null;
  const values=parts.map(Number);
  return values.every(value=>Number.isFinite(value)&&value<=Number.MAX_SAFE_INTEGER)?values:null;
}

export function configureNumericRules(rules) {
  const configured=new Map(), edits=new Map(rules.map(upgradeNumericRule).map(row=>[row.id,row.content]));
  for(const rule of numericRuleDefaults()){
    const edit=edits.get(rule.id);
    if(!edit||edit===rule.content)continue;
    const input=tableRows(edit), values=new Map();
    const defaults=tableRows(rule.content);
    if(![...defaults].some(([label,cells])=>input.has(label)&&cells.every(parseCell)))continue;
    for(const [label,cells] of defaults){
      const expected=cells.map(parseCell);
      if(expected.some(value=>!value))continue;
      const edited=input.get(label);
      if(!edited)throw new Error(rule.name+'缺少「'+label+'」');
      const parsed=edited.map(parseCell);
      if(parsed.length!==expected.length||parsed.some(value=>!value))throw new Error(rule.name+'「'+label+'」包含无效数值');
      let row=parsed.flat();
      if(rule.id==='equipment-transmission'){
        const [rate,threshold]=parsed;
        if(rate.length>2||threshold.length!==2||rate[0]<=0||(rate[1]??rate[0])<rate[0]||threshold[1]<=threshold[0]||
          rate.some(value=>Math.round(value*100)/100!==value))throw new Error(label+'的传导率或神识门槛无效');
        row=[rate[0],rate[1]??rate[0],...threshold];
      }else if(parsed.some(value=>value.length!==1))throw new Error(rule.name+'「'+label+'」须逐项填写数字');
      if(['attribute-baseline','scalar-ranges'].includes(rule.id)&&row[1]<=row[0])throw new Error(label+'的上界须大于下界');
      if(['attribute-factors','cultivation-progress'].includes(rule.id)&&row[0]<=0)throw new Error(label+'须大于零');
      values.set(label,row);
    }
    if(rule.id==='attribute-baseline'){
      const ranges=[...values.values()];
      if(ranges.some((row,index)=>index&&row[0]!==ranges[index-1][1]))throw new Error('相邻境界的上界和下界须相同');
    }
    configured.set(rule.id,values);
  }
  applyNumericSettings(configured);
}

export function upgradeNumericRule(rule) {
  const defaults=numericRuleDefaults().find(row=>row.id===rule.id);
  if(rule.id==='attribute-baseline'){
    const rows=tableRows(rule.content);
    if(rows.has('渡劫')&&!NUMERIC_IMMORTAL_REALM_ROWS.some(row=>rows.has(row.realm))){
      const last=Number(rows.get('渡劫')[1]);
      if(Number.isFinite(last)&&last>0){
        const scale=last/1500000;
        const extra=NUMERIC_IMMORTAL_REALM_ROWS.map(row=>row.realm+' | '+Number((row.min*scale).toFixed(6))+' | '+Number((row.max*scale).toFixed(6))).join('\n');
        return {...rule,content:rule.content.replace(/^(渡劫\s*\|[^\n]+)$/mu,'$1\n'+extra)
          .replace('最后渡劫上界1500000可取','最后道祖上界可取').replace('不含，渡劫末端含','不含，道祖末端含').replace('超出渡劫上界均','超出道祖上界均')+'\n仙界扩表为1.1.6暂定设计；保留既有区间，按渡劫末端同比衔接，仅新建和只读标签使用，不重算旧人物。'};
      }
    }
  }
  if(rule.id==='equipment-hard-caps'){
    const rows=tableRows(rule.content),families=['真仙','金仙','太乙','大罗','道祖'];
    const old=rows.get('渡劫');
    if(old&&old.length===13&&old.every(cell=>Number.isFinite(Number(cell))&&Number(cell)>=0)&&!families.some(name=>rows.has(name))){
      const extra=families.map(name=>{
        const scale=NUMERIC_IMMORTAL_REALM_ROWS.find(row=>row.realm.startsWith(name)).min/1000000;
        return name+' | '+old.map((value,index)=>index<10?Number((Number(value)*scale).toFixed(6)):value).join(' | ');
      }).join('\n');
      return {...rule,content:rule.content.replace(/^(渡劫\s*\|[^\n]+)$/mu,'$1\n'+extra)+'\n仙界单件硬锁为1.1.6暂定扩展，按仙界白值大境界下界相对渡劫同比衔接；原档与独立气运/魅力/修速硬锁不变。'};
    }
  }
  if(rule.id==='root-speed'&&/^1\s+灵根\s*\|/mu.test(rule.content)){
    const old=tableRows(rule.content);
    const content=defaults.content.split('\n').map(line=>{
      const count=Object.keys(CULTIVATION_ROOT_LABELS).find(key=>line.startsWith(CULTIVATION_ROOT_LABELS[key]+' | '));
      return count&&old.has(count+' 灵根')?CULTIVATION_ROOT_LABELS[count]+' | '+old.get(count+' 灵根').join(' | '):line;
    }).join('\n');
    return {...rule,name:defaults.name,content};
  }
  if(rule.id==='attribute-baseline'&&rule.content===numericRulesText({includeTechniqueSpeed:false})||
    rule.id==='technique-speed'&&rule.content===techniqueSpeedContract())return defaults;
  if(rule.id!=='equipment-transmission')return rule;
  const rows=tableRows(defaults.content);
  const old=/^(混沌之宝·(?:下品|中品|上品|顶阶|至高)) \| (?:0\.9[6-9]|1\.00) \| (?:2400000 \/ 6000000|2800000 \/ 7000000|3200000 \/ 8000000|3600000 \/ 9000000|4000000 \/ 10000000)$/gmu;
  const content=rule.content.replace(old,(_line,label)=>[label,...rows.get(label)].join(' | '));
  return content===rule.content?rule:{...rule,content};
}

export function linkNumericRuleReferences(template, project = text => text) {
  if (typeof template !== 'string') return template;
  const defaultContract = project(numericRulesText());
  return template.replaceAll(defaultContract, NUMERIC_BASELINE_REFERENCES)
    .replaceAll(project(legacyMortalNumericRulesText()), NUMERIC_BASELINE_REFERENCES)
    .replaceAll(project(techniqueSpeedContract()), '${numeric_rule:technique-speed}')
    .replace(/### 传导率表（6器类 × 4品质）[^]*?(?=\*\*区间内取哪个值|### 神识门槛表)/gu,
      '### 装备传导与神识门槛\n${numeric_rule:equipment-transmission}\n\n')
    .replace(/### 神识门槛表（6器类 × 4品质）[^]*?(?=### 加成属性)/gu,'')
    .replace(/### 境界硬锁（10档 × 13属性；单件加成上限）[^]*?(?=### 算例)/gu,
      '### 装备单件硬锁\n${numeric_rule:equipment-hard-caps}\n\n');
}

export function expandNumericRuleReferences(template, rules, project = text => text) {
  if (typeof template !== 'string') return template;
  const withReferences=linkNumericRuleReferences(template,project);
  const byId = new Map(rules.map(rule => [rule.id,rule]));
  return withReferences.replace(/\$\{numeric_rule:([a-z0-9-]{1,100})\}/g, (token,id) => {
    const rule = byId.get(id);
    return rule ? project(rule.content) : '（数值规则未找到：' + id + '）';
  });
}
