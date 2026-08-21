// Read the RuntimeVersion a runtime blob declares, without executing it.
//
// Substrate release artifacts are `sp-maybe-compressed-blob`: an 8-byte magic
// then a zstd stream. The decompressed wasm carries a custom section named
// `runtime_version` whose payload is the SCALE-encoded RuntimeVersion prefix —
// spec_name, impl_name (compact-length strings), then authoring_version,
// spec_version, impl_version (u32 LE). That is all the baseline scan needs to
// compare a pinned asset against what a live chain reports.

import { decompress } from 'fzstd';

const ZSTD_MAGIC = Buffer.from([0x52, 0xbc, 0x53, 0x76, 0x46, 0xdb, 0x8e, 0x05]); // sp-maybe-compressed-blob

export function decompressRuntime(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(ZSTD_MAGIC)) {
    return Buffer.from(decompress(buf.subarray(8)));
  }
  return buf;
}

function leb128(buf, at) {
  let result = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
}

/** Find a wasm custom section by name; returns its payload or null. */
function customSection(wasm, name) {
  if (wasm.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm blob (bad magic)');
  let pos = 8; // magic + version
  while (pos < wasm.length) {
    const id = wasm[pos++];
    let size;
    [size, pos] = leb128(wasm, pos);
    const end = pos + size;
    if (id === 0) {
      let nameLen, nameStart;
      [nameLen, nameStart] = leb128(wasm, pos);
      const sectionName = wasm.subarray(nameStart, nameStart + nameLen).toString('utf8');
      if (sectionName === name) return wasm.subarray(nameStart + nameLen, end);
    }
    pos = end;
  }
  return null;
}

function scaleCompactLen(buf, at) {
  const b = buf[at];
  if ((b & 0b11) === 0b00) return [b >> 2, at + 1];
  if ((b & 0b11) === 0b01) return [(b | (buf[at + 1] << 8)) >> 2, at + 2];
  if ((b & 0b11) === 0b10) return [buf.readUInt32LE(at) >>> 2, at + 4];
  throw new Error('unexpectedly long SCALE compact for a spec-name string');
}

/**
 * The spec a runtime artifact declares: { specName, specVersion }.
 * Accepts compressed or raw blobs.
 */
export function runtimeSpecOf(blob) {
  const wasm = decompressRuntime(blob);
  const payload = customSection(wasm, 'runtime_version');
  if (!payload) throw new Error('blob has no runtime_version custom section');
  let at = 0;
  let len;
  [len, at] = scaleCompactLen(payload, at);
  const specName = payload.subarray(at, at + len).toString('utf8');
  at += len;
  [len, at] = scaleCompactLen(payload, at); // impl_name — skip
  at += len;
  at += 4; // authoring_version
  const specVersion = payload.readUInt32LE(at);
  return { specName, specVersion };
}
