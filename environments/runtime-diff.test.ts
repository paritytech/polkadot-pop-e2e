// The runtime diff. The fixtures are the pinned product-sdk descriptor's own metadata,
// edited the way a runtime release would edit it, so the tests need no chain, no wasm
// and no network.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompatibilityLevel } from "@polkadot-api/metadata-compatibility";
import {
  descriptorChainFor,
  diffMetadata,
  diffPipelines,
  forkPorts,
  grade,
  installedSdk,
  loadDescriptor,
  selectorsIn,
  type Descriptor,
} from "./runtime-diff.ts";
import { decodeMetadata, type UnifiedMetadata } from "./runtime-watch/metadata.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(HERE, "..", "packages", "chain-tests");

const clone = (metadata: UnifiedMetadata): UnifiedMetadata => structuredClone(metadata);
const pallet = (metadata: UnifiedMetadata, name: string) => metadata.pallets.find((p) => p.name === name)!;
const descriptorsDir = (): string => {
  const descriptors = installedSdk(TESTS_DIR).find((p) => p.name === "@parity/product-sdk-descriptors");
  assert.ok(descriptors, "chain-tests pulls @parity/product-sdk-descriptors in through product-sdk");
  return descriptors.dir;
};

let descriptor: Descriptor;
let metadata: UnifiedMetadata; // what the descriptor was generated from: the SDK and this runtime agree on everything
before(async () => {
  const name = descriptorChainFor(descriptorsDir(), "previewnet", "people");
  assert.equal(name, "previewnet-individuality");
  descriptor = await loadDescriptor(descriptorsDir(), name);
  metadata = decodeMetadata(await descriptor.getMetadata!());
});

describe("SDK selectors", () => {
  it("reads typed, unsafe and optional-chained access", () => {
    const source = `
      api.query.Game.Players.getValue(x);
      client.getUnsafeApi()?.query?.NetworkSuffix?.NetworkSuffix.getValue();
      api.constants.Score.Suffix(); api.tx.Game.sign_up({}); api.apis.Metadata.metadata_at_version(16);
      api.event.System.ExtrinsicFailed.filter(e); api.view.Resources.get_lite_stmt_store_slots_per_period();
      api.query.lowercase.ignored;`;
    assert.deepEqual([...selectorsIn(source)].sort(), [
      "api:Metadata.metadata_at_version",
      "constant:Score.Suffix",
      "event:System.ExtrinsicFailed",
      "query:Game.Players",
      "query:NetworkSuffix.NetworkSuffix",
      "tx:Game.sign_up",
      "view:Resources.get_lite_stmt_store_slots_per_period",
    ]);
  });

  it("finds the SDK packages the tests run on, each at its installed version", () => {
    const names = installedSdk(TESTS_DIR).map((p) => p.name);
    for (const n of ["@parity/product-sdk", "@parity/product-sdk-individuality", "@parity/product-sdk-descriptors"]) {
      assert.ok(names.includes(n), `${n} reachable from chain-tests`);
    }
  });

  it("maps a manifest chain to the descriptor that points at the same endpoint", () => {
    assert.equal(descriptorChainFor(descriptorsDir(), "previewnet", "asset-hub"), "previewnet-asset-hub");
    assert.equal(descriptorChainFor(descriptorsDir(), "paseo-next-v2", "people"), "paseo-individuality");
    assert.equal(descriptorChainFor(descriptorsDir(), "previewnet", "relay"), null);
  });
});

describe("grades", () => {
  const { Incompatible, Partial, BackwardsCompatible, Identical } = CompatibilityLevel;

  it("is breaking only when polkadot-api now refuses every value", () => {
    assert.equal(grade(Identical, Incompatible), "breaking");
    assert.equal(grade(BackwardsCompatible, Incompatible), "breaking");
  });

  it("is partial when polkadot-api now refuses some values", () => {
    assert.equal(grade(Identical, Partial), "partial");
    assert.equal(grade(BackwardsCompatible, Partial), "partial");
  });

  it("is additive when the SDK fits as well as it did, or was already refused", () => {
    assert.equal(grade(Identical, BackwardsCompatible), "additive");
    assert.equal(grade(Partial, Partial), "additive");
    assert.equal(grade(Incompatible, Incompatible), "additive");
    assert.equal(grade(Incompatible, Identical), "additive");
  });
});

describe("entries", () => {
  it("reports nothing between a runtime and itself", async () => {
    const diff = await diffMetadata({ liveMeta: metadata, candidateMeta: clone(metadata), descriptor });
    assert.deepEqual(diff.entries, []);
    assert.equal(diff.extensions.summary, "No change.");
  });

  it("grades a removal as breaking and a new entry as additive", async () => {
    const live = clone(metadata);
    const candidate = clone(metadata);
    const score = pallet(candidate, "Score");
    const removed = score.constants[0]!.name;
    score.constants = score.constants.slice(1);
    // An entry live lacks and the candidate has is what a release adds.
    const game = pallet(live, "Game");
    const added = game.storage!.items[0]!.name;
    game.storage!.items = game.storage!.items.slice(1);

    const { entries } = await diffMetadata({ liveMeta: live, candidateMeta: candidate, descriptor });
    const by = Object.fromEntries(entries.map((e) => [e.selector, e]));
    assert.equal(by[`constant:Score.${removed}`]!.change, "removed");
    assert.equal(by[`constant:Score.${removed}`]!.severity, "breaking");
    assert.deepEqual(by[`constant:Score.${removed}`]!.sdk, { live: "Identical", candidate: "Incompatible" });
    assert.equal(by[`query:Game.${added}`]!.change, "added");
    assert.equal(by[`query:Game.${added}`]!.severity, "additive");
    assert.equal(entries[0]!.severity, "breaking", "breaking entries come first");
  });

  it("grades a type change by how the SDK fits it, not by the change alone", async () => {
    const candidate = clone(metadata);
    const items = pallet(candidate, "System").storage!.items;
    const number = items.find((i) => i.name === "Number")!;
    const digest = items.find((i) => i.name === "Digest")!;
    number.type = structuredClone(digest.type); // a u32 storage value now holds a digest

    const { entries } = await diffMetadata({ liveMeta: metadata, candidateMeta: candidate, descriptor });
    const changed = entries.find((e) => e.selector === "query:System.Number")!;
    assert.equal(changed.change, "changed");
    assert.equal(changed.severity, "breaking");
    assert.equal(changed.sdk.candidate, "Incompatible");
  });

  it("marks what the SDK reads, and lists SDK selectors the candidate dropped", async () => {
    const candidate = clone(metadata);
    const score = pallet(candidate, "Score");
    score.constants = score.constants.filter((c) => c.name !== "score_context");
    const bySdk = {
      "@parity/product-sdk-individuality": [
        "constant:Score.score_context",
        "constant:Score.Suffix",
        "query:NoSuchPallet.Item",
      ],
    };
    const diff = await diffMetadata({ liveMeta: metadata, candidateMeta: candidate, descriptor, bySdk });
    assert.equal(diff.entries.find((e) => e.selector === "constant:Score.score_context")!.sdkRef, true);
    assert.deepEqual(diff.missingSurfaces, [
      { selector: "constant:Score.score_context", packages: ["@parity/product-sdk-individuality"], alsoMissingOnLive: false },
      // Live lacked it too: not this release's doing. A pallet neither side has is
      // another chain's selector and is left out.
      { selector: "constant:Score.Suffix", packages: ["@parity/product-sdk-individuality"], alsoMissingOnLive: true },
    ]);
  });
});

describe("extension pipelines", () => {
  type Pipelines = UnifiedMetadata["extrinsic"]["extensionsByVersion"];
  const withPipelines = (base: UnifiedMetadata, pipelines: Pipelines): UnifiedMetadata => {
    const out = clone(base);
    out.extrinsic.extensionsByVersion = pipelines;
    return out;
  };

  it("reads extensions leaving v0 for a new v1 as a move, and breaking", () => {
    const v0 = metadata.extrinsic.extensionsByVersion[0]!;
    const [a, b, ...rest] = v0;
    const live = withPipelines(metadata, { 0: v0 });
    const candidate = withPipelines(metadata, { 0: rest, 1: [a!, b!, ...rest] });

    const ext = diffPipelines(live, candidate);
    assert.deepEqual(
      ext.moved.map((m) => [m.identifier, m.from, m.to]),
      [
        [a!.identifier, [0], [1]],
        [b!.identifier, [0], [1]],
      ],
    );
    assert.deepEqual(
      ext.versions.map((v) => [v.version, v.status, v.severity]),
      [
        [0, "changed", "breaking"],
        [1, "added", "additive"],
      ],
    );
    assert.equal(ext.summary, `new pipeline v1. ${a!.identifier}, ${b!.identifier} moved from v0 to v1.`);
    // Runtime Watch reads the same change as the person-pipeline split.
    assert.deepEqual(ext.watch?.moved, [a!.identifier, b!.identifier]);
    assert.deepEqual([ext.watch?.beforeVersions, ext.watch?.afterVersions], [["0"], ["0", "1"]]);
  });

  it("does not read two runtimes that both have v0 and v1 as a move", () => {
    const v0 = metadata.extrinsic.extensionsByVersion[0]!;
    const [a, ...rest] = v0;
    const split = withPipelines(metadata, { 0: rest, 1: [a!, ...rest] });
    const ext = diffPipelines(split, clone(split));
    assert.equal(ext.summary, "No change.");
    assert.equal(ext.watch, null);
  });

  it("catches an extension that keeps its name and changes its type", () => {
    const v0 = metadata.extrinsic.extensionsByVersion[0]!;
    const other = v0.find((x) => x.additionalSigned !== v0[0]!.additionalSigned)!;
    const retyped = v0.map((e, i) => (i === 0 ? { ...e, additionalSigned: other.additionalSigned } : e));
    const ext = diffPipelines(withPipelines(metadata, { 0: v0 }), withPipelines(metadata, { 0: retyped }));
    assert.deepEqual(ext.versions[0]!.retyped, [v0[0]!.identifier]);
    assert.equal(ext.versions[0]!.severity, "breaking");
    assert.equal(ext.watch, null);
  });
});

describe("fork ports", () => {
  it("reads the engine ports file, relay through alice", () => {
    const portOf = forkPorts(
      "# ports\nRELAY_ALICE_PORT=10000\nPEOPLE_PORT=10010 # people\nASSET_HUB_PORT=10020\nWEB3_STORAGE_PORT=10040\n",
    );
    assert.equal(portOf("relay"), "10000");
    assert.equal(portOf("people"), "10010");
    assert.equal(portOf("asset-hub"), "10020");
    assert.equal(portOf("web3-storage"), "10040");
    assert.equal(portOf("bulletin"), undefined);
  });
});
