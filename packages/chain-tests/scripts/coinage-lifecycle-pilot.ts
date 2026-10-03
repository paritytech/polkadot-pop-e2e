/** Split-and-claim or recycling pilot on a disposable PreviewNet; fixed plans, real calls. */
import assert from 'node:assert/strict';
import { WsProvider } from '@polkadot/api';
import { burstSubmitter, connectBurstProvider, type BurstResult } from '../src/lib/coinage-burst-submit.js';
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

import { checkSplitState, readyMembers } from '../src/lib/coinage-lifecycle.js';

const scenario = process.env.SCENARIO ?? 'split';
assert(scenario === 'split' || scenario === 'recycle');
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

async function stage(count: number, name: string) {
  const prepStart = performance.now();
  const [min, max] = await Promise.all([
    api.constants.Coinage.MinimumExponent(), api.constants.Coinage.MaximumExponent(),
  ]);
  const unit = 1n << BigInt(Math.max(0, -min));
  const denomination = scenario === 'split' ? 2 : 1;
  if (scenario === 'split') {
    assert(await api.constants.Coinage.MaxSplitOutputs() >= 2);
    assert(min <= 1 && max >= 2);
  }
  const amount = coinValueToAssetAmount(denomination, unit, min, max);
  const asset = { parents: 0, interior: { type: 'X1' as const,
    value: { type: 'GeneralIndex' as const, value: BigInt('0x' + randomBytes(16).toString('hex')) } } };
  assert.equal(await api.query.Assets.Asset.getValue(asset), undefined);
  await fixture('create sufficient asset', api.tx.Sudo.sudo({ call: api.tx.Assets.force_create({
    id: asset, owner: { type: 'Id', value: admin.address }, is_sufficient: true, min_balance: 1n,
  }).decodedCall }), true);
  const palletBytes = new Uint8Array(32);
  palletBytes.set(new TextEncoder().encode('modlcoinage '));
  const palletAccount = AccountId().dec(palletBytes);
  const backing = amount * BigInt(count) + 1n;
  await fixture('back seeded coins plus minimum balance', api.tx.Assets.mint({
    id: asset, beneficiary: { type: 'Id', value: palletAccount }, amount: backing,
  }));
  const instanceId = await api.query.Coinage.NextInstanceId.getValue();
  await fixture('create sufficient instance', api.tx.Sudo.sudo({ call:
    api.tx.Coinage.create_sufficient_instance({ asset_id: asset, asset_unit: unit }).decodedCall,
  }), true);
  const actors = Array.from({ length: count }, (_, id) => {
    const source = keyring.addFromSeed(randomBytes(32));
    keyring.removePair(source.address);
    const recipient = encodeAddress(randomBytes(32));
    const payment = keyring.addFromSeed(randomBytes(32));
    keyring.removePair(payment.address);
    const change = encodeAddress(randomBytes(32));
    const voucher = topUpArguments(instanceId, denomination, source.address, randomBytes(32));
    return { id, source: source.address, recipient, payment: payment.address, change, voucher,
      paymentSigner: capacitySigner(payment.publicKey, data => payment.sign(data)) as ReturnType<typeof capacitySigner> | undefined,
      signer: capacitySigner(source.publicKey, data => source.sign(data)) as ReturnType<typeof capacitySigner> | undefined };
  });
  assert.equal(new Set(actors.flatMap(a => [a.source, a.recipient, a.payment, a.change])).size, count * 4);
  const originalCoin = { instance_id: instanceId, value: denomination, age: 0 };
  for (let offset = 0; offset < count; offset += fixtureBatch) {
    const items: [Uint8Array, Uint8Array][] = await Promise.all(actors.slice(offset, offset + fixtureBatch).map(async actor => [
      Binary.fromHex(await api.query.Coinage.CoinsByOwner.getKey(actor.source)),
      codecs.query.Coinage.CoinsByOwner.value.enc(originalCoin),
    ] as [Uint8Array, Uint8Array]));
    await fixture(`seed source coins ${offset}..${Math.min(offset + fixtureBatch, count) - 1}`,
      api.tx.Sudo.sudo({ call: api.tx.System.set_storage({ items }).decodedCall }), true);
  }
  const { hash: at, number: startingBlock } = await client.getFinalizedBlock();
  const instance = await api.query.Coinage.Instances.getValue(instanceId, { at });
  assert.equal(instance?.mode.type, 'Sufficient');
  assert.deepEqual(instance.asset_id, asset);
  assert.equal(instance.asset_unit, unit);
  assert.equal((await api.query.Assets.Account.getValue(asset, palletAccount, { at }))?.balance, backing);
  await inGroups(actors, async actor => {
    assert.deepEqual(await api.query.Coinage.CoinsByOwner.getValue(actor.source, { at }), originalCoin);
    for (const address of [actor.payment, actor.change, actor.recipient]) {
      assert.equal(await api.query.Coinage.CoinsByOwner.getValue(address, { at }), undefined);
    }
  });
  const prepareStart = performance.now();
  const prepared: Array<{ hex: string; txHash: string }> = new Array(count);
  await inGroups(actors, async actor => {
    const call = scenario === 'split'
      ? api.tx.Coinage.split({ split_into: [[1, [actor.payment, actor.change]]] })
      : api.tx.Coinage.load_recycler_with_coin({ member_key: actor.voucher.member_key,
        proof_of_ownership: actor.voucher.proof_of_ownership });
    const signed = await call.sign(actor.signer!, { ...coinClaimOptions(), mortality: { mortal: false } });
    prepared[actor.id] = { hex: Binary.toHex(signed), txHash: blake2AsHex(signed) };
    actor.signer = undefined;
  });
  const collectionBytes = new Uint8Array(32);
  collectionBytes.set(new TextEncoder().encode('coinage/recycler'));
  new DataView(collectionBytes.buffer).setUint32(16, instanceId, true);
  collectionBytes[20] = denomination;
  const collection = Binary.toHex(collectionBytes);
  if (scenario === 'recycle') {
    assert(await api.query.Members.Collections.getValue(collection, { at }), 'Recycler collection missing');
  }
  save(`${name}-fixture`, { scenario, count, instanceId, instance, asset, unit, denomination,
    originalCoin, backing, palletAccount, startingBlock, at, collection,
    mode: name.endsWith('-smoke') ? 'burst' : mode, poolProfile, poolTransactions: poolProfile === 'enlarged' ? poolTransactions : undefined,
    poolKbytes: poolProfile === 'enlarged' ? 262144 : undefined, deadlineMs, launchTargetMs, syntheticDelayMs: 0,
    fixtureMethod: 'root-seeded coins; backing minted, issuance and wrapped-hold setup bypassed',
    preparationMs: performance.now() - prepStart, signingMs: performance.now() - prepareStart,
    mortality: 'immortal (disposable fork only)',
    actors: actors.map(a => ({ id: a.id, source: a.source, payment: a.payment, change: a.change,
      recipient: a.recipient, memberKey: a.voucher.member_key })) });
  console.log(json({ phase: 'prepared', scenario, name, count }));
  const sender = new WsProvider('ws://127.0.0.1:10010', false, {}, deadlineMs);
  const submit = burstSubmitter(sender, async hash => {
    const [block, events] = await Promise.all([
      client._request<{ block: { header: { number: string }; extrinsics: string[] } }>('chain_getBlock', [hash]),
      api.query.System.Events.getValue({ at: hash, signal: AbortSignal.timeout(15_000) }),
    ]);
    mkdirSync(`${out}/${name}-observed-blocks`, { recursive: true });
    writeCapacityJson(`${out}/${name}-observed-blocks/${hash}.json`, { hash, block, events });
    return { number: Number.parseInt(block.block.header.number, 16), extrinsics: block.block.extrinsics, events };
  }, (txHash, observation) => log(`${name}-watch-transitions`, { txHash, ...observation }));
  let guard: string | undefined;
  let stopped = false;
  let observer: Promise<void> | undefined;
  const expectedMembers = new Set(actors.map(a => a.voucher.member_key));
  const readiness = new Map<string, { elapsedMs: number; at: string; ring: number; position: number; included: number; revision: number }>();
  let cutoff: { elapsedMs: number; at: string } | undefined;
  let ringEvidence: unknown;
  let firstStarted = 0;
  let lastSettled = 0;
  let observationDeadline = Infinity;
  const memberSentAt = new Map<string, number>();
  const summaries: Record<string, unknown>[] = [];
  async function checkState(label: string, claimed: boolean, actorIds: number[]) {
    const block = await client.getFinalizedBlock();
    const states: unknown[] = [];
    const errors: unknown[] = [];
    await inGroups(actorIds.map(i => actors[i]), async a => {
      try {
        const options = { at: block.hash, signal: AbortSignal.timeout(15_000) };
        const [source, payment, change, recipient, member] = await Promise.all([
          api.query.Coinage.CoinsByOwner.getValue(a.source, options),
          api.query.Coinage.CoinsByOwner.getValue(a.payment, options),
          api.query.Coinage.CoinsByOwner.getValue(a.change, options),
          api.query.Coinage.CoinsByOwner.getValue(a.recipient, options),
          scenario === 'recycle' ? api.query.Coinage.RecyclersCoinToRecycler.getValue(a.voucher.member_key, options) : undefined,
        ]);
        states.push({ actor: a.id, source: source ?? null, payment: payment ?? null,
          change: change ?? null, recipient: recipient ?? null, member: member ?? null });
        if (scenario === 'split') checkSplitState(instanceId, claimed, { source, payment, change, recipient });
        else { assert.equal(source, undefined); assert.deepEqual(member, [instanceId, denomination]); }
      } catch (error) { errors.push({ actor: a.id, error: String(error) }); }
    });
    const finalBacking = (await api.query.Assets.Account.getValue(asset, palletAccount,
      { at: block.hash, signal: AbortSignal.timeout(15_000) }))?.balance;
    if (finalBacking !== backing) errors.push({ error: 'Backing changed' });
    const state = { scenario, at: block, instanceId, denomination, claimed, count: actorIds.length, actorIds,
      backing, finalBacking, states, errors, passed: errors.length === 0 && states.length === actorIds.length };
    save(`${label}-state`, state);
    return state;
  }
  async function wave(label: string, wire: typeof prepared, operation: 'CoinSplit' | 'CoinTransferred' | 'RecyclerLoadedWithCoin', claimed: boolean, actorIds: number[]) {
    save(`${label}-signed`, wire.map((tx, actor) => ({ actor, sourceActor: actorIds[actor], ...tx })));
    const started = performance.now();
    firstStarted ||= started;
    observationDeadline = started + deadlineMs;
    const results: BurstResult[] = [];
    const sentAt: number[] = [];
    const pending: Promise<void>[] = [];
    for (let i = 0; i < wire.length && !guard; i++) {
      sentAt[i] = performance.now() - started;
      memberSentAt.set(actors[actorIds[i]].voucher.member_key, started - firstStarted + sentAt[i]);
      pending.push(submit(wire[i], Math.max(1, Math.floor(deadlineMs - (performance.now() - started)))).then(result => {
        log(`${label}-transactions`, { actor: i, sourceActor: actorIds[i], sentAtMs: sentAt[i], ...result });
        result.rpcObservations = [];
        results[i] = result;
      }));
      if (i % 100 === 99) await yieldLoop();
    }
    const sendWindowMs = performance.now() - started;
    await Promise.all(pending);
    lastSettled = performance.now();
    const state = await checkState(label, claimed, actorIds);
    const finalized = results.filter(r => r.status === 'finalized').length;
    const summary = { name: label, scenario, count: actorIds.length, actorIds, startedMs: started - firstStarted, sent: sentAt.length, finalized,
      generatorLimited: sendWindowMs > launchTargetMs, sendWindowMs, launchTargetMs,
      finalityMs: latencies(results.filter(r => r.status === 'finalized').map(r => r.elapsedMs)),
      settledMs: lastSettled - started, guard, stateVerified: state.passed,
      passed: !guard && state.passed && sentAt.length === actorIds.length && finalized === actorIds.length && sendWindowMs <= launchTargetMs };
    summaries.push(summary); save(`${label}-summary`, summary);
    console.log(json({ ...summary, actorIds: undefined }));
    const audit = await auditBurst({ name: label, expected: actorIds.length, results, operation, out, api, summary, requireScenarioPass: false });
    assert(!guard && state.passed && sentAt.length === actorIds.length && finalized === actorIds.length,
      `${label}: unsafe to continue after incomplete execution or failed state checks`);
    // Event fields are part of the scenario, not only the generic event-name audit.
    for (const receipt of JSON.parse(readFileSync(`${out}/${label}-receipts.json`, 'utf8'))) {
      const event = receipt.events.find((e: { type: string; value: { type: string } }) => e.type === 'Coinage' && e.value.type === operation);
      assert.equal(event.value.value.instance_id, instanceId);
      if (operation === 'CoinSplit') assert.equal(event.value.value.output_count, 2);
      if (operation === 'RecyclerLoadedWithCoin') assert.equal(event.value.value.value, denomination);
      if (operation === 'CoinTransferred') {
        assert.equal(event.value.value.to, actors[actorIds[receipt.actor]].recipient);
        assert.equal(event.value.value.value, 1);
        assert.equal(event.value.value.new_age, 2);
      }
    }
    return { audit, sentAt, started };
  }
  try {
    await connectBurstProvider(sender);
    let lastHash = (await client.getFinalizedBlock()).hash;
    let lastProgress = performance.now();
    const observationStart = performance.now();
    observer = (async () => {
      while (!stopped) {
        try {
          const block = await client.getFinalizedBlock();
          if (block.hash !== lastHash) { lastHash = block.hash; lastProgress = performance.now(); }
          if (performance.now() - lastProgress > 60_000) guard = 'People finality stalled for 60 seconds';
          if (scenario === 'recycle') {
            const options = { at: block.hash, signal: AbortSignal.timeout(15_000) };
            const [pages, statuses, roots, queue] = await Promise.all([
              api.query.Members.RingKeys.getEntries(collection, options),
              api.query.Members.RingKeysStatus.getEntries(collection, options),
              api.query.Members.Root.getEntries(collection, options),
              api.query.Members.QueuePageIndices.getValue(collection, options),
            ]);
            const elapsedMs = performance.now() - (firstStarted || observationStart);
            if (firstStarted && performance.now() <= observationDeadline) {
              cutoff = { elapsedMs, at: block.hash };
              ringEvidence = { ...cutoff, collection, pages, statuses, roots, queue };
              const newlyReady: unknown[] = [];
              for (const [member, proof] of readyMembers(pages, statuses, roots, expectedMembers)) {
                if (!readiness.has(member)) {
                  readiness.set(member, { ...cutoff, ...proof });
                  newlyReady.push({ member, ...readiness.get(member) });
                }
              }
              if (newlyReady.length) log(`${name}-readiness-evidence`, { newlyReady, evidence: ringEvidence });
            }
          }
          log(`${name}-samples`, { elapsedMs: performance.now() - observationStart, block,
            ready: readiness.size, guard, cpu: process.cpuUsage(), memory: process.memoryUsage() });
        } catch (error) { guard = `Observer error: ${String(error)}`; log(`${name}-samples`, { guard }); }
        if (!stopped) await delay(5000);
      }
    })();
    const groups = mode === 'paced' && !name.endsWith('-smoke')
      ? [Array.from({ length: 8000 }, (_, i) => i), Array.from({ length: 2000 }, (_, i) => i + 8000)]
      : [actors.map(a => a.id)];
    const groupResults: unknown[] = [];
    for (const [index, actorIds] of groups.entries()) {
      const prefix = groups.length === 1 ? name : `${name}-wave-${index + 1}`;
      const first = await wave(`${prefix}-${scenario}`, actorIds.map(i => prepared[i]),
        scenario === 'split' ? 'CoinSplit' : 'RecyclerLoadedWithCoin', false, actorIds);
      if (scenario === 'split') {
        const signingStart = performance.now();
        const claims: typeof prepared = new Array(actorIds.length);
        await inGroups(actorIds, async (id, position) => {
          const actor = actors[id];
          const signed = await api.tx.Coinage.transfer({ to: actor.recipient }).sign(actor.paymentSigner!,
            { ...coinClaimOptions(), mortality: { mortal: false } });
          claims[position] = { hex: Binary.toHex(signed), txHash: blake2AsHex(signed) };
          actor.paymentSigner = undefined;
        });
        save(`${prefix}-claim-preparation`, { signingMs: performance.now() - signingStart,
          barrierMs: signingStart - lastSettled, note: 'Includes split state and receipt audit; not a wallet memo simulation' });
        await wave(`${prefix}-claim`, claims, 'CoinTransferred', true, actorIds);
      } else {
        const groupReady = () => actorIds.every(i => readiness.has(actors[i].voucher.member_key));
        while (!guard && !groupReady() && performance.now() - first.started < deadlineMs) await delay(1000);
        if (!groupReady()) guard ??= `Readiness deadline: group ${index + 1}`;
      }
      groupResults.push({ index, actorIds, completedMs: performance.now() - firstStarted, guard });
      save(`${name}-groups`, groupResults);
      for (const id of actorIds) prepared[id] = undefined!;
      if (guard) break; // Never release wave two without a successful first-wave gate.
    }
    stopped = true; await observer;
    const summary = { name, scenario, count, mode: groups.length > 1 ? 'paced' : 'burst', groups: groupResults, deadlineMs, requestedExtrinsics: scenario === 'split' ? 2 * count : count,
      waves: summaries, guard, completionToLastReceiptMs: lastSettled - firstStarted,
      ready: scenario === 'recycle' ? readiness.size : undefined,
      readinessPopulation: scenario === 'recycle' ? 'Observed-ready fixture members only' : undefined,
      unresolvedReadiness: scenario === 'recycle' ? count - readiness.size : undefined,
      readinessMs: scenario === 'recycle' ? latencies(actors.flatMap((a, i) => {
        const ready = readiness.get(a.voucher.member_key);
        return ready ? [ready.elapsedMs - memberSentAt.get(a.voucher.member_key)!] : [];
      })) : undefined,
      observationCutoff: cutoff, elapsedMs: performance.now() - firstStarted,
      passed: !guard && summaries.length === groups.length * (scenario === 'split' ? 2 : 1) && summaries.every(s => s.passed) && (scenario !== 'recycle' || readiness.size === count),
      unavailableMetrics: ['measured execution cost versus weight', 'PVF deadline compliance'],
    };
    save(`${name}-readiness`, { observations: [...readiness].map(([member, observation]) => ({ member, sentAtMs: memberSentAt.get(member), ...observation })), cutoff, ringEvidence });
    save(`${name}-summary`, summary); console.log(json({ ...summary, groups: undefined, waves: undefined }));
    assert(summary.passed, 'Lifecycle completion checks failed');
  } finally {
    stopped = true; await observer;
    save(`${name}-readiness`, { observations: [...readiness].map(([member, observation]) =>
      ({ member, sentAtMs: memberSentAt.get(member), ...observation })), cutoff, ringEvidence });
    await sender.disconnect();
  }
}

try {
  save('lifecycle-runtime', { version: await api.constants.System.Version(),
    blockWeights: await api.constants.System.BlockWeights(), blockLength: await api.constants.System.BlockLength(),
    scenario, users, mode, poolProfile, poolTransactions, deadlineMs, launchTargetMs });
  await stage(1, `${scenario}-smoke`);
  await stage(users, `${scenario}-pilot`);
} catch (error) {
  save('lifecycle-error', { scenario, error: String(error), stack: error instanceof Error ? error.stack : undefined });
  console.error(error); process.exitCode = 1;
} finally { coinage.close(); }
