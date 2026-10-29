<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { AlertCircle, Info, ScrollText, CircleHelp } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { bytesLabel, cpuLabel, sampleFreshness } from '@/components/infrastructure/format';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
import { dateTime } from '@/lib/utils';
import type { Service } from './types';
const props = defineProps<{ service: Service }>();
const emit = defineEmits<{ logs: [podUid: string, container: string] }>();
const now = useObservationClock();
const current = computed(
  () =>
    !props.service.observationStale &&
    sampleFreshness(props.service.lastObservedAt, now.value) === 'fresh',
);
const metricsCurrent = computed(
  () =>
    current.value &&
    props.service.observation?.metrics.state === 'available' &&
    sampleFreshness(props.service.observation.metrics.observedAt, now.value) === 'fresh',
);
const observation = computed(() => props.service.observation);
const workload = computed(() => observation.value?.controller ?? observation.value?.deployment);
const controllerKind = computed(
  () =>
    observation.value?.controller?.kind ?? (observation.value?.deployment ? 'Deployment' : null),
);
const eventsExpanded = ref(false);
const eventListId = useId();
const visibleEvents = computed(() => {
  const events = [...(observation.value?.events ?? [])].sort(
    (a, b) => (Date.parse(b.lastObservedAt ?? '') || 0) - (Date.parse(a.lastObservedAt ?? '') || 0),
  );
  return eventsExpanded.value ? events : events.slice(0, 5);
});
watch(
  () => props.service.id,
  () => (eventsExpanded.value = false),
);
const containerStates: Record<string, string> = {
  waiting: '等待启动',
  running: '运行中',
  terminated: '已退出',
  unknown: '未知',
};
</script>
<template>
  <div class="stack" data-service-runtime>
    <div v-if="!current && observation" class="notice notice-warning">
      <CircleHelp />
      <p>保留最后一次观察，当前运行状态未知。最近观察：{{ dateTime(service.lastObservedAt) }}。</p>
    </div>
    <section class="panel">
      <div class="section-head">
        <h2>运行观察</h2>
        <span class="meta">{{ dateTime(service.lastObservedAt) }}</span>
      </div>
      <dl class="runtime-summary">
        <div>
          <dt>就绪副本</dt>
          <dd>
            {{
              current && workload
                ? `${workload.readyReplicas ?? '未知'} / ${workload.replicas}`
                : '未知'
            }}
          </dd>
        </div>
        <div>
          <dt>当前 CPU</dt>
          <dd>{{ metricsCurrent ? cpuLabel(observation?.metrics.cpuCores) : '未知' }}</dd>
        </div>
        <div>
          <dt>当前内存</dt>
          <dd>{{ metricsCurrent ? bytesLabel(observation?.metrics.memoryBytes) : '未知' }}</dd>
        </div>
      </dl>
      <p v-if="controllerKind" class="meta mt-4" data-workload-controller>
        工作负载：{{ controllerKind }}
        <span v-if="observation?.controller"> · {{ observation.controller.strategy }}</span>
        <span v-if="!current"> · 历史观察</span>
      </p>
      <p v-if="observation?.controller?.kind === 'StatefulSet'" class="meta mono mt-2 break-all">
        当前修订 {{ observation.controller.currentRevision ?? '未知' }} · 更新修订
        {{ observation.controller.updateRevision ?? '未知' }}
      </p>
      <p class="meta mt-4">
        指标来自 Kubernetes Metrics API，采样于 {{ dateTime(observation?.metrics.observedAt) }}。
      </p>
      <p v-if="observation?.serviceDns" class="meta mt-3 break-all">
        环境内服务地址：<code>{{ observation.serviceDns }}</code>
      </p>
    </section>
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>实例与容器</h2>
          <p class="meta mt-1">{{ observation?.pods.length ?? 0 }} 个已读取 Pod · UID 确认归属</p>
        </div>
      </div>
      <div v-if="observation?.pods.length" class="pod-list">
        <article v-for="pod in observation.pods" :key="pod.uid" class="pod-item">
          <div class="flex flex-wrap justify-between gap-3">
            <div class="min-w-0">
              <h3 class="mono break-all">{{ pod.name }}</h3>
              <p class="meta mt-1">
                节点 {{ pod.nodeName || '待调度' }} · {{ current ? pod.phase : `上次 ${pod.phase}`
                }}{{ pod.deletionTimestamp ? ' · 正在终止' : '' }}
              </p>
            </div>
            <span :class="['badge', current && pod.ready ? 'badge-good' : 'badge-warning']">{{
              !current ? '当前未知' : pod.ready === true ? 'Ready' : '未就绪'
            }}</span>
          </div>
          <p class="meta mt-2">
            配置 r{{ pod.configRevision ?? '未知' }} · 创建于 {{ dateTime(pod.createdAt) }}
          </p>
          <div v-for="container in pod.containers" :key="container.name" class="container-row">
            <div class="min-w-0">
              <strong>{{ container.name }}</strong>
              <p class="meta mt-1">
                {{ current ? containerStates[container.state] : '当前状态未知' }} · 重启
                {{ container.restartCount ?? '未知' }} 次<span v-if="container.exitCode !== null">
                  · 退出码 {{ container.exitCode }}</span
                >
              </p>
              <p
                v-if="container.reason || container.oomKilled"
                class="text-destructive text-sm mt-1"
              >
                {{ container.oomKilled ? 'OOMKilled：内存超出容器限制' : container.reason }}
              </p>
              <p v-if="container.lastTerminationReason" class="meta mt-1">
                上次退出：{{ container.lastTerminationReason }}
              </p>
              <p class="meta mono mt-2 break-all">{{ container.imageId || container.image }}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              :disabled="!current || !!pod.deletionTimestamp"
              @click="emit('logs', pod.uid, container.name)"
              ><ScrollText />查看日志</Button
            >
          </div>
          <details class="mt-3">
            <summary class="meta cursor-pointer">实例身份</summary>
            <dl class="detail-list mt-3">
              <div>
                <dt>Pod UID</dt>
                <dd class="mono break-all">{{ pod.uid }}</dd>
              </div>
              <div>
                <dt>所属控制器</dt>
                <dd class="mono break-all">
                  {{
                    pod.owner
                      ? `${pod.owner.kind} / ${pod.owner.uid}`
                      : pod.replicaSetUid
                        ? `ReplicaSet / ${pod.replicaSetUid}`
                        : '未确认'
                  }}
                </dd>
              </div>
              <div>
                <dt>控制器模板</dt>
                <dd>
                  {{
                    (pod.matchesControllerTemplate ?? pod.matchesDeploymentTemplate)
                      ? '匹配本次观察的模板'
                      : '未匹配本次观察的模板'
                  }}
                </dd>
              </div>
              <div>
                <dt>发布快照</dt>
                <dd>
                  <RouterLink
                    v-if="pod.snapshotId"
                    :to="`/deployments/${pod.snapshotId}`"
                    class="text-link mono break-all"
                    >{{ pod.snapshotId }}</RouterLink
                  ><span v-else>未知</span>
                </dd>
              </div>
              <div>
                <dt>命名空间</dt>
                <dd class="mono break-all">{{ pod.namespace }}</dd>
              </div>
            </dl>
          </details>
        </article>
      </div>
      <div v-else class="notice">
        <Info />
        <p>
          {{
            current && observation && service.runtimeState === 'stopped'
              ? '服务已停止，没有当前实例可连接。发布历史和任务日志仍可查看。'
              : service.desiredState === 'stopped'
                ? '期望状态为停止，尚无最新观察确认实际是否已停止。发布历史和任务日志仍可查看。'
                : service.runtimeState === 'unpublished'
                  ? '服务尚未发布，保存配置后可在发布预览中启动。'
                  : '本次观察尚未发现当前服务的实例。'
          }}
        </p>
      </div>
      <p v-if="observation?.podsTruncated" class="meta mt-4">
        实例预览已达到数量上限，以上条数不代表全部实例。
      </p>
    </section>
    <section v-if="observation?.drift.length" class="panel">
      <h2 class="mb-4">配置需要核对</h2>
      <div
        v-for="item in observation.drift"
        :key="`${item.kind}:${item.name}:${item.reason}`"
        class="notice notice-warning mb-3"
      >
        <AlertCircle />
        <p>
          <strong>{{ item.kind }} / {{ item.name }}</strong
          ><span class="block meta mt-1">{{ item.reason }}</span>
        </p>
      </div>
    </section>
    <section v-if="observation?.events.length" class="panel">
      <div class="section-head">
        <h2>最近事件</h2>
        <span v-if="!current" class="badge">历史观察</span>
      </div>
      <p class="meta mb-4">
        显示最近 {{ visibleEvents.length }} 条 · 本次观察 {{ observation.events.length }} 条
      </p>
      <ol :id="eventListId" class="event-list">
        <li v-for="event in visibleEvents" :key="event.uid">
          <span :class="['badge', event.type === 'Warning' ? 'badge-warning' : '']">{{
            event.reason
          }}</span>
          <p class="mt-2">{{ event.message }}</p>
          <p class="meta mt-1">
            {{ event.objectKind }} / {{ event.objectName }} · {{ dateTime(event.lastObservedAt) }} ·
            {{ event.count ?? '未知' }} 次
          </p>
        </li>
      </ol>
      <Button
        v-if="observation.events.length > 5"
        variant="ghost"
        class="mt-4"
        :aria-expanded="eventsExpanded"
        :aria-controls="eventListId"
        @click="eventsExpanded = !eventsExpanded"
        >{{
          eventsExpanded ? '只显示最近 5 条' : `展开其余 ${observation.events.length - 5} 条事件`
        }}</Button
      >
      <p v-if="observation.eventsTruncated" class="meta mt-4">事件预览已截断。</p>
    </section>
  </div>
</template>
<style scoped>
.runtime-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.5rem;
  margin: 0;
}
.runtime-summary dt {
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.runtime-summary dd {
  font-size: 1.375rem;
  margin: 0.375rem 0 0;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
.pod-item {
  padding: 1.25rem 0;
  border-top: 1px solid var(--border);
}
.pod-item:first-child {
  border-top: 0;
  padding-top: 0;
}
.container-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  margin-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.container-row button {
  flex-shrink: 0;
}
.event-list {
  padding: 0;
  list-style: none;
  margin: 0;
}
.event-list li + li {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
  margin-top: 1rem;
}
@media (max-width: 639px) {
  .runtime-summary {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .runtime-summary > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .runtime-summary dd {
    font-size: 1.125rem;
    margin: 0;
  }
  .container-row {
    flex-direction: column;
  }
}
</style>
