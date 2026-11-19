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
import { createCountingStore, type CountingStore, type MeasurableStore } from "./measured-store.js";
import type { SignallingProfile } from "./profile.js";
import { StandInLinks, type LinkWire, type PeerLinks } from "./sdp.js";
import { DeliveryCounter, SignallingStats, bump } from "./stats.js";
import { VideoMesh, type BotVideo } from "./video/mesh.js";

/** The room's key out of a game: one room for the whole run. */
const ROOM = "game";

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
  /** Real peer connections with video in place of descriptions of Chrome's size. */
  video?: BotVideo;
  /** The player's registered communication secret; a bot's derives from its account. */
  secret?: Uint8Array;
  /** A game on the app's own topics, which real players use too. */
  game?: AppGame;
}

export interface AppGame {
  /** The app's room key, `g<game index>`. */
  room: string;
  /** Co-players' communication identifiers as registered on chain; a bot's derives from its account. */
  identifiers: ReadonlyMap<string, Uint8Array>;
  /** The run's bots: deliveries count between them alone. */
  bots: ReadonlySet<string>;
}

/**
 * One player's signalling over a game as the Jollity app runs it: the app's statement transport,
 * configured as the app's game source configures it, driven as the app's mesh drives it for a
 * room of every co-player of every round. Without `video`, descriptions and candidates of
 * Chrome's size stand in for a WebRTC connection's; with it, a `VideoMesh` negotiates real ones.
 */
export class SignallingBot {
  private readonly clock = createStoreClock({ base: () => ({ ms: Date.now(), kind: "device" }) });
  private readonly countingStore: CountingStore;
  private readonly counter: DeliveryCounter;
  private transport: SignalTransport | undefined;
  private links: PeerLinks | undefined;

  constructor(private readonly options: BotOptions) {
    const { roster, game } = options;
    // Every bot co-player listens on the player's topic, so each statement is due to each of them.
    const recipients = game ? roster.filter((peer) => game.bots.has(peer)).length : roster.length;
    this.counter = new DeliveryCounter(options.stats, options.window, recipients, options.self);
    const botSigners = game && new Set([...game.bots].map((bot) => toHex(accountId.enc(bot)).toLowerCase()));
    const measured = botSigners && ((signer: string | undefined) => signer === undefined || botSigners.has(signer.toLowerCase()));
    this.countingStore = createCountingStore(options.store, options.stats, this.counter, measured);
  }

  /** The waiting room's store clock calibration: one statement on the player's own channel. */
  async calibrate(): Promise<void> {
    const { store, namespace, self, stats } = this.options;
    // Not counted: the calibration statement is on a channel no co-player listens on.
    const calibrationStore: StatementStoreLike = { ...store, subscribe: (filter, onPage) => store.subscribe(filter, onPage, { opened() {}, ended() {}, failed() {} }) };
    const { outcome } = await calibrateStoreClock({ store: calibrationStore, clock: this.clock, labels: calibrationLabels(namespace, self, "jollity:rtc-v2") });
    bump(stats.calibrations, outcome);
  }

  /** Opens the room: from now on the transport signals, and its heartbeat re-sends. */
  open(): void {
    const { self, roster, namespace, profile, stats, video } = this.options;
    const signalling = statementTransport({
      resolveStore: async () => this.countingStore,
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
        secret: async () => this.options.secret ?? communicationSecret(accountId.enc(self)),
        peerIdentifier: async (peer) => this.options.game?.identifiers.get(peer) ?? communicationIdentifier(accountId.enc(peer)),
      },
      onSubmit: (event) => bump(stats.submitEvents, event.kind),
      log: (message) => {
        if (!/store live|subscribed/.test(message)) console.warn(`[${self}] ${message}`);
      },
    });
    stats.links += roster.length;
    const wire: LinkWire = {
      signal: (peer, payload) => this.transport?.send(peer, payload),
      onLinked: (peer, linked) => this.transport?.setLinked?.(peer, linked),
    };
    const links = video ? new VideoMesh({ ...video, ...wire, self, window: this.options.window }) : new StandInLinks(self, profile, wire);
    this.links = links;
    this.transport = signalling({
      base: "",
      room: this.options.game?.room ?? ROOM,
      id: self,
      name: self,
      peers: roster,
      handlers: {
        onPeerJoined: () => {},
        onPeerLeft: () => {},
        onSignal: (from, data) => {
          if (isRtcPayload(data)) links.onSignal(from, data);
        },
      },
    });
    links.open(roster);
  }

  /** Closes the room: the peer connections close, and the transport sends bye and stops sending. */
  async close(): Promise<void> {
    if (this.links) {
      const linksUp = await this.links.close();
      this.options.stats.linksUp += linksUp;
    }
    this.transport?.close();
  }

  /** Stops counting deliveries, which arrive until then. */
  leave(): void {
    this.countingStore.close();
    this.counter.finish();
  }
}
