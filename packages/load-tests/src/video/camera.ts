import { randomInt } from "node:crypto";
import { MediaStreamTrack, RtpHeader, RtpPacket } from "werift";
import { FRAME_MS, FRAME_TICKS, type Clip } from "./clip.js";
import type { VideoStats } from "./stats.js";

/**
 * A bot's camera: the clip's packets at 24 fps on one track that every active link's sender
 * shares, as a phone's encoder feeds all its peer connections. Each sender writes its own SSRC,
 * sequence numbers and payload type. A keyframe request jumps to the clip's next IDR.
 */
export class Camera {
  readonly track = new MediaStreamTrack({ kind: "video" });
  private cursor: number;
  private timestamp = randomInt(2 ** 32);
  private sequence = randomInt(2 ** 16);
  private keyframeRequested = false;
  private nextFrameAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly clip: Clip,
    private readonly stats: VideoStats,
  ) {
    this.cursor = randomInt(clip.frames.length);
  }

  start(): void {
    if (this.timer) return;
    this.nextFrameAt = performance.now() + Math.random() * FRAME_MS;
    const tick = () => {
      const late = Math.floor((performance.now() - this.nextFrameAt) / FRAME_MS);
      if (late > 0) {
        this.stats.framesSkipped += late;
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

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.track.stop();
  }

  /** The next frame goes out as the clip's next keyframe. */
  requestKeyframe(): void {
    this.keyframeRequested = true;
  }

  private sendFrame(): void {
    if (this.keyframeRequested) {
      this.keyframeRequested = false;
      if (!this.clip.frames[this.cursor].key) {
        this.stats.keyframesForced++;
        this.cursor = this.clip.nextKeyIndex(this.cursor);
      }
    }
    const { payloads } = this.clip.frames[this.cursor];
    payloads.forEach((payload, index) => {
      const header = new RtpHeader({ sequenceNumber: this.sequence, timestamp: this.timestamp, marker: index === payloads.length - 1 });
      this.sequence = (this.sequence + 1) & 0xffff;
      this.track.writeRtp(new RtpPacket(header, payload));
    });
    this.stats.framesSent++;
    this.cursor = (this.cursor + 1) % this.clip.frames.length;
    this.timestamp = (this.timestamp + FRAME_TICKS) >>> 0;
  }
}
