import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import locateSdk from "./index.ts";

/** A folder with these files, each given as its contents (objects become JSON). */
const tree = (files: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-"));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return dir;
};

describe("locateSdk", () => {
  it("finds the installed SDK packages through dependencies, and their dist/", () => {
    const dir = tree({
      "package.json": { name: "app", version: "1.0.0", dependencies: { "@parity/product-sdk-tx": "1" } },
      "node_modules/@parity/product-sdk-tx/package.json": {
        name: "@parity/product-sdk-tx",
        version: "1.0.0",
        dependencies: { "@parity/product-sdk-descriptors": "1", "left-pad": "1" },
      },
      "node_modules/@parity/product-sdk-tx/dist/index.js": "",
      "node_modules/@parity/product-sdk-descriptors/package.json": { name: "@parity/product-sdk-descriptors", version: "0.14.0" },
    });
    const sdk = locateSdk(dir);
    assert.equal(sdk.layout, "installed");
    assert.equal(sdk.descriptors, fs.realpathSync(path.join(dir, "node_modules/@parity/product-sdk-descriptors")));
    assert.deepEqual(sdk.code, [fs.realpathSync(path.join(dir, "node_modules/@parity/product-sdk-tx/dist"))]);
    assert.deepEqual(sdk.packages.map((p) => `${p.name}@${p.version}`).sort(), [
      "@parity/product-sdk-descriptors@0.14.0",
      "@parity/product-sdk-tx@1.0.0",
    ]);
    assert.deepEqual(sdk.warnings, []);
  });

  it("uses the descriptors chain-client uses when several versions are installed, and says so", () => {
    const dir = tree({
      "package.json": {
        name: "app",
        version: "1.0.0",
        dependencies: { "@parity/product-sdk-chain-client": "1", "@parity/product-sdk-descriptors": "2" },
      },
      "node_modules/@parity/product-sdk-descriptors/package.json": { name: "@parity/product-sdk-descriptors", version: "0.15.0" },
      "node_modules/@parity/product-sdk-chain-client/package.json": {
        name: "@parity/product-sdk-chain-client",
        version: "1.0.0",
        dependencies: { "@parity/product-sdk-descriptors": "1" },
      },
      "node_modules/@parity/product-sdk-chain-client/node_modules/@parity/product-sdk-descriptors/package.json": {
        name: "@parity/product-sdk-descriptors",
        version: "0.14.0",
      },
    });
    const sdk = locateSdk(dir);
    assert.match(sdk.descriptors, /product-sdk-chain-client\/node_modules\/@parity\/product-sdk-descriptors$/);
    assert.match(sdk.warnings[0] ?? "", /installed at 2 versions \(0\.15\.0, 0\.14\.0\); using 0\.14\.0/);
  });

  it("refuses an installed SDK without descriptors, and a folder that is neither layout", () => {
    const noDescriptors = tree({ "package.json": { name: "app", version: "1.0.0" } });
    assert.throws(() => locateSdk(noDescriptors), /no @parity\/product-sdk-descriptors among its installed dependencies/);
    assert.throws(() => locateSdk(tree({ "readme.md": "" })), /neither product-sdk\/packages nor a project/);
  });

  it("finds the SDK the chain tests install", () => {
    const sdk = locateSdk(path.join(import.meta.dirname, "..", "..", "..", "packages", "chain-tests"));
    assert.equal(sdk.layout, "installed");
    assert.ok(sdk.packages.some((p) => p.name === "@parity/product-sdk-individuality"));
    assert.ok(sdk.code.every((dir) => dir.endsWith(`${path.sep}dist`)));
  });
});

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

describe("locateSdk on the source repo", { skip: fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded" }, () => {
  it("reads product-sdk/packages as the source layout", () => {
    const packages = path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages");
    const sdk = locateSdk(packages);
    assert.equal(sdk.layout, "source");
    assert.equal(sdk.descriptors, path.join(packages, "descriptors"));
    assert.deepEqual(sdk.code, [packages]);
    assert.ok(sdk.packages.some((p) => p.name === "@parity/product-sdk-individuality" && p.version === "0.11.4"));
  });
});
