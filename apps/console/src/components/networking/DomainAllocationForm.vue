<script setup lang="ts">
import { computed, reactive, toRefs, useId, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { Info, LoaderCircle, ArrowRight, Settings2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import CopyButton from '@/components/CopyButton.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import NetworkTarget from './NetworkTarget.vue';
import { api } from '@/lib/api';
import { idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { queryClient } from '@/lib/query';
import type { Operation } from '@/lib/types';
import type { ServiceNetworking } from './types';
import { invalidateNetworking } from './queries';
import { networkingSettingsLocation } from './presentation';

const props = defineProps<{ context: ServiceNetworking }>();
const emit = defineEmits<{ submitted: [operation: Operation] }>();
const uid = useId();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const form = reactive({ portId: '', confirmed: false });
const { portId, confirmed } = toRefs(form);
const guard = useDirtyForm(form, '域名绑定');
const selectedPort = computed(() =>
  props.context.eligiblePorts.find((port) => port.id === portId.value),
);
const keys = new Map<string, string>();
watch(
  () => props.context.eligiblePorts,
  (ports) => {
    if (!guard.dirty.value && !ports.some((port) => port.id === portId.value)) {
      portId.value = ports[0]?.id ?? '';
      confirmed.value = false;
      guard.markClean();
    }
  },
  { immediate: true },
);
watch(portId, () => (confirmed.value = false));
const create = useMutation({
  mutationFn: (input: { serviceId: string; revision: number; portId: string; key: string }) =>
    api.create<Operation>(
      `/services/${input.serviceId}/domains`,
      { revision: input.revision, portId: input.portId },
      input.key,
    ),
  onSuccess: async (operation, input) => {
    queryClient.setQueryData(['operation', operation.id], operation);
    guard.markClean();
    if (active()) {
      ui.toast('域名请求已受理，DNS、路由和证书结果分别等待检查。');
      emit('submitted', operation);
    }
    await invalidateNetworking(input.serviceId);
  },
});
const disabled = computed(
  () =>
    auth.restoreMode ||
    create.isPending.value ||
    props.context.blockers.length > 0 ||
    !selectedPort.value,
);
function submit() {
  if (disabled.value || !confirmed.value || !selectedPort.value) return;
  const current = props.context;
  const token = `${current.serviceId}:${current.serviceRevision}:${portId.value}`;
  if (!keys.has(token)) keys.set(token, idempotencyKey());
  create.mutate({
    serviceId: current.serviceId,
    revision: current.serviceRevision,
    portId: portId.value,
    key: keys.get(token)!,
  });
}
</script>
<template>
  <form class="panel" data-domain-allocation @submit.prevent="submit">
    <div class="section-head">
      <div>
        <h2>分配默认域名</h2>
        <p class="meta mt-1">域名分配后保持固定，服务改名不会更换入口。</p>
      </div>
    </div>
    <NetworkTarget :context="context" class="mb-6" />
    <div v-if="context.blockers.length" class="notice notice-warning mb-6">
      <Info aria-hidden="true" />
      <div class="min-w-0">
        <strong>绑定前还需要完成</strong>
        <ul class="network-blockers">
          <li v-for="blocker in context.blockers" :key="blocker.code">{{ blocker.message }}</li>
        </ul>
        <div class="actions mt-3">
          <RouterLink
            :to="networkingSettingsLocation(context.cluster.id)"
            class="text-link inline-flex items-center gap-1"
          >
            <Settings2 class="size-4" />查看平台与集群入口设置
          </RouterLink>
          <RouterLink
            v-if="!context.eligiblePorts.length"
            :to="{
              path: `/projects/${context.project.id}/services/${context.serviceId}`,
              query: { environment: context.environment.slug, tab: 'configuration' },
            }"
            class="text-link"
            >配置并发布 HTTP 端口</RouterLink
          >
        </div>
      </div>
    </div>
    <fieldset :disabled="create.isPending.value || auth.restoreMode" class="stack">
      <div class="form-grid">
        <div class="field">
          <label :for="`${uid}-port`">已发布 HTTP 端口</label>
          <select
            :id="`${uid}-port`"
            v-model="portId"
            class="input"
            :disabled="!context.eligiblePorts.length"
            required
          >
            <option v-if="!context.eligiblePorts.length" value="">暂无可绑定端口</option>
            <option v-for="port in context.eligiblePorts" :key="port.id" :value="port.id">
              {{ port.name }} · {{ port.servicePort }} / HTTP · r{{ port.publishedConfigRevision }}
            </option>
          </select>
          <p class="field-hint">绑定已发布的具名端口。修改草稿不会立即改变此入口。</p>
        </div>
        <div class="field">
          <label :for="`${uid}-suffix`">目标集群后缀</label>
          <input
            :id="`${uid}-suffix`"
            class="input mono"
            readonly
            :value="context.clusterNetworking.domainSuffix || '尚未配置'"
          />
          <p class="field-hint">完整域名会在请求受理后分配并保存。</p>
        </div>
      </div>
      <section class="dns-instructions" aria-label="DNS 配置说明">
        <h3>DNS 记录指向集群入口</h3>
        <p class="meta mt-2">在 DNS 服务商处设置记录；控制台不会创建或删除手工 DNS。</p>
        <dl class="detail-list mt-3">
          <div>
            <dt>集群后缀</dt>
            <dd class="mono">{{ context.clusterNetworking.domainSuffix || '尚未配置' }}</dd>
          </div>
          <div>
            <dt>A / AAAA 地址</dt>
            <dd class="mono">
              <p
                v-for="address in context.clusterNetworking.entryAddresses"
                :key="address"
                class="dns-value"
              >
                <span>{{ address }}</span
                ><CopyButton
                  :text="address"
                  :label="`复制 ${address.includes(':') ? 'AAAA' : 'A'} 记录值 ${address}`"
                  compact
                />
              </p>
              <span v-if="!context.clusterNetworking.entryAddresses.length">未设置</span>
            </dd>
          </div>
          <div v-if="context.clusterNetworking.cnameTarget">
            <dt>CNAME 目标</dt>
            <dd class="mono dns-value">
              <span>{{ context.clusterNetworking.cnameTarget }}</span
              ><CopyButton
                :text="context.clusterNetworking.cnameTarget"
                label="复制 CNAME 目标"
                compact
              />
            </dd>
          </div>
        </dl>
      </section>
      <p class="meta">先验证 ACME staging 签发流程，再单独申请正式证书。测试证书不受浏览器信任。</p>
      <label class="binding-confirm">
        <input v-model="confirmed" type="checkbox" :disabled="disabled" />
        <span>已核对目标集群、HTTP 端口和 DNS 记录归属。</span>
      </label>
    </fieldset>
    <ServiceMutationError :error="create.error.value" class="mt-5" />
    <div class="form-footer">
      <Button type="submit" :disabled="disabled || !confirmed">
        <LoaderCircle v-if="create.isPending.value" class="animate-spin" /><ArrowRight v-else />
        {{ create.isPending.value ? '正在受理…' : '分配默认域名' }}
      </Button>
    </div>
  </form>
</template>
<style scoped>
.network-blockers {
  margin: 0.625rem 0 0;
  padding-left: 1.25rem;
  list-style: disc;
}
.network-blockers li + li {
  margin-top: 0.375rem;
}
.dns-instructions {
  border-top: 1px solid var(--border);
  padding-top: 1.25rem;
}
.dns-value {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
}
.dns-value > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.binding-confirm {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}
.binding-confirm input {
  margin-top: 0.2rem;
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  accent-color: var(--primary);
}
</style>
