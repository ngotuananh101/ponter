import { setTimeout as delay } from 'node:timers/promises';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  openFilesPeer,
  waitForFilesFrame,
  waitFor,
  agents,
  type FilesFrame,
} from './harness';
import type {
  FilesAckMessage,
  FilesDownloadBegin,
  FilesDownloadRequest,
  FilesErrorCode,
  FilesErrorMessage,
  FilesListRequest,
  FilesListResult,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
  FileChunkMessage,
} from '@ponter/shared';

const FILE_CHUNK_BYTES = 32768;
const WINDOW = 16;

/**
 * Layer 3: a real Rust agent serving a real directory over a real
 * DTLS/SCTP channel, driven by a raw TypeScript offerer (spec §8.3).
 * No Xvfb, no capture stack — mirror of terminal.e2e.test.ts.
 */
describe.skipIf(!isLinux)('cross-language files E2E', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    await setupE2E();
    // A shared parent holds the root and the escape target as siblings, so a
    // single `..` from the root reaches the outside file on the real filesystem
    // (canonicalize succeeds and the prefix check yields PATH_OUTSIDE_ROOT
    // rather than NOT_FOUND). See spec §6.4's path-policy rows.
    const parent = mkdtempSync(join(tmpdir(), 'ponter-files-'));
    rootDir = join(parent, 'root');
    outsideDir = join(parent, 'outside');
    mkdirSync(rootDir);
    mkdirSync(outsideDir);
    // Seed: a small file, a subdirectory with a file, and a 600 KiB file
    // (19 chunks — larger than the 16-chunk window, so the sender must pause
    // for acks; spec §8.3 "download").
    writeFileSync(join(rootDir, 'notes.txt'), 'hello ponter\n');
    mkdirSync(join(rootDir, 'docs'));
    writeFileSync(join(rootDir, 'docs', 'readme.md'), '# docs\n');
    const big = Buffer.alloc(600 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    writeFileSync(join(rootDir, 'big.bin'), big);
    // The escape target lives OUTSIDE the root; the path-escape test proves
    // the sandbox refuses to reach it.
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside\n');
  }, 120_000);

  afterAll(async () => {
    await teardownE2E(() => {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    });
  }, 60_000);

  /** Register + spawn an agent whose files gate is open on `rootDir`. */
  async function connectFilesAgent(): Promise<{
    token: string;
    agentId: string;
    sessionId: string;
    frames: FilesFrame[];
    offerer: PeerConnection;
    send: (type: string, payload: unknown) => void;
  }> {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });
    spawnAgent(agentId, credential, ['--files-root', rootDir]);
    await waitForAgentOnline(token, agentId);
    const { offerer, frames } = await openFilesPeer(
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
    );
    return {
      token,
      agentId,
      sessionId,
      frames,
      offerer,
      send: (type, payload) =>
        offerer.dataChannels.sendJson('files', type, payload),
    };
  }

  it('lists the seeded directory with sizes and types', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const request: FilesListRequest = {
        requestId: crypto.randomUUID(),
        path: '',
      };
      send('files-list', request);

      const frame = await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-list-result',
        'files-list-result for the root',
      );
      const result = frame.payload as unknown as FilesListResult;
      expect(result.requestId).toBe(request.requestId);
      expect(result.truncated).toBe(false);

      const names = result.entries.map((e) => e.name).sort();
      expect(names).toEqual(['big.bin', 'docs', 'notes.txt']);

      const notes = result.entries.find((e) => e.name === 'notes.txt');
      expect(notes?.isDirectory).toBe(false);
      expect(notes?.size).toBe('hello ponter\n'.length);

      const docs = result.entries.find((e) => e.name === 'docs');
      expect(docs?.isDirectory).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('downloads a 600 KiB file byte-for-byte across the 16-chunk window', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: 'big.bin',
      } satisfies FilesDownloadRequest);

      const begin = (
        await waitForFilesFrame(
          frames,
          (f) => f.type === 'files-download-begin',
          'files-download-begin',
        )
      ).payload as unknown as FilesDownloadBegin;
      const totalChunks = Math.ceil((600 * 1024) / FILE_CHUNK_BYTES);
      expect(begin.size).toBe(600 * 1024);
      expect(begin.totalChunks).toBe(totalChunks);
      expect(totalChunks).toBeGreaterThan(WINDOW); // the window is exercised

      const chunks = new Map<number, Buffer>();
      let acked = 0;

      // Drive the sender: ack every chunk as it arrives. The agent pauses at
      // the 16-chunk window until acks arrive (ADR-34).
      const deadline = Date.now() + 60_000;
      while (acked < totalChunks && Date.now() < deadline) {
        const pending = frames.filter(
          (f) =>
            f.type === 'files-download-chunk' &&
            !chunks.has(
              (f.payload as unknown as FileChunkMessage).chunkIndex ?? -1,
            ),
        );
        for (const frame of pending) {
          const chunk = frame.payload as unknown as FileChunkMessage;
          chunks.set(chunk.chunkIndex, Buffer.from(chunk.data, 'base64'));
          acked = chunks.size;
          send('files-download-ack', {
            transferId,
            nextChunkIndex: acked,
          } satisfies FilesAckMessage);
        }
        if (acked < totalChunks) await delay(50);
      }

      expect(acked).toBe(totalChunks);
      await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-end',
        'files-download-end',
      );

      const assembled = Buffer.concat(
        [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
      );
      expect(
        Buffer.compare(assembled, readFileSync(join(rootDir, 'big.bin'))),
      ).toBe(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('uploads a 100 KiB file that lands byte-equal with no .part left behind', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      const payload = Buffer.alloc(100 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 256;
      const totalChunks = Math.ceil(payload.length / FILE_CHUNK_BYTES); // 4

      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'uploaded.bin',
        size: payload.length,
      } satisfies FilesUploadBeginRequest);

      // Wait for the first ack before sending, then keep the window open.
      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-upload-ack' &&
          (f.payload as unknown as FilesAckMessage).transferId === transferId &&
          (f.payload as unknown as FilesAckMessage).nextChunkIndex === 0,
        'files-upload-ack { nextChunkIndex: 0 }',
      );

      for (let index = 0; index < totalChunks; index += 1) {
        const slice = payload.subarray(
          index * FILE_CHUNK_BYTES,
          Math.min((index + 1) * FILE_CHUNK_BYTES, payload.length),
        );
        send('files-upload-chunk', {
          transferId,
          chunkIndex: index,
          totalChunks,
          data: slice.toString('base64'),
        } satisfies FileChunkMessage);

        // The ack for chunk `index` is `nextChunkIndex: index + 1`.
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-upload-ack' &&
            (f.payload as unknown as FilesAckMessage).transferId ===
              transferId &&
            (f.payload as unknown as FilesAckMessage).nextChunkIndex ===
              index + 1,
          `files-upload-ack { nextChunkIndex: ${index + 1} }`,
        );
      }

      send('files-upload-end', { transferId } satisfies FilesUploadEndRequest);

      const complete = (
        await waitForFilesFrame(
          frames,
          (f) => f.type === 'files-upload-complete',
          'files-upload-complete',
        )
      ).payload as unknown as FilesUploadComplete;
      expect(complete.name).toBe('uploaded.bin');
      expect(complete.size).toBe(payload.length);

      expect(
        Buffer.compare(readFileSync(join(rootDir, 'uploaded.bin')), payload),
      ).toBe(0);
      expect(existsSync(join(rootDir, 'uploaded.bin.ponter-part'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('cancel mid-download stops the chunks, logs, and leaves the session usable', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: 'big.bin',
      } satisfies FilesDownloadRequest);

      // `files-download-begin` arrives, then `pump_download` emits the initial
      // WINDOW-bounded batch in one call (spec §2.4: the sender fills the
      // window on start). Ack exactly one chunk, then cancel. The cancel is a
      // separate frame: the agent processes it, clears its download state
      // (mirror of the Rust unit test `cancel_stops_the_download_and_removes_the_state`),
      // and never pumps again — so the transfer can never reach the full 19
      // chunks. The in-flight window (≤16) may still drain from the SCTP
      // buffer; the contract is that the *pump* stops, not that already-queued
      // frames are retracted (impossible on a fire-and-forget channel).
      await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-begin',
        'files-download-begin',
      );
      // Let the initial window land, then ack one and cancel.
      await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-chunk',
        'the first download chunk',
      );
      send('files-download-ack', {
        transferId,
        nextChunkIndex: 1,
      } satisfies FilesAckMessage);
      send('files-cancel', { transferId });

      // Wait for the agent to log the cancel (info level, spec §6.1): proof
      // the cancel was processed server-side and the download state was torn
      // down.
      await waitFor(
        () => {
          const agentLog = agents.map((a) => a.output()).join('\n');
          return agentLog.includes('files transfer cancelled');
        },
        'the agent to log the cancel',
        10_000,
      );

      // The cancel stops the pump: the initial WINDOW (indices 0..15) plus at
      // most the one chunk the pre-cancel ack freed (index 16) may arrive — the
      // ack and the cancel are distinct frames in the serial session loop, so
      // an ack processed before the cancel can release one extra chunk. What
      // must NEVER appear are indices >= WINDOW+1 (17, 18): those only exist if
      // the pump kept running past the cancel, which the cancel precludes. The
      // 19-chunk (600 KiB) file is thus never fully delivered on a cancelled
      // transfer — the structural pin, independent of SCTP drain timing.
      await delay(2_000);
      const beyondWindow = frames.filter(
        (f) =>
          f.type === 'files-download-chunk' &&
          (f.payload as unknown as FileChunkMessage).transferId ===
            transferId &&
          (f.payload as unknown as FileChunkMessage).chunkIndex >= WINDOW + 1,
      );
      expect(beyondWindow).toHaveLength(0);

      // The agent logged the cancel at info level (spec §6.1).
      const agentLog = agents.map((a) => a.output()).join('\n');
      expect(agentLog).toContain('files transfer cancelled');

      // Fail-soft: the session still serves a fresh list (spec §2.6).
      const requestId = crypto.randomUUID();
      send('files-list', { requestId, path: '' } satisfies FilesListRequest);
      const result = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-list-result' &&
            (f.payload as unknown as FilesListResult).requestId === requestId,
          'a files-list-result after the cancel',
        )
      ).payload as unknown as FilesListResult;
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses paths outside the root with PATH_OUTSIDE_ROOT', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const cases = [
        { path: '../outside/secret.txt', label: 'a .. escape' },
        { path: '..', label: 'a bare ..' },
        { path: '/etc/passwd', label: 'an absolute path' },
      ];
      for (const { path, label } of cases) {
        const transferId = crypto.randomUUID();
        send('files-download', {
          transferId,
          path,
        } satisfies FilesDownloadRequest);
        const error = (
          await waitForFilesFrame(
            frames,
            (f) =>
              f.type === 'files-error' &&
              (f.payload as unknown as FilesErrorMessage).transferId ===
                transferId,
            `files-error for ${label}`,
          )
        ).payload as unknown as FilesErrorMessage;
        // The refusal is the contract this E2E pins: an escape attempt must
        // produce a files-error and no bytes. Which code depends on the
        // spec's two readings — ADR-33 lists `..` among syntactically
        // rejected components (INVALID_PATH), while §6.4's contract table
        // resolves `a/../../etc/passwd` through canonicalize to
        // PATH_OUTSIDE_ROOT and pins absolute paths to INVALID_PATH. The
        // exact mapping is pinned by the Rust unit tests (Task 4); here both
        // refusal codes are accepted so the suite does not encode one
        // reading of that tension.
        expect(['PATH_OUTSIDE_ROOT', 'INVALID_PATH']).toContain(
          error.code as FilesErrorCode,
        );
      }
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses the offer when the gate is closed', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });
    // No --files-root: the gate is closed (ADR-32).
    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    let refused = false;
    try {
      await openFilesPeer(
        new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toContain(
      'refused: files root not configured or unusable',
    );
  }, 90_000);

  it('refuses an upload onto an existing name with FILE_EXISTS and leaves it untouched', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const before = readFileSync(join(rootDir, 'notes.txt'));
      const transferId = crypto.randomUUID();
      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'notes.txt',
        size: 4,
      } satisfies FilesUploadBeginRequest);

      const error = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-error' &&
            (f.payload as unknown as FilesErrorMessage).transferId ===
              transferId,
          'files-error for the overwrite attempt',
        )
      ).payload as unknown as FilesErrorMessage;
      expect(error.code).toBe('FILE_EXISTS');

      expect(
        Buffer.compare(readFileSync(join(rootDir, 'notes.txt')), before),
      ).toBe(0);
      expect(existsSync(join(rootDir, 'notes.txt.ponter-part'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses a declared-oversize upload before any chunk with FILE_TOO_LARGE', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'huge.bin',
        size: 2 ** 30 + 1,
      } satisfies FilesUploadBeginRequest);

      const error = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-error' &&
            (f.payload as unknown as FilesErrorMessage).transferId ===
              transferId,
          'files-error for the oversize upload',
        )
      ).payload as unknown as FilesErrorMessage;
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(existsSync(join(rootDir, 'huge.bin.ponter-part'))).toBe(false);
      expect(existsSync(join(rootDir, 'huge.bin'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
