#!/usr/bin/env node
/* 未定义变量检查闸门：用 TypeScript（checkJs）做权威检测，构建前跑。
 *
 * 【为什么用 tsc 而不是自己写 AST 分析】
 * 我试过用 acorn 自建作用域链，三次都因边界情况出错（漏注册声明导致 9 万误报、
 * 嵌套函数递归死循环）。TypeScript 是工业级实现，TS2304「Cannot find name」
 * 就是权威的未定义变量检测，直接用它。
 *
 * 【为什么只管 core/】
 * frontend/ 下的文件大量使用运行时注入的全局（db、currentArchiveName、fr* 函数…），
 * 这些在打包后的单文件里真实存在，但 tsc 单文件视角看不到，会产生 400+ 误报。
 * core/ 是纯逻辑层，只 import 其他 core 模块，不含运行时注入 ——
 * 这里的 TS2304 每一个都是真 bug。
 *
 * 已抓到的真实案例：
 *   orchestrator.js 用了 renderMaterialForPrompt 但没 import
 *   （和 diff.js 的 expected 同类：只在特定路径触发，平时看不出来）
 *
 * 用法：node scripts/check-undef.mjs
 *   退出码 1 = 有未定义引用，应阻断构建
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');
const TSCONFIG = path.join(HERE, 'tsconfig.scope.json');

if (!fs.existsSync(TSC)) {
  console.log('[check-undef] 跳过：未找到 typescript（' + TSC + '）');
  process.exit(0);
}

let raw = '';
try {
  raw = execFileSync(process.execPath, [TSC, '-p', TSCONFIG], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  raw = String((e.stdout || '') + (e.stderr || ''));
}

/* 只关心 TS2304：Cannot find name 'X' */
const hits = [];
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error TS2304: Cannot find name '(.+?)'\.$/);
  if (m) hits.push({ file: m[1].replace(/\\/g, '/'), line: +m[2], col: +m[3], name: m[4] });
}

/* 只报 core/ 下的 —— 见文件头说明 */
const coreHits = hits.filter(h => /(^|\/)card\/src\/core\//.test(h.file));

console.log('== 未定义变量检查（tsc checkJs · TS2304）==');
console.log('   TS2304 总数: ' + hits.length + '（其中 core/: ' + coreHits.length + '）');
console.log('');

if (!coreHits.length) {
  console.log('OK core/ 下没有未定义引用');
  console.log('');
  process.exit(0);
}

const byFile = {};
coreHits.forEach(h => (byFile[h.file] || (byFile[h.file] = [])).push(h));
for (const [file, list] of Object.entries(byFile)) {
  console.log('X ' + file.replace(/^.*card\/src\//, ''));
  const seen = new Set();
  list.forEach(h => {
    const k = h.line + '|' + h.name;
    if (seen.has(k)) return;
    seen.add(k);
    console.log('    行' + h.line + '  未定义「' + h.name + '」');
  });
  console.log('');
}
console.log('共 ' + coreHits.length + ' 处 —— 构建已阻断');
process.exit(1);
