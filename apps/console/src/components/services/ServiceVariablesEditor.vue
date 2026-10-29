<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, useId } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { FileInput, KeyRound, Plus, Trash2, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import MutationError from '@/components/MutationError.vue';
import { useCollection } from '@/lib/query';
import { api } from '@/lib/api';
import type { SecretReference } from '@/lib/types';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { variableDraft } from './presentation';
import type { EnvironmentImport, VariableDraft } from './types';
const variables = defineModel<VariableDraft[]>({ required: true });
defineProps<{ disabled?: boolean }>();
const uid = useId();
const active = useViewScope();
const references = useCollection<SecretReference>('/secrets', { kind: 'generic' });
const importOpen = ref(false);
const text = ref('');
const importResult = ref<EnvironmentImport | null>(null);
const protectImport = ref(true);
const importGuard = useDirtyForm(() => (importOpen.value ? text.value : ''), '.env 导入内容');
const parse = useMutation({
  gcTime: 0,
  mutationFn: (source: string) =>
    api.create<EnvironmentImport>('/services/parse-env', { text: source }),
  onSuccess: (value) => {
    if (active()) importResult.value = value;
  },
});
const duplicateNames = computed(
  () =>
    importResult.value?.variables
      .filter((value) => variables.value.some((row) => row.name === value.name))
      .map((value) => value.name) ?? [],
);
const canImport = computed(
  () =>
    !!importResult.value?.variables.length &&
    !importResult.value.issues.length &&
    !duplicateNames.value.length &&
    variables.value.length + importResult.value.variables.length <= 128,
);
async function addVariable() {
  const row = variableDraft();
  variables.value.push(row);
  await nextTick();
  document.getElementById(`${uid}-${row.rowId}-name`)?.focus();
}
function changeMode(row: VariableDraft) {
  row.value = '';
  row.secretRefId = '';
  row.secretKey = '';
}
function clearImport() {
  text.value = '';
  importResult.value = null;
  importOpen.value = false;
  parse.reset();
  importGuard.markClean();
}
function applyImport() {
  if (!canImport.value || !importResult.value) return;
  variables.value.push(
    ...importResult.value.variables.map((value) => ({
      ...variableDraft(value),
      mode: protectImport.value || value.secret ? ('secret' as const) : ('plain' as const),
    })),
  );
  clearImport();
}
onScopeDispose(() => {
  text.value = '';
  importResult.value = null;
});
</script>
<template>
  <section class="variable-editor" aria-label="环境变量编辑">
    <div class="section-head">
      <div>
        <h2>环境变量</h2>
        <p class="meta mt-1">发布时注入容器。秘密值保存后仅保留加密引用。</p>
      </div>
      <div class="actions">
        <Button
          type="button"
          variant="outline"
          :disabled="disabled"
          @click="importOpen = !importOpen"
          ><FileInput />导入 .env</Button
        ><Button
          type="button"
          variant="outline"
          :disabled="disabled || variables.length >= 128"
          @click="addVariable"
          ><Plus />添加变量</Button
        >
      </div>
    </div>
    <div v-if="importOpen" class="env-import mb-6">
      <div class="section-head">
        <h3>批量导入 .env</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="清空并关闭 .env 导入"
          @click="clearImport"
          ><X
        /></Button>
      </div>
      <label :for="`${uid}-env-source`" class="sr-only">.env 文件内容</label
      ><Textarea
        :id="`${uid}-env-source`"
        v-model="text"
        rows="6"
        spellcheck="false"
        autocomplete="off"
        class="mono"
        placeholder="APP_TITLE=Ozz&#10;API_KEY=…"
        :disabled="disabled || parse.isPending.value"
        @input="importResult = null"
      />
      <p class="meta mt-2">逐行校验，不执行命令或展开变量。最多 24 KiB；重复变量请先处理。</p>
      <label class="check-line mt-3"
        ><input
          v-model="protectImport"
          type="checkbox"
          :disabled="disabled"
        />将导入的值全部作为秘密保存</label
      >
      <MutationError class="mt-3" :error="parse.error.value" />
      <ul v-if="importResult?.issues.length" class="notice notice-danger block mt-3" role="alert">
        <li v-for="issue in importResult.issues" :key="`${issue.line}:${issue.code}`">
          第 {{ issue.line }} 行：{{ issue.message }}
        </li>
      </ul>
      <p v-if="duplicateNames.length" class="text-destructive mt-3" role="alert">
        已存在同名变量：{{ duplicateNames.join('、') }}。导入不会覆盖它们。
      </p>
      <p
        v-if="importResult && variables.length + importResult.variables.length > 128"
        class="text-destructive mt-3"
        role="alert"
      >
        变量总数不能超过 128 个。
      </p>
      <p v-if="importResult && !importResult.issues.length" class="meta mt-3">
        已解析 {{ importResult.variables.length }} 个变量：{{
          importResult.variables.map((variable) => variable.name).join('、')
        }}
      </p>
      <div class="actions mt-4">
        <Button
          type="button"
          variant="outline"
          :disabled="disabled || !text || parse.isPending.value"
          @click="parse.mutate(text)"
          >{{ parse.isPending.value ? '正在校验…' : '解析并检查' }}</Button
        ><Button type="button" :disabled="disabled || !canImport" @click="applyImport"
          >加入当前草稿</Button
        >
      </div>
    </div>
    <div v-if="variables.length" class="variable-rows">
      <div v-for="row in variables" :key="row.rowId" class="variable-row">
        <div class="field">
          <label :for="`${uid}-${row.rowId}-name`">变量名</label
          ><Input
            :id="`${uid}-${row.rowId}-name`"
            v-model="row.name"
            required
            maxlength="128"
            class="mono"
            placeholder="API_KEY"
            :disabled="disabled"
          />
        </div>
        <div class="field">
          <label :for="`${uid}-${row.rowId}-mode`">保存方式</label
          ><select
            :id="`${uid}-${row.rowId}-mode`"
            v-model="row.mode"
            class="input"
            :disabled="disabled"
            @change="changeMode(row)"
          >
            <option value="plain">普通变量</option>
            <option value="secret">新的秘密值</option>
            <option value="reference">已有秘密引用</option>
          </select>
        </div>
        <div v-if="row.mode !== 'reference'" class="field variable-value">
          <label :for="`${uid}-${row.rowId}-value`">{{
            row.mode === 'secret' ? '秘密值' : '变量值'
          }}</label
          ><Input
            :id="`${uid}-${row.rowId}-value`"
            v-model="row.value"
            :type="row.mode === 'secret' ? 'password' : 'text'"
            autocomplete="off"
            maxlength="24576"
            class="mono"
            :disabled="disabled"
          /><span v-if="row.mode === 'secret'" class="meta"
            ><KeyRound class="inline size-3" />保存后不再返回明文</span
          >
        </div>
        <div v-else class="variable-reference variable-value">
          <div class="field">
            <label :for="`${uid}-${row.rowId}-reference`">秘密引用</label
            ><select
              :id="`${uid}-${row.rowId}-reference`"
              v-model="row.secretRefId"
              required
              class="input"
              :disabled="disabled || references.isPending.value"
            >
              <option value="" disabled>选择已保存的秘密</option>
              <option
                v-if="
                  row.secretRefId &&
                  !references.items.value.some((item) => item.id === row.secretRefId)
                "
                :value="row.secretRefId"
              >
                当前引用 · {{ row.secretRefId }}
              </option>
              <option
                v-for="reference in references.items.value"
                :key="reference.id"
                :value="reference.id"
              >
                {{ reference.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label :for="`${uid}-${row.rowId}-key`">秘密键</label
            ><Input
              :id="`${uid}-${row.rowId}-key`"
              v-model="row.secretKey"
              required
              maxlength="128"
              class="mono"
              placeholder="value"
              :disabled="disabled"
            />
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          :aria-label="`删除变量 ${row.name || '未命名'}`"
          :disabled="disabled"
          @click="variables = variables.filter((item) => item.rowId !== row.rowId)"
          ><Trash2
        /></Button>
      </div>
    </div>
    <p v-else class="muted py-8">尚无环境变量。可以逐项添加，或从 .env 导入。</p>
    <Button
      v-if="references.hasNextPage.value"
      type="button"
      variant="ghost"
      class="mt-3"
      :disabled="references.isFetchingNextPage.value"
      @click="references.fetchNextPage()"
      >载入更多秘密引用</Button
    >
  </section>
</template>
<style scoped>
.env-import {
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--secondary);
}
.variable-row {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 0.8fr) minmax(12rem, 1.6fr) auto;
  gap: 1rem;
  align-items: start;
  padding: 1.25rem 0;
  border-bottom: 1px solid var(--border);
}
.variable-row > button {
  margin-top: 1.75rem;
}
.variable-reference {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(6rem, 0.6fr);
  gap: 0.75rem;
}
.check-line {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
@media (max-width: 1000px) {
  .variable-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .variable-value {
    grid-column: 1 / 3;
    grid-row: 2;
  }
  .variable-row > button {
    grid-column: 3;
    grid-row: 1;
  }
}
@media (max-width: 639px) {
  .variable-row {
    gap: 0.75rem;
  }
  .variable-reference {
    grid-template-columns: 1fr;
  }
  .env-import {
    padding: 1rem;
  }
}
</style>
