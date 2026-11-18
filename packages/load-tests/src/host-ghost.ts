// Runs inside `truapi-host signing-host --script`: `truapi` and `host` are the host's globals,
// and the plan file at `GHOST_PLAN` lists which ghosts this host plays and when.
import { readFileSync, writeFileSync } from "node:fs";
import { SignallingBot } from "./bot.js";
import type { HostGhostPlan } from "./host.js";
import type { MeasurableStore } from "./measured-store.js";
import { roomOpensAt } from "./profile.js";
import { coPlayersOf } from "./seating.js";
import { DeliveryCounter, SignallingStats } from "./stats.js";
import { sleepUntil } from "./time.js";

type Hex = `0x${string}`;

interface Result<T> {
  isErr(): boolean;
  value: T;
  error: unknown;
}

interface HostStatement {
  expiry: bigint;
  channel: Hex;
  topics: Hex[];
  data: Hex;
}

interface SignedStatement {
  proof?: { tag: string; value?: { signer?: string } };
  expiry?: bigint;
  channel?: Hex;
  data?: Hex;
}

declare const truapi: {
  statementStore: {
    subscribe(options: { request: { tag: "MatchAny"; value: string[] } }): {
      subscribe(observer: {
        next(page: { statements: SignedStatement[] }): void;
        error(error: unknown): void;
        complete(): void;
      }): { unsubscribe(): void };
    };
    createProof(request: { productAccountId: unknown; statement: HostStatement }): Promise<Result<{ proof: unknown }>>;
    submit(statement: HostStatement & { proof: unknown }): Promise<Result<undefined>>;
  };
};
declare const host: { productAccount(index: number): unknown };

/** How long the app waits before opening a subscription the host ended, by attempt. */
const RESUBSCRIBE_MS = [1000, 2000, 4000, 8000, 16000];

/** A host error as text, as product-sdk-host's `formatHostError` writes it for the app. */
function hostErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const tagged = error as { tag?: unknown; reason?: unknown; value?: { tag?: unknown; value?: unknown; reason?: unknown } } | null;
  if (typeof tagged?.tag === "string") {
    if (tagged.tag === "Domain" && typeof tagged.value?.tag === "string" && tagged.value.value !== undefined) return hostErrorMessage(tagged.value.value);
    return typeof tagged.value?.reason === "string" ? `${tagged.tag}: ${tagged.value.reason}` : tagged.tag;
  }
  if (typeof tagged?.reason === "string") return tagged.reason;
  return JSON.stringify(error, (_, value) => (typeof value === "bigint" ? String(value) : value)) ?? String(error);
}

/**
 * The host's statement store for product account `productAccountId`, as the app's
 * `playerStatementStore` adapts it: proved as the player, and a subscription the host ends
 * opened again.
 */
function hostStatementStore(productAccountId: unknown, counter: DeliveryCounter): MeasurableStore {
  return {
    async createProofAuthorized(wire) {
      const result = await truapi.statementStore.createProof({ productAccountId, statement: wire as HostStatement });
      if (result.isErr()) throw new Error(`statement proof refused: ${hostErrorMessage(result.error)}`);
      return result.value.proof;
    },
    async submit(wire) {
      const result = await truapi.statementStore.submit(wire as HostStatement & { proof: unknown });
      if (result.isErr()) throw new Error(`statement submit failed: ${hostErrorMessage(result.error)}`);
    },
    subscribe(filter, onPage) {
      let attempt = 0;
      let closed = false;
      let retry: NodeJS.Timeout | undefined;
      let current: { unsubscribe(): void } | undefined;
      const open = () => {
        let ended = false;
        const end = (reason: string) => {
          if (closed || ended) return;
          ended = true;
          counter.recordEnd(reason);
          retry = setTimeout(open, RESUBSCRIBE_MS[Math.min(attempt++, RESUBSCRIBE_MS.length - 1)]);
        };
        counter.recordSubscribe();
        current = truapi.statementStore.subscribe({ request: { tag: "MatchAny", value: filter.matchAny } }).subscribe({
          next(page) {
            attempt = 0;
            onPage({
              statements: page.statements.map(({ proof, expiry, channel, data }) => ({ data, signer: proof?.value?.signer?.toLowerCase(), channel, expiry })),
            });
          },
          error: (error) => end(hostErrorMessage(error)),
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

async function play(ghost: number): Promise<void> {
  const index = plan.firstPlayer + ghost;
  const roster = coPlayersOf(index, accounts.length, profile).map((other) => accounts[other]);
  const counter = new DeliveryCounter(stats, plan.window, roster.length);
  const store = hostStatementStore(host.productAccount(plan.firstAccount + ghost), counter);
  const bot = new SignallingBot({ self: accounts[index], roster, namespace: plan.namespace, profile, store, stats, counter });
  await sleepUntil(plan.joinAt[ghost]);
  void bot.calibrate();
  await sleepUntil(roomOpensAt(plan.phase, plan.gameStart));
  bot.open();
  await sleepUntil(plan.stopAt);
  bot.close();
  await sleepUntil(plan.leaveAt);
  bot.leave();
}

await Promise.all(Array.from({ length: plan.ghosts }, (_, ghost) => play(ghost)));
writeFileSync(plan.resultPath, JSON.stringify(stats));
