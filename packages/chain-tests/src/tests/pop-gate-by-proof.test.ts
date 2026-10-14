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
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { compact } from "@polkadot-api/substrate-bindings";
import { mergeUint8 } from "@polkadot-api/utils";
import { ringRootsWindow } from "../lib/individuality-compat.js";
import { createPeopleClient, createAssetHubClient, type PeopleApi } from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { createPgasPayerSigner } from "../lib/claim-signer.js";
import { getNetworkConfig } from "../config/networks.js";
import {
  fetchRingMembers,
  encodeMembers,
  waitForInclusion,
  LITE_PEOPLE_IDENTIFIER,
} from "../lib/ring.js";
import { getCachedRingLocation } from "../lib/ring-cascade.js";
import { customAliasContext } from "../lib/alias-claim.js";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { connectPopCounter, revertName } from "../lib/pop-counter-contract.js";

const CTX_LABEL = "triangle-e2e:pop-counter"; // == PopCounter.CTX
const COLLECTION_HEX = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
const MAX_PROOF_ATTEMPTS = 3;

type Hex = `0x${string}`;
type BumpArgs = [proof: Hex, expectedAlias: Hex, ringIndex: number, revision: number];

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PoP-gated counter — stateless (personhoodInfoByProof)",
  () => {
    let peopleClient: PolkadotClient;
    let peopleApi: PeopleApi;
    let assetHubClient: PolkadotClient;
    let counter: Awaited<ReturnType<typeof connectPopCounter>>["contract"];
    let consumedArgs: BumpArgs | null = null;
    let caller: string;
    let signer: CommonSignerTxCreator;

    beforeAll(async () => {
      assertChainHealthy("people");
      assertChainHealthy("asset-hub");
      const network = getNetworkConfig();
      ({ client: peopleClient, api: peopleApi } = createPeopleClient(network.people.ws));
      ({ client: assetHubClient } = createAssetHubClient(network.assetHub.ws));
      const popCounter = await connectPopCounter(assetHubClient);
      counter = popCounter.contract;
      console.log(`[pop-by-proof] PopCounter at ${popCounter.address}`);

      const creds = await ensureAttested();
      caller = creds.address;
      signer = createPgasPayerSigner(deriveKeyPair(creds.entropy));
      console.log(`[pop-by-proof] caller (lite-person, no alias registered): ${caller}`);
    });

    afterAll(() => {
      peopleClient?.destroy();
      assetHubClient?.destroy();
    });

    /** Poll AH RingRoots until it mirrors `targetRevision` for this ring. */
    async function waitForAhRingRevision(
      ringIndex: number,
      targetRevision: number,
      timeoutMs = 120_000,
    ): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const roots = await ringRootsWindow(assetHubClient, COLLECTION_HEX, ringIndex);
        if (roots.some((r) => r.revision === targetRevision)) return;
        const max = roots.length === 0 ? -1 : Math.max(...roots.map((r) => r.revision));
        console.log(`[pop-by-proof] waiting AH ring sync — target=${targetRevision} max=${max}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      throw new Error(`[pop-by-proof] AH never mirrored revision ${targetRevision}`);
    }

    /**
     * Generate a ring-VRF proof bound to the contract's `expectedMessage()`
     * and return `bumpByProof(...)` arguments the contract already accepts
     * in a dry-run. Re-snapshots the People ring per attempt (it can rebuild
     * mid-flight) and waits for Asset Hub to mirror that revision.
     */
    async function buildBumpByProofArgs(): Promise<BumpArgs> {
      const creds = await ensureAttested();
      const verifiableEntropy = blake2b256(creds.entropy);
      const context = customAliasContext(CTX_LABEL);

      const location =
        getCachedRingLocation() ??
        (await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, { peopleClient }));
      const ringIndex = location.ringIndex;

      // The 32-byte message the contract reconstructs from msg.sender + nonce.
      const expected = await counter.expectedMessage.query({ origin: caller });
      if (!expected.success) throw new Error(`[pop-by-proof] expectedMessage failed: ${revertName(expected)}`);
      const message = Binary.fromHex(expected.value as Hex);

      const { one_shot } = verifiableFor();
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
        const fin = await peopleClient.getFinalizedBlock();
        const at = fin.hash as Hex;
        const root = await peopleApi.query.Members.Root.getValue(COLLECTION_HEX, ringIndex, { at });
        const revision = root?.revision ?? 0;
        const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
        console.log(
          `[pop-by-proof] attempt=${attempt} ring=${ringIndex} rev=${revision} members=${memberKeys.length}`,
        );

        await waitForAhRingRevision(ringIndex, revision);

        const { proof, alias } = one_shot(verifiableEntropy, encodeMembers(memberKeys), context, message);
        // The precompile decodes `T::Proof` (a `BoundedVec<u8, …>`) from the raw
        // `bytes proof`, so it needs SCALE's `compact(len)` prefix.
        const proofScale = mergeUint8([compact.enc(proof.length), proof]);
        const args: BumpArgs = [Binary.toHex(proofScale) as Hex, Binary.toHex(alias) as Hex, ringIndex, revision];

        const dry = await counter.bumpByProof.query(...args, { origin: caller });
        if (dry.success) return args;
        lastErr = new Error(`bumpByProof reverted (${revertName(dry)})`);
        console.log(`[pop-by-proof] attempt=${attempt} reverted — re-snapshotting`);
      }
      throw lastErr ?? new Error("[pop-by-proof] proof generation exhausted retries");
    }

    async function readBumpCount(alias: Hex): Promise<bigint> {
      const result = await counter.byAliasByProof.query(alias, { origin: caller });
      if (!result.success) throw new Error(`[pop-by-proof] byAliasByProof failed: ${revertName(result)}`);
      return result.value as bigint;
    }

    it(
      "accepts a fresh bound proof from a lite-person with no registered alias",
      async () => {
        const args = await buildBumpByProofArgs();
        const before = await readBumpCount(args[1]);

        const result = await counter.bumpByProof.tx(...args, { signer, origin: caller });
        if (!result.ok) throw result.error;
        expect(result.value.ok).toBe(true);
        consumedArgs = args;
        console.log(`[pop-by-proof] bumpByProof landed @#${result.value.block.number}`);

        expect(await readBumpCount(args[1])).toBe(before + 1n);
      },
      300_000,
    );

    it(
      "rejects replay of the consumed proof (nonce advanced)",
      async () => {
        if (!consumedArgs) throw new Error("[pop-by-proof] prior bump didn't run");
        // The per-caller nonce advanced after the accepted bump, so the
        // contract now reconstructs a different message than the proof bound.
        const result = await counter.bumpByProof.query(...consumedArgs, { origin: caller });
        expect(result.success).toBe(false);
      },
      120_000,
    );
  },
);
