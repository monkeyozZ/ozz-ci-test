<script setup lang="ts">
import { AlertCircle } from '@lucide/vue';
import { ApiError, errorMessage } from '@/lib/api';
defineProps<{ error?: unknown }>();
</script>
<template>
  <div v-if="error" class="notice notice-danger" role="alert" tabindex="-1" data-mutation-error>
    <AlertCircle />
    <div class="min-w-0">
      <strong>{{ errorMessage(error) }}</strong>
      <p v-if="error instanceof ApiError && error.status === 409" class="mt-1">
        请核对当前资源与最新版本。已填写的内容仍保留。
      </p>
      <p v-if="error instanceof ApiError && error.status === 0" class="mt-1">
        请求结果尚未确认，请先刷新相关记录，再决定下一步。
      </p>
      <p v-if="error instanceof ApiError && error.problem.requestId" class="mono mt-2">
        请求 {{ error.problem.requestId }}
      </p>
    </div>
  </div>
</template>
