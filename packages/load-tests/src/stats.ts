import { Histogram } from "./histogram.js";
import type { Probe } from "./statement.js";

export function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

export const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);

/** A subscription silent this long before the window's end counts as stalled. */
export const STALL_MS = 30_000;

/** Counts a subscription that delivered nothing, or stopped `STALL_MS` before `windowEnd`. */
export function countDeliveryGap(stats: SignallingStats, lastDeliveryAt: number, windowEnd: number): void {
  if (lastDeliveryAt === 0) stats.silentSubscriptions++;
  else if (lastDeliveryAt < windowEnd - STALL_MS) stats.stalledSubscriptions++;
}

/**
 * One player's share of a step's delivery counts: the bundles it sent that `recipients` others
 * are due, and the ones it received, each counted once, so every kind of ghost measures loss alike.
 */
export class DeliveryCounter {
  private readonly seen = new Set<string>();
  private lastDeliveryAt = 0;

  constructor(
    private readonly stats: SignallingStats,
    private readonly window: { start: number; end: number },
    private readonly self: number,
    private readonly recipients: number,
  ) {}

  /** A bundle of this player's the store accepted; one sent in the window is due to every recipient. */
  accepted(sentAt: number): void {
    if (sentAt < this.window.start || sentAt >= this.window.end) return;
    this.stats.acceptedInWindow++;
    this.stats.expectedDeliveries += this.recipients;
  }

  /** A bundle that arrived at this player; another player's sent in the window counts once. */
  receive(probe: Probe | undefined, now: number): void {
    if (!probe || probe.sender === this.self || probe.sentAt < this.window.start || probe.sentAt >= this.window.end) return;
    // A resubscribed feed may deliver a bundle again; one counted twice would hide a lost one.
    const key = `${probe.sender}:${probe.sequence}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.stats.deliveredInWindow++;
    this.stats.latency.add(now - probe.sentAt);
    this.lastDeliveryAt = now;
  }

  /** Counts the player's subscription if it delivered nothing, or stopped before the window ended. */
  finish(): void {
    countDeliveryGap(this.stats, this.lastDeliveryAt, this.window.end);
  }
}

/** What the ghosts of one shard observed during one step. */
export class SignallingStats {
  connections = 0;
  connectFailures: Record<string, number> = {};
  connectionsLost: Record<string, number> = {};
  subscribed = 0;
  subscribeFailures: Record<string, number> = {};
  subscriptionsEnded: Record<string, number> = {};
  /** Subscriptions open through the game that delivered none of its statements. */
  silentSubscriptions = 0;
  /**
   * Subscriptions that delivered some of the game's statements, then none in its last
   * `STALL_MS`: the statement store ends a subscriber that falls behind without telling it.
   */
  stalledSubscriptions = 0;
  /** `statement_submit` answers by status (and reason), or the error the request ended with. */
  submits: Record<string, number> = {};
  /** Bundles not sent because `maxInflight` submits were still waiting, as the app does. */
  skippedInflight = 0;
  /** Statements the node accepted as new whose probe time falls in the measurement window. */
  acceptedInWindow = 0;
  /** Deliveries those statements owe: for each, the ghosts that listen on its topics. */
  expectedDeliveries = 0;
  /** Deliveries to this shard's ghosts of statements from other ghosts sent in the window. */
  deliveredInWindow = 0;
  bytesSubmitted = 0;
  latency = new Histogram();
  submitRtt = new Histogram();

  /** Adds the counts of `other`, a `SignallingStats` or its JSON. */
  add(other: SignallingStats): void {
    const own = this as unknown as Record<string, number | Histogram | Record<string, number>>;
    for (const [key, value] of Object.entries(other) as Array<[string, number | { counts: Record<number, number> } | Record<string, number>]>) {
      const field = own[key];
      if (typeof value === "number") own[key] = (field as number) + value;
      else if (field instanceof Histogram) field.merge(new Histogram((value as { counts: Record<number, number> }).counts));
      else for (const [entry, count] of Object.entries(value as Record<string, number>)) bump(field as Record<string, number>, entry, count);
    }
  }
}
