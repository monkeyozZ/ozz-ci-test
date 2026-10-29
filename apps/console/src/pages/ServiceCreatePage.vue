<script setup lang="ts">
import { computed, provide, shallowReactive, watch } from 'vue';
import { routeLocationKey, useRoute, type RouteLocationNormalizedLoaded } from 'vue-router';
import ImageServiceCreatePage from './ImageServiceCreatePage.vue';
import TemplatesPage from './TemplatesPage.vue';
import TemplateCreatePage from './TemplateCreatePage.vue';
import GitServiceCreatePage from './GitServiceCreatePage.vue';
import { creationViewKey } from '@/composables/useCreationDialogState';
const props = defineProps<{ displayRoute?: RouteLocationNormalizedLoaded }>();
const liveRoute = useRoute();
const route = shallowReactive({ ...(props.displayRoute ?? liveRoute) });
watch(
  () => props.displayRoute ?? { ...liveRoute },
  (value) => Object.assign(route, value),
);
// This provider belongs to one dialog session; it never changes global router guards.
provide(routeLocationKey, route);
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
