<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch, type ComponentPublicInstance } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';

const props = defineProps<{
  text: string;
  firstLine: number;
  wrap: boolean;
  following: boolean;
  reading: boolean;
}>();
const emit = defineEmits<{ pause: [] }>();
const output = ref<HTMLElement>();
const lineHeight = ref(21.45);
const lines = computed(() => {
  if (!props.text) return [];
  const values = props.text.split('\n');
  if (values.at(-1) === '') values.pop();
  return values;
});
const bufferLines = computed(() => (props.text ? props.text.split('\n').length : 0));
const encoder = new TextEncoder();
const bufferBytes = computed(() => encoder.encode(props.text).byteLength);
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => {
    // Capture this base so old and new options have stable keys when older lines are trimmed.
    const first = props.firstLine;
    return {
      count: lines.value.length,
      getScrollElement: () => output.value ?? null,
      getItemKey: (index: number) => first + index,
      estimateSize: () => lineHeight.value,
      overscan: 8,
      paddingStart: 16,
      paddingEnd: 16,
      anchorTo: 'end' as const,
      followOnAppend: props.following,
      scrollEndThreshold: 40,
      enabled: !!props.text,
    };
  }),
);
const visible = computed(() => virtualizer.value.getVirtualItems());
const totalHeight = computed(() => virtualizer.value.getTotalSize());
let positioning = false;
let frame = 0;
function measure(element: Element | ComponentPublicInstance | null) {
  virtualizer.value.measureElement(element instanceof HTMLElement ? element : null);
}
async function jumpToBottom() {
  positioning = true;
  cancelAnimationFrame(frame);
  await nextTick();
  virtualizer.value.scrollToEnd({ behavior: 'auto' });
  frame = requestAnimationFrame(() => {
    positioning = false;
  });
}
function onScroll() {
  if (!output.value || positioning) return;
  if (output.value.scrollHeight - output.value.scrollTop - output.value.clientHeight >= 40)
    emit('pause');
}
watch(output, (element) => {
  if (element) lineHeight.value = Number.parseFloat(getComputedStyle(element).lineHeight) || 21.45;
});
watch(
  () => props.wrap,
  async () => {
    await nextTick();
    virtualizer.value.measure();
    if (props.following) await jumpToBottom();
  },
);
onScopeDispose(() => cancelAnimationFrame(frame));
defineExpose({ jumpToBottom });
</script>

<template>
  <div
    ref="output"
    class="runtime-log-output"
    :class="{ 'wrap-lines': wrap }"
    :data-buffer-characters="text.length"
    :data-buffer-lines="bufferLines"
    :data-buffer-bytes="bufferBytes"
    tabindex="0"
    role="region"
    aria-label="容器日志输出，可滚动，移开底部暂停跟随"
    @scroll="onScroll"
    @wheel="$event.deltaY < 0 && emit('pause')"
    @keydown="['ArrowUp', 'PageUp', 'Home'].includes($event.key) && emit('pause')"
  >
    <pre v-if="text" :style="{ height: `${totalHeight}px` }"><span
      v-for="item in visible"
      :key="String(item.key)"
      :ref="measure"
      class="virtual-log-line"
      :data-index="item.index"
      :data-line-key="item.key"
      :style="{ transform: `translateY(${item.start}px)` }"
      v-text="`${lines[item.index]}\n`"
    /></pre>
    <p v-else class="muted p-4">{{ reading ? '等待日志输出…' : '选择实例与容器后读取日志。' }}</p>
  </div>
</template>

<style scoped>
.runtime-log-output {
  height: min(32rem, 65dvh);
  min-height: 15rem;
  overflow: auto;
  overflow-anchor: none;
  border: 1px solid var(--border);
  border-radius: 0 0 0.5rem 0.5rem;
  background: var(--background);
  font: 0.8125rem/1.65 var(--font-mono);
}
.runtime-log-output pre {
  position: relative;
  font: inherit;
  white-space: pre;
  tab-size: 2;
  margin: 0;
}
.virtual-log-line {
  position: absolute;
  top: 0;
  left: 1rem;
  display: block;
  width: max-content;
  min-width: calc(100% - 2rem);
  min-height: 1lh;
  padding-right: 1rem;
}
.wrap-lines pre {
  white-space: pre-wrap;
}
.wrap-lines .virtual-log-line {
  width: calc(100% - 2rem);
  padding-right: 0;
  overflow-wrap: anywhere;
}
.runtime-log-output:focus-visible {
  outline-offset: 2px;
}
</style>
