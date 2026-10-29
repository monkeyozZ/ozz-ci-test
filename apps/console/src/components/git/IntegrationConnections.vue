<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { Plus, RefreshCw, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import IntegrationCheck from './IntegrationCheck.vue';
import SecretReferencePicker from './SecretReferencePicker.vue';
import GitHubRepositories from './GitHubRepositories.vue';
import { api } from '@/lib/api';
import { invalidateCollection, useCollection } from '@/lib/query';
import { idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { hasUnsavedChanges, useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import type { Operation } from '@/lib/types';
import type {
  Builder,
  BuilderInput,
  BuilderUpdate,
  GitHubConnection,
  GitHubConnectionInput,
  GitHubConnectionUpdate,
  RegistryConnection,
  RegistryConnectionInput,
  RegistryConnectionUpdate,
} from './types';
const props = defineProps<{ kind: 'github' | 'registries' | 'builders' }>();
type Integration = GitHubConnection | RegistryConnection | Builder;
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const path = computed(() => '/integrations/' + props.kind);
const titles = { github: 'GitHub 授权', registries: '镜像仓库身份', builders: '独立 Builder' };
const items = useCollection<Integration>(path, undefined, true, { refetchInterval: 10_000 });
const editing = ref<Integration | null>(null);
const editorOpen = ref(false);
const formElement = ref<HTMLFormElement>();
const selectedGithub = ref<GitHubConnection | null>(null);
const latestOperation = ref<Operation | null>(null);
const form = reactive({
  name: '',
  credentialRefId: '',
  authority: '',
  namespace: '',
  pushCredentialRefId: '',
  pullCredentialRefId: '',
  endpoint: '',
  instanceId: '',
  identityPublicKey: '',
  buildkitVersion: '',
  frontendDigest: '',
  enabled: true,
});
const guard = useDirtyForm(() => (editorOpen.value ? form : null), '集成连接');
function fill(value?: Integration) {
  Object.assign(form, {
    name: value?.name ?? '',
    credentialRefId: '',
    authority: '',
    namespace: '',
    pushCredentialRefId: '',
    pullCredentialRefId: '',
    endpoint: '',
    instanceId: '',
    identityPublicKey: '',
    buildkitVersion: '',
    frontendDigest: '',
    enabled: true,
  });
  if (!value) return;
  if ('credentialRefId' in value) form.credentialRefId = value.credentialRefId;
  if ('pushVerification' in value)
    Object.assign(form, {
      authority: value.authority,
      namespace: value.namespace,
      pushCredentialRefId: value.pushCredentialRefId,
      pullCredentialRefId: value.pullCredentialRefId,
    });
  if ('profile' in value)
    Object.assign(form, {
      endpoint: value.endpoint,
      instanceId: value.instanceId,
      identityPublicKey: value.identityPublicKey,
      buildkitVersion: value.profile.buildkitVersion,
      frontendDigest: value.profile.frontendDigest,
      enabled: value.enabled,
    });
}
async function open(value?: Integration) {
  if (save.isPending.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃尚未保存的集成修改？',
      description: '将打开所选连接的已保存配置。',
      confirmText: '放弃修改并打开',
    }))
  )
    return;
  if (!active()) return;
  editing.value = value ?? null;
  fill(value);
  editorOpen.value = true;
  save.reset();
  guard.markClean();
  await nextTick();
  formElement.value?.querySelector<HTMLInputElement>('input')?.focus();
}
async function close() {
  if (save.isPending.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃集成修改？',
      description: '关闭后清空尚未保存的连接配置。',
      confirmText: '关闭并清空',
    }))
  )
    return;
  if (!active()) return;
  editorOpen.value = false;
  editing.value = null;
  fill();
  guard.markClean();
}
const save = useMutation({
  mutationFn: async () => {
    const current = editing.value;
    if (props.kind === 'github') {
      if (current) {
        const body: GitHubConnectionUpdate = {
          revision: current.revision,
          name: form.name.trim(),
          credentialRefId: form.credentialRefId,
        };
        return api.update<GitHubConnection>(path.value + '/' + current.id, body);
      }
      const body: GitHubConnectionInput = {
        name: form.name.trim(),
        credentialRefId: form.credentialRefId,
      };
      return api.create<GitHubConnection>(path.value, body);
    }
    if (props.kind === 'registries') {
      if (form.pushCredentialRefId === form.pullCredentialRefId)
        throw new Error('推送与运行拉取必须使用两个不同的凭证引用。');
      if (current) {
        const body: RegistryConnectionUpdate = {
          revision: current.revision,
          name: form.name.trim(),
          pushCredentialRefId: form.pushCredentialRefId,
          pullCredentialRefId: form.pullCredentialRefId,
        };
        return api.update<RegistryConnection>(path.value + '/' + current.id, body);
      }
      const body: RegistryConnectionInput = {
        name: form.name.trim(),
        authority: form.authority.trim(),
        namespace: form.namespace.trim(),
        pushCredentialRefId: form.pushCredentialRefId,
        pullCredentialRefId: form.pullCredentialRefId,
      };
      return api.create<RegistryConnection>(path.value, body);
    }
    const profile = {
      buildkitVersion: form.buildkitVersion.trim(),
      frontendDigest: form.frontendDigest.trim(),
    };
    if (current) {
      const body: BuilderUpdate = {
        revision: current.revision,
        name: form.name.trim(),
        endpoint: form.endpoint.trim(),
        credentialRefId: form.credentialRefId,
        profile,
        enabled: form.enabled,
      };
      return api.update<Builder>(path.value + '/' + current.id, body);
    }
    const body: BuilderInput = {
      name: form.name.trim(),
      instanceId: form.instanceId.trim(),
      identityPublicKey: form.identityPublicKey.trim(),
      endpoint: form.endpoint.trim(),
      credentialRefId: form.credentialRefId,
      profile,
    };
    return api.create<Builder>(path.value, body);
  },
  onSuccess: async () => {
    editorOpen.value = false;
    editing.value = null;
    fill();
    guard.markClean();
    await invalidateCollection(path.value);
    if (active()) ui.toast('连接配置已保存，请单独检查当前认证与能力。');
  },
});
const verify = useMutation({
  mutationFn: (input: { item: Integration; key?: string }): Promise<Operation | Integration> =>
    props.kind === 'registries'
      ? api.create<Operation>(
          path.value + '/' + input.item.id + '/verify',
          { revision: input.item.revision },
          input.key,
        )
      : api.create<Integration>(path.value + '/' + input.item.id + '/verify', {
          revision: input.item.revision,
        }),
  onSuccess: async (value) => {
    await invalidateCollection(path.value);
    if (!active()) return;
    if ('kind' in value) {
      latestOperation.value = value;
      await invalidateCollection('/operations');
    } else ui.toast('检查结果已更新。');
  },
});
const verificationKeys = new Map<string, string>();
async function check(item: Integration) {
  if (auth.restoreMode || verify.isPending.value) return;
  if (props.kind === 'registries') {
    if (
      !(await ui.confirm({
        title: '执行 Registry 推送与拉取检查？',
        description:
          '将在此连接的平台专用探针 repository 写入小型 OCI 镜像，分别验证推送身份、运行拉取身份，以及拉取身份确实不能推送。此操作有持久任务记录。',
        confirmText: '执行推送与拉取检查',
      }))
    )
      return;
  }
  if (!active()) return;
  const token = item.id + ':' + item.revision;
  if (!verificationKeys.has(token)) verificationKeys.set(token, idempotencyKey());
  verify.mutate({ item, key: verificationKeys.get(token) });
}
const locked = computed(() => auth.restoreMode || save.isPending.value || verify.isPending.value);
</script>
<template>
  <div class="stack">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>{{ titles[kind] }}</h2>
          <p v-if="kind === 'github'" class="meta mt-1">
            Fine-grained PAT 选择所需仓库，并授予 Metadata / Contents 读取权限；Webhook 管理另需
            Webhooks 写权限。
          </p>
          <p v-else-if="kind === 'registries'" class="meta mt-1">
            构建产物推送与运行镜像拉取使用独立身份，分别记录检查结果。
          </p>
          <p v-else class="meta mt-1">
            登记独立 Linux Builder 的稳定实例身份、mTLS 连接及固定构建工具配置。
          </p>
        </div>
        <div class="actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新集成连接"
            :disabled="items.isFetching.value"
            @click="items.refetch()"
            ><RefreshCw
          /></Button>
          <Button :disabled="locked" @click="open()"><Plus />新增连接</Button>
        </div>
      </div>
      <form
        v-if="editorOpen"
        ref="formElement"
        class="integration-editor mb-6"
        @submit.prevent="save.mutate()"
      >
        <h3 class="font-medium mb-4">{{ editing ? '编辑连接与当前认证' : '登记新连接' }}</h3>
        <fieldset class="integration-fields" :disabled="locked">
          <div class="form-grid">
            <div class="field">
              <label for="integration-name">连接名称</label
              ><Input id="integration-name" v-model="form.name" required maxlength="120" />
            </div>
            <SecretReferencePicker
              v-if="kind === 'github'"
              v-model="form.credentialRefId"
              kind="git"
              label="GitHub fine-grained PAT 凭证"
              required
              :disabled="locked"
            />
            <template v-if="kind === 'registries'">
              <div class="field">
                <label for="registry-authority">Registry 地址</label
                ><Input
                  id="registry-authority"
                  v-model="form.authority"
                  class="mono"
                  required
                  maxlength="253"
                  :readonly="!!editing"
                  placeholder="ghcr.io"
                />
                <p class="field-hint">仅 authority，登记后固定。</p>
              </div>
              <div class="field">
                <label for="registry-namespace">固定命名空间</label
                ><Input
                  id="registry-namespace"
                  v-model="form.namespace"
                  class="mono"
                  required
                  maxlength="255"
                  :readonly="!!editing"
                  placeholder="my-team"
                />
              </div>
              <SecretReferencePicker
                v-model="form.pushCredentialRefId"
                kind="registry"
                label="构建产物推送凭证"
                required
                :disabled="locked"
              />
              <SecretReferencePicker
                v-model="form.pullCredentialRefId"
                kind="registry"
                label="运行时镜像拉取凭证"
                required
                :disabled="locked"
              />
            </template>
            <template v-if="kind === 'builders'">
              <div class="field">
                <label for="builder-endpoint">Builder HTTPS 地址</label
                ><Input
                  id="builder-endpoint"
                  v-model="form.endpoint"
                  type="url"
                  class="mono"
                  required
                  maxlength="2048"
                  placeholder="https://builder.example.com"
                />
              </div>
              <SecretReferencePicker
                v-model="form.credentialRefId"
                kind="builder"
                label="Builder mTLS 连接凭证"
                required
                :disabled="locked"
              />
              <div class="field">
                <label for="builder-instance">固定实例 ID</label
                ><Input
                  id="builder-instance"
                  v-model="form.instanceId"
                  class="mono"
                  required
                  maxlength="36"
                  :readonly="!!editing"
                />
                <p class="field-hint">使用 Builder 安装输出的 UUID，更换实例需新建连接。</p>
              </div>
              <div class="field">
                <label for="builder-version">BuildKit 版本</label
                ><Input
                  id="builder-version"
                  v-model="form.buildkitVersion"
                  class="mono"
                  required
                  maxlength="64"
                />
              </div>
              <div class="field">
                <label for="builder-frontend">Dockerfile frontend digest</label
                ><Input
                  id="builder-frontend"
                  v-model="form.frontendDigest"
                  class="mono"
                  required
                  pattern="sha256:[0-9a-f]{64}"
                />
              </div>
            </template>
          </div>
          <div v-if="kind === 'builders'" class="field mt-4">
            <label for="builder-public-key">实例身份签名公钥</label
            ><textarea
              id="builder-public-key"
              v-model="form.identityPublicKey"
              class="input mono"
              rows="4"
              required
              maxlength="2048"
              :readonly="!!editing"
              spellcheck="false"
            />
            <p class="field-hint">
              从该 Builder 安装资料核对公钥，地址或 mTLS 轮换仍须匹配此实例身份。
            </p>
          </div>
          <label v-if="kind === 'builders' && editing" class="flex gap-2 items-center mt-4"
            ><input v-model="form.enabled" type="checkbox" />启用此 Builder</label
          >
        </fieldset>
        <MutationError class="mt-4" :error="save.error.value" />
        <div class="form-footer">
          <Button type="button" variant="outline" :disabled="save.isPending.value" @click="close"
            >取消编辑</Button
          >
          <Button type="submit" :disabled="locked"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />保存连接配置</Button
          >
        </div>
      </form>
      <MutationError class="mb-5" :error="verify.error.value" />
      <p v-if="latestOperation" class="notice mb-5">
        检查任务已受理。<RouterLink :to="'/operations/' + latestOperation.id" class="text-link"
          >查看真实检查结果</RouterLink
        >
      </p>
      <QueryState
        :pending="items.isPending.value"
        :error="items.error.value"
        @retry="items.refetch()"
      >
        <ul class="integration-list">
          <li v-for="item in items.items.value" :key="item.id">
            <div class="section-head">
              <div>
                <h3 class="font-medium break-all">{{ item.name }}</h3>
                <p v-if="'authorization' in item" class="meta mt-1">
                  {{ item.account ? item.account.login + ' · ' + item.account.id : '账号尚未验证' }}
                  · fine-grained PAT
                </p>
                <p v-else-if="'pushVerification' in item" class="meta mono mt-1 break-all">
                  {{ item.authority }}/{{ item.namespace }}
                </p>
                <p v-else class="meta mono mt-1 break-all">
                  {{ item.endpoint }} · {{ item.enabled ? '已启用' : '已停用' }}
                </p>
              </div>
              <div class="actions">
                <Button variant="outline" :disabled="locked" @click="open(item)"
                  >编辑或替换凭证</Button
                >
                <Button variant="outline" :disabled="locked" @click="check(item)">{{
                  kind === 'registries'
                    ? '执行推送与拉取检查'
                    : kind === 'builders'
                      ? '验证身份与能力'
                      : '验证当前授权'
                }}</Button>
              </div>
            </div>
            <div v-if="'pushVerification' in item" class="integration-checks">
              <div>
                <IntegrationCheck label="构建推送" :check="item.pushVerification" />
                <p class="meta mono mt-2 break-all">凭证 {{ item.pushCredentialRefId }}</p>
              </div>
              <div>
                <IntegrationCheck label="运行拉取与只读权限" :check="item.pullVerification" />
                <p class="meta mono mt-2 break-all">凭证 {{ item.pullCredentialRefId }}</p>
              </div>
            </div>
            <template v-else>
              <IntegrationCheck
                :label="'authorization' in item ? 'GitHub 授权' : 'Builder 身份与能力'"
                :check="item.verification"
              />
              <p class="meta mono mt-2 break-all">凭证 {{ item.credentialRefId }}</p>
              <div v-if="'profile' in item" class="meta mt-3">
                <p>
                  实例 {{ item.instanceId }} · 配置 r{{ item.profileRevision }} · BuildKit
                  {{ item.profile.buildkitVersion }}
                </p>
                <p v-if="item.capabilities" class="mt-1">
                  已验证平台 {{ item.capabilities.platform.os }}/{{
                    item.capabilities.platform.architecture
                  }}
                  · 最大并发 {{ item.capabilities.maxConcurrency }}
                </p>
                <p v-else class="mt-1">尚无已验证的执行能力。</p>
                <p v-if="item.capabilities" class="mt-1">
                  Builder 代际 {{ item.capabilities.highGeneration }} / 控制面核对代际
                  {{ item.capabilities.controlPlaneGenerationAtCheck }}
                </p>
              </div>
              <Button
                v-if="'authorization' in item"
                variant="ghost"
                class="mt-3"
                :disabled="hasUnsavedChanges()"
                @click="selectedGithub = item"
                >查看授权仓库与 Webhook</Button
              >
            </template>
          </li>
        </ul>
        <p v-if="!items.items.value.length && !items.error.value" class="meta py-5">
          尚未登记{{ titles[kind] }}。先保存相应凭证，再登记连接并单独验证。
        </p>
        <Button
          v-if="items.hasNextPage.value"
          variant="outline"
          :disabled="items.isFetchingNextPage.value"
          @click="items.fetchNextPage()"
          >载入更多连接</Button
        >
      </QueryState>
    </section>
    <GitHubRepositories
      v-if="selectedGithub && kind === 'github'"
      :key="selectedGithub.id"
      :connection="selectedGithub"
    />
  </div>
</template>
<style scoped>
.integration-fields {
  border: 0;
  padding: 0;
  min-width: 0;
}
.integration-editor {
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.integration-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.integration-list > li {
  padding: 1.5rem 0;
}
.integration-list > li + li {
  border-top: 1px solid var(--border);
}
.integration-checks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
@media (max-width: 640px) {
  .integration-checks {
    grid-template-columns: 1fr;
  }
}
</style>
