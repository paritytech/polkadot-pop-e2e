// buildRequirements with the descriptors in fixtures/ (see fixtures/README.md) and
// usage scanned from small packages written for each test. Skipped without fixtures.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import SdkDescriptor from "../descriptor/index.ts";
import type { ChainKey, RequirementSet } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import buildRequirements from "./index.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";
const packagesOf = (sdk: string) => path.join(FIXTURES, `product-sdk-${sdk}`, "product-sdk", "packages");

describe("buildRequirements", { skip }, () => {
  const paseo = async (sdk = "0.42.0"): Promise<Record<ChainKey, SdkDescriptor>> => {
    const load = (chain: string) => SdkDescriptor.load(path.join(packagesOf(sdk), "descriptors", "chains", chain));
    return { individuality: await load("paseo-individuality"), assetHub: await load("paseo-asset-hub"), bulletin: await load("paseo-bulletin") };
  };

  /** Usage of one package whose src/read.ts is `source`. */
  const usageOf = (source: string): SdkUsage => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/app" }));
    fs.writeFileSync(path.join(dir, "src", "read.ts"), source);
    return SdkUsage.scan(dir);
  };

  /** Each chain's requirements as `selector placedBy`. */
  const placement = (set: RequirementSet) =>
    Object.fromEntries(set.chains.map((c) => [c.chain, c.entries.map((e) => `${e.selector} ${e.placedBy}`)]));

  it("puts a read on the chain the code names", async () => {
    const set = buildRequirements(await paseo(), usageOf(`chain.individuality.query.Game.Players;`));
    assert.deepEqual(placement(set), {
      individuality: ["query:Game.Players chain"],
      assetHub: [],
      bulletin: [],
    });
    const [requirement] = set.chains[0]?.entries ?? [];
    assert.equal(requirement?.expected?.selector, "query:Game.Players");
    assert.equal(requirement?.direction, "both");
  });

  it("puts a read with no chain on every chain whose descriptor has the pallet", async () => {
    const set = buildRequirements(await paseo(), usageOf(`api.tx.Coinage.transfer(x);\napi.query.System.Number;`));
    assert.deepEqual(placement(set), {
      individuality: ["query:System.Number pallet", "tx:Coinage.transfer pallet"],
      assetHub: ["query:System.Number pallet"],
      bulletin: ["query:System.Number pallet"],
    });
  });

  it("keeps the reads no chain takes", async () => {
    const set = buildRequirements(await paseo(), usageOf(`api.tx.NoSuchPallet.go(x);`));
    assert.deepEqual(set.unplaced.map((u) => u.selector), ["tx:NoSuchPallet.go"]);
  });

  it("leaves out chains without a descriptor, and keeps their reads as unplaced", async () => {
    const { individuality } = await paseo();
    const set = buildRequirements({ individuality }, usageOf(`chain.bulletin.query.TransactionStorage.ByteFee;`));
    assert.deepEqual(set.chains.map((c) => c.chain), ["individuality"]);
    assert.deepEqual(set.unplaced.map((u) => `${u.chain} ${u.selector}`), ["bulletin query:TransactionStorage.ByteFee"]);
  });

  it("collects every use of a selector into one requirement", async () => {
    const set = buildRequirements(
      await paseo(),
      usageOf(`chain.individuality.query.Game.Players;\nconst q = chain.individuality.query.Game;\nq.Players;`),
    );
    const entries = set.chains[0]?.entries ?? [];
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.uses.map((u) => u.line), [1, 3]);
  });

  it("has no expected type for an entry the descriptor lacks: its name is all that is checked", async () => {
    const set = buildRequirements(await paseo(), usageOf(`chain.individuality.query.Game.NoSuchEntry;`));
    const [requirement] = set.chains[0]?.entries ?? [];
    assert.equal(requirement?.selector, "query:Game.NoSuchEntry");
    assert.equal(requirement?.expected, null);
  });

  it("is optional only when every use is", async () => {
    const optional = async (source: string) => buildRequirements(await paseo(), usageOf(source)).chains[0]?.entries[0]?.optional;
    assert.equal(await optional(`chain.individuality.query.Game?.Players;`), true);
    assert.equal(await optional(`chain.individuality.query.Game?.Players;\nchain.individuality.query.Game.Players;`), false);
  });

  it("signs on a chain with a tx requirement", async () => {
    const set = buildRequirements(await paseo(), usageOf(`chain.individuality.tx.Game.report(x);\nchain.assetHub.query.System.Number;`));
    assert.deepEqual(
      set.chains.map((c) => `${c.chain} ${c.signs}`),
      ["individuality true", "assetHub false", "bulletin false"],
    );
  });

  it("builds R for the fixture SDKs", async () => {
    const set = buildRequirements(await paseo("0.42.0"), SdkUsage.scan(packagesOf("0.42.0")));
    assert.deepEqual(
      set.chains.map((c) => `${c.chain} ${c.entries.length}`),
      ["individuality 53", "assetHub 18", "bulletin 6"],
    );
    assert.deepEqual(set.unplaced, []);
    const people = set.chains[0]?.entries ?? [];
    // Read with `?.`: the SDK works on runtimes without the NetworkSuffix pallet.
    assert.equal(people.find((e) => e.selector === "query:NetworkSuffix.NetworkSuffix")?.optional, true);
    // Read by the SDK, but not in its own descriptor: the issue's example of a surface to check by name.
    assert.equal(people.find((e) => e.selector === "constant:Score.Suffix")?.expected, null);
  });
});
