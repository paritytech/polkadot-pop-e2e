import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { AccountId } from "@polkadot-api/substrate-bindings";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { previewPeople } from "@pop-e2e/papi";
import { createClaimSigner, createPgasPayerSigner } from "../lib/claim-signer.js";
import { PEOPLE_IDENTIFIER, encodeMembers, fetchRingMembers, ringExponent } from "../lib/ring.js";
import { productContextSuffix, stmtStoreContextV012 } from "../lib/individuality-compat.js";
import { PEOPLE_CLAIM_EXTENSIONS } from "../lib/people-claim.js";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { artifact, extrinsicBody, hash, prepared, type Context } from "./protocol.js";
import { withProofWorkers } from "./proofs.js";

const pause = () => new Promise((resolve) => setTimeout(resolve, 6000));
function integer(value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`expected integer 1..${max}`);
  return value;
}
function people(run: string, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const index = Buffer.alloc(4);
    index.writeUInt32LE(i);
    const entropy = Binary.fromHex(`0x${hash(Buffer.concat([Buffer.from(hash(Buffer.from(run)), "hex"), Buffer.from("ring"), index]))}`);
    return { entropy, key: Binary.toHex(verifiableFor().member_from_entropy(entropy)) };
  });
}

export async function invoke(op: string, inputs: any, context: Context) {
  const client = createClient(getWsProvider(inputs.target));
  const api = client.getTypedApi(previewPeople);
  const collection = Binary.toHex(PEOPLE_IDENTIFIER);
  const snapshot = async () => {
    const { hash: at } = await client.getFinalizedBlock();
    const now = await api.query.Timestamp.Now.getValue({ at });
    const metadata = await client.getMetadata(at);
    const version = await api.apis.Core.version({ at });
    return { at, period: Math.floor(Number(now) / 86_400_000), metadata: hash(metadata!),
      version: `${version.spec_version}/${version.transaction_version}` };
  };
  try {
    const start = await snapshot();
    const genesis = (await client.getChainSpecData()).genesisHash;
    const suffix = await productContextSuffix(client);
    if (!suffix) throw new Error("People product contexts required");
    const exponent = await ringExponent(api, "People");
    if (op === "preflight") {
      await api.tx.Resources.set_statement_store_account({ period: start.period, seq: 0, target_account: AccountId().dec(new Uint8Array(32)) }).getEncodedData();
      return { identity: { genesis, metadata: start.metadata, version: start.version, period: start.period } };
    }
    const members = integer(inputs.members, 5000);
    const persons = people(context.run_id, members);
    if (op === "recognize") {
      await cryptoWaitReady();
      const account = new Keyring({ type: "sr25519" }).addFromUri(inputs.credential);
      const sudo = await api.query.Sudo.Key.getValue({ at: start.at });
      if (!sudo || Binary.toHex(AccountId().enc(sudo)) !== Binary.toHex(account.publicKey)) throw new Error("credential is not the sudo account");
      let nonce = (await api.query.System.Account.getValue(account.address)).nonce;
      const transactions = [];
      for (let i = 0; i < members; i += 500) {
        const call = api.tx.People.force_recognize_personhood({ people: persons.slice(i, i + 500).map((p) => p.key) });
        const tx = api.tx.Sudo.sudo({ call: call.decodedCall });
        transactions.push(prepared(await tx.create(createPgasPayerSigner(account), {
          nonce: nonce++, mortality: { mortal: false }, customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS,
        }), { sudo: true }));
      }
      return { transactions: await artifact(context, "recognition", transactions), members };
    }
    const slots = integer(inputs.slots, 20);
    const total = integer(members * slots, 100_000);
    const reserve = integer(inputs["probe-reserve"], total - 1);
    // Read locations, revisions and included keys at one finalized block.
    const deadline = Date.now() + 1_200_000;
    let locations: number[] = [];
    let rings = new Map<number, { revision: number; keys: Uint8Array[] }>();
    while (true) {
      const { at } = await snapshot();
      const statuses = await Promise.all(persons.map((p) => api.query.Members.Members.getValue(collection, p.key, { at })));
      if (statuses.every((s) => s?.type === "Included")) {
        locations = statuses.map((s) => s!.type === "Included" ? s.value.ring_index : -1);
        rings = new Map(await Promise.all([...new Set(locations)].map(async (i) => {
          const root = await api.query.Members.Root.getValue(collection, i, { at });
          const keys = await fetchRingMembers(api, "People", i, at);
          return [i, { revision: root?.revision ?? 0, keys: root ? keys : [] }] as const;
        })));
        if (persons.every((p, i) => rings.get(locations[i])!.keys.some((k) => Binary.toHex(k) === p.key))) break;
      }
      if (Date.now() >= deadline) throw new Error("recognition did not reach built rings in 20 minutes");
      await pause();
    }
    const current = await snapshot();
    const started = performance.now();
    const transactions = await withProofWorkers(total, async (i, prove) => {
      const member = i % members;
      const seq = Math.floor(i / members);
      const person = persons[member];
      const ring = rings.get(locations[member])!;
      const target = Binary.fromHex(`0x${hash(Buffer.from(`${context.run_id}/target/${member}/${seq}`))}`);
      const proofContext = stmtStoreContextV012(suffix, current.period, seq);
      const encodedMembers = encodeMembers(ring.keys);
      const signer = createClaimSigner({
        extensionName: "AsResources", context: proofContext, verifiableEntropy: person.entropy, encodedMembers, ringExponent: exponent,
        prove: (message) => prove(exponent, person.entropy, encodedMembers, proofContext, message),
        extensionValue: (proof) => ({ type: "RegisterStatementStoreAllowance", value: [proof, locations[member], ring.revision, { type: "People" }] }),
      });
      const tx = api.tx.Resources.set_statement_store_account({ period: current.period, seq, target_account: AccountId().dec(target) });
      return prepared(await tx.create(signer, { nonce: 0, customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS }), { target: Binary.toHex(target), member, seq });
    });
    console.error(`${total} proofs in ${((performance.now() - started) / 1000).toFixed(2)}s`);
    const after = await snapshot();
    if (after.metadata !== start.metadata || after.version !== start.version || after.period !== current.period) throw new Error("runtime or claim period changed during preparation");
    for (const tx of [transactions[0], transactions[total - 1]]) {
      const valid = await api.apis.TaggedTransactionQueue.validate_transaction(
        { type: "External", value: undefined }, extrinsicBody(Binary.fromHex(`0x${tx.bytes}`)), after.at, { at: after.at },
      );
      if (!valid.success) throw new Error("prepared claim rejected by runtime validation");
    }
    if (new Set(transactions.map((tx) => tx.hash)).size !== total) throw new Error("duplicate claims");
    return {
      flood: await artifact(context, "claims", transactions.slice(0, total - reserve)),
      probes: await artifact(context, "probes", transactions.slice(total - reserve)),
    };
  } finally {
    client.destroy();
  }
}
