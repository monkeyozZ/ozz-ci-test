<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import IntegrationConnections from './IntegrationConnections.vue';
import { useActiveTabVisibility } from '@/composables/useActiveTabVisibility';
const route = useRoute();
const items = [
  { id: 'github', label: 'GitHub 授权' },
  { id: 'registries', label: 'Registry 推送与拉取' },
  { id: 'builders', label: '独立 Builder' },
] as const;
const kind = computed(
  () => items.find((item) => item.id === route.query.integration)?.id ?? 'github',
);
const navigation = useActiveTabVisibility(kind);
</script>
<template>
  <nav ref="navigation" class="page-tabs" aria-label="Git 与构建集成">
    <RouterLink
      v-for="item in items"
      :key="item.id"
      class="page-tab"
      :to="{ path: '/settings', query: { tab: 'git', integration: item.id } }"
      :aria-current="kind === item.id ? 'page' : undefined"
      >{{ item.label }}</RouterLink
    >
  </nav>
  <IntegrationConnections :key="kind" :kind="kind" />
</template>
