/**
 * Fetch ring members for a given collection from the People chain
 * (`Members.Members` storage) and generate a ring-VRF proof bound to a
 * context and a message hash via `verifiablejs.one_shot`.
 *
 * Ring-VRF proofs are anonymous within the ring: the proof reveals only
 * an alias, derived deterministically from `(verifiable_entropy, context)`.
 * The proof is verified on chain against the ring's stored root.
 */
import { Binary, type PolkadotClient } from "polkadot-api";
import { member_from_entropy, one_shot } from "verifiablejs/nodejs";
import { toHex } from "@polkadot-api/utils";
import type { PeopleApi } from "./client.js";

// SCALE-Vec of u8 prefix length (compact) — we encode members manually as
// length-prefixed concatenation rather than depending on PAPI types.
import { compact } from "@polkadot-api/substrate-bindings";

/** 32-byte ASCII identifiers for the on-chain Members collections. */
export const PEOPLE_IDENTIFIER = new TextEncoder().encode(
  "people                          ",
);
export const LITE_PEOPLE_IDENTIFIER = new TextEncoder().encode(
  "pop:polkadot.network/people-lite",
);

if (PEOPLE_IDENTIFIER.length !== 32 || LITE_PEOPLE_IDENTIFIER.length !== 32) {
  throw new Error("Identifiers must be exactly 32 bytes");
}

export type Collection = "People" | "LitePeople";

function identifierFor(c: Collection): Uint8Array {
  return c === "People" ? PEOPLE_IDENTIFIER : LITE_PEOPLE_IDENTIFIER;
}

/**
 * Fetch the ordered list of ring members for `(collection, ringIndex)`
 * from `Members.RingKeys` storage. Members are stored paginated; we walk
 * pages 0..N until empty and concatenate. Insertion order matters — the
 * ring root is computed from this exact sequence, so fetching from
 * `Members.Members` (which is keyed by member-key and therefore *sorted*)
 * would produce a different root and proofs would fail to verify.
 */
export async function fetchRingMembers(
  peopleApi: PeopleApi,
  collection: Collection,
  ringIndex = 0,
  /** Pin the read to a specific block hash so members + revision are atomic. */
  at?: string,
): Promise<Uint8Array[]> {
  // PAPI 2.x: storage keys for SizedHex<32> take a hex string, not a binary.
  const id = Binary.toHex(identifierFor(collection));
  const members: Uint8Array[] = [];
  const opts = at ? { at } : undefined;
  // Walk pages until we hit an empty one. Each page is a Vec<MemberKey>.
  for (let page = 0; ; page++) {
    const pageKeys = await peopleApi.query.Members.RingKeys.getValue(
      id,
      ringIndex,
      page,
      opts,
    );
    if (!pageKeys || pageKeys.length === 0) break;
    for (const k of pageKeys) {
      // PAPI 2.x types page values as SizedHex<32> (hex string) — no Binary
      // wrapper, no Uint8Array branch to defend against.
      members.push(Binary.fromHex(k));
    }
  }
  console.log(
    `[ring] ${collection} ring ${ringIndex}${at ? ` @ ${at.slice(0, 10)}…` : ""}: ${members.length} keys (insertion-ordered)`,
  );
  return members;
}

/**
 * SCALE-encode a `Vec<Member>` from raw 32-byte member keys.
 *
 * Note: `verifiablejs.one_shot` expects the SCALE-encoded `Vec<Member>` —
 * NOT the raw concatenation. Each member is a fixed 32-byte key, so the
 * SCALE encoding is `compact_len(N) || member_0 || ... || member_{N-1}`.
 */
export function encodeMembers(members: Uint8Array[]): Uint8Array {
  const lenPrefix = compact.enc(members.length);
  const total = new Uint8Array(
    lenPrefix.length + members.reduce((a, m) => a + m.length, 0),
  );
  total.set(lenPrefix, 0);
  let offset = lenPrefix.length;
  for (const m of members) {
    total.set(m, offset);
    offset += m.length;
  }
  return total;
}

export interface RingVrfProof {
  /** 788-byte ring-VRF proof. */
  proof: Uint8Array;
  /** 32-byte alias derived deterministically from `(verifiable_entropy, context)`. */
  alias: Uint8Array;
}

/**
 * Generate a ring-VRF proof bound to `context` and `message` for the given
 * collection. Fetches ring members from `peopleApi` (the proof-generation
 * algorithm needs the full ring; verification on chain uses the stored root).
 */
export async function generateRingVrfProof(
  peopleApi: PeopleApi,
  collection: Collection,
  verifiableEntropy: Uint8Array,
  context: Uint8Array,
  message: Uint8Array,
): Promise<RingVrfProof> {
  if (context.length !== 32) {
    throw new Error(`context must be 32 bytes, got ${context.length}`);
  }
  if (message.length !== 32) {
    throw new Error(`message must be 32 bytes (blake2_256), got ${message.length}`);
  }
  const memberKeys = await fetchRingMembers(peopleApi, collection, 0);
  if (memberKeys.length === 0) {
    throw new Error(
      `No ${collection} members found in Members.Members — ring not built yet`,
    );
  }
  // Sanity-check: our own member key must be in the Included set, otherwise
  // the proof cannot verify against the ring root.
  const ownKey = member_from_entropy(verifiableEntropy);
  const ownHex = toHex(ownKey);
  const found = memberKeys.some((m) => toHex(m) === ownHex);
  if (!found) {
    throw new Error(
      `Lite-person member key ${ownHex.slice(0, 18)}… not in Included ring (${memberKeys.length} included). ` +
        `Attestation is likely still in Onboarding state — wait for the ring rebuild.`,
    );
  }
  const encodedMembers = encodeMembers(memberKeys);
  const result = one_shot(verifiableEntropy, encodedMembers, context, message);
  if (result.proof.length !== 788) {
    throw new Error(
      `Unexpected proof length: ${result.proof.length} (expected 788)`,
    );
  }
  return { proof: result.proof, alias: result.alias };
}

/**
 * Helper used by the chain side to convert a raw timestamp (seconds) into
 * the daily period number used by stmt-store and PGAS contexts.
 */
export const SECONDS_PER_DAY = 86_400;

/**
 * Member's location in a multi-ring chain. The runtime no longer keeps
 * everyone in `ring 0` — once a ring fills up, new members go to ring 1, 2…
 * Allowance proofs must be generated against the specific ring the member
 * belongs to.
 */
export interface MemberLocation {
  ringIndex: number;
  ringPage: number;
  ringPosition: number;
  /**
   * Finalized block hash where the inclusion was last confirmed. Pin
   * subsequent reads (Members.Root, Members.RingKeys) to this hash so the
   * snapshot stays consistent — between two `getFinalizedBlock()` calls
   * the chain can advance past a ring rebuild and shift revisions, which
   * yields BadProof on submission.
   */
  at: string;
}

/**
 * Wait until the lite-person derived from `verifiableEntropy` is `Included`
 * in the on-chain ring AND its key is present in `RingKeys` at the latest
 * finalized block — `Members.Members` flips to `Included` slightly before
 * the ring rebuild lands, and submitting a proof in that window yields
 * `BadProof` because the recorded ring root doesn't include us yet.
 *
 * Polls `peopleClient.getFinalizedBlock()` and reads both storage items
 * pinned to the same finalized hash so the snapshot is consistent.
 * Resolves with the member's `{ringIndex, ringPage, ringPosition}`.
 */
export async function waitForInclusion(
  peopleApi: PeopleApi,
  collection: Collection,
  verifiableEntropy: Uint8Array,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    peopleClient?: PolkadotClient;
  },
): Promise<MemberLocation> {
  const timeoutMs = opts?.timeoutMs ?? 300_000; // 5 min
  const pollMs = opts?.pollMs ?? 5_000;
  // Block time on these chains is ~6s — wait at least 3 blocks between
  // the first and second finalized snapshot so the second read genuinely
  // crosses a finalisation boundary (otherwise both reads return the
  // same hash and the "stability" check is a no-op).
  const stabilityWaitMs = 18_000;
  const collectionId = Binary.toHex(identifierFor(collection));
  const ownKey = member_from_entropy(verifiableEntropy);
  const ownKeyHex = Binary.toHex(ownKey);
  // Captured once so both the initial finalized read and the stability
  // recheck below use the same client reference — narrows out the
  // `peopleClient?: PolkadotClient | undefined` ambiguity that previously
  // hid behind `opts!.peopleClient.X` non-null assertions.
  const peopleClient = opts?.peopleClient;
  const startedAt = Date.now();
  let lastTag: string | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    // Pin both reads to a finalized block so Members status and RingKeys
    // see the same state. If we read at HEAD, the chain may have flipped
    // status to Included but not yet rebuilt the ring page our key lives
    // in — that race shows up as BadProof when we submit.
    const fin = peopleClient ? await peopleClient.getFinalizedBlock() : undefined;
    const at = fin ? { at: fin.hash as string } : undefined;
    const status = await peopleApi.query.Members.Members.getValue(
      collectionId,
      ownKeyHex,
      at,
    );
    const tag = status?.type ?? "missing";
    // Narrow on `status` itself rather than the `tag` local — TS can't
    // relate `tag === "Included"` back to `status.type` once `tag` is
    // computed via the `??` fallback.
    if (status?.type === "Included") {
      const v = status.value;
      // Confirm our key actually appears at that ring/page. If not, the
      // ring rebuild hasn't reached this finalized block yet — wait.
      const page = await peopleApi.query.Members.RingKeys.getValue(
        collectionId,
        v.ring_index,
        v.ring_page,
        at,
      );
      const inRing = (page ?? []).some((k) => k === ownKeyHex);
      if (inRing && fin && peopleClient) {
        // The ring-rebuild offchain worker writes Members.RingKeys + Root
        // in one block, but the new revision can be invalidated by another
        // rebuild a few blocks later (e.g. another member onboarding).
        // To submit a stable proof, require the same (revision, member-set)
        // to persist for at least one extra finalized block.
        await new Promise((r) => setTimeout(r, stabilityWaitMs));
        const fin2 = await peopleClient.getFinalizedBlock();
        const at2 = { at: fin2.hash as string };
        const root2 = await peopleApi.query.Members.Root.getValue(
          collectionId,
          v.ring_index,
          at2,
        );
        const page2 = await peopleApi.query.Members.RingKeys.getValue(
          collectionId,
          v.ring_index,
          v.ring_page,
          at2,
        );
        const stillInRing = (page2 ?? []).some((k) => k === ownKeyHex);
        if (!stillInRing || !root2) {
          if (lastTag !== "ring-unstable") {
            console.log(
              `[ring] revision unstable — waiting for next rebuild to settle`,
            );
            lastTag = "ring-unstable";
          }
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        console.log(
          `[ring] member stable in ring after ${Math.round((Date.now() - startedAt) / 1000)}s — ring=${v.ring_index} page=${v.ring_page} pos=${v.ring_position} rev=${root2.revision} @${fin2.hash.slice(0, 10)}…`,
        );
        return {
          ringIndex: v.ring_index,
          ringPage: v.ring_page,
          ringPosition: v.ring_position,
          at: fin2.hash,
        };
      }
      if (inRing && !fin) {
        // No client passed — caller is doing read-at-head. Return without
        // a pinned hash; downstream is responsible for its own snapshot.
        console.log(
          `[ring] member Included after ${Math.round((Date.now() - startedAt) / 1000)}s — ring=${v.ring_index} page=${v.ring_page} pos=${v.ring_position}`,
        );
        return {
          ringIndex: v.ring_index,
          ringPage: v.ring_page,
          ringPosition: v.ring_position,
          at: "",
        };
      }
      if (lastTag !== "ring-pending") {
        console.log(
          `[ring] member Included but not yet in RingKeys (${Math.round((Date.now() - startedAt) / 1000)}s) — waiting for ring rebuild…`,
        );
        lastTag = "ring-pending";
      }
    } else if (tag !== lastTag) {
      console.log(
        `[ring] member ${tag} (${Math.round((Date.now() - startedAt) / 1000)}s) — waiting…`,
      );
      lastTag = tag;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Member not Included after ${timeoutMs / 1000}s — last status: ${lastTag ?? "unknown"}`,
  );
}
