// Runs inside `truapi-host signing-host --script`: `truapi` and `host` are the host's globals,
// and the plan file at `GHOST_PLAN` lists which ghosts this host plays and when.
import { readFileSync, writeFileSync } from "node:fs";
import {
  formatHostError,
  type HexString,
  type ProductAccountId,
  type SignedStatement,
  type Statement,
  type StatementProof,
  type TruApi,
} from "@parity/product-sdk-host";
import type { WireStatement } from "@jollity/statement-core";
import { SignallingBot } from "./bot.js";
import type { HostGhostPlan, HostGhostResult } from "./host.js";
import type { MeasurableStore } from "./measured-store.js";
import { roomOpensAt } from "./profile.js";
import { coPlayersOf } from "./seating.js";
import { SignallingStats } from "./stats.js";
import { sleepUntil } from "./time.js";
import { botVideo } from "./video/run.js";
import { VideoStats } from "./video/stats.js";

declare const truapi: Pick<TruApi, "statementStore">;
declare const host: { productAccount(index: number): ProductAccountId };

/** `wire` as the host takes a statement: its fields are hex the transport already wrote. */
const hostStatement = (wire: WireStatement): Statement => ({
  expiry: wire.expiry,
  channel: wire.channel as HexString,
  topics: wire.topics as HexString[],
  data: wire.data as HexString,
});

/** The account that signed a statement, absent from an on-chain proof. */
const signerOf = (statement: SignedStatement) => (statement.proof.tag === "OnChain" ? undefined : statement.proof.value.signer.toLowerCase());

/** How long the app waits before opening a subscription the host ended, by attempt. */
const RESUBSCRIBE_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * The host's statement store for product account `productAccountId`, as the app's
 * `playerStatementStore` adapts it: proved as the player, and a subscription the host ends
 * opened again.
 */
function hostStatementStore(productAccountId: ProductAccountId): MeasurableStore {
  return {
    async createProofAuthorized(wire) {
      const result = await truapi.statementStore.createProof({ productAccountId, statement: hostStatement(wire) });
      if (result.isErr()) throw new Error(`statement proof rejected: ${formatHostError(result.error)}`);
      return result.value.proof;
    },
    async submit(wire) {
      // The proof is the one `createProofAuthorized` returned for this statement.
      const result = await truapi.statementStore.submit({ ...hostStatement(wire), proof: wire.proof as StatementProof });
      if (result.isErr()) throw new Error(`statement submit failed: ${formatHostError(result.error)}`);
    },
    subscribe(filter, onPage, events) {
      let attempt = 0;
      let closed = false;
      let retry: NodeJS.Timeout | undefined;
      let current: { unsubscribe(): void } | undefined;
      const open = () => {
        let ended = false;
        const end = (reason: string) => {
          if (closed || ended) return;
          ended = true;
          events.ended(reason);
          retry = setTimeout(open, RESUBSCRIBE_MS[Math.min(attempt++, RESUBSCRIBE_MS.length - 1)]);
        };
        events.opened();
        current = truapi.statementStore.subscribe({ request: { tag: "MatchAny", value: filter.matchAny as HexString[] } }).subscribe({
          next(page) {
            attempt = 0;
            onPage({
              statements: page.statements.map((statement) => ({ data: statement.data, signer: signerOf(statement), channel: statement.channel, expiry: statement.expiry })),
            });
          },
          error: (error) => end(formatHostError(error)),
          complete: () => end("completed"),
        });
      };
      open();
      return {
        unsubscribe() {
          closed = true;
          clearTimeout(retry);
          current?.unsubscribe();
        },
      };
    },
  };
}

const plan = JSON.parse(readFileSync(process.env.GHOST_PLAN!, "utf8")) as HostGhostPlan;
const { profile, accounts } = plan;
const stats = new SignallingStats();
const video = plan.video && { ...plan.video, stats: new VideoStats() };

async function play(ghost: number): Promise<void> {
  const index = plan.firstPlayer + ghost;
  const roster = coPlayersOf(index, accounts.length, profile).map((other) => accounts[other]);
  const store = hostStatementStore(host.productAccount(plan.firstAccount + ghost));
  const bot = new SignallingBot({
    self: accounts[index],
    roster,
    namespace: plan.namespace,
    profile,
    store,
    stats,
    window: plan.window,
    video: video && botVideo(video.ice, video.turn[ghost], video.stats, { index, players: accounts.length, profile, roomOpenAt: plan.gameStart }, (other) => accounts[other]),
  });
  await sleepUntil(plan.joinAt[ghost]);
  void bot.calibrate();
  await sleepUntil(roomOpensAt(plan.phase, plan.gameStart));
  bot.open();
  await sleepUntil(plan.stopAt);
  await bot.close();
  await sleepUntil(plan.leaveAt);
  bot.leave();
}

await Promise.all(Array.from({ length: plan.ghosts }, (_, ghost) => play(ghost)));
writeFileSync(plan.resultPath, JSON.stringify({ stats, ...(video && { video: video.stats }) } satisfies HostGhostResult));
