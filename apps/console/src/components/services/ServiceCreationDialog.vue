<script setup lang="ts">
import { computed, provide, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui';
import { X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import ServiceCreatePage from '@/pages/ServiceCreatePage.vue';
import { DIRTY_FORM_SCOPE } from '@/composables/useDirtyForm';
import {
  CREATION_DIALOG,
  CREATION_SCOPE,
  creationNavigationLocked,
  withoutCreationQuery,
} from '@/composables/useCreationDialogState';

provide(DIRTY_FORM_SCOPE, CREATION_SCOPE);
provide(CREATION_DIALOG, true);
const route = useRoute();
const router = useRouter();
const content = ref<HTMLElement>();
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const composing = ref(false);
const choosing = computed(() => !route.query.source && !route.query.template);
function close() {
  if (!creationNavigationLocked.value)
    void router.push({ path: route.path, query: withoutCreationQuery(route.query) });
}
function escape(event: KeyboardEvent) {
  event.preventDefault();
  if (
    creationNavigationLocked.value ||
    composing.value ||
    event.isComposing ||
    event.keyCode === 229
  )
    return;
  const back = content.value?.querySelector<HTMLElement>('[data-creation-back]');
  if (back && !back.hasAttribute('disabled') && back.getAttribute('aria-disabled') !== 'true')
    back.click();
  else close();
}
function restoreFocus(event: Event) {
  event.preventDefault();
  if (previousFocus?.isConnected) previousFocus.focus();
  else document.getElementById('main-content')?.focus();
}
</script>
<template>
  <DialogRoot
    :open="true"
    @update:open="
      (open) => {
        if (!open) close();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="creation-overlay" />
      <DialogContent
        :class="['creation-dialog', { 'source-dialog': choosing }]"
        @escape-key-down="escape"
        @close-auto-focus="restoreFocus"
        @compositionstart.capture="composing = true"
        @compositionend.capture="composing = false"
        @interact-outside="$event.preventDefault()"
      >
        <DialogTitle class="sr-only">添加服务</DialogTitle>
        <DialogDescription class="sr-only"
          >在当前项目选择来源、配置服务并核对部署。</DialogDescription
        >
        <Button
          type="button"
          class="creation-close"
          variant="ghost"
          size="icon"
          aria-label="关闭添加服务"
          :disabled="creationNavigationLocked"
          @click="close"
          ><X
        /></Button>
        <div ref="content"><ServiceCreatePage /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
<style scoped>
.creation-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  background: oklch(18% 0.024 284 / 0.52);
}
.creation-dialog {
  position: fixed;
  z-index: 230;
  top: 6vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(54rem, calc(100vw - 3rem));
  max-height: 88dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.5rem 2rem 2rem;
  border: 1px solid var(--border);
  border-radius: 0.875rem;
  background: var(--card);
  box-shadow: 0 1.5rem 5rem oklch(15% 0.02 284 / 0.2);
}
.source-dialog {
  width: min(42rem, calc(100vw - 3rem));
}
.creation-close {
  position: absolute;
  right: 1rem;
  top: 1rem;
  z-index: 1;
}
@media (max-width: 639px) {
  .creation-dialog {
    inset: 0;
    transform: none;
    width: 100%;
    max-height: 100dvh;
    height: 100dvh;
    border-radius: 0;
    padding: 1.25rem 1rem 2rem;
  }
}
</style>
