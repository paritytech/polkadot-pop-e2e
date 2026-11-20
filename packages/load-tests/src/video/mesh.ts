import {
  decodeChannelMessage,
  decodePeerConnectionSignal,
  encodeChannelMessage,
  encodePeerConnectionSignal,
  USE_CASE_RENEGOTIATION,
  type PeerConnectionSignalValue,
  type RtcPayload,
} from "@jollity/statement-core";
import { RTCPeerConnection, type RTCDataChannel, type RTCRtpTransceiver } from "werift";
import type { LinkWire, PeerLinks } from "../sdp.js";
import { bump } from "../stats.js";
import { sleep } from "../time.js";
import { Camera } from "./camera.js";
import type { Clip } from "./clip.js";
import { peerConfig, type IceSetup } from "./ice.js";
import { ReceiveStream } from "./receive.js";
import type { VideoStats } from "./stats.js";

/** The app's keyframe request frame on the "data" channel (jollity-app `lib/webrtc/keyframe-frame.ts`). */
const USE_CASE_KEYFRAME_REQUEST = "jollity_keyframe_request_use_case";
const PLI_CHECK_MS = 250;

/** The co-players at a bot's table in one round, and when the camera turns to them. */
export interface VideoRound {
  activeFrom: number;
  group: string[];
}

/** A bot's video: its rounds' groups, its camera's clip, its ICE servers, and the counts it adds to. */
export interface BotVideo {
  /** In order; the first round's group gets the camera from the room's opening. */
  rounds: VideoRound[];
  clip: Clip;
  ice: IceSetup;
  stats: VideoStats;
}

export interface VideoMeshOptions extends BotVideo, LinkWire {
  self: string;
  window: { start: number; end: number };
}

interface Link {
  peer: string;
  pc: RTCPeerConnection;
  /** The lower id offers, on the statement transport and then on the lane, as the app's mesh decides. */
  initiator: boolean;
  createTime: number;
  channel?: RTCDataChannel;
  transceiver?: RTCRtpTransceiver;
  receive: ReceiveStream;
  standby: boolean;
  descriptionSent: boolean;
  /** The co-player's description over the statement transport, from when it starts to apply. */
  remoteSdp?: string;
  /** The co-player's offers, answered one at a time. */
  answering: Promise<void>;
  /** The co-player's video SSRC, which a PLI addresses. */
  remoteSsrc?: number;
  pendingCandidates: RTCIceCandidateInit[];
  up: boolean;
  /** Candidates by type this side gathered and the co-player sent, in descriptions and trickled. */
  localCandidates: Record<string, number>;
  remoteCandidates: Record<string, number>;
}

/** The `o=` line's session id: one per peer connection, kept through its renegotiations and ICE restarts. */
const sessionOf = (sdp: string) => /^o=\S+ (\S+)/m.exec(sdp)?.[1];

/** Once `pc` has no negotiation under way, or after `ms`. */
async function waitForStable(pc: RTCPeerConnection, ms: number): Promise<void> {
  for (const until = Date.now() + ms; pc.signalingState !== "stable" && Date.now() < until; ) await sleep(100);
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 80);

function countCandidate(counts: Record<string, number>, candidate: string | undefined): void {
  const type = / typ (\w+)/.exec(candidate ?? "")?.[1];
  if (type) bump(counts, type);
}

function countSdpCandidates(counts: Record<string, number>, sdp: string): void {
  for (const line of sdp.split("\r\n")) if (line.startsWith("a=candidate:")) countCandidate(counts, line);
}

const describeCandidates = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([type, count]) => `${type} ${count}`)
    .join(" ") || "none";

/**
 * One bot's peer connections, set up as the app's mesh (jollity-app `lib/webrtc/mesh.ts`) sets
 * them up: a data-channel-only offer and answer over the statement transport, then the video
 * negotiated over the "data" channel's renegotiation lane. The camera goes to the current
 * round's group; links to a later round's co-players stay on standby (`replaceTrack(null)`), and
 * links with no round left close when the next round's group takes the camera.
 */
export class VideoMesh implements PeerLinks {
  private readonly links = new Map<string, Link>();
  private readonly camera: Camera;
  private readonly timers: NodeJS.Timeout[] = [];
  private linksUp = 0;
  private closed = false;

  constructor(private readonly options: VideoMeshOptions) {
    this.camera = new Camera(options.clip, options.stats);
  }

  /** Links to every co-player of every round, as the app does during the pre-game countdown. */
  open(peers: string[]): void {
    const { rounds, stats, self } = this.options;
    stats.bots++;
    if (this.options.ice.turn.length > 0) stats.botsWithTurn++;
    this.camera.start();
    const now = Date.now();
    for (const peer of peers) this.createLink(peer, !rounds[0]?.group.includes(peer), self < peer, now);
    for (const round of rounds.slice(1)) this.timers.push(setTimeout(() => this.startRound(round), Math.max(0, round.activeFrom - Date.now())));
    this.timers.push(setInterval(() => this.links.forEach((link) => link.receive.check(Date.now())), PLI_CHECK_MS));
  }

  /** A description or candidate from `from` over the statement transport. */
  onSignal(from: string, { rtc }: RtcPayload): void {
    let link = this.links.get(from);
    if (!link) return;
    const { desc, cand, gen } = rtc;
    if (desc?.type === "offer" && desc.sdp) {
      // An offer from another connection of the co-player's (it rebuilt its link or reloaded):
      // this one is done, and a fresh one takes the offer, as the app's mesh rebuilds.
      if (link.remoteSdp !== undefined && sessionOf(link.remoteSdp) !== sessionOf(desc.sdp)) link = this.replaceLink(link);
      const answered = link;
      answered.answering = answered.answering.then(() => this.answer(answered, desc.sdp!, gen));
    } else if (desc?.type === "answer" && desc.sdp) void this.applyAnswer(link, desc.sdp);
    if (cand) {
      countCandidate(link.remoteCandidates, cand.candidate);
      void this.addCandidate(link, cand);
    }
  }

  /** Closes every link and stops the camera; returns the links that were up until they closed. */
  async close(): Promise<number> {
    this.closed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.camera.stop();
    await Promise.all([...this.links.values()].map((link) => this.closeLink(link, "end")));
    return this.linksUp;
  }

  /** A link to `peer`; with `offers`, it opens the data channel and makes the first offer. */
  private createLink(peer: string, standby: boolean, initiator: boolean, now: number, offers = initiator): Link {
    const { stats, window } = this.options;
    const pc = new RTCPeerConnection(peerConfig(this.options.ice));
    const link: Link = {
      peer,
      pc,
      initiator,
      createTime: now,
      receive: new ReceiveStream(stats, window, () => this.sendPli(link)),
      standby,
      descriptionSent: false,
      answering: Promise.resolve(),
      pendingCandidates: [],
      up: false,
      localCandidates: {},
      remoteCandidates: {},
    };
    this.links.set(peer, link);
    if (!standby) link.receive.activate(now);
    pc.onIceCandidate.subscribe((candidate) => {
      // Candidates gathered before the description went out are in its SDP.
      if (!candidate || !link.descriptionSent || this.closed) return;
      countCandidate(link.localCandidates, candidate.candidate);
      if (link.channel?.readyState === "open") {
        this.sendLane(link, { tag: "IceCandidates", value: [{ sdp: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0, sdpMid: candidate.sdpMid }] });
      } else this.options.signal(peer, { rtc: { cand: candidate.toJSON() } });
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed") bump(stats.failures, `connection failed: local ${describeCandidates(link.localCandidates)}, remote ${describeCandidates(link.remoteCandidates)}`);
    });
    // 701: a STUN or TURN server that didn't answer; 401 or 403 from a TURN server that rejected the credentials.
    pc.onIceCandidateError.subscribe((event) => bump(stats.candidateErrors, `${event.errorCode} ${event.errorText ?? ""}`.trim()));
    pc.onDataChannel.subscribe((channel) => this.attachChannel(link, channel));
    // Where the app's answerer adds its track before the lane offer arrives, this one takes the
    // offer's transceiver, during setRemoteDescription so its track's first packets are counted.
    // The answer carries the same sendrecv video either way.
    pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
      transceiver.setDirection("sendrecv");
      this.watchVideo(link, transceiver);
    });
    if (offers) {
      // The channel exists before the offer, so the offer's only m-line is the application one.
      this.attachChannel(link, pc.createDataChannel("data"));
      void this.offer(link);
    }
    return link;
  }

  /** A fresh connection to `link`'s co-player in place of `link`'s, which closes; it waits for the co-player's offer. */
  private replaceLink(link: Link): Link {
    void this.closeLink(link, "rebuild");
    return this.createLink(link.peer, link.standby, link.initiator, Date.now(), false);
  }

  private async offer(link: Link): Promise<void> {
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      if (this.closed) return;
      this.options.signal(link.peer, { rtc: { desc: { type: "offer", sdp: link.pc.localDescription!.sdp } } });
      link.descriptionSent = true;
      countSdpCandidates(link.localCandidates, link.pc.localDescription!.sdp);
    } catch (error) {
      bump(this.options.stats.failures, `offer: ${describe(error)}`);
    }
  }

  /**
   * Answers the co-player's offer `sdp` as the app's mesh answers one: a re-send changes nothing,
   * and a renegotiation or ICE restart on the same connection is answered on it. An offer that
   * meets one of this side's own is ignored by the initiator, the app's impolite side; the other
   * side waits for its own negotiation to end first.
   */
  private async answer(link: Link, sdp: string, gen: string | undefined): Promise<void> {
    // The transport delivers an offer again with every re-send until the link is up.
    if (this.closed || this.links.get(link.peer) !== link || link.remoteSdp === sdp) return;
    if (link.pc.signalingState !== "stable") {
      if (link.initiator) {
        bump(this.options.stats.failures, "offer ignored in glare");
        return;
      }
      await waitForStable(link.pc, 5_000);
    }
    link.remoteSdp = sdp;
    countSdpCandidates(link.remoteCandidates, sdp);
    try {
      await link.pc.setRemoteDescription({ type: "offer", sdp });
      await this.flushCandidates(link);
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      if (this.closed) return;
      this.options.signal(link.peer, { rtc: { desc: { type: "answer", sdp: link.pc.localDescription!.sdp }, gen } });
      link.descriptionSent = true;
      countSdpCandidates(link.localCandidates, link.pc.localDescription!.sdp);
    } catch (error) {
      bump(this.options.stats.failures, `answer: ${describe(error)}`);
    }
  }

  private async applyAnswer(link: Link, sdp: string): Promise<void> {
    if (!link.initiator || link.remoteSdp !== undefined || link.pc.signalingState !== "have-local-offer") return;
    link.remoteSdp = sdp;
    countSdpCandidates(link.remoteCandidates, sdp);
    try {
      await link.pc.setRemoteDescription({ type: "answer", sdp });
      await this.flushCandidates(link);
    } catch (error) {
      bump(this.options.stats.failures, `apply answer: ${describe(error)}`);
    }
  }

  private async addCandidate(link: Link, candidate: RTCIceCandidateInit): Promise<void> {
    if (!link.pc.remoteDescription) {
      link.pendingCandidates.push(candidate);
      return;
    }
    await link.pc.addIceCandidate(candidate).catch((error) => bump(this.options.stats.failures, `candidate: ${describe(error)}`));
  }

  private async flushCandidates(link: Link): Promise<void> {
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) await this.addCandidate(link, candidate);
  }

  private attachChannel(link: Link, channel: RTCDataChannel): void {
    if (link.channel && link.channel !== channel) return;
    link.channel = channel;
    channel.onMessage.subscribe((data) => {
      if (typeof data !== "string") this.onFrame(link, data);
    });
    if (channel.readyState === "open") this.onChannelOpen(link);
    else channel.stateChanged.subscribe((state) => state === "open" && this.onChannelOpen(link));
  }

  private onChannelOpen(link: Link): void {
    if (link.up || this.closed) return;
    const { stats, onLinked } = this.options;
    link.up = true;
    stats.connectMs.add(Date.now() - link.createTime);
    bump(stats.candidateTypes, link.pc.iceTransports[0]?.getSelectedCandidatePair()?.local.type ?? "unknown");
    onLinked(link.peer, true);
    // Media starts once the channel is open, and only the initiator offers it down the lane.
    if (link.initiator) void this.offerVideo(link);
  }

  private async offerVideo(link: Link): Promise<void> {
    try {
      const transceiver = link.pc.addTransceiver(link.standby ? "video" : this.camera.track, { direction: "sendrecv" });
      this.watchVideo(link, transceiver);
      await link.pc.setLocalDescription(await link.pc.createOffer());
      this.sendLane(link, { tag: "Offer", value: link.pc.localDescription!.sdp });
    } catch (error) {
      bump(this.options.stats.failures, `video offer: ${describe(error)}`);
    }
  }

  private onFrame(link: Link, data: Buffer): void {
    let frame: { id: string; data: Uint8Array };
    try {
      // scale-ts reads a view's backing buffer from offset 0: a Buffer from werift's pool decodes wrong.
      frame = decodeChannelMessage(new Uint8Array(data));
    } catch {
      return;
    }
    if (frame.id === USE_CASE_KEYFRAME_REQUEST) {
      this.options.stats.keyframeRequestsReceived++;
      this.camera.requestKeyframe();
    } else if (frame.id === USE_CASE_RENEGOTIATION) void this.onLane(link, decodePeerConnectionSignal(frame.data));
  }

  private async onLane(link: Link, signal: PeerConnectionSignalValue): Promise<void> {
    const { pc } = link;
    try {
      if (signal.tag === "Offer") {
        await pc.setRemoteDescription({ type: "offer", sdp: signal.value });
        await link.transceiver?.sender.replaceTrack(link.standby ? null : this.camera.track);
        await pc.setLocalDescription(await pc.createAnswer());
        this.sendLane(link, { tag: "Answer", value: pc.localDescription!.sdp });
        this.recordVideoNegotiation(link);
      } else if (signal.tag === "Answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.value });
        this.recordVideoNegotiation(link);
      } else {
        for (const candidate of signal.value) {
          countCandidate(link.remoteCandidates, candidate.sdp);
          await pc.addIceCandidate({ candidate: candidate.sdp, sdpMLineIndex: candidate.sdpMLineIndex, sdpMid: candidate.sdpMid });
        }
      }
    } catch (error) {
      bump(this.options.stats.failures, `lane ${signal.tag}: ${describe(error)}`);
    }
  }

  private recordVideoNegotiation(link: Link): void {
    this.options.stats.linksWithVideo++;
    link.receive.markNegotiated(Date.now());
  }

  private watchVideo(link: Link, transceiver: RTCRtpTransceiver): void {
    link.transceiver = transceiver;
    const { stats } = this.options;
    transceiver.sender.onPictureLossIndication.subscribe(() => {
      stats.pliReceived++;
      this.camera.requestKeyframe();
    });
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        link.remoteSsrc = rtp.header.ssrc;
        link.receive.record(rtp.header.sequenceNumber, rtp.header.marker, rtp.payload, Date.now());
      });
    });
  }

  private sendPli(link: Link): void {
    if (link.remoteSsrc !== undefined) link.transceiver?.receiver.sendRtcpPLI(link.remoteSsrc).catch(() => {});
  }

  private sendLane(link: Link, signal: PeerConnectionSignalValue): void {
    if (link.channel?.readyState !== "open") return;
    link.channel.send(Buffer.from(encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal(signal) })));
  }

  /** The next round's group gets the camera: standby ends for it, and links with no round left close. */
  private startRound(round: VideoRound): void {
    if (this.closed) return;
    const now = Date.now();
    const later = this.options.rounds.filter((next) => next.activeFrom > round.activeFrom).flatMap((next) => next.group);
    for (const link of [...this.links.values()]) {
      const active = round.group.includes(link.peer);
      if (!active && !later.includes(link.peer)) {
        void this.closeLink(link, "round");
        continue;
      }
      if (active === !link.standby) continue;
      link.standby = !active;
      if (active) link.receive.activate(now);
      else link.receive.deactivate(now);
      link.transceiver?.sender.replaceTrack(active ? this.camera.track : null).catch((error) => bump(this.options.stats.failures, `standby: ${describe(error)}`));
    }
  }

  /**
   * Closes `link`, at the end of play, at a round switch, or for a fresh connection to the same
   * co-player. A round switch closes the peer connection alone, as the app's `dropPeer` does, and
   * leaves the transport's linked flag set; so does a rebuild, whose fresh link counts on its own.
   */
  private async closeLink(link: Link, when: "end" | "round" | "rebuild"): Promise<void> {
    if (this.links.get(link.peer) !== link) return;
    this.links.delete(link.peer);
    link.receive.finish(Date.now());
    const { stats } = this.options;
    for (const [type, count] of Object.entries(link.localCandidates)) bump(stats.localCandidates, type, count);
    for (const [type, count] of Object.entries(link.remoteCandidates)) bump(stats.remoteCandidates, type, count);
    // TURN servers that gave this link no relay candidate, such as with the server's relay ports all
    // allocated (508); counted from the candidates, since onIceCandidateError doesn't always fire.
    const turnUrls = this.options.ice.turn.filter((server) => /^turns?:/.test(String(server.urls))).length;
    // A link that never sent its description gathered no candidates at all.
    const relaysMissing = link.descriptionSent ? turnUrls - (link.localCandidates.relay ?? 0) : 0;
    if (relaysMissing > 0) bump(stats.candidateErrors, "TURN server without a relay candidate", relaysMissing);
    if (link.up && when !== "rebuild") {
      // A co-player with no round left closes its side at the same moment, so a link closed by
      // the round switch may already read closed here: only a failed connection counts as down.
      if (link.pc.connectionState !== "failed") this.linksUp++;
      if (when === "end") this.options.onLinked(link.peer, false);
    }
    await link.pc.close().catch(() => {});
  }
}
