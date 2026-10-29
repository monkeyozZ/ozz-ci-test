<script setup lang="ts">
import { computed } from 'vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import { ApiError } from '@/lib/api';
const props = defineProps<{ error?: unknown }>();
const fields = computed(() => {
  if (!(props.error instanceof ApiError)) return [];
  const details = props.error.problem.errors;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  return Object.entries(details).flatMap(([field, messages]) =>
    Array.isArray(messages)
      ? messages
          .filter((message): message is string => typeof message === 'string')
          .map((message) => ({ field, message }))
      : [],
  );
});
</script>
<template>
  <div v-if="error" data-storage-mutation-error>
    <ServiceMutationError :error="error" />
    <ul v-if="fields.length" class="storage-field-errors mt-3">
      <li v-for="(issue, index) in fields" :key="index">
        <span class="mono">{{ issue.field }}</span
        >：{{ issue.message }}
      </li>
    </ul>
  </div>
</template>
<style scoped>
.storage-field-errors {
  color: var(--destructive);
  list-style: disc;
  padding-left: 1.25rem;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.storage-field-errors li + li {
  margin-top: 0.375rem;
}
</style>
