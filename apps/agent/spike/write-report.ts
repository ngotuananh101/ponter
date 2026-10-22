// apps/agent/spike/write-report.ts
/**
 * Runs the spike and writes `report.json` — the machine-readable evidence the
 * plan's P0 gate and the §8 trail cite.
 *
 * Kept out of `spike.test.ts` so the test stays a test: the test asserts, this
 * records. Run it with
 * `pnpm --filter @ponter/agent-node exec tsx spike/write-report.ts`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeNegotiation } from './negotiation.ts';
import { runSpike, type SpikeRunResult } from './spike.ts';

export interface NegotiationOnlyResult {
  run: 'vp8-first-local' | 'mode-0-first-offer-without-r-s3';
  negotiatedCodec: {
    mimeType: string;
    payloadType: number;
    parameters?: string;
  } | null;
  negotiatedPacketizationMode: number | null;
  answerSdp: string;
  offerSdp: string;
  note: string;
}

export interface SpikeReport {
  generatedBy: string;
  weriftVersion: string;
  note: string;
  runs: SpikeRunResult[];
  negotiationOnly: NegotiationOnlyResult[];
}

async function main() {
  const transport = await runSpike('r-s1-list');

  const vp8First = await probeNegotiation('vp8-first-local');
  const mode0NoFix = await probeNegotiation('mode-0-first-offer', {
    applyR_S3: false,
  });

  const report: SpikeReport = {
    generatedBy: 'apps/agent/spike/write-report.ts',
    weriftVersion: '0.24.4',
    note: 'Run 1 (r-s1-list) is the transport-half result: a real Chromium peer decoded the H.264 the werift sender wrote. The two negation-only runs never open a transport — the synthetic offer carries a placeholder DTLS fingerprint, so no handshake can complete against it. They measure what werift NEGOTIATES, which is where the D4b and D4d regressions live.',
    runs: [transport],
    negotiationOnly: [
      {
        run: 'vp8-first-local',
        negotiatedCodec: vp8First.negotiatedCodec,
        negotiatedPacketizationMode: vp8First.negotiatedPacketizationMode,
        answerSdp: vp8First.answerSdp,
        offerSdp: vp8First.offerSdp,
        note: 'D4b, reproduced: a local codec list of [useVP8(), useH264()] lets the browser VP8 entry survive the mime-type-only filter and, because werift takes params.codecs[0] as the sender codec (rtpSender.js:408), the sender lands on VP8. That is the black-video bug. R-S1 ([useH264()] only) is the fix; run 1 is the proof it works.',
      },
      {
        run: 'mode-0-first-offer-without-r-s3',
        negotiatedCodec: mode0NoFix.negotiatedCodec,
        negotiatedPacketizationMode: mode0NoFix.negotiatedPacketizationMode,
        answerSdp: mode0NoFix.answerSdp,
        offerSdp: mode0NoFix.offerSdp,
        note: 'D4d, reproduced: with the mode-0 H.264 entry listed first, werift takes it as the sender codec because transceiverManager.js:244-260 filters by mime type only and never inspects fmtp. R-S3 re-points the sender at the mode-1 entry; the negotiation test asserts the re-point lands on pt102.',
      },
    ],
  };

  const target = join(import.meta.dirname, 'report.json');
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
  process.stdout.write(
    `run 1: decoded=${transport.decodedFrameCount} wirePt=${transport.wirePayloadType} pli=${transport.pliObserved} keyframeAfterPli=${transport.keyframeAfterPli} encoder=${transport.encoderProfileLevelId} negotiated=${transport.negotiatedProfileLevelId}\n`,
  );
  process.stdout.write(
    `vp8-first-local: ${vp8First.negotiatedCodec?.mimeType} pt=${vp8First.negotiatedCodec?.payloadType}\n`,
  );
  process.stdout.write(
    `mode-0-first without R-S3: ${mode0NoFix.negotiatedCodec?.mimeType} pt=${mode0NoFix.negotiatedCodec?.payloadType}\n`,
  );

  // The werift peer connections are deliberately never closed — the ordinary
  // path (`vitest`) exits for us, but a standalone run would sit on werift's
  // live timers forever after the work is done. Exiting here says "finished",
  // not "gave up": `writeFileSync` above has already flushed the report.
  process.exit(0);
}

await main();
