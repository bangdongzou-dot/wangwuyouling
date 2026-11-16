// 玩家明确指定的名单是配置，按字面解析，不推断人物重要程度或原著身份。
export function roleToken(value){return String(value??'').replace(/[\u3000\s]+/g,'').replace(/[“”"'‘’《》〈〉【】\[\]（）()]/g,'').trim();}

// Stable source identity. The game's C-series storage keys are allocated separately.
export function canonActorId(name) {
  const registered=String(name??'').trim().normalize('NFC');
  return registered?'CANON-'+Array.from(registered,char=>char.codePointAt(0).toString(16).toUpperCase()).join('-'):'';
}
export function parseRoleRoster(text){
 const roster=Object.create(null),seen=new Map();
 for(const line of String(text??'').split(/\r?\n/)){
  if(!line.trim())continue;
  const [head,...rest]=line.split('|'),name=head.trim(),aliases=rest.join('|').split(/[,，、;；|]+/).map(s=>s.trim()).filter(Boolean);
  if(!roleToken(name))throw Error('名单中有空姓名');
  if(Object.hasOwn(roster,name))throw Error('姓名重复：'+name);
  roster[name]=[...new Set(aliases.filter(a=>a!==name))];
  for(const token of [name,...roster[name]]){const key=roleToken(token),owner=seen.get(key);if(owner&&owner!==name)throw Error('姓名或别名「'+token+'」同时属于'+owner+'和'+name);seen.set(key,name);}
 }
 return roster;
}
export function formatRoleRoster(roster){return Object.entries(roster||{}).map(([name,aliases])=>name+(Array.isArray(aliases)&&aliases.filter(a=>a!==name).length?' | '+aliases.filter(a=>a!==name).join('、'):'')).join('\n');}
export function normalizeRoleLists(value){
 const input=value&&typeof value==='object'?value:{},ids=new Set(),lists=[];
 for(const row of Array.isArray(input.lists)?input.lists:[]){
  if(!row||!String(row.id||'').trim()||row.id==='default'||ids.has(row.id))throw Error('自定义名单编号重复或无效');
  if(!String(row.name||'').trim())throw Error('请填写名单名称');
  const roster=parseRoleRoster(formatRoleRoster(row.roster));ids.add(row.id);lists.push({id:row.id,name:String(row.name).trim(),roster});
 }
 return {activeId:ids.has(input.activeId)?input.activeId:'default',lists};
}
export function activeRoleRoster(value,defaults={}){const config=normalizeRoleLists(value);return config.activeId==='default'?defaults:config.lists.find(row=>row.id===config.activeId).roster;}
export function resolveRoleName(roster,value){const key=roleToken(value);if(!key)return '';for(const [name,aliases]of Object.entries(roster||{}))if([name,...(Array.isArray(aliases)?aliases:[])].some(alias=>roleToken(alias)===key))return name;return '';}

/* ==================== 三档待遇：核心 / 重要 / 配角 ====================
 *
 * 分档只决定「给多少资源」，不决定「是不是原著人物」。
 *   A 领衔核心：单独写、精核，最高规格
 *   B 重要角色：合写、核关键事实
 *   C 非重要配角：打包短写、紧凑核对
 *
 * 身份与待遇是两件事：
 *   - W 原著身份集合：年表/原设定里有这个人，决定「要不要检索、要不要演」
 *   - A/B/C 决定「用什么规格演」
 * 一个原著人物进了 W 不等于就是 A。上名单只决定待遇。
 */
export const CE_CAST_TIER = Object.freeze({
  /** 领衔核心：单独写、精核 */
  core: 'core',
  /** 重要角色：合写、核关键事实 */
  major: 'major',
  /** 非重要配角：打包短写、紧凑核对 */
  minor: 'minor',
});

/**
 * 凡人默认核心名单（建议四人）。
 *
 * 这是本游戏的资源配置建议，不是官方评级。玩家可自行增删。
 * 保持小名单的目的：防止最高规格再次扩散到所有重要人物。
 * 元瑶、大衍神君、厉飞雨、墨居仁、张铁等继续留在第二档，不等于忽视他们。
 */
export const CE_DEFAULT_CORE_NAMES = Object.freeze(['韩立','南宫婉','紫灵','银月']);

/**
 * 三档默认篇幅预算（字）。是可调整的参考，不是必须凑够的下限。
 *
 * 2026-11-01 玩家要求：「核心角色篇幅也默认到800」。
 *   · 只改 core：1200 → 800
 *   · major = 400、minor = 160 **保持原样不动**
 *
 * 为什么之前「看着是 800 但其实没生效」：
 *   设置面板有回退逻辑 tierBudget()：没有 tierBudgets 配置时用旧字段 coreMaxChars（800）；
 *   而真正算篇幅时用的是这里 CE_CAST_TIER_BUDGET.core（1200）。
 *   两边不一致 → 界面显示 800、实际发 1200。
 *   现在把这里的 core 也定为 800，两处对齐。
 */
export const CE_CAST_TIER_BUDGET = Object.freeze({
  [CE_CAST_TIER.core]: 800,
  [CE_CAST_TIER.major]: 400,
  [CE_CAST_TIER.minor]: 160,
});

/** 各档默认单批人数上限保护。内容不超容量时不该无脑一人一批。 */
export const CE_CAST_TIER_BATCH = Object.freeze({
  [CE_CAST_TIER.core]: 1,
  [CE_CAST_TIER.major]: 4,
  [CE_CAST_TIER.minor]: 6,
});

/** 把名单配置里的核心名单读出来，并解析成规范姓名集合。 */
export function normalizeCoreNames(value,defaults=CE_DEFAULT_CORE_NAMES){
  const list=Array.isArray(value)?value:defaults;
  return [...new Set(list.map(name=>String(name||'').trim()).filter(Boolean))];
}

/**
 * 判定一批人物的档位。
 *
 * 优先级 A > B > C，同一规范身份只处理一次。
 *
 * @param {Array<string>} names 本轮参与者姓名
 * @param {object} [options]
 * @param {object} [options.roster] 原著重要名单（W 的身份来源之一）
 * @param {Array<string>} [options.coreNames] 玩家核心名单
 * @param {Function} [options.resolve] (名字或别名) => 规范姓名
 * @returns {Map<string,string>} 规范姓名 → 档位
 */
export function assignCastTiers(names,options={}){
  const roster=options.roster&&typeof options.roster==='object'?options.roster:{};
  const resolve=typeof options.resolve==='function'?(value=>options.resolve(value)||String(value||'').trim()):(value=>String(value||'').trim());
  const coreNames=new Set(normalizeCoreNames(options.coreNames));
  const out=new Map();
  for(const raw of Array.isArray(names)?names:[]){
    const name=resolve(raw);
    if(!name||out.has(name))continue;
    // A：玩家明确指定的核心名单
    if(coreNames.has(name)||[...coreNames].some(core=>resolve(core)===name)){out.set(name,CE_CAST_TIER.core);continue;}
    // B：原著重要名单里除 A 之外的人
    if(resolveRoleName(roster,name)){out.set(name,CE_CAST_TIER.major);continue;}
    // C：其余原著人物
    out.set(name,CE_CAST_TIER.minor);
  }
  return out;
}

/** 按档位分组，保持稳定顺序。 */
export function groupByCastTier(tiers){
  const groups={[CE_CAST_TIER.core]:[],[CE_CAST_TIER.major]:[],[CE_CAST_TIER.minor]:[]};
  for(const [name,tier] of tiers instanceof Map?tiers:[])(groups[tier]||groups[CE_CAST_TIER.minor]).push(name);
  return groups;
}

/** 取某个档位的篇幅预算。 */
export function castTierBudget(tier,budgets={}){
  const key=Object.prototype.hasOwnProperty.call(CE_CAST_TIER,tier)?tier:CE_CAST_TIER.minor;
  const value=Number(budgets?.[key]);
  return Number.isFinite(value)&&value>0?value:CE_CAST_TIER_BUDGET[key];
}

export function renderRoleRosterEditor(value,defaults,esc){
 const config=normalizeRoleLists(value),roster=activeRoleRoster(config,defaults),custom=config.activeId!=='default',current=config.lists.find(row=>row.id===config.activeId);
 return '<details class="ce-canon-roster" id="ce-canon-important-roles"><summary><span>原著重要角色名单</span><span class="ce-canon-count" data-role-count>'+Object.keys(roster).length+' 人</span></summary><div class="ce-canon-roster-editor">'
  +'<label>当前名单<select id="ce-canon-role-list" class="ce-canon-input"><option value="default">凡人默认名单</option>'+config.lists.map(row=>'<option value="'+esc(row.id)+'"'+(row.id===config.activeId?' selected':'')+'>'+esc(row.name)+'</option>').join('')+'</select></label>'
  +'<div class="ce-canon-roster-actions"><button type="button" data-role-action="new">新建空白名单</button><button type="button" data-role-action="copy">复制当前名单</button><button type="button" data-role-action="delete"'+(custom?'':' disabled')+'>删除这份名单</button></div>'
  +'<label>名单名称<input id="ce-canon-role-name" class="ce-canon-input" value="'+esc(current?.name||'凡人默认名单')+'"'+(custom?'':' readonly')+'></label>'
  +'<label>人物与别名<textarea id="ce-canon-role-text" class="ce-canon-input" rows="10" spellcheck="false"'+(custom?'':' readonly')+'>'+esc(formatRoleRoster(roster))+'</textarea></label>'
  +'<p class="hint">每行一人：姓名 | 别名一、别名二。默认名单可复制编辑；年表人物仍参与补演。保存设置后生效。</p><p data-role-feedback role="status" aria-live="polite"></p></div></details>';
}
export function bindRoleRosterEditor(root,value,defaults={}){
 const box=root?.querySelector?.('#ce-canon-important-roles');if(!box||box._roleListDraft)return;
 const draft=normalizeRoleLists(value),get=id=>box.querySelector('#'+id),feedback=box.querySelector('[data-role-feedback]');
 function capture(){if(draft.activeId==='default')return;const row=draft.lists.find(r=>r.id===draft.activeId);row.roster=parseRoleRoster(get('ce-canon-role-text').value);row.name=get('ce-canon-role-name').value.trim();if(!row.name)throw Error('请填写名单名称');}
 function paint(){const select=get('ce-canon-role-list');select.replaceChildren();for(const row of [{id:'default',name:'凡人默认名单'},...draft.lists]){const opt=select.ownerDocument.createElement('option');opt.value=row.id;opt.textContent=row.name;select.appendChild(opt);}select.value=draft.activeId;
  const custom=draft.activeId!=='default',row=draft.lists.find(r=>r.id===draft.activeId),roster=activeRoleRoster(draft,defaults);
  get('ce-canon-role-name').value=row?.name||'凡人默认名单';get('ce-canon-role-name').readOnly=!custom;
  get('ce-canon-role-text').value=formatRoleRoster(roster);get('ce-canon-role-text').readOnly=!custom;
  box.querySelector('[data-role-count]').textContent=Object.keys(roster).length+' 人';box.querySelector('[data-role-action="delete"]').disabled=!custom;
 }
 box._roleListDraft={read(){capture();return normalizeRoleLists(draft);},reset(){try{capture();}catch(_){}draft.activeId='default';paint();}};
 get('ce-canon-role-list').addEventListener('change',()=>{const chosen=get('ce-canon-role-list').value;try{capture();draft.activeId=chosen;paint();feedback.textContent='名单已切换，保存设置后生效';}catch(e){get('ce-canon-role-list').value=draft.activeId;feedback.textContent=e.message;}});
 box.addEventListener('input',()=>{try{const roster=parseRoleRoster(get('ce-canon-role-text').value);box.querySelector('[data-role-count]').textContent=Object.keys(roster).length+' 人';feedback.textContent='尚未保存';}catch(e){feedback.textContent=e.message;}});
 box.addEventListener('click',event=>{const button=event.target.closest('[data-role-action]');if(!button)return;try{const action=button.dataset.roleAction;if(action!=='delete')capture();
  if(action==='delete'){draft.lists=draft.lists.filter(row=>row.id!==draft.activeId);draft.activeId='default';}
  else {const roster=action==='copy'?parseRoleRoster(formatRoleRoster(activeRoleRoster(draft,defaults))):{},baseId='roles-'+Date.now().toString(36);let serial=draft.lists.length,id=baseId+'-'+serial;while(draft.lists.some(row=>row.id===id))id=baseId+'-'+(++serial);draft.lists.push({id,name:action==='copy'?'当前名单副本':'新名单',roster});draft.activeId=id;}
  paint();feedback.textContent='尚未保存';get('ce-canon-role-name').focus();
 }catch(e){feedback.textContent=e.message;}});
}
export function readRoleRosterEditor(dom,previous){return dom?.querySelector?.('#ce-canon-important-roles')?._roleListDraft?.read() || normalizeRoleLists(previous);}

/* ==================== 核心名单编辑器 ====================
 * 核心名单只有人名，没有别名，所以比重要名单简单：一个多行文本框。
 * 复用同一套 .ce-canon-roster 样式，视觉和重要名单保持一致。
 */
export function renderCoreRosterEditor(value,esc){
  const names=normalizeCoreNames(value);
  return '<details class="ce-canon-roster" id="ce-canon-core-roles"><summary><span>领衔核心名单</span><span class="ce-canon-count" data-core-count>'+names.length+' 人</span></summary><div class="ce-canon-roster-editor">'
    +'<label>核心人物<textarea id="ce-canon-core-text" class="ce-canon-input" rows="6" spellcheck="false" placeholder="每行一位角色">'+esc(names.join('\n'))+'</textarea></label>'
    +'<p class="hint">每行一人，默认四人。核心角色单独写、精核，篇幅按上方「核心角色篇幅」。其余原著人物按重要名单与配角处理；上名单只决定待遇，不代表每轮都要演。保存设置后生效。</p>'
    +'<p data-core-feedback role="status" aria-live="polite"></p></div></details>';
}
export function bindCoreRosterEditor(root,value){
  const box=root?.querySelector?.('#ce-canon-core-roles');if(!box||box._coreDraft)return;
  const area=box.querySelector('#ce-canon-core-text'),feedback=box.querySelector('[data-core-feedback]'),counter=box.querySelector('[data-core-count]');
  let draft=normalizeCoreNames(value);
  area.value=draft.join('\n');
  const parse=()=>[...new Set(String(area.value||'').split(/\r?\n/).map(name=>name.trim()).filter(Boolean))];
  box._coreDraft={read(){draft=parse();return draft;},reset(){draft=[...CE_DEFAULT_CORE_NAMES];area.value=draft.join('\n');counter.textContent=draft.length+' 人';feedback.textContent='已恢复默认';}};
  area.addEventListener('input',()=>{try{draft=parse();counter.textContent=draft.length+' 人';feedback.textContent='尚未保存';}catch(e){feedback.textContent=e.message;}});
}
export function readCoreRosterEditor(dom,previous){return dom?.querySelector?.('#ce-canon-core-roles')?._coreDraft?.read() || normalizeCoreNames(previous);}
