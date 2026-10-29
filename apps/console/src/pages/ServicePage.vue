<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from 'reka-ui';
import {
  ChevronRight,
  ChevronDown,
  Layers3,
  RefreshCw,
  Play,
  Square,
  RotateCcw,
  LoaderCircle,
  Info,
  AlertCircle,
  ArrowRight,
  Package,
  GitBranch,
  Ellipsis,
  ScrollText,
  History,
  Trash2,
  Settings2,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceVariablesEditor from '@/components/services/ServiceVariablesEditor.vue';
import ServiceWorkspacePanel from '@/components/services/ServiceWorkspacePanel.vue';
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
import { sampleFreshness } from '@/components/infrastructure/format';
import { useObservationClock } from '@/components/infrastructure/useObservationClock';
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
const tabs = [
  { id: 'overview', label: '服务状态' },
  { id: 'variables', label: '环境变量' },
  { id: 'usage', label: '用量' },
  { id: 'network', label: '网络' },
  { id: 'storage', label: '数据与存储' },
  { id: 'settings', label: '设置' },
] as const;
type WorkspaceTab = (typeof tabs)[number]['id'];
type WorkspacePanel = 'review' | 'logs' | 'deployments';
type SettingsSection = 'configuration' | 'source' | 'danger';
const panel = computed<WorkspacePanel | null>(() =>
  ['review', 'logs', 'deployments'].includes(String(route.query.tab))
    ? (route.query.tab as WorkspacePanel)
    : null,
);
const tab = computed<WorkspaceTab>(() => {
  const value = panel.value ? route.query.view : route.query.tab;
  if (value === 'source' || value === 'configuration') return 'settings';
  return tabs.some((item) => item.id === value) ? (value as WorkspaceTab) : 'overview';
});
const settingsSection = computed<SettingsSection>(() => {
  if (route.query.tab === 'source') return isGit.value ? 'source' : 'configuration';
  if (route.query.tab === 'configuration') return 'configuration';
  return route.query.section === 'danger'
    ? 'danger'
    : route.query.section === 'source' && isGit.value
      ? 'source'
      : 'configuration';
});
const visitedTabs = ref(new Set<WorkspaceTab>());
watch(tab, (value) => visitedTabs.value.add(value), { immediate: true });
const editingMounted = computed(
  () => visitedTabs.value.has('variables') || visitedTabs.value.has('settings'),
);
const editingVisible = computed(
  () =>
    tab.value === 'variables' ||
    (tab.value === 'settings' && settingsSection.value === 'configuration'),
);
const panelTitles: Record<WorkspacePanel, string> = {
  review: '部署服务',
  logs: '运行日志',
  deployments: '部署记录',
};
const reviewBusy = ref(false);
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
const draftForm = ref<HTMLFormElement>();
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
  const invalid = draftForm.value?.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input:invalid, select:invalid, textarea:invalid');
  if (invalid) {
    const section = invalid.closest<HTMLElement>('[data-workspace-section]')?.dataset
      .workspaceSection;
    await router.push(location(section === 'variables' ? 'variables' : 'settings'));
    await nextTick();
    if (section !== 'variables' && editor.value) await editor.value.validate();
    else {
      invalid.focus();
      invalid.reportValidity();
    }
    return;
  }
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
function location(value: string, extra: Record<string, string> = {}) {
  const {
    tab: _tab,
    view: _view,
    section: _section,
    target: _target,
    podUid: _podUid,
    container: _container,
    ...query
  } = route.query;
  const isPanel = ['review', 'logs', 'deployments'].includes(value);
  return {
    path: route.path,
    query: {
      ...query,
      ...(value === 'overview' ? {} : { tab: value }),
      ...(isPanel && tab.value !== 'overview' ? { view: tab.value } : {}),
      ...(isPanel && tab.value === 'settings' ? { section: settingsSection.value } : {}),
      ...extra,
    },
  };
}
function settingsLocation(section: SettingsSection) {
  return location('settings', section === 'configuration' ? {} : { section });
}
function closePanel(open: boolean) {
  if (open || reviewBusy.value) return;
  void router.replace(
    tab.value === 'settings' ? settingsLocation(settingsSection.value) : location(tab.value),
  );
}
function deployed(value: Deployment) {
  reviewBusy.value = false;
  void router.push(`/deployments/${value.id}`);
}
function showLogs(podUid: string, container: string) {
  void router.push(location('logs', { podUid, container }));
}
function allowReviewNavigation() {
  if (!reviewBusy.value || !auth.user) return true;
  ui.toast('部署请求正在处理，请稍后再离开。');
  return false;
}
onBeforeRouteUpdate(allowReviewNavigation);
onBeforeRouteLeave(allowReviewNavigation);
const now = useObservationClock();
const observationCurrent = computed(
  () =>
    !!service.data.value &&
    !service.data.value.observationStale &&
    sampleFreshness(service.data.value.lastObservedAt, now.value) === 'fresh',
);
const observedWorkload = computed(
  () => service.data.value?.observation?.controller ?? service.data.value?.observation?.deployment,
);
const statusDescription = computed(() => {
  const current = service.data.value;
  if (!current || current.runtimeState === 'unpublished')
    return '服务已创建。确认配置并部署后，就能在这里查看运行状态。';
  if (!observationCurrent.value)
    return '尚未取得新的运行观察。当前状态未知，可查看最近的实例信息和任务结果。';
  if (current.runtimeState === 'stopped') return '工作负载已停止，配置、数据卷和部署历史仍然保留。';
  if (current.runtimeState === 'running')
    return '服务正在运行。可以查看运行日志，或继续配置网络与数据。';
  if (current.runtimeState === 'pending')
    return '实例正在等待就绪。打开用量查看实例、容器和最近事件。';
  if (current.runtimeState === 'missing')
    return '未观察到预期的运行资源。请检查最近任务与配置差异。';
  if (current.runtimeState === 'degraded')
    return '部分实例运行异常。查看运行日志和实例事件以定位原因。';
  return '当前运行状态未知。查看最近观察与任务结果，确认服务状态。';
});
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
      <div v-else class="service-workspace" data-service-workspace>
        <nav class="breadcrumbs" aria-label="面包屑">
          <RouterLink to="/projects" class="text-link">项目</RouterLink>
          <ChevronRight />
          <RouterLink
            :to="{
              path: `/projects/${service.data.value.projectId}`,
              query: { environment: service.data.value.environment.slug },
            }"
            class="text-link"
            >{{ service.data.value.project.name }}</RouterLink
          >
          <ChevronRight /><span>{{ service.data.value.name }}</span>
        </nav>
        <header class="service-workspace-head">
          <div class="service-heading">
            <span class="service-mark" aria-hidden="true"
              ><GitBranch v-if="isGit" /><Package v-else
            /></span>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-3">
                <h1>{{ service.data.value.name }}</h1>
                <ServiceRuntimeBadge :service="service.data.value" />
              </div>
              <p v-if="service.data.value.description" class="meta mt-2">
                {{ service.data.value.description }}
              </p>
              <div class="service-heading-meta meta">
                <RouterLink
                  :to="settingsLocation(isGit ? 'source' : 'configuration')"
                  class="service-source-link"
                  :title="serviceSourceLabel(service.data.value)"
                  >{{ serviceSourceLabel(service.data.value) }}</RouterLink
                >
                <span class="service-heading-target"
                  ><Layers3 class="size-3.5" />
                  <RouterLink :to="`/clusters/${service.data.value.clusterId}`" class="text-link">{{
                    service.data.value.cluster.name
                  }}</RouterLink></span
                >
              </div>
            </div>
          </div>
          <div class="service-primary-actions">
            <Button as-child :disabled="writesLocked" data-service-deploy>
              <RouterLink :to="location('review')"><Play />部署</RouterLink>
            </Button>
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <Button variant="outline" size="icon" aria-label="更多服务操作"
                  ><Ellipsis
                /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="service-action-menu" align="end" :side-offset="8">
                  <DropdownMenuItem
                    class="service-action-item"
                    :disabled="service.isFetching.value"
                    @select="service.refetch()"
                    ><RefreshCw />刷新状态</DropdownMenuItem
                  >
                  <DropdownMenuSeparator class="service-action-separator" />
                  <DropdownMenuItem
                    v-if="service.data.value.desiredState === 'stopped'"
                    class="service-action-item"
                    :disabled="writesLocked || !canResumeRestart"
                    @select="runAction('resume')"
                    ><Play />{{ isGit ? '恢复原已发布版本' : '恢复运行' }}</DropdownMenuItem
                  >
                  <template v-else>
                    <DropdownMenuItem
                      class="service-action-item"
                      :disabled="writesLocked || !canResumeRestart"
                      @select="runAction('restart')"
                      ><RotateCcw />重启服务</DropdownMenuItem
                    >
                    <DropdownMenuItem
                      class="service-action-item"
                      :disabled="writesLocked"
                      @select="runAction('stop')"
                      ><Square />停止服务</DropdownMenuItem
                    >
                  </template>
                  <DropdownMenuSeparator class="service-action-separator" />
                  <DropdownMenuItem class="service-action-item" as-child>
                    <RouterLink :to="settingsLocation('configuration')"
                      ><Settings2 />服务设置</RouterLink
                    >
                  </DropdownMenuItem>
                  <DropdownMenuItem class="service-action-item service-action-danger" as-child>
                    <RouterLink :to="settingsLocation('danger')"><Trash2 />删除服务…</RouterLink>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </div>
        </header>
        <ServiceMutationError class="mb-5" :error="operation.error.value" />
        <div v-if="service.data.value.activeTask" class="notice mb-5" role="status">
          <LoaderCircle class="animate-spin" />
          <p>
            正在{{
              service.data.value.activeTask.type === 'deployment' ? '部署服务' : '执行服务操作'
            }}，完成后可继续修改。
            <RouterLink :to="taskLocation(service.data.value.activeTask)" class="text-link ml-2"
              >查看当前任务</RouterLink
            >
          </p>
        </div>
        <nav ref="tabNavigation" class="page-tabs service-tabs" aria-label="服务页面">
          <RouterLink
            v-for="item in tabs"
            :key="item.id"
            :to="location(item.id)"
            class="page-tab"
            :aria-current="tab === item.id ? 'page' : undefined"
            >{{ item.label }}
            <span
              v-if="['settings', 'variables'].includes(item.id) && guard.dirty.value"
              class="service-dirty-dot"
              aria-label="配置有未保存修改"
            />
          </RouterLink>
        </nav>
        <div v-if="guard.dirty.value && !editingVisible" class="workspace-draft-note" role="status">
          <span>有未保存的配置修改，切换页签会保留草稿。</span>
          <RouterLink :to="settingsLocation('configuration')" class="text-link"
            >继续编辑</RouterLink
          >
        </div>
        <div v-if="tab === 'overview'" class="stack" data-service-status>
          <section class="service-status-section">
            <div class="section-head">
              <div>
                <h2>运行状态</h2>
                <p class="meta mt-2 service-status-copy">{{ statusDescription }}</p>
              </div>
              <div class="actions">
                <Button as-child variant="outline"
                  ><RouterLink :to="location('logs')"><ScrollText />日志</RouterLink></Button
                >
                <Button as-child variant="outline"
                  ><RouterLink :to="location('deployments')"
                    ><History />部署记录</RouterLink
                  ></Button
                >
              </div>
            </div>
            <dl class="service-status-facts">
              <div>
                <dt>已发布版本</dt>
                <dd>
                  <RouterLink
                    v-if="service.data.value.published"
                    :to="`/deployments/${service.data.value.published.deploymentId}`"
                    class="text-link"
                    >r{{ service.data.value.published.configRevision }}</RouterLink
                  >
                  <span v-else>尚未部署</span>
                </dd>
              </div>
              <div>
                <dt>就绪实例</dt>
                <dd>
                  {{
                    observationCurrent && observedWorkload
                      ? `${observedWorkload.readyReplicas ?? '未知'} / ${observedWorkload.replicas}`
                      : '未知'
                  }}
                </dd>
              </div>
              <div>
                <dt>期望状态</dt>
                <dd>{{ service.data.value.desiredState === 'stopped' ? '停止' : '运行' }}</dd>
              </div>
              <div>
                <dt>最近观察</dt>
                <dd class="text-sm">{{ dateTime(service.data.value.lastObservedAt) }}</dd>
              </div>
            </dl>
            <RouterLink :to="location('usage')" class="text-link service-inline-link"
              >查看实例与用量<ArrowRight class="size-4"
            /></RouterLink>
          </section>
          <div
            v-if="
              service.data.value.hasUnpublishedChanges ||
              ['partial', 'drifted', 'unknown'].includes(service.data.value.configurationState)
            "
            class="notice notice-warning"
          >
            <Info />
            <div>
              <strong>{{
                service.data.value.configurationState === 'partial'
                  ? '配置只完成部分应用'
                  : service.data.value.configurationState === 'drifted'
                    ? '检测到配置漂移'
                    : service.data.value.configurationState === 'unknown'
                      ? '配置应用状态未知'
                      : '有配置等待部署'
              }}</strong>
              <p>
                当前保存的草稿为 r{{
                  service.data.value.configRevision
                }}，部署前可核对与已发布版本的差异。
              </p>
              <RouterLink :to="location('review')" class="text-link mt-2 inline-block"
                >审阅部署差异</RouterLink
              >
            </div>
          </div>
          <div v-if="service.data.value.lastErrorMessage" class="notice notice-danger">
            <AlertCircle />
            <div>
              <strong>{{ service.data.value.lastErrorMessage }}</strong>
              <p v-if="service.data.value.lastErrorCode" class="meta mono mt-2">
                {{ service.data.value.lastErrorCode }}
              </p>
            </div>
          </div>
          <ServicePendingCommits v-if="isGit" :service="service.data.value" />
          <section class="service-deployment-section">
            <div class="section-head"><h2>来源与部署</h2></div>
            <div class="service-detail-row">
              <span class="meta">{{ isGit ? 'Git 来源' : '容器镜像' }}</span>
              <div class="min-w-0">
                <p class="mono break-all">{{ serviceSourceLabel(service.data.value) }}</p>
              </div>
              <RouterLink
                :to="settingsLocation(isGit ? 'source' : 'configuration')"
                class="text-link"
                >修改</RouterLink
              >
            </div>
            <div class="service-detail-row">
              <span class="meta">保存的配置</span>
              <div>
                r{{ service.data.value.configRevision
                }}<span
                  v-if="service.data.value.hasUnpublishedChanges"
                  class="badge badge-warning ml-2"
                  >待部署</span
                >
                <p class="meta mt-1">
                  {{ configurationLabels[service.data.value.configurationState] }}
                </p>
              </div>
              <RouterLink :to="settingsLocation('configuration')" class="text-link"
                >编辑</RouterLink
              >
            </div>
            <div class="service-detail-row">
              <span class="meta">已完整应用</span>
              <div class="min-w-0">
                <template v-if="service.data.value.published"
                  >r{{ service.data.value.published.configRevision }}
                  <p class="meta mt-1">
                    {{ dateTime(service.data.value.published.appliedAt) }}
                  </p></template
                >
                <span v-else class="meta">部署成功后记录来源、配置和产物。</span>
              </div>
              <RouterLink
                v-if="service.data.value.published"
                :to="`/deployments/${service.data.value.published.deploymentId}`"
                class="text-link"
                >查看</RouterLink
              >
            </div>
            <details class="service-identity-details">
              <summary><ChevronDown class="size-4" />部署位置与服务身份</summary>
              <dl class="service-identity-grid">
                <div>
                  <dt>项目 / 环境</dt>
                  <dd>
                    {{ service.data.value.project.name }} /
                    {{ service.data.value.environment.name }}
                  </dd>
                </div>
                <div>
                  <dt>部署位置</dt>
                  <dd>
                    <RouterLink
                      :to="`/clusters/${service.data.value.clusterId}`"
                      class="text-link"
                      >{{ service.data.value.cluster.name }}</RouterLink
                    >
                  </dd>
                </div>
                <div>
                  <dt>服务标识</dt>
                  <dd class="mono">{{ service.data.value.slug }}</dd>
                </div>
                <div v-if="service.data.value.controller">
                  <dt>工作负载</dt>
                  <dd>{{ service.data.value.controller.kind }}</dd>
                </div>
                <div v-if="service.data.value.template">
                  <dt>模板版本</dt>
                  <dd>
                    {{ service.data.value.template.id }} {{ service.data.value.template.version }}
                  </dd>
                </div>
                <div v-if="service.data.value.databaseInstanceId">
                  <dt>数据库身份</dt>
                  <dd>
                    <RouterLink
                      :to="`/databases/${service.data.value.databaseInstanceId}`"
                      class="text-link"
                      >查看数据库</RouterLink
                    >
                  </dd>
                </div>
                <div
                  v-if="service.data.value.published?.source?.kind === 'github'"
                  class="service-identity-wide"
                >
                  <dt>已发布提交</dt>
                  <dd class="mono break-all">
                    {{ service.data.value.published.source.commitSha }}
                  </dd>
                </div>
                <div
                  v-if="isGit && service.data.value.published?.image"
                  class="service-identity-wide"
                >
                  <dt>已发布产物</dt>
                  <dd class="mono break-all">
                    {{ service.data.value.published.image.deployReference }}
                  </dd>
                </div>
                <div v-if="service.data.value.lastSuccessfulDeploymentId">
                  <dt>最近成功部署</dt>
                  <dd>
                    <RouterLink
                      :to="`/deployments/${service.data.value.lastSuccessfulDeploymentId}`"
                      class="text-link"
                      >查看记录</RouterLink
                    >
                  </dd>
                </div>
              </dl>
            </details>
          </section>
        </div>
        <div v-if="tab === 'usage'" data-service-usage>
          <div class="section-head">
            <div>
              <h2>当前资源与实例</h2>
              <p class="meta mt-1">查看即时 CPU、内存、实例状态与最近事件。</p>
            </div>
            <Button as-child variant="outline"
              ><RouterLink :to="location('logs')"><ScrollText />运行日志</RouterLink></Button
            >
          </div>
          <ServiceRuntimePanel :service="service.data.value" @logs="showLogs" />
        </div>
        <nav v-show="tab === 'settings'" class="service-settings-nav" aria-label="服务设置分组">
          <RouterLink
            :to="settingsLocation('configuration')"
            :aria-current="settingsSection === 'configuration' ? 'page' : undefined"
            >运行配置</RouterLink
          >
          <RouterLink
            v-if="isGit"
            :to="settingsLocation('source')"
            :aria-current="settingsSection === 'source' ? 'page' : undefined"
            >Git 来源与构建</RouterLink
          >
          <RouterLink
            :to="settingsLocation('danger')"
            :aria-current="settingsSection === 'danger' ? 'page' : undefined"
            >危险操作</RouterLink
          >
        </nav>
        <form
          v-if="editingMounted"
          v-show="editingVisible"
          ref="draftForm"
          class="service-draft-form"
          novalidate
          @submit.prevent="saveDraft"
        >
          <section v-show="tab === 'settings'" class="panel" data-workspace-section="settings">
            <div class="section-head">
              <div>
                <h2>运行配置</h2>
                <p class="meta mt-1">保存为配置草稿，部署后应用到实例。</p>
              </div>
            </div>
            <ServiceConfigurationEditor
              ref="editor"
              v-model="form"
              compact
              hide-variables
              :source-kind="service.data.value.source?.kind"
              :disabled="writesLocked"
              :protected-configuration="!!service.data.value.databaseInstanceId"
              :protection-reason="database.data.value?.protection.reason"
            />
          </section>
          <section v-show="tab === 'variables'" class="panel" data-workspace-section="variables">
            <div
              v-if="service.data.value.databaseInstanceId"
              class="notice mb-5"
              data-database-variable-protection
            >
              <Info />
              <p>
                {{
                  database.data.value?.protection.reason ||
                  '数据库初始化变量由固定模板管理，不能在这里修改。'
                }}
              </p>
            </div>
            <ServiceVariablesEditor
              v-model="form.variables"
              :disabled="writesLocked || !!service.data.value.databaseInstanceId"
            />
          </section>
          <ServiceMutationError class="mt-5" :error="localError || save.error.value" />
          <div class="service-draft-footer">
            <div>
              <strong>{{ guard.dirty.value ? '有未保存的修改' : '草稿已保存' }}</strong>
              <p class="meta mt-1">
                配置 r{{ service.data.value.configRevision }} · 保存后仍需部署
              </p>
            </div>
            <div class="actions">
              <Button
                type="button"
                variant="outline"
                :disabled="save.isPending.value"
                @click="reloadDraft"
                >载入最新草稿</Button
              >
              <Button type="submit" :disabled="writesLocked || !guard.dirty.value"
                ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
                  save.isPending.value ? '正在保存…' : '保存草稿'
                }}</Button
              >
            </div>
          </div>
        </form>
        <div
          v-if="visitedTabs.has('settings') && isGit"
          v-show="tab === 'settings' && settingsSection === 'source'"
          data-service-source-settings
        >
          <ServiceGitSource :service="service.data.value" />
        </div>
        <div
          v-if="visitedTabs.has('settings')"
          v-show="tab === 'settings' && settingsSection === 'danger'"
        >
          <ServiceDeletionReview
            :service="service.data.value"
            :disabled="writesLocked"
            :pending="operation.isPending.value"
            :error="operation.error.value"
            @confirm="deleteReviewed"
          />
        </div>
        <div v-if="visitedTabs.has('network')" v-show="tab === 'network'">
          <ServiceNetworkPanel :service-id="serviceId" />
        </div>
        <div v-if="visitedTabs.has('storage')" v-show="tab === 'storage'">
          <ServiceStoragePanel :service="service.data.value" />
        </div>
        <ServiceWorkspacePanel
          :open="!!panel"
          :title="panel ? panelTitles[panel] : ''"
          :description="`${service.data.value.project.name} / ${service.data.value.name}`"
          :busy="reviewBusy"
          @update:open="closePanel"
        >
          <template v-if="panel === 'review'">
            <div v-if="guard.dirty.value" class="notice notice-warning mb-5">
              <Info />
              <div>
                <strong>本页还有未保存的配置</strong>
                <p>
                  本次复核只包含已保存的草稿 r{{
                    service.data.value.configRevision
                  }}。尚未保存的修改仍保留在编辑器中。
                </p>
                <RouterLink
                  :to="settingsLocation('configuration')"
                  class="text-link mt-2 inline-block"
                  >返回编辑并保存</RouterLink
                >
              </div>
            </div>
            <ConfigurationReview
              :service="service.data.value"
              :pending-target-id="
                typeof route.query.target === 'string' ? route.query.target : undefined
              "
              @submitted="deployed"
              @busy-change="reviewBusy = $event"
            />
          </template>
          <DeploymentCollection v-else-if="panel === 'deployments'" :service-id="serviceId" />
          <template v-else-if="panel === 'logs'">
            <p v-if="isGit" class="meta mb-4">
              这里显示所选实例的容器运行输出。
              <RouterLink
                v-if="service.data.value.activeTask?.type === 'deployment'"
                :to="`/deployments/${service.data.value.activeTask.id}`"
                class="text-link"
                >查看当前部署的构建、推送与阶段日志</RouterLink
              >
              <RouterLink
                v-else-if="service.data.value.published"
                :to="`/deployments/${service.data.value.published.deploymentId}`"
                class="text-link"
                >查看已发布版本的构建、推送与阶段日志</RouterLink
              >
            </p>
            <ServiceLogViewer :service="service.data.value" />
          </template>
        </ServiceWorkspacePanel>
      </div>
    </template>
  </QueryState>
</template>
<style scoped>
.service-workspace {
  min-width: 0;
}
.service-workspace-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.75rem;
}
.service-heading {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  min-width: 0;
}
.service-heading h1 {
  font-size: clamp(1.5rem, 2.5vw, 1.875rem);
  overflow-wrap: anywhere;
  line-height: 1.25;
}
.service-mark {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  color: var(--primary);
  background: var(--card);
}
.service-mark svg {
  width: 1.3rem;
  height: 1.3rem;
}
.service-heading-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  margin-top: 0.625rem;
}
.service-source-link {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 32rem;
}
.service-source-link:hover {
  color: var(--primary);
}
.service-heading-target {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}
.service-primary-actions {
  display: flex;
  flex-shrink: 0;
  gap: 0.5rem;
}
.service-tabs {
  gap: clamp(1.1rem, 2.4vw, 2rem);
}
.service-dirty-dot {
  display: inline-block;
  width: 0.375rem;
  height: 0.375rem;
  margin: 0 0 0.15rem 0.35rem;
  border-radius: 100%;
  background: var(--primary);
}
.workspace-draft-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 0.8125rem;
}
.service-status-section {
  padding: 0.5rem 0 1.5rem;
  border-bottom: 1px solid var(--border);
}
.service-status-copy {
  max-width: 54ch;
}
.service-status-facts {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr minmax(10rem, 1.3fr);
  gap: 1.25rem;
  margin: 1.75rem 0 0;
}
.service-status-facts dt,
.service-identity-grid dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.service-status-facts dd {
  margin: 0.5rem 0 0;
  font-size: 0.9375rem;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.service-inline-link {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 1.5rem;
  font-size: 0.8125rem;
}
.service-deployment-section > .section-head {
  margin-bottom: 0.5rem;
}
.service-detail-row {
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr) auto;
  align-items: start;
  gap: 1rem;
  padding: 1.125rem 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.875rem;
}
.service-identity-details {
  padding: 1.25rem 0 0.5rem;
}
.service-identity-details summary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--muted-foreground);
  cursor: pointer;
  font-size: 0.8125rem;
  list-style: none;
}
.service-identity-details summary::-webkit-details-marker {
  display: none;
}
.service-identity-details[open] > summary svg {
  transform: rotate(180deg);
}
.service-identity-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem 2rem;
  padding: 1.5rem 0 0;
}
.service-identity-grid dd {
  margin-top: 0.375rem;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.service-identity-wide {
  grid-column: 1 / -1;
}
.service-settings-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 1.5rem;
}
.service-settings-nav a {
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--muted-foreground);
}
.service-settings-nav a:hover,
.service-settings-nav a[aria-current='page'] {
  background: var(--secondary);
  color: var(--foreground);
}
.service-draft-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 1.25rem;
  padding: 1rem 0;
}
.service-draft-footer strong {
  font-size: 0.875rem;
  font-weight: 550;
}
.service-action-menu {
  z-index: 250;
  min-width: 13rem;
  max-width: calc(100vw - 2rem);
  padding: 0.375rem;
  border: 1px solid var(--border);
  border-radius: 0.625rem;
  background: var(--card);
  color: var(--foreground);
  box-shadow: var(--shadow);
}
.service-action-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border-radius: 0.375rem;
  padding: 0.625rem 0.75rem;
  font-size: 0.875rem;
  outline: none;
  cursor: pointer;
}
.service-action-item svg {
  width: 1rem;
  height: 1rem;
}
.service-action-item[data-highlighted] {
  background: var(--secondary);
}
.service-action-item[data-disabled] {
  opacity: 0.45;
  cursor: default;
}
.service-action-danger {
  color: var(--destructive);
}
.service-action-separator {
  height: 1px;
  background: var(--border);
  margin: 0.375rem;
}
@media (max-width: 900px) {
  .service-status-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .service-source-link {
    max-width: 100%;
  }
  .service-status-section > .section-head {
    align-items: flex-start;
  }
}
@media (max-width: 639px) {
  .service-workspace-head {
    flex-wrap: wrap;
    gap: 1rem;
  }
  .service-primary-actions {
    margin-left: auto;
  }
  .service-detail-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem 1rem;
  }
  .service-detail-row > :first-child {
    grid-column: 1 / -1;
  }
  .service-identity-grid {
    grid-template-columns: 1fr;
  }
  .service-draft-footer > div,
  .service-draft-footer > .actions {
    width: 100%;
  }
  .service-draft-footer > .actions > button {
    flex: 1;
  }
}
</style>
