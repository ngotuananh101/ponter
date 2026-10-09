# Desktop UI Synchronization & Visual Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize and elevate the visual design of the Ponter Desktop app (`apps/desktop`) to match the high-polish aesthetic of the Web UI (`apps/web`), adopting a focused compact installer/utility shell, rich card views with Lucide icons, interactive stepper navigation, and an integrated session logout capability.

**Architecture:** Adopt a centered compact utility layout in `App.vue` with an ambient gradient backdrop. Overhaul each view (`ServerSetupView`, `LoginView`, `WizardView`, `DevicesView`) into styled shadcn-vue cards using tokens from `packages/ui-components`, embedding `ThemeToggle` into card headers. Implement a clean `logout` IPC command in the Tauri Rust backend to securely purge memory tokens and OS keychain secrets, wiring it to the frontend `auth` store and `DevicesView`.

**Tech Stack:** Tauri v2, Rust, Vue 3, Pinia, TypeScript, shadcn-vue / Reka UI (`packages/ui-components`), Tailwind CSS v4, `@lucide/vue`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-desktop-ui-synchronization-design.md`

## Global Constraints

- **R8 Storage Gate (BINDING):** Absolutely zero references to `localStorage`, `sessionStorage`, or `indexedDB` in production code under `apps/desktop/src`. Automated check: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` must return empty.
- **TEST-INTEGRITY (BINDING):** Never remove, skip, or weaken tests to make suites pass. Preserve all existing 54 unit tests and all `data-testid` selectors across views (`server-setup-*`, `login-*`, `wizard-*`, `device-*`, `theme-toggle`).
- **UI Component Immutability:** Do not edit generated files under `packages/ui-components/src/components/ui/**`. Wrap or compose externally.
- **Security & Secret Boundaries:** Access tokens remain memory-only in `AppState`. Refresh tokens reside exclusively in the OS keychain. `logout` purges both.

## Review Focus

1. **Badge Nesting Defect (HTML Semantics):** In `DevicesView`, `<Badge>` must never be nested inside another `<Badge>`. `device-platform` and `device-online` must render as siblings while preserving exact testids and text contents.
2. **Persistence Integrity during Stepper Progress:** Stepper in `WizardView` must maintain reactive binding to `config.allowInput` (Gate A) and `store.autoStart` without race conditions or re-triggering probes unprompted.
3. **Storage Gate Verification (R8):** UI components, icons, or dropdowns must not introduce helper utilities that touch browser storage.
4. **Logout State Consistency:** Invoking `logout` must reset `authStore.user` to `null`, `authStore.status` to `'idle'`, clear memory `access_token`, delete OS keychain entry, and instantly transition `App.vue` back to `LoginView`.
5. **Theme Contrast & Dark Mode Consistency:** All cards, borders (`border-border/80`), backgrounds (`bg-card/95`), and text tokens must remain readable and high-contrast in both light and dark modes.

---

### Task 1: Backend `logout` Command & Frontend Auth Store Action

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/login.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/stores/auth.ts`
- Test: `apps/desktop/src-tauri/src/commands/login.rs` (unit test in module)
- Test: `apps/desktop/src/__tests__/login.test.ts`

**Interfaces:**
- Produces: `logout` Tauri command, `useAuthStore().logout(): Promise<void>`.
- Consumes: `AppState.access_token`, `keychain::delete_secret`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src-tauri/src/commands/login.rs`, add a test verifying `logout_impl`:
```rust
#[test]
fn logout_impl_clears_token_and_deletes_keychain() {
    let state = AppState::with_config(None);
    {
        let mut token = state.access_token.lock().unwrap();
        *token = Some("secret-token".into());
    }
    assert!(state.access_token.lock().unwrap().is_some());
    let res = logout_impl(&state);
    assert!(res.is_ok());
    assert!(state.access_token.lock().unwrap().is_none());
}
```

In `apps/desktop/src/__tests__/login.test.ts`, add a test for `authStore.logout()`:
```typescript
it('logout() clears user, sets status to idle, and invokes logout command', async () => {
  const store = useAuthStore();
  store.user = { id: 'u1', username: 'alice', email: null, role: 'user' };
  store.status = 'authenticated';
  vi.mocked(invoke).mockResolvedValue(undefined);

  await store.logout();

  expect(store.user).toBeNull();
  expect(store.status).toBe('idle');
  expect(store.isAuthenticated).toBe(false);
  expect(invoke).toHaveBeenCalledWith('logout');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logout_impl`
Expected: FAIL (`logout_impl` not found)

Run: `pnpm --filter @ponter/desktop test src/__tests__/login.test.ts`
Expected: FAIL (`store.logout is not a function`)

- [ ] **Step 3: Implement `logout` in backend and frontend store**

In `apps/desktop/src-tauri/src/commands/login.rs`:
```rust
#[tauri::command]
pub async fn logout(state: tauri::State<'_, AppState>) -> std::result::Result<(), String> {
    logout_impl(&state).map_err(|e| e.to_string())
}

pub fn logout_impl(state: &AppState) -> Result<()> {
    let mut access_token = state.access_token.lock().unwrap();
    *access_token = None;
    drop(access_token);

    keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)?;
    Ok(())
}
```

In `apps/desktop/src-tauri/src/lib.rs`, add `commands::login::logout` to `tauri::generate_handler!`:
```rust
        .invoke_handler(tauri::generate_handler![
            commands::login::login,
            commands::login::logout,
            commands::wizard::probe_server,
            // ...
```

In `apps/desktop/src/stores/auth.ts`:
```typescript
  async function logout(): Promise<void> {
    try {
      await invoke('logout');
    } finally {
      user.value = null;
      status.value = 'idle';
      error.value = null;
    }
  }

  return {
    user,
    status,
    error,
    isAuthenticated,
    login,
    logout,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logout_impl`
Expected: PASS

Run: `pnpm --filter @ponter/desktop test src/__tests__/login.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/login.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/stores/auth.ts apps/desktop/src/__tests__/login.test.ts
git commit -m "feat(desktop): add logout command and authStore.logout action"
```

---

### Task 2: App Shell Wrapper & `ThemeToggle` Refactoring in `App.vue`

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/__tests__/app.test.ts`

**Interfaces:**
- Consumes: `useConfigStore`, `useAuthStore`, `useWizardStore`.
- Produces: Polished centered utility window shell container.

- [ ] **Step 1: Write test for shell container**

In `apps/desktop/src/__tests__/app.test.ts`, assert the outer layout container:
```typescript
it('renders the centered utility window shell', async () => {
  const wrapper = await mountApp();
  expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test src/__tests__/app.test.ts`
Expected: FAIL (`[data-testid="app-shell"]` not found)

- [ ] **Step 3: Update `App.vue`**

Remove the floating `<ThemeToggle class="fixed right-3 top-3 z-50" />` from `App.vue`. Wrap the conditional views in a centered container:
```html
<template>
  <div
    data-testid="app-shell"
    class="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-background via-background to-muted/20 select-none text-foreground"
  >
    <ServerSetupView v-if="!configStore.hasServerUrl || configStore.editing" />
    <LoginView v-else-if="!authStore.isAuthenticated" />
    <WizardView v-else-if="!wizardStore.completed" />
    <DevicesView v-else />
  </div>
</template>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test src/__tests__/app.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/__tests__/app.test.ts
git commit -m "refactor(desktop): wrap App.vue in centered utility shell"
```

---

### Task 3: Visual Overhaul of `ServerSetupView.vue` (ADR-70)

**Files:**
- Modify: `apps/desktop/src/views/ServerSetupView.vue`
- Test: `apps/desktop/src/__tests__/serverSetup.test.ts`

**Interfaces:**
- Consumes: `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` from `@/components/ui/card`, `Input`, `Label`, `Button`, `Alert`, `ThemeToggle`, Lucide icons (`Server`, `Globe`, `Loader2`).
- Preserves: `server-setup-root`, `server-setup-help`, `server-setup-url`, `server-setup-connect`, `server-setup-message`.

- [ ] **Step 1: Verify current tests pass before modification**

Run: `pnpm --filter @ponter/desktop test src/__tests__/serverSetup.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 2: Redesign `ServerSetupView.vue`**

Replace the raw unstyled HTML with a styled Card matching the Web design language:
```html
<template>
  <div data-testid="server-setup-root" class="w-full max-w-md">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-2 pb-4">
        <div class="flex items-center justify-between">
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Server class="w-5 h-5" />
          </div>
          <ThemeToggle />
        </div>
        <div>
          <CardTitle class="text-2xl font-bold tracking-tight">Server Connection</CardTitle>
          <CardDescription data-testid="server-setup-help" class="text-sm text-muted-foreground mt-0.5">
            Enter your Ponter server URL to verify connectivity.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label for="server-setup-url" class="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Globe class="w-3.5 h-3.5 text-muted-foreground" />
            Server URL
          </Label>
          <Input
            id="server-setup-url"
            type="url"
            data-testid="server-setup-url"
            placeholder="http://localhost:8787"
            v-model="url"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary font-mono"
            @keydown.enter.prevent="connect"
          />
        </div>

        <Alert
          v-if="probe && !probe.ok"
          data-testid="server-setup-message"
          variant="destructive"
          role="alert"
          aria-live="polite"
        >
          <AlertDescription>{{ probe.message }}</AlertDescription>
        </Alert>

        <Button
          data-testid="server-setup-connect"
          :disabled="loading || !url"
          class="w-full font-medium"
          @click="connect"
        >
          <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
          {{ loading ? 'Probing...' : 'Connect' }}
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `pnpm --filter @ponter/desktop test src/__tests__/serverSetup.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/views/ServerSetupView.vue
git commit -m "feat(desktop): modernize ServerSetupView to shadcn card with theme toggle"
```

---

### Task 4: Visual Overhaul of `LoginView.vue` (ADR-70 Web Parity)

**Files:**
- Modify: `apps/desktop/src/views/LoginView.vue`
- Test: `apps/desktop/src/__tests__/login.test.ts`

**Interfaces:**
- Consumes: `@/components/ui/card`, `@/components/ui/input`, `@/components/ui/label`, `@/components/ui/button`, `@/components/ui/alert`, `@/components/ThemeToggle.vue`, Lucide icons (`Terminal`, `ShieldCheck`, `User`, `Lock`, `Loader2`).
- Preserves: `login-username`, `login-password`, `login-error`, `login-submit`, `login-server-line`, `login-change-server`.

- [ ] **Step 1: Verify current tests pass before modification**

Run: `pnpm --filter @ponter/desktop test src/__tests__/login.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 2: Redesign `LoginView.vue`**

Upgrade `LoginView.vue` to match `LoginForm.vue` from `apps/web`:
```html
<template>
  <main class="w-full max-w-md">
    <h1 class="sr-only">Login</h1>
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-2 pb-4">
        <div class="flex items-center justify-between">
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Terminal class="w-5 h-5" />
          </div>
          <div class="flex items-center gap-2">
            <div
              class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
            >
              <ShieldCheck class="w-3.5 h-3.5 text-primary" />
              <span>Token Auth</span>
            </div>
            <ThemeToggle />
          </div>
        </div>
        <div>
          <CardTitle class="text-2xl font-bold tracking-tight">Ponter Desktop</CardTitle>
          <CardDescription class="text-sm text-muted-foreground mt-0.5">
            Sign in to your Ponter account
          </CardDescription>
        </div>
        <div
          class="flex items-center justify-between p-2 rounded-md bg-muted/40 border border-border/60 text-xs font-mono text-muted-foreground"
          data-testid="login-server-line"
        >
          <span class="truncate">Server: {{ config.serverUrl || 'not set' }}</span>
          <button
            type="button"
            data-testid="login-change-server"
            class="ml-2 text-primary hover:underline font-medium cursor-pointer"
            @click="config.editing = true"
          >
            Change
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="login-username" class="text-xs font-medium text-foreground flex items-center gap-1.5">
              <User class="w-3.5 h-3.5 text-muted-foreground" />
              Username
            </Label>
            <Input
              id="login-username"
              data-testid="login-username"
              v-model="username"
              type="text"
              placeholder="Username"
              autocomplete="username"
              :disabled="store.status === 'loading'"
              class="bg-background/60 text-sm focus-visible:ring-primary"
            />
          </div>
          <div class="space-y-2">
            <Label for="login-password" class="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Lock class="w-3.5 h-3.5 text-muted-foreground" />
              Password
            </Label>
            <Input
              id="login-password"
              data-testid="login-password"
              v-model="password"
              type="password"
              placeholder="Password"
              autocomplete="current-password"
              :disabled="store.status === 'loading'"
              class="bg-background/60 text-sm focus-visible:ring-primary"
            />
          </div>
          <Alert
            v-if="store.error"
            data-testid="login-error"
            variant="destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertDescription>{{ store.error }}</AlertDescription>
          </Alert>
          <Button
            data-testid="login-submit"
            type="submit"
            :disabled="store.status === 'loading'"
            class="w-full font-medium"
          >
            <Loader2 v-if="store.status === 'loading'" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.status === 'loading' ? 'Signing in...' : 'Sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </main>
</template>
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `pnpm --filter @ponter/desktop test src/__tests__/login.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/views/LoginView.vue
git commit -m "feat(desktop): overhaul LoginView to match web design with token badge and theme toggle"
```

---

### Task 5: Stepper Navigation & Visual Overhaul of `WizardView.vue` (ADR-71)

**Files:**
- Modify: `apps/desktop/src/views/WizardView.vue`
- Test: `apps/desktop/src/__tests__/wizard.test.ts`

**Interfaces:**
- Consumes: `@/components/ui/card`, `@/components/ui/button`, `@/components/ui/checkbox`, `@/components/ui/label`, `@/components/ui/alert`, `@/components/ThemeToggle.vue`, Lucide icons (`Monitor`, `ShieldCheck`, `Zap`, `CheckCircle2`, `Loader2`).
- Preserves: all 14 `data-testid` attributes in `WizardView`.

- [ ] **Step 1: Verify current tests pass before modification**

Run: `pnpm --filter @ponter/desktop test src/__tests__/wizard.test.ts`
Expected: PASS (22 passed)

- [ ] **Step 2: Redesign `WizardView.vue`**

Transform `WizardView.vue` into a Stepper Card:
```html
<template>
  <div data-testid="wizard-root" class="w-full max-w-lg">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-4 pb-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono font-medium px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
              AGENT SETUP
            </span>
          </div>
          <ThemeToggle />
        </div>

        <!-- Stepper Navigation -->
        <div class="grid grid-cols-3 gap-2 border-b border-border/60 pb-3 text-xs font-medium">
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="store.step === 'capture' ? 'text-primary font-semibold border-b-2 border-primary' : 'text-muted-foreground'"
          >
            <Monitor class="w-3.5 h-3.5" />
            <span>1. Capture</span>
          </div>
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="store.step === 'inputGate' ? 'text-primary font-semibold border-b-2 border-primary' : 'text-muted-foreground'"
          >
            <ShieldCheck class="w-3.5 h-3.5" />
            <span>2. Input</span>
          </div>
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="store.step === 'autoStart' ? 'text-primary font-semibold border-b-2 border-primary' : 'text-muted-foreground'"
          >
            <Zap class="w-3.5 h-3.5" />
            <span>3. System</span>
          </div>
        </div>
      </CardHeader>

      <CardContent class="space-y-5">
        <!-- Step 1: Capture -->
        <div v-if="store.step === 'capture'" data-testid="wizard-step-capture" class="space-y-4">
          <div>
            <h1 class="text-xl font-bold tracking-tight">Screen Capture</h1>
            <p data-testid="wizard-capture-help" class="text-sm text-muted-foreground mt-1">
              Grant screen-recording permission when prompted, then verify capture.
            </p>
          </div>

          <Alert
            v-if="store.captureProbe && !store.captureProbe.ok"
            data-testid="wizard-capture-message"
            variant="destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertDescription>{{ store.captureProbe.message }}</AlertDescription>
          </Alert>

          <Button
            data-testid="wizard-probe-capture"
            :disabled="store.loading"
            class="w-full font-medium"
            @click="probeCapture"
          >
            <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.loading ? 'Probing...' : 'Verify Capture' }}
          </Button>
        </div>

        <!-- Step 2: Input Gate -->
        <div v-else-if="store.step === 'inputGate'" data-testid="wizard-step-input-gate" class="space-y-4">
          <div>
            <h1 class="text-xl font-bold tracking-tight">Input Gate</h1>
            <p data-testid="wizard-input-help" class="text-sm text-muted-foreground mt-1 leading-relaxed">
              Two gates protect your input. Gate A (this step) is the --allow-input preference that defaults to closed; enabling it allows the relay to forward keyboard/mouse events. Gate B is the peer-identity verification performed at admission — even with Gate A open, only verified peers can send input events.
            </p>
          </div>

          <label
            for="wizard-input-checkbox"
            class="p-3.5 rounded-lg border border-border/80 bg-muted/30 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/50 transition-colors"
          >
            <div class="space-y-0.5">
              <span class="text-sm font-medium text-foreground block">Allow remote input</span>
              <span class="text-xs text-muted-foreground block">Enable remote control of mouse and keyboard</span>
            </div>
            <Checkbox
              id="wizard-input-checkbox"
              data-testid="wizard-input-checkbox"
              v-model="config.allowInput"
              aria-label="Allow remote input"
            />
          </label>

          <Button
            data-testid="wizard-finish"
            :disabled="store.loading"
            class="w-full font-medium"
            @click="finish"
          >
            <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.loading ? 'Saving...' : 'Continue' }}
          </Button>
        </div>

        <!-- Step 3: Auto-start -->
        <div v-else-if="store.step === 'autoStart'" data-testid="wizard-step-auto-start" class="space-y-4">
          <div>
            <h1 class="text-xl font-bold tracking-tight">All Set</h1>
            <p data-testid="wizard-autostart-help" class="text-sm text-muted-foreground mt-1">
              Adds Ponter to your system's startup so the agent runs on login. Takes effect at the next login.
            </p>
          </div>

          <label
            for="wizard-autostart-checkbox"
            class="p-3.5 rounded-lg border border-border/80 bg-muted/30 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/50 transition-colors"
          >
            <div class="space-y-0.5">
              <span class="text-sm font-medium text-foreground block">Auto-start the agent on login</span>
              <span class="text-xs text-muted-foreground block">Launch agent in background at system startup</span>
            </div>
            <Checkbox
              id="wizard-autostart-checkbox"
              data-testid="wizard-autostart-checkbox"
              :model-value="store.autoStart"
              @update:model-value="onAutoStartChange"
              aria-label="Auto-start the agent on login"
            />
          </label>

          <Alert
            v-if="store.autoStartError"
            data-testid="wizard-autostart-error"
            variant="destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertDescription>{{ store.autoStartError }}</AlertDescription>
          </Alert>

          <Button
            data-testid="wizard-autostart-finish"
            :disabled="store.loading"
            class="w-full font-medium"
            @click="complete"
          >
            <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.loading ? 'Saving...' : 'Done' }}
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `pnpm --filter @ponter/desktop test src/__tests__/wizard.test.ts`
Expected: PASS (22 passed)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/views/WizardView.vue
git commit -m "feat(desktop): overhaul WizardView with stepper progress and interactive option cards"
```

---

### Task 6: Visual Overhaul of `DevicesView.vue` & Session Logout Integration (ADR-72)

**Files:**
- Modify: `apps/desktop/src/views/DevicesView.vue`
- Test: `apps/desktop/src/__tests__/devices.test.ts`

**Interfaces:**
- Consumes: `useAuthStore`, `useDevicesStore`, `useConfigStore`, `@/components/ui/card`, `@/components/ui/button`, `@/components/ui/badge`, `@/components/ui/alert`, `@/components/ui/alert-dialog`, `@/components/ThemeToggle.vue`, Lucide icons (`Laptop`, `Server`, `LogOut`, `Plus`, `Trash2`, `Info`, `ShieldCheck`).
- Preserves: all `data-testid` attributes in `DevicesView.vue`.

- [ ] **Step 1: Write test for logout button in `DevicesView`**

In `apps/desktop/src/__tests__/devices.test.ts`, add a test verifying logout:
```typescript
it('logout button triggers authStore.logout', async () => {
  const wrapper = mount(DevicesView);
  const authStore = useAuthStore();
  const logoutSpy = vi.spyOn(authStore, 'logout').mockResolvedValue(undefined);

  const logoutBtn = wrapper.find('[data-testid="devices-logout"]');
  expect(logoutBtn.exists()).toBe(true);
  await logoutBtn.trigger('click');

  expect(logoutSpy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test src/__tests__/devices.test.ts`
Expected: FAIL (`[data-testid="devices-logout"]` not found)

- [ ] **Step 3: Redesign `DevicesView.vue`**

Upgrade `DevicesView.vue` to Fleet Management Card, separating badges and adding logout:
```html
<template>
  <div data-testid="devices-root" class="w-full max-w-xl">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-3 pb-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Laptop class="w-4 h-4" />
            </div>
            <div>
              <CardTitle class="text-xl font-bold tracking-tight">Devices</CardTitle>
              <CardDescription data-testid="devices-username" class="text-xs text-muted-foreground font-mono">
                Signed in as {{ authStore.user?.username }}
              </CardDescription>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <ThemeToggle />
            <Button
              data-testid="devices-logout"
              variant="ghost"
              size="sm"
              class="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1.5"
              @click="authStore.logout"
            >
              <LogOut class="w-3.5 h-3.5" />
              <span>Log out</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent class="space-y-4">
        <Alert
          v-if="store.error"
          data-testid="devices-error"
          variant="destructive"
        >
          <AlertDescription>{{ store.error }}</AlertDescription>
        </Alert>

        <div v-if="store.loading" data-testid="devices-loading" class="py-8 text-center text-sm text-muted-foreground font-mono">
          Loading devices...
        </div>

        <div v-else-if="store.devices.length === 0" data-testid="devices-empty" class="py-8 text-center text-sm text-muted-foreground">
          No devices registered yet
        </div>

        <ul v-else data-testid="devices-list" class="space-y-2.5">
          <li
            v-for="device in store.devices"
            :key="device.id"
            data-testid="device-row"
            class="p-3.5 rounded-lg border border-border/60 bg-muted/20 hover:bg-muted/30 transition-colors flex items-center justify-between gap-4"
          >
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span data-testid="device-hostname" class="font-semibold text-sm text-foreground">
                  {{ device.hostname }}
                </span>
                <!-- Clean sibling badges (NO nesting defect) -->
                <Badge
                  variant="outline"
                  data-testid="device-platform"
                  class="text-[11px] font-mono px-1.5 py-0"
                >
                  {{ device.platform ?? 'unknown' }}
                </Badge>
                <Badge
                  data-testid="device-online"
                  :variant="device.isOnline ? 'default' : 'secondary'"
                  class="text-[11px] font-mono px-1.5 py-0 flex items-center gap-1"
                >
                  <span
                    v-if="device.isOnline"
                    class="w-1.5 h-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse"
                  />
                  {{ device.isOnline ? 'online' : 'offline' }}
                </Badge>
              </div>
              <div class="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                <span data-testid="device-id" class="truncate">{{ device.id }}</span>
                <span>·</span>
                <span data-testid="device-created">{{ device.createdAt }}</span>
              </div>
            </div>

            <Button
              data-testid="device-delete"
              variant="destructive"
              size="sm"
              class="shrink-0"
              @click="handleDelete(device.id)"
            >
              Delete
            </Button>
          </li>
        </ul>
      </CardContent>

      <CardFooter class="flex flex-col items-stretch gap-2.5 pt-2">
        <Button
          data-testid="devices-register"
          :disabled="store.loading"
          class="w-full font-medium"
          @click="handleRegister"
        >
          <Plus class="w-4 h-4 mr-1.5" />
          {{ store.loading ? 'Registering...' : 'Register Device' }}
        </Button>
        <p v-if="!store.registered" data-testid="devices-register-hint" class="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
          <Info class="w-3.5 h-3.5 text-primary shrink-0" />
          <span>The agent runtime runs from the system tray.</span>
        </p>
      </CardFooter>

      <!-- Delete confirmation dialog -->
      <AlertDialog
        :open="deleteDialogOpen"
        @update:open="(val: boolean) => { deleteDialogOpen = val; }"
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete device?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel @click="cancelDelete">Cancel</AlertDialogCancel>
            <AlertDialogAction @click="confirmDelete">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  </div>
</template>
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm --filter @ponter/desktop test src/__tests__/devices.test.ts`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/views/DevicesView.vue apps/desktop/src/__tests__/devices.test.ts
git commit -m "feat(desktop): overhaul DevicesView with OS status badges, unnested DOM, and logout action"
```

---

### Task 7: Full Verification & R8 Storage Audit

**Files:**
- Verification only

- [ ] **Step 1: Run frontend vitest test suite**

Run: `pnpm --filter @ponter/desktop test`
Expected: 55+ tests pass (100% GREEN)

- [ ] **Step 2: Run frontend lint & typecheck**

Run: `pnpm --filter @ponter/desktop lint && pnpm --filter @ponter/desktop typecheck`
Expected: 0 errors

- [ ] **Step 3: Run backend rust tests & clippy**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 88 tests pass, 0 clippy warnings

- [ ] **Step 4: Run R8 Storage Gate check**

Run: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"`
Expected: EMPTY output (0 matches in production code)

- [ ] **Step 5: Run whole-workspace typecheck and test**

Run: `pnpm typecheck && pnpm test:node`
Expected: ALL pass clean
