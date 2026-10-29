<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import {
  Plus,
  KeyRound,
  Trash2,
  ShieldCheck,
  Sun,
  Moon,
  Monitor,
  LoaderCircle,
  Eye,
  EyeOff,
  RefreshCw,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import EmptyState from '@/components/EmptyState.vue';
import PlatformNetworkingSettings from '@/components/networking/PlatformNetworkingSettings.vue';
import ClusterNetworkingSettings from '@/components/networking/ClusterNetworkingSettings.vue';
import GitBuildIntegrations from '@/components/git/GitBuildIntegrations.vue';
import { api } from '@/lib/api';
import { useCollection, invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { useActiveTabVisibility } from '@/composables/useActiveTabVisibility';
import { dateTime, idempotencyKey } from '@/lib/utils';
import type { SecretKind, SecretReference } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const showNetworking = computed(() => route.query.tab === 'network');
const showGit = computed(() => route.query.tab === 'git');
const settingsNavigation = useActiveTabVisibility(() => route.query.tab);
const auth = useAuthStore();
const ui = useUiStore();
const secrets = useCollection<SecretReference>('/secrets');
const editorOpen = ref(false);
const visible = ref(false);
const form = reactive({
  name: '',
  kind: 'ssh' as SecretKind,
  value: '',
  username: '',
  passphrase: '',
  caCertificate: '',
  clientCertificate: '',
  clientPrivateKey: '',
  expiresAt: '',
});
const guard = useDirtyForm(() => (editorOpen.value ? form : null), '凭证');
let key = idempotencyKey();
const kinds: { value: SecretKind; label: string; valueLabel: string }[] = [
  { value: 'ssh', label: 'SSH 私钥', valueLabel: '私钥内容' },
  { value: 'kubeconfig', label: 'Kubernetes 配置', valueLabel: 'kubeconfig 内容' },
  { value: 'git', label: 'GitHub fine-grained PAT', valueLabel: 'Fine-grained PAT' },
  { value: 'registry', label: '镜像仓库', valueLabel: '仓库密码或令牌' },
  { value: 'database', label: '数据库', valueLabel: '数据库密码' },
  { value: 'generic', label: '通用凭证', valueLabel: '凭证内容' },
  { value: 'webhook', label: 'Webhook 验签密钥', valueLabel: 'Base64url 验签密钥' },
  { value: 'builder', label: 'Builder mTLS 连接', valueLabel: 'mTLS 凭证' },
];
const selectedKind = computed(() => kinds.find((kind) => kind.value === form.kind)!);
const save = useMutation({
  gcTime: 0,
  mutationFn: () => {
    const payload =
      form.kind === 'ssh'
        ? { privateKey: form.value, ...(form.passphrase ? { passphrase: form.passphrase } : {}) }
        : form.kind === 'kubeconfig'
          ? { kubeconfig: form.value }
          : form.kind === 'git'
            ? { token: form.value }
            : form.kind === 'builder'
              ? {
                  caCertificate: form.caCertificate,
                  clientCertificate: form.clientCertificate,
                  clientPrivateKey: form.clientPrivateKey,
                }
              : form.kind === 'webhook'
                ? { secret: form.value }
                : form.kind === 'registry' || form.kind === 'database'
                  ? { username: form.username, password: form.value }
                  : { value: form.value };
    return api.create<SecretReference>(
      '/secrets',
      {
        name: form.name,
        kind: form.kind,
        payload,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      },
      key,
    );
  },
  onSuccess: async () => {
    clearForm();
    editorOpen.value = false;
    guard.markClean();
    await invalidateCollection('/secrets');
    if (!isViewActive()) return;
    ui.toast('凭证已加密保存，普通查询仅返回引用资料。');
  },
});
const remove = useMutation({
  mutationFn: (secret: SecretReference) => api.delete(`/secrets/${secret.id}`, secret.revision),
  onSuccess: async () => {
    await invalidateCollection('/secrets');
    if (!isViewActive()) return;
    ui.toast('凭证引用已删除。');
  },
});
function clearForm() {
  form.name = '';
  form.value = '';
  form.username = '';
  form.passphrase = '';
  form.caCertificate = '';
  form.clientCertificate = '';
  form.clientPrivateKey = '';
  form.expiresAt = '';
  visible.value = false;
}
onBeforeUnmount(clearForm);
async function openEditor() {
  if (save.isPending.value) return;
  editorOpen.value = true;
  key = idempotencyKey();
  save.reset();
  guard.markClean();
  await nextTick();
  document.getElementById('secret-name')?.focus();
}
async function closeEditor() {
  if (save.isPending.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃凭证输入？',
      description: '关闭后会清空尚未保存的凭证内容。',
      confirmText: '清空并关闭',
    }))
  )
    return;
  clearForm();
  editorOpen.value = false;
  guard.markClean();
}
async function deleteSecret(secret: SecretReference) {
  if (
    await ui.confirm({
      title: `删除凭证「${secret.name}」？`,
      description: '正在被服务器、集群或其他资源引用的凭证无法删除。',
      confirmText: '删除凭证',
      destructive: true,
    })
  )
    if (isViewActive()) remove.mutate(secret);
}
function kindLabel(kind: SecretKind) {
  return kinds.find((item) => item.value === kind)?.label ?? kind;
}
function expired(secret: SecretReference) {
  return secret.expiresAt && new Date(secret.expiresAt).valueOf() < Date.now();
}
function generateWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  form.value = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  visible.value = false;
}
watch(
  () => route.query.new,
  async (kind) => {
    const choice = kinds.find((item) => item.value === kind);
    if (choice && !auth.restoreMode && !editorOpen.value) {
      form.kind = choice.value;
      await openEditor();
    }
  },
  { immediate: true },
);
</script>
<template>
  <div class="page-head">
    <div>
      <h1>设置与凭证</h1>
      <p>管理平台入口、Git 与构建集成、外观偏好和连接凭证。</p>
    </div>
  </div>
  <nav ref="settingsNavigation" class="page-tabs" aria-label="设置页面">
    <RouterLink
      to="/settings?tab=network"
      class="page-tab"
      :aria-current="showNetworking ? 'page' : undefined"
      >平台与集群入口</RouterLink
    >
    <RouterLink to="/settings?tab=git" class="page-tab" :aria-current="showGit ? 'page' : undefined"
      >Git 与构建</RouterLink
    >
    <RouterLink
      to="/settings"
      class="page-tab"
      :aria-current="!showNetworking && !showGit ? 'page' : undefined"
      >外观与凭证</RouterLink
    >
  </nav>
  <div v-if="showNetworking" class="stack">
    <PlatformNetworkingSettings />
    <ClusterNetworkingSettings />
  </div>
  <GitBuildIntegrations v-else-if="showGit" />
  <div v-else class="stack">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>外观</h2>
          <p class="meta mt-1">仅保存在此浏览器，不影响当前编辑内容。</p>
        </div>
      </div>
      <fieldset class="theme-options">
        <legend class="sr-only">选择外观主题</legend>
        <label
          v-for="choice in [
            { value: 'light', label: '浅色', icon: Sun },
            { value: 'dark', label: '深色', icon: Moon },
            { value: 'system', label: '跟随系统', icon: Monitor },
          ]"
          :key="choice.value"
          :class="['theme-option', { selected: ui.theme === choice.value }]"
          ><input
            v-model="ui.theme"
            type="radio"
            name="appearance"
            :value="choice.value"
          /><component :is="choice.icon" class="size-5" /><span>{{ choice.label }}</span></label
        >
      </fieldset>
    </section>
    <section>
      <div class="section-head">
        <div>
          <h2>连接凭证</h2>
          <p class="meta mt-1">凭证内容加密保存，只展示类型、名称和有效期。</p>
        </div>
        <div class="actions">
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新凭证"
            :disabled="secrets.isFetching.value"
            @click="secrets.refetch()"
            ><RefreshCw /></Button
          ><Button v-if="!auth.restoreMode && !editorOpen" @click="openEditor"
            ><Plus />新增凭证</Button
          >
        </div>
      </div>
      <form v-if="editorOpen" class="panel mb-6" @submit.prevent="save.mutate()">
        <h2 class="mb-5">新增凭证</h2>
        <fieldset class="stack" :disabled="save.isPending.value || auth.restoreMode">
          <div class="form-grid">
            <div class="field">
              <label for="secret-name">凭证名称</label
              ><Input
                id="secret-name"
                v-model="form.name"
                required
                maxlength="120"
                placeholder="便于辨认的名称"
                autocomplete="off"
              />
            </div>
            <div class="field">
              <label for="secret-kind">类型</label
              ><select
                id="secret-kind"
                v-model="form.kind"
                class="input"
                @change="
                  form.value = '';
                  form.passphrase = '';
                  form.username = '';
                  form.caCertificate = '';
                  form.clientCertificate = '';
                  form.clientPrivateKey = '';
                "
              >
                <option v-for="kind in kinds" :key="kind.value" :value="kind.value">
                  {{ kind.label }}
                </option>
              </select>
            </div>
          </div>
          <div v-if="form.kind === 'registry' || form.kind === 'database'" class="field">
            <label for="secret-username">用户名</label
            ><Input
              id="secret-username"
              v-model="form.username"
              required
              autocomplete="off"
              maxlength="200"
            />
          </div>
          <div v-if="form.kind !== 'builder'" class="field">
            <div class="flex items-center justify-between gap-3">
              <label for="secret-value" class="font-medium">{{ selectedKind.valueLabel }}</label
              ><Button
                type="button"
                variant="ghost"
                size="sm"
                :aria-pressed="visible"
                @click="visible = !visible"
                ><component :is="visible ? EyeOff : Eye" />{{
                  visible ? '隐藏内容' : '显示内容'
                }}</Button
              >
            </div>
            <textarea
              v-if="form.kind === 'ssh' || form.kind === 'kubeconfig'"
              id="secret-value"
              v-model="form.value"
              :class="['input mono', { 'masked-content': !visible }]"
              rows="6"
              required
              maxlength="200000"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :aria-label="selectedKind.valueLabel"
            /><Input
              v-else
              id="secret-value"
              v-model="form.value"
              :type="visible ? 'text' : 'password'"
              required
              maxlength="200000"
              autocomplete="new-password"
              :pattern="form.kind === 'webhook' ? '[A-Za-z0-9_-]{32,128}' : undefined"
            />
            <template v-if="form.kind === 'webhook'">
              <p class="field-hint">独立的 32–128 字符 Base64url 密钥，仅用于 Webhook 验签。</p>
              <Button type="button" variant="outline" @click="generateWebhookSecret"
                >生成随机验签密钥</Button
              >
            </template>
            <p class="field-hint">保存后不回显原文。需要更新时，新建凭证并替换资源引用。</p>
          </div>
          <div v-else class="stack">
            <div class="section-head">
              <h3 class="font-medium">Builder mTLS 凭证</h3>
              <Button
                type="button"
                variant="ghost"
                :aria-pressed="visible"
                @click="visible = !visible"
                >{{ visible ? '隐藏凭证内容' : '显示凭证内容' }}</Button
              >
            </div>
            <div
              v-for="field in [
                { key: 'caCertificate' as const, label: 'CA 证书' },
                { key: 'clientCertificate' as const, label: '客户端证书' },
                { key: 'clientPrivateKey' as const, label: '客户端私钥' },
              ]"
              :key="field.key"
              class="field"
            >
              <label :for="'builder-secret-' + field.key">{{ field.label }}</label>
              <textarea
                :id="'builder-secret-' + field.key"
                v-model="form[field.key]"
                rows="5"
                required
                :class="['input mono', { 'masked-content': !visible }]"
                maxlength="32768"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              />
            </div>
            <p class="field-hint">填写 PEM 内容。保存后只返回凭证引用，不回显证书或私钥内容。</p>
          </div>
          <div class="form-grid">
            <div v-if="form.kind === 'ssh'" class="field">
              <label for="secret-passphrase">私钥口令 <span class="meta">（选填）</span></label
              ><Input
                id="secret-passphrase"
                v-model="form.passphrase"
                type="password"
                autocomplete="new-password"
              />
            </div>
            <div class="field">
              <label for="secret-expires">到期时间 <span class="meta">（选填）</span></label
              ><Input id="secret-expires" v-model="form.expiresAt" type="datetime-local" />
              <p class="field-hint">按当前浏览器时区填写。</p>
            </div>
          </div>
        </fieldset>
        <MutationError class="mt-4" :error="save.error.value" />
        <div class="form-footer">
          <Button
            type="button"
            variant="outline"
            :disabled="save.isPending.value"
            @click="closeEditor"
            >取消并清空</Button
          ><Button type="submit" :disabled="save.isPending.value || auth.restoreMode"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '加密保存凭证'
            }}</Button
          >
        </div>
      </form>
      <MutationError class="mb-4" :error="remove.error.value" />
      <QueryState
        :pending="secrets.isPending.value"
        :error="secrets.error.value"
        :refreshing="secrets.isRefetching.value"
        @retry="secrets.refetch()"
        ><div v-if="secrets.items.value.length" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>凭证</th>
                <th>类型</th>
                <th>有效期</th>
                <th class="mobile-hide">保存时间</th>
                <th><span class="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="secret in secrets.items.value" :key="secret.id">
                <td>
                  <strong>{{ secret.name }}</strong>
                  <p class="meta flex items-center gap-1 mt-1">
                    <ShieldCheck class="size-3.5" />已加密保存
                  </p>
                </td>
                <td>{{ kindLabel(secret.kind) }}</td>
                <td>
                  <span v-if="expired(secret)" class="badge badge-warning">已到期</span>
                  <p class="meta">
                    {{ secret.expiresAt ? dateTime(secret.expiresAt) : '未设置到期时间' }}
                  </p>
                </td>
                <td class="meta mobile-hide">{{ dateTime(secret.createdAt) }}</td>
                <td>
                  <Button
                    v-if="!auth.restoreMode"
                    variant="ghost"
                    size="icon"
                    :aria-label="`删除凭证 ${secret.name}`"
                    :disabled="remove.isPending.value"
                    @click="deleteSecret(secret)"
                    ><Trash2
                  /></Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="!secrets.error.value && !editorOpen" class="panel">
          <EmptyState
            :icon="KeyRound"
            title="添加第一个连接凭证"
            description="先保存 SSH 私钥或 kubeconfig，再在服务器与集群中选择对应引用。"
            ><Button v-if="!auth.restoreMode" @click="openEditor"
              ><Plus />新增凭证</Button
            ></EmptyState
          >
        </div>
        <Button
          v-if="secrets.hasNextPage.value"
          class="mt-5"
          variant="outline"
          :disabled="secrets.isFetchingNextPage.value"
          @click="secrets.fetchNextPage()"
          >载入更多凭证</Button
        ></QueryState
      >
    </section>
  </div>
</template>
<style scoped>
.theme-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  border: 0;
  padding: 0;
}
.theme-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.875rem 1.25rem;
  cursor: pointer;
}
.theme-option.selected {
  border-color: var(--primary);
  background: var(--accent);
}
.theme-option input {
  accent-color: var(--primary);
}
.masked-content {
  -webkit-text-security: disc;
}
</style>
