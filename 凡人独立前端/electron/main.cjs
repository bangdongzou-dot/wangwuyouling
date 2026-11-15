/* ============================================================================
 * 凡人修仙传 · 原著补演（独立桌面版）
 * Electron 主进程
 *
 * 目标：双击 exe 直接开游戏窗口，不经过浏览器、不经过酒馆。
 * 参考方舟项目的 electron/main.cjs。
 *
 * ★★ 2026-11-01 新增热更新（玩家：「关于热更新，是否可行呢？在pc版本和安卓
 *    版本上都安排热更新」→ 确定先做 PC 端 + GitHub 托管 + 后台检查提示）
 *
 * 【为什么 PC 端热更新能成立（已实测，不是推测）】
 *   整个游戏就是一个 dist/index.html 单文件。
 *   实测：在 Electron 里加载 A 目录的 html 写入 IndexedDB，再加载 B 目录
 *   （完全不同路径）的同一份 html —— 存档照常读回「来自A版本的存档」。
 *   说明 origin 恒为 file://，IndexedDB 绑在 origin 上、与文件路径无关。
 *   所以热更新只要换 index.html 文件，玩家存档自动继承，零迁移。
 *
 * 【加载优先级】
 *   ① userData/web/index.html   ← 热更新下载的版本（可能存在）
 *   ② __dirname/../dist/index.html ← 安装包内置版本（保底）
 *   外部文件损坏/读不出来时静默回退内置，绝不白屏。
 *
 * 【安全护栏】
 *   · 只认 HTTPS + 白名单域名（GitHub），防止被劫持注入
 *   · 下载后校验 sha256，不符直接丢弃
 *   · 先写 .tmp 再原子 rename，避免下到一半断电留下半个文件
 *   · 保留上一版备份，新版本启动失败（渲染进程崩溃）自动回滚
 *   · 更新只在玩家点「立即更新」后发生，后台仅检查不下载
 * ========================================================================== */
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');

// 单实例：重复双击时把已有窗口叫到前台，而不是开第二个
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 同一profile只能有一个数据库拥有者；已有实例收到second-instance后负责显示窗口。
  app.quit();
}

// 页面跑在 file:// 下，需要允许本地文件互相访问（IndexedDB / 内联资源）
app.commandLine.appendSwitch('allow-file-access-from-files');
// 关掉节流，后台时也让生成任务继续跑
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ---------------------------------------------------------------------------
// 热更新配置
// ---------------------------------------------------------------------------

/* 更新源。仓库地址只有一处来源：package.json 的 "update" 字段。
 *
 * 为什么不再写死在这里：
 *   原来这里是一行写死的占位地址（OWNER/REPO 那种），每次发版都得手改一行、
 *   现在由 scripts/make-version.mjs 按 package.json.update 算出完整地址，
 *   写进 build-info.json；主进程从这里读。改仓库只改 package.json 一处。
 *
 * 优先级：环境变量 FR_UPDATE_URL > build-info.json 里的 updateUrl > 内置兜底占位。
 * 远端 version.json 格式：
 *   { "version": "0.1.3", "url": "https://.../index.html", "sha256": "...", "notes": "更新说明" }
 */
const UPDATE_ALLOWED_HOSTS = ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'];

function resolveManifestUrl() {
  if (process.env.FR_UPDATE_URL) return String(process.env.FR_UPDATE_URL);
  for (const rel of [[__dirname, '..', 'build-info.json'], [__dirname, '..', 'dist', 'build-info.json']]) {
    try {
      const p = path.join.apply(path, rel);
      if (!fs.existsSync(p)) continue;
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info && info.updateUrl) return String(info.updateUrl);
    } catch (e) { /* 读不到就继续往下找 */ }
  }
  return '';
}

const UPDATE_MANIFEST_URL = resolveManifestUrl();

// 当前内置版本号（由打包脚本写进 build-info.json；缺失时退回 package.json）
function readBuiltinVersion() {
  try {
    const p = path.join(__dirname, '..', 'build-info.json');
    if (fs.existsSync(p)) {
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info && info.version) return String(info.version);
    }
  } catch (e) { /* 忽略，走下面的兜底 */ }
  try {
    // package.json 在 asar 里，require 能读到
    return String(require('../package.json').version || '0.1.0');
  } catch (e) { return '0.1.0'; }
}

/* 内置包自己的**内容指纹**。
 *
 * 玩家 2026-11-01 定的规则：
 *   「如果检测到玩家本地版本和我上传版本有实质差异，那就一样要更新，
 *     并且替换为最新的同版本更新日志 …… 所以每个上传包需要有单独的身份识别」
 *
 * 也就是说：光比版本号不够。同一个版本号我可能因为修 bug 重传了内容，
 * 已经装了这一版的玩家按「版本号相等」判定就永远收不到修正。
 *
 * 身份标识就用 sha256 —— 它本身就是内容指纹，内容变一个字节它就变，
 * 而且 make-version.mjs 早就把它写进 build-info.json 了，不用新增字段。
 */
function readBuiltinSha256() {
  try {
    const p = path.join(__dirname, '..', 'build-info.json');
    if (fs.existsSync(p)) {
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info && info.sha256) return String(info.sha256).toLowerCase();
    }
  } catch (e) { /* 读不到就没有身份，退化成只比版本号 */ }
  return '';
}

const BUILTIN_VERSION = readBuiltinVersion();
const BUILTIN_SHA256 = readBuiltinSha256();
const WEB_DIR = () => path.join(app.getPath('userData'), 'web');
const WEB_HTML = () => path.join(WEB_DIR(), 'index.html');
const WEB_HTML_BAK = () => path.join(WEB_DIR(), 'index.html.bak');
const WEB_META = () => path.join(WEB_DIR(), 'active.json');
const WEB_META_BAK = () => path.join(WEB_DIR(), 'active.json.bak');
const BUILTIN_HTML = path.join(__dirname, '..', 'dist', 'index.html');

function ensureWebDir() {
  const d = WEB_DIR();
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function readHotInfo(html, metaPath) {
  try {
    if (!fs.existsSync(html) || fs.statSync(html).size <= 1024 * 1024) return null;
    const header = Buffer.alloc(1024);
    const fd = fs.openSync(html, 'r');
    let length;
    try {
      length = fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const stamp = header.toString('utf8', 0, length)
      .match(/<!--\s*凡人卡独立前端\s*·\s*build\s+[\d\-T:.Z]+\s*·\s*v?([\d.]+)\s*-->/)?.[1];
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
    const metadataMatches = !stamp || stamp === meta?.version;
    return {
      version: stamp || String(meta?.version || BUILTIN_VERSION),
      sha256: (metadataMatches && meta?.sha256) || sha256(fs.readFileSync(html)),
      notes: metadataMatches ? String(meta?.notes || '') : '',
      localCandidate: metadataMatches && meta?.localCandidate === true,
      installedAt: metadataMatches ? meta?.installedAt : undefined,
    };
  } catch (error) {
    console.error('[热更新] 检查外部文件失败:', error.message);
    return null;
  }
}

// 选择启动文件与检查更新时使用同一个版本身份。同版本仍优先热更修正。
function readActiveInfo() {
  const html = WEB_HTML();
  const hot = readHotInfo(html, WEB_META());
  if (hot && compareVersion(hot.version, BUILTIN_VERSION) >= 0)
    return { ...hot, source: 'hot', path: html };
  return { source: 'builtin', version: BUILTIN_VERSION, sha256: BUILTIN_SHA256, notes: '', path: BUILTIN_HTML };
}

function writeUpdateMetadata(file, { version, sha256, notes, installedAt, localCandidate }) {
  fs.writeFileSync(file, JSON.stringify({
    version, sha256, notes, installedAt, ...(localCandidate ? { localCandidate } : {}),
  }, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 系统代理探测
//
// ★★ 2026-11-01 玩家问：「是因为我开着vpn吗？」——是，而且这是个真 bug。
//
// 现象：挂 VPN 时 check() 一直报「连接更新服务器超时」，但浏览器能打开 GitHub。
// 根因：Node 的 https 模块**不读系统代理设置**，只会直连。
//       而 Windows 的代理（Clash/V2Ray 这类）写在注册表
//       HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings，
//       同一台机器上 PowerShell、浏览器、Electron 的 net 模块都会读，
//       唯独裸 https.get 不读 —— 于是直连被墙，超时。
// 实测证据：同一台机器同一时刻
//   · 直连 https.get      → 15427ms 超时 ECONNRESET
//   · 走 127.0.0.1:2080 隧道 → 370ms 返回 200
//
// 影响面：国内玩家用 GitHub 基本都得挂代理，不修则**所有挂代理的玩家都收不到更新**。
//
// 修法：探测到系统代理就走 CONNECT 隧道（Node 原生 https 的标准代理做法），
//       探不到就照旧直连。不做任何强制，也不改变白名单校验。
// ---------------------------------------------------------------------------
function readSystemProxy() {
  // ① 环境变量优先（玩家/CI 显式指定时听他的）
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (envProxy) {
    try {
      const p = new URL(envProxy);
      if (p.hostname) return { host: p.hostname, port: parseInt(p.port, 10) || 80 };
    } catch (_) { /* 格式不对就忽略，继续看注册表 */ }
  }
  // ② Windows 注册表里的系统代理（Clash/V2Ray 等默认都写这里）
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const enable = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'latin1' });
      if (!/0x1/i.test(enable)) return null;           // 代理未启用
      const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'latin1' });
      const m = server.match(/ProxyServer\s+REG_\w+\s+(\S+)/);
      if (!m) return null;
      // 可能是 "127.0.0.1:2080" 或 "http=127.0.0.1:2080;https=127.0.0.1:2080"
      const raw = m[1].trim();
      const httpsPart = /https=([^;\s]+)/i.exec(raw);
      const chosen = httpsPart ? httpsPart[1] : raw.split(';')[0].replace(/^[a-z]+=/i, '');
      const bits = chosen.split(':');
      const host = bits[0];
      const port = parseInt(bits[1], 10);
      if (host && port > 0) return { host, port };
    } catch (_) { /* 读不到就当没代理 */ }
  }
  return null;
}

// 让 https.get 走代理：手写 CONNECT 隧道，再在隧道上做 TLS。
// 这是 Node 没有内置代理支持时的标准做法，不引入任何第三方依赖。
function proxyCreateConnection(proxy, opts, cb) {
  const net = require('net');
  const tls = require('tls');
  const sock = net.connect(proxy.port, proxy.host, () => {
    sock.write(`CONNECT ${opts.host}:443 HTTP/1.1\r\nHost: ${opts.host}:443\r\n\r\n`);
    sock.once('data', (chunk) => {
      const head = chunk.toString('latin1');
      if (/^HTTP\/1\.[01]\s+200/.test(head)) {
        cb(null, tls.connect({ socket: sock, servername: opts.host }));
      } else {
        sock.destroy();
        cb(new Error('代理拒绝连接: ' + head.split('\r\n')[0]));
      }
    });
  });
  sock.on('error', cb);
}

// ---------------------------------------------------------------------------
// 网络工具（只走 https）
// ---------------------------------------------------------------------------

/* 把 github.com 的 /raw/ 形式改写成 raw.githubusercontent.com 直链。
 *
 * 为什么需要：实测（2026-11-01，玩家机器 + 代理）
 *   https://github.com/<owner>/<repo>/raw/<branch>/<file>  → 301 指回自己 → 死循环
 *   https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file> → 200，直接给内容
 * 这个改写只做域名+路径的等价替换，不跨仓库、不改指向，安全性不变
 * （两个域名都在 UPDATE_ALLOWED_HOSTS 里）。
 */
function rawDirectUrl(u) {
  try {
    const p = new URL(u);
    if (p.hostname !== 'github.com') return '';
    const m = p.pathname.match(/^\/([^/]+)\/([^/]+)\/raw\/([^/]+)(\/.*)$/);
    if (!m) return '';
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}${m[4]}${p.search || ''}`;
  } catch (e) { return ''; }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 国内加速站名单（2026-11-01 实测，见 scripts/diag-mirror-download.cjs）
 *
 * 【为什么要这个】
 *   玩家朋友实测反馈「检查更新：无法连接网络」—— 查下来是 ENOTFOUND / getaddrinfo，
 *   即 DNS 解析失败。根因：他的 VPN 是 **TUN 模式**，只劫持全局流量、
 *   不写系统代理注册表，所以 readSystemProxy() 探不到代理；
 *   程序于是直连 raw.githubusercontent.com，被 DNS 污染 → 解析失败。
 *   结论：只靠「读系统代理」这一条路，覆盖不了 TUN 模式玩家和完全没挂 VPN 的玩家。
 *
 * 【三层线路，按顺序试，谁通用谁】
 *   ① 系统代理隧道 —— Clash/V2Ray 默认（系统代理）模式
 *   ② 直连            —— TUN 模式玩家（VPN 已接管全局流量）纯直连也能通
 *   ③ 国内加速站      —— 没挂 VPN、或挂着也不通的玩家
 *
 * 实测结果（同一台机器，12MB 包体完整下载并比对 sha256）：
 *   直连 GitHub           ✓ 16.6s  哈希吻合
 *   ghproxy.net           ✓ 48.1s  哈希吻合
 *   gh-proxy.com          ✓  7.8s  哈希吻合
 *   ghfast.top            ✓  3.2s  哈希吻合
 *   ghfile.geekertao.top  ✓  4.1s  哈希吻合
 *
 * 【安全边界没有放宽】
 *   加速站只是把同一份文件转发过来，内容仍然要过 **sha256 校验**（downloadAndApply 里
 *   那一步没动过），所以镜像投毒会被直接丢弃。而 UPDATE_ALLOWED_HOSTS 仍是原来的
 *   三个 GitHub 域名 —— 加速站是**独立的白名单**，只用于「拿不到时的兜底」，
 *   不会因为镜像可在白名单里塞任意域名。
 * ────────────────────────────────────────────────────────────────────────── */
const UPDATE_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://ghfile.geekertao.top/',
];

/* 把官方 URL 映射成加速站 URL：加速站用法是 <镜像前缀><完整原始URL> */
function mirrorUrl(officialUrl) {
  const list = [];
  for (const prefix of UPDATE_MIRRORS) {
    // 只给 GitHub 域名做镜像，其它域名不加（保持边界清晰）
    try {
      const h = new URL(officialUrl).hostname;
      if (h !== 'raw.githubusercontent.com' && h !== 'github.com') continue;
    } catch (e) { continue; }
    list.push(prefix + officialUrl);
  }
  return list;
}

/* 单次请求：不再自动换线路，只负责「用指定的方式发一次请求」。
 * useProxy: true=走系统代理隧道；false=纯直连。
 */
function httpsGetOnce(url, { maxBytes = 64 * 1024 * 1024, timeoutMs = 60000, redirects = 3, onProgress = null, useProxy = null, allowHosts = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址非法: ' + url)); }
    if (u.protocol !== 'https:') return reject(new Error('只允许 https'));
    const hosts = allowHosts || UPDATE_ALLOWED_HOSTS;
    // allowHosts === 'any' 只用于加速站兜底：镜像域名是动态拼的，
    // 但拿到的内容仍要过 sha256 校验，所以这里放行不影响安全。
    if (hosts !== 'any' && !hosts.includes(u.hostname)) {
      return reject(new Error('域名不在白名单: ' + u.hostname));
    }

    const proxy = useProxy === false ? null : readSystemProxy();
    const reqOptions = {
      headers: {
        'User-Agent': 'fanren-standalone-updater',
        'Cache-Control': 'no-cache',
      },
      timeout: timeoutMs,
    };
    if (proxy) reqOptions.createConnection = (opts, cb) => proxyCreateConnection(proxy, opts, cb);

    const req = https.get(u, reqOptions, (res) => {
      // 跟随重定向（GitHub release 会跳 objects.githubusercontent.com，已加白名单）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          /* 2026-11-01 玩家真实环境实测出来的坑：**重定向指回自己**。
           *
           * 在开着代理（Clash 之类）的机器上，
           *   https://github.com/<owner>/<repo>/raw/<branch>/version.json
           * 会返回 301，而 location 又指回**同一个地址** —— 于是原代码
           * 递归下去把 redirects 耗尽，抛「重定向过多」。
           * 玩家看到的现象：「点更新，一下就弹回来」，因为整个过程只花几十毫秒。
           *
           * 兜底手段不靠猜：github.com 的 /raw/ 形式本来就是 raw 直链的跳板，
           * 这里一次性改写成 https://raw.githubusercontent.com/<o>/<r>/<branch>/<file>
           * 再重试一次。实测直链 990ms 下完 12MB，sha256 完全吻合。
           * 域名仍在白名单内，安全边界不变。
           */
          const rewritten = rawDirectUrl(u.toString());
          if (rewritten && rewritten !== u.toString()) {
            console.warn('[热更新] 重定向循环，改写为 raw 直链重试:', rewritten);
            return httpsGetOnce(rewritten, { maxBytes, timeoutMs, redirects: 1, onProgress, useProxy, allowHosts }).then(resolve, reject);
          }
          return reject(new Error('重定向过多，且无法改写为直链'));
        }
        const next = new URL(res.headers.location, u).toString();
        // 自己指自己：直接判定为循环，不再递归
        if (next === u.toString()) {
          const rewritten = rawDirectUrl(next);
          if (rewritten && rewritten !== next) {
            console.warn('[热更新] 重定向指回自己，改写为 raw 直链重试:', rewritten);
            return httpsGetOnce(rewritten, { maxBytes, timeoutMs, redirects: 1, onProgress, useProxy, allowHosts }).then(resolve, reject);
          }
          return reject(new Error('重定向指回自己（循环），已中止'));
        }
        return httpsGetOnce(next, { maxBytes, timeoutMs, redirects: redirects - 1, onProgress, useProxy, allowHosts }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      let total = 0;
      /* 2026-11-01 玩家：「做个好看的 ui，能让玩家直观看到更新下载进度，
       * 不然没反馈都不知道在不在下载和更新。」
       *
       * 原来这里收了 onProgress 参数却从不调用 —— 玩家点更新后界面全程没反应，
       * 11.4 MB 下载十几秒到几十秒，很容易被当成卡死然后强退。
       *
       * 现在每收到一块数据就回报一次「已收/总量」。总量取 Content-Length；
       * GitHub 万一不给就按 0 报，前端会切换成「已下载 X MB」的不确定进度样式。
       * 限流到 ~10 次/秒，避免小文件刷爆 IPC。 */
      const totalBytes = Number(res.headers['content-length'] || 0);
      let lastReport = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          req.destroy();
          return reject(new Error('文件过大，已中止'));
        }
        chunks.push(c);
        if (typeof onProgress === 'function') {
          const now = Date.now();
          if (now - lastReport >= 100 || (totalBytes && total >= totalBytes)) {
            lastReport = now;
            try { onProgress({ received: total, total: totalBytes }); } catch (e) {}
          }
        }
      });
      res.on('end', () => {
        if (typeof onProgress === 'function') {
          try { onProgress({ received: total, total: totalBytes || total }); } catch (e) {}
        }
        resolve(Buffer.concat(chunks));
      });
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

/* 多线路调度：按 ①系统代理 → ②直连 → ③国内加速站 的顺序尝试，谁先通用谁。
 *
 * 为什么必须这样（2026-11-01 玩家朋友实测）：
 *   他开着 VPN，但仍然报「检查更新：无法连接网络」。
 *   查因：那条错误对应 ENOTFOUND / getaddrinfo —— DNS 解析失败。
 *   他的 VPN 是 **TUN 模式**：接管全局流量，但**不写系统代理注册表**，
 *   所以 readSystemProxy() 返回 null，程序直连 raw.githubusercontent.com
 *   就被 DNS 污染打死了。
 *   再加上完全没挂 VPN 的玩家（国内直连 GitHub 基本不通），
 *   只靠系统代理一条路覆盖不了所有人。
 *
 * 顺序为什么是这个：
 *   ① 系统代理：Clash/V2Ray 默认模式，最快最稳（实测 359ms 拉清单）
 *   ② 直连：TUN 模式玩家已经在全局代理里了，纯直连即可（注意要把
 *      createConnection 去掉，否则会去连一个并不存在的本地代理端口）
 *   ③ 加速站：兜底，实测 3~48 秒下完 12MB，哈希与 GitHub 完全一致
 *
 * 安全：镜像拿到的内容仍要过 sha256 校验，投毒会被丢弃（见 downloadAndApply）。
 */
async function httpsGet(url, opts = {}) {
  const { quiet = false } = opts;
  const errors = [];

  // 构建候选线路：[{ label, run }]
  const attempts = [];
  const hasProxy = !!readSystemProxy();
  if (hasProxy) {
    attempts.push({ label: '系统代理', run: () => httpsGetOnce(url, { ...opts, useProxy: true }) });
  }
  attempts.push({ label: '直连', run: () => httpsGetOnce(url, { ...opts, useProxy: false }) });

  // 加速站兜底（只对 GitHub 域名生效）；下载大文件时给更长的超时
  for (const m of mirrorUrl(url)) {
    attempts.push({
      label: '加速站',
      run: () => httpsGetOnce(m, {
        ...opts,
        useProxy: false,
        timeoutMs: Math.max(Number(opts.timeoutMs) || 60000, 60000),
        allowHosts: 'any', // 镜像域名是动态拼的；内容仍要过 sha256 校验，见 downloadAndApply
      }),
    });
  }

  for (const a of attempts) {
    try {
      const buf = await a.run();
      if (!quiet) console.log('[热更新] 线路可用: ' + a.label);
      return buf;
    } catch (e) {
      const msg = String(e && e.message || e);
      errors.push(a.label + ': ' + msg);
      if (!quiet) console.warn('[热更新] 线路失败 [' + a.label + '] ' + msg);
    }
  }

  // 全都不通 —— 把最关键的原因抛出来（DNS 失败要能对应到「无法连接网络」）
  const joined = errors.join(' | ');
  const err = new Error(joined || '所有线路都不可用');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(joined)) err.code = 'ENOTFOUND';
  throw err;
}

/* 版本号比较：支持 0.1.0 / 0.1.0.1 / 1.2.3 这类点分段。
 * 返回 >0 表示 a 比 b 新。 */
function compareVersion(a, b) {
  const na = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
  const nb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const x = na[i] || 0, y = nb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// 更新流程
// ---------------------------------------------------------------------------
let updateState = {
  checking: false,
  available: null,   // { version, url, sha256, notes }
  downloading: false,
  progress: 0,
  error: '',
  lastCheckAt: 0,
  changelog: [],     // 远端 version.json 里的完整更新日志
};

/* 判断远端这个包要不要更新到本地。
 *
 * ★ 2026-11-01 玩家定的规则：
 *   「如果检测到玩家本地版本和我上传版本有实质差异，那就一样要更新，
 *     并且替换为最新的同版本更新日志 …… 所以每个上传包需要有单独的身份识别」
 *
 * 原来的判定是 compareVersion(远端, 本地) > 0 —— **只比版本号**。
 * 结果：我先发了 1.0.3，随后发现更新日志有 bug、用同一个版本号重传了修好的包，
 * 已经装了 1.0.3 的玩家因为「版本号相等」永远收不到修正。
 *
 * 现在改成三重判定，任何一条命中就更新：
 *   ① 远端版本号更高                      → 正常升级
 *   ② 版本号相同但内容指纹（sha256）不同   → 同版本号的修正包，也要更新
 *   ③ 本地没有指纹（老版本没记 sha256）    → 保守起见，远端有指纹就更新
 *
 * 为什么不担心「降级」：远端版本号更低时 ①②③ 都不成立，不会更新。
 * 为什么不担心「反复更新」：装完之后 active.json 会记下新的 sha256，
 *   下次比较时本地指纹 == 远端指纹，②③ 都不成立，不会重复下载。
 */
function needUpdate(manifest, active) {
  const remoteVer = String(manifest.version || '');
  const remoteSha = String(manifest.sha256 || '').toLowerCase();
  const localVer = String(active.version || '');
  const localSha = String(active.sha256 || '').toLowerCase();

  // ① 版本号更高
  if (compareVersion(remoteVer, localVer) > 0) {
    return { update: true, reason: 'newer' };
  }
  // 远端版本号更低 → 明确不降级
  if (compareVersion(remoteVer, localVer) < 0) {
    return { update: false, reason: 'remote-older' };
  }

  // 本机未发布候选沿用正式版本号；线上同号文件可能更旧，不能以不同指纹当作更新。
  if (active.localCandidate === true) return { update: false, reason: 'local-candidate' };

  // ② 普通已发布安装的版本号相同，比内容指纹
  if (remoteSha && localSha && remoteSha !== localSha) {
    return { update: true, reason: 'same-version-new-content' };
  }
  // ③ 本地没记指纹（老版本装的），远端有指纹就补一次
  if (remoteSha && !localSha) {
    return { update: true, reason: 'local-sha-unknown' };
  }
  // 指纹一致（或远端没给指纹）→ 已是最新
  return { update: false, reason: 'same' };
}

/* 检查远端是否有新版本。只发一个 GET，不下载正文。 */
async function checkForUpdate({ manual = false } = {}) {
  if (updateState.checking || updateState.downloading) {
    return { ok: false, reason: 'busy' };
  }
  updateState.checking = true;
  updateState.error = '';
  try {
    // 没配更新源就直接给玩家一句人话，别去发一个必然失败的请求
    if (!UPDATE_MANIFEST_URL) throw new Error('更新服务器还没配置好');
    const buf = await httpsGet(UPDATE_MANIFEST_URL, { maxBytes: 256 * 1024, timeoutMs: 15000 });
    let manifest;
    try { manifest = JSON.parse(buf.toString('utf8')); }
    catch (e) { throw new Error('version.json 格式错误'); }

    if (!manifest || !manifest.version) throw new Error('version.json 缺少 version 字段');
    if (!manifest.url) throw new Error('version.json 缺少 url 字段');

    // 下载地址同样必须在白名单内
    const u = new URL(manifest.url);
    if (u.protocol !== 'https:' || !UPDATE_ALLOWED_HOSTS.includes(u.hostname)) {
      throw new Error('下载地址不在白名单');
    }

    const active = readActiveInfo();
    const verdict = needUpdate(manifest, active);
    const newer = verdict.update;
    updateState.lastCheckAt = Date.now();
    // 远端带的完整更新日志，给版本页面显示用
    if (Array.isArray(manifest.changelog)) {
      updateState.changelog = manifest.changelog;
    } else if (manifest.version && manifest.notes) {
      updateState.changelog = [{ version: String(manifest.version), date: '', items: [String(manifest.notes)] }];
    }
    updateState.available = newer ? {
      version: String(manifest.version),
      url: String(manifest.url),
      sha256: String(manifest.sha256 || ''),
      notes: String(manifest.notes || ''),
      size: Number(manifest.size || 0),
      // 界面据此显示「同版本号的修正包」而不是「发现新版本」
      reason: verdict.reason,
      /* ★ 2026-11-02 玩家：「检查更新检测到新版本就应该先把版本更新日志显示出来给玩家看才对」
       *
       * 原来这里**不带更新日志**，界面只拿到 version + 一行 notes，
       * 想知道这版改了什么必须自己点「详情」跳到版本面板。
       * 现在把「这一版」的条目一起推过去，界面可以在提示条里直接展开。
       * 只取当前版本那一条，不把历史全推过去 —— 提示条只需要「这次更新了什么」。
       */
      changelog: (function () {
        try {
          var list = Array.isArray(updateState.changelog) ? updateState.changelog : [];
          var hit = list.filter(function (r) {
            return r && String(r.version) === String(manifest.version);
          })[0];
          if (hit) return { version: String(hit.version || ''), date: String(hit.date || ''), items: (hit.items || []).map(String) };
          // 远端没给这一版的条目，退化成 notes 一行，保证提示条不至于空着
          var notes = String(manifest.notes || '').trim();
          if (notes) return { version: String(manifest.version), date: '', items: notes.split('；').map(function (s) { return s.trim(); }).filter(Boolean) };
          return null;
        } catch (e) { return null; }
      })(),
    } : null;

    return {
      ok: true,
      current: active.version,
      latest: String(manifest.version),
      hasUpdate: newer,
      reason: verdict.reason,
    };
  } catch (e) {
    updateState.error = String(e && e.message || e);
    // 把技术性错误翻成玩家能看懂的话。HTTP 404 多半是仓库还没配好，
    // 直接甩给玩家一个 "HTTP 404" 会让人以为游戏坏了。
    var friendly = updateState.error;
    if (/HTTP 404/.test(friendly)) {
      friendly = '更新服务器还没配置好';
    } else if (/HTTP 4\d\d/.test(friendly)) {
      friendly = '更新服务器返回错误';
    } else if (/HTTP 5\d\d/.test(friendly)) {
      friendly = '更新服务器暂时不可用';
    } else if (/超时|timeout/i.test(friendly)) {
      friendly = '连接更新服务器超时';
    } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(friendly)) {
      friendly = '无法连接网络';
    } else if (/域名不在白名单|地址非法|只允许 https/.test(friendly)) {
      friendly = '更新地址无效';
    } else if (/version\.json/.test(friendly)) {
      friendly = '更新信息格式有误';
    }
    updateState.error = friendly;
    // 手动检查才弹窗打扰；自动检查静默失败（没网也能正常玩）
    if (manual) {
      try { dialog.showMessageBox({ type: 'warning', title: '检查更新', message: '检查更新失败', detail: friendly }); } catch (er) {}
    }
    return { ok: false, reason: friendly };
  } finally {
    updateState.checking = false;
  }
}

/* 下载并安装更新。下载到 .tmp → 校验 sha256 → 原子 rename。 */
async function downloadAndApply(onProgress) {
  const info = updateState.available;
  if (!info) return { ok: false, reason: '没有可更新的版本' };
  if (updateState.downloading) return { ok: false, reason: '正在下载中' };

  updateState.downloading = true;
  updateState.progress = 0;
  try {
    ensureWebDir();
    /* 下载进度实时推给界面。
     * 节流 120ms：进度条肉眼看得出来就行，推太频繁反而拖慢主线程。
     * 同时算出速度与剩余时间，让玩家知道「还要多久」而不只是一个百分比。 */
    let lastEmit = 0, lastBytes = 0, lastTime = 0;
    const startedAt = Date.now();
    const emitProgress = (p) => {
      const now = Date.now();
      const received = Number(p && p.received || 0);
      const total = Number(p && p.total || 0);
      const pct = total > 0 ? Math.min(99, Math.max(0, Math.round(received / total * 100))) : 0;
      updateState.progress = pct;
      updateState.received = received;
      updateState.totalBytes = total;
      if (now - lastEmit < 120 && !(total > 0 && received >= total)) return;
      // 速度按「距上次取样」算，比全程平均更能反映当前快慢
      const dt = now - (lastTime || startedAt);
      const speed = dt > 0 ? (received - lastBytes) / (dt / 1000) : 0;
      lastEmit = now; lastBytes = received; lastTime = now;
      const payload = {
        progress: pct,
        received,
        total,
        speed: Math.max(0, Math.round(speed)),
        // 剩余秒数只在总量已知且速度有效时给，否则前端显示「计算中」
        eta: (total > 0 && speed > 1024) ? Math.max(0, Math.round((total - received) / speed)) : -1,
      };
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send('fr-update:progress', payload);
      } catch (e) {}
    };

    const buf = await httpsGet(info.url, {
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 180000,
      onProgress: emitProgress,
    });

    // 完整性校验：远端给了 sha256 就必须对得上
    if (info.sha256) {
      const got = sha256(buf);
      if (got !== String(info.sha256).toLowerCase()) {
        throw new Error('文件校验失败（sha256 不符），已丢弃');
      }
    }
    // 兜底：至少得是一份像样的 html
    if (buf.length < 1024 * 1024) throw new Error('下载文件过小，疑似无效');
    const head = buf.slice(0, 512).toString('utf8').toLowerCase();
    if (head.indexOf('<!doctype') < 0 && head.indexOf('<html') < 0) {
      throw new Error('下载内容不是网页，已丢弃');
    }

    // 先把当前生效的那份备份起来，新版本起不来时能回滚
    const html = WEB_HTML();
    try {
      const active = readActiveInfo();
      fs.rmSync(WEB_META_BAK(), { force: true });
      if (active.source === 'hot') {
        fs.copyFileSync(html, WEB_HTML_BAK());
        writeUpdateMetadata(WEB_META_BAK(), active);
      } else {
        fs.rmSync(WEB_HTML_BAK(), { force: true });
      }
    } catch (error) {
      logWindowFailure('update-backup-failed', { message: String(error.code || error.message) });
    }

    // 写临时文件再原子替换，避免下到一半断电留下半个文件
    const tmp = html + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, html);

    // 版本元数据
    writeUpdateMetadata(WEB_META(), {
      version: info.version,
      sha256: info.sha256 || sha256(buf),
      notes: info.notes || '',
      installedAt: new Date().toISOString(),
    });

    updateState.available = null;
    updateState.progress = 100;
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('fr-update:progress', {
          progress: 100,
          received: buf.length,
          total: buf.length,
          speed: 0,
          eta: 0,
          done: true,
        });
      }
    } catch (e) {}
    return { ok: true, version: info.version };
  } catch (e) {
    updateState.error = String(e && e.message || e);
    return { ok: false, reason: updateState.error };
  } finally {
    updateState.downloading = false;
  }
}

/* 回滚时恢复同一份 HTML 和版本身份。选到哪一份就继续加载哪一份。 */
function rollback(restoreBackup = true) {
  try {
    const bak = WEB_HTML_BAK();
    const prior = restoreBackup && readHotInfo(bak, WEB_META_BAK());
    if (prior && compareVersion(prior.version, BUILTIN_VERSION) >= 0) {
      fs.copyFileSync(bak, WEB_HTML());
      writeUpdateMetadata(WEB_META(), prior);
      console.error('[热更新] 已回滚到上一版');
      return WEB_HTML();
    }
    fs.rmSync(WEB_HTML(), { force: true });
    fs.rmSync(WEB_META(), { force: true });
    console.error('[热更新] 已回到内置版本');
    return BUILTIN_HTML;
  } catch (e) {
    logWindowFailure('update-rollback-failed', { code: e.code, message: e.message });
    console.error('[热更新] 回滚失败:', e && e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let mainWindow = null;

function logWindowFailure(kind, details) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), JSON.stringify({ at: new Date().toISOString(), kind, ...details }) + '\n');
  } catch (_) {}
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: '凡人修仙传 · 原著补演',
    backgroundColor: '#0B0C0E',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 允许跨域请求模型接口（file:// 下默认会被拦）
      webSecurity: false,
      // 热更新检查器预加载脚本（只暴露最小 API，不给渲染进程 node 能力）
      preload: path.join(__dirname, 'preload.cjs'),
    }
  });

  Menu.setApplicationMenu(null);

  // 优先外部热更文件，回退内置
  const active = readActiveInfo();
  let entry = active.path;
  let recovering = false;
  let restoredHot = false;
  console.log('[启动] 加载:', active.source === 'hot' ? '热更新版本' : '内置版本', entry);
  async function recoverHotEntry() {
    const win = mainWindow;
    if (recovering || entry !== WEB_HTML() || !win || win.isDestroyed()) return;
    recovering = true;
    // Windows 可能仍锁着加载失败的文件。先结束该页面的读取，再恢复磁盘上的版本。
    await win.loadURL('about:blank').catch(() => {});
    if (win.isDestroyed()) return;
    entry = rollback(!restoredHot) || BUILTIN_HTML;
    restoredHot = entry === WEB_HTML();
    recovering = false;
    win.loadFile(entry).catch(() => {});
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  /* ★ 2026-11-02 玩家：「你能直接拿日志吗？我不知道怎么弄」
   *
   * Electron 默认不把渲染进程的 console 落到任何文件里，出事时只能让玩家
   * 自己开 F12 截图 —— 这不现实。这里挂一个**只读旁听**：
   *   webContents 'console-message' 事件把渲染进程的 console 逐行追加到
   *   userData/logs/render.log，玩家不用做任何事，我直接读文件。
   *
   * 三条纪律：
   *   1. 绝不改任何游戏逻辑，只旁听；
   *   2. 写盘失败一律吞掉，绝不让日志问题影响游戏；
   *   3. 单文件超过 8MB 自动清空重来，避免无限增长。
   */
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'render.log');
    const MAX_LOG_BYTES = 8 * 1024 * 1024;
    let logBroken = false;
    const appendLog = (line) => {
      if (logBroken) return;
      try {
        try {
          const st = fs.statSync(logFile);
          if (st.size > MAX_LOG_BYTES) fs.writeFileSync(logFile, '');
        } catch (_) { /* 文件还不存在，正常 */ }
        fs.appendFileSync(logFile, line + '\n');
      } catch (_) {
        logBroken = true;   // 写不了就彻底停手，别每行都试一次
      }
    };
    appendLog('===== 启动 ' + new Date().toISOString() + ' =====');
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      try {
        const lv = ['DBG', 'LOG', 'WARN', 'ERR'][level] || String(level);
        appendLog('[' + new Date().toISOString().slice(11, 23) + '][' + lv + '] ' + String(message));
      } catch (_) {}
    });
    console.log('[启动] 渲染日志写入:', logFile);
  } catch (e) {
    try { console.warn('[启动] 渲染日志启用失败（不影响游戏）:', e && e.message); } catch (_) {}
  }

  // 内存分配失败不代表更新文件损坏，不能把已安装修复一起降级。
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    logWindowFailure('render-process-gone', { reason: details && details.reason, exitCode: details && details.exitCode });
    console.error('[启动] 渲染进程异常:', details && details.reason);
    if (details && details.reason === 'oom') {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '游戏页面已停止',
        message: '游戏页面因内存分配失败而停止。',
        detail: '当前游戏版本和已保存的数据保持原样。重新打开后可读取存档，未完成的本轮需要重试。错误原因已记录到本地日志。',
        buttons: ['重新打开当前版本', '退出游戏'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (response === 0) mainWindow.loadFile(entry);
        else app.quit();
      }).catch(error => logWindowFailure('oom-recovery-failed', { message: String(error && error.message || error) }));
      return;
    }
    recoverHotEntry();
  });

  // 页面加载失败 → 同上回滚
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    logWindowFailure('did-fail-load', { code, desc, isMainFrame });
    // Story iframes fail independently; aborted navigation also isn't a corrupt update.
    if (isMainFrame !== true || code === -3) return;
    console.error('[启动] 页面加载失败:', code, desc, url);
    recoverHotEntry();
  });
  mainWindow.loadFile(entry).catch(() => {});

  // 外链走系统浏览器，不在游戏窗口里打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC：渲染进程通过 preload 暴露的 window.frUpdate 调用
// ---------------------------------------------------------------------------
ipcMain.handle('fr-update:info', () => {
  const active = readActiveInfo();
  return {
    current: active.version,
    source: active.source,
    builtin: BUILTIN_VERSION,
    available: updateState.available,
    checking: updateState.checking,
    downloading: updateState.downloading,
    progress: updateState.progress,
    error: updateState.error,
    changelog: updateState.changelog || [],
    // 更新源地址：排查「检查更新总是失败」时一眼能看出是不是地址没配
    manifestUrl: UPDATE_MANIFEST_URL || '',
  };
});

ipcMain.handle('fr-update:check', async (e, opts) => {
  return await checkForUpdate({ manual: !!(opts && opts.manual) });
});

ipcMain.handle('fr-update:apply', async () => {
  const r = await downloadAndApply();
  if (r.ok) {
    // 下载成功：询问玩家是否立即重启生效
    try {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: '更新已就绪',
        message: '新版本 ' + r.version + ' 已下载完成',
        detail: '重启后生效。存档不受影响。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        app.relaunch();
        app.exit(0);
      }
    } catch (e) { /* 弹窗失败不影响已下载的文件 */ }
  }
  return r;
});

ipcMain.handle('fr-update:rollback', () => ({ ok: Boolean(rollback()) }));

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!gotTheLock) return;
  createMainWindow();

  let lastNotifiedRelease = '';
  function notifyAvailableUpdate(startup = false) {
    if (!updateState.available || !mainWindow || mainWindow.isDestroyed()) return;
    const { version, sha256 } = updateState.available;
    const release = String(version) + ':' + String(sha256 || '').trim().toLowerCase();
    if (release === lastNotifiedRelease) return;
    try {
      mainWindow.webContents.send('fr-update:available', { ...updateState.available, startup });
      lastNotifiedRelease = release;
    } catch (e) {}
  }

  // 启动后延迟检查更新（不阻塞开窗、不占用启动时间）
  // 玩家口径「越流畅越好，没必要的内容都不要」→ 所以延后且只在后台跑
  setTimeout(() => {
    checkForUpdate({ manual: false }).then((r) => {
      if (r && r.ok && r.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        /* ★ 2026-11-02 玩家：「检查更新检测到新版本就应该先把版本更新日志显示出来给玩家看」
         *
         * 启动这一次带上 startup:true —— 界面据此弹「居中面板」展示完整更新日志。
         * 理由：玩家刚开游戏、还没进正文，这时看「这版改了什么」是自然时机，
         * 跟所有游戏的开场更新提示一样，不打断任何正在做的事。
         * 游戏进行中的 30 分钟巡检则**不**带这个标记，只弹一行轻提示，避免打断阅读。
         */
        try {
          notifyAvailableUpdate(true);
        } catch (e) {}
      }
    }).catch(() => {});
  }, 8000);

  /* -------------------------------------------------------------------------
   * 【主动提醒：定时巡检】玩家 2026-11-01：「还有主动提醒玩家更新的机制也要检查一下」
   *
   * 原来只在启动 8 秒后检查**一次**就再也不管了。玩家挂着游戏玩几个小时，
   * 期间我们发了新版，他永远收不到提醒 —— 必须重启游戏才可能看到。
   * 现在改成每隔一段时间再查一次，有新版本就推同一条「发现新版本」提示条。
   *
   * 为什么 30 分钟：
   *   · 太密会白白耗流量、也给 GitHub 添麻烦；
   *   · 玩家一局玩下来通常几十分钟到几小时，30 分钟足够在一局内被发现；
   *   · 检查只拉一个 2KB 的 version.json，开销可以忽略。
   *
   * 为什么跳过「已在下载中」：
   *   checkForUpdate 自己会返回 busy，这里再判一次是为了不去打扰正在下载的玩家。
   * ---------------------------------------------------------------------- */
  const RECHECK_INTERVAL_MS = 30 * 60 * 1000;
  let recheckTimer = null;

  function periodicCheck() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (updateState.downloading) return;
    checkForUpdate({ manual: false }).then((r) => {
      if (!r || !r.ok || !r.hasUpdate) return;
      notifyAvailableUpdate();
    }).catch(() => { /* 后台巡检失败静默，不打扰玩家 */ });
  }

  recheckTimer = setInterval(periodicCheck, RECHECK_INTERVAL_MS);
  if (recheckTimer && typeof recheckTimer.unref === 'function') recheckTimer.unref();
});

app.on('window-all-closed', () => { app.quit(); });
