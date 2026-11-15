// 两份叙事可以交叉；语义重复交模型判断，程序只守协议与操作边界。
import {withRetry} from './retry.js';
import {parseJsonLoose} from './diff.js';
import {packRequestMaterials} from './request-budget.js';

export function splitSettlementCandidates(proposal={}) {
  const rows=[];
  for(const [kind,key]of [['characters','characterDelta'],['items','itemOperations'],['misc','miscDelta']])for(const raw of proposal[key]||[]){
    if(kind==='characters'&&raw.command==='add'&&raw.data&&typeof raw.data==='object'){
      for(const field of Object.keys(raw.data).filter(key=>key!=='0'))rows.push({kind,operation:{...raw,data:{[field]:raw.data[field]}}});
    }else rows.push({kind,operation:structuredClone(raw)});
  }
  return rows.map((row,index)=>({...row,id:'P'+(index+1)}));
}

function sameOperationScope(before,after,kind){
  if(!after||typeof after!=='object'||Array.isArray(after))return false;
  // 身份、命令和字段不能换。仅允许已有数值/描述的净变化修正。
  const mutable=kind==='items'?new Set(['quantity','amount','count']):new Set(['data','value','current','max']);
  const keys=new Set([...Object.keys(before),...Object.keys(after)]);
  for(const key of keys){
    if(!mutable.has(key)){if(JSON.stringify(before[key])!==JSON.stringify(after[key]))return false;continue;}
    if(!Object.hasOwn(before,key)||!Object.hasOwn(after,key))return false;
    if(key==='data'){
      if(!before.data||!after.data||typeof before.data!=='object'||typeof after.data!=='object'||Array.isArray(after.data))return false;
      if(!Object.keys(after.data).length||Object.keys(after.data).some(field=>!Object.hasOwn(before.data,field)))return false;
      if(Object.hasOwn(before.data,'0')&&before.data['0']!==after.data['0'])return false;
    }
    if(kind==='items'&&(!Number.isFinite(Number(after[key]))||Number(after[key])<0))return false;
  }
  return true;
}

export function parseSettlementReview(raw,input={}){
  const parsed=parseJsonLoose(raw),rows=parsed?.decisions,candidates=input.candidates||[],records=new Map((input.records||[]).map(row=>[row.id,row]));
  const fail=reason=>({ok:false,reason:'变量重复核验未完成：'+reason});
  if(!Array.isArray(rows)||rows.length!==candidates.length)return fail('候选操作必须逐项返回，不得漏项');
  const seen=new Set(),out={ok:true,characterDelta:[],itemOperations:[],miscDelta:[],covered:[],decisions:[]};
  for(const row of rows){
    const source=candidates.find(item=>item.id===row?.id);
    if(!source||seen.has(row.id))return fail('操作编号未知或重复');seen.add(row.id);
    if(!['new','covered','conflict'].includes(row.verdict)||!String(row.reason||'').trim())return fail(row.id+'缺少明确判定与理由');
    if(row.verdict==='conflict')return fail(row.id+'存在冲突：'+row.reason);
    const ownSource=source.sourceId?(input.sources||[]).find(item=>item.id===source.sourceId)?.proseText:input.proseText;
    if(typeof row.evidence!=='string'||!row.evidence.trim()||!String(ownSource||'').includes(row.evidence))return fail(row.id+'缺少本人补演的逐字原句');
    if(!Array.isArray(row.settledIds)||row.settledIds.some(id=>!records.has(id)))return fail(row.id+'引用了未成功或不存在的结算记录');
    if(row.verdict==='covered'&&!row.settledIds.length)return fail(row.id+'声称已结算但没有成功依据');
    const operation=row.operation===undefined?source.operation:row.operation;
    if(!sameOperationScope(source.operation,operation,source.kind))return fail(row.id+'修正越过原操作的实体、命令或字段');
    const decision={...row,kind:source.kind,operation:structuredClone(operation)};out.decisions.push(decision);
    if(row.verdict==='covered')out.covered.push(decision);else out[{characters:'characterDelta',items:'itemOperations',misc:'miscDelta'}[source.kind]].push(decision.operation);
  }
  return out;
}

export async function reviewSettlement(input={}){
  if(!(input.candidates||[]).length)return {ok:true,characterDelta:[],itemOperations:[],miscDelta:[],covered:[],decisions:[]};
  const options=input.options||{};
  const instructions='你负责核对同一楼层普通演化与人物补演之间的重复结算。完整本人故事允许重述组队、赠物或战斗，不代表再发生一次。逐项判断候选操作：new为真正新增或普通阶段未落实的变量；covered为有成功回执支持的同一次变化；conflict为不能确认或与既定事实冲突。只处理当前人物，世界或共享转移按整次事实结算，不因两人都讲述而重复执行。\n'
    +'同一字段在普通阶段写过不是重复的充分条件，受伤后疗伤、得到后消耗、同额不同次交易都可能是新增。新内心或动机可更新，不能把未写明的态度加成再加一次。以当前快照为基线推导截至当前时点的净新增结果，早先经历不得覆盖后来已确认事实。失败请求和仅仅出现在正文中不等于变量已落实。\n'
    +'可以用operation修正本候选的净新增值，但不能换命令、人物、物品、收付双方或增加未核对字段。新增事实必须有本人正文原句。covered必须引用records中真实成功记录的id；快照记录只证明当下状态，不能凭余额相同推断两笔交易是同一件事。无法判断时conflict，不能假成功。\n'
    +'只返回JSON：{"decisions":[{"id":"候选P编号","verdict":"new或covered或conflict","evidence":"本人正文连续原句","settledIds":["实际依据记录编号，可为空"],"reason":"语义与时序依据","operation":"仅需修正时填完整同范围操作对象，否则省略"}]}。每条候选恰好一项。\n';
  const payload={name:input.name,storyText:input.storyText,...(input.sources?{sources:input.sources}:{proseText:input.proseText}),records:input.records||[],snapshot:input.snapshot||{},candidates:input.candidates};
  const scopeInstruction=input.sources?'\n本次合批处理多个人物。sources给出每人的独立正文与快照，候选sourceId指明归属。evidence必须摘自该source的正文，不许串人物；共享转交仍只结算一次。\n':'';
  const messages=[{role:'user',content:instructions+scopeInstruction+JSON.stringify(payload)}];
  let checked;
  const result=await withRetry(async({correct})=>input.host.llmCall(correct({stage:'变量重复核验',subject:input.name||'',messages,signal:options.signal})),{signal:options.signal,config:options.retry||{},onRetry:options.onRetry,
   // 不合格必须交给 withRetry 走「带纠正的重试」：直接 throw 只会原样重发，
   // 模型看不到上次哪条候选判错、错成什么，重试必然再犯同样的错。
   validate:(raw)=>{
     const value=checked=parseSettlementReview(raw,input);
     if(value.ok)return {ok:true};
     const candidates=(input.candidates||[]).map(row=>String(row&&row.id||'')).filter(Boolean);
     const items=[];
     const bad=(value.decisions||[]).filter(row=>!row||row.verdict===undefined);
     if(bad.length)items.push({label:'决策缺失或verdict不合法',actual:bad.map(row=>String(row&&row.id||'?')).join('、'),hint:'verdict 只能是 new/covered/conflict'});
     if(!items.length&&value.reason)items.push({label:String(value.reason)});
     return {ok:false,reason:String(value.reason||'变量重复核验不合格'),correction:{expected:candidates,items,hint:'每条候选恰好一项决策，无法判断用 conflict，不能假成功'}};
   }});
  return result.ok?checked:{ok:false,reason:result.reason||'变量重复核验未完成'};
}

/** 同楼层就绪候选合并核验；不等待尚未生成正文的人物。 */
export function createSettlementReviewBatcher(options={}){
  let pending=[],timer=null,sealed=false;
  const delay=Math.max(0,Math.min(200,Number(options.waitMs) || 0));
  const aborted=()=>Object.assign(new Error('已取消变量核验'),{name:'AbortError'});
  async function flush(){
    timer=null;const ready=pending.splice(0).filter(row=>{if(row.input.options?.signal?.aborted){row.reject(aborted());return false;}return true;});
    if(!ready.length){options.onIdle?.();return;}
    let groups;
    try{groups=packRequestMaterials(ready,{...options.limits,sharedChars:String(ready[0].input.storyText||'').length+4000,measure:row=>JSON.stringify([row.input.name,row.input.proseText,row.input.snapshot,row.input.records,row.input.candidates]).length,estimateOutput:row=>row.input.candidates.length*600});}
    catch(error){ready.forEach(row=>row.reject(error));options.onIdle?.();return;}
    await Promise.all(groups.map(async group=>{
      const controller=new AbortController(),detach=[];
      try{
        const records=new Map(),candidates=[],sources=[],routes=new Map();
        group.forEach((row,index)=>{
          const input=row.input,sourceId='S'+index;sources.push({id:sourceId,name:input.name,proseText:input.proseText,snapshot:input.snapshot});
          for(const record of input.records||[]){const old=records.get(record.id);if(old&&JSON.stringify(old)!==JSON.stringify(record))throw new Error('同批核验回执内容冲突：'+record.id);records.set(record.id,record);}
          for(const candidate of input.candidates){const id='P'+(candidates.length+1);routes.set(id,{row,id:candidate.id});candidates.push({...candidate,id,sourceId});}
          const signal=input.options?.signal,check=()=>{if(group.every(own=>own.input.options?.signal?.aborted))controller.abort(aborted());};
          signal?.addEventListener('abort',check,{once:true});detach.push(()=>signal?.removeEventListener('abort',check));check();
        });
        const first=group[0].input;
        const result=await (options.review||reviewSettlement)({...first,name:group.map(row=>row.input.name).join('、'),sources,records:[...records.values()],candidates,snapshot:{},options:{...first.options,signal:controller.signal}});
        if(!result.ok){group.forEach(row=>row.resolve(result));return;}
        group.forEach(row=>{
          if(row.input.options?.signal?.aborted){row.reject(aborted());return;}
          const decisions=(result.decisions||[]).filter(item=>routes.get(item.id)?.row===row).map(item=>({...item,id:routes.get(item.id).id}));
          const own={ok:true,decisions,covered:decisions.filter(item=>item.verdict==='covered'),characterDelta:[],itemOperations:[],miscDelta:[]};
          decisions.filter(item=>item.verdict!=='covered').forEach(item=>own[{characters:'characterDelta',items:'itemOperations',misc:'miscDelta'}[item.kind]].push(item.operation));row.resolve(own);
        });
      }catch(error){group.forEach(row=>row.reject(error));}finally{detach.forEach(fn=>fn());}
    }));
    options.onIdle?.();
  }
  return {
    /** 登记一条待核验候选；返回的 Promise 在本次合并核验完成后结算。 */
    enqueue(input){return new Promise((resolve,reject)=>{
      pending.push({input,resolve,reject});
      // 合批成员由调用方的显式闭批决定，不由计时器竞速决定。
      // 计时器只做「上限兜底」：从第一条登记开始计一个最长等待，
      // 期间不断有人到达也不重置它，所以不会因为来一个就往后拖。
      // waitMs=0 表示「不要等」，用 0 延时立刻发送（不能干脆不设定时器，
      // 那样在没有 seal() 的调用方会永远挂住）。
      if(timer===null)timer=setTimeout(()=>{timer=null;if(pending.length)flush();},delay);
    });},
    /**
     * 显式闭批：调用方明确表示「本楼层该来的人都来了」，立即发送。
     * 合批成员由调用方按真实返回包确定，不再依赖计时器竞速。
     */
    seal(){
      sealed=true;
      if(timer!==null){clearTimeout(timer);timer=null;}
      if(pending.length)return flush();
      options.onIdle?.();
      return Promise.resolve();
    },
    get sealed(){return sealed;},
    get pending(){return pending.length;},
  };
}
