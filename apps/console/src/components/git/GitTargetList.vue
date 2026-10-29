<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { dateTime } from '@/lib/utils';
import { reasonLabel, targetStateLabels } from './presentation';
import type { WebhookTarget } from './types';
defineProps<{ targets: WebhookTarget[]; disabled?: boolean }>();
function reviewLocation(target: WebhookTarget) {
  return {
    path: '/projects/' + target.target.projectId + '/services/' + target.currentServiceId,
    query: { tab: 'review', target: target.id },
  };
}
</script>
<template>
  <ul class="git-target-list" data-git-targets>
    <li v-for="target in targets" :key="target.id">
      <div class="min-w-0">
        <p class="mono break-all">{{ target.commitSha }}</p>
        <div class="flex flex-wrap gap-2 mt-2">
          <span class="badge" :class="{ 'badge-warning': target.state === 'pending' }">{{
            targetStateLabels[target.state]
          }}</span>
          <span v-if="target.manualRequired && !target.deploymentId" class="badge">需明确发布</span>
          <span class="meta">{{ dateTime(target.createdAt) }}</span>
        </div>
        <p class="meta mt-2">{{ reasonLabel(target.reason) }}</p>
        <p v-if="target.blockedReason && !target.deploymentId" class="meta mt-2">
          {{ reasonLabel(target.blockedReason) }}
        </p>
        <details class="mt-3">
          <summary class="meta">投递身份与来源</summary>
          <dl class="target-identities mt-3">
            <div>
              <dt>服务</dt>
              <dd>{{ target.target.serviceName }} · {{ target.serviceId }}</dd>
            </div>
            <div>
              <dt>来源版本</dt>
              <dd>{{ target.sourceRevisionId }}</dd>
            </div>
            <div>
              <dt>收件时配置</dt>
              <dd>
                运行 r{{ target.configRevisionAtReceipt }} · 策略 r{{
                  target.policyRevisionAtReceipt
                }}
              </dd>
            </div>
            <div>
              <dt>投递顺序</dt>
              <dd>{{ target.receiptSequence }}</dd>
            </div>
            <div>
              <dt>事件</dt>
              <dd>
                <RouterLink
                  :to="'/webhook-deliveries/' + target.webhookDeliveryId"
                  class="text-link"
                  >{{ target.webhookDeliveryId }}</RouterLink
                >
              </dd>
            </div>
          </dl>
        </details>
      </div>
      <div class="actions">
        <Button v-if="target.deploymentId" as-child variant="outline"
          ><RouterLink :to="'/deployments/' + target.deploymentId">查看部署结果</RouterLink></Button
        >
        <Button
          v-else-if="target.canPreview && target.currentServiceId && !disabled"
          as-child
          variant="outline"
          ><RouterLink :to="reviewLocation(target)">审阅此提交</RouterLink></Button
        >
        <span v-else-if="target.canPreview && disabled" class="meta"
          >当前任务结束或退出只读状态后可审阅。</span
        >
      </div>
    </li>
  </ul>
</template>
<style scoped>
.git-target-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.git-target-list > li {
  display: flex;
  justify-content: space-between;
  gap: 1.25rem;
  align-items: flex-start;
  padding: 1.25rem 0;
}
.git-target-list > li + li {
  border-top: 1px solid var(--border);
}
.target-identities {
  font-size: 0.8125rem;
  display: grid;
  gap: 0.5rem;
}
.target-identities dt {
  color: var(--muted-foreground);
}
.target-identities dd {
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  min-height: 2rem;
}
@media (max-width: 640px) {
  .git-target-list > li {
    flex-direction: column;
  }
}
</style>
