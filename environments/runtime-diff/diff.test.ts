// The runtime diff. The fixtures are the pinned product-sdk descriptor's own metadata,
// edited the way a runtime release would edit it, so the tests need no chain, no wasm
// and no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { CompatibilityLevel } from "@polkadot-api/metadata-compatibility";
import { capture, diffMetadata, forkPorts, readPlan } from "./diff.ts";
import { isBreaking, type Descriptor } from "./entries.ts";
import { diffPipelines } from "./extensions.ts";
import { readJson } from "./json.ts";
import { decodeMetadata, type UnifiedMetadata } from "./metadata.ts";
import { descriptorChainFor, installedSdk, loadDescriptor, releaseEndpoint, selectorsIn } from "./sdk.ts";

const TESTS_DIR = path.join(import.meta.dirname, "..", "..", "packages", "chain-tests");

function descriptorsDir(): string {
  const descriptors = installedSdk(TESTS_DIR).find((p) => p.name === "@parity/product-sdk-descriptors");
  assert.ok(descriptors, "chain-tests pulls @parity/product-sdk-descriptors in through product-sdk");
  return descriptors.dir;
}

function pallet(metadata: UnifiedMetadata, name: string) {
  const found = metadata.pallets.find((p) => p.name === name);
  assert.ok(found, `pallet ${name}`);
  return found;
}

let descriptor: Descriptor;
// What the descriptor was generated from: the SDK and this runtime agree on everything.
let metadata: UnifiedMetadata;
before(async () => {
  const name = descriptorChainFor(descriptorsDir(), "previewnet", "people");
  assert.equal(name, "previewnet-individuality");
  descriptor = await loadDescriptor(descriptorsDir(), name);
  metadata = decodeMetadata(await descriptor.getMetadata());
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

  it("matches an endpoint that differs only by a trailing slash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "descriptors-"));
    const papi = path.join(dir, "chains", "people-slash", ".papi");
    fs.mkdirSync(papi, { recursive: true });
    const wsUrl = `${releaseEndpoint("previewnet", "people") ?? ""}/`;
    fs.writeFileSync(path.join(papi, "polkadot-api.json"), JSON.stringify({ entries: { people: { wsUrl } } }));
    assert.equal(descriptorChainFor(dir, "previewnet", "people"), "people-slash");
  });
});

describe("entries", () => {
  it("is breaking when polkadot-api now refuses some or all values", () => {
    const { Incompatible, Partial, BackwardsCompatible, Identical } = CompatibilityLevel;
    assert.equal(isBreaking(Identical, Incompatible), true);
    assert.equal(isBreaking(Identical, Partial), true);
    assert.equal(isBreaking(Identical, BackwardsCompatible), false);
    // Already refused on live: not this release's doing.
    assert.equal(isBreaking(Incompatible, Incompatible), false);
  });

  it("reports nothing between a runtime and itself", async () => {
    const diff = await diffMetadata(metadata, structuredClone(metadata), descriptor);
    assert.deepEqual(diff.entries, []);
    assert.equal(diff.extensions.summary, "No change.");
    assert.ok(diff.pallets.includes("PeopleLite"));
  });

  it("grades a removal as breaking and a new entry as additive", async () => {
    const live = structuredClone(metadata);
    const candidate = structuredClone(metadata);
    const score = pallet(candidate, "Score");
    const [removed] = score.constants.splice(0, 1);
    // An entry live lacks and the candidate has is what a release adds.
    const [added] = pallet(live, "Game").storage?.items.splice(0, 1) ?? [];
    assert.ok(removed && added);

    const { entries } = await diffMetadata(live, candidate, descriptor);
    const gone = entries.find((e) => e.selector === `constant:Score.${removed.name}`);
    const fresh = entries.find((e) => e.selector === `query:Game.${added.name}`);
    assert.deepEqual([gone?.change, gone?.severity, gone?.sdk], [
      "removed",
      "breaking",
      { live: "Identical", candidate: "Incompatible" },
    ]);
    assert.deepEqual([fresh?.change, fresh?.severity], ["added", "additive"]);
    assert.equal(entries[0]?.severity, "breaking", "breaking entries come first");
  });

  it("grades a type change by how the SDK fits it, not by the change alone", async () => {
    const candidate = structuredClone(metadata);
    const items = pallet(candidate, "System").storage?.items ?? [];
    const number = items.find((i) => i.name === "Number");
    const digest = items.find((i) => i.name === "Digest");
    assert.ok(number && digest);
    number.type = structuredClone(digest.type); // a u32 storage value now holds a digest

    const { entries } = await diffMetadata(metadata, candidate, descriptor);
    const changed = entries.find((e) => e.selector === "query:System.Number");
    assert.deepEqual([changed?.change, changed?.severity, changed?.sdk.candidate], ["changed", "breaking", "Incompatible"]);
  });

  it("marks what the SDK reads, and lists SDK selectors the candidate dropped", async () => {
    const candidate = structuredClone(metadata);
    const score = pallet(candidate, "Score");
    score.constants = score.constants.filter((c) => c.name !== "score_context");
    const pkg = "@parity/product-sdk-individuality";
    const bySdk = { [pkg]: ["constant:Score.score_context", "constant:Score.Suffix", "query:NoSuchPallet.Item"] };
    const diff = await diffMetadata(metadata, candidate, descriptor, bySdk);
    assert.equal(diff.entries.find((e) => e.selector === "constant:Score.score_context")?.sdkRef, true);
    assert.deepEqual(diff.missingSurfaces, [
      { selector: "constant:Score.score_context", packages: [pkg], alsoMissingOnLive: false },
      // Live lacked it too: not this release's doing. A pallet neither side has is
      // another chain's selector and is left out.
      { selector: "constant:Score.Suffix", packages: [pkg], alsoMissingOnLive: true },
    ]);
  });
});

describe("extension pipelines", () => {
  type Pipelines = UnifiedMetadata["extrinsic"]["extensionsByVersion"];
  const withPipelines = (pipelines: Pipelines): UnifiedMetadata => {
    const out = structuredClone(metadata);
    out.extrinsic.extensionsByVersion = pipelines;
    return out;
  };
  const v0 = () => metadata.extrinsic.extensionsByVersion[0] ?? [];

  it("reads extensions leaving v0 for a new v1 as a move, and breaking", () => {
    const [a, b, ...rest] = v0();
    assert.ok(a && b);
    const ext = diffPipelines(withPipelines({ 0: v0() }), withPipelines({ 0: rest, 1: [a, b, ...rest] }));
    assert.deepEqual(
      ext.moved.map((m) => [m.identifier, m.from, m.to]),
      [
        [a.identifier, [0], [1]],
        [b.identifier, [0], [1]],
      ],
    );
    assert.deepEqual(
      ext.versions.map((v) => [v.version, v.status, v.breaking]),
      [
        [0, "changed", true],
        [1, "added", false],
      ],
    );
    assert.equal(ext.summary, `new pipeline v1. ${a.identifier}, ${b.identifier} moved from v0 to v1.`);
  });

  it("catches an extension that keeps its name and changes its type", () => {
    const [first, ...rest] = v0();
    const other = rest.find((x) => x.additionalSigned !== first?.additionalSigned);
    assert.ok(first && other);
    const ext = diffPipelines(
      withPipelines({ 0: v0() }),
      withPipelines({ 0: [{ ...first, additionalSigned: other.additionalSigned }, ...rest] }),
    );
    assert.deepEqual([ext.versions[0]?.retyped, ext.versions[0]?.breaking], [[first.identifier], true]);
  });

  it("lists a compatible type change without calling it breaking", () => {
    const candidate = withPipelines({ 0: v0() });
    const hash = v0().find((x) => x.identifier === "CheckMetadataHash");
    const mode = hash && candidate.lookup[hash.type]?.def;
    assert.ok(hash && mode?.tag === "composite");
    const modeType = candidate.lookup[mode.value[0]?.type ?? -1]?.def;
    assert.ok(modeType?.tag === "variant");
    // One more mode: every value a signer built for live still encodes.
    modeType.value.push({ name: "Extra", fields: [], index: modeType.value.length, docs: [] });
    const ext = diffPipelines(withPipelines({ 0: v0() }), candidate);
    assert.deepEqual(
      [ext.versions[0]?.status, ext.versions[0]?.retyped, ext.versions[0]?.breaking],
      ["changed", ["CheckMetadataHash"], false],
    );
  });
});

describe("gate inputs", () => {
  it("reads the engine ports file, relay through alice", () => {
    const portOf = forkPorts(
      "# ports\nRELAY_ALICE_PORT=10000\nPEOPLE_PORT=10010 # people\nASSET_HUB_PORT=10020\nWEB3_STORAGE_PORT=10040\n",
    );
    assert.deepEqual(
      ["relay", "people", "asset-hub", "web3-storage", "bulletin"].map(portOf),
      ["10000", "10010", "10020", "10040", undefined],
    );
  });

  it("records an SDK it cannot read and still writes the diff", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diff-"));
    const result = await capture({
      manifest: { network: "previewnet", chains: {} },
      plan: [["people", "/w/people.wasm"]],
      liveSource: () => undefined,
      out,
      testsDir: path.join(out, "missing"),
    });
    assert.match(result.sdkError ?? "", /ENOENT/);
    assert.deepEqual([result.sdk, result.descriptors, result.sdkSelectors], [[], null, {}]);
    assert.deepEqual(result.chains, [
      {
        chain: "people",
        pin: null,
        wasm: "people.wasm",
        endpoint: "wss://previewnet.substrate.dev/people",
        descriptor: null,
        error: "no RPC port known for people",
      },
    ]);
    assert.deepEqual(readJson(fs.readFileSync(path.join(out, "diff.json"), "utf8")), result);
  });

  it("reads the upgrade plan", () => {
    assert.deepEqual(readPlan("people=/w/people.wasm\n\nasset-hub=/w/ah.wasm\n"), [
      ["people", "/w/people.wasm"],
      ["asset-hub", "/w/ah.wasm"],
    ]);
  });
});
