<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { Layers3, Plus } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api } from '@/lib/api';
import { useCollection } from '@/lib/query';
import type { Cluster } from '@/lib/types';
import ClusterEntryEditor from './ClusterEntryEditor.vue';

const route = useRoute();
const router = useRouter();
const clusters = useCollection<Cluster>('/clusters');
const clusterId = computed(() =>
  typeof route.query.clusterId === 'string'
    ? route.query.clusterId
    : (clusters.items.value[0]?.id ?? ''),
);
const cluster = useQuery({
  queryKey: computed(() => ['cluster', clusterId.value]),
  enabled: computed(() => !!clusterId.value),
  queryFn: ({ queryKey, signal }) => api.get<Cluster>(`/clusters/${queryKey[1]}`, signal),
});
async function changeCluster(event: Event) {
  const select = event.target as HTMLSelectElement;
  try {
    await router.push({ path: '/settings', query: { tab: 'network', clusterId: select.value } });
  } finally {
    select.value = clusterId.value;
  }
}
</script>
<template>
  <section class="panel" data-cluster-networking-settings>
    <div class="section-head">
      <div>
        <h2>集群应用入口</h2>
        <p class="meta mt-1">每个集群独立配置后缀、预期入口与网络能力。</p>
      </div>
    </div>
    <QueryState
      :pending="clusters.isPending.value"
      :error="clusters.error.value"
      @retry="clusters.refetch()"
    >
      <template v-if="clusters.items.value.length || clusterId">
        <div class="field mb-6 max-w-lg">
          <label for="networking-cluster">承载集群</label
          ><select id="networking-cluster" :value="clusterId" class="input" @change="changeCluster">
            <option
              v-if="
                cluster.data.value && !clusters.items.value.some((item) => item.id === clusterId)
              "
              :value="clusterId"
            >
              {{ cluster.data.value.name }}
            </option>
            <option v-for="item in clusters.items.value" :key="item.id" :value="item.id">
              {{ item.name }} · {{ item.slug }}
            </option></select
          ><Button
            v-if="clusters.hasNextPage.value"
            variant="ghost"
            :disabled="clusters.isFetchingNextPage.value"
            @click="clusters.fetchNextPage()"
            >载入更多集群</Button
          >
        </div>
        <QueryState
          :pending="cluster.isPending.value"
          :error="cluster.error.value"
          @retry="cluster.refetch()"
          ><ClusterEntryEditor
            v-if="cluster.data.value"
            :key="cluster.data.value.id"
            :cluster="cluster.data.value"
        /></QueryState>
      </template>
      <EmptyState
        v-else
        :icon="Layers3"
        title="先登记一个集群"
        description="应用入口属于具体集群，登记后可配置域名后缀与预期地址。"
        ><Button as-child
          ><RouterLink to="/clusters/new"><Plus />登记集群</RouterLink></Button
        ></EmptyState
      >
    </QueryState>
  </section>
</template>
