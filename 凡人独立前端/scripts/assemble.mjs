/* ============================================================================
 * 凡人卡独立前端 · 组装器（assemble.mjs）
 *
 * 思路（学方舟 assemble.js）：
 *   不改任何玩法源码，只把「酒馆垫片」插到主 bundle 之前，
 *   然后把所有东西拼成一个单文件 HTML，双击即开。
 *
 * 为什么必须单文件：
 *   file:// 协议下 <script type="module"> 会被 CORS 拦住，
 *   所以只能用 IIFE 拼接（现有 build.mjs 已经是这个做法）。
 *
 * 用法：
 *   node 凡人独立前端/scripts/assemble.mjs
 * 产物：
 *   根目录/凡人独立前端.html
 * ========================================================================== */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(HERE, '..');                       // 凡人独立前端/
const REPO_ROOT = path.resolve(OUT_ROOT, '..');                  // 原著补演/

/* ---------------------------------------------------------------------------
 * 【2026-10-30 源码隔离】玩家决定：酒馆版源码封存，独立端自包含。
 *
 * 以前这里指向 REPO_ROOT/凡人修仙传内置集成 —— 两个版本共用一个源码树，
 * 改独立端就会污染要交付酒馆的那份卡。现在改成读本工程内的副本：
 *
 *   card/       ← 卡源码副本，内部结构与酒馆项目 root 完全一致：
 *                 card/src/{frontend,core,assets}/ + card/src/{card.base,regex.base,
 *                 card-shell.png,features}.…  这样 build.mjs 的 root/src/… 拼法不用改
 *   新年表.json ← build.mjs 用 root/../新年表.json 读年表，所以放在 OUT_ROOT
 *   build/      ← 构建器（build.mjs + lib/）
 *
 * 两份副本在隔离时做过逐字节 sha256 比对（57/57 一致）。
 * 从今往后：独立端只改 card/，酒馆版源码原地封存不动。
 * ------------------------------------------------------------------------- */
const CARD_ROOT = path.join(OUT_ROOT, 'card');                   // 卡源码副本（= build.mjs 的 root）
const BUILD_ROOT = path.join(OUT_ROOT, 'build');                 // 构建器副本

// 断言：副本必须齐备，缺一个就直接报清楚，不要等到构建中途才炸。
const REQUIRED = [
  path.join(BUILD_ROOT, 'build.mjs'),
  path.join(BUILD_ROOT, 'lib', 'bundle-core.mjs'),
  path.join(BUILD_ROOT, 'lib', 'regex-transport.mjs'),
  path.join(BUILD_ROOT, 'lib', 'worldbook.mjs'),
  path.join(CARD_ROOT, 'src', 'frontend', 'layout.html'),
  path.join(CARD_ROOT, 'src', 'frontend', 'main.js'),
  path.join(CARD_ROOT, 'src', 'frontend', 'components.json'),
  path.join(CARD_ROOT, 'src', 'card.base.json'),
  path.join(CARD_ROOT, 'src', 'regex.base.json'),
  path.join(CARD_ROOT, 'src', 'card-shell.png'),
  path.join(CARD_ROOT, 'src', 'features.json'),
  path.join(CARD_ROOT, 'src', 'assets', 'timeline-source.json'),
  path.join(OUT_ROOT, '新年表.json')
];
for (const p of REQUIRED) {
  if (!existsSync(p)) {
    throw new Error('源码副本缺失：' + path.relative(OUT_ROOT, p) +
      '\n请从 凡人修仙传内置集成 重新同步该文件（隔离说明见 测试版优化方案/30-酒馆版封存与独立端源码隔离.md）');
  }
}

// 复用卡项目的构建逻辑，拿到「已经组装好、能跑」的前端 HTML。
// 注意：build.mjs 用 projectRoot 拼 src/… 路径，所以这里传 CARD_ROOT。
async function buildBaseHtml() {
  const mod = await import(pathToFileURL(path.join(BUILD_ROOT, 'build.mjs')).href);
  // write:false → 只要 HTML，不覆盖任何成品
  const result = await mod.buildArtifacts(CARD_ROOT, { write: false });
  return result.html;
}

function pathToFileURL(p) {
  return new URL('file:///' + p.replace(/\\/g, '/'));
}

// 把世界书内联进 HTML，避免 file:// 读不到本地 json。
// 注意：这里读的是**卡内世界书**（character_book 用），与 src/builtin/worldbook.json 是同一份内容的两处用途。
async function readWorldbook() {
  const p = path.join(CARD_ROOT, 'src', 'assets', 'worldbook.json');
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

// 读垫片与启动脚本。
async function readOwn(name) {
  return fs.readFile(path.join(OUT_ROOT, 'src', name), 'utf8');
}

// 读内置资源（预设 / 正文正则）。
// 2026-10-31：不再读 worldbook.json —— 内置世界书（旧「万物有灵」）已按玩家决定移除，
// 世界观设定改由「世界规则」承载（card/src/canon/world-rules/，一条规则一个条目），
// 正文请求按关键词选取世界规则条目。
async function readBuiltinAssets() {
  const dir = path.join(OUT_ROOT, 'src', 'builtin');
  const preset = JSON.parse(await fs.readFile(path.join(dir, 'preset.json'), 'utf8'));
  const regex = JSON.parse(await fs.readFile(path.join(dir, 'regex.json'), 'utf8'));
  const imageDir = path.join(dir, 'image-materials');
  const imagePrompts = JSON.parse(await fs.readFile(path.join(imageDir, 'prompts.json'), 'utf8'));
  const imageExamples = Object.fromEntries(await Promise.all(['photo', 'design', 'portrait', 'story'].map(async name => [
    name, 'data:image/jpeg;base64,' + (await fs.readFile(path.join(imageDir, name + '.jpg'))).toString('base64')
  ])));
  const defaultAvatarPosters = Object.fromEntries(await Promise.all(['male', 'female'].map(async name => [
    name, 'data:image/jpeg;base64,' + (await fs.readFile(path.join(dir, 'default-avatars', name + '.jpg'))).toString('base64')
  ])));
  return { preset, regex, imageMaterials: { ...imagePrompts, examples: imageExamples }, defaultAvatarPosters };
}

// 保持编码声明在脚本之前，浏览器读取单文件时可以尽早识别 UTF-8。
function injectBeforeAll(html, code) {
  const m = html.match(/<head[^>]*>\s*<meta\s+charset=["']utf-8["']\s*\/?>/i);
  if (!m) throw new Error('找不到 <head> 开头的 UTF-8 声明，无法注入垫片');
  const at = m.index + m[0].length;
  return html.slice(0, at) + '\n<script>\n' + code + '\n</script>\n' + html.slice(at);
}

// 在 </body> 前插入（启动引导要在 DOM 就绪后跑）。
function injectBeforeBodyEnd(html, code) {
  const idx = html.lastIndexOf('</body>');
  if (idx < 0) throw new Error('找不到 </body>');
  return html.slice(0, idx) + '\n<script>\n' + code + '\n</script>\n' + html.slice(idx);
}

function wrapIIFE(code, label) {
  // 独立脚本之间不共享作用域，各自包一层，避免顶层变量互相覆盖。
  return '/* ==== ' + label + ' ==== */\n(function(){\n' + code + '\n})();';
}

/* ---------------------------------------------------------------------------
 * 离线化：把外部 CDN 依赖处理掉
 *
 * 实测结论（扫产物得到）：
 *   dexie      —— 必需。db.archives 等用了 392 处，本地有 dexie.min.js，直接内联。
 *   leancloud  —— 未使用（AV. 只有 1 处误匹配），移除标签。
 *   echarts    —— 未使用（0 处调用），移除标签。
 *   font-awesome —— 815 处 fa- 图标类。CDN 断了只是图标变方块，不影响功能；
 *                  保留标签（联网时正常），断网时降级。
 *
 * 为什么要内联：file:// 下如果 CDN 连不上，Dexie 未定义 → db 建不出来 →
 * 整个卡片白屏。这是「双击即开」能否成立的关键。
 * ------------------------------------------------------------------------- */
const KEEP_REMOTE = [/font-awesome/i];

function inlineDexie(html, dexieSource) {
  // 找到 CDN 的 dexie script 标签，替换成内联脚本
  const re = /<script\b[^>]*src=["'][^"']*dexie[^"']*["'][^>]*>\s*<\/script\s*>/i;
  if (!re.test(html)) {
    // 没有标签：可能已内联，或结构变了。给出明确提示而不是静默通过。
    console.warn('       ⚠ 没找到 dexie 的 CDN 标签，跳过内联');
    return html;
  }
  const inline = '<script>\n' + dexieSource + '\n</script>';
  return html.replace(re, () => inline);
}

function dropUnusedRemote(html) {
  const dropped = [];
  html = html.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi, (whole, url) => {
    if (KEEP_REMOTE.some((k) => k.test(url))) return whole;
    dropped.push(url);
    return '<!-- 已移除未使用的远程依赖：' + url + ' -->';
  });
  return { html, dropped };
}

/* ---------------------------------------------------------------------------
 * 离线兜底：让页面在完全断网时也能正常显示
 *
 * 实测断网打开时有 10 个失败请求：
 *   - font-awesome CSS            → 图标变方块，不影响功能
 *   - fonts.googleapis.com × 7    → 字体回退到系统字体，不影响功能
 *   - splash 背景视频（美团图床）  → 首屏黑底，但按钮正常
 *
 * 都不致命，但控制台刷满红字，玩家会以为坏了。
 * 处理：干掉首屏远程视频换成同色系渐变；字体全部回退系统字体栈。
 * ------------------------------------------------------------------------- */
function offlineHardening(html) {
  const before = html.length;

  // 首屏视频：保留！那是作者做的角色立绘动画，是这个游戏的门面。
  // 之前为了「零报错」把它删了，结果首屏变成纯黑渐变——得不偿失。
  // 这里只做一件事：视频加载失败时用同色系渐变顶上，加了 still 有画面，
  // 网络不好时也不会是一片黑。

  const css = [
    '/* 离线兜底（独立前端注入）：字体回退到系统字体栈 */',
    'html,body{font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC","Noto Sans CJK SC",system-ui,-apple-system,"Segoe UI",sans-serif!important}',
    '/* 离线时 FontAwesome 不可用，避免 fa- 元素撑出空白方块 */',
    '.fa,.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands{font-style:normal}',
    '/* 首屏：原 CSS 已经把 video 做成 fixed + object-fit:cover + z-index:-1，',
    '   这里绝不能再改 #splash-screen 的 position（一改就从全屏变成一条横带）。',
    '   只补一个「视频没加载出来时先铺底色」的兜底。 */',
    '#splash-screen{background:radial-gradient(120% 90% at 50% 0%,#2b2418 0%,#151310 55%,#0a0908 100%)}'
  ].join('\n');

  if (!/<\/head>/i.test(html)) throw new Error('找不到 </head>');
  html = html.replace(/<\/head>/i, () => '<style>\n' + css + '\n</style>\n</head>');
  return { html, savedChars: before - html.length };
}

function checkSyntax(html) {
  // 逐个 <script> 校验语法，避免拼出一个「能打开但全白」的页面。
  const bad = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const code = m[1];
    if (!code.trim()) continue;
    i++;
    try { new vm.Script(code); }
    catch (e) { bad.push({ index: i, error: String(e.message || e) }); }
  }
  return { total: i, bad };
}

async function main() {
  console.log('[组装] 开始…');

  console.log('[组装] 1/6 构建主程序（复用 build.mjs，不覆盖主项目成品）…');
  let html = await buildBaseHtml();
  console.log('       主程序 HTML: ' + (html.length / 1024 / 1024).toFixed(2) + ' MB');

  console.log('[组装] 2/6 内联内置预设/正则…');
  const builtin = await readBuiltinAssets();

  // 2026-10-31：内置世界书（worldbook.json，旧「万物有灵」16 条）已按玩家决定移除。
  // 世界观设定统一由正文按需读取「世界规则」，
  // 规则来源是 card/src/canon/world-rules/*.txt（一条规则一个条目）。
  // 这里只保留预设与正则。
  //
  // 关键：JSON 里可能含 "</script>" 字样（正则规则里就有），直接写进 <script>
  // 会把标签提前闭合，导致语法错误。必须把 < 转成 \u003c。
  const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
  // 2026-10-31：把角色卡字段注入页面。
  // 酒馆里预设有一批「占位符条目」（content 为空），发送时由酒馆按 identifier 填入：
  //   charDescription / charPersonality / scenario / dialogueExamples → 角色卡同名字段
  //   worldInfoBefore / worldInfoAfter → 由正文按需读取的「世界规则」代替旧世界书
  //   chatHistory → 聊天历史（本卡历史走 currentMainContent，已进【近期事态回顾】）
  // 脱离酒馆后拿不到角色卡对象，这些槽位就成了空串 →
  // 模型既不知道自己在演谁，也看不见世界设定。故把卡字段一并注入，供 builtin-preset.js 填充。
  let frCard = { name: '', description: '', personality: '', scenario: '', mes_example: '' };
  let frCardBook = [];
  try {
    const cardBasePath = path.join(CARD_ROOT, 'src', 'card.base.json');
    const cardRaw = JSON.parse(await fs.readFile(cardBasePath, 'utf8'));
    const cd = cardRaw.data || cardRaw;
    frCard = {
      name: String(cd.name || ''),
      description: String(cd.description || ''),
      personality: String(cd.personality || ''),
      scenario: String(cd.scenario || ''),
      mes_example: String(cd.mes_example || '')
    };
    // 卡内 character_book：酒馆宿主按 constant / position 无条件注入。
    // 这 11 条是这张卡真正的写作规范（文风 2,374 字、<upstore> 指令 11,387 字、
    // 属性说明 3,101 字、战斗判定 1,549 字…），共约 20,999 字符。
    // 脱离酒馆后宿主不再注入 → 必须由独立端自己补，否则模型不知道怎么写。
    const cbe = (cd.character_book && cd.character_book.entries) || [];
    frCardBook = cbe
      .filter((e) => e && e.disable !== true && String(e.content || '').trim())
      .map((e) => ({
        name: String(e.name || e.comment || ''),
        position: String(e.position || 'before_char'),
        constant: !!e.constant,
        // character_book 里字段名是 insertion_order（酒馆 convertCharacterBook 里
        // 映射成 order，再按 (a,b)=>b.order-a.order **降序**排序）。别写成 e.order。
        order: Number(e.insertion_order == null ? (e.order == null ? 0 : e.order) : e.insertion_order) || 0,
        content: String(e.content || '')
      }));
    console.log('       角色卡: ' + (frCard.name || '(无名)'));
    console.log('       卡内世界书: ' + frCardBook.length + ' 条 / ' +
      frCardBook.reduce((a, e) => a + e.content.length, 0) + ' 字符（全部 constant 注入）');
  } catch (e) {
    console.warn('       ⚠ 读角色卡失败，占位符将保持为空：' + (e && e.message));
  }
  const wbCode = [
    'window.__FR_BUILTIN_PRESET__ = ' + safeJson(builtin.preset) + ';',
    'window.__FR_PROSE_RENDER_FORMAT__ = ' + safeJson((await readOwn('builtin/prose-rendering-protocol.md')).trim()) + ';',
    'window.__FR_BUILTIN_REGEX__ = ' + safeJson(builtin.regex) + ';',
    'window.__FR_IMAGE_MATERIALS__ = ' + safeJson(builtin.imageMaterials) + ';',
    'window.__FR_DEFAULT_AVATAR_POSTERS__ = ' + safeJson(builtin.defaultAvatarPosters) + ';',
    'window.__FR_CARD__ = ' + safeJson(frCard) + ';',
    'window.__FR_CARD_BOOK__ = ' + safeJson(frCardBook) + ';'
  ].join('\n');
  const presetEnabled = (builtin.preset.prompts || []).filter((p) => p && p.enabled === true).length;
  console.log('       正文预设: ' + (builtin.preset.prompts || []).length + ' 条（启用 ' + presetEnabled + '）');
  console.log('       正文正则: ' + (builtin.regex.rules || []).length + ' 条常规 + ' +
    (builtin.regex.chainRules || []).length + ' 条思维链');
  console.log('       内置世界书: 已移除（正文按需读取世界规则）');

  console.log('[组装] 3/6 注入垫片、内置资源、玩家性格与启动引导…');
  const shim = await readOwn('st-shim.js');
  const { bundleCoreModules } = await import(pathToFileURL(path.join(BUILD_ROOT, 'lib', 'bundle-core.mjs')).href);
  const { source: chatRequestPolicy } = await bundleCoreModules(CARD_ROOT, {
    files: ['chat-request-policy.js','story-image-assets.js'],
    globalName: 'FR_CHAT_REQUEST_CORE'
  });
  const builtinMod = await readOwn('builtin-preset.js');
  const persona = await readOwn('player-persona.js');
  const proseApi = await readOwn('prose-api-settings.js');
  const stPresetImport = await readOwn('st-preset-import.js');
  const wvGuidance = await readOwn('worldview-guidance.js');
  const presetManager = await readOwn('preset-manager.js');
  const presetAdapters = await readOwn('preset-adapters.js');
  const wvPanel = await readOwn('worldview-panel.js');
  const wvTrace = await readOwn('worldview-panel-trace.js');
  const wvGuidePrompt = await readOwn('builtin/worldview-prompt.md');
  const boot = await readOwn('boot.js');
  /* 手机 / 小屏自适应引擎（2026-11-01 玩家：「任何情况，打开任何窗口，
     不管横屏还是竖屏，永远要以最舒适最合适的方式显示内容」）。
     它在运行时持续监测：任何浮层/弹窗一旦横向溢出屏幕、或高于屏幕导致
     标题与关闭按钮点不到，就当场收到视口内并允许内部滚动；转屏后自动重算。
     必须注入在 boot 之前、且越靠前越好，保证弹窗一出现就已被接管。 */
  const mobileAdaptive = await readOwn('mobile-adaptive.js');
  // 热更新界面提示条（2026-11-01 玩家：「在 pc 版本和安卓版本上都安排热更新」）
  // 只在 Electron 里干活：没有 window.frUpdate 时（浏览器版/安卓版）静默退出。
  // 注入在 boot 之前，确保游戏启动完就能接收主进程推来的「有新版本」事件。
  const updateUiPath = path.join(OUT_ROOT, 'src', 'update', 'update-ui.js');
  const updateUi = existsSync(updateUiPath) ? await fs.readFile(updateUiPath, 'utf8') : '';
  // 版本更新页面（玩家：「初始页面还有游戏内系统设置页面都要有」）
  // 两个入口：首屏「版本更新」按钮 + 系统控制台 → 数据与管理 → 版本更新
  const versionPanelPath = path.join(OUT_ROOT, 'src', 'update', 'version-panel.js');
  const versionPanel = existsSync(versionPanelPath) ? await fs.readFile(versionPanelPath, 'utf8') : '';
  if (updateUi) console.log('       热更新提示条: 已接入');
  if (versionPanel) console.log('       版本更新页面: 已接入');

  // 正文世界规则内置资产：通则和可编辑条目
  const wvPromptPath = path.join(CARD_ROOT, 'src', 'canon', 'world-rules', 'prose-policy.md');
  const wvRulesDir = path.join(CARD_ROOT, 'src', 'canon', 'world-rules');
  if (!existsSync(wvPromptPath)) throw new Error('缺少正文世界规则通则：' + wvPromptPath);
  if (!existsSync(wvRulesDir)) throw new Error('缺少世界规则目录：' + wvRulesDir);
  const wvPromptText = await fs.readFile(wvPromptPath, 'utf8');
  const wvRulesIndex = JSON.parse(await fs.readFile(path.join(wvRulesDir, 'index.json'), 'utf8'));
  const wvRules = [];
  for (const r of (wvRulesIndex.rules || [])) {
    const p = path.join(wvRulesDir, r.file);
    if (!existsSync(p)) throw new Error('缺少规则文件：' + p);
    wvRules.push({
      id: r.id, name: r.name, domain: r.domain || [],
      enabled: r.enabled !== false, order: r.order || 0,
      triggerMode: r.triggerMode, keywords: r.keywords,
      content: (await fs.readFile(p, 'utf8')).trim()
    });
  }
  const migration = JSON.parse(await fs.readFile(path.join(wvRulesDir, 'legacy-migration.json'), 'utf8'));
  const wvCode = 'window.__FR_WV_PROMPT__=' + safeJson(wvGuidePrompt) + ';\n' +
    'window.__FR_WR_PROSE__=' + JSON.stringify(wvPromptText) + ';\n' +
    'window.__FR_WR_MIGRATION__=' + JSON.stringify(migration) + ';\n' +
    'window.__FR_WR_DEFAULT__=' + JSON.stringify({ version: wvRulesIndex.version || '1.0', rules: wvRules }) + ';';
  console.log('       正文世界规则通则: ' + wvPromptText.length + ' 字符');
  console.log('       世界规则包: ' + wvRules.length + ' 条 / ' +
    wvRules.reduce((n, r) => n + r.content.length, 0) + ' 字符');

  // 顺序很关键：injectBeforeAll 是「插到 head 最前面」，
  // 所以后注入的反而更靠前。依赖链：
  //   世界书/内置数据 → 垫片 → 内置模块（读数据）→ 面板 → 启动引导
  // 正文世界规则：先加载内置资产，再加载条目选择及编辑器。
  // 注入顺序（从后往前）：boot → wvPanel → adapters → presetManager → proseApi → …
  // 依赖链：preset-manager 必须先于 adapters（adapters 调 PM.register），
  //         adapters 必须先于 wvPanel（面板点开后由管理器渲染）。
  html = injectBeforeAll(html, wrapIIFE(boot, '启动引导'));                          // 最后
  html = injectBeforeAll(html, wrapIIFE(mobileAdaptive, '全站自适应层'));
  if (updateUi) html = injectBeforeAll(html, wrapIIFE(updateUi, '热更新提示条'));
  if (versionPanel) html = injectBeforeAll(html, wrapIIFE(versionPanel, '版本更新页面'));
  html = injectBeforeAll(html, wrapIIFE(wvPanel, '世界观指导面板'));
  html = injectBeforeAll(html, wrapIIFE(wvTrace, '世界观指导观测面板'));
  html = injectBeforeAll(html, wrapIIFE(presetAdapters, '预设管理器适配器'));
  html = injectBeforeAll(html, wrapIIFE(presetManager, '通用预设管理器'));
  html = injectBeforeAll(html, wrapIIFE(proseApi, '正文API面板'));
  html = injectBeforeAll(html, wrapIIFE(stPresetImport, '酒馆预设导入适配'));
  html = injectBeforeAll(html, wrapIIFE(persona, '玩家性格'));
  html = injectBeforeAll(html, wrapIIFE(builtinMod, '内置预设与正则'));
  html = injectBeforeAll(html, wrapIIFE(wvGuidance, '世界规则选择与世界观指导'));
  html = injectBeforeAll(html, wrapIIFE(shim, '酒馆垫片'));
  html = injectBeforeAll(html, chatRequestPolicy);
  html = injectBeforeAll(html, wrapIIFE(wvCode, '世界规则内置资产'));
  html = injectBeforeAll(html, wrapIIFE(wbCode, '内置数据（世界书/预设/正则）')); // 最前

  console.log('[组装] 4/6 离线化：内联 Dexie、移除未用 CDN…');
  // dexie 现在由本工程自己的 devDependencies 提供，不再借用酒馆项目的 node_modules。
  const dexiePath = path.join(OUT_ROOT, 'node_modules', 'dexie', 'dist', 'dexie.min.js');
  if (!existsSync(dexiePath)) {
    throw new Error('缺少 dexie：' + path.relative(OUT_ROOT, dexiePath) +
      '\n请在 凡人独立前端 下执行 npm install（package.json 的 devDependencies 已声明 dexie）');
  }
  const dexieSrc = await fs.readFile(dexiePath, 'utf8');
  html = inlineDexie(html, dexieSrc);
  const dropped = dropUnusedRemote(html);
  html = dropped.html;
  console.log('       内联 dexie.min.js: ' + (dexieSrc.length / 1024).toFixed(0) + ' KB');
  console.log('       移除远程依赖: ' + (dropped.dropped.length ? dropped.dropped.join(', ') : '无'));

  const hardened = offlineHardening(html);
  html = hardened.html;
  console.log('       离线兜底: 首屏视频→渐变背景、字体回退系统栈');

  console.log('[组装] 5/6 语法校验…');
  const syn = checkSyntax(html);
  if (syn.bad.length) {
    for (const b of syn.bad) console.error('       ❌ script#' + b.index + ': ' + b.error);
    throw new Error('有 ' + syn.bad.length + ' 段脚本语法错误，已中止');
  }
  console.log('       ' + syn.total + ' 段脚本全部通过');

  console.log('[组装] 6/6 写出成品…');
  // 构建标记：方便日后确认「这份是独立版」，同时把版本号写进 html 最前面。
  // 版本号从 package.json 读。
  let buildVersion = '0.1.0';
  try {
    const pkgRaw = await fs.readFile(path.join(OUT_ROOT, 'package.json'), 'utf8');
    buildVersion = JSON.parse(pkgRaw).version || buildVersion;
  } catch (e) { /* 读不到就用兜底 */ }
  const stamp = '<!-- 凡人卡独立前端 · build ' + new Date().toISOString() +
    ' · v' + buildVersion + ' -->\n';
  html = stamp + html;

  /* 版本号给运行时用。
   *
   * 【为什么用 JS 全局变量，而不是让页面去解析注释】
   *   一开始让 version-panel.js 用正则从 document.documentElement.outerHTML 里
   *   抠那条 `<!-- ... v0.1.2 -->` 注释。
   *   实测发现 **outerHTML 不含 <html> 之前的注释节点**，正则永远不命中，
   *   浏览器版/安卓版因此显示「—」。
   *   现在改成在这里直接注入一个全局变量，页面读 window.__FR_APP_VERSION__，
   *   任何平台、任何时候都拿得到，不依赖 DOM 结构。
   */
  const versionCode = 'window.__FR_APP_VERSION__=' + JSON.stringify(buildVersion) + ';';
  html = injectBeforeAll(html, versionCode);
  console.log('   版本号: v' + buildVersion + '（已注入 window.__FR_APP_VERSION__）');

  /* -------------------------------------------------------------------------
   * 【更新日志内置兜底】玩家 2026-11-01 反馈：
   *   「如果你的版本和当前最新版本一致，或者你已经更新了，你就看不到更新日志了，
   *     我希望更新日志能永远保留，玩家一直能看到所有历史更新日志。」
   *
   * 为什么光靠远端不够：
   *   · 远端 version.json 只在「检查更新」成功时才会拿到；
   *   · 浏览器版 / 安卓版**没有 frUpdate 桥**，根本连不上远端；
   *   · PC 端如果玩家没点过「检查更新」，updateState.changelog 一直是空的；
   *   · window.__FR_CHANGELOG__ 原先**从来没有人赋值**（只有读取），
   *     等于 PC 端那条「用远端日志」的路也是死的。
   *
   * 所以这里把 发布包/CHANGELOG.json（累积的全部版本）直接烤进产物，
   * 让任何平台、任何网络状态、任何时候都有完整历史可看。
   * 远端拿得到时以远端为准（远端可能比本地构建更新），拿不到就用这份兜底。
   * ---------------------------------------------------------------------- */
  let bakedChangelog = [];
  const clPath = path.join(REPO_ROOT, '发布包', 'CHANGELOG.json');
  try {
    const rawCl = await fs.readFile(clPath, 'utf8');
    const parsed = JSON.parse(rawCl);
    if (Array.isArray(parsed)) {
      // 只保留结构完整的条目，避免一条坏数据把整块渲染搞挂
      bakedChangelog = parsed
        .filter(function (r) { return r && r.version && Array.isArray(r.items) && r.items.length; })
        .map(function (r) {
          return {
            version: String(r.version),
            date: String(r.date || ''),
            items: r.items.map(function (s) { return String(s); }),
          };
        });
    }
  } catch (e) {
    console.warn('   ⚠ 未能读取 发布包/CHANGELOG.json，内置日志将为空：' + (e && e.message || e));
  }

  /* ★ 2026-11-01 玩家报「本地已经是 1.0.3，更新日志里却没有 1.0.3」：
   *
   * 根因是**构建顺序天生慢一步**：
   *   assemble（此刻把 CHANGELOG.json 烤进产物）
   *     → make-dist
   *       → make-version（此时才把本版条目写进 CHANGELOG.json）
   * 烤进去的那份永远少了「正在发的这一版」。
   *
   * 修法：**当前版本的日志一律以人工编写的
   *   `发布包/版本更新日志/v<当前版本>-changelog.json` 为准**。
   * 理由：那份是人写的对外日志，条目最全、措辞经过斟酌；
   *   CHANGELOG.json 里的同版本条目可能来自上一轮 make-version（条目更旧更少）。
   * 之前只在「完全没有当前版本」时才补，结果出现过
   *   人写的 6 条 vs 烤进去的 5 条不一致（玩家看到的是少的那个）。
   * 其它版本（历史版本）保持 CHANGELOG.json 原样，不动。
   */
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(OUT_ROOT, 'package.json'), 'utf8'));
    const curVer = String(pkg.version || '');
    if (curVer) {
      const perVerPath = path.join(REPO_ROOT, '发布包', '版本更新日志', 'v' + curVer + '-changelog.json');
      let authoritative = null;
      if (existsSync(perVerPath)) {
        try {
          const perVer = JSON.parse(await fs.readFile(perVerPath, 'utf8'));
          const items = Array.isArray(perVer.items) ? perVer.items.map(String).filter(Boolean) : [];
          if (items.length) {
            authoritative = { version: curVer, date: String(perVer.date || ''), items: items };
          }
        } catch (e) {
          console.warn('   ⚠ 读取 v' + curVer + '-changelog.json 失败：' + (e && e.message || e));
        }
      }

      const idx = bakedChangelog.findIndex(function (r) { return r.version === curVer; });
      if (authoritative) {
        const oldCount = idx >= 0 ? bakedChangelog[idx].items.length : 0;
        // 移除旧条目，把人工这份放到最前
        bakedChangelog = bakedChangelog.filter(function (r) { return r.version !== curVer; });
        bakedChangelog.unshift(authoritative);
        if (idx < 0) {
          console.log('   更新日志: 累积日志缺 v' + curVer + '，已从 v' + curVer
            + '-changelog.json 补入 ' + authoritative.items.length + ' 条');
        } else if (oldCount !== authoritative.items.length) {
          console.log('   更新日志: v' + curVer + ' 条目数以人工日志为准 '
            + oldCount + ' 条 → ' + authoritative.items.length + ' 条');
        }
      } else if (idx < 0) {
        console.warn('   ⚠ 累积日志与 v' + curVer + '-changelog.json 都没有 v' + curVer
          + ' 的条目 —— 更新日志会缺当前版本！');
      }
    }
  } catch (e) {
    console.warn('   ⚠ 补齐当前版本日志失败：' + (e && e.message || e));
  }

  const changelogCode = 'window.__FR_CHANGELOG_BUILTIN__=' + JSON.stringify(bakedChangelog) + ';';
  html = injectBeforeAll(html, changelogCode);
  console.log('   更新日志: ' + bakedChangelog.length + ' 个版本已内置（window.__FR_CHANGELOG_BUILTIN__）: '
    + bakedChangelog.map(function (r) { return 'v' + r.version; }).join(', '));

  const outFile = path.join(REPO_ROOT, '凡人独立前端.html');
  await fs.writeFile(outFile, html, 'utf8');

  const size = Buffer.byteLength(html);
  const sha = crypto.createHash('sha256').update(html).digest('hex');
  console.log('');
  console.log('✅ 成品: ' + outFile);
  console.log('   大小: ' + (size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('   sha256: ' + sha.slice(0, 32) + '…');
  console.log('   双击即可打开（file:// 下无需服务器）');
}

main().catch(function (e) {
  console.error('[组装] 失败: ' + (e && e.stack || e));
  process.exit(1);
});
