import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  type Abi,
  type Address,
} from "viem";
import type { TypedApi } from "polkadot-api";
import type { Paseo } from "@triangle-e2e/papi";
import { performDryRunCall } from "./revive.js";

type AssetHubApi = TypedApi<Paseo>;

export async function performContractCall<T>(
  api: AssetHubApi,
  originSubstrateAddress: string,
  contractAddress: Address,
  abi: Abi,
  functionName: string,
  args: any[],
): Promise<T> {
  const encodedData = encodeFunctionData({
    abi,
    functionName: functionName as any,
    args,
  });

  const call = await performDryRunCall(
    api,
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
    functionName: functionName as any,
    data: call.data,
  });

  return (Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : decoded) as unknown as T;
}
