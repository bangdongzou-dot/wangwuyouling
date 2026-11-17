const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const root=path.resolve(__dirname,'..');const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(root,'card/src/frontend/preset-compat.js'),'utf8'),ctx);
const catalog=JSON.parse(fs.readFileSync(path.join(root,'card/src/assets/evolution-presets.json'),'utf8'));
const note=ctx.FR_MANUAL_REFERENCE_CONTENT_RULE;assert.ok(note.includes('资料载体（无需学习）/功法/技能'));assert.ok(note.includes('同一载体兼有资料与完整可修内容'));assert.ok(note.includes('不含功法'));assert.ok(note.includes('玩家B1'));assert.ok(note.includes('阵纹拓录'));
let checked=0;
for(const preset of catalog){for(const spec of ctx.FR_NPC_LEARNING_RULE_SPECS){const r=preset.prompts?.[spec.scope]?.rules?.find(r=>r.id===spec.rule.id);if(!r)continue;checked++;assert.ok(r.content.endsWith(note),preset.id+':'+spec.scope);}}
assert.ok(checked>=8);
for(const spec of ctx.FR_NPC_LEARNING_RULE_SPECS){for(const base of [spec.rule.content,spec.rule.content.replace(ctx.FR_NPC_TECHNIQUE_OLD,ctx.FR_NPC_TECHNIQUE_RULE),spec.rule.content.replace(ctx.FR_NPC_TECHNIQUE_OLD,ctx.FR_NPC_TECHNIQUE_RULE)+"\n"+note.split("\n")[0]]){const p={prompts:{[spec.scope]:{rules:[{...spec.rule,enabled:false,content:base+'\n用户尾注保留'}]}}};ctx.frAdaptNpcManualLearningRules(p);const r=p.prompts[spec.scope].rules[0];assert.ok(r.content.includes(note));assert.ok(r.content.endsWith('\n用户尾注保留'));assert.equal(r.enabled,false);const first=JSON.stringify(p);ctx.frAdaptNpcManualLearningRules(p);assert.equal(JSON.stringify(p),first);}
const custom={prompts:{[spec.scope]:{rules:[{...spec.rule,content:'用户完全自定义规则'}]}}};ctx.frAdaptNpcManualLearningRules(custom);assert.equal(custom.prompts[spec.scope].rules[0].content,'用户完全自定义规则');}
const canon=fs.readFileSync(path.join(root,'card/src/frontend/canon-runtime.js'),'utf8');for(const paragraph of note.split("\n")) assert.ok(canon.includes(paragraph));
console.log('PASS catalog '+checked+' rules; old/current migration; tails; disabled state; idempotence; custom protection; canon parity; reference/mixed/negation/causality contracts');
