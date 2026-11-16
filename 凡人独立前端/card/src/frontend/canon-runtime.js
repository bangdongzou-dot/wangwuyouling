// 整个前端辅助AI请求共用预算，不另造API发送器。
var frAiRequestBudget = null;
// 只留当前页面最近一次失败正文的已拼装材料，不重做指导或检索。
var frFailedMainPrompt=null,frMainPromptEditRevision=0,frMainPromptWatching=false;
function frMainPromptWatch(){
  if(frMainPromptWatching||typeof document==='undefined')return;
  document.addEventListener('change',function(){frMainPromptEditRevision++;});
  frMainPromptWatching=true;
}
function frClearFailedMainRequestDisplay(){
  if(typeof mainContentArea==='undefined'||!mainContentArea?.querySelectorAll)return;
  mainContentArea.querySelectorAll('.log-entry').forEach(function(row){
    var text=String(row.textContent||'').trim();
    if(row.classList.contains('fr-main-request-error')||row.classList.contains('error')&&/^\[(?:天机紊乱\] API调用失败|流程未完成\] 正文模型请求)/.test(text)||row.classList.contains('system')&&/^(?:已保留本轮正文提示词。|正文未生成，可复用已准备提示词重试。)/.test(text))row.remove();
  });
}
async function frRetryFailedMainPrompt(userLogId){
  if(typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating)return false;
  var cached=frFailedMainPrompt;if(!cached||cached.archiveName!==currentArchiveName)return false;
  if(userLogId&&userLogId!==cached.userLogId)return false;
  var archive=await db.archives.get(currentArchiveName),logs=archive?.data?.logs||[],index=logs.findIndex(row=>row.id===cached.userLogId);
  if(index<0||logs.slice(index+1).some(row=>row.type==='user'||row.type==='ai'))return false;
  var editedLog=cached.userLogContent!==undefined&&logs[index].content!==cached.userLogContent;
  var input=String(messageInput.value||'').trim()||(editedLog?String(logs[index].content||'').replace(/^> /,''):cached.input);
  var changed=editedLog||input!==cached.input||frMainPromptEditRevision!==cached.editRevision||JSON.stringify(currentState)!==cached.stateText||(cached.actionsText!==undefined&&JSON.stringify(typeof actionQueue==='undefined'?[]:actionQueue)!==cached.actionsText);
  var reuse=!changed||await showCustomDialog({title:'正文提示词已准备好',message:'检测到输入、状态或设置有修改。复用时保留原提示词及原行动；模型接口仍按当前配置请求。',buttons:[{text:'复用原提示词',value:()=>true},{text:'按修改从头生成',value:()=>false}]});
  if(reuse){frClearFailedMainRequestDisplay();await sendMessage(cached.input,{preparedMain:cached});return true;}
  var previous=logs.slice(0,index).reverse().find(row=>row.stateSnapshot);
  if(!previous)throw new Error('找不到原回合快照，无法从头生成');
  frClearFailedMainRequestDisplay();
  frFailedMainPrompt=null;
  if(!await loadStateFromLog(previous.id,true))throw new Error('回退原回合失败');
  await sendMessage(input);return true;
}
var frAiRequestWaits = new WeakMap();
function frErrorText(error){
  if(typeof error==='string'&&error.trim())return error;
  if(typeof error?.message==='string'&&error.message.trim())return error.message;
  if(error?.error)return frErrorText(error.error);
  try{var text=JSON.stringify(error);if(text&&text!=='{}'&&text!=='null')return text;}catch(_){}
  return '未提供具体错误信息，请查看对应阶段记录';
}
function frMainRequestFailureText(error){
  var detail=frErrorText(error);
  var id=error?.request_id||error?.requestId||error?.generation_id;
  if(!id)id=detail.match(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i)?.[0];
  if(id)return String(id);
  return detail.split(/\r?\n/)[0].replace(/^(?:父窗口AI生成失败[：:]\s*|Generate method error:\s*)+/i,'').slice(0,120);
}
async function frPreserveGeneratedStory(record,error){
  if(!record?.id||!String(record.content||'').trim()||!currentArchiveName)return false;
  var archive=await db.archives.get(currentArchiveName);
  if(!archive)throw new Error('当前存档不存在，正文仍保留在页面');
  if(!(archive.data?.logs||[]).some(function(log){return log.id===record.id;})){
    var reason=(record.stage||'正文后续处理')+'：'+frErrorText(error);
    await saveToLog(currentArchiveName,{...record,stateSnapshot:JSON.stringify(currentState),canonPending:{status:'error',reason:reason},postProcessingError:reason});
  }
  return true;
}
function frAiQueueWaitMs(signal) {
  var row=signal && frAiRequestWaits.get(signal);
  return row ? row.total+(row.waiting?Date.now()-row.started:0) : 0;
}
function frAiQueueTimeout(controller,timeoutMs,onTimeout) {
  var base=frAiQueueWaitMs(controller.signal),start=Date.now(),id=null,closed=false;
  function tick(){if(closed)return;var row=frAiRequestWaits.get(controller.signal),remaining=Number(timeoutMs)+frAiQueueWaitMs(controller.signal)-base-(Date.now()-start);if(row&& row.waiting || remaining>0){id=setTimeout(tick,Math.max(50,row&& row.waiting?1000:remaining));return;}onTimeout();}
  id=setTimeout(tick,Math.max(1,Number(timeoutMs)||120000));return {cancel:function(){closed=true;clearTimeout(id);}};
}
// 地址、密钥、模型是一个接口位，不逐字段拼接两套服务。
function frResolveRetrievalRerankRoute(canon,globalConfig={}) {
  var own=canon&&typeof canon==='object'?canon:null;
  if(own?own.retrievalEnableRerank===false:!globalConfig.enableRerank)return {enabled:false};
  if(typeof frApiRoutes==='function'){
    var dedicated=own&&frApiRoutes('CULTIVATION_CANON_BRIDGE_CONFIG_V1','retrievalRerankApiPresetId');
    var shared=frApiRoutes('CULTIVATION_KNOWLEDGE_SEARCH_API_CONFIG_V2','rerankApiPresetId');
    var primary=dedicated?.[0]||shared?.[0];
    if(primary)return {enabled:true,source:dedicated?.[0]?'canon':'global',config:{
      rerankUrl:primary.apiUrl,rerankModel:primary.apiModel,apiKey:primary.apiKey,
      ...(dedicated?.[0]?{apiChainSource:'canon'}:{})
    }};
    if(dedicated||shared)return {enabled:false};
  }
  var hasOwn=own&&['retrievalRerankUrl','retrievalRerankKey','retrievalRerankModel','retrievalRerankApiPresetId'].some(function(key){return String(own[key]||'').trim();});
  var config=hasOwn?{rerankUrl:String(own.retrievalRerankUrl||'').trim(),apiKey:String(own.retrievalRerankKey||'').trim(),rerankModel:String(own.retrievalRerankModel||'').trim()}
    :{rerankUrl:String(globalConfig.rerankUrl||'').trim(),apiKey:String(globalConfig.rerankKey||'').trim(),rerankModel:String(globalConfig.rerankModel||'').trim()};
  if(!config.rerankUrl&&!config.rerankModel&&!hasOwn)return {enabled:false};
  if(!config.rerankUrl||!config.rerankModel)return {enabled:false,reason:(hasOwn?'补演专属':'全局')+'重排配置缺少'+(!config.rerankUrl?'地址':'模型')+'，本次保留向量匹配资料'};
  return {enabled:true,source:hasOwn?'canon':'global',config:hasOwn?{...config,apiChainSource:'canon'}:config};
}

function frAiRateLimitRoute(endpoint, apiKey) {
  try {
    var url=new URL(endpoint);
    if(url.protocol==='https:'||url.protocol==='http:')return JSON.stringify([url.origin,String(apiKey??'')]);
  }catch(_){}
}

function frAiPrioritizeRoutes(routes) {
  if(!frAiRequestBudget?.cooldownRemaining||routes.length<2)return routes;
  var available=[],cooling=[];
  for(var route of routes){
    var wait=frAiRequestBudget.cooldownRemaining(frAiRateLimitRoute(route.apiUrl,route.apiKey));
    if(wait)cooling.push({route,wait});
    else available.push(route);
  }
  // Use the configured order while routes can send. If all fail, the final
  // wait belongs to the route that becomes available soonest.
  return [...available,...cooling.sort((a,b)=>b.wait-a.wait).map(row=>row.route)];
}

async function frScheduleAiRequest(work,signal,kind,options={}) {
  signal?.throwIfAborted();
  var own=typeof ceBridgeLoadConfig==='function'?await ceBridgeLoadConfig():{};
  var native=typeof loadConcurrentEvolutionConfig==='function'?await loadConcurrentEvolutionConfig():{};
  var trace=signal&&typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(signal):null;
  var group=options.group || (trace&&trace.phase!=='变量演化'?'canon':'ordinary');
  var isCanon=group==='canon';
  var timeoutMs=Math.max(15000,Math.min(1800000,Number(isCanon?own.requestTimeoutMs:native.requestTimeout)||120000));
  var report=function(state,waitMs){if(typeof options.onProgress==='function'){try{options.onProgress({state:state,kind:kind,waitMs:waitMs||0,timeoutMs:timeoutMs});}catch(error){console.warn('[请求状态] 更新失败',error);}}};
  // 瞬时故障（5xx/网关/网络抖动）只对原检索的向量化与重排做有限退避重试；
  // 4xx、取消与超时不重试，避免把明确错误或玩家停止当成可重试。
  var transientRetryable=function(error){
    if(!error || error.name==='AbortError' || error.name==='TimeoutError')return false;
    var status=Number(error.status || error.httpStatus) || 0;
    if(status===429 || (status>=400 && status<500))return false;
    if(status>=500)return true;
    return /NetworkError|Failed to fetch|fetch failed|Load failed|network request|网络|网关|502|503|504/i.test(String(error.name||'')+' '+String(error.message||''));
  };
  var retryDelays=Array.isArray(options.retryDelays)?options.retryDelays:Array.from({length:Math.max(0,Math.min(5,Number(isCanon?(own.retry?.maxRetries??2):2)))},(_,index)=>Math.min(8000,400*Math.pow(2,index)));
  var withTransientRetry=async function(work,signal){
    var lastError=null;
    for(var attempt=0;attempt<=retryDelays.length;attempt+=1){
      signal?.throwIfAborted();
      try{return await work();}catch(error){
        lastError=error;
        if(attempt>=retryDelays.length || !transientRetryable(error))throw error;
        report('retrying',retryDelays[attempt]);
        await new Promise(function(resolve,reject){var onAbort=function(){clearTimeout(timer);reject(signal?.reason || Object.assign(new Error('已取消请求'),{name:'AbortError'}));};var timer=setTimeout(function(){signal?.removeEventListener('abort',onAbort);resolve();},retryDelays[attempt]);if(signal){if(signal.aborted)return onAbort();signal.addEventListener('abort',onAbort,{once:true});}});
      }
    }
    throw lastError;
  };
  // 每个真实HTTP独立计时，覆盖读取响应体；排队尚未准入时不启动此计时器。
  // 重试必须重建自己的控制器与计时器：上一次的 signal 一旦 abort 就永久作废，
  // 复用会让第二次尝试立刻抛错，把可重试的瞬时故障变成硬失败。
  var boundedWork=async function(){
    signal?.throwIfAborted();
    // 既有变量演化/流式请求保留其调用方自己的超时；只补齐原检索的缺口。
    if(!isCanon && kind!=='embedding' && kind!=='rerank' && !options.enforceTimeout)return work(signal);
    var attemptOnce=async function(){
      signal?.throwIfAborted();
      var controller=new AbortController(),requestSignal=controller.signal;
      var relay=function(){controller.abort(signal.reason);};
      signal?.addEventListener('abort',relay,{once:true});
      var rejectAbort;
      var interrupted=new Promise(function(resolve,reject){rejectAbort=function(){var error=requestSignal.reason;if(!error || !error.name){error=new Error('已取消请求');error.name='AbortError';}reject(error);};requestSignal.addEventListener('abort',rejectAbort,{once:true});});
      var timeout=function(){var label={embedding:'向量接口',rerank:'重排接口',chat:'模型接口',stream:'流式模型接口'}[kind]||'接口';var error=new Error(label+'请求超时（'+Math.round(timeoutMs/1000)+'秒），请检查接口或调整请求超时');error.name='TimeoutError';controller.abort(error);};
      var timer=typeof frAiQueueTimeout==='function'?frAiQueueTimeout(controller,timeoutMs,timeout):setTimeout(timeout,timeoutMs);
      try{return await Promise.race([Promise.resolve().then(function(){requestSignal.throwIfAborted();return work(requestSignal);}),interrupted]);}
      finally{if(timer&& typeof timer.cancel==='function')timer.cancel();else clearTimeout(timer);signal?.removeEventListener('abort',relay);requestSignal.removeEventListener('abort',rejectAbort);}
    };
    return attemptOnce();
  };
  var runTransport=function(work){return !options.hasNextRoute&&!isCanon&&(kind==='embedding'||kind==='rerank'||options.enforceTimeout)?withTransientRetry(work,signal):work();};
  if(typeof CE_CORE==='undefined' || !CE_CORE['request-budget'])return runTransport(boundedWork);
  if(!frAiRequestBudget)frAiRequestBudget=CE_CORE['request-budget'].createRequestBudget();
  // Providers can share quotas across multiple model routes for the same credential.
  var budget=frAiRequestBudget,rateLimitRoute=frAiRateLimitRoute(options.endpoint,options.apiKey);
  budget.configure({requestsPerMinute:own.requestsPerMinute || 15,maxConcurrency:native.maxConcurrency || 5,concurrencyByGroup:{ordinary:native.maxConcurrency || 5,canon:own.maxConcurrency || 5}});
  var requestWithCooldown=async function(){
    try{return await boundedWork();}
    catch(error){
      if(Number(error?.status||error?.httpStatus)===429)budget.cooldown(error.retryAfterMs,rateLimitRoute);
      throw error;
    }
  };
  var row=signal && frAiRequestWaits.get(signal) || {total:0,waiting:false,started:0};
  row.started=Date.now();row.waiting=true;if(signal)frAiRequestWaits.set(signal,row);
  var run=signal && typeof frCanonTraceSignals!=='undefined' && frCanonTraceSignals.get(signal),reported=false,countedWait=false;
  var finishWait=function(){if(row.waiting){row.total+=Date.now()-row.started;row.waiting=false;}if(run&& countedWait){run.queuedRequests=Math.max(0,(run.queuedRequests||1)-1);countedWait=false;}};
  report('queued');
  var send=async function(){row.started=Date.now();row.waiting=true;reported=false;report('queued');try{return await budget.run(requestWithCooldown,{signal:signal,group:group,route:rateLimitRoute,hasNextRoute:options.hasNextRoute,onAdmit:function(){finishWait();report('running');if(run){run.networkStats=run.networkStats || {};run.networkStats[kind]=(run.networkStats[kind] || 0)+1;frCanonTraceEvent(run,'network','发出辅助AI请求',{kind:kind,counts:run.networkStats});}},onWait:function(ms){report('queued',ms);if(run&&!reported){reported=true;countedWait=true;run.queuedRequests=(run.queuedRequests||0)+1;frCanonTraceEvent(run,'queue','请求排队',{kind:kind,waitMs:ms,limit:own.requestsPerMinute || 15});}}});}finally{finishWait();}};
  return runTransport(send);
}
function frAiUpstreamError(data,status,retryAfter) {
  var raw=data && data.error;
  if(!raw && !(Number(status)>=400))return null;
  var message=typeof raw==='string'?raw:String(raw && (raw.message || raw.detail) || data && data.message || '上游请求失败');
  var code=Number(status)>=400?Number(status):Number(raw && (raw.code || raw.status));
  if(code===429 || /rate.?limit|too many requests|requests? per min|rpm|请求.*[超限额]/i.test(message))code=429;
  var error=new Error('API请求失败'+(code?' ('+code+')':'')+'：'+message);error.status=code;
  if(code===429){
    var seconds=Number(retryAfter),date=Date.parse(retryAfter);
    error.retryAfterMs=Number.isFinite(seconds)&&seconds>0?seconds*1000:Number.isFinite(date)?Math.max(1000,date-Date.now()):60000;
  }
  return error;
}

function frAssertTimeLocationDeltaApplied(delta,state) {
  var op=(delta||[]).filter(function(item){return item.command==='add'&& item.id===TIME_LOCATION_ROW_ID&& item.data&& item.data['0']!==undefined;}).at(-1);
  if(!op)return;
  // applyChanges 写原始时间行；用于展示的 fullText 会改分隔符，不能用它验证写入。
  var rows=state?.['4'],row=Array.isArray(rows)?rows.find(item=>item?.id===TIME_LOCATION_ROW_ID):rows?.[TIME_LOCATION_ROW_ID];
  if(!row||row['0']!==op.data['0'])throw new Error('时间地点指令未实际应用，返回状态与指令不一致');
}

// 只有原变量职责具备完整执行入口时才接管；缺项沿原卡流程并明确提示。
function frCeRequestOwnership(config,preset) {
  /* ★★ 2026-11-02 全面复盘「合并报错」：原来 5 种情况挤成一句「未配置完整」。
   * 玩家根本不知道是没开启、还是缺 URL、缺密钥、缺模型。逐个拆开。 */
  if (!config) return {ok:false,reason:'变量演化接口没有任何配置：请到设置里填写 URL、密钥和模型'};
  if (!config.enabled) return {ok:false,reason:'变量演化接口没有启用：请到设置里打开该开关'};
  if (!config.apiUrl) return {ok:false,reason:'变量演化接口缺少 URL：请在设置里填写接口地址（需以 http:// 或 https:// 开头）'};
  if (!config.apiKey) return {ok:false,reason:'变量演化接口缺少密钥（API Key）：请在设置里填写'};
  if (!config.apiModel) return {ok:false,reason:'变量演化接口缺少模型名：请在设置里选择或填写模型'};
  if (config.enableMiscEvolution === false) return {ok:false,reason:'世界/任务/地图杂项阶段已关闭'};
  var labels={player:'主角变量',item_management:'物品与灵石',misc_management:'世界/任务/地图'};
  for (var key of Object.keys(labels)) {
    var phase=preset&& preset.prompts&& preset.prompts[key];
    var hasRules=phase&&(Array.isArray(phase.rules)?phase.rules.some(function(r){return r.enabled!==false&& String(r.content||'').trim();}):String(phase.systemPrompt||'').trim());
    if (!phase || phase.enabled===false || !hasRules) return {ok:false,reason:labels[key]+'预设未启用或为空'};
  }
  return {ok:true,reason:''};
}

// 独立系统的宿主调度入口。普通变量演化只提供服务，不拥有本系统启停。
/*__FR_BUILD_ID__*/
function frCanonReadAdoptedStoryHeader(storyText) {
  const source = String(storyText || '').replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
  const contents = [...source.matchAll(/<content>[\s\S]*?<\/content>/gi)];
  if (contents.length > 1) return null;
  const content = contents[0];
  const headers = [...source.matchAll(/<ui_sys>([\s\S]*?)<\/ui_sys>/gi)];
  const closing = content ? headers.filter(header => header.index >= content.index + content[0].length) : [];
  // 新楼层采用正文后的状态栏。旧楼层只有一个状态栏时沿用旧格式。
  const status = closing.length === 1 ? closing[0] : headers.length === 1 ? headers[0] : null;
  if (!status) return null;
  const body = status[1];
  const times = [...body.matchAll(/<ti>([^<]+)<\/ti>/gi)];
  if (times.length !== 1) return null;
  const time = times[0][1].match(/^\s*(?:🕒\s*)?(\d{1,6}年\s*\d{1,2}月\s*\d{1,2}日\s*\d{1,2}[:：]\d{2})\s*(?:[|｜]|$)/u)?.[1].replace('：', ':');
  return time && wtParseTimelinePointStrict(time) ? { body, time } : null;
}

function frCanonMainStoryText(value,options={}) {
  var source=String(value || '').replace(/<!--FR_CANON_START-->[\s\S]*?<!--FR_CANON_END-->/g,'');
  // 补演语料只取正文；读取实际时间时显式保留正文头。两者不回写展示源。
  if(!options.includeLayout && typeof parseAIResponse==='function')source=parseAIResponse(source).storyContent;
  source=source.replace(/\x60\x60\x60worldbook\s*([\s\S]*?)\s*\x60\x60\x60/g,function(_,json) { try { return String(JSON.parse(json).title || ''); } catch(_) { return ''; } });
  var template=document.createElement('template');
  template.innerHTML=source;
  template.content.querySelectorAll('script,style,template,thinking,think,upstore,[hidden],[aria-hidden="true"],[data-fr-canon]').forEach(function(node) { node.remove(); });
  template.content.querySelectorAll('[style]').forEach(function(node) { if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) node.remove(); });
  template.content.querySelectorAll('br').forEach(function(node) { node.replaceWith(document.createTextNode('\n')); });
  template.content.querySelectorAll('p,div,section,li,h1,h2,h3,h4,h5,blockquote').forEach(function(node) { node.appendChild(document.createTextNode('\n')); });
  return String(template.content.textContent || '').replace(/\n{3,}/g,'\n\n').trim();
}

function frFormatGenerationTimers(timers, now) {
  var html = '';
  Object.keys(timers).forEach(function(key) {
    var timer = timers[key];
    if (!timer || !timer.active) return;
    var finished = timer.endTime !== null && timer.endTime !== undefined;
    var endAt = finished ? timer.endTime : now;
    var elapsedMs = Math.max(0, endAt - timer.startTime);
    // 单行始终是该任务实际经过的时间；交集单独显示，不能冒充实测节省量。
    var overlapMs = 0;
    if (key === 'variables' && timers.canon?.active) {
      var c = timers.canon;
      var cEnd = c.endTime === null || c.endTime === undefined ? now : c.endTime;
      // 两条线的时间交集：max(起点) → min(终点)，没有交集就是 0。
      var from = Math.max(timer.startTime, c.startTime);
      var to = Math.min(endAt, cEnd);
      if (to > from) overlapMs = to - from;
    }
    var elapsed = (elapsedMs / 1000).toFixed(1);
    var icon = !finished ? '⏳' : ({error:'❌',cancelled:'⏹',skipped:'➖'}[timer.status] || '✅');
    var chars = timer.charCount > 0 ? ' | ' + timer.charCount + '字' : '';
    var label = timer.label;
    var parallel = key === 'variables' && overlapMs > 0
      ? '<span class="fr-canon-parallel-mark" style="margin-left:8px;color:#b599e0">与补演重叠 ' + (overlapMs / 1000).toFixed(1) + 's</span>'
      : '';
    html += '<div>' + icon + ' ' + label + ': ' + elapsed + 's' + chars + parallel + '</div>';
  });
  return html;
}

async function frCanonSetTurnPending(logId,status,reason,storyTurn){
  if(!logId || typeof db==='undefined')return;
  const name=currentArchiveName;
  await db.transaction('rw',db.archives,async()=>{
    const archive=await db.archives.get(name),log=archive?.data?.logs?.find(row=>row.id===logId);
    if(!log||name!==currentArchiveName)return;
    if(status===null)delete log.canonPending;else log.canonPending={status:status,reason:String(reason || '本轮补演尚未完成')};
    if(storyTurn==='no_progress')log.canonStoryTurn=storyTurn;
    else if(storyTurn==='completed')delete log.canonStoryTurn;
    await db.archives.put(archive);
  });
}
async function frCanonTurnNeedsContinuation(log, archiveName) {
  if (!log?.canonPending || log.canonTurnCommit) return false;
  const boundary = typeof frCanonBoundaryLoad === 'function' && await frCanonBoundaryLoad(archiveName, log.id, 'canon');
  const tier = boundary?.turnPlan?.turnAdvanceTier || boundary?.storyAnalysis?.turnAdvanceTier;
  const outsideWithoutWork = boundary?.ok === true && tier === 'outsideRange'
    && !boundary.turnPlan?.canonJobs?.length && !boundary.turnPlan?.deferredRefs?.length
    && !boundary.storyAnalysis?.worldEvents?.length;
  return !outsideWithoutWork;
}

async function frCanonRequireCompletedTurn(){
  const archiveName = currentArchiveName;
  const config = await ceBridgeLoadConfig();
  if (config.enabled === false) return true;
  const archive = await db.archives.get(archiveName);
  const pending = await frCanonTurnNeedsContinuation(frReplayLatestLog(archive), archiveName);
  return currentArchiveName !== archiveName || !pending;
}
async function frCanonContinueTurn(defaults){
  defaults=defaults||{};
  if(!currentArchiveName)throw new Error('没有正在进行的存档');
  var archive=await db.archives.get(currentArchiveName),log=frReplayLatestLog(archive);
  /* ★ 2026-11-02 玩家：「账本里的智能重跑应该与局部重跑里的智能重跑逻辑一致才对。」
   *
   * 这句纠正了一个更根本的定位错误。原来账本的「智能重跑」按钮调的是这里，
   * 于是「智能重跑」实际上是「接续本轮没跑完的事务」，和局部重跑面板里
   * 那个按请求状态挑失败项的智能重跑不是一回事。
   *
   * 现在账本按钮已改走 frReplayRunDirect({smart:true})，与其他智能重跑完全同一条路。
   * 所以这里回归它本来的职责：**接续语义**，只服务明确表达
   * 「接着把没跑完的跑完」的入口，不再兼任智能重跑。
   *
   * 职责单一之后，原来那句「没有待继续事项就抛错」是正确且必要的：
   * 这里本来就不该被当成通用的失败重跑去点。 */
  if(!await frCanonTurnNeedsContinuation(log,currentArchiveName))throw new Error('本轮没有待继续事项；需要自动补跑失败的项，请用「智能重跑」。');
  var own=await ceBridgeLoadConfig();if(own.enabled===false)throw new Error('原著补演已关闭，请先启用后继续本轮。');
  // 继续与主动重跑分开选取。缺记录或版本变化一律由边界校验拒绝，不能退回整轮重算。
  return frReplayRunDirect('canon',Object.assign({},defaults,{mode:'continue'}));
}

async function frRunCanonAfterHostTurn(options) {
  var input = options || {};
  /* ★★★ 2026-11-03 排查「局部重跑 0 次调用」：这个函数有好几个**静默提前返回**，
   * 每一个都会让上层拿到一个「非 ok 但也不报错」的结果，最后表现为
   * 「本次没有可重算的内容」——和「真的没有内容」看起来完全一样。
   * 所以把入口参数和每个提前返回点都打出来（WARN 才能进玩家日志）。 */
  try{console.warn('[补演·入口] replay='+String(!!input.replay)
    +' storyText长度='+String((input.storyText||'').length)
    +' logId='+String(input.logId||'')
    +' earlyPreparation='+String(!!input.earlyPreparation)
    +' ｜replay内 changed='+String((input.replay&&input.replay.changed||[]).length)
    +' seeds='+String(Object.keys((input.replay&&input.replay.seeds)||{}).length)
    +' boundary='+String(!!(input.replay&&input.replay.boundary))
    +' frozenBoundary='+String(!!(input.replay&&input.replay.frozenBoundary)));}catch(_){}
  if(!input.replay&&!input.earlyPreparation&&typeof frCanonEarlyCurrent!=='undefined'&&frCanonEarlyCurrent?.requiredBoundary&&frCanonEarlyCurrent.storyText===String(input.storyText||'')&&frCanonEarlyCurrent.logId===input.logId)input={...input,earlyPreparation:frCanonEarlyCurrent};
  var startedAt = Date.now();
  var ownConfig = await ceBridgeLoadConfig();
  try{console.warn('[补演·配置] enabled='+String(ownConfig&&ownConfig.enabled));}catch(_){}
  if (ownConfig.enabled === false) return { status: 'disabled', landed: false };
  if (input.signal && input.signal.aborted) return { status: 'aborted', landed: false };
  // 复用原请求取消桥；undefined不设超时，不能传0（原桥会把0归一为1ms）。
  var lifecycle = ceCreateRequestAbortBridge(undefined,input.signal);
  var traceRun=null;
  var timingStatus='error';
  var notifyTiming=function(phase) {
    try { if(typeof input.onTiming==='function') input.onTiming(phase,{startTime:startedAt,endTime:phase==='finish'?Date.now():null,status:timingStatus}); } catch(_) {}
  };
  notifyTiming('start');
  /* ★★★ 2026-11-03 玩家验收标准第一条：「运行日志及时清理，按照原卡逻辑」。
   *
   * 这里原来挂着一整套【临时诊断】：
   *   · 给 lifecycle.controller.abort 打补丁，记录第一次 abort 的调用堆栈
   *     （[补演诊断·ABORT] / [补演诊断·STACK]）
   *   · 十来个 _mark('N-阶段名') 打点，每次补演往日志里灌十几行
   *     （[补演阶段] xxx 耗时Nms）
   *   · 失败分支里再打两行完整 result JSON（[补演诊断] status=… / result完整=…）
   *
   * 这些是当初排查「停止无效」「重跑一刀切」时加的临时手段。
   * 问题已经查清并修好（abort 实际一直有效，是侧栏显示被覆盖；
   * 重跑范围是 ranks 线性表算错），诊断代码就不该继续留在正式版里：
   *   · 每次补演刷十几行 warn，日志几轮就上兆，玩家看日志找不到真问题；
   *   · abort 补丁改写了原生方法，等于给停止链路多套一层，没必要；
   *   · 失败原因已经有 ceBridgePushCanonDiag 走正常诊断通道给玩家看，
   *     不需要再往 console 里喷原始 JSON。
   *
   * 这里全部删除。若将来还要查，用正式的诊断通道（frCanonDiag）而不是 console.warn。
   */
  var abortOnPageHide = function() { lifecycle.controller.abort(Object.assign(new Error('页面已卸载，停止本轮原著任务'),{name:'AbortError',code:'FR_PAGE_UNLOAD'})); };
  try {
  await frCanonSetTurnPending(input.logId,'running','正在处理本轮原著补演');
  if(typeof frEnsureCanonSettlementBase==='function')await frEnsureCanonSettlementBase(input.logId,input.storyText,!!input.replay,{keepPending:!!input.awaitOrdinaryWrite});
  if(input.earlyPreparation?.narrative&&typeof frClaimCanonNarrativePreparation==='function')input={...input,earlyPreparation:await frClaimCanonNarrativePreparation({...input,targetTime:ceResolveCanonTargetTime(input)})};
  var earlyRecord=input.earlyPreparation;
  if(earlyRecord?.narrative&&!earlyRecord.cancelled&&earlyRecord.traceRun){traceRun=earlyRecord.traceRun;var cancelEarly=function(){if(earlyRecord.adopted)lifecycle.controller.abort(earlyRecord.controller.signal.reason);};earlyRecord.controller.signal.addEventListener('abort',cancelEarly,{once:true});}
  else if(typeof frCanonTraceBegin==='function'){await frCanonTraceLoad();traceRun=frCanonTraceBegin('正文后补演',{signal:input.signal,controller:lifecycle.controller,logId:input.logId});}
  if(typeof frReplayBefore==='function'){
    await frReplayBefore('canon',traceRun,{storyText:input.storyText||'',userInput:input.userInput||'',logId:input.logId});
    if(typeof frReplaySession==='object'&& frReplaySession&& frReplaySession.context.system==='ce'){
      frReplaySession.canonBase={system:'canon',archiveName:currentArchiveName,sourceRunId:traceRun.id,buildId:typeof FR_BUILD_ID==='string'?FR_BUILD_ID:'',args:{storyText:input.storyText||'',userInput:input.userInput||'',logId:input.logId},beforeArchive:await db.archives.get(currentArchiveName),beforeMemory:frTakeCanonMemory()};
    }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide',abortOnPageHide,{once:true});
    var serviceConfig = {...await loadConcurrentEvolutionConfig(),maxConcurrency:ownConfig.maxConcurrency || 5,requestTimeout:ownConfig.requestTimeoutMs || 120000,retryCount:ownConfig.retry?.maxRetries ?? 2,parseRetryCount:ownConfig.retry?.maxRetries ?? 2,batchLimits:ownConfig.batchLimits,canonCompletionEnabled:true,completionRepairCount:ownConfig.completionRepairCount??1,readyBatchWaitMs:ownConfig.readyBatchWaitMs??100};
    var preset = await getActiveConcurrentEvolutionPreset({resolveRoute:false});
    var shared = buildSharedEvolutionContext(input.storyText || '', input.userInput || '');
    if (lifecycle.signal.aborted) {if(traceRun)await frCanonTraceFinish(traceRun,'cancelled',{status:'aborted',landed:false});return {status:'aborted',landed:false,landedReason:'本轮补演已被中止（signal aborted）'};}
    var result=await ceRunCanonTurnAfterStory({...input,signal:lifecycle.signal,sharedContext:shared,config:serviceConfig,preset:preset,traceRun:traceRun});
    // 成功落库后必须清掉“未完成”标记。
    // 之前只在事务提交那里 delete log.canonPending（那条只覆盖世界提交这一条路径），
    // 这条主路径跑完就是不清，标记从 running 永久留着，
    // 结果玩家账本都记好了、界面却一直显示未完成、还被拦住不许推进下一回合。
    // 玩家 2026-11-01：「账本都记账了，为什么显示未完成，不允许我推进回合？」
    if(result && !result.actorReplacement && (result.landed || result.duplicate ||
       ['nothing_to_do','empty','skipped'].includes(result.status))){
      const emptyTurn=result.boundaryOnly&&result.turnAdvanceTier==='sameEventNoProgress';
      try{ await frCanonSetTurnPending(input.logId,null,null,emptyTurn?'no_progress':
        result.landed&&!result.duplicate?'completed':undefined); }
      catch(error){console.warn('[原著补演] 无法更新本轮故事记录:',error);}
    }
    // 失败必须让玩家看见原因：此前只把状态标成 error 就返回，界面既不出正文也没有任何提示。
    if(result && !result.landed && !result.duplicate){
      if(!['nothing_to_do','empty','skipped'].includes(result.status))await frCanonSetTurnPending(input.logId,'error',result.reason||result.landReason||'本轮有未完成事项，请继续本轮补演');
      var failReason=String(result.reason || result.landReason || '').trim();
      var silentStatus=result.status==='nothing_to_do' || result.status==='empty' || result.status==='skipped';
      /* 2026-11-03 随【临时诊断】一起删掉的两行 console.warn（status 明细 + result 完整 JSON）。
       * 失败原因下面走 ceBridgePushCanonDiag / showDanmaku / frCanonTraceEvent 三条正常通道，
       * 玩家在界面上就能看到；不需要再往控制台喷原始 JSON。 */
      /* ★ 2026-11-06 玩家：「原著补演秒失败，而且什么都不说」。
       * 原条件 if(!silentStatus && failReason) 要求 failReason 非空才通知，
       * 但只要某条失败路径返回的结果里没有 reason/landReason，就是空串 →
       * 三条通道全跳过，计时器却照样盖 ❌。玩家只能看到一个没有解释的红叉。
       * 这里改成：只要不是「静默跳过类」状态，就必须说一句话，没有原因就给兜底。 */
      var failReasonShown=failReason||('本轮补演提前结束（status='+String(result&&result.status||'无')+'）');
      if(!silentStatus){
        try{if(typeof ceBridgePushCanonDiag==='function')ceBridgePushCanonDiag('error','原著补演未完成',failReasonShown);}catch(_){}
        try{if(typeof showDanmaku==='function')showDanmaku('原著补演未完成：'+failReasonShown,'error');}catch(_){}
        if(traceRun)frCanonTraceEvent(traceRun,'error','原著补演未完成',{status:result&&result.status,reason:failReasonShown});
      }
    }
    /* ★ 2026-11-06 排障：计时器为什么画 ❌，必须能一眼看出来。
     * WARN 级才进玩家日志，这里用它把决定性字段打全。 */
    try{console.warn('[补演·结局] status='+String(result&&result.status)
      +' landed='+String(!!(result&&result.landed))
      +' duplicate='+String(!!(result&&result.duplicate))
      +' reason='+String((result&&(result.reason||result.landReason))||'(空)')
      +' isNull='+String(result===null)+' isUndef='+String(result===undefined));}catch(_){}
    timingStatus=result&& result.landed?'saved':result&&(result.status==='nothing_to_do'||result.status==='empty'||result.duplicate)?'skipped':'error';
    if(traceRun)await frCanonTraceFinish(traceRun,lifecycle.signal.reason?.code==='FR_REPLAY_FAILURE'||lifecycle.signal.reason?.name==='TimeoutError'?'error':lifecycle.signal.aborted?'cancelled':result&& result.landed?'saved':result&&(result.status==='nothing_to_do'||result.status==='empty'||result.duplicate)?'skipped':'error',result);
    return result;
  } catch(error) {
    /* ★★★ 2026-11-03 玩家：「原著补演也是马上失败」。
     * 这里原来只把 message 记进 turnPending 就重新抛，**日志里看不到堆栈**，
     * 于是"1.5 秒失败"只能靠猜。补一行带 stack 的 WARN（只有 WARN 以上进玩家日志）。 */
    try{console.warn('[补演·异常] '+String(error&&error.message||error)
      +' ｜stack='+(error&&error.stack?String(error.stack).split('\n').slice(0,7).join(' | '):'(无)'));}catch(_){}
    await frCanonSetTurnPending(input.logId,'error',String(error.message||error));
    if(traceRun)await frCanonTraceFinish(traceRun,lifecycle.signal.reason?.code==='FR_REPLAY_FAILURE'||lifecycle.signal.reason?.name==='TimeoutError'?'error':lifecycle.signal.aborted?'cancelled':'error',{reason:String(error.message||error)});
    throw error;
  } finally {
    try {
    lifecycle.cleanup();
    if(earlyRecord&&cancelEarly)earlyRecord.controller.signal.removeEventListener('abort',cancelEarly);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('pagehide',abortOnPageHide);
    if (typeof ceBridgeCloseStatus === 'function') ceBridgeCloseStatus(traceRun);
    /* ★★★ 2026-11-03 玩家：「变量演化跑完了局部重跑为什么没有内容？」
     *
     * 【真根因】这里原来写的是
     *     if(typeof frReplaySealPending==='function' && !isMainApiGenerating) await frReplaySealPending();
     *
     * 意思就是「主 API 还在生成时，跳过封存」。
     * 但变量演化是**在原著补演回合内部**跑的：CE 收尾时，
     * 外层原著补演的正文 API 往往还在跑（玩家截图里「原著补演 220.3s ⏳」还在转），
     * 于是 isMainApiGenerating 仍为 true → CE 的边界和阶段产物**一条都没落库**。
     * 结果就是 CE 面板 allRequests=[]、目标 0/0、「没有符合条件的目标」。
     *
     * 【为什么当初要加这个判断】seal 会读存档并写一条大对象，
     * 它担心和正在进行的正文生成抢状态。但 seal 只写自己系统的键
     * （FR_REPLAY_BASE_V1:<存档>:<系统> 和 FR_CANON_TURN_ARTIFACTS_V1:<存档>:<层>），
     * 用的是**收尾时刻**的真实存档快照，本身就是「本轮跑完之后」的一致状态，
     * 和正文是否还在跑无关。真正怕的是**读到的存档被写了一半**，
     * 而那由 seal 内部的 debouncedSave.flush() 处理。
     *
     * 【修法】不再因为「主 API 在跑」而跳过 AE/CE 自己的封存。
     * 封存失败仍然只告警、不影响回合收尾（seal 内部已 try/catch 每个系统）。 */
    if (typeof frReplaySealPending === 'function') {
      try { await frReplaySealPending('canon'); }
      catch (sealError) { try { console.warn('[局部重跑] 封存边界失败（不影响回合）：', sealError); } catch (_) {} }
    }
    } finally {
      if(lifecycle.signal.aborted) timingStatus='cancelled';
      notifyTiming('finish');
    }
  }
}

var frCanonCommitScope = null;
function frCanonReservedNpcIds(){
  var record=typeof frCanonEarlyCurrent!=='undefined'?frCanonEarlyCurrent:null;
  return record&&!record.cancelled&&record.archiveName===currentArchiveName?(record.reservedTargets||[]).filter(target=>target.canonNew).map(target=>target.id):[];
}
function frResolveUserName() {
  // 原卡多处已使用的宿主取名路径。避免依赖在JS源码执行前展开{{user}}。
  //
  // 【独立前端补的姓名注入，玩家 2026-10-30 指出漏了】
  //   原卡在酒馆里靠 ST 的 Persona 提供玩家名（name1），独立版没有酒馆，
  //   上面那条路径永远失败，于是所有地方都退化成「你」。
  //   这里补两个来源，优先级：
  //     1. 酒馆宿主（保持原卡行为，若将来仍在酒馆里跑）
  //     2. 玩家在开局向导「性别与种族」页填的名字
  //     3. 独立版配置里的 playerName
  //     4. 兜底「你」
  try {
    var parentWindow = window.parent;
    var value = parentWindow?.SillyTavern?.getContext?.()?.name1 || parentWindow?.name1;
    // 「玩家」是独立版垫片的占位默认值，不是真名，不能当名字用
    if (typeof value === 'string' && value.trim() && value.trim() !== '玩家') return value.trim();
  } catch (_) {}
  try {
    // 独立版垫片自建的 window.SillyTavern 也走同一套：占位值不算数
    var ctx = window.SillyTavern?.getContext?.();
    var own = ctx && ctx.name1;
    if (typeof own === 'string' && own.trim() && own.trim() !== '玩家') return own.trim();
  } catch (_) {}
  try {
    if (typeof window.frPlayerNameGet === 'function') {
      var mine = String(window.frPlayerNameGet() || '').trim();
      if (mine) return mine;
    }
  } catch (_) {}
  try {
    if (typeof window.FRStandaloneConfig?.load === 'function') {
      var cfgName = String(window.FRStandaloneConfig.load().playerName || '').trim();
      // DEFAULTS 里的「玩家」是占位值，不当真名用
      if (cfgName && cfgName !== '玩家') return cfgName;
    }
  } catch (_) {}
  return '你';
}
// 暴露给调试与独立前端自检用（不影响卡内原有调用）
try { window.frResolveUserName = frResolveUserName; } catch (_) {}
function frInCanonCommit() { return !!frCanonCommitScope || !!(typeof frReplaySession==='object'&& frReplaySession&& frReplaySession.strictApply); }
function frFormatCanonSupplement(input) {
  var src = input || {};
  var sections = (src.blocks || []).map(function(block) {
    var body = String(block.body || '').replace(/^@@[^\n]*(?:\n|$)/gm,'').trim();
    return body ? '<h5>'+ceBridgeEsc(block.name || '人物视角')+'</h5><div style="white-space:pre-wrap">'+ceBridgeEsc(body).replace(/^###\s+\[([^\]\r\n]+)\]\s*$/gm,"\u003ch6 class=\"fr-canon-diary-date\">\u00241\u003c/h6>")+'</div>' : '';
  }).filter(Boolean);
  if (src.worldForMisc) sections.push('<h5>世界见闻</h5><div style="white-space:pre-wrap">'+ceBridgeEsc(src.worldForMisc)+'</div>');
  return sections.length ? '<!--FR_CANON_START--><details data-fr-canon="true"><summary>原著补演 · 人物视角与世界见闻</summary>'+sections.join('\n')+'</details><!--FR_CANON_END-->' : '';
}
function frAssertCanonInput(input) {
  var signal = input && input.signal;
  if (signal && signal.aborted) {
    if(signal.reason&& signal.reason.code==='FR_REPLAY_FAILURE')throw signal.reason;
    var detail=signal.reason?.message||typeof signal.reason==='string'&& signal.reason||'';
    if(/^(?:This operation was aborted|The operation was aborted\.?)$/i.test(detail))detail='';
    var error = new Error(detail||'原著补演已停止'); error.name = 'AbortError'; throw error;
  }
  if (input && input.boundary && currentArchiveName !== input.boundary.archiveName) {
    throw new Error('补演期间已切换存档，丢弃旧结果');
  }
}
function frAssertCanonCommit() {
  if (frCanonCommitScope) frAssertCanonInput(frCanonCommitScope);
  else if(typeof frReplaySession==='object'&& frReplaySession&& frReplaySession.strictApply){
    if(currentArchiveName!==frReplaySession.archiveName||frReplaySession.controller.signal.aborted||frReplaySession.invalid){var error=new Error(frReplaySession.invalid||'局部重跑已停止或切换存档');error.name='AbortError';throw error;}
  }
}

// 只监督原执行器的事实覆盖/真实ID，不推断人物语义，也不维护第二份游戏变量。
function frCanonCompletionTools() {
  function cultivationColumn(value) {
    var left=String(value??'').split(/[|｜]/)[0].trim();
    var percentage=left.match(/[（(]\s*(\d+(?:\.\d+)?)\s*%\s*[）)]/);
    return {realm:percentage?left.replace(percentage[0],'').trim():left,progress:percentage?Number(percentage[1]):null};
  }
  function comparableRealm(value) {
    var realm=cultivationColumn(value).realm.replace(/\s+/gu,'').replace(/^练气/u,'炼气');
    if(/^(?:未详|未知|不详|无资料)$/u.test(realm))return '';
    return realm.replace(/^炼气(?:期)?第?(\d{1,2}|十[一二三]?|[一二两三四五六七八九])层$/u,(_,layer)=>{
      var names=['','一','二','三','四','五','六','七','八','九','十','十一','十二','十三'];
      var number=/^\d+$/u.test(layer)?Number(layer):names.indexOf(layer==='两'?'二':layer);
      return '炼气'+(names[number]||layer)+'层';
    });
  }
  function itemState(value){
    var text=String(value||'').trim(),head=text.split(/[（(]/)[0].trim();
    var aliases={'持有':'held','已获得':'held','已持有':'held','已消耗':'consumed','已失去':'lost','已交付':'transferred','已转交':'transferred','已送出':'transferred','已毁坏':'destroyed','不存在':'absent'};
    return aliases[head]||text;
  }
  function read(response) {
    var text=String(response||''),match=text.match(/<canon_completion>\s*([\s\S]*?)\s*<\/canon_completion>/i),value;
    try{value=match?JSON.parse(match[1].replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,'')):JSON.parse(text).completion;}catch(_){return {};}
    var rows=Array.isArray(value)?value:value?.actors;
    if(!Array.isArray(rows))return value&&typeof value==='object'?value:{};
    return Object.fromEntries(rows.filter(row=>row&&String(row.id||row.targetId||'')).map(row=>[String(row.id||row.targetId),row]));
  }
  function strip(response) {
    var text=String(response||''),start=text.lastIndexOf('<canon_completion>');
    if(start<0||start<text.toLowerCase().lastIndexOf('</upstore>'))return text;
    var suffix=text.slice(start);if(!/^<canon_completion>[\s\S]*<\/canon_completion>\s*$/i.test(suffix))return text;
    try{JSON.parse(suffix.replace(/^<canon_completion>\s*|\s*<\/canon_completion>\s*$/gi,'').replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,''));}catch(_){return text;}
    return text.slice(0,start).trim();
  }
  function context(src,targets) {
    var byTargetId={};
    for(var target of targets||[]){
      var block=(src.blocks||[]).find(block=>block.name===target.name);
      var review=block?.completionReview||(src.config?.canonCompletionEnabled?{facts:[],baseline:{applicable:true,basis:'沿原预设核对现有基础配置；不得冒称无需变化'}}:null);
      if(block?.handoffDeclared&&!frCanonHasVariableFront(block))review={facts:(block.handoffReview?.policy==='read_only_terminal'?block.handoffReview.missingCanonItems||[]:[]).map(item=>({kind:item.kind,name:item.name,state:'held',source:'prose',evidence:item.evidence})),cultivation:null,baseline:{applicable:false,basis:'只补AI核验的交汇原著道具漏项，不重跑普通人物变量或基础配置'}};
      byTargetId[target.id]={name:target.name,review:review,body:block?frCanonVariableBody(block):'',reference:src.canonReferences?.[target.name]||null};
    }
    return {byTargetId:byTargetId,referenceTime:src.sharedContext?.currentTime||'',canonReferences:src.canonReferences||{}};
  }
  function prompt(data,phase) {
    if(!data?.byTargetId || !Object.values(data.byTargetId).some(row=>row.review))return '';
    // 正文与人物资料已在阶段主提示词中；附录只携带短事实和本人上限。
    var material={referenceTime:data.referenceTime||'',byTargetId:Object.fromEntries(Object.entries(data.byTargetId).map(([id,row])=>[id,{
      name:row.name,review:row.review,...(row.reference?.ceiling?.text?{ceiling:row.reference.ceiling.text}:{})
    }]))};
    var promptText='\n【两层变量落实与同次核对】\n第一层：把本批已确认散文中的持有、消耗、穿戴、修习和境界进度完整落实，不仅是新获得。第二层：散文未展开的基础配置按原预设合理补全；不另造剧情，不补回已消耗或失去的物品，凡人不强套修士物资。年表与设定仅约束当前事实与补全，不直接兑现未来。技能由人物模块写原备注skills，功法物与装备由物品模块处理。当前阶段：'+phase+'。\n'
      +'【逐人核对材料】\n'+JSON.stringify(material)+'\n'
      +'原<upstore>指令协议保持；其后附一个独立<canon_completion>JSON</canon_completion>，用于核对，不能放入upstore。格式：{"actors":[{"id":"本批真实ID","facts":[{"index":0,"status":"done","refs":["对应原物品或技能ID"],"reason":"说明"}],"baseline":{"checked":true,"reason":"原规则补全或明确不适用理由"}}]}。index为review.facts的原数组序号。只核对此阶段负责的事实：人物负责skill/cultivation，物品负责inventory/equipment/practice；持有/装备/修习必须引用真实原ID，已在库也要引用，不再获得一遍。以当前实际归属为准：已消耗、送出、传授后交付的实体书可标absent并说明；借用、场景设施、他人所有或不属于实体物品可not_applicable并说明。前序事实的分类不是强制库存清单，不得为了满足它把已送出的物品重新塞回送出者背包。普通工具、信物随身携带按原装备规则留在inventory即可，不能因为“佩戴/随身”就强塞装备槽；真正可装备且实际装备的物品仍落实原槽位。不能把实际缺失冒称不适用。基础配置核对要逐人列checked与具体理由，未完成标missing。境界和层内百分比必须按review.cultivation与当前实际情况写原第2列，合法0可保留，技能熟练度和事件时间比例不是境界进度。走廊壁是上限，不是立即达到的目标；只有越过明确上限才需要已确认外力。';
    promptText=promptText.replace('人物负责skill/cultivation','人物负责skill/cultivation/state');
    promptText+="\n【NPC秘籍获得与学习核对】逐本扫描已确认散文和review里的本人获得、持有、传授、学习秘籍事实，即使被归为inventory或practice也要触发对应人物学习核对，不等待额外一句“已学会”。长期功法移入同一真实实例的technique对应槽main/0、body/1、spirit/2、craft/3；原文明确修习、继续原功、改修、暂缓或不能修习时照实落实；未明确时对本人已获且可修的同类功法按师承用途、当前实际收益和最高修炼上限择优，合理推断注明依据，无法判优时保留原功。换入同一实例，旧功退回储物袋，沿用境界进度，不重发或复制库存。眨眼剑法等武技、术法、神通用原生0–9完整技能对象及addSkill增量写本人skills，匹配并复用既有技能ID，不清空旧技能；仅获得时记录基础初学，不编造高阶修成。明确不能学、条件不足、替人保管或已失去未习得时保留具体原因。技能秘籍载体仍在则保留，不因学会误删；无实体传授不造书。人物阶段处理技能、物品阶段处理功法槽与载体，人物在前时也须从取得事实先处理技能，不等物品结果；合并阶段同时核对，后续阶段复用真实ID，不重复执行。回执必须说明每本落实或例外，不能以物品已入库代替技能落地；原阶段命令白名单不变。长春功、象甲功原境界约束照留，获得/试练不等于炼气突破。";
    promptText+="\n【仅年表补演的已有配置】先核对来源用途与玩家影响：进入canon-runtime或出现年表/预制标签不等于纯原著历史。以下合理还原仅用于明确未受玩家改变、且当前节点已经确定的原著历史NPC范围；不适用于普通游戏正文变量链，也不授权为玩家或普通正文中的NPC推测发放资产和能力。当前存档、已确认玩家变异/前台交汇和普通演化实际回执优先，受影响部分按新因果发展；玩家夺走、已消耗、已失去、已交付或未取得的资产不得借补演恢复，来源或影响范围不明默认实时因果边界。当期设定明确此人已会某手段/神通/功法，或本节点年表、已确认补演剧情实际由本人施展，即可认定已有掌握，不要求从头复述获取/学会过程；这是档案镜像补记，不授权安排额外机缘、能力增长或既定原著结局。文学省略不是缺证据，未写何时购得、受教不构成拒绝落地理由。本段当期已会/已用事实就是补演阶段有效的技能与配置依据，不受旧句“只有本轮新学习或获赠才写入”的闸门限制；没有新的学习动作不等于没有既有能力。首次出现可依据当时身份、职业、修为、职责与已经使用的动作，合理补齐其已有技能、背包及实际装备，作为当期既有终态，不伪造本轮受赠、购买、额外数量或新学习经过。已有实物和技能先匹配原ID，不重复发放；未具名的职业基础配置可保守完善，不凭职业套发高阶珍宝、独门绝学或超出当期修为的能力。持续修习体系仍是功法，进入真实对应槽；可施展的具体武技/术法/神通才写原生技能，不把所有功法一股脑转技能。只使用当前节点时间以前已成立且属于本人的事实；未来成就、计划承诺、尚未掌握、仅见别人施展、借用或替人保管均不能当成本人已会/已拥有，明确条件不足与封禁等例外须保留。仅补当前明确事实或合理既有配置与档案之间的缺口；已经完整落地且无变化就沿用，不因回顾历史重发奖励或覆盖无关原值。";
    if(phase!=='items')promptText+='\n【人物修为落档】已确认本人引气入体或能持续循经运转修仙灵气时，凡人应落实到炼气一层。长春功第N层已成才落实到炼气对应层，初察气感、收经卷、试练、将要破层或象甲功等凡俗炼体不足以改变炼气境界。人物用 add 更新原第2列为「炼气一层(5%)|原身份」一类格式，只改境界与层内进度，保留未变化的身份。新小境界已确立且无具体进度时取旧突破重置范围5–15%的下限5%，已有同层合法进度则沿用。不要只写第9列、功法槽或完成回执。旧凡人状态不能覆盖当轮已证实的新境界，未来资料不提前兑现。';
    promptText+='\n伤势、康复、中毒等临时state事实落第4列；明确身份与职务（identity）核对第2列；已有往来、从属或联络（relationship）核对第13列。兼容旧回执：即使事实写作state，接引弟子等身份仍进第2列，与某人或势力的暗中往来仍进第13列。不得把猜测写成既有关系。「战斗状态」只核对第31列布尔开关。动作地点在第16列，推断的动机和目标在27–29。对应completion.facts须附实际写入或复用的完整列值fields和reason；未落地标missing。技能、气运、功法有依据才补；确无内容在回执说明核对结果，不为填满捏造条目。物品阶段只写物品、穿戴与明确的灵石事务，不返回人物终态；灵石余额看第26列，确认没有是0，不创建灵石物品ID。';
    return phase==='merged'?promptText.replace('原<upstore>指令协议保持；其后附一个独立<canon_completion>JSON</canon_completion>，用于核对，不能放入upstore。','核对内容写在同一JSON的completion对象中，不在JSON外附标签。').replace('只核对此阶段负责的事实：','本次同时核对人物与物品事实：'):promptText;
  }
  function containers(target) {
    var projected=typeof FrEquipmentRuntime==='object'?FrEquipmentRuntime.project(target.data):null;
    var remarks=projected?projected.remarks:parseRemarksString(target.data?.['9']||''),nested=function(value,fallback){if(value==null)return fallback;return typeof value==='string'?parseNestedJsonString(value,fallback):value;};
    var inventory=nested(remarks.inventory,[]),equipment=nested(remarks.equipment,{}),skills=nested(remarks.skills,[]),ids=new Set(),equipped=new Set(),skillIds=new Set(),itemsById=new Map();
    (Array.isArray(inventory)?inventory:[]).forEach(item=>{if(item){var id=String(item.id||item['0']||'');ids.add(id);itemsById.set(id,item);}});
    Object.values(equipment||{}).flatMap(value=>Array.isArray(value)?value:[value]).filter(Boolean).forEach(item=>{var id=String(item.id||item['0']||'');ids.add(id);equipped.add(id);itemsById.set(id,item);});
    (Array.isArray(skills)?skills:[]).forEach(item=>{if(item)skillIds.add(String(item.id||item['0']||''));});
    var skillsById=new Map();(Array.isArray(skills)?skills:[]).forEach(item=>{if(item)skillsById.set(String(item.id||item['0']||''),item);});
    return {ids:ids,equipped:equipped,skillIds:skillIds,itemsById:itemsById,skillsById:skillsById};
  }
  function check(input) {
    var target=input.target,phase=input.phase,facts=input.facts||[],report=input.report,hardMissing=[],missingFactIndexes=[],softNotes=[],bag=containers(target),ops=input.actual?[]:input.operations||[];
    function fail(index,note){hardMissing.push(note);missingFactIndexes.push(index);}
    var itemKinds=['inventory','item','equipment','practice','technique','gongfa'],characterKinds=['skill','skills','state','identity','relationship'];
    var supported=phase==='items'?itemKinds:characterKinds;
    var idOf=item=>String(item?.id||item?.['0']||'');
    for(var op of ops){if(String(op.owner||op.to||'')!==String(target.id))continue;var id=String(op.itemId||idOf(op.item)||idOf(op.data)||'');if(id && ['createItem','transferItem','refreshItemData'].includes(op.type))bag.ids.add(id);if(id&&(op.item||op.data))bag.itemsById.set(id,op.item||op.data);if(id&&op.type==='equipItem'){bag.ids.add(id);bag.equipped.add(id);}}
    facts.forEach(function(fact,index){
      if(!fact||!supported.includes(String(fact.kind||'')))return;
      var column='',name=String(fact.name||'').trim();
      if(fact.kind==='identity'||fact.kind==='state'&&/(?:身份|职务|头衔)$/u.test(name))column='2';
      else if(fact.kind==='relationship'||fact.kind==='state'&&/^与.{1,80}(?:往来|联络|交好|结盟|勾结)$/u.test(name))column='13';
      else if(fact.kind==='state')column=name==='战斗状态'?'31':'4';
      var row=report?.facts?.find(row=>Number(row.index)===index),label=(column==='2'?'身份：':column==='13'?'关系：':column?'状态：':phase==='items'?'物品/功法：':'技能：')+String(fact.name||'第'+(index+1)+'项');
      var negative=['consumed','lost','transferred','destroyed','absent'].includes(itemState(fact.state));
      // practice描述修习行为，既可落实为真实技能，也可引用实际持有的功法物；不凭空造书。
      var available=phase==='characters'?bag.skillIds:fact.kind==='equipment'?bag.equipped:fact.kind==='practice'?new Set([...bag.ids,...bag.skillIds]):bag.ids;
      // 附加回执不是第二套真相。缺标签时仅接受唯一、同名、实际可回读的原变量证据，
      // 不用模糊名称、他人ID或“已完成”字样冒充落实；明确坏ID仍须纠正。
      if(phase==='items'&&!negative&&(!row||['done','exists'].includes(row.status)&&!(row.refs||[]).length)){
        var key=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/[《》「」『』（）()\s]/g,'');
        var exact=Array.from(available).filter(id=>{
          var item=bag.itemsById.get(id)||(fact.kind==='practice'?bag.skillsById.get(id):null);
          if(!item||key(item.name||item['1'])!==key(fact.name))return false;
          return !ops.some(op=>String(op.itemId||'')===id&&(['consumeItem','destroyItem'].includes(op.type)&&String(op.owner||'')===String(target.id)||op.type==='transferItem'&&String(op.from||'')===String(target.id)));
        });
        if(exact.length===1){softNotes.push(label+'已按同名原变量ID核对：'+exact[0]);return;}
      }
      if(!row || ['missing','error'].includes(row.status)){fail(index,label+'尚未落实');return;}
      if(column){
        var col=column;
        var declared=row.fields?.[col],actual=target.data?.[col];
        var asText=function(value){return value==null?'':typeof value==='string'?value.trim():JSON.stringify(value);};
        if(!['done','exists'].includes(row.status)||!String(row.reason||'').trim()||!asText(declared)||asText(declared)!==asText(actual)||
          (col==='31'&&!/^(true|false)$/.test(asText(actual))))fail(index,label+'未在第'+col+'列找到一致的状态落实证据');
        return;
      }
      if(['absent','not_applicable'].includes(row.status)&&String(row.reason||'').trim()){
        softNotes.push(label+'：'+String(row.reason));return;
      }
      if(negative&&['done','exists'].includes(row.status)&&String(row.reason||'').trim())return;
      var refs=Array.isArray(row.refs)?row.refs.map(String):[];
      if(input.actual)refs=refs.map(function(id){var transfer=(input.itemReceipts||[]).find(receipt=>receipt.success===true&&String(receipt.oldId)===id&&String(receipt.to)===String(target.id)&&receipt.newId);return transfer?String(transfer.newId):id;});
      var guarded=fact.kind==='equipment'&&refs.length&&refs.every(id=>bag.ids.has(id)&&(input.ruleSkips||[]).some(skip=>String(skip.itemId)===id&&String(skip.owner)===String(target.id)&&skip.skipReason==='equipment_rule'));
      if(guarded){softNotes.push(label+'已保留物品，原装备规则拒绝槽位操作，正常跳过');return;}
      var carried=fact.kind==='equipment'&&refs.length&&refs.every(id=>bag.equipped.has(id)||bag.ids.has(id)&&bag.itemsById.has(id)&&typeof ceResolveExpectedEquipmentSlotByItemData==='function'&&!ceResolveExpectedEquipmentSlotByItemData(bag.itemsById.get(id)));
      if(carried){softNotes.push(label+'已按原物品规则保存在背包；普通工具不要求装备槽');return;}
      if(!refs.length||refs.some(id=>!available.has(id)))fail(index,label+'未找到对应原变量ID');
    });
    // 灵石是**货币**，不是物品：存人物第 26 列的数字，从来就没有离散物品 ID。
    //
    // 玩家 2026-11-01 报：账本把「韩立本轮待补齐：物品/功法：下品灵石未找到对应原变量ID」
    // 判成「未完成」，回合因此卡住，要玩家自己点「继续本轮补演」。
    //
    // 根因：上面的闸门要求每条 inventory 事实都给出 refs（真实物品 ID）并能在
    // inventory/equipment 里找到。灵石在第一层压根不进物品表 ——
    // 原卡第 26 列「当前灵石」是个数值，物品管理用的是 transferSpiritStones 指令。
    // 所以模型如实写了「我有 300 下品灵石」，反而被判成没落实。这是判据错，不是模型错。
    //
    // 正确判法：灵石类事实改看第 26 列有没有有效数值，有就算落实。
    var isCurrencyName = function (name) {
      var text = String(name || '');
      return /^(?:(?:\d+|[一二三四五六七八九十百千万数几]+)\s*(?:枚|块|颗)?\s*)?(?:(?:上|中|下|极)品|(?:低|中|高|超)阶)?灵(?:石|币)$/.test(text.trim());
    };
    // 已在上面被判失败、但其实属于货币的，从这里捞回来。
    if (hardMissing.length) {
      var stoneValue = target && target.data ? target.data['26'] : undefined;
      var stoneText=String(stoneValue??'').trim();
      var stoneNumber=Number(stoneText);
      var stoneOk=/^\d+$/.test(stoneText)&&Number.isSafeInteger(stoneNumber);
      var proposedCredit=ops.some(op=>op.type==='transferSpiritStones'&&String(op.to)===String(target.id)&&Number(op.amount)>0);
      const wallet = typeof frReadSpiritStoneWallet==='function' ? frReadSpiritStoneWallet(target?.data) : {下品:stoneOk?stoneNumber:0};
      if (Object.values(wallet).some(amount=>amount>0)||proposedCredit) {
        var oldCount=hardMissing.length;
        var keep=function(note,i){
          const name = facts[missingFactIndexes[i]]?.name;
          if (!note.includes('未找到对应原变量ID') || !isCurrencyName(name)) return true;
          const namedGrade=String(name).match(/(下品|中品|上品|极品|低阶|中阶|高阶|超阶)灵(?:石|币)/u)?.[1];
          const normalize=typeof frSpiritStoneGrade==='function'?frSpiritStoneGrade:(value=>value||'下品');
          const grade=normalize(namedGrade);
          return !(wallet[grade]>0||ops.some(op=>op.type==='transferSpiritStones'&&String(op.to)===String(target.id)&&
            normalize(op.toGrade??op.grade??op.品级)===grade&&Number(op.receivedAmount??op.amount)>0));
        };
        var keepFlags=hardMissing.map(keep);
        missingFactIndexes=missingFactIndexes.filter((_,i)=>keepFlags[i]);
        hardMissing=hardMissing.filter((_,i)=>keepFlags[i]);
        if (hardMissing.length<oldCount) softNotes.push('灵石按对应品级的钱包余额核对，不计入物品ID校验');
      }
    }
    if(input.baseline?.applicable===true && (!(report?.baseline?.checked===true||report?.baseline?.checked==='true')||!String(report.baseline.reason||'').trim()))softNotes.push('未附基础配置核对说明；沿用原变量规则及实际执行结果');
    var cultivation=input.cultivation,actualCultivation=cultivationColumn(target.data?.['2']);
    if(phase==='characters'&&cultivation){
      var expectedRealm=comparableRealm(cultivation.realm||cultivation.column2);
      if(expectedRealm&&comparableRealm(actualCultivation.realm)!==expectedRealm)hardMissing.push('境界尚未正确写入第2列，应为'+expectedRealm);
      var expectedProgress=String(cultivation.progress??'').trim();
      if(expectedProgress&&Number.isFinite(Number(expectedProgress))&&
        (actualCultivation.progress===null||Math.abs(actualCultivation.progress-Number(expectedProgress))>0.01))hardMissing.push('境界进度尚未正确写入第2列');
    }
    if(report?.baseline?.reason)softNotes.push(String(report.baseline.reason));
    return {completed:hardMissing.length===0,phase:phase,hardMissing:hardMissing,missingFactIndexes:missingFactIndexes,softNotes:softNotes,cultivation:actualCultivation.progress!==null?actualCultivation:cultivation||null};
  }
  return {read:read,strip:strip,context:context,prompt:prompt,check:check};
}

function frCloneCanonPreset(preset) {
  var copy = frAdaptProseExecutionPreset(preset || {});
  copy._frCanonConversionPreset = true;
  copy.prompts = copy.prompts || {};
  var constraint = '【本次调用只转换已成立的补演散文】\n'
    + '两层依据：第一层完整落实已确认散文中的最终事实（包括已持有的物品、修习技能与境界进度，不限新获得）；第二层按原变量演化规则合理补全基础配置与残缺列。'
    + '普通饰物、纪念物和日常工具的佩戴不等于法宝装备；先按设定与实际故事确定物品类别。原卡没有对应饰品槽时，物品保留原容器，穿戴状态写人物第16列，不为了装进槽位改成法宝，不强发equipItem。'
    + '不得重新推演剧情、另造奇遇或突破，不因补全恢复已消耗、失去或转交的物品；按当前身份适配，凡人不得强套高阶修士配置。'
    + '既有完整人物不重新随机生成；原著明确设定可据资料补齐未知列，原著未写的基础空白仅按原预设允许的规则保守推断并标注估值。没有事实变化或允许补列时输出空操作。'
    + '若目标附有【本轮人物基础建档边界】，须按原生新人字段体系建立基础档案：这属于人物初始化，不是追加剧情；依据和范围只认该目标通知。'
    + '使用给出的角色ID，不更改玩家既有事实，不写正文总结；第35列由系统统一追加，勿重复写。';
  ['npc','beast','item_management','misc_management'].forEach(function(key) {
    var prompt = copy.prompts[key] || (copy.prompts[key] = {});
    prompt.enabled = true;
    if (Array.isArray(prompt.rules)) { if (!prompt.rules.some(function(r){return r.id==='fr-canon-consume-only'&& r.content===constraint;})) prompt.rules.push({id:'fr-canon-consume-only',name:'补演散文转换约束',enabled:true,content:constraint}); }
    else prompt.systemPrompt = String(prompt.systemPrompt || '') + '\n\n' + constraint;
  });
  var worldConstraint='【世界范围与上游统一】\n世界模型依据实际因果确认势力、地域、公共秩序、群体处境、公共资源或共同消息的已成立变化。具体人物可以参与世界变化；单纯个人经历归本人。杂项只转换给出的世界正文，不再依据人名数量、规模词表或额外推演重新认定世界范围。没有世界正文时不生成世界指令；有世界正文且无需修改现有世界数据时按原合法空操作协议返回。不得输出超出世界正文证据的事件；仍禁止回写玩家、前台时间地点、场景地图和玩家任务。解析、来源或权限失败必须报错，不能伪装无变化。';
  var miscPrompt=copy.prompts.misc_management;
  if(Array.isArray(miscPrompt.rules)){if(!miscPrompt.rules.some(function(rule){return rule.id==='fr-canon-world-scope' && rule.content===worldConstraint;}))miscPrompt.rules.push({id:'fr-canon-world-scope',name:'世界结果统一范围',enabled:true,content:worldConstraint});}
  else miscPrompt.systemPrompt=String(miscPrompt.systemPrompt || '')+'\n\n'+worldConstraint;
  return copy;
}

function frCanonNpcProfileGaps(row, options) {
  var data = row || {};
  // 判据必须和执行器（变量演化）对齐：它用 completionDetail.needsModelFill
  // 决定「这张卡还要不要补」（见 main.js shouldRetry = needsModelFill === true），
  // 补演这边不能再自己另立一套，否则两边对不上话：
  // 执行器认为不用补，补演却报缺项，玩家就会看到「明明补不了却一直提示待补」。
  var detail = ceGetOriginalTimelineColdStartRowCompletionDetail(data);
  var optional=options?.tier==='minor'?new Set(['12','27','28','29']):options?.tier==='major'?new Set(['12','29']):new Set();
  var missing = (detail.missingNotes || []).concat(detail.missingColumns || []).filter(function(note){var column=String(note).match(/^第(\d+)列/);return !column||!optional.has(column[1]);});
  // 判据直接用执行器 ceGetOriginalTimelineColdStartRowCompletionDetail 报出的缺项，
  // 与变量演化同一口径（同一个函数、同一份 missingNotes/missingColumns）。
  // 注意：不能再用 needsModelFill 去过滤——它表示「要不要交给模型补写」，
  // 不代表「这张卡完整」；用它清空会漏掉背景列这类真实缺项。
  var placeholder = /^(?:未知|不详|未详|待补全|undefined|null|无资料)$/i;
  ['1','2'].forEach(function(key) {
    if (!String(data[key] || '').trim() || placeholder.test(String(data[key]).split('|')[0].trim())) missing.push('第' + key + '列基本身份缺失');
  });
  var remarks = parseRemarksString(data['9'] || '');
  var isDead = /死亡|陨落|身死/.test(String(data['4'] || ''));
  ['年龄','寿元'].forEach(function(key) {
    var value = remarks[key];
    var valid = (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      || (typeof value === 'string' && /[\d一二三四五六七八九十百千]/.test(value) && !placeholder.test(value.trim()));
    if (!valid || (key === '寿元' && Number(value) === 0 && !isDead)) missing.push(key + '缺失或无效');
  });
  if (remarks.isBonded !== true && remarks.isBonded !== false && !/^(?:true|false)$/.test(String(remarks.isBonded))) missing.push('isBonded缺失');
  var attributes = parseNestedJsonString(data['11'], {});
  ['血量','法力'].forEach(function(key) {
    var value = attributes && attributes[key];
    if (!value || !Number.isFinite(value.current) || !Number.isFinite(value.max) || value.current < 0 || value.max < value.current || (key === '血量' && value.max === 0 && !isDead)) missing.push(key + '属性未定义或无效');
  });
  if(options?.complete){
    if(!/(?:\(|（)\s*\d+(?:\.\d+)?\s*%\s*(?:\)|）)/.test(String(data['2']||'').split('|')[0]))missing.push('第2列修炼进度未定义');
    if(!['major','minor'].includes(options?.tier))['物攻','物防','法攻','法防','神识','物理穿透','法术穿透','气运','魅力','脚力','修炼速度'].forEach(function(key){var value=attributes?.[key];if(!value||!Number.isFinite(value.current)||!Number.isFinite(value.max)||value.current<0||value.max<value.current)missing.push('第11列'+key+'属性未定义或无效');});
  }
  var appearance = String(data['16'] || '').split('|');
  // An unrecorded coordinate does not invalidate a named location.
  var place = (appearance[2] || '')
    .replace(/([（(][^（）()]+)[，,；;]\s*坐标\s*[:：]?\s*(?:未详|不详|未知|未载)\s*([）)])\s*$/u, '$1$2')
    .replace(/\s*[（(]\s*坐标\s*[:：]?\s*(?:未详|不详|未知|未载)\s*[）)]\s*$/u, '').trim();
  if (appearance.length !== 5 || !place || /未知|不详|未详|当前位置|当前场景|原著相关地点/.test(place)) missing.push('人物位置缺失');
  const knownUnknown=remarks.canonActorId ? String(remarks.canonPrebuiltUnknown||'').split(',') : [];
  const realm=String(data['2']||'').split('|');
  const knownRole=knownUnknown.includes('境界')&&realm[0]?.trim()==='未知'&&realm[1]?.trim()&&!placeholder.test(realm[1].trim());
  return Array.from(new Set(missing)).filter(note=>
    !(knownRole&&note==='第2列基本身份缺失')&&!['年龄','寿元'].some(key=>
      knownUnknown.includes(key)&&remarks[key]==null&&String(note).includes(key+'缺失')));
}

// 软缺口记录到当前补演运行上，面板据此显示「待补项」。
// 只影响展示与后续「补这一项」按钮，不参与成败判定。
function frCanonRecordProfileGaps(list) {
  try {
    var run = typeof frCanonTraceActive === 'object' && frCanonTraceActive ? frCanonTraceActive : null;
    if (!run) return;
    run.profileGaps = Array.isArray(list) ? list.map(function(row) { return { name: row.name, gaps: row.gaps.slice() }; }) : [];
    if (typeof frCanonTraceEvent === 'function') {
      frCanonTraceEvent(run, 'gap', '人物档案有 ' + run.profileGaps.length + ' 项待补，本轮其余结果照常保存', {
        detail: run.profileGaps.map(function(row) { return row.name + '：' + row.gaps.join('；'); }).join(' / ')
      });
    }
  } catch (_) {}
}
// 人物档案缺口的处置原则：谁有问题就停谁，不连坐。
// 玩家 2026-10-30：「不管什么原因，谁出问题就停他的就好了啊，为什么要连带」。
// 所以这里只返回「哪些人不合格」，由调用方把这些人物从本轮剔除、其余照常保存；
// 只有「一个人都不剩」才算整轮失败（那确实没得存）。
//
// 注意：下面两个函数保持自包含（只依赖 frCanonNpcProfileGaps），
// 因为测试会按函数名从源码里单独抽出它们来跑，不能引用模块内的其他新符号。
function frCanonNpcProfileGapTiers(row, options) {
  var gaps = frCanonNpcProfileGaps(row, options);
  var fatal = [], soft = [];
  gaps.forEach(function(note) {
    var text = String(note);
    // 缺了人物直接不可用：基本身份、血量/法力、当前位置、年龄寿元。
    if (options?.allowIncompletePrebuiltProfile&&/^(?:人物位置缺失|年龄缺失或无效|寿元缺失或无效)$/.test(text)) soft.push(text);
    else if (/第1列|第2列基本身份|第3列|性格|年龄缺失|寿元缺失|isBonded|血量|法力|人物位置/.test(text)) fatal.push(text);
    else soft.push(text);
  });
  return { fatal: fatal, soft: soft };
}
// 返回 { failed:[{name,gaps,soft}], soft:[{name,gaps}] }，不抛错（除非 allowSoft===false）。
function frCanonCollectNpcProfileGaps(targets, options) {
  var allowSoft = options && options.allowSoft === true;
  var failed = [], soft = [];
  (targets || []).forEach(function(target) {
    if (!target.canonNew && !target.canonNeedsProfile) return;
    var tiers = frCanonNpcProfileGapTiers(target.data, { complete: target.canonCheckComplete, tier: target.castTier });
    if (tiers.fatal.length) failed.push({ name: target.name, gaps: tiers.fatal, soft: tiers.soft });
    else if (tiers.soft.length) soft.push({ name: target.name, gaps: tiers.soft });
  });
  // 软缺口只记录，交给面板显示「待补项」，不中断。
  if (soft.length && typeof frCanonRecordProfileGaps === 'function') frCanonRecordProfileGaps(soft);
  // 硬缺口：非 allowSoft 时按老规矩抛（保留给「必须全合格」的少数场景），
  // allowSoft 时只返回清单，让调用方剔除这几个人、其余继续。
  if (failed.length && !allowSoft) {
    throw new Error(failed.map(function(row) { return row.name + '：' + row.gaps.join('；'); }).join(' / '));
  }
  return { failed: failed, soft: soft };
}
// 人物档案校验。语义：默认「严格」——有问题就抛，保持这个函数的原有契约
// （测试直接调它时要求抛错，界面文案也靠它）。
// 「谁出问题只停谁、不连坐」由调用方显式传 {allowSoft:true} 来启用：
// 那时它只返回 {failed,soft} 清单，不抛，由调用方剔除不合格的人、其余照常保存。
//
// 这个函数必须完全自包含：测试会用 sourceFunction('frAssertCanonNpcProfiles')
// 按函数名把它单独抽出来装进沙箱，所以不能调用本文件里其他新函数。
function frAssertCanonNpcProfiles(targets, options) {
  var allowSoft = !!(options && options.allowSoft === true);
  var failed = [], soft = [];
  (targets || []).forEach(function(target) {
    // 检查范围：本次要建档/补档的人（canonNew / canonNeedsProfile），
    // 以及虽然不新建、但档案里已经有内容（只是某列仍是「未知」占位）的人。
    // 完全空白、又没有建档需求的目标不检查——那种情况由物品/杂项阶段处理，
    // 不该在这里报一堆「第1列缺失」把整轮挡住。
    if (target && target.canonSkipProfileCheck === true) return;
    if (!target.canonNew && !target.canonNeedsProfile) {
      var rowData = target.data || {};
      var hasAnyValue = Object.keys(rowData).some(function(key) {
        if (key === '0') return false;
        var value = rowData[key];
        return value !== undefined && value !== null && String(value).trim() !== '';
      });
      if (!hasAnyValue) return;
    }
    var gaps = frCanonNpcProfileGaps(target.data, { complete: target.canonCheckComplete, tier: target.castTier });
    var fatal = [], ownSoft = [];
    gaps.forEach(function(note) {
      var text = String(note);
      // 缺了人物直接不可用：基本身份、血量/法力、当前位置、年龄寿元。
      if (/第1列|第2列基本身份|第3列|性格|年龄缺失|寿元缺失|isBonded|血量|法力|人物位置/.test(text)) fatal.push(text);
      else ownSoft.push(text);
    });
    if (fatal.length) failed.push({ name: target.name, gaps: fatal, soft: ownSoft });
    else if (ownSoft.length) soft.push({ name: target.name, gaps: ownSoft });
  });
  if (soft.length && typeof frCanonRecordProfileGaps === 'function') frCanonRecordProfileGaps(soft);
  if (failed.length && !allowSoft) {
    // 文案沿用原格式「XX人物档案不完整：...」，界面与既有契约测试都按这个识别。
    throw new Error(failed.map(function(row) { return row.name + '人物档案不完整：' + row.gaps.join('；'); }).join(' / '));
  }
  return { failed: failed, soft: soft };
}

function frCanonCharacterOwnershipRules() {
  return '韩立及其他原著人物均是独立NPC。第7列对实际玩家的称呼、第15列对实际玩家的好感由日常变量演化维护，本次补演不要写；第13列只写有根据的具名NPC关系，不用B1、玩家、你或{{user}}代替韩立。玩家已在游戏中建立的关系保留。第4列是持续状态，第31列是战斗开关，第16列是动作和地点，不相互代写。秘闻性格类首次有据时建立，此后承接既有终态；仅已明确发生的经历才记增量，不补造事件。本人已引气入体或可持续循经运转，凡人应在原第2列落为炼气一层，保留身份；长春功已练成的层数对应炼气同层。初察气感、试练、将破未破或象甲功等凡俗炼体不能写成炼气突破。';
}

function frCanonGuardCharacterResult(result) {
  var guard=typeof ceBridgeCore==='function'?ceBridgeCore()['canon-prebuilt']?.guardCanonCharacterDelta:null;
  return guard&&Array.isArray(result?.delta)?{...result,delta:guard(result.delta,result.target)}:result;
}

function frBuildCanonNpcProfileInstruction(target, evidence, input) {
  // 复用原卡的普通新人生成机制，而不是旧原著冷启动的“只补几列”。
  var nativeInstruction = buildNewCharacterInstruction({id:target.id,name:target.name,justCreated:true,canonProfile:true,reason:'本轮原著补演首次建立人物基础档案'});
  // 三档材料深度：A 领衔核心给全套逐项规格，B 重要给个人相关，C 配角只给最小可用档案。
  // 档位只影响「要写多细」，不影响共同底线：ID、物权、生死、境界、进度、检索真实性
  // 三档都必须对，任何一档都不许编造事件或突破。
  var tier=String(target.castTier || 'minor');
  var tierBlock='';
  var estimateLine=ceBridgeCore()['character-profile'].PREBUILT_TERMINAL_TEXT_RULE+'\n凡人无法力时可明确为0/0。\n';
  if(tier==='core'){
    tierBlock='【本人物档位：领衔核心（全套规格）】\n'
      +'必须补齐身份、性格、当前状态、正常人物背景、内心想法、第16列五段、当前/短期/长期目标、战斗/盟友状态，以及第9列年龄/寿元/isBonded。详细属性沿原预设updateAttribute格式补全13项，不以一行简介代替；技能/词条按适用性生成，不给凡人学徒凭空配战斗三件套。\n'
      +estimateLine;
  }else if(tier==='major'){
    tierBlock='【本人物档位：重要角色（个人相关规格）】\n'
      +'必须补齐身份、性格、当前状态、人物背景要点、当前与短期目标、以及第9列年龄/寿元。血量、法力、第16列位置、战斗/盟友状态与isBonded须有效；属性沿原预设updateAttribute格式给出与本轮散文实际相关的项，不必凑满13项，但不能用一行简介代替。\n'
      +'长期目标可从人物的明确动机与行动推断。血脉资质、特殊体质、亲密关系结合资料及前态仍无法推定时可留未详。\n'
      +estimateLine;
  }else{
    tierBlock='【本人物档位：配角（最小可用档案）】\n'
      +'补齐身份、性格要点、当前状态、本轮实际动作与位置、第16列五段、战斗/盟友状态，以及第9列年龄/寿元/isBonded。血量与法力必须是有效数值结构，凡人法力0合法；其他属性只补本轮散文真正涉及的变化项。\n'
      +'从经历与场景能合理推断的背景、内心想法、目标、关系、外貌和衣着简要填写，仍无法推定的非必填细节可留未详。\n'
      +estimateLine;
  }
  return nativeInstruction + '\n\n【本轮人物基础建档边界】\n'
    + '本通知仅对' + target.name + '（' + target.id + '）生效。ID此时只在提案副本预留，尚未保存；必须使用同一ID的add/updateAttribute完成基础建档。\n'
    + '上方原生新人通知提供字段体系与指令格式；依两层规则落实散文并合理补全基础列、技能与词条，物品装备由原物品阶段初始化；不得借建档另造事件、修为突破或未来经历。\n'
    + '原著明确的相关列依设定填写，原著未交代的部分按变量演化规则合理推断。保留已确认的经历和变异。当前档案以本节点为限，未来境界、结局、伤亡、年龄留给后续。\n'
    + tierBlock
    + '位置依该人物散文/档案，不得套用玩家所在的' + String(input.sharedContext && input.sharedContext.currentLocation || '前台场景') + '；第16列其他无资料外貌/衣着可明确未详。\n'
    + frCanonCharacterOwnershipRules()+'\n'
    + '无资料的资质、特殊体质与秘闻保持未详，不得随机补造；装备与物品按原物品模块两层规则核对补全。\n'
    + '第35列由系统追加，禁止写入；第9列必须合并且保留原有来源键。若基础档案仍不能完成，返回缺口说明，本轮不得以空操作冒充建档成功。\n'
    + '【原著人物资料，仅作背景依据】\n' + (String(evidence && evidence.content || '').trim() || '暂无可靠原著人物资料；以现有档案与本轮散文为准。')
    + '\n【该人物本轮已确认散文】\n' + (input.blocks || []).filter(function(block) { return block.name === target.name; }).map(function(block) { return frCanonVariableBody(block); }).join('\n')
    + '\n【已确认历史经历，仅用于基础建档，不等于本轮正文全部通过】\n'+String(input.biography && input.biography[target.name] || '无');
}

function frBuildCanonReferenceInstruction(reference){
  var ref=reference || {};
  return '【原著设定与变量填写依据】\n原著设定已明确的相关列先依设定填写；原著未交代的空白才沿原变量演化规则保守推断。现有存档和本轮已确认经历造成的变化优先，不能把已确认变异恢复为原著，也不能借补列另造剧情或突破；物品基础配置依原规则适配当前身份补全，不擅自发未来法宝。\n'
    +'【本轮原卡批量检索返回的本人设定】\n'+String(ref.setting || ref.biography || '未检索到可靠本人设定，不得伪造原著依据。')
    +'\n【原著相关经历参考，不等于当前已发生】\n'+String(ref.timeline || '')
    +'\n【走廊壁：最近后续相关事件】\n'+String(ref.ceiling && ref.ceiling.text || '暂无后续事件上限资料，不代表可自由突破；仍依当前境界与原规则。')
    +'\n境界与层内百分比必须结合该事件日期、上次实际境界/进度、修炼时间、资质、功法、资源与伤势理解，不能用事件经过比例代替修炼进度。第2列保留实际层内百分比（凡人0%合法），无事实不能归零、暴涨或突破。走廊壁是上限，不是立刻达到的目标。在该时间点前，没有明确且足以改变修炼节奏或进度的外力，不得演化超过上限；普通日常不构成例外。存在外力须列明已确认来源和实际影响，不能自造奇遇。回忆、幻境、假设和提及他人的境界不是本人当期上限。此约束同时用于正文与变量列。';
}

async function frResolveCanonTargets(input) {
  var names = Array.from(new Set([...(input.blocks || []).map(function(block) { return String(block.name || '').trim(); }),...Object.keys(input.biography || {})].filter(Boolean)));
  if (!names.length) return [];
  // 三档判定的唯一来源：与散文分派共用同一份配置与同一个判定函数。
  // 在解析阶段就定下，后面写档案、核验都读同一个 target.castTier，不各自再判一次。
  var tierResolver = typeof input.castTierResolver === 'function' ? input.castTierResolver
    : (await (async function() {
        var module = typeof CE_CORE === 'object' && CE_CORE ? CE_CORE['role-roster'] : null;
        if (!module || typeof module.assignCastTiers !== 'function') return null;
        var config = null;
        try { config = typeof ceBridgeLoadConfig === 'function' ? await ceBridgeLoadConfig() : null; } catch (error) { config = null; }
        // 名单与核心名单都走设置里保存的那份，取不到才退回内置默认。
        var defaults=typeof CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP==='object'?CE_IMPORTANT_ORIGINAL_ROLE_ALIAS_MAP:{};
        var roster=typeof ceBridgeActiveRoleRoster==='function'?ceBridgeActiveRoleRoster(config):module.activeRoleRoster(config?.importantRoleLists,defaults);
        var coreNames = Array.isArray(config && config.coreCharacterNames)
          ? config.coreCharacterNames : module.CE_DEFAULT_CORE_NAMES;
        return function(list) {
          return module.assignCastTiers(list, {
            roster: roster,
            coreNames: coreNames,
            resolve: function(value) { return module.resolveRoleName(roster, value) || String(value || '').trim(); },
          });
        };
      })());
  var index = await ceBuildOriginalTimelineNpcArchiveIndex({sharedContext: input.sharedContext || {},includePlayer:true,strict:true});
  var allTargets = await collectEvolutionTargets({...input.config, focusSelectionMode:'all'}, {silent:true});
  var used = new Set(allTargets.map(function(t) { return t.id; }));
  (index.records || []).forEach(function(row) { used.add(row.id); });
  var replayIds=new Map((input.replay?.variableHandoff?.actors||[]).map(row=>[row.name,row.id]));
  Object.entries(input.replay?.actorReplacement?.actorIds||{}).forEach(([name,id])=>replayIds.set(name,id));
  var canonIdentity = typeof CE_CORE === 'object' && CE_CORE?.['role-roster']?.canonActorId;
  var boundActors = new Map();
  if (typeof canonIdentity === 'function' && typeof parseRemarksString === 'function') {
    for (var candidate of [...(index.records || []), ...allTargets]) {
      var binding = candidate.id !== 'B1' && parseRemarksString(candidate.data?.['9'] || '').canonActorId;
      if (!binding) continue;
      if (!boundActors.has(binding)) boundActors.set(binding, new Set());
      boundActors.get(binding).add(candidate.id);
    }
  }
  var next = Math.max(0, Number(index.maxNpcNumber) || 0) + 1;
  var targets = [];
  for (var name of names) {
    frAssertCanonInput(input);
    var clean = function(text) { return String(text || '').replace(/<[^>]*>/g,'').split('|')[0].trim(); };
    var variants = ceBuildOriginalTimelineNameVariants(name);
    var records = (index.records || []).filter(function(r) {
      return clean(r.name) === name || variants.includes(r.normalizedName)
        || Array.from(r.aliases || []).some(function(alias) { return variants.includes(alias); });
    });
    var exact = allTargets.filter(function(t) { return clean(t.name) === name; });
    var bound = typeof canonIdentity === 'function' && boundActors.get(canonIdentity(name));
    var identities = bound || new Set([...records.map(function(r) { return r.id; }),...exact.map(function(t) { return t.id; })]);
    if (identities.size > 1) throw new Error('同名或别名人物无法唯一定位：' + name);
    var matchedId = Array.from(identities)[0];
    var record = bound ? (index.records || []).find(row=>row.id===matchedId) : records[0];
    var replayId=replayIds.get(name);
    if(replayId&&(matchedId?matchedId!==replayId:used.has(replayId)))throw new Error('定点重跑的人物ID已变化：'+name+'（'+replayId+'）');
    var target = allTargets.find(function(t) { return t.id === matchedId; });
    if (!target && record) {
      target = {id:record.id,name:name,type:record.id === 'B1'?'player':'npc',data:JSON.parse(JSON.stringify(record.data)),sceneType:record.sceneType || 'offscene',biography:{content:JSON.stringify(record.data)}};
    }
    if (target) target = {...target,name:name};
    if (!target) {
      while (used.has('C' + next)) next++;
      var id = replayId||'C' + next++; used.add(id);
      // 复用现有ID与冷启动行构造；只准备副本，此处不建档、不落库。
      var candidate = {raw:name,normalized:name,variants:ceBuildOriginalTimelineNameVariants(name)};
      // 人物设定已由核心新人检索提供给散文。整部传记不能直接给当前行定境界/伤病。
      var row = ceBuildOriginalTimelineColdStartNpcRow({targetId:id,candidate:candidate,
        vectorMatch:{canonicalName:name,content:'',title:name},
        sharedContext:{currentTime:input.sharedContext && input.sharedContext.currentTime || ''}});
      row['2'] = '未知'; row['4'] = '未知'; row['16'] = '未知|未知|未知|未知|未知';
      row['35'] = ''; // 原著条目不是已发生的生平，统一由已确认补演经历填入。
      target = {id:id,name:name,type:'npc',data:row,sceneType:'offscene',biography:{content:JSON.stringify(row)},canonNew:true};
    }
    if (target.type === 'player' || target.id === 'B1') throw new Error('NPC补演不得接管主角：' + name);
    var profileRemarks = typeof parseRemarksString === 'function' ? parseRemarksString(target.data && target.data['9'] || '') : {};
    var pendingProfile = profileRemarks.pending_model_fill === true || String(profileRemarks.pending_model_fill) === 'true'
      || profileRemarks.original_timeline_cold_start === true || String(profileRemarks.original_timeline_cold_start) === 'true';
    var reference=input.canonReferences && input.canonReferences[name];
    if(!target.castTier&&tierResolver){var assigned=tierResolver([name]);target.castTier=assigned?.get(name)||'minor';}
    if(input.config?.canonCompletionEnabled)target.canonCheckComplete=true;
    if (target.canonNew || (frCanonNpcProfileGaps(target.data,{complete:target.canonCheckComplete,tier:target.castTier}).length && (pendingProfile || input.config?.canonCompletionEnabled))) {
      target.canonNeedsProfile = true;
      // 档位只决定「要写多细」，与分派阶段共用同一套判定，不另立一份名单。
      if(!target.castTier&&tierResolver){
        try{var tierMap=tierResolver([name]);target.castTier=(tierMap&&tierMap.get&&tierMap.get(name))||'minor';}catch(error){target.castTier='minor';}
      }
      var candidate = {raw:name,normalized:name,variants:ceBuildOriginalTimelineNameVariants(name)};
      var evidence = reference ? {canonicalName:name,content:[reference.setting,reference.biography,reference.timeline].filter(Boolean).join('\n\n')} : await ceSearchOriginalCharacterVectors(candidate, {biographyCache:input.sharedContext && input.sharedContext._biographyCache});
      // 原生检索可返回近似姓名，不能拿另一人的资料补本人的档案。
      if (evidence && !ceBuildOriginalTimelineNameVariants(evidence.canonicalName || name).some(function(alias) { return variants.includes(alias); })) evidence = null;
      target.canonProfileInstruction = frBuildCanonNpcProfileInstruction(target,evidence,input);
    }
    if(reference)target.canonProfileInstruction=String(target.canonProfileInstruction || '')+'\n\n'+frBuildCanonReferenceInstruction(reference);
    targets.push(JSON.parse(JSON.stringify(target)));
  }
  return targets;
}

function frCanonUseMergedVariables(input) {
  if(input?.config?.variableUpdateMode!=='merged'||input.isSelectiveReplay||(input.targets||[]).some(target=>target.canonRepairFields?.length))return false;
  var replay=input.replay||(typeof frReplaySessionBySignal==='function'?frReplaySessionBySignal(input.signal,'canon'):null);
  if(!replay&&typeof frReplaySessionBySignal!=='function'&&typeof frReplaySession==='object'&&frReplaySession&&frReplaySession.system!=='ce')replay=frReplaySession;
  return !replay;
}

// 本次只转换已验正文，人物和物品共享一次模型返回；解析/结算仍走原校验器。
async function frExecuteCanonMergedVariables(input) {
  var targets=input.targets||[],context=input.sharedContext||{};
  if(!targets.length)return [];
  var options={preset:input.preset,config:{...input.config,mergedIndependentTargetIds:[]},targets:targets,sharedContext:context,signal:input.signal,canonVariables:true,enabledPhases:{entry:false,items:true,misc:false}};
  var completionTools=frCanonCompletionTools();
  var batches=FrMergedEvolution.characterBatches(targets,input.config.mergedNpcBatchLimit);
  var pack=await requestMergedEvolutionPhase(batches.length===1?options:{...options,sharedOnly:true});
  var reports=completionTools.read(JSON.stringify({completion:pack.completion}));
  if(batches.length>1){
    var characterResponses=Object.create(null),characterReports=Object.create(null),thinking=[];
    for(var batch of batches){
      input.signal?.throwIfAborted();
      var ids=new Set(batch.map(target=>target.id));
      var names=new Set(batch.map(target=>target.name));
      var data=context.canonCompletionContext;
      var selected=data?.byTargetId?{...data,byTargetId:Object.fromEntries(Object.entries(data.byTargetId).filter(([id])=>ids.has(id)))}:data;
      var blocks=(input.blocks||context.canonProseBlocks||[]).filter(block=>names.has(block.name));
      var current;
      try {
        current=await requestMergedEvolutionPhase({...options,targets:batch,characterBatch:true,enabledPhases:{entry:false,items:false,misc:false},
          sharedItemResponse:FrMergedEvolution.itemsForBatch(pack.itemResponse,batch),
          sharedContext:{...context,storyText:blocks.length?frCanonVariableText(blocks,''):context.storyText,canonCompletionContext:selected}});
      } catch (error) {
        if (input.signal?.aborted) throw error;
        throw new Error('补演人物批次失败（'+[...names].join('、')+'）：'+error.message,{cause:error});
      }
      Object.assign(characterResponses,current.characterResponses);
      Object.assign(characterReports,completionTools.read(JSON.stringify({completion:current.completion})));
      thinking.push(current.think);
    }
    pack={...pack,characterResponses,think:thinking.filter(Boolean).join('\n\n')};
    reports=characterReports;
  }
  var itemResponse=pack.itemResponse+'\n<canon_completion>'+JSON.stringify(pack.completion)+'</canon_completion>';
  context._frCanonMergedItemsResponse=itemResponse;
  var results=await executeConcurrentRequests({...input,sharedContext:{...context,precomputedCharacterResponses:pack.characterResponses,mergedThinking:pack.think}});
  return results.map(function(result){return frCanonGuardCharacterResult({...result,completion:reports[result.target.id]||null,mergedItemResponse:itemResponse,variableMode:'merged'});});
}

// 仅补演变量转换走批量；提示词仍由原卡构造，指令仍由原解析器处理。
async function frExecuteCanonCharacterBatch(input) {
  if (!input.isSelectiveReplay && !(input.targets||[]).some(target=>target.canonRepairFields?.length) && typeof frReplayRecordVariableMode==='function') frReplayRecordVariableMode('canon', input.config?.variableUpdateMode, input.signal);
  if(frCanonUseMergedVariables(input)){
    try{return await frExecuteCanonMergedVariables(input);}
    catch(error){
      if(input.signal?.aborted || !(error?.mergedEnvelopeFailure || error?.code==='FR_MERGED_RESPONSE_EMPTY' || error?.code==='FR_MERGED_RESPONSE_LENGTH'))throw error;
      // 合并包还没有产生可提交提案，只降级这批已验收正文的变量转换。
      input.sharedContext._frCanonMergedFallback=true;
      var run=input.signal&&typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(input.signal):null;
      if(run&&typeof frCanonTraceEvent==='function')frCanonTraceEvent(run,'stage','分批更新补演变量',{reason:String(error.message),targetIds:(input.targets||[]).map(target=>target.id)});
    }
  }
  var targets=input.targets || [],config=input.config || {},signal=input.signal;
  var rows=await Promise.all(targets.map(async function(target){var prompt=await buildCharacterEvolutionPrompt(target,input.preset,input.sharedContext);if(!String(prompt || '').trim())throw new Error('人物转换提示词为空：'+target.name);return {target:target,prompt:String(prompt)};}));
  // 只共享逐字相同的整段。把本批全部姓名/ID换成同一符号会抹去朋友、
  // 对手及物品ID的差异，甚至把两张不同人物档案误当作共用资料。
  var counts=new Map();
  rows.forEach(function(row){
    var seen=new Set();
    String(row.prompt||'').split(/\n\s*\n/).forEach(function(part){
      if(part.length<=120)return;
      seen.add(part);
    });
    seen.forEach(function(part){counts.set(part,(counts.get(part)||0)+1);});
  });
  var common=[];
  counts.forEach(function(count,text){if(count>1)common.push(text);});
  common.sort(function(a,b){return b.length-a.length;});
  var frCommonHint="";
  if(common.length){
    frCommonHint="【共用段落说明】下文【共用段落 Rk】是全批人物共同适用的规则与背景，只给出一份，不要重复处理；"
      + "本批人物清单：" + rows.map(function(row){return '【'+row.target.id+' '+row.target.name+'】';}).join('、')
      + "。人物档案、关系引用和物品ID以各自原始资料为准，不互相替换。\n\n";
  }
  var frDedupBefore=rows.reduce(function(n,row){return n+String(row.prompt||"").length;},0);
  rows=rows.map(function(row){
    var text=String(row.prompt||"");
    var pieces=text.split(/\n\s*\n/);
    var normed=pieces.slice();
    for(var ci=0;ci<common.length;ci+=1){
      var key=common[ci];
      for(var pi=0;pi<pieces.length;pi+=1){
        if(normed[pi]===key){pieces[pi]='【共用段落 R'+ci+'】';normed[pi]=null;}
      }
    }
    return {target:row.target,prompt:pieces.join('\n\n')};
  });
  var rules=frCommonHint+common.map(function(part,index){
    return '【共用段落 R'+index+'】\n'+part;
  }).join('\n\n');
  try{console.log('[补演人物批处理] 去重: 去重前 '+frDedupBefore+' 字符 → 抽出共用段落 '+common.length+' 条 / '+common.reduce(function(n,s){return n+s.length;},0)+' 字符（共用部分只发一次）→ 去重后各人合计 '+rows.reduce(function(n,row){return n+row.prompt.length;},0)+' 字符');}catch(_){}
  var pack=ceBridgeCore()['request-budget'].packRequestMaterials;
  var own=typeof ceBridgeLoadConfig==='function'?await ceBridgeLoadConfig():{};
  // 局部重跑时，只要这批里有人被选中，就拆成每人一个请求。
  // 否则合批里混进没勾的人，frReplayResolve 会判「当前合批包含未选人物」直接中止整轮重跑
  // （玩家 2026-10-30 报）。做法与 orchestrator.js:189 的「生平旧账」完全一致。
  // 注意：调用方 main.js:40100 没传 replay，所以这里直接读模块级的 frReplaySession。
  var replay=input.replay||(typeof frReplaySessionBySignal==='function'?frReplaySessionBySignal(signal,'canon'):typeof frReplaySession==='object'&&frReplaySession?.system!=='ce'?frReplaySession:null);
  var replayScopes=replay?.selection?.scopes||replay?.scopes||[];
  var replayStages=replay?.selection?.stages||replay?.stages||[];
  // 局部重跑只勾了部分人物时，必须把「选中」和「未选中」拆成两组请求。
  //
  // 玩家 2026-11-01 报（截图）：
  //   【未完成】当前合批包含未选人物，缺少可安全拆分的完整材料。本次停止，不会整组重新请求。
  //   只能点「重试·继续本轮补演」。
  //
  // 旧逻辑：只要 batch 里**有人**被勾选（touched），就把整组拆成一人一请求；
  //   但没勾的人也被一起拆成单人请求发出去 → frReplayResolve 判「批次含未选人物」→ 抛异常中止。
  //   拆了个寂寞：拆开了，但没把该跳过的跳过。
  //
  // 新逻辑：
  //   · 整阶段都勾（stages 含 characters）→ 不拆，全量正常合批。
  //   · 只有部分人勾 → 选中的人各自单发，未选中的人**合并成一批发给复用逻辑**
  //     （它们会走缓存 / 投影，命中就不再发真实请求）。
  //   · 没有范围勾选信息 → 保持原样，不凭空空拆。
  var charSelected=function(row){
    if(!replayScopes.length)return true;
    if(replayStages.includes('characters'))return true;
    return replayScopes.includes('characters:'+row.target.name)||replayScopes.includes('characters:'+row.target.id);
  };
  /* 2026-11-06：补演人物批处理的每批人数上限。
   * 之前完全交给 maxInputChars/maxOutputChars 推导，实测会把 4 个人并成一个
   * 约 49 万字符的请求；一旦超时就是整批全灭（4 个人一起丢）。
   * 补演追求精确落地，失败面越小越好，默认每批 2 人；可用
   * ceBridgeLoadConfig().characterBatchMaxItems 覆盖。 */
  var frBatchMaxItems=Math.max(1,Math.min(4,Number(own.characterBatchMaxItems)||2));
  var batches=pack(rows,Object.assign({},own.batchLimits,{maxItems:frBatchMaxItems,measure:function(row){return row.prompt.length;},sharedChars:rules.length,estimateOutput:function(row){return row.target.canonNeedsProfile?4500:1500;}})).flatMap(function(group){
    if(group.some(row=>Array.isArray(row.target.canonRepairFields)))return group.map(row=>[row]);
    if(!replayScopes.length)return [group];
    var picked=group.filter(charSelected),rest=group.filter(function(row){return !charSelected(row);});
    // 没混就原样保留（保持打包效率）。
    if(!picked.length||!rest.length)return [group];
    // 混了：选中的各自单发；未选中的合一批交给复用逻辑处理。
    return picked.map(function(row){return [row];}).concat([rest]);
  }),results=[];
  var apiConfigs=getApiConfigsToTry(config);if(!apiConfigs.length)throw new Error('变量演化接口未配置');
  /* 2026-11-06：把这一批到底要跑多少人、总共多少字打出来。
   * 玩家报「一个变量都没落地」时，这行能直接区分「没跑」和「跑了但失败」。 */
  try{console.log('[补演人物批处理] 共 '+rows.length+' 人, '+batches.length+' 批, 合计 '+rows.reduce(function(n,r){return n+r.prompt.length;},0)+' 字符, 名单='+rows.map(function(r){return r.target.id+'/'+r.target.name;}).join('、'));}catch(_){}
  await Promise.all(batches.map(async function(batch){
    if(signal && signal.aborted){var stopped=new Error('已取消人物转换');stopped.name='AbortError';throw stopped;}
    var ids=batch.map(function(row){return row.target.id;}),names=batch.map(function(row){return row.target.name;});
    var referenced=new Set(batch.flatMap(row=>[...row.prompt.matchAll(/【共用段落 R(\d+)】/g)].map(match=>Number(match[1]))));
    var batchRules=referenced.size?'【共用段落说明】以下为本批人物共同引用的规则。\n'+common.map((part,index)=>referenced.has(index)?'【共用段落 R'+index+'】\n'+part:'').filter(Boolean).join('\n\n'):'';
    var completion=input.sharedContext?.canonCompletionContext;
    if(completion?.byTargetId)completion={...completion,byTargetId:Object.fromEntries(ids.filter(id=>Object.hasOwn(completion.byTargetId,id)).map(id=>[id,completion.byTargetId[id]]))};
    var prompt='以下人物同批处理，各自规则逐项保留，禁止混淆人物和物品归属。\n'+batchRules+'\n\n'+batch.map(function(row){return '【人物 '+row.target.id+' '+row.target.name+'】\n'+row.prompt;}).join('\n\n')+'\n【统一返回】只输出一个<upstore>指令块，合并各人实际需要的更新；无变化允许空块。只许修改本批ID：'+ids.join('、')+'。不写时间、玩家、任务、地图；不新增名单外人物。'+frCanonCompletionTools().prompt(completion,'characters');
    prompt+='\n'+frCanonCharacterOwnershipRules();
    var dsWire=typeof frUsesDeepSeekEvolutionWire==='function'&&frUsesDeepSeekEvolutionWire(input.preset);
    var withCompletion=dsWire&&prompt.includes('<canon_completion>');
    var controller=new AbortController(),forward=function(){controller.abort(signal.reason);};if(signal){if(signal.aborted)forward();else signal.addEventListener('abort',forward,{once:true});}
    if(typeof frCanonTraceLinkSignal==='function')frCanonTraceLinkSignal(signal,controller.signal,{stageKey:'characters',subject:names.join('、'),targetId:ids.join(','),targetIds:ids});
    /* 2026-11-06 修复：原来这里是固定 120 秒。
     * 玩家实测 4 个角色全超时、一个变量都没落地；提示词实测 12~14 万字符。
     * 现在按「这次真正要发多少字」估算，并考虑并发排队。
     *
     *   base     : 玩家配置的下限（不低于它）
     *   字符项   : 每 1000 字符 8 秒（读得慢、生成的 JSON 也长）
     *   并发行   : 同批几个人一起发，后发的要排队，按人数放大
     *
     * 举例：13 万字符、4 人并发 → 120s 与 (120 + 130*8) * sqrt(4) 取大 ≈ 2320s
     * 上限 30 分钟封顶，避免真的挂死时玩家等太久。
     */
    var frBatchPromptChars=String(prompt||'').length;
    var frBatchCount=Math.max(1,batches.length);
    var frBatchBase=Math.max(120000,Number(config.requestTimeout)||120000);
    var frBatchBySize=Math.round(frBatchBase+frBatchPromptChars*8)/1000*1000;
    var frBatchTimeout=Math.max(frBatchBase,Math.round(frBatchBySize*Math.sqrt(frBatchCount)));
    frBatchTimeout=Math.min(1800000,frBatchTimeout);
    try{console.log('[补演人物批处理] 提示词='+frBatchPromptChars+' 字符, 批次='+frBatchCount+', 超时='+Math.round(frBatchTimeout/1000)+' 秒（玩家配置下限 '+Math.round(frBatchBase/1000)+' 秒）');}catch(_){}
    var timer=typeof frAiQueueTimeout==='function'?frAiQueueTimeout(controller,frBatchTimeout,function(){controller.abort(Object.assign(new Error('人物变量转换请求超时（'+Math.round(frBatchTimeout/1000)+'秒，提示词'+frBatchPromptChars+'字符）'),{name:'TimeoutError'}));}):null;
    try{
      var parsed=null,response='';
      var run;
      for(var apiIndex=0;apiIndex<apiConfigs.length;apiIndex++){
      var hasNextRoute=apiIndex<apiConfigs.length-1;
      run=await ceBridgeCore().retry.withRetry(async function(attemptInfo){
        var previous=attemptInfo&&attemptInfo.previous;
        var api=apiConfigs[apiIndex];var caller=genericApiCall.__ceOriginal || genericApiCall;
        // 上一次失败必须回传：不带上「错在哪、应该是什么」，重试只是原样重发。
        var retryPrompt=previous&&previous.text?prompt+'\n'+previous.text:prompt;
        if(dsWire)retryPrompt=frEvolutionWirePrompt(retryPrompt,input.preset,withCompletion);
        response=await caller(api.apiUrl,api.apiKey,api.apiModel,[{role:'user',content:retryPrompt}],controller.signal,
          {route:api,hasNextRoute,purpose:dsWire?'json':undefined,max_tokens:Math.max(256,Math.min(262144,Number(own.maxOutputTokens)||65536))});
        if(typeof ceThrowIfApiFailureText==='function')ceThrowIfApiFailureText(response,'补演人物批量转换');
        var wire=dsWire?frEvolutionWireReply(response,input.preset,withCompletion):null;
        if(wire?.error)return {ok:false,reason:wire.error};
        if(wire)response=wire.text;
        var normalized=dsWire?ceExtractUpstoreEnvelope(frCanonCompletionTools().strip(response)):null;
        if(normalized?.error)return {ok:false,reason:normalized.error};
        var store=normalized?[response,normalized.commandsString]:String(response || '').match(/<upstore>([\s\S]*?)<\/upstore>/);
        if(!store)return {ok:false,reason:'人物批量转换缺少 upstore 指令块',correction:{items:[{label:'缺少指令块',actual:'未返回 <upstore>',expected:'<upstore>…</upstore>',hint:'必须只输出一个 upstore 指令块，无变化也要输出空块'}],hint:'用 <upstore></upstore> 包裹指令，不要输出解释文字'}};
        parsed=parseConcurrentEvolutionCommands(store[1]);
        if(parsed.errorMessages && parsed.errorMessages.length)return {ok:false,reason:'人物批量转换指令解析失败：'+JSON.stringify(parsed.errorMessages),correction:{items:[{label:'指令格式不合法',actual:parsed.errorMessages.map(error=>String(error?.detail||error?.details||error?.title||error)).join('；'),hint:'每条指令用合法的原生函数调用及其参数，不输出 command/data 对象'}],hint:dsWire?'按 DS 最终格式重写 commands 列表，只保留本批授权指令':'按原指令格式重写，不要新增未授权命令'}};
        var crossed=[];
        for(var op of parsed.delta || []){var opId=resolveConcurrentEvolutionOpId(op);if(!ids.includes(opId))crossed.push(String(opId));}
        if(crossed.length)return {ok:false,reason:'人物批量转换越过本批目标：'+crossed.join('、'),correction:{expected:ids,items:crossed.map(function(bad){return {label:'越界目标 '+bad,actual:bad,expected:ids.join('、'),hint:'只许修改本批 ID'};}),hint:'删掉越界指令，只保留本批人物的更新'}};
        return {ok:true,value:response};
      },{signal:controller.signal,config:{maxRetries:Math.max(Number(config.retryCount)||0,Number(config.parseRetryCount)||0)},
        retryThrown:!hasNextRoute,
        // 上面的回调把不合格当成 {ok:false,...} 返回，交给 withRetry 带着纠正段重试。
        // 没有这个 validate，返回值会被当成功，越界指令就漏过去了。
        validate:function(value){if(!value||value.ok!==false)return {ok:true};return {ok:false,reason:String(value.reason||'人物批量转换不合格'),correction:value.correction||null};},
        onRetry:function(attempt,max,reason){if(typeof frCanonTraceEvent==='function'&& typeof frCanonTraceSignals!=='undefined'){var trace=frCanonTraceSignals.get(controller.signal);if(trace)frCanonTraceEvent(trace,'retry','人物批量转换重试',{attempt:attempt,max:max,reason:reason});}}});
      if(run.ok || controller.signal.aborted)break;
      }
      if(!run.ok){var failed=new Error(run.reason);
        // 越界/越权属于安全约束：必须硬失败，不能被上层降级成按人重跑。
        if(/越过本批/.test(String(run.reason||'')))failed.ceUnsafe=true;
        if(controller.signal.aborted)failed.name='AbortError';throw failed;}
      for(var row of batch){var delta=(parsed.delta || []).filter(function(op){return resolveConcurrentEvolutionOpId(op)===row.target.id;});results.push({target:row.target,success:true,response:response,delta:delta,emptyUpstore:delta.length===0,commandsString:'',completion:frCanonCompletionTools().read(response)[row.target.id]||null,thinkingContent:typeof ceExtractThinkingContent==='function'?ceExtractThinkingContent(response):''});}
    }catch(batchError){
      // 越界/越权这类安全约束必须硬失败，绝不降级放行：那会让指令改到别的人物身上。
      // 只有「调用或解析一过性失败」才降级为按人重跑，让成功的人不被拖累。
      var unsafe=batchError&&batchError.ceUnsafe===true;
      if(unsafe)throw batchError;
      var batchReason=String((batchError&&batchError.message)||batchError);
      /* 2026-11-06：原来这里只有 results.push，日志里查不到任何痕迹。
       * 玩家看到「一个变量都没落地」时，日志必须能回答「哪几个人、什么原因」。 */
      try{console.warn('[补演人物批处理] 整批失败: '+batch.map(function(row){return row.target.id+'/'+row.target.name;}).join('、')+' ｜原因='+batchReason);}catch(_){}
      for(var failedRow of batch)results.push({target:failedRow.target,success:false,error:batchReason,response:'',delta:[],emptyUpstore:false,commandsString:'',completion:null,thinkingContent:''});
    }finally{if(timer)timer.cancel();if(signal)signal.removeEventListener('abort',forward);}
  }));
  return results.map(frCanonGuardCharacterResult);
}

function frCanonItemComponents(ids,operations){
  var parent=new Map(ids.map(id=>[String(id),String(id)]));
  var find=function(id){while(parent.get(id)!==id)id=parent.get(id);return id;};
  for(var op of operations||[]){var touched=Array.from(new Set([op.owner,op.from,op.to].filter(Boolean).map(String)));
    if(!touched.length||touched.some(id=>!parent.has(id)))throw Object.assign(new Error('合并物品归属超出本批范围'),{ceUnsafe:true});
    for(var id of touched.slice(1))parent.set(find(id),find(touched[0]));
  }
  var groups=new Map();for(var id of parent.keys()){var key=find(id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(id);}return Array.from(groups.values());
}

function frCanonActorReceipt(boundary,target,block,biography){
  var body=String(block.body||''),hash=2166136261;
  for(var i=0;i<body.length;i++){hash^=body.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return {receiptId:boundary?.logId+'|'+target.id+'|'+(hash>>>0).toString(16),actorId:target.id,name:target.name,bodyFingerprint:(hash>>>0).toString(16),body:body,block:structuredClone(block),status:'saved',biography:String(biography?.[block.name]||'')};
}

function frCanonStoredActorRow(archive, id) {
  var active = currentState['0']?.[id];
  if (active) return active;
  var entry = (archive.data.state.worldBookEntries || []).find(row => row.key === id || row.id === id);
  try { return typeof entry?.content === 'string' ? JSON.parse(entry.content) : entry?.content; }
  catch (_) { return null; }
}

function frCanonPrebuiltIdentityTaken(archive, id, name) {
  var variants = ceBuildOriginalTimelineNameVariants(name);
  var matches = function(row, title) {
    var label = String(row?.['1'] || title || '').split('|')[0];
    return label === name || ceBuildOriginalTimelineNameVariants(label).some(alias => variants.includes(alias)) ||
      (row && Array.from(ceExtractOriginalTimelineAliasList(row, {name:label}) || []).some(alias => variants.includes(alias)));
  };
  if (Object.entries(currentState['0'] || {}).some(([key, row]) => key === id || row?.['0'] === id || matches(row))) return true;
  var entries = (archive.data.state.worldBookEntries || []).concat(ceResolveWritableWorldBookBaseline(archive, {respectDeleted:true}).entries || []);
  return entries.some(entry => {
    if (!entry) return false;
    if ([entry.key, entry.id, entry.characterId, entry.charId].includes(id)) return true;
    var row;
    try { row = typeof entry.content === 'string' ? JSON.parse(entry.content) : entry.content; } catch (_) {}
    return row?.['0'] === id || matches(row, entry.title || entry.name) || matches(null, entry.title || entry.name);
  });
}

// Only the prebuilt route uses this gate before mutation repair. Ordinary replay remains parallel.
async function frAwaitCanonPrebuiltSettlement(input) {
  input.signal?.throwIfAborted();
  if(input.awaitOrdinaryWrite){
    var wake,interrupted=new Promise(function(resolve){wake=function(){resolve(false);};});
    input.signal?.addEventListener('abort',wake,{once:true});
    var saved;
    try{saved=await Promise.race([input.awaitOrdinaryWrite,interrupted]);}
    finally{input.signal?.removeEventListener('abort',wake);}
    input.signal?.throwIfAborted();
    frAssertCanonInput({...input,boundary:{archiveName:input.archiveName}});
    if(!saved)throw new Error('本轮普通变量未保存，预制修订保留待续');
  }
  var boundary=await frCaptureCanonBoundary(input.logId);
  frAssertCanonInput({...input,boundary});
  if(boundary.archiveName!==input.archiveName)throw new Error('补演期间已切换存档，丢弃旧结果');
  if(input.floorContent!==undefined&&boundary.floorContent!==input.floorContent)throw new Error('补演期间正文已变化，拒绝覆盖新状态');
  if(input.awaitOrdinaryWrite&&!Object.values(boundary.actorCommits||{}).some(row=>row.prebuiltActor)){
    await frEnsureCanonSettlementBase(input.logId,input.storyText,false,{refresh:true,archiveName:input.archiveName,
      floorContent:input.floorContent,signal:input.signal});
    boundary=await frCaptureCanonBoundary(input.logId);
    frAssertCanonInput({...input,boundary});
    if(input.floorContent!==undefined&&boundary.floorContent!==input.floorContent)throw new Error('补演期间正文已变化，拒绝覆盖新状态');
  }
  return boundary.settlementBase || input.ordinarySettlement || null;
}
function frCanonPrebuiltTerminalCharacterDelta(id, terminalFields, oldRemarks) {
  // 普通 add 对背包只做增量合并。预制同一实体转入装备后，先移除其旧背包位置。
  // 只凭稳定 ID 和终态实际位置判断，不按同名删书，不改变普通 add 的语义。
  var next=parseRemarksString(terminalFields['9'] || ''),nested=value=>typeof value==='string'?parseNestedJsonString(value,[]):value;
  var oldBag=nested(oldRemarks?.inventory)||[],nextBag=nested(next.inventory)||[],equipment=typeof next.equipment==='string'?parseNestedJsonString(next.equipment,{}):next.equipment;
  var itemId=item=>String(item?.['0']||item?.id||'');
  var retained=new Set(nextBag.map(itemId)),equipped=new Set(Object.values(equipment||{}).flat().filter(Boolean).map(itemId));
  var moved=new Set(oldBag.map(itemId).filter(key=>key&&!retained.has(key)&&equipped.has(key)));
  return [...Array.from(moved,subId=>({command:'deItem',id,subId})),{command:'add',id,data:terminalFields}];
}

function frCanonSourceRow(data) {
  var row=structuredClone(data);
  if(typeof row['9']==='string'){
    row['9']=parseRemarksString(row['9']);
    for(var key of ['inventory','equipment','skills','traits','gongfa','cultivationArts']){
      if(typeof row['9'][key]==='string')row['9'][key]=JSON.parse(row['9'][key]);
    }
  }
  if(typeof row['11']==='string')row['11']=JSON.parse(row['11']);
  for(var key of ['年龄','寿元'])if(typeof row['9']?.[key]==='string'&&/^\d+$/.test(row['9'][key]))
    row['9'][key]=Number(row['9'][key]);
  return row;
}

function frCanonEncodeSourceRow(row, original) {
  var result={...row};
  if(typeof original['9']==='string'&&result['9'])result['9']=serializeRemarksObject(result['9']);
  if(typeof original['11']==='string'&&result['11'])result['11']=JSON.stringify(result['11']);
  if(result['13']&&typeof result['13']==='object')result['13']=Object.entries(result['13']).map(([name,value])=>name+':'+value).join('；')||'无';
  return result;
}

function frCanonRecoverPrebuiltResources(row, actor, steps, gaps) {
  const attributesOf=data=>{
    let value=data?.['11'];
    if(typeof value==='string'){
      try{value=JSON.parse(value);}catch(_){return null;}
    }
    return value==null?{}:typeof value==='object'&&!Array.isArray(value)?value:null;
  };
  const current=attributesOf(row);
  if(!current)return row;
  const first=steps[0];
  const before=attributesOf(first?.before), productBefore=attributesOf(first?.productBefore);
  const terminal=attributesOf(actor.terminalColumns);
  const touches=(op,name)=>op.kind==='attribute'&&op.subject===name;
  const dead=/死亡|陨落|身死/.test(String(row['4']||''));
  const result={...current};
  for(const name of ['血量','法力']){
    if(!gaps.includes(name+'属性未定义或无效'))continue;
    const changed=(actor.variables||[]).some(op=>touches(op,name))||steps.some(step=>
      (step.details.fields||[]).some(({path})=>path[0]==='11'&&(!path[1]||path[1]===name))||
      (step.legacyOperations||step.details.operations||[]).some(op=>touches(op,name)));
    const source=before?.[name]??productBefore?.[name]??(!changed&&actor.status!=='变异'?terminal?.[name]:null);
    if(!Number.isFinite(source?.current)||!Number.isFinite(source?.max))continue;
    const old=current[name];
    const value=Number.isFinite(old?.current)&&old.current>=0?old.current:source.current;
    const minMax=name==='血量'&&!dead?Number.MIN_VALUE:0;
    const max=Number.isFinite(old?.max)&&old.max>=minMax?old.max:source.max;
    if(value<0||max<value||max<minMax)continue;
    result[name]={...old,current:value,max};
  }
  return result.血量===current.血量&&result.法力===current.法力?row:
    {...row,'11':row['11']==null||typeof row['11']==='string'?JSON.stringify(result):result};
}

function frCanonAssignSourceIds(row,id){
  var notes=row['9'];
  if(!notes||typeof notes!=='object')return;
  var groups=[
    ['I', [...(notes.inventory||[]),...Object.values(notes.equipment||{}).flat()].filter(Boolean)],
    ['S', (notes.skills||[]).filter(Boolean)],
  ];
  for(var [prefix,items] of groups){
    var used=new Set(items.filter(item=>item&&typeof item==='object').map(item=>item['0']).filter(Boolean));
    var index=1;
    for(var item of items)if(item&&typeof item==='object'&&!item['0']){
      var key;
      do{key=prefix+'_'+id+'_'+String(index++).padStart(2,'0');}while(used.has(key));
      item['0']=key;used.add(key);
    }
  }
}

function frCanonOrdinaryEventSource(target,receipt,after){
  var block=receipt.block;
  var ids=[...new Set(block?.eventIds||[])];
  if(ids.length!==1||!after||!target?.data)return null;
  var eventId=ids[0],core=ceBridgeCore()['canon-event-details'];
  var node={id:eventId+'-F-'+receipt.receiptId,at:'',dependsOn:[]};
  var biography=String(receipt.biography||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  var before=frCanonSourceRow(target.data),current=frCanonSourceRow(after);
  return core.eventSourceRecord(eventId,node,{name:target.name,canonActorId:'npc:'+target.id,
    prose:block.body,biography:biography.filter(line=>!String(before['35']||'').split(/\r?\n/).includes(line)),columns:current},
    {before,knownBaseline:true});
}

function frCanonMergeOrdinaryEventSources(ledger,receipts){
  for(var receipt of receipts){
    for(var source of receipt.eventSources || (receipt.eventSource?[receipt.eventSource]:[])){
      if(!source.eventId)continue;
      var event=(ledger.eventProgress||[]).find(row=>row.eventId===source.eventId);
      if(!event){
        event={eventId:source.eventId,startAt:source.at,endAt:source.at,coveredTo:source.at,status:'ongoing',resolved:false,occurred:[],pending:[],changes:[]};
        (ledger.eventProgress ||= []).push(event);
      }
      event.nodes=event.nodes||[];
      if(!event.nodes.some(node=>node.nodeId===source.nodeId))event.nodes.push({
        nodeId:source.nodeId,title:'人物实际落地回执',kind:'canon',state:'done',sourceOnly:true,at:source.at||event.coveredTo||'',
        actors:[source.name],contributions:[{...source,at:source.at||event.coveredTo||''}],
      });
    }
  }
}

async function frAppendCanonBiography(archiveName, person, text) {
  var archive=await db.archives.get(archiveName);
  var row=person.type==='beast'?currentState['7']?.[person.id]:frCanonStoredActorRow(archive,person.id);
  if(!row)throw new Error('生平目标行不存在：'+person.name);
  var patch={command:'add',data:{'35':String(text||'').trim()}};
  if(patch.data['35']&&mergeAppendBiographyForAdd(patch,row)!==false)row['35']=patch.data['35'];
  if(person.type!=='beast'&&!await updateConcurrentEvolutionArchiveEntry(person.id,row,{silent:true,createIfNotExists:true}))
    throw new Error('生平档案保存失败：'+person.name);
}

async function frApplyCanonOrdinaryEventSteps(steps, targetMap, boundary) {
  var details=ceBridgeCore()['canon-event-details'], sources={}, itemReceipts=[];
  for(var [index,step] of steps.entries()){
    frAssertCanonCommit();
    var archive=await db.archives.get(boundary.archiveName);
    var before=new Map(), stepTargets=new Map();
    for(var actor of step.actors){
      var target=targetMap.get(actor.id), data=frCanonStoredActorRow(archive,actor.id)||target.data;
      before.set(actor.id,frCanonSourceRow(data));
      stepTargets.set(actor.id,{...target,data,biography:{...target.biography,content:JSON.stringify(data)}});
    }
    var changes=await ceApplyCharacterDeltaWithStateSync(step.characterDelta,{targetMap:stepTargets,syncState:false,ensureArchiveEntries:true});
    if(!changes||changes.error)throw new Error('逐事件人物落地失败：'+step.key+' '+String(changes?.error||''));
    var items=await executeItemOperations(step.itemOperations,{npcLoadoutIds:step.actors.map(actor=>actor.id),
      techniqueStory:Object.fromEntries(step.actors.map(actor=>[actor.id,actor.prose]))});
    if(!Array.isArray(items)||items.length!==step.itemOperations.length||items.some(row=>!row?.success))throw new Error('逐事件物品落地失败：'+step.key);
    itemReceipts.push(...items);
    for(var actor of step.actors)if(actor.biography.length)await frAppendCanonBiography(boundary.archiveName,targetMap.get(actor.id),actor.biography.join('\n'));
    archive=await db.archives.get(boundary.archiveName);
    var records=step.actors.map(function(actor){
      var old=before.get(actor.id),row=frCanonSourceRow(frCanonStoredActorRow(archive,actor.id));
      if(!row)throw new Error('逐事件人物回读失败：'+actor.name);
      var previous=new Set(String(old['35']||'').split(/\r?\n/u).map(line=>line.trim()));
      var actual=new Set(String(row['35']||'').split(/\r?\n/u).map(line=>line.trim()));
      if(actor.biography.some(line=>!actual.has(line)))throw new Error('逐事件经历回读失败：'+actor.name);
      var ownItems=step.itemOperations.filter(op=>[op.owner,op.from,op.to].includes(actor.id));
      var ownDelta=step.characterDelta.filter(op=>resolveConcurrentEvolutionOpId(op)===actor.id);
      var dependencies=step.dependencies.filter(entry=>entry.id===actor.id);
      var record=details.eventSourceRecord(step.eventId,{id:step.key+'-F-'+boundary.logId+'-'+actor.id,at:step.at,
        dependsOn:[...new Set(dependencies.map(entry=>entry.previous+'-F-'+boundary.logId+'-'+actor.id))]},
        {name:actor.name,canonActorId:'npc:'+actor.id,prose:actor.prose,biography:actor.biography.filter(line=>!previous.has(line)),columns:row},
        {before:old,knownBaseline:true,operations:[...ownDelta,...ownItems]});
      Object.assign(record,{ordinary:true,floorId:boundary.logId,sourceOrder:index});
      if(dependencies.length)record.dependencyEvidence=dependencies.map(({previous,evidence})=>({previous,evidence}));
      for(var field of record.fields){
        if(field.path[0]==='11' || field.path[0]==='26'&&(step.foundation||step.absoluteBalances.includes(actor.id)) ||
          field.path[0]==='9'&&field.path[1]==='inventory'&&ownItems.some(op=>op.type==='updateItemQuantity'))delete field.delta;
      }
      return record;
    });
    for(var op of step.itemOperations.filter(row=>row.from&&row.to&&row.from!==row.to)){
      var pair=records.filter(record=>['npc:'+op.from,'npc:'+op.to].includes(record.actor));
      for(var record of pair)record.pairedSourceIds=[...new Set([...(record.pairedSourceIds||[]),...pair.filter(row=>row!==record).map(row=>row.sourceId)])];
    }
    for(var record of records)(sources[record.actor.slice(4)] ||= []).push(record);
  }
  return {sources,itemReceipts};
}

async function frPrepareCanonOrdinaryEventBatch(src,targets) {
  var core=ceBridgeCore(),details=core['canon-event-details'],legacyTimeline;
  if(src.blocks.some(block=>!block.eventWindows?.length)&&typeof frTimelineReadSource==='function'){
    legacyTimeline=typeof src.timelineSource==='string'?JSON.parse(src.timelineSource):await frTimelineReadSource();
    frAssertCanonInput(src);
  }
  var entries=targets.map(function(target){
    var block=src.blocks.find(row=>row.name===target.name);
    var windows=block.eventWindows?.length?block.eventWindows:(src.sharedContext?.canonEventWindows||[]);
    if(!windows.length&&legacyTimeline){
      var wanted=new Set(block.eventIds||[]);
      var events=(legacyTimeline.entries||[]).map(row=>({...row,code:row.code||core['vector-input'].eventCodeFromTitle(row.title)})).filter(row=>wanted.has(row.code));
      var range=src.sharedContext?.canonRange||{};
      windows=core['prose-material'].buildProseEventSegments(events,range);
    }
    var segments=details.ordinaryEventSegments(block,windows);
    var missing=block.handoffReview?.policy==='read_only_terminal'?block.handoffReview.missingCanonItems||[]:[];
    if(missing.length){
      var terminal=details.ordinaryEventSegments({...block,handoffDeclared:false,body:block.readOnlyBody,biographyLine:block.readOnlyBiographyLine},windows).at(-1);
      if(!terminal)throw new Error('交汇道具缺少事件来源：'+target.name);
      segments.push({...terminal,prose:missing.map(item=>item.text+'（交汇已核验漏项）').join('\n'),biography:[],itemsOnly:true});
    }
    if(!segments.length&&(!block.handoffDeclared||target.canonNew))throw new Error('跨事件人物缺少可结算正文：'+target.name);
    return {id:target.id,name:target.name,segments};
  });
  var steps=details.planOrdinaryEventSteps(entries);
  var foundations=targets.filter(target=>(target.canonNew||target.canonNeedsProfile)&&steps.some(step=>step.actors.some(actor=>actor.id===target.id))).map(target=>({
    key:'BASE:'+target.id,eventId:null,at:steps.find(step=>step.actors.some(actor=>actor.id===target.id)).at,foundation:true,
    actors:[{id:target.id,name:target.name,prose:'依本人已知设定补齐必要基础档案，事件得失留给对应正文段。',biography:[]}],
  }));
  steps=[...foundations,...steps];
  var participants=targets.filter(target=>steps.some(step=>step.actors.some(actor=>actor.id===target.id)));
  if(!participants.length)return {targets,eventSteps:[],characterDelta:[],itemOperations:[],miscDelta:[]};
  var completionTools=frCanonCompletionTools(),completionContext=completionTools.context(src,targets);
  var context={...src.sharedContext,canonCompletionContext:completionContext,
    storyText:steps.map(step=>JSON.stringify({key:step.key,foundation:step.foundation||undefined,actors:step.actors.map(({id,name,prose,itemsOnly})=>({id,name,prose,itemsOnly}))})).join('\n\n'),
    userInput:'仅把给定NPC本人正文转换成逐事件命令。前段结算后再算后段。itemsOnly为真只补该段核验过的原著道具。'};
  if(typeof frCanonSettlementInstruction==='function')context.userInput+=frCanonSettlementInstruction(src.settlementBase,targets);
  var pack=await requestMergedEvolutionPhase({preset:frCloneCanonPreset(src.preset),config:{...src.config,mergedIndependentTargetIds:[]},
    targets:participants,sharedContext:context,signal:src.signal,canonVariables:true,eventSteps:steps,enabledPhases:{entry:false,items:true,misc:false}});
  frAssertCanonInput(src);
  var eventSteps=steps.map(function(step,index){
    var eventPack=pack.eventPacks[index];
    var characterDelta=step.actors.flatMap(function(actor){
      var target=targets.find(row=>row.id===actor.id);
      var commandText=eventPack.characterResponses[actor.id].match(/<upstore>([\s\S]*?)<\/upstore>/i)[1];
      var parsed=parseConcurrentEvolutionCommands(commandText);
      if(parsed.errorMessages?.length || (actor.itemsOnly&&parsed.delta?.length))throw new Error('逐事件人物指令不合格：'+step.key+' · '+actor.name);
      if(parsed.delta?.some(op=>Object.hasOwn(op.data||{},'35')))throw new Error('逐事件经历须来自本人摘要：'+step.key+' · '+actor.name);
      return frCanonGuardCharacterResult({target,delta:parsed.delta||[]}).delta;
    });
    var items=parseItemManagementResponse(eventPack.itemResponse);
    if(items.error)throw new Error('逐事件物品指令不合格：'+step.key+' · '+items.error);
    if(step.foundation&&items.operations?.length)throw new Error('人物基础档案不得混入事件物品：'+step.key);
    return {...step,characterDelta,itemOperations:items.operations||[],absoluteBalances:eventPack.absoluteBalances,dependencies:eventPack.dependencies};
  });
  var reports=completionTools.read(JSON.stringify({completion:pack.completion}));
  return {targets,eventSteps,characterDelta:[],itemOperations:[],miscDelta:[],
    completionEvidence:{context:completionContext,characters:reports,items:reports}};
}

function frCanonEventProposalGroups(proposal) {
  var ids=proposal.targets.map(target=>target.id);
  var items=proposal.eventSteps.flatMap(step=>step.itemOperations);
  return frCanonItemComponents(ids,items).map(function(component){
    var selected=new Set(component);
    var eventSteps=proposal.eventSteps.map(step=>({...step,
      actors:step.actors.filter(actor=>selected.has(actor.id)),
      characterDelta:step.characterDelta.filter(op=>selected.has(resolveConcurrentEvolutionOpId(op))),
      itemOperations:step.itemOperations.filter(op=>[op.owner,op.from,op.to].some(id=>selected.has(id))),
    })).filter(step=>step.actors.length);
    return {...proposal,eventSteps,targets:proposal.targets.filter(target=>selected.has(target.id))};
  });
}

function frCanonWithdrawActorRow(archive,id,row,sources,retained,ids) {
  var details=ceBridgeCore()['canon-event-details'];
  var changed=details.withdrawEventSources(row,sources,retained,ids);
  if(changed)return changed;
  for(var floor of (archive.data.logs||[]).slice().reverse()){
    var compressed=floor.canonActorCommits?.[id]?.applied?.biographyCompression?.updates?.find(entry=>entry.id===id);
    if(!compressed?.text||typeof compressed.sourceText!=='string')continue;
    var text=String(row['35']||'');
    if(text!==compressed.text&&!text.startsWith(compressed.text+'\n'))continue;
    changed=details.withdrawEventSources({...row,35:compressed.sourceText+text.slice(compressed.text.length)},sources,retained,ids);
    if(changed)return changed;
  }
  return null;
}

function frPlanCanonOrdinaryWithdrawals(archive, ledger, logId) {
  var details=ceBridgeCore()['canon-event-details'];
  var previous=archive.data.state.canonLedger?.eventProgress||[];
  var withdrawn=details.ordinaryEventWithdrawals(previous,ledger.eventProgress);
  if(!withdrawn.length)return [];
  var ids=new Set(withdrawn.map(source=>source.sourceId)), retained=new Map();
  for(var event of previous)for(var node of event.nodes||[])for(var source of node.contributions||[])
    if(source.status==='applied'&&!ids.has(source.sourceId))retained.set(source.sourceId,source);
  for(var floor of archive.data.logs||[])for(var receipt of Object.values(floor.canonActorCommits||{}))
    for(var source of receipt.eventSources||[])
      if((!source.eventId||floor.id===logId)&&source.status==='applied'&&!ids.has(source.sourceId))retained.set(source.sourceId,source);
  var changes=[];
  for(var actor of new Set(withdrawn.map(source=>source.actor))){
    var id=actor.replace(/^npc:/u,''), sources=withdrawn.filter(source=>source.actor===actor);
    var data=frCanonStoredActorRow(archive,id);
    if(!data)throw new Error('取消事件缺少可核验的人物档案：'+sources[0].name);
    var row=frCanonSourceRow(data), other=[...retained.values()].filter(source=>source.actor===actor);
    var next=frCanonWithdrawActorRow(archive,id,row,sources,other,ids);
    if(!next)throw new Error('取消事件与其他来源有依赖或缺证：'+sources[0].name+' · '+sources.map(source=>source.eventId).join('、'));
    frCanonAssignSourceIds(next,id);
    changes.push({id,before:data,data:frCanonEncodeSourceRow(next,data)});
  }
  for(var event of ledger.eventProgress||[])for(var node of event.nodes||[])for(var source of node.contributions||[])
    if(ids.has(source.sourceId))source.status='withdrawn';
  return changes;
}

function frCreatePrebuiltLanding(input) {
  let tail=Promise.resolve(), ordinary, floorContent=input.floorContent;
  const enqueue=work=>{
    const job=tail.then(work);
    tail=job.catch(()=>{});
    return job;
  };
  const capture=async()=>{
    floorContent??=input.floorContent;
    const boundary=await frCaptureCanonBoundary(input.logId);
    frAssertCanonInput({...input,boundary});
    if(boundary.archiveName!==input.archiveName||floorContent!==undefined&&boundary.floorContent!==floorContent)
      throw new Error('预制回执与当前存档楼层不一致');
    floorContent=boundary.floorContent;
    return boundary;
  };
  async function updateLog(change){
    await input.awaitFloor?.();
    const boundary=await capture();
    await db.transaction('rw',db.archives,async()=>{
      frAssertCanonInput({...input,boundary});
      const archive=await db.archives.get(boundary.archiveName);
      const log=archive?.data?.logs?.find(row=>row.id===boundary.logId);
      if(!log||log.content!==boundary.floorContent||log.canonTurnCommit)throw new Error('预制回执的楼层已变化或已结算');
      if(change(log)===false)return;
      await db.archives.put(archive);
      frAssertCanonInput({...input,boundary});
    });
  }
  const waitOrdinary=()=>ordinary ||= Promise.resolve().then(()=>input.awaitSettlement?.());
  return {
    load:async(deferredEventIds=[])=>{
      if(input.awaitFloor){
        frAssertCanonInput({...input,boundary:{archiveName:input.archiveName}});
        const archive=await db.archives.get(input.archiveName);
        if(!archive?.data?.logs?.some(row=>row.id===input.logId))return {};
      }
      const boundary=await capture();
      const premature=Object.values(boundary.actorCommits||{}).filter(row=>
        row.prebuiltActor&&row.block?.eventIds?.some(id=>deferredEventIds.includes(id)));
      if(premature.length){
        const names=premature.map(row=>row.name).join('、');
        throw Object.assign(new Error('本轮已有提前写入后续事件的人物回执：'+names+'。请从这轮玩家正文之前的楼层重新推进。'),{code:'PREBUILT_PREMATURE_RECEIPTS'});
      }
      return boundary.prebuiltCheckpoints;
    },
    checkpoint:(key,receipt,stage)=>enqueue(()=>updateLog(log=>{
      (log.canonPrebuiltCheckpoints ||= {})[key]={...structuredClone(receipt),...stage};
      if(stage.stage==='预制人物修订'&&stage.subject){
        const body=Object.values(receipt.value).map(row=>row.prose).join('\n\n');
        (log.canonPrebuiltProse ||= {})[stage.subject]={status:'saved',receiptId:receipt.signature,
          block:{name:stage.subject,body}};
      }
    })),
    actors:async payload=>{
      await enqueue(()=>updateLog(log=>{
        const prose=(log.canonPrebuiltProse ||= Object.create(null));
        const added=payload.actors.filter(actor=>actor.body&&!Object.hasOwn(prose,actor.name));
        for(const {name,body,status,eventIds} of added)
          prose[name]={status:'saved',receiptId:log.id+'|prebuilt-prose|'+name,block:{name,body,status,eventIds}};
        return added.length>0;
      }));
      // Do not occupy the write queue while ordinary evolution is still running.
      await waitOrdinary();
      return enqueue(async()=>{
        const boundary=await capture();
        let rejection;
        const proposal=await frPrepareCanonPrebuiltProposal(payload,{...input,floorContent,awaitOrdinaryWrite:null,
          allowPrebuiltActors:true,onProposalRejected:reason=>{rejection=reason;}});
        if(!proposal)throw new Error(rejection||'预制落地提案未通过核对');
        if(!proposal.targets.length)return false;
        const blocks=payload.actors.filter(actor=>proposal.targets.some(target=>target.name===actor.name))
          .map(({name,body,status,eventIds})=>({name,body,status,eventIds}));
        const biography=Object.fromEntries(payload.actors.filter(actor=>blocks.some(block=>block.name===actor.name)).map(actor=>[actor.name,actor.biography]));
        const source={...input,boundary,actorOnly:true,blocks,biography,
          actorReceipts:proposal.targets.map(target=>{
            const block=blocks.find(row=>row.name===target.name);
            return {...frCanonActorReceipt(boundary,target,block,biography),prebuiltActor:proposal.prebuiltActorInputs[target.name],
              prebuiltSources:proposal.prebuiltSources.filter(row=>row.name===target.name)};
          })};
        proposal.biographyCompression=await frPrepareCanonBiographyCompression(source,proposal);
        await frCommitCanonProposal(source,proposal);
        return true;
      });
    },
    prepare:async payload=>{
      await waitOrdinary();
      return enqueue(()=>frPrepareCanonPrebuiltProposal(payload,{...input,floorContent,awaitOrdinaryWrite:null,allowPrebuiltActors:true}));
    },
  };
}

async function frCanonPrebuiltActorSignature(actor,sourceSteps) {
  const serialized=JSON.stringify([actor,sourceSteps]);
  if(!globalThis.crypto?.subtle)return serialized;
  const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function frPrepareCanonPrebuiltProposal(payload, input) {
  const stock=ceBridgeCore()['inventory-stock'];
  const reject=reason=>{input.onProposalRejected?.(reason);return null;};
  if (input.awaitOrdinaryWrite) {
    var saved = await input.awaitOrdinaryWrite;
    frAssertCanonInput({ ...input, boundary:{ archiveName:input.archiveName } });
    if (!saved) throw new Error('本轮普通变量未保存，预制成品保留待提交');
  }
  var boundary = await frCaptureCanonBoundary(input.logId);
  frAssertCanonInput({ ...input, boundary });
  if (boundary.archiveName !== input.archiveName) throw new Error('补演期间已切换存档，丢弃旧结果');
  if (input.floorContent !== undefined && boundary.floorContent !== input.floorContent) throw new Error('补演期间正文已变化，拒绝覆盖新状态');
  if (input.awaitOrdinaryWrite) {
    await frEnsureCanonSettlementBase(input.logId,input.storyText,false,{ refresh:true, archiveName:input.archiveName, floorContent:input.floorContent, signal:input.signal });
    boundary = await frCaptureCanonBoundary(input.logId);
    frAssertCanonInput({ ...input, boundary:{ archiveName:input.archiveName } });
    if (input.floorContent !== undefined && boundary.floorContent !== input.floorContent) throw new Error('补演期间正文已变化，拒绝覆盖新状态');
  }
  const commits=Object.values(boundary.actorCommits);
  if (!boundary.settlementBase) return reject('本楼层缺少普通结算快照');
  if (boundary.settlementBase.partial) return reject('本楼层的普通演化还有未完成项目');
  if (boundary.receipt) return reject('本楼层已经完成账本提交');
  if (commits.some(row=>!input.allowPrebuiltActors||!row.prebuiltActor))
    return reject('本楼层已有其他来源的人物补演回执');
  var archive = JSON.parse(boundary.archiveText), targets = [], characterDelta = [], itemOperations = [], readback = {}, terminalRows = [], scenePlacements=[];
  var core = ceBridgeCore()['canon-prebuilt'],details=ceBridgeCore()['canon-event-details'];
  var withdrawals=payload.withdrawalReceipts||[];
  var names = [...payload.actors.map(actor => actor.name),...withdrawals.map(row=>row.name).filter(Boolean)];
  var canonIds = new Map(payload.actors.filter(actor=>actor.canonActorId).map(actor=>[actor.name,actor.canonActorId]));
  var characters = ceBridgeReadCharacters(names, boundary.settlementBase.afterRows, canonIds);
  var sourceRows=[],worldWithdrawals=new Set();
  var sourceSteps=payload.sourceSteps||[];
  var prebuiltSavedActors=Object.create(null),prebuiltActorInputs=Object.create(null);
  const savedLedger=archive.data.state.currentState?.canonLedger;
  var savedDetails=(savedLedger?.eventProgress||[]).flatMap(event=>
    (event.nodes||[]).flatMap(node=>node.contributions||[]));
  var removedIds=new Set(withdrawals.map(row=>row.sourceId));
  for(var source of withdrawals.filter(row=>row.actor==='@world')){
    var matching=(currentState['5']||[]).filter(row=>row.canonEventSourceId===source.sourceId);
    if(matching.length!==source.world.length||matching.some(row=>!source.world.some(original=>
      row['1']===original.scope&&row['2']===original.title+'｜'+String(original.prose||'').trim())))
      throw new Error('世界事件缺少可核验的来源回执：'+source.nodeId);
    matching.forEach(row=>worldWithdrawals.add(row.id));
  }
  for(var name of new Set(withdrawals.map(row=>row.name).filter(Boolean))){
    var id=characters[name]?.id,data=frCanonStoredActorRow(archive,id);
    if(!/^C\d+$/.test(id||'')||!data||JSON.stringify(boundary.settlementBase.afterRows?.[id])!==JSON.stringify(data))
      throw new Error('抽离缺少唯一的实际档案：'+name);
    var relevant=withdrawals.filter(row=>row.name===name);
    var retained=savedDetails.filter(row=>row.name===name&&row.status==='applied'&&!removedIds.has(row.sourceId));
    var inputRow=frCanonSourceRow(data);
    var changed=frCanonWithdrawActorRow(archive,id,inputRow,relevant,retained,removedIds);
    if(!changed)throw new Error('事件来源与当前档案不一致，须补证后抽离：'+name+' · '+relevant.map(row=>row.nodeId).join('、'));
    frCanonAssignSourceIds(changed,id);
    sourceRows.push({id,before:data,data:frCanonEncodeSourceRow(changed,data)});
  }
  var used = new Set([...Object.keys(boundary.settlementBase.afterRows || {}), ...Object.keys(currentState['0'] || {}), ...frCanonReservedNpcIds()]);
  for (var entry of archive.data.state.worldBookEntries || []) for (var key of [entry?.key, entry?.id, entry?.characterId, entry?.charId]) if (key) used.add(key);
  var next = Array.from(used).reduce((highest, id) => /^C\d+$/.test(id) ? Math.max(highest, Number(id.slice(1))) : highest, 0) + 1;
  for (var actor of payload.actors) {
    const ownSteps=sourceSteps.filter(step=>step.name===actor.name);
    const saved=commits.find(receipt=>receipt.name===actor.name);
    if(input.allowPrebuiltActors)prebuiltActorInputs[actor.name]=await frCanonPrebuiltActorSignature(actor,ownSteps);
    if(saved){
      const oldSignature=()=>frCanonPrebuiltActorSignature(actor,ownSteps.map(({legacy,legacyOperations,productBefore,productAfter,...step})=>step));
      if((saved.prebuiltActor!==prebuiltActorInputs[actor.name]&&saved.prebuiltActor!==await oldSignature())||
        !core.samePrebuiltActorBaseline(saved.prebuiltAfterRow,frCanonStoredActorRow(archive,saved.actorId)))
        throw new Error('已保存人物与本轮成品不一致：'+actor.name);
      prebuiltSavedActors[actor.name]=saved;
      continue;
    }
    var id = Object.hasOwn(characters, actor.name) ? characters[actor.name].id : '';
    if (!id) {
      if (characters.__unresolvedNames?.includes(actor.name)) return reject(actor.name+'匹配到多份人物档案');
      if (!actor.seedColumns) return reject(actor.name+'在本楼层没有人物档案，预制落地计划也没有可用的初始快照');
      if (!Number.isSafeInteger(next)) return reject('无法分配新人物编号');
      var newId = 'C' + next++;
      var aliases = ceBuildOriginalTimelineNameVariants(actor.name);
      if (targets.some(target => ceBuildOriginalTimelineNameVariants(target.name).some(alias => aliases.includes(alias))) ||
          frCanonPrebuiltIdentityTaken(archive, newId, actor.name)) return reject(actor.name+'与已有档案姓名或编号冲突');
      let profileIssue;
      var newRow = core.compilePrebuiltNewActor(newId, actor,reason=>{profileIssue=reason;});
      if (!newRow) return reject(actor.name+'的预制初始快照无法写入'+(profileIssue?' · '+profileIssue:''));
      newRow['9'] = serializeRemarksObject(newRow['9']);
      const gaps=frCanonNpcProfileGapTiers(newRow,{complete:false,allowIncompletePrebuiltProfile:actor.allowUnknownDemographics});
      if(gaps.fatal.length)throw new Error(actor.name+'的预制档案无法保存：'+gaps.fatal.join('、'));
      if(actor.allowMissingLocation&&gaps.soft.includes('人物位置缺失'))
        frCanonRecordProfileGaps([{name:actor.name,gaps:['人物位置缺失']}]);
      targets.push({id:newId,name:actor.name,type:'npc',data:newRow,sceneType:'offscene',canonNew:true});
      if(actor.presentAtEnd===true)scenePlacements.push({id:newId,present:true});
      readback[newId] = {fields:{...newRow},attributes:{}};
      continue;
    }
    if (!/^C\d+$/.test(id) || targets.some(row => row.id === id)) return reject(actor.name+'没有唯一可写的 NPC 编号');
    var storedData = frCanonStoredActorRow(archive, id);
    var data = sourceRows.find(row=>row.id===id)?.data||storedData;
    if (!data) throw new Error(actor.name+'缺少当前人物档案');
    if (!core.samePrebuiltActorBaseline(boundary.settlementBase.afterRows?.[id],storedData))
      throw new Error(actor.name+'的普通结算后快照与当前档案不一致');
    var ordinaryTouched=(boundary.settlementBase.records || []).some(row =>
      [row.operation?.id, row.operation?.data?.['0'], row.operation?.owner, row.operation?.from, row.operation?.to].includes(id));
    if (ordinaryTouched && (!actor.ordinaryState || !core.samePrebuiltActorBaseline(actor.ordinaryState.afterRow,storedData)))
      throw new Error(actor.name+'的预制修订未使用本轮普通结算后快照');
    var ownSources=sourceSteps.filter(step=>step.name===actor.name);
    const profileOptions={complete:false,allowIncompletePrebuiltProfile:true};
    let fatal=frCanonNpcProfileGapTiers(data,profileOptions).fatal;
    if(fatal.includes('血量属性未定义或无效')||fatal.includes('法力属性未定义或无效')){
      const recovered=frCanonRecoverPrebuiltResources(data,actor,ownSources,fatal);
      if(recovered!==data){
        const patch=sourceRows.find(row=>row.id===id);
        if(patch)patch.data=recovered;
        else sourceRows.push({id,before:storedData,data:recovered});
        data=recovered;
        fatal=frCanonNpcProfileGapTiers(data,profileOptions).fatal;
      }
    }
    if(fatal.length)throw new Error(actor.name+'的人物档案缺少必要字段：'+fatal.join('、'));
    var target = { id, name: actor.name, type: 'npc', data: structuredClone(storedData),
      sceneType: currentState['0']?.[id] ? 'onscene' : 'offscene' };
    if(typeof actor.presentAtEnd==='boolean')scenePlacements.push({id,present:actor.presentAtEnd});
    if(ownSources.some(step=>step.legacy)){
      var working=frCanonSourceRow(data);
      working['9']=ceBridgeCore()['equipment-layout'].coalesceTreasureSets(working['9']);
      const savedDifference=savedLedger?.prebuiltActorDifferences?.find(row=>row.actorId===id);
      for(const step of ownSources){
        const before=working;
        const moveNames=new Set([...(step.legacyOperations||[]),...(step.details.operations||[])].filter(op=>op.kind==='item').map(op=>op.subject));
        const currentItems=working['9']?.inventory;
        const expanded=stock.restoreInventoryMembers(currentItems,moveNames);
        if(expanded!==currentItems)working={...working,9:{...working['9'],inventory:expanded}};
        if(step.legacy){
          working=core.mergeLegacyPrebuiltActorStep(working,{
            ...step,productBefore:step.productBefore&&frCanonSourceRow(step.productBefore),
            productAfter:step.productAfter&&frCanonSourceRow(step.productAfter),
          },actor.playerNames,savedDifference);
        }else{
          const fields=(step.before?details.eventFieldChanges(frCanonSourceRow(step.before),frCanonSourceRow(step.columns)):step.details.fields)
            .filter(details.isPrebuiltEventField);
          working=details.applyEventFieldChanges(working,fields,{prebuilt:true});
          if(!working)throw new Error('成品来源与实际档案不一致，须补证：'+actor.name+' · '+step.details.nodeId);
        }
        const inventory=working['9']?.inventory;
        const compressed=stock.applyInventoryCompressionTemplate(inventory,step.columns?.['9']?.inventory);
        if(compressed!==inventory)working={...working,9:{...working['9'],inventory:compressed}};
        frCanonAssignSourceIds(working,id);
        step.details.fields=details.eventFieldChanges(before,working).filter(details.isPrebuiltEventField);
        step.details.knownBaseline=true;
      }
      const place=ceBridgeCore()['character-profile'].prebuiltProfilePlace;
      const lastAppearance=actor.terminalColumns?.['16'];
      if(!place(String(working['16']||'').split('|')[2])&&place(String(lastAppearance||'').split('|')[2]))
        working=details.applyPrebuiltSnapshotColumns(working,{'16':lastAppearance});
      const overlay=frCanonEncodeSourceRow(working,data);
      const priorPatch=sourceRows.find(row=>row.id===id);
      if(priorPatch)priorPatch.data=overlay;
      else sourceRows.push({id,before:storedData,data:overlay});
      readback[id]={fields:Object.fromEntries(Object.entries(overlay).filter(([key,value])=>value!==storedData[key])),attributes:{}};
      targets.push(target);
      continue;
    }
    if(ownSources.length&&ownSources.every(step=>step.verified)&&!ordinaryTouched){
      var working=frCanonSourceRow(data);
      working['9']=ceBridgeCore()['equipment-layout'].coalesceTreasureSets(working['9']);
      for(var step of ownSources){
        const original=working;
        const moveNames=new Set((step.details.operations||[]).filter(op=>op.kind==='item').map(op=>op.subject));
        const previousInventory=working['9']?.inventory;
        const expanded=stock.restoreInventoryMembers(previousInventory,moveNames);
        if(expanded!==previousInventory)working={...working,9:{...working['9'],inventory:expanded}};
        var planned=step.before?details.eventFieldChanges(frCanonSourceRow(step.before),frCanonSourceRow(step.columns)):step.details.fields;
        var fields=planned.filter(details.isPrebuiltEventField);
        var changed=details.applyEventFieldChanges(working,fields,{prebuilt:true});
        if(!changed)throw new Error('成品来源与实际档案不一致，须补证：'+actor.name+' · '+step.details.nodeId);
        const inventory=changed['9']?.inventory;
        const compressed=stock.applyInventoryCompressionTemplate(inventory,step.columns?.['9']?.inventory);
        if(compressed!==inventory)changed={...changed,9:{...changed['9'],inventory:compressed}};
        frCanonAssignSourceIds(changed,id);
        step.details.fields=details.eventFieldChanges(original,changed).filter(details.isPrebuiltEventField);
        working=changed;
      }
      working=details.applyPrebuiltSnapshotColumns(working,actor.terminalColumns,{
        preservePosition:actor.allowMissingLocation||target.sceneType==='onscene'&&!actor.liveScene,
      });
      var overlay=frCanonEncodeSourceRow(working,data);
      var priorPatch=sourceRows.find(row=>row.id===id);
      if(priorPatch)priorPatch.data=overlay;
      else sourceRows.push({id,before:storedData,data:overlay});
      readback[id]={fields:Object.fromEntries(Object.entries(overlay).filter(([key,value])=>value!==storedData[key])),attributes:{}};
      targets.push(target);
      continue;
    }
    if (actor.terminalColumns) {
      // On-scene actors retain their live position; ordinary receipt columns stay authoritative.
      var oldRemarks = parseRemarksString(data['9'] || '');
      for (var key of ['inventory','equipment','skills']) {
        if (typeof oldRemarks[key]!=='string') continue;
        try {oldRemarks[key]=JSON.parse(oldRemarks[key]);} catch (_) {return reject(actor.name+'当前档案的 '+key+' 无法读取');}
      }
      var beforeRemarks=actor.ordinaryState?.beforeRow?parseRemarksString(actor.ordinaryState.beforeRow['9']||''):null;
      if(beforeRemarks)for(var key of ['inventory','equipment','skills','traits','gongfa'])if(typeof beforeRemarks[key]==='string'){
        try{beforeRemarks[key]=JSON.parse(beforeRemarks[key]);}catch(_){return reject(actor.name+'的普通结算前态 '+key+' 无法读取');}
      }
      var terminal = core.compilePrebuiltTerminalActor({...target,data},actor,oldRemarks,{beforeRemarks,preserveColumns:target.sceneType==='onscene'&&!actor.liveScene?['16']:[]});
      if (!terminal) return reject(actor.name+'的预制终态无法与当前档案合并');
      var terminalFields = {...terminal.fields,9:serializeRemarksObject(terminal.remarks)};
      if(target.sceneType==='onscene')characterDelta.push(...frCanonPrebuiltTerminalCharacterDelta(id,terminalFields,oldRemarks));
      else terminalRows.push({id,data:{...data,...terminalFields}});
      readback[id]={fields:terminalFields,attributes:{}};
      targets.push(target);
      continue;
    }
    if(ordinaryTouched)return reject(actor.name+'已有本轮普通结算，预制增量缺少可合并终态');
    var itemChanges = actor.variables.filter(op => op.kind === 'item');
    var remainingItems = [];
    if (itemChanges.length) {
      var remarks = parseRemarksString(data['9'] || '');
      var inventory = parseNestedJsonString(remarks.inventory, []);
      var equipment = parseNestedJsonString(remarks.equipment, {});
      var itemPlan = core.compilePrebuiltInventory(id, itemChanges, inventory, Object.values(equipment || {}).flat(),
        {requireBaseline:actor.requireBaseline});
      if (!itemPlan) return reject(actor.name+'的预制物品增减与当前库存不一致');
      remainingItems = itemPlan.remaining;
      itemOperations.push(...itemPlan.operations);
    }
    var operations = core.compilePrebuiltActorDelta({...target,data}, actor.variables.filter(op => op.kind !== 'item'), {requireBaseline:actor.requireBaseline});
    if (!operations) return reject(actor.name+'的预制变量增减与当前档案不一致');
    if (typeof actor.statusSnapshot === 'string' && actor.statusSnapshot !== data['4'])
      operations.push({command:'add',data:{0:id,4:actor.statusSnapshot}});
    var fields = {}, attributes = {};
    for (var op of operations) {
      if (op.command === 'add') for (var field of Object.keys(op.data)) { if (field !== '0') fields[field] = op.data[field]; }
      else attributes[op.attribute] = op.value.current;
    }
    readback[id] = { fields, attributes, remainingItems };
    targets.push(target);
    characterDelta.push(...operations);
  }
  var miscDelta = [];
  var worldRows = Array.isArray(currentState['5']) ? currentState['5'].filter(row=>!worldWithdrawals.has(row.id)) : [];
  if (payload.world.length && (!Array.isArray(currentState['5']) && currentState['5'] != null ||
      (boundary.settlementBase.records || []).some(row => row.kind === 'misc'))) return null;
  for (var [index, event] of payload.world.entries()) {
    if (!event.at) return null;
    var title = event.title, description = String(event.prose || '').trim();
    var eventId = 'prebuilt:' + event.nodeId + ':' + (event.sourceIndex??index);
    var knownConflict = ceBridgeCore()['world-events'].caixiaConflictLink(event);
    var action = knownConflict?.action || event.action || 'add';
    var previousId = knownConflict?.previousId ?? event.previousId;
    if (!['add','update','resolve'].includes(action) || (action !== 'add' && !knownConflict &&
        (!previousId || !worldRows.concat(miscDelta.map(op=>op.eventData)).some(row=>row?.prebuiltChangeId===previousId||row?.id===previousId)))) return null;
    if (worldRows.some(row => row?.id === eventId || (event.changeId && row?.prebuiltChangeId===event.changeId) || String(row?.['2'] || '').trim() === description)) return null;
    miscDelta.push({ command: 'addWorldEvent', eventData: { 0: event.at, 1: event.scope, 2: title + '｜' + description, id: eventId,
      ...ceBridgeCore()['world-events']?.worldLifecycleFields(event),
      ...(event.sourceId?{canonEventSourceId:event.sourceId}:{}),
      prebuiltChangeId:event.changeId||eventId,prebuiltChange:action,prebuiltPreviousId:previousId||'' } });
  }
  var finalSources=new Map(sourceSteps.map(step=>[step.sourceId,step.details]));
  for(const step of sourceSteps){
    const target=targets.find(row=>row.name===step.name);
    if(step.productAfter&&(target||prebuiltSavedActors[step.name])){
      step.details.productBaseline=frCanonSourceRow(step.productAfter);
      step.details.actorId=target?.id||prebuiltSavedActors[step.name].actorId;
    }
  }
  for(const receipt of Object.values(prebuiltSavedActors))for(const source of receipt.prebuiltSources||[])
    finalSources.set(source.sourceId,source);
  for(var event of payload.progress||[])for(var node of event.nodes||[])if(node.contributions)
    node.contributions=node.contributions.map(row=>finalSources.get(row.sourceId)||row);
  return { targets, characterDelta, itemOperations, miscDelta, terminalRows, sourceRows, scenePlacements, worldWithdrawals:[...worldWithdrawals], floorContent:boundary.floorContent,
    prebuiltActorInputs,prebuiltSavedActors,prebuiltSources:sourceSteps.map(step=>step.details),
    prebuiltReadback: readback, prebuiltBiography: payload.compressions || [] };
}

function frCanonRefreshPrebuiltActorDifferences(ledger,archive,logId,actorIds){
  const selected=actorIds&&new Set(actorIds);
  const latest=new Map();
  for(const event of ledger.eventProgress||[])for(const node of event.nodes||[])for(const source of node.contributions||[]){
    if(selected&&!selected.has(source.actorId))continue;
    if(source.status!=='applied'||!source.actorId||!source.productBaseline)continue;
    const previous=latest.get(source.actorId);
    if(!previous||source.at>=previous.at)latest.set(source.actorId,source);
  }
  const differences=(ledger.prebuiltActorDifferences||[]).filter(row=>selected&&!selected.has(row.actorId));
  const tools=ceBridgeCore()['canon-event-details'];
  for(const [actorId,source] of latest){
    const actual=frCanonStoredActorRow(archive,actorId);
    if(!actual)continue;
    let fields;
    try{fields=tools.prebuiltActorDifferences(source.productBaseline,frCanonSourceRow(actual));}
    catch(error){console.warn('[原著补演] 无法核对人物成品差异：'+source.name,error.message);continue;}
    if(fields.length)differences.push({actorId,name:source.name,eventId:source.eventId,nodeId:source.nodeId,sourceId:source.sourceId,logId,fields});
  }
  if(differences.length)ledger.prebuiltActorDifferences=differences;
  else delete ledger.prebuiltActorDifferences;
}

function frCreateCanonCharacterPipeline(input){
  var controller=new AbortController(),jobs=[],scheduled=new Set(),setup=null,planned=[],fingerprints={},saved={},commitTail=Promise.resolve();

  var forward=function(){controller.abort(input.signal.reason);};if(input.signal){if(input.signal.aborted)forward();else input.signal.addEventListener('abort',forward,{once:true});}
  if(typeof frCanonTraceLinkSignal==='function')frCanonTraceLinkSignal(input.signal,controller.signal);
  var detach=function(){if(input.signal)input.signal.removeEventListener('abort',forward);};
  var progress=function(){var run=typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(controller.signal):null;if(run&& typeof frCanonTraceEvent==='function')frCanonTraceEvent(run,'progress','人物保存进度',{actorProgress:{total:scheduled.size,saved:Object.keys(saved).length}});};
  var ensureTargets=function(packet){
    if(!setup)setup=(input.resolvedTargets?Promise.resolve(input.resolvedTargets):frResolveCanonTargets({...input,signal:controller.signal,canonReferences:packet.canonReferences||{},biography:{},blocks:(packet.names||(packet.blocks||[]).map(b=>b.name)).map(name=>({name:name,body:''}))})).then(function(targets){planned=targets;return targets;});
    return setup;
  };
  var api={
    enqueue:function enqueuePacket(packet){
      var blocks=(packet.blocks || []).filter(function(block){
        if(scheduled.has(block.name))return false;
        var prior=Object.values(input.boundary?.actorCommits||{}).find(receipt=>receipt.name===block.name&&receipt.status==='saved'&&receipt.body===String(block.body||''));
        if(!prior)return true;
        scheduled.add(block.name);saved[block.name]=prior;fingerprints[block.name]=prior.body;
        var run=typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(controller.signal):null;
        if(run&&typeof frCanonTracePublish==='function')frCanonTracePublish(run,'人物变量 · '+block.name,{kind:'characters',...prior,status:'saved',reason:'沿用本轮已保存结果'});
        return false;
      });progress();if(!blocks.length)return Promise.resolve([]);
      ensureTargets(packet);
      var crossEvent=typeof ceBridgeCore==='function'&&ceBridgeCore()['canon-event-details']?.ordinaryCrossEvent;
      if(crossEvent&&blocks.some(crossEvent)){
        var eventBlocks=blocks.filter(block=>crossEvent(block)||block.eventWindows?.length), rest=blocks.filter(block=>!eventBlocks.includes(block));
        for(var block of eventBlocks){scheduled.add(block.name);fingerprints[block.name]=String(block.body||'');}
        progress();
        var eventJob=setup.then(async function(targets){
          var names=new Set(eventBlocks.map(block=>block.name));
          var src={...input,actorOnly:true,signal:controller.signal,settlementBase:input.boundary?.settlementBase,blocks:eventBlocks,
            timelineSource:input.timelineSource||input.traceRun?._timelineSource,
            biography:Object.fromEntries(Object.entries(packet.biography||{}).filter(([name])=>names.has(name))),canonReferences:packet.canonReferences||{}};
          var selected=targets.filter(target=>names.has(target.name)).map(function(row){
            var target=structuredClone(row),reference=src.canonReferences[target.name];
            if(target.canonNeedsProfile)target.canonProfileInstruction=frBuildCanonNpcProfileInstruction(target,{content:[reference?.setting,reference?.biography,reference?.timeline].filter(Boolean).join('\n')},src)+(reference?'\n'+frBuildCanonReferenceInstruction(reference):'');
            return target;
          });
          if(selected.length!==names.size)throw new Error('逐事件结算缺少唯一人物档案');
          var proposal=await frPrepareCanonOrdinaryEventBatch(src,selected);
          if(typeof input.awaitCommitBoundary==='function'){await input.awaitCommitBoundary(src);frAssertCanonInput(src);}
          var failures=[];
          for(var group of frCanonEventProposalGroups(proposal)){
            const groupNames=new Set(group.targets.map(target=>target.name));
            const groupBlocks=eventBlocks.filter(block=>groupNames.has(block.name));
            const groupBiography=Object.fromEntries(Object.entries(src.biography).filter(([name])=>groupNames.has(name)));
            const receipts=group.targets.map(target=>frCanonActorReceipt(input.boundary,target,groupBlocks.find(block=>block.name===target.name),groupBiography));
            const commit=commitTail.then(()=>{
              if([...groupNames].some(name=>eventJob.invalidatedNames.has(name)))throw new Error('逐事件人物依据已更新，须从新正文继续');
              return frCommitCanonProposal({...src,blocks:groupBlocks,biography:groupBiography,actorReceipts:receipts},group);
            });
            commitTail=commit.catch(function(){});
            try{
              var result=await commit;
              for(var receipt of Object.values(result.actorReceipts))saved[receipt.name]=receipt;
              progress();
            }catch(error){
              if(![...groupNames].every(name=>eventJob.invalidatedNames.has(name)))failures.push(error);
            }
          }
          if(failures.length)throw failures[0];
          return {ok:true,targets:selected,results:[]};
        }).catch(error=>({ok:false,error}));
        eventJob.canonActorNames=eventBlocks.map(block=>block.name);
        eventJob.invalidatedNames=new Set();
        jobs.push(eventJob);
        return rest.length?Promise.all([eventJob,enqueuePacket({...packet,blocks:rest})]):Promise.all([eventJob]);
      }
      // 同一就绪故事包沿原执行器合批生成提案；提交仍逐人隔离。
      var batchPreparation=blocks.length>1?setup.then(async function(targets){
        var batchSrc={...input,settlementBase:input.boundary?.settlementBase,signal:controller.signal,blocks:blocks,biography:packet.biography || {},canonReferences:packet.canonReferences || {},actorOnly:true};
        frAssertCanonInput(batchSrc);
        var selected=targets.filter(function(target){return blocks.some(function(block){return block.name===target.name;})&&!input.boundary?.actorCommits?.[target.id];}).map(function(row){
          var target=structuredClone(row),reference=batchSrc.canonReferences[target.name],block=blocks.find(block=>block.name===target.name);
          if(block?.handoffDeclared&&!frCanonHasVariableFront(block)){if(target.canonNew)throw new Error('普通阶段尚未建立此交汇人物，不能借只读末段新建全人物：'+target.name);target.canonNeedsProfile=false;}
          if(target.canonNeedsProfile)target.canonProfileInstruction=frBuildCanonNpcProfileInstruction(target,{content:[reference?.setting,reference?.biography,reference?.timeline].filter(Boolean).join('\n')},batchSrc)+(reference?'\n'+frBuildCanonReferenceInstruction(reference):'');
          return target;
        });
        var text=frCanonVariableText(blocks,''),context={...(input.sharedContext || {}),storyText:text,userInput:'仅按各人已核验的正文转换变量。从各人轮前档案出发，按日期逐段继承叠加，后段使用前段终态。',canonProseOnly:true,originalTimelinePhaseReuseEnabled:false,originalTimelinePacket:null,originalTimelinePackets:[],originalTimelineEvents:'',originalTimelineRawBlock:'',originalTimelineDigest:'',worldTimelineContext:'',originalTimelineReplayStoryText:'',originalTimelineItemText:'',originalTimelineMiscText:''};
        if(typeof frCanonCompletionTools==='function'){batchSrc.canonCompletionContext=frCanonCompletionTools().context(batchSrc,selected);context.canonCompletionContext=batchSrc.canonCompletionContext;}
        if(typeof frCanonSettlementInstruction==='function')context.userInput+=frCanonSettlementInstruction(batchSrc.settlementBase,selected);
        var requested=selected.filter(function(target){return target.canonNeedsProfile||blocks.some(function(block){return block.name===target.name&&(block.handoffDeclared?frCanonHasVariableFront(block):frCanonVariableBody(block));});});
        context.canonProseBlocks=batchSrc.blocks;
        var results=requested.length?await executeConcurrentRequests({targets:requested,preset:frCloneCanonPreset(input.preset),config:input.config,sharedContext:context,signal:controller.signal}):[];
        frAssertCanonInput(batchSrc);
        var byName={};
        selected.forEach(function(target){
          var found=(results || []).filter(function(result){return result?.target?.id===target.id;});
          var result=found.length===1?found[0]:requested.some(function(row){return row.id===target.id;})?{target:target,success:false,error:'本批缺少唯一人物提案：'+target.name}:{target:target,success:true,emptyUpstore:true,delta:[]};
          if(result.success===true&&(result.error||result.parseErrors?.length||(!Array.isArray(result.delta)&&!result.emptyUpstore)||(result.delta || []).some(function(op){return String(op.id||op.data?.['0']||target.id)!==target.id;})))result={target:target,success:false,error:'人物批提案未通过本人指令检查：'+target.name};
          byName[target.name]={result:result};
        });
        var successful=selected.filter(function(target){return byName[target.name].result.success===true;}),delta=successful.flatMap(function(target){return byName[target.name].result.delta || [];});
        if(!successful.length)return byName;
        var preview=ceBuildOriginalTimelinePostCharacterPreviewTargets(successful,delta),validNames=new Set(successful.map(function(target){return target.name;}));
        batchSrc.blocks=blocks.filter(function(block){return validNames.has(block.name);});
        var item,atomicItemBatch=typeof context._frCanonMergedItemsResponse==='string'||context._frCanonMergedFallback===true;
        try{
          item=await requestItemManagementPhase({preset:frCloneCanonPreset(input.preset),config:input.config,signal:controller.signal,currentTime:context.currentTime,currentLocation:context.currentLocation,userInput:context.userInput,storyText:frCanonVariableText(batchSrc.blocks,''),evolutionTargets:preview,canonParticipantIds:preview.map(function(target){return target.id;}),canonCompletionContext:typeof frCanonCompletionTools==='function'?frCanonCompletionTools().context(batchSrc,preview):undefined,proposalOnly:true,...(typeof context._frCanonMergedItemsResponse==='string'?{precomputedResponse:context._frCanonMergedItemsResponse}:{})});
          frAssertCanonInput(batchSrc);
        }catch(error){if(controller.signal.aborted||atomicItemBatch)throw error;return byName;}
        if(!item||item.error||item.skipped||item.proposalOnly!==true||!Array.isArray(item.operations)){if(atomicItemBatch)throw new Error(item?.error||'补演物品提案未通过校验');return byName;}
        var ids=new Set(successful.map(function(target){return target.id;})),owners=function(op){return Array.from(new Set([op.owner,op.from,op.to].filter(Boolean).map(String)));};
        if(atomicItemBatch){
          // 有转交关系的人同一事务结算，操作只应用一次；无关联人物仍逐人提交。
          frCanonItemComponents(Array.from(ids),item.operations).forEach(function(component){
            var componentIds=new Set(component),componentTargets=successful.filter(target=>componentIds.has(target.id));
            var ownItems={...item,operations:item.operations.filter(op=>owners(op).every(id=>componentIds.has(id))),completion:Object.fromEntries(Object.entries(item.completion||{}).filter(([id])=>componentIds.has(id)))};
            if(component.length===1){byName[componentTargets[0].name].items=ownItems;return;}
            var group={targets:componentTargets,results:componentTargets.map(target=>byName[target.name].result),items:ownItems,blocks:blocks.filter(block=>componentTargets.some(target=>target.name===block.name)),packet:packet,promise:null};
            componentTargets.forEach(target=>{byName[target.name].joint=group;});
          });
          return byName;
        }
        // 共同转交、共享资源或未知归属交原逐人结算与回执复核，不拆分同一操作。
        if(item.operations.some(function(op){var touched=owners(op);return touched.length!==1||!ids.has(touched[0]);}))return byName;
        successful.forEach(function(target){byName[target.name].items={...item,operations:item.operations.filter(function(op){return owners(op)[0]===target.id;}),completion:item.completion&&Object.hasOwn(item.completion,target.id)?{[target.id]:item.completion[target.id]}:{}};});
        return byName;
      }).catch(function(error){return {batchError:error};}):null;
      var currentJobs=blocks.map(function(block){
      scheduled.add(block.name);fingerprints[block.name]=String(block.body || '');
      progress();
      var actorController=new AbortController(),actorForward=function(){actorController.abort(controller.signal.reason);};
      if(controller.signal.aborted)actorForward();else controller.signal.addEventListener('abort',actorForward,{once:true});
      if(typeof frCanonTraceLinkSignal==='function')frCanonTraceLinkSignal(controller.signal,actorController.signal,{stageKey:'characters',subject:block.name,targetId:'',targetIds:[]});
      var biography=Object.prototype.hasOwnProperty.call(packet.biography || {},block.name)?{[block.name]:packet.biography[block.name]}:{};
      var src={...input,settlementBase:input.boundary?.settlementBase,signal:actorController.signal,timelineSource:input.timelineSource || input.traceRun?._timelineSource,canonReferences:packet.canonReferences || {},biography:biography,blocks:[block],actorOnly:true};
      var publish=function(status,reason,receipt){var run=typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(controller.signal):null;if(run && typeof frCanonTracePublish==='function')frCanonTracePublish(run,'人物变量 · '+block.name,{kind:'characters',name:block.name,status:status,reason:String(reason || ''),...(receipt || {})});};
      publish('preparing');
      var job=setup.then(async function(targets){
        frAssertCanonInput(src);
        var selected=targets.filter(function(t){return block.name===t.name;}).map(function(t){
          var target=structuredClone(t),reference=src.canonReferences[target.name];
          if(block.handoffDeclared&&!frCanonHasVariableFront(block)){if(target.canonNew)throw new Error('普通阶段尚未建立此交汇人物，不能借只读末段新建全人物：'+target.name);target.canonNeedsProfile=false;}
          if(target.canonNeedsProfile)target.canonProfileInstruction=frBuildCanonNpcProfileInstruction(target,{content:[reference?.setting,reference?.biography,reference?.timeline].filter(Boolean).join('\n')},src)+(reference?'\n'+frBuildCanonReferenceInstruction(reference):'');
          return target;
        });
        if(selected.length!==1)throw new Error('人物立即保存缺少唯一目标：'+block.name);
        var target=selected[0],body=String(block.body || '');
        if(typeof frCanonTraceTag==='function')frCanonTraceTag(src.signal,'characters',block.name,target.id);
        var actorReceipt=frCanonActorReceipt(input.boundary,target,block,biography);
        var previous=input.boundary?.actorCommits?.[target.id];
        if(previous){if(previous.body!==body)throw new Error('该人物本轮正文已经保存，请从原检查点重跑后替换：'+target.name);saved[target.name]=previous;publish('saved','复用本楼层已保存人物回执',previous);progress();return {ok:true,results:[],targets:selected,receipt:previous};}
        var variableBody=frCanonVariableBody(block);
        var text=variableBody?'## '+(block.eventIds || []).join(',')+' | '+block.name+' | '+block.status+'\n'+variableBody:'';
        var context={...(src.sharedContext || {}),storyText:text,userInput:'仅转换本批已通过验收的人物正文，不重新推演剧情。',canonProseOnly:true,originalTimelinePhaseReuseEnabled:false,originalTimelinePacket:null,originalTimelinePackets:[],originalTimelineEvents:'',originalTimelineRawBlock:'',originalTimelineDigest:'',worldTimelineContext:'',originalTimelineReplayStoryText:'',originalTimelineItemText:'',originalTimelineMiscText:''};
        var preparedBatch=batchPreparation?await batchPreparation:null;
        // 批量准备整批失败（如接口报错）时不能直接抛错拖垮全部人物：
        // 那个人自己会走下面逐人路径重跑一次，成功的人继续用已有结果。
        // 只有该批根本没有产出（无法降级）时才把错误抛出去。
        if(preparedBatch&&preparedBatch.batchError&&!preparedBatch[block.name])throw preparedBatch.batchError;
        var ownBatch=preparedBatch?preparedBatch[block.name]:null;
        if(ownBatch?.joint){
          var group=ownBatch.joint;
          if(!group.promise)group.promise=(async function(){
            var groupNames=new Set(group.targets.map(row=>row.name)),groupSrc={...input,actorOnly:true,signal:controller.signal,settlementBase:input.boundary?.settlementBase,blocks:group.blocks,biography:Object.fromEntries(Object.entries(group.packet.biography||{}).filter(([name])=>groupNames.has(name))),canonReferences:group.packet.canonReferences||{},preparedCharacters:{targets:group.targets,results:group.results,fingerprints:Object.fromEntries(group.blocks.map(row=>[row.name,String(row.body||'')]))},preparedItems:group.items};
            var proposal=await frPrepareCanonProposal(groupSrc);proposal.biographyCompression=await frPrepareCanonBiographyCompression(groupSrc,proposal);
            if(typeof input.awaitCommitBoundary==='function'){await input.awaitCommitBoundary(groupSrc);frAssertCanonInput(groupSrc);groupSrc.settlementBase=input.boundary?.settlementBase;if(!input.trustedBoundary&&!proposal.settlementReview)proposal=await frReviewCanonSettlement(groupSrc,proposal);}
            var receipts=group.targets.map(row=>({...frCanonActorReceipt(input.boundary,row,group.blocks.find(block=>block.name===row.name),groupSrc.biography),completion:proposal.completion?.[row.id]||null}));
            var commit=commitTail.then(function(){frAssertCanonInput(groupSrc);return frCommitCanonProposal({...groupSrc,actorReceipts:receipts},proposal);});commitTail=commit.catch(function(){});return commit;
          })();
          var grouped=await group.promise,receipt=grouped.actorReceipts?.[target.id];
          if(!receipt)throw new Error('共同转交结算缺少人物回执：'+target.name);
          saved[target.name]=receipt;publish('saved','共同物品已原子结算',receipt);progress();return {ok:true,results:[ownBatch.result],targets:selected,receipt:receipt};
        }
        if(typeof frCanonCompletionTools==='function'){src.canonCompletionContext=frCanonCompletionTools().context(src,selected);context.canonCompletionContext=src.canonCompletionContext;}
        var results=ownBatch?[ownBatch.result]:(block.handoffDeclared?frCanonVariableBody(block):text)||target.canonNeedsProfile?await executeConcurrentRequests({targets:selected,preset:frCloneCanonPreset(src.preset),config:src.config,sharedContext:context,signal:src.signal}):[];
        if(ownBatch?.items)src.preparedItems=ownBatch.items;
        src.proseText=text;
        src.preparedCharacters={targets:selected,results:results,fingerprints:{[block.name]:body}};
        if(results.length===1&&typeof results[0].mergedItemResponse==='string')src.precomputedItemResponse=results[0].mergedItemResponse;
        var proposal=await frPrepareCanonProposal(src);
        actorReceipt.completion=proposal.completion?.[target.id]||null;
        proposal.biographyCompression=await frPrepareCanonBiographyCompression(src,proposal);
        // 独立已建档人物可先转换提案；普通保存结束后才接续真实快照与成功回执。
        if(typeof input.awaitCommitBoundary==='function'){
          await input.awaitCommitBoundary(src);frAssertCanonInput(src);
          src.settlementBase=input.boundary?.settlementBase;
          if(!input.trustedBoundary&&!proposal.settlementReview)proposal=await frReviewCanonSettlement(src,proposal);
        }
        // 模型全部在事务外并行；共享存档的确定性事务依次接续最新成功边界。
        var committed;
        var commit=commitTail.then(async function(){
          frAssertCanonInput(src);
          var result=await frCommitCanonProposal({...src,actorReceipt:actorReceipt},proposal);
          saved[target.name]=result.actorReceipt;publish('saved','',result.actorReceipt);progress();return result;
        });
        commitTail=commit.catch(function(){});committed=await commit;
        return {ok:true,results:results,targets:selected,receipt:committed.actorReceipt};
      }).catch(function(error){publish(error.name==='AbortError'?'cancelled':'error',error.message,{completion:error.completion?.[planned.find(row=>row.name===block.name)?.id]||null});return {ok:false,error:error};}).finally(function(){controller.signal.removeEventListener('abort',actorForward);});
      job.canonActorName=block.name;jobs.push(job);
      return job;
      });
      return Promise.all(currentJobs);
    },
    invalidate:function(names){
      var removed=new Set(names||[]);
      for(var job of jobs)for(var name of job.canonActorNames||[])if(removed.has(name))job.invalidatedNames.add(name);
      jobs=jobs.filter(job=>!removed.has(job.canonActorName)&&!job.canonActorNames?.every(name=>removed.has(name)));
      removed.forEach(name=>{scheduled.delete(name);delete fingerprints[name];delete saved[name];});
      setup=null;planned=[];
    },
    finish:async function(){try{if(!setup)return Object.keys(saved).length?{targets:input.resolvedTargets||[],results:[],fingerprints:fingerprints,saved:saved}:null;var batches=await Promise.all(jobs),bad=batches.find(function(b){return !b.ok;});if(bad)throw bad.error;return {targets:planned,results:batches.flatMap(function(b){return b.results || [];}),fingerprints:fingerprints,saved:saved};}finally{detach();}},
    stop:async function(){controller.abort();await Promise.all(jobs);detach();}
  };
  if(frCanonUseMergedVariables(input)){
    // 正文生成器会await enqueue：普通人物必须先确认收件，不能等finish才resolve而死锁。
    // 收齐本轮普通正文后一次转换变量；核心/玩家指定独立人物仍可先行，不改正文分组。
    var deferred=new Map(),registrations=[],deliveries=[],enqueueMergedNow=api.enqueue,finishMergedNow=api.finish,stopMergedNow=api.stop,invalidateMergedNow=api.invalidate,flushMergedPromise=null;
    api.enqueue=function(packet){var registered=(async function(){
      if(controller.signal.aborted)throw Object.assign(new Error('已取消补演变量'),{name:'AbortError'});
      if(flushMergedPromise)throw new Error('本轮变量已经收尾，不能向旧批次追加故事');
      var targets=await ensureTargets(packet),separate=[],explicit=new Set(input.config?.mergedIndependentTargetIds||[]);
      if(controller.signal.aborted)throw Object.assign(new Error('已取消补演变量'),{name:'AbortError'});
      for(var block of packet.blocks||[]){
        var target=targets.find(row=>row.name===block.name);
        if(!target)throw new Error('变量合并缺少已定位人物：'+block.name);
        var cross=typeof ceBridgeCore==='function'&&ceBridgeCore()['canon-event-details']?.ordinaryCrossEvent?.(block);
        if(explicit.has(target.id)||target.castTier==='core'&&!cross)separate.push(block);
        else if(!scheduled.has(block.name)&&!deferred.has(block.name))deferred.set(block.name,{block:block,packet:packet});
      }
      return separate;
    })();registrations.push(registered);
      var delivery=registered.then(async separate=>(await Promise.all(separate.map(block=>enqueueMergedNow({...packet,blocks:[block]})))).flat());
      deliveries.push(delivery);delivery.catch(function(){});return delivery;
    };
    api.invalidate=function(names){for(var name of names||[])deferred.delete(name);invalidateMergedNow(names);};
    api.finish=async function(){
      if(!flushMergedPromise)flushMergedPromise=(async function(){
        // 等姓名/归属登记完成即可合批，不把核心人物的模型与提交完成当作普通人物的输入。
        await Promise.all(registrations);
        var rows=Array.from(deferred.values());deferred.clear();
        if(rows.length&&!controller.signal.aborted){var packet={blocks:rows.map(row=>row.block),names:planned.map(row=>row.name),biography:{},canonReferences:{}};rows.forEach(row=>{Object.assign(packet.biography,row.packet.biography||{});Object.assign(packet.canonReferences,row.packet.canonReferences||{});});await enqueueMergedNow(packet);}
        await Promise.all(deliveries);
      })();
      try{await flushMergedPromise;return await finishMergedNow();}finally{detach();}
    };
    api.stop=async function(){deferred.clear();controller.abort();return stopMergedNow();};
    return api;
  }
  // 只收集已就绪的单人结果，短窗口到点立即下送，不等待尚未写完的NPC。
  var wait=Number(input.config?.readyBatchWaitMs),pending=[],timer=null,enqueueNow=api.enqueue,finishNow=api.finish,stopNow=api.stop;
  wait=Number.isFinite(wait)?Math.max(0,Math.min(200,wait)):0;
  var flush=async function(){
    if(timer!==null){clearTimeout(timer);timer=null;}
    var batch=pending.splice(0);if(!batch.length)return;
    if(controller.signal.aborted){batch.forEach(row=>row.reject(Object.assign(new Error('已取消就绪合批'),{name:'AbortError'})));return;}
    var merged={blocks:[],names:[],biography:{},canonReferences:{}};
    batch.forEach(row=>{merged.blocks.push(...row.packet.blocks||[]);merged.names.push(...row.packet.names||[]);Object.assign(merged.biography,row.packet.biography||{});Object.assign(merged.canonReferences,row.packet.canonReferences||{});});
    merged.names=Array.from(new Set(merged.names));
    try{var result=await enqueueNow(merged);batch.forEach(row=>row.resolve(result));}catch(error){batch.forEach(row=>row.reject(error));}
  };
  if(wait>0)api.enqueue=function(packet){if((packet?.blocks||[]).length!==1)return enqueueNow(packet);return new Promise(function(resolve,reject){pending.push({packet,resolve,reject});if(timer===null)timer=setTimeout(flush,wait);});};
  api.finish=async function(){await flush();return finishNow();};
  api.stop=async function(){controller.abort();await flush();return stopNow();};
  controller.signal.addEventListener('abort',function(){if(timer!==null){clearTimeout(timer);timer=null;}pending.splice(0).forEach(row=>row.reject(Object.assign(new Error('已取消就绪合批'),{name:'AbortError'})));},{once:true});
  return api;
}

function frCanonVariableBody(block){
  if(block&& block.handoffDeclared){
    /* 2026-11-02 玩家报：补演卡在「交汇段尚未核验，不能进入变量解析」，
     * 只能点「继续本轮补演」，但重试还是同一条错，永远过不去。
     *
     * 原来是这么写的：
     *     if(!block.handoffReview||typeof block.variableBody!=='string')throw ...
     *
     * 这条把两件不同的事绑死了：
     *   · variableBody  = @@交汇开始 **之前**那一段，本来就是拿来解析变量的
     *   · handoffReview = AI 对交汇**末段**有没有漏原著道具的核验结论
     * 前者缺了确实不能解析（会误碰只读末段），后者缺了只是少了「AI 认定的
     * 漏项补录」，前面那段照样该正常落实变量。
     *
     * 玩家早前定的原则：「小错自己针对性重试补足，别让小的拦住整个流程」。
     * 所以这里改成降级而不是抛错：能解析的就解析，缺的漏项补录就不加。
     *
     * variableBody 万一也没带上，就从 body 里按同一个标记自己切一段——
     * 只取 @@交汇开始 之前的，绝不碰只读末段。
     */
    var front=typeof block.variableBody==='string'
      ? block.variableBody
      : String(block.body||'').split(/^\s*@@交汇开始\s*$/m)[0];
    front=String(front||'').trim();
    if(!front)return '';            // 前面确实没有可解析内容，交给上层按空处理
    var missing=block.handoffReview&&block.handoffReview.policy==='read_only_terminal'?block.handoffReview.missingCanonItems||[]:[];
    return [front,missing.length?'【AI确认普通阶段遗漏的原著道具，仅补以下漏项；不得再次解析交汇末段其他变化】\n'+missing.map(item=>item.text).join('\n'):''].filter(Boolean).join('\n\n');
  }
  return String(block?.body||'').trim();
}
function frCanonVariableText(blocks,fallback){
  if(!(blocks||[]).some(block=>typeof block.body==='string'))return String(fallback||'').trim();
  return (blocks||[]).map(block=>{var body=frCanonVariableBody(block);return body?'## '+(block.eventIds||[]).join(',')+' | '+block.name+' | '+(block.status||'变异')+'\n'+body:'';}).filter(Boolean).join('\n\n');
}
/* 交汇人物的「前面有没有可解析内容」统一判断。
 *
 * 原来到处直接写 `String(block.variableBody||'').trim()`，
 * 一旦 variableBody 没带上（交汇核验没返回时就会这样），
 * 这个人物会被**静默跳过**，玩家只看到流程卡住、不知道少了谁。
 * 现在统一走 frCanonVariableBody：它会自己从 body 切出 @@交汇开始 之前那段。
 */
function frCanonHasVariableFront(block){
  try{return !!frCanonVariableBody(block);}catch(_){return false;}
}

// 补缺只能追加真正新操作，不能重新创建此前有效提案中的同一实体。
function frBuildCanonItemRepair(missing,context,operations){
  var ids=new Set(missing.map(row=>String(row.id)));
  return {actors:missing.map(row=>{
    var facts=context.byTargetId[row.id]?.review?.facts||[];
    return {id:String(row.id),name:row.name,facts:row.missingFactIndexes.map((index,i)=>({...facts[index],index,issue:row.missing[i]}))};
  }),previousOperations:(operations||[]).filter(op=>[op.owner,op.from,op.to].some(id=>ids.has(String(id||''))))};
}
function frMergeCanonItemRepairReports(previous,patch,plan){
  var reports={...previous};
  for(var actor of plan.actors){
    var next=patch?.[actor.id],before=reports[actor.id];
    if(!Array.isArray(next?.facts))continue;
    var allowed=new Set(actor.facts.map(fact=>fact.index));
    var facts=new Map((Array.isArray(before?.facts)?before.facts:[]).map(row=>[Number(row.index),row]));
    for(var row of next.facts)if(row&&allowed.has(Number(row.index)))facts.set(Number(row.index),row);
    reports[actor.id]={...before,facts:Array.from(facts.values())};
  }
  return reports;
}

function frMergeCanonItemRepair(previous,patch,allowedIds){
  var out=structuredClone(previous||[]),id=item=>String(item?.['0']||item?.id||'');
  var stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  var signature=op=>{var {reason,...value}=op;return JSON.stringify(stable(value));},echoes=new Map();
  for(var op of previous||[]){var key=signature(op);echoes.set(key,(echoes.get(key)||0)+1);}
  for(var op of patch||[]){
    var key=signature(op),count=echoes.get(key)||0;
    // 补缺回显此前已确认的消耗/转移不能执行第二遍；原提案的真实多次操作完整保留。
    if(count){echoes.set(key,count-1);continue;}
    if(op.type==='createItem'&&id(op.item)){
      var old=out.find(row=>row.type==='createItem'&&String(row.owner)===String(op.owner)&&id(row.item)===id(op.item));
      if(old){
        var name=item=>String(item?.['1']||item?.name||'').replace(/<[^>]*>/g,'').trim();
        var type=item=>String(item?.['2']||item?.type||'').trim();
        if(name(old.item)!==name(op.item)||type(old.item)!==type(op.item))throw new Error('物品补缺同ID身份冲突：'+op.owner+'/'+id(op.item)+'；保留此前有效提案，不重新分配ID');
        continue; // 保留第一次的完整数据/数量，不让重复create覆盖为后续模型改稿。
      }
    }
    if(op.type==='equipItem'&&out.some(row=>row.type==='equipItem'&&row.owner===op.owner&&row.slot===op.slot&&row.itemId===op.itemId&&(row.index??row.slotIndex??null)===(op.index??op.slotIndex??null)&&JSON.stringify(row.data||null)===JSON.stringify(op.data||null)))continue;
    out.push(structuredClone(op));
  }
  if(allowedIds){var allowed=new Set(allowedIds);for(var op of out.slice((previous||[]).length)){var touched=[op.owner,op.from,op.to].filter(Boolean);if(!touched.length||touched.some(id=>!allowed.has(String(id))))throw new Error('物品补缺越过缺项人物');}}
  return out;
}

async function frPrepareCanonProposal(input) {
  var src = input || {};
  frAssertCanonInput(src);
  var preset = frCloneCanonPreset(src.preset);
  var prepared=src.preparedCharacters,saved=src.actorOnly?{}:prepared?.saved || {};
  var pendingBlocks=(src.blocks || []).filter(function(block){return !saved[block.name];});
  if(typeof ceBridgeCore==='function'&&pendingBlocks.some(block=>ceBridgeCore()['canon-event-details']?.ordinaryCrossEvent?.(block)))
    throw new Error('跨事件人物尚缺逐事件落地回执，请继续本轮人物变量结算');
  var text = frCanonVariableText(pendingBlocks,Object.keys(saved).length?'':src.proseText);
  var world = String(src.worldForMisc || '').trim();
  var base=src.settlementBase||src.boundary?.settlementBase;
  var finish=async function(proposal){
    var result=!src.trustedBoundary&&typeof frReviewCanonSettlement==='function'?await frReviewCanonSettlement({...src,settlementBase:base},proposal):proposal;
    var finalPreview=ceBuildOriginalTimelinePostCharacterPreviewTargets(result.targets||[],result.characterDelta||[]);frAssertCanonNpcProfiles(finalPreview);
    if(result.completionEvidence)for(var target of finalPreview){var review=result.completionEvidence.context.byTargetId[target.id]?.review;for(var phase of ['characters','items']){var checked=frCanonCompletionTools().check({target,facts:review?.facts,phase,report:result.completionEvidence[phase][target.id],operations:result.itemOperations||[],cultivation:phase==='characters'?review?.cultivation:null,baseline:review?.baseline});if(!checked.completed)throw Object.assign(new Error(target.name+'结算后本轮待补齐：'+checked.hardMissing.join('；')),{completion:{[target.id]:checked}});}}
    return result;
  };
  var context = {...(src.sharedContext || {}),storyText:text,userInput:'仅按本人正文已成立的事实转换变量。从轮前档案出发，按日期逐段继承叠加，后段使用前段终态。',
    canonProseOnly:true,originalTimelinePhaseReuseEnabled:false,originalTimelinePacket:null,originalTimelinePackets:[],
    originalTimelineEvents:'',originalTimelineRawBlock:'',originalTimelineDigest:'',worldTimelineContext:'',
    originalTimelineReplayStoryText:'',originalTimelineItemText:'',originalTimelineMiscText:'',canonProseBlocks:pendingBlocks};
  var names=new Set([...pendingBlocks.map(function(b){return b.name;}),...Object.keys(src.biography || {}).filter(function(name){return !saved[name];})]);
  var targets = prepared ? prepared.targets.filter(function(t){return names.has(t.name);}) : await frResolveCanonTargets(src);
  for(var target of targets){var scopeBlock=pendingBlocks.find(block=>block.name===target.name);if(scopeBlock?.handoffDeclared&&!String(scopeBlock.variableBody||'').trim()){if(target.canonNew)throw new Error('普通阶段尚未建立此交汇人物，不能借只读末段新建全人物：'+target.name);target.canonNeedsProfile=false;}}
  if(prepared)for(var block of (src.blocks || [])){if(prepared.fingerprints[block.name]!==String(block.body || ''))throw new Error('已准备人物正文发生变化，拒绝使用旧变量提案：'+block.name);}
  var historyOnly=!text && !world;
  if(historyOnly && targets.some(function(target){return target.canonNeedsProfile;})){
    context.storyText='【已确认历史经历，用于基础人物建档】\n'+Object.entries(src.biography || {}).map(function(entry){return entry[0]+'：\n'+entry[1];}).join('\n\n')+'\n仅建立必要人物基础档案，不将未通过的本轮NPC正文或待写缺口当成事实，不新增事件、物品或世界变化。';
  }
  if(typeof frCanonSettlementInstruction==='function')context.userInput+=frCanonSettlementInstruction(base,targets);
  var traceRun=src.signal&& typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(src.signal):null;
  if(traceRun)frCanonTraceEvent(traceRun,'stage','原执行器 · 人物变量转换',{targets:targets.map(function(t){return {id:t.id,name:t.name};})});
  var characterDelta = [];
  var completionTools=frCanonCompletionTools(),completionContext=completionTools.context(src,targets),characterReports={};
  context.canonCompletionContext=completionContext;
  var requestedNames = new Set(pendingBlocks.map(function(b) { return String(b.name || '').trim(); }));
  var requestTargets = targets.filter(function(t) { return requestedNames.has(t.name)&& pendingBlocks.some(block=>block.name===t.name&&(block.body==null?text:block.handoffDeclared?frCanonHasVariableFront(block):frCanonVariableBody(block))) || t.canonNeedsProfile; });
  if (requestTargets.length) {
    var results = prepared ? prepared.results.filter(function(result){return requestTargets.some(function(t){return t.id===result.target?.id;});}) : [];
    var remaining=requestTargets.filter(function(target){return !results.some(function(result){return result.target?.id===target.id;});});
    if(remaining.length)results=results.concat(await executeConcurrentRequests({targets:remaining,preset:preset,config:src.config,sharedContext:context,signal:src.signal}));
    if(traceRun)frCanonTraceEvent(traceRun,'parsed','人物提案与实际推理返回',results);
    frAssertCanonInput(src);
    if (!Array.isArray(results) || results.length !== requestTargets.length) throw new Error('人物提案数量不完整');
    for (var result of results) {
      if(result?.target?.id)characterReports[result.target.id]=result.completion||completionTools.read(result.response)[result.target.id]||null;
      if (!result || result.success !== true || result.error || (result.parseErrors && result.parseErrors.length)) {
        throw new Error('人物提案失败：' + String(result && (result.error || result.parseErrors) || '没有有效结果'));
      }
      if (!Array.isArray(result.delta) && result.emptyUpstore !== true) throw new Error('人物提案缺少合法指令块');
      for (var op of (result.delta || [])) {
        var targetId = String(op.id || (op.data && op.data['0']) || (result.target && result.target.id) || '').trim();
        if (!targets.some(function(t) { return t.id === targetId; })) throw new Error('人物提案越过本次目标：' + targetId);
        characterDelta.push(op);
      }
    }
  }
  var preview = ceBuildOriginalTimelinePostCharacterPreviewTargets(targets, characterDelta);
  var repairedCharacterInputs=false;
  var configured=src.config?.completionRepairCount??3,repairBudget=Math.max(0,Math.min(3,Math.floor(Number(configured)||0)));
  for(var attempt=0;attempt<repairBudget;attempt++){
    frAssertCanonInput(src);
    var incomplete=preview.filter(function(target){var review=completionContext.byTargetId[target.id]?.review;return ((target.canonNew||target.canonNeedsProfile)&&frCanonNpcProfileGaps(target.data,{complete:target.canonCheckComplete,tier:target.castTier}).length)||!completionTools.check({target,facts:review?.facts,phase:'characters',report:characterReports[target.id],cultivation:review?.cultivation,baseline:review?.baseline}).completed;});
    if(!incomplete.length)break;
    var repairs=incomplete.map(function(target){
      var review=completionContext.byTargetId[target.id]?.review;var gaps=((target.canonNew||target.canonNeedsProfile)?frCanonNpcProfileGaps(target.data,{complete:target.canonCheckComplete,tier:target.castTier}):[]).concat(completionTools.check({target,facts:review?.facts,phase:'characters',report:characterReports[target.id],cultivation:review?.cultivation,baseline:review?.baseline}).hardMissing),fields=new Set(['9']);if(review?.cultivation)fields.add('2');
      gaps.forEach(function(gap){var column=String(gap).match(/第(\d+)列/);if(column)fields.add(column[1]);if(/年龄|寿元|isBonded/.test(gap))fields.add('9');if(/属性|血量|法力/.test(gap))fields.add('11');if(/人物位置/.test(gap))fields.add('16');});
      // 必须把「允许补哪些列」写进指令：只说缺哪几项，模型不知道边界，容易越界改到已确认栏位。
      var allowedFields=Array.from(fields).sort(function(a,b){return Number(a)-Number(b);});
      return {...target,canonRepairFields:Array.from(fields),canonProfileInstruction:String(target.canonProfileInstruction||'')+'\n【本次档案缺项定点补全】\n只补此人未通过的栏位：'+gaps.join('；')+'。\n本次只允许写这些列：'+allowedFields.map(function(field){return '第'+field+'列';}).join('、')+'；其余列保留现状；多返回的旧字段将忽略，只应用本次补缺字段。\n当前快照已经包含上次有效提案，保留其他已确认字段，不重演正文、不增加物品或改变目标。优先依据本轮原著设定及实际经历补列，未明确的性格可依据原著行为作保守推断并说明依据；不可继续用未知、待补等占位词。只返回缺列的add/updateAttribute及对应缺失技能addSkill/词条addTrait指令和本次核对回执，保留其他数据；完整性校验仍会执行。'};
    });
    if(traceRun)frCanonTraceEvent(traceRun,'stage','原执行器 · 人物档案补全',{names:repairs.map(function(target){return target.name;}),attempt:attempt+1});
    var repaired=await executeConcurrentRequests({targets:repairs,preset:preset,config:src.config,sharedContext:{...context,canonCompletionContext:completionContext,userInput:'仅补本次列明的档案缺项，保留此前有效提案，不重新演化人物。'},signal:src.signal});
    frAssertCanonInput(src);
    if(!Array.isArray(repaired)||repaired.length!==repairs.length)throw new Error('人物档案补列返回数量不完整');
    var patch=[];
    for(var result of repaired){
      var target=repairs.find(function(row){return row.id===result?.target?.id;});
      if(target)characterReports[target.id]=result.completion||completionTools.read(result.response)[target.id]||characterReports[target.id];
      if(!target||result.success!==true||result.error||result.parseErrors?.length||!Array.isArray(result.delta))throw new Error('人物档案补列失败：'+String(result?.error||'没有完整有效的指令'));
      for(var op of result.delta){
        var id=String(op.id||op.data?.['0']||target.id);
        if(id!==target.id)continue;
        if(op.command==='add'&& op.data&& typeof op.data==='object'){
          // 定点补列只取所需字段；多返回的旧字段忽略，不推翻本次有效补缺。
          op={...op,data:Object.fromEntries(Object.entries(op.data).filter(function(pair){return pair[0]==='0'||target.canonRepairFields.includes(pair[0]);}))};
          if(!Object.keys(op.data).some(function(key){return key!=='0';}))continue;
        }else if(op.command==='updateAttribute'&& target.canonRepairFields.includes('11')){
          // 只允许缺失基础属性的原生定值指令，不额外演化其他属性。
        }else if(['addSkill','addTrait'].includes(op.command)&&target.canonRepairFields.includes('9')){
          // 原技能/词条补缺仍由原人物执行器写备注列。
        }else continue;
        patch.push(op);
      }
    }
    if(patch.length)repairedCharacterInputs=true;
    characterDelta=characterDelta.concat(patch);preview=ceBuildOriginalTimelinePostCharacterPreviewTargets(targets,characterDelta);
  }
  // 谁不合格就停谁，不连坐：把这些人物从本轮剔除，其余照常往下走。
  // 只有「一个人都不剩」才真的没法继续（那才抛）。
  // 用 allowSoft:true 明确要求「不连坐」；函数本身保持严格契约，测试直接调它时仍会抛。
  // 老调用方或测试桩可能不返回清单，那就当作「没有缺口」，保持向后兼容。
  var profileGate=frAssertCanonNpcProfiles(preview,{allowSoft:true}) || {};
  if(profileGate.failed && profileGate.failed.length){
    var failedNames=new Set(profileGate.failed.map(function(row){return row.name;}));
    preview=preview.filter(function(target){return !failedNames.has(target.name);});
    if(typeof frCanonRecordProfileGaps==='function')frCanonRecordProfileGaps(profileGate.failed.map(function(row){return {name:row.name,gaps:row.gaps.concat(row.soft||[])};}));
    // 全都不合格时，没有可保存的人物，这时确实只能停。
    // 文案沿用「XX人物档案不完整」，界面与既有契约测试都按这个识别。
    if(!preview.length)throw new Error(profileGate.failed.map(function(row){return row.name+'人物档案不完整：'+row.gaps.join('；');}).join(' / '));
  }
  var completion={};
  var completionFailed=[];
  for(var target of preview){
    var review=completionContext.byTargetId[target.id]?.review;
    var checked=completionTools.check({target,facts:review?.facts,phase:'characters',report:characterReports[target.id],cultivation:review?.cultivation,baseline:review?.baseline});
    completion[target.id]=checked;
    // 待补齐也只停这个人，不再整轮抛。
    if(!checked.completed)completionFailed.push({name:target.name,gaps:(checked.hardMissing||[]).slice()});
  }
  if(completionFailed.length){
    var failed2=new Set(completionFailed.map(function(row){return row.name;}));
    preview=preview.filter(function(target){return !failed2.has(target.name);});
    if(typeof frCanonRecordProfileGaps==='function')frCanonRecordProfileGaps(completionFailed);
    // 全都不合格时没有可保存的人物，只能停。文案要带上具体缺项（如「性格」占位），
    // 界面与既有契约测试都按这个识别。
    if(!preview.length)throw new Error(completionFailed.map(function(row){return row.name+'本轮待补齐：'+row.gaps.join('；');}).join(' / '));
  }
  if(historyOnly)return finish({targets:targets,characterDelta:characterDelta,itemOperations:[],miscDelta:[]});
  var common = {preset:preset,config:src.config,signal:src.signal,
    currentTime:context.currentTime,currentLocation:context.currentLocation,userInput:context.userInput};
  if(traceRun)frCanonTraceEvent(traceRun,'stage','原执行器 · 物品变量转换');
  var mergedItemResponse=src.precomputedItemResponse||context._frCanonMergedItemsResponse;
  var item = (!repairedCharacterInputs && src.preparedItems) || ((preview.length||text||(world&&!prepared?.fullySettled)) ? await requestItemManagementPhase({...common,storyText:text + '\n\n' + world,evolutionTargets:preview,canonParticipantIds:preview.map(function(target){return target.id;}),canonCompletionContext:completionTools.context(src,preview),proposalOnly:true,...(!repairedCharacterInputs&&typeof mergedItemResponse==='string'?{precomputedResponse:mergedItemResponse}:{})}) : {proposalOnly:true,skipped:false,operations:[],completion:{}});
  if(traceRun)frCanonTraceEvent(traceRun,'parsed','物品提案与实际推理返回',item);
  frAssertCanonInput(src);
  if (!item || item.error || item.skipped || item.proposalOnly !== true) throw new Error('物品提案失败：' + String(item && (item.error || item.reason) || '未返回提案'));
  var itemReports=item.completion||{};
  var inspectItems=function(){var missing=[];for(var target of preview){var review=completionContext.byTargetId[target.id]?.review;var result=completionTools.check({target,facts:review?.facts,phase:'items',report:itemReports[target.id],operations:item.operations||[],baseline:review?.baseline});completion[target.id]={...completion[target.id],phase:result.phase,completed:result.completed,hardMissing:result.hardMissing,softNotes:[...(completion[target.id]?.softNotes||[]),...result.softNotes]};if(!result.completed)missing.push({...target,missing:result.hardMissing,missingFactIndexes:result.missingFactIndexes});}return missing;};
  var itemMissing=inspectItems();
  for(var repair=0;itemMissing.length && repair<repairBudget;repair++){
    var repairIds=new Set(itemMissing.map(row=>row.id));
    var repairPlan=frBuildCanonItemRepair(itemMissing,completionContext,item.operations);
    var patch=await requestItemManagementPhase({...common,evolutionTargets:preview.filter(row=>repairIds.has(row.id)),canonParticipantIds:Array.from(repairIds),canonItemRepair:repairPlan,proposalOnly:true});
    frAssertCanonInput(src);if(patch.error||patch.skipped||patch.proposalOnly!==true)throw new Error('物品定点补缺失败：'+String(patch.error||patch.reason||'无有效返回'));
    item={...item,operations:frMergeCanonItemRepair(item.operations,patch.operations,repairIds)};itemReports=frMergeCanonItemRepairReports(itemReports,patch.completion,repairPlan);itemMissing=inspectItems();
  }
  if(itemMissing.length)throw Object.assign(new Error(itemMissing.map(row=>row.name+'本轮待补齐：'+row.missing.join('；')).join('\n')),{completion:completion});
  var completionEvidence={context:completionContext,characters:characterReports,items:itemReports};
  // 人物正文不能冒充世界块证据；全局杂项由真正世界块独立经过原权限检查。
  if(src.actorOnly)return finish({targets:targets,characterDelta:characterDelta,itemOperations:item.operations || [],completion:completion,completionEvidence:completionEvidence,miscDelta:[],thinking:{items:item.thinking}});
  if(!world){
    if(traceRun)frCanonTraceEvent(traceRun,'parsed','世界与杂项无需变更',{kind:'misc',noChanges:src.worldNoChanges || [],delta:[],reason:'没有已成立世界正文，个人经历已由人物与物品阶段处理'});
    return finish({targets:targets,characterDelta:characterDelta,itemOperations:item.operations || [],completion:completion,completionEvidence:completionEvidence,miscDelta:[],worldNoChanges:src.worldNoChanges || [],thinking:{items:item.thinking}});
  }
  if(traceRun)frCanonTraceEvent(traceRun,'stage','原执行器 · 世界与杂项转换');
  var misc = src.preparedMisc || await requestMiscEvolutionPhase({...common,sharedContext:{...context,worldEvents:typeof ceBridgeReadWorldEvents==='function'?ceBridgeReadWorldEvents():typeof currentState==='object'?JSON.stringify(currentState?.['5']||[]):context.worldEvents||'',canonWorldEvidence:world,storyText:world},storyText:world});
  if(traceRun)frCanonTraceEvent(traceRun,'parsed','世界提案与实际推理返回',misc);
  frAssertCanonInput(src);
  if (!misc || misc.error || misc.skipped || !Array.isArray(misc.delta)) throw new Error('杂项提案失败：' + String(misc && (misc.error || misc.reason) || '未返回指令'));
  var skippedMisc=new Set((misc.ruleSkips||[]).map(function(op){return JSON.stringify(op);}));
  var failedMisc=(misc.blockedOps||[]).filter(function(op){return !skippedMisc.has(JSON.stringify(op));});
  if (failedMisc.length) {
    var blocked=failedMisc.map(function(op) { var id=resolveConcurrentEvolutionOpId(op);var reason=typeof ceFormatOriginalTimelineBlockedReason==='function'?ceFormatOriginalTimelineBlockedReason(op.blockedReason):op.blockedReason;return String(op.command || '未知指令')+(id?'（'+id+'）':'')+'：'+String(reason || '超出本阶段允许范围'); });
    throw new Error('杂项提案未通过，账本未提交：'+blocked.join('；'));
  }
  if (misc.delta.some(function(op) { return ceIsOriginalTimelineProtectedMiscId(resolveConcurrentEvolutionOpId(op)); })) throw new Error('补演杂项越过前台受保护范围：时间地点、场景地图或玩家任务');
  return finish({targets:targets,characterDelta:characterDelta,itemOperations:item.operations || [],completion:completion,completionEvidence:completionEvidence,miscDelta:misc.delta,thinking:{items:item.thinking,misc:misc.thinking}});
}

async function frPrepareCanonBiographyCompression(input,proposal) {
  var src=input || {},run=src.signal && typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(src.signal):null;
  frAssertCanonInput(src);
  var rows=ceBuildOriginalTimelinePostCharacterPreviewTargets(proposal.targets || [],proposal.characterDelta || []);
  var latestDeeds={};
  rows.forEach(function(target){
    var extra=String(src.biography?.[target.name] || '').trim();
    if(extra){var patch={command:'add',data:{'35':extra}};if(mergeAppendBiographyForAdd(patch,target.data)!==false)target.data['35']=patch.data['35'];}
    latestDeeds[target.id]=ceSplitColumn35Entries(target.data['35']).slice(-1)[0] || '';
  });
  var targets=await ceCollectBiographyCompressionTargets({onlyProvided:true,rows:rows});
  function publish(status,data){if(run && typeof frCanonTracePublish==='function')frCanonTracePublish(run,'生平整理',{kind:'biographyCompression',status:status,...data});}
  if(!targets.size){publish('not_needed',{names:[],reason:'本轮生平未达到原压缩条件'});return {skipped:true,reason:'no_targets',updatedIds:[],updates:[]};}
  var names=Array.from(targets.values()).map(function(t){return t.name;});
  if (proposal.prebuiltReadback) {
    var core = ceBridgeCore()['canon-prebuilt'];
    var updates = Array.from(targets, ([id, target]) => {
      var sourceText = String(target.rawBiography || '');
      var result = core.findPrebuiltCharacterCompression(target.name, sourceText, String(target.rawBackground ?? ''), proposal.prebuiltBiography);
      if(!result)return null;
      var latest=String(latestDeeds[id] || '').trim();
      if(latest && !result.text.split(/\r?\n/).includes(latest))result.text+=(result.text?'\n':'')+latest;
      if(result.text.length+String(result.background ?? target.rawBackground ?? '').length>=sourceText.length+String(target.rawBackground ?? '').length)return null;
      return {id, sourceText, sourceBackground:String(target.rawBackground ?? ''), ...result};
    }).filter(Boolean);
    var pending = updates.length < targets.size;
    var reason = pending ? '部分经历没有相符的预制压缩稿，保留完整原文' : '沿用相符的预制压缩稿';
    publish(pending?'pending':'prepared',{names,reason,count:updates.length});
    return {skipped:!updates.length,status:pending?'pending':'prepared',reason,names,updatedIds:updates.map(row=>row.id),updates};
  }
  if(run)frCanonTraceEvent(run,'stage','生平压缩',{count:targets.size,names:names});publish('preparing',{names:names});
  try{
    var result=await runBiographyCompression({reason:'canon_finalize',silentStatus:true,targetsMap:targets,prepareOnly:true,strict:true,latestDeeds:latestDeeds,signal:src.signal,fallbackApi:src.config});
    frAssertCanonInput(src);
    if(!result || result.error || result.skipped || result.failedBatches?.length || result.updates?.length!==targets.size)throw new Error(result?.error || result?.reason || '未返回完整压缩结果');
    result.names=names;publish('prepared',{names:names,count:result.updatedIds.length});return result;
  }catch(error){
    frAssertCanonInput(src);
    // 压缩只是收尾整理。保留原始经历与已准备变量，不因整理失败撤销人物。
    var reason=String(error.message||error);publish('pending',{names:names,reason:reason});
    return {skipped:true,status:'pending',reason:reason,names:names,updatedIds:[],updates:[]};
  }
}

async function frCaptureCanonBoundary(logId) {
  var name = currentArchiveName;
  if (!name) throw new Error('原著补演没有可绑定的当前存档');
  var archive = await db.archives.get(name);
  if (!archive || !archive.data || !Array.isArray(archive.data.logs)) throw new Error('原著补演无法读取当前存档日志');
  var logs = archive.data.logs;
  var log = logId ? logs.find(function(l) { return l.id === logId; })
    : logs.slice().reverse().find(function(l) { return l.type === 'ai' && !l.isGhost && !l.isDeepSummary && !l.isSnapshot; });
  if (!log || log.type !== 'ai') throw new Error('原著补演缺少对应的正文楼层');
  if (currentArchiveName !== name) throw new Error('已切换存档');
  return {archiveName:name,logId:log.id,floorContent:log.content,archiveText:JSON.stringify(archive),stateText:JSON.stringify(currentState),
    receipt:log.canonTurnCommit || null,settlementBase:structuredClone(log.canonSettlementBase||null),actorCommits:structuredClone(log.canonActorCommits || {}),
    prebuiltCheckpoints:structuredClone(log.canonPrebuiltCheckpoints||{})};
}

async function frReviewCanonLedger(before,ledger,{signal,traceRun,extra}={}){
  const config=await ceBridgeLoadConfig();
  const host=ceBridgeHost(signal,traceRun);
  return ceBridgeCore().ledger.reviewCanonLedgerMutations({before,ledger,signal,extra,retry:config.retry,call:host.llmCall});
}

async function frPrepareCanonLedgerReview(plan,boundary,options){
  if(options.replay?.localOnly){
    const saved=options.replay.prebuiltState?.ledgerReview;
    if(saved)plan.next={...plan.next,mutationReview:saved.status,...(saved.notes?.length?{mutationNotes:saved.notes}:{})};
    return;
  }
  try{
    const review=await frReviewCanonLedger(JSON.parse(boundary.stateText).canonLedger,plan.next,options);
    plan.next={...review.ledger,mutationReview:{status:review.status}};
  }catch(error){
    options.signal?.throwIfAborted();
    plan.next={...plan.next,mutationReview:{status:'pending',reason:String(error.message||error)}};
  }
}

async function frReplaySavedCanonLedger(context,selection,archive){
  const name=context.archiveName,logId=String(context.logId),signal=selection.signal;
  const floor=frReplayLatestLog(archive),state=archive?.data?.state,ledger=state?.canonLedger;
  if(String(floor?.id)!==logId||!floor?.canonTurnCommit||!ledger||floor.canonTurnCommit.worldTime!==ledger.worldTime)
    throw new Error('本层还没有完整落地的账本。请先继续未完成的补演或预制成品落地。');
  const stamp=JSON.stringify(ledger),floorContent=floor.content,receiptId=floor.canonTurnCommit.id;
  const run=frCanonTraceHistory.findLast(row=>row.archiveName===name&&String(row.logId)===logId&&row.phase==='正文后补演');
  const previous=context.beforeArchive?.data?.state;
  let before=previous?.canonLedger||previous?.currentState?.canonLedger;
  if(!before||JSON.stringify(before)===stamp){
    const logs=archive.data.logs, prior=logs.slice(0,logs.indexOf(floor)).findLast(row=>row.canonTurnCommit?.stateText);
    if(prior)before=JSON.parse(prior.canonTurnCommit.stateText).canonLedger;
    else if(context.rebuiltAt)before={};
  }
  frReplaySetBusy('canon',true);
  try{
    const review=await frReviewCanonLedger(before,ledger,{signal,traceRun:run,extra:selection.extra});
    const next={...review.ledger,mutationReview:{status:review.status}};
    signal?.throwIfAborted();
    let saved;
    await db.transaction('rw',db.archives,async function(){
      signal?.throwIfAborted();
      const latest=await db.archives.get(name),row=frReplayLatestLog(latest),actual=latest?.data?.state;
      if(currentArchiveName!==name||String(row?.id)!==logId||row.content!==floorContent||row.canonTurnCommit?.id!==receiptId||JSON.stringify(actual?.canonLedger)!==stamp||JSON.stringify(currentState?.canonLedger)!==stamp)
        throw new Error('正文楼层或账本已变化，本次账本整理未写入。');
      const snapshot=JSON.parse(row.stateSnapshot),receiptState=JSON.parse(row.canonTurnCommit.stateText);
      if(JSON.stringify(snapshot.canonLedger)!==stamp||JSON.stringify(receiptState.canonLedger)!==stamp||JSON.stringify(actual.currentState?.canonLedger)!==stamp)
        throw new Error('账本副本未对齐，本次账本整理未写入。');
      actual.canonLedger=next;actual.currentState.canonLedger=next;snapshot.canonLedger=next;receiptState.canonLedger=next;
      row.stateSnapshot=JSON.stringify(snapshot);row.canonTurnCommit={...row.canonTurnCommit,stateText:JSON.stringify(receiptState)};
      await db.archives.put(latest);
      const readback=await db.archives.get(name),confirmed=frReplayLatestLog(readback),expected=JSON.stringify(next);
      signal?.throwIfAborted();
      if(currentArchiveName!==name||JSON.stringify(readback?.data?.state?.canonLedger)!==expected||JSON.stringify(JSON.parse(confirmed.stateSnapshot).canonLedger)!==expected)throw new Error('账本回读不一致');
      saved=readback;
    });
    if(currentArchiveName===name&&JSON.stringify(currentState?.canonLedger)===stamp){
      currentState.canonLedger=structuredClone(next);window._ceCanonLedgerSnapshot=structuredClone(next);
    }
    try{
      const baseKey='FR_REPLAY_BASE_V1:'+name+':canon',base=await dbGet(baseKey),memory=frTakeCanonMemory();
      if(String(base?.logId)===logId){
        const afterStamp=await frReplayStamp(saved,memory);
        await dbSet(baseKey,{...base,afterArchive:saved,afterMemory:memory,afterStamp,ledgerReplayError:''});
        const ceKey='FR_REPLAY_BASE_V1:'+name+':ce',ce=await dbGet(ceKey);
        if(String(ce?.logId)===logId&&ce.afterStamp===base.afterStamp)await dbSet(ceKey,{...ce,afterStamp});
      }
      if(run){
        for(const key of ['result','executionResult'])if(run[key])run[key]={...run[key],ledgerPlan:{...run[key].ledgerPlan,next},ledgerReplayError:''};
        const display=frCanonCurrentDisplays.get(name);
        if(run._currentDisplayRestored&&display?.runs?.[run.phase]?.id===run.id){
          display.runs[run.phase].result=run.result;
          await frCanonCurrentDisplayQueue(display,()=>dbSet(display.key,{logId,runs:display.runs}));
        }else await frCanonCurrentDisplaySave(run,true);
        frCanonTraceRenderSoon();
      }
    }catch(error){console.warn('[原著补演] 账本已保存，展示同步失败：',error);}
    const message=review.status==='done'?'账本变异记录已更新并保存。':'本轮无新增变异，账本已在本地核对并保存。';
    if(typeof showDanmaku==='function')showDanmaku(message,'success');
    return {status:'ok',landed:true,message};
  }catch(error){
    if(!signal?.aborted&&currentArchiveName===name){
      const key='FR_REPLAY_BASE_V1:'+name+':canon',base=await dbGet(key);
      if(String(base?.logId)===logId)await dbSet(key,{...base,ledgerReplayError:String(error.message||error)});
    }
    throw error;
  }finally{frReplaySetBusy('canon',false);}
}

async function frRunCanonVariableHandoff({options,boundary,result,pipeline,targetTime}){
  var handoff=result.variableHandoff,names=new Set(handoff.actors.map(row=>row.name)),plan=handoff.ledgerPlan;
  var prior=Object.values(boundary.actorCommits||{}),traceRun=options.traceRun;
  var exactSaved=(receipt,block)=>receipt?.status==='saved'&&receipt.name===block.name&&receipt.body===String(block.body||'');
  // This route recovers uncommitted variables. Replacing an already-applied actor needs a separate reversible delta.
  if(handoff.actors.some(actor=>prior.some(row=>row.name===actor.name||row.actorId===actor.id))){
    await pipeline.stop();
    throw new Error('所选人物已有本轮保存回执，不能在旧结果上重复应用人物或物品变量。');
  }
  var blocks=handoff.blocks.filter(block=>names.has(block.name)),biography={...handoff.biography};
  for(var block of blocks)if(!biography[block.name])biography[block.name]=String(block.handoffDeclared?block.variableBiographyLine||'':block.biographyLine||'');
  var ready,error;
  if(traceRun)frCanonTraceEvent(traceRun,'stage','更新人物与物品变量',{targets:handoff.actors.map(row=>row.name)});
  try{
    await pipeline.enqueue({blocks,names:blocks.map(row=>row.name),biography,canonReferences:handoff.canonReferences});
    ready=await pipeline.finish();
  }catch(failure){error=failure;await pipeline.stop();}
  frAssertCanonInput(options);
  var updated=await frCaptureCanonBoundary(boundary.logId),saved=Object.values(updated.actorCommits||{});
  var finished=handoff.actors.filter(actor=>exactSaved(updated.actorCommits?.[actor.id],blocks.find(block=>block.name===actor.name)));
  if(!finished.length)throw error||new Error('本次人物与物品变量没有通过实际落档复核。');
  var missing=handoff.actors.filter(actor=>!finished.includes(actor));
  var scopes=rows=>rows.flatMap(row=>['characters:'+row.id,'items:'+row.id]);
  var outcome={...result,variableHandoff:undefined,actorProgressSaved:true,replayCleared:{stages:[],scopes:scopes(finished)},failedScopes:scopes(missing),
    ledgerPlan:plan,biography,canonReferences:handoff.canonReferences,worldForMisc:handoff.worldForMisc,worldNoChanges:handoff.worldNoChanges};
  var allSaved=handoff.completeActorCoverage===true&&handoff.blocks.every(block=>saved.some(receipt=>exactSaved(receipt,block)));
  if(!missing.length&&allSaved&&!updated.settlementBase?.partial&&plan?.changed===true&&plan.next?.worldTime===targetTime){
    await frPrepareCanonLedgerReview(plan,updated,options);
    var commit=await ceApplyCanonProseToEvolution({sharedContext:options.sharedContext,config:options.config,preset:options.preset,
      prose:handoff.blocks,proseText:'',worldForMisc:handoff.worldForMisc,worldNoChanges:handoff.worldNoChanges,canonReferences:handoff.canonReferences,
      signal:options.signal,boundary:updated,ledger:plan.next,biography,preparedCharacters:{...ready,fullySettled:true,
        fingerprints:Object.fromEntries(handoff.blocks.map(row=>[row.name,String(row.body||'')])),
        saved:Object.fromEntries(saved.map(row=>[row.name,row]))},timelineSource:traceRun?._timelineSource,needsCommit:true});
    if(commit?.ok&&commit.committed)return {...outcome,landed:true,commit,ledgerPlan:{...plan,landed:true,next:commit.ledger||plan.next}};
    error=new Error(commit?.reason||'世界与账本未提交');
  }
  var reason=missing.length?'已保存 '+finished.length+' 人，仍有 '+missing.length+' 人的变量待处理'+(error?'：'+String(error.message):''):
    error?'人物与物品变量已保存；世界与账本待完成：'+String(error.message):
    allSaved?'人物与物品变量已保存；旧轮缺少可直接提交的账本计划，请继续本轮收尾。':'所选人物与物品变量已保存；其余未完成项目保留，账本未推进。';
  return {...outcome,status:'partial',landed:false,partial:true,landReason:reason,
    failedStages:allSaved&&!missing.length?['misc']:[]};
}

function frTakeCanonMemory() {
  var memory = {state:JSON.parse(JSON.stringify(currentState)),map:JSON.parse(JSON.stringify(WORLD_MAP_DATA)),
    bonded:JSON.parse(JSON.stringify(bondedCharacters)),windows:{},pending:_ceCanonLedgerPending};
  if(typeof frOrdinarySettlementPending!=='undefined')memory.ordinarySettlement=structuredClone(frOrdinarySettlementPending);
  if(typeof ceBridgeBeforeState!=='undefined')memory.bridgeBefore={rows:structuredClone(ceBridgeBeforeState),time:typeof ceBridgeBeforeTime==='string'?ceBridgeBeforeTime:'',archive:typeof ceBridgeBeforeArchive==='string'?ceBridgeBeforeArchive:''};
  ['_ceCanonLedgerSnapshot','_ceDeletedWorldBookIds','_ceDeletedWorldBookIdsPendingClear','_concurrentEvolutionDeletedIds',
    'lastItemManagementResult','lastMiscEvolutionResult','lastEntryDecisionResult','lastImageEvolutionResult','lastOriginalTimelineEvolutionResult',
    '_ceLastThinkingResults','_cePendingMiscSummary','_concurrentEvolutionProcessedIds','_concurrentEvolutionProcessedNames','_concurrentEvolutionFrequencySkippedIds',
    '_entryDecisionDeedsUpdated','_entryDecisionCurrentRoundId','_entryDecisionLatestRequestId','_entryDecisionDeedsWriteGuard',
    '_ceBiographyCompressionTriggeredThisRun','_concurrentEvolutionRerollStateApplied','pendingReentryForConcurrentEvolution','pendingNewCharacterForConcurrentEvolution'].forEach(function(key) {
    memory.windows[key] = {exists:Object.prototype.hasOwnProperty.call(window,key),value:structuredClone(window[key])};
  });
  memory.items = structuredClone(itemManagementFallbackRows);
  return memory;
}

function frRestoreCanonMemory(memory) {
  currentState = memory.state; window.currentState = currentState;
  if(typeof frOrdinarySettlementPending!=='undefined')frOrdinarySettlementPending=structuredClone(memory.ordinarySettlement||null);
  WORLD_MAP_DATA = memory.map; bondedCharacters = memory.bonded;
  itemManagementFallbackRows = memory.items; _ceCanonLedgerPending = memory.pending;
  if(memory.bridgeBefore&& typeof ceBridgeBeforeState!=='undefined'){ceBridgeBeforeState=structuredClone(memory.bridgeBefore.rows);ceBridgeBeforeTime=memory.bridgeBefore.time;ceBridgeBeforeArchive=memory.bridgeBefore.archive;}
  Object.keys(memory.windows).forEach(function(key) {
    var entry = memory.windows[key];
    if (entry.exists) window[key] = entry.value; else delete window[key];
  });
  if (typeof ceClearOffscreenRosterCache === 'function') ceClearOffscreenRosterCache();
}

// 只核对原生世界事件表的确定字段；不再次判断事件的重要性或剧情语义。
function frAssertCanonWorldReadback(beforeState,afterState,delta) {
  var ops=(delta||[]).filter(op=>['addWorldEvent','updateWorldEvent','deleteWorldEvent'].includes(op.command));
  if(!ops.length)return [];
  var actual=afterState?.['5'];if(!Array.isArray(actual))throw new Error('世界记事回读未返回原生事件表');
  var latest=new Map();ops.forEach(op=>latest.set(op.command==='addWorldEvent'?op.eventData?.id:op.id,op));
  var receipts=[];
  latest.forEach(function(op,id){
    if(!id)throw new Error('世界记事指令缺少原生事件编号');
    var record=actual.find(row=>row.id===id),deleted=op.command==='deleteWorldEvent';
    if(deleted?!!record:!record)throw new Error('世界记事实际回读未落实目标：'+id);
    const lifecycle=typeof ceBridgeCore==='function'?ceBridgeCore()?.['world-events']:null;
    const expected=lifecycle?.worldLifecycleFields(op.eventData||op.data)||{};
    if(!deleted&&Object.entries(expected).some(([key,value])=>String(record[key]||'').trim()!==value))
      throw new Error('世界记事实际回读未落实持续影响：'+id);
    receipts.push({id:id,deleted:deleted,record:record||null});
  });
  // 原执行器允许排序、格式化和补默认字段；不再逐字比较整张世界表。
  return receipts;
}

async function frCommitCanonProposal(input, proposal) {
  var src = input || {};
  var boundary = src.boundary;
  var actorOnly=src.actorOnly===true;
  var actorReceipts=actorOnly||proposal.prebuiltReadback?(Array.isArray(src.actorReceipts)?src.actorReceipts:src.actorReceipt?[src.actorReceipt]:[]):[];
  if (!boundary || (!actorOnly && (!src.ledger || !src.ledger.worldTime)) || (actorOnly && !actorReceipts.length)) throw new Error('补演提交缺少存档边界或可提交账本');
  if(actorOnly){var receiptIds=new Set(actorReceipts.map(row=>row.actorId)),targetIds=new Set((proposal.targets||[]).map(row=>row.id));if(receiptIds.size!==actorReceipts.length||receiptIds.size!==targetIds.size||Array.from(targetIds).some(id=>!receiptIds.has(id))||actorReceipts.some(row=>!row.actorId||!row.receiptId||row.status!=='saved'))throw new Error('补演人物回执与本次结算目标不一致');}
  frAssertCanonInput(src);
  if (frCanonCommitScope) throw new Error('已有补演提交正在执行');
  var memory;
  var receiptId = actorOnly?actorReceipts.map(row=>row.receiptId).join(';'):boundary.logId + '|' + src.ledger.worldTime;
  var appliedItems = [], ordinaryEventSources = {};
  var savedActors=actorOnly?{}:proposal.prebuiltSavedActors||src.preparedCharacters?.saved||{};
  var savedBiography=Object.fromEntries(Object.entries(structuredClone(src.biography || {})).filter(function(entry){return !savedActors[entry[0]];}));
  var committedArchiveText='',committedStateText='',committedArchiveForTrace=null,persistedActorReceipts={};
  var miscReceipt = {requestedDelta:[],noOperations:true,stateChanged:false};
  var traceRun=src.signal&& typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(src.signal):null;
  if(traceRun)frCanonTraceEvent(traceRun,'stage','应用变量与原子保存',{characterCommands:(proposal.characterDelta||[]).length,itemCommands:(proposal.itemOperations||[]).length,worldCommands:(proposal.miscDelta||[]).length});
  try {
    // 本次人物或收尾所需的模型请求已经结束；不等待其他人的模型。
    await db.transaction('rw', db.archives, db.settings, async function() {
      var archive = await db.archives.get(boundary.archiveName);
      if(typeof src.timelineSource==='string')await frTimelineAssertSource(src.timelineSource);
      frAssertCanonInput(src);
      if (JSON.stringify(archive) !== boundary.archiveText || JSON.stringify(currentState) !== boundary.stateText) {
        throw new Error('补演期间存档或正文已变化，拒绝覆盖新状态');
      }
      var log = archive.data.logs.find(function(l) { return l.id === boundary.logId; });
      if (!log) throw new Error('补演正文楼层已被删除');
      if(actorOnly)for(var receipt of actorReceipts){if(log.canonActorCommits?.[receipt.actorId])throw new Error('该人物本轮已经保存，拒绝重复应用：'+receipt.name);}
      memory = frTakeCanonMemory();
      frCanonCommitScope = src;
      currentState = structuredClone(currentState); WORLD_MAP_DATA = structuredClone(WORLD_MAP_DATA);
      var targets = proposal.targets || [];
      var targetMap = new Map(targets.map(function(t) { return [t.id,t]; }));
      if (proposal.prebuiltReadback) {
        for (var target of targets) {
          if (log.canonActorCommits?.[target.id] || (target.canonNew ? frCanonPrebuiltIdentityTaken(archive, target.id, target.name) :
            JSON.stringify(frCanonStoredActorRow(archive, target.id)) !== JSON.stringify(target.data))) {
            throw new Error('预制落地前人物状态已变化：' + target.name);
          }
        }
        var withdrawnWorldIds=new Set(proposal.worldWithdrawals||[]);
        if(withdrawnWorldIds.size){
          var oldWorldRows=currentState['5']||[];
          currentState['5']=oldWorldRows.filter(row=>!withdrawnWorldIds.has(row.id));
          if(oldWorldRows.length-currentState['5'].length!==withdrawnWorldIds.size)throw new Error('世界来源回读不一致');
        }
        for (var op of proposal.miscDelta) {
          if ((currentState['5'] || []).some(row => row.id === op.eventData.id || row['2'] === op.eventData['2'])) throw new Error('世界大事已有保存记录');
        }
      }
      var sourceRows=proposal.sourceRows||[];
      if(!actorOnly&&!proposal.prebuiltReadback&&src.ledger.eventProgress?.some(event=>event.status==='cancelled')){
        src.ledger=structuredClone(src.ledger);
        sourceRows=[...sourceRows,...frPlanCanonOrdinaryWithdrawals(archive,src.ledger,boundary.logId)];
      }
      for(var change of sourceRows){
        if(JSON.stringify(frCanonStoredActorRow(archive,change.id))!==JSON.stringify(change.before))throw new Error('待抽离的人物已变化：'+change.id);
        if(currentState['0']?.[change.id])currentState['0'][change.id]=structuredClone(change.data);
        if(!await updateConcurrentEvolutionArchiveEntry(change.id,change.data,{silent:true,createIfNotExists:false}))
          throw new Error('人物事件抽离保存失败：'+change.id);
        var sourceArchive=await db.archives.get(boundary.archiveName);
        if(JSON.stringify(frCanonStoredActorRow(sourceArchive,change.id))!==JSON.stringify(change.data))
          throw new Error('人物事件抽离回读失败：'+change.id);
      }
      for (var target of targets) {
        if (!target.canonNew) continue;
        var created = await updateConcurrentEvolutionArchiveEntry(target.id, target.data, {silent:true,createIfNotExists:true});
        if (!created) throw new Error('新人建档失败：' + target.name);
      }
      for (var terminal of proposal.terminalRows || []) {
        frAssertCanonCommit();
        var savedTerminal = await updateConcurrentEvolutionArchiveEntry(terminal.id,terminal.data,{silent:true});
        if (!savedTerminal) throw new Error('预制终态保存失败：'+terminal.id);
      }
      if(proposal.eventSteps?.length){
        var eventResult=await frApplyCanonOrdinaryEventSteps(proposal.eventSteps,targetMap,boundary);
        ordinaryEventSources=eventResult.sources;
        appliedItems=eventResult.itemReceipts;
      }
      frAssertCanonCommit();
      var characters = await ceApplyCharacterDeltaWithStateSync(proposal.characterDelta || [], {targetMap:targetMap,syncState:false,ensureArchiveEntries:true});
      if (!characters || characters.error) throw new Error('人物应用失败：' + String(characters && characters.error || '无结果'));
      // 预览通过不等于实际落档通过；从事务内权威世界档案回读后再确认。
      var profileArchive = await db.archives.get(boundary.archiveName);
      if (proposal.prebuiltReadback) {
        for (var target of targets) {
          var expected = proposal.prebuiltReadback[target.id], actual = frCanonStoredActorRow(profileArchive, target.id);
          var attrs = typeof actual?.['11'] === 'string' ? JSON.parse(actual['11']) : actual?.['11'];
          if (!actual || Object.entries(expected.fields).some(([key, value]) => actual[key] !== value &&
              !ceBridgeCore()['cultivation-arts'].cultivationArtStateEqual(actual[key],value)) ||
              Object.entries(expected.attributes).some(([key, value]) => attrs?.[key]?.current !== value)) {
            throw new Error('预制变量未通过实际回读：' + target.name);
          }
        }
      }
      var savedProfiles = targets.filter(function(t) { return t.canonNew || t.canonNeedsProfile; }).map(function(target) {
        /* ★★★ 2026-11-02 玩家截图：账本标红「未完成 · 韩立人物档案保存后缺失」。
         *
         * 【根因】这一段回读**只查 worldBookEntries**（世界书条目）。
         * 但韩立是主角，他的档案存在**变量第 0 行**（currentState['0']），
         * 不是世界书条目 —— 所以对主角必然 find 不到，直接抛「保存后缺失」。
         *
         * 证据：同一函数下面「完成度回读」那一段（约 1445 行）自己就是双来源的：
         *     var actualRow=(currentState[target.type==='beast'?'7':'0']||{})[target.id];
         *     if(!actualRow&&actualEntry)actualRow=...entry.content...
         * 也就是说本项目本来就有「先查变量行、再退回世界书条目」的既定口径，
         * 只有这里漏了，属于遗漏而非设计。
         *
         * 【修法】按同一口径回读：
         *   ① 先查变量行（野兽走 7，其余走 0）；
         *   ② 再退回 worldBookEntries；
         *   ③ 两者都没有才算真的缺失。
         */
        var stateRow=(currentState[target.type==='beast'?'7':'0']||{})[target.id];
        var entry=(profileArchive.data.state.worldBookEntries || []).find(function(e) { return e.key === target.id || e.id === target.id; });
        var row;
        if(stateRow)row=stateRow;
        else if(entry){try { row = typeof entry.content === 'string' ? JSON.parse(entry.content) : entry.content; } catch (_) { throw new Error(target.name + '人物档案保存内容无效'); }}
        if(!row)throw new Error(target.name + '人物档案保存后缺失');
        return {...target,data:row};
      });
      // 这里已经写进数据库、回读验证过了，缺了就是真写坏，必须严格。
  frAssertCanonNpcProfiles(savedProfiles, { allowSoft: false });
      frAssertCanonCommit();
      var items = await executeItemOperations(proposal.itemOperations || [],{npcLoadoutIds:targets.filter(target=>target.type==='npc').map(target=>target.id),
        preserveTechnique:!!proposal.prebuiltReadback,techniqueStory:src.storyText||''});
      if (!Array.isArray(items) || items.some(function(op) { return !op || op.success !== true; })) throw new Error('物品操作未完整成功');
      if (proposal.prebuiltReadback && (proposal.itemOperations || []).length) {
        if (items.length !== proposal.itemOperations.length) throw new Error('预制物品落地回执不完整');
        var itemArchive = await db.archives.get(boundary.archiveName);
        // 同一冻结回读快照内复用解析结果；不跨事务、轮次或写入缓存。
        var readInventoryCache = new Map();
        var readInventory = function(owner) {
          if (readInventoryCache.has(owner)) return readInventoryCache.get(owner);
          var ownerEntry = (itemArchive.data.state.worldBookEntries || []).find(row => row.key === owner || row.id === owner);
          var ownerRow = typeof ownerEntry?.content === 'string' ? JSON.parse(ownerEntry.content) : ownerEntry?.content;
          var ownerRemarks = parseRemarksString(ownerRow?.['9'] || '');
          var ownerItems = parseNestedJsonString(ownerRemarks.inventory, []);
          if (!ownerRow || !Array.isArray(ownerItems)) throw new Error('预制物品所属角色背包无法回读：' + owner);
          var equipment = parseNestedJsonString(ownerRemarks.equipment, {});
          var combined = ownerItems.concat(Object.values(equipment).flatMap(slots=>Array.isArray(slots)?slots.filter(Boolean):[]));
          readInventoryCache.set(owner, combined);
          return combined;
        };
        for (var expectedItem of proposal.itemOperations.filter(op => op.type === 'createItem')) {
          // 原生执行器会重排物品命令，按操作和归属配对回执。
          var itemResult = items.find(result => result.type === 'createItem' && result.owner === expectedItem.owner &&
            result.operation?.item?.['1'] === expectedItem.item['1']);
          var landedItem = itemResult?.itemId && readInventory(expectedItem.owner).find(row => row?.['0'] === itemResult.itemId);
          if (!landedItem ||
            Object.keys(expectedItem.item).some(field => String(landedItem[field]) !== String(expectedItem.item[field]))) {
            throw new Error('预制物品回读不一致：' + expectedItem.item['1']);
          }
        }
        for (var [owner, expected] of Object.entries(proposal.prebuiltReadback)) {
          if (!expected.remainingItems?.length) continue;
          var inventory = readInventory(owner);
          for (var stock of expected.remainingItems) {
            var stacks = inventory.filter(row => (row?.['0'] || row?.id) === stock.itemId);
            var item = stacks[0];
            if (stock.quantity === 0 ? stacks.length !== 0 : stacks.length !== 1 ||
                String(item['1'] || item.name || '').trim() !== stock.name ||
                String(item['5'] ?? item.quantity) !== String(stock.quantity)) {
              throw new Error('预制物品消耗回读不一致：' + stock.name);
            }
          }
        }
      }
      appliedItems.push(...items);
      if(proposal.completionEvidence){
        var actualArchive=await db.archives.get(boundary.archiveName);
        for(var target of targets){
          var actualEntry=(actualArchive.data.state.worldBookEntries||[]).find(entry=>entry.key===target.id||entry.id===target.id);
          var actualRow=(currentState[target.type==='beast'?'7':'0']||{})[target.id];
          if(!actualRow&&actualEntry)actualRow=typeof actualEntry.content==='string'?JSON.parse(actualEntry.content):actualEntry.content;
          if(!actualRow)throw new Error(target.name+'变量落地后档案缺失');
          var review=proposal.completionEvidence.context.byTargetId[target.id]?.review;
          for(var phase of ['characters','items']){
            var checked=frCanonCompletionTools().check({target:{...target,data:actualRow},facts:review?.facts,phase,report:proposal.completionEvidence[phase][target.id],actual:true,itemReceipts:appliedItems,ruleSkips:appliedItems.filter(row=>row.skipped&&row.skipReason==='equipment_rule'),cultivation:phase==='characters'?review?.cultivation:null,baseline:review?.baseline});
            if(!checked.completed)throw Object.assign(new Error(target.name+'实际回读仍缺项：'+checked.hardMissing.join('；')),{completion:{[target.id]:checked}});
          }
        }
      }
      frAssertCanonCommit();
      if ((proposal.miscDelta || []).length) {
        var beforeMisc = JSON.stringify([currentState,WORLD_MAP_DATA]),beforeWorldState=structuredClone(currentState);
        var misc = await applyChanges(currentState, structuredClone(proposal.miscDelta));
        if (!misc || !misc.newState) throw new Error('世界变化没有返回有效状态');
        var worldReadback=frAssertCanonWorldReadback(beforeWorldState,misc.newState,proposal.miscDelta);
        currentState = misc.newState;
        miscReceipt = {requestedDelta:proposal.miscDelta,worldReadback:worldReadback,noOperations:false,stateChanged:beforeMisc!==JSON.stringify([currentState,WORLD_MAP_DATA])};
      }
      // 人物可在场或离场。生平统一追加到实际行，再同步权威档案。
      var biography = savedBiography;
      const appliedPrebuiltSources=new Map();
      for (var name of Object.keys(biography)) {
        var person = targets.find(function(t) { return t.name === name; });
        if (!person) throw new Error('生平缺少已定位人物：' + name);
        const owned=(proposal.prebuiltSources||[]).filter(source=>source.name===name&&source.status==='applied');
        if(owned.length){
          const tools=ceBridgeCore()['canon-event-details'];
          const bioArchive=await db.archives.get(boundary.archiveName);
          const savedRow=frCanonStoredActorRow(bioArchive,person.id);
          if(!savedRow)throw new Error('预制生平缺少人物档案：'+name);
          const before=String(savedRow['35']||'');
          let text=before;
          for(const source of owned){
            const result=tools.appendPrebuiltBiography(text,source.biography||[]);
            text=result.text;
            appliedPrebuiltSources.set(source.sourceId,{...source,biography:result.added});
          }
          if(text!==before){
            const next={...savedRow,35:text};
            if(!await updateConcurrentEvolutionArchiveEntry(person.id,next,{silent:true,createIfNotExists:true}))
              throw new Error('预制生平保存失败：'+name);
            if(currentState['0']?.[person.id])currentState['0'][person.id]=next;
            const checked=await db.archives.get(boundary.archiveName);
            if(String(frCanonStoredActorRow(checked,person.id)?.['35']||'')!==text)
              throw new Error('预制生平回读不一致：'+name);
          }
          savedBiography[name]=owned.flatMap(source=>appliedPrebuiltSources.get(source.sourceId).biography).join('\n');
          continue;
        }
        var eventLines=new Set((proposal.eventSteps||[]).flatMap(step=>step.actors.filter(actor=>actor.id===person.id).flatMap(actor=>actor.biography)));
        var extra=String(biography[name]||'').split(/\r?\n/u).filter(line=>!eventLines.has(line.trim())).join('\n');
        if(extra.trim())await frAppendCanonBiography(boundary.archiveName,person,extra);
      }
      // 压缩已在事务外经原流程生成。这里只替换同源的第10/35列，不能覆盖其他变量。
      var compression=proposal.biographyCompression;
      for(var compressed of compression?.updates || []){
        var target=targets.find(function(t){return t.id===compressed.id;});
        if(!target)continue;
        var compressedArchive=await db.archives.get(boundary.archiveName);
        var compressedEntry=(compressedArchive.data.state.worldBookEntries || []).find(function(e){return e.key===target.id || e.id===target.id;});
        var compressedRow=(target.type==='beast'?currentState['7']:currentState['0'])?.[target.id];
        if(!compressedRow && compressedEntry)compressedRow=JSON.parse(compressedEntry.content);
        if(!compressedRow || String(compressedRow['35'] || '')!==compressed.sourceText || (Object.prototype.hasOwnProperty.call(compressed,'sourceBackground') && String(compressedRow['10'] ?? '')!==compressed.sourceBackground)){compression.status='pending';compression.reason='经历已有更新，保留完整原文';compression.updatedIds=(compression.updatedIds||[]).filter(id=>id!==target.id);continue;}
        compressedRow['35']=compressed.text;
        if(Object.prototype.hasOwnProperty.call(compressed,'background'))compressedRow['10']=compressed.background;
        savedBiography[target.name]=compressed.text;
        if(!await updateConcurrentEvolutionArchiveEntry(target.id,compressedRow,{silent:true,createIfNotExists:true}))throw new Error('压缩生平保存失败：'+target.name);
      }
      frAssertCanonCommit();
      // 重新读取同一事务内已更新的档案，避免覆盖前面人物、物品的档案修改。
      archive = await db.archives.get(boundary.archiveName);
      log = archive.data.logs.find(function(l) { return l.id === boundary.logId; });
      // The canon owner saves both the archive profile and the live roster. Being mentioned
      // or having a profile does not imply presence: the proposal carries a verified endpoint.
      for(const placement of proposal.scenePlacements||[]){
        if(!/^C\d+$/u.test(placement.id)||!targetMap.has(placement.id))throw new Error('在场人物归属不符');
        if(placement.present){
          const row=frCanonStoredActorRow(archive,placement.id);
          if(!row)throw new Error('在场人物档案无法回读：'+targetMap.get(placement.id).name);
          (currentState['0'] ||= {})[placement.id]=structuredClone(row);
        }else if(currentState['0']?.[placement.id])delete currentState['0'][placement.id];
      }
      if(!actorOnly){
        src.ledger=structuredClone(src.ledger);
        for(const event of src.ledger.eventProgress||[])for(const node of event.nodes||[]){
          if(node.contributions?.length)node.contributions=node.contributions.map(source=>appliedPrebuiltSources.get(source.sourceId)||source);
        }
        var allSaved=Object.values(savedActors);
        if(allSaved.some(receipt=>receipt.eventSource||receipt.eventSources?.length))frCanonMergeOrdinaryEventSources(src.ledger,allSaved);
        const affectedIds=new Set([...targets.map(row=>row.id),...allSaved.map(row=>row.actorId),...sourceRows.map(row=>row.id)]);
        for(const {operation} of boundary.settlementBase?.records||[]){
          for(const id of [operation?.id,operation?.data?.['0'],operation?.owner,operation?.from,operation?.to])
            if(/^C\d+$/u.test(id||''))affectedIds.add(id);
        }
        frCanonRefreshPrebuiltActorDifferences(src.ledger,archive,boundary.logId,affectedIds);
        var updatedNames=Array.from(new Set([...targets.map(function(t){return t.name;}),...allSaved.map(function(r){return r.name;})].filter(Boolean)));
        src.ledger.lastTurn=Object.assign({},src.ledger.lastTurn || {},{...(proposal.prebuiltReadback?{actorCount:updatedNames.length}:{}),updatedNames:updatedNames,updatedIds:Array.from(new Set([...targets.map(function(t){return t.id;}),...allSaved.map(function(r){return r.actorId;})])),biographyNames:Object.keys(src.biography || {}),worldNoChanges:structuredClone(src.worldNoChanges || [])});
        currentState.canonLedger = structuredClone(src.ledger);
        archive.data.state.canonLedger = structuredClone(src.ledger);
      }
      archive.data.state.currentState = structuredClone(currentState);
      archive.data.state.worldMap = structuredClone(WORLD_MAP_DATA);
      archive.data.state.bondedCharacters = structuredClone(bondedCharacters);
      if(proposal.settlementReview){log.canonSettlementReviews=log.canonSettlementReviews||{};for(var reviewKey of actorOnly?actorReceipts.map(row=>row.actorId):['world'])log.canonSettlementReviews[reviewKey]=structuredClone(proposal.settlementReview);}
      log.stateSnapshot = JSON.stringify(currentState);
      log.biographySnapshot = structuredClone(archive.data.state.worldBookEntries || []);
      log.canonSupplement = actorOnly?{blocks:[...(log.canonSupplement?.blocks || []).filter(function(block){return !actorReceipts.some(receipt=>receipt.name===block.name);}),...structuredClone(src.blocks || [])],worldForMisc:String(log.canonSupplement?.worldForMisc || '')}:{blocks:structuredClone(src.blocks || []),worldForMisc:String(src.worldForMisc || '')};
      if(compression)log.canonBiographyCompression={status:compression.status==='pending'?'pending':compression.skipped?'not_needed':'done',reason:compression.reason||'',updatedIds:compression.updatedIds || [],names:compression.names || []};
      log.detailedEvolutionHtml = String(log.detailedEvolutionHtml || '').replace(/<!--FR_CANON_START-->[\s\S]*?<!--FR_CANON_END-->/g,'') + frFormatCanonSupplement(log.canonSupplement);
      if(actorOnly || proposal.prebuiltReadback){
        log.canonActorCommits=log.canonActorCommits || {};
        for(var receipt of actorReceipts){
          var ownItems=actorReceipts.length===1?appliedItems:appliedItems.filter(op=>{
            var operation=op.operation || op;
            var owners=actorReceipts.filter(row=>[op.owner,op.from,op.to,operation.owner,operation.from,operation.to].includes(row.actorId));
            return owners[0]?.actorId===receipt.actorId;
          });
          log.canonActorCommits[receipt.actorId]={...structuredClone(receipt),...(actorReceipts.length>1?{sharedReceiptId:receiptId,participantIds:actorReceipts.map(row=>row.actorId)}:{}),applied:{characterDelta:structuredClone((proposal.characterDelta || []).filter(op=>String(op.id||op.data?.['0']||'')===receipt.actorId)),items:structuredClone(ownItems),misc:structuredClone(proposal.miscDelta || []),biography:structuredClone(Object.fromEntries(Object.entries(savedBiography).filter(([name])=>name===receipt.name))),biographyCompression:structuredClone(compression || null)}};
          if(ordinaryEventSources[receipt.actorId]?.length)log.canonActorCommits[receipt.actorId].eventSources=ordinaryEventSources[receipt.actorId];
          else if(actorOnly&&!proposal.prebuiltReadback&&receipt.block?.eventIds?.length===1){
            var actor=targetMap.get(receipt.actorId);
            var eventSource=frCanonOrdinaryEventSource(actor,receipt,frCanonStoredActorRow(archive,receipt.actorId));
            if(eventSource)log.canonActorCommits[receipt.actorId].eventSource=eventSource;
          }
          if(receipt.prebuiltActor){
            log.canonActorCommits[receipt.actorId].prebuiltSources=(receipt.prebuiltSources||[])
              .map(source=>appliedPrebuiltSources.get(source.sourceId)||source);
            log.canonActorCommits[receipt.actorId].prebuiltAfterRow=structuredClone(frCanonStoredActorRow(archive,receipt.actorId));
            const savedProse=(log.canonPrebuiltProse ||= {});
            savedProse[receipt.name]={status:'saved',block:receipt.block,receiptId:receipt.receiptId};
          }
          persistedActorReceipts[receipt.actorId]=structuredClone(log.canonActorCommits[receipt.actorId]);
        }
        if(actorOnly)log.canonPending=log.canonPending || {status:'running',reason:'人物已分别保存，本轮其他步骤尚未完成'};
      }
      if(!actorOnly){
        log.canonWorldNoChanges=structuredClone(src.worldNoChanges || []);
        log.canonTurnCommit = {id:receiptId,worldTime:src.ledger.worldTime,stateText:JSON.stringify(currentState),...(proposal.prebuiltReadback?{mode:'prebuilt'}:{})};
        delete log.canonPending;
      }
      await db.archives.put(archive);
      frAssertCanonCommit();
      var verifiedArchive=await db.archives.get(boundary.archiveName);
      if(JSON.stringify(verifiedArchive)!==JSON.stringify(archive)){
        // 补演与普通演化并行跑，普通线的 db.archives.put 可能落进这次回读里，
        // 回读到的是它刚写的版本。此时只确认本次写入的关键字段确实落库——
        // 其他字段被并行改动属于正常并发，不是补演保存失败。
        // 这里不做任何等待：事务体内不许可等待，重试只能放在事务之外。
        var landedLedger=JSON.stringify(verifiedArchive?.data?.state?.canonLedger??null)===JSON.stringify(archive.data.state?.canonLedger??null);
        var landedTurn=JSON.stringify(verifiedArchive?.data?.logs?.find(function(row){return row.id===boundary.logId;})?.canonTurnCommit??null)===JSON.stringify(log.canonTurnCommit??null);
        const confirmedLog=verifiedArchive?.data?.logs?.find(row=>row.id===boundary.logId);
        const landedActors=Object.entries(persistedActorReceipts).every(([id,receipt])=>JSON.stringify(confirmedLog?.canonActorCommits?.[id])===JSON.stringify(receipt));
        if(!landedLedger||!landedTurn||!landedActors)throw new Error('补演保存回读不一致，拒绝确认完成');
      }
      // Only actor-by-actor continuation needs a new serialized boundary. Full-turn
      // tracing can use the already read-back archive instead of stringify + parse.
      if(actorOnly){committedArchiveText=JSON.stringify(verifiedArchive);committedStateText=JSON.stringify(currentState);}
      else if(traceRun)committedArchiveForTrace=verifiedArchive;
    });
  } catch (error) {
    // IndexedDB 自动回滚库内操作；只恢复本次内存，不另写旧整档覆盖其他任务。
    if (memory && currentArchiveName === boundary.archiveName) frRestoreCanonMemory(memory);
    if(traceRun)frCanonTraceEvent(traceRun,'error','事务回滚，未保存',{reason:String(error.message||error)});
    throw error;
  } finally {
    if(frCanonCommitScope===src)frCanonCommitScope = null;
  }
  // 事务的 Promise 成功以后才发布账本、刷新 UI。失败不回滚已提交事实。
  window.currentState = currentState;
  miscReceipt.committed = true;
  if(traceRun){
    try{
      if(!actorOnly&&typeof frCanonSavedEventVariables==='function'){
        const rows=frCanonSavedEventVariables(committedArchiveForTrace,boundary.logId);
        frCanonTracePublish(traceRun,'事件变量保存明细',{kind:'savedEventVariables',rows});
      }
      if(proposal.prebuiltReadback){
        for(const receipt of Object.values(persistedActorReceipts)){
          const {characterDelta,items,biography}=receipt.applied;
          frCanonTracePublish(traceRun,'预制人物变量已保存 · '+receipt.actorId,{
            kind:'characters',status:'saved',name:receipt.name,actorId:receipt.actorId,body:receipt.body,
            applied:{characterDelta,items,biography}
          });
          frCanonTraceEvent(traceRun,'actor_saved','预制人物变量已保存',{
            receiptId,logId:boundary.logId,actorId:receipt.actorId,name:receipt.name,
            applied:{characterDelta,items,biography}
          });
        }
      }
      const commitTraceType=actorOnly?(src.actorReceipt?.actorId||src.actorReceipt?.name?'actor_saved':'actor_transaction'):'committed';
      frCanonTraceEvent(traceRun,commitTraceType,actorOnly?'人物数据库事务已提交':'数据库事务已提交',{receiptId:receiptId,logId:boundary.logId,actorId:src.actorReceipt?.actorId,name:src.actorReceipt?.name,applied:{items:appliedItems,misc:proposal.miscDelta||[],miscReceipt:miscReceipt,biography:savedBiography,biographyCompression:proposal.biographyCompression?{updatedIds:proposal.biographyCompression.updatedIds || [],names:proposal.biographyCompression.names || []}:null}});
    }catch(recordError){console.warn('[原著补演] 存档已提交，结果记录显示失败:',recordError);}
  }
  if(actorOnly){boundary.archiveText=committedArchiveText;boundary.stateText=committedStateText;boundary.actorCommits=boundary.actorCommits || {};Object.assign(boundary.actorCommits,persistedActorReceipts);}
  else{_ceCanonLedgerPending = null; window._ceCanonLedgerSnapshot = structuredClone(src.ledger);}
  try {
    var committed = await db.archives.get(boundary.archiveName);
    ceSyncWorldBookCachesFromStateEntries(committed.data.state.worldBookEntries || [], 'canon_committed', {allowEmpty:true});
    await refreshConcurrentEvolutionUI();
    if (typeof document !== 'undefined' && typeof createLogEntryElement === 'function') {
      var renderedLog = committed.data.logs.find(function(l) { return l.id === boundary.logId; });
      var logElement = document.querySelector('.log-entry[data-log-id="'+boundary.logId+'"]');
      if (renderedLog && logElement) logElement.replaceWith(createLogEntryElement(renderedLog,'ai'));
    }
  } catch (uiError) { console.warn('[原著补演] 已保存，但界面刷新失败:', uiError); }
  if (typeof cloudStorageConfig !== 'undefined' && cloudStorageConfig.enabled && cloudStorageConfig.autoSync) {
    uploadArchiveToCloud(boundary.archiveName,true).catch(function(error) { console.warn('[原著补演] 云同步失败:', error); });
  }
  return {ok:true,committed:true,receiptId:receiptId,actorReceipt:actorOnly&&actorReceipts.length===1?persistedActorReceipts[actorReceipts[0].actorId]:null,actorReceipts:actorOnly?persistedActorReceipts:null,ledger:actorOnly?null:structuredClone(src.ledger),biographyCompression:proposal.biographyCompression?{updatedIds:proposal.biographyCompression.updatedIds || [],skipped:!!proposal.biographyCompression.skipped,reason:proposal.biographyCompression.reason || ''}:null};
}

async function ceCommitNpcPovProseToEvolution(input) {
  var src = input || {};
  try {
    var proposal = await frPrepareCanonProposal(src);
    proposal.biographyCompression=await frPrepareCanonBiographyCompression(src,proposal);
    return await frCommitCanonProposal(src,proposal);
  } catch (error) {
    return {ok:false,committed:false,reason:String(error && error.message || error),retry:error.retry||null};
  }
}
