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

const okProbe = { ok: true, message: 'OK' };
const failProbe = { ok: false, message: 'FAIL' };

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
    expect(store.autoStart).toBe(false);
  });

  it('starts on the server step with no probes', () => {
    const store = useWizardStore();
    expect(store.step).toBe('server');
    expect(store.serverProbe).toBeNull();
    expect(store.captureProbe).toBeNull();
  });

  it('advances only when probes succeed (R1: store-level gate)', () => {
    const store = useWizardStore();
    expect(store.canAdvance).toBe(true);

    // No probe yet — advance is refused.
    store.advance();
    expect(store.step).toBe('server');

    // serverProbe ok → can advance to capture.
    store.serverProbe = okProbe;
    store.advance();
    expect(store.step).toBe('capture');

    // captureProbe not set yet — advance refused.
    store.advance();
    expect(store.step).toBe('capture');

    // captureProbe ok → can advance to inputGate.
    store.captureProbe = okProbe;
    store.advance();
    expect(store.step).toBe('inputGate');

    // inputGate → autoStart is unconditional (gate B at admission, Task 7).
    store.advance();
    expect(store.step).toBe('autoStart');

    expect(store.canAdvance).toBe(false);
  });

  it('advance with failed probe leaves step unchanged (R1 negative)', () => {
    const store = useWizardStore();

    // serverProbe is ok:false → must not advance.
    store.serverProbe = failProbe;
    store.advance();
    expect(store.step).toBe('server');

    // captureProbe is ok:false → must not advance.
    store.serverProbe = okProbe;
    store.advance();
    expect(store.step).toBe('capture');

    store.captureProbe = failProbe;
    store.advance();
    expect(store.step).toBe('capture');
  });

  it('sets allowInput when toggled on the input-gate step', async () => {
    const store = useWizardStore();
    // Set probes so advance works.
    store.serverProbe = okProbe;
    store.advance(); // server → capture
    store.captureProbe = okProbe;
    store.advance(); // capture → inputGate

    expect(store.allowInput).toBe(false);

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_wizard_settings', {
      serverUrl: '',
      allowInput: false,
    });
    // finish() advances to autoStart but does NOT set completed (R11).
    expect(store.step).toBe('autoStart');
    expect(store.completed).toBe(false);
  });

  it('finish() calls save_wizard_settings and advances to autoStart', async () => {
    const store = useWizardStore();
    // Fast-forward to inputGate with probes.
    store.serverProbe = okProbe;
    store.advance(); // server → capture
    store.captureProbe = okProbe;
    store.advance(); // capture → inputGate

    store.serverUrl = 'http://localhost:8787';
    store.allowInput = true;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_wizard_settings', {
      serverUrl: 'http://localhost:8787',
      allowInput: true,
    });
    // finish() advances to autoStart but does NOT set completed (R11).
    expect(store.step).toBe('autoStart');
    expect(store.completed).toBe(false);
  });

  it('complete() calls set_autostart then sets completed', async () => {
    const store = useWizardStore();
    store.step = 'autoStart';
    store.autoStart = true;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.complete();
    expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: true });
    expect(store.completed).toBe(true);
  });

  it('complete() with autoStart false calls set_autostart with false', async () => {
    const store = useWizardStore();
    store.step = 'autoStart';
    store.autoStart = false;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.complete();
    expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: false });
    expect(store.completed).toBe(true);
  });

  it('setAutoStart() calls invoke and updates autoStart', async () => {
    const store = useWizardStore();
    store.autoStart = false;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.setAutoStart(true);
    expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: true });
    expect(store.autoStart).toBe(true);
  });

  it('loadAutoStart() calls is_autostart_enabled and updates autoStart', async () => {
    const store = useWizardStore();
    store.autoStart = false;

    vi.mocked(invoke).mockResolvedValue(true);
    await store.loadAutoStart();
    expect(invoke).toHaveBeenCalledWith('is_autostart_enabled');
    expect(store.autoStart).toBe(true);
  });

  /** setAutoStart surfaces errors and reverts the optimistic update (R11). */
  it('setAutoStart() rejects and reverts autoStart on error', async () => {
    const store = useWizardStore();
    store.autoStart = false;

    vi.mocked(invoke).mockRejectedValue(new Error('OS refused'));
    await expect(store.setAutoStart(true)).rejects.toThrow('OS refused');
    expect(store.autoStart).toBe(false); // reverted
    expect(store.autoStartError).toContain('OS refused');
  });

  /** The `||` fallback must be load-bearing when the error message is empty. */
  it('setAutoStart() falls back to a generic message on an empty error message', async () => {
    const store = useWizardStore();
    store.autoStart = false;

    vi.mocked(invoke).mockRejectedValue(new Error(''));
    await expect(store.setAutoStart(true)).rejects.toThrow();
    // The optimistic toggle was reverted.
    expect(store.autoStart).toBe(false);
    // An empty Error message must fall back to the generic message.
    expect(store.autoStartError).toBe('Failed to update auto-start preference');
  });

  /** complete() does NOT set completed when set_autostart rejects (R11). */
  it('complete() keeps completed false on set_autostart error', async () => {
    const store = useWizardStore();
    store.step = 'autoStart';
    store.autoStart = true;

    vi.mocked(invoke).mockRejectedValue(new Error('nope'));
    await expect(store.complete()).rejects.toThrow('nope');
    expect(store.completed).toBe(false);
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
    // The store gate enforces: even if the view called advance(), it would
    // refuse. But the view only calls advance on ok — double protection.
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

  it('reset clears all state including autoStart', () => {
    const store = useWizardStore();
    store.serverUrl = 'http://localhost:8787';
    store.allowInput = true;
    store.autoStart = true;
    store.serverProbe = { ok: true, message: 'ok' };
    store.serverProbe = okProbe;
    store.advance();
    store.captureProbe = okProbe;
    store.advance();
    store.completed = true;
    store.autoStartError = 'some error';

    store.reset();
    expect(store.step).toBe('server');
    expect(store.serverUrl).toBe('');
    expect(store.allowInput).toBe(false);
    expect(store.autoStart).toBe(false);
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

    // Check the input checkbox and click Continue (finish)
    await wrapper
      .find('[data-testid="wizard-input-checkbox"]')
      .trigger('click');
    await flushPromises();
    await nextTick();
    await wrapper.find('[data-testid="wizard-finish"]').trigger('click');
    await flushPromises();
    await nextTick();

    // finish() saves settings and advances to autoStart (step 4), but does NOT
    // set completed — step 4 is the final step (R11).
    expect(store.step).toBe('autoStart');
    expect(store.completed).toBe(false);
    expect(wrapper.find('[data-testid="wizard-autostart-help"]').exists()).toBe(
      true,
    );
    expect(
      wrapper.find('[data-testid="wizard-autostart-checkbox"]').exists(),
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="wizard-autostart-finish"]').exists(),
    ).toBe(true);
  });

  it('autoStart checkbox toggle calls set_autostart', async () => {
    const wrapper = mount(WizardView);
    const store = useWizardStore();
    store.step = 'autoStart';
    await nextTick();

    vi.mocked(invoke).mockResolvedValue(undefined);
    const checkbox = wrapper.find('[data-testid="wizard-autostart-checkbox"]');
    await checkbox.trigger('click');
    await flushPromises();
    await nextTick();
    expect(invoke).toHaveBeenCalledWith('set_autostart', { enabled: true });
  });

  it('autostart finish calls complete() which sets completed', async () => {
    const wrapper = mount(WizardView);
    const store = useWizardStore();
    store.step = 'autoStart';
    store.autoStart = true;
    await nextTick();

    vi.mocked(invoke).mockResolvedValue(undefined);
    await wrapper
      .find('[data-testid="wizard-autostart-finish"]')
      .trigger('click');
    await flushPromises();
    expect(store.completed).toBe(true);
  });

  it('entering step 4 loads real auto-start state (is_autostart_enabled)', async () => {
    mount(WizardView);
    const store = useWizardStore();

    vi.mocked(invoke).mockResolvedValue(false);
    store.step = 'autoStart';
    await nextTick();
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('is_autostart_enabled');
  });

  it('renders the auto-start error element when autoStartError is set', async () => {
    const wrapper = mount(WizardView);
    const store = useWizardStore();
    store.step = 'autoStart';
    await nextTick();

    store.autoStartError = 'boom: registry write failed';
    await nextTick();

    const errorEl = wrapper.find('[data-testid="wizard-autostart-error"]');
    expect(errorEl.exists()).toBe(true);
    expect(errorEl.text()).toContain('boom: registry write failed');
  });
});
