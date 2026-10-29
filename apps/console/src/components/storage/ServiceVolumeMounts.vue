<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { Plus, LoaderCircle, Unplug, Search, RefreshCw, HardDrive } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import type { Service } from '@/components/services/types';
import { serviceLocation } from '@/components/services/presentation';
import { api } from '@/lib/api';
import { queryClient, useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { volumeMounts, saveVolumeMount, detachVolumeMount, invalidateStorage } from './queries';
import type { Volume, SaveVolumeMountInput, Database } from './types';
import { formatStorageBytes } from './format';
import StorageMutationError from './StorageMutationError.vue';
const props = defineProps<{
  service: Service;
  database?: Database | null;
  databasePending?: boolean;
}>();
const route = useRoute();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const prefix = useId();
const mounts = useQuery({
  queryKey: computed(() => ['service-volume-mounts', props.service.id]),
  queryFn: ({ signal }) => volumeMounts(props.service.id, signal),
  refetchInterval: 15_000,
});
const form = ref({
  volumeId: typeof route.query.volumeId === 'string' ? route.query.volumeId : '',
  mountPath: '/data',
  readOnly: false,
});
const guard = useDirtyForm(form, '卷挂载草稿');
const baseRevision = ref(0);
const selectedRevision = ref(0);
const localError = ref<Error | null>(null);
const search = ref('');
const params = computed<Record<string, string>>(() => ({
  projectId: props.service.projectId,
  environmentId: props.service.environmentId,
  clusterId: props.service.clusterId,
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const volumes = useCollection<Volume>(
  '/volumes',
  params,
  computed(() => !props.database && !props.databasePending),
);
const selected = useQuery({
  queryKey: computed(() => ['volume', form.value.volumeId]),
  enabled: computed(() => !!form.value.volumeId),
  queryFn: ({ queryKey, signal }) => api.get<Volume>(`/volumes/${queryKey[1]}`, signal),
});
const available = computed(() =>
  volumes.items.value.filter(
    (volume) => volume.desiredState === 'active' && !volume.retainedDatabase,
  ),
);
const targetMatches = computed(
  () =>
    !!selected.data.value &&
    selected.data.value.environment?.id === props.service.environmentId &&
    selected.data.value.project?.id === props.service.projectId &&
    selected.data.value.cluster?.id === props.service.clusterId &&
    !selected.data.value.retainedDatabase &&
    selected.data.value.desiredState === 'active',
);
const mountBlocker = computed(() => {
  const volume = selected.data.value;
  if (volume?.activeTask) return '所选卷有未完成的存储任务，任务结束后再保存挂载。';
  if (volume?.maintenance && volume.maintenance.state !== 'closed')
    return '所选卷仍处于持久维护锁定状态。任务结束或超时不会释放锁，请核验并退出维护。';
  if (!form.value.readOnly && props.service.configuration.replicas !== 1)
    return '可写本地卷要求单副本，请先将应用配置草稿的副本数设为 1。';
  return null;
});
watch(
  mounts.data,
  (value) => {
    if (value && (!baseRevision.value || !guard.dirty.value))
      baseRevision.value = value.serviceRevision;
  },
  { immediate: true },
);
watch(
  () => form.value.volumeId,
  () => {
    selectedRevision.value = 0;
  },
);
watch(
  selected.data,
  (value) => {
    if (
      value &&
      value.id === form.value.volumeId &&
      (!selectedRevision.value || !guard.dirty.value)
    )
      selectedRevision.value = value.revision;
  },
  { immediate: true },
);
const stale = computed(
  () =>
    (!!mounts.data.value && baseRevision.value !== mounts.data.value.serviceRevision) ||
    (!!selected.data.value &&
      !!selectedRevision.value &&
      selectedRevision.value !== selected.data.value.revision),
);
const save = useMutation({
  mutationFn: (input: SaveVolumeMountInput) => saveVolumeMount(props.service.id, input),
  onSuccess: async (collection) => {
    queryClient.setQueryData(['service-volume-mounts', props.service.id], collection);
    await invalidateStorage(props.service.id, form.value.volumeId);
    if (!active()) return;
    form.value = { volumeId: '', mountPath: '/data', readOnly: false };
    guard.markClean();
    baseRevision.value = collection.serviceRevision;
    ui.toast('挂载草稿已保存，发布后才会更新实际挂载。');
  },
});
const detach = useMutation({
  mutationFn: (input: { mountId: string; revision: number }) =>
    detachVolumeMount(props.service.id, input.mountId, input.revision),
  onSuccess: async (collection) => {
    queryClient.setQueryData(['service-volume-mounts', props.service.id], collection);
    await invalidateStorage(props.service.id);
    if (active()) ui.toast('草稿引用已解除，发布并核对 Pod 后才能确认实际卸载。');
  },
});
const locked = computed(
  () =>
    auth.restoreMode ||
    !!props.service.activeTask ||
    save.isPending.value ||
    detach.isPending.value,
);
async function recheck() {
  const chosenId = form.value.volumeId;
  const results = await Promise.all([mounts.refetch(), selected.refetch()]);
  if (!active() || chosenId !== form.value.volumeId) return;
  if (results[0].isSuccess && results[1].isSuccess) {
    baseRevision.value = results[0].data.serviceRevision;
    selectedRevision.value = results[1].data.revision;
    localError.value = null;
  }
}
function submit() {
  if (
    locked.value ||
    props.database ||
    props.databasePending ||
    !targetMatches.value ||
    !!mountBlocker.value ||
    !selectedRevision.value ||
    !baseRevision.value ||
    stale.value
  )
    return;
  localError.value = null;
  if (!form.value.mountPath.startsWith('/') || form.value.mountPath === '/') {
    localError.value = new Error('挂载路径需要是明确的数据目录，不能使用根目录。');
    return;
  }
  save.mutate({
    revision: baseRevision.value,
    volumeRevision: selectedRevision.value,
    volumeId: form.value.volumeId,
    mountPath: form.value.mountPath,
    readOnly: form.value.readOnly,
  });
}
</script>
<template>
  <section class="panel" data-service-volume-mounts>
    <div class="section-head">
      <div>
        <h2>卷挂载草稿</h2>
        <p class="meta mt-2">最多 8 个挂载；保存后仍需发布服务</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="刷新挂载记录"
        :disabled="mounts.isFetching.value"
        @click="mounts.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <QueryState
      :pending="mounts.isPending.value"
      :error="mounts.error.value"
      @retry="mounts.refetch()"
      ><ul v-if="mounts.data.value?.data.length" class="mount-list">
        <li v-for="mount in mounts.data.value.data" :key="mount.id">
          <div class="min-w-0">
            <RouterLink :to="`/volumes/${mount.volumeId}`" class="text-link font-medium">{{
              mount.volume.name
            }}</RouterLink>
            <p class="mono text-sm mt-2">
              {{ mount.mountPath }} · {{ mount.readOnly ? '只读' : '可写' }}
            </p>
            <div class="flex gap-2 flex-wrap mt-2">
              <span :class="['badge', mount.desired ? 'badge-primary' : '']">{{
                mount.desired ? '草稿引用' : '草稿已解除'
              }}</span
              ><RouterLink
                v-if="mount.lastPublishedDeploymentId"
                :to="`/deployments/${mount.lastPublishedDeploymentId}`"
                class="badge text-link"
                >{{ mount.detachedAt ? '历史发布引用' : '已发布引用' }}</RouterLink
              >
            </div>
            <p v-if="!mount.desired && !mount.detachedAt" class="field-hint mt-2">
              实际卸载尚未确认，请查看卷的 Pod 观察。
            </p>
          </div>
          <Button
            v-if="mount.desired"
            type="button"
            variant="outline"
            size="sm"
            :disabled="locked || database?.dataVolume.id === mount.volumeId"
            @click="
              detach.mutate({ mountId: mount.id, revision: mounts.data.value!.serviceRevision })
            "
            ><Unplug />解除草稿引用</Button
          >
        </li>
      </ul>
      <p v-else class="meta">此服务还没有卷挂载草稿。</p></QueryState
    >
    <StorageMutationError :error="detach.error.value" class="mt-5" />
    <p v-if="database" class="notice mt-5">
      数据库数据卷由原数据库身份和受保护布局管理。通用挂载表单不能替换或解除它。
    </p>
    <form v-else-if="!databasePending" class="mount-form mt-6" @submit.prevent="submit">
      <div class="section-head">
        <h3>选择现有卷</h3>
        <Button as-child variant="outline" size="sm"
          ><RouterLink
            :to="{
              path: '/volumes/new',
              query: {
                projectId: service.projectId,
                environmentId: service.environmentId,
                serviceId: service.id,
              },
            }"
            ><Plus />先创建新卷</RouterLink
          ></Button
        >
      </div>
      <fieldset :disabled="locked">
        <legend class="sr-only">新挂载</legend>
        <div class="field">
          <label :for="`${prefix}-search`">查找当前环境的卷</label>
          <div class="relative">
            <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
              :id="`${prefix}-search`"
              v-model="search"
              class="pl-10"
              placeholder="搜索卷名称"
            />
          </div>
        </div>
        <div class="field mt-4">
          <label :for="`${prefix}-volume`">数据卷</label
          ><select :id="`${prefix}-volume`" v-model="form.volumeId" class="input" required>
            <option value="" disabled>选择当前项目环境的卷</option>
            <option
              v-if="
                selected.data.value &&
                !available.some((item) => item.id === selected.data.value!.id)
              "
              :value="selected.data.value.id"
            >
              {{ selected.data.value.name }}
            </option>
            <option v-for="volume in available" :key="volume.id" :value="volume.id">
              {{ volume.name }} · {{ formatStorageBytes(volume.requestedBytes) }} ·
              {{ volume.pvc.phase }}
            </option></select
          ><Button
            v-if="volumes.hasNextPage.value"
            type="button"
            variant="ghost"
            class="self-start"
            :disabled="volumes.isFetchingNextPage.value"
            @click="volumes.fetchNextPage()"
            >载入更多卷</Button
          >
        </div>
        <QueryState
          class="mt-4"
          :pending="volumes.isPending.value || (!!form.volumeId && selected.isPending.value)"
          :error="volumes.error.value || selected.error.value"
          @retry="
            volumes.refetch();
            if (form.volumeId) selected.refetch();
          "
          ><p v-if="selected.data.value" class="field-hint">
            {{ selected.data.value.storageClassName }} ·
            {{
              selected.data.value.locality === 'waiting_for_consumer'
                ? '等待首次消费者，可先保存挂载草稿'
                : selected.data.value.observation.message
            }}
          </p></QueryState
        >
        <p v-if="selected.data.value && !targetMatches" class="field-error mt-3">
          所选卷不属于当前项目环境，或属于受保护的数据库数据，不能在这里挂载。
        </p>
        <p v-if="selected.data.value && mountBlocker" class="field-error mt-3">
          {{ mountBlocker }}
          <RouterLink
            :to="{
              path: `/volumes/${selected.data.value.id}`,
              query: { tab: selected.data.value.maintenance ? 'manual' : undefined },
            }"
            class="text-link"
            >查看卷与维护状态</RouterLink
          >
        </p>
        <div class="field mt-5">
          <label :for="`${prefix}-path`">容器挂载路径</label
          ><Input
            :id="`${prefix}-path`"
            v-model="form.mountPath"
            required
            maxlength="300"
            placeholder="/data"
          />
        </div>
        <label class="mount-readonly mt-4"
          ><input v-model="form.readOnly" type="checkbox" />只读挂载</label
        >
      </fieldset>
      <p class="field-hint mt-4">
        应用挂载可写本地卷时，发布要求单副本与
        Recreate，更新期间会中断服务。停止服务仍保留已发布引用。
      </p>
      <div v-if="stale" class="notice notice-warning mt-5">
        <div>
          <strong>服务或卷版本已变化</strong>
          <p class="mt-1">填写内容已保留，请核对最新版本后再保存。</p>
          <Button
            type="button"
            variant="outline"
            class="mt-3"
            :disabled="mounts.isFetching.value || selected.isFetching.value"
            @click="recheck"
            >重新核对版本</Button
          >
        </div>
      </div>
      <StorageMutationError :error="localError || save.error.value" class="mt-5" />
      <div class="form-footer">
        <RouterLink :to="serviceLocation(service, 'review')" class="text-link"
          >审阅已保存的配置</RouterLink
        ><Button
          type="submit"
          :disabled="
            locked ||
            !targetMatches ||
            !!mountBlocker ||
            !selectedRevision ||
            !baseRevision ||
            stale
          "
          ><LoaderCircle v-if="save.isPending.value" class="animate-spin" /><HardDrive
            v-else
          />保存挂载草稿</Button
        >
      </div>
    </form>
  </section>
</template>
<style scoped>
.mount-list {
  display: grid;
  gap: 1rem;
}
.mount-list li {
  display: flex;
  justify-content: space-between;
  align-items: start;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.mount-list p,
.mount-list a {
  overflow-wrap: anywhere;
}
.mount-form {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
}
.mount-form fieldset {
  min-width: 0;
  border: 0;
  padding: 0;
}
.mount-readonly {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 0.875rem;
}
.mount-readonly input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--primary);
}
</style>
