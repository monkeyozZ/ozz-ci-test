<script setup lang="ts">
import { computed, useId } from 'vue';
import { Button } from '@/components/ui/button';
import MutationError from '@/components/MutationError.vue';
import { useCollection } from '@/lib/query';
import type { SecretKind, SecretReference } from '@/lib/types';
const model = defineModel<string>({ required: true });
const props = defineProps<{
  kind: SecretKind;
  label: string;
  disabled?: boolean;
  required?: boolean;
}>();
const uid = useId();
const secrets = useCollection<SecretReference>('/secrets', () => ({ kind: props.kind }));
const known = computed(() => secrets.items.value.some((secret) => secret.id === model.value));
</script>
<template>
  <div class="field">
    <label :for="uid">{{ label }}</label>
    <select
      :id="uid"
      v-model="model"
      class="input"
      :disabled="disabled"
      :required="required"
      :aria-describedby="uid + '-hint'"
    >
      <option value="">选择已保存的凭证</option>
      <option v-if="model && !known" :value="model">当前引用 · {{ model }}</option>
      <option v-for="secret in secrets.items.value" :key="secret.id" :value="secret.id">
        {{ secret.name
        }}{{ secret.expiresAt && Date.parse(secret.expiresAt) <= Date.now() ? '（已到期）' : '' }}
      </option>
    </select>
    <p :id="uid + '-hint'" class="field-hint">
      只读取凭证引用。<RouterLink
        :to="{ path: '/settings', query: { new: kind } }"
        class="text-link"
        >新增凭证</RouterLink
      >
    </p>
    <MutationError :error="secrets.error.value" />
    <Button v-if="secrets.error.value" type="button" variant="ghost" @click="secrets.refetch()"
      >重试读取凭证</Button
    >
    <Button
      v-if="secrets.hasNextPage.value"
      type="button"
      variant="ghost"
      :disabled="secrets.isFetchingNextPage.value"
      @click="secrets.fetchNextPage()"
      >载入更多凭证</Button
    >
  </div>
</template>
