import { setTimeout as delay } from 'node:timers/promises';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PeerConnection } from '../../src/connection';
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
  waitForBinaryFrame,
  packBinary,
  unpackBinary,
  sendRaw,
  type FilesFrame,
  FILE_CHUNK_BYTES,
  WINDOW,
  sha256Hex,
  assembleDownload,
  drainDownload,
} from './harness';
import type {
  FilesAckMessage,
  FilesDownloadBegin,
  FilesDownloadRequest,
  FilesPauseAckMessage,
  FilesPauseMessage,
  FilesResumeAckMessage,
  FilesResumeRequest,
  FilesUploadBeginRequest,
  FilesUploadEndRequest,
  FilesActionResult,
  FilesMkdirRequest,
  FilesDeleteRequest,
  FilesRenameRequest,
} from '@ponter/shared';
import {
  BINARY_HEADER_LEN,
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
} from '@ponter/shared';

/**
 * Layer 3 advanced E2E: the Week 11 file-transfer features against the real
 * Rust agent over werift.
 *
 * Covers (per the brief + controller rulings):
 * 1. Binary framing byte-level integrity (25-byte header + UUID dash framing).
 * 2. Large-file download (3 MiB / 96 chunks) byte-for-byte, exercising the
 *    64-chunk window.
 * 3. Sustained download throughput > 10 MB/s on the 3 MiB transfer — records
 *    the REAL measured MB/s and FAIL if it doesn't hold.
 * 4. Pause + resume for upload (offset continuity, `.part` retained) and
 *    download (resume pumps chunks).
 * 5. Sandboxed directory operations (mkdir/rename/delete) including the
 *    escape-refusal path.
 *
 * This suite mirrors the wire codec LOCALLY and never imports
 * `packages/file-core` (browser-oriented) or any Vue/Pinia store.
 */
describe.skipIf(!isLinux)('files advanced E2E', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    await setupE2E();
    const parent = mkdtempSync(join(tmpdir(), 'ponter-files-adv-'));
    rootDir = join(parent, 'root');
    outsideDir = join(parent, 'outside');
    mkdirSync(rootDir);
    mkdirSync(outsideDir);
    // A small file for mkdir/rename/delete exercises.
    writeFileSync(join(rootDir, 'seed.txt'), 'seed\n');
    // The escape target lives OUTSIDE the root.
    writeFileSync(join(outsideDir, 'escape.txt'), 'escape\n');
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
    binaryFrames: Uint8Array[];
    offerer: PeerConnection;
    send: (type: string, payload: unknown) => void;
    sendRawChunk: (
      type: number,
      transferId: string,
      chunkIndex: number,
      data: Uint8Array,
    ) => void;
  }> {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });
    spawnAgent(agentId, credential, ['--files-root', rootDir]);
    await waitForAgentOnline(token, agentId);
    const { offerer, frames, binaryFrames } = await openFilesPeer(
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
    );
    return {
      token,
      agentId,
      sessionId,
      frames,
      binaryFrames,
      offerer,
      send: (type, payload) =>
        offerer.dataChannels.sendJson('files', type, payload),
      sendRawChunk: (type, transferId, chunkIndex, data) =>
        sendRaw(offerer, packBinary(type, transferId, chunkIndex, data)),
    };
  }

  it('binary framing: header fields exact, payload length exact, UUID round-trips', async () => {
    // Seed a file whose payload length is not a multiple of the chunk size so
    // the last chunk exercises the remainder branch.
    const { offerer, frames, binaryFrames, send } = await connectFilesAgent();
    try {
      // 1000 bytes ⇒ 1 chunk (remainder, 1000 bytes, not a full 32768).
      const name = 'f1000.bin';
      const payload = Buffer.alloc(1000);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 256;
      writeFileSync(join(rootDir, name), payload);

      const transferId = crypto.randomUUID();
      const uuidHex = transferId.replace(/-/g, '');
      const expectedWireId = Buffer.from(uuidHex, 'hex');

      send('files-download', {
        transferId,
        path: name,
      } satisfies FilesDownloadRequest);

      const begin = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-download-begin' &&
            (f.payload as unknown as FilesDownloadBegin).transferId ===
              transferId,
          'files-download-begin',
        )
      ).payload as unknown as FilesDownloadBegin;
      expect(begin.totalChunks).toBe(1);

      await waitForBinaryFrame(
        binaryFrames,
        (f) => {
          const d = unpackBinary(f);
          return (
            d.type === BINARY_TYPE_DOWNLOAD_CHUNK &&
            d.transferId === transferId &&
            d.chunkIndex === 0
          );
        },
        'a binary download chunk for the first (only) chunk',
      );

      // Ack the single chunk so the agent emits files-download-end.
      send('files-download-ack', {
        transferId,
        nextChunkIndex: 1,
      } satisfies FilesAckMessage);

      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-download-end' &&
          (f.payload as unknown as { transferId: string }).transferId ===
            transferId,
        'files-download-end',
      );

      // Byte-level integrity of the captured binary frame.
      const chunkFrame = binaryFrames.find((f) => {
        const d = unpackBinary(f);
        return (
          d.type === BINARY_TYPE_DOWNLOAD_CHUNK &&
          d.transferId === transferId &&
          d.chunkIndex === 0
        );
      });
      expect(chunkFrame).toBeDefined();
      const raw = chunkFrame!;

      // (a) Header length is exactly 25.
      expect(raw.length).toBe(BINARY_HEADER_LEN + payload.length);

      // (b) Type byte is 0x01 (download chunk).
      expect(raw[0]).toBe(BINARY_TYPE_DOWNLOAD_CHUNK);

      // (c) The 16 wire bytes equal the dashed UUID with dashes stripped and
      // hex-decoded.
      expect(Buffer.from(raw.slice(1, 17))).toEqual(expectedWireId);

      // (d) The 8-byte big-endian chunk index is 0.
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      expect(Number(view.getBigUint64(17, false))).toBe(0);

      // (e) Payload length equals the remainder (1000), not the full chunk cap.
      expect(raw.length - BINARY_HEADER_LEN).toBe(1000);

      // (f) Payload bytes match the seeded content.
      expect(
        Buffer.compare(Buffer.from(raw.slice(BINARY_HEADER_LEN)), payload),
      ).toBe(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('large-file download (3 MiB / 96 chunks) is byte-for-byte and exceeds the window', async () => {
    const { offerer, frames, binaryFrames, send } = await connectFilesAgent();
    try {
      // Seed a 3 MiB file: 96 chunks (3 MiB / 32768 = 96 exactly), which is
      // > WINDOW (64) so the window boundary is exercised.
      const name = 'big.bin';
      const size = 3 * 1024 * 1024;
      const payload = Buffer.alloc(size);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
      writeFileSync(join(rootDir, name), payload);

      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: name,
      } satisfies FilesDownloadRequest);

      const begin = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-download-begin' &&
            (f.payload as unknown as FilesDownloadBegin).transferId ===
              transferId,
          'files-download-begin',
        )
      ).payload as unknown as FilesDownloadBegin;
      const totalChunks = Math.ceil(size / FILE_CHUNK_BYTES);
      expect(begin.totalChunks).toBe(totalChunks);
      expect(totalChunks).toBe(WINDOW + 32); // 96 > 64, window is exercised

      await drainDownload(
        binaryFrames,
        transferId,
        totalChunks,
        (nextChunkIndex) =>
          send('files-download-ack', {
            transferId,
            nextChunkIndex,
          } satisfies FilesAckMessage),
      );

      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-download-end' &&
          (f.payload as unknown as { transferId: string }).transferId ===
            transferId,
        'files-download-end',
      );

      const assembled = assembleDownload(binaryFrames, transferId);
      expect(assembled.length).toBe(size);
      // SHA-256 equality, not just Buffer.compare, per the brief's
      // "byte-level integrity" contract.
      expect(sha256Hex(assembled)).toBe(sha256Hex(payload));
    } finally {
      await offerer.close();
    }
  }, 120_000);

  it('sustained download throughput > 10 MB/s on a 50 MiB transfer', async () => {
    const { offerer, frames, binaryFrames, send } = await connectFilesAgent();
    try {
      // 50 MiB = 1600 chunks (> WINDOW so the pump pauses for acks). The brief
      // names this the "spec scale" transfer. The controller's hard rule: never
      // fabricate the number — assert > 10 MB/s and FAIL if this machine can't
      // sustain it on loopback.
      const name = 'throughput.bin';
      const size = 50 * 1024 * 1024;
      const payload = Buffer.alloc(size);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
      writeFileSync(join(rootDir, name), payload);

      const transferId = crypto.randomUUID();
      const start = process.hrtime.bigint();

      send('files-download', {
        transferId,
        path: name,
      } satisfies FilesDownloadRequest);

      const begin = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-download-begin' &&
            (f.payload as unknown as FilesDownloadBegin).transferId ===
              transferId,
          'files-download-begin',
        )
      ).payload as unknown as FilesDownloadBegin;
      const totalChunks = begin.totalChunks;

      // Tight drain loop: ack by contiguous count. Track a cursor so we only
      // unpack each frame once, and only re-ack when the contiguous frontier
      // advances (avoids re-sending the same ack every iteration).
      const deadline = Date.now() + 120_000;
      const chunks = new Set<number>();
      let cursor = 0;
      let lastAcked = 0;
      while (chunks.size < totalChunks && Date.now() < deadline) {
        for (let i = cursor; i < binaryFrames.length; i++) {
          const frame = binaryFrames[i];
          if (!frame) continue;
          const decoded = unpackBinary(frame);
          if (
            decoded.type === BINARY_TYPE_DOWNLOAD_CHUNK &&
            decoded.transferId === transferId
          ) {
            chunks.add(decoded.chunkIndex);
          }
        }
        cursor = binaryFrames.length;
        let contiguous = 0;
        while (chunks.has(contiguous)) contiguous++;
        if (contiguous > lastAcked) {
          lastAcked = contiguous;
          send('files-download-ack', {
            transferId,
            nextChunkIndex: contiguous,
          } satisfies FilesAckMessage);
        }
        if (chunks.size < totalChunks) await delay(0);
      }
      expect(chunks.size).toBe(totalChunks);

      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-download-end' &&
          (f.payload as unknown as { transferId: string }).transferId ===
            transferId,
        'files-download-end',
      );

      const end = process.hrtime.bigint();
      const elapsedNs = Number(end - start);
      const elapsedSec = elapsedNs / 1_000_000_000;
      const mbps = size / (1024 * 1024) / elapsedSec;

      // Integrity check (SHA-256 of the reassembled payload).
      const assembled = assembleDownload(binaryFrames, transferId);
      expect(sha256Hex(assembled)).toBe(sha256Hex(payload));

      expect(mbps).toBeGreaterThan(10);
    } finally {
      await offerer.close();
    }
  }, 180_000);

  it('pause + resume upload: .part retained, offset continuity, completes after resume', async () => {
    const { offerer, frames, send, sendRawChunk } = await connectFilesAgent();
    try {
      // 2 chunks (65536 bytes) so we can pause mid-stream.
      const transferId = crypto.randomUUID();
      const name = 'paused-up.bin';
      const size = 2 * FILE_CHUNK_BYTES;
      const payload = Buffer.alloc(size);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 5) % 256;

      send('files-upload-begin', {
        transferId,
        path: '',
        name,
        size,
      } satisfies FilesUploadBeginRequest);

      // First ack (nextChunkIndex: 0).
      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-upload-ack' &&
          (f.payload as unknown as FilesAckMessage).transferId === transferId,
        'files-upload-ack after begin',
      );

      // Send chunk 0 only, then pause.
      sendRawChunk(
        BINARY_TYPE_UPLOAD_CHUNK,
        transferId,
        0,
        new Uint8Array(payload.subarray(0, FILE_CHUNK_BYTES)),
      );
      // Wait for ack to advance past chunk 0 (ADR-37 batching may delay it).
      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-upload-ack' &&
          (f.payload as unknown as FilesAckMessage).transferId === transferId &&
          (f.payload as unknown as FilesAckMessage).nextChunkIndex >= 1,
        'files-upload-ack { nextChunkIndex >= 1 }',
      );

      // Pause the upload.
      const pauseReq: FilesPauseMessage = { transferId, direction: 'upload' };
      send('files-pause', pauseReq);
      const pauseAck = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-pause-ack' &&
            (f.payload as unknown as FilesPauseAckMessage).transferId ===
              transferId,
          'files-pause-ack',
        )
      ).payload as unknown as FilesPauseAckMessage;
      // The pause ack reports the resume point (acked chunk index). After one
      // chunk it should be 1.
      expect(pauseAck.ackedChunkIndex).toBe(1);

      // The .part must still be on disk (pause retains it).
      expect(existsSync(join(rootDir, `${name}.ponter-part`))).toBe(true);
      const partSize = statSync(join(rootDir, `${name}.ponter-part`)).size;
      expect(partSize).toBe(FILE_CHUNK_BYTES); // exactly one chunk written

      // Resume from chunk 1 (the next contiguous offset).
      const resumeReq: FilesResumeRequest = {
        transferId,
        path: '',
        direction: 'upload',
        fromChunkIndex: 1,
      };
      send('files-resume', resumeReq);
      const resumeAck = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-resume-ack' &&
            (f.payload as unknown as FilesResumeAckMessage).transferId ===
              transferId,
          'files-resume-ack',
        )
      ).payload as unknown as FilesResumeAckMessage;
      expect(resumeAck.approved).toBe(true);
      expect(resumeAck.fromChunkIndex).toBe(1);

      // Send the second chunk; it lands after the resumed offset.
      sendRawChunk(
        BINARY_TYPE_UPLOAD_CHUNK,
        transferId,
        1,
        new Uint8Array(payload.subarray(FILE_CHUNK_BYTES)),
      );
      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-upload-ack' &&
          (f.payload as unknown as FilesAckMessage).transferId === transferId &&
          (f.payload as unknown as FilesAckMessage).nextChunkIndex >= 2,
        'files-upload-ack { nextChunkIndex >= 2 }',
      );

      // End the upload.
      send('files-upload-end', { transferId } satisfies FilesUploadEndRequest);
      const complete = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-upload-complete' &&
            (f.payload as unknown as { transferId: string }).transferId ===
              transferId,
          'files-upload-complete',
        )
      ).payload as unknown as {
        transferId: string;
        name: string;
        size: number;
      };
      expect(complete.name).toBe(name);
      expect(complete.size).toBe(size);

      // The final file matches the payload byte-for-byte and no .part remains.
      expect(Buffer.compare(readFileSync(join(rootDir, name)), payload)).toBe(
        0,
      );
      expect(sha256Hex(readFileSync(join(rootDir, name)))).toBe(
        sha256Hex(payload),
      );
      expect(existsSync(join(rootDir, `${name}.ponter-part`))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('pause + resume download: resume pumps chunks from the offset', async () => {
    const { offerer, frames, binaryFrames, send } = await connectFilesAgent();
    try {
      const name = 'paused-down.bin';
      const size = 4 * FILE_CHUNK_BYTES; // 4 chunks
      const payload = Buffer.alloc(size);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 13) % 256;
      writeFileSync(join(rootDir, name), payload);

      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: name,
      } satisfies FilesDownloadRequest);

      const begin = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-download-begin' &&
            (f.payload as unknown as FilesDownloadBegin).transferId ===
              transferId,
          'files-download-begin',
        )
      ).payload as unknown as FilesDownloadBegin;
      expect(begin.totalChunks).toBe(4);

      // Let the initial window (all 4 chunks, since 4 < 64) land, then pause
      // after acking 2.
      await waitForBinaryFrame(
        binaryFrames,
        (f) => {
          const d = unpackBinary(f);
          return (
            d.type === BINARY_TYPE_DOWNLOAD_CHUNK &&
            d.transferId === transferId &&
            d.chunkIndex === 1
          );
        },
        'two download chunks landed',
      );
      send('files-download-ack', {
        transferId,
        nextChunkIndex: 2,
      } satisfies FilesAckMessage);

      // Pause the download.
      const pauseReq: FilesPauseMessage = { transferId, direction: 'download' };
      send('files-pause', pauseReq);
      const pauseAck = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-pause-ack' &&
            (f.payload as unknown as FilesPauseAckMessage).transferId ===
              transferId,
          'files-pause-ack for download',
        )
      ).payload as unknown as FilesPauseAckMessage;
      expect(pauseAck.ackedChunkIndex).toBe(2);

      // Resume from chunk 2; the agent should immediately pump resumed chunks.
      const resumeReq: FilesResumeRequest = {
        transferId,
        path: name,
        direction: 'download',
        fromChunkIndex: 2,
      };
      send('files-resume', resumeReq);
      const resumeAck = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-resume-ack' &&
            (f.payload as unknown as FilesResumeAckMessage).transferId ===
              transferId,
          'files-resume-ack for download',
        )
      ).payload as unknown as FilesResumeAckMessage;
      expect(resumeAck.approved).toBe(true);
      expect(resumeAck.fromChunkIndex).toBe(2);

      // Drain the rest (chunks 2 and 3).
      await drainDownload(binaryFrames, transferId, 4, (nextChunkIndex) =>
        send('files-download-ack', {
          transferId,
          nextChunkIndex,
        } satisfies FilesAckMessage),
      );

      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-download-end' &&
          (f.payload as unknown as { transferId: string }).transferId ===
            transferId,
        'files-download-end',
      );

      const assembled = assembleDownload(binaryFrames, transferId);
      expect(sha256Hex(assembled)).toBe(sha256Hex(payload));
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('sandboxed mkdir / rename / delete succeed inside the root', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      // mkdir
      const mkdirId = crypto.randomUUID();
      send('files-mkdir', {
        requestId: mkdirId,
        dir: '',
        name: 'sub',
      } satisfies FilesMkdirRequest);
      const mkdirResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId === mkdirId,
          'files-action-result for mkdir',
        )
      ).payload as unknown as FilesActionResult;
      expect(mkdirResult.action).toBe('mkdir');
      expect(mkdirResult.success).toBe(true);
      expect(existsSync(join(rootDir, 'sub'))).toBe(true);

      // rename a file into the new subdir
      const renameId = crypto.randomUUID();
      send('files-rename', {
        requestId: renameId,
        oldPath: 'seed.txt',
        newPath: 'sub/seed.txt',
      } satisfies FilesRenameRequest);
      const renameResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId === renameId,
          'files-action-result for rename',
        )
      ).payload as unknown as FilesActionResult;
      expect(renameResult.action).toBe('rename');
      expect(renameResult.success).toBe(true);
      expect(existsSync(join(rootDir, 'sub', 'seed.txt'))).toBe(true);
      expect(existsSync(join(rootDir, 'seed.txt'))).toBe(false);

      // delete the renamed file
      const deleteId = crypto.randomUUID();
      send('files-delete', {
        requestId: deleteId,
        path: 'sub/seed.txt',
      } satisfies FilesDeleteRequest);
      const deleteResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId === deleteId,
          'files-action-result for delete',
        )
      ).payload as unknown as FilesActionResult;
      expect(deleteResult.action).toBe('delete');
      expect(deleteResult.success).toBe(true);
      expect(existsSync(join(rootDir, 'sub', 'seed.txt'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('sandboxed directory ops refuse escapes with success:false', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      // mkdir with an escaping name.
      const mkdirId = crypto.randomUUID();
      send('files-mkdir', {
        requestId: mkdirId,
        dir: '',
        name: '../evil',
      } satisfies FilesMkdirRequest);
      const mkdirResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId === mkdirId,
          'files-action-result for mkdir escape',
        )
      ).payload as unknown as FilesActionResult;
      expect(mkdirResult.success).toBe(false);
      expect(mkdirResult.error).toBeDefined();

      // rename destination escaping the root.
      const renameId = crypto.randomUUID();
      send('files-rename', {
        requestId: renameId,
        oldPath: 'seed.txt',
        newPath: '../outside/renamed.txt',
      } satisfies FilesRenameRequest);
      const renameResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId === renameId,
          'files-action-result for rename escape',
        )
      ).payload as unknown as FilesActionResult;
      expect(renameResult.success).toBe(false);

      // rename destination already existing ⇒ FILE_EXISTS code substring.
      const existingId = crypto.randomUUID();
      writeFileSync(join(rootDir, 'dup.bin'), Buffer.alloc(1));
      writeFileSync(join(rootDir, 'target.bin'), Buffer.alloc(1));
      send('files-rename', {
        requestId: existingId,
        oldPath: 'dup.bin',
        newPath: 'target.bin',
      } satisfies FilesRenameRequest);
      const existingResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId ===
              existingId,
          'files-action-result for rename-collision',
        )
      ).payload as unknown as FilesActionResult;
      expect(existingResult.success).toBe(false);
      // Assert on the code substring, not the brittle full message.
      expect(existingResult.error).toMatch(/FILE_EXISTS/);

      // delete of the sandbox root ⇒ PERMISSION_DENIED.
      const rootDeleteId = crypto.randomUUID();
      send('files-delete', {
        requestId: rootDeleteId,
        path: '',
      } satisfies FilesDeleteRequest);
      const rootDeleteResult = (
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-action-result' &&
            (f.payload as unknown as FilesActionResult).requestId ===
              rootDeleteId,
          'files-action-result for root delete',
        )
      ).payload as unknown as FilesActionResult;
      expect(rootDeleteResult.success).toBe(false);
      expect(rootDeleteResult.error).toMatch(/PERMISSION_DENIED/);
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
