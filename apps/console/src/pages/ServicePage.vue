<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import {
  ChevronRight,
  Layers3,
  RefreshCw,
  Play,
  Square,
  RotateCcw,
  LoaderCircle,
  Info,
  AlertCircle,
  ArrowRight,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import ServiceRuntimeBadge from '@/components/services/ServiceRuntimeBadge.vue';
import ServiceRuntimePanel from '@/components/services/ServiceRuntimePanel.vue';
import ConfigurationReview from '@/components/services/ConfigurationReview.vue';
import ServiceGitSource from '@/components/git/ServiceGitSource.vue';
import ServicePendingCommits from '@/components/git/ServicePendingCommits.vue';
import { serviceSourceLabel } from '@/components/git/presentation';
import DeploymentCollection from '@/components/services/DeploymentCollection.vue';
import ServiceLogViewer from '@/components/services/ServiceLogViewer.vue';
import ServiceNetworkPanel from '@/components/networking/ServiceNetworkPanel.vue';
import ServiceStoragePanel from '@/components/storage/ServiceStoragePanel.vue';
import ServiceDeletionReview from '@/components/storage/ServiceDeletionReview.vue';
import { invalidateStorage } from '@/components/storage/queries';
import type { Database } from '@/components/storage/types';
import {
  configurationLabels,
  draftConfiguration,
  serviceDraft,
  serviceLocation,
  taskLocation,
} from '@/components/services/presentation';
import type { Deployment, Service, UpdateServiceInput } from '@/components/services/types';
import { draftRuntimeConfiguration } from '@/components/services/presentation';
import type { Operation } from '@/lib/types';
import { api, request } from '@/lib/api';
import type { Envelope } from '@/lib/types';
import { invalidateCollection, queryClient } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const serviceId = String(route.params.serviceId);
const service = useQuery({
  queryKey: ['service', serviceId],
  queryFn: ({ signal }) => api.get<Service>(`/services/${serviceId}`, signal),
  refetchInterval: 10_000,
});
const database = useQuery({
  queryKey: computed(() => ['database', service.data.value?.databaseInstanceId]),
  enabled: computed(() => !!service.data.value?.databaseInstanceId),
  queryFn: ({ queryKey, signal }) => api.get<Database>(`/databases/${queryKey[1]}`, signal),
});
const isGit = computed(() => service.data.value?.source?.kind === 'github');
const tabs = computed(() => [
  { id: 'overview', label: '概览' },
  ...(isGit.value ? [{ id: 'source', label: 'Git 来源' }] : []),
  { id: 'configuration', label: '配置草稿' },
  { id: 'review', label: '发布预览' },
  { id: 'deployments', label: '部署记录' },
  { id: 'logs', label: '容器日志' },
  { id: 'network', label: '域名与网络' },
  { id: 'storage', label: '数据与存储' },
]);
const tab = computed(() =>
  tabs.value.some((value) => value.id === route.query.tab) ? String(route.query.tab) : 'overview',
);
const tabNavigation = ref<HTMLElement>();
watch(
  [tab, tabNavigation],
  ([_tab, navigation], _previous, onCleanup) => {
    if (!navigation) return;
    const revealActiveTab = () => {
      const selected = navigation.querySelector<HTMLElement>('[aria-current="page"]');
      if (!selected) return;
      const bounds = navigation.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      const left = bounds.left + navigation.clientLeft;
      const right = left + navigation.clientWidth;
      const delta =
        selectedBounds.left < left
          ? selectedBounds.left - left
          : selectedBounds.right > right
            ? selectedBounds.right - right
            : 0;
      if (Math.abs(delta) > 1) navigation.scrollBy({ left: delta, behavior: 'instant' });
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(navigation);
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' },
);
const contextMismatch = computed(
  () =>
    !!service.data.value &&
    ((route.params.projectId && route.params.projectId !== service.data.value.projectId) ||
      (typeof route.query.environment === 'string' &&
        route.query.environment !== service.data.value.environment.slug)),
);
const form = ref(serviceDraft());
const guard = useDirtyForm(form, '服务配置草稿');
const localError = ref<Error | null>(null);
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
watch(
  service.data,
  (value) => {
    if (value && !guard.dirty.value) {
      form.value = serviceDraft(value);
      guard.markClean();
    }
  },
  { immediate: true },
);
const save = useMutation({
  gcTime: 0,
  mutationFn: (input: UpdateServiceInput) => api.update<Service>(`/services/${serviceId}`, input),
  onSuccess: async (value) => {
    form.value = serviceDraft(value);
    guard.markClean();
    queryClient.setQueryData(['service', serviceId], value);
    await invalidateCollection('/services');
    if (active()) ui.toast('配置草稿已保存，发布后才会更新运行实例。');
  },
});
async function saveDraft() {
  if (
    !service.data.value ||
    auth.restoreMode ||
    save.isPending.value ||
    service.data.value.activeTask
  )
    return;
  localError.value = null;
  if (editor.value && !(await editor.value.validate())) return;
  try {
    save.mutate({
      revision: form.value.revision,
      name: form.value.name.trim(),
      description: form.value.description,
      ...(isGit.value
        ? {}
        : { registryCredentialRefId: form.value.registryCredentialRefId || null }),
      configuration: isGit.value
        ? draftRuntimeConfiguration(form.value)
        : draftConfiguration(form.value),
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查配置。');
    await nextTick();
    document.querySelector<HTMLElement>('[data-mutation-error]')?.focus();
  }
}
async function reloadDraft() {
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新的已保存草稿？',
      description: '本页尚未保存的修改会被替换。已发布快照保持不变。',
      confirmText: '载入最新草稿',
    }))
  )
    return;
  const result = await service.refetch();
  if (result.data && active()) {
    form.value = serviceDraft(result.data);
    guard.markClean();
    localError.value = null;
    save.reset();
  }
}
const operation = useMutation({
  mutationFn: async (input: {
    action: 'restart' | 'resume' | 'stop' | 'delete';
    revision: number;
    key: string;
  }) =>
    input.action === 'delete'
      ? (
          await request<Envelope<Operation>>(`/services/${serviceId}`, {
            method: 'DELETE',
            body: { revision: input.revision },
            idempotencyKey: input.key,
          })
        ).data
      : api.create<Operation>(
          `/services/${serviceId}/${input.action}`,
          { revision: input.revision },
          input.key,
        ),
  onSuccess: async (value) => {
    queryClient.setQueryData(['operation', value.id], value);
    await Promise.all([
      invalidateCollection('/operations'),
      invalidateCollection('/services'),
      invalidateStorage(serviceId),
      service.refetch(),
    ]);
    if (active()) await router.push(`/operations/${value.id}`);
  },
});
const operationKeys = new Map<string, string>();
async function runAction(action: 'restart' | 'resume' | 'stop') {
  const current = service.data.value;
  if (!current || current.activeTask || auth.restoreMode || operation.isPending.value) return;
  const names = {
    restart: '重启服务',
    resume: isGit.value ? '恢复原已发布版本' : '恢复运行',
    stop: '停止服务',
  };
  const descriptions = {
    restart: `重启已发布配置 r${current.published?.configRevision ?? '未知'}，不应用尚未发布的草稿。`,
    resume: `恢复完整已发布配置 r${current.published?.configRevision ?? '未知'} 及其副本数，当前草稿不会发布。${isGit.value ? '使用原产物，不开始新构建，也不消费待发布提交。' : ''}`,
    stop: '将运行副本缩减为零，保留服务配置、数据卷与部署历史。',
  };
  if (
    !(await ui.confirm({
      title: `${names[action]}「${current.name}」？`,
      description: `${current.project.name} / ${current.environment.name} · ${current.cluster.name}。${descriptions[action]}`,
      confirmText: names[action],
    }))
  )
    return;
  if (!active()) return;
  const token = `${action}:${current.revision}`;
  if (!operationKeys.has(token)) operationKeys.set(token, idempotencyKey());
  operation.mutate({ action, revision: current.revision, key: operationKeys.get(token)! });
}
function deleteReviewed(revision: number) {
  const current = service.data.value;
  if (
    !current ||
    current.revision !== revision ||
    current.activeTask ||
    auth.restoreMode ||
    operation.isPending.value
  )
    return;
  const token = `delete:${revision}`;
  if (!operationKeys.has(token)) operationKeys.set(token, idempotencyKey());
  operation.mutate({ action: 'delete', revision, key: operationKeys.get(token)! });
}
const writesLocked = computed(
  () =>
    auth.restoreMode ||
    save.isPending.value ||
    operation.isPending.value ||
    !!service.data.value?.activeTask,
);
const canResumeRestart = computed(
  () => !!service.data.value?.published && service.data.value.configurationState === 'consistent',
);
function location(value: string) {
  return {
    path: route.path,
    query: {
      environment: service.data.value?.environment.slug,
      ...(value === 'overview' ? {} : { tab: value }),
    },
  };
}
function deployed(value: Deployment) {
  void router.push(`/deployments/${value.id}`);
}
function showLogs(podUid: string, container: string) {
  void router.push({
    path: route.path,
    query: { environment: service.data.value?.environment.slug, tab: 'logs', podUid, container },
  });
}
onScopeDispose(() => {
  for (const variable of form.value.variables) if (variable.mode === 'secret') variable.value = '';
});
</script>
<template>
  <QueryState
    :pending="service.isPending.value"
    :error="service.error.value"
    @retry="service.refetch()"
  >
    <template v-if="service.data.value">
      <div v-if="contextMismatch" class="notice notice-warning">
        <AlertCircle />
        <div>
          <strong>服务与当前项目或环境不匹配</strong>
          <p>
            这个服务实际属于 {{ service.data.value.project.name }} /
            {{ service.data.value.environment.name }}。当前链接不会改变它的部署目标。
          </p>
          <RouterLink :to="serviceLocation(service.data.value)" class="text-link mt-3 inline-block"
            >打开正确的服务上下文</RouterLink
          >
        </div>
      </div>
      <template v-else>
        <nav class="breadcrumbs" aria-label="面包屑">
          <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight /><RouterLink
            :to="{
              path: `/projects/${service.data.value.projectId}`,
              query: { environment: service.data.value.environment.slug },
            }"
            class="text-link"
            >{{ service.data.value.project.name }}</RouterLink
          ><ChevronRight /><span>{{ service.data.value.environment.name }}</span
          ><ChevronRight /><span>{{ service.data.value.name }}</span>
        </nav>
        <div class="page-head">
          <div>
            <div class="flex items-center flex-wrap gap-3">
              <h1>{{ service.data.value.name }}</h1>
              <ServiceRuntimeBadge :service="service.data.value" />
            </div>
            <p>
              {{
                service.data.value.description ||
                (isGit ? '管理 Git 来源、运行配置、发布与实例。' : '管理镜像配置、部署与运行实例。')
              }}
            </p>
            <div class="flex flex-wrap items-center gap-2 mt-3 meta">
              <Layers3 class="size-4" /><RouterLink
                :to="`/clusters/${service.data.value.clusterId}`"
                class="text-link"
                >{{ service.data.value.cluster.name }}</RouterLink
              ><span>来自项目 · {{ service.data.value.environment.name }}</span>
              <span v-if="service.data.value.controller"
                >· {{ service.data.value.controller.kind }}</span
              >
              <span v-if="service.data.value.template">
                · {{ service.data.value.template.id }} {{ service.data.value.template.version }}
              </span>
              <RouterLink
                v-if="service.data.value.databaseInstanceId"
                :to="`/databases/${service.data.value.databaseInstanceId}`"
                class="text-link"
                >查看数据库身份</RouterLink
              >
            </div>
          </div>
          <div class="actions">
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新服务"
              :disabled="service.isFetching.value"
              @click="service.refetch()"
              ><RefreshCw /></Button
            ><Button
              v-if="service.data.value.desiredState === 'stopped'"
              variant="outline"
              :disabled="writesLocked || !canResumeRestart"
              @click="runAction('resume')"
              ><Play />{{ isGit ? '恢复原已发布版本' : '恢复运行' }}</Button
            ><template v-else
              ><Button
                variant="outline"
                :disabled="writesLocked || !canResumeRestart"
                @click="runAction('restart')"
                ><RotateCcw />重启</Button
              ><Button variant="outline" :disabled="writesLocked" @click="runAction('stop')"
                ><Square />停止</Button
              ></template
            ><Button as-child :disabled="writesLocked"
              ><RouterLink :to="location('review')"><ArrowRight />发布预览</RouterLink></Button
            >
          </div>
        </div>
        <ServiceMutationError class="mb-5" :error="operation.error.value" />
        <div v-if="service.data.value.activeTask" class="notice mb-5" role="status">
          <LoaderCircle class="animate-spin" />
          <p>
            当前服务正在执行{{
              service.data.value.activeTask.type === 'deployment' ? '部署' : '操作'
            }}，配置与运行变更暂不可并行。<RouterLink
              :to="taskLocation(service.data.value.activeTask)"
              class="text-link ml-2"
              >查看当前任务</RouterLink
            >
          </p>
        </div>
        <nav ref="tabNavigation" class="page-tabs" aria-label="服务页面">
          <RouterLink
            v-for="item in tabs"
            :key="item.id"
            :to="location(item.id)"
            class="page-tab"
            :aria-current="tab === item.id ? 'page' : undefined"
            >{{ item.label
            }}<span
              v-if="item.id === 'configuration' && guard.dirty.value"
              class="ml-1"
              aria-label="有未保存修改"
              >•</span
            ></RouterLink
          >
        </nav>
        <template v-if="tab === 'overview'">
          <section class="panel mb-6">
            <dl class="configuration-summary">
              <div>
                <dt>配置草稿</dt>
                <dd>
                  r{{ service.data.value.configRevision
                  }}<span
                    v-if="service.data.value.hasUnpublishedChanges"
                    class="badge badge-warning ml-2"
                    >待发布</span
                  >
                  <p class="meta mono mt-2 break-all">
                    {{ serviceSourceLabel(service.data.value) }}
                  </p>
                  <RouterLink
                    :to="location('configuration')"
                    class="text-link text-sm mt-3 inline-block"
                    >编辑草稿</RouterLink
                  >
                </dd>
              </div>
              <div>
                <dt>已完整应用</dt>
                <dd>
                  {{
                    service.data.value.published
                      ? `r${service.data.value.published.configRevision}`
                      : '尚未发布'
                  }}
                  <p class="meta mt-2">
                    {{
                      service.data.value.published
                        ? dateTime(service.data.value.published.appliedAt)
                        : '发布后记录不可变的来源、配置与产物'
                    }}
                  </p>
                  <p
                    v-if="service.data.value.published?.source?.kind === 'github'"
                    class="meta mono mt-2 break-all"
                  >
                    {{ service.data.value.published.source.commitSha }}
                  </p>
                  <p
                    v-if="isGit && service.data.value.published?.image"
                    class="meta mono mt-2 break-all"
                  >
                    {{ service.data.value.published.image.deployReference }}
                  </p>
                  <RouterLink
                    v-if="service.data.value.published"
                    :to="`/deployments/${service.data.value.published.deploymentId}`"
                    class="text-link text-sm mt-3 inline-block"
                    >查看这次部署</RouterLink
                  >
                </dd>
              </div>
              <div>
                <dt>配置观察</dt>
                <dd class="text-base">
                  {{ configurationLabels[service.data.value.configurationState] }}
                  <p class="meta mt-2">
                    期望状态：{{ service.data.value.desiredState === 'stopped' ? '停止' : '运行' }}
                  </p>
                  <p v-if="service.data.value.lastSuccessfulDeploymentId" class="meta mt-2">
                    最近成功
                    <RouterLink
                      :to="`/deployments/${service.data.value.lastSuccessfulDeploymentId}`"
                      class="text-link"
                      >查看记录</RouterLink
                    >
                  </p>
                </dd>
              </div>
            </dl>
          </section>
          <div
            v-if="
              service.data.value.hasUnpublishedChanges ||
              ['partial', 'drifted', 'unknown'].includes(service.data.value.configurationState)
            "
            class="notice notice-warning mb-6"
          >
            <Info />
            <div>
              <strong>{{
                service.data.value.configurationState === 'partial'
                  ? '配置只完成部分应用'
                  : service.data.value.configurationState === 'drifted'
                    ? '检测到配置漂移'
                    : '配置需要审阅'
              }}</strong>
              <p>当前草稿与已发布快照分开保存。确认差异后再发布。</p>
              <RouterLink :to="location('review')" class="text-link mt-2 inline-block"
                >审阅发布差异</RouterLink
              >
            </div>
          </div>
          <div v-if="service.data.value.lastErrorMessage" class="notice notice-danger mb-6">
            <AlertCircle />
            <div>
              <strong>{{ service.data.value.lastErrorMessage }}</strong>
              <p v-if="service.data.value.lastErrorCode" class="meta mono mt-2">
                {{ service.data.value.lastErrorCode }}
              </p>
            </div>
          </div>
          <ServicePendingCommits v-if="isGit" :service="service.data.value" />
          <ServiceRuntimePanel :service="service.data.value" @logs="showLogs" />
        </template>
        <ServiceGitSource v-else-if="tab === 'source' && isGit" :service="service.data.value" />
        <template v-else-if="tab === 'configuration'">
          <div class="notice mb-6">
            <Info />
            <p>
              正在编辑配置草稿 r{{
                service.data.value.configRevision
              }}。保存不会立即改变已发布实例。
            </p>
          </div>
          <form class="panel" novalidate @submit.prevent="saveDraft">
            <ServiceConfigurationEditor
              :source-kind="service.data.value.source?.kind"
              ref="editor"
              v-model="form"
              :disabled="writesLocked"
              :protected-configuration="!!service.data.value.databaseInstanceId"
              :protection-reason="database.data.value?.protection.reason"
            /><ServiceMutationError class="mt-5" :error="localError || save.error.value" />
            <div class="form-footer">
              <Button
                type="button"
                variant="outline"
                :disabled="save.isPending.value"
                @click="reloadDraft"
                >载入最新草稿</Button
              ><Button type="submit" :disabled="writesLocked || !guard.dirty.value"
                ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
                  save.isPending.value ? '正在保存…' : '保存草稿'
                }}</Button
              >
            </div>
          </form>
          <ServiceDeletionReview
            :service="service.data.value"
            :disabled="writesLocked"
            :pending="operation.isPending.value"
            :error="operation.error.value"
            @confirm="deleteReviewed"
          />
        </template>
        <ConfigurationReview
          v-else-if="tab === 'review'"
          :service="service.data.value"
          :pending-target-id="
            typeof route.query.target === 'string' ? route.query.target : undefined
          "
          @submitted="deployed"
        />
        <DeploymentCollection v-else-if="tab === 'deployments'" :service-id="serviceId" />
        <template v-else-if="tab === 'logs'">
          <p v-if="isGit" class="meta mb-4">
            下面显示所选 Pod 的容器运行输出。
            <RouterLink
              v-if="service.data.value.activeTask?.type === 'deployment'"
              :to="'/deployments/' + service.data.value.activeTask.id"
              class="text-link"
              >查看当前发布的构建、推送与阶段日志</RouterLink
            >
            <RouterLink
              v-else-if="service.data.value.published"
              :to="'/deployments/' + service.data.value.published.deploymentId"
              class="text-link"
              >查看已发布版本的构建、推送与阶段日志</RouterLink
            >
          </p>
          <ServiceLogViewer :service="service.data.value" />
        </template>
        <ServiceNetworkPanel v-else-if="tab === 'network'" :service-id="serviceId" />
        <ServiceStoragePanel v-else-if="tab === 'storage'" :service="service.data.value" />
      </template>
    </template>
  </QueryState>
</template>
<style scoped>
.configuration-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.5rem;
  margin: 0;
}
.configuration-summary dt {
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.configuration-summary dd {
  margin: 0.5rem 0 0;
  font-size: 1.125rem;
  font-weight: 550;
}
.configuration-summary > div + div {
  border-left: 1px solid var(--border);
  padding-left: 1.5rem;
}
@media (max-width: 750px) {
  .configuration-summary {
    grid-template-columns: 1fr;
  }
  .configuration-summary > div + div {
    border-left: 0;
    border-top: 1px solid var(--border);
    padding-left: 0;
    padding-top: 1.25rem;
  }
}
</style>
