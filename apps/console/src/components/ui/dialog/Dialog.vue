<script setup lang="ts">
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'reka-ui';
import { X } from '@lucide/vue';
import { ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
const props = withDefaults(
  defineProps<{ open: boolean; title: string; description?: string; width?: 'normal' | 'wide' }>(),
  { width: 'normal' },
);
defineEmits<{ 'update:open': [value: boolean] }>();
let previousFocus: HTMLElement | null = null;
const composing = ref(false);
watch(
  () => props.open,
  (open) => {
    if (!open) composing.value = false;
    if (open && document.activeElement instanceof HTMLElement)
      previousFocus = document.activeElement;
  },
);
function restoreFocus(event: Event) {
  event.preventDefault();
  if (previousFocus?.isConnected) previousFocus.focus();
  else document.getElementById('main-content')?.focus();
}
function preserveComposition(event: KeyboardEvent) {
  if (event.isComposing || composing.value || event.keyCode === 229) event.preventDefault();
}
</script>
<template>
  <DialogRoot :open="open" @update:open="$emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent
        :class="['dialog-content', { 'dialog-wide': width === 'wide' }]"
        @close-auto-focus="restoreFocus"
        @compositionstart.capture="composing = true"
        @compositionend.capture="composing = false"
        @escape-key-down="preserveComposition"
      >
        <div class="dialog-header">
          <div>
            <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle
            ><DialogDescription v-if="description" class="mt-2 text-sm text-muted-foreground">{{
              description
            }}</DialogDescription
            ><DialogDescription v-else class="sr-only">{{ title }}</DialogDescription>
          </div>
          <DialogClose as-child
            ><Button variant="ghost" size="icon" aria-label="关闭对话框"><X /></Button
          ></DialogClose>
        </div>
        <div class="dialog-body"><slot /></div>
        <div v-if="$slots.footer" class="dialog-footer"><slot name="footer" /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
