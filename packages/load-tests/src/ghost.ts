import {
  SUBMIT_TIMEOUT_MS,
  decodeStatement,
  encodeStatement,
  fromHex,
  isSubmitSuccess,
  keypairStatementProver,
  toHex,
  type StatementFields,
  type StatementProof,
  type SubmitResult,
  type WireStatement,
} from "@jollity/statement-core";
import { SignallingBot } from "./bot.js";
import type { Player } from "./keys.js";
import type { DeliveredStatement, MeasurableStore } from "./measured-store.js";
import { roomOpensAt, type Phase, type SignallingProfile } from "./profile.js";
import { RpcConnection } from "./rpc.js";
import { DeliveryCounter, bump, type SignallingStats } from "./stats.js";

export interface GhostRoom {
  profile: SignallingProfile;
  phase: Phase;
  /** Prefix of every topic and channel of this step, so steps and runs never share one. */
  namespace: string;
  /** When the room opens, the pre-connect before the game. */
  gameStart: number;
  window: { start: number; end: number };
  stats: SignallingStats;
}

const SUBSCRIBE = "statement_subscribeStatement";
const UNSUBSCRIBE = "statement_unsubscribeStatement";

const fieldsOf = (wire: WireStatement): StatementFields => ({
  expiry: wire.expiry,
  channel: fromHex(wire.channel),
  topic1: fromHex(wire.topics[0]!),
  data: fromHex(wire.data),
});

/**
 * The store of a player that signs its own statements and talks to People over `connection`,
 * as the app's standalone store does, with one subscription to all its topics as a host opens.
 */
function rpcStatementStore(connection: RpcConnection, player: Player, stats: SignallingStats, counter: DeliveryCounter): MeasurableStore {
  const prover = keypairStatementProver(player);
  return {
    createProofAuthorized: (wire) => prover.prove(fieldsOf(wire)),
    async submit(wire) {
      const encoded = toHex(encodeStatement(wire.proof as StatementProof, fieldsOf(wire)));
      const result = (await connection.request("statement_submit", [encoded], SUBMIT_TIMEOUT_MS)) as SubmitResult;
      if (!isSubmitSuccess(result)) throw new Error(`statement rejected: ${JSON.stringify(result)}`);
      return result;
    },
    subscribe(filter, onPage) {
      let subscription: string | undefined;
      let closed = false;
      const unsubscribe = () => void connection.unsubscribe(UNSUBSCRIBE, subscription!, SUBMIT_TIMEOUT_MS).catch(() => {});
      connection
        .subscribe(SUBSCRIBE, [{ matchAny: filter.matchAny }], SUBMIT_TIMEOUT_MS, {
          onNotification: (result) => {
            const encoded = (result as { data?: { statements?: string[] } }).data?.statements ?? [];
            onPage({
              statements: encoded.flatMap((statement): DeliveredStatement[] => {
                try {
                  const decoded = decodeStatement(fromHex(statement));
                  return [{ data: toHex(decoded.data), signer: toHex(decoded.proof.signer), channel: toHex(decoded.channel), expiry: decoded.expiry }];
                } catch {
                  return [];
                }
              }),
            });
          },
          onEnd: (reason) => counter.recordEnd(reason),
        })
        .then(
          (id) => {
            subscription = id;
            counter.recordSubscribe();
            if (closed) unsubscribe();
          },
          (error: Error) => bump(stats.subscribeFailures, error.message),
        );
      return {
        unsubscribe: () => {
          closed = true;
          if (subscription) unsubscribe();
        },
      };
    },
  };
}

/** A player that only signals, over a direct RPC connection, as the app's transport signals. */
export class Ghost {
  private readonly bot: SignallingBot;
  private timer: NodeJS.Timeout | undefined;

  constructor(player: Player, roster: Player[], connection: RpcConnection, private readonly room: GhostRoom) {
    const counter = new DeliveryCounter(room.stats, room.window, roster.length);
    this.bot = new SignallingBot({
      self: player.address,
      roster: roster.map((other) => other.address),
      namespace: room.namespace,
      profile: room.profile,
      store: rpcStatementStore(connection, player, room.stats, counter),
      stats: room.stats,
      counter,
    });
  }

  /** Calibrates the store clock now, as the waiting room does, and opens the room when it opens. */
  join(): void {
    void this.bot.calibrate();
    this.timer = setTimeout(() => this.bot.open(), roomOpensAt(this.room.phase, this.room.gameStart) - Date.now());
  }

  /** Closes the room; deliveries still count until `leave`. */
  stopSending(): void {
    clearTimeout(this.timer);
    this.bot.close();
  }

  leave(): void {
    this.bot.leave();
  }
}
