import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bundleCoreModules} from './lib/bundle-core.mjs';
import {protectHtmlForTavern,REGEX_TRANSPORT_VERSION} from './lib/regex-transport.mjs';
import {convertWorldInfoToCharacterBook,WORLD_BOOK_NAME} from './lib/worldbook.mjs';
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(buf){let c=0xffffffff;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunks(png){assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');const out=[];let i=8;while(i<png.length){const len=png.readUInt32BE(i),end=i+len+12;assert.ok(end<=png.length);const type=png.toString('ascii',i+4,i+8);const data=png.subarray(i+8,end-4);assert.equal(crc32(png.subarray(i+4,end-4)),png.readUInt32BE(end-4));out.push({type,data,raw:png.subarray(i,end)});i=end;if(type==='IEND')break;}assert.equal(i,png.length);assert.equal(out.at(-1).type,'IEND');return out;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return b;}
export function decodeCardPng(png){const out={crcValid:true};for(const c of chunks(png)){if(c.type!=='tEXt')continue;const zero=c.data.indexOf(0),key=c.data.subarray(0,zero).toString();if(['chara','ccv3'].includes(key)){assert.ok(!out[key]);out[key]=JSON.parse(Buffer.from(c.data.subarray(zero+1).toString(),'base64').toString('utf8'));}}return out;}
function replaceOnce(s,key,v){assert.equal(s.split(key).length,2,`组件占位次数错误 ${key}`);return s.replace(key,()=>v);}
export async function assembleFrontend(root,options={}){
  let layout=options.layout??await fs.readFile(path.join(root,'src/frontend/layout.html'),'utf8');
  const files=JSON.parse(await fs.readFile(path.join(root,'src/frontend/components.json'),'utf8'));
  const core=(await bundleCoreModules(root)).source;
  const defaults={};
  /* ★★ 2026-11-06 玩家：「之前那一份预设就不要内置了，避免误导。之前那份可以说是废弃了。」
   *
   * 原来这里循环 ['preset','timeline']，其中 preset 读的是 src/assets/preset.json
   * ——旧的重点演化预设（万物有灵世界观适配·原著演化版）。
   * 那份已被 evolution-presets.json 的四套（完整/轻量/DS完整/DS轻量）取代，
   * 继续打包只会让运行时把它当成「空库兜底」而误用旧规则。
   *
   * 现在 defaults 只留 timeline；重点演化预设的唯一来源是 evolutionPresets。
   * 配套改动：default-assets.js 的校验、main.js loadConcurrentEvolutionPresets 的兜底与基线。
   */
  defaults.timeline=JSON.parse(await fs.readFile(path.join(root,'src/assets/timeline.json'),'utf8'));
  defaults.evolutionPresets=JSON.parse(await fs.readFile(path.join(root,'src/assets/evolution-presets.json'),'utf8'));
  const timelineSource=JSON.parse(await fs.readFile(path.join(root,'src/assets/timeline-source.json'),'utf8'));
  const timelineBytes=await fs.readFile(path.join(root,'..',timelineSource.source));
  assert.equal(crypto.createHash('sha256').update(timelineBytes).digest('hex'),timelineSource.sha256,'年表来源已变更，请先复核同步默认资料');
  assert.equal(defaults.timeline.length,timelineSource.entries);
  assert.equal(JSON.stringify(defaults.timeline),JSON.stringify(JSON.parse(timelineBytes.toString('utf8'))),'内置默认年表必须与用户指定来源一致');
  const packed=zlib.gzipSync(JSON.stringify(defaults)).toString('base64');
  const containerPatches=JSON.parse(await fs.readFile(path.join(root,'src/assets/container-preset-patches.json'),'utf8'));
  assert.equal(containerPatches.version,1,'容器预设升级清单版本错误');
  assert.ok(Array.isArray(containerPatches.patches),'容器预设升级清单缺失');
  const storyImageSource=(await fs.readFile(path.join(root,'src/frontend/story-image-assets.js'),'utf8'))
    +'\n'+(await fs.readFile(path.join(root,'src/frontend/canon-portrait-gallery.js'),'utf8'));
  const equipmentSource=(await fs.readFile(path.join(root,'src/frontend/equipment-runtime.js'),'utf8'))+'\n'+(await fs.readFile(path.join(root,'src/frontend/item-presentation.js'),'utf8'))+'\n'+(await fs.readFile(path.join(root,'src/frontend/cultivation-arts-view.js'),'utf8'))+'\n'+(await fs.readFile(path.join(root,'src/frontend/equipment-view.js'),'utf8'))+'\n'+(await fs.readFile(path.join(root,'src/frontend/numeric-rule-panel.js'),'utf8'))+'\n'+(await fs.readFile(path.join(root,'src/frontend/equipment-preset.js'),'utf8'));
  const defaultSource='var FR_DEFAULT_VECTOR_SEARCH_PROMPT = '+JSON.stringify(await fs.readFile(path.join(root,'src/assets/vector-search-prompt.md'),'utf8'))+';\nvar FR_PACKED_DEFAULTS = '+JSON.stringify(packed)+';\nvar FR_CONTAINER_PRESET_PATCHES = '+JSON.stringify(containerPatches).replace(/</g,'\\u003c')+';\n'+await fs.readFile(path.join(root,'src/frontend/default-assets.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/preset-compat.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/merged-evolution.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/ce-preset-catalog.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/evolution-settings.js'),'utf8');
  for(const entry of files){let text=await fs.readFile(path.join(root,entry.file),'utf8');if(entry.file.endsWith('/style-1.css'))text+='\n'+await fs.readFile(path.join(root,'src/frontend/evolution-settings.css'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/equipment-view.css'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/cultivation-arts-view.css'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/visual-system.css'),'utf8');if(entry.file.endsWith('/main.js')){text=replaceOnce(text,'/*__FR_DEFAULTS__*/',defaultSource+'\n'+storyImageSource+'\n'+equipmentSource+'\n'+await fs.readFile(path.join(root,'src/frontend/diagnostic-log.js'),'utf8'));text=replaceOnce(text,'/*__CANON_CORE__*/',core);text=replaceOnce(text,'/*__CANON_BRIDGE__*/',await fs.readFile(path.join(root,'src/frontend/canon-bridge.js'),'utf8'));text=replaceOnce(text,'/*__CANON_RUNTIME__*/',await fs.readFile(path.join(root,'src/frontend/canon-settlement.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/canon-early.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/canon-runtime.js'),'utf8'));text=replaceOnce(text,'/*__CANON_OBSERVABILITY__*/',await fs.readFile(path.join(root,'src/frontend/canon-node-times.js'),'utf8')+'\n'+await fs.readFile(path.join(root,'src/frontend/canon-observability.js'),'utf8'));text=replaceOnce(text,'/*__CANON_REPLAY__*/',await fs.readFile(path.join(root,'src/frontend/canon-replay.js'),'utf8'));}layout=replaceOnce(layout,entry.token,text);}
  assert.ok(!/\{\{(?:FR_COMPONENT_|MISSING_COMPONENT)/.test(layout),'缺少组件占位替换');
  // 2026-10-31：内置世界书（旧「万物有灵」）已按玩家决定移除 ——
  // 世界观设定统一进「世界规则」，由世界观裁定器按需注入，不再打包进 character_book。
  // 文件不存在时降级为空 entries，保证独立端构建不依赖它。
  let worldbook={entries:{}};
  try{
    worldbook=JSON.parse(await fs.readFile(path.join(root,'src/assets/worldbook.json'),'utf8'));
  }catch(e){ worldbook={entries:{}}; }
  const buildId='FRI-'+crypto.createHash('sha256').update(REGEX_TRANSPORT_VERSION+'\n'+WORLD_BOOK_NAME+'\n'+JSON.stringify(worldbook)+'\n'+layout).digest('hex').slice(0,12);
  layout=replaceOnce(layout,'/*__FR_BUILD_ID__*/','var FR_BUILD_ID = '+JSON.stringify(buildId)+';');
  layout=replaceOnce(layout,'{{FR_BOOT_BUILD_ID}}',buildId);
  assert.ok(!/\/\*__(?:FR|CANON)_\w+__\*\//.test(layout),'未替换工程构建占位符');
  for(const match of layout.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){if(match[1].trim())new vm.Script(match[1]);}
  return options.transport==='raw'?layout:protectHtmlForTavern(layout);
}
export async function buildArtifacts(root,options={}){
  const html=await assembleFrontend(root);
  const base=JSON.parse(await fs.readFile(path.join(root,'src/card.base.json'),'utf8'));
  // 2026-10-31：内置世界书已移除，character_book 降级为空（独立端不用它）。
  let worldbook={entries:{}};
  try{ worldbook=JSON.parse((await fs.readFile(path.join(root,'src/assets/worldbook.json'))).toString('utf8')); }catch(e){ worldbook={entries:{}}; }
  assert.ok(worldbook.entries&&typeof worldbook.entries==='object'&&!Array.isArray(worldbook.entries),'世界书必须是酒馆原生entries对象');
  base.data.character_book=convertWorldInfoToCharacterBook(WORLD_BOOK_NAME,worldbook.entries);
  base.data.extensions.world=WORLD_BOOK_NAME;
  const regex=JSON.parse(await fs.readFile(path.join(root,'src/regex.base.json'),'utf8'));
  regex.replaceString='```html\n'+html+'\n```';
  const scripts=base.data.extensions.regex_scripts;
  const candidates=scripts.map((s,i)=>({s,i})).filter(x=>x.s.id===regex.id);
  assert.equal(candidates.length,1,'核心正则ID必须唯一匹配，禁止按文本体积猜测替换对象');
  const coreRegexIndex=candidates[0].i;
  assert.ok(scripts[coreRegexIndex].replaceString.length>100000,'无法确认核心正则');
  scripts[coreRegexIndex]=regex;
  // V2 mirror fields are retained; only the data regex entry changes.
  const v2={...base,spec:'chara_card_v2',spec_version:'2.0'};
  const shell=await fs.readFile(path.join(root,'src/card-shell.png'));
  const preserved=chunks(shell).filter(c=>!(c.type==='tEXt'&&['chara','ccv3'].includes(c.data.subarray(0,c.data.indexOf(0)).toString())));
  const text=(key,obj)=>chunk('tEXt',Buffer.from(key+'\0'+Buffer.from(JSON.stringify(obj)).toString('base64')));
  const png=Buffer.concat([shell.subarray(0,8),...preserved.slice(0,-1).map(c=>c.raw),text('chara',v2),text('ccv3',base),preserved.at(-1).raw]);
  /* ★★ 2026-11-06 玩家：「之前那一份预设就不要内置了，避免误导。之前那份可以说是废弃了。」
   *
   * 原来这里会读 src/assets/preset.json（旧的重点演化预设·万物有灵世界观适配·原著演化版），
   * 跑一遍 frAdaptEvolutionPreset 再导出成「重点演化预设-独立原著补演适配版.json」。
   *
   * 那份预设已被新四套（evolution-presets.json：完整/轻量/DS完整/DS轻量）取代，
   * 继续内置只会让人误选旧规则（它没有容器体系那套数值契约）。
   * 所以 preset.json 已删除，这里同步移除读取与导出。
   *
   * 注意：正文预设仍走 scripts/assemble.mjs 读的 src/builtin/preset.json，与本处无关。 */
  const result={html,card:base,regex,png,coreRegexIndex,features:JSON.parse(await fs.readFile(path.join(root,'src/features.json'),'utf8'))};
  if(options.write!==false){
    // User-facing artifacts have one canonical copy in the workspace root; reports stay in the project.
    const dist=path.join(root,'dist'),artifactDir=path.dirname(root);
    await fs.mkdir(dist,{recursive:true});
    const outputs={'万物有灵原著补演前端.html':html,'万物有灵原著补演正则.json':JSON.stringify(regex,null,2),'凡人修仙传原著补演测试卡.json':JSON.stringify(base,null,2),'凡人修仙传原著补演测试卡.png':png};
    const report={date:new Date().toLocaleDateString('sv-SE'),buildId:html.match(/var FR_BUILD_ID = "([^"]+)"/)[1],artifactDirectory:'..',gate:'offline-artifact',runtimeAccepted:false,features:result.features,timeline:JSON.parse(await fs.readFile(path.join(root,'src/assets/timeline-source.json'),'utf8')),worldbook:{name:WORLD_BOOK_NAME,entries:base.data.character_book.entries.length,sha256:crypto.createHash('sha256').update(worldbookBytes).digest('hex')},files:{}};
    for(const[name,data]of Object.entries(outputs)){
      await fs.writeFile(path.join(artifactDir,name),data);
      report.files[name]={bytes:Buffer.byteLength(data),sha256:crypto.createHash('sha256').update(data).digest('hex')};
    }
    await fs.writeFile(path.join(dist,'build-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){await buildArtifacts(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));}
