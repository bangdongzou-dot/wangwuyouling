// Independent database: no upgrade of CultivationDB, no automatic deletion.
// A reference is committed only after the Blob has been read back and SHA-256 verified.
var frStoryAssetDb = null;
var frStoryAssetNodes = new Map();
var frStoryAssetObserver = null;
var frStoryAssetCleanup = null;
// Geometry only, never Blob/data URLs. Re-rendered history reuses stable placeholders.
var frStoryAssetDimensions = new Map();
function frStoryAssetsCore() { return typeof CE_CORE !== 'undefined' ? CE_CORE['story-image-assets'] : null; }
function frStoryAssetsDatabase() {
  if (!frStoryAssetDb) {
    frStoryAssetDb = new Dexie('CultivationStoryImages');
    frStoryAssetDb.version(1).stores({assets:'&id'});
  }
  return frStoryAssetDb;
}
async function frStoryImageReadBlob(ref) {
  const core = frStoryAssetsCore();
  if (!core?.isStoryImageRef(ref)) throw new Error('正文图片引用无效');
  const row = await frStoryAssetsDatabase().assets.get(ref);
  if (!row?.blob) throw new Error('本地正文图片缺失，请导入包含图片的完整备份');
  return core.verifyStoryImageBlob(ref, row.blob);
}
async function frStoryImageReadDataUrl(ref) {
  return frStoryAssetsCore().storyImageBlobDataUrl(await frStoryImageReadBlob(ref));
}
async function frStoryImagePut(source) {
  const core = frStoryAssetsCore();
  const blob = core.decodeStoryImageDataUrl(source);
  const id = await core.storyImageBlobRef(blob);
  const assets = frStoryAssetsDatabase().assets;
  const existing = await assets.get(id);
  if (existing?.blob) {
    try { await core.verifyStoryImageBlob(id,existing.blob); return id; } catch (_) {}
  }
  await assets.put({id,blob,bytes:blob.size,mime:blob.type,createdAt:new Date().toISOString()});
  await frStoryImageReadBlob(id);
  return id;
}
async function frStoryImageLocalizeResults(results, signal) {
  const localized = [];
  let failures = 0;
  for (const item of results || []) {
    signal?.throwIfAborted();
    let imageUrl = item.imageUrl;
    try {
      if (/^data:image\//i.test(imageUrl)) imageUrl = await frStoryImagePut(imageUrl);
      else if (/^(https?:|blob:)/i.test(imageUrl)) {
        // Only newly generated provider results, never background-fetch legacy remote URLs.
        const response = await fetch(imageUrl,{signal,credentials:'omit'});
        if (!response.ok) throw new Error('图片下载失败');
        const blob = await response.blob();
        imageUrl = await frStoryImagePut(await frStoryAssetsCore().storyImageBlobDataUrl(blob));
      }
    } catch (error) {
      signal?.throwIfAborted();
      failures++;
      console.warn('[正文图片] 本地复制失败，保留原始图片地址。');
    }
    localized.push({...item,imageUrl});
  }
  signal?.throwIfAborted();
  if (failures && typeof showDanmaku === 'function') showDanmaku('部分插图尚未本地化，已保留原图；这些图片暂不能保证离线显示。','warning');
  return localized;
}
async function frMigrateStoryArchive(archiveName, archiveData) {
  const core = frStoryAssetsCore();
  if (!core || !archiveData) return archiveData;
  const plan = await core.migrateStoryImageDocument(archiveData,frStoryImagePut);
  if (!plan.changes.length) return archiveData;
  let committed = false;
  await db.archives.where('name').equals(archiveName).modify(archive => {
    if (!archive?.data) return false;
    const result = core.applyStoryImageChanges(archive.data,plan.changes);
    committed = result.applied === plan.changes.length;
    if (!result.applied) return false;
  });
  if (plan.failed) console.warn('[正文图片] 有图片未迁移，原始内联图片已保留。');
  // On a concurrent change, callers keep their unchanged read rather than adopt stale edits.
  return committed ? plan.value : archiveData;
}
async function frStoryPortableDocument(value) {
  const core = frStoryAssetsCore();
  return core ? core.materializeStoryImageDocument(value,frStoryImageReadDataUrl) : value;
}
async function frStoryImportDocument(value) {
  const core = frStoryAssetsCore();
  if (!core) return value;
  // References from an incomplete/nonportable external file must not create a broken archive.
  const verified = new Set();
  await core.mapStoryImageDocument(value,async text => {
    for (const ref of core.storyImageRefs(text)) if (!verified.has(ref)) { await frStoryImageReadBlob(ref); verified.add(ref); }
    return text;
  });
  const result = await core.migrateStoryImageDocument(value,frStoryImagePut);
  return result.value; // Copy/quota failure intentionally keeps each original inline image.
}
// Explicit rollback preparation. Also useful for restoring a single archive to old-format HTML.
// No binaries are deleted, so other branches/history/undo remain valid.
function frStoryRollbackGuard() {
  if ((typeof isMainApiGenerating !== 'undefined' && isMainApiGenerating) ||
      (typeof frGenerationTasks !== 'undefined' && frGenerationTasks.size) ||
      (typeof frReplayBusy !== 'undefined' && frReplayBusy)) {
    throw new Error('请先停止生成/重跑，再还原旧版兼容图片');
  }
}
async function frRestoreInlineStoryImages(archiveName) {
  frStoryRollbackGuard();
  const archive = await db.archives.get(archiveName);
  if (!archive?.data) throw new Error('找不到待回滚的存档');
  const core = frStoryAssetsCore();
  const plan = await core.planStoryImageMaterialization(archive.data,frStoryImageReadDataUrl);
  frStoryRollbackGuard();
  let result = {applied:0,skipped:0};
  if (plan.changes.length) await db.archives.where('name').equals(archiveName).modify(current => {
    result = core.applyStoryImageChanges(current.data,plan.changes);
    if (!result.applied) return false;
  });
  if (result.skipped) throw new Error('存档已变化，未覆盖新内容；请在停止生成后重试回滚');
  return result;
}
function frStoryImagePrompt(input) {
  return frStoryAssetsCore()?.sanitizeStoryImageMessages(input) ?? input;
}
function frStoryImagePrepareHtml(html) {
  return frStoryAssetsCore()?.storyImageDisplayHtml(html) ?? html;
}
function frStoryAssetRememberDimensions(node, ref) {
  const width = node.naturalWidth || frStoryAssetDimensions.get(ref)?.width;
  const height = node.naturalHeight || frStoryAssetDimensions.get(ref)?.height;
  if (!(width > 0 && height > 0)) return;
  frStoryAssetDimensions.set(ref,{width,height});
  // aspect-ratio alone has no definite width after src is removed. HTML dimensions
  // retain the intrinsic footprint while max-width:100% / height:auto stay responsive.
  if (!node.hasAttribute('width')) node.setAttribute('width',String(width));
  if (!node.hasAttribute('height')) node.setAttribute('height',String(height));
  node.style.aspectRatio = width + ' / ' + height;
}
function frStoryAssetSetPlaceholder(node, ref) {
  const size = frStoryAssetDimensions.get(ref);
  if (!size) return false;
  // Valid transparent image, not a broken img: preserves responsive replaced layout.
  node.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + size.width + '" height="' + size.height + '"></svg>');
  return true;
}
function frStoryAssetRelease(node, remove = true) {
  const state = frStoryAssetNodes.get(node);
  if (!state) return;
  if (!remove) frStoryAssetRememberDimensions(node,state.ref);
  state.generation++;
  node.onload = null;
  if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
  // A src-less img becomes a broken inline element in Chromium and collapses,
  // even with width/height + aspect-ratio. Keep geometry, not the full image.
  if (remove || !frStoryAssetSetPlaceholder(node,state.ref)) node.removeAttribute('src');
  if (remove) { frStoryAssetObserver?.unobserve(node); frStoryAssetNodes.delete(node); }
}
async function frStoryAssetLoad(node) {
  const state = frStoryAssetNodes.get(node);
  if (!state || state.loading || state.url) return;
  const generation = ++state.generation;
  state.loading = true;
  try {
    const blob = await frStoryImageReadBlob(state.ref);
    if (frStoryAssetNodes.get(node) !== state || !node.isConnected || state.generation !== generation) return;
    state.url = URL.createObjectURL(blob);
    node.onload = () => {
      if (frStoryAssetNodes.get(node) === state && state.generation === generation) frStoryAssetRememberDimensions(node,state.ref);
    };
    node.src = state.url;
    node.removeAttribute('data-fr-story-error');
  } catch (_) {
    if (frStoryAssetNodes.get(node) === state && state.generation === generation) {
      node.alt = '本地插图暂不可用，请导入含图片的完整备份';
      node.setAttribute('data-fr-story-error','true');
    }
  } finally {
    state.loading = false;
    if (frStoryAssetNodes.get(node) === state && state.visible && !state.url && state.generation !== generation) void frStoryAssetLoad(node);
  }
}
function frStoryImageHydrate(element) {
  if (!element || !frStoryAssetsCore()) return;
  if (!frStoryAssetCleanup) {
    frStoryAssetCleanup = new MutationObserver(() => {
      for (const [node,state] of frStoryAssetNodes) if (!node.isConnected || node.getAttribute('data-fr-story-asset') !== state.ref) frStoryAssetRelease(node);
    });
    frStoryAssetCleanup.observe(document.documentElement,{childList:true,subtree:true});
    window.addEventListener('pagehide',() => {
      for (const node of frStoryAssetNodes.keys()) frStoryAssetRelease(node);
    });
  }
  if (!frStoryAssetObserver && typeof IntersectionObserver === 'function') {
    frStoryAssetObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = frStoryAssetNodes.get(entry.target);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (entry.isIntersecting) void frStoryAssetLoad(entry.target);
        else frStoryAssetRelease(entry.target,false);
      }
    });
  }
  for (const node of element.querySelectorAll('img[data-fr-story-asset]')) {
    const ref = node.getAttribute('data-fr-story-asset');
    if (!frStoryAssetsCore().isStoryImageRef(ref) || frStoryAssetNodes.has(node)) continue;
    frStoryAssetRememberDimensions(node,ref);
    frStoryAssetSetPlaceholder(node,ref);
    node.loading = 'lazy';
    frStoryAssetNodes.set(node,{ref,url:null,generation:0,loading:false,visible:false});
    if (frStoryAssetObserver) frStoryAssetObserver.observe(node);
    else { frStoryAssetNodes.get(node).visible = true; void frStoryAssetLoad(node); }
  }
}
