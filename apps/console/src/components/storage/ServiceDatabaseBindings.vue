<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { LoaderCircle, Unplug, Search, Eye, Link2, Pencil, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import type { Service } from '@/components/services/types';
import { serviceLocation } from '@/components/services/presentation';
import { api } from '@/lib/api';
import { queryClient, useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { useDirtyForm } from '@/composables/useDirtyForm';
import {
  databaseBindings,
  previewDatabaseBinding,
  saveDatabaseBinding,
  detachDatabaseBinding,
  invalidateStorage,
} from './queries';
import type {
  Database,
  DatabaseBinding,
  DatabaseBindingInput,
  DatabaseBindingPreview,
  DatabaseOutputKey,
  DatabaseOutputMapping,
} from './types';
import { databaseState, engineLabel } from './presentation';
import StorageMutationError from './StorageMutationError.vue';
import StorageIssues from './StorageIssues.vue';
const props = defineProps<{ service: Service }>();
const route = useRoute();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const prefix = useId();
const bindings = useQuery({
  queryKey: computed(() => ['service-database-bindings', props.service.id]),
  queryFn: ({ signal }) => databaseBindings(props.service.id, signal),
  refetchInterval: 15_000,
});
const initialForm = () => ({
  databaseInstanceId: typeof route.query.databaseId === 'string' ? route.query.databaseId : '',
  profile: 'fields' as 'fields' | 'url',
  mapping: { host: '', port: '', database: '', user: '', password: '', db: '', url: '' } as Record<
    DatabaseOutputKey,
    string
  >,
});
const form = ref(initialForm());
const guard = useDirtyForm(form, '数据库连接草稿');
const baseRevision = ref(0);
const search = ref('');
const localError = ref<Error | null>(null);
const params = computed<Record<string, string>>(() => ({
  projectId: props.service.projectId,
  environmentId: props.service.environmentId,
  clusterId: props.service.clusterId,
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const databases = useCollection<Database>('/databases', params);
const provider = useQuery({
  queryKey: computed(() => ['database', form.value.databaseInstanceId]),
  enabled: computed(() => !!form.value.databaseInstanceId),
  queryFn: ({ queryKey, signal }) => api.get<Database>(`/databases/${queryKey[1]}`, signal),
  refetchInterval: 15_000,
});
const providerReady = computed(
  () =>
    !!provider.data.value?.service &&
    provider.data.value.service.id !== props.service.id &&
    provider.data.value.projectId === props.service.projectId &&
    provider.data.value.environmentId === props.service.environmentId &&
    provider.data.value.clusterId === props.service.clusterId &&
    provider.data.value.databaseReady &&
    !provider.data.value.observationStale &&
    !!provider.data.value.observation?.authenticated,
);
const fieldKeys = computed<DatabaseOutputKey[]>(() =>
  form.value.profile === 'url'
    ? ['url']
    : provider.data.value?.engine === 'redis'
      ? ['host', 'port', 'db', 'password']
      : ['host', 'port', 'database', 'user', 'password'],
);
const outputLabels: Record<DatabaseOutputKey, string> = {
  host: '私有主机',
  port: '端口',
  database: '数据库名',
  user: '用户',
  password: '密码（秘密引用）',
  db: 'Redis 逻辑库',
  url: '完整连接 URI（秘密引用）',
};
watch(
  bindings.data,
  (value) => {
    if (value && (!baseRevision.value || !guard.dirty.value))
      baseRevision.value = value.serviceRevision;
  },
  { immediate: true },
);
watch(
  () => provider.data.value?.engine,
  (engine) => {
    if (!engine) return;
    const defaults: Record<DatabaseOutputKey, string> =
      engine === 'postgresql'
        ? {
            host: 'DB_HOST',
            port: 'DB_PORT',
            database: 'DB_NAME',
            user: 'DB_USER',
            password: 'DB_PASSWORD',
            db: 'REDIS_DB',
            url: 'DATABASE_URL',
          }
        : {
            host: 'REDIS_HOST',
            port: 'REDIS_PORT',
            database: 'DB_NAME',
            user: 'DB_USER',
            password: 'REDIS_PASSWORD',
            db: 'REDIS_DB',
            url: 'REDIS_URL',
          };
    for (const key of Object.keys(defaults) as DatabaseOutputKey[])
      if (!form.value.mapping[key]) form.value.mapping[key] = defaults[key];
  },
);
const mapping = computed<DatabaseOutputMapping>(() =>
  Object.fromEntries(fieldKeys.value.map((key) => [key, form.value.mapping[key].trim()])),
);
const fingerprint = computed(() =>
  JSON.stringify({
    revision: baseRevision.value,
    databaseInstanceId: form.value.databaseInstanceId,
    profile: form.value.profile,
    mapping: mapping.value,
    providerRevision: provider.data.value?.revision,
  }),
);
const reviewed = ref<{
  value: DatabaseBindingPreview;
  input: DatabaseBindingInput;
  fingerprint: string;
} | null>(null);
const staleRevision = computed(
  () => !!bindings.data.value && bindings.data.value.serviceRevision !== baseRevision.value,
);
const stale = computed(
  () =>
    staleRevision.value || (!!reviewed.value && reviewed.value.fingerprint !== fingerprint.value),
);
const preview = useMutation({
  mutationFn: (input: { body: DatabaseBindingInput; fingerprint: string }) =>
    previewDatabaseBinding(props.service.id, input.body),
  onSuccess: (value, input) => {
    if (active()) reviewed.value = { value, input: input.body, fingerprint: input.fingerprint };
  },
});
const save = useMutation({
  mutationFn: (input: DatabaseBindingInput) => saveDatabaseBinding(props.service.id, input),
  onSuccess: async (collection) => {
    queryClient.setQueryData(['service-database-bindings', props.service.id], collection);
    await invalidateStorage(props.service.id);
    if (!active()) return;
    form.value = initialForm();
    form.value.databaseInstanceId = '';
    guard.markClean();
    reviewed.value = null;
    baseRevision.value = collection.serviceRevision;
    ui.toast('连接草稿已保存，发布应用后才会注入数据库连接。');
  },
});
const detach = useMutation({
  mutationFn: (input: { bindingId: string; revision: number }) =>
    detachDatabaseBinding(props.service.id, input.bindingId, input.revision),
  onSuccess: async (collection) => {
    queryClient.setQueryData(['service-database-bindings', props.service.id], collection);
    await invalidateStorage(props.service.id);
    if (active()) ui.toast('连接草稿已解除，当前已发布应用继续使用原配置。');
  },
});
const locked = computed(
  () =>
    auth.restoreMode ||
    !!props.service.activeTask ||
    save.isPending.value ||
    detach.isPending.value,
);
function edit(binding: DatabaseBinding) {
  form.value.databaseInstanceId = binding.databaseInstanceId;
  form.value.profile = binding.profile;
  form.value.mapping = { ...initialForm().mapping, ...binding.mapping };
  baseRevision.value = bindings.data.value?.serviceRevision ?? props.service.revision;
  reviewed.value = null;
}
async function recheck() {
  const result = await bindings.refetch();
  if (active() && result.isSuccess) baseRevision.value = result.data.serviceRevision;
}
function createPreview() {
  if (
    !providerReady.value ||
    !baseRevision.value ||
    locked.value ||
    preview.isPending.value ||
    staleRevision.value
  )
    return;
  localError.value = null;
  const names = Object.values(mapping.value);
  if (new Set(names).size !== names.length) {
    localError.value = new Error('每个数据库输出需要使用不同的环境变量名。');
    return;
  }
  preview.mutate({
    fingerprint: fingerprint.value,
    body: {
      revision: baseRevision.value,
      databaseInstanceId: form.value.databaseInstanceId,
      profile: form.value.profile,
      mapping: mapping.value,
    },
  });
}
function saveReviewed() {
  if (
    reviewed.value &&
    !stale.value &&
    providerReady.value &&
    !locked.value &&
    !preview.isPending.value &&
    !reviewed.value.value.issues.some((issue) => issue.blocks === 'save' || issue.blocks === 'both')
  )
    save.mutate(reviewed.value.input);
}
</script>
<template>
  <section class="panel" data-service-database-bindings>
    <div class="section-head">
      <div>
        <h2>数据库连接草稿</h2>
        <p class="meta mt-2">仅连接同项目、同环境的私有数据库，最多 8 个绑定</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="刷新数据库连接"
        :disabled="bindings.isFetching.value"
        @click="bindings.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <QueryState
      :pending="bindings.isPending.value"
      :error="bindings.error.value"
      @retry="bindings.refetch()"
      ><ul v-if="bindings.data.value?.data.length" class="binding-list">
        <li v-for="binding in bindings.data.value.data" :key="binding.id">
          <div class="binding-heading">
            <div class="min-w-0">
              <RouterLink
                :to="`/databases/${binding.databaseInstanceId}`"
                class="text-link font-medium"
                >{{ binding.provider.name }}</RouterLink
              >
              <p class="meta mt-2">
                {{ engineLabel(binding.provider.engine) }} ·
                {{ binding.profile === 'url' ? '秘密 URI 引用' : '字段映射' }}
              </p>
              <div class="flex gap-2 flex-wrap mt-2">
                <span class="badge">{{ binding.desired ? '草稿引用' : '草稿已解除' }}</span
                ><span v-if="binding.published" class="badge badge-primary">已发布引用</span>
              </div>
            </div>
            <div class="actions">
              <Button
                v-if="binding.desired"
                type="button"
                variant="outline"
                size="sm"
                :disabled="locked"
                @click="edit(binding)"
                ><Pencil />编辑映射</Button
              ><Button
                v-if="binding.desired"
                type="button"
                variant="outline"
                size="sm"
                :disabled="locked"
                @click="
                  detach.mutate({
                    bindingId: binding.id,
                    revision: bindings.data.value!.serviceRevision,
                  })
                "
                ><Unplug />解除草稿连接</Button
              >
            </div>
          </div>
          <p class="mono text-sm mt-3">
            {{
              Object.entries(binding.mapping)
                .map(([output, name]) => `${output} → ${name}`)
                .join(' · ')
            }}
          </p>
          <StorageIssues :issues="binding.issues" class="mt-4" title="连接检查" />
        </li>
      </ul>
      <p v-else class="meta">此应用还没有数据库连接草稿。</p></QueryState
    >
    <StorageMutationError :error="detach.error.value" class="mt-5" />
    <form class="binding-form mt-6" @submit.prevent="createPreview">
      <h3 class="mb-5">添加或更新连接</h3>
      <fieldset :disabled="locked">
        <legend class="sr-only">数据库连接映射</legend>
        <div class="field">
          <label :for="`${prefix}-search`">查找同环境数据库</label>
          <div class="relative">
            <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
              :id="`${prefix}-search`"
              v-model="search"
              class="pl-10"
              placeholder="搜索数据库名称"
            />
          </div>
        </div>
        <div class="field mt-4">
          <label :for="`${prefix}-provider`">数据库</label
          ><select
            :id="`${prefix}-provider`"
            v-model="form.databaseInstanceId"
            required
            class="input"
          >
            <option value="" disabled>选择已发布并通过认证检查的数据库</option>
            <option
              v-if="
                provider.data.value &&
                !databases.items.value.some((item) => item.id === provider.data.value!.id)
              "
              :value="provider.data.value.id"
              :disabled="!providerReady"
            >
              {{ provider.data.value.service?.name ?? provider.data.value.originalService.name }}
            </option>
            <option
              v-for="database in databases.items.value"
              :key="database.id"
              :value="database.id"
              :disabled="
                !database.service ||
                database.service.id === service.id ||
                !database.databaseReady ||
                !database.observation?.authenticated ||
                database.observationStale
              "
            >
              {{ database.service?.name ?? database.originalService.name }} ·
              {{ engineLabel(database.engine) }} · {{ databaseState(database).label }}
            </option></select
          ><Button
            v-if="databases.hasNextPage.value"
            type="button"
            variant="ghost"
            class="self-start"
            :disabled="databases.isFetchingNextPage.value"
            @click="databases.fetchNextPage()"
            >载入更多同环境数据库</Button
          >
        </div>
        <QueryState
          class="mt-4"
          :pending="
            databases.isPending.value || (!!form.databaseInstanceId && provider.isPending.value)
          "
          :error="databases.error.value || provider.error.value"
          @retry="
            databases.refetch();
            if (form.databaseInstanceId) provider.refetch();
          "
          ><p v-if="provider.data.value && !providerReady" class="field-error">
            所选数据库当前不能连接。需核对归属、有效提供方、认证结果与观察时效。
          </p></QueryState
        >
        <div class="field mt-5">
          <label :for="`${prefix}-profile`">注入方式</label
          ><select :id="`${prefix}-profile`" v-model="form.profile" class="input">
            <option value="fields">分别映射连接字段</option>
            <option value="url">映射受控 URI 秘密引用</option>
          </select>
        </div>
        <div v-if="provider.data.value" class="mapping-fields mt-5">
          <div v-for="key in fieldKeys" :key="key" class="field">
            <label :for="`${prefix}-${key}`">{{ outputLabels[key] }} → 环境变量</label
            ><Input
              :id="`${prefix}-${key}`"
              v-model="form.mapping[key]"
              required
              pattern="[a-zA-Z_][a-zA-Z0-9_]*"
              maxlength="128"
              class="mono"
            />
          </div>
        </div>
      </fieldset>
      <p class="field-hint mt-4">
        页面不显示密码或含密码 URI。变量冲突需要显式处理；保存连接不会发布或重启应用。
      </p>
      <div v-if="staleRevision" class="notice notice-warning mt-5">
        <div>
          <strong>应用版本已变化</strong>
          <p class="mt-1">填写的映射保留，请核对最新草稿后重新预览。</p>
          <Button
            type="button"
            variant="outline"
            class="mt-3"
            :disabled="bindings.isFetching.value"
            @click="recheck"
            >载入当前版本</Button
          >
        </div>
      </div>
      <StorageMutationError
        :error="localError || preview.error.value || save.error.value"
        class="mt-5"
      />
      <div class="form-footer">
        <RouterLink :to="serviceLocation(service, 'review')" class="text-link"
          >审阅已保存的配置</RouterLink
        ><Button
          type="submit"
          variant="outline"
          :disabled="
            locked || preview.isPending.value || !providerReady || !baseRevision || staleRevision
          "
          ><LoaderCircle v-if="preview.isPending.value" class="animate-spin" /><Eye
            v-else
          />预览连接变更</Button
        >
      </div>
    </form>
    <section v-if="reviewed" class="binding-preview mt-6" data-database-binding-preview>
      <div class="section-head">
        <h3>连接变更预览</h3>
        <span v-if="stale" class="badge badge-warning">已变化，请重新预览</span>
      </div>
      <StorageIssues :issues="reviewed.value.issues" title="映射检查" class="mb-5" />
      <ul class="variable-diff">
        <li v-for="variable in reviewed.value.variables" :key="variable.name">
          <span class="mono font-medium">{{ variable.name }}</span
          ><span class="meta"
            >{{ variable.change === 'add' ? '新增' : '替换' }} · {{ variable.output }} ·
            {{ variable.secret ? '秘密引用' : '非敏感连接字段' }}</span
          >
        </li>
      </ul>
      <p class="field-hint mt-4">仅保存映射与依赖。发布应用时固定提供方身份和凭证版本。</p>
      <Button
        type="button"
        class="mt-5"
        :disabled="
          locked ||
          preview.isPending.value ||
          !providerReady ||
          stale ||
          reviewed.value.issues.some((issue) => issue.blocks === 'save' || issue.blocks === 'both')
        "
        @click="saveReviewed"
        ><LoaderCircle v-if="save.isPending.value" class="animate-spin" /><Link2
          v-else
        />保存连接草稿</Button
      >
    </section>
  </section>
</template>
<style scoped>
.binding-list {
  display: grid;
  gap: 1rem;
}
.binding-list > li {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow-wrap: anywhere;
}
.binding-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
}
.binding-form,
.binding-preview {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
}
.binding-form fieldset {
  min-width: 0;
  padding: 0;
  border: 0;
}
.mapping-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.variable-diff {
  display: grid;
  gap: 0.75rem;
}
.variable-diff li {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem;
  background: var(--secondary);
  border-radius: 0.5rem;
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .mapping-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
