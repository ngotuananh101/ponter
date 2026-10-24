/**
 * Is this failure fatal to the *credential*, as opposed to fatal to the
 * *request*? (B53, ported from `api.rs`'s `is_auth_fatal`.)
 *
 * The distinction is the whole reason reconnect exists: a 500 or a 403 is
 * worth retrying or ignoring, while a 401 or `UNAUTHORIZED` means this agent
 * will never be admitted. Reconnecting on those hammers a server that has
 * already decided, and on `4409` would evict the connection that replaced us.
 *
 * Deliberately not a message-substring match: issue #107 replaced message
 * matching with this stable signal pair because a server rewording its message
 * silently turned a fatal into an infinite loop.
 */
export interface AuthSignal {
  status?: number;
  code?: string;
}

export function isAuthFatal(frame: AuthSignal): boolean {
  return frame.status === 401 || frame.code === 'UNAUTHORIZED';
}
