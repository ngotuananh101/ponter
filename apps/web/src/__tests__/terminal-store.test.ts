import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';

describe('useTerminalStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initializes with empty tabs and connections', () => {
    const store = useTerminalStore();
    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBeNull();
  });

  it('selects active tab and closes tab correctly', () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as unknown as TerminalSession,
    });
    store.setActiveTab('tab-1');
    expect(store.activeTabId).toBe('tab-1');

    store.closeTab('tab-1');
    expect(store.tabs.length).toBe(0);
    expect(store.activeTabId).toBeNull();
  });
});
