import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { capture, forkRpc, main, readChainFile } from "./capture.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "capture-"));

describe("readChainFile", () => {
  it("reads chain=path lines, relative to the file, skipping blanks and comments", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "plan.env"), "# upgrades\npeople=live/people.wasm\n\nasset-hub=/abs/asset-hub.wasm\n");
    assert.deepEqual(
      [...readChainFile(path.join(dir, "plan.env"))],
      [
        ["people", path.join(dir, "live", "people.wasm")],
        ["asset-hub", "/abs/asset-hub.wasm"],
      ],
    );
  });

  it("refuses a line that is not chain=path", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "plan.env"), "people\n");
    assert.throws(() => readChainFile(path.join(dir, "plan.env")), /not a chain=path line: people/);
  });
});

describe("forkRpc", () => {
  const rpc = forkRpc("# ports\nRELAY_ALICE_PORT=10000\nPEOPLE_PORT=10010\nASSET_HUB_PORT=10020 # collator\n");

  it("maps a chain to its fork node's port", () => {
    assert.equal(rpc("people"), "http://127.0.0.1:10010");
    assert.equal(rpc("asset-hub"), "http://127.0.0.1:10020");
    assert.equal(rpc("relay"), "http://127.0.0.1:10000");
    assert.equal(rpc("bulletin"), undefined);
  });
});

// Real runtimes from fixtures/ (see fixtures/README.md): capture opens every blob. Skipped without them.
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("capture", { skip }, () => {
  const PEOPLE = "next_people_paseo_runtime.compact.compressed.wasm";
  const people = () => fs.readFileSync(path.join(FIXTURES, "runtime-0.3.4", PEOPLE));

  // One local server stands in for both a node's RPC and GitHub's release downloads.
  let server: http.Server;
  let base = "";
  before(async () => {
    server = http.createServer((request, response) => {
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          const { id } = JSON.parse(body) as { id: number };
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${people().toString("hex")}` }));
        });
      } else if (request.url === `/paritytech/individuality-community/releases/download/v0.3.4/${PEOPLE}`) {
        response.end(people());
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("captures :code over RPC and indexes it", async () => {
    const out = tmp();
    const { captured, failed } = await capture("live", ["people"], { kind: "rpc", urls: new Map([["people", base]]) }, out);
    assert.deepEqual(failed, []);
    assert.equal(captured[0]?.specVersion, 3004000);
    assert.equal(fs.readFileSync(path.join(out, "live.env"), "utf8"), "people=live/people.wasm\n");
    assert.deepEqual(fs.readFileSync(path.join(out, "live", "people.wasm")), people());
  });

  it("finds the fork's node through ports.env", async () => {
    const out = tmp();
    const ports = path.join(out, "ports.env");
    fs.writeFileSync(ports, `PEOPLE_PORT=${new URL(base).port}\n`);
    const { captured } = await capture("live", ["people"], { kind: "ports", ports }, out);
    assert.equal(captured[0]?.chain, "people");
  });

  it("downloads a release's asset by the name release-map.mjs gives it", async () => {
    const out = tmp();
    const source = { kind: "release" as const, repo: "paritytech/individuality-community", tag: "v0.3.4", network: "previewnet", base };
    const { captured, failed } = await capture("candidate", ["people", "bulletin"], source, out);
    assert.deepEqual(captured.map((c) => c.chain), ["people"]);
    // Bulletin's runtime comes from another repo: nothing to download here.
    assert.match(failed[0]?.error ?? "", /no paritytech\/individuality-community runtime for bulletin on previewnet/);
    assert.equal(fs.readFileSync(path.join(out, "candidate.env"), "utf8"), "people=candidate/people.wasm\n");
  });

  it("copies a plan's files, and leaves out one that is not a runtime", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "junk.wasm"), "not a runtime");
    const files = new Map([
      ["people", path.join(FIXTURES, "runtime-0.3.4", PEOPLE)],
      ["asset-hub", path.join(out, "junk.wasm")],
    ]);
    const { captured, failed } = await capture("candidate", ["people", "asset-hub"], { kind: "plan", files }, out);
    assert.deepEqual(captured.map((c) => c.chain), ["people"]);
    assert.deepEqual(failed.map((f) => f.chain), ["asset-hub"]);
    assert.equal(fs.readFileSync(path.join(out, "candidate.env"), "utf8"), "people=candidate/people.wasm\n");
  });

  it("reports a release asset that is not there", async () => {
    const source = { kind: "release" as const, repo: "paritytech/individuality-community", tag: "v9.9.9", network: "previewnet", base };
    const { failed } = await capture("live", ["people"], source, tmp());
    assert.match(failed[0]?.error ?? "", /HTTP 404/);
  });
});

describe("capture's command line", () => {
  const quietly = async (args: string[]) => {
    const original = console.error;
    console.error = () => {};
    try {
      return await main(args);
    } finally {
      console.error = original;
    }
  };

  it("refuses a missing side, output or source", async () => {
    assert.equal(await quietly([]), 2);
    assert.equal(await quietly(["sideways", "--out", tmp()]), 2);
    assert.equal(await quietly(["live", "--plan", "x"]), 2);
    assert.equal(await quietly(["live", "--out", tmp()]), 2);
    assert.equal(await quietly(["live", "--out", tmp(), "--release", "owner/repo"]), 2);
    assert.equal(await quietly(["live", "--out", tmp(), "--release", "owner/repo@v1"]), 2);
  });

  it("writes an empty index when there is nothing to capture, as in a steady-state run", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "upgrades.env"), "");
    assert.equal(await quietly(["candidate", "--out", out, "--plan", path.join(out, "upgrades.env")]), 0);
    assert.equal(fs.readFileSync(path.join(out, "candidate.env"), "utf8"), "");
  });
});
