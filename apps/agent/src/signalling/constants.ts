/**
 * Liveness and framing constants. Not in `@ponter/webrtc-core`: those live only
 * in the Rust `signal.rs`, and the browser transport's equivalents are a
 * different mechanism (there is no 90 s idle check in the browser client).
 */
/** Sent as a `{"type":"ping"}` text frame plus a real WS ping, then flushed. */
export const PING_INTERVAL_MS = 30_000;
/** Three missed pings. The server forgets a socket after this silence. */
export const IDLE_TIMEOUT_MS = 90_000;
/**
 * Checked **before** parsing, so a hostile peer cannot make the agent allocate
 * an object graph proportional to the frame.
 */
export const MAX_INBOUND_FRAME_BYTES = 256 * 1024;
/** SCTP message cap the browser also enforces; a pty chunk plus its envelope. */
export const MAX_DATA_CHANNEL_FRAME_BYTES = 64 * 1024;
