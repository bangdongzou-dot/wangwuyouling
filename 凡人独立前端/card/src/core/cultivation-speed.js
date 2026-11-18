import { numericSetting } from './numeric-settings.js';
// 修炼速度是效率百分数，不参与战力容器缩放。本模块只计算，不推进时间/改存档/扣物品。
export const CULTIVATION_SPEED_VERSION = 'root-speed-v1';
export const CULTIVATION_ROOT_BASES = Object.freeze({ 1:200, 2:150, 3:100, 4:50, 5:25 });
export const CULTIVATION_ROOT_LABELS = Object.freeze({
  1:'单灵根（天灵根）',2:'双灵根（真灵根）',3:'三灵根（真灵根）',
  4:'四灵根（伪灵根）',5:'五灵根（伪灵根）',
});
export const CULTIVATION_ROOT_TRAITS = Object.freeze([
  '五行灵根的基础属性为金、木、水、火、土。单灵根只具其中一属，资质清纯，原著设定其结丹前无瓶颈。双灵根与三灵根称真灵根，修行较快。四灵根与五灵根称伪灵根，修炼艰难，通常难以筑基，但机缘、资源和功法仍会改变实际进展。',
  '异灵根又称变异灵根。原著举例为雷、冰、暗、风，由两三种五行属性异变而成，修炼速度可与天灵根相比。配合相应功法能发挥特长，仍有结丹瓶颈。',
  '游戏白值：单属性异灵根沿用单灵根，兼有普通属性的双属性异灵根（例如土、雷）沿用双灵根。明确无灵根的普通引气白值为 0。仅写真灵根而未注明数量时按三灵根，仅写伪灵根时按四灵根。未知资质暂按 100。',
  '万物有灵 · 混沌灵根：金木水火土五行本源兼具风雷冰暗四极异变，九属纯度皆为十成，体内自成小大千世界。可修各属性灵气，化神期前无突破瓶颈，仍需实际积累修为。',
  '混沌灵根具备全属性法术威力加成、低消耗及对五行与变异法术的极高先天抗性。白值为天灵根的十倍，默认 2000。混沌仙胎独立选择，按天灵根基准另加十倍，默认同时拥有时为 4000。',
]);
export const CULTIVATION_BASE_YEARS = Object.freeze({ 炼气:3, 筑基:45, 结丹:120, 元婴:300, 化神:500 });
export const CULTIVATION_DAYS_PER_YEAR = 360;
export const TECHNIQUE_QUALITIES = Object.freeze(['下品','中品','上品','极品']);
export const TECHNIQUE_SPEED_BY_GRADE = Object.freeze({
  黄阶:Object.freeze([10,20,30,45]),
  玄阶:Object.freeze([60,80,120,160]),
  地阶:Object.freeze([200,250,360,500]),
  天阶:Object.freeze([650,800,1100,1500]),
  仙阶:Object.freeze([2000,2800,4000,5600]),
  道阶:Object.freeze([7500,10000,14000,20000]),
});
export const TECHNIQUE_SPEED_BASELINES = Object.freeze(Object.fromEntries(Object.entries(TECHNIQUE_SPEED_BY_GRADE).map(([tier,rates])=>[tier,rates[1]])));
const rootSpeed=count=>numericSetting('root-speed',CULTIVATION_ROOT_LABELS[count])?.[0]??CULTIVATION_ROOT_BASES[count];
export function techniqueSpeedBaseline(item) {
  const grade = String(item?.['6'] || item?.grade || '').replace(/<[^>]*>/g,'').trim();
  const pair = grade.match(/^([黄玄地天仙道]阶)\s*(?:[·・／/]\s*|[（(]\s*)?(下品|中品|上品|极品)[）)]?$/u);
  const named = grade.match(/^[黄玄地天仙道]阶$/u)?.[0];
  const rank = Number(grade.match(/^(\d+)\s*品?$/u)?.[1]);
  const tier = pair?.[1] || named || (rank >= 17 ? '天阶' : rank >= 11 ? '地阶' : rank >= 5 ? '玄阶' : rank >= 1 ? '黄阶' : '');
  const quality = pair?.[2] || '';
  const slot = quality ? TECHNIQUE_QUALITIES.indexOf(quality) : 1;
  return {tier,quality,flat:0,percent:(numericSetting('technique-speed',tier)??TECHNIQUE_SPEED_BY_GRADE[tier])?.[slot] ?? 10};
}

export function techniqueImmortalRealmRank(raw) {
  const realm=String(raw || '').split('|')[0].replace(/\s+/g,'').replace(/[（(]\d+(?:\.\d+)?%[）)]$/u,'');
  const m=realm.match(/^(真仙|金仙|太乙(?:玉仙)?|大罗(?:金仙)?|道祖)(?:期|境)?(下位|中位|上位|初期|中期|后期|大圆满|圆满|巅峰)?$/u);
  if(!m)return null;
  const family=m[1].slice(0,2);
  const position={下位:1,中位:2,上位:3,初期:1,中期:2,后期:3,大圆满:4,圆满:4,巅峰:4};
  return {真仙:1000,金仙:1100,太乙:1200,大罗:1300,道祖:1400}[family]+(position[m[2]] || 0);
}

// A semicolon can separate stages or separate modifiers within the same stage.
export function splitTechniqueEffectStages(text) {
  if (typeof text !== 'string') return [];
  const entries=[];
  for (const piece of text.replace(/\\n|\r\n?/g,'\n').split(/[\n;；]/u)) {
    const line=piece.trim();
    if(!line)continue;
    const match=line.match(/^([^:：]{1,30})[：:]\s*(.+)$/u);
    if(match && !/^(?:属性加成|修炼速度|修炼效率|修速|效果)$/u.test(match[1].trim())){
      entries.push({realm:match[1].trim(),effect:match[2].trim()});
    }else if(entries.length){
      entries.at(-1).effect+='，'+line;
    }
  }
  return entries;
}

export function explicitTechniqueSpeed(effect) {
  const clean=String(effect || '').replace(/＋/g,'+').replace(/[－−]/g,'-').replace(/％/g,'%');
  const matches=[...clean.matchAll(/(?:修炼速度|修炼效率|修速)\s*[：:]?\s*([+-])\s*((?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)(?:\s*([万亿]))?\s*(%)?(?![\d.%万亿]|[,，]\d|[eE][+-]?\d)/gu)];
  if(!matches.length)return null;
  return matches.reduce((out,m)=>{const value=Number(m[2].replace(/[,，]/g,''))*(m[3]==='亿'?1e8:m[3]==='万'?1e4:1);if(Number.isFinite(value))out[m[4]?'percent':'flat']+=(m[1]==='-'?-1:1)*value;return out;},{flat:0,percent:0});
}

export function resolveTechniqueSpeed(item, activeEntries) {
  for(let i=activeEntries.length-1;i>=0;i--){
    const explicit=explicitTechniqueSpeed(activeEntries[i].effect);
    if(explicit)return {...explicit,source:'record'};
  }
  return {...techniqueSpeedBaseline(item),source:'tier'};
}

function previousTechniqueSpeedContract() {
  return '所有功法必有修炼速度加成。实际修习并装备且满足解锁条件后，以第6列品阶取修速基准：黄阶+20%、玄阶+80%、地阶+250%、天阶+800%；未定品阶旧功法暂用入门+10%。第8列已有明确修炼速度加成时保留，取最后已解锁的明示值，同一功法不叠加品阶基准和明示值。其他加成只按功法特性填第8列，不把功法收益写进基础白值。';
}
export function techniqueSpeedContract() {
  const table=Object.entries(TECHNIQUE_SPEED_BY_GRADE).map(([tier,values])=>tier+' '+values.map(x=>'+'+x+'%').join('/')).join('；');
  return '所有功法必有修炼速度加成。第6列新功法用「阶·品」，例如「仙阶·上品」。六阶为黄、玄、地、天、仙、道，每阶分下品、中品、上品、极品；最高为道阶·极品。实际装备并解锁后，按下品/中品/上品/极品的次序取修速基准：'+table+'。只记录了阶则按该阶中品基准，未定品阶用入门+10%。第8列明示修速取最后已解锁的值，不与基准叠加；其余属性按功法特性填写。功法品阶不代替第7列修炼上限或第8列解锁条件，也不把加成写进人物白值。';
}
const finiteNonnegative = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) >= 0;
const round = value => Number(value.toFixed(8));

export function readCultivationRoot(character) {
  if (typeof character === 'string') return character.trim();
  if (!character || typeof character !== 'object') return '';
  // 玩家沿用第9列；NPC第5列。人物视图显式linggen优先，避免读取别人的全局状态。
  const explicit = character.linggen ?? character.spiritRoot;
  if (typeof explicit === 'string' && explicit.trim() && explicit !== '无') return explicit.trim();
  let notes = character['9'] ?? character.remarks;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch (_) {
      const match = notes.match(/(?:^|[|｜])\s*灵根\s*[:：]\s*([^|｜]*)/u);
      notes = match ? { 灵根:match[1] } : {};
    }
  }
  const stored = character['0'] === 'B1' ? notes?.灵根 ?? character['5'] : character['5'] ?? notes?.灵根;
  return typeof stored === 'string' ? stored.trim() : typeof explicit === 'string' ? explicit.trim() : '';
}

export function resolveCultivationRootBase(character) {
  const root = readCultivationRoot(character).replace(/\s+/gu,'');
  const result = (value, reason, known=true) => ({value,root,reason,known});
  if (!root || /^(?:无|未知|待定|不详|未觉醒|未检测)$/u.test(root)) return result(100,'unknown_root',false);
  if (/^(?:无灵根|没有灵根)(?:[（(].*[）)])?$/u.test(root)) return result(0,'no_spiritual_root');
  // 混沌是用户明确指定的玩家金手指：天灵根200的十倍。疑似/未获不能激活。
  if (/混沌灵根/u.test(root) && !/(?:疑似|未知|待确认|未获|未觉醒|封印|受损|或)/u.test(root)) return result(rootSpeed(1) * 10,'chaos_root');
  // 其他自定义超常资质不能仅凭其中的“五”或“天”猜成普通灵根。
  if (/(?:混沌|混元|变异五行|仙灵根|圣灵根|道灵根|未明|待确认|疑似|或|转化|封印|受损)/u.test(root)) return result(100,'special_or_uncertain_root',false);
  const counts = {一:1,单:1,二:2,双:2,两:2,三:3,四:4,五:5};
  const countMatch = root.match(/([一单二双两三四五1-5])(?:属性)?灵根/u);
  const explicitCount = countMatch ? (counts[countMatch[1]] || Number(countMatch[1])) : null;
  const present = root.replace(/(?:缺少|缺乏|不含|缺)(?:[金木水火土冰风雷光暗](?:[、，,／/])?)+/gu, '');
  const elements = new Set(present.match(/[金木水火土冰风雷光暗]/gu) || []);
  const recognized = /(?:天灵根|异灵根|变异灵根|真灵根|伪灵根|五行灵根|[金木水火土冰风雷光暗]灵根)/u.test(root) || !!explicitCount;
  if (!recognized) return result(100,'unknown_root',false);
  if (/五行灵根/u.test(root)) return result(rootSpeed(5),'five_roots');
  if (explicitCount && elements.size && elements.size !== explicitCount) return result(100,'conflicting_root',false);
  const count = explicitCount || (elements.size > 0 && elements.size <= 5 ? elements.size : null);
  if (/天灵根/u.test(root) && count && count !== 1) return result(100,'conflicting_root',false);
  if (count) return result(rootSpeed(count),'root_count_' + count);
  if (/天灵根|异灵根|变异灵根/u.test(root)) return result(rootSpeed(1),'single_special_root');
  if (/伪灵根/u.test(root)) return result(rootSpeed(4),'unspecified_pseudo_root');
  return result(rootSpeed(3),'unspecified_true_root');
}

export function resolveCultivationSpeedCell(raw, character) {
  const base = resolveCultivationRootBase(character);
  if (raw && typeof raw === 'object') {
    const current = finiteNonnegative(raw.current) ? Number(raw.current) : null;
    const max = finiteNonnegative(raw.max) ? Number(raw.max) : null;
    if (current !== null || max !== null) return {current:current ?? max,max:max ?? current,source:'stored'};
  } else if (finiteNonnegative(raw)) return {current:Number(raw),max:Number(raw),source:'stored'};
  return {current:base.value,max:base.value,source:base.known?'root':'unknown_root'};
}

export function calculateCultivationProgress(input = {}) {
  const realm = String(input.realm || '').trim().replace(/^练气/u,'炼气').replace(/^金丹/u,'结丹');
  const stage = Object.keys(CULTIVATION_BASE_YEARS).find(key => realm.startsWith(key));
  if (!stage) return {ok:false,reason:'unsupported_realm'};
  const speed = input.finalSpeed && typeof input.finalSpeed === 'object' ? input.finalSpeed.current : input.finalSpeed;
  if (!finiteNonnegative(speed)) return {ok:false,reason:'invalid_final_speed'};
  if (!finiteNonnegative(input.cultivationDays) || !finiteNonnegative(input.availableDays) || Number(input.cultivationDays) > Number(input.availableDays)) return {ok:false,reason:'invalid_practice_time'};
  const external = input.externalMultiplier ?? 1;
  const progress = input.startingProgress ?? 0;
  if (!finiteNonnegative(external) || !finiteNonnegative(progress) || Number(progress) > 100) return {ok:false,reason:'invalid_context'};
  const multiplier = Number(speed) / 100;
  const baselineDays = (numericSetting('cultivation-progress',stage)?.[0]??CULTIVATION_BASE_YEARS[stage]) *
    (numericSetting('cultivation-progress','每年天数')?.[0]??CULTIVATION_DAYS_PER_YEAR);
  const dailyProgress = 100 / baselineDays * multiplier * Number(external);
  const rawGain = dailyProgress * Number(input.cultivationDays);
  if (![multiplier,dailyProgress,rawGain].every(Number.isFinite)) return {ok:false,reason:'numeric_overflow'};
  // 仅同层参考；突破必须另有已完成事实，保留现存99%以上进度，不反向裁低。
  const finalProgress = Math.max(Number(progress),Math.min(99,Number(progress) + rawGain));
  return {ok:true,stage,multiplier,baselineDays,dailyProgress:round(dailyProgress),rawGain:round(rawGain),appliedGain:round(finalProgress-Number(progress)),progress:round(finalProgress),bottleneck:rawGain>finalProgress-Number(progress)};
}

export function buildCultivationSpeedSnapshot(character, finalAttributes) {
  const cell = finalAttributes?.修炼速度;
  const raw = cell && typeof cell === 'object' ? cell.current : cell;
  const root = resolveCultivationRootBase(character);
  if (!finiteNonnegative(raw)) return {version:CULTIVATION_SPEED_VERSION,available:false,reason:'final_speed_unavailable'};
  const realm = character?.realm ?? character?.['2'] ?? '';
  const calc = calculateCultivationProgress({realm,finalSpeed:raw,cultivationDays:1,availableDays:1});
  return {version:CULTIVATION_SPEED_VERSION,available:true,root:readCultivationRoot(character),rootInitialReference:root.value,
    finalSpeed:Number(raw),multiplier:Number(raw)/100,baselineDays:calc.ok?calc.baselineDays:null,dailyProgress:calc.ok?calc.dailyProgress:null,
    rule:'只读修炼参考，非本轮已获进度。新增普通修为=实际已完成修炼天数×每日进度点×未入面板的外部效率；不得用经过天数替代修炼天数，不再乘灵根/功法/词条/装备/Buff，不乘丹药直接修为，不改时间，不自动突破。'};
}

export function buildCultivationSpeedRules({ includeTechniqueSpeed = true } = {}) {
  return [
    '【修炼速度生成与消费合同 root-speed-v1】',
    '修炼速度是普通引气修炼效率百分数，100=1倍、200=2倍、0=停止普通吐纳；不是境界战力，也不随容器战力压缩。',
    '新建玩家/NPC及真正缺失的白值，按已确认灵根初始化第11列修炼速度current=max：普通五灵根25、四灵根50、三灵根100、双灵根150、单灵根/天灵根200；单属性异灵根200、双属性混合异灵根150。混沌灵根明确优先识别为2000，等于天灵根200的十倍；这是玩家金手指，仅实际已获得/已激活时适用，不凭空授予，也不在最终倍率外再乘十。明确无灵根为0，仅限制普通引气，不禁止凡俗锻炼或有依据的其他修行。真灵根未明数量100、伪灵根未明数量50；未知/特殊自定义无确定标准暂100并保留未明依据，不凭名字强造额外倍率。',
    '已有合法修炼速度白值（包括旧档100、0或明确自定义值）保留，不批量重算，不将最终总值写回白值。灵根重塑等确证永久改变才按实际事实更新；临时或条件变化用原生状态，常驻特质用bonus，功法用境界效果，不能重复进白值。',
    ...(includeTechniqueSpeed ? [includeTechniqueSpeed==='previous'?previousTechniqueSpeedContract():techniqueSpeedContract()] : []),
    '混沌仙胎的修速来源显式写 bonus.修炼速度={percent:1000,percentBase:"天灵根基准"}，基底固定取天灵根200，故只加2000。与混沌灵根同选时2000+2000=4000（天灵根20倍），不是把2000再乘11；与普通天灵根同选为200+2000=2200。普通功法/装备/其他来源仍按各自原白值基准额外加算，不让仙胎固定基底收益进入它们的百分比基数。已存白值不据此批量重写。',
    '已确认选择混沌仙胎或激活混沌灵根者，化神前无突破瓶颈，不得强造瓶颈或要求额外突破丹药/材料。仍需真实修炼积累与已发生的跨境事实，不自动跳时间、不因刚选天赋便凭空升境；一般瓶颈规则对此明确特例让位。',
    '正文与变量优先读取11_修炼效率_只读或最终面板修炼速度X，效率只乘X/100一次。只在确认实际进行普通修炼时消费；以实际已完成修炼时间为输入，不以聊天轮数、时间跨度、年表事件比例保底增长。未知时间不编造。',
    '每日进度点=100/(基准年数×360)×X/100。基准：炼气3年/层，筑基45年/小境界，结丹120年/小境界，元婴300年/小境界，化神500年/小境界。高阶未定义不得外推。该值是参考速率，不是本轮奖励。',
    '普通新增进度=实际修炼天数×每日进度点×未计入最终面板的外部效率。灵根、功法、词条、装备、已生效Buff已在最终X内，不再拆开相乘；聚灵阵/灵脉/辅材只有未入面板部分另计。丹药直接修为按丹药规则单算，不乘修炼速度；同一来源、同一时间段只能结算一次。',
    '沿用本地原生add与既有境界/进度字段，NPC第2列层内进度与第9列修为进度保持一致，保留身份。已有明确结算/预制终态只落地一次，不按速率再补一份；原著已确认里程碑、当期上限与玩家实际因果优先，不能用公式反造历史。临界99%后不凭速率自动跨越未完成突破，真实突破按事实另处理。',
    '游戏没有settleNpcCultivation命令，不输出它或cr路径。模型判断修炼事实并按上述本地数值参考给出原生命令；本地不会因显示速率自动改存档、扣药或跳时间。'
  ].join('\n');
}
