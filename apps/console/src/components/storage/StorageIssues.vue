<script setup lang="ts">
import { AlertCircle, Info } from '@lucide/vue';

withDefaults(
  defineProps<{
    issues: ReadonlyArray<{ code: string; message: string }>;
    title?: string;
    danger?: boolean;
  }>(),
  { title: '继续操作前需要处理', danger: false },
);
</script>
<template>
  <div
    v-if="issues.length"
    :class="['notice', danger ? 'notice-danger' : 'notice-warning']"
    data-storage-issues
  >
    <AlertCircle v-if="danger" aria-hidden="true" /><Info v-else aria-hidden="true" />
    <div class="min-w-0">
      <strong>{{ title }}</strong>
      <ul class="issue-list">
        <li v-for="(issue, index) in issues" :key="`${issue.code}:${index}`">
          <p>{{ issue.message }}</p>
          <p class="meta mono mt-1">{{ issue.code }}</p>
        </li>
      </ul>
      <slot />
    </div>
  </div>
</template>
<style scoped>
.issue-list {
  list-style: none;
  margin-top: 0.75rem;
  padding: 0;
  overflow-wrap: anywhere;
}
.issue-list li + li {
  margin-top: 0.875rem;
}
</style>
