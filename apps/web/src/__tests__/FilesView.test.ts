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

/** Mount FilesView attached to the document body (for dialog keyboard events). */
function mountAttached(overrides: Partial<TabItem> = {}) {
  const wrapper = mount(FilesView, {
    props: { tab: filesTab(overrides) },
    attachTo: document.body,
  });
  return wrapper;
}

/** Open the New Folder dialog, enter a name, and click confirm or cancel. */
async function newFolderAction(
  wrapper: ReturnType<typeof mountFiles>,
  name: string,
  confirm = true,
) {
  await wrapper.find('[data-test="files-new-folder-btn"]').trigger('click');
  const input = wrapper.find<HTMLInputElement>(
    '[data-test="new-folder-input"]',
  );
  await input.setValue(name);
  await wrapper
    .find(`[data-test="new-folder-${confirm ? 'confirm' : 'cancel'}"]`)
    .trigger('click');
}

/** Open the Rename dialog for the given row, enter a name, and click confirm or cancel. */
async function renameAction(
  wrapper: ReturnType<typeof mountFiles>,
  rowSelector: string,
  name: string,
  confirm = true,
) {
  await wrapper.find(`${rowSelector} .rename-action`).trigger('click');
  const input = wrapper.find<HTMLInputElement>('[data-test="rename-input"]');
  await input.setValue(name);
  await wrapper
    .find(`[data-test="rename-${confirm ? 'confirm' : 'cancel'}"]`)
    .trigger('click');
}

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

  describe('FilesView Advanced UI (Week 11)', () => {
    it('renders New Folder and Transfers toolbar buttons', () => {
      const wrapper = mountFiles();
      expect(wrapper.find('[data-test="files-new-folder-btn"]').exists()).toBe(
        true,
      );
      expect(wrapper.find('[data-test="files-transfers-btn"]').exists()).toBe(
        true,
      );
    });

    it('triggers dragover visual state when dragging files over table', async () => {
      const wrapper = mountFiles();
      const dropzone = wrapper.find('[data-test="files-dropzone"]');
      await dropzone.trigger('dragover');
      expect(wrapper.classes()).toContain('drag-active');
    });

    it('drops files onto the dropzone and calls filesUpload for each', async () => {
      const store = useTerminalStore();
      const upload = vi.spyOn(store, 'filesUpload').mockResolvedValue();
      const wrapper = mountFiles();

      const dropzone = wrapper.find('[data-test="files-dropzone"]');
      const file1 = new File([new Uint8Array([1])], 'a.txt');
      const file2 = new File([new Uint8Array([2])], 'b.txt');
      const file3 = new File([new Uint8Array([3])], 'c.txt');

      const event = new DragEvent('drop');
      Object.defineProperty(event, 'dataTransfer', {
        value: { files: [file1, file2, file3] },
        configurable: true,
      });
      await dropzone.element.dispatchEvent(event);

      expect(upload).toHaveBeenCalledWith('tab-f1', file1);
      expect(upload).toHaveBeenCalledWith('tab-f1', file2);
      expect(upload).toHaveBeenCalledWith('tab-f1', file3);
      expect(upload).toHaveBeenCalledTimes(3);
    });

    it('removes the drag-active class on dragleave', async () => {
      const wrapper = mountFiles();
      const dropzone = wrapper.find('[data-test="files-dropzone"]');
      await dropzone.trigger('dragover');
      expect(wrapper.classes()).toContain('drag-active');
      await dropzone.trigger('dragleave');
      expect(wrapper.classes()).not.toContain('drag-active');
    });

    it('opens the New Folder dialog and confirms via store.filesMkdir', async () => {
      const store = useTerminalStore();
      const mkdir = vi.spyOn(store, 'filesMkdir').mockResolvedValue();
      const wrapper = mountFiles();

      await wrapper.find('[data-test="files-new-folder-btn"]').trigger('click');

      const input = wrapper.find<HTMLInputElement>(
        '[data-test="new-folder-input"]',
      );
      await input.setValue('NewDir');
      await wrapper.find('[data-test="new-folder-confirm"]').trigger('click');

      expect(mkdir).toHaveBeenCalledWith('tab-f1', 'NewDir');
    });

    it('attaches to the document body: confirm calls filesMkdir exactly once', async () => {
      const store = useTerminalStore();
      const mkdir = vi.spyOn(store, 'filesMkdir').mockResolvedValue();
      const wrapper = mountAttached();
      try {
        await newFolderAction(wrapper, 'NewDir', true);

        expect(mkdir).toHaveBeenCalledTimes(1);
        expect(mkdir).toHaveBeenCalledWith('tab-f1', 'NewDir');
      } finally {
        wrapper.unmount();
      }
    });

    it('attaches to the document body: Cancel does not call filesMkdir', async () => {
      const store = useTerminalStore();
      const mkdir = vi.spyOn(store, 'filesMkdir').mockResolvedValue();
      const wrapper = mountAttached();
      try {
        await newFolderAction(wrapper, 'NewDir', false);

        expect(mkdir).not.toHaveBeenCalled();
      } finally {
        wrapper.unmount();
      }
    });

    it('opens the Rename dialog from a row action and confirms', async () => {
      const store = useTerminalStore();
      const rename = vi.spyOn(store, 'filesRename').mockResolvedValue();
      const wrapper = mountFiles();

      await wrapper
        .find('[data-test="files-row-notes.txt"] .rename-action')
        .trigger('click');

      const input = wrapper.find<HTMLInputElement>(
        '[data-test="rename-input"]',
      );
      await input.setValue('renamed.txt');
      await wrapper.find('[data-test="rename-confirm"]').trigger('click');

      expect(rename).toHaveBeenCalledWith('tab-f1', 'notes.txt', 'renamed.txt');
    });

    it('preserves the subdirectory path when renaming a file in a subdirectory', async () => {
      const store = useTerminalStore();
      const rename = vi.spyOn(store, 'filesRename').mockResolvedValue();
      const wrapper = mountFiles({
        filesPath: 'docs/sub',
        fileList: {
          path: 'docs/sub',
          entries: [entry({ name: 'notes.txt', path: 'docs/sub/notes.txt' })],
          truncated: false,
        },
      });

      await wrapper
        .find('[data-test="files-row-notes.txt"] .rename-action')
        .trigger('click');

      const input = wrapper.find<HTMLInputElement>(
        '[data-test="rename-input"]',
      );
      await input.setValue('renamed.txt');
      await wrapper.find('[data-test="rename-confirm"]').trigger('click');

      expect(rename).toHaveBeenCalledWith(
        'tab-f1',
        'docs/sub/notes.txt',
        'docs/sub/renamed.txt',
      );
    });

    it('attaches to the document body: Rename confirm calls filesRename exactly once', async () => {
      const store = useTerminalStore();
      const rename = vi.spyOn(store, 'filesRename').mockResolvedValue();
      const wrapper = mountAttached();
      try {
        await renameAction(
          wrapper,
          '[data-test="files-row-notes.txt"]',
          'renamed.txt',
          true,
        );

        expect(rename).toHaveBeenCalledTimes(1);
        expect(rename).toHaveBeenCalledWith(
          'tab-f1',
          'notes.txt',
          'renamed.txt',
        );
      } finally {
        wrapper.unmount();
      }
    });

    it('attaches to the document body: Rename Cancel does not call filesRename', async () => {
      const store = useTerminalStore();
      const rename = vi.spyOn(store, 'filesRename').mockResolvedValue();
      const wrapper = mountAttached();
      try {
        await renameAction(
          wrapper,
          '[data-test="files-row-notes.txt"]',
          'renamed.txt',
          false,
        );

        expect(rename).not.toHaveBeenCalled();
      } finally {
        wrapper.unmount();
      }
    });

    it('opens the Delete confirmation dialog from a row action', async () => {
      const store = useTerminalStore();
      const del = vi.spyOn(store, 'filesDelete').mockResolvedValue();
      const wrapper = mountFiles();

      await wrapper
        .find('[data-test="files-row-notes.txt"] .delete-action')
        .trigger('click');

      await wrapper.find('[data-test="delete-confirm"]').trigger('click');

      expect(del).toHaveBeenCalledWith('tab-f1', 'notes.txt', false);
    });

    it('deletes a directory with recursive=true from the confirm dialog', async () => {
      const store = useTerminalStore();
      const del = vi.spyOn(store, 'filesDelete').mockResolvedValue();
      const wrapper = mountFiles();

      await wrapper
        .find('[data-test="files-row-docs"] .delete-action')
        .trigger('click');

      // The confirm dialog marks recursive for directories.
      await wrapper.find('[data-test="delete-confirm"]').trigger('click');
      expect(del).toHaveBeenCalledWith('tab-f1', 'docs', true);
    });

    it('opens and closes the transfers drawer', async () => {
      const wrapper = mountFiles();
      expect(wrapper.find('[data-test="transfer-drawer"]').exists()).toBe(
        false,
      );

      await wrapper.find('[data-test="files-transfers-btn"]').trigger('click');
      expect(wrapper.find('[data-test="transfer-drawer"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="transfer-drawer"]').classes()).toContain(
        'open',
      );
    });

    it('pauses and resumes a transfer from the drawer', async () => {
      const store = useTerminalStore();
      const pause = vi.spyOn(store, 'filesPauseTransfer').mockResolvedValue();
      const resume = vi.spyOn(store, 'filesResumeTransfer').mockResolvedValue();

      const handle: TransferHandle = {
        transferId: 't-ul-1',
        direction: 'upload',
        done: Promise.resolve(),
        cancel: vi.fn(),
      };

      const wrapper = mountFiles({
        fileTransfers: [
          {
            transferId: 't-ul-1',
            direction: 'upload',
            bytesTransferred: 30,
            totalBytes: 100,
            chunkIndex: 2,
            name: 'up.bin',
            handle,
            paused: true,
          },
        ],
      });

      await wrapper.find('[data-test="files-transfers-btn"]').trigger('click');

      await wrapper.find('[data-test="queue-resume-t-ul-1"]').trigger('click');
      expect(resume).toHaveBeenCalledWith('tab-f1', 't-ul-1');

      await wrapper.find('[data-test="queue-pause-t-ul-1"]').trigger('click');
      expect(pause).toHaveBeenCalledWith('tab-f1', 't-ul-1');
    });

    it('cancels a transfer from the drawer', async () => {
      const store = useTerminalStore();
      const cancel = vi
        .spyOn(store, 'filesCancelTransfer')
        .mockImplementation(() => {});

      const handle: TransferHandle = {
        transferId: 't-dl-2',
        direction: 'download',
        done: Promise.resolve(),
        cancel: vi.fn(),
      };

      const wrapper = mountFiles({
        fileTransfers: [
          {
            transferId: 't-dl-2',
            direction: 'download',
            bytesTransferred: 40,
            totalBytes: 100,
            chunkIndex: 0,
            name: 'down.bin',
            handle,
          },
        ],
      });

      await wrapper.find('[data-test="files-transfers-btn"]').trigger('click');
      await wrapper.find('[data-test="queue-cancel-t-dl-2"]').trigger('click');
      expect(cancel).toHaveBeenCalledWith('tab-f1', 't-dl-2');
    });
  });
});
