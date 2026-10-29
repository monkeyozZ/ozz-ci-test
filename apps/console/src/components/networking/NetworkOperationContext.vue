<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Globe, Layers3 } from '@lucide/vue';
import {
  domainOperationInput,
  clusterNetworkingOperationInput,
} from '@/components/infrastructure/operation-presentation';
import NetworkTarget from './NetworkTarget.vue';
import { networkingSettingsLocation } from './presentation';
import { api, ApiError } from '@/lib/api';
import type { Cluster, Operation } from '@/lib/types';
import type { Domain } from './types';

const props = defineProps<{ operation: Operation }>();
const domainInput = computed(() => domainOperationInput(props.operation));
const clusterInput = computed(() => clusterNetworkingOperationInput(props.operation));
const domainId = computed(() => domainInput.value?.domainId ?? '');
const unbound = computed(
  () => props.operation.kind === 'domain_unbind' && props.operation.status === 'succeeded',
);
const domain = useQuery({
  queryKey: computed(() => ['domain', domainId.value]),
  enabled: computed(() => !!domainId.value && !unbound.value),
  queryFn: ({ queryKey, signal }) => api.get<Domain>(`/domains/${queryKey[1]}`, signal),
});
const clusterId = computed(() => clusterInput.value?.clusterId ?? '');
const cluster = useQuery({
  queryKey: computed(() => ['cluster', clusterId.value]),
  enabled: computed(() => !!clusterId.value),
  queryFn: ({ queryKey, signal }) => api.get<Cluster>(`/clusters/${queryKey[1]}`, signal),
});
const domainMissing = computed(
  () => domain.error.value instanceof ApiError && domain.error.value.status === 404,
);
</script>
<template>
  <div v-if="domainInput" class="notice mb-6" data-domain-operation-context>
    <Globe aria-hidden="true" />
    <div class="min-w-0">
      <strong class="break-all">固定域名 · {{ domainInput.hostname }}</strong>
      <NetworkTarget
        v-if="domain.data.value && !unbound"
        :context="domain.data.value"
        class="mt-3"
      />
      <p v-else class="mono break-all mt-2">
        {{ domainInput.target.namespace }} / {{ domainInput.target.portName }}
      </p>
      <p class="meta mt-3">此处保留本次任务结果，DNS、路由与证书的最近观察在域名详情中查看。</p>
      <RouterLink
        v-if="!unbound && !domainMissing"
        :to="`/domains/${domainInput.domainId}`"
        class="text-link inline-block mt-3"
        >查看域名独立检查</RouterLink
      >
      <p v-else class="meta mt-3">
        {{
          unbound
            ? '本次解绑已完成，固定目标与任务记录保留。'
            : '原域名记录已不存在，固定目标与任务记录保留。'
        }}
      </p>
      <RouterLink to="/domains" class="text-link inline-block mt-3 ml-4">返回域名列表</RouterLink>
    </div>
  </div>
  <div v-else-if="clusterInput" class="notice mb-6" data-cluster-network-operation-context>
    <Layers3 aria-hidden="true" />
    <div class="min-w-0">
      <strong class="break-all"
        >固定集群 · {{ cluster.data.value?.name ?? clusterInput.clusterId }}</strong
      >
      <p class="meta mt-2">
        基于入口设置 r{{ clusterInput.networkRevision }} 提交，能力检查与安装结果保存在本任务中。
      </p>
      <RouterLink
        :to="networkingSettingsLocation(clusterInput.clusterId)"
        class="text-link inline-block mt-3"
        >查看集群入口与网络能力</RouterLink
      >
    </div>
  </div>
</template>
