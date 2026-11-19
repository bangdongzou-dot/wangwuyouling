// 物品展示只读明确分类和品阶，不读名字夸饰、HTML颜色或旧灵蕴词。
(function(g){
'use strict';
const neutral='#b9a783';
const divineTier = '幻彩神物';
const divineColor = '#f4c8ff';
// 这里只映射展示色；不据颜色反推品阶，不改写物品记录。
const gradeHues=[['#d7d7ce','#5d5b50'],['#69f0ae','#176b43'],['#82c7eb','#245f91'],['#e7a5f7','#79448e'],['#ffd700','#825b0b'],['#f49a91','#9a392f']];
const techniqueTiers=['黄阶','玄阶','地阶','天阶','仙阶','道阶'];
const plainText=value=>typeof value==='string'||typeof value==='number'?String(value).replace(/<[^>]*>/g,'').trim():'';
function rankNumber(value){
 const text=String(value),digits='零一二三四五六七八九';
 if(/^\d{1,2}$/.test(text))return Number(text);
 if(text==='十')return 10;
 if(text.length===1)return digits.indexOf(text);
 const match=text.match(/^([一二三]?)十([一二三四五六七八九]?)$/u);
 return match?(match[1]?digits.indexOf(match[1]):1)*10+(match[2]?digits.indexOf(match[2]):0):0;
}
function rankPresentation(raw){
 const text=plainText(raw);
 if(!text||/^(?:无|未详|未知|未载|未定|普通|凡物|杂物)(?:品阶)?$/u.test(text))return null;
 const pair=text.match(/^([黄玄地天仙道]阶)\s*(?:[·・／/]\s*|[（(]\s*)?(下品|中品|上品|极品)?[）)]?$/u);
 if(pair){const [color,dayColor]=gradeHues[techniqueTiers.indexOf(pair[1])];return{label:pair[1]+(pair[2]?' · '+pair[2]:''),color,dayColor,known:true,needsClassification:false,colorSource:'grade'};}
 const numeric=text.match(/^([一二三四五六七八九十零\d]{1,4})\s*品(?:[·・／/]?([人玄地天]阶))?$/u);
 if(numeric){const rank=rankNumber(numeric[1]);if(rank<1||rank>24)return null;const index=rank>=17?3:rank>=11?2:rank>=5?1:0;const [color,dayColor]=gradeHues[index];return{label:text,color,dayColor,known:true,needsClassification:false,colorSource:'grade'};}
 const realm=text.match(/^(炼气|筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫|真仙|金仙|太乙|大罗|道祖)阶(?:\s*[·・／/]\s*(下品|中品|上品|顶阶|极品))?$/u);
 if(realm){const index=Math.min(5,['炼气','筑基','结丹','元婴','化神','炼虚','合体','大乘','渡劫','真仙','金仙','太乙','大罗','道祖'].indexOf(realm[1]));const [color,dayColor]=gradeHues[index];return{label:realm[1]+'阶'+(realm[2]?' · '+realm[2]:''),color,dayColor,known:true,needsClassification:false,colorSource:'grade'};}
 const quality=text.match(/^(下品|中品|上品|顶阶|极品)$/u);
 if(quality){const [color,dayColor]=gradeHues[{下品:0,中品:1,上品:2,顶阶:3,极品:4}[quality[1]]];return{label:text,color,dayColor,known:true,needsClassification:false,colorSource:'grade'};}
 return null;
}
function otherItemRank(i){
 const effect=i['4']??i.effect;
 const structured=effect&&typeof effect==='object'?effect:{};
 for(const value of [i.itemGrade,i.grade,i.rank,i.quality,i.品阶,i.显示品阶,i.品质,structured.品阶,structured.品质]){const raw=plainText(value);const parsed=rankPresentation(/^\d{1,2}$/u.test(raw)?raw+'品':raw);if(parsed)return parsed;}
 const numbered=structured.品质档??i.品质档;
 if(numbered!=null){const parsed=rankPresentation(plainText(numbered).replace(/品$/u,'')+'品');if(parsed)return parsed;}
 // 旧约定把明确品阶写在描述开头；不扫描姓名、器物夸饰或正文中的未来品阶。
 const prefix=plainText(i['3']??i.description).match(/^(?:【)?((?:[一二三四五六七八九十零\d]{1,4}\s*品(?:[·・／/]?[人玄地天]阶)?)|(?:[黄玄地天仙道]阶(?:[·・／/]?(?:下品|中品|上品|极品))?)|(?:下品|中品|上品|顶阶|极品))(?=[^一二三四五六七八九十零\d]|$)/u);
 return prefix?rankPresentation(prefix[1]):null;
}
function categoryPresentation(i,c){
 const type=typeOf(i),desc=plainText(i['3']??i.description);
 const spiritualHerb=/^(?:灵草|灵药)$/u.test(type)||/^(?:药材|草药|药草)$/u.test(type)&&/(?:灵草|灵药)/u.test(desc);
 const spiritualMaterial=/^(?:灵材|炼器材料|炼丹材料)$/u.test(type)||c.category==='material'&&/(?:灵材|妖兽[^。；]{0,8}材料|炼器材料|炼丹材料)/u.test(desc);
 const label=spiritualHerb?'灵草':spiritualMaterial?'灵材':/^(?:丹药|灵兽丹)$/u.test(type)?'丹药':/^(?:符箓|符纸)$/u.test(type)?'符箓':/^(?:阵盘|阵具)$/u.test(type)?'阵具':'';
 if(!label)return null;
 const hue=label==='灵草'||label==='灵材'?1:label==='丹药'?4:2;
 const [color,dayColor]=gradeHues[hue];
 return{label:'',categoryLabel:label,color,dayColor,known:false,needsClassification:false,colorSource:'category'};
}
const paths={
weapon:'M22 2 24 4 12 18 9 15Z M22 4 11 16 M7 14 14 20 M5 13 7 14 6 17 11 22 14 20 15 22 M9 19 4 24 M6 22 8 24 M4 24 3 26 M18 8l2 2',
head:'M6 18 5 10 9 8 10 3h8l1 5 4 2-1 8 M8 18h12 M6 22h16l1-4H5Z M10 5l4 3 4-3 M9 8l5 4 5-4 M14 8v10 M4 11 2 15l4 3 M24 11l2 4-4 3',
body:'M9 3 3 7 2 14l5 2 2-5-1 13h12l-1-13 2 5 5-2-1-7-6-4-5 4Z M9 3l5 8 5-8 M14 11l-3 13 M9 15h10 M19 15l4 5 M11 20l-1 4 M17 18l1 6',
legs:'M5 4h7l-1 12 3 4v4H3v-4l2-4Z M17 4h6l-1 12 4 4v4H16v-5l1-3Z M5 7h7 M17 7h6 M3 21h11 M16 21h10 M7 11h3 M19 11h2',
accessory:'M14 2v5 M10 3q4 5 8 0 M8 11q6-8 12 0v8q-6 6-12 0Z M14 10a4 4 0 1 0 0 8 4 4 0 1 0 0-8 M11 22v4 M14 23v4 M17 22v4',
technique:'M5 3h18v19H8 M5 3a2 2 0 0 0-2 2v17a3 3 0 0 0 3 3h17v-3H6a1 1 0 0 1 0-2h17 M18 6v10h-6V6Z M15 8v6 M9 7v9 M5 3v16',
bodyart:'M6 6 10 3l4 4 4-4 4 3-2 6-3 1v11h-6V13l-3-1Z M10 16h8 M10 20h8',
mind:'M3 14q11-14 22 0-11 14-22 0Z M18 14a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M14 2v3 M14 23v3',
craft:'M7 9h14l2 13H5Z M9 5h10 M11 2h6 M8 25h12 M9 14h10 M14 10v11',
natal:'M14 2q-5 5-5 10t5 10q5-5 5-10T14 2Z M9 11 3 8q-2 11 11 14Q27 19 25 8l-6 3 M14 7v12 M6 22q8 5 16 0 M9 25h10',
treasure:'M6 10h16l-1 9q-7 5-14 0Z M5 7h18v3H5Z M10 6l4-4 4 4 M3 11H1v5l6 1 M25 11h2v5l-6 1 M9 21l-2 5 M19 21l2 5 M11 13h6v5h-6Z M14 14v3',
pill:'M10 3h8v5l5 5v9q-9 5-18 0v-9l5-5Z M9 3h10 M6 14h16 M10 18h8',
talisman:'M7 2h14v24H7Z M10 7h8 M14 5v8l-4 3h8l-5 6 M10 24h8',
oil:'M10 3h8v5l4 6v10H6V14l4-6Z M10 6h8 M14 12q-6 7 0 9 6-2 0-9Z',
food:'M3 14h22q-1 10-11 10T3 14Z M5 10h18 M10 3v5 M17 2v6',
herb:'M14 25V12 M14 19Q2 18 4 7q11 0 10 12 M14 14Q14 2 25 3q0 10-11 11',
material:'m14 3 9 5v12l-9 5-9-5V8Z M5 8l9 5 9-5 M14 13v12 M9 6l10 5',
rare:'M9 3h10l5 5v14l-10 4-10-4V8Z M9 6h10v15l-5 2-5-2Z M11 10h6 M14 8v10 M11 15h6 M14 2v4',
misc:'M9 3h10l-3 5q12 15 5 17H7Q0 23 12 8Z M9 8h10 M10 19h8 M14 15v8'
};
function core(name){return(g.CE_CORE||(typeof CE_CORE!=='undefined'?CE_CORE:{}))?.[name];}
function typeOf(i){return String(i?.['2']||i?.type||i?.category||'').trim();}
function projectMiracleBottle(item) {
  const engine = core('container-equipment');
  return engine ? engine.projectMiracleBottle(item) : item;
}
function classify(i){const fn=core('equipment-layout')?.classifyItem||g.FrEquipmentRuntime?.classify;return fn?fn(i):{category:'misc',slotKey:null,indices:[]};}
function iconKey(i){const c=classify(i),t=typeOf(i),n=c.indices?.[0];
if(c.slotKey==='weapon')return'weapon';if(c.slotKey==='armor')return['head','body','legs','accessory'][n]||'body';if(c.slotKey==='technique')return['technique','bodyart','mind','craft'][n]||'technique';if(c.slotKey==='treasure')return n===0?'natal':'treasure';
if(/^(丹药|灵兽丹|药剂|药品)$/.test(t))return'pill';if(/^(符箓|符纸)$/.test(t))return'talisman';if(/^(油|油料|灯油|燃料|灵油)$/.test(t))return'oil';if(/^(食物|食品)$/.test(t))return'food';if(/^(灵药|草药|药材|种子|炼丹材料)$/.test(t))return'herb';return({material:'material',consumable:'pill',rare:'rare'})[c.category]||'misc';}
function icon(i,cssClass){
 const k=iconKey(i),c=String(cssClass||'').split(/\s+/).filter(x=>/^[a-zA-Z_][\w-]*$/.test(x)).join(' ');
 // 本地器物图：薄金外纹与淡底只作装饰，物品类型仍由中央轮廓表达。
 // 不使用SVG全局id，避免背包中多图标的渐变/裁剪定义相互覆盖。
 return '<svg xmlns="http://www.w3.org/2000/svg" class="fr-item-icon '+c+'" data-item-icon="'+k+'" data-fr-item-tier="'+ornament(i)+'" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
 +'<circle cx="24" cy="24" r="21" fill="currentColor" fill-opacity=".055" stroke-opacity=".2" stroke-width=".7"/>'
 +'<path d="M7 17V9h8 M33 9h8v8 M7 31v8h8 M33 39h8v-8" stroke-opacity=".36" stroke-width=".7"/>'
 +'<g transform="translate(7 6) scale(1.2)"><path d="'+paths[k]+'" fill="currentColor" fill-opacity=".11"/></g>'
 +'<path d="m24 2 1.5 2L24 6l-1.5-2ZM24 42l1.5 2-1.5 2-1.5-2Z" fill="currentColor" fill-opacity=".5" stroke="none"/></svg>';
}
function rarity(i){
if(!i||typeof i!=='object')return{label:'',color:neutral,known:false,needsClassification:false};
i=projectMiracleBottle(i);
const c=classify(i),equipment=c.category==='equipment'||c.category==='treasure';
if(c.category==='technique'){
 const baseline=core('cultivation-speed')?.techniqueSpeedBaseline(i);
 const index=techniqueTiers.indexOf(baseline?.tier);
 if(index>=0){const [color,dayColor]=gradeHues[index];return{label:baseline.tier+(baseline.quality?' · '+baseline.quality:''),color,dayColor,known:true,needsClassification:false,colorSource:'grade'};}
 return{label:'',categoryLabel:'功法',color:'#dac39a',dayColor:'#795533',known:false,needsClassification:false,colorSource:'category'};
}
if(!equipment)return otherItemRank(i)||categoryPresentation(i,c)||{label:'',color:neutral,known:false,needsClassification:false};
const engine=core('container-equipment');
const colors=engine?.CONTAINER_CLASS_COLORS||{};
const parsed=engine?.parseItemContainerEquipment(i);
if(parsed?.ok && parsed.type==='混沌之宝' && parsed.quality==='至高')return{label:'混沌之宝 · 至高',color:colors[parsed.type],known:true,needsClassification:false,ornament:'chaos'};
if(i.artifactTier===divineTier)return{label:divineTier,color:divineColor,known:true,needsClassification:!parsed?.ok,ornament:'divine'};
if(parsed?.ok)return{label:parsed.type+' · '+parsed.quality,color:colors[parsed.type]||neutral,known:true,needsClassification:false};
const tier=String(i.artifactTier||typeOf(i)).trim();
if(tier!=='混沌之宝'&&Object.hasOwn(colors,tier))return{label:tier,color:colors[tier],known:true,needsClassification:true};
const t=typeOf(i),label=['凡器','法器','法宝','本命法宝','普通法宝','灵宝','通天灵宝','玄天圣器','玄天残宝','玄天之宝','仙器'].includes(t)?t:c.label||'';
return{label,color:neutral,known:false,needsClassification:true};
}
function ornament(i){
 const r=rarity(i),colors=core('container-equipment')?.CONTAINER_CLASS_COLORS||{};
 if(r.ornament)return r.ornament;
 if(r.colorSource)return 'plain';
 if(!r.known)return 'plain';
 const levels={凡器:'mortal',法器:'magic',法宝:'treasure',灵宝:'spirit',通天灵宝:'celestial',玄天之宝:'supreme'};
 return Object.keys(levels).find(k=>colors[k]===r.color)?levels[Object.keys(levels).find(k=>colors[k]===r.color)]:'plain';
}
function decorate(element,item){
 if(!element)return;
 element.classList.add('fr-item-surface');
 element.setAttribute('data-fr-item-tier',ornament(item));
 const r=rarity(item);
 const classColors=core('container-equipment')?.CONTAINER_CLASS_COLORS||{};
 const classIndex=['凡器','法器','法宝','灵宝','通天灵宝','玄天之宝'].findIndex(key=>classColors[key]===r.color);
 element.style.setProperty('--fr-item-aura',r.color);
 element.setAttribute('data-fr-item-color-source',r.colorSource||(r.known?'grade':'none'));
 element.style.setProperty('--fr-item-label-color',r.color);
 element.style.setProperty('--fr-item-label-day-color',r.dayColor||(classIndex>=0?gradeHues[classIndex][1]:r.color));
}
const detailEscape=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const detailSection=(title,html,extra='')=>html?'<section class="fr-chaos-section '+extra+'"><h3>'+detailEscape(title)+'</h3>'+html+'</section>':'';
function detailText(value,{fields=false,levels=false}={}){
 const text=String(value??'').replace(/\\n|\r\n?/g,'\n').trim();
 if(!text||text==='无')return '';
 const paragraph=line=>{
  const sentences=line.match(/[^。！？]+[。！？]*|[。！？]+/gu)||[line];
  const parts=[];let part='';
  for(const sentence of sentences){if(part.length>=74){parts.push(part);part='';}part+=sentence;}
  if(part)parts.push(part);
  return parts.map(chunk=>'<p>'+detailEscape(chunk)+'</p>').join('');
 };
 const lines=text.split(levels?/[;；\n]+/u:/\n+/u).flatMap(line=>line.split(/(?=【[^】]{1,12}】)/u)).map(s=>s.trim()).filter(Boolean);
 return lines.map(line=>{
  const entry=line.match(/^【([^】]{1,12})】\s*[:：]?\s*(.+)$/u)
   ||((fields||levels)&&line.match(/^([^：:，。；;]{1,16})[：:]\s*(.+)$/u));
  return entry?'<div class="fr-item-entry"><strong>'+detailEscape(entry[1])+'</strong><div>'+paragraph(entry[2])+'</div></div>':paragraph(line);
 }).join('');
}
function chaosDetailHtml(item){
 item=projectMiracleBottle(item);
 if(rarity(item).ornament!=='chaos')return '';
 const description=String(item.description||item['3']||'').replace(/\\n/g,'\n').trim();
 if(!description)return '';
 const fields=description.split(/【(器物能力|万道之基|造化|生命|烘炉|认主|蕴灵|神识传导)】/u);
 if(fields.length===1)return '';
 const escape=detailEscape;
 const paragraphs=(text,breakBefore)=>text.trim().split(breakBefore||/\n+/u).filter(part=>part.trim()).map(part=>'<p>'+escape(part.trim())+'</p>').join('');
 const origin=fields[0].replace(/^混沌之宝·至高。\s*/u,'');
 const powers=[];
 let summary='',spirit='',binding='',transmission='';
 for(let index=1;index<fields.length;index+=2){
  const [label,value]=fields.slice(index,index+2);
  if(!value.trim())continue;
  if(label==='器物能力')summary+=paragraphs(value);
  else if(label==='蕴灵')spirit+=paragraphs(value,/\n+|(?<=。)(?=她与宿主|本体为超脱者)/u);
  else if(label==='认主')binding+=paragraphs(value);
  else if(label==='神识传导')transmission+=paragraphs(value);
  else powers.push('<div><dt>'+escape(label)+'</dt><dd>'+paragraphs(value)+'</dd></div>');
 }
 return (origin?'<section class="fr-chaos-section fr-chaos-origin"><h3>器物来历</h3>'+paragraphs(origin,/\n+|(?<=。)(?=此宝神异)/u)+'</section>':'')
  +(powers.length||summary?'<section class="fr-chaos-section"><h3>器物能力</h3><div class="fr-chaos-lead">'+summary+'</div><dl class="fr-chaos-powers">'+powers.join('')+'</dl></section>':'')
  +(spirit||binding?'<section class="fr-chaos-section fr-chaos-spirit"><h3>'+(spirit?'器灵 · 红宝':'认主')+'</h3>'+spirit
    +(binding?'<aside>'+(spirit?'<strong>认主</strong>':'')+binding+'</aside>':'')+'</section>':'')
  +(transmission?'<div class="fr-chaos-note"><strong>神识传导</strong>'+transmission+'</div>':'');
}
function containerDetailHtml(item,result){
 const parsed=core('container-equipment')?.parseItemContainerEquipment(item);
 if(!parsed?.recognized)return '';
 const format=value=>Number.isFinite(value)?(core('numeric-display')?.formatDisplayNumber(value) ?? String(value)):'—';
 const metric=(label,value)=>'<div><dt>'+detailEscape(label)+'</dt><dd>'+detailEscape(value)+'</dd></div>';
 const reason=code=>({unknown_realm:'持有者境界不在已定义范围内',white_value_missing:'持有者缺少对应白值',white_value_invalid:'白值不是有效非负数',consciousness_missing:'缺少神识白值',consciousness_invalid:'神识白值无效',hard_cap_missing:'该属性硬锁尚未定义',hard_cap_invalid:'该属性硬锁配置无效',numeric_overflow:'计算结果超出有效数值范围',reserved_chaos_tier:'混沌之宝至高品阶专属混沌造化瓶'})[code]||'容器字段不合法，无法结算';
 if(!parsed.ok)return detailSection('容器传导','<p>'+detailEscape(reason(parsed.reason))+'</p>');
 let outcome='';
 if(result?.ok){
  const locked=result.factor===0;
  outcome='<div class="fr-item-outcome"><div><span>实际加成</span><strong>'+detailEscape(parsed.attribute)+' +'+format(result.value)+'</strong></div><span>'+ (locked?'神识不足 · 无法驱动':'达到驱动门槛')+'</span></div>';
 }else if(result)outcome='<p class="fr-item-muted">'+detailEscape(reason(result.reason))+'</p>';
 const stats='<dl class="fr-item-metrics" aria-label="神识门槛">'+metric('传导率',format(parsed.rate*100)+'%')+
  metric('启动神识',format(parsed.minConsciousness))+metric('完整传导神识',format(parsed.perfectConsciousness))+'</dl>';
 const formula=result?.ok?'<details class="fr-item-formula"><summary>计算明细</summary><p>'+detailEscape(result.sourceAttribute)+'白值 '+format(result.sourceValue)+' × '+parsed.rate.toFixed(2)+' × 神识修正 '+format(result.factor)+' = '+format(result.rawValue)+'</p><p>神识白值 '+format(result.consciousness)+'；单件硬锁 '+format(result.cap)+(result.clamped?'（已截断）':'')+'</p></details>':'';
 return detailSection('容器传导 · '+parsed.attribute,outcome+stats+formula,'fr-item-drive');
}
function detailHtml(raw,options={}){
 const item=projectMiracleBottle({...raw?.columns,...raw});
 const category=classify(item).category;
 const desc=item.description||item['3'];
 const effect=item.effect||item['4'];
 const titles={equipment:['装备效果','器物来历'],treasure:['器物效果','器物来历'],consumable:['使用效果','物品说明'],material:['材料用途','来源与特性'],rare:['用途与线索','来历与说明'],misc:['用途','物品说明']};
 const section=detailSection;
 if(category==='technique'){
  const realm=item.maxRealm||item['7'];
  const grade=item.grade||item['6'];
  const cultivation=core('cultivation-speed');
  const baseline=cultivation?.techniqueSpeedBaseline(item);
  const gradeLabel=baseline?.quality?baseline.tier+' · '+baseline.quality:grade;
  const knownSpeed=Object.hasOwn(options,'techniqueSpeed');
  const speed=knownSpeed?options.techniqueSpeed:baseline;
  const format=(n,suffix)=>Number.isFinite(n)&&n!==0?(n>0?'+':'')+n+suffix:'';
  const amount=speed?[format(speed.percent,'%'),format(speed.flat,'')].filter(Boolean).join(' / ')||'0':'未生效';
  const tierBasis=speed?.tier?speed.tier+(speed.quality?' · '+speed.quality:'')+'基准':'入门基准';
  const basis=knownSpeed?(speed?.source==='record'?'按当前已解锁境界记录':tierBasis):tierBasis+' · 明示境界加成优先';
  const speedCard=cultivation?'<div class="fr-item-outcome fr-technique-speed"><div><span>修炼速度加成</span><strong>'+detailEscape(amount)+'</strong></div><span>'+detailEscape(speed?basis:options.inactiveReason||'达到首个功法境界后生效')+'</span></div>':'';
  const metrics=[gradeLabel?['功法品阶',gradeLabel]:null,realm?['修炼上限',realm]:null,options.status?['修习状态',options.status]:null].filter(Boolean);
  const facts=metrics.length?'<dl class="fr-item-metrics'+(metrics.length===3?' fr-item-metrics-three':'')+'">'+metrics.map(([label,value])=>'<div><dt>'+label+'</dt><dd>'+detailEscape(value)+'</dd></div>').join('')+'</dl>':'';
  return section('修习概览',speedCard+facts+(options.currentEffect?'<div class="fr-item-entry"><strong>当前境界效果</strong><div>'+detailText(options.currentEffect)+'</div></div>':''))+
   section('功法要义',detailText(desc))+section('各境界效果',detailText(item.realmEffects||item['8'],{levels:true}))||
   section('功法要义','<p class="fr-item-muted">暂无详细资料</p>');
 }
 const [effectTitle,descTitle]=/^(技能|神通|武技|法术|秘籍)$/u.test(typeOf(item))?['招式与效果','要义与说明']:titles[category]||titles.misc;
 const rules=containerDetailHtml(item,options.containerResult);
 const lore=chaosDetailHtml(item);
 const cultivationAid=core('cultivation-environment')?.cultivationAidSummary(item,options.cultivationActorRank);
 return (cultivationAid?section('修炼辅助',detailText(cultivationAid)):'')+(rules||section(effectTitle,detailText(effect,{fields:true})))+(lore||section(descTitle,detailText(desc)))||section('物品说明','<p class="fr-item-muted">暂无详细资料</p>');
}
g.FrItemPresentation=Object.freeze({icon,iconKey,rarity,ornament,decorate,projectMiracleBottle,chaosDetailHtml,detailHtml});
})(window);
