/** Default-pool sustained load. Inventory size is a ceiling, not a promised actor count. */
import assert from 'node:assert/strict';
import { RingProofPool } from '../src/lib/coinage-proof-pool.js';
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
import { sustainPool, type PoolTransition, type Supply } from '../src/lib/coinage-sustained.js';
import { readReadyPool } from '../src/lib/coinage-pool-metric.js';
import { unloadSigner, voucherAlias, tokenContext, type ProofRing } from '../src/lib/coinage-unload.js';
import { encodeMembers } from '../src/lib/ring.js';
import { member_from_entropy, alias_in_context } from 'verifiablejs/nodejs';

const proofPool = new RingProofPool();
const scenario = process.env.SCENARIO ?? 'claim';
const scenarios = ['topup', 'claim', 'split', 'recycle', 'merchant', 'quota', 'offboard', 'full-flow'];
assert(scenarios.includes(scenario));
assert((process.env.POOL_PROFILE ?? 'default') === 'default', 'Sustained test must use the default pool');
const count = Number(process.env.ACTOR_COUNT ?? '20000');
assert(Number.isInteger(count) && count >= 1 && count <= 250000);
const stateQueryConcurrency = 64;
// Offboarding 1,000 transactions took up to 285s in verified run 37593396451.
// Allow the proof-heavy inventory to drain; the measured hold stays at 180s.
const deadlineMs = ['quota', 'offboard', 'full-flow'].includes(scenario)
  ? Math.max(1_800_000, count * 600) : 1_800_000;
const smoke = process.env.SMOKE_ONLY === 'true';
const target = smoke ? 1 : 8000;
const durationMs = smoke ? 10000 : 180000;
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
let reached = 'startup';

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

type Stage = 'topup' | 'claim' | 'split' | 'recycle' | 'unload' | 'offboard' | 'done' | 'failed';
type Operation = Parameters<typeof auditBurst>[0]['operation'];
type Work = { actor: number; stage: Stage; operation: Operation; hex: string; txHash: string;
  period?: number; counter?: number; submissionPhase?: string; submittedAt?: string };

async function run() {
  const preparationStart = performance.now();
  const seedCoins = ['claim', 'merchant', 'split', 'recycle'].includes(scenario);
  const needsVoucher = ['topup', 'recycle', 'quota', 'offboard', 'full-flow'].includes(scenario);
  const needsPeople = ['quota', 'offboard', 'full-flow'].includes(scenario);
  const min = await api.constants.Coinage.MinimumExponent();
  const unit = 1n << BigInt(Math.max(0, -min)), denomination = scenario === 'split' ? 2 : 1;
  const amount = (1n << BigInt(denomination)) * unit;
  const asset = { parents: 0, interior: { type: 'X1' as const, value: {
    type: 'GeneralIndex' as const, value: BigInt('0x' + randomBytes(16).toString('hex')) } } };
  await fixture('create asset', api.tx.Sudo.sudo({ call: api.tx.Assets.force_create({
    id: asset, owner: { type: 'Id', value: admin.address }, is_sufficient: true, min_balance: 1n,
  }).decodedCall }), true);
  const palletBytes = new Uint8Array(32); palletBytes.set(new TextEncoder().encode('modlcoinage '));
  const palletAccount = AccountId().dec(palletBytes), backing = seedCoins ? amount * BigInt(count) + 1n : 1n;
  await fixture('seed backing', api.tx.Assets.mint({ id: asset, beneficiary: { type: 'Id', value: palletAccount }, amount: backing }));
  const instanceId = await api.query.Coinage.NextInstanceId.getValue();
  await fixture('create instance', api.tx.Sudo.sudo({ call: api.tx.Coinage.create_sufficient_instance({ asset_id: asset, asset_unit: unit }).decodedCall }), true);
  const [quotaLimit] = await api.view.Coinage.get_free_unload_token_info();
  assert(!needsPeople || quotaLimit > 1, 'Need free unload allowance');
  const personSecrets = Array.from({ length: needsPeople ? (scenario === 'quota' ? Math.ceil(count / quotaLimit) : count) : 0 }, () => randomBytes(32));
  const merchant = scenario === 'merchant' ? keyring.addFromSeed(randomBytes(32)) : undefined;
  if (merchant) keyring.removePair(merchant.address);
  const pair = () => { const p = keyring.addFromSeed(randomBytes(32)); keyring.removePair(p.address); return p; };
  const actors = Array.from({ length: count }, (_, id) => {
    const sourceKey = pair();
    const paymentKey = scenario === 'split' || scenario === 'full-flow' ? pair() : undefined;
    const destinationKey = scenario === 'full-flow' ? pair() : undefined;
    const source = sourceKey.address, payment = paymentKey?.address ?? encodeAddress(randomBytes(32));
    const destination = merchant ? merchant.derive(`//receipt//${id}`).address : destinationKey?.address ?? encodeAddress(randomBytes(32));
    const entropy = randomBytes(32), recycledEntropy = randomBytes(32);
    const personEntropy = needsPeople ? personSecrets[scenario === 'quota' ? Math.floor(id / quotaLimit) : id] : undefined;
    return { id, source, payment, destination,
      sourceSigner: (seedCoins ? capacitySigner(sourceKey.publicKey, data => sourceKey.sign(data)) : signerFor(sourceKey)) as ReturnType<typeof signerFor> | undefined,
      paymentSigner: paymentKey ? signerFor(paymentKey) : undefined,
      destinationSigner: destinationKey ? signerFor(destinationKey) : undefined,
      change: encodeAddress(randomBytes(32)), entropy, recycledEntropy, personEntropy,
      person: personEntropy ? Binary.toHex(member_from_entropy(personEntropy)) : undefined,
      voucher: needsVoucher ? topUpArguments(instanceId, denomination, source, entropy) : undefined,
      recycledVoucher: scenario === 'full-flow' ? topUpArguments(instanceId, denomination, destination, recycledEntropy) : undefined,
      started: false, stage: (scenario === 'full-flow' || scenario === 'topup' ? 'topup'
        : scenario === 'offboard' || scenario === 'quota' ? 'offboard'
        : scenario === 'merchant' ? 'claim' : scenario) as Stage };
  });
  const recognized = new Set<string>();
  reached = 'setup';
  // PAPI's submitAndWatch uses transaction_v1_broadcast, which this node caps at 16 active
  // broadcasts per connection. Beyond that it returns null, PAPI drops the error and the
  // transaction is never sent. Fixture loads use the same legacy watch path as the hold.
  const setupSender = new WsProvider('ws://127.0.0.1:10010', false, {}, 180_000);
  await connectBurstProvider(setupSender);
  const setupSubmit = burstSubmitter(setupSender, async hash => {
    const [block, events] = await Promise.all([
      client._request<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [hash]),
      api.query.System.Events.getValue({ at: hash }),
    ]);
    save(`sustained-setup-block-${Number.parseInt(block.block.header.number, 16)}`, { hash, block, events });
    return { number: Number.parseInt(block.block.header.number, 16), extrinsics: block.block.extrinsics, events };
  }, (txHash, observation) => log('sustained-setup-watch-transitions', { txHash, ...observation }));
  const setupOutcomes: Record<string, number> = {};
  try {
  for (let offset = 0; offset < count; offset += seedCoins ? 5000 : 100) {
    const batch = actors.slice(offset, offset + (seedCoins ? 5000 : 100));
    if (seedCoins) {
      const items = await Promise.all(batch.map(async a => [Binary.fromHex(await api.query.Coinage.CoinsByOwner.getKey(a.source)),
        codecs.query.Coinage.CoinsByOwner.value.enc({ instance_id: instanceId, value: denomination, age: 0 })] as [Uint8Array, Uint8Array]));
      await fixture('seed source coins', api.tx.Sudo.sudo({ call: api.tx.System.set_storage({ items }).decodedCall }), true);
    } else {
      const people = [...new Set(batch.flatMap(a => a.person ? [a.person] : []))].filter(p => !recognized.has(p));
      if (people.length) await fixture('recognize people', api.tx.Sudo.sudo({ call: api.tx.People.force_recognize_personhood({ people }).decodedCall }), true);
      people.forEach(p => recognized.add(p));
      await fixture('fund source accounts', api.tx.Utility.batch_all({ calls: batch.map(a => api.tx.Assets.mint({
        id: asset, beneficiary: { type: 'Id', value: a.source }, amount }).decodedCall) }));
      if (scenario === 'offboard' || scenario === 'quota') {
        // Keep every outcome in the batch before deciding; the first unresolved watch is not the whole story.
        const results = await Promise.all(batch.map(async a => {
          const signed = await api.tx.Coinage.load_recycler_with_external_asset_unpaid(a.voucher!)
            .sign(a.sourceSigner!, { ...unpaidTopUpOptions(0), mortality: { mortal: false } });
          return setupSubmit({ hex: Binary.toHex(signed), txHash: blake2AsHex(signed) }, 180_000);
        }));
        results.forEach((result, i) => {
          log('sustained-fixture-loads', { actor: batch[i].id, ...result });
          setupOutcomes[result.status] = (setupOutcomes[result.status] ?? 0) + 1;
        });
        save('sustained-setup-outcome', { requested: count, attempted: offset + batch.length, outcomes: setupOutcomes });
        const incomplete = results.length - results.filter(r => r.status === 'finalized').length;
        if (incomplete) throw new Error(`Setup top-ups incomplete: ${incomplete} of ${results.length} in batch at actor ${offset} did not finalize successfully`);
      }
    }
  }
  } finally { await setupSender.disconnect(); }
  const collectionBytes = new Uint8Array(32); collectionBytes.set(new TextEncoder().encode('coinage/recycler'));
  new DataView(collectionBytes.buffer).setUint32(16, instanceId, true); collectionBytes[20] = denomination;
  const recyclerCollection = Binary.toHex(collectionBytes);
  let peopleCollection: string | undefined;
  if (needsPeople) {
    const at = await client.getFinalizedBlock();
    const pages = await api.query.Members.RingKeys.getEntries({ at: at.hash });
    const ids = [...new Set(pages.filter(p => p.value.includes(actors[0].person!)).map(p => p.keyArgs[0]))];
    assert.equal(ids.length, 1); peopleCollection = ids[0];
  }
  const rings = new Map<string, Map<string, Omit<ProofRing, 'entropy'>>>();
  async function refreshRings(collection: string, exponent: 9 | 10, keys: Set<string>) {
    const at = await client.getFinalizedBlock(), opts = { at: at.hash };
    const [pages, statuses, roots] = await Promise.all([api.query.Members.RingKeys.getEntries(collection, opts),
      api.query.Members.RingKeysStatus.getEntries(collection, opts), api.query.Members.Root.getEntries(collection, opts)]);
    const found = readyMembers(pages, statuses, roots, keys), indexed = new Map<string, Omit<ProofRing, 'entropy'>>();
    const encoded = new Map<number, Uint8Array>();
    for (const [key, location] of found) {
      if (!encoded.has(location.ring)) encoded.set(location.ring, encodeMembers(pages.filter(p => p.keyArgs[1] === location.ring)
        .sort((a, b) => a.keyArgs[2] - b.keyArgs[2]).flatMap(p => p.value).slice(0, location.included).map(k => Binary.fromHex(k))));
      indexed.set(key, { exponent, ring: location.ring, revision: location.revision, members: encoded.get(location.ring)! });
    }
    rings.set(collection, indexed);
    log('sustained-readiness', { at, collection, ready: found.size, expected: keys.size });
    save(collection === peopleCollection ? 'sustained-people-rings' : 'sustained-recycler-rings', { at, pages, statuses, roots });
    return found.size;
  }
  async function awaitRings(collection: string, exponent: 9 | 10, keys: Set<string>) {
    const deadline = performance.now() + deadlineMs;
    while (await refreshRings(collection, exponent, keys) !== keys.size) {
      assert(performance.now() < deadline, 'Ring readiness timeout'); await delay(2000);
    }
  }
  if (peopleCollection) await awaitRings(peopleCollection, 9, new Set(actors.map(a => a.person!)));
  if (scenario === 'offboard' || scenario === 'quota') await awaitRings(recyclerCollection, 10, new Set(actors.map(a => a.voucher!.member_key)));

  async function prepare(id: number): Promise<Work | undefined> {
    const a = actors[id], stage = a.stage;
    const options = { ...coinClaimOptions(), mortality: { mortal: false as const } };
    let signed: Uint8Array, operation: Operation, period: number | undefined, counter: number | undefined;
    if (stage === 'topup') {
      signed = await api.tx.Coinage.load_recycler_with_external_asset_unpaid(a.voucher!).sign(a.sourceSigner!, { ...unpaidTopUpOptions(0), mortality: { mortal: false } });
      operation = 'RecyclerLoadedWithExternalAsset';
    } else if (stage === 'claim') {
      signed = await api.tx.Coinage.transfer({ to: a.destination }).sign((scenario === 'split' || scenario === 'full-flow' ? a.paymentSigner! : a.sourceSigner!), options);
      operation = 'CoinTransferred';
    } else if (stage === 'split') {
      signed = await api.tx.Coinage.split({ split_into: [[1, [a.payment, a.change]]] }).sign(a.sourceSigner!, options);
      operation = 'CoinSplit';
    } else if (stage === 'recycle') {
      const voucher = scenario === 'full-flow' ? a.recycledVoucher! : a.voucher!;
      signed = await api.tx.Coinage.load_recycler_with_coin({ member_key: voucher.member_key, proof_of_ownership: voucher.proof_of_ownership })
        .sign((scenario === 'full-flow' ? a.destinationSigner! : a.sourceSigner!), options);
      operation = 'RecyclerLoadedWithCoin';
    } else {
      assert(stage === 'unload' || stage === 'offboard');
      const recycled = scenario === 'full-flow' && stage === 'offboard';
      const voucher = recycled ? a.recycledVoucher! : a.voucher!, entropy = recycled ? a.recycledEntropy : a.entropy;
      const recycler = rings.get(recyclerCollection)?.get(voucher.member_key);
      if (!recycler) return undefined;
      const person = rings.get(peopleCollection!)!.get(a.person!)!;
      period = Math.floor(Number(await api.query.Timestamp.Now.getValue()) / 86400000);
      counter = scenario === 'quota' ? a.id % quotaLimit : recycled ? 1 : 0;
      const signer = unloadSigner({ prove: proofPool.prove, person: { ...person, entropy: a.personEntropy! }, vouchers: [{ ...recycler, entropy }], period, counter,
        observe: timing => log('sustained-proofs', { actor: id, stage, ...timing }) });
      const args = { instance_id: instanceId, aliases: [Binary.toHex(voucherAlias(entropy))], value: denomination,
        index: recycler.ring, revision: recycler.revision, to: stage === 'unload' ? a.payment : a.destination };
      const call = stage === 'unload' ? api.tx.Coinage.unload_recycler_into_coin(args)
        : api.tx.Coinage.unload_recycler_into_external_asset({ ...args, max_fee: 0n });
      const unpaid = unpaidTopUpOptions(0);
      signed = await call.sign(signer, { ...unpaid, mortality: { mortal: false }, customSignedExtensions: { ...unpaid.customSignedExtensions, AsCoinage: { value: undefined } } });
      operation = stage === 'unload' ? 'RecyclerUnloadedIntoCoin' : 'RecyclerUnloadedIntoExternalAsset';
    }
    return { actor: id, stage, operation, period, counter, hex: Binary.toHex(signed), txHash: blake2AsHex(signed) };
  }

  const initial: Work[] = [];
  for (let offset = 0; offset < actors.length; offset += proofPool.size) {
    await Promise.all(actors.slice(offset, offset + proofPool.size).map(async (a, index) => {
      const work = await prepare(a.id); assert(work);
      initial[offset + index] = work; a.sourceSigner = undefined;
    }));
    await yieldLoop();
  }
  save('sustained-fixture', { scenario, inventory: count, instanceId, asset, unit, amount, backing, palletAccount,
    quotaLimit, peopleCount: personSecrets.length, peopleCollection, recyclerCollection, seedCoins,
    observationDeadlineMs: deadlineMs, preparationMs: performance.now() - preparationStart, proofWorkers: proofPool.size, nativeWallet: false,
    actors: actors.map(a => ({ id: a.id, source: a.source, payment: a.payment, recipient: a.destination,
      change: a.change, person: a.person, member: a.voucher?.member_key, recycledMember: a.recycledVoucher?.member_key })) });
  log('sustained-phases', { phase: 'prepared', wallTime: new Date().toISOString() });
  reached = 'hold';
  const sender = new WsProvider('ws://127.0.0.1:10010', false, {}, deadlineMs);
  const notifications = new Map<string, (state: PoolTransition) => void>();
  const submit = burstSubmitter(sender, async hash => {
    const [block, events] = await Promise.all([client._request<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [hash]),
      api.query.System.Events.getValue({ at: hash })]);
    save(`sustained-block-${Number.parseInt(block.block.header.number, 16)}`, { hash, block, events });
    return { number: Number.parseInt(block.block.header.number, 16), extrinsics: block.block.extrinsics, events };
  }, (hash, observation) => {
    log('sustained-watch-transitions', { txHash: hash, ...observation });
    const notify = notifications.get(hash), status = observation.status;
    if (status === 'ready' || status === 'future') notify?.('ready');
    else if (typeof status === 'object' && status && 'inBlock' in status) notify?.('in-block');
    else if (typeof status === 'object' && status && 'retracted' in status) notify?.('retracted');
  });
  const completed: Array<{ work: Work; result: BurstResult }> = [];
  const followups: number[] = [];
  let nextInitial = 0, followupIndex = 0, inFlight = 0, phase = 'fill';
  let lastRefresh = 0;
  async function nextFollowup(): Promise<Work | undefined> {
    if (followupIndex > 4096) { followups.splice(0, followupIndex); followupIndex = 0; }
    if (followupIndex === followups.length) return undefined;
    if (scenario === 'full-flow' && performance.now() - lastRefresh > 2000) {
      await refreshRings(recyclerCollection, 10, new Set(actors.flatMap(a => a.started ? [a.voucher!.member_key, a.recycledVoucher!.member_key] : [])));
      lastRefresh = performance.now();
    }
    // Try each currently waiting actor once; an unbuilt ring must not block other ready work.
    const length = followups.length;
    for (let i = followupIndex; i < length; i++) {
      const id = followups[followupIndex++], work = await prepare(id);
      if (work) return work;
      followups.push(id);
    }
    return undefined;
  }
  async function offer(): Promise<Supply<Work>> {
    const following = await nextFollowup();
    if (following) return { kind: 'work', work: following };
    if (nextInitial < initial.length) return { kind: 'work', work: initial[nextInitial++] };
    return { kind: inFlight || followupIndex < followups.length ? 'wait' : 'exhausted' };
  }
  async function send(work: Work, notify: (state: PoolTransition) => void) {
    work.submissionPhase = phase; work.submittedAt = new Date().toISOString();
    actors[work.actor].started = true;
    notifications.set(work.txHash, notify); inFlight++;
    log('sustained-signed', { ...work, phase, wallTime: new Date().toISOString() });
    try {
      const result = await submit(work, deadlineMs);
      if (result.status === 'submission-error' && /1016|pool.*limit|Immediately Dropped/i.test(String(result.error ?? ''))) {
        notify('rejected');
      } else if (result.status === 'dispatch-error') {
        notify('failed');
      } else if (result.status !== 'finalized') {
        // A terminated watch does not establish that the transaction left every pool view.
        notify('unresolved');
      }
      return result;
    }
    finally { inFlight--; notifications.delete(work.txHash); notify('terminal'); }
  }
  function finish(work: Work, result: BurstResult) {
    log('sustained-transactions', { actor: work.actor, stage: work.stage, phase: work.submissionPhase, submittedAt: work.submittedAt, ...result });
    completed.push({ work, result });
    const a = actors[work.actor];
    if (result.status !== 'finalized') { a.stage = 'failed'; return; }
    if (scenario === 'split' && work.stage === 'split') a.stage = 'claim';
    else if (scenario === 'full-flow') {
      const next: Partial<Record<Stage, Stage>> = { topup: 'unload', unload: 'claim', claim: 'recycle', recycle: 'offboard', offboard: 'done' };
      a.stage = next[work.stage]!;
    } else a.stage = 'done';
    if (a.stage !== 'done') followups.push(a.id);
  }
  await connectBurstProvider(sender);
  try {
    const endpoints = JSON.parse(readFileSync(`${out}/metrics-endpoints.json`, 'utf8'));
    const metricsUrl = endpoints['Collator-1502']; assert.equal(typeof metricsUrl, 'string');
    // The pinned fork-aware pool admits ready.count + future.count globally (8192 + 819).
    // Inclusion can leave a transaction in that mempool until finality. Reserve 32 entries
    // for maintenance traffic; this is a client bound, never a node configuration change.
    // SDK: polkadot-weekly2026w33-rc2, transaction-pool/src/{builder,fork_aware_txpool/fork_aware_txpool}.rs.
    const pressure = await sustainPool({ target, poolLimit: 8192, admissionLimit: 9011,
      maxOutstanding: 9011 - 32, durationMs, fillTimeoutMs: 600000,
      release: work => { if (actors[work.actor].started) followups.push(work.actor); },
      readReady: () => readReadyPool(metricsUrl), next: offer, submit: send, recordResult: finish,
      recordSample: sample => { phase = sample.phase; log('sustained-pool', { ...sample, wallTime: new Date().toISOString(), memory: process.memoryUsage(), cpu: process.cpuUsage() }); } });
    save('sustained-pressure', pressure);
    // The controller has stopped new submissions and drained its watches. Measure the
    // observed pool drain before completing any remaining dependent lifecycle steps.
    const drainStart = performance.now();
    while (await readReadyPool(metricsUrl) > 0) {
      assert(performance.now() - drainStart < deadlineMs, 'Pool did not drain'); await delay(1000);
    }
    save('sustained-drain', { afterWatchDrainMs: performance.now() - drainStart, watchDrainMs: pressure.drainMs });
    phase = 'flow-completion';
    const completionStart = performance.now();
    while (followupIndex < followups.length) {
      assert(performance.now() - completionStart < deadlineMs, 'Dependent flow completion timed out');
      const batch: Work[] = [];
      for (let i = 0; i < 128; i++) { const work = await nextFollowup(); if (!work) break; batch.push(work); }
      await Promise.all(batch.map(async work => finish(work, await send(work, () => {}))));
      if (!batch.length) await delay(2000);
    }
    const completionMs = performance.now() - completionStart;
    const auditErrors: string[] = [];
    for (const operation of new Set(completed.map(row => row.work.operation))) {
      const results = completed.filter(row => row.work.operation === operation).map(row => row.result);
      const name = `sustained-${operation}`;
      const summary = { passed: results.every(r => r.status === 'finalized'), expected: results.length };
      save(`${name}-summary`, summary);
      try { await auditBurst({ name, expected: results.length, results, operation, out, api, summary }); }
      catch (error) { auditErrors.push(`${operation}: ${String(error)}`); }
    }
    const at = await client.getFinalizedBlock(), stateErrors: string[] = [];
    const startedActors = actors.filter(a => a.started);
    await inGroups(startedActors, async a => {
      const [source, payment, recipient, change, external, sourceExternal] = await Promise.all([
        api.query.Coinage.CoinsByOwner.getValue(a.source, { at: at.hash }),
        api.query.Coinage.CoinsByOwner.getValue(a.payment, { at: at.hash }),
        api.query.Coinage.CoinsByOwner.getValue(a.destination, { at: at.hash }),
        api.query.Coinage.CoinsByOwner.getValue(a.change, { at: at.hash }),
        api.query.Assets.Account.getValue(asset, a.destination, { at: at.hash }),
        seedCoins ? Promise.resolve(undefined) : api.query.Assets.Account.getValue(asset, a.source, { at: at.hash }),
      ]);
      log('sustained-state', { at, actor: a.id, stage: a.stage, source: source ?? null, payment: payment ?? null,
        recipient: recipient ?? null, change: change ?? null, external: external ?? null, sourceExternal: sourceExternal ?? null });
      try {
        assert.equal(a.stage, 'done'); assert.equal(source, undefined); assert.equal(payment, undefined);
        if (!seedCoins) assert.equal(sourceExternal?.balance ?? 0n, 0n, 'Source asset was not debited');
        if (scenario === 'claim' || scenario === 'merchant' || scenario === 'split') {
          assert.deepEqual(recipient, { instance_id: instanceId, value: 1, age: scenario === 'split' ? 2 : 1 });
          if (scenario === 'split') assert.deepEqual(change, { instance_id: instanceId, value: 1, age: 1 });
        } else assert.equal(recipient, undefined);
        if (['quota', 'offboard', 'full-flow'].includes(scenario)) assert.equal(external?.balance, amount);
      } catch (error) { stateErrors.push(`actor ${a.id}: ${String(error)}`); }
    });
    const finalBacking = (await api.query.Assets.Account.getValue(asset, palletAccount, { at: at.hash }))?.balance;
    const heldBacking = await api.query.AssetsHolder.BalancesOnHold.getValue(asset, palletAccount, { at: at.hash }) ?? 0n;
    const offboards = completed.filter(r => r.work.stage === 'offboard' && r.result.status === 'finalized').length;
    const topups = completed.filter(r => r.work.stage === 'topup' && r.result.status === 'finalized').length;
    const expectedHeld = seedCoins ? 0n : amount * BigInt((scenario === 'offboard' || scenario === 'quota' ? count : topups) - offboards);
    if (finalBacking !== backing || heldBacking !== expectedHeld) stateErrors.push('Backing differs');
    await inGroups(completed.filter(row => row.work.period !== undefined && row.result.status === 'finalized'), async ({ work, result }) => {
      const alias = Binary.toHex(alias_in_context(actors[work.actor].personEntropy!, tokenContext(work.period!, work.counter!)));
      assert(result.block);
      const consumed = await api.query.Coinage.ConsumedFreeUnloadTokens.getValue(work.period!, alias, { at: result.block.hash });
      log('sustained-tokens', { at: result.block, actor: work.actor, period: work.period, counter: work.counter, alias, consumed: consumed !== undefined });
      if (consumed === undefined) stateErrors.push(`Token missing for ${work.actor}/${work.stage}`);
    });
    if (scenario === 'topup' || scenario === 'recycle') {
      await awaitRings(recyclerCollection, 10, new Set(startedActors.filter(a => a.stage === 'done').map(a => a.voucher!.member_key)));
    }
    const summary = { scenario, runtime: await api.constants.System.Version(), poolProfile: 'default', pressure,
      admittedActors: startedActors.length, inventory: count, transactions: completed.length, completionMs,
      finalized: completed.filter(r => r.result.status === 'finalized').length, auditErrors, stateErrors,
      at, finalBacking, backing, heldBacking, expectedHeld,
      callMix: Object.fromEntries([...new Set(completed.map(r => r.work.operation))].map(op => [op, completed.filter(r => r.work.operation === op).length])),
      callMixBySubmissionPhase: Object.fromEntries(['fill', 'hold', 'flow-completion'].map(p => [p,
        Object.fromEntries([...new Set(completed.map(r => r.work.operation))].map(op => [op,
          completed.filter(r => r.work.operation === op && r.work.submissionPhase === p).length]))])),
      quotaCoverage: scenario === 'quota' ? 'Valid unloads grouped by person allowance; boundary probes and period rollover are separate cases' : undefined,
      workloadPassed: completed.length > 0 && !auditErrors.length && !stateErrors.length && !pressure.asyncErrors.length
        && completed.filter(r => r.work.submissionPhase !== 'flow-completion').length === pressure.submitted,
      pressurePassed: pressure.holdCompleted && pressure.reason === 'hold-complete' && (smoke || pressure.fractionOfRequestedHoldInBand >= .95),
      smokeOnly: smoke,
      boundary: 'Fixed plans with fixture inventory; flow-completion calls after pool drain are outside the pressure window' };
    save('sustained-summary', summary);
    assert(summary.workloadPassed && summary.pressurePassed, 'Workload correctness or achieved pressure failed; see separate result fields');
  } finally { await sender.disconnect(); }
}

try {
  save('sustained-runtime', { version: await api.constants.System.Version(), scenario, inventory: count,
    poolProfile: 'default', target, durationMs, smoke });
  await run();
}
catch (error) { save('sustained-error', { phase: reached, error: String(error), stack: error instanceof Error ? error.stack : undefined }); console.error(error); process.exitCode = 1; }
finally { armShutdownDeadline(`${out}/sustained-shutdown-error.json`); await proofPool.close(); coinage.close(); }
