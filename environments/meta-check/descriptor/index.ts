// D: the metadata a product-sdk's descriptors were generated from, read from one chain
// of the descriptors package, `descriptors/chains/<chain>`.
//
// polkadot-api.json names the `.scale` file the descriptors were generated from and
// the code hash of the runtime it came from. The source repo has that file; the npm
// package does not, and carries the same bytes in its generated code instead.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import MetadataView from "../metadata-view/index.ts";

const CONFIG = path.join(".papi", "polkadot-api.json");

const PapiEntry = z.object({
  /** The `.scale` file, relative to the chain's directory. */
  metadata: z.string(),
  codeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});

/** The part of polkadot-api.json we read. A descriptor chain has exactly one entry. */
const PapiConfig = z.object({
  entries: z
    .record(z.string(), PapiEntry)
    .transform((entries) => Object.values(entries))
    .pipe(z.tuple([PapiEntry])),
});

const hasGetMetadata = (value: unknown): value is { getMetadata: () => Promise<Uint8Array> } =>
  typeof value === "object" && value !== null && "getMetadata" in value && typeof value.getMetadata === "function";

/** The metadata the npm package's generated descriptors carry, from their `getMetadata()`. */
async function generatedMetadata(chainDir: string): Promise<Uint8Array> {
  const file = path.join(chainDir, "generated", "dist", "index.js");
  if (!fs.existsSync(file)) throw new Error(`${chainDir}: neither the .scale file nor ${file}`);
  const module: Record<string, unknown> = await import(pathToFileURL(file).href);
  const descriptor = Object.values(module).find(hasGetMetadata);
  if (!descriptor) throw new Error(`${file}: no descriptor with getMetadata()`);
  return descriptor.getMetadata();
}

export default class SdkDescriptor extends MetadataView {
  readonly chain: string;
  readonly codeHash: string;

  private constructor(chain: string, codeHash: string, metaDataScale: Uint8Array) {
    super(metaDataScale);
    this.chain = chain;
    this.codeHash = codeHash;
  }

  /** `chainDir` is `.../descriptors/chains/<chain>`, in the source repo or as npm installs it. */
  static async load(chainDir: string): Promise<SdkDescriptor> {
    const configFile = path.join(chainDir, CONFIG);
    const parsed = PapiConfig.safeParse(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (!parsed.success) throw new Error(`${configFile}:\n${z.prettifyError(parsed.error)}`);
    const [{ metadata, codeHash }] = parsed.data.entries;
    // papi runs from the chain's directory, so the metadata path is relative to it.
    const scale = path.resolve(chainDir, metadata);
    const bytes = fs.existsSync(scale) ? fs.readFileSync(scale) : await generatedMetadata(chainDir);
    return new SdkDescriptor(path.basename(chainDir), codeHash, bytes);
  }
}
