// Story illustrations only. Portrait fields and unrelated image URLs are not migrated.
// Immutable blob keys are shared by history, snapshots and branches; never auto-delete.
export const STORY_IMAGE_PREFIX = 'fr-story-image:sha256:';
export function isStoryImageRef(value) {
  return typeof value === 'string' && /^fr-story-image:sha256:[a-f0-9]{64}$/.test(value);
}
export function storyImageRefs(text) {
  return typeof text === 'string' ? [...new Set(text.match(/fr-story-image:sha256:[a-f0-9]{64}/g) || [])] : [];
}
export function decodeStoryImageDataUrl(source) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source || '');
  if (!match) throw new Error('正文图片不是可复制的内联图片');
  const encoded = match[2].replace(/\s/g, '');
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('正文图片编码无效');
  const binary = atob(encoded);
  if (!binary.length) throw new Error('正文图片内容为空');
  return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1].toLowerCase() });
}
export async function storyImageBlobRef(blob, cryptoApi = globalThis.crypto) {
  if (!blob || !/^image\//i.test(blob.type) || !blob.size) throw new Error('正文图片内容无效');
  // MIME participates in identity, so two decoders cannot interpret the same key differently.
  const bytes = await new Blob([blob.type.toLowerCase(), '\n', blob]).arrayBuffer();
  const hash = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes));
  return STORY_IMAGE_PREFIX + Array.from(hash, n => n.toString(16).padStart(2, '0')).join('');
}
export async function verifyStoryImageBlob(ref, blob, cryptoApi = globalThis.crypto) {
  if (!isStoryImageRef(ref) || await storyImageBlobRef(blob, cryptoApi) !== ref) throw new Error('正文图片校验失败，原始记录已保留');
  return blob;
}
export async function storyImageBlobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}
async function storyMapHtmlImages(text, replace) {
  const figures = [...text.matchAll(/<figure\b[^>]*\bdata-ce-generated-image(?:\s|=|>)[\s\S]*?<\/figure\s*>/gi)];
  let result = text;
  for (let i = figures.length - 1; i >= 0; i--) {
    const figure = figures[i];
    const sources = [...figure[0].matchAll(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([\s\S]*?)\2/gi)];
    let next = figure[0];
    for (let j = sources.length - 1; j >= 0; j--) {
      const source = sources[j], value = await replace(source[3]);
      if (value !== source[3]) next = next.slice(0, source.index) + source[1] + source[2] + value + source[2] + next.slice(source.index + source[0].length);
    }
    if (next !== figure[0]) result = result.slice(0, figure.index) + next + result.slice(figure.index + figure[0].length);
  }
  return result;
}
// Copy-on-write traversal. JSON-stringified snapshots are transformed without touching
// avatar blobs, and only changed string leaves are eligible for later compare-and-swap.
export async function mapStoryImageDocument(root, mapString) {
  const changes = [];
  async function visit(value, path, recordChanges) {
    if (typeof value === 'string') {
      let next = value;
      if (value.includes('data-ce-generated-image') || value.includes(STORY_IMAGE_PREFIX)) {
        const trimmed = value.trimStart();
        if (trimmed[0] === '{' || trimmed[0] === '[') {
          let parsed;
          try { parsed = JSON.parse(value); } catch (_) {}
          if (parsed && typeof parsed === 'object') {
            const mapped = await visit(parsed, [], false);
            if (mapped !== parsed) next = JSON.stringify(mapped);
          } else next = await mapString(value);
        } else next = await mapString(value);
      }
      if (next !== value && recordChanges) changes.push({path, before:value, after:next});
      return next;
    }
    if (!value || typeof value !== 'object' || value instanceof Blob || value instanceof Date) return value;
    let next = value;
    for (const key of Object.keys(value)) {
      const mapped = await visit(value[key], [...path,key], recordChanges);
      if (mapped !== value[key]) {
        if (next === value) next = Array.isArray(value) ? value.slice() : {...value};
        Object.defineProperty(next, key, {value:mapped,writable:true,enumerable:true,configurable:true});
      }
    }
    return next;
  }
  const value = await visit(root, [], true);
  return {value, changes};
}
export async function migrateStoryImageDocument(root, putVerified) {
  let copied = 0, failed = 0;
  const sources = new Map();
  const result = await mapStoryImageDocument(root, text => storyMapHtmlImages(text, async src => {
    if (!/^data:image\//i.test(src)) return src;
    if (sources.has(src)) return sources.get(src);
    try {
      const ref = await putVerified(src);
      if (!isStoryImageRef(ref)) throw new Error('未返回已校验的本地图片引用');
      sources.set(src, ref); copied++; return ref;
    } catch (_) { failed++; sources.set(src,src); return src; }
  }));
  return {...result, copied, failed};
}
export function applyStoryImageChanges(target, changes) {
  let applied = 0, skipped = 0;
  for (const change of changes) {
    let parent = target;
    for (const key of change.path.slice(0,-1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent,key)) { parent = null; break; }
      parent = parent[key];
    }
    const key = change.path.at(-1);
    if (parent && typeof parent === 'object' && Object.hasOwn(parent,key) && parent[key] === change.before) { parent[key] = change.after; applied++; }
    else skipped++;
  }
  return {applied,skipped};
}
export async function planStoryImageMaterialization(root, getVerifiedDataUrl) {
  // Fail closed: a portable export with missing binaries would be a false backup.
  const cache = new Map();
  return mapStoryImageDocument(root, async text => {
    for (const ref of storyImageRefs(text)) {
      if (!cache.has(ref)) {
        const source = await getVerifiedDataUrl(ref);
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(source || '')) throw new Error('正文图片缺失，未生成不完整备份');
        cache.set(ref, source);
      }
      text = text.split(ref).join(cache.get(ref));
    }
    return text;
  });
}
export async function materializeStoryImageDocument(root, getVerifiedDataUrl) {
  return (await planStoryImageMaterialization(root, getVerifiedDataUrl)).value;
}
export function storyImageDisplayHtml(html) {
  return String(html || '').replace(/\bsrc\s*=\s*(["'])(fr-story-image:sha256:[a-f0-9]{64})\1/gi,
    (_,quote,ref) => 'data-fr-story-asset=' + quote + ref + quote);
}
export function stripStoryImageText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<figure\b[^>]*data-ce-generated-image[^>]*>[\s\S]*?<\/figure\s*>/gi,'')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi,'')
    .replace(/fr-story-image:sha256:[a-f0-9]{64}/gi,'');
}
export function sanitizeStoryImageMessages(input) {
  if (typeof input === 'string') return stripStoryImageText(input);
  if (!Array.isArray(input)) return input;
  return input.map(message => {
    if (typeof message === 'string') return stripStoryImageText(message);
    if (!message || typeof message !== 'object') return message;
    if (typeof message.content === 'string') return {...message,content:stripStoryImageText(message.content)};
    // Explicit image_url parts are intentionally preserved for user-enabled image references.
    if (Array.isArray(message.content)) return {...message,content:message.content.map(part =>
      part?.type === 'text' ? {...part,text:stripStoryImageText(part.text)} : part)};
    return message;
  });
}
