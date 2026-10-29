<script setup lang="ts">
import { HardDrive, ArrowUpRight, Activity } from '@lucide/vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import { taskLocation } from '@/components/services/presentation';
import { dateTime } from '@/lib/utils';
import type { Volume } from './types';
import { formatStorageBytes } from './format';
import { volumeState, maintenanceState } from './presentation';
defineProps<{ volumes: Volume[] }>();
</script>
<template>
  <div class="panel volume-list" data-volume-list>
    <article
      v-for="volume in volumes"
      :key="volume.id"
      class="volume-row"
      :data-volume-id="volume.id"
    >
      <div class="volume-name">
        <HardDrive class="size-5 shrink-0 text-primary" />
        <div class="min-w-0">
          <RouterLink :to="`/volumes/${volume.id}`" class="text-link font-semibold">{{
            volume.name
          }}</RouterLink>
          <p class="meta mt-2">
            {{ volume.project?.name ?? '项目已归档' }} /
            {{ volume.environment?.name ?? '环境已归档' }} ·
            {{ volume.cluster?.name ?? '集群已归档' }}
          </p>
          <p class="meta mono mt-2">{{ volume.storageClassName }} · {{ volume.pvc.name }}</p>
        </div>
      </div>
      <div class="volume-size">
        <span class="meta">申请容量</span>
        <p class="font-medium mt-1">{{ formatStorageBytes(volume.requestedBytes) }}</p>
        <p class="meta mt-1">
          {{ volume.hardQuotaSupport === 'unsupported' ? '无硬配额' : '配额能力未知' }}
        </p>
      </div>
      <div class="volume-state">
        <NetworkStateBadge v-bind="volumeState(volume)" />
        <p class="meta mt-2">{{ dateTime(volume.observation.observedAt) }}</p>
        <p v-if="volume.retained" class="meta mt-2">服务删除后保留的数据</p>
        <NetworkStateBadge
          v-if="volume.maintenance && volume.maintenance.state !== 'closed'"
          class="mt-2"
          v-bind="maintenanceState(volume.maintenance)"
        />
      </div>
      <div class="volume-actions">
        <RouterLink
          :to="`/volumes/${volume.id}`"
          class="text-link inline-flex items-center gap-1"
          :aria-label="`查看卷 ${volume.name}`"
          >详情<ArrowUpRight class="size-4" /></RouterLink
        ><RouterLink
          v-if="volume.activeTask"
          :to="taskLocation(volume.activeTask)"
          class="text-link inline-flex items-center gap-1 mt-3"
          ><Activity class="size-4" />任务</RouterLink
        >
      </div>
    </article>
  </div>
</template>
<style scoped>
.volume-list {
  padding: 0;
}
.volume-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(7rem, 0.55fr) minmax(0, 1fr) 4rem;
  gap: 1.5rem;
  align-items: start;
  padding: 1.5rem;
}
.volume-row + .volume-row {
  border-top: 1px solid var(--border);
}
.volume-name {
  display: flex;
  align-items: start;
  gap: 0.875rem;
}
.volume-name > svg {
  margin-top: 0.125rem;
}
.volume-row p,
.volume-row a {
  overflow-wrap: anywhere;
}
.volume-actions {
  display: flex;
  flex-direction: column;
  align-items: end;
}
@media (max-width: 1023px) {
  .volume-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 4rem;
    gap: 1rem;
  }
  .volume-name {
    grid-column: 1 / 3;
  }
  .volume-size {
    grid-column: 1;
    grid-row: 2;
    padding-left: 2.125rem;
  }
  .volume-state {
    grid-column: 2;
    grid-row: 2;
  }
  .volume-actions {
    grid-column: 3;
    grid-row: 1 / 3;
  }
}
@media (max-width: 550px) {
  .volume-row {
    grid-template-columns: minmax(0, 1fr);
    padding: 1.125rem;
    gap: 1.25rem;
  }
  .volume-name,
  .volume-size,
  .volume-state,
  .volume-actions {
    grid-column: 1;
    grid-row: auto;
  }
  .volume-size {
    padding-left: 0;
  }
  .volume-actions {
    flex-direction: row;
    gap: 1.25rem;
    align-items: center;
  }
  .volume-actions a {
    margin-top: 0;
  }
}
</style>
