<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, Info, Trash2, LoaderCircle, Server as ServerIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import ServerOnboarding from '@/components/infrastructure/ServerOnboarding.vue';
import SshCredentialEditor from '@/components/infrastructure/SshCredentialEditor.vue';
import { bytesLabel } from '@/components/infrastructure/format';
import { api } from '@/lib/api';
import { queryClient, useCollection, invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { resourceListPath } from '@/lib/resource-list-navigation';
import type { Server, SecretReference } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const listLocation = computed(
  () => resourceListPath(route.query.list, 'infrastructure') ?? '/infrastructure?tab=servers',
);
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const serverId = String(route.params.serverId ?? '');
const editing = !!serverId;
const server = useQuery({
  queryKey: ['server', serverId],
  enabled: editing,
  queryFn: ({ signal }) => api.get<Server>(`/servers/${serverId}`, signal),
});
const secrets = useCollection<SecretReference>('/secrets', { kind: 'ssh' });
const form = reactive({
  name: '',
  host: '',
  sshPort: 22 as number | string,
  sshUser: '',
  region: '',
  credentialRefId: '',
  tags: '',
  revision: 1,
});
const guard = useDirtyForm(form, '服务器登记');
const reloading = ref(false);
const operationBusy = ref(false);
const credentialEditorOpen = ref(false);
async function closeCredentialEditor() {
  credentialEditorOpen.value = false;
  await nextTick();
  document.getElementById('server-credential')?.focus();
}
function credentialCreated(value: SecretReference) {
  form.credentialRefId = value.id;
  void closeCredentialEditor();
}
async function refreshServer() {
  await Promise.all([server.refetch(), invalidateCollection('/servers')]);
}
const key = idempotencyKey();
function fill(value: Server) {
  Object.assign(form, {
    name: value.name,
    host: value.host,
    sshPort: value.sshPort,
    sshUser: value.sshUser,
    region: value.region ?? '',
    credentialRefId: value.credentialRefId ?? '',
    tags: value.tags.join(', '),
    revision: value.revision,
  });
  guard.markClean();
}
watch(
  server.data,
  (value) => {
    if (value && !guard.dirty.value) fill(value);
  },
  { immediate: true },
);
const save = useMutation({
  mutationFn: () => {
    const body = {
      name: form.name,
      host: form.host,
      sshPort: Number(form.sshPort),
      sshUser: form.sshUser,
      region: form.region || null,
      credentialRefId: form.credentialRefId || null,
      tags: [
        ...new Set(
          form.tags
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
    };
    return editing
      ? api.update<Server>(`/servers/${serverId}`, { ...body, revision: form.revision })
      : api.create<Server>('/servers', body, key);
  },
  onSuccess: async (value) => {
    fill(value);
    queryClient.setQueryData(['server', value.id], value);
    await invalidateCollection('/servers');
    if (!isViewActive()) return;
    ui.toast('服务器登记已保存，SSH 状态以最近一次预检为准。');
    if (!editing) await router.replace(`/servers/${value.id}`);
  },
});
const remove = useMutation({
  mutationFn: (revision: number) => api.delete(`/servers/${serverId}`, revision),
  onSuccess: async () => {
    guard.abandon();
    queryClient.removeQueries({ queryKey: ['server', serverId] });
    await invalidateCollection('/servers');
    if (!isViewActive()) return;
    await router.push('/infrastructure?tab=servers');
    ui.toast('服务器登记已移除。');
  },
});
async function deleteServer() {
  const reviewedRevision = server.data.value?.revision;
  if (!reviewedRevision) return;
  if (
    await ui.confirm({
      title: `移除服务器「${server.data.value?.name}」？`,
      description:
        '移除控制台里的主机地址与凭证引用不会停止应用或卸载远端软件。仍关联节点或在途任务时，会拒绝移除。',
      confirmText: '移除登记',
      destructive: true,
    })
  )
    if (isViewActive()) remove.mutate(reviewedRevision);
}
async function reload() {
  if (save.isPending.value || reloading.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新服务器资料？',
      description: '当前未保存的编辑将被最新资料替换。',
      confirmText: '载入最新资料',
    }))
  )
    return;
  if (!isViewActive()) return;
  reloading.value = true;
  try {
    const result = await server.refetch();
    if (result.data && isViewActive()) {
      fill(result.data);
      save.reset();
    }
  } finally {
    reloading.value = false;
  }
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink :to="listLocation" class="text-link">服务器</RouterLink><ChevronRight /><span>{{
      editing ? '服务器登记' : '登记服务器'
    }}</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>{{ editing ? (server.data.value?.name ?? '服务器登记') : '登记服务器' }}</h1>
      <p>
        {{
          editing
            ? '核对 SSH 身份、检查主机环境，并连接项目的承载集群。'
            : '保存主机连接资料与 SSH 凭证引用。'
        }}
      </p>
    </div>
    <StatusBadge v-if="editing && server.data.value" :status="server.data.value.connectionStatus" />
  </div>
  <QueryState
    :pending="editing && server.isPending.value"
    :error="server.error.value"
    @retry="server.refetch()"
    ><div v-if="!editing || server.data.value" class="split">
      <div class="stack">
        <ServerOnboarding
          v-if="editing && server.data.value"
          :server="server.data.value"
          :disabled="
            save.isPending.value || reloading || remove.isPending.value || credentialEditorOpen
          "
          :metadata-dirty="guard.dirty.value"
          @changed="refreshServer"
          @busy="operationBusy = $event"
        />
        <SshCredentialEditor
          v-if="credentialEditorOpen"
          :default-name="form.name ? `${form.name} · SSH` : 'SSH 访问凭证'"
          :disabled="operationBusy"
          @created="credentialCreated"
          @close="closeCredentialEditor"
        />
        <form class="panel" @submit.prevent="save.mutate()">
          <div class="section-head">
            <h2>服务器资料</h2>
            <span v-if="guard.dirty.value" class="badge">尚未保存</span>
          </div>
          <fieldset
            class="stack"
            :disabled="
              save.isPending.value ||
              reloading ||
              auth.restoreMode ||
              operationBusy ||
              credentialEditorOpen
            "
          >
            <div class="form-grid">
              <div class="field">
                <label for="server-name">服务器名称</label
                ><Input
                  id="server-name"
                  v-model="form.name"
                  required
                  maxlength="120"
                  placeholder="例如：新加坡应用机"
                />
              </div>
              <div class="field">
                <label for="server-region">地区 <span class="meta">（选填）</span></label
                ><Input
                  id="server-region"
                  v-model="form.region"
                  maxlength="80"
                  placeholder="例如：新加坡"
                />
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="server-host">地址 / IP</label
                ><Input
                  id="server-host"
                  v-model="form.host"
                  required
                  maxlength="253"
                  placeholder="app.example.com"
                  autocomplete="off"
                  aria-describedby="server-host-hint"
                />
                <p id="server-host-hint" class="field-hint">
                  只填写主机名或 IP，不包含协议和端口。
                </p>
              </div>
              <div class="field">
                <label for="server-port">SSH 端口</label
                ><Input
                  id="server-port"
                  v-model="form.sshPort"
                  type="number"
                  required
                  min="1"
                  max="65535"
                  step="1"
                  inputmode="numeric"
                />
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="server-user">SSH 用户</label
                ><Input
                  id="server-user"
                  v-model="form.sshUser"
                  required
                  maxlength="64"
                  placeholder="ubuntu"
                  autocomplete="off"
                />
              </div>
              <div class="field">
                <label for="server-credential">SSH 凭证 <span class="meta">（选填）</span></label
                ><select
                  id="server-credential"
                  v-model="form.credentialRefId"
                  class="input"
                  :disabled="secrets.isPending.value"
                >
                  <option value="">稍后添加凭证</option>
                  <option
                    v-if="
                      form.credentialRefId &&
                      !secrets.items.value.some((item) => item.id === form.credentialRefId)
                    "
                    :value="form.credentialRefId"
                  >
                    当前引用 · {{ form.credentialRefId }}
                  </option>
                  <option v-for="secret in secrets.items.value" :key="secret.id" :value="secret.id">
                    {{ secret.name }}
                  </option>
                </select>
                <p class="field-hint">
                  仅使用 SSH 类型引用。<RouterLink to="/settings" class="text-link"
                    >管理凭证</RouterLink
                  >
                </p>
                <Button type="button" variant="ghost" size="sm" @click="credentialEditorOpen = true"
                  >新增 SSH 凭证</Button
                >
                <p v-if="secrets.error.value" class="field-error">
                  凭证列表暂不可用，请到设置重新载入。
                </p>
                <Button
                  v-if="secrets.hasNextPage.value"
                  type="button"
                  variant="ghost"
                  size="sm"
                  @click="secrets.fetchNextPage()"
                  >载入更多凭证</Button
                >
              </div>
            </div>
            <div class="field">
              <label for="server-tags">标签 <span class="meta">（选填）</span></label
              ><Input
                id="server-tags"
                v-model="form.tags"
                maxlength="1200"
                placeholder="production, singapore"
              />
              <p class="field-hint">逗号分隔，最多 20 个标签，每个不超过 64 字符。</p>
            </div>
          </fieldset>
          <MutationError class="mt-4" :error="save.error.value" />
          <div class="form-footer">
            <Button
              v-if="editing"
              type="button"
              variant="outline"
              :disabled="save.isPending.value || reloading"
              @click="reload"
              >载入最新资料</Button
            ><Button v-else as-child variant="outline"
              ><RouterLink :to="listLocation">取消</RouterLink></Button
            ><Button
              type="submit"
              :disabled="
                save.isPending.value ||
                reloading ||
                auth.restoreMode ||
                operationBusy ||
                credentialEditorOpen ||
                (editing && !guard.dirty.value)
              "
              ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
                save.isPending.value ? '正在保存…' : '保存服务器登记'
              }}</Button
            >
          </div>
        </form>
        <section v-if="editing" class="panel">
          <h2>移除登记</h2>
          <p class="muted mt-2 mb-5">受其他资源引用的服务器需要先处理关联关系。</p>
          <MutationError class="mb-4" :error="remove.error.value" /><Button
            variant="destructive"
            :disabled="
              remove.isPending.value || auth.restoreMode || operationBusy || credentialEditorOpen
            "
            @click="deleteServer"
            ><Trash2 />移除服务器登记</Button
          >
        </section>
      </div>
      <aside class="stack">
        <section class="panel">
          <h2 class="mb-4 flex items-center gap-2"><ServerIcon class="size-5" />连接记录</h2>
          <StatusBadge :status="server.data.value?.connectionStatus" />
          <dl class="detail-list mt-3">
            <div>
              <dt>SSH 身份</dt>
              <dd>
                {{ server.data.value?.hostKey.trustedFingerprint ? '已保存可信指纹' : '尚未核对' }}
              </dd>
            </div>
            <div>
              <dt>最近预检</dt>
              <dd>{{ dateTime(server.data.value?.preflightAt) }}</dd>
            </div>
            <div>
              <dt>主机规格</dt>
              <dd>
                {{
                  server.data.value?.preflight
                    ? `${server.data.value.preflight.cpuCount} 核 / ${bytesLabel(server.data.value.preflight.memoryBytes)}`
                    : '尚无采集结果'
                }}
              </dd>
            </div>
          </dl>
        </section>
        <div class="notice">
          <Info />
          <p>
            服务器保存主机连接资料。项目的承载目标是集群，登记服务器后不会直接成为可选择的项目目标。
          </p>
        </div>
      </aside>
    </div></QueryState
  >
</template>
