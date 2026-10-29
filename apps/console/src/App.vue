<script setup lang="ts">
import GlobalFeedback from '@/components/GlobalFeedback.vue';
import { useAuthStore } from '@/stores/auth';
const auth = useAuthStore();
</script>
<template>
  <div v-if="!auth.ready" class="min-h-dvh grid place-items-center" role="status">
    <div class="space-y-4 w-64">
      <p class="text-lg font-semibold">Ozz</p>
      <div class="skeleton h-3 w-3/4" />
      <div class="skeleton h-3" />
      <span class="sr-only">正在恢复工作台会话</span>
    </div>
  </div>
  <RouterView v-else /><GlobalFeedback />
</template>
