<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ImageServiceCreatePage from './ImageServiceCreatePage.vue';
import TemplatesPage from './TemplatesPage.vue';
import TemplateCreatePage from './TemplateCreatePage.vue';
import GitServiceCreatePage from './GitServiceCreatePage.vue';
import { creationViewKey } from '@/composables/useCreationDialogState';
const route = useRoute();
const template = computed(() =>
  typeof route.query.template === 'string' ? route.query.template : '',
);
const viewKey = computed(() => creationViewKey(route));
const component = computed(() =>
  route.query.source === 'image'
    ? ImageServiceCreatePage
    : route.query.source === 'github'
      ? GitServiceCreatePage
      : template.value
        ? TemplateCreatePage
        : TemplatesPage,
);
</script>
<template>
  <KeepAlive :max="12"><component :is="component" :key="viewKey" /></KeepAlive>
</template>
