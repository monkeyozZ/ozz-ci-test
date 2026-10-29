<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import SecretReferencePicker from './SecretReferencePicker.vue';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import type { Operation } from '@/lib/types';
import type { GitHubConnection, GitRepository, RegisterWebhookInput } from './types';
import { useGitRepositories } from './queries';
const props = defineProps<{ connection: GitHubConnection }>();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const repositories = useGitRepositories(() => props.connection.id);
const selected = ref<GitRepository | null>(null);
const secretRefId = ref('');
const latestOperation = ref<Operation | null>(null);
const guard = useDirtyForm(
  () => (selected.value ? { repository: selected.value.id, secretRefId: secretRefId.value } : null),
  'Webhook 注册',
);
let key = idempotencyKey();
const selectedFresh = computed(
  () =>
    selected.value &&
    repositories.items.value.some(
      (item) => item.id === selected.value?.id && item.revision === selected.value.revision,
    ),
);
const register = useMutation({
  mutationFn: (input: { repositoryId: string; body: RegisterWebhookInput }) =>
    api.create<Operation>(
      '/integrations/github/' +
        props.connection.id +
        '/repositories/' +
        input.repositoryId +
        '/webhook',
      input.body,
      key,
    ),
  onSuccess: async (operation) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['github-page', '/integrations/github/' + props.connection.id + '/repositories'],
      }),
      invalidateCollection('/operations'),
    ]);
    if (!active()) return;
    latestOperation.value = operation;
    selected.value = null;
    secretRefId.value = '';
    guard.markClean();
  },
});
function open(repository: GitRepository) {
  if (guard.dirty.value || register.isPending.value) return;
  selected.value = repository;
  secretRefId.value = '';
  key = idempotencyKey();
  register.reset();
  guard.markClean();
}
async function close() {
  if (register.isPending.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃 Webhook 注册配置？',
      description: '尚未提交的凭证选择将被清空。',
      confirmText: '关闭注册表单',
    }))
  )
    return;
  if (!active()) return;
  selected.value = null;
  secretRefId.value = '';
  guard.markClean();
}
function submit() {
  if (
    !selected.value ||
    !selectedFresh.value ||
    !secretRefId.value ||
    auth.restoreMode ||
    register.isPending.value
  )
    return;
  register.mutate({
    repositoryId: selected.value.id,
    body: { revision: selected.value.revision, secretRefId: secretRefId.value },
  });
}
const hookLabels: Record<string, string> = {
  unregistered: '未注册',
  pending: '注册待确认',
  registered: '已注册',
  verified: '已核对',
  failed: '注册或验证失败',
  updating: '更新中',
};
</script>
<template>
  <section class="panel" data-github-repositories>
    <div class="section-head">
      <div>
        <h2>{{ connection.name }} · 授权仓库</h2>
        <p class="meta mt-1">仓库读取与 Webhook 管理分别核对，保存 PAT 不会自动注册 Webhook。</p>
      </div>
      <Button
        variant="outline"
        :disabled="repositories.isFetching.value"
        @click="repositories.refetch()"
        >刷新仓库权限</Button
      >
    </div>
    <p v-if="latestOperation" class="notice mb-5">
      Webhook 操作已受理。<RouterLink :to="'/operations/' + latestOperation.id" class="text-link"
        >查看注册或更新结果</RouterLink
      >
    </p>
    <form v-if="selected" class="hook-editor mb-5" @submit.prevent="submit">
      <h3 class="font-medium">注册或更新 {{ selected.fullName }} 的 Webhook</h3>
      <p class="meta mt-2 mb-4">
        将实际修改此仓库中平台持有的 Hook。PAT 需要该仓库的 Webhooks 写权限；验签密钥独立保存。
      </p>
      <SecretReferencePicker
        v-model="secretRefId"
        kind="webhook"
        label="Webhook 验签凭证"
        required
        :disabled="register.isPending.value || auth.restoreMode"
      />
      <p v-if="!selectedFresh" class="meta text-destructive mt-3">
        仓库资料已变化，请关闭后刷新仓库，再重新选择。
      </p>
      <MutationError class="mt-4" :error="register.error.value" />
      <div class="form-footer">
        <Button type="button" variant="outline" :disabled="register.isPending.value" @click="close"
          >关闭注册表单</Button
        >
        <Button
          type="submit"
          :disabled="auth.restoreMode || register.isPending.value || !selectedFresh"
          >{{ register.isPending.value ? '正在受理…' : '确认在 GitHub 注册或更新' }}</Button
        >
      </div>
    </form>
    <QueryState
      :pending="repositories.isPending.value"
      :error="repositories.error.value"
      @retry="repositories.refetch()"
    >
      <ul class="repository-list">
        <li v-for="repository in repositories.items.value" :key="repository.id">
          <div class="min-w-0">
            <h3 class="font-medium break-all">{{ repository.fullName }}</h3>
            <p class="meta mt-2">
              {{ repository.private ? '私有仓库' : '公开仓库' }} · 默认分支
              {{ repository.defaultBranch }} · 最近权限核对
              {{ dateTime(repository.lastVerifiedAt) }}
            </p>
            <p class="meta mt-2">
              Webhook：{{ hookLabels[repository.hook.state] || repository.hook.state
              }}{{ repository.hook.verifiedAt ? ' · ' + dateTime(repository.hook.verifiedAt) : '' }}
            </p>
            <p v-if="repository.hook.callbackUrl" class="meta mono mt-1 break-all">
              {{ repository.hook.callbackUrl }}
            </p>
            <p v-if="repository.hook.errorCode" class="meta mono text-destructive mt-2">
              {{ repository.hook.errorCode }}
            </p>
            <RouterLink
              v-if="repository.hook.operationId"
              :to="'/operations/' + repository.hook.operationId"
              class="text-link text-sm mt-2 inline-block"
              >查看 Webhook 操作</RouterLink
            >
          </div>
          <Button
            variant="outline"
            :disabled="auth.restoreMode || register.isPending.value || guard.dirty.value"
            @click="open(repository)"
            >配置 Webhook</Button
          >
        </li>
      </ul>
      <p v-if="!repositories.items.value.length && !repositories.error.value" class="meta py-4">
        没有可读取的授权仓库。请核对 fine-grained PAT 的账号、仓库选择及 Contents 读取权限。
      </p>
      <Button
        v-if="repositories.hasNextPage.value"
        variant="outline"
        :disabled="repositories.isFetchingNextPage.value"
        @click="repositories.fetchNextPage()"
        >载入更多授权仓库</Button
      >
    </QueryState>
  </section>
</template>
<style scoped>
.hook-editor {
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.repository-list {
  list-style: none;
  padding: 0;
}
.repository-list li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding: 1.25rem 0;
}
.repository-list li + li {
  border-top: 1px solid var(--border);
}
@media (max-width: 640px) {
  .repository-list li {
    flex-direction: column;
  }
}
</style>
