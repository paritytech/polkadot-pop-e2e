/** Claim-only pilot on a disposable local PreviewNet. Root-seeded fixture, real signed claims. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises';
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';
import { AccountId, Binary, getTypedCodecs } from 'polkadot-api';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { previewPeople } from '@pop-e2e/papi';
import {
  coinClaimOptions, coinValueToAssetAmount, createCoinageClient,
  unpaidTopUpOptions, watchCoinageTransaction, type SubmissionResult,
} from '../src/lib/coinage-client.js';

const users = Number(process.env.ACTOR_COUNT ?? '100');
assert(Number.isInteger(users) && users >= 1 && users <= 1000);
const out = resolve('../../network-out');
mkdirSync(out, { recursive: true });
const json = (data: unknown) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value);
const save = (name: string, data: unknown) => writeFileSync(`${out}/${name}.json`, json(data) + '\n');
const log = (name: string, data: unknown) => appendFileSync(`${out}/${name}.jsonl`, json(data) + '\n');
const deadlineMs = 600_000;
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
  log('claim-fixture', { label, ...result });
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
  for (let offset = 0; offset < values.length; offset += 16) {
    await Promise.all(values.slice(offset, offset + 16).map((value, index) => work(value, offset + index)));
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
  const denomination = 1;
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
    const recipient = keyring.addFromSeed(randomBytes(32));
    return { id, source: source.address, recipient: recipient.address, signer: signerFor(source) };
  });
  assert.equal(new Set(actors.flatMap(a => [a.source, a.recipient])).size, count * 2);
  const originalCoin = { instance_id: instanceId, value: denomination, age: 0 };
  const recipientCoin = { ...originalCoin, age: 1 };
  for (let offset = 0; offset < count; offset += 100) {
    const items: [Uint8Array, Uint8Array][] = await Promise.all(actors.slice(offset, offset + 100).map(async actor => [
      Binary.fromHex(await api.query.Coinage.CoinsByOwner.getKey(actor.source)),
      codecs.query.Coinage.CoinsByOwner.value.enc(originalCoin),
    ] as [Uint8Array, Uint8Array]));
    await fixture(`seed source coins ${offset}..${Math.min(offset + 100, count) - 1}`,
      api.tx.Sudo.sudo({ call: api.tx.System.set_storage({ items }).decodedCall }), true);
  }
  const { hash: at, number: startingBlock } = await client.getFinalizedBlock();
  const instance = await api.query.Coinage.Instances.getValue(instanceId, { at });
  assert.equal(instance?.mode.type, 'Sufficient');
  assert.deepEqual(instance.asset_id, asset);
  assert.equal(instance.asset_unit, unit);
  assert.equal((await api.query.Assets.Account.getValue(asset, palletAccount, { at }))?.balance, backing);
  const prepared: Array<{ signed: Uint8Array; txHash: string }> = new Array(count);
  await inGroups(actors, async actor => {
    assert.deepEqual(await api.query.Coinage.CoinsByOwner.getValue(actor.source, { at }), originalCoin);
    assert.equal(await api.query.Coinage.CoinsByOwner.getValue(actor.recipient, { at }), undefined);
    const signed = await api.tx.Coinage.transfer({ to: actor.recipient }).sign(actor.signer,
      { ...coinClaimOptions(), mortality: { mortal: false }, at });
    prepared[actor.id] = { signed, txHash: blake2AsHex(signed) };
  });
  // The pinned SDK permits 16 active transaction_v1_broadcast operations per connection.
  const senders = Array.from({ length: Math.ceil(count / 15) }, () => createCoinageClient('ws://127.0.0.1:10010'));
  let stopped = false;
  let observer: Promise<void> | undefined;
  try {
    await Promise.all(senders.map(sender => sender.client.getFinalizedBlock()));
    save(`${name}-fixture`, { count, instanceId, instance, backing, palletAccount, originalCoin,
      fixtureMethod: 'root storage seeding; issuance bypassed; external backing minted',
      startingBlock, at, senderConnections: senders.length, maximumBroadcastsPerConnection: 15,
      mortality: 'immortal (disposable fork only)', preparationMs: performance.now() - prepStart,
      actors: actors.map(({ id, source, recipient }) => ({ id, source, recipient })) });
    console.log(json({ phase: 'prepared', name, count }));
    const started = performance.now();
    const wallStart = new Date().toISOString();
    let lastHash = at;
    let lastProgress = started;
    let finalityProgress = 0;
    let guard: string | undefined;
    observer = (async () => {
      while (!stopped) {
        try {
          const block = await client.getFinalizedBlock();
          if (block.hash !== lastHash) { lastHash = block.hash; lastProgress = performance.now(); finalityProgress++; }
          if (performance.now() - lastProgress > 60_000) guard = 'People finality stalled for 60 seconds';
          log(`${name}-samples`, { elapsedMs: performance.now() - started, block,
            cpu: process.cpuUsage(), memory: process.memoryUsage(), guard });
        } catch (error) { guard = 'Observer RPC failure'; log(`${name}-samples`, { error: String(error) }); }
        if (!stopped) await delay(5000);
      }
    })();
    const sentAt: number[] = [];
    const pending: Promise<SubmissionResult>[] = [];
    for (let i = 0; i < count && !guard; i++) {
      sentAt[i] = performance.now() - started;
      pending.push(watchCoinageTransaction(senders[Math.floor(i / 15)].client, prepared[i],
        Math.max(1, Math.floor(deadlineMs - sentAt[i]))).then(result => {
        log(`${name}-transactions`, { actor: i, sentAtMs: sentAt[i], ...result });
        return result;
      }));
      if (i % 100 === 99) await yieldLoop();
    }
    const sendWindowMs = performance.now() - started;
    const results = await Promise.all(pending);
    const settledAt = performance.now() - started;
    stopped = true;
    await observer;
    senders.forEach(sender => sender.close());
    const finalized = results.filter(r => r.status === 'finalized').length;
    // Reconcile every submitted claim at one finalized state, including unresolved outcomes.
    const verificationBlock = await client.getFinalizedBlock();
    let verified = 0;
    const mismatches: unknown[] = [];
    await inGroups(actors, async actor => {
      try {
        const options = { at: verificationBlock.hash, signal: AbortSignal.timeout(15_000) };
        const [source, recipient] = await Promise.all([
          api.query.Coinage.CoinsByOwner.getValue(actor.source, options),
          api.query.Coinage.CoinsByOwner.getValue(actor.recipient, options),
        ]);
        assert.equal(source, undefined);
        assert.deepEqual(recipient, recipientCoin);
        verified++;
      } catch (error) { mismatches.push({ actor: actor.id, error: String(error) }); }
    });
    const finalBacking = (await api.query.Assets.Account.getValue(asset, palletAccount,
      { at: verificationBlock.hash, signal: AbortSignal.timeout(15_000) }))?.balance;
    const generatorLimited = sendWindowMs > 1000;
    const passed = !guard && !generatorLimited && sentAt.length === count && finalized === count
      && verified === count && finalBacking === backing;
    const signals = results.flatMap((r, i) => {
      const event = r.observations.find(o => o.event.type === 'broadcasted');
      return event ? [sentAt[i] + event.elapsedMs] : [];
    });
    const summary = { name, users: count, wallStart, sent: sentAt.length, finalized, verified,
      passed, guard, generatorLimited, sendWindowMs,
      papiBroadcastSignalWindowMs: signals.length ? Math.max(...signals) : null,
      finalityProgress, settledAtMs: settledAt, drainAfterLastSendMs: settledAt - (sentAt.at(-1) ?? 0),
      finalityMs: latencies(results.filter(r => r.status === 'finalized').map(r => r.elapsedMs)),
      outcomes: results.reduce<Record<string, number>>((counts, r) => {
        counts[r.status] = (counts[r.status] ?? 0) + 1; return counts;
      }, {}),
      verificationBlock, mismatches, backing, finalBacking,
      unavailableMetrics: ['node RPC acceptance times', 'pool ready/future counts', 'block weight/proof-size use',
        'block authoring time', 'PVF execution time'],
    };
    save(`${name}-summary`, summary);
    console.log(json(summary));
    assert(passed, `${name}: claim outcome, final state or launch-window check failed`);
  } finally {
    stopped = true;
    senders.forEach(sender => sender.close());
    await observer;
  }
}

try {
  save('claim-runtime', { version: await api.constants.System.Version(),
    genesis: await client._request('chain_getBlockHash', [0]), requestedActors: users, syntheticDelayMs: 0 });
  await stage(1, 'claim-smoke');
  await stage(users, 'claim-burst');
} catch (error) {
  save('claim-error', { error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally { coinage.close(); }
