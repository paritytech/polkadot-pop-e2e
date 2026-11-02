// Where a product-sdk's code (U) and descriptors (D) are, in either layout:
//
//   source     `product-sdk/packages` of the source repo: each package's src/, and
//              descriptors/ with its .scale files
//   installed  a project that depends on the SDK, as `packages/chain-tests`: every
//              @parity SDK package npm installed for it, found by following
//              dependencies the way Node resolves them, and the dist/ each one ships
//
// The dependency walk follows `installedSdk` in runtime-diff/sdk.ts.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const SDK_SCOPE = /^@parity\/(product-sdk|bulletin-sdk)/;
const DESCRIPTORS = "@parity/product-sdk-descriptors";
// The package that builds the chain clients from the descriptors: when packages pin
// different descriptor versions, its version is the one the clients use.
const CHAIN_CLIENT = "@parity/product-sdk-chain-client";

export interface SdkLocation {
  layout: "source" | "installed";
  /** The descriptors package's folder; its chains are in `chains/<chain>`. */
  descriptors: string;
  /** The folders to scan for U. */
  code: string[];
  /** Name and version of every SDK package found, for the report. */
  packages: { name: string; version: string }[];
  /** Things worth saying that do not stop the run, e.g. several descriptor versions. */
  warnings: string[];
}

const Manifest = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});
type Manifest = z.infer<typeof Manifest>;

function readManifest(dir: string): Manifest {
  const file = path.join(dir, "package.json");
  const parsed = Manifest.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The nearest `node_modules/<name>` above `from`, the way Node resolves it, as a real path. */
function resolvePackage(from: string, name: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

/**
 * Every SDK package reachable from `root`'s dependencies, at the version installed.
 * pnpm keeps each package's own dependencies next to its real path, so resolving from
 * there finds the version it pins. Development dependencies count only for `root`.
 */
function installedPackages(root: string): Map<string, Manifest> {
  const found = new Map<string, Manifest>(); // real dir -> manifest
  const queue: { dir: string; manifest: Manifest; isRoot: boolean }[] = [
    { dir: fs.realpathSync(root), manifest: readManifest(root), isRoot: true },
  ];
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { dependencies, devDependencies, peerDependencies } = item.manifest;
    const names = Object.keys({ ...dependencies, ...peerDependencies, ...(item.isRoot ? devDependencies : {}) });
    for (const name of names.filter((n) => SDK_SCOPE.test(n))) {
      const dir = resolvePackage(item.dir, name);
      if (!dir || found.has(dir)) continue;
      const manifest = readManifest(dir);
      found.set(dir, manifest);
      queue.push({ dir, manifest, isRoot: false });
    }
  }
  return found;
}

function installed(root: string): SdkLocation {
  const packages = installedPackages(root);
  const descriptorDirs = [...packages].filter(([, m]) => m.name === DESCRIPTORS).map(([dir]) => dir);
  if (descriptorDirs.length === 0) throw new Error(`${root}: no ${DESCRIPTORS} among its installed dependencies`);

  const warnings: string[] = [];
  let descriptors = descriptorDirs[0] ?? "";
  if (descriptorDirs.length > 1) {
    const client = [...packages].find(([, m]) => m.name === CHAIN_CLIENT)?.[0];
    const used = client ? resolvePackage(client, DESCRIPTORS) : null;
    descriptors = used ?? descriptors;
    const versions = descriptorDirs.map((dir) => packages.get(dir)?.version).join(", ");
    warnings.push(
      `${DESCRIPTORS} is installed at ${descriptorDirs.length} versions (${versions}); using ${packages.get(descriptors)?.version}, the one ${CHAIN_CLIENT} uses`,
    );
  }

  const code = [...packages]
    .filter(([, m]) => m.name !== DESCRIPTORS)
    .map(([dir]) => path.join(dir, "dist"))
    .filter((dist) => fs.existsSync(dist));
  return {
    layout: "installed",
    descriptors,
    code,
    packages: [...packages.values()].map(({ name, version }) => ({ name, version })),
    warnings,
  };
}

function source(dir: string): SdkLocation {
  const packages = fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((pkg) => fs.existsSync(path.join(pkg, "package.json")))
    .map((pkg) => readManifest(pkg));
  return {
    layout: "source",
    descriptors: path.join(dir, "descriptors"),
    code: [dir],
    packages: packages.map(({ name, version }) => ({ name, version })),
    warnings: [],
  };
}

/** Which layout `dir` is, and where its U and D are in it. */
export default function locateSdk(dir: string): SdkLocation {
  const descriptorsHere = path.join(dir, "descriptors", "package.json");
  if (fs.existsSync(descriptorsHere) && readManifest(path.dirname(descriptorsHere)).name === DESCRIPTORS) {
    return source(dir);
  }
  if (fs.existsSync(path.join(dir, "package.json"))) return installed(dir);
  throw new Error(`${dir} is neither product-sdk/packages nor a project with the SDK installed`);
}
