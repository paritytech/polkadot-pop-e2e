import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { RtcPayload } from "@jollity/statement-core";
import type { SignallingProfile } from "./profile.js";

/** How a bot's links reach the statement transport. */
export interface LinkWire {
  /** Sends a description or candidate to `peer` over the transport. */
  signal(peer: string, payload: RtcPayload): void;
  /** The link to `peer` came up, or went down. */
  onLinked(peer: string, linked: boolean): void;
}

/** A bot's links to its co-players: `VideoMesh`, or `StandInLinks` without video. */
export interface PeerLinks {
  open(peers: string[]): void;
  onSignal(from: string, payload: RtcPayload): void;
  /** Closes every link; resolves to how many were up until they closed. */
  close(): Promise<number>;
}

/** The app's mesh gathers candidates up to this long before a description goes out. */
const GATHER_MS = 750;

interface StandInLink {
  credentials: IceCredentials;
  sent: boolean;
  description: boolean;
  candidates: boolean;
  up: boolean;
}

/**
 * Links negotiated as the app's mesh negotiates them, with descriptions and candidates of Chrome's
 * size in place of a WebRTC connection's. A link is up once its description went out and the
 * co-player's description and candidates came in.
 */
export class StandInLinks implements PeerLinks {
  private readonly links = new Map<string, StandInLink>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly self: string,
    private readonly profile: SignallingProfile,
    private readonly wire: LinkWire,
  ) {}

  open(peers: string[]): void {
    for (const peer of peers) this.links.set(peer, { credentials: iceCredentials(), sent: false, description: false, candidates: false, up: false });
    // The lower id offers and the other answers, as the app's mesh decides.
    for (const peer of peers) if (this.self < peer) this.sendDescription(peer, "offer");
  }

  onSignal(from: string, { rtc }: RtcPayload): void {
    const link = this.links.get(from);
    if (!link) return;
    if (rtc.desc?.type === "offer") this.sendDescription(from, "answer", rtc.gen);
    if (rtc.desc) link.description = true;
    if (rtc.cand) link.candidates = true;
    this.update(from, link);
  }

  async close(): Promise<number> {
    this.timers.forEach((timer) => clearTimeout(timer));
    return [...this.links.values()].filter((link) => link.up).length;
  }

  /** The app's mesh sends a description once gathering is done, then trickles candidates. */
  private sendDescription(peer: string, type: "offer" | "answer", gen?: string): void {
    this.timers.push(
      setTimeout(() => {
        const link = this.links.get(peer)!;
        this.wire.signal(peer, { rtc: { desc: sessionDescription(type, link.credentials, this.profile.descriptionBytes), gen } });
        for (const cand of iceCandidates(link.credentials, this.profile.candidates)) this.wire.signal(peer, { rtc: { cand } });
        link.sent = true;
        this.update(peer, link);
      }, GATHER_MS),
    );
  }

  private update(peer: string, link: StandInLink): void {
    const up = link.sent && link.description && link.candidates;
    if (up === link.up) return;
    link.up = up;
    this.wire.onLinked(peer, up);
  }
}

const ICE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const iceToken = (length: number) => Array.from({ length }, () => ICE_CHARACTERS[randomInt(ICE_CHARACTERS.length)]).join("");
const publicAddress = () => `${randomInt(1, 224)}.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/** One side of a link's ICE credentials: its descriptions and candidates carry the same ufrag. */
export interface IceCredentials {
  ufrag: string;
  password: string;
}

export const iceCredentials = (): IceCredentials => ({ ufrag: iceToken(4), password: iceToken(24) });

/**
 * A data-channel-only description as Chrome writes it, of at least `bytes`: what is short of
 * them after the session lines is host candidates gathered before the description went out.
 */
export function sessionDescription(type: "offer" | "answer", credentials: IceCredentials, bytes: number): RTCSessionDescriptionInit {
  const fingerprint = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const head = [
    "v=0",
    `o=- ${randomBytes(8).readBigUInt64BE() >> 1n} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ];
  const tail = [
    `a=ice-ufrag:${credentials.ufrag}`,
    `a=ice-pwd:${credentials.password}`,
    "a=ice-options:trickle",
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${type === "offer" ? "actpass" : "active"}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];
  const lines = [...head, ...tail];
  const length = () => lines.reduce((sum, line) => sum + line.length + 2, 0);
  while (length() < bytes) {
    lines.splice(head.length, 0, `a=candidate:${randomInt(2 ** 32)} 1 udp 2122260223 ${randomUUID()}.local ${randomInt(1024, 65536)} typ host generation 0 network-id 1`);
  }
  return { type, sdp: `${lines.join("\r\n")}\r\n` };
}

/** `count` candidates gathered after the description went out, as Chrome trickles them: server
 *  reflexive and relayed ones, the mix a phone behind a NAT finds. */
export function iceCandidates(credentials: IceCredentials, count: number): RTCIceCandidateInit[] {
  return Array.from({ length: count }, (_, index) => {
    const relayed = index % 2 === 1;
    const kind = relayed ? `relay raddr ${publicAddress()} rport ${randomInt(1024, 65536)}` : `srflx raddr 0.0.0.0 rport 0`;
    return {
      candidate: `candidate:${randomInt(2 ** 32)} 1 udp ${relayed ? 41885439 : 1686052607} ${publicAddress()} ${randomInt(1024, 65536)} typ ${kind} generation 0 ufrag ${credentials.ufrag} network-id ${1 + (index % 3)} network-cost 10`,
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: credentials.ufrag,
    };
  });
}
