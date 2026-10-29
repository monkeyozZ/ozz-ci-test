<script setup lang="ts">
import { CheckCircle2, AlertCircle, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useUiStore } from '@/stores/ui';
import { shallowRef, watch } from 'vue';
const ui = useUiStore();
const displayedConfirmation = shallowRef(ui.confirmation);
watch(
  () => ui.confirmation,
  (value) => {
    if (value) displayedConfirmation.value = value;
  },
  { immediate: true },
);
</script>
<template>
  <Dialog
    :open="!!ui.confirmation"
    :title="displayedConfirmation?.title ?? ''"
    :description="displayedConfirmation?.description"
    @after-close="!ui.confirmation && (displayedConfirmation = null)"
    @update:open="
      (value) => {
        if (!value) ui.settleConfirmation(false);
      }
    "
  >
    <template #footer
      ><Button type="button" variant="outline" @click="ui.settleConfirmation(false)">{{
        displayedConfirmation?.cancelText ?? '取消'
      }}</Button
      ><Button
        type="button"
        :variant="displayedConfirmation?.destructive ? 'destructive' : 'default'"
        @click="ui.settleConfirmation(true)"
        >{{ displayedConfirmation?.confirmText ?? '离开此页' }}</Button
      ></template
    >
  </Dialog>
  <TransitionGroup
    name="toast"
    tag="div"
    class="toast-region"
    aria-live="polite"
    aria-atomic="false"
  >
    <div
      v-for="notice in ui.notices"
      :key="notice.id"
      :class="['toast', { 'toast-error': notice.tone === 'error' }]"
      :role="notice.tone === 'error' ? 'alert' : 'status'"
    >
      <component
        :is="notice.tone === 'success' ? CheckCircle2 : AlertCircle"
        class="size-5 shrink-0"
      /><span class="min-w-0 flex-1">{{ notice.message }}</span
      ><Button variant="ghost" size="icon" aria-label="关闭提示" @click="ui.dismiss(notice.id)"
        ><X
      /></Button>
    </div>
  </TransitionGroup>
</template>
<style scoped>
.toast-region {
  position: fixed;
  right: 1.5rem;
  bottom: max(1.5rem, env(safe-area-inset-bottom));
  width: min(26rem, calc(100vw - 2rem));
  /* Background notices must not cover an active dialog's confirmation controls. */
  z-index: 210;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.toast {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--border);
  padding: 0.75rem 0.75rem 0.75rem 1rem;
  border-radius: 0.75rem;
  background: var(--card);
  box-shadow: var(--shadow);
}
.toast > svg {
  color: var(--success);
}
.toast-error > svg {
  color: var(--destructive);
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--motion-content) var(--ease-out),
    transform var(--motion-content) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(0.375rem);
}
.toast-move {
  transition: transform var(--motion-content) var(--ease-out);
}
.toast-leave-active {
  position: absolute;
  width: 100%;
  pointer-events: none;
}
</style>
