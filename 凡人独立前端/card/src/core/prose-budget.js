// 篇幅按本人实际事件段扩展；仅容量不足时拆分，同一事件不按经过天数乘算。
import {normalizeRequestLimits,packRequestMaterials} from './request-budget.js';
import {splitHandoffStory} from './prose-validate.js';

export function proseEventCount(material){
  const segments=material?.material?.eventSegments || [];
  return Math.max(1,new Set(segments.map((row,i)=>row.code||row.start+'|'+row.end+'|'+i)).size);
}
export function withProseBudget(item,base){
  return {...item,material:{...item.material,proseBaseChars:base,proseMaxChars:base*proseEventCount(item)}};
}
export function splitProseMaterial(item,limits={}){
  const mat=item.material || {},segments=mat.eventSegments || [],capacity=normalizeRequestLimits(limits);
  const base=Number(mat.proseBaseChars)||Number(mat.proseMaxChars)||400;
  if(segments.length<2 || (Number(mat.proseMaxChars)||base)+500<=capacity.maxOutputChars)return [item];
  /* 2026-11-02 复盘：eventSegments 现在混有「空白段」（gap:true）。
   * 按段数分批会把空白段单独切出去，模型只看到一段空白，写出来的东西
   * 和前后事件完全脱节；而且分批后 timeRange 取 events[0].start/at(-1).end
   * 也会算错（空白段的 start 可能早于第一个事件）。
   *
   * 处理：分批时**保持空白段跟着它后面的那个事件段**，不单独成批。
   * 具体做法：先按事件段分组，每组把紧邻其前的空白段带上。 */
  const common={...mat,eventSegments:[]};
  /* 2026-11-02 复盘修复：分批时把空白段绑到它后面的那个事件段一起走。
   *
   * 为什么必须绑：
   *   eventSegments 现在混有 gap:true 的空白段（玩家要求「空白期也成段」）。
   *   直接按段数分批会把空白段单独切到一批里，模型只看到「这段时间他在过日子」，
   *   却看不到紧接着发生了什么事件，写出来必然脱节；
   *   而且分批后 timeRange 取 events[0].start 也会算错。
   *
   * 绑法：把序列扫一遍，遇到空白段就先攒着，遇到事件段时把它们合成一个不可分单元。
   * 若整段序列没有事件段（纯空白），就整体作为一个单元，不拆。
   */
  const units=[];
  let pendingGaps=[];
  for(const seg of segments){
    if(seg && seg.gap){pendingGaps.push(seg);continue;}
    units.push([...pendingGaps,seg]);
    pendingGaps=[];
  }
  // 末尾剩下的空白段（后面没有事件了）挂到最后一个单元上。
  if(pendingGaps.length){
    if(units.length)units[units.length-1]=[...units[units.length-1],...pendingGaps];
    else units.push(pendingGaps);
  }
  // 按「单元」分批：packRequestMaterials 吃的是数组，这里传入单元数组后要摊平回来。
  const groups=packRequestMaterials(units,{...limits,maxOutputChars:capacity.maxOutputChars-500,sharedChars:JSON.stringify(common).length+500,estimateOutput:()=>base})
    .map(unitList=>unitList.flat());
  return groups.map((events,index)=>({...item,material:{...mat,eventSegments:events,taskCodes:events.map(event=>event.code).filter(Boolean),
    timeRange:{start:events[0].start,end:events.at(-1).end},proseMaxChars:base*events.length,
    handoffRequired:index===groups.length-1&&mat.handoffRequired,prosePart:{index:index+1,total:groups.length}}}));
}
export function mergeProseResults(results){
  const failed=results.find(result=>!result.ok);if(failed)return failed;
  if(results.length===1)return results[0];
  const blocks=results.map(result=>result.block),last=blocks.at(-1);
  const body=blocks.map(block=>block.handoffDeclared?block.variableBody:block.body).filter(Boolean).join('\n\n');
  const biography=blocks.map(block=>block.handoffDeclared?block.variableBiographyLine:block.biographyLine).filter(Boolean).join('\n');
  const changed=blocks.find(block=>block.status==='变异')||blocks.find(block=>block.status!=='照原著');
  const uniq=key=>[...new Set(blocks.flatMap(block=>block[key]||[]))];
  return {ok:true,gaps:[],block:{...blocks[0],eventIds:uniq('eventIds'),declaredWritten:uniq('declaredWritten'),declaredUnwritten:uniq('declaredUnwritten'),
    status:changed?.status||'照原著',reason:blocks.map(block=>block.reason).filter(Boolean).join('；'),
    ...splitHandoffStory(last.handoffDeclared?body+'\n@@交汇开始\n'+last.readOnlyBody:body,biography,last.readOnlyBiographyLine||'')}};
}
