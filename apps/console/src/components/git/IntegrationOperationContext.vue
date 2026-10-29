<script setup lang="ts">
import { computed } from 'vue';
import { dateTime } from '@/lib/utils';
import type { Operation } from '@/lib/types';
const props = defineProps<{ operation: Operation }>();
const hookInput = computed(() => {
  const input = props.operation.input;
  return props.operation.scope === 'integration' &&
    'action' in input &&
    input.action === 'register_webhook'
    ? input
    : null;
});
const registryInput = computed(() => {
  const input = props.operation.input;
  return props.operation.scope === 'integration' &&
    'action' in input &&
    input.action === 'validate_registry'
    ? input
    : null;
});
const hookResult = computed(() => {
  const result = props.operation.result;
  return result && 'registered' in result ? result : null;
});
const registryResult = computed(() => {
  const result = props.operation.result;
  return result && 'pullCannotPush' in result ? result : null;
});
</script>
<template>
  <section v-if="hookInput || registryInput" class="panel mb-6" data-integration-operation>
    <div class="section-head">
      <h2>{{ hookInput ? '固定 Webhook 注册目标' : '固定 Registry 验证目标' }}</h2>
      <RouterLink
        :to="{
          path: '/settings',
          query: { tab: 'git', integration: hookInput ? 'github' : 'registries' },
        }"
        class="text-link"
        >返回集成设置</RouterLink
      >
    </div>
    <dl v-if="hookInput" class="integration-result">
      <div>
        <dt>仓库身份</dt>
        <dd>{{ hookInput.integrationId }}</dd>
      </div>
      <div>
        <dt>回调地址</dt>
        <dd>{{ hookInput.callbackUrl }}</dd>
      </div>
      <div>
        <dt>验签凭证引用</dt>
        <dd>{{ hookInput.hookSecretRefId }}</dd>
      </div>
      <div v-if="hookResult">
        <dt>实际注册 Hook</dt>
        <dd>{{ hookResult.hookId }} · {{ hookResult.registered ? '已注册' : '待确认' }}</dd>
      </div>
    </dl>
    <dl v-else-if="registryInput" class="integration-result">
      <div>
        <dt>固定连接</dt>
        <dd>{{ registryInput.integrationId }}</dd>
      </div>
      <div>
        <dt>平台探针 repository</dt>
        <dd>{{ registryInput.probeRepository }}</dd>
      </div>
      <template v-if="registryResult">
        <div>
          <dt>权限检查</dt>
          <dd>
            推送 {{ registryResult.push ? '通过' : '未通过' }} · 拉取
            {{ registryResult.pull ? '通过' : '未通过' }} · 拉取身份禁止推送
            {{ registryResult.pullCannotPush ? '已确认' : '未确认' }}
          </dd>
        </div>
        <div>
          <dt>实际探针产物</dt>
          <dd>{{ registryResult.probeReference }}</dd>
        </div>
        <div>
          <dt>检查时间</dt>
          <dd>{{ dateTime(registryResult.checkedAt) }}</dd>
        </div>
        <div>
          <dt>探针保留</dt>
          <dd>
            {{ registryResult.probeRetained ? '探针产物保留在平台专用仓库中' : '探针产物已清理' }}
          </dd>
        </div>
      </template>
    </dl>
    <p v-if="!operation.result" class="meta mt-4">尚无执行结果，请结合当前任务状态与日志核对。</p>
  </section>
</template>
<style scoped>
.integration-result {
  display: grid;
  gap: 1rem;
}
dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  margin-bottom: 0.375rem;
}
dd {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}
</style>
