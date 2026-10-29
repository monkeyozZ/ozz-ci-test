<script setup lang="ts">
import { FolderKanban, Plus } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import type { Project, Cluster } from '@/lib/types';
import ServiceCollection from '@/components/services/ServiceCollection.vue';
import { useRouteFilter } from '@/composables/useRouteFilter';
const auth = useAuthStore();
const projectId = useRouteFilter('projectId');
const clusterId = useRouteFilter('clusterId');
const projects = useCollection<Project>('/projects');
const clusters = useCollection<Cluster>('/clusters');
</script>
<template>
  <div class="page-head">
    <div>
      <h1>服务</h1>
      <p>汇总所有项目中的服务，配置与发布在所属项目中完成。</p>
    </div>
    <Button v-if="!auth.restoreMode" as-child
      ><RouterLink to="/projects"><Plus />选择项目添加服务</RouterLink></Button
    >
  </div>
  <div class="flex flex-wrap gap-4 mb-6">
    <div class="field min-w-48 flex-1 max-w-sm">
      <label for="services-project">所属项目</label
      ><select
        id="services-project"
        v-model="projectId"
        class="input"
        :disabled="projects.isPending.value"
      >
        <option value="">{{ projects.isPending.value ? '正在载入项目…' : '全部项目' }}</option>
        <option
          v-if="projectId && !projects.items.value.some((item) => item.id === projectId)"
          :value="projectId"
        >
          当前项目 · {{ projectId }}
        </option>
        <option v-for="project in projects.items.value" :key="project.id" :value="project.id">
          {{ project.name }}
        </option>
      </select>
      <p v-if="projects.error.value" class="field-error">
        项目选项未能更新。<button
          type="button"
          class="text-link"
          :disabled="projects.isFetching.value"
          @click="projects.refetch()"
        >
          {{ projects.isFetching.value ? '正在重试…' : '重新载入' }}
        </button>
      </p>
      <Button
        v-if="projects.hasNextPage.value"
        variant="ghost"
        :disabled="projects.isFetchingNextPage.value"
        @click="projects.fetchNextPage()"
        >载入更多项目</Button
      >
    </div>
    <div class="field min-w-48 flex-1 max-w-sm">
      <label for="services-cluster">承载集群</label
      ><select
        id="services-cluster"
        v-model="clusterId"
        class="input"
        :disabled="clusters.isPending.value"
      >
        <option value="">{{ clusters.isPending.value ? '正在载入集群…' : '全部集群' }}</option>
        <option
          v-if="clusterId && !clusters.items.value.some((item) => item.id === clusterId)"
          :value="clusterId"
        >
          当前集群 · {{ clusterId }}
        </option>
        <option v-for="cluster in clusters.items.value" :key="cluster.id" :value="cluster.id">
          {{ cluster.name }}
        </option>
      </select>
      <p v-if="clusters.error.value" class="field-error">
        集群选项未能更新。<button
          type="button"
          class="text-link"
          :disabled="clusters.isFetching.value"
          @click="clusters.refetch()"
        >
          {{ clusters.isFetching.value ? '正在重试…' : '重新载入' }}
        </button>
      </p>
      <Button
        v-if="clusters.hasNextPage.value"
        variant="ghost"
        :disabled="clusters.isFetchingNextPage.value"
        @click="clusters.fetchNextPage()"
        >载入更多集群</Button
      >
    </div>
  </div>
  <ServiceCollection :project-id="projectId" :cluster-id="clusterId" show-context />
  <p class="meta mt-4 flex items-center gap-2">
    <FolderKanban class="size-4" />服务始终属于一个项目环境，并继承该项目的集群。
  </p>
</template>
