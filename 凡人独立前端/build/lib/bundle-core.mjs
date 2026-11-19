// ============================================================
// 核心模块打包器：把 src/core/*.js（ES module）
// 变成能拼进注入器的普通脚本
//
// 为什么必须有这一步：
//   注入器最终产物是一条正则脚本，内部是普通 <script>，
//   **没有 ES module 环境**。而 src/core/ 全是 import/export。
//   直接拼接的结果是语法错误，所以之前这 11 个模块
//   只能活在 `node --test` 里，一个字节都没进过产物。
//
// ------------------------------------------------------------
// 做法：不引入任何构建依赖，用最朴素的模块表
//
//   每个模块包成一个工厂函数：
//     __define('interval', function (exports, require) {
//       'use strict';
//       ... 去掉 import/export 之后的正文 ...
//       exports.parseTimePoint = parseTimePoint;
//     });
//
//   import { a } from './x.js'
//     → const { a } = require('x');
//
//   最后统一 require 一遍，挂成 window.CE_CORE。
//
// 约束（本文件会主动校验，不合格直接抛错，不带病构建）：
//   · 只支持具名导入导出，不支持 default / 命名空间导入
//   · 导出只能是顶层 const / function / async function / class
//   · 模块间不得有重名顶层声明（拼进同一作用域会互相覆盖）
// ============================================================

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** 参与打包的模块（顺序无关，依赖由 import 决定；这里只列清单防漏） */
export const CORE_MODULE_FILES = [
  'host-adapter.js',
  'numeric-display.js',
  'story-image-assets.js',
  'host-material.js',
  'interval.js',
  'inventory-stock.js',
  'ledger.js',
  'retry.js',
  'request-budget.js',
  'chat-request-policy.js',
  'vector-input.js',
  'diff.js',
  'canon-turn-plan.js',
  'canon-prebuilt.js',
  'canon-event-details.js',
  'world-events.js',
  'canon-node.js',
  'actor-state.js',
  'character-profile.js',
  'character-status.js',
  'equipment-layout.js',
  'newcomer.js',
  'backstory.js',
  'ceiling.js',
  'biography.js',
  'guidance.js',
  'turn-focus.js',
  'prompt-registry.js',
  'prose-material.js',
  'prose-budget.js',
  'prose-prompt.js',
  'prose-dispatch.js',
  'prose-validate.js',
  'settlement.js',
  'role-roster.js',
  'settings-panel.js',
  'api-library.js',
  'container-equipment.js',
  'numeric-settings.js',
  'numeric-skill.js',
  'numeric-realms.js',
  'initial-realm.js',
  'numeric-preset.js',
  'numeric-rule-library.js',
  'cultivation-speed.js',
  'cultivation-environment.js',
  'cultivation-arts.js',
  'visibility.js',
  'world-block.js',
  'yellow-hooks.js',
  'orchestrator.js',
];

const EXPORT_RE = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/;
const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([^'"]+?)(?:\.js)?['"]\s*;?/gm;

function moduleId(fileName) {
  return path.basename(fileName, '.js');
}

/**
 * 把一个 ES module 源码改写成工厂函数体。
 *
 * @param {string} source
 * @param {string} fileName 用于报错定位
 * @returns {{body:string, exports:string[], dependencies:string[]}}
 */
export function transformModule(source, fileName) {
  const label = fileName || '<module>';
  const exported = [];
  const dependencies = [];

  // ---- 1. 摘掉 import，改成 require 解构 ----
  let body = source.replace(IMPORT_RE, (whole, namesRaw, fromRaw) => {
    const names = namesRaw
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error(`${label}: 空的具名导入`);
    }
    for (const n of names) {
      if (n === 'default' || n.startsWith('*')) {
        throw new Error(`${label}: 不支持 default / 命名空间导入（${n}）`);
      }
      if (!/^[A-Za-z0-9_$]+$/.test(n)) {
        throw new Error(`${label}: 不支持的导入写法「${n}」`);
      }
    }
    const dep = String(fromRaw).replace(/\.js$/, '');
    if (!dependencies.includes(dep)) dependencies.push(dep);
    return `const { ${names.join(', ')} } = require('${dep}');`;
  });

  // 残留的 import 说明写法超出支持范围，宁可构建失败也不产出坏包
  const leftoverImport = body.match(/^\s*import\s/m);
  if (leftoverImport) {
    throw new Error(`${label}: 存在无法改写的 import 语句`);
  }

  // ---- 2. 去掉 export 前缀，收集导出名 ----
  const lines = body.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const m = line.match(EXPORT_RE);
    if (!m) {
      const names = line.match(/^export\s*\{\s*([A-Za-z0-9_$\s,]+)\s*\}\s*;?\s*$/);
      if (names) {
        const list = names[1].split(',').map(name => name.trim()).filter(Boolean);
        if (!list.length || list.some(name => !/^[A-Za-z0-9_$]+$/.test(name))) {
          throw new Error(`${label}: 不支持的导出写法：${line.trim()}`);
        }
        for (const name of list) if (!exported.includes(name)) exported.push(name);
        return '';
      }
      if (/^\s*export\s/.test(line)) {
        throw new Error(`${label}: 不支持的导出写法：${line.trim()}`);
      }
      return line;
    }
    exported.push(m[1]);
    return line.replace(/^export\s+/, '');
  });
  body = rewritten.join('\n');

  if (exported.length === 0) {
    throw new Error(`${label}: 没有任何导出，不像一个模块`);
  }

  return { body, exports: exported, dependencies };
}

/**
 * 打包全部核心模块。
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {string[]} [options.files]
 * @param {string} [options.globalName='CE_CORE']
 * @returns {Promise<{source:string, modules:Array<{id:string,exports:string[],dependencies:string[]}>}>}
 */
export async function bundleCoreModules(projectRoot, options = {}) {
  const files = Array.isArray(options.files) && options.files.length > 0
    ? options.files
    : CORE_MODULE_FILES;
  // 只有用默认清单时才检查「目录里有没有漏登记的模块」。
  // 显式传 files 是调用方刻意挑子集（测试、局部打包），不该被拦。
  const usingDefaultList = files === CORE_MODULE_FILES;
  const globalName = String(options.globalName || 'CE_CORE');
  const coreDir = path.join(projectRoot, 'src', 'core');

  if (usingDefaultList) {
    const onDisk = (await readdir(coreDir))
      .filter((f) => f.endsWith('.js'))
      .sort();
    const unlisted = onDisk.filter((f) => !files.includes(f));
    if (unlisted.length > 0) {
      throw new Error(`核心模块清单已过期，未登记：${unlisted.join('、')}`);
    }
  }

  const modules = [];
  for (const fileName of files) {
    const source = await readFile(path.join(coreDir, fileName), 'utf8');
    const transformed = transformModule(source, fileName);
    modules.push({ id: moduleId(fileName), fileName, ...transformed });
  }

  // 依赖必须都在包内
  const known = new Set(modules.map((m) => m.id));
  for (const m of modules) {
    for (const dep of m.dependencies) {
      if (!known.has(dep)) {
        throw new Error(`${m.fileName}: 依赖的模块「${dep}」不在打包清单里`);
      }
    }
  }

  // 顶层重名会互相覆盖，拼包前先挡住
  const owners = new Map();
  const collisions = [];
  for (const m of modules) {
    for (const name of m.exports) {
      if (owners.has(name)) {
        collisions.push(`${name}（${owners.get(name)} / ${m.fileName}）`);
      } else {
        owners.set(name, m.fileName);
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(`核心模块导出重名：${collisions.join('、')}`);
  }

  // 按依赖拓扑排序，保证 define 顺序与 require 顺序无关
  const ordered = topoSort(modules);

  const out = [];
  out.push('// ============================================================');
  out.push('// 原著补演 · 核心模块（构建自动生成，禁止手改）');
  out.push('// 源文件：src/core/*.js —— 改那边，不要改这里');
  out.push('// ============================================================');
  out.push(`var ${globalName} = (function () {`);
  out.push("  'use strict';");
  out.push('');
  out.push('  var __defs = Object.create(null);');
  out.push('  var __cache = Object.create(null);');
  out.push('');
  out.push('  function __define(name, factory) { __defs[name] = factory; }');
  out.push('');
  out.push('  function __require(name) {');
  out.push('    if (__cache[name]) return __cache[name];');
  out.push('    var factory = __defs[name];');
  out.push("    if (!factory) throw new Error('核心模块缺失: ' + name);");
  out.push('    var exports = {};');
  out.push('    __cache[name] = exports;');
  out.push('    factory(exports, __require);');
  out.push('    return exports;');
  out.push('  }');
  out.push('');

  for (const m of ordered) {
    out.push(`  // ---- ${m.fileName} ----`);
    out.push(`  __define('${m.id}', function (exports, require) {`);
    out.push("    'use strict';");
    out.push(indent(m.body, '    '));
    out.push('');
    for (const name of m.exports) {
      out.push(`    exports.${name} = ${name};`);
    }
    out.push('  });');
    out.push('');
  }

  out.push('  return {');
  for (let i = 0; i < ordered.length; i += 1) {
    const suffix = i === ordered.length - 1 ? '' : ',';
    // id 可能含连字符（host-adapter），必须加引号才是合法键
    out.push(`    ${JSON.stringify(ordered[i].id)}: __require('${ordered[i].id}')${suffix}`);
  }
  out.push('  };');
  out.push('})();');
  out.push('');

  const publicSummary = ordered.map((m) => ({
    id: m.id,
    exports: m.exports,
    dependencies: m.dependencies,
  }));

  return { source: out.join('\n'), modules: publicSummary };
}

/** 依赖拓扑排序（稳定：同层按原始清单顺序） */
function topoSort(modules) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const visited = new Map(); // id -> 'visiting' | 'done'
  const result = [];

  const visit = (m, stack) => {
    const state = visited.get(m.id);
    if (state === 'done') return;
    if (state === 'visiting') {
      throw new Error(`核心模块存在循环依赖：${[...stack, m.id].join(' -> ')}`);
    }
    visited.set(m.id, 'visiting');
    for (const dep of m.dependencies) {
      visit(byId.get(dep), [...stack, m.id]);
    }
    visited.set(m.id, 'done');
    result.push(m);
  };

  for (const m of modules) visit(m, []);
  return result;
}

function indent(text, prefix) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? prefix + line : line))
    .join('\n');
}
