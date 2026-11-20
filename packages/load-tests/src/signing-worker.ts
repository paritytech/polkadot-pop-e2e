// A `SigningPool` thread: signs the jobs the pool posts, over its own connections to the chains.
import { parentPort, workerData } from "node:worker_threads";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { withScoreParticipant } from "@parity/product-sdk-individuality";
import { accountSigner, hostSigner, signEntry } from "./burst.js";
import { signSignUp } from "./join.js";
import { playerFromSecret, type Player } from "./keys.js";
import type { SignerKind, SigningJob, SigningOutcome, SigningReply } from "./signing-pool.js";
import { connectAssetHub, connectPeople, type AssetHubApi, type Endpoints, type PeopleConnection } from "./target.js";

const endpoints = workerData as Endpoints;
let people: PeopleConnection | undefined;
let assetHub: { api: AssetHubApi } | undefined;

function creatorOf(player: Player, kind: SignerKind): CommonSignerTxCreator {
  if (kind === "account") return accountSigner(player);
  return kind === "host" ? hostSigner(player) : withScoreParticipant(hostSigner(player));
}

async function runJob(job: SigningJob): Promise<SigningOutcome> {
  const player = playerFromSecret(job.index, job.secretKey);
  if (job.kind === "signUp") return signSignUp((people ??= connectPeople(endpoints)).engine, player);
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
