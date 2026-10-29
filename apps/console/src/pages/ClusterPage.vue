<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, Info, Trash2, LoaderCircle, Layers3, FolderKanban } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import ClusterConnection from '@/components/infrastructure/ClusterConnection.vue';
import { api } from '@/lib/api';
import { queryClient, useCollection, invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { dateTime, idempotencyKey, slugify } from '@/lib/utils';
import type { Cluster, Project, SecretReference } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const clusterId = String(route.params.clusterId ?? '');
const editing = !!clusterId;
const cluster = useQuery({
  queryKey: ['cluster', clusterId],
  enabled: editing,
  queryFn: ({ signal }) => api.get<Cluster>(`/clusters/${clusterId}`, signal),
});
const projects = useCollection<Project>('/projects', { clusterId }, editing);
const secrets = useCollection<SecretReference>('/secrets', { kind: 'kubeconfig' });
const form = reactive({
  name: '',
  slug: '',
  description: '',
  region: '',
  apiEndpoint: '',
  credentialRefId: '',
  revision: 1,
});
const guard = useDirtyForm(form, '集群登记');
const reloading = ref(false);
const operationBusy = ref(false);
const connectionEditing = ref(false);
async function refreshCluster() {
  await Promise.all([
    cluster.refetch(),
    invalidateCollection('/clusters'),
    invalidateCollection('/projects'),
  ]);
}
const slugEdited = ref(editing);
watch(
  () => form.name,
  (name) => {
    if (!slugEdited.value) form.slug = slugify(name);
  },
);
function fill(value: Cluster) {
  Object.assign(form, {
    name: value.name,
    slug: value.slug,
    description: value.description ?? '',
    region: value.region ?? '',
    apiEndpoint: value.apiEndpoint ?? '',
    credentialRefId: value.credentialRefId ?? '',
    revision: value.revision,
  });
  guard.markClean();
}
watch(
  cluster.data,
  (value) => {
    if (value && !guard.dirty.value) fill(value);
  },
  { immediate: true },
);
const bound = computed(() => (cluster.data.value?.projectCount ?? 0) > 0);
const connectionLocked = computed(
  () => bound.value || (editing && cluster.data.value?.connectionStatus !== 'unverified'),
);
const key = idempotencyKey();
const save = useMutation({
  mutationFn: () => {
    const common = {
      name: form.name,
      description: form.description || null,
      region: form.region || null,
    };
    const connection = {
      apiEndpoint: form.apiEndpoint || null,
      credentialRefId: form.credentialRefId || null,
    };
    return editing
      ? api.update<Cluster>(`/clusters/${clusterId}`, {
          ...common,
          ...(connectionLocked.value ? {} : connection),
          revision: form.revision,
        })
      : api.create<Cluster>('/clusters', { ...common, ...connection, slug: form.slug }, key);
  },
  onSuccess: async (result) => {
    fill(result);
    queryClient.setQueryData(['cluster', result.id], result);
    await Promise.all([invalidateCollection('/clusters'), invalidateCollection('/projects')]);
    if (!isViewActive()) return;
    ui.toast('集群登记已保存，连接状态以验证结果为准。');
    if (!editing)
      await router.replace(
        route.query.returnTo === '/projects/new'
          ? { path: '/projects/new', query: { clusterId: result.id } }
          : `/clusters/${result.id}`,
      );
  },
});
const remove = useMutation({
  mutationFn: (revision: number) => api.delete(`/clusters/${clusterId}`, revision),
  onSuccess: async () => {
    guard.abandon();
    queryClient.removeQueries({ queryKey: ['cluster', clusterId] });
    await invalidateCollection('/clusters');
    if (!isViewActive()) return;
    await router.push('/infrastructure');
    ui.toast('集群登记已移除。');
  },
});
async function deleteCluster() {
  const reviewedRevision = cluster.data.value?.revision;
  if (!reviewedRevision) return;
  if (
    await ui.confirm({
      title: `移除集群「${cluster.data.value?.name}」？`,
      description:
        '移除控制台中的集群登记不会停止应用或卸载集群。仍被项目、资源或在途任务引用时，会拒绝移除。',
      confirmText: '移除登记',
      destructive: true,
    })
  )
    if (isViewActive()) remove.mutate(reviewedRevision);
}
async function reload() {
  if (save.isPending.value || reloading.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新集群资料？',
      description: '当前未保存的编辑将被最新资料替换。',
      confirmText: '载入最新资料',
    }))
  )
    return;
  if (!isViewActive()) return;
  reloading.value = true;
  try {
    const result = await cluster.refetch();
    if (result.data && isViewActive()) {
      fill(result.data);
      save.reset();
    }
  } finally {
    reloading.value = false;
  }
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/infrastructure" class="text-link">基础设施</RouterLink><ChevronRight /><span>{{
      editing ? '集群登记' : '登记集群'
    }}</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>{{ editing ? (cluster.data.value?.name ?? '集群登记') : '登记集群' }}</h1>
      <p>保存承载目标的资料，连接验证与项目归属各自清晰。</p>
    </div>
    <StatusBadge
      v-if="editing && cluster.data.value"
      :status="cluster.data.value.connectionStatus"
      :observed-at="cluster.data.value.lastObservedAt"
    />
  </div>
  <QueryState
    :pending="editing && cluster.isPending.value"
    :error="cluster.error.value"
    @retry="cluster.refetch()"
  >
    <ClusterConnection
      v-if="editing && cluster.data.value"
      class="mb-6"
      :cluster="cluster.data.value"
      :disabled="save.isPending.value || reloading || remove.isPending.value"
      :metadata-dirty="guard.dirty.value"
      @changed="refreshCluster"
      @busy="operationBusy = $event"
      @editing="connectionEditing = $event"
    />
    <div v-if="!editing || cluster.data.value" class="split">
      <div class="stack">
        <form class="panel" @submit.prevent="save.mutate()">
          <div class="section-head">
            <h2>登记资料</h2>
            <span v-if="guard.dirty.value" class="badge">尚未保存</span>
          </div>
          <fieldset
            class="stack"
            :disabled="
              save.isPending.value ||
              reloading ||
              auth.restoreMode ||
              operationBusy ||
              connectionEditing
            "
          >
            <div class="form-grid">
              <div class="field">
                <label for="cluster-name">集群名称</label
                ><Input
                  id="cluster-name"
                  v-model="form.name"
                  required
                  maxlength="120"
                  placeholder="例如：新加坡集群"
                />
              </div>
              <div class="field">
                <label for="cluster-slug">集群标识</label
                ><Input
                  id="cluster-slug"
                  v-model="form.slug"
                  :readonly="editing"
                  required
                  maxlength="63"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="sg-prod"
                  @input="slugEdited = true"
                />
                <p class="field-hint">标识保存后保持固定。</p>
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="cluster-region">地区 <span class="meta">（选填）</span></label
                ><Input
                  id="cluster-region"
                  v-model="form.region"
                  maxlength="80"
                  placeholder="例如：新加坡"
                />
              </div>
              <div class="field">
                <label for="cluster-endpoint"
                  >Kubernetes API 地址 <span class="meta">（选填）</span></label
                ><Input
                  id="cluster-endpoint"
                  v-model="form.apiEndpoint"
                  type="url"
                  pattern="https://.*"
                  :readonly="connectionLocked"
                  maxlength="2048"
                  placeholder="https://cluster.example.com:6443"
                />
                <p class="field-hint">填写可由控制面访问的 HTTPS 地址。</p>
              </div>
            </div>
            <div class="field">
              <label for="cluster-credential">连接凭证 <span class="meta">（选填）</span></label
              ><select
                id="cluster-credential"
                v-model="form.credentialRefId"
                class="input"
                :disabled="connectionLocked || secrets.isPending.value"
              >
                <option value="">稍后添加，先保存未验证登记</option>
                <option
                  v-if="
                    form.credentialRefId &&
                    !secrets.items.value.some((item) => item.id === form.credentialRefId)
                  "
                  :value="form.credentialRefId"
                >
                  当前引用 · {{ form.credentialRefId }}
                </option>
                <option v-for="secret in secrets.items.value" :key="secret.id" :value="secret.id">
                  {{ secret.name }}
                </option>
              </select>
              <p class="field-hint">
                仅显示 kubeconfig 类型引用。<RouterLink to="/settings" class="text-link"
                  >管理凭证</RouterLink
                >
              </p>
              <p v-if="secrets.error.value" class="field-error">
                凭证列表暂不可用，请到设置重新载入。
              </p>
              <Button
                v-if="secrets.hasNextPage.value"
                type="button"
                variant="ghost"
                size="sm"
                @click="secrets.fetchNextPage()"
                >载入更多凭证</Button
              >
            </div>
            <div v-if="connectionLocked" class="notice">
              <Info />
              <p>
                {{
                  bound
                    ? `此集群已被 ${cluster.data.value?.projectCount} 个项目引用。`
                    : '此集群已有连接观察记录。'
                }}
                当前可修改显示资料。更换 API 地址或凭证时，需要重新验证同一集群身份。
              </p>
            </div>
            <div class="field">
              <label for="cluster-description">描述 <span class="meta">（选填）</span></label
              ><Textarea
                id="cluster-description"
                v-model="form.description"
                rows="3"
                maxlength="1000"
              />
            </div>
          </fieldset>
          <MutationError class="mt-4" :error="save.error.value" />
          <div class="form-footer">
            <Button
              v-if="editing"
              type="button"
              variant="outline"
              :disabled="save.isPending.value || reloading"
              @click="reload"
              >载入最新资料</Button
            ><Button v-else as-child variant="outline"
              ><RouterLink to="/infrastructure">取消</RouterLink></Button
            ><Button
              type="submit"
              :disabled="
                save.isPending.value ||
                reloading ||
                auth.restoreMode ||
                operationBusy ||
                connectionEditing ||
                (editing && !guard.dirty.value)
              "
              ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
                save.isPending.value
                  ? '正在保存…'
                  : route.query.returnTo === '/projects/new'
                    ? '保存并返回创建项目'
                    : '保存登记'
              }}</Button
            >
          </div>
        </form>
        <section v-if="editing" class="panel">
          <div class="section-head">
            <h2 class="flex items-center gap-2"><FolderKanban class="size-4" />关联项目</h2>
            <span class="badge">{{ cluster.data.value?.projectCount ?? 0 }}</span>
          </div>
          <QueryState
            :pending="projects.isPending.value"
            :error="projects.error.value"
            @retry="projects.refetch()"
            ><div v-if="projects.items.value.length" class="divide-y divide-border">
              <RouterLink
                v-for="project in projects.items.value"
                :key="project.id"
                :to="`/projects/${project.id}`"
                class="flex items-center justify-between py-3"
                ><span
                  >{{ project.name }} <span class="meta ml-2">{{ project.slug }}</span></span
                ><ChevronRight class="size-4"
              /></RouterLink>
            </div>
            <p v-else-if="!projects.error.value" class="muted">尚无项目绑定此集群。</p>
            <Button
              v-if="projects.hasNextPage.value"
              variant="outline"
              class="mt-4"
              @click="projects.fetchNextPage()"
              >载入更多项目</Button
            ></QueryState
          >
        </section>
        <section v-if="editing" class="panel">
          <h2>移除登记</h2>
          <p class="muted mt-2 mb-5">任何项目引用都会阻止移除，包括尚无服务的空项目。</p>
          <MutationError class="mb-4" :error="remove.error.value" /><Button
            variant="destructive"
            :disabled="
              bound ||
              remove.isPending.value ||
              auth.restoreMode ||
              operationBusy ||
              connectionEditing
            "
            @click="deleteCluster"
            ><Trash2 />移除集群登记</Button
          >
        </section>
      </div>
      <aside class="stack">
        <section class="panel">
          <h2 class="mb-4 flex items-center gap-2"><Layers3 class="size-5" />连接与能力</h2>
          <StatusBadge
            :status="cluster.data.value?.connectionStatus"
            :observed-at="cluster.data.value?.lastObservedAt"
          />
          <dl class="detail-list mt-3">
            <div>
              <dt>最近观察</dt>
              <dd>{{ dateTime(cluster.data.value?.lastObservedAt) }}</dd>
            </div>
            <div>
              <dt>API 与权限</dt>
              <dd>
                {{
                  cluster.data.value?.observation
                    ? '已有验证记录，见能力与权限明细'
                    : '尚无验证结果'
                }}
              </dd>
            </div>
            <div>
              <dt>节点与资源</dt>
              <dd>
                {{
                  cluster.data.value?.observation
                    ? `${cluster.data.value.nodeCount} 个节点记录`
                    : '尚无采集结果'
                }}
              </dd>
            </div>
          </dl>
        </section>
        <p class="meta px-1">
          已登记的目标可用于保存项目资料。连接和所需运行能力确认后，才能承载实际发布。
        </p>
      </aside>
    </div>
  </QueryState>
</template>
