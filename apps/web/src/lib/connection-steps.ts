/**
 * The initialization stages a session tab moves through while its WebRTC
 * handshake runs. The store stamps the current step onto the tab so the
 * workspace can show the user where the connection actually is, instead of a
 * blank screen (terminal) or an unexplained spinner (desktop).
 */
export type InitStep = 'session' | 'ice' | 'negotiating' | 'shell' | 'stream';

export interface InitStepDef {
  key: InitStep;
  label: string;
}

/**
 * Steps differ per tab kind: a terminal ends by opening a PTY shell, a desktop
 * stream ends by waiting for the first video track. Both share the leading
 * session / ICE / negotiation stages.
 */
export const INIT_STEPS: Record<'terminal' | 'desktop', InitStepDef[]> = {
  terminal: [
    { key: 'session', label: 'Creating session' },
    { key: 'ice', label: 'Preparing connection' },
    { key: 'negotiating', label: 'Negotiating WebRTC channel' },
    { key: 'shell', label: 'Opening shell' },
  ],
  desktop: [
    { key: 'session', label: 'Creating session' },
    { key: 'ice', label: 'Preparing connection' },
    { key: 'stream', label: 'Negotiating video stream' },
  ],
};

/** Index of `step` within the kind's step list; falls back to the first step. */
export function stepIndex(
  kind: 'terminal' | 'desktop',
  step: InitStep,
): number {
  const idx = INIT_STEPS[kind].findIndex((s) => s.key === step);
  return idx === -1 ? 0 : idx;
}
