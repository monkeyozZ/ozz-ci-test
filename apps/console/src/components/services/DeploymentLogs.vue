<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { ArrowDown, Pause, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import CopyButton from '@/components/CopyButton.vue';
import { request } from '@/lib/api';
import { dateTime } from '@/lib/utils';
import type { Deployment, DeploymentLogs } from './types';
import { matchesLogSearch, useLogViewport } from './useBufferedLog';

const props = defineProps<{ deploymentId: string; active: boolean; kind?: Deployment['kind'] }>();
const search = ref('');
const {
  output,
  following,
  unread,
  pause,
  jumpToLatest,
  appended,
  onScroll,
  onWheel,
  onHistoryKey,
  reset,
} = useLogViewport();
const wrapLines = ref(true);
const logs = useInfiniteQuery({
  queryKey: computed(() => ['deployment-logs', props.deploymentId]),
  initialPageParam: '',
  queryFn: ({ queryKey, pageParam, signal }) => {
    const search = new URLSearchParams({ limit: '100' });
    if (pageParam) search.set('cursor', pageParam);
    return request<DeploymentLogs>(`/deployments/${queryKey[1]}/logs?${search}`, { signal });
  },
  getNextPageParam: (last) => (last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined),
  maxPages: 20,
  refetchInterval: () => (props.active ? 2000 : false),
});
const rows = computed(() =>
  [
    ...new Map(
      (logs.data.value?.pages.flatMap((page) => page.data) ?? []).map((line) => [
        line.sequence,
        line,
      ]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence),
);
const filteredRows = computed(() =>
  rows.value.filter((line) =>
    matchesLogSearch(
      `${line.timestamp} ${line.level} ${line.message} ${line.code ?? ''}`,
      search.value,
    ),
  ),
);
const copyText = computed(() =>
  filteredRows.value
    .map(
      (line) =>
        `${line.timestamp} ${line.level} ${line.message}${line.code ? ` [${line.code}]` : ''}`,
    )
    .join('\n'),
);
const copyContext = computed(() => JSON.stringify([props.deploymentId, search.value]));
const unavailable = computed(() => {
  switch (logs.data.value?.pages[0]?.unavailableReason) {
    case 'expired':
      return '这次部署的日志已超过保留期限，配置快照与任务结果仍保留。';
    case 'not_started':
      return '任务尚未开始，执行器处理后会记录输出。';
    default:
      return '这次部署尚无可用的执行日志。';
  }
});
watch(rows, (_value, old) => {
  const previous = old.at(-1)?.sequence ?? 0;
  const added = filteredRows.value.filter((line) => line.sequence > previous).length;
  appended(added);
});
watch(search, () => {
  unread.value = 0;
  appended(0);
});
watch(
  () => props.deploymentId,
  () => {
    search.value = '';
    reset();
  },
);
watch(
  () => props.active,
  () => void logs.refetch(),
);
</script>

<template>
  <section class="panel" data-deployment-logs>
    <div class="section-head">
      <div>
        <h2>部署执行日志</h2>
        <p class="meta mt-1">
          {{ active ? '每 2 秒读取持久记录' : '已保留的执行输出' }} ·
          {{
            kind === 'git_deploy'
              ? '来源：平台阶段事件；构建与推送原始输出在上方单独展示'
              : '镜像发布不包含构建步骤'
          }}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="刷新部署日志"
        :disabled="logs.isFetching.value"
        @click="logs.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <QueryState
      :pending="logs.isPending.value"
      :error="logs.error.value"
      :refreshing="logs.isFetching.value"
      @retry="logs.refetch()"
    >
      <template v-if="rows.length">
        <div class="log-toolbar">
          <span role="status"
            >{{ search ? `${filteredRows.length} 条匹配 / ` : '' }}{{ rows.length }} 条已载入 ·
            {{ following ? '自动滚动' : '自动滚动已暂停' }}</span
          >
          <input
            v-model="search"
            type="search"
            class="input log-search"
            aria-label="搜索部署日志"
            placeholder="搜索已载入的日志"
          />
          <label class="flex items-center gap-2"
            ><input v-model="wrapLines" type="checkbox" />长行换行</label
          >
          <Button v-if="following" variant="ghost" size="sm" @click="pause"
            ><Pause />暂停滚动</Button
          >
          <Button v-else variant="ghost" size="sm" @click="jumpToLatest"
            ><ArrowDown />回到最新{{ unread ? ` · ${unread} 条新输出` : '' }}</Button
          >
          <CopyButton
            :text="copyText"
            :context-key="copyContext"
            :label="search ? '复制匹配日志' : '复制部署日志'"
          />
        </div>
        <div
          ref="output"
          class="deployment-log"
          :class="{ 'nowrap-lines': !wrapLines }"
          tabindex="0"
          role="region"
          aria-label="部署执行日志，可滚动"
          @scroll="onScroll"
          @wheel="onWheel"
          @keydown="onHistoryKey"
        >
          <div v-for="line in filteredRows" :key="line.sequence" class="log-line">
            <time :datetime="line.timestamp">{{ dateTime(line.timestamp) }}</time>
            <span :class="['log-level', `log-${line.level}`]">{{ line.level }}</span>
            <span class="log-message"
              >{{ line.message
              }}<small v-if="line.code" class="block muted">{{ line.code }}</small></span
            >
          </div>
          <p v-if="!filteredRows.length" class="muted py-4">
            已载入的日志中没有匹配内容。清除搜索可查看全部缓冲。
          </p>
        </div>
      </template>
      <p v-else-if="!logs.error.value" class="muted py-5">{{ unavailable }}</p>
      <p v-if="logs.data.value?.pages.some((page) => page.truncated)" class="meta mt-3">
        部分较早日志已按保留规则裁剪。
      </p>
      <p v-if="rows.length >= 2000" class="meta mt-3">
        此视图最多保留 2,000 条已载入日志。继续载入会移除视图中的较早输出。
      </p>
      <Button
        v-if="logs.hasNextPage.value"
        variant="outline"
        class="mt-4"
        :disabled="logs.isFetching.value"
        @click="logs.fetchNextPage()"
        >{{ logs.isFetchingNextPage.value ? '正在载入…' : '载入后续日志' }}</Button
      >
    </QueryState>
  </section>
</template>

<style scoped>
.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem 0.5rem 0 0;
  background: var(--secondary);
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.deployment-log {
  max-height: 30rem;
  overflow: auto;
  padding: 1rem;
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0 0 0.5rem 0.5rem;
  background: var(--background);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}
.log-search {
  width: min(100%, 18rem);
}
.log-line {
  display: grid;
  grid-template-columns: 8.5rem 2.75rem minmax(18rem, 1fr);
  gap: 0.75rem;
  line-height: 1.8;
  min-width: 33rem;
}
.log-line time,
.log-level {
  color: var(--muted-foreground);
}
.log-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.nowrap-lines .log-message {
  white-space: pre;
  overflow-wrap: normal;
}
.log-warn {
  color: var(--warning);
}
.log-error {
  color: var(--destructive);
}
</style>
