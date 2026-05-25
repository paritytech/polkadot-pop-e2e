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
import { verifiableFor } from "./verifiable-loader.js";
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
  const { member_from_entropy, one_shot } = verifiableFor();
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
  // Proof length: 788 pre-ThinVRF (v0.6.5), 787 post-ThinVRF (v0.7.0+).
  // Keeping the assertion as a regression guard against silent verifiablejs
  // misalignment — drop the alternation once every network is on v0.7.0+.
  if (result.proof.length !== 788 && result.proof.length !== 787) {
    throw new Error(
      `Unexpected proof length: ${result.proof.length} (expected 787 or 788)`,
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
  const { member_from_entropy } = verifiableFor();
  const ownKey = member_from_entropy(verifiableEntropy);
  const ownKeyHex = Binary.toHex(ownKey);
  // Captured once so both the initial finalized read and the stability
  // recheck below use the same client reference — narrows out the
  // `peopleClient?: PolkadotClient | undefined` ambiguity that previously
  // hid behind `opts!.peopleClient.X` non-null assertions.
  const peopleClient = opts?.peopleClient;
  const startedAt = Date.now();
  let lastTag: string | undefined;
  // Capture a baseline snapshot so a timeout can prove whether the chain
  // was making progress at all. Without this the failure message just
  // says "300s, Onboarding" and the on-call has no idea whether to page
  // the runtime team (reconciler stuck) or bump the budget (slow but
  // healthy).
  const startSnap = peopleClient
    ? await captureRingDiagnostic(peopleApi, peopleClient, collectionId)
    : null;
  const statusLog: Array<{ atSec: number; tag: string }> = [];
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
      statusLog.push({ atSec: Math.round((Date.now() - startedAt) / 1000), tag });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const endSnap = peopleClient
    ? await captureRingDiagnostic(peopleApi, peopleClient, collectionId)
    : null;
  throw new Error(formatInclusionTimeout({
    timeoutMs,
    lastTag,
    statusLog,
    startSnap,
    endSnap,
    collection,
  }));
}

interface RingDiagnostic {
  blockNumber: number;
  ringZeroRevision: number | null;
  onboardingCount: number;
  includedCount: number;
}

/**
 * Snapshot the chain-side ring state for diagnostic comparison across a
 * wait window. Reads ring-0 revision (the active ring for both People
 * and LitePeople collections during onboarding) plus the full Members
 * map count broken down by status. Cheap enough to run twice in the
 * lifetime of a `waitForInclusion` call (start + on-timeout).
 */
async function captureRingDiagnostic(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  collectionIdHex: string,
): Promise<RingDiagnostic> {
  const fin = await peopleClient.getFinalizedBlock();
  const at = { at: fin.hash as `0x${string}` };
  const [root, allMembers] = await Promise.all([
    peopleApi.query.Members.Root.getValue(collectionIdHex, 0, at),
    peopleApi.query.Members.Members.getEntries(collectionIdHex, at),
  ]);
  let onboarding = 0;
  let included = 0;
  for (const entry of allMembers) {
    const t = entry.value?.type;
    if (t === "Onboarding") onboarding++;
    else if (t === "Included") included++;
  }
  return {
    blockNumber: fin.number,
    ringZeroRevision: root?.revision ?? null,
    onboardingCount: onboarding,
    includedCount: included,
  };
}

/**
 * Render the `waitForInclusion` timeout error with enough diagnostic
 * detail that an on-call reading the test output can immediately classify
 * the failure: chain-side reconciler stalled, ring at capacity, RPC slow,
 * or our extrinsic never landed. Each "Likely cause" bullet maps to a
 * different remediation, so the formatter spells them out rather than
 * leaving the reader to triangulate.
 */
function formatInclusionTimeout(args: {
  timeoutMs: number;
  lastTag: string | undefined;
  statusLog: Array<{ atSec: number; tag: string }>;
  startSnap: RingDiagnostic | null;
  endSnap: RingDiagnostic | null;
  collection: Collection;
}): string {
  const { timeoutMs, lastTag, statusLog, startSnap, endSnap, collection } = args;
  const secs = timeoutMs / 1000;
  const lines: string[] = [
    `Ring inclusion timed out: the People-chain ring builder did not include this new attested account after ${secs}s.`,
    `Effect: no ring-VRF proof can be generated for this account, so any test that depends on attestation (allowances, PGAS claim, statement-store write, bulletin upload) cannot run.`,
    `Last on-chain status seen: ${lastTag ?? "unknown"}.`,
  ];
  if (startSnap && endSnap) {
    const blockDelta = endSnap.blockNumber - startSnap.blockNumber;
    const expectedBlocks = Math.round(secs / 6); // ~6s block time
    const revDelta =
      endSnap.ringZeroRevision != null && startSnap.ringZeroRevision != null
        ? endSnap.ringZeroRevision - startSnap.ringZeroRevision
        : null;
    // Classify based on what the chain numbers tell us — the test
    // produces an explicit verdict so a non-runtime engineer doesn't have
    // to reason about block deltas / revision counters in the moment.
    let verdict: string;
    if (blockDelta < expectedBlocks / 2) {
      verdict =
        `→ Chain side: the People chain barely advanced (${blockDelta} blocks in ${secs}s, expected ~${expectedBlocks}). The chain itself is slow or its RPC is degraded. Action: re-run; if persistent, check the People-chain RPC endpoint.`;
    } else if (revDelta === 0) {
      verdict =
        `→ Chain side: the People chain is producing blocks fine, but the ring builder (individuality offchain worker) has not produced a new ring revision in the last ${secs}s. This is the "builder stuck" fault — new attestations cannot become usable until it recovers. Action: notify the individuality runtime team; this is NOT a test bug.`;
    } else if (revDelta != null && revDelta > 0 && lastTag === "Onboarding") {
      verdict =
        `→ Chain side: the ring builder ran (${revDelta} new revision(s)) but did not pick up this member. Ring may be at capacity, or the builder is processing the onboarding queue slower than members are arriving. Action: file an issue against individuality runtime.`;
    } else if (lastTag === "missing" || lastTag == null) {
      verdict =
        `→ Backend side: this account never appeared in Members storage at all — the IB never landed its registration extrinsic. Action: re-check IB attestation logs (this is the same failure class the IB-vendored wasm change was meant to fix; if it shows up again, look there first).`;
    } else {
      verdict =
        `→ Ambiguous: chain advanced, ring revision advanced, but member still not Included after waiting. May indicate the stability re-check window keeps invalidating us (ring rebuilds back-to-back). Worth raising with the individuality team.`;
    }
    const transitions = statusLog.length
      ? statusLog.map((e) => `[${e.atSec}s] ${e.tag}`).join(" → ")
      : "(none — status never changed)";
    lines.push(
      ``,
      `Verdict:`,
      `  ${verdict}`,
      ``,
      `Raw chain numbers (for the runtime team):`,
      `  collection:         ${collection}`,
      `  finalized block:    #${startSnap.blockNumber} → #${endSnap.blockNumber} (+${blockDelta} blocks; ~${expectedBlocks} expected at 6s/block)`,
      `  ring 0 revision:    ${startSnap.ringZeroRevision ?? "null"} → ${endSnap.ringZeroRevision ?? "null"} (${
        revDelta == null ? "n/a" : revDelta === 0 ? "UNCHANGED" : `+${revDelta}`
      })`,
      `  onboarding queue:   ${startSnap.onboardingCount} → ${endSnap.onboardingCount} members`,
      `  included members:   ${startSnap.includedCount} → ${endSnap.includedCount}`,
      `  status transitions: ${transitions}`,
    );
  } else {
    lines.push(
      ``,
      `(Diagnostic snapshot unavailable — caller did not pass opts.peopleClient. Plumb the client through to enable richer error reports.)`,
    );
  }
  return lines.join("\n");
}
