import {
  AccountId,
  Binary,
  createClient,
  type PolkadotClient,
  type PolkadotSigner,
  type TxBroadcastEvent,
  type TypedApi,
} from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { previewPeople } from "@pop-e2e/papi";
import { blake2AsHex } from "@polkadot/util-crypto";
import { verifiableFor } from "./verifiable-loader.js";

type CoinageApi = TypedApi<typeof previewPeople>;
type LoadArgs = Parameters<CoinageApi["tx"]["Coinage"]["load_recycler_with_external_asset_unpaid"]>[0];
type LoadOptions = NonNullable<Parameters<ReturnType<CoinageApi["tx"]["Coinage"]["load_recycler_with_external_asset_unpaid"]>["sign"]>[1]>;

function integerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
}

// Adapted from triangle-e2e PR #43. Amounts stay in integer asset units.
export function coinValueToAssetAmount(value: number, unit: bigint, min: number, max: number): bigint {
  integerInRange("minimum exponent", min, -128, 127);
  integerInRange("maximum exponent", max, min, 127);
  integerInRange("denomination", value, min, max);
  if (unit <= 0n) throw new Error("asset unit must be positive");
  const divisor = value < 0 ? 1n << BigInt(-value) : 1n;
  if (unit % divisor !== 0n) throw new Error("denomination would truncate the asset amount");
  const amount = value < 0 ? unit / divisor : unit << BigInt(value);
  if (amount >= 1n << 128n) throw new Error("asset amount exceeds u128");
  return amount;
}

export function unpaidTopUpOptions(nonce: number): LoadOptions {
  integerInRange("nonce", nonce, 0, 0xffff_ffff);
  return {
    nonce,
    customSignedExtensions: {
      VerifyMultiSignature: { value: { type: "Disabled", value: undefined } },
      AsPerson: { value: undefined },
      AsProofOfInkParticipant: { value: undefined },
      ScoreAsParticipant: { value: undefined },
      GameAsInvited: { value: undefined },
      PeopleLiteAuth: { value: undefined },
      AsMember: { value: undefined },
      AsCoinage: { value: { type: "InfallibleUnpaidSigned", value: { nonce } } },
      AsResources: { value: undefined },
      HonourAuth: { value: undefined },
      RestrictOrigins: { value: false },
    },
  };
}

/** Coin ownership authorizes the claim; it does not spend an account nonce. */
export function coinClaimOptions(): LoadOptions {
  const options = unpaidTopUpOptions(0);
  return {
    ...options,
    customSignedExtensions: {
      ...options.customSignedExtensions,
      AsCoinage: { value: { type: "AsCoin", value: undefined } },
    },
  };
}

/** The voucher secret is independent of the account signing the load. */
export function topUpArguments(
  instanceId: number, value: number, address: string, voucherEntropy: Uint8Array,
): LoadArgs {
  integerInRange("instance id", instanceId, 0, 0xffff_ffff);
  integerInRange("denomination", value, -128, 127);
  if (voucherEntropy.length !== 32) throw new Error("voucher entropy must be 32 bytes");
  const crypto = verifiableFor();
  return {
    instance_id: instanceId,
    preservation: { type: "Expendable", value: undefined },
    value,
    member_key: Binary.toHex(crypto.member_from_entropy(voucherEntropy)),
    proof_of_ownership: Binary.toHex(crypto.sign(voucherEntropy, AccountId().enc(address))),
  };
}

export interface PreparedTopUp {
  signed: Uint8Array;
  txHash: string;
  address: string;
  instanceId: number;
  denomination: number;
  memberKey: string;
  amount: bigint;
  nonce: number;
  at: string;
}

export interface SubmissionResult {
  txHash: string;
  status: "finalized" | "dispatch-error" | "submission-error" | "unresolved";
  elapsedMs: number;
  block?: { hash: string; number: number; index: number };
  error?: unknown;
  observations: Array<{ elapsedMs: number; event: TxBroadcastEvent }>;
}

/** No retries: a timeout is unresolved, not proof that the transaction was dropped. */
export function watchTopUp(
  client: Pick<PolkadotClient, "submitAndWatch">,
  prepared: Pick<PreparedTopUp, "signed" | "txHash">,
  timeoutMs = 600_000,
): Promise<SubmissionResult> {
  integerInRange("timeout milliseconds", timeoutMs, 1, 2_147_483_647);
  return new Promise((resolve) => {
    const started = performance.now();
    const observations: SubmissionResult["observations"] = [];
    let subscription: { unsubscribe(): void } | undefined;
    let settled = false;
    const finish = (result: Pick<SubmissionResult, "status" | "block" | "error">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      resolve({ txHash: prepared.txHash, elapsedMs: performance.now() - started, observations, ...result });
    };
    const timer = setTimeout(() => finish({ status: "unresolved" }), timeoutMs);
    try {
      subscription = client.submitAndWatch(prepared.signed).subscribe({
        next(event) {
          observations.push({ elapsedMs: performance.now() - started, event });
          if (event.type === "finalized") {
            finish({ status: event.ok ? "finalized" : "dispatch-error", block: event.block, error: event.dispatchError });
          }
        },
        error(error: unknown) {
          finish({ status: "submission-error", error: error instanceof Error ? error.message : error });
        },
        complete() { finish({ status: "unresolved" }); },
      });
      // Observable producers may complete synchronously, before assignment.
      if (settled) subscription.unsubscribe();
    } catch (error) {
      finish({ status: "submission-error", error: error instanceof Error ? error.message : error });
    }
  });
}

// The same tracker applies to any prepared Coinage transaction.
export const watchCoinageTransaction = watchTopUp;

/** Chain client only. The caller owns funding, voucher secrets and the workload. */
export function createCoinageClient(endpoint: string) {
  const client = createClient(getWsProvider(endpoint));
  // Compatibility is checked against the repository's PreviewNet descriptors.
  const api = client.getTypedApi(previewPeople);
  return {
    client,
    api,
    async prepareTopUp(input: {
      instanceId: number;
      denomination: number;
      signer: PolkadotSigner;
      voucherEntropy: Uint8Array;
      nonce?: number;
    }): Promise<PreparedTopUp> {
      const address = AccountId().dec(input.signer.publicKey);
      const args = topUpArguments(input.instanceId, input.denomination, address, input.voucherEntropy);
      const { hash: at } = await client.getFinalizedBlock();
      const [instance, min, max, account] = await Promise.all([
        api.query.Coinage.Instances.getValue(input.instanceId, { at }),
        api.constants.Coinage.MinimumExponent(),
        api.constants.Coinage.MaximumExponent(),
        api.query.System.Account.getValue(address, { at }),
      ]);
      if (!instance) throw new Error(`Coinage instance ${input.instanceId} does not exist`);
      const amount = coinValueToAssetAmount(input.denomination, instance.asset_unit, min, max);
      const nonce = input.nonce ?? account.nonce;
      const signed = await api.tx.Coinage.load_recycler_with_external_asset_unpaid(args).sign(
        input.signer, { ...unpaidTopUpOptions(nonce), at },
      );
      return { signed, txHash: blake2AsHex(signed), address, instanceId: input.instanceId,
        denomination: input.denomination, memberKey: args.member_key, amount, nonce, at };
    },
    submitTopUp(prepared: PreparedTopUp, timeoutMs?: number) {
      return watchTopUp(client, prepared, timeoutMs);
    },
    close() { client.destroy(); },
  };
}
