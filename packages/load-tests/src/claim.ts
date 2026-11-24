import { Enum, type SizedHex, type SS58String } from "polkadot-api";
import { getApprovedCollections, getClaimableCollections, getClaims, type Claim } from "@parity/product-sdk-nfts";
import type { PeopleClient as AppPeopleClient } from "@individuality/people-chain";
import { gameCredits, type GameCredits } from "@individuality/game-outcome";
import { claimsChain, type ClaimsChain } from "@individuality/game-outcome/chain";
import { defaultCollectionFor } from "@jollity/collectables/src/picks";
import { accountSigner, signEntry, submitLanes, summarizeBurst, type BurstSummary, type Lane } from "./burst.js";
import { Histogram, type QuantileSummary } from "./histogram.js";
import { derivePlayer, type Keypair, type Player } from "./keys.js";
import { requireFunder } from "./join.js";
import { submitToBestBlock } from "./root.js";
import type { SigningPool } from "./signing-pool.js";
import { APP_NETWORKS, connectAssetHub, type AssetHubApi, type Target } from "./target.js";
import { readAll, retry, sleep, withTimeout } from "./time.js";

export interface ClaimResult {
  /** Credits the game awarded the players, as the app counts a game's credits. */
  awarded: number;
  /** Of those, the ones Asset Hub had a root for, and so could be claimed, when the wait ended. */
  claimable: number;
  /** From the end of the report burst until the last credit was claimable, or the wait ended. */
  claimableAfterMs: number;
  collections: number[];
  /** Every claim, each timed from its submission to its block. */
  burst: BurstSummary | null;
  /** Of the claimable credits, the ones Asset Hub marks as claimed once every player is done. */
  claimed: number;
  /** Per player, from its first claim's submission until its last claim finished. */
  playerMs: QuantileSummary | null;
}

/** Fees of a player's claims on Asset Hub. */
const ASSET_HUB_FUNDS = 10_000_000_000n;
/** How long the run waits for the game's credits to arrive on Asset Hub. */
const CLAIMABLE_WAIT_MS = 600_000;
const CREDITS_READ_ATTEMPTS = 3;
const CREDITS_READ_MS = 60_000;
/**
 * Claim reads at once. Each reads every award of each of the player's award blocks without a root,
 * every claimant's, so more at once only queue: 100 at once took 40 s each on previewnet, 10 took 2.6 s.
 */
const CREDITS_READ_CONCURRENCY = 10;
/** Players the run reads until the game's credits have roots; the others are read once they have. */
const CREDITS_SAMPLE = 10;

/** One player's credits of the game, counted as the app counts them, and the claims it can make now. */
interface CreditsRead {
  player: Player;
  credits: GameCredits;
  claims: Array<Claim & { hash: string }>;
}

/** Tops every claiming player up to `ASSET_HUB_FUNDS` on Asset Hub: as root on a fork, else from the funder. */
async function fundOnAssetHub(api: AssetHubApi, target: Target, players: Player[]): Promise<void> {
  const accounts = await api.query.System.Account.getValues(players.map((player) => [player.address]), { at: "best" });
  const short = players.filter((_, position) => accounts[position].data.free < ASSET_HUB_FUNDS);
  if (short.length === 0) return;
  // Without a root key the funder pays, and must cover every player before the first transfer.
  const funder = target.sudo ? undefined : requireFunder(target);
  if (funder) {
    const needed = BigInt(short.length) * ASSET_HUB_FUNDS + ASSET_HUB_FUNDS;
    const available = (await api.query.System.Account.getValue(funder.address, { at: "best" })).data.free;
    if (available < needed) {
      throw new Error(
        `${funder.address} has ${Number(available) / 1e10} UNIT on ${target.label}'s Asset Hub; send it at least ${Math.ceil(Number(needed - available) / 1e10)} UNIT more`,
      );
    }
  }
  for (let start = 0; start < short.length; start += 500) {
    const chunk = short.slice(start, start + 500);
    const tx = funder
      ? api.tx.Utility.batch_all({
          calls: chunk.map((player) => api.tx.Balances.transfer_keep_alive({ dest: Enum("Id", player.address), value: ASSET_HUB_FUNDS }).decodedCall),
        })
      : api.tx.Sudo.sudo({
          call: api.tx.Utility.batch_all({
            calls: chunk.map((player) => api.tx.Balances.force_set_balance({ who: Enum("Id", player.address), new_free: ASSET_HUB_FUNDS }).decodedCall),
          }).decodedCall,
        });
    const signer: Keypair = funder ?? target.sudo!;
    const included = await submitToBestBlock(tx, signer);
    console.log(`[claim] funded ${Math.min(start + 500, short.length)}/${short.length} on Asset Hub in #${included.block.number}`);
  }
}

/** Every claimable collection the nfts SDK approves for `target`'s network, ascending by id, as the chest offers them. */
async function readChestCollections(chain: ClaimsChain, target: Target): Promise<number[]> {
  const approved = new Set(getApprovedCollections(APP_NETWORKS[target.network]));
  const chestCollections: number[] = [];
  let fromId: number | undefined;
  for (;;) {
    const result = await getClaimableCollections(chain, fromId === undefined ? {} : { fromId });
    if (!result.ok) throw new Error(`claimable collections: ${result.error.message}`);
    chestCollections.push(...result.value.collections.map((collection) => collection.id).filter((id) => approved.has(id)));
    if (result.value.nextId === null) return chestCollections.sort((left, right) => left - right);
    fromId = result.value.nextId;
  }
}

/**
 * Waits for the credits game `gameIndex` awarded the players to arrive on Asset Hub, counted as
 * the app counts them, then has every player claim its own one at a time, each into the
 * collection the chest shows it in and to a fresh purse key, as the stash does after the game.
 * `sinceBlock` is the People block of the game's first report.
 */
export async function claimCredits(
  target: Target,
  people: AppPeopleClient,
  players: Player[],
  gameIndex: number,
  sinceBlock: number,
  connections: number,
  pool: SigningPool,
): Promise<ClaimResult> {
  const { client, api } = connectAssetHub(target);
  const chain = claimsChain(people, client);
  const started = Date.now();
  // The read the app's `readGameCredits` makes, counted as it counts, except that a credit with no
  // root counts only from the game's reports on: an earlier award block whose every credit was
  // claimed loses its tree, and its credits read as rootless too.
  const readCredits = (player: Player): Promise<CreditsRead> =>
    retry(CREDITS_READ_ATTEMPTS, 0, async () => {
      const read = getClaims(chain, { claimant: { tag: "Account", address: player.address }, individualityAt: "best", signal: AbortSignal.timeout(CREDITS_READ_MS) });
      const result = await withTimeout(read, CREDITS_READ_MS, `claims of ${player.address}`);
      if (!result.ok) throw new Error(`claims of ${player.address}: ${result.error.message}`);
      const runClaims = result.value.claims.filter((claim) => claim.gameIndex !== null || claim.awardBlock >= sinceBlock);
      const claims = runClaims.filter(
        (claim): claim is Claim & { hash: string } => claim.gameIndex === gameIndex && claim.state === "claimable" && claim.hash !== null,
      );
      return { player, credits: gameCredits(runClaims, gameIndex, true), claims };
    });
  const readPlayers = (selected: Player[]) => readAll(selected, readCredits, CREDITS_READ_CONCURRENCY);
  const countCredits = (reads: CreditsRead[]) => {
    const sum = (pick: (credits: GameCredits) => number) => reads.reduce((total, read) => total + pick(read.credits), 0);
    return { awarded: sum((credits) => credits.total), claimable: sum((credits) => credits.claimable), pending: sum((credits) => credits.pending) };
  };
  const waiting = (reads: CreditsRead[]) => {
    const { awarded, claimable, pending } = countCredits(reads);
    console.log(`[claim] ${claimable}/${awarded} credits of ${reads.length} players claimable after ${Math.round((Date.now() - started) / 1000)} s`);
    return (awarded === 0 || pending > 0) && Date.now() - started <= CLAIMABLE_WAIT_MS;
  };
  try {
    // A game's credits get their roots together, so a few players show when every player's have.
    const sample = players.slice(0, CREDITS_SAMPLE);
    let reads = await readPlayers(sample);
    while (waiting(reads)) {
      await sleep(12_000);
      reads = await readPlayers(sample);
    }
    reads = await readPlayers(players);
    while (waiting(reads)) {
      await sleep(12_000);
      const again = new Map((await readPlayers(reads.filter((read) => read.credits.pending > 0).map((read) => read.player))).map((read) => [read.player, read]));
      reads = reads.map((read) => again.get(read.player) ?? read);
    }
    const { awarded, claimable } = countCredits(reads);
    const claimableAfterMs = Date.now() - started;
    const collections = await readChestCollections(chain, target);
    if (collections.length === 0 || claimable === 0) return { awarded, claimable, claimableAfterMs, collections, burst: null, claimed: 0, playerMs: null };

    const claimants = reads.filter((read) => read.claims.length > 0);

    await fundOnAssetHub(api, target, claimants.map((read) => read.player));
    const nonces = await api.query.System.Account.getValues(claimants.map((read) => [read.player.address]), { at: "best" });
    const txs = claimants.map(({ player, claims }) =>
      claims.map((claim) =>
        api.tx.NftClaims.claim({
          claimant: Enum("Account"),
          block: claim.awardBlock,
          credit: claim.hash as SizedHex<32>,
          leaf_index: claim.leafIndex!,
          proof: claim.proof! as SizedHex<32>[],
          collection: defaultCollectionFor(claim.hash, collections)!,
          // A purse key takes one NFT, so every claim mints to a key of its own.
          mint_to: derivePlayer(`${player.address}/nft/${claim.awardBlock}`, claim.leafIndex!).address,
        }),
      ),
    );
    const creators = claimants.map(({ player }) => accountSigner(player));
    // Signed up front: one process signs for every player, which a phone does for itself only.
    const flat = await pool.sign(
      claimants.flatMap(({ player }, index) =>
        txs[index].map((tx, offset) => ({ player, chain: "assetHub" as const, signer: "account" as const, tx, nonce: nonces[index].nonce + offset })),
      ),
      "claim",
    );
    let taken = 0;
    const signed = txs.map((own) => flat.slice(taken, (taken += own.length)));
    // `system_accountNextIndex` counts the pool's pending transactions, which a storage read doesn't.
    const readNonce = (address: SS58String): Promise<number> =>
      retry(3, 2_000, () => withTimeout(client._request<number, [string]>("system_accountNextIndex", [address]), 15_000, "nonce read"));
    const playerMs = new Histogram();
    // As the stash claims: one claim at a time, the next once the previous is in a block.
    const lanes = claimants.map(
      ({ player }, index): Lane =>
        async (submit) => {
          const started = Date.now();
          const own = signed[index];
          for (let next = 0; next < own.length; next++) {
            if (await submit(own[next])) continue;
            // A failed claim leaves the following ones at the wrong nonce: sign them again at the chain's.
            const nonce = await readNonce(player.address);
            for (let later = next + 1; later < own.length; later++) {
              own[later] = await withTimeout(signEntry({ creator: creators[index], tx: txs[index][later], nonce: nonce + later - next - 1 }), 30_000, "signing");
            }
          }
          playerMs.add(Date.now() - started);
        },
    );
    console.log(`[claim] ${claimants.length} players claim ${claimable} credits, each one at a time`);
    // A claim counts once it executed in its block; which credits were claimed is read from Asset Hub after.
    const burst = await submitLanes(lanes, api, client, [target.assetHubRpc!], connections, () => Number.POSITIVE_INFINITY, { progress: "claim" });
    // Not `getClaims`: once every leaf of an award block is claimed Asset Hub deletes its tree, and
    // `getClaims` then shows the block's credits as earned in no game. The leaf ledger stays.
    const claimSubmissions = claimants.flatMap(({ claims }) => claims);
    const blocks = [...new Set(claimSubmissions.map((claim) => claim.awardBlock))];
    const ledgers = await api.query.NftClaims.ClaimedLeaves.getValues(blocks.map((block) => [block]), { at: "best" });
    const ledgerOf = new Map(blocks.map((block, position) => [block, ledgers[position]]));
    const claimed = claimSubmissions.filter((claim) => ((ledgerOf.get(claim.awardBlock)?.[claim.leafIndex! >> 3] ?? 0) >> (claim.leafIndex! & 7)) & 1).length;
    console.log(`[claim] ${burst.ok}/${burst.submitted} claims executed in ${burst.durationMs} ms; ${claimed}/${claimable} credits claimed on chain`);
    return { awarded, claimable, claimableAfterMs, collections, burst: summarizeBurst(burst), claimed, playerMs: playerMs.summary() };
  } finally {
    client.destroy();
  }
}
