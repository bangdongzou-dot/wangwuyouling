import { WORLD_EVENT_LIFECYCLE_RULE_TEXT } from './world-events.js';
import { numericRulesText, legacyMortalNumericRulesText, NUMERIC_IMMORTAL_REALM_ROWS, NUMERIC_ATTRIBUTE_FACTORS, NUMERIC_SCALAR_RANGES } from './numeric-realms.js';
import { techniqueSpeedContract, buildCultivationSpeedRules, CULTIVATION_ROOT_BASES, CULTIVATION_BASE_YEARS,
  CULTIVATION_DAYS_PER_YEAR, TECHNIQUE_SPEED_BY_GRADE, CULTIVATION_ROOT_LABELS, CULTIVATION_ROOT_TRAITS } from './cultivation-speed.js';
import { CONTAINER_LIMITS, CONTAINER_HARD_CAPS } from './container-equipment.js';
import { applyNumericSettings } from './numeric-settings.js';
import { DEFAULT_SKILL_COST_PERCENT, SKILL_REALM_ANCHORS } from './numeric-skill.js';
import { spiritNumericTables } from './cultivation-environment.js';

const baselineRules = () => numericRulesText({includeTechniqueSpeed:false}).split('\n【修炼速度生成与消费合同')[0]
  .split('\n').filter(line=>!line.startsWith('基准区间乘下列系数')&&!line.startsWith('气运、魅力单独用')).join('\n');
const rootRules = () => buildCultivationSpeedRules({includeTechniqueSpeed:false}).split('\n');
const techniqueTable = () => [
  '功法品阶 | 下品 | 中品 | 上品 | 极品',
  ...Object.entries(TECHNIQUE_SPEED_BY_GRADE).map(([key,values])=>[key,...values.map(x=>'+'+x+'%')].join(' | ')),
  techniqueSpeedContract().replace(/：黄阶 [^。]+。/u,'，具体倍率见上表。'),
].join('\n');

export const NUMERIC_BASELINE_REFERENCES = '${numeric_rule:attribute-baseline}\n${numeric_rule:attribute-factors}\n${numeric_rule:scalar-ranges}\n${numeric_rule:root-speed}\n${numeric_rule:cultivation-progress}\n${numeric_rule:technique-speed}';

const characterNaming = `【正文人物命名】以下规则用于本轮正文中新人物的命名，优先于旧命名示例。已知人物沿用已确认且当前叙事可用的姓名或称谓。

## 身份与叙事边界
- 先辨同一人物，再取姓名。当前存档已有正式姓名、稳定俗名/乳名、已确认原著人物的确证姓名或唯一稳定名号均沿用，并复用原ID；原著已知人物（包括禁用名单中的人物）不得为避撞名改名。禁用名单只防无依据的新原创角色冒用知名姓名。
- 只在本轮叙事确实需要介绍已经登场的新人物时使用姓名参考。传闻、未来登场或尚未出生的人沿用已有信息，不借命名提前安排登场。
- 描述性称呼先与全部角色索引、在场及离场档案核对；若指向已有角色则沿用原姓名和ID，不另建同一人。不知道私名且已有能唯一稳定指向该人的公开名号时保留名号，不因“姓+名”要求臆造私名。
- 仅对叙事确需具名、尚无具体姓名、稳定俗名或唯一公开名号的新人物，保留已明示姓氏和身份，组合原创姓名。同一人物返场继续沿用已确认称呼。
- 新生儿以正文已命名、父母明确姓氏与家族习惯优先；无明确取姓习惯时可沿父姓，父不明而母姓明确时沿母姓；两者不明不虚构亲属身份，可用稳定乳名。姓名字风格只作参考，不凭姓名反推性别、立场、身体特征或经历。
- 新候选名须查全部角色索引、在场人物、离场人物及本轮已选名，避免给不同新人物重名；同一已知人物重复出现属于复用，不是改名理由。当前未提供完整索引时只据可见材料核查，不声称已检索未提供的档案。
- 命名不泄露真名：后台确证身份不等于角色或玩家已知，正文称呼与人物内心仍遵守各自认知边界。正文遵循已成立事实和当前叙事视角。

下列命名触发、禁用模式与原创组合要求均服从上面的身份边界，只适用于上述确需命名的新个体；已有姓名、稳定俗名及唯一稳定公开名号不在改名范围。“只给出职务/泛称”不包括已确证唯一身份的稳定公开名号。

## 角色命名触发
- 新建 NPC、婴儿、临时具名修士、家族成员或需要把描述性称呼落库为角色名时，必须使用具体姓名或稳定俗名。
- 禁止把“男青年”“神秘老者”“黑衣剑修”“紫袍长老”“某氏”“黄老”“掩月宗女弟子”等描述性称呼直接当作姓名。
- 若正文或人物档案已经明确给出姓名或二丫、大柱这类具体、稳定的俗名与乳名，则沿用，不因缺少姓氏而改名；若只给出姓氏、泛称、职务、外貌、门派或传闻，则保留已明示事实，重新生成原创姓名。

## 姓氏池
- 复姓（必须支持）：南宫、慕容、上官、欧阳、公孙、独孤、东方、西门、令狐、诸葛、司徒、司马、皇甫、轩辕、尉迟、澹台、百里、闻人、长孙、宇文、赫连、夏侯、淳于、端木、钟离、公仪、公冶、申屠、仲孙、太叔、宗政、濮阳、巫马、公良、乐正、夹谷、宰父、谷梁、拓跋、呼延、东郭、第五、北乡
- 单姓：云、风、叶、林、江、苏、白、柳、沈、陆、顾、秦、萧、楚、宋、韩、冷、凌、墨、燕、颜、谢、裴、魏、卫、商、慕、君、戚、傅、钟、严、黄、赵、钱、孙、李、周、吴、郑、王、冯、陈、褚、蒋、杨、朱、许、何、吕、施、张、孔、曹、金、陶、姜、邹、喻、柏、水、窦、章、尤、葛、奚、范、彭、郎、鲁、韦、昌、马、苗、凤、花、方、俞、任、袁、鲍、史、唐、费、廉、岑、薛、雷、贺、倪、汤、滕、殷、罗、毕、郝、邬、安、常、乐、于、时、皮、卞、齐、康、伍、余、元、卜、孟、平、尹、姚、邵、湛、汪、祁、毛、禹、狄、米、贝、明、臧、伏、成、戴、谈、庞、熊、纪、舒、屈、项、祝、董、梁、杜、阮、蓝、闵、席、季、麻、强、贾、路、娄、危、童、翟、宁、仇、裘、缪、解、应、宗、丁、宣、邓、郁、单、杭、洪、包、诸、左、石、崔、吉、龚、程、邢、荣、翁、荀、羊、於、惠、甄、曲、家、封、芮、羿、储、靳、汲、邴、糜、松、井、段、富、巫、乌、焦、巴、弓、牧、隗、山、谷、车、侯、宓、蓬、全、郗、班、仰、秋、仲、伊、宫、仝、栾、暴、甘、钭、厉、戎、祖、武、符、刘、景、詹、束、龙、幸、司、韶、黎、蓟、薄、印、宿、怀、蒲、邰、从、鄂、索、咸、籍、赖、卓、蔺、屠、蒙、池、乔、阴、胥、能、苍、双、闻、莘、党、翦、谭、贡、劳、逄、姬、申、扶、堵、冉、宰、郦、雍、郤、璩、桑、桂、濮、牛、寿、通、边、扈、冀、浦、尚、农、温、别、庄

## 名字字池
- 天象：星、辰、月、霄、霜、雪、云、雾、岚、虹、霁、晴、曦、昊、旻、曜、晖、晟、景、昭、晏、晞、玄、斗、参、衡、阙、宸、阑
- 自然：风、雷、电、雨、露、霞、烟、尘、影、光、炎、寒、冰、焰、松、竹、梅、兰、荷、莲、芷、蘅、薇、苓、棠、槿、檀、桂、棂、枫、桑、桐、萤、鹿、鹤、鸿、鸾、翎、羽、素
- 山水：川、河、溪、泉、渊、峰、岳、崖、岩、澜、涛、潮、澈、泓、洲、沧、溟、淮、洛、湘、沅、潇、汀、屿、岭、峦、嶂、岫、岑、壑
- 玉石：瑾、瑜、琼、瑶、璃、珀、璧、琅、珏、琰、玦、珩、璟、琛、璇、璎、珞、玑、珑、琬、瑛、琦、璠、瑄、瑟、瑕、琪、琮、璨、玥
- 品德：清、雅、静、宁、逸、悠、澹、远、默、寂、素、淡、虚、玄、真、明、慎、微、止、观、照、怀、若、知、行、守、衍、朴、和、安、定、诚、谦、恕、允、靖
- 阴暗/邪修：殇、冥、幽、魄、厄、劫、煞、邪、诡、狱、渊、噬、戮、诛、烬、烛、魇、枭、魁、獠、刃、锋、绝、裂、崩、劾、屠、厉、灭、阴
- 女性柔雅：婉、嫣、妍、姝、娴、绮、曼、凝、泠、沁、菡、萱、宛、依、纾、韵、歌、舞、盈、柔、怜、惜、念、语、诗、音、黛、绫、霓、含
- 男性沉雄：钧、衡、岳、铮、峥、嵘、骁、朔、渊、玄、尘、野、阔、沉、砚、渺、舟、策、临、照、弈、衍、澈、昭、庭、砺、嶙、越、苍、闻

## 俗名与乳名参考
- 不含姓氏的完整词组：铁枪、狗蛋、二狗、大牛、三柱、二丫、大柱、铁柱、石头、黑子、瘸子、胖丫、富贵、来福、平安、满仓、有田
- 根据人物出身、家族习惯、性别与当前语境选择雅名或俗名。乡村凡人、民间生活与乡土出身人物可参考俗名，修士也可保留原有俗名；不得仅因境界变化改名。
- 排行 + 事物：如二狗、大牛、三柱；特征 + 称谓：如黑子、瘸子、胖丫；愿望寄托：如富贵、来福、平安。词组按整体使用，不与雅名字池逐字混拼。
- 特征型称呼须符合已知人物事实及合理的乡里称呼，不因名字凭空添加身体特征或经历；已知正式姓名时继续沿用，绰号只作合适语境下的称呼。
- 有明确姓氏时沿用姓氏；民间俗名通常可用单姓 + 完整俗名词组。没有明确姓氏时，也可使用二丫、大柱这类具体、稳定的俗名或乳名，不必凭空补姓。

## 组合规则
- 常规雅名结构为“姓 + 双字名”，高阶修士、前辈、杀伐气重者可用“姓 + 单字名”；神秘人物可另有道号，角色名仍优先具体姓名或稳定俗名。
- 男性偏天象、山水、品德、沉雄字；女性偏玉石、自然、柔雅、品德字；正派偏清、逸、玄、瑾、琼、霁、澈；邪派偏殇、冥、幽、煞、诛、戮、厄。
- 创建前必须检查全部角色索引、在场人物、离场人物和本轮候选名，避免完全重复，也避免短期集中出现同一字头或同一姓氏。
- 内置姓名库、俗名词组与本轮姓名示例只用于参考风格，不是白名单、候选清单或必选列表；不需要从中挑一个，也不得机械照抄。
- 正式输出必须根据本轮角色身份、性别、立场、门派、父母姓氏和已有姓名自行组合自然的新姓名。

## 禁用名单
- 未有明确完整姓名证据时，禁止新 NPC 命中：韩立、南宫婉、厉飞雨、墨彩环、紫灵、令狐老祖、元瑶、银月、柳玉、董萱儿、陈巧倩、慕沛灵、宋蒙、曲魂、辛如音、妍丽、文思月、凌玉灵、温青、风希、叶凡、萧炎、林动、唐三、楚枫、云天河、柳如烟、张小凡、王林、方寒、石昊、牧尘、洛璃、云韵、美杜莎

## 本轮随机姓名示例
1. 澹台诡曦；2. 刘霜和；3. 长孙萱棂；4. 蒙幽清；5. 公孙岩；6. 宗政屿鹤；7. 冉澈砺；8. 宣苍怜；9. 濮影潇；10. 许焰慎；11. 邬砚；12. 夹谷岭；13. 尉迟娴瑾；14. 公冶骁月；15. 北乡珩嶂；16. 寿琬琼；17. 拓跋朴虚；18. 韩远阔；19. 刘含野；20. 成雪恕

## 本轮俗名示例
鲁大柱、路胖丫、宋大柱、刘黑子、江瘸子`;

export function numericRuleDefaults() {
  const transmission = Object.entries(CONTAINER_LIMITS).flatMap(([tier, qualities]) =>
    Object.entries(qualities).map(([quality, rule]) => {
      const rate = rule.minRate === rule.maxRate ? rule.minRate.toFixed(2) : `${rule.minRate}–${rule.maxRate}`;
      return `${tier}·${quality} | ${rate} | ${rule.minConsciousness} / ${rule.perfectConsciousness}`;
    }));
  return [
    { id: 'character-naming', name: '人物命名', content: characterNaming },
    { id: 'world-event-lifecycle', name: '世界大事持续与延期', content: WORLD_EVENT_LIFECYCLE_RULE_TEXT },
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
    ...spiritNumericTables(),
    { id: 'sect-income', name: '宗门供给与差事收入', content: [
      '黄枫谷炼气弟子完成普通杂务，每年约得20–30块下品灵石。按实际履职月份折算，全年范围供校准。',
      '持续照管药园等收入较高的低级差事，每月约2–5块下品灵石。首次任职从低端估起，涨报酬须符合职责和表现。',
      '黄枫谷筑基弟子每年可领一块中品灵石，并有额外材料和供给。不同宗门、身份及职务按当地制度估算。',
      '按实际已任职时间或已有资格的供给周期合计过账，入门当天不预发未来俸禄。同一份供给与同一段差事不重复记，已结算的期间不再计入。来源、品类和实发数有原文时优先用原文。',
    ].join('\n') },
    { id: 'skill-mana-cost', name: '技能品阶与法力消耗', content: [
      '技能大阶 | 消耗下限（%） | 消耗上限（%）',
      ...Object.keys(SKILL_REALM_ANCHORS).map(realm=>[realm+'阶',...DEFAULT_SKILL_COST_PERCENT].join(' | ')),
      '基准是技能大阶入门时的标准法力白值下界。按阶内位置在上下限之间线性取值，最后四舍五入为每次法力消耗。',
      '阶内位置 0–24 为下品，25–49 为中品，50–74 为上品，75–100 为顶阶。已有定标沿用；技能本身发生质变时才重新判档。',
      '角色突破、资源亏空和装备变化不抬高同一招式的单次消耗。按面板最终当前法力判定并扣减，包含已生效的常驻加成和 Buff。未发动不扣费，已发动后落空、被挡也扣费。',
      '凡俗武学、固有感官与装备或耗材自身的代价按真实资源处理，不套法力区间。',
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
      if(rule.id==='world-event-lifecycle'&&row.some(value=>!Number.isInteger(value)||value<=0))throw new Error(label+' duration must be positive integer days');
      if(rule.id==='skill-mana-cost'&&(row[0]<=0||row[1]<row[0]||row[1]>100))throw new Error(label+'须满足 0＜消耗下限≤消耗上限≤100');
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
