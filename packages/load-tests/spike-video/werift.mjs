import {
  H264Packetizer,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useNACK,
  usePLI,
  useREMB,
  useSdesMid,
  useTransportWideCC,
  useTWCC,
} from 'werift';
import { H264_FMTP } from './common.mjs';

const PAYLOAD_TYPE = 96;

let bandwidthEstimator = 'lightweight';
export let name = 'werift';

export function configure(library) {
  bandwidthEstimator = library === 'werift-gcc' ? 'gcc' : 'lightweight';
  name = `werift (${bandwidthEstimator})`;
}

const config = () => ({
  codecs: {
    audio: [],
    video: [
      new RTCRtpCodecParameters({
        mimeType: 'video/H264',
        clockRate: 90000,
        payloadType: PAYLOAD_TYPE,
        rtcpFeedback: [useNACK(), usePLI(), useREMB(), useTWCC()],
        parameters: H264_FMTP,
      }),
    ],
  },
  headerExtensions: { video: [useSdesMid(), useAbsSendTime(), useTransportWideCC()] },
  iceServers: [],
  iceUseDefaultStunServer: false,
  iceUseIpv6: false,
  iceInterfaceAddresses: { udp4: '127.0.0.1' },
  bandwidthEstimator,
});

// One camera track per bot, shared by every group link like a browser MediaStreamTrack;
// each sender rewrites SSRC and sequence numbers on its own copy.
export function createCamera() {
  const track = new MediaStreamTrack({ kind: 'video' });
  const packetizer = new H264Packetizer({ payloadType: PAYLOAD_TYPE, maxPayloadSize: 1200 });
  return {
    track,
    send(frame, timestamp) {
      for (const packet of packetizer.packetize(frame.annexb, timestamp)) track.writeRtp(packet);
    },
  };
}

function wireVideo(transceiver, bot, group) {
  transceiver.sender.onPictureLossIndication.subscribe(() => bot.onPli());
  if (!group) return;
  let remoteSsrc = 0;
  const stream = bot.addStream(() => {
    if (remoteSsrc) transceiver.receiver.sendRtcpPLI(remoteSsrc).catch(() => {});
  });
  transceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      const { header, payload } = rtp;
      remoteSsrc = header.ssrc;
      stream.record(header.sequenceNumber, header.timestamp, header.marker, payload, performance.now());
    });
  });
}

function opened(channel) {
  return new Promise((resolve) => {
    if (channel.readyState === 'open') return resolve();
    channel.stateChanged.subscribe((state) => state === 'open' && resolve());
  });
}

/**
 * Connects two bots: data-channel-only offer/answer in process, then the video m-line is
 * added by an offer/answer exchanged over the "data" channel, as the app's media lane does.
 */
export async function connectLink(first, second, group) {
  const offerer = new RTCPeerConnection(config());
  const answerer = new RTCPeerConnection(config());
  const answererChannel = new Promise((resolve) => answerer.onDataChannel.subscribe(resolve));
  const offererChannel = offerer.createDataChannel('data');
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription);
  const remoteChannel = await answererChannel;
  await Promise.all([opened(offererChannel), opened(remoteChannel)]);

  const send = (channel, description) => channel.send(JSON.stringify({ type: description.type, sdp: description.sdp }));
  const answered = new Promise((resolve, reject) => {
    remoteChannel.onMessage.subscribe(async (message) => {
      try {
        const added = new Promise((resolveAdded) =>
          answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
            wireVideo(transceiver, second, group);
            resolveAdded(transceiver);
          }),
        );
        await answerer.setRemoteDescription(JSON.parse(message));
        const transceiver = await added;
        transceiver.setDirection('sendrecv');
        if (group) await transceiver.sender.replaceTrack(second.camera.track);
        await answerer.setLocalDescription(await answerer.createAnswer());
        send(remoteChannel, answerer.localDescription);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  const negotiated = new Promise((resolve, reject) => {
    offererChannel.onMessage.subscribe((message) => offerer.setRemoteDescription(JSON.parse(message)).then(resolve, reject));
  });
  const transceiver = offerer.addTransceiver(group ? first.camera.track : 'video', { direction: 'sendrecv' });
  wireVideo(transceiver, first, group);
  await offerer.setLocalDescription(await offerer.createOffer());
  send(offererChannel, offerer.localDescription);
  await Promise.all([answered, negotiated]);
  return { offerer, answerer };
}
