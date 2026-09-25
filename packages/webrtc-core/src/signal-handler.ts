import type { SignalMessage } from '@remote/shared';

export function toSessionDescriptionInit(
  offerOrAnswer: { sdp: string },
  type: 'offer' | 'answer',
): RTCSessionDescriptionInit {
  if (!offerOrAnswer.sdp) {
    throw new Error('Empty SDP description');
  }
  return {
    type,
    sdp: offerOrAnswer.sdp,
  };
}

export function toIceCandidateInit(signal: {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}): RTCIceCandidateInit {
  if (!signal.candidate) {
    throw new Error('Empty ICE candidate');
  }
  return {
    candidate: signal.candidate,
    sdpMid: signal.sdpMid ?? null,
    sdpMLineIndex: signal.sdpMLineIndex ?? null,
  };
}

export function createOfferSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  capabilities: string[] = [],
): SignalMessage {
  return {
    type: 'offer',
    data: {
      sessionId,
      sdp: desc.sdp ?? '',
      capabilities,
    },
  };
}

export function createAnswerSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  approved = true,
): SignalMessage {
  return {
    type: 'answer',
    data: {
      sessionId,
      sdp: desc.sdp ?? '',
      approved,
    },
  };
}

export function createCandidateSignal(
  sessionId: string,
  cand: RTCIceCandidateInit,
): SignalMessage {
  return {
    type: 'ice-candidate',
    data: {
      sessionId,
      candidate: cand.candidate ?? '',
      sdpMid: cand.sdpMid ?? null,
      sdpMLineIndex: cand.sdpMLineIndex ?? null,
    },
  };
}
