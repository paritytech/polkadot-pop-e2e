/** Node metric families a step reports: statement store, RPC server, pool, process. */
const PREFIXES = [
  "substrate_sub_statement_store_",
  "substrate_sync_statement",
  "substrate_rpc_",
  "substrate_ready_transactions_number",
  "substrate_block_height",
  "process_cpu_seconds_total",
  "process_resident_memory_bytes",
];

export type Sample = Record<string, number>;

/**
 * Each matching series summed over its labels, keyed by name plus the `status`/`reason`/`method`
 * labels when present; histogram buckets are dropped, their `_sum` and `_count` are kept.
 */
export async function scrape(url: string): Promise<Sample> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`failed to scrape ${url}: HTTP ${response.status}`);
  const sample: Sample = {};
  for (const line of (await response.text()).split("\n")) {
    if (line.startsWith("#") || !PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    const match = /^([a-z_:]+)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match || match[1].endsWith("_bucket")) continue;
    const labels = [...(match[2] ?? "").matchAll(/(status|reason|method|block|type)="([^"]*)"/g)].map(([, key, value]) => `${key}=${value}`);
    const key = labels.length > 0 ? `${match[1]}{${labels.join(",")}}` : match[1];
    sample[key] = (sample[key] ?? 0) + Number(match[3]);
  }
  return sample;
}

export type NodeMetrics = Record<string, Sample | { error: string }>;

/** `scrape` of every url, keyed by url; a failed scrape is recorded instead of failing the step. */
export async function scrapeAll(urls: string[]): Promise<NodeMetrics> {
  const entries = await Promise.all(
    urls.map(async (url) => [url, await scrape(url).catch((error: Error) => ({ error: error.message }))] as const),
  );
  return Object.fromEntries(entries);
}
