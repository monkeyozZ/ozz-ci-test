<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { Eye, EyeOff, Upload, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{
    id: string;
    kind: 'kubeconfig' | 'ssh_private_key';
    disabled?: boolean;
    required?: boolean;
    maxBytes?: number;
  }>(),
  { disabled: false, required: true, maxBytes: 200_000 },
);
const model = defineModel<string>({ default: '' });
const label = computed(() => (props.kind === 'kubeconfig' ? 'kubeconfig 内容' : 'SSH 私钥内容'));
const fileInput = ref<HTMLInputElement | null>(null);
const visible = ref(false);
const reading = ref(false);
const fileError = ref('');
const fileLabel = ref('');
let fileEpoch = 0;
let active = true;
onScopeDispose(() => {
  active = false;
  fileEpoch++;
});
watch(model, () => {
  fileEpoch++;
});
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) visible.value = false;
  },
);
async function readFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || props.disabled) return;
  const epoch = ++fileEpoch;
  fileError.value = '';
  fileLabel.value = '';
  if (file.size > props.maxBytes) {
    fileError.value = `文件超过 ${Math.floor(props.maxBytes / 1000)} KB，请使用包含内嵌凭证的单一配置。`;
    return;
  }
  reading.value = true;
  try {
    const value = await file.text();
    if (!active || epoch !== fileEpoch || props.disabled) return;
    if (!value.trim()) {
      fileError.value = '文件为空，请选择有效的凭证文件。';
      return;
    }
    model.value = value;
    visible.value = false;
    fileLabel.value = `已读取 ${file.name}`;
  } catch {
    if (active && epoch === fileEpoch) fileError.value = '没有读到文件内容，请重新选择或直接粘贴。';
  } finally {
    if (active) reading.value = false;
  }
}
function clear() {
  fileEpoch++;
  model.value = '';
  fileLabel.value = '';
  fileError.value = '';
  visible.value = false;
}
function inputChanged() {
  fileEpoch++;
  fileLabel.value = '';
  fileError.value = '';
}
</script>

<template>
  <div class="field">
    <div class="credential-heading">
      <label :for="id" class="font-medium">{{ label }}</label>
      <div class="actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          :disabled="disabled || reading"
          @click="fileInput?.click()"
          ><Upload />{{ reading ? '正在读取…' : '选择文件' }}</Button
        >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          :aria-pressed="visible"
          :disabled="disabled"
          @click="visible = !visible"
          ><component :is="visible ? EyeOff : Eye" />{{ visible ? '隐藏内容' : '显示内容' }}</Button
        >
      </div>
    </div>
    <input
      ref="fileInput"
      type="file"
      class="sr-only"
      tabindex="-1"
      :aria-label="`选择${label}文件`"
      :accept="
        kind === 'kubeconfig' ? '.yaml,.yml,.json,.conf,text/plain,application/json' : undefined
      "
      :disabled="disabled"
      @change="readFile"
    />
    <textarea
      :id="id"
      v-model="model"
      :class="['input mono credential-input', { 'masked-content': !visible }]"
      rows="6"
      :required="required"
      :disabled="disabled"
      :maxlength="maxBytes"
      :aria-describedby="`${id}-hint${fileError ? ` ${id}-error` : ''}`"
      :aria-invalid="!!fileError"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      @input="inputChanged"
    />
    <div class="credential-heading">
      <p :id="`${id}-hint`" class="field-hint">
        {{
          kind === 'kubeconfig'
            ? '使用内嵌 CA 与客户端证书或 Token 的配置。'
            : '支持 OpenSSH 或 PEM 私钥。'
        }}
        保存后不会回显原文。
      </p>
      <Button
        v-if="model"
        type="button"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        @click="clear"
      >
        <X />清空输入
      </Button>
    </div>
    <p v-if="fileError" :id="`${id}-error`" class="field-error" role="alert">{{ fileError }}</p>
    <p v-else-if="fileLabel" class="field-hint" role="status">{{ fileLabel }}</p>
  </div>
</template>

<style scoped>
.credential-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.credential-input {
  resize: vertical;
  line-height: 1.5;
}
.masked-content {
  -webkit-text-security: disc;
}
</style>
