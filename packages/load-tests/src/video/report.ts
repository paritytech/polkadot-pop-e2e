import type { QuantileSummary } from "../histogram.js";
import { total } from "../stats.js";
import { VideoStats, type VideoGroups } from "./stats.js";

/** Below this share of the expected frames a step's video fails. */
const MIN_FRAME_SHARE = 0.95;
/** Above this share of camera frames skipped, the bots' machines, not the network, may be the limit. */
const MAX_SKIPPED_SHARE = 0.01;

export interface VideoSummary {
  bots: number;
  botsWithTurn: number;
  /** The step's links and those up when the game ended, as the signalling table counts them. */
  links: number;
  linksUp: number;
  linksWithVideo: number;
  connectMs: QuantileSummary;
  candidateTypes: Record<string, number>;
  linkPaths: Record<string, number>;
  localCandidates: Record<string, number>;
  remoteCandidates: Record<string, number>;
  candidateErrors: Record<string, number>;
  streams: number;
  streamsWithFrames: number;
  firstFrameMs: QuantileSummary;
  framesExpected: number;
  framesReceived: number;
  frameShare: number;
  loss: number;
  /** Average received bitrate of a stream while its camera was on. */
  kbpsPerStream: number;
  pliSent: number;
  pliReceived: number;
  keyframesForced: number;
  skippedShare: number;
  failures: Record<string, number>;
  turnFetches: Record<string, number>;
  turnIssuerMs: QuantileSummary;
  turnProofMs: QuantileSummary;
}

/**
 * A step's video over every bot, and over each side of two splits: bots with TURN and with STUN
 * only, and relay-only bots and free ones, which may connect directly.
 */
export interface VideoGroupSummaries {
  all: VideoSummary;
  withTurn: VideoSummary;
  withoutTurn: VideoSummary;
  relayOnly: VideoSummary;
  free: VideoSummary;
}

export function summarizeVideoGroups(groups: VideoGroups): VideoGroupSummaries {
  const merged = (...parts: VideoStats[]) => {
    const stats = new VideoStats();
    for (const part of parts) stats.add(part);
    return summarizeVideo(stats);
  };
  return {
    all: merged(groups.relayOnly, groups.turnAndDirect, groups.stunOnly),
    withTurn: merged(groups.relayOnly, groups.turnAndDirect),
    withoutTurn: summarizeVideo(groups.stunOnly),
    relayOnly: summarizeVideo(groups.relayOnly),
    free: merged(groups.turnAndDirect, groups.stunOnly),
  };
}

function summarizeVideo(stats: VideoStats): VideoSummary {
  const lossBase = stats.streamPackets + stats.packetsLost;
  return {
    bots: stats.bots,
    botsWithTurn: stats.botsWithTurn,
    links: stats.links,
    linksUp: stats.linksUp,
    linksWithVideo: stats.linksWithVideo,
    connectMs: stats.connectMs.summary(),
    candidateTypes: stats.candidateTypes,
    linkPaths: stats.linkPaths,
    localCandidates: stats.localCandidates,
    remoteCandidates: stats.remoteCandidates,
    candidateErrors: stats.candidateErrors,
    streams: stats.streams,
    streamsWithFrames: stats.streamsWithFrames,
    firstFrameMs: stats.firstFrameMs.summary(),
    framesExpected: stats.framesExpected,
    framesReceived: stats.framesReceived,
    frameShare: stats.framesExpected > 0 ? stats.framesReceived / stats.framesExpected : 0,
    loss: lossBase > 0 ? stats.packetsLost / lossBase : 0,
    kbpsPerStream: stats.activeMs > 0 ? (stats.bytesReceived * 8) / stats.activeMs : 0,
    pliSent: stats.pliSent,
    pliReceived: stats.pliReceived,
    keyframesForced: stats.keyframesForced,
    skippedShare: stats.framesSent > 0 ? stats.framesSkipped / (stats.framesSent + stats.framesSkipped) : 0,
    failures: stats.failures,
    turnFetches: stats.turnFetches,
    turnIssuerMs: stats.turnIssuerMs.summary(),
    turnProofMs: stats.turnProofMs.summary(),
  };
}

/** What in a step's video points at a problem, and whether it points at the bots' machines. */
export function videoFindings(video: VideoSummary): { findings: string[]; clientBound: boolean } {
  const findings: string[] = [];
  // Links that never came up are the signalling table's finding.
  if (video.linksWithVideo < video.linksUp) findings.push(`video: ${video.linksUp - video.linksWithVideo} of ${video.linksUp} links up never negotiated video`);
  if (video.streamsWithFrames < video.streams) findings.push(`video: ${video.streams - video.streamsWithFrames} of ${video.streams} streams showed no frame`);
  if (video.frameShare < MIN_FRAME_SHARE) findings.push(`video: ${(video.frameShare * 100).toFixed(1)}% of the expected frames arrived`);
  if (total(video.failures) > 0) findings.push(`video: ${JSON.stringify(video.failures)}`);
  if (total(video.candidateErrors) > 0) findings.push(`ICE: candidate errors ${JSON.stringify(video.candidateErrors)}`);
  const turnFailures = total(video.turnFetches) - (video.turnFetches.ok ?? 0);
  if (turnFailures > 0) findings.push(`TURN: ${turnFailures} of ${total(video.turnFetches)} credential requests failed ${JSON.stringify(video.turnFetches)}`);
  const clientBound = video.skippedShare > MAX_SKIPPED_SHARE;
  if (clientBound) findings.push(`client: cameras skipped ${(video.skippedShare * 100).toFixed(1)}% of frames, add machines`);
  return { findings, clientBound };
}

/** The video table of a layer's steps: a row of every bot, then one per side of each split the step had both sides of. */
export function videoMarkdown(target: string, steps: Array<{ players: number; video: VideoGroupSummaries }>): string {
  const ms = (summary: QuantileSummary) => `${summary.p50 ?? "–"} / ${summary.p95 ?? "–"}`;
  const counts = (record: Record<string, number>) =>
    Object.entries(record)
      .map(([key, count]) => `${key} ${count}`)
      .join(", ") || "–";
  const header = [
    "Players",
    "Bots",
    "Links up / attempted",
    "With video",
    "Connect p50 / p95 ms",
    "Candidate types",
    "Direct / relay links",
    "Candidate errors",
    "Candidates gathered / received",
    "First frame p50 / p95 ms",
    "Frames received / expected",
    "Loss",
    "kbps per stream",
    "PLI sent / received, IDRs forced",
    "TURN (bots with servers, requests)",
    "Issuer p50 / p95 ms",
  ];
  const row = (players: number, label: string, video: VideoSummary) =>
    [
      players,
      `${label} ${video.bots}`,
      `${video.linksUp} / ${video.links}`,
      video.linksWithVideo,
      ms(video.connectMs),
      counts(video.candidateTypes),
      `${video.linkPaths.direct ?? 0} / ${video.linkPaths.relay ?? 0}${video.linkPaths.unknown ? `, unknown ${video.linkPaths.unknown}` : ""}`,
      counts(video.candidateErrors),
      `${counts(video.localCandidates)} / ${counts(video.remoteCandidates)}`,
      ms(video.firstFrameMs),
      `${video.framesReceived} / ${video.framesExpected} (${(video.frameShare * 100).toFixed(1)}%)`,
      `${(video.loss * 100).toFixed(2)}%`,
      video.kbpsPerStream.toFixed(0),
      `${video.pliSent} / ${video.pliReceived}, ${video.keyframesForced}`,
      `${video.botsWithTurn} of ${video.bots}; ${counts(video.turnFetches)}`,
      ms(video.turnIssuerMs),
    ].join(" | ");
  const split = (players: number, sides: Array<[string, VideoSummary]>) =>
    sides.every(([, video]) => video.bots > 0) ? sides.map(([label, video]) => row(players, label, video)) : [];
  const rows = steps.flatMap(({ players, video }) => [
    row(players, "all", video.all),
    ...split(players, [
      ["with TURN", video.withTurn],
      ["without TURN", video.withoutTurn],
    ]),
    ...split(players, [
      ["relay-only", video.relayOnly],
      ["free", video.free],
    ]),
  ]);
  return [`### Video on ${target}`, "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((cells) => `| ${cells} |`), ""].join("\n");
}
