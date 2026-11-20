// 本轮只读准备：缓存原RAG回信和完整相同请求的正文事实结果，不保存故事或游戏状态。
var frAiBackgroundSignals = new WeakSet();
var frAiPriorityRoots = new WeakMap();
var frCanonEarlyCurrent = null;
function frIsBackgroundAiRequest(signal) { return !!signal && frAiBackgroundSignals.has(frAiPriorityRoots.get(signal)||signal); }
function frInheritAiRequestPriority(parent,child) { if(child&&parent)frAiPriorityRoots.set(child,frAiPriorityRoots.get(parent)||parent); }
function frCanonEarlyAbort() { var error=new Error('本轮提前资料准备已停止');error.name='AbortError';return error; }
function frCreateCanonEarlyCache(options) {
  var opts=options || {},entries=new Map(),models=new Map(),stats={queries:0,reused:0,boundaryRequests:0,boundaryReused:0},queries=[];
  var valid=function(){return !opts.signal?.aborted && (!opts.isCurrent || opts.isCurrent());};
  var assertCurrent=function(){if(!valid())throw frCanonEarlyAbort();};
  var clone=function(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));};
  var keyOf=function(query,request){return JSON.stringify([String(query),request.referenceTime || '',request.characterNames || [],request.queryBatchSize || 32,request.materialRequestScope || null,request.queries || null,request.queryTexts || null]);};
  return {stats:stats,queries:queries,wrap:function(host,preparing,sourceStamp,reuseSignal){
    var wrapped=Object.assign({},host),original=host.vectorContext;
    var model=host.llmCall;
    if(typeof model==='function')wrapped.llmCall=async function(payload){
      assertCurrent();var allowed=['正文硬事实提取','补演边界格式整理'].includes(payload?.stage);
      if(preparing&&(!opts.boundaryEnabled||!allowed)){opts.stop?.();throw frCanonEarlyAbort();}
      var key=JSON.stringify([payload.stage,payload.subject||'',payload.messages,payload.json]),saved=models.get(key);
      if(!preparing&&allowed&&sourceStamp===opts.sourceStamp&&saved){
        stats.boundaryReused++;
        if(typeof frCanonTraceRequest==='function'){
          if(typeof frCanonTraceTag==='function')frCanonTraceTag(reuseSignal,payload.stage,payload.subject||'','');
          var req=frCanonTraceRequest(reuseSignal,{model:'提前准备结果复用',messages:payload.messages});
          if(req){req.reused=true;req.preparedAt=saved.at;frCanonTraceResponse(req,{preparedReuse:true,text:saved.text});}
        }
        return saved.text;
      }
      if(preparing){if(opts.preparationSignal?.aborted)throw frCanonEarlyAbort();stats.boundaryRequests++;}
      var text=await model.call(host,payload);assertCurrent();
      if(preparing&&!opts.preparationSignal?.aborted&&typeof text==='string'&&text.trim())models.set(key,{text:text,at:Date.now()});
      return text;
    };
    if(typeof original!=='function')return wrapped;
    wrapped.vectorContext=async function(query,requestOptions){
      assertCurrent();var request=requestOptions || {},key=keyOf(query,request),saved=entries.get(key);
      if(!preparing && sourceStamp===opts.sourceStamp && saved){
        var result=saved.result;assertCurrent();
        if(result){stats.reused++;wrapped.vectorContext.lastReceipt=clone(result.receipt);wrapped.vectorContext.lastMaterialRequest=clone(result.materialRequest);request.onReceipt?.(clone(result.receipt));return result.text;}
      }
      // 跨轮资料快照：重跑时同一查询直接复用上轮检索结果，不再重新检索。
      // 存档/楼层不符在 frCanonMaterialsTake 里仍然硬失效；
      // 检索配置变了只是「软失效」——不再一刀切作废，
      // 而是落到下面重新查一次，查完覆盖旧值（A 方案，玩家 2026-10-30 定）。
      if(!preparing){
        var snap=await frCanonMaterialsTake(frCanonMaterialsArchiveName(opts.archiveName),opts.logId,frCanonMaterialQueryKey(query,request));
        if(snap && snap.stale){
          if(typeof frCanonTraceEvent==='function' && opts.traceRun)frCanonTraceEvent(opts.traceRun,'reuse-miss','检索配置已变，旧资料作废，按当前配置重新检索',{query:String(query).slice(0,120),reason:String(snap.staleReason||'')});
          snap=null;
        }
        if(snap){
          stats.reused++;
          wrapped.vectorContext.lastReceipt=clone(snap.receipt);wrapped.vectorContext.lastMaterialRequest=clone(snap.materialRequest);
          try{request.onReceipt?.(clone(snap.receipt));}catch(_){}
          if(typeof frCanonTraceEvent==='function' && opts.traceRun)frCanonTraceEvent(opts.traceRun,'reuse','复用上轮检索资料（未重新检索）',{query:String(query).slice(0,120),at:snap.at});
          assertCurrent();
          return snap.text;
        }
      }
      var receipt=null;
      var perform=async function(){
        assertCurrent();if(preparing && opts.preparationSignal?.aborted)throw frCanonEarlyAbort();
        var text=await original.call(host,query,Object.assign({},request,{onReceipt:function(value){receipt=clone(value);request.onReceipt?.(value);}}));assertCurrent();if(preparing && opts.preparationSignal?.aborted)throw frCanonEarlyAbort();
        var materialRequest=clone(original.lastMaterialRequest);
        wrapped.vectorContext.lastReceipt=receipt || clone(original.lastReceipt);wrapped.vectorContext.lastMaterialRequest=materialRequest;
        return {text:text,receipt:receipt,materialRequest:materialRequest};
      };
      // 检索成功就把这份资料存进跨轮快照，重跑时不必再检索一遍。
      // 正式阶段和后台预备阶段都要存：正式阶段才是真正跑完一整轮的那次。
      // 楼层取 opts.logId；正式阶段拿不到就退回当前最新楼层，否则会存到空键上。
      var persist=async function(out){
        try{
          if(!out||typeof out.text!=='string'||!out.text.trim())return;
          var logId=opts.logId||'';
          if(!logId&&typeof db!=='undefined'&&db.archives){
            var archive=await db.archives.get(frCanonMaterialsArchiveName(opts.archiveName));
            var latestLog=typeof frReplayLatestLog==='function'?frReplayLatestLog(archive):(archive?.data?.logs||[]).slice().reverse().find(function(log){return log.type==='ai';});
            logId=latestLog?.id||'';
          }
          if(!logId)return;
          var qkey=frCanonMaterialQueryKey(query,request);
          await frCanonMaterialsSave(frCanonMaterialsArchiveName(opts.archiveName),logId,{[qkey]:{
            key:qkey,text:out.text,receipt:out.receipt,materialRequest:out.materialRequest,
            queryText:String(query),queryKey:qkey,configStamp:frCanonMaterialsConfigStamp(),at:Date.now()
          }});
          // 本轮存下的资料要「随时可复用」：写成功后立刻通知在看重跑面板的地方刷新，
          // 否则玩家点开面板看到的还是旧快照（或空），会以为没存下来。
          try{
            if(typeof window!=='undefined'&&typeof window.frCanonMaterialsChanged==='function')window.frCanonMaterialsChanged(logId);
          }catch(_){}
        }catch(error){
          // 玩家 2026-10-30：原来是 catch(_){}，失败全被吞掉，资料存不进去查四次都没证据。
          // 保存失败不阻断主流程（补演比存资料重要），但必须留痕。
          console.warn('[资料快照] 保存失败：'+String(error&&error.message||error),error);
        }
      };
      if(!preparing){var done=await perform();await persist(done);return done.text;}
      stats.queries++;queries.push({queryText:String(query),requestOptions:clone(Object.assign({},request,{onReceipt:undefined}))});
      var row={result:null};entries.set(key,row);
      var result=await perform();
      // 玩家 2026-10-30：receipt 是诊断信息不是资料本体，有正文就落盘，否则跨轮永远是空的。
      row.result=result.receipt?.completed===true&&['found','not_found','empty','ok'].includes(result.receipt.status)?result:null;
      if(row.result)await persist(result);
      else if(result&&typeof result.text==='string'&&result.text.trim())await persist(result);
      return result.text;
    };
    return wrapped;
  }};
}
async function frCanonEarlySourceStamp(narrativeOnly) {
  // 来源戳要覆盖：向量库变更、检索配置与提示词模板、实际参与检索的上下文
  // （地点、思考内容、正文、回退截止、人物快照等）、档案与设置。
  // 向量那一维用 Dexie 表变更通知计数，不读也不序列化整个向量库；
  // 没有变更通知时只是这一维退化，其余维度照常算，不能因此让整个戳失效。
  var hasVectors=!(typeof db==='undefined' || !db.vectors);
  var api=hasVectors?(typeof Dexie!=='undefined'?Dexie:db.constructor):null;
  if(hasVectors && typeof api?.on==='function'){
    if(!frCanonVectorRevision || frCanonVectorRevision.database!==db){
      if(frCanonVectorRevision&&typeof frCanonVectorRevision.api?.on?.storagemutated?.unsubscribe==='function')frCanonVectorRevision.api.on.storagemutated.unsubscribe(frCanonVectorRevision.listener);
      var revision={database:db,api:api,value:0};
      revision.listener=function(parts){if(Object.keys(parts||{}).some(function(key){return key.startsWith('idb://'+db.name+'/vectors/');}))revision.value++;};
      api.on('storagemutated',revision.listener);frCanonVectorRevision=revision;
    }
  }
  var config=typeof knowledgeSearchGlobalConfig==='object'?knowledgeSearchGlobalConfig:{},method=config.vectorSearchMethod || 'semantic';
  var template=String(method==='hybrid'?config.hybridKeywordPrompt || (typeof DEFAULT_HYBRID_SEARCH_PROMPT==='string'?DEFAULT_HYBRID_SEARCH_PROMPT:''):method==='llm_index'?config.vectorIndexPrompt || (typeof DEFAULT_VECTOR_INDEX_PROMPT==='string'?DEFAULT_VECTOR_INDEX_PROMPT:''):config.vectorSummaryPrompt || (typeof DEFAULT_VECTOR_SEARCH_PROMPT==='string'?DEFAULT_VECTOR_SEARCH_PROMPT:''));
  var player=typeof currentPlayerData==='object' && currentPlayerData || {},archive=!narrativeOnly&&db.archives?await db.archives.get(currentArchiveName):null;
  var context={name:template.includes('${playerName}')?player.name || '玩家':'',location:template.includes('${currentLocation}')?player.location || '未知':'',story:template.includes('${story_text}') || config.vectorSearchWorldBooks?.some(function(row){return row.enabled!==false && row.triggerMode==='green';})?typeof lastAiStoryText==='string'?lastAiStoryText:'':'',thinking:template.includes('${thinking_content}')?typeof latestThinkingContent==='string'?latestThinkingContent:'':'',vectorCutoffTimestamp:archive?.data?.state?.vectorCutoffTimestamp};
  if(template.includes('${state_snapshot}'))context.state=typeof currentState==='object'?{world:currentState?.['4']||{},characters:currentState?.['0']||{}}:{};
  else if(template.includes('${character_biographies}'))context.characters=typeof currentState==='object'?currentState?.['0']||{}:{};
  if(template.includes('${playerRank}'))context.rank={realm:player.realm||'',row:typeof currentState==='object'?currentState?.['0']?.B1?.['2']||'':''};
  context.canonSettings=typeof ceBridgeLoadConfig==='function'?await ceBridgeLoadConfig():{};
  context.nativeSettings=typeof loadConcurrentEvolutionConfig==='function'?await loadConcurrentEvolutionConfig():{};
  if(narrativeOnly)context={canonSettings:context.canonSettings,nativeSettings:context.nativeSettings};
  var data=JSON.stringify([frCanonVectorRevision?frCanonVectorRevision.value:'no-vector-revision',config,template,context,typeof currentArchiveId!=='undefined'?currentArchiveId:'']);
  if(!globalThis.crypto?.subtle){
    // 没有 crypto 时用同一份数据的长度与字符和做退化指纹：仍能感知变化，
    // 只是不保证抗碰撞。绝不能因为环境缺能力就让来源戳恒为空。
    var text=String(data),sum=0;
    for(var i=0;i<text.length;i++){sum=(sum*31+text.charCodeAt(i))>>>0;}
    return 'plain-'+text.length+'-'+sum.toString(16);
  }
  var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest)).map(function(value){return value.toString(16).padStart(2,'0');}).join('');
}
var frCanonVectorRevision=null;
function frCancelCanonEarlyPreparation(record) {
  if(!record)return;record.cancelled=true;record.controller.abort(frCanonEarlyAbort());
  record.releaseOrdinary?.(null);
  if(record.earlyPipeline)record.earlyPipeline.stop().catch(function(){});
  if(record.narrative&&record.traceRun&&!record.adopted&&record.traceRun.status==='running'&&typeof frCanonTraceFinish==='function'){
    record.traceRun.branchHidden=record.requiredBoundary!==true;
    frCanonTraceFinish(record.traceRun,'cancelled',{landed:false,reason:'提前任务已停止；必需边界的已执行记录仍保留'});
  }
  record.detach?.();if(frCanonEarlyCurrent===record)frCanonEarlyCurrent=null;
}
function frStartCanonEarlyPreparation(options) {
  var opts=options || {};frCancelCanonEarlyPreparation(frCanonEarlyCurrent);
  var record={archiveName:currentArchiveName,logId:opts.logId,storyText:String(opts.storyText || ''),userInput:String(opts.userInput || ''),parentSignal:opts.signal,controller:new AbortController(),startedAt:Date.now(),cancelled:false,stats:{queries:0,reused:0},queries:[]};
  record.boundaryReady=new Promise(function(resolve,reject){record.resolveBoundary=resolve;record.rejectBoundary=reject;});record.boundaryReady.catch(function(){});
  frCanonEarlyCurrent=record;
  var valid=function(){return frCanonEarlyCurrent===record && !record.cancelled && !record.parentSignal?.aborted && currentArchiveName===record.archiveName;};
  var relay=function(){frCancelCanonEarlyPreparation(record);};
  opts.signal?.addEventListener('abort',relay,{once:true});record.detach=function(){opts.signal?.removeEventListener('abort',relay);};
  frAiBackgroundSignals.add(record.controller.signal);
  record.ready=(async function(){
    try {
      var config=await ceBridgeLoadConfig(),native=await loadConcurrentEvolutionConfig();
      if((opts.requiredBoundary||config.preBoundaryEnabled===true)&&config.enabled!==false)return await frRunRequiredCanonPreparation(record,opts,config,valid);
      if(!valid() || record.claimed || config.enabled===false || config.earlyPreparationEnabled===false)return;
      if(config.earlyBoundaryEnabled!==false)return await frRunCanonNarrativePreparation(record,opts,config,valid);
      var stamp=await frCanonEarlySourceStamp();if(!stamp || !valid() || record.claimed)return;
      var core=ceBridgeCore(),timeline=await frTimelineLoadForCanon('提前只读资料',null),time=ceBridgeReadWorldTime(),ledger=await ceBridgeLoadLedger({worldTime:time}),rows=await ceBridgeReadStoredRows();
      if(!valid() || record.claimed)return;
      var cache=frCreateCanonEarlyCache({signal:opts.signal,preparationSignal:record.controller.signal,isCurrent:valid,sourceStamp:stamp,archiveName:record.archiveName,logId:opts.logId,boundaryEnabled:config.earlyBoundaryEnabled!==false,stop:function(){record.controller.abort(frCanonEarlyAbort());}});record.cache=cache;record.stats=cache.stats;record.queries=cache.queries;
      var host=cache.wrap(ceBridgeHost(record.controller.signal,null),true,stamp);
      // 即使编排器以后新增了写调用或模型调用，这个只读端口也没有执行权限。
      host.storageSet=async function(){throw frCanonEarlyAbort();};

      host.stateRead=function(){return typeof currentState==='object'?JSON.parse(JSON.stringify(currentState)):null;};
      host.uiStatus=function(){};host.uiThinking=function(){};
      await core.orchestrator.runCanonTurn({host:host,signal:record.controller.signal,worldTime:ledger?.worldTime || time,targetTime:time,timeline:timeline,storyText:frCanonMainStoryText(opts.storyText),playerInput:opts.userInput || '',logId:opts.logId,canonicalNames:ceBridgeCanonSearchScope(timeline,[]).allowlist,characters:ceBridgeReadCharacters(collectTitleNames(timeline),rows),beforeStateRows:ceBridgeGetBeforeState(),onScene:ceBridgeReadOnScene(),location:ceBridgeReadLocation(),debts:ledger?.debts,openEvents:ledger?.openEvents || [],eventProgress:ledger?.eventProgress || [],eventWatches:ledger?.eventWatches || [],mutationNotes:ledger?.mutationNotes || [],previousTurn:ledger?.lastTurn,hooks:ledger?.hooks,options:Object.assign({},ceBridgeProseDispatchConfig(config),{materials:ceBridgeMaterialsFor('guidance',config),onStage:function(name){if(name==='补演边界判定'&&config.earlyBoundaryEnabled===false)record.controller.abort(frCanonEarlyAbort());}})});
    } catch(error) {
      var failure=error instanceof Error?error:Object.assign(new Error(typeof frErrorText==='function'?frErrorText(error):String(error?.message||error||'提前任务异常')),error&&typeof error==='object'?error:{});
      record.rejectBoundary?.(failure);if(failure.name!=='AbortError')record.reason=failure.message;
      if(record.traceRun?.status==='running'&&typeof frCanonTraceFinish==='function')await frCanonTraceFinish(record.traceRun,failure.name==='AbortError'?'cancelled':'error',{landed:false,reason:failure.message});
    }
    finally {record.finishedAt=Date.now();record.detach();}
  })();
  return record;
}
async function frGetCanonEarlyHost(options,host) {
  var opts=options || {},record=opts.earlyPreparation;
  if(!record || record!==frCanonEarlyCurrent || record.cancelled || record.parentSignal?.aborted || opts.signal?.aborted || record.archiveName!==currentArchiveName || record.logId!==opts.logId || record.storyText!==String(opts.storyText || '') || record.userInput!==String(opts.userInput || ''))return host;
  try {
  // 普通演化已确认后，前台立即接管；只复用已完整取得的批次，不等低优先排队。
  record.claimed=true;record.controller.abort(frCanonEarlyAbort());
  if(record!==frCanonEarlyCurrent || record.cancelled || record.parentSignal?.aborted || opts.signal?.aborted || record.archiveName!==currentArchiveName || !record.cache)return host;
  if(typeof db!=='undefined' && db.archives){var archive=await db.archives.get(record.archiveName),latest=typeof frReplayLatestLog==='function'?frReplayLatestLog(archive):(archive?.data?.logs || []).filter(function(row){return row.type==='ai' && !row.isGhost;}).at(-1);if(!latest || latest.id!==record.logId)return host;}
  var stamp=await frCanonEarlySourceStamp();
  if(!stamp || record!==frCanonEarlyCurrent || record.cancelled || record.parentSignal?.aborted || record.archiveName!==currentArchiveName)return host;
  return record.cache.wrap(host,false,stamp,opts.signal);
  } catch(error) {record.reason=String(error.message || error);return host;}
}

// 同一条编排提前开始，正式阶段接续它；不再把已发的边界与故事请求重发一轮。
async function frRunCanonNarrativePreparation(record,opts,config,valid){
  record.narrative=true;record.sourceStamp=await frCanonEarlySourceStamp(true);
  if(!record.sourceStamp||!valid())return;
  var core=ceBridgeCore();
  if(typeof frCanonTraceBegin==='function'){
    if(typeof frCanonTraceLoad==='function')await frCanonTraceLoad();
    record.traceRun=frCanonTraceBegin('正文后补演',{signal:record.controller.signal,controller:record.controller,logId:record.logId});
  }
  var timeline=await frTimelineLoadForCanon('提前补演',record.traceRun),time=ceBridgeReadWorldTime(),ledger=await ceBridgeLoadLedger({worldTime:time}),rows=await ceBridgeReadStoredRows();
  if(!valid()||record.claimed)return;
  record.timelineStamp=ceBridgeCore()['canonical-json'].hashCanonicalJson(timeline);record.targetTime=time;
  record.ordinaryReady=new Promise(resolve=>{record.releaseOrdinary=resolve;});
  record.controller.signal.addEventListener('abort',function(){record.releaseOrdinary(null);},{once:true});
  var host=ceBridgeHost(record.controller.signal,record.traceRun),snapshot=typeof currentState==='object'?structuredClone(currentState):{};
  // 2026-10-31：这里原本只做 record.stats.queries++ 计数，没有持久化。
  // 但**真正的落库点不在这里**——补演走 frRunRequiredCanonPreparation →
  // prepareCanonTurnBoundary，检索由 canon-bridge.js 的 configs.vectorContext
  // 直调原始 getVectorContext 完成，绕过本文件的任何包装。
  // 因此「存资料」的修复写在 canon-bridge.js 那个真正的检索入口里。
  // 这里仅保留原有计数语义，不做二次包装，避免出现「以为修了其实没接上」的假象。
  if(typeof host.vectorContext==='function'){
    var rawVector=host.vectorContext;
    host.vectorContext=async function(){
      record.stats.queries++;
      var text=await rawVector.apply(host,arguments);
      host.vectorContext.lastReceipt=rawVector.lastReceipt;
      host.vectorContext.lastMaterialRequest=rawVector.lastMaterialRequest;
      return text;
    };
  }
  host.storageSet=async function(){throw frCanonEarlyAbort();};host.stateRead=function(){return structuredClone(snapshot);};
  var ordinary=async function(){var base=await record.ordinaryReady;if(!base||!valid())throw frCanonEarlyAbort();return base;};
  var dispatch=ceBridgeProseDispatchConfig(config);
  record.resultPromise=core.orchestrator.runCanonTurn({host:host,signal:record.controller.signal,worldTime:ledger?.worldTime||time,targetTime:time,timeline:timeline,storyText:frCanonMainStoryText(opts.storyText),playerInput:opts.userInput||'',logId:record.logId,canonicalNames:ceBridgeCanonSearchScope(timeline,[]).allowlist,characters:ceBridgeReadCharacters(collectTitleNames(timeline),ceBridgeGetBeforeState()||rows),beforeStateRows:ceBridgeGetBeforeState(),onScene:ceBridgeReadOnScene(),location:ceBridgeReadLocation(),debts:ledger?.debts,openEvents:ledger?.openEvents||[],eventProgress:ledger?.eventProgress||[],eventWatches:ledger?.eventWatches||[],mutationNotes:ledger?.mutationNotes||[],previousTurn:ledger?.lastTurn,hooks:ledger?.hooks,options:{...dispatch,materials:ceBridgeMaterialsFor('replay',config),awaitOrdinarySettlement:ordinary,onProseReady:async function(packet){await ordinary();return record.deliver?.(packet);},onStage:function(name,detail,view){if(record.traceRun&&typeof frCanonTraceEvent==='function'){frCanonTraceEvent(record.traceRun,'stage',name,detail);if(view)frCanonTracePublish(record.traceRun,view.kind==='prose'?'人物正文 · '+view.block.name:name,view);}}}});
  record.resultPromise.catch(function(){});
  return record.resultPromise;
}
async function frClaimCanonNarrativePreparation(options){
  var opts=options||{},record=opts.earlyPreparation;
  if(!record?.narrative)return null;
  if(!record.resultPromise){frCancelCanonEarlyPreparation(record);return null;}
  var matches=record===frCanonEarlyCurrent&&!record.cancelled&&!record.parentSignal?.aborted&&!opts.signal?.aborted&&record.archiveName===currentArchiveName&&record.logId===opts.logId&&record.storyText===String(opts.storyText||'')&&record.userInput===String(opts.userInput||'');
  try{
    var core=ceBridgeCore(),point=core.interval.parseTimePoint;
    matches=matches&&point(record.targetTime)===point(opts.targetTime)&&point(opts.targetTime)!==null;
    if(matches&&!record.requiredBoundary)matches=record.sourceStamp===await frCanonEarlySourceStamp(true)&&record.timelineStamp===ceBridgeCore()['canonical-json'].hashCanonicalJson(await frTimelineLoadForCanon('接续提前补演',null));
  }catch(_){matches=false;}
  if(!matches){if(record.requiredBoundary)throw new Error('当前正文或回合与前置边界不一致，请回到本轮对应记录继续，不能静默重跑整轮边界');frCancelCanonEarlyPreparation(record);return null;}
  record.claimed=true;return record;
}
async function frAdoptCanonNarrativePreparation(options){
  var opts=options||{},record=opts.earlyPreparation;
  if(!record?.narrative||!record.claimed||record.cancelled)return null;
  record.claimed=true;record.adopted=true;record.claimedAt=Date.now();record.deliver=opts.onProseReady;frAiBackgroundSignals.delete(record.controller.signal);
  if(typeof frAiRequestBudget==='object'&&frAiRequestBudget&&typeof frAiRequestBudget.promote==='function')frAiRequestBudget.promote();
  var abort=function(){record.controller.abort(opts.signal.reason);record.releaseOrdinary(null);};opts.signal?.addEventListener('abort',abort,{once:true});
  record.awaitOrdinaryWrite=opts.awaitOrdinaryWrite;
  record.floorContent=opts.floorContent;
  record.releasePrebuiltFloor?.();
  try{
    var settlement=opts.ordinarySettlement||{};
    if(record.preparedBoundary?.turnPlan?.route==='prebuilt'&&typeof frAwaitCanonPrebuiltSettlement==='function'){
      let started=false;
      record.startPrebuiltSettlement=function(){
        if(started)return;
        started=true;
        void frAwaitCanonPrebuiltSettlement({...opts,archiveName:record.archiveName,logId:record.logId,
          signal:record.controller.signal,storyText:record.storyText}).then(record.releaseOrdinary,error=>{
            record.releaseOrdinary({partial:true,failures:[{reason:String(error.message||error)}]});
          });
      };
      if(record.prebuiltSettlementRequested)record.startPrebuiltSettlement();
    }else record.releaseOrdinary(settlement);
    return await record.resultPromise;
  }finally{opts.signal?.removeEventListener('abort',abort);}
}

// 必需前置与旧低优先资料预热分开：并发/RPM为1也必须得到本轮分工。
async function frPrepareRequiredCanonBoundary(options){
  var opts=options||{},config=await ceBridgeLoadConfig();
  if(config.enabled===false)return null;
  opts.signal?.throwIfAborted();
  if(!opts.logId&&typeof db!=='undefined'&&db.archives){var archive=await db.archives.get(currentArchiveName),latest=typeof frReplayLatestLog==='function'?frReplayLatestLog(archive):(archive?.data?.logs||[]).filter(function(row){return row.type==='ai'&&!row.isGhost;}).at(-1);opts={...opts,logId:latest?.id};}
  var record=opts.earlyPreparation||frCanonEarlyCurrent;
  var matches=record?.requiredBoundary&&!record.adopted&&record.archiveName===currentArchiveName&&!record.cancelled&&!record.parentSignal?.aborted&&record.storyText===String(opts.storyText||'')&&record.userInput===String(opts.userInput||'')&&(!opts.logId||record.logId===opts.logId);
  if(!matches)record=frStartCanonEarlyPreparation({...opts,requiredBoundary:true});
  try{await record.boundaryReady;}catch(error){
    // 前置失败也属于这一楼层：保存已采用正文和自身pending，不能借下一轮跳过。
    if(opts.logId&&record.archiveName===currentArchiveName&&!opts.signal?.aborted&&typeof db!=='undefined'&&db.archives&&typeof saveToLog==='function'){
      var failedArchive=await db.archives.get(record.archiveName),existing=failedArchive?.data?.logs?.find(function(row){return row.id===opts.logId;});
      if(!existing){
        var floor=opts.adoptedFloor||{};
        await saveToLog(record.archiveName,{
          id:opts.logId,type:'ai',timestamp:floor.timestamp||new Date().toISOString(),
          content:floor.content??record.storyText,unoptimizedContent:floor.unoptimizedContent??record.storyText,
          branchContent:floor.branchContent??'',newsReference:floor.newsReference??'无',
          stateSnapshot:JSON.stringify(typeof currentState==='object'?currentState:{}),
          canonPending:{status:'failed',reason:String(error.message||error)}
        });
      }
      else if(typeof frCanonSetTurnPending==='function')await frCanonSetTurnPending(opts.logId,'failed',String(error.message||error));
    }
    throw error;
  }
  if(!record.preparedBoundary?.ok)throw new Error(record.reason||record.preparedBoundary?.reason||'本轮前置边界未完成');
  opts.signal?.throwIfAborted();
  if(record.cancelled||record.archiveName!==currentArchiveName)throw frCanonEarlyAbort();
  return record;
}
async function frRunRequiredCanonPreparation(record,opts,config,valid){
  record.requiredBoundary=true;record.narrative=true;
  frAiBackgroundSignals.delete(record.controller.signal);
  var core=ceBridgeCore();
  if(typeof core.orchestrator.prepareCanonTurnBoundary!=='function')throw new Error('核心缺少统一前置边界入口');
  record.sourceStamp=await frCanonEarlySourceStamp(true);
  if(!valid())throw frCanonEarlyAbort();
  if(typeof frCanonTraceBegin==='function'){
    if(typeof frCanonTraceLoad==='function')await frCanonTraceLoad();
    record.traceRun=frCanonTraceBegin('正文后补演',{signal:record.controller.signal,controller:record.controller,logId:record.logId});
  }
  var timeline=await frTimelineLoadForCanon('前置边界',record.traceRun),time=ceResolveCanonTargetTime(opts);
  // 重载后尚无轮前缓存；切档也不能借用上一档的时间。
  // 此处尚未执行普通变量，已加载存档仍是本轮起点；不以正文终点冒充起点。
  var start=(ceBridgeBeforeArchive===record.archiveName&&ceBridgeBeforeTime)||ceBridgeReadWorldTime();
  var ledger=await ceBridgeLoadLedger({worldTime:start}),rows=structuredClone(ceBridgeGetBeforeState()||await ceBridgeReadStoredRows());
  if(!valid())throw frCanonEarlyAbort();
  if(record.traceRun&&typeof frCanonTracePublish==='function')frCanonTracePublish(record.traceRun,'本轮读取的账本',{kind:'ledgerSnapshot',ledger:ledger});
  var host=ceBridgeHost(record.controller.signal,record.traceRun),snapshot=structuredClone(typeof currentState==='object'?currentState:{});
  host.storageSet=async function(){throw frCanonEarlyAbort();};host.stateRead=function(){return structuredClone(snapshot);};
  record.ordinaryReady=new Promise(function(resolve){record.releaseOrdinary=resolve;});
  record.controller.signal.addEventListener('abort',function(){record.releaseOrdinary(null);},{once:true});
  var ordinary=async function(){var base=await record.ordinaryReady;if(!base||!valid())throw frCanonEarlyAbort();return base;};
  var dispatch=ceBridgeProseDispatchConfig(config);
  var base={host:host,signal:record.controller.signal,worldTime:opts.openingStart||ledger?.worldTime||start,targetTime:time,bodyTimeKnown:!!time,timeline:timeline,storyText:frCanonMainStoryText(opts.storyText),playerInput:opts.userInput||'',logId:record.logId,archiveName:record.archiveName,canonicalNames:ceBridgeCanonSearchScope(timeline,[]).allowlist,characters:ceBridgeReadCharacters(collectTitleNames(timeline),rows),beforeStateRows:rows,onScene:ceBridgeReadOnScene(),location:ceBridgeReadLocation(),debts:ledger?.debts,openEvents:ledger?.openEvents||[],eventProgress:ledger?.eventProgress||[],eventWatches:ledger?.eventWatches||[],mutationNotes:ledger?.mutationNotes||[],previousTurn:ledger?.lastTurn,hooks:ledger?.hooks,options:{...dispatch,materials:ceBridgeMaterialsFor('replay',config),bodyTimeKnown:!!time,canonPushBoundaryVersion:1,ordinaryIndependent:true,onProseReady:async function(packet){await ordinary();return record.deliver?.(packet);},onStage:function(name,detail,view){if(record.traceRun&&typeof frCanonTraceEvent==='function'){frCanonTraceEvent(record.traceRun,'stage',name,detail);if(view)frCanonTracePublish(record.traceRun,view.kind==='prose'?'人物正文 · '+view.block.name:name,view);}}}};
  base.turnNo=(Number(ledger?.turnNo)||0)+1;
  base.prebuiltActorDifferences=ledger?.prebuiltActorDifferences||[];
  // This live entry point reserves canon actors before the ordinary runner can start.
  base.options.prebuiltOrdinaryExclusive=true;
  base.options.awaitPrebuiltSettlement=function(){
    record.prebuiltSettlementRequested=true;
    record.startPrebuiltSettlement?.();
    return ordinary();
  };
  if(typeof frCreatePrebuiltLanding==='function'){
    const floorReady=new Promise(resolve=>{record.releasePrebuiltFloor=resolve;});
    record.controller.signal.addEventListener('abort',record.releasePrebuiltFloor,{once:true});
    const landing=frCreatePrebuiltLanding({logId:record.logId,archiveName:record.archiveName,signal:record.controller.signal,
      get floorContent(){return record.floorContent;},storyText:record.storyText,timelineSource:record.traceRun?._timelineSource,
      awaitFloor:()=>floorReady,
      awaitSettlement:base.options.awaitPrebuiltSettlement});
    base.options.prebuiltLanding=landing;
    base.options.preparePrebuiltProposal=landing.prepare;
  }else base.options.preparePrebuiltProposal=function(payload){
    return frPrepareCanonPrebuiltProposal(payload,{logId:record.logId,archiveName:record.archiveName,signal:record.controller.signal,
      awaitOrdinaryWrite:record.awaitOrdinaryWrite,floorContent:record.floorContent,storyText:record.storyText});
  };
  record.boundaryInput=base;
  if(record.traceRun&&typeof frCanonTracePublish==='function')frCanonTracePublish(record.traceRun,'前置边界输入',{kind:'boundaryInput',start:base.worldTime,end:base.targetTime,bodyTimeKnown:base.bodyTimeKnown,storyChars:base.storyText.length,timelineCount:timeline.length});
  console.warn('[原著补演] 前置边界输入',JSON.stringify({logId:record.logId,start:base.worldTime,end:base.targetTime,bodyTimeKnown:base.bodyTimeKnown,storyChars:base.storyText.length,timelineCount:timeline.length}));
  var receipt=await core.orchestrator.prepareCanonTurnBoundary(base);
  if(!valid())throw frCanonEarlyAbort();
  record.preparedBoundary=receipt;record.boundaryFinishedAt=Date.now();
  if(!receipt.ok){record.reason=receipt.reason;throw new Error(receipt.reason||'前置边界未完成');}
  // 并行入口也必须在任何变量/物品异常之前封存完整边界，不能等整轮成功。
  if(typeof frCanonBoundarySave==='function'){
    await frCanonBoundarySave(record.archiveName,record.logId,receipt,'canon');
    if(!valid())throw frCanonEarlyAbort();
    if(typeof frCanonBoundaryPrune==='function')await frCanonBoundaryPrune(record.archiveName,record.logId,'canon');
  }
  record.targetTime=receipt.range?.end||base.targetTime;
  if(record.traceRun&&typeof frCanonTracePublish==='function')frCanonTracePublish(record.traceRun,'本轮实际分工',{kind:'routing',turnPlan:receipt.turnPlan});
  // 正文已确定事实；普通阶段只把事实落地，不再自动请求AI复判边界。
  record.reconcile=async function(){return record.reconciliation||(record.reconciliation={ok:true,preparedBoundary:receipt,invalidatedActorRefs:[],continuationJobs:[],needsContinuation:false});};
  if(receipt.turnPlan?.route==='prebuilt'||!(receipt.turnPlan?.canonJobs||[]).length){
    record.resultPromise=core.orchestrator.runCanonTurn({...base,targetTime:record.targetTime,preparedBoundary:receipt});
    record.resultPromise.catch(function(){});record.resolveBoundary?.(receipt);return record.resultPromise;
  }
  var nativeConfig={...await loadConcurrentEvolutionConfig(),maxConcurrency:config.maxConcurrency || 5,requestTimeout:config.requestTimeoutMs || 120000,retryCount:config.retry?.maxRetries ?? 2,parseRetryCount:config.retry?.maxRetries ?? 2},preset=await getActiveConcurrentEvolutionPreset();
  record.reservedTargets=await frResolveCanonTargets({blocks:receipt.turnPlan.canonJobs.map(function(job){return {name:job.name,body:''};}),sharedContext:buildSharedEvolutionContext(opts.storyText,opts.userInput),config:{...nativeConfig,canonCompletionEnabled:true},signal:record.controller.signal});
  var boundary={archiveName:record.archiveName,logId:record.logId,actorCommits:{},settlementBase:null};
  record.earlyBoundary=boundary;
  record.earlyPipeline=frCreateCanonCharacterPipeline({resolvedTargets:record.reservedTargets,boundary:boundary,signal:record.controller.signal,sharedContext:buildSharedEvolutionContext(opts.storyText,opts.userInput),config:{...nativeConfig,batchLimits:config.batchLimits,canonCompletionEnabled:true,completionRepairCount:config.completionRepairCount??1,readyBatchWaitMs:config.readyBatchWaitMs??100},preset:preset,traceRun:record.traceRun,trustedBoundary:true,
    awaitCommitBoundary:async function(){await ordinary();Object.assign(boundary,await frCaptureCanonBoundary(record.logId));}});
  record.pendingDeliveries=[];
  base.options.onProseReady=function(packet){var delivery=record.earlyPipeline.enqueue(packet);record.pendingDeliveries.push(delivery);delivery.catch(function(){});return Promise.resolve([]);};
  record.resultPromise=(async function(){
    var result=await core.orchestrator.runCanonTurn({...base,targetTime:record.targetTime,preparedBoundary:receipt});
    if(!result.prebuiltProposal&&String(result.worldForMisc||'').trim())record.preparedMisc=await requestMiscEvolutionPhase({preset:frCloneCanonPreset(preset),config:nativeConfig,signal:record.controller.signal,proposalOnly:true,sharedContext:{...buildSharedEvolutionContext(opts.storyText,opts.userInput),canonProseOnly:true,canonWorldEvidence:result.worldForMisc,storyText:result.worldForMisc},storyText:result.worldForMisc});
    return result;
  })();
  record.resultPromise.catch(function(){});
  record.resolveBoundary?.(receipt);
  return record.resultPromise;
}
function frCanonExcludedRefs(plan){
  return new Set([...(plan?.canonOwnedRefs||plan?.prebuiltActorRefs||[]),
    ...(plan?.canonJobs||[]).flatMap(function(row){return [row.actorRef,row.name];}),
    ...(plan?.deferredRefs||[])].filter(Boolean).map(String));
}
// 普通变量演化只消费已就绪的分工。不能创建、接管或取消原著任务。
async function frReadCanonPlanForOrdinary(options){
  var src=options||{},record=src.earlyPreparation,archive=currentArchiveName,logId=String(src.logId||'');
  if(!archive||!logId)return null;
  if(record?.requiredBoundary&&record.archiveName===archive&&String(record.logId)===logId&&record.preparedBoundary?.ok)return record.preparedBoundary.turnPlan||null;
  if(typeof frCanonBoundaryLoad!=='function')return null;
  var boundary=await frCanonBoundaryLoad(archive,logId,'canon');
  if(archive!==currentArchiveName)throw frCanonEarlyAbort();
  return boundary?.ok?ceBridgeCore().orchestrator.routeFrozenCanonBoundary(boundary).turnPlan||null:null;
}
function frCanonOrdinaryTargets(targets,plan){
  var excluded=frCanonExcludedRefs(plan);
  return (targets||[]).filter(function(row){return row.id==='B1'||(!excluded.has(String(row.id))&&!excluded.has(String(row.name)));});
}
function frCanonOrdinaryOperations(operations,plan){
  var excluded=frCanonExcludedRefs(plan);
  var touches=function(value){if(!value||typeof value!=='object')return false;return [value.id,value.targetId,value.characterId,value.owner,value.from,value.to,value.data?.['0'],value.data?.owner,value.data?.from,value.data?.to].some(function(id){return excluded.has(String(id));});};
  return (operations||[]).filter(function(op){return !touches(op);});
}
function frCanonOwnershipInstruction(plan){
  var refs=Array.from(frCanonExcludedRefs(plan));
  return refs.length?'\n【本轮统一分工】以下人物由原著补演或待补资料任务独占，普通阶段只读其快照作背景，不给他们自由演化、物品或人物变量提案：'+JSON.stringify(refs)+'。主角、时间、场景、地图和任务仍按原职责处理。':'';
}

function frFilterCanonOrdinaryDelta(delta,record){
  if(!Array.isArray(delta)||!record?.requiredBoundary||record.cancelled||record.parentSignal?.aborted||record.archiveName!==currentArchiveName)return delta;
  var filtered=frCanonOrdinaryOperations(delta,record.preparedBoundary?.turnPlan);delta.splice(0,delta.length,...filtered);return delta;
}

function frMergeCanonContinuation(first,resumed,names,reconciliation){
  var replaced=new Set(names||[]),out={...first,...resumed,reconciliation:reconciliation};
  out.prose=[...(first.prose||[]).filter(function(block){return !replaced.has(block.name);}),...(resumed.prose||[])];
  out.proseText=out.prose.map(function(block){return block.body||'';}).join('\n\n');
  out.biography={...Object.fromEntries(Object.entries(first.biography||{}).filter(function(pair){return !replaced.has(pair[0]);})),...(resumed.biography||{})};
  for(var key of ['debts','backstoryDebts','worldDebts','unowned']){
    var retained=(first[key]||[]).filter(function(row){return !replaced.has(typeof row==='string'?row:row.name||row.actor||row.actorName);});
    out[key]=[...retained,...(resumed[key]||[])];
  }
  var progress=new Map((first.eventProgress||[]).map(function(row){return [row.eventId,row];}));
  (resumed.eventProgress||[]).forEach(function(row){progress.set(row.eventId,row);});out.eventProgress=Array.from(progress.values());
  var incomplete=['debts','backstoryDebts','worldDebts','unowned'].some(function(key){return out[key].length;});
  // 未定位的原轮失败不得被另一人的成功接续掩盖。
  if(incomplete||first.status!=='ok'||resumed.status!=='ok'){
    out.status='incomplete';out.landed=false;out.ok=false;out.reason=first.status!=='ok'?first.reason||'原轮仍有未恢复步骤':resumed.reason||'本轮仍有未完成任务';
    if(out.ledgerPlan)out.ledgerPlan={...out.ledgerPlan,landed:false};
  }else if(out.ledgerPlan?.next){out.ledgerPlan={...out.ledgerPlan,next:{...out.ledgerPlan.next,eventProgress:out.eventProgress}};}
  return out;
}


// ===== 补演资料快照：把本轮检索到的资料存下来，重跑时不必重新检索 =====
// 与轮内缓存（frCreateCanonEarlyCache，只活一轮）互补：这里是跨轮持久层。
var FR_CANON_MATERIALS_PREFIX='FR_CANON_MATERIALS_V1:';
function frCanonMaterialsKeep(){
  // 保留几层楼的检索资料。
  //
  // ★ 2026-11-02 复盘修正：这里原来写「默认 1」，与 canonical 配置
  //   canon-bridge.js 的 materialsKeep:3 不一致，读代码的人会以为只留一层。
  //   实际口径以配置为准：默认 1 层 —— 只保留本回合。
  //   （玩家 2026-11-02：「不存在玩家回退回合后还打算用旧资料重跑的情况，
  //     这是个伪命题。」所以多留几层没有任何实际用处。）
  //   这里的 Math.max(1,...) 只是防御：配置缺失/为 0/为负数时兜底成 1，
  //   保证「至少留下当前这一层」，绝不因为配置异常把本轮资料也清掉。
  //
  //   保留轮数只决定**存多久、能翻看多远**，不决定**能不能拿来复用**：
  //   重跑时真正复用的永远是本回合那一份（见 frReplayReadContext 的 source）。
  var raw=typeof ceBridgeLastConfig==='object'&&ceBridgeLastConfig?ceBridgeLastConfig.materialsKeep:undefined;
  return Math.max(1,Math.min(30,Number(raw)||1));
}
// 沙箱或早期阶段可能还没有全局存档名，取不到就退化为空串，不能抛错。
function frCanonMaterialsArchiveName(explicit){
  if(explicit)return explicit;
  return typeof currentArchiveName==='string'?currentArchiveName:'';
}
function frCanonMaterialsKey(archiveName,logId){
  var name=archiveName|| (typeof currentArchiveName==='string'?currentArchiveName:'');
  return FR_CANON_MATERIALS_PREFIX+String(name||'')+':'+String(logId||'');
}
// 检索参数的复用口径直接沿用轮内缓存那把尺，避免两套标准打架。
function frCanonMaterialQueryKey(query,request){
  var r=request||{};
  return JSON.stringify([String(query),r.referenceTime||'',r.characterNames||[],r.queryBatchSize||32,r.materialRequestScope||null,r.queries||null,r.queryTexts||null]);
}
async function frCanonMaterialsDigest(text){
  try{
    if(!globalThis.crypto?.subtle)return '';
    var buf=new TextEncoder().encode(String(text||''));
    var out=await crypto.subtle.digest('SHA-256',buf);
    return Array.from(new Uint8Array(out)).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
  }catch(_){return '';}
}
// ---------- 原著指导产物的回收（只删更早楼层，本轮内完整保留） ----------
/* ★★★ 2026-11-03 玩家拍板定下的目的与口径（原话）：
 *   「原著指导的话需要达到的目的是本轮重roll正文的时候可以复用就行了。」
 *   「可以，那就落实刚才你打算的修复」。
 *
 * 【为什么要有它】
 * 指导产物存在 FR_CANON_GUIDANCE_V1:<存档>:<楼层号>，
 * 原来只有 dbGet / dbSet，**一次删除都没有** —— 每打一层楼就永久多一份，从不回收。
 * 补演资料那边早就有 frCanonMaterialsPrune 做同类回收，指导这边漏了。
 *
 * 【为什么只删「更早楼层」】
 * 能否复用由 ceCanonSameInput 判定：存档名 + 时间 + 玩家输入三样都没变才复用。
 * 同一层楼内重roll正文，这三样不变 → 直接命中复用分支，**根本不读旧楼层的键**。
 * 一旦推进到下一层，楼层号变了，旧键的 key 永远对不上，
 * 既不会被复用也不会被读取 —— 纯粹占地方。
 *
 * 所以范围严格限定为「楼层号 < 当前楼层」：
 *   · 当前层：本轮重roll正文靠它复用，绝不能删；
 *   · 更晚的楼层：可能是从别的分支回退回来后留下的，不归这里管，也不删。
 *
 * 【实现】用 settings 表 toArray() 按前缀精确筛，
 * 再按「:」后那段是否是纯数字楼层号判断，只处理数字楼层。
 * 不猜区间 —— 猜区间会漏掉稀疏的历史键。
 */
// ---------- 本轮阶段产物（局部重跑的数据底座） ----------
/* ★★★ 2026-11-03 玩家拍板（原话）：
 *   「那个运行记录是指思考展示区域的运行记录……而补演流程过程中生成的数据
 *     在本轮中都应该作为持久性数据资料存在。我的需求就是哪里错了可以针对性重跑哪里。」
 *   「只在本轮存，重roll，推进，回退后都清理」
 *
 * 【为什么必须另建一张表】
 * 局部重跑面板的目标列表原来整份取自 frCanonTraceHistory —— 那是**思考展示区**的运行记录，
 * 纯内存（canon-observability.js:1015 明确不读 FR_CANON_TRACE_V1，因该表在玩家机器上已达 628MB），
 * 切存档/重启即清空，启动时还会主动删表。
 * 于是「展示区没内容」和「补演没跑过」在数据上是同一件事，
 * 面板必然显示 0/0，局部重跑在重启后永远不可用。
 *
 * 这两个用途必须分开：
 *   · 展示（含思考过程 events、完整提示词回放）→ 纯内存，重启就没，这是对的；
 *   · 重跑数据底座（阶段产物、状态、结果）→ 落库，只留本轮。
 *
 * 【存什么】
 * 每条请求只留重跑真正需要的：stageKey / subject / targetId / targetIds / status / cacheKey /
 * response（结果可复用）/ messages（精确重算用）。**不存 events**（那是展示用的思考过程）。
 * 【存多少】只存当前这一层的键，一层一条，不跨层累积。
 */
var FR_CANON_TURN_ARTIFACTS_PREFIX='FR_CANON_TURN_ARTIFACTS_V1:';
function frCanonTurnArtifactsKey(archiveName,logId,system){
  var name=archiveName||(typeof currentArchiveName==='string'?currentArchiveName:'');
  return FR_CANON_TURN_ARTIFACTS_PREFIX+String(name||'')+':'+String(logId||'')+(system?':'+(system==='ce'?'ce':'canon'):'');
}
// 把运行记录里的一条请求压成可执行重跑的最小形态。
// 当前楼执行材料独立于完整诊断。大小上限拒绝整项，不截断命令或故事。
function frCanonReplayBounded(value,maxChars){
  try{var text=JSON.stringify(value);return text&&text.length<=(maxChars||16*1024*1024)?JSON.parse(text):null;}catch(_){return null;}
}
function frCanonReplayResponse(value,maxChars){
  var content=value?.choices?.[0]?.message?.content;
  if(typeof content!=='string')return null;
  content=content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,'');
  return frCanonReplayBounded({choices:[{message:{content:content}}]},Math.min(maxChars||2*1024*1024,2*1024*1024));
}
function frCanonReplayResult(value,maxChars){
  if(!value||typeof value!=='object')return null;
  var out={};
  if(value.prebuiltRepair)out.prebuiltRepair=value.prebuiltRepair;
  ['status','ok','landed','reason','landReason','aborted','rolledBack','partial','actorProgressSaved','range','worldTime','endTime','prose','continuationInput','worldState','materialState','mergedReplayReceipt','debts','backstoryDebts','worldDebts','unconfirmedEvents','failedBatches','progressFailure','blockedOps','retry','failedStages','failedScopes','replayCleared','boundaryStale','unowned'].forEach(function(key){if(value[key]!==undefined)out[key]=value[key];});
  if((value.status==='ok'||value.actorProgressSaved===true)&&value.ledgerPlan?.changed===true&&value.ledgerPlan.next){
    ['ledgerPlan','biography','canonReferences','worldForMisc','worldNoChanges'].forEach(function(key){if(value[key]!==undefined)out[key]=value[key];});
  }
  if(Array.isArray(value.boundaryChangedFields))out.boundaryChangedFields=value.boundaryChangedFields.slice();
  if(value.commit)out.commit={blockedOps:value.commit.blockedOps,miscReceipt:value.commit.miscReceipt?{blockedOps:value.commit.miscReceipt.blockedOps}:undefined};
  if(value.continuationInput){
    var resume=value.continuationInput,allowed={};
    ['saveId','archiveName','branchId','logId','turnNo','worldTime','targetTime','storyText','playerInput','characters','beforeStateRows','onScene','location','debts','openEvents','eventProgress','prebuiltActorDifferences','eventWatches','mutationNotes','previousTurn','hooks','canonicalNames','materialState'].forEach(function(key){if(resume.data?.[key]!==undefined)allowed[key]=resume.data[key];});
    out.continuationInput={version:resume.version,timeline:resume.timeline,data:allowed};
    if(resume.preparedBoundary){var prepared={};['ok','reason','inputStamp','resolvedInputStamp','range','storyAnalysis','turnPlan','analysisActors','candidates','boundaryBackground','retrievalReceipt','endpointReceipt'].forEach(function(key){if(resume.preparedBoundary[key]!==undefined)prepared[key]=resume.preparedBoundary[key];});out.continuationInput.preparedBoundary=prepared;}
  }
  return frCanonReplayBounded(out,Math.min(maxChars||16*1024*1024,16*1024*1024));
}
function frCanonReplayCapture(run,type,label,value){
  if(!run||!['变量演化','正文后补演'].includes(run.phase)||!value)return;
  if(label==='补演解析与账本计划'){
    run.executionResult=frCanonReplayResult(value);
    if(!run.executionResult)run.replayUnavailable='本轮执行回执超过16Mi字符或无法序列化，未截断保存；缺失阶段需要重新获取';
  }
  if(type!=='view'||!['prose','characters','continuationInput','replayMaterial'].includes(value.kind))return;
  var view={};
  var fields=value.kind==='prose'?['kind','block','accepted']:value.kind==='characters'?['kind','name','actorId','id','status','reason','completion','row']:value.kind==='continuationInput'?['kind','input']:['kind','name','material','proseStage'];
  fields.forEach(function(key){if(value[key]!==undefined)view[key]=value[key];});
  if(value.kind==='continuationInput')view.input=frCanonReplayResult({continuationInput:value.input})?.continuationInput;
  var key=value.kind+':'+String(value.name||value.block?.name||''),views=(run.executionViews||[]).filter(function(row){return row.key!==key;});
  views.push({key:key,type:'view',data:view});
  var bounded=frCanonReplayBounded(views);
  if(bounded)run.executionViews=bounded;else run.replayUnavailable='本轮必要视图超过16Mi字符或无法序列化，未截断保存；缺失阶段需要重新获取';
}
function frCanonArtifactOfRequest(req){
  if(!req||typeof req!=='object')return null;
  var stageKey=String(req.stageKey||'');
  if(!stageKey)return null;
  return {
    stageKey:stageKey,
    id:String(req.id||''),
    stage:String(req.stage||''),
    subject:String(req.subject||''),
    targetId:String(req.targetId||''),
    targetIds:Array.isArray(req.targetIds)?req.targetIds.slice():[],
    status:String(req.status||''),
    ...(req.mergedAccepted===true?{mergedAccepted:true}:{}),
    ...(Array.isArray(req.mergedPhases)?{mergedPhases:req.mergedPhases.slice()}:{}),
    ...(Array.isArray(req.replayExcludedScopes)?{replayExcludedScopes:req.replayExcludedScopes.slice()}:{}),
    model:String(req.model||''),
    // 仅是同楼同目标语义复用身份；绝不能冒充精确提示词命中。
    cacheKey:'replay-semantic:'+String(req.id||''),
    semanticOnly:true,
    archiveName:String(req._run?.archiveName||req.archiveName||''),
    logId:String(req._run?.logId||req.logId||''),
    system:req._run?(req._run.phase==='变量演化'?'ce':'canon'):String(req.system||''),
    /* 结果可复用：模型原始返回。缺了它就只能重算，所以必须留下。 */
    response:req.replayUnavailable?null:frCanonReplayResponse(req.replayResponse||req.response),
    /* 精确重算：原始提示词。玩家要的是「哪里错了针对性地重跑哪里」，
     * 少了它就拼不回同一次调用。 */
    messages:null,
    ...(req.replayUnavailable?{replayUnavailable:req.replayUnavailable}:{}),
    startedAt:req.startedAt||0,
    endedAt:req.endedAt||0
  };
}
async function frCanonTurnArtifactsSave(archiveName,logId,requests,system,execution){
  if(typeof dbSet!=='function')return null;
  if(!logId)return null;
  try{
    var rows=(Array.isArray(requests)?requests:[]).map(frCanonArtifactOfRequest).filter(Boolean);
    if(!rows.length&&!execution)return null;
    var responseChars=0;
    rows.forEach(function(req){var size=JSON.stringify(req.response||null).length;if(responseChars+size>16*1024*1024){req.response=null;req.replayUnavailable='本轮必要响应超过16Mi字符，未截断保存；本阶段需重新获取';}else responseChars+=size;});
    system=system==='ce'?'ce':'canon';
    var key=frCanonTurnArtifactsKey(archiveName,logId,system);
    var row={
      archiveName:String(archiveName||currentArchiveName||''),
      logId:String(logId),
      system:String(system||'canon'),
      requests:rows,
      count:rows.length,
      sealedAt:Date.now()
    };
    if(execution){
      row.executionResult=frCanonReplayResult(execution.executionResult||execution.result);
      row.executionViews=frCanonReplayBounded(execution.executionViews||[]);
      if(execution.replayUnavailable)row.replayUnavailable=execution.replayUnavailable;
      if(!row.executionResult&&(execution.executionResult||execution.result))row.replayUnavailable='本轮执行回执超过16Mi字符或无法序列化，未截断保存；边界、成功故事及接续材料需要重新获取';
      if(!frCanonReplayBounded({result:row.executionResult,views:row.executionViews})){
        row.executionResult=null;row.executionViews=[];row.replayUnavailable='本轮执行回执与必要视图合计超过16Mi字符，未截断保存；缺失阶段需要重新获取';
      }
    }
    await dbSet(key,row);
    await frCanonTurnArtifactsPrune(row.archiveName,row.logId,system);
    return row;
  }catch(error){
    console.warn('[阶段产物] 保存失败：'+String(error&&error.message||error),error);
    return null;
  }
}
async function frCanonTurnArtifactsLoad(archiveName,logId,system){
  if(typeof dbGet!=='function')return null;
  try{
    var legacyKey=frCanonTurnArtifactsKey(archiveName,logId);
    var keys=system?[frCanonTurnArtifactsKey(archiveName,logId,system),legacyKey]:[legacyKey,frCanonTurnArtifactsKey(archiveName,logId,'canon'),frCanonTurnArtifactsKey(archiveName,logId,'ce')];
    for(var key of keys){
    var row=await dbGet(key).catch(function(){return null;});
    if(!row||!Array.isArray(row.requests)||(!row.requests.length&&!row.executionResult&&!row.executionViews?.length))continue;
    /* 系统必须对得上，两条线路各用各的产物，绝不串用。 */
    if(String(row.archiveName||'')!==String(archiveName||currentArchiveName||''))continue;
    if(String(row.logId||'')!==String(logId||''))continue;
    if(system&&String(row.system||'canon')!==String(system))continue;
    return row;
    }
    return null;
  }catch(_){return null;}
}
/* ★★★ 2026-11-03 玩家定：局部重跑不该从「补演边界判定」重跑整轮。
 *
 * 玩家原话：「我全选失败项重跑，从补演边界判定开始重跑了，逻辑是不是还是不对？」
 *          「上一阶段的结果本质上不就是下一阶段的资料吗？」
 *
 * 【要解决的问题】
 * 前置分工（preparedBoundary）是补演流程的第一阶段，它算出本轮：
 *   · 从哪段原文到哪段（range）
 *   · 有哪些原著任务、每个人分到哪些事件（turnPlan.decisions / canonJobs）
 *   · 正文里已经把谁处理过了（storyAnalysis.handled）
 *   · 本轮世界发生了什么（storyAnalysis.worldEvents）
 * 这些**全是下游要用的输入**，本来就是「第一阶段的结果」。
 * 但原来它只活在一次运行的闭包里，重跑时又从头算一遍 ——
 * 于是玩家勾 13 项，实际跑 53 项（边界一变，下游按指纹比对全部失配）。
 *
 * 【做法】算完就原样存下来，重跑时按 logId 取回直接复用。
 * 存的是**完整对象**，不做任何裁剪 —— 裁剪过的副本会让下游
 * 误判「谁都没处理过」，比不复用更糟。
 *
 * 【生命周期与本轮产物完全一致】
 * 都用 frCanonTurnArtifactsPrune 那条「只保留 currentLogId」的清理规则，
 * 换层/回退/重roll 就丢，不会跨层污染。
 */
var FR_CANON_BOUNDARY_PREFIX='FR_CANON_BOUNDARY_V1:';
function frCanonBoundaryKey(archiveName,logId){return FR_CANON_BOUNDARY_PREFIX+String(archiveName||'')+':'+String(logId||'');}
async function frCanonBoundarySave(archiveName,logId,boundary,system){
  if(typeof dbSet!=='function'||!logId||!boundary)return null;
  try{
    var row={archiveName:String(archiveName||currentArchiveName||''),logId:String(logId),system:String(system||'canon'),boundary:boundary,sealedAt:Date.now()};
    await dbSet(frCanonBoundaryKey(row.archiveName,row.logId),row);
    return row;
  }catch(error){
    console.warn('[前置分工] 保存失败：'+String(error&&error.message||error),error);
    return null;
  }
}
async function frCanonBoundaryLoad(archiveName,logId,system){
  if(typeof dbGet!=='function'||!logId)return null;
  try{
    var row=await dbGet(frCanonBoundaryKey(archiveName||currentArchiveName,logId)).catch(function(){return null;});
    if(!row||!row.boundary)return null;
    if(String(row.archiveName||'')!==String(archiveName||currentArchiveName||''))return null;
    if(system&&String(row.system||'canon')!==String(system))return null;
    return row.boundary;
  }catch(_){return null;}
}
// Prefix queries must not materialize unrelated replay snapshots from settings.
async function frCanonSettingsRowsByPrefix(prefix){
  var table=db.settings;
  if(typeof table.where==='function'){
    var where=table.where('key');
    if(where&&typeof where.startsWith==='function')return await where.startsWith(prefix).toArray();
  }
  // Older adapters: enumerate keys only, then fetch matching records. Never fall
  // back to table.toArray(), which also clones multi-gigabyte replay baselines.
  var collection=typeof table.toCollection==='function'?table.toCollection():null;
  if(!collection||typeof collection.primaryKeys!=='function'||typeof table.get!=='function')return [];
  var keys=await collection.primaryKeys(),rows=[];
  for(var key of keys){
    if(typeof key!=='string'||!key.startsWith(prefix))continue;
    var row=await table.get(key);if(row)rows.push(row);
  }
  return rows;
}
async function frCanonBoundaryPrune(archiveName,currentLogId,system){
  try{
    if(typeof dbSet!=='function')return 0;
    if(typeof db==='undefined'||!db||!db.settings)return 0;
    var name=archiveName||(typeof currentArchiveName==='string'?currentArchiveName:'');
    if(!name)return 0;
    var keep=String(currentLogId||''),prefix=FR_CANON_BOUNDARY_PREFIX+name+':',removed=0;
    var rows=await frCanonSettingsRowsByPrefix(prefix);
    for(var r of rows){
      var key=String(r&&r.key||'');
      if(key.indexOf(prefix)!==0)continue;
      if(key.slice(prefix.length)===keep)continue;
      if(system&&r.value&&String(r.value.system||'canon')!==String(system))continue;
      await db.settings.delete(key);removed++;
    }
    return removed;
  }catch(_){return 0;}
}


/* 清理：保留 currentLogId 那一份，删掉本存档其它的。
 * 推进到下一层、回退到上一层、重roll 后重新采集时都会调用到，
 * 结果就是「只在本轮存」，不会跨层累积。 */
async function frCanonTurnArtifactsPrune(archiveName,currentLogId,system){
  try{
    if(typeof dbSet!=='function')return 0;
    if(typeof db==='undefined'||!db||!db.settings)return 0;
    var name=archiveName||(typeof currentArchiveName==='string'?currentArchiveName:'');
    if(!name)return 0;
    var keep=String(currentLogId||'');
    var prefix=FR_CANON_TURN_ARTIFACTS_PREFIX+name+':';
    var rows=await frCanonSettingsRowsByPrefix(prefix),removed=0;
    for(var r of rows){
      var key=String(r&&r.key||'');
      if(key.indexOf(prefix)!==0)continue;
      var rowSystem=r.value?String(r.value.system||'canon'):key.endsWith(':ce')?'ce':key.endsWith(':canon')?'canon':'';
      if(system&&rowSystem!==system)continue;
      var logId=r.value&&r.value.logId!==undefined?String(r.value.logId):key.slice(prefix.length).replace(/:(ce|canon)$/,'');
      if(keep&&logId===keep)continue;      // 当前这一层留着
      await dbSet(key,null);
      removed++;
    }
    return removed;
  }catch(_){return 0;}
}
// 重roll / 回退 时显式丢掉本层产物：这一层要重新跑，旧产物一律作废。
async function frCanonTurnArtifactsDrop(archiveName,logId){
  try{
    if(typeof dbSet!=='function')return;
    for(var system of [null,'ce','canon'])await dbSet(frCanonTurnArtifactsKey(archiveName,logId,system),null);
  }catch(_){}
}

async function ceCanonPruneOlderGuidance(archiveName,currentFloor){
  try{
    if(typeof dbSet!=='function')return;
    if(typeof db==='undefined'||!db||!db.settings)return;
    var name=archiveName|| (typeof currentArchiveName==='string'?currentArchiveName:'');
    if(!name)return;
    var cur=Number(currentFloor);
    if(!isFinite(cur)||cur<=1)return;        // 第 1 层没有更早的
    var prefix='FR_CANON_GUIDANCE_V1:'+name+':';
    var rows=await frCanonSettingsRowsByPrefix(prefix);
    for(var r of rows){
      var key=String(r&&r.key||'');
      if(key.indexOf(prefix)!==0)continue;
      var tail=key.slice(prefix.length);
      if(!/^\d+$/.test(tail))continue;        // 非数字楼层不管
      var floor=Number(tail);
      if(!(floor<cur))continue;               // 当前层与更晚楼层一律保留
      await dbSet(key,null);
    }
  }catch(_){}
}

async function frCanonMaterialsSave(archiveName,logId,patch){
  if(!logId||typeof dbSet!=='function')return null;
  var key=frCanonMaterialsKey(archiveName,logId);
  var row=await dbGet(key).catch(function(){return null;});
  row=row&&typeof row==='object'?row:{archiveName:archiveName,logId:logId,rows:{},createdAt:Date.now()};
  row.rows=row.rows||{};
  Object.assign(row.rows,patch||{});
  row.updatedAt=Date.now();
  await dbSet(key,row);
  await frCanonMaterialsPrune(archiveName,logId);
  return row;
}
// 取一条可复用的检索资料；硬失效条件任一命中就返回 null，宁可重检索也不给错资料。
//
// 玩家口径（2026-10-31）：
//   「如果我已经推进剧情到下一层了，这个资料就可以清理了，在本层必须一直在。
//     因为我的目的是在本层重跑原著补演的时候不要再检索一遍资料。」
// 所以这里**严格按楼层**：只认本层（logId）自己的资料，绝不跨层借用别层结果。
// 本层资料的清理交给 frCanonMaterialsPrune 在推进到新楼层后做。
async function frCanonMaterialsTake(archiveName,logId,queryKey){
  try{
    if(!queryKey)return null;
    var row=await frCanonMaterialsLoad(archiveName,logId);
    if(!row||!row.rows)return null;
    var hit=row.rows[queryKey];
    if(!hit||typeof hit.text!=='string')return null;
    // 硬失效一：存档名变了。
    if(String(row.archiveName||'')!==String(archiveName||''))return null;
    // 硬失效二：楼层对不上。
    if(String(row.logId||'')!==String(logId||''))return null;
    // 软失效：检索配置变了（玩家改过 topK / 结果上限 / 阈值 / 重排模型）。
    // 不再直接判死——玩家调参数做实验很正常，改一次就把攒的资料全废掉太重了。
    // 改成「标记为需重查」：仍然返回这份资料让上层知道它存在，
    // 但 stale=true 表示配置已变，上层应重新查一次并覆盖旧值。
    var stale=false;
    if(hit.configStamp){
      var nowStamp=frCanonMaterialsConfigStamp();
      if(nowStamp!==hit.configStamp){
        stale=true;
        hit=Object.assign({},hit,{stale:true,staleReason:'检索配置已变（原 '+String(hit.configStamp||'')+'，现 '+nowStamp+'）'});
      }
    }
    hit.stale=stale;
    return hit;
  }catch(_){return null;}
}
// 检索相关配置的指纹：与结果强相关，变了就不能复用旧资料。
// 注意字段名要用补演自己的 retrieval* ——原来写的是原卡的 rerankTopK/vectorMaxResults 那套，
// 补演配置里根本没有这些名字，于是指纹恒为 "||||"，等于「永远判定配置没变」和
// 「一旦有值就判定变了」两头都不准（玩家 2026-10-30 报材料复用失效）。
function frCanonMaterialsConfigStamp(){
  var cfg=typeof ceBridgeLastConfig==='object'&&ceBridgeLastConfig?ceBridgeLastConfig:{};
  var pick=function(key){var v=cfg[key];return v===undefined||v===null?'':String(v);};
  return [pick('retrievalTopK'),pick('retrievalRerankMinScore'),pick('retrievalRerankModel'),pick('retrievalEnableRerank')].join('|');
}
async function frCanonMaterialsLoad(archiveName,logId){
  if(!logId||typeof dbGet!=='function')return null;
  var row=await dbGet(frCanonMaterialsKey(archiveName,logId)).catch(function(){return null;});
  return row&&typeof row==='object'&&row.rows?row:null;
}
// 只保留最近 keep 层（默认 1 = 只留当前层）。
// 玩家口径（2026-10-31）：「推进到下一层了，这个资料就可以清理了，在本层必须一直在。」
//
// 注意 keep 的语义：当前正在用的这一层**永远不能删**，哪怕它已经不在
// archive.data.logs 的最近 keep 名次里（比如 logId 是刚建、还没落进 logs 的新层）。
// 原来只按 ids.slice(keep) 取「旧层」，一旦新层尚未写入 logs，当前层会被算进旧层名单，
// 结果刚存下的资料立刻被自己清掉 —— 表现为「存了但永远查不到」。
async function frCanonMaterialsPrune(archiveName,logId){
  if(typeof dbGet!=='function'||typeof dbSet!=='function')return;
  try{
    var archive=typeof db!=='undefined'&&db.archives?await db.archives.get(archiveName):null;
    var ids=(archive?.data?.logs||[]).map(function(log){return String(log.id);}).reverse();
    var keep=frCanonMaterialsKeep();
    // 当前层先钉死在保留集合里，再谈其它层。
    var keepSet=new Set();
    if(logId)keepSet.add(String(logId));
    ids.slice(0,keep).forEach(function(id){keepSet.add(id);});
    // 全部候选：既包括仍然存在的楼层，也包括可能残留的旧层键
    var stale=ids.filter(function(id){return !keepSet.has(String(id));});
    for(var id of stale){
      if(String(id)===String(logId))continue;   // 双保险：当前层绝不删
      await dbSet(frCanonMaterialsKey(archiveName,id),null);
    }
  }catch(_){}
}

// ---------- 只读查看（玩家在局部重跑面板里翻资料用） ----------
// 纯展示，不提供删除或编辑：这些资料是判断「重跑前提有没有变」的依据，
// 让玩家改它会破坏判断，所以只开读口。
function frCanonMaterialsWorldTime(log){
  // 楼层对应的游戏世界时间。优先用年表账本，没有就退回楼层自身记录。
  var ledger=log&&log.canonLedger;
  var text=String(ledger&&ledger.worldTime||log&&log.worldTime||'').trim();
  return text;
}
// 列出可查看的楼层：只含有资料的、且不超过保留轮数。
// 注意：这些楼层**仅供只读回看**，不是重跑的执行依据。
// 重跑真正复用的永远是本回合那一份（见 frReplayMaterialsReady 只查 context.logId）。
// 返回按「新→旧」排列，玩家一眼看到当前本轮在最上面。
// 找最新一层「确实存过资料」的楼层。
//
// 为什么需要它：frCanonMaterialsFloors 只回看 materialsKeep 层（配置默认 1），
// 而且要求该层 row.rows 非空才列出来。一旦当轮没存（比如中途停止、
// 或者资料存在更早的楼层），floors 就返回空，重跑面板的 currentFloorId
// 一直是空串，于是不管数据库里有没有资料，一律报「还没有保存过」。
// 玩家 2026-10-30：这个结论是错的，必须真的去库里翻一次。
async function frCanonMaterialsLatestFloorId(archiveName){
  var name=frCanonMaterialsArchiveName(archiveName);
  if(typeof dbGet!=='function'||typeof db==='undefined'||!db.archives)return '';
  try{
    var archive=await db.archives.get(name);
    var logs=(archive?.data?.logs||[]).filter(function(log){
      return log&&log.type==='ai'&&!log.isGhost&&!log.isDeepSummary&&!log.isSnapshot;
    }).reverse();  // 新→旧
    // 这里刻意不受 materialsKeep 限制：玩家要看到的是「到底有没有存过」，
    // 而不是「保留策略允不允许看」。保留策略只影响自动清理，不该影响读取判断。
    for(var log of logs){
      var row=await dbGet(frCanonMaterialsKey(name,log.id)).catch(function(){return null;});
      if(row&&row.rows&&Object.keys(row.rows).length)return String(log.id);
    }
    return '';
  }catch(_){return '';}
}

async function frCanonMaterialsFloors(archiveName){
  var name=frCanonMaterialsArchiveName(archiveName);
  if(typeof dbGet!=='function'||typeof db==='undefined'||!db.archives)return [];
  try{
    var archive=await db.archives.get(name);
    // 玩家 2026-11-01：「这个层数怎么是一堆乱码啊，对齐快照实际层数。」
    //
    // 原来是 `label: '第 ' + String(log.id) + ' 层'` —— 直接把 **UUID** 当层号写进去了，
    // 面板上显示成「第 1e8f33a1-57f7-4405-950f-c0a94117b286 层」。
    //
    // 层号必须相对**全部有效楼层**来算，而不是相对「有资料的楼层」：
    //   玩家说的「第 N 层」指的是对话里的第 N 楼（和快照、存档列表同一口径）。
    //   如果只数有资料的楼层，会产生「有资料的 2 层被标成第 1、2 层」，
    //   但它们在对话里其实是第 7、8 楼 —— 玩家拿去对照时仍然对不上。
    var allLogs=(archive?.data?.logs||[]).filter(function(log){
      return log&&log.type==='ai'&&!log.isGhost&&!log.isDeepSummary&&!log.isSnapshot;
    });
    // 楼层号：正序第几个（1 起），和「第 N 楼」口径一致
    var floorNoById={};
    allLogs.forEach(function(log,i){floorNoById[String(log.id)]=i+1;});

    var logs=allLogs.slice().reverse();  // 新→旧
    var keep=frCanonMaterialsKeep(),out=[];
    for(var i=0;i<logs.length&&out.length<keep;i++){
      var log=logs[i];
      var row=await dbGet(frCanonMaterialsKey(name,log.id)).catch(function(){return null;});
      if(!row||!row.rows||!Object.keys(row.rows).length)continue;  // 没存过资料的楼层不列
      var floorNo=floorNoById[String(log.id)]||0;
      out.push({
        logId:String(log.id),
        /* ★★★ 2026-11-03 玩家定（原话）：
         *   「关于对齐快照楼层那几处，其实你的逻辑没问题，
         *     只是和玩家直观看到的不一样而已，玩家看到的快照是第二层，
         *     那我们就用蠢办法，直接说第一回合、第二回合好了」
         *
         * 内部算的是「第几个 AI 楼层」，玩家看到的是「第几回合」，两者差 1
         * （天道初启那一层不算回合）。与其解释口径，不如**直接用玩家看得懂的说法**：
         * 面板上一律写「第 N 回合」，和「人生快照」里的编号直观对上。
         * 内部 floorNo 字段保留不动（程序逻辑还按它算），只是显示文案换掉。 */
        label:floorNo?('第 '+Math.max(1,floorNo-1)+' 回合'):('第 '+Math.max(1,allLogs.length-i-1)+' 回合'),
        floorNo:floorNo,
        worldTime:frCanonMaterialsWorldTime(log),
        count:Object.keys(row.rows).length,
        updatedAt:Number(row.updatedAt)||0
      });
    }
    return out;
  }catch(_){return [];}
}
// 取某一楼层存下的全部资料条目，供面板展示。
async function frCanonMaterialsList(archiveName,logId){
  var name=frCanonMaterialsArchiveName(archiveName);
  var row=await frCanonMaterialsLoad(name,logId);
  if(!row||!row.rows)return [];
  var nowStamp=frCanonMaterialsConfigStamp();
  return Object.keys(row.rows).map(function(key){
    var hit=row.rows[key]||{};
    var stamp=String(hit.configStamp||'');
    return {
      queryKey:key,
      queryText:String(hit.queryText||''),
      text:String(hit.text||''),
      receipt:hit.receipt||null,
      materialRequest:hit.materialRequest||null,
      configStamp:stamp,
      // 面板上要能看出「这条是按旧配置查的」。不改内容、不删数据，只做标注。
      stale:!!stamp&&stamp!==nowStamp,
      at:Number(hit.at)||0
    };
  }).sort(function(a,b){return b.at-a.at;});  // 新→旧
}
