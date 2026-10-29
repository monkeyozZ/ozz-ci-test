<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { HardDrive } from '@lucide/vue';
import { volumeOperationInput } from '@/components/infrastructure/operation-presentation';
import { api } from '@/lib/api';
import type { Operation } from '@/lib/types';
import type { Volume } from './types';
import StorageTarget from './StorageTarget.vue';
import { storageContext } from './presentation';

const props = defineProps<{ operation: Operation }>();
const input = computed(() => volumeOperationInput(props.operation));
const volume = useQuery({
  queryKey: computed(() => ['volume', input.value?.volumeId]),
  enabled: computed(() => !!input.value),
  queryFn: ({ queryKey, signal }) => api.get<Volume>(`/volumes/${queryKey[1]}`, signal),
});
const maintenance = computed(() => props.operation.kind.startsWith('volume_maintenance_'));
const context = computed(() => (volume.data.value ? storageContext(volume.data.value) : null));
</script>

<template>
  <section v-if="input" class="notice mb-6" data-volume-operation-context>
    <HardDrive aria-hidden="true" />
    <div class="min-w-0">
      <h2 class="text-base">固定数据卷 · {{ volume.data.value?.name ?? input.volumeId }}</h2>
      <StorageTarget v-if="context" :context="context" class="mt-3" />
      <p class="meta mono mt-3 break-all">
        卷 {{ input.volumeId }} · 提交版本 r{{ input.volumeRevision }}
      </p>
      <p class="meta mono mt-2 break-all">命名空间 {{ input.target.namespace }}</p>
      <p class="meta mt-3">任务结束后，请在卷详情核对 PVC、节点和实际挂载的最近观察。</p>
      <p v-if="maintenance" class="mt-3">
        维护锁独立于任务状态保存。任务结束或维护超时都不会自动释放锁，也不会自动完成备份或恢复。
      </p>
      <p v-if="operation.kind === 'volume_create'" class="mt-3">
        创建任务成功后，WaitForFirstConsumer 卷可以继续
        Pending；保存并发布消费者挂载后才会绑定节点。
      </p>
      <dl v-if="input.confirmation" class="storage-facts mt-4">
        <div>
          <dt>已确认 PVC UID</dt>
          <dd class="mono break-all">{{ input.confirmation.pvcUid ?? '从未创建 PVC' }}</dd>
        </div>
        <div>
          <dt>已确认回收策略</dt>
          <dd>{{ input.confirmation.reclaimPolicy ?? '无远端卷' }}</dd>
        </div>
      </dl>
      <div class="flex flex-wrap gap-x-5 gap-y-3 mt-4">
        <RouterLink :to="`/volumes/${input.volumeId}`" class="text-link">查看数据卷观察</RouterLink>
        <RouterLink
          v-if="maintenance"
          :to="{ path: `/volumes/${input.volumeId}`, query: { tab: 'manual' } }"
          class="text-link"
          >查看维护状态与手工记录</RouterLink
        >
      </div>
    </div>
  </section>
</template>
