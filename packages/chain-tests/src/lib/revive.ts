import { Binary, type TypedApi } from "polkadot-api";
import type { Paseo } from "@triangle-e2e/papi";
import { isAddress, type Address } from "viem";

type AssetHubApi = TypedApi<Paseo>;

export interface ReviveCallResult {
  isOk: boolean;
  data: `0x${string}`;
  flags: bigint;
}

function convertToHexString(value: unknown): `0x${string}` {
  if (!value) return "0x";
  if (typeof (value as any)?.asHex === "function") return (value as any).asHex();
  if (typeof (value as any)?.toHex === "function") return (value as any).toHex();
  if (value instanceof Uint8Array) {
    return ("0x" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  }
  return "0x";
}

function normalizeFlags(flags: any): bigint {
  try {
    if (typeof flags === "bigint") return flags;
    if (typeof flags === "number") return BigInt(flags);
    if (typeof flags === "string") return BigInt(flags);
    if (flags && typeof (flags as any).toString === "function") return BigInt((flags as any).toString());
    return 0n;
  } catch {
    return 0n;
  }
}

const DRY_RUN_STORAGE_LIMIT = 18446744073709551615n;
const DRY_RUN_WEIGHT_LIMIT = {
  ref_time: 18446744073709551615n,
  proof_size: 18446744073709551615n,
};

export async function performDryRunCall(
  api: AssetHubApi,
  originSubstrateAddress: string,
  contractAddress: Address,
  value: bigint,
  encodedData: `0x${string}`,
): Promise<ReviveCallResult> {
  const result = await api.apis.ReviveApi.call(
    originSubstrateAddress,
    Binary.fromHex(contractAddress),
    value,
    DRY_RUN_WEIGHT_LIMIT,
    DRY_RUN_STORAGE_LIMIT,
    Binary.fromHex(encodedData),
  );

  const executionResult = (result as any).result;
  const ok =
    executionResult?.success !== undefined
      ? executionResult.success
        ? executionResult.value
        : null
      : executionResult?.ok ?? (executionResult?.isOk ? executionResult.value : null);

  const flags = normalizeFlags(ok?.flags);
  const data = convertToHexString(ok?.data);
  const didRevert = ok ? (flags & 1n) === 1n : true;

  return {
    isOk: !!ok && !didRevert,
    data,
    flags,
  };
}
