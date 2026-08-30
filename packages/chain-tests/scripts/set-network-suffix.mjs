// Set a chain's DotNS network suffix after a runtime upgrade, and prove it stuck.
//
// The suffix is part of the ring-VRF product context preimage
// ("product/" ++ name ++ "." ++ suffix ++ "/" ++ ...), so a chain holding the
// wrong one derives contexts nobody's proofs match, and every proof-carrying
// extrinsic fails as BadProof rather than saying anything useful.
//
// indiv_pallet_network_suffix is new, so it is absent from our committed
// descriptors: this drives the live metadata through getUnsafeApi(). It is also
// why this signs with PAPI — these runtimes reject polkadot-js signatures.
//
//   node scripts/set-network-suffix.mjs <ws> <suffix>

import { Binary, createClient } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from '@polkadot-labs/hdkd-helpers';

const [ws, target] = process.argv.slice(2);
if (!ws || !target) {
  console.error('usage: set-network-suffix.mjs <ws-endpoint> <suffix>');
  process.exit(2);
}

// This submits a root call. Forks only — a public endpoint is always a mistake
// here, and //Alice holding sudo is a property of a bitten fork, not of a network.
if (!/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(ws)) {
  console.error(`refusing to submit a root call to ${ws} — this only ever targets a local fork`);
  process.exit(2);
}

const client = createClient(getWsProvider(ws));
const api = client.getUnsafeApi();

const read = async () => {
  const v = await api.query.NetworkSuffix.NetworkSuffix.getValue();
  return typeof v?.asText === 'function' ? v.asText() : String(v);
};

try {
  const before = await read();
  console.log(`network suffix before: ${before}`);
  if (before === target) {
    console.log(`already ${target} — nothing to do`);
    client.destroy();
    process.exit(0);
  }

  // //Alice holds sudo on every fork (the bite overrides the sudo key).
  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const alice = derive('//Alice');
  const signer = getPolkadotSigner(alice.publicKey, 'Sr25519', alice.sign);

  const inner = api.tx.NetworkSuffix.set_network_suffix({
    network_suffix: Binary.fromText(target),
  });
  const result = await api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(signer);
  if (!result.ok) {
    console.error(`sudo call failed: ${JSON.stringify(result.dispatchError)}`);
    client.destroy();
    process.exit(1);
  }

  const after = await read();
  console.log(`network suffix after : ${after}  (block ${result.block.number})`);
  client.destroy();
  process.exit(after === target ? 0 : 1);
} catch (error) {
  console.error(`could not set the network suffix: ${error.message}`);
  client.destroy();
  process.exit(1);
}
