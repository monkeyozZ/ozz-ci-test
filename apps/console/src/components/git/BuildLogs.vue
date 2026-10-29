<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ArrowDown, Pause, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import { request } from '@/lib/api';
import { dateTime } from '@/lib/utils';
import { stageLabels } from '@/components/services/presentation';
import { decimalSequenceCompare } from './presentation';
import type { BuildLogChunk, BuildLogPage, BuildRun } from './types';
const props = defineProps<{ deploymentId: string; runs: BuildRun[]; active: boolean }>();
const selectedRun = ref('');
const cursor = ref('');
const rows = ref<BuildLogChunk[]>([]);
const following = ref(true);
const unread = ref(0);
const wrap = ref(true);
const clipped = ref(false);
const output = ref<HTMLElement>();
watch(
  () => props.runs,
  (runs) => {
    if (!selectedRun.value && runs.length) selectedRun.value = runs.at(-1)!.id;
  },
  { immediate: true },
);
watch(
  selectedRun,
  () => {
    cursor.value = '';
    rows.value = [];
    clipped.value = false;
    unread.value = 0;
  },
  { flush: 'sync' },
);
const logs = useQuery({
  queryKey: computed(() => ['build-logs', props.deploymentId, selectedRun.value, cursor.value]),
  enabled: computed(() => !!selectedRun.value),
  gcTime: 0,
  staleTime: 0,
  queryFn: ({ queryKey, signal }) => {
    const search = new URLSearchParams({ limit: '50', runId: String(queryKey[2]) });
    if (queryKey[3]) search.set('cursor', String(queryKey[3]));
    return request<BuildLogPage>('/deployments/' + queryKey[1] + '/build-logs?' + search, {
      signal,
    });
  },
  refetchInterval: () => (props.active ? 3000 : false),
});
async function jumpToLatest() {
  following.value = true;
  unread.value = 0;
  await nextTick();
  if (output.value) output.value.scrollTop = output.value.scrollHeight;
}
watch(logs.data, async (page) => {
  if (!page || page.runId !== selectedRun.value) return;
  if (!page.available) {
    rows.value = [];
    unread.value = 0;
    clipped.value = false;
    return;
  }
  const existing = new Map(rows.value.map((row) => [row.sequence, row]));
  const added = page.items.filter((row) => !existing.has(row.sequence)).length;
  for (const row of page.items) existing.set(row.sequence, row);
  const merged = [...existing.values()].sort((a, b) =>
    decimalSequenceCompare(a.sequence, b.sequence),
  );
  let characters = 0;
  const retained: BuildLogChunk[] = [];
  for (let index = merged.length - 1; index >= 0; index--) {
    const row = merged[index]!;
    if (retained.length >= 200 || characters + row.content.length > 200_000) {
      clipped.value = true;
      break;
    }
    retained.unshift(row);
    characters += row.content.length;
  }
  rows.value = retained;
  if (following.value) await jumpToLatest();
  else unread.value += added;
  // While running, catch up one bounded page at a time, then poll only the tail page.
  if (
    props.active &&
    page.pageInfo.hasMore &&
    page.pageInfo.nextCursor &&
    page.runId === selectedRun.value
  )
    cursor.value = page.pageInfo.nextCursor;
});
function onScroll() {
  if (!output.value) return;
  if (output.value.scrollHeight - output.value.scrollTop - output.value.clientHeight > 48)
    following.value = false;
}
const unavailable = computed(() => {
  if (!selectedRun.value) return '尚无已登记的构建执行，任务开始后会显示对应输出。';
  return logs.data.value?.unavailableReason === 'expired'
    ? '本次构建输出已超过保留期限，任务与产物身份仍保留。'
    : logs.data.value?.unavailableReason === 'not_started'
      ? '构建尚未开始。'
      : '此执行尚无可读取的构建输出。';
});
</script>
<template>
  <section id="build-logs" class="panel" data-build-logs>
    <div class="section-head">
      <div>
        <h2>构建与推送输出</h2>
        <p class="meta mt-1">来源：独立 Builder · 按执行记录保留检出、构建、导出与推送日志。</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="刷新构建日志"
        :disabled="!selectedRun || logs.isFetching.value"
        @click="logs.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <div v-if="runs.length" class="build-log-toolbar">
      <label class="field"
        ><span>构建执行</span
        ><select v-model="selectedRun" class="input" aria-label="选择构建执行">
          <option v-for="run in runs" :key="run.id" :value="run.id">
            执行 {{ run.runNumber }} · {{ dateTime(run.createdAt) }}
          </option>
        </select></label
      >
      <label class="flex items-center gap-2"
        ><input v-model="wrap" type="checkbox" />长行换行</label
      >
      <Button v-if="following" variant="ghost" @click="following = false"><Pause />暂停跟随</Button>
      <Button v-else variant="ghost" @click="jumpToLatest"
        ><ArrowDown />{{ unread ? '新增 ' + unread + ' 段 · ' : '' }}回到底部</Button
      >
    </div>
    <QueryState
      :pending="!!selectedRun && logs.isPending.value && !rows.length"
      :error="logs.error.value"
      @retry="logs.refetch()"
    >
      <div
        v-if="rows.length"
        ref="output"
        class="build-output mt-4"
        :class="{ nowrap: !wrap }"
        role="region"
        tabindex="0"
        aria-label="构建与推送日志，可滚动"
        @scroll="onScroll"
      >
        <div v-for="row in rows" :key="row.sequence" class="build-chunk">
          <p class="meta">
            <time :datetime="row.timestamp">{{ dateTime(row.timestamp) }}</time> ·
            {{ stageLabels[row.phase] || row.phase }}
          </p>
          <pre>{{ row.content }}</pre>
          <p v-if="row.truncated" class="meta">此段输出已截断。</p>
        </div>
      </div>
      <p v-else-if="!logs.error.value" class="meta py-5">{{ unavailable }}</p>
      <p v-if="logs.data.value?.truncated" class="meta mt-3">
        服务端已按保留上限截断部分构建输出。
      </p>
      <p v-if="clipped" class="meta mt-3">
        当前窗口最多保留 200 段、200,000 字符，较早输出已移出此窗口。
      </p>
      <p v-if="logs.data.value?.expiresAt" class="meta mt-3">
        此执行日志保留至 {{ dateTime(logs.data.value.expiresAt) }}
      </p>
      <Button
        v-if="logs.data.value?.pageInfo.hasMore"
        variant="outline"
        class="mt-4"
        :disabled="logs.isFetching.value"
        @click="cursor = logs.data.value?.pageInfo.nextCursor || cursor"
        >载入后续构建日志</Button
      >
    </QueryState>
  </section>
</template>
<style scoped>
.build-log-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.75rem 1rem;
}
.build-log-toolbar .field {
  max-width: 100%;
}
.build-output {
  max-height: 34rem;
  min-height: 10rem;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--secondary);
  padding: 1rem;
}
.build-chunk + .build-chunk {
  margin-top: 1rem;
}
.build-chunk pre {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 0.25rem;
}
.nowrap pre {
  white-space: pre;
  overflow-wrap: normal;
}
</style>
