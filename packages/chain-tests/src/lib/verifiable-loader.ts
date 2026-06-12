/**
 * Thin wrapper over `verifiablejs` for the ring-VRF primitives this
 * package needs. Single source of truth for `one_shot` + friends so
 * call sites don't have to remember the `ring_exponent` argument.
 *
 * History note: prior to verifiablejs `1.3.0-beta.4` we vendored the
 * IB-blessed wasm (`vendor/verifiablejs-thinvrf/`) and shipped a
 * network-aware loader to also support the pre-ThinVRF
 * `verifiablejs@1.2.0` build for paseo-next-v2. beta.4 fixed the
 * SCALE-prefix bug in `one_shot` that was the original reason the
 * vendor copy diverged from npm — see commit `70f996c` in the
 * verifiablejs repo. With the fix on npm and every tracked network
 * on the unified post-ThinVRF pallet shape, the vendor + branch are
 * dead weight.
 */
import * as verifiable from "verifiablejs/nodejs";

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

export function verifiableFor(): VerifiableApi {
  return {
    sign: verifiable.sign,
    member_from_entropy: verifiable.member_from_entropy,
    one_shot: (entropy, members, context, message) =>
      verifiable.one_shot(PEOPLE_RING_EXPONENT, entropy, members, context, message),
  };
}
