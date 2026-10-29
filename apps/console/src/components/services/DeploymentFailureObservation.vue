<script setup lang="ts">
import { computed } from 'vue';
import { dateTime } from '@/lib/utils';
import type { DeploymentDetail } from './types';
const props = defineProps<{ evidence: NonNullable<DeploymentDetail['failureObservation']> }>();
const workload = computed(() => props.evidence.controller ?? props.evidence.deployment);
const controllerKind = computed(
  () =>
    props.evidence.controller?.kind ??
    (props.evidence.deployment ? 'Deployment' : '未观察到工作负载'),
);
const retainedOom = computed(() =>
  props.evidence.pods.some(
    (pod) =>
      (pod.matchesControllerTemplate ?? pod.matchesDeploymentTemplate) &&
      pod.containers?.some((container) => container.oomKilled),
  ),
);
const legacyDiagnostics = computed(() =>
  props.evidence.pods.some((pod) => pod.containers === undefined),
);
const containerStates: Record<string, string> = {
  waiting: '等待中',
  running: '运行中',
  terminated: '已结束',
  unknown: '状态未知',
};
const stateLabels: Record<string, string> = {
  consistent: '一致',
  verified: '已核对',
  drifted: '存在差异',
  missing: '资源缺失',
  unknown: '未知',
};
</script>

<template>
  <details class="panel" data-deployment-failure-observation>
    <summary class="cursor-pointer font-medium">
      失败时的运行状态<span v-if="retainedOom" class="ml-2 font-normal">· 容器内存不足</span>
    </summary>
    <div class="mt-5 stack">
      <p class="meta">
        第 {{ evidence.attempt }} 次尝试失败时保留的观察，不会随当前运行状态刷新。
        此记录用于定位当时的差异，不表示配置已完整应用。
      </p>
      <dl class="detail-list">
        <div>
          <dt>证据采集于</dt>
          <dd>{{ dateTime(evidence.capturedAt) }}</dd>
        </div>
        <div>
          <dt>运行采样于</dt>
          <dd>{{ dateTime(evidence.observedAt) }}</dd>
        </div>
        <div>
          <dt>失败代码</dt>
          <dd class="mono break-all">{{ evidence.errorCode }}</dd>
        </div>
        <div>
          <dt>当时的配置</dt>
          <dd>{{ stateLabels[evidence.configurationState] || evidence.configurationState }}</dd>
        </div>
        <div>
          <dt>当时的控制器</dt>
          <dd>{{ controllerKind }}</dd>
        </div>
        <div>
          <dt>当时就绪副本</dt>
          <dd>
            {{
              workload
                ? `${workload.readyReplicas ?? '未知'} / ${workload.replicas}`
                : '未观察到工作负载'
            }}
          </dd>
        </div>
      </dl>
      <div>
        <h3 class="mb-3">当时的差异</h3>
        <ul v-if="evidence.drift.length" class="space-y-3">
          <li v-for="(item, index) in evidence.drift" :key="index" class="break-words">
            <strong class="break-all">{{ item.kind }} / {{ item.name }}</strong>
            <p class="meta mt-1">{{ item.reason }}</p>
          </li>
        </ul>
        <p v-else class="meta">这次采样没有记录到具体差异。</p>
        <p v-if="evidence.truncated.drift" class="meta mt-3">差异记录已截断，以上不是全部差异。</p>
      </div>
      <div>
        <h3 class="mb-3">当时的资源与实例</h3>
        <ul class="space-y-3">
          <li v-for="(item, index) in evidence.resources" :key="`resource-${index}`">
            <strong class="break-all">{{ item.kind }} / {{ item.name }}</strong>
            <span class="meta ml-2">{{ stateLabels[item.state] || item.state }}</span>
            <p v-if="item.reason" class="meta mt-1">{{ item.reason }}</p>
          </li>
          <li v-for="item in evidence.pods" :key="item.uid">
            <strong class="break-all">Pod / {{ item.name }}</strong>
            <p class="meta mt-1">
              {{ item.phase }} · 配置 r{{ item.configRevision ?? '未知' }} ·
              {{
                (item.matchesControllerTemplate ?? item.matchesDeploymentTemplate)
                  ? '匹配当时的控制器模板'
                  : '未匹配当时的控制器模板'
              }}
            </p>
            <p class="meta mono mt-1 break-all">{{ item.uid }}</p>
            <ul v-if="item.containers?.length" class="mt-3 space-y-2">
              <li v-for="container in item.containers" :key="container.name" class="break-words">
                <p>
                  容器 <span class="mono break-all">{{ container.name }}</span> ·
                  {{ containerStates[container.state] || '状态未知' }}
                </p>
                <p v-if="container.oomKilled" class="mt-1">
                  内存不足（OOMKilled），检查内存上限与应用用量后重新发布。
                </p>
                <p
                  v-else-if="container.reason || container.lastTerminationReason"
                  class="meta mt-1"
                >
                  {{ container.reason || container.lastTerminationReason }}
                </p>
                <p class="meta mt-1">
                  累计重启 {{ container.restartCount ?? '未知' }} 次
                  <span v-if="container.exitCode !== null"> · 退出码 {{ container.exitCode }}</span>
                </p>
              </li>
            </ul>
            <p v-if="item.owner || item.replicaSetUid" class="meta mono mt-1 break-all">
              {{
                item.owner
                  ? `${item.owner.kind} / ${item.owner.uid}`
                  : `ReplicaSet / ${item.replicaSetUid}`
              }}
            </p>
          </li>
        </ul>
        <p v-if="!evidence.resources.length && !evidence.pods.length" class="meta">
          没有保留资源或实例条目。
        </p>
        <p v-if="legacyDiagnostics" class="meta mt-3">这份历史记录未保存容器诊断。</p>
        <p
          v-if="
            evidence.truncated.resources || evidence.truncated.pods || evidence.truncated.containers
          "
          class="meta mt-3"
        >
          {{ evidence.truncated.resources ? '资源记录已截断。' : ''
          }}{{ evidence.truncated.pods ? '实例记录已截断。' : ''
          }}{{ evidence.truncated.containers ? '容器诊断已截断。' : '' }}
        </p>
      </div>
    </div>
  </details>
</template>
