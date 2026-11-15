/* ============================================================================
 * 把组装好的单文件成品放进 dist/index.html，供 Electron 加载。
 *
 * 为什么还要这一步：
 *   assemble.mjs 产出的是根目录的「凡人独立前端.html」（给浏览器直接双击用）。
 *   Electron 需要一个固定路径，所以复制一份到 dist/index.html。
 *   两边内容完全一致，只是入口不同。
 * ========================================================================== */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');          // 凡人独立前端/
const REPO = path.resolve(ROOT, '..');          // 原著补演/
const SRC = path.join(REPO, '凡人独立前端.html');
const DIST = path.join(ROOT, 'dist');

async function main() {
  await fs.mkdir(DIST, { recursive: true });
  const html = await fs.readFile(SRC, 'utf8');
  const out = path.join(DIST, 'index.html');
  await fs.writeFile(out, html, 'utf8');
  console.log('[dist] ' + (html.length / 1024 / 1024).toFixed(2) + ' MB → dist/index.html');
}

main().catch((e) => {
  console.error('[dist] 失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
