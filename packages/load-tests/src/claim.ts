import { Enum, type PolkadotClient, type SizedHex } from "polkadot-api";
import { getClaimableCollections, getClaims, type Claim, type NftsChain, type NftsCreditsChain } from "@parity/product-sdk-nfts";
import { signEntry, submitLanes, summarizeBurst, type BurstSummary, type Lane } from "./burst.js";
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
const READ_CONCURRENCY = 20;

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
 * Waits for the credits `gameIndex` awarded the players to reach Asset Hub, then claims every
 * one at once, each into a claimable collection and to a fresh purse key, as a player does
 * after the game. `awarded` is how many credits to expect.
 */
export async function claimCredits(
  target: Target,
  people: PolkadotClient,
  players: Player[],
  gameIndex: number,
  awarded: number,
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
    let claimable = 0;
    for (;;) {
      const reads = await readAll(players, async (player) => {
        const result = await getClaims(chain, { claimant: { tag: "Account", address: player.address }, individualityAt: "best" });
        if (!result.ok) throw new Error(`claims of ${player.address}: ${result.error.message}`);
        return { player, claims: result.value.claims.filter((claim) => claim.gameIndex === gameIndex && claim.state === "claimable") };
      });
      mine = reads.filter((read) => read.claims.length > 0);
      claimable = mine.reduce((sum, read) => sum + read.claims.length, 0);
      console.log(`[claim] ${claimable}/${awarded} credits claimable after ${Math.round((Date.now() - started) / 1000)} s`);
      if (claimable >= awarded || Date.now() - started > CLAIMABLE_WAIT_MS) break;
      await sleep(12_000);
    }
    const claimableAfterMs = Date.now() - started;
    const offered = await getClaimableCollections(chain);
    if (!offered.ok) throw new Error(`claimable collections: ${offered.error.message}`);
    const collections = offered.value.collections.map((collection) => collection.id);
    if (collections.length === 0 || claimable === 0) return { awarded, claimable, claimableAfterMs, collections, burst: null, playerMs: null };

    await fundOnAssetHub(api, target, mine.map((read) => read.player));
    const nonces = await api.query.System.Account.getValues(mine.map((read) => [read.player.address]), { at: "best" });
    const playerMs = new Histogram();
    let position = 0;
    // As the stash claims: one claim at a time, the next once the previous has landed, at the
    // following nonce, or at the chain's after a failure.
    const lanes = mine.map(
      ({ player, claims }, index): Lane =>
        async (submit) => {
          const started = Date.now();
          let nonce = nonces[index].nonce;
          for (const claim of claims) {
            const tx = api.tx.NftClaims.claim({
              claimant: Enum("Account"),
              block: claim.awardBlock,
              credit: claim.hash as SizedHex<32>,
              leaf_index: claim.leafIndex!,
              proof: claim.proof! as SizedHex<32>[],
              collection: collections[position++ % collections.length],
              // A purse key holds one NFT, so every claim mints to a key of its own.
              mint_to: derivePlayer(`${player.address}/nft/${claim.awardBlock}`, claim.leafIndex!).address,
            });
            if (await submit(await signEntry({ signer: player, tx, nonce }))) nonce++;
            else nonce = (await api.query.System.Account.getValue(player.address, { at: "best" })).nonce;
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
