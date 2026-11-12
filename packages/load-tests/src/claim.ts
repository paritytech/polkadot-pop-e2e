import { Enum, type PolkadotClient, type SizedHex, type SS58String } from "polkadot-api";
import { getClaimableCollections, getClaims, type Claim, type NftsChain, type NftsCreditsChain } from "@parity/product-sdk-nfts";
import { signEntries, signEntry, submitLanes, summarizeBurst, type BurstSummary, type Lane } from "./burst.js";
import { Histogram, type QuantileSummary } from "./histogram.js";
import { derivePlayer, type Keypair, type Player } from "./keys.js";
import { submitToBestBlock } from "./root.js";
import { connectAssetHub, type AssetHubApi, type Target } from "./target.js";

export interface ClaimResult {
  /** Credits the game awarded the players: the `Person` votes they received. */
  awarded: number;
  /** Of those, the ones Asset Hub had a root for, and so could be claimed, when the wait ended. */
  claimable: number;
  /** From the end of the report burst until the last credit was claimable, or the wait ended. */
  claimableAfterMs: number;
  collections: number[];
  /** Every claim, each timed from its submission to its block. */
  burst: BurstSummary | null;
  /** Per player, from its first claim's submission until its last claim finished. */
  playerMs: QuantileSummary | null;
}

/** Fees of a player's claims on Asset Hub. */
const ASSET_HUB_FUNDS = 10_000_000_000n;
/** How long the run waits for the game's credits to reach Asset Hub. */
const CLAIMABLE_WAIT_MS = 600_000;
const READ_CONCURRENCY = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `read` over `items`, `READ_CONCURRENCY` at a time, in order. */
async function readAll<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const position = next++;
        results[position] = await read(items[position]);
      }
    }),
  );
  return results;
}

/** Tops every claiming player up to `ASSET_HUB_FUNDS` on Asset Hub: as root on a fork, else from the funder. */
async function fundOnAssetHub(api: AssetHubApi, target: Target, players: Player[]): Promise<void> {
  const accounts = await api.query.System.Account.getValues(players.map((player) => [player.address]), { at: "best" });
  const short = players.filter((_, position) => accounts[position].data.free < ASSET_HUB_FUNDS);
  if (!target.sudo && short.length > 0) {
    if (!target.funder) throw new Error(`${target.label}: no funded account to pay the claims on Asset Hub; set TEST_MNEMONIC`);
    const needed = BigInt(short.length) * ASSET_HUB_FUNDS + ASSET_HUB_FUNDS;
    const available = (await api.query.System.Account.getValue(target.funder.address, { at: "best" })).data.free;
    if (available < needed) {
      throw new Error(
        `${target.funder.address} has ${Number(available) / 1e10} UNIT on ${target.label}'s Asset Hub; send it at least ${Math.ceil(Number(needed - available) / 1e10)} UNIT more`,
      );
    }
  }
  for (let start = 0; start < short.length; start += 500) {
    const chunk = short.slice(start, start + 500);
    let tx;
    let signer: Keypair;
    if (target.sudo) {
      const calls = chunk.map((player) => api.tx.Balances.force_set_balance({ who: Enum("Id", player.address), new_free: ASSET_HUB_FUNDS }).decodedCall);
      tx = api.tx.Sudo.sudo({ call: api.tx.Utility.batch_all({ calls }).decodedCall });
      signer = target.sudo;
    } else {
      if (!target.funder) throw new Error(`${target.label}: no funded account to pay the claims on Asset Hub; set TEST_MNEMONIC`);
      const calls = chunk.map((player) => api.tx.Balances.transfer_keep_alive({ dest: Enum("Id", player.address), value: ASSET_HUB_FUNDS }).decodedCall);
      tx = api.tx.Utility.batch_all({ calls });
      signer = target.funder;
    }
    const included = await submitToBestBlock(tx, signer);
    console.log(`[claim] funded ${Math.min(start + 500, short.length)}/${short.length} on Asset Hub in #${included.block.number}`);
  }
}

/**
 * Waits for the credits People awarded the players from `sinceBlock` on to reach Asset Hub, then
 * has every player claim its own one at a time, each into a claimable collection and to a fresh
 * purse key, as the stash does after the game.
 */
export async function claimCredits(
  target: Target,
  people: PolkadotClient,
  players: Player[],
  sinceBlock: number,
  connections: number,
): Promise<ClaimResult> {
  const { client, api } = connectAssetHub(target);
  const chain = {
    individuality: people.getUnsafeApi(),
    assetHub: client.getUnsafeApi(),
    raw: { individuality: people, assetHub: client },
  } as unknown as NftsChain & NftsCreditsChain;
  const started = Date.now();
  try {
    let mine: Array<{ player: Player; claims: Claim[] }> = [];
    let awarded = 0;
    let claimable = 0;
    for (;;) {
      // Every credit People awarded the players from the reports' block on, claimable or not
      // yet: the bots play no other game meanwhile.
      const reads = await readAll(players, async (player) => {
        const result = await getClaims(chain, { claimant: { tag: "Account", address: player.address }, individualityAt: "best" });
        if (!result.ok) throw new Error(`claims of ${player.address}: ${result.error.message}`);
        const fresh = result.value.claims.filter((claim) => claim.awardBlock >= sinceBlock);
        return { player, awarded: fresh.length, claims: fresh.filter((claim) => claim.state === "claimable") };
      });
      mine = reads.filter((read) => read.claims.length > 0);
      awarded = reads.reduce((sum, read) => sum + read.awarded, 0);
      claimable = mine.reduce((sum, read) => sum + read.claims.length, 0);
      console.log(`[claim] ${claimable}/${awarded} credits claimable after ${Math.round((Date.now() - started) / 1000)} s`);
      if ((awarded > 0 && claimable === awarded) || Date.now() - started > CLAIMABLE_WAIT_MS) break;
      await sleep(12_000);
    }
    const claimableAfterMs = Date.now() - started;
    const offered = await getClaimableCollections(chain);
    if (!offered.ok) throw new Error(`claimable collections: ${offered.error.message}`);
    const collections = offered.value.collections.map((collection) => collection.id);
    if (collections.length === 0 || claimable === 0) return { awarded, claimable, claimableAfterMs, collections, burst: null, playerMs: null };

    await fundOnAssetHub(api, target, mine.map((read) => read.player));
    const nonces = await api.query.System.Account.getValues(mine.map((read) => [read.player.address]), { at: "best" });
    let position = 0;
    const txs = mine.map(({ player, claims }) =>
      claims.map((claim) =>
        api.tx.NftClaims.claim({
          claimant: Enum("Account"),
          block: claim.awardBlock,
          credit: claim.hash as SizedHex<32>,
          leaf_index: claim.leafIndex!,
          proof: claim.proof! as SizedHex<32>[],
          collection: collections[position++ % collections.length],
          // A purse key holds one NFT, so every claim mints to a key of its own.
          mint_to: derivePlayer(`${player.address}/nft/${claim.awardBlock}`, claim.leafIndex!).address,
        }),
      ),
    );
    // Signed up front: one process signs for every player, which a phone does for itself only.
    const flat = await signEntries(
      mine.flatMap(({ player }, index) => txs[index].map((tx, offset) => ({ signer: player, tx, nonce: nonces[index].nonce + offset }))),
      "claim",
    );
    let taken = 0;
    const signed = txs.map((own) => flat.slice(taken, (taken += own.length)));
    const readNonce = async (address: SS58String): Promise<number> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return (await api.query.System.Account.getValue(address, { at: "best" })).nonce;
        } catch (error) {
          if (attempt === 3) throw error;
          await sleep(2_000);
        }
      }
    };
    const playerMs = new Histogram();
    // As the stash claims: one claim at a time, the next once the previous has landed.
    const lanes = mine.map(
      ({ player }, index): Lane =>
        async (submit) => {
          const started = Date.now();
          const own = signed[index];
          for (let next = 0; next < own.length; next++) {
            if (await submit(own[next])) continue;
            // A failed claim leaves the following ones at the wrong nonce: sign them again at the chain's.
            const nonce = await readNonce(player.address);
            for (let later = next + 1; later < own.length; later++) {
              own[later] = await signEntry({ signer: player, tx: txs[index][later], nonce: nonce + later - next - 1 });
            }
          }
          playerMs.add(Date.now() - started);
        },
    );
    console.log(`[claim] ${mine.length} players claim ${claimable} credits, each one at a time`);
    const burst = await submitLanes(lanes, api, client, [target.assetHubRpc!], connections, () => Number.POSITIVE_INFINITY);
    console.log(`[claim] claims: ${burst.ok}/${burst.submitted} in ${burst.durationMs} ms`);
    return { awarded, claimable, claimableAfterMs, collections, burst: summarizeBurst(burst), playerMs: playerMs.summary() };
  } finally {
    client.destroy();
  }
}
