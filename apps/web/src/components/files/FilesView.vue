<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowUp,
  File as FileIcon,
  Folder,
  RefreshCw,
  Upload,
  X,
} from '@lucide/vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import type { RemoteFile } from '@ponter/shared';

const props = defineProps<{ tab: TabItem }>();
const store = useTerminalStore();

const fileInput = ref<HTMLInputElement | null>(null);

const currentPath = computed(() => props.tab.filesPath ?? '');
const segments = computed(() => currentPath.value.split('/').filter(Boolean));
const atRoot = computed(() => currentPath.value === '');
const entries = computed(() => props.tab.fileList?.entries ?? []);
const transfers = computed(() => props.tab.fileTransfers ?? []);

/** Human sizes per spec §7.1: B / KiB / MiB / GiB, one decimal from KiB up. */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = size;
  let unit: (typeof units)[number] = 'KiB';
  for (const u of units) {
    unit = u;
    value /= 1024;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatModified(iso: string): string {
  return new Date(iso).toLocaleString();
}

function percentOf(t: {
  bytesTransferred: number;
  totalBytes: number;
}): number {
  if (t.totalBytes <= 0) return 0;
  return Math.min(100, Math.floor((t.bytesTransferred / t.totalBytes) * 100));
}

function parentPath(): string {
  const parts = segments.value.slice(0, -1);
  return parts.join('/');
}

function navigate(path: string): void {
  void store.filesNavigate(props.tab.id, path);
}

function onRowClick(entry: RemoteFile): void {
  if (entry.isDirectory) navigate(entry.path);
  else void store.filesDownload(props.tab.id, entry.path);
}

function refresh(): void {
  navigate(currentPath.value);
}

function onUploadClick(): void {
  fileInput.value?.click();
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset so picking the same file again still fires `change`.
  input.value = '';
  if (file) void store.filesUpload(props.tab.id, file);
}
</script>

<template>
  <div data-test="files-view" class="flex h-full min-h-0 flex-col">
    <!-- Toolbar: up / refresh / breadcrumb / upload -->
    <div
      class="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-xs"
    >
      <button
        data-test="files-up"
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        title="Up one level"
        aria-label="Up one level"
        :disabled="atRoot"
        @click="navigate(parentPath())"
      >
        <ArrowUp class="w-3.5 h-3.5" />
      </button>
      <button
        data-test="files-refresh"
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Refresh listing"
        aria-label="Refresh listing"
        @click="refresh()"
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>

      <nav
        class="flex min-w-0 flex-1 items-center gap-1 font-mono"
        aria-label="Current path"
      >
        <button
          data-test="files-crumb-root"
          class="flex-shrink-0 hover:text-foreground"
          :class="atRoot ? 'text-foreground' : 'text-muted-foreground'"
          @click="navigate('')"
        >
          root
        </button>
        <template
          v-for="(segment, index) in segments"
          :key="`${index}-${segment}`"
        >
          <span class="flex-shrink-0 text-muted-foreground">/</span>
          <button
            :data-test="`files-crumb-${index}`"
            class="truncate"
            :class="
              index === segments.length - 1
                ? 'text-foreground'
                : 'text-muted-foreground'
            "
            @click="navigate(segments.slice(0, index + 1).join('/'))"
          >
            {{ segment }}
          </button>
        </template>
      </nav>

      <button
        data-test="files-upload"
        class="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        @click="onUploadClick()"
      >
        <Upload class="w-3.5 h-3.5" />
        Upload
      </button>
      <!-- Hidden picker: one file per pick, uploaded into the current dir. -->
      <input
        ref="fileInput"
        id="files-upload-input"
        data-test="files-upload-input"
        type="file"
        aria-label="Upload a file"
        class="hidden"
        @change="onFilePicked"
      />
    </div>

    <!-- Error banner: the store maps FilesError.code to this text (§7.1). -->
    <div
      v-if="tab.fileError"
      data-test="files-error"
      role="alert"
      class="flex flex-shrink-0 items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <span class="truncate">{{ tab.fileError }}</span>
      <button
        data-test="files-error-dismiss"
        class="flex-shrink-0 rounded p-0.5 hover:bg-destructive/20"
        aria-label="Dismiss error"
        @click="store.clearFileError(tab.id)"
      >
        <X class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Listing -->
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-card/95 text-left text-muted-foreground">
          <tr>
            <th class="px-3 py-1.5 font-medium">Name</th>
            <th class="w-24 px-3 py-1.5 text-right font-medium">Size</th>
            <th class="w-48 px-3 py-1.5 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.path"
            :data-test="`files-row-${entry.name}`"
            class="cursor-pointer border-t border-border/50 hover:bg-muted/50"
            tabindex="0"
            @click="onRowClick(entry)"
            @keydown.enter="onRowClick(entry)"
          >
            <td class="px-3 py-1.5">
              <span class="flex items-center gap-2">
                <Folder
                  v-if="entry.isDirectory"
                  class="w-3.5 h-3.5 flex-shrink-0 text-primary"
                />
                <FileIcon
                  v-else
                  class="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                />
                <span class="truncate">{{ entry.name }}</span>
              </span>
            </td>
            <td class="px-3 py-1.5 text-right font-mono text-muted-foreground">
              {{ entry.isDirectory ? '—' : formatSize(entry.size) }}
            </td>
            <td class="px-3 py-1.5 font-mono text-muted-foreground">
              {{ formatModified(entry.modifiedAt) }}
            </td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="!tab.fileList"
        class="p-6 text-center text-xs text-muted-foreground"
      >
        Loading…
      </p>
      <p
        v-else-if="entries.length === 0"
        class="p-6 text-center text-xs text-muted-foreground"
      >
        This folder is empty
      </p>

      <p
        v-if="tab.fileList?.truncated"
        data-test="files-truncated"
        class="px-3 py-1.5 text-[11px] text-amber-500"
      >
        Listing truncated: showing the first 4096 entries.
      </p>
    </div>

    <!-- Transfer footer: one line per active transfer, with cancel (§7.1). -->
    <div
      v-if="transfers.length"
      class="flex-shrink-0 space-y-1 border-t border-border px-3 py-1.5"
    >
      <div
        v-for="t in transfers"
        :key="t.transferId"
        :data-test="`files-transfer-${t.transferId}`"
        class="flex items-center gap-2 text-xs font-mono"
      >
        <span class="text-muted-foreground">
          {{ t.direction === 'download' ? '↓' : '↑' }}
        </span>
        <span class="max-w-[220px] truncate">{{ t.name }}</span>
        <span class="text-muted-foreground">{{ percentOf(t) }}%</span>
        <button
          :data-test="`files-cancel-${t.transferId}`"
          class="rounded p-0.5 text-muted-foreground hover:text-destructive"
          :aria-label="`Cancel transfer of ${t.name}`"
          @click="store.filesCancelTransfer(tab.id, t.transferId)"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
