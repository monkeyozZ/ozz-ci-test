<script setup lang="ts">
import { useId } from 'vue';
import { Input } from '@/components/ui/input';
import type { Template } from './types';
const model = defineModel<Record<string, string>>({ required: true });
defineProps<{ template: Template; disabled?: boolean }>();
const prefix = useId();
</script>
<template>
  <fieldset :disabled="disabled" class="template-parameters" data-template-parameters>
    <legend class="sr-only">模板参数</legend>
    <div v-for="parameter in template.parameters" :key="parameter.name" class="field">
      <label :for="`${prefix}-${parameter.name}`"
        >{{ parameter.label
        }}<span v-if="parameter.type === 'bytes'" class="meta">（GiB）</span></label
      >
      <Input
        :id="`${prefix}-${parameter.name}`"
        v-model="model[parameter.name]"
        :type="parameter.type === 'string' ? 'text' : 'number'"
        :min="parameter.type === 'bytes' ? 1 : (parameter.minimum ?? undefined)"
        :max="parameter.type === 'bytes' ? undefined : (parameter.maximum ?? undefined)"
        :step="parameter.type === 'string' ? undefined : 1"
        :required="parameter.required"
        :aria-describedby="`${prefix}-${parameter.name}-hint`"
        :autocomplete="parameter.name === 'username' ? 'off' : undefined"
      />
      <p :id="`${prefix}-${parameter.name}-hint`" class="field-hint">
        {{ parameter.description
        }}<template v-if="parameter.type === 'bytes'"> 申请量不构成 local-path 的硬配额。</template>
      </p>
    </div>
    <p v-if="!template.parameters.length" class="meta">
      此模板使用固定的已核验配置，没有额外参数。
    </p>
    <p v-if="template.category === 'database'" class="notice template-credential-note">
      保存模板时生成数据库凭证；密码通过受控连接引用提供给应用。
    </p>
  </fieldset>
</template>
<style scoped>
.template-parameters {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
  border: 0;
  padding: 0;
}
.template-credential-note {
  display: block;
  font-size: 0.875rem;
}
</style>
