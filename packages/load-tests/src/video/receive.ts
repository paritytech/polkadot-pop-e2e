import { carriesIdr, FRAMES_PER_SECOND } from "./clip.js";
import type { VideoStats } from "./stats.js";

const SEEN_WINDOW = 1024;
const PLI_INTERVAL_MS = 1_000;
/** No keyframe this long after the first packet means the sender started mid-GOP: request one. */
const KEYFRAME_WAIT_MS = 500;

/**
 * One co-player's video as a bot receives it, counted without decoding: packets, frames
 * (marker bits), keyframes, loss from sequence gaps. It requests a keyframe (PLI) as a decoder
 * does: when none has arrived since the camera came on, or when a loss persists past NACK repair.
 */
export class ReceiveStream {
  private readonly seen = new Int32Array(SEEN_WINDOW).fill(-1);
  private highestSequence = -1;
  private baseSequence = -1;
  private packets = 0;
  private frameHasIdr = false;
  private keyframeSeen = false;
  private firstPacketAt = 0;
  private lastPliAt = 0;
  private lossAtCheck: [number, number] = [0, 0];
  /** Camera on, from the room's opening or the end of standby. */
  private activatedAt: number | undefined;
  /** When frames became due: camera on and the video negotiated. */
  private dueSince: number | undefined;
  private negotiated = false;

  constructor(
    private readonly stats: VideoStats,
    private readonly window: { start: number; end: number },
    private readonly requestKeyframe: () => void,
  ) {}

  /** The co-player's camera comes on for this bot at `now`; frames are due once the video is negotiated. */
  activate(now: number): void {
    if (this.activatedAt !== undefined) return;
    this.stats.streams++;
    this.activatedAt = now;
    this.keyframeSeen = false;
    this.firstPacketAt = 0;
    if (this.negotiated) this.dueSince = now;
  }

  /** The video lane's answer is applied: from now on frames are due while the camera is on. */
  markNegotiated(now: number): void {
    this.negotiated = true;
    if (this.activatedAt !== undefined) this.dueSince ??= now;
  }

  /** The camera goes off (standby, or the link closes): the frames due so far are counted. */
  deactivate(now: number): void {
    if (this.dueSince !== undefined) {
      const dueMs = Math.max(0, Math.min(now, this.window.end) - Math.max(this.dueSince, this.window.start));
      this.stats.activeMs += dueMs;
      this.stats.framesExpected += Math.round((dueMs * FRAMES_PER_SECOND) / 1000);
    }
    this.activatedAt = undefined;
    this.dueSince = undefined;
  }

  private extendSequence(sequence: number): number {
    if (this.highestSequence < 0) return sequence;
    let extended = (this.highestSequence & ~0xffff) | sequence;
    const delta = extended - this.highestSequence;
    if (delta < -0x8000) extended += 0x10000;
    else if (delta > 0x8000) extended -= 0x10000;
    return extended;
  }

  record(sequence: number, marker: boolean, payload: Buffer, now: number): void {
    if (this.firstPacketAt === 0) this.firstPacketAt = now;
    const extended = this.extendSequence(sequence);
    const slot = extended % SEEN_WINDOW;
    if (this.seen[slot] === extended) return;
    this.seen[slot] = extended;
    if (extended > this.highestSequence) this.highestSequence = extended;
    if (this.baseSequence < 0) this.baseSequence = extended;
    this.packets++;
    const inWindow = now >= this.window.start && now < this.window.end;
    if (inWindow) {
      this.stats.packetsReceived++;
      this.stats.bytesReceived += payload.length;
    }
    if (carriesIdr(payload)) this.frameHasIdr = true;
    if (!marker) return;
    if (this.frameHasIdr && !this.keyframeSeen) {
      this.keyframeSeen = true;
      if (this.activatedAt !== undefined) {
        this.stats.streamsWithFrames++;
        this.stats.firstFrameMs.add(now - this.activatedAt);
      }
    }
    if (inWindow) {
      this.stats.framesReceived++;
      if (this.frameHasIdr) this.stats.keyframesReceived++;
    }
    this.frameHasIdr = false;
  }

  private get lost(): number {
    return this.baseSequence < 0 ? 0 : Math.max(0, this.highestSequence - this.baseSequence + 1 - this.packets);
  }

  /** Sends a PLI when no keyframe arrived since the camera came on, or a loss persisted over two checks. */
  check(now: number): void {
    if (this.firstPacketAt === 0 || now - this.lastPliAt < PLI_INTERVAL_MS) return;
    const lost = this.lost;
    const persistentLoss = lost > this.lossAtCheck[0] && this.lossAtCheck[1] > this.lossAtCheck[0];
    this.lossAtCheck = [this.lossAtCheck[1], lost];
    const missingKeyframe = !this.keyframeSeen && now - this.firstPacketAt > KEYFRAME_WAIT_MS;
    if (!persistentLoss && !missingKeyframe) return;
    this.lastPliAt = now;
    this.stats.pliSent++;
    this.requestKeyframe();
  }

  /** The stream's loss, counted once when its link closes. */
  finish(now: number): void {
    this.deactivate(now);
    this.stats.streamPackets += this.packets;
    this.stats.packetsLost += this.lost;
  }
}
