<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { creationStepQuery } from '@/composables/useCreationDialogState';
import { Package, Plus, RefreshCw, Search, ArrowUpRight, Activity } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { dateTime } from '@/lib/utils';
import ServiceRuntimeBadge from './ServiceRuntimeBadge.vue';
import { configurationLabels, serviceLocation, taskLocation } from './presentation';
import type { Service } from './types';
import { serviceSourceLabel } from '@/components/git/presentation';
const props = withDefaults(
  defineProps<{
    projectId?: string;
    environmentId?: string;
    environmentSlug?: string;
    clusterId?: string;
    heading?: string;
    showContext?: boolean;
  }>(),
  { heading: '服务', showContext: false },
);
const auth = useAuthStore();
const route = useRoute();
const search = ref('');
const filters = computed(() => ({
  ...(props.projectId ? { projectId: props.projectId } : {}),
  ...(props.environmentId ? { environmentId: props.environmentId } : {}),
  ...(props.clusterId ? { clusterId: props.clusterId } : {}),
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const collection = useCollection<Service>('/services', filters, true, { refetchInterval: 15_000 });
const createLocation = computed(() =>
  props.projectId && props.environmentId && props.environmentSlug
    ? {
        path:
          route.params.projectId === props.projectId ? route.path : `/projects/${props.projectId}`,
        query: creationStepQuery(route.params.projectId === props.projectId ? route.query : {}, {
          environment: props.environmentSlug,
        }),
      }
    : null,
);
</script>
<template>
  <section class="panel service-collection" data-service-collection>
    <div class="section-head">
      <div>
        <h2>{{ heading }}</h2>
        <p v-if="collection.items.value.length" class="meta mt-1">
          已载入 {{ collection.items.value.length }} 个服务
        </p>
      </div>
      <div class="actions">
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新服务列表"
          :disabled="collection.isFetching.value"
          @click="collection.refetch()"
          ><RefreshCw /></Button
        ><Button
          v-if="createLocation && !auth.restoreMode && (collection.items.value.length || search)"
          as-child
          ><RouterLink :to="createLocation"><Plus />添加服务</RouterLink></Button
        >
      </div>
    </div>
    <div v-if="collection.items.value.length || search" class="relative max-w-md mb-5">
      <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
        v-model="search"
        class="pl-10"
        aria-label="搜索服务"
        placeholder="搜索服务名称或标识"
      />
    </div>
    <QueryState
      :pending="collection.isPending.value"
      :error="collection.error.value"
      @retry="collection.refetch()"
    >
      <div v-if="collection.items.value.length" class="service-list">
        <article
          v-for="service in collection.items.value"
          :key="service.id"
          class="service-row"
          :data-service-id="service.id"
        >
          <div class="service-identity">
            <span class="service-icon"><Package /></span>
            <div class="min-w-0">
              <RouterLink :to="serviceLocation(service)" class="service-name text-link">{{
                service.name
              }}</RouterLink>
              <p v-if="showContext" class="meta mt-1">
                {{ service.project.name }} / {{ service.environment.name }} ·
                {{ service.cluster.name }}
              </p>
              <p class="meta mono mt-1 truncate" :title="serviceSourceLabel(service)">
                {{ serviceSourceLabel(service) }}
              </p>
            </div>
          </div>
          <div class="service-observation">
            <ServiceRuntimeBadge :service="service" />
            <p class="meta mt-2">
              {{
                service.lastObservedAt
                  ? `观察于 ${dateTime(service.lastObservedAt)}`
                  : '尚无运行观察'
              }}
            </p>
          </div>
          <div class="service-draft">
            <span
              v-if="
                service.configurationState === 'partial' || service.configurationState === 'drifted'
              "
              class="badge badge-danger"
              >{{ configurationLabels[service.configurationState] }}</span
            ><span v-else-if="service.hasUnpublishedChanges" class="badge badge-warning"
              >草稿 r{{ service.configRevision }} 待发布</span
            ><span v-else class="meta">{{ configurationLabels[service.configurationState] }}</span>
            <p v-if="service.activeTask" class="mt-2">
              <RouterLink
                :to="taskLocation(service.activeTask)"
                class="text-link inline-flex items-center gap-1 text-sm"
                ><Activity class="size-3.5" />{{
                  service.activeTask.type === 'deployment' ? '查看部署任务' : '查看操作任务'
                }}</RouterLink
              >
            </p>
          </div>
          <RouterLink
            :to="serviceLocation(service)"
            class="text-link service-open"
            :aria-label="`打开服务 ${service.name}`"
            >打开服务<ArrowUpRight class="size-4"
          /></RouterLink>
        </article>
      </div>
      <EmptyState
        v-else
        :icon="Package"
        :title="search ? '没有匹配的服务' : '添加第一个服务'"
        :description="search ? '试试其他名称或标识。' : '从 GitHub、Docker 镜像或模板开始。'"
        ><Button v-if="createLocation && !auth.restoreMode && !search" as-child
          ><RouterLink :to="createLocation"><Plus />添加服务</RouterLink></Button
        ></EmptyState
      >
      <Button
        v-if="collection.hasNextPage.value"
        variant="outline"
        class="mt-5"
        :disabled="collection.isFetchingNextPage.value"
        @click="collection.fetchNextPage()"
        >{{ collection.isFetchingNextPage.value ? '正在载入…' : '载入更多服务' }}</Button
      >
    </QueryState>
  </section>
</template>
<style scoped>
.service-row {
  display: grid;
  grid-template-columns: minmax(12rem, 1.5fr) minmax(9rem, 1fr) minmax(9rem, 1fr) auto;
  gap: 1.25rem;
  align-items: center;
  padding: 1.5rem 0;
  border-top: 1px solid var(--border);
}
.service-row:first-child {
  border-top: 0;
  padding-top: 0.5rem;
}
.service-identity {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  min-width: 0;
}
.service-icon {
  display: grid;
  place-items: center;
  background: var(--secondary);
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.5rem;
  flex-shrink: 0;
}
.service-icon svg {
  width: 1.2rem;
  height: 1.2rem;
  color: var(--muted-foreground);
}
.service-name {
  font-size: 1rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.service-open {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  white-space: nowrap;
}
@media (max-width: 1250px) {
  .service-row {
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
  }
  .service-draft {
    padding-left: 3.375rem;
  }
  .service-open {
    justify-self: end;
  }
}
@media (max-width: 639px) {
  .service-row {
    gap: 1rem;
  }
  .service-identity {
    grid-column: 1/-1;
  }
  .service-draft {
    padding-left: 0;
  }
  .service-observation {
    grid-column: 1;
  }
  .service-open {
    grid-column: 2;
    grid-row: 3;
  }
  .service-draft {
    grid-column: 1;
    grid-row: 3;
  }
}
</style>
