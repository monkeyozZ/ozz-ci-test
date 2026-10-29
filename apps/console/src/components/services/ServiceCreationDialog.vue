<script setup lang="ts">
import { computed, nextTick, provide, ref, shallowRef, watch } from 'vue';
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
const open = computed(() => route.query.createService === '1');
const displayedRoute = shallowRef({ ...route });
const session = ref(0);
const content = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
let focusedFrame: HTMLElement | null = null;
let focusedStep = '';
let rememberedChoices = new WeakMap<HTMLElement, HTMLElement>();
const composing = ref(false);
const choosing = computed(
  () => !displayedRoute.value.query.source && !displayedRoute.value.query.template,
);
watch(
  [open, () => route.fullPath],
  ([isOpen], previous) => {
    if (!isOpen) {
      composing.value = false;
      return;
    }
    if (!previous?.[0]) {
      const trigger = document.activeElement;
      if (trigger instanceof HTMLElement && !content.value?.contains(trigger))
        previousFocus = trigger;
      session.value++;
      focusedFrame = null;
      focusedStep = '';
      rememberedChoices = new WeakMap();
    }
    // Only the visible session follows navigation. Closing content keeps its last step.
    displayedRoute.value = { ...route };
  },
  { immediate: true, flush: 'sync' },
);
function rememberChoice(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const frame = target.closest<HTMLElement>('[data-creation-step]');
  if (
    frame &&
    ['source', 'templates'].includes(frame.dataset.creationStep ?? '') &&
    target.matches('a[href], input, textarea, select, button') &&
    !target.hasAttribute('data-creation-back')
  )
    rememberedChoices.set(frame, target);
}
function focusStep() {
  if (!open.value || !content.value) return false;
  const ownDialog = content.value.closest('[role="dialog"]');
  const topDialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1);
  if (topDialog && topDialog !== ownDialog) return false;
  const frame = content.value.querySelector<HTMLElement>('[data-creation-step]');
  if (!frame) return false;
  const step = frame.dataset.creationStep ?? '';
  if (frame === focusedFrame && step === focusedStep) return true;
  const remembered = rememberedChoices.get(frame);
  const visible = (element: HTMLElement | null | undefined): element is HTMLElement =>
    !!element &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest('[inert], :disabled, [aria-disabled="true"]');
  const target =
    step === 'review'
      ? frame.querySelector<HTMLElement>('[data-creation-heading]')
      : step === 'configure'
        ? frame.querySelector<HTMLElement>('input[id$="-name"]')
        : visible(remembered)
          ? remembered
          : frame.querySelector<HTMLElement>('[data-creation-autofocus]');
  if (!visible(target)) return false;
  focusedFrame = frame;
  focusedStep = step;
  target.focus({ preventScroll: true });
  ownDialog?.scrollTo({ top: 0, behavior: 'instant' });
  return true;
}
async function focusContent(event: Event) {
  event.preventDefault();
  await nextTick();
  if (open.value && !focusStep())
    content.value
      ?.querySelector<HTMLElement>('[data-creation-heading]')
      ?.focus({ preventScroll: true });
}
watch(
  content,
  (element, _previous, onCleanup) => {
    if (!element) return;
    const observer = new MutationObserver(focusStep);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-creation-step'],
    });
    onCleanup(() => observer.disconnect());
    focusStep();
  },
  { flush: 'post' },
);
function close() {
  if (open.value && !creationNavigationLocked.value)
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
async function restoreFocus(event: Event) {
  event.preventDefault();
  await nextTick();
  if (open.value || document.querySelector('[role="dialog"][data-state="open"]')) return;
  if (
    previousFocus?.isConnected &&
    previousFocus !== document.body &&
    !previousFocus.closest('[inert]')
  )
    previousFocus.focus({ preventScroll: true });
  else document.getElementById('main-content')?.focus({ preventScroll: true });
}
</script>
<template>
  <DialogRoot
    :open="open"
    @update:open="
      (open) => {
        if (!open) close();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="creation-overlay" :inert="!open" />
      <DialogContent
        :class="['creation-dialog', { 'source-dialog': choosing }]"
        :inert="!open"
        :aria-busy="creationNavigationLocked || undefined"
        @escape-key-down="escape"
        @open-auto-focus="focusContent"
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
        <div ref="content" @focusin.capture="rememberChoice">
          <ServiceCreatePage :key="session" :display-route="displayedRoute" />
        </div>
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
.creation-overlay[data-state='open'] {
  animation: creation-overlay-enter var(--motion-dialog) var(--ease-out);
}
.creation-overlay[data-state='closed'] {
  animation: creation-overlay-exit var(--motion-fast) var(--ease-in);
}
.creation-overlay[data-state='closed'],
.creation-dialog[data-state='closed'] {
  pointer-events: none !important;
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
.creation-dialog[data-state='open'] {
  animation: creation-dialog-enter var(--motion-dialog) var(--ease-out);
}
.creation-dialog[data-state='closed'] {
  animation: creation-dialog-exit var(--motion-fast) var(--ease-in);
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
@keyframes creation-overlay-enter {
  from {
    opacity: 0;
  }
}
@keyframes creation-overlay-exit {
  to {
    opacity: 0;
  }
}
@keyframes creation-dialog-enter {
  from {
    opacity: 0;
    translate: 0 0.5rem;
    scale: 0.985;
  }
}
@keyframes creation-dialog-exit {
  to {
    opacity: 0;
    translate: 0 0.25rem;
    scale: 0.99;
  }
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
@media (prefers-reduced-motion: reduce) {
  .creation-overlay,
  .creation-dialog {
    animation: none;
  }
}
</style>
