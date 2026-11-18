import { test } from "node:test";
import assert from "node:assert/strict";
import { Binary, getOfflineApi, getTypedCodecs } from "polkadot-api";
import { AccountId, compact } from "@polkadot-api/substrate-bindings";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { previewPeople } from "@pop-e2e/papi";
import { createClaimSigner, createPgasPayerSigner } from "../lib/claim-signer.js";
import { encodeMembers, PEOPLE_IDENTIFIER } from "../lib/ring.js";
import { stmtStoreContextV012 } from "../lib/individuality-compat.js";
import { PEOPLE_CLAIM_EXTENSIONS } from "../lib/people-claim.js";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { extrinsicBody } from "./protocol.js";
import { withProofWorkers } from "./proofs.js";

// Real encoding/proving against checked-in previewnet metadata, without an RPC.
test("PAPI encodes sudo and worker-proved v5 claims offline", async () => {
  const api = await getOfflineApi(previewPeople);
  await cryptoWaitReady();
  const account = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const entropy = new Uint8Array(32).fill(17);
  const key = verifiableFor().member_from_entropy(entropy);
  const call = api.tx.People.force_recognize_personhood({ people: [Binary.toHex(key)] });
  const sudo = await api.tx.Sudo.sudo({ call: call.decodedCall }).create(createPgasPayerSigner(account), {
    nonce: 0, mortality: { mortal: false }, customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS,
  });
  assert.ok(sudo.length > 64);
  const codecs = await getTypedCodecs(previewPeople);
  const decoded = codecs.tx.People.force_recognize_personhood.dec(Uint8Array.from(call.encodedData.subarray(2)));
  assert.equal(decoded.people.length, 1);
  assert.equal(new TextDecoder().decode(PEOPLE_IDENTIFIER), "pop:polkadot.network/people     ");
  const [bytes] = await withProofWorkers(1, async (_i, prove) => {
    const context = stmtStoreContextV012("testnet", 20722, 5);
    const members = encodeMembers([key]);
    const signer = createClaimSigner({
      extensionName: "AsResources", context, verifiableEntropy: entropy, encodedMembers: members, ringExponent: 9,
      prove: (message) => prove(9, entropy, members, context, message),
      extensionValue: (proof) => ({ type: "RegisterStatementStoreAllowance", value: [proof, 0, 0, { type: "People" }] }),
    });
    return api.tx.Resources.set_statement_store_account({ period: 20722, seq: 5, target_account: AccountId().dec(key) })
      .create(signer, { nonce: 0, mortality: { mortal: false }, customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS });
  });
  // Full extrinsic: compact length, then v5 general marker, extension version and body.
  const prefix = compact.enc(compact.dec(bytes));
  assert.equal(compact.dec(bytes), bytes.length - prefix.length);
  assert.equal(bytes[prefix.length], 0x45);
  assert.ok(bytes.length > 785);
  const genesis = previewPeople.genesis!;
  const validation = codecs.apis.TaggedTransactionQueue.validate_transaction.args.enc([
    { type: "External", value: undefined }, extrinsicBody(bytes), genesis,
  ]);
  assert.deepEqual(Buffer.from(validation), Buffer.concat([Buffer.from([2]), Buffer.from(bytes), Buffer.from(genesis.slice(2), "hex")]));
});
