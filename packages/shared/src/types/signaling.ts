export interface SignalOffer {
  sessionId: string;
  sdp: string;
  capabilities: string[];
}

export interface SignalAnswer {
  sessionId: string;
  sdp: string;
  approved: boolean;
}

export interface IceCandidateSignal {
  sessionId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalMessage =
  | { type: 'offer'; data: SignalOffer }
  | { type: 'answer'; data: SignalAnswer }
  | { type: 'ice-candidate'; data: IceCandidateSignal };
