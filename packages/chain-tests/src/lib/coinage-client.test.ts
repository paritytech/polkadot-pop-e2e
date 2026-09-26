import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountId, Binary, getOfflineApi, getTypedCodecs, type PolkadotClient, type TxBroadcastEvent } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { previewPeople } from "@pop-e2e/papi";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { verify_signature } from "verifiablejs/nodejs";
import { coinValueToAssetAmount, topUpArguments, unpaidTopUpOptions, watchTopUp } from "./coinage-client.js";

test("denominations use exact integer arithmetic and reject truncation/overflow", () => {
  assert.equal(coinValueToAssetAmount(1, 128n, -7, 20), 256n);
  assert.equal(coinValueToAssetAmount(-7, 128n, -7, 20), 1n);
  assert.throws(() => coinValueToAssetAmount(-1, 3n, -7, 20), /truncate/);
  assert.throws(() => coinValueToAssetAmount(1.5, 128n, -7, 20), /integer/);
  assert.throws(() => coinValueToAssetAmount(21, 128n, -7, 20), /integer/);
  assert.throws(() => coinValueToAssetAmount(1, 1n << 127n, 0, 127), /u128/);
  assert.throws(() => coinValueToAssetAmount(0, 0n, 0, 10), /positive/);
});

test("real voucher proof binds to the funding account; metadata preserves instance and denomination", async () => {
  const address = AccountId().dec(new Uint8Array(32).fill(1));
  const args = topUpArguments(42, -3, address, new Uint8Array(32).fill(7));
  assert.equal(verify_signature(Binary.fromHex(args.proof_of_ownership), AccountId().enc(address), Binary.fromHex(args.member_key)), true);
  assert.equal(verify_signature(Binary.fromHex(args.proof_of_ownership), new Uint8Array(32).fill(2), Binary.fromHex(args.member_key)), false);
  const codecs = await getTypedCodecs(previewPeople);
  const codec = codecs.tx.Coinage.load_recycler_with_external_asset_unpaid;
  assert.deepEqual(codec.dec(codec.enc(args)), args);
  assert.throws(() => topUpArguments(-1, 1, address, new Uint8Array(32)), /instance id/);
  assert.throws(() => topUpArguments(0, 128, address, new Uint8Array(32)), /denomination/);
  assert.throws(() => topUpArguments(0, 1, address, new Uint8Array(31)), /entropy/);
});

test("signs an unpaid instance load using the checked-in PreviewNet metadata", async () => {
  await cryptoWaitReady();
  const pair = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const accountSigner = getPolkadotSigner(pair.publicKey, "Sr25519", (data) => pair.sign(data));
  const offline = await getOfflineApi(previewPeople);
  let sawCoinage = false;
  const signer = { ...accountSigner, async signTx(...args: Parameters<typeof accountSigner.signTx>) {
    // Option::Some, InfallibleUnpaidSigned (variant 5), nonce as a u32 LE.
    assert.deepEqual(Array.from(args[1].AsCoinage.value), [1, 5, 7, 0, 0, 0]);
    sawCoinage = true;
    return accountSigner.signTx(...args);
  } };
  const tx = offline.tx.Coinage.load_recycler_with_external_asset_unpaid(
    topUpArguments(3, 1, pair.address, new Uint8Array(32).fill(9)),
  );
  const signed = await tx.sign(signer, { ...unpaidTopUpOptions(7), nonce: 7, mortality: { mortal: false } });
  assert.ok(sawCoinage);
  assert.ok(signed.length > 100);
});

const prepared = { signed: new Uint8Array([1]), txHash: "0x12" };
const block = { hash: "0x34", number: 10, index: 0 };

// No RPC: exercise the same subscription callbacks that PAPI invokes, including
// synchronous completion, reorgs, errors and subscriptions that never respond.
function source(events: TxBroadcastEvent[], error?: Error, complete = true) {
  let unsubscribed = false;
  const client = { submitAndWatch() { return { subscribe(observer: {
    next(event: TxBroadcastEvent): void; error(error: Error): void; complete(): void;
  }) {
    for (const event of events) observer.next(event);
    if (error) observer.error(error);
    else if (complete) observer.complete();
    return { unsubscribe() { unsubscribed = true; } };
  } }; } } as unknown as Pick<PolkadotClient, "submitAndWatch">;
  return { client, unsubscribed: () => unsubscribed };
}

test("best-block inclusion and retraction remain unresolved without finality", async () => {
  const mock = source([
    { type: "txBestBlocksState", txHash: "0x12", found: true, ok: true, block, events: [] },
    { type: "txBestBlocksState", txHash: "0x12", found: false, isValid: true },
  ]);
  const result = await watchTopUp(mock.client, prepared, 100);
  assert.equal(result.status, "unresolved");
  assert.equal(result.observations.length, 2);
  assert.ok(mock.unsubscribed());
});

test("finality reports dispatch failure separately from a successful top-up", async () => {
  for (const ok of [true, false] as const) {
    const mock = source([ok
      ? { type: "finalized", txHash: "0x12", ok, block, events: [] }
      : { type: "finalized", txHash: "0x12", ok, block, events: [], dispatchError: { type: "BadOrigin", value: undefined } },
    ]);
    const result = await watchTopUp(mock.client, prepared);
    assert.equal(result.status, ok ? "finalized" : "dispatch-error");
    assert.deepEqual(result.block, block);
    assert.ok(mock.unsubscribed());
  }
});

test("RPC/pool errors and timeouts are distinct; both release the subscription", async () => {
  const rejected = source([], new Error("Invalid transaction"));
  const result = await watchTopUp(rejected.client, prepared);
  assert.equal(result.status, "submission-error");
  assert.equal(result.error, "Invalid transaction");
  assert.ok(rejected.unsubscribed());
  const stalled = source([], undefined, false);
  assert.equal((await watchTopUp(stalled.client, prepared, 10)).status, "unresolved");
  assert.ok(stalled.unsubscribed());
});

test("claims sign as the source coin, preserve the destination and encode seeded coins", async () => {
  const { coinClaimOptions } = await import("./coinage-client.js");
  await cryptoWaitReady();
  const pair = new Keyring({ type: "sr25519" }).addFromUri("//claim-source");
  const destination = new Keyring({ type: "sr25519" }).addFromUri("//claim-recipient").address;
  const base = getPolkadotSigner(pair.publicKey, "Sr25519", data => pair.sign(data));
  let checked = false;
  const signer = { ...base, async signTx(...args: Parameters<typeof base.signTx>) {
    // Option::Some, AsCoin (variant 0): no unpaid account nonce payload.
    assert.deepEqual(Array.from(args[1].AsCoinage.value), [1, 0]);
    checked = true;
    return base.signTx(...args);
  } };
  const offline = await getOfflineApi(previewPeople);
  const codecs = await getTypedCodecs(previewPeople);
  const args = { to: destination };
  assert.deepEqual(codecs.tx.Coinage.transfer.dec(codecs.tx.Coinage.transfer.enc(args)), args);
  const coin = { instance_id: 17, value: 1, age: 0 };
  assert.deepEqual(codecs.query.Coinage.CoinsByOwner.value.dec(
    codecs.query.Coinage.CoinsByOwner.value.enc(coin)), coin);
  const signed = await offline.tx.Coinage.transfer(args).sign(signer,
    { ...coinClaimOptions(), nonce: 0, mortality: { mortal: false } });
  assert(checked);
  assert(signed.length > 64);
});
