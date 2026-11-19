import ndc from 'node-datachannel';
import { H264_FMTP, containsPli, isRtcp, rtpPayloadOffset } from './common.mjs';

ndc.initLogger('Error', (level, message) => process.stderr.write(`[libdatachannel ${level}] ${message}\n`));

const PAYLOAD_TYPE = 96;
const MAX_FRAGMENT = 1200;
// Without forceMediaTransport a data-channel-only first negotiation sets up DTLS without SRTP,
// and the video m-line added later over the lane never opens.
const config = { iceServers: [], bindAddress: '127.0.0.1', forceMediaTransport: true };

/**
 * "raw": no media handler; RTP is built from the clip's pre-packetized payloads and RTCP PLI is
 * sent and parsed in JS. "native": libdatachannel's H264RtpPacketizer, SR reporter and NACK
 * responder. RtcpReceivingSession is left out in both modes: on a sendrecv track it consumes every
 * incoming RTCP packet, PLI included, so the sender side would never see keyframe requests.
 */
let mode = 'raw';
export let name = 'node-datachannel';

export function configure(library) {
  mode = library === 'ndc-native' ? 'native' : 'raw';
  name = `node-datachannel (${mode})`;
}

function sendRaw(output, frame, timestamp) {
  const last = frame.payloads.length - 1;
  frame.payloads.forEach((payload, index) => {
    const packet = Buffer.allocUnsafe(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = (index === last ? 0x80 : 0) | PAYLOAD_TYPE;
    packet.writeUInt16BE(output.sequence, 2);
    packet.writeUInt32BE(timestamp, 4);
    packet.writeUInt32BE(output.ssrc, 8);
    payload.copy(packet, 12);
    output.sequence = (output.sequence + 1) & 0xffff;
    output.track.sendMessageBinary(packet);
  });
}

export function createCamera() {
  const outputs = [];
  return {
    outputs,
    send(frame, timestamp) {
      for (const output of outputs) {
        if (!output.track.isOpen()) continue;
        if (mode === 'raw') {
          sendRaw(output, frame, timestamp);
        } else {
          output.rtpConfig.timestamp = timestamp;
          output.track.sendMessageBinary(frame.annexb);
        }
      }
    },
  };
}

function buildPli(senderSsrc, mediaSsrc) {
  const packet = Buffer.alloc(12);
  packet[0] = 0x81;
  packet[1] = 206;
  packet.writeUInt16BE(2, 2);
  packet.writeUInt32BE(senderSsrc, 4);
  packet.writeUInt32BE(mediaSsrc, 8);
  return packet;
}

function addVideo(pc, bot, group) {
  const ssrc = Math.floor(Math.random() * 2 ** 31) + 1;
  const cname = `bot${bot.id}`;
  const video = new ndc.Video('video', 'SendRecv');
  video.addH264Codec(PAYLOAD_TYPE, H264_FMTP);
  video.addSSRC(ssrc, cname, cname, `camera${bot.id}`);
  const track = pc.addTrack(video);
  const output = { track, ssrc, sequence: Math.floor(Math.random() * 0x10000) };
  const handlers = [];
  if (mode === 'native') {
    output.rtpConfig = new ndc.RtpPacketizationConfig(ssrc, cname, PAYLOAD_TYPE, 90000);
    const packetizer = new ndc.H264RtpPacketizer('LongStartSequence', output.rtpConfig, MAX_FRAGMENT);
    handlers.push(packetizer, new ndc.RtcpSrReporter(output.rtpConfig), new ndc.RtcpNackResponder());
    for (const handler of handlers.slice(1)) packetizer.addToChain(handler);
    track.setMediaHandler(packetizer);
  }
  let remoteSsrc = 0;
  // Native mode cannot send a PLI: a raw RTCP packet would go through the packetizer.
  const requestKeyframe = mode === 'raw' ? () => remoteSsrc && track.sendMessageBinary(buildPli(ssrc, remoteSsrc)) : () => {};
  const stream = group ? bot.addStream(requestKeyframe) : undefined;
  track.onMessage((packet) => {
    if (isRtcp(packet)) {
      if (containsPli(packet)) bot.onPli();
    } else if (stream) {
      remoteSsrc = packet.readUInt32BE(8);
      const offset = rtpPayloadOffset(packet);
      stream.record(packet.readUInt16BE(2), packet.readUInt32BE(4), (packet[1] & 0x80) !== 0, packet.subarray(offset), performance.now());
    }
  });
  if (group) bot.camera.outputs.push(output);
  const opened = new Promise((resolve) => (track.isOpen() ? resolve() : track.onOpen(resolve)));
  return { track, video, handlers, opened };
}

function waitOpen(channel) {
  return new Promise((resolve) => (channel.isOpen() ? resolve() : channel.onOpen(resolve)));
}

/**
 * Connects two bots: data-channel-only offer/answer in process, then the video m-line is
 * added by an offer/answer exchanged over the "data" channel, as the app's media lane does.
 */
export async function connectLink(first, second, group) {
  const offerer = new ndc.PeerConnection(`bot${first.id}-${second.id}`, config);
  const answerer = new ndc.PeerConnection(`bot${second.id}-${first.id}`, config);
  const lane = { offerer: undefined, answerer: undefined };
  const wireSignalling = (local, remote, side) => {
    local.onLocalDescription((sdp, type) => {
      if (lane[side]) lane[side].sendMessage(JSON.stringify({ sdp, type }));
      else setImmediate(() => remote.setRemoteDescription(sdp, type));
    });
    local.onLocalCandidate((candidate, mid) => {
      if (!lane[side]) setImmediate(() => remote.addRemoteCandidate(candidate, mid));
    });
  };
  wireSignalling(offerer, answerer, 'offerer');
  wireSignalling(answerer, offerer, 'answerer');

  const answererChannel = new Promise((resolve) => answerer.onDataChannel(resolve));
  const offererChannel = offerer.createDataChannel('data');
  const channels = await Promise.all([waitOpen(offererChannel).then(() => offererChannel), answererChannel]);
  await waitOpen(channels[1]);
  [lane.offerer, lane.answerer] = channels;

  const media = {};
  const answered = new Promise((resolve) => {
    lane.answerer.onMessage((message) => {
      const { sdp, type } = JSON.parse(message);
      media.answerer = addVideo(answerer, second, group);
      answerer.setRemoteDescription(sdp, type);
      resolve();
    });
  });
  lane.offerer.onMessage((message) => {
    const { sdp, type } = JSON.parse(message);
    offerer.setRemoteDescription(sdp, type);
  });
  media.offerer = addVideo(offerer, first, group);
  offerer.setLocalDescription();
  await answered;
  await Promise.all([media.offerer.opened, media.answerer.opened]);
  return { offerer, answerer, media, channels };
}
