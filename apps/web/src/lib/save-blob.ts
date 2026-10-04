/**
 * Save `bytes` to the user's downloads as `name` (spec §7.1): an object URL
 * plus a synthetic `<a download>` click, then the URL is revoked. In-memory by
 * design for the thin slice — the large-file/streaming watch item is §9.4.
 */
export function saveBlob(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as unknown as Uint8Array<ArrayBuffer>]),
  );
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
