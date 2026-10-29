<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { ChevronRight, Plus, Trash2, GitBranch } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import MutationError from '@/components/MutationError.vue';
import SecretReferencePicker from './SecretReferencePicker.vue';
import { useCollection } from '@/lib/query';
import { useGitBranches, useGitRepositories } from './queries';
import type { Builder, GitHubConnection, GitSourceDraft, RegistryConnection } from './types';
const form = defineModel<GitSourceDraft>({ required: true });
const props = defineProps<{ disabled?: boolean; creating?: boolean; compact?: boolean }>();
const uid = useId();
const root = ref<HTMLElement>();
const connections = useCollection<GitHubConnection>('/integrations/github');
const repositories = useGitRepositories(() => form.value.connectionId);
const branches = useGitBranches(
  () => form.value.connectionId,
  () => form.value.repositoryId,
);
const builders = useCollection<Builder>('/integrations/builders');
const registries = useCollection<RegistryConnection>('/integrations/registries');
const registry = computed(() =>
  registries.items.value.find((item) => item.id === form.value.registryConnectionId),
);
const branch = computed(() =>
  branches.items.value.find((item) => item.ref === form.value.branchRef),
);
const builder = computed(() =>
  builders.items.value.find((item) => item.id === form.value.builderId),
);
function changeConnection() {
  form.value.repositoryId = '';
  form.value.branchRef = '';
}
function changeRepository() {
  form.value.branchRef = '';
}
function addArgument() {
  form.value.buildArgs.push({ rowId: crypto.randomUUID(), name: '', value: '' });
}
function addSecret() {
  form.value.buildSecrets.push({
    rowId: crypto.randomUUID(),
    mountId: '',
    secretRefId: '',
    secretKey: 'value',
  });
}
async function validate() {
  const invalid = root.value?.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input:invalid, select:invalid, textarea:invalid');
  if (invalid) {
    let details = invalid.closest('details');
    while (details) {
      details.open = true;
      details = details.parentElement?.closest('details') ?? null;
    }
    await nextTick();
    invalid.focus();
    invalid.reportValidity();
    return false;
  }
  if (!repositories.items.value.some((item) => item.id === form.value.repositoryId))
    throw new Error('请从当前授权列表选择仓库，必要时载入更多仓库。');
  if (
    repositories.error.value ||
    branches.error.value ||
    repositories.isFetching.value ||
    branches.isFetching.value
  )
    throw new Error('请等待仓库与分支检查完成，或重试失败的授权读取。');
  if (!branch.value) throw new Error('请从当前仓库重新选择已授权分支。');
  return true;
}
defineExpose({ validate });
</script>
<template>
  <fieldset
    ref="root"
    class="git-source-fields"
    :class="{ 'git-source-compact': compact }"
    :disabled="disabled"
    data-git-source-editor
  >
    <legend class="sr-only">GitHub 来源与构建配置</legend>
    <div class="section-head">
      <div>
        <h2>GitHub 来源</h2>
        <p v-if="!compact" class="meta mt-1">保存来源后，再审阅固定提交并发布。</p>
      </div>
      <RouterLink to="/settings?tab=git" class="text-link">管理 Git 与构建集成</RouterLink>
    </div>
    <div class="form-grid">
      <div class="field">
        <label :for="uid + '-connection'">GitHub 授权</label>
        <select
          :id="uid + '-connection'"
          v-model="form.connectionId"
          class="input"
          required
          @change="changeConnection"
        >
          <option value="">选择 GitHub 连接</option>
          <option
            v-if="
              form.connectionId &&
              !connections.items.value.some((item) => item.id === form.connectionId)
            "
            :value="form.connectionId"
          >
            当前连接 · {{ form.connectionId }}
          </option>
          <option v-for="item in connections.items.value" :key="item.id" :value="item.id">
            {{ item.name }}{{ item.account ? ' · ' + item.account.login : '' }}
          </option>
        </select>
        <MutationError :error="connections.error.value" />
        <Button
          v-if="connections.error.value"
          type="button"
          variant="ghost"
          @click="connections.refetch()"
          >重新读取授权</Button
        >
        <Button
          v-if="connections.hasNextPage.value"
          type="button"
          variant="ghost"
          @click="connections.fetchNextPage()"
          >载入更多连接</Button
        >
      </div>
      <div class="field">
        <label :for="uid + '-repository'">授权仓库</label>
        <select
          :id="uid + '-repository'"
          v-model="form.repositoryId"
          class="input"
          required
          :disabled="!form.connectionId || repositories.isFetching.value"
          @change="changeRepository"
        >
          <option value="">
            {{ repositories.isFetching.value ? '正在读取授权仓库…' : '选择已授权仓库' }}
          </option>
          <option
            v-if="
              form.repositoryId &&
              !repositories.items.value.some((item) => item.id === form.repositoryId)
            "
            :value="form.repositoryId"
            disabled
          >
            当前仓库尚未出现在授权列表
          </option>
          <option v-for="item in repositories.items.value" :key="item.id" :value="item.id">
            {{ item.fullName }}
          </option>
        </select>
        <MutationError :error="repositories.error.value" />
        <Button
          v-if="repositories.error.value"
          type="button"
          variant="ghost"
          @click="repositories.refetch()"
          >重新读取仓库</Button
        >
        <Button
          v-if="repositories.hasNextPage.value"
          type="button"
          variant="ghost"
          :disabled="repositories.isFetchingNextPage.value"
          @click="repositories.fetchNextPage()"
          >载入更多仓库</Button
        >
      </div>
      <div class="field">
        <label :for="uid + '-branch'">跟踪分支</label>
        <select
          :id="uid + '-branch'"
          v-model="form.branchRef"
          class="input"
          required
          :disabled="!form.repositoryId || branches.isFetching.value"
        >
          <option value="">{{ branches.isFetching.value ? '正在读取分支…' : '选择分支' }}</option>
          <option v-if="form.branchRef && !branch" :value="form.branchRef" disabled>
            {{ form.branchRef }} · 等待核对
          </option>
          <option v-for="item in branches.items.value" :key="item.ref" :value="item.ref">
            {{ item.name }}
          </option>
        </select>
        <p v-if="branch && !compact" class="field-hint mono break-all">
          <GitBranch class="inline size-3.5" /> {{ branch.commitSha }}
        </p>
        <p v-if="!compact" class="field-hint">这里显示当前观察，发布预览会固定完整 commit。</p>
        <MutationError :error="branches.error.value" />
        <Button
          v-if="branches.error.value"
          type="button"
          variant="ghost"
          @click="branches.refetch()"
          >重新读取分支</Button
        >
        <Button
          v-if="branches.hasNextPage.value"
          type="button"
          variant="ghost"
          :disabled="branches.isFetchingNextPage.value"
          @click="branches.fetchNextPage()"
          >载入更多分支</Button
        >
      </div>
      <div class="field">
        <label :for="uid + '-dockerfile'">Dockerfile 路径</label>
        <Input
          :id="uid + '-dockerfile'"
          v-model="form.dockerfilePath"
          class="mono"
          required
          maxlength="500"
          placeholder="Dockerfile"
        />
        <p class="field-hint">
          {{
            compact
              ? '仓库必须包含该 Dockerfile，路径相对于仓库根目录。'
              : '相对于仓库根目录，发布前核对所选 commit 中的实际文件。'
          }}
        </p>
      </div>
      <div v-if="!compact" class="field">
        <label :for="uid + '-context'">构建上下文</label>
        <Input
          :id="uid + '-context'"
          v-model="form.contextPath"
          class="mono"
          required
          maxlength="500"
          placeholder="."
        />
        <p class="field-hint">使用仓库内目录；“.” 表示仓库根目录。</p>
      </div>
    </div>
    <div class="section-head mt-7">
      <div>
        <h2>{{ compact ? '构建设置' : '构建与镜像去向' }}</h2>
        <p v-if="!compact" class="meta mt-1">Builder 执行构建，服务仍发布到项目继承的 Cluster。</p>
      </div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label :for="uid + '-builder'">独立 Builder</label>
        <select :id="uid + '-builder'" v-model="form.builderId" class="input" required>
          <option value="">选择已登记的 Builder</option>
          <option v-if="form.builderId && !builder" :value="form.builderId">
            当前 Builder · {{ form.builderId }}
          </option>
          <option
            v-for="item in builders.items.value"
            :key="item.id"
            :value="item.id"
            :disabled="!item.enabled"
          >
            {{ item.name }}{{ !item.enabled ? '（已停用）' : '' }}
          </option>
        </select>
        <p v-if="builder" class="field-hint">
          {{
            builder.capabilities
              ? builder.capabilities.platform.os + '/' + builder.capabilities.platform.architecture
              : '尚无已验证的架构能力'
          }}
        </p>
        <MutationError :error="builders.error.value" />
        <Button
          v-if="builders.error.value"
          type="button"
          variant="ghost"
          @click="builders.refetch()"
          >重新读取 Builder</Button
        >
        <Button
          v-if="builders.hasNextPage.value"
          type="button"
          variant="ghost"
          @click="builders.fetchNextPage()"
          >载入更多 Builder</Button
        >
      </div>
      <div class="field">
        <label :for="uid + '-registry'">产物 Registry</label>
        <select :id="uid + '-registry'" v-model="form.registryConnectionId" class="input" required>
          <option value="">选择镜像仓库连接</option>
          <option v-if="form.registryConnectionId && !registry" :value="form.registryConnectionId">
            当前连接 · {{ form.registryConnectionId }}
          </option>
          <option v-for="item in registries.items.value" :key="item.id" :value="item.id">
            {{ item.name }} · {{ item.authority }}/{{ item.namespace }}
          </option>
        </select>
        <MutationError :error="registries.error.value" />
        <Button
          v-if="registries.error.value"
          type="button"
          variant="ghost"
          @click="registries.refetch()"
          >重新读取 Registry</Button
        >
        <Button
          v-if="registries.hasNextPage.value"
          type="button"
          variant="ghost"
          @click="registries.fetchNextPage()"
          >载入更多 Registry</Button
        >
      </div>
      <div class="field">
        <label :for="uid + '-image'">镜像名称</label>
        <Input
          :id="uid + '-image'"
          v-model="form.imageRepository"
          class="mono"
          required
          maxlength="255"
          placeholder="my-app"
        />
        <p class="field-hint break-all">
          {{
            registry
              ? registry.authority + '/' + registry.namespace + '/'
              : '相对于所选 Registry 命名空间。'
          }}{{ registry ? form.imageRepository : '' }}
        </p>
      </div>
      <fieldset class="field architecture-options">
        <legend>固定构建架构</legend>
        <label
          ><input v-model="form.architectures" type="checkbox" value="amd64" /> Linux / amd64</label
        >
        <label
          ><input v-model="form.architectures" type="checkbox" value="arm64" /> Linux / arm64</label
        >
        <p v-if="Object.keys(form.variants).length" class="field-hint">
          保留来源已有平台变体：{{
            Object.entries(form.variants)
              .map(([architecture, variant]) => architecture + '/' + variant)
              .join('、')
          }}
        </p>
        <p class="field-hint">重试保留所选架构，发布时另行核对目标节点。</p>
      </fieldset>
    </div>
    <details class="git-advanced mt-6">
      <summary>
        <ChevronRight v-if="compact" />{{ compact ? '更多构建设置' : '构建参数与秘密挂载' }}
      </summary>
      <div v-if="compact" class="field mt-4">
        <label :for="uid + '-context'">构建上下文</label>
        <Input
          :id="uid + '-context'"
          v-model="form.contextPath"
          class="mono"
          required
          maxlength="500"
          placeholder="."
        />
        <p class="field-hint">使用仓库内目录；“.” 表示仓库根目录。</p>
      </div>
      <p class="meta mt-4">
        普通构建参数只填写非敏感值。构建秘密须明确选择，运行变量不会自动传入构建。
      </p>
      <div v-for="row in form.buildArgs" :key="row.rowId" class="git-argument mt-4">
        <div class="field">
          <label :for="row.rowId + '-name'">构建参数名</label
          ><Input :id="row.rowId + '-name'" v-model="row.name" required maxlength="128" />
        </div>
        <div class="field">
          <label :for="row.rowId + '-value'">普通参数值</label
          ><Input :id="row.rowId + '-value'" v-model="row.value" maxlength="4096" />
        </div>
        <Button
          type="button"
          variant="ghost"
          :aria-label="'删除构建参数 ' + (row.name || '未命名')"
          @click="form.buildArgs = form.buildArgs.filter((item) => item.rowId !== row.rowId)"
          ><Trash2
        /></Button>
      </div>
      <Button
        type="button"
        variant="outline"
        class="mt-4"
        :disabled="form.buildArgs.length >= 64"
        @click="addArgument"
        ><Plus />添加普通构建参数</Button
      >
      <div v-for="row in form.buildSecrets" :key="row.rowId" class="git-secret mt-5">
        <div class="form-grid">
          <div class="field">
            <label :for="row.rowId + '-mount'">秘密挂载 ID</label
            ><Input :id="row.rowId + '-mount'" v-model="row.mountId" required maxlength="64" />
          </div>
          <SecretReferencePicker
            v-model="row.secretRefId"
            kind="generic"
            label="构建秘密引用"
            required
            :disabled="props.disabled"
          />
          <div class="field">
            <label :for="row.rowId + '-key'">秘密字段</label
            ><Input :id="row.rowId + '-key'" v-model="row.secretKey" required maxlength="128" />
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          @click="form.buildSecrets = form.buildSecrets.filter((item) => item.rowId !== row.rowId)"
          ><Trash2 />删除此秘密挂载</Button
        >
      </div>
      <Button
        type="button"
        variant="outline"
        class="mt-4"
        :disabled="form.buildSecrets.length >= 32"
        @click="addSecret"
        ><Plus />添加构建秘密</Button
      >
      <p class="field-hint mt-3">
        Dockerfile 使用 RUN --mount=type=secret,id=挂载ID。保存来源时固定秘密内容版本。
      </p>
      <label v-if="creating && compact" class="git-policy mt-6">
        <input v-model="form.autoDeploy" type="checkbox" />
        <span>
          <strong>启用此分支的自动发布</strong>
          <small
            >还需在集成设置明确注册
            Webhook。停止期间收到提交只记录待办，恢复原版本不会消费待办。</small
          >
        </span>
      </label>
    </details>
    <label v-if="creating && !compact" class="git-policy mt-6">
      <input v-model="form.autoDeploy" type="checkbox" />
      <span
        ><strong>启用此分支的自动发布</strong
        ><small
          >还需在集成设置明确注册
          Webhook。停止期间收到提交只记录待办，恢复原版本不会消费待办。</small
        ></span
      >
    </label>
  </fieldset>
</template>
<style scoped>
.git-source-fields,
.architecture-options {
  border: 0;
  padding: 0;
  min-width: 0;
}
.architecture-options label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
}
.git-advanced {
  border-top: 1px solid var(--border);
  padding-top: 1.25rem;
}
.git-advanced summary {
  cursor: pointer;
  font-weight: 550;
  min-height: 2.75rem;
}
.git-source-compact .git-advanced > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  list-style: none;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  font-weight: 400;
}
.git-source-compact .git-advanced > summary::-webkit-details-marker {
  display: none;
}
.git-source-compact .git-advanced > summary > svg {
  width: 1rem;
  height: 1rem;
}
.git-source-compact .git-advanced[open] > summary > svg {
  transform: rotate(90deg);
}
.git-source-compact .git-policy {
  padding: 1rem 0 0;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
}
.git-argument {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 0.75rem;
  align-items: end;
}
.git-secret {
  border: 1px solid var(--border);
  padding: 1rem;
  border-radius: 0.5rem;
}
.git-policy {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.git-policy input {
  margin-top: 0.25rem;
}
.git-policy small {
  display: block;
  color: var(--muted-foreground);
  margin-top: 0.375rem;
}
@media (max-width: 640px) {
  .git-argument {
    grid-template-columns: 1fr;
  }
}
</style>
