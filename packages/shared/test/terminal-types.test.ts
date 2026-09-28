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

  it('instantiates valid TerminalDataMessage', () => {
    const dataMsg: TerminalDataMessage = {
      terminalId: 'term-1',
      data: 'hello world',
    };
    expect(dataMsg.terminalId).toBe('term-1');
    expect(dataMsg.data).toBe('hello world');
  });

  it('instantiates valid TerminalResizeMessage', () => {
    const resizeMsg: TerminalResizeMessage = {
      terminalId: 'term-1',
      cols: 120,
      rows: 40,
    };
    expect(resizeMsg.terminalId).toBe('term-1');
    expect(resizeMsg.cols).toBe(120);
    expect(resizeMsg.rows).toBe(40);
  });

  it('instantiates valid TerminalCloseMessage and TerminalExitMessage', () => {
    const closeMsg: TerminalCloseMessage = { terminalId: 'term-1' };
    const exitMsg: TerminalExitMessage = { terminalId: 'term-1', exitCode: 0 };
    expect(closeMsg.terminalId).toBe('term-1');
    expect(exitMsg.exitCode).toBe(0);
  });

  it('TerminalExitMessage works without optional exitCode', () => {
    const exitMsg: TerminalExitMessage = { terminalId: 'term-1' };
    expect(exitMsg.terminalId).toBe('term-1');
    expect(exitMsg.exitCode).toBeUndefined();
  });
});
