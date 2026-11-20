// Stable JSON and bounded UTF-8 hashing for stored replay and timeline signatures.
function* canonicalJsonParts(value) {
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      if (index) yield ',';
      const child = value[index];
      yield* canonicalJsonParts(child === undefined ? null : child);
    }
    yield ']';
  } else if (value && typeof value === 'object') {
    // Match the legacy sorted copy, including JSON's numeric key ordering and
    // treating Dates or Maps by their enumerable fields.
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== '__proto__') sorted[key] = value[key];
    }
    let first = true;
    yield '{';
    for (const key of Object.keys(sorted)) {
      const child = sorted[key];
      if (child === undefined) continue;
      if (!first) yield ',';
      first = false;
      yield* canonicalJsonParts(key);
      yield ':';
      yield* canonicalJsonParts(child);
    }
    yield '}';
  } else if (typeof value === 'string' && value.length > 8192) {
    yield '"';
    let start = 0;
    while (start < value.length) {
      let end = Math.min(start + 8192, value.length);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else {
    yield JSON.stringify(value);
  }
}

// SHA-256 over the original UTF-8 byte sequence. SubtleCrypto only accepts one
// contiguous buffer, which forced the renderer to materialize the entire save.
const sha256Rounds = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function hashCanonicalJson(value) {
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const tail = new Uint8Array(128);
  const tailView = new DataView(tail.buffer);
  const encoder = new TextEncoder();
  const rotate = (number, bits) => (number >>> bits) | (number << (32 - bits));
  let used = 0, length = 0;

  function block(view, offset) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15], y = words[index - 2];
      const low = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const high = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = words[index - 16] + low + words[index - 7] + high;
    }
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let index = 0; index < words.length; index++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const first = (h + sum1 + choice + sha256Rounds[index] + words[index]) | 0;
      h = g; g = f; f = e; e = (d + first) | 0;
      d = c; c = b; b = a; a = (first + sum0 + majority) | 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }

  function update(text) {
    const bytes = encoder.encode(text);
    length += bytes.length;
    let offset = 0;
    if (used) {
      offset = Math.min(bytes.length, 64 - used);
      tail.set(bytes.subarray(0, offset), used);
      used += offset;
      if (used < 64) return;
      block(tailView, 0);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (; offset + 64 <= bytes.length; offset += 64) block(view, offset);
    tail.set(bytes.subarray(offset), 0);
    used = bytes.length - offset;
  }

  let text = '';
  for (const part of canonicalJsonParts(value)) {
    text += part;
    if (text.length >= 16384) {
      update(text);
      text = '';
    }
  }
  if (text) update(text);
  tail.fill(0, used);
  tail[used] = 0x80;
  const padded = used < 56 ? 64 : 128;
  tailView.setUint32(padded - 8, Math.floor(length / 0x20000000));
  tailView.setUint32(padded - 4, length * 8);
  for (let offset = 0; offset < padded; offset += 64) block(tailView, offset);
  return Array.from(state, word => word.toString(16).padStart(8, '0')).join('');
}
