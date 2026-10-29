<script setup lang="ts">
import { reactive, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { LoaderCircle, Info } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import type { PlatformSettings } from './types';

const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const consoleOrigin = location.origin;
const settings = useQuery({
  queryKey: ['platform-settings'],
  queryFn: ({ signal }) => api.get<PlatformSettings>('/platform-settings', signal),
});
const form = reactive({ revision: 0, appsDomainSuffix: '', acmeEmail: '' });
const guard = useDirtyForm(form, '平台入口设置');
function setForm(value: PlatformSettings) {
  Object.assign(form, {
    revision: value.revision,
    appsDomainSuffix: value.appsDomainSuffix ?? '',
    acmeEmail: value.acmeEmail ?? '',
  });
  guard.markClean();
}
watch(
  settings.data,
  (value) => {
    if (value && !guard.dirty.value) setForm(value);
  },
  { immediate: true },
);
const save = useMutation({
  mutationFn: () =>
    api.update<PlatformSettings>('/platform-settings', {
      revision: form.revision,
      appsDomainSuffix: form.appsDomainSuffix.trim() || null,
      acmeEmail: form.acmeEmail.trim() || null,
    }),
  onSuccess: async (value) => {
    setForm(value);
    queryClient.setQueryData(['platform-settings'], value);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['cluster-networking'] }),
      queryClient.invalidateQueries({ queryKey: ['service-networking'] }),
    ]);
    if (active()) ui.toast('平台入口设置已保存。');
  },
});
async function reload() {
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新平台设置？',
      description: '本页尚未保存的应用后缀和联系邮箱会被替换。',
      confirmText: '载入最新设置',
    }))
  )
    return;
  const result = await settings.refetch();
  if (result.data && active()) {
    setForm(result.data);
    save.reset();
  }
}
</script>
<template>
  <section class="panel" data-platform-networking-settings>
    <div class="section-head">
      <div>
        <h2>平台入口</h2>
        <p class="meta mt-1">管理控制台与应用入口分别配置。</p>
      </div>
    </div>
    <QueryState
      :pending="settings.isPending.value"
      :error="settings.error.value"
      @retry="settings.refetch()"
    >
      <form
        v-if="settings.data.value"
        @submit.prevent="
          !auth.restoreMode && !save.isPending.value && guard.dirty.value && save.mutate()
        "
      >
        <fieldset class="stack" :disabled="auth.restoreMode || save.isPending.value">
          <div class="field">
            <label for="network-console-origin">当前控制台地址</label>
            <input id="network-console-origin" class="input" :value="consoleOrigin" readonly />
            <p class="field-hint">来自当前访问地址。管理 HTTPS 在部署入口中配置。</p>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="network-apps-suffix">默认应用后缀</label>
              <Input
                id="network-apps-suffix"
                v-model="form.appsDomainSuffix"
                placeholder="例如 apps.example.com"
                autocomplete="off"
                autocapitalize="off"
                :spellcheck="false"
                maxlength="253"
              />
              <p class="field-hint">各集群使用独立子后缀。已有域名不会自动迁移。</p>
            </div>
            <div class="field">
              <label for="network-acme-email">ACME 联系邮箱</label>
              <Input
                id="network-acme-email"
                v-model="form.acmeEmail"
                type="email"
                autocomplete="email"
                placeholder="接收证书服务通知的邮箱"
                maxlength="254"
              />
              <p class="field-hint">用于证书服务的账户联系信息。</p>
            </div>
          </div>
        </fieldset>
        <div
          v-if="!settings.data.value.appsDomainSuffix || !settings.data.value.acmeEmail"
          class="notice mt-5"
        >
          <Info aria-hidden="true" />
          <p>配置应用后缀和联系邮箱后，再为集群设置应用入口。</p>
        </div>
        <MutationError :error="save.error.value" class="mt-5" />
        <div class="form-footer">
          <p class="meta mr-auto" role="status">
            {{
              guard.dirty.value
                ? '有未保存的更改'
                : settings.data.value.updatedAt
                  ? `已保存 r${settings.data.value.revision} · ${dateTime(settings.data.value.updatedAt)}`
                  : '尚未保存平台入口'
            }}
          </p>
          <Button
            type="button"
            variant="outline"
            :disabled="save.isPending.value || settings.isFetching.value"
            @click="reload"
            >载入最新设置</Button
          >
          <Button
            type="submit"
            :disabled="auth.restoreMode || save.isPending.value || !guard.dirty.value"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '保存平台设置'
            }}</Button
          >
        </div>
      </form>
    </QueryState>
  </section>
</template>
