import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  type Abi,
  type Address,
} from "viem";
import type { PolkadotClient } from "polkadot-api";
import type { AssetHubApi } from "./client.js";
import { performDryRunCall } from "./revive.js";

/**
 * Generic ABI dispatch helper. We accept `abi: Abi` (the wide viem type),
 * which means viem's `decodeFunctionResult` returns `unknown` — there's no
 * compile-time link between the runtime ABI and TS. The caller declares
 * the expected return via the `T` generic (`performContractCall<bigint>`)
 * and the final `as T` is an *explicit trust boundary*: the caller is
 * vouching that the ABI they passed truly returns this shape. If you want
 * stronger typing at a specific call site, narrow the ABI to `as const`
 * and use viem's `readContract` directly instead.
 */
export async function performContractCall<T>(
  api: AssetHubApi,
  client: PolkadotClient,
  originSubstrateAddress: string,
  contractAddress: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
): Promise<T> {
  const encodedData = encodeFunctionData({
    abi,
    functionName,
    args,
  });

  const call = await performDryRunCall(
    api,
    client,
    originSubstrateAddress,
    contractAddress,
    0n,
    encodedData,
  );

  if (!call.isOk) {
    let revertReason: string = call.data;
    try {
      const decoded = decodeErrorResult({ abi, data: call.data });
      revertReason = decoded.args
        ? `${decoded.errorName}(${decoded.args.map(String).join(", ")})`
        : decoded.errorName;
    } catch {
      // Unknown error selector — fall back to raw hex
    }
    throw new Error(`Contract reverted: ${revertReason}`);
  }

  const decoded = decodeFunctionResult({
    abi,
    functionName,
    data: call.data,
  });

  // Solidity ABI returns are always tuples; viem unwraps single-element
  // tuples to scalars only when typing knows the ABI literally. With the
  // wide `Abi` we get a tuple back regardless, so unwrap manually.
  const unwrapped =
    Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : decoded;
  return unwrapped as T;
}
