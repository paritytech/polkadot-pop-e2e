# Coinage transaction client

This is the client layer above the PreviewNet network in PR #32. The burst
workflow will be a separate change. It reuses this repository's PAPI descriptors,
account signer and `verifiablejs` dependency. Ownership-proof and denomination
helpers are adapted from [triangle-e2e PR #43](https://github.com/paritytech/triangle-e2e/pull/43).

The client prepares one instance-aware `load_recycler_with_external_asset_unpaid`
with `InfallibleUnpaidSigned` and `Expendable` preservation. It signs before
submission, so a later load generator can prepare transactions outside the
measurement window. There is no coin selection or wallet policy implementation.

## Try one top-up

Start the local PreviewNet from PR #32. Select an existing Coinage instance and
fund the signing account with its backing asset. Instance creation, funding,
pot setup and burst scheduling are the next workflow's responsibility.

From `packages/chain-tests`:

```sh
pnpm coinage inspect 0
# Set COINAGE_SIGNER_URI to the funded account's URI.
# Set COINAGE_VOUCHER_SEED to a fresh, independent 32-byte hex secret.
pnpm coinage top-up 0 1
```

Replace `0` with the instance ID printed by your fixture. The default RPC is
`ws://127.0.0.1:10010`; override it with `COINAGE_RPC`. The command accepts only
loopback endpoints. Keep the voucher secret if you intend to unload later.

`prepareTopUp` takes a signer, instance, denomination and voucher secret. It
reads the instance and account at a finalized block and returns signed bytes,
the transaction hash and amount. A caller scheduling multiple transactions for
one account must supply distinct nonces. Prepared transactions are mortal;
submit them promptly, not after a long fixture-generation phase.

`submitTopUp` watches those bytes without retrying. Its result distinguishes
finalized success, finalized dispatch failure, submission errors, and an
unresolved timeout. Best-block inclusion and retraction are recorded separately.
Finalized loading does **not** mean that the recycler ring is ready to unload.

## Validation

```sh
pnpm test:coinage-client
```

Offline tests verify real ownership proofs, encoding and signing against the
checked-in PreviewNet metadata, and outcome tracking across reorgs and timeouts.
They do not demonstrate runtime acceptance or capacity. The next workflow must
first prove one funded load succeeds on the fork before attempting 10,000 users.
