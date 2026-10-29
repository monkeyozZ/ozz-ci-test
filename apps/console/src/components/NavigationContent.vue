<script setup lang="ts">
import { computed, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  FolderKanban,
  Server,
  Activity,
  Settings2,
  ChevronLeft,
  Layers3,
  ChevronRight,
  Package,
  Globe,
  HardDrive,
  Database,
  History,
} from '@lucide/vue';
import { api } from '@/lib/api';
import { useCollection } from '@/lib/query';
import type { Project, Environment } from '@/lib/types';
import type { Service } from '@/components/services/types';
const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? ''));
const projectPath = computed(() => `/projects/${projectId.value}`);
const isProjectRoot = computed(() => route.path === projectPath.value);
const serviceId = computed(() => String(route.params.serviceId ?? ''));
const service = useQuery({
  queryKey: computed(() => ['service', serviceId.value]),
  enabled: computed(() => !!serviceId.value),
  queryFn: ({ queryKey, signal }) => api.get<Service>(`/services/${queryKey[1]}`, signal),
});
const project = useQuery({
  queryKey: computed(() => ['project', projectId.value]),
  enabled: computed(() => !!projectId.value),
  queryFn: ({ signal }) => api.get<Project>(`/projects/${projectId.value}`, signal),
});
const environments = useCollection<Environment>(
  '/environments',
  computed(() => ({ projectId: projectId.value })),
  computed(() => !!projectId.value),
);
const selectId = useId();
const environmentSlug = computed(() => {
  if (serviceId.value && service.data.value?.projectId === projectId.value)
    return service.data.value.environment.slug;
  if (typeof route.query.environment === 'string') return route.query.environment;
  return serviceId.value ? '' : 'production';
});
const selectedEnvironment = computed(() =>
  environments.items.value.find((environment) => environment.slug === environmentSlug.value),
);
const nav = [
  { to: '/projects', label: '项目', icon: FolderKanban },
  { to: '/services', label: '服务', icon: Package },
  { to: '/templates', label: '服务模板', icon: Layers3 },
  { to: '/databases', label: '数据库', icon: Database },
  { to: '/volumes', label: '持久卷', icon: HardDrive },
  { to: '/domains', label: '域名与网络', icon: Globe },
  { to: '/infrastructure', label: '基础设施', icon: Server },
  { to: '/deployments', label: '部署与 Git 事件', icon: History },
  { to: '/operations', label: '操作任务', icon: Activity },
  { to: '/settings', label: '设置与凭证', icon: Settings2 },
];
function active(path: string) {
  if (path === '/deployments' && route.path.startsWith('/webhook-deliveries/')) return true;
  if (path === '/infrastructure')
    return ['/infrastructure', '/clusters', '/servers'].some((prefix) =>
      route.path.startsWith(prefix),
    );
  return route.path.startsWith(path);
}
async function changeEnvironment(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  try {
    await router.push({
      path: projectPath.value,
      query: isProjectRoot.value ? { ...route.query, environment: value } : { environment: value },
    });
  } finally {
    (event.target as HTMLSelectElement).value = environmentSlug.value;
  }
}
</script>
<template>
  <div class="nav-content">
    <template v-if="projectId">
      <RouterLink to="/projects" class="back-link"
        ><ChevronLeft class="size-4" />返回项目列表</RouterLink
      >
      <div v-if="project.data.value" class="project-context">
        <div class="project-mark">{{ project.data.value.name.slice(0, 1).toUpperCase() }}</div>
        <h2 class="break-words">{{ project.data.value.name }}</h2>
        <RouterLink :to="`/clusters/${project.data.value.clusterId}`" class="context-cluster"
          ><Layers3 class="size-3.5" /><span>{{
            project.data.value.cluster?.name ?? project.data.value.clusterId
          }}</span
          ><ChevronRight class="size-3.5"
        /></RouterLink>
        <label :for="selectId" class="meta mt-6 block">当前环境</label>
        <select
          :id="selectId"
          :value="environmentSlug"
          class="input mt-2"
          :disabled="!environments.items.value.length"
          @change="changeEnvironment"
        >
          <option v-if="!selectedEnvironment" :value="environmentSlug" disabled>
            {{ environmentSlug || '正在载入服务环境…' }}
          </option>
          <option
            v-for="environment in environments.items.value"
            :key="environment.id"
            :value="environment.slug"
          >
            {{ environment.name }} · {{ environment.slug }}
          </option>
        </select>
        <button
          v-if="environments.hasNextPage.value"
          class="text-link mt-2 text-xs"
          :disabled="environments.isFetchingNextPage.value"
          @click="environments.fetchNextPage()"
        >
          载入更多环境
        </button>
      </div>
      <div v-else class="space-y-3 p-4">
        <div class="skeleton h-8" />
        <div class="skeleton h-20" />
      </div>
      <nav aria-label="项目导航" class="nav-links">
        <RouterLink
          :to="{ path: `/projects/${projectId}`, query: { environment: environmentSlug } }"
          class="nav-item"
          :aria-current="
            !isProjectRoot || !['environments', 'settings'].includes(String(route.query.tab ?? ''))
              ? 'page'
              : undefined
          "
          ><Package />项目服务</RouterLink
        >
        <RouterLink
          :to="{
            path: `/projects/${projectId}`,
            query: { environment: environmentSlug, tab: 'environments' },
          }"
          class="nav-item"
          :aria-current="isProjectRoot && route.query.tab === 'environments' ? 'page' : undefined"
          ><Layers3 />环境</RouterLink
        >
        <RouterLink
          :to="{
            path: `/projects/${projectId}`,
            query: { environment: environmentSlug, tab: 'settings' },
          }"
          class="nav-item"
          :aria-current="isProjectRoot && route.query.tab === 'settings' ? 'page' : undefined"
          ><Settings2 />项目设置</RouterLink
        >
      </nav>
      <p class="context-note">环境继承项目的固定集群</p>
      <div class="nav-divider" />
    </template>
    <p class="nav-label">{{ projectId ? '工作台' : '个人工作台' }}</p>
    <nav aria-label="主导航" class="nav-links">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :aria-current="!projectId && active(item.to) ? 'page' : undefined"
        ><component :is="item.icon" />{{ item.label }}</RouterLink
      >
    </nav>
  </div>
</template>
<style scoped>
.nav-content {
  padding: 1.5rem 0.875rem;
}
.nav-label {
  font-size: 0.75rem;
  color: var(--muted-foreground);
  margin: 0 0.75rem 0.75rem;
}
.nav-links {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  border-radius: 0.5rem;
  color: var(--muted-foreground);
}
.nav-item svg {
  width: 1.125rem;
  height: 1.125rem;
}
.nav-item:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.nav-item[aria-current='page'] {
  background: var(--accent);
  color: var(--primary);
  font-weight: 550;
}
.back-link {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  padding: 0.5rem;
}
.project-context {
  padding: 1.25rem 0.625rem 1.5rem;
}
.project-mark {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  background: var(--accent);
  color: var(--primary);
  border-radius: 0.625rem;
  font-weight: 650;
  margin-bottom: 0.75rem;
}
.context-cluster {
  display: flex;
  gap: 0.375rem;
  align-items: center;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  margin-top: 0.5rem;
}
.context-cluster span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.context-note {
  margin: 1rem 0.75rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
.nav-divider {
  height: 1px;
  background: var(--border);
  margin: 1.5rem 0.75rem;
}
</style>
