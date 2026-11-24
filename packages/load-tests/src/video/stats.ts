import { Histogram } from "../histogram.js";
import { addCounts } from "../stats.js";

/** What the video bots of one shard observed during one step; sums across shards like `SignallingStats`. */
export class VideoStats {
  /** Links the bots opened to their co-players, and those up until they closed, each side counted. */
  links = 0;
  linksUp = 0;
  /** Peer connections whose video renegotiation over the "data" channel completed. */
  linksWithVideo = 0;
  /** Room open (or the link's creation) to its "data" channel opening. */
  connectMs = new Histogram();
  /** Local candidate type of each connected link's selected pair: host, srflx, prflx or relay. */
  candidateTypes: Record<string, number> = {};
  /** Each connected link's path as the app counts it (`LinkPath`): direct, relay or unknown. */
  linkPaths: Record<string, number> = {};
  /** Candidates by type the bots gathered and their co-players sent them, over every link. */
  localCandidates: Record<string, number> = {};
  remoteCandidates: Record<string, number> = {};
  /** ICE candidate errors by code and text, such as 701 for a TURN server that didn't answer. */
  candidateErrors: Record<string, number> = {};
  /** Why a link's negotiation or connection failed, by step. */
  failures: Record<string, number> = {};

  /** Incoming streams a bot expected video on: a co-player of a round, both cameras on. */
  streams = 0;
  /** Of those, the ones on which at least one whole keyframe arrived. */
  streamsWithFrames = 0;
  /** Camera on to the first whole keyframe of the stream. */
  firstFrameMs = new Histogram();
  /** 24 per second of every stream's camera-on time inside the measurement window. */
  framesExpected = 0;
  /** Frames (marker bits) that arrived inside the window, and how many were keyframes. */
  framesReceived = 0;
  keyframesReceived = 0;
  /** Each stream's packets and missing sequence numbers from its first packet to its highest, window or not. */
  streamPackets = 0;
  packetsLost = 0;
  /** RTP packets and payload bytes received inside the window, and the camera-on time they cover. */
  packetsReceived = 0;
  bytesReceived = 0;
  activeMs = 0;

  framesSent = 0;
  /** Frames the camera skipped because its timer fell behind, as a busy encoder drops them. */
  framesSkipped = 0;
  pliSent = 0;
  pliReceived = 0;
  /** Keyframe requests that came over the "data" channel, as the app sends them. */
  keyframeRequestsReceived = 0;
  /** Requests served by jumping the camera to the clip's next IDR. */
  keyframesForced = 0;

  /** TURN credential fetches by outcome: `ok`, or the issuer's cause and HTTP status. */
  turnFetches: Record<string, number> = {};
  /** Issuer answer time of each fetch, proof excluded. */
  turnIssuerMs = new Histogram();
  /** Ring-VRF proof time of each fetch. */
  turnProofMs = new Histogram();
  /** Bots whose peer connections had TURN servers when the room opened. */
  botsWithTurn = 0;
  bots = 0;

  /** Adds the counts of `other`, a `VideoStats` or its JSON. */
  add(other: VideoStats): void {
    addCounts(this, other);
  }
}

/** A bot's ICE group: TURN with relay candidates only, TURN with every candidate, or STUN only. */
export type VideoGroup = "relayOnly" | "turnAndDirect" | "stunOnly";

/** The video counts of each `VideoGroup`, kept apart for the summary. */
export class VideoGroups {
  relayOnly = new VideoStats();
  turnAndDirect = new VideoStats();
  stunOnly = new VideoStats();

  /** Adds the counts of `other`, a `VideoGroups` or its JSON. */
  add(other: VideoGroups): void {
    this.relayOnly.add(other.relayOnly);
    this.turnAndDirect.add(other.turnAndDirect);
    this.stunOnly.add(other.stunOnly);
  }
}
