<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ImageServiceCreatePage from './ImageServiceCreatePage.vue';
import TemplatesPage from './TemplatesPage.vue';
import TemplateCreatePage from './TemplateCreatePage.vue';
import GitServiceCreatePage from './GitServiceCreatePage.vue';
const route = useRoute();
const template = computed(() =>
  typeof route.query.template === 'string' ? route.query.template : '',
);
const templateKey = computed(
  () =>
    `${template.value}:${String(route.query.version ?? '')}:${String(route.query.environment ?? '')}`,
);
</script>
<template>
  <ImageServiceCreatePage v-if="route.query.source === 'image'" />
  <GitServiceCreatePage
    v-else-if="route.query.source === 'github'"
    :key="String(route.query.environment ?? '')"
  />
  <TemplateCreatePage v-else-if="template" :key="templateKey" />
  <TemplatesPage v-else />
</template>
