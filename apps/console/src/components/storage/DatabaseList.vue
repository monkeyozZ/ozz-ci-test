<script setup lang="ts">
import { Database as DatabaseIcon, ArrowUpRight, ShieldCheck } from '@lucide/vue';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import { dateTime } from '@/lib/utils';
import type { Database } from './types';
import { databaseState, engineLabel } from './presentation';
defineProps<{ databases: Database[] }>();
</script>
<template>
  <div class="panel database-list" data-database-list>
    <article
      v-for="database in databases"
      :key="database.id"
      class="database-row"
      :data-database-id="database.id"
    >
      <div class="database-name">
        <DatabaseIcon class="size-5 shrink-0 text-primary" />
        <div class="min-w-0">
          <RouterLink :to="`/databases/${database.id}`" class="text-link font-semibold">{{
            database.service?.name ?? database.originalService.name
          }}</RouterLink>
          <p class="meta mt-2">{{ engineLabel(database.engine) }} {{ database.exactVersion }}</p>
          <p v-if="!database.service" class="meta mt-2">原服务已删除 · 数据与保护身份保留</p>
          <RouterLink
            :to="`/volumes/${database.dataVolume.id}`"
            class="text-link inline-block mt-2 text-sm"
            >{{ database.dataVolume.name }}</RouterLink
          >
        </div>
      </div>
      <div class="database-connection">
        <span class="meta">集群内私有地址</span>
        <p class="mono text-sm mt-2">{{ database.connection.host ?? '尚未发布' }}</p>
        <p class="meta mt-2">
          端口 {{ database.connection.port }} ·
          {{
            database.engine === 'redis'
              ? `逻辑库 ${database.connection.redisDatabase ?? '未知'}`
              : database.connection.database
          }}
        </p>
      </div>
      <div>
        <NetworkStateBadge v-bind="databaseState(database)" />
        <p class="meta mt-2">{{ dateTime(database.observation?.observedAt) }}</p>
        <p v-if="database.protection.active" class="meta mt-2 inline-flex gap-1 items-center">
          <ShieldCheck class="size-3.5" />数据身份受保护
        </p>
      </div>
      <RouterLink
        :to="`/databases/${database.id}`"
        class="text-link database-open inline-flex items-center gap-1"
        :aria-label="`查看数据库 ${database.service?.name ?? database.originalService.name}`"
        >详情<ArrowUpRight class="size-4"
      /></RouterLink>
    </article>
  </div>
</template>
<style scoped>
.database-list {
  padding: 0;
}
.database-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(10rem, 0.8fr) 4rem;
  gap: 1.5rem;
  padding: 1.5rem;
  align-items: start;
}
.database-row + .database-row {
  border-top: 1px solid var(--border);
}
.database-name {
  display: flex;
  align-items: start;
  gap: 0.875rem;
}
.database-name > svg {
  margin-top: 0.125rem;
}
.database-row p,
.database-row a {
  overflow-wrap: anywhere;
}
.database-open {
  justify-self: end;
}
@media (max-width: 1100px) {
  .database-row {
    grid-template-columns: minmax(0, 1fr) minmax(10rem, 0.6fr);
  }
  .database-name {
    grid-column: 1;
  }
  .database-connection {
    grid-column: 1;
    grid-row: 2;
    padding-left: 2.125rem;
  }
  .database-open {
    align-self: end;
  }
}
@media (max-width: 600px) {
  .database-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
    padding: 1.125rem;
  }
  .database-connection {
    grid-row: auto;
    padding-left: 0;
  }
  .database-open {
    justify-self: start;
  }
}
</style>
