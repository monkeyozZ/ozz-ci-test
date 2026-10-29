<script setup lang="ts">
import { CheckCircle2, AlertCircle, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useUiStore } from '@/stores/ui';
const ui = useUiStore();
</script>
<template>
  <Dialog
    :open="!!ui.confirmation"
    :title="ui.confirmation?.title ?? ''"
    :description="ui.confirmation?.description"
    @update:open="
      (value) => {
        if (!value) ui.settleConfirmation(false);
      }
    "
  >
    <p class="muted">
      {{
        ui.confirmation?.destructive
          ? '请确认对象与影响范围，再继续操作。'
          : '选择继续编辑可以回到当前内容。'
      }}
    </p>
    <template #footer
      ><Button variant="outline" @click="ui.settleConfirmation(false)">取消</Button
      ><Button
        :variant="ui.confirmation?.destructive ? 'destructive' : 'default'"
        @click="ui.settleConfirmation(true)"
        >{{ ui.confirmation?.confirmText ?? '离开此页' }}</Button
      ></template
    >
  </Dialog>
  <div class="toast-region" aria-live="polite" aria-atomic="false">
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
  </div>
</template>
<style scoped>
.toast-region {
  position: fixed;
  right: 1.5rem;
  bottom: max(1.5rem, env(safe-area-inset-bottom));
  width: min(26rem, calc(100vw - 2rem));
  /* Background notices must not cover an active dialog's confirmation controls. */
  z-index: 250;
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
</style>
