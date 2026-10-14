<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Terminal, Laptop, Radio, Server, ShieldCheck } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';

defineProps<{ open: boolean }>();
defineEmits<{ (e: 'update:open', value: boolean): void }>();
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent
      class="sm:max-w-3xl"
      data-test="encryption-by-channel-dialog"
    >
      <DialogHeader>
        <DialogTitle>Encryption by Channel</DialogTitle>
        <DialogDescription>
          Truthful security architecture: application-layer E2EE vs
          transport-only
        </DialogDescription>
      </DialogHeader>

      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr
              class="text-left text-[11px] text-muted-foreground border-b border-border/60"
            >
              <th class="py-2.5 px-4 font-medium first:pl-1 last:pr-1">
                Channel
              </th>
              <th class="py-2.5 px-4 font-medium first:pl-1 last:pr-1">
                Mechanism
              </th>
              <th class="py-2.5 px-4 font-medium first:pl-1 last:pr-1">
                Details
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/50">
            <tr data-test="sec-channel-terminal">
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap font-medium text-foreground"
              >
                <div class="flex items-center gap-2">
                  <Terminal class="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>Terminal I/O (PTY)</span>
                </div>
              </td>
              <td class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap">
                <Badge variant="outline" class="text-xs font-mono"
                  >E2EE · AES-GCM-256</Badge
                >
              </td>
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 text-muted-foreground leading-relaxed"
              >
                ECDH P-256 → HKDF-SHA256, session key bound to Ed25519 signature
                (when the agent advertises e2ee)
              </td>
            </tr>
            <tr data-test="sec-channel-input">
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap font-medium text-foreground"
              >
                <div class="flex items-center gap-2">
                  <Laptop class="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>Desktop control input</span>
                </div>
              </td>
              <td class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap">
                <Badge variant="outline" class="text-xs font-mono"
                  >E2EE · AES-GCM-256</Badge
                >
              </td>
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 text-muted-foreground leading-relaxed"
              >
                Admitted only after verifying the peer's Ed25519 identity
                (ADR-41/42)
              </td>
            </tr>
            <tr data-test="sec-channel-video">
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap font-medium text-foreground"
              >
                <div class="flex items-center gap-2">
                  <Radio class="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>Desktop video stream</span>
                </div>
              </td>
              <td class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap">
                <Badge variant="secondary" class="text-xs font-mono"
                  >DTLS-SRTP</Badge
                >
              </td>
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 text-muted-foreground leading-relaxed"
              >
                WebRTC P2P transport encryption; no application-layer E2EE
                (keeps latency low & enables hardware decode)
              </td>
            </tr>
            <tr data-test="sec-channel-files">
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap font-medium text-foreground"
              >
                <div class="flex items-center gap-2">
                  <Server class="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>File transfer</span>
                </div>
              </td>
              <td class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap">
                <Badge variant="secondary" class="text-xs font-mono"
                  >DTLS / SCTP</Badge
                >
              </td>
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 text-muted-foreground leading-relaxed"
              >
                WebRTC DataChannel P2P
              </td>
            </tr>
            <tr data-test="sec-channel-signaling">
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap font-medium text-foreground"
              >
                <div class="flex items-center gap-2">
                  <ShieldCheck class="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>Signaling</span>
                </div>
              </td>
              <td class="py-3 px-4 first:pl-1 last:pr-1 whitespace-nowrap">
                <Badge variant="secondary" class="text-xs font-mono">TLS</Badge>
              </td>
              <td
                class="py-3 px-4 first:pl-1 last:pr-1 text-muted-foreground leading-relaxed"
              >
                Self-hosted server relays SDP/ICE metadata only; it never sees
                session payloads
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted-foreground mt-3">
        Application-layer E2EE applies to terminal and control-input channels
        only. Video and file transfer rely on WebRTC's mandatory transport
        encryption (DTLS/SRTP).
      </p>
    </DialogContent>
  </Dialog>
</template>
