<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Menu, Search, LogOut, ShieldCheck, LockKeyhole, X, Activity } from '@lucide/vue';
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui';
import { Button } from '@/components/ui/button';
import NavigationContent from './NavigationContent.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';
import CommandPalette from './CommandPalette.vue';
import ServiceCreationDialog from './services/ServiceCreationDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { hasUnsavedChanges } from '@/composables/useDirtyForm';
import { errorMessage } from '@/lib/api';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const loggingOut = ref(false);
function shortcuts(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
    event.preventDefault();
    ui.commandOpen = !ui.commandOpen;
  }
}
function restoreNavigationFocus(event: Event) {
  event.preventDefault();
  document.getElementById('navigation-trigger')?.focus();
}
onMounted(() => window.addEventListener('keydown', shortcuts));
onUnmounted(() => window.removeEventListener('keydown', shortcuts));
async function logout() {
  if (
    hasUnsavedChanges() &&
    !(await ui.confirm({
      title: '退出并放弃当前编辑？',
      description: '当前表单有未保存的修改，退出后需要重新填写。',
      confirmText: '退出当前会话',
    }))
  )
    return;
  loggingOut.value = true;
  try {
    await auth.logout();
    await router.replace('/login');
  } catch (error) {
    ui.toast(errorMessage(error), 'error');
  } finally {
    loggingOut.value = false;
  }
}
</script>
<template>
  <a href="#main-content" class="skip-link">跳到主要内容</a>
  <div :class="['app-shell', { 'project-shell': !!route.params.projectId }]">
    <header class="app-header">
      <div class="header-brand">
        <Button
          class="mobile-menu"
          id="navigation-trigger"
          variant="ghost"
          size="icon"
          aria-label="打开导航"
          @click="ui.navigationOpen = true"
          ><Menu /></Button
        ><RouterLink to="/projects" class="brand" aria-label="Ozz 项目工作台"
          ><span class="brand-mark">o</span><span>Ozz</span></RouterLink
        >
      </div>
      <div class="header-tools">
        <button
          type="button"
          class="search-trigger"
          aria-label="快速打开项目与资源"
          aria-haspopup="dialog"
          :aria-expanded="ui.commandOpen"
          aria-keyshortcuts="Meta+K Control+K"
          @click="ui.commandOpen = true"
        >
          <Search class="size-4" /><span>快速打开项目与资源</span><kbd>⌘ K</kbd>
        </button>
        <div class="header-right">
          <RouterLink to="/deployments" class="activity-trigger" aria-label="活动与任务"
            ><Activity class="size-4" /><span class="mobile-hide">活动</span></RouterLink
          >
          <ThemeSwitcher />
          <div class="admin-chip">
            <span class="avatar">{{ auth.user?.username.slice(0, 1).toUpperCase() }}</span
            ><span class="mobile-hide">{{ auth.user?.username }}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="退出当前会话"
            :disabled="loggingOut"
            @click="logout"
            ><LogOut
          /></Button>
        </div>
      </div>
    </header>
    <aside class="app-sidebar">
      <NavigationContent />
      <div class="sidebar-footer"><ShieldCheck class="size-4" /><span>单管理员工作区</span></div>
    </aside>
    <DialogRoot v-model:open="ui.navigationOpen">
      <DialogPortal>
        <DialogOverlay class="nav-overlay" />
        <DialogContent class="nav-drawer" @close-auto-focus="restoreNavigationFocus">
          <DialogTitle class="sr-only">工作台导航</DialogTitle>
          <DialogDescription class="sr-only">选择项目、服务器、服务或设置。</DialogDescription>
          <div class="flex justify-end px-3 pt-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭导航"
              @click="ui.navigationOpen = false"
              ><X
            /></Button>
          </div>
          <NavigationContent />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <main id="main-content" class="app-main" tabindex="-1">
      <div v-if="auth.restoreMode" class="notice notice-warning mb-6" role="status">
        <LockKeyhole />
        <div>
          <strong>恢复核对中 · 只读模式</strong>
          <p>可以查看已有资源与任务，核对完成后才能继续修改。</p>
        </div>
      </div>
      <RouterView v-slot="{ Component }"
        ><component :is="Component" :key="route.path"
      /></RouterView>
    </main>
  </div>
  <CommandPalette />
  <ServiceCreationDialog
    v-if="route.params.projectId && route.query.createService === '1'"
    :key="`${route.path}:${route.query.environment ?? 'production'}:${route.query.environmentId ?? ''}`"
  />
</template>
<style scoped>
.activity-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding: 0 0.5rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  border-radius: 0.5rem;
}
.activity-trigger:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.app-shell {
  --sidebar-width: 14rem;
  min-height: 100dvh;
}
.project-shell {
  --sidebar-width: 15.5rem;
}
.app-header {
  height: 4rem;
  display: flex;
  align-items: center;
  position: sticky;
  top: 0;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  z-index: 100;
}
.header-brand {
  width: var(--sidebar-width);
  flex-shrink: 0;
  padding: 0 1.75rem;
  display: flex;
  align-items: center;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 1.125rem;
  font-weight: 650;
  letter-spacing: -0.04em;
}
.brand-mark {
  display: grid;
  place-items: center;
  background: var(--primary);
  color: var(--primary-foreground);
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  font-size: 1.25rem;
  line-height: 1;
  font-weight: 500;
}
.header-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 1.75rem;
  width: 100%;
  min-width: 0;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.search-trigger {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  background: transparent;
  border: 0;
  color: var(--muted-foreground);
  min-height: 2.5rem;
  text-align: left;
}
.search-trigger kbd {
  padding: 0.0625rem 0.3125rem;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  margin-left: 2rem;
  font: 0.75rem var(--font-sans);
}
.admin-chip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  padding: 0 0.5rem;
}
.avatar {
  display: grid;
  place-items: center;
  width: 1.875rem;
  height: 1.875rem;
  border: 1px solid var(--border);
  background: var(--secondary);
  border-radius: 50%;
  font-size: 0.75rem;
}
.app-sidebar {
  position: fixed;
  width: var(--sidebar-width);
  top: 4rem;
  bottom: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: auto;
  padding: 1.5rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
.app-main {
  margin-left: var(--sidebar-width);
  padding: 2rem;
  max-width: 115rem;
  min-height: calc(100dvh - 4rem);
  outline: none;
}
.mobile-menu {
  display: none;
}
.skip-link {
  position: fixed;
  z-index: 600;
  top: 0.5rem;
  left: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  color: var(--primary-foreground);
  background: var(--primary);
  transform: translateY(-200%);
}
.skip-link:focus {
  transform: translateY(0);
}
.nav-overlay {
  position: fixed;
  inset: 3.75rem 0 0;
  z-index: 300;
  background: oklch(18% 0.024 284 / 0.42);
}
.nav-drawer {
  position: fixed;
  z-index: 400;
  top: 3.75rem;
  left: 0;
  bottom: 0;
  width: min(19rem, 85vw);
  background: var(--sidebar);
  overflow-y: auto;
  border-right: 1px solid var(--border);
}
@media (max-width: 900px) {
  .app-sidebar {
    display: none;
  }
  .app-main {
    margin-left: 0;
    padding: 1.5rem;
  }
  .app-header {
    height: 3.75rem;
  }
  .header-brand {
    width: auto;
    padding: 0 0.75rem;
    gap: 0.5rem;
  }
  .header-tools {
    padding: 0 1rem 0 0.5rem;
  }
  .mobile-menu {
    display: inline-flex;
  }
  .search-trigger span,
  .search-trigger kbd {
    display: none;
  }
  .search-trigger {
    padding: 0.5rem;
  }
  .header-right {
    gap: 0.125rem;
  }
  .app-main {
    min-height: calc(100dvh - 3.75rem);
  }
}
@media (max-width: 639px) {
  .app-main {
    padding: 1.5rem 1rem 2rem;
  }
  .header-tools {
    gap: 0.125rem;
  }
  .admin-chip {
    padding: 0 0.25rem;
  }
  .brand {
    gap: 0.5rem;
  }
}
</style>
