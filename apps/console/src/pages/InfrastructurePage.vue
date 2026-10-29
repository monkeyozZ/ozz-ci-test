<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Server as ServerIcon, Layers3, Plus, Search, ChevronRight, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { dateTime } from '@/lib/utils';
import type { Server, Cluster } from '@/lib/types';
const route = useRoute();
const auth = useAuthStore();
const tab = computed(() => (route.query.tab === 'servers' ? 'servers' : 'clusters'));
const clusters = useCollection<Cluster>('/clusters');
const servers = useCollection<Server>('/servers');
const query = computed(() => (tab.value === 'clusters' ? clusters : servers));
const search = ref('');
const visibleClusters = computed(() =>
  clusters.items.value.filter((item) =>
    `${item.name} ${item.slug} ${item.region ?? ''}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const visibleServers = computed(() =>
  servers.items.value.filter((item) =>
    `${item.name} ${item.host} ${item.region ?? ''}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
</script>
<template>
  <div class="page-head">
    <div>
      <h1>基础设施</h1>
      <p>管理承载项目的集群，以及服务器连接资料。</p>
    </div>
    <div v-if="!auth.restoreMode" class="actions">
      <Button as-child variant="outline"
        ><RouterLink to="/servers/new"><ServerIcon />登记服务器</RouterLink></Button
      ><Button as-child
        ><RouterLink to="/clusters/new"><Plus />登记集群</RouterLink></Button
      >
    </div>
  </div>
  <nav class="page-tabs" aria-label="基础设施类型">
    <RouterLink
      to="/infrastructure"
      class="page-tab"
      :aria-current="tab === 'clusters' ? 'page' : undefined"
      >集群 <span class="badge ml-1">{{ clusters.items.value.length }}</span></RouterLink
    ><RouterLink
      to="/infrastructure?tab=servers"
      class="page-tab"
      :aria-current="tab === 'servers' ? 'page' : undefined"
      >服务器 <span class="badge ml-1">{{ servers.items.value.length }}</span></RouterLink
    >
  </nav>
  <div class="mb-5 flex items-center justify-between gap-3">
    <div class="relative w-full max-w-sm">
      <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
        v-model="search"
        class="pl-10"
        :aria-label="tab === 'clusters' ? '搜索已载入集群' : '搜索已载入服务器'"
        placeholder="搜索已载入的名称、地区或地址"
      />
    </div>
    <Button
      variant="outline"
      size="icon"
      aria-label="刷新基础设施"
      :disabled="query.isFetching.value"
      @click="query.refetch()"
      ><RefreshCw
    /></Button>
  </div>
  <QueryState
    :pending="query.isPending.value"
    :error="query.error.value"
    :refreshing="query.isRefetching.value"
    @retry="query.refetch()"
  >
    <template v-if="tab === 'clusters'">
      <div v-if="visibleClusters.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>集群</th>
              <th class="mobile-hide">地区</th>
              <th>关联项目</th>
              <th>连接状态</th>
              <th class="mobile-hide">最近观察</th>
              <th><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cluster in visibleClusters" :key="cluster.id">
              <td>
                <RouterLink :to="`/clusters/${cluster.id}`" class="font-medium text-link">{{
                  cluster.name
                }}</RouterLink>
                <p class="mono muted mt-1">{{ cluster.slug }}</p>
              </td>
              <td class="mobile-hide">{{ cluster.region || '尚未填写' }}</td>
              <td>{{ cluster.projectCount ?? '—' }}</td>
              <td>
                <StatusBadge
                  :status="cluster.connectionStatus"
                  :observed-at="cluster.lastObservedAt"
                />
              </td>
              <td class="meta mobile-hide">{{ dateTime(cluster.lastObservedAt) }}</td>
              <td>
                <Button as-child variant="ghost" size="icon"
                  ><RouterLink
                    :to="`/clusters/${cluster.id}`"
                    :aria-label="`查看集群 ${cluster.name}`"
                    ><ChevronRight /></RouterLink
                ></Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!clusters.error.value" class="panel">
        <EmptyState
          :icon="Layers3"
          :title="search ? '没有匹配的集群' : '登记第一个集群'"
          :description="
            search
              ? '调整关键词，或继续载入其他记录。'
              : '项目将固定绑定到一个已登记的集群。登记资料与连接验证分别进行。'
          "
          ><Button v-if="search" variant="outline" @click="search = ''">清空搜索</Button
          ><Button v-else-if="!auth.restoreMode" as-child
            ><RouterLink to="/clusters/new"><Plus />登记集群</RouterLink></Button
          ></EmptyState
        >
      </div>
    </template>
    <template v-else>
      <div v-if="visibleServers.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>服务器</th>
              <th>连接地址</th>
              <th class="mobile-hide">SSH 身份</th>
              <th>连接状态</th>
              <th class="mobile-hide">最近预检</th>
              <th><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="server in visibleServers" :key="server.id">
              <td>
                <RouterLink :to="`/servers/${server.id}`" class="font-medium text-link">{{
                  server.name
                }}</RouterLink>
                <p class="meta mt-1">{{ server.region || '尚未填写地区' }}</p>
              </td>
              <td>
                <code>{{ server.host }}</code>
                <p class="meta">SSH {{ server.sshPort }}</p>
              </td>
              <td class="mobile-hide">
                <code>{{ server.sshUser }}</code>
                <p class="meta">{{ server.credentialRefId ? '已选择凭证引用' : '尚未选择凭证' }}</p>
              </td>
              <td><StatusBadge :status="server.connectionStatus" /></td>
              <td class="meta mobile-hide">{{ dateTime(server.lastObservedAt) }}</td>
              <td>
                <Button as-child variant="ghost" size="icon"
                  ><RouterLink
                    :to="`/servers/${server.id}`"
                    :aria-label="`查看服务器 ${server.name}`"
                    ><ChevronRight /></RouterLink
                ></Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!servers.error.value" class="panel">
        <EmptyState
          :icon="ServerIcon"
          :title="search ? '没有匹配的服务器' : '登记服务器连接资料'"
          :description="
            search
              ? '调整关键词，或继续载入其他记录。'
              : '保存主机地址、SSH 用户及凭证引用，为后续接入准备基础资料。'
          "
          ><Button v-if="search" variant="outline" @click="search = ''">清空搜索</Button
          ><Button v-else-if="!auth.restoreMode" as-child
            ><RouterLink to="/servers/new"><Plus />登记服务器</RouterLink></Button
          ></EmptyState
        >
      </div>
    </template>
    <div v-if="query.hasNextPage.value" class="mt-6 text-center">
      <Button
        variant="outline"
        :disabled="query.isFetchingNextPage.value"
        @click="query.fetchNextPage()"
        >{{ query.isFetchingNextPage.value ? '正在载入…' : '载入更多记录' }}</Button
      >
    </div>
  </QueryState>
</template>
