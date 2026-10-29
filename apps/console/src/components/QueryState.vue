<script setup lang="ts">
import { AlertCircle, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { errorMessage, ApiError } from '@/lib/api';
defineProps<{ pending?: boolean; error?: unknown; refreshing?: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div v-if="pending" role="status" aria-label="正在载入" class="space-y-4">
    <span class="sr-only">正在载入</span>
    <div class="skeleton h-12 w-2/5" />
    <div v-for="i in 3" :key="i" class="skeleton h-24" />
  </div>
  <div v-else-if="error" class="notice notice-danger mb-6" role="alert" tabindex="-1">
    <AlertCircle />
    <div class="min-w-0 flex-1">
      <strong>没有载入最新数据</strong>
      <p class="mt-1">{{ errorMessage(error) }}</p>
      <p v-if="error instanceof ApiError && error.problem.requestId" class="mono mt-2">
        请求 {{ error.problem.requestId }}
      </p>
      <Button variant="outline" class="mt-3" @click="$emit('retry')"><RefreshCw />重新载入</Button>
    </div>
  </div>
  <template v-if="!pending"
    ><p v-if="refreshing" class="meta mb-3" role="status">正在更新，保留当前内容…</p>
    <slot
  /></template>
</template>
