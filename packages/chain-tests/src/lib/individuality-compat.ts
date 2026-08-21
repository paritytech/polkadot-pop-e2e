/**
 * individuality v0.12.0 reshaped two Asset Hub surfaces the tests read; these
 * helpers speak both worlds so one suite serves previewnet (v0.12.0) and
 * paseo-next-v2 (v0.11.2), and nothing here needs touching when pnv2 upgrades.
 *
 *   - `MembersSubscriber.RingRoots` grew a leading `generation` key (its live
 *     prefix is `CurrentGeneration`); pre-v0.12 it was (identifier, ring_index).
 *   - `AliasAccounts.AliasFee` moved from storage to an `Option<Balance>`
 *     runtime constant.
 *
 * Reads go through `getUnsafeApi()` deliberately: it encodes against the LIVE
 * runtime metadata, so the same code adapts per chain, with the shape probe
 * being "does the v0.12 entry exist" (a missing entry throws synchronously on
 * lookup, an existing one decodes).
 */

import { type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";

/**
 * v0.12 replaced the raw 32-byte allowance contexts with hashed "product
 * contexts": blake2_256("product/peopl.<networkSuffix>/" ++ suffix32), where
 * suffix32 = "sys/" ++ u32le(family) ++ u32le(a) ++ (u32le(b) | u8(b)).
 * Families: 1 resources-notification, 2 statement-store slot, 3 long-term
 * storage, 4 PGAS claim. The network suffix is a per-network runtime param —
 * "test" on previewnet, "paseo" on pnv2 once it takes v0.12.
 */
function productContext(
  networkSuffix: string,
  family: number,
  a: number,
  b: number,
  tail: "u32" | "u8",
): Uint8Array {
  const enc = new TextEncoder();
  const suffix = new Uint8Array(32);
  suffix.set(enc.encode("sys/"), 0);
  new DataView(suffix.buffer).setUint32(4, family, true);
  new DataView(suffix.buffer).setUint32(8, a, true);
  if (tail === "u32") new DataView(suffix.buffer).setUint32(12, b, true);
  else suffix[12] = b & 0xff;
  const head = enc.encode(`product/peopl.${networkSuffix}/`);
  const preimage = new Uint8Array(head.length + 32);
  preimage.set(head, 0);
  preimage.set(suffix, head.length);
  return blake2b256(preimage);
}

export const pgasContextV012 = (networkSuffix: string, day: number, slot: number) =>
  productContext(networkSuffix, 4, day, slot, "u32");
export const longTermStorageContextV012 = (networkSuffix: string, period: number, counter: number) =>
  productContext(networkSuffix, 3, period, counter, "u8");
export const stmtStoreContextV012 = (networkSuffix: string, period: number, seq: number) =>
  productContext(networkSuffix, 2, period, seq, "u32");

/**
 * Whether this chain's runtime uses the v0.12 product-context format (and the
 * generation-keyed RingRoots). Version-gated per spec name; unknown chains
 * report false (legacy).
 */
export async function usesProductContexts(client: PolkadotClient): Promise<boolean> {
  const v = (await client.getUnsafeApi().apis.Core.version()) as {
    spec_name: string;
    spec_version: number;
  };
  const name = String(v.spec_name);
  const spec = Number(v.spec_version);
  if (name === "next-asset-hub-paseo") return spec >= 2_000_038;
  if (name === "next-people-paseo") return spec >= 1_000_035;
  return false;
}

export interface RingCommitmentRecord {
  revision: number;
}

/**
 * The AH RingRoots window for (collection, ringIndex) — v0.12's generation
 * prefix applied when the runtime has one. Keys are passed as plain hex
 * strings (what the [u8;32] codec accepts); revisions are coerced to number
 * so callers' `===` comparisons hold whatever width the record fields decode
 * to (some are u64 → BigInt).
 */
export async function ringRootsWindow(
  client: PolkadotClient,
  collectionHex: string,
  ringIndex: number,
): Promise<RingCommitmentRecord[]> {
  const u = client.getUnsafeApi();
  let records: { revision: number | bigint }[] | undefined;
  try {
    const generation = await u.query.MembersSubscriber.CurrentGeneration.getValue();
    records = (await u.query.MembersSubscriber.RingRoots.getValue(
      generation,
      collectionHex,
      ringIndex,
    )) as typeof records;
  } catch {
    // Pre-v0.12: no CurrentGeneration, two-key map.
    records = (await u.query.MembersSubscriber.RingRoots.getValue(
      collectionHex,
      ringIndex,
    )) as typeof records;
  }
  return (records ?? []).map((r) => ({ revision: Number(r.revision) }));
}

/**
 * The PGAS fee an alias registration burns. v0.12: an `Option<Balance>`
 * constant (undefined = ops never set it, registrations fail AliasFeeUnset);
 * pre-v0.12: a storage value with the same unset semantics.
 */
export async function aliasFee(client: PolkadotClient): Promise<bigint | undefined> {
  const u = client.getUnsafeApi();
  try {
    return (await u.constants.AliasAccounts.AliasFee()) as bigint | undefined;
  } catch {
    try {
      return (await u.query.AliasAccounts.AliasFee.getValue()) as bigint | undefined;
    } catch {
      // v0.12 exposes the fee neither as a constant (no #[pallet::constant]) nor
      // as storage — unreadable; callers measure the burn post-hoc.
      return undefined;
    }
  }
}
