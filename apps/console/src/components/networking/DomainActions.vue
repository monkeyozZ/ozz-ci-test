<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { RefreshCw, RotateCw, ShieldCheck, Unlink, LoaderCircle, Info } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import CopyButton from '@/components/CopyButton.vue';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { idempotencyKey } from '@/lib/utils';
import { queryClient } from '@/lib/query';
import type { Operation } from '@/lib/types';
import { requestDomainAction, invalidateNetworking } from './queries';
import { certificateStatus } from './presentation';
import type { Domain } from './types';

const props = defineProps<{ domain: Domain }>();
const emit = defineEmits<{ submitted: [operation: Operation] }>();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const reconcileHelpId = useId();
const unbindOpen = ref(false);
const unbindTarget = ref<Domain | null>(null);
const confirmation = ref('');
const composing = ref(false);
const keys = new Map<string, string>();
const task = useMutation({
  mutationFn: (
    input: Parameters<typeof requestDomainAction>[0] & { serviceId: string; token: string },
  ) => requestDomainAction(input),
  onSuccess: async (operation, input) => {
    queryClient.setQueryData(['operation', operation.id], operation);
    keys.delete(input.token);
    if (active()) {
      unbindOpen.value = false;
      confirmation.value = '';
      ui.toast(
        input.action === 'unbind'
          ? '解绑请求已受理，等待路由与专属证书清理。'
          : input.action === 'production'
            ? '正式证书申请已受理，等待实际签发结果。'
            : input.action === 'reconcile'
              ? '重新应用任务已受理，沿用当前完整域名。'
              : '网络检查任务已受理。',
      );
      emit('submitted', operation);
    }
    await invalidateNetworking(input.serviceId, input.domainId);
  },
});
const locked = computed(
  () =>
    auth.restoreMode ||
    task.isPending.value ||
    !!props.domain.activeTask ||
    props.domain.desiredState === 'deleting',
);
const pendingAction = computed(() =>
  task.isPending.value && task.variables.value?.domainId === props.domain.id
    ? task.variables.value.action
    : null,
);
const canRequestProduction = computed(
  () =>
    props.domain.certificateEnvironment === 'staging' &&
    props.domain.certificate?.state === 'staging_ready' &&
    !props.domain.observationStale &&
    certificateStatus(props.domain.certificate).tone !== 'danger',
);
function dispatch(action: Parameters<typeof requestDomainAction>[0]['action'], domain: Domain) {
  if (locked.value) return;
  const token = `${domain.id}:${domain.revision}:${action}`;
  if (!keys.has(token)) keys.set(token, idempotencyKey());
  task.mutate({
    domainId: domain.id,
    serviceId: domain.serviceId,
    revision: domain.revision,
    action,
    key: keys.get(token)!,
    token,
  });
}
async function requestProduction() {
  if (locked.value || !canRequestProduction.value) return;
  const domain = props.domain;
  if (
    !(await ui.confirm({
      title: '申请正式证书？',
      description: `${domain.hostname} 已记录 staging 签发结果。这会为 ${domain.project.name} / ${domain.environment.name} · ${domain.cluster.name} 发起独立的 ACME production 任务。${domain.certificate?.authority === 'local_test' ? '当前使用本地测试 CA，production 模式的结果仍是浏览器默认不信任的测试证书。' : '正式 HTTPS 状态取决于后续证书观察。'}`,
      confirmText: '申请正式证书',
    }))
  )
    return;
  if (active()) dispatch('production', domain);
}
function openUnbind() {
  if (locked.value) return;
  unbindTarget.value = props.domain;
  confirmation.value = '';
  task.reset();
  unbindOpen.value = true;
}
function setUnbindOpen(open: boolean) {
  if (task.isPending.value) return;
  unbindOpen.value = open;
  if (!open) {
    confirmation.value = '';
    composing.value = false;
  }
}
function submitUnbind() {
  const target = unbindTarget.value;
  if (
    !target ||
    task.isPending.value ||
    auth.restoreMode ||
    composing.value ||
    confirmation.value.trim() !== target.hostname
  )
    return;
  dispatch('unbind', target);
}
function preserveComposition(event: KeyboardEvent) {
  if (event.key === 'Enter' && (composing.value || event.isComposing || event.keyCode === 229))
    event.preventDefault();
}
</script>
<template>
  <div data-domain-actions>
    <div class="actions">
      <CopyButton :text="domain.hostname" label="复制完整域名" />
      <Button
        variant="outline"
        :disabled="locked"
        :aria-busy="pendingAction === 'sync' || undefined"
        @click="dispatch('sync', domain)"
        ><LoaderCircle v-if="pendingAction === 'sync'" class="animate-spin" /><RefreshCw v-else />{{
          pendingAction === 'sync' ? '正在提交检查…' : '重新检查'
        }}</Button
      >
      <Button
        v-if="domain.desiredState === 'active'"
        variant="outline"
        :disabled="locked"
        :aria-busy="pendingAction === 'reconcile' || undefined"
        :aria-describedby="reconcileHelpId"
        @click="dispatch('reconcile', domain)"
        ><LoaderCircle v-if="pendingAction === 'reconcile'" class="animate-spin" /><RotateCw
          v-else
        />{{ pendingAction === 'reconcile' ? '正在提交重新应用…' : '重新应用绑定' }}</Button
      >
      <Button
        v-if="canRequestProduction || pendingAction === 'production'"
        :disabled="locked"
        :aria-busy="pendingAction === 'production' || undefined"
        @click="requestProduction"
        ><LoaderCircle v-if="pendingAction === 'production'" class="animate-spin" /><ShieldCheck
          v-else
        />{{ pendingAction === 'production' ? '正在提交证书申请…' : '申请正式证书' }}</Button
      >
      <Button variant="outline" :disabled="locked" @click="openUnbind"><Unlink />解绑审查</Button>
    </div>
    <p v-if="domain.desiredState === 'active'" :id="reconcileHelpId" class="meta mt-3 max-w-prose">
      重新应用会保留完整域名与绑定端口，使用当前已发布的服务配置。证书环境保持不变。
    </p>
    <ServiceMutationError v-if="!unbindOpen" :error="task.error.value" class="mt-4" />
    <Dialog
      :open="unbindOpen"
      title="解绑域名与清理资源"
      :description="unbindTarget?.hostname"
      width="wide"
      @update:open="setUnbindOpen"
    >
      <form @submit.prevent="submitUnbind" @keydown.capture="preserveComposition">
        <template v-if="unbindTarget">
          <p>
            解除 <strong class="mono break-all">{{ unbindTarget.hostname }}</strong> 与
            {{ unbindTarget.serviceName }} 的路由绑定。
          </p>
          <dl class="detail-list my-5">
            <div>
              <dt>专属路由</dt>
              <dd>请求删除，等待确认</dd>
            </div>
            <div>
              <dt>专属证书资源</dt>
              <dd>按已确认的归属清理</dd>
            </div>
            <div>
              <dt>共享资源</dt>
              <dd>保留共享 Namespace、Issuer 与账户凭证</dd>
            </div>
            <div>
              <dt>手工 DNS</dt>
              <dd>保留，平台不会删除</dd>
            </div>
          </dl>
          <div class="notice notice-warning mb-5">
            <Info aria-hidden="true" />
            <p>清理失败时会保留域名与任务记录，确认完成后才释放绑定。</p>
          </div>
          <div class="field">
            <label for="domain-unbind-confirmation">输入完整域名确认</label
            ><Input
              id="domain-unbind-confirmation"
              v-model="confirmation"
              autocomplete="off"
              autocapitalize="off"
              :spellcheck="false"
              :disabled="task.isPending.value"
              @compositionstart="composing = true"
              @compositionend="composing = false"
            />
          </div>
          <ServiceMutationError :error="task.error.value" class="mt-4" />
          <div class="form-footer">
            <Button
              type="button"
              variant="outline"
              :disabled="task.isPending.value"
              @click="setUnbindOpen(false)"
              >返回</Button
            ><Button
              type="submit"
              variant="destructive"
              :aria-busy="task.isPending.value || undefined"
              :disabled="
                task.isPending.value ||
                auth.restoreMode ||
                confirmation.trim() !== unbindTarget.hostname
              "
              ><LoaderCircle v-if="task.isPending.value" class="animate-spin" />{{
                task.isPending.value ? '正在提交解绑…' : '提交解绑请求'
              }}</Button
            >
          </div>
        </template>
      </form>
    </Dialog>
  </div>
</template>
