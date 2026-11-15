// The breaking count the Matrix alert reads. Fixtures are the real shapes from diff.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChainDiff, Diff } from "./diff.ts";
import type { EntryDiff } from "./entries.ts";
import type { PipelineRow } from "./extensions.ts";
import { isBreaking } from "./markdown.ts";
import { summarize } from "./summary.ts";

// A chain that was diffed (not one that errored).
type Diffed = Extract<ChainDiff, { entries: unknown }>;

const entry = (selector: string, severity: EntryDiff["severity"]): EntryDiff => ({
  selector,
  change: "changed",
  severity,
  sdk: { live: "Identical", candidate: "Incompatible" },
  paths: [],
  sdkRef: true,
});

const row = (version: number, breaking: boolean): PipelineRow => ({
  version,
  status: breaking ? "changed" : "same",
  breaking,
  before: ["CheckNonce"],
  after: ["CheckNonce"],
  added: [],
  removed: [],
  reordered: false,
  retyped: [],
});

const surface = (selector: string, alsoMissingOnLive: boolean) => ({
  selector,
  packages: ["@parity/product-sdk-individuality"],
  alsoMissingOnLive,
});

const people: Diffed = {
  chain: "people",
  pin: "paritytech/individuality-community@v0.4.0",
  wasm: "people.wasm",
  endpoint: "wss://previewnet.substrate.dev/people",
  descriptor: "previewnet-individuality",
  live: { specName: "people", specVersion: 3004000, transactionVersion: 6, codeHash: "0xaa" },
  candidate: { specName: "people", specVersion: 3005000, transactionVersion: 7, codeHash: "0xbb" },
  entries: [],
  extensions: {
    versions: [row(0, false)],
    moved: [],
    summary: "No change.",
    extrinsicVersions: { removed: [], added: [] },
  },
  missingSurfaces: [],
  pallets: ["PeopleLite", "System"],
};

// Each helper changes one part of a chain.
const withVersions = (chain: Diffed, versions: PipelineRow[]): Diffed => ({ ...chain, extensions: { ...chain.extensions, versions } });
const withRemoved = (chain: Diffed, removed: number[]): Diffed => ({
  ...chain,
  extensions: { ...chain.extensions, extrinsicVersions: { removed, added: [] } },
});
const noDescriptor = (chain: Diffed): Diffed => ({ ...chain, descriptor: null });

const diffOf = (chains: ChainDiff[], sdkError: string | null = null): Diff => ({
  network: "previewnet",
  sdk: [],
  sdkError,
  descriptors: sdkError === null ? "@parity/product-sdk-descriptors@0.14.0" : null,
  sdkSelectors: {},
  chains,
});

describe("runtime diff summary", () => {
  it("counts breaking entries and leaves partial and other entries out", () => {
    const chain: Diffed = {
      ...people,
      entries: [
        entry("tx:PeopleLite.set_alias_account", "breaking"),
        entry("tx:Sudo.sudo", "partial"),
        entry("event:Game.NewGame", "other"),
        entry("query:Game.Games", "breaking"),
      ],
    };
    const summary = summarize(diffOf([chain]));
    assert.equal(summary.breaking, 2);
    assert.deepEqual(summary.chains, [{ chain: "people", breaking: 2 }]);
    assert.equal(summary.unknown, 0);
  });

  it("counts breaking extension versions on a chain the SDK signs for", () => {
    const chain = withVersions({ ...people, entries: [entry("tx:PeopleLite.set_alias_account", "breaking")] }, [
      row(0, true),
      row(1, false),
      row(2, true),
    ]);
    assert.equal(summarize(diffOf([chain])).breaking, 3);
  });

  it("counts an SDK surface the candidate lost, but not one live lacked or one already a removed entry", () => {
    const chain: Diffed = {
      ...people,
      entries: [{ ...entry("constant:Game.airdrop_event_id_base", "breaking"), change: "removed" }],
      missingSurfaces: [
        surface("query:NetworkSuffix.NetworkSuffix", false),
        surface("query:Old.Gone", true),
        surface("constant:Game.airdrop_event_id_base", false),
      ],
    };
    // The removed entry is counted once, as an entry. Only the NetworkSuffix surface adds.
    assert.deepEqual(summarize(diffOf([chain])).chains, [{ chain: "people", breaking: 2 }]);
  });

  it("counts each removed extrinsic version on a chain the SDK signs for", () => {
    assert.equal(summarize(diffOf([withRemoved(people, [4, 5])])).breaking, 2);
  });

  it("counts an errored chain as unknown beside breaking chains, and sums only the breaking ones", () => {
    const withEntry: ChainDiff = { ...people, entries: [entry("tx:PeopleLite.set_alias_account", "breaking")] };
    const withVersion: ChainDiff = withVersions({ ...people, chain: "asset-hub" }, [row(0, true)]);
    const errored: ChainDiff = { ...people, chain: "bulletin", error: "no :code" };
    const summary = summarize(diffOf([withEntry, errored, withVersion]));
    assert.equal(summary.breaking, 2);
    assert.equal(summary.unknown, 1);
    assert.deepEqual(summary.chains.map((c) => [c.chain, c.breaking, c.error]), [
      ["people", 1, undefined],
      ["bulletin", 0, "no :code"],
      ["asset-hub", 1, undefined],
    ]);
  });

  it("treats every diffed chain as unknown when the SDK could not be read, each counted once", () => {
    const failed: ChainDiff = { ...people, chain: "asset-hub", error: "timeout" };
    const versioned: ChainDiff = withVersions({ ...people, chain: "bulletin" }, [row(0, true)]);
    const summary = summarize(diffOf([people, failed, versioned], "ENOENT: no such file"));
    // Three chains, each unknown exactly once: the errored one is not counted twice.
    assert.equal(summary.unknown, 3);
    assert.equal(summary.sdkError, "ENOENT: no such file");
    // The breaking extension version on bulletin is still a breaking change.
    assert.equal(summary.breaking, 1);
  });

  it("is zero for an empty diff", () => {
    assert.deepEqual(summarize(diffOf([])), { breaking: 0, chains: [], sdkError: null, unknown: 0 });
  });
});

describe("summary agrees with the job summary", () => {
  // Each variant is one chain the job summary's rule has an opinion on, with no failing
  // test naming anything. The job summary's `isBreaking` is the reference.
  const variants: [string, Diffed][] = [
    ["nothing changed", people],
    ["breaking entry", { ...people, entries: [entry("tx:PeopleLite.set_alias_account", "breaking")] }],
    ["partial and other entries only", { ...people, entries: [entry("tx:Sudo.sudo", "partial"), entry("event:Game.NewGame", "other")] }],
    ["breaking extension version", withVersions(people, [row(0, true)])],
    ["breaking extension version, no descriptor", noDescriptor(withVersions(people, [row(0, true)]))],
    ["added extension version", withVersions(people, [{ ...row(1, false), status: "added" }])],
    ["removed extrinsic version", withRemoved(people, [4])],
    ["removed extrinsic version, no descriptor", noDescriptor(withRemoved(people, [4]))],
    ["gone SDK surface", { ...people, missingSurfaces: [surface("query:NetworkSuffix.NetworkSuffix", false)] }],
    ["gone SDK surface live also lacks", { ...people, missingSurfaces: [surface("query:Old.Gone", true)] }],
    ["gone SDK surface without descriptor", noDescriptor({ ...people, missingSurfaces: [surface("query:NetworkSuffix.NetworkSuffix", false)] })],
    [
      "removed entry with its surface gone",
      {
        ...people,
        entries: [{ ...entry("constant:Game.airdrop_event_id_base", "other"), change: "removed" }],
        missingSurfaces: [surface("constant:Game.airdrop_event_id_base", false)],
      },
    ],
  ];

  it("has both breaking and calm variants, so the check cannot pass trivially", () => {
    const verdicts = variants.map(([, c]) => isBreaking(c));
    assert.ok(verdicts.includes(true) && verdicts.includes(false));
  });

  for (const [name, chain] of variants) {
    it(`${name}: breaking count > 0 exactly when the job summary says the chain breaks`, () => {
      const counted = summarize(diffOf([chain])).chains[0]?.breaking ?? 0;
      assert.equal(counted > 0, isBreaking(chain), `summary counts ${counted}`);
    });
  }

  it("does not count an entry only a failing test names, though the job summary links it", () => {
    const chain = { ...people, entries: [entry("tx:Sudo.sudo", "partial")] };
    assert.equal(isBreaking(chain, new Set(["people|tx:Sudo.sudo"])), true);
    assert.equal(summarize(diffOf([chain])).breaking, 0);
  });
});
