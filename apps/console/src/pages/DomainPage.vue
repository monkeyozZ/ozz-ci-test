<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { ChevronRight, RefreshCw, Info, Activity, ArrowUpRight, AlertCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import DomainActions from '@/components/networking/DomainActions.vue';
import DomainObservations from '@/components/networking/DomainObservations.vue';
import NetworkTarget from '@/components/networking/NetworkTarget.vue';
import { domainServiceLocation, publicHttpsUrl } from '@/components/networking/presentation';
import { invalidateNetworking } from '@/components/networking/queries';
import type { Domain } from '@/components/networking/types';
import { taskLocation } from '@/components/services/presentation';
import { useViewScope } from '@/composables/useViewScope';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/utils';
import type { Operation } from '@/lib/types';

const route = useRoute();
const router = useRouter();
const active = useViewScope();
const domainId = String(route.params.domainId);
const domain = useQuery({
  queryKey: ['domain', domainId],
  queryFn: ({ signal }) => api.get<Domain>(`/domains/${domainId}`, signal),
  refetchInterval: (query) => (query.state.data?.activeTask ? 3000 : 15_000),
});
const operationId = computed(() =>
  typeof route.query.operation === 'string' && /^[0-9a-f-]{36}$/.test(route.query.operation)
    ? route.query.operation
    : '',
);
const operation = useQuery({
  queryKey: computed(() => ['operation', operationId.value]),
  enabled: computed(() => !!operationId.value),
  queryFn: ({ queryKey, signal }) => api.get<Operation>(`/operations/${queryKey[1]}`, signal),
  refetchInterval: (query) =>
    ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
});
const matchingOperation = computed(() => {
  const value = operation.data.value;
  return value && 'domainId' in value.input && value.input.domainId === domainId ? value : null;
});
watch(
  () => matchingOperation.value?.status,
  (status) => {
    if (status && !['queued', 'running'].includes(status))
      void invalidateNetworking(domain.data.value?.serviceId, domainId);
  },
);
const now = ref(Date.now());
const timer = window.setInterval(() => (now.value = Date.now()), 30_000);
onScopeDispose(() => window.clearInterval(timer));
const httpsUrl = computed(() =>
  domain.data.value ? publicHttpsUrl(domain.data.value, now.value) : null,
);
function submitted(value: Operation) {
  if (!active()) return;
  if (value.kind === 'domain_unbind') void router.push(`/operations/${value.id}`);
  else void router.replace({ path: route.path, query: { operation: value.id } });
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/domains" class="text-link">域名与网络</RouterLink><ChevronRight /><span>{{
      domain.data.value?.hostname ?? domainId.slice(0, 8)
    }}</span>
  </nav>
  <QueryState
    :pending="domain.isPending.value"
    :error="domain.error.value"
    @retry="domain.refetch()"
  >
    <template v-if="domain.data.value">
      <div class="page-head">
        <div>
          <h1 class="domain-title mono">{{ domain.data.value.hostname }}</h1>
          <p>
            {{
              domain.data.value.desiredState === 'deleting'
                ? '解绑清理中，等待受管资源删除确认。'
                : '持久默认域名，服务显示名变化后保持不变。'
            }}
          </p>
          <NetworkTarget :context="domain.data.value" class="mt-4" />
        </div>
        <div class="actions">
          <Button as-child variant="outline"
            ><RouterLink :to="domainServiceLocation(domain.data.value)"
              >返回服务网络</RouterLink
            ></Button
          ><Button
            variant="outline"
            size="icon"
            aria-label="刷新域名观察"
            :disabled="domain.isFetching.value"
            @click="domain.refetch()"
            ><RefreshCw
          /></Button>
        </div>
      </div>
      <DomainActions :domain="domain.data.value" class="mb-6" @submitted="submitted" />
      <div v-if="matchingOperation" class="notice mb-6" data-network-operation>
        <Activity aria-hidden="true" />
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <strong>本次网络任务</strong><StatusBadge :status="matchingOperation.status" />
          </div>
          <p class="mt-2">任务受理与 DNS、路由、证书结果分别记录。</p>
          <RouterLink
            :to="`/operations/${matchingOperation.id}`"
            class="text-link inline-block mt-2"
            >查看本次任务</RouterLink
          >
        </div>
      </div>
      <div v-else-if="domain.data.value.activeTask" class="notice mb-6">
        <Activity aria-hidden="true" />
        <div>
          <strong>此服务有正在处理的任务</strong>
          <p class="mt-2">任务完成前暂不能提交另一项网络变更。</p>
          <RouterLink
            :to="taskLocation(domain.data.value.activeTask)"
            class="text-link inline-block mt-2"
            >查看当前任务</RouterLink
          >
        </div>
      </div>
      <div v-if="domain.data.value.lastErrorMessage" class="notice notice-danger mb-6">
        <AlertCircle aria-hidden="true" />
        <div class="min-w-0">
          <strong>{{ domain.data.value.lastErrorMessage }}</strong>
          <p v-if="domain.data.value.lastErrorCode" class="mono mt-2">
            {{ domain.data.value.lastErrorCode }}
          </p>
          <RouterLink
            :to="{ path: '/operations', query: { serviceId: domain.data.value.serviceId } }"
            class="text-link inline-block mt-3"
            >查看相关任务与重试入口</RouterLink
          >
        </div>
      </div>
      <div v-if="domain.data.value.observationStale" class="notice notice-warning mb-6">
        <Info aria-hidden="true" />
        <p>当前显示上次观察结果，尚未确认最新状态。重新检查后继续核对三组结果。</p>
      </div>
      <div class="split">
        <section class="panel">
          <h2 class="mb-6">独立检查结果</h2>
          <DomainObservations :domain="domain.data.value" />
        </section>
        <aside class="stack">
          <section class="panel">
            <h2>绑定资料</h2>
            <dl class="detail-list mt-4">
              <div>
                <dt>服务</dt>
                <dd>
                  <RouterLink :to="domainServiceLocation(domain.data.value)" class="text-link">{{
                    domain.data.value.serviceName
                  }}</RouterLink>
                </dd>
              </div>
              <div>
                <dt>HTTP 端口</dt>
                <dd class="mono">
                  {{ domain.data.value.servicePort.name }}:{{
                    domain.data.value.servicePort.servicePort
                  }}
                </dd>
              </div>
              <div>
                <dt>端口发布版本</dt>
                <dd>r{{ domain.data.value.servicePort.publishedConfigRevision }}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{{ dateTime(domain.data.value.createdAt) }}</dd>
              </div>
              <div>
                <dt>最近尝试</dt>
                <dd>{{ dateTime(domain.data.value.lastAttemptAt) }}</dd>
              </div>
            </dl>
          </section>
          <section class="panel">
            <h2>访问入口</h2>
            <template v-if="httpsUrl"
              ><p class="meta mt-3 mb-4">最近观察中的 DNS、路由与正式证书均已就绪。</p>
              <Button as-child
                ><a :href="httpsUrl" target="_blank" rel="noopener noreferrer"
                  >打开 HTTPS<ArrowUpRight /></a></Button></template
            ><template v-else
              ><p class="muted mt-3">入口尚未确认可用。</p>
              <p class="meta mt-2">
                DNS、路由和有效的正式证书分别就绪后，才提供 HTTPS 访问链接。
              </p></template
            >
          </section>
        </aside>
      </div>
    </template>
  </QueryState>
</template>
<style scoped>
.domain-title {
  font-size: clamp(1.125rem, 2vw, 1.5rem);
  line-height: 1.5;
}
</style>
