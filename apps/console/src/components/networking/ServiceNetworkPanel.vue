<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { RefreshCw, Settings2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import { api } from '@/lib/api';
import { useViewScope } from '@/composables/useViewScope';
import type { Operation } from '@/lib/types';
import DomainAllocationForm from './DomainAllocationForm.vue';
import DomainList from './DomainList.vue';
import NetworkTarget from './NetworkTarget.vue';
import { networkingSettingsLocation } from './presentation';
import type { ServiceNetworking } from './types';

const props = defineProps<{ serviceId: string }>();
const router = useRouter();
const active = useViewScope();
const network = useQuery({
  queryKey: ['service-networking', props.serviceId],
  queryFn: ({ signal }) =>
    api.get<ServiceNetworking>(`/services/${props.serviceId}/networking`, signal),
  refetchInterval: 10_000,
});
function submitted(operation: Operation) {
  if (!active()) return;
  const input = operation.input;
  if ('domainId' in input && typeof input.domainId === 'string')
    void router.push({ path: `/domains/${input.domainId}`, query: { operation: operation.id } });
  else void router.push(`/operations/${operation.id}`);
}
</script>
<template>
  <section data-service-networking>
    <div class="section-head">
      <div>
        <h2>域名与网络</h2>
        <p class="meta mt-1">分别查看 DNS、路由和证书，定位入口访问问题。</p>
      </div>
      <div class="actions">
        <Button v-if="network.data.value" as-child variant="outline"
          ><RouterLink :to="networkingSettingsLocation(network.data.value.cluster.id)"
            ><Settings2 />入口设置</RouterLink
          ></Button
        >
        <Button
          variant="outline"
          size="icon"
          aria-label="刷新服务网络"
          :disabled="network.isFetching.value"
          @click="network.refetch()"
          ><RefreshCw
        /></Button>
      </div>
    </div>
    <QueryState
      :pending="network.isPending.value"
      :error="network.error.value"
      @retry="network.refetch()"
    >
      <template v-if="network.data.value">
        <template v-if="network.data.value.domains.length">
          <NetworkTarget :context="network.data.value" class="mb-5" />
          <DomainList :domains="network.data.value.domains" />
          <p class="meta mt-4">
            域名使用已发布的具名端口。查看域名详情可检查 DNS、申请正式证书或解绑。
          </p>
        </template>
        <DomainAllocationForm v-else :context="network.data.value" @submitted="submitted" />
      </template>
    </QueryState>
  </section>
</template>
