import type { PolkadotClient } from "polkadot-api";
import type { AssetHubApi, PeopleApi } from "./target.js";
import { sleep } from "./time.js";

/** A `System.Events` record, as far as the run reads it. */
export interface ChainEvent {
  phase: { type: string; value?: unknown };
  event: { type: string; value: { type: string; value?: unknown } };
}

export interface BlockContents {
  body: Uint8Array[];
  events: ChainEvent[];
  /** `Timestamp.Now`, chain milliseconds. */
  timestamp: number;
}

const contentsByClient = new WeakMap<PolkadotClient, Map<string, Promise<BlockContents>>>();

async function fetchBlockContents(client: PolkadotClient, api: PeopleApi | AssetHubApi, hash: string): Promise<BlockContents> {
  // The node reports a block to a transaction's watcher before papi follows it, so the first reads may miss it.
  for (let attempt = 0; ; attempt++) {
    try {
      const [body, events, timestamp] = await Promise.all([
        client.getBlockBody(hash),
        api.query.System.Events.getValue({ at: hash }) as Promise<ChainEvent[]>,
        api.query.Timestamp.Now.getValue({ at: hash }),
      ]);
      return { body, events, timestamp: Number(timestamp) };
    } catch (error) {
      if (attempt >= 20) throw error;
      await sleep(500);
    }
  }
}

/**
 * Block `hash`'s body, events and timestamp, fetched once per client for every reader until
 * `releaseBlockContents`: a burst and the run's block follower read the same blocks.
 */
export function readBlockContents(client: PolkadotClient, api: PeopleApi | AssetHubApi, hash: string): Promise<BlockContents> {
  const contents = contentsByClient.get(client) ?? new Map<string, Promise<BlockContents>>();
  contentsByClient.set(client, contents);
  let read = contents.get(hash);
  if (!read) {
    read = fetchBlockContents(client, api, hash);
    contents.set(hash, read);
    read.catch(() => contents.delete(hash));
  }
  return read;
}

/** Frees block `hash`'s contents once no reader needs them again. */
export function releaseBlockContents(client: PolkadotClient, hash: string): void {
  contentsByClient.get(client)?.delete(hash);
}
