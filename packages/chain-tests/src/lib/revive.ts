import { Binary, type PolkadotClient } from "polkadot-api";
import { type Address } from "viem";
import type { AssetHubApi } from "./client.js";

export interface ReviveCallResult {
  isOk: boolean;
  data: `0x${string}`;
  flags: number;
}

const DRY_RUN_STORAGE_LIMIT = 18446744073709551615n;
const DRY_RUN_WEIGHT_LIMIT = {
  ref_time: 18446744073709551615n,
  proof_size: 18446744073709551615n,
};

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return ("0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

export async function performDryRunCall(
  api: AssetHubApi,
  client: PolkadotClient,
  originSubstrateAddress: string,
  contractAddress: Address,
  value: bigint,
  encodedData: `0x${string}`,
): Promise<ReviveCallResult> {
  // Pass an explicit `{ at }` so PAPI doesn't try to guess options from the
  // last positional arg. PAPI 2.1.2's `isOptionalArg` returns true for any
  // object with no own-enumerable properties — `Binary.fromHex("0x")`
  // (empty Uint8Array) qualifies, gets misread as options, and `at` ends up
  // bound to `Uint8Array.prototype.at` (a function). That function flows
  // through chainHead and trips a confusing `BlockNotPinnedError` /
  // `Invalid params` error pair. See
  // docs/issues/papi-isOptionalArg-misclassifies-empty-binary.md.
  const fin = await client.getFinalizedBlock();
  const result = await api.apis.ReviveApi.call(
    originSubstrateAddress,
    contractAddress,
    value,
    DRY_RUN_WEIGHT_LIMIT,
    DRY_RUN_STORAGE_LIMIT,
    Binary.fromHex(encodedData),
    { at: fin.hash },
  );

  // PAPI 2.x types `result.result` as `ResultPayload<{flags,data},Module>`,
  // i.e. `{ success: true, value } | { success: false, value }`. Discriminate.
  if (!result.result.success) {
    return { isOk: false, data: "0x", flags: 0 };
  }
  const ok = result.result.value;
  // Bit 0 of flags = "reverted". Caller treats either revert or non-success
  // identically — both surface as a thrown error in `performContractCall`.
  const didRevert = (ok.flags & 1) === 1;
  return {
    isOk: !didRevert,
    data: bytesToHex(ok.data),
    flags: ok.flags,
  };
}
