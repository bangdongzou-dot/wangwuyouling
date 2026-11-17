// Diagnostic records only. Uses the original settings table; never supplies game facts.
var frCanonTraceHistory = [];
/* 2026-11-03 边跑边存节流表（键 = 存档:楼层:系统）。
 * 目的是「跑一点显示一点」，同时不让高频事件反复整表覆盖写拖住主线程。 */
var frCanonLivePersistAt = {};
var frCanonLivePersistTimer = {};
var frCanonTraceArchive = '';
/* ★★★ 2026-11-02 楼层号唯一口径（纯函数，不依赖任何面板是否先跑过）
 *
 * 玩家两次反馈：
 *   「当前应该是第二层快照，为什么原著人物故事显示第三层？」
 *   「原著补演展示的当前回合你是不是忘记修改了？」
 *
 * 病根不在算法，在**时机**。原来把算法挂在 window 上，但那段代码写在
 * main.js 的「打开人生快照面板」函数体内 —— 只有打开那个面板时才执行。
 * 而补演面板、原著人物故事平时先开，那时 window 上什么都没有，
 * 于是永远走「logs 数组真实下标」的退路，把 isSnapshot / isUndoSnapshot
 * 这些隐藏记录也数了进去，楼层号就差一位。
 *
 * 现在把算法写成这里的顶层纯函数：给一份存档 + 一个 logId，当场算出来。
 * 谁调用都不用关心别人有没有先跑过。口径与人生快照面板完全一致：
 *   · 跳过 isSnapshot / isUndoSnapshot
 *   · 深度合并按 mergedCount 记成「第 N-M 层 (深度合并)」
 */
function frBuildFloorDisplayMapPure(archiveLike){
  var logs=[];
  try{
    if(archiveLike&&archiveLike.data&&Array.isArray(archiveLike.data.logs))logs=archiveLike.data.logs;
    else if(Array.isArray(archiveLike))logs=archiveLike;
    else if(archiveLike&&Array.isArray(archiveLike.logs))logs=archiveLike.logs;
  }catch(_){logs=[];}
  var map=new Map(),counter=1;
  logs.forEach(function(log){
    if(!log||log.isSnapshot||log.isUndoSnapshot)return;
    if(log.isDeepSummary){
      var count=log.mergedCount||10;
      map.set(log.id,{displayText:'第 '+counter+'-'+(counter+count-1)+' 回合 (深度合并)',realFloor:counter});
      counter+=count;
    }else{
      map.set(log.id,{displayText:'第 '+counter+' 回合',realFloor:counter});
      counter++;
    }
  });
  return map;
}
function frFloorLabelOf(logId,archiveLike){
  var key=String(logId||'');
  if(!key)return '';
  try{
    var hit=frBuildFloorDisplayMapPure(archiveLike).get(key);
    return hit&&hit.displayText?String(hit.displayText):'';
  }catch(_){return '';}
}
/* 楼层号缓存：渲染是同步的，但存档要异步读，所以用「异步预取 + 同步取用」。
 *
 * 2026-11-02 玩家：「原著补演展示的当前回合你是不是忘记修改了？」
 * 「原著人物故事还是显示第三层」。
 *
 * 这两处都死在同一个地方：楼层号算法本身是对的，但**拿不到存档的 logs**。
 *   · window.__frFloorDisplayMap 只在打开人生快照面板时才生成；
 *   · frCanonTraceArchive 存的是存档名（字符串），不是存档对象。
 * 所以这里维护一份按存档名缓存的 logs 顺序表，任何人随时可以同步查楼层号；
 * 缓存失效（切存档、快照回退、重roll）后由 frCanonFloorCacheRefresh 重新拉。
 */
var frCanonFloorCache={archiveName:'',logs:null};
function frCanonFloorCacheSet(archiveName,logs){
  frCanonFloorCache={archiveName:String(archiveName||''),logs:Array.isArray(logs)?logs:null};
}
function frCanonFloorCacheGet(archiveName){
  var want=String(archiveName||'');
  if(!want)return null;
  if(frCanonFloorCache.archiveName===want&&Array.isArray(frCanonFloorCache.logs))return frCanonFloorCache.logs;
  return null;
}
/* ★★★ 2026-11-03 玩家把这条线的原则说透了：
 *
 * 「不管是运行日志还是可复用资料，我只希望在本轮看到他，
 *   其他该持久性保存的数据才是直接写入快照，比如说账本。」
 * 「这个清理应该是独立端自己能进行的流程才对，不能说每次来手动清理，
 *   而是我换档或者重roll或者回退本该清理的内容，如果没做到才是问题，
 *   你手动清理反而导致会掩盖这些问题。」
 * 「包括进行下一轮推进剧情也要清理掉临时的内容。」
 *
 * ── 由此定下的两条边界，下面这个函数就是它的唯一执行点 ──
 *
 * 【必须清掉 · 只在本轮可见】
 *   ① 运行记录 frCanonTraceHistory / frCanonTraceActive / frCanonTraceSelected
 *      —— 完整诊断仅在内存；本轮玩家展示由有上限的独立缓存负责。
 *   ② 可复用资料的内存缓存 frCanonFloorCache（楼层号映射）、frCanonFoldMemory（折叠态）
 *   ③ 重跑会话 frReplaySession / frReplaySessionsBySystem / 直跑任务
 *   ④ 待落回的 mid-run 备份 frReplayPending
 *   ⑤ 提前准备中的早启动记录 frCanonEarlyCurrent
 *
 * 【绝对不能碰 · 属于存档快照】
 *   人物表 / 物品表 / 时间地点表 / 世界大事表 / 任务栏 / 技能栏（currentState 七个分表）、
 *   账本 canonLedger、logs 里的正文与楼层、
 *   FR_REPLAY_BASE_V1 / FR_REPLAY_RECOVERY_V1 这两个**跨回合恢复锚点**
 *   （它们是「中断后还能接着重跑」的保险，清了就等于把玩家的回退能力抹掉）。
 *
 * 【触发点必须齐全】换档、重roll、回退快照、推进下一轮 —— 四个边界都要走这里。
 * 之前 main.js 只挂了两处，而且挂的函数根本不存在（typeof 恒 false，从未执行过），
 * 重roll 的四条路径更是一个都没有。那才是真正的问题。
 *
 * @param {string} reason 触发来源；只有同档重roll允许保留指导
 */
function frCanonMayReuseGuidance(reason){return /^重roll-/.test(String(reason||''));}
function frCanonDropTurnDerivedState(reason,{keepWorldview=false}={}){
  if(!keepWorldview&&!frCanonMayReuseGuidance(reason))window.FRWorldview?.traceClear?.();
  try{
    /* ★★★ 2026-11-03 玩家：「原著指导不是可以复用吗？为什么我重roll正文就没了？」
     *
     * 【先把事实记清，别又猜错方向】
     * 这里清的是 frCanonTraceHistory（纯内存运行记录）。
     * 但玩家 2026-11-02 明确交代过：
     *   「原著指导和原著补演是分开的，虽然没有修改行动指令选择情况原著指导内容的话
     *     原著指导是保留旧的，只有原著补演是需要刷新重新渲染」
     * 也就是说 **重roll 正文时，原著指导该留着、补演该刷新**。
     *
     * 而这一行是「一刀切全清」，它把指导记录也一起清掉了。
     * 后面的兜底（frCanonTraceRender 里「当前楼层没记录 → 找含原著指导的那条」）
     * 是在**同一个已被清空的数组**里找，自然永远找不到 →
     * 面板只能显示「暂无运行记录」，正是玩家现在看到的现象。
     *
     * 【修法】不在这里一刀切。指导类记录保留，其余照旧清掉。
     * 这样兜底才有东西可捞，面板能继续显示「本轮沿用的原著指导」。
     * 顺带把清理前后的条数打出来，避免以后又靠静读猜。 */
    if(typeof frCanonCurrentDisplayPending!=='undefined')frCanonCurrentDisplayPending=null;
    var beforeCount=Array.isArray(frCanonTraceHistory)?frCanonTraceHistory.length:0;
    var isGuidanceRun=function(r){
      try{return String((r&&r.phase)||'')==='原著指导';}catch(_){return false;}
    };
    var keepGuidance=frCanonMayReuseGuidance(reason)&&Array.isArray(frCanonTraceHistory)
      ? frCanonTraceHistory.filter(function(r){return isGuidanceRun(r)&&r.archiveName===currentArchiveName;})
      : [];
    var sameFloorAuxiliary=['重roll-变量思维','重roll-世界演化','重roll-正文优化'].includes(reason);
    var keepDisplay=sameFloorAuxiliary?keepGuidance.concat(frCanonTraceHistory.filter(function(run){
      return run.archiveName===currentArchiveName&&run.phase==='正文后补演'&&run.logId&&run.status!=='running'&&!run.branchHidden&&run.result?.rolledBack!==true;
    })):keepGuidance;
    var keepIds=keepDisplay.map(function(r){return r&&r.id;}).filter(Boolean);
    // Auxiliary rerolls do not create a new story floor; keep its canon display.
    if(!sameFloorAuxiliary)frCanonTraceArchive='';
    frCanonTraceHistory=keepDisplay;
    frCanonTraceSelected=(keepIds.indexOf(frCanonTraceSelected)>=0)?frCanonTraceSelected:'';
    frCanonTraceActive=null;
    frCanonTraceRenderTimer=null;
    try{console.warn('[原著补演] 清理本轮派生状态 ('+String(reason||'')+')：'
      +'运行记录 '+beforeCount+' → 保留本轮展示 '+keepDisplay.length+' 条');}catch(_){}

    /* ② 可复用资料的缓存：楼层号随档变，折叠态随回合变，都不该跨轮带 */
    frCanonFloorCache={archiveName:'',logs:null};
    frCanonFoldMemory.clear();

    /* ③ 重跑会话与直跑任务：上一轮的 session 留着会让下一轮误判「还在跑」 */
    if(typeof frReplaySessionsBySystem==='object'&&frReplaySessionsBySystem){
      frReplaySessionsBySystem.canon=null;frReplaySessionsBySystem.ce=null;
    }
    if(typeof frReplayDirectTasksBySystem==='object'&&frReplayDirectTasksBySystem){
      frReplayDirectTasksBySystem.canon=null;frReplayDirectTasksBySystem.ce=null;
    }
    if(typeof frReplaySession!=='undefined')frReplaySession=null;
    if(typeof frReplayDirectTask!=='undefined')frReplayDirectTask=null;

    /* ④ 待落回的 mid-run 备份：本轮结束就没有「待落回」这回事了。
     *    注意只清内存表 frReplayPending，**不动** FR_REPLAY_* 两个持久锚点。 */
    if(typeof frReplayPending==='object'&&frReplayPending){
      Object.keys(frReplayPending).forEach(function(k){delete frReplayPending[k];});
    }

    /* ⑤ 早启动准备记录：属于上一轮的中间产物 */
    if(typeof frCanonEarlyCurrent!=='undefined')frCanonEarlyCurrent=null;

    /* ⑥ 本轮阶段产物（局部重跑的数据底座）
     * ★★★ 2026-11-03 玩家拍板：「只在本轮存，重roll，推进，回退后都清理」
     *
     * 和上面那些「纯内存、丢了就丢了」的东西不同，这份是**落库**的，
     * 删了要真删，否则会跨回合残留、越攒越多。
     * 各触发点的语义：
     *   推进下一轮 / 回退快照 / 重roll(正文·变量思维·世界演化·变量演化)
     *     → 都是「本轮已经作废」，产物必须清掉，等新一轮重新采集；
     *   切换存档
     *     → 不清：产物按 <存档>:<楼层> 分键，切回来还要能用，清掉反而误伤。
     * 局部重跑本身**不经过这里**（它不清产物，那正是它要复用的东西）。 */
    try{
      var dropReason=String(reason||'');
      var keepForSwitch=dropReason.indexOf('切换存档')===0;
      /* ★★★ 2026-11-03 玩家：「局部重跑是本回合保存」。
       *
       * 【这里曾经把本回合的局部重跑数据整份删掉】
       *   frCanonTurnArtifactsPrune(dropName, '')  ← 传空字符串 = 一层都不留
       * 而它挂在四条 **重roll** 路径（正文优化 / 变量思维 / 世界演化 / 变量演化）上。
       *
       * 重roll 的语义是「**同一回合**里重跑正文」，楼层号其实没变；
       * 这时把本回合的阶段产物删光，后果是：
       *   重roll 之后、新一轮还没跑完的这段时间里，局部重跑面板 0/0，
       *   玩家看到的就是「重启/重roll 之后局部重跑资料又没了」。
       * 而按玩家的口径，它本来就该是**本回合的持久数据**，重启后也在。
       *
       * 【正确边界】
       *   · 推进下一轮 / 回退快照 → 那一轮确实作废，产物该清（保持原行为）；
       *   · 切换存档 → 不清（分层存，切回来还要用，原行为）；
       *   · **重roll → 不清**：同一回合重跑，产物留着给局部重跑做底座；
       *     新一轮跑完会覆盖成新那一层的产物，不会越攒越多。
       * 这样「重roll → 局部重跑」这条最常用的路径才真的能用。 */
      var keepForReroll=dropReason.indexOf('重roll')===0;
      if(!keepForSwitch&&!keepForReroll&&typeof frCanonTurnArtifactsPrune==='function'){
        var dropName=(typeof currentArchiveName==='string')?currentArchiveName:'';
        if(dropName){
          /* currentLogId 传空 = 一份都不留，把本存档的全部产物清掉。
           * 只在「推进下一轮 / 回退快照」这类真正的轮次作废时走到这里。 */
          Promise.resolve(frCanonTurnArtifactsPrune(dropName,'')).catch(function(){});
        }
      }
    }catch(_){}

    /* 面板立刻按新边界重画，别让玩家还看着上一轮的东西 */
    try{ if(typeof frCanonTraceRenderSoon==='function')frCanonTraceRenderSoon(); }catch(_){}
    try{ if(typeof frCanonRefreshSidebarSoon==='function')frCanonRefreshSidebarSoon(); }catch(_){}
    try{ if(typeof console!=='undefined'&&console.debug)console.debug('[原著补演] 本轮临时内容已失效 ('+String(reason||'')+')'); }catch(_){}
  }catch(_){}
}
/* 同步取楼层号：先用手上的缓存，缓存没有就退回宿主映射。
 * （缓存由各面板打开时的异步预取填好，见 frCanonFloorCacheRefresh。） */
function frFloorLabelSync(logId,archiveName){
  var key=String(logId||'');
  if(!key)return '';
  /* ★★★ 优先级必须反过来！这是上一版没修好的真正原因。
   *
   * 2026-11-02 玩家：「当前应该是第二层快照，为什么原著人物故事显示第三层？」
   *         （改完仍然显示第三层）
   *
   * 上一版我让「自己按 logs 下标算」排在「读宿主映射」**前面**，
   * 于是宿主那套（人生快照面板用的、玩家认可的口径）永远轮不到，
   * 显示的还是自己算的下标号 —— 等于没改。
   *
   * 正确优先级：
   *   ① window.__frFloorDisplayMap —— 人生快照面板用的同一份，玩家认可的口径；
   *   ② 自己按 logs 现算 —— 只在宿主还没算出来时兜底。
   */
  try{
    var map=(typeof window!=='undefined'&&window.__frFloorDisplayMap instanceof Map)?window.__frFloorDisplayMap:null;
    if(map&&map.has(key)){
      var hit=map.get(key);
      if(hit&&hit.displayText)return String(hit.displayText);
    }
  }catch(_){}
  var name=String(archiveName||frCanonTraceArchive||'');
  var logs=frCanonFloorCacheGet(name);
  if(logs&&logs.length){
    var text=frFloorLabelOf(key,{data:{logs:logs}});
    if(text)return text;
  }
  return '';
}
async function frCanonFloorCacheRefresh(archiveName){
  var name=String(archiveName||currentArchiveName||'');
  if(!name)return null;
  if(frCanonFloorCacheGet(name))return frCanonFloorCache.logs;
  try{
    if(typeof db==='undefined'||!db.archives)return null;
    var archive=await db.archives.get(name);
    var logs=archive&&archive.data&&Array.isArray(archive.data.logs)?archive.data.logs:null;
    if(Array.isArray(logs)){
      frCanonFloorCacheSet(name,logs);
      return logs;
    }
  }catch(error){console.warn('[楼层号] 读取存档楼层顺序失败:',error);}
  return null;
}
var frCanonTraceBranch = null;
var frCanonTraceSignals = new WeakMap();
// 节点详情只读已有回信；全页同一时刻仅一个，重绘和关闭都会清理监听。
var frCanonPointerClose=null;
function frCanonOpenNode(anchor,row){
  if(frCanonPointerClose)frCanonPointerClose();
  var panel=document.createElement('aside');panel.className='fr-pointer-popup';panel.setAttribute('role','dialog');panel.setAttribute('aria-label',row.title||'节点详情');
  function text(tag,value){var n=document.createElement(tag);n.textContent=String(value||'未记录');panel.appendChild(n);return n;}
  panel.dataset.open='true';var heading=text('p','');heading.textContent='';heading.className='fr-pointer-pop-h';var badge=document.createElement('span');badge.className='fr-pointer-tag is-'+row.state;badge.textContent={done:'已完成',todo:'未发生',mutated:'节点变异',created:'新增变异'}[row.state]||'节点';heading.appendChild(badge);heading.appendChild(document.createTextNode(row.title||'节点详情'));
  var labels=row.state==='created'?{cause:'变异原因',result:'变异结果',handling:'处理方式'}:row.state==='mutated'?{original:'原节点',cause:'变异原因',result:'变异结果',handling:'处理方式'}:row.state==='done'?{result:'阶段结果',actors:'涉及人物',...(!row.timeEstimate?.estimated?{at:'完成于'}:{})}:{original:'原著节点',cause:'当前状态'};
  Object.entries(labels).forEach(function(pair){var line=document.createElement('div');line.className='fr-pointer-pop-row';var k=document.createElement('span');k.className='k';k.textContent=pair[1];var v=document.createElement('span');v.className='v';v.textContent=String((Array.isArray(row[pair[0]])?row[pair[0]].join('、'):row[pair[0]])||(pair[0]==='original'?row.title:'')||'未记录');line.append(k,v);panel.appendChild(line);});
  if(row.timing)text('p','参考时间 '+row.timing.from+(row.timing.to&&row.timing.to!==row.timing.from?'–'+row.timing.to:'')+' · '+row.timing.basis).className='fr-pointer-estimate-basis';
  if(row.receipt)text('p',(row.receipt.at?'实际发生 '+row.receipt.at:'确认于 '+row.receipt.confirmedAt)+
    (row.receipt.evidence?' · '+row.receipt.evidence:'')).className='fr-pointer-estimate-basis';
  if(row.timeEstimate?.estimated&&!row.timing){
    var timingLine=document.createElement('div');timingLine.className='fr-pointer-pop-row';var timingKey=document.createElement('span');timingKey.className='k';timingKey.textContent='推算时间';var timingValue=document.createElement('span');timingValue.className='v';timingValue.textContent=row.timeEstimate.label;timingLine.append(timingKey,timingValue);panel.appendChild(timingLine);
    text('p',row.timeEstimate.basis||'依据本轮时间与事件进展推算，尚非确认发生日。').className='fr-pointer-estimate-basis';
  }
  var close=text('button','×');close.className='fr-pointer-pop-close';close.type='button';close.setAttribute('aria-label','关闭节点详情');document.body.appendChild(panel);anchor.setAttribute('aria-expanded','true');
  function locate(){var rect=anchor.getBoundingClientRect(),width=Math.min(300,(window.innerWidth||800)-20);panel.style.width=width+'px';
    var left=Math.max(10,Math.min(rect.left+rect.width/2-width/2,(window.innerWidth||800)-width-10));panel.style.left=left+'px';panel.style.setProperty('--arrow',Math.max(16,Math.min(width-16,rect.left+rect.width/2-left))+'px');
    var height=panel.getBoundingClientRect().height,bottom=rect.bottom;if(anchor.classList.contains('fr-pointer-node'))bottom+=30;
    var top=bottom+14;panel.dataset.side='below';if(top+height>(window.innerHeight||800)-10&&rect.top-height-14>=10){top=rect.top-height-14;panel.dataset.side='above';}panel.style.top=Math.max(10,Math.min(top,(window.innerHeight||800)-height-10))+'px';}
  locate();
  function dismiss(){panel.remove();anchor.setAttribute('aria-expanded','false');anchor.dispatchEvent(new Event('fr-pointer-dismiss'));document.removeEventListener('click',outside,true);document.removeEventListener('keydown',key);window.removeEventListener('resize',dismiss);document.removeEventListener('scroll',locate,true);frCanonPointerClose=null;}
  function outside(e){
    /* 玩家反馈：点节点详情的 × 会把整个补演 UI 一起关掉。
     *
     * 根因（已核实）：补演面板 #thinking-log-popup 上挂着
     *   document.addEventListener('click', e=>{
     *     if(!thinkBtn.contains(e.target) && !thinkPopup.contains(e.target))
     *       thinkPopup.classList.add('hidden');   // 整个补演 UI 消失
     *   });
     * 而节点详情面板是 append 到 document.body 的，在 thinkPopup 之外，
     * 所以点它的 × 会被判定成「点了面板外部」。
     *
     * 两层防护：
     *   ① × 的 onclick 里 stopPropagation，事件不再往上冒；
     *   ② 这里用捕获阶段监听 + 显式放行自身元素，双保险。
     * 任一层生效都不会误关整个 UI。
     */
    if(e.target&&(panel.contains(e.target)||anchor.contains(e.target)))return;
    dismiss();
  }
  function key(e){if(e.key==='Escape'){e.stopPropagation();dismiss();anchor.focus({preventScroll:true});}}
  frCanonPointerClose=dismiss;
  close.onmousedown=function(e){if(e)e.stopPropagation();};
  close.onclick=function(e){
    /* 关键：阻止冒泡。否则这次点击会被 #thinking-log-popup 的
     * 「点外部就隐藏」监听当成点了外面，把整个原著补演 UI 一起关掉。 */
    if(e){e.preventDefault();e.stopPropagation();}
    dismiss();anchor.focus({preventScroll:true});
  };
  /* 弹窗内部任何点击都不往外冒，避免误触外层「点外面就关」的监听。 */
  function stopEvt(e){e.stopPropagation();}
  panel.addEventListener('click',stopEvt);
  panel.addEventListener('mousedown',stopEvt);
  document.addEventListener('click',outside,true);
  document.addEventListener('keydown',key);
  window.addEventListener('resize',dismiss);
  document.addEventListener('scroll',locate,true);
  close.focus({preventScroll:true});
}
function frCanonNodeButton(host,row,cls){var b=document.createElement('button');b.type='button';b.className=(cls||'fr-pointer-node')+' is-'+row.state;b.textContent=row.title;b.title=row.title;b.setAttribute('aria-label',row.title);b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-expanded','false');b.onclick=function(e){e.stopPropagation();if(b.getAttribute('aria-expanded')==='true'){if(frCanonPointerClose)frCanonPointerClose();}else frCanonOpenNode(b,row);};host.appendChild(b);return b;}
function frCanonRenderLedger(host,ledger,key,plan){
  if(!ledger)return;
  var progressById=new Map((ledger.eventProgress||[]).map(row=>[row.eventId,row]));
  var windows=plan?.eventWindows||[],windowById=new Map(windows.map(row=>[row.eventId,row]));
  var excluded=new Set(plan?.prebuiltUnreachedEventIds||plan?.ordinaryUnreachedEventIds||[]);
  var interval=typeof ceBridgeCore==='function'?ceBridgeCore()?.interval:null;
  if(interval&&windows.length&&progressById.size){
    var actual=[...progressById.values()].filter(row=>row.resolved||row.occurred?.length||row.nodes?.some(n=>n.state!=='todo'||n.reachedMilestoneId||n.contributions?.some(c=>c.status==='applied')));
    var known=new Set(actual.map(row=>row.eventId));
    var groups=frCanonBoundaryEventGroups(windows,actual,interval.parseTimePoint(ledger.worldTime),interval.parseTimePoint,interval.parseTimePrecision,[...excluded]);
    if(actual.length)groups.unstarted.forEach(row=>{if(!known.has(row.eventId))excluded.add(row.eventId);});
  }
  var openEvents=(ledger.openEvents||[]).filter(row=>!progressById.get(row.eventId)?.resolved&&(!excluded.has(row.eventId)||Object.keys(row.doneActors||{}).length||
    progressById.get(row.eventId)?.occurred?.length||progressById.get(row.eventId)?.nodes?.some(n=>n.state!=='todo'||n.reachedMilestoneId||n.contributions?.some(c=>c.status==='applied'))));
  var labels={version:'版本',worldTime:'世界时间',turnNo:'轮次',eventId:'事件编号',title:'标题',startAt:'起点',endAt:'参考终点',coveredTo:'已处理到',status:'状态',resolved:'已收尾',current:'实际阶段',occurred:'已发生',pending:'尚未发生',changes:'变异记录',reason:'依据',nodes:'事件节点',timingChange:'时序变异',timingHistory:'时序变异历史',eventIds:'关联事件',actors:'相关人物',from:'起',to:'止',attempts:'尝试次数',doneActors:'已处理人物',recordedAt:'记录于',actualStart:'实际起点',referenceStart:'原著起点',referenceEnd:'原著终点',kind:'类型',who:'人物',text:'内容',hook:'线索',bornTurn:'创建轮次',lastTurn:'最近轮次',closedTurn:'收尾轮次',note:'说明',at:'时间',rangeStart:'区间起',rangeEnd:'区间止',wroteNames:'补成人物',updatedNames:'更新人物',updatedIds:'更新编号',biographyNames:'生平更新',gaps:'未补成',openEventIds:'未结束事件',eventCount:'事件数',actorCount:'人物数',id:'编号'};
  function node(tag,value,parent,cls){var n=document.createElement(tag);if(value!==undefined)n.textContent=String(value);if(cls)n.className=cls;parent.appendChild(n);return n;}
  var names={ongoing:'进行中',completed:'已完成',changed:'已变异',blocked:'受阻',replaced:'已替代',expired:'机会已过',cancelled:'已取消',early:'提前',delayed:'延期',suspected:'变异嫌疑',confirmed:'已确认',dismissed:'已排除',saved:'已保存',ok:'阶段完成',open:'未收尾',closed:'已收尾'};
  function values(parent,obj){
    if(obj===null||obj===undefined||obj===''){node('span','暂无记录',parent,'fr-lg-empty');return;}
    if(typeof obj!=='object'){node('span',typeof obj==='boolean'?(obj?'是':'否'):names[obj]||String(obj),parent);return;}
    if(Array.isArray(obj)){
      if(!obj.length){node('span','无',parent,'fr-lg-empty');return;}
      if(obj.every(function(x){return typeof x!=='object';})){var ul=node('ul',undefined,parent,'fr-lg-lst');obj.forEach(function(x){node('li',x,ul);});return;}
      obj.forEach(function(row){var card=node('div',undefined,parent,row&&row.title&&row.state?'fr-lg-node-record':'fr-lg-record');if(row&&row.title&&row.state)frCanonNodeButton(card,row,'fr-ledger-node');else values(card,row);});return;
    }
    Object.entries(obj).forEach(function(pair){var line=node('div',undefined,parent,'fr-lg-kv');node('span',labels[pair[0]]||pair[0],line,'k');var body=node('div',undefined,line,'v');values(body,pair[1]);});
  }
  function eventCard(parent,row){
    var card=node(row.resolved?'details':'div',undefined,parent,'fr-lg-ev'+(row.resolved?' fr-lg-done-ev':''));
    if(row.resolved)card.dataset.recordId=key+'-ledger-event-'+row.eventId;
    var head=node(row.resolved?'summary':'div',undefined,card,'fr-lg-ev-head');node('span',row.eventId||'',head,'fr-lg-ev-code');node('span',String(row.title||row.current||'事件进度').replace(/^【E-[^】]+】\s*/,''),head,'fr-lg-ev-name');node('span',row.resolved?'已收尾':names[row.status]||'进行中',head,'fr-lg-badge '+(row.resolved?'completed':row.status||'ongoing'));
    if(row.startAt||row.endAt)node('span',(row.startAt||'')+' – '+(row.endAt||''),head,'fr-lg-ev-date');
    var body=node('div',undefined,card,'fr-lg-ev-body'),copy=Object.fromEntries(Object.entries(row).filter(function(pair){return !['eventId','title','status','startAt','endAt'].includes(pair[0]);}));values(body,copy);
  }
  // ── 结构化渲染：每个分区按字段语义排版，不再把嵌套对象整棵倒出来 ──
  // 通用递归只作兜底，用于尚未单独建模的字段。
  function kv(parent,label,value,cls){
    var row=node('div',undefined,parent,'fr-lg-kv'+(cls?' '+cls:''));
    node('span',label,row,'k');
    var body=node('div',undefined,row,'v');
    if(typeof value==='string'||typeof value==='number')node('span',String(value),body);
    else if(value!==null)values(body,value);
    return row;
  }
  function list(parent,items,cls){
    var arr=Array.isArray(items)?items.filter(function(x){return x!==null&&x!==undefined&&String(x).trim()!=='';}):[];
    if(!arr.length){node('span','无',parent,'fr-lg-empty');return;}
    var ul=node('ul',undefined,parent,'fr-lg-lst'+(cls?' '+cls:''));
    arr.forEach(function(x){node('li',typeof x==='object'?(x.text||x.title||x.name||JSON.stringify(x)):String(x),ul);});
  }
  function sectionTitle(parent,text,count){
    var h=node('div',undefined,parent,'fr-lg-sub-head');node('span',text,h,'fr-lg-sub-t');
    if(count!==undefined&&count!==null)node('span',String(count),h,'fr-lg-sub-n');
    return h;
  }
  // 事件进度：状态/时间/阶段/已发生/尚未发生/变异/依据/节点，各自成块
  function eventProgressCard(parent,row){
    var wrap=node(row.resolved?'details':'div',undefined,parent,'fr-lg-ev'+(row.resolved?' fr-lg-done-ev':''));
    if(row.resolved)wrap.dataset.recordId=key+'-ledger-event-'+row.eventId;
    var head=node(row.resolved?'summary':'div',undefined,wrap,'fr-lg-ev-head');
    node('span',row.eventId||'',head,'fr-lg-ev-code');
    node('span',String(row.title||'').replace(/^【E-[^】]+】\s*/,'')||row.eventId||'',head,'fr-lg-ev-name');
    node('span',row.resolved?'已收尾':(names[row.status]||'进行中'),head,'fr-lg-badge '+(row.resolved?'completed':row.status||'ongoing'));
    if(row.startAt||row.endAt)node('span',(row.startAt||'')+(row.startAt&&row.endAt?' – ':'')+(row.endAt||''),head,'fr-lg-ev-date');
    var body=node('div',undefined,wrap,'fr-lg-ev-body');
    if(row.coveredTo)kv(body,'已推进到',row.coveredTo+(row.resolved?' · 已收尾':' · 未收尾'));
    if(row.current)kv(body,'当前阶段',row.current);
    if((row.occurred||[]).length)kv(body,'已发生',null).querySelector('.v').appendChild((function(){var d=document.createElement('div');list(d,row.occurred,'fr-lg-ok');return d;})());
    if((row.pending||[]).length)kv(body,'尚未发生',null).querySelector('.v').appendChild((function(){var d=document.createElement('div');list(d,row.pending,'fr-lg-wait');return d;})());
    if((row.changes||[]).length)kv(body,'变异',null).querySelector('.v').appendChild((function(){var d=document.createElement('div');list(d,row.changes,'fr-lg-warn');return d;})());
    if((row.nodes||[]).length){
      var nv=kv(body,'节点',null).querySelector('.v');var bar=node('div',undefined,nv,'fr-lg-nodebar');
      row.nodes.forEach(function(n){frCanonNodeButton(bar,n,'fr-lg-nodechip');});
    }
    if(row.reason)kv(body,'判断依据',row.reason);
    if(row.timingChange&&row.timingChange.kind)kv(body,'时序变异',[names[row.timingChange.kind]||row.timingChange.kind,row.timingChange.reason].filter(Boolean).join('：'));
  }
  // 时间索引和实际进度分开保存；展示时按事件编号合并。
  function openEventRow(parent,row){
    var progress=progressById.get(row.eventId),reference=windowById.get(row.eventId);
    var next=(progress?.nodes||[]).find(n=>n.state==='todo'),last=(progress?.nodes||[]).filter(n=>n.state!=='todo').at(-1);
    var wrap=node('div',undefined,parent,'fr-lg-ev');
    var head=node('div',undefined,wrap,'fr-lg-ev-head');
    node('span',row.eventId||'事件',head,'fr-lg-ev-code');
    node('span',String(progress?.title||reference?.title||row.title||'').replace(/^【E-[^】]+】\s*/,'').replace(/\s*\[人物[:：][\s\S]*$/,'').trim()||'原著事件',head,'fr-lg-ev-name');
    node('span',names[progress?.status]||'待核对',head,'fr-lg-badge '+(progress?.status||'ongoing'));
    if(row.coveredTo)node('span','核对至 '+row.coveredTo,head,'fr-lg-ev-date');
    var body=node('div',undefined,wrap,'fr-lg-ev-body');
    kv(body,'当前阶段',progress?.current||last?.title||'尚无已确认节点');
    var nextTitle=next?.title||progress?.pending?.[0];
    if(nextTitle)kv(body,'下一节点（未完成）',nextTitle);
    if(progress?.changes?.length)kv(body,'变异',progress.changes);
    if(row.endAt)kv(body,'年表参考终点',row.endAt);
    var people=new Map(Object.entries(row.doneActors||{}));
    (progress?.nodes||[]).forEach(n=>{
      (n.contributions||[]).forEach(c=>{if(c.name&&c.status==='applied'&&!people.has(c.name))people.set(c.name,c.livePrefix?'已保存本轮片段':'已保存节点结果');});
      if(['applied','repaired'].includes(n.prebuilt))(n.actors||[]).forEach(name=>{if(!people.has(name))people.set(name,'已保存节点结果');});
    });
    var actors=[...people];
    if(actors.length){
      var av=kv(body,'已处理人物',null).querySelector('.v');
      actors.forEach(function(pair){
        var one=node('div',undefined,av,'fr-lg-actor');
        node('span',pair[0],one,'fr-lg-actor-name');
        var txt=Array.isArray(pair[1])?pair[1].join('；'):String(pair[1]||'');
        node('span',txt||'已处理',one,'fr-lg-actor-note');
      });
    }
  }
  // 变异关注：编号/状态/原因/记录时间
  function watchRow(parent,row){
    var wrap=node('div',undefined,parent,'fr-lg-ev');
    var head=node('div',undefined,wrap,'fr-lg-ev-head');
    node('span',row.eventId||'关注',head,'fr-lg-ev-code');
    node('span',names[row.status]||row.status||'已记录',head,'fr-lg-badge '+(row.status==='confirmed'?'changed':'ongoing'));
    if(row.at||row.recordedAt)node('span',row.at||row.recordedAt,head,'fr-lg-ev-date');
    var body=node('div',undefined,wrap,'fr-lg-ev-body');
    if(row.reason)kv(body,'原因',row.reason);
  }
  // 欠账：区间/原因/欠谁什么/关联事件/已试次数
  function debtRow(parent,row){
    var wrap=node('div',undefined,parent,'fr-lg-ev');
    var head=node('div',undefined,wrap,'fr-lg-ev-head');
    node('span',(row.from||'?')+(row.to?' → '+row.to:''),head,'fr-lg-ev-code');
    if(row.attempts)node('span','已试 '+row.attempts+' 次',head,'fr-lg-badge ongoing');
    var body=node('div',undefined,wrap,'fr-lg-ev-body');
    if(row.reason||row.detail)kv(body,'原因',row.reason||row.detail);
    var actors=row.actors&&typeof row.actors==='object'?Object.entries(row.actors):[];
    if(actors.length){
      var v=kv(body,'欠谁什么',null).querySelector('.v');
      actors.forEach(function(pair){var one=node('div',undefined,v,'fr-lg-actor');node('span',pair[0],one,'fr-lg-actor-name');node('span',Array.isArray(pair[1])?pair[1].join('；'):String(pair[1]||''),one,'fr-lg-actor-note');});
    }
    if((row.eventIds||[]).length)kv(body,'关联事件',row.eventIds.join('、'));
  }
  // 钩子：谁 + 什么事
  function hookRow(parent,row){
    var wrap=node('div',undefined,parent,'fr-lg-ev');
    var head=node('div',undefined,wrap,'fr-lg-ev-head');
    node('span',row.who||'线索',head,'fr-lg-ev-code');
    node('span',names[row.status]||row.status||'未收尾',head,'fr-lg-badge '+(row.status==='closed'?'completed':'ongoing'));
    if(row.bornTurn)node('span','第 '+row.bornTurn+' 轮记下',head,'fr-lg-ev-date');
    var body=node('div',undefined,wrap,'fr-lg-ev-body');
    if(row.hook||row.text)kv(body,'内容',row.hook||row.text);
    if(row.note)kv(body,'说明',row.note);
  }
  function genericRows(parent,rows,fn){
    var arr=Array.isArray(rows)?rows:[];
    if(!arr.length){node('span','暂无记录',parent,'fr-lg-empty');return;}
    arr.forEach(function(row){fn(parent,row);});
  }
  var card=node('article',undefined,host,'fr-lg-card fr-ledger-view');
  var title=node('h4','账本',card,'fr-lg-title');
  node('p','第 '+(ledger.turnNo||0)+' 轮 · 世界时间 '+(ledger.worldTime||'未记录'),card,'fr-lg-sub');
  var summary=node('div',undefined,card,'fr-lg-summary');
  [['版本',ledger.version||3,'gold'],['事件进度',(ledger.eventProgress||[]).length,'green'],['进行中事件',openEvents.length,'blue'],['欠账',(ledger.debts||[]).length,'dim'],['钩子',(ledger.hooks||[]).length,'dim'],['变异关注',(ledger.eventWatches||[]).length,'red']]
    .forEach(function(item){var chip=node('span',undefined,summary,'fr-lg-chip '+item[2]);node('span',item[0],chip);node('span',item[1],chip,'n');});
  var secs=[
    {title:'基本信息',count:null,render:function(b){
      kv(b,'世界时间',ledger.worldTime||'未记录');
      kv(b,'轮次','第 '+(ledger.turnNo||0)+' 轮');
      kv(b,'结构版本',String(ledger.version||3));
    }},
    {title:'事件进度',count:(ledger.eventProgress||[]).length,render:function(b){
      genericRows(b,ledger.eventProgress,eventProgressCard);
    }},
    {title:'进行中事件',count:openEvents.length,render:function(b){
      genericRows(b,openEvents,openEventRow);
    }},
    {title:'变异关注',count:(ledger.eventWatches||[]).length,render:function(b){
      genericRows(b,ledger.eventWatches,watchRow);
    }},
    ...(ledger.prebuiltActorDifferences?.length?[{title:'人物与预制成品的差异',count:ledger.prebuiltActorDifferences.length,render:function(b){
      const labels={'2':'境界与身份','4':'状态','9':'人物备注','11':'白值属性','13':'关系','16':'位置','26':'灵石','27':'当前动机','28':'短期目标','29':'长期目标'};
      const renderValue=value=>value===undefined?'无':typeof value==='string'?value:JSON.stringify(value);
      genericRows(b,ledger.prebuiltActorDifferences,function(parent,row){
        const group=node('details',undefined,parent,'fr-lg-ev');
        node('summary',row.name+' · '+row.nodeId+' · '+row.fields.length+' 处',group);
        for(const {path,delta,before,after} of row.fields){
          const label=[labels[path[0]]||('第 '+path[0]+' 列'),...path.slice(1)].join(' · ');
          kv(group,label,renderValue(before)+' → '+renderValue(after)+(Number.isFinite(delta)?'（'+(delta>0?'+':'')+delta+'）':''));
        }
      });
    }}]:[]),
    {title:'待继续处理（欠账）',count:(ledger.debts||[]).length,render:function(b){
      genericRows(b,ledger.debts,debtRow);
    }},
    {title:'后续线索（钩子）',count:(ledger.hooks||[]).length,render:function(b){
      genericRows(b,ledger.hooks,hookRow);
    }},
    {title:'上一轮做了什么',count:null,render:function(b){
      var last=ledger.lastTurn;
      if(!last||!Object.keys(last).length){node('span','暂无记录',b,'fr-lg-empty');return;}
      if(last.at||last.rangeEnd)kv(b,'时间',last.at||last.rangeEnd);
      if(last.rangeStart||last.rangeEnd)kv(b,'区间',(last.rangeStart||'?')+' → '+(last.rangeEnd||'?'));
      if(last.status)kv(b,'状态',names[last.status]||last.status);
      if((last.wroteNames||[]).length)kv(b,'补成了',last.wroteNames.join('、'));
      if((last.updatedNames||[]).length)kv(b,'更新了',last.updatedNames.join('、'));
      if((last.biographyNames||[]).length)kv(b,'生平更新',last.biographyNames.join('、'));
      var gaps=last.gaps&&typeof last.gaps==='object'?Object.entries(last.gaps):[];
      if(gaps.length){
        var gv=kv(b,'未补成',null).querySelector('.v');
        gaps.forEach(function(pair){var one=node('div',undefined,gv,'fr-lg-actor');node('span',pair[0],one,'fr-lg-actor-name');node('span',Array.isArray(pair[1])?pair[1].join('；'):String(pair[1]||''),one,'fr-lg-actor-note warn');});
      }
      if(last.eventCount||last.actorCount)kv(b,'规模',(last.eventCount||0)+' 个事件 · '+(last.actorCount||0)+' 人');
      if((last.openEventIds||[]).length)kv(b,'未结束',last.openEventIds.join('、'));
    }},
  ];
  secs.forEach(function(sec,index){
    var d=node('details',undefined,card,'fr-lg-sec');
    d.dataset.recordId=key+'-ledger-'+index;
    var h=node('summary',undefined,d,'fr-lg-h');
    node('span',sec.title,h);
    if(sec.count!==null)node('span',sec.count+' 项',h,'cnt');
    var body=node('div',undefined,d,'fr-lg-body');
    sec.render(body);
  });
  card.appendChild(node('div',undefined,card,'fr-lg-foot')).textContent='账本随楼层快照保存，回退时回到该楼层的状态。';
}
// 进度指针是现有年表/账本/边界结果的只读投影；日历位置不代表剧情完成度。
function frCanonRenderProgressPointer(parent,plan,finalRows,analysis,preview=null){
  if(window.__frPointerLayoutObserver){window.__frPointerLayoutObserver.disconnect();window.__frPointerLayoutObserver=null;}
  var layouts=[];
  var windows=plan?.eventWindows|| [],range=plan?.range|| {},parse=typeof ceBridgeCore==='function'?ceBridgeCore()?.interval?.parseTimePoint:null;
  if((!windows.length&& !(plan?.eventWatches|| []).length)|| typeof parse!=='function')return;
  if(frCanonPointerClose)frCanonPointerClose();
  var point=parse(range.end),saved=plan.savedEventProgress|| [],observed=finalRows?.length?finalRows:plan.observedEventProgress|| [];
  var endOfWindow=function(value){var end=parse(value);return Number.isFinite(end)&&frCanonSingleNodeDate(value)&&!/:/.test(value)?end+1439:end;};
  var prebuiltUnreached=new Set(plan.prebuiltUnreachedEventIds||[]);
  var unreached=new Set([...prebuiltUnreached,...(plan.ordinaryUnreachedEventIds||[])]);
  var currentFor=event=>unreached.has(event.eventId)?null:observed.find(row=>row.eventId===event.eventId);
  var ongoing=windows.filter(function(event){var start=parse(event.startAt),end=endOfWindow(event.endAt),last=currentFor(event)||saved.find(row=>row.eventId===event.eventId);return last?.resolved!==true&& ((Number.isFinite(point)&& Number.isFinite(start)&& Number.isFinite(end)&& start<=point&& point<=end)|| last?.timingChange?.kind==='delayed'&& last.resolved!==true);});
  var selected=ongoing.filter(event=>!unreached.has(event.eventId)),more=null;
  if(!selected.length)selected=ongoing.filter(event=>unreached.has(event.eventId)).slice(-1);
  if(!selected.length)selected=windows.filter(event=>!unreached.has(event.eventId)).slice(-1);
  function node(tag,text,cls,host){var n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;(host|| parent).appendChild(n);return n;}
  selected.forEach(function(event,index){
    if(index===1){more=node('details',undefined,'fr-pointer-more');node('summary','其他进行中事件 · '+(selected.length-1),'',more);}
    var box=node('article',undefined,'fr-pointer-card',index?more:parent),before=saved.find(row=>row.eventId===event.eventId),current=currentFor(event),start=parse(event.startAt),end=parse(event.endAt);
    var title=String(event.title|| event.eventId).replace(/\s*\[人物[:：][\s\S]*$/,'');node('h4',title,'fr-pointer-title',box);
    if(unreached.has(event.eventId))node('p',prebuiltUnreached.has(event.eventId)
      ? '已识别预制成品，节点待确认，本轮未推进账本。'
      : '事件尚待条件成立，本轮未推进账本。','fr-pointer-warning',box);
    var timing=current?.timingChange|| event.timingChange|| before?.timingChange,status=current?.status|| before?.status;
    var stateLabel={expired:'机会已过 · 原路线关闭',cancelled:'已取消 · 原路线关闭',replaced:'已被替代',completed:'实际完成'}[status]|| ({early:'提前启动',delayed:'有因果延期'}[timing?.kind]);
    if(stateLabel)node('p',stateLabel,'fr-pointer-warning',box);
    var head=node('div',undefined,'fr-pointer-heading',box);node('span',preview?'预览时点':'此刻','fr-pointer-caption',head);node('strong',range.end|| '尚未确认时间','fr-pointer-date',head);
    var sameDay=!!(frCanonSingleNodeDate(event.startAt)&&frCanonSingleNodeDate(event.endAt)&&Number.isFinite(start)&&Number.isFinite(end)&&
      Math.floor(start/1440)===Math.floor(end/1440));
    var valid=Number.isFinite(start)&& Number.isFinite(end)&& (sameDay?end>=start:end>start)&& Number.isFinite(point),position=function(value){return valid?(end===start?50:Math.max(0,Math.min(100,(value-start)/(end-start)*100))):0;},at=position(point);
    var registry=new Map();[...(before?.nodes||[]),...(current?.nodes||[])].forEach(function(row){registry.set(row.nodeId||row.title,row);});
    // A 精修稿：真实日期横轴 + 编号对位；所有标签留在 axis 坐标系。
    var displayNodes=typeof frCanonPointerVisibleNodes==='function'?frCanonPointerVisibleNodes(before,current,event):Array.from(registry.values());
    var timingLabel=function(row){
      var t=row.timing,r=row.receipt;
      var when=t?'参考 '+t.from+(t.to&&t.from!==t.to?'–'+t.to:''):'';
      var recorded=r?(r.at?'发生 '+r.at:'确认于 '+r.confirmedAt):'';
      return [when,recorded].filter(Boolean).join(' · ');
    };
    displayNodes=displayNodes.map(function(row){return {...row,receipt:row.milestoneReceipts?.find(r=>r.id===row.nodeId)};});
    if(sameDay)displayNodes=displayNodes.flatMap(function(row){
      if(!row.milestones?.length)return [row];
      var reached=row.milestones.findIndex(step=>step.id===row.reachedMilestoneId);
      return row.milestones.map(function(step,i){return {...row,nodeId:step.id,settlementNodeId:row.nodeId,
        state:row.state==='todo'&&i<=reached?'done':row.state,
        timing:step.timing,receipt:row.milestoneReceipts?.find(r=>r.id===step.id),
        title:step.title,original:step.evidence||row.original,dateBasis:step.dateBasis||row.dateBasis,actors:step.actors||row.actors};});
    });
    var nodes=displayNodes.map(function(row,i){return {row:row,order:i,date:parse(row.at)};}).sort(function(a,b){return Number.isFinite(a.date)&&Number.isFinite(b.date)?a.date-b.date||a.order-b.order:a.order-b.order;}).map(function(item){return item.row;});
    if(!preview&&typeof frCanonEstimateNodeTimes==='function')nodes=frCanonEstimateNodeTimes(nodes,event,range,parse);
    // Open-ended estimates provide context, but cannot place a single date on this axis.
    var unplaced=preview||sameDay?[]:nodes.filter(function(row){var t=row.timeEstimate;return t&&(t.point===null||(t.estimated&&(!t.start||!t.end)));});
    var placeable=nodes.filter(function(row){return !unplaced.includes(row);});
    var milestones=!preview&&!sameDay&&typeof frCanonPointerMilestones==='function'?frCanonPointerMilestones(placeable):{visible:placeable,additional:[]};
    milestones.additional=milestones.additional.concat(unplaced);
    nodes=milestones.visible;
    var displayPoints=!preview&&typeof frCanonSpreadEstimatedNodes==='function'?frCanonSpreadEstimatedNodes(nodes,event,range,parse):nodes.map(function(row){return preview?parse(row.at):row.timeEstimate?.point??parse(row.at);});
    var spreadEstimates=displayPoints.some(function(value,i){return value!==nodes[i].timeEstimate?.point&&nodes[i].timeEstimate?.estimated===true;});
    if(!preview)nodes=nodes.map(function(row,i){return frCanonWithDisplayedNodeDate(row,displayPoints[i]);});
    var dayPosition=function(index){return nodes.length>1?index/(nodes.length-1)*100:50;};
    if(sameDay){
      var focus=preview?nodes.findIndex(row=>row.nodeId===preview.selected):nodes.findLastIndex(row=>row.state==='done'||row.state==='mutated');
      at=focus<0?(preview&&nodes.length?100:0):dayPosition(focus);
    }
    // 日期决定横坐标；同刻/近刻节点在轴线上下分层，编号对应下方详情卡片。
    var axis=node('div',undefined,'fr-pointer-axis',box),track=node('div',undefined,'fr-pointer-track',axis);
    var fill=node('div',undefined,'fr-pointer-fill',track);
    var now=node('span',undefined,'fr-pointer-now',track);now.title='本轮日期位置；不表示剧情完成度';now.setAttribute('aria-label','此刻日期位置');
    var list=node('div',undefined,'fr-pointer-list',box);
    var previous=null,next=null,markers=[];
    nodes.forEach(function(row,n){
      var date=displayPoints[n],left=sameDay?dayPosition(n):valid&&Number.isFinite(date)?position(date):15+(nodes.length===1?70:n/(nodes.length-1)*70),id=String(n+1).padStart(2,'0');
      var item={row:row,left:left,text:row.title,id:id};
      /* clamp 而不是裸 left：圆点自身宽 23px、translateX(-50%)，
       * 落 0% 时半个圆会跑到容器外（玩家截图里 01/02/03 就贴在卡片左边缘外）。 */
      var marker=frCanonNodeButton(track,row);marker.textContent=id;marker.style.left='clamp(16px,'+left+'%,calc(100% - 16px))';marker.dataset.nodeLeft=String(left);marker.dataset.pointerId=id;item.marker=marker;
      markers.push({left:left,date:sameDay?n:date,marker:marker});
      // Both the numbered marker and its card open the same read-only details.
      var label=frCanonNodeButton(list,row,'fr-pointer-lbl');label.replaceChildren();label.dataset.pointerId=id;
      node('b',id,'fr-pointer-number',label);node('span',row.title||'未命名节点','fr-pointer-name',label);node('small',timingLabel(row)||row.timeEstimate?.label||row.at||'本轮时间范围待确认','fr-pointer-node-date',label);
      label.setAttribute('aria-label','节点 '+id+' '+(row.title||'')+' · '+({done:'已完成',todo:'未发生',mutated:'节点变异',created:'新增变异'}[row.state]||'状态未记录'));
      item.el=label;
      marker.setAttribute('aria-label','节点 '+id+' '+(row.title||'')+' · 点击查看详情');
      var openMarker=marker.onclick,openLabel=label.onclick;
      marker.onclick=function(e){ list.querySelectorAll('.is-active').forEach(function(el){el.classList.remove('is-active');}); label.classList.add('is-active'); if(label.scrollIntoView)label.scrollIntoView({block:'nearest',behavior:'smooth'});openMarker.call(marker,e); };
      label.onclick=function(e){ track.querySelectorAll('.is-active').forEach(function(el){el.classList.remove('is-active');}); marker.classList.add('is-active');openLabel.call(label,e); };
      if(preview){
        if(row.dateBasis||row.timing){label.querySelector('small').textContent=timingLabel(row)||(/推算|估算|估计/.test(row.dateBasis)?'推算 ':'')+row.at;label.title=row.timing?.basis||row.dateBasis;}
        [marker,label].forEach(function(control){
          control.removeAttribute('aria-haspopup');control.removeAttribute('aria-expanded');
          control.setAttribute('aria-label','节点 '+id+' '+row.title+' · '+row.at);
          control.setAttribute('aria-pressed',String(row.nodeId===preview.selected));
          control.classList.toggle('is-active',row.nodeId===preview.selected);
          control.onclick=function(){preview.onSelect(row.settlementNodeId||row.nodeId,control===marker,row.nodeId,Boolean(row.settlementNodeId));};
        });
      }
      if(row.timeEstimate?.estimated){marker.dataset.estimated='true';marker.title=row.timeEstimate.label;}
      if(valid&&Number.isFinite(date)){if(date<=point)previous=item;else if(!next)next=item;}
    });
    // 此刻始终贴近日期轴；节点为标签让位，不把标签推到最上层。
    var nowTag=node('span',preview?'预览':'此刻','fr-pointer-now-tag',track);
    nowTag.style.left='clamp(28px,'+at+'%,calc(100% - 28px))';nowTag.style.top='auto';nowTag.style.bottom='calc(100% + 20px)';
    nowTag.title=sameDay?'当日节点顺序位置':'本轮日期位置；不表示剧情完成度';
    // 按容器实际像素分组，给上下节点及此刻标签分别预留高度。
    var lastWidth=0,mutationMarkers=[];
    function layoutMarkers(){
      var width=track.getBoundingClientRect().width||axis.getBoundingClientRect().width;
      if(!width)width=360;if(width===lastWidth)return;lastWidth=width;
      var groups=[],ordered=markers.map(function(row){return {...row,x:Math.max(16,Math.min(width-16,width*row.left/100))};}).sort(function(a,b){return a.x-b.x;});
      var dateGroups=[];
      if(preview)ordered.forEach(function(row){
        var group=dateGroups[dateGroups.length-1];
        if(group&&Number.isFinite(row.date)&&row.date===group[0].date)group.push(row);else dateGroups.push([row]);
      });
      var spreadPreview=preview&&width-32>=(dateGroups.length-1)*44,shifted=false;
      if(spreadPreview){
        var lastX=-28;
        dateGroups.forEach(function(group,i){
          var x=Math.min(width-16-(dateGroups.length-1-i)*44,Math.max(group[0].x,lastX+44));lastX=x;
          if(Math.abs(x-group[0].x)>1)shifted=true;
          group.forEach(function(row){row.x=x;row.marker.style.left=x+'px';});
        });
        groups=dateGroups;
      }else ordered.forEach(function(row){
        row.marker.style.left='clamp(16px,'+row.left+'%,calc(100% - 16px))';
        var group=groups[groups.length-1];if(!group||row.x-group[0].x>=42)groups.push([row]);else group.push(row);
      });
      if(preview&&!sameDay)axis.dataset.spaced=String(shifted);
      var upperExtent=0,lowerExtent=0,placed=[];track.querySelectorAll('.fr-pointer-stem').forEach(function(el){el.remove();});
      var tagX=Math.max(28,Math.min(width-28,width*at/100));
      var tagWidth=nowTag.getBoundingClientRect().width||54,tagHeight=nowTag.getBoundingClientRect().height||32;
      groups.forEach(function(group){
        var nearNow=group.some(function(row){return Math.abs(row.x-tagX)<tagWidth/2+24;});
        var nearestUpper=group.length%2?42:21;
        var upperShift=nearNow&&group.length>1?Math.max(0,tagHeight+20+24-nearestUpper):0;
        group.forEach(function(row,i){
        var offset=(i-(group.length-1)/2)*42;
        if(offset<0)offset-=upperShift;
        function fits(value){
          if(placed.some(function(other){return Math.abs(other.x-row.x)<42&&Math.abs(other.offset-value)<42;}))return false;
          return !(Math.abs(row.x-tagX)<tagWidth/2+24&&value+14>-20-tagHeight-5&&value-14<-20+5);
        }
        // 相邻小组可能靠近：复用已有高度层，避免跨组碰撞或链式堆成一根长柱。
        if(!fits(offset)){
          var candidates=[0];for(var lane=1;lane<=ordered.length*2+6;lane++){candidates.push(-lane*21,lane*21);}
          offset=candidates.find(fits)??offset;
        }
        placed.push({x:row.x,offset:offset});
        upperExtent=Math.max(upperExtent,-offset);lowerExtent=Math.max(lowerExtent,offset);
        row.marker.style.top='calc(50% + '+offset+'px)';row.marker.dataset.tier=String(i-(group.length-1)/2);
        if(offset){var stem=node('span',undefined,'fr-pointer-stem',track);stem.style.left=row.marker.style.left;stem.style.top='calc(50% + '+Math.min(0,offset)+'px)';stem.style.height=Math.abs(offset)+'px';}
      });});
      var mutationLanes=[],mutationDepth=0;
      mutationMarkers.forEach(function(mark){
        var x=Math.max(16,Math.min(width-16,width*Number(mark.dataset.datePosition||0)/100)),lane=0;
        while(mutationLanes[lane]?.some(function(oldX){return Math.abs(oldX-x)<40;}))lane++;
        (mutationLanes[lane]||(mutationLanes[lane]=[])).push(x);
        mark.style.top=(lowerExtent+30+lane*30)+'px';mutationDepth=Math.max(mutationDepth,54+lane*30);
      });
      axis.style.paddingTop=Math.max(tagHeight+24,upperExtent+24)+'px';axis.style.paddingBottom=(lowerExtent+Math.max(24,mutationDepth))+'px';
    }
    layouts.push({axis:axis,layout:layoutMarkers});layoutMarkers();
    if(preview&&!sameDay)node('p','相近日期的节点已横向错开，具体日期以卡片为准。','fr-pointer-footnote fr-pointer-spacing-note',box);
    // 箭头跟随标签同一横向位置
    now.style.left='clamp(12px,'+at+'%,calc(100% - 12px))';
    fill.style.width='clamp(0px,'+at+'%,100%)';
    if(!nodes.length)list.remove();

    if(valid&& before?.coveredTo){var oldPoint=parse(before.coveredTo);if(Number.isFinite(oldPoint)){var old=node('span',undefined,'fr-pointer-saved',track);old.style.left=position(oldPoint)+'%';old.title='上轮保存：'+before.coveredTo;}}
    ['referenceStart','referenceEnd'].forEach(function(key){if(event[key]&& event[key]!==event[key==='referenceStart'?'startAt':'endAt']){var tick=node('span',undefined,'fr-pointer-saved',track);tick.style.left=position(parse(event[key]))+'%';tick.title=(key==='referenceStart'?'原著参考起点：':'原著参考终点：')+event[key];}});
    var ends=node('div',undefined,'fr-pointer-ends',box);node('span',sameDay?'当日开始':'起 '+(event.startAt|| '未标日期'),'',ends);node('span',sameDay?'当日结束':'参考止 '+(event.referenceEnd|| event.endAt|| '未标日期'),'',ends);
    var phase=node('div',undefined,'fr-pointer-phase',box);node('span',preview?'年表节点':finalRows?.length?'实际阶段':'本轮判断','fr-pointer-caption',phase);node('strong',current?.current|| before?.current|| '尚未有已确认阶段，等待本轮推演','',phase);
    if(before)node('p','上轮保存 · '+(before.coveredTo|| '未标时间')+' · '+(before.current|| '暂无阶段记录'),'fr-pointer-history',box);
    if(!valid)node('p','参考日期不完整，仅展示实际阶段。','fr-pointer-history',box);
    else if(point>endOfWindow(event.referenceEnd|| event.endAt)&& (current|| before)?.resolved!==true)node('p','已超出原著参考终点；是否还能继续，以本轮实际判断为准。','fr-pointer-warning',box);
    if(spreadEstimates)node('p','缺少确切日期的节点按先后顺序估算到日；预计日期会随剧情推进调整。','fr-pointer-footnote',box);
    if(nodes.length){
      node('p',sameDay?(preview?'按当天先后排列。点击节点可查看当天的人物正文和变量。':'按当天先后排列，具体进度以已确认的节点为准。'):
        preview?'点击节点，查看该时点的人物正文、增减和终态。':'时间尺只表示日期位置，事情做到哪里以实际阶段为准。','fr-pointer-footnote',box);
      var legend=node('div',undefined,'fr-pointer-legend',box),axisLabel=sameDay?'当日顺序':'日期经过范围';(preview?[['seg',axisLabel],['done','已生成'],['todo','待生成']]:[['seg',axisLabel],['done','已完成节点'],['todo','未完成节点'],['mutated','节点变异'],['created','新增变异']]).forEach(function(pair){var item=node('span',undefined,'',legend);node('i',undefined,'fr-pointer-key is-'+pair[0],item);node('span',pair[1],'',item);});
    }
    var changes=[],seen=new Set();
    function change(text,time,type){if(!text|| seen.has(text))return;seen.add(text);changes.push({text:typeof text==='string'?text:JSON.stringify(text),time:time,type:type});}
    (plan.eventWatches|| []).filter(row=>row.eventId===event.eventId).forEach(row=>change(row.reason,row.recordedAt|| range.end,row.status==='suspected'?'变异嫌疑':'已确认变异'));
    (current?.timingHistory||before?.timingHistory||[]).forEach(row=>change(row.reason,row.actualStart||row.recordedAt||range.end,({early:'提前启动',delayed:'有因果延期',expired:'机会已过',cancelled:'原路线取消'}[row.kind]||'时序变异')));
    if(timing?.reason)change(timing.reason,timing.actualStart|| timing.recordedAt|| range.end,({early:'提前启动',delayed:'有因果延期',expired:'机会已过',cancelled:'原路线取消'}[timing.kind]|| '时序变异'));
    if(['expired','cancelled'].includes(status))change(current?.reason|| before?.reason,current?.coveredTo|| before?.coveredTo|| range.end,status==='expired'?'机会已过':'事件取消');
    (before?.changes|| []).forEach(text=>change(text,before.coveredTo,'已保存变异'));
    (current?.changes|| []).forEach(text=>change(text,current.coveredTo|| range.end,'本轮变异'));
    (plan.decisions|| []).filter(row=>row.canonAdvance==='break'&& (row.eventIds|| []).includes(event.eventId)).forEach(row=>(row.corridor?.breakReasons|| [row.reason]).forEach(text=>change((row.name|| row.actorRef)+'：'+text,range.end,'破壁 · 本轮识别')));
    (analysis?.influences|| []).forEach(function(row){var job=(plan.canonJobs|| []).find(job=>job.name===row.name);if(job?.eventIds?.includes(event.eventId))change(row.name+'：'+row.reason,range.end,'本轮影响 · 待实际推演确认');});
    if(changes.length){
      var details=node('details',undefined,'fr-pointer-changes',box);node('summary','变异与影响 · '+changes.length+' 项','',details);
      changes.forEach(function(row){var item=node('div',undefined,'fr-pointer-change',details);node('span',row.type,'fr-pointer-change-label',item);node('p',row.text,'',item);if(row.time)node('small','记录至 / 识别于 '+row.time+'；不代表精确发生时间','',item);});
      changes.forEach(function(row,index){var mark=node('button','◆','fr-pointer-mutation',track);mark.type='button';mark.style.left=position(parse(row.time))+'%';
        /* ★★★ 2026-11-03 玩家：「连线看不清，变异和此刻重叠」。
         *
         * 【根因】当时刻点和变异标记落在同一时间附近时，两者在**同一条竖线上**：
         *   此刻标签挂在 axis 上（在轨道上方），变异 ◆ 挂在 track 上 top=11px（也在轨道上方附近），
         * 于是「+ 红薯波波」正好压在「此刻」两个字上。
         *
         * 【修法】把变异 ◆ **移到轨道下方**（track 底部之外），
         * 与上方标签彻底分开层：上=标签，中=轨道，下=变异标记。
         * 同时给每一行的标记一点错位，避免多个变异挤在一起。
         * 这样无论此刻和变异是否同刻，都不会再压字。 */
        mark.dataset.datePosition=String(position(parse(row.time)));mutationMarkers.push(mark);
        mark.title=row.type+'：'+row.text;mark.setAttribute('aria-label','查看'+row.type);mark.onclick=function(){details.open=true;mark.setAttribute('aria-expanded','true');};});
      lastWidth=0;layoutMarkers();
    }
    if(milestones.additional.length){
      var extra=node('details',undefined,'fr-pointer-pending fr-pointer-additional',box);
      node('summary','其他已登记节点 · '+milestones.additional.length+' 项',undefined,extra);
      var extraList=node('div',undefined,'fr-pointer-list',extra);
      milestones.additional.forEach(function(row){row=frCanonWithDisplayedNodeDate(row,row.timeEstimate?.point);var button=frCanonNodeButton(extraList,row,'fr-pointer-lbl');button.textContent=row.title+' · '+(row.timeEstimate?.label||'日期待推算');});
    }
    var occurred=current?.occurred||before?.occurred||[],pendingRows=current?.pending||before?.pending||[];
    if(occurred.length){var history=node('details',undefined,'fr-pointer-pending fr-pointer-occurred',box);node('summary','已发生详情 · '+occurred.length+' 项',undefined,history);occurred.forEach(text=>node('p',text,'',history));}
    if(pendingRows.length){var pending=node('details',undefined,'fr-pointer-pending fr-pointer-future',box);node('summary','尚未发生 · '+pendingRows.length+' 项',undefined,pending);pendingRows.forEach(text=>node('p',text,'',pending));}
  });
  var externalWatches=(plan.eventWatches|| []).filter(row=>!windows.some(event=>event.eventId===row.eventId));
  if(!selected.length&&!externalWatches.length)node('p','本轮暂无可显示的事件进度。','fr-pointer-history');
  if(externalWatches.length){var watchBox=node('details',undefined,'fr-pointer-changes');node('summary','按编号关注 · '+externalWatches.length+' 项','',watchBox);externalWatches.forEach(function(row){node('p',row.eventId+' · '+(row.status==='suspected'?'变异嫌疑':'已确认变异')+' · '+row.reason,'',watchBox);});}
  if(typeof ResizeObserver==='function'&&layouts.length){
    var observer=new ResizeObserver(function(){layouts.forEach(function(row){if(row.axis.isConnected)row.layout();});});
    layouts.forEach(function(row){observer.observe(row.axis);});window.__frPointerLayoutObserver=observer;
  }
}
var frCanonTraceSignalMeta = new WeakMap();
var frCanonTraceActive = null;
var frCanonTraceSelected = '';
var frCanonTraceWriteQueue = Promise.resolve();
var frCanonTraceRenderTimer = null;
var frCanonDirectActions = {};

// 资料补取只更新本次材料；不会重走人物、正文或账本。
var frCanonMaterialBusy = null;
function frCanonMaterialResult(run){var parsed=(run.events||[]).filter(function(e){return e.label==='补演解析与账本计划'&&e.data;}).slice(-1)[0];return Object.assign({},parsed&&parsed.data||{},run.result||{},run.executionResult||{});}
function frCanonMaterialLatestLog(archive){return (archive?.data?.logs||[]).slice().reverse().find(function(log){return log.type==='ai'&&!log.isGhost&&!log.isDeepSummary&&!log.isSnapshot&&!String(log.content||'').includes('<h4>天道初启</h4>');});}
async function frCanonMaterialStamp(archive){
  if(typeof frReplayStamp==='function'&&typeof frTakeCanonMemory==='function')return frReplayStamp(archive,frTakeCanonMemory());
  if(!globalThis.crypto?.subtle)throw new Error('当前环境不能校验资料所属楼层。');
  var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([archive,typeof currentState==='object'?currentState:null])));
  return Array.from(new Uint8Array(digest)).map(function(value){return value.toString(16).padStart(2,'0');}).join('');
}
async function frCanonMaterialSourceStamp(){
  if(typeof db==='undefined' || !db.archives || !currentArchiveName)return '';
  var name=currentArchiveName,archive=await db.archives.get(name),stamp=await frCanonMaterialStamp(archive);
  if(name!==currentArchiveName)throw new Error('资料采集时存档已切换。');
  return stamp;
}
async function frCanonMaterialSeal(run){
  if(!run || !run.materialState || !run.logId || run.archiveName!==currentArchiveName || run.branchHidden || typeof db==='undefined' || !db.archives)return;
  var archive=await db.archives.get(run.archiveName),latest=frCanonMaterialLatestLog(archive);
  if(!latest || latest.id!==run.logId)return;
  var stamp=await frCanonMaterialStamp(archive);
  if(run.archiveName!==currentArchiveName || run.branchHidden)return;
  run.materialBoundary={logId:run.logId,stamp:stamp,buildId:run.buildId};
}
async function frCanonMaterialAttach(run,result){
  if(!run || !run._capture || !run._record || run._controller?.signal.aborted || !result?.materialState)return;
  run.materialState=frCanonTraceClean(result.materialState,run);
  if(result.guidanceContext)run.materialGuidanceContext=frCanonTraceClean(result.guidanceContext,run);
  try{await frCanonMaterialSeal(run);}catch(error){run.materialSealReason=String(error.message||error);}
}
async function frCanonMaterialValidate(run,own){
  if(!run || run.archiveName!==currentArchiveName || run.branchHidden || run.status==='cancelled')throw new Error('这份资料不属于当前有效回合，不能补取。');
  if(frCanonMaterialBusy && frCanonMaterialBusy!==own || typeof frReplayBusy!=='undefined'&&frReplayBusy || typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating || typeof concurrentEvolutionRunning!=='undefined'&&concurrentEvolutionRunning || frCanonTraceActive?.status==='running'&&frCanonTraceActive!==own)throw new Error('另一项工作正在运行，请结束后补取资料。');
  var turns=frCanonTraceTurns(),latestTurn=turns[turns.length-1];
  if(!latestTurn || !latestTurn.runs.some(function(item){return item.id===run.id;}))throw new Error('只能补取当前最新回合的资料。');
  var boundary=run.materialBoundary;
  if(!boundary || boundary.logId!==run.logId || boundary.buildId!==(typeof FR_BUILD_ID==='string'?FR_BUILD_ID:''))throw new Error('本轮资料尚未绑定当前楼层，或版本已变化，请完成当前回合后再试。');
  var archive=await db.archives.get(currentArchiveName),latest=frCanonMaterialLatestLog(archive);
  if(!latest || latest.id!==boundary.logId || await frCanonMaterialStamp(archive)!==boundary.stamp)throw new Error('存档、楼层或状态已经变化，不能补取旧回合资料。');
  if(run.archiveName!==currentArchiveName || run.branchHidden || own?._controller?.signal.aborted)throw Object.assign(new Error('补取已停止或存档已切换，本次返回不采用。'),{name:'AbortError'});
  return archive;
}
async function frCanonRetryMaterial(runId,key,options){
  var opts=options||{},run=frCanonTraceHistory.find(function(item){return item.id===runId;}),worker=null,previous=frCanonTraceActive;
  if(frCanonMaterialBusy)throw new Error('另一项资料补取正在运行，请等待结束。');
  var reservation={};frCanonMaterialBusy=reservation;
  try{
    var sourceArchive=await frCanonMaterialValidate(run,reservation);
    var core=ceBridgeCore(),materialCore=core['host-material'],state=run.materialState;
    if(!opts.guidanceOnly && !materialCore.retryableMaterialKeys(state).includes(key))throw new Error('这项资料没有可补取的失败请求。');
    if(!opts.guidanceOnly && key!=='ragVector' && (!state.sourceStamp || await frCanonMaterialStamp(sourceArchive)!==state.sourceStamp))throw new Error('原资料读取时点已经变化，无法安全重取当时的'+((state.report||[]).find(function(row){return row.key===key;})?.label||'资料')+'；原成功资料保留，本项仍记为未完成，不用现态冒充。');
    if(opts.guidanceOnly && (!run.materialGuidanceContext || materialCore.retryableMaterialKeys(state).length))throw new Error('请先补齐失败资料，再定点更新本轮指导。');
    if(frCanonTraceActive?.status==='running' || typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating || typeof concurrentEvolutionRunning!=='undefined'&&concurrentEvolutionRunning)throw new Error('另一项工作已经开始，请结束后补取资料。');
  }catch(error){if(frCanonMaterialBusy===reservation)frCanonMaterialBusy=null;throw error;}
  worker=frCanonTraceBegin('资料补取',{logId:run.logId,turnId:run.turnId});frCanonMaterialBusy=worker;
  var forward=function(){worker._controller.abort();};if(opts.signal){if(opts.signal.aborted)forward();else opts.signal.addEventListener('abort',forward,{once:true});}
  var leave=function(){worker._controller.abort();};if(typeof window!=='undefined')window.addEventListener('pagehide',leave,{once:true});
  run.materialRetryFeedback={key:key||'guidance',status:'running',text:opts.guidanceOnly?'正在更新本轮指导…':'正在补取本项资料…'};frCanonTraceSelected=run.id;frCanonTraceRenderSoon();
  try{
    var host=ceBridgeHost(worker._controller.signal,worker),collected=opts.guidanceOnly?{retryState:state,material:state.material,report:state.report}:await materialCore.retryHostMaterial({host:host,state:state,keys:[key],signal:worker._controller.signal});
    await frCanonMaterialValidate(run,worker);
    var result=frCanonMaterialResult(run),next=Object.assign({},result,{materialState:collected.retryState,materialReport:collected.report}),pending=materialCore.retryableMaterialKeys(collected.retryState);
    var rag=collected.report.find(function(row){return row.key==='ragVector';});if(rag)next.retrievalReceipt=Object.assign({},rag);
    var target=collected.report.find(function(row){return row.key===key;}),currentItemDone=opts.guidanceOnly || target && !['error','unconfigured','missing','unavailable'].includes(target.status),allClear=pending.length===0 && currentItemDone,guidanceNeeded=run.phase==='原著指导' && run.materialGuidanceContext;
    if(allClear && guidanceNeeded && (opts.guidanceOnly || !result.guidance && !result.text)){
      var settings=await ceBridgeLoadConfig(),context=structuredClone(run.materialGuidanceContext);
      var guidance=await core.guidance.runGuidance(Object.assign({},context,{host:host,materialState:collected.retryState,options:Object.assign({},settings,context.options||{},{signal:worker._controller.signal})}));
      await frCanonMaterialValidate(run,worker);
      if(opts.guidanceOnly)currentItemDone=guidance.ok===true;
      next=Object.assign({},next,guidance,{injectable:false,materialUpdated:true,guidanceNeedsUpdate:!guidance.ok,reason:guidance.ok?'指导已更新，供本轮核对；已生成的正文不会追溯采用。':guidance.reason});
      if(!guidance.ok && result.guidance){next.guidance=result.guidance;next.text=result.text;next.materialFollowup='资料已补齐，但新指导未完成，仍保留此前指导；此前指导尚未使用新资料。';}
    }else if(allClear){next.materialUpdated=true;next.guidanceNeedsUpdate=!!guidanceNeeded;next.materialFollowup=guidanceNeeded?'资料已补齐，需更新指导；此前指导尚未使用新资料。':'资料已补齐；此前补演尚未使用新资料，需另行核对后续阶段。';}
    await frCanonMaterialValidate(run,worker);
    run.materialState=frCanonTraceClean(collected.retryState,run);run.result=frCanonTraceClean(next,run);
    run.materialRetryFeedback={key:key||'guidance',status:currentItemDone?'done':'error',text:currentItemDone?(!allClear?'本项资料已补齐，其他读取未完成项仍可分别补取。':next.guidanceNeedsUpdate?'资料已补齐，需更新指导。':next.materialFollowup || next.reason || '本项资料已补齐。'):opts.guidanceOnly?'资料已补齐，但本轮指导更新失败：'+(next.reason||'未取得有效指导'):'本项读取仍未完成，可再次补取。'};
    if(run.phase==='原著指导' && next.guidance && next.ok){run.status='done';}
    await frCanonTracePersist(run);
    if(run.persisted===false)throw new Error('资料结果保存失败，请重试保存记录。');
    await frCanonTraceFinish(worker,currentItemDone?'done':'error',{reason:run.materialRetryFeedback.text});
    return {ok:!!currentItemDone,result:run.result};
  }catch(error){
    var cancelled=worker._controller.signal.aborted || error.name==='AbortError';
    run.materialRetryFeedback={key:key||'guidance',status:cancelled?'cancelled':'error',text:cancelled?'已停止补取，原有资料保留。':String(error.message||error)};
    await frCanonTraceFinish(worker,cancelled?'cancelled':'error',{reason:run.materialRetryFeedback.text});
    throw error;
  }finally{
    if(opts.signal)opts.signal.removeEventListener('abort',forward);if(typeof window!=='undefined')window.removeEventListener('pagehide',leave);
    frCanonMaterialBusy=null;if(frCanonTraceActive===worker)frCanonTraceActive=previous;frCanonTraceSelected=run.id;frCanonTraceRenderSoon();
  }
}

function frCanonTraceClean(value, run, ancestors) {
  var secrets = run && run._secrets || [];
  var kind=typeof value;
  if(kind==='function'||kind==='symbol')return undefined;
  if(kind==='bigint')return String(value);
  if (typeof value === 'string') {
    var text = value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&#\s]*/gi,"\u00241[已隐藏]");
    secrets.forEach(function(secret) { if(secret) text=text.split(secret).join('[已隐藏]'); });
    return text;
  }
  if (value && typeof value === 'object') {
    var seen=ancestors||new WeakSet();
    if(seen.has(value))return '[循环引用]';
    seen.add(value);
    var tag=Object.prototype.toString.call(value),out;
    var clean=function(v){return frCanonTraceClean(v,run,seen);};
    var privateKey=function(key){return /^_/.test(key)||/^(api[-_]?key|authorization|headers|secret|password|access[-_]?token|refresh[-_]?token|token)$/i.test(key);};
    if(Array.isArray(value))out=value.map(function(v){var item=clean(v);return item===undefined?null:item;});
    else if(tag==='[object Map]'){
      out={type:'Map',entries:[]};value.forEach(function(v,k){if(typeof k==='string'&& privateKey(k))return;var key=clean(k),item=clean(v);if(key!==undefined&& item!==undefined)out.entries.push([key,item]);});
    }else if(tag==='[object Set]'){
      out={type:'Set',values:[]};value.forEach(function(v){var item=clean(v);if(item!==undefined)out.values.push(item);});
    }else if(tag==='[object Date]')out=Number.isNaN(value.getTime())?'无效日期':value.toISOString();
    else if(tag==='[object AbortSignal]')out={type:'AbortSignal',aborted:!!value.aborted,reason:clean(value.reason)};
    else {
      out={};
      if(/Error\]$/.test(tag)){out.name=clean(value.name);out.message=clean(value.message);if(value.stack)out.stack=clean(value.stack);if(value.cause!==undefined)out.cause=clean(value.cause);}
      Object.keys(value).forEach(function(key){
        if(privateKey(key))return;
        var descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor||!Object.prototype.hasOwnProperty.call(descriptor,'value'))return;
        var item=clean(descriptor.value);
        if(item!==undefined)Object.defineProperty(out,clean(key),{value:item,enumerable:true,writable:true,configurable:true});
      });
    }
    seen.delete(value);
    return out;
  }
  return value;
}
function frCanonTraceExport(run) { var target=run || frCanonTraceHistory.find(function(r) { return r.id===frCanonTraceSelected; }) || frCanonTraceHistory[frCanonTraceHistory.length-1] || {};return frCanonTraceClean(target,target); }
function frCanonTraceCurrentTurnPayload(){var turns=frCanonTraceTurns(),turn=turns.find(function(t){return t.runs.some(function(r){return r.id===frCanonTraceSelected;});}) || turns[turns.length-1];return turn?turn.runs.map(function(run){return frCanonTraceExport(run);}):[];}
async function frCanonCopyRecordText(text){
  try{if(window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText==='function'){await window.navigator.clipboard.writeText(text);return;}}catch(_){}
  var previous=document.activeElement,field=document.createElement('textarea');field.value=text;field.setAttribute('readonly','');field.style.cssText='position:fixed;left:-10000px;top:0;';document.body.appendChild(field);
  try{field.select();if(typeof document.execCommand!=='function'||!document.execCommand('copy'))throw new Error('复制失败，请使用导出本轮记录');}
  finally{field.remove();if(previous && previous.isConnected && typeof previous.focus==='function')previous.focus();}
}
function frCanonTraceLinkSignal(parent, child, meta) { var run=parent&& frCanonTraceSignals.get(parent);if(run&& child){var own=Object.assign({},frCanonTraceSignalMeta.get(parent)||{},meta||{});if(Array.isArray(own.targetIds))own.targetIds=own.targetIds.slice();frCanonTraceSignals.set(child,run);frCanonTraceSignalMeta.set(child,own);} }
function frCanonTraceTag(signal,stageKey,subject,targetId){
  if(!signal)return;
  var own=Object.assign({},frCanonTraceSignalMeta.get(signal)||{});
  if(own.stageKey!==stageKey){
    delete own.subject;delete own.targetId;delete own.targetIds;delete own.mergedPhases;
  }
  own.stageKey=stageKey;
  if(arguments.length>2)own.subject=subject||'';
  if(arguments.length>3)own.targetId=targetId||'';
  frCanonTraceSignalMeta.set(signal,own);
}
// 这里只跟踪已经实际安排的工作，不推测未来阶段、耗时或整轮百分比。
function frCanonProgressStart(signal,stageKey,subject){
  var run=signal&&frCanonTraceSignals.get(signal);if(!run || run.status!=='running')return null;
  if(!run._bubbleTasks)Object.defineProperty(run,'_bubbleTasks',{value:[],enumerable:false});
  var meta=frCanonTraceSignalMeta.get(signal)||{},task={run:run,stageKey:stageKey||meta.stageKey,subject:subject===undefined?meta.subject||'':subject,active:true,requestState:'preparing'};
  // 子信号继承工作身份；展示不再靠可能被重跑规则改写的阶段名称猜测。
  task.id='task:'+run._bubbleTasks.length;task.signal=signal;
  frCanonTraceSignalMeta.set(signal,Object.assign({},meta,{progressTaskId:task.id}));
  run._bubbleTasks.push(task);frCanonTraceEvent(run,'progress','开始当前任务',{stage:task.stageKey,subject:task.subject});return task;
}
function frCanonProgressEnd(task){if(task&&task.active){task.active=false;var meta=frCanonTraceSignalMeta.get(task.signal);if(meta?.progressTaskId===task.id){var {progressTaskId,...rest}=meta;frCanonTraceSignalMeta.set(task.signal,rest);}delete task.signal;frCanonTraceEvent(task.run,'progress','当前任务结束',{stage:task.stageKey,subject:task.subject});}}
function frCanonProgressRequest(task,row){if(task&&task.active){task.requestState=row.state;if(row.state==='retry')task.retry={attempt:row.attempt,max:row.max,kind:row.kind};if(row.state==='backup'){task.backup=row.index;task.retry=null;}frCanonTraceEvent(task.run,'progress','请求运行状态',{stage:task.stageKey,subject:task.subject,state:row.state,attempt:row.attempt,max:row.max,backup:row.index});}}
function frCanonBubbleSubject(subject){
  return String(subject||'').split('、').map(function(raw){var name=typeof ceSanitizeCharacterName==='function'?ceSanitizeCharacterName(raw):String(raw).replace(/<[^>]*>/g,'').trim();name=name.split('|')[0].trim();return /^(?:[BCMN]\d+|(?:npc|actor|character)[_-].+|TIME_LOCATION_ROW|SCENE_MAP)$/i.test(name)?'':name;}).filter(Boolean).join('、');
}
function frCanonBubbleTaskLabel(stage,subject){
  subject=frCanonBubbleSubject(subject);
  /* 2026-11-02 玩家报：气泡显示「原著指导 · 当前事件 · 原著指导」，重复两次。
   *
   * 根因：stage 有时是**复合阶段名**「当前事件 · 原著指导」——它整串去查表
   * 查不到，就原样返回，再被外层拼成「原著指导」+「当前事件 · 原著指导」，
   * 同一个词出现两遍。
   *
   * 修法：复合阶段名先拆开，认得的段用映射名，认不得的原样留。
   * 这样「当前事件 · 原著指导」→「判断当前事件」，
   * 外层再拼 phase 就是玩家要的「原著指导 · 判断当前事件」。
   */
  var rawStage=String(stage||'');
  var names={merged:'合并更新变量','canon-merged':'合并更新补演变量',items:'更新物品',characters:'更新人物变量',misc:'更新世界',entry:'更新登场',tags:'校准人物标签',biography:'整理人物生平',vectorContext:'检索资料',stateSnapshot:'读取存档状态',archive:'读取人物档案',worldEvents:'读取世界大事',timeline:'读取年表',
    '人物视角散文':'生成 NPC 视角正文','人物散文':'生成 NPC 视角正文','群像视角散文':'合批生成 NPC 视角正文','配角群像':'合批生成 NPC 视角正文',
    '人物正文':'NPC 视角正文','人物正文复用':'复用 NPC 视角正文','人物正文·失败子集合批重写':'合批重写 NPC 视角正文','预制人物正文续接':'续接 NPC 视角正文','依据随正文返回':'NPC 视角正文及依据已返回',
    '落地依据提取':'补查落地依据','变量重复核验':'核对重复结算','人物边界批量判定':'判断人物边界','人物终态推演':'核对人物状态','正文硬事实提取':'补演边界判定','生平旧账':'核对人物旧账',
    '预制补演路线':'匹配成品','等待普通变量保存':'等待变量演化','等待变量演化结果':'等待变量演化',
    '成品就绪，等变量演化提交':'成品就绪 · 等变量演化','核对存档并提交':'核对存档','复用预制成品':'取用成品',
    '定点修订预制节点':'核对变异','预制变异边界':'核对变异','预制人物修订':'修订 NPC 视角正文','预制人物变量':'结算变量','预制世界大事修订':'修订世界大事',
    '核对预制落地内容':'核对落地','预制节点待落地':'核对落地','保存预制结果':'保存结果',
    '当前事件':'判断当前事件','原著指导':'判断当前事件','世界正文':'世界补演','世界事件补演':'撰写世界补演','世界事件核验':'核对世界补演'};
  var mapOne=function(one){var key=String(one||'').trim();if(!key||key==='处理中')return '';return names[key]||(/[\p{Script=Han}]/u.test(key)?key:'');};
  var stageParts=rawStage.split(/\s*·\s*/).filter(Boolean);
  // 整串认得就按整串走；认不得但能拆成多段，就逐段翻译（去重，避免两段译成同一个词）。
  var mapped='';
  if(names[rawStage]){
    mapped=names[rawStage];
  }else if(stageParts.length>1){
    var seenStage=new Set();
    mapped=stageParts.map(mapOne).filter(function(text){if(!text||seenStage.has(text))return false;seenStage.add(text);return true;}).join(' · ');
  }else{
    mapped=mapOne(rawStage);
  }
  if(!mapped)return '';
  /* 2026-11-02 玩家报：气泡显示「原著指导 · 当前事件 · 原著指导」，同一个词两遍。
   *
   * 根因不只是 stage 查不到表，还有 subject 本身也带着阶段名——
   * 例如 subject="当前事件 · 原著指导"、stage="原著指导"：
   * 拼出来就是 "当前事件 · 原著指导 · 判断当前事件"，照样重复。
   *
   * 修法：subject 里凡是和 stage 映射结果重复的段，或者本身就是阶段名的段，
   * 一律剔除。只留真正的人名／对象名，人名为空时就不拼前半截。
   */
  if(subject){
    var mappedParts=new Set(String(mapped).split(/\s*·\s*/).filter(Boolean));
    var stageRawParts=new Set(rawStage.split(/\s*·\s*/).filter(Boolean));
    subject=subject.split(/\s*·\s*/).filter(function(part){
      var name=String(part||'').trim();
      if(!name)return false;
      if(mappedParts.has(name))return false;      // 和动作名重复
      if(stageRawParts.has(name))return false;    // 和阶段名重复
      if(names[name])return false;                // 本身就是一个可翻译的阶段名
      return true;
    }).join(' · ');
  }
  return (subject?subject+' · ':'')+mapped;
}
function frCanonBubbleIsActor(stage,subject){
  return !!frCanonBubbleSubject(subject)&&['merged','canon-merged','items','characters','tags','biography','变量重复核验','人物视角散文','群像视角散文','预制人物修订','预制人物变量','落地依据提取','人物边界批量判定','人物终态推演','生平旧账','生平压缩'].includes(stage);
}
// 只读已有视图/保存回执。HTTP returned、变量开始和失败都不是人物已保存。
function frCanonBubbleActorSummary(run){
  var names=new Set(),prose=new Map(),variables=new Map(),returned=new Set();
  function add(value){var name=frCanonBubbleSubject(typeof value==='string'?value:value?.name);if(name)name.split('、').forEach(function(one){names.add(one);});}
  (run.requests||[]).forEach(function(req){
    if(frCanonBubbleIsActor(req.stageKey,req.subject))add(req.subject);
    if(req.status==='returned'&&['人物视角散文','群像视角散文','配角群像'].includes(req.stageKey))frCanonBubbleSubject(req.subject).split('、').filter(Boolean).forEach(function(name){returned.add(name);});
  });
  var views=[...(run.executionViews||[]),...(run.events||[]).filter(function(row){return row.type==='view';})];
  views.sort(function(a,b){return (a.time||0)-(b.time||0);}).forEach(function(row){var data=row.data||row;
    if(data.kind==='selection')(data.included||[]).forEach(add);
    if(data.kind==='dispatch'){(data.solo||[]).forEach(add);(data.batches||[]).flat().forEach(add);}
    if(data.kind==='prose'&&data.block?.name){add(data.block.name);prose.set(data.block.name,data);if(String(data.block.body||'').trim())returned.add(data.block.name);}
    if(data.kind==='characters'&&data.name){add(data.name);variables.set(data.name,data);}
  });
  var final=run.executionResult||run.result||{},rolledBack=final.rolledBack===true;
  (final.prose||final.blocks||[]).forEach(function(block){if(!block?.name)return;add(block.name);if(!prose.has(block.name))prose.set(block.name,{block:block,accepted:true});if(String(block.body||'').trim())returned.add(block.name);});
  var accepted=0,pending=0,saved=0,reused=0;
  prose.forEach(function(value,name){
    var body=String(value.block?.body||''),receipt=variables.get(name),completion=receipt?.completion||value.block?.completion;
    var missing=typeof frCanonCompletionMissing==='function'?frCanonCompletionMissing(completion):[];
    var incomplete=completion&&(completion.completed===false||missing.length>0);
    var committed=!rolledBack&&!incomplete&&body&&((receipt?.status==='saved'&&receipt.body===body)||(final.landed===true&&(final.prose||final.blocks||[]).some(function(block){return block.name===name&&block.body===body;})));
    if(committed)saved++;
    if(value.accepted===true&&body){accepted++;if(!committed)pending++;if(value.reused===true)reused++;}
  });
  var summary=names.size?'已登记 '+names.size+' 人 · NPC 视角正文已返回 '+returned.size+' · 已核验 '+accepted+' · 变量待落实 '+pending+' · 已保存 '+saved+(reused?' · 复用 '+reused:''):'';
  return {total:names.size,returned:returned.size,accepted:accepted,pending:pending,saved:saved,reused:reused,text:summary};
}
function frCanonBubbleProgress(run){
  var tasks=[],seen=new Set(),requests=run.requests||[],materials=run._bubbleMaterials||[],extra=[];
  function add(text,key){key=key||text;if(text&&!seen.has(key)){seen.add(key);tasks.push(text);}}
  var activeRequests=requests.filter(function(req){return req.status==='running'||req.status==='queued';});
  (run._bubbleTasks||[]).filter(function(task){return task.active;}).forEach(function(task){var label=frCanonBubbleTaskLabel(task.stageKey,task.subject);if(label)add(label+(task.requestState==='queued'?'（等待请求额度）':'')+(task.retry?'（'+(task.retry.kind==='parse'?'解析重试':'请求重试')+' '+task.retry.attempt+'/'+task.retry.max+'）':'')+(task.backup?'（备用接口 '+task.backup+'）':''),label);});
  activeRequests.forEach(function(req){add(frCanonBubbleTaskLabel(req.stageKey,req.subject));});
  materials.filter(function(task){return task.active;}).forEach(function(task){add(task.label);});
  if(requests.length){var returned=requests.filter(function(req){return req.status==='returned';}).length,failed=requests.filter(function(req){return req.status==='error';}).length,cancelled=requests.filter(function(req){return req.status==='cancelled'||req.status==='interrupted';}).length;
    extra.push('请求已返回 '+returned+'/'+requests.length+' 次，待返回 '+activeRequests.length+' 次'+(failed?'，失败 '+failed+' 次':'')+(cancelled?'，已停止 '+cancelled+' 次':''));}
  if(materials.length)extra.push('资料已读 '+materials.filter(function(task){return task.status==='read';}).length+'/'+materials.length+' 项，待读 '+materials.filter(function(task){return task.active;}).length+' 项'+(materials.some(function(task){return task.status==='error';})?'（有读取失败）':''));
  if(run._bubbleActors){var actor=run._bubbleActors;extra.push('人物已保存 '+actor.saved+' 人／已安排 '+actor.total+' 人，待保存 '+Math.max(0,actor.total-actor.saved)+' 人');}
  var actors=[],ordinary=[],actorRows=new Map(),workRows=[];
  function current(stage,subject,waiting,requestId){
    var work=frCanonBubbleTaskLabel(stage,'');
    if(!work)return;
    workRows.push({stage:stage,subject:frCanonBubbleSubject(subject),requestId:requestId,work:work,waiting:!!waiting});
    if(frCanonBubbleIsActor(stage,subject)){
      var people=frCanonBubbleSubject(subject).split('、').filter(Boolean),work=frCanonBubbleTaskLabel(stage,'');
      people.forEach(function(name){actorRows.set(requestId+'|'+name,{name:name,stage:stage,requestId:requestId,work:work,waiting:!!waiting});});
      var shown=people.slice(0,2).join('、')+(people.length>2?'等'+people.length+'人':'');
      actors.push(frCanonBubbleTaskLabel(stage,shown)+(waiting?'（等待请求额度）':''));
    }else ordinary.push(frCanonBubbleTaskLabel(stage,''));
  }
  var liveTasks=(run._bubbleTasks||[]).filter(function(row){return row.active;});
  var liveById=new Map(liveTasks.map(function(task){return [task.id,task];})),shownTasks=new Set();
  activeRequests.forEach(function(row){
    var task=liveById.get(row._progressTaskId);
    if(!task){current(row.stageKey,row.subject,row.status==='queued',row.id);return;}
    if(!shownTasks.has(task.id)){shownTasks.add(task.id);current(task.stageKey,task.subject,row.status==='queued'||task.requestState==='queued',task.id);}
  });
  liveTasks.forEach(function(task){if(!shownTasks.has(task.id))current(task.stageKey,task.subject,task.requestState==='queued',task.id);});
  var reading=materials.filter(function(row){return row.active;}).at(-1),search=reading&&reading.key==='vectorContext'?reading:null;
  var searchNames={analysis:'分析检索条件',embedding:'向量化检索条件',matching:'匹配设定资料',rerank:'重排检索结果'};
  var currentMaterial=search?(search.requestState==='queued'?'等待检索额度':searchNames[search.stage]||'检索资料'):reading?reading.label:'';
  materials.filter(function(row){return row.active;}).forEach(function(row,index){workRows.push({stage:'资料',requestId:'material:'+index,work:row.label||'读取资料',waiting:row.requestState==='queued'});});
  return {tasks:tasks,extra:extra,actors:actors,actorRows:Array.from(actorRows.values()),workRows:workRows,summary:frCanonBubbleActorSummary(run),currentTask:currentMaterial||ordinary.at(-1)||''};
}
function frCanonTraceFilterLoadedBranch() {
  var branch=frCanonTraceBranch;
  if(!branch || branch.archiveName!==currentArchiveName)return;
  frCanonTraceHistory.forEach(function(run){
    // 重新载入的记录没有控制器；本页活跃任务由回退入口取消，不因普通刷新误伤。
    if(run.archiveName===branch.archiveName && !run._controller && (!run.logId || !branch.ids.has(run.logId)))run.branchHidden=true;
  });
}
// Only a bounded player-facing card for the current floor; execution receipts remain separate.
var frCanonCurrentDisplays=new Map();
window.FRReadWorldviewTurn=function(){
  var archive=currentArchiveName;
  if(!archive||(typeof frCurrentBranchArchiveName==='function'&&frCurrentBranchArchiveName()!==archive))return null;
  var floor=typeof frCurrentBranchLogId==='function'?frCurrentBranchLogId():frCanonCurrentDisplayResolveFloor(archive);
  var live=window.FRWorldview?.traceCurrent?.(archive,floor);
  if(live)return live.trace;
  if(typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating)return null;
  var state=frCanonCurrentDisplays.get(archive);
  return floor&&state?.floor===floor?state.runs['世界观指导']||null:null;
};
// Adopted story identity is transient until saveToLog moves the bounded display anchor.
var frCanonCurrentDisplayPending=null;
function frCanonCurrentDisplayPendingRun(archive){
  var own=typeof frCanonCurrentDisplayPending==='object'&&frCanonCurrentDisplayPending;
  if(!own||own.archiveName!==archive||archive!==currentArchiveName)return null;
  var run=frCanonTraceHistory.find(function(row){return row.id===own.runId&&row.archiveName===archive&&String(row.logId)===own.logId&&!row.branchHidden&&row.result?.rolledBack!==true;});
  return run&&frCanonTraceSignals.get(own.signal)===run?own:null;
}
function frCanonCurrentDisplayResolveFloor(archive){
  var pending=frCanonCurrentDisplayPendingRun(archive);
  if(pending)return pending.logId;
  // Same authority as branch options: the actually rendered AI floor, not a stale global.
  if(typeof frCurrentBranchLogId==='function')return String(frCurrentBranchLogId()||'');
  var state=typeof frCanonCurrentDisplays!=='undefined'&&frCanonCurrentDisplays.get(archive);
  return state?String(state.floor||''):String((typeof window!=='undefined'&&window._ceCurrentLogId)||'');
}
function frCanonCurrentDisplayFloor(logs){
  return String(logs?.findLast(function(row){return row?.type==='ai'&&row.id&&!row.isGhost&&!row.isSnapshot&&!row.isUndoSnapshot&&!row.isDeepSummary&&!String(row.content||'').includes('<h4>天道初启</h4>');})?.id||'');
}
function frCanonCurrentDisplayQueue(state,work){
  state.queue=state.queue.then(work).catch(function(error){console.warn('[原著补演] 本层展示保存或恢复失败:',error);});
  return state.queue;
}
function frCanonSavedActorViews(floor){
  return Object.values(floor?.canonActorCommits||{}).filter(row=>row?.status==='saved'&&row.actorId&&row.name&&row.applied).map(row=>({
    type:'view',data:{kind:'characters',status:'saved',name:row.name,actorId:row.actorId,body:row.body,applied:row.applied}
  }));
}
function frCanonCurrentDisplayRestore(archive,floor,runs){
  if(!floor||currentArchiveName!==archive)return;
  for(var phase of ['原著指导','正文后补演']){
    var row=runs[phase];
    if(row?.phase===phase&&row.archiveName===archive&&row.logId===floor&&
       !frCanonTraceHistory.some(function(run){return run.archiveName===archive&&run.logId===floor&&run.phase===phase;})){
      const restored=Object.assign({},row,{_currentDisplayRestored:true});
      if(row._savedActorViews)Object.defineProperty(restored,'_savedActorViews',{value:row._savedActorViews});
      frCanonTraceHistory.push(restored);
    }
  }
}
function frCanonCurrentDisplayAnchor(archive,floor){
  if(!archive||archive!==currentArchiveName||typeof dbGet!=='function')return Promise.resolve();
  if(typeof frCanonCurrentDisplayPending!=='undefined'&&frCanonCurrentDisplayPending?.archiveName===archive&&frCanonCurrentDisplayPending.logId===floor)frCanonCurrentDisplayPending=null;
  var state=frCanonCurrentDisplays.get(archive);
  if(!state){
    state={floor:null,queue:Promise.resolve(),key:'FR_CANON_CURRENT_DISPLAY_V1:'+archive,runs:{}};
    frCanonCurrentDisplays.set(archive,state);
  }
  if(state.floor===floor)return state.queue.then(function(){
    if(state.floor===floor)frCanonCurrentDisplayRestore(archive,floor,state.runs);
  });
  var leftFloor=state.floor!==null;
  state.floor=floor;
  state.runs={};
  frCanonTraceHistory=frCanonTraceHistory.filter(function(run){return run.archiveName!==archive||!run.logId||String(run.logId)===floor;});
  return frCanonCurrentDisplayQueue(state,async function(){
    if(leftFloor){
      if(typeof dbRemove==='function')await dbRemove(state.key);
      else await dbSet(state.key,null);
      return;
    }
    var stored=await dbGet(state.key);
    if(state.floor!==floor)return;
    if(!stored)return;
    if(!floor||stored.logId!==floor){
      if(typeof dbRemove==='function')await dbRemove(state.key);
      else await dbSet(state.key,null);
      return;
    }
    for(var phase of ['原著指导','正文后补演']){
      var row=stored.runs?.[phase];
      if(row?.phase!==phase||row.archiveName!==archive||row.logId!==floor)continue;
      state.runs[phase]=row;
    }
    if(stored.runs?.['世界观指导']?.endedAt)state.runs['世界观指导']=stored.runs['世界观指导'];
    const restored=state.runs['正文后补演'];
    if(restored){
      const archiveRow=await db.archives.get(archive),log=archiveRow?.data?.logs?.find(row=>String(row.id)===floor);
      if(state.floor!==floor||currentArchiveName!==archive)return;
      Object.defineProperty(restored,'_savedActorViews',{value:frCanonSavedActorViews(log),configurable:true});
      const ledger=archiveRow?.data?.state?.canonLedger;
      if(log?.canonTurnCommit&&ledger?.worldTime===log.canonTurnCommit.worldTime){
        restored.result={...restored.result,landed:true,ledgerPlan:{...restored.result?.ledgerPlan,next:ledger}};
        Object.defineProperty(restored,'_savedEventVariables',{value:frCanonSavedEventVariables(archiveRow,floor),configurable:true});
      }
    }
    frCanonCurrentDisplayRestore(archive,floor,state.runs);
    window.FRWorldviewTrace?.renderSoon();
  });
}
// Called only after a real AI log has been saved, including retained-story failure paths.
async function frCanonCurrentDisplayAdopted(archive,floor){
  await frCanonCurrentDisplayAnchor(archive,floor);
  if(archive!==currentArchiveName)return;
  var worldview=window.FRWorldview?.traceAdopted?.(archive,floor);
  var state=frCanonCurrentDisplays.get(archive);
  if(worldview&&state?.floor===floor){
    await frCanonCurrentDisplayQueue(state,async function(){
      if(state.floor!==floor||archive!==currentArchiveName||state.runs['世界观指导']===worldview)return;
      state.runs['世界观指导']=worldview;
      await dbSet(state.key,{logId:floor,runs:state.runs});
    });
  }
  for(var run of frCanonTraceHistory.filter(function(row){return row.archiveName===archive&&String(row.logId)===floor&&row.phase==='原著指导'&&row.endedAt&&!row.branchHidden;})){
    if(archive!==currentArchiveName)return;
    await frCanonCurrentDisplaySave(run);
  }
}
function frCanonCurrentDisplayCard(run){
  var guidance=run.phase==='原著指导',visible=Object.assign({},run.result,run.executionResult);
  var result={},events=[],requests=[];
  if(guidance){
    var source=run.guidanceDisplay||visible;
    if(!source.text)return null;
    result=frCanonGuidanceDisplayResult(source.text,source);
  }else{
    var keys=['status','ok','landed','committed','reason','landReason','partial','actorProgressSaved','range','worldTime','endTime','prose','blocks','worldForMisc','worldBlock','worldNoChanges','debts','backstoryDebts','worldDebts','unconfirmedEvents','failedBatches','progressFailure','blockedOps','eventProgress','openEvents'];
    keys.forEach(function(key){if(visible[key]!==undefined)result[key]=visible[key];});
    var viewByKey=new Map(),pointer=visible.turnPlan,observedAnalysis;
    [...(run.executionViews||[]),...(run._displayViews?.values()||[]),...(run.events||[])].forEach(function(row){
      var value=row?.data;
      if(row.type!=='view'||!value)return;
      if(value.turnPlan?.eventWindows)pointer=value.turnPlan;
      var view;
      if(value.kind==='storyAnalysis')observedAnalysis=value;
      if(value.kind!=='routing'&&value.kind!=='canonTurnPlan')view=frCanonCurrentDisplayView(value);
      if(view)viewByKey.set(view.kind+':'+(view.name||view.block?.name||''),{type:'view',data:view});
    });
    if(pointer)result.turnPlan=frCanonCurrentDisplayPlan(pointer);
    if(visible.ledgerPlan)result.ledgerPlan={changed:visible.ledgerPlan.changed,next:{openEvents:visible.ledgerPlan.next?.openEvents}};
    if(visible.storyAnalysis&&!observedAnalysis)result.storyAnalysis=frCanonCurrentDisplayView({kind:'storyAnalysis',...visible.storyAnalysis});
    var names=new Set((result.prose||result.blocks||[]).map(function(row){return row?.name;}));
    events=Array.from(viewByKey.values()).filter(function(row){return row.data.kind!=='prose'||!names.has(row.data.block?.name);});
    requests=(run.requests||[]).slice(-120).map(function(req){return {stageKey:req.stageKey,subject:req.subject,targetId:req.targetId,targetIds:req.targetIds,status:req.status};});
    if(!Object.keys(result).length&&!events.length)return null;
  }
  var card=frCanonTraceClean({id:run.id,phase:run.phase,archiveName:run.archiveName,logId:String(run.logId),turnId:'floor:'+run.logId,
    startedAt:run.startedAt,endedAt:run.endedAt,status:run.status,result:result,events:events,requests:requests},run);
  if(JSON.stringify(card).length>384*1024){
    card.events=card.events.filter(function(row){return row.data?.kind!=='characters';});
    if(JSON.stringify(card).length>384*1024){
      var headline={};['text','status','landed','reason','range','turnPlan'].forEach(function(key){if(card.result[key]!==undefined)headline[key]=card.result[key];});
      card.result=headline;card.events=[];
    }
  }
  return JSON.stringify(card).length<=384*1024?card:null;
}
function frCanonCurrentDisplaySave(run,committed,checkpoint){
  var state=frCanonCurrentDisplays.get(run?.archiveName),phase=run?.phase;
  var inProgress=run?.status==='running';
  if(!state||run.archiveName!==currentArchiveName||!run.logId||state.floor!==String(run.logId)||
      !['原著指导','正文后补演'].includes(phase)||(!run.endedAt&&!(checkpoint&&inProgress))||
      run.branchHidden||run._currentDisplayRestored||run.result?.rolledBack===true||(run._replay&&!committed))return Promise.resolve();
  if(!frCanonTraceHistory.includes(run))return Promise.resolve();
  var card,floor=state.floor;
  try{card=frCanonCurrentDisplayCard(run);}catch(error){
    console.warn('[原著补演] 无法整理本层展示:',error);
    return Promise.resolve();
  }
  if(!card)return Promise.resolve();
  if(inProgress){
    card.status='interrupted';
    card.result.landed=false;card.result.committed=false;
    card.result.reason='上次运行未结束，已保留本层当时的展示。';
    card.requests.forEach(function(req){if(['running','queued'].includes(req.status))req.status='interrupted';});
  }
  return frCanonCurrentDisplayQueue(state,async function(){
    if(state.floor!==floor||run.archiveName!==currentArchiveName||!frCanonTraceHistory.includes(run))return;
    var old=state.runs[phase];
    if(old&&old.id!==card.id&&Number(old.startedAt)>Number(card.startedAt))return;
    if(old&&committed&&run._replay?.selection?.replay?.actorReplacement){
      ['turnPlan','eventProgress','worldForMisc','worldBlock','worldNoChanges'].forEach(function(key){
        if(card.result[key]===undefined&&old.result[key]!==undefined)card.result[key]=old.result[key];
      });
      if(JSON.stringify(card).length>384*1024)return;
    }
    if(old&&JSON.stringify(old)===JSON.stringify(card))return;
    state.runs[phase]=card;
    await dbSet(state.key,{logId:floor,runs:state.runs});
  });
}
function frCanonCurrentDisplayReplayFailure(archiveName,logId,reason){
  var state=frCanonCurrentDisplays.get(archiveName),floor=String(logId);
  if(!state||state.floor!==floor||archiveName!==currentArchiveName)return Promise.resolve();
  return frCanonCurrentDisplayQueue(state,async function(){
    var previous=state.runs['正文后补演'];
    if(!previous||state.floor!==floor||archiveName!==currentArchiveName)return;
    state.runs['正文后补演']={...previous,result:{...previous.result,replayFailure:reason}};
    await dbSet(state.key,{logId:floor,runs:state.runs});
    frCanonTraceRenderSoon();
  });
}
function frCanonCurrentDisplayCapture(run,type,data){
  if(run.phase!=='正文后补演'||type!=='view'||!data)return;
  var kind=data.kind;
  var view=frCanonCurrentDisplayView(data);
  if(!view)return;
  if(!run._displayViews)Object.defineProperty(run,'_displayViews',{value:new Map()});
  run._displayViews.set(kind+':'+(view.name||view.block?.name||''),{type:'view',data:kind==='characters'&&data.status==='saved'?data:view});
}
function frCanonCurrentDisplayPlan(plan){
  return {range:plan.range,time:plan.time,route:plan.route,mode:plan.mode,turnAdvanceTier:plan.turnAdvanceTier,coveredEventIds:plan.coveredEventIds,involvedActors:plan.involvedActors,
    canonJobs:Array.isArray(plan.canonJobs)?plan.canonJobs.filter(Boolean).map(function(row){return {name:row.name,actorRef:row.actorRef,eventIds:row.eventIds};}):undefined,
    prebuiltUnreachedEventIds:plan.prebuiltUnreachedEventIds,ordinaryUnreachedEventIds:plan.ordinaryUnreachedEventIds,
    eventWindows:plan.eventWindows,eventWatches:plan.eventWatches,observedEventProgress:plan.observedEventProgress,savedEventProgress:plan.savedEventProgress,
    decisions:Array.isArray(plan.decisions)?plan.decisions.filter(Boolean).map(function(row){return {name:row.name,actorRef:row.actorRef,canonAdvance:row.canonAdvance,reason:row.reason,corridor:row.corridor?{breakReasons:row.corridor.breakReasons}:undefined};}):undefined};
}
function frCanonSavedEventVariables(archive,logId){
  const logs=archive?.data?.logs||[];
  const index=logs.findIndex(row=>String(row.id)===String(logId));
  const read=text=>{try{return typeof text==='string'?JSON.parse(text):text;}catch(_){return null;}};
  const saved=read(logs[index]?.canonTurnCommit?.stateText);
  if(!saved?.canonLedger)return [];
  let previous=null;
  for(let i=index-1;i>=0;i--){
    if(logs[i].isGhost||logs[i].isUndoSnapshot)continue;
    const state=read(logs[i].canonTurnCommit?.stateText)||read(logs[i].stateSnapshot);
    if(state&&typeof state==='object'){previous=state.canonLedger||state.currentState?.canonLedger||{};break;}
  }
  return ceBridgeCore()['canon-event-details'].committedEventVariables(previous,saved.canonLedger,String(logId));
}

function frCanonBoundaryEventGroups(windows,progress,now,clock,precision,unreachedIds=[]){
  const groups={past:[],ongoing:[],unstarted:[]};
  const byId=new Map((progress||[]).map(row=>[row.eventId,row]));
  const unreached=new Set(unreachedIds);
  const confirmedOngoing=[...byId.values()].some(row=>row.resolved!==true&&['ongoing','changed','blocked'].includes(row.status));
  for(const window of windows){
    if(unreached.has(window.eventId)){groups.unstarted.push(window);continue;}
    const row=byId.get(window.eventId),timing=row?.timingChange||window.timingChange;
    const start=clock(window.startAt),rawEnd=clock(window.endAt),end=rawEnd===null?null:rawEnd+(precision(window.endAt)==='day'?1440:0);
    if(row?.resolved===true||['completed','replaced','expired','cancelled'].includes(row?.status)){groups.past.push(window);continue;}
    if((row&&['ongoing','changed','blocked'].includes(row.status))||timing?.kind==='delayed'){groups.ongoing.push(window);continue;}
    if(start===null||end===null||now===null||start>now){groups.unstarted.push(window);continue;}
    if(now>=end){groups.past.push(window);continue;}
    groups[confirmedOngoing?'unstarted':'ongoing'].push(window);
  }
  return groups;
}

function frCanonRenderSavedEventVariables(card,rows){
  if(!rows.length)return;
  const make=(tag,text,className)=>{
    const node=document.createElement(tag);
    if(text)node.textContent=text;
    if(className)node.className=className;
    return node;
  };
  const details=make('details','','fr-canon-event-saves');
  details.open=rows.length<=8;
  details.append(make('summary','本轮已保存变量 · '+rows.length+' 项'));
  const byPerson=new Map();
  for(const row of rows){
    const key=row.name||'公共记录';
    if(!byPerson.has(key))byPerson.set(key,[]);
    byPerson.get(key).push(row);
  }
  for(const [name,changes] of byPerson){
    const group=make('div','','fr-canon-event-save-person');
    group.append(make('strong',name));
    const list=make('ul');
    for(const row of changes){
      const item=make('li');
      item.append(make('strong',row.label),' · '+row.detail);
      if(row.status==='withdrawn')item.prepend(make('span','已撤回','fr-canon-event-withdrawn'));
      if(row.point){
        const basis=make('p','依据：'+row.point,'fr-canon-event-save-basis');
        const ref=/^P(\d+)$/iu.exec(row.evidenceRef||'');
        if(ref)basis.append(make('small','原文第'+Number(ref[1])+'段'));
        item.append(basis);
      }
      list.append(item);
    }
    group.append(list);details.append(group);
  }
  card.append(details);
}

function frCanonCurrentDisplayView(data){
  var kind=data.kind,out={kind:kind},keys={
    prose:['block','accepted','reused'],characters:['name','actorId','id','status','body','completion','applied'],
    eventProgress:['rows','confirmed'],savedEventVariables:['rows'],world:['body'],worldNoChange:['noChanges'],replayMaterial:['name','proseStage'],
    storyAnalysis:['turnAdvanceTier','handled','influences','worldEvents','coveredEventIds','involvedActors','rejectedActors'],
    judgement:['musts','diff'],selection:['included','excludedStory','excludedStoryEvidence','excludedNonCanon','handoffNames'],
    events:['range','events'],retrieval:['status','reason','completed','attempted','requiredCharacters'],materials:['profile','report']
  }[kind];
  if((kind==='canonTurnPlan'||kind==='routing')&&data.turnPlan)return {kind:kind,turnPlan:frCanonCurrentDisplayPlan(data.turnPlan)};
  if(!keys)return null;
  keys.forEach(function(key){if(data[key]!==undefined)out[key]=data[key];});
  if(kind==='materials'&&Array.isArray(out.report))out.report=out.report.filter(Boolean).map(function(row){
    return {key:row.key,label:row.label,chars:row.chars,originalChars:row.originalChars,status:row.status,truncated:row.truncated,reason:row.reason,selectedCount:row.selectedCount,unit:row.unit};
  });
  if(kind==='events'&&Array.isArray(out.events))out.events=out.events.filter(Boolean).map(function(row){
    return {title:row.title||row.code,start:row.start||row.startTime,end:row.end||row.endTime};
  });
  if(kind==='characters'&&out.applied)out.applied={items:Array.isArray(out.applied.items)?out.applied.items.filter(Boolean).map(function(row){return {type:row.type,itemName:row.itemName};}):undefined};
  return out;
}
async function frCanonTraceLoad(logs,options) {
  var archive=typeof currentArchiveName==='string'?currentArchiveName:'';
  if(Array.isArray(logs))frCanonTraceBranch={archiveName:archive,ids:new Set(logs.map(function(log){return log.id;}))};
  frCanonTraceFilterLoadedBranch();
  var restore=!!options?.restoreDisplay;
  // Pipeline loads must not resurrect a previous floor after the new-turn reset.
  var canRestore=restore&&!(typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating)&&
    !(typeof frCanonCurrentDisplayPendingRun==='function'&&frCanonCurrentDisplayPendingRun(archive));
  var displayFloor=Array.isArray(logs)?frCanonCurrentDisplayFloor(logs):canRestore&&typeof frCanonCurrentDisplayResolveFloor==='function'?frCanonCurrentDisplayResolveFloor(archive):null;
  if(!Array.isArray(logs)&&displayFloor!==null){
    // A tab is read-only. During archive switching the old DOM may still be on screen.
    // Unknown, empty or foreign DOM never authorizes moving/deleting another display anchor.
    var owner=typeof frCurrentBranchArchiveName==='function'?frCurrentBranchArchiveName():archive;
    if(owner!==archive||!displayFloor||typeof db==='undefined'||!db.archives)displayFloor=null;
    else if(frCanonCurrentDisplays.get(archive)?.floor!==displayFloor){
      try{
        var storedArchive=await db.archives.get(archive);
        if(currentArchiveName!==archive||typeof isMainApiGenerating!=='undefined'&&isMainApiGenerating||
           (typeof frCurrentBranchArchiveName==='function'&&frCurrentBranchArchiveName()!==archive)||
           frCanonCurrentDisplayResolveFloor(archive)!==displayFloor||
           frCanonCurrentDisplayFloor(storedArchive?.data?.logs)!==displayFloor)displayFloor=null;
      }catch(_){displayFloor=null;}
    }
  }
  if(currentArchiveName!==archive)return;
  if(frCanonTraceArchive===archive){
    if(displayFloor!==null&&typeof frCanonCurrentDisplayAnchor==='function')await frCanonCurrentDisplayAnchor(archive,displayFloor);
    return;
  }
  frCanonTraceArchive=archive;frCanonTraceSelected='';frCanonTraceHistory=[];
  if(!archive)return;
  if(displayFloor!==null&&typeof frCanonCurrentDisplayAnchor==='function')await frCanonCurrentDisplayAnchor(archive,displayFloor);
  // Never read the unbounded pre-1.0.7 trace history.
  try{
    if(typeof dbRemove==='function')await dbRemove('FR_CANON_TRACE_V1:'+archive);
    else if(typeof dbSet==='function')await dbSet('FR_CANON_TRACE_V1:'+archive,null);
  }catch(_){}
  /* ★★★ 2026-11-03 玩家：「为什么该清理的数据一直没清理，也是个问题」。
   * 上面这一行只删**当前存档**的 TRACE 表。但真机上最肥的一条是：
   *     FR_CANON_TRACE_V1:我的修仙路   328.25 MB
   * 「我的修仙路」这个存档早就删了，它的数据却永远没人删 ——
   * 因为这条清理只认「当前存档名」，存档一删，它的垃圾就变成永久孤儿。
   *
   * 同理还有 FR_REPLAY_BASE_V1 / FR_REPLAY_RECOVERY_V1 /
   * FR_CANON_MATERIALS_V1 / FR_CANON_BOUNDARY_V1 / FR_CANON_GUIDANCE_V1 /
   * FR_CANON_TURN_ARTIFACTS_V1 都带存档名，都会留下孤儿。
   *
   * 玩家定的规矩是「资料数据跟着快照行动」+「清理应该是独立端自己能进行的流程」，
   * 所以这里做一次**按存档名对账的全局清扫**：凡是带有存档名的这些前缀里，
   * 存档名不在当前存档列表中的，一律删掉。不依赖玩家手动操作。 */
  frCanonOrphanSweepSoon();
}

/* ★★★ 2026-11-03 孤儿数据清扫（彻底解决「该清一直没清」）
 *
 * 【问题】所有按存档名分区的持久化都在 db.settings，清理函数只清当前存档。
 * 玩家删掉存档 / 改名 / 重开之后，旧存档名下的数据全部变成没人管的孤儿，
 * 而且**永远不会再被任何代码读或删**。玩家机器上实测 328MB 就这么来的。
 *
 * 【做法】以 db.archives 的存档名为唯一真相：
 *   · 列出所有带存档名分区的 key
 *   · 解析出它的存档名
 *   · 存档名不在存活列表里 → 删
 *
 * 【安全边界】
 *   ① 只处理明确「按存档名分区」的已知前缀，不做模糊匹配，绝不误删配置项
 *      （CULTIVATION_* / WORLD_EVOLUTION_* 这些没有存档名的配置一律不碰）。
 *   ② 只要 db.archives 读不出来（返回空/异常），直接放弃整轮清扫 ——
 *      宁可不清，也不能把玩家所有存档资料当成孤儿删光。
 *   ③ 分批删、每批让出主线程，避免像原来那样「一次清 628MB 表卡死」。
 *   ④ 全程 try/catch，清扫失败绝不影响补演主流程。 */
var FR_CANON_ORPHAN_PREFIXES=[
  'FR_CANON_TRACE_V1:',
  'FR_CANON_CURRENT_DISPLAY_V1:',
  'FR_CANON_TURN_ARTIFACTS_V1:',
  'FR_CANON_MATERIALS_V1:',
  'FR_CANON_BOUNDARY_V1:',
  'FR_CANON_GUIDANCE_V1:',
  'FR_REPLAY_BASE_V1:',
  'FR_REPLAY_RECOVERY_V1:'
];
var frCanonOrphanSweepAt=0;
function frCanonOrphanSweepSoon(){
  /* 一个页面生命周期内只扫一次；也不和补演抢主线程。 */
  if(frCanonOrphanSweepAt&&Date.now()-frCanonOrphanSweepAt<60000)return;
  frCanonOrphanSweepAt=Date.now();
  var run=function(){
    Promise.resolve(frCanonOrphanSweep()).catch(function(e){
      try{console.warn('[孤儿清扫] 跳过：'+String(e&&e.message||e));}catch(_){}
    });
  };
  if(typeof setTimeout==='function')setTimeout(run,1200);
  else run();
}
async function frCanonOrphanSweep(){
  try{
    if(typeof db==='undefined'||!db||!db.settings||!db.archives)return 0;
    // 两张表的主键就是存档名和设置键。清扫无需读入存档正文或旧诊断内容。
    var names=await db.archives.toCollection().primaryKeys();
    if(!names.length)return 0;
    var live=new Set(names);
    var keys=await db.settings.toCollection().primaryKeys();
    var doomed=[];
    keys.forEach(function(key){
      if(typeof key!=='string')return;
      var hit=FR_CANON_ORPHAN_PREFIXES.find(function(prefix){return key.startsWith(prefix);});
      if(!hit)return;
      var owner=key.slice(hit.length);
      if(!owner||live.has(owner))return;
      // 分区键可以带楼层或类型后缀，存档名本身也可以含冒号。
      if(hit!=='FR_CANON_CURRENT_DISPLAY_V1:'){
        for(var colon=owner.indexOf(':');colon!==-1;colon=owner.indexOf(':',colon+1)){
          if(live.has(owner.slice(0,colon)))return;
        }
      }
      doomed.push(key);
    });
    if(!doomed.length)return 0;

    /* ③ 分批删，每批 4 条并让出一次事件循环，避免卡死主线程 */
    var removed=0;
    for(var k=0;k<doomed.length;k++){
      var rmKey=doomed[k];
      try{
        /* ★ 2026-11-03 这里绝不能 dbGet + JSON.stringify。
         * 真机上 FR_CANON_TRACE_V1:我的修仙路 单条就是 328MB，
         * 读出来再序列化一次会直接把主线程卡死 ——
         * 原来那张表 628MB 时，「清理一次就卡死」就是这么来的。
         * 删除只传 key，开销与体积无关。 */
        if(typeof dbRemove==='function')await dbRemove(rmKey);
        else if(typeof dbSet==='function')await dbSet(rmKey,null);
        removed++;
      }catch(_){}
      /* 每删 4 条让出一次事件循环。 */
      if(k%4===3)await new Promise(function(r){setTimeout(r,0);});
    }
    try{
      console.log('[孤儿清扫] 已删除 '+removed+' 条无主存档数据 ｜ 存活存档: '+Array.from(live).join(','));
    }catch(_){}
    return removed;
  }catch(_){return 0;}
}
function frCanonTraceVisibility(){return frCanonTraceHistory.filter(function(r){return r.archiveName===currentArchiveName;}).map(function(r){return {id:r.id,hidden:!!r.branchHidden};});}

/* 自愈：把「被误隐藏」的原著指导记录重新显示出来。
 *
 * 玩家 2026-10-31 反复反馈：「原著指导的ui还是没有」。
 *
 * 原因有两层：
 *   ① 之前几版把已经跑完、已经注入正文的指导记录误判成「待丢弃的旧记录」，
 *      打上了 branchHidden=true；
 *   ② 修复只改了「以后不再误隐藏」，**已经落库的 hidden 标记不会自己消失**。
 *      所以玩家打开面板，那段指导依然是空的 —— 修了但看不见。
 *
 * 这里的判据刻意保守：只有「确实有产出」的指导记录才恢复。
 * 空壳记录（没跑完、没结论）保持隐藏，否则会冒出半截垃圾。
 * 恢复是一次性的：同一个 id 恢复过就记下来，避免玩家手动隐藏后又被自动拉回来。
 */
async function frCanonTraceHealGuidance(){
  var archive=typeof currentArchiveName==='string'?currentArchiveName:'';
  if(!archive)return 0;
  var healed=0;
  for(var run of frCanonTraceHistory){
    if(!run||run.archiveName!==archive)continue;
    if(run.phase!=='原著指导')continue;
    if(!run.branchHidden)continue;                 // 没隐藏，不用管
    // 有真实产出才恢复
    var hasOutput=run.status!=='running' && run.result &&
      (run.result.guidance || run.result.text || run.result.injectable!==undefined ||
       (run.result.materialReport||[]).length);
    if(!hasOutput)continue;
    run.branchHidden=false;
    healed++;
    await frCanonTracePersist(run);
  }
  if(healed){
    console.log('[原著补演] 已恢复 '+healed+' 条被误隐藏的原著指导记录');
    frCanonTraceSelected='';frCanonTraceRenderSoon();
  }
  return healed;
}

/* 重roll 时**直接清掉**旧的补演记录，不再保留历史。
 *
 * 玩家 2026-11-02 定的规则（原话）：
 *   「我想了一下，旧的原著补演部分的历史干脆不要保存了，
 *     重roll 就直接清理，别把问题搞复杂了」
 *
 * 之前的做法是打 branchHidden 标记、渲染成「已被重roll覆盖 · 以下为历史记录」
 * 的折叠块。玩家明确否掉了：旧结果就该消失，不该留着让人多看一眼。
 *
 * 边界（不能伤及无辜）：
 *   · **只删补演类记录**。原著指导是正文之前跑的，重roll 后该沿用，
 *     玩家早前交代过「没有修改行动指令选择情况原著指导内容的话
 *     原著指导是保留旧的」，所以这里绝不碰 phase==='原著指导'。
 *   · 只删当前存档的记录。
 *   · 内存和存档一起删，刷新后也不会再冒出来。
 *   · 仍在跑的旧记录先中止，避免它继续写脏数据。
 */
async function frCanonTracePurge(runs){
  var list=(runs||[]).filter(function(run){return run&& run.archiveName===currentArchiveName&& run.phase!=='原著指导';});
  if(!list.length)return 0;
  var ids=new Set(list.map(function(run){return run.id;}));
  list.forEach(function(run){
    if(run.status==='running'&& run._controller){try{run._controller.abort();}catch(_){}}
  });
  frCanonTraceHistory=frCanonTraceHistory.filter(function(run){return !ids.has(run.id);});
  frCanonTraceSelected='';
  /* 运行记录只活在内存里：从 frCanonTraceHistory 里移除就是真的没了，
   * 不再有「同步写一份到 db.settings 的 FR_CANON_TRACE_V1 表」这一步。
   * 原来这里要 dbGet 整表再 dbSet 整表，玩家机器上那张表已 628MB，
   * 清理一次就卡死主线程。 */
  frCanonTraceRenderSoon();
  return list.length;
}
async function frCanonTraceReplace(context,committedIds){
  // 新结果提交后才能替换旧记录。准备、失败、取消均不能先把原页面清空。
  if(!Array.isArray(committedIds)||!committedIds.length)return;
  /* 2026-11-02 玩家：「旧的原著补演部分的历史干脆不要保存了，重roll 就直接清理」。
   * 这里原来只是打 branchHidden=true 标记，把旧记录折叠起来。
   * 渲染层的折叠块已经按玩家要求删掉，标记如果还留着，
   * 记录就会挂在内存和存档里占地方、也让后续统计（资料补取校验等）多一层判断。
   * 现在改成直接清掉：和 frCanonTracePurge 走同一条路，只动补演类记录。
   */
  var stale=frCanonTraceHistory.filter(function(r){
    return r.archiveName===currentArchiveName && r.logId===context.logId
      && r.phase===(context.system==='ce'?'变量演化':'正文后补演')
      && !committedIds.includes(r.id);
  });
  if(stale.length)await frCanonTracePurge(stale);
  if(context.system!=='ce'&&typeof frCanonCurrentDisplaySave==='function'){
    var accepted=frCanonTraceHistory.findLast(function(run){
      return run.archiveName===currentArchiveName&&run.logId===context.logId&&run.phase==='正文后补演'&&committedIds.includes(run.id);
    });
    if(accepted)await frCanonCurrentDisplaySave(accepted,true);
  }
  frCanonTraceSelected='';frCanonTraceRenderSoon();
}
async function frCanonTraceRestoreVisibility(saved){
  var map=new Map((saved || []).map(function(row){return [row.id,row.hidden];}));
  for(var run of frCanonTraceHistory.filter(function(r){return r.archiveName===currentArchiveName;})){run.branchHidden=map.has(run.id)?map.get(run.id):true;await frCanonTracePersist(run);}
  frCanonTraceSelected='';frCanonTraceRenderSoon();
}
async function frCanonTraceRollback(logs,discardPending){
  var ids=new Set((logs || []).map(function(log){return log.id;}));
  var pending=[];
  for(var run of frCanonTraceHistory.filter(function(r){return r.archiveName===currentArchiveName;})){
    /* ★★ 2026-10-31 玩家：「你应该做的是不要隐藏，而不是先隐藏再想办法找回来」
     *
     * 这个函数是「回退到某个楼层」时，把该楼层**之后**的观测记录作废。
     * 作废的依据只能是「这条记录属于哪个楼层」——也就是 run.logId。
     *
     * 原来的写法：
     *     if(run.logId ? !ids.has(run.logId) : discardPending!==false){
     *       run.branchHidden=true;   // ← 没有 logId 的记录一律隐藏
     *     }
     * 问题在于 **run.logId 为空 = 这条记录不属于任何楼层**，不是
     * 「它属于一个被撤销的楼层」。而原著指导恰恰是**正文前**跑的，
     * 那时候楼层还不存在，logId 天然为空。
     * 于是每一次回退都会把原著指导永久隐藏掉，面板上整段消失。
     *
     * 之前我在这里打过补丁（"有产出就不隐藏"），但那是「先隐藏再想办法
     * 找回来」的思路 —— 玩家明确指出这是错的。
     *
     * 正确的做法：**没有楼层号的记录根本不参与楼层回退判定，永远不隐藏。**
     * 它不属于任何楼层，就不该被任何楼层操作影响。
     *
     * 只有真正绑定了楼层、且该楼层已被撤销的记录才隐藏。
     * 另外，仍在运行的记录要中止（这是回退的副作用，必须保留）。
     */
    if(!run.logId){
      // 未绑定楼层：不隐藏。如果它还在跑，回退时需要中止，避免脏写。
      if(run.status==='running' && run._controller) run._controller.abort();
      continue;
    }
    if(!ids.has(run.logId)){
      run.branchHidden=true;
      if(run.status==='running' && run._controller)run._controller.abort();
      pending.push(run);
    }
  }
  // 分支隐藏必须落库：刷新后要能还原「已撤销回合」，这是回退正确性的一部分。
  // 但落库走的是全局串行写队列，队列里只要有一环不回来，这里一 await 就会把
  // 整个快照回退（含「重新发送」）永久卡在「正在回退到该楼层」。
  // 所以照常等它落库，但加一个上限：超时就先放行回退，写入继续在后台排队完成。
  // 观测记录不该有能力挡住回退主流程。
  var writes=Promise.all(pending.map(function(run){return Promise.resolve(frCanonTracePersist(run)).catch(function(){});}));
  await Promise.race([writes,new Promise(function(resolve){setTimeout(resolve,800);})]);
  frCanonTraceSelected='';frCanonTraceRenderSoon();
}
function frCanonTraceBegin(phase, options) {
  var opts=options||{},archive=typeof currentArchiveName==='string'?currentArchiveName:'';
  var parent=opts.signal&& frCanonTraceSignals.get(opts.signal);
  var postStory=phase==='正文后补演'||phase==='变量演化';
  var activeFloor=postStory&&typeof window!=='undefined'?String(window._ceCurrentLogId||'').trim():'';
  if(frCanonTraceArchive!==archive){frCanonTraceArchive=archive;frCanonTraceHistory=[];}
  var run={id:'canon-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),archiveName:archive,logId:opts.logId||activeFloor||parent?.logId||'',phase:phase,
    buildId:typeof FR_BUILD_ID==='string'?FR_BUILD_ID:'',worldTime:typeof ceBridgeReadWorldTime==='function'?ceBridgeReadWorldTime():'',
    startedAt:Date.now(),endedAt:null,status:'running',currentStage:'准备资料',events:[],requests:[],result:null};
  run.turnId=opts.turnId||(run.logId?'floor:'+run.logId:parent?.archiveName===archive?parent.turnId:run.id);
  var config=typeof ceBridgeLastConfig==='object'&& ceBridgeLastConfig||{};
  Object.defineProperty(run,'_secrets',{value:[config.api&& config.api.apiKey].filter(Boolean),enumerable:false});
  var controller=opts.controller||new AbortController();
  Object.defineProperty(run,'_controller',{value:controller,enumerable:false});
  /* ★★★ 2026-11-02 玩家：「停止原著补演依然失效，无法停止。」
   *
   * 【根因】frCanonStopAll 靠三样东西找在飞的 controller：
   *   ① window.__frStopControllers 登记表
   *   ② 全局 frReplaySession / frReplayDirectTask
   *   ③ frCanonTraceHistory 里 status==='running' 的 run
   *
   * 但登记表(__frStopControllers)只有一处写入：智能重跑入口。
   * **普通补演主流程从头到尾没登记过任何 controller。**
   * 而 ③ 依赖运行记录 —— 记录改纯内存后，刚打开面板/刚切存档时常常是空的。
   * 结果：普通补演跑起来后，点停止什么都停不住。
   *
   * 【修法】在这里统一登记：frCanonTraceBegin 是每一次补演/演化开始的必经入口，
   * 每个 run 的 controller 都登记进去，pagehide / 正常结束 / 异常结束时自动摘除。
   * 这样不管从哪条路径启动，frCanonStopAll 都能无差别停住。
   */
  (function(){
    try{
      if(typeof frCanonTrackStop==='function'){
        var releaseRun=frCanonTrackStop(controller,phase==='变量演化'?'ce':'canon');
        run.__releaseStop=releaseRun;
        var detachStop=function(){
          try{releaseRun();}catch(_){}
        };
        controller.signal.addEventListener('abort',detachStop,{once:true});
        if(typeof window!=='undefined')window.addEventListener('pagehide',detachStop,{once:true});
      }
    }catch(_){}
  })();
  Object.defineProperty(run,'_capture',{value:config.showDiagnostics!==false&& config.traceCaptureBodies!==false,enumerable:false});
  Object.defineProperty(run,'_record',{value:phase==='原著指导'||config.showDiagnostics!==false,enumerable:false});
  // 重跑挂载按系统、存档和signal归属判断；同档普通生成不能继承重跑选择。
  (function(){
    var system=phase==='变量演化'?'ce':'canon';
    var session=typeof frReplaySessionsBySystem==='object'&&frReplaySessionsBySystem
      ? frReplaySessionsBySystem[system] : null;
    if(!session&&typeof frReplaySession==='object'&&frReplaySession){
      var legacySystem=frReplaySession.system||frReplaySession.context?.system||'canon';
      if(legacySystem===system)session=frReplaySession;
    }
    if(!session||session.archiveName!==archive||!session.selection)return;
    if((session.system||session.context?.system||'canon')!==system)return;
    var sessionSignal=session.controller?.signal;
    var direct=!!sessionSignal&&(opts.signal===sessionSignal||controller.signal===sessionSignal);
    var inherited=!!opts.signal&&parent?.archiveName===archive&&parent._replay===session
      &&(parent.phase==='变量演化'?'ce':'canon')===system;
    if(direct||inherited){
      Object.defineProperty(run,'_replay',{value:session,enumerable:false,configurable:true});
      run.replayOf=session.context?.sourceRunId||'局部重跑';
    }
  })();
  if(opts.signal)frCanonTraceSignals.set(opts.signal,run);
  if(opts.signal&& opts.signal!==controller.signal){
    var abort=function(){controller.abort(opts.signal.reason);};
    if(opts.signal.aborted)controller.abort(opts.signal.reason);else opts.signal.addEventListener('abort',abort,{once:true});
    Object.defineProperty(run,'_detach',{value:function(){opts.signal.removeEventListener('abort',abort);},enumerable:false});
  }
  frCanonTraceSignals.set(controller.signal,run);
  // 普通演化有自己的气泡；并行启动它不能夺走仍在运行的原著补演显示权。
  if(phase!=='变量演化'||!frCanonTraceActive||frCanonTraceActive.status!=='running'||frCanonTraceActive._controller?.signal.aborted)frCanonTraceActive=run;
  frCanonTraceSelected=run.id;
  if(run._record||phase==='变量演化'||phase==='正文后补演')frCanonTraceHistory.push(run);
  var keep=Math.max(1,Math.min(30,Number(config.traceKeep)||10));
  var keyOf=function(r){return r.logId?'floor:'+r.logId:r.turnId||r.id;};
  var turnIds=Array.from(new Set(frCanonTraceHistory.map(keyOf))).slice(-keep);
  frCanonTraceHistory=frCanonTraceHistory.filter(function(r){return turnIds.includes(keyOf(r));});
  if(run.logId){
    /* ★★ 2026-11-01 玩家：「之前是只显示原著补演，现在是只显示原著指导了，你怎么拆东墙补西墙了」
     *
     * 楼层号现在才拿到。把本轮「正文生成前」就已经跑过、当时还拿不到楼层号的记录
     * （原著指导、资料自检等）一并归到这个楼层。
     *
     * 边界：只接管「上一条有楼层记录之后」产生的无楼层记录，不会误吞历史轮次的孤儿。
     * 归并后它们与正文后补演同属一个 turn，面板就能一起显示，不再二选一。
     */
    var lastFloored=0;
    frCanonTraceHistory.forEach(function(r){if(r!==run&&r.logId&&r.startedAt>lastFloored)lastFloored=r.startedAt;});
    frCanonTraceHistory.forEach(function(r){
      if(r===run||r.logId||r.archiveName!==archive)return;
      if(r.startedAt<lastFloored)return;
      r.turnId=run.turnId;r.logId=run.logId;frCanonTracePersist(r);
    });
    frCanonTraceHistory.filter(function(r){return r.turnId===run.turnId;}).forEach(function(r){r.logId=run.logId;frCanonTracePersist(r);});
    /* 2026-11-02 玩家：「只要原著补演流程开始立马清理」
     *
     * 场景：重roll 正文 → 新补演刚开始跑（还在准备资料）→ 面板上仍挂着
     * 上一轮那份完整的补演记录。玩家扫一眼会以为这轮已经跑过了。
     *
     * 所以新补演一启动，就把**同一回合里上一次的补演记录**标成已作废
     * （branchHidden）。渲染层会把它们收进折叠块，只剩一行
     * 「已被重roll覆盖」，玩家想翻历史再点开。
     *
     * 边界（不能伤及无辜）：
     *   · 只动**同一回合**的记录，别的楼层一概不碰
     *   · 只动**补演类**记录（正文后补演／变量演化／资料补取等）。
     *     原著指导不在此列——玩家明确要求「没有修改行动指令选择情况
     *     原著指导内容的话原著指导是保留旧的」，指导跑在正文之前，
     *     重roll 后本来就该沿用，绝不能一起作废。
     *   · 不删数据，只打标记，历史随时可翻回来
     *   · 局部重跑（run.replayOf 指向的那条源记录）也不算旧结果顶替，
     *     它本来就是被复用的来源，保持原样
     */
    // 玩家 2026-11-02 定：旧补演记录**直接清掉**，不做折叠保留。
    // 原来这里是打 branchHidden 标记 + 折叠，玩家明确否掉了。
    var stale=frCanonTraceHistory.filter(function(old){
      if(old===run)return false;
      if(old.archiveName!==archive)return false;
      if(old.turnId!==run.turnId)return false;
      if(old.phase!==run.phase)return false;
      if(old.phase==='原著指导')return false;              // 指导保留旧的，玩家要求
      if(run.replayOf&&old.id===run.replayOf)return false; // 局部重跑的来源记录，留着
      return true;
    });
    // 这里在同步函数里，不能 await：清理由 frCanonTracePurge 内部排队执行，
    // 内存先同步删掉（界面立刻干净），存档写入走既有串行队列，不阻塞开跑。
    if(stale.length)frCanonTracePurge(stale);
  }
  frCanonTraceEvent(run,'stage','准备资料');
  return run;
}
// 气泡只报当前任务；原标签、资料字段和请求统计仍留在完整记录中。
function frCanonBubblePhase(run) {
  var phase=run&& run.phase;
  var name=phase==='原著指导'?'原著指导':phase==='资料自检'?'资料自检':phase==='资料补取'?'资料补取':run?._prebuiltBubble?'预制补演':'原著补演';
  return name+(run?._replay&&phase!=='资料自检'?'重跑':'');
}
function frCanonBubbleText(run,stageOnly) {
  run=run||{};
  var raw=String(run.currentStage||''),retry=/^重试(?:\s*·|$)/.test(raw);
  raw=raw.replace(/^重试\s*·\s*/,'');
  var parts=raw.split(/\s*·\s*/),stage=parts[0],subject=frCanonBubbleSubject(parts.slice(1).join(' · '));
  var names={
    '事件进度观察':'核对事件进展','事件进度':'记录事件进展','补演边界判定':'判断补演范围','正文边界判定':'判断补演范围','正文人物与事实':'核对人物影响','准备资料':'准备资料','判断本轮时间':'判断时间','补演对象':'筛选原著人物','采集资料':'整理资料','焦点':'筛选人物','当前节点':'定位事件','候选':'筛选事件',
    '原著指导':'判断当前事件','当前事件':'判断当前事件','账本':'读取进度','上一轮':'读取进度','跨轮事件':'核对进度',
    '区间':'确定范围','候选事件':'筛选事件','进行中':'核对进度','正文':'核对正文','人物':'筛选人物',
    '新人':'核对新人物','生平':'核对生平','生平旧账':'核对生平','世界背景':'整理世界资料','终态推演':'判断补演边界',
    '人物终态推演':'核对人物','正文硬事实提取':'补演边界','差集与正文覆盖核对':'核对遗漏',
    '落地依据提取':'落地依据提取','变量重复核验':'核对重复结算','生平压缩':'整理人物生平',
    '要点压缩':'整理要点','逐条对勾':'核对遗漏','一步式差集':'核对遗漏','正文事实':'核对正文',
    '人物边界批量判定':'核对人物','资料检索':'检索资料','差集':'核对遗漏','天花板':'核对后续约束','已覆盖':'核对已写内容','资料':'整理资料','人物档案':'整理人物资料',
    '无人认领':'检查遗漏','材料审计':'检查资料','分派':'安排补演','结算':'整理结果','生平经历':'整理生平',
    '世界块':'世界补演','黄区钩子':'整理后续线索',
    '登场 / 退场判断':'更新登场','物品管理':'更新物品','角色 / 灵兽变量演化':'更新人物',
    '世界 / 地图 / 任务与总结':'更新世界','NPC标签校准':'校准标签','生平压缩':'整理生平',
    '世界与杂项转换':'更新世界','人物变量转换':'更新人物','物品变量转换':'更新物品',
    '人物档案补全':'补全人物档案',
    '应用变量与原子保存':'保存结果','数据库事务已提交':'保存完成'
  };
  var task=names[stage]||frCanonBubbleTaskLabel(stage,'');
  if(/^人物正文\s*·\s*失败子集合批重写$/u.test(raw))task=frCanonBubbleTaskLabel('人物正文·失败子集合批重写','');
  else if(subject&&task.includes('NPC 视角正文'))task+=' · '+Array.from(subject).slice(0,14).join('')+(Array.from(subject).length>14?'…':'');
  if(stage==='采集资料'&& subject==='vectorContext')task='检索资料';
  // 原执行器的三种转换给中文名。基准线原来把其余一律当「更新世界」，
  // 结果「人物档案补全」被说成更新世界——说的是假话。认不出就保留真名。
  if(stage==='原执行器'&&subject){
    var execNames={'人物变量转换':'更新人物','物品变量转换':'更新物品','世界与杂项转换':'更新世界'};
    task=execNames[subject]||subject;
  }
  if(stage==='原执行器'&&/^物品变量转换$/.test(String(subject||'').replace(/\s*·\s*.*$/,''))){
    var tail=String(subject||'').split(/\s*·\s*/).slice(1).join(' · '),batch=/^(整批|复用合批结果|本人物)/.test(tail)?tail:'';
    task='更新物品'+(batch?' · '+batch.replace('整批','整批 ').replace(/^(\d+)人$/,"\u00241 人"):'');
  }
  if(subject&&(stage==='人物终态推演'||stage==='角色 / 灵兽变量演化')){
    var name=Array.from(subject).slice(0,8).join('')+(Array.from(subject).length>8?'…':'');
    task=name+(stage==='人物终态推演'?' · 核对状态':'变量');
  }
  if(retry&&/ 正文$/.test(stage))task='生成 NPC 视角正文 · '+Array.from(stage.replace(/ 正文$/,'')).slice(0,8).join('');
  if(stageOnly)return task?task+(retry?'（重试）':''):'';
  var phase=frCanonBubblePhase(run);
  var progress=frCanonBubbleProgress(run);
  // 气泡沿用变量演化的任务口径；资料与请求统计留在运行记录，不塞入提示。
  var live=progress.workRows.map(function(row){return (frCanonBubbleTaskLabel(row.stage,row.subject)||row.work)+(row.waiting?'（等待额度）':'');});
  var active=live.length?live.slice(0,2).join('；')+(live.length>2?'；另有 '+(live.length-2)+' 项':''):progress.currentTask||task;
  return active?phase+' · '+(live.length>1?'并行 '+live.length+' 项 · ':'')+active+(retry?'（重试）':'')+(!run._prebuiltBubble&&progress.summary.text?' · '+progress.summary.text:''):'';
}
/* ★★ 2026-11-01 玩家：「卡顿更严重了」「跑流程的时候，从发送对话指令开始」
 *                          「尤其是原著指导到原著补演检索资料的阶段」
 *
 * frCanonTraceEvent 在检索阶段被调用几十次，每次原来都**同步**做三件重活：
 *   ① frCanonBubbleProgress(run) —— 多层 filter/some/Set 遍历（请求、任务、资料、人物）
 *   ② frCanonBubbleText(run)     —— 内部含 60+ 条目的映射表字面量，每次调用重建
 *   ③ ceBridgeStatus(...)        —— 遍历气泡 childNodes 找文本节点再改写
 *
 * 气泡显示的是「正在做什么」，玩家看到 100ms 延迟完全无感；
 * 但几十次同步重算累积起来，就把计时器和气泡自己的跑秒挤掉了。
 *
 * 改成 120ms 节流合批：密集事件只算一次、只更新一次气泡。
 * 最后一次状态一定会落地（setTimeout 里读的是 run 的当前值，不是快照）。
 */
var frCanonBubbleUpdateTimer = null;
var frCanonBubbleUpdateRun = null;
function frCanonBubbleUpdateSoon(run){
  if(!run||run!==frCanonTraceActive||run.archiveName!==currentArchiveName){if(run&&typeof ceBridgeCloseStatus==='function')ceBridgeCloseStatus(run);return;}
  frCanonBubbleUpdateRun=run;
  if(frCanonBubbleUpdateTimer)return;
  frCanonBubbleUpdateTimer=setTimeout(function(){
    frCanonBubbleUpdateTimer=null;
    var run=frCanonBubbleUpdateRun;frCanonBubbleUpdateRun=null;
    try{
      if(!run||run!==frCanonTraceActive||run.archiveName!==currentArchiveName||run.status!=='running'||run._controller?.signal.aborted){if(typeof ceBridgeCloseStatus==='function')ceBridgeCloseStatus(run);return;}
      var progress=frCanonBubbleProgress(run);
      if((progress.workRows.length||progress.summary.total)&&typeof ceBridgeActorStatus==='function')ceBridgeActorStatus(progress.workRows,run,progress);
      else if(typeof ceBridgeStatus==='function')ceBridgeStatus(frCanonBubbleText(run),run._controller,run);
    }catch(e){}
  },120);
}

function frCanonTraceEvent(run, type, label, data) {
  if(typeof frCanonReplayCapture==='function')frCanonReplayCapture(run,type,label,data);
  if(!run)return;
  var source=String(label||''),match=source.match(/^(采集资料|资料|资料读取失败)\s*·\s*(.+)$/);
  if(match){
    if(!run._bubbleMaterials)Object.defineProperty(run,'_bubbleMaterials',{value:[],enumerable:false});
    var key=match[2],sources={recentStory:'既往正文',narrativeMemory:'叙事记忆',stateSnapshot:'当前状态',characters:'人物档案',items:'物品资料',beasts:'灵兽资料',worldEvents:'世界大事',tasks:'任务记录',map:'地图资料',worldFactors:'世界背景',worldbookNames:'世界书目录',worldbookEntries:'世界书正文',vectorContext:'检索资料'};
    if(match[1]==='采集资料'){
      // 2026-10-31：同一 key 重复采集时，先把旧的 active 记录关掉。
      // 否则会残留多条 active，气泡永远显示这一项（玩家报「一直显示在检索资料，
      // 我还以为卡在这个阶段了」）。重复采集说明上一次已经不再有效。
      run._bubbleMaterials.forEach(function(row){
        if(row.key===key&&row.active){row.active=false;row.status='superseded';}
      });
      run._bubbleMaterials.push({key:key,label:sources[key]||'读取资料',active:true,status:'reading'});
    }else{
      // 结束事件：把该 key 下**所有**还 active 的记录都关掉，而不是只关第一条。
      // 原来用 find() 只关一条，采集两次就会留一条永远 active 的幽灵记录。
      var closed=false;
      run._bubbleMaterials.forEach(function(row){
        if(row.key!==key||!row.active)return;
        row.active=false;row.status=match[1]==='资料'?'read':'error';closed=true;
      });
      // 结束事件找不到对应 active 记录时，也不能让别的 key 的 active 残留挡路：
      // 说明这次采集没有成对出现，兜底清掉所有超过 1 分钟的陈旧 active 记录。
      if(!closed)run._bubbleMaterials.forEach(function(row){
        if(row.active&&Date.now()-(row.at||0)>60000){row.active=false;row.status='stale';}
      });
    }
    if(!run._bubbleMaterials.length)return;
    run._bubbleMaterials.forEach(function(row){if(row.at===undefined)row.at=Date.now();});
  }
  if(source==='原检索进度'&&data){var search=(run._bubbleMaterials||[]).find(function(row){return row.key==='vectorContext'&&row.active;});if(search){var searchLabels={analysis:'分析检索条件',embedding:'向量化资料',matching:'匹配资料',rerank:'重排资料'};search.label='检索资料 · '+(data.label||searchLabels[data.stage]||'整理资料');search.stage=data.stage;search.requestState=data.requestState;}}
  if(type==='progress'&&data&&data.actorProgress){if(!run._bubbleActors)Object.defineProperty(run,'_bubbleActors',{value:{},enumerable:false});run._bubbleActors.total=data.actorProgress.total;run._bubbleActors.saved=data.actorProgress.saved;}
  frCanonCurrentDisplayCapture(run,type,data);
  var visibleData=data===undefined?null:data;
  if(source==='补演解析与账本计划')visibleData={status:data?.status,reason:data?.reason,proseCount:data?.prose?.length||0,executionResult:true};
  if(run._capture===false&& visibleData!==null)visibleData={recording:'完整内容记录已关闭',reason:visibleData.reason||visibleData.error||undefined};
  var event={id:run.id+'-event-'+run.events.length,time:Date.now(),type:type,label:String(label||''),data:frCanonTraceClean(visibleData,run)};
  run.events.push(event);
  if(type==='stage'||type==='retry')run.currentStage=event.label;
  if(type==='stage'&&/^(?:预制补演路线|预制变异边界|预制人物修订|预制人物变量|预制世界大事修订|预制人物正文续接)(?:$| · )/.test(source))run._prebuiltBubble=true;
  // 资料读完/读失败时，currentStage 还停在「采集资料 · xxx」那一格，
  // 而这条事件是 type:'material'，原来不更新 currentStage，
  // 于是气泡会一直停在「检索资料」不往下走（玩家 2026-10-30 报：
  // 实际在生成人物变量，气泡还写着检索资料）。
  // 这里把它推进到「资料已读」，让气泡跟着下一个真实阶段走。
  if(type==='material'&&/^资料\s*·\s*/.test(String(event.label||'')))run.currentStage='资料';
  // 2026-10-31：新的**真实阶段**开始时，把上一批资料读取标记全部作废。
  // 这是「气泡卡在检索资料」最根本的一条：
  // 资料采集发生在补演早期，之后进入人物变量等阶段，那些 active 记录本该无关了，
  // 但只要有一条没被正确关闭，frCanonBubbleProgress 的 currentMaterial 就会
  // 一直压住 ordinary 里的真实任务，气泡永远显示「检索资料」。
  // 玩家原话：「按理应该在做什么就显示做什么，而不是一律显示检索资料导致误解」。
  if(type==='stage'&&!/^采集资料\s*·\s*/.test(source)){
    (run._bubbleMaterials||[]).forEach(function(row){
      if(row.active){row.active=false;row.status='stale';}
    });
  }
  var cfg=typeof ceBridgeLastConfig==='object'&& ceBridgeLastConfig||{};
  if(run.phase!=='变量演化'&& run.status==='running'&&!run._controller?.signal.aborted&& run.archiveName===currentArchiveName&& cfg.showStatus!==false&& typeof ceBridgeStatus==='function') {
    frCanonBubbleUpdateSoon(run);
  }
  frCanonTraceRenderSoon();
  frCanonRefreshSidebarSoon();
  if(!run._persistTimer)Object.defineProperty(run,'_persistTimer',{value:null,writable:true,enumerable:false});
  clearTimeout(run._persistTimer);
  run._persistTimer=setTimeout(function(){frCanonTracePersist(run);},180);
  return event;
}

/* ★★ 2026-11-01 玩家：「卡顿更严重了」「跑流程的时候，从发送对话指令开始」
 *                          「尤其是原著指导到原著补演检索资料的阶段」
 *
 * frCanonTraceEvent 在检索阶段会被调用几十次（13 个资料源 × 采集开始/结束，
 * 外加每个模型请求的 stage/prepared/returned）。
 * 原来这里每次都**同步**调 frCanonRefreshSidebar()：
 *   · document.getElementById('fr-canon-sidebar-status')
 *   · document.querySelector('[data-fr-canon-action="stop"]')
 *   · document.querySelector('[data-fr-canon-action="check"]')
 * 三次全文档查询 + 写 textContent + 改 disabled，没有任何节流。
 *
 * 和 frCanonTraceRenderSoon 一样加 100ms 节流：同一批密集事件只刷一次侧栏。
 * 侧栏显示的是「当前阶段」文字，100ms 延迟玩家完全无感。
 */
var frCanonRefreshSidebarTimer = null;
function frCanonRefreshSidebarSoon(){
  if(frCanonRefreshSidebarTimer)return;
  frCanonRefreshSidebarTimer=setTimeout(function(){
    frCanonRefreshSidebarTimer=null;
    if(typeof frCanonRefreshSidebar==='function')frCanonRefreshSidebar();
  },100);
}
function frCanonTraceRequest(signal, payload) {
  var run=signal&& frCanonTraceSignals.get(signal);
  if(!run||run.status!=='running')return null;
  var src=payload||{};
  var meta=frCanonTraceSignalMeta.get(signal)||{};
  var stageNames={entry:'登场 / 退场判断',items:'物品管理',characters:'角色 / 灵兽变量演化',misc:'世界 / 地图 / 任务与总结',tags:'NPC标签校准',biography:'生平压缩'};
  var stage=(stageNames[meta.stageKey]||meta.stageKey||run.currentStage)+(meta.subject?' · '+meta.subject:'');
  frCanonTraceEvent(run,'stage',stage);
  if(src.secret&&!run._secrets.includes(src.secret))run._secrets.push(src.secret);
  var req={id:run.id+'-request-'+run.requests.length,stage:stage,model:src.model||'',startedAt:Date.now(),endedAt:null,status:'running',
    stageKey:meta.stageKey||run.currentStage,subject:meta.subject||'',targetId:meta.targetId||'',targetIds:Array.isArray(meta.targetIds)?meta.targetIds.slice():[],
    messages:run._capture?frCanonTraceClean(src.messages||[],run):'完整材料记录已关闭'};
  if (Array.isArray(meta.mergedPhases) && ['merged','canon-merged'].includes(req.stageKey)) req.mergedPhases=meta.mergedPhases.slice();
  if(typeof frReplayStageKey==='function')req.stageKey=frReplayStageKey(req.stageKey);
  if(meta.progressTaskId)Object.defineProperty(req,'_progressTaskId',{value:meta.progressTaskId,enumerable:false});
  if(run._capture)req.cacheKey=JSON.stringify(frCanonTraceClean([req.stageKey,req.targetId||req.subject,src.endpoint||'',req.model,src.options||{},src.messages||[]],run));
  else{req.cacheKey='replay-semantic:'+req.id;req.semanticOnly=true;}
  Object.defineProperty(req,'_run',{value:run,enumerable:false});
  run.requests.push(req);frCanonTraceEvent(run,'prepared','准备模型调用 #'+run.requests.length,{model:req.model,stage:req.stage});return req;
}
function frCanonTraceResponse(req, data) {
  if(!req)return;
  req.endedAt=Date.now();req.status='returned';req.durationMs=req.endedAt-req.startedAt;
  var executionResponse=typeof frCanonReplayResponse==='function'?frCanonReplayResponse(data):null;
  var executionChars=executionResponse?JSON.stringify(executionResponse).length:0;
  if(Number(req._run._executionResponseChars||0)+executionChars>16*1024*1024)executionResponse=null;
  else req._run._executionResponseChars=Number(req._run._executionResponseChars||0)+executionChars;
  req.replayResponse=executionResponse;
  if(!executionResponse)req.replayUnavailable='模型返回缺少正文或超过2Mi字符，未截断保存；本阶段需重新获取';
  req.response=req._run._capture?frCanonTraceClean(data,req._run):executionResponse;
  frCanonTraceEvent(req._run,'response','模型返回 #'+(req._run.requests.indexOf(req)+1),{durationMs:req.durationMs,finishReason:data&& data.choices&& data.choices[0]&& data.choices[0].finish_reason});
}
function frCanonTraceRequestError(req, error) {
  if(!req)return;
  req.endedAt=Date.now();req.status=error&& error.name==='AbortError'&&!/^FR_REPLAY_(?:FAILURE|PREREQUISITE)$/.test(error.code||'')?'cancelled':'error';req.error=frCanonTraceClean(String(error&& error.message||error),req._run);
  frCanonTraceEvent(req._run,req.status,'模型请求'+(req.status==='cancelled'?'取消':'失败'),{error:req.error,stage:req.stage});
}
function frCanonTracePersist(run) {
  /* 运行记录只活在内存里，不落库。
   *
   * 1.0.6 的实现每写一条记录就要：
   *     var old = await dbGet('FR_CANON_TRACE_V1:'+存档);   // 读出整张表
   *     rows.push(snapshot);
   *     await dbSet(key, rows.filter(...));                  // 整张表写回
   * 玩家机器上这张表实测已 628MB，于是每次落记录主线程阻塞 45 秒以上，
   * 补演就卡在「检索资料」阶段不动 —— 卡顿不是模型慢，是这一读一写。
   *
   * 而且它只按「回合数」(traceKeep) 限流，一个回合里塞的正文、prompt、
   * 状态快照副本再多也照存不误，所以体积只增不减。
   *
   * 现在的口径和原卡一致：思维/运行过程是纯内存变量，当前层那份挂在
   * frCanonTraceHistory 上，面板打开时现取，随刷新消失。
   * 从根本上不存在「上一轮的记录还留着」和「表越滚越大」。
   */
  if(!run)return Promise.resolve();
  // 局部尝试的产物只在执行器确认提交后合并；失败和迟到计时器不能覆盖原成果。
  if(run._replay)return Promise.resolve();
  run.persisted=false;
  frCanonTraceRenderSoon();
  // Guidance is display-only. It must never replace the canon executor's same-floor receipt.
  if(!['变量演化','正文后补演'].includes(run.phase)||run.branchHidden||!frCanonTraceHistory.includes(run))return Promise.resolve();
  if(run.phase==='正文后补演'&&run.status==='running'&&run.logId&&run._displayViews?.size&&
     Date.now()-Number(run._displayCheckpointAt||0)>=4000&&typeof frCanonCurrentDisplaySave==='function'){
    run._displayCheckpointAt=Date.now();
    frCanonCurrentDisplaySave(run,false,true);
  }
  /* ★★★ 2026-11-03 玩家：「两个局部重跑为什么要跑完才显示，为什么不跑一点显示一点？
   *   不是内容是一点一点存下来的吗？」
   *
   * 对，内容本来就是一点一点产生的（每准备一次模型调用就 run.requests.push 一条），
   * 但我们原来把**落库**整个推迟到回合收尾（frReplaySealPending），
   * 于是面板在整轮跑完之前永远是 0/0，玩家看不到任何进度。
   *
   * 现在：每次运行状态变化（发起请求 / 收到返回 / 失败）都顺手把
   * **本轮的阶段产物**增量写进 FR_CANON_TURN_ARTIFACTS_V1，做到边跑边可见。
   *
   * 三个约束，避免把 628MB 的老坑重演：
   *   ① 只写当前层（键里带 logId），不跨层累积；
   *   ② 写的是「压缩后的产物形态」（frCanonArtifactOfRequest），
   *      不含 events、不含完整 messages 之外的展示数据；
   *   ③ 同一层用覆盖写，条目数 = 阶段数级别，不会因为反复写而膨胀。
   * 仍然不写 FR_CANON_TRACE_V1 那张历史大表（那才是 628MB 的来源）。 */
  try{
    var prName=String(run.archiveName||(typeof currentArchiveName==='string'?currentArchiveName:''));
    var prLogId=String(run.logId||'').trim();
    if(prName&&prLogId&&Array.isArray(run.requests)&&(run.requests.length||run.executionResult||run.executionViews?.length)&&
       typeof frCanonTurnArtifactsSave==='function'){
      var prSystem=(run.phase==='变量演化')?'ce':'canon';
      /* 节流：同一层 120ms 内不重复整表覆盖写，避免高频事件把主线程拖住。
       * 最后一次一定会写（由 round 结束事件和收尾的 seal 补齐）。 */
      var prKey=prName+':'+prLogId+':'+prSystem;
      var prLast=frCanonLivePersistAt[prKey]||0;
      var prNow=Date.now();
      if(prNow-prLast>=120){
        frCanonLivePersistAt[prKey]=prNow;
        frCanonTurnArtifactsSave(prName,prLogId,run.requests,prSystem,run)
          .catch(function(e){try{console.warn('[阶段产物] 边跑边存失败（不影响运行）：',e);}catch(_){}});
      }else{
        /* 末尾一条一定要落，保证最后状态不丢。 */
        clearTimeout(frCanonLivePersistTimer[prKey]);
        frCanonLivePersistTimer[prKey]=setTimeout(function(){
          if(run.branchHidden||!frCanonTraceHistory.includes(run))return;
          frCanonLivePersistAt[prKey]=Date.now();
          try{
            frCanonTurnArtifactsSave(prName,prLogId,run.requests,prSystem,run)
              .catch(function(){});
          }catch(_){}
        },140);
      }
      run.persisted=true;
    }
  }catch(_){}
  return Promise.resolve();
}
async function frCanonTraceFinish(run,status,result) {
  if(!run)return;
  if(typeof frCanonReplayResult==='function'&&['变量演化','正文后补演'].includes(run.phase)){
    var execution=frCanonReplayResult(Object.assign({},run.executionResult||{},result||{}));
    if(execution)run.executionResult=execution;else{run.executionResult=null;run.replayUnavailable='本轮执行回执超过16Mi字符或无法序列化，未截断保存；缺失阶段需要重新获取';}
    if(execution)run.executionViews=(run.executionViews||[]).filter(function(row){
      if(row.data?.kind==='continuationInput'&&execution.continuationInput)return false;
      return !(row.data?.kind==='prose'&&row.data.accepted===true&&(execution.prose||[]).some(function(block){return block.name===row.data.block?.name&&block.body===row.data.block?.body;}));
    });
  }
  run.status=status;run.endedAt=Date.now();run.result=frCanonTraceClean(run._capture?result:{status:result&& result.status,landed:result&& result.landed,reason:result&& result.reason,recording:'完整内容记录已关闭'},run);
  // 指导属于玩家实际使用的结果；关闭调试记录只省去材料和请求，不隐藏指导正文。
  if(run.phase==='原著指导'&&!run._capture&&result?.text)run.result=frCanonGuidanceDisplayResult(result.text,result);
  run.requests.filter(function(req){return req.status==='running';}).forEach(function(req){req.status=status==='cancelled'?'cancelled':'interrupted';req.endedAt=run.endedAt;});
  if(run._detach)run._detach();
  frCanonTraceEvent(run,status,status==='saved'?'事务已提交并保存':status==='cancelled'?'已取消，未报保存成功':status==='error'?'失败，请查看所在阶段':'本阶段结束',result);
  if(run.phase!=='变量演化'&&typeof ceBridgeCloseStatus==='function')ceBridgeCloseStatus(run);
  await frCanonTracePersist(run);
  if(typeof frCanonCurrentDisplaySave==='function')await frCanonCurrentDisplaySave(run);
  frCanonTraceRenderSoon();
}
function frCanonTraceRenderSoon() {
  clearTimeout(frCanonTraceRenderTimer);frCanonTraceRenderTimer=setTimeout(function(){
    var popup=document.getElementById('thinking-log-popup'),tab=document.getElementById('thinking-log-canon-content');
    if(popup?.classList.contains('hidden')||tab&&!tab.classList.contains('active'))return;
    frCanonTraceRender();
  },70);
}
function frCanonTraceText(value) { return typeof value==='string'?value:JSON.stringify(value,null,2); }


// 指导缓存与展示共用一份轻量结果；不保存请求、材料、状态快照或旧补演。
function frCanonGuidanceDisplayResult(block,source){
  var text=String(block||'').trim(),result={ok:true,injectable:true,text:text};
  if(!source||String(source.text||'').trim()!==text)return result;
  function strings(object,keys){var out={};keys.forEach(function(key){if(typeof object?.[key]==='string')out[key]=object[key];});return out;}
  if(source.guidance&&typeof source.guidance==='object'){
    result.guidance={};
    ['facts','pending','notYet','invisible','doNotForce'].forEach(function(key){result.guidance[key]=(Array.isArray(source.guidance[key])?source.guidance[key]:[]).filter(function(value){return typeof value==='string';});});
    if(source.guidance.deviation)result.guidance.deviation=strings(source.guidance.deviation,['level','conclusion']);
  }
  if(source.node)result.node=strings(source.node,['code','title']);
  if(source.guidanceTime)result.guidanceTime=strings(source.guidanceTime,['time','source','precision','reason']);
  return result;
}
function frCanonGuidanceSnapshot(block,signal){
  var text=String(block||'').trim();if(!text)return null;
  var source=signal&&frCanonTraceSignals.get(signal);
  if(!source||source.archiveName!==currentArchiveName||source.phase!=='原著指导'||String(source.result?.text||source.guidanceDisplay?.text||'').trim()!==text){
    source=frCanonTraceHistory.filter(function(run){return run.archiveName===currentArchiveName&&run.phase==='原著指导'&&String(run.guidanceDisplay?.text||run.result?.text||'').trim()===text;}).at(-1);
  }
  return {archiveName:currentArchiveName,block:String(block),display:frCanonGuidanceDisplayResult(text,source?.guidanceDisplay||source?.result)};
}
async function frCanonRestoreGuidanceDisplay(saved,options){
  var opts=options||{},archive=currentArchiveName,text=String(saved?.block||'').trim();
  if(!archive||!text||saved.archiveName&&saved.archiveName!==archive||opts.signal?.aborted)return null;
  await frCanonTraceLoad();
  if(currentArchiveName!==archive||opts.signal?.aborted)return null;
  var source=opts.signal&&frCanonTraceSignals.get(opts.signal);
  if(source&&frCanonTraceHistory.includes(source)&&source.archiveName===archive&&source.phase==='原著指导'&&source.result?.text===text)return source;
  var result=frCanonGuidanceDisplayResult(text,saved.display);
  var run=frCanonTraceBegin('原著指导',{signal:opts.signal});
  run.reusedGuidance=true;
  await frCanonTraceFinish(run,'done',result);
  // 展示内容不依赖“完整诊断记录”开关；这里仅有上面的白名单字段。
  run.result=result;
  frCanonTraceRenderSoon();
  return run;
}
function frCanonCompletionMissing(completion){return Array.isArray(completion?.hardMissing)?completion.hardMissing.filter(Boolean):[];}
function frCanonCompletionModules(completion){
  var modules=new Set();frCanonCompletionMissing(completion).forEach(function(row){var module=typeof row==='object'&&(row.module||row.stage||row.stageKey);if(['characters','items'].includes(module))modules.add(module);});
  return modules.size?Array.from(modules):['characters','items'];
}
function frCanonCompletionText(value){if(value===null||value===undefined)return '';if(typeof value==='object')return value.reason||value.text||value.fact||value.detail||value.field||JSON.stringify(value);return String(value);}
function frCanonTraceStatusLabel(status){return {running:'运行中',saved:'已保存',done:'本阶段完成',skipped:'已跳过',error:'失败',cancelled:'已取消',interrupted:'已中断',returned:'已返回'}[status]||status;}
async function frCanonTraceBindLog(signal,logId){
  if(!logId||!signal||signal.aborted)return;
  var archive=currentArchiveName,source=frCanonTraceSignals.get(signal);
  // Only the request that actually supplied this story can claim its display identity.
  // Reused guidance is explicitly restored onto this signal before generation begins.
  if(!source||source.archiveName!==currentArchiveName||!frCanonTraceHistory.includes(source)||source.branchHidden)return;
  if(!signal.aborted&&typeof frCanonCurrentDisplayPending!=='undefined'&&
     (typeof frCanonCurrentDisplays==='undefined'||frCanonCurrentDisplays.get(currentArchiveName)?.floor!==String(logId))){
    source.logId=logId;
    frCanonCurrentDisplayPending={archiveName:currentArchiveName,logId:String(logId),runId:source.id,signal:signal};
  }
  var current=function(run){return currentArchiveName===archive&&!signal.aborted&&frCanonTraceHistory.includes(source)&&frCanonTraceHistory.includes(run)&&run.archiveName===archive;};
  for(var run of frCanonTraceHistory.filter(function(r){return r.archiveName===archive&&(r.turnId===source.turnId||r===source);})){ 
    if(!current(run))return;
    run.logId=logId;run.turnId='floor:'+logId;
    if(typeof frCanonMaterialSeal==='function')await frCanonMaterialSeal(run);
    if(!current(run))return;
    await frCanonTracePersist(run);
    if(!current(run))return;
    if(typeof frCanonCurrentDisplaySave==='function')await frCanonCurrentDisplaySave(run);
  }
}
function frCanonTracePublish(run,label,data){
  if(!run)return;
  var old=run.events.find(function(e){return e.type==='view'&& e.label===label;});
  if(old){
    frCanonCurrentDisplayCapture(run,'view',data);
    // 展示去重不能绕过恢复记录：否则已核验正文/失败回执仍停在首次预览状态。
    if(typeof frCanonReplayCapture==='function')frCanonReplayCapture(run,'view',label,data);
    old.data=frCanonTraceClean(run._capture?data:{recording:'完整内容记录已关闭'},run);old.time=Date.now();
    frCanonTraceRenderSoon();frCanonBubbleUpdateSoon(run);frCanonRefreshSidebarSoon();
    if(typeof frCanonTracePersist==='function')frCanonTracePersist(run);
  }
  else frCanonTraceEvent(run,'view',label,data);
}
function frCanonTraceTurns(){
  var groups=new Map();
  /* ★★ 2026-11-01 玩家：「我这轮是原著指导出了之后重roll正文的」
   *           「然后都跑到这了，原著补演下面的内容都不展示了」
   *
   * 原来这里用 `!r.branchHidden` 把作废楼层的记录**直接过滤掉**。
   * 重roll正文会让旧楼层作废，绑在该楼层的补演记录全被标 branchHidden，
   * 于是一整个回合的记录从面板上凭空消失 —— 玩家看到「跑完了内容没了」，
   * 既不知道是被重roll覆盖了，也翻不回原内容。
   *
   * 玩家早就批评过这种思路：「不要隐藏，而不是先隐藏再想办法找回来」。
   * 所以现在**不再过滤**：作废的记录照样留在它原本的回合里，
   * 由渲染层用「本轮已被重roll覆盖」的标注把它们显式标出来。
   * 玩家要能在历史回合里翻到，也要能一眼看出它不是当前有效结果。
   *
   * 保留 !branchHidden 的语义只用于「是否还属于当前有效分支」的判断，
   * 不再用它决定「这条记录要不要存在」。
   */
  frCanonTraceHistory.filter(function(r){return r.archiveName===currentArchiveName;}).forEach(function(run){
    var key=run.logId?'floor:'+run.logId:run.turnId||run.id;
    if(!groups.has(key))groups.set(key,{id:key,startedAt:run.startedAt,runs:[]});
    var group=groups.get(key);group.runs.push(run);group.startedAt=Math.min(group.startedAt,run.startedAt);
  });
  var allTurns=Array.from(groups.values()).map(function(turn){var latest=new Map();turn.runs.forEach(function(run){if(run.result?.rolledBack===true && latest.has(run.phase))return;latest.set(run.phase,run);});turn.runs=Array.from(latest.values()).sort(function(a,b){return a.startedAt-b.startedAt;});return turn;}).filter(function(t){return t.runs.some(function(r){return r.phase!=='变量演化';});}).sort(function(a,b){return a.startedAt-b.startedAt;});
  /* ★★★ 2026-11-02 玩家定了新的展示规则（原话）：
   *
   *   「关于原著补演这里的展示记录，一层只保留一个记录，玩家重roll这一层
   *     就覆盖这一层之前的记录，不然就乱了，不知道哪个才是实际的记录了。
   *     这样，干脆和其他展示区一样，每层刷新，只保留这一层的记录，
   *     不要分上一回合下一回合了，永远只展示当前回合最新的记录流程。」
   *
   * 以前这里返回**所有楼层**，渲染层再用「上一回合/下一回合」让玩家翻。
   * 结果重roll之后同一层的记录会有好几份，玩家分不清哪份才是实际生效的。
   *
   * 现在跟其他展示区一样：**只认当前楼层**。
   * 当前楼层取 window._ceCurrentLogId（宿主统一维护的那个），
   * 这样「当前楼层」只有一个定义，不会和世界日报、世界演化等区块打架。
   *
   * 为什么不会重演 1.0.5 那个「重roll 后内容全不显示」：
   *   · 那时是**按 branchHidden 过滤记录**，楼层作废 → 记录被删掉 → 空白
   *   · 现在是**按楼层取记录**，重roll 后新楼层重新跑补演 → 新记录进来 → 有内容
   *   · 万一新楼层还没跑，就显示「暂无运行记录」——这是事实（流程确实没跑），
   *     而不是把已经跑过的内容藏起来
   */
  var currentLogId='';
  try{currentLogId=typeof frCanonCurrentDisplayResolveFloor==='function'?frCanonCurrentDisplayResolveFloor(currentArchiveName):String((typeof frCanonCurrentDisplays!=='undefined'?frCanonCurrentDisplays.get(currentArchiveName)?.floor:undefined)??((typeof window!=='undefined'&&window._ceCurrentLogId)||'')).trim();}catch(e){currentLogId='';}
  var currentTurns=currentLogId?allTurns.filter(function(t){return t.id==='floor:'+currentLogId;}):[];
  /* 2026-11-02 玩家报：「我重roll的时候原著补演展示界面没有刷新清理旧的原著补演内容」
   *            「补演还没跑的时候没刷新，补演跑完了刷新成新内容了」
   *
   * 问题在这里。原来是这么写的：
   *     if(!currentTurns.length)currentTurns=allTurns.length?[allTurns[allTurns.length-1]]:[];
   * 本意是「当前楼层还没记录时别让面板空白」，但拿的是**最新一条记录**，
   * 而最新一条恰好是刚被重roll作废的上一楼层那份。于是重roll完、补演还没
   * 跑的那段时间里，面板显示的是**旧楼层的结果**，玩家会以为这次已经跑过了
   * ——「渲染滞后」的观感就是这么来的。
   *
   * 但**不能一删了之**：玩家 2026-11-02 特别交代过
   *   「原著指导和原著补演是分开的，虽然显示在一回合，但是如果没有修改
   *     行动指令选择情况原著指导内容的话原著指导是保留旧的，这个没问题，
   *     只有原著补演是需要刷新重新渲染」
   * 所以这里的兜底要分两类对待：
   *
   *   · 原著指导 —— 正文之前就跑了，重roll 时如果行动指令没改，内容本来就该
   *     沿用旧的。它必须还能显示出来，否则面板会空白。
   *   · 原著补演（正文后补演／变量演化等）—— 前提一变就必须重新算，
   *     旧结果绝不能顶替。当前楼层还没跑，就老老实实显示「暂无运行记录」。
   *
   * 做法：当前楼层没有记录时，兜底只取**不含补演类记录**的那一条回合。
   * 全是补演、没有可沿用的指导 → 返回空数组，由渲染层打空态文案
   * （frCanonTraceRender 里的 `if(!turn)` 分支，这是既有能力，无需新增）。
   */
  // 正文重roll沿用的指导仍挂旧楼层。只带入这条指导，绝不把旧补演一起带回来。
  var guidance=frCanonTraceHistory.filter(function(r){return r.archiveName===currentArchiveName&&r.phase==='原著指导'&&!r.branchHidden&&r.result?.rolledBack!==true&&
    (!r.logId||String(r.logId)===currentLogId||typeof frCanonCurrentDisplays==='undefined');}).sort(function(a,b){return a.startedAt-b.startedAt;}).at(-1);
  if(!currentTurns.length){
    if(guidance)currentTurns=[{id:currentLogId?'floor:'+currentLogId:'floor:'+guidance.logId,startedAt:guidance.startedAt,runs:[guidance]}];
  }else if(guidance&&!currentTurns[0].runs.some(function(r){return r.phase==='原著指导';})){
    currentTurns[0]={...currentTurns[0],runs:[guidance,...currentTurns[0].runs]};
  }
  return currentTurns;
}
// 2026-10-31 玩家反馈：「怎么原著补演的ui一直往上收啊，一会不看又少了一部分？」
//
// 现象：补演跑起来后，面板里已经展开的区块过一会儿自己折回去了，
//       看着像内容在往上收、越来越少。
// 根因：流式过程中 frCanonTraceRenderSoon 会反复重渲染，而每次都用
//       container.replaceChildren() 整块重建 DOM。原本只按 data-record-id
//       记住展开状态，但「进度指针」「补演边界判定」这些区块是普通 div，
//       里面的 details 没有 record-id，于是它们的展开状态每次都被丢掉，
//       重建后回到默认折叠 —— 玩家看到的就是「自己收上去了」。
//
// 现在补一套「按结构位置 + 标题文字」的展开记忆，覆盖所有 details，
// 不管有没有 record-id，重渲染后都能恢复原样。
var frCanonFoldMemory = new Map();   // key -> true(展开) / false(折叠)
function frCanonFoldKey(node, root){
  // 用「同名兄弟中的第几个 + summary 文字」拼出稳定 key。
  var parts = [];
  var cur = node;
  while (cur && cur !== root && cur.nodeType === 1) {
    var idx = 0, sib = cur;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === cur.tagName && sib.className === cur.className) idx++;
    }
    parts.unshift(cur.tagName + '[' + idx + ']');
    cur = cur.parentElement;
  }
  var summary = node.querySelector(':scope > summary');
  var label = summary ? String(summary.textContent || '').trim().slice(0, 40) : '';
  return parts.join('/') + '|' + label;
}
function frCanonFoldSnapshot(root){
  var map = new Map();
  if (!root) return map;
  Array.prototype.forEach.call(root.querySelectorAll('details'), function (d) {
    try { map.set(frCanonFoldKey(d, root), d.open === true); } catch (_) {}
  });
  return map;
}
function frCanonFoldRestore(root, snapshot){
  if (!root || !snapshot || !snapshot.size) return;
  Array.prototype.forEach.call(root.querySelectorAll('details'), function (d) {
    var key;
    try { key = frCanonFoldKey(d, root); } catch (_) { return; }
    if (snapshot.has(key)) d.open = snapshot.get(key);
    else if (d.dataset.recordId && frCanonFoldMemory.has(d.dataset.recordId)) d.open = frCanonFoldMemory.get(d.dataset.recordId) === true;
  });
}
function frCanonTraceRender(){
  if(window.__frPointerLayoutObserver){window.__frPointerLayoutObserver.disconnect();window.__frPointerLayoutObserver=null;}
  if(frCanonPointerClose)frCanonPointerClose();
  var container=document.getElementById('canon-trace-content');if(!container)return;
  /* 2026-11-02 玩家：「原著补演展示的当前回合你是不是忘记修改了？」
   *
   * 渲染是同步的，但楼层号要读存档 logs（异步）。这里先看缓存有没有；
   * 没有就**异步预取一次，拿到后自动重绘**。
   * 这样第一次打开会短暂只显示时间，几十毫秒后补上「第 N 层」，
   * 不需要玩家先去点开人生快照面板。
   * 用 _floorPrefetchFor 记下正在预取的存档名，避免每次渲染都重复发起。
   */
  var prefetchName=String(currentArchiveName||'');
  if(prefetchName&&!frCanonFloorCacheGet(prefetchName)&&frCanonTraceRender._floorPrefetchFor!==prefetchName){
    frCanonTraceRender._floorPrefetchFor=prefetchName;
    frCanonFloorCacheRefresh(prefetchName).then(function(logs){
      if(Array.isArray(logs))frCanonTraceRenderSoon();
      else frCanonTraceRender._floorPrefetchFor='';
    }).catch(function(){frCanonTraceRender._floorPrefetchFor='';});
  }
  /* 2026-10-31 玩家：「你应该做的是不要隐藏，而不是先隐藏再想办法找回来」
   *
   * 这里原来有一段「渲染前自愈」：每次渲染都扫一遍历史，把被误隐藏的
   * 原著指导放出来。那是治标 —— 根因在 frCanonTraceRollback 里
   * （没有楼层号的记录被当成待丢弃项隐藏）。
   *
   * 根因已修：没有 logId 的记录现在根本不参与楼层回退判定，永不隐藏。
   * 所以这段每次渲染都跑的补丁删掉。历史脏数据由 frCanonTraceLoad 里的
   * 一次性迁移负责清理（只跑一次，跑完记标记）。
   *
   * 面板渲染就该只做渲染这一件事。
   */
  var expanded=new Set(Array.from(container.querySelectorAll('details[open]')).map(function(n){return n.dataset.recordId;}));
  // 重渲染前先记下「所有」details 的开合状态（含没有 record-id 的普通区块）
  var foldBefore=frCanonFoldSnapshot(container);
  // record-id 的也并入长期记忆，跨回合切换后仍记得
  Array.prototype.forEach.call(container.querySelectorAll('details[data-record-id]'),function(d){frCanonFoldMemory.set(d.dataset.recordId,d.open===true);});
  var scroll=container.scrollTop,parentScroll=container.parentElement?.scrollTop,turns=frCanonTraceTurns();
  var selected=turns.findIndex(function(t){return t.runs.some(function(r){return r.id===frCanonTraceSelected;});});
  if(selected<0)selected=turns.length-1;
  var turn=turns[selected];container.replaceChildren();container.classList.add('fr-canon-trace');
  function el(tag,text,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  // ---- 检索日志 / 资料摘要渲染（必须留在本函数内：要用上面的 el()）----
  /**
   * 把检索日志（main.js 产出的纯文本）渲染成有层次的 DOM。
   *
   * 玩家 2026-10-30 定：补演阶段的检索结果要和原著指导一样看得懂，
   * 「现在只能看到一堆没有排版的 json 格式内容」。
   *
   * 日志本身是已经排好版的多行文本，这里只做视觉分层，不重新解析语义：
   *   🎯 策略行      → 加粗标题
   *   🔍 "检索词"    → 每个检索词一个小标题
   *   └─ ✅/⚪ ...   → 命中项，达标绿色、未达标灰色
   *   📊 / 🧩 / 🟡   → 汇总块
   *
   * @param {string} text 日志原文
   * @returns {HTMLElement|null} 解析出的容器；无法解析时返回 null，交回纯文本渲染
   */
  function frCanonSearchLogView(text){
    var raw=String(text==null?'':text);
    if(!raw.trim())return null;
    var lines=raw.split(/\r?\n/);
    var box=el('div',undefined,'fr-canon-searchlog');
    var hits=0,curBlock=null;
    for(var i=0;i<lines.length;i++){
      var line=lines[i],trimmed=line.trim();
      if(!trimmed)continue;
      if(/^🎯/.test(trimmed)){
        box.appendChild(el('div',trimmed,'fr-canon-searchlog-head'));curBlock=null;continue;
      }
      if(/^⚠️/.test(trimmed)){
        box.appendChild(el('div',trimmed,'fr-canon-searchlog-warn'));continue;
      }
      if(/^🔍/.test(trimmed)){
        // 检索词标题：去掉 emoji 与引号，只留词本身。
        var word=trimmed.replace(/^🔍\s*/,'').replace(/^"|"$/g,'');
        var head=el('div',undefined,'fr-canon-searchlog-query');
        head.appendChild(el('span','🔍','fr-canon-searchlog-qicon'));
        head.appendChild(el('span',word||trimmed,'fr-canon-searchlog-qtext'));
        box.appendChild(head);curBlock=head;hits++;continue;
      }
      if(/^[📊🧩🟡📌]/.test(trimmed)){
        var block=el('div',undefined,'fr-canon-searchlog-summary');
        block.appendChild(el('div',trimmed,'fr-canon-searchlog-summary-title'));
        box.appendChild(block);curBlock=block;continue;
      }
      if(/^[└├│]/.test(trimmed)){
        var ok=/✅/.test(trimmed),low=/🟡/.test(trimmed);
        var cls=ok?'is-pass':low?'is-low':'is-miss';
        var row=el('div',trimmed.replace(/^[└├│─\s]+/,''),'fr-canon-searchlog-hit '+cls);
        (curBlock||box).appendChild(row);continue;
      }
      // 其余（缩进的汇总说明等）跟当前块走。
      var tail=el('div',trimmed,'fr-canon-searchlog-line');
      (curBlock||box).appendChild(tail);
    }
    return hits?box:box;
  }

  /**
   * 「查看资料与记录」的内容整理成人能读的几行，不再抛一整坨 JSON。
   *
   * 原来是 `{source, report, retrievedOriginal, currentMaterial}` 直接
   * JSON.stringify，玩家看到的是一屏原始 JSON，看不出检索质量。
   */
  function frCanonMaterialSummaryText(value){
    if(!value||typeof value!=='object')return frCanonTraceText(value);
    var row=value.report&&typeof value.report==='object'?value.report:{};
    var out=[];
    var src=row.label||value.source||row.key||'';
    if(src)out.push('资料项：'+src);
    if(row.status)out.push('状态：'+String(row.status));
    if(row.reason)out.push('说明：'+String(row.reason));
    if(row.chars!==undefined)out.push('本次字数：'+String(row.chars));
    if(row.truncated)out.push('已截断（原 '+String(row.originalChars||'?')+' 字）');
    if(Array.isArray(row.selectedSources)&&row.selectedSources.length){
      out.push('检索实际来源：'+row.selectedSources.map(function(s){return String(s.source)+' '+String(s.count)+'条';}).join(' · '));
    }
    if(Array.isArray(row.requiredCharacters)&&row.requiredCharacters.length){
      out.push('必需人物：'+row.requiredCharacters.map(function(r){return String(r.name||'')+(r.found===true?'（已取得）':'（未取得）');}).join('、'));
    }
    if(row.searchLog)out.push('检索明细：见上方「查看检索词与实际入选资料」');
    // 原始回执仍完整保留在后面，供排障复制，只是不再顶在开头占满屏幕。
    out.push('');
    out.push('—— 原始记录 ——');
    out.push(JSON.stringify(value,null,2));
    return out.join('\n');
  }
  // 所有按钮统一走这里：点击立即给出忙碌/完成/失败反馈，不再有点了没反应的按钮。
  function button(text,handler,parent){
    var b=el('button',text);b.type='button';
    b.addEventListener('click',async function(event){
      event.preventDefault();event.stopPropagation();
      if(b.disabled)return;
      var label=b.textContent,slow=false;
      // 同步动作很快就结束，不要闪一下「处理中」；超过一瞬才显示忙碌态。
      var timer=setTimeout(function(){slow=true;b.setAttribute('aria-busy','true');b.textContent='处理中…';},140);
      try{
        var out=handler(event);
        if(out&&typeof out.then==='function')await out;
        return out;
      }catch(error){
        b.textContent='失败，可重试';
        b.dataset.actionState='error';
        b.title=String(error&&error.message||error);
        setTimeout(function(){if(b.isConnected){b.textContent=label;delete b.dataset.actionState;b.removeAttribute('aria-busy');}},2400);
        throw error;
      }finally{
        clearTimeout(timer);
        if(slow&&b.isConnected){b.textContent=label;b.removeAttribute('aria-busy');}
      }
    });
    parent.appendChild(b);return b;
  }
  // 把本轮时间推进档位归一成一份展示用信息。
  // 三档信息量差别极大：跨事件档只需说清涉及谁，无进展档只需一句结论，
  // 只有同事件有进展档才需要逐人细说。展示跟着档位走，不硬套同一套排版。
  function boundaryTierInfo(result,storyAnalysis,judgement,plan,views,events){
    var tier=result?.turnAdvanceTier||storyAnalysis?.turnAdvanceTier||judgement?.turnAdvanceTier||plan?.turnAdvanceTier||'';
    var decisions=plan?.decisions||judgement?.turnPlan?.decisions||[];
    var unreached=new Set(plan?.prebuiltUnreachedEventIds||plan?.ordinaryUnreachedEventIds||[]);
    var actors=Array.isArray(plan?.canonJobs)?plan.canonJobs.filter(row=>!row?.eventIds?.length||row.eventIds.some(id=>!unreached.has(id))).map(function(row){return row?.name||row?.actorRef;}):[
      ...(result?.involvedActors||[]),...(plan?.involvedActors||[]),...(storyAnalysis?.involvedActors||[]),
      ...decisions.filter(function(row){return ['push','break'].includes(row.canonAdvance);}).map(function(row){return row.name||row.actorRef;}),
      ...(result?.prose||result?.blocks||[]).map(row=>row.name),
      ...views.filter(v=>v.kind==='prose'&&v.accepted===true||v.kind==='characters'&&v.status==='saved').map(v=>v.name||v.block?.name),
      ...events.filter(e=>e.type==='actor_saved'&&e.data?.applied).map(e=>e.data.name),
    ];
    actors=[...new Set(actors.map(name=>String(name||'').trim()).filter(Boolean))];
    var meta={
      crossEvent:{label:'跨年表事件 · 完整补演',tone:'cross',headline:'本轮时间跨度覆盖多个年表事件',hint:'全员完整补演'},
      sameEventProgress:{label:'同事件内 · 有实际进展',tone:'progress',headline:'本轮落在同一年表事件内并产生新的原著要求',hint:'按需增量补演'},
      sameEventNoProgress:{label:'同事件内 · 无实际进展',tone:'none',headline:'本轮没有产生新的原著要求',hint:'不补演，流程结束'},
      outsideRange:{label:'年表之外 · 无需补演',tone:'none',headline:'本轮时间不在任何年表事件区间内',hint:'无原著参照，不补演'},
    };
    var picked=meta[tier]||{label:'档位待确认',tone:'none',headline:'',hint:''};
    picked.tier=tier;picked.actors=actors;picked.decisions=decisions;
    picked.coveredEventIds=result?.coveredEventIds||storyAnalysis?.coveredEventIds||[];
    return picked;
  }
  function section(title,parent){var s=el('section',undefined,'ce-thinking-section');s.appendChild(el('h3',title,'ce-thinking-section-header'));var b=el('div',undefined,'ce-thinking-section-body');s.appendChild(b);(parent||container).appendChild(s);return b;}
  function line(parent,label,text,badge){if(text===undefined||text===null||text==='')return;var p=el('p',undefined,'ce-entry-item fr-canon-trace-row');if(label)p.appendChild(el('span',label,badge?'ce-entry-badge '+badge:'fr-canon-trace-label'));p.appendChild(el('span',String(text),'fr-canon-trace-text'));parent.appendChild(p);}
  // 分组卡片：把同类结论收进一个带标题的区块，避免长列表平铺后无法扫读。
  // 传 recordId 时整张卡变成可折叠的 <details>：默认收起，玩家想细看再展开，
  // 展开状态与其它折叠项一样记在 recordId 上，刷新后保留。
  // 摘要行除了标题还能带一段右侧说明（比如「已保存」），
  // 这样收起时也能一眼看出谁保存了、谁还没保存，不用挨个展开找。
  function group(parent,title,tone,options){
    var opts=options||{};
    var foldable=typeof opts.recordId==='string'&&opts.recordId!=='';
    var box=el(foldable?'details':'div','','fr-canon-group'+(tone?' fr-canon-group-'+tone:'')+(foldable?' fr-canon-group-collapsible':''));
    if(foldable){
      box.dataset.recordId=opts.recordId;
      box.open=expanded.has(opts.recordId)||opts.open===true;
      var head=el('summary','','fr-canon-group-title');
      head.appendChild(el('span',title,'fr-canon-group-title-text'));
      // 用 <small> 承载状态词：它既是摘要里唯一可见的文字，
      // 也要能被「只看可见文字」的读取方式取到，收起时状态才看得见。
      if(opts.note)head.appendChild(el('small',opts.note,opts.noteTone?'fr-canon-group-note '+opts.noteTone:'fr-canon-group-note'));
      box.appendChild(head);
    }else box.appendChild(el('div',title,'fr-canon-group-title'));
    var body=el('div','','fr-canon-group-body');box.appendChild(body);parent.appendChild(box);return body;
  }
  // 结论条目：分类标题 + 逐条内容，条与条之间独立，不再把标签和正文挤成一行。
  // 用 <p> 承载正文，保证每条结论仍是可被读取、可被复制的段落。
  function item(parent,text,index){var row=el('p','','fr-canon-group-item');row.appendChild(el('span',String(index),'fr-canon-group-index'));row.appendChild(el('span',String(text),'fr-canon-group-text'));parent.appendChild(row);return row;}
  // 统计摘要：让玩家先看到「有哪几类、各几条」，再决定看哪一类。
  // 标签和条数分开渲染：条数用等宽数字加粗，扫读时数字对齐更容易比较。
  function summary(parent,entries){
    var bar=el('div','','fr-canon-summary');var total=0;
    entries.forEach(function(entry){if(!entry.rows.length)return;total+=entry.rows.length;var chip=el('span',undefined,'fr-canon-summary-chip fr-canon-summary-'+(entry.tone||'plain'));chip.appendChild(el('span',entry.title,'fr-canon-summary-label'));chip.appendChild(el('span',String(entry.rows.length),'fr-canon-summary-count'));bar.appendChild(chip);});
    if(!total)return null;parent.appendChild(bar);return bar;
  }
  // 时间轴：把「已经发生 / 本轮应发生 / 尚未到时机」串成一条竖线。
  // 这三类本来就是同一条时间线的过去、现在、未来，平铺成三个卡片会让玩家自己归类。
  function timeline(parent){var wrap=el('div','','fr-canon-timeline');parent.appendChild(wrap);return wrap;}
  // 时间轴的一段。dot: past|now|future。now 段用实心高亮点，视觉重心落在「我现在该演什么」。
  function stage(parent,title,dot,rows,collapsed,note){
    var box=el('div','','fr-canon-stage fr-canon-stage-'+dot+(collapsed?' is-collapsed':''));
    var head=el('div','','fr-canon-stage-head');
    head.appendChild(el('span',undefined,'fr-canon-stage-dot'));
    head.appendChild(el('span',title,'fr-canon-stage-title'));
    head.appendChild(el('span',String(rows.length),'fr-canon-stage-count'));
    box.appendChild(head);
    var body=el('div','','fr-canon-stage-body');
    var hint=note||('后续将发生 '+rows.length+' 件事，点击展开。');
    var fill=function(open){body.replaceChildren();if(open)rows.forEach(function(text,index){item(body,text,index+1);});else body.appendChild(el('p',hint,'fr-canon-stage-hint'));};
    fill(!collapsed);
    box.appendChild(body);
    if(collapsed){
      head.setAttribute('role','button');head.setAttribute('tabindex','0');head.setAttribute('aria-expanded','false');
      var toggle=function(){
        var open=box.classList.toggle('is-collapsed')===false;
        head.setAttribute('aria-expanded',open?'true':'false');fill(open);
      };
      head.addEventListener('click',toggle);
      head.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}});
    }
    parent.appendChild(box);return box;
  }
  // 旁注：不属于时间轴的信息（剧透、世界线偏离），用独立视觉语言区分，
  // 让玩家一眼看出「这不是时间线上的一环」。
  function aside(parent,title,tone,rows,note){
    var box=el('div','','fr-canon-aside fr-canon-aside-'+tone);
    var head=el('div','','fr-canon-aside-head');
    head.appendChild(el('span',title,'fr-canon-aside-title'));
    head.appendChild(el('span',String(rows.length)+' 条','fr-canon-aside-count'));
    box.appendChild(head);
    var body=el('div','','fr-canon-aside-body');
    rows.forEach(function(text,index){item(body,text,index+1);});
    box.appendChild(body);
    if(note)box.appendChild(el('p',note,'fr-canon-aside-note'));
    parent.appendChild(box);return box;
  }
  // 情境条：时间、原著事件、资料状态压成一行，不再各占一行浪费高度。
  function contextBar(parent,time,event,receipt){
    var bar=el('div','','fr-canon-context');
    if(time){bar.appendChild(el('span',typeof time==='string'?time:String(time.time||time.targetTime||''),'fr-canon-context-time'));}
    /* ★★ 2026-11-01 玩家：「关于开局只写到月的话你是怎么处理当前时间点的呢？」
     *
     * 口径（玩家定）：只说到月 → 按当月月初 1 号；什么都没说 → 按当前世界时间。
     *
     * 但光显示「0010.04.01」会让玩家以为那天是自己指定的。
     * 这里把「时间是怎么定出来的」一并摊开，玩家才看得出程序替他补了哪一天：
     *   · precision='month' → 明确写「你只说到月，按 4 月 1 日判定」
     *   · source='world'    → 「你没指定，沿用当前世界时间」
     */
    if(time && typeof time==='object'){
      var precision=String(time.precision||''),source=String(time.source||'');
      var hint='';
      if(precision==='month')hint='你只指定到月份，本轮按当月 1 日判定';
      else if(source==='world')hint='本轮未指定时间，沿用当前世界时间';
      else if(source==='story_timeline')hint='沿用本轮正文年表锚点';
      if(hint){
        if(bar.childElementCount)bar.appendChild(el('span',undefined,'fr-canon-context-sep'));
        var tip=el('span',hint,'fr-canon-context-chip is-warn');tip.title=String(time.reason||'');bar.appendChild(tip);
      }
    }
    if(event){if(bar.childElementCount)bar.appendChild(el('span',undefined,'fr-canon-context-sep'));bar.appendChild(el('h4',event,'fr-canon-context-event'));}
    if(receipt){
      var labels={found:'资料已返回',not_found:'未找到资料',disabled:'检索已关闭',unavailable:'检索不可用',unconfigured:'检索未配置',error:'检索未完成',cancelled:'检索已取消',not_needed:'无需检索'};
      if(bar.childElementCount)bar.appendChild(el('span',undefined,'fr-canon-context-sep'));
      bar.appendChild(el('span',labels[receipt.status]||String(receipt.reason||''),'fr-canon-context-chip'+(receipt.completed===true?' is-ok':' is-warn')));
    }
    if(bar.childElementCount)parent.appendChild(bar);return bar;
  }
  function eventTitle(text){var title=String(text||'').replace(/^\s*(?:【)?E-\d+(?:】)?\s*[·|：:\-]?\s*/,'').trim();return title||'原著事件';}
  function searchLine(parent,receipt){if(!receipt)return;var labels={found:'已检索，资料已返回',not_found:'已检索，未找到资料；按已有材料继续',disabled:'已关闭，未执行检索',unavailable:'检索能力不可用',unconfigured:'检索未配置',error:'检索未完成',cancelled:'检索已取消',not_needed:'本轮无需检索'};line(parent,'设定资料',labels[receipt.status]||receipt.reason,receipt.completed?'ce-badge-in':'ce-badge-reentry');}
  function localCopy(label,value,parent,id){
    var b=button(label,async function(){b.disabled=true;try{var data=typeof value==='function'?value():value;var safe=frCanonTraceClean(data,{_secrets:(turn?.runs||[]).flatMap(function(r){return r._secrets||[];})});await frCanonCopyRecordText(frCanonTraceText(safe));b.textContent='已复制';}catch(error){b.textContent='复制失败';b.title=String(error.message||error);}finally{b.disabled=false;setTimeout(function(){if(b.isConnected)b.textContent=label;},1800);}},parent);
    b.dataset.copyRecordId=id;return b;
  }
  function details(id,label,value,parent){var d=el('details');d.dataset.recordId=id;d.appendChild(el('summary',label));localCopy('复制此项',value,d,id);var pre=el('pre');d.appendChild(pre);d.addEventListener('toggle',function(){if(d.open)pre.textContent=frCanonTraceText(value);});if(expanded.has(id)){d.open=true;pre.textContent=frCanonTraceText(value);}(parent||container).appendChild(d);return d;}
  function fold(parent,id,label){var d=el('details',undefined,'fr-canon-result-fold');d.dataset.recordId=id;d.open=expanded.has(id);d.appendChild(el('summary',label));parent.appendChild(d);return d;}
  // 仅供原生展示器读取的格式转换；不解析剧情，也不执行任何变量指令。
  function displayCommands(ops){return (ops||[]).map(function(op){
    if(!op||!op.command)return '';var cmd=op.command;
    if(cmd==='add'||cmd==='set')return cmd+'('+JSON.stringify(op.data||{})+')';
    if(cmd==='updateAttribute')return cmd+'('+JSON.stringify(op.id||'')+','+JSON.stringify(op.attribute||op.attrName||op.key||'属性')+','+JSON.stringify(op.data||op.value||{})+')';
    return cmd+'('+JSON.stringify(op.id||'')+','+JSON.stringify(op.data??op.skillData??op.traitData??op.itemData??op.gongfa??op.value??op.name??{})+')';
  }).filter(Boolean).join('\n');}
  var placedRequests=new Set();
  function debug(run,parent,filter,scopeLabel){
    var d=el('details',undefined,'fr-canon-diagnostics');d.dataset.recordId=run.id+'-diagnostics-'+(scopeLabel||'remaining');d.open=expanded.has(d.dataset.recordId);d.appendChild(el('summary','查看提示词、模型返回与诊断'));parent.appendChild(d);
    var requests=(run.requests||[]).filter(function(req){return filter?filter(req):!placedRequests.has(req.id);}),groups=new Map();
    requests.forEach(function(req){placedRequests.add(req.id);var label=scopeLabel||req.stageKey||req.stage||run.phase;if(!groups.has(label))groups.set(label,[]);groups.get(label).push(req);});
    groups.forEach(function(rows,label){var group=el('div',undefined,'fr-canon-copy-group');group.appendChild(el('h4',label));d.appendChild(group);
      localCopy('复制本阶段',function(){return {stage:label,buildId:run.buildId,status:run.status,attemptCount:rows.length,request:rows.at(-1),reason:run.result?.reason||''};},group,run.id+'-stage-'+label);
      rows.forEach(function(req,i){details(req.id+'-messages','#'+(i+1)+' '+req.stage+' · 发送内容',req.messages,group);details(req.id+'-response','#'+(i+1)+' '+req.stage+' · 模型返回与推理',req.response||req.error||'等待返回',group);});
    });
    if(!filter){details(run.id+'-parsed','解析与执行详情',run.result||run.events,d);details(run.id+'-timeline','运行过程',run.events,d);details(run.id+'-meta','记录与保存详情',{archive:run.archiveName,status:run.status,persisted:run.persisted,error:run.persistError},d);}
    return d;
  }
  function native(parent,data,prefix){
    if(!data||typeof ceRenderThinkingToStreamTab!=='function')return false;
    var target=el('div',undefined,'fr-canon-native-results');
    try{ceRenderThinkingToStreamTab(data.thinking||[],data.entry||null,{container:target,snapshot:data.snapshot||{}});if(data.proposed)target.querySelectorAll('.ce-thinking-item-management .ce-entry-item').forEach(function(n){if(n.textContent.startsWith('执行结果:'))n.remove();});target.querySelectorAll('details').forEach(function(d,i){d.dataset.recordId=prefix+'-native-'+i;d.open=expanded.has(d.dataset.recordId);});parent.appendChild(target);return target.childElementCount>0;}
    catch(error){line(parent,'结果暂无法显示','请展开下方记录查看返回内容。','ce-badge-out');return false;}
  }
  var bar=el('div',undefined,'fr-canon-trace-toolbar');
  /* ★★★ 2026-11-02 玩家：「不要分上一回合下一回合了，永远只展示当前回合最新的记录流程。」
   *
   * 所以这里不再放「上一回合 / 下一回合」按钮——回合切换会让同一层的多份记录
   * 同时存在，玩家分不清哪份才是实际生效的。现在 frCanonTraceTurns() 只返回
   * 当前楼层的记录，标题固定显示当前回合，翻页按钮一并去掉。
   */
  /* 2026-11-02 玩家：「原著补演展示这里的运行日志是不是最好也改成对应快照层数，
   * 这样也能更直观看到是不是对齐了。」
   *         「原著补演展示的当前回合你是不是忘记修改了？」
   *
   * 楼层号用文件顶部的 frFloorLabelOf 纯函数**现算**，不依赖任何面板先跑过。
   * （上一版读 window.__frFloorDisplayMap，而那份映射要打开人生快照面板才生成，
   *   所以这里永远取不到值，标题只剩时间 —— 玩家截图正是这个现象。）
   *
   * turn.id 的形状：frCanonTraceTurns 里分组键是
   *   run.logId ? 'floor:'+run.logId : (turnId || run.id)
   * 所以要先剥掉 'floor:' 前缀再查；查不到再退回该回合第一条 run 的 logId。
   */
  function frFloorTextOf(rawId){
    var key=String(rawId||'');
    if(!key)return '';
    try{
      var candidates=[key];
      if(key.indexOf('floor:')===0)candidates.unshift(key.slice(6));
      var archiveLike=frCanonTraceArchive;
      for(var ci=0;ci<candidates.length;ci++){
        var text=frFloorLabelSync(candidates[ci],frCanonTraceArchive);
        if(text)return text;
      }
      // 兜底：宿主渲染过聊天楼层时挂上的那份映射
      var map=(typeof window!=='undefined'&&window.__frFloorDisplayMap instanceof Map)?window.__frFloorDisplayMap:null;
      for(var cj=0;cj<candidates.length;cj++){
        if(map&&map.has(candidates[cj])){
          var hit=map.get(candidates[cj]);
          var hitText=hit&&hit.displayText?String(hit.displayText):'';
          if(hitText)return hitText;
        }
      }
    }catch(_){}
    return '';
  }
  var turnFloorText=frFloorTextOf(turn&&turn.id);
  if(!turnFloorText&&turn&&turn.runs){
    for(var trIdx=0;trIdx<turn.runs.length&&!turnFloorText;trIdx++){
      turnFloorText=frFloorTextOf(turn.runs[trIdx]&&turn.runs[trIdx].logId);
    }
  }
  bar.appendChild(el('span',turn
    ?('当前回合 · '+(turnFloorText?turnFloorText+' · ':'')+new Date(turn.startedAt).toLocaleString())
    :'原著补演','fr-canon-turn-title'));
  button('导出本轮记录',function(){if(!turn)return;var blob=new Blob([JSON.stringify(turn.runs.map(function(r){return frCanonTraceExport(r);}),null,2)],{type:'application/json'});var url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='原著补演-'+turn.id.replace(/[^\w-]/g,'_')+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);},bar).disabled=!turn;
  container.appendChild(bar);
  if(!turn){container.appendChild(el('p','暂无运行记录。下一轮的原著指导、补演故事和生效结果会依次显示在这里。','fr-canon-empty'));return;}
  /* 2026-11-02 玩家改规则：旧补演记录**直接清掉**，面板上不再出现
   * 「本轮已被重roll覆盖」的说明块和折叠块。
   * 记录在 frCanonTracePurge 里就从内存和存档同时删掉了，
   * 所以到渲染这一步，turn.runs 里本来就不会再有作废记录。
   * 保留下面的空态分支即可：新补演还没跑时，面板显示「暂无运行记录」。
   */
  var allRuns=turn.runs.filter(function(r){return r.phase!=='变量演化';}).sort(function(a,b){return a.startedAt-b.startedAt;});
  var latest=new Map();allRuns.forEach(function(r){if(r.result?.rolledBack===true&& latest.has(r.phase))return;latest.set(r.phase,r);});var runs=Array.from(latest.values()).sort(function(a,b){return a.startedAt-b.startedAt;});
  var previous=allRuns.filter(function(r){return latest.get(r.phase)!==r;});
  runs.forEach(function(run){
    var events=run.events||[],final=run.result||{},views=[...(run._displayViews?.values()||[]),...events,...(run._savedActorViews||[])].filter(function(e){return e.type==='view'&& e.data;}).map(function(e){return e.data;});
    var replaySource=run.replayOf&&frCanonTraceHistory.find(function(previous){return previous.id===run.replayOf&&previous.archiveName===run.archiveName&&previous.logId===run.logId;});
    if(replaySource){var retained=(replaySource.events||[]).filter(function(e){return e.type==='view'&&e.data?.kind==='prose'&&e.data.accepted===true;}).map(function(e){return Object.assign({},e.data,{reused:true});});views=retained.concat(views);}
    var parsed=events.filter(function(e){return e.label==='补演解析与账本计划'&& e.data;}).slice(-1)[0];
    var result=Object.assign({},parsed&& parsed.data||{},final,run.executionResult||{}),active=run.status==='running',committed=final.rolledBack!==true&&(final.landed===true||final.committed===true||events.some(function(e){return e.type==='committed';}));
    var host=el('div',undefined,'fr-canon-flow-part');host.dataset.runId=run.id;container.appendChild(host);
    /* 2026-11-02 玩家改规则：旧补演记录直接清掉，不再折叠保留。
     * 所以这里不再有 branchHidden 的折叠分支——能走到这里的记录都是有效的。
     */
    var phase=run.phase==='正文后补演'?'原著补演':run.phase;
    function directAction(parent,label,selection){
      var group=el('div',undefined,'fr-canon-action-group');parent.appendChild(group);parent=group;
      if(typeof frReplayRunDirect!=='function')return;
      var selectionKey=JSON.stringify(selection),actionKey=run.archiveName+'|'+run.id+'|'+selectionKey;
      // 新尝试替换展示记录时，沿用同一楼层同一操作的反馈，不能让点击确认消失。
      var pending=Object.values(frCanonDirectActions).find(function(s){return s.busy&&s.archiveName===run.archiveName&&s.logId===run.logId&&s.selectionKey===selectionKey;});
      var state=frCanonDirectActions[actionKey]||(frCanonDirectActions[actionKey]=pending||{busy:false,message:'',phase:'idle',archiveName:run.archiveName,logId:run.logId,selectionKey:selectionKey});
      var anotherBusy=Object.values(frCanonDirectActions).some(function(s){return s.busy&&s.archiveName===run.archiveName;});
      var status=el('span',state.busy&&active?'已启动，正在重跑…':state.message||(active?'本轮正在处理中，请稍候。':''),'fr-canon-action-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      var b=button(state.busy?(active?'正在重跑…':'正在准备…'):state.phase==='success'?'已完成 · '+label:state.phase==='error'?'重试 · '+label:label,async function(){
        if(state.busy||b.disabled)return;state.busy=true;state.phase='busy';state.prerequisite=null;state.message='已收到，正在准备重跑…';frCanonTraceRender();
        try{var outcome;if(selection.continueTurn&&typeof frCanonContinueTurn==='function')outcome=await frCanonContinueTurn({runId:run.id,direct:true});else outcome=await frReplayRunDirect('canon',Object.assign({runId:run.id},selection));
          /* 「本轮没有失败项」是正常结果，不是失败。
           * 原来会被当成 landed===false 抛成红字「未完成：…」，
           * 玩家以为点坏了。现在按成功收尾，并如实说明什么都没跑。 */
          if(outcome&&outcome.noFailure===true){state.phase='success';state.message=outcome.reason||'本轮没有失败或没跑完的项目。';}
          else if(outcome?.landed===false)throw new Error(outcome.reason||outcome.landReason||'本轮尚未完成，请查看对应阶段。');
          else{state.phase='success';state.message=outcome?.message||'处理完成，结果已更新。';}
        }
        catch(error){state.phase='error';state.message='未完成：'+String(error.message||error);state.prerequisite=error.retrySelection||null;}
        finally{state.busy=false;frCanonTraceRender();}
      },parent);b.disabled=active||anotherBusy;b.classList.add('fr-canon-direct-action');b.setAttribute('aria-busy',String(state.busy));b.dataset.actionState=state.phase;b.title=b.disabled?(state.busy?'已收到，正在处理。':'本轮正在处理，请等待结束。'):label;
      if(selection.stages)b.dataset.replayStage=selection.stages.join('、');parent.appendChild(status);
      if(state.prerequisite){var prerequisiteStages=Array.from(new Set([...(state.prerequisite.stages||[]),...(state.prerequisite.scopes||[]).map(scope=>scope.slice(0,scope.indexOf(':')))]));var stageLabels={characters:'人物状态',items:'物品更新',misc:'世界更新','人物边界批量判定':'人物边界','人物终态推演':'人物状态核对','人物视角散文':'人物正文','落地依据提取':'落地依据提取','生平旧账':'过往经历','变量重复核验':'结算核验'};var prerequisiteLabel=prerequisiteStages.length===1?(stageLabels[prerequisiteStages[0]]||prerequisiteStages[0]):'所需前置';var dependency=button('从'+prerequisiteLabel+'继续',async function(){
        if(state.busy)return;state.busy=true;state.phase='busy';state.message='正在从所需前置继续…';frCanonTraceRender();
        try{await frReplayRunDirect('canon',{runId:run.id,stages:Array.from(new Set([...(selection.stages||[]),...(state.prerequisite.stages||[])])),scopes:Array.from(new Set([...(selection.scopes||[]),...(selection.scope?[selection.scope]:[]),...(state.prerequisite.scopes||[])]))});state.phase='success';state.message='处理完成，结果已更新。';state.prerequisite=null;}
        catch(error){state.phase='error';state.message='未完成：'+String(error.message||error);state.prerequisite=error.retrySelection||null;}finally{state.busy=false;frCanonTraceRender();}
      },parent);dependency.classList.add('fr-canon-direct-action');dependency.disabled=active||anotherBusy;dependency.dataset.retryPrerequisite='true';}
      return b;
    }
    function stageAction(parent,keys,label){return directAction(parent,label||'重跑本阶段',{stages:keys});}
    if(run._replay||run.replayOf)phase+=' · 局部重跑';
    var report=result.materialReport||views.filter(function(v){return v.kind==='materials';}).slice(-1)[0]?.report;
    if(Array.isArray(report))report=report.filter(function(row){return row&&typeof row==='object'&&!Array.isArray(row);});
    if(Array.isArray(report)&&report.length){
      var materials=section('资料准备 · '+phase,host),available=report.filter(function(row){return Number(row.chars)>0;}),cut=report.filter(function(row){return row.truncated;});
      line(materials,'已取得',available.length+' / '+report.length+' 项 · '+available.reduce(function(sum,row){return sum+(Number(row.chars)||0);},0)+' 字','ce-badge-in');
      if(cut.length)line(materials,'已截断',cut.length+' 项；可在设置中调整发送上限。','ce-badge-reentry');
      var grid=el('div',undefined,'fr-canon-material-grid');materials.appendChild(grid);
      report.forEach(function(row){
        var chars=Number(row.chars)||0,original=Number(row.originalChars)||chars,empty=chars===0,failed=['error','unconfigured'].includes(row.status),unavailable=['missing','unavailable'].includes(row.status);
        var card=el('article',undefined,'fr-canon-material-card'+(row.truncated?' is-truncated':empty?' is-empty':''));grid.appendChild(card);
        var heading=el('div',undefined,'fr-canon-material-heading');card.appendChild(heading);heading.appendChild(el('h4',row.label||row.key));
        heading.appendChild(el('span',failed?'读取未完成':unavailable?'能力不可用':row.truncated?'已截断':empty?'暂无资料':'已取得','ce-entry-badge '+(failed||unavailable?'ce-badge-out':row.truncated?'ce-badge-reentry':empty?'':'ce-badge-in')));
        line(card,'',failed||unavailable?row.reason||'本次读取未完成，请查看记录。':empty?(row.status==='skipped'?'本阶段未采集。':'本次没有资料；按已有材料继续。'):row.truncated?'发送 '+chars+' / 原 '+original+' 字':chars+' 字 · 完整发送');
        if(row.selectedCount!==undefined)line(card,'取用范围',row.selectedCount+(row.unit||'条')+' · 选中记录完整发送');
        if(row.compatibilityFallback)line(card,'兼容读取',row.reason);
        if(Array.isArray(row.missingArchives)&&row.missingArchives.length)line(card,'尚未建档',row.missingArchives.join('、')+'；'+(Array.isArray(row.settingAvailableNames)&&row.settingAvailableNames.length?'其中 '+row.settingAvailableNames.join('、')+' 已取得原著设定，可按新人路径继续。':'对应原著设定亦尚未确认，不补造。'));
        var noSettings=(Array.isArray(row.requiredCharacters)?row.requiredCharacters:[]).filter(function(receipt){return receipt&&receipt.found!==true;});if(noSettings.length)line(card,'设定未取得',noSettings.map(function(receipt){return receipt.name+'：'+receipt.reason;}).join('；'));
        if(Array.isArray(row.selectedSources)&&row.selectedSources.length)line(card,'检索实际来源',row.selectedSources.map(source=>source.source+' '+source.count+'条').join(' · '));
        // 检索日志单独成块，用结构化视图渲染（玩家 2026-10-30 要求：
        // 补演要和原著指导一样看得懂，不要一坨原始文本）。
        if(row.searchLog){
          var logDetails=el('details');
          logDetails.dataset.recordId=run.id+'-material-'+row.key+'-search-log';
          logDetails.appendChild(el('summary','查看检索词与实际入选资料'));
          localCopy('复制此项',row.searchLog,logDetails,logDetails.dataset.recordId);
          var logView=frCanonSearchLogView(row.searchLog);
          var logPre=el('pre');logPre.textContent=row.searchLog;
          logDetails.appendChild(logView||logPre);
          if(logView){
            // 排好版的视图给默认展示；原文折叠保留，方便排障时整段复制。
            var rawFold=el('details',undefined,'fr-canon-searchlog-raw');
            rawFold.appendChild(el('summary','查看原始文本'));
            rawFold.appendChild(logPre);
            logDetails.appendChild(rawFold);
          }
          logDetails.addEventListener('toggle',function(){
            if(logDetails.open && !logDetails.dataset.rendered){
              logDetails.dataset.rendered='1';
            }
          });
          if(expanded.has(logDetails.dataset.recordId))logDetails.open=true;
          card.appendChild(logDetails);
        }
        var captured=events.filter(function(e){return e.type==='material'&&e.label==='资料 · '+(row.key==='ragVector'?'vectorContext':row.key);}).slice(-1)[0];
        var value={source:row.label||row.key,report:row};if(captured)value.retrievedOriginal=captured.data;if(run.materialState?.material?.[row.key])value.currentMaterial=run.materialState.material[row.key];
        // 摘要在前、原始记录在后，不再一打开就是一屏 JSON。
        details(run.id+'-material-'+row.key,'查看资料与记录',frCanonMaterialSummaryText(value),card);
        if(failed && run.materialState){
          var retry=button('只重试本项',async function(){retry.disabled=true;retry.setAttribute('aria-busy','true');try{await frCanonRetryMaterial(run.id,row.key);}catch(error){run.materialRetryFeedback={key:row.key,status:'error',text:String(error.message||error)};frCanonTraceRenderSoon();}},card);
          retry.dataset.materialRetry=row.key;retry.disabled=active||!!frCanonMaterialBusy||selected!==turns.length-1||!run.materialBoundary;retry.title=retry.disabled?'仅当前有效楼层且没有其他工作运行时可补取。':'只重试这项失败资料，保留已取得和正常空项。';retry.setAttribute('aria-busy',String(!!frCanonMaterialBusy && run.materialRetryFeedback?.key===row.key));
        }
      });
      if(run.materialRetryFeedback)line(materials,'',run.materialRetryFeedback.text);
      if(result.materialFollowup)line(materials,'资料后续',result.materialFollowup);
      if(result.guidanceNeedsUpdate && run.materialGuidanceContext){var update=button('仅更新本轮指导',async function(){update.disabled=true;try{await frCanonRetryMaterial(run.id,'',{guidanceOnly:true});}catch(error){run.materialRetryFeedback={status:'error',text:String(error.message||error)};frCanonTraceRenderSoon();}},materials);update.disabled=active||!!frCanonMaterialBusy||selected!==turns.length-1||!run.materialBoundary;update.dataset.materialGuidanceUpdate='true';}
    }
    if(run.phase==='原著指导'){
      var guide=section(phase,host),node=result.node;
      var time=run.guidanceTime||result.guidanceTime;
      // 情境条：时间、事件、资料状态压成一行，玩家一眼知道「现在在哪、资料够不够」。
      contextBar(guide,time,node?eventTitle(node.title):'',result.retrievalReceipt);
      if(result.guidance){
        var rowsOf=function(key){return (result.guidance[key]||[]).filter(function(text){return String(text||'').trim();});};
        var past=rowsOf('facts'),now=rowsOf('pending'),future=rowsOf('notYet');
        var secret=rowsOf('invisible'),deviated=rowsOf('doNotForce');
        // 不再单列摘要 chips：时间轴的段标题和旁注头已经带条数，
        // 再来一排同名统计只会重复一遍，反而让玩家多看一次同样的词。
        // 时间轴：过去 → 现在 → 未来，一条竖线串起来，玩家不用自己归类。
        if(past.length||now.length||future.length){
          var axis=timeline(guide);
          if(past.length)stage(axis,'已经发生','past',past,false);
          // 本轮应发生是玩家最需要看的，即使为空也给出明确结论。
          stage(axis,'本轮应发生','now',now.length?now:['本轮没有必须写进正文的原著情节。'],false);
          if(future.length)stage(axis,'尚未到时机','future',future,true);
        }
        // 旁注：不属于时间轴的两类，用独立视觉语言区分。
        if(secret.length)aside(guide,'玩家尚不知情','hidden',secret,'以下内容玩家角色还不知道，不要写成玩家已知。');
        if(deviated.length)aside(guide,'已偏离原著','deviated',deviated);
        var conclusion=result.guidance.deviation?.conclusion;
        if(conclusion){
          var status=el('div','','fr-canon-worldline');
          var off=/偏离|不一致|冲突/.test(String(conclusion));
          status.appendChild(el('span',off?'世界线偏离':'世界线吻合','fr-canon-worldline-badge'+(off?' is-off':'')));
          status.appendChild(el('span',String(conclusion),'fr-canon-worldline-text'));
          guide.appendChild(status);
        }
        if(!past.length&&!now.length&&!future.length&&!secret.length&&!deviated.length&&!conclusion){
          line(guide,'','本轮没有需要额外推演的原著结论。','ce-badge-in');
        }
      }
      else if(result.text)guide.appendChild(el('div',result.text,'fr-canon-trace-prose'));
      else line(guide,'',active?'正在整理本轮原著指导…':result.reason||'本轮没有注入原著指导。');
      if(result.injectable===false&& result.text)line(guide,'未采用',result.reason||'本轮指导未加入正文提示词。','ce-badge-out');
      debug(run,guide);return;
    }
    if(run.phase==='资料自检'){
      var check=section('资料检查',host);line(check,'',active?'正在检查年表、接口与原卡执行服务…':run.status==='cancelled'?'检查已取消。':result.ok?'年表与执行配置检查完成。':result.reason||'检查未完成。');debug(run,check);return;
    }
    // 「本轮任务分工」不再单独成面板：分工就是边界判定的结论，
    // 两块并排会各说各话（曾经出现过上面写「走廊内局部补演」、
    // 下面年表却跨了三个事件的自相矛盾）。现在统一在「补演边界判定」里，
    // 按本轮时间推进档位决定展开多少，只有同事件有进展档才逐人细说。
    var judgement=views.filter(function(v){return v.kind==='judgement';}).slice(-1)[0]||{};
    var selection=views.filter(function(v){return v.kind==='selection';}).slice(-1)[0];
    var dispatch=views.filter(function(v){return v.kind==='dispatch';}).slice(-1)[0];
    var storyAnalysis=views.filter(function(v){return v.kind==='storyAnalysis';}).slice(-1)[0];
    var source=views.filter(function(v){return v.kind==='events';}).slice(-1)[0]||{};
    var retrieval=views.filter(function(v){return v.kind==='retrieval';}).slice(-1)[0]||result.retrievalReceipt;
    var notes=views.filter(function(v){return v.kind==='materialNotes';}).slice(-1)[0];
    var range=result.range||source.range,diff=result.diff||judgement.diff,musts=result.musts||judgement.musts;
    var pointerPlan=result.turnPlan||views.filter(v=>v.kind==='routing'||v.kind==='canonTurnPlan').at(-1)?.turnPlan||views.filter(v=>v.kind==='canonTurnPlan').at(-1);
    if(pointerPlan?.eventWindows?.length|| pointerPlan?.eventWatches?.length)frCanonRenderProgressPointer(section('进度指针',host),pointerPlan,result.eventProgress||[],storyAnalysis||result.storyAnalysis);
    /* ★★ 2026-11-01 玩家：「这种在原著故事之前的时间点也应该启动原著补演的边界判定
     *    流程才对啊，怎么展示ui里完全没有。」
     *
     * 原来这里靠「有没有数据」决定要不要画这一块：
     *   if(storyAnalysis||selection||diff||musts||range||retrieval){ ... }
     * 开局在原著第一件事之前时这些全空 → 整块不画 → 玩家看到一片空白，
     * 分不清是「跑了但结论是不用补」还是「压根没跑」。
     *
     * 现在：补演阶段的边界判定**恒画**。
     *   · 有数据 → 照旧展示档位、时间跨度、年表。
     *   · 没数据 → 也给一块明确的结论，把「为什么没有可补的」写出来，
     *     而不是让面板留白。这两件事必须让玩家能分辨。
     */
    {
      var boundary=section('补演边界判定',host);
      // 与原著指导同一套视觉：顶部情境条 + 档位徽章，下面按档位决定展开多少。
      // 三档的信息量差别极大，硬要统一排版只会让档① 塞满没用的逐人说明、
      // 让档③ 空占一大块。所以按档位分别渲染。
      var tierInfo=boundaryTierInfo(result,storyAnalysis||result.storyAnalysis,judgement,pointerPlan,views,events);
      var tierBar=el('div','','fr-canon-tier-bar');
      var tierChip=el('span',tierInfo.label,'fr-canon-tier-chip fr-canon-tier-'+tierInfo.tone);
      tierBar.appendChild(tierChip);
      boundary.appendChild(tierBar);
      // 完全没有可用判定材料时的兜底结论：明确说清「为什么没东西可补」。
      var noMaterial=!(storyAnalysis||selection||diff||musts||range||retrieval);
      if(noMaterial&&!tierInfo.tier){
        /* ★★ 2026-11-01 玩家截图：边界判定跑的时候，这段说明被挤成每行一个字的竖条。
         *
         * 根因：原来这里复用了 .fr-canon-group-item —— 那是「序号 + 正文」的两列网格
         *   grid-template-columns:24px minmax(0,1fr)
         * 而这里只塞了一个 span、没有序号，它落进了第一列（宽 24px），
         * 于是每个字被迫换行，竖成一条。
         *
         * 这不是「样式没写好」，是**用错了容器**：没有序号的行不该套带序号的网格。
         * 所以不再复用 group-item，改用专门的无序号说明行 fr-canon-note。
         * 容器修好的同时给个兜底 min-width，防止以后再被类似的窄列挤住。
         */
        var note=el('p',undefined,'fr-canon-note');
        note.textContent=active?'本轮边界正在准备，尚未形成判定结果。'
          :'本轮尚未形成有效边界判定。'+(result.reason||'请查看运行过程，确认是否未启动、中止或失败。')+'不能据此认定为「年表之外」。';
        boundary.appendChild(note);
      }
      function dateLabel(value){return String(value||'').split(/[\/|]/)[0].trim();}
      if(range){var dates=el('div','','fr-canon-boundary-dates');dates.appendChild(el('small','本轮时间跨度',''));dates.appendChild(el('strong',dateLabel(range.start)+' → '+dateLabel(range.end),''));boundary.appendChild(dates);}
      var eventWindows=pointerPlan?.eventWindows||[],interval=typeof ceBridgeCore==='function'?ceBridgeCore()?.interval:null,clock=interval?.parseTimePoint,now=clock?clock(range?.end):null;
      var past=[],ongoingEvents=[];
      var confirmedRows=(committed&&result.ledgerPlan?.next?.eventProgress)||views.filter(v=>v.kind==='eventProgress'&&v.confirmed).at(-1)?.rows;
      var visibleEventIds=new Set(eventWindows.map(row=>row.eventId));
      var boundaryEvents=frCanonBoundaryEventGroups(eventWindows,(confirmedRows||result.eventProgress||pointerPlan?.observedEventProgress||[]).filter(row=>visibleEventIds.has(row.eventId)),now,
        clock||(()=>null),interval?.parseTimePrecision||(()=>null),pointerPlan?.prebuiltUnreachedEventIds||pointerPlan?.ordinaryUnreachedEventIds);
      past=boundaryEvents.past;ongoingEvents=boundaryEvents.ongoing;
      function eventList(label,rows){if(!rows.length)return;var body=el('div','','fr-canon-boundary-events');body.appendChild(el('small',label,''));rows.forEach(function(e,index){var title=String(e.title||'').replace(/\s*\[人物[:：][\s\S]*$/,'').replace(/^\s*【?E-\d+(?:\.\d+)?】?\s*/,'').replace(/^\d{1,4}年[^\s]*\s*/,'').trim();var line=el('div','','fr-canon-boundary-event');line.appendChild(el('span',e.eventId||'','fr-canon-name-chip'));line.appendChild(el('strong',title||'原著事件',''));body.appendChild(line);});boundary.appendChild(body);}
      eventList('本轮经过的年表',past);eventList('当前进行中',ongoingEvents);
      eventList('候选 · 尚未确认开始',boundaryEvents.unstarted);
      // 相关年表：三档都要给出，玩家要能对上「为什么是这一档」。
      // 时间跨度大的轮次（尤其跨年表事件档）可能涉及几十条，必须可折叠，
      // 否则整块会把下面的档位结论挤到看不见。默认收起，只留标题和条数。
      var relatedEvents=(source.events||[]).slice();
      if(relatedEvents.length){
        var evFold=el('details','','fr-canon-event-fold');
        evFold.dataset.recordId=run.id+'-boundary-events';
        evFold.open=expanded.has(evFold.dataset.recordId);
        var evHead=el('summary','','fr-canon-event-fold-head');
        evHead.appendChild(el('span','相关年表 · '+relatedEvents.length+' 条','fr-canon-event-fold-title'));
        evHead.appendChild(el('span','点击展开','fr-canon-event-fold-hint'));
        evFold.appendChild(evHead);
        var evBody=el('div','','fr-canon-event-fold-body');
        relatedEvents.forEach(function(e,index){
          var row=el('p','','fr-canon-group-item');
          row.appendChild(el('span',String(index+1),'fr-canon-group-index'));
          var text=el('span','','fr-canon-group-text');
          text.appendChild(el('strong',eventTitle(e.title||e.text),'fr-canon-group-actor'));
          var span=[e.start||e.startTime,e.end||e.endTime].filter(Boolean).join(' → ');
          if(span)text.appendChild(el('span',span,'fr-canon-group-reason'));
          row.appendChild(text);evBody.appendChild(row);
        });
        evFold.appendChild(evBody);
        // 展开时把提示换成收起，避免还写着「点击展开」。
        evHead.addEventListener('click',function(){evHead.lastChild.textContent=evFold.open?'收起':'点击展开';});
        boundary.appendChild(evFold);
      }
      // 档①：只说清「这一档、涉及谁」，怎么补交给人物补演阶段。
      // 涉及人物可能几十个（跨年表事件档尤其如此），名字标签默认收起，
      // 标题行已经给出人数，展开才铺开名单，避免把档位结论顶出视野。
      if(tierInfo.tier==='crossEvent'){
        var crossActors=(tierInfo.actors||[]);
        var crossFold=el('details','','fr-canon-event-fold');
        crossFold.dataset.recordId=run.id+'-boundary-cross-actors';
        crossFold.open=expanded.has(crossFold.dataset.recordId);
        var crossHead=el('summary','','fr-canon-event-fold-head');
        crossHead.appendChild(el('span','本轮完整补演 · '+crossActors.length+' 人','fr-canon-event-fold-title'));
        crossHead.appendChild(el('span',crossActors.length?'点击展开':'',"fr-canon-event-fold-hint"));
        crossFold.appendChild(crossHead);
        var crossBody=el('div','','fr-canon-event-fold-body');
        if(crossActors.length){
          var chipWrap=el('div','','fr-canon-name-chips');
          crossActors.forEach(function(name){chipWrap.appendChild(el('span',name,'fr-canon-name-chip'));});
          crossBody.appendChild(chipWrap);
          crossBody.appendChild(el('p','包含成品直接落地、修订落地和普通补演。','fr-canon-group-note'));
        } else {
          crossBody.appendChild(el('p','本轮涉及人物尚未确认。','fr-canon-group-note'));
        }
        crossFold.appendChild(crossBody);
        if(crossActors.length)crossHead.addEventListener('click',function(){crossHead.lastChild.textContent=crossFold.open?'收起':'点击展开';});
        boundary.appendChild(crossFold);
      }
      // 档③：默认一句话收工。但破壁优先级高于档位——若有人被真实变异打破走廊，
      // 这些人仍要转完整补演，必须单独点出来，不能笼统说「本轮不补演」。
      else if(tierInfo.tier==='sameEventNoProgress'){
        var brokenRows=(tierInfo.decisions||[]).filter(function(row){return row.canonAdvance==='break';});
        if(brokenRows.length){
          var breakBody=group(boundary,'破壁 · 转完整补演',tierInfo.tone);
          breakBody.appendChild(el('p','本轮原著没有新增推进，但下列人物走廊被真实变异打破，仍要完整补演。','fr-canon-group-note'));
          brokenRows.forEach(function(row,index){
            var line=el('p','','fr-canon-group-item');
            line.appendChild(el('span',String(index+1),'fr-canon-group-index'));
            var text=el('span','','fr-canon-group-text');
            text.appendChild(el('strong',row.name||row.actorRef||'未署名人物','fr-canon-group-actor'));
            var why=[];
            if(row.corridor&&row.corridor.breakReasons&&row.corridor.breakReasons.length)why.push(row.corridor.breakReasons.join('、'));
            if(row.reason)why.push(row.reason);
            text.appendChild(el('span',why.join(' · ')||'走廊被打破','fr-canon-group-reason'));
            line.appendChild(text);breakBody.appendChild(line);
          });
          var quiet=(tierInfo.decisions||[]).length-brokenRows.length;
          breakBody.appendChild(el('p','其余 '+(quiet>0?quiet+' 人':'人物')+'不补演，回普通演化。','fr-canon-group-note'));
        } else if(pointerPlan?.mode==='progress_only'&&pointerPlan?.route==='prebuilt'){
          var progressBody=group(boundary,'本轮仅登记原著进度',tierInfo.tone);
          progressBody.appendChild(el('p','已确认新的里程碑，本轮没有需要追加的人物或世界任务。','fr-canon-group-note'));
        } else {
          var stopBody=group(boundary,'本轮不补演',tierInfo.tone);
          stopBody.appendChild(el('p','同一年表事件内没有产生新的原著要求，补演流程到此结束，人物回到普通演化。','fr-canon-group-note'));
        }
      }
      // 档②：唯一需要逐人细说的档位。
      else {
        searchLine(boundary,retrieval);
        var handled=selection?.excludedStoryEvidence||storyAnalysis?.handled||[];
        var handledNames=handled.length?handled.map(function(item){return item.name+' · '+(item.reason||'由普通变量演化负责');}):((!handled.length&&selection?.excludedStory?.length)?selection.excludedStory:[]);
        if(handledNames.length){var doneBody=group(boundary,'正文已处理','done');handledNames.forEach(function(text,index){item(doneBody,text,index+1);});}
        var influences=(storyAnalysis?.influences||[]).map(function(entry){return '影响 '+entry.name+' · '+(entry.reason||'');})
          .concat((storyAnalysis?.worldEvents||[]).map(function(entry){return '世界影响 · '+(entry.reason||'');}))
          .concat((diff?.mutated||[]).map(function(entry){return '偏离原著 · '+(typeof entry==='string'?entry:[entry.name,entry.actual||entry.reason||entry.original].filter(Boolean).join(' · '));}));
        if(influences.length){var influenceBody=group(boundary,'连带影响与偏离','deviated');influences.forEach(function(text,index){item(influenceBody,text,index+1);});}
        /* ★★ 2026-11-02 玩家定：「小错自己重试，大错修不好才报告，谁错修谁不影响其他人」
         *
         * 上一版把「一个人物数据不合格」从「整轮失败」改成「只剔除这个人」，
         * 但如果面板不显示，这个人就是**静默消失**——比报错更糟。
         *
         * 所以这里必须显式列出来：谁被剔了、为什么、其余人不受影响。
         * 玩家看到的是「5 人正常 + 1 人待重跑」，而不是「6 人里少了一个不知道去哪了」。
         */
        var rejectedActors=(storyAnalysis&&Array.isArray(storyAnalysis.rejectedActors))?storyAnalysis.rejectedActors:[];
        if(rejectedActors.length){
          var rejectBody=group(boundary,'本轮未通过的人物','deviated');
          rejectedActors.forEach(function(entry,index){
            var line=el('p','','fr-canon-group-item');
            line.appendChild(el('span',String(index+1),'fr-canon-group-index'));
            var text=el('span','','fr-canon-group-text');
            text.appendChild(el('strong',String(entry.actorRef||'未署名人物'),'fr-canon-group-actor'));
            text.appendChild(el('span','本轮未通过，其余人物照常推进 · 可单独重跑此人 · '+String(entry.reason||''),'fr-canon-group-reason'));
            line.appendChild(text);
            rejectBody.appendChild(line);
          });
        }
        var gapRows=[];
        var decisions=(tierInfo.decisions||[]).filter(function(row){return row.canonAdvance!=='none';});
        if(decisions.length){
          var fillBody=group(boundary,'本轮要补','todo');
          decisions.forEach(function(row,index){
            var line=el('p','','fr-canon-group-item');
            line.appendChild(el('span',String(index+1),'fr-canon-group-index'));
            var text=el('span','','fr-canon-group-text');
            text.appendChild(el('strong',row.name||row.actorRef||'未署名人物','fr-canon-group-actor'));
            var advanceLabel={push:'增量补演',break:'破壁完整补演',needs_context:'待补资料'}[row.canonAdvance]||row.canonAdvance;
            var reasons=[];
            if(row.requiredInfluences&&row.requiredInfluences.length)reasons.push('本轮新增 '+row.requiredInfluences.join('、'));
            if(row.corridor&&row.corridor.currentStage)reasons.push('当前阶段 '+row.corridor.currentStage);
            if(row.corridor&&row.corridor.intact===false)reasons.push('走廊已被打破');
            if(row.reason)reasons.push(row.reason);
            text.appendChild(el('span',advanceLabel+(reasons.length?' · '+reasons.join(' · '):''),'fr-canon-group-reason'));
            line.appendChild(text);fillBody.appendChild(line);
          });
        }
        var gaps=diff?.perActor || {};
        if(!Object.keys(gaps).length && diff?.missing?.length)gapRows.push(diff.missing.map(function(p){return typeof p==='string'?p:[p.name||p.actor,p.fact||p.point||p.content||p.text].filter(Boolean).join('：');}).join('；'));
        Object.keys(gaps).forEach(function(name){var list=Array.isArray(gaps[name])?gaps[name]:[gaps[name]];gapRows.push(name+' · '+list.join('；'));});
        if(gapRows.length){var gapBody=group(boundary,'需要补演','todo');gapRows.forEach(function(text,index){item(gapBody,text,index+1);});}
        if(!handledNames.length && !influences.length && !gapRows.length && !decisions.length && diff){var okBody=group(boundary,'已核对','done');okBody.appendChild(el('p','人物当前没有待补缺口。','fr-canon-group-note'));}
      }
      function readableFold(id,title,render){var d=el('details');d.dataset.recordId=run.id+id;d.open=expanded.has(d.dataset.recordId);d.appendChild(el('summary',title));boundary.appendChild(d);render(d);}
      if(notes?.notes?.length)readableFold('-material-notes','资料局限说明',function(parent){notes.notes.forEach(function(note){line(parent,'',typeof note==='string'?note:JSON.stringify(note));});});
      if(musts)readableFold('-expected','原著应有进展与判断依据',function(parent){Object.keys(musts).forEach(function(name){var state=musts[name];if(!state||typeof state!=='object')return;line(parent,name,Object.keys(state).filter(function(k){return k!=='依据';}).map(function(k){return k+'：'+(Array.isArray(state[k])?state[k].join('、'):typeof state[k]==='object'?JSON.stringify(state[k]):state[k]);}).join('；'));if(state['依据'])line(parent,'依据',Array.isArray(state['依据'])?state['依据'].join('；'):state['依据']);});});
      // 相关年表已在上方档位条之后单独渲染（可折叠），这里不再重复一遍。
      if(result.backstoryLines?.length)readableFold('-history','过往经历 · '+result.backstoryLines.length+'条 · '+(committed?'已保存':'待本轮落实'),function(parent){result.backstoryLines.forEach(function(row){line(parent,row.name,row.line);});});
      debug(run,boundary,function(req){return /边界|硬事实|终态/.test(req.stageKey||req.stage||'');},'补演边界判定');
      if(dispatch)readableFold('-dispatch','查看本轮撰写安排',function(parent){line(parent,'单独撰写',(dispatch.solo||[]).join('、'));(dispatch.batches||[]).forEach(function(names,i){line(parent,'合写 '+(i+1),names.join('、'));});});
      stageAction(boundary,['正文硬事实提取','人物边界批量判定'],'重跑边界判定');
    }
    var blockMap=new Map();views.filter(function(v){return v.kind==='prose'&& v.block;}).forEach(function(v){blockMap.set(v.block.name,{block:v.block,accepted:v.accepted,reused:v.reused});});
    (result.prose||result.blocks||[]).forEach(function(b){if(b&& b.name)blockMap.set(b.name,{block:b,accepted:true});});
    (run.requests||[]).filter(function(req){return ['生平旧账','人物边界批量判定','人物终态推演','人物视角散文','群像视角散文'].includes(req.stageKey);}).forEach(function(req){String(req.subject||'').split('、').filter(Boolean).forEach(function(name){if(!blockMap.has(name))blockMap.set(name,{block:{name:name,body:''},accepted:false});});});
    if(blockMap.size){var stories=section('人物补演',host);blockMap.forEach(function(value){var b=value.block;
      var card=el('div',undefined,'fr-canon-trace-character');card.dataset.characterName=b.name;stories.appendChild(card);
      var variable=views.filter(function(v){return v.kind==='characters' && v.name===b.name;}).slice(-1)[0];
      var completion=variable?.completion||b.completion,hardMissing=frCanonCompletionMissing(completion),incomplete=completion&&(completion.completed===false||hardMissing.length>0);
      var individuallySaved=final.rolledBack!==true&&variable?.status==='saved'&&variable.body===b.body&&!incomplete;
      card.appendChild(el('h4',b.name));var blockSaved=!incomplete&&(individuallySaved||committed&&(result.prose||result.blocks||[]).some(function(saved){return saved.name===b.name&& saved.body===b.body;}));
      if(value.reused&&!blockSaved)line(card,'保留此前已核验正文',active?'正在复用；完成核对后随本轮保存。':'此前正文仍可阅读。','ce-badge-in');
      line(card,blockSaved?'已保存':value.accepted?'已核验':active?'核验中':'待补正',b.status==='阻断'?(b.reason||'原著进展已受阻'):blockSaved?(individuallySaved?'此人物的状态、物品与生平已保存。':'已随本轮保存。'):value.accepted?'正文已通过核验。':active?'正在核对完成情况。':'本次内容未生效。',blockSaved||value.accepted?'ce-badge-in':'ce-badge-reentry');
      if(completion)line(card,'完整性',incomplete?'本轮未完成'+(hardMissing.length?'：'+hardMissing.map(frCanonCompletionText).join('；'):'，仍需核对落实。'):completion.completed===true?(blockSaved?'已核对完整并保存。':'已核对完整，等待保存。'):'尚未确认完整。',incomplete?'ce-badge-out':'ce-badge-reentry');
      var cultivation=completion?.cultivation||b.completionReview?.cultivation;
      if(cultivation&&typeof cultivation==='object'){var realm=cultivation.realm??cultivation.currentRealm,progress=cultivation.progress??cultivation.currentProgress;if(realm!==undefined||progress!==undefined)line(card,'境界进度',[realm,progress!==undefined?'进度 '+frCanonCompletionText(progress):''].filter(function(v){return v!==undefined&&v!==null&&v!=='';}).join(' · '));}
      var completed=b.declaredWritten||[];if(completed.length)completed.forEach(function(text){line(card,'已完成',text,'ce-badge-in');});else line(card,'',blockSaved?'本轮人物经历已保存。':value.accepted?'正文已核验，等待变量落实。':'人物正文已返回，完成情况尚待核对。');
      var d=el('details');d.dataset.recordId=run.id+'-story-'+b.name;d.open=expanded.has(d.dataset.recordId);d.appendChild(el('summary','阅读补演正文'));var prose=el('div',undefined,'fr-canon-trace-prose');frCanonRenderDiary(prose,b.body||'本次没有返回人物正文。');d.appendChild(prose);card.appendChild(d);
      if(!blockSaved && variable)line(card,'状态更新',variable.status==='preparing'?'正在准备人物状态。':variable.status==='proposed'?'提案已返回，等待校验和保存。':variable.status==='cancelled'?'本次准备已取消，尚未写入。':'本次未完成，请在下方诊断查看具体原因。',variable.status==='error'?'ce-badge-out':'ce-badge-reentry');
      else if(!blockSaved)line(card,'',active?(value.accepted?'人物正文已核验，等待状态准备。':'正文通过核验后再更新人物状态。'):'本次尚未生效，须在本轮继续完成。');
      var ownRequests=(run.requests||[]).filter(function(r){return String(r.subject||'').split('、').includes(b.name);});
      if(ownRequests.length)debug(run,card,function(req){return ownRequests.includes(req);},b.name+' · 人物补演');
      var actorDetails=el('details');actorDetails.dataset.recordId=run.id+'-completion-'+b.name;actorDetails.open=expanded.has(actorDetails.dataset.recordId);actorDetails.appendChild(el('summary','查看事实与落实核对'));card.appendChild(actorDetails);
      details(run.id+'-'+b.name+'-facts','故事事实',b.completionReview?.facts||b.declaredWritten||[],actorDetails);
      details(run.id+'-'+b.name+'-readback','解析与回读结果',{review:b.completionReview,completion:completion,receipt:variable},actorDetails);
      if(Array.isArray(completion?.softNotes))completion.softNotes.forEach(function(note){line(actorDetails,'说明',frCanonCompletionText(note));});
      var originalMaterial=views.filter(function(v){return v.kind==='replayMaterial'&&v.name===b.name;}).slice(-1)[0];
      var req=ownRequests.find(function(r){return ['人物视角散文','群像视角散文'].includes(r.stageKey);})||(originalMaterial?.proseStage?{stageKey:originalMaterial.proseStage}:null);
      if(req)directAction(card,blockSaved?'重跑此人物':'补跑此人物',{scope:req.stageKey+':'+b.name});
      if(incomplete){var variableRequest=ownRequests.find(function(r){return r.stageKey==='characters';}),ids=variableRequest?.targetIds?.length?variableRequest.targetIds:String(variableRequest?.targetId||'').split(','),names=String(variableRequest?.subject||'').split('、'),actorId=variable?.actorId||variable?.id||ids[names.indexOf(b.name)]||b.name;directAction(card,'补齐缺项',{scopes:frCanonCompletionModules(completion).map(function(key){return key+':'+actorId;})});}
    });}
    var world=result.worldBlock?.body||result.worldForMisc||views.filter(function(v){return v.kind==='world';}).slice(-1)[0]?.body;
    var worldNoChanges=result.worldNoChanges||views.filter(function(v){return v.kind==='worldNoChange';}).flatMap(function(v){return v.noChanges||[];});
    if(world || (!worldNoChanges.length && (run.requests||[]).some(function(r){return r.stageKey==='世界事件补演';}))){var wb=section('世界补演',host);line(wb,'正文',world?(committed?'已完成并保存。':'已生成，待本轮落实。'):'本轮世界补演尚未完成。');if(world)details(run.id+'-world-story','阅读世界见闻',world,wb);stageAction(wb,['世界事件补演'],world?'重跑世界补演':'补跑世界补演');}
    if(worldNoChanges.length){
      var worldCheck=section('世界变化核对',host);
      contextBar(worldCheck,'',world?'部分事件未产生新增世界变化':'本轮没有新增世界大事');
      var reasonGroups=new Map();worldNoChanges.forEach(function(row){var reason=String(row.reason||'本条没有新增世界层面的变化。');if(!reasonGroups.has(reason))reasonGroups.set(reason,[]);reasonGroups.get(reason).push(row);});
      var wi=0;reasonGroups.forEach(function(rows,reason){
        var list=el('div',undefined,'fr-canon-world-events');worldCheck.appendChild(list);
        var seen=new Set();rows.forEach(function(row){
          var title=String(row.title||'').replace(/\s*\[人物[:：][\s\S]*$/,'').trim();
          var date=title.match(/^\s*(?:【?E-\d+(?:\.\d+)?】?\s*)?(\d{1,4}年[\d年月日.\-—~至到 ]+)\s*/);
          var code=String(row.eventId||row.code||title.match(/E-\d+(?:\.\d+)?/)?.[0]||'');
          title=eventTitle(title);if(date)title=title.replace(date[1],'').trim();
          var key=code+'|'+title;if(seen.has(key))return;seen.add(key);
          var card=el('div',undefined,'fr-canon-world-event');if(code)card.appendChild(el('span',code,'fr-canon-name-chip'));
          var text=el('div');text.appendChild(el('strong',title||'原著事件'));if(date)text.appendChild(el('small',date[1].trim()));card.appendChild(text);list.appendChild(card);
        });
        var why=fold(worldCheck,run.id+'-world-reason-'+wi++,'判断依据'+(rows.length>1?' · '+rows.length+'条事件':''));why.appendChild(el('p',reason,'fr-canon-result-note'));
        localCopy('复制此项',{events:rows,reason:reason},why,why.dataset.recordId);
      });
      line(worldCheck,committed?'已保存':'已核对',committed?'核对结果已随本轮保存。':'等待本轮保存。','ce-badge-in');
      debug(run,worldCheck,function(req){return req.stageKey==='世界事件补演';},'世界变化核对');
      stageAction(worldCheck,['世界事件补演'],'重新核对世界变化');
    }
    var committedEvent=events.filter(function(e){return e.type==='committed'&& e.data;}).slice(-1)[0];
    var variableStages=(run.requests||[]).filter(function(r){return ['characters','items','misc','tags'].includes(r.stageKey);});
    var savedPeople=new Map(),proposals=new Map(),names={};
    views.filter(function(v){return v.kind==='characters';}).forEach(function(v){var id=v.actorId||v.id||v.name;if(id&&v.status==='saved'&&v.applied)savedPeople.set(id,v);});
    events.filter(function(e){return e.type==='actor_saved'&&e.data?.applied;}).forEach(function(e){var v=e.data,id=v.actorId||v.name;if(id&&!savedPeople.has(id))savedPeople.set(id,v);});
    events.filter(function(e){return e.label==='人物提案与实际推理返回'&&Array.isArray(e.data);}).forEach(function(e){e.data.forEach(function(r){var id=r.target?.id||r.id;if(id){proposals.set(id,r);names[id]=r.target?.name||r.name||id;}});});
    savedPeople.forEach(function(v,id){names[id]=v.name||names[id]||id;});
    if(variableStages.length||savedPeople.size||proposals.size||committedEvent?.data.applied){
      var actions=section('变量落地',host),stageNames={characters:'人物状态',items:'随身物品',misc:'世界与任务',tags:'人物标签'};
      actions.classList.add('fr-canon-updates');
      if(committed||savedPeople.size&&final.rolledBack!==true)line(actions,'已保存',savedPeople.size?'已保存 '+savedPeople.size+' 位人物的变量结果，展开可查看人物状态、物品与生平。':'本轮变量已保存。','ce-badge-in');
      var actors=new Set([...savedPeople.keys(),...proposals.keys()]);
      actors.forEach(function(id){
        var saved=savedPeople.get(id),r=proposals.get(id),revoked=final.rolledBack===true,ap=saved?.applied;
        var state=saved&&!revoked?'已保存':revoked?'已撤销':r?.error||r?.success===false?'未完成':committed?'已保存':'待保存';
        var stateTone=state==='已保存'?'ce-badge-in':state==='未完成'||state==='已撤销'?'ce-badge-out':'ce-badge-reentry';
        // 每个角色一张可折叠卡，默认收起：人多时先看到「谁保存了什么状态」，
        // 想看细节再展开，不必让整页被逐人明细撑开。
        var card=group(actions,names[id]||id,'plain',{recordId:run.id+'-updates-person-'+id,note:state,noteTone:stateTone});
        // group 返回的是内容体；可折叠卡片的根节点是它的父级 <details>。
        // 人物标记直接打在根节点上，样式与 actorId 才能一直跟着这张卡。
        var cardBox=card.parentElement||card;
        cardBox.classList.add('fr-canon-update-person');cardBox.dataset.actorId=id;
        line(card,state,state==='已保存'?'人物状态与本次变化已保存。':state==='已撤销'?'本次结果未生效。':state==='未完成'?'本次未完成，已保留返回结果。':'提案已返回，尚未保存。',stateTone);
        var charDelta=ap?.characterDelta,commands=charDelta?displayCommands(charDelta):r?.commandsString||displayCommands(r?.delta);
        var snapshot={names:names};if(ap?.items?.length)snapshot.lastItemManagementResult={executedOps:ap.items};
        var thinking=commands||r?[Object.assign({},r||{},{id:id,name:names[id]||id,type:r?.target?.type||r?.type||'npc',commandsString:commands,thinkingContent:''})]:[];
        native(card,{thinking:thinking,snapshot:snapshot},run.id+'-updates-'+id);
        var nativeState=card.querySelector('.ce-thinking-character');
        if(nativeState){
          var stateHead=nativeState.querySelector('.ce-thinking-section-header');if(stateHead)stateHead.textContent='人物状态';
          nativeState.querySelectorAll('div').forEach(function(n){if(!n.children.length&&n.textContent==='(无思考内容)')n.remove();});
          var extra=[];nativeState.querySelectorAll('.ce-entry-item').forEach(function(row){var badge=row.querySelector('.ce-entry-badge')?.textContent||'';if(!/^列(?:2|4|16)\(/.test(badge)&&!/^技能|^功法|^气运/.test(badge))extra.push(row);});
          if(extra.length){var more=fold(nativeState,run.id+'-updates-fields-'+id,'更多人物变化 · '+extra.length+'项');extra.forEach(function(row){more.appendChild(row);});}
        }
        if(!thinking.length&&!ap?.items?.length)line(card,'','本次没有记录到具体变量变化。');
        if(ap?.biography&&Object.keys(ap.biography).length)details(run.id+'-updates-bio-'+id,'查看已保存的生平条目',ap.biography,card);
      });
      var ap=committedEvent?.data.applied;
      if(ap&&(ap.items?.length||ap.misc?.length||ap.miscReceipt?.requestedDelta?.length)){
        var global=group(actions,'世界与公共变化','plain');line(global,committed?'已保存':'已撤销',committed?'本轮公共变化已保存。':'本次公共变化未生效。',committed?'ce-badge-in':'ce-badge-out');
        var sharedSnapshot={names:names};if(ap.items?.length)sharedSnapshot.lastItemManagementResult={executedOps:ap.items};
        if(ap.misc?.length||ap.miscReceipt?.requestedDelta?.length)sharedSnapshot.lastMiscEvolutionResult=ap.miscReceipt||{requestedDelta:ap.misc||[]};
        native(global,{snapshot:sharedSnapshot},run.id+'-updates-world');
      }
      // 物品提案先显示待保存，不把返回成功冒充执行成功。已保存人物用上方实际回执。
      if(!committed){
        var pendingItems=new Map();events.filter(function(e){return e.label==='物品提案与实际推理返回'&&e.data;}).forEach(function(e){
          (e.data.operations||[]).forEach(function(op){var owner=op.owner||op.from||op.to||'',key=owner+'|'+(op.type||op.command)+'|'+(op.itemId||op.item?.['0']||'')+'|'+(op.to||'');pendingItems.set(key,op);});
        });
        var unsavedItems=Array.from(pendingItems.values()).filter(function(op){return !savedPeople.has(op.owner||op.from||op.to||'');});
        if(unsavedItems.length){var itemBox=group(actions,'随身物品 · '+(final.rolledBack?'已撤销':'待保存'),'plain');
          line(itemBox,'',final.rolledBack?'以下提案已撤销，未生效。':'以下为尚未保存人物的物品提案，保存后才会生效。','ce-badge-reentry');
          native(itemBox,{proposed:true,snapshot:{names:names,lastItemManagementResult:{executedOps:unsavedItems}}},run.id+'-updates-item-proposal');
        }
      }
      if(!actors.size&&!ap&&!events.some(function(e){return e.label==='物品提案与实际推理返回';}))line(actions,'',active?'正在更新人物状态与随身物品…':'本次尚无可展示的变量结果。');
      var d=debug(run,actions,function(req){return ['characters','items','misc','tags'].includes(req.stageKey);},'变量更新');
      d.dataset.recordId=run.id+'-updates-diagnostics';d.open=expanded.has(d.dataset.recordId);
      details(run.id+'-updates-receipts','实际保存回执',Array.from(savedPeople.values()).concat(ap?[committedEvent.data]:[]),d);
      var controls=el('div',undefined,'fr-canon-update-actions');actions.appendChild(controls);
      Array.from(new Set(variableStages.map(function(r){return r.stageKey;}))).forEach(function(key){stageAction(controls,[key],'重跑'+stageNames[key]);});
    }
    var biographyView=views.filter(function(v){return v.kind==='biographyCompression';}).slice(-1)[0];
    if(biographyView){
      var biographySection=section('生平整理',host),compressed=committedEvent?.data.applied?.biographyCompression;
      var description=biographyView.status==='pending'?'本轮保留完整生平，未压缩；不影响人物与账本保存。':biographyView.status==='not_needed'?'未达到原压缩条件，本轮无需压缩。':biographyView.status==='error'?'本轮未完成：'+biographyView.reason:committed && compressed?'已压缩并保存 '+compressed.updatedIds.length+' 人。':biographyView.status==='prepared'?'压缩已准备，待保存。':'正在按原规则整理生平。';
      line(biographySection,'',description,biographyView.status==='error'?'ce-badge-out':'ce-badge-reentry');
      if(biographyView.names?.length)line(biographySection,'人物',biographyView.names.join('、'));
      stageAction(biographySection,['biography'],'重跑生平整理');
    }
    var eventView=views.filter(function(v){return v.kind==='eventProgress';}).slice(-1)[0],eventRows=[...(eventView?.rows || result.eventProgress || [])];
    var savedVariables=committed?(run._savedEventVariables||views.filter(function(v){return v.kind==='savedEventVariables';}).at(-1)?.rows||[]):[];
    var savedByEvent=new Map();
    for(var entry of savedVariables){
      if(!savedByEvent.has(entry.eventId))savedByEvent.set(entry.eventId,[]);
      savedByEvent.get(entry.eventId).push(entry);
      if(!eventRows.some(row=>row.eventId===entry.eventId))eventRows.push({eventId:entry.eventId,title:entry.title,current:'本轮已有保存记录'});
    }
    if(eventRows.length){var eventSection=section('事件进展',host);
      eventRows.forEach(function(row){var card=el('div',undefined,'fr-canon-trace-character');eventSection.appendChild(card);var title=row.title || row.eventId;
        try{var cleaner=typeof ceBridgeCore==='function'&&ceBridgeCore()['vector-input']?.cleanEventTitle;if(typeof cleaner==='function')title=cleaner(title) || title;}catch(_){}
        card.appendChild(el('h4',eventTitle(title)));var labels={ongoing:'进行中',changed:row.resolved?'变异收尾':'已经变异',blocked:row.resolved?'阻断收尾':'受阻',completed:'实际完成',replaced:'已被替代',expired:'机会已过',cancelled:'已取消'};
        line(card,labels[row.status] || '进展',row.current,'ce-badge-reentry');line(card,'',committed?'进度已随本轮保存。':eventView?.confirmed?'实际故事已核对，待保存。':'边界观察，等待实际推演确认。');
        if(committed){
          var savedRows=savedByEvent.get(row.eventId)||[];
          if(savedRows.length)frCanonRenderSavedEventVariables(card,savedRows);
          else line(card,'','本轮无可按此事件核对的变量明细。');
        }
        (row.advanced || []).forEach(function(text){line(card,'本轮推进',text,'ce-badge-in');});(row.changes || []).forEach(function(text){line(card,'变化',text,'ce-badge-reentry');});
        var d=el('details');d.dataset.recordId=run.id+'-event-'+row.eventId;d.open=expanded.has(d.dataset.recordId);d.appendChild(el('summary','查看事件经过与后续事项'));card.appendChild(d);
        (row.occurred || []).forEach(function(text){line(d,'已发生',text);});(row.pending || []).forEach(function(text){line(d,'尚未发生',text);});if(row.endAt)line(d,'原著参考结束',row.endAt+'；按实际故事判断收尾');line(d,'处理到',row.coveredTo);line(d,'判断依据',row.reason);
      });
      stageAction(eventSection,['世界事件补演'],'重新核对事件进展');
    }
    var ledger=result.ledgerPlan?.next,openEvents=ledger?.openEvents||result.openEvents||[];
    var ledgerView=views.filter(function(v){return v.kind==='ledger';}).slice(-1)[0];
    var progress=section('账本检查',host);
    var ledgerSnapshot=views.filter(function(v){return v.kind==='ledgerSnapshot';}).at(-1)?.ledger;
    if(ledger||ledgerSnapshot)line(progress,'账本视图',ledger?(committed?'本轮已保存账本':'本轮待保存计划'):'本轮开始时读取的已保存账本');
    frCanonRenderLedger(progress,ledger||ledgerSnapshot,run.id,pointerPlan);
    progress.querySelectorAll('details[data-record-id]').forEach(function(d){d.open=expanded.has(d.dataset.recordId);});
    if(ledgerView)line(progress,'账本计划','已整理到 '+ledgerView.worldTime+'；'+(committed?'已随人物和世界变化保存。':active?'等待变量落地和保存。':'本轮落地未完成，未提交进度。'));
    if(ledger)line(progress,'账本更新',committed?'已记到 '+ledger.worldTime:'本轮进度尚未写入存档。');
    if(committed&&ledger){
      var review=ledger.mutationReview;
      if(review?.status==='pending')line(progress,'变异记录待整理',review.reason||'已保存已核验的事件进度，可单独重跑账本。','ce-badge-reentry');
      if(review?.status==='done')line(progress,'已保存','本轮变异记录已整理并保存。','ce-badge-in');
      if(review?.status==='not_needed')line(progress,'已核对','本轮没有需要另行整理的变异，已在本地核对账本。');
      if(ledger.mutationNotes?.length){
        var notes=el('details');notes.dataset.recordId=run.id+'-ledger-mutations';notes.open=expanded.has(notes.dataset.recordId);
        notes.appendChild(el('summary','查看变异记录 · '+ledger.mutationNotes.length+' 条'));
        ledger.mutationNotes.forEach(function(row){line(notes,[row.eventId,row.nodeId].filter(Boolean).join(' · '),row.note);});
        progress.appendChild(notes);
      }
      stageAction(progress,['补演账本'],'重跑补演账本');
    }
    if(!ledger&&!ledgerSnapshot)openEvents.filter(e=>!(pointerPlan?.prebuiltUnreachedEventIds||pointerPlan?.ordinaryUnreachedEventIds||[]).includes(e.eventId)).forEach(function(e){line(progress,'待核对事件',[e.eventId,eventTitle(e.title),e.coveredTo?'核对至 '+e.coveredTo:''].filter(Boolean).join(' · '),'ce-badge-reentry');});
    (result.debts||ledger?.debts||[]).forEach(function(d){line(progress,'待继续处理',[d.name,d.reason||d.detail,Object.entries(d.actors||{}).map(function(pair){return pair[0]+'：'+(Array.isArray(pair[1])?pair[1].join('；'):pair[1]);}).join('；')].filter(Boolean).join('：'),'ce-badge-reentry');});
    if(committed&& ledger?.lastTurn?.wroteNames?.length)line(progress,'本轮已处理',ledger.lastTurn.wroteNames.join('、'));
    (result.openHooks||[]).forEach(function(h){line(progress,'后续线索',h.text||h.title||h.description||h.hook);});
    if(active)line(progress,'',frCanonBubbleText(run)+'…');
    else if(committed)line(progress,'已保存','本轮人物、世界变化与后续进度已保存。','ce-badge-in');
    else if(!final.replayFailure)line(progress,run.status==='cancelled'?'已取消':run.status==='error'?'未完成':'本轮结果',final.rolledBack?'本次重跑已撤销，原结果保留。':final.reason||final.landReason||(final.duplicate?'本轮已有保存结果，没有重复写入。':run.status==='skipped'?'本轮无需新增补演。':'未确认生效；本轮进度未推进。'),'ce-badge-out');
    if(!active&&final.replayFailure)line(progress,'最近重跑未完成',final.replayFailure,'ce-badge-out');
    // 世界与进度失败要说清是哪一批、哪几条事件、为什么，玩家才知道补哪几条。
    // 成功批次已确认的进度不受影响，重跑只补失败的那些。
    (final.failedBatches||[]).forEach(function(row){
      var codes=(row.eventCodes||[]).join('、')||'未返回事件编号';
      var titles=(row.eventTitles||[]).filter(Boolean).join('、');
      line(progress,'未确认进度',[row.stage,(codes?(titles?codes+'（'+titles+'）':codes):''),row.reason].filter(Boolean).join('：'),'ce-badge-out');
    });
    if((final.unconfirmedEvents||[]).length&&!(final.failedBatches||[]).length){
      line(progress,'未确认进度','这些事件本轮未返回进度：'+final.unconfirmedEvents.join('、'),'ce-badge-out');
    }
    if(run.persistError)line(progress,'记录保存失败','游戏结果与记录保存分别处理，请展开下方详情。','ce-badge-out');
    /* ★★★ 2026-11-02 玩家：「账本里的智能重跑应该与局部重跑里的智能重跑
     * 逻辑一致才对。」
     *
     * 完全正确，之前这里是两套东西：
     *   · 局部重跑面板的「智能重跑」→ frReplayRunDirect({smart:true})
     *       → frReplayFailedSelection 自动挑「失败/没返回」的请求项
     *   · 账本这里的「智能重跑」→ frCanonContinueTurn({continueTurn:true})
     *       → mode:'continue' → frReplayContinueSelection 按落地状态接续
     * 名字一样，干的事不一样：玩家点同一个名字，得到两种行为，
     * 而且账本这条还常因为「没有待继续事项」直接报错。
     *
     * 现在统一成**同一条**：都走 frReplayRunDirect 的 smart:true 分支。
     * 「智能重跑」的定义只有一个 —— 自动把出问题的都选上重跑，
     * 谁错补谁，不多跑没出问题的部分。
     *
     * 接续语义（mode:'continue'）并没有被删掉，它退回到自己该在的位置：
     * 只由「继续本轮补演」这类明确表达「接着跑没跑完的」入口使用，
     * 不再挂在「智能重跑」这个名字下面迷惑玩家。 */
    /* ★★★ 2026-11-03 玩家定：
     *   「账本那里也应该叫智能重跑，只是再加一个局部重跑的便捷入口，
     *     所以账本那里应该有两个按钮：
     *     出错了才显示的智能重跑，和常驻显示的局部重跑的便捷入口。」
     *
     * 所以这里分成两个按钮，显示条件不同：
     *   · 智能重跑 → **只有本轮真的出问题时才出现**，替玩家自动挑出失败项重跑
     *   · 局部重跑 → **常驻**，只是个打开面板的便捷入口，不一定有错误
     *
     * 【什么算「出问题了」】按已有字段判断，不新造状态：
     *   ① 运行状态是 error / cancelled / interrupted（中途失败或被中止）
     *   ② 结果明确没落地（landed===false）
     *   ③ 有失败批次 failedBatches，或存在未确认的进度
     *   ④ 上次重跑被撤销（rolledBack）——结果没生效，等于还欠着
     *   ⑤ 已经点过智能重跑但失败了（state.phase==='error'）——要能再试
     * 只要命中一条就显示；都没命中说明本轮是干净的，不拿按钮去干扰玩家。
     *
     * 注意：智能重跑与局部重跑面板里那个「智能重跑」是**同一条实现**
     *       （都走 frReplayRunDirect 的 smart:true → frReplayFailedSelection），
     *       不另写一套判断，避免两处口径再次分叉。
     */
    var hasFailure=!!(
      run.status==='error'||run.status==='cancelled'||run.status==='interrupted'
      ||final.landed===false||final.rolledBack===true
      ||(Array.isArray(final.failedBatches)&&final.failedBatches.length)
      ||(Array.isArray(final.unconfirmedEvents)&&final.unconfirmedEvents.length)
    );
    if(!active&&!hasFailure){
      /* 干净的轮次也可能点过智能重跑但那次失败了 —— 这种情况仍要给出重试入口。 */
      try{
        hasFailure=Object.keys(frCanonDirectActions).some(function(k){
          var s=frCanonDirectActions[k];
          return s&&s.archiveName===run.archiveName&&s.logId===run.logId&&s.selectionKey==='{"smart":true}'&&s.phase==='error';
        });
      }catch(_){}
    }
    // 智能重跑：仅在有问题时出现。
    if(!active&&hasFailure&&typeof frReplayRunDirect==='function')directAction(progress,'智能重跑',{smart:true});
    // 局部重跑：常驻的便捷入口，任何时候都能打开面板自己挑。
    if(typeof frReplayOpenPicker==='function')button('局部重跑',function(){
      // 这只是「打开局部重跑面板」的快捷入口，不是智能重跑。
      frReplayOpenPicker('canon',{runId:run.id}).catch(function(error){line(progress,'未打开',error.message,'ce-badge-out');});
    },progress);
    debug(run,progress);
  });
  previous.filter(function(r){return r.result?.rolledBack===true;}).forEach(function(r){line(container,'重跑已撤销',(r.result.reason||'本次重跑未完成')+'；上次生效结果仍保留。','ce-badge-out');});
  if(previous.length)details(turn.id+'-attempts','较早尝试与诊断',previous.map(function(r){return frCanonTraceExport(r);}),container);
  // 重建完把所有区块的开合状态还原回去 —— 玩家展开的东西不该被后台刷新收走。
  frCanonFoldRestore(container,foldBefore);
  container.scrollTop=scroll;if(container.parentElement&& parentScroll!==undefined)container.parentElement.scrollTop=parentScroll;
}

function frCanonRenderDiary(parent,text,options){
  var opts=options||{};
  /* ★★ 2026-11-02 玩家：「但是段落之间隔开距离并且来点区分度，并且标记最新的段落。
   *   我刚才看错也暴露出ui设计上的不足了，要美观和有质感一点。让玩家一目了然」
   *
   * 原来所有段落都塞进同一个 pre-wrap 容器，只在中间插一个普通 h4 当日期，
   * 结果：段落之间只有行距、没有任何边界，玩家分不清哪里是上一段结束；
   * 而且整段是「一整块」，看不出哪一段是刚生成的最新内容 —— 玩家真的看错了。
   *
   * 现在改成「一段一卡片」：
   *   · 每个日期段独立成一个 .fr-canon-diary-block，有自己的边框和背景，
   *     段与段之间有明确间距，一眼能看出是两段不同的经历；
   *   · 日期做成小徽章（贴在卡片顶部），不再是一行裸字；
   *   · 最后一段加「最新」标记 + 左侧高亮条，玩家一眼知道哪段是刚写出来的；
   *   · 段内正文仍保留原有的换行行为（不再依赖父级 pre-wrap）。
   */
  var lines=String(text || '').split(/\r?\n/);
  // 先按 ### 标题把文本切成 [{label, body[]}]，没标题的部分归到第一段（label 为空）。
  var groups=[],current={label:'',lines:[]};
  lines.forEach(function(line){
    if(/^@@事件[:：]\s*(?:E-\d+(?:\.\d+)?|GAP)\s*$/u.test(line))return;
    var match=line.match(/^###\s+\[([^\]]+)\]\s*$/);
    if(match){
      if(current.label||current.lines.some(function(l){return String(l).trim();}))groups.push(current);
      current={label:match[1].replace('@',' · '),lines:[]};
    }else current.lines.push(line);
  });
  if(current.label||current.lines.some(function(l){return String(l).trim();}))groups.push(current);
  // 去掉每段首尾空行
  groups.forEach(function(group){
    while(group.lines.length&&!String(group.lines[0]).trim())group.lines.shift();
    while(group.lines.length&&!String(group.lines[group.lines.length-1]).trim())group.lines.pop();
  });
  groups=groups.filter(function(group){return group.label||group.lines.length;});
  if(!groups.length)return;

  groups.forEach(function(group,index){
    var isLatest=index===groups.length-1 && !opts.noLatest;
    var block=document.createElement('section');
    block.className='fr-canon-diary-block'+(isLatest?' is-latest':'');
    if(group.label){
      var head=document.createElement('div');
      head.className='fr-canon-diary-date-row';
      var badge=document.createElement('span');
      badge.className='fr-canon-diary-date';
      badge.textContent=group.label;
      head.appendChild(badge);
      if(isLatest){
        var tag=document.createElement('span');
        tag.className='fr-canon-diary-latest';
        tag.textContent='最新';
        head.appendChild(tag);
      }
      block.appendChild(head);
    }else if(isLatest){
      var head2=document.createElement('div');
      head2.className='fr-canon-diary-date-row';
      var tag2=document.createElement('span');
      tag2.className='fr-canon-diary-latest';
      tag2.textContent='最新';
      head2.appendChild(tag2);
      block.appendChild(head2);
    }
    var bodyText=group.lines.join('\n').trim();
    if(bodyText){
      var p=document.createElement('div');
      p.className='fr-canon-diary-body';
      p.textContent=bodyText;
      block.appendChild(p);
    }
    parent.appendChild(block);
  });
}
function frCanonBuildStoryFloors(logs,rows,name,legacyEmptyFloor=''){
  const prose=new Map(rows.filter(row=>row.name===name).map(row=>[String(row.logId),row]));
  const floors=[];
  for(const log of logs){
    if(log?.type!=='ai'||!log.id||log.isGhost||log.isSnapshot||log.isUndoSnapshot||log.isDeepSummary||
       String(log.content||'').includes('<h4>天道初启</h4>'))continue;
    const logId=String(log.id),story=prose.get(logId);
    if(story){floors.push(story);continue;}
    if(!floors.length)continue;
    const empty=log.canonPending?.status==='error'&&!log.canonTurnCommit?'incomplete':
      log.canonStoryTurn==='no_progress'||logId===legacyEmptyFloor?'no_progress':
      log.canonPending&&!log.canonTurnCommit?'incomplete':'no_prose';
    floors.push({logId,empty});
  }
  return floors;
}

async function frCanonOpenStories(){
  var existing=document.getElementById('fr-canon-story-reader');if(existing){existing.focus();return;}
  var archiveName=currentArchiveName,focus=document.activeElement;
  var overlay=document.createElement('div');overlay.id='fr-canon-story-reader';overlay.className='fr-canon-story-reader';overlay.tabIndex=-1;overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','fr-canon-reader-title');
  var panel=document.createElement('div');panel.className='fr-canon-reader-panel';overlay.appendChild(panel);
  function node(tag,text,parent,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;(parent||panel).appendChild(n);return n;}
  var header=node('header',undefined,panel,'fr-canon-reader-header');node('h3','原著人物故事',header).id='fr-canon-reader-title';
  var refresh=node('button','刷新',header);refresh.type='button';var close=node('button','关闭',header);close.type='button';
  var body=node('div',undefined,panel,'fr-canon-reader-body'),nav=node('nav',undefined,body,'fr-canon-reader-people');nav.setAttribute('aria-label','选择原著人物');
  /* ★★★ 2026-11-03 玩家：「原著人物故事都打不开报错了」——截图报
   *   `(parent || panel).appendChild is not a function`。
   *
   * 【根因】上一版插入「世界大事记」时，把原本这一行覆盖掉了：
   *     var content=node('article',undefined,body,'fr-canon-reader-pages');...
   * 于是 content 这个变量从未声明，下面 `node('section',undefined,content,...)`
   * 里的 content 解析成了别的东西（浏览器里是同一个未定义标识符的错误用法），
   * node() 第三个参数不是元素 → (parent||panel).appendChild 直接报错，
   * 整个读者面板打不开。
   *
   * 【教训】插入代码时必须确认被替换的行里有没有**顺带声明的变量**，
   * 不能只看自己新增的那几行。
   */
  var content=node('article',undefined,body,'fr-canon-reader-pages');content.setAttribute('aria-live','polite');
  var selected='__world__',storyFloor='';
  
/* ═══ 世界大事记 ═══
   * 2026-11-02 玩家：「这个世界正文倒也不是不行，现在没有一个显示展示的区域，
   *   可以加上去，也放在原著人物故事里」「可以把这个正文总结归纳成世界大事记」。
   *
   * 【为什么放在这里】世界正文是「世界事件补演」阶段的产出，和人物故事同源同轮；
   * 放在同一个读者面板里，玩家读完人物再顺读世界，动线连续，也不用另开新入口。
   *
   * 【数据来源】不走运行记录（它随重跑变化、还可能被清），直接读存档里的
   * 世界事件变量 —— 那是补演真正落盘的结果，回退快照时也跟着一起回退，
   * 天然满足「资料数据跟着快照行动」。
   */
  var worldPanel=node('section',undefined,content,'fr-canon-world-digest');
  worldPanel.id='fr-canon-world-digest';
  var worldHead=node('header',undefined,worldPanel,'fr-canon-world-digest-head');
  node('h4','世界大事记',worldHead);
  var worldMeta=node('span',undefined,worldHead,'fr-canon-world-digest-meta');
  var worldBodyEl=node('div',undefined,worldPanel,'fr-canon-world-digest-body');
  // 世界大事的权威来源是表5；年表账本记录个人与公共事件的进度，不能整体充当新闻。
  // 旧表内容只折叠展示，不按词表擅自删除或重判；新写入须遵守宏观新闻合同。
  var WORLD_STATUS_LABEL={ongoing:"进行中",completed:"已结束",changed:"已变异",blocked:"受阻",replaced:"已被替代",expired:"已错过",cancelled:"已取消"};
  /* 把一行存档表世界大事规整成大事记条目（来源①：玩家原创剧情）。
   * 列定义是固定的 {0:时间, 1:地点, 2:描述}，老存档还多一个 id。 */
  function worldPlayerEventRow(e){
    if(!e||typeof e!=='object')return null;
    var desc=String(e['2']||'').trim();
    if(!desc)return null;                       // 没描述等于没内容，直接丢
    var time=String(e['0']||'').trim();
    var place=String(e['1']||'').trim();
    return {
      kind:'player',
      id:String(e.id||''),
      title:desc,
      start:time,
      end:'',
      place:place,
      status:'',
      settled:false,                            // 玩家大事没有「收尾」概念，一直是既成事实
      endKnown:false
    };
  }
  /* 时间行文案：这是玩家要的「开放态」的唯一出口，集中在这里，避免各处口径不一。
   *
   *   有起有终            → 「1361年 ~ 1362年」
   *   有起无终、正常推进   → 「1370年 ~ 进行中」
   *   有起无终、已收尾     → 「1350年」（不硬编一个假终点）
   *   有起无终、特殊状态   → 「1401年 ~ 受阻」/「~ 已变异」
   *
   * ★ 2026-11-03 自测抓到：原来这里对非 ongoing 的状态一律写「进行中」，
   *   于是「受阻」那行变成「1401年 ~ 进行中」但徽标写「受阻」，
   *   读起来自相矛盾。状态词本身就是最准的表达，直接用它，
   *   不要用一个笼统的「进行中」去盖。
   */
  function worldEventSpanText(it){
    if(!it.start)return '';
    if(it.endKnown)return it.start+' ~ '+it.end;
    if(it.kind==='player')return it.start;      // 玩家大事只有一个时间点
    if(it.settled)return it.start;
    var label=WORLD_STATUS_LABEL[it.status]||'进行中';
    return it.start+' ~ '+label;
  }
  /* 只有「真的还在正常推进」才算进行中；
   * 受阻/已变异这类有自己状态的，不混进这个计数；
   * 玩家原创大事是既成事实，也不算进行中。 */
  function worldEventIsOngoing(it){
    if(it.kind==='player')return false;
    return !it.settled && (it.status==='ongoing'||!it.status);
  }
  function renderWorldDigest(archive, at){
    worldBodyEl.replaceChildren();
    var items=[], lifecycle=typeof CE_CORE==='object'?CE_CORE['world-events']:null;
    /* ── 来源①：玩家原创剧情的大事（存档表 currentState['5']）── */
    try{
      var raw=(typeof currentState==='object'&&currentState)?currentState['5']:null;
      if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch(_){raw=null;}}
      if(Array.isArray(raw)){
        if(lifecycle)items=lifecycle.projectWorldEvents(raw,at||(typeof ceBridgeReadWorldTime==='function'?ceBridgeReadWorldTime():'')).map(row=>({
          ...row,kind:row.active||row.ended?'world':'player',place:row.scope,
          status:row.active?'ongoing':row.closureKind==='deadline'?'期限届满·结果未确认':row.ended?'completed':'',settled:row.ended,
          end:row.endedAt||row.endsAt,endKnown:row.ended&&Boolean(row.endedAt||row.endsAt)
        }));
        else items=raw.map(worldPlayerEventRow).filter(Boolean);
      }
    }catch(_){}
    // 年表进度含拜师、修炼等个人经历，不能凭 E 编号直接变成世界大事。
    // 原著与原创的公共事件均须经世界阶段判定，写入表5后统一展示；账本仍用于进度指针。
    /* 去重：年表事件按 eventId，玩家事件按 id/标题，避免同一件事被记两遍。 */
    var seen=new Set(),dedup=[];
    items.forEach(function(x){
      var key=x.kind==='canon'?('c:'+x.id):('p:'+(x.id||x.title));
      if(seen.has(key))return;
      seen.add(key);
      dedup.push(x);
    });
    items=dedup;
    /* 排序：先按时间字符串，再按种类 —— 让读者顺着时间线读。
     * 玩家事件与年表事件混排，因为它们在玩家眼里就是同一本大事记。 */
    items.sort(function(a,b){
      if(worldEventIsOngoing(a)!==worldEventIsOngoing(b))return worldEventIsOngoing(a)?-1:1;
      var ta=String(a.start||''),tb=String(b.start||'');
      if(ta!==tb)return ta<tb?-1:1;
      return String(a.title||'').localeCompare(String(b.title||''));
    });
    var {current,history}=lifecycle?lifecycle.splitWorldDigest(items):{
      current:items.filter(worldEventIsOngoing),history:items.filter(it=>!worldEventIsOngoing(it))};
    worldMeta.textContent=current.length+' 项进行中';
    if(!current.length)node('p','当前暂无生效的世界局势或可参与的主线、机缘。',worldBodyEl,'fr-canon-world-digest-empty');
    function renderEntries(entries,parent){
      var list=node('ol',undefined,parent,'fr-canon-world-digest-list');
      entries.forEach(function(it){
      var li=node('li',undefined,list,'fr-canon-world-digest-item');
      li.setAttribute('data-kind',it.kind);
      var top=node('div',undefined,li,'fr-canon-world-digest-item-top');
      /* 时间：统一走 worldEventSpanText，不再各处自己拼，避免口径打架。 */
      var span=worldEventSpanText(it);
      if(span)node('time',span,top,'fr-canon-world-digest-time');
      var newsText=String(it.title||'').trim();
      var shortText=newsText.length>120?newsText.slice(0,120)+'…':newsText;
      node('strong',shortText,top,'fr-canon-world-digest-title');
      if(newsText.length>120){
        var legacyDetail=node('details',undefined,li,'fr-canon-world-digest-full');
        node('summary','查看完整记录',legacyDetail);
        node('p',newsText,legacyDetail,'fr-canon-world-digest-desc');
      }
      // 表5同时包含原创与原著补演写入，不能一律误标为“原创”。
      if(it.kind==='player')node('span','已登记',top,'fr-canon-world-digest-badge is-player');
      if(it.place)node('span',it.place,top,'fr-canon-world-digest-place');
      /* 进行中由时间行已经说了「~ 进行中」，就不再加一个同义徽标；
       * 其余状态（已结束/已变异/受阻/已错过…）才上徽标。 */
      if(it.status&&it.status!=='ongoing'){
        node('span',WORLD_STATUS_LABEL[it.status]||it.status,top,'fr-canon-world-digest-badge is-'+(it.status||''));
      }
      /* 当前进展 / 已发生 / 尚未发生：让玩家知道这件大事走到哪一步了。 */
      var desc=[];
      if(it.description&&it.description!==it.title)desc.push(it.description);
      if(it.effect)desc.push((it.active?'当前影响：':it.closureKind==='deadline'?'最近已知影响：':'结案影响：')+it.effect);
      if(it.eventCategory)desc.push('事件类别：'+it.eventCategory);
      if(it.expiresAt)desc.push('当前窗口截止：'+it.expiresAt);
      if(it.lifecycleReviewNeeded)desc.push('待下一轮依据资料与因果复核分类或时间，不丢弃原历史。');
      if(it.active&&it.estimatedEnd)desc.push('预计结束：'+it.estimatedEnd);
      if(it.active&&it.endsAt)desc.push('确定结束时间：'+it.endsAt);
      if(it.active&&it.endCondition)desc.push('结束条件：'+it.endCondition);
      if(it.current)desc.push(it.current);
      if(it.occurred&&it.occurred.length)desc.push('已发生：'+it.occurred.join('；'));
      if(it.pending&&it.pending.length)desc.push('尚未发生：'+it.pending.join('；'));
      for(const detail of desc)node('p',detail,li,'fr-canon-world-digest-desc');
      });
    }
    if(current.length)renderEntries(current,worldBodyEl);
    if(history.length){
      var archiveDetails=node('details',undefined,worldBodyEl,'fr-canon-world-digest-history');
      node('summary','历史大事 · '+history.length+' 项',archiveDetails);
      renderEntries(history,archiveDetails);
    }
  }
  function dismiss(){overlay.remove();if(focus && focus.isConnected)focus.focus();}
  close.addEventListener('click',dismiss);overlay.addEventListener('click',function(e){if(e.target===overlay)dismiss();});
  overlay.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();dismiss();}if(e.key==='Tab'){var items=Array.from(panel.querySelectorAll('button:not([disabled])'));if(!items.length)return;var first=items[0],last=items[items.length-1];if(e.shiftKey && (document.activeElement===first || document.activeElement===overlay)){e.preventDefault();last.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}}});
  async function load(){
    if(currentArchiveName!==archiveName){dismiss();return;}refresh.disabled=true;
    try{
      var archive=archiveName && typeof db!=='undefined' && db.archives?await db.archives.get(archiveName):null;
      if(currentArchiveName!==archiveName){dismiss();return;}
      /* 拿到存档就立刻填充楼层号缓存，让 floorLabel() 能现算「第 N 层」。
       * 2026-11-02 玩家：「原著人物故事还是显示第三层」——
       * 原来这里算楼层号靠 window.__frFloorDisplayMap，那份映射只有打开人生快照
       * 面板时才生成，所以永远取不到，只能退回 logs 真实下标，把隐藏记录数进去，
       * 于是快照是第 2 层、故事显示第 3 层。现在用这份存档现算，口径统一。 */
      if(archive&&archive.data&&Array.isArray(archive.data.logs))frCanonFloorCacheSet(archiveName,archive.data.logs);
      var rows=[],index=new Map();
      // 去重键只用「轮次 + 人物」，绝不能把正文内容算进去。
      // 单人局部重跑会重写同一人物的正文，旧正文仍留在更早的 run 记录里；
      // 按内容去重就会把同一个人同一轮的两份正文都显示出来。
      // 同一轮同一人物以「后到的」为准：局部重跑刚产生的正文比存档里的旧正文新。
      function add(block,logId,saved){
        if(!block?.name || !block.body)return;
        var key=String(logId)+'|'+block.name,at=index.get(key);
        if(at===undefined){index.set(key,rows.length);rows.push({name:block.name,body:block.body,saved:saved,logId:logId});return;}
        // 后到者覆盖：调用顺序是「先存档、后运行记录」，运行记录里的正文更新。
        // 局部重跑后存档里的旧正文必须被新正文替换，不能因为旧正文带 saved 标记就压住新的。
        rows[at]={name:block.name,body:block.body,saved:saved||rows[at].saved,logId:logId};
      }
      (archive?.data?.logs || []).forEach(function(log){
        const committed=log.canonSupplement?.blocks||[];
        for(const block of committed)add(block,log.id,true);
        for(const receipt of Object.values(log.canonPrebuiltProse||{}))
          if(receipt.status==='saved'&&!committed.some(block=>block.name===receipt.block?.name))add(receipt.block,log.id,true);
      });
      frCanonTraceTurns().forEach(function(turn){turn.runs.filter(function(run){return run.phase==='正文后补演' && !run.result?.rolledBack && !run.branchHidden;}).forEach(function(run){(run.result?.prose || []).forEach(function(block){add(block,run.logId,run.result?.landed===true);});(run.events || []).filter(function(e){return e.type==='view' && e.data?.kind==='prose' && e.data.accepted===true;}).forEach(function(e){add(e.data.block,run.logId,run.result?.landed===true);});});});
      // 人物导航与空态在下面 floorOrder 过滤之后统一处理（见 namesAfterFilter）。

      /* ★★★ 2026-11-02 玩家：「原著人物小故事分回合，反而要类似我本来要求的原著补演那样，
       *   分上一层下一层的回合，显示最新回合，重roll哪一层就替换覆盖哪一个回合，
       *   这样玩家就不用翻找当前最新回合的内容。其他逻辑不变。」
       *
       * 原来 show(name) 把这个人**所有回合**的正文一次性堆在下面，
       * 回合越攒越多，玩家要往下翻才知道哪段是当前的。
       *
       * 现在按回合分组，默认只显示**最新回合**，顶部给「上一回合 / 下一回合」翻页。
       * 重roll 同一层时，因为 rows 的去重键是「楼层 + 人物」，
       * 新正文会直接覆盖该楼层那一条（见上面 add()），不会多出一个回合——
       * 所以「重roll哪一层就替换覆盖哪一个回合」是自动成立的。
       *
       * 「其他逻辑不变」：人物导航、存档/运行记录合并、局部重跑后到者覆盖，全部保留。
       */
      // 本人物出现过的楼层，按时间先后排序（rows 的写入顺序是「先存档、后运行记录」，
      // 但楼层顺序要以 logId 在存档 logs 里的位置为准，才和玩家看到的回合顺序一致）。
      var floorOrder=(archive?.data?.logs || []).map(function(log){return String(log.id);});
      var floorTime={};
      (archive?.data?.logs || []).forEach(function(log){floorTime[String(log.id)]=log.createdAt||log.updatedAt||0;});
      /* ★★ 2026-11-02 玩家：「这些也是要跟着快照一起回退的」
       *
       * rows 只做「楼层 + 人物」去重，**只要运行记录里还留着这段正文就显示**。
       * 问题是观测记录（frCanonTraceHistory）跟存档 logs 是两套东西：
       * 回退快照之后，logs 里那一层已经没了，但运行记录还在内存/库里，
       * 于是读者面板仍然能翻到「一层已经不存在」的正文，楼层号也对不上。
       *
       * 这里按存档 logs 做一次收敛：**楼层已经不在存档里的正文，一律不展示**。
       * 判据就是 floorOrder（当前存档真实楼层序列），它随快照回退自然变化，
       * 所以「跟着快照一起回退」是自动成立的，不需要另写一套回退钩子。
       *
       * ★ 注意位置：这段必须在 floorOrder 赋值**之后**。
       * 上一版把它写在 floorOrder 声明前面，var 提升拿到的是 undefined，
       * 一开面板就炸 `Cannot read properties of undefined (reading 'indexOf')`。
       */
      rows=rows.filter(function(row){
        if(!row.logId)return false;
        return floorOrder.indexOf(String(row.logId))>=0;
      });
      // 过滤后重新建人物导航：某些人物可能只剩已被回退的楼层，要一起消失。
      var namesAfterFilter=Array.from(new Set(rows.map(function(row){return row.name;})));
      nav.replaceChildren();
      var worldNav=node('button','世界大事记',nav,'fr-canon-reader-world-nav');worldNav.type='button';
      function showWorld(){
        selected='__world__';content.replaceChildren(worldPanel);renderWorldDigest(archive);content.scrollTop=0;
        Array.from(nav.querySelectorAll('button')).forEach(function(b){var active=b===worldNav;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
      }
      worldNav.addEventListener('click',showWorld);
      if(!namesAfterFilter.length){
        showWorld();node('span','暂无人物故事',nav,'fr-canon-reader-empty');
        return;
      }
      if(selected!=='__world__'&&!namesAfterFilter.includes(selected))selected='__world__';
      /* ★★ 2026-11-02 玩家：「当前应该是第二层快照，为什么原著人物故事显示第三层？」
       *
       * 原因：两个地方各算各的楼层号，口径不一致。
       *   · 人生快照面板（main.js floorDisplayMap）会跳过 isSnapshot / isUndoSnapshot，
       *     深度合并层还按 mergedCount 记成「第 N-M 层」，编号是**虚拟楼层号**；
       *   · 原著人物故事这里原来直接用 floorOrder.indexOf(logId)+1，
       *     那是 logs 数组的**真实下标**，把隐藏记录也数进去了。
       * 存档里只要存在快照/撤销类隐藏记录，两边的数字就差一位 ——
       * 玩家看到的正是「快照是第 2 层，故事却写第 3 层」。
       *
       * 现在统一口径：优先调用 window.frFloorLabelOf（它拿传进来的存档**现算**，
       * 算法与人生快照面板完全一致：跳过 isSnapshot/isUndoSnapshot、
       * 深度合并按 mergedCount 记成「第 N-M 层」），拿不到再退回真实下标。
       * 这样「人生快照」「原著人物故事」「补演面板」「局部重跑面板」四处
       * 显示的都是同一个楼层号。
       *
       * ★ 上一版为什么没生效：只读 window.__frFloorDisplayMap，
       *   而那份映射是打开人生快照面板时才建立的。补演面板/人物故事平时先开，
       *   那时 window 上根本没有这份映射，于是永远走真实下标那条退路，
       *   楼层号自然还是错一位。所以必须现算，不能依赖谁先跑过。
       */
      var floorLabelMap = (typeof window !== 'undefined' && window.__frFloorDisplayMap instanceof Map)
        ? window.__frFloorDisplayMap : null;
      var liveArchive = archive || (typeof frCanonTraceArchive === 'object' ? frCanonTraceArchive : null);
      function floorLabel(logId){
        var key=String(logId || '');
        var at=floorOrder.indexOf(key);
        var t=floorTime[key];
        var timeText=t?new Date(t).toLocaleString():'';
        /* ① 现算（首选，纯函数，不依赖任何人先跑过） */
        if(at>=0){
          var computed=frFloorLabelSync(key,liveArchive);
          if(computed)return timeText?(computed+' · '+timeText):computed;
        }
        /* ② 宿主已经算好的那份映射（兜底） */
        if(at>=0&&floorLabelMap&&floorLabelMap.has(key)){
          var mapped=floorLabelMap.get(key);
          var mappedText=mapped&&mapped.displayText?String(mapped.displayText):'';
          if(mappedText)return timeText?(mappedText+' · '+timeText):mappedText;
        }
        /* ③ 最后才用真实下标（会数进隐藏记录，可能差一位） */
        var seq=at>=0?(at+1):0;
        if(seq)return timeText?('第 '+seq+' 层 · '+timeText):('第 '+seq+' 层');
        // 不在存档里：说明该楼层已被回退/删除，这不是一个可指着看的楼层。
        return timeText?('已回退楼层 · '+timeText):'已回退楼层';
      }
      const logs=archive?.data?.logs||[];
      const currentId=frCanonCurrentDisplayFloor(logs);
      const currentLog=logs.find(log=>String(log.id)===currentId);
      let legacyEmptyFloor='';
      if(currentLog&&!currentLog.canonStoryTurn&&currentLog.canonPending?.status!=='error'&&!rows.some(row=>String(row.logId)===currentId)&&
         typeof frCanonBoundaryLoad==='function'){
        const boundary=await frCanonBoundaryLoad(archiveName,currentId,'canon');
        if(boundary?.ok&&(boundary.turnPlan?.turnAdvanceTier||boundary.storyAnalysis?.turnAdvanceTier)==='sameEventNoProgress'&&
           !boundary.turnPlan?.canonJobs?.length&&!boundary.turnPlan?.deferredRefs?.length&&!boundary.storyAnalysis?.worldEvents?.length){
          legacyEmptyFloor=currentId;
        }
      }
      if(currentArchiveName!==archiveName){dismiss();return;}
      function show(name){
        // 世界新闻与人物故事是互斥页面，人物页不再重复新闻。
        selected=name;content.replaceChildren();
        node('h2',name,content);
        Array.from(nav.querySelectorAll('button')).forEach(function(b){var active=b.textContent===name;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
        var floors=frCanonBuildStoryFloors(logs,rows,name,legacyEmptyFloor);
        if(!floors.length){node('p','暂无该人物的正文。',content);content.scrollTop=0;return;}
        // 选中楼层不存在（换了人物/换了存档）就回落到最新回合。
        var at=floors.findIndex(function(row){return String(row.logId||'')===storyFloor;});
        if(at<0)at=floors.length-1;
        /* ★ 2026-11-02：楼层号必须**始终**显示，不能只在多回合时才出现。
         * 原来整条回合栏（含楼层号）都裹在 if(floors.length>1) 里，
         * 结果单楼层人物的正文根本看不到自己属于哪一层 —— 玩家要的
         * 「楼层编号直接对应实际快照楼层」就落空了。
         * 现在拆开：楼层号常驻；翻页按钮只在多于一个回合时出现。 */
        var bar=node('div',undefined,content,'fr-canon-story-turnbar');
        node('span',(at===floors.length-1?'最新回合':'第 '+(at+1)+' / '+floors.length+' 回合')+' · '+floorLabel(floors[at].logId),bar,'fr-canon-story-turnlabel');
        if(floors.length>1){
          var prev=node('button','上一回合',bar);prev.type='button';prev.disabled=at<=0;
          prev.addEventListener('click',function(){storyFloor=String(floors[at-1].logId||'');show(name);});
          var next=node('button','下一回合',bar);next.type='button';next.disabled=at>=floors.length-1;
          next.addEventListener('click',function(){storyFloor=at+1===floors.length-1?'':String(floors[at+1].logId||'');show(name);});
          // 翻页按钮顺序：上一回合 · 标签 · 下一回合
          bar.insertBefore(prev,bar.firstChild);
        }
        var row=floors[at];
        var chapter=node('section',undefined,content,'fr-canon-reader-chapter');
        if(row.empty){
          node('p',row.empty==='no_progress'?'本轮无实质故事进展。':
            row.empty==='incomplete'?'本轮原著补演尚未完成。':'本轮暂无该人物的视角正文。',chapter);
          content.scrollTop=0;
          return;
        }
        node('small',row.saved?'已随当前存档保存':'本轮正文已核验 · 变量待落实',chapter);
        // 段落卡片自己带边框/背景/间距（见 .fr-canon-diary-block），
        // 外层不再套 fr-canon-trace-prose —— 那会给整块加 pre-wrap 和行高，
        // 把卡片之间的间距和日期徽章的排版一起压扁。
        var prose=node('div',undefined,chapter,'fr-canon-diary');
        // 「最新」= 这一层里**最后一个日期段**；若整层不是最新楼层，
        // 用 noLatest 明确不标，避免玩家把旧楼层的末段误读成本轮新写的。
        frCanonRenderDiary(prose,row.body,{noLatest:at!==floors.length-1});
        content.scrollTop=0;
      }
      namesAfterFilter.forEach(function(name){var b=node('button',name,nav);b.type='button';b.addEventListener('click',function(){storyFloor='';show(name);});});
      if(selected==='__world__')showWorld();else show(selected);
    }catch(error){content.replaceChildren();node('p','故事读取失败：'+error.message,content);}finally{refresh.disabled=false;}
  }
  refresh.addEventListener('click',load);document.body.appendChild(overlay);close.focus();await load();
}
async function frCanonOpenTrace() {
  await frCanonTraceLoad();frCanonTraceRender();
  var popup=document.getElementById('thinking-log-popup');if(popup)popup.classList.remove('hidden');
  if(typeof switchThinkingLogTab==='function')switchThinkingLogTab('canon');
}
function frCanonBindSettings(overlay) {
  var get=function(id){return overlay.querySelector('#'+id);};
  // 本层照常处理控件默认行为与关闭委托，仅隔开宿主的正文外点监听。
  ['click','mousedown','pointerdown'].forEach(function(type){overlay.addEventListener(type,function(event){event.stopPropagation();});});
  var panel=ceBridgeCore()['settings-panel'];
  var sections=panel.CE_PANEL_SECTIONS;
  function section(key){Object.keys(sections).forEach(function(k){var n=get(sections[k]);if(n)n.hidden=k!==key;});overlay.querySelectorAll('[data-ce-canon-section]').forEach(function(b){var active=b.dataset.ceCanonSection===key;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
  overlay.querySelectorAll('[data-ce-canon-section]').forEach(function(b){b.addEventListener('click',function(){section(b.dataset.ceCanonSection);});});section('basic');
  var mode=get('ce-canon-api-mode');
  function syncMode(){get('ce-canon-custom-api').hidden=mode.value!=='custom';get('ce-canon-inherited-api').hidden=mode.value==='custom';}
  mode.addEventListener('change',syncMode);syncMode();
  if(typeof loadConcurrentEvolutionConfig==='function')loadConcurrentEvolutionConfig().then(function(c){get('ce-canon-inherited-api').textContent=c.apiModel?'当前沿用模型：'+c.apiModel+'。专用接口字段不写入该配置。':'变量演化尚未选择模型，请先配置变量演化，或改用独立接口。';}).catch(function(e){get('ce-canon-inherited-api').textContent='读取接口失败：'+e.message;});
  if(typeof frHydrateLibraryConfig==='function' && typeof ceBridgeLastConfig==='object')frHydrateLibraryConfig('CULTIVATION_CANON_BRIDGE_CONFIG_V1',ceBridgeLastConfig);
  get('ce-canon-key-toggle').addEventListener('click',function(){var field=get('ce-canon-api-key');field.type=field.type==='password'?'text':'password';this.textContent=field.type==='password'?'显示':'隐藏';});
  get('ce-canon-model-manual').addEventListener('change',function(){get('ce-canon-api-model-custom').hidden=!this.checked;get('ce-canon-api-model').disabled=this.checked;});
  get('ce-canon-fetch-models').addEventListener('click',async function(){
    var btn=this,select=get('ce-canon-api-model'),previous=select.value,feedback=get('ce-canon-model-feedback');
    feedback.textContent='正在获取模型列表…';
    try {
      if(typeof fetchModelsForPanel!=='function')throw new Error('原卡模型列表功能不可用');
      var models=await fetchModelsForPanel('ce-canon-api-url','ce-canon-api-key','ce-canon-api-model',btn,{persistToActivePreset:false,onFeedback:function(text){feedback.textContent=text;}});
      if(Array.isArray(models)&& models.length){if(models.includes(previous))select.value=previous;get('ce-canon-model-manual').checked=false;get('ce-canon-api-model-custom').hidden=true;select.disabled=false;}
      else {select.replaceChildren();var option=document.createElement('option');option.value=previous;option.textContent=previous||'未选择模型';select.appendChild(option);}
    }catch(e){feedback.textContent='获取失败：'+e.message+'。可检查接口或手动指定模型。';}
  });
  get('ce-canon-open-trace').addEventListener('click',function(){ceBridgeCloseSettings();frCanonOpenTrace();});

  overlay.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();ceBridgeCloseSettings();}});
  get('ce-canon-api-mode').focus();
}

function frCanonStopAll(scope){
  var all=scope==='all',reason=Object.assign(new Error('玩家已停止原著补演'),{name:'AbortError',code:'FR_USER_STOP'});
  var abort=function(controller){try{if(controller&&!controller.signal.aborted)controller.abort(reason);}catch(_){}};
  // 停止补演只作用于自己的会话。锁和登记由持有者在 finally 释放，
  // 否则取消尚未完成回滚时，新任务可能提前写入同一存档。
  for(var item of (Array.isArray(window.__frStopControllers)?window.__frStopControllers.slice():[])){
    if(all||item.system!=='ce')abort(item.controller||item);
  }
  for(var system of (all?['canon','ce']:['canon'])){
    if(typeof frReplayDirectTasksBySystem==='object')abort(frReplayDirectTasksBySystem?.[system]?.controller);
    if(typeof frReplaySessionsBySystem==='object')abort(frReplaySessionsBySystem?.[system]?.controller);
  }
  if(typeof frCanonEarlyCurrent!=='undefined'&&frCanonEarlyCurrent?.archiveName===currentArchiveName){
    abort(frCanonEarlyCurrent.controller);
    if(typeof frCancelCanonEarlyPreparation==='function')frCancelCanonEarlyPreparation(frCanonEarlyCurrent);
  }
  if(frCanonMaterialBusy?._controller)abort(frCanonMaterialBusy._controller);
  var runs=new Set(frCanonTraceHistory);if(frCanonTraceActive)runs.add(frCanonTraceActive);
  runs.forEach(function(run){if(run.archiveName!==currentArchiveName||run.phase==='变量演化')return;abort(run._controller);if(run.status==='running'){frCanonTraceEvent(run,'cancel-requested','玩家已停止原著补演');if(typeof ceBridgeCloseStatus==='function')ceBridgeCloseStatus(run);}});
  /* frCanonRefreshSidebar 第 2417 行会把停止按钮重新启用，但它只在「有活跃 run」时
   * 才把状态写成「运行中」。停止之后要让侧栏立刻反映「已停止」，
   * 不能因为内存记录被清空就退回「就绪」让玩家以为没停下。 */
  var node=document.getElementById('fr-canon-sidebar-status');if(node)node.textContent='已停止 · 已完成结果保留';
  frCanonTraceRenderSoon();
}
/* 登记一个在飞的 AbortController，供 frCanonStopAll 无差别停止。
 * 返回的 release 必须由调用方在 finally 里调用，否则会越积越多。 */
function frCanonTrackStop(controller,system){
  if(typeof window==='undefined'||!controller)return function(){};
  if(!Array.isArray(window.__frStopControllers))window.__frStopControllers=[];
  var item={controller:controller,system:system==='ce'?'ce':'canon',at:Date.now()};
  window.__frStopControllers.push(item);
  return function(){
    try{
      var idx=window.__frStopControllers.indexOf(item);
      if(idx>=0)window.__frStopControllers.splice(idx,1);
    }catch(_){}
  };
}
function frCanonRefreshSidebar(){
  var node=document.getElementById('fr-canon-sidebar-status');if(!node)return;
  var run=frCanonTraceActive&& frCanonTraceActive.phase!=='变量演化'&& frCanonTraceActive.archiveName===currentArchiveName?frCanonTraceActive:null;
  /* ★★★ 2026-11-03 玩家：「是显示问题，实际上我能够重roll正文了。」
   *
   * 停止其实已经生效了——日志里有实证：
   *   [补演诊断·ABORT] reason=AbortError/玩家已停止原著补演 code=FR_USER_STOP
   * 但侧栏仍停在「运行中·<阶段名>」，玩家以为没停下来。
   *
   * 【根因】frCanonStopAll 先 abort 再把状态写成「已停止」，
   * 可随后 frCanonRefreshSidebar 又跑一遍，它只看 run.status==='running'，
   * 而中止那一刻 run.status 往往还没来得及被改写（要等 Promise 链条走完），
   * 于是这里又把「运行中」写回去，把「已停止」覆盖掉。
   *
   * 【修法】判断「是否还在跑」不能只看 status，还要看 controller 的信号。
   * 只要 signal 已经 aborted，这一轮就是停了，状态必须显示已停止。
   */
  var aborted=!!(run&&((run._controller&&run._controller.signal&&run._controller.signal.aborted)||run.status==='cancelled'));
  var active=!!(run&& run.status==='running'&& !aborted);
  var disabled=typeof ceBridgeLastConfig==='object'&& ceBridgeLastConfig&& ceBridgeLastConfig.enabled===false;
  node.textContent=aborted?'已停止 · 已完成结果保留':active?frCanonBubbleText(run):run?frCanonTraceStatusLabel(run.status)+' · '+run.currentStage:disabled?'已关闭 · 可在设置中启用':'就绪 · 等待下一轮';
  /* ★ 停止按钮的可点性保持原样（无条件下发 false）。
   *
   * 不要改成 `!active` 之类"没在跑就置灰"的写法：
   * 重跑走的不是 frCanonTraceBegin 那条 trace 路径，frCanonTraceActive 有可能
   * 不指向正在跑的那一次。一旦按 active 置灰，就会出现"正在跑但按钮是灰的"，
   * 那正是玩家反复报的"无法停止"。宁可让它在空闲时仍可点（点了也无副作用），
   * 也不能让它在真正需要停止时点不动。 */
  var stop=document.querySelector('[data-fr-canon-action="stop"]');if(stop)stop.disabled=false;
  var check=document.querySelector('[data-fr-canon-action="check"]');if(check)check.disabled=active;
}
async function frCanonCheckResources(){
  if(frCanonTraceActive&& frCanonTraceActive.archiveName===currentArchiveName&& frCanonTraceActive.status==='running')return;
  await frCanonTraceLoad();var run=frCanonTraceBegin('资料自检');
  try{
    var own=await ceBridgeLoadConfig();
    var timeline=await loadWorldEvolutionTimelineConfig();
    frCanonTraceEvent(run,'material','年表资料',{entries:Array.isArray(timeline.entries)?timeline.entries.length:0,worldTime:ceBridgeReadWorldTime()});
    var api=await ceBridgeGetApiConfigs();
    frCanonTraceEvent(run,'material','接口检查（未发送请求）',{mode:own.api&& own.api.apiUrl?'独立接口':'沿用变量演化',available:api.length>0,models:api.map(function(c){return c.apiModel;})});
    var preset=await getActiveConcurrentEvolutionPreset();
    var services={characters:typeof executeConcurrentRequests==='function',items:typeof requestItemManagementPhase==='function',world:typeof requestMiscEvolutionPhase==='function',save:typeof frCommitCanonProposal==='function'};
    frCanonTraceEvent(run,'material','原卡执行服务',{services:services,presetId:preset&& preset.id,prompts:Object.keys(preset&& preset.prompts||{})});
    run._controller.signal.throwIfAborted();
    var ok=api.length>0&& Object.values(services).every(Boolean)&&!!preset;
    await frCanonTraceFinish(run,ok?'done':'error',{readOnly:true,modelCalls:0,ok:ok,reason:ok?'配置检查完成；不等同于真实接口生成测试通过。':'接口、预设或执行服务不完整，请查看上方检查项。'});
  }catch(error){await frCanonTraceFinish(run,run._controller.signal.aborted?'cancelled':'error',{readOnly:true,reason:String(error.message||error)});}
  finally{if(typeof ceBridgeCloseStatus==='function')ceBridgeCloseStatus(run);}
  await frCanonOpenTrace();
}
function frCanonInitUI(){
  if(!document.getElementById('fr-canon-observability-style')){
    var style=document.createElement('style');style.id='fr-canon-observability-style';style.textContent=`
.fr-canon-world-events{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px;margin:14px 0 6px}.fr-canon-world-event{display:flex;align-items:flex-start;gap:10px;padding:13px 14px;border:1px solid rgba(140,120,83,.24);border-radius:9px;background:rgba(140,120,83,.07);min-width:0}.fr-canon-world-event>div{min-width:0}.fr-canon-world-event strong{display:block;font-size:14px;line-height:1.6;color:var(--text-primary,#e0dccf);overflow-wrap:anywhere}.fr-canon-world-event small{display:block;margin-top:4px;font-size:11px;line-height:1.65;color:var(--text-secondary,#aaa);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.fr-canon-trace details.fr-canon-result-fold{margin:10px 0;padding:10px 13px;border:1px solid rgba(140,120,83,.2);border-radius:8px;background:rgba(0,0,0,.09);min-width:0}.fr-canon-trace .fr-canon-result-fold>summary{cursor:pointer;color:var(--concurrent-evo-accent-text,#d5bc83);font-size:13px;line-height:1.7;min-height:24px}.fr-canon-result-note{line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text-secondary,#b8b2a4);font-size:13px}.fr-canon-updates .fr-canon-group{margin-top:14px}.fr-canon-update-person .fr-canon-group-title{font-size:15px;padding:12px 16px}.fr-canon-group-collapsible>summary.fr-canon-group-title{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;min-height:44px}.fr-canon-group-collapsible>summary.fr-canon-group-title::-webkit-details-marker{display:none}.fr-canon-group-collapsible>summary.fr-canon-group-title::before{content:'▸';flex:0 0 auto;font-size:12px;line-height:1;color:var(--text-secondary,#b8b2a4);transition:transform .16s ease}.fr-canon-group-collapsible[open]>summary.fr-canon-group-title::before{transform:rotate(90deg)}.fr-canon-group-title-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.fr-canon-group-note{flex:0 0 auto;font-size:12px;line-height:1.5;padding:2px 9px;border-radius:999px;border:1px solid rgba(140,120,83,.35);color:var(--text-secondary,#b8b2a4);white-space:nowrap}.fr-canon-group-note.ce-badge-in{border-color:rgba(96,168,110,.45);color:#8fce9c}.fr-canon-group-note.ce-badge-out{border-color:rgba(196,104,96,.45);color:#e0a09a}.fr-canon-group-note.ce-badge-reentry{border-color:rgba(196,164,96,.45);color:#dfc38a}.fr-canon-group-collapsible[open]>summary.fr-canon-group-title{border-bottom:1px solid rgba(140,120,83,.19)}.fr-canon-updates .fr-canon-native-results .ce-thinking-section{margin:12px 0 0;border:0;background:transparent;box-shadow:none}.fr-canon-updates .fr-canon-native-results .ce-thinking-section-header{padding:8px 0;background:transparent;border-bottom:1px solid rgba(140,120,83,.19);font-size:13px}.fr-canon-updates .fr-canon-native-results .ce-thinking-section-body{padding:10px 0}.fr-canon-updates .ce-entry-item{display:flex;align-items:baseline;flex-wrap:wrap;gap:7px 10px;margin:8px 0;line-height:1.75;overflow-wrap:anywhere}.fr-canon-updates .ce-entry-item>span{min-width:0;overflow-wrap:anywhere}.fr-canon-updates .ce-entry-badge{flex-shrink:0;white-space:nowrap;border-radius:5px;padding:3px 9px;font-size:11px;line-height:1.5}.fr-canon-updates .ce-badge-in{background:rgba(62,132,67,.28);color:#9dce9c}.fr-canon-updates .ce-badge-out{background:rgba(153,66,66,.26);color:#e6a3a3}.fr-canon-updates .ce-badge-reentry{background:rgba(163,120,42,.27);color:#e3bf75}.fr-canon-update-actions{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid rgba(140,120,83,.2);padding-top:12px;margin-top:14px}.fr-canon-update-actions .fr-canon-action-group{border:0;margin:0;padding:0}.fr-canon-update-actions button{margin:0}.fr-canon-updates .fr-canon-result-fold .fr-canon-trace-row{font-size:13px}@media(max-width:640px){.fr-canon-world-events{grid-template-columns:minmax(0,1fr)}.fr-canon-update-person .fr-canon-group-body{padding:10px}.fr-canon-updates .ce-entry-badge{max-width:100%;white-space:normal}.fr-canon-update-actions .fr-canon-action-group{flex:1 1 140px}}
/* 2026-11-02 玩家：「原著人物小故事分回合，分上一层下一层的回合，显示最新回合，
   重roll哪一层就替换覆盖哪一个回合，这样玩家就不用翻找当前最新回合的内容。」
   人物故事顶部回合导航：默认停在最新回合，多回合时才出现。 */
.fr-canon-story-turnbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 18px;padding:9px 12px;border:1px solid rgba(140,120,83,.26);border-radius:9px;background:rgba(140,120,83,.08)}
.fr-canon-story-turnbar button{min-height:32px;padding:5px 12px;font-size:12.5px}
.fr-canon-story-turnbar button[disabled]{opacity:.42;cursor:default}
/* 2026-11-02 玩家：「段落之间隔开距离并且来点区分度，并且标记最新的段落……
   要美观和有质感一点。让玩家一目了然」
   一段一卡片：段间明确间距、日期做成徽章、最新段高亮 + 左侧琥珀色竖条。
   配色全部走既有 CSS 变量，不引入新的色系，保持与其它面板一致。 */
.fr-canon-diary-block{position:relative;margin:0 0 18px;padding:16px 20px 18px;border:1px solid rgba(140,120,83,.28);border-left:3px solid rgba(140,120,83,.42);border-radius:10px;background:rgba(140,120,83,.045);transition:border-color .15s,background .15s}
.fr-canon-diary-block:last-child{margin-bottom:4px}
.fr-canon-diary-block.is-latest{border-color:rgba(213,188,131,.52);border-left-color:var(--concurrent-evo-accent-text,#d5bc83);background:rgba(213,188,131,.085);box-shadow:0 0 0 1px rgba(213,188,131,.1),0 2px 14px rgba(0,0,0,.18)}
.fr-canon-diary-date-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid rgba(140,120,83,.18)}
/* 2026-11-02 玩家：「日期也可以渲染一下，像展示界面那样显眼一点。」
   直接沿用展示界面已在用的日期语言：亮金色 #f0dfb6、等宽数字、tabular-nums，
   字号抬到 15px 并加粗，让日期成为段落里第一眼看到的东西。 */
.fr-canon-diary-date{display:inline-block;padding:5px 14px;border:1px solid rgba(213,188,131,.45);border-radius:999px;background:linear-gradient(180deg,rgba(213,188,131,.22),rgba(213,188,131,.1));color:#f0dfb6;font-size:15px;font-weight:700;letter-spacing:.03em;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.fr-canon-diary-block.is-latest .fr-canon-diary-date{border-color:rgba(240,223,182,.72);background:linear-gradient(180deg,rgba(240,223,182,.3),rgba(213,188,131,.14));color:#fff6dc;box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px rgba(213,188,131,.22)}
/* 2026-11-02 玩家：「但是要注意对比度，不要导致字看不清了」
   「最新」原来是「深字压金色实底」，实测只有 1.21:1 —— 远低于可读门槛。
   改成「金色字压深底 + 金色描边」：文字与自身底色对比拉到 12:1 以上，
   即使整块浮在任何深浅背景上都不会糊。 */
.fr-canon-diary-latest{display:inline-block;padding:3px 10px;border:1px solid rgba(240,223,182,.85);border-radius:999px;background:rgba(20,19,16,.92);color:#f6e7bf;font-size:11px;font-weight:700;letter-spacing:.08em;box-shadow:0 0 10px rgba(213,188,131,.28)}
.fr-canon-diary-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14.5px;line-height:2;color:var(--text-primary,#e0e0e0)}
.fr-canon-diary-body p{margin:0 0 12px}
.fr-canon-story-turnlabel{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.6;color:var(--text-secondary,#b8b0a0);overflow-wrap:anywhere}
.fr-canon-story-entry{position:absolute;left:50%;right:auto;transform:translateX(-50%);top:10px;z-index:6;border:1px solid var(--input-border,#66573c);border-radius:18px;padding:7px 13px;background:var(--modal-bg,#1c1c1c);color:var(--concurrent-evo-accent-text,#d5bc83);font:inherit;font-size:12px;cursor:pointer;box-shadow:0 2px 8px #0004}#main-content-wrapper #main-content-area{padding-top:48px}.fr-canon-story-reader{position:fixed;inset:0;z-index:22000;background:#0009;display:flex;align-items:center;justify-content:center;padding:22px}.fr-canon-reader-panel{width:min(1060px,100%);height:min(88vh,900px);display:flex;flex-direction:column;background:var(--modal-bg,#1c1c1c);color:var(--text-primary,#e0dccf);border:1px solid var(--input-border,#6d5c3c);border-radius:14px;box-shadow:0 20px 65px #0008;overflow:hidden}.fr-canon-reader-header{display:flex;align-items:center;gap:10px;padding:16px 22px;border-bottom:1px solid var(--input-border,#6d5c3c);background:rgba(140,120,83,.13)}.fr-canon-reader-header h3{flex:1;margin:0;font-size:18px;color:var(--concurrent-evo-accent-text,#d5bc83)}.fr-canon-reader-body{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:0;flex:1}.fr-canon-reader-people{padding:16px 10px;overflow:auto;border-right:1px solid var(--input-border,#5a4e3c)}.fr-canon-reader-panel button{min-height:38px;border:1px solid var(--input-border,#5a4e3c);border-radius:8px;background:var(--input-bg,#222);color:inherit;font:inherit;cursor:pointer;padding:7px 13px}.fr-canon-reader-people button{display:block;width:100%;text-align:left;margin-bottom:9px}.fr-canon-reader-people button.active{background:rgba(140,120,83,.25);border-color:var(--concurrent-evo-accent-text,#d5bc83);color:var(--concurrent-evo-accent-text,#d5bc83)}.fr-canon-reader-pages{overflow:auto;padding:26px clamp(18px,4vw,52px)}.fr-canon-reader-pages h2{font-size:24px;color:var(--concurrent-evo-accent-text,#d5bc83);margin:0 0 24px}.fr-canon-reader-pages small{font-size:11px;color:var(--text-secondary,#aaa)}.fr-canon-reader-chapter{padding-bottom:24px;margin-bottom:20px;border-bottom:1px solid var(--separator-color,#5a4e3c)}.fr-canon-diary-date{font-size:13px!important;font-weight:600;color:var(--concurrent-evo-accent-text,#d5bc83);margin:22px 0 12px!important;letter-spacing:.04em}.fr-canon-reader-pages .fr-canon-trace-prose{font-size:16px;line-height:2.15}.fr-canon-trace-prose p{margin:0 0 18px;white-space:pre-wrap}.fr-canon-reader-panel button:focus-visible{outline:2px solid var(--concurrent-evo-accent-text,#d5bc83);outline-offset:2px}@media(max-width:640px){.fr-canon-story-reader{padding:8px}.fr-canon-reader-panel{height:94vh}.fr-canon-reader-body{display:flex;flex-direction:column}.fr-canon-reader-people{display:flex;gap:8px;border-right:0;border-bottom:1px solid var(--separator-color,#5a4e3c);padding:9px;flex-shrink:0;max-height:60px}.fr-canon-reader-people button{width:auto;white-space:nowrap;margin:0}.fr-canon-reader-pages{padding:18px;flex:1}.fr-canon-reader-header{padding:12px}.fr-canon-reader-header h3{font-size:16px}.fr-canon-reader-panel button{min-height:44px}}

.fr-canon-trace .ce-thinking-section-header{margin:0;font-family:inherit;font-size:13px;color:var(--concurrent-evo-accent-text,#d5bc83)}.fr-canon-trace .ce-thinking-section-body{min-width:0}.fr-canon-trace .fr-canon-trace-row{display:flex;align-items:baseline;gap:9px;margin:6px 0;overflow-wrap:anywhere}.fr-canon-trace .fr-canon-trace-row>span:last-child{min-width:0;white-space:pre-wrap}.fr-canon-trace-label{flex-shrink:0;color:var(--concurrent-evo-accent-text,#d5bc83);font-size:12px}.fr-canon-trace-character{padding:14px 0 12px;border-bottom:1px solid rgba(140,120,83,.22)}.fr-canon-trace-character:last-child{border-bottom:0}.fr-canon-trace-character h4{display:inline-block;margin:0 10px 8px 0;font-size:15px;color:var(--concurrent-evo-accent-text,#d5bc83)}.fr-canon-trace-prose{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.95;font-family:inherit;margin:12px 0;color:var(--text-primary,#e0e0e0)}.fr-canon-trace-outcome{border-color:rgba(193,158,83,.5)}.fr-canon-trace .fr-canon-trace-outcome .ce-thinking-section-header{background:rgba(140,120,83,.23)}@media(max-width:640px){.fr-canon-trace .fr-canon-trace-row{flex-wrap:wrap;gap:3px 8px}.fr-canon-trace .ce-thinking-section-body{padding:9px}.fr-canon-trace-prose{font-size:14px;line-height:1.85}}
.fr-canon-trace{padding:18px;color:var(--text-primary);font-size:13px;line-height:1.65;min-width:0}.fr-canon-trace-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.fr-canon-trace select,.fr-canon-trace button{font:inherit;min-height:38px;border:1px solid var(--input-border);border-radius:8px;background:var(--input-bg);color:inherit;padding:7px 12px}.fr-canon-trace select{flex:1;min-width:180px}.fr-canon-trace-heading{padding:14px 16px;border:1px solid var(--separator-color);border-radius:10px;background:rgba(140,120,83,.12);font-size:15px}.fr-canon-trace-note{font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere}.fr-canon-empty{padding:40px 15px;text-align:center;color:var(--text-secondary)}.fr-canon-trace-timeline{border-left:2px solid var(--primary-color);margin:18px 7px;padding-left:14px}.fr-canon-trace-event{display:grid;grid-template-columns:65px minmax(0,1fr);gap:10px;padding:5px 0}.fr-canon-trace-event time{font-family:monospace;color:var(--text-secondary)}.fr-canon-trace-event.error,.fr-canon-trace-event.cancelled{color:#eaa29a}.fr-canon-trace-event.committed,.fr-canon-trace-event.saved{color:#8ecf9c}.fr-canon-trace details{border:0;padding:0;margin:9px 0}.fr-canon-trace details details{margin:9px 0 9px 12px;padding-left:10px;border-left:1px solid var(--separator-color,#655739)}.fr-canon-diagnostics>summary{font-size:12px;opacity:.7}.fr-canon-trace-toolbar{position:sticky;top:0;z-index:1;flex-wrap:wrap;padding:10px 0;background:var(--modal-bg,#1c1c1c)}.fr-canon-turn-title{flex:1;min-width:130px;color:var(--text-secondary,#aaa)}.fr-canon-flow-part{margin-bottom:16px}.fr-canon-trace .ce-thinking-section{margin:0 0 12px}.fr-canon-trace .ce-thinking-section-header{font-size:14px}.fr-canon-trace-prose{font-size:15px;line-height:1.95}.fr-canon-trace summary{cursor:pointer;color:var(--text-primary);overflow-wrap:anywhere}.fr-canon-trace pre{white-space:pre-wrap!important;overflow-wrap:anywhere!important;max-height:420px;overflow:auto;font:12px/1.65 ui-monospace,Consolas,monospace!important;padding:12px;background:var(--input-bg);border-radius:6px;margin:10px 0 0!important}.fr-canon-sidebar-status{font-size:11px;color:var(--text-secondary);padding:4px 0;overflow-wrap:anywhere}.fr-canon-stop{border-color:#874d4d!important;color:#e9a4a4!important}.fr-canon-stop:disabled{opacity:.4;cursor:default}.fr-canon-trace :focus-visible{outline:2px solid var(--hover-color);outline-offset:3px}@media(max-width:640px){.fr-canon-trace{padding:10px}.fr-canon-trace button,.fr-canon-trace select{min-height:44px}.fr-canon-trace-event{grid-template-columns:52px minmax(0,1fr)}}

.fr-canon-material-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;margin-top:12px}.fr-canon-material-card{min-width:0;padding:12px 14px;border:1px solid var(--separator-color,#514a3a);border-radius:9px;background:rgba(140,120,83,.055)}.fr-canon-material-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.fr-canon-material-heading h4{margin:0;color:var(--concurrent-evo-accent-text,#d5bc83);font:inherit;font-weight:600}.fr-canon-material-heading .ce-entry-badge{white-space:nowrap;font-size:11px}.fr-canon-material-card.is-truncated{border-color:#94713d;background:rgba(175,122,42,.08)}.fr-canon-material-card.is-empty{color:var(--text-secondary,#aaa)}.fr-canon-material-card .fr-canon-trace-row{font-size:12px;margin:8px 0}.fr-canon-material-card>details>summary{font-size:12px;color:var(--text-secondary,#aaa)}.fr-canon-trace .fr-canon-material-card button,.fr-canon-copy-group>button{font-size:12px;padding:5px 10px;min-height:32px;margin-top:8px}.fr-canon-copy-group{margin:12px 0}.fr-canon-copy-group h4{margin:4px 0;color:var(--concurrent-evo-accent-text,#d5bc83)}
/* ============ 边界判定：情境行 + 分组卡片 ============ */
/* 情境行：时间范围、待补演名单等元信息，双列对齐，比一行行堆叠更整齐。 */
.fr-canon-guide-meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px;padding:10px 14px;margin:0 0 12px;border-radius:9px;border:1px solid rgba(140,120,83,.22);background:rgba(140,120,83,.07)}
.fr-canon-guide-meta-item{display:contents;margin:0}
.fr-canon-guide-meta-key{font-size:12px;color:rgba(213,188,131,.82);font-weight:500;white-space:nowrap}
.fr-canon-guide-meta-value{font-size:13px;color:var(--text-primary,#e0dccf);overflow-wrap:anywhere;line-height:1.55}
/* 分组卡片：边界判定按语义分组，标题带左侧色条区分类型。 */
.fr-canon-group{margin:0 0 12px;border-radius:9px;border:1px solid rgba(140,120,83,.24);border-left-width:3px;overflow:hidden;background:rgba(140,120,83,.045)}
.fr-canon-group-title{padding:9px 14px;font-size:13px;font-weight:600;color:var(--concurrent-evo-accent-text,#d5bc83);background:rgba(140,120,83,.08);border-bottom:1px solid rgba(140,120,83,.14)}
.fr-canon-group-body{padding:4px 14px 8px}
.fr-canon-group-note{padding:8px 0 4px;font-size:12.5px;line-height:1.7;color:var(--text-secondary,#c2bba9);overflow-wrap:anywhere}
.fr-canon-group-done{border-left-color:rgba(129,199,132,.55)}
.fr-canon-group-done .fr-canon-group-title{color:#9dd6a2}
.fr-canon-group-todo{border-left-color:rgba(213,188,131,.6)}
.fr-canon-group-deviated{border-left-color:#c98a4b}
.fr-canon-group-deviated .fr-canon-group-title{color:#e3b283}
.fr-canon-group-world{border-left-color:rgba(126,143,166,.55)}
.fr-canon-group-world .fr-canon-group-title{color:#a9bcd2}
@media(max-width:640px){.fr-canon-guide-meta{grid-template-columns:minmax(0,1fr);gap:3px;padding:9px 11px}.fr-canon-guide-meta-value{margin-bottom:5px}}
/* 情境条：时间·事件·资料状态压成一行，比原来三行省一半高度。 */
.fr-canon-context{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 14px;margin:0 0 14px;border:1px solid rgba(140,120,83,.28);border-radius:10px;background:rgba(140,120,83,.09)}
.fr-canon-context-time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:600;color:var(--concurrent-evo-accent-text,#d5bc83);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.fr-canon-context-sep{width:1px;height:13px;background:rgba(140,120,83,.35);flex-shrink:0}
.fr-canon-context-event{margin:0;font-size:13px;font-weight:500;color:var(--text-primary,#e0dccf);font-family:inherit;line-height:1.45}
.fr-canon-context-chip{margin-left:auto;flex-shrink:0;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid transparent}
.fr-canon-context-chip.is-ok{border-color:rgba(129,199,132,.4);background:rgba(76,175,80,.16);color:#9dd6a2}
.fr-canon-context-chip.is-warn{border-color:rgba(239,154,154,.35);background:rgba(244,67,54,.14);color:#ef9a9a}
/* 摘要 chips：标签与条数分开，条数等宽加粗，横向对比更快。 */
.fr-canon-summary{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.fr-canon-summary-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 11px 5px 12px;border-radius:999px;font-size:12.5px;border:1px solid;line-height:1.4;flex-shrink:0;white-space:nowrap}
.fr-canon-summary-label{font-weight:500;white-space:nowrap;color:inherit}
.fr-canon-summary-count{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px}
.fr-canon-summary-past{border-color:rgba(140,120,83,.45);background:rgba(140,120,83,.13);color:#cfc4a8}
.fr-canon-summary-now{border-color:rgba(213,188,131,.6);background:rgba(213,188,131,.2);color:#f0dcae}
.fr-canon-summary-future{border-color:rgba(126,143,166,.4);background:rgba(126,143,166,.13);color:#a9bcd2}
.fr-canon-summary-deviated{border-color:rgba(201,138,75,.45);background:rgba(201,138,75,.14);color:#e3b283}
.fr-canon-summary-done,.fr-canon-summary-todo,.fr-canon-summary-later,.fr-canon-summary-hidden,.fr-canon-summary-plain{border-color:rgba(140,120,83,.35);background:rgba(140,120,83,.1);color:#cfc4a8}
/* 时间轴：一条竖线串起过去→现在→未来，节点用实心/高亮/空心区分。 */
.fr-canon-timeline{position:relative;margin:0 0 18px;padding-left:20px}
.fr-canon-timeline::before{content:"";position:absolute;left:5px;top:9px;bottom:9px;width:2px;background:linear-gradient(180deg,rgba(140,120,83,.1),rgba(140,120,83,.32) 18%,rgba(140,120,83,.32) 82%,rgba(140,120,83,.1))}
/* 时间轴之后用一条极淡的分隔线隔开旁注，让「时间线」和「旁注」是两块东西。 */
.fr-canon-timeline+.fr-canon-aside,.fr-canon-timeline+.fr-canon-worldline{margin-top:0}
.fr-canon-aside+.fr-canon-worldline{margin-top:12px}
.fr-canon-stage{position:relative;padding:2px 0 14px}
.fr-canon-stage:last-child{padding-bottom:0}
.fr-canon-stage-dot{position:absolute;left:-20px;top:5px;width:12px;height:12px;border-radius:50%;box-sizing:border-box;background:rgba(140,120,83,.55)}
.fr-canon-stage-past .fr-canon-stage-dot{background:rgba(140,120,83,.55)}
.fr-canon-stage-now .fr-canon-stage-dot{background:var(--concurrent-evo-accent-text,#d5bc83);box-shadow:0 0 0 4px rgba(213,188,131,.18)}
.fr-canon-stage-future .fr-canon-stage-dot{background:transparent;border:2px solid rgba(140,120,83,.45)}
.fr-canon-stage-head{display:flex;align-items:center;gap:9px;padding:1px 0 7px;cursor:default}
.fr-canon-stage.is-collapsed .fr-canon-stage-head{cursor:pointer;user-select:none;border-radius:6px;padding:4px 8px 4px 4px;margin:-3px 0 4px -4px}
.fr-canon-stage.is-collapsed .fr-canon-stage-head:hover{background:rgba(140,120,83,.1)}
.fr-canon-stage.is-collapsed .fr-canon-stage-head:focus-visible{outline:2px solid var(--concurrent-evo-accent-text,#d5bc83);outline-offset:2px}
.fr-canon-stage-title{font-size:13px;font-weight:600;color:var(--concurrent-evo-accent-text,#d5bc83)}
.fr-canon-stage-now .fr-canon-stage-title{color:#f0dcae}
.fr-canon-stage-count{font-variant-numeric:tabular-nums;font-size:11px;font-weight:600;color:rgba(207,196,168,.6);padding:1px 7px;border-radius:999px;background:rgba(140,120,83,.14)}
.fr-canon-stage.is-collapsed .fr-canon-stage-count::after{content:" ›";color:rgba(207,196,168,.5)}
.fr-canon-stage.is-collapsed .fr-canon-stage-head:hover .fr-canon-stage-count::after{content:" ⌄"}
.fr-canon-stage-body{min-width:0}
.fr-canon-stage-hint{margin:2px 0 0;font-size:12px;color:var(--text-secondary,#a9a294);font-style:normal}
/* 条目：序号定宽右对齐 + 正文自适应，长句正常换行，不再挤成一行。 */
.fr-canon-group-item{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:start;margin:0;padding:7px 0;border-bottom:1px solid rgba(140,120,83,.1);font-size:13px;line-height:1.72;color:var(--text-primary,#e0dccf)}
.fr-canon-group-item:last-child{border-bottom:0;padding-bottom:2px}
.fr-canon-group-index{font-variant-numeric:tabular-nums;text-align:right;font-size:12px;line-height:1.72;color:rgba(213,188,131,.72);font-weight:600}
.fr-canon-group-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
/* 无序号说明行：单列、整行可换行。
   2026-11-01 玩家截图报「每行一个字」——原来这种行误用了带序号的
   两列网格(.fr-canon-group-item，第一列只有 24px)，正文被塞进 24px 里竖成一条。
   这里明确单列 + 足够宽度，不再继承序号列。 */
.fr-canon-note{display:block;min-width:0;margin:0;padding:7px 0;border-bottom:1px solid rgba(140,120,83,.1);font-size:13px;line-height:1.72;color:var(--text-primary,#e0dccf);overflow-wrap:anywhere;white-space:pre-wrap}
.fr-canon-note:last-child{border-bottom:0;padding-bottom:2px}
/* 回合被重roll覆盖的提示条。
   2026-11-01 玩家：「然后都跑到这了，原著补演下面的内容都不展示了」——
   记录不再静默消失，改成显式说明，并且原内容仍留在下方可查。 */
.fr-canon-superseded{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:8px 0 4px;padding:9px 12px;border-radius:8px;background:rgba(196,132,58,.10);border:1px solid rgba(196,132,58,.34);min-width:0}
.fr-canon-superseded-badge{flex:0 0 auto;padding:2px 9px;border-radius:999px;font-size:12px;line-height:1.5;color:#f0cf95;background:rgba(196,132,58,.22);border:1px solid rgba(196,132,58,.45)}
.fr-canon-superseded-text{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.66;color:var(--text-secondary,#b8b0a0);overflow-wrap:anywhere}
/* 单条被覆盖记录：降饱和 + 左侧竖线，和有效记录形成明确区分。 */
.fr-canon-flow-part.is-superseded{opacity:.72;border-left:2px solid rgba(196,132,58,.42);padding-left:10px}
.fr-canon-flow-part.is-superseded:hover{opacity:.92}
/* 2026-11-02 玩家：「变量演化流程展示每次都要跑完才展示，统一一下和其他一样，
   一边跑一边陆续展示。」——第一个角色结果回来前的占位，让玩家立刻看到流程在跑。 */
.fr-canon-streaming-placeholder{padding:18px 4px;font-size:13px;line-height:1.7;color:var(--text-secondary,#b8b0a0);opacity:.82}
.fr-canon-streaming-placeholder::before{content:'▍';margin-right:6px;color:#7fb2e5;animation:fr-canon-blink 1.1s steps(2,start) infinite}
@keyframes fr-canon-blink{to{visibility:hidden}}
.fr-canon-superseded-tag{margin:2px 0 6px;font-size:12px;line-height:1.55;color:#e0bd88;letter-spacing:.2px}
/* 2026-11-02 玩家：「折叠起来，只显示这个标记。玩家想看才打开」
 * 被重roll覆盖的旧补演记录整段收进 details，默认收起，面板上只剩 summary 那行。
 * 这样重roll完、新补演还没跑的时候，不会有一大块旧内容占着面板让人误以为跑过了。 */
.fr-canon-superseded-fold{margin:0 0 10px}
.fr-canon-superseded-details{border:1px solid rgba(196,132,58,.32);border-radius:8px;background:rgba(196,132,58,.07);padding:0 12px}
.fr-canon-superseded-details>summary{cursor:pointer;list-style:none;padding:8px 0}
.fr-canon-superseded-details>summary::-webkit-details-marker{display:none}
.fr-canon-superseded-details>summary::before{content:"▸";display:inline-block;margin-right:7px;color:#e0bd88;transition:transform .15s}
.fr-canon-superseded-details[open]>summary::before{transform:rotate(90deg)}
.fr-canon-superseded-details>summary:hover{color:#f0cf95}
.fr-canon-superseded-details[open]>summary{margin-bottom:4px;border-bottom:1px solid rgba(196,132,58,.22)}
.fr-canon-superseded-details .fr-canon-flow-part{margin-top:8px}
/* 分工条目：人名加粗单列，理由缩进换行，避免「人名 + 长理由」挤成一行难以扫读。 */
.fr-canon-group-actor{display:block;font-weight:600;color:var(--text-primary,#e8e3d6);font-size:13px;line-height:1.5}
.fr-canon-group-reason{display:block;margin-top:2px;font-size:12px;line-height:1.62;color:var(--text-secondary,#a9a294);overflow-wrap:anywhere}
/* 实际补演名单：等宽小标签排布，人数多时自动换行不溢出。 */
.fr-canon-name-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 4px}
.fr-canon-name-chip{padding:3px 10px;border-radius:999px;font-size:12px;line-height:1.5;color:#e8d9b0;background:rgba(213,188,131,.12);border:1px solid rgba(213,188,131,.32)}
.fr-canon-group-empty{margin:0;padding:6px 0 2px;font-size:12px;color:rgba(207,196,168,.62)}
.fr-canon-group-note{margin:0 0 8px;font-size:11.5px;line-height:1.6;color:rgba(207,196,168,.7)}
/* 本轮时间推进档位条：一档一色，玩家一眼看出这轮是「大补」「小补」还是「不补」。
   跨事件用金色（最重要）、有进展用绿色、无进展用灰蓝（收束感）。
   与原著指导的世界线徽章共用同一套圆角、字重和描边厚度，保持整卡一致。 */
.fr-pointer-card{min-width:0;padding:20px 22px;margin:0 0 12px;border:1px solid #8c785344;border-radius:12px;background:radial-gradient(ellipse at 15% 0%,#b89d6320,transparent 65%),linear-gradient(135deg,#24231f,#181917);box-shadow:inset 0 1px #e3cf9620}
.fr-pointer-title{color:#d8c399!important;margin:0 0 18px!important;font-size:1.07em;line-height:1.6;overflow-wrap:anywhere}.fr-pointer-heading,.fr-pointer-phase{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;line-height:1.65}.fr-pointer-caption{color:#a99b82;font-size:.86em;letter-spacing:.08em}.fr-pointer-date{color:#f0dfb6;font-variant-numeric:tabular-nums}.fr-pointer-track{position:relative;height:9px;margin:30px 16px 25px;background:#070907;border:1px solid #6b60433d;border-radius:20px;box-shadow:inset 0 2px 4px #0009}.fr-pointer-fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#665633,#b59b60,#e2c880);box-shadow:0 0 10px #d9b86230}.fr-pointer-now{position:absolute;top:-5px;width:17px;height:17px;transform:translateX(-50%);border-radius:50%;background:#efe2b4;border:3px solid #6f5d37;box-shadow:0 0 0 4px #d9bd6820,0 0 14px #cfb16155;z-index:2}.fr-pointer-saved{position:absolute;top:-2px;height:12px;width:3px;transform:translateX(-50%);background:#aba795;border-radius:2px}.fr-pointer-ends{display:flex;justify-content:space-between;gap:16px;color:#a69e8d;font-size:.82em;font-variant-numeric:tabular-nums}.fr-pointer-phase{margin-top:18px;color:#e8e1d2}.fr-pointer-history,.fr-pointer-footnote{font-size:.83em;color:#999787;line-height:1.7;margin:8px 0!important}.fr-pointer-warning{color:#dcad71;font-size:.86em;margin:10px 0!important}.fr-pointer-mutation{position:absolute;top:11px;transform:translateX(-50%);width:32px;height:26px;padding:0!important;background:transparent!important;border:0!important;color:#efad66!important;text-shadow:0 0 8px #e79b3e66;font-size:17px;cursor:pointer;z-index:3}.fr-pointer-mutation:focus-visible{outline:2px solid #e9bb6f;outline-offset:2px}.fr-pointer-changes,.fr-pointer-pending,.fr-pointer-more{margin-top:15px;border-top:1px solid #8c78532b;padding-top:10px}.fr-pointer-changes>summary{color:#d7ae76}.fr-pointer-change{padding:12px 0;border-bottom:1px solid #8c785322;overflow-wrap:anywhere}.fr-pointer-change-label{display:inline-block;color:#e5b477;font-size:.82em}.fr-pointer-change p{margin:7px 0!important}.fr-pointer-change small{color:#969082}.fr-pointer-pending{color:#b6b0a1;font-size:.9em}.fr-pointer-footnote{margin-top:14px!important}@media(max-width:640px){.fr-pointer-card{padding:16px 14px}.fr-pointer-date{font-size:.93em;overflow-wrap:anywhere}.fr-pointer-ends{font-size:.75em;gap:12px}.fr-pointer-title{margin-bottom:12px!important}}
.fr-canon-tier-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 12px;padding:11px 14px;border-radius:10px;border:1px solid rgba(140,120,83,.28);background:linear-gradient(180deg,rgba(140,120,83,.13),rgba(140,120,83,.05))}
.fr-canon-tier-chip{flex-shrink:0;padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:600;letter-spacing:.01em;border:1px solid transparent;white-space:nowrap}
.fr-canon-tier-cross{color:#f0dcae;background:rgba(213,188,131,.22);border-color:rgba(213,188,131,.62);box-shadow:0 0 0 1px rgba(213,188,131,.12) inset}
.fr-canon-tier-progress{color:#9dd6a2;background:rgba(76,175,80,.18);border-color:rgba(129,199,132,.42)}
.fr-canon-tier-none{color:#a9bcd2;background:rgba(126,143,166,.15);border-color:rgba(126,143,166,.4)}
.fr-canon-boundary-dates,.fr-canon-boundary-events{display:grid;gap:10px;margin:14px 0;padding:16px;border:1px solid rgba(180,156,103,.2);border-radius:12px;background:rgba(180,156,103,.035)}.fr-canon-boundary-dates small,.fr-canon-boundary-events small{color:#ad9d7c}.fr-canon-boundary-dates strong{font-size:16px;line-height:1.8}.fr-canon-boundary-event{display:flex;align-items:center;gap:12px;padding:7px 0}.fr-canon-boundary-event strong{font-size:15px;line-height:1.7}.fr-canon-tier-range{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;font-weight:600;color:var(--concurrent-evo-accent-text,#d5bc83);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.fr-canon-tier-hint{margin-left:auto;flex-shrink:0;font-size:11.5px;font-weight:500;color:rgba(207,196,168,.72)}
@media(max-width:640px){.fr-canon-tier-bar{gap:7px;padding:9px 11px}.fr-canon-tier-hint{margin-left:0;width:100%}}
/* 可折叠区块：时间跨度大的轮次年表可能有几十条，不收起来会把档位结论挤出屏幕。
   用 <details>/<summary> 原生折叠，不额外写交互；标题行本身就是可点区域，
   右侧给一个会随展开状态换字的提示，避免出现「已展开还写着点击展开」。 */
.fr-canon-event-fold{margin:0 0 12px;border:1px solid rgba(140,120,83,.2);border-radius:10px;background:rgba(255,255,255,.015);overflow:hidden}
.fr-canon-event-fold-head{display:flex;align-items:center;gap:8px;padding:9px 13px;cursor:pointer;list-style:none;user-select:none;transition:background .15s ease}
.fr-canon-event-fold-head::-webkit-details-marker{display:none}
.fr-canon-event-fold-head:hover{background:rgba(213,188,131,.07)}
.fr-canon-event-fold-head::before{content:'▸';flex-shrink:0;font-size:10px;color:rgba(207,196,168,.55);transition:transform .15s ease}
.fr-canon-event-fold[open]>.fr-canon-event-fold-head::before{transform:rotate(90deg)}
.fr-canon-event-fold-title{font-size:12.5px;font-weight:600;color:rgba(207,196,168,.88);letter-spacing:.01em}
.fr-canon-event-fold-hint{margin-left:auto;flex-shrink:0;font-size:11px;color:rgba(207,196,168,.45)}
.fr-canon-event-fold-body{padding:2px 13px 11px;border-top:1px solid rgba(140,120,83,.13)}
.fr-canon-event-fold-body>.fr-canon-group-item:first-child{margin-top:8px}
@media(max-width:640px){.fr-canon-event-fold-head{padding:8px 11px}.fr-canon-event-fold-body{padding:2px 11px 10px}}
/* 旁注：不属于时间轴的两类，左侧色条 + 淡背景，一眼区分。 */
.fr-canon-aside{margin:0 0 12px;border-radius:9px;border:1px solid rgba(140,120,83,.24);border-left-width:3px;overflow:hidden}
.fr-canon-aside-head{display:flex;align-items:center;gap:9px;padding:9px 14px}
.fr-canon-aside-title{font-size:13px;font-weight:600}
.fr-canon-aside-count{margin-left:auto;font-variant-numeric:tabular-nums;font-size:11px;color:rgba(207,196,168,.62)}
.fr-canon-aside-body{padding:0 14px 4px}
.fr-canon-aside-note{margin:0;padding:0 14px 10px;font-size:11.5px;line-height:1.6;color:var(--text-secondary,#a9a294)}
.fr-canon-aside-hidden{border-left-color:#9c6fb0;background:rgba(156,111,176,.07)}
.fr-canon-aside-hidden .fr-canon-aside-title{color:#c9a3d8}
.fr-canon-aside-deviated{border-left-color:#c98a4b;background:rgba(201,138,75,.07)}
.fr-canon-aside-deviated .fr-canon-aside-title{color:#e3b283}
/* 世界线状态条：状态徽章 + 说明同一行，替代原来一个大标题挂一句话。 */
.fr-canon-worldline{display:flex;align-items:flex-start;gap:10px;margin:4px 0 0;padding:10px 14px;border-radius:9px;border:1px solid rgba(140,120,83,.26);background:rgba(140,120,83,.07)}
.fr-canon-worldline-badge{flex-shrink:0;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(76,175,80,.18);color:#9dd6a2;border:1px solid rgba(129,199,132,.35)}
.fr-canon-worldline-badge.is-off{background:rgba(255,183,77,.16);color:#e3b283;border-color:rgba(201,138,75,.4)}
.fr-canon-worldline-text{min-width:0;font-size:12.5px;line-height:1.65;color:var(--text-secondary,#c2bba9);overflow-wrap:anywhere}
@media(max-width:640px){
  .fr-canon-context{gap:6px;padding:9px 11px}
  .fr-canon-context-chip{margin-left:0}
  .fr-canon-summary{gap:6px}
  .fr-canon-group-item{grid-template-columns:20px minmax(0,1fr);gap:8px}
  .fr-canon-timeline{padding-left:17px}
  .fr-canon-stage-dot{left:-17px;width:11px;height:11px}
  .fr-canon-worldline{flex-direction:column;gap:7px}
}
@media(prefers-reduced-motion:reduce){.fr-canon-stage.is-collapsed .fr-canon-stage-head{transition:none}}
#chat-view .fr-canon-story-entry{position:absolute;left:10px;right:auto;top:110px;transform:none;width:28px;height:28px;min-width:28px;min-height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid var(--primary-color,#8c7853);background:rgba(0,0,0,.4);color:var(--text-primary,#eee5d3);z-index:1002;box-shadow:none}#chat-view .fr-canon-story-entry::after{content:"";position:absolute;inset:-6px;border-radius:50%}#chat-view .fr-canon-story-entry:hover{background:var(--primary-color,#8c7853);color:#17150f}#chat-view .fr-canon-story-entry:focus-visible{outline:2px solid var(--hover-color,#e7c679);outline-offset:3px}#main-content-wrapper #main-content-area{padding-top:0}.fr-canon-direct-action{margin:10px 8px 0 0}.fr-canon-action-status{display:inline-block;max-width:100%;margin:8px 0;color:var(--text-secondary,#c8bea8);font-size:12px;overflow-wrap:anywhere}
.fr-canon-action-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}.fr-canon-action-group .fr-canon-action-status{flex:0 1 auto;max-width:600px;margin:0;line-height:1.6}.fr-canon-action-group .fr-canon-direct-action{flex:0 0 auto;margin:0}.fr-canon-trace button.fr-canon-direct-action{position:relative;min-height:42px;padding:9px 16px 9px 36px;border:1px solid #927745;background:linear-gradient(180deg,#332c20,#211e18);color:#f0dfb8;cursor:pointer;box-shadow:inset 0 1px #ffffff0d,0 2px 5px #0003;transition:background .15s,border-color .15s,color .15s,box-shadow .15s,transform .1s}
.fr-canon-trace button.fr-canon-direct-action:not(:disabled):hover{background:linear-gradient(180deg,#69512c,#49371e);border-color:#ebc675;color:#fff2cf;box-shadow:inset 0 1px #fff3,0 0 0 2px #d9b35c22,0 3px 12px #0005}
.fr-canon-trace button.fr-canon-direct-action:not(:disabled):active{transform:translateY(1px);background:#ac8845;color:#17130d;box-shadow:inset 0 2px 5px #0005}
.fr-canon-trace button.fr-canon-direct-action:focus-visible{outline:2px solid #f3d68f;outline-offset:3px;background:#49391f}
.fr-canon-trace button.fr-canon-direct-action:disabled{cursor:not-allowed;opacity:.65;box-shadow:none;background:#292722;border-color:#665d4a;color:#c2bba9}
.fr-canon-trace button.fr-canon-direct-action::before{content:"";position:absolute;left:13px;top:50%;width:12px;height:12px;margin-top:-7px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;opacity:0;box-sizing:border-box}
.fr-canon-trace button.fr-canon-direct-action[aria-busy="true"]{opacity:1;cursor:progress;border-color:#d6b36a;background:#463820;color:#f8e2b0}
.fr-canon-trace button.fr-canon-direct-action[aria-busy="true"]::before{opacity:1;animation:fr-canon-action-spin .8s linear infinite}
.fr-canon-trace button.fr-canon-direct-action[data-action-state="success"]{border-color:#8ea678;color:#dce9c8}.fr-canon-trace button.fr-canon-direct-action[data-action-state="error"]{border-color:#b98467;color:#f0cfb8}
@keyframes fr-canon-action-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.fr-canon-trace button.fr-canon-direct-action{transition:none}.fr-canon-trace button.fr-canon-direct-action[aria-busy="true"]::before{animation:none}}

.fr-canon-trace button:not(:disabled):hover{border-color:#cfb474;background:linear-gradient(135deg,#5e5033,#393328);color:#f3dfb0;box-shadow:0 0 12px #c5a66525}.fr-canon-trace button:not(:disabled):active{transform:translateY(1px);background:#74603a}.fr-canon-trace button:disabled{opacity:.4;cursor:not-allowed}.fr-canon-trace button:focus-visible{outline:2px solid #d8c399;outline-offset:3px}
/* 卡片：照搬 .fr-pointer-card */
.fr-pointer-card{min-width:0;padding:20px 22px;margin:0 0 12px;border:1px solid #8c785344;border-radius:12px;
  background:radial-gradient(ellipse at 15% 0%,#b89d6320,transparent 65%),linear-gradient(135deg,#24231f,#181917);
  box-shadow:inset 0 1px #e3cf9620;position:relative}
.fr-pointer-title{color:#d8c399;margin:0 0 18px;font-size:1.07em;line-height:1.6;overflow-wrap:anywhere}
.fr-pointer-heading,.fr-pointer-phase{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;line-height:1.65}
.fr-pointer-caption{color:#a99b82;font-size:.86em;letter-spacing:.08em}
.fr-pointer-date{color:#f0dfb6;font-variant-numeric:tabular-nums}

/* 轨道 */
/* 进度指针布局：第三版（Playwright 实测通过）
 *
 * 2026-11-02 玩家：「你这改得乱七八糟啊，不应该啊，你要自己看看好不好看啊，
 * 而且加滚动条做什么啊，这种区域肯定只能全展开整体加大啊。」
 *
 * 前两版都错，原因各不相同，记下来免得再犯：
 *
 * 【第一版】轨道内 absolute + overflow-x:auto
 *   硬伤：CSS 规定一个轴不是 visible 时，另一个轴的 visible 会被强制成 auto，
 *   所以横向滚动必然连带长出**纵向滚动条**；轨道还被 minWidth 撑得比容器宽，
 *   右侧留一大段没有节点的空白。
 *
 * 【第二版】等分的 flex 列（每格放一个标签）
 *   硬伤：标签被平均分到 N 个等宽格子里，**完全脱离自己对应的节点位置** ——
 *   圆点在 8%/22%/55%，标签却挤在左边一竖排，看着就是一坨。
 *   Playwright 实测截图证实了这点，方案本身是错的。
 *
 * 【第三版，当前】绝对定位 + 分道 + 夹紧
 *   · 标签按 left%（真实时间位置）绝对定位，对准自己的节点；
 *   · 宽高先估算，再按中心距贪心装道（同一道的标签互不重叠）；
 *   · 相邻标签上下交替，天然错开；
 *   · 贴容器边缘的标签做**夹紧**，不让它越界；
 *   · 高度靠 axis 的 padding 撑开 —— 是文档流增高，不是滚动，永远没有滚动条；
 *   · 全部展开，不裁切、不折叠。
 *   Playwright 实测：hOverflow=false / vOverflow=false / 无重叠 / 无越界。
 */
.fr-pointer-axis{position:relative;width:100%;margin:0;padding:0;overflow:visible;box-sizing:border-box}
/* 轨道：宽度恒等于容器，绝不用 minWidth 撑宽（那样会右侧空一块还要横滚） */
.fr-pointer-track{position:relative;height:9px;width:100%;margin:0;box-sizing:border-box;
  background:#070907;border:1px solid #6b60433d;border-radius:20px;box-shadow:inset 0 2px 4px #0009}
.fr-pointer-fill{position:absolute;top:0;left:0;height:100%;border-radius:20px 0 0 20px;
  background:linear-gradient(90deg,#3f7a4e,#5fbf7a,#8fd99f);box-shadow:0 0 10px #5fbf7a35}
/* 此刻指针：用箭头不用圆点——圆点会被误认成事件节点 */
.fr-pointer-now{position:absolute;top:-15px;transform:translateX(-50%);z-index:6;
  display:flex;flex-direction:column;align-items:center;pointer-events:none}
.fr-pointer-now::before{content:'';width:0;height:0;
  border-left:7px solid transparent;border-right:7px solid transparent;
  border-top:13px solid #efe2b4;
  filter:drop-shadow(0 0 7px #cfb16199)}
.fr-pointer-now::after{content:'';width:2px;height:100%;position:absolute;top:12px;
  background:linear-gradient(180deg,#efe2b4,#6f5d3700)}
/* 「此刻」文字：和节点标签一样**参与分道**（top 由 JS 算），不再是钉死的 top:-38px。
 * 钉死会压到相邻标签 —— 实测截图里它就和「迷路逢顾」叠在一起了。
 *
 * ★★★ 2026-11-03 玩家：「进度指针此刻这里的问题还是没解决」。
 * 真正原因是**它挂错了父节点**（原来挂在 17px 宽的游标 now 上，坐标全是另一套），
 * 已改为挂到 axis，和 .fr-pointer-lbl 完全同构（见 JS 里的长注释）。
 * 所以这里去掉 left:50% 这个「相对 now 居中」的旧值 —— 现在 left 由 JS 按真实时间位置算，
 * 与普通标签走同一行代码。只保留 translateX(-50%) 做自身水平居中。 */
.fr-pointer-now-tag{position:absolute;transform:translateX(-50%);
  font-size:10px;letter-spacing:.08em;color:#efe2b4;white-space:nowrap;
  text-shadow:0 0 8px #000000cc,0 0 12px #cfb16166;z-index:7}

/* 事件节点（只画在线上的圆点） */
.fr-pointer-node{position:absolute;top:50%;width:13px;height:13px;margin-top:-6.5px;transform:translateX(-50%);
  border-radius:50%;border:2px solid #8a8272;background:#12110f;cursor:pointer;z-index:3;
  transition:box-shadow .15s,transform .15s}
.fr-pointer-node:hover{transform:translateX(-50%) scale(1.25);box-shadow:0 0 0 4px #e8e1d21f}
.fr-pointer-node.is-done{border-color:#5fbf7a;background:#5fbf7a;box-shadow:0 0 8px #5fbf7a66}
.fr-pointer-node.is-todo{border-color:#e8e1d2;background:#24231f}
/* 变异两种 */
.fr-pointer-node.is-mutated{border-color:#e05c5c;background:#e05c5c;box-shadow:0 0 0 4px #e05c5c2e,0 0 12px #e05c5c77;
  animation:frPointerPulse 2.4s ease-in-out infinite}
.fr-pointer-node.is-created{border-color:#e05c5c;background:#24231f;box-shadow:0 0 0 4px #e05c5c2e;
  animation:frPointerPulse 2.4s ease-in-out infinite}
.fr-pointer-node.is-created::after{content:'';position:absolute;inset:1px;border-radius:50%;background:#e05c5c}
@keyframes frPointerPulse{0%,100%{box-shadow:0 0 0 4px #e05c5c2e}50%{box-shadow:0 0 0 7px #e05c5c14}}

/* 节点标签：绝对定位、对齐自己的节点；单行不换行（宽度可预测，分道才准） */
.fr-pointer-lbl{position:absolute;transform:translateX(-50%);font-size:11px;
  color:#969082;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;
  cursor:pointer;z-index:2;letter-spacing:.02em;padding:0;border:0;background:none;line-height:1.5}
.fr-pointer-lbl.is-done{color:#6fbf87}
.fr-pointer-lbl.is-todo{color:#a69e8d}
.fr-pointer-lbl.is-mutated,.fr-pointer-lbl.is-created{color:#e88383;font-weight:600}
/* 2026-11-02 玩家截图：进度指针标签全变成「带边框的白方块」、互相压住。
 *
 * 原因：本卡有一层通用 button 样式（边框/背景/内边距），标签是 <button>，
 * 被那层样式套上了。上一版为图省事把「去外观」那段 !important 覆盖整段删了，
 * 结果标签恢复成按钮外观 —— 视觉上是方框，宽度也变大，分道算法跟着算歪。
 * 这段必须保留，且必须 !important：通用 button 选择器特异性更高，普通声明压不住。
 */
.fr-pointer-lbl{padding:0!important;border:0!important;background:transparent!important;
  box-shadow:none!important;min-width:0!important;min-height:0!important;outline-offset:2px}
/* ★ 2026-11-02 玩家截图：节点圆点变成了**横向椭圆**。
 *
 * 原因同标签：通用 button 样式带了 min-width:44px + padding，
 * 而圆点标记的是 width:13px;height:13px —— 宽度被 min-width 顶到 44px，
 * 高度只有 13px，于是画出来就是一根横条椭圆，看着像进度条上的污点。
 * 上一版把「去外观」整段删掉时，圆点这条也一起没了。
 * 必须 !important：通用 button 选择器特异性更高，普通声明压不住。
 */
.fr-pointer-node{padding:0!important;min-width:0!important;min-height:0!important;
  width:13px!important;height:13px!important;box-sizing:border-box;
  font-size:0!important;line-height:1!important;overflow:hidden!important;
  border-radius:50%!important}
.fr-pointer-node:hover{box-shadow:0 0 0 4px #e8e1d21f}
.fr-pointer-node:active{transform:translateX(-50%) scale(1.12)!important}
.fr-pointer-lbl:hover{color:#f0dfb6!important}
/* 「此刻」是 span，不受 button 样式影响，但仍要精确控制 */
.fr-pointer-now-tag{border:0!important;background:transparent!important;padding:2px 4px!important;
  box-shadow:none!important;min-width:0!important}
/* 「此刻」文字：与节点标签同一套排版，只是颜色更亮、字号略小。
 * 上一版它绝对定位在游标上方（top:-38px），会压到标题、也会和相邻标签叠；
 * 现在跟节点标签一样进列容器，位置稳定。 */
.fr-pointer-lbl.is-now{color:#efe2b4;letter-spacing:.08em;font-size:10.5px}
/* 墨色暖金时间轴：时间横坐标保持不变，同刻/近刻按像素在上下分层。 */
.fr-pointer-card{position:relative;background:radial-gradient(ellipse at 85% 0,#a8874610,transparent 65%),#211e19;border:1px solid #79613c66;border-radius:9px;box-shadow:inset 0 1px #e9cf8f0b,0 6px 20px #0002}
.fr-pointer-title{font-family:SimSun,serif;letter-spacing:.08em;font-size:1.2em;color:#e4cea1;border-bottom:1px solid #92784b36;padding-bottom:16px}
.fr-pointer-heading{background:linear-gradient(90deg,#a4894015,transparent 85%);border-left:2px solid #b89a5e;padding:12px 16px;margin-bottom:8px}
.fr-pointer-between{margin-left:auto;font-size:13px;line-height:1.9;overflow-wrap:anywhere;color:#d1c5af}.fr-pointer-between small{display:block;color:#b5a78e;font-size:12px}.fr-pointer-between-now{color:#e1c279}
.fr-pointer-axis .fr-pointer-track{height:2px;border:0;background:#73624770;box-shadow:none}
.fr-pointer-axis .fr-pointer-fill{background:linear-gradient(90deg,#8d7148,#d4b578);box-shadow:none}
.fr-pointer-axis .fr-pointer-node{width:28px!important;height:28px!important;margin-top:-14px;font:12px/26px Georgia,serif!important;text-align:center;border:1px solid #a48d62;box-shadow:0 0 0 4px #211e19;z-index:4;color:#e8d8b8;animation:none}
.fr-pointer-axis .fr-pointer-node.is-done{border-color:#d4b474;background:#b69a60;color:#201b13}
.fr-pointer-axis .fr-pointer-node.is-todo{background:#29241c;border-color:#8c7957;color:#d7cab0}
.fr-pointer-axis .fr-pointer-node.is-mutated,.fr-pointer-axis .fr-pointer-node.is-created{background:#3a2620;border-color:#ca926b;color:#efc09c}
.fr-pointer-axis .fr-pointer-node.is-created{border-style:dashed}.fr-pointer-axis .fr-pointer-node.is-created::after{display:none}
.fr-pointer-stem{position:absolute;display:block;width:1px;background:#a78a536b;pointer-events:none;z-index:1}
.fr-pointer-axis .fr-pointer-now{display:none}
.fr-pointer-axis .fr-pointer-now-tag{padding:5px 11px!important;background:#cfb274!important;color:#211d16;border-radius:4px;text-shadow:none;font:13px/1.7 SimSun,serif;letter-spacing:.12em;z-index:6}
.fr-pointer-now-tag::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #cfb274}
.fr-pointer-axis button.is-active,.fr-pointer-axis button:focus-visible{outline:2px solid #e6ca8e!important;outline-offset:4px}
.fr-pointer-list{display:grid;gap:10px;margin:14px 0 10px;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));align-items:stretch}
.fr-pointer-list .fr-pointer-lbl{position:relative;transform:none;display:block;width:100%;max-width:none;min-height:92px!important;
 white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;text-align:left;
 padding:14px!important;border:1px solid #80683f66!important;border-radius:6px;background:linear-gradient(145deg,#2c261e,#221f19)!important;
 box-shadow:inset 0 1px #e8c77e0a!important;font:15px/1.6 SimSun,serif;color:#e3d5bb;letter-spacing:.02em;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.fr-pointer-list .fr-pointer-lbl:hover{border-color:#c9a663!important;background:#30291f!important}
.fr-pointer-list .fr-pointer-lbl.is-active,.fr-pointer-list .fr-pointer-lbl:focus-visible{outline:2px solid #d9b97b;outline-offset:2px;border-color:#d6b575!important}
.fr-pointer-list .fr-pointer-number{display:inline-block;min-width:24px;text-align:center;border-radius:3px;background:#c7a66612;border:1px solid #ba9a5f55;font:12px/20px Georgia,serif;color:#dcc28b;padding:0 4px;margin-right:9px;vertical-align:1px}
.fr-pointer-list .fr-pointer-name{display:inline;vertical-align:top}
.fr-pointer-list .fr-pointer-node-date{display:block;font:12px/1.6 'Microsoft YaHei',sans-serif;color:#bcae94;margin:7px 0 0;letter-spacing:.01em}
.fr-pointer-list .fr-pointer-lbl.is-done{color:#e2cfaa;border-left:3px solid #bea065!important}
.fr-pointer-list .fr-pointer-lbl.is-todo{color:#cbbfa8;border-left:3px solid #74654c!important}
.fr-pointer-list .fr-pointer-lbl.is-mutated,.fr-pointer-list .fr-pointer-lbl.is-created{color:#e5b28e;border-left:3px solid #bd8662!important}
.fr-pointer-card .fr-pointer-key.is-seg{background:linear-gradient(90deg,#8d7148,#d4b578)}
.fr-pointer-card .fr-pointer-key.is-done{background:#b69a60}.fr-pointer-card .fr-pointer-key.is-todo{border-color:#a48d62}
.fr-pointer-card .fr-pointer-key.is-mutated,.fr-pointer-card .fr-pointer-key.is-created{background:#bd8662;border-color:#bd8662}
.fr-pointer-card .fr-pointer-footnote,.fr-pointer-card .fr-pointer-ends,.fr-pointer-card .fr-pointer-legend{color:#b5a78e}

/* ═══ 世界大事记（原著人物故事内新增一节）═══
 * 2026-11-02 玩家：「这个世界正文…没有一个显示展示的区域，可以加上去，
 * 也放在原著人物故事里」「把正文总结归纳成世界大事记」。
 * 用 ol/li 而不是段落堆叠：大事记本质是有序时间线，列表语义更准确，
 * 也方便后续单条展开。 */
.fr-canon-world-digest{margin:0 0 22px;padding:14px 16px;border:1px solid #8c785333;
  border-radius:10px;background:linear-gradient(135deg,#24231f,#1a1a18)}
.fr-canon-world-digest-head{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;
  padding-bottom:10px;border-bottom:1px solid #8c785322}
.fr-canon-world-digest-head h4{margin:0;font-size:15px;font-weight:600;color:#d8c399;letter-spacing:.02em}
.fr-canon-world-digest-meta{font-size:.8em;color:#8a8272}
.fr-canon-world-digest-empty{margin:0;color:#999787;font-size:.88em}
.fr-canon-world-digest-list{margin:0;padding-left:22px;color:#ddd5c6;font-size:.88em;line-height:1.75}
/* 大事记的状态徽标：进行中/已结束/已变异/受阻…
 * 2026-11-03 玩家要「开放态」：拿不准结束就明说「进行中」，
 * 所以徽标是信息本身，不是装饰 —— 颜色区分清楚，一眼能扫。 */
.fr-canon-world-digest-badge{flex:0 0 auto;font-size:.78em;line-height:1.5;padding:1px 7px;border-radius:999px;
  border:1px solid #8c785344;background:#2a2822;color:#a99b82;white-space:nowrap}
.fr-canon-world-digest-badge.is-ongoing{border-color:#5a7fa855;background:#1e2a33;color:#7fb3d5}
.fr-canon-world-digest-badge.is-completed{border-color:#5a8a6655;background:#1e2b22;color:#8fc79c}
.fr-canon-world-digest-badge.is-changed{border-color:#b08a4a66;background:#2e2718;color:#e0b866}
.fr-canon-world-digest-badge.is-blocked,
.fr-canon-world-digest-badge.is-cancelled{border-color:#a55a5a55;background:#2e1e1e;color:#d98c8c}
/* 「原创」角标：标出这条是玩家自己打出来的大事，不是原著年表本来有的。
 * 两者地位等位（玩家要求「没有分开的必要」），所以只是轻量角标，不分组、不弱化。 */
.fr-canon-world-digest-badge.is-player{border-color:#8a6fb055;background:#261e33;color:#b8a0d8}
.fr-canon-world-digest-place{flex:0 0 auto;font-size:.8em;color:#8a8272}
.fr-canon-world-digest-item{margin:0 0 10px}
.fr-canon-world-digest-item:last-child{margin-bottom:0}
.fr-canon-world-digest-item-top{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.fr-canon-world-digest-time{color:#a99b82;font-size:.86em;font-variant-numeric:tabular-nums;flex:0 0 auto}
.fr-canon-world-digest-title{color:#f0dfb6;font-weight:600}
.fr-canon-world-digest-history{margin-top:12px;border-top:1px solid rgba(180,152,100,.22);padding-top:8px}
.fr-canon-world-digest-history summary{cursor:pointer;padding:5px 0;color:var(--concurrent-evo-accent-text,#d5bc83)}
.fr-canon-world-digest-desc{margin:3px 0 0;color:#c5bfae;overflow-wrap:anywhere;white-space:pre-line}
/* 轨道上的浮动「此刻」文字已由列表版承载，这个元素只留作 title/aria 载体 */
.fr-pointer-now-tag.is-hidden{display:none}

.fr-pointer-ends{display:flex;justify-content:space-between;gap:16px;color:#a69e8d;font-size:.82em;
  font-variant-numeric:tabular-nums}
.fr-pointer-phase{margin-top:18px;color:#e8e1d2}
.fr-pointer-history,.fr-pointer-footnote{font-size:.83em;color:#999787;line-height:1.7;margin:8px 0}
.fr-pointer-footnote{margin-top:14px}

/* 图例 */
.fr-pointer-legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:16px;padding-top:12px;
  border-top:1px solid #8c78532b;font-size:11.5px;color:#8a8272}
.fr-pointer-legend span{display:inline-flex;align-items:center;gap:6px}
.fr-pointer-key{width:11px;height:11px;border-radius:50%;display:inline-block;flex:0 0 auto}
.fr-pointer-key.is-done{background:#5fbf7a}
.fr-pointer-key.is-todo{border:2px solid #e8e1d2;background:#24231f}
.fr-pointer-key.is-mutated{background:#e05c5c}
.fr-pointer-key.is-created{border:2px solid #e05c5c;background:#24231f;position:relative}
.fr-pointer-key.is-created::after{content:'';position:absolute;inset:2px;border-radius:50%;background:#e05c5c}
.fr-pointer-key.is-seg{width:20px;height:6px;border-radius:3px;background:linear-gradient(90deg,#3f7a4e,#8fd99f)}

/* ===== 二级弹窗：浮在视口层，可溢出卡片 ===== */
.fr-pointer-popup{position:fixed;z-index:35000;width:300px;max-width:calc(100vw - 20px);
  padding:13px 15px 12px;border:1px solid #8c785380;border-radius:10px;
  background:linear-gradient(150deg,#312e28,#1a1916);
  box-shadow:0 16px 42px #000000d9,0 0 0 1px #00000059,inset 0 1px #e3cf9633;
  font-size:12px;line-height:1.68;display:none;text-align:left}
.fr-pointer-popup[data-open="true"]{display:block}
.fr-pointer-popup::before{content:'';position:absolute;left:var(--arrow,50%);width:9px;height:9px;
  transform:translateX(-50%) rotate(45deg);background:#312e28;
  border-right:1px solid #8c785380;border-bottom:1px solid #8c785380;bottom:-5px}
.fr-pointer-popup[data-side="below"]::before{bottom:auto;top:-5px;border:0;
  border-left:1px solid #8c785380;border-top:1px solid #8c785380;background:#312e28}
.fr-pointer-pop-h{display:flex;align-items:center;gap:7px;margin:0 24px 9px 0;font-weight:600;font-size:12.5px;color:#e8e1d2}
.fr-pointer-pop-h .fr-pointer-tag{padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;letter-spacing:.02em;flex:0 0 auto}
.fr-pointer-tag.is-done{color:#9dd6a2;background:rgba(76,175,80,.18);border:1px solid rgba(129,199,132,.42)}
.fr-pointer-tag.is-todo{color:#a9bcd2;background:rgba(126,143,166,.15);border:1px solid rgba(126,143,166,.4)}
.fr-pointer-tag.is-mutated{color:#f0a0a0;background:rgba(224,92,92,.2);border:1px solid rgba(224,92,92,.5)}
.fr-pointer-tag.is-created{color:#f0a0a0;background:rgba(224,92,92,.12);border:1px solid rgba(224,92,92,.45);border-style:dashed}
.fr-pointer-pop-row{display:flex;gap:10px;padding:7px 0;border-top:1px solid #8c785322}
.fr-pointer-pop-row:first-of-type{border-top:0;padding-top:2px}
.fr-pointer-pop-row .k{flex:0 0 62px;color:#8a8272;font-size:11.5px;letter-spacing:.02em}
.fr-pointer-pop-row .v{flex:1;color:#ddd5c6;overflow-wrap:anywhere;min-width:0}
.fr-pointer-popup .fr-pointer-estimate-basis{font-size:12px;line-height:1.65;color:#afa58f;margin:10px 0 0}
.fr-pointer-pop-row .v em{color:#e88383;font-style:normal}
.fr-pointer-pop-row .v b{color:#f0dfb6;font-weight:600}
.fr-pointer-pop-close{position:absolute;top:7px;right:9px;background:none;border:0;color:#8a8272;
  font-size:15px;cursor:pointer;line-height:1;padding:3px 5px;border-radius:4px}
.fr-pointer-pop-close:hover{color:#e8e1d2;background:#ffffff0f}

.fr-pointer-popup{box-sizing:border-box;max-height:70vh;overflow:auto;color:#e8e1d2;font:12px/1.68 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.fr-pointer-popup[data-open="true"]{display:block!important}.fr-pointer-pop-close{padding:3px 5px!important;min-width:0!important;background:none!important;border:0!important;box-shadow:none!important}
@media(prefers-reduced-motion:reduce){.fr-pointer-node{animation:none!important}}
/* 卡片：照搬 .fr-lg-fr-pointer-card */
.fr-lg-card{min-width:0;padding:20px 22px;margin:0 0 14px;border:1px solid #8c785344;border-radius:12px;
  background:radial-gradient(ellipse at 15% 0%,#b89d6320,transparent 65%),linear-gradient(135deg,#24231f,#181917);
  box-shadow:inset 0 1px #e3cf9620;position:relative}
.fr-lg-title{color:#d8c399;margin:0 0 4px;font-size:1.07em;line-height:1.6;font-weight:600}
.fr-lg-sub{color:#8a8272;font-size:.82em;margin:0 0 16px}

/* 表头摘要 */
.fr-lg-summary{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.fr-lg-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;
  font-size:12px;font-weight:600;letter-spacing:.01em;border:1px solid transparent;white-space:nowrap}
.fr-lg-chip .n{font-variant-numeric:tabular-nums;opacity:.85;font-weight:700}
.fr-lg-chip.gold{color:#f0dcae;background:rgba(213,188,131,.18);border-color:rgba(213,188,131,.5)}
.fr-lg-chip.green{color:#9dd6a2;background:rgba(76,175,80,.18);border-color:rgba(129,199,132,.42)}
.fr-lg-chip.blue{color:#a9bcd2;background:rgba(126,143,166,.15);border-color:rgba(126,143,166,.4)}
.fr-lg-chip.red{color:#f0a0a0;background:rgba(224,92,92,.16);border-color:rgba(224,92,92,.45)}
.fr-lg-chip.dim{color:#9b9086;background:rgba(155,144,134,.1);border-color:rgba(155,144,134,.28)}

/* 分区 */
.fr-lg-sec{margin-top:18px;border-top:1px solid #8c78532b;padding-top:14px}
.fr-lg-sec:first-of-type{border-top:0;padding-top:0;margin-top:0}
.fr-lg-h{display:flex;align-items:center;gap:9px;margin:0 0 11px;cursor:pointer;
  font-size:13px;font-weight:600;color:#d7ae76;user-select:none}
.fr-lg-h .cnt{color:#8a8272;font-weight:400;font-size:11.5px;font-variant-numeric:tabular-nums}
.fr-lg-h .fr-lg-arw{font-size:9px;color:#8a8272;transition:transform .16s;display:inline-block}
.fr-lg-h[aria-expanded="true"] .fr-lg-arw{transform:rotate(90deg)}
.fr-lg-body[data-open="false"]{display:none}

/* 键值行 */
.kv{display:flex;gap:11px;padding:6px 0;font-size:12.5px;border-top:1px solid #8c78531c}
.kv:first-child{border-top:0;padding-top:0}
.kv .k{flex:0 0 76px;color:#8a8272;font-size:11.5px;letter-spacing:.02em}
.kv .v{flex:1;color:#ddd5c6;overflow-wrap:anywhere;min-width:0}
.kv .v b{color:#f0dfb6;font-weight:600}
.kv .v em{color:#e88383;font-style:normal}
.kv .v .n{color:#9dd6a2}

/* 事件卡（嵌套） */
.fr-lg-ev{border:1px solid #8c78532e;border-radius:9px;padding:12px 14px;margin:0 0 10px;
  background:rgba(140,120,83,.045)}
.fr-lg-ev-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin:0 0 9px}
.fr-lg-ev-code{color:#c8a86a;font-weight:700;font-size:12.5px}
.fr-lg-ev-name{color:#e8e1d2;font-weight:600;font-size:12.5px}
.fr-lg-ev-date{color:#8a8272;font-size:11.5px;font-variant-numeric:tabular-nums;margin-left:auto}
.fr-lg-badge{padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:600;flex:0 0 auto}
.fr-lg-badge.ongoing{color:#f0dcae;background:rgba(213,188,131,.18);border:1px solid rgba(213,188,131,.45)}
.fr-lg-badge.completed{color:#9dd6a2;background:rgba(76,175,80,.18);border:1px solid rgba(129,199,132,.42)}
.fr-lg-badge.changed{color:#f0a0a0;background:rgba(224,92,92,.16);border:1px solid rgba(224,92,92,.45)}
.fr-lg-badge.blocked{color:#e5b477;background:rgba(229,180,119,.15);border:1px solid rgba(229,180,119,.4)}
.fr-lg-badge.expired,.fr-lg-badge.cancelled{color:#a9bcd2;background:rgba(126,143,166,.15);border:1px solid rgba(126,143,166,.4)}

/* 节点条 */
.nodes{display:flex;flex-wrap:wrap;gap:7px;margin:9px 0 0}
.nd{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:7px;
  font-size:11.5px;border:1px solid #8c78532e;background:#1c1a17;cursor:pointer}
.nd:hover{border-color:#8c785366}
.nd .fr-lg-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.nd.fr-lg-done .fr-lg-dot{background:#5fbf7a}
.nd.fr-lg-todo .fr-lg-dot{border:1.5px solid #e8e1d2;background:transparent}
.nd.fr-lg-mutated .fr-lg-dot{background:#e05c5c}
.nd.fr-lg-created .fr-lg-dot{border:1.5px solid #e05c5c;background:#24231f;box-shadow:inset 0 0 0 1.5px #e05c5c}
.nd.fr-lg-mutated,.nd.fr-lg-created{color:#e88383}
.nd .fr-lg-t{color:#ddd5c6}

/* 列表 */
.fr-lg-lst{margin:0;padding:0;list-style:none}
.fr-lg-lst li{padding:5px 0 5px 15px;position:relative;font-size:12.5px;color:#ddd5c6;
  border-top:1px solid #8c78531c;overflow-wrap:anywhere}
.fr-lg-lst li:first-child{border-top:0}
.fr-lg-lst li::before{content:'·';position:absolute;left:4px;color:#8a8272}
.fr-lg-lst.fr-lg-ok li::before{content:'✓';color:#5fbf7a;font-size:10px;top:6px}
.fr-lg-lst.fr-lg-wait li::before{content:'○';color:#a69e8d;font-size:10px;top:6px}
.fr-lg-lst.fr-lg-warn li::before{content:'!';color:#e05c5c;font-weight:700}

/* 空态 */
.fr-lg-empty{color:#6f665e;font-size:12px;font-style:normal;padding:4px 0}

/* 折叠小标 */
.fr-lg-foot{margin-top:14px;padding-top:11px;border-top:1px solid #8c78532b;
  display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:#6f665e}

/* 已收尾事件：再套一层折叠，收起时只留一行摘要 */
.fr-lg-ev.fr-lg-done-ev{border-color:#8c785325;background:rgba(140,120,83,.028)}
.fr-lg-ev.fr-lg-done-ev>.fr-lg-ev-head{cursor:pointer;margin:0;user-select:none}
.fr-lg-ev.fr-lg-done-ev>.fr-lg-ev-head .fr-lg-arw{font-size:9px;color:#8a8272;transition:transform .16s;display:inline-block}
.fr-lg-ev.fr-lg-done-ev>.fr-lg-ev-head[aria-expanded="true"] .fr-lg-arw{transform:rotate(90deg)}
.fr-lg-ev.fr-lg-done-ev>.fr-lg-ev-head:hover .fr-lg-ev-name{color:#f0dfb6}
.fr-lg-ev-body[data-open="false"]{display:none}
.fr-lg-ev-body{margin-top:10px}
.fr-lg-ev-sum{color:#6f665e;font-size:11.5px;margin-left:2px}

.fr-lg-h{list-style:none}.fr-lg-h::-webkit-details-marker{display:none}.fr-lg-h::before{content:'▶';color:#8a8272;font-size:9px;transition:transform .16s}.fr-lg-sec[open]>.fr-lg-h::before{transform:rotate(90deg)}
.fr-lg-sec>.fr-lg-body{padding-top:3px}.fr-lg-ev summary{list-style:none;cursor:pointer}.fr-lg-ev summary::before{content:'▶';font-size:9px;color:#8a8272}.fr-lg-ev[open]>summary::before{transform:rotate(90deg)}
.fr-lg-kv{display:flex!important}.fr-lg-record{padding:5px 0}.fr-ledger-node{display:inline-flex!important;gap:6px;align-items:center;padding:3px 9px!important;margin:3px!important;border:1px solid #8c78532e!important;border-radius:7px!important;background:#1c1a17!important;color:#ddd5c6!important;font-size:11.5px!important;box-shadow:none!important}
.fr-ledger-node::before{content:'';width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#5fbf7a}.fr-ledger-node.is-todo::before{border:1.5px solid #e8e1d2;background:transparent}.fr-ledger-node.is-mutated::before{background:#e05c5c}.fr-ledger-node.is-created::before{border:1.5px solid #e05c5c;background:#24231f;box-shadow:inset 0 0 0 1.5px #e05c5c}.fr-ledger-node.is-mutated,.fr-ledger-node.is-created{color:#e88383!important}
@media(max-width:500px){.fr-lg-card{padding:16px 12px}.fr-lg-kv{gap:8px}.fr-lg-kv .k{flex-basis:64px}.fr-lg-summary{gap:6px}.fr-lg-chip{font-size:11px;padding:3px 8px}}

.fr-lg-card>.fr-lg-sec{border:0!important;border-top:1px solid #8c78532b!important;border-radius:0!important;background:none!important;margin:18px 0 0!important;padding:14px 0 0!important}.fr-lg-card>.fr-lg-sec:first-of-type{border-top:0!important;margin-top:0!important;padding-top:0!important}

.fr-lg-node-record{display:inline-block;vertical-align:top}
.fr-lg-sub-head{display:flex;align-items:center;gap:8px;margin:12px 0 6px;font-size:11.5px;color:#a99b82;letter-spacing:.06em}
.fr-lg-sub-head:first-child{margin-top:0}
.fr-lg-sub-t{font-weight:600}
.fr-lg-sub-n{color:#6f665e;font-variant-numeric:tabular-nums}
.fr-lg-actor{display:grid;grid-template-columns:minmax(4.5em,auto) 1fr;gap:4px 10px;align-items:baseline;padding:5px 0;border-top:1px solid #8c78531c;font-size:12.5px}
@media(max-width:640px){.fr-lg-actor{grid-template-columns:1fr;gap:2px}.fr-lg-actor-name{max-width:none}}
.fr-lg-actor:first-child{border-top:0}
.fr-lg-actor-name{flex:0 0 auto;min-width:64px;max-width:9em;color:#d7ae76;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fr-lg-actor-note{color:#ddd5c6;overflow-wrap:anywhere}
.fr-lg-actor-note.warn{color:#e88383}
.fr-lg-nodebar{display:flex;flex-wrap:wrap;gap:7px}
.fr-lg-kv .v>div{min-width:0}
.fr-lg-nodechip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:7px;font-size:11.5px;border:1px solid #8c78532e;background:#1c1a17;cursor:pointer;color:#ddd5c6}
.fr-lg-nodechip:hover{border-color:#8c785366}
.fr-lg-nodechip.is-mutated,.fr-lg-nodechip.is-created{color:#e88383}
.fr-lg-nodechip::before{content:'';width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#5fbf7a}
.fr-lg-nodechip.is-todo::before{border:1.5px solid #e8e1d2;background:transparent}
.fr-lg-nodechip.is-mutated::before{background:#e05c5c}
.fr-lg-nodechip.is-created::before{border:1.5px solid #e05c5c;background:#24231f;box-shadow:inset 0 0 0 1.5px #e05c5c}

/* 检索日志结构化视图：补演要和原著指导一样看得懂，不要一坨原始文本。 */
.fr-canon-searchlog{display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:8px 0;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(0,0,0,.22);font-size:12.5px;line-height:1.7}
.fr-canon-searchlog-head{font-weight:600;color:#e5c78a;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.08)}
.fr-canon-searchlog-warn{color:#f0b464}
.fr-canon-searchlog-query{margin-top:8px;font-weight:600;color:#9fd4f0;overflow-wrap:anywhere}
/* 图标固定宽度，文字必须吃掉剩余空间；否则 flex 会把文字压成一条竖线（玩家实测）。 */
.fr-canon-searchlog-qicon{margin-right:6px}
.fr-canon-searchlog-qtext{overflow-wrap:anywhere}
.fr-canon-searchlog-hit{padding:2px 0 2px 18px;overflow-wrap:anywhere}
.fr-canon-searchlog-hit.is-pass{color:#8fd18a}
.fr-canon-searchlog-hit.is-low{color:#f0b464}
.fr-canon-searchlog-hit.is-miss{color:#8b8578}
.fr-canon-searchlog-summary{margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.10)}
.fr-canon-searchlog-summary-title{font-weight:600;color:#e5c78a;margin-bottom:4px}
.fr-canon-searchlog-line{padding-left:14px;color:#c5bca8;overflow-wrap:anywhere}
.fr-canon-searchlog-raw{margin-top:8px}
.fr-canon-searchlog-raw>summary{cursor:pointer;color:#9a9488;font-size:12px}
`;document.head.appendChild(style);
  }
  document.addEventListener('click',function(event){
    var target=event.target&& event.target.closest?event.target.closest('[data-fr-canon-action]'):null;if(!target)return;
    var action=target.dataset.frCanonAction;
    var task=action==='settings'?ceBridgeOpenSettings():action==='stories'?frCanonOpenStories():action==='trace'?frCanonOpenTrace():action==='check'?frCanonCheckResources():action==='replay'?frReplayOpenPicker('canon'):null;
    if(action==='timeline'){var nativeButton=document.getElementById('open-world-evolution-timeline-btn');if(nativeButton)nativeButton.click();}
    if(action==='stop'){
      frCanonStopAll();
    }
    if(task&& typeof task.catch==='function')task.catch(function(error){var status=document.getElementById('fr-canon-sidebar-status');if(status)status.textContent='操作失败：'+error.message;});
  });
  frCanonRefreshSidebar();
}
frCanonInitUI();
