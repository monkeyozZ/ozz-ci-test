<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui';
import { ArrowLeft, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';

const props = defineProps<{
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
}>();
const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const composing = ref(false);
let previousFocus: HTMLElement | null = null;
watch(
  () => props.open,
  (open) => {
    if (open && document.activeElement instanceof HTMLElement)
      previousFocus = document.activeElement;
    if (!open) composing.value = false;
  },
);
function requestOpen(open: boolean) {
  if (!open && props.busy) return;
  emit('update:open', open);
}
function restoreFocus(event: Event) {
  event.preventDefault();
  if (previousFocus?.isConnected) previousFocus.focus();
  else document.getElementById('main-content')?.focus();
}
function preserveComposition(event: KeyboardEvent) {
  if (props.busy || event.isComposing || composing.value || event.keyCode === 229)
    event.preventDefault();
}
</script>
<template>
  <DialogRoot :open="open" @update:open="requestOpen">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent
        class="service-workspace-panel"
        @close-auto-focus="restoreFocus"
        @compositionstart.capture="composing = true"
        @compositionend.capture="composing = false"
        @escape-key-down="preserveComposition"
        @interact-outside="busy && $event.preventDefault()"
      >
        <header class="workspace-panel-head">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            :disabled="busy"
            aria-label="返回服务"
            @click="requestOpen(false)"
            ><ArrowLeft
          /></Button>
          <div class="min-w-0">
            <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle>
            <DialogDescription class="meta mt-1">{{ description }}</DialogDescription>
          </div>
          <span v-if="busy" class="workspace-panel-busy meta" role="status">
            <LoaderCircle class="size-4 animate-spin" />正在处理…
          </span>
        </header>
        <div class="workspace-panel-body"><slot /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
<style scoped>
.service-workspace-panel {
  position: fixed;
  z-index: 400;
  inset: 1rem 1rem 1rem auto;
  display: flex;
  flex-direction: column;
  width: min(70rem, calc(100vw - 3rem));
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 0.875rem;
  background: var(--background);
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: workspace-panel-enter 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.workspace-panel-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.875rem;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--card);
}
.workspace-panel-head > div {
  overflow-wrap: anywhere;
}
.workspace-panel-busy {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.5rem;
  margin-left: auto;
}
.workspace-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.5rem;
}
@keyframes workspace-panel-enter {
  from {
    transform: translateX(1rem);
    opacity: 0;
  }
}
@media (max-width: 639px) {
  .service-workspace-panel {
    inset: 0;
    width: 100%;
    border: 0;
    border-radius: 0;
  }
  .workspace-panel-head,
  .workspace-panel-body {
    padding: 1rem;
  }
  .workspace-panel-busy {
    font-size: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .service-workspace-panel {
    animation: none;
  }
}
</style>
