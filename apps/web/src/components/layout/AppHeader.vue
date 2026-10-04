<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import ThemeToggle from './ThemeToggle.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Terminal, LayoutDashboard, ShieldCheck, LogOut } from '@lucide/vue';

const props = withDefaults(
  defineProps<{
    /**
     * Full-bleed mode: the header bar spans the viewport edge to edge so it
     * aligns with app-shell pages (workspace). Regular pages keep the
     * centered content column.
     */
    fluid?: boolean;
  }>(),
  { fluid: false },
);

const headerInnerClass = computed(() =>
  props.fluid
    ? 'flex h-14 w-full items-center justify-between px-4 sm:px-6'
    : 'container mx-auto flex h-14 items-center justify-between px-4 sm:px-6',
);

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const userInitials = computed(() => {
  const name = authStore.user?.username || 'U';
  return name.slice(0, 2).toUpperCase();
});

async function handleLogout() {
  await authStore.logout();
  router.push('/login');
}
</script>

<template>
  <header
    class="border-b border-border/80 bg-card/90 backdrop-blur-md sticky top-0 z-40 transition-colors"
  >
    <div :class="headerInnerClass">
      <div class="flex items-center gap-6">
        <router-link
          to="/"
          class="flex items-center gap-2.5 font-bold tracking-tight group"
        >
          <div
            class="w-8 h-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center text-primary transition-all group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-sm"
          >
            <Terminal class="w-4 h-4" />
          </div>
          <div class="flex flex-col">
            <div class="flex items-center gap-1.5 leading-none">
              <span class="text-base font-extrabold tracking-tight"
                >Ponter</span
              >
              <span
                class="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                >REMOTE</span
              >
            </div>
          </div>
        </router-link>

        <nav
          v-if="authStore.isAuthenticated"
          class="hidden md:flex items-center gap-1 text-sm"
        >
          <router-link
            to="/dashboard"
            class="flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors"
            :class="
              route.name === 'dashboard'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            "
          >
            <LayoutDashboard class="w-4 h-4" />
            Dashboard
          </router-link>
          <router-link
            to="/workspace"
            class="flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors"
            :class="
              route.name === 'workspace'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            "
          >
            <Terminal class="w-4 h-4" />
            Workspace
          </router-link>
          <router-link
            v-if="authStore.user?.role === 'admin'"
            to="/admin"
            class="flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors"
            :class="
              route.name === 'admin'
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            "
          >
            <ShieldCheck class="w-4 h-4 text-violet-500" />
            Admin
          </router-link>
        </nav>
      </div>

      <div class="flex items-center gap-3">
        <div
          v-if="authStore.isAuthenticated"
          class="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-mono"
        >
          <span
            class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"
          ></span>
          <span>E2EE Ready</span>
        </div>

        <ThemeToggle />

        <template v-if="authStore.isAuthenticated">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                class="relative h-9 w-9 rounded-full ring-offset-background hover:ring-2 hover:ring-ring/50 transition-all p-0"
              >
                <Avatar class="h-8 w-8 border border-border">
                  <AvatarFallback
                    class="bg-primary/10 text-primary font-mono text-xs font-semibold"
                  >
                    {{ userInitials }}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              class="w-56 shadow-lg border-border"
            >
              <DropdownMenuLabel class="font-normal p-3">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-semibold leading-none text-foreground">
                    {{ authStore.user?.username }}
                  </p>
                  <p
                    class="text-xs leading-none text-muted-foreground font-mono truncate"
                  >
                    {{ authStore.user?.email || 'No email registered' }}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div
                class="px-3 py-1.5 flex items-center justify-between text-xs text-muted-foreground"
              >
                <span class="flex items-center gap-1.5">
                  <ShieldCheck class="w-3.5 h-3.5 text-primary" />
                  Security Tier
                </span>
                <Badge
                  variant="secondary"
                  class="font-mono text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-none"
                >
                  ZERO-TRUST
                </Badge>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10 flex items-center gap-2"
                @click="handleLogout"
              >
                <LogOut class="w-4 h-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
        <template v-else>
          <router-link to="/login">
            <Button variant="ghost" size="sm">Login</Button>
          </router-link>
          <router-link to="/register">
            <Button size="sm">Register</Button>
          </router-link>
        </template>
      </div>
    </div>
  </header>
</template>
