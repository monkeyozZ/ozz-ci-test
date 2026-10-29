<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, reactive, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { KeyRound, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import MutationError from '@/components/MutationError.vue';
import CredentialContent from './CredentialContent.vue';
import { api } from '@/lib/api';
import { invalidateCollection } from '@/lib/query';
import { idempotencyKey } from '@/lib/utils';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import type { SecretReference } from '@/lib/types';

const props = withDefaults(defineProps<{ defaultName?: string; disabled?: boolean }>(), {
  defaultName: '',
  disabled: false,
});
const emit = defineEmits<{ created: [secret: SecretReference]; close: [] }>();
const ui = useUiStore();
const auth = useAuthStore();
const isViewActive = useViewScope();
const form = reactive({
  name: props.defaultName,
  method: 'private_key' as 'private_key' | 'password',
  privateKey: '',
  passphrase: '',
  password: '',
});
const guard = useDirtyForm(form, '新 SSH 凭证');
let key = idempotencyKey();
watch(form, () => {
  key = idempotencyKey();
});
function clear() {
  form.privateKey = '';
  form.passphrase = '';
  form.password = '';
}
onScopeDispose(clear);
onMounted(async () => {
  await nextTick();
  document.getElementById('ssh-credential-name')?.focus();
});
const save = useMutation({
  mutationFn: () =>
    api.create<SecretReference>(
      '/secrets',
      {
        name: form.name.trim(),
        kind: 'ssh',
        payload:
          form.method === 'private_key'
            ? {
                privateKey: form.privateKey,
                ...(form.passphrase ? { passphrase: form.passphrase } : {}),
              }
            : { password: form.password },
      },
      key,
    ),
  onSuccess: async (value) => {
    clear();
    guard.markClean();
    await invalidateCollection('/secrets');
    if (!isViewActive()) return;
    emit('created', value);
    ui.toast('SSH 凭证已加密保存。保存服务器登记后即可使用这个引用。');
  },
});
async function close() {
  if (save.isPending.value) return;
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃 SSH 凭证输入？',
      description: '尚未保存的私钥和密码会被清空。',
      confirmText: '清空并关闭',
    }))
  )
    return;
  if (!isViewActive()) return;
  clear();
  guard.markClean();
  emit('close');
}
</script>

<template>
  <form class="panel" aria-label="新增 SSH 凭证" @submit.prevent="save.mutate()">
    <h2 class="flex items-center gap-2 mb-5"><KeyRound class="size-5" />新增 SSH 凭证</h2>
    <fieldset class="stack" :disabled="disabled || auth.restoreMode || save.isPending.value">
      <div class="form-grid">
        <div class="field">
          <label for="ssh-credential-name">SSH 凭证名称</label
          ><Input
            id="ssh-credential-name"
            v-model="form.name"
            required
            maxlength="120"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="ssh-credential-method">认证方式</label
          ><select id="ssh-credential-method" v-model="form.method" class="input">
            <option value="private_key">SSH 私钥</option>
            <option value="password">SSH 密码</option>
          </select>
        </div>
      </div>
      <template v-if="form.method === 'private_key'">
        <CredentialContent
          id="ssh-credential-key"
          v-model="form.privateKey"
          kind="ssh_private_key"
          :disabled="disabled || auth.restoreMode || save.isPending.value"
        />
        <div class="field">
          <label for="ssh-credential-passphrase">私钥口令 <span class="meta">（选填）</span></label
          ><Input
            id="ssh-credential-passphrase"
            v-model="form.passphrase"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
          />
        </div>
      </template>
      <div v-else class="field">
        <label for="ssh-credential-password">SSH 登录密码</label
        ><Input
          id="ssh-credential-password"
          v-model="form.password"
          type="password"
          required
          autocomplete="new-password"
          maxlength="4096"
        />
        <p class="field-hint">仅用于连接已登记的 SSH 主机，保存后不会回显。</p>
      </div>
    </fieldset>
    <MutationError class="mt-4" :error="save.error.value" />
    <div class="form-footer">
      <Button type="button" variant="outline" :disabled="save.isPending.value" @click="close"
        >取消并清空</Button
      ><Button type="submit" :disabled="disabled || auth.restoreMode || save.isPending.value"
        ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
          save.isPending.value ? '正在加密保存…' : '加密保存 SSH 凭证'
        }}</Button
      >
    </div>
  </form>
</template>
