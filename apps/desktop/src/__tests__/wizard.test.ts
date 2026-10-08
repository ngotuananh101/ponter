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
    expect(store.step).toBe('capture');
    expect(store.completed).toBe(false);
    expect(store.autoStart).toBe(false);
  });

  it('starts on the capture step with no probe', () => {
    const store = useWizardStore();
    expect(store.step).toBe('capture');
    expect(store.captureProbe).toBeNull();
  });

  it('advances only when probes succeed (R1: store-level gate)', () => {
    const store = useWizardStore();
    expect(store.canAdvance).toBe(true);

    // No probe yet — advance is refused.
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

    // captureProbe is ok:false → must not advance.
    store.captureProbe = failProbe;
    store.advance();
    expect(store.step).toBe('capture');
  });

  it('sets allowInput when toggled on the input-gate step', async () => {
    const store = useWizardStore();
    // Fast-forward to inputGate with probes.
    store.captureProbe = okProbe;
    store.advance(); // capture → inputGate

    expect(store.allowInput).toBe(false);

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: false,
      theme: null,
    });
    // finish() advances to autoStart but does NOT set completed (R11).
    expect(store.step).toBe('autoStart');
    expect(store.completed).toBe(false);
  });

  it('finish() calls save_config and advances to autoStart', async () => {
    const store = useWizardStore();
    // Fast-forward to inputGate with probes.
    store.captureProbe = okProbe;
    store.advance(); // capture → inputGate

    store.allowInput = true;

    vi.mocked(invoke).mockResolvedValue(undefined);
    await store.finish();
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: true,
      theme: null,
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
    store.allowInput = true;
    store.autoStart = true;
    store.captureProbe = okProbe;
    store.advance();
    store.completed = true;
    store.autoStartError = 'some error';

    store.reset();
    expect(store.step).toBe('capture');
    expect(store.allowInput).toBe(false);
    expect(store.autoStart).toBe(false);
    expect(store.captureProbe).toBeNull();
    expect(store.completed).toBe(false);
  });
});

describe('WizardView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('shows capture probe result and does not advance on failure', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: false,
      message: 'Could not capture screen: permission denied',
    });

    const wrapper = mount(WizardView);
    const store = useWizardStore();

    await wrapper.find('[data-testid="wizard-probe-capture"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(store.step).toBe('capture');
    expect(
      wrapper.find('[data-testid="wizard-capture-message"]').text(),
    ).toContain('Could not capture');
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
      .mockResolvedValueOnce({ ok: true, message: 'Captured 1920×1080' })
      .mockResolvedValueOnce(undefined); // save_config

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
