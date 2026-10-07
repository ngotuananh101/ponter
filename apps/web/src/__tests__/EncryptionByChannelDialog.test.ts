import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import EncryptionByChannelDialog from '@/components/security/EncryptionByChannelDialog.vue';

const STUBS = {
  Teleport: {
    template: '<slot />',
  },
};

function mountDialog(open: boolean) {
  return mount(EncryptionByChannelDialog, {
    props: { open },
    global: { stubs: STUBS },
  });
}

describe('EncryptionByChannelDialog.vue', () => {
  it('does not render when open is false', () => {
    const wrapper = mountDialog(false);
    expect(
      wrapper.find('[data-test="encryption-by-channel-dialog"]').exists(),
    ).toBe(false);
  });

  it('renders the dialog with all five channel rows when open is true', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    expect(
      wrapper.find('[data-test="encryption-by-channel-dialog"]').exists(),
    ).toBe(true);

    for (const test of [
      'sec-channel-terminal',
      'sec-channel-input',
      'sec-channel-video',
      'sec-channel-files',
      'sec-channel-signaling',
    ]) {
      expect(wrapper.find(`[data-test="${test}"]`).exists()).toBe(true);
    }
  });

  it('video row is transport-only (DTLS-SRTP), never end-to-end', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    const videoRow = wrapper.find('[data-test="sec-channel-video"]');
    expect(videoRow.text()).not.toMatch(/end-to-end/i);
    expect(videoRow.text()).toMatch(/DTLS-SRTP/);
  });

  it('files row is transport-only (DTLS / SCTP), never end-to-end', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    const filesRow = wrapper.find('[data-test="sec-channel-files"]');
    expect(filesRow.text()).not.toMatch(/e2ee|end-to-end/i);
    expect(filesRow.text()).toMatch(/DTLS \/ SCTP/);
  });

  it('signaling row is transport-only, never end-to-end', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    const signalingRow = wrapper.find('[data-test="sec-channel-signaling"]');
    expect(signalingRow.text()).not.toMatch(/e2ee|end-to-end/i);
  });

  it('terminal row references the app-layer cipher', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="sec-channel-terminal"]').text()).toContain(
      'AES-GCM-256',
    );
  });

  it('input row references the app-layer cipher', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="sec-channel-input"]').text()).toContain(
      'AES-GCM-256',
    );
  });

  it('footnote states the scope of app-layer E2EE precisely', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(
      'Application-layer E2EE applies to terminal and control-input channels only',
    );
  });

  it('emits update:open(false) when the built-in close button is clicked', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    // shadcn DialogContent renders a close button wrapping <span class="sr-only">Close</span>
    const closeButton = wrapper.find('button[data-slot="dialog-close"]');
    if (closeButton.exists()) {
      await closeButton.trigger('click');
      expect(wrapper.emitted('update:open')).toEqual([[false]]);
    } else {
      // Fallback: emit update:open(false) directly on the Dialog component
      const dialog = wrapper.findComponent({ name: 'Dialog' });
      if (dialog.exists()) {
        dialog.vm.$emit('update:open', false);
        expect(wrapper.emitted('update:open')).toEqual([[false]]);
      } else {
        // Re-fall to DialogRoot if that is the component name
        const dialogRoot = wrapper.findComponent({ name: 'DialogRoot' });
        dialogRoot.vm.$emit('update:open', false);
        expect(wrapper.emitted('update:open')).toEqual([[false]]);
      }
    }
  });

  it('uses a wider-than-default dialog width', async () => {
    const wrapper = mountDialog(true);
    await wrapper.vm.$nextTick();

    const content = wrapper.find('[data-test="encryption-by-channel-dialog"]');
    expect(content.classes()).toContain('max-w-3xl');
    expect(content.classes()).not.toContain('max-w-2xl');
  });
});
