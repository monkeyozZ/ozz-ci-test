<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import { ChevronRight, Activity } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import { taskLocation } from '@/components/services/presentation';
import NetworkStateBadge from './NetworkStateBadge.vue';
import { certificateStatus, dnsStatus, routeStatus, domainServiceLocation } from './presentation';
import type { Domain } from './types';

defineProps<{ domains: Domain[] }>();
const now = ref(Date.now());
const timer = window.setInterval(() => (now.value = Date.now()), 30_000);
onScopeDispose(() => window.clearInterval(timer));
</script>
<template>
  <div class="table-wrap domain-list" data-domain-list>
    <table class="data-table domain-table">
      <caption class="sr-only">
        域名、固定目标以及独立的 DNS、路由和证书检查结果
      </caption>
      <thead>
        <tr>
          <th>域名</th>
          <th>归属与端口</th>
          <th>DNS</th>
          <th>路由</th>
          <th>TLS</th>
          <th><span class="sr-only">操作</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="domain in domains" :key="domain.id" :data-domain-id="domain.id">
          <td class="domain-name-cell">
            <RouterLink :to="`/domains/${domain.id}`" class="text-link font-semibold mono hostname">
              {{ domain.hostname }}
            </RouterLink>
            <p class="meta mt-2">
              {{ domain.desiredState === 'deleting' ? '解绑清理中' : '默认域名 · 标识已固定' }}
            </p>
            <p v-if="domain.observationStale" class="stale-note mt-2">上次观察，当前未能更新</p>
          </td>
          <td class="domain-context-cell">
            <p>{{ domain.project.name }} / {{ domain.environment.name }}</p>
            <RouterLink :to="domainServiceLocation(domain)" class="text-link inline-block mt-1">{{
              domain.serviceName
            }}</RouterLink>
            <p class="meta mt-1">{{ domain.cluster.name }}</p>
            <p class="mono meta mt-1">
              {{ domain.servicePort.name }}:{{ domain.servicePort.servicePort }} · HTTP
            </p>
          </td>
          <td data-label="DNS" class="domain-status-cell">
            <NetworkStateBadge v-bind="dnsStatus(domain.dns)" />
            <p class="meta mt-2">{{ domain.dns ? dateTime(domain.dns.observedAt) : '尚无观察' }}</p>
          </td>
          <td data-label="路由" class="domain-status-cell">
            <NetworkStateBadge v-bind="routeStatus(domain.route)" />
            <p class="meta mt-2">
              {{ domain.route ? dateTime(domain.route.observedAt) : '尚无观察' }}
            </p>
          </td>
          <td data-label="TLS" class="domain-status-cell">
            <NetworkStateBadge v-bind="certificateStatus(domain.certificate, now)" />
            <p class="meta mt-2">
              {{
                domain.certificate?.notAfter
                  ? `到期 ${dateTime(domain.certificate.notAfter)}`
                  : '有效期待确认'
              }}
            </p>
          </td>
          <td class="domain-actions-cell">
            <RouterLink
              :to="`/domains/${domain.id}`"
              class="text-link domain-open"
              :aria-label="`查看域名 ${domain.hostname}`"
              >详情<ChevronRight class="size-4"
            /></RouterLink>
            <RouterLink
              v-if="domain.activeTask"
              :to="taskLocation(domain.activeTask)"
              class="text-link domain-open mt-3"
              ><Activity class="size-3.5" />任务</RouterLink
            >
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.domain-table {
  table-layout: fixed;
  font-size: 0.875rem;
}
.domain-table th:first-child {
  width: 27%;
}
.domain-table th:nth-child(2) {
  width: 23%;
}
.domain-table th:nth-child(3),
.domain-table th:nth-child(4),
.domain-table th:nth-child(5) {
  width: 14%;
}
.domain-table th:last-child {
  width: 8%;
}
.domain-table td,
.domain-table th {
  padding: 1rem;
}
.domain-table td {
  overflow-wrap: anywhere;
}
.hostname {
  font-size: 0.875rem;
}
.domain-open {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
}
.stale-note {
  color: var(--warning);
  font-size: 0.75rem;
}
.domain-status-cell :deep(.badge) {
  white-space: normal;
}
@media (max-width: 1199px) {
  .domain-table,
  .domain-table tbody {
    display: block;
  }
  .domain-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .domain-table tr {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.125rem;
    padding: 1.25rem;
    border-top: 1px solid var(--border);
  }
  .domain-table tr:first-child {
    border-top: 0;
  }
  .domain-table td {
    display: block;
    border: 0;
    padding: 0;
  }
  .domain-name-cell {
    grid-column: 1 / 3;
  }
  .domain-context-cell {
    grid-column: 1 / -1;
  }
  .domain-actions-cell {
    grid-column: 3;
    grid-row: 1;
    justify-self: end;
  }
  .domain-status-cell::before {
    content: attr(data-label);
    display: block;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    margin-bottom: 0.625rem;
  }
}
@media (max-width: 479px) {
  .domain-table tr {
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    padding: 1.125rem;
  }
  .domain-name-cell,
  .domain-context-cell,
  .domain-actions-cell {
    grid-column: 1;
  }
  .domain-actions-cell {
    grid-row: auto;
    justify-self: start;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .domain-actions-cell a {
    margin: 0;
  }
  .domain-status-cell {
    display: grid !important;
    grid-template-columns: 3.5rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: start;
  }
  .domain-status-cell::before {
    padding-top: 0.1875rem;
    margin: 0;
  }
  .domain-status-cell p {
    grid-column: 2;
    margin: 0;
  }
}
</style>
