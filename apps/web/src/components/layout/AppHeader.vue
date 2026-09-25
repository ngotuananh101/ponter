<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
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

const router = useRouter();
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
  <header class="border-b border-border bg-card">
    <div class="container mx-auto flex h-16 items-center justify-between px-4">
      <div class="flex items-center space-x-3">
        <router-link
          to="/"
          class="flex items-center space-x-2 text-xl font-bold tracking-tight"
        >
          <span class="text-primary font-extrabold">Ponta</span>
          <span class="text-muted-foreground font-normal">Remote</span>
        </router-link>
      </div>

      <div class="flex items-center space-x-4">
        <ThemeToggle />

        <template v-if="authStore.isAuthenticated">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="relative h-9 w-9 rounded-full">
                <Avatar class="h-9 w-9">
                  <AvatarFallback
                    class="bg-primary/10 text-primary font-medium"
                  >
                    {{ userInitials }}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-medium leading-none">
                    {{ authStore.user?.username }}
                  </p>
                  <p class="text-xs leading-none text-muted-foreground">
                    {{ authStore.user?.email || 'No email' }}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div
                class="px-2 py-1.5 flex items-center justify-between text-xs text-muted-foreground"
              >
                <span>Status</span>
                <Badge
                  variant="secondary"
                  class="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-none"
                >
                  Active
                </Badge>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="cursor-pointer text-destructive focus:text-destructive"
                @click="handleLogout"
              >
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
