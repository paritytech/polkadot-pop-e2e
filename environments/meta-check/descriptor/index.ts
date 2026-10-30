// D: the metadata a product-sdk's descriptors were generated from, read from the
// descriptors package's source, `product-sdk/packages/descriptors/chains/<chain>`.
//
// polkadot-api.json names the `.scale` file the descriptors were generated from and
// the code hash of the runtime it came from.

import fs from "node:fs";
import path from "node:path";
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

export default class SdkDescriptor extends MetadataView {
  readonly chain: string;
  readonly codeHash: string;

  private constructor(chain: string, codeHash: string, metaDataScale: Uint8Array) {
    super(metaDataScale);
    this.chain = chain;
    this.codeHash = codeHash;
  }

  /** `chainDir` is `.../descriptors/chains/<chain>`. */
  static load(chainDir: string): SdkDescriptor {
    const configFile = path.join(chainDir, CONFIG);
    const parsed = PapiConfig.safeParse(JSON.parse(fs.readFileSync(configFile, "utf8")));
    if (!parsed.success) throw new Error(`${configFile}:\n${z.prettifyError(parsed.error)}`);
    const [{ metadata, codeHash }] = parsed.data.entries;
    // papi runs from the chain's directory, so the metadata path is relative to it.
    const bytes = fs.readFileSync(path.resolve(chainDir, metadata));
    return new SdkDescriptor(path.basename(chainDir), codeHash, bytes);
  }
}
