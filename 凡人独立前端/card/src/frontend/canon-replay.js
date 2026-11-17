// Local replay reuses the native executor and its parsers. Never applies a cached
// delta over an already-applied delta: restore the captured boundary first.
var frReplaySession = null;
/* 按系统各存一份重跑会话指针。
 * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
 * 原来只有一个 frReplaySession，两个系统共用 ——
 * 一边开跑就把另一边的会话顶掉，停止、状态判断、互斥判断全会串台。
 * 现在 canon / ce 各一个槽位，frReplaySession 只作为「最近一次」的汇总引用。 */
var frReplaySessionsBySystem = { canon: null, ce: null };
function frReplaySessionOf(system){
  var key = (system === 'ce') ? 'ce' : 'canon';
  return frReplaySessionsBySystem[key] || null;
}
function frReplaySessionBySignal(signal,system){
  if(!signal)return null;
  var sessions=system?[frReplaySessionOf(system)]:[frReplaySessionOf('canon'),frReplaySessionOf('ce')];
  var exact=sessions.find(function(session){return session&&session.archiveName===currentArchiveName&&(session.controller?.signal===signal||session.selection?.signal===signal);});
  if(exact)return exact;
  var run=typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(signal):null;
  var owner=run&&run._replay;
  return owner&&sessions.includes(owner)&&owner.archiveName===currentArchiveName&&run.phase===(owner.system==='ce'?'变量演化':'正文后补演')?owner:null;
}
function frReplaySessionSystemOf(session){
  if(!session) return '';
  if(session.system) return session.system;
  return session.context && session.context.system === 'ce' ? 'ce' : 'canon';
}
/* 给「重跑内部要往上写楼层」这类操作挑会话。
 * 只在真正在跑的那条线上挑，绝不拿另一条线的上下文去写存档。 */
function frReplayPickAttachSession(signal,system){
  if(signal)return frReplaySessionBySignal(signal,system);
  if(system){var own=frReplaySessionOf(system);return own&&own.archiveName===currentArchiveName?own:null;}
  var canon=frReplaySessionsBySystem.canon,ce=frReplaySessionsBySystem.ce;
  if(canon&&!ce)return canon;
  if(ce&&!canon)return ce;
  if(canon&&ce){
    // 无明确调用归属时不能猜测；内部写回必须传入所属线路的signal。
    return null;
  }
  return null;
}
// 两条线路独立接收任务；涉及同一整档的快照/写回/恢复按提交顺序执行。
// 等待者尚未拍恢复快照，可独立取消，不能覆盖前一条刚提交的结果。
var frReplayArchiveQueue=new Map();
function frReplayAcquireArchive(name,signal,onQueued){
  return new Promise(function(resolve,reject){
    function stopped(){var error=new Error('已取消等待中的局部重跑');error.name='AbortError';return error;}
    if(signal?.aborted){reject(stopped());return;}
    var key=String(name),queue=frReplayArchiveQueue.get(key);
    if(!queue){queue=[];frReplayArchiveQueue.set(key,queue);}
    var started=false,released=false;
    var ticket={start:function(){
      started=true;if(signal)signal.removeEventListener('abort',cancel);
      resolve(function(){
        if(released)return;released=true;
        queue.shift();
        if(queue.length)queue[0].start();else frReplayArchiveQueue.delete(key);
      });
    }};
    function cancel(){
      if(started)return;
      var at=queue.indexOf(ticket);if(at>=0)queue.splice(at,1);
      if(signal)signal.removeEventListener('abort',cancel);
      reject(stopped());
    }
    queue.push(ticket);
    if(queue.length===1)ticket.start();
    else{
      if(signal)signal.addEventListener('abort',cancel,{once:true});
      try{if(onQueued)onQueued();else if(typeof showDanmaku==='function')showDanmaku('已排队，当前存档的上一条重跑结束后继续；可以随时停止。','info');}catch(_){}
    }
  });
}
/* ★★★ 2026-11-02 玩家：「原著补演和变量演化的局部重跑是不是共享重跑逻辑和状态，
 * 这两个明明是两条线路，但是只要我重跑其中一个，另一个就显示锁死说其他的在重跑，
 * 不准我重跑另一个。」
 *
 * 是共享的，而且这是错的。原著补演（canon）和变量演化（ce）是两条独立线路：
 *   · 各自的阶段表（CC_REPLAY_STAGES_CANON / CC_REPLAY_STAGES_CE）
 *   · 各自的基线（FR_REPLAY_BASE_V1:<存档>:canon / :ce）
 *   · 各自的恢复备份（FR_REPLAY_RECOVERY_V1:<存档>:canon / :ce）
 *   · 各自的会话（frReplaySessionsBySystem）
 *   · 各自的后端（frRunCanonAfterHostTurn / rerollConcurrentEvolution）
 * 唯一不该共享的就是这把「谁在跑」的锁。原来 frReplayBusy 是一个全局布尔，
 * 于是 A 跑着 B 就永远进不来，玩家看到的是「另一边被锁死了」。
 *
 * 现在按系统分开记录：只有**同一个系统**在跑时才拒绝。
 * frReplayBusy 保留为「任一系统在跑」的汇总值（给只看总状态的地方用），
 * 真正做准入判断的地方改读 frReplayBusyOf(system)。
 */
var frReplayBusy = false;
var frReplayBusyBySystem = { canon: false, ce: false };
function frReplayBusyOf(system){
  var key = (system === 'ce') ? 'ce' : 'canon';
  return frReplayBusyBySystem[key] === true;
}
function frReplaySetBusy(system, value){
  var key = (system === 'ce') ? 'ce' : 'canon';
  frReplayBusyBySystem[key] = !!value;
  frReplayBusy = frReplayBusyBySystem.canon || frReplayBusyBySystem.ce;
}
var frReplayPending = {};
var frReplayDirectBusy = false;
var frReplayDirectBusyBySystem = { canon: false, ce: false };
function frReplayDirectBusyOf(system){
  var key = (system === 'ce') ? 'ce' : 'canon';
  return frReplayDirectBusyBySystem[key] === true;
}
function frReplaySetDirectBusy(system, value){
  var key = (system === 'ce') ? 'ce' : 'canon';
  frReplayDirectBusyBySystem[key] = !!value;
  frReplayDirectBusy = frReplayDirectBusyBySystem.canon || frReplayDirectBusyBySystem.ce;
}
var frReplayDirectTask = null;
/* 直接重跑任务也按系统各存一份。frReplayDirectTask 只作「最近一次」的汇总引用，
 * 停止与状态查询走 frReplayDirectTasksBySystem[system]，各看各的。 */
var frReplayDirectTasksBySystem = { canon: null, ce: null };
function frReplayStageKey(stage){
  /* ★★★ 2026-11-03 玩家：「我觉得变量落地或者代码执行阶段没必要单独拆分成阶段，
   *   而是直接并入对应的前阶段中，真正需要重跑的是调用api请求的那些阶段。」
   *
   * 【这个函数是「阶段身份」的唯一归一化入口，必须把同一个阶段的所有写法归成一把 key，
   *   否则勾选与执行两边认的不是同一个东西，勾了等于没勾。】
   *
   * 已知的三种脏写法（都是实测出来的，不是推测）：
   *   ① 后缀噪声：「世界事件补演·修正重发」——修正重发是同一阶段的第二次请求。
   *   ② 旧名：      「人物正文语义核验」——已经改名为「落地依据提取」。
   *   ③ 复合名：    「采集资料 · vectorContext」——展示名 + 具体目标拼在一起。
   *      frCanonTraceRequest 第1549行拼 stage 时会把 subject 接在后面，
   *      而第1553行 stageKey 在调用方没显式传 meta.stageKey 时退化成 run.currentStage，
   *      于是存档里出现这种复合名。面板上的 key 是干净的 vectorContext，
   *      两边一比就永远对不上 → 玩家勾了这个阶段，执行时一条请求都匹配不到，
   *      表现就是「一瞬间完成、什么都没跑」。
   *
   * 【修法】先按「 · 」把复合名拆开，取**能对上已知阶段表**的那一段；
   *   拆不出干净的段落时退回去掉首尾空白的原值，绝不瞎猜成别的阶段。 */
  var raw=String(stage||'');
  raw=raw.replace(/·\s*修正重发$/,'').trim();
  if(raw==='人物正文语义核验')return '落地依据提取';
  if(raw==='配角群像')return '群像视角散文';
  if(raw.indexOf(' · ')<0)return raw;
  /* 复合名：逐段比对已知别名，认得出就归一，认不出保留原串。 */
  var ALIAS={
    'vectorContext':'vectorContext','采集资料':'vectorContext','资料检索':'vectorContext',
    '正文硬事实提取':'正文硬事实提取','补演边界判定':'补演边界格式整理',
    '补演边界格式整理':'补演边界格式整理',
    '人物边界批量判定':'人物边界批量判定','生平旧账':'生平旧账',
    '人物终态推演':'人物终态推演','差集与正文覆盖核对':'差集与正文覆盖核对',
    '落地依据提取':'落地依据提取','人物视角散文':'人物视角散文',
    '群像视角散文':'群像视角散文','配角群像':'群像视角散文',
    /* ★★★ 2026-11-03 玩家：「为什么不允许我原著补演局部重跑？」「两个逻辑打架，直接罢工」。
     *
     * 【真根因 · 面板键与请求 stage 名根本不是一个词】
     *   面板 STAGE_ACTIONS 里这个世界事件动作给的是键 `misc`；
     *   而 orchestrator.js:2825 实际发起请求时用的是
     *       stage: '世界事件补演'   （修正重发时是 '世界事件补演·修正重发'）
     *   于是 frReplayResolve 里
     *       selected = selection.stages.includes(req.stageKey)
     *   左边是 ['misc']，右边是 '世界事件补演' —— **永远为 false**。
     *   结果每条请求都被判成「没选中 → 复用」，
     *   一个模型调用都没发出去（realCalls===0），
     *   面板最后弹出「本次没有可重算的内容：所选『世界事件补演、misc』」。
     *   玩家观察到的「准备从边界判定开始跑又罢工」正是这个序列。
     *
     * 【修法】把两侧统一到**同一个键**：无论面板叫 misc 还是请求叫「世界事件补演」，
     * 归一化后一律落到 `世界事件补演`（它是实际 stage 的真名，也是
     * frCanonTraceRequest 落库时写的名字，取真实名才不会再次错位）。
     * `世界事件核验` 是同一件事的旧称，一起并进来。
     * 注意：**不能**反过来把请求归一成 misc —— 那样落库的 stageKey 会和
     * 后续真实请求再次对不上，等于把坑挪个位置。 */
    '世界事件补演':'世界事件补演','世界事件核验':'世界事件补演','misc':'世界事件补演',
    '变量重复核验':'变量重复核验','原著指导':'原著指导',
    'characters':'characters','items':'items',
    'tags':'tags','biography':'biography'
  };
  var parts=raw.split(' · ').map(function(x){return x.trim();}).filter(Boolean);
  /* 从右往左找：复合名的右段通常才是真正的阶段 key（例如「采集资料 · vectorContext」）。 */
  for(var i=parts.length-1;i>=0;i--){
    if(ALIAS[parts[i]])return ALIAS[parts[i]];
  }
  for(var j=0;j<parts.length;j++){
    if(ALIAS[parts[j]])return ALIAS[parts[j]];
  }
  return raw;
}
function frReplayNormalizeRequest(req){
  req.stageKey=frReplayStageKey(req.stageKey);
  try{var key=JSON.parse(req.cacheKey);if(Array.isArray(key)&&typeof key[0]==='string'){key[0]=frReplayStageKey(key[0]);req.cacheKey=JSON.stringify(key);}}catch(_){}
  return req;
}
// 每个请求是否完成必须由阶段结果判断，不能把「接口有返回」当成核验通过。
function frReplayResultOf(run){var parsed=(run.events||[]).filter(function(e){return e.label==='补演解析与账本计划'&& e.data;}).at(-1);return Object.assign({},parsed&& parsed.data||{},run.result||{},run.executionResult||{});}
function frReplayViewsOf(run){return (run.events||[]).concat(run.executionViews||[]).filter(function(e){return e.type==='view'&&e.data;}).map(function(e){return e.data;});}
function frReplayProseState(run){
  var rows=new Map(),result=frReplayResultOf(run||{});
  frReplayViewsOf(run||{}).forEach(function(view){
    if(view.kind==='prose'&&view.block?.name)rows.set(view.block.name,view);
  });
  // 预览视图可能尚未验收；最终结果中的成功正文才是可复用成果。
  (result.prose||[]).forEach(function(block){if(block?.name)rows.set(block.name,{block:block,accepted:true});});
  (result.debts||[]).forEach(function(debt){
    var name=typeof debt==='string'?debt:debt?.name||debt?.actor;
    if(name)rows.set(name,Object.assign({},rows.get(name)||{block:{name:name,body:''}},{accepted:false,reason:debt.reason||''}));
  });
  return rows;
}
// A completed narrative can feed the paired character/item retry directly.
// Accept only unambiguous owner IDs and a complete, accepted narrative from this floor.
function frReplayVariableHandoff(data,selection,result,seeds){
  if(selection.system!=='canon'||(selection.stages||[]).length)return null;
  var scopes=(selection.scopes||[]).map(frReplaySplitScope);
  if(!scopes.length||scopes.some(row=>!row.valid||!['characters','items'].includes(row.stage)))return null;
  var ids=new Map(),conflicts=new Set();
  (data.allRequests||[]).filter(req=>['canon-merged','characters','items'].includes(req.stageKey)).forEach(function(req){
    var names=frReplayRequestNames(req),targets=frReplayRequestTargets(req);
    if(names.length!==targets.length)return;
    names.forEach(function(name,index){var id=String(targets[index]||'');if(!/^C\d+$/.test(id))return;if(ids.has(id)&&ids.get(id)!==name)conflicts.add(id);else ids.set(id,name);});
  });
  var people=new Map();
  for(var scope of scopes){
    var id=ids.has(scope.name)?scope.name:Array.from(ids).find(([,name])=>name===scope.name)?.[0];
    var name=ids.get(id);
    if(!name||conflicts.has(id)||!seeds[name]||seeds[name].refreshFacts)return null;
    if(!people.has(id))people.set(id,{name,id,stages:new Set()});
    people.get(id).stages.add(scope.stage);
  }
  if(Array.from(people.values()).some(row=>row.stages.size!==2))return null;
  var failures=frReplayFailedSelection(data),failed=new Set(failures.scopes);
  if(Array.from(people.values()).some(row=>!['characters','items'].some(stage=>failed.has(stage+':'+row.id)||failed.has(stage+':'+row.name)||failures.stages.includes(stage))))return null;
  var completeResult=(result.status==='ok'||result.actorProgressSaved===true)&&
    !['debts','backstoryDebts','worldDebts','unconfirmedEvents','unowned'].some(key=>result[key]?.length);
  // The old parallel entry point saved accepted prose views but could fail before
  // saving the aggregate narrative. Only the failed canon-merged request proves a
  // legacy group reached variable conversion. It does not prove ledger readiness.
  if(!completeResult&&Array.from(people.values()).some(row=>!(data.allRequests||[]).some(req=>
    req.stageKey==='canon-merged'&&(req.status!=='returned'||req.mergedAccepted!==true)&&frReplayRequestTargets(req).includes(row.id))))return null;
  if(!completeResult&&(result.debts||[]).some(row=>people.has(row?.actorId)||Array.from(people.values()).some(actor=>actor.name===(typeof row==='string'?row:row?.name||row?.actor))))return null;
  var blocks=completeResult&&result.prose?.length?result.prose:Object.values(seeds).map(seed=>seed.block),names=new Set(blocks.map(row=>row?.name));
  if(!blocks.length||names.size!==blocks.length||blocks.some(row=>!row?.name||seeds[row.name]?.block?.body!==row.body||!String(row.body||'').trim())||
      Array.from(people.values()).some(row=>!names.has(row.name)))return null;
  return {actors:Array.from(people.values(),({name,id})=>({name,id})),blocks:structuredClone(blocks),
    biography:structuredClone(result.biography||{}),canonReferences:structuredClone(result.canonReferences||{}),
    ledgerPlan:structuredClone(completeResult?result.ledgerPlan||null:null),worldForMisc:String(result.worldForMisc||''),worldNoChanges:structuredClone(result.worldNoChanges||[])};
}
function frReplayTargetPending(selection,stage,id,req){
  if(frReplayTargetSelected(selection,stage,id))return true;
  // 合批中的其他人物不是当前卡片的别名。
  var names=frReplayRequestNames(req),ids=frReplayRequestTargets(req),index=ids.indexOf(id);
  if(index>=0&&ids.length===names.length)return frReplayTargetSelected(selection,stage,names[index]);
  return !id&&names.length===1&&frReplayTargetSelected(selection,stage,names[0]);
}
function frReplaySemanticOwned(req,session){
  if(!req.semanticOnly)return true;
  return frReplayRequestOwned(req,session);
}
function frReplayRequestOwned(req,session){
  var context=session.context||{},system=session.system||context.system||session.selection?.system;
  var archive=session.archiveName||context.archiveName,logId=context.logId;
  var owner=req._run;
  return !!archive&&!!logId&&String(req.archiveName||owner?.archiveName||'')===String(archive)
    &&String(req.logId||owner?.logId||'')===String(logId)
    &&String(req.system||(owner?(owner.phase==='变量演化'?'ce':'canon'):'')||'')===String(system||'');
}
function frReplayArtifactExcluded(req,old){
  var ids=frReplayRequestTargets(req).concat(frReplayRequestNames(req));
  return (old.replayExcludedScopes||[]).some(function(scope){var pair=frReplaySplitScope(scope);return pair.stage===req.stageKey&&(!pair.name||ids.includes(pair.name));});
}
function frReplayRequestNames(req){return String(req.subject||'').split('、').filter(Boolean);}
function frReplayRequestTargets(req){return req.targetIds?.length?req.targetIds.slice():req.targetId?String(req.targetId).split(',').filter(Boolean):frReplayRequestNames(req);}
// 只投影已有真实返回，不复制HTTP/cache记录；定点重跑仍用原分阶段协议。
function frReplayCanonMergedResponse(req,session){
  if(session.system==='ce'||session.context?.system==='ce'||!['characters','items'].includes(req.stageKey)||typeof FrMergedEvolution!=='object')return null;
  var wanted=frReplayRequestTargets(req);if(!wanted.length)return null;
  for(var old of (session.cache||[]).slice().reverse()){
    if(old.stageKey!=='canon-merged'||old.status!=='returned'||old.mergedAccepted!==true||frReplayArtifactExcluded(req,old)||!wanted.every(id=>frReplayRequestTargets(old).includes(id))||
      (Array.isArray(old.mergedPhases)&&!old.mergedPhases.includes(req.stageKey)))continue;
    var raw=old.response?.choices?.[0]?.message?.content,pack;
    try{pack=FrMergedEvolution.parseResponse(raw,{canonCompletion:true,allowedTargetIds:frReplayRequestTargets(old),parseCharacters:parseConcurrentEvolutionCommands,parseItems:parseItemManagementCommands,parseMisc:text=>ceParseMiscCommandsBlock(text),resolveTarget:resolveConcurrentEvolutionOpId});}
    catch(_){continue;}
    var commands=[];
    if(req.stageKey==='characters'){
      wanted.forEach(id=>{var text=pack.characterResponses[id];if(typeof text==='string')commands.push(text.slice('<upstore>'.length,-'</upstore>'.length));});
    }else{
      var lines=pack.itemResponse.slice('<upstore>'.length,-'</upstore>'.length).split('\n').filter(Boolean);
      for(var line of lines){var ops=parseItemManagementCommands(line).operations||[],touched=Array.from(new Set(ops.flatMap(op=>[op.owner,op.from,op.to].filter(Boolean).map(String))));
        if(!touched.some(id=>wanted.includes(id)))continue;
        if(touched.some(id=>!wanted.includes(id)))throw new Error('共同物品转交不能只复用一方，请同时选择转交双方的物品项目');
        commands.push(line);
      }
    }
    var completion={actors:pack.completion.actors.filter(row=>wanted.includes(row.id))};
    var response=structuredClone(old.response);response.choices[0].message.content='<upstore>'+commands.filter(Boolean).join('\n')+'</upstore>\n<canon_completion>'+JSON.stringify(completion)+'</canon_completion>';
    return {source:old,response:response};
  }
  return null;
}
function frReplayDisplayRequests(requests,system){
  // 只投影选择界面，不复制或伪造 HTTP 缓存。执行仍按语义阶段定点修补。
  return (requests||[]).flatMap(function(req){
    var merged=system==='ce'&&req.stageKey==='merged';
    var stages=merged?(req.mergedPhases||['entry','items','characters','misc']):system==='canon'&&req.stageKey==='canon-merged'?(req.mergedPhases||['characters','items']):null;
    if(!stages)return [req];
    return stages.map(function(stage){
      var row={...req,stageKey:stage,sourceStageKey:req.stageKey,sourceRequestId:req.id};
      // 登退场、杂项是全局阶段；人物与物品按所属者定点修补。
      if(merged&&['entry','misc'].includes(stage)){row.targetId='';row.targetIds=[];row.subject='';}
      return row;
    });
  });
}
function frReplayRecordVariableMode(system,mode,signal){
  if(!['merged','staged'].includes(mode)||typeof currentArchiveName!=='string'||!currentArchiveName)return;
  if(typeof frReplaySessionBySignal==='function'&&frReplaySessionBySignal(signal,system))return;
  var context=frReplayPending[currentArchiveName+':'+system];
  if(context)context.variableUpdateMode=mode;
}
function frReplayModeInfo(data,system){
  var context=data&&data.context||{},base=data&&data.base||{},source=data&&data.source||{};
  if(system==='canon'&&(data?.ledgerReplay?.mode==='prebuilt'||context.prebuiltRetry||frReplayResultOf(source).prebuiltRepair))return {
    mode:'prebuilt',label:'预制成品',description:'可定点修订本轮变异、重新覆盖已核验的成品，或单独核对账本。'};
  var mode=context.variableUpdateMode||base.variableUpdateMode||source.variableUpdateMode;
  var requests=data&&data.allRequests||[];
  if(mode!=='merged'&&mode!=='staged'){
    var mergedKey=system==='ce'?'merged':'canon-merged';
    if(requests.some(function(req){return req.stageKey===mergedKey;})||(system==='ce'&&(context.mergedReplayReceipt||base.mergedReplayReceipt||source.result?.mergedReplayReceipt)))mode='merged';
    else mode='unknown'; // 不拿现在的设置冒充历史回合的实际模式。
  }
  return {mode:mode,label:mode==='merged'?'合并演化':mode==='staged'?'分阶段演化':'未记录',
    description:mode==='merged'?'原轮合并结果按阶段展开；本次只重跑选中的阶段或人物，其余成功结果复用。':'本次按选中的阶段或人物定点重跑，其余成功结果复用。'};
}
// 仅支持源码明确分隔的独立人物材料；接口、模型、参数、共享背景和本人全文必须逐字一致。
function frReplayProjectInput(key,stage,names){
  try{
    var parts=JSON.parse(key),messages=structuredClone(parts[5]),found=false;
    messages.forEach(function(message){
      if(typeof message.content!=='string')return;
      var text=message.content,rows=[],prefix='',suffix='';
      if(stage==='人物边界批量判定'){
        var pattern=/【独立人物：([^\r\n】]+)】\n/g,matches=Array.from(text.matchAll(pattern)),tail=text.indexOf('\n【本批统一输出协议，优先于各人物模板的单人格式】');
        if(!matches.length||tail<matches[0].index)return;
        prefix=text.slice(0,matches[0].index);suffix=text.slice(tail);
        rows=matches.map(function(match,index){return [match[1],text.slice(match.index,index+1<matches.length?matches[index+1].index:tail).trim()];});
      }else if(stage==='生平旧账'){
        var matches=Array.from(text.matchAll(/^\d+\. \*\*([^\r\n]+)\*\*\n   现状：/gm));if(!matches.length)return;
        var last=matches.at(-1),tail=text.indexOf('\n\n',last.index);if(tail<0)return;
        prefix=text.slice(0,matches[0].index);suffix=text.slice(tail);
        rows=matches.map(function(match,index){return [match[1],text.slice(match.index,index+1<matches.length?matches[index+1].index:tail).trim().replace(/^\d+\./,'1.')];});
      }else if(stage==='落地依据提取'){
        var marker='\n【本批人物及其唯一待核验正文】\n',position=text.lastIndexOf(marker);if(position<0)return;
        prefix=text.slice(0,position+marker.length);
        // 事件进度含全员约束，不能当作各自独立的核验缓存拆用。
        if(prefix.includes('【事件进度专用背景开始】')||prefix.includes('【本批事件，仍在同一次正文核验中返回eventProgress】'))throw new Error('事件进度核验不可投影');
        var packet=JSON.parse(text.slice(position+marker.length));if(!Array.isArray(packet))throw new Error('人物核验材料不是独立数组');
        rows=packet.map(function(row){if(!row||typeof row.name!=='string')throw new Error('人物核验材料缺少姓名');return [row.name,JSON.stringify(row)];});
      }else return;
      if(new Set(rows.map(function(row){return row[0];})).size!==rows.length)throw new Error('人物材料分隔重复');
      var selected=names.map(function(name){var matches=rows.filter(function(row){return row[0]===name;});if(matches.length!==1)throw new Error('缺少独立人物材料');return matches[0];});
      message.content=JSON.stringify([prefix,selected,suffix]);found=true;
    });
    if(!found)return null;parts[1]=names.join('、');parts[5]=messages;return JSON.stringify(parts);
  }catch(_){return null;}
}
function frReplayProjectedResponse(req,session){
  if(!['人物边界批量判定','生平旧账','落地依据提取'].includes(req.stageKey))return null;
  var names=frReplayRequestNames(req),input=frReplayProjectInput(req.cacheKey,req.stageKey,names);
  var replay=session.selection?.replay,verified=session.boundaryInputVerified;
  var frozenOwned=!!verified&&replay?.preserveInput===true&&verified.archiveName===session.context?.archiveName&&verified.logId===session.context?.logId;
  if(!names.length||!input&&!frozenOwned)return null;
  for(var old of session.cache.slice().reverse()){
    if(old.stageKey!==req.stageKey||old.status!=='returned'||frReplayArtifactExcluded(req,old))continue;
    var exact=input&&frReplayProjectInput(old.cacheKey,req.stageKey,names)===input;
    // Live diagnostics and compact receipts have the same ownership requirement.
    var sameFrozen=frozenOwned&&frReplayRequestOwned(old,session)&&names.every(function(name){return frReplayRequestNames(old).includes(name);});
    if(!exact&&!sameFrozen)continue;
    try{
      var response=structuredClone(old.response),raw=response.choices[0].message.content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,'').replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,'').trim(),parsed=JSON.parse(raw),projected;
      if(req.stageKey==='人物边界批量判定'||req.stageKey==='落地依据提取'){
        if(!Array.isArray(parsed.results))continue;
        var rows=names.map(function(name){var matches=parsed.results.filter(function(row){return row.name===name;});if(matches.length!==1)throw new Error('旧人物返回不完整');return matches[0];});projected={results:rows};
      }else{projected={};names.forEach(function(name){if(!Array.isArray(parsed[name]))throw new Error('旧人物旧账不完整');projected[name]=parsed[name];});}
      response.choices[0].message.content=JSON.stringify(projected);return {source:old,response:response};
    }catch(_){}
  }
  return null;
}
function frReplayBindBoundaryProof(session){
  var replay=session.selection?.replay;
  if(!replay||session.system!=='canon')return;
  session.boundaryInputVerified=null;
  session.continuationInputVerified=null;
  replay.onContinuationInputVerified=function(proof){
    var context=session.context||{},resume=replay.continuationInput;
    if(!proof||!context.archiveName||!context.logId||proof.archiveName!==context.archiveName||proof.logId!==context.logId
      ||replay.preserveInput!==true||resume?.version!==1||resume?.data?.archiveName!==context.archiveName||resume?.data?.logId!==context.logId)throw new Error('重跑接续输入验证的来源与当前楼层不一致');
    session.continuationInputVerified={archiveName:proof.archiveName,logId:proof.logId};
  };
  replay.onBoundaryInputVerified=function(proof){
    var context=session.context||{},resume=replay.continuationInput;
    if(!proof||!context.archiveName||!context.logId||proof.archiveName!==context.archiveName||proof.logId!==context.logId
      ||replay.preserveInput!==true||resume?.data?.archiveName!==context.archiveName||resume?.data?.logId!==context.logId){
      throw new Error('重跑冻结输入验证的来源与当前楼层不一致');
    }
    session.boundaryInputVerified={archiveName:proof.archiveName,logId:proof.logId,turnKey:proof.turnKey||''};
  };
}
function frReplayContinueSelection(data){
  var run=data.source,result=frReplayResultOf(run),stages=[],scopes=[],latest=new Map();
  var prebuilt=frReplayPrebuiltFailures(data);
  if(prebuilt)return {...prebuilt,mode:'continue',completed:[]};
  var cleared=(data.base||data.context)?.cleared||{};
  data.allRequests.forEach(function(req){
    var targets=frReplayRequestTargets(req);
    if(req.stageKey==='canon-merged'){
      (req.mergedPhases||['characters','items']).forEach(function(stage){targets.forEach(function(id){
        latest.set(stage+':'+id,{req:{...req,stageKey:stage,status:req.status==='returned'&&req.mergedAccepted!==true?'error':req.status},id:id});
      });});
      return;
    }
    (targets.length?targets:['']).forEach(function(id){latest.set(req.stageKey+':'+id,{req:req,id:id});});
  });
  function add(req,name){if(!req)return;var id=name||req.targetId||req.subject||'';if(id)scopes.push(req.stageKey+':'+id);else stages.push(req.stageKey);}
  latest.forEach(function(row,key){if(!['returned','skipped'].includes(row.req.status)&&!(cleared.stages||[]).includes(row.req.stageKey)&&!(cleared.scopes||[]).includes(key))add(row.req,row.id);});
  var pending=frReplayPendingFailures(data.base||data.context);
  stages.push(...pending.stages);scopes.push(...pending.scopes);
  function own(name,keys){var table=data.context?.beforeMemory?.state?.['0']||{},id=Object.keys(table).find(function(id){return String(table[id]?.['1']||'').split('|')[0]===name;});var req=data.allRequests.slice().reverse().find(function(req){return keys.includes(req.stageKey)&&(frReplayRequestNames(req).includes(name)||id&&(req.targetId===id||(req.targetIds||[]).includes(id)||frReplayRequestNames(req).includes(id)));});add(req,['characters','items'].includes(req?.stageKey)&&id?id:name);}
  (result.debts||[]).forEach(function(row){own(typeof row==='string'?row:row.name||row.actor,['人物视角散文','群像视角散文']);});
  (result.backstoryDebts||[]).forEach(function(row){own(typeof row==='string'?row:row.name||row.actor,['生平旧账']);});
  if((result.worldDebts||[]).length||(result.unconfirmedEvents||[]).length||(result.failedBatches||[]).length||result.progressFailure)stages.push('世界事件补演');
  var views=frReplayViewsOf(run);
  frReplayProseState(run).forEach(function(row,name){if(row.accepted===false)own(name,['人物视角散文','群像视角散文']);});
  // 请求已返回也可能仍缺字段；继续只处理该人物的转换，不重写已核验故事。
  var actorViews=new Map();views.filter(function(v){return v.kind==='characters'&&v.name;}).forEach(function(v){actorViews.set(v.name,v);});
  actorViews.forEach(function(view,name){
    var completion=view.completion,missing=Array.isArray(completion?.hardMissing)?completion.hardMissing:[];
    // 档案列缺口也算失败项（玩家 2026-10-30 报的正是这个）：
    // 「韩立人物档案不完整：第10列（背景）仍为 seed 兜底文本」。
    // 判定口径直接沿用变量演化那边的专项补：看 completionDetail.needsModelFill，
    // 而不是只盯 completion.hardMissing——后者只查技能/物品 facts，不含档案列。
    // 见 main.js 里 shouldRetry = completionDetail.needsModelFill === true。
    var needsFill=false,columnGaps=[];
    try{
      var detail=null;
      if(view.row&&typeof ceGetOriginalTimelineColdStartRowCompletionDetail==='function'){
        detail=ceGetOriginalTimelineColdStartRowCompletionDetail(view.row);
      }
      if(detail){
        needsFill=detail.needsModelFill===true;
        if(Array.isArray(detail.missingColumns))columnGaps=detail.missingColumns.slice();
        if(Array.isArray(detail.missingNotes))columnGaps=columnGaps.concat(detail.missingNotes);
      }else if(Array.isArray(view.missingColumns)&&view.missingColumns.length){
        columnGaps=view.missingColumns.slice();
        needsFill=true;
      }
    }catch(_){}
    if(!completion||completion.completed!==false&&!missing.length&&!needsFill&&!columnGaps.length){
      // 人物保存链可在物品、压缩或重复结算阶段失败，不等于人物转换失败。
      if(['error','cancelled'].includes(view.status))own(name,['characters','items','biography','变量重复核验']);
      return;
    }
    // 只有档案列缺口时，补「人物状态更新」即可（定点补列在那一阶段内部完成）。
    if(!missing.length&&(needsFill||columnGaps.length)){
      own(name,['characters']);
      if(!scopes.length)scopes.push('characters:'+name);
      return;
    }
    var modules=new Set();missing.forEach(function(row){var module=row&&typeof row==='object'&&(row.module||row.stage||row.stageKey);if(['characters','items'].includes(module))modules.add(module);});
    if(!modules.size&&['characters','items'].includes(completion.phase))modules.add(completion.phase);
    if(!modules.size){modules.add('characters');modules.add('items');}
    var table=data.context?.beforeMemory?.state?.['0']||{},actorId=view.actorId||view.id||Object.keys(table).find(function(id){return String(table[id]?.['1']||'').split('|')[0]===name;})||name;
    modules.forEach(function(module){var count=scopes.length;own(name,[module]);if(scopes.length===count)scopes.push(module+':'+actorId);});
  });
  if(result.commit?.blockedOps?.length||result.blockedOps?.length||result.commit?.miscReceipt?.blockedOps?.length)stages.push('misc');
  if(result.retry?.stage){if(result.retry.targets?.length)result.retry.targets.forEach(function(name){scopes.push(result.retry.stage+':'+name);});else stages.push(result.retry.stage);}
  if(!stages.length&&!scopes.length&& result.landed!==true){
    var failed=data.allRequests.at(-1);
    if(failed && /boundary|prose|failed|error|incomplete|rolled/i.test(String(result.status||run.status||'')))add(failed);
  }
  // 到过杂项但最终事务失败时，人物回执仍可复用，只重试未落地的最终世界提交。
  if(!stages.length&&!scopes.length&& data.allRequests.some(function(req){return req.stageKey==='misc';})&& result.landed!==true)stages.push('misc');
  if(!stages.length&&!scopes.length)throw new Error('本轮没有可确认的失败目标或未完阶段；请从具体人物或阶段主动重跑，不能把全部成功项当成继续。');
  // 记住已完成目标：下游首次执行可继续，旧成功项失配时仍须停止。
  var completed=(data.cache||data.allRequests).filter(function(req){return req.status==='returned';}).map(function(req){return {stageKey:req.stageKey,targets:frReplayRequestTargets(req)};});
  return {stages:Array.from(new Set(stages)),scopes:Array.from(new Set(scopes)),mode:'continue',allowDependencies:false,extra:'',completed:completed};
}
function frReplayTargetSelected(selection,stage,name){return (selection.stages||[]).includes(stage)||(selection.scopes||[]).includes(stage+':'+name);}
// 「智能重跑」：从本轮记录里自动挑出真正失败/没返回的目标，玩家不用自己翻找。
// 只挑失败项，成功的一项都不带——重跑范围越小越安全，也越快。
// 选择与显示共享同一目标身份，人物阶段用姓名，其余优先稳定ID。
function frReplayScopeTargets(req){
  var key=frReplayStageKey(req.stageKey),names=frReplayRequestNames(req);
  // These requests carry timeline nodes in targetIds. Their replay scope is the NPC name.
  if(['预制人物修订','预制人物变量','预制成品落地'].includes(key))return names;
  var ids=frReplayRequestTargets(req);
  return ['生平旧账','人物边界批量判定','人物终态推演','人物视角散文','群像视角散文','落地依据提取'].includes(key)
    ? (names.length?names:ids) : (ids.length?ids:names);
}
function frReplayPendingFailures(context){
  var pending=context&&context.pendingFailures;
  if(!pending||pending.archiveName!==context.archiveName||pending.system!==context.system||String(pending.logId||'')!==String(context.logId||''))return {stages:[],scopes:[]};
  return {stages:Array.isArray(pending.stages)?pending.stages:[],scopes:Array.isArray(pending.scopes)?pending.scopes:[]};
}
function frReplayUpdatePendingFailures(context,selection,result){
  var previous=frReplayPendingFailures(context),done=result&&(result.replayCleared||selection)||{stages:[],scopes:[]};
  var stages=previous.stages.filter(function(stage){return !(done.stages||[]).includes(stage);});
  var scopes=previous.scopes.filter(function(scope){return !(done.stages||[]).includes(frReplaySplitScope(scope).stage)&&!(done.scopes||[]).includes(scope);});
  var failedScopes=result?result.failedScopes||[]:selection.scopes||[];
  var failedStages=result?result.failedStages||[]:selection.stages||[];
  failedStages.forEach(function(stage){if(!failedScopes.some(function(scope){return frReplaySplitScope(scope).stage===stage;})&&!stages.includes(stage))stages.push(stage);});
  failedScopes.forEach(function(scope){if(scope&&!scopes.includes(scope))scopes.push(scope);});
  return {archiveName:context.archiveName,system:context.system,logId:context.logId,stages:stages,scopes:scopes,at:Date.now()};
}
function frReplayActorFailureScopes(data){
  var latest=new Map(),scopes=[];
  frReplayViewsOf(data?.source||{}).filter(view=>view.kind==='characters'&&view.name).forEach(view=>latest.set(view.name,view));
  latest.forEach(function(view,name){
    var missing=Array.isArray(view.completion?.hardMissing)?view.completion.hardMissing:[];
    if(view.status==='saved'||view.completion?.completed!==false&&!missing.length&&!['error','cancelled'].includes(view.status))return;
    var requests=(data.allRequests||[]).filter(req=>frReplayRequestNames(req).includes(name)||view.actorId&&frReplayRequestTargets(req).includes(view.actorId));
    var table=data.context?.beforeMemory?.state?.['0']||{};
    var id=view.actorId||view.id||Object.keys(table).find(id=>String(table[id]?.['1']||'').split('|')[0]===name);
    var last=requests.at(-1),lastNames=last&&frReplayRequestNames(last)||[],lastIds=last&&frReplayRequestTargets(last)||[];
    if(!id&&lastNames.length===lastIds.length)id=lastIds[lastNames.indexOf(name)];
    id=id||name;
    var modules=new Set();
    missing.forEach(function(row){var module=typeof row==='object'&&(row.module||row.stage||row.stageKey);if(['characters','items'].includes(module))modules.add(module);});
    if(!modules.size&&['characters','items'].includes(view.completion?.phase))modules.add(view.completion.phase);
    if(!modules.size&&last&&['characters','items','biography','变量重复核验'].includes(last.stageKey))modules.add(last.stageKey);
    if(!modules.size){modules.add('characters');modules.add('items');}
    modules.forEach(module=>scopes.push(module+':'+id));
  });
  return Array.from(new Set(scopes));
}

function frReplayPrebuiltFailures(data){
  if(data.context?.system!=='canon')return null;
  var state=data.context.prebuiltRetry || frReplayResultOf(data.source||{}).prebuiltRepair;
  if(!state)return null;
  return {stages:[...new Set(state.failures.filter(row=>!row.subject).map(row=>row.stage))],
    scopes:[...new Set(state.failures.filter(row=>row.subject).map(row=>row.stage+':'+row.subject))]};
}
function frReplayFailedSelection(data){
  if(data.context?.system==='canon'&&data.ledgerReplay?.status==='error')return {stages:['补演账本'],scopes:[]};
  var prebuilt=frReplayPrebuiltFailures(data);
  if(prebuilt)return prebuilt;
  var stages=[],scopes=[],latest=new Map();
  var system=data&&data.context&&data.context.system||data&&data.system;
  var table=system?frReplayStagesFor(system):frReplayStagesFor('canon').concat(frReplayStagesFor('ce'));
  var legal=new Set(table.map(function(row){return row.key;}));
  var base=data&&(data.base||data.context),cleared=base&&base.cleared||{stages:[],scopes:[]};
  // merged只是一次真实HTTP请求，重跑仍选原阶段；不得伪造四份返回缓存。
  var mergedReceipt=system==='ce'&&(base&&base.mergedReplayReceipt||data&&data.source&&data.source.result&&data.source.result.mergedReplayReceipt);
  ((data&&(data.allRequests||data.cache))||[]).forEach(function(req){
    if(!req)return;
    var key=frReplayStageKey(req.stageKey);
    if(system==='canon'&&key==='canon-merged'){
      (req.mergedPhases||['characters','items']).forEach(function(stage){frReplayRequestTargets(req).forEach(function(id){latest.set(stage+':'+id,{key:stage,id:id,status:req.status==='returned'&&req.mergedAccepted!==true?'error':String(req.status||'').toLowerCase()});});});
      return;
    }
    if(system==='ce'&&key==='merged'){
      if(!mergedReceipt&&!['returned','skipped'].includes(String(req.status||'').toLowerCase())){
        (req.mergedPhases||['entry','items','misc']).filter(stage=>stage!=='characters').forEach(function(stage){latest.set(stage+':',{key:stage,id:'',status:'error'});});
        // 请求元数据只记录普通人物；重要人物的HTTP仍有独立characters回执。
        if(!req.mergedPhases||req.mergedPhases.includes('characters'))frReplayRequestTargets(req).forEach(function(id){latest.set('characters:'+id,{key:'characters',id:id,status:'error'});});
      }
      return;
    }
    if(!legal.has(key))return;
    var targets=frReplayScopeTargets(req);
    (targets.length?targets:['']).forEach(function(id){latest.set(key+':'+id,{key:key,id:id,status:String(req.status||'').toLowerCase()});});
  });
  if(mergedReceipt){
    (mergedReceipt.failedStages||[]).forEach(function(key){if(legal.has(key))latest.set(key+':',{key:key,id:'',status:'error'});});
    (mergedReceipt.failedScopes||[]).forEach(function(scope){var pair=frReplaySplitScope(scope);if(legal.has(pair.stage))latest.set(scope,{key:pair.stage,id:pair.name,status:'error'});});
  }
  latest.forEach(function(row){
    if(row.status==='returned'||row.status==='skipped')return;
    if((cleared.stages||[]).includes(row.key)||(cleared.scopes||[]).includes(row.key+':'+row.id))return;
    if(row.id)scopes.push(row.key+':'+row.id);else if(!stages.includes(row.key))stages.push(row.key);
  });
  var pending=frReplayPendingFailures(base);
  pending.stages.forEach(function(stage){if(legal.has(stage)&&!stages.includes(stage))stages.push(stage);});
  pending.scopes.forEach(function(scope){if(legal.has(frReplaySplitScope(scope).stage)&&!scopes.includes(scope))scopes.push(scope);});
  if(system==='canon'||!system){
    frReplayActorFailureScopes(data).forEach(function(scope){if(!scopes.includes(scope))scopes.push(scope);});
    // HTTP 返回不等于正文验收通过；智能重跑与面板必须读取最终语义债务。
    frReplayProseState(data.source||{}).forEach(function(row,name){
      if(row.accepted!==false)return;
      var req=(data.allRequests||[]).slice().reverse().find(function(req){return ['人物视角散文','群像视角散文'].includes(frReplayStageKey(req.stageKey))&&frReplayRequestNames(req).includes(name);});
      if(req){var scope=frReplayStageKey(req.stageKey)+':'+name;if(!scopes.includes(scope))scopes.push(scope);}
    });
  }
  return {stages:stages,scopes:scopes};
}
function frReplayProsePlan(data,selection){
  if(selection.system==='canon'&&selection.stages.includes('补演账本')){
    if(selection.stages.length!==1||selection.scopes.length)throw new Error('请单独选择补演账本。重跑其他阶段时，会随其结果更新账本。');
    return null;
  }
  var result=frReplayResultOf(data.source),blocks=frReplayProseState(data.source),materials={},writingInputs={},views=frReplayViewsOf(data.source);
  var prebuiltState=data.context?.prebuiltRetry || result.prebuiltRepair;
  var picked=selection.stages.concat(selection.scopes.map(scope=>frReplaySplitScope(scope).stage));
  var prebuiltRepair=selection.system==='canon'&&picked.some(stage=>stage.startsWith('预制'));
  if(prebuiltRepair){
    if(!prebuiltState||picked.some(stage=>!stage.startsWith('预制')))throw new Error('请单独选择本轮的预制修订或落地阶段。');
    var resume=result.continuationInput;
    var start=resume?.data?.worldTime||result.range?.start,end=resume?.data?.targetTime||result.range?.end;
    if(data.ledgerReplay?.review)prebuiltState={...prebuiltState,ledgerReview:data.ledgerReplay.review};
    return {prebuiltRepair,prebuiltState,prebuiltWasLanded:result.landed===true,
      localOnly:picked.every(stage=>stage==='预制成品落地'),
      continuationInput:structuredClone(resume||null),
      boundary:start&&end?{start,end,logId:data.context.logId}:null,
      stages:selection.stages.slice(),scopes:selection.scopes.slice(),mode:selection.mode,extra:selection.extra};
  }
  views.forEach(function(v){if(v.kind==='replayMaterial'&&v.name&&v.material)materials[v.name]={material:v.material,stage:v.proseStage};});
  /* ★★★ 2026-11-03 玩家：「我选了阶段也无法重跑」。
   *
   * 【这是「局部重跑永远 0 次调用」完整链条的最后一环，也是最根本的一环】
   *   blocks 上面只从两处收集：result.prose 与 events 里的 kind==='prose' 视图。
   *   而局部重跑取数据时，source 常常是 **artifacts**：
   *     source = { id:'artifacts:'+logId, requests:artifactRequests }   ← 只有 requests
   *   artifacts 里**不保留 events**（frCanonArtifactOfRequest 明确丢弃了它），
   *   于是 views=[]、result.prose=[],blocks 为空。
   *
   *   blocks 一空，下面 forEach 就不会执行，changed 与 seeds 全空 →
   *   frReplayProsePlan 返回「没有任何散文目标」→ 执行器一条散文请求都不生成
   *   → realCalls=0、复用 0 条 → 面板弹「本次没有可重算的内容」。
   *
   *   这解释了为什么把阶段名、人物名、misc 映射全部修对之后**依然跑不动**：
   *   问题不在名字，在于**散文计划压根没生出目标**。
   *
   * 【修法】补一条不依赖 events 的来源：从请求本身推出「这一轮写过谁」。
   *   人物视角散文/群像视角散文/配角群像 的请求 subject 就是人物名（顿号分隔），
   *   这是落库时一定保留下来的字段，比 events 可靠。
   *   对每个这种请求里的姓名建一个占位 block（body 暂为空），
   *   让下面的 selected/seeds 逻辑照常工作。
   *   占位不改变任何判定语义：它只提供「这个人属于本轮散文范围」这一事实。 */
  try{
    var proseStages=['人物视角散文','群像视角散文','配角群像'];
    (data.allRequests||[]).forEach(function(req){
      var sk=frReplayStageKey(req&&req.stageKey);
      if(proseStages.indexOf(sk)<0)return;
      frReplayRequestNames(req).forEach(function(nm){
        if(!nm||blocks.has(nm))return;
        blocks.set(nm,{block:{name:nm,body:''},accepted:false,fromRequest:true});
      });
    });
  }catch(_){}
  var seeds={},changed=[];
  blocks.forEach(function(row,name){
    var before=['生平旧账','人物边界批量判定','人物终态推演','差集与正文覆盖核对','人物视角散文','群像视角散文','配角群像'];
    var selected=before.some(function(stage){return frReplayTargetSelected(selection,stage,name);})||(selection.stages||[]).includes('正文硬事实提取');
    // 成功正文就是本轮已有成果。指纹只用于诊断，不能成为再次核验或重写的门槛。
    var refreshFacts=frReplayTargetSelected(selection,'落地依据提取',name);
    if(selected)changed.push(name);else if(row.accepted===true&&String(row.block?.body||'').trim())seeds[name]={block:structuredClone(row.block),material:materials[name]?.material||'',refreshFacts:refreshFacts};
    var exact=(selection.scopes||[]).map(frReplaySplitScope).find(function(scope){return scope.name===name&&['人物视角散文','群像视角散文','配角群像','落地依据提取'].includes(scope.stage);});
    if(exact&&materials[name])writingInputs[name]={material:materials[name].material,stage:materials[name].stage||exact.stage,reference:result.canonReferences?.[name]};
  });
  var actorIds={};data.allRequests.filter(function(req){return req.stageKey==='characters';}).forEach(function(req){var names=frReplayRequestNames(req),ids=req.targetIds?.length?req.targetIds:String(req.targetId||'').split(',');names.forEach(function(name,index){if(ids[index])actorIds[name]=ids[index];});});
  var observed=result.range||(views.filter(function(v){return v.kind==='events'&& v.range;}).at(-1)||{}).range;
  /* ★★★ 2026-11-03 玩家报：「本次未替换结果：原记录没有冻结的补演起止时间，无法精准继续；
   *   不会以当前时间重开整轮。」
   *
   * 原来只有 start 有兜底（退回账本世界时间），**end 完全没有**：
   *     var start=observed?.start||…worldTime, end=observed?.end;
   * 只要 events 里没留下 range，end 就是 undefined → boundary 变 null →
   * 执行时第 1122 行判定 !selection.replay.boundary 直接抛错，整次重跑白做。
   *
   * end 的正确兜底是**本轮已推进到的世界时间**：
   * 补演的语义就是「把世界时间从 start 推到 end」，
   * 而回合跑完后账本上的世界时间正是这次推进的终点。
   * 顺序：① 记录里冻结的 end → ② 运行结果里的世界时间 → ③ 账本当前世界时间 → ④ start。
   * 这样只要这一层确实跑过，就一定能冻结出一段合法的起止时间，
   * 不再因为少了 events.range 就把整次重跑判死。 */
  var start=observed?.start||data.context?.beforeMemory?.state?.canonLedger?.worldTime,
      end=observed?.end
        ||result?.worldTime
        ||result?.endTime
        ||data.context?.afterMemory?.state?.canonLedger?.worldTime
        ||data.context?.beforeMemory?.state?.canonLedger?.worldTime
        ||start;
  /* ★★★ 2026-11-03 玩家：「我选了阶段也无法重跑」。
   *
   * 这条 warn 是**给玩家排查用的**，必须用 console.warn 而不是 console.info：
   * 玩家客户端只有 WARN 及以上会进 render.log，info 一律不留痕
   * （上次「局部重跑·判定」用 info 写，日志里一条都查不到，白查半天）。
   *
   * 打三样东西，足以定位「为什么 0 次调用」：
   *   ① blocks 收集到多少人（= 散文目标总数）
   *   ② changed 几人（= 判定为要重写的人）
   *   ③ seeds 几人（= 复用旧正文的人）
   * 三者全 0 → 计划没生目标；changed 为 0 但 blocks>0 → 选中判定没命中。 */
  try{
    console.warn('[局部重跑] 散文计划 → 目标块='+blocks.size
      +' 需重写='+changed.length
      +' 复用='+Object.keys(seeds).length
      +' ｜阶段='+JSON.stringify(selection.stages||[])
      +' ｜人物='+JSON.stringify(selection.scopes||[]));
  }catch(_){}
  /* 注意：这里**不要**返回 frozenBoundary。
   * 前置分工由外层（开始局部重跑那段）异步取回后挂到 selected.replay 上，
   * 因为本函数是同步的，而取值是异步的。
   * 2026-11-03 玩家报「本次未替换结果：frozenBoundary is not defined」——
   * 就是我上一版删了声明却漏了这个引用。 */
  var ledgerCloseout=result.actorProgressSaved===true&&selection.stages.length===1&&selection.stages[0]==='misc'&&!selection.scopes.length;
  return {seeds:seeds,changed:changed,writingInputs:writingInputs,scopes:selection.scopes.slice(),stages:selection.stages.slice(),actorIds:actorIds,mode:selection.mode,ledgerCloseout:ledgerCloseout,
    variableHandoff:frReplayVariableHandoff(data,selection,result,seeds),
    continuationInput:structuredClone(result.continuationInput || views.find(function(v){return v.kind==='continuationInput';})?.input || null),
    worldState:(selection.mode==='continue'||ledgerCloseout)?structuredClone(result.worldState || null):null,
    worldOrder:result.actorProgressSaved&&!changed.length?(result.prose||[]).map(block=>block.name):null,
    materialState:selection.mode==='continue'?structuredClone(result.materialState || data.source.materialState || null):null,
    boundary:start&& end?{start:start,end:end,logId:data.context.logId}:null};
}
// 全局边界的真实上游被点选时，不能用冻结结果绕过玩家的选择。
function frReplayBoundarySelected(selection){
  var stages=(selection.stages||[]).concat((selection.scopes||[]).map(function(scope){return frReplaySplitScope(scope).stage;}));
  return !stages.length||stages.some(function(stage){return ['vectorContext','资料检索','采集资料','正文硬事实提取','补演边界格式整理','补演边界判定'].includes(frReplayStageKey(stage));});
}
async function frReplayPrepareBoundary(data,selection){
  var replay=selection.replay,context=data.context||{};
  if(!replay)return;
  delete replay.frozenBoundary;
  replay.preserveInput=false;
  if(selection.system!=='canon')return;
  var resume=replay.continuationInput;
  var sameTurn=resume?.version===1&&resume.data&&context.archiveName&&context.logId
    &&resume.data.archiveName===context.archiveName&&resume.data.logId===context.logId;
  if(!sameTurn)replay.continuationInput=null;
  replay.preserveInput=!!sameTurn;
  if(frReplayBoundarySelected(selection)){
    // 重判采用该楼层原始正文的时间头，同时保留原时点人物快照和账本事实。
    if(sameTurn)delete replay.continuationInput.preparedBoundary;
    var targetTime=context.args?.storyText&&frCanonReadAdoptedStoryHeader(context.args.storyText)?.time;
    var beforeState=context.beforeMemory?.state;
    var beforeClock=beforeState?.currentState && ceGetAuthoritativeTimeLocationInfo(beforeState.currentState).timeText;
    var originalStart=beforeState?.canonLedger?.worldTime
      || (beforeClock!=='时间未知'&&beforeClock)
      || (sameTurn&&resume.data.worldTime)||replay.boundary?.start;
    if(targetTime&&originalStart){
      replay.boundary={start:originalStart,end:targetTime,logId:context.logId};
      if(sameTurn){resume.data.worldTime=originalStart;resume.data.targetTime=targetTime;}
    }
    return;
  }
  var frozen=null;
  if(context.archiveName&&context.logId&&typeof frCanonBoundaryLoad==='function'){
    try{frozen=await frCanonBoundaryLoad(context.archiveName,context.logId,'canon');}catch(_){}
  }
  function reliable(boundary){return boundary&&boundary.ok!==false&&!!(boundary.inputStamp||boundary.turnPlan?.inputStamp);}
  // 独立冻结键可能未刷盘；本轮回执也保存了同一份完整边界，不能因键缺失整轮重发。
  if(!reliable(frozen)&&sameTurn)frozen=resume.preparedBoundary;
  // 此处仅认来源和完整性。正文、时间、年表及语义指纹仍由实际编排器逐项校验。
  if(reliable(frozen))replay.frozenBoundary=frozen;
}
/* ★ 2026-11-02 玩家：「会不会原著补演的重跑也有这个问题，你都复查一下，然后修复」
 *
 * 统一的安全 scope 拆分。scope 形如 "阶段key:人物名"，但**不是每一条都长这样**：
 *   · 只勾了阶段没勾人物时，可能没有冒号，或冒号后面是空的；
 *   · 上游任何一处拼错也会产生这种残缺串。
 *
 * 原来的写法直接用 indexOf/slice，遇到这种串会算出错误结果：
 *   · scope.indexOf(':') 在没有冒号时返回 -1，
 *     scope.slice(0, -1) 会把**最后一个字符吃掉**（"entry" → "entr"），
 *     于是拿一个不存在的阶段名去查 ranks，永远查不到，依赖判定整条失效；
 *   · scope.slice(cut+1) 在冒号后为空时拿到空字符串，
 *     再被当成「一个人物名」塞进集合，就会得出「勾了 1 个人却对不上」的假结论。
 *
 * 这个函数只做一件事：把 scope 稳定地拆成 {stage, name}，
 * 任何残缺串都返回空字符串，让调用方可以干净地跳过它们。
 */
function frReplaySplitScope(scope){
  var text=String(scope==null?'':scope),cut=text.indexOf(':');
  if(cut<0)return {stage:'',name:'',valid:false};          // 没有冒号：不是「阶段:人物」结构
  var stage=frReplayStageKey(text.slice(0,cut).trim()),name=text.slice(cut+1).trim();
  return {stage:stage,name:name,valid:!!(stage&&name)};     // 冒号后为空 → valid=false
}
/* ★★★ 2026-11-02 玩家定调（原话）：
 *   「很简单，相关关联的流程只要选择其中任何一个，会自动把他的前置流程选上，不就可以了？」
 *   「只要是有必要关联的前后当然都要一起，不然前面变了，关联的后面没改，那不是矛盾了？」
 *   「不对，流程完全不一样，不能共用，我说的是问题的逻辑和本质一样，不是让你共用偷懒」
 *
 * 于是这里定义**两份完全独立的阶段表**，绝不合并、绝不互相套用：
 *   · CC_REPLAY_STAGES_CANON —— 原著补演，阶段多、依赖链严密
 *   · CC_REPLAY_STAGES_CE    —— 变量演化，阶段少、经查无数据依赖
 *
 * 每项字段：
 *   key    面板与选择里用的键（和实际请求的 stageKey 一致）
 *   name   给玩家看的中文名
 *   hint   一句话说明「重跑这个会发生什么」
 *   needs  它必须依赖的上游（勾它就要一起带的前置）
 *   feeds  依赖它的下游（它的结果变了，这些也得跟着重算，否则前后矛盾）
 *   group  面板分组标题
 *
 * needs/feeds 只写「真的会因为数据变化而必须一起跑」的关系，
 * 不写「流程上碰巧排在后面」的关系 —— 那会把范围无端放大。
 */

/* ===== 原著补演 =====
 *
 * ★ 2026-11-02 关于 feeds（下游）的粒度，特意做得比 needs 保守：
 *   needs 是「没有它就出不来结果」，必须一路带到底；
 *   feeds 只写「直接吃它的产物」的那一层，不做无限传递。
 *
 * 原因：玩家要的是「前面变了、关联的后面也跟着改」，不是「一点就全家桶」。
 * 如果把 feeds 也做成传递闭包，勾一项就会把十几个阶段全带上，
 * 那等于变相整轮重跑，既慢又违背「选什么跑什么」。
 * 所以这里只写真实的数据流向，靠 needs 保证上游完整、靠这一层保证下游不落单。
 */
var CC_REPLAY_STAGES_CANON=[
  {key:'补演账本',name:'补演账本',group:'账本',hint:'核对已经保存的事件进度；有变异时重新整理变异记录。',needs:[],feeds:[]},
  {key:'预制变异边界',name:'预制变异边界',group:'预制成品',hint:'核对变异节点及影响范围。',needs:[],feeds:[]},
  {key:'预制人物修订',name:'预制人物正文',group:'预制成品',hint:'在成品基础上修订人物视角。',needs:[],feeds:['预制人物变量']},
  {key:'预制人物变量',name:'预制人物变量',group:'预制成品',hint:'按节点继承上一状态，根据本人正文结算。',needs:['预制人物修订'],feeds:[]},
  {key:'预制世界大事修订',name:'预制世界大事修订',group:'预制成品',hint:'修订受影响的世界大事。',needs:[],feeds:[]},
  {key:'预制成品落地',name:'预制成品落地',group:'预制成品',hint:'用已验证结果重新提交。',needs:[],feeds:[]},
  /* ★★★ 2026-11-03 玩家定（原话）：
   *   「对。这个东西的本质也是蝴蝶效应和变异因子传导链之一，
   *    整个原著补演最骨架的设计就是蝴蝶效应和变异因子的积累传导」
   *   「其实现缺的只是原著补演参考环需要加入上一轮的世界事件作为参考，其他都没问题」
   *
   * 【曾经加过一个「世界变化预判」阶段，已撤销】
   * 当时以为是「世界变化回不到本轮开头」这个缺陷，就在资料检索前另起一次模型调用
   * 猜一份世界变化塞进本轮参考。玩家当场指出：
   *   「为什么叫预判？不是说在npc正文写之前的事件大事件都只是作为参考资料吗？」
   * 核实后确认这是旁路，不在这条积累传导链上：
   *   · 世界大事本来就已在参考环里（原著指导、NPC 散文都吃得到上一轮的世界大事）
   *   · 它本身是**一份持续累积的记录**，不是「猜」也不是「待定」
   *   · 缺的不是内容，是**提示词没讲清这份资料是干什么的、怎么被本轮行为更新的**
   * 所以正确做法是补提示词说明，不是再加一次调用。
   *
   * 【本表顺序 = 真实执行顺序】
   * 玩家问过「这些阶段是按照运行流程顺序排的吗」——原来分四组是功能分类，
   * 和真实流程对不上，按面板理解必然错。现在按 orchestrator 里 step 打点的真实前后排。 */
  {key:'vectorContext',name:'资料检索',group:'准备资料',hint:'按原著查本轮涉及事件的背景资料。',needs:[],feeds:['正文硬事实提取','补演边界格式整理']},
  {key:'正文硬事实提取',name:'正文硬事实提取',group:'准备资料',hint:'从正文里抽出确定无疑的事实，作为后续推演的依据。',needs:['vectorContext'],feeds:['人物边界批量判定']},
  {key:'补演边界格式整理',name:'补演边界格式整理',group:'准备资料',hint:'整理本轮补演的起止边界格式。',needs:['vectorContext'],feeds:[]},
  {key:'人物边界批量判定',name:'人物边界批量判定',group:'人物推演',hint:'一次性判断每个相关人物这轮走到了哪一步。',needs:['正文硬事实提取'],feeds:['生平旧账','人物终态推演']},
  {key:'生平旧账',name:'生平旧账',group:'人物推演',hint:'补上每个人物过去经历中与本轮相关的那部分。',needs:['人物边界批量判定'],feeds:['人物终态推演']},
  {key:'人物终态推演',name:'人物终态推演',group:'人物推演',hint:'推出每个人物本轮结束时的状态、行为与动机。',needs:['生平旧账','人物边界批量判定'],feeds:['差集与正文覆盖核对']},
  {key:'差集与正文覆盖核对',name:'差集与正文覆盖核对',group:'人物推演',hint:'核对推演结果和正文有没有冲突、有没有漏掉。',needs:['人物终态推演'],feeds:['人物视角散文','群像视角散文']},
  {key:'落地依据提取',name:'落地依据提取',group:'人物推演',hint:'从已写的人物正文提取落档事实；通常随正文同次返回。',needs:['人物视角散文','群像视角散文'],feeds:['characters']},
  {key:'人物视角散文',name:'人物视角散文',group:'人物正文',hint:'用人物自己的视角写这一轮他经历了什么。',needs:['差集与正文覆盖核对'],feeds:['落地依据提取','世界事件补演']},
  {key:'群像视角散文',name:'群像视角散文',group:'人物正文',hint:'一次写一组人物的视角正文。',needs:['差集与正文覆盖核对'],feeds:['落地依据提取','世界事件补演']},
  /* 世界事件补演排在这里不是缺陷，是积累链的必然：
   * 它要把「本轮所有人物实际做了什么」汇聚成新的世界大事，
   * 而人物正文是那份实际结果——汇聚只能发生在产生之后。 */
  {key:'世界事件补演',name:'世界事件补演',group:'世界与落地',hint:'把本轮所有人物正文的实际结果汇聚成新的世界大事，供下一轮所有人参考。',needs:['人物视角散文','群像视角散文'],feeds:['misc']},
  {key:'characters',name:'人物存档落地',group:'世界与落地',hint:'把上面推演的结果真正写进人物档案。',needs:['落地依据提取'],feeds:['items']},
  {key:'items',name:'物品更新',group:'世界与落地',hint:'更新物品、灵石和装备的归属与状态。',needs:['characters'],feeds:[]},
  {key:'变量重复核验',name:'变量重复核验',group:'世界与落地',hint:'检查有没有同一个变量被重复写入。',needs:['items'],feeds:[]},
  {key:'tags',name:'人物标签',group:'世界与落地',hint:'更新人物身上的标签。',needs:['变量重复核验'],feeds:[]},
  {key:'biography',name:'生平整理',group:'世界与落地',hint:'按原规则整理已有生平。',needs:['tags'],feeds:[]},
  {key:'misc',name:'世界、地图与任务',group:'世界与落地',hint:'处理世界事件、地图变化与任务进展。',needs:['biography'],feeds:[]}
];

/* ===== 变量演化 =====
 * 每个阶段都是「读本回合正文 + 预设 + 当前档案」自己算，
 * 不读别的阶段的输出（已逐个核对入参）。所以这里 needs/feeds 几乎全空。
 * 唯一保留的是玩家认可的那一条：角色演化需要登场判断先把人落定。 */
var CC_REPLAY_STAGES_CE=[
  {key:'tags',name:'人物标签',group:'变量演化',hint:'重新校准本轮涉及人物的标签。',needs:[],feeds:[]},
  {key:'entry',name:'登场与退场',group:'变量演化',hint:'重新判断谁在这一轮登场、谁离场，以及全局变化。',needs:[],feeds:['characters']},
  {key:'items',name:'物品更新',group:'变量演化',hint:'重新处理物品、灵石和装备。',needs:[],feeds:[]},
  {key:'characters',name:'人物状态更新',group:'变量演化',hint:'让选中的角色逐个重新演化（最耗时的一步）。',needs:['entry'],feeds:[]},
  {key:'misc',name:'世界、地图与任务',group:'变量演化',hint:'重新处理世界事件、地图与任务。',needs:[],feeds:[]},
  {key:'biography',name:'生平整理',group:'变量演化',hint:'按原规则整理已有生平。',needs:[],feeds:[]}
];

/* 取当前系统的阶段表。这是唯一的分派点，两张表本身互不相干。 */
function frReplayStagesFor(system){
  return String(system||'')==='ce'?CC_REPLAY_STAGES_CE:CC_REPLAY_STAGES_CANON;
}
function frReplayStageMeta(system,key){
  var list=frReplayStagesFor(system);
  for(var i=0;i<list.length;i++)if(list[i].key===key)return list[i];
  return null;
}
/* 计算实际执行集合：勾中任意一项，按当前系统自己的表把必须一起跑的带上。
 *
 * 玩家原话：「只要是有必要关联的前后当然都要一起，不然前面变了，
 *           关联的后面没改，那不是矛盾了？」
 *
 * 规则（三条，缺一条就会失控）：
 *   ① 上游 needs —— **递归带到底**。
 *      勾「人物视角散文」就必须有「落地依据提取」，它又必须有「差集核对」……
 *      整条上游链缺一环都跑不出来，所以一路补全。这部分是真正的最小必要集。
 *
 *   ② 下游 feeds —— **只对玩家亲手勾的那一项，带一层**。
 *      我的结果变了，直接吃我结果的那一层要跟着重算，否则前后矛盾。
 *      但**不对自动带上的项再展开下游**：否则「检索」被上游带进来后，
 *      它的下游「世界事件补演」也会被拖进来；「落地依据」被带进来后，
 *      和「人物视角散文」并列的「群像视角散文」「配角群像」也会被拖进来——
 *      这些都不是必要关联，是变相整轮重跑。
 *
 *   ③ 带上来的下游不再反向补它自己的全部上游。
 *      比如带上「人物存档落地」，它名义上需要三种散文，但那是并列分工，
 *      玩家只勾了一种就只更新那一种，不该把另外两种也拉来跑。
 *
 * 返回 {stages:[键], added:对象(键 => 触发它的那个键)}，
 * added 里只放「不是玩家直接勾的、被关联带上的」，面板要如实标出来。
 */
function frReplayExpandSelection(system,keys){
  var list=frReplayStagesFor(system),byKey={};
  list.forEach(function(s){byKey[s.key]=s;});
  var picked={},added={},userPicked=[];
  (Array.isArray(keys)?keys:[]).forEach(function(k){
    if(byKey[k]&&!picked[k]){picked[k]=true;userPicked.push(k);}
  });

  /* ★★★ 2026-11-03 玩家定：上游不再自动带上。
   *
   * 玩家原话：
   *   「其实我仔细看了一眼，我认为真正的问题都有结果给下一个阶段用，
   *     每个需要资料的阶段都有资料可以复用，现在似乎是只有资料可复用」
   *   「对，否则你怎么重跑后面的阶段呢？上一阶段的结果本质上不就是下一阶段的资料吗？」
   *   「要做当然要做到底」「执行落实」。
   *
   * 【原来错在哪】
   * 这里原来有一段「① 上游递归带到底」：勾一个阶段，就把 needs 链上所有上游
   * 全塞进 picked。勾「落地依据提取」实际等于勾了 6 个阶段
   * （资料检索 → 正文硬事实提取 → 人物边界批量判定 → 生平旧账/人物终态推演
   *  → 差集与正文覆盖核对 → 落地依据提取）。
   *
   * 后果不只是「多跑几步」：这 6 个阶段全部进了 selection.stages，
   * frReplayTargetSelected 对它们一律返回 true，于是 frReplayResolve 里
   * 「没勾中的阶段复用上次结果」那条通用规则**一次都进不去**，
   * 每个上游都被当成「玩家要求重算」→ 整条链重问模型。
   * 玩家只想要一步，得到的是整轮。
   *
   * 【为什么去掉是对的】
   * 上游阶段的产物本来就会被保存（同一次运行记录里的 response），
   * 下游要它当输入时，走的是「按阶段名+人物复用上次结果」那条通用路径，
   * 不需要也不应该由扩展器替玩家把上游按下重跑。
   * 玩家勾谁就跑谁，其余一律复用 —— 这才与面板上那句
   * 「其余有效结果复用」一致。
   *
   * 【仍然保留的】下游带一层（见下）—— 它是「勾中的阶段变了，它的直接消费者
   * 需要跟着更新」这一个方向，不会反向把上游拖下水。
   */
  /* ② 下游只对「玩家亲手勾的项」带一层，不再往下展开。 */
  userPicked.forEach(function(key){
    var meta=byKey[key];
    if(!meta)return;
    (meta.feeds||[]).forEach(function(down){
      if(!byKey[down]||picked[down])return;
      picked[down]=true;
      if(!added[down])added[down]=key;
    });
  });

  /* 输出按表的自然顺序，保证面板显示和执行顺序稳定。 */
  var stages=list.filter(function(s){return picked[s.key];}).map(function(s){return s.key;});
  return {stages:stages,added:added};
}

/* 阶段依赖的下游闭包：从所选阶段出发，沿 feeds 一路往下走。
 *
 * ★★★ 2026-11-03 玩家：「单独重跑没有落实到位，实际还是每次一刀切从头开始跑，
 *   你需要全面核查复盘所有单独的项目的关联上游和实际重跑执行逻辑。」
 *
 * 【原来的病】frReplayDependency 用的是一张**线性 ranks 表**：
 *   var ranks={vectorContext:-1,'正文硬事实提取':0,'补演边界格式整理':0,...'misc':10}
 *   判定写成「rank >= 所选阶段的 rank 就算要跑」。
 * 这是把 DAG 压成了一个序号，语义完全错：
 *   · '补演边界格式整理' 是**独立分支**（只读资料检索、不产出任何下游），
 *     但它排 0，于是勾它 = 后面 16 个阶段全部重跑；
 *   · '物品更新' 排在 6，勾它会连带 tags/biography/misc，可它 feeds 是空的；
 *   · 实测 17 个阶段全部加起来多跑 87 个项次（详见 _audit-stage-scope.cjs）。
 * 玩家看到的「一刀切从头跑」就是这个。
 *
 * 【现在的口径】玩家 2026-11-03 定：
 *   勾某个阶段 = 跑它自己 + 它 feeds 的**真正下游**；上游有现成结果就复用，不重跑。
 * 直接复用项目里已经维护好的 CC_REPLAY_STAGES_CANON / _CE 的 needs/feeds，
 * 不再另立一套序号表——两套口径打架正是这个 bug 反复修不好的根源。
 */
function frReplayStageTable(system){
  return system==='ce'
    ? (typeof CC_REPLAY_STAGES_CE!=='undefined'?CC_REPLAY_STAGES_CE:[])
    : (typeof CC_REPLAY_STAGES_CANON!=='undefined'?CC_REPLAY_STAGES_CANON:[]);
}
/* 从一组起始阶段出发，算出「自己 + 沿 feeds 的全部下游」。 */
function frReplayDownstreamClosure(startStages,system){
  var table=frReplayStageTable(system),out=new Set(),queue=[];
  (startStages||[]).forEach(function(k){if(k&&!out.has(k)){out.add(k);queue.push(k);}});
  while(queue.length){
    var cur=queue.shift();
    var node=table.find?table.find(function(s){return s.key===cur;}):null;
    if(!node||!Array.isArray(node.feeds))continue;
    node.feeds.forEach(function(f){
      if(f&&!out.has(f)){out.add(f);queue.push(f);}
    });
  }
  return out;
}
function frReplayDependency(req,selection){
  if(!selection.replay)return false;
  if(selection.replay.actorReplacement&&['世界事件补演','世界事件核验','misc'].includes(req.stageKey))return false;
  var identities=new Set(frReplayRequestTargets(req).concat(frReplayRequestNames(req)));
  Object.entries({...selection.replay.actorIds,...selection.replay.actorReplacement?.actorIds}).forEach(function(pair){if(identities.has(pair[0])||identities.has(pair[1])){identities.add(pair[0]);identities.add(pair[1]);}});
  var relevantScopes=(selection.scopes||[]).filter(function(scope){var parts=frReplaySplitScope(scope);return parts.valid&&(!identities.size||identities.has(parts.name));});
  if(selection.replay.actorReplacement){
    const prose=['人物视角散文','群像视角散文','配角群像'];
    if(prose.includes(req.stageKey)&&relevantScopes.some(scope=>prose.includes(frReplaySplitScope(scope).stage)))return true;
  }
  /* 本次重跑属于哪条系统：canon 用原著阶段的 DAG，ce 用自己的。
   * selection.system 由 frReplayExecuteSmart 之前的调用方带上；
   * 拿不到时按 canon 处理（原著补演是默认系统）。 */
  var system=selection.system==='ce'?'ce':'canon';
  if(selection.mode==='continue'&& Array.isArray(selection.completed)){
    var targets=frReplayRequestTargets(req),done=selection.completed.some(function(old){return old.stageKey===req.stageKey&&(!targets.length&&!old.targets.length||targets.some(function(id){return old.targets.includes(id);}));});
    if(done)return false;
    /* 「继续本轮」：只补跑「已完成阶段的下游 + 本次点名的阶段」。
     * 原来用 ranks[stage] 取最小值再比大小，缺 key 的阶段直接被忽略，
     * 现在用闭包，缺 key 顶多不进集合，不会算出假的先后关系。 */
    var pendingStages=(selection.stages||[]).concat(relevantScopes.map(function(scope){return frReplaySplitScope(scope).stage;}).filter(Boolean));
    var needContinue=frReplayDownstreamClosure(pendingStages,system);
    return needContinue.has(req.stageKey);
  }

  /* 定点重跑（玩家在面板上明确勾了什么）：
   * 只跑「勾选的阶段 + 它们的下游」，其余阶段一律复用已有结果。 */
  var pickedStages=(selection.stages||[]).slice();
  relevantScopes.forEach(function(scope){
    var parts=frReplaySplitScope(scope);
    if(parts.valid&&parts.stage)pickedStages.push(parts.stage);
  });
  var need=frReplayDownstreamClosure(pickedStages,system);
  if(selection.replay.actorReplacement&&relevantScopes.length&&['变量重复核验','tags','biography'].includes(req.stageKey))return true;
  if(!need.size)return false;
  if(need.has(req.stageKey))return true;
  /* 世界事件补演 / misc 这类「跟人物无关的全局产出」：
   * 只有在本轮**有人物级阶段被选中**时才需要连带，避免只勾一个人还去重跑世界。 */
  return false;
}
async function frCeOwnsRequests(){try{var config=await loadConcurrentEvolutionConfig();if(!(config&& config.enabled&& config.apiUrl&& config.apiKey&& config.apiModel))return false;return frCeRequestOwnership(config,await getActiveConcurrentEvolutionPreset()).ok;}catch(_){return false;}}
/* frReplayFail 要往「正在跑的那次重跑」的会话里记错误。
 *
 * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
 * 原来直接读全局 frReplaySession —— 两条线路并行时可能读到**别人的会话**，
 * 把 A 的失败写进 B 的 invalid，B 明明好好的却被判中止。
 *
 * 现在按系统取：canon / ce 各自一份，互不影响。
 * （同一次重跑内部用的是局部别名 self，比这里更精确；这里只用系统兜底。） */
function frReplayFail(label,error,source){
  var message=String(label||'重跑失败')+'：'+String(error&&error.message||error||'未知原因');
  var owner=typeof source==='string'?frReplaySessionOf(source):frReplaySessionBySignal(source);
  if(!owner&&!source){
    var active=[frReplaySessionOf('canon'),frReplaySessionOf('ce')].filter(Boolean);
    if(active.length===1)owner=active[0];
  }
  if(!owner)return;
  owner.invalid=owner.invalid||message;
  try{owner.controller?.abort(new Error(owner.invalid));}catch(_){}
}

/* 按「阶段名 + 人物」宽松匹配可复用结果。
 *
 * ★★ 2026-11-01 玩家定：局部重跑时没选中的阶段，不该因为 cacheKey 差一个字节就整轮中止。
 *
 * ★★★ 2026-11-03 玩家定（彻底版）：不再有「某阶段禁止复用」的黑名单。
 * 玩家原话：
 *   「每个需要资料的阶段都有资料可以复用，现在似乎是只有资料可复用」
 *   「上一阶段的结果本质上不就是下一阶段的资料吗？」
 *   「要做当然要做到底」「执行落实」。
 *
 * 原来这里有一份 BLOCKED=['落地依据提取','vectorContext']，
 * 理由是担心这些阶段带着**全局状态**（落地依据可能返回 eventProgress 事件进度），
 * 复用旧值会把上次的进度当成这次的、造成重复记账。
 *
 * 那个担心本身成立，但结论错了：问题是**某个字段**不该复用，
 * 不是**整个阶段**不该复用。用「整阶段禁运」去解决一个字段的问题，
 * 等于把所有按人物独立产出的人物结果也一并丢掉，玩家只能整条链重算。
 *
 * 正确做法是**字段级剔除**：先按阶段+人物宽松匹配，命中后把那些
 * 带全局语义的字段从返回里摘掉（见 frReplayStripGlobalFields），
 * 人物部分的结果照常复用。阶段一视同仁，没有例外名单。
 *
 * 安全性边界（仍然保留，不是无脑复用）：
 *   · 只认同一个 stageKey —— 不同阶段的结果语义完全不同，绝不混用。
 *   · 人物集合必须一致 —— 少人多人都算材料不同，宁可重算。
 *   · 只认 status==='returned' 且确实带 choices[0].message.content 的。
 *   · 从新到旧取最近一条 —— 越接近当前状态越可信。
 * 满足不了就返回 null，让调用方照旧去重算（而不是中止）。
 */
function sameStageReusable(req,session){
  if(!req||!req.stageKey||!session||!Array.isArray(session.cache))return null;
  var wantNames=frReplayRequestNames(req);
  var want=(wantNames.length?wantNames:frReplayRequestTargets(req)).slice().sort().join('、');
  for(var i=session.cache.length-1;i>=0;i--){
    var old=session.cache[i];
    if(!old||old.stageKey!==req.stageKey)continue;
    if(frReplayArtifactExcluded(req,old))continue;
    if(old.status!=='returned')continue;
    if(!old.response||!Array.isArray(old.response.choices))continue;
    if(typeof old.response.choices[0]?.message?.content!=='string')continue;
    var wantIds=req.targetIds?.length?req.targetIds:req.targetId?[req.targetId]:[];
    var haveIds=old.targetIds?.length?old.targetIds:old.targetId?[old.targetId]:[];
    if(wantIds.length&&haveIds.length&&wantIds.slice().sort().join('、')!==haveIds.slice().sort().join('、'))continue;
    // 人物集合必须一致：req 与缓存项都按同样规则摊平成「名字、名字」再比。
    var oldReq={subject:old.subject,targetId:old.targetId,targetIds:old.targetIds};
    var haveNames=frReplayRequestNames(oldReq);
    var have=(haveNames.length?haveNames:frReplayRequestTargets(oldReq)).slice().sort().join('、');
    if(want!==have)continue;
    return old;
  }
  return null;
}

/* 把「带全局语义、不能跨次复用」的字段从一份已缓存的模型返回里摘掉，
 * 其余字段原样保留。
 *
 * 目前只有 eventProgress（事件进度）：它是**全员共享**的推进量，
 * 复用旧值等于把上次的进度当成这次的，会重复记账。
 * 摘掉之后：
 *   · 人物部分（各人边界/旧账/落地依据）照常复用 —— 这是玩家要的；
 *   · eventProgress 缺失 → 调用方按「这次没算出来」处理，该补的补，
 *     不会拿旧值冒充新结果。
 *
 * 返回新的 response 对象（结构化克隆过），不改动 session.cache 里的原件。
 */
function frReplayStripGlobalFields(response,stageKey){
  if(!response||!Array.isArray(response.choices))return response;
  var copy=structuredClone(response);
  var content=copy.choices[0]?.message?.content;
  if(typeof content!=='string')return copy;
  try{
    var text=content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,'').replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'').trim();
    var parsed=JSON.parse(text);
    if(!parsed||typeof parsed!=='object')return copy;
    if(Object.prototype.hasOwnProperty.call(parsed,'eventProgress')){
      delete parsed.eventProgress;
      copy.choices[0].message.content=JSON.stringify(parsed);
    }
    return copy;
  }catch(_){
    // 解析不了就原样返回：宁可让调用方按原逻辑判断，也不猜。
    return copy;
  }
}

function frReplaySameWorldProgress(old,prompt,session){
  var proof=session.continuationInputVerified, selection=session.selection||{};
  if(!proof||proof.archiveName!==session.context?.archiveName||proof.logId!==session.context?.logId||
    selection.replay?.preserveInput!==true||selection.replay?.changed?.length||frReplayBoundarySelected(selection))return false;
  var codes=function(messages){
    var content=Array.isArray(messages)?messages.map(row=>String(row.content||'')).join('\n'):String(messages||'');
    return content.match(/(?:^|\n)本批候选编号：([^\r\n]+)/u)?.[1].split(',').map(id=>id.trim()).sort()||[];
  };
  var expected=codes(prompt);
  if(!expected.length||JSON.stringify(expected)!==JSON.stringify(codes(old.messages)))return false;
  var raw=old.response?.choices?.[0]?.message?.content;
  try{
    var rows=JSON.parse(String(raw||'').replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/giu,'')).eventProgress;
    return Array.isArray(rows)&&JSON.stringify(rows.map(row=>String(row.eventId||row.code||'').toUpperCase()).sort())===JSON.stringify(expected);
  }catch(_){return false;}
}

function frReplayResolve(req, prompt) {
  var session=req&& req._run&& req._run._replay;
  if(!session)return {reused:false,prompt:prompt};
  if(session.selection?.fullTurn){session.realCalls=Number(session.realCalls||0)+1;return {reused:false,prompt:prompt};}
  session.cache=(session.cache||[]).filter(function(old){return frReplaySemanticOwned(old,session);});
  frReplayNormalizeRequest(req);
  if(session.selection.replay?.prebuiltRepair &&
      ['预制变异边界','预制人物修订','预制人物变量','预制世界大事修订'].includes(req.stageKey)){
    session.realCalls=Number(session.realCalls||0)+1;
    return {reused:false,prompt:prompt};
  }
  var selection=session.selection,scope=req.stageKey+':'+(req.targetId||req.subject||'');
  var selected=(selection.stages||[]).includes(req.stageKey)||(selection.scopes||[]).includes(scope)||(req.targetIds||[]).some(function(id){return (selection.scopes||[]).includes(req.stageKey+':'+id);})||frReplayRequestNames(req).some(function(name){return frReplayTargetSelected(selection,req.stageKey,name);});
  /* ★★★ 2026-11-03 玩家报：「这次是一瞬间就显示完成了」。
   *
   * 「一瞬间完成」= 执行器跑完了、但**一个模型调用都没发出去**，
   * 也就是这条链上每个请求都被判成了「复用」。而玩家明明勾了要重跑。
   * 光看结果没法知道是哪一条判错，所以在这里把每个请求的判定打出来：
   *   阶段键 / 目标 / 是否判为选中 / 选择里到底有什么。
   * 只打 stage 与布尔值，不打正文，不影响性能也不泄露内容。 */
  try{
    console.info('[局部重跑·判定] '+(req.stageKey||'?')
      +(req.targetId||req.subject?(' / '+(req.targetId||req.subject)):'')
      +' → selected='+selected
      +'  (stages='+JSON.stringify(selection.stages||[])+', scopes='+JSON.stringify(selection.scopes||[])+')');
  }catch(_){}
  /* ★★ 2026-11-01 玩家反复撞上的那个错误：
   *     「当前合批包含未选人物，缺少可安全拆分的完整材料。本次停止，不会整组重新请求。」
   *
   * 原来这里是无条件中止：
   *   if(选中了部分人 && 这个请求里混进了没选中的人) → abort 整个 session
   *
   * 这个行为的后果被放大了：只要玩家用「局部重跑」选了 2 个人，
   * 而某个合批请求恰好把 3 个人合在一起，整轮补演就停死，
   * 面板只甩一句「缺少可安全拆分的完整材料」，玩家完全无从下手。
   * 这正是玩家说的「之前经常出现补演错误说人物不能拆分」。
   *
   * 关键事实：**这个函数下面就有 frReplayProjectInput，它能按姓名精确拆**。
   * 它已经支持三类结构化请求的拆分：
   *   · 人物边界批量判定（【独立人物：X】分段）
   *   · 生平旧账（编号 + 现状：分段）
   *   · 落地依据提取（【本批人物及其唯一待核验正文】后面的独立 JSON 数组）
   * 拆法：把消息内容重组成 [前缀, 只保留选中的人, 后缀]，并同步改写 subject。
   * 拆不出来（格式不是这三类、或人数对不上）才返回 null。
   *
   * 所以正确做法不是「一律中止」，而是：
   *   ① 先试着按选中名单**真的拆一份请求出来**；
   *   ② 拆成功了 → 用拆出来的请求继续跑（不再中止，也不再整组重请）；
   *   ③ 拆不出来（材料确实没有可安全切分的位置）→ 才中止，并且把原因说清楚。
   *
   * 这样既守住了 orchestrator.js 那条底线（
   *   「不能凭空空拆，那会把正常全量重跑也拆成一人一请求」），
   * 又不会把一个局部的、本来能拆的情况变成整轮停死。
   */
  if(selected&&!(selection.stages||[]).includes(req.stageKey)&& frReplayRequestTargets(req).some(function(id){return !frReplayTargetSelected(selection,req.stageKey,id);})){
    var targets=frReplayRequestTargets(req);
    var keepTargets=targets.filter(function(id){return frReplayTargetSelected(selection,req.stageKey,id);});
    /* frReplayProjectInput 认的是**姓名**，而且它内部会把 parts[1] 改写成
     * names.join('、')——也就是说它自己就把 subject 对齐了。
     * 所以这里只用 req.subject 里的姓名做筛选，不要再自己拼一套 targetIds，
     * 免得两套口径打架（targetId 可能是人物 id，subject 是姓名）。 */
    var projNames=frReplayRequestNames(req);
    var keepNames=projNames.filter(function(name,index){return frReplayTargetSelected(selection,req.stageKey,name)
      || targets.length===projNames.length&&frReplayTargetSelected(selection,req.stageKey,targets[index]);});
    keepTargets=targets.filter(function(id,index){return frReplayTargetSelected(selection,req.stageKey,id)
      || targets.length===projNames.length&&keepNames.includes(projNames[index]);});
    var projectionKey=req.semanticOnly?JSON.stringify([req.stageKey,req.subject,'',req.model,{},Array.isArray(prompt)?prompt:[{role:'user',content:String(prompt||'')}] ]):req.cacheKey;
    var splitKey=keepNames.length&&keepNames.length<projNames.length
      ?frReplayProjectInput(projectionKey,req.stageKey,keepNames)
      :null;
    if(splitKey){
      // 拆成功：就地改写成「只含选中人物」的请求，继续正常流程（不再中止整轮）。
      if(!req.semanticOnly)req.cacheKey=splitKey;
      // 缓存身份与实际发送内容必须一致，否则仍会重算未选中的人。
      var splitMessages=JSON.parse(splitKey)[5];
      prompt=Array.isArray(prompt)?splitMessages:splitMessages.map(function(message){return message.content;}).join('\n');
      req.subject=keepNames.join('、');
      if(Array.isArray(req.targetIds))req.targetIds=keepTargets.slice();
      else if(typeof req.targetId==='string')req.targetId=keepTargets.join(',')||keepTargets[0]||'';
      req.splitFromMixedBatch=true;
      try{
        if(typeof window!=='undefined'&&window.console)window.console.info('[原著补演] 合批含未选人物，已按选中名单拆出 '+keepNames.length+' 人继续，不中止整轮：'+keepNames.join('、'));
      }catch(_){}
    }else{
      session.invalid='当前合批包含未选人物，且这段材料没有可安全切分的位置（只支持「人物边界批量判定」「生平旧账」「落地依据提取」三类结构化请求）。本次停止，不会整组重新请求。'
        +'请改用「整轮重跑」，或先把这一批全部勾选/全部不勾选。';
      var grouped=new Error(session.invalid);grouped.name='ReplayDependencyError';grouped.code='FR_REPLAY_FAILURE';if(session.controller)session.controller.abort(grouped);throw grouped;
    }
  }
  /* ★★★ 2026-11-03 玩家拍板（原话）：
   *   「局部补演并不是只能补演失败的项目，而是即使成功了也要丢弃原有结果进行补演，
   *     只要玩家选择了，你能理解这个意思吗？」
   *
   * 【原来错在哪】这一行的写法是
   *     var cached = (!selected || (selection.smartReuse||[]).includes(req.cacheKey)) && ...
   * 表面看「选中了就不复用」，但后面那个 || 会把 selected 的意图整个抵消：
   * smartReuse 是在 frReplayExecuteSmart 里把**所有成功项**的 cacheKey 都塞进去的（第 1549 行），
   * 于是只要这一项上次跑成功过，无论玩家勾没勾，都会命中缓存直接复用 ——
   * 玩家勾了「重跑这个」，界面表现却是原地不动，等于没跑。
   *
   * 【现在】选中 = 强制重算，不接受任何缓存。
   * 玩家勾选的含义是「这一项的旧结果我不要了，重新生成」，
   * 这是主动作废，不是「允许复用」。所以 selected 必须一票否决 smartReuse。
   * 只有**没被选中**的请求才走缓存复用（那才是「其余有效结果复用」的本意）。 */
  var dependent=frReplayDependency(req,selection)||selection.allowDependencies&& frReplayDependency(req,Object.assign({},selection,{replay:selection.replay||{}}));
  var cached=(!selected)&&!(dependent&&selection.replay?.actorReplacement)&&!req.semanticOnly&& req.cacheKey&& session.cache.slice().reverse().find(function(old){return !old.semanticOnly&&!frReplayArtifactExcluded(req,old)&&old.cacheKey===req.cacheKey&& old.status==='returned'&& old.response&& old.response.choices&& typeof old.response.choices[0]?.message?.content==='string';});
  if(cached){req.reused=true;req.sourceRequestId=cached.id;try{session.reusedCount=Number(session.reusedCount||0)+1;}catch(_){}return {reused:true,response:structuredClone(cached.response)};}
  var projected=!selected&&!dependent&& (frReplayCanonMergedResponse(req,session)||frReplayProjectedResponse(req,session));
  if(projected){req.reused=true;req.sourceRequestId=projected.source.id;req.projected=true;try{session.reusedCount=Number(session.reusedCount||0)+1;}catch(_){}return {reused:true,response:projected.response};}
  // 资料检索（vectorContext）是所有阶段的共同前置输入，优先级排 -1。
  // 它没被复用上时不能直接中止——前置输入缺了就该去补，不是停下来。
  // 玩家 2026-10-30 定（A 方案）：旧资料因检索配置变化失效时，按当前配置重新查一次。
  var prerequisiteInput=req.stageKey==='vectorContext';
  /* ★★ 2026-11-01 玩家：「依赖材料已变化或没有可复用返回」又出现了，还要修完。
   *
   * 原来的逻辑：
   *   if(!selected && !dependent && !prerequisiteInput) → 直接抛错中止整轮
   *
   * 病根：把两件性质完全不同的事混成了一条错误——
   *   ① 「这个阶段玩家没选中重跑」      → 完全正常，应该照旧复用上次结果。
   *   ② 「这个阶段材料真的变了、必须重算」→ 才该提示，而且也不该整轮中止。
   * 于是玩家点「继续本轮补演」时，只要缓存 key 有一个字对不上（cacheKey 是整份
   * messages 的哈希，措辞微调、时间戳、名单顺序变化都会变），就整轮停死，
   * 面板只甩一句「依赖材料已变化」，玩家完全无从下手——这就是反复「修了又出」的原因。
   *
   * 玩家 2026-11-01 定（放宽复用）：没选中的阶段按「阶段名 + 人物」匹配复用。
   *   · 同一阶段、同一批人物、上次成功返回过 → 直接用上次结果，不重问模型。
   *   · 匹配不到才真的去重算，而不是中止。
   *   · 选中的阶段照常重跑，绝不拿缓存糊弄（没有偷扩大重跑范围）。
   */
  if(!selected&&!dependent&&!prerequisiteInput){
    var loose=sameStageReusable(req,session);
    var world=req.stageKey==='世界事件补演';
    if(loose&&(!world||frReplaySameWorldProgress(loose,prompt,session))){
      req.reused=true;req.sourceRequestId=loose.id;req.projected=true;
      try{session.reusedCount=Number(session.reusedCount||0)+1;}catch(_){}
      /* ★★★ 2026-11-03：复用时按**字段**剔除带全局语义的部分（如 eventProgress），
       * 不再按阶段整段禁运。阶段一视同仁，没有例外名单。
       * 见 frReplayStripGlobalFields 的说明。 */
      // 整轮原始边界是只读事实快照，不是增量记账。旧异常轮尚无独立冻结键时，
      // core确认完整原始接续输入后可原样校验；删eventProgress反而制造一次新边界请求。
      // 人物子集/未确认原输入仍沿原剥离规则，不能借此继承全局推进。
      var proof=session.continuationInputVerified,wholeBoundary=req.stageKey==='正文硬事实提取'&&proof
        &&proof.archiveName===session.context?.archiveName&&proof.logId===session.context?.logId&&session.selection?.replay?.preserveInput===true&&frReplaySemanticOwned(loose,session);
      var looseResponse=wholeBoundary||world?structuredClone(loose.response):frReplayStripGlobalFields(loose.response,req.stageKey);
      if(typeof frCanonTraceEvent==='function'&&req._run){
        try{frCanonTraceEvent(req._run,'reuse-loose','按阶段+人物复用上次结果：'+req.stageKey+' / '+(req.subject||req.targetId||''),{stage:req.stageKey,subject:req.subject||req.targetId||'',sourceRequestId:loose.id});}catch(_){}
      }
      return {reused:true,response:looseResponse};
    }
  }
  if(!selected&&!dependent&&!prerequisiteInput){
    if(selection.replay?.actorReplacement){
      throw new Error('定点替换缺少可复用的「'+String(req.stageKey||'前置步骤')+'」记录，本次未扩大范围，原结果保留。');
    }
    // 玩家 2026-10-30：这条报错反复出现（「依赖材料已变化」），但玩家根本看不出
    // 到底是哪一步变了。以前只有一句结论，排查全靠猜——这正是「修了四次没进展」的原因。
    // 现在把真实原因摊开：缓存里有多少条、同阶段的有没有、cacheKey 差在哪。
    var sameStage=session.cache.filter(function(old){return old.stageKey===req.stageKey;});
    var diag={
      stage:req.stageKey,
      subject:req.subject||req.targetId||'',
      cacheTotal:session.cache.length,
      cacheSameStage:sameStage.length,
      hasCacheKey:!!req.cacheKey,
      sameStageKeys:sameStage.slice(0,5).map(function(old){return String(old.cacheKey||'').slice(0,80);}),
      thisKey:String(req.cacheKey||'').slice(0,80),
      selected:!!selected,
      dependent:!!dependent
    };
    console.warn('[补演重跑] 无法复用，改为重算：'+JSON.stringify({stage:diag.stage,subject:diag.subject,cacheTotal:diag.cacheTotal,cacheSameStage:diag.cacheSameStage,hasCacheKey:diag.hasCacheKey,selected:diag.selected,dependent:diag.dependent}));
    /* ★★★ 2026-11-03 玩家机器日志里这条只剩 `[object Object]`，等于没有信息。
     * console 在玩家客户端看不到（独立端没有控制台），所以必须把**可读结论**
     * 走 trace 事件送进界面。下面这个 why 就是给玩家看的「为什么重算」。 */
    var why;
    if(!req.cacheKey)why='这次请求没有缓存指纹（cacheKey 为空），只能重算';
    else if(!diag.cacheTotal)why='本轮没有任何缓存结果可用（缓存为空）';
    else if(!diag.cacheSameStage)why='缓存里没有「'+String(req.stageKey||'')+'」这一阶段的结果';
    else why='有「'+String(req.stageKey||'')+'」的结果，但指纹对不上（说明输入材料变了）';
    if(typeof frCanonTraceEvent==='function'&&req._run){
      try{frCanonTraceEvent(req._run,'reuse-miss-recalc','无法复用，改为重算：阶段='+diag.stage+'｜'+why,diag);}catch(_){}
    }
    /* ★★ 2026-11-01 玩家定：这里**不再中止**。
     *
     * 原来这里 throw 一条 ReplayDependencyError 并 abort 整个 session，
     * 面板只剩一句「依赖材料已变化或无可用返回」——玩家既看不懂，也没法继续。
     * 这是同一句报错反复出现四次的根源：它把「材料变了，需要重算」当成了致命错误。
     *
     * 现在：材料对不上就是该重算，让它自然往下走到下面 return {reused:false, prompt}。
     * 「未扩大到其他人物或阶段」这条安全约束仍然成立 —— 因为是否重算由 selected 决定，
     * 只有玩家选中的阶段才会走真正的重算分支，没选中的已经在上面的 sameStageReusable 里复用掉了。
     */
    session.recalcFallback=(session.recalcFallback||0)+1;
    if(typeof frCanonTraceEvent==='function'&&req._run){
      try{frCanonTraceEvent(req._run,'dependency','材料已变化，按当前状态重算本阶段',{stage:req.stageKey,subject:req.subject||req.targetId||''});}catch(_){}
    }
  }
  if(!selected&&prerequisiteInput&& typeof frCanonTraceEvent==='function')frCanonTraceEvent(req._run,'dependency','前置资料无可用返回，按当前配置重新检索',{stage:req.stageKey});
  req.reused=false;req.dependencyRecalculated=!selected;
  /* 真实重算计数：每一条确定要发模型请求的，都记一笔到本次会话上。
   * 供 frReplayExecute 收尾时判断「这次到底有没有真的重算」，
   * 避免把「一个请求都没发」的成功返回当成跑完了糊弄玩家。 */
  try{ session.realCalls=Number(session.realCalls||0)+1; }catch(_){}
  if(!selected&& typeof frCanonTraceEvent==='function')frCanonTraceEvent(req._run,'dependency','仅重算受影响的后续阶段',{stage:req.stageKey,subject:req.subject||'',targetId:req.targetId||''});
  var next=prompt;
  if(selected&& selection.extra){next=Array.isArray(prompt)?prompt.slice():[{role:'user',content:String(prompt)}];next.push({role:'user',content:'【本次局部重跑附加要求，仅针对当前目标】\n'+selection.extra});}
  return {reused:false,prompt:next};
}
function frReplayLatestLog(archive){return (archive?.data?.logs||[]).slice().reverse().find(function(l){return l.type==='ai'&&!l.isGhost&&!l.isDeepSummary&&!l.isSnapshot&&!String(l.content||'').includes('<h4>天道初启</h4>');});}
/* 2026-11-02 玩家：「界面一卡一卡的」
 *
 * frReplayStamp 每次都要：
 *   1. structuredClone(整个存档)      ← 存档含全部正文日志，可能几十上百 MB
 *   2. 深度排序包装 ordered()          ← 递归重建全部对象
 *   3. JSON.stringify 全量             ← 再生成一个巨型字符串
 *   4. SHA-256 整个字符串
 * 全是同步动作，跑一次就能把主线程按住几百毫秒到数秒。
 * 而局部重跑流程里它被调用多次（边界拍、成功收尾、失败回滚各一次），
 * 玩家感受就是「一卡一卡的」，期间点任何按钮都没反应。
 *
 * 这里做两件事，都不改判定语义：
 *   · 同一份存档内容只算一次，结果缓存 —— 重复调用直接返回。
 *   · 把计算拆成让出主线程的分片，避免长时间独占。
 * 指纹值本身不变，边界校验逻辑完全照旧。
 */
/* ★ 2026-11-02 修正上一版自己的错误：缓存按对象引用比对，**从来没命中过**。
 *
 * 上一版写的是 `hitMem.memory===memory`，想用「同一份存档 + 同一份内存」判重。
 * 但 frTakeCanonMemory() 内部全是 JSON.parse(JSON.stringify(...))，
 * **每调一次必定生成全新对象**，引用永远不等 —— 缓存形同虚设，
 * 该算几次还是算几次，卡顿一点没解决。
 *
 * 现在改成内容判重：拿不到便宜的判据就不硬判，改用**本轮计数**做键。
 * 同一轮重跑里，只要还没发生过写回（epoch 不变），且 archive 是同一个对象引用，
 * 就直接复用上一次的指纹 —— 这覆盖了 frReplayValidate(561/481/579) 那段
 * 「同一份存档连续核对多次」的真实场景。
 * 写回存档后 epoch+1，缓存自动失效，绝不会把旧指纹当成新状态。
 */
var frReplayStampCache=new WeakMap();
var frReplayStampEpoch=0;
function frReplayStampBump(){frReplayStampEpoch++;}
async function frReplayStamp(archive,memory){
  if(!globalThis.crypto?.subtle)throw new Error('当前运行环境不能计算重跑边界指纹');
  // 同一对象 + 同一 epoch（期间没有任何写回）→ 结果必然相同。
  try{
    var hitMem=frReplayStampCache.get(archive);
    if(hitMem&&hitMem.epoch===frReplayStampEpoch&&typeof hitMem.value==='string')return hitMem.value;
  }catch(_){}
  // 先让出一帧，保证卡顿前 UI 已经刷新过一次（玩家能看到「正在核对」）。
  await new Promise(function(r){setTimeout(r,0);});
  // Project only excluded display fields. Do not clone and recursively rebuild the
  // entire history merely to sort its keys; stringify visits one shallow object at a time.
  var copy=Object.assign({},archive);
  if(archive?.data){
    copy.data=Object.assign({},archive.data);
    if(archive.data.state){
      copy.data.state=Object.assign({},archive.data.state);
      delete copy.data.state.npcAvatars;
      if(JSON.stringify(copy.data.state.rpgMaps)==='{}')delete copy.data.state.rpgMaps;
    }
    if(Array.isArray(archive.data.logs))copy.data.logs=archive.data.logs.map(function(log){
      var projected=Object.assign({},log);delete projected.detailedEvolutionHtml;delete projected.canonPending;return projected;
    });
  }
  var raw=JSON.stringify([copy,memory.state,memory.map,memory.bonded],function(key,value){
    // Use the original value to preserve the former ordered() treatment of Dates,
    // Maps and other structured-clone values (rather than invoking their toJSON).
    var original=this[key];
    if(original&&typeof original==='object'&&!Array.isArray(original)){
      var sorted={};Object.keys(original).sort().forEach(function(k){sorted[k]=original[k];});return sorted;
    }
    return original;
  });
  var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  var result=Array.from(new Uint8Array(digest)).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
  var epochAtStart=frReplayStampEpoch;
  try{frReplayStampCache.set(archive,{epoch:epochAtStart,value:result});}catch(_){}
  return result;
}
async function frReplayBefore(system,run,args){
  /* 按系统判断，不能看汇总的 frReplaySession。
   * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
   * 原来这里 if(frReplaySession)return —— 只要**任一系统**有会话就跳过封存边界，
   * 于是另一边跑着的时候，这边的边界永远不更新，重跑就会用旧边界。
   * 现在只看自己这个系统有没有会话。 */
  var beforeSystem=(system==='ce')?'ce':'canon';
  if(frReplaySessionOf(beforeSystem))return;
  var archiveName=currentArchiveName,key=archiveName+':'+system;
  // 执行基线是重跑所需数据，不受展示诊断开关控制。
  if(!run){delete frReplayPending[key];return;}
  try{
    var archive=await db.archives.get(archiveName);
    if(!archive)throw new Error('存档不存在');
    frReplayPending[key]={system:system,archiveName:archiveName,sourceRunId:run.id,buildId:typeof FR_BUILD_ID==='string'?FR_BUILD_ID:'',args:structuredClone(args),beforeArchive:archive,beforeMemory:frTakeCanonMemory()};
    var context=frReplayPending[key],latest=frReplayLatestLog(archive);
    /* ★★★ 2026-11-03 玩家报：「重启游戏依然会清空所有局部重跑资料」，实测真机库后确诊。
     *
     * 【原来错在哪】这里原本还有一句
     *     if(latest){ context.logId=...; context.afterStamp=await frReplayStamp(...);
     *                 await dbSet('FR_REPLAY_BASE_V1:'+key,context); }   ← 立刻写库
     *
     * 它把**回合开始前**的 context 直接写进了数据库，可那份东西根本不是可用的边界：
     *   · afterMemory / afterArchive / sealedAt 全都还没有
     *   · afterStamp 记的是**回合前**的存档指纹
     * 真正可用的那份要等 frReplaySealPending 在回合结束时覆盖。
     *
     * 实测证据（真机库副本，只读）：
     *     FR_REPLAY_BASE_V1:我的修仙路:canon
     *        afterStamp=true  afterMemory=false  afterArchive=false  sealedAt=未封存
     * 也就是说只要 seal 那一步没走成，库里就永久留着一份「半成品」。
     * 重启后 frReplayValidate 读到它，拿当前存档指纹去比回合前的 afterStamp，
     * 必然不等 → 抛 reason.stage='characters' → 玩家看到「从核对人物开始重跑」，
     * 同时面板因为 context 不可用而显示 0/0、资料全空。
     *
     * 【修法】回合开始阶段**只放内存，不写库**。
     * 数据库里只允许存在「已封存、字段齐全」的边界；要么完整可用，要么干脆没有。
     * 这样重启后读到的要么是可用的边界，要么是干净的「没有」，绝不会是骗人的半成品。 */
    if(latest){
      context.logId=run.logId || latest.id;
      context.afterStamp=await frReplayStamp(archive,context.beforeMemory);
      // 独立开跑检查点不冒充已封存边界；只供主动整轮补跑恢复。
      await dbSet('FR_REPLAY_START_V1:'+key,context);
    }
  }catch(error){frCanonTraceEvent(run,'error','本轮局部重跑边界未记录',{reason:String(error.message||error)});}
}
async function frReplaySealPending(onlySystem){
  var name=currentArchiveName;
  if(Object.keys(frReplayPending).some(function(key){return key.startsWith(name+':');})&& typeof debouncedSave!=='undefined'&& typeof debouncedSave.flush==='function')await debouncedSave.flush();
  for(var system of (onlySystem?[onlySystem]:['ce','canon'])){
    var key=name+':'+system,context=frReplayPending[key];if(!context)continue;
    try{
      var run=frCanonTraceHistory.find(function(r){return r.id===context.sourceRunId;});
      // 补演比变量演化先收尾时，不能把仍在飞的变量演化封为失败基线，反之亦然。
      if(!run||run.status==='running'||run.endedAt==null)continue;
      var archive=await db.archives.get(name),floorId=run.logId||context.logId;
      var log=(archive?.data?.logs||[]).find(function(row){return row.type==='ai'&&!row.isGhost&&!row.isSnapshot&&!row.isDeepSummary&&String(row.id)===String(floorId);});
      if(!log||name!==currentArchiveName||frReplayPending[key]!==context)continue;
      // archives.get already owns an isolated IndexedDB snapshot. Transfer it to the boundary;
      // cloning the full history/images again doubles this snapshot at the sealing peak.
      context.logId=log.id;context.afterMemory=frTakeCanonMemory();context.afterArchive=archive;context.afterStamp=await frReplayStamp(archive,context.afterMemory);
      context.sealedAt=Date.now();
      if(system==='ce'&&run.ceWriteJournal)context.ceWriteJournal=structuredClone(run.ceWriteJournal);
      var mergedRun=system==='ce'&&frCanonTraceHistory.find(function(r){return r.id===context.sourceRunId;});
      var executionResult=mergedRun&&frReplayResultOf(mergedRun);
      if(executionResult&&executionResult.mergedReplayReceipt){
        context.mergedReplayReceipt=structuredClone(executionResult.mergedReplayReceipt);
        context.pendingFailures=frReplayUpdatePendingFailures(context,{stages:[],scopes:[]},context.mergedReplayReceipt);
      }
      await dbSet('FR_REPLAY_BASE_V1:'+key,context);
      if(frReplayPending[key]===context)delete frReplayPending[key];
      run.logId=log.id;await frCanonTracePersist(run);
      /* ★★★ 2026-11-03 玩家拍板：「补演流程过程中生成的数据在本轮中都应该作为持久性数据资料存在。
       *   我的需求就是哪里错了可以针对性重跑哪里。」「只在本轮存，重roll，推进，回退后都清理。」
       *
       * 关键在于**落库**：运行记录（frCanonTraceHistory）是给思考展示区看的，纯内存，
       * 重启/切存档就没了。局部重跑面板此前正是从它取目标列表，
       * 于是「展示区空」= 「面板 0/0」= 「重启后不能重跑」。
       * 这里在封存边界的同时，把本轮各阶段的产物（阶段键/目标/状态/结果/原始提示词）
       * 落进 FR_CANON_TURN_ARTIFACTS_V1:<存档>:<楼层>，让重跑有真正的数据底座。
       * 采集失败不能拖累边界封存，所以单独 try。 */
      try{
        if(run&&Array.isArray(run.requests)&&(run.requests.length||run.executionResult||run.executionViews?.length)&&typeof frCanonTurnArtifactsSave==='function'){
          await frCanonTurnArtifactsSave(name,log.id,run.requests,system,run);
        }
      }catch(artifactError){
        console.warn('[阶段产物] 落库失败（不影响本轮边界）：',artifactError);
      }
    }catch(error){
      /* ★★★ 2026-11-03：原来这里只有 console.warn，玩家永远看不到封存失败。
       * 而封存失败的直接后果就是「重启后局部重跑全空 + 从核对人物开始」。
       * 现在同时：① 留一条 trace 事件（面板可见）② 打红字日志。 */
      var msg='[局部重跑] 边界封存失败（重启后将无法局部重跑）：'+String(error&&error.message||error);
      console.warn(msg,error);
      try{
        var failRun=frCanonTraceHistory.find(function(r){return r.id===context.sourceRunId;});
        if(failRun&&typeof frCanonTraceEvent==='function')frCanonTraceEvent(failRun,'error','本轮重跑边界未封存',{reason:String(error&&error.message||error)});
      }catch(_){}
    }
  }
}
// 只在局部执行实际验收提交后更新当前楼产物。未选成果继承，失效目标禁止复活。
async function frReplayCommitArtifacts(context,selection,runs,result){
  if(typeof frCanonTurnArtifactsLoad!=='function'||typeof frCanonTurnArtifactsSave!=='function')return;
  var system=context.system==='ce'?'ce':'canon',old=await frCanonTurnArtifactsLoad(context.archiveName,context.logId,system);
  var actual=(runs||[]).filter(function(run){return run.archiveName===context.archiveName&&String(run.logId||'')===String(context.logId)&&run.phase===(system==='ce'?'变量演化':'正文后补演');});
  if(!actual.length)return;
  function affected(req){
    return (selection.stages||[]).includes(req.stageKey)||frReplayRequestTargets(req).concat(frReplayRequestNames(req)).some(function(id){return frReplayTargetSelected(selection,req.stageKey,id);})||frReplayDependency(req,selection);
  }
  var returned=actual.flatMap(function(run){return run.requests||[];}).filter(function(req){return req.status==='returned';});
  function superseded(stage,id,name){
    if(system==='canon'&&frReplayBoundarySelected(selection))return affected({stageKey:stage,targetId:id,targetIds:id?[id]:[],subject:name});
    var cleared=result?.replayCleared;
    if((cleared?.stages||[]).includes(stage)||(cleared?.scopes||[]).some(function(scope){return scope===stage+':'+id||name&&scope===stage+':'+name;}))return true;
    return returned.some(function(req){
      if(req.stageKey!==stage)return false;
      var owners=frReplayRequestTargets(req).concat(frReplayRequestNames(req));
      return id||name?owners.includes(id)||owners.includes(name):!owners.length;
    });
  }
  var inherited=(old?.requests||[]).map(function(req){
    var copy=structuredClone(req),stages=req.mergedPhases||(req.stageKey==='canon-merged'?['characters','items']:req.stageKey==='merged'?['entry','items','characters','misc']:[req.stageKey]);
    var targets=frReplayRequestTargets(req),names=frReplayRequestNames(req),exclude=new Set(req.replayExcludedScopes||[]);
    stages.forEach(function(stage){
      (targets.length?targets:['']).forEach(function(id,index){var name=names[index]||id;
        // A predicted dependency is not evidence of a new committed owner/stage result.
        if(superseded(stage,id,name))exclude.add(stage+':'+id);
      });
    });
    copy.replayExcludedScopes=Array.from(exclude);return copy;
  });
  function identity(req){return JSON.stringify([req.stageKey,frReplayRequestTargets(req).slice().sort(),req.mergedPhases||null]);}
  var requests=new Map();inherited.forEach(function(req){requests.set(identity(req),req);});
  actual.forEach(function(run){(run.requests||[]).forEach(function(req){requests.set(identity(req),req);});});
  var previous=old?.executionResult||{},combined=Object.assign({},previous);
  if(system==='canon'&&!selection.replay?.actorReplacement&&(selection.replay?.changed?.length||frReplayBoundarySelected(selection))){
    ['ledgerPlan','biography','canonReferences','worldForMisc','worldNoChanges','actorProgressSaved'].forEach(function(key){delete combined[key];});
  }
  actual.forEach(function(run){Object.assign(combined,frReplayResultOf(run));});Object.assign(combined,result||{});
  var prose=new Map();(selection.replay?.prebuiltRepair?[]:previous.prose||[]).forEach(function(block){if(!['人物视角散文','群像视角散文'].some(function(stage){return affected({stageKey:stage,subject:block.name});}))prose.set(block.name,block);});
  actual.forEach(function(run){(frReplayResultOf(run).prose||[]).forEach(function(block){prose.set(block.name,block);});});
  (result?.prose||[]).forEach(function(block){prose.set(block.name,block);});if(previous.prose||combined.prose)combined.prose=Array.from(prose.values());
  if(system==='ce'&&(combined.mergedReplayReceipt||context.mergedReplayReceipt)){
    combined.mergedReplayReceipt=Object.assign({},combined.mergedReplayReceipt||context.mergedReplayReceipt,{failedStages:context.pendingFailures?.stages||[],failedScopes:context.pendingFailures?.scopes||[]});
    context.mergedReplayReceipt=structuredClone(combined.mergedReplayReceipt);
  }
  var views=new Map();(old?.executionViews||[]).forEach(function(view){
    var data=view.data||{},stage=data.kind==='prose'?'人物视角散文':data.kind==='characters'?'characters':'';
    if(selection.replay?.prebuiltRepair&&['prose','eventProgress','world','characters','ledger'].includes(data.kind))return;
    if(stage&&affected({stageKey:stage,subject:data.name||data.block?.name||'',targetId:data.actorId||data.id||''}))return;
    if(data.kind==='prose'&&(combined.prose||[]).some(function(block){return block.name===data.block?.name;}))return;
    views.set(view.key,view);
  });
  actual.forEach(function(run){(run.executionViews||[]).forEach(function(view){views.set(view.key,view);});});
  var saved=await frCanonTurnArtifactsSave(context.archiveName,context.logId,Array.from(requests.values()),system,{executionResult:combined,executionViews:Array.from(views.values())});
  if(!saved)throw new Error('局部重跑结果已产生，但本轮可复用产物保存失败；未报告完整成功');
  // 后续界面仍用最后一次执行对象，但必要结果与持久化必须是同一份已合并成果。
  var latest=actual.at(-1);latest.executionResult=saved.executionResult;latest.executionViews=saved.executionViews;latest.replayUnavailable=saved.replayUnavailable;
}
function frReplayRunBlock(system){
  var title=system==='ce'?'变量演化':'原著补演';
  if(frReplayBusyOf(system))return title+'的上一次重跑还在收尾。';
  var active=typeof frCanonTraceActive==='object'?frCanonTraceActive:null;
  if(active?.archiveName===currentArchiveName&&active.status==='running'&&(active.phase==='变量演化'?'ce':'canon')===system)
    return active._controller?.signal.aborted?title+'已收到停止指令，正在保存可复用结果。':title+'本轮仍在运行。';
  if(typeof concurrentEvolutionRunning!=='undefined'&&concurrentEvolutionRunning)
    return system==='ce'?'变量演化本轮仍在运行。':'变量演化仍在更新存档；完成后可安全重跑原著补演。';
  if(typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating)
    return '当前回合仍占用存档写入；结束后会自动检查重跑是否可用。';
  return '';
}
async function frReplayValidate(context,options){
  if(!context||context.archiveName!==currentArchiveName)throw new Error('没有当前存档的本轮重跑边界。请先完成启用完整记录的一轮。');
  if(context.unsealed)throw new Error('本轮结果正在保存，已返回的阶段可查看；保存完成后可执行局部重跑。');
  // 版本标记变化不能封死重试；实际前置兼容性由完整请求材料逐项核对。
  /* ★★★ 2026-11-02 玩家：「原著补演和变量演化的局部重跑是不是共享重跑逻辑和状态，
   * 这两个明明是两条线路，但是只要我重跑其中一个，另一个就显示锁死说其他的在重跑。」
   *
   * 原来的判断把两个系统共用一个 frReplayBusy，等于让两条独立线路互相封死。
   * 现在按 context.system 分开判定：只拒绝**同一个系统**已有重跑在跑。
   *
   * 宿主侧的 isMainApiGenerating / concurrentEvolutionRunning 仍然保留，
   * 因为那是原卡主流程（生成正文、变量演化总体）在跑，任何重跑都该让路。
   * 但 frCanonTraceActive 要看它属于哪个系统：
   *   · 变量演化正在跑，不该拦住原著补演的重跑；
   *   · 反之亦然。
   */
  var blocked=frReplayRunBlock(context?.system==='ce'?'ce':'canon');
  if(blocked)throw Object.assign(new Error(blocked),{code:'FR_REPLAY_RUNNING'});
  var archive=await db.archives.get(currentArchiveName),latest=frReplayLatestLog(archive);
  /* ★★ 2026-11-01 玩家截图：重试按钮被永久锁死，提示
   *     「未完成：这条记录属于其他楼层，请使用当前最新回合的重试入口。」
   *
   * 原来的判断：
   *     if(!latest || latest.id !== context.logId) throw '属于其他楼层…'
   *
   * 病根：它把「这个边界是否仍然可用」偷换成了「这个楼层是不是**最新**的」。
   *   · context.logId 是封存那一刻的楼层 id；
   *   · 只要玩家之后又走了一轮（哪怕那一轮跟这次重试毫无关系），
   *     latest.id 就变了，于是旧边界**永久失效**，按钮再也点不动；
   *   · 而这恰恰是玩家最需要重试的时候——刚失败、想改完设置再来一次。
   *
   * 两者根本不是一回事：
   *   「楼层是不是最新」  ≠  「这条重跑边界还能不能用」
   *
   * 真正该守的是：**那次封存的楼层还在存档里**（没被删除/回退掉），
   * 这样它对应的材料、快照、账本都还在，重跑才有依据。
   * 至于之后又多了几层，跟这一层的重跑能不能做没有关系。
   *
   * 所以改成：按 id 在楼层列表里找到那一层
   *   找到了 → 放行（哪怕它不是最新楼层）
   *   找不到 → 才是真的「这条记录已经不存在了」，给出能照着做的提示
   *
   * 安全前提（没有放开任何危险的东西）：
   *   · 后面 frReplayStamp 整档指纹校验照旧；
   *   · fresReplayMaterialsReady 逐项材料核对照旧；
   *   · 真正的执行仍用 context.logId 去取材料（不串层）。
   */
  /* 判「那一层还在不在」，必须跟 frReplayLatestLog 用**同一套过滤条件**——
   * 否则一个 ghost/快照/深度摘要的 id 也会被当成有效楼层放行。
   * 这里把那套条件抽出来复用，避免两处口径以后又漂移。 */
  var replayLogs=(archive?.data?.logs||[]).filter(function(l){return l.type==='ai'&&!l.isGhost&&!l.isDeepSummary&&!l.isSnapshot&&!String(l.content||'').includes('<h4>天道初启</h4>');});
  var floorIds=replayLogs.map(function(log){return String(log.id);});
  var sameFloor=!!context.logId&&floorIds.indexOf(String(context.logId))>=0;
  if(!latest){
    throw new Error('当前存档还没有任何回合记录，无法局部重跑。请先完成一轮启用完整记录的回合。');
  }
  if(!sameFloor){
    throw new Error('这条重跑记录对应的楼层（'+(context.logId||'未知')+'）已不在当前存档里（可能被删除或回退过）。请用当前最新回合的重跑入口，或点「整轮重跑」。');
  }
  /* ★★★ 2026-11-03 半成品边界自愈（真机库实测确诊后新增）。
   *
   * 现象：玩家重启游戏后局部重跑面板变 0/0、资料全空，点了就从「核对人物」重跑。
   * 真机库副本只读实测发现，坏就坏在库里这类记录：
   *     FR_REPLAY_BASE_V1:我的修仙路:canon
   *        afterStamp=true  afterMemory=false  afterArchive=false  sealedAt=未封存
   *
   * 这种记录是 frReplayBefore 在**回合开始前**写进去的半成品（已修：现在只放内存）。
   * 它看着像存在，实际不可用：afterStamp 记的是回合前的指纹，
   * 拿它跟当前存档比必然不等，于是走下面第 980 行抛 stage='characters'，
   * 玩家就被迫从人物阶段整轮重来。
   *
   * 【修法】识别「没封存的半成品」，改用当前存档**现场重建**一份可用边界：
   * 既然这一层还在（sameFloor 已通过）、存档就是当前这一轮的结果，
   * 那么「现在的存档 + 现在的内存」正是本轮结束后的状态，可以直接当作 after 侧。
   * 重建后写回库，下次重启读到的就是封存过的完整边界。
   * 这不是放宽校验：楼层归属与材料核对（replayLogs / frReplayMaterialsReady）照旧生效，
   * 只是不再拿一份明显残缺的记录去跟当前状态做无意义的比对。 */
  var halfSealed=!context.sealedAt||!context.afterMemory||!context.afterArchive;
  if(halfSealed){
    try{
      var rebuiltMemory=frTakeCanonMemory();
      context.afterArchive=structuredClone(archive);
      context.afterMemory=structuredClone(rebuiltMemory);
      context.afterStamp=await frReplayStamp(archive,rebuiltMemory);
      if(!context.beforeArchive)context.beforeArchive=structuredClone(archive);
      if(!context.beforeMemory)context.beforeMemory=structuredClone(rebuiltMemory);
      context.sealedAt=Date.now();
      context.rebuiltAt=Date.now();
      await dbSet('FR_REPLAY_BASE_V1:'+String(currentArchiveName)+':'+String(context.system||'canon'),context);
      console.info('[局部重跑] 检测到未封存的旧边界，已用当前存档重建并封存，本次按新边界重跑');
      return archive;
    }catch(rebuildError){
      console.warn('[局部重跑] 旧边界重建失败，回落到常规校验：',rebuildError);
    }
  }
  if(await frReplayStamp(archive,frTakeCanonMemory())!==context.afterStamp){
    if(options?.allowRebase&& context.afterArchive&& context.afterMemory)return archive;
    if(options?.allowRebase && context.beforeArchive && context.beforeMemory && latest.stateSnapshot){
      var memory=frTakeCanonMemory(),snapshot;
      try{snapshot=JSON.parse(latest.stateSnapshot);}catch(_){}
      if(snapshot && JSON.stringify(snapshot)===JSON.stringify(memory.state) && JSON.stringify(archive.data?.state?.currentState)===JSON.stringify(memory.state)){
        // 旧记录只存指纹时，最新正文快照与库、内存三方一致才接续；不把其他楼层当旧终态。
        context.afterArchive=structuredClone(archive);context.afterMemory=structuredClone(memory);return archive;
      }
    }
    // 整档指纹不一致不等于不能重跑：只要本次要用到的材料齐备且逐项对得上，就放行。
    // 这是方案 B 的核心——把"整档一致才允许"换成"本次材料可用就允许"。
    if(options?.allowRebase && await frReplayMaterialsReady(context))return archive;
    var reason=new Error('本轮结算前置已有变化，可从人物变量阶段重新核对后继续；不会用旧整档覆盖当前游戏。');reason.code='FR_REPLAY_PREREQUISITE';reason.stage='characters';throw reason;
  }
  return archive;
}
// 三方撤销只退掉本次执行确实改变、且仍保持其原结果的部分；外来修改保留。
function frReplayRewindValue(before,after,current){
  var serialize=value=>JSON.stringify(value,(_,row)=>row instanceof Map?{__map:Array.from(row)}:row instanceof Set?{__set:Array.from(row)}:row);
  var equal=(a,b)=>serialize(a)===serialize(b);
  if(equal(before,after))return structuredClone(current);
  if(equal(current,after))return structuredClone(before);
  if(typeof before==='number'&& typeof after==='number'&& typeof current==='number')return current-(after-before);
  if(before instanceof Map && after instanceof Map && current instanceof Map){var result=new Map(current);new Set([...before.keys(),...after.keys()]).forEach(function(key){var value=frReplayRewindValue(before.get(key),after.get(key),current.get(key));if(value===undefined)result.delete(key);else result.set(key,value);});return result;}
  if(Array.isArray(before)&&Array.isArray(after)&&Array.isArray(current)){
    var keyOf=row=>row && typeof row==='object'?(row.id??row.uid??row.key??row.name):null;
    if([...before,...after,...current].every(row=>keyOf(row)!==null)){
      var b=new Map(before.map(row=>[keyOf(row),row])),a=new Map(after.map(row=>[keyOf(row),row])),c=new Map(current.map(row=>[keyOf(row),row]));
      if(b.size===before.length && a.size===after.length && c.size===current.length){
        var keys=Array.from(new Set([...current.map(keyOf),...before.map(keyOf)]));
        return keys.map(key=>frReplayRewindValue(b.get(key),a.get(key),c.get(key))).filter(row=>row!==undefined);
      }
    }
  }
  if(before && after && current && typeof before==='object' && typeof after==='object' && typeof current==='object' && !Array.isArray(before) && !Array.isArray(after) && !Array.isArray(current)){
    var out=structuredClone(current);new Set([...Object.keys(before),...Object.keys(after)]).forEach(function(key){var value=frReplayRewindValue(before[key],after[key],current[key]);if(value===undefined)delete out[key];else out[key]=value;});return out;
  }
  return structuredClone(current);
}
// CE journals only its writes, by stage, in chronological order. Canon owns a different receipt.
function frReplayCeChanges(stage,before,after){
  const changes=[];
  const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Map);
  const walk=(a,b,path,identities)=>{
    if(JSON.stringify(a)===JSON.stringify(b))return;
    if(plain(a)&&plain(b)){
      for(const key of new Set([...Object.keys(a),...Object.keys(b)])){
        if(['__proto__','prototype','constructor'].includes(key))continue;
        let names=identities;
        if(path.length===2&&path[0]==='state'&&['0','7'].includes(path[1])){
          names=[key,a[key]?.['1'],b[key]?.['1']].filter(Boolean).map(value=>String(value).split('|')[0].trim());
        }else if(path.length===2&&path[0]==='state'&&path[1]==='1'){
          names=['B1'];
        }else if(path.length===1&&['entries','bonded','items','avatars'].includes(path[0])){
          names=[key,String(key).split('_')[0],a[key]?.name,b[key]?.name,a[key]?.title,b[key]?.title].filter(Boolean).map(String);
        }
        walk(a[key],b[key],path.concat(key),names);
      }
    }else changes.push({stage,path,identities,before:structuredClone(a),after:structuredClone(b)});
  };
  for(const key of ['state','entries','bonded','items','avatars','map'])walk(before[key],after[key],[key],[]);
  return changes;
}
function frReplayCeSelectionContains(change,selection){
  const scopes=(selection.scopes||[]).map(frReplaySplitScope).filter(row=>row.valid&&row.stage===change.stage);
  return scopes.length?scopes.some(row=>change.identities.includes(row.name)):(selection.stages||[]).includes(change.stage);
}
function frReplayCeApplyJournal(snapshot,journal,selection,reverse){
  const output=structuredClone(snapshot);
  const changes=reverse?journal.slice().reverse():journal;
  for(const change of changes){
    if(!frReplayCeSelectionContains(change,selection))continue;
    const {path,before,after}=change, key=path.at(-1);
    let object=output;
    for(const part of path.slice(0,-1)){
      if(!object||typeof object!=='object'||!Object.hasOwn(object,part)){object=null;break;}
      object=object[part];
    }
    if(!object||typeof object!=='object'||JSON.stringify(object[key])!==JSON.stringify(reverse?after:before)){
      throw new Error('重跑目标的'+(change.identities[0]||change.stage)+'已变化，无法安全撤换旧结果；现有成果保留。');
    }
    const value=reverse?before:after;
    if(value===undefined)delete object[key];else object[key]=structuredClone(value);
  }
  return output;
}
function frReplayCeSnapshot(archive,memory){
  const state=archive?.data?.state||{};
  const index=rows=>Object.fromEntries((Array.isArray(rows)?rows:[]).map((row,i)=>[String(row?.id||row?.key||'@'+i),row]));
  const indexedState={...memory.state};
  for(const key of ['4','5'])if(Array.isArray(indexedState[key]))indexedState[key]={__frReplayRows:true,...index(indexedState[key])};
  const entries=Object.fromEntries((state.worldBookEntries||[]).map((row,i)=>[String(row?.key||row?.id||'@'+i),row]));
  return structuredClone({state:indexedState,entries,bonded:memory.bonded||{},
    items:Object.fromEntries(memory.items||[]),avatars:state.npcAvatars||{},map:memory.map||{}});
}
function frReplayCeRestoreSnapshot(snapshot,archive,memory,logId){
  const state=archive.data.state,log=archive.data.logs?.find(row=>String(row.id)===String(logId));
  for(const key of ['4','5'])if(snapshot.state[key]?.__frReplayRows) snapshot.state[key]=Object.entries(snapshot.state[key]).filter(([id])=>id!=='__frReplayRows').map(([,row])=>row);
  memory.state=state.currentState=snapshot.state;
  memory.bonded=state.bondedCharacters=snapshot.bonded;
  memory.map=state.worldMap=snapshot.map;
  memory.items=new Map(Object.entries(snapshot.items));
  state.worldBookEntries=Object.values(snapshot.entries);
  state.npcAvatars=snapshot.avatars;
  if(!log)return;
  if(Array.isArray(log.biographySnapshot))log.biographySnapshot=[{_isFullSnapshot:true},...state.worldBookEntries];
  if(log.stateSnapshot){
    const prior=typeof log.stateSnapshot==='string'?JSON.parse(log.stateSnapshot):log.stateSnapshot;
    log.stateSnapshot=JSON.stringify(prior?.currentState?{...prior,currentState:snapshot.state,worldBookEntries:state.worldBookEntries}:snapshot.state);
  }
}
// Smart repair includes the connected component of actual transfers, never unrelated actors.
// Manual selections still use the existing double-sided transfer guard.
function frReplayExpandCeTransferSelection(selection,journal){
  if(selection.system!=='ce'||selection.smart!==true)return selection;
  const result={...selection,stages:[...(selection.stages||[])],scopes:[...(selection.scopes||[])]};
  const pairs=(journal?.transfers||[]).filter(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(id=>typeof id==='string'&&id));
  let changed=true;
  while(changed){
    changed=false;
    for(const pair of pairs){
      if(!pair.some(id=>frReplayCeSelectionContains({stage:'items',identities:[id]},result)))continue;
      for(const id of pair){
        if(frReplayCeSelectionContains({stage:'items',identities:[id]},result))continue;
        result.scopes.push('items:'+id);changed=true;
      }
    }
  }
  return result;
}

function frReplayCeTransferSelected(pair,selection){
  const owners=pair.map(id=>frReplayCeSelectionContains({stage:'items',identities:[id]},selection));
  if(owners[0]!==owners[1])throw new Error('这笔物品转交涉及 '+pair.join(' 和 ')+'，请同时选中双方的物品更新；原结果已保留。');
  return owners[0];
}
function frReplayCeLegacyJournal(context){
  const before=context.beforeMemory,after=context.afterMemory;
  if(context.rebuiltAt||!before?.state||!after?.state||!context.beforeArchive||!context.afterArchive)return null;
  const old=frReplayCeSnapshot(context.beforeArchive,before),next=frReplayCeSnapshot(context.afterArchive,after);
  const writes=frReplayCeChanges('entry',old,next);
  if(!writes.length)return {changes:[],transfers:[]};
  // Older interrupted merged runs saved entry rows before the faulty time-row check.
  // Use only those explicit receipts, never attribute an unrelated same-floor write to CE.
  const entry=after.windows?.lastEntryDecisionResult?.value,ordinary=after.ordinarySettlement;
  if(!entry?.error?.includes('时间地点指令未实际应用')||entry.globalResult?.appliedCount!==0||
     !ordinary?.partial||String(ordinary.logId)!==String(context.logId)||ordinary.records?.length!==0)return null;
  const ids=new Set([...(entry.executedIds||[]),...(entry.deedsUpdatesApplied||[])].map(String));
  const scope=writes.filter(change=>change.identities.some(id=>ids.has(id)));
  if(!ids.size||[...ids].some(id=>!scope.some(change=>change.identities.includes(id))))return null;
  return {changes:scope,transfers:[]};
}
function frReplayMakeCeRecorder(){
  const archiveName=currentArchiveName;
  let active=null;
  const journal=[],transfers=[];
  const capture=async()=>frReplayCeSnapshot(await db.archives.get(archiveName),
    {state:currentState,bonded:bondedCharacters,map:WORLD_MAP_DATA,items:itemManagementFallbackRows});
  return {journal,transfers,async stage(next){
    if(currentArchiveName!==archiveName)return;
    const previous=active;
    if(!previous&&!next)return;
    active=null;
    const now=await capture();
    if(previous)journal.push(...frReplayCeChanges(previous.key,previous.before,now));
    if(next)active={key:next,before:now};
  }};
}
// An explicit actor replacement must undo that actor's previous settlement before applying the new one.
function frReplayPrepareActorReplacement(context, selection, archive, memory){
  const proseStages=['人物视角散文','群像视角散文','配角群像','落地依据提取'];
  const scopes=(selection.scopes||[]).map(frReplaySplitScope);
  if(selection.system!=='canon'||selection.mode==='continue'||(selection.stages||[]).length||!scopes.length||
     !scopes.every(scope=>scope.valid&&proseStages.includes(scope.stage)))return null;
  const names=[...new Set(scopes.map(scope=>scope.name))];
  const working=structuredClone(archive), workingMemory=structuredClone(memory);
  const log=working.data.logs.find(row=>row.id===context.logId);
  if(!log)throw new Error('找不到所选人物对应的正文楼层。');
  const before=context.beforeArchive?.data?.state, after=context.afterArchive?.data?.state;
  const state=working.data.state, actorIds={}, selected=new Set(names), replacedSourceIds=[];
  const oldPending=structuredClone(log.canonPending||null);
  function entryFor(entries,id){return (entries||[]).find(entry=>String(entry?.key||'')===id||String(entry?.id||'')===id);}
  for(const receipt of Object.values(log.canonActorCommits||{})){
    if(!selected.has(receipt.name))continue;
    const id=String(receipt.actorId||'');
    if(!/^C\d+$/.test(id)||!before||!after||!context.beforeMemory?.state||!context.afterMemory?.state)
      throw new Error(receipt.name+'缺少可安全替换的原人物基线，原结果已保留。');
    if(receipt.participantIds?.some(other=>other!==id)||
       (receipt.applied?.items||[]).some(row=>{
         const op=row.operation||row.op||row;
         return [op.owner,op.from,op.to].some(owner=>owner&&String(owner)!==id);
       })||(receipt.applied?.misc||[]).length)
      throw new Error(receipt.name+'与其他人物有共同结算，不能只撤换此人的结果。原结果已保留。');
    actorIds[receipt.name]=id;
    replacedSourceIds.push(...(receipt.eventSources||(receipt.eventSource?[receipt.eventSource]:[])).map(source=>source.sourceId));
    const replace=(target,old,next,key)=>{
      if(JSON.stringify(old?.[key])===JSON.stringify(next?.[key]))return;
      if(JSON.stringify(target?.[key])!==JSON.stringify(next?.[key]))
        throw new Error(receipt.name+'的存档在结算后已变动，不能安全替换。原结果已保留。');
      if(old?.[key]===undefined)delete target[key];else target[key]=structuredClone(old[key]);
    };
    for(const table of ['0','7']){
      const old=context.beforeMemory.state[table], next=context.afterMemory.state[table];
      if(workingMemory.state[table])replace(workingMemory.state[table],old,next,id);
      if(state.currentState?.[table])replace(state.currentState[table],old,next,id);
    }
    if(workingMemory.bonded)replace(workingMemory.bonded,context.beforeMemory.bonded,context.afterMemory.bonded,id);
    if(state.bondedCharacters)replace(state.bondedCharacters,before.bondedCharacters,after.bondedCharacters,id);
    const previous=entryFor(before.worldBookEntries,id), closed=entryFor(after.worldBookEntries,id);
    const current=entryFor(state.worldBookEntries,id);
    if(JSON.stringify(previous)!==JSON.stringify(closed)){
      if(JSON.stringify(current)!==JSON.stringify(closed))throw new Error(receipt.name+'的档案在结算后已变动，原结果已保留。');
      const position=state.worldBookEntries.indexOf(current);
      if(previous)state.worldBookEntries.splice(position<0?state.worldBookEntries.length:position,position<0?0:1,structuredClone(previous));
      else if(position>=0)state.worldBookEntries.splice(position,1);
    }
    delete log.canonActorCommits[id];
    if(log.canonSettlementReviews)delete log.canonSettlementReviews[id];
  }
  return {names,actorIds,oldPending,replacedSourceIds,working,workingMemory};
}
async function frReplayRestore(archive,memory,name){
  await db.transaction('rw',db.archives,async function(){await db.archives.put(structuredClone(archive));});
  /* 存档已写回 → 之前算出的边界指纹全部作废。
   * 这是 frReplayStamp 缓存唯一的失效入口：所有写回都走这里，
   * 所以只要在这里涨一次 epoch，缓存就绝不会把旧指纹当成新状态用。 */
  frReplayStampBump();
  if(currentArchiveName!==name)return;
  frRestoreCanonMemory(structuredClone(memory));window.currentState=currentState;
  if(typeof ceSyncWorldBookCachesFromStateEntries==='function')ceSyncWorldBookCachesFromStateEntries(archive.data?.state?.worldBookEntries||[],'selective_replay_restore',{allowEmpty:true});
  if(typeof syncStateFromTables==='function')syncStateFromTables();
  if(typeof refreshConcurrentEvolutionUI==='function')await refreshConcurrentEvolutionUI();
}
async function frReplayAttachCurrentLog(signal,system){
  /* 按系统取会话，不读全局那份「最近一次」。
   * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
   * 两条线路可能同时有会话，全局 frReplaySession 只记得后启动的那一个，
   * 直接读它会把楼层写回**别人的存档上下文**。
   *
   * 本函数由重跑内部调用，同一时刻真正在跑的系统就是 context.system；
   * 优先用它，取不到再退回「唯一那个有会话的系统」。 */
  var session=frReplayPickAttachSession(signal,system);
  if(!session)return;
  var current=await db.archives.get(session.archiveName),backup=session.backup.archive;
  // CE originally runs before this AI log is saved. Restore that same ordering.
  var present=new Set((current.data.logs||[]).map(function(l){return l.id;}));
  for(var source of backup.data.logs||[]){
    if(present.has(source.id))continue;
    var log=structuredClone(source);
    if(log.id===session.context.logId){delete log.canonStoryTurn;delete log.canonTurnCommit;delete log.canonActorCommits;delete log.canonPrebuiltCheckpoints;delete log.canonPrebuiltProse;delete log.canonSupplement;delete log.canonSettlementBase;delete log.canonSettlementReviews;log.detailedEvolutionHtml=String(log.detailedEvolutionHtml||'').replace(/<!--FR_CANON_START-->[\s\S]*?<!--FR_CANON_END-->/g,'');log.stateSnapshot=JSON.stringify(currentState);}
    current.data.logs.push(log);
  }
  await db.archives.put(current);
  // 写回楼层后，之前算出的边界指纹一样作废（见 frReplayStamp 的缓存说明）。
  frReplayStampBump();
}
// 方案 B：只核对本次重跑真正需要的材料，而不是整档指纹。
// 材料齐备且逐项对得上就允许重跑；缺哪一项就说清是哪一项，不再用一句
// 「资料和前提已变化」把玩家堵死。
//
// ★ 2026-11-02 复盘明确：这里只查 context.logId —— 也就是**本回合**那一层，
//   故意不受面板上「可复用资料楼层」选择的影响。
//   理由：能不能重跑，取决于「本回合那次检索有没有真的落盘」，
//   不能因为玩家在面板上翻到了更早楼层的旧资料，就误判成「材料齐备可以跑」。
//   面板上的楼层选择是**只读回看**，不是执行依据。
async function frReplayMaterialsReady(context){
  try{
    var row=typeof frCanonMaterialsLoad==='function'?await frCanonMaterialsLoad(context.archiveName,context.logId):null;
    // 没有任何材料记录：说明这一轮没存过检索资料，退回原判定，不假装能重跑。
    if(!row||!row.rows||!Object.keys(row.rows).length)return false;
    // 有材料就说明上轮检索已落盘，重跑时 getCanonMaterialsTake 会按需取用；
    // 逐条内容的有效性已在取用时由配置指纹把关，这里只需确认存在可用条目。
    var usable=Object.keys(row.rows).filter(function(key){var hit=row.rows[key];return hit&&typeof hit.text==='string';});
    if(!usable.length)return false;
    if(typeof frCanonTraceEvent==='function'&&typeof frCanonTraceActive==='object'&&frCanonTraceActive)frCanonTraceEvent(frCanonTraceActive,'reuse','重跑按材料级校验放行',{materials:usable.length});
    return true;
  }catch(_){return false;}
}
async function frReplayExecute(context,selection,cache){
  var parentSignal=selection.signal,queuedController=new AbortController();
  var forwardQueuedStop=function(){queuedController.abort(parentSignal.reason);};
  if(parentSignal){if(parentSignal.aborted)forwardQueuedStop();else parentSignal.addEventListener('abort',forwardQueuedStop,{once:true});}
  // 等待和拍快照期间也归全局停止管理，不能在玩家停止后悄悄启动排队任务。
  var releaseQueuedStop=typeof frCanonTrackStop==='function'?frCanonTrackStop(queuedController,context.system):function(){};
  var releaseArchive,endDiagnosticRound;
  try{
  releaseArchive=await frReplayAcquireArchive(context.archiveName,queuedController.signal,selection.onQueued);
  endDiagnosticRound=globalThis.FrDiagnosticLog?.beginRound(context.logId);
  selection={...selection,signal:queuedController.signal};
  function checkStop(){if(selection.signal?.aborted){var stopped=new Error('已取消局部重跑');stopped.name='AbortError';throw stopped;}}
  checkStop();
  var archive=await frReplayValidate(context,{allowRebase:true}),name=context.archiveName;
  checkStop();
  if(context.system==='canon'&&selection.stages.includes('补演账本')){
    if(selection.stages.length!==1||selection.scopes.length)throw new Error('请单独选择补演账本。重跑其他阶段时，会随其结果更新账本。');
    return await frReplaySavedCanonLedger(context,selection,archive);
  }
  if(!(selection.stages||[]).length&&!(selection.scopes||[]).length)throw new Error('至少选择一个阶段或人物');
  if(context.system==='canon'&& selection.replay&& context.beforeMemory&&!selection.replay.boundary)throw new Error('原记录没有冻结的补演起止时间，无法精准继续；不会以当前时间重开整轮。');
  var backup={archive:structuredClone(archive),memory:frTakeCanonMemory(),archiveName:name,system:(context.system==='ce'?'ce':'canon'),createdAt:Date.now(),bases:{ce:await dbGet('FR_REPLAY_BASE_V1:'+name+':ce'),canon:await dbGet('FR_REPLAY_BASE_V1:'+name+':canon')}};
  if(context.logId&&typeof frCanonTurnArtifactsKey==='function'){
    backup.artifactKey=frCanonTurnArtifactsKey(name,context.logId,backup.system);
    backup.artifactLogId=String(context.logId);
    backup.artifact=await dbGet(backup.artifactKey);
  }
  if(typeof frCanonTraceVisibility==='function')backup.traceVisibility=frCanonTraceVisibility();
  checkStop();
  /* 恢复备份也按系统分开存。
   * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
   * 原来键是 FR_REPLAY_RECOVERY_V1:<存档>，两边共用一个槽位 ——
   * 变量演化重跑一次就把原著补演那份崩溃备份覆盖掉了，
   * 之后原著补演出问题想「恢复中断前存档」时，恢复的是变量演化那一刻的存档。
   * 现在带上系统后缀，两份互不干扰；旧的无后缀键只读不写，保持向后兼容。 */
  var recoverySystem=(context.system==='ce')?'ce':'canon';
  var recoveryKey='FR_REPLAY_RECOVERY_V1:'+name+':'+recoverySystem;
  await dbSet(recoveryKey,backup); // Durable crash recovery before the first mutation.
  if(selection.signal?.aborted){await dbSet(recoveryKey,null);checkStop();}
  frReplaySetBusy(recoverySystem,true);
  var controller=new AbortController();
  /* 登记给 frCanonStopAll：智能重跑真正在飞的是这个 controller，
   * 不是外层 frReplayDirectTask.controller —— 不登记就停不住。
   * 玩家 2026-11-02：「而且智能重跑后原著补演还无法停止了。」 */
  var releaseStopTrack=typeof frCanonTrackStop==='function'?frCanonTrackStop(controller,recoverySystem):function(){};
  var forwardStop=function(){controller.abort(selection.signal.reason);};if(selection.signal)selection.signal.addEventListener('abort',forwardStop,{once:true});
  frReplaySession={archiveName:name,system:recoverySystem,context:context,backup:backup,selection:selection,cache:cache,controller:controller,invalid:null};
  /* 除了汇总的 frReplaySession，再按系统各存一份指针。
   * 停止、面板查询、状态判断都走 frReplaySessionOf(system)，各看各的，
   * 不会因为另一个系统正在跑就误判成本系统在跑。
   *
   * ★ 本函数后面全部改读局部别名 self，不再直接读全局 frReplaySession。
   *   原因：另一条线路随时可能把全局那个指针写走，直接读会读到别人的会话，
   *   于是本轮的 pendingSaves / invalid / prerequisite 全串台。
   *   self 从创建到 finally 都指向「本次重跑」这同一个对象，永远不会串。 */
  frReplaySessionsBySystem[recoverySystem]=frReplaySession;
  var self=frReplaySession;
  frReplayBindBoundaryProof(self);
  var abort=function(){controller.abort(Object.assign(new Error('页面已卸载，本次重跑停止'),{name:'AbortError',code:'FR_PAGE_UNLOAD'}));};window.addEventListener('pagehide',abort,{once:true});
  var succeeded=false;
  try{
    if(selection.mode!=='continue'&&typeof frCanonTraceReplace==='function')await frCanonTraceReplace(context);
    var changed=await frReplayStamp(archive,backup.memory)!==context.afterStamp;
    var prebuiltReplacement=selection.replay?.prebuiltWasLanded===true;
    var continuing=context.system==='canon'&&!prebuiltReplacement&&(selection.mode==='continue'||selection.replay?.prebuiltRepair===true);
    if(selection.replay)selection.replay.preserveInput=context.system==='canon'&&selection.replay.preserveInput===true;
    /* ★★★ 2026-11-02 玩家：「显示补演灵石失败，我点击智能重跑之后为什么直接原著人物故事
     * 全清空了，前面都写完了。不是逻辑早就是哪里错了补哪里吗？灵石这样的小问题
     * 需要从散文前跑起吗？」
     *
     * 原来的逻辑只有两种待遇：
     *   continuing（继续本轮补演） → 保留现状
     *   其它一切（局部重跑 / 智能重跑） → 无条件回到 context.beforeArchive 再跑
     *
     * 问题在于「回到 beforeArchive」= frReplayRestore 把**整份存档覆盖**
     * （db.archives.put），也就是说已经写好的散文、已经落地的人物、已经结算的账本
     * 全部被退回补演开始之前。补个灵石数量，却把整轮的成果一起抹掉。
     *
     * 正确的口径是「哪里错补哪里」：只有当玩家**明确选择了会改写正文/边界的阶段**时，
     * 才需要回到起点重算；只补杂项、物品、单个变量这类叶子阶段时，
     * 必须保留现有成果，在原地上做增量修正。
     *
     * 判定依据 selection 里勾了什么（都是已有字段，不新增状态）：
     *   · stages 里出现任何「上游/会改写正文」的阶段 → 需要回滚重算
     *   · scopes 非空（按人物重跑散文）→ 需要回滚重算
     *   · 只勾了叶子阶段（杂项、物品、材料补充等）→ 不回滚，原地增量
     */
    /* ★★★ 2026-11-03 玩家：「我在原著补演局部重跑里选择重跑已完成的韩小妹群像视角散文，
     *                   实际执行从人物边界批量判定开始重跑。」
     *
     * 原来这张表把「人物视角散文」「群像视角散文」也算成**上游阶段**，
     * 于是只勾这两项（它们明明是最终产出）也会 needsFullRewind=true，
     * 整轮回滚到补演开始前、从人物边界批量判定重跑一遍 ——
     * 玩家只是想让某个人重写一段散文，结果整轮成果被推倒重来。
     *
     * 【口径】这张表只放「会改写正文/边界判定」的真上游阶段。
     * 散文是**下游产出**：它读上游结论来写文章，勾它不该反过来触发上游重算。
     * 移除不等于「散文不能重跑」——散文照旧会被重跑，
     * 只是走增量路径，保留已完成的正文与账本。
     */
    var FR_REPLAY_UPSTREAM_STAGES = [
      '正文硬事实提取','vectorContext','生平旧账','人物边界批量判定',
      '人物终态推演','差集与正文覆盖核对',
      '补演边界格式整理'
    ];
    var replayStages = Array.isArray(selection.stages) ? selection.stages : [];
    var replayScopes = Array.isArray(selection.scopes) ? selection.scopes : [];
    // 回滚判断要包含人物限定的阶段，但请求选择仍保留 scopes 的人物粒度。
    var rewindStages=replayStages.concat(replayScopes.map(function(scope){return frReplayStageKey(frReplaySplitScope(scope).stage);}).filter(Boolean));
    /* ★★★ 2026-11-03 玩家报：「局部重跑到底是显示问题还是执行逻辑真的没修好，
     *   怎么还是从核对人物开始，显示边界批量判定？」
     *
     * 答案是**执行逻辑真的没修好**，就卡在这一行：
     *
     *   var needsFullRewind = replayScopes.length > 0 || ...;
     *
     * `replayScopes` 是「阶段:人物」形式的选择（如「物品更新:韩小妹」）。
     * 只要玩家勾了**任何一个人物**，scopes 就非空，needsFullRewind 立刻为真，
     * 于是整轮回滚到补演开始前、从「人物边界批量判定 / 核对人物」重跑 ——
     * 玩家只勾了一个人物的一步，却把整条链推倒重来。
     *
     * 【为什么要回滚，什么时候才需要回滚】
     * 回滚的目的是让「重算的部分」从一个干净的基线开始，避免重复累加。
     * 但勾**某个人物**不等于要重算所有人：这个人的结果重写即可，
     * 别人的结果照旧复用。真正需要整轮回滚的只有两种情况：
     *   ① 玩家勾的**阶段**本身会改写全局状态（人物边界判定、边界提取等）；
     *   ② 玩家没勾任何具体目标 —— 那本来就是整轮重跑。
     * 勾人物属于「定点修正一个人」，不该触发整轮回滚。
     *
     * 所以判定改成：只看**阶段**是否需要回滚；scopes 不再单独构成回滚理由。
     * 若某个 scopes 对应的阶段本身在回滚名单里，上面那条
     * rewindStages 的判定包含 scope 的所属阶段；只用于回滚判断，
     * 不把人物选择升级成整阶段重算。 */
    if(prebuiltReplacement&&changed)throw new Error('本轮落地后的存档已变化，无法安全替换预制结果。');
    var needsFullRewind = (selection.fullTurn&&context.system==='canon') || prebuiltReplacement || rewindStages.some(function (stage) { return FR_REPLAY_UPSTREAM_STAGES.indexOf(stage) >= 0; })
      || replayStages.includes('落地依据提取')
      // 一个目标都没勾 = 整轮重跑，必须回滚到干净基线。
      || (!replayStages.length && !replayScopes.length);
    var incrementalReplay = !continuing && !needsFullRewind;
    if (context.system==='canon'&&incrementalReplay) {
      console.log('[局部重跑] 本次只涉及叶子阶段（'
        + (replayStages.join('、') || '未命名阶段')
        + '），按「哪里错补哪里」在原地上增量修正，不回滚已完成的正文与账本');
    }
    var restoredArchive=continuing?archive:needsFullRewind?(changed?frReplayRewindValue(context.beforeArchive,context.afterArchive,archive):context.beforeArchive):archive;
    var restoredMemory=continuing?backup.memory:needsFullRewind?(changed?frReplayRewindValue(context.beforeMemory,context.afterMemory,backup.memory):context.beforeMemory):backup.memory;
    var didRewind=false;
    if(!continuing&&needsFullRewind){
      /* ★★★ 2026-11-03 玩家：「资料都被清空了，我只能从头跑了」。
       *
       * 【事故链 · 逐条对上日志】
       *  ① 玩家勾了上游阶段（正文硬事实提取/补演边界格式整理/人物边界批量判定）
       *     → needsFullRewind=true → 这里把**整份存档 put 回 beforeArchive**，
       *       本轮已写好的正文、人物档案、账本一起被推回补演开始前。
       *  ② 回滚之后，编排器偏偏走了「本轮没有原著人物或世界追加任务」的早返回
       *     （见 orchestrator.js 的分支），**一行散文都没重新生成**。
       *  ③ 于是存档就停在被清空的状态 —— 玩家看到的「资料全没了」。
       *
       * 【真正的缺陷】不是「回滚」本身（勾上游阶段确实需要干净基线，
       * 否则会重复累加），而是**回滚之后如果这一轮什么都没写成，
       * 没有任何机制把存档退回去**。回滚是单向的，失败却不会撤销它。
       *
       * 【修法】回滚前先留一份「回滚前快照」；如果这一轮结果没有真正落地
       * （landed=false 或 prose 为空），就把这份快照写回去 —— 等于撤销回滚。
       * 这样：
       *   · 跑成功的路径：行为完全不变（保留干净基线重算，不留快照后果）
       *   · 跑空/失败的路径：存档回到玩家点重跑之前的样子，什么都不丢
       * 不再出现「点一下，资料没了，还什么都没跑出来」。 */
      try{
        await dbSet(recoveryKey+':preRewind',{archive:structuredClone(archive),memory:frTakeCanonMemory(),archiveName:name,system:recoverySystem,createdAt:Date.now(),reason:'整轮回滚前的自动快照'});
      }catch(snapErr){console.warn('[局部重跑] 回滚前快照保存失败：',snapErr);}
      await frReplayRestore(restoredArchive,restoredMemory,name);
      didRewind=true;
      console.warn('[局部重跑] 已按上游阶段回滚到本轮起始基线（若本轮未产出，将在收尾时自动撤销）');
    }
    var result;
    let oldCeJournal;
    if(context.system==='ce'){
      if(String(frReplayLatestLog(archive)?.id)!==String(context.logId))throw new Error('变量演化重跑只能替换当前楼层的结果，原存档未改动。');
      const journal=oldCeJournal=context.ceWriteJournal||frReplayCeLegacyJournal(context);
      if(!journal||!Array.isArray(journal.changes))throw new Error('旧版没有记录本轮变量演化各阶段实际写入的内容，无法安全回退。请从本层之前的快照重新生成一次，原存档未改动。');
      const expanded=frReplayExpandCeTransferSelection({...selection,system:context.system},journal);
      if(expanded.scopes.length!==(selection.scopes||[]).length){
        selection.scopes=expanded.scopes;self.selection=selection;
        console.warn('[变量演化·智能重跑] 已自动补齐物品转交关联：'+selection.scopes.filter(scope=>scope.startsWith('items:')).join('、'));
      }
      (journal.transfers||[]).forEach(pair=>frReplayCeTransferSelected(pair,selection));
      const selectedWrites=journal.changes.filter(change=>frReplayCeSelectionContains(change,selection));
      if(selectedWrites.length){
        const working=structuredClone(archive),memory=structuredClone(backup.memory);
        const snapshot=frReplayCeApplyJournal(frReplayCeSnapshot(working,memory,context.logId),selectedWrites,selection,true);
        frReplayCeRestoreSnapshot(snapshot,working,memory,context.logId);
        await frReplayRestore(working,memory,name);
        console.warn('[变量演化·局部重跑] 已撤回所选阶段原写入 '+selectedWrites.length+' 项；开始重新演化。');
      }
    }
    if(context.system==='canon'&&incrementalReplay&&selection.replay&&!selection.replay.prebuiltRepair){
      const replacement=frReplayPrepareActorReplacement(context,selection,archive,backup.memory);
      if(replacement){
        selection.replay.actorReplacement={names:replacement.names,actorIds:replacement.actorIds,oldPending:replacement.oldPending,replacedSourceIds:replacement.replacedSourceIds};
        await frReplayRestore(replacement.working,replacement.workingMemory,name);
      }
    }
    /* ★★★ 2026-11-03 排查断点：执行器到底有没有真的把流程交给编排器。
     * 用 WARN（玩家日志只留 WARN 及以上）。这条打出来 = 确实进了执行分支；
     * 打不出来 = 在这之前就 return 了，那就是另一条路径，
     * 不能再去编排器里找来调用痕迹。 */
    try{console.warn('[局部重跑·执行] 即将交给编排器 ｜system='+String(context.system)
      +' ｜stages='+JSON.stringify(replayStages)
      +' ｜scopes='+JSON.stringify(replayScopes)
      +' ｜needsFullRewind='+String(needsFullRewind)
      +' ｜boundary='+String(!!(selection.replay&&selection.replay.boundary))
      +' ｜frozen='+String(!!(selection.replay&&selection.replay.frozenBoundary))
      +' ｜changed='+String((selection.replay&&selection.replay.changed||[]).length)
      +' ｜seeds='+String(Object.keys((selection.replay&&selection.replay.seeds)||{}).length));}catch(_){}
    if(context.system==='ce'){
      result=await rerollConcurrentEvolution({_frSelective:true,signal:controller.signal});
      if(selection.fullTurn&&result?.partial)throw new Error('整轮变量仍有失败阶段，本次已撤销并保留重跑前结果。');
      if(!result||result.ok!==true)throw new Error(result&&result.reason||'变量演化没有返回成功保存回执');
      if(!self.ceWriteJournal)throw new Error('变量演化重跑没有封存写入记录，原结果已保留。');
      const journal=oldCeJournal,replacement=self.ceWriteJournal;
      const cleared=result.replayCleared||{stages:[],scopes:[]};
      const completed=change=>(cleared.stages||[]).includes(change.stage)||(cleared.scopes||[]).some(scope=>{
        const row=frReplaySplitScope(scope);return row.stage===change.stage&&change.identities.includes(row.name);
      });
      const failedNew=replacement.changes.filter(change=>!completed(change));
      const restoreOld=journal.changes.filter(change=>frReplayCeSelectionContains(change,selection)&&!completed(change));
      if(failedNew.length||restoreOld.length){
        const working=await db.archives.get(name),memory=frTakeCanonMemory();
        let snapshot=frReplayCeSnapshot(working,memory,context.logId);
        const all={stages:[...new Set(failedNew.concat(restoreOld).map(change=>change.stage))],scopes:[]};
        snapshot=frReplayCeApplyJournal(snapshot,failedNew,all,true);
        snapshot=frReplayCeApplyJournal(snapshot,restoreOld,all,false);
        frReplayCeRestoreSnapshot(snapshot,working,memory,context.logId);
        await frReplayRestore(working,memory,name);
      }
      self.ceReplacementJournal={
        changes:journal.changes.filter(change=>!frReplayCeSelectionContains(change,selection)||!completed(change)).concat(replacement.changes.filter(completed)),
        transfers:(journal.transfers||[]).filter(pair=>!frReplayCeTransferSelected(pair,selection)||!pair.every(id=>completed({stage:'items',identities:[id]})))
          .concat((replacement.transfers||[]).filter(pair=>pair.every(id=>completed({stage:'items',identities:[id]}))))
      };
    }else{
      result=await frRunCanonAfterHostTurn({...context.args,signal:controller.signal,logId:context.logId,replay:selection.replay||null,fullTurn:selection.fullTurn===true});
      /* ★★★ 2026-11-03 排查：编排器返回了什么？
       * 用户日志只留 WARN 及以上，所以必须 warn。
       * 这一条能一次性回答「0 次调用」到底断在哪：
       *   status 非 ok  → 编排器自己判失败了（看 reason）
       *   status=ok 但 prose=0 → 散文一个都没写出来
       *   prose>0 但 landed=false → 写了但落地被判失败（看 landReason） */
      try{console.warn('[局部重跑·编排返回] status='+String(result&&result.status)
        +' landed='+String(result&&result.landed)
        +' prose='+String(((result&&result.prose)||[]).length)
        +' reason='+String((result&&(result.reason||result.landReason))||'')
        +' debts='+String(((result&&result.debts)||[]).length)
        +' backstoryDebts='+String(((result&&result.backstoryDebts)||[]).length)
        +' worldDebts='+String(((result&&result.worldDebts)||[]).length)
        +' unowned='+String(((result&&result.unowned)||[]).length));}catch(_){}
      /* ★★★ 2026-11-02 修：这里原来是一个优先级陷阱。
       *
       * 原写法：
       *   if(!result || !result.landed && !continuing && !['nothing_to_do','empty'].includes(result.status)) throw ...
       *
       * && 优先级高于 ||，所以实际等价于：
       *   if( !result || ( !result.landed && !continuing && ... ) ) throw ...
       *
       * 后果：只要 continuing 为真（也就是「继续本轮补演」这种接续模式），
       * **即使 result.landed === false（根本没落地）也不会报错**，
       * 直接把「没写成」当成成功，面板显示跑完了，但数据没进去。
       * 这正好就是玩家说的「我感觉应该是执行成功了」的另一面：
       * 有时候是真的成功被误报失败，有时候是真的没成功却被当成成功。
       *
       * 现在的判定拆开写清楚，两种情况分开处理：
       *   ① 没有任何结果 → 一定报错
       *   ② 结果明确说没落地、且不是「本来就没啥可做」的空跑 → 报错
       * continuing 不再是免死金牌：接续模式下同样要求真落地。 */
      var emptyRun=!!result&&['nothing_to_do','empty'].includes(result.status);
      /* ★★★ 2026-11-03：already_committed 必须**显式识别**，不能当成普通成功。
       * 它的含义是「这一层已按当前状态提交过，本次一步都没执行」，
       * 而玩家点的是局部重跑 —— 二者语义相反。
       * 上面的幂等短路已经对局部重跑放开（见 ceRunCanonTurnAfterStory），
       * 但如果因为别的原因仍然返回它，就必须把真相说出来，
       * 不能让它落进「0 次调用 → 没有可重算的内容」那个含糊提示里。
       * 非局部重跑路径（正常整轮）不受影响。 */
      if(result&&result.status==='already_committed'&&(selection.stages||[]).length+(selection.scopes||[]).length>0){
        throw new Error('本轮已被判定为「已按当前状态提交过」，重跑未执行任何步骤。'
          +'这是防止重复提交的保护；如果你确实要丢弃现有结果重算，请改用「智能重跑」或勾上「补演边界判定」后重试。');
      }
      var verifiedActorProgress=result?.actorProgressSaved===true&&(incrementalReplay||continuing);
      if(!result||(!result.landed&&!emptyRun&&!verifiedActorProgress)){
        /* ★★★ 2026-11-03「资料被清空」的收尾保险，必须放在 throw 之前。
         *
         * 走到了这里说明：本次已经整轮回滚（didRewind=true），
         * 而这一轮**什么都没落地**。如果不撤销回滚，玩家就等于
         * 「点了一下，资料没了，还什么都没跑出来」——正是他遇到的事故。
         *
         * 撤销用的是回滚前拍的那份快照，把存档原样写回去。
         * 这样失败路径变成「什么都没发生」，而不是「数据损坏」。 */
        if(didRewind){
          try{
            var preSnap=await dbGet(recoveryKey+':preRewind');
            if(preSnap&&preSnap.archive){
              await frReplayRestore(structuredClone(preSnap.archive),structuredClone(preSnap.memory||backup.memory),name);
              await dbSet(recoveryKey+':preRewind',null);
              console.warn('[局部重跑] 本轮未产出任何结果 → 已自动撤销回滚，存档恢复原样（未丢数据）');
            }else{
              console.warn('[局部重跑] 需要撤销回滚但快照缺失，请用手动备份恢复');
            }
          }catch(undoErr){console.warn('[局部重跑] 撤销回滚失败：',undoErr);}
        }
        throw self.prerequisite||new Error(self.invalid||result?.landReason||result?.reason||result?.status||'补演未完成');
      }
      /* 成功路径：删掉临时快照，不留冗余数据。 */
      if(didRewind){try{await dbSet(recoveryKey+':preRewind',null);}catch(_){}}
    }
    if(controller.signal.aborted||self.invalid){var reason=controller.signal.reason?.message||'',generic=/^(?:This operation was aborted|The operation was aborted\.?)$/i.test(reason);throw new Error(self.invalid||!generic&& reason||'已取消本次局部重跑');}
    if(self.pendingSaves)await Promise.all(Array.from(self.pendingSaves));
    // 空跑不能保留上游预回滚，也不能改写恢复锚点或清除失败标记。
    var savedWithoutModel=context.system==='canon'&&self.boundaryInputVerified&&(
      (selection.replay?.ledgerCloseout===true||selection.replay?.prebuiltRepair===true)&&result?.landed===true&&result.commit?.committed===true||
      continuing&&selection.replay?.prebuiltRepair===true&&result?.actorProgressSaved===true);
    if(!Number(self.realCalls||0)&&!savedWithoutModel){
      await frReplayRestoreBackup(backup);
      await dbSet(recoveryKey+':preRewind',null);
      await dbSet(recoveryKey,null);
      var noCallMessage='所选项目本轮没有实际重算，原正文、档案及重跑基线已保留。';
      if(typeof showDanmaku==='function')showDanmaku(noCallMessage,'warning');
      return Object.assign({},result||{},{noRealCall:true,noRealCallMessage:noCallMessage});
    }
    var remainingFailures=frReplayUpdatePendingFailures(context,selection,result);
    if(context.system==='ce' && typeof frRefreshOrdinarySettlementAfterReplay==='function'){
      await frRefreshOrdinarySettlementAfterReplay(context,result.replayCleared,remainingFailures);
    }
    var updated=await db.archives.get(name);
    var nextMemory=frTakeCanonMemory();
    var keepBefore=context.system==='ce'||continuing||result?.actorProgressSaved===true||!!selection.replay?.actorReplacement;
    // This independently read after-snapshot is never mutated below; keep before-side isolation.
    var next={...context,beforeArchive:structuredClone(keepBefore?context.beforeArchive:restoredArchive),beforeMemory:structuredClone(keepBefore?context.beforeMemory:restoredMemory),afterArchive:updated,afterMemory:nextMemory,afterStamp:await frReplayStamp(updated,nextMemory),sealedAt:Date.now()};
    delete next.prebuiltRetry;
    if(selection.replay?.prebuiltRepair&&result?.prebuiltRepair?.failures?.length)next.prebuiltRetry=result.prebuiltRepair;
    if(self.ceReplacementJournal)next.ceWriteJournal=self.ceReplacementJournal;
    next.pendingFailures=remainingFailures;
    var rows=frCanonTraceHistory.filter(function(r){return r.archiveName===name&& r.startedAt>=backup.createdAt&& r.phase===(context.system==='ce'?'变量演化':'正文后补演');});
    if(rows.length)next.sourceRunId=rows[rows.length-1].id;
    await dbSet('FR_REPLAY_BASE_V1:'+name+':'+context.system,next);
    if(context.system==='canon'){
      var ceBase=await dbGet('FR_REPLAY_BASE_V1:'+name+':ce');
      if(ceBase&& ceBase.logId===context.logId&& ceBase.afterStamp===context.afterStamp){ceBase.afterStamp=next.afterStamp;ceBase.sealedAt=next.sealedAt;await dbSet('FR_REPLAY_BASE_V1:'+name+':ce',ceBase);}
    }
    if(context.system==='ce'){
      // A new canonical baseline was captured by the replayed downstream turn.
      var canon=self.canonBase;
      if(canon){canon.afterStamp=next.afterStamp;canon.logId=context.logId;canon.sealedAt=next.sealedAt;await dbSet('FR_REPLAY_BASE_V1:'+name+':canon',canon);}
    }
    /* ★★★ 2026-11-02 玩家：「跑完后局部重跑里的标记是不是要清除？
     *   就是我刚才显示跑完了，但是依然报错，而且依然显示未处理错误。」
     *
     * 原因：面板的「待处理」徽标读的是 data.allRequests 里每条请求的 status，
     * 而那是**重跑前那份基线**里的记录，重跑成功并不会回头改它。
     * 于是玩家明明跑成功了，下次打开面板仍看到一片「待处理」，
     * 以为自己白跑了 —— 这正是玩家反馈的现象。
     *
     * 修法：成功时把本次**确实跑过的范围**记进这份基线的 cleared 名单，
     * 下次打开面板时，凡在这份名单里的项就按「已完成」显示。
     * 只记成功路径，失败/回滚不会走到这里，所以不会出现「没跑完却显示完成」。
     * 记的是阶段键和「阶段:人物」两种粒度，与面板的 dataset.stage / dataset.scope 对齐。 */
    try{
      var cleared=next.cleared&&typeof next.cleared==='object'?next.cleared:{stages:[],scopes:[]};
      var clearedStages=Array.isArray(cleared.stages)?cleared.stages.slice():[];
      var clearedScopes=Array.isArray(cleared.scopes)?cleared.scopes.slice():[];
      var actualCleared=result&&result.replayCleared||selection;
      if(next.prebuiltRetry){
        const failureStages=new Set(next.prebuiltRetry.failures.map(row=>row.stage));
        const failures=new Set(next.prebuiltRetry.failures.map(row=>row.subject?row.stage+':'+row.subject:row.stage));
        actualCleared={stages:(actualCleared.stages||[]).filter(stage=>!failureStages.has(stage)),
          scopes:(actualCleared.scopes||[]).filter(scope=>!failures.has(scope)&&!failures.has(frReplaySplitScope(scope).stage))};
      }
      if(context.system==='ce'&&result&&result.replayCleared){
        var touchedStages=new Set((selection.stages||[]).concat((selection.scopes||[]).map(function(scope){return String(scope).split(':')[0];})));
        clearedStages=clearedStages.filter(function(stage){return !touchedStages.has(stage);});
        clearedScopes=clearedScopes.filter(function(scope){return !(selection.stages||[]).includes(String(scope).split(':')[0])&&!(selection.scopes||[]).includes(scope)&&!(result.failedScopes||[]).includes(scope);});
      }
      (actualCleared.stages||[]).forEach(function(k){if(k&&clearedStages.indexOf(k)<0)clearedStages.push(k);});
      (actualCleared.scopes||[]).forEach(function(s){if(s&&clearedScopes.indexOf(s)<0)clearedScopes.push(s);});
      next.cleared={stages:clearedStages,scopes:clearedScopes,at:Date.now()};
      await dbSet('FR_REPLAY_BASE_V1:'+name+':'+context.system,next);
    }catch(clearError){throw new Error('局部重跑已完成范围保存失败：'+clearError.message);}
    await frReplayCommitArtifacts(next,selection,rows,result);
    if(context.system==='ce'&&next.mergedReplayReceipt)await dbSet('FR_REPLAY_BASE_V1:'+name+':ce',next);
    if(result?.landed!==false&&typeof frCanonTraceReplace==='function')await frCanonTraceReplace(context,rows.map(function(run){return run.id;}));
    await dbSet(recoveryKey,null);
    succeeded=true;
    /* ★★★ 2026-11-03 玩家报：「这次是一瞬间就显示完成了」。
     *
     * 这是「看起来没跑」最隐蔽的一类：执行器正常返回、面板按成功关闭，
     * 但本轮**一个模型请求都没发出去**——所勾阶段本轮没有可处理内容，
     * 或者请求全被判成复用。玩家完全没法区分「跑完了」和「压根没跑」，
     * 于是只能反复怀疑是不是白点了。必须把这件事说破。
     *
     * 判据用 frReplayResolve 累计的真实重算条数（self.realCalls），
     * 只在确实为 0 时提示；不猜、也不改变任何执行行为。 */
    try{
      var realCalls=Number(self.realCalls||0);
      /* ★★★ 2026-11-03 玩家报：面板底部提示
       *   「本次没有可重算的内容：所选『（未指定阶段）』……」
       *   而他明明勾了「韩小妹 · 群像视角散文」。
       *
       * 【为什么会出现「未指定阶段」】
       * 勾选**具体人物**时，阶段会被按人物收窄，selection.stages 本来就该是空的
       * （日志里「以下阶段已按右侧勾选收窄到具体人物」说的就是这件事）。
       * 但这段提示语只读 selection.stages，为空就输出「（未指定阶段）」——
       * 等于把「收窄成功」说成「你什么都没选」，把责任推给玩家。
       *
       * 【修法】把两样都说出来：
       *   · 选了阶段 → 列阶段名
       *   · 只选了人物 → 列人物名（这才是玩家实际勾的东西）
       *   · 两样都空   → 才说未指定（且这一档上面已经 throw 拦掉了，正常到不了）
       * 同时把「复用了几条」也算进去，让玩家知道请求确实被读到了，
       * 只是全部命中了复用，而不是「没读到你勾的东西」。 */
      var stageList=(selection.stages||[]).filter(Boolean);
      var scopeList=(selection.scopes||[]).filter(Boolean);
      var pickedLabel=stageList.length
        ? stageList.join('、')
        : (scopeList.length
            ? scopeList.map(function(s){return String(s).replace(/^[^:]*:/,'');}).join('、')
            : '（未指定阶段）');
      var pickedKind=stageList.length?'阶段':(scopeList.length?'人物':'');
      if(realCalls===0&&savedWithoutModel){
        if(typeof showDanmaku==='function')showDanmaku('补演账本已保存，沿用已核验的结果。','success');
      }else if(realCalls===0){
        /* 复用条数是「这次到底读到了多少请求」的硬证据：
         * 复用>0 说明链路是通的，只是全都命中缓存；复用=0 才是真的没东西可跑。
         * 两者对玩家意味着完全不同的下一步，必须分开说。 */
        var reusedCount=Number(self.reusedCount||0);
        var tail;
        if(reusedCount>0){
          tail='本轮读到 '+reusedCount+' 条已有结果并全部复用（没有需要重新生成的部分）。存档与资料未做任何改动。';
        }else{
          tail='本轮没有产出可重算的步骤（可能它本轮确实没有需要处理的内容，或结果已是最新）。存档与资料未做任何改动。';
        }
        var noCallMsg='本次没有可重算的内容：所选'
          +(pickedKind?('（按'+pickedKind+'）'):'')
          +'「'+pickedLabel+'」'+tail;
        try{ if(typeof showDanmaku==='function') showDanmaku(noCallMsg,'warning'); }catch(_){}
        if(typeof frCanonTraceEvent==='function'){
          frCanonTraceHistory.filter(function(r){return r._replay===self;}).forEach(function(noRun){
            try{frCanonTraceEvent(noRun,'notice','本轮无需重算（0 次模型调用，复用 '+reusedCount+' 条）',{stages:selection.stages||[],scopes:selection.scopes||[]});}catch(_){}
          });
        }
        try{ result=Object.assign({},result||{},{noRealCall:true,noRealCallMessage:noCallMsg}); }catch(_){}
      }else{
        try{ if(typeof showDanmaku==='function') showDanmaku((result?.partial?'局部重跑部分完成，失败项目仍保留：实际重算 ':'局部重跑完成：实际重算 ')+realCalls+' 步。',result?.partial?'warning':'success'); }catch(_){}
      }
    }catch(_){}
    return result;
  }catch(error){
    try{
      if(self.pendingSaves)await Promise.allSettled(Array.from(self.pendingSaves));
      if(continuing){
        // 接续不是替换：其他人物刚刚成功提交的事务也要保留。
        // Preserve the full independent readback without duplicating its history/images again.
        var partialArchive=await db.archives.get(name),partialMemory=frTakeCanonMemory();
        await dbSet('FR_REPLAY_BASE_V1:'+name+':canon',{...context,afterArchive:partialArchive,afterMemory:partialMemory,afterStamp:await frReplayStamp(partialArchive,partialMemory),sealedAt:Date.now()});
      }else await frReplayRestoreBackup(backup);
      if(selection.replay?.prebuiltRepair&&result?.prebuiltRepair?.failures?.length){
        var prebuiltBase=await dbGet('FR_REPLAY_BASE_V1:'+name+':canon')||context;
        if(prebuiltBase.logId===context.logId)await dbSet('FR_REPLAY_BASE_V1:'+name+':canon',
          {...prebuiltBase,prebuiltRetry:result.prebuiltRepair});
      }
      // 停止和传输失败保持原冻结基线。只有明确已返回却未通过解析/落地的回执，才新增语义失败标记。
      if(error.replayFailure&&!controller.signal.aborted&&!selection.signal?.aborted){
        var returnedStages=new Set(frCanonTraceHistory.filter(function(run){return run._replay===self;}).flatMap(function(run){return run.requests||[];}).filter(function(req){return req.status==='returned';}).map(function(req){return frReplayStageKey(req.stageKey);}));
        var semanticFailure={replayCleared:{stages:[],scopes:[]},failedStages:(error.replayFailure.failedStages||[]).filter(function(stage){return returnedStages.has(stage);}),failedScopes:(error.replayFailure.failedScopes||[]).filter(function(scope){return returnedStages.has(frReplaySplitScope(scope).stage);})};
        if(semanticFailure.failedStages.length||semanticFailure.failedScopes.length){
          var failedBase=await dbGet('FR_REPLAY_BASE_V1:'+name+':'+context.system)||context;
          if(failedBase.archiveName===name&&failedBase.system===context.system&&String(failedBase.logId||'')===String(context.logId||'')){
            failedBase.pendingFailures=frReplayUpdatePendingFailures(failedBase,selection,semanticFailure);
            await dbSet('FR_REPLAY_BASE_V1:'+name+':'+context.system,failedBase);
          }
        }
      }
      await dbSet(recoveryKey,null);
    }catch(restoreError){throw new Error('重跑结束后的存档整理未完成，请使用局部重跑面板的“恢复中断前存档”：'+restoreError.message);}
    var attempts=frCanonTraceHistory.filter(function(run){return run._replay===self;});
    for(var attempt of attempts){frCanonTraceEvent(attempt,continuing?'partial':'rollback',continuing?'已完成结果保留，仅当前步骤未完成':'本次局部重跑已撤销，原存档和内存已恢复',{reason:String(error.message||error)});await frCanonTraceFinish(attempt,self.invalid?'error':controller.signal.aborted?'cancelled':'error',{rolledBack:!continuing,reason:String(error.message||error)});}
    if(context.system==='canon'&&result?.status==='prose_failed'&&!controller.signal.aborted&&
      typeof frCanonCurrentDisplayReplayFailure==='function'){
      await frCanonCurrentDisplayReplayFailure(name,context.logId,String(result.reason||error.message||error))
        .catch(displayError=>console.warn('[局部重跑] 未能保留失败展示：',displayError.message));
    }
    throw self.prerequisite||error;
  }finally{
    window.removeEventListener('pagehide',abort);
    if(selection.signal)selection.signal.removeEventListener('abort',forwardStop);
    try{releaseStopTrack();}catch(_){}
    /* 清理也要按系统各自清，不能一把清空。
     * 原来这里无条件写 frReplaySession=null; frReplayBusy=false;
     * 于是 A 跑完就把 B 的「在跑」标记一起清掉 —— B 还在跑，锁却没了，
     * 第三方又能进来，状态彻底乱套。
     * 现在只清自己那一份，并且逐个比对：全局指针只在自己仍是它时才清。 */
    if(frReplaySessionsBySystem[recoverySystem]===self)frReplaySessionsBySystem[recoverySystem]=null;
    if(frReplaySession===self)frReplaySession=null;
    frReplayReleaseCompletedTraceSession(self);
    frReplaySetBusy(recoverySystem,false);
    if(succeeded&& typeof cloudStorageConfig==='object'&& cloudStorageConfig&& cloudStorageConfig.enabled&& cloudStorageConfig.autoSync&& typeof uploadArchiveToCloud==='function')uploadArchiveToCloud(name,true).catch(function(e){console.warn('[局部重跑] 已保存，云同步失败:',e);});
  }
  }finally{
    endDiagnosticRound?.();
    if(releaseArchive)releaseArchive();
    if(parentSignal)parentSignal.removeEventListener('abort',forwardQueuedStop);
    releaseQueuedStop();
  }
}
// Trace history outlives execution. Keep its display marker, not rollback archives/cache.
// Called only after commit/rollback and pending writes finish; active sessions stay intact.
function frReplayReleaseCompletedTraceSession(session){
  if(!session)return;
  var marker={archiveName:session.archiveName,system:session.system,completed:true,
    selection:{replay:{actorReplacement:session.selection?.replay?.actorReplacement===true}}};
  var runs=new Set(frCanonTraceHistory);
  if(typeof frCanonTraceActive==='object'&&frCanonTraceActive)runs.add(frCanonTraceActive);
  for(var run of runs){
    if(run._replay!==session)continue;
    Object.defineProperty(run,'_replay',{value:marker,enumerable:false,configurable:true});
  }
}
async function frReplayRestoreBackup(backup){await frReplayRestore(backup.archive,backup.memory,backup.archiveName);if(backup.traceVisibility && typeof frCanonTraceRestoreVisibility==='function')await frCanonTraceRestoreVisibility(backup.traceVisibility);if(backup.bases)for(var system of ['ce','canon'])await dbSet('FR_REPLAY_BASE_V1:'+backup.archiveName+':'+system,backup.bases[system]||null);if(backup.artifactKey&&typeof frCanonTurnArtifactsKey==='function'&&backup.artifactKey===frCanonTurnArtifactsKey(backup.archiveName,backup.artifactLogId,backup.system))await dbSet(backup.artifactKey,backup.artifact||null);}
/* 当前重跑面板是哪个系统（变量演化 / 原著补演）。
 * 玩家 2026-11-02：「变量演化的局部重跑只是给他做个前端入口，
 *                  他本身的后端逻辑是闭环自带的」
 * 所以两个系统的「有没有材料」必须用各自的判据，不能互借。
 * 由 frReplayOpenPicker 在打开时写入，面板内所有判据都读它。 */
var frReplaySystem='canon';
function frReplayIsCeSystem(){return frReplaySystem==='ce';}
/* 变量演化重跑的材料：本回合正文 + 已建档角色档案。
 * 它不依赖补演的资料检索快照，所以「无匹配资料」这个结论对它是错的。 */
function ceHasReplayMaterial(){
  try{
    if(typeof currentArchiveName!=='string'||!currentArchiveName)return false;
    // 本轮存在变量演化记录本身，就说明正文与角色档案当时都在。
    return frCanonTraceHistory.some(function(r){
      return r.archiveName===currentArchiveName && r.phase==='变量演化' && r.startedAt>0;
    });
  }catch(_){return false;}
}
async function frReplayReadContext(system,defaults){
  defaults=defaults||{};await frCanonTraceLoad();
  var name=currentArchiveName,context=await dbGet('FR_REPLAY_BASE_V1:'+name+':'+system);
  // The persisted boundary is replaced only at settlement. While that is pending,
  // display this round's recorded requests rather than a deleted previous floor.
  var pendingContext=typeof frReplayPending==='object'&&frReplayPending[name+':'+system];
  if(pendingContext&&pendingContext.archiveName===name&&pendingContext.system===system){
    context={...pendingContext,unsealed:true};
  }
  /* 2026-11-02 玩家：「变量演化的局部重跑只是给他做个前端入口，
   *                    他本身的后端逻辑是闭环自带的」
   *           「变量演化的材料就是玩家的正文剧情……是不存在资料丢失的」
   *
   * 原来这里把两个系统混在一个池子里取缓存源：
   *     r.phase==='变量演化' || r.phase==='正文后补演'
   * 于是变量演化重跑会拿原著补演的记录当自己的缓存，
   * 更糟的是下面 system==='ce' 那段还会把 canon 的 base 也塞进 sources。
   *
   * 后果：变量演化重跑面板会把补演的资料检索快照当成「本阶段资料」，
   * 按人物名查不到就显示「无匹配资料」——可变量演化压根不靠补演的资料。
   *
   * 现在严格按系统取自己的记录，互不引用：
   *   变量演化 → 只认 phase==='变量演化'
   *   原著补演 → 只认 phase==='正文后补演'
   * 两者本来就是独立闭环，重跑入口只是前端一层壳子。
   */
  var wantPhase=system==='ce'?'变量演化':'正文后补演';
  var rows=frCanonTraceHistory.filter(function(r){return r.archiveName===name && r.phase===wantPhase;});
  var source=context&& rows.find(function(r){return r.id===context.sourceRunId;});
  /* ★★★ 2026-11-03 玩家拍板：「那个运行记录是指思考展示区域的运行记录……
   *   而补演流程过程中生成的数据在本轮中都应该作为持久性数据资料存在。
   *   我的需求就是哪里错了可以针对性重跑哪里。」
   *
   * 【原来错在哪】allRequests 只从 frCanonTraceHistory（**纯内存**的展示用运行记录）取。
   * 这是展示数据，重启/切存档即空，于是面板必然 0/0、局部重跑在重启后永远不可用。
   *
   * 【现在】优先用落库的「本轮阶段产物」当数据底座；
   * 只有当产物表不存在（老数据、或本轮还没跑完）时，才退回内存运行记录。
   * 两者都是同一批请求，字段口径一致，后续执行逻辑完全不用改。 */
  var artifactRow=null;
  try{
    if(context&&context.logId&&typeof frCanonTurnArtifactsLoad==='function'){
      artifactRow=await frCanonTurnArtifactsLoad(name,context.logId,(system==='ce')?'ce':'canon');
    }
  }catch(_){artifactRow=null;}
  var artifactRequests=artifactRow&&Array.isArray(artifactRow.requests)?artifactRow.requests:[];
  // Keep failed attempts out of the cache: prefer the currently committed source,
  // and its downstream canonical run, never a rejected local replay.
  // 注意：跨系统的 base 不再互相借用——ce 只认 ce 的 source。
  var sources=source?[source]:[];
  var allRequests=(artifactRequests.length
      ? artifactRequests.slice()
      : sources.flatMap(function(r){return r.requests||[];}))
    .filter(function(r){return r.stageKey!=='images';})
    .map(frReplayNormalizeRequest);
  /* 来源标记：产物表命中时，面板不该再依赖 source 是否存在。
   * 老逻辑要求 source 必须有 cacheKey 才认为可重跑，而产物表本身就是权威数据源。 */
  if(artifactRow){
    source=Object.assign({},source||{id:'artifacts:'+String(context&&context.logId||'')},{requests:artifactRequests});
    // 请求与语义结果须来自同一份已提交产物，不能拼接旧展示源的失败/成功状态。
    if(artifactRow.executionResult)source.executionResult=artifactRow.executionResult;
    if(Array.isArray(artifactRow.executionViews))source.executionViews=artifactRow.executionViews;
    if(artifactRow.replayUnavailable)source.replayUnavailable=artifactRow.replayUnavailable;
  }
  var prebuiltState=system==='canon'&&(context?.prebuiltRetry||frReplayResultOf(source||{}).prebuiltRepair);
  if(prebuiltState)for(var target of [...prebuiltState.targets,...prebuiltState.failures]){
    var exists=allRequests.some(req=>req.stageKey===target.stage&&String(req.subject||'')===String(target.subject||''));
    if(!exists)allRequests.push(frReplayNormalizeRequest({stageKey:target.stage,subject:target.subject||'',
      status:prebuiltState.failures.some(row=>row.stage===target.stage&&row.subject===target.subject)?'error':'returned'}));
  }
  if(prebuiltState)allRequests=allRequests.filter(req=>req.stageKey.startsWith('预制'));
  var ledgerReplay=null;
  if(system==='canon'&&context?.logId&&!context.unsealed){
    const liveArchive=await db.archives.get(name),floor=frReplayLatestLog(liveArchive),ledger=liveArchive?.data?.state?.canonLedger;
    if(String(floor?.id)===String(context.logId)&&floor?.canonTurnCommit&&ledger?.worldTime===floor.canonTurnCommit.worldTime){
      const error=context.ledgerReplayError||(ledger.mutationReview?.status==='pending'?ledger.mutationReview.reason:'');
      ledgerReplay={status:error?'error':'returned',error,mode:floor.canonTurnCommit.mode,review:{status:ledger.mutationReview,notes:ledger.mutationNotes}};
      source=source||{id:'ledger:'+context.logId,requests:[]};
      allRequests=allRequests.filter(req=>req.stageKey!=='补演账本');
      allRequests.push(frReplayNormalizeRequest({stageKey:'补演账本',...ledgerReplay}));
    }
  }
  var cache=allRequests.filter(function(r){return r.status==='returned'&& r.cacheKey&& r.response&& Array.isArray(r.response.choices);});
  if(source){
    var rejected=Array.from(frReplayProseState(source)).filter(function(pair){return pair[1].accepted===false;}).map(function(pair){return pair[0];});
    cache=cache.filter(function(req){return req.stageKey!=='落地依据提取'||!frReplayRequestNames(req).some(function(name){return rejected.includes(name);});});
  }
  /* 恢复备份按系统分开读，各读各的。
   * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
   * 原来只读无后缀的 FR_REPLAY_RECOVERY_V1:<存档>，两条线路共用同一个槽位，
   * 变量演化重跑一次就把原著补演那份崩溃备份覆盖了。
   * 现在优先读带系统后缀的；读不到再退回旧的无后缀键（向后兼容老数据）。 */
  var recoverySystem=(system==='ce')?'ce':'canon';
  var recovery=await dbGet('FR_REPLAY_RECOVERY_V1:'+name+':'+recoverySystem);
  if(!recovery){
    var legacy=await dbGet('FR_REPLAY_RECOVERY_V1:'+name);
    /* 旧键没有系统标记，只能凭 backup.system 判断是不是自己的。
     * 没有标记的老备份按「原著补演」处理（那是老版本唯一的入口）。 */
    if(legacy){
      var legacySystem=legacy.system==='ce'?'ce':'canon';
      if(legacySystem===recoverySystem)recovery=legacy;
    }
  }
  /* 把 base（本轮基线）也带出去：面板要靠它上面的 cleared 名单
   * 判断哪些项上一次已经跑成功了，从而不再显示「待处理」。 */
  var replayWarnings=[];
  if(artifactRow?.replayUnavailable)replayWarnings.push('边界、成功故事及接续材料：'+artifactRow.replayUnavailable);
  allRequests.forEach(function(req){if(req.replayUnavailable)replayWarnings.push((req.stageKey||'阶段')+(req.subject?' / '+req.subject:'')+'：'+req.replayUnavailable);});
  return {name:name,context:context,base:context,source:source,allRequests:allRequests,cache:cache,recovery:recovery,replayWarnings:replayWarnings,ledgerReplay};
}
// 展示页的定点操作直接执行；批量选择窗口只负责统一选取，不充当必经中转页。
// 主动整轮入口：没有失败请求也能跑，但绝不把已有写入当成空白基线。
async function frReplayRunWholeFloor(system,logId){
  system=system==='ce'?'ce':'canon';
  const name=currentArchiveName,blocked=frReplayRunBlock(system);
  if(blocked)throw new Error(blocked);
  if(!name)throw new Error('请先进入存档');
  const archive=await db.archives.get(name),log=frReplayLatestLog(archive);
  if(!log||String(log.id)!==String(logId))throw new Error('请先回退到该楼层，再重跑整轮；不会修改后续楼层的数据。');
  const memory=frTakeCanonMemory(),key=name+':'+system;
  let context=await dbGet('FR_REPLAY_BASE_V1:'+key);
  if(String(context?.logId)!==String(logId))context=null;
  const start=await dbGet('FR_REPLAY_START_V1:'+key);
  // 崩溃在首次实际写入前：起始指纹一致，可以恢复完整启动材料。
  if(!context&&String(start?.logId)===String(logId)){
    if(await frReplayStamp(archive,memory)!==start.afterStamp)throw new Error('本层曾中断且已有写入，缺少完整撤回记录。为避免物品或数值重复叠加，请先回退本层之前的快照再重跑。');
    context={...start,ceWriteJournal:{changes:[],transfers:[]}};
  }
  if(!context){
    await frCanonTraceLoad();
    const phase=system==='ce'?'变量演化':'正文后补演';
    const prior=(frCanonTraceHistory||[]).some(run=>String(run.logId)===String(logId)&&run.phase===phase);
    const artifact=typeof frCanonLoadTurnArtifacts==='function'?await frCanonLoadTurnArtifacts(name,logId,system):null;
    const settlement=memory.ordinarySettlement;
    if(prior||artifact?.executionResult||artifact?.requests?.length||(system==='ce'&&String(settlement?.logId)===String(logId)))throw new Error('本层已有执行痕迹但缺少可撤回基线，不能安全重复结算；请先回退本层之前的快照。');
    const index=archive.data.logs.findIndex(row=>String(row.id)===String(logId));
    const user=archive.data.logs.slice(0,index).reverse().find(row=>row.type==='user');
    const story=String(log.content||'').replace(/<[^>]*>/g,'');
    if(!story.trim())throw new Error('该楼层没有可用于重新演化的正文');
    context={system,archiveName:name,logId:log.id,args:{storyText:story,userInput:String(user?.content||''),logId:log.id,force:true},beforeArchive:archive,beforeMemory:memory,ceWriteJournal:{changes:[],transfers:[]}};
  }
  context={...context,unsealed:false,afterArchive:context.afterArchive||archive,afterMemory:context.afterMemory||memory,sealedAt:context.sealedAt||Date.now()};
  context.afterStamp=context.afterStamp||await frReplayStamp(archive,memory);
  // 选全阶段仅用于写入归属；请求调度由 fullTurn 明确禁用缓存/失败筛选。
  const stages=frReplayStagesFor(system).map(row=>row.key).filter(key=>key!=='补演账本');
  return frReplayExecute(context,{system,stages,scopes:[],smart:false,fullTurn:true,mode:'replace',allowDependencies:true,replay:null},[]);
}

async function frReplayRunDirect(system,defaults){
  /* 直接重跑（智能重跑 / 定点重跑）的互斥锁也按系统分开。
   * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
   * 原来 frReplayDirectBusy 是全局布尔，变量演化一开跑，原著补演的智能重跑就进不来。 */
  var directSystem=(system==='ce')?'ce':'canon';
  if(frReplayDirectBusyOf(directSystem))throw new Error('正在处理本轮重跑，请等待结束。');
  frReplaySetDirectBusy(directSystem,true);
  defaults=defaults||{};
  var task={archiveName:currentArchiveName,system:directSystem,controller:new AbortController()};
  frReplayDirectTask=task;
  frReplayDirectTasksBySystem[directSystem]=task;
  var forwardStop=function(){task.controller.abort(defaults.signal.reason);};
  if(defaults.signal){if(defaults.signal.aborted)forwardStop();else defaults.signal.addEventListener('abort',forwardStop,{once:true});}
  function checkStop(){task.controller.signal.throwIfAborted();}
  if(typeof frCanonRefreshSidebar==='function')frCanonRefreshSidebar();
  try{
  checkStop();var data=await frReplayReadContext(system,defaults);checkStop();
  // 玩家 2026-10-30：不要强制玩家恢复存档。
  // recovery 只代表「上次重跑被中断」，不是存档损坏的证据；
  // 玩家完全可能就想直接重 roll 这一轮。而且重跑自带备份+回滚，直接跑是安全的。
  // 这里原来 throw 会把所有定点重跑入口全拦死。
  if(data.recovery)console.warn('[局部重跑] 检测到上次中断的备份，本次直接重跑（开始时会重新拍备份）');
  await frReplayValidate(data.context,{allowRebase:true});
  checkStop();
  // 玩家 2026-10-30 定：只要还在本回合，任何时候都能重跑任意阶段。
  // 原来这里按 runId 严格比对，手动停止补演会留下一条中止记录并改写 sourceRunId，
  // 面板上带旧 runId 的按钮就再也点不动了。
  // 不再拿 runId 拦人：当前回合是否可重跑由 frReplayValidate 与下面的
  // source / cacheKey 校验决定，那两项已经保证边界和完整返回都成立。
  if(!data.source||!data.ledgerReplay&&!data.allRequests.some(function(r){return r.cacheKey;})&&!frReplayResultOf(data.source).prebuiltRepair)throw new Error('本轮没有完整重跑记录，不能定点替换。请使用继续本轮补演。');
  var scopes=(defaults.scopes||[]).slice();if(defaults.scope)scopes.push(defaults.scope);
  scopes=Array.from(new Set(scopes.map(function(scope){var pair=frReplaySplitScope(scope);return pair.valid?pair.stage+':'+pair.name:scope;})));
  var stages=Array.from(new Set((defaults.stages||[]).map(frReplayStageKey)));
  // 「智能重跑」（账本里点「批量重跑」）：自动只挑出真正失败/没返回的目标，
  // 玩家不用自己一页页翻找。玩家 2026-10-30：
  //   「直接点击账本那里的智能重跑，就是自动失败哪里出问题补哪里」。
  // 只有显式 smart:true 才自动挑；光带 runId 不动选择——
  // 定点重跑（frReplayRunDirect）也会带 runId，不能被顺手改范围。
  if(defaults.smart===true){
    var auto=frReplayFailedSelection(data);
    /* ★ 2026-11-02 玩家：「账本那里的智能重跑，我也是在那里几乎没有成功过，是不是也是类似问题」
     *
     * 是同一类问题，而且这里有两处。
     *
     * 第一处：直接对 frReplayFailedSelection 的返回值取 .forEach。
     *   现在它总是返回数组，但这是「碰巧安全」——只要以后任何人改动
     *   那个函数的返回形状（少给一个字段、返回 null），这里立刻抛
     *   Cannot read properties of undefined，整次智能重跑当场结束，
     *   玩家看到的就是「智能重跑又失败了」，且看不出任何原因。
     *   所以先把返回值归一化成数组，不依赖调用方永远给对。
     *
     * 第二处（更要命）：智能重跑自动挑出来的 scope 是 "stageKey:人物名"，
     *   而 stageKey 是补演的阶段键（entry/items/characters/misc/tags/biography），
     *   人物名可能来自旧记录、已改名、或根本不在本轮目标表里。
     *   这些 scope 一旦被当成「玩家点名的人物」去做收敛，
     *   就会命中「勾选的目标没有对应人物」而中止 —— 明明只是自动补失败项。
     *   所以这里打上标记，让下游知道「这些是智能挑的、可以放宽」，
     *   而不是当成玩家的硬性指定。
     */
    var autoStages=Array.isArray(auto&&auto.stages)?auto.stages:[];
    var autoScopes=Array.isArray(auto&&auto.scopes)?auto.scopes:[];
    autoStages.forEach(function(k){if(stages.indexOf(k)<0)stages.push(k);});
    autoScopes.forEach(function(k){if(scopes.indexOf(k)<0)scopes.push(k);});
    // 一个失败项都没有：不用跑，直接告诉玩家本轮是干净的。
    /* ★ 2026-11-02：这里原来 throw，账本上就显示成红字「未完成：…」，
     * 让玩家以为点坏了。其实这是「本来就没问题」，属于正常结果。
     * 改成一个带标记的普通返回，由调用方按「本轮无事可做」正常收尾。
     * 玩家定的原则：小错自己处理，不要动不动弹报错堵死流程。 */
    if(!stages.length&&!scopes.length){
      return {status:'nothing_to_do',landed:false,noFailure:true,
        reason:'本轮没有失败或没跑完的项目，不需要智能重跑。'};
    }
  }
  if(defaults.mode==='continue'){var resumed=frReplayContinueSelection(data);stages=resumed.stages;scopes=resumed.scopes;}
  if(!stages.length&&!scopes.length)throw new Error('请选择需要主动重跑的人物或阶段。');
  var selection={smart:defaults.smart===true,stages:stages,scopes:scopes,mode:defaults.mode||(defaults.smart&&frReplayPrebuiltFailures(data)?'continue':'rerun'),extra:String(defaults.extra||''),allowDependencies:defaults.allowDependencies===true,signal:task.controller.signal};
  /* ★ 2026-11-03：带上系统标识。
   * frReplayDependency 要按「原著补演 / 变量演化」各自的阶段 DAG 算下游闭包，
   * 两条线的阶段 key 有重名（tags/items/characters…）但依赖关系不同，
   * 不带这个字段就会拿 canon 的表去判 ce 的请求。
   * data.context.system 是本次重跑真实所属的系统（frReplayReadContext 给的）。 */
  selection.system=(data&&data.context&&data.context.system==='ce')?'ce':'canon';
  if(resumed)selection.completed=resumed.completed;
  selection.replay=frReplayProsePlan(data,selection);
  if(data.replayWarnings?.length&&typeof showDanmaku==='function')showDanmaku('部分重跑材料未缓存：'+data.replayWarnings.join('；'),'warning');
  await frReplayPrepareBoundary(data,selection);
  checkStop();
  return await frReplayExecuteSmart(data,selection);
  }finally{
    if(defaults.signal)defaults.signal.removeEventListener('abort',forwardStop);
    if(frReplayDirectTask===task)frReplayDirectTask=null;
    if(frReplayDirectTasksBySystem[directSystem]===task)frReplayDirectTasksBySystem[directSystem]=null;
    frReplaySetDirectBusy(directSystem,false);
    if(typeof frCanonRefreshSidebar==='function')frCanonRefreshSidebar();
  }
}
// 账本入口只追加实际发现的失效前置；定点入口保留明确的前置操作交给玩家。
async function frReplayExecuteSmart(data,selection){
  var visited=new Set();
  // 重试要有上限。原来 for(;;) 只靠 visited 防「同一组前置重复」，
  // 防不住「每次缺的前置都不一样」——那样会一轮轮整轮重跑，玩家看到的就是
  // 一直转圈、一直弹「局部重跑尚未结束」（玩家 2026-10-30 报）。
  // 正常最多补两次前置就齐了；到 3 次还不行，说明是死循环，必须停。
  var rounds=0;
  // 整轮重跑总时长兜底。单次请求有 280 秒超时，但整轮没有，
  // 卡住时玩家只能看着转圈（玩家 2026-10-30 报）。
  var outerSignal=selection.signal,controller=new AbortController();
  var forward=function(){controller.abort(outerSignal.reason);};
  if(outerSignal?.aborted)forward();else outerSignal?.addEventListener('abort',forward,{once:true});
  var deadline=setTimeout(function(){
    var run=typeof frCanonTraceActive==='object'?frCanonTraceActive:null;
    var stage=run?._replay&&run.archiveName===data.context?.archiveName&&run._replay.system===data.context?.system?run.currentStage:'';
    controller.abort(Object.assign(new Error('局部重跑超过 15 分钟'+(stage?'（'+stage+'）':'')+'，已停止；请检查未完成阶段。'),{name:'TimeoutError'}));
  },15*60*1000);
  selection={...selection,signal:controller.signal};
  try{for(;;){
    if(++rounds>3)throw new Error('补演重试 3 次仍未凑齐前置材料，已停止。请检查局部重跑的目标选择，或改用整轮重跑。');
    selection.signal?.throwIfAborted();
    try{return await frReplayExecute(data.context,selection,data.cache);}catch(error){
      selection.signal?.throwIfAborted();
      if(selection.mode!=='continue'||error.code!=='FR_REPLAY_PREREQUISITE'||!error.retrySelection)throw error;
      var key=JSON.stringify(error.retrySelection);if(visited.has(key))throw error;visited.add(key);
      // 让玩家看见它在补前置，而不是以为卡住了。
      if(typeof frCanonTraceEvent==='function'&&typeof frCanonTraceActive==='object'&&frCanonTraceActive)frCanonTraceEvent(frCanonTraceActive,'dependency','第 '+rounds+' 次补前置材料后重试',{stages:(error.retrySelection.stages||[]).join('、'),scopes:(error.retrySelection.scopes||[]).join('、')});
      var attempts=typeof frCanonTraceHistory!=='undefined'?frCanonTraceHistory.filter(function(run){return run._replay?.selection===selection;}):[];
      var reusable=attempts.flatMap(function(run){return run.requests||[];}).filter(function(req){return req.status==='returned'&& req.cacheKey&& req.response?.choices;});
      data.cache=data.cache.concat(reusable);selection.smartReuse=Array.from(new Set([...(selection.smartReuse||[]),...reusable.map(function(req){return req.cacheKey;})]));
      selection.stages=Array.from(new Set(selection.stages.concat(error.retrySelection.stages||[])));
      selection.scopes=Array.from(new Set(selection.scopes.concat(error.retrySelection.scopes||[])));
      selection.completed=(selection.completed||[]).flatMap(function(row){
        if(selection.stages.includes(row.stageKey))return [];
        var targets=row.targets.filter(function(id){return !selection.scopes.includes(row.stageKey+':'+id);});
        return row.targets.length&&!targets.length?[]:[{stageKey:row.stageKey,targets:targets}];
      });
      selection.replay=frReplayProsePlan(data,selection);
      await frReplayPrepareBoundary(data,selection);
    }
  }}finally{clearTimeout(deadline);outerSignal?.removeEventListener('abort',forward);}
}
async function frReplayOpenPicker(system,defaults){
  defaults=defaults||{};
  var existing=document.getElementById('fr-replay-overlay');if(existing){existing.focus();return;}
  frReplaySystem=system==='ce'?'ce':'canon';
  var data=await frReplayReadContext(system,defaults),name=data.name,context=data.context,source=data.source,allRequests=data.allRequests,cache=data.cache,recovery=data.recovery;
  var overlay=document.createElement('div');overlay.id='fr-replay-overlay';overlay.className='overlay visible';overlay.tabIndex=-1;
  var panel=document.createElement('section');panel.className='modal fr-replay-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','按阶段与人物局部重跑');overlay.appendChild(panel);
  function node(tag,text,parent){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;(parent||panel).appendChild(n);return n;}
  var header=node('header');header.className='fr-replay-header';node('h3',(system==='ce'?'变量演化':'原著补演')+' · 局部重跑',header);
  var modeInfo=frReplayModeInfo(data,system);
  var modeLine=node('p',modeInfo.mode==='prebuilt'?'原回合：预制成品补演 · 本次重跑：定点处理':'原回合变量模式：'+modeInfo.label+' · 本次重跑：分阶段定点修补',header);modeLine.className='fr-replay-note';modeLine.dataset.replayMode=modeInfo.mode;
  node('p',modeInfo.description,header).className='fr-replay-note';
  if(data.replayWarnings?.length)node('p','部分结果无法直接复用，重跑时需要重新获取：'+data.replayWarnings.join('；'),header).className='fr-replay-error';
  /* 2026-11-02 玩家：「包括原著补演的局部重跑和变量演化的局部重跑，
   * 是不是都显示一下当前对齐的层数，这样这些需要对齐快照的资料
   * 我们就能一目了然是否落实了我们的修复内容。」
   *
   * 楼层号统一取 window.__frFloorDisplayMap（与「人生快照」同一口径）。
   * 显示的是 context.logId 对应的那一层 —— 也就是这次重跑**真正会作用到的楼层**，
   * 这样玩家打开面板就能确认「我改的是不是当前这一层」，不用再去别处比对。
   */
  var replayFloorText=(function(){
    try{
      var key=String(context&&context.logId||'');
      if(!key)return '';
      /* ★★★ 2026-11-02 实测数据：「对齐楼层：当前回合（该层未登记）」
       *
       * 诊断输出：
       *   {"hasMap":false,"mapSize":0,"archiveLogs":3,"logIdIndex":2,"logIdFound":true}
       *
       * 也就是说：当前回合**就在存档里**，下标 2，楼层算出来是「第 3 层」；
       * 但 window.__frFloorDisplayMap 是 null —— 因为它只在**打开人生快照面板**
       * 时才被赋值（见 main.js 的空快照函数内部）。补演/重跑面板平时先开，
       * 那时 window 上根本没有这份映射，于是永远掉进「该层未登记」。
       *
       * 修法：不要依赖「谁先算过」。
       *   ① 优先用已经算好的 window.__frFloorDisplayMap（和人生快照完全同口径）；
       *   ② 没有就现场读存档、调 frFloorLabelOf 现算（算法逐行照抄 main.js，
       *      跳过 isSnapshot/isUndoSnapshot，深度合并层按 mergedCount 记「第 N-M 层」）。
       * 这样无论面板谁先打开，显示都一致。
       */
      var map=(typeof window!=='undefined'&&window.__frFloorDisplayMap instanceof Map)?window.__frFloorDisplayMap:null;
      if(map&&map.has(key)){
        var hit=map.get(key);
        if(hit&&hit.displayText)return String(hit.displayText);
      }
      // 兜底：现读存档再算（异步面板——先返回空，由下面 refreshFloorLabel 回填）
      if(typeof frFloorLabelSync==='function'){
        var sync=frFloorLabelSync(key,currentArchiveName);
        if(sync)return sync;
      }
    }catch(_){return '';}
    return '';
  })();

  var headerMeta=node('p','对齐楼层：'+(replayFloorText||'当前回合（该层未登记）')
    +(source?' · 复用本层已有结果':'')+(context&&context.logId?'':'（无楼层绑定）'),header);
  headerMeta.className='fr-replay-note fr-replay-floor';
  /* ★★★ 2026-11-03 玩家截图：「对齐楼层：当前回合（该层未登记）」，可诊断明明写着「楼层已绑定」。
   *
   * 【根因】上一版注释里写着「先返回空，由下面 refreshFloorLabel 回填」——
   * 但那个回填函数**从来没有被写出来**。注释描述了一个不存在的机制，
   * 于是只要面板打开时 frCanonFloorCache 还没预热，这一行就永远停在「该层未登记」。
   *
   * 面板是同步渲染的，而读存档算楼层是异步的，所以正确的做法只能是：
   * 先用同步结果渲染 → 异步算出来后再改这一行文字。
   * 这里补上真正缺的那段回填。 */
  (function(refreshFloorLabel){
    var key=String(context&&context.logId||'');
    if(!key)return;
    if(replayFloorText)return;                       // 同步就算出来了，不用回填
    var name=String(currentArchiveName||'');
    if(!name)return;
    Promise.resolve()
      .then(function(){return typeof frCanonFloorCacheRefresh==='function'?frCanonFloorCacheRefresh(name):null;})
      .then(function(){
        var text=typeof frFloorLabelSync==='function'?frFloorLabelSync(key,name):'';
        if(!text)return;
        /* 只在面板还在文档里、而且还是「未登记」这句时才改，避免覆盖后续状态。 */
        if(!headerMeta.isConnected)return;
        headerMeta.textContent='对齐楼层：'+text
          +(source?' · 复用本层已有结果':'')+(context&&context.logId?'':'（无楼层绑定）');
      })
      .catch(function(){});
  })();
  // 右上角关闭：与 Esc、底部「取消」走同一条退出路径，重跑进行中时先停止并恢复。
  var headerClose=node('button','✕',header);headerClose.type='button';headerClose.className='fr-replay-x';headerClose.setAttribute('aria-label','关闭局部重跑');
  headerClose.addEventListener('click',function(){
    // 关窗而已，重跑继续在后台跑完（玩家 2026-10-30 明确要求）。
    dismiss();
  });
  var note=node('p','选择需要重新处理的阶段或人物，其余有效结果复用；结果变化时，仅更新本人及真正受影响的后续核对。',header);note.className='fr-replay-note';
  /* 楼层选择：正常情况下只有本回合一层，选择器会隐藏（见 refreshFloors）。
   *
   * ★ 2026-11-02 复盘澄清（玩家问：「局部重跑里的资料复用只保留在本回合？」）：
   *   这里**只是只读回看**。翻到更早的楼层能看到当时的检索资料，
   *   但重跑时真正复用的永远是**本回合**那一份（见 frReplayReadContext 的 source、
   *   以及 frReplayMaterialsReady 只查 context.logId）。
   *   所以标签写成「查看历史资料楼层」而不是「可复用资料楼层」——
   *   原来那个名字会让人以为翻到哪层就能拿哪层的资料去复用，是错的。
   */
  var floorBar=node('div',undefined,header);floorBar.className='fr-replay-floors';floorBar.hidden=true;
  var floorLabel=node('label','查看历史资料楼层',floorBar);floorLabel.className='fr-replay-floor-label';
  floorLabel.title='这里可以翻看前几轮留下的检索资料，仅供对照参考；重跑实际复用的永远是本回合自己的资料。';
  var floorSelect=node('select',undefined,floorLabel);floorSelect.className='fr-replay-floor-select';floorSelect.setAttribute('aria-label','选择要查看资料的楼层');
  var floorInfo=node('span','',floorBar);floorInfo.className='fr-replay-floor-info';
  var floorCache=new Map();
  var currentFloorId='';
  // 目标卡上的资料徽标，等楼层资料异步加载完后统一回填（见 refreshFloors）。
  var badgeCells=[];
  var floorError='';
  /* ★ 2026-11-02 玩家：「按阶段重跑和按人物分组重跑的逻辑有问题，好像失效了。
   *   干脆就删除了，不需要上面这个分类，左右本身就分类了。」
   *
   * 这两个页签是过时的设计：左边本来就是阶段、右边本来就是目标，
   * 界面上已经天然分了类。再加一层「按阶段 / 按人物」的切换，
   * 不但没有信息增量，还引入了一堆「切换后列表被过滤、搜索失效、
   * 当前阶段残留」的问题——玩家看到的就是「逻辑失效了」。
   *
   * 所以整个页签区删掉，mode 恒为 'stage'（= 不过滤），
   * 左右两栏各自负责自己的浏览与勾选，互不干扰。
   * 相关变量保留但不再参与过滤，避免牵动其它引用点。 */
  var body=node('div');body.className='fr-replay-body';
  var aside=node('aside',undefined,body);aside.className='fr-replay-stages';node('h4','要重跑什么',aside);
  /* 玩家 2026-11-03：「我觉得你左侧弄两份就是画蛇添足了，就用简化的这一份就好了」。
   * 所以不再提供「详细 / 按动作看」切换——只留一份：动作。
   * 技术阶段对玩家没有意义，它只是系统内部的执行单位，藏在动作下面即可。 */
  var viewBar=node('div',undefined,aside);viewBar.className='fr-replay-view-bar';viewBar.hidden=true;
  var btnDetail=node('button','详细',viewBar);btnDetail.type='button';
  var btnSimple=node('button','按动作看',viewBar);btnSimple.type='button';
  var viewTip=node('p','勾一个动作，等于勾上它包含的全部步骤。下方右侧按同一步骤分组列出具体项目。',aside);viewTip.className='fr-replay-view-tip';
  var stageList=node('div',undefined,aside);stageList.className='fr-replay-stage-list';
  var instructions=node('details',undefined,aside);node('summary','重跑说明',instructions);node('p','只重新处理选中的项目，复用本回合有效资料与未选中的成功结果；仅当前置失效时补齐必要前置。主正文与已生成图片保留；失败或停止会恢复重跑前状态。',instructions);
  var extraFold=node('details',undefined,aside);node('summary','附加要求（可选）',extraFold);
  var extra=node('textarea',undefined,extraFold);extra.rows=3;extra.placeholder='只传给本次选中的阶段或人物';extra.setAttribute('aria-label','局部重跑附加要求');
  var depLabel=node('label',undefined,extraFold),dep=node('input',undefined,depLabel);dep.type='checkbox';depLabel.appendChild(document.createTextNode('允许已确认依赖的后续阶段更新（不会重算无关人物）'));
  var targetArea=node('section',undefined,body);targetArea.className='fr-replay-targets';
  /* 自动关联说明条：勾选后在这里如实告诉玩家「还自动带了哪几个阶段、为什么」。
   * 默认隐藏，没有自动带上任何东西时不占版面。 */
  var autoBar=node('p',undefined,targetArea);autoBar.className='fr-replay-auto-related';autoBar.hidden=true;
  autoBar.setAttribute('role','status');
  var tools=node('div',undefined,targetArea);tools.className='fr-replay-target-tools';
  /* ★ 2026-11-02 玩家：「左边是大阶段，右边是该阶段对应的小流程或者
   *   具体人物或者项目，这个逻辑本身就是分类了。」
   *
   * 原来上面还有一层「按阶段重跑 / 按人物分组重跑」页签，纯属重复分类，
   * 而且切换逻辑带着一堆毛病（列表被过滤、搜索失效、当前阶段残留）。
   * 页签已经整个删掉，改成左右天然对应的结构：
   *   左边 = 大阶段；右边 = 这个阶段下的具体人物/项目。
   *
   * 但只剩一个问题要补：以前点页签会把 activeStage 清空，
   * 现在没页签了，玩家点了某个阶段的「查看目标」就再也回不到全部。
   * 所以在右侧标题旁放一个「当前：<阶段名> ✕ 显示全部」的小胶囊，
   * 点 ✕ 或点它本身就能回到全量视图。
   * 没选中具体阶段时不显示，不占版面。 */
  var stageFilterBar=node('div',undefined,tools);stageFilterBar.className='fr-replay-stage-filter';stageFilterBar.hidden=true;
  var stageFilterName=node('span','',stageFilterBar);stageFilterName.className='fr-replay-stage-filter-name';
  var stageFilterClear=node('button','显示全部',stageFilterBar);stageFilterClear.type='button';stageFilterClear.className='fr-replay-stage-filter-clear';
  stageFilterClear.addEventListener('click',function(){activeStage='';activeAction='';page=0;renderFilter();});
  var targetTitle=node('h4','目标',tools),filterLabel=node('label',undefined,tools),unfinished=node('input',undefined,filterLabel);unfinished.type='checkbox';unfinished.dataset.replayFilter='unfinished';filterLabel.appendChild(document.createTextNode('仅看失败项'));
  var search=node('input',undefined,tools);search.type='search';search.placeholder='搜索阶段或人物姓名';search.setAttribute('aria-label','搜索阶段或人物');
  var selections=node('div',undefined,tools);selections.className='fr-replay-selection-tools';var selectVisible=node('button','全选当前结果',selections),clear=node('button','清空全部',selections);selectVisible.type=clear.type='button';
  /* ★★★ 2026-11-02 玩家改定位（原话）：
   *   「智能重跑的按钮最好放在最下面开始局部重跑这一条，
   *     而且最好 ui 做区分度显眼一些，引导玩家优先使用。」
   *
   * 所以它不再放在目标区工具条里，而是挪到页面最底部的 footer，
   * 和「开始局部重跑」并排，做成高亮主按钮，引导玩家优先用它。
   * 语义与账本里的智能重跑**完全一致**，不是另写一套：
   * 都走 frReplayRunDirect 的 smart:true 分支，由 frReplayFailedSelection
   * 自动挑出失败/没返回的目标，然后走和手动勾选一样的执行路径。
   * 玩家原话：「智能重跑的逻辑本质就是自动把出问题的都选上重跑」。
   *
   * 按钮在这里先建好，等 footer 建出来再挂进去。 */
  var smart=node('button','智能重跑');
  smart.type='button';
  smart.className='fr-replay-smart-btn';
  smart.title='自动挑出本轮失败或没有返回的项目，直接重跑这些项目（不会多跑没出问题的地方）';
  var targetList=node('div',undefined,targetArea);targetList.className='fr-replay-target-list';
  var empty=node('p','没有符合条件的目标。',targetArea);empty.className='fr-replay-empty';empty.hidden=true;
  // 资料详情：就地展开在条目下方（玩家 2026-10-30 要求）。
  // 原来是个盖在列表右侧的抽屉，看资料时要在两个区域之间来回挪眼；
  // 列表里又常有同名条目（比如多个「韩父韩天生」），并排显示容易看错行。
  // 现在改成：哪个条目点了「资料」，内容就贴在哪个条目正下方，再点一次收起。
  var inlineMat=null; // 当前展开的就地容器，同一时刻只留一个
  function closeMaterials(){if(!inlineMat)return;inlineMat.remove();inlineMat=null;}
  function inlineHost(anchor){
    // 同一个锚点再次点击＝收起；换锚点＝先把旧的收掉。
    if(inlineMat&&inlineMat._anchor===anchor){closeMaterials();return null;}
    closeMaterials();
    var host=document.createElement('div');host.className='fr-replay-inline-mat';
    host._anchor=anchor;
    // 插在锚点后面。锚点是 label/卡片，它的父节点就是列表容器。
    if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(host,anchor.nextSibling);
    else targetList.appendChild(host);
    inlineMat=host;
    return host;
  }
  // 状态行：状态文字 + 可选的「恢复中断前存档」小按钮并排。
  // 玩家 2026-10-30：恢复按钮不要做成大块占版面，放这里小一点、够得着就行。
  var statusRow=node('div');statusRow.className='fr-replay-status-row';
  var error=node('p','正在核对本轮边界…',statusRow);error.className='fr-replay-status';error.setAttribute('role','status');
  var eligible=false;
  /* ★★★ 2026-11-03 玩家报了两次：「重启游戏依然会清空所有局部重跑资料」。
   *
   * 之前这里只把 e.message 丢到状态行，玩家看到的是
   * 「本轮完整返回已关闭、过期或未保存。请启用完整记录并完成新一轮。」
   * —— 但这句是 catch 里的**兜底文案**，真实拒绝原因（哪一步判定失败）
   * 全被吞掉了，所以一直查不出到底是「基线键没读到」还是「楼层对不上」。
   *
   * 现在把判定链路逐项写进状态行，让玩家一眼看到断在哪一环：
   *   ① 有没有读到重跑基线（FR_REPLAY_BASE_V1:<存档>:<系统>）
   *   ② 基线里的 logId 在不在当前楼层的 log 列表里
   *   ③ 本轮有没有带 cacheKey 的完整返回
   * 这三项任一为否则重跑无从谈起，玩家不必再猜。 */
  var diagParts=[];
  /* ★★★ 2026-11-03 玩家：「我要你修复的是显示问题，是你把他改坏了不显示了」。
   *
   * 【必须把两种「空」分开讲，否则误报】
   *   · 一条请求都没有 → 本轮还没跑完（产物只在回合收尾由 frReplaySealPending 落库），
   *     或重启后点开了一个没跑过的楼层。正确提示是「这轮还没有可重跑的项目」。
   *   · 有请求但都没 cacheKey → 那才是完整返回没留下。
   * 之前一律套用「完整返回已关闭、过期或未保存」，把「再跑一轮就好」
   * 误报成「设置坏了」，玩家自然以为是我改坏了。 */
  var rawRequestCount=0,cachedRequestCount=0,waitingForReplay=false;
  try{
    rawRequestCount=allRequests.length;
    cachedRequestCount=allRequests.filter(function(r){return r.cacheKey;}).length;
    diagParts.push('基线'+(context?'已读到':'未读到'));
    if(context)diagParts.push('楼层'+(context.logId?'已绑定':'未绑定'));
    diagParts.push('产物 '+artifactRequests.length+' 条');
    diagParts.push('返回 '+cachedRequestCount+' 项');
  }catch(_){}
  async function checkAdmission(){
  try{await frReplayValidate(context,{allowRebase:true});
    // 同 401 行：不再用 runId 拦人。手动停止补演会改写 sourceRunId，
    // 旧按钮带着旧 runId，按原严格比对会被永久禁用。
    // 能否重跑交给 frReplayValidate 与下面的完整返回校验。
    if(!rawRequestCount)throw new Error('本轮还没有可重跑的项目——这一回合要么还没跑完（项目在回合结束时才入库），要么是重启后没跑过的楼层。跑完一轮正文后再点这里。');
    if(!cachedRequestCount&&!data.ledgerReplay&&!frReplayResultOf(source||{}).prebuiltRepair)throw new Error('本轮的请求没有留下可复用的完整返回（缺少缓存指纹）。请确认「完整内容记录」是开启的，再跑完一轮正文。');
    if(!source)throw new Error('没有找到本轮的运行记录来源，无法确定重跑基线。');
    eligible=true;waitingForReplay=false;error.textContent='当前正文回合 · '+cache.length+' 项返回可复用';}
  catch(e){eligible=false;waitingForReplay=!!context&&(context.unsealed===true||e?.code==='FR_REPLAY_RUNNING');error.textContent=String((e&&e.message)||e)+(diagParts.length?('［诊断：'+diagParts.join(' · ')+'］'):'');}
  }
  await checkAdmission();
  var checks=[],groups=new Map();
  frReplayDisplayRequests(allRequests,system).forEach(function(r){if(!groups.has(r.stageKey))groups.set(r.stageKey,[]);groups.get(r.stageKey).push(r);});
  var names={entry:'登场与退场',items:'物品更新',characters:'人物状态更新',misc:'世界、地图与任务',tags:'人物标签',biography:'生平整理',vectorContext:'资料检索'};
  var hints={entry:'重新判断出入场与全局变化。',items:'重新处理物品、灵石和装备。',characters:'更新状态、行为、动机与生平。',misc:'重新处理世界事件、地图与任务。',biography:'按原规则整理已有生平。'};
  /* ★ 2026-11-02 玩家：「另一方面，局部重跑里本身的阶段和选项是否正确也是个问题，
   *   这也要注意。经过很多更新，可能一些阶段和流程我们已经有所调整了。」
   *
   * 原来面板只用上面那张 7 项的小表，而实际流程会发出十几种 stageKey。
   * 没被映射到的阶段就用裸键名显示，玩家看到「人物边界批量判定」「差集与正文覆盖核对」
   * 这种词，既不知道是什么、也不知道该不该勾。
   *
   * 现在改成从**当前系统自己的阶段表**里取名字和说明：
   *   · 原著补演 → CC_REPLAY_STAGES_CANON（18 项，含依赖）
   *   · 变量演化 → CC_REPLAY_STAGES_CE（6 项，无依赖）
   * 表里查不到的历史键仍然兜底用原键名，并给一句通用说明，
   * 保证「任何曾经出现过的阶段」都有可读的名字。 */
  var ceMode=frReplayIsCeSystem();
  var stageTable=frReplayStagesFor(ceMode?'ce':'canon');
  var stageByName={};stageTable.forEach(function(s){stageByName[s.key]=s;});
  stageTable.forEach(function(s){names[s.key]=s.name;if(s.hint)hints[s.key]=s.hint;});
  /* ★★★ 2026-11-03 玩家定（原话）：
   *   「重跑按实际运行顺序排，还有你说的简化。」
   *
   * 【为什么要重排】原来这个面板是按 allRequests 里出现的先后顺序渲染的，
   * 那是**请求先后**，不是流程先后；再加上面板把阶段分成「准备资料/人物推演/…」的功能组，
   * 玩家按面板读流程必然对不上真实执行顺序（世界事件补演其实在人物正文之后）。
   * 现在一律按 stageTable（= 真实执行顺序）排；表里查不到的历史键排在最后。
   *
   * 【为什么简化】18 个技术阶段对玩家是噪音：
   *   「人物边界批量判定」「差集与正文覆盖核对」「落地依据提取」
   * 玩家既不知道是什么，也不知道勾了会发生什么。所以提供「按动作看」的视图，
   * 把技术阶段归成玩家真正会想的那几件事。默认仍是详细视图，玩家自己切换。
   *
   * 【注意】这一段必须排在 stageTable 定义之后。
   * 第一版写在了前面，导致 stageTable 还是 undefined 就取 .length，
   * 玩家点「局部重跑」直接报 Cannot read properties of undefined (reading 'length')。
   * 未声明提升（var 只提升声明不提升赋值）的坑，位置就是语义。 */
  var STAGE_ACTIONS=[
    {key:'act:prebuilt',name:'定点修订预制成品',hint:'按受影响的人物、节点或世界大事修订。',stages:['预制变异边界','预制人物修订','预制人物变量','预制世界大事修订']},
    {key:'act:prebuilt-land',name:'重新落地预制成品',hint:'复用本轮已有成品和修订，重新写入存档。',stages:['预制成品落地']},
    {key:'act:prepare',name:'查资料、定边界',hint:'把本轮要用的原著资料查回来，并整理补演的起止边界。',
     stages:['vectorContext','正文硬事实提取','补演边界格式整理']},
    {key:'act:figure',name:'推演每个人物',hint:'判断每人走到哪一步、补上过往，推出本轮结束时的状态与动机，再核对有没有和正文冲突。',
     stages:['人物边界批量判定','生平旧账','人物终态推演','差集与正文覆盖核对']},
    {key:'act:gather',name:'整理落地依据',hint:'把最终能写进档案的事实依据抽出来，准备写正文。',
     stages:['落地依据提取']},
    {key:'act:prose',name:'写人物正文',hint:'按每个人自己的视角写出这一轮他经历了什么。',
     stages:['人物视角散文','群像视角散文']},
    {key:'act:world',name:'更新世界大事',hint:'把本轮所有人物正文的实际结果汇聚成新的世界大事，成为下一轮所有人的既定背景。',
     stages:['世界事件补演']},
    /* ★★★ 2026-11-03 玩家：「为什么不允许我原著补演局部重跑？」
     *
     * 【这里也要改，和 frReplayStageKey 的 ALIAS 改法配套】
     * 原来最后一组是
     *     stages:['characters','items','变量重复核验','tags','biography','misc']
     * 其中 `misc` 与上面 act:world 的「世界事件补演」是**同一件事**：
     * canon 的真实请求在 orchestrator.js:2825 用 stage='世界事件补演'，
     * 而面板旧键叫 misc。所以 `misc` 同时挂在两个动作里 ——
     * 玩家点「更新世界大事」勾中的是 misc，
     * 归一化后变成「世界事件补演」，落进这一组却又不属于「写进存档」。
     *
     * 现在统一：`misc` 只属于「更新世界大事」，写进存档这一组只保留
     * 真正落档案的四项。这样勾选与执行两边指的是同一个阶段，不再打架。 */
    {key:'act:land',name:'写进存档',hint:'把结果真正落进人物档案、物品、标签、生平、地图与任务。',
     stages:['characters','items','变量重复核验','tags','biography']},
    {key:'act:ledger',name:'补演账本',hint:'单独核对本轮已保存的账本；不会重跑正文、人物或物品。',stages:['补演账本']},
  ];
  /* ★★★ 2026-11-03 玩家：「之前的就是对的，你乱改什么？我要你修复的是显示问题，
   *   是你把他改坏了不显示了，明白吗？」
   *
   * 【我上一版错在哪 · 必须记下来】
   * 原版这一行是 `var simpleView=stageTable.length>9;`，我改成了恒 true，
   * 理由是「变量演化也是空的，所以让它也走动作视图」。
   * 这个推理从根上就错了 ——
   *
   *   原著补演 18 阶段：有资料检索、边界判定、人物推演、散文、世界事件这一整条链，
   *                      所以它需要「按动作归组」来降噪。
   *   变量演化  6 阶段：entry / characters / items / tags / misc / biography，
   *                      本身就是玩家看得懂的动作，**它走的是自己的详细列表**，
   *                      根本不需要、也不应该套原著补演的六动作分组。
   *
   * 我把 fmt 改成恒 true 之后，变量演化被迫用 CANON 的 STAGE_ACTIONS 去匹配，
   * 而两套 key 几乎不重叠 → 五张卡片全写「本轮没有这一项」、entry 还没归属。
   * **这就是「改坏了不显示」的真正来源。**
   *
   * 【现在】恢复原判据：两条线路各走各的视图，符合它们各自的流程。
   * 原来那条真正的显示 bug 单独修（见下面 if(!present.length) 那段），
   * 不再靠「换视图」来绕过。 */
  var simpleView=stageTable.length>9; /* 阶段多才用动作视图；变量演化只有几项走自己的列表 */
  /* 阶段 → 动作 反查表：右侧项目卡按这个归组。 */
  var actionOfStage={};
  STAGE_ACTIONS.forEach(function(a){a.stages.forEach(function(s){actionOfStage[s]=a.key;});});
  /* 按真实执行顺序给 groups 排序；表里没有的键（历史遗留）排到最后。 */
  var orderedGroups=new Map();
  stageTable.forEach(function(s){if(groups.has(s.key))orderedGroups.set(s.key,groups.get(s.key));});
  groups.forEach(function(requests,key){if(!orderedGroups.has(key))orderedGroups.set(key,requests);});
  groups=orderedGroups;
  var pendingSelection={stages:[],scopes:[]};try{pendingSelection=frReplayContinueSelection(data);}catch(_){}
  var latestFailures=frReplayFailedSelection(data);
  /* ★ 2026-11-02 玩家：「跑完后局部重跑里的标记是不是要清除？」
   *
   * 这份 cleared 名单是上一次局部重跑**成功**时记下的范围。
   * 凡在名单里的阶段/人物，说明它已经跑完了，徽标就不再显示「待处理」，
   * 免得玩家明明跑成功却看到一片红，以为白跑了。
   * 只认成功路径写入的记录；失败或回滚不会留下 cleared。 */
  var clearedRange=(function(){
    try{
      var base=data.base;
      var c=base&&base.cleared;
      if(!c||typeof c!=='object')return {stages:[],scopes:[]};
      return {stages:Array.isArray(c.stages)?c.stages:[],scopes:Array.isArray(c.scopes)?c.scopes:[]};
    }catch(_){return {stages:[],scopes:[]};}
  })();
  var wasClearedStage={};clearedRange.stages.forEach(function(k){wasClearedStage[k]=true;});
  var wasClearedScope={};clearedRange.scopes.forEach(function(s){wasClearedScope[s]=true;});
  /* ★★★ 2026-11-02 玩家：「世界地图和任务为什么总是失败，是不是之前的残留？
   * 看起来杂项是跑完的啊？」
   *
   * 对，就是残留。上面的 cleared 名单只在**局部重跑成功**时才写，
   * 而玩家日常跑的是**正常补演**——那条路径从来没人写 cleared。
   * 于是面板读 allRequests 里那份**补演之前**的旧基线，
   * 看到 misc 当时没返回就永远标「待处理」，
   * 哪怕这一次补演的杂项明明已经跑成功、日志里都写着「应用结果: 应用 1 条」。
   *
   * 修法：把「**当前这一层真实跑成功的项**」也算成已完成。
   * 数据来源是当前的运行记录（frCanonTraceHistory 里本楼层、非变量演化的 run），
   * 它记录的是**实际这一次**每个阶段/每个目标的结果，不是旧基线。
   * 判据只认明确成功的标记，不猜：
   *   · run.status 为 'ok'/'done'/'success'/'completed' 且没有 rolledBack
   *   · 该 run 的事件里出现 'committed'/'saved' 收尾
   */
  var liveDoneStage={},liveDoneScope={};
  try{
    var liveLogId=String(context&&context.logId||'');
    var livePhaseName=(system==='ce')?'变量演化':'正文后补演';
    var liveArchiveName=String(name||'');
    /* 关键：阶段与目标记在 run.requests[] 里（见 canon-observability.js
     *   `run.requests.push(req)`，req.stageKey / req.subject / req.targetId / req.status），
     * run 本身上没有 stageKey/targets 字段。所以必须遍历 requests，不能读 run.stageKey。 */
    var liveDoneRequest={};
    if(Array.isArray(frCanonTraceHistory)){
      frCanonTraceHistory.forEach(function(run){
        if(!run)return;
        if(liveArchiveName&&run.archiveName!==liveArchiveName)return;
        if(liveLogId&&String(run.logId||'')!==liveLogId)return;
        if(run.phase!==livePhaseName)return;
        if(run.branchHidden||run.result&&run.result.rolledBack===true)return;
        var st=String(run.status||'').toLowerCase();
        var okStatus=(st==='saved'||st==='ok'||st==='done'||st==='success'||st==='completed');
        var hasCommit=false;
        try{
          hasCommit=(run.events||[]).some(function(e){return e&&(e.type==='committed'||e.type==='saved');});
        }catch(_){}
        var canComplete=okStatus||hasCommit||st==='running';
        var requests=Array.isArray(run.requests)?run.requests:[];
        requests.forEach(function(req){
          if(!req)return;
          var reqStatus=String(req.status||'').toLowerCase();
          var completed=canComplete&&(reqStatus==='returned'||reqStatus==='skipped');
          // 与 allRequests 使用同一阶段身份；新版失败覆盖旧版成功。
          var stKey=frReplayStageKey(req.stageKey);
          if(!stKey)return;
          var ids=Array.from(new Set(frReplayRequestTargets(req).concat(frReplayRequestNames(req))));
          // 人物返回只完成本人，不得将整个阶段所有人标成完成。
          if(!ids.length)liveDoneStage[stKey]=completed;
          ids.forEach(function(id){liveDoneScope[stKey+':'+id]=completed;});
          var subj=String(req.subject||'').trim();
          var targetId=String(req.targetId||'').trim();
          if(targetId)liveDoneScope[stKey+':'+targetId]=completed;
          liveDoneRequest[stKey+'|'+subj]=completed;
        });
      });
    }
  }catch(liveDoneError){console.warn('[局部重跑] 读取本轮实际完成情况失败（不影响面板）:',liveDoneError);}
  var stageOrder={};
  var targets=[],stageBoxes=new Map(),activeStage='';
  /* 动作级过滤：activeStage 只能存一个阶段 key，而一个动作可能含多个技术阶段。
   * 所以单独存 activeAction，visibleTargets 优先按它过滤（整组），
   * 没有 activeAction 时才退回原来的单阶段过滤（详细视图仍在用）。 */
  var activeAction='';
  /* 简化视图下，一张卡代表「一个动作」，下面挂着它包含的技术阶段。
   * 勾动作 = 勾它的全部技术阶段，语义与详细视图完全一致，
   * 只是让玩家按「我要重做什么事」来选，而不是按「哪个模型请求」来选。
   *
   * 实现上不重排原有渲染：两个视图各自渲染到自己的容器，切换只切显示。
   * 这样详细视图那条久经考验的渲染路径一行都不用动，风险最小。 */
  var actionBoxes=new Map();
  /* 详细列表照常渲染（stageBoxes 全在里面，执行侧照旧），但不显示。
   * 玩家只看动作；技术阶段降级为内部执行单位。 */
  var detailWrap=node('div',undefined,stageList);detailWrap.className='fr-replay-detail-list';detailWrap.hidden=true;
  var simpleWrap=node('div',undefined,stageList);simpleWrap.className='fr-replay-action-list';
  function syncActionBoxes(){
    actionBoxes.forEach(function(row){
      var on=row.stages.every(function(s){var sb=stageBoxes.get(s);return sb?sb.checked:true;});
      var some=row.stages.some(function(s){var sb=stageBoxes.get(s);return sb&&sb.checked;});
      row.box.checked=on;
      row.box.indeterminate=some&&!on;
    });
  }
  /* ★★★ 2026-11-03 玩家定（原话）：
   *   「我觉得你左侧弄两份就是画蛇添足了，就用简化的这一份就好了，
   *     右边的具体项目绑定简化后的流程。你要站在玩家角度考虑，玩家要的是什么：
   *     一目了然看懂每个阶段，很快找到想要重跑的阶段和项目，
   *     一目了然看到选择的项目或者阶段之间的关联关系。」
   *
   * 【上一版错在哪】左侧同时挂了「详细（18 个技术阶段）」和「按动作看（6 个动作）」
   * 两份列表，让玩家自己在两套世界观之间来回切——这是把系统的内部分工丢给玩家去理解。
   *
   * 【现在】左侧只有一份：动作。技术阶段不再出现在界面上，只作为执行单位藏在下面。
   * 具体项目（人物/事件/物品…）在右侧，按动作分组挂到对应动作底下，
   * 这样「勾了哪个动作 → 会重跑哪些项目」在同一屏里就能看完，不用切视图。
   *
   * 【实现】执行侧完全不用改：stageBoxes 里仍然装着每个技术阶段的真实勾选框
   * （只是 hidden、不参与视觉），动作卡勾选时同步它们。
   * 右侧分组用的也是同一份 groups，项目卡的勾选逻辑一行没动。 */
  if(simpleView){
    STAGE_ACTIONS.forEach(function(action){
      const prebuiltAction=action.key.startsWith('act:prebuilt');
      if(action.key!=='act:ledger'&&prebuiltAction!==(modeInfo.mode==='prebuilt'))return;
      var present=action.stages.filter(function(s){return groups.has(s);});
      /* ★★★ 2026-11-03 玩家报：「局部重跑不管是变量演化还是原著补演现在都是空的」。
       *
       * 【我造成的】这里原来写的是 `if(!present.length)return;` ——
       * 一个动作在当前这一轮没有任何对应请求时，整张卡片直接不渲染。
       * 后果：只要 groups 是空的（这一轮还没跑成、或产物表没落上），
       * **左栏 6 个动作卡片全部消失，界面一片空白**，玩家连「该先跑一轮」都看不出来。
       *
       * 【为什么当时会这么写】想的是「这个动作下面没项目就别占地方」。
       * 但那是站在数据视角，不是玩家视角 —— 空白对玩家等于「界面坏了」。
       *
       * 【现在】卡片一律渲染，只把「本轮没有对应项目」标出来并禁用勾选。
       * 玩家看到的是「这一步这轮没跑」，而不是一个空壳面板。 */
      var absent=!present.length;
      var card=node('label',undefined,simpleWrap);card.className='fr-replay-action-card';
      if(absent)card.classList.add('is-absent');
      card.dataset.action=action.key;
      var head=node('div',undefined,card);head.className='fr-replay-action-head';
      var box=node('input',undefined,head);box.type='checkbox';
      box.dataset.action=action.key;box.dataset.stages=present.join(',');
      box.checked=absent?false:present.every(function(s){return (defaults.stages||[]).includes(s);});
      if(absent)box.disabled=true;
      node('strong',action.name,head);
      /* ★★★ 2026-11-03 玩家报：「我选了左边你右边就有对应的只显示这个阶段的项目啊，
       *   之前有这个逻辑你怎么反而删除了？」
       *
       * 对，我删了。`activeStage` 那套「右边只看这一段」的过滤逻辑（visibleTargets 里
       * `if(activeStage&&t.key!==activeStage)return false`）本身一行没动，
       * 但**唯一的触发入口**是详细阶段卡上的那个说明按钮（browse），
       * 而我把详细列表隐藏了 —— 于是玩家再也点不到，功能等于被我删掉。
       *
       * 而且玩家这句话本身也是更合理的设计：
       * 「选了左边 → 右边只显示这个阶段的项目」，这就是他要的第三个「一目了然」。
       * 所以动作卡标题区可点：点一下右栏只显示这个动作的项目，再点一下回到全部。
       * 点勾选框只负责勾选，不触发过滤（两件事分开，不互相干扰）。 */
      var focusBtn=node('button','只看这步的项目',head);focusBtn.type='button';
      focusBtn.className='fr-replay-action-focus';
      focusBtn.title=absent
        ? '这一步本轮没有产生任何项目，无从重跑。'
        : '点一下：右侧只显示「'+action.name+'」包含的项目；再点一下回到全部。';
      if(absent)focusBtn.disabled=true;
      var actionStageKeys=present.slice();
      focusBtn.addEventListener('click',function(ev){
        ev.preventDefault();ev.stopPropagation();
        if(absent)return;
        /* activeStage 只能存一个 key，而一个动作可能含多个技术阶段。
         * 所以另外记 activeAction，visibleTargets 优先按动作归组过滤（见那里的说明）。 */
        if(activeAction===action.key){
          activeAction='';activeStage='';
        }else{
          activeAction=action.key;activeStage=actionStageKeys[0]||'';
        }
        page=0;
        try{renderFilter();}catch(_){}
      });
      var body=node('div',undefined,card);body.className='fr-replay-action-body';
      node('p',action.hint,body);
      var stepLine=node('span','',body);stepLine.dataset.actionSteps=action.key;
      /* 本轮无项目时把「为什么空」直接写在卡片上，玩家不用猜是坏了还是没跑。 */
      stepLine.textContent=absent
        ? '本轮没有这一项（共 '+(action.stages||[]).length+' 步：'+action.stages.map(function(s){return names[s]||s;}).join('、')+'）'
        : '含 '+present.length+' 步：'+present.map(function(s){return names[s]||s;}).join('、');
      box.addEventListener('change',function(){
        if(absent){box.checked=false;return;}
        present.forEach(function(s){var sb=stageBoxes.get(s);if(sb)sb.checked=box.checked;});
        try{applyAutoRelationFromUserAction();}catch(_){}
      });
      actionBoxes.set(action.key,{box:box,stages:present});
      checks.push(box);
    });
  }
  {
    groups.forEach(function(requests,key){
    var stage=node('div',undefined,detailWrap);stage.className='fr-replay-stage';var label=node('label',undefined,stage),all=node('input',undefined,label);all.type='checkbox';all.dataset.stage=key;all.checked=(defaults.stages||[]).includes(key);node('strong',names[key]||key,label);checks.push(all);stageBoxes.set(key,all);
    var browse=node('button',hints[key]||'选择此阶段的全部或指定目标。',stage);browse.type='button';browse.title='只看'+(names[key]||key)+'这一项下的目标';browse.addEventListener('click',function(){activeStage=(activeStage===key?'':key);page=0;renderFilter();});
    // 阶段级「资料」入口：看这个阶段本回合的检索资料。
    // 资料入口只对原著补演有意义；变量演化自带闭环，不看补演的资料快照。
    if(!frReplayIsCeSystem()){
      var stageMat=node('button','资料',stage);stageMat.type='button';stageMat.className='fr-replay-mat-btn';
      stageMat.title='查看「'+(names[key]||key)+'」本回合的检索资料（重跑只用本回合这一份）';
      stageMat.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();openMaterials(key,'',names[key]||key,stage);});
    }
    var latest=new Map();requests.forEach(function(req){
      var individuals=frReplayScopeTargets(req);
      if(individuals.length)individuals.forEach(function(name){latest.set(name,req);});else latest.set('',req);
    });
    latest.forEach(function(req,id){var card=node('label',undefined,targetList);card.className='fr-replay-target';card.dataset.searchText=(key+' '+(names[key]||'')+' '+id+' '+req.subject).toLowerCase();
      var box=node('input',undefined,card);box.type='checkbox';
      /* ★★★ 2026-11-03 玩家报：「点击后直接弹出来了，什么都没发生」。
       *
       * 【病根】原来无条件拼 `key + ':' + id`。
       * 「世界事件补演」「物品更新」这类**阶段级目标**本身没有具体人物，id 是空串，
       * 于是 dataset.scope 变成 "世界事件补演:" —— 冒号后面什么都没有的脏 scope。
       *
       * 下游 frReplayTargetSelected 是按 (stage + ':' + name) 精确比对的：
       *     selection.scopes.includes(stage + ':' + name)
       * name 永远非空，所以这条脏 scope **匹配不到任何请求**。
       * 玩家看到的画面就是：勾上了、点开始、面板一闪关掉（走了成功路径）、
       * 游戏里什么都没变 —— 因为真正下发的范围里没有一个能对上号的请求。
       *
       * 【修法】没有具体人物时**不要拼冒号**。
       * 阶段级目标的意思本来就是「这个阶段整体」，用阶段勾选（dataset.stage）表达即可；
       * 右侧这一项只作为「看到它、能勾它」的入口，勾上等价于勾中该阶段。
       * 这样 scope 里永远不含空 name，不会再有匹配不上的脏值。 */
      var targetId=String(id==null?'':id);
      box.dataset.scope=targetId?(key+':'+targetId):'';
      box.dataset.stage=key;
      if(!targetId)box.dataset.stageOnly='1';
      box.checked=all.checked||(box.dataset.scope&&defaults.scope===box.dataset.scope)||(defaults.scopes||[]).includes(box.dataset.scope);checks.push(box);
      var copy=node('span',undefined,card);copy.className='fr-replay-target-copy';var labelName=frReplayRequestNames(req).length>1?id:req.subject||names[key]||key;if(/^(?:[BCG]\d+)(?:[,、][BCG]\d+)*$/.test(labelName))labelName='本阶段人物';node('strong',labelName,copy);node('small',names[key]||key,copy);
      /* 徽标判定：三种来源，任一为真是「待处理」
       *   ① 这条请求本身没成功返回
       *   ② 属于待接续的选择（上一轮没跑完的部分）
       *   ③ 这个人物名被待接续选择点名过
       *
       * ★ 但还要扣掉一种情况：这一项在上一次局部重跑里**已经跑成功**了。
       *   玩家 2026-11-02 报：「跑完后局部重跑里的标记是不是要清除？
       *   就是我刚才显示跑完了，但是依然显示未处理错误。」
       *   因为 ① 读的是重跑前那份基线的旧记录，成功并不会回头改它。
       *   所以这里用 cleared 名单（成功时写入）把它捞回来，
       *   已经跑成功的项就按「已完成」显示，不再误报待处理。 */
      var clearedBySuccess=(wasClearedStage[key]===true)||(wasClearedScope[key+':'+id]===true)
        // 本次补演实际跑成功的项同样算已完成（见上面 liveDone 的说明）。
        ||(liveDoneStage[key]===true)||(liveDoneScope[key+':'+id]===true)
        ||frReplayTargetPending({stages:[],scopes:Object.keys(liveDoneScope).filter(function(scope){return liveDoneScope[scope]===true;})},key,id,req);
      var failedByLatest=frReplayTargetPending(latestFailures,key,id,req);
      var unfinishedTarget=failedByLatest||!clearedBySuccess&&(!['returned','skipped'].includes(req.status)||frReplayTargetPending(pendingSelection,key,id,req));
      // 徽标要如实：资料快照按楼层存，任何阶段/任何人物都能查到匹配的资料。
      // 原来只看 key==='vectorContext'，于是人物条目一律显示「无独立资料」，
      // 玩家 2026-10-30 报：「所有项目都显示无独立资料，资料复用机制是摆设」。
      //
      // 还有一个更隐蔽的时序问题：目标列表在这里渲染，而楼层资料要到
      // 本函数末尾 refreshFloors() 异步加载完才有。所以这里只能先按当前缓存算，
      // 算出来是 0 就先不显示「无匹配资料」这种结论性文案，等资料到位再回填。
      //
      // ★ 2026-11-02 玩家：「变量演化的局部重跑只是给他做个前端入口，
      //   他本身的后端逻辑是闭环自带的」「变量演化的材料就是玩家的正文剧情」。
      //   所以变量演化（ceSystem）根本不该拿补演的检索资料当判据——
      //   它要的是本回合正文和已建档角色档案，报「无匹配资料」是纯粹的错误结论。
      var ceSystem=frReplayIsCeSystem();
      /* ★★★ 2026-11-03 玩家定（原话）：
       *   「但是你要标识清楚是结果可复用」
       *   「就是结果和资料两个标识都要有」
       *
       * 原来这里只有**一枚**徽标，而且判定完全围绕「检索资料」：
       *   有资料 → 「本回合 N 条」；没资料 → 「无匹配资料」。
       * 玩家看不出「这个阶段上次跑成功了、结果能直接拿来用」这件事，
       * 只能靠猜，于是每次都要整条链重跑才敢放心。
       *
       * 现在并排两枚，各说各的、互不冒充：
       *   ① 资料徽标：本回合检索到的资料条数（原有口径，不改）。
       *   ② 结果徽标：这个阶段/这个人物**上次已经跑成功**，产物还在，
       *      下游可以把它当输入复用 —— 这正是玩家说的
       *      「上一阶段的结果本质上不就是下一阶段的资料吗」。
       *
       * 结果复用的判据不猜：只认 liveDoneStage/liveDoneScope（本次运行记录里
       * status 为 returned/skipped 的请求），以及基线里 status==='returned' 的请求。
       * 没有可靠记录就不显示「结果可复用」，绝不拿「应该跑过了」来糊弄。
       */
      var resultReusable = !unfinishedTarget && ((liveDoneStage[key] === true)
        || (liveDoneScope[key + ':' + id] === true)
        || (req.status === 'returned')
        || frReplayRequestNames(req).some(function (nm) { return liveDoneScope[key + ':' + nm] === true; }));
      var matCount=ceSystem?0:matRowsFor(key,String(id||labelName||'')).length;
      /* 「可复用 N」改口径：真正能复用的只有**本回合**那一份资料。
       * 原来写「可复用」，配合上面的楼层选择器，很容易被理解成
       * 「切到哪一层就能复用哪一层的资料」——那是错的。
       * 2026-11-02 复盘后统一改成「本回合 N 条」，和实际行为对齐。 */
      var canReuse=ceSystem?(!unfinishedTarget&&ceHasReplayMaterial()):(!unfinishedTarget&&matCount>0);
      var status=node('span',ceSystem
        ?(unfinishedTarget?'待处理':'材料就绪')
        :(canReuse?('本回合 '+matCount+' 条'):unfinishedTarget?'待处理':'无匹配资料'),card);
      status.className='fr-replay-target-badge '+(canReuse?'returned':'unfinished');
      if(ceSystem){
        status.title=unfinishedTarget?'本项目本轮没跑完，可以单独重跑':'重跑依据：本回合正文、角色档案与预设规则；变量演化自带闭环，不需要补演资料';
      }else if(!canReuse&&!unfinishedTarget)status.title='本回合没有和它匹配的检索资料；重跑会沿用已有的检索结果。';
      else if(canReuse)status.title='本回合有 '+matCount+' 条与它相关的检索资料，重跑时直接复用，不重新检索。';
      // 供 refreshFloors 加载完后回填，避免「资料还没读就说没有」。
      badgeCells.push({status:status,key:key,id:String(id||labelName||''),unfinished:unfinishedTarget,ce:ceSystem});
      /* ★★★ 2026-11-03 玩家定：「就是结果和资料两个标识都要有」。
       * 第二枚徽标 —— 结果可复用。与资料徽标并排，各说各的：
       *   · 资料徽标回答「有没有检索资料」；
       *   · 结果徽标回答「这一步上次跑成功了没有、产物还在不在」。
       * 两者都真时，玩家就知道这一步重跑既不用重检索、也不用重推演上游。 */
      var resultBadge = node('span', resultReusable ? '结果可复用' : '需重算', card);
      resultBadge.className = 'fr-replay-target-badge fr-replay-result-badge ' + (resultReusable ? 'returned' : 'unfinished');
      resultBadge.title = resultReusable
        ? '这一步上次已经跑成功，产物还在；重跑下游时会直接把它当输入复用，不重新调模型。'
        : '这一步还没有可用的成功产物，重跑时会重新生成。';
      /* ★★★ 2026-11-03 玩家：「局部补演并不是只能补演失败的项目，而是即使成功了
       *   也要丢弃原有结果进行补演，只要玩家选择了。」
       *
       * 徽标必须跟着勾选实时变。否则会出现很误导的画面：
       * 玩家勾上「韩小妹 · 群像视角散文」，旁边却仍写着「结果可复用」，
       * 看起来像是又要复用、不会真跑。
       * 勾选 = 主动作废旧结果，此时应该显示「将丢弃重跑」。
       * 取消勾选恢复事实描述（它上次确实跑成功了）。 */
      var syncResultBadge = function () {
        var sel = box.checked;
        if (sel && resultReusable) {
          resultBadge.textContent = '将丢弃重跑';
          resultBadge.className = 'fr-replay-target-badge fr-replay-result-badge rerun';
          resultBadge.title = '已选中：本次会丢弃原有的成功结果，重新生成这一项。';
        } else if (sel) {
          resultBadge.textContent = '将重跑';
          resultBadge.className = 'fr-replay-target-badge fr-replay-result-badge rerun';
          resultBadge.title = '已选中：本次会重新生成这一项。';
        } else {
          resultBadge.textContent = resultReusable ? '结果可复用' : '需重算';
          resultBadge.className = 'fr-replay-target-badge fr-replay-result-badge ' + (resultReusable ? 'returned' : 'unfinished');
          resultBadge.title = resultReusable
            ? '这一步上次已经跑成功，产物还在；重跑下游时会直接把它当输入复用，不重新调模型。'
            : '这一步还没有可用的成功产物，重跑时会重新生成。';
        }
      };
      box.addEventListener('change', syncResultBadge);
      // 人物级「资料」入口：只显示这个人相关的检索结果。变量演化不看补演资料。
      if(!frReplayIsCeSystem()){
        var personMat=node('button','资料',card);personMat.type='button';personMat.className='fr-replay-mat-btn fr-replay-mat-btn-mini';
        personMat.title='查看「'+labelName+'」本回合的检索资料';
        personMat.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();openMaterials(key,String(id||labelName),labelName,card);});
      }
      targets.push({node:card,box:box,key:key,unfinished:unfinishedTarget});
      /* 记录这条目标属于哪个动作，供右侧按动作分组显示（玩家 2026-11-03 要求
       * 「右边的具体项目绑定简化后的流程」）。只用于展示归组，不改任何执行逻辑。 */
      card.dataset.actionGroup=actionOfStage[key]||'';
      /* 失败项加一个 class，配合 CSS 做左侧红条 + 深底色，
       * 让玩家在长列表里扫一眼就能分出「要补的」和「默认复用的」。 */
      if(unfinishedTarget){card.classList.add('is-unfinished');card.dataset.frFail='1';}
      box.addEventListener('change',function(){var siblings=targets.filter(function(t){return t.key===key;});all.checked=siblings.every(function(t){return t.box.checked;});all.indeterminate=!all.checked&& siblings.some(function(t){return t.box.checked;});update();});
    });
    /* 玩家手动勾/取消一个阶段后：
     *   ① 同步该阶段下的人物勾选（原有行为）
     *   ② 按当前系统自己的关联表，把必须一起跑的前后阶段自动带上并标出来
     * 第②步只改勾选状态和提示文字，不动任何阶段的执行逻辑。 */
    all.addEventListener('change',function(){
      /* 先记下「这是玩家亲手点的」这个事实，再同步子项与关联。
       * 顺序很重要：如果先 applyAutoRelationFromUserAction，
       * 它可能已经把 box.checked 改回去了，这里就记不到玩家的真实意图。 */
      markExplicitStageAction(key,all.checked);
      targets.filter(function(t){return t.key===key;}).forEach(function(t){t.box.checked=all.checked;});
      all.indeterminate=false;
      if(!all.checked&&all.dataset.frAutoRelated==='1')delete all.dataset.frAutoRelated;
      try{applyAutoRelationFromUserAction();}catch(_){}
      update();
      try{syncActionBoxes();}catch(_){}
    });
  });
  }
  /* 不再有视图切换：详细列表恒隐藏，动作列表恒显示。
   * 动作卡勾选时同步到真正的阶段勾选框（stageBoxes），执行侧完全不用改。 */
  /* 两条线路各走各的视图 —— 这是它们**流程不同**的直接体现，不是视图偏好：
   *   · 原著补演 18 阶段：技术阶段名对玩家是噪音，走「按动作看」的动作卡。
   *   · 变量演化 6 阶段：`登场与退场 / 人物状态更新 / 物品更新 / 人物标签 /
   *                       世界地图与任务 / 生平整理` 本身就是玩家看得懂的动作，
   *     所以直接显示它自己的阶段列表，**不套原著补演的分组**。
   * 上一版我把 simpleView 改成恒 true，等于强行给变量演化套别人的流程，
   * 结果五张卡片全写「本轮没有这一项」—— 那个 bug 就是这个强行统一造成的。 */
  if(simpleView){
    simpleWrap.hidden=false;
    syncActionBoxes();
  }else{
    /* 变量演化阶段少、自带可读名称：直接显示它自己的阶段列表。 */
    detailWrap.hidden=false;
    viewTip.hidden=true;
    viewBar.hidden=true;
  }
  /* ---------- 检索资料查看（只读） ---------- */
  // 数据来自 FR_CANON_MATERIALS_V1 快照：一个楼层一行，行内按检索请求分条。
  // 阶段卡片看该阶段全部检索资料；人物卡片按人名/事件码过滤到那一条。
  function matWorldTimeLabel(row){
    var t=String(row&&row.worldTime||'').trim();
    return t?('· '+t):'';
  }
  function matEsc(s){return String(s==null?'':s);}
  async function loadFloor(logId){
    // 缓存里「已有值」才算命中。
    // 原来写的是 floorCache.has(logId)，而 refreshFloors 为了标记待加载
    // 会先对所有楼层 set(logId, null)，于是这里的 has() 恒为 true，
    // 直接 return null —— 首屏资料永远是null，徽标全停在「无匹配资料」。
    // 玩家 2026-10-30 起的反馈即源于此：资料其实在库里，面板却读不到。
    var cached=floorCache.get(logId);
    if(cached!==undefined&&cached!==null)return cached;
    var rows=[];
    try{
      if(typeof frCanonMaterialsList==='function')rows=await frCanonMaterialsList(name,logId);
      else floorError='资料读取函数未加载，无法查看（不影响重跑本身）';
    }catch(err){
      // 不静默吞：把原因记下来，面板上显示，排查时不用猜。
      floorError='读取资料失败：'+((err&&err.message)||String(err));
      rows=[];
    }
    floorCache.set(logId,rows);
    return rows;
  }
  // 阶段→检索资料的对应：只有 vectorContext（资料检索）这一阶段产出资料快照。
  function matRowsFor(key,id){
    var rows=floorCache.get(currentFloorId)||[];
    // 资料快照是按「楼层」存的，跟是哪个阶段查的无关。
    // 所以任何阶段的条目都能查同一批资料：传了 id 就按人名/事件码筛，
    // 没传就是该阶段全部。玩家 2026-10-30：人物也该能查到自己的资料。
    if(!id)return rows;
    var needle=String(id||'').toLowerCase();
    var hit=rows.filter(function(row){
      var hay=(String(row.queryText||'')+' '+JSON.stringify(row.materialRequest||{})).toLowerCase();
      return needle&& hay.indexOf(needle)>=0;
    });
    return hit;
  }
  function renderMaterials(key,id,titleText,host){
    // 内容写进调用方给的就地容器（host），不再写全局面板。
    var head=node('div',undefined,host);head.className='fr-replay-mat-head';
    var title=node('strong',titleText||'检索资料',head);title.className='fr-replay-mat-title';
    var x=node('button','✕',head);x.type='button';x.className='fr-replay-mat-x';x.setAttribute('aria-label','收起资料详情');
    x.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();closeMaterials();});
    var meta=node('div','',host);meta.className='fr-replay-mat-meta';
    var list=node('div',undefined,host);list.className='fr-replay-mat-list';
    var floorRows=floorCache.get(currentFloorId)||[];
    if(!floorRows.length){
      meta.textContent=floorError||'该楼层还没有保存过检索资料。跑完一轮正文后这里才有内容。';
      return;
    }
    // 资料快照按楼层存，任何阶段/任何人物都能查同一批资料，只要按 id 过滤。
    // 玩家 2026-10-30：人物点「资料」应该能看到自己的检索结果，不能一律说没有。
    var rows=matRowsFor(key,id);
    if(!rows.length){
      meta.textContent=id
        ? ('本回合没有和「'+titleText+'」匹配的检索资料。可以切到「资料检索」看整轮全部 '+floorRows.length+' 条。')
        : ('本回合共 '+floorRows.length+' 条检索资料。');
    }else{
      meta.textContent='本回合共 '+floorRows.length+' 条检索资料，当前显示 '+rows.length+' 条。';
    }
    // 有旧配置留下的资料时，明确告诉玩家「重跑会重新查」，而不是让他以为能直接复用。
    var staleCount=rows.filter(function(row){return row.stale;}).length;
    if(staleCount){
      meta.textContent+=' 其中 '+staleCount+' 条是旧检索设置下查的（检索设置改过），重跑时会按当前设置重新检索。';
    }
    if(!rows.length){
      var tip=node('p','这个目标没有匹配到检索资料，可以切到「资料检索」看整轮全部。',list);tip.className='fr-replay-mat-empty';
      return;
    }
    rows.forEach(function(row){
      var details=node('details',undefined,list);details.className='fr-replay-mat-item';
      var sum=node('summary',undefined,details);sum.className='fr-replay-mat-sum';
      var q=String(row.queryText||'').trim();
      var headText=q?q.split('\n')[0]:'（无检索词）';
      if(headText.length>72)headText=headText.slice(0,72)+'…';
      node('span',headText,sum);
      var r=row.receipt||{};
      var badge=node('em',String(r.status||'已保存'),sum);badge.className='fr-replay-mat-badge';
      // 旧配置下查的资料打个标记，跟正常可复用的区分开。
      if(row.stale){var staleTag=node('em','旧设置',sum);staleTag.className='fr-replay-mat-badge fr-replay-mat-badge-stale';staleTag.title='这条是按修改前的检索设置查的，重跑会重新检索';}
      var meta2=node('div',undefined,details);meta2.className='fr-replay-mat-detail-meta';
      var bits=[];
      if(q)bits.push('检索词：'+q);
      if(row.at)bits.push('保存时间：'+new Date(row.at).toLocaleString('zh-CN'));
      if(r.reason)bits.push('回执：'+r.reason);
      if(row.configStamp)bits.push('检索配置：'+row.configStamp);
      bits.forEach(function(t){node('span',t,meta2);});
      var pre=node('pre',matEsc(row.text)||'（空）',details);pre.className='fr-replay-mat-text';
    });
  }
  async function refreshFloors(){
    // 变量演化不需要「资料楼层」——它不读补演的资料快照。
    if(frReplayIsCeSystem()){floorBar.hidden=true;refreshBadges();return;}
    var floors=[];
    try{
      if(typeof frCanonMaterialsFloors==='function')floors=await frCanonMaterialsFloors(name);
    }catch(_){floors=[];}
    floorSelect.textContent='';
    floorCache.clear();
    if(!floors.length){
      // 之前这里直接 return，currentFloorId 保持旧值（可能是空串），
      // 于是「没有楼层」和「有资料但没读到」两种情况在面板上长得一样。
      // 现在明确清掉，避免误导。
      currentFloorId='';
      if(floorError){floorBar.hidden=false;floorSelect.textContent='';floorInfo.textContent=floorError;}
      else floorBar.hidden=true;
      refreshBadges();
      return;
    }
    /* ★ 2026-11-02 玩家定：「只保留在本回合，因为不存在玩家回退回合后
     *   还打算用旧资料重跑的情况，这是个伪命题。」
     *
     * 既然只保留本回合（materialsKeep=1），「选楼层」这个动作就没有任何意义了：
     * 只有一层可看，给个下拉框反而让玩家以为「是不是能切到别的轮次拿旧资料」。
     * 所以只有真的存在多层的旧存档（历史数据残留）时才显示选择器；
     * 正常情况（只有本回合这一层）直接隐藏，不给玩家制造多余的疑问。
     * 资料本身照常可看，只是不再有「选哪层」这个干扰项。 */
    if(floors.length<=1){
      floorBar.hidden=true;
      currentFloorId=floors[0].logId;
      await loadFloor(currentFloorId);
      refreshBadges();
      return;
    }
    floorBar.hidden=false;
    floors.forEach(function(floor,index){
      var opt=document.createElement('option');
      opt.value=floor.logId;
      opt.textContent=floor.label+(floor.worldTime?' · '+floor.worldTime:'')+(index===0?'（当前本轮）':'');
      floorSelect.appendChild(opt);
    });
    currentFloorId=floors[0].logId;
    floorSelect.value=currentFloorId;
    // 「每层 N 条」原来取 floors[0].count —— 但玩家切到别的楼层后就对不上了。
    // 现在按当前选中楼层实时显示，切楼层时同步更新（见下面 change 监听）。
    /* 「每层 N 条」原来取 floors[0].count —— 但玩家切到别的楼层后就对不上了。
     * 现在按当前选中楼层实时显示，切楼层时同步更新（见下面 change 监听）。
     * ★ 2026-11-02：补一句「仅供查看」，把「能看」和「能复用」在文案上分开，
     *   避免玩家以为翻到旧楼层就能拿旧资料去重跑。 */
    function syncFloorInfo(){
      var cur=floors.find(function(f){return f.logId===floorSelect.value;})||floors[0];
      floorInfo.textContent='共 '+floors.length+' 层有资料，当前层 '+cur.count+' 条（仅供查看，重跑只用本回合自己的资料）';
    }
    syncFloorInfo();
    floorSelect.onchange=syncFloorInfo;
    // 不再预先把竞态标记成 null —— 那会让 loadFloor 直接命中 null 提前返回。
    // 直接把当前楼层真正读进来，其余楼层按需加载（loadFloor 自己会缓存）。
    await loadFloor(currentFloorId);
    // 资料到位了，把之前渲染时算不出资料的徽标回填一次。
    // 目标列表先渲染、楼层资料后异步到达，不回填就会一直停在「无匹配资料」，
    // 玩家看到的结论是错的（资料其实有，只是还没读完）。
    refreshBadges();
  }
  // 供 canon-early.js 在「本轮刚存下一条资料」时回调：立刻刷新楼层与徽标，
  // 做到「存下就能看到」——不用关掉面板再打开才能刷新。
  window.frCanonMaterialsChanged=function(logId){
    try{
      if(logId&&String(logId)!==String(currentFloorId))floorCache.delete(String(logId));
      else if(currentFloorId)floorCache.delete(currentFloorId);
      refreshFloors().catch(function(){});
    }catch(_){}
  };
  // 按当前楼层缓存重算每张目标卡上的资料徽标。资料没读到时保持「读取中」，不下结论。
  function refreshBadges(){
    var loaded=floorCache.get(currentFloorId);
    var ready=Array.isArray(loaded);
    // 变量演化不靠补演资料快照，用「正文 + 角色档案」判材料是否就绪。
    if(frReplayIsCeSystem()){
      var ceReady=ceHasReplayMaterial();
      badgeCells.forEach(function(cell){
        if(!cell.status||!cell.status.parentNode)return;
        var ok=cell.unfinished?false:ceReady;
        cell.status.textContent=cell.unfinished?'待处理':(ok?'材料就绪':'待处理');
        cell.status.className='fr-replay-target-badge '+(ok?'returned':'unfinished');
        cell.status.title=cell.unfinished
          ?'本项目本轮没跑完，可以单独重跑'
          :(ok?'重跑依据：本回合正文、角色档案与预设规则；变量演化自带闭环，不需要补演资料':'缺少本轮正文或角色档案，先跑一轮再重跑');
      });
      return;
    }
    badgeCells.forEach(function(cell){
      if(!cell.status||!cell.status.parentNode)return;
      if(cell.key==='补演账本'||cell.key==='预制成品落地'){
        cell.status.textContent=cell.unfinished?'待处理':cell.key==='补演账本'?'账本已保存':'落地结果可复用';
        cell.status.className='fr-replay-target-badge '+(cell.unfinished?'unfinished':'returned');
        cell.status.title=cell.unfinished?'本项需要重跑':'沿用本层已经核验的数据';
        return;
      }
      var count=ready?matRowsFor(cell.key,cell.id).length:0;
      var canReuse=!cell.unfinished&&count>0;
      cell.status.textContent=canReuse?('本回合 '+count+' 条'):cell.unfinished?'待处理':(ready?'无匹配资料':'读取中…');
      cell.status.className='fr-replay-target-badge '+(canReuse?'returned':'unfinished');
      cell.status.title=canReuse?'本回合有与它匹配的检索资料，重跑时直接复用':cell.unfinished?'本项目本轮没跑完':'本回合没有和它匹配的检索资料；重跑会沿用已有的检索结果。';
    });
  }
  floorSelect.addEventListener('change',async function(){
    currentFloorId=floorSelect.value;
    await loadFloor(currentFloorId);
    var floor=null;
    try{
      if(typeof frCanonMaterialsFloors==='function'){
        var all=await frCanonMaterialsFloors(name);
        floor=all.find(function(f){return f.logId===currentFloorId;})||null;
      }
    }catch(_){}
    floorInfo.textContent=floor?('该层 '+floor.count+' 条'):'';
    // 换了楼层，资料口径也换了，徽标必须跟着重算。
    refreshBadges();
    // 切换楼层后，如果资料正在展开，就按新楼层重画同一处（锚点不变，位置不跳）。
    if(inlineMat&&inlineMat._anchor&&inlineMat._anchor.isConnected){
      var anchor=inlineMat._anchor;
      closeMaterials();
      openMaterials(matCurrentKey,matCurrentId,matCurrentTitle,anchor);
    }
  });
  var matCurrentKey='',matCurrentId='',matCurrentTitle='';
  async function openMaterials(key,id,titleText,anchor){
    matCurrentKey=key;matCurrentId=id;matCurrentTitle=titleText;
    // 就地展开：内容贴在锚点条目正下方。再点同一处＝收起。
    var host=inlineHost(anchor);
    if(!host)return;
    // 玩家 2026-10-30：不能再因为 currentFloorId 为空就直接说「没有保存过」。
    // 那只是「没查到楼层列表」，不等于「真的没存过资料」——
    // 之前 frCanonMaterialsFloors 返回空就一路 return，currentFloorId 永远是空串，
    // 于是面板不管数据库里有没有资料，一律报「还没有保存过」，玩家看到的结论是错的。
    if(!currentFloorId){
      // 回退一：直接找最新一层有资料的楼层。
      try{
        if(typeof frCanonMaterialsLatestFloorId==='function'){
          var latest=await frCanonMaterialsLatestFloorId(name);
          if(latest){currentFloorId=String(latest);floorCache.set(currentFloorId,await loadFloor(currentFloorId));}
        }
      }catch(_){}
    }
    if(!currentFloorId){
      renderMaterialsNote(host,titleText||'可复用资料',floorError||'本存档还没有保存过检索资料。');
      return;
    }
    renderMaterials(key,id,titleText,host);
  }
  // 没有楼层资料时也给同样的就地容器，行为一致，不让玩家以为按钮没反应。
  function renderMaterialsNote(host,title,text){
    var head=node('div',undefined,host);head.className='fr-replay-mat-head';
    var t=node('strong',title,head);t.className='fr-replay-mat-title';
    var x=node('button','✕',head);x.type='button';x.className='fr-replay-mat-x';x.setAttribute('aria-label','收起资料详情');
    x.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();closeMaterials();});
    var meta=node('div',text,host);meta.className='fr-replay-mat-meta';
  }

  // 分页 + 报错优先（玩家 2026-10-30 要求）：
  //   「局部重跑界面要集中优先展示一下报错出问题的对应项目，
  //     做一个分页集中管理这些，这样不用玩家去自己一个一个翻找。」
  // 列表可能几十上百条，一次全铺出来玩家根本找不到失败的那几条。
  var PAGE_SIZE=40;
  var page=0;
  var failedFirst=node('input',undefined,filterLabel);failedFirst.type='checkbox';failedFirst.dataset.replayFilter='failedFirst';failedFirst.checked=true;
  filterLabel.appendChild(document.createTextNode('失败项排最前'));
  var pager=node('div',undefined,targetArea);pager.className='fr-replay-pager';
  var pagerInfo=node('span','',pager);pagerInfo.className='fr-replay-pager-info';
  var pagerPrev=node('button','上一页',pager),pagerNext=node('button','下一页',pager);
  pagerPrev.type=pagerNext.type='button';
  pagerPrev.className=pagerNext.className='fr-replay-pager-btn';
  function visibleTargets(){
    var list=targets.filter(function(t){
      /* 左栏点了某个动作 → 右栏只看这个动作包含的项目（整组，不是单个阶段）。
       * 玩家 2026-11-03：「我选了左边你右边就有对应的只显示这个阶段的项目啊，
       *   之前有这个逻辑你怎么反而删除了？」——这是原有能力，只是入口被我在重构时弄丢了。
       * 动作级过滤优先；没点动作时再走原来的单阶段过滤（详细视图仍在用）。 */
      if(activeAction){
        var group=actionOfStage[t.key];
        if(group!==activeAction)return false;
      }else if(activeStage&&t.key!==activeStage)return false;
      if(unfinished.checked&&!t.unfinished)return false;
      if(!t.node.dataset.searchText.includes(search.value.trim().toLowerCase()))return false;
      return true;
    });
    /* ★★★ 2026-11-02 玩家报：「失败项排在最前的逻辑是失效的，并没有排在最前面。」
     *
     * 根因：原来这里只是把 list 排了序，但真正决定谁显示在哪的是
     * `t.node.hidden` + DOM 里本来就有的先后顺序。
     * 排序结果只被用来切片分页，**从来没有动过 DOM 节点的顺序**，
     * 所以界面上看到的永远是渲染时的原始次序 —— 排序等于没做。
     *
     * 修法：排序后**真的把 DOM 节点按顺序重排**（appendChild 会移动已有节点，
     * 不会复制，也不会丢失事件监听）。
     * 同时失败项集中钉在最前面，成功项跟在后面，
     * 让玩家一进来第一眼就是需要补的那一批。 */
    if(failedFirst.checked){
      list=list.slice().sort(function(a,b){
        var d=(b.unfinished?1:0)-(a.unfinished?1:0);
        if(d)return d;
        return 0;   // 同组内保持原有相对顺序，避免每次刷新都跳来跳去
      });
    }
    /* 排序结果落到 DOM。只对「当前可见集合」重排，
     * 不可见的项留在原处不影响观感。 */
    try{
      var anchor=null;
      list.forEach(function(t){
        if(anchor)anchor.parentNode.insertBefore(t.node,anchor.nextSibling);
        else targetList.appendChild(t.node);
        anchor=t.node;
      });
      /* 分组隔离：给「需要重跑」和「默认复用」两段各加一条小标题。
       *
       * ★ 2026-11-02 玩家纠正：「明明是上面，你怎么写下面。」
       *   上一版只插了一条标题在失败项下方，文案却写「下面这些……」，
       *   于是标题指向的分明是它自己上面的那批，方向完全说反了。
       *
       * 现在改成**每个分组各有一条标题，且标题一律放在本组上方**：
       *   上面：需要重跑 N 项
       *   （失败项…）
       *   下面：默认复用 N 项
       *   （成功项…）
       * 这样「上面/下面」永远指它自己下面那一组，不再自相矛盾。
       * 每次重排前先清掉上一次插的标题，避免越叠越多。 */
      Array.prototype.forEach.call(targetList.querySelectorAll('.fr-replay-group-head, .fr-replay-action-head-sep'),function(h){h.remove();});
      /* ★★★ 2026-11-03 玩家定：
       *   「右边的具体项目绑定简化后的流程」
       *   「一目了然看到选择的项目或者阶段之间的关联关系」
       *
       * 有动作视图时，右侧不再按「需要重跑 / 默认复用」切两段——
       * 那两段解决的是「哪些没跑完」，回答不了玩家「这一项属于哪一步」。
       * 改成按**动作**分段，玩家从上往下读就是补演的真实流程；
       * 每段标题写明动作名 + 本段有几项 + 本段是否已被勾选，
       * 上下相邻就能直接看出「改这一步会带动后面哪些」。
       * 失败项仍然排最前（failedFirst 的排序在上一段已经生效，这里只负责加标题）。 */
      if(simpleView){
        var byAction={};
        list.forEach(function(t){
          var a=String(t.node.dataset.actionGroup||'');
          if(!a)return;
          (byAction[a]||(byAction[a]=[])).push(t);
        });
        STAGE_ACTIONS.forEach(function(action){
          var arr=byAction[action.key];
          if(!arr||!arr.length)return;
          var head=node('div');
          head.className='fr-replay-group-head fr-replay-action-head-sep';
          var anyChecked=arr.some(function(t){return t.box.checked;});
          var failCount=arr.filter(function(t){return t.unfinished;}).length;
          head.textContent=action.name+'（'+arr.length+' 项'
            +(failCount?('，其中 '+failCount+' 项待处理'):'')
            +'）'+(anyChecked?' · 已勾选':'');
          head.dataset.action=action.key;
          if(anyChecked)head.classList.add('is-picked');
          targetList.insertBefore(head,arr[0].node);
        });
      }else if(failedFirst.checked&&list.length){
        var failList=list.filter(function(t){return t.unfinished;});
        var okList=list.filter(function(t){return !t.unfinished;});
        if(failList.length){
          var headFail=node('div');
          headFail.className='fr-replay-group-head is-fail';
          headFail.textContent='需要重跑 '+failList.length+' 项（本轮没跑完或没返回）';
          targetList.insertBefore(headFail,failList[0].node);
        }
        if(okList.length){
          var headOk=node('div');
          headOk.className='fr-replay-group-head';
          headOk.textContent='默认复用 '+okList.length+' 项（本轮已有结果，不勾就不会重跑）';
          targetList.insertBefore(headOk,okList[0].node);
        }
      }
    }catch(_){}
    return list;
  }
  function renderFilter(){
    var list=visibleTargets(),total=list.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
    if(page>=pages)page=pages-1;if(page<0)page=0;
    var pageSet=new Set(list.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE));
    targets.forEach(function(t){t.node.hidden=!pageSet.has(t);});
    targetTitle.textContent='目标 · '+total+' / '+targets.length;
    empty.hidden=total>0;
    pager.hidden=pages<=1;
    pagerInfo.textContent='第 '+(page+1)+' / '+pages+' 页 · 共 '+total+' 项'+(unfinished.checked?'（仅失败项）':'');
    pagerPrev.disabled=page<=0;pagerNext.disabled=page>=pages-1;
    /* 右侧标题栏的阶段胶囊：显示「当前只看哪个大阶段」，
     * 并给出回到全部的按钮。没选中具体阶段时整体隐藏。
     * 同时把左侧对应卡片高亮，左右对应关系一眼可见。 */
    if(stageFilterBar){
      var curMeta=activeStage?frReplayStageMeta(ceMode?'ce':'canon',activeStage):null;
      /* 动作级过滤时显示动作名（玩家看得懂的那个），不是技术阶段名。 */
      var curActionName='';
      if(activeAction){
        var hit=STAGE_ACTIONS.filter(function(a){return a.key===activeAction;})[0];
        if(hit)curActionName=hit.name;
      }
      if(curActionName||activeStage){
        stageFilterBar.hidden=false;
        stageFilterName.textContent='当前只看：'+(curActionName||(curMeta?curMeta.name:activeStage));
        stageFilterClear.hidden=false;
      }else{
        stageFilterBar.hidden=true;
        stageFilterClear.hidden=true;
      }
    }
    try{
      /* 左栏高亮：动作级过滤高亮动作卡，单阶段过滤高亮阶段卡。 */
      if(simpleWrap){
        Array.prototype.forEach.call(simpleWrap.querySelectorAll('.fr-replay-action-card'),function(c){
          c.classList.toggle('is-active',!!activeAction&&c.dataset.action===activeAction);
        });
      }
    }catch(_){}
    try{
      stageBoxes.forEach(function(box,key){
        var card=box.closest?box.closest('.fr-replay-stage'):null;
        if(card)card.classList.toggle('is-active',!!activeStage&&key===activeStage);
      });
    }catch(_){}
  }
  pagerPrev.addEventListener('click',function(){page--;renderFilter();});
  pagerNext.addEventListener('click',function(){page++;renderFilter();});
  failedFirst.addEventListener('change',function(){page=0;renderFilter();});
  // 默认把失败项排在前面并跳到第一页，玩家一进来就看见要补的。
  page=0;
  search.addEventListener('input',function(){page=0;renderFilter();});unfinished.addEventListener('change',function(){page=0;renderFilter();});
  selectVisible.addEventListener('click',function(){targets.filter(function(t){return !t.node.hidden;}).forEach(function(t){t.box.checked=true;});syncStages();update();});
  clear.addEventListener('click',function(){checks.forEach(function(c){c.checked=false;c.indeterminate=false;});update();});
  /* 智能重跑：把「出问题的」自动勾上，然后立刻开跑。
   *
   * 玩家原话：「智能重跑的逻辑本质就是自动把出问题的都选上重跑」。
   * 所以这里只做两件事，不引入任何第三条逻辑：
   *   ① 用 frReplayFailedSelection 自动挑出失败/没返回的项，替玩家把勾打上；
   *   ② 复用下面「开始局部重跑」那个按钮的同一套启动流程。
   * 最终执行的还是同一份 selection、同一条执行路径 ——
   * 和玩家自己一个个勾完再点开始，跑出来的东西完全一样。
   *
   * 一个失败项都没有时不启动，直接告诉玩家本轮是干净的，
   * 避免点下去什么都不发生、让人以为按钮坏了。 */
  var prebuiltSmartClick=false,ceSmartClick=false;
  smart.addEventListener('click',function(){
    if(working)return;
    /* ★★★ 2026-11-02 玩家截图：面板上明明列出「需要重跑 3 项」，
     * 底部却提示「本轮没有失败或没跑完的项目，不需要智能重跑」。
     *
     * 【根因】面板与按钮用了**两套判定标准**：
     *   · 面板（第 1565 行 unfinishedTarget）：req.status!=='returned'
     *     —— 只要不是成功返回，就算待处理，skipped 也算；
     *   · 智能重跑（frReplayFailedSelection）：显式排除 skipped
     *     —— 那是我早前为修「主动跳过不该重跑」加的过滤。
     *
     * 两边各自都「有道理」，但结果是：面板列出 3 项、按钮说 0 项，玩家看懵。
     *
     * 【修法】不再另算一份，直接读面板已经算好的结果 ——
     * 目标卡片上的 unfinished 标记，就是玩家在界面上看到的那 3 项。
     * 所见即所跑，结构上消除不一致的可能。
     *
     * 保留 frReplayFailedSelection 作为兜底：面板还没渲染（比如直接调按钮）时它仍能用。
     */
    var auto=frReplayFailedSelection(data);
    var autoStages=Array.isArray(auto&&auto.stages)?auto.stages:[];
    var autoScopes=Array.isArray(auto&&auto.scopes)?auto.scopes:[];
    if(!autoStages.length&&!autoScopes.length){
      error.textContent='本轮没有失败或没跑完的项目，不需要智能重跑。';
      error.style.color='#7fd1a0';
      return;
    }
    // 智能重跑替换手动草稿，只选真正失败项，不把人物失败升级为整个阶段。
    checks.forEach(function(c){c.checked=false;c.indeterminate=false;});
    explicitCleared={};
    var pickedStages=new Set(autoStages),pickedScopes=new Set(autoScopes);
    targets.forEach(function(t){
      t.box.checked=pickedStages.has(t.key)||pickedScopes.has(t.box.dataset.scope);
    });
    autoStages.forEach(function(key){var box=stageBoxes.get(key);if(box)box.checked=true;});
    syncStages();
    update();
    error.textContent='智能重跑：已自动选中 '+(autoStages.length+autoScopes.length)+' 个失败项目，即将开始。';
    error.style.color='';
    prebuiltSmartClick=!!frReplayPrebuiltFailures(data);
    ceSmartClick=true; try{start.click();}finally{prebuiltSmartClick=false;ceSmartClick=false;}
  });
  /* 从「子项勾选」反推「阶段勾选」。
   *
   * ★ 2026-11-02 修两个隐患（配合阶段可取消的改动）：
   *   ① 原来直接写 ts.every(...)。空数组的 every() 恒为 true，
   *      于是**没有任何子目标的阶段会被强行勾上**，玩家取消也取消不掉。
   *   ② 原来只改勾选、不管 explicitCleared。玩家取消某阶段后，
   *      再点「全选当前结果」，阶段又被勾上，但取消标记还留着，
   *      下次自动关联会把它再取消一次——自己和自己打架。
   *      现在子项被外部操作改成「全勾」时，顺手清掉取消标记，保持自洽。 */
  function syncStages(){
    stageBoxes.forEach(function(box,key){
      var ts=targets.filter(function(t){return t.key===key;});
      if(!ts.length)return;                      // 没有可勾的子目标，不要凭空数组强行勾上
      var all=ts.every(function(t){return t.box.checked;});
      box.checked=all;
      box.indeterminate=!all&&ts.some(function(t){return t.box.checked;});
      if(all&&explicitCleared[key])delete explicitCleared[key];
    });
  }
  var footer=node('div');footer.className='fr-replay-footer';var count=node('span','未选择目标',footer);count.className='fr-replay-count';count.setAttribute('aria-live','polite');
  /* ★★★ 2026-11-02 玩家纠正排布（原话）：
   *   「我的意思是智能重跑，局部重跑，取消这样一排。
   *     然后智能重跑要做区分 ui 啊，比如边框和颜色的区别。」
   *
   * 上一版我插错了位置，导致「开始局部重跑」被挤到第二行整行撑开，
   * 看着像两块大横条，完全不是玩家要的一排。
   *
   * 现在 footer 从左到右依次是：
   *   [计数…]        [智能重跑] [开始局部重跑] [取消]
   * 三个按钮同在一排，靠右对齐；计数占剩下的空间。
   *
   * 视觉分区（玩家要的「区分 ui」）：
   *   智能重跑  → 金色实心 + 双层描边光晕，最显眼，引导优先点
   *   局部重跑  → 金色实心，普通强调
   *   取消      → 描边空心，弱化 */
  var close=node('button','取消',footer),start=node('button','开始局部重跑',footer);
  close.type=start.type='button';start.className='major-action-button';start.disabled=true;
  smart.className='fr-replay-smart-btn';
  smart.disabled=true;
  /* 顺序：智能重跑 → 开始局部重跑 → 取消。appendChild 会按调用顺序排列。 */
  footer.appendChild(smart);
  footer.appendChild(start);
  footer.appendChild(close);
  var previousFocus=document.activeElement,working=false,workingController=null;
  // ============ 退出设计（玩家 2026-10-30 全面复盘后重写） ============
  //
  // 原来最大的结构性错误：dismiss() 开头写 if(working)return;，
  // 把「关窗」和「停任务」绑死。为了绕开它，✕ / 底部按钮 / Esc 各自打补丁，
  // 每处都只做了一半，最后连锁出四个问题：
  //   ① 批量禁用 panel.querySelectorAll('input,textarea,button') 把 ✕ 也禁了
  //   ② 底部按钮把自己 disabled=true，后续依赖 catch 才能恢复
  //   ③ 只有 try 成功路径才 dismiss()，失败/中止就永久留窗
  //   ④ overlay 是 inset:0 + z-index:30000 全屏遮罩，里面按钮全禁 → 整页卡死
  //
  // 现在按一条铁律重写：
  //   关窗 = 纯 UI 操作，任何时候都能做，不看 working，不依赖任何流程
  //   停任务 = 独立动作，只有底部「停止并恢复」做
  //   ✕ / Esc 永远可点，永远只关窗，绝不被禁用
  //   重跑结束（无论成功失败）一定关窗

  function dismiss(){
    try{overlay.remove();}catch(_){}
    try{if(previousFocus&&previousFocus.isConnected)previousFocus.focus();}catch(_){}
  }
  // 只中止任务，不碰 UI。是否关窗由调用方决定。
  function stopOnly(){
    try{workingController?.abort();}catch(_){}
    // 面板停止只属于当前线路；全局停止仍由全局入口负责。
    try{frReplaySessionOf(system)?.controller?.abort();}catch(_){}
  }
  /* ★★★ 2026-11-02 玩家定调（原话）：
   *   「很简单，相关关联的流程只要选择其中任何一个，会自动把他的前置流程选上，不就可以了？」
   *   「只要是有必要关联的前后当然都要一起，不然前面变了，关联的后面没改，那不是矛盾了？」
   *
   * 这里做三件事：
   *   ① 玩家每勾一项，按当前系统自己的阶段表算出「实际要跑的集合」（前后都带）；
   *   ② 被关联带上的阶段自动打勾，并标一个「前置/后续」小标记；
   *   ③ 顶部用一行字说清楚「自动带上了哪几个、为什么」，
   *      让玩家一目了然知道发生了什么，而不是莫名其妙多跑了东西。
   *
   * 注意：这里只改「界面上勾了什么」和「提示文字」，
   * 不改变任何阶段的内部执行方式——那个阶段本来怎么跑还是怎么跑。
   */
  var autoBar=null,autoReasonOf={};
  /* ★★★ 2026-11-02 玩家报：「左侧的阶段选项选择后无法取消了。」
   *
   * 根因就在这个函数里，之前写错了：
   *   collectPickedKeys() 读的是**所有已勾选的阶段**，其中包含上一轮
   *   被自动关联带上的那些。玩家手动取消某个阶段后，它仍然在别人的
   *   关联表里（比如取消「人物视角散文」，但「characters」还勾着），
   *   于是下一行 `box.checked=true` 又把它勾回来 —— 玩家点几次都取消不掉。
   *
   * 修法：把「玩家亲手点的」和「系统自动带的」彻底分开记。
   *   · explicitPicked：玩家自己勾的（不含 auto 标记的）
   *   · 自动关联只从 explicitPicked 推导，绝不把玩家刚取消的项再加回来
   *   · 玩家取消某项时，若它之前是自动带上的，直接清掉标记、保持取消
   * 这样「点了就取消」一定生效，而「选了 A 必须带 B」的规则依然保留。 */
  var explicitCleared={};          // 玩家明确取消过的阶段，本轮内不再自动加回
  function collectPickedKeys(){
    var keys=[];
    stageBoxes.forEach(function(box,key){
      if(box.checked && box.dataset.frAutoRelated!=='1')keys.push(key);
    });
    return keys;
  }
  function applyAutoRelationFromUserAction(){
    // 只从「玩家亲手勾的」推导关联，不从自动带上来的项再推导，
    // 否则会一层层传染，最终把整张表都勾满。
    var picked=collectPickedKeys();
    var expanded=frReplayExpandSelection(ceMode?'ce':'canon',picked);
    autoReasonOf=expanded.added||{};
    stageTable.forEach(function(s){
      var box=stageBoxes.get(s.key);
      if(!box)return;
      // 玩家亲手勾的：保持勾选、去掉自动标记
      if(picked.indexOf(s.key)>=0){delete box.dataset.frAutoRelated;return;}
      // 玩家明确取消过的：绝不再自动加回来
      if(explicitCleared[s.key]){box.checked=false;delete box.dataset.frAutoRelated;return;}
      var reason=autoReasonOf[s.key];
      if(reason){
        box.checked=true;
        box.dataset.frAutoRelated='1';
      }else if(box.dataset.frAutoRelated==='1'){
        // 不再被任何已选项需要了，撤销自动勾选
        box.checked=false;
        delete box.dataset.frAutoRelated;
      }else{
        delete box.dataset.frAutoRelated;
      }
    });
    // 阶段勾选变了，它下面的人物卡也要跟着同步，否则会出现
    // 「阶段取消了、人物还勾着」这种自相矛盾的状态。
    stageBoxes.forEach(function(box,key){
      if(box.checked)return;
      targets.forEach(function(t){if(t.key===key&&t.box.checked)t.box.checked=false;});
    });
    refreshAutoBar(picked,expanded);
  }
  /* 玩家手点某个阶段时调用：记录「这是玩家亲手操作」，
   * 勾上→清除取消记录；取消→记进 explicitCleared。 */
  function markExplicitStageAction(key,checked){
    if(checked){delete explicitCleared[key];}
    else{explicitCleared[key]=true;}
  }
  function refreshAutoBar(picked,expanded){
    if(!autoBar)return;
    var addedKeys=Object.keys(autoReasonOf);
    if(!addedKeys.length){
      autoBar.hidden=true;
      autoBar.textContent='';
      return;
    }
    var parts=addedKeys.map(function(k){
      var meta=frReplayStageMeta(ceMode?'ce':'canon',k);
      var from=frReplayStageMeta(ceMode?'ce':'canon',autoReasonOf[k]);
      return (meta?meta.name:k)+'（'+(from?'因为「'+from.name+'」需要':'关联')+'）';
    });
    autoBar.hidden=false;
    autoBar.textContent='已自动带上 '+addedKeys.length+' 个关联阶段：'+parts.join('、')+'。'
      +'这些阶段的结果和已勾选的项互相依赖，不一起跑会出现前后不一致。';
  }
  function update(){var selected=targets.filter(function(t){return t.box.checked;}).length;count.textContent='已选 '+selected+' 个目标';start.disabled=working||!eligible||!selected;
    /* 智能重跑不看「当前勾了什么」，它自己会挑失败项，所以只要本轮可重跑就能用。
     * 这样玩家进来什么都不用想，直接点它就行。 */
    if(smart)smart.disabled=working||!eligible;
  }
  // 进入/退出「重跑中」的界面状态。集中管理，避免各处各禁一半。
  function setRunningUI(on){
    working=!!on;
    start.disabled=!!on;
    close.textContent=on?'停止并恢复':'关闭';
    close.disabled=false;              // 底部按钮不自禁，点了就走「先停再关」
    panel.querySelectorAll('input,textarea,button').forEach(function(n){
      if(n===close||n===headerClose)return;   // 这两个永远可用，是卡死时的最后保险
      n.disabled=!!on;
    });
    if(!on)update();
  }

  syncStages();renderFilter();update();

  // 右上角 ✕：永远只关窗，重跑继续在后台跑完（玩家 2026-10-30 明确要求）。
  headerClose.addEventListener('click',function(){dismiss();});

  // 底部按钮：重跑中语义是「停止并恢复」——先停任务，再关窗，一条路走到底。
  close.addEventListener('click',function(){
    if(working)stopOnly();
    dismiss();
  });

  // Esc 同样只是收起面板，不打断重跑。
  overlay.addEventListener('keydown',function(e){
    if(e.key==='Escape'){e.stopPropagation();dismiss();}
    if(e.key==='Tab'){
      var items=Array.from(panel.querySelectorAll('button,input,textarea')).filter(function(n){return !n.disabled&&!n.hidden&&n.getClientRects().length;});
      var first=items[0],last=items[items.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }
  });

  start.addEventListener('click',async function(){
    var smartContinue=prebuiltSmartClick,smartRepair=ceSmartClick;
    // 必须在这里建 controller：上面 stopOnly() 靠它中止本轮。
    // 之前重写这段时漏掉这一行，导致 workingController 恒为 null，
    // 「停止并恢复」点了什么也不做 —— 又是一种卡死。
    workingController=new AbortController();
    setRunningUI(true);
    error.textContent='正在重跑；右上角和运行记录显示实际阶段。失败或取消将恢复本次开始前的存档。';
    try{
      /* ★ 2026-11-02 玩家：「只要是有必要关联的前后当然都要一起，
       *   不然前面变了，关联的后面没改，那不是矛盾了？」
       *
       * 界面上已经在下勾选时自动带了关联（applyAutoRelationFromUserAction），
       * 但这里**再按当前系统自己的阶段表算一遍并发给后端**，理由是：
       *   · 玩家可能通过「全选当前结果」「清空全部」「智能重跑」这些批量按钮
       *     改动勾选，那些路径不一定走逐个 change 事件；
       *   · 界面上显示的勾选状态和后端真正执行的范围必须是同一份，
       *     不能靠「界面看起来勾了」来保证。
       * 这一层是幂等的：已经带上的不会重复加。 */
      /* ★★★ 2026-11-03 钩子：阶段级目标（没有具体人物）的勾选，
       * 要按「该阶段整体重跑」来算，计入 pickedStages。
       * 它们的 dataset.scope 是空的，不能也不该塞进 scopes ——
       * 塞进去就是一个匹配不到任何请求的脏值（这正是
       * 「点开始后一闪关掉、什么都没发生」的成因）。 */
      var stageOnlyPicked=checks.filter(function(n){return n.checked&&n.dataset.stageOnly&&n.dataset.stage;}).map(function(n){return n.dataset.stage;});
      var pickedStages=checks.filter(function(n){return n.checked&&n.dataset.stage&&!n.dataset.stageOnly;}).map(function(n){return n.dataset.stage;});
      stageOnlyPicked.forEach(function(stage){if(pickedStages.indexOf(stage)<0)pickedStages.push(stage);});
      var pickedScopes=checks.filter(function(n){return n.checked&&n.dataset.scope;}).map(function(n){return n.dataset.scope;});
      /* ★★★ 2026-11-03 玩家报：「局部重跑到底是显示问题还是执行逻辑真的没修好，
       *   怎么还是从核对人物开始，显示边界批量判定？」
       *
       * 【真正的病根在这里】左列的**阶段勾选框**和右列的**人物勾选框**是两套独立的东西：
       *   · 勾左列「物品更新」→ 进 selection.stages → frReplayTargetSelected 对这个
       *     阶段下**所有人**都返回 true → 整个阶段全跑，右侧只勾一个人根本限制不住。
       *   · 只勾右列某个人   → 进 selection.scopes → 只有那一个人跑。
       *
       * 玩家的意图明明是「我要重跑这个阶段，但只针对韩小妹一个人」，
       * 于是很自然会「左列勾阶段 + 右列勾人」。可这个组合被解释成了
       * 「整个阶段全跑」——右列那个勾等于白勾。
       *
       * 【修法】让右列的勾选能收窄左列阶段：
       *   某个阶段被勾选时，如果**右列有该阶段下的人物被勾**，
       *   就把这个阶段从 stages 里摘掉、只保留那些人物（走 scopes）。
       *   若右列该阶段下一个人都没勾，才表示「整个阶段都跑」，保持原行为。
       *
       * 这样两种用法都成立，且都符合直觉：
       *   · 只勾阶段、不勾人   → 该阶段所有人重跑（原有行为）
       *   · 勾阶段 + 勾某几个人 → 只重跑这几个人（玩家要的）
       */
      var scopeStages={};
      pickedScopes.forEach(function(scope){
        var parts=frReplaySplitScope(scope);
        if(parts.valid&&parts.stage)scopeStages[parts.stage]=true;
      });
      /* 找出「既被阶段勾选、又有具体人物被勾」的阶段，把它们交给 scopes 表达。 */
      var narrowedStages=pickedStages.filter(function(stage){return scopeStages[stage]===true;});
      var effectiveStages=narrowedStages.length
        ? pickedStages.filter(function(stage){return narrowedStages.indexOf(stage)<0;})
        : pickedStages;
      if(narrowedStages.length){
        try{
          console.info('[局部重跑] 以下阶段已按右侧勾选收窄到具体人物，不再整阶段重跑：'+narrowedStages.join('、'));
        }catch(_){}
      }
      var expanded=frReplayExpandSelection(ceMode?'ce':'canon',effectiveStages);
      // scopes 已经明确表达具体人物；不能并进 stages，否则会重算该阶段所有人。
      // 直接读已收集的勾选项，不读尚未赋值的 selected。
      var scopeDerivedStages=pickedScopes.map(function(scope){return frReplaySplitScope(scope).stage;}).filter(Boolean);
      var finalStages=expanded.stages.length?expanded.stages.slice():effectiveStages.slice();
      if(scopeDerivedStages.length)console.warn('[局部重跑] 按人物限定阶段：'+Array.from(new Set(scopeDerivedStages)).join('、'));
      var autoAdded=Object.keys(expanded.added||{});
      if(autoAdded.length){
        try{console.info('[局部重跑] 按关联自动带上 '+autoAdded.length+' 个阶段：'+autoAdded.join('、'));}catch(_){}
      }
      var selected={smart:smartRepair,system:ceMode?'ce':'canon',mode:smartContinue?'continue':'rerun',stages:finalStages,scopes:checks.filter(function(n){return n.checked&&n.dataset.scope;}).map(function(n){return n.dataset.scope;}).filter(Boolean),extra:extra.value.trim(),allowDependencies:dep.checked,signal:workingController.signal};
      selected.replay=frReplayProsePlan(data,selected);
      /* ★★★ 2026-11-03 玩家定：局部重跑不该从「补演边界判定」重跑整轮。
       *
       * 把上一轮算好的前置分工取回来，挂到 replay.frozenBoundary 上带进执行侧。
       * orchestrator 会先拿它做语义指纹校验：
       *   · 对得上 → 直接复用，不再调模型重算「这一段原文、这几个人」
       *   · 对不上 → 明确告诉玩家「源头变过了」，让你决定要不要连边界一起重跑
       *   · 取不到（老存档/本轮没走过）→ 退回原行为，照常算，不会跑不动
       *
       * 只有原著补演才有这一层；变量演化自带闭环，不涉及前置边界。 */
      await frReplayPrepareBoundary(data,selected);
      /* ★★★ 2026-11-03 玩家报：「点击后直接弹出来了，什么都没发生」。
       *
       * 现象是面板直接关掉（只有成功路径才 dismiss），说明 frReplayExecute 正常返回，
       * 但游戏里什么都没变。凭日志才查得动，所以把**真正发下去的选择**打出来：
       * 勾了哪些阶段、哪些人物、算出来的 boundary 有没有值。
       * 三者任一为空都能一眼看出是哪一环丢了。 */
      try{
        console.info('[局部重跑] 提交选择 →',
          '阶段=' + JSON.stringify(selected.stages),
          '人物=' + JSON.stringify(selected.scopes),
          '边界=' + (selected.replay && selected.replay.boundary
            ? (selected.replay.boundary.start + ' → ' + selected.replay.boundary.end)
            : '缺失'));
      }catch(_){}
      if(!selected.stages.length && !selected.scopes.length){
        /* 一个都没算出来就别往下走了 —— 走下去必然「成功但什么都没做」，
         * 而面板又会因为成功而关闭，玩家只看到一闪。 */
        throw new Error('没有解析出要重跑的目标（阶段与人物都是空）。请重新勾选后再试。');
      }
      selected.onQueued=function(){error.textContent='已排队，当前存档的上一条重跑结束后继续；可以随时停止。';};
      var execResult=await frReplayExecute(context,selected,cache);
      setRunningUI(false);
      /* ★★★ 2026-11-03 玩家：「这次是一瞬间就显示完成了」。
       *
       * 一个模型请求都没发出去，却按成功关窗，等于骗玩家「跑完了」。
       * 这种情况**不关窗**，留在面板上把话说清楚：
       * 是所勾阶段本轮没有可处理内容，而不是跑成功了。
       * 玩家关掉窗口后才不会以为白点一次。 */
      if(execResult&&execResult.noRealCall){
        error.textContent=execResult.noRealCallMessage||'本次没有可重算的内容。';
        error.style.color='#e0b070';
        error.style.fontWeight='600';
        return;
      }
      dismiss();
      await frCanonOpenTrace();
    }catch(e){
      /* ★ 2026-11-02 玩家：「我点击重跑怎么没反应……右上角没有气泡反馈在跑流程」
       *
       * 原来这里无论成功失败都 dismiss()，把弹窗关掉。失败时：
       *   1. 先把原因写进 error.textContent
       *   2. 紧接着 dismiss() 把整个 overlay 移除
       *   → 玩家一个字都看不到，界面上就像「点了没反应」。
       *
       * 现在失败时**保持弹窗开着**，把原因显示在面板里，让玩家知道为什么没跑成、
       * 下一步该怎么做。成功才关窗。
       * 关窗按钮 / Esc 仍然随时可用，不会留一个关不掉的窗。
       */
      setRunningUI(false);
      var reason=String((e&&e.message)||e||'未知错误');
      error.textContent='本次未替换结果：'+reason;
      /* 这个 <p> 的默认样式类是 fr-replay-status（灰字，用作进度说明）。
       * 失败时要让它显眼：加一个内联的告警色，不依赖额外的 CSS 类——
       * 之前写 fr-replay-error 但样式表里根本没这个类，等于没提示。 */
      error.style.color='#e57373';
      error.style.fontWeight='600';
      try{
        // 同时给一条右侧提示，避免玩家只盯流程面板时错过。
        if(typeof showDanmaku==='function')showDanmaku('局部重跑未完成：'+reason,'error');
      }catch(_){}
      // 不 dismiss()：留在面板上，玩家能读到原因并重选目标重试。
    }
  });
  // 玩家 2026-10-30：不要强制玩家恢复存档。
  //
  // recovery 只是「上一次局部重跑被中断」留下的备份记录（frReplayExecute 开头写入、
  // 正常结束清除），它不代表当前存档坏了。玩家完全可能想直接重 roll 这一轮，
  // 把开始按钮锁死（原来的 start.disabled=true; eligible=false）是不合理的限制。
  //
  // 而且重跑本身就带完整备份与回滚（backup + frReplayRestoreBackup），
  // 直接重跑是安全的：开始时会重新拍备份，失败/中止会自动恢复。
  //
  // 所以：恢复存档做成「可选的小按钮」，放在状态栏末尾，不阻断重跑，也不改变 eligible。
  if(recovery){
    // 放进状态行：小号文字按钮，不占版面，也不抢主按钮的注意力。
    var restore=node('button','恢复中断前存档',statusRow);restore.type='button';
    restore.className='fr-replay-restore';
    restore.title='把存档恢复到上次局部重跑开始前的状态（可选，不恢复也能直接重跑）';
    restore.addEventListener('click',async function(){
      restore.disabled=true;
      try{
        /* 只查**本系统**是否在跑：另一个系统（另一条线路）正在重跑，不影响这边恢复。
         * 2026-11-02 玩家：「必须要彻底区分开来，这俩是完全不同的线路和独立系统。」
         * 原来读全局 frReplayBusy，于是变量演化一跑，原著补演的恢复按钮就点不动。 */
        var restoreSystem=(system==='ce')?'ce':'canon';
        if(frReplayBusyOf(restoreSystem)||frReplayDirectBusyOf(restoreSystem))throw new Error('重跑仍在运行');
        var releaseRestore=await frReplayAcquireArchive(name,null,function(){error.textContent='正在等待当前存档的重跑结束，再恢复备份。';});
        try{await frReplayRestoreBackup(recovery);}finally{releaseRestore();}
        /* 恢复备份按系统分开存，清除也必须清对应的那一个。
         * 原来只清 FR_REPLAY_RECOVERY_V1:<存档>（无系统后缀），
         * 而写入时已经带后缀了，于是这份脏标记永远删不掉、下次还会提示。 */
        await dbSet('FR_REPLAY_RECOVERY_V1:'+name+':'+restoreSystem,null);
        try{await dbSet('FR_REPLAY_RECOVERY_V1:'+name,null);}catch(_){}
        dismiss();
        await frReplayOpenPicker(system,defaults);
      }catch(e){error.textContent='恢复失败：'+e.message;restore.disabled=false;}
    });
    // 状态栏提示「有这么一份备份可用」，不阻止玩家直接重跑。
    if(!error.textContent||/正在核对本轮边界/.test(error.textContent))
      error.textContent='检测到上次重跑中断留下的备份：可直接重跑，也可先恢复。';
  }
  document.body.appendChild(overlay);close.focus();
  var idleSealChecks=0;
  if(waitingForReplay)(async function waitForAdmission(){
    if(!overlay.isConnected||!waitingForReplay||working)return;
    var block=frReplayRunBlock(system);
    if(block){idleSealChecks=0;error.textContent=block;}
    else if(context.unsealed){
      // 面板打开时可能只有实时产物；封存后重读同一楼层，不能把旧空列表当最终结果。
      var refreshed=await frReplayReadContext(system,{...defaults,logId:context.logId});
      if(!overlay.isConnected)return;
      if(refreshed.context?.archiveName!==context.archiveName||refreshed.context?.logId!==context.logId){waitingForReplay=false;error.textContent='当前存档或楼层已变化，请从对应回合重新打开。';return;}
      if(!refreshed.context.unsealed){dismiss();await frReplayOpenPicker(system,defaults);return;}
      if(++idleSealChecks>=12){waitingForReplay=false;error.textContent='本轮已结束，但重跑基线没有完成保存。已返回的资料仍可查看。';return;}
      error.textContent='正在核对本轮重跑基线的保存结果。';
    }else{await checkAdmission();update();}
    if(waitingForReplay&&overlay.isConnected)setTimeout(function(){waitForAdmission().catch(function(e){error.textContent='重跑状态刷新失败：'+String(e?.message||e);});},700);
  })().catch(function(e){error.textContent='重跑状态刷新失败：'+String(e?.message||e);});
  // 面板先出来，楼层资料异步补上；取不到就整行隐藏，不打扰正常重跑。
  refreshFloors().catch(function(){floorBar.hidden=true;});
}
function frReplayInitUI(){
  frReplayWorkspaceStyle();
  var style=document.createElement('style');style.textContent=`#fr-replay-overlay{position:fixed;inset:0;z-index:30000;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}.fr-replay-panel{display:flex!important;flex-direction:column;width:min(1080px,96vw);max-height:92vh;border:1px solid var(--primary-color);border-radius:14px;background:var(--modal-bg,var(--input-bg,#1c1c1c));color:var(--text-primary,#ddd);padding:20px;box-sizing:border-box}.fr-replay-panel h3{margin:0 0 8px;color:var(--hover-color,#e6be6c)}.fr-replay-note{font-size:12px;color:var(--text-secondary,#aaa)}.fr-replay-body{overflow:auto;min-height:0;padding:6px}.fr-replay-body fieldset{border:1px solid var(--separator-color,#655739);border-radius:9px;margin:10px 0;padding:10px}.fr-replay-body legend{color:var(--hover-color,#e6be6c)}.fr-replay-body label{display:flex;gap:10px;align-items:center;padding:9px;min-height:26px;font-size:13px}.fr-replay-body input[type=checkbox]{accent-color:#c49a48}.fr-replay-body input[type=search],.fr-replay-body textarea{box-sizing:border-box;width:100%;border:1px solid var(--input-border,#655739);border-radius:7px;background:var(--input-bg,#151515);color:inherit;padding:12px;font:inherit}.fr-replay-footer{display:flex;gap:10px;align-items:center;border-top:1px solid var(--separator-color,#655739);padding-top:14px;margin-top:12px}.fr-replay-footer span{flex:1;font-size:12px}.fr-replay-panel button{padding:10px 15px;min-height:42px;background:var(--input-bg,#25221b);color:inherit;border:1px solid var(--primary-color,#8c7853);border-radius:7px;cursor:pointer}.fr-replay-panel button:disabled{opacity:.45;cursor:default}.fr-replay-panel :focus-visible{outline:2px solid #e6be6c;outline-offset:2px}@media(max-width:640px){.fr-replay-panel{padding:12px}.fr-replay-footer{flex-wrap:wrap}.fr-replay-footer span{flex-basis:100%}.fr-replay-panel button{min-height:44px}}`;document.head.appendChild(style);
}
// 使用独立命名空间压过原卡通用弹窗和按钮尺寸，防止底栏被挤成竖排。
function frReplayWorkspaceStyle(){var style=document.createElement('style');style.textContent=`
/* ===== 视图切换与「按动作看」卡片（玩家 2026-11-03：「还有你说的简化。」）===== */
#fr-replay-overlay .fr-replay-view-bar{display:flex;gap:8px;margin:0 0 10px}
#fr-replay-overlay .fr-replay-view-bar button{font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid #55472e;background:#252119;color:#c4b89e;cursor:pointer}
#fr-replay-overlay .fr-replay-view-bar button.is-on{background:#bb9245;color:#1c1811;border-color:#bb9245;font-weight:600}
#fr-replay-overlay .fr-replay-view-tip{font-size:12px;color:#9b9081;margin:0 0 10px;line-height:1.5}
#fr-replay-overlay .fr-replay-action-card{display:block;border:1px solid #514630;background:#22201a;border-radius:8px;padding:12px;margin-bottom:10px;cursor:pointer}
#fr-replay-overlay .fr-replay-action-card:has(input:checked){border-color:#bb9245;background:#2b2519}
/* 本轮没有对应项目：卡片照常显示（不隐藏），只做降权 + 说明。
   玩家 2026-11-03「局部重跑现在都是空的」——原来直接不渲染，界面全空。
   现在至少能看出是「这轮没跑」而不是「面板坏了」。 */
#fr-replay-overlay .fr-replay-action-card.is-absent{opacity:.55;cursor:default}
#fr-replay-overlay .fr-replay-action-card.is-absent .fr-replay-action-head{cursor:default}
#fr-replay-overlay .fr-replay-action-card.is-absent .fr-replay-action-body span{color:#8a7d68}
#fr-replay-overlay .fr-replay-action-head{display:flex;align-items:center;gap:12px;cursor:pointer}
#fr-replay-overlay .fr-replay-action-head strong{font-size:15px;font-weight:600;color:#e8ddc6;line-height:1.4}
/* 「只看这步的项目」：玩家 2026-11-03「我选了左边你右边就有对应的只显示这个阶段的项目啊，
   之前有这个逻辑你怎么反而删除了？」——把它做成动作卡上明确的一个入口。 */
#fr-replay-overlay .fr-replay-action-focus{margin-left:auto;flex:none;padding:4px 10px;border-radius:999px;border:1px solid #6b5a3a;background:#2b2519;color:#d9c9a3;font-size:12px;cursor:pointer;white-space:nowrap}
#fr-replay-overlay .fr-replay-action-focus:hover{background:#3b301d;color:#ffda85}
#fr-replay-overlay .fr-replay-action-card.is-active{border-color:#d2a653;box-shadow:inset 3px 0 0 #d2a653}
#fr-replay-overlay .fr-replay-action-card.is-active .fr-replay-action-focus{background:#bb9245;color:#1c1811;border-color:#bb9245}

#fr-replay-overlay .fr-replay-action-body{margin:6px 0 0 32px}
#fr-replay-overlay .fr-replay-action-body p{margin:0;font-size:12px;line-height:1.7;color:#a99d87}
#fr-replay-overlay .fr-replay-action-body span{display:block;margin-top:6px;font-size:12px;line-height:1.6;color:#8d8577}
/* 右侧按动作分组的分隔标题。玩家 2026-11-03：「右边的具体项目绑定简化后的流程」、   「一目了然看到选择的项目或者阶段之间的关联关系」。 */
#fr-replay-overlay .fr-replay-action-head-sep{display:flex;align-items:center;gap:8px;margin:18px 0 10px;padding:8px 12px;border-left:3px solid #6b5a3a;background:#221f18;border-radius:0 6px 6px 0;font-size:14px;font-weight:600;color:#d9c9a3}
#fr-replay-overlay .fr-replay-action-head-sep:first-child{margin-top:0}
#fr-replay-overlay .fr-replay-action-head-sep.is-picked{border-left-color:#bb9245;color:#f0d79b;background:#2b2519}


#fr-replay-overlay .fr-replay-panel{width:min(1440px,96vw)!important;max-width:1440px!important;height:min(880px,94vh);max-height:94vh!important;min-height:0;padding:0!important;overflow:hidden;background:#1c1b18;color:#eee5d3;box-shadow:0 26px 90px #0009}
#fr-replay-overlay .fr-replay-panel *{scrollbar-width:thin;scrollbar-color:#796745 #24211a}#fr-replay-overlay .fr-replay-panel ::-webkit-scrollbar{width:8px;height:8px}#fr-replay-overlay .fr-replay-panel ::-webkit-scrollbar-track{background:#24211a}#fr-replay-overlay .fr-replay-panel ::-webkit-scrollbar-thumb{background:#796745;border-radius:5px}
#fr-replay-overlay .fr-replay-header{position:relative;padding:22px 26px 14px;flex:none}#fr-replay-overlay h3{font-size:22px;margin:0 0 8px;color:#edcf8b}#fr-replay-overlay .fr-replay-note{font-size:14px;line-height:1.6;margin:0;color:#c6bda9}#fr-replay-overlay .fr-replay-x{position:absolute;top:16px;right:18px;width:34px!important;height:34px;min-height:34px;padding:0!important;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;border-radius:7px;border:1px solid #5a4e3c;background:rgba(0,0,0,.35);color:#c9bda6;cursor:pointer}#fr-replay-overlay .fr-replay-x:hover{background:#3b301d;color:#ffda85;border-color:#796745}#fr-replay-overlay .fr-replay-x:focus-visible{outline:2px solid #edcf8b;outline-offset:2px}@media(max-width:720px){#fr-replay-overlay .fr-replay-x{top:12px;right:12px;width:30px!important;height:30px;min-height:30px}}
#fr-replay-overlay button{width:auto!important;flex:none!important;min-width:0;min-height:44px;font:inherit;line-height:1.5;white-space:normal;word-break:normal;overflow-wrap:normal;background:#26231c;color:#eee5d3;border-color:#71603d}
#fr-replay-overlay .fr-replay-panel :focus-visible{outline:2px solid #f1cd83;outline-offset:3px}
#fr-replay-overlay .fr-replay-body{position:relative;display:grid!important;grid-template-columns:minmax(260px,32%) minmax(0,1fr);flex:1;min-height:0;overflow:hidden;padding:0;border-top:1px solid #4b4232;border-bottom:1px solid #4b4232}
#fr-replay-overlay .fr-replay-stages{min-width:0;overflow:auto;padding:20px 22px;border-right:1px solid #4b4232}#fr-replay-overlay h4{font-size:16px;color:#e5c78a;margin:0 0 14px}
#fr-replay-overlay .fr-replay-stage{border:1px solid #514630;background:#22201a;border-radius:8px;padding:12px;margin-bottom:10px}#fr-replay-overlay label{font-size:15px!important;line-height:1.6;min-width:0}#fr-replay-overlay .fr-replay-stage label{padding:0;display:flex;align-items:flex-start;gap:12px;cursor:pointer}#fr-replay-overlay input[type=checkbox]{width:19px;height:19px;flex:none;margin:3px 0 0;accent-color:#d2a653}
#fr-replay-overlay .fr-replay-stage button{padding:5px 0 0 31px;border:0;background:none;text-align:left;color:#c5bca8;font-size:13px;min-height:32px;width:100%!important}#fr-replay-overlay .fr-replay-stages details{margin-top:18px;font-size:13px;line-height:1.7;color:#c9c0ad}#fr-replay-overlay summary{cursor:pointer;min-height:30px}#fr-replay-overlay textarea{font-size:14px;margin:8px 0;min-height:90px}
#fr-replay-overlay .fr-replay-targets{display:flex;flex-direction:column;min-width:0;min-height:0;padding:0!important}#fr-replay-overlay .fr-replay-target-tools{display:grid;grid-template-columns:1fr auto;gap:12px;padding:20px 22px 14px;border-bottom:1px solid #4b4232;flex:none}#fr-replay-overlay .fr-replay-target-tools h4{margin:0;align-self:center}#fr-replay-overlay .fr-replay-target-tools label{display:flex;gap:8px;padding:0;font-size:13px!important;align-items:center}#fr-replay-overlay .fr-replay-target-tools input[type=search]{grid-column:1/-1;min-height:46px;font-size:15px}
#fr-replay-overlay .fr-replay-selection-tools{grid-column:1/-1;display:flex;gap:10px}#fr-replay-overlay .fr-replay-selection-tools button{padding:7px 14px;font-size:14px}#fr-replay-overlay .fr-replay-target-list{overflow:auto;min-height:0;padding:18px 22px;scroll-padding:12px}
/* 分页条：目标多时一页只铺 40 条，玩家翻页找失败项，不用一直往下滚。 */
#fr-replay-overlay .fr-replay-pager{display:flex;align-items:center;gap:12px;padding:10px 22px;border-top:1px solid #4b4232;flex:none}
/* 自动关联说明条：勾选后如实告诉玩家「还自动带了哪几个阶段、为什么」。
 * 用暖色边线和平实文字，既不抢眼也不至于被忽略。 */
#fr-replay-overlay .fr-replay-auto-related{margin:0;padding:12px 22px;border-bottom:1px solid #4b4232;background:#26231b;color:#d9cbaa;font-size:13px;line-height:1.7}
#fr-replay-overlay .fr-replay-auto-related[hidden]{display:none}
/* 被关联自动带上的阶段勾选框加一个左侧暖色竖线，让玩家一眼看出「这个不是我点的」。 */
#fr-replay-overlay .fr-replay-stage:has(input[data-fr-auto-related="1"]){box-shadow:inset 3px 0 0 #d2a653}
/* ===== 失败项视觉隔离（玩家 2026-11-02：「失败项的 ui 也要做区分甚至分组隔离，让玩家一目了然」）=====
 * 用左侧红色竖条 + 略深的底色，和「材料就绪」的正常项明显区分开。
 * 只靠徽标颜色不够——列表一长，玩家的眼睛是跟着整行走的。 */
#fr-replay-overlay .fr-replay-target.is-unfinished{border-left:4px solid #c0563f;background:#251c19}
#fr-replay-overlay .fr-replay-target.is-unfinished strong{color:#f0b8a8}
/* 失败分组的小标题条：把「需要重跑」和「默认复用」两段明确隔开。 */
#fr-replay-overlay .fr-replay-group-head{display:flex;align-items:center;gap:10px;padding:10px 4px 6px;font-size:13px;color:#c9b99b;letter-spacing:.02em}
#fr-replay-overlay .fr-replay-group-head::after{content:'';flex:1;height:1px;background:#4b4232}
#fr-replay-overlay .fr-replay-group-head.is-fail{color:#e79a86}
/* ===== footer 三个按钮的视觉分区（玩家 2026-11-02：「智能重跑要做区分 ui，比如边框和颜色的区别」）=====
 *   智能重跑 → 金色实心 + 双层描边光晕，最显眼，引导优先点
 *   局部重跑 → 金色实心，普通强调
 *   取消     → 描边空心，弱化，避免和主操作抢注意力
 * 三者同处一排、靠右对齐，不分行。 */
#fr-replay-overlay .fr-replay-smart-btn{
  border:2px solid #f0cd84!important;
  background:linear-gradient(180deg,#a07f3b,#7d6029)!important;
  color:#fff8e6!important;
  font-weight:700!important;
  padding:11px 26px!important;
  font-size:15px!important;
  border-radius:9px!important;
  box-shadow:0 0 0 3px rgba(210,166,83,.22),0 2px 10px rgba(0,0,0,.35)!important;
  letter-spacing:.02em;
}
#fr-replay-overlay .fr-replay-smart-btn:hover:not(:disabled){background:linear-gradient(180deg,#b8934a,#8d6d31)!important;box-shadow:0 0 0 3px rgba(210,166,83,.34),0 2px 12px rgba(0,0,0,.4)!important}
#fr-replay-overlay .fr-replay-smart-btn:disabled{opacity:.45;cursor:default;box-shadow:none!important}
#fr-replay-overlay .fr-replay-footer .major-action-button{border-width:1px!important;box-shadow:none!important;padding:10px 22px!important;font-size:14px!important}
#fr-replay-overlay .fr-replay-footer button:not(.fr-replay-smart-btn):not(.major-action-button){background:transparent!important;border:1px solid #5a4e3c!important;color:#c9bda6!important;font-weight:400!important}
#fr-replay-overlay .fr-replay-footer button:not(.fr-replay-smart-btn):not(.major-action-button):hover:not(:disabled){border-color:#8a7550!important;color:#e5d6b8!important}
/* 失败项视觉隔离：左侧红条 + 略深底色，长列表里一眼能分出要补的。 */
#fr-replay-overlay .fr-replay-target.is-unfinished{border-left:4px solid #c0563f;background:#251c19}
#fr-replay-overlay .fr-replay-target.is-unfinished strong{color:#f0b8a8}
/* 右侧「当前只看哪个大阶段」胶囊：取代已删除的页签。
 * 左边选阶段 → 右边只显示该阶段的目标；点这里回到全部。 */
#fr-replay-overlay .fr-replay-stage-filter{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #6b5a3a;border-radius:999px;background:#2b2519;font-size:13px;color:#e5c78a;white-space:nowrap;min-width:0}
#fr-replay-overlay .fr-replay-stage-filter[hidden]{display:none}
#fr-replay-overlay .fr-replay-stage-filter-name{overflow:hidden;text-overflow:ellipsis}
#fr-replay-overlay .fr-replay-stage-filter-clear{padding:3px 10px!important;min-height:24px!important;font-size:12px!important;border-radius:999px!important;background:#3b301d!important;border:1px solid #7a6539!important;color:#ffda85!important}
#fr-replay-overlay .fr-replay-stage-filter-clear:hover{background:#4a3c22!important}
#fr-replay-overlay .fr-replay-stage-filter-clear[hidden]{display:none}
/* 左侧阶段被选中查看时高亮，让左右对应关系一目了然。 */
#fr-replay-overlay .fr-replay-stage.is-active{border-color:#d2a653;background:#2e2718}
#fr-replay-overlay .fr-replay-group-head{display:flex;align-items:center;gap:10px;padding:14px 4px 8px;font-size:13px;color:#9d9481;letter-spacing:.02em}
#fr-replay-overlay .fr-replay-group-head::after{content:'';flex:1;height:1px;background:#4b4232}
#fr-replay-overlay .fr-replay-group-head.is-fail{color:#e79a86}
#fr-replay-overlay .fr-replay-group-head.is-fail::after{background:#5a4438}
#fr-replay-overlay .fr-replay-pager[hidden]{display:none}
#fr-replay-overlay .fr-replay-pager-info{margin-right:auto;font-size:13px;color:#c6bda9;white-space:nowrap}
#fr-replay-overlay .fr-replay-pager-btn{padding:7px 16px;font-size:13px;white-space:nowrap}
#fr-replay-overlay .fr-replay-pager-btn:disabled{opacity:.45;cursor:default}
#fr-replay-overlay .fr-replay-target{display:grid!important;grid-template-columns:20px minmax(0,1fr) auto auto auto;gap:12px;align-items:center;padding:15px!important;min-height:76px;box-sizing:border-box;border:1px solid #55472e;background:#252119;border-radius:8px;margin-bottom:10px;cursor:pointer}#fr-replay-overlay .fr-replay-target:has(input:checked){border-color:#bb9245;background:#302719}#fr-replay-overlay .fr-replay-target-copy{min-width:0}#fr-replay-overlay .fr-replay-target strong{display:block;font-size:16px;font-weight:600;overflow-wrap:anywhere}#fr-replay-overlay .fr-replay-target small{display:block;font-size:13px;color:#c4b89e;margin-top:4px}#fr-replay-overlay .fr-replay-target-badge{font-size:12px;padding:4px 9px;border-radius:5px;white-space:nowrap;background:#303d2b;color:#bfdbaf}#fr-replay-overlay .fr-replay-target-badge.unfinished{background:#554123;color:#f5c678}/* 结果可复用徽标：蓝青色系，与资料徽标的绿色、待处理的黄色区分 */
#fr-replay-overlay .fr-replay-result-badge{background:#26343d;color:#a8cfe0}#fr-replay-overlay .fr-replay-result-badge.unfinished{background:#332b23;color:#9b9081}#fr-replay-overlay .fr-replay-result-badge.rerun{background:#3a2a1c;color:#e0b070}#fr-replay-overlay [hidden]{display:none!important}
#fr-replay-overlay .fr-replay-status{font-size:13px;color:#c6bda9;margin:0;padding:10px 26px;line-height:1.6;flex:none;overflow-wrap:anywhere}
/* 状态行：状态文字 + 可选小按钮并排。恢复存档按钮做小，不抢版面。 */
#fr-replay-overlay .fr-replay-status-row{display:flex!important;align-items:center;gap:12px;padding:10px 26px;flex:none;min-width:0}
#fr-replay-overlay .fr-replay-status-row .fr-replay-status{padding:0;flex:1;min-width:0}
#fr-replay-overlay .fr-replay-restore{padding:4px 10px!important;min-height:26px!important;font-size:12px!important;line-height:1.4;white-space:nowrap;flex:none;background:transparent!important;border:1px solid #6b5c3e!important;color:#c9bda6!important;border-radius:6px;opacity:.85}
#fr-replay-overlay .fr-replay-restore:hover{background:#3b301d!important;color:#ffda85!important;border-color:#796745!important;opacity:1}
#fr-replay-overlay .fr-replay-restore:disabled{opacity:.4;cursor:default}
#fr-replay-overlay .fr-replay-footer{display:grid!important;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:12px;flex:none;margin:0;padding:14px 26px 20px;border-top:1px solid #4b4232}#fr-replay-overlay .fr-replay-count{min-width:0;white-space:nowrap;word-break:normal;font-size:14px}#fr-replay-overlay .fr-replay-footer button{padding:10px 22px;white-space:nowrap}#fr-replay-overlay .fr-replay-footer .major-action-button{background:#d6ac58;color:#211909;border-color:#e5c078;font-weight:600}#fr-replay-overlay .fr-replay-panel :focus-visible{outline:2px solid #f1cd83;outline-offset:3px}#fr-replay-overlay .fr-replay-empty{padding:24px;color:#c6bda9}
/* 楼层选择条 */
#fr-replay-overlay .fr-replay-floors{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0 0;padding:10px 14px;border:1px solid #514630;background:#22201a;border-radius:8px}
#fr-replay-overlay .fr-replay-floor-label{display:flex;align-items:center;gap:8px;font-size:14px;color:#d9c9a3;margin:0}
#fr-replay-overlay .fr-replay-floor-select{padding:6px 10px;border-radius:6px;border:1px solid #6b5c3e;background:#1b1914;color:#edcf8b;font-size:14px;min-height:32px}
#fr-replay-overlay .fr-replay-floor-info{font-size:13px;color:#a99f8b}
/* 卡片上的「资料」按钮 */
#fr-replay-overlay .fr-replay-stage{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px}
#fr-replay-overlay .fr-replay-stage>label{grid-column:1;min-width:0}
#fr-replay-overlay .fr-replay-stage>.fr-replay-mat-btn{grid-column:2;justify-self:end}
#fr-replay-overlay .fr-replay-stage>button:not(.fr-replay-mat-btn){grid-column:1/-1}
#fr-replay-overlay .fr-replay-mat-btn{padding:5px 12px;border-radius:6px;border:1px solid #6b5c3e;background:#2c2820;color:#e5c78a;font-size:13px;min-height:30px;width:auto!important;white-space:nowrap;cursor:pointer}
#fr-replay-overlay .fr-replay-inline-mat{grid-column:1/-1;margin:6px 0 2px;padding:12px 14px 14px 20px;border-left:3px solid #6b5c3e;border-radius:0 8px 8px 0;background:rgba(140,120,83,.07)}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-title{color:#e5c78a;font-size:14px}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-meta{color:#a89c86;font-size:12px;line-height:1.7;margin-bottom:8px}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-item{border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:6px 10px;margin:6px 0;background:rgba(0,0,0,.18)}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-sum{cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;color:#d8cdb8}
#fr-replay-overlay .fr-replay-inline-mat .fr-replay-mat-text{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.7;color:#b9ae98;margin:8px 0 2px}
#fr-replay-overlay .fr-replay-mat-btn:hover{background:#3a3427;border-color:#8a7550;color:#f3deab}
#fr-replay-overlay .fr-replay-mat-btn-mini{padding:4px 10px;font-size:12px;min-height:26px;white-space:nowrap;flex:none}
/* 资料详情抽屉 */
#fr-replay-overlay .fr-replay-materials{display:flex;flex-direction:column;min-width:0;min-height:0;background:#1b1914;border-left:1px solid #4b4232}
#fr-replay-overlay .fr-mat-open .fr-replay-body{grid-template-columns:minmax(200px,22%) minmax(0,1fr) minmax(320px,38%)}
#fr-replay-overlay .fr-replay-mat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 10px;border-bottom:1px solid #3d3729;flex:none}
#fr-replay-overlay .fr-replay-mat-title{font-size:17px;color:#edcf8b}
#fr-replay-overlay .fr-replay-mat-x{padding:2px 10px;border:1px solid #6b5c3e;background:#2c2820;color:#e5c78a;border-radius:6px;font-size:15px;min-height:30px;width:auto!important;cursor:pointer}
#fr-replay-overlay .fr-replay-mat-meta{padding:10px 18px;font-size:13px;line-height:1.6;color:#a99f8b;border-bottom:1px solid #332e23;flex:none}
#fr-replay-overlay .fr-replay-mat-list{flex:1;min-height:0;overflow:auto;padding:12px 18px 20px;display:flex;flex-direction:column;gap:10px}
#fr-replay-overlay .fr-replay-mat-item{border:1px solid #4a4130;background:#22201a;border-radius:8px;padding:10px 12px}
#fr-replay-overlay .fr-replay-mat-sum{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:14px;color:#e2d5b6;cursor:pointer;word-break:break-word}
#fr-replay-overlay .fr-replay-mat-badge{font-style:normal;font-size:12px;padding:2px 8px;border-radius:999px;background:#3a3427;color:#c8b789;flex:none}
#fr-replay-overlay .fr-replay-mat-badge-stale{background:#4a3320;color:#f0b464;border-color:#7a5a32}

#fr-replay-overlay .fr-replay-mat-detail-meta{display:flex;flex-direction:column;gap:3px;margin:8px 0 6px;font-size:12px;line-height:1.6;color:#9d9482;word-break:break-word}
#fr-replay-overlay .fr-replay-mat-text{margin:0;padding:10px 12px;background:#15140f;border:1px solid #3a3427;border-radius:6px;font-size:13px;line-height:1.7;color:#cfc6b2;white-space:pre-wrap;word-break:break-word;max-height:46vh;overflow:auto}
#fr-replay-overlay .fr-replay-mat-empty{font-size:14px;color:#a99f8b;margin:8px 0}

@media(max-width:720px){#fr-replay-overlay .fr-replay-floors{gap:8px;padding:8px 10px}#fr-replay-overlay .fr-replay-floor-select{flex:1;min-width:120px}#fr-replay-overlay .fr-mat-open .fr-replay-body{grid-template-columns:minmax(0,1fr)}#fr-replay-overlay .fr-mat-open .fr-replay-materials{position:absolute;inset:0;z-index:6;border:0;border-radius:0}#fr-replay-overlay .fr-replay-mat-text{max-height:38vh}}
@media(max-width:720px){#fr-replay-overlay .fr-replay-panel{width:98vw!important;height:96vh;max-height:96vh!important}#fr-replay-overlay .fr-replay-header{padding:16px}#fr-replay-overlay .fr-replay-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);overflow:auto}#fr-replay-overlay .fr-replay-stages{padding:12px;border-right:0;border-bottom:1px solid #4b4232;max-height:42vh;overflow:auto}#fr-replay-overlay .fr-replay-target-tools,#fr-replay-overlay .fr-replay-target-list{padding:12px}#fr-replay-overlay .fr-replay-target-tools{grid-template-columns:1fr}#fr-replay-overlay .fr-replay-target{grid-template-columns:20px minmax(0,1fr);gap:9px;padding:10px!important}#fr-replay-overlay .fr-replay-target span,#fr-replay-overlay .fr-replay-target em,#fr-replay-overlay .fr-replay-target strong{white-space:normal!important;word-break:break-word;overflow-wrap:anywhere;writing-mode:horizontal-tb;min-width:0}#fr-replay-overlay .fr-replay-target-badge{grid-column:2;justify-self:start}#fr-replay-overlay .fr-replay-footer{padding:12px 16px;gap:8px;grid-template-columns:minmax(0,1fr) auto auto auto}#fr-replay-overlay .fr-replay-footer button{padding:9px 12px}#fr-replay-overlay .fr-replay-count{white-space:normal}}
`;document.head.appendChild(style);}
frReplayInitUI();
