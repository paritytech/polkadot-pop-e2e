import { readFileSync } from 'node:fs';

export const FRAME_MS = 1000 / 24;
export const FRAME_TICKS = 90000 / 24;
export const H264_FMTP = 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1';
const START_CODE = Buffer.from([0, 0, 0, 1]);
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_AUD = 9;

function splitAnnexB(data) {
  const starts = [];
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

/** RFC 6184 packetization-mode=1 payloads: single NAL unit packets, FU-A above `maxSize`. */
function packetizeH264(nals, maxSize = 1200) {
  const payloads = [];
  const chunkSize = maxSize - 2;
  for (const nal of nals) {
    if (nal.length <= maxSize) {
      payloads.push(nal);
      continue;
    }
    for (let offset = 1; offset < nal.length; offset += chunkSize) {
      const flags = (offset === 1 ? 0x80 : 0) | (offset + chunkSize >= nal.length ? 0x40 : 0);
      const header = Buffer.from([(nal[0] & 0xe0) | 28, flags | (nal[0] & 0x1f)]);
      payloads.push(Buffer.concat([header, nal.subarray(offset, offset + chunkSize)]));
    }
  }
  return payloads;
}

/** Loads an Annex-B clip encoded with `aud=1` as frames of 4-byte start-code NAL units, without AUD and SEI. */
export function loadClip(path) {
  const frames = [];
  let nals = [];
  const flush = () => {
    if (nals.length === 0) return;
    frames.push({
      payloads: packetizeH264(nals),
      annexb: Buffer.concat(nals.flatMap((nal) => [START_CODE, nal])),
      key: nals.some((nal) => (nal[0] & 0x1f) === NAL_IDR),
    });
    nals = [];
  };
  for (const nal of splitAnnexB(readFileSync(path))) {
    const type = nal[0] & 0x1f;
    if (type === NAL_AUD) flush();
    else if (type !== NAL_SEI) nals.push(nal);
  }
  flush();
  const keyIndexes = frames.flatMap((frame, index) => (frame.key ? [index] : []));
  const nextKeyIndex = (index) => keyIndexes.find((key) => key >= index) ?? keyIndexes[0];
  const bytes = frames.reduce((sum, frame) => sum + frame.annexb.length, 0);
  return { frames, nextKeyIndex, kbps: (bytes * 8 * 24) / frames.length / 1000 };
}

export function isRtcp(packet) {
  const type = packet[1];
  return type >= 192 && type <= 223;
}

export function containsPli(packet) {
  for (let offset = 0; offset + 4 <= packet.length; ) {
    const format = packet[offset] & 0x1f;
    if (packet[offset + 1] === 206 && format === 1) return true;
    offset += (packet.readUInt16BE(offset + 2) + 1) * 4;
  }
  return false;
}

export function rtpPayloadOffset(packet) {
  let offset = 12 + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  return offset;
}

function carriesIdr(payload) {
  const type = payload[0] & 0x1f;
  if (type === NAL_IDR) return true;
  if (type === 28) return (payload[1] & 0x1f) === NAL_IDR;
  if (type === 24) {
    for (let offset = 1; offset + 2 < payload.length; offset += 2 + payload.readUInt16BE(offset)) {
      if ((payload[offset + 2] & 0x1f) === NAL_IDR) return true;
    }
  }
  return false;
}

const SEEN_WINDOW = 1024;

/** Counts one received RTP stream: unique packets, frames, keyframes, loss from sequence gaps, RFC 3550 jitter. */
export class StreamStats {
  constructor(requestKeyframe) {
    this.requestKeyframe = requestKeyframe;
    this.seen = new Int32Array(SEEN_WINDOW).fill(-1);
    this.highestSequence = -1;
    this.lastPliAt = 0;
    this.keyframeSeen = false;
    this.firstPacketAt = 0;
    this.reset();
  }

  reset() {
    this.baseSequence = -1;
    this.packets = 0;
    this.duplicates = 0;
    this.bytes = 0;
    this.frames = 0;
    this.keyframes = 0;
    this.jitter = 0;
    this.previousTransit = undefined;
    this.frameHasIdr = false;
    this.lossAtCheck = [0, 0];
  }

  extendSequence(sequence) {
    if (this.highestSequence < 0) return sequence;
    const cycle = this.highestSequence & ~0xffff;
    let extended = cycle | sequence;
    const delta = extended - this.highestSequence;
    if (delta < -0x8000) extended += 0x10000;
    else if (delta > 0x8000) extended -= 0x10000;
    return extended;
  }

  record(sequence, timestamp, marker, payload, now) {
    if (this.firstPacketAt === 0) this.firstPacketAt = now;
    const extended = this.extendSequence(sequence);
    const slot = extended % SEEN_WINDOW;
    if (this.seen[slot] === extended) {
      this.duplicates++;
      return;
    }
    this.seen[slot] = extended;
    if (extended > this.highestSequence) this.highestSequence = extended;
    if (this.baseSequence < 0) this.baseSequence = extended;
    this.packets++;
    this.bytes += payload.length;

    const transit = now * 90 - timestamp;
    if (this.previousTransit !== undefined) {
      let difference = transit - this.previousTransit;
      // RTP timestamps wrap at 2^32; arrival time is a float, so fold the difference back.
      if (difference > 2 ** 31) difference -= 2 ** 32;
      else if (difference < -(2 ** 31)) difference += 2 ** 32;
      this.jitter += (Math.abs(difference) - this.jitter) / 16;
    }
    this.previousTransit = transit;

    if (carriesIdr(payload)) this.frameHasIdr = true;
    if (marker) {
      this.frames++;
      if (this.frameHasIdr) {
        this.keyframes++;
        this.keyframeSeen = true;
      }
      this.frameHasIdr = false;
    }
  }

  get lost() {
    if (this.baseSequence < 0) return 0;
    return Math.max(0, this.highestSequence - this.baseSequence + 1 - this.packets);
  }

  /** Sends a PLI when no keyframe arrived yet or when a loss persisted for two checks (time for NACK repair). */
  check(now) {
    if (this.firstPacketAt === 0 || now - this.lastPliAt < 1000) return false;
    const lost = this.lost;
    const persistentLoss = lost > this.lossAtCheck[0] && this.lossAtCheck[1] > this.lossAtCheck[0];
    this.lossAtCheck = [this.lossAtCheck[1], lost];
    const missingKeyframe = !this.keyframeSeen && now - this.firstPacketAt > 500;
    if (!persistentLoss && !missingKeyframe) return false;
    this.lastPliAt = now;
    this.requestKeyframe();
    return true;
  }
}

/** A player: one camera feeding its group links at 24 fps, and the streams it receives from its group. */
export class Bot {
  constructor(id, clip) {
    this.id = id;
    this.clip = clip;
    this.camera = undefined;
    this.streams = [];
    this.cursor = Math.floor(Math.random() * clip.frames.length);
    this.timestamp = Math.floor(Math.random() * 2 ** 32);
    this.keyframeRequested = false;
    this.framesSent = 0;
    this.framesSkipped = 0;
    this.pliReceived = 0;
    this.pliSent = 0;
    this.forcedKeyframes = 0;
  }

  addStream(requestKeyframe) {
    const stream = new StreamStats(() => {
      this.pliSent++;
      requestKeyframe();
    });
    this.streams.push(stream);
    return stream;
  }

  onPli() {
    this.pliReceived++;
    this.keyframeRequested = true;
  }

  start(performance) {
    this.nextFrameAt = performance.now() + Math.random() * FRAME_MS;
    const tick = () => {
      const late = Math.floor((performance.now() - this.nextFrameAt) / FRAME_MS);
      if (late > 0) {
        // A real encoder drops frames it could not produce in time.
        this.framesSkipped += late;
        this.cursor = (this.cursor + late) % this.clip.frames.length;
        this.timestamp = (this.timestamp + late * FRAME_TICKS) >>> 0;
        this.nextFrameAt += late * FRAME_MS;
      }
      this.sendFrame();
      this.nextFrameAt += FRAME_MS;
      this.timer = setTimeout(tick, Math.max(0, this.nextFrameAt - performance.now()));
    };
    this.timer = setTimeout(tick, Math.max(0, this.nextFrameAt - performance.now()));
  }

  stop() {
    clearTimeout(this.timer);
  }

  sendFrame() {
    if (this.keyframeRequested) {
      this.keyframeRequested = false;
      if (!this.clip.frames[this.cursor].key) this.forcedKeyframes++;
      this.cursor = this.clip.nextKeyIndex(this.cursor);
    }
    this.camera.send(this.clip.frames[this.cursor], this.timestamp);
    this.framesSent++;
    this.cursor = (this.cursor + 1) % this.clip.frames.length;
    this.timestamp = (this.timestamp + FRAME_TICKS) >>> 0;
  }

  resetCounters() {
    this.framesSent = 0;
    this.framesSkipped = 0;
    this.pliReceived = 0;
    this.pliSent = 0;
    this.forcedKeyframes = 0;
    for (const stream of this.streams) stream.reset();
  }
}

/**
 * Bot i links to i±1..±5 (10 co-players). Groups are blocks of 6 consecutive bots, so every
 * group mate is one of those links: 5 links carry video both ways, the other 5 stay on standby.
 */
export function buildLinks(botCount) {
  if (botCount < 12 || botCount % 6 !== 0) throw new Error(`bot count must be a multiple of 6 and at least 12, got ${botCount}`);
  const links = [];
  for (let first = 0; first < botCount; first++) {
    for (let distance = 1; distance <= 5; distance++) {
      const second = (first + distance) % botCount;
      links.push({ first, second, group: Math.floor(first / 6) === Math.floor(second / 6) });
    }
  }
  return links;
}
