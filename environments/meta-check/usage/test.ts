import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readsIn } from "./reads.ts";
import SdkUsage from "./index.ts";

/** The reads in a snippet, as `selector chain line`. */
const reads = (source: string): string[] =>
  readsIn("snippet.ts", source).map((r) => `${r.selector} ${r.chain ?? "-"} ${r.line}`);

describe("readsIn", () => {
  it("reads a direct access, with or without optional chaining", () => {
    assert.deepEqual(
      reads(`
        chain.individuality.query.Game.Players.getValue(key);
        chain.individuality.query?.NetworkSuffix?.NetworkSuffix;
        chain.assetHub.apis.NftsApi.owner();
      `),
      [
        "query:Game.Players individuality 2",
        "query:NetworkSuffix.NetworkSuffix individuality 3",
        "api:NftsApi.owner assetHub 4",
      ],
    );
  });

  it("maps each API word to its kind", () => {
    assert.deepEqual(
      reads(`
        api.tx.Coinage.transfer(args);
        api.constants.Resources.MaxUsernameLength;
        api.event.System.ExtrinsicSuccess.watch();
        api.view.Assets.balance_of(who);
      `),
      ["tx:Coinage.transfer - 2", "constant:Resources.MaxUsernameLength - 3", "event:System.ExtrinsicSuccess - 4", "view:Assets.balance_of - 5"],
    );
  });

  it("does not read a chain whose access stops before the entry", () => {
    assert.deepEqual(reads(`const query = chain.individuality.query.Game;`), []);
  });

  it("follows const aliases", () => {
    assert.deepEqual(
      reads(`
        const query = chain.individuality.query.Game;
        query.Players.getValue(key);
        const api = chain.individuality;
        const q = api.query;
        q.Score.Participants;
      `),
      ["query:Game.Players individuality 3", "query:Score.Participants individuality 6"],
    );
  });

  it("follows destructuring, renamed and nested", () => {
    assert.deepEqual(
      reads(`
        const { query } = chain.individuality;
        query.Game.Players;
        const { constants: c } = chain.individuality;
        c.Resources.MaxUsernameLength;
        const { individuality: { tx } } = chain;
        tx.Game.sign_up(args);
      `),
      [
        "query:Game.Players individuality 3",
        "constant:Resources.MaxUsernameLength individuality 5",
        "tx:Game.sign_up individuality 7",
      ],
    );
  });

  it("follows only the alias in scope", () => {
    assert.deepEqual(
      reads(`
        function people() {
          const query = chain.individuality.query;
          return query.Game.Players;
        }
        function assets() {
          const query = chain.assetHub.query;
          return query.Assets.Asset;
        }
      `),
      ["query:Game.Players individuality 4", "query:Assets.Asset assetHub 8"],
    );
  });

  it("does not follow a let, which can be reassigned: the read stays, without its chain", () => {
    assert.deepEqual(
      reads(`
        let query = chain.individuality.query;
        query.Game.Players;
      `),
      ["query:Game.Players - 3"],
    );
  });

  it("reads through casts and parentheses", () => {
    assert.deepEqual(reads(`(chain as GameChain).individuality.query.Game.Players;`), [
      "query:Game.Players individuality 1",
    ]);
  });

  it("skips comments, strings and in-source tests", () => {
    assert.deepEqual(
      reads(`
        // chain.individuality.query.Game.Players
        /** chain.individuality.tx.Game.sign_up */
        const text = "chain.individuality.query.Game.Players";
        if (import.meta.vitest) {
          chain.individuality.query.Game.Players;
        }
      `),
      [],
    );
  });

  it("reads plain JavaScript, as dist/ ships it", () => {
    assert.deepEqual(
      readsIn("index.js", `const query = chain.individuality.query.Game;\nquery.Players.getValue();`).map((r) => r.selector),
      ["query:Game.Players"],
    );
  });
});

describe("SdkUsage.scan", () => {
  const packagesWith = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-usage-"));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
  };
  const manifest = (name: string, devDependencies: Record<string, string> = {}) =>
    JSON.stringify({ name, devDependencies });
  const DESCRIPTORS = { "@parity/product-sdk-descriptors": "workspace:*" };

  it("records each read with its package, file and line, and skips tests and the descriptors", () => {
    const dir = packagesWith({
      "game/package.json": manifest("@x/game", DESCRIPTORS),
      "game/src/read.ts": "\nchain.individuality.query.Game.Players;",
      "game/src/read.test.ts": "chain.individuality.query.Game.Rounds;",
      "descriptors/package.json": manifest("@parity/product-sdk-descriptors"),
      "descriptors/src/x.ts": "api.query.System.Account;",
    });
    assert.deepEqual(SdkUsage.scan(dir).uses, [
      { selector: "query:Game.Players", chain: "individuality", line: 2, package: "@x/game", file: "game/src/read.ts" },
    ]);
  });

  it("throws when a package that depends on the descriptors reads nothing", () => {
    const dir = packagesWith({
      "game/package.json": manifest("@x/game", DESCRIPTORS),
      "game/src/read.ts": "export const nothing = 1;",
    });
    assert.throws(() => SdkUsage.scan(dir), /@x\/game depends on @parity\/product-sdk-descriptors/);
  });

  it("scans one package's src/, naming the package from the package.json above it", () => {
    const dir = packagesWith({
      "game/package.json": manifest("@x/game", DESCRIPTORS),
      "game/src/read.ts": "chain.individuality.query.Game.Players;",
    });
    assert.deepEqual(SdkUsage.scan(path.join(dir, "game", "src")).uses, [
      { selector: "query:Game.Players", chain: "individuality", line: 1, package: "@x/game", file: "read.ts" },
    ]);
  });

  it("skips test folders", () => {
    const dir = packagesWith({
      "game/package.json": manifest("@x/game"),
      "game/src/read.ts": "chain.individuality.query.Game.Players;",
      "game/manual-tests/try.mjs": "api.tx.System.remark(x);",
      "game/src/__tests__/read.ts": "chain.individuality.query.Game.Rounds;",
      "game/test/helpers.ts": "chain.individuality.query.Game.Seats;",
    });
    assert.deepEqual(
      SdkUsage.scan(dir).uses.map((u) => u.file),
      ["game/src/read.ts"],
    );
  });

  it("reads dist/ past a nameless package.json, and skips node_modules", () => {
    const dir = packagesWith({
      "game/package.json": manifest("@x/game", DESCRIPTORS),
      "game/dist/package.json": JSON.stringify({ type: "module" }),
      "game/dist/index.js": "chain.individuality.query.Game.Players;",
      "game/node_modules/dep/package.json": manifest("dep"),
      "game/node_modules/dep/index.js": "chain.individuality.query.Game.Rounds;",
    });
    assert.deepEqual(
      SdkUsage.scan(path.join(dir, "game")).uses.map((u) => `${u.package} ${u.file} ${u.selector}`),
      ["@x/game dist/index.js query:Game.Players"],
    );
  });

  it("throws for a file with no package.json above it", () => {
    const dir = packagesWith({ "loose/read.ts": "chain.individuality.query.Game.Players;" });
    assert.throws(() => SdkUsage.scan(dir), /no package\.json above it/);
  });

  it("accepts a package without the descriptors that reads nothing", () => {
    const dir = packagesWith({
      "logger/package.json": manifest("@x/logger"),
      "logger/src/log.ts": "export const log = console.log;",
    });
    assert.deepEqual(SdkUsage.scan(dir).uses, []);
  });
});

// Against the product-sdk versions in fixtures/ (see fixtures/README.md); skipped without them.
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("SdkUsage on the fixture SDKs", { skip }, () => {
  const scan = (sdk: string) => SdkUsage.scan(path.join(FIXTURES, `product-sdk-${sdk}`, "product-sdk", "packages"));

  it("finds the reads, with where they are", () => {
    const usage = scan("0.42.0");
    assert.equal(usage.uses.length, 112);
    assert.equal(usage.selectors().size, 71);
    assert.ok(
      usage.uses.some(
        (u) =>
          u.selector === "query:NetworkSuffix.NetworkSuffix" &&
          u.chain === "individuality" &&
          u.file === "individuality/src/rings.ts" &&
          u.line === 284,
      ),
    );
  });

  it("splits the reads by chain", () => {
    const usage = scan("0.42.0");
    assert.equal(usage.forChain("individuality").length, 79);
    assert.equal(usage.forChain("assetHub").length, 12);
    assert.equal(usage.unattributed().length, 21);
    assert.ok(usage.forChain("assetHub").every((u) => u.package === "@parity/product-sdk-nfts"));
  });

  it("scans one package's src/ the same as it is found in the whole tree", () => {
    const individuality = path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages", "individuality", "src");
    const alone = SdkUsage.scan(individuality).uses;
    const inTree = scan("0.42.0").uses.filter((u) => u.package === "@parity/product-sdk-individuality");
    assert.equal(alone.length, 74);
    assert.deepEqual(
      alone.map((u) => `${u.selector} individuality/src/${u.file}:${u.line}`),
      inTree.map((u) => `${u.selector} ${u.file}:${u.line}`),
    );
  });

  it("tells the two SDK versions apart", () => {
    const old = scan("0.24.0");
    const current = scan("0.42.0");
    assert.equal(old.selectors().size, 33);
    assert.ok(!old.selectors().has("query:NetworkSuffix.NetworkSuffix"));
    assert.ok(current.selectors().has("query:NetworkSuffix.NetworkSuffix"));
    // 0.42.0 reads everything 0.24.0 did, and more.
    assert.ok([...old.selectors()].every((s) => current.selectors().has(s)));
  });
});
