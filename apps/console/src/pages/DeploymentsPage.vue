<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Button } from '@/components/ui/button';
import MutationError from '@/components/MutationError.vue';
import DeploymentCollection from '@/components/services/DeploymentCollection.vue';
import WebhookDeliveries from '@/components/git/WebhookDeliveries.vue';
import { useCollection } from '@/lib/query';
import type { Environment, Project } from '@/lib/types';
const route = useRoute();
const showEvents = computed(() => route.query.tab === 'events');
const projectId = ref(typeof route.query.projectId === 'string' ? route.query.projectId : '');
const environmentId = ref(
  typeof route.query.environmentId === 'string' ? route.query.environmentId : '',
);
const projects = useCollection<Project>('/projects');
const environments = useCollection<Environment>(
  '/environments',
  () => ({ projectId: projectId.value }),
  () => !!projectId.value,
);
</script>
<template>
  <div class="page-head">
    <div>
      <h1>部署与 Git 事件</h1>
      <p>查看持久发布记录、事件收件和每个服务的投递结果。</p>
    </div>
    <Button as-child variant="outline"
      ><RouterLink to="/settings?tab=git">Git 与构建设置</RouterLink></Button
    >
  </div>
  <nav class="page-tabs" aria-label="交付记录">
    <RouterLink to="/deployments" class="page-tab" :aria-current="!showEvents ? 'page' : undefined"
      >发布记录</RouterLink
    >
    <RouterLink to="/operations" class="page-tab">资源操作</RouterLink>
    <RouterLink
      to="/deployments?tab=events"
      class="page-tab"
      :aria-current="showEvents ? 'page' : undefined"
      >Git 事件</RouterLink
    >
  </nav>
  <WebhookDeliveries v-if="showEvents" />
  <template v-else>
    <div class="form-grid mb-5">
      <div class="field">
        <label for="deployment-project">项目</label>
        <select
          id="deployment-project"
          v-model="projectId"
          class="input"
          @change="environmentId = ''"
        >
          <option value="">全部项目</option>
          <option v-for="project in projects.items.value" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
        <MutationError :error="projects.error.value" />
        <Button v-if="projects.error.value" variant="ghost" @click="projects.refetch()"
          >重新读取项目</Button
        >
        <Button v-if="projects.hasNextPage.value" variant="ghost" @click="projects.fetchNextPage()"
          >载入更多项目</Button
        >
      </div>
      <div class="field">
        <label for="deployment-environment">环境</label>
        <select
          id="deployment-environment"
          v-model="environmentId"
          class="input"
          :disabled="!projectId"
        >
          <option value="">全部环境</option>
          <option
            v-for="environment in environments.items.value"
            :key="environment.id"
            :value="environment.id"
          >
            {{ environment.name }}
          </option>
        </select>
        <MutationError :error="environments.error.value" />
        <Button v-if="environments.error.value" variant="ghost" @click="environments.refetch()"
          >重新读取环境</Button
        >
        <Button
          v-if="environments.hasNextPage.value"
          variant="ghost"
          @click="environments.fetchNextPage()"
          >载入更多环境</Button
        >
      </div>
    </div>
    <DeploymentCollection
      :project-id="projectId || undefined"
      :environment-id="environmentId || undefined"
    />
  </template>
</template>
