import {
  calibrateStoreClock,
  calibrationLabels,
  createStoreClock,
  isRtcPayload,
  statementTransport,
  toHex,
  type SignalTransport,
  type StatementStoreLike,
} from "@jollity/statement-core";
import { AccountId } from "@polkadot-api/substrate-bindings";
import { communicationIdentifier, communicationSecret } from "./keys.js";
import { measuredStore, type MeasurableStore, type MeasuredStore } from "./measured-store.js";
import type { SignallingProfile } from "./profile.js";
import { iceCandidates, iceCredentials, sessionDescription, type IceCredentials } from "./sdp.js";
import { DeliveryCounter, SignallingStats, bump } from "./stats.js";

/** The room's key: one room for the whole game, as the app opens it. */
const ROOM = "game";
/** The app's mesh gathers candidates up to this long before a description goes out. */
const GATHER_MS = 750;

const accountId = AccountId();

export interface BotOptions {
  /** The player's account, which is its id on the wire, and the co-players its room links to. */
  self: string;
  roster: string[];
  namespace: string;
  profile: SignallingProfile;
  store: MeasurableStore;
  stats: SignallingStats;
  /** The measurement window: statements stamped in it count toward delivery. */
  window: { start: number; end: number };
}

interface Link {
  credentials: IceCredentials;
  sent: boolean;
  description: boolean;
  candidates: boolean;
  up: boolean;
}

/**
 * One player's signalling over a game as the Jollity app runs it: the app's statement transport,
 * configured as the app's game source configures it, driven as the app's mesh drives it for a
 * room of every co-player of every round, with descriptions and candidates of Chrome's size in
 * place of a WebRTC connection's.
 */
export class SignallingBot {
  private readonly clock = createStoreClock({ base: () => ({ ms: Date.now(), kind: "device" }) });
  private readonly measured: MeasuredStore;
  private readonly counter: DeliveryCounter;
  private readonly links = new Map<string, Link>();
  private transport: SignalTransport | undefined;

  constructor(private readonly options: BotOptions) {
    // Every co-player listens on the player's topic, so each statement is due to each of them.
    this.counter = new DeliveryCounter(options.stats, options.window, options.roster.length, options.self);
    this.measured = measuredStore(options.store, options.stats, this.counter);
  }

  /** The waiting room's store clock calibration: one statement on the player's own channel. */
  async calibrate(): Promise<void> {
    const { store, namespace, self, stats } = this.options;
    // Unmeasured: the calibration statement is on a channel no co-player listens on.
    const unmeasured: StatementStoreLike = { ...store, subscribe: (filter, onPage) => store.subscribe(filter, onPage, { opened() {}, ended() {}, failed() {} }) };
    const { outcome } = await calibrateStoreClock({ store: unmeasured, clock: this.clock, labels: calibrationLabels(namespace, self, "jollity:rtc-v2") });
    bump(stats.calibrations, outcome);
  }

  /** Opens the room: from now on the transport signals, and its heartbeat re-sends. */
  open(): void {
    const { self, roster, namespace, profile, stats } = this.options;
    const signalling = statementTransport({
      resolveStore: async () => this.measured,
      storeClock: this.clock,
      namespace,
      signerOf: (peer) => {
        try {
          return toHex(accountId.enc(peer));
        } catch {
          return null;
        }
      },
      labelPrefix: "jollity:rtc-v5",
      bundle: true,
      deflateBundles: true,
      keys: {
        secret: async () => communicationSecret(accountId.enc(self)),
        peerIdentifier: async (peer) => communicationIdentifier(accountId.enc(peer)),
      },
      onSubmit: (event) => bump(stats.submitEvents, event.kind),
      log: (message) => {
        if (!/store live|subscribed/.test(message)) console.warn(`[${self}] ${message}`);
      },
    });
    const update = (peer: string, link: Link) => {
      const up = link.sent && link.description && link.candidates;
      if (up === link.up) return;
      link.up = up;
      this.transport?.setLinked?.(peer, up);
    };
    // The app's mesh sends a description once gathering is done, then trickles candidates.
    const sendDescription = (peer: string, type: "offer" | "answer", gen?: string) =>
      setTimeout(() => {
        const link = this.links.get(peer)!;
        this.transport?.send(peer, { rtc: { desc: sessionDescription(type, link.credentials, profile.descriptionBytes), gen } });
        for (const cand of iceCandidates(link.credentials, profile.candidates)) this.transport?.send(peer, { rtc: { cand } });
        link.sent = true;
        update(peer, link);
      }, GATHER_MS);
    for (const peer of roster) this.links.set(peer, { credentials: iceCredentials(), sent: false, description: false, candidates: false, up: false });
    stats.links += roster.length;
    this.transport = signalling({
      base: "",
      room: ROOM,
      id: self,
      name: self,
      peers: roster,
      handlers: {
        onPeerJoined: () => {},
        onPeerLeft: () => {},
        onSignal: (from, data) => {
          const link = this.links.get(from);
          if (!link || !isRtcPayload(data)) return;
          const { desc, cand, gen } = data.rtc;
          if (desc?.type === "offer") sendDescription(from, "answer", gen);
          if (desc) link.description = true;
          if (cand) link.candidates = true;
          update(from, link);
        },
      },
    });
    // The lower id offers and the other answers, as the app's mesh decides.
    for (const peer of roster) if (self < peer) sendDescription(peer, "offer");
  }

  /** Closes the room: the transport sends bye and stops sending. */
  close(): void {
    for (const link of this.links.values()) if (link.up) this.options.stats.linksUp++;
    this.transport?.close();
  }

  /** Stops counting deliveries, which arrive until then. */
  leave(): void {
    this.measured.close();
    this.counter.finish();
  }
}
