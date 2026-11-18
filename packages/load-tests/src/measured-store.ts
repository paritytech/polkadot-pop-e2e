import {
  SIGN_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  TTL_S,
  errMessage,
  withTimeout,
  type StatementStoreLike,
  type StatementSubscription,
  type WireStatement,
} from "@jollity/statement-core";
import { DeliveryCounter, SignallingStats, bump } from "./stats.js";

/** A statement as a store delivers it: beside what the transport reads, its channel and expiry. */
export interface DeliveredStatement {
  data?: string;
  signer?: string;
  channel?: string;
  expiry?: bigint;
}

/** What a store reports of one subscription's life. */
export interface SubscriptionEvents {
  opened(): void;
  /** The store ended the subscription before the player unsubscribed. */
  ended(reason: string): void;
  /** The subscription did not open. */
  failed(reason: string): void;
}

/** A `StatementStoreLike` whose pages also say each statement's channel and expiry, and that reports its subscriptions' life. */
export interface MeasurableStore extends Omit<StatementStoreLike, "subscribe"> {
  subscribe(filter: { matchAny: string[] }, onPage: (page: { statements: DeliveredStatement[] }) => void, events: SubscriptionEvents): StatementSubscription;
}

/** The time a statement was stamped: `nextSlotExpiry` packs its milliseconds, modulo 2^32,
 *  beside the deadline `TTL_S` seconds later. */
export function stampTime(expiry: bigint): number {
  const low = Number(expiry & 0xffff_ffffn);
  const approximate = (Number(expiry >> 32n) - TTL_S) * 1000;
  return low + Math.round((approximate - low) / 2 ** 32) * 2 ** 32;
}

/** An error as a count key: numbers in it, such as an expiry in it, would make every key differ. */
const countKey = (error: unknown) => errMessage(error).replace(/\d+/g, "N").slice(0, 160);

/** A player's store as its transport uses it, which stops delivering to the player on `close`. */
export type MeasuredStore = StatementStoreLike & { close(): void };

/**
 * When each statement of this process's players went out, by `channel/expiry`. A receiver in the
 * same process measures latency from it; the expiry stamp reads late here, since the process's
 * players share statement-core's expiry floor, which moves every stamp past the last one.
 */
const sendTimes = new Map<string, number>();
const statementKey = (channel: string, expiry: bigint) => `${channel.toLowerCase()}/${expiry}`;

/**
 * `store` as one player's transport uses it, counting what the summary reads: every submit, and
 * every statement delivered to the player, which arrives from then until `close`, also after the
 * transport unsubscribed.
 */
export function createCountingStore(store: MeasurableStore, stats: SignallingStats, counter: DeliveryCounter): MeasuredStore {
  const proofStarts = new Map<bigint, number>();
  const subscriptions: StatementSubscription[] = [];
  return {
    async createProofAuthorized(wire: WireStatement) {
      proofStarts.set(wire.expiry, Date.now());
      sendTimes.set(statementKey(wire.channel, wire.expiry), Date.now());
      try {
        // The transport gives up on a proof or submit after these, so one that hangs counts as `timeout`.
        return await withTimeout(store.createProofAuthorized(wire), SIGN_TIMEOUT_MS);
      } catch (error) {
        proofStarts.delete(wire.expiry);
        bump(stats.submits, `proof:${countKey(error)}`);
        throw error;
      }
    },
    async submit(wire) {
      const startedAt = proofStarts.get(wire.expiry) ?? Date.now();
      proofStarts.delete(wire.expiry);
      stats.bytesSubmitted += (wire.data.length - 2) / 2;
      try {
        const result = await withTimeout(store.submit(wire), SUBMIT_TIMEOUT_MS);
        stats.submitRtt.add(Date.now() - startedAt);
        bump(stats.submits, result && typeof result === "object" && "status" in result && typeof result.status === "string" ? result.status : "new");
        counter.accepted(wire.channel.toLowerCase(), stampTime(wire.expiry));
        return result;
      } catch (error) {
        stats.submitRtt.add(Date.now() - startedAt);
        bump(stats.submits, `submit:${countKey(error)}`);
        throw error;
      }
    },
    subscribe(filter, onPage) {
      let forwarding = true;
      const events: SubscriptionEvents = {
        opened: () => counter.recordSubscribe(),
        ended: (reason) => counter.recordEnd(reason),
        failed: (reason) => bump(stats.subscribeFailures, reason),
      };
      subscriptions.push(
        store.subscribe(
          filter,
          (page) => {
            const now = Date.now();
            for (const { channel, expiry } of page.statements) {
              if (channel === undefined || expiry === undefined) continue;
              const stampedAt = stampTime(expiry);
              counter.receive(channel.toLowerCase(), stampedAt, sendTimes.get(statementKey(channel, expiry)) ?? stampedAt, now);
            }
            if (forwarding) onPage(page);
          },
          events,
        ),
      );
      return { unsubscribe: () => (forwarding = false) };
    },
    close() {
      for (const subscription of subscriptions) subscription.unsubscribe?.();
    },
  };
}
