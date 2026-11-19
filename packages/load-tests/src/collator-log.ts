/** A block previewnet's People collator 1 built, and why building ended: `NoMoreTransactions`, `HitBlockWeightLimit`, `HitBlockSizeLimit` or `HitDeadline`. */
export interface Proposal {
  number: number;
  end: string;
}

const LOG_URL = "https://previewnet.substrate.dev/logs";
const CHUNK_BYTES = 4 << 20;
const PROPOSAL_LINE = /Prepared block for proposing at (\d+) \(\d+ ms\) hash: (0x[0-9a-f]+);.*; end: (\w+)/;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Collator 1's proposals for blocks `first` to `last`, built between `fromMs` and `toMs`, from
 * previewnet's public daily logs. A log lists the newest line first, so each day's log is read
 * in ranges from its start until the proposals go back past `first`.
 */
export async function readProposals(first: number, last: number, fromMs: number, toMs: number): Promise<Proposal[]> {
  const proposals = new Map<string, Proposal>();
  for (let day = Date.parse(utcDate(toMs)); day >= Date.parse(utcDate(fromMs)); day -= 86_400_000) {
    const url = `${LOG_URL}/${utcDate(day)}/people-collator1.log`;
    const decoder = new TextDecoder();
    let partialLine = "";
    for (let offset = 0; ; offset += CHUNK_BYTES) {
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + CHUNK_BYTES - 1}` }, signal: AbortSignal.timeout(60_000) });
      if (response.status === 416) break;
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`${url}: HTTP ${response.status} to a range request`);
      }
      const chunk = new Uint8Array(await response.arrayBuffer());
      const lines = (partialLine + decoder.decode(chunk, { stream: true })).split("\n");
      partialLine = lines.pop()!;
      let earlier = false;
      for (const line of lines) {
        const match = PROPOSAL_LINE.exec(line);
        if (!match) continue;
        const number = Number(match[1]);
        if (number < first) earlier = true;
        else if (number <= last) proposals.set(match[2], { number, end: match[3] });
      }
      if (earlier) return [...proposals.values()];
      if (chunk.length < CHUNK_BYTES) break;
    }
  }
  return [...proposals.values()];
}
