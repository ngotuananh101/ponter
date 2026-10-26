// apps/agent/test/config.test.ts
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_SHELL_PREFERENCE,
  firstAvailable,
  loadConfig,
  resolveShell,
  windowsShellRoots,
} from '../src/config.js';

const base = {
  AGENT_ID: 'a1',
  AGENT_CREDENTIAL: 'ag_secret',
  SHELL: '/bin/bash',
  HOME: '/home/u',
};

describe('loadConfig', () => {
  it('applies every documented default', () => {
    const c = loadConfig({ ...base });
    expect(c.server).toBe('ws://localhost:8787/api/ws/agent');
    expect(c.stun).toBe('stun:stun.l.google.com:19302');
    expect(c.cols).toBe(80);
    expect(c.rows).toBe(24);
    expect(c.allowInput).toBe(false);
    expect(c.filesRoot).toBeNull();
    expect(c.desktopProfile.id).toBe('1080p30');
  });

  it('defaults the identity path under XDG_CONFIG_HOME when set', () => {
    const c = loadConfig({ ...base, XDG_CONFIG_HOME: '/xdg' });
    expect(c.identityPath).toBe('/xdg/ponter/agent-identity.pkcs8');
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME is unset', () => {
    const c = loadConfig({ ...base });
    expect(c.identityPath).toBe('/home/u/.config/ponter/agent-identity.pkcs8');
  });

  it('refuses to start without a credential, naming both sources', () => {
    expect(() =>
      loadConfig({ ...base, AGENT_CREDENTIAL: undefined }),
    ).toThrowError(/no agent credential: set AGENT_CREDENTIAL/);
  });

  it('rejects an unknown desktop profile rather than defaulting silently', () => {
    expect(() =>
      loadConfig({ ...base, AGENT_DESKTOP_PROFILE: '1440p' }),
    ).toThrowError(/unknown desktop profile "1440p"/);
  });

  it('reads the agent-local input gate, which no peer can flip', () => {
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: '1' }).allowInput).toBe(
      true,
    );
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: '0' }).allowInput).toBe(
      false,
    );
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: 'true' }).allowInput).toBe(
      true,
    );
  });

  it('leaves filesRoot null when the env var is empty', () => {
    expect(loadConfig({ ...base, AGENT_FILES_ROOT: '' }).filesRoot).toBeNull();
  });

  it('defaults the capture backend to the screen and accepts the test pattern', () => {
    expect(loadConfig({ ...base }).desktopSource).toBe('screen');
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_SOURCE: 'test' }).desktopSource,
    ).toBe('test');
  });

  it('rejects an unknown capture backend rather than falling back to the screen', () => {
    expect(() =>
      loadConfig({ ...base, AGENT_DESKTOP_SOURCE: 'window' }),
    ).toThrowError(/unknown desktop source "window"/);
  });

  it('defaults the selection timeout to 5000 ms and reads an explicit one', () => {
    expect(loadConfig({ ...base }).desktopSelectTimeoutMs).toBe(5000);
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_SELECT_TIMEOUT_MS: '250' })
        .desktopSelectTimeoutMs,
    ).toBe(250);
  });

  it('leaves the poll interval null unless one is set, so the profile budget applies', () => {
    expect(loadConfig({ ...base }).desktopPollIntervalMs).toBeNull();
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: '16' })
        .desktopPollIntervalMs,
    ).toBe(16);
  });

  it('treats a zero or unparseable poll interval as unset, not as a spin loop', () => {
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: '0' })
        .desktopPollIntervalMs,
    ).toBeNull();
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: 'soon' })
        .desktopPollIntervalMs,
    ).toBeNull();
  });

  // --- operator shell resolution (B38) ---
  // The six `main.rs` tests for this surface were assigned to Plan 2 by the
  // coverage matrix and deferred to Plan 3 by Task 9. They live here instead:
  // this is config-time resolution, the same moment the Rust's `main` did it.

  it('an explicit AGENT_SHELL always wins over detection, on every platform', () => {
    expect(
      loadConfig({ ...base, AGENT_SHELL: '/usr/bin/fish' }, 'linux').shell,
    ).toBe('/usr/bin/fish');
    expect(
      loadConfig({ ...base, AGENT_SHELL: 'pwsh.exe' }, 'win32').shell,
    ).toBe('pwsh.exe');
  });

  it('on unix falls back to $SHELL and then to /bin/sh', () => {
    expect(loadConfig({ ...base, SHELL: '/usr/bin/zsh' }, 'linux').shell).toBe(
      '/usr/bin/zsh',
    );
    expect(loadConfig({ AGENT_CREDENTIAL: 'ag_x' }, 'linux').shell).toBe(
      '/bin/sh',
    );
  });

  it('prefers the Windows shells in order and stops at the first hit', () => {
    const resolve = (present: readonly string[]) => (name: string) =>
      present.includes(name) ? `C:\\found\\${name}` : undefined;
    // cmd.exe being present must not shadow a pwsh that is also installed.
    expect(firstAvailable(WINDOWS_SHELL_PREFERENCE, resolve(['cmd.exe']))).toBe(
      'C:\\found\\cmd.exe',
    );
    expect(
      firstAvailable(WINDOWS_SHELL_PREFERENCE, resolve(['pwsh', 'cmd.exe'])),
    ).toBe('C:\\found\\pwsh');
    expect(
      firstAvailable(
        WINDOWS_SHELL_PREFERENCE,
        resolve(['powershell', 'cmd.exe']),
      ),
    ).toBe('C:\\found\\powershell');
    expect(
      firstAvailable(WINDOWS_SHELL_PREFERENCE, () => undefined),
    ).toBeUndefined();
  });

  it('carries a resolved absolute path through, not the bare name', () => {
    const pref = ['pwsh', 'powershell', 'cmd.exe'];
    const resolved = firstAvailable(pref, (name) =>
      name === 'pwsh'
        ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        : undefined,
    );
    expect(resolved).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('finds PowerShell 7 in its install root when it is not on PATH', () => {
    // The MSI does not always add its directory to PATH, so a PATH-only probe
    // would fall through to the older powershell.exe — the case the Rust's
    // `windows_shell_roots` exists for.
    const env = { ProgramFiles: 'C:\\Program Files' };
    const roots = windowsShellRoots(env);
    expect(roots[0]).toBe('C:\\Program Files\\PowerShell\\7');
    expect(roots).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(
      resolveShell({ ...base }, 'win32', (name, _roots) =>
        name === 'pwsh'
          ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
          : undefined,
      ),
    ).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('falls back to cmd.exe only when nothing else resolves', () => {
    expect(resolveShell({ ...base }, 'win32', () => undefined)).toBe('cmd.exe');
  });
});
