// apps/agent/spike/spike.ts
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useH264,
} from 'werift';
import {
  packetizeAnnexB,
  splitAnnexB,
  spsProfileLevelId,
} from './packetizer-copy.ts';

export interface SpikeRunResult {
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer';
  negotiatedCodec: {
    mimeType: string;
    payloadType: number;
    parameters?: string;
  } | null;
  wirePayloadType: number | null;
  negotiatedPacketizationMode: number | null;
  decodedFrameCount: number;
  encoderProfileLevelId: string | null;
  negotiatedProfileLevelId: string | null;
  profileMatches: boolean | null;
  pliObserved: boolean;
  keyframeAfterPli: boolean;
  /**
   * The presented picture's 4x4 luma region means, plus how far they are from
   * the fixture's own. A3 requires pixels, not merely a decoder that produced
   * *a* picture: an all-black stream decodes happily.
   */
  lumaGrid: number[][] | null;
  lumaSpread: number | null;
  maxGridDeviation: number | null;
  answerSdp: string;
  offerSdp: string;
}

const FIXTURE_PATH = join(
  import.meta.dirname,
  'fixtures',
  'idr-1280x720.annexb',
);
const PAGE_PATH = join(import.meta.dirname, 'browser-peer.html');

const FRAME_INTERVAL_MS = 33;
const SSRC = 0x2b3c4d5e;

/** The `profile-level-id` carried in an `fmtp` parameters string, uppercased. */
function fmtpProfileLevelId(parameters: string | undefined): string | null {
  if (!parameters) return null;
  const match = /profile-level-id=([0-9a-fA-F]{6})/.exec(parameters);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The fixture's IDR access unit, with its SPS and PPS stripped.
 *
 * Used to provoke a PLI: a receiver that is handed slices it has no parameter
 * sets for cannot initialise its decoder, and asks for a keyframe. Without a
 * mechanism like this the round-trip is untestable — a healthy stream never
 * produces one.
 */
function slicesOnly(annexB: Buffer): Buffer {
  const kept = splitAnnexB(annexB).filter((nal) => {
    const type = nal[0]! & 0x1f;
    return type !== 7 && type !== 8;
  });
  return Buffer.concat(kept.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal]));
}

interface BrowserStats {
  decodedFrames: number;
  framesReceived: number;
  packetsReceived: number;
  bytesReceived: number;
  payloadType: number | null;
  codecMimeType: string | null;
  presentedFrames: number;
  lumaGrid: number[][] | null;
  videoWidth: number;
  videoHeight: number;
  connectionState: string;
  errors: string[];
}

/**
 * The fixture's own 4x4 luma grid, derived by decoding it with
 * `ffmpeg -pix_fmt gray` and taking a region mean — not by hand. This is the
 * ground truth the received picture is compared against.
 */
const EXPECTED_GRID: number[][] = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures', 'expected-grid.json'),
      'utf8',
    ),
  ) as { grid: number[][] }
).grid;

function gridSpread(grid: number[][]): number {
  const flat = grid.flat();
  return Math.max(...flat) - Math.min(...flat);
}

/** The largest absolute difference between two same-shaped grids. */
function maxDeviation(a: number[][], b: number[][]): number {
  let worst = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y]!.length; x++) {
      worst = Math.max(worst, Math.abs(a[y]![x]! - (b[y]?.[x] ?? 0)));
    }
  }
  return worst;
}

async function readStats(page: Page): Promise<BrowserStats> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __getStats: () => Promise<BrowserStats> }
      ).__getStats() as Promise<BrowserStats>,
  );
}

async function waitForConnection(pc: RTCPeerConnection, page: Page) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (pc.connectionState === 'connected') return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      throw new Error(
        `spike: peer connection ${pc.connectionState} (browser=${(await readStats(page)).connectionState})`,
      );
    }
    await delay(100);
  }
  throw new Error(
    `spike: peer connection did not reach "connected" (state=${pc.connectionState})`,
  );
}

/** Drive one full transport-half run against a real Chromium peer. */
async function runSpikeOnce(): Promise<SpikeRunResult> {
  const annexB = readFileSync(FIXTURE_PATH);
  const browser: Browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (err) =>
    browserErrors.push(`pageerror: ${err.message}`),
  );

  try {
    await page.goto(`file://${PAGE_PATH}`);

    const offerSdp = (await page.evaluate(() =>
      (
        window as unknown as { __createOffer: () => Promise<string> }
      ).__createOffer(),
    )) as string;

    const pc = new RTCPeerConnection({
      codecs: { audio: [], video: [useH264()] },
      iceServers: [],
    });

    // R-S4: the transceiver exists BEFORE setRemoteDescription. Adding it
    // afterwards yields a second, `a=inactive` m-line whose `sender.codec` is
    // undefined — which `sendRtp` then turns into a silent no-op.
    pc.addTransceiver('video', { direction: 'sendrecv' });

    // werift starts gathering as soon as the transceiver exists, which is
    // BEFORE the browser has an answer to attach candidates to. The page
    // rejects a candidate while its remote description is null, so hold them
    // here and flush once `__setAnswer` has resolved.
    const localCandidates: Array<{
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }> = [];
    let answerSet = false;
    const flushCandidates = async () => {
      while (localCandidates.length > 0) {
        const candidate = localCandidates.shift()!;
        await page.evaluate(
          (c) =>
            (
              window as unknown as {
                __addIce: (x: unknown) => Promise<number>;
              }
            ).__addIce(c),
          candidate,
        );
      }
    };
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      localCandidates.push({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
      if (answerSet) {
        void flushCandidates().catch((err: Error) =>
          browserErrors.push(`addIce: ${err.message}`),
        );
      }
    });

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

    const transceiver = pc.getTransceivers()[0]!;
    const sender = transceiver.sender as unknown as {
      codec?: { mimeType: string; payloadType: number; parameters?: string };
      onPictureLossIndication?: {
        subscribe: (fn: () => void) => void;
      };
    };

    // R-S3: re-point the sender at the browser's `packetization-mode=1` entry.
    // `prepareSend` already ran inside `setRemoteDescription`, so reordering
    // alone does not move `sender.codec`; the assignment below is what does
    // the work. Never spread a codec — `{...codec}` drops the `name`
    // prototype getter and `sdpManager` then throws on `.toLowerCase()`.
    const mode1Entry = (transceiver.codecs ?? []).find(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        (c.parameters ?? '').includes('packetization-mode=1'),
    );
    if (!mode1Entry) {
      throw new Error(
        'spike: the browser offered no H.264 entry with packetization-mode=1',
      );
    }
    transceiver.codecs = [
      mode1Entry,
      ...(transceiver.codecs ?? []).filter((c) => c !== mode1Entry),
    ];
    sender.codec = mode1Entry as typeof sender.codec;

    const track = new MediaStreamTrack({
      kind: 'video',
      id: 'spike-video',
      ssrc: SSRC,
    });
    const addedSender = pc.addTrack(track);
    // `addTrack` reuses the pre-existing transceiver; confirm identity rather
    // than assuming, because a second m-line would produce a stream nobody
    // subscribed to.
    if (addedSender !== transceiver.sender) {
      throw new Error('spike: addTrack created a different sender');
    }
    track.codec = mode1Entry;

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await page.evaluate(
      (sdp) =>
        (
          window as unknown as {
            __setAnswer: (x: string) => Promise<string>;
          }
        ).__setAnswer(sdp),
      answer.sdp ?? '',
    );
    answerSet = true;
    await flushCandidates();

    // Trickle the browser's candidates into werift. Poll because the page has
    // no back-channel; the list is small and local.
    let drained = 0;
    const candidateDeadline = Date.now() + 15_000;
    while (Date.now() < candidateDeadline) {
      const candidates = (await page.evaluate(() =>
        (
          window as unknown as {
            __getCandidates: () => Promise<
              Array<{
                candidate: string;
                sdpMid: string | null;
                sdpMLineIndex: number | null;
              }>
            >;
          }
        ).__getCandidates(),
      )) as Array<{
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
      }>;
      for (const c of candidates.slice(drained)) {
        await pc.addIceCandidate(c);
      }
      drained = candidates.length;
      if (pc.connectionState === 'connected') break;
      await delay(100);
    }

    await waitForConnection(pc, page);

    let pliObserved = false;
    const pliPromise = new Promise<void>((resolve) => {
      sender.onPictureLossIndication?.subscribe(() => {
        pliObserved = true;
        resolve();
      });
    });

    // `randomInt`'s upper bound is exclusive, so `0xffff` and `0xffffffff`
    // reproduce the `0 .. n-1` range `Math.floor(Math.random() * n)` had.
    let sequenceNumber = randomInt(0, 0xffff);
    let timestamp = randomInt(0, 0xffffffff);

    const send = (bytes: Buffer, step = 3000) => {
      const result = packetizeAnnexB(bytes, {
        payloadType: sender.codec!.payloadType,
        sequenceNumber,
        timestamp,
        ssrc: SSRC,
      });
      for (const packet of result.packets) {
        track.writeRtp(
          new RtpPacket(
            new RtpHeader({
              payloadType: packet.payloadType,
              sequenceNumber: packet.sequenceNumber,
              timestamp: packet.timestamp,
              ssrc: SSRC,
              marker: packet.marker,
            }),
            packet.payload,
          ),
        );
      }
      sequenceNumber = result.nextSequenceNumber;
      timestamp = (timestamp + step) >>> 0;
    };

    // Phase A — provoke a PLI by sending slices with no parameter sets.
    const sliced = slicesOnly(annexB);
    const sliceDeadline = Date.now() + 4000;
    while (!pliObserved && Date.now() < sliceDeadline) {
      send(sliced);
      await delay(FRAME_INTERVAL_MS);
    }
    await Promise.race([pliPromise, delay(500)]);

    const statsBeforeKeyframe = await readStats(page);

    // Phase B — a real keyframe: SPS + PPS + IDR, repeated so the receiver has
    // several chances to decode once its decoder can initialise.
    //
    // The loop does NOT stop at the first decoded frame: a single frame is a
    // sample of one, and the luma comparison below is more trustworthy with
    // several. It keeps sending for a fixed window after the first decode.
    const firstDecodeDeadline = Date.now() + 3000;
    let lastStats = statsBeforeKeyframe;
    while (Date.now() < firstDecodeDeadline) {
      send(annexB);
      await delay(FRAME_INTERVAL_MS);
      lastStats = await readStats(page);
      if (lastStats.decodedFrames > statsBeforeKeyframe.decodedFrames) break;
    }

    if (lastStats.decodedFrames === 0) {
      // Give the decoder one last window before declaring the gate failed.
      const finalDeadline = Date.now() + 2000;
      while (Date.now() < finalDeadline && lastStats.decodedFrames === 0) {
        send(annexB);
        await delay(FRAME_INTERVAL_MS);
        lastStats = await readStats(page);
      }
    } else {
      const settleDeadline = Date.now() + 1500;
      while (Date.now() < settleDeadline) {
        send(annexB);
        await delay(FRAME_INTERVAL_MS);
      }
      lastStats = await readStats(page);
    }

    const encoderProfileLevelId = spsProfileLevelId(annexB);
    const negotiatedProfileLevelId = fmtpProfileLevelId(
      sender.codec?.parameters,
    );

    return {
      run: 'r-s1-list',
      negotiatedCodec: sender.codec
        ? {
            mimeType: sender.codec.mimeType,
            payloadType: sender.codec.payloadType,
            parameters: sender.codec.parameters,
          }
        : null,
      wirePayloadType: lastStats.payloadType,
      negotiatedPacketizationMode: (sender.codec?.parameters ?? '').includes(
        'packetization-mode=1',
      )
        ? 1
        : 0,
      decodedFrameCount: lastStats.decodedFrames,
      encoderProfileLevelId,
      negotiatedProfileLevelId,
      profileMatches:
        encoderProfileLevelId && negotiatedProfileLevelId
          ? // Only the first three octets' high nibbles carry profile/level
            // constraints that a browser enforces; compare the profile_idc and
            // level_idc the way the browser does.
            encoderProfileLevelId.slice(0, 2) ===
              negotiatedProfileLevelId.slice(0, 2) &&
            encoderProfileLevelId.slice(2, 4) ===
              negotiatedProfileLevelId.slice(2, 4)
          : null,
      pliObserved,
      keyframeAfterPli:
        pliObserved &&
        lastStats.decodedFrames > statsBeforeKeyframe.decodedFrames,
      lumaGrid: lastStats.lumaGrid,
      lumaSpread: lastStats.lumaGrid ? gridSpread(lastStats.lumaGrid) : null,
      maxGridDeviation: lastStats.lumaGrid
        ? Math.round(maxDeviation(lastStats.lumaGrid, EXPECTED_GRID) * 100) /
          100
        : null,
      answerSdp: answer.sdp ?? '',
      offerSdp,
    };
  } finally {
    await browser.close();
    if (browserErrors.length > 0) {
      process.stderr.write(
        `spike browser errors:\n${browserErrors.join('\n')}\n`,
      );
    }
  }
}

/**
 * Memoised so the two transport tests share ONE run.
 *
 * Both tests assert on the same exchange — pixels, then the PLI round-trip —
 * and launching Chromium twice would double the cost while testing the same
 * code path. A failed run fails both, which is the honest outcome: neither
 * assertion can be made from a run that never reached pixels.
 */
const runs = new Map<string, Promise<SpikeRunResult>>();

export async function runSpike(
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer',
): Promise<SpikeRunResult> {
  if (run !== 'r-s1-list') {
    throw new Error(
      `runSpike: "${run}" is a negotiation-only run — it never opens a transport`,
    );
  }
  let pending = runs.get(run);
  if (!pending) {
    pending = runSpikeOnce();
    runs.set(run, pending);
  }
  return pending;
}
