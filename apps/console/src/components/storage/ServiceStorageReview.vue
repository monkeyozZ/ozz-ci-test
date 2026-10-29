<script setup lang="ts">
import { computed, watch } from 'vue';
import { useQueries, useQuery } from '@tanstack/vue-query';
import { AlertCircle, Info, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import type { Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { volumeMounts, databaseBindings } from './queries';
import { databaseOutputLabel } from './publication';
import type { Database, Volume } from './types';

const props = defineProps<{ service: Service }>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const mounts = useQuery({
  queryKey: computed(() => ['service-volume-mounts', props.service.id]),
  queryFn: ({ signal }) => volumeMounts(props.service.id, signal),
  refetchOnMount: 'always',
});
const bindings = useQuery({
  queryKey: computed(() => ['service-database-bindings', props.service.id]),
  queryFn: ({ signal }) => databaseBindings(props.service.id, signal),
  refetchOnMount: 'always',
});
const desiredMounts = computed(() => mounts.data.value?.data.filter((item) => item.desired) ?? []);
const desiredBindings = computed(
  () => bindings.data.value?.data.filter((item) => item.desired) ?? [],
);
const volumeIds = computed(() => [...new Set(desiredMounts.value.map((item) => item.volumeId))]);
const databaseIds = computed(() => [
  ...new Set([
    ...desiredBindings.value.map((item) => item.databaseInstanceId),
    ...(props.service.databaseInstanceId ? [props.service.databaseInstanceId] : []),
  ]),
]);
const volumes = useQueries({
  queries: computed(() =>
    volumeIds.value.map((id) => ({
      queryKey: ['volume', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<Volume>(`/volumes/${id}`, signal),
      refetchOnMount: 'always' as const,
    })),
  ),
});
const databases = useQueries({
  queries: computed(() =>
    databaseIds.value.map((id) => ({
      queryKey: ['database', id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<Database>(`/databases/${id}`, signal),
      refetchOnMount: 'always' as const,
    })),
  ),
});
const matching = computed(() =>
  [mounts.data.value, bindings.data.value].every(
    (value) =>
      value &&
      value.serviceRevision === props.service.revision &&
      value.configRevision === props.service.configRevision,
  ),
);
const detailsPending = computed(() =>
  [...volumes.value, ...databases.value].some((query) => query.isPending),
);
const detailsError = computed(
  () => [...volumes.value, ...databases.value].find((query) => query.error)?.error,
);
function awaitsInitialDatabaseVolume(volume: Volume): boolean {
  const database = databases.value.find(
    (query) => query.data?.id === props.service.databaseInstanceId,
  )?.data;
  // The backend persists this database fence before its first PVC create request.
  // An empty UID alone cannot distinguish a new volume from a lost write receipt.
  return Boolean(
    database &&
    props.service.kind === 'database' &&
    !props.service.published &&
    props.service.configurationState === 'unpublished' &&
    props.service.template?.id === database.template.id &&
    props.service.template?.version === database.template.version &&
    database.service?.id === props.service.id &&
    database.dataVolume.id === volume.id &&
    database.dataVolume.pvcUid === null &&
    database.projectId === props.service.projectId &&
    database.environmentId === props.service.environmentId &&
    database.clusterId === props.service.clusterId &&
    database.protection.active === false &&
    database.protection.fencedAt === null &&
    database.initialization.state === 'not_started' &&
    database.initialization.initializedAt === null &&
    database.initialization.pvcUid === null &&
    volume.project?.id === props.service.projectId &&
    volume.environment?.id === props.service.environmentId &&
    volume.cluster?.id === props.service.clusterId &&
    volume.retainedDatabase?.id === database.id &&
    volume.retainedDatabase.serviceId === props.service.id &&
    volume.retainedDatabase.initializationFenceAt === null &&
    volume.retainedDatabase.initializedAt === null &&
    volume.pvc.uid === null &&
    volume.pv === null &&
    volume.observation.state === 'unknown' &&
    volume.observation.observedAt === null &&
    volume.observation.code === null &&
    volume.lastAttemptAt === null &&
    volume.lastErrorCode === null &&
    volume.mounts.actual.length === 0 &&
    volume.mounts.published.length === 0 &&
    !volume.mounts.truncated &&
    volume.mounts.desired.every((mount) => mount.serviceId === props.service.id),
  );
}
const blockers = computed(() => {
  const issues: string[] = [];
  for (const query of volumes.value) {
    const volume = query.data;
    if (!volume) continue;
    if (volume.desiredState !== 'active') issues.push(`${volume.name} 正在销毁或已销毁。`);
    if (volume.activeTask) issues.push(`${volume.name} 有未完成的存储任务。`);
    if (volume.maintenance && volume.maintenance.state !== 'closed')
      issues.push(`${volume.name} 仍处于数据维护锁定状态。`);
    if (
      !awaitsInitialDatabaseVolume(volume) &&
      (volume.observation.stale ||
        ['unknown', 'missing', 'drifted'].includes(volume.observation.state))
    )
      issues.push(`${volume.name} 的存储观察需要重新核对。`);
    if (
      volume.environment?.id !== props.service.environmentId ||
      volume.cluster?.id !== props.service.clusterId
    )
      issues.push(`${volume.name} 与发布目标不属于同一环境和集群。`);
  }
  for (const binding of desiredBindings.value) {
    issues.push(
      ...binding.issues
        .filter((issue) => ['deploy', 'both'].includes(issue.blocks))
        .map((issue) => issue.message),
    );
    const provider = databases.value.find(
      (query) => query.data?.id === binding.databaseInstanceId,
    )?.data;
    if (
      provider &&
      (!provider.service ||
        !provider.databaseReady ||
        provider.observationStale ||
        provider.observation?.authenticated !== true)
    )
      issues.push(`${binding.provider.name} 尚未通过当前数据库认证检查。`);
    if (
      provider &&
      (provider.environmentId !== props.service.environmentId ||
        provider.clusterId !== props.service.clusterId)
    )
      issues.push(`${binding.provider.name} 与发布目标不属于同一环境和集群。`);
  }
  return [...new Set(issues)];
});
const reading = computed(
  () =>
    mounts.isFetching.value ||
    bindings.isFetching.value ||
    [...volumes.value, ...databases.value].some((query) => query.isFetching),
);
const ready = computed(
  () =>
    matching.value &&
    !reading.value &&
    !mounts.error.value &&
    !bindings.error.value &&
    !detailsPending.value &&
    !detailsError.value &&
    !blockers.value.length &&
    (mounts.data.value?.data.length ?? 9) <= 8 &&
    (bindings.data.value?.data.length ?? 17) <= 16 &&
    desiredBindings.value.length <= 8,
);
watch(ready, (value) => emit('ready', value), { immediate: true });
async function refresh() {
  await Promise.all([
    mounts.refetch(),
    bindings.refetch(),
    ...volumes.value.map((query) => query.refetch()),
    ...databases.value.map((query) => query.refetch()),
  ]);
}
const volumeFor = (id: string) => volumes.value.find((query) => query.data?.id === id)?.data;
const databaseFor = (id: string) => databases.value.find((query) => query.data?.id === id)?.data;
</script>

<template>
  <div data-service-storage-review>
    <div class="section-head">
      <h3>控制器与数据引用</h3>
      <Button variant="outline" size="sm" :disabled="reading" @click="refresh"
        ><RefreshCw />重新核对引用</Button
      >
    </div>
    <dl class="storage-facts">
      <div>
        <dt>工作负载</dt>
        <dd>
          {{ service.controller?.kind ?? 'Deployment' }} ·
          {{ service.controller?.strategy ?? 'RollingUpdate' }}
        </dd>
      </div>
      <div>
        <dt>来源模板</dt>
        <dd>
          {{
            service.template ? `${service.template.id} · ${service.template.version}` : '自定义镜像'
          }}
        </dd>
      </div>
    </dl>
    <div v-if="service.controller?.strategy === 'Recreate'" class="notice notice-warning mt-4">
      <Info />
      <p>可写本地卷采用单副本 Recreate：先停止旧实例，再启动新实例，发布期间服务会中断。</p>
    </div>
    <div
      v-if="mounts.data.value && bindings.data.value && !matching"
      class="notice notice-warning mt-4"
    >
      <AlertCircle />
      <p>数据引用集合与这次服务预览版本不一致。请载入最新服务预览后重新核对。</p>
    </div>
    <h4 class="font-medium mt-6">挂载草稿</h4>
    <QueryState
      :pending="mounts.isPending.value"
      :error="mounts.error.value"
      @retry="mounts.refetch()"
    >
      <ul v-if="desiredMounts.length" class="draft-reference-list mt-3">
        <li v-for="mount in desiredMounts" :key="mount.id">
          <RouterLink :to="`/volumes/${mount.volumeId}`" class="text-link font-medium">{{
            mount.volume.name
          }}</RouterLink>
          <p class="mono mt-2 break-all">
            {{ mount.mountPath }} · {{ mount.readOnly ? '只读' : '可写' }} · 卷 r{{
              mount.volume.revision
            }}
          </p>
          <p class="meta mono mt-2 break-all">{{ mount.volumeId }}</p>
          <p v-if="volumeFor(mount.volumeId)" class="meta mono mt-2 break-all">
            PVC {{ volumeFor(mount.volumeId)?.pvc.name }} · UID
            {{ volumeFor(mount.volumeId)?.pvc.uid ?? '尚未创建' }}
          </p>
          <p
            v-if="
              volumeFor(mount.volumeId) && awaitsInitialDatabaseVolume(volumeFor(mount.volumeId)!)
            "
            class="meta mt-2"
          >
            数据卷尚未创建。确认首次发布后，将先核验存储并创建 PVC，再初始化数据库。
          </p>
        </li>
      </ul>
      <p v-else class="meta mt-3">这份完整挂载草稿没有持久卷。</p>
      <p v-if="mounts.data.value?.data.some((item) => !item.desired)" class="meta mt-3">
        原发布中的移除项仍有引用；发布和实际卸载完成后才解除占用。
      </p>
    </QueryState>
    <h4 class="font-medium mt-6">数据库连接草稿</h4>
    <QueryState
      :pending="bindings.isPending.value"
      :error="bindings.error.value"
      @retry="bindings.refetch()"
    >
      <ul v-if="desiredBindings.length" class="draft-reference-list mt-3">
        <li v-for="binding in desiredBindings" :key="binding.id">
          <RouterLink
            :to="`/databases/${binding.databaseInstanceId}`"
            class="text-link font-medium"
            >{{ binding.provider.name }}</RouterLink
          >
          <p class="meta mono mt-2 break-all">{{ binding.databaseInstanceId }}</p>
          <ul class="text-sm space-y-1 mt-3">
            <li v-for="(name, output) in binding.mapping" :key="output">
              <code>{{ name }}</code> ← {{ databaseOutputLabel[output] ?? output }}
            </li>
          </ul>
          <p v-if="databaseFor(binding.databaseInstanceId)" class="meta mono mt-3 break-all">
            凭证引用 {{ databaseFor(binding.databaseInstanceId)?.credential.refId }} · 内容 r{{
              databaseFor(binding.databaseInstanceId)?.credential.contentRevision
            }}
          </p>
        </li>
      </ul>
      <p v-else class="meta mt-3">这份完整连接草稿没有数据库依赖。</p>
      <p v-if="bindings.data.value?.data.some((item) => !item.desired)" class="meta mt-3">
        已从草稿移除的连接仍保留历史发布引用，后续发布完成才解除依赖。
      </p>
    </QueryState>
    <QueryState
      v-if="volumeIds.length || databaseIds.length"
      :pending="detailsPending"
      :error="detailsError"
      class="mt-4"
      @retry="refresh"
    >
      <div
        v-if="service.databaseInstanceId && databaseFor(service.databaseInstanceId)"
        class="notice mt-4"
      >
        <Info />
        <div class="min-w-0">
          <strong>数据库初始化身份固定</strong>
          <p>{{ databaseFor(service.databaseInstanceId)?.protection.reason }}</p>
          <p class="meta mono mt-2 break-all">
            凭证引用 {{ databaseFor(service.databaseInstanceId)?.credential.refId }} · 内容 r{{
              databaseFor(service.databaseInstanceId)?.credential.contentRevision
            }}
          </p>
        </div>
      </div>
    </QueryState>
    <div v-if="blockers.length" class="notice notice-warning mt-5">
      <AlertCircle />
      <div>
        <strong>发布前需要处理</strong>
        <ul class="mt-2 space-y-2">
          <li v-for="issue in blockers" :key="issue">{{ issue }}</li>
        </ul>
      </div>
    </div>
    <p class="meta mt-4">
      草稿引用按服务 r{{ service.revision }}
      核对。受理时将固定卷身份、挂载路径、提供方部署和凭证引用；不会显示明文密码或连接 URI。
    </p>
  </div>
</template>

<style scoped>
.draft-reference-list {
  display: grid;
  gap: 0.875rem;
}
.draft-reference-list > li {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
  min-width: 0;
}
</style>
