import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return {
    __esModule: true,
    invoke: fn,
    default: { invoke: fn },
  };
});

import { invoke } from '@tauri-apps/api/core';
import { useWizardStore } from '@/stores/wizard';
import WizardView from '@/views/WizardView.vue';

/** Storage gate: no webview storage in production frontend code (R8). */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

describe('wizard store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('defaults allow_input to false (Gate A)', () => {
    const store = useWizardStore();
    expect(store.allowInput).toBe(false);
    expect(store.step).toBe('server');
    expect(store.completed).toBe(false);
  });

  it('starts on the server step with no probes', () => {
    const store = useWizardStore();
    expect(store.step).toBe('server');
    expect(store.serverProbe).toBeNull();
    expect(store.captureProbe).toBeNull();
  });

  it('advances server → capture → inputGate → autoStart', () => {
    const store = useWizardStore();
    expect(store.canAdvance).toBe(true);

    store.advance();
    expect(store.step).toBe('capture');

    store.advance();
    expect(store.step).toBe('inputGate');

    store.advance();
    expect(store.step).toBe('autoStart');

    expect(store.canAdvance).toBe(false);
  });

  it('sets allowInput when toggled on the input-gate step', async () => {
    const store = useWizardStore();
    store.advance(); // server → capture
    store.advance(); // capture → inputGate

    expect(store.allowInput).toBe(false);

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_wizard_settings', {
      serverUrl: '',
      allowInput: false,
    });
  });

  it('finish() calls save_wizard_settings with serverUrl and allowInput', async () => {
    const store = useWizardStore();
    store.serverUrl = 'http://localhost:8787';
    store.advance();
    store.advance();
    store.advance(); // → autoStart

    store.allowInput = true;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_wizard_settings', {
      serverUrl: 'http://localhost:8787',
      allowInput: true,
    });
    expect(store.completed).toBe(true);
  });

  it('probeServer stores the result and returns it', async () => {
    const store = useWizardStore();
    store.serverUrl = 'http://localhost:8787';

    const mockResult = { ok: true, message: 'Server reachable' };
    vi.mocked(invoke).mockResolvedValue(mockResult);

    const result = await store.probeServer();
    expect(result).toEqual(mockResult);
    expect(store.serverProbe).toEqual(mockResult);
    expect(invoke).toHaveBeenCalledWith('probe_server', {
      url: 'http://localhost:8787',
    });
  });

  it('probeServer with bad result does not advance', async () => {
    const store = useWizardStore();
    store.serverUrl = 'http://dead:8787';

    vi.mocked(invoke).mockResolvedValue({
      ok: false,
      message: 'Could not reach http://dead:8787: connection refused',
    });

    const result = await store.probeServer();
    expect(result.ok).toBe(false);
    expect(store.step).toBe('server');
  });

  it('probeCapture stores the result', async () => {
    const store = useWizardStore();

    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      message: 'Captured 1920×1080 from monitor:0',
    });

    const result = await store.probeCapture();
    expect(result.ok).toBe(true);
    expect(store.captureProbe).toEqual(result);
    expect(invoke).toHaveBeenCalledWith('probe_capture');
  });

  it('reset clears all state', () => {
    const store = useWizardStore();
    store.serverUrl = 'http://localhost:8787';
    store.allowInput = true;
    store.serverProbe = { ok: true, message: 'ok' };
    store.advance();

    store.reset();
    expect(store.step).toBe('server');
    expect(store.serverUrl).toBe('');
    expect(store.allowInput).toBe(false);
    expect(store.serverProbe).toBeNull();
    expect(store.captureProbe).toBeNull();
    expect(store.completed).toBe(false);
  });
});

describe('WizardView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('never writes to webview storage', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      message: 'Server reachable',
    });

    const wrapper = mount(WizardView);
    await wrapper
      .find('[data-testid="wizard-server-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="wizard-probe-server"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);
  });

  it('renders the server step with url input and probe button', () => {
    const wrapper = mount(WizardView);
    expect(wrapper.find('[data-testid="wizard-server-url"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="wizard-probe-server"]').exists()).toBe(
      true,
    );
  });

  it('advances to capture step after successful server probe', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ ok: true, message: 'Server reachable' })
      .mockResolvedValueOnce({ ok: true, message: 'Captured 1920×1080' });

    const wrapper = mount(WizardView);
    const store = useWizardStore();

    await wrapper
      .find('[data-testid="wizard-server-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="wizard-probe-server"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(store.step).toBe('capture');
    expect(wrapper.find('[data-testid="wizard-probe-capture"]').exists()).toBe(
      true,
    );
  });

  it('shows capture probe result and does not advance on failure', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: false,
      message: 'Could not reach server: connection refused',
    });

    const wrapper = mount(WizardView);
    const store = useWizardStore();

    await wrapper
      .find('[data-testid="wizard-server-url"]')
      .setValue('http://dead');
    await wrapper.find('[data-testid="wizard-probe-server"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(store.step).toBe('server');
    expect(
      wrapper.find('[data-testid="wizard-server-message"]').text(),
    ).toContain('Could not reach');
  });

  it('renders input gate step with allowInput checkbox', async () => {
    const wrapper = mount(WizardView);
    const store = useWizardStore();
    // Fast-forward to inputGate
    store.step = 'inputGate';
    await nextTick();

    expect(wrapper.find('[data-testid="wizard-input-checkbox"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="wizard-finish"]').exists()).toBe(true);
  });

  it('renders autoStart step after all probes pass', async () => {
    const wrapper = mount(WizardView);
    const store = useWizardStore();

    vi.mocked(invoke)
      .mockResolvedValueOnce({ ok: true, message: 'Server reachable' })
      .mockResolvedValueOnce({ ok: true, message: 'Captured 1920×1080' })
      .mockResolvedValueOnce(undefined); // save_wizard_settings

    await wrapper
      .find('[data-testid="wizard-server-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="wizard-probe-server"]').trigger('click');
    await flushPromises();
    await nextTick();

    await wrapper.find('[data-testid="wizard-probe-capture"]').trigger('click');
    await flushPromises();
    await nextTick();

    // Check the input checkbox and finish
    await wrapper.find('[data-testid="wizard-input-checkbox"]').setValue(true);
    await wrapper.find('[data-testid="wizard-finish"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(store.step).toBe('autoStart');
    expect(wrapper.find('[data-testid="wizard-complete"]').exists()).toBe(true);
  });
});
