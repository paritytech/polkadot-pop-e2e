import type { Player } from "./keys.js";
import { bundleBytes, isConnecting, type SignallingProfile } from "./profile.js";
import { RpcConnection, RpcError } from "./rpc.js";
import { probePayload, readProbe, signStatement, topicOf, type Hex } from "./statement.js";
import { bump, type SignallingStats } from "./stats.js";

export interface GhostRoom {
  profile: SignallingProfile;
  /** Prefix of every topic and channel of this step, so steps and runs never share one. */
  namespace: string;
  room: Hex;
  gameStart: number;
  window: { start: number; end: number };
  stats: SignallingStats;
}

const SUBSCRIBE = "statement_subscribeStatement";
const UNSUBSCRIBE = "statement_unsubscribeStatement";

/**
 * A player that only signals: it subscribes to its inbox and the room as the app does, and
 * submits a bundle of the profile's size on its own channel at the profile's period.
 */
export class Ghost {
  private readonly inbox: Hex;
  private readonly channel: Hex;
  private subscription: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private inflight = 0;
  private stopped = false;
  private delivered = 0;

  constructor(
    private readonly player: Player,
    private readonly connection: RpcConnection,
    private readonly game: GhostRoom,
  ) {
    this.inbox = topicOf(`${game.namespace}/inbox/${player.index}`);
    this.channel = topicOf(`${game.namespace}/bundle/${player.index}`);
  }

  async join(): Promise<void> {
    const { stats, profile } = this.game;
    try {
      this.subscription = await this.connection.subscribe(SUBSCRIBE, [{ matchAny: [this.inbox, this.game.room] }], profile.submitTimeoutMs, {
        onNotification: (result) => this.receive(result),
        onEnd: (reason) => bump(stats.subscriptionsEnded, reason),
      });
      stats.subscribed++;
    } catch (error) {
      bump(stats.subscribeFailures, (error as Error).message);
      return;
    }
    // A random phase, so the ghosts' bundles spread over the period like players' do.
    this.schedule(Math.random() * profile.connectingIntervalMs);
  }

  /** Stops sending; the subscription stays until `leave`, so late deliveries still count. */
  stopSending(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async leave(): Promise<void> {
    this.stopSending();
    if (!this.subscription) return;
    if (this.delivered === 0) this.game.stats.silentSubscriptions++;
    await this.connection.unsubscribe(UNSUBSCRIBE, this.subscription, this.game.profile.submitTimeoutMs).catch(() => {});
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const connecting = isConnecting(this.game.profile, Date.now() - this.game.gameStart);
      void this.send(connecting);
      const { connectingIntervalMs, linkedIntervalMs } = this.game.profile;
      this.schedule(connecting ? connectingIntervalMs : linkedIntervalMs);
    }, delayMs);
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
        topics: [this.game.room],
        channel: this.channel,
        expirySeconds: Math.floor(sentAt / 1000) + profile.ttlSeconds,
        sequence,
        data: probePayload({ sender: this.player.index, sequence, sentAt }, bundleBytes(profile, connecting)),
      });
      stats.bytesSubmitted += (statement.length - 2) / 2;
      const result = (await this.connection.request("statement_submit", [statement], profile.submitTimeoutMs)) as { status: string; reason?: string };
      stats.submitRtt.add(Date.now() - sentAt);
      bump(stats.submits, result.reason ? `${result.status}:${result.reason}` : result.status);
      if (result.status === "new" && sentAt >= window.start && sentAt < window.end) stats.acceptedInWindow++;
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
      stats.deliveredInWindow++;
      this.delivered++;
      stats.latency.add(now - probe.sentAt);
    }
  }
}
