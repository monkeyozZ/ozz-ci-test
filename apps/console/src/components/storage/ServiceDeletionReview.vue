<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { Trash2, LoaderCircle, HardDrive } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import type { Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useViewScope } from '@/composables/useViewScope';
import type { ServiceDeletionPreview } from './types';
import StorageIssues from './StorageIssues.vue';
import StorageMutationError from './StorageMutationError.vue';
const props = defineProps<{
  service: Service;
  disabled?: boolean;
  pending?: boolean;
  error?: unknown;
}>();
const emit = defineEmits<{ confirm: [revision: number] }>();
const auth = useAuthStore();
const active = useViewScope();
const review = ref<ServiceDeletionPreview | null>(null);
const element = ref<HTMLElement>();
const preview = useMutation({
  mutationFn: (revision: number) =>
    api.create<ServiceDeletionPreview>(`/services/${props.service.id}/deletion-preview`, {
      revision,
    }),
  onSuccess: async (value) => {
    if (!active()) return;
    review.value = value;
    await nextTick();
    element.value?.focus();
  },
});
const stale = computed(() => !!review.value && review.value.revision !== props.service.revision);
const locked = computed(
  () =>
    auth.restoreMode ||
    props.disabled ||
    props.pending ||
    !!props.service.activeTask ||
    preview.isPending.value,
);
function confirm() {
  if (review.value && !stale.value && !locked.value && !review.value.blockers.length)
    emit('confirm', review.value.revision);
}
</script>
<template>
  <section class="panel danger-zone mt-6" data-service-deletion-review>
    <h2>删除服务，保留数据卷</h2>
    <p class="text-sm mt-3">
      停止工作负载并删除服务管理资源，部署历史、持久卷与数据库初始化凭证继续保留。
    </p>
    <Button
      type="button"
      variant="destructive"
      class="mt-5"
      :disabled="locked"
      @click="preview.mutate(service.revision)"
      ><LoaderCircle v-if="preview.isPending.value" class="animate-spin" /><Trash2 v-else />{{
        review ? '重新审阅删除影响' : '审阅服务删除'
      }}</Button
    >
    <StorageMutationError :error="preview.error.value || error" class="mt-5" />
    <div
      v-if="review"
      ref="element"
      tabindex="-1"
      class="service-deletion-content mt-6"
      data-service-deletion-preview
    >
      <p class="font-medium">
        {{ service.project.name }} / {{ service.environment.name }} · {{ service.cluster.name }} ·
        {{ service.name }}
      </p>
      <div class="notice mt-4">
        <HardDrive />
        <p>{{ review.dataRetentionMessage }}</p>
      </div>
      <h3 class="mt-5">将保留的数据卷</h3>
      <ul v-if="review.retainedVolumes.length" class="retained-volumes mt-3">
        <li v-for="volume in review.retainedVolumes" :key="volume.id">
          <RouterLink :to="`/volumes/${volume.id}`" class="text-link font-medium">{{
            volume.name
          }}</RouterLink>
          <p class="meta mono mt-1">PVC UID {{ volume.pvcUid ?? '尚未确认' }}</p>
          <RouterLink
            v-if="volume.databaseInstanceId"
            :to="`/databases/${volume.databaseInstanceId}`"
            class="text-link inline-block mt-2 text-sm"
            >数据库身份继续保留</RouterLink
          >
        </li>
      </ul>
      <p v-else class="meta mt-2">本次完整预览没有列出需保留的卷。</p>
      <template v-if="review.databaseConsumers.length"
        ><h3 class="mt-5">数据库消费者</h3>
        <ul class="retained-volumes mt-3">
          <li v-for="consumer in review.databaseConsumers" :key="consumer.serviceId">
            <RouterLink
              :to="{
                path: `/projects/${service.projectId}/services/${consumer.serviceId}`,
                query: { tab: 'storage' },
              }"
              class="text-link"
              >{{ consumer.name }}</RouterLink
            >
            <p class="meta mt-1">
              {{
                [
                  consumer.desired ? '草稿引用' : '',
                  consumer.published ? '已发布引用' : '',
                  consumer.inFlight ? '部署在途' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              }}
            </p>
          </li>
        </ul></template
      >
      <StorageIssues :issues="review.blockers" class="mt-5" danger title="删除前需要处理" />
      <p v-if="stale" class="field-error mt-5">服务版本已变化，请重新审阅删除影响。</p>
      <Button
        type="button"
        variant="destructive"
        class="mt-5"
        :disabled="locked || stale || !!review.blockers.length"
        @click="confirm"
        ><LoaderCircle v-if="pending" class="animate-spin" />确认删除服务并保留数据卷</Button
      >
    </div>
  </section>
</template>
<style scoped>
.service-deletion-content {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
}
.retained-volumes {
  display: grid;
  gap: 0.75rem;
}
.retained-volumes li {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1rem;
  overflow-wrap: anywhere;
}
</style>
