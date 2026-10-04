import type { FileClientErrorCode } from '@ponter/file-core';

/**
 * UI text per client error code (spec §7.1). The store maps `FilesError.code`
 * to one of these strings and puts it on `tab.fileError`; the view renders the
 * string, so no component needs to know the wire codes.
 */
export const FILE_ERROR_TEXT: Record<FileClientErrorCode, string> = {
  PATH_OUTSIDE_ROOT: 'The agent refused that path',
  INVALID_PATH: 'The agent refused that path',
  NOT_FOUND: 'That file or folder no longer exists',
  NOT_A_FILE: 'That entry is not a file',
  NOT_A_DIRECTORY: 'That entry is not a folder',
  FILE_EXISTS: 'A file with that name already exists',
  FILE_TOO_LARGE: 'That file is too large to transfer',
  TRANSFER_BUSY: 'Another transfer is already running in that direction',
  TRANSFER_UNKNOWN: 'The transfer is no longer known to the agent',
  TRANSFER_TIMEOUT: 'The transfer timed out',
  IO_ERROR: 'The agent could not complete the operation',
  BAD_FRAME: 'The agent rejected a malformed message',
  CANCELLED: 'Transfer cancelled',
  RESUME_INVALID: 'The file changed on the agent — the transfer cannot resume',
  DIR_NOT_EMPTY: 'That folder is not empty',
  PERMISSION_DENIED: 'The agent refused that operation',
  QUEUE_FULL: 'Too many transfers are queued',
};

export function fileErrorMessage(code: FileClientErrorCode): string {
  return FILE_ERROR_TEXT[code];
}
