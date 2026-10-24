// apps/agent/src/files/session.ts
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { FilesErrorCode } from '@ponter/shared';
import { SandboxError, errnoToCode } from './sandbox.js';
import type { FilesRoot } from './sandbox.js';
import {
  ACK_FLUSH_INTERVAL_MS,
  ACK_FREQUENCY_CHUNKS,
  FILE_MAX_BYTES,
  FILE_WINDOW_CHUNKS,
  FILES_IDLE_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  decodeUploadChunk,
  encodeDownloadChunk,
  expectedChunkLen,
  partName,
  rfc3339Utc,
  totalChunks,
} from './protocol.js';
import type { FilesFrame } from './protocol.js';

/**
 * Re-exported because the frame union is part of this module's *own* public
 * surface too: every method here returns `FilesFrame[]`, and the tests import
 * it from `session.js`. The declaration lives in `protocol.ts` because
 * `frameFiles` depends on it; this line keeps the import site unchanged.
 */
export type { FilesFrame };

export { FILES_IDLE_TIMEOUT_MS };

/**
 * The wire shape of one entry, exactly `RemoteFile` from
 * `packages/shared/src/types/files.ts:6-13`. Declared here rather than
 * imported so `apps/agent` does not depend on the browser's package; the two
 * must stay identical and `files.e2e.test.ts` is what catches a drift.
 */
export interface RemoteFileWire {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

/**
 * The twelve browser→agent shapes, in the Rust's own order
 * (`FilesInbound`, `files.rs:489-504`).
 *
 * This list is the **decode** boundary, and it exists as a value because the
 * alternative — twelve `case` labels with no enumeration anywhere — is exactly
 * how the Rust ended up testing 7 of its 12 arms: `decode_round_trips_every_
 * browser_to_agent_type` named the enumeration in its title and covered list,
 * download, upload-begin, upload-chunk, upload-end, cancel and download-ack,
 * omitting `mkdir`, `rename`, `delete`, `pause` and `resume`. Two of the five
 * it omitted are the two the port read the wrong field names for.
 */
export const FILES_INBOUND_TYPES = [
  'files-list',
  'files-download',
  'files-download-ack',
  'files-upload-begin',
  'files-upload-chunk',
  'files-upload-end',
  'files-pause',
  'files-resume',
  'files-cancel',
  'files-mkdir',
  'files-delete',
  'files-rename',
] as const;

export type FilesInboundType = (typeof FILES_INBOUND_TYPES)[number];

const INBOUND = new Set<string>(FILES_INBOUND_TYPES);

/**
 * The three arms whose failures answer on `files-action-result`. Kept beside
 * the decode list because both are claims about the same twelve names, and a
 * reader checking one should not have to hunt for the other.
 */
const ACTION_TYPES = new Set<string>([
  'files-mkdir',
  'files-delete',
  'files-rename',
]);

/**
 * The inbound decode step, and the only way into `dispatch`.
 *
 * Returning `null` for an unrecognised `type` is the whole contract: `dispatch`
 * switches on the *decoded* discriminant, so a type this function rejects
 * cannot reach an arm. Routing dispatch through the decoder rather than
 * testing them separately is what makes the decode test evidence about
 * dispatch — a test that called a decoder nothing used would prove the decoder
 * knows twelve names and nothing else.
 */
export function decodeFilesFrame(message: {
  type: string;
  [key: string]: unknown;
}): ({ type: FilesInboundType } & { [key: string]: unknown }) | null {
  if (!INBOUND.has(message.type)) return null;
  return message as { type: FilesInboundType } & { [key: string]: unknown };
}

/**
 * Resume requires the `.part` length to equal the resume offset **exactly**.
 * No truncation and no tolerance: a `.part` that is a byte short would leave a
 * hole that `write+append` can never fill, and a byte long would silently
 * duplicate a byte into the finished file.
 */
export function resumeOffsetMatches(
  partBytes: number,
  fromChunkIndex: number,
): boolean {
  return partBytes === fromChunkIndex * 32_768;
}

interface DownloadState {
  transferId: string;
  sent: number;
  acked: number;
  total: number;
  size: number;
  buffer: Buffer;
  paused: boolean;
  deadline: number;
}

interface UploadState {
  transferId: string;
  nextChunk: number;
  written: number;
  total: number;
  size: number;
  partPath: string;
  destPath: string;
  /**
   * The destination as the **wire** spells it, sandbox-relative and
   * `''`-joined — the Rust's `UploadState::dest_rel` (`files.rs:1095-1096`,
   * built by `join_rel`). `files-upload-complete.path` carries this one; the
   * absolute `destPath` stays host-side.
   */
  destRel: string;
  lastAcked: number;
  pendingAck: number | null;
  lastAckAt: number;
  paused: boolean;
  deadline: number;
}

/**
 * One session's file transfers (B42/B43/B45/B46).
 *
 * Two shape decisions worth stating:
 *
 * - **One slot per direction, and the window applies to downloads only.** The
 *   Rust gated only `DownloadState`; uploads are ungated because the browser is
 *   the trusted side and a gate there would need a browser-side counterpart —
 *   a protocol change, not a port.
 * - **The window is 64 chunks, not 16.** A stale comment in the Rust said 16;
 *   the constant, the gate and four tests all said 64. The code wins.
 *
 * Every rejection is a frame, never a throw out of `handle`: a bad path must not
 * end the session, which is exactly what "fail-soft" means here.
 */
export class FilesSession {
  private download: DownloadState | null = null;
  private upload: UploadState | null = null;

  constructor(
    private readonly root: FilesRoot,
    private readonly now: () => number,
  ) {}

  handle(message: { type: string; [key: string]: unknown }): FilesFrame[] {
    // The decode step is the gate, not a sibling of `dispatch`: a type outside
    // the twelve never reaches a `case`. Returning `[]` rather than throwing
    // keeps the Rust's behaviour — an unknown `type` is dropped by the
    // dispatcher's `_ =>` arm, not turned into an error frame.
    const decoded = decodeFilesFrame(message);
    if (decoded === null) return [];
    try {
      return this.dispatch(decoded);
    } catch (error) {
      const code =
        error instanceof SandboxError ? error.code : errnoToCode(error);
      // **R10: the failure path, stated in one place.** The three actions
      // answer on `files-action-result` with `success: false`; everything else
      // (list, transfer lifecycle) answers on `files-error`. Routing action
      // failures through `files-error` — which is what the plan did — sends an
      // unchecked code to a frame that does not validate it (see
      // `actionFailure`).
      if (ACTION_TYPES.has(message.type))
        return [this.actionFailure(message, code)];
      return [this.errorFrame(message, code, (error as Error).message)];
    }
  }

  /** Called from a 1 s tick. */
  checkIdle(): FilesFrame[] {
    const now = this.now();
    const out: FilesFrame[] = [];
    if (
      this.download &&
      !this.download.paused &&
      this.download.deadline <= now
    ) {
      out.push({
        type: 'files-error',
        transferId: this.download.transferId,
        code: 'TRANSFER_TIMEOUT',
        message: 'transfer timed out',
      });
      this.download = null;
    }
    if (this.upload && !this.upload.paused && this.upload.deadline <= now) {
      const { transferId } = this.upload;
      this.discardUpload(this.upload);
      this.upload = null;
      // `timeout_frame("upload", &state.transfer_id)` in the Rust
      // (`files.rs:1259-1270`) sets the id on both directions. Without it the
      // browser's transfer promise never settles: `packages/file-core` only
      // clears a transfer when the frame carries the id it is waiting on.
      out.push({
        type: 'files-error',
        transferId,
        code: 'TRANSFER_TIMEOUT',
        message: 'transfer timed out',
      });
    }
    return out;
  }

  /**
   * **R7: `noteChunk()` returns the predicate; `takePendingAck()` takes
   * unconditionally; `flushAcks()` re-applies no gate.**
   *
   * The Rust separates **when** from **what**: `note_chunk()` returns the
   * predicate (`files.rs:1165-1172`), `take_pending_ack()` takes
   * unconditionally (`:1173-1180`), the chunk path uses `if`
   * (`:1651-1656`) and the tick path takes unconditionally
   * (`:1717-1719`). The plan collapsed both into one `pendingAckFrame()`, so
   * `flushAcks()` re-evaluated the gate the chunk path had just evaluated —
   * a decorative 20 ms tick that could not change anything. Worse, the
   * collapse makes one case **impossible to express**: a chunk that is due on
   * the frequency rule but not on the interval rule, or the reverse. With the
   * split, the chunk path flushes when the predicate says so and the tick
   * flushes whatever is pending regardless.
   *
   * Both paths read the **same injected clock**. The Rust used monotonic
   * `elapsed()`; the port injects `now()` and keeps it injected — a real timer
   * here would make the ack tests sleep and would put a production clock
   * inside a class whose whole design is that time is a parameter.
   */
  private noteChunk(): boolean {
    const state = this.upload;
    if (!state) return false;
    state.pendingAck = state.nextChunk;
    return (
      state.pendingAck - state.lastAcked >= ACK_FREQUENCY_CHUNKS ||
      this.now() - state.lastAckAt >= ACK_FLUSH_INTERVAL_MS
    );
  }

  /** Takes whatever is pending, with **no** gate. Called from the 20 ms tick. */
  private takePendingAck(): FilesFrame[] {
    const state = this.upload;
    if (!state || state.pendingAck === null) return [];
    const nextChunkIndex = state.pendingAck;
    state.lastAcked = nextChunkIndex;
    state.pendingAck = null;
    state.lastAckAt = this.now();
    return [
      {
        type: 'files-upload-ack',
        transferId: state.transferId,
        nextChunkIndex,
      },
    ];
  }

  /** Called from a 20 ms tick so a low-rate upload still acks promptly. */
  flushAcks(): FilesFrame[] {
    return this.takePendingAck();
  }

  private dispatch(message: {
    type: FilesInboundType;
    [key: string]: unknown;
  }): FilesFrame[] {
    switch (message.type) {
      case 'files-list':
        return this.list(message);
      case 'files-download':
        return this.startDownload(message);
      case 'files-download-ack':
        return this.ackDownload(message);
      case 'files-upload-begin':
        return this.beginUpload(message);
      case 'files-upload-chunk':
        return this.chunkUpload(message);
      case 'files-upload-end':
        return this.endUpload(message);
      case 'files-pause':
        return this.pause(message);
      case 'files-resume':
        return this.resume(message);
      case 'files-cancel':
        this.cancel(message);
        return [];
      case 'files-mkdir':
        return this.mkdir(message);
      case 'files-delete':
        return this.remove(message);
      case 'files-rename':
        return this.rename(message);
      default:
        return [];
    }
  }

  private errorFrame(
    message: { [key: string]: unknown },
    code: string,
    text: string,
  ): FilesFrame {
    return {
      type: 'files-error',
      ...(typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      ...(typeof message.transferId === 'string'
        ? { transferId: message.transferId }
        : {}),
      code,
      message: text,
    };
  }

  /**
   * `MAX_LIST_ENTRIES` truncates **and sets `truncated`**, rather than refusing.
   * A directory with 4 096 entries is normal; refusing to list it would make the
   * browser's file manager unusable on exactly the machines people use for file
   * transfer. The flag is what stops the UI claiming it showed everything.
   *
   * The wire shape is `RemoteFile` (`packages/shared/src/types/files.ts:6-13`,
   * unchanged since Week 10): `{name, path, size, isDirectory, modifiedAt}`.
   * Every field is carried through, not renamed — `apps/web`'s FilesView reads
   * `isDirectory`, `path` and `modifiedAt` directly, and
   * `packages/webrtc-core/test/e2e/files.e2e.test.ts:123,127` asserts
   * `isDirectory`.
   */
  private list(message: { [key: string]: unknown }): FilesFrame[] {
    const rel = String(message.path ?? '');
    const path = this.root.resolveExisting(rel);
    // A file where a directory was expected is NOT_A_DIRECTORY; other failures
    // are IO_ERROR. `readdirSync` is the call that raises it, so the mapping
    // happens here rather than in `handle()`'s generic catch.
    let names: Dirent[];
    try {
      names = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `listing \`${rel}\``);
    }
    const entries: RemoteFileWire[] = names.map((entry) => {
      // A per-entry stat failure fails the whole list (spec §6.1): a
      // half-listed directory is worse than an error.
      const stat = statSync(join(path, entry.name));
      // `metadata.len()` is a real number for a directory too — the wire type
      // declares `size: number`, not `number | null`.
      return {
        name: entry.name,
        path: rel === '' ? entry.name : `${rel}/${entry.name}`,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modifiedAt: rfc3339Utc(stat.mtimeMs),
      };
    });
    // Deterministic order (spec §2.5): directories first, then name
    // byte-wise. Sort BEFORE truncating — `read_dir` order is arbitrary.
    entries.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        Buffer.compare(
          Buffer.from(a.name, 'utf8'),
          Buffer.from(b.name, 'utf8'),
        ),
    );
    const truncated = entries.length > MAX_LIST_ENTRIES;
    return [
      {
        type: 'files-list-result',
        requestId: message.requestId,
        path: rel,
        entries: entries.slice(0, MAX_LIST_ENTRIES),
        truncated,
      },
    ];
  }

  private startDownload(message: { [key: string]: unknown }): FilesFrame[] {
    const transferId = String(message.transferId);
    const resolved = this.root.resolveExisting(String(message.path ?? ''));
    const stat = statSync(resolved);
    if (stat.isDirectory()) throw new SandboxError('NOT_A_FILE', 'not a file');
    if (stat.size > FILE_MAX_BYTES)
      throw new SandboxError('FILE_TOO_LARGE', 'file too large');
    if (this.download)
      throw new SandboxError(
        'TRANSFER_BUSY',
        'a download is already in flight',
      );
    const total = totalChunks(stat.size);
    const out: FilesFrame[] = [
      {
        type: 'files-download-begin',
        transferId,
        name: resolved.split('/').pop(),
        path: String(message.path),
        size: stat.size,
        totalChunks: total,
      },
    ];
    if (total === 0) {
      out.push({ type: 'files-download-end', transferId });
      return out;
    }
    const state: DownloadState = {
      transferId,
      sent: 0,
      acked: 0,
      total,
      size: stat.size,
      buffer: readFileSync(resolved),
      paused: false,
      deadline: this.now() + FILES_IDLE_TIMEOUT_MS,
    };
    this.download = state;
    out.push(...this.pump(state));
    return out;
  }

  private pump(state: DownloadState): FilesFrame[] {
    const frames: FilesFrame[] = [];
    while (
      state.sent < state.total &&
      state.sent - state.acked < FILE_WINDOW_CHUNKS
    ) {
      const start = state.sent * 32_768;
      frames.push(
        encodeDownloadChunk(
          state.transferId,
          state.sent,
          state.buffer.subarray(
            start,
            start + expectedChunkLen(state.size, state.sent),
          ),
        ),
      );
      state.sent += 1;
    }
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    return frames;
  }

  private ackDownload(message: { [key: string]: unknown }): FilesFrame[] {
    const state = this.download;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such download');
    }
    const next = Number(message.nextChunkIndex);
    if (next > state.sent) {
      this.download = null;
      throw new SandboxError('BAD_FRAME', 'ack ahead of what was sent');
    }
    if (next <= state.acked) return [];
    state.acked = next;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    if (state.paused) return [];
    const frames = this.pump(state);
    if (state.acked >= state.total) {
      this.download = null;
      frames.push({ type: 'files-download-end', transferId: state.transferId });
    }
    return frames;
  }

  private beginUpload(message: { [key: string]: unknown }): FilesFrame[] {
    const size = Number(message.size);
    if (size > FILE_MAX_BYTES)
      throw new SandboxError('FILE_TOO_LARGE', 'file too large');
    if (this.upload)
      throw new SandboxError('TRANSFER_BUSY', 'an upload is already in flight');
    const name = String(message.name);
    const dirWire = String(message.path ?? '');
    const dest = this.root.resolveParentForCreate(dirWire, name);
    try {
      statSync(dest);
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    const partPath = partName(dest);
    try {
      closeSync(openSync(partPath, 'wx', 0o600));
    } catch {
      // A stale .part is removed once and retried once; a second failure is real.
      unlinkSync(partPath);
      closeSync(openSync(partPath, 'wx', 0o600));
    }
    const transferId = String(message.transferId);
    this.upload = {
      transferId,
      nextChunk: 0,
      written: 0,
      total: totalChunks(size),
      size,
      partPath,
      destPath: dest,
      // `join_rel` (`files.rs:2069-2075`): the wire path, not the host path.
      destRel: dirWire === '' ? name : `${dirWire}/${name}`,
      lastAcked: 0,
      pendingAck: null,
      lastAckAt: this.now(),
      paused: false,
      deadline: this.now() + FILES_IDLE_TIMEOUT_MS,
    };
    // **The begin is answered with the first cumulative ack** (`files.rs:1623-1627`,
    // spec §6.1). Not an optimisation: the browser's transfer pump is driven from
    // `onAck` alone (`packages/file-core/src/transfer.ts:164-177`), so a begin
    // that answers nothing means no chunk is ever sent and every upload hangs
    // until the 30 s idle timeout.
    return [{ type: 'files-upload-ack', transferId, nextChunkIndex: 0 }];
  }

  /**
   * `total` is `null` for the binary form, which carries no total: the JSON
   * `files-upload-chunk` repeats `totalChunks` on every chunk, the binary frame
   * has no room for it. Passing a sentinel (or `-1`) here and comparing anyway
   * would reject **every** binary chunk — the check must be skipped, not
   * satisfied.
   */
  private acceptChunk(
    transferId: string,
    chunkIndex: number,
    total: number | null,
    payload: Uint8Array,
  ): void {
    const state = this.upload;
    if (!state || state.transferId !== transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
    }
    if (total !== null && total !== state.total) {
      throw new SandboxError('BAD_FRAME', 'total chunk count changed');
    }
    if (chunkIndex !== state.nextChunk)
      throw new SandboxError('BAD_FRAME', 'chunk index out of order');
    if (payload.length !== expectedChunkLen(state.size, chunkIndex)) {
      throw new SandboxError('BAD_FRAME', 'chunk length does not match');
    }
    const fd = openSync(state.partPath, 'a');
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    state.nextChunk += 1;
    state.written += payload.length;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
  }

  private chunkUpload(message: { [key: string]: unknown }): FilesFrame[] {
    try {
      const payload = Buffer.from(String(message.data ?? ''), 'base64');
      this.acceptChunk(
        String(message.transferId),
        Number(message.chunkIndex),
        Number(message.totalChunks),
        payload,
      );
    } catch (error) {
      if (this.upload) this.discardUpload(this.upload);
      this.upload = null;
      throw error;
    }
    // R7: the chunk path evaluates the predicate and flushes only if it says
    // so. The tick path (`flushAcks`) does not re-ask.
    return this.noteChunk() ? this.takePendingAck() : [];
  }

  /** Called by the binary dispatcher for a `0x02` frame. */
  acceptBinaryChunk(frame: Uint8Array): FilesFrame[] {
    const decoded = decodeUploadChunk(frame);
    try {
      this.acceptChunk(
        decoded.transferId,
        decoded.chunkIndex,
        null,
        decoded.payload,
      );
    } catch (error) {
      if (this.upload) this.discardUpload(this.upload);
      this.upload = null;
      throw error;
    }
    return this.noteChunk() ? this.takePendingAck() : [];
  }

  private endUpload(message: { [key: string]: unknown }): FilesFrame[] {
    const state = this.upload;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
    }
    if (state.nextChunk !== state.total || state.written !== state.size) {
      this.discardUpload(state);
      this.upload = null;
      throw new SandboxError('BAD_FRAME', 'upload ended before the last chunk');
    }
    const fd = openSync(state.partPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    /**
     * `link` then `unlink`, not `rename`. `rename` would silently overwrite a
     * destination that appeared during the transfer — and the `FILE_EXISTS`
     * check happened at `beginUpload`, minutes earlier for a 1 GiB file. `link`
     * fails with `EEXIST` instead, which is the behaviour the Rust had and the
     * only one that cannot lose someone else's file.
     */
    try {
      linkSync(state.partPath, state.destPath);
    } catch {
      this.discardUpload(state);
      this.upload = null;
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    }
    unlinkSync(state.partPath);
    this.upload = null;
    /**
     * **R8: the final ack precedes the complete frame, in that order.**
     *
     * The Rust returns `vec![final_ack, complete]` (`files.rs:1734`); the plan
     * returned complete only. The order is the contract, not a convenience:
     * the ack carries the last `nextChunkIndex` the sender is waiting on, and
     * a browser that sees `files-upload-complete` first has already torn down
     * the transfer state the ack addresses. `state.nextChunk` is final here
     * because `endUpload` refuses to run unless every chunk arrived, so the
     * ack is built from the same numbers the complete frame carries.
     */
    return [
      {
        type: 'files-upload-ack',
        transferId: state.transferId,
        nextChunkIndex: state.nextChunk,
      },
      {
        type: 'files-upload-complete',
        transferId: state.transferId,
        name: state.destRel.split('/').pop(),
        // The wire path, not the host path: `FilesUploadComplete.path` is a
        // `FilesPath` — sandbox-relative (`packages/shared/src/types/files.ts:82`),
        // matching `files.rs:2281`. An absolute path here leaks the host layout
        // and breaks every consumer that resolves it against the root again.
        path: state.destRel,
        size: state.size,
      },
    ];
  }

  private pause(message: { [key: string]: unknown }): FilesFrame[] {
    if (message.direction === 'download' && this.download) {
      this.download.paused = true;
      return [
        {
          type: 'files-pause-ack',
          transferId: this.download.transferId,
          ackedChunkIndex: this.download.acked,
          bytesTransferred: this.download.acked * 32_768,
        },
      ];
    }
    if (message.direction === 'upload' && this.upload) {
      this.upload.paused = true;
      return [
        {
          type: 'files-pause-ack',
          transferId: this.upload.transferId,
          ackedChunkIndex: this.upload.nextChunk,
          bytesTransferred: this.upload.nextChunk * 32_768,
        },
      ];
    }
    throw new SandboxError('TRANSFER_UNKNOWN', 'no such transfer');
  }

  private resume(message: { [key: string]: unknown }): FilesFrame[] {
    const from = Number(message.fromChunkIndex);
    if (message.direction === 'upload') {
      const state = this.upload;
      if (!state || state.transferId !== message.transferId) {
        throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
      }
      if (!state.paused) {
        return [
          {
            type: 'files-resume-ack',
            transferId: state.transferId,
            approved: false,
            fromChunkIndex: from,
            reason: 'transfer is not paused',
          },
        ];
      }
      const partBytes = statSync(state.partPath).size;
      if (!resumeOffsetMatches(partBytes, from)) {
        return [
          {
            type: 'files-resume-ack',
            transferId: state.transferId,
            approved: false,
            fromChunkIndex: from,
            reason: `.part is ${partBytes} bytes, resume offset would land at ${from * 32_768} bytes`,
          },
        ];
      }
      state.paused = false;
      state.nextChunk = from;
      state.lastAcked = from;
      state.pendingAck = null;
      state.lastAckAt = this.now();
      return [
        {
          type: 'files-resume-ack',
          transferId: state.transferId,
          approved: true,
          fromChunkIndex: from,
        },
      ];
    }
    const state = this.download;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such download');
    }
    if (!state.paused) {
      return [
        {
          type: 'files-resume-ack',
          transferId: state.transferId,
          approved: false,
          fromChunkIndex: from,
          reason: 'transfer is not paused',
        },
      ];
    }
    state.sent = from;
    state.acked = from;
    state.paused = false;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    return [
      {
        type: 'files-resume-ack',
        transferId: state.transferId,
        approved: true,
        fromChunkIndex: from,
      },
      ...this.pump(state),
    ];
  }

  private cancel(message: { [key: string]: unknown }): void {
    if (this.upload && this.upload.transferId === message.transferId) {
      this.discardUpload(this.upload);
      this.upload = null;
    }
    if (this.download && this.download.transferId === message.transferId) {
      this.download = null;
    }
  }

  /**
   * Called on peer-connection teardown. Removes any in-flight `.part` so a
   * half-received upload does not sit in the sandbox looking like a file the
   * user might open. Both slots are cleared **before** any filesystem work, so a
   * throwing `unlinkSync` cannot leave a stale state that a later message
   * resumes into.
   */
  dispose(): void {
    const upload = this.upload;
    const download = this.download;
    this.upload = null;
    this.download = null;
    if (upload) this.discardUpload(upload);
    void download;
  }

  /**
   * **R5: the wire's field names, not the Rust's.**
   *
   * `FilesMkdirRequest` (`packages/shared/src/types/files.ts:154-158`) is
   * `{ requestId, dir, name }`. The Rust's handler reads `request.dir` too
   * (`files.rs:537-541`), so the plan's `message.path` was wrong against
   * **both** sources of truth — and wrong silently: `String(undefined ?? '')`
   * is `''`, which `resolveExisting` resolves to the root, so every mkdir
   * landed in the sandbox root instead of the named directory and returned a
   * success frame.
   *
   * **R10(a): the `EEXIST` mapping has to be on THIS path, not merely to exist
   * in the file.** `mkdirSync` over an existing path throws `EEXIST`
   * (errno −17), which is **not** a `SandboxError`; `errnoToCode` does map it
   * (`:3738`) but its call sites are `:3773`, `:3783`, `:3794`, `:4911`,
   * `:5051` and `:5452` — none of them here. So the catch-only path turned a duplicate
   * mkdir into `IO_ERROR`, and with a bare-code contract that wrong code would
   * be **shipped** rather than swallowed. The Rust checks existence first and
   * returns `FILE_EXISTS` (`files.rs:873-883`); mapping the throw reaches the
   * same code without a TOCTOU window between the check and the call.
   */
  private mkdir(message: { [key: string]: unknown }): FilesFrame[] {
    const target = this.root.resolveParentForCreate(
      String(message.dir ?? ''),
      String(message.name),
    );
    try {
      mkdirSync(target);
    } catch (error) {
      throw new SandboxError(
        errnoToCode(error),
        `mkdir ${String(message.dir ?? '')}/${String(message.name)}`,
      );
    }
    return [this.actionResult(message, target)];
  }

  /**
   * `files-delete` honours `recursive`, as the Rust does (ADR-40,
   * `files.rs:918-943`): `recursive: true` removes the tree, and a
   * non-recursive call on a non-empty directory is refused with
   * `DIR_NOT_EMPTY` so the caller must say what it means. The web UI sends
   * `recursive: true` for every folder delete, so a port that always took the
   * non-recursive arm failed every folder delete outright.
   *
   * The root refusal sits above both arms: `rmSync(target, {recursive: true})`
   * on the root would delete the whole sandbox in one message.
   */
  private remove(message: { [key: string]: unknown }): FilesFrame[] {
    const target = this.root.resolveExisting(String(message.path ?? ''));
    // `resolveExisting('')` returns the canonical root, so this compares two
    // canonical strings. Comparing against `this.root` (the object) would be
    // always-false and would let a peer delete the root itself.
    if (target === this.root.root) {
      throw new SandboxError(
        'PERMISSION_DENIED',
        'the files root itself cannot be deleted',
      );
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      if (Boolean(message.recursive)) {
        rmSync(target, { recursive: true });
      } else {
        try {
          rmdirSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
            throw new SandboxError(
              'DIR_NOT_EMPTY',
              'the directory is not empty',
            );
          }
          throw error;
        }
      }
    } else {
      unlinkSync(target);
    }
    return [this.actionResult(message, target)];
  }

  /**
   * **R5, part two: the wire's names AND the root refusal the port lost.**
   *
   * `FilesRenameRequest` (`packages/shared/src/types/files.ts:166-170`) is
   * `{ requestId, oldPath, newPath }`. The plan read `from` / `toPath` /
   * `toName`, none of which the wire carries, so all three were `undefined`:
   * `from` resolved to the root, `toPath` to the root, and `toName` to the
   * **string** `"undefined"` — the rename went to `<root>/undefined` and threw
   * `EINVAL` → `IO_ERROR` for every UI rename.
   *
   * The root guard is the **second** half and it is not implied by the field
   * names. `remove` already refuses the root (`:5468-5470`, comparing the
   * canonical *string* so the comparison is not always-false); `rename` has no
   * such check, and the Rust does (`files.rs:964-970` returns
   * `PermissionDenied`, "cannot rename sandbox root"). Under the broken names
   * the missing guard was masked — `from` was always `''` and the failure came
   * out as `IO_ERROR` for an unrelated reason. **With the wire's real names
   * `rename('', 'x')` resolves `''` to the canonical root and reaches
   * `renameSync`**, so fixing the names without adding the guard swaps one
   * wrong code for another. Containment still holds the destination inside the
   * root, so this is a wrong code plus a missing refusal, not an escape — but
   * `IO_ERROR` where the Rust produces `PERMISSION_DENIED` is a contract
   * break, and the guard is the behaviour the Rust pinned.
   */
  private rename(message: { [key: string]: unknown }): FilesFrame[] {
    const from = this.root.resolveExisting(String(message.oldPath ?? ''));
    // The same comparison `remove` makes, for the same reason: two canonical
    // strings, never the `FilesRoot` object (which would be always-false).
    if (from === this.root.root) {
      throw new SandboxError(
        'PERMISSION_DENIED',
        'the files root itself cannot be renamed',
      );
    }
    // `newPath` is a full relative path on the wire, not a directory plus a
    // name. Splitting it here keeps `resolveParentForCreate` — which rejects a
    // name containing a separator — as the single place a create-target is
    // validated.
    const slash = String(message.newPath ?? '').lastIndexOf('/');
    const parentDir =
      slash === -1 ? '' : String(message.newPath).slice(0, slash);
    const name =
      slash === -1
        ? String(message.newPath ?? '')
        : String(message.newPath).slice(slash + 1);
    const to = this.root.resolveParentForCreate(parentDir, name);
    try {
      statSync(to);
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    renameSync(from, to);
    return [this.actionResult(message, to)];
  }

  private actionResult(
    message: { [key: string]: unknown },
    path: string,
  ): FilesFrame {
    // `path` is a canonical absolute path; the wire carries it relative to the
    // root. `this.root` is the `FilesRoot`, so the comparison and the slice
    // both go through `.root` (the canonical string).
    const prefix = this.root.root;
    return {
      type: 'files-action-result',
      requestId: message.requestId,
      action: String(message.type).replace('files-', ''),
      success: true,
      // Declared divergence, not an oversight: neither the Rust's
      // `FilesActionResult` (`files.rs:564-570`) nor the shared type
      // (`packages/shared/src/types/files.ts:172-177`) carries a `path` on an
      // action result. The browser never reads it (`payload.path` on this
      // frame: 0 hits), and `FilesFrame` is `{ type: string; [key: string]:
      // unknown }`, so `tsc` cannot catch it either. Kept for logging, and
      // recorded here so the next reader does not mistake it for the contract.
      // **The failure arm below must not carry it.**
      path: path === prefix ? '' : path.slice(prefix.length + 1),
    };
  }

  /**
   * **R10: the failure arm, and the code it carries.**
   *
   * The Rust routes an action failure through `files-action-result` with
   * `success: false` and a **prefixed** string (`"FILE_EXISTS: …"`); the
   * browser's `isFilesErrorCode` never matches that, so on `main` every failed
   * action degrades to `BAD_FRAME`. The plan had no failure arm at all and
   * routed failures through `files-error` instead. **Neither artefact is the
   * right answer, and the port takes the combination of both:** the Rust's
   * *frame*, carrying the browser's *bare code*.
   *
   * Why `files-action-result` and not `files-error`, stated because the
   * distinction is a validation asymmetry rather than a style preference:
   * `files-action-result` **validates** the code it carries
   * (`client.ts:566-571`, `isFilesErrorCode` else `BAD_FRAME`), while
   * `files-error` casts the payload unchecked (`client.ts:631-636`). An unknown
   * code crossing on `files-error` arrives intact, the store maps it through
   * `fileErrorMessage` into a 17-key `Record` whose exhaustiveness is a
   * compile-time property only, the lookup returns `undefined`, and
   * `FilesView.vue:268`'s `v-if="tab.fileError"` treats that as falsy — so the
   * error banner **disappears entirely** rather than showing a wrong message.
   * `files-action-result` cannot produce that outcome, because the array
   * rejects what it does not know.
   *
   * The code comes from the `SandboxError`'s own `code` field — the port has
   * the bare code in hand at the throw site and parses nothing. `error` is set
   * **only when `success` is false**, so the success frame keeps the shape it
   * had.
   */
  private actionFailure(
    message: { [key: string]: unknown },
    code: FilesErrorCode,
  ): FilesFrame {
    return {
      type: 'files-action-result',
      requestId: message.requestId,
      action: String(message.type).replace('files-', ''),
      success: false,
      // The BARE code — `'FILE_EXISTS'`, never `'FILE_EXISTS: …'`.
      error: code,
      // No `path`: the failure arm's shape is the four fields the browser
      // reads (`requestId`, `success`, `error`, plus the type's `action`).
    };
  }

  private discardUpload(state: UploadState): void {
    try {
      unlinkSync(state.partPath);
    } catch {
      /* a missing .part is the desired end state */
    }
  }
}

/** Tears a session down: both slots cleared, any `.part` removed. */
export function teardown(session: FilesSession): void {
  session.dispose();
}
