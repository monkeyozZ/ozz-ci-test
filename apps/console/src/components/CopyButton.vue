<script setup lang="ts">
import { Check, Copy, LoaderCircle } from '@lucide/vue';
import { onScopeDispose, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    disabled?: boolean;
    compact?: boolean;
    contextKey?: string;
  }>(),
  { label: '复制', compact: false },
);
const pending = ref(false);
const feedback = ref<'idle' | 'copied' | 'error'>('idle');
let generation = 0;
let active = true;
let timer: ReturnType<typeof setTimeout> | undefined;
function resetFeedback() {
  generation++;
  if (timer) clearTimeout(timer);
  feedback.value = 'idle';
}
// Live logs keep the result of the clicked snapshot visible as new lines arrive.
// Static values reset immediately when the value itself changes.
watch(() => props.contextKey ?? props.text, resetFeedback);
onScopeDispose(() => {
  active = false;
  resetFeedback();
});
async function copy() {
  if (pending.value || props.disabled || !props.text) return;
  resetFeedback();
  const request = generation;
  pending.value = true;
  try {
    await navigator.clipboard.writeText(props.text);
    if (!active || request !== generation) return;
    feedback.value = 'copied';
    timer = setTimeout(() => {
      feedback.value = 'idle';
    }, 1600);
  } catch {
    if (active && request === generation) feedback.value = 'error';
  } finally {
    if (active) pending.value = false;
  }
}
</script>

<template>
  <span class="copy-control">
    <Button
      type="button"
      variant="ghost"
      :size="compact ? 'icon' : 'sm'"
      :class="['copy-button', { 'copy-button-compact': compact }]"
      :disabled="disabled || pending || !text"
      :aria-label="pending ? '正在复制' : feedback === 'copied' ? '已复制' : label"
      :title="label"
      :aria-busy="pending || undefined"
      @click.stop="copy"
    >
      <LoaderCircle v-if="pending" class="animate-spin" /><Check
        v-else-if="feedback === 'copied'"
        class="text-[var(--success)]"
      /><Copy v-else />
      <span v-if="!compact">{{
        pending ? '正在复制' : feedback === 'copied' ? '已复制' : label
      }}</span>
    </Button>
    <span v-if="feedback === 'error'" class="copy-error" role="status"
      >复制失败，请选中文本后复制。</span
    >
  </span>
</template>

<style scoped>
.copy-control {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  max-width: 100%;
}
.copy-button:not(.copy-button-compact) {
  min-width: 6rem;
}
.copy-error {
  font-size: 0.8125rem;
  color: var(--destructive);
  overflow-wrap: anywhere;
}
</style>
