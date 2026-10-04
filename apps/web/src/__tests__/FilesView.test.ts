import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import FilesView from '@/components/files/FilesView.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import type { RemoteFile } from '@ponter/shared';
import type { TransferHandle } from '@ponter/file-core';

const entry = (overrides: Partial<RemoteFile> = {}): RemoteFile => ({
  name: 'notes.txt',
  path: 'notes.txt',
  size: 3,
  isDirectory: false,
  modifiedAt: '2026-10-04T10:00:00Z',
  ...overrides,
});

/** A files tab already populated with a root listing (the store's steady state). */
function filesTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-f1',
    agentId: 'ag-1',
    kind: 'files',
    terminalId: '',
    title: 'Host 1',
    status: 'active',
    filesPath: '',
    fileList: {
      path: '',
      entries: [
        entry({ name: 'docs', path: 'docs', isDirectory: true, size: 0 }),
        entry(),
      ],
      truncated: false,
    },
    ...overrides,
  };
}

const mountFiles = (overrides: Partial<TabItem> = {}) =>
  mount(FilesView, { props: { tab: filesTab(overrides) } });

describe('FilesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders the listing with name, size and modified columns', () => {
    const wrapper = mountFiles();
    const text = wrapper.text();
    expect(text).toContain('docs');
    expect(text).toContain('notes.txt');
    // 3 bytes renders as "3 B" (the human formatter), not "3".
    expect(text).toContain('3 B');
    expect(text).toContain('Name');
    expect(text).toContain('Modified');
  });

  it('navigates into a directory on row click', async () => {
    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const wrapper = mountFiles();

    await wrapper.find('[data-test="files-row-docs"]').trigger('click');

    expect(navigate).toHaveBeenCalledWith('tab-f1', 'docs');
  });

  it('downloads a file on row click', async () => {
    const store = useTerminalStore();
    const download = vi.spyOn(store, 'filesDownload').mockResolvedValue();
    const wrapper = mountFiles();

    await wrapper.find('[data-test="files-row-notes.txt"]').trigger('click');

    expect(download).toHaveBeenCalledWith('tab-f1', 'notes.txt');
  });

  it('disables the up button at the root and walks up from a subdirectory', async () => {
    const atRoot = mountFiles();
    expect(
      atRoot.find('[data-test="files-up"]').attributes('disabled'),
    ).toBeDefined();

    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const nested = mountFiles({
      filesPath: 'docs/sub',
      fileList: { path: 'docs/sub', entries: [], truncated: false },
    });
    const up = nested.find('[data-test="files-up"]');
    expect(up.attributes('disabled')).toBeUndefined();

    await up.trigger('click');
    expect(navigate).toHaveBeenCalledWith('tab-f1', 'docs');
  });

  it('renders clickable breadcrumb segments', async () => {
    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const wrapper = mountFiles({
      filesPath: 'docs/sub',
      fileList: { path: 'docs/sub', entries: [], truncated: false },
    });

    expect(wrapper.text()).toContain('docs');
    expect(wrapper.text()).toContain('sub');

    await wrapper.find('[data-test="files-crumb-root"]').trigger('click');
    expect(navigate).toHaveBeenCalledWith('tab-f1', '');
  });

  it('reads the picked file from the hidden input and calls filesUpload', async () => {
    const store = useTerminalStore();
    const upload = vi.spyOn(store, 'filesUpload').mockResolvedValue();
    const wrapper = mountFiles();

    const input = wrapper.find<HTMLInputElement>(
      '[data-test="files-upload-input"]',
    );
    expect(input.attributes('type')).toBe('file');

    const file = new File([new Uint8Array([1, 2, 3])], 'up.bin');
    Object.defineProperty(input.element, 'files', {
      value: [file],
      configurable: true,
    });
    await input.trigger('change');

    expect(upload).toHaveBeenCalledWith('tab-f1', file);
  });

  it('shows each active transfer with its percent and cancels from the footer', async () => {
    const store = useTerminalStore();
    const cancel = vi
      .spyOn(store, 'filesCancelTransfer')
      .mockImplementation(() => {});
    const handle: TransferHandle = {
      transferId: 't-dl-1',
      direction: 'download',
      done: Promise.resolve(),
      cancel: vi.fn(),
    };
    const wrapper = mountFiles({
      fileTransfers: [
        {
          transferId: 't-dl-1',
          direction: 'download',
          bytesTransferred: 50,
          totalBytes: 100,
          chunkIndex: 0,
          name: 'big.bin',
          handle,
        },
      ],
    });

    const line = wrapper.find('[data-test="files-transfer-t-dl-1"]');
    expect(line.text()).toContain('big.bin');
    expect(line.text()).toContain('50%');

    await line.find('[data-test="files-cancel-t-dl-1"]').trigger('click');
    expect(cancel).toHaveBeenCalledWith('tab-f1', 't-dl-1');
  });

  it('renders the store-mapped error text and dismisses the banner', async () => {
    const store = useTerminalStore();
    const clear = vi
      .spyOn(store, 'clearFileError')
      .mockImplementation(() => {});
    const wrapper = mountFiles({
      fileError: 'A file with that name already exists',
    });

    const banner = wrapper.find('[data-test="files-error"]');
    expect(banner.text()).toContain('A file with that name already exists');

    await wrapper.find('[data-test="files-error-dismiss"]').trigger('click');
    expect(clear).toHaveBeenCalledWith('tab-f1');
  });

  it('notes a truncated listing and the empty-directory state', () => {
    const truncated = mountFiles({
      fileList: { path: '', entries: [], truncated: true },
    });
    expect(truncated.find('[data-test="files-truncated"]').exists()).toBe(true);
    expect(truncated.text()).toContain('empty');

    const empty = mountFiles({
      fileList: { path: '', entries: [], truncated: false },
    });
    expect(empty.find('[data-test="files-truncated"]').exists()).toBe(false);
    expect(empty.text()).toContain('empty');
  });
});
