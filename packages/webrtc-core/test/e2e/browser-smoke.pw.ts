import { test, expect } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  setupE2E,
  teardownE2E,
  spawnLogged,
  killAndWait,
  waitFor,
  BASE_URL,
  REPO_ROOT,
  spawnAgent,
  waitForAgentOnline,
  waitForAgentSigningKey,
  postJson,
  type AgentCreated,
} from './harness';

const WEB_PORT = 5173;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

let viteChild: ChildProcess | null = null;

test.beforeAll(async () => {
  process.env.CORS_ORIGIN = WEB_URL;
  await setupE2E();

  const vite = spawnLogged(
    'pnpm',
    [
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      String(WEB_PORT),
      '--strictPort',
    ],
    {
      cwd: join(REPO_ROOT, 'apps', 'web'),
      env: { VITE_API_URL: BASE_URL },
    },
  );
  viteChild = vite.child;

  await waitFor(
    async () => {
      try {
        const res = await fetch(WEB_URL);
        return res.ok;
      } catch {
        return false;
      }
    },
    `Vite dev server on ${WEB_URL}`,
    40_000,
  );
});

test.afterAll(async () => {
  await teardownE2E(async () => {
    if (viteChild) {
      await killAndWait(viteChild);
      viteChild = null;
    }
  });
});

test('browser desktop stream connects, verifies peer, applies playout tuning, and echoes input', async ({
  page,
}) => {
  // Capture created RTCPeerConnections and desktop-stats frames from the app context
  await page.addInitScript(() => {
    const customWindow = window as unknown as {
      __pcs: RTCPeerConnection[];
      __statsFrames: Array<{
        frameSamples?: Array<{
          seq: number;
          captureEpochMs: number;
          encodeMs: number;
        }>;
      }>;
    };
    customWindow.__pcs = [];
    customWindow.__statsFrames = [];

    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args: unknown[]) {
      const pc = new (
        Orig as unknown as new (...a: unknown[]) => RTCPeerConnection
      )(...args);
      customWindow.__pcs.push(pc);

      const origCreateDataChannel = pc.createDataChannel;
      pc.createDataChannel = function (
        label: string,
        opts?: RTCDataChannelInit,
      ) {
        const dc = origCreateDataChannel.call(pc, label, opts);
        if (label === 'control') {
          dc.addEventListener('message', (ev: MessageEvent) => {
            try {
              const msg = JSON.parse(ev.data as string) as {
                type?: string;
                payload?: {
                  frameSamples?: Array<{
                    seq: number;
                    captureEpochMs: number;
                    encodeMs: number;
                  }>;
                };
              };
              if (msg.type === 'desktop-stats' && msg.payload) {
                customWindow.__statsFrames.push(msg.payload);
              }
            } catch {
              // Ignore non-JSON or unrelated frames
            }
          });
        }
        return dc;
      };

      pc.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
        if (ev.channel.label === 'control') {
          ev.channel.addEventListener('message', (ev2: MessageEvent) => {
            try {
              const msg = JSON.parse(ev2.data as string) as {
                type?: string;
                payload?: {
                  frameSamples?: Array<{
                    seq: number;
                    captureEpochMs: number;
                    encodeMs: number;
                  }>;
                };
              };
              if (msg.type === 'desktop-stats' && msg.payload) {
                customWindow.__statsFrames.push(msg.payload);
              }
            } catch {
              // Ignore non-JSON or unrelated frames
            }
          });
        }
      });

      return pc;
    } as unknown as typeof RTCPeerConnection;
    window.RTCPeerConnection.prototype = Orig.prototype;
  });

  // 1. Register through the UI to generate IndexedDB ECDH & Ed25519 signing keys
  const suffix = `${Date.now()}`;
  const username = `smoke_${suffix}`;
  const password = 'Password123!';

  await page.goto(`${WEB_URL}/register`, { waitUntil: 'domcontentloaded' });
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', password);
  await page.fill('#reg-confirm-password', password);
  await page.locator('button[type="submit"]').click();

  await page.waitForFunction(
    () => localStorage.getItem('remote.accessToken') !== null,
    null,
    { timeout: 20_000 },
  );
  const token = await page.evaluate(() =>
    localStorage.getItem('remote.accessToken')!,
  );
  expect(token).toBeTruthy();

  // 2. Create agent + session via REST and spawn the real agent binary
  const agentId = `smoke-agent-${suffix}`;
  const created = await postJson<AgentCreated>(
    '/api/agents',
    { id: agentId, capabilities: ['desktop'] },
    token,
  );
  const agent = spawnAgent(
    agentId,
    created.credential,
    ['--desktop-source', 'test', '--allow-input'],
    { DISPLAY: process.env.DISPLAY ?? ':99' },
  );

  await waitForAgentOnline(token, agentId);
  await waitForAgentSigningKey(token, agentId);

  // 3. Navigate to workspace and connect to the desktop stream
  await page.goto(`${WEB_URL}/workspace`, { waitUntil: 'domcontentloaded' });
  const connectBtn = page.locator(`[data-test="connect-desktop-${agentId}"]`);
  await connectBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await connectBtn.click();

  // 4. Assert ADR-49 proof items:
  // Item a: desktop-stats visible
  const statsEl = page.locator('[data-test="desktop-stats"]');
  await statsEl.waitFor({ state: 'visible', timeout: 45_000 });
  const statsText = await statsEl.innerText();
  expect(statsText).toContain('1280×720');
  expect(statsText).toContain('30 fps');

  // Item b: remote video track attached and active
  const video = page.locator('video').first();
  await video.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      return (
        v !== null &&
        v.videoWidth > 0 &&
        v.videoHeight > 0 &&
        v.srcObject !== null
      );
    },
    null,
    { timeout: 20_000 },
  );

  // Item c: connection state === 'connected'
  const connState = await page.evaluate(() => {
    const pcs =
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [];
    for (const pc of pcs) {
      if (pc.getReceivers().some((r) => r.track?.kind === 'video')) {
        return pc.connectionState;
      }
    }
    return null;
  });
  expect(connState).toBe('connected');

  // Item d: peerVerified badge rendered (Phase 6a ADR-41/42)
  await expect(page.locator('[data-test="desktop-peer-verified"]')).toBeVisible(
    { timeout: 10_000 },
  );

  // Item e: receiver playout knob applied (Task 9)
  const receiverKnobs = await page.evaluate(() => {
    const pcs =
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [];
    for (const pc of pcs) {
      const recv = pc
        .getReceivers()
        .find((r) => r.track && r.track.kind === 'video') as
        Record<string, unknown> | undefined;
      if (recv) {
        return {
          hasJitterBufferTarget: 'jitterBufferTarget' in recv,
          jitterBufferTarget: recv.jitterBufferTarget,
          hasPlayoutDelayHint: 'playoutDelayHint' in recv,
          playoutDelayHint: recv.playoutDelayHint,
        };
      }
    }
    return null;
  });
  expect(receiverKnobs).not.toBeNull();
  if (receiverKnobs?.hasJitterBufferTarget) {
    expect(receiverKnobs.jitterBufferTarget).toBe(100);
  } else if (receiverKnobs?.hasPlayoutDelayHint) {
    expect(receiverKnobs.playoutDelayHint).toBeCloseTo(0.1);
  }

  // 5. Carry the ADR-47 glass-to-glass (g2g) protocol via test-pattern bar decode
  const g2gValues: number[] = [];
  for (let sampleIdx = 0; sampleIdx < 12; sampleIdx++) {
    const sample = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v || v.videoWidth === 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, 1280, 720);
      const canvasSampleMs = Date.now();
      const imgData = ctx.getImageData(0, 360, 1280, 1).data;

      // Scan 160 possible bar positions (each candidate k represents bar_x = k * 8)
      let bestK = -1;
      let bestScore = -Infinity;
      for (let k = 0; k < 160; k++) {
        const barX = k * 8;
        let score = 0;
        for (let dx = 0; dx < 16; dx++) {
          const x = (barX + dx) % 1280;
          const idx = x * 4;
          const r = imgData[idx] ?? 0;
          const g = imgData[idx + 1] ?? 0;
          score += g - r;
        }
        if (score > bestScore) {
          bestScore = score;
          bestK = k;
        }
      }

      const customWindow = window as unknown as {
        __statsFrames?: Array<{
          frameSamples?: Array<{
            seq: number;
            captureEpochMs: number;
            encodeMs: number;
          }>;
        }>;
      };
      const statsFrames = customWindow.__statsFrames ?? [];
      const allSamples = statsFrames.flatMap((f) => f.frameSamples ?? []);
      return {
        canvasSampleMs,
        bestK,
        bestScore,
        samples: allSamples,
      };
    });

    if (sample && sample.bestScore > 1000 && sample.samples.length > 0) {
      const matching = sample.samples.filter(
        (s: { seq: number; captureEpochMs: number }) =>
          Number(s.seq) % 160 === sample.bestK &&
          sample.canvasSampleMs >= s.captureEpochMs &&
          sample.canvasSampleMs - s.captureEpochMs < 1500,
      );
      const closest = matching[matching.length - 1];
      if (closest) {
        const diff = sample.canvasSampleMs - closest.captureEpochMs;
        if (diff >= 0 && diff < 1500) {
          g2gValues.push(diff);
        }
      }
    }
    await delay(80);
  }

  expect(g2gValues.length).toBeGreaterThan(0);
  g2gValues.sort((a, b) => a - b);
  const g2gMin = g2gValues[0];
  const g2gMax = g2gValues[g2gValues.length - 1];
  const g2gMedian = g2gValues[Math.floor(g2gValues.length / 2)];
  console.log(
    `[6b g2g] n=${g2gValues.length} min=${g2gMin}ms median=${g2gMedian}ms max=${g2gMax}ms`,
  );

  // 6. Assert input toggle and echo under Xvfb (:99)
  const toggle = page.locator('[data-test="desktop-input-toggle"]');
  await toggle.waitFor({ state: 'visible', timeout: 15_000 });
  await toggle.check().catch(async () => {
    await toggle.click();
  });

  const statusEl = page.locator('[data-test="desktop-input-status"]');
  await expect(statusEl).toHaveText('Controlling', { timeout: 10_000 });

  const box = await video.boundingBox();
  expect(box).not.toBeNull();
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(
      box!.x + box!.width * (0.2 + 0.05 * i),
      box!.y + box!.height * (0.3 + 0.04 * i),
    );
    await delay(60);
  }

  await waitFor(
    () => /desktop-input applied/.test(agent.output()),
    'agent to log "desktop-input applied"',
    20_000,
  );
});
