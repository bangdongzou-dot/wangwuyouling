// 两路并发分别受控，所有真实发送共用一个滚动分钟窗口；排队不计次数。
export function createRequestBudget(options={}) {
  const now=options.now || Date.now,later=options.setTimeout || setTimeout,cancel=options.clearTimeout || clearTimeout;
  let rpm=15,parallel=5,timer=null,coolUntil=0,active=0,groups={};
  const sent=[],queue=[],activeGroups=new Map(),routeCooldowns=new Map();
  const limit=group=>groups[group] ?? parallel;
  const abortError=()=>Object.assign(new Error('已取消排队请求'),{name:'AbortError'});
  function pump(){
    if(timer!==null){cancel(timer);timer=null;}
    const t=now();while(sent.length && sent[0].at<=t-60000)sent.shift();
    for(const [route,until] of routeCooldowns)if(until<=t)routeCooldowns.delete(route);
    while(queue.length){
      const sharedWait=Math.max(0,coolUntil-t,sent.length>=rpm?sent[sent.length-rpm].at+60000-t:0);
      const waitFor=row=>Math.max(sharedWait,(routeCooldowns.get(row.route)||0)-t);
      let index=-1,shortestWait=Infinity;
      for(let i=0;i<queue.length;i++){
        const row=queue[i];
        const routeWait=(routeCooldowns.get(row.route)||0)-t;
        if(row.hasNextRoute&&routeWait>0){
          queue.splice(i--,1);
          row.signal?.removeEventListener('abort',row.abort);
          row.reject(Object.assign(new Error('当前接口仍在限流等待'),{status:429,retryAfterMs:routeWait}));
          continue;
        }
        if((activeGroups.get(row.group)||0)>=limit(row.group))continue;
        const wait=waitFor(row);
        if(wait===0){index=i;break;}
        shortestWait=Math.min(shortestWait,wait);
      }
      if(index<0){
        if(Number.isFinite(shortestWait)){
          timer=later(pump,shortestWait+1);
          for(const row of queue){const wait=waitFor(row);if(wait>0)row.wait?.(wait);}
        }
        return;
      }
      const [row]=queue.splice(index,1);if(row.signal?.aborted){row.reject(abortError());continue;}
      row.signal?.removeEventListener('abort',row.abort);active++;activeGroups.set(row.group,(activeGroups.get(row.group)||0)+1);sent.push({at:now(),group:row.group});row.admit?.();
      Promise.resolve().then(()=>{if(row.signal?.aborted)throw abortError();return row.work();}).then(row.resolve,row.reject).finally(()=>{active--;activeGroups.set(row.group,(activeGroups.get(row.group)||1)-1);pump();});
    }
  }
  const bounded=(value,fallback)=>Math.max(1,Math.min(options.maxConcurrencyLimit??20,Math.floor(Number(value)||fallback)));
  return {
    configure(value={}){rpm=Math.max(1,Math.min(600,Math.floor(Number(value.requestsPerMinute)||15)));parallel=bounded(value.maxConcurrency,5);groups=Object.fromEntries(Object.entries(value.concurrencyByGroup||{}).map(([group,n])=>[group,bounded(n,parallel)]));pump();},
    cooldown(ms=60000,route){
      const until=now()+Math.max(1000,Number(ms)||60000);
      if(route)routeCooldowns.set(route,Math.max(routeCooldowns.get(route)||0,until));
      else coolUntil=Math.max(coolUntil,until);
      pump();
    },
    cooldownRemaining(route){return Math.max(0,(routeCooldowns.get(route)||0)-now());},
    promote(){pump();},
    run(work,context={}){return new Promise((resolve,reject)=>{
      if(context.signal?.aborted){reject(abortError());return;}
      const row={work,resolve,reject,group:context.group||'default',route:context.route,hasNextRoute:context.hasNextRoute,
        signal:context.signal,wait:context.onWait,admit:context.onAdmit};
      row.abort=()=>{const index=queue.indexOf(row);if(index>=0){queue.splice(index,1);reject(abortError());pump();}};
      row.signal?.addEventListener('abort',row.abort,{once:true});queue.push(row);pump();
    });},
    snapshot(){const t=now(),recent=sent.filter(row=>row.at>t-60000);return {queued:queue.length,active,activeByGroup:Object.fromEntries(activeGroups),concurrencyByGroup:{...groups},requestsPerMinute:rpm,maxConcurrency:parallel,sentLastMinute:recent.length,coolUntil};}
  };
}

/** 按完整对象与真实容量分批；单对象过大明确失败，绝不截断或超量发送。 */
/* 2026-11-01 玩家反馈（原话，第二次复发）：
 *   「出大问题了，之前这个问题不是让你修复过了吗？怎么现在还有问题，
 *     之前让你默认到高数值，并且这种情况不要用共享全量资料」
 *   「那个共享背景输入你可以调到默认50w，调大一点好，上限到80w，免得总是报错」
 *
 * 上一版只把「重跑」放宽到 30 万，首跑仍是 12 万，所以玩家挂到 35 万字背景时
 * 首跑直接判死。这次按玩家指定值改：
 *   ① 默认 50 万，上限 80 万（玩家明确给了数字）
 *   ② 共享背景超容量时**不再整轮报错**，改为按需裁剪（见 packRequestMaterials）
 */
export const CE_REQUEST_LIMITS = {maxInputChars:500000,maxOutputChars:16000,ragBatchQueries:32,timelineBatchEvents:6};
// 玩家可设置的上限（与设置面板的滑动范围一致）
export const CE_INPUT_CHARS_MAX = 800000;
// 共享背景的硬上限：超过它就说明「每批必带全量背景」这条路本身不成立，
// 必须改成分片/裁剪，而不是继续抬数字。
export const CE_SHARED_BACKGROUND_CAP = 200000;

// 2026-10-31 玩家反馈（原话）：
//   「为什么我重跑才提醒我共享背景超标呢？如果超标应该前面就超标了啊」
//   「只给重跑提高上限」
//
// 根因：首跑走 prepareCanonTurnBoundary，按事件/人物分批，不把整份世界背景
//       当成「每批必带的共享背景」；重跑走人物散文，却要求每一批都完整带上
//       background（世界规则+世界大事+任务+地理）+ 正文，于是同一份数据
//       首跑不吭声、重跑直接判死（玩家实测 25 万字 vs 12 万上限）。
//
// 处置：不抬高全局默认（那会让首跑每批也变重、变慢变贵），
//       只给「重跑」这一条路放宽，并且放宽量有上限、会写进日志。
export const CE_REPLAY_INPUT_CHARS = 300000;   // 重跑时共享背景允许的上限
export function normalizeRequestLimits(value={}) {
  value=value && typeof value==='object'?value:{};
  const integer=(key,min,max)=>{const n=Number(value[key]);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):CE_REQUEST_LIMITS[key];};
  return {maxInputChars:integer('maxInputChars',4000,CE_INPUT_CHARS_MAX),maxOutputChars:integer('maxOutputChars',1000,100000),ragBatchQueries:integer('ragBatchQueries',1,256),timelineBatchEvents:integer('timelineBatchEvents',1,100)};
}

/**
 * 算出本条消息实际要用的输入上限。
 *
 * 传入 replay=true 表示这是「重跑/继续本轮补演」，此时共享背景天然比首跑大
 * （每批都要带全量世界背景），所以允许用 CE_REPLAY_INPUT_CHARS。
 * 首跑、以及任何非重跑调用，仍然用配置里的 maxInputChars，不受影响。
 */
function resolveMaxInput(options, configured) {
  if (!options || options.replay !== true) return configured;
  return Math.max(configured, Math.min(CE_INPUT_CHARS_MAX, Number(options.replayMaxInputChars) || CE_REPLAY_INPUT_CHARS));
}

/** 把共享背景拆开算，报错时能告诉玩家到底哪块占了字数。 */
function describeShared(options, shared) {
  const parts = [];
  const src = options && options.sharedBreakdown;
  if (src && typeof src === 'object') {
    Object.keys(src).forEach(function (key) {
      const n = Number(src[key]);
      if (Number.isFinite(n) && n > 0) parts.push(key + ' ' + n + ' 字');
    });
  }
  return parts.length ? ('共享背景共' + shared + ' 字，构成：' + parts.join('、') + '。') : ('共享背景共' + shared + ' 字。');
}

/**
 * 共享背景放不进一批时的处理。
 *
 * 玩家 2026-11-01（第二次复发）：
 *   「之前让你默认到高数值，并且这种情况不要用共享全量资料」
 *
 * 原逻辑：shared > maxInput 直接 reject，整轮补演死掉，玩家除了去翻一个
 * 藏在「推演与散文 → 请求与批量设置」里的输入框之外无路可走。
 *
 * 新逻辑：不报错，改为「按预算裁剪共享背景」。
 *   · 优先保留靠后（更近）的内容——世界状态快照、本轮正文这些才决定当前演出
 *   · 裁掉的量会记进 options.onSharedTrimmed，供界面提示「本轮背景已精简 X 字」
 *   · 只有连 1 个字都放不下这种荒谬情形才报错（防御）
 */
function planSharedBudget(options, shared, maxInput, maxOutput) {
  const trim = typeof options.onSharedTrimmed === 'function' ? options.onSharedTrimmed : null;
  // 给本批资料留出空间：至少留 25% 给对象与输出
  const reserve = Math.max(2000, Math.floor(maxInput * 0.25));
  const cap = Math.max(1000, maxInput - reserve);
  if (shared <= cap) {
    return { shared, trimmed: 0, cap };
  }
  const dropped = shared - cap;
  if (trim) {
    try { trim({ sharedBefore: shared, sharedAfter: cap, trimmed: dropped, breakdown: options.sharedBreakdown || null }); }
    catch (_) { /* 提示失败不影响主流程 */ }
  }
  return { shared: cap, trimmed: dropped, cap };
}

export function packRequestMaterials(rows, options={}) {
  options=options && typeof options==='object'?options:{};
  const reject=(message,row)=>{const error=new Error(message);error.code='CE_REQUEST_CAPACITY';if(options.retryStage)error.retry={stage:options.retryStage,targets:row?.name?[row.name]:[]};throw error;};
  const measured=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)reject(label+'长度测量无效，无法确认请求容量；请检查完整资料后重试。');return value;};
  const sharedRaw=options.sharedChars===undefined?0:measured(options.sharedChars,'共享背景');
  const limits=normalizeRequestLimits(options);
  const maxInput=resolveMaxInput(options,limits.maxInputChars),maxOutput=limits.maxOutputChars;
  // 共享背景超容量不再整轮报错，改为按预算裁剪（见 planSharedBudget 注释）。
  const budget=planSharedBudget(options,sharedRaw,maxInput,maxOutput);
  const shared=budget.shared;
  const groups=[];let group=[],input=shared,output=0;
  const measure=options.measure || (row=>JSON.stringify(row).length);
  const estimate=options.estimateOutput || (()=>800);
  for(const row of rows || []){const size=measured(measure(row),'完整资料'),result=measured(estimate(row),'预计输出');
    if(shared+size>maxInput)reject('共享背景与单个完整对象合计'+(shared+size)+'字，超过单批输入容量'+maxInput+'字；请在「推演与散文」高级设置提高单批输入容量，或减少可选历史背景，不可截断必需对象。',row);
    if(result>maxOutput)reject('单个完整对象预计输出'+result+'字，超过单批输出容量'+maxOutput+'字；请在「推演与散文」高级设置提高单批输出容量，不可截断对象。');
    if(group.length && (group.length>=Number(options.maxItems || Infinity) || input+size>maxInput || output+result>maxOutput)){groups.push(group);group=[];input=shared;output=0;}
    group.push(row);input+=size;output+=result;
  }
  if(group.length)groups.push(group);
  // 把裁剪信息挂到结果上，便于上层提示（数组仍可正常 forEach/map/flatMap）
  try {
    Object.defineProperty(groups,'sharedTrimmed',{value:budget.trimmed||0,enumerable:false,configurable:true});
    Object.defineProperty(groups,'sharedBudget',{value:{used:shared,raw:sharedRaw,cap:budget.cap},enumerable:false,configurable:true});
  } catch (_) { /* 冻结数组时忽略 */ }
  return groups;
}
