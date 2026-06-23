/**
 * Stateless proof-of-personhood gating end-to-end — the `personhoodInfoByProof`
 * path, complementing `pop-gate.test.ts` (which exercises the stored-alias
 * `personhoodStatus` path).
 *
 * `PopCounter.bumpByProof(...)` takes a FRESH ring-VRF proof inline; the
 * IPersonhood precompile (0x0a010000) verifies it on the fly against the
 * LitePeople ring root mirrored on Asset Hub — NO prior
 * `AliasAccounts.set_paid_alias_account` registration required. The proof is
 * bound to `keccak256(msg.sender, nonce)` (read from the contract via
 * `expectedMessage()`), so it can't be replayed by the same caller, and the
 * precompile's "we don't bind msg.sender for you" caveat is satisfied.
 *
 * Two verdicts:
 *   - An attested lite-person (no alias registered) can bump by proof.
 *   - Replaying the same (now-consumed) proof reverts — the per-caller nonce
 *     advanced, so the bound message no longer matches.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { compact } from "@polkadot-api/substrate-bindings";
import { mergeUint8 } from "@polkadot-api/utils";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import {
  createPeopleClient,
  createAssetHubClient,
  assertRichAssetHub,
  type PeopleApi,
  type RichAssetHubApi,
  type AssetHubApi,
} from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import {
  fetchRingMembers,
  encodeMembers,
  waitForInclusion,
  LITE_PEOPLE_IDENTIFIER,
} from "../lib/ring.js";
import { getCachedRingLocation } from "../lib/ring-cascade.js";
import { customAliasContext } from "../lib/alias-claim.js";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { findPopCounterContract, POP_COUNTER_ABI } from "../lib/pop-counter-contract.js";

const CTX_LABEL = "triangle-e2e:pop-counter"; // == PopCounter.CTX
const COLLECTION_HEX = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
const MAX_PROOF_ATTEMPTS = 3;

type Hex = `0x${string}`;

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PoP-gated counter — stateless (personhoodInfoByProof)",
  () => {
    let network: NetworkConfig;
    let peopleClient: PolkadotClient;
    let peopleApi: PeopleApi;
    let assetHubClient: PolkadotClient;
    let assetHubApi: AssetHubApi;
    let contractAddress: Hex;
    let consumedCalldata: Hex | null = null;
    let caller: string;
    let signer: ReturnType<typeof getPolkadotSigner>;

    beforeAll(async () => {
      assertChainHealthy("people");
      assertChainHealthy("asset-hub");
      network = getNetworkConfig();
      console.log(`[pop-by-proof] Network: ${network.name}`);

      const p = createPeopleClient(network.people.ws);
      peopleClient = p.client;
      peopleApi = p.api;
      const ah = createAssetHubClient(network.assetHub.ws);
      assetHubClient = ah.client;
      assetHubApi = ah.api;

      const addr = await findPopCounterContract(assetHubApi);
      if (!addr) {
        throw new Error(
          "[pop-by-proof] No PopCounter contract deployed — run `pnpm deploy-counter` first.",
        );
      }
      contractAddress = addr as Hex;
      console.log(`[pop-by-proof] PopCounter at ${contractAddress}`);

      const creds = await ensureAttested();
      caller = creds.address;
      const keyPair = deriveKeyPair(creds.entropy);
      signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", async (i) => keyPair.sign(i));
      console.log(`[pop-by-proof] caller (lite-person, no alias registered): ${caller}`);
    });

    afterAll(() => {
      peopleClient?.destroy();
      assetHubClient?.destroy();
    });

    interface DryRun {
      reverted: boolean;
      returnDataHex: string;
      returnData: Uint8Array;
      weight: unknown;
      deposit: bigint;
    }

    /** Dry-run a contract call from `caller`. Never submits. */
    async function dryRun(richAh: RichAssetHubApi, data: Hex): Promise<DryRun> {
      const fin = await assetHubClient.getFinalizedBlock();
      const dry = await richAh.apis.ReviveApi.call(
        caller,
        contractAddress,
        0n,
        undefined,
        undefined,
        Binary.fromHex(data),
        { at: fin.hash },
      );
      const outerOk = dry.result.success;
      const inner = outerOk
        ? (dry.result.value as unknown as { flags: number; data: Uint8Array })
        : null;
      const reverted = !outerOk || (inner !== null && (inner.flags & 1) !== 0);
      const deposit = dry.storage_deposit.type === "Charge" ? dry.storage_deposit.value : 0n;
      return {
        reverted,
        returnDataHex: inner ? Binary.toHex(inner.data) : "",
        returnData: inner ? inner.data : new Uint8Array(),
        weight: dry.weight_required,
        deposit,
      };
    }

    /** Submit a contract call from `caller`, reusing a prior dry-run's limits. */
    async function submit(richAh: RichAssetHubApi, data: Hex, dry: DryRun) {
      const tx = richAh.tx.Revive.call({
        dest: contractAddress,
        value: 0n,
        weight_limit: dry.weight as never,
        storage_deposit_limit: dry.deposit > 0n ? dry.deposit : 1n,
        data: Binary.fromHex(data),
      });
      return tx.signAndSubmit(signer);
    }

    /** Read a `bytes32`/`uint256` view return for the given calldata. */
    async function readView(richAh: RichAssetHubApi, data: Hex): Promise<Hex> {
      const { returnData } = await dryRun(richAh, data);
      return Binary.toHex(returnData) as Hex;
    }

    /** Poll AH RingRoots until it mirrors `targetRevision` for this ring. */
    async function waitForAhRingRevision(
      richAh: RichAssetHubApi,
      ringIndex: number,
      targetRevision: number,
      timeoutMs = 120_000,
    ): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const roots =
          (await richAh.query.MembersSubscriber.RingRoots.getValue(COLLECTION_HEX, ringIndex)) ?? [];
        if (roots.some((r) => r.revision === targetRevision)) return;
        const max = roots.length === 0 ? -1 : Math.max(...roots.map((r) => r.revision));
        console.log(`[pop-by-proof] waiting AH ring sync — target=${targetRevision} max=${max}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      throw new Error(`[pop-by-proof] AH never mirrored revision ${targetRevision}`);
    }

    /**
     * Generate a ring-VRF proof bound to the contract's `expectedMessage()`
     * and return validated `bumpByProof(...)` calldata + the derived alias.
     * Re-snapshots the People ring per attempt (it can rebuild mid-flight)
     * and waits for Asset Hub to mirror that revision; dry-runs each candidate
     * so we only return calldata the precompile already accepted.
     */
    async function buildBumpByProofCalldata(
      richAh: RichAssetHubApi,
    ): Promise<{ calldata: Hex; alias: Hex }> {
      const creds = await ensureAttested();
      const verifiableEntropy = blake2b256(creds.entropy);
      const context = customAliasContext(CTX_LABEL);

      const location =
        getCachedRingLocation() ??
        (await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, { peopleClient }));
      const ringIndex = location.ringIndex;

      // The 32-byte message the contract reconstructs from msg.sender + nonce.
      const msgHex = decodeFunctionResult({
        abi: POP_COUNTER_ABI,
        functionName: "expectedMessage",
        data: await readView(
          richAh,
          encodeFunctionData({ abi: POP_COUNTER_ABI, functionName: "expectedMessage" }),
        ),
      }) as Hex;
      const message = Uint8Array.from((msgHex.slice(2).match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

      const { one_shot } = verifiableFor();
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
        const fin = await peopleClient.getFinalizedBlock();
        const at = fin.hash as Hex;
        const root = await peopleApi.query.Members.Root.getValue(COLLECTION_HEX, ringIndex, { at });
        const revision = root?.revision ?? 0;
        const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
        const encodedMembers = encodeMembers(memberKeys);
        console.log(
          `[pop-by-proof] attempt=${attempt} ring=${ringIndex} rev=${revision} members=${memberKeys.length} msg=${msgHex.slice(0, 14)}…`,
        );

        await waitForAhRingRevision(richAh, ringIndex, revision);

        const { proof, alias } = one_shot(verifiableEntropy, encodedMembers, context, message);
        // The runtime's `Proof` type is `BoundedVec<u8, …>`, which SCALE-encodes
        // as `compact(len) ++ bytes`. papi adds that prefix when encoding the
        // `set_*_alias_account` extrinsic; the precompile decodes `T::Proof`
        // from our raw `bytes proof`, so we must prepend the same prefix here —
        // otherwise it reads the signature's leading bytes as a bogus length.
        const proofScale = mergeUint8([compact.enc(proof.length), proof]);
        const calldata = encodeFunctionData({
          abi: POP_COUNTER_ABI,
          functionName: "bumpByProof",
          args: [Binary.toHex(proofScale) as Hex, Binary.toHex(alias) as Hex, ringIndex, revision],
        });

        const dry = await dryRun(richAh, calldata);
        if (!dry.reverted) return { calldata, alias: Binary.toHex(alias) as Hex };
        lastErr = new Error(`bumpByProof reverted (data=${dry.returnDataHex})`);
        console.log(`[pop-by-proof] attempt=${attempt} reverted — re-snapshotting`);
      }
      throw lastErr ?? new Error("[pop-by-proof] proof generation exhausted retries");
    }

    function readBumpCount(richAh: RichAssetHubApi, alias: Hex): Promise<bigint> {
      return readView(
        richAh,
        encodeFunctionData({ abi: POP_COUNTER_ABI, functionName: "byAliasByProof", args: [alias] }),
      ).then(
        (hex) =>
          decodeFunctionResult({
            abi: POP_COUNTER_ABI,
            functionName: "byAliasByProof",
            data: hex,
          }) as bigint,
      );
    }

    it(
      "accepts a fresh bound proof from a lite-person with no registered alias",
      async () => {
        assertRichAssetHub(assetHubApi);
        const richAh = assetHubApi;

        const { calldata, alias } = await buildBumpByProofCalldata(richAh);
        const before = await readBumpCount(richAh, alias);

        const dry = await dryRun(richAh, calldata);
        expect(dry.reverted).toBe(false);
        const result = await submit(richAh, calldata, dry);
        if (!result.ok) {
          throw new Error(`[pop-by-proof] dispatch failed: ${JSON.stringify(result.dispatchError)}`);
        }
        consumedCalldata = calldata;
        console.log(`[pop-by-proof] bumpByProof landed @#${result.block.number}`);

        expect(await readBumpCount(richAh, alias)).toBe(before + 1n);
      },
      300_000,
    );

    it(
      "rejects replay of the consumed proof (nonce advanced)",
      async () => {
        assertRichAssetHub(assetHubApi);
        if (!consumedCalldata) throw new Error("[pop-by-proof] prior bump didn't run");
        // The per-caller nonce advanced after the accepted bump, so the
        // contract now reconstructs a different message than the proof bound.
        const { reverted } = await dryRun(assetHubApi, consumedCalldata);
        expect(reverted).toBe(true);
      },
      120_000,
    );
  },
);
