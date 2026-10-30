// report: check what `capture` collected against the SDK, and write the report.
//
//   main.ts report --in <dir> --sdk <dir> --network <name> [--descriptor chain=name,...] [--out <dir>]
//
//   --in          what capture wrote: <dir>/live.env and <dir>/candidate.env
//   --sdk         product-sdk/packages of the source repo, or a project with the SDK
//                 installed, such as packages/chain-tests (see sdk/index.ts)
//   --network     a release-map.mjs network; each chain's descriptor is the one whose
//                 endpoint matches the network's (previewnet -> previewnet-individuality)
//   --descriptor  pick a chain's descriptor by name instead (people=paseo-individuality)
//   --out         where report.md and report.json go; --in by default
//
// The markdown also goes to stdout, for the job summary. A breaking change does not
// fail the command: it is diagnosis. A chain that could not be checked does (exit 1).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { CHAINS } from "../../release-map.mjs";
import check from "../check/index.ts";
import SdkDescriptor from "../descriptor/index.ts";
import toJson from "../report/json.ts";
import renderMarkdown from "../report/markdown.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import locateSdk from "../sdk/index.ts";
import type { ChainKey, Report, Run } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import { readChainFile } from "./capture.ts";

/** Manifest chain -> the SDK's chain-client key. Chains the SDK does not read (the relay) are not here. */
const CHAIN_KEY: Record<string, ChainKey> = { people: "individuality", "asset-hub": "assetHub", bulletin: "bulletin" };

const endpoints: Record<string, Record<string, { ws?: string }>> = CHAINS;

const PapiEndpoints = z.object({ entries: z.record(z.string(), z.object({ wsUrl: z.string() })) });
const withoutSlash = (url: string): string => url.replace(/\/+$/, "");

/** The descriptor chain whose endpoint is the one release-map.mjs gives `chain` on `network`. */
function descriptorByEndpoint(descriptorsDir: string, network: string, chain: string): string {
  const ws = endpoints[network]?.[chain]?.ws;
  if (!ws) throw new Error(`release-map.mjs has no endpoint for ${chain} on ${network}; pick one with --descriptor`);
  const chainsDir = path.join(descriptorsDir, "chains");
  const match = fs.readdirSync(chainsDir).find((name) => {
    const config = path.join(chainsDir, name, ".papi", "polkadot-api.json");
    if (!fs.existsSync(config)) return false;
    const parsed = PapiEndpoints.safeParse(JSON.parse(fs.readFileSync(config, "utf8")));
    return parsed.success && Object.values(parsed.data.entries).some((e) => withoutSlash(e.wsUrl) === withoutSlash(ws));
  });
  if (!match) throw new Error(`no descriptor points at ${ws}, the ${network} endpoint for ${chain}`);
  return match;
}

export interface ReportOptions {
  in: string;
  sdk: string;
  network: string;
  /** Manifest chain -> descriptor chain name, overriding the endpoint match. */
  descriptors?: Map<string, string>;
}

/** Check every upgraded chain in `<in>/candidate.env`. A chain that cannot be checked is recorded, not thrown. */
export async function report(options: ReportOptions): Promise<{ run: Run; warnings: string[] }> {
  const candidates = readChainFile(path.join(options.in, "candidate.env"));
  const liveFile = path.join(options.in, "live.env");
  const lives = fs.existsSync(liveFile) ? readChainFile(liveFile) : new Map<string, string>();
  const warnings: string[] = [];
  const failed: Run["failed"] = [];
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // The chains to check, with the SDK's key and descriptor for each.
  const sdk = locateSdk(options.sdk);
  warnings.push(...sdk.warnings);
  const chains: { chain: string; key: ChainKey; descriptor: SdkDescriptor }[] = [];
  for (const chain of candidates.keys()) {
    const key = CHAIN_KEY[chain];
    if (!key) {
      warnings.push(`${chain}: the SDK does not read this chain; not checked`);
      continue;
    }
    try {
      const name = options.descriptors?.get(chain) ?? descriptorByEndpoint(sdk.descriptors, options.network, chain);
      chains.push({ chain, key, descriptor: await SdkDescriptor.load(path.join(sdk.descriptors, "chains", name)) });
    } catch (error) {
      failed.push({ chain, error: errorText(error) });
    }
  }

  // Nothing upgraded (a steady-state run), or nothing loadable: no SDK read can matter.
  if (chains.length === 0) return { run: { reports: [], unplaced: [], failed }, warnings };

  const set = buildRequirements(
    Object.fromEntries(chains.map(({ key, descriptor }) => [key, descriptor])),
    SdkUsage.scan(...sdk.code),
  );
  const reports: Report[] = [];
  for (const { chain, key } of chains) {
    const requirements = set.chains.find((r) => r.chain === key);
    const live = lives.get(chain);
    const candidate = candidates.get(chain);
    try {
      if (!requirements) throw new Error(`no requirements were built for ${key}`);
      if (!live) throw new Error(`no live runtime in ${liveFile}`);
      if (!candidate) throw new Error("no candidate runtime");
      reports.push(check(requirements, new Runtime(fs.readFileSync(live)), new Runtime(fs.readFileSync(candidate))));
    } catch (error) {
      failed.push({ chain, error: errorText(error) });
    }
  }
  return { run: { reports, unplaced: set.unplaced, failed }, warnings };
}

const pairs = (text: string): Map<string, string> =>
  new Map(
    text
      .split(",")
      .filter(Boolean)
      .map((pair): [string, string] => {
        const at = pair.indexOf("=");
        if (at <= 0) throw new Error(`not a chain=name pair: ${pair}`);
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );

const USAGE = "usage: main.ts report --in <dir> --sdk <dir> --network <name> [--descriptor chain=name,...] [--out <dir>]";

/** `report ...`, from the command line. Returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      in: { type: "string" },
      sdk: { type: "string" },
      network: { type: "string" },
      descriptor: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.in || !values.sdk || !values.network) {
    console.error(`--in, --sdk and --network are required\n${USAGE}`);
    return 2;
  }

  try {
    const { run, warnings } = await report({
      in: values.in,
      sdk: values.sdk,
      network: values.network,
      descriptors: values.descriptor ? pairs(values.descriptor) : undefined,
    });
    for (const warning of warnings) console.error(`warning: ${warning}`);
    for (const { chain, error } of run.failed) console.error(`${chain}: not checked: ${error}`);

    const markdown = renderMarkdown(run);
    const out = values.out ?? values.in;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "report.md"), `${markdown}\n`);
    fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify(toJson(run), null, 2)}\n`);
    console.log(markdown);
    return run.failed.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`report failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
