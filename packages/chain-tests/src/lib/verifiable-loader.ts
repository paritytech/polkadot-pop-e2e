/**
 * Network-aware loader for verifiablejs. Bandersnatch signatures + ring-VRF
 * proofs flipped between two formats when individuality bumped its
 * `verifiable` crate rev for v0.7.0 (commit `05719ba` on the verifiable
 * repo, "Bump ark-vrf version and use ThinVRF for plain signature"):
 *
 *   - `verifiablejs@1.2.0` — paseo-next-v2 (v0.6.5): 96-byte sigs,
 *     pre-ThinVRF; `one_shot(entropy, members, ctx, msg)` signature.
 *   - vendored `verifiablejs-thinvrf` — previewnet (v0.7.0): 64-byte sigs,
 *     ThinVRF; `one_shot(ring_exponent, entropy, members, ctx, msg)`.
 *
 * `verifiablejs-thinvrf` is vendored from `paritytech/identity-backend` at
 * `vendor/verifiablejs-thinvrf/`, NOT pulled from npm. The npm-published
 * `verifiablejs@1.3.0-beta.0` is a separate build of the same nominal
 * version that ships a divergent wasm — signatures it generates do not
 * verify against the IB's beta.0 build, so registrations submitted with
 * the npm wasm get flipped to FAILED by the reconciler. Match the IB's
 * build exactly or expect that failure mode. See
 * `vendor/verifiablejs-thinvrf/PROVENANCE.md` for refresh instructions.
 *
 * The new API also takes a `RingExponent` (9 | 10 | 14) — both People and
 * LitePeople collections are configured as `R2e9` in the individuality
 * runtimes, so we hard-code 9. Once every tracked network is on v0.7.0+,
 * drop the alias + the `thinVrf` feature flag and pin a single dep.
 */
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import * as verifiableOld from "verifiablejs/nodejs";
import * as verifiableNew from "verifiablejs-thinvrf/nodejs";

const PEOPLE_RING_EXPONENT = 9 as const;

export interface OneShotResult {
  proof: Uint8Array;
  alias: Uint8Array;
}

export interface VerifiableApi {
  sign(entropy: Uint8Array, message: Uint8Array): Uint8Array;
  member_from_entropy(entropy: Uint8Array): Uint8Array;
  one_shot(
    entropy: Uint8Array,
    members: Uint8Array,
    context: Uint8Array,
    message: Uint8Array,
  ): OneShotResult;
}

export function verifiableFor(network: NetworkConfig = getNetworkConfig()): VerifiableApi {
  if (network.features.thinVrf) {
    return {
      sign: verifiableNew.sign,
      member_from_entropy: verifiableNew.member_from_entropy,
      one_shot: (entropy, members, context, message) =>
        verifiableNew.one_shot(PEOPLE_RING_EXPONENT, entropy, members, context, message),
    };
  }
  return {
    sign: verifiableOld.sign,
    member_from_entropy: verifiableOld.member_from_entropy,
    one_shot: verifiableOld.one_shot,
  };
}
