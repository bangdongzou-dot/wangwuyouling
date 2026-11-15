// 酒馆会在正则替换文本上先展开$n和宏。只编码JS字符串/模板片段中的语法字符；
// 浏览器解析后值不变，声明、闭包、脚本加载方式和后续角色卡正则接点不变。
import vm from 'node:vm';
import assert from 'node:assert/strict';
const natives=process.binding('natives'),key=Object.keys(natives).find(k=>/acorn\/dist\/acorn$/.test(k));
const acorn={};vm.runInNewContext(natives[key],{exports:acorn,module:{exports:acorn}});
export const REGEX_TRANSPORT_VERSION='js-literal-unicode-v2-markdown-fences';
const risky=s=>/\$(?:\d|<)|\{\{|```/.test(s);
function encode(value){return JSON.stringify(value).replace(/\$(?=\d|<)/g,'\\u0024').replace(/\{\{/g,'\\u007b\\u007b').replace(/`/g,'\\u0060').replace(/</g,'\\u003c');}
export function protectScriptForTavern(source){
 const comments=[],ast=acorn.parse(source,{ecmaVersion:'latest',onComment:comments}),edits=[];
 // ST decorates quotes before Markdown with a lazy triple-backtick matcher, even for
 // fences inside JS strings/regular expressions/comments. Keep the outer HTML fence intact.
 for(const comment of comments){const text=source.slice(comment.start,comment.end);if(text.includes('```'))edits.push({start:comment.start,end:comment.end,text:text.replace(/`/g,'\\x60')});}
 function walk(node,parent){if(!node?.type)return;
  if(node.type==='Literal'&&typeof node.value==='string'&&risky(node.value)) edits.push({start:node.start,end:node.end,text:encode(node.value)});
  if(node.type==='Literal'&&node.regex&&node.raw.includes('```'))edits.push({start:node.start,end:node.end,text:node.raw.replace(/`/g,'\\x60')});
  if(node.type==='TemplateElement'&&risky(node.value.raw)){
   assert.notEqual(parent?.parentType,'TaggedTemplateExpression','含酒馆替换语法的tagged template须单独核验，不能改变raw语义');
   assert.notEqual(node.value.cooked,null);
   edits.push({start:node.start,end:node.end,text:encode(node.value.cooked).slice(1,-1).replace(/`/g,'\\`').replace(/\$\{/g,'\\${')});
  }
  for(const [k,v]of Object.entries(node)){if(k==='parentType')continue;if(Array.isArray(v))v.forEach(x=>walk(x,{...node,parentType:parent?.type}));else if(v&&typeof v==='object')walk(v,{...node,parentType:parent?.type});}
 }
 walk(ast,null);
 let result=source;for(const e of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,e.start)+e.text+result.slice(e.end);
 new vm.Script(result);return result;
}
export function protectHtmlForTavern(html){return html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,(_,open,source,close)=>open+(source.trim()?protectScriptForTavern(source):source)+close);}
