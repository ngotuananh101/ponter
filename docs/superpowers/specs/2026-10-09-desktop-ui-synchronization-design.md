# Desktop UI Synchronization & Visual Overhaul — Design Spec

- **Status:** Draft (under user review)
- **Phase:** Desktop Visual Parity & Experience Hardening
- **Related:** `apps/desktop/src/App.vue`, `apps/desktop/src/views/{ServerSetupView,LoginView,WizardView,DevicesView}.vue`, `apps/desktop/src/stores/auth.ts`, `apps/desktop/src-tauri/src/commands/login.rs`, `apps/desktop/src-tauri/src/lib.rs`, `packages/ui-components`, `apps/web/src/components/auth/LoginForm.vue`, `apps/web/src/views/DashboardView.vue`.

---

## 1. Context & Motivation

Phase 7 delivered the core Tauri v2 desktop application, and Phase 8c established the server configuration resolution chain, config persistence, login ordering, and dark mode. However, the visual presentation of `apps/desktop` remained at a raw, functional wireframe level:
1. **Lack of an App Shell:** `App.vue` contains no container, no framing, and mounts `ThemeToggle` as a disconnected floating element (`fixed right-3 top-3 z-50`).
2. **Raw HTML in `ServerSetupView`:** Displays bare `<h1>`, `<p>`, `<Input>`, `<Button>` elements vertically centered with no Card, no visual framing, and no status styling.
3. **Unstyled Multi-Step `WizardView`:** Steps (Capture, Input Gate, Auto-Start) are presented as plain, unstyled HTML blocks with raw checkboxes and buttons, lacking stepper navigation, informative visual grouping, or status indication.
4. **Disparity in `LoginView`:** Uses a basic card lacking the brand identity, icons, and visual refinement present in `apps/web/src/components/auth/LoginForm.vue`.
5. **Bare Presentation in `DevicesView`:** Lacks operating system icons, live pulse status indicators, proper spacing, session logout capabilities, and contains an invalid nested badge defect (`<Badge>` nested inside `<Badge>` for platform/online).

In contrast, the web client (`apps/web`) features a refined design system built on `packages/ui-components` (shadcn-vue), OKLCH color tokens, dark mode support, `@lucide/vue` iconography, and tailored typography (`Inter` + `JetBrains Mono`).

**Goal:** Elevate `apps/desktop` to match the visual fidelity, polish, and UX standards of `apps/web`, adopting a focused **Compact Installer & Utility Shell** layout, while strictly preserving all existing test selectors, R8 storage rules, and security boundaries.

---

## 2. Architectural Decisions (ADR-69 to ADR-72)

### ADR-69: Compact Utility Window Shell & Unified Layout

- **Layout Structure:** Desktop application runs in a focused, frameless utility window. Rather than a top navigation bar designed for a browser, the app renders a centered, polished container:
  ```html
  <div class="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-background via-background to-muted/20 select-none">
    <!-- Active View Card -->
  </div>
  ```
- **Integrated Theme Control:** Remove the floating `fixed right-3 top-3 z-50` `ThemeToggle` from `App.vue`. Integrate `ThemeToggle` cleanly into the top-right action area of each view card (or card header).
- **Responsive Sizing:**
  - `ServerSetupView`: `max-w-md w-full`
  - `LoginView`: `max-w-md w-full`
  - `WizardView`: `max-w-lg w-full`
  - `DevicesView`: `max-w-xl w-full`

### ADR-70: ServerSetup & Login Visual Parity with Web

- **ServerSetupView:**
  - Wrapped in `<Card class="w-full max-w-md border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">`.
  - Header displays a branded `Server` icon container (`w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary`), title `Server Connection` (`text-xl font-bold tracking-tight`), description `server-setup-help`, and top-right `ThemeToggle`.
  - URL Input features clear labeling, placeholder `http://localhost:8787`, and connect button with spinning `Loader2` indicator.
  - Failures displayed in `Alert variant="destructive"` with icon and polite aria attributes.
  - Preserves: `server-setup-root`, `server-setup-help`, `server-setup-url`, `server-setup-connect`, `server-setup-message`.
- **LoginView:**
  - Matches `apps/web/src/components/auth/LoginForm.vue`.
  - Header displays `Terminal` icon box, `Token Auth` security badge (`font-mono text-xs`), title `Ponter Desktop`, and top-right `ThemeToggle`.
  - Server line (`login-server-line`) styled as a sleek badge/pill: `Server: <url>` with an inline `Change` button (`login-change-server`).
  - Inputs feature leading `@lucide/vue` icons (`User`, `Lock`) and clean focus rings.
  - Preserves: `login-username`, `login-password`, `login-error`, `login-submit`, `login-server-line`, `login-change-server`.

### ADR-71: Stepper-based Multi-step Wizard

- **Visual Stepper Navigation:**
  - Header includes a 3-step visual progress bar:
    1. **Screen Capture** (`Monitor` icon)
    2. **Input Gate** (`ShieldCheck` icon)
    3. **Auto-Start** (`Zap` icon)
  - States:
    - Active: `text-primary font-medium border-b-2 border-primary`
    - Completed: `text-emerald-500 font-medium` with `CheckCircle2` icon
    - Upcoming: `text-muted-foreground`
- **Interactive Checkbox Cards:**
  - In Step 2 (Input Gate) and Step 3 (Auto-Start), replace bare checkboxes with interactive preference cards:
    - Bounded container: `p-3 rounded-lg border border-border/80 bg-muted/30 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/50 transition-colors`
    - Label and description on the left; checkbox on the right.
- **Clear Call-to-Actions:**
  - Primary action buttons full width or prominent aligned: `Verify Capture`, `Continue`, `Done`.
- **Preserves:** `wizard-root`, `wizard-step-capture`, `wizard-capture-help`, `wizard-probe-capture`, `wizard-capture-message`, `wizard-step-input-gate`, `wizard-input-help`, `wizard-input-checkbox`, `wizard-finish`, `wizard-step-auto-start`, `wizard-autostart-help`, `wizard-autostart-checkbox`, `wizard-autostart-error`, `wizard-autostart-finish`.

### ADR-72: Enhanced Devices Management & Session Logout

- **Header & Session Control:**
  - Card Header displays title `Devices`, user badge `Operator: <username>` (`devices-username`), and server URL indicator.
  - Action row on top-right: `ThemeToggle` and a dedicated **Logout** button (`LogOut` icon, ghost button).
  - Logout command cleans up `state.access_token` in memory, deletes the refresh token from OS keychain via `keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)`, resets auth store state, and navigates back to `LoginView`.
- **Fleet Device Rows:**
  - Individual device items wrapped in `rounded-lg border border-border/60 bg-muted/20 hover:bg-muted/30 p-3 flex items-center justify-between transition-colors`.
  - Platform icon (`Laptop` / `Server`) alongside hostname (`font-semibold text-sm`).
  - Fix invalid DOM badge nesting: render `device-platform` and `device-online` as sibling badges:
    ```html
    <Badge variant="outline" data-testid="device-platform">{{ device.platform ?? 'unknown' }}</Badge>
    <Badge :variant="device.isOnline ? 'default' : 'secondary'" data-testid="device-online" class="flex items-center gap-1.5">
      <span v-if="device.isOnline" class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      {{ device.isOnline ? 'online' : 'offline' }}
    </Badge>
    ```
  - Mono-formatted truncated ID (`data-testid="device-id"`) and localized timestamp (`data-testid="device-created"`).
  - Destructive delete action with confirmation modal (`AlertDialog`).
- **Footer:**
  - Prominent "Register Device" button (`devices-register`) with `Plus` icon.
  - Subtle informational hint box (`devices-register-hint`) explaining background system tray operation.

---

## 3. Security, Storage & Quality Invariants

1. **R8 Storage Gate (BINDING):**
   - Zero occurrences of `localStorage`, `sessionStorage`, or `indexedDB` in production code under `apps/desktop/src`.
   - Gate verification: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` must return EMPTY.
2. **TEST-INTEGRITY (BINDING):**
   - All 54 existing unit tests in `apps/desktop/src/__tests__/` must remain green.
   - All `data-testid` attributes must be preserved exactly as tested.
   - No assertions removed or weakened; new assertions added for logout functionality.
3. **Keychain & Token Handling (ADR-52):**
   - Access tokens remain memory-only in `AppState`.
   - Refresh tokens stored in OS keychain.
   - Logout removes keychain secret and clears memory token.

---

## 4. Scope & File Touch List

### Frontend (`apps/desktop/src`)
- `App.vue`: Remove floating toggle; introduce centered wrapper.
- `views/ServerSetupView.vue`: Overhaul to card layout, icon, header, theme toggle.
- `views/LoginView.vue`: Overhaul to card layout, Web parity, icons, pill server line, theme toggle.
- `views/WizardView.vue`: Overhaul to stepper card, icon headers, interactive checkbox cards.
- `views/DevicesView.vue`: Overhaul to fleet management card, OS icons, pulse badges, logout button, unnested badges.
- `stores/auth.ts`: Add `logout()` action calling backend `logout` and resetting state.
- `__tests__/*.test.ts`: Maintain existing tests, update any wrapper structure if needed (while keeping testids), add logout test.

### Backend (`apps/desktop/src-tauri`)
- `src/commands/login.rs`: Implement `logout` command (clears memory `access_token`, calls `keychain::delete_secret`).
- `src/lib.rs`: Register `logout` in `tauri::generate_handler!`.

---

## 5. Verification Plan

1. **Unit Tests:** `pnpm --filter @ponter/desktop test` passes all tests (54+).
2. **Lint & Typecheck:** `pnpm --filter @ponter/desktop lint` and `pnpm --filter @ponter/desktop typecheck` clean.
3. **R8 Storage Gate:** Automated grep check verifies zero webview storage in `apps/desktop/src`.
4. **Rust Clippy & Tests:** `cargo clippy` and `cargo test` clean in `apps/desktop/src-tauri`.
5. **Theme Switching:** Dark mode and light mode render with correct contrast, borders, and typography across all 4 views.
