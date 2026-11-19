// A `SigningPool` thread: signs the jobs the pool posts, over its own connections to the chains.
import { parentPort, workerData } from "node:worker_threads";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { ringCollectionId, withScoreParticipant } from "@parity/product-sdk-individuality";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { localAirdropVrfSigner } from "@parity/product-sdk-individuality/testing";
import { accountSigner, hostSigner, signEntry } from "./burst.js";
import { bindSeat, signSignUp } from "./join.js";
import { playerFromSecret, type Player } from "./keys.js";
import { RingSnapshots } from "./lite.js";
import type { OutcomeOf, SignerKind, SigningJob, SigningReply } from "./signing-pool.js";
import { connectAssetHub, connectPeople, type AssetHubApi, type Endpoints, type PeopleConnection } from "./target.js";
import { createProofQueue, proveTurnNow } from "./video/turn.js";

const endpoints = workerData as Endpoints;
let people: PeopleConnection | undefined;
let assetHub: { api: AssetHubApi } | undefined;
let snapshots: RingSnapshots | undefined;
const proveInTurn = createProofQueue();

function creatorOf(player: Player, kind: SignerKind): CommonSignerTxCreator {
  if (kind === "account") return accountSigner(player);
  return kind === "host" ? hostSigner(player) : withScoreParticipant(hostSigner(player));
}

/** The lite key of `liteEntropy` over this thread's People connection. */
function liteProver(connection: PeopleConnection, liteEntropy: Uint8Array) {
  snapshots ??= new RingSnapshots(connection.api, connection.client);
  return snapshots.prover(liteEntropy);
}

async function runJob(job: SigningJob): Promise<OutcomeOf<SigningJob>> {
  if (job.kind === "turnProof") {
    const prover = liteProver((people ??= connectPeople(endpoints)), job.liteEntropy);
    return proveInTurn(() => proveTurnNow(prover, { productId: job.productId, genesis: job.genesis, collectionId: ringCollectionId, hash: blake2b256 }));
  }
  const { index, secretKey, liteEntropy } = job.player;
  const player: Player = { ...playerFromSecret(index, secretKey), liteEntropy };
  if (job.kind === "signUp" || job.kind === "bind") {
    const connection = (people ??= connectPeople(endpoints));
    const personhood = player.liteEntropy ? liteProver(connection, player.liteEntropy) : undefined;
    if (job.kind === "bind") return bindSeat(connection.engine, player, personhood);
    return signSignUp(connection.engine, player, { personhood, signVrf: job.drawTicket ? localAirdropVrfSigner(secretKey).signVrf : undefined });
  }
  const tx =
    job.chain === "people"
      ? await (people ??= connectPeople(endpoints)).api.txFromCallData(job.callData)
      : await (assetHub ??= connectAssetHub(endpoints)).api.txFromCallData(job.callData);
  return { extrinsic: await signEntry({ creator: creatorOf(player, job.signer), tx, nonce: job.nonce }) };
}

const reply = (message: SigningReply) => parentPort!.postMessage(message);

parentPort!.on("message", async ({ id, job }: { id: number; job: SigningJob }) => {
  try {
    reply({ id, ...(await runJob(job)) });
  } catch (error) {
    reply({ id, error: (error as Error).message });
  }
});
