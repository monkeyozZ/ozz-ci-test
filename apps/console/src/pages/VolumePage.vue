<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import {
  ChevronRight,
  RefreshCw,
  Activity,
  Trash2,
  LoaderCircle,
  AlertCircle,
  ArrowRight,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import StorageTarget from '@/components/storage/StorageTarget.vue';
import StorageIssues from '@/components/storage/StorageIssues.vue';
import StorageMutationError from '@/components/storage/StorageMutationError.vue';
import VolumeObservations from '@/components/storage/VolumeObservations.vue';
import VolumeReferences from '@/components/storage/VolumeReferences.vue';
import VolumeMaintenancePanel from '@/components/storage/VolumeMaintenancePanel.vue';
import ManualDataGuide from '@/components/storage/ManualDataGuide.vue';
import ManualDataRecords from '@/components/storage/ManualDataRecords.vue';
import { storageContext, volumeState } from '@/components/storage/presentation';
import { volumeAction, invalidateStorage } from '@/components/storage/queries';
import type { Volume, VolumeDeletionPreview } from '@/components/storage/types';
import type { Service } from '@/components/services/types';
import { serviceLocation, taskLocation } from '@/components/services/presentation';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { resourceListPath } from '@/lib/resource-list-navigation';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from '@/composables/useViewScope';
const route = useRoute();
const listLocation = computed(() => resourceListPath(route.query.list, 'volumes') ?? '/volumes');
const router = useRouter();
const auth = useAuthStore();
const active = useViewScope();
const volumeId = String(route.params.volumeId);
const volume = useQuery({
  queryKey: ['volume', volumeId],
  queryFn: ({ signal }) => api.get<Volume>(`/volumes/${volumeId}`, signal),
  refetchInterval: 10_000,
});
const context = computed(() => (volume.data.value ? storageContext(volume.data.value) : null));
const kind = computed(() =>
  volume.data.value?.retainedDatabase?.engine === 'postgresql'
    ? 'postgresql'
    : volume.data.value?.retainedDatabase?.engine === 'redis'
      ? 'redis'
      : 'files',
);
const returnServiceId = typeof route.query.serviceId === 'string' ? route.query.serviceId : '';
const returnService = useQuery({
  queryKey: ['service', returnServiceId],
  enabled: !!returnServiceId,
  queryFn: ({ signal }) => api.get<Service>(`/services/${returnServiceId}`, signal),
});
const canReturn = computed(
  () =>
    !!returnService.data.value &&
    returnService.data.value.environmentId === volume.data.value?.environment?.id &&
    returnService.data.value.clusterId === volume.data.value.cluster?.id,
);
const tabs = [
  { id: 'overview', label: '存储观察' },
  { id: 'mounts', label: '引用与挂载' },
  { id: 'manual', label: '手工备份与恢复' },
];
const tab = computed(() =>
  tabs.some((item) => item.id === route.query.tab) ? String(route.query.tab) : 'overview',
);
const keys = new Map<string, string>();
const lastAction = ref('');
const action = useMutation({
  mutationFn: volumeAction,
  onSuccess: async (operation) => {
    queryClient.setQueryData(['operation', operation.id], operation);
    await invalidateStorage(undefined, volumeId);
    if (active()) await router.push(`/operations/${operation.id}`);
  },
});
const locked = computed(
  () => auth.restoreMode || action.isPending.value || !!volume.data.value?.activeTask,
);
function perform(
  kind: 'sync' | 'maintenance/enter' | 'maintenance/exit',
  extras: { purpose?: 'backup' | 'restore'; maintenanceId?: string } = {},
) {
  if (!volume.data.value || locked.value) return;
  const input = { volumeId, revision: volume.data.value.revision, action: kind, ...extras };
  const token = JSON.stringify(input);
  if (!keys.has(token)) keys.set(token, idempotencyKey());
  lastAction.value = kind;
  action.mutate({ ...input, key: keys.get(token)! });
}
const deletion = ref<VolumeDeletionPreview | null>(null);
const confirmation = ref('');
const deletionElement = ref<HTMLElement>();
const preview = useMutation({
  mutationFn: (revision: number) =>
    api.create<VolumeDeletionPreview>(`/volumes/${volumeId}/deletion-preview`, { revision }),
  onSuccess: async (value) => {
    if (!active()) return;
    deletion.value = value;
    confirmation.value = '';
    await nextTick();
    deletionElement.value?.focus();
  },
});
const deletionStale = computed(
  () => !!deletion.value && deletion.value.revision !== volume.data.value?.revision,
);
function destroy() {
  const review = deletion.value;
  if (
    !review ||
    locked.value ||
    deletionStale.value ||
    review.blockers.length ||
    confirmation.value !== review.volumeName
  )
    return;
  const input = {
    volumeId,
    revision: review.revision,
    action: 'destroy' as const,
    confirmation: {
      volumeId: review.volumeId,
      pvcUid: review.pvcUid,
      reclaimPolicy: review.reclaimPolicy,
      previewDigest: review.previewDigest,
      volumeName: confirmation.value,
    },
  };
  const token = JSON.stringify(input);
  if (!keys.has(token)) keys.set(token, idempotencyKey());
  lastAction.value = 'destroy';
  action.mutate({ ...input, key: keys.get(token)! });
}
</script>
<template>
  <QueryState
    :pending="volume.isPending.value"
    :error="volume.error.value"
    @retry="volume.refetch()"
  >
    <template v-if="volume.data.value">
      <nav class="breadcrumbs" aria-label="面包屑">
        <RouterLink :to="listLocation" class="text-link">持久卷</RouterLink><ChevronRight /><span>{{
          volume.data.value.name
        }}</span>
      </nav>
      <div class="page-head">
        <div>
          <div class="flex items-center flex-wrap gap-3">
            <h1>{{ volume.data.value.name }}</h1>
            <NetworkStateBadge v-bind="volumeState(volume.data.value)" />
          </div>
          <p>
            {{
              volume.data.value.retained
                ? '服务已删除，卷与数据身份继续保留。'
                : '独立管理数据卷，服务停止和删除都会保留此卷。'
            }}
          </p>
        </div>
        <div class="actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="刷新卷详情"
            :disabled="volume.isFetching.value"
            @click="volume.refetch()"
            ><RefreshCw /></Button
          ><Button
            type="button"
            variant="outline"
            :disabled="locked || volume.data.value.desiredState === 'destroyed'"
            @click="perform('sync')"
            ><LoaderCircle
              v-if="action.isPending.value && lastAction === 'sync'"
              class="animate-spin"
            />重新检查存储</Button
          >
        </div>
      </div>
      <StorageTarget v-if="context" :context="context" class="mb-6" />
      <div v-else class="notice notice-warning mb-6">
        <AlertCircle />
        <p>部分归属资料已归档。卷与已确认的数据身份仍保留在当前记录。</p>
      </div>
      <div v-if="volume.data.value.activeTask" class="notice mb-6">
        <Activity />
        <div>
          <strong>卷有正在执行的任务</strong>
          <p class="mt-1">任务结束后仍需核对 PVC、节点和维护记录。</p>
          <RouterLink
            :to="taskLocation(volume.data.value.activeTask)"
            class="text-link mt-2 inline-block"
            >查看当前任务</RouterLink
          >
        </div>
      </div>
      <div v-if="canReturn && returnService.data.value" class="notice mb-6">
        <ArrowRight />
        <div>
          <strong>下一步：将卷加入服务草稿</strong>
          <p class="mt-1">
            创建卷与保存挂载分开执行。此卷的身份已经保留，挂载失败后可继续审阅同一卷。
          </p>
          <RouterLink
            :to="{
              ...serviceLocation(returnService.data.value, 'storage'),
              query: {
                environment: returnService.data.value.environment.slug,
                tab: 'storage',
                volumeId,
              },
            }"
            class="text-link mt-2 inline-block"
            >返回 {{ returnService.data.value.name }} 配置挂载</RouterLink
          >
        </div>
      </div>
      <StorageMutationError v-if="lastAction === 'sync'" :error="action.error.value" class="mb-6" />
      <nav class="page-tabs" aria-label="持久卷详情">
        <RouterLink
          v-for="item in tabs"
          :key="item.id"
          :to="{
            path: route.path,
            query: { ...route.query, tab: item.id === 'overview' ? undefined : item.id },
          }"
          :aria-current="tab === item.id ? 'page' : undefined"
          class="page-tab"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <template v-if="tab === 'overview'">
        <VolumeObservations :volume="volume.data.value" />
        <section v-if="volume.data.value.retainedDatabase" class="panel mt-6">
          <h2>受保护的数据库数据</h2>
          <p class="mt-3 text-sm">数据库身份、初始化保护和凭证引用不会随原服务删除而清空。</p>
          <RouterLink
            :to="`/databases/${volume.data.value.retainedDatabase.id}`"
            class="text-link mt-3 inline-block"
            >查看数据库保护与原服务记录</RouterLink
          >
        </section>
        <section
          v-if="volume.data.value.desiredState !== 'destroyed'"
          class="panel danger-zone mt-6"
        >
          <h2>独立销毁卷</h2>
          <p class="mt-3 text-sm">
            服务删除只保留数据。销毁卷是单独操作，需重新核对所有引用、实际占用、PVC UID 和 PV
            回收策略。
          </p>
          <StorageIssues
            :issues="volume.data.value.deletionBlockers"
            class="mt-5"
            title="当前销毁限制"
          /><StorageMutationError :error="preview.error.value" class="mt-5" /><Button
            type="button"
            variant="destructive"
            class="mt-5"
            :disabled="locked || preview.isPending.value"
            @click="preview.mutate(volume.data.value.revision)"
            ><LoaderCircle v-if="preview.isPending.value" class="animate-spin" /><Trash2
              v-else
            />审阅卷销毁</Button
          >
        </section>
        <section
          v-if="deletion"
          ref="deletionElement"
          tabindex="-1"
          class="panel mt-6"
          data-volume-deletion-preview
        >
          <h2>卷销毁审查</h2>
          <dl class="storage-facts mt-5">
            <div>
              <dt>目标卷</dt>
              <dd>{{ deletion.volumeName }}</dd>
            </div>
            <div>
              <dt>PVC / PV</dt>
              <dd class="mono">{{ deletion.pvcName }} / {{ deletion.pvName ?? '未绑定' }}</dd>
            </div>
            <div>
              <dt>固定 PVC UID</dt>
              <dd class="mono">{{ deletion.pvcUid ?? '没有已确认的 UID' }}</dd>
            </div>
            <div>
              <dt>实际回收策略</dt>
              <dd>{{ deletion.reclaimPolicy ?? '未知' }}</dd>
            </div>
            <div>
              <dt>观察时间</dt>
              <dd>{{ dateTime(deletion.observedAt) }}</dd>
            </div>
            <div>
              <dt>最近手工备份</dt>
              <dd>
                {{
                  deletion.lastManualBackupRecord
                    ? `${deletion.lastManualBackupRecord.backupId} · 操作者报告`
                    : '没有已登记的手工备份记录'
                }}
              </dd>
            </div>
          </dl>
          <StorageIssues :issues="deletion.blockers" danger class="mt-5" title="当前不能销毁" />
          <p v-if="deletionStale" class="field-error mt-5">卷版本已变化，请重新审阅销毁。</p>
          <div v-if="!deletion.blockers.length" class="notice notice-danger mt-5">
            <AlertCircle />
            <p>
              独立销毁会按已核验的回收策略删除 PVC
              与关联数据。该操作无法撤销；请先确认离机副本与恢复验证记录。资源删除不等同于物理安全擦除。
            </p>
          </div>
          <div class="field mt-5">
            <label for="volume-destroy-name">输入完整卷名「{{ deletion.volumeName }}」确认</label
            ><Input
              id="volume-destroy-name"
              v-model="confirmation"
              autocomplete="off"
              :disabled="locked || !!deletion.blockers.length || deletionStale"
            />
          </div>
          <StorageMutationError
            v-if="lastAction === 'destroy'"
            :error="action.error.value"
            class="mt-5"
          /><Button
            type="button"
            variant="destructive"
            class="mt-5"
            :disabled="
              locked ||
              !!deletion.blockers.length ||
              deletionStale ||
              confirmation !== deletion.volumeName
            "
            @click="destroy"
            ><LoaderCircle
              v-if="action.isPending.value && lastAction === 'destroy'"
              class="animate-spin"
            />确认销毁卷</Button
          >
        </section>
      </template>
      <VolumeReferences v-else-if="tab === 'mounts'" :volume="volume.data.value" />
      <template v-else
        ><ManualDataGuide
          :kind="kind"
          :source-label="volume.data.value.name"
          class="mb-6" /><VolumeMaintenancePanel
          :volume="volume.data.value"
          :disabled="auth.restoreMode"
          :pending="action.isPending.value"
          :error="lastAction.startsWith('maintenance/') ? action.error.value : null"
          class="mb-6"
          @enter="perform('maintenance/enter', { purpose: $event })"
          @exit="perform('maintenance/exit', { maintenanceId: $event })" /><ManualDataRecords
          :volume="volume.data.value"
      /></template>
    </template>
  </QueryState>
</template>
