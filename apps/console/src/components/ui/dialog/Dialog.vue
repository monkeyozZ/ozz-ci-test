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
import { nextTick, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    width?: 'normal' | 'wide';
    busy?: boolean;
  }>(),
  { width: 'normal' },
);
const emit = defineEmits<{ 'update:open': [value: boolean]; 'after-close': [] }>();
let previousFocus: HTMLElement | null = null;
const composing = ref(false);
const body = ref<HTMLElement>();
const footer = ref<HTMLElement>();
const displayedTitle = ref(props.title);
const displayedDescription = ref(props.description);
watch(
  () => [props.open, props.title, props.description] as const,
  ([open, title, description], previous) => {
    if (!open) composing.value = false;
    if (open) {
      displayedTitle.value = title;
      displayedDescription.value = description;
    }
    if (open && !previous?.[0] && document.activeElement instanceof HTMLElement)
      previousFocus = document.activeElement;
  },
  { immediate: true, flush: 'sync' },
);
function requestOpen(value: boolean) {
  if (!value && props.busy) return;
  emit('update:open', value);
}
function clickOverlay(event: MouseEvent) {
  if (props.open && event.button === 0 && !event.ctrlKey) requestOpen(false);
}
function focusContent(event: Event) {
  const selectors =
    'input:not([type="hidden"]):not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), select:not(:disabled), button:not(:disabled), a[href]';
  const candidates = [
    ...(body.value?.querySelectorAll<HTMLElement>('[data-dialog-autofocus]') ?? []),
    ...(body.value?.querySelectorAll<HTMLElement>(selectors) ?? []),
    ...(footer.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
  ];
  const target = candidates.find(
    (element) =>
      element.getClientRects().length > 0 &&
      !element.closest('[inert], [aria-hidden="true"], [aria-disabled="true"], :disabled'),
  );
  if (target) {
    event.preventDefault();
    target.focus({ preventScroll: true });
  }
}
async function restoreFocus(event: Event) {
  event.preventDefault();
  await nextTick();
  if (props.open) return;
  const openDialogs = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'),
  ];
  const currentDialog = openDialogs.at(-1);
  if (!currentDialog || (previousFocus && currentDialog.contains(previousFocus))) {
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]'))
      previousFocus.focus({ preventScroll: true });
    else {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        active.closest('[inert], [data-state="closed"][role="dialog"]')
      )
        document.getElementById('main-content')?.focus({ preventScroll: true });
    }
  }
  emit('after-close');
}
function preserveComposition(event: KeyboardEvent) {
  if (props.busy || event.isComposing || composing.value || event.keyCode === 229)
    event.preventDefault();
}
</script>
<template>
  <DialogRoot :open="open" @update:open="requestOpen">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" @click.self="clickOverlay" />
      <DialogContent
        :class="['dialog-content', { 'dialog-wide': width === 'wide' }]"
        :aria-busy="busy || undefined"
        :inert="!open"
        @open-auto-focus="focusContent"
        @close-auto-focus="restoreFocus"
        @interact-outside="busy && $event.preventDefault()"
        @compositionstart.capture="composing = true"
        @compositionend.capture="composing = false"
        @escape-key-down="preserveComposition"
      >
        <div :class="['dialog-header', { 'dialog-header-without-body': !$slots.default }]">
          <div>
            <DialogTitle class="text-lg font-semibold">{{ displayedTitle }}</DialogTitle
            ><DialogDescription
              v-if="displayedDescription"
              class="mt-2 text-sm text-muted-foreground"
              >{{ displayedDescription }}</DialogDescription
            ><DialogDescription v-else class="sr-only">{{ displayedTitle }}</DialogDescription>
          </div>
          <DialogClose as-child
            ><Button
              type="button"
              variant="ghost"
              size="icon"
              :disabled="busy"
              aria-label="关闭对话框"
              ><X /></Button
          ></DialogClose>
        </div>
        <div v-if="$slots.default" ref="body" class="dialog-body"><slot /></div>
        <div v-if="$slots.footer" ref="footer" class="dialog-footer"><slot name="footer" /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
