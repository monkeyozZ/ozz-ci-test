<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Activity, CircleHelp, CheckCircle2, PauseCircle, AlertCircle } from '@lucide/vue';
import { api } from '@/lib/api';
import type { WorkerStatus } from '@/lib/types';
import { dateTime } from '@/lib/utils';
const query = useQuery({
  queryKey: ['worker-status'],
  queryFn: ({ signal }) => api.get<WorkerStatus>('/operations/worker-status', signal),
  refetchInterval: 5000,
});
const state = computed(() => {
  if (query.error.value)
    return {
      label: '执行器状态暂不可用',
      detail: '未取得新的健康记录，请稍后重试。',
      icon: CircleHelp,
      tone: 'notice-warning',
    };
  const data = query.data.value;
  if (!data)
    return {
      label: '正在读取执行器状态',
      detail: '检查独立执行器最近的健康记录。',
      icon: Activity,
      tone: '',
    };
  return {
    ready: {
      label: '任务执行器可用',
      detail: '队列已连接，可以持续跟踪任务执行。',
      icon: CheckCircle2,
      tone: 'notice-good',
    },
    degraded: {
      label: '任务调度暂时受限',
      detail: '已受理任务保留在控制面，连接恢复后继续投递。',
      icon: AlertCircle,
      tone: 'notice-warning',
    },
    offline: {
      label: '尚未观察到可用执行器',
      detail: '任务可以持久受理，等待执行器恢复处理。',
      icon: CircleHelp,
      tone: 'notice-warning',
    },
    paused: {
      label: '恢复核对中，任务暂停',
      detail: '当前保持只读，核对完成后继续处理。',
      icon: PauseCircle,
      tone: 'notice-warning',
    },
  }[data.status];
});
</script>
<template>
  <section :class="['notice', state.tone]" aria-label="独立任务执行器健康状态">
    <component :is="state.icon" />
    <div class="min-w-0 flex-1">
      <strong>{{ state.label }}</strong>
      <p class="mt-1">{{ state.detail }}</p>
      <div v-if="query.data.value" class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <span>排队 {{ query.data.value.queuedCount }}</span
        ><span>待投递 {{ query.data.value.unpublishedCount }}</span
        ><span
          >队列{{
            { connected: '已连接', disconnected: '连接中断', unknown: '状态未知' }[
              query.data.value.queue
            ]
          }}</span
        ><span v-if="query.data.value.workers.length"
          >最近心跳 {{ dateTime(query.data.value.workers[0]?.lastSeenAt) }}</span
        >
      </div>
    </div>
  </section>
</template>
