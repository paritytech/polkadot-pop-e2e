/** Evidence from fresh block/state reads, independent of submitAndWatch's outcome callbacks. */
import assert from 'node:assert/strict';
import { writeCapacityJson } from './coinage-capacity.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { blake2AsHex } from '@polkadot/util-crypto';
import type { createCoinageClient, SubmissionResult } from './coinage-client.js';

type Event = { phase: { type: string; value?: unknown }; event: {
  type: string; value: { type: string; value?: unknown };
} };
type Block = { block: { header: { number: string; [key: string]: unknown }; extrinsics: string[] } };
const json = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

export function verifyReceipt(hash: string, index: number, extrinsics: string[], events: Event[], operation: string) {
  assert(Number.isInteger(index) && index >= 0 && index < extrinsics.length, 'Extrinsic index outside block');
  assert.equal(blake2AsHex(extrinsics[index]), hash, 'Transaction hash does not match the block extrinsic');
  const own = events.filter(e => e.phase.type === 'ApplyExtrinsic' && e.phase.value === index).map(e => e.event);
  assert(own.some(e => e.type === 'System' && e.value.type === 'ExtrinsicSuccess'), 'No on-chain dispatch success');
  assert(!own.some(e => e.type === 'System' && e.value.type === 'ExtrinsicFailed'), 'On-chain dispatch failed');
  assert(own.some(e => e.type === 'Coinage' && e.value.type === operation), 'Expected Coinage event missing');
  return own;
}

async function rpc<T>(port: number, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const body = await response.json() as { result: T; error?: unknown };
  assert(!body.error, `${method}: ${json(body.error)}`);
  assert(body.result != null, `${method}: missing RPC result`);
  return body.result;
}

export async function auditBurst(input: {
  name: string; expected: number; results: Array<SubmissionResult | undefined>;
  operation: 'CoinTransferred' | 'RecyclerLoadedWithExternalAsset';
  out: string; api: ReturnType<typeof createCoinageClient>['api']; summary: Record<string, unknown>;
}) {
  const { name, expected, results, operation, out, api, summary } = input;
  const receipts: unknown[] = [];
  const errors: string[] = [];
  const directory = `${out}/evidence/${name}`;
  mkdirSync(directory, { recursive: true });
  const seen = new Set<string>();
  const groups = new Map<string, Array<{ actor: number; result: SubmissionResult }>>();
  if (results.length !== expected) errors.push(`Expected ${expected} results, got ${results.length}`);
  results.forEach((result, actor) => {
    if (!result) { errors.push(`Actor ${actor}: missing result`); return; }
    if (seen.has(result.txHash)) errors.push(`Duplicate transaction hash: ${result.txHash}`);
    seen.add(result.txHash);
    if (result.status !== 'finalized' || !result.block) {
      errors.push(`Actor ${actor}: ${result.status}`); return;
    }
    const group = groups.get(result.block.hash) ?? [];
    group.push({ actor, result });
    groups.set(result.block.hash, group);
  });
  const csv = ['actor,tx_hash,block_number,block_hash,extrinsic_index,finality_ms,verified'];
  for (const [hash, group] of groups) {
    try {
      const block = await rpc<Block>(10010, 'chain_getBlock', [hash]);
      const number = Number.parseInt(block.block.header.number, 16);
      const finalityViews = [];
      for (const port of [10010, 10011]) {
        const deadline = Date.now() + 30_000;
        let head: string, header: { number: string };
        do {
          head = await rpc<string>(port, 'chain_getFinalizedHead');
          header = await rpc<{ number: string }>(port, 'chain_getHeader', [head]);
          if (Number.parseInt(header.number, 16) >= number) break;
          await delay(1000);
        } while (Date.now() < deadline);
        assert(Number.parseInt(header!.number, 16) >= number, `Node ${port} has not finalized block ${number}`);
        const canonical = await rpc<string>(port, 'chain_getBlockHash', [number]);
        assert.equal(canonical, hash, `Node ${port} reports a different canonical block`);
        finalityViews.push({ port, finalizedHash: head!, finalizedNumber: Number.parseInt(header!.number, 16), canonical });
      }
      const events = await api.query.System.Events.getValue({ at: hash, signal: AbortSignal.timeout(15_000) });
      writeFileSync(`${directory}/block-${number}.json`, json({ hash, block, events, finalityViews }) + '\n');
      const indexedEvents = new Map<number, Event[]>();
      for (const event of events) {
        if (event.phase.type !== 'ApplyExtrinsic') continue;
        const index = event.phase.value;
        const own = indexedEvents.get(index) ?? [];
        own.push(event);
        indexedEvents.set(index, own);
      }
      for (const { actor, result } of group) {
        try {
          assert.equal(result.block!.number, number, 'Reported block number differs');
          const own = verifyReceipt(result.txHash, result.block!.index, block.block.extrinsics, indexedEvents.get(result.block!.index) ?? [], operation);
          receipts.push({ actor, txHash: result.txHash, block: result.block, events: own });
          csv.push([actor, result.txHash, number, hash, result.block!.index, result.elapsedMs, true].join(','));
        } catch (error) { errors.push(`Actor ${actor}: ${String(error)}`); }
      }
    } catch (error) { errors.push(`Block ${hash}: ${String(error)}`); }
  }
  const passed = errors.length === 0 && receipts.length === expected && summary.passed === true && summary.generatorLimited !== true;
  const audit = { name, expected, verifiedReceipts: receipts.length, uniqueHashes: seen.size, passed, errors,
    operation, nodes: [10010, 10011], runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    commit: process.env.GITHUB_SHA, summary,
    trustBoundary: 'Two local RPC views plus raw block bodies and decoded events; not an independent consensus or storage-proof verification.' };
  writeFileSync(`${out}/${name}-audit.json`, json(audit) + '\n');
  writeCapacityJson(`${out}/${name}-receipts.json`, receipts);
  writeFileSync(`${out}/${name}-transactions.csv`, csv.join('\n') + '\n');
  writeFileSync(`${out}/${name}-report.md`, `# ${name}: ${passed ? 'PASS' : 'FAIL'}\n\n`
    + `Requested: **${expected}**. Independently re-read block receipts: **${receipts.length}**.\n\n`
    + `Scenario state checks: **${summary.passed === true ? 'passed' : 'failed'}**. See ${name}-summary.json for counts and latency.\n\n`
    + `Every verified hash matches the raw extrinsic at its recorded block/index. Both local People nodes report the block as canonical below their finalized heads. Each receipt has System.ExtrinsicSuccess and Coinage.${operation}.\n\n`
    + `Download this artifact; inspect ${name}-transactions.csv, ${name}-receipts.json and evidence/${name}/block-*.json. Runtime, fixture and node provenance are saved alongside them.\n\n`
    + `Driver launch time and PAPI broadcast signals are not node acceptance timestamps. A fixture-seeded claim does not prove issuance or a full wallet payment. Metrics are sampled observations, not proof of weight accuracy or production capacity.\n\n`
    + `Audit errors: ${errors.length}.\n\n${errors.map(e => '- ' + e).join('\n')}\n`);
  assert(passed, `${name}: block evidence or scenario checks failed; see audit artifact`);
  return audit;
}
