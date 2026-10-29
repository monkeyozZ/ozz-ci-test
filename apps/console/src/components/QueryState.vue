<script setup lang="ts">
import { AlertCircle, RefreshCw, WifiOff } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { errorMessage, ApiError } from '@/lib/api';
import { useNetworkStatus } from '@/composables/useNetworkStatus';
defineProps<{ pending?: boolean; error?: unknown; refreshing?: boolean }>();
defineEmits<{ retry: [] }>();
const online = useNetworkStatus();
</script>
<template>
  <div class="query-state" :aria-busy="(pending || refreshing) && online ? true : undefined">
    <div v-if="pending && !online" class="notice notice-warning" role="status">
      <WifiOff />
      <div>
        <strong>等待网络恢复</strong>
        <p>连接恢复后会继续载入，请保留当前页面。</p>
      </div>
    </div>
    <div v-else-if="pending" role="status" aria-label="正在载入" class="space-y-4">
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
        <Button
          type="button"
          variant="outline"
          class="mt-3"
          :disabled="refreshing || !online"
          @click="$emit('retry')"
        >
          <RefreshCw :class="{ 'animate-spin': refreshing && online }" />{{
            !online ? '等待网络恢复' : refreshing ? '正在重新载入' : '重新载入'
          }}
        </Button>
      </div>
    </div>
    <template v-if="!pending">
      <div
        v-if="refreshing !== undefined && !error"
        class="query-refresh"
        role="status"
        aria-live="polite"
      >
        <span v-if="refreshing && online"
          ><RefreshCw class="size-3.5 animate-spin" />正在更新，保留当前内容</span
        >
      </div>
      <slot />
    </template>
  </div>
</template>
