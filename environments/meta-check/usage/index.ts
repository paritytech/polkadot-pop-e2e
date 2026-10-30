// U: the chain entries a product-sdk's code reads.
//
// Point it at any folder: all of `product-sdk/packages`, one package, its `src/`
// (TypeScript, as in the source repo) or its `dist/` (JavaScript, as npm ships it).
// Each file belongs to the package of the nearest package.json above it, the way Node
// resolves packages; reads.ts finds the entries in one file.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ChainKey, Selector, Use } from "../types.ts";
import { readsIn } from "./reads.ts";

const DESCRIPTORS = "@parity/product-sdk-descriptors";

/**
 * Packages that depend on the descriptors without reading the chain: chain-client
 * builds the clients from them and leaves the reading to the other packages.
 */
const READS_NOTHING: ReadonlySet<string> = new Set(["@parity/product-sdk-chain-client"]);

const Dependencies = z.record(z.string(), z.string()).optional();

// `name` is optional: a build can drop a `{ "type": "module" }` package.json into
// dist/, which marks the module format and is not a package of its own.
const PackageJson = z.object({
  name: z.string().optional(),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  peerDependencies: Dependencies,
});

interface Package {
  name: string;
  /** The folder holding its package.json. */
  dir: string;
  dependsOnDescriptors: boolean;
}

/** Folders that hold dependencies or tests, not the SDK's own code: `test`, `__tests__`, `manual-tests`. */
const SKIPPED_DIR = /^(node_modules|e2e|__tests__|(.+-)?tests?)$/;

/** Source and built files; not declarations or tests. `file` is relative to the scanned folder. */
const isScanned = (file: string): boolean =>
  /\.(tsx?|[cm]?js)$/.test(file) &&
  !/\.d\.tsx?$/.test(file) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
  !path.dirname(file).split(path.sep).some((dir) => SKIPPED_DIR.test(dir));

function readPackage(manifest: string): Package | null {
  const parsed = PackageJson.safeParse(JSON.parse(fs.readFileSync(manifest, "utf8")));
  if (!parsed.success) throw new Error(`${manifest}:\n${z.prettifyError(parsed.error)}`);
  const { name, dependencies, devDependencies, peerDependencies } = parsed.data;
  if (name === undefined) return null;
  return {
    name,
    dir: path.dirname(manifest),
    dependsOnDescriptors: [dependencies, devDependencies, peerDependencies].some((deps) => deps?.[DESCRIPTORS] !== undefined),
  };
}

/** The package a directory belongs to: its own package.json, or its parent's. Cached per directory. */
function packageFinder(): (dir: string) => Package | null {
  const cache = new Map<string, Package | null>();
  const packageOf = (dir: string): Package | null => {
    const known = cache.get(dir);
    if (known !== undefined) return known;
    const manifest = path.join(dir, "package.json");
    const parent = path.dirname(dir);
    const own = fs.existsSync(manifest) ? readPackage(manifest) : null;
    const found = own ?? (parent === dir ? null : packageOf(parent));
    cache.set(dir, found);
    return found;
  };
  return packageOf;
}

export default class SdkUsage {
  readonly uses: Use[];

  private constructor(uses: Use[]) {
    this.uses = uses;
  }

  /**
   * Every scanned file under each of `dirs`, except the descriptors package's own. A
   * use's `file` is relative to its folder; when there are several, as for the packages
   * npm installs, it is the package name and the path in the package instead
   * (`@parity/product-sdk-tx/dist/index.js`).
   *
   * A package that depends on the descriptors but reads nothing (and is not in
   * READS_NOTHING) means the scan missed something, such as a build change or a new
   * access pattern, so it throws instead of reporting no usage.
   */
  static scan(...dirs: string[]): SdkUsage {
    const packageOf = packageFinder();
    const uses: Use[] = [];
    const readsPerPackage = new Map<string, { pkg: Package; count: number }>();
    for (const dir of dirs) {
      const root = path.resolve(dir);
      const files = fs
        .readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter(isScanned)
        .sort()
        .map((file) => path.join(root, file));

      for (const file of files) {
        const pkg = packageOf(path.dirname(file));
        if (!pkg) throw new Error(`${file}: no package.json above it`);
        if (pkg.name === DESCRIPTORS) continue;

        const found = readsIn(file, fs.readFileSync(file, "utf8")).map(
          (read): Use => ({
            ...read,
            package: pkg.name,
            file: dirs.length > 1 ? path.join(pkg.name, path.relative(pkg.dir, file)) : path.relative(root, file),
          }),
        );
        const tally = readsPerPackage.get(pkg.name) ?? { pkg, count: 0 };
        tally.count += found.length;
        readsPerPackage.set(pkg.name, tally);
        uses.push(...found);
      }
    }

    for (const { pkg, count } of readsPerPackage.values()) {
      if (pkg.dependsOnDescriptors && !READS_NOTHING.has(pkg.name) && count === 0) {
        throw new Error(`${pkg.name} depends on ${DESCRIPTORS} but no chain read was found in its files`);
      }
    }
    return new SdkUsage(uses);
  }

  selectors(): Set<Selector> {
    return new Set(this.uses.map((use) => use.selector));
  }

  forChain(chain: ChainKey): Use[] {
    return this.uses.filter((use) => use.chain === chain);
  }

  /** Reads through a local API whose chain the code does not show. */
  unattributed(): Use[] {
    return this.uses.filter((use) => use.chain === null);
  }
}
