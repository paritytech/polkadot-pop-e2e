/**
 * "Fake" PolkadotSigner that produces a v5 general transaction blob
 * (extrinsic version 5, type "general") instead of signing.
 *
 * Required for unsigned txs that carry custom transaction-extension data —
 * e.g. `AsResources` carrying a ring-VRF proof for an allowance claim.
 *
 * Workaround tracked at:
 *   https://github.com/polkadot-api/polkadot-api/issues/760
 *
 * The signer doesn't actually sign anything. It threads through whatever
 * `signedExtensions` PAPI resolved (including any `customSignedExtensions`
 * passed to `signSubmitAndWatch`) and builds the v5 general format.
 */
import {
  compact,
  decAnyMetadata,
  extrinsicFormat,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import type { PolkadotSigner } from "polkadot-api";
import { mergeUint8 } from "polkadot-api/utils";

const EXTENSION_VERSION = 0;

export const generalSigner: PolkadotSigner = {
  publicKey: new Uint8Array(32),
  signBytes() {
    throw new Error("generalSigner: signBytes is unsupported");
  },
  async signTx(callData, signedExtensions, metadata) {
    const decMeta = unifyMetadata(decAnyMetadata(metadata));
    const extList = decMeta.extrinsic.signedExtensions[EXTENSION_VERSION];
    const extra = extList.map(({ identifier }) => {
      const ext = signedExtensions[identifier];
      if (!ext) {
        throw new Error(`generalSigner: missing signed extension '${identifier}'`);
      }
      return ext.value;
    });

    const preResult = mergeUint8([
      extrinsicFormat.enc({ version: 5, type: "general" }),
      new Uint8Array([EXTENSION_VERSION]),
      ...extra,
      callData,
    ]);
    return mergeUint8([compact.enc(preResult.length), preResult]);
  },
};
