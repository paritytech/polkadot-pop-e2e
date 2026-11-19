// Runs run.mjs once per library and bot count, each in a fresh process, and stops raising
// the bot count for a library once the main thread saturates or media degrades.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    libs: { type: 'string', default: 'ndc,ndc-native,werift,werift-gcc' },
    bots: { type: 'string', default: '12,30,60,90,120,180,240,360' },
    seconds: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '5' },
  },
});
const directory = new URL('./results/', import.meta.url).pathname;
mkdirSync(directory, { recursive: true });
const output = `${directory}${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

const isSaturated = (result) =>
  result.eventLoopUtilization >= 0.9 ||
  result.receivedFrameRatio < 0.95 ||
  result.framesSkipped > result.framesSent * 0.01 ||
  result.lossPercent > 1;

const results = [];
for (const lib of values.libs.split(',')) {
  for (const bots of values.bots.split(',')) {
    const stdout = execFileSync(
      process.execPath,
      ['--expose-gc', 'run.mjs', '--lib', lib, '--bots', bots, '--seconds', values.seconds, '--warmup', values.warmup],
      { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: 600_000 },
    );
    const result = { ...JSON.parse(stdout.trim().split('\n').at(-1)), saturated: false };
    result.saturated = isSaturated(result);
    results.push(result);
    appendFileSync(output, `${JSON.stringify(result)}\n`);
    if (result.saturated) break;
  }
}

console.log(`\nresults: ${output}\n`);
console.log('| library | K | CPU % total | CPU %/bot | main thread busy | MB/bot | loss % | jitter ms (mean/p95) | rx frames | rx kbit/s per bot | saturated |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const result of results) {
  console.log(
    `| ${result.lib} | ${result.bots} | ${result.cpuPercent} | ${result.cpuPercentPerBot} | ${Math.round(result.eventLoopUtilization * 100)}% | ${result.mbPerBot} | ${result.lossPercent} | ${result.jitterMeanMs}/${result.jitterP95Ms} | ${Math.round(result.receivedFrameRatio * 100)}% | ${result.receiveKbpsPerBot} | ${result.saturated ? 'yes' : ''} |`,
  );
}
