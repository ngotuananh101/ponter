import { describe, it, expect } from 'vitest';
import type {
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  TerminalCloseMessage,
  TerminalExitMessage,
} from '../src';

describe('Terminal Message Types', () => {
  it('instantiates valid TerminalCreateMessage', () => {
    const msg: TerminalCreateMessage = {
      terminalId: 'term-1',
      cols: 100,
      rows: 30,
      shell: '/bin/bash',
    };
    expect(msg.terminalId).toBe('term-1');
    expect(msg.cols).toBe(100);
    expect(msg.rows).toBe(30);
    expect(msg.shell).toBe('/bin/bash');
  });

  it('instantiates valid TerminalCloseMessage and TerminalExitMessage', () => {
    const closeMsg: TerminalCloseMessage = { terminalId: 'term-1' };
    const exitMsg: TerminalExitMessage = { terminalId: 'term-1', exitCode: 0 };
    expect(closeMsg.terminalId).toBe('term-1');
    expect(exitMsg.exitCode).toBe(0);
  });
});
