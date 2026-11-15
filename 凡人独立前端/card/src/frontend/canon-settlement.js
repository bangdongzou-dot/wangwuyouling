// 普通结算依据与楼层同存；完整显示正文和可解析正文分开传递。
var frOrdinarySettlementPending=null;
var frCanonSettlementQueues=new Map();
function frRequestCanonSettlementReview(request,input){
  var core=ceBridgeCore().settlement;
  if(typeof core.createSettlementReviewBatcher!=='function')return core.reviewSettlement(request);
  var key=String(input.boundary?.archiveName||currentArchiveName)+'|'+String(input.boundary?.logId||''),queue=frCanonSettlementQueues.get(key);
  if(!queue){queue=core.createSettlementReviewBatcher({review:core.reviewSettlement,waitMs:input.config?.readyBatchWaitMs??100,limits:input.config?.batchLimits,onIdle:function(){if(frCanonSettlementQueues.get(key)===queue&&!queue.pending)frCanonSettlementQueues.delete(key);}});frCanonSettlementQueues.set(key,queue);}
  return queue.enqueue(request);
}
/**
 * 显式闭批：本楼层该参与核验的人物都已登记后调用。
 * 合批成员由这次闭批确定，不再让 100ms 计时器决定谁和谁同批。
 */
function frSealCanonSettlementReview(input){
  var key=String(input?.boundary?.archiveName||currentArchiveName)+'|'+String(input?.boundary?.logId||''),queue=frCanonSettlementQueues.get(key);
  return queue?queue.seal():Promise.resolve();
}
function frRecordOrdinarySettlement(summary,storyText,logId){
  var records=[],source=summary||{},add=function(kind,operation){if(operation&& typeof operation==='object')records.push({id:'O'+(records.length+1),kind:kind,operation:structuredClone(operation)});};
  (source.appliedChanges||[]).forEach(row=>{if(row?.success!==false)add('characters',row.operation||row);});
  (source.itemManagement?.executedOps||[]).forEach(row=>{if(row?.success===true)add('items',row.operation||row.op);});
  var misc=source.misc||{};
  if(!misc.error){if(Array.isArray(misc.appliedChanges))misc.appliedChanges.forEach(row=>add('misc',row.operation||row));else if(Array.isArray(misc.requestedDelta)&&misc.appliedCount===misc.requestedDelta.length&&!misc.blockedOps?.length)misc.requestedDelta.forEach(op=>add('misc',op));}
  frOrdinarySettlementPending={archiveName:currentArchiveName,logId:logId,storyText:String(storyText||''),records:records,failures:structuredClone(source.errors||[]),partial:!!source.error||!!source.entryDecision?.error||Object.values(source.failedCount||{}).some(n=>n>0)||!!source.itemManagement?.error||!!misc.error};
}

async function frRefreshOrdinarySettlementAfterReplay(context, cleared, pendingFailures) {
  const pending = frOrdinarySettlementPending;
  if (pending?.archiveName !== context.archiveName || pending?.logId !== context.logId) return;
  const archive = await db.archives.get(context.archiveName);
  const floor = archive?.data?.logs?.find(row => row.id === context.logId);
  const previous = floor?.canonSettlementBase;
  if (!previous || floor.canonTurnCommit || Object.keys(floor.canonActorCommits || {}).length) return;
  if (!cleared?.stages?.length && !cleared?.scopes?.length) return;
  const completed = record => {
    if (cleared.stages.includes(record.kind)) return true;
    const op = record.operation;
    const ids = [op?.id, op?.data?.['0'], op?.owner, op?.from, op?.to].filter(Boolean);
    return ids.some(id => cleared.scopes.includes(record.kind + ':' + id));
  };
  pending.records = previous.records.filter(record => !completed(record))
    .concat(pending.records.filter(completed))
    .map((record, index) => ({ ...record, id: 'O' + (index + 1) }));
  pending.partial = pending.partial || !!(pendingFailures?.stages?.length || pendingFailures?.scopes?.length);
  await frEnsureCanonSettlementBase(context.logId, previous.storyText || pending.storyText, false,
    { archiveName: context.archiveName, floorContent: floor.content, refresh: true });
}
async function frEnsureCanonSettlementBase(logId,storyText,replay,options){
  var name=options?.archiveName||currentArchiveName;
  var archive=await db.archives.get(name),log=archive?.data?.logs?.find(row=>row.id===logId);
  if(!log)throw new Error('结算依据缺少本轮正文楼层');
  if(replay&& log.canonSettlementBase){if(log.canonSettlementBase.logId!==logId)throw new Error('结算依据楼层不符');return structuredClone(log.canonSettlementBase);}
  var rows=typeof ceBridgeReadStoredRows==='function'?await ceBridgeReadStoredRows():structuredClone(currentState['0']||{});
  var pending;
  var base=await db.transaction('rw',db.archives,async function(){
    var fresh=await db.archives.get(name),floor=fresh?.data?.logs?.find(row=>row.id===logId);
    if(currentArchiveName!==name)throw new Error('记录结算依据时已切换存档');
    if(!floor)throw new Error('结算依据缺少本轮正文楼层');
    if(options?.floorContent!==undefined&&floor.content!==options.floorContent)throw new Error('补演期间正文已变化，拒绝覆盖新状态');
    options?.signal?.throwIfAborted();
    pending=frOrdinarySettlementPending?.archiveName===name&&frOrdinarySettlementPending.logId===logId?frOrdinarySettlementPending:null;
    var previous=options?.refresh&&floor.canonSettlementBase?.logId===logId?floor.canonSettlementBase:null;
    var current={version:1,archiveName:name,logId:logId,storyText:String(storyText||''),ordinaryStory:pending?.storyText||previous?.ordinaryStory||'',records:structuredClone(pending?.records||previous?.records||[]),partial:!!(pending?.partial??previous?.partial),failures:structuredClone(pending?.failures||previous?.failures||[]),afterRows:rows};
    floor.canonSettlementBase=current;await db.archives.put(fresh);
    return structuredClone(current);
  });
  if(!options?.keepPending&&frOrdinarySettlementPending===pending)frOrdinarySettlementPending=null;
  return base;
}
function frCanonSettlementRecords(base,targets){
  if(!base)return [];
  var ids=new Set((targets||[]).map(row=>row.id));
  var touches=op=>[op?.id,op?.data?.['0'],op?.owner,op?.from,op?.to].some(id=>ids.has(id));
  var records=(base.records||[]).filter(row=>row.kind==='misc'||touches(row.operation));
  for(var id of ids)if(base.afterRows?.[id])records.push({id:'S:'+id,kind:'snapshot',operation:{id:id},state:base.afterRows[id],note:'当前完整快照，只证明状态，不单独证明两次交易是同一次'});
  return structuredClone(records);
}
async function frRefreshCanonSettlementBase(input,proposal){
  var base=structuredClone(input.settlementBase||input.boundary?.settlementBase||null);if(!base)return null;
  var archive=await db.archives.get(input.boundary.archiveName),log=archive?.data?.logs?.find(row=>row.id===input.boundary.logId);
  if(!log)throw new Error('本轮结算依据缺少正文楼层');
  base.actorReceiptIds=[];
  Object.values(log.canonActorCommits||{}).forEach(function(receipt){
    var additions=[];['characterDelta','items','misc'].forEach(function(key){(receipt.applied?.[key]||[]).forEach(function(operation,index){additions.push({id:'A:'+receipt.receiptId+':'+key+':'+index,kind:key==='characterDelta'?'characters':key==='items'?'items':'misc',operation:operation.operation||operation});});});
    var candidate={...base,records:additions};if(!ceBridgeCore().settlement.splitSettlementCandidates(proposal).some(row=>frCanonCandidateOverlaps(row,candidate)))return;
    base.records.push(...additions);base.actorReceiptIds.push(receipt.receiptId);
  });
  (proposal.targets||[]).forEach(function(target){var row=archive.data.state?.currentState?.['0']?.[target.id];if(!row){var entry=(archive.data.state?.worldBookEntries||[]).find(value=>value.id===target.id||value.key===target.id);try{row=typeof entry?.content==='string'?JSON.parse(entry.content):entry?.content;}catch(_){}}if(row){base.afterRows=base.afterRows||{};base.afterRows[target.id]=structuredClone(row);}});
  base.actorReceiptIds.sort();return base;
}
function frCanonSettlementInstruction(base,targets){
  return base?'\n【普通阶段已确认结算，仅供避免重复，不是再次执行的指令】\n'+JSON.stringify(frCanonSettlementRecords(base,targets))+'\n仅转换可解析新增正文；已结算交汇末段未提供给本次解析。以当前快照为基线计算最终新增，过去的经历不得覆盖后来已确认状态；同字段后续变化仍允许。':'';
}
// 重复核验只处理本轮正文实际涉及且本轮年表涉及的人物；后台人物不参加。
function frCanonCandidateOverlaps(row,base){
  var ids=op=>[op?.id,op?.data?.['0'],op?.owner,op?.from,op?.to].filter(Boolean);
  return (base?.records||[]).some(record=>{
    if(record.kind!==row.kind)return false;
    var a=row.operation,b=record.operation;
    if(row.kind==='misc')return a.command===b.command||ids(a).some(id=>ids(b).includes(id));
    if(!ids(a).some(id=>ids(b).includes(id)))return false;
    if(row.kind==='characters'&&a.command==='add'&&b.command==='add'&&a.data&&b.data)return Object.keys(a.data).some(key=>key!=='0'&&Object.hasOwn(b.data,key));
    // 其余同实体操作不能仅凭命令名不同就证明互不影响，交AI判净新增。
    return true;
  });
}
function frCanonSettlementScope(proposal,base,blocks){
  var all=ceBridgeCore().settlement.splitSettlementCandidates(proposal);
  var names=new Set([...(base.handoffNames||[]),...(blocks||[]).filter(block=>block.handoffDeclared&&(block.handoffReview?.excluded!==true||block.handoffReview?.missingCanonItems?.length)).map(block=>block.name)]);
  var ids=new Set((proposal.targets||[]).filter(target=>names.has(target.name)).map(target=>String(target.id)));
  if(!ids.size)return [];
  return all.filter(row=>[row.operation?.id,row.operation?.data?.['0'],row.operation?.owner,row.operation?.from,row.operation?.to].some(id=>ids.has(String(id))));
}
function frCanonNeedsSettlementFallback(proposal,base,blocks){
  return !!base && frCanonSettlementScope(proposal,base,blocks).length>0;
}
/**
 * 定点重核：新到达的成功回执只影响「和它争同一资源/字段」的候选。
 *
 * 方案任务4-3：「新回执只有真正改变同一资源/字段才定点重核，无关人不返工。」
 * 所以这里不重发整批，只挑出真正与本次新回执重叠的那几条候选。
 */
function frCanonPointRecheckRows(candidates,newRecords){
  var rows=Array.isArray(candidates)?candidates:[];
  var incoming=Array.isArray(newRecords)?newRecords:[];
  if(!rows.length||!incoming.length)return [];
  // 用同一套重叠判定，避免「定点重核」另立一份口径。
  var probe={records:incoming};
  return rows.filter(function(row){
    try{return frCanonCandidateOverlaps(row,probe);}catch(_){return false;}
  });
}
/**
 * 返回这次定点重核需要补发的候选；不需要重核时返回空数组。
 * 调用方拿到空数组就意味着「无需重核」，不该为此再发一次请求。
 */
function frCanonPointRecheckPlan(proposal,base,newRecords){
  /* ★★ 2026-11-02 全面复盘：原来缺 base 和缺 proposal 挤成一句。拆开。 */
  if (!base) return {ok:false,reason:'结算缺少基准（base）：没有当前存档的变量状态就无法判断要改什么'};
  if (!proposal) return {ok:false,reason:'结算缺少提案（proposal）：本轮没有要落地的变量变更内容'};
  var core=ceBridgeCore().settlement;
  var all=typeof core.splitSettlementCandidates==='function'?core.splitSettlementCandidates(proposal):[];
  var rows=frCanonPointRecheckRows(all,newRecords);
  return {rows:rows,reason:rows.length?'与本次新回执争同一资源或字段':'与本次新回执无关，无需重核'};
}
async function frReviewCanonSettlement(input,proposal){
  var src=input||{},base=src.settlementBase||src.boundary?.settlementBase;
  if(!base)return {...proposal,reviewedReceipts:[]};
  base={...base,handoffNames:src.boundary?.handoffNames||base.handoffNames||[]};
  var scoped=frCanonSettlementScope(proposal,base,src.blocks);
  // 定点重核：本轮若声明了「只有这一批新回执是新的」，就只核与它争同一资源的候选，
  // 与它无关的候选不因为别人落了新回执而重新返工。
  if(src.pointRecheckRecords&&src.pointRecheckRecords.length){
    var narrowed=frCanonPointRecheckRows(scoped,src.pointRecheckRecords);
    if(!narrowed.length)return {...proposal,reviewedReceipts:base.actorReceiptIds||[],pointRecheck:{skipped:true,reason:'与本次新回执无关，无需重核'}};
    scoped=narrowed;
  }
  if(!scoped.length)return {...proposal,reviewedReceipts:base.actorReceiptIds||[]};
  var core=ceBridgeCore().settlement,run=src.signal&&typeof frCanonTraceSignals!=='undefined'?frCanonTraceSignals.get(src.signal):null;
  var result=await frRequestCanonSettlementReview({name:(proposal.targets||[]).map(row=>row.name).join('、')||'世界',storyText:base.storyText||'',proseText:frCanonVariableText(src.blocks,src.proseText)+'\n'+String(src.worldForMisc||''),records:frCanonSettlementRecords(base,proposal.targets),snapshot:Object.fromEntries((proposal.targets||[]).map(row=>[row.id,base.afterRows?.[row.id]||row.data])),candidates:scoped,host:ceBridgeHost(src.signal,run),options:{signal:src.signal,retry:{maxRetries:src.config?.parseRetryCount??2,retryDelayMs:src.config?.retryDelay??1000}}},src);
  if(!result.ok)throw new Error(result.reason);
  if(run)frCanonTraceEvent(run,'parsed','变量重复兜底核验',result);
  var decisions=new Map((result.decisions||[]).map(row=>[row.id,row])),selected=new Set(scoped.map(row=>row.id)),merged={characterDelta:[],itemOperations:[],miscDelta:[]};
  for(var row of core.splitSettlementCandidates(proposal)){
    var decision=decisions.get(row.id);
    if(selected.has(row.id)&&!decision)throw new Error('重复核验缺少候选回执：'+row.id);
    if(decision?.verdict==='covered')continue;
    merged[row.kind==='characters'?'characterDelta':row.kind==='items'?'itemOperations':'miscDelta'].push(decision?.operation||row.operation);
  }
  return {...proposal,...merged,settlementReview:result,reviewedReceipts:base.actorReceiptIds||[]};
}
