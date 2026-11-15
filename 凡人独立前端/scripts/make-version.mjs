/* 生成热更新版本清单。
 *
 * 玩家方案：PC 端 + GitHub 托管 + 后台检查提示。
 *
 * 产出（都放 dist/，随打包进 app.asar；同时给 GitHub 上传用）：
 *   dist/build-info.json  ← 打包内置的版本信息（main.cjs 读它）
 *   发布包/version.json    ← 上传到 GitHub 的更新清单
 *   发布包/index.html      ← 上传到 GitHub 的更新包（就是 dist/index.html 副本）
 *
 * 用法：
 *   node scripts/make-version.mjs            # 用 package.json 的版本
 *   node scripts/make-version.mjs 0.1.1      # 指定版本
 *   node scripts/make-version.mjs 0.1.1 https://github.com/你/仓库
 *
 * 【为什么要 sha256】
 *   主进程下载更新包后必须校验 hash 是否符合。GitHub raw 偶尔会被运营商劫持，
 *   校验能保证玩家装到的就是作者发布的那份，否则宁可不更新。
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(OUT_ROOT, '..');

async function main() {
  const pkgPath = path.join(OUT_ROOT, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));

  let version = process.argv[2] || pkg.version || '0.1.0';
  const repoUrl = process.argv[3] || '';

  /* 版本号只有这一个来源：本脚本。
   * 传了参数就以参数为准，并**回写 package.json**，
   * 保证 package.json / 构建标记 / build-info.json / version.json 四处永远一致。
   * （曾出现三处版本号各不相同，导致版本页面显示的和实际打包的对不上） */
  if (version !== pkg.version) {
    pkg.version = version;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log('   已同步 package.json 版本号 → ' + version);
  }

  const distHtml = path.join(OUT_ROOT, 'dist', 'index.html');
  if (!existsSync(distHtml)) {
    throw new Error('缺少 dist/index.html，请先跑 node scripts/make-dist.mjs');
  }
  const buf = await fs.readFile(distHtml);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const size = buf.length;

  // 校验：产物里的构建标记版本号必须与本次发版版本一致，
  // 否则说明 dist 是旧的、没重新构建（踩过这个坑）。
  // 只扫开头 2000 字符 —— 标记永远在最前面，避免匹配到脚本源码里的示例文本。
  const htmlText = buf.toString('utf8');
  const stampMatch = htmlText.slice(0, 2000)
    .match(/<!--\s*凡人卡独立前端\s*·\s*build\s+[\d\-T:.Z]+\s*·\s*v?([\d.]+)\s*-->/);
  if (!stampMatch) {
    throw new Error(
      'dist/index.html 里找不到构建标记，说明不是 assemble.mjs 的产物。\n' +
      '请先重新跑 node scripts/assemble.mjs && node scripts/make-dist.mjs'
    );
  } else if (stampMatch[1] !== version) {
    throw new Error(
      '版本号不一致：dist/index.html 里是 v' + stampMatch[1] +
      '，但本次要发 v' + version + '。\n' +
      '请先重新跑 node scripts/assemble.mjs && node scripts/make-dist.mjs'
    );
  }

  // ① 内置版本信息（main.cjs 用它判断「当前装的是哪一版」）
  /* 更新源地址：优先命令行第 3 个参数，否则读 package.json 的 update 字段。
   *
   * 为什么要写进 build-info.json：主进程在 asar 里拿不到「用户改了哪一行」，
   * 但它能读 build-info.json。把地址固化进产物，就不需要每次发版手改 main.cjs。
   */
  /* 更新源地址：**一律用 raw.githubusercontent.com 直链**。
   *
   * 为什么不写 github.com/<owner>/<repo>/raw/<branch>/version.json：
   *   2026-11-01 玩家真实环境实测（代理 127.0.0.1:2080）：
   *     拉 github.com/.../raw/main/version.json → 301 **指回它自己** →
   *       主进程 httpsGet 把 redirects 耗尽 → 抛「重定向过多」→ 瞬间失败
   *       玩家看到的现象就是「点更新，一下就弹回来」。
   *     拉 raw.githubusercontent.com/.../main/version.json → 200，359ms。
   *   12MB 包体同理：raw 直链 990ms 下完、sha256 完全吻合；
   *   github.com 形式则根本拿不到文件。
   *
   * 裸 https.get 不像浏览器那样会自动处理相对跳转，这是 GitHub raw 最容易踩的坑。
   * 用直链最稳，且 raw.githubusercontent.com 本来就在 UPDATE_ALLOWED_HOSTS 白名单里，
   * 不改变任何安全边界。
   */
  const pkgUpdate = pkg.update || {};
  const branch = pkgUpdate.branch || 'main';
  const repoBase = (pkgUpdate.owner && pkgUpdate.repo)
    ? `https://raw.githubusercontent.com/${pkgUpdate.owner}/${pkgUpdate.repo}/${branch}`
    : '';
  if (!repoBase) {
    console.warn('⚠ package.json 缺 update.owner / update.repo，更新地址会回落占位符 —— 玩家点更新会 404！');
  }
  // 命令行显式传了仓库地址也归一化成 raw 直链，避免又拼出会 301 的 github.com 形式
  let manifestUrl = repoBase ? `${repoBase}/version.json` : '';
  if (repoUrl) {
    const m = String(repoUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
    if (m) manifestUrl = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/version.json`;
    else if (/^https:\/\/raw\.githubusercontent\.com\//.test(String(repoUrl))) {
      manifestUrl = `${String(repoUrl).replace(/\/+$/, '')}/version.json`;
    }
  }
  if (!manifestUrl) manifestUrl = 'https://raw.githubusercontent.com/OWNER/REPO/main/version.json';


  const buildInfo = {
    version,
    sha256: sha,
    size,
    builtAt: new Date().toISOString(),
    updateUrl: manifestUrl,
  };
  await fs.writeFile(
    path.join(OUT_ROOT, 'dist', 'build-info.json'),
    JSON.stringify(buildInfo, null, 2),
    'utf8'
  );

  // ② 同步写一份到 electron/ 旁边，方便本地调试（asar 里读的是 dist 那份）
  await fs.writeFile(
    path.join(OUT_ROOT, 'build-info.json'),
    JSON.stringify(buildInfo, null, 2),
    'utf8'
  );

  // ③ GitHub 更新清单
  const pubDir = path.join(REPO_ROOT, '发布包');
  await fs.mkdir(pubDir, { recursive: true });

  /* 更新日志。
   *
   * 玩家口径：「这一版更新内容删了，目前还没有更新过一次，不要写之前的内容」。
   * → 不传第 4 个参数就**不写任何条目**（首发版本没有历史可写）。
   *   别再用「常规更新」这种占位词凑数 —— 玩家一版没更新过，写了就是假的。
   *
   * 以后真发新版时：
   *   node scripts/make-version.mjs 0.1.3 <仓库> "修复A|新增B"
   * 条目会累积进 发布包/CHANGELOG.json，并写进 version.json 的 changelog。
   * 页面从远端读，改日志不用重新打包。
   */
  const notesArg = process.argv[4] || '';
  const newItems = notesArg
    ? notesArg.split('|').map((s) => s.trim()).filter(Boolean)
    : [];
  const today = new Date().toISOString().slice(0, 10);

  // 累积历史更新日志（只有真的传了条目才写）
  const changelogPath = path.join(pubDir, 'CHANGELOG.json');
  let changelog = [];
  try {
    if (existsSync(changelogPath)) {
      changelog = JSON.parse(await fs.readFile(changelogPath, 'utf8'));
      if (!Array.isArray(changelog)) changelog = [];
    }
  } catch (e) { changelog = []; }
  if (newItems.length) {
    changelog = changelog.filter((r) => r && r.version !== version);
    changelog.unshift({ version, date: today, items: newItems });
    await fs.writeFile(changelogPath, JSON.stringify(changelog, null, 2), 'utf8');
  } else if (existsSync(changelogPath)) {
    // 没传条目就保持原样，不新增也不删除
  }

  const notes = newItems.join('；');
  /* 下载地址。
   *
   * 【为什么是 raw 而不是 releases/latest/download】
   *   最简单的发布方式是把 index.html 直接放仓库根目录（GitHub 网页上传即可），
   *   不走 Releases。对应的 raw 地址就是 main 分支根目录的文件。
   *   仓库地址来自 manifestUrl（由 package.json.update 推出），不在这里另编一份，
   *   避免「清单地址」和「下载地址」指向两个不同的仓库。
   */
  /* 下载地址：**一律用 raw.githubusercontent.com 直链**。
   *
   * 【为什么不用 github.com/<owner>/<repo>/raw/<branch>/<file>】
   *   2026-11-01 实测（玩家真实环境 + 代理 127.0.0.1:2080）：
   *     · github.com/.../raw/main/version.json  → 301 指回它自己 → 无限重定向
   *       → 主进程 httpsGet 的 redirects 耗尽，抛「重定向过多」，**瞬间失败**
   *     · raw.githubusercontent.com/.../main/version.json → 200，359ms
   *   同样地，12MB 包体走 raw 直链 990ms 下完、sha256 完全吻合；
   *   走 github.com 形式则根本拿不到文件。
   *
   *   裸 https.get 不像浏览器那样会缓存/跟随 301，这是 GitHub 把
   *   raw 跳转做成「相对自身」后最容易踩的坑。用直链最稳，且不改变安全边界
   *   （raw.githubusercontent.com 本来就在 UPDATE_ALLOWED_HOSTS 白名单里）。
   */
  const pkgUpdate2 = pkg.update || {};
  const downloadUrl = (pkgUpdate2.owner && pkgUpdate2.repo)
    ? `https://raw.githubusercontent.com/${pkgUpdate2.owner}/${pkgUpdate2.repo}/${pkgUpdate2.branch || 'main'}/index.html`
    : 'https://raw.githubusercontent.com/OWNER/REPO/main/index.html';
  if (!pkgUpdate2.owner || !pkgUpdate2.repo) {
    console.warn('⚠ package.json 缺 update.owner / update.repo，下载地址回落占位符 —— 玩家点更新会 404！');
  }
  // 保留 ghBase 供下面的日志输出使用（与 downloadUrl 同源，不再单独推导）
  const ghBase = (pkgUpdate2.owner && pkgUpdate2.repo)
    ? `https://raw.githubusercontent.com/${pkgUpdate2.owner}/${pkgUpdate2.repo}/${pkgUpdate2.branch || 'main'}`
    : '';

  const manifest = {
    version,
    url: downloadUrl,
    sha256: sha,
    size,
    notes,
    changelog,
    releasedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(pubDir, 'version.json'), JSON.stringify(manifest, null, 2), 'utf8');
  // 更新包 = 当前 dist/index.html 的副本，直接传 GitHub 即可
  await fs.copyFile(distHtml, path.join(pubDir, 'index.html'));

  console.log('✅ 热更新清单已生成');
  console.log('   版本      : ' + version);
  console.log('   大小      : ' + (size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('   sha256    : ' + sha);
  console.log('   更新日志  : ' + newItems.length + ' 条，历史累计 ' + changelog.length + ' 个版本');
  newItems.forEach((it) => console.log('              · ' + it));
  console.log('   build-info: dist/build-info.json（打包内置）');
  console.log('   version   : ' + path.join(pubDir, 'version.json') + '（上传 GitHub）');
  console.log('   index.html: ' + path.join(pubDir, 'index.html') + '（上传 GitHub）');
  console.log('');
  console.log('   更新源（已写进 build-info.json，exe 启动后就读这个）：');
  console.log('     清单: ' + (manifestUrl || '（未配置！检查 package.json 的 update 字段）'));
  console.log('     包体: ' + downloadUrl);
  if (manifestUrl) {
    console.log('');
    console.log('   两个文件都要传到仓库根目录（' + (pkgUpdate.branch || 'main') + ' 分支）：');
    console.log('     version.json / index.html');
  }
}

main().catch((e) => {
  console.error('[版本清单] 失败:', e && e.stack || e);
  process.exit(1);
});
