# Minimalist Desktop UI Architecture (RustDesk/TeamViewer Model) — Design Spec

- **Status:** Draft (ready for team review)
- **Phase:** Desktop UI Streamlining & Zero-Click Onboarding
- **Date:** 2026-10-19
- **Supersedes / Amends:** Streamlines manual device registration and start/stop controls from Phase 7 (ADR-85 / ADR-86 / PR #155)
- **Related ADRs:** ADR-13 (Agent credentials), ADR-52 (Keychain isolation), ADR-64/65 (Config resolution & persistence), ADR-66 (Startup-flash gate), ADR-78 (Linux and Windows x86_64 support matrix), ADR-85 (Electron desktop shell with Vue 3 renderer), ADR-86 (Rust agent binary sidecar supervision), ADR-88 (Shared design layer integration), ADR-89 (Unified API client access)
- **Related Files:** `apps/desktop/src/renderer/views/DevicesView.vue`, `apps/desktop/src/renderer/stores/devices.ts`, `apps/desktop/src/renderer/stores/config.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/devices.ts`, `apps/desktop/src/shared/ipc-types.ts`, `apps/desktop/src/preload/index.ts`, `apps/web/src/views/WorkspaceView.vue`, `apps/desktop/src/main/__tests__/ipc.test.ts`, `apps/desktop/src/renderer/__tests__/devices.test.ts`

---

## 1. Context & Motivation

The Ponter desktop client (`apps/desktop`) was re-platformed to Electron 35 with a Vue 3 renderer (ADR-85) consuming shared design tokens and primitives from `@ponter/ui-components` (ADR-88). In its current implementation (`DevicesView.vue`), the authenticated view centers on an administrative device fleet table combined with manual registration controls:
1. **Manual Capability Configuration:** Users must select toggleable capability buttons ("Terminal", "Desktop", "Files") and manually click "Register Device" before the machine can receive remote sessions.
2. **Disconnected Sidecar Lifecycle Controls:** Starting and stopping the local background agent sidecar requires navigating a separate "Start Agent" / "Stop Agent" button in the status bar, creating confusion between whether the machine is "registered" versus "ready to be accessed".
3. **Absence of Outgoing Remote Initiation:** The desktop app currently acts solely as an agent host and device management panel. To initiate a remote control session to another machine, users are forced to leave the desktop app and open the web browser dashboard manually.

### The RustDesk / TeamViewer Paradigm

Popular remote desktop tools (RustDesk, AnyDesk, TeamViewer) succeed through a minimalist, two-pane operational model:
- **Left Pane ("This Device"):** Displays this machine's identity (Name, Platform, ID with quick copy), operational status, and a single master toggle ("Allow Remote Access") that runs or halts the background service.
- **Right Pane ("Remote Control"):** Provides a direct input field to enter a partner's machine ID, choose the desired session mode (Desktop, Terminal, or File Transfer), and connect immediately.
- **Bottom Pane ("My Devices"):** Presents a compact account device ledger allowing one-click connection to saved machines.

The project owner approved adopting this minimalist model for `apps/desktop`. The goal of this specification is to establish the complete architectural contract, UX layout, automation lifecycle, IPC extensions, and test criteria for this streamlined desktop experience.

---

## 2. Locked Owner Decisions

The following requirements have been approved by the owner and are binding:

1. **Two-Column Hero Layout:**
   - **Left Column ("This Device"):** Machine Hostname, Operating Platform badge, Device ID with quick-copy button, real-time connection status indicator, and a single master toggle "Allow Remote Access".
   - **Right Column ("Remote Control"):** Partner Device ID input field, target session mode selector (`Desktop` | `Terminal` | `Files`), and a primary "Connect" action button.
   - **Bottom Section ("My Devices"):** Compact list of all registered account devices featuring one-click connection and deletion capabilities.
2. **Elimination of Manual Administrative Friction:**
   - Remove manual capability selection checkboxes (`terminal`, `desktop`, `files`) from the primary view.
   - Remove separate manual "Start Agent" / "Stop Agent" buttons from the primary view.
   - "Allow Remote Access" toggle directly governs background sidecar execution (`AgentControlService`) and persists sticky user preference (`agentAutoStart`).
3. **Zero-Click Onboarding Automation:**
   - Upon entering the main authenticated view, if the local machine does not possess a `localAgentId` in `config.json` and keychain, the app silently registers the device in the background using the operating system hostname and full capabilities (`['desktop', 'terminal', 'files']`).
   - If "Allow Remote Access" is enabled (default on initial setup), the local agent sidecar starts automatically without requiring user clicks.
4. **IPC Remote Session Invocation:**
   - Introduce IPC channel `desktop:open-remote-session` accepting `{ targetId: string, mode: 'desktop' | 'terminal' | 'files' }`.
   - The Electron main process resolves the active `serverUrl`, constructs the target URL `${serverUrl}/workspace/${targetId}?mode=${mode}`, and opens it in the user's default browser via `shell.openExternal`.
5. **Component System & Window Constraints:**
   - Exclusively construct the UI using shadcn-vue primitives exported by `@ponter/ui-components`.
   - Maintain the standard desktop window geometry: 800x600 default dimensions with 480x500 minimum constraints, ensuring clean responsive stacking without clipping or scrollbar distortion.

---

## 3. Architecture & UX Specification

### 3.1 Hero Layout — Column 1: "This Device" (Incoming Access)

The left column represents the local machine's identity and governs whether external users can establish connections to it.

```
+-----------------------------------------------------------+
| This Device                                               |
| Manage incoming connections to this computer             |
|                                                           |
| Hostname:   DESKTOP-PRO                     [ Linux ]     |
| Device ID:  dev_a1b2c3d4                    [ Copy ID ]   |
| Status:     (*) Ready for connections                     |
|                                                           |
| [=======================================================] |
| Allow Remote Access                             [ TOGGLE ]|
| Enable to let authorized users connect to this device     |
+-----------------------------------------------------------+
```

#### Elements & Behaviors
- **Card Wrapper:** Built with `Card`, `CardHeader`, and `CardContent` from `@ponter/ui-components`.
- **Hostname & Platform:**
  - Displays the machine's hostname (resolved from `localDevice.hostname` or system fallback).
  - Displays a platform badge (`Badge` variant `outline`) indicating `linux` or `windows`.
- **Device ID & Clipboard Action:**
  - Displays the short, canonical device identifier (`dev_xxxxxxxx`).
  - Formatted with monospace typography (`font-mono text-sm bg-muted/30 px-2 py-1 rounded`).
  - Includes a "Copy ID" icon button (`Button` variant `ghost` or `outline` size `sm`).
  - Clicking "Copy ID" writes the ID to the system clipboard (`navigator.clipboard.writeText`) and renders transient feedback (e.g., toast notification or icon swap to checkmark for 2000ms).
- **Status Indicator:**
  - Displays real-time sidecar state pushed via `onRuntimeStatus`:
    - `connected` / `starting`: Pulsing emerald indicator (`bg-emerald-400 animate-pulse`), label "Ready for connections".
    - `disconnected`: Amber indicator (`bg-amber-400`), label "Connecting to server...".
    - `stopped`: Slate indicator (`bg-muted-foreground`), label "Remote access disabled".
    - `error`: Destructive indicator (`bg-red-400`), label "Agent encountered an error".
- **Master Toggle ("Allow Remote Access"):**
  - Implemented as an accessible switch or stylized toggle button (`data-testid="toggle-remote-access"`).
  - **State Synchronization:**
    - Evaluates to `true` when the sidecar is active (`agentRunning`) or `agentAutoStart` is configured.
    - Evaluates to `false` when the agent is stopped.
  - **Toggle Interaction:**
    - Toggling ON: Dispatches `window.ponter.startAgent()`, saves `agentAutoStart: true` via `saveConfig`, and updates status to starting.
    - Toggling OFF: Dispatches `window.ponter.stopAgent()`, saves `agentAutoStart: false` via `saveConfig`, and updates status to stopped.
    - Controls are disabled (`disabled: isPending`) while a start or stop request is serialized on `AgentControlService`.

---

### 3.2 Hero Layout — Column 2: "Remote Control" (Outgoing Connection)

The right column provides instant initiation of remote desktop, terminal, or file management sessions to partner devices.

```
+-----------------------------------------------------------+
| Remote Control                                            |
| Connect to and control a remote computer                  |
|                                                           |
| Partner Device ID                                         |
| [ Enter partner ID (e.g. dev_b2c3d4e5)                 ]  |
|                                                           |
| Session Mode                                              |
| [ (o) Desktop     ( ) Terminal     ( ) Files           ]  |
|                                                           |
| [                   Connect ->                          ] |
+-----------------------------------------------------------+
```

#### Elements & Behaviors
- **Partner Device ID Input:**
  - Standard `Input` primitive from `@ponter/ui-components` (`data-testid="remote-partner-id"`).
  - Placeholder: `"Enter partner ID (e.g. dev_xxxxxxxx)"`.
  - Auto-trims whitespace; validates that input is non-empty and conforms to standard agent ID format (`^[a-zA-Z0-9_-]{1,64}$`).
- **Session Mode Selector:**
  - Segmented control or radio button group (`data-testid="remote-session-mode"`).
  - Options:
    1. **Desktop (Default):** Interactive WebRTC screen streaming and input injection. Icon: `Monitor`.
    2. **Terminal:** Remote PTY shell session. Icon: `Terminal`.
    3. **Files:** Bidirectional SFTP file transfer queue. Icon: `Folder`.
- **Connect Action:**
  - Primary button (`Button` size `default`, class `w-full font-medium`).
  - Label: `"Connect"` with an outgoing icon (`ArrowUpRight`).
  - Disabled state: Disabled when partner ID is blank, invalid, or during IPC dispatch.
  - Action on Click:
    - Calls `window.ponter.openRemoteSession({ targetId, mode })`.
    - Handles failure gracefully: displays inline alert if server URL is missing or if URL invocation fails.

---

### 3.3 Bottom Section: "My Devices" (Account Fleet)

Located directly underneath the two hero cards, providing seamless 1-click access to all other machines associated with the logged-in user.

```
+-----------------------------------------------------------------------------------------+
| My Devices (3)                                                                          |
| Registered machines available under your account                                        |
|                                                                                         |
| Hostname        Platform     Device ID        Status     Actions                        |
| --------------------------------------------------------------------------------------- |
| workstation-01  [ Linux ]    dev_11223344     (o) Online [ Connect v ] [ Delete ]       |
| laptop-win11    [ Windows ]  dev_55667788     ( ) Offline[ Offline   ] [ Delete ]       |
| desktop-home    [ Linux ]    dev_a1b2c3d4 (*) (o) Online [ This device]                  |
+-----------------------------------------------------------------------------------------+
```

#### Elements & Behaviors
- **Compact List / Table View:**
  - Rendered in a clean bordered container (`border border-border/80 bg-card/95 rounded-lg`).
  - Max height constrained (`max-h-56` or flex-bounded) with smooth vertical scrolling (`overflow-y-auto`).
- **Row Columns:**
  - **Hostname & Platform:** Device name with platform badge (`linux` / `windows`).
  - **Device Identifier:** Monospace display (`font-mono text-xs text-muted-foreground`), with optional quick copy.
  - **Local Identifier Badge:** Distinct "This device" badge (`Badge` variant `outline`, border-primary/40 text-primary) rendered when `device.id === localAgentId`.
  - **Status Indicator:**
    - Online: Emerald pulsing dot (`w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse`) with text "online".
    - Offline: Muted dot with text "offline".
- **Row Actions:**
  - **Quick Connect:**
    - Active when `device.isOnline === true` and `device.id !== localAgentId`.
    - Button variant `default` or `outline` size `sm`.
    - Clicking connects with default mode (`desktop`) or opens a compact dropdown for `Desktop`, `Terminal`, `Files`.
    - Dispatches `openRemoteSession({ targetId: device.id, mode })`.
    - Disabled when the target device is offline or represents the local machine itself.
  - **Delete:**
    - Button variant `destructive` size `sm` with `Trash2` icon.
    - Opens standard `AlertDialog` confirmation modal before calling `store.remove(device.id)`.
    - If the deleted device is the current local machine (`device.id === localAgentId`), the main process purges `localAgentId` from `config.json` and stops the running agent sidecar.

---

## 4. Automation & Zero-Click Onboarding Lifecycle

### 4.1 Automated Background Registration

Under the previous workflow, a newly installed desktop app remained inactive until the user navigated the registration controls. Under this specification, registration is fully automated.

```
User logs in (or session auto-restores)
               │
               ▼
App lands on DevicesView.vue
               │
               ▼
Check localAgentId in config / keychain
               │
       ┌───────┴───────┐
       ▼               ▼
 localAgentId        localAgentId
   exists              is null
       │               │
       │               ▼
       │     Silently call store.register()
       │     - Hostname: os.hostname()
       │     - Capabilities: ['desktop', 'terminal', 'files']
       │     - Key generation & server registration
       │     - Credential saved to keychain
       │     - localAgentId saved to config.json
       │               │
       └───────┬───────┘
               ▼
Check allowRemoteAccess / agentAutoStart
               │
       ┌───────┴───────┐
       ▼               ▼
     false            true (default)
       │               │
       ▼               ▼
Agent remains    Silently call startAgent()
   stopped       - Verify binary & keychain
                 - Launch sidecar with 2000ms grace
                 - Transition runtime status to connected
```

#### Step-by-Step Execution
1. **Initial Mount Check:**
   - In `onMounted()`, `DevicesView.vue` reads `localAgentId` via `window.ponter.getLocalAgentId()`.
   - Concurrently, `store.refresh()` fetches the existing device list from the server.
2. **Silent Registration Dispatch:**
   - If `localAgentId === null`:
     - Sets non-blocking background registration indicator.
     - Calls `store.register(['desktop', 'terminal', 'files'])`.
     - `DeviceManager.registerDevice()` on the main process detects platform, generates `dev_xxxxxxxx` ID, creates the server agent record, stores the credential in `safeStorage`, and updates `localAgentId` in `config.json`.
     - Renderer updates its local reference `localAgentId.value = newId`.
3. **Automated Agent Launch:**
   - Following registration (or on mount if already registered):
   - Reads `config.agentAutoStart`. If `agentAutoStart !== false` (defaulting to true for fresh installs):
     - Calls `window.ponter.startAgent()`.
     - `AgentControlService` serializes the start request, verifies credentials, spawns `ponter-agent`, watches health across the 2000ms grace period, and broadcasts status changes to the UI.
4. **Error Resilience:**
   - If registration fails (e.g. network timeout or quota limit `AGENT_LIMIT_REACHED`), the failure is surfaced in a clean, dismissible `Alert` without preventing the user from using the "Remote Control" panel to access other machines.

---

## 5. IPC & Backend Integration Specifications

### 5.1 New Channel: `desktop:open-remote-session`

To allow the desktop client to initiate remote connections seamlessly, Electron's main process provides an external browser launching bridge.

#### IPC Interface (`src/shared/ipc-types.ts`)
```ts
export type RemoteSessionMode = 'desktop' | 'terminal' | 'files';

export interface OpenRemoteSessionPayload {
  targetId: string;
  mode: RemoteSessionMode;
}

export interface OpenRemoteSessionResult {
  ok: boolean;
  error?: string;
}

export interface PonterDesktopApi {
  // Existing channels 1-20...
  
  /**
   * Launch a remote session to a partner machine in the default system browser (Channel 21).
   */
  openRemoteSession(payload: OpenRemoteSessionPayload): Promise<OpenRemoteSessionResult>;
}
```

#### Main Process Implementation (`src/main/ipc.ts`)
```ts
import { shell } from 'electron';

// Channel 21: desktop:open-remote-session
ipcMain.handle(
  'desktop:open-remote-session',
  async (_event, payload: OpenRemoteSessionPayload): Promise<OpenRemoteSessionResult> => {
    // 1. Input validation
    if (!payload || typeof payload.targetId !== 'string') {
      return { ok: false, error: 'Invalid target agent ID' };
    }
    const targetId = payload.targetId.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(targetId)) {
      return { ok: false, error: 'Target ID contains invalid characters' };
    }

    const validModes: RemoteSessionMode[] = ['desktop', 'terminal', 'files'];
    const mode = validModes.includes(payload.mode) ? payload.mode : 'desktop';

    // 2. Resolve active server URL
    const effectiveUrl = config.load().serverUrl;
    if (!effectiveUrl) {
      return { ok: false, error: 'Server URL is not configured' };
    }

    // 3. Normalize URL and construct workspace destination
    try {
      const baseUrl = new URL(effectiveUrl);
      if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
        return { ok: false, error: 'Invalid server URL protocol' };
      }
      
      const destination = new URL(
        `/workspace/${encodeURIComponent(targetId)}`,
        baseUrl
      );
      destination.searchParams.set('mode', mode);

      // 4. Open in default operating system browser
      await shell.openExternal(destination.toString());
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to open remote session: ${message}` };
    }
  }
);
```

#### Preload Script Bridge (`src/preload/index.ts`)
```ts
openRemoteSession: (payload: OpenRemoteSessionPayload) =>
  ipcRenderer.invoke('desktop:open-remote-session', payload),
```

---

### 5.2 Web Companion Integration (`apps/web`)

When `shell.openExternal` launches `${serverUrl}/workspace/${targetId}?mode=${mode}`, the web application's `WorkspaceView.vue` consumes the query parameter:

```ts
// apps/web/src/views/WorkspaceView.vue
onMounted(() => {
  const initialAgentId = route.params.agentId as string | undefined;
  const initialMode = (route.query.mode as string | undefined)?.toLowerCase();

  if (initialAgentId) {
    if (initialMode === 'desktop') {
      terminalStore.openDesktopTab(initialAgentId);
    } else if (initialMode === 'files') {
      terminalStore.openFilesTab(initialAgentId);
    } else {
      // Default fallback to terminal shell
      terminalStore.openTab(initialAgentId);
    }
  }
  window.addEventListener('keydown', handleKeyDown);
});
```

This guarantees seamless end-to-end routing whether the user requests screen sharing, terminal execution, or file browsing.

---

## 6. Layout & Responsive Geometry

### 6.1 Geometry Constraints (ADR-85 / PR #148)
- **Base Dimensions:** 800px width x 600px height.
- **Minimum Dimensions:** 480px width x 500px height.
- **Scroll Behavior:** Main window body uses `overflow-hidden`. Inner content uses vertical auto-scrolling with bounded heights to prevent horizontal layout blowout.

### 6.2 Grid Layout Specification
- **Container:** `max-w-4xl mx-auto flex flex-col gap-4 p-4`
- **Hero Row:** `grid grid-cols-1 md:grid-cols-2 gap-4`
  - On standard 800px width: 2 equal-width columns side by side.
  - On narrow viewports (< 640px): Stacks gracefully into single column with consistent vertical spacing.
- **Fleet Table Container:** `flex-1 min-h-0 bg-card rounded-lg border border-border/80 p-4`
  - Table body bounded by `max-h-56` or flex scrolling.

---

## 7. Security & Isolation Considerations

1. **URL Protocol Injection Guard (S5144 / S5147):**
   - In `desktop:open-remote-session`, the destination URL is constructed using `new URL()` and strictly asserted against `http:` and `https:` protocols before passing to `shell.openExternal()`. Non-web schemes (e.g., `file:`, `javascript:`, `shell:`) are rejected immediately.
2. **Credential Isolation (ADR-13 / ADR-52 / R8):**
   - Automated registration stores the generated agent secret directly in the operating system keychain (`device_credential_${id}`) using Electron's `safeStorage`. The secret is never exposed to the Vue renderer, `config.json`, or renderer storage.
3. **Process Supervision Isolation (ADR-86 / Issue #154):**
   - The "Allow Remote Access" toggle controls the sidecar via `AgentControlService` with serialized queues. Child process errors are trapped without crashing the Electron main process, and stdout is ignored (`stdio: ['ignore', 'ignore', 'pipe']`) to prevent 64KB OS pipe buffer deadlocks.

---

## 8. Testing & Verification Strategy

### 8.1 Main Process Vitest Tests (`apps/desktop/src/main/__tests__/ipc.test.ts`)
- **IPC Registration Verification:** Assert all 21 channels are registered on `ipcMain`.
- **`desktop:open-remote-session` Tests:**
  - Verify rejection of invalid or malicious target IDs (e.g. `../etc/passwd`, script injections).
  - Verify rejection when `serverUrl` is unconfigured.
  - Verify rejection of invalid protocols (e.g. `file://`).
  - Verify successful invocation of `shell.openExternal` with correct encoded URL and mode query param.

### 8.2 Renderer View Vitest Tests (`apps/desktop/src/renderer/__tests__/devices.test.ts`)
- **Zero-Click Onboarding:**
  - Mock `getLocalAgentId` returning `null`.
  - Assert `store.register` is automatically invoked with `['desktop', 'terminal', 'files']`.
  - Assert `localAgentId` is updated and displayed on UI.
- **"This Device" Hero Card:**
  - Assert hostname, platform badge, and formatted device ID render properly.
  - Assert clicking "Copy ID" writes to clipboard.
  - Assert runtime status indicators match sidecar status (`connected`, `starting`, `stopped`).
- **"Allow Remote Access" Master Toggle:**
  - Assert toggling ON dispatches `startAgent()`.
  - Assert toggling OFF dispatches `stopAgent()`.
  - Assert toggle is disabled while operation is pending.
- **"Remote Control" Hero Card:**
  - Assert validation of partner ID input field.
  - Assert mode selector toggles between Desktop, Terminal, and Files.
  - Assert clicking "Connect" invokes `window.ponter.openRemoteSession({ targetId, mode })`.
- **"My Devices" Fleet Table:**
  - Assert device list renders in compact table with online/offline indicators.
  - Assert "This device" badge appears exclusively on the local machine's row.
  - Assert clicking 1-click connect on an online peer triggers `openRemoteSession`.
  - Assert connect button is disabled for offline devices and the local device row.
  - Assert delete button triggers `AlertDialog` confirmation and executes `store.remove()`.

### 8.3 Web Routing Test (`apps/web/src/__tests__/WorkspaceView.test.ts`)
- Assert visiting `/workspace/dev_123?mode=desktop` calls `openDesktopTab('dev_123')`.
- Assert visiting `/workspace/dev_123?mode=files` calls `openFilesTab('dev_123')`.
- Assert visiting `/workspace/dev_123?mode=terminal` (or omitted) calls `openTab('dev_123')`.

---

## 9. Backward Compatibility & Parity Ledger

| Existing Behavior (PR #155) | Minimalist UI Model (This Spec) | Migration Impact |
|---|---|---|
| Manual capability selection buttons (`Terminal`, `Desktop`, `Files`) in CardFooter | Removed from UI; automated registration applies full capabilities `['desktop', 'terminal', 'files']` silently | Zero friction; eliminates user capability confusion |
| Manual "Register Device" button required before agent can be used | Automated zero-click registration on first view mount | Seamless out-of-the-box readiness |
| Separate "Start Agent" / "Stop Agent" in runtime status bar | Unified into single "Allow Remote Access" toggle switch | Clear mental model matching RustDesk / TeamViewer |
| No outgoing remote session initiation from Desktop client | Hero "Remote Control" panel with target ID + mode selection | Enables direct connection from desktop app |
| Card layout with single device list | 2-column hero cards ("This Device" + "Remote Control") with compact "My Devices" fleet table below | Maximizes screen utility within 800x600 window |
| 20 IPC channels registered | 21 IPC channels registered (`desktop:open-remote-session` added) | Purely additive; 100% backward compatible |
