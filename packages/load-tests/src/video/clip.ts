import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** H.264 Constrained Baseline 3.1, one NAL unit or FU-A per packet: what the app prefers from a phone. */
export const H264_FMTP = "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1";
export const FRAMES_PER_SECOND = 24;
export const FRAME_MS = 1000 / FRAMES_PER_SECOND;
export const FRAME_TICKS = 90_000 / FRAMES_PER_SECOND;
const MAX_PAYLOAD_BYTES = 1_200;

const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_AUD = 9;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;

/** 360×360 at 24 fps, about 290 kbps, an IDR every 2 s: `pnpm clip` writes it again. */
export const DEFAULT_CLIP = resolve(import.meta.dirname, "../../media/clip.h264");

export interface ClipFrame {
  /** RTP payloads, the last of which carries the marker bit. */
  payloads: Buffer[];
  key: boolean;
}

export interface Clip {
  frames: ClipFrame[];
  /** The first keyframe at or after `index`, wrapping to the clip's start. */
  nextKeyIndex(index: number): number;
}

function splitAnnexB(data: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let index = 0; index + 2 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
      starts.push(index + 3);
      index += 2;
    }
  }
  return starts.map((start, position) => {
    let end = position + 1 < starts.length ? starts[position + 1] - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    return data.subarray(start, end);
  });
}

/** RFC 6184 packetization-mode=1 payloads: single NAL unit packets, FU-A above `MAX_PAYLOAD_BYTES`. */
function packetize(nals: Buffer[]): Buffer[] {
  const chunkBytes = MAX_PAYLOAD_BYTES - 2;
  return nals.flatMap((nal) => {
    if (nal.length <= MAX_PAYLOAD_BYTES) return [nal];
    const payloads: Buffer[] = [];
    for (let offset = 1; offset < nal.length; offset += chunkBytes) {
      const flags = (offset === 1 ? 0x80 : 0) | (offset + chunkBytes >= nal.length ? 0x40 : 0);
      payloads.push(Buffer.concat([Buffer.from([(nal[0] & 0xe0) | NAL_FU_A, flags | (nal[0] & 0x1f)]), nal.subarray(offset, offset + chunkBytes)]));
    }
    return payloads;
  });
}

/** An Annex-B clip encoded with access unit delimiters, as frames of RTP payloads without AUD and SEI. */
export function loadClip(path = DEFAULT_CLIP): Clip {
  const frames: ClipFrame[] = [];
  let nals: Buffer[] = [];
  const flush = () => {
    if (nals.length === 0) return;
    frames.push({ payloads: packetize(nals), key: nals.some((nal) => (nal[0] & 0x1f) === NAL_IDR) });
    nals = [];
  };
  for (const nal of splitAnnexB(readFileSync(path))) {
    const type = nal[0] & 0x1f;
    if (type === NAL_AUD) flush();
    else if (type !== NAL_SEI) nals.push(nal);
  }
  flush();
  const keyIndexes = frames.flatMap((frame, index) => (frame.key ? [index] : []));
  if (keyIndexes.length === 0) throw new Error(`${path} has no IDR frame`);
  return { frames, nextKeyIndex: (index) => keyIndexes.find((key) => key >= index) ?? keyIndexes[0] };
}

/** Whether an H.264 RTP payload carries (the start of) an IDR slice. */
export function carriesIdr(payload: Buffer): boolean {
  const type = payload[0] & 0x1f;
  if (type === NAL_IDR) return true;
  if (type === NAL_FU_A) return (payload[1] & 0x1f) === NAL_IDR;
  if (type === NAL_STAP_A) {
    for (let offset = 1; offset + 2 < payload.length; offset += 2 + payload.readUInt16BE(offset)) {
      if ((payload[offset + 2] & 0x1f) === NAL_IDR) return true;
    }
  }
  return false;
}
