<script setup lang="ts">
import { computed } from 'vue';
import { Check, CircleHelp, CirclePause, AlertCircle, Clock3, PackageOpen } from '@lucide/vue';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
import { sampleFreshness } from '@/components/infrastructure/format';
import type { Service } from './types';
const props = defineProps<{ service: Service }>();
const now = useObservationClock();
const status = computed(() =>
  props.service.runtimeState !== 'unpublished' &&
  (props.service.observationStale ||
    sampleFreshness(props.service.lastObservedAt, now.value) !== 'fresh')
    ? 'unknown'
    : props.service.runtimeState,
);
const states = {
  unpublished: { text: '尚未发布', icon: PackageOpen, tone: '' },
  running: { text: '运行中', icon: Check, tone: 'badge-good' },
  pending: { text: '等待就绪', icon: Clock3, tone: 'badge-warning' },
  stopped: { text: '已停止', icon: CirclePause, tone: '' },
  degraded: { text: '运行异常', icon: AlertCircle, tone: 'badge-danger' },
  missing: { text: '运行资源缺失', icon: AlertCircle, tone: 'badge-danger' },
  unknown: { text: '当前状态未知', icon: CircleHelp, tone: 'badge-warning' },
};
const state = computed(() => states[status.value]);
</script>
<template>
  <span :class="['badge', state.tone]"><component :is="state.icon" />{{ state.text }}</span>
</template>
