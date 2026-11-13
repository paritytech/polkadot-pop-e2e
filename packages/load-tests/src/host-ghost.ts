// Runs inside `truapi-host signing-host --script`: `truapi` and `host` are the host's globals,
// and the plan file at `GHOST_PLAN` lists which ghosts this host plays and when.
import { readFileSync, writeFileSync } from "node:fs";
import { toHex } from "@polkadot-api/utils";
import type { HostGhostPlan } from "./host.js";
import { bundleBytes, firstSendAt, isConnecting, nextSendAt } from "./profile.js";
import { probePayload, readProbe, topicOf, type Hex } from "./statement.js";
import { DeliveryCounter, SignallingStats, bump } from "./stats.js";
import { sleepUntil, withTimeout } from "./time.js";
import { seatOf, wireBytes, type Seat } from "./seating.js";

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

declare const truapi: {
  statementStore: {
    subscribe(options: { request: { tag: "MatchAny"; value: Hex[] } }): {
      subscribe(observer: {
        next(page: { statements: Array<{ data?: Hex }> }): void;
        error(error: unknown): void;
        complete(): void;
      }): { unsubscribe(): void };
    };
    createProof(request: { productAccountId: unknown; statement: HostStatement }): Promise<Result<{ proof: unknown }>>;
    submit(statement: HostStatement & { proof: unknown }): Promise<Result<undefined>>;
  };
};
declare const host: { productAccount(index: number): unknown };

const plan = JSON.parse(readFileSync(process.env.GHOST_PLAN!, "utf8")) as HostGhostPlan;
const { profile, window } = plan;
const stats = new SignallingStats();
const describe = (error: unknown) => JSON.stringify(error, (_, value) => (typeof value === "bigint" ? String(value) : value))?.slice(0, 160);

async function send(ghost: number, index: number, channel: Hex, seat: Seat, counter: DeliveryCounter, sequence: number, connecting: boolean): Promise<void> {
  const sentAt = Date.now();
  const statement: HostStatement = {
    expiry: (BigInt(Math.floor(sentAt / 1000) + profile.ttlSeconds) << 32n) | BigInt(sequence),
    channel,
    topics: seat.post,
    data: toHex(probePayload({ sender: index, sequence, sentAt }, wireBytes(seat, bundleBytes(profile, connecting)))) as Hex,
  };
  try {
    const proof = await withTimeout(truapi.statementStore.createProof({ productAccountId: host.productAccount(ghost), statement }), profile.submitTimeoutMs, "proof");
    if (proof.isErr()) return bump(stats.submits, `proof:${describe(proof.error)}`);
    stats.bytesSubmitted += (statement.data.length - 2) / 2;
    const submitted = await withTimeout(truapi.statementStore.submit({ ...statement, proof: proof.value.proof }), profile.submitTimeoutMs, "submit");
    stats.submitRtt.add(Date.now() - sentAt);
    if (submitted.isErr()) return bump(stats.submits, `submit:${describe(submitted.error)}`);
    bump(stats.submits, "new");
    counter.accepted(sentAt);
  } catch (error) {
    bump(stats.submits, `error:${(error as Error).message}`);
  }
}

async function play(ghost: number): Promise<void> {
  const index = plan.firstPlayer + ghost;
  const channel = topicOf(`${plan.namespace}/bundle/${index}`);
  const seat = seatOf(plan.namespace, plan.seating, profile, index);
  await sleepUntil(plan.joinAt[ghost]);
  const counter = new DeliveryCounter(stats, window, index, seat.recipients);
  counter.subscribed();
  const subscription = truapi.statementStore.subscribe({ request: { tag: "MatchAny", value: seat.listen } }).subscribe({
    next(page) {
      const now = Date.now();
      for (const statement of page.statements) counter.receive(statement.data ? readProbe(statement.data) : undefined, now);
    },
    error: (error) => counter.ended(describe(error)),
    complete: () => counter.ended("completed"),
  });
  let inflight = 0;
  let sequence = 0;
  let next = firstSendAt(profile, plan.phase, plan.gameStart, Date.now());
  for (;;) {
    await sleepUntil(next);
    if (Date.now() >= plan.stopAt) break;
    const connecting = isConnecting(profile, next - plan.gameStart);
    if (inflight >= profile.maxInflight) stats.skippedInflight++;
    else {
      inflight++;
      void send(ghost, index, channel, seat, counter, sequence++, connecting).finally(() => inflight--);
    }
    next = nextSendAt(profile, plan.phase, plan.gameStart, next, connecting);
  }
  await sleepUntil(plan.leaveAt);
  counter.finish();
  subscription.unsubscribe();
}

await Promise.all(Array.from({ length: plan.ghosts }, (_, ghost) => play(ghost)));
writeFileSync(plan.resultPath, JSON.stringify(stats));
