import type { TurnServer } from "@jollity/protocol";
import {
  RTCRtpCodecParameters,
  useAbsSendTime,
  useNACK,
  usePLI,
  useREMB,
  useSdesMid,
  useTransportWideCC,
  useTWCC,
  type PeerConfig,
} from "werift";
import { H264_FMTP } from "./clip.js";

/** The app's STUN list (jollity-app `lib/webrtc/ice.ts`), present with or without TURN. */
export const APP_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:19302",
  "stun:stun4.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/** How a bot's peer connections reach their co-players. */
export interface IceSetup {
  stunUrls: string[];
  /** The issuer's TURN servers with this bot's credentials; none without a pass. */
  turn: TurnServer[];
  /** Only relay candidates, as the app does on a network where only TURN works. */
  relay: boolean;
  /** Gather host candidates on this address alone, such as 127.0.0.1 for bots on one machine. */
  interfaceAddress?: string;
}

/** A peer connection configured as the app's: H.264 Constrained Baseline video only, NACK, PLI and TWCC. */
export function peerConfig(ice: IceSetup): Partial<PeerConfig> {
  return {
    codecs: {
      audio: [],
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90_000,
          payloadType: 96,
          rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
          parameters: H264_FMTP,
        }),
      ],
    },
    headerExtensions: { audio: [], video: [useSdesMid(), useAbsSendTime(), useTransportWideCC()] },
    iceServers: [...(ice.stunUrls.length > 0 ? [{ urls: ice.stunUrls }] : []), ...ice.turn],
    iceTransportPolicy: ice.relay ? "relay" : "all",
    iceUseDefaultStunServer: false,
    iceUseIpv6: false,
    ...(ice.interfaceAddress && { iceInterfaceAddresses: { udp4: ice.interfaceAddress } }),
  };
}
