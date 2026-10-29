<script setup lang="ts">
import { CheckCircle2, AlertCircle, CircleHelp } from '@lucide/vue';
import { dateTime } from '@/lib/utils';
import type { IntegrationCheck } from './types';
defineProps<{ label: string; check: IntegrationCheck }>();
const labels = { unverified: '尚未验证', verified: '验证通过', failed: '验证失败' };
</script>
<template>
  <div class="integration-check">
    <p class="flex items-center gap-2">
      <CheckCircle2 v-if="check.state === 'verified'" class="size-4 text-success" />
      <AlertCircle v-else-if="check.state === 'failed'" class="size-4 text-destructive" />
      <CircleHelp v-else class="size-4" />
      <span>{{ label }} · {{ labels[check.state] }}</span>
    </p>
    <p class="meta mt-1">{{ check.checkedAt ? dateTime(check.checkedAt) : '尚无检查时间' }}</p>
    <p v-if="check.errorCode" class="mono text-destructive text-sm mt-1 break-all">
      {{ check.errorCode }}
    </p>
    <p v-if="check.errorCode === 'BUILDER_GENERATION_MISMATCH'" class="meta mt-2">
      Builder 与控制面代际不匹配。请登记匹配当前代际的独立
      Builder，或按人工恢复核对流程显式更新代际。普通验证不会提升代际。
    </p>
  </div>
</template>
