// Service Worker for file downloads (spec §4.3.1 / ADR-38).
// Intercept `/files-download-stream/:transferId/:filename`, look up the
// MessagePort registered at init, and respond with a ReadableStream that
// the browser downloads natively.

// transferId -> MessagePort
const ports = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('message', (event) => {
  const { type, transferId, filename, size } = event.data || {};
  if (type === 'STREAM_INIT' && transferId && event.ports[0]) {
    ports.set(transferId, { port: event.ports[0], filename, size });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Route: /files-download-stream/:transferId/:filename
  const parts = url.pathname.split('/');
  // ['', 'files-download-stream', transferId, filename]
  if (parts.length === 4 && parts[1] === 'files-download-stream') {
    const transferId = parts[2];
    const entry = ports.get(transferId);
    if (!entry) {
      event.respondWith(new Response('not found', { status: 404 }));
      return;
    }

    const { port, filename, size } = entry;
    const stream = new ReadableStream({
      start(controller) {
        port.onmessage = (ev) => {
          const msg = ev.data;
          if (msg.type === 'CHUNK') {
            controller.enqueue(new Uint8Array(msg.chunk));
          } else if (msg.type === 'END') {
            controller.close();
            ports.delete(transferId);
            port.onmessage = null;
          }
        };
        port.onmessageerror = () => {
          controller.error(new Error('port message error'));
          ports.delete(transferId);
          port.onmessage = null;
        };
        port.addEventListener('close', () => {
          controller.error(new Error('port closed'));
          ports.delete(transferId);
        });
      },
    });

    const headers = {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': 'application/octet-stream',
    };
    if (size > 0) {
      headers['Content-Length'] = String(size);
    }
    event.respondWith(new Response(stream, { headers }));
    return;
  }
});
