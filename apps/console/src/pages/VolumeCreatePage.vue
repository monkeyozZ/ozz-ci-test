<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, HardDrive, LoaderCircle, Info, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import StorageTargetPicker from '@/components/storage/StorageTargetPicker.vue';
import StorageMutationError from '@/components/storage/StorageMutationError.vue';
import StorageIssues from '@/components/storage/StorageIssues.vue';
import { createVolume, invalidateStorage } from '@/components/storage/queries';
import { gibToBytes } from '@/components/storage/format';
import type { ClusterStorage, CreateVolumeInput } from '@/components/storage/types';
import type { Project, Environment } from '@/lib/types';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { idempotencyKey, slugify, dateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from '@/composables/useViewScope';
import { useDirtyForm } from '@/composables/useDirtyForm';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const active = useViewScope();
const query = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const selection = ref({ projectId: query('projectId'), environmentId: query('environmentId') });
const context = ref<{ project: Project; environment: Environment } | null>(null);
const form = ref({ name: '', slug: '', requestedGiB: '1', storageClassName: '' });
const guard = useDirtyForm(form, '新建持久卷');
const localError = ref<Error | null>(null);
const clusterId = computed(() => context.value?.project.clusterId ?? '');
const storage = useQuery({
  queryKey: computed(() => ['cluster-storage', clusterId.value]),
  enabled: computed(() => !!clusterId.value),
  queryFn: ({ queryKey, signal }) =>
    api.get<ClusterStorage>(`/clusters/${queryKey[1]}/storage`, signal),
  refetchInterval: 30_000,
});
const selectedClass = computed(() =>
  storage.data.value?.storageClasses.find((item) => item.name === form.value.storageClassName),
);
const canCreate = computed(
  () =>
    !!context.value &&
    !!selectedClass.value?.supported &&
    !storage.data.value?.stale &&
    storage.data.value?.capabilities?.permissions === 'ready' &&
    storage.data.value?.capabilities?.provisioner.state === 'ready' &&
    !storage.data.value.capabilities.truncated,
);
let generatedSlug = '';
watch(
  () => form.value.name,
  (name) => {
    if (!form.value.slug || form.value.slug === generatedSlug) {
      generatedSlug = slugify(name);
      form.value.slug = generatedSlug;
    }
  },
);
watch(clusterId, () => {
  form.value.storageClassName = '';
});
watch(storage.data, (value) => {
  if (!form.value.storageClassName && value) {
    const supported = value.storageClasses.filter((item) => item.supported);
    const initial =
      supported.find((item) => item.default) ?? (supported.length === 1 ? supported[0] : null);
    if (initial) {
      form.value.storageClassName = initial.name;
      if (!form.value.name) guard.markClean();
    }
  }
});
const keys = new Map<string, string>();
const create = useMutation({
  mutationFn: (input: CreateVolumeInput) => {
    const token = JSON.stringify(input);
    if (!keys.has(token)) keys.set(token, idempotencyKey());
    return createVolume(input, keys.get(token)!);
  },
  onSuccess: async (result) => {
    queryClient.setQueryData(['operation', result.operation.id], result.operation);
    await invalidateStorage(undefined, result.volumeId);
    if (!active()) return;
    guard.markClean();
    await router.push({
      path: `/volumes/${result.volumeId}`,
      query: {
        operationId: result.operation.id,
        ...(query('serviceId') ? { serviceId: query('serviceId') } : {}),
      },
    });
  },
});
function submit() {
  if (!context.value || !canCreate.value || auth.restoreMode || create.isPending.value) return;
  localError.value = null;
  try {
    create.mutate({
      environmentId: context.value.environment.id,
      name: form.value.name.trim(),
      slug: form.value.slug,
      requestedBytes: gibToBytes(form.value.requestedGiB),
      storageClassName: form.value.storageClassName,
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查卷配置。');
  }
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/volumes" class="text-link">持久卷</RouterLink><ChevronRight /><span
      >创建卷</span
    >
  </nav>
  <div class="page-head">
    <div>
      <h1>创建持久卷</h1>
      <p>在项目环境中创建真实 PVC。创建受理后，再将卷加入服务的挂载草稿。</p>
    </div>
  </div>
  <form class="panel" @submit.prevent="submit">
    <StorageTargetPicker
      v-model="selection"
      :disabled="create.isPending.value"
      @context="context = $event"
    />
    <fieldset
      class="volume-create-fields mt-7"
      :disabled="create.isPending.value || auth.restoreMode"
    >
      <legend class="sr-only">卷配置</legend>
      <div class="field">
        <label for="volume-name">卷名称</label
        ><Input
          id="volume-name"
          v-model="form.name"
          required
          maxlength="120"
          placeholder="例如：应用上传文件"
        />
      </div>
      <div class="field">
        <label for="volume-slug">卷标识</label
        ><Input
          id="volume-slug"
          v-model="form.slug"
          required
          maxlength="63"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          placeholder="例如：app-uploads"
        />
      </div>
      <div class="field">
        <label for="volume-size">申请容量（GiB）</label
        ><Input
          id="volume-size"
          v-model="form.requestedGiB"
          type="number"
          min="1"
          step="1"
          required
        />
        <p class="field-hint">local-path 不提供写入硬配额。</p>
      </div>
      <div class="field">
        <label for="volume-storage-class">StorageClass</label
        ><select
          id="volume-storage-class"
          v-model="form.storageClassName"
          class="input"
          required
          :disabled="!storage.data.value"
        >
          <option value="" disabled>选择集群已核验的存储类</option>
          <option
            v-for="item in storage.data.value?.storageClasses ?? []"
            :key="item.uid"
            :value="item.name"
            :disabled="!item.supported"
          >
            {{ item.name }}{{ item.supported ? '' : ' · 当前不支持' }}
          </option>
        </select>
      </div>
    </fieldset>
    <QueryState
      v-if="clusterId"
      class="mt-6"
      :pending="storage.isPending.value"
      :error="storage.error.value"
      @retry="storage.refetch()"
      ><template v-if="storage.data.value"
        ><div class="section-head">
          <h2>目标集群存储检查</h2>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="刷新存储能力"
            :disabled="storage.isFetching.value"
            @click="storage.refetch()"
            ><RefreshCw
          /></Button>
        </div>
        <p class="meta mb-4">
          观察于 {{ dateTime(storage.data.value.observedAt)
          }}{{ storage.data.value.stale ? ' · 已过期，暂不能创建' : '' }}
        </p>
        <StorageIssues :issues="storage.data.value.capabilities?.issues ?? []" />
        <div v-if="selectedClass" class="notice mt-4">
          <Info />
          <div>
            <p>{{ selectedClass.message }}</p>
            <p class="meta mt-2">
              {{ selectedClass.bindingMode ?? '绑定模式未知' }} · 回收策略
              {{ selectedClass.reclaimPolicy ?? '未知' }}
            </p>
          </div>
        </div>
        <p v-if="!canCreate" class="field-hint mt-4">
          需要完整且有效的能力观察、可用 provisioner、权限及受支持的 StorageClass 后才能创建。
        </p></template
      ></QueryState
    >
    <div class="notice mt-6">
      <HardDrive />
      <p>
        WaitForFirstConsumer 会等待第一个消费者后再绑定 PV
        和节点。卷创建任务结束后，仍需保存挂载草稿并发布服务。
      </p>
    </div>
    <StorageMutationError :error="localError || create.error.value" class="mt-6" />
    <div class="form-footer">
      <Button as-child variant="outline"><RouterLink to="/volumes">返回卷列表</RouterLink></Button
      ><Button type="submit" :disabled="!canCreate || create.isPending.value || auth.restoreMode"
        ><LoaderCircle v-if="create.isPending.value" class="animate-spin" /><HardDrive v-else />{{
          create.isPending.value ? '正在提交…' : '创建卷并查看任务'
        }}</Button
      >
    </div>
  </form>
</template>
<style scoped>
.volume-create-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
  min-width: 0;
  padding: 0;
  border: 0;
}
@media (max-width: 650px) {
  .volume-create-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
