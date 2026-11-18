import { TTL_S, errMessage, type StatementStoreLike, type StatementSubscription, type WireStatement } from "@jollity/statement-core";
import { DeliveryCounter, SignallingStats, bump } from "./stats.js";

/** A statement as a store delivers it: beside what the transport reads, its channel and expiry. */
export interface DeliveredStatement {
  data?: string;
  signer?: string;
  channel?: string;
  expiry?: bigint;
}

/** A `StatementStoreLike` whose pages also say each statement's channel and expiry. */
export interface MeasurableStore extends Omit<StatementStoreLike, "subscribe"> {
  subscribe(filter: { matchAny: string[] }, onPage: (page: { statements: DeliveredStatement[] }) => void): StatementSubscription;
}

/** The time a statement was stamped: `nextSlotExpiry` packs its milliseconds, modulo 2^32,
 *  beside the deadline `TTL_S` seconds later. */
export function stampTime(expiry: bigint): number {
  const low = Number(expiry & 0xffff_ffffn);
  const approximate = (Number(expiry >> 32n) - TTL_S) * 1000;
  return low + Math.round((approximate - low) / 2 ** 32) * 2 ** 32;
}

/** An error as a count key: numbers in it, such as an expiry it names, would make every key differ. */
const countKey = (error: unknown) => errMessage(error).replace(/\d+/g, "N").slice(0, 160);

/** A player's store as its transport uses it, which stops delivering to the player on `close`. */
export type MeasuredStore = StatementStoreLike & { close(): void };

/**
 * `store` as one player's transport uses it, counting what the summary reads: every submit, and
 * every statement delivered to the player, which arrives from then until `close`, also after the
 * transport unsubscribed.
 */
export function measuredStore(store: MeasurableStore, stats: SignallingStats, counter: DeliveryCounter): MeasuredStore {
  const proofStarts = new Map<bigint, number>();
  const subscriptions: StatementSubscription[] = [];
  return {
    async createProofAuthorized(wire: WireStatement) {
      proofStarts.set(wire.expiry, Date.now());
      try {
        return await store.createProofAuthorized(wire);
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
        const result = await store.submit(wire);
        stats.submitRtt.add(Date.now() - startedAt);
        bump(stats.submits, result && typeof result === "object" && "status" in result && typeof result.status === "string" ? result.status : "new");
        counter.accepted(stampTime(wire.expiry));
        return result;
      } catch (error) {
        stats.submitRtt.add(Date.now() - startedAt);
        bump(stats.submits, `submit:${countKey(error)}`);
        throw error;
      }
    },
    subscribe(filter, onPage) {
      let forwarding = true;
      subscriptions.push(
        store.subscribe(filter, (page) => {
          const now = Date.now();
          for (const { channel, expiry } of page.statements) {
            if (channel !== undefined && expiry !== undefined) counter.receive(`${channel}/${expiry}`, stampTime(expiry), now);
          }
          if (forwarding) onPage(page);
        }),
      );
      return { unsubscribe: () => (forwarding = false) };
    },
    close() {
      for (const subscription of subscriptions) subscription.unsubscribe?.();
    },
  };
}
