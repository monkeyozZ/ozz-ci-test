<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import ConfigurationReview from '@/components/services/ConfigurationReview.vue';
import DeploymentLogs from '@/components/services/DeploymentLogs.vue';
import BuildLogs from '@/components/git/BuildLogs.vue';
import BuildSummary from '@/components/git/BuildSummary.vue';
import GitSourceSummary from '@/components/git/GitSourceSummary.vue';
import DeploymentFailureObservation from '@/components/services/DeploymentFailureObservation.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import DeploymentStorageSnapshot from '@/components/storage/DeploymentStorageSnapshot.vue';
import { invalidateStorage } from '@/components/storage/queries';
import { serviceLocation, stageLabels } from '@/components/services/presentation';
import type { Deployment, DeploymentDetail, Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const isViewActive = useViewScope();
const deploymentId = String(route.params.deploymentId);
const deployment = useQuery({
  queryKey: ['deployment-detail', deploymentId],
  queryFn: ({ signal }) => api.get<DeploymentDetail>(`/deployments/${deploymentId}`, signal),
  refetchInterval: (query) =>
    ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
});
const active = computed(() => ['queued', 'running'].includes(deployment.data.value?.status ?? ''));
const serviceId = computed(() => deployment.data.value?.serviceId ?? '');
const service = useQuery({
  queryKey: computed(() => ['service', serviceId.value]),
  enabled: computed(() => !!serviceId.value),
  queryFn: ({ queryKey, signal }) => api.get<Service>(`/services/${queryKey[1]}`, signal),
  refetchInterval: () => (active.value ? 5000 : false),
});
const stages = computed(() => {
  const order = [
    'checkout',
    'building',
    'exporting',
    'pushing',
    'resolving',
    'preparing_storage',
    'deploying',
    'waiting_healthy',
    'verifying_database',
  ];
  return [...(deployment.data.value?.stages ?? [])].sort(
    (a, b) => a.attempt - b.attempt || order.indexOf(a.name) - order.indexOf(b.name),
  );
});
const stageDescriptions: Record<string, string> = {
  checkout: '在独立 Builder 检出并核对固定 commit。',
  building: '按固定 Dockerfile、上下文与构建参数执行。',
  exporting: '登记并保留 OCI 产物与原 digest。',
  pushing: '使用独立推送身份上传原产物，尚未应用服务配置。',
  resolving: '确认目标架构与不可变镜像摘要。',
  preparing_storage: '核对卷身份、节点约束与本次挂载引用。',
  deploying: '按固定快照创建或更新受管资源。',
  waiting_healthy: '等待本次发布的副本与探针就绪。',
  verifying_database: '确认数据库完成初始化并通过私有认证检查。',
};
const retryOpen = ref(false);
const retryRegion = ref<HTMLElement>();
const canRetry = computed(
  () =>
    ['failed', 'cancelled'].includes(deployment.data.value?.status ?? '') &&
    !!service.data.value &&
    !auth.restoreMode,
);
watch(
  () => deployment.data.value?.status,
  (status, previous) => {
    if (status && status !== previous && !['queued', 'running'].includes(status)) {
      void invalidateCollection('/deployments');
      void invalidateCollection('/services');
      void invalidateStorage(serviceId.value || undefined);
      if (serviceId.value) void service.refetch();
    }
  },
);
const cancel = useMutation({
  mutationFn: () => api.create<Deployment>(`/deployments/${deploymentId}/cancel`, {}),
  onSuccess: async (value) => {
    queryClient.setQueryData<DeploymentDetail>(['deployment-detail', deploymentId], (previous) =>
      previous ? { ...previous, ...value } : undefined,
    );
    await Promise.all([
      deployment.refetch(),
      invalidateCollection('/deployments'),
      invalidateCollection('/services'),
    ]);
    if (isViewActive())
      ui.toast(value.status === 'cancelled' ? '部署已取消。' : '取消请求已受理，等待执行器确认。');
  },
});
async function requestCancel() {
  if (
    !(await ui.confirm({
      title: '请求取消这次部署？',
      description: '取消会终止后续处理，已应用的配置和远端资源仍会保留。最终结果由执行器确认。',
      confirmText: '请求取消',
    }))
  )
    return;
  if (isViewActive() && active.value) cancel.mutate();
}
async function openRetry() {
  retryOpen.value = true;
  await service.refetch();
  await nextTick();
  retryRegion.value?.focus();
  retryRegion.value?.scrollIntoView({ block: 'start' });
}
function submitted(value: Deployment) {
  void router.push(`/deployments/${value.id}`);
}
const snapshotText = computed(() => {
  const snapshot = deployment.data.value?.snapshot;
  if (!snapshot) return '';
  const config = snapshot.configuration;
  return JSON.stringify(
    {
      ...snapshot,
      configuration: {
        ...config,
        environment: config.environment.map((variable) =>
          variable.secretRefId
            ? {
                name: variable.name,
                secret: '已加密的秘密引用',
                secretRefId: variable.secretRefId,
                secretKey: variable.secretKey,
              }
            : variable,
        ),
      },
    },
    null,
    2,
  );
});
</script>

<template>
  <QueryState
    :pending="deployment.isPending.value"
    :error="deployment.error.value"
    :refreshing="deployment.isFetching.value"
    @retry="deployment.refetch()"
  >
    <template v-if="deployment.data.value">
      <nav class="breadcrumbs" aria-label="面包屑">
        <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight />
        <RouterLink
          v-if="service.data.value"
          :to="serviceLocation(service.data.value, 'deployments')"
          class="text-link"
          >{{ service.data.value.name }} · 部署记录</RouterLink
        >
        <span v-else>{{ deployment.data.value.snapshot.serviceName }} · 历史部署</span
        ><ChevronRight /><span>{{ deploymentId.slice(0, 8) }}</span>
      </nav>
      <div class="page-head">
        <div>
          <div class="flex flex-wrap items-center gap-3">
            <h1>
              {{ deployment.data.value.snapshot.serviceName }} ·
              {{ deployment.data.value.kind === 'git_deploy' ? 'Git 构建发布' : '镜像发布' }}
            </h1>
            <StatusBadge :status="deployment.data.value.status" />
          </div>
          <p>
            固定配置 r{{ deployment.data.value.configRevision }} ·
            {{ dateTime(deployment.data.value.createdAt) }}
          </p>
          <p class="meta mono break-all mt-2">{{ deploymentId }}</p>
        </div>
        <div class="actions">
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新部署状态"
            :disabled="deployment.isFetching.value"
            @click="deployment.refetch()"
            ><RefreshCw
          /></Button>
          <Button
            v-if="canRetry"
            variant="outline"
            :disabled="service.isFetching.value"
            @click="openRetry"
            ><RotateCcw />审阅原部署重试</Button
          >
          <Button
            v-if="active && !auth.restoreMode"
            variant="outline"
            :disabled="cancel.isPending.value || !!deployment.data.value.cancelRequestedAt"
            @click="requestCancel"
            ><Square />{{
              deployment.data.value.cancelRequestedAt ? '取消待确认' : '请求取消'
            }}</Button
          >
          <Button v-if="service.data.value" as-child variant="outline"
            ><RouterLink :to="serviceLocation(service.data.value)"
              ><ArrowLeft />返回服务</RouterLink
            ></Button
          >
        </div>
      </div>
      <ServiceMutationError class="mb-5" :error="cancel.error.value" />
      <div v-if="deployment.data.value.status === 'queued'" class="notice mb-6" role="status">
        <Clock3 />
        <div>
          <strong>部署已持久受理，等待执行</strong>
          <p>离开页面后仍会继续处理，受理成功不代表镜像已经运行。</p>
        </div>
      </div>
      <div
        v-if="deployment.data.value.cancelRequestedAt && active"
        class="notice notice-warning mb-6"
        role="status"
      >
        <Info />
        <p>取消意图已记录，正在等待执行器确认结束。</p>
      </div>
      <div
        v-if="deployment.data.value.status === 'failed'"
        class="notice notice-danger mb-6"
        role="alert"
      >
        <AlertCircle />
        <div class="min-w-0">
          <strong>{{
            deployment.data.value.errorMessage || '部署失败，请查看阶段与执行日志。'
          }}</strong>
          <p v-if="deployment.data.value.errorCode" class="mono break-all mt-2">
            {{ deployment.data.value.errorCode }}
          </p>
        </div>
      </div>
      <div
        v-if="deployment.data.value.appliedAt && deployment.data.value.status !== 'succeeded'"
        class="notice notice-warning mb-6"
      >
        <Info />
        <p>
          配置已于 {{ dateTime(deployment.data.value.appliedAt) }} 完整应用。{{
            active
              ? '正在继续确认运行状态。'
              : '这次任务未成功结束，已应用的配置仍需在服务概览核对。'
          }}
        </p>
      </div>
      <div v-if="!active" class="notice mb-6">
        <Info />
        <p>此处保留这次部署的最终结果。应用后续的健康变化请查看服务运行观察。</p>
      </div>
      <div
        v-if="retryOpen"
        ref="retryRegion"
        tabindex="-1"
        class="mb-6"
        aria-label="原部署重试预览"
      >
        <QueryState
          :pending="service.isPending.value"
          :error="service.error.value"
          :refreshing="service.isFetching.value"
          @retry="service.refetch()"
          ><ConfigurationReview
            v-if="service.data.value"
            :service="service.data.value"
            :retry-of="deployment.data.value"
            @submitted="submitted"
        /></QueryState>
        <Button variant="ghost" class="mt-3" @click="retryOpen = false">收起重试预览</Button>
      </div>
      <div class="split deployment-layout">
        <div class="stack min-w-0">
          <section class="panel" data-deployment-stages>
            <div class="section-head">
              <h2>发布阶段</h2>
              <span class="meta">{{
                active
                  ? stageLabels[deployment.data.value.phase] || deployment.data.value.phase
                  : stageLabels[deployment.data.value.status]
              }}</span>
            </div>
            <ol class="deployment-stages">
              <li>
                <span class="stage-icon text-success"><CheckCircle2 /></span>
                <div>
                  <strong>持久受理</strong>
                  <p class="meta mt-1">{{ dateTime(deployment.data.value.createdAt) }}</p>
                </div>
              </li>
              <li v-for="stage in stages" :key="stage.id">
                <span
                  :class="[
                    'stage-icon',
                    {
                      'text-success': stage.status === 'succeeded',
                      'text-destructive': stage.status === 'failed',
                    },
                  ]"
                  ><LoaderCircle
                    v-if="stage.status === 'running'"
                    class="animate-spin" /><CheckCircle2
                    v-else-if="stage.status === 'succeeded'" /><AlertCircle
                    v-else-if="stage.status === 'failed'" /><Circle v-else
                /></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <strong
                      >{{ stageLabels[stage.name] || stage.name
                      }}<span v-if="deployment.data.value.attempts > 1" class="meta ml-2"
                        >尝试 {{ stage.attempt }}</span
                      ></strong
                    ><span v-if="stage.status === 'skipped'" class="badge">未执行</span
                    ><StatusBadge v-else :status="stage.status" />
                  </div>
                  <p class="meta mt-1">{{ stageDescriptions[stage.name] }}</p>
                  <p class="meta mt-2">
                    {{
                      stage.startedAt
                        ? `开始 ${dateTime(stage.startedAt)}`
                        : stage.status === 'skipped'
                          ? '该步骤没有开始'
                          : '尚未开始'
                    }}<span v-if="stage.finishedAt"> · 结束 {{ dateTime(stage.finishedAt) }}</span>
                  </p>
                  <p v-if="stage.errorCode" class="mono text-destructive text-sm mt-2 break-all">
                    {{ stage.errorCode }}
                  </p>
                </div>
              </li>
            </ol>
            <p v-if="!stages.length" class="meta mt-4">暂无阶段记录，刷新后核对执行器进度。</p>
            <p v-if="deployment.data.value.kind === 'image_deploy'" class="meta mt-6">
              构建：不适用。这次部署直接使用现有镜像。
            </p>
          </section>
          <BuildSummary
            v-if="deployment.data.value.kind === 'git_deploy'"
            :build="deployment.data.value.build"
          />
          <BuildLogs
            v-if="deployment.data.value.kind === 'git_deploy'"
            :deployment-id="deploymentId"
            :runs="deployment.data.value.build?.runs ?? []"
            :active="active"
          />
          <DeploymentLogs
            :deployment-id="deploymentId"
            :active="active"
            :kind="deployment.data.value.kind"
          />
          <DeploymentFailureObservation
            v-if="deployment.data.value.failureObservation"
            :evidence="deployment.data.value.failureObservation"
          />
          <section class="panel">
            <div class="section-head">
              <h2>固定配置快照</h2>
              <span class="badge">r{{ deployment.data.value.configRevision }}</span>
            </div>
            <GitSourceSummary
              v-if="deployment.data.value.snapshot.version === 3"
              class="mb-6"
              :revision="deployment.data.value.snapshot.source.revision"
              :commit-sha="deployment.data.value.snapshot.source.commitSha"
            />
            <dl class="detail-list">
              <div v-if="deployment.data.value.snapshot.version !== 3">
                <dt>提交镜像</dt>
                <dd class="mono break-all">
                  {{ deployment.data.value.snapshot.configuration.image }}
                </dd>
              </div>
              <div>
                <dt>解析产物</dt>
                <dd class="mono break-all">
                  {{
                    deployment.data.value.resolvedImage?.deployReference ||
                    '尚未解析出可部署的镜像摘要'
                  }}
                </dd>
              </div>
              <div>
                <dt>副本数</dt>
                <dd>{{ deployment.data.value.snapshot.configuration.replicas }}</dd>
              </div>
              <div>
                <dt>健康等待上限</dt>
                <dd>{{ deployment.data.value.snapshot.configuration.healthTimeoutSeconds }} 秒</dd>
              </div>
            </dl>
            <DeploymentStorageSnapshot :snapshot="deployment.data.value.snapshot" class="mt-6" />
            <details class="snapshot-details mt-5">
              <summary>查看完整配置</summary>
              <pre class="snapshot-json mt-4" tabindex="0" aria-label="固定配置快照">{{
                snapshotText
              }}</pre>
            </details>
          </section>
        </div>
        <aside class="panel self-start min-w-0">
          <h2>固定发布目标</h2>
          <p class="meta mt-2">任务保存时确定，重试保留原目标。</p>
          <dl class="detail-list mt-4">
            <div>
              <dt>项目</dt>
              <dd>
                <RouterLink
                  :to="{
                    path: `/projects/${deployment.data.value.target.projectId}`,
                    query:
                      service.data.value?.environmentId ===
                      deployment.data.value.target.environmentId
                        ? { environment: service.data.value.environment.slug }
                        : { tab: 'environments' },
                  }"
                  class="text-link break-all"
                  >{{
                    service.data.value?.projectId === deployment.data.value.target.projectId
                      ? service.data.value.project.name
                      : deployment.data.value.target.projectId
                  }}</RouterLink
                >
              </dd>
            </div>
            <div>
              <dt>环境</dt>
              <dd class="break-all">
                {{
                  service.data.value?.environmentId === deployment.data.value.target.environmentId
                    ? service.data.value.environment.name
                    : deployment.data.value.target.environmentId
                }}
              </dd>
            </div>
            <div>
              <dt>继承集群</dt>
              <dd>
                <RouterLink
                  :to="`/clusters/${deployment.data.value.target.clusterId}`"
                  class="text-link break-all"
                  >{{
                    service.data.value?.clusterId === deployment.data.value.target.clusterId
                      ? service.data.value.cluster.name
                      : deployment.data.value.target.clusterId
                  }}</RouterLink
                >
              </dd>
            </div>
            <div>
              <dt>命名空间</dt>
              <dd class="mono break-all">{{ deployment.data.value.target.namespace }}</dd>
            </div>
            <div>
              <dt>受管服务</dt>
              <dd class="mono break-all">{{ deployment.data.value.target.serviceName }}</dd>
            </div>
            <div>
              <dt>配置应用</dt>
              <dd>
                {{
                  deployment.data.value.appliedAt
                    ? dateTime(deployment.data.value.appliedAt)
                    : '尚无完整应用记录'
                }}
              </dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{{ dateTime(deployment.data.value.finishedAt) }}</dd>
            </div>
            <div>
              <dt>尝试次数</dt>
              <dd>
                {{ deployment.data.value.attempts }} / {{ deployment.data.value.maxAttempts }}
              </dd>
            </div>
            <div v-if="deployment.data.value.retryOfId">
              <dt>原部署</dt>
              <dd>
                <RouterLink
                  :to="`/deployments/${deployment.data.value.retryOfId}`"
                  class="text-link mono break-all"
                  >{{ deployment.data.value.retryOfId }}</RouterLink
                >
              </dd>
            </div>
          </dl>
          <p v-if="!deployment.data.value.serviceId" class="meta mt-5">
            服务已删除，此部署作为历史记录保留。
          </p>
        </aside>
      </div>
    </template>
  </QueryState>
</template>

<style scoped>
.deployment-stages {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}
.deployment-stages li {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.stage-icon {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  flex-shrink: 0;
  color: var(--muted-foreground);
}
.stage-icon svg {
  width: 1.125rem;
  height: 1.125rem;
}
.stage-icon.text-success {
  color: var(--success);
}
.stage-icon.text-destructive {
  color: var(--destructive);
}
.snapshot-details {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
}
.snapshot-details summary {
  cursor: pointer;
  padding: 0.5rem 0;
}
.snapshot-json {
  font: 0.8125rem/1.65 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 30rem;
  overflow: auto;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
}
</style>
