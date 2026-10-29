<script setup lang="ts">
import { computed, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  FolderKanban,
  Server,
  Settings2,
  ChevronLeft,
  Layers3,
  ChevronRight,
  Package,
  Plus,
  Link2,
} from '@lucide/vue';
import { api } from '@/lib/api';
import { useCollection } from '@/lib/query';
import { useProjectEnvironments } from '@/composables/useProjectEnvironments';
import { creationStepQuery } from '@/composables/useCreationDialogState';
import { useAuthStore } from '@/stores/auth';
import ServiceRuntimeBadge from '@/components/services/ServiceRuntimeBadge.vue';
import { serviceLocation } from '@/components/services/presentation';
import type { Project } from '@/lib/types';
import type { Service } from '@/components/services/types';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
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
const selectId = useId();
const environmentSlug = computed(() => {
  if (serviceId.value && service.data.value?.projectId === projectId.value)
    return service.data.value.environment.slug;
  if (route.query.environment != null)
    return typeof route.query.environment === 'string' ? route.query.environment : '';
  return serviceId.value ? '' : 'production';
});
const environments = useProjectEnvironments(projectId, environmentSlug);
const selectedEnvironment = environments.currentEnvironment;
const services = useCollection<Service>(
  '/services',
  computed(() => ({
    projectId: projectId.value,
    environmentId: selectedEnvironment.value?.id ?? '',
  })),
  computed(() => !!project.data.value && !!selectedEnvironment.value),
  { refetchInterval: 15_000 },
);
const createLocation = computed(() => ({
  path: route.path,
  query: creationStepQuery(route.query, {
    environment: environmentSlug.value,
  }),
}));
const nav = [
  { to: '/projects', label: '项目', icon: FolderKanban },
  { to: '/infrastructure', label: '服务器', icon: Server },
  { to: '/settings', label: '设置', icon: Settings2 },
];
function active(path: string) {
  if (path === '/settings')
    return [
      '/settings',
      '/services',
      '/templates',
      '/databases',
      '/volumes',
      '/domains',
      '/deployments',
      '/webhook-deliveries',
      '/operations',
    ].some((prefix) => route.path.startsWith(prefix));
  if (path === '/infrastructure')
    return ['/infrastructure', '/clusters', '/servers'].some((prefix) =>
      route.path.startsWith(prefix),
    );
  return route.path.startsWith(path);
}
async function changeEnvironment(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (!environments.items.value.some((item) => item.slug === value)) return;
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
        ><ChevronLeft class="size-4" />所有项目</RouterLink
      >
      <div v-if="project.data.value" class="project-context">
        <h2 class="break-words">{{ project.data.value.name }}</h2>
        <RouterLink :to="`/clusters/${project.data.value.clusterId}`" class="context-cluster"
          ><Layers3 class="size-3.5" /><span>{{
            project.data.value.cluster?.name ?? project.data.value.clusterId
          }}</span
          ><ChevronRight class="size-3.5"
        /></RouterLink>
        <template v-if="environments.showEnvironmentControl.value">
          <label :for="selectId" class="meta mt-5 block">环境</label>
          <select
            :id="selectId"
            :value="environmentSlug"
            class="input mt-2"
            :disabled="environments.isResolving.value || !environments.items.value.length"
            @change="changeEnvironment"
          >
            <option v-if="!selectedEnvironment" :value="environmentSlug" disabled>
              {{ environments.isResolving.value ? '正在载入…' : environmentSlug || '环境不可用' }}
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
            v-if="environments.error.value"
            class="text-link mt-2 text-xs"
            @click="environments.refetch()"
          >
            重新载入环境
          </button>
          <button
            v-if="environments.hasNextPage.value"
            class="text-link mt-2 text-xs"
            :disabled="environments.isFetchingNextPage.value"
            @click="environments.fetchNextPage()"
          >
            载入更多环境
          </button>
        </template>
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
            isProjectRoot && (!route.query.tab || route.query.tab === 'overview')
              ? 'page'
              : undefined
          "
          ><Package />服务总览</RouterLink
        >
        <RouterLink
          :to="{
            path: `/projects/${projectId}`,
            query: { environment: environmentSlug, tab: 'integrations' },
          }"
          class="nav-item"
          :aria-current="isProjectRoot && route.query.tab === 'integrations' ? 'page' : undefined"
          ><Link2 />整合</RouterLink
        >
        <RouterLink
          :to="{
            path: `/projects/${projectId}`,
            query: { environment: environmentSlug, tab: 'settings' },
          }"
          class="nav-item"
          :aria-current="
            isProjectRoot && ['settings', 'environments'].includes(String(route.query.tab))
              ? 'page'
              : undefined
          "
          ><Settings2 />项目设置</RouterLink
        >
        <RouterLink
          v-if="selectedEnvironment && !auth.restoreMode"
          :to="createLocation"
          class="nav-item"
          :aria-current="route.query.createService === '1' ? 'page' : undefined"
          ><Plus />添加服务</RouterLink
        >
      </nav>
      <p class="nav-label mt-7">服务</p>
      <nav v-if="selectedEnvironment" aria-label="项目服务" class="nav-links">
        <div v-if="services.isPending.value" class="space-y-2 px-3">
          <div class="skeleton h-9" />
          <div class="skeleton h-9" />
        </div>
        <RouterLink
          v-for="item in services.items.value"
          :key="item.id"
          :to="serviceLocation(item)"
          class="nav-item service-link"
          :aria-current="serviceId === item.id ? 'page' : undefined"
          ><Package /><span class="service-name" :title="item.name">{{ item.name }}</span
          ><ServiceRuntimeBadge :service="item" compact
        /></RouterLink>
        <p
          v-if="!services.isPending.value && !services.items.value.length && !services.error.value"
          class="nav-empty"
        >
          添加首个服务后，会显示在这里。
        </p>
        <button
          v-if="services.error.value"
          class="text-link px-3 py-2 text-sm"
          @click="services.refetch()"
        >
          重新载入服务
        </button>
        <button
          v-else-if="services.hasNextPage.value"
          class="text-link px-3 py-2 text-sm"
          :disabled="services.isFetchingNextPage.value"
          @click="services.fetchNextPage()"
        >
          载入更多服务
        </button>
      </nav>
      <p v-else-if="!environments.isResolving.value" class="nav-empty">
        核对环境后可查看所属服务。
      </p>
    </template>
    <nav v-else aria-label="主导航" class="nav-links">
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
  flex-shrink: 0;
}
.service-link {
  gap: 0.5rem;
}
.service-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-empty {
  padding: 0.5rem 0.75rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  line-height: 1.6;
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
