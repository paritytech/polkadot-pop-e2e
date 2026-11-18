import { Histogram } from "./histogram.js";

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
 * Deliveries of the statements accepted in the window. A player has one statement per channel, a
 * newer one replacing the last, so a receiver credits every statement of a channel up to the
 * latest it received there: one replaced before it arrived came with the one that replaced it.
 */
export function creditedDeliveries(stats: Pick<SignallingStats, "acceptedStamps" | "deliveredUpTo">): number {
  let credited = 0;
  for (const channels of Object.values(stats.deliveredUpTo)) {
    for (const [channel, upTo] of Object.entries(channels)) credited += (stats.acceptedStamps[channel] ?? []).filter((stamp) => stamp <= upTo).length;
  }
  return credited;
}

/**
 * One player's share of a step's delivery counts: the statements it sent that `recipients` others
 * are due, and the ones it received, so every kind of ghost measures loss alike.
 */
export class DeliveryCounter {
  private readonly seen = new Set<string>();
  private lastDeliveryAt = 0;
  private subscribeTime: number | undefined;
  private statements = 0;

  constructor(
    private readonly stats: SignallingStats,
    private readonly window: { start: number; end: number },
    private readonly recipients: number,
    private readonly receiver: string,
  ) {}

  /** A statement of this player's on `channel` the store accepted; one stamped in the window is due to every recipient. */
  accepted(channel: string, stampedAt: number): void {
    if (stampedAt < this.window.start || stampedAt >= this.window.end) return;
    this.stats.acceptedInWindow++;
    this.stats.expectedDeliveries += this.recipients;
    (this.stats.acceptedStamps[channel] ??= []).push(stampedAt);
  }

  recordSubscribe(): void {
    this.subscribeTime = Date.now();
    this.stats.subscribed++;
  }

  /** Counts a subscription that ended before its player left, by `reason`, with how long it lasted. */
  recordEnd(reason: string): void {
    bump(this.stats.subscriptionsEnded, reason);
    this.stats.subscriptionLifetimeMs.add(Date.now() - (this.subscribeTime ?? Date.now()));
    if (this.statements === 0) this.stats.emptySubscriptionEnds++;
  }

  /**
   * A statement on `channel` stamped at `stampedAt`, sent at `sentAt`, arrived at this player; one
   * stamped in the window counts once.
   */
  receive(channel: string, stampedAt: number, sentAt: number, now: number): void {
    this.statements++;
    const channels = (this.stats.deliveredUpTo[this.receiver] ??= {});
    channels[channel] = Math.max(channels[channel] ?? 0, stampedAt);
    // A resubscribed feed may deliver a statement again; one counted twice would hide a lost one.
    const key = `${channel}/${stampedAt}`;
    if (stampedAt < this.window.start || stampedAt >= this.window.end || this.seen.has(key)) return;
    this.seen.add(key);
    this.stats.deliveredInWindow++;
    this.stats.latency.add(now - sentAt);
    this.lastDeliveryAt = now;
  }

  /** Counts the player's subscription, if it opened one, when it delivered nothing or stopped before the window ended. */
  finish(): void {
    if (this.subscribeTime !== undefined) countDeliveryGap(this.stats, this.lastDeliveryAt, this.window.end);
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
  /** Time from subscribing to the end of each subscription in `subscriptionsEnded`. */
  subscriptionLifetimeMs = new Histogram();
  /** Subscriptions in `subscriptionsEnded` that ended before delivering any statement. */
  emptySubscriptionEnds = 0;
  /** Subscriptions open through the game that delivered none of its statements. */
  silentSubscriptions = 0;
  /**
   * Subscriptions that delivered some of the game's statements, then none in its last
   * `STALL_MS`: the statement store ends a subscriber that falls behind without telling it.
   */
  stalledSubscriptions = 0;
  /** `statement_submit` answers by status, or the error the proof or submit failed with. */
  submits: Record<string, number> = {};
  /** What the statement transport reported of its submits: retries, waits for a slot, frames
   *  replaced while queued, and submits it gave up on. */
  submitEvents: Record<string, number> = {};
  /** The waiting room's store clock calibrations, by outcome. */
  calibrations: Record<string, number> = {};
  /** Links the ghosts' rooms negotiate, and those up when the game ended. */
  links = 0;
  linksUp = 0;
  /** Statements the node accepted whose stamp time falls in the measurement window. */
  acceptedInWindow = 0;
  /** Deliveries those statements owe: for each, the ghosts that listen on its topics. */
  expectedDeliveries = 0;
  /** Statements of other ghosts stamped in the window that reached this shard's ghosts themselves, not replaced first. */
  deliveredInWindow = 0;
  /** Per channel, the stamp times of the statements accepted in the window. */
  acceptedStamps: Record<string, number[]> = {};
  /** Per receiver, then per channel, the latest stamp time the receiver got there. */
  deliveredUpTo: Record<string, Record<string, number>> = {};
  bytesSubmitted = 0;
  latency = new Histogram();
  submitRtt = new Histogram();

  /** Adds the counts of `other`, a `SignallingStats` or its JSON. */
  add(other: SignallingStats): void {
    const { acceptedStamps, deliveredUpTo, ...counts } = other;
    for (const [channel, stamps] of Object.entries(acceptedStamps)) (this.acceptedStamps[channel] ??= []).push(...stamps);
    for (const [receiver, channels] of Object.entries(deliveredUpTo)) {
      const latest = (this.deliveredUpTo[receiver] ??= {});
      for (const [channel, stamp] of Object.entries(channels)) latest[channel] = Math.max(latest[channel] ?? 0, stamp);
    }
    const own = this as unknown as Record<string, number | Histogram | Record<string, number>>;
    for (const [key, value] of Object.entries(counts) as Array<[string, number | { counts: Record<number, number> } | Record<string, number>]>) {
      const field = own[key];
      if (typeof value === "number") own[key] = (field as number) + value;
      else if (field instanceof Histogram) field.merge(new Histogram((value as { counts: Record<number, number> }).counts));
      else for (const [entry, count] of Object.entries(value as Record<string, number>)) bump(field as Record<string, number>, entry, count);
    }
  }
}
