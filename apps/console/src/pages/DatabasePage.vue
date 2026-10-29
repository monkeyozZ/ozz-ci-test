<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { ChevronRight, RefreshCw, ArrowRight, AlertCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import DatabaseIdentity from '@/components/storage/DatabaseIdentity.vue';
import StorageTarget from '@/components/storage/StorageTarget.vue';
import type { Database } from '@/components/storage/types';
import type { Project, Environment } from '@/lib/types';
import { api } from '@/lib/api';
const route = useRoute();
const databaseId = String(route.params.databaseId);
const database = useQuery({
  queryKey: ['database', databaseId],
  queryFn: ({ signal }) => api.get<Database>(`/databases/${databaseId}`, signal),
  refetchInterval: 10_000,
});
const project = useQuery({
  queryKey: computed(() => ['project', database.data.value?.projectId]),
  enabled: computed(() => !!database.data.value),
  queryFn: ({ queryKey, signal }) => api.get<Project>(`/projects/${queryKey[1]}`, signal),
});
const environment = useQuery({
  queryKey: computed(() => ['environment', database.data.value?.environmentId]),
  enabled: computed(() => !!database.data.value),
  queryFn: ({ queryKey, signal }) => api.get<Environment>(`/environments/${queryKey[1]}`, signal),
});
const context = computed(() =>
  project.data.value && environment.data.value
    ? {
        project: project.data.value,
        environment: environment.data.value,
        cluster: project.data.value.cluster,
      }
    : null,
);
</script>
<template>
  <QueryState
    :pending="database.isPending.value"
    :error="database.error.value"
    @retry="database.refetch()"
    ><template v-if="database.data.value">
      <nav class="breadcrumbs" aria-label="面包屑">
        <RouterLink to="/databases" class="text-link">数据库</RouterLink><ChevronRight /><span>{{
          database.data.value.service?.name ?? database.data.value.originalService.name
        }}</span>
      </nav>
      <div class="page-head">
        <div>
          <h1>
            {{ database.data.value.service?.name ?? database.data.value.originalService.name }}
          </h1>
          <p>数据库连接、真实认证观察与数据身份保护。</p>
        </div>
        <Button
          type="button"
          variant="outline"
          :disabled="database.isFetching.value"
          @click="database.refetch()"
          ><RefreshCw />刷新检查</Button
        >
      </div>
      <StorageTarget v-if="context" :context="context" class="mb-6" />
      <div
        v-else-if="project.error.value || environment.error.value"
        class="notice notice-warning mb-6"
      >
        <AlertCircle />
        <p>部分归属资料当前不可读取，保留的数据库身份仍可查看。</p>
      </div>
      <DatabaseIdentity :database="database.data.value" />
      <section class="panel mt-6" data-database-consumers>
        <div class="section-head">
          <div>
            <h2>使用此数据库的应用</h2>
            <p class="meta mt-2">连接草稿、已发布引用与在途部署分别保留</p>
          </div>
          <Button v-if="database.data.value.service" as-child variant="outline"
            ><RouterLink
              :to="{
                path: '/services',
                query: {
                  projectId: database.data.value.projectId,
                  environmentId: database.data.value.environmentId,
                },
              }"
              >选择同环境应用<ArrowRight /></RouterLink
          ></Button>
        </div>
        <div v-if="database.data.value.consumersTruncated" class="notice notice-warning mb-5">
          <AlertCircle />
          <p>这里只展示部分消费者。删除提供方前会重新检查完整依赖。</p>
        </div>
        <ul v-if="database.data.value.consumers.length" class="database-consumers">
          <li v-for="consumer in database.data.value.consumers" :key="consumer.serviceId">
            <RouterLink
              :to="{
                path: `/projects/${database.data.value.projectId}/services/${consumer.serviceId}`,
                query: { tab: 'storage' },
              }"
              class="text-link font-medium"
              >{{ consumer.name }}</RouterLink
            >
            <div class="flex gap-2 flex-wrap mt-2">
              <span v-if="consumer.desired" class="badge">草稿引用</span
              ><span v-if="consumer.published" class="badge badge-primary">已发布引用</span
              ><span v-if="consumer.inFlight" class="badge badge-warning">部署在途</span>
            </div>
          </li>
        </ul>
        <p v-else class="meta">当前返回的记录中没有消费者。</p>
        <p class="field-hint mt-5">
          在应用的数据与存储页选择同项目、同环境的数据库，审阅变量映射并保存草稿，发布应用后才会注入凭证。
        </p>
      </section>
      <section class="panel mt-6">
        <h2>手工备份与恢复</h2>
        <p class="text-sm mt-3">
          在数据卷下查看指引、进入维护并登记操作证据。恢复到新卷后，核对真实数据，再决定消费者与流量切换。
        </p>
        <Button as-child variant="outline" class="mt-5"
          ><RouterLink
            :to="{
              path: `/volumes/${database.data.value.dataVolume.id}`,
              query: { tab: 'manual' },
            }"
            >打开手工数据指引<ArrowRight /></RouterLink
        ></Button>
      </section> </template
  ></QueryState>
</template>
<style scoped>
.database-consumers {
  display: grid;
  gap: 1rem;
}
.database-consumers li {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
</style>
