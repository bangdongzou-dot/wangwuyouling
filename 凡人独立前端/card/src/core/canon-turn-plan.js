// 同轮瞬时分工。只读冻结输入，不调用普通结算或写库。
import { projectActorProfile, projectOrdinarySettlement } from './character-profile.js';
import {entriesInRange,entrySpan,canonReplayRange,parseTimePoint} from './interval.js';
import {collectActorBundles} from './actor-state.js';
import {eventCodeFromTitle,renderEventMaterial} from './vector-input.js';
import {findNextAppearance} from './ceiling.js';
import {analyzeStoryBoundary} from './diff.js';
import {loadLedger,mergeEventWatches} from './ledger.js';
import {withRetry} from './retry.js';
import {activePrebuiltImpacts,prebuiltBoundaryEvents,routePrebuiltBoundary} from './canon-prebuilt.js';
import {eventProgressForModel,isOrdinarySourceOnlyNode} from './canon-event-details.js';
import {hashCanonicalJson} from './canonical-json.js';

function boundaryTimelineSignature(timeline) {
  return Array.isArray(timeline) ? 'sha256:'+hashCanonicalJson(timeline) : timeline;
}

const codeOf=event=>String(event.code || event.eventId || eventCodeFromTitle(event.title) || '');
export function ordinaryUnreachedEvents(events,observed=[],saved=[],until='',storyText=''){
  const end=parseTimePoint(until);
  if(end===null)return [];
  const day=Math.floor(end/1440);
  const byId=new Map(observed.map(row=>[row.eventId,row]));
  const prior=new Map(saved.map(row=>[row.eventId,row]));
  const hasActualScope=row=>row?.occurred?.length||row?.nodes?.some(node=>!isOrdinarySourceOnlyNode(node)&&
    (node.state==='done'||node.state==='mutated'&&node.at))||
    ['changed','blocked'].includes(row?.status)&&row?.changes?.length||
    row?.timingChange?.kind==='early'&&row.timingChange.actualStart;
  const dayOf=value=>{const point=parseTimePoint(value);return point===null?null:Math.floor(point/1440);};
  const ordered=events.slice().sort((a,b)=>(parseTimePoint(a.time_start)??Infinity)-(parseTimePoint(b.time_start)??Infinity));
  const blocked=[];
  let earlierPending=false;
  for(const event of ordered){
    const id=codeOf(event),row=byId.get(id),old=prior.get(id);
    const quote=String(row?.evidence||'').trim();
    const confirmedThisTurn=quote&&storyText.includes(quote)&&(hasActualScope(row)||row?.resolved);
    if(earlierPending&&dayOf(event.time_start)===day&&!confirmedThisTurn&&!hasActualScope(old)&&!old?.resolved){
      blocked.push(id);
      continue;
    }
    const pointer=row||old;
    if(dayOf(event.time_end)===day&&pointer&&!pointer.resolved&&
      (pointer.pending?.length||pointer.nodes?.some(node=>node.state==='todo')))earlierPending=true;
  }
  return blocked;
}

export function eventWithActualWindow(event,progress=[],until=''){
  const timing=(progress.find(row=>row.eventId===codeOf(event))||{}).timingChange||event.timingChange;
  if(!timing||!['early','delayed'].includes(timing.kind)||!timing.reason)return event;
  const start=event.referenceStart||event.time_start,end=event.referenceEnd||event.time_end;
  const brief=String(event.content_brief||'').split('\n【实际时序变异】')[0];
  return {...event,referenceStart:start,referenceEnd:end,timingChange:timing,
    time_start:timing.kind==='early'?(timing.actualStart||timing.recordedAt||event.time_start):event.time_start,
    time_end:timing.kind==='delayed'&&parseTimePoint(end)<parseTimePoint(until)?until:event.time_end,
    content_brief:brief+'\n【实际时序变异】'+timing.reason+'；原著参考 '+start+' → '+end+'。仅推演实际已启动且仍可能继续的部分，不将参考日期当成已发生事实。'};
}
export function canonBoundaryInputStamp(src){
  // 保留语义字段，完整年表使用 SHA-256 指纹。活跃名册不属于语义输入。
  //
  // 2026-10-31 玩家反馈：「我改一下设置怎么就不行了，那这种情况不就无解了吗？」
  //
  // 原来的写法把整个 options 都塞进指纹（只排掉函数和几个字段）。
  // 后果：玩家改任何一项设置（容量、字数、档位…），指纹立刻变，
  //       已冻结的 preparedBoundary 永远匹配不上 → 重跑永久卡在
  //       「正文、时间、档案或设置已变化，前置边界失效」，点多少次都没用。
  // 这等于「改设置 = 自锁」。
  //
  // 现在的原则：指纹只认「会改变本轮原著分工结果」的语义输入。
  //   · 正文、起止时间、年表、人物、行前状态、进度、欠账、钩子、资料 → 必须认（变了确实要重算）
  //   · 纯输出规格类设置（容量、字数预算、并发、超时、重试次数、
  //     档位预算、开关类偏好）→ 不认。它们只影响「怎么写、写多少」，
  //     不影响「这一轮该谁出场、做哪些任务」。
  // 这样改设置后重跑仍能复用已有分工，不会自锁。
  const options=src.options || {};
  // 明确排除的非语义项：函数、运行时对象、以及只影响篇幅/性能的配置。
  const NON_SEMANTIC_KEYS=new Set([
    // 运行时对象／回调
    'signal','preparedBoundary','ordinarySettlement','savedActorCommits','onStage','replay',
    'onProseReady','onRetry','onMaterialRequest','onReceipt','traceRun','controller',
    'prebuiltLanding','prebuiltOrdinaryExclusive',
    'turnNo','ordinaryIndependent','canonPushBoundaryVersion', // 轮数只认顶层；调度开关不是边界事实
    // 容量与篇幅（改这些只是让写多写少，不改变本轮分工）
    'maxInputChars','maxOutputChars','maxOutputCharsLimit','batchLimits','tierBudgets',
    'coreMaxChars','minorMaxChars','coreSolo','proseMaxChars','proseBaseChars',
    // 并发／超时／重试（纯性能与稳定性）
    'maxConcurrency','requestTimeout','requestTimeoutMs','retryCount','parseRetryCount',
    'retry','timeout','readyBatchWaitMs','completionRepairCount','batchLimitsOverride',
    // 界面／展示偏好
    'showDiagnostics','materialMode','verbose','silentStatus','debug'
  ]);
  const semanticOptions=Object.fromEntries(Object.entries(options).filter(([key,value])=>
    typeof value!=='function' && !NON_SEMANTIC_KEYS.has(key)
  ));
  // prepareCanonTurnPlanBoundary 只有显式 false 才推断时间，其余均使用给定终点。
  semanticOptions.bodyTimeKnown=options.bodyTimeKnown!==false;
  return JSON.stringify({version:2,save:src.saveId || src.archiveName || '',branch:src.branchId || '',log:src.logId || '',turn:src.turnNo || options.turnNo,story:src.storyText,start:src.worldTime,end:src.targetTime,timeline:boundaryTimelineSignature(src.timeline),characters:src.characters,before:src.beforeStateRows,progress:src.eventProgress,watches:src.eventWatches,...(src.mutationNotes?.length?{mutationNotes:src.mutationNotes}:{}),open:src.openEvents,debts:src.debts,hooks:src.hooks,material:src.materialState,options:semanticOptions});
}

// 兼容已保存的 v2 签名。旧签名重复收录 options.turnNo，提交后重跑会自行加一；
// 对象属性顺序也不是事实变化。仅归一化已证实的非语义字段，保留全部其余输入。
function canonicalBoundaryStamp(stamp){
  try{
    const value=JSON.parse(stamp);
    if(value.version!==2)return null;
    if(Array.isArray(value.timeline))value.timeline=boundaryTimelineSignature(value.timeline);
    if(value.options){
      delete value.options.turnNo;delete value.options.ordinaryIndependent;delete value.options.canonPushBoundaryVersion;
      delete value.options.prebuiltLanding;delete value.options.prebuiltOrdinaryExclusive;
      value.options.bodyTimeKnown=value.options.bodyTimeKnown!==false;
    }
    const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'
      ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
    return stable(value);
  }catch(_){return null;}
}
export function canonBoundaryStampDifferences(saved,current){
  if(saved&&saved===current)return [];
  const a=canonicalBoundaryStamp(saved),b=canonicalBoundaryStamp(current);
  if(!a||!b)return ['signature'];
  return [...new Set([...Object.keys(a),...Object.keys(b)])]
    .filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key]));
}
export function canonBoundaryStampsEqual(saved,current){
  return Boolean(saved)&&canonBoundaryStampDifferences(saved,current).length===0;
}

export async function prepareCanonTurnPlanBoundary(src={}){
  const options={...src.options,canonPushBoundaryVersion:1,signal:src.signal || src.options?.signal};
  if(options.signal?.aborted)return {ok:false,reason:'本轮已中止'};
  const inputStamp=canonBoundaryInputStamp(src);
  let ledger=src.ledger;
  if(!ledger && (src.debts===undefined || src.openEvents===undefined || !src.worldTime))ledger=(await loadLedger(src.host,{worldTime:src.worldTime})).ledger;
  ledger=ledger || {eventWatches:src.eventWatches || []};
  const range=canonReplayRange({start:src.worldTime || ledger.worldTime,end:String(src.targetTime || (options.bodyTimeKnown===false?(src.worldTime || ledger.worldTime):''))},src.debts || ledger.debts || [],src.timeline);
  if(!range.start || !range.end || !String(src.storyText || '').trim())return {ok:false,reason:'前置边界需要稳定正文与实际起终点',inputStamp,range};
  const progress=src.eventProgress || ledger.eventProgress || [],open=src.openEvents || ledger.openEvents || [];
  const closed=new Set(progress.filter(row=>row.resolved).map(row=>row.eventId));
  const pending=new Set([...progress.filter(row=>!row.resolved).map(row=>row.eventId),...open.map(row=>row.eventId)]);
  // Even before the first reference date, real facts may activate a future event.
  // The shared boundary decides outsideRange versus a genuine early/break exception.
  let candidates=entriesInRange(src.timeline,range.start,range.end);
  for(const event of src.timeline || [])if(pending.has(codeOf(event))&&!candidates.some(row=>codeOf(row)===codeOf(event)))candidates.push(event);
  for(const timing of src.activatedEvents||[]){const event=(src.timeline||[]).find(row=>codeOf(row)===timing.eventId);if(event&&!candidates.some(row=>codeOf(row)===timing.eventId))candidates.push({...event,timingChange:timing});}
  candidates=candidates.filter(event=>!closed.has(codeOf(event)));
  candidates=candidates.map(event=>eventWithActualWindow(event,progress,range.end));
  const prebuilt=prebuiltBoundaryEvents(candidates,range);
  const allPrebuilt=prebuilt.length>0&&prebuilt.length===candidates.length;
  const endPoint=parseTimePoint(range.end);
  const boundaryMaterial=event=>{
    const span=entrySpan(event);
    return renderEventMaterial(event,{mode:options.materialMode||'current_only',
      isCurrent:endPoint!==null&&!!span&&span.min<=endPoint&&endPoint<=span.max,maxChars:0});
  };
  const playerNames=Object.entries(src.characters || {}).filter(([,info])=>info.isPlayer || info.id==='B1').map(([name])=>name);
  const actors=collectActorBundles({events:candidates,playerNames,windowOnly:true,materialMode:options.materialMode,currentTime:range.end}).actors;
  const nextReferences=new Map();
  const analysisActors=actors.map(actor=>{
    const info=src.characters?.[actor.name] || {},actorRef=String(info.id || actor.name),next=findNextAppearance((src.timeline||[]).filter(event=>!candidates.some(active=>codeOf(active)===codeOf(event))),actor.name,range.end);
    if(next && !nextReferences.has(codeOf(next)))nextReferences.set(codeOf(next),{code:codeOf(next),title:next.title,time_start:next.time_start,time_end:next.time_end,text:boundaryMaterial(next).text});
    const before=src.beforeStateRows?.[actorRef];
    const eventIds=actor.events.map(codeOf);
    const coverage=open.filter(row=>row.doneActors?.[actor.name]);
    const actorCoverage=allPrebuilt?coverage.filter(row=>eventIds.includes(row.eventId)).map(row=>({
      eventId:row.eventId,doneActors:{[actor.name]:row.doneActors[actor.name]},
    })):coverage;
    return {name:actor.name,actorRef,eventIds,nextReferenceIds:next?[codeOf(next)].filter(Boolean):[],state:projectActorProfile(before || info),material:['【本人事件与下一节点】按eventIds读取共享候选事件，按nextReferenceIds读取一次性共享下一节点材料。','【轮前基线 before:'+actorRef+'】使用本人state字段的冻结档案，不以普通未提交提案替代。','【已确认覆盖】\n'+JSON.stringify(actorCoverage),!next?'未来节点未知；不得因此冻结境界内进度':'下一节点仅作条件性走廊参考，须辨明本人当期现实。'].filter(Boolean).join('\n\n')};
  });
  const known=collectActorBundles({events:src.timeline || [],windowOnly:true,playerNames}).actors;
  const people=[...new Set([...known.map(row=>row.name),...(options.originalCharacterNames || []),...(src.canonicalNames || []),...Object.keys(src.characters || {})])].map(name=>({name,id:src.characters?.[name]?.id,aliases:[...new Set([...(src.characters?.[name]?.aliases || []),...(known.find(row=>row.name===name)?.aliases || [])])],isPlayer:playerNames.includes(name),isCanon:(known.some(row=>row.name===name)||(options.originalCharacterNames || []).includes(name)||(src.canonicalNames || []).includes(name))&&!playerNames.includes(name)}));
  const pointersByCode=new Map(prebuilt.map(event=>[event.code,event.nodes]));
  const events=candidates.map(event=>{
    const code=codeOf(event);
    const material=boundaryMaterial(event);
    const duplicatesPointer=allPrebuilt&&!material.original&&pointersByCode.get(code).some(node=>node.evidence?.trim()===material.brief);
    return {code,title:event.title,time_start:event.time_start,time_end:event.time_end,...(duplicatesPointer?{}:{text:material.text})};
  });
  const activeWorld = src.host?.activeWorldEvents ? await src.host.activeWorldEvents(range.start) : '';
  const boundaryBackground=[src.boundaryBackground,activeWorld&&'【当前世界局势】\n'+activeWorld,'【一次性共享下一节点材料，按nextReferenceIds引用；不是无条件上限】\n'+JSON.stringify([...nextReferences.values()].filter(row=>!events.some(event=>event.code===row.code)))].filter(Boolean).join('\n\n');
  const referenced=new Set(String(src.storyText||'').match(/E-\d+(?:\.\d+)?/gi)||[]);
  const nextGlobal=(src.timeline||[]).filter(event=>parseTimePoint(event.time_start)>parseTimePoint(range.end)).sort((a,b)=>parseTimePoint(a.time_start)-parseTimePoint(b.time_start))[0];
  if(nextGlobal)referenced.add(codeOf(nextGlobal));
  // 账本已有线索按编号定点取条目，不再为这批线索调用全库语义检索。
  (ledger.eventWatches||[]).forEach(row=>referenced.add(row.eventId));
  nextReferences.forEach((_,code)=>referenced.add(code));
  const eventIndex=new Map((src.timeline||[]).map(event=>[codeOf(event),event]));
  const referenceEvents=[...referenced].map(id=>eventIndex.get(id)).filter(event=>event&&!candidates.some(active=>codeOf(active)===codeOf(event))&&!closed.has(codeOf(event)));
  const relevantIds=new Set(candidates.concat(referenceEvents).map(codeOf));
  const candidateNames=new Set(prebuilt.flatMap(event=>event.nodes.flatMap(node=>node.actors)));
  const impacts=allPrebuilt?activePrebuiltImpacts(progress).filter(row=>candidateNames.has(row.name)):[];
  const modelProgress=eventProgressForModel(allPrebuilt?progress.filter(row=>relevantIds.has(row.eventId)):progress);
  const mutationNotes=(ledger.mutationNotes||[]).filter(row=>relevantIds.has(row.eventId)).slice(-20);
  const previousEvidence=src.corridorEvidenceResume;
  const resumeAnalysis=previousEvidence?.turnPlan?.deferredRefs?.length&&
    [previousEvidence.inputStamp,previousEvidence.resolvedInputStamp].some(stamp=>canonBoundaryStampsEqual(stamp,inputStamp))
    ?previousEvidence.storyAnalysis:null;
  let storyAnalysis=resumeAnalysis || (analysisActors.length || events.length || referenceEvents.length || src.hooks?.length || options.bodyTimeKnown===false ? await analyzeStoryBoundary({host:src.host,storyText:src.storyText,actors:analysisActors,people,events,prebuilt,referenceEvents:src.activatedEvents?[]:referenceEvents.map(event=>({code:codeOf(event),title:event.title,time_start:event.time_start,time_end:event.time_end,summary:nextReferences.has(codeOf(event))?'详见共享下一节点材料':event.content_brief||''})),range,currentTime:range.end,eventProgress:modelProgress,hooks:src.hooks || [],background:boundaryBackground+'\n【按编号承接的变异线索，嫌疑不是已启动】\n'+JSON.stringify(ledger.eventWatches||[])+(impacts.length?'\n【本轮相关且仍未解除的预制变异】\n'+JSON.stringify(impacts):'')+(mutationNotes.length?'\n【相关账本变异摘要，仅为参考，以当前事实和结构化状态为准】\n'+JSON.stringify(mutationNotes):''),options:{...options,prebuiltOnly:allPrebuilt}}) : {ok:true,facts:[],factRecords:[],handled:[],influences:[],worldEvents:[],actorDecisions:[],eventProgress:[],resolvedHooks:[],turnAdvanceTier:'outsideRange'});
  if(!storyAnalysis.ok || options.signal?.aborted)return {ok:false,reason:storyAnalysis.reason || '本轮已中止',inputStamp,range,storyAnalysis};
  if(storyAnalysis.activatedEvents?.length&&!src.activatedEvents){
    return prepareCanonTurnPlanBoundary({...src,ledger:{...ledger,eventWatches:mergeEventWatches(ledger.eventWatches,storyAnalysis.eventWatches)},activatedEvents:storyAnalysis.activatedEvents,boundaryBackground:[src.boundaryBackground,'【同轮已识别的提前事件，只扩展真实相关范围】\n'+JSON.stringify(storyAnalysis.activatedEvents)+'\n变异记录：'+JSON.stringify(storyAnalysis.eventWatches||[])].filter(Boolean).join('\n')});
  }
  candidates=candidates.map(event=>eventWithActualWindow(event,storyAnalysis.eventProgress||[],range.end));
  if(options.bodyTimeKnown===false){
    range.end=storyAnalysis.bodyEndTime;
    const actual=entriesInRange(src.timeline,range.start,range.end).filter(event=>!closed.has(codeOf(event)));
    if(actual.some(event=>!candidates.some(row=>codeOf(row)===codeOf(event)))){
      // 首次同次语义判断取得真实终点后，仅当范围确实扩展才再确认完整事件集合。
      // 第二次使用已确定终点，不允许递归猜时间或循环增加人物。
      const scoped=await prepareCanonTurnPlanBoundary({...src,targetTime:range.end,options:{...src.options,bodyTimeKnown:true}});
      return {...scoped,inputStamp,resolvedInputStamp:canonBoundaryInputStamp({...src,targetTime:range.end}),endpointReceipt:{bodyEndTime:range.end,scopeExpanded:true},...(scoped.turnPlan?{turnPlan:{...scoped.turnPlan,inputStamp}}:{})};
    }
  }
  let retrievalReceipt={status:'deferred',attempted:false,completed:false,reason:'前置使用年表、轮前快照及下一节点；完整资料仅为实际任务读取'};
  const unresolved=storyAnalysis.actorDecisions.filter(row=>row.canonAdvance==='needs_context');
  if(unresolved.length && typeof src.host?.vectorContext==='function' && options.materials!==false && options.materials?.ragVector!==false){
    const wanted=new Set(unresolved.map(row=>row.actorRef)),subset=analysisActors.filter(actor=>wanted.has(actor.actorRef));
    const neededEvents=new Set(unresolved.flatMap(row=>row.eventIds));
    const scopedEvents=events.filter(event=>neededEvents.has(event.code)).map(event=>{
      if(!allPrebuilt)return event;
      const candidate=candidates.find(row=>codeOf(row)===event.code);
      return candidate?{...event,text:boundaryMaterial(candidate).text}:event;
    });
    const query='【前置边界仅补必要缺失资料，不重建全员历史】\n'+JSON.stringify({range,requests:unresolved.map(row=>({name:row.name,requiredMaterials:row.requiredMaterials})),actors:subset,events:scopedEvents});
    const found=await withRetry(()=>src.host.vectorContext(query,{batchCollection:true,characterNames:subset.map(row=>row.name),referenceTime:range.end}),{config:options.retry,signal:options.signal,retryDelayMs:options.retryDelayMs,maxDelayMs:options.retryMaxDelayMs});
    retrievalReceipt={attempted:true,completed:found.ok,status:found.ok?(String(found.value || '').trim()?'found':'not_found'):'error',reason:found.ok?'必要缺失资料已合批检索':found.reason,characterNames:subset.map(row=>row.name)};
    if(!found.ok)return {ok:false,reason:'必要资料补取失败：'+found.reason,inputStamp,range,storyAnalysis,retrievalReceipt};
    const request={host:src.host,storyText:src.storyText,actors:subset,people,events:scopedEvents,range,currentTime:range.end,eventProgress:modelProgress,hooks:src.hooks || [],affectedActorRefs:analysisActors.filter(actor=>!storyAnalysis.handled.some(row=>row.name===actor.name)).map(actor=>actor.actorRef),background:[boundaryBackground,'【必要资料实际检索回信】\n'+JSON.stringify(retrievalReceipt)+'\ncompleted=true且not_found表示真实完成但无命中。未知设定不造假；若现有年表、正文与快照足以判断则依据已有事实定案，不因相同未命中反复索要资料。确实无法定案才保留needs_context，须指出具体缺口。',found.value,'【此前同轮已确认事实与世界边界，编号保留】\n'+JSON.stringify({facts:storyAnalysis.factRecords,worldEvents:storyAnalysis.worldEvents})].filter(Boolean).join('\n\n'),options:{...options,bodyTimeKnown:true}};
    const checkScope=scope=>{
      if(!allPrebuilt)return analyzeStoryBoundary(scope);
      const codes=new Set(scope.events.map(row=>row.code));
      return analyzeStoryBoundary({...scope,prebuilt:prebuilt.filter(row=>codes.has(row.code)),
        options:{...scope.options,prebuiltOnly:true,eventProgressVersion:0}});
    };
    let checked=await checkScope(request);
    if(checked.ok && checked.additionalAffectedRefs?.length){
      checked.additionalAffectedRefs.forEach(ref=>wanted.add(ref));
      const closure=analysisActors.filter(actor=>wanted.has(actor.actorRef)),closureEvents=new Set(closure.flatMap(actor=>actor.eventIds));
      checked=await checkScope({...request,actors:closure,events:events.filter(event=>closureEvents.has(event.code)),background:request.background+'\n【本次材料明确指出的实际受影响闭包，仅重核这些人】\n'+JSON.stringify(checked.actorDecisions)});
      if(checked.ok && checked.additionalAffectedRefs?.length)return {ok:false,reason:'破壁影响继续扩展，须在本轮确认新增依赖，不能静默丢弃或无限重核',inputStamp,range,storyAnalysis,retrievalReceipt};
    }
    if(!checked.ok)return {ok:false,reason:'必要资料补回后的定点边界未完成：'+checked.reason,inputStamp,range,storyAnalysis,retrievalReceipt};
    if(checked.prebuiltUnavailable)return {ok:false,reason:'补取资料后未能核对预制节点例外',inputStamp,range,storyAnalysis,retrievalReceipt};
    // 前台归属或事实修订意味着前置契约变化，不能静默覆盖其他人物已经确认的分工。
    /* ★★ 2026-11-02 全面复盘「合并报错」：原来 2 种情况挤成一句。拆开，各自指出变了什么。 */
    {
      const lostHandled=checked.handled.filter(row=>!storyAnalysis.handled.some(old=>old.name===row.name)).map(row=>row.name);
      if(lostHandled.length)return {ok:false,reason:'补回材料后，这些人物从「正文已处理」里消失了：'+lostHandled.map(n=>'「'+n+'」').join('、')+'；材料变化不应改变前台归属，请继续本轮完整边界确认'};
      const changedFacts=checked.factRecords.filter(row=>!storyAnalysis.factRecords.some(old=>old.id===row.id&&old.text===row.text&&old.evidence===row.evidence)).map(row=>row.id);
      if(changedFacts.length)return {ok:false,reason:'补回材料后，这些正文事实的内容变了：'+changedFacts.map(i=>'「'+String(i)+'」').join('、')+'；同一事实的原文与依据不应因补材料而改变，请继续本轮完整边界确认'};
    }
    // A targeted material lookup cannot erase the already confirmed global prebuilt branch.
    const newInfluences=checked.influences.filter(row=>!storyAnalysis.influences.some(old=>old.name===row.name));
    const revisedNodes=new Map((storyAnalysis.prebuiltNodes||[]).map(row=>[row.id,row]));
    for(const row of checked.prebuiltNodes||[]){
      const old=revisedNodes.get(row.id);
      const settled=old&&old.status==='mutated'&&old.resolution==='occurred';
      if(!settled||row.status!=='mutated'||row.resolution!=='occurred'){
        revisedNodes.set(row.id,row);
        continue;
      }
      const local=new Set(subset.map(actor=>actor.name));
      const mergeNames=(a,b)=>[...new Set([...(a||[]).filter(name=>!local.has(name)),...(b||[])])];
      revisedNodes.set(row.id,{...old,...row,
        actors:mergeNames(old.actors,row.actors),withdrawnActors:mergeNames(old.withdrawnActors,row.withdrawnActors),
        clearedActors:mergeNames(old.clearedActors,row.clearedActors),
        reviseWorld:Boolean(old.reviseWorld||row.reviseWorld),worldDependsOn:mergeNames(old.worldDependsOn,row.worldDependsOn)});
    }
    storyAnalysis={...storyAnalysis,influences:[...storyAnalysis.influences,...newInfluences],actorDecisions:storyAnalysis.actorDecisions.map(row=>checked.actorDecisions.find(next=>next.actorRef===row.actorRef) || row),uncertain:[...(storyAnalysis.uncertain || []),...(checked.uncertain || [])],
      ...(allPrebuilt?{prebuiltNodes:[...revisedNodes.values()]}:{})};
  }
  const decisions=storyAnalysis.actorDecisions;
  // 本轮时间推进档位决定分工形态，而不是让下游从单人的 canonAdvance 猜。
  // 跨年表事件档：全员完整补演，任务名单来自边界判定的 involvedActors，
  // 不要求边界逐人说明补什么（该档边界只定档位和范围，细节由人物补演阶段展开）。
  // 同事件无进展档：通常 canonJobs 为空、补演流程结束；
  //   但破壁优先级高于档位——若有人被真实变异打破走廊（canonAdvance=break），
  //   这些人仍要进完整补演，其余人不进。下面 push/break 的过滤自然覆盖这一情形。
  const turnAdvanceTier=storyAnalysis.turnAdvanceTier || '';
  const crossActors=Array.isArray(storyAnalysis.involvedActors)?storyAnalysis.involvedActors:[];
  const crossEvents=new Set(Array.isArray(storyAnalysis.coveredEventIds)?storyAnalysis.coveredEventIds:[]);
  const crossJobs=turnAdvanceTier==='crossEvent'?crossActors.map(name=>{
    const actor=analysisActors.find(row=>row.name===name) || {};
    const eventIds=(actor.eventIds || []).filter(id=>!crossEvents.size || crossEvents.has(id));
    return {actorRef:actor.actorRef || name,name,depth:'full',eventIds:eventIds.length?eventIds:(actor.eventIds || [])};
  }):[];
  const unfilteredJobs=crossJobs.length?crossJobs:decisions.filter(row=>row.canonAdvance==='break'||(row.canonAdvance==='push'&&!['sameEventNoProgress','outsideRange'].includes(turnAdvanceTier))).map(row=>({actorRef:row.actorRef,name:row.name,depth:row.canonAdvance==='break'?'full':'incremental',eventIds:row.eventIds}));
  const ordinaryUnreachedEventIds=allPrebuilt?[]:ordinaryUnreachedEvents(candidates,storyAnalysis.eventProgress,progress,range.end,src.storyText);
  const canonJobs=ordinaryUnreachedEventIds.length?unfilteredJobs.map(job=>({...job,eventIds:job.eventIds.filter(id=>!ordinaryUnreachedEventIds.includes(id))})).filter(job=>job.eventIds.length):unfilteredJobs;
  const deferredRefs=decisions.filter(row=>row.canonAdvance==='needs_context').map(row=>row.actorRef);
  const owned=new Set([...canonJobs.map(row=>row.actorRef),...deferredRefs]);
  const turnPlan={version:1,turnAdvanceTier,coveredEventIds:[...crossEvents],involvedActors:crossActors,ordinaryUnreachedEventIds,turnKey:String(src.logId || src.turnNo || ''),inputStamp,range,timelineActorRefs:analysisActors.map(row=>row.actorRef),frontActorRefs:storyAnalysis.handled.map(row=>String(src.characters?.[row.name]?.id || row.name)),decisions,canonJobs,ordinaryTargetRefs:(src.ordinaryTargetRefs || []).filter(ref=>!owned.has(ref)),deferredRefs,mode:canonJobs.some(row=>row.depth==='full')?'normal':canonJobs.length?'scoped':storyAnalysis.eventProgress?.length?'progress_only':'none'};
  // 仅为展示投影，不另存一套进度，也不新增模型判断。
  const candidateIds=new Set(candidates.map(codeOf));
  turnPlan.eventWindows=candidates.map(event=>({eventId:codeOf(event),title:event.title,startAt:event.time_start||event.startAt||'',endAt:event.time_end||event.endAt||'',referenceStart:event.referenceStart||'',referenceEnd:event.referenceEnd||'',timingChange:event.timingChange||null}));
  turnPlan.savedEventProgress=progress.filter(row=>candidateIds.has(row.eventId));
  turnPlan.observedEventProgress=storyAnalysis.eventProgress || [];
  if(ordinaryUnreachedEventIds.length)turnPlan.ordinaryUnreachedEventIds=ordinaryUnreachedEventIds;
  turnPlan.eventWatches=mergeEventWatches(ledger.eventWatches,[...(storyAnalysis.eventWatches||[]),...(src.activatedEvents||[]).map(row=>({...row,status:'confirmed'}))]);
  turnPlan.watchEvents=referenceEvents.filter(event=>turnPlan.eventWatches.some(row=>row.eventId===codeOf(event))).map(event=>({eventId:codeOf(event),title:event.title}));
  return routePrebuiltBoundary({ok:true,inputStamp,resolvedInputStamp:canonBoundaryInputStamp({...src,targetTime:range.end}),range,storyAnalysis,turnPlan,analysisActors,candidates,boundaryBackground,retrievalReceipt,ordinaryCandidates:src.ordinaryTargetRefs||[]},
    {...ledger,turnNo:ledger.turnNo??Math.max(0,(Number(src.turnNo)||1)-1),lastTurn:src.previousTurn||ledger.lastTurn,
      eventProgress:progress,mutationNotes:src.mutationNotes||ledger.mutationNotes});
}

/** 普通阶段已保存的新事实只对实际依赖候选合批复核；不写状态或修改原准备对象。 */
export async function reconcileCanonTurnPlanBoundary(input={}){
  const prepared=input.preparedBoundary;
  if(!prepared?.ok)return {ok:false,reason:'缺少有效前置边界'};
  const oldPlan=prepared.turnPlan;
  // 跨事件档没有逐人decisions，实际共享操作仍须找到已分派的人。
  const originalDecisions=oldPlan.decisions.length?oldPlan.decisions:(oldPlan.canonJobs||[]).map(job=>({...job,canonAdvance:'push'}));
  const allowed=new Set(originalDecisions.map(row=>row.actorRef));
  const actual=new Set((input.affectedRefs || []).filter(ref=>allowed.has(ref)));
  if(input.worldChanged===true)for(const ref of allowed)actual.add(ref);
  const records=input.ordinarySettlement?.records || [];
  if(!actual.size || !records.length)return {ok:true,preparedBoundary:prepared,invalidatedActorRefs:[],fullJobs:[],continuationJobs:[],needsContinuation:false};
  const subset=prepared.analysisActors.filter(actor=>actual.has(actor.actorRef)).map(actor=>({...actor,state:projectActorProfile(input.ordinarySettlement?.afterRows?.[actor.actorRef] || actor.state)}));
  const eventIds=new Set(subset.flatMap(actor=>actor.eventIds));
  const events=prepared.candidates.filter(event=>eventIds.has(codeOf(event))).map(event=>({...event,code:codeOf(event),text:renderEventMaterial(event,{maxChars:0}).text}));
  const checked=await analyzeStoryBoundary({host:input.host,storyText:input.storyText || '',actors:subset,people:prepared.analysisActors.map(actor=>({name:actor.name,isCanon:true})),events,range:prepared.range,currentTime:prepared.range.end,affectedActorRefs:[...allowed],extraSourceRefs:records.map(row=>row.id),background:String(prepared.boundaryBackground || '')+'\n【普通阶段实际成功回执及最新快照，只证明已保存事实】\n'+JSON.stringify(projectOrdinarySettlement(input.ordinarySettlement))+'\n【原共享边界】\n'+JSON.stringify(prepared.storyAnalysis)+'\n本次只复核所给依赖候选，依据成功回执判断实际外力是否改变原著要求或打破走廊。只升级真正有因果者，其他人维持原结论；sourceRefs允许使用成功回执id。不得把普通回执伪造为玩家正文原句，facts和handled只依实际主正文。',options:{...input.options,canonPushBoundaryVersion:1,bodyTimeKnown:true,eventProgressVersion:0}});
  if(!checked.ok)return {ok:false,reason:checked.reason,preparedBoundary:prepared,invalidatedActorRefs:[...actual]};
  if(checked.additionalAffectedRefs?.length){
    if(input.scopeExpansion)return {ok:false,reason:'实际依赖影响闭包仍未确认，须继续本轮，不允许忽略新增受影响者',preparedBoundary:prepared,invalidatedActorRefs:[...actual,...checked.additionalAffectedRefs]};
    return reconcileCanonTurnPlanBoundary({...input,affectedRefs:[...actual,...checked.additionalAffectedRefs],scopeExpansion:true});
  }
  const decisions=originalDecisions.map(row=>checked.actorDecisions.find(next=>next.actorRef===row.actorRef) || row);
  const unresolved=decisions.filter(row=>actual.has(row.actorRef)&&row.canonAdvance==='needs_context');
  if(unresolved.length)return {ok:false,reason:'实际依赖的走廊尚未确认，须在本轮补取材料继续',preparedBoundary:prepared,invalidatedActorRefs:unresolved.map(row=>row.actorRef)};
  const invalidatedActorRefs=decisions.filter(row=>actual.has(row.actorRef)&&JSON.stringify(row)!==JSON.stringify(originalDecisions.find(old=>old.actorRef===row.actorRef))).map(row=>row.actorRef);
  const invalidated=new Set(invalidatedActorRefs);
  // 跨事件档的分工来自 involvedActors 全员，复核时不能被逐人 decisions 冲掉。
  const canonJobs=(oldPlan.turnAdvanceTier==='crossEvent'&&(oldPlan.canonJobs||[]).length)
    ? oldPlan.canonJobs
    : decisions.filter(row=>['push','break'].includes(row.canonAdvance)).map(row=>({actorRef:row.actorRef,name:row.name,eventIds:row.eventIds,depth:row.canonAdvance==='break'?'full':'incremental'}));
  const continuationJobs=canonJobs.filter(row=>invalidated.has(row.actorRef));
  const turnPlan={...oldPlan,decisions,canonJobs,deferredRefs:decisions.filter(row=>row.canonAdvance==='needs_context').map(row=>row.actorRef),mode:canonJobs.some(row=>row.depth==='full')?'normal':canonJobs.length?'scoped':oldPlan.mode};
  return {ok:true,preparedBoundary:{...prepared,turnPlan,storyAnalysis:{...prepared.storyAnalysis,actorDecisions:decisions},dependencyReceipt:{recordIds:records.map(row=>row.id),affectedRefs:[...actual]}},invalidatedActorRefs,continuationJobs,fullJobs:continuationJobs.filter(row=>row.depth==='full'),needsContinuation:invalidatedActorRefs.length>0};
}

