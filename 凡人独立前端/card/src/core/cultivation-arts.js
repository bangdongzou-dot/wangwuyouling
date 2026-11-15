// Shared, read-only projections and explicit writes for the eight cultivation arts.
export const CULTIVATION_ARTS = Object.freeze([
  ['talisman','符箓','绘制符纹、调墨运笔与封存术力'],['formation','阵法','辨识阵纹、布阵破阵与节点调配'],
  ['alchemy','炼丹','辨药配伍、控火炼制与成丹收丹'],['artifact','炼器','材料处理、器型锻炼与禁制铭刻'],
  ['puppet','傀儡','机巧制作、核心炼制与傀儡操控'],['beastTaming','御兽','辨识习性、驯养沟通与协同驾驭'],
  ['cooking','灵膳','调和灵材、掌握火候与食补灵气'],['planting','种植','培育灵药、照料灵田与采收养护']
].map(([key,name,description])=>Object.freeze({key,name,description})));
export const CULTIVATION_ART_TIERS = Object.freeze(['未入门','初窥门径','小有所成','登堂入室','融会贯通','炉火纯青','宗师之境']);
const artKeys=new Set(CULTIVATION_ARTS.map(x=>x.key));
const artRecord=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const artParse=x=>{if(typeof x==='string'){try{return JSON.parse(x);}catch{return null;}}return x;};
const artText=x=>typeof x==='string'&&!!x.trim();
export function readCultivationArts(source) {
  if(!artRecord(source))return {};
  if(Object.hasOwn(source,'cultivationArts'))return artParse(source.cultivationArts)??{};
  if(artRecord(source.columns))return readCultivationArts(source.columns);
  if(artRecord(source.data))return readCultivationArts(source.data);
  const raw=source['9']??source.remarks;
  let notes=artParse(raw);
  if(!artRecord(notes)&&typeof raw==='string'){
    const match=raw.match(/(?:^|\|)cultivationArts\s*:/u);
    if(match){const start=match.index+match[0].length;let depth=0,quoted=false,escape=false;
      for(let i=start;i<raw.length;i++){const c=raw[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='{')depth++;if(c==='}'&&--depth===0){notes={cultivationArts:artParse(raw.slice(start,i+1).trim())};break;}}
    }
  }
  return artRecord(notes)?artParse(notes.cultivationArts)??{}:{};
}
export function validateCultivationArts(value,{requireBasis=true}={}) {
  if(value===undefined)return [];
  if(!artRecord(value))return ['百艺必须是对象'];
  const errors=[];
  for(const [key,entry] of Object.entries(value)){
    if(!artKeys.has(key)){errors.push('未知百艺项目：'+key);continue;}
    if(!artRecord(entry)||!CULTIVATION_ART_TIERS.includes(entry.tier)||typeof entry.progress!=='number'||!Number.isFinite(entry.progress)||entry.progress<0||entry.progress>99){errors.push(key+' 的档位或当前档内进度无效（0–99）');continue;}
    if(requireBasis&&!artText(entry.basis))errors.push(key+' 缺少依据');
    if(entry.eventId!==undefined&&!artText(entry.eventId))errors.push(key+' 的事件标识无效');
    if(entry.previous!==undefined&&entry.previous!==null&&(!artRecord(entry.previous)||!CULTIVATION_ART_TIERS.includes(entry.previous.tier)||typeof entry.previous.progress!=='number'||!Number.isFinite(entry.previous.progress)))errors.push(key+' 的前态无效');
  }
  return errors;
}
export function cultivationArtStateEqual(left,right) {
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  const a=Object.keys(left).sort(),b=Object.keys(right).sort();
  return a.length===b.length&&a.every((key,index)=>key===b[index]&&cultivationArtStateEqual(left[key],right[key]));
}
export function mergeCultivationArts(previous,patch) {
  const old=artParse(previous),next=artParse(patch);
  if(!artRecord(next))throw new Error('百艺更新必须是对象，不能清空已有百艺');
  const result=artRecord(old)?structuredClone(old):{};
  for(const [key,entry] of Object.entries(next)){
    if(cultivationArtStateEqual(result[key],entry))continue;
    const errors=validateCultivationArts({[key]:entry});if(errors.length)throw new Error(errors.join('；'));
    const before=result[key];
    if(artRecord(before)&&entry.eventId&&((before.eventId===entry.eventId)||(Array.isArray(before.appliedEventIds)&&before.appliedEventIds.includes(entry.eventId)))){
      // A retried terminal fact cannot pay the same practice reward again.
      if(before.tier===entry.tier&&before.progress===entry.progress)continue;
      throw new Error('百艺同一事实已结算：'+key);
    }
    if(artRecord(before)&&before.tier===entry.tier&&before.progress===entry.progress&&before.basis===entry.basis)continue;
    if(Object.hasOwn(entry,'previous')){
      const expected=entry.previous;
      if(expected===null?before!==undefined:(!artRecord(before)||before.tier!==expected.tier||before.progress!==expected.progress))throw new Error('百艺前态已变化：'+key);
    }
    const history=Array.isArray(before?.appliedEventIds)?before.appliedEventIds.filter(artText):[];
    if(artText(before?.eventId)&&!history.includes(before.eventId))history.push(before.eventId);
    if(artText(entry.eventId)&&!history.includes(entry.eventId))history.push(entry.eventId);
    result[key]={...(artRecord(before)?before:{}),...structuredClone(entry)};
    delete result[key].previous;
    if(history.length)result[key].appliedEventIds=history;
  }
  return result;
}
export function cultivationArtsSnapshot(source) {
  const map=readCultivationArts(source);
  return {entries:CULTIVATION_ARTS.map(art=>{
    const value=artRecord(map)?map[art.key]:undefined;
    const valid=value!==undefined&&!validateCultivationArts({[art.key]:value},{requireBasis:false}).length;
    return {...art,status:value===undefined?'unknown':valid?'known':'invalid',tier:valid?value.tier:null,progress:valid?value.progress:null,basis:valid&&artText(value.basis)?value.basis:'',legacy:valid&&!artText(value.basis)};
  }),usage:'百艺是永久基础掌握度；缺项待确认，不等于不会。进度为本档0–99%，99不自动升档。结合当前任务、材料工具、功法辅助和真实证据判断；不能当作战斗修为、必定成功或重复叠加已结算收益。'};
}
export function cultivationArtsBonuses(sources) {
  const totals=Object.fromEntries(CULTIVATION_ARTS.map(x=>[x.key,{practice:0,success:0,quality:0,speed:0,sources:[]}])) ,seen=new Set();
  for(const source of sources||[]){
    const identity=source.id||source.name;if(!identity||seen.has(identity))continue;seen.add(identity);
    const perSource={};
    for(const text of source.effects||[]){
      const re=/(全部百艺|符箓|阵法|炼丹|炼器|傀儡|御兽|灵膳|种植)\s*(练习效率|成功率|品质倾向|制作速度)\s*([+-])\s*(\d+(?:\.\d+)?)\s*[%％]/gu;let m;
      while((m=re.exec(String(text)))){const amount=Number(m[4])*(m[3]==='-'?-1:1),field=({'练习效率':'practice','成功率':'success','品质倾向':'quality','制作速度':'speed'})[m[2]];
        // Ambiguous prose and malformed exponent/decimal suffixes are not numeric inputs.
        if(/[\d.%％]/u.test(String(text).slice(re.lastIndex,re.lastIndex+1)))continue;
        for(const art of CULTIVATION_ARTS)if(m[1]==='全部百艺'||m[1]===art.name){perSource[art.key]??={};perSource[art.key][field]=amount;}
      }
    }
    for(const [key,values]of Object.entries(perSource)){for(const [field,amount]of Object.entries(values))totals[key][field]+=amount;totals[key].sources.push({id:source.id||'',name:source.name||identity,...values});}
  }
  for(const value of Object.values(totals)){value.practiceMultiplier=Math.max(0,1+value.practice/100);value.productionMultiplier=Math.max(0,1+value.speed/100);}
  return totals;
}
export const CULTIVATION_ARTS_RULE = [
  '【百艺生成、维护与消费合同 v1】B1与NPC统一在第9列备注 cultivationArts 保存八艺：talisman符箓、formation阵法、alchemy炼丹、artifact炼器、puppet傀儡、beastTaming御兽、cooking灵膳、planting种植。每个已知项是 {tier,progress,basis}，变化可附 eventId、previous:{tier,progress}；eventId用事实所属楼层/年表节点ID加动作标识，同一事实重跑沿用同一ID。缺项待确认，不默认八项未入门，也不清空旧项。',
  'tier只用：未入门、初窥门径、小有所成、登堂入室、融会贯通、炉火纯青、宗师之境。分别表示不能稳定实践、掌握基础但常失败、独立完成低阶作品、稳定完成同阶常用品、能改良既有技艺、同阶复杂任务少失手、能开创新法与传承。progress为当前档内0–99%，99不自动升档；升档须代表作、传承、点拨、顿悟等已完成事实。境界不自动授予百艺。',
  '初始补全按当前时间已成立的职业、成名经历、原文评价及实际作品判断。已明确长期擅长或精通某艺者可直接设登堂入室至炉火纯青等相应高档，宗师须开创传承证据；药童/学徒可初窥门径。不能所有人物从零起步，也不能仅看持有丹炉、买书、拥有某功法就判高手。仅当前有证据的艺赋值，其余省略；旧存档不能因刷新降级重置。',
  '真实练习、阅读并领会、独立使用、失败后复盘才增加对应永久基础进度。仅购买教材/材料、口头计划、旁观或使用成品不增加。普通有效练习建议+1至3，集中练习/有意义复盘+3至8，代表性成果或持续训练+8至15；明确长期修习按实际时长、难度与结果合理评估，可超该建议。初次已掌握是初始化，不把其历史再当本轮新增奖励；同一动作在正文、补演、校对和重跑出现只结算一次。',
  '百艺功法使用原生第8列境界效果，按实际已修习/已装备且已解锁段提供辅助，不改13属性白值，不直接永久拔高百艺。精确可解析格式为“炼丹练习效率+30%、炼丹成功率+5%、炼丹品质倾向+5%、炼丹制作速度+10%”；可换对应艺名，只有确实通用才用全部百艺。同源各境界段取每指标最后已解锁值，不累加历史层。低阶入门常见练习效率10–20%、专精成熟20–50%、独特传承据原文；成功/品质通常3–10%、制作速度5–30%，允许无数值。明确原文优先，不凭品质自动发满额。',
  '练习效率只在有真实练习的本次基础增量上乘(1+辅助/100)，得到的永久学习成果保留，功法撤下不会遗忘；下一次练习不再作用于历史熟练度。成功率按百分点修正，品质是倾向，制作速度是效率倍率，不减少到负耗时。它们是正文判定参数，不是已有自动掷骰或制作器，不能承诺必成、无材料造物或无视配方/境界限制。功法撤下则当前辅助撤下，不减永久进度。',
  '生成普通变量只根据当前玩家正文和实际档案因果；预制/原著历史补全按当期证据，并继承全部既有百艺。买教材、开始学、实际练习、已掌握四种事实分开。具体法术归skills、功法实体归功法槽、独特天赋归traits；不要为每一档熟练度重复造trait/skill或重复授予功法被动。basis写本次依据，维护只提交改变的艺与绝对终态，保留旧值及其他艺。'
].join('\n');
export const CULTIVATION_ARTS_GAME_RULE = CULTIVATION_ARTS_RULE+'\n本地游戏执行使用既有 add("C1", {"9":{"cultivationArts":{"alchemy":{"tier":"初窥门径","progress":12,"basis":"本层实际练习控火", "eventId":"本层ID:控火练习", "previous":{"tier":"初窥门径","progress":10}}}}})，B1同格式。首次初始化previous可为null；无可用事件ID时必须提供准确previous，勿伪造ID。不要输出朋友前端的ca/state短命令或新增未实现命令。';
export function adaptCultivationArtsPreset(preset) {
  if(!preset||typeof preset!=='object')return preset;
  const rules=preset.sharedRules;
  if(!Array.isArray(rules))return preset;
  const known=Boolean(preset.frBuiltinCatalogId)||rules.some(x=>x.id==='fr-compressed-numeric-v1'&&typeof x.content==='string'&&x.content.startsWith('【压缩白值与等效实力规则表 compressed-container-20261111-v1】'));
  if(!known)return preset;
  const oldOutput="【修仙百艺熟练度字段规范】本规则优先于所有符箓/阵法/炼丹/炼器/傀儡/御兽/灵膳/种植旧写法。\n- 符箓、阵法、炼丹、炼器、傀儡、御兽、灵膳、种植的内部字段是 character.<id>.cultivationArts；B1 与 NPC 使用同一结构。但 state 指令输出必须使用下方 `ca.<id>.<key>` 短格式，不要直接写 `characters.<id>.cultivationArts.<key>` 整项路径。\n- 八项固定 key：talisman=符箓，formation=阵法，alchemy=炼丹，artifact=炼器，puppet=傀儡，beastTaming=御兽，cooking=灵膳，planting=种植。\n- 这八项是角色百艺熟练度，不是 traits，也不是 skills；不得为“符箓师/阵法师/炼丹师/炼器师/傀儡师/御兽师/灵膳师/灵植夫熟练度”生成 trait，不得为这些熟练度生成 skill。\n- 灵膳：调和灵材、妖兽血肉、灵米灵蔬、药膳火候与食补灵气的技艺。种植：培育灵草灵药、照料灵田、催发生机、辨识土水火候与采收时机的技艺。\n- 若角色掌握了具体法术/功法/战技，才写 skills；若获得长期体质、血脉或天赋，才写 traits；道号与称号写入独立的 `identity.title`。普通百艺练习、升档或进度变化只能写 cultivationArts。\n- 每项必须包含 tier 与 progress；progress 范围 0-99，99 表示当前档位圆满，不在本字段内自动升档。\n- tier 只能使用：未入门、初窥门径、小有所成、登堂入室、融会贯通、炉火纯青、宗师之境。\n- 档位含义：未入门=只听过名目，不能稳定实践；初窥门径=会基础手法，失败率高；小有所成=能独立完成低阶成品；登堂入室=可稳定产出同境界常用品；融会贯通=能改良配方、阵纹、器型或操控法门；炉火纯青=同阶中少有失手，可处理复杂委托；宗师之境=能开创新法，影响门派或地域传承。\n- 普通学习、练习、失败复盘、低阶材料消耗可小幅增加 progress；稳定完成代表性作品、获得传承、名师点拨、关键顿悟才可提升 tier。\n- 不得因为角色境界提升自动提升百艺熟练度；境界只影响可承载上限和学习效率。\n- 没有正文、用户输入、长期后台行为或角色目标证据时，不要更新百艺熟练度。\n- 百艺变更最终必须使用短格式 `ca.<id>.<key>`；`ca` 表示 cultivationArts，`p` 表示 progress，`t` 表示 tier。\n- 短格式固定写法：\n  - 只加/减进度：`ca.B1.alchemy.p += 8`\n  - 同时设置档位和进度：`ca.B1.artifact = 初窥门径/10`\n  - 灵膳进展：`ca.B1.cooking.p += 5`\n  - 种植初始化：`ca.C1.planting = 初窥门径/12`\n  - 只设置档位：`ca.C1.formation.t = 小有所成`\n  - 只设置进度：`ca.C1.formation.p = 12`\n- 百艺指令只能写入 <state> 或 stateCommands 的逐行赋值文本；禁止写成 JSON state 对象，禁止写 `state(\"path\", value)`，禁止混入 <upstore>，禁止在赋值行末尾追加分号或逗号。\n- 每条百艺指令必须一行一条；字符串档位在短格式里不加引号，数字不加引号。\n- 错误示例：`{\"character.B1.cultivationArts.artifact\":{\"tier\":\"初窥门径\"}}`、`state(\"character.B1.cultivationArts.artifact.progress\", 10)`、`characters.C1.cultivationArts.talisman = 未入门/0`、`ca.B1.artifact.t = \"初窥门径\";`\n\n【修仙百艺熟练度自检】在 player/npc 重点演化 <thinking> 中必须保留此表；没有变化也要逐项写“不变”：\n| 项目 | 当前档位/进度 | 本轮证据 | 变化判断 | state 指令 |\n| 符箓 | ... | ... | +N / 升档 / 不变 | ... |\n| 阵法 | ... | ... | +N / 升档 / 不变 | ... |\n| 炼丹 | ... | ... | +N / 升档 / 不变 | ... |\n| 炼器 | ... | ... | +N / 升档 / 不变 | ... |\n| 傀儡 | ... | ... | +N / 升档 / 不变 | ... |\n| 御兽 | ... | ... | +N / 升档 / 不变 | ... |\n| 灵膳 | ... | ... | +N / 升档 / 不变 | ... |\n| 种植 | ... | ... | +N / 升档 / 不变 | ... |\n";
  const patches=[["- 百艺仍使用 `ca.<id>.<key>`，见百艺规则。","- 百艺改用第9列 cultivationArts 原生 add 终态，见百艺合同。"],["- 短指令 ca.<id>","- 百艺使用原生 add 的第9列 cultivationArts 终态。"],["- 符箓、阵法、炼丹、炼器、傀儡、御兽、灵膳、种植写百艺，不写 skills 或 traits。仅输出本轮实际变化的 ca.<id>.<key> 短指令字符串。key 分别为 talisman/formation/alchemy/artifact/puppet/beastTaming/cooking/planting；tier 为未入门/初窥门径/小有所成/登堂入室/融会贯通/炉火纯青/宗师之境，progress 为 0–99。示例：\"ca.C1.alchemy.p += 5\"，\"ca.B1.cooking = 初窥门径/10\"。境界提升不自动提升百艺。","- 八艺只写第9列 cultivationArts，不写skills/traits；按百艺合同给有依据的档位、0–99档内进度及basis，以原生add维护绝对终态。"]];
  const replaceArts=body=>{if(typeof body!=='string')return body;let next=body===oldOutput||body.startsWith(oldOutput+'\n')?CULTIVATION_ARTS_GAME_RULE+body.slice(oldOutput.length):body;for(const [from,to]of patches)next=next.replace(from,to);return next;};
  for(const key of ['character-cultivation-arts-output','character-compact-state-output'])if(preset.contentTemplates?.[key])preset.contentTemplates[key]=replaceArts(preset.contentTemplates[key]);
  for(const group of Object.values(preset.prompts||{}))for(const rule of group.rules||[])if(['standalone-cultivation-arts-output','mv-1','mv-2'].includes(rule.id))rule.content=replaceArts(rule.content);
  const legacy="* 熟练度变动：无论是否成功，每次炼制/烹制/培育固定增加10点对应熟练度，炼丹对应炼丹，炼器对应炼器，炼制傀儡对应傀儡，烹制灵膳对应灵膳，种植培育对应种植。熟练度满100则自动突破。",replacement="* 百艺熟练度按【百艺生成、维护与消费合同 v1】在第9列 cultivationArts 维护。有据练习只结算一次；每档进度0–99，升档须实际成果，不固定每次+10，也不满100自动突破。";
  if(typeof preset.contentTemplates?.['character-cultivation-formula']==='string')preset.contentTemplates['character-cultivation-formula']=preset.contentTemplates['character-cultivation-formula'].replace(legacy,replacement);
  for(const group of Object.values(preset.prompts||{}))for(const rule of group.rules||[])if(rule.id==='player-cultivation-formula'&&typeof rule.content==='string')rule.content=rule.content.replace(legacy,replacement);
  if(!rules.some(x=>x.id==='fr-cultivation-arts-v1'))rules.push({id:'fr-cultivation-arts-v1',name:'百艺生成维护与功法辅助',enabled:true,content:CULTIVATION_ARTS_GAME_RULE});
  return preset;
}
