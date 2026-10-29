<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Plus, Settings2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import type { Cluster, Environment, Project } from '@/lib/types';
import DomainCollection from '@/components/networking/DomainCollection.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const queryValue = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const projectId = computed(() => queryValue('projectId'));
const environmentId = computed(() => queryValue('environmentId'));
const clusterId = computed(() => queryValue('clusterId'));
const serviceId = computed(() => queryValue('serviceId'));
const projects = useCollection<Project>('/projects');
const clusters = useCollection<Cluster>('/clusters');
const environments = useCollection<Environment>(
  '/environments',
  computed(() => ({ projectId: projectId.value })),
  computed(() => !!projectId.value),
);
function filter(key: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  void router.replace({
    path: '/domains',
    query: {
      ...route.query,
      [key]: value || undefined,
      ...(key === 'projectId' ? { environmentId: undefined, serviceId: undefined } : {}),
    },
  });
}
</script>
<template>
  <div class="page-head">
    <div>
      <h1>域名与网络</h1>
      <p>分别检查 DNS、路由后端和证书，定位访问问题。</p>
    </div>
    <div class="actions">
      <Button as-child variant="outline"
        ><RouterLink to="/settings?tab=network"><Settings2 />入口设置</RouterLink></Button
      ><Button v-if="!auth.restoreMode" as-child
        ><RouterLink to="/services"><Plus />选择服务分配域名</RouterLink></Button
      >
    </div>
  </div>
  <div class="domain-filters mb-6">
    <div class="field">
      <label for="domains-project">所属项目</label
      ><select
        id="domains-project"
        :value="projectId"
        class="input"
        @change="filter('projectId', $event)"
      >
        <option value="">全部项目</option>
        <option
          v-if="projectId && !projects.items.value.some((item) => item.id === projectId)"
          :value="projectId"
        >
          当前项目 {{ projectId.slice(0, 8) }}
        </option>
        <option v-for="item in projects.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
        </option></select
      ><Button v-if="projects.hasNextPage.value" variant="ghost" @click="projects.fetchNextPage()"
        >载入更多项目</Button
      >
    </div>
    <div class="field">
      <label for="domains-environment">所属环境</label
      ><select
        id="domains-environment"
        :value="environmentId"
        class="input"
        :disabled="!projectId"
        @change="filter('environmentId', $event)"
      >
        <option value="">{{ projectId ? '全部环境' : '先选择项目' }}</option>
        <option
          v-if="
            environmentId && !environments.items.value.some((item) => item.id === environmentId)
          "
          :value="environmentId"
        >
          当前环境 {{ environmentId.slice(0, 8) }}
        </option>
        <option v-for="item in environments.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
        </option></select
      ><Button
        v-if="environments.hasNextPage.value"
        variant="ghost"
        @click="environments.fetchNextPage()"
        >载入更多环境</Button
      >
    </div>
    <div class="field">
      <label for="domains-cluster">承载集群</label
      ><select
        id="domains-cluster"
        :value="clusterId"
        class="input"
        @change="filter('clusterId', $event)"
      >
        <option value="">全部集群</option>
        <option
          v-if="clusterId && !clusters.items.value.some((item) => item.id === clusterId)"
          :value="clusterId"
        >
          当前集群 {{ clusterId.slice(0, 8) }}
        </option>
        <option v-for="item in clusters.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
        </option></select
      ><Button v-if="clusters.hasNextPage.value" variant="ghost" @click="clusters.fetchNextPage()"
        >载入更多集群</Button
      >
    </div>
  </div>
  <p v-if="serviceId" class="meta mb-4">
    当前仅显示指定服务。<RouterLink
      :to="{ path: '/domains', query: { ...route.query, serviceId: undefined } }"
      class="text-link"
      >清除服务范围</RouterLink
    >
  </p>
  <DomainCollection
    :project-id="projectId"
    :environment-id="environmentId"
    :cluster-id="clusterId"
    :service-id="serviceId"
  />
</template>
<style scoped>
.domain-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  max-width: 54rem;
}
@media (max-width: 639px) {
  .domain-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
