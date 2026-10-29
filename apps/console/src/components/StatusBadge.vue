<script setup lang="ts">
import { computed } from 'vue';
import { CircleHelp, Clock3, LoaderCircle, Check, X, CirclePause } from '@lucide/vue';
import { sampleFreshness } from '@/components/infrastructure/format';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
import { dateTime } from '@/lib/utils';
const props = defineProps<{ status?: string | null; observedAt?: string | null }>();
const now = useObservationClock();
const observedStatus = computed(() =>
  props.observedAt !== undefined &&
  ['connected', 'ready'].includes(props.status ?? '') &&
  sampleFreshness(props.observedAt, now.value) !== 'fresh'
    ? 'stale'
    : props.status,
);
const state = computed(
  () =>
    ({
      unverified: { label: '尚未验证', icon: CircleHelp, tone: '' },
      ready: { label: '已验证', icon: Check, tone: 'badge-good' },
      connected: { label: '已连接', icon: Check, tone: 'badge-good' },
      stale: { label: '观察已过期', icon: CircleHelp, tone: 'badge-warning' },
      unreachable: { label: '暂不可达', icon: CircleHelp, tone: 'badge-warning' },
      queued: { label: '已排队', icon: Clock3, tone: 'badge-warning' },
      running: { label: '执行中', icon: LoaderCircle, tone: 'badge-primary' },
      succeeded: { label: '已完成', icon: Check, tone: 'badge-good' },
      failed: { label: '失败', icon: X, tone: 'badge-danger' },
      cancelled: { label: '已取消', icon: CirclePause, tone: '' },
    })[observedStatus.value ?? 'unverified'] ?? {
      label: '状态未知',
      icon: CircleHelp,
      tone: 'badge-warning',
    },
);
</script>
<template>
  <span
    :class="['badge', state.tone]"
    :title="observedAt !== undefined ? `最近观察：${dateTime(observedAt)}` : undefined"
    ><component :is="state.icon" />{{ state.label }}</span
  >
</template>
