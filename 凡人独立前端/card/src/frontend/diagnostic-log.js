(function (host) {
  'use strict';
  const key = 'FR_DIAGNOSTIC_LOG_V1';
  const hour = 3600000;
  const limit = 500;
  const stages = new Set(['预制变异边界','预制人物修订','预制人物变量','预制世界大事修订','预制人物正文续接','预制成品落地']);
  const codes = new Set(['json','variables_array','ordinary_delta_array','columns','prose_heading','prose_shape','scope','model_request','validation','not_selected','input_capacity']);
  const issueLabels = {
    json:'无法读取模型回包',variables_array:'变量列表格式有误',ordinary_delta_array:'普通结算变化列表格式有误',
    columns:'人物终态列校验未通过',prose_heading:'视角正文标题格式有误',prose_shape:'视角正文或生平格式有误',
    scope:'超出本阶段写入范围',model_request:'模型请求未完成',validation:'回包校验未通过',
    not_selected:'重跑选择未匹配到待处理任务',input_capacity:'请求材料超过长度上限',
  };
  const systems = [
    [/预制|补演|年表/, '原著补演'], [/重点演化|CE_|变量|物品阶段/, '变量演化'],
    [/世界观/, '世界观指导'], [/向量|知识检索/, '向量检索'], [/数据库|存档|Dexie/, '存档'],
    [/地图/, '地图'], [/图片|生图|图像/, '生图'], [/API|网络|请求/, '模型与网络'],
    [/加载|更新/, '加载与更新'],
  ];
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const safeSubject = value => typeof value === 'string' && /^[\p{L}\p{N}· ._-]{1,36}$/u.test(value) ? value : undefined;
  const normalize = value => ({
    enabled: value?.enabled !== false,
    includeNames: value?.includeNames !== false,
    retention: value?.retention === 24 ? 24 : 168,
  });
  let stored;
  try { stored = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
  let settings = normalize(stored?.settings);
  const prune = (rows, hours = settings.retention) => {
    const threshold = Date.now() - hours * hour;
    return rows.filter(row => number(row?.at) !== undefined && row.at >= threshold).slice(-limit);
  };
  const systemNames = new Set(['游戏运行',...systems.map(([,label]) => label)]);
  const events = new Set(['预制回包校验','预制任务未完成','运行警告','运行错误','脚本异常','后台任务异常','网络恢复','网络断开']);
  const floorKey = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
  const roundRefs = new Map(Object.entries(stored?.roundRefs||{}).filter(([key,id])=>floorKey.test(key)&&number(id)>0));
  const activeRounds = [];
  function project(row) {
    if (!events.has(row?.event) || !systemNames.has(row.system) || !['info','warning','error'].includes(row.level)) return null;
    const {system,level,event} = row;
    const safe = {system,level,event,at:number(row.at)};
    if(number(row.round)>0)safe.round=row.round;
    if (event === '预制回包校验' || event === '预制任务未完成') {
      Object.assign(safe,{
        stage:stages.has(row.stage) ? row.stage : undefined,
        subject:settings.includeNames ? safeSubject(row.subject) : undefined,
        nodes:Array.isArray(row.nodes) ? row.nodes.filter(id => typeof id === 'string' && /^E-\d{1,10}-N\d{1,10}$/u.test(id)).slice(0,30) : [],
        attempt:number(row.attempt),chars:number(row.chars),elapsedMs:number(row.elapsedMs),
        status:row.status === 'failed' ? 'failed' : 'accepted',code:codes.has(row.code) ? row.code : undefined,
      });
    }
    if (event === '脚本异常') Object.assign(safe,{
      code:/^(?:Type|Range|Reference|Syntax|URI|Eval)?Error$/u.test(row.code||'') ? row.code : undefined,
      line:number(row.line),column:number(row.column),
    });
    if (Number.isInteger(row.httpStatus) && row.httpStatus >= 400 && row.httpStatus <= 599) safe.httpStatus=row.httpStatus;
    return safe;
  }
  let entries = prune(Array.isArray(stored?.entries) ? stored.entries.map(project).filter(Boolean) : []);
  let lastRound=Math.max(0,...roundRefs.values(),...entries.map(row=>row.round||0));
  let saveTimer;
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    entries = prune(entries);
    const retained=new Set([...entries.map(row=>row.round),...activeRounds.map(row=>row.round)]);
    for(const [floor,round] of roundRefs)if(!retained.has(round))roundRefs.delete(floor);
    try { localStorage.setItem(key, JSON.stringify({settings,entries,roundRefs:Object.fromEntries(roundRefs)})); } catch (_) {}
  };
  function record(fields) {
    if (!settings.enabled) return;
    const entry=project({round:activeRounds.at(-1)?.round,...fields,at:Date.now()});
    if (!entry) return;
    entries.push(entry);
    if (entries.length > limit) entries.shift();
    if (!saveTimer) saveTimer = setTimeout(persist, 500);
  }
  function beginRound(logId) {
    if(!floorKey.test(logId||''))return ()=>{};
    const round=roundRefs.get(logId)||++lastRound;
    roundRefs.set(logId,round);
    const token={round};
    activeRounds.push(token);
    return ()=>{
      const index=activeRounds.indexOf(token);
      if(index>=0)activeRounds.splice(index,1);
      persist();
    };
  }
  function recordPrebuilt(row, event, level) {
    if (!stages.has(row.stage)) return;
    record({
      system:'原著补演', level, event,
      stage:row.stage, subject:settings.includeNames ? safeSubject(row.subject) : undefined,
      nodes:Array.isArray(row.nodeIds) ? row.nodeIds.filter(id => typeof id === 'string' && /^E-\d+-N\d+/u.test(id)).slice(0,30)
        .map(id => id.match(/^E-\d+-N\d+/u)[0]) : [],
      ...(roundRefs.has(row.logId)?{round:roundRefs.get(row.logId)}:{}),
      attempt:number(row.attempt), chars:number(row.chars), elapsedMs:number(row.elapsedMs),
      status:row.status === 'failed' ? 'failed' : 'accepted', code:codes.has(row.code) ? row.code : undefined,
    });
  }
  function prebuiltAttempt(row) {
    recordPrebuilt(row,'预制回包校验',row.status==='failed'?'warning':'info');
  }
  function prebuiltFailure(row) {
    recordPrebuilt({...row,status:'failed'},'预制任务未完成','error');
  }
  function configure(patch) {
    settings = normalize({...settings,...patch});
    if (!settings.includeNames) entries = entries.map(({subject,...row}) => row);
    persist();
  }
  function report({hours = 24, issuesOnly = false, round} = {}) {
    const selected = prune(entries, Math.min(settings.retention, [1,24,168].includes(hours) ? hours : 24))
      .filter(row => (round===undefined||round===(row.round||0))&&(!issuesOnly || row.level !== 'info')).map(row => ({...row}));
    const appVersion=/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(host.__FR_APP_VERSION__||'') ? host.__FR_APP_VERSION__ : undefined;
    return {kind:'fanren-diagnostics',version:1,appVersion,exportedAt:new Date().toISOString(),
      ...(round===undefined?{hours,issuesOnly}:{round,startedAt:selected[0]?.at,endedAt:selected.at(-1)?.at}),entries:selected};
  }
  function clear() { entries = []; persist(); }
  for (const level of ['warn','error']) {
    const original = console[level];
    console[level] = function (...args) {
      const label = typeof args[0] === 'string' ? args[0].match(/^\[([^\]\r\n]{1,36})\]/u)?.[1] : '';
      const system = systems.find(([pattern]) => label && pattern.test(label))?.[1] || '游戏运行';
      const http = args.slice(0,2).map(value=>typeof value==='string'?value.match(/\bHTTP\s+([45]\d{2})\b/u)?.[1]:undefined).find(Boolean);
      record({system,level:level==='warn'?'warning':'error',event:level==='warn'?'运行警告':'运行错误',httpStatus:http?Number(http):undefined});
      return original.apply(console,args);
    };
  }
  host.addEventListener('error', event => {
    const name = event.error?.name;
    const code = /^(?:Type|Range|Reference|Syntax|URI|Eval)?Error$/u.test(name||'') ? name : undefined;
    record({system:'游戏运行',level:'error',event:'脚本异常',code,line:number(event.lineno),column:number(event.colno)});
  });
  host.addEventListener('unhandledrejection', () => record({system:'游戏运行',level:'error',event:'后台任务异常'}));
  for (const [type, event] of [['online','网络恢复'],['offline','网络断开']]) {
    host.addEventListener(type, () => record({system:'模型与网络',level:type==='offline'?'warning':'info',event}));
  }
  host.addEventListener('pagehide',persist);
  host.FrDiagnosticLog = Object.freeze({prebuiltAttempt,prebuiltFailure,configure,report,clear,beginRound});

  function open(settingsMode) {
    if (document.getElementById('fr-diagnostic-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'fr-diagnostic-dialog';
    dialog.dataset.mode = settingsMode ? 'settings' : 'viewer';
    dialog.setAttribute('aria-labelledby','fr-diagnostic-title');
    dialog.innerHTML = '<header><div><span class="fr-diagnostic-kicker">系统 · 运行记录</span><h2 id="fr-diagnostic-title"></h2></div><button type="button" data-close aria-label="关闭诊断日志">×</button></header>' +
      '<div class="fr-diagnostic-body"><p data-capture></p>' +
      '<fieldset data-options><legend>记录设置</legend><label><input data-enabled type="checkbox"> 本机记录</label>' +
      '<label><input data-names type="checkbox"> 记录 NPC 姓名</label>' +
      '<label>保留时长 <select data-retention><option value="24">24 小时</option><option value="168">7 天</option></select></label>' +
      '<button type="button" data-clear>清空本机记录</button><div data-confirm hidden>' +
      '<p>清空已记录的诊断日志？</p><button type="button" data-confirm-clear>确认清空</button> <button type="button" data-cancel>取消</button></div></fieldset>' +
      '<section class="fr-diagnostic-round" aria-label="回合记录"><label for="fr-diagnostic-round-picker">查看回合</label>' +
      '<select id="fr-diagnostic-round-picker" data-round></select><p data-preview aria-label="回合诊断摘要"></p>' +
      '<details data-issues><summary><span>错误</span><span data-issue-count></span></summary>' +
      '<ol data-issue-list aria-label="本回合错误"></ol><p data-no-issues>本回合没有错误。</p></details></section></div>' +
      '<footer><span data-status role="status"></span><button class="major-action-button" type="button" data-download>导出日志</button></footer>';
    const find = selector => dialog.querySelector(selector);
    find('h2').textContent = settingsMode ? '诊断日志设置' : '诊断日志';
    find('[data-options]').hidden = !settingsMode;
    find('[data-enabled]').checked = settings.enabled;
    find('[data-names]').checked = settings.includeNames;
    find('[data-retention]').value = String(settings.retention);
    const status = find('[data-status]');
    const picker=find('[data-round]');
    const issuesPanel=find('[data-issues]');
    const issueList=find('[data-issue-list]');
    const selection = () => report({hours:168,round:Number(picker.value)});
    const clock = new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    function issueCard(row) {
      const item=document.createElement('li');
      item.dataset.level=row.level;
      const badge=document.createElement('span');
      badge.className='fr-diagnostic-severity';
      badge.textContent='错误';
      const time=document.createElement('time');
      time.dateTime=new Date(row.at).toISOString();
      time.textContent=clock.format(row.at);
      const title=document.createElement('strong');
      title.textContent=[row.stage||row.system,row.subject].filter(Boolean).join(' · ');
      const detail=document.createElement('p');
      detail.textContent=[issueLabels[row.code]||row.event,row.attempt?'第 '+row.attempt+' 次':null,
        row.nodes?.join('、'),row.httpStatus?'HTTP '+row.httpStatus:null,row.line?'第 '+row.line+' 行':null].filter(Boolean).join(' · ');
      item.append(badge,title,time,detail);
      return item;
    }
    function refresh() {
      find('[data-capture]').textContent = settings.enabled ? '本机记录已开启 · 仅包含运行诊断' : '本机记录已暂停';
      const previous=picker.value;
      const rounds=new Map();
      for(const row of prune(entries).reverse())if(!rounds.has(row.round||0))rounds.set(row.round||0,row.at);
      picker.replaceChildren();
      for(const [round,at] of [...rounds].sort(([a,atA],[b,atB])=>Number(!!b)-Number(!!a)||atB-atA||b-a)){
        const option=document.createElement('option');
        option.value=String(round);
        option.textContent=round?'第 '+round+' 轮 · '+new Date(at).toLocaleString('zh-CN',{hour12:false}):'旧版未分轮记录';
        picker.append(option);
      }
      if(previous&&rounds.has(Number(previous)))picker.value=previous;
      picker.disabled=!rounds.size;
      const {entries:rows} = selection();
      const issues=rows.filter(row=>row.level==='error');
      find('[data-preview]').textContent=rows.length?rows.length+' 条记录 · '+issues.length+' 条错误':'';
      issuesPanel.hidden=!rows.length;
      find('[data-issue-count]').textContent=issues.length+' 条错误';
      find('[data-no-issues]').hidden=issues.length>0;
      issueList.hidden=!issues.length;
      issueList.replaceChildren(...issues.reverse().map(issueCard));
      status.textContent = rows.length ? '合并导出为一份文件' : '暂无诊断记录';
      find('[data-download]').disabled = !rows.length;
    }
    find('[data-enabled]').onchange = event => { configure({enabled:event.target.checked}); refresh(); };
    find('[data-names]').onchange = event => { configure({includeNames:event.target.checked}); refresh(); };
    find('[data-retention]').onchange = event => { configure({retention:Number(event.target.value)}); refresh(); };
    picker.onchange = () => { issuesPanel.open=false; refresh(); };
    find('[data-close]').onclick = () => dialog.close();
    find('[data-clear]').onclick = () => { find('[data-confirm]').hidden=false; find('[data-confirm-clear]').focus(); };
    find('[data-cancel]').onclick = () => { find('[data-confirm]').hidden=true; find('[data-clear]').focus(); };
    find('[data-confirm-clear]').onclick = () => { clear(); find('[data-cancel]').click(); refresh(); };
    find('[data-download]').onclick = () => {
      const data=selection();
      if (!data.entries.length) { refresh(); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href=url;
      link.download='凡人修仙传-诊断日志-'+(data.round?'第'+data.round+'轮-':'')+data.exportedAt.slice(0,19).replace(/[:T]/gu,'-')+'.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
      status.textContent = '已发起下载 · '+data.entries.length+' 条';
    };
    dialog.addEventListener('close',() => dialog.remove(),{once:true});
    document.body.append(dialog);
    refresh();
    dialog.showModal();
  }
  document.addEventListener('click', event => {
    if (event.target.closest?.('#fr-diagnostic-log-button')) open(false);
    if (event.target.closest?.('#fr-diagnostic-settings-button')) open(true);
  });
})(globalThis);
