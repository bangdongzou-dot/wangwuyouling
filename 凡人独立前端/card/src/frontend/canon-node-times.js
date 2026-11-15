/**
 * 原著补演 · 进度指针节点「预计时间」纯函数
 *
 * 设计依据（任务书 T-NODE-TIME-013，冻结设计，不要改成均分时间）：
 *   1. **只有明确的 at 是事实锚点**。未知 at 只推算可信区间，
 *      绝不把推算写回 at，不改 state / 已完成计数。
 *      没有证据不编造精确小时分钟，也不把所有未知节点平摊成假精确日期。
 *   2. 初始区间取 event.startAt 与 event.referenceEnd||event.endAt；
 *      本轮时间 range.end 是「此刻」。done 节点上界不得晚于此刻；
 *      todo 节点下界不得早于此刻。相邻已知 at 的节点分别约束下/上界。
 *      未知节点同约束可显示相同区间——这是诚实的估计，不是缺陷。
 *   3. 过去 done 用「推算 YYYY.MM.DD—YYYY.MM.DD」；未完成用「预计 …」。
 *      同日可合并为一日；明确 at 展示原值。
 *      上下界矛盾时不伪造日期，给开放区间（如「预计晚于 0010.06.20」），
 *      point 用有效边界。全部日期都不可解析才 label=「本轮时间范围待确认」。
 *   4. 当前时间晚于参考终点时，未来节点仍必须 >= 当前，不挤回旧参考区间。
 *      延期已知可在 basis 注明；**不能由日期逾期反推事件完成**。
 *   5. parse 来自 core/interval.js，数值是 31 日定长进位分钟：
 *        (((year*12+(month-1))*31+(day-1))*24+hour)*60+minute
 *      输出推算区间**只到日**，不擅用 Gregorian/真实现代年月，
 *      也不把这个数当 Unix 时间。允许返回区间中点作可视定位，
 *      但必须保持 estimated=true，不当成实际发生日。
 *
 * 本文件不使用 ESM export（与 frontend 注入约定一致）：注入后为全局函数。
 */

/**
 * @param {Array<{nodeId?:string,title?:string,at?:string,state?:string}>} nodes 业务先后排列
 * @param {{startAt?:string,referenceEnd?:string,endAt?:string,title?:string,eventId?:string}} event
 * @param {{start?:string,end?:string}} range 本轮时间范围，end 为「此刻」
 * @param {(text:string)=>number|null} parse core/interval.js 的 parseTimePoint
 * @returns {Array<object>} 全新行；每行在原字段基础上附 timeEstimate
 */
// 参考事项不是轴上的独立节点，原文仍在「尚未发生」中可查。
function frCanonPointerVisibleNodes(before,current) {
  var registry=new Map();
  var sourceOnly=typeof ceBridgeCore==='function'?ceBridgeCore()?.['canon-event-details']?.isOrdinarySourceOnlyNode:null;
  [before,current].forEach(function(row){(row?.nodes||[]).forEach(function(n){if(!sourceOnly?.(n))registry.set(n.nodeId||n.title,{...n});});});
  return Array.from(registry.values());
}

function frCanonPointerMilestones(rows){
  if(rows.length<=6)return {visible:rows,additional:[]};
  var changes=rows.filter(n=>['mutated','created'].includes(n.state));
  var done=rows.filter(n=>n.state==='done'),future=rows.filter(n=>n.state==='todo');
  var priority=[done.at(-1),future[0],...changes.slice().reverse(),done[0],future.at(-1),...rows.filter(n=>n.result||n.original||n.at||n.estimatedAt),...rows];
  var chosen=new Set();
  for(var row of priority){if(row)chosen.add(row);if(chosen.size===6)break;}
  return {visible:rows.filter(row=>chosen.has(row)),additional:rows.filter(row=>!chosen.has(row))};
}

// Date fields on a node represent one day or time, unlike the event window.
function frCanonSingleNodeDate(value){
  var raw=String(value??'').trim();
  return /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:[ T]+\d{1,2}:\d{2})?$/.test(raw)?raw:'';
}

function frCanonNodeDay(point){
  if(!Number.isFinite(point)||point<0)return '';
  var index=Math.floor(point/1440),month=Math.floor(index/31),day=index%31+1;
  return String(Math.floor(month/12)).padStart(4,'0')+'.'+String(month%12+1).padStart(2,'0')+'.'+String(day).padStart(2,'0');
}

function frCanonWithDisplayedNodeDate(row,point){
  var t=row.timeEstimate;
  if(!t?.estimated||!t.start||!t.end||!Number.isFinite(point))return row;
  var day=frCanonNodeDay(point);
  return day?{...row,timeEstimate:{...t,point,label:(row.state==='todo'?'预计 ':'推算 ')+day}}:row;
}

function frCanonEstimateNodeTimes(nodes, event, range, parse) {
  var list = Array.isArray(nodes) ? nodes : [];
  var ev = event && typeof event === 'object' ? event : {};
  var rg = range && typeof range === 'object' ? range : {};
  var parseFn = typeof parse === 'function' ? parse : null;

  /* ── 时间点解析小工具（全部走传入的 parse，不自己造口径）── */
  function toPoint(text) {
    if (!parseFn) return null;
    var raw = text === null || text === undefined ? '' : String(text).trim();
    if (!raw) return null;
    var n = parseFn(raw);
    return typeof n === 'number' && isFinite(n) ? n : null;
  }

  /* 定长 31 日反解：把分钟序号还原成 年.月.日（只到日，丢掉时分） */
  function toDateText(point) {
    if (typeof point !== 'number' || !isFinite(point)) return '';
    var minutes = Math.floor(point);
    if (minutes < 0) return '';
    var dayIndex = Math.floor(minutes / (24 * 60));
    var yearIndex = Math.floor(dayIndex / 31);
    var day = dayIndex - yearIndex * 31 + 1;
    var monthIndex = Math.floor(yearIndex / 12);
    var month = yearIndex - monthIndex * 12 + 1;
    return pad4(monthIndex) + '.' + pad2(month) + '.' + pad2(day);
  }
  function pad2(n) { n = Number(n) || 0; return (n < 10 ? '0' : '') + n; }
  function pad4(n) { n = Number(n) || 0; var s = String(n); while (s.length < 4) s = '0' + s; return s; }

  /* 取某点所在「日」的起止（用于把区间收拢到日粒度） */
  var DAY = 24 * 60;
  function dayStart(point) { return Math.floor(point / DAY) * DAY; }
  function dayEnd(point) { return dayStart(point) + DAY - 1; }

  /* ── 基础锚点 ── */
  var nowPoint = toPoint(rg.end);                       /* 此刻 */
  var refEndPoint = toPoint(ev.referenceEnd);
  if (refEndPoint === null) refEndPoint = toPoint(ev.endAt);
  var startPoint = toPoint(ev.startAt);

  /* 区间下界首选 event.startAt；没有就用 range.start */
  var rangeStartPoint = toPoint(rg.start);
  var lowerSeed = startPoint !== null ? startPoint : rangeStartPoint;

  /* 参考终点（上界种子）。若此刻已越过它，仍以「此刻」为未来下界 —— 见设计 4 */
  var upperSeed = refEndPoint;
  var refEndPassed = refEndPoint !== null && nowPoint !== null && nowPoint > refEndPoint;

  /* ── 每个节点的已知锚点 ── */
  var anchors = list.map(function (row) {
    var planned=row?.state==='todo';
    var atText=frCanonSingleNodeDate(planned?(row?.estimatedAt||row?.at):row?.at);
    var point = toPoint(atText);
    if(planned&&point!==null&&((nowPoint!==null&&dayEnd(point)<nowPoint)||(refEndPoint!==null&&point>refEndPoint)))point=null;
    return { row: row, atText: atText, point: point, known: point !== null, planned:planned };
  });

  var hasAnyKnownDate = anchors.some(function (a) { return a.known; });
  var hasAnyTimeInput = nowPoint !== null || refEndPoint !== null || startPoint !== null || rangeStartPoint !== null || hasAnyKnownDate;

  return anchors.map(function (item, index) {
    var row = item.row && typeof item.row === 'object' ? item.row : {};
    var out = {};
    /* 浅拷贝原字段，保证「返回全新行、不改原输入」 */
    Object.keys(row).forEach(function (k) { out[k] = row[k]; });

    var isDone = String(row.state || '') !== 'todo';
    var atKnown = item.known&&!item.planned;

    /* ① 已有可解析 at：原样保留，不推算 */
    if (atKnown) {
      out.at = row.at;
      out.timeEstimate = {
        estimated: false,
        label: item.atText,
        start: item.atText,
        end: item.atText,
        point: item.point,
        basis: '节点已有明确时间 at=' + item.atText + '，按事实锚点原样展示，不做推算。'
      };
      return out;
    }

    /* ② 连任何时间输入都没有：诚实地说明缺输入，不编日期 */
    if (!hasAnyTimeInput || !parseFn) {
      out.timeEstimate = {
        estimated: false,
        label: '本轮时间范围待确认',
        start: '',
        end: '',
        point: null,
        basis: buildMissingBasis(parseFn, ev, rg)
      };
      return out;
    }

    /* ③ 推算区间 —— 用相邻事实锚点夹逼，而不是均分 */
    var prevAnchor = null;
    var nextAnchor = null;
    for (var i = index - 1; i >= 0; i -= 1) {
      if (anchors[i].known) { prevAnchor = anchors[i]; break; }
    }
    for (var j = index + 1; j < anchors.length; j += 1) {
      if (anchors[j].known) { nextAnchor = anchors[j]; break; }
    }

    /* 下界：优先「上一已知锚点」，其次「本轮起点」；todo 再抬到「此刻」 */
    var lower = prevAnchor ? prevAnchor.point : lowerSeed;
    /* 上界：优先「下一已知锚点」，其次「参考终点」 */
    var upper = nextAnchor ? nextAnchor.point : upperSeed;

    var basisParts = [];
    /* 方向必须写对：prevAnchor 约束下界（节点排它之后），nextAnchor 约束上界（节点排它之前） */
    if (prevAnchor) basisParts.push('下界参考前序已知节点 at=' + prevAnchor.atText);
    else if (lowerSeed !== null) basisParts.push('下界取自 ' + (startPoint !== null ? 'event.startAt=' + String(ev.startAt) : 'range.start=' + String(rg.start)));
    if (nextAnchor) basisParts.push('上界参考后续节点 ' + (nextAnchor.planned?'预计 ':'at=') + nextAnchor.atText);
    else if (refEndPoint !== null) basisParts.push('上界参考事件终点 ' + String(ev.referenceEnd !== undefined && ev.referenceEnd !== null && String(ev.referenceEnd) !== '' ? ev.referenceEnd : ev.endAt));

    var conflicting = false;

    if (isDone) {
      /* done：区间必须落在「此刻」之前（上界不晚于此刻） */
      if (nowPoint !== null && (upper === null || upper > nowPoint)) upper = nowPoint;
      if (nowPoint !== null && lower !== null && lower > nowPoint) {
        /* 下界已越过此刻 → 矛盾，不伪造 */
        conflicting = true;
      }
      basisParts.push('已完成节点上界不晚于此刻' + (nowPoint !== null ? '（range.end=' + String(rg.end) + '）' : ''));
    } else {
      /* todo：下界不得早于此刻 —— 这是设计 4 的核心 */
      if (nowPoint !== null && (lower === null || lower < nowPoint)) lower = nowPoint;
      basisParts.push('未完成节点下界不早于此刻' + (nowPoint !== null ? '（range.end=' + String(rg.end) + '）' : ''));
    }

    /* 此刻越过参考终点：未来节点仍 >= 此刻，不挤回旧区间 */
    if (refEndPassed && !isDone) {
      upper = null; /* 开放上界，不假装知道 */
      basisParts.push('此刻已晚于参考终点 ' + toDateText(refEndPoint) + '，不把预计时间挤回旧区间；日期逾期不能反推事件已完成');
    } else if (refEndPassed) {
      /* done 且已越过参考终点：上界仍取此刻，但注明冲突 */
      basisParts.push('此刻已晚于参考终点 ' + toDateText(refEndPoint) + '，按上界不晚于此刻处理');
    }

    /* 上下界矛盾：不伪造日期，给开放区间 */
    if (lower !== null && upper !== null && lower > upper) {
      conflicting = true;
    }

    // Only explicit estimates that fit the current window can determine a marker.
    // Older saves used at for future nodes, so read it as an estimate only.
    var estimateText=frCanonSingleNodeDate(row.estimatedAt||(!isDone?row.at:''));
    var explicit=toPoint(estimateText);
    if(!conflicting&&explicit!==null&&(lower===null||dayEnd(explicit)>=lower)&&(upper===null||explicit<=upper)){
      if(lower!==null)explicit=Math.max(explicit,lower);
      var estimateDay=toDateText(explicit);
      out.timeEstimate={estimated:true,label:(isDone?'推算 ':'预计 ')+estimateDay,start:estimateDay,end:estimateDay,point:explicit,
        basis:'该日期依据本轮剧情及先后约束推算，尚非确认发生日。'};
      return out;
    }

    var startText = '';
    var endText = '';
    var point = null;
    var label = '';

    if (conflicting) {
      /* 开放区间：只给一个有效边界 */
      var edge = isDone ? (upper !== null ? upper : nowPoint !== null ? nowPoint : lower) : (lower !== null ? lower : upper);
      point = edge;
      var edgeText = edge !== null ? toDateText(edge) : '';
      var isFutureOpen = !isDone;
      if (edgeText) {
        label = isFutureOpen ? '预计晚于 ' + edgeText : '推算不晚于 ' + edgeText;
        if (!isDone) startText = edgeText; /* 开放上界 */
        else endText = edgeText;
      } else {
        label = '本轮时间范围待确认';
      }
      basisParts.push('时间约束冲突（下界晚于上界），不伪造具体日期，只给有效边界');
    } else {
      /* 收拢到日粒度：下界取当日 0 点、上界取当日末尾，输出只到日 */
      var lo = lower !== null ? dayStart(lower) : null;
      var hi = upper !== null ? dayEnd(upper) : null;
      if (lo !== null && hi !== null && lo > hi) { lo = dayStart(upper) ; hi = dayEnd(upper) }

      var loText = lo !== null ? toDateText(lo) : '';
      var hiText = hi !== null ? toDateText(hi) : '';
      startText = loText;
      endText = hiText;

      /* 中点作可视定位（可能越出日界，故先夹回区间再取日） */
      if (lo !== null && hi !== null) {
        point = lo + Math.floor((hi - lo) / 2);
      } else if (lo !== null) {
        point = lo;
      } else if (hi !== null) {
        point = hi;
      }
      if (point !== null) {
        if (lower !== null && point < lower) point = lower;
        if (upper !== null && point > upper) point = upper;
      }

      if (loText && hiText && loText === hiText) {
        label = (isDone ? '推算 ' : '预计 ') + loText; /* 同日合并为一日 */
      } else if (loText && hiText) {
        label = (isDone ? '推算 ' : '预计 ') + loText + '—' + hiText;
      } else if (loText) {
        /* 开放上界：任务书示例文案是「预计晚于 YYYY.MM.DD」 */
        label = (isDone ? '推算晚于 ' : '预计晚于 ') + loText;
      } else if (hiText) {
        label = (isDone ? '推算早于 ' : '预计早于 ') + hiText;
      } else {
        label = '本轮时间范围待确认';
      }
    }

    /* 只有「确实没有任何日期信息」时才降级为待确认；
     * 冲突分支已给出有效边界文案，不能被这里抹掉。 */
    if (label === '') label = '本轮时间范围待确认';
    if (label !== '本轮时间范围待确认' && !startText && !endText && point === null) {
      label = '本轮时间范围待确认';
    }

    out.timeEstimate = {
      estimated: true,
      label: label,
      start: startText,
      end: endText,
      point: point,
      basis: basisParts.join('；') + '；推算区间只到日，为可信估计，不是实际发生日。'
    };
    /* 关键：不把推算写进 at —— out.at 保持原值（可能 undefined） */
    if (!('at' in out)) out.at = row.at;
    return out;
  });
}

/* 缺输入时把「缺什么」说清楚，而不是笼统说未标日期 */
function buildMissingBasis(parseFn, ev, rg) {
  var missing = [];
  if (!parseFn) missing.push('未提供 parseTimePoint');
  var hasStart = ev && String(ev.startAt === undefined || ev.startAt === null ? '' : ev.startAt).trim() !== '';
  var hasEnd = ev && String(ev.endAt === undefined || ev.endAt === null ? '' : ev.endAt).trim() !== '';
  var hasRef = ev && String(ev.referenceEnd === undefined || ev.referenceEnd === null ? '' : ev.referenceEnd).trim() !== '';
  var hasNow = rg && String(rg.end === undefined || rg.end === null ? '' : rg.end).trim() !== '';
  if (!hasStart && !hasEnd && !hasRef) missing.push('事件未提供 startAt/referenceEnd/endAt');
  if (!hasNow) missing.push('本轮未提供 range.end（此刻）');
  if (!missing.length) missing.push('所有时间输入均无法解析为时间点');
  return '缺输入：' + missing.join('、') + '。没有可用锚点时不编造日期。';
}

// 只调整展示位置：同一预计区间内按事件顺序展开，不改 at/预计区间或实际进度。
function frCanonSpreadEstimatedNodes(nodes,event,range,parse) {
  var rows=Array.isArray(nodes)?nodes:[],read=typeof parse==='function'?parse:function(){return null;};
  var points=rows.map(function(row){return row.timeEstimate?.point??read(row.at);});
  var groups=new Map(),start=read(event?.startAt),end=read(event?.endAt),now=read(range?.end);
  rows.forEach(function(row,index){
    var t=row.timeEstimate;if(t?.estimated!==true)return;
    var lo=read(t.start),hi=read(t.end);if(!Number.isFinite(lo)||!Number.isFinite(hi))return;
    if(Number.isFinite(start))lo=Math.max(lo,start);if(Number.isFinite(end))hi=Math.min(hi,end);
    if(Number.isFinite(now)){if(row.state==='done')hi=Math.min(hi,now);else lo=Math.max(lo,now);}
    if(hi<=lo)return;
    var key=lo+'|'+hi,group=groups.get(key);if(!group){group={lo:lo,hi:hi,indexes:[]};groups.set(key,group);}group.indexes.push(index);
  });
  groups.forEach(function(group){if(group.indexes.length<2)return;group.indexes.forEach(function(index,i){points[index]=group.lo+(group.hi-group.lo)*(i+1)/(group.indexes.length+1);});});
  return points;
}

/* 供测试/宿主按需取用（不作为 ESM 导出） */
if (typeof globalThis !== 'undefined') {
  globalThis.frCanonEstimateNodeTimes = frCanonEstimateNodeTimes
  globalThis.frCanonPointerVisibleNodes = frCanonPointerVisibleNodes
  globalThis.frCanonSpreadEstimatedNodes = frCanonSpreadEstimatedNodes
  globalThis.frCanonEstimateNodeTimesBuildMissingBasis = buildMissingBasis
}
