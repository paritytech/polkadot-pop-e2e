import type { Player } from "./keys.js";
import { bundleBytes, firstSendAt, isConnecting, nextSendAt, type Phase, type SignallingProfile } from "./profile.js";
import { RpcConnection, RpcError } from "./rpc.js";
import { probePayload, readProbe, signStatement, topicOf, type Hex } from "./statement.js";
import { seatOf, wireBytes, type Seat, type Seating } from "./seating.js";
import { bump, countDeliveryGap, type SignallingStats } from "./stats.js";

export interface GhostRoom {
  profile: SignallingProfile;
  phase: Phase;
  /** Prefix of every topic and channel of this step, so steps and runs never share one. */
  namespace: string;
  seating: Seating;
  gameStart: number;
  window: { start: number; end: number };
  stats: SignallingStats;
}

const SUBSCRIBE = "statement_subscribeStatement";
const UNSUBSCRIBE = "statement_unsubscribeStatement";

/**
 * A player that only signals: it listens where the app's version of `seating` listens, and
 * submits a bundle of the profile's size on its own channel at the profile's period.
 */
export class Ghost {
  private readonly channel: Hex;
  private readonly seat: Seat;
  private readonly received = new Set<string>();
  private subscription: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private nextAt = 0;
  private sequence = 0;
  private inflight = 0;
  private stopped = false;
  /** When the subscription last delivered a statement of the window; 0 before the first. */
  private lastDeliveryAt = 0;

  constructor(
    private readonly player: Player,
    private readonly connection: RpcConnection,
    private readonly game: GhostRoom,
  ) {
    this.channel = topicOf(`${game.namespace}/bundle/${player.index}`);
    this.seat = seatOf(game.namespace, game.seating, game.profile, player.index);
  }

  async join(): Promise<void> {
    const { stats, profile } = this.game;
    try {
      this.subscription = await this.connection.subscribe(SUBSCRIBE, [{ matchAny: this.seat.listen }], profile.submitTimeoutMs, {
        onNotification: (result) => this.receive(result),
        onEnd: (reason) => bump(stats.subscriptionsEnded, reason),
      });
      stats.subscribed++;
    } catch (error) {
      bump(stats.subscribeFailures, (error as Error).message);
      return;
    }
    this.nextAt = firstSendAt(profile, this.game.phase, this.game.gameStart, Date.now());
    this.schedule();
  }

  /** Stops sending; the subscription stays until `leave`, so late deliveries still count. */
  stopSending(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async leave(): Promise<void> {
    this.stopSending();
    if (!this.subscription) return;
    countDeliveryGap(this.game.stats, this.lastDeliveryAt, this.game.window.end);
    await this.connection.unsubscribe(UNSUBSCRIBE, this.subscription, this.game.profile.submitTimeoutMs).catch(() => {});
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const { profile, phase, gameStart } = this.game;
      const at = this.nextAt;
      const connecting = isConnecting(profile, at - gameStart);
      void this.send(connecting);
      this.nextAt = nextSendAt(profile, phase, gameStart, at, connecting);
      this.schedule();
    }, Math.max(0, this.nextAt - Date.now()));
  }

  private async send(connecting: boolean): Promise<void> {
    const { stats, profile, window } = this.game;
    if (this.inflight >= profile.maxInflight) {
      stats.skippedInflight++;
      return;
    }
    this.inflight++;
    const sentAt = Date.now();
    const sequence = this.sequence++;
    try {
      const statement = await signStatement(this.player, {
        topics: this.seat.post,
        channel: this.channel,
        expirySeconds: Math.floor(sentAt / 1000) + profile.ttlSeconds,
        sequence,
        data: probePayload({ sender: this.player.index, sequence, sentAt }, wireBytes(this.seat, bundleBytes(profile, connecting))),
      });
      stats.bytesSubmitted += (statement.length - 2) / 2;
      const result = (await this.connection.request("statement_submit", [statement], profile.submitTimeoutMs)) as { status: string; reason?: string };
      stats.submitRtt.add(Date.now() - sentAt);
      bump(stats.submits, result.reason ? `${result.status}:${result.reason}` : result.status);
      if (result.status === "new" && sentAt >= window.start && sentAt < window.end) {
        stats.acceptedInWindow++;
        stats.expectedDeliveries += this.seat.recipients;
      }
    } catch (error) {
      bump(stats.submits, error instanceof RpcError ? `rpc-error:${error.code}` : `error:${(error as Error).message}`);
    } finally {
      this.inflight--;
    }
  }

  private receive(result: unknown): void {
    const statements = (result as { data?: { statements?: string[] } }).data?.statements ?? [];
    const { stats, window } = this.game;
    const now = Date.now();
    for (const statement of statements) {
      const probe = readProbe(statement);
      if (!probe || probe.sender === this.player.index) continue;
      if (probe.sentAt < window.start || probe.sentAt >= window.end) continue;
      // A resubscribed feed may deliver a bundle again; one counted twice would hide a lost one.
      const key = `${probe.sender}:${probe.sequence}`;
      if (this.received.has(key)) continue;
      this.received.add(key);
      stats.deliveredInWindow++;
      this.lastDeliveryAt = now;
      stats.latency.add(now - probe.sentAt);
    }
  }
}
