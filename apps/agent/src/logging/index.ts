// apps/agent/src/logging/index.ts
/**
 * Level policy (`RUST_LOG`, default `info`) plus the known-benign-line filter.
 *
 * `RUST_LOG` outlives the Rust tree on purpose: it is the documented knob the
 * desktop supervisor and the self-hosting guide tell an operator to set, and
 * renaming it would break deployments that already use it.
 *
 * The Rust filter carried ten rules. **None of them port**: every one names a
 * Rust crate's target (`rtc_ice`, `rtc_dtls`, `libwayshot_xcap`, `quinn_udp`,
 * `webrtc::peer_connection::*`) and the TypeScript stack is werift, which logs
 * through a different mechanism. The *mechanism* ports — a (target, substring)
 * pair where both must match — and the rules are added as werift's own noise is
 * discovered while wiring the peer. The five retired rationales that carry real
 * operational knowledge (the coturn loopback 403, the DTLS alert that cannot be
 * distinguished from a fatal one, the loopback STUN write, the mDNS candidate,
 * the duplicate ICE discards) are recorded in the retirement note for Plan 3 so
 * they are not lost, and are re-expressed here if werift has equivalents.
 */
export type NoiseRule = readonly [target: string, message: string];

/** Both parts must match: the target scopes the crate, the substring the case. */
export const NOISE: readonly NoiseRule[] = [];

/**
 * `rules` is a parameter so the matcher can be exercised against a table that
 * is not empty: `NOISE` ships empty, and a function whose only input is `[]`
 * cannot be shown to match anything. The default keeps every production call
 * site reading the shipped table.
 */
export function isNoise(
  target: string,
  message: string,
  rules: readonly NoiseRule[] = NOISE,
): boolean {
  if (rules.length === 0) return false;
  return rules.some(([t, m]) => target.startsWith(t) && message.includes(m));
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

const ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Resolve the active level from `RUST_LOG`.
 *
 * The Rust used `EnvFilter`, whose full grammar is per-target directives. The
 * agent only ever relied on the bare level form (`RUST_LOG=debug`), so this
 * reads a comma-separated list, takes the last bare level it finds, and ignores
 * `target=level` directives rather than pretending to implement them. An
 * unrecognised value falls back to `info`, as `EnvFilter::try_from_default_env`
 * falling back to `info` did.
 */
export function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.RUST_LOG?.trim();
  if (!raw) return 'info';
  let level: LogLevel = 'info';
  for (const part of raw.split(',')) {
    const candidate = part.trim().toLowerCase();
    if (candidate in ORDER) level = candidate as LogLevel;
  }
  return level;
}

export function createLogger(
  env: NodeJS.ProcessEnv,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const threshold = ORDER[levelFromEnv(env)];
  const emit = (
    level: LogLevel,
    fields: Record<string, unknown>,
    message: string,
  ): void => {
    if (ORDER[level] > threshold) return;
    if (
      isNoise(typeof fields.target === 'string' ? fields.target : '', message)
    )
      return;
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    const suffix = extra ? ` (${extra})` : '';
    sink(`${level.toUpperCase()} ${message}${suffix}`);
  };
  return {
    error: (f, m) => emit('error', f, m),
    warn: (f, m) => emit('warn', f, m),
    info: (f, m) => emit('info', f, m),
    debug: (f, m) => emit('debug', f, m),
  };
}
