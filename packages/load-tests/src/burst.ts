import type { PolkadotClient, Transaction } from "polkadot-api";
import { getTxCreator } from "polkadot-api/tx-creator";
import { toHex } from "@polkadot-api/utils";
import { PEOPLE_CLAIM_EXTENSIONS } from "@pop-e2e/chain-tests/src/lib/people-claim.js";
import { Histogram, type QuantileSummary } from "./histogram.js";
import type { Keypair } from "./keys.js";
import { RpcConnection } from "./rpc.js";
import { bump } from "./stats.js";
import type { AssetHubApi, PeopleApi } from "./target.js";

/** A chain a burst goes to: its events and timestamp are read for each block a transaction lands in. */
type BurstApi = PeopleApi | AssetHubApi;

export interface BurstEntry {
  signer: Keypair;
  tx: Transaction;
  /** The chain's next nonce of the signer when undefined. */
  nonce?: number;
}

interface BurstCounts {
  submitted: number;
  ok: number;
  /** Rejections by the RPC or pool, and dispatch errors, by error. */
  failures: Record<string, number>;
  /** Succeeded in a block whose timestamp is at most the burst's deadline. */
  inTime: number;
  firstBlock: number | null;
  lastBlock: number | null;
  durationMs: number;
}

export interface Burst extends BurstCounts {
  inclusionMs: Histogram;
}

export interface BurstSummary extends BurstCounts {
  inclusionMs: QuantileSummary;
}

interface BlockView {
  number: number;
  timestamp: number;
  /** "ok", the dispatch error of the extrinsic `hex`, or undefined when the block lacks it. */
  outcome(hex: string): string | undefined;
}

const TX_TIMEOUT_MS = 300_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeError(error: unknown): string {
  const parts: string[] = [];
  let value = error as { type?: string; value?: unknown } | undefined;
  while (value && typeof value === "object" && typeof value.type === "string") {
    parts.push(value.type);
    value = value.value as typeof value;
  }
  return parts.length > 0 ? parts.join(".") : JSON.stringify(error);
}

type ChainEvent = { phase: { type: string; value?: unknown }; event: { type: string; value: { type: string; value: unknown } } };

/** A block's extrinsics, events and timestamp, read once however many transactions it contains. */
function blockReader(api: BurstApi, client: PolkadotClient): (hash: string) => Promise<BlockView> {
  const cache = new Map<string, Promise<BlockView>>();
  const read = async (hash: string): Promise<BlockView> => {
    // The node reports the block before papi follows it, so the first reads may miss it.
    for (let attempt = 0; ; attempt++) {
      try {
        const [header, body, events, timestamp] = await Promise.all([
          client.getBlockHeader(hash),
          client.getBlockBody(hash),
          api.query.System.Events.getValue({ at: hash }) as Promise<ChainEvent[]>,
          api.query.Timestamp.Now.getValue({ at: hash }),
        ]);
        const extrinsics = body.map((extrinsic) => toHex(extrinsic));
        return {
          number: header.number,
          timestamp: Number(timestamp),
          outcome(hex) {
            const index = extrinsics.indexOf(hex);
            if (index < 0) return undefined;
            const own = events.filter((record) => record.phase.type === "ApplyExtrinsic" && record.phase.value === index);
            const failed = own.find((record) => record.event.type === "System" && record.event.value.type === "ExtrinsicFailed");
            return failed ? describeError((failed.event.value.value as { dispatch_error: unknown }).dispatch_error) : "ok";
          },
        };
      } catch (error) {
        if (attempt >= 20) throw error;
        await sleep(500);
      }
    }
  };
  return (hash) => cache.get(hash) ?? cache.set(hash, read(hash)).get(hash)!;
}

/** An upper bound of polkadot-api's time to sign one transaction on a CI runner. */
export const SIGNING_MS = 150;

/**
 * Each entry as a signed extrinsic in hex, mortal for 256 blocks. polkadot-api takes tens of
 * milliseconds per transaction, so a burst's transactions are signed before its window opens.
 */
export async function signEntries(entries: BurstEntry[], label: string): Promise<string[]> {
  const started = Date.now();
  const signed: string[] = [];
  for (let start = 0; start < entries.length; start += 200) {
    const chunk = entries.slice(start, start + 200).map(async ({ signer, tx, nonce }) => {
      const creator = getTxCreator(signer.publicKey, "Sr25519", async (input) => signer.sign(input));
      const options = { ...(nonce !== undefined && { nonce }), mortality: { mortal: true, period: 256 }, customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS };
      return toHex(await tx.create(creator, options as never));
    });
    signed.push(...(await Promise.all(chunk)));
  }
  console.log(`[${label}] ${signed.length} transactions signed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return signed;
}

/**
 * Submits every signed extrinsic at once over `connections` fresh connections to `urls` with
 * `author_submitAndWatchExtrinsic`, and resolves when each is in a best block, rejected or
 * timed out. `deadline` maps the chain time the burst starts at to the latest in-time block
 * timestamp.
 */
export async function submitBurst(
  signed: string[],
  api: BurstApi,
  client: PolkadotClient,
  urls: string[],
  connectionCount: number,
  deadline: (chainStart: number) => number,
): Promise<Burst> {
  const burst: Burst = { submitted: 0, ok: 0, failures: {}, inclusionMs: new Histogram(), inTime: 0, firstBlock: null, lastBlock: null, durationMs: 0 };
  const connections = await Promise.all(Array.from({ length: connectionCount }, (_, i) => RpcConnection.open(urls[i % urls.length], 15_000)));
  const readBlock = blockReader(api, client);
  const latest = deadline(Number(await api.query.Timestamp.Now.getValue({ at: "best" })));
  const start = Date.now();
  await Promise.all(
    signed.map(
      (hex, position) =>
        new Promise<void>((resolve) => {
          const connection = connections[position % connections.length];
          const submittedAt = Date.now();
          let id: string | undefined;
          let finished = false;
          const finish = (failure?: string) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (id) void connection.unsubscribe("author_unwatchExtrinsic", id, 10_000).catch(() => {});
            if (failure) bump(burst.failures, failure);
            resolve();
          };
          const timer = setTimeout(() => finish("timeout"), TX_TIMEOUT_MS);
          const included = async (hash: string) => {
            burst.inclusionMs.add(Date.now() - submittedAt);
            const block = await readBlock(hash);
            burst.firstBlock = Math.min(burst.firstBlock ?? Infinity, block.number);
            burst.lastBlock = Math.max(burst.lastBlock ?? 0, block.number);
            const outcome = block.outcome(hex);
            if (outcome !== "ok") return finish(outcome ?? "not in its block");
            burst.ok++;
            if (block.timestamp <= latest) burst.inTime++;
            finish();
          };
          burst.submitted++;
          connection
            .subscribe("author_submitAndWatchExtrinsic", [hex], 30_000, {
              onNotification(status) {
                if (status === "dropped" || status === "invalid") return finish(`pool: ${status}`);
                if (typeof status !== "object" || status === null) return;
                const [kind, value] = Object.entries(status)[0] ?? [];
                if (kind === "usurped" || kind === "finalityTimeout") finish(`pool: ${kind}`);
                else if (kind === "inBlock") included(value as string).catch((error: Error) => finish(`block read: ${error.message}`));
              },
              onEnd: (reason) => finish(`watch: ${reason}`),
            })
            .then((subscription) => {
              id = subscription;
              if (finished) void connection.unsubscribe("author_unwatchExtrinsic", subscription, 10_000).catch(() => {});
            })
            .catch((error: Error) => finish(`submit: ${error.message}`));
        }),
    ),
  );
  burst.durationMs = Date.now() - start;
  for (const connection of connections) connection.close();
  return burst;
}

export function summarizeBurst(burst: Burst): BurstSummary {
  return { ...burst, inclusionMs: burst.inclusionMs.summary() };
}
