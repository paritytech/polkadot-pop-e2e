/** Split-and-claim or recycling pilot on a disposable PreviewNet; fixed plans, real calls. */
import assert from 'node:assert/strict';
import { WsProvider } from '@polkadot/api';
import { burstSubmitter, connectBurstProvider, type BurstResult } from '../src/lib/coinage-burst-submit.js';
import { armShutdownDeadline } from '../src/lib/coinage-shutdown.js';
import { auditBurst } from '../src/lib/coinage-burst-audit.js';
import { capacitySigner, writeCapacityJson } from '../src/lib/coinage-capacity.js';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';
import { AccountId, Binary, getTypedCodecs } from 'polkadot-api';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { previewPeople } from '@pop-e2e/papi';
import {
  coinClaimOptions, coinValueToAssetAmount, createCoinageClient,
  unpaidTopUpOptions, watchCoinageTransaction, topUpArguments,
} from '../src/lib/coinage-client.js';

import { readyMembers } from '../src/lib/coinage-lifecycle.js';

const scenario = process.env.SCENARIO ?? 'offboard';
assert(scenario === 'offboard');
const users = Number(process.env.ACTOR_COUNT ?? '100');
assert(Number.isInteger(users) && users >= 1 && users <= 100000);
const mode = process.env.LOAD_MODE ?? 'burst';
assert(mode === 'burst' || mode === 'paced');
assert(mode !== 'paced' || users === 10000);
const poolProfile = process.env.POOL_PROFILE ?? 'default';
assert(poolProfile === 'default' || poolProfile === 'enlarged');
const poolTransactions = Number(process.env.POOL_TRANSACTIONS ?? '11000');
assert(Number.isInteger(poolTransactions) && poolTransactions >= 11000 && poolTransactions <= 110000);
const deadlineMs = users > 10000 ? 1_800_000 : 600_000;
const launchTargetMs = users >= 100000 ? 10000 : users >= 40000 ? 5000 : 1000;
const fixtureBatch = Math.min(users, 5000);
const stateQueryConcurrency = 64;
const out = resolve('../../network-out');
mkdirSync(out, { recursive: true });
const json = (data: unknown) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value);
const save = (name: string, data: unknown) => writeCapacityJson(`${out}/${name}.json`, data);
const log = (name: string, data: unknown) => appendFileSync(`${out}/${name}.jsonl`, json(data) + '\n');
await cryptoWaitReady();
const coinage = createCoinageClient('ws://127.0.0.1:10010');
const { api, client } = coinage;
const codecs = await getTypedCodecs(previewPeople);
const keyring = new Keyring({ type: 'sr25519' });
const signerFor = (pair: ReturnType<typeof keyring.addFromUri>) =>
  getPolkadotSigner(pair.publicKey, 'Sr25519', data => pair.sign(data));
const admin = keyring.addFromUri('//Alice');
const adminSigner = signerFor(admin);
const standardExtensions = { ...unpaidTopUpOptions(0).customSignedExtensions, AsCoinage: { value: undefined } };

async function fixture(label: string, tx: ReturnType<typeof api.tx.Sudo.sudo>, sudo = false) {
  const signed = await tx.sign(adminSigner, { customSignedExtensions: standardExtensions });
  const result = await watchCoinageTransaction(client, { signed, txHash: blake2AsHex(signed) }, 180_000);
  log('lifecycle-fixture', { label, ...result });
  assert.equal(result.status, 'finalized', `Fixture failed: ${label}`);
  if (sudo) {
    const event = result.observations.find(o => o.event.type === 'finalized')!.event;
    assert(event.type === 'finalized');
    const sudid = event.events.find(e => e.type === 'Sudo' && e.value.type === 'Sudid');
    assert(sudid?.type === 'Sudo' && sudid.value.type === 'Sudid');
    assert(sudid.value.value.sudo_result.success, `Inner sudo failed: ${label}`);
  }
  console.log(json({ phase: 'fixture', label, status: result.status }));
}

async function inGroups<T>(values: T[], work: (value: T, index: number) => Promise<void>) {
  for (let offset = 0; offset < values.length; offset += stateQueryConcurrency) {
    await Promise.all(values.slice(offset, offset + stateQueryConcurrency).map((value, index) => work(value, offset + index)));
  }
}

function latencies(values: number[]) {
  values.sort((a, b) => a - b);
  const p = (q: number) => values.length ? values[Math.max(0, Math.ceil(values.length * q) - 1)] : null;
  return { count: values.length, p50: p(0.5), p95: p(0.95), max: p(1) };
}


import { member_from_entropy } from 'verifiablejs/nodejs';
import { encodeMembers, PEOPLE_IDENTIFIER } from '../src/lib/ring.js';
import { unloadSigner, voucherAlias, type ProofRing } from '../src/lib/coinage-unload.js';
import { groups } from '../src/lib/coinage-campaign.js';
async function stage(count: number, name: string) {
  const prepStart = performance.now();
  const peopleCollection = Binary.toHex(PEOPLE_IDENTIFIER);
  const min = await api.constants.Coinage.MinimumExponent();
  const unit = 1n << BigInt(Math.max(0, -min));
  const denomination = 1, amount = 2n * unit;
  const asset = { parents: 0, interior: { type: 'X1' as const, value: { type: 'GeneralIndex' as const,
    value: BigInt('0x' + randomBytes(16).toString('hex')) } } };
  await fixture('create asset', api.tx.Sudo.sudo({ call: api.tx.Assets.force_create({
    id: asset, owner: { type: 'Id', value: admin.address }, is_sufficient: true, min_balance: 1n,
  }).decodedCall }), true);
  const palletBytes = new Uint8Array(32); palletBytes.set(new TextEncoder().encode('modlcoinage '));
  const palletAccount = AccountId().dec(palletBytes), backing = amount * BigInt(count) + 1n;
  await fixture('back coins', api.tx.Assets.mint({ id: asset,
    beneficiary: { type: 'Id', value: palletAccount }, amount: backing }));
  const instanceId = await api.query.Coinage.NextInstanceId.getValue();
  await fixture('create instance', api.tx.Sudo.sudo({ call:
    api.tx.Coinage.create_sufficient_instance({ asset_id: asset, asset_unit: unit }).decodedCall }), true);
  const collectionBytes = new Uint8Array(32); collectionBytes.set(new TextEncoder().encode('coinage/recycler'));
  new DataView(collectionBytes.buffer).setUint32(16, instanceId, true); collectionBytes[20] = denomination;
  const collection = Binary.toHex(collectionBytes);
  const actors = Array.from({ length: count }, (_, id) => {
    const coin = keyring.addFromSeed(randomBytes(32)); keyring.removePair(coin.address);
    const destination = keyring.addFromSeed(randomBytes(32)); keyring.removePair(destination.address);
    const personEntropy = randomBytes(32), entropy = randomBytes(32);
    return { id, coin, destination, personEntropy, entropy,
      person: Binary.toHex(member_from_entropy(personEntropy)),
      voucher: topUpArguments(instanceId, denomination, coin.address, entropy) };
  });
  for (let offset = 0; offset < count; offset += 100) {
    const batch = actors.slice(offset, offset + 100);
    await fixture('recognize fixture people', api.tx.Sudo.sudo({ call:
      api.tx.People.force_recognize_personhood({ people: batch.map(a => a.person) }).decodedCall }), true);
    const items: [Uint8Array, Uint8Array][] = await Promise.all(batch.map(async a => [
      Binary.fromHex(await api.query.Coinage.CoinsByOwner.getKey(a.coin.address)),
      codecs.query.Coinage.CoinsByOwner.value.enc({ instance_id: instanceId, value: denomination, age: 0 }),
    ]));
    await fixture('seed fixture coins', api.tx.Sudo.sudo({ call: api.tx.System.set_storage({ items }).decodedCall }), true);
    // Setup loads are paced and excluded from offboarding latency.
    const signedLoads = await Promise.all(batch.map(a => api.tx.Coinage.load_recycler_with_coin({
      member_key: a.voucher.member_key, proof_of_ownership: a.voucher.proof_of_ownership,
    }).sign(signerFor(a.coin), { ...coinClaimOptions(), mortality: { mortal: false } })));
    await Promise.all(signedLoads.map(async signed => {
      const result = await watchCoinageTransaction(client, { signed, txHash: blake2AsHex(signed) }, 180000);
      log(`${name}-setup-loads`, result); assert.equal(result.status, 'finalized');
    }));
  }
  async function rings(id: string, keys: Set<string>, exponent: 9 | 10) {
    const started = performance.now();
    while (performance.now() - started < deadlineMs) {
      const block = await client.getFinalizedBlock(), opts = { at: block.hash };
      const [pages, statuses, roots] = await Promise.all([
        api.query.Members.RingKeys.getEntries(id, opts), api.query.Members.RingKeysStatus.getEntries(id, opts),
        api.query.Members.Root.getEntries(id, opts),
      ]);
      const located = readyMembers(pages, statuses, roots, keys);
      log(`${name}-fixture-readiness`, { collection: id, at: block, ready: located.size, expected: keys.size, elapsedMs: performance.now() - started });
      if (located.size === keys.size) {
        save(`${name}-${id === collection ? 'recycler' : 'people'}-rings`, { at: block, pages, statuses, roots });
        return (key: string, entropy: Uint8Array): ProofRing => {
          const location = located.get(key)!;
          const members = pages.filter(p => p.keyArgs[1] === location.ring).sort((a,b) => a.keyArgs[2] - b.keyArgs[2]).flatMap(p => p.value).slice(0, location.included);
          return { entropy, exponent, ring: location.ring, revision: location.revision,
            members: encodeMembers(members.map(m => Binary.fromHex(m))) };
        };
      }
      await delay(5000);
    }
    throw new Error(`Fixture ring readiness timed out for ${id}`);
  }
  const personRing = await rings(peopleCollection, new Set(actors.map(a => a.person)), 9);
  const recyclerRing = await rings(collection, new Set(actors.map(a => a.voucher.member_key)), 10);
  const sender = new WsProvider('ws://127.0.0.1:10010', false, {}, deadlineMs);
  const submit = burstSubmitter(sender, async hash => {
    const [block, events] = await Promise.all([
      client._request<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [hash]),
      api.query.System.Events.getValue({ at: hash }),
    ]);
    save(`${name}-block-${Number.parseInt(block.block.header.number, 16)}`, { hash, block, events });
    return { number: Number.parseInt(block.block.header.number, 16), extrinsics: block.block.extrinsics, events };
  }, (txHash, observation) => log(`${name}-watch-transitions`, { txHash, ...observation }));
  const waves: unknown[] = [];
  save(`${name}-fixture`, { count, instanceId, asset, unit, amount, backing, palletAccount, collection,
    poolProfile, poolTransactions, preparationMs: performance.now() - prepStart,
    boundary: 'Root-seeded people and backed coins, real loads/ring builds, no native wallet',
    actors: actors.map(a => ({ id: a.id, source: a.coin.address, destination: a.destination.address, person: a.person, member: a.voucher.member_key })) });
  try {
    await connectBurstProvider(sender);
    for (const [waveIndex, ids] of groups(count, name.endsWith('smoke') ? 'burst' : mode).entries()) {
      const prefix = `${name}-wave-${waveIndex + 1}`;
      const timestamp = await api.query.Timestamp.Now.getValue();
      const period = Math.floor(Number(timestamp) / 86400000);
      const prepared: { hex: string; txHash: string }[] = [];
      for (const id of ids) {
        const a = actors[id], ring = recyclerRing(a.voucher.member_key, a.entropy);
        const signer = unloadSigner({ person: personRing(a.person, a.personEntropy), vouchers: [ring], period, counter: 0,
          observe: timing => log(`${prefix}-proofs`, { actor: id, ...timing }) });
        const options = unpaidTopUpOptions(0);
        const signed = await api.tx.Coinage.unload_recycler_into_external_asset({ instance_id: instanceId,
          aliases: [Binary.toHex(voucherAlias(a.entropy))], value: denomination, index: ring.ring,
          revision: ring.revision, to: a.destination.address, max_fee: 0n,
        }).sign(signer, { ...options, mortality: { mortal: false }, customSignedExtensions: {
          ...options.customSignedExtensions, AsCoinage: { value: undefined },
        } });
        prepared.push({ hex: Binary.toHex(signed), txHash: blake2AsHex(signed) });
        if (id % 10 === 0) await yieldLoop();
      }
      assert.equal(Math.floor(Number(await api.query.Timestamp.Now.getValue()) / 86400000), period, 'Period changed while preparing proofs');
      save(`${prefix}-signed`, prepared);
      const wallStart = new Date().toISOString(), started = performance.now();
      const pending = prepared.map((wire, i) => {
        const sentAtMs = performance.now() - started;
        return submit(wire, deadlineMs).then(result => { log(`${prefix}-transactions`, { actor: ids[i], sentAtMs, ...result }); return result; });
      });
      const sendWindowMs = performance.now() - started, results = await Promise.all(pending);
      const summary = { name: prefix, wallStart, count: ids.length, sent: results.length, sendWindowMs,
        finalityMs: latencies(results.filter(r => r.status === 'finalized').map(r => r.elapsedMs)),
        settledMs: performance.now() - started, passed: results.every(r => r.status === 'finalized') };
      save(`${prefix}-summary`, summary);
      await auditBurst({ name: prefix, expected: ids.length, results, operation: 'RecyclerUnloadedIntoExternalAsset', out, api, summary });
      const at = await client.getFinalizedBlock();
      const states: unknown[] = [];
      await inGroups(ids, async id => {
        const a = actors[id], balance = await api.query.Assets.Account.getValue(asset, a.destination.address, { at: at.hash });
        states.push({ actor: id, balance: balance?.balance });
        assert.equal(balance?.balance, amount, 'Offboard amount differs');
      });
      const finalBacking = (await api.query.Assets.Account.getValue(asset, palletAccount, { at: at.hash }))?.balance;
      const completed = groups(count, name.endsWith('smoke') ? 'burst' : mode).slice(0, waveIndex + 1).flat().length;
      save(`${prefix}-state`, { at, states, finalBacking, expectedBacking: backing - amount * BigInt(completed) });
      assert.equal(finalBacking, backing - amount * BigInt(completed));
      waves.push(summary);
    }
    save(`${name}-summary`, { count, waves, passed: true });
  } finally { await sender.disconnect(); }
}
try {
  save('unload-runtime', { version: await api.constants.System.Version(), scenario, users, mode, poolProfile, poolTransactions });
  await stage(1, 'offboard-smoke');
  if (process.env.SMOKE_ONLY !== 'true') await stage(users, 'offboard-pilot');
} catch (error) {
  save('unload-error', { error: String(error), stack: error instanceof Error ? error.stack : undefined });
  console.error(error); process.exitCode = 1;
} finally { armShutdownDeadline(`${out}/unload-shutdown-error.json`); coinage.close(); }
