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
assert(scenario === 'offboard' || scenario === 'full-flow' || scenario === 'quota');
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
let phase = 'startup';

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
import { encodeMembers } from '../src/lib/ring.js';
import { unloadSigner, voucherAlias, type ProofRing } from '../src/lib/coinage-unload.js';
import { groups, recyclingDecision } from '../src/lib/coinage-campaign.js';
async function stage(count: number, name: string) {
  const prepStart = performance.now();
  let peopleCollection: string;
  const min = await api.constants.Coinage.MinimumExponent();
  const unit = 1n << BigInt(Math.max(0, -min));
  const denomination = 1, amount = 2n * unit;
  const asset = { parents: 0, interior: { type: 'X1' as const, value: { type: 'GeneralIndex' as const,
    value: BigInt('0x' + randomBytes(16).toString('hex')) } } };
  await fixture('create asset', api.tx.Sudo.sudo({ call: api.tx.Assets.force_create({
    id: asset, owner: { type: 'Id', value: admin.address }, is_sufficient: true, min_balance: 1n,
  }).decodedCall }), true);
  const palletBytes = new Uint8Array(32); palletBytes.set(new TextEncoder().encode('modlcoinage '));
  const palletAccount = AccountId().dec(palletBytes), backing = 1n;
  await fixture('back coins', api.tx.Assets.mint({ id: asset,
    beneficiary: { type: 'Id', value: palletAccount }, amount: backing }));
  const instanceId = await api.query.Coinage.NextInstanceId.getValue();
  await fixture('create instance', api.tx.Sudo.sudo({ call:
    api.tx.Coinage.create_sufficient_instance({ asset_id: asset, asset_unit: unit }).decodedCall }), true);
  const collectionBytes = new Uint8Array(32); collectionBytes.set(new TextEncoder().encode('coinage/recycler'));
  new DataView(collectionBytes.buffer).setUint32(16, instanceId, true); collectionBytes[20] = denomination;
  const collection = Binary.toHex(collectionBytes);
  const [quotaLimit] = await api.view.Coinage.get_free_unload_token_info();
  assert(quotaLimit > 0, 'No free allowance available');
  // Quota actors are unload requests; each full cohort exhausts one person's allowance.
  const quotaPeople = Array.from({ length: scenario === 'quota' ? Math.ceil(count / quotaLimit) : count }, () => randomBytes(32));
  const actors = Array.from({ length: count }, (_, id) => {
    const coin = keyring.addFromSeed(randomBytes(32)); keyring.removePair(coin.address);
    const destination = keyring.addFromSeed(randomBytes(32)); keyring.removePair(destination.address);
    const personEntropy = quotaPeople[scenario === 'quota' ? Math.floor(id / quotaLimit) : id], entropy = randomBytes(32), recycledEntropy = randomBytes(32);
    const payment = keyring.addFromSeed(randomBytes(32)); keyring.removePair(payment.address);
    return { id, coin, destination, payment, personEntropy, entropy, recycledEntropy,
      recycledVoucher: topUpArguments(instanceId, denomination, destination.address, recycledEntropy),
      person: Binary.toHex(member_from_entropy(personEntropy)),
      voucher: topUpArguments(instanceId, denomination, coin.address, entropy) };
  });
  const recognized = new Set<string>();
  phase = `${name}: setup`;
  // PAPI's submitAndWatch uses transaction_v1_broadcast, which this node caps at 16 active
  // broadcasts per connection. Beyond that it returns null, PAPI drops the error and the
  // transaction is never sent. Setup loads use the same legacy watch path as the workload.
  const setupSender = new WsProvider('ws://127.0.0.1:10010', false, {}, 180_000);
  await connectBurstProvider(setupSender);
  const setupSubmit = burstSubmitter(setupSender, async hash => {
    const [block, events] = await Promise.all([
      client._request<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [hash]),
      api.query.System.Events.getValue({ at: hash }),
    ]);
    save(`${name}-setup-block-${Number.parseInt(block.block.header.number, 16)}`, { hash, block, events });
    return { number: Number.parseInt(block.block.header.number, 16), extrinsics: block.block.extrinsics, events };
  }, (txHash, observation) => log(`${name}-setup-watch-transitions`, { txHash, ...observation }));
  const setupOutcomes: Record<string, number> = {};
  try {
  for (let offset = 0; offset < count; offset += 100) {
    const batch = actors.slice(offset, offset + 100);
    const newPeople = [...new Set(batch.map(a => a.person))].filter(p => !recognized.has(p));
    if (newPeople.length) await fixture('recognize fixture people', api.tx.Sudo.sudo({ call:
      api.tx.People.force_recognize_personhood({ people: newPeople }).decodedCall }), true);
    newPeople.forEach(p => recognized.add(p));
    await fixture('fund top-up actors', api.tx.Utility.batch_all({ calls: batch.map(a => api.tx.Assets.mint({ id: asset, beneficiary: { type: 'Id', value: a.coin.address }, amount }).decodedCall) }));
    if (scenario === 'full-flow') continue;
    // Real setup top-ups create Wrapped holds, which offboarding releases.
    const signedLoads = await Promise.all(batch.map(a => api.tx.Coinage.load_recycler_with_external_asset_unpaid(a.voucher)
      .sign(signerFor(a.coin), { ...unpaidTopUpOptions(0), mortality: { mortal: false } })));
    // Keep every outcome in the batch before deciding; the first unresolved watch is not the whole story.
    const results = await Promise.all(signedLoads.map(signed => setupSubmit(
      { hex: Binary.toHex(signed), txHash: blake2AsHex(signed) }, 180_000)));
    results.forEach((result, i) => {
      log(`${name}-setup-loads`, { actor: batch[i].id, ...result });
      setupOutcomes[result.status] = (setupOutcomes[result.status] ?? 0) + 1;
    });
    save(`${name}-setup-outcome`, { requested: count, attempted: offset + batch.length, outcomes: setupOutcomes });
    const incomplete = results.length - results.filter(r => r.status === 'finalized').length;
    if (incomplete) throw new Error(`Setup top-ups incomplete: ${incomplete} of ${results.length} in batch at actor ${offset} did not finalize successfully`);
  }
  } finally { await setupSender.disconnect(); }
  // The older helper uses the retired "people ..." identifier. Discover the actual
  // collection from the member just recognized on this runtime, never from a name guess.
  const membershipAt = await client.getFinalizedBlock();
  const memberPages = await api.query.Members.RingKeys.getEntries({ at: membershipAt.hash });
  const collections = [...new Set(memberPages.filter(page => page.value.includes(actors[0].person))
    .map(page => page.keyArgs[0]))];
  save(`${name}-people-collection`, { at: membershipAt, member: actors[0].person, collections });
  assert.equal(collections.length, 1, 'Recognized person must identify exactly one Members collection');
  peopleCollection = collections[0];
  async function rings(id: string, keys: Set<string>, exponent: 9 | 10) {
    const started = performance.now();
    while (performance.now() - started < deadlineMs) {
      const block = await client.getFinalizedBlock(), opts = { at: block.hash };
      const [pages, statuses, roots] = await Promise.all([
        api.query.Members.RingKeys.getEntries(id, opts), api.query.Members.RingKeysStatus.getEntries(id, opts),
        api.query.Members.Root.getEntries(id, opts),
      ]);
      const located = readyMembers(pages, statuses, roots, keys);
      save(`${name}-${id === peopleCollection ? 'people' : 'recycler'}-readiness-state`, { at: block, pages, statuses, roots });
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
  phase = `${name}: fixture readiness`;
  const personRing = await rings(peopleCollection, new Set(actors.map(a => a.person)), 9);
  const fixtureRecyclerRing = scenario !== 'full-flow' ? await rings(collection, new Set(actors.map(a => a.voucher.member_key)), 10) : undefined;
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
  const members = async (ids: number[], recycled = false) => rings(collection,
    new Set(ids.map(i => recycled ? actors[i].recycledVoucher.member_key : actors[i].voucher.member_key)), 10);
  type Wire = { hex: string; txHash: string };
  const wire = (signed: Uint8Array): Wire => ({ hex: Binary.toHex(signed), txHash: blake2AsHex(signed) });
  const allGroups = groups(count, name.endsWith('smoke') ? 'burst' : mode);
  save(`${name}-fixture`, { scenario, count, instanceId, asset, unit, amount, backing, palletAccount, collection,
    quotaLimit, peopleCount: quotaPeople.length, actorMeaning: scenario === 'quota' ? 'unload requests grouped by person allowance' : 'distinct person',
    poolProfile, poolTransactions, preparationMs: performance.now() - prepStart,
    boundary: scenario === 'full-flow' ? 'Root-created people and funded actors; real top-up, unload, claim, recycle and offboard; fixed plan without native wallet' : 'Root-created people and funded actors; real top-ups create vouchers and Wrapped holds; no native wallet',
    actors: actors.map(a => ({ id: a.id, source: a.coin.address, payment: a.payment.address, destination: a.destination.address, person: a.person, member: a.voucher.member_key, recycledMember: a.recycledVoucher.member_key })) });
  let firstSubmission = 0;
  let sampling = false;
  const samples = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const at = await client.getFinalizedBlock();
      const allowance = await api.view.Coinage.get_free_unload_token_info({ at: at.hash });
      log(`${name}-samples`, { at, allowance, elapsedMs: performance.now() - prepStart, cpu: process.cpuUsage(), memory: process.memoryUsage() });
    } catch (error) { log(`${name}-samples`, { error: String(error) }); }
    finally { sampling = false; }
  }, 5000);
  async function execute(prefix: string, ids: number[], prepared: Wire[], operation: Parameters<typeof auditBurst>[0]['operation']) {
    save(`${prefix}-signed`, prepared);
    const wallStart = new Date().toISOString(), started = performance.now(); firstSubmission ||= started;
    const pending = prepared.map((tx, i) => {
      const sentAtMs = performance.now() - started;
      return submit(tx, deadlineMs).then(result => { log(`${prefix}-transactions`, { actor: ids[i], sentAtMs, ...result }); return result; });
    });
    const sendWindowMs = performance.now() - started, results = await Promise.all(pending);
    const summary = { name: prefix, wallStart, count: ids.length, sent: results.length, sendWindowMs,
      finalityMs: latencies(results.filter(r => r.status === 'finalized').map(r => r.elapsedMs)),
      settledMs: performance.now() - started, passed: results.every(r => r.status === 'finalized') };
    save(`${prefix}-summary`, summary); waves.push(summary); save(`${name}-progress`, { waves });
    await auditBurst({ name: prefix, expected: ids.length, results, operation, out, api, summary });
    return results;
  }
  async function unload(ids: number[], prefix: string, locate: (key: string, entropy: Uint8Array) => ProofRing, intoCoin: boolean, recycled: boolean, counter: number) {
    const timestamp = await api.query.Timestamp.Now.getValue();
    const period = Math.floor(Number(timestamp) / 86400000), prepared: Wire[] = [];
    for (const id of ids) {
      const a = actors[id], entropy = recycled ? a.recycledEntropy : a.entropy;
      const voucher = recycled ? a.recycledVoucher : a.voucher;
      const ring = locate(voucher.member_key, entropy);
      const tokenCounter = scenario === 'quota' ? id % quotaLimit : counter;
      const signer = unloadSigner({ person: personRing(a.person, a.personEntropy), vouchers: [ring], period, counter: tokenCounter,
        observe: timing => log(`${prefix}-proofs`, { actor: id, ...timing, cpu: process.cpuUsage(), memory: process.memoryUsage() }) });
      const args = { instance_id: instanceId, aliases: [Binary.toHex(voucherAlias(entropy))],
        value: denomination, index: ring.ring, revision: ring.revision, to: intoCoin ? a.payment.address : a.destination.address };
      const call = intoCoin ? api.tx.Coinage.unload_recycler_into_coin(args) : api.tx.Coinage.unload_recycler_into_external_asset({ ...args, max_fee: 0n });
      const options = unpaidTopUpOptions(0);
      const signed = await call.sign(signer, { ...options, mortality: { mortal: false }, customSignedExtensions: {
        ...options.customSignedExtensions, AsCoinage: { value: undefined },
      } });
      prepared.push(wire(signed));
      if (id % 10 === 0) await yieldLoop();
    }
    assert.equal(Math.floor(Number(await api.query.Timestamp.Now.getValue()) / 86400000), period, 'Period changed while preparing proofs');
    await execute(prefix, ids, prepared, intoCoin ? 'RecyclerUnloadedIntoCoin' : 'RecyclerUnloadedIntoExternalAsset');
    const at = await client.getFinalizedBlock();
    const { alias_in_context } = await import('verifiablejs/nodejs');
    const { tokenContext } = await import('../src/lib/coinage-unload.js');
    const tokens: unknown[] = [];
    await inGroups(ids, async id => {
      const alias = Binary.toHex(alias_in_context(actors[id].personEntropy, tokenContext(period, scenario === 'quota' ? id % quotaLimit : counter)));
      const consumed = await api.query.Coinage.ConsumedFreeUnloadTokens.getValue(period, alias, { at: at.hash });
      tokens.push({ actor: id, period, counter: scenario === 'quota' ? id % quotaLimit : counter, alias, consumed: consumed !== undefined });
      assert(consumed !== undefined, 'Successful unload token was not consumed');
    });
    save(`${prefix}-tokens`, { at, tokens });
  }
  try {
    await connectBurstProvider(sender);
    phase = `${name}: workload`;
    for (const [waveIndex, ids] of allGroups.entries()) {
      const prefix = `${name}-wave-${waveIndex + 1}`;
      let recyclerRing = fixtureRecyclerRing;
      if (scenario === 'full-flow') {
        const loads = await Promise.all(ids.map(async id => wire(await api.tx.Coinage.load_recycler_with_external_asset_unpaid(actors[id].voucher)
          .sign(signerFor(actors[id].coin), { ...unpaidTopUpOptions(0), mortality: { mortal: false } }))));
        await execute(`${prefix}-topup`, ids, loads, 'RecyclerLoadedWithExternalAsset');
        recyclerRing = await members(ids);
        await unload(ids, `${prefix}-payment`, recyclerRing, true, false, 0);
        const claims = await Promise.all(ids.map(async id => wire(await api.tx.Coinage.transfer({ to: actors[id].destination.address })
          .sign(signerFor(actors[id].payment), { ...coinClaimOptions(), mortality: { mortal: false } }))));
        await execute(`${prefix}-claim`, ids, claims, 'CoinTransferred');
        const claimedAt = await client.getFinalizedBlock();
        await inGroups(ids, async id => assert.deepEqual(await api.query.Coinage.CoinsByOwner.getValue(actors[id].destination.address, { at: claimedAt.hash }), { instance_id: instanceId, value: denomination, age: 1 }));
        const recycled = await Promise.all(ids.map(async id => wire(await api.tx.Coinage.load_recycler_with_coin({ member_key: actors[id].recycledVoucher.member_key,
          proof_of_ownership: actors[id].recycledVoucher.proof_of_ownership }).sign(signerFor(actors[id].destination), { ...coinClaimOptions(), mortality: { mortal: false } }))));
        await execute(`${prefix}-recycle`, ids, recycled, 'RecyclerLoadedWithCoin');
        recyclerRing = await members(ids, true);
      }
      assert(recyclerRing);
      await unload(ids, prefix, recyclerRing, false, scenario === 'full-flow', scenario === 'full-flow' ? 1 : 0);
      const at = await client.getFinalizedBlock();
      const states: unknown[] = [];
      await inGroups(ids, async id => {
        const a = actors[id], balance = await api.query.Assets.Account.getValue(asset, a.destination.address, { at: at.hash });
        const source = await api.query.Coinage.CoinsByOwner.getValue(a.coin.address, { at: at.hash });
        const recipient = await api.query.Coinage.CoinsByOwner.getValue(a.destination.address, { at: at.hash });
        const observation = { actor: id, balance: balance?.balance, source: source ?? null, recipient: recipient ?? null };
        states.push(observation); log(`${prefix}-state-observations`, { at, ...observation });
        assert.equal(balance?.balance, amount, 'Offboard amount differs');
        assert.equal(source, undefined); assert.equal(recipient, undefined);
      });
      const finalBacking = (await api.query.Assets.Account.getValue(asset, palletAccount, { at: at.hash }))?.balance;
      const completed = allGroups.slice(0, waveIndex + 1).flat().length;
      const expectedBacking = 1n;
      const heldBacking = await api.query.AssetsHolder.BalancesOnHold.getValue(asset, palletAccount, { at: at.hash }) ?? 0n;
      const expectedHeldBacking = scenario === 'full-flow' ? 0n : amount * BigInt(count - completed);
      save(`${prefix}-state`, { at, states, finalBacking, expectedBacking, heldBacking, expectedHeldBacking });
      assert.equal(heldBacking, expectedHeldBacking);
      assert.equal(finalBacking, expectedBacking);
    }
    if (scenario === 'quota') {
      const { alias_in_context } = await import('verifiablejs/nodejs');
      const { tokenContext } = await import('../src/lib/coinage-unload.js');
      const at = await client.getFinalizedBlock();
      const [limit] = await api.view.Coinage.get_free_unload_token_info({ at: at.hash });
      const period = Math.floor(Number(await api.query.Timestamp.Now.getValue({ at: at.hash })) / 86400000);
      const people = [...new Map(actors.map(a => [a.person, a])).values()];
      const rejected = [];
      for (const a of people) {
        const consumed = actors.filter(x => x.person === a.person).length;
        for (const remaining of [Math.floor(limit * .2) + 1, Math.floor(limit * .2), 0]) {
          for (const platform of ['android', 'ios'] as const) for (const age of [1, 14]) {
            log(`${name}-policy-model`, { platform, actor: a.id, at, period, limit, remaining, age,
              source: 'documented policy model; not a native wallet execution',
              ...recyclingDecision({ platform, age, maximumAge: 16, discretionary: true, limit, remaining }) });
          }
        }
        // Two real negative probes: duplicate a consumed token, and cross the allowance bound.
        for (const counter of [0, limit]) {
          const ring = fixtureRecyclerRing!(a.voucher.member_key, a.entropy);
          const signer = unloadSigner({ person: personRing(a.person, a.personEntropy), vouchers: [ring], period, counter });
          const options = unpaidTopUpOptions(0);
          const signed = await api.tx.Coinage.unload_recycler_into_external_asset({ instance_id: instanceId,
            aliases: [Binary.toHex(voucherAlias(a.entropy))], value: denomination, index: ring.ring, revision: ring.revision,
            to: encodeAddress(randomBytes(32)), max_fee: 0n }).sign(signer, { ...options, mortality: { mortal: false },
              customSignedExtensions: { ...options.customSignedExtensions, AsCoinage: { value: undefined } } });
          const result = await submit(wire(signed), 60000);
          const alias = Binary.toHex(alias_in_context(a.personEntropy, tokenContext(period, counter)));
          const after = await client.getFinalizedBlock();
          const tokenConsumed = await api.query.Coinage.ConsumedFreeUnloadTokens.getValue(period, alias, { at: after.hash });
          const record = { actor: a.id, person: a.person, period, counter, limit, consumedBefore: consumed,
            expected: counter === 0 ? 'duplicate token rejection' : 'counter out of range', ...result,
            tokenConsumedAfter: tokenConsumed !== undefined };
          rejected.push(record); save(`${name}-negative-probes`, rejected);
          assert.equal(result.status, 'submission-error', 'Negative probe did not produce an explicit validation rejection');
          const expectedCode = counter === 0 ? 57 : 58;
          assert(new RegExp(`(?:custom|error)[^0-9]*${expectedCode}(?:[^0-9]|$)`, 'i').test(String(result.error)), `Wrong rejection reason: ${String(result.error)}`);
          assert(counter === 0 || tokenConsumed === undefined, 'Out-of-range token was consumed');
        }
      }
      save(`${name}-quota`, { at, limit, people: people.length, unloadRequests: count, negativeProbes: rejected.length,
        rollover: 'not exercised by burst case; requires a separate real-period observation',
        policyExecution: 'separate model only' });
    }
    save(`${name}-summary`, { count, waves, elapsedMs: performance.now() - firstSubmission, passed: true });
  } finally { clearInterval(samples); await sender.disconnect(); }

}
try {
  save('unload-runtime', { version: await api.constants.System.Version(), scenario, users, mode, poolProfile, poolTransactions });
  await stage(1, `${scenario}-smoke`);
  if (process.env.SMOKE_ONLY !== 'true') await stage(users, `${scenario}-pilot`);
} catch (error) {
  save('unload-error', { phase, error: String(error), stack: error instanceof Error ? error.stack : undefined });
  console.error(error); process.exitCode = 1;
} finally { armShutdownDeadline(`${out}/unload-shutdown-error.json`); coinage.close(); }
