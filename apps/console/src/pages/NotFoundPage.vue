<script setup lang="ts">
import { FolderSearch } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import EmptyState from '@/components/EmptyState.vue';
</script>
<template>
  <div class="panel">
    <EmptyState
      :icon="FolderSearch"
      title="找不到这个页面"
      description="链接可能已失效。可以返回项目列表，重新选择资源。"
      ><Button as-child><RouterLink to="/projects">返回项目列表</RouterLink></Button></EmptyState
    >
  </div>
</template>
