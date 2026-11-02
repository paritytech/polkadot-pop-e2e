import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { denormalizeLookup, type EnumVar, type LookupEntry, type MetadataPrimitives, type StructVar, type Var } from "@polkadot-api/metadata-builders";
import SdkDescriptor from "../descriptor/index.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import type { Encoding, Requirements, RuntimeDiff, Selector, TypeChange } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import compareTypes, { MAX_TYPE_CHANGES } from "./compare.ts";
import diff from "./index.ts";

// ── Hand-built runtimes: only what diff reads ────────────

// Every type gets its own id, and the name the report gives it; live and candidate share the table.
const TYPES = new Map<number, LookupEntry>();
const NAMES: unknown[] = [];
const type = <T extends Var>(name: string, def: T): LookupEntry & T => {
  const id = TYPES.size + 1;
  const entry = { id, ...def } as LookupEntry & T;
  TYPES.set(id, entry);
  NAMES[id] = { id, path: [name], params: [], def: { tag: "tuple", value: [] }, docs: [] };
  return entry;
};
const primitive = (value: MetadataPrimitives, name: string = value) => type(name, { type: "primitive", value });
const struct = (name: string, value: Record<string, LookupEntry>) =>
  type(name, { type: "struct", value: value as StructVar["value"], innerDocs: {} } as StructVar);
const enumOf = (name: string, variants: Record<string, [index: number, LookupEntry]>) =>
  type(name, {
    type: "enum",
    value: Object.fromEntries(
      Object.entries(variants).map(([key, [idx, value]]) => [key, { type: "lookupEntry", value, idx }]),
    ) as EnumVar["value"],
    innerDocs: {},
  } as EnumVar);

type Extension = { identifier: string; type: number; additionalSigned: number };

const fake = (
  entries: Partial<Record<Selector, Encoding>> = {},
  pipelines: Record<number, Extension[]> = {},
  extrinsicVersions = [4, 5],
) =>
  ({
    lookup: (id: number) => TYPES.get(id),
    entry: (selector: Selector) => (entries[selector] ? { encoding: entries[selector] } : undefined),
    pipelines: Object.fromEntries(Object.entries(pipelines).map(([version, list]) => [version, list.map((e) => e.identifier)])),
    metadata: { lookup: NAMES, extrinsic: { extensionsByVersion: pipelines, version: extrinsicVersions } },
  }) as unknown as Runtime;

/** A runtime from a type registry as metadata has it, read with PAPI's own lookup, which first met these ids. */
const fromRegistry = (registry: unknown[], ...first: number[]) => {
  const types = registry as Parameters<typeof denormalizeLookup>[0];
  const lookup = denormalizeLookup(types);
  for (const id of first) lookup(id);
  return { lookup, metadata: { lookup: types } } as unknown as Runtime;
};

const value = (type: LookupEntry): Encoding => ({ args: null, value: type });
const call = (type: LookupEntry): Encoding => ({ args: type, value: null });

const requirements = (selectors: Selector[], usesTransactions = false) =>
  ({ chain: "individuality", entries: selectors.map((selector) => ({ selector })), usesTransactions }) as unknown as Requirements;

const line = ({ path, status, before, after }: TypeChange) => `${path} ${status} ${before ?? "-"} -> ${after ?? "-"}`;
const changes = (before: Var, after: Var) => compareTypes(fake(), fake())("value", before, after).map(line);

const u16 = primitive("u16");
const u32 = primitive("u32");
const u64 = primitive("u64");

describe("compareTypes", () => {
  it("finds a field either side lacks, which PAPI's change list does not report from the receiving side", () => {
    const live = struct("Info", { who: u32, gone: u32 });
    const candidate = struct("Info", { who: u32, amount: u64 });
    assert.deepEqual(changes(live, candidate), ["value.gone removed u32 -> -", "value.amount added - -> u64"]);
  });

  it("sees what changes the encoding and PAPI calls Identical: widths, compact, account and byte lengths", () => {
    const compact = (size: "u32" | "u64") => type(`Compact<${size}>`, { type: "compact", isBig: size === "u64", size });
    const bytes = (len: number) => type(`[u8; ${len}]`, { type: "array", value: primitive("u8"), len });
    assert.deepEqual(changes(u16, u32), ["value changed u16 -> u32"]);
    assert.deepEqual(changes(u32, compact("u32")), ["value changed u32 -> Compact<u32>"]);
    assert.deepEqual(changes(compact("u32"), compact("u64")), ["value changed Compact<u32> -> Compact<u64>"]);
    assert.deepEqual(changes(type("AccountId32", { type: "AccountId32" }), type("AccountId20", { type: "AccountId20" })), [
      "value changed AccountId32 -> AccountId20",
    ]);
    assert.deepEqual(changes(bytes(32), bytes(20)), ["value changed [u8; 32] -> [u8; 20]"]);
  });

  it("names how a type encodes where its name stayed the same", () => {
    assert.deepEqual(changes(primitive("u16", "Balance"), primitive("u32", "Balance")), ["value changed u16 -> u32"]);
    assert.deepEqual(changes(struct("Key", { a: u32 }), type("Key", { type: "tuple", value: [u32, u16], innerDocs: [] })), [
      "value changed { a: u32 } -> (u32, u16)",
    ]);
  });

  it("sees fields that moved within a struct, and variants whose index changed: SCALE encodes both", () => {
    assert.deepEqual(changes(struct("Info", { a: u32, b: u16, c: u32 }), struct("Info", { b: u16, a: u32 })), [
      "value changed { a, b } -> { b, a }",
      "value.c removed u32 -> -",
    ]);
    assert.deepEqual(changes(enumOf("Event", { A: [0, u16], B: [1, u32] }), enumOf("Event", { A: [0, u32], C: [1, u32], B: [2, u32] })), [
      "value.A changed u16 -> u32",
      "value.B changed index 1 -> index 2",
      "value.C added - -> u32",
    ]);
  });

  it("finds nothing between types that encode alike, recursive ones too", () => {
    const list = () => {
      const node = struct("Node", { head: u32 });
      const self = enumOf("List", { Nil: [0, u32], Cons: [1, node] });
      Object.assign(node.value, { tail: self });
      return self;
    };
    assert.deepEqual(changes(struct("Info", { who: u32 }), struct("Info", { who: u32 })), []);
    assert.deepEqual(changes(list(), list()), []);
  });

  it("stops at a recursive type it is already comparing, and reports a change under each path", () => {
    // List = Nil | Cons(Node), Node = { head, tail: List }, twice under Call: head became u64.
    const call = (head: LookupEntry) => {
      const node = struct("Node", { head });
      const list = enumOf("List", { Nil: [0, u32], Cons: [1, node] });
      Object.assign(node.value, { tail: list });
      return struct("Call", { first: list, second: list });
    };
    assert.deepEqual(changes(call(u32), call(u64)), ["value.first.Cons.head changed u32 -> u64", "value.second.Cons.head changed u32 -> u64"]);
  });

  it("does not trust an equality that leaned on a recursive pair later found to differ", () => {
    // P = { x: X, y }, X = { back: P }: X looks equal while P is assumed equal, until P's y differs.
    const root = (y: LookupEntry) => {
      const x = struct("X", {});
      const p = struct("P", { x, y });
      Object.assign(x.value, { back: p });
      return struct("Root", { p, x });
    };
    assert.deepEqual(changes(root(u32), root(u64)), ["value.p.y changed u32 -> u64", "value.x.back.y changed u32 -> u64"]);
  });

  describe("a newtype around a type still being built, which PAPI's lookup leaves a bare { id }", () => {
    // 0: Vec<Instr>, 1: Instr = A(u16 or u32) | B(Xcm), 2: Xcm(Vec<Instr>), 3: the width.
    const registry = (width: "u16" | "u32") => [
        { id: 0, path: [], params: [], def: { tag: "sequence", value: 1 }, docs: [] },
        {
          id: 1,
          path: ["Instr"],
          params: [],
          def: {
            tag: "variant",
            value: [
              { name: "A", fields: [{ type: 3, docs: [] }], index: 0, docs: [] },
              { name: "B", fields: [{ type: 2, docs: [] }], index: 1, docs: [] },
            ],
          },
          docs: [],
        },
        { id: 2, path: ["Xcm"], params: [], def: { tag: "composite", value: [{ type: 0, docs: [] }] }, docs: [] },
        { id: 3, path: [], params: [], def: { tag: "primitive", value: { tag: width } }, docs: [] },
      ];
    /** A runtime whose lookup first met these ids, as its first entries would. */
    const runtime = (width: "u16" | "u32", ...first: number[]) => fromRegistry(registry(width), ...first);

    it("looks it up again, and finds the change inside", () => {
      const [live, candidate] = [runtime("u16", 0), runtime("u32", 0)];
      // Entering at Vec<Instr> leaves Xcm a bare { id } of Vec<Instr>.
      assert.ok(!("type" in live.lookup(2)));
      assert.deepEqual(compareTypes(live, candidate)("value", live.lookup(2), candidate.lookup(2)).map(line), [
        "value.value.A changed u16 -> u32",
      ]);
    });

    it("compares it with the same type looked up whole on the other side", () => {
      const [live, candidate] = [runtime("u16", 0), runtime("u16", 2)];
      assert.ok("type" in candidate.lookup(2));
      assert.deepEqual(compareTypes(live, candidate)("value", live.lookup(2), candidate.lookup(2)), []);
    });
  });

  describe("a tuple that PAPI's lookup reads as an array or a tuple, depending on doc comments", () => {
    // 0: u128, 1: u64, 2: Pair(…), each field of a type and documented or not.
    const pair = (...fields: [type: number, docs: string[]][]) =>
      fromRegistry([
        { id: 0, path: [], params: [], def: { tag: "primitive", value: { tag: "u128" } }, docs: [] },
        { id: 1, path: [], params: [], def: { tag: "primitive", value: { tag: "u64" } }, docs: [] },
        { id: 2, path: ["Pair"], params: [], def: { tag: "composite", value: fields.map(([type, docs]) => ({ type, docs })) }, docs: [] },
      ]);
    const compare = (live: Runtime, candidate: Runtime) =>
      compareTypes(live, candidate)("value", live.lookup(2), candidate.lookup(2)).map(line);

    it("finds nothing when a doc comment turns [u128; 2] into (u128, u128): they encode alike", () => {
      const undocumented = pair([0, []], [0, []]);
      const documented = pair([0, ["The first."]], [0, []]);
      assert.deepEqual([undocumented.lookup(2).type, documented.lookup(2).type], ["array", "tuple"]);
      assert.deepEqual(compare(undocumented, documented), []);
      assert.deepEqual(compare(documented, undocumented), []);
    });

    it("compares one with the other element by element", () => {
      assert.deepEqual(compare(pair([0, []], [0, []]), pair([0, []], [1, []])), ["value.1 changed u128 -> u64"]);
      assert.deepEqual(compare(pair([0, []], [0, []]), pair([0, ["The first."]], [0, []], [0, []])), ["value.2 added - -> u128"]);
    });
  });

  it(`stops past ${MAX_TYPE_CHANGES} changes, returning one more to say so`, () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i): [string, [number, LookupEntry]] => [`V${i}`, [i, u32]]));
    assert.equal(changes(enumOf("Big", {}), enumOf("Big", many)).length, MAX_TYPE_CHANGES + 1);
  });
});

describe("diff", () => {
  const info = struct("Info", { who: u32 });

  it("lists the entries R uses that one side lacks or that differ, with each side's types", () => {
    const live = fake({ "query:A.Same": value(u32), "query:A.Gone": value(info), "tx:A.go": call(info), "query:A.Changed": value(u32) });
    const candidate = fake({ "query:A.Same": value(u32), "constant:A.New": value(u64), "tx:A.go": call(info), "query:A.Changed": value(u64) });
    const r = diff(
      requirements(["constant:A.New", "query:A.Changed", "query:A.Gone", "query:A.Never", "query:A.Same", "tx:A.go"]),
      live,
      candidate,
    );
    assert.deepEqual(
      r.entries.map((e) => `${e.selector} ${e.status}: ${e.types.map(line).join(", ")}`),
      [
        "constant:A.New added: value added - -> u64",
        "query:A.Changed changed: value changed u32 -> u64",
        // A side with nothing is no type: a removed storage item or constant has only its value.
        "query:A.Gone removed: value removed Info -> -",
      ],
    );
    assert.ok(r.entries.every((e) => !e.truncated));
  });

  it("keeps an added or removed entry that has nothing to encode, as a call without arguments", () => {
    const none: Encoding = { args: null, value: null };
    const r = diff(requirements(["event:A.Done", "tx:A.stop", "tx:A.wait"]), fake({ "tx:A.stop": none, "tx:A.wait": none }), fake({ "event:A.Done": none, "tx:A.wait": none }));
    assert.deepEqual(
      r.entries.map((e) => `${e.selector} ${e.status} [${e.types.map(line).join(", ")}]`),
      ["event:A.Done added []", "tx:A.stop removed []"],
    );
  });

  it("says when an entry had more changes than it lists", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i): [string, [number, LookupEntry]] => [`V${i}`, [i, u32]]));
    const r = diff(requirements(["event:A.Big"]), fake({ "event:A.Big": value(enumOf("Big", {})) }), fake({ "event:A.Big": value(enumOf("Big", many)) }));
    assert.equal(r.entries[0]?.types.length, MAX_TYPE_CHANGES);
    assert.equal(r.entries[0]?.truncated, true);
  });

  it("lists the value's changes even when the args have more than the limit", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i): [string, [number, LookupEntry]] => [`V${i}`, [i, u32]]));
    const r = diff(
      requirements(["query:A.Big"]),
      fake({ "query:A.Big": { args: enumOf("Key", {}), value: u32 } }),
      fake({ "query:A.Big": { args: enumOf("Key", many), value: u64 } }),
    );
    const types = r.entries[0]?.types ?? [];
    assert.equal(types.length, MAX_TYPE_CHANGES + 1);
    assert.deepEqual(types.filter((t) => t.path.startsWith("value")).map(line), ["value changed u32 -> u64"]);
    assert.equal(r.entries[0]?.truncated, true);
  });

  describe("where the SDK uses transactions", () => {
    const grown = struct("Info", { who: u32, at: u32 });
    const ext = (identifier: string, typeId = u32.id): Extension => ({ identifier, type: typeId, additionalSigned: u32.id });
    const transactions = (
      live: Record<number, Extension[]>,
      candidate: Record<number, Extension[]>,
      { usesTransactions = true, versions = [[4, 5], [4, 5]] } = {},
    ): RuntimeDiff => diff(requirements(["tx:A.go"], usesTransactions), fake({}, live, versions[0]), fake({}, candidate, versions[1]));

    it("lists the versions added and removed, and in the rest the extensions added, removed, reordered or retyped", () => {
      const r = transactions(
        { 0: [ext("A"), ext("B"), ext("C"), ext("D", info.id)], 1: [ext("X")], 2: [ext("Same")] },
        { 0: [ext("C"), ext("A"), ext("E"), ext("D", grown.id)], 2: [ext("Same")], 3: [ext("Y")] },
      );
      assert.deepEqual(
        r.pipelines.map((p) => [p.version, p.status, p.added, p.removed, p.reordered, p.live, p.candidate]),
        [
          [0, "changed", ["E"], ["B"], true, ["A", "B", "C", "D"], ["C", "A", "E", "D"]],
          [1, "removed", [], ["X"], false, ["X"], null],
          [3, "added", ["Y"], [], false, null, ["Y"]],
        ],
      );
      assert.deepEqual(
        r.pipelines[0]?.retyped.map((e) => `${e.identifier}: ${e.types.map(line).join(", ")}`),
        ["D: type.at added - -> u32"],
      );
    });

    it("sees a retyped extension's implicit value too", () => {
      const r = transactions(
        { 0: [{ identifier: "A", type: u32.id, additionalSigned: u32.id }] },
        { 0: [{ identifier: "A", type: u32.id, additionalSigned: u64.id }] },
      );
      assert.deepEqual(r.pipelines[0]?.retyped[0]?.types.map(line), ["additionalSigned changed u32 -> u64"]);
      assert.equal(r.pipelines[0]?.reordered, false);
    });

    it("lists the extrinsic versions the candidate stops or starts accepting", () => {
      assert.deepEqual(transactions({}, {}, { versions: [[5, 4], [5, 6]] }).extrinsicVersions, {
        live: [4, 5],
        candidate: [5, 6],
        added: [6],
        removed: [4],
      });
      assert.equal(transactions({}, {}).extrinsicVersions, null);
    });

    it("leaves pipelines and extrinsic versions out where the SDK uses no transactions", () => {
      const r = transactions({ 0: [ext("A")] }, { 1: [ext("A")] }, { usesTransactions: false, versions: [[4], [5]] });
      assert.deepEqual([r.pipelines, r.extrinsicVersions], [[], null]);
    });
  });
});

// ── On the fixtures (see fixtures/README.md); skipped without them ──

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("diff on the fixtures", { skip }, () => {
  const WASM = { people: "next_people_paseo_runtime.compact.compressed.wasm", assetHub: "next_asset_hub_paseo_runtime.compact.compressed.wasm" };
  const wasm = (release: string, chain: keyof typeof WASM = "people") =>
    new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, WASM[chain])));
  const requirementsOf = async (sdk: string, chain: "individuality" | "assetHub") => {
    const packages = path.join(FIXTURES, `product-sdk-${sdk}`, "product-sdk", "packages");
    const name = chain === "individuality" ? "paseo-individuality" : "paseo-asset-hub";
    const descriptor = await SdkDescriptor.load(path.join(packages, "descriptors", "chains", name));
    const [requirements] = buildRequirements({ [chain]: descriptor }, SdkUsage.scan(packages)).chains;
    assert.ok(requirements);
    return requirements;
  };
  const peopleOf = (sdk: string) => requirementsOf(sdk, "individuality");
  const changes = (r: RuntimeDiff, selector: Selector) => r.entries.find((e) => e.selector === selector)?.types.map(line);

  it("says what changed in the entries the SDK reads, whether or not the SDK minds", async () => {
    const r = diff(await peopleOf("0.42.0"), wasm("0.3.1"), wasm("0.3.4"));
    assert.equal(r.chain, "individuality");
    assert.deepEqual(
      r.entries.map((e) => `${e.selector} ${e.status} ${e.types.length}`),
      [
        "api:NftCreditsApi.nft_claim_credit_proofs changed 2",
        "query:Airdrop.Events changed 1",
        "query:NftCredits.NftClaimCreditAwards changed 1",
        "tx:Sudo.sudo changed 6",
      ],
    );
    // PAPI lists no change for this key: its kind changed at the root.
    assert.deepEqual(changes(r, "query:NftCredits.NftClaimCreditAwards"), ["args changed u32 -> (u32, u32)"]);
    assert.deepEqual(changes(r, "tx:Sudo.sudo")?.[0], "args.call.Score.force_set_attendance added - -> { who: AccountOrPerson<AccountId32>, attended: bool, game_index: u32 }");
  });

  it("says which entries one runtime lacks, and the fields only the candidate has", async () => {
    const r = diff(await peopleOf("0.42.0"), wasm("0.3.4"), wasm("nightly-3004007"));
    assert.deepEqual(changes(r, "constant:Game.airdrop_event_id_base"), ["value removed [u8; 27] -> -"]);
    // PAPI grades this BackwardsCompatible with no change listed: live decodes the candidate's value.
    assert.deepEqual(changes(r, "query:Score.Participants"), ["value.attended_games_while_recognized added - -> u32"]);
  });

  it("says how the extension pipelines changed: the person extensions left v0, and a new v1 has them", async () => {
    const r = diff(await peopleOf("0.28.0"), wasm("0.3.1"), wasm("0.3.4"));
    assert.deepEqual(
      r.pipelines.map((p) => `v${p.version} ${p.status} +${p.added.length} -${p.removed.length} ${p.reordered} ${p.retyped.length}`),
      ["v0 changed +1 -12 false 0", "v1 added +23 -0 false 0"],
    );
    assert.deepEqual(r.pipelines[0]?.added, ["CheckMetadataHash"]);
    assert.equal(r.extrinsicVersions, null);
  });

  it("sees error variants shift index, which PAPI does not compare", async () => {
    const r = diff(await requirementsOf("0.42.0", "assetHub"), wasm("0.3.1", "assetHub"), wasm("0.3.4", "assetHub"));
    const revive = changes(r, "api:ReviveApi.call") ?? [];
    assert.deepEqual(revive.slice(0, 4), [
      "value.result.ko.Module.Assets.ContainsFreezes changed index 21 -> index 22",
      "value.result.ko.Module.Assets.ContainsHolds changed index 22 -> index 23",
      "value.result.ko.Module.Assets.TooManyReserves changed index 23 -> index 24",
      "value.result.ko.Module.Assets.AssetIdAllocationFailed added - -> ()",
    ]);
  });

  it("finds no change between two loads of one runtime", async () => {
    const r = diff(await peopleOf("0.28.0"), wasm("0.3.4"), wasm("0.3.4"));
    assert.deepEqual([r.entries, r.pipelines, r.extrinsicVersions], [[], [], null]);
  });
});
