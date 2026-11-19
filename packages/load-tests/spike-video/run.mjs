// One process, K bots on loopback. Prints one JSON line with the measurement window's results.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Bot, buildLinks, loadClip } from './common.mjs';

const { values } = parseArgs({
  options: {
    lib: { type: 'string', default: 'ndc' },
    bots: { type: 'string', default: '12' },
    seconds: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '16' },
    clip: { type: 'string', default: new URL('./clip.h264', import.meta.url).pathname },
  },
});
const botCount = Number(values.bots);
const measureSeconds = Number(values.seconds);
const library = await import(values.lib.startsWith('werift') ? './werift.mjs' : './ndc.mjs');
library.configure?.(values.lib);
const clip = loadClip(values.clip);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const log = (message) => process.stderr.write(`[${library.name} K=${botCount}] ${message}\n`);

global.gc?.();
const rssBaseline = process.memoryUsage().rss;
const bots = Array.from({ length: botCount }, (_, id) => new Bot(id, clip));
for (const bot of bots) bot.camera = library.createCamera(bot);

const links = buildLinks(botCount);
const connections = [];
const connectStart = performance.now();
let nextLink = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (nextLink < links.length) {
      const { first, second, group } = links[nextLink++];
      connections.push(await library.connectLink(bots[first], bots[second], group));
    }
  }),
);
const connectSeconds = (performance.now() - connectStart) / 1000;
log(`${links.length} links connected in ${connectSeconds.toFixed(1)} s, clip ${clip.kbps.toFixed(0)} kbps`);

for (const bot of bots) bot.start(performance);
const checker = setInterval(() => {
  const now = performance.now();
  for (const bot of bots) for (const stream of bot.streams) stream.check(now);
}, 250);
await sleep(Number(values.warmup) * 1000);

for (const bot of bots) bot.resetCounters();
const loopDelay = monitorEventLoopDelay({ resolution: 2 });
loopDelay.enable();
const eluStart = performance.eventLoopUtilization();
const cpuStart = process.cpuUsage();
const windowStart = performance.now();
await sleep(measureSeconds * 1000);
const windowSeconds = (performance.now() - windowStart) / 1000;
const cpu = process.cpuUsage(cpuStart);
const elu = performance.eventLoopUtilization(eluStart);
loopDelay.disable();
const rss = process.memoryUsage().rss;
clearInterval(checker);
for (const bot of bots) bot.stop();

const streams = bots.flatMap((bot) => bot.streams);
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const received = sum(streams, (stream) => stream.packets);
const lost = sum(streams, (stream) => stream.lost);
const jitters = streams.map((stream) => stream.jitter / 90).sort((left, right) => left - right);
const expectedFrames = streams.length * 24 * windowSeconds;
const cpuPercent = ((cpu.user + cpu.system) / 1e6 / windowSeconds) * 100;
const round = (value, digits = 2) => Number(value.toFixed(digits));

const result = {
  lib: library.name,
  bots: botCount,
  links: links.length,
  videoStreams: streams.length,
  connectSeconds: round(connectSeconds, 1),
  windowSeconds: round(windowSeconds, 1),
  cpuPercent: round(cpuPercent, 1),
  cpuPercentPerBot: round(cpuPercent / botCount),
  eventLoopUtilization: round(elu.utilization),
  loopDelayP99Ms: round(loopDelay.percentile(99) / 1e6, 1),
  rssMB: round(rss / 2 ** 20, 0),
  mbPerBot: round((rss - rssBaseline) / 2 ** 20 / botCount),
  framesSent: sum(bots, (bot) => bot.framesSent),
  framesSkipped: sum(bots, (bot) => bot.framesSkipped),
  receivedFrameRatio: round(sum(streams, (stream) => stream.frames) / expectedFrames, 3),
  keyframes: sum(streams, (stream) => stream.keyframes),
  pliSent: sum(bots, (bot) => bot.pliSent),
  pliReceived: sum(bots, (bot) => bot.pliReceived),
  forcedKeyframes: sum(bots, (bot) => bot.forcedKeyframes),
  packetsReceived: received,
  duplicates: sum(streams, (stream) => stream.duplicates),
  lossPercent: round((lost / Math.max(1, received + lost)) * 100, 3),
  jitterMeanMs: round(sum(jitters, (jitter) => jitter) / Math.max(1, jitters.length)),
  jitterP95Ms: round(jitters[Math.floor(jitters.length * 0.95)] ?? 0),
  receiveKbpsPerBot: round((sum(streams, (stream) => stream.bytes) * 8) / windowSeconds / 1000 / botCount, 0),
};
console.log(JSON.stringify(result));
process.exit(0);
