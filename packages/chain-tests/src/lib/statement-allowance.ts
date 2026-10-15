/**
 * Statement-store allowance claim, done the way a truapi host does it:
 * `Resources.set_statement_store_account(period, seq, target)` in the first
 * free slot of the day, authorized by an `AsResources::RegisterStatementStoreAllowance`
 * ring-VRF proof bound to that slot's context. The target is a separate
 * per-product key, which then signs the statements.
 */
import { getSs58AddressInfo, type PolkadotClient, type SS58String } from "polkadot-api";
import { toHex } from "polkadot-api/utils";
import { asResources, createClaimSigner } from "./claim-signer.js";
import type { PeopleApi } from "./client.js";
import { productContextSuffix, stmtStoreContextV012 } from "./individuality-compat.js";
import { stmtStoreContext, dayFromTimestamp } from "./allowances.js";
import { isRetryableInvalidTx, submitPeopleClaim } from "./people-claim.js";
import { ringExponent, takeRingSnapshot, waitForInclusion } from "./ring.js";
import { getCachedRingLocation } from "./ring-cascade.js";
import { verifiableFor } from "./verifiable-loader.js";
import type { AttestedCredentials } from "./credentials.js";
import { personRingEntropy } from "./truapi-identity.js";

const MAX_PROOF_ATTEMPTS = 3;

export interface StatementAllowance {
  period: number;
  seq: number;
  /** False when the target already held a slot this period. */
  claimed: boolean;
}

/** `Resources.StatementStoreAllowances` keys the period as big-endian bytes. */
const periodKey = (period: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, period, false);
  return toHex(b);
};

const publicKeyOf = (address: SS58String | undefined) => {
  const info = address ? getSs58AddressInfo(address) : undefined;
  return info?.isValid ? toHex(info.publicKey) : undefined;
};

/** Registers `target` for a statement-store allowance from `creds`' lite personhood. */
export async function claimStatementAllowance(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  creds: Pick<AttestedCredentials, "entropy" | "networkSuffix">,
  target: SS58String,
): Promise<StatementAllowance> {
  const entropy = personRingEntropy(creds);
  const { ringIndex } =
    getCachedRingLocation() ??
    (await waitForInclusion(peopleApi, "LitePeople", entropy, { peopleClient }));
  // Hosts take the period from their own clock.
  const period = dayFromTimestamp(Math.floor(Date.now() / 1000));
  const suffix = await productContextSuffix(peopleClient);
  const contextFor = (seq: number) =>
    suffix ? stmtStoreContextV012(suffix, period, seq) : stmtStoreContext(period, seq);

  const { alias_in_context } = verifiableFor();
  const targetKey = publicKeyOf(target);
  const slots = await peopleApi.view.Resources.get_lite_stmt_store_slots_per_period();
  // Every slot is read: the target may hold one past the first free slot.
  let seq: number | undefined;
  for (let s = 0; s < slots; s++) {
    const alias = toHex(alias_in_context(entropy, contextFor(s)));
    const entry = await peopleApi.query.Resources.StatementStoreAllowances.getValue(periodKey(period), alias);
    if (entry && publicKeyOf(entry.account_id) === targetKey) return { period, seq: s, claimed: false };
    if (!entry && seq === undefined) seq = s;
  }
  if (seq === undefined) throw new Error(`[stmt-allowance] all ${slots} slots of period ${period} are taken`);

  const context = contextFor(seq);
  const exponent = await ringExponent(peopleApi, "LitePeople");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
    const snap = await takeRingSnapshot(peopleApi, peopleClient, ringIndex);
    console.log(
      `[stmt-allowance] attempt=${attempt} period=${period} seq=${seq} ring=${ringIndex} rev=${snap.revisionIndex}`,
    );

    const signer = createClaimSigner({
      extensionName: "AsResources",
      context,
      verifiableEntropy: entropy,
      encodedMembers: snap.encodedMembers,
      ringExponent: exponent,
      extensionValue: asResources("RegisterStatementStoreAllowance", {
        ringIndex,
        revision: snap.revisionIndex,
        collection: "LitePeople",
      }),
    });
    const tx = peopleApi.tx.Resources.set_statement_store_account({ period, seq, target_account: target });
    try {
      const result = await submitPeopleClaim(tx, signer);
      if (!result.ok) throw new Error(`[stmt-allowance] claim failed in block #${result.block}`);
      // Hosts confirm the slot now holds the target before using it.
      const alias = toHex(alias_in_context(entropy, context));
      const entry = await peopleApi.query.Resources.StatementStoreAllowances.getValue(periodKey(period), alias, {
        at: result.blockHash,
      });
      if (publicKeyOf(entry?.account_id) !== targetKey) {
        throw new Error(`[stmt-allowance] slot ${seq} holds ${entry?.account_id ?? "nothing"}, not ${target}`);
      }
      return { period, seq, claimed: true };
    } catch (err) {
      lastErr = err;
      if (!isRetryableInvalidTx(err) || attempt === MAX_PROOF_ATTEMPTS) throw err;
    }
  }
  throw lastErr;
}
