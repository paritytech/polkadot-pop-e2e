// Seed a chain's DotNS network suffix after a runtime upgrade.
//
// indiv_pallet_network_suffix is new and nothing seeds it on upgrade, so an
// upgraded chain reads back the pallet default ("paseo"). The suffix is part of
// the ring-VRF product context preimage —
// "product/" ++ name ++ "." ++ suffix ++ "/" ++ suffix.bytes() — so a chain
// holding the wrong one derives contexts no client's proof matches, and every
// proof-carrying extrinsic fails as BadProof with nothing naming the cause.
//
// Temporary: it belongs in a migration in the runtime. Tracked in
// docs/issues-drafts/individuality-network-suffix-not-seeded-on-upgrade.md.
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

// This submits a root call. Forks only — //Alice holding sudo is a property of a
// bitten fork, not of a network, and a public endpoint here is always a mistake.
if (!/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(ws)) {
  console.error(`refusing to submit a root call to ${ws} — this only ever targets a local fork`);
  process.exit(2);
}

const client = createClient(getWsProvider(ws));
const api = client.getUnsafeApi();

const read = async () => {
  const v = await api.query.NetworkSuffix.NetworkSuffix.getValue();
  if (typeof v?.asText === 'function') return v.asText();
  // ValueQuery hands back raw bytes when the value is the pallet default.
  return Array.isArray(v) || ArrayBuffer.isView(v)
    ? new TextDecoder().decode(Uint8Array.from(v))
    : String(v);
};

// A steady-state run installs a runtime predating the pallet; there is nothing to
// seed and that is not a failure. Only an unknown pallet/entry is tolerated.
const missingPallet = (message) =>
  /NetworkSuffix/i.test(message) &&
  /(not found|unknown|undefined|no such|cannot read)/i.test(message);

let before;
try {
  before = await read();
} catch (error) {
  if (missingPallet(error.message)) {
    console.log(`this runtime has no NetworkSuffix pallet — nothing to seed (${error.message})`);
    client.destroy();
    process.exit(0);
  }
  console.error(`could not read the network suffix: ${error.message}`);
  client.destroy();
  process.exit(1);
}

try {
  console.log(`network suffix before: ${before}`);
  if (before === target) {
    console.log(`already ${target} — nothing to do`);
    client.destroy();
    process.exit(0);
  }

  const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
  const alice = derive('//Alice');
  const signer = getPolkadotSigner(alice.publicKey, 'Sr25519', alice.sign);

  // These runtimes carry People-chain transaction extensions PAPI will not fill
  // on its own; passthrough values, the same set the suite signs with.
  const customSignedExtensions = {
    VerifyMultiSignature: { value: { type: 'Disabled', value: undefined } },
    AsPerson: { value: undefined },
    AsProofOfInkParticipant: { value: undefined },
    ScoreAsParticipant: { value: undefined },
    GameAsInvited: { value: undefined },
    PeopleLiteAuth: { value: undefined },
    AsMember: { value: undefined },
    AsCoinage: { value: undefined },
    AsResources: { value: undefined },
    RestrictOrigins: { value: false },
  };

  const inner = api.tx.NetworkSuffix.set_network_suffix({
    network_suffix: Binary.fromText(target),
  });
  const result = await api.tx.Sudo.sudo({ call: inner.decodedCall }).signAndSubmit(signer, {
    customSignedExtensions,
  });
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
