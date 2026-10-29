<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, FileCheck2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Volume, ManualDataRecord } from './types';
import ManualDataRecordList from './ManualDataRecordList.vue';
import ManualDataRecordForm from './ManualDataRecordForm.vue';
const props = defineProps<{ volume: Volume }>();
const auth = useAuthStore();
const ui = useUiStore();
const showForm = ref(false);
const records = useCollection<ManualDataRecord>(
  computed(() => `/volumes/${props.volume.id}/manual-data-records`),
);
function saved() {
  showForm.value = false;
  ui.toast('手工记录已保存，验证结果标记为操作者报告。');
}
</script>
<template>
  <section class="panel" data-manual-data-records>
    <div class="section-head">
      <div>
        <h2>手工备份与恢复记录</h2>
        <p class="meta mt-2">记录真实执行结果，保留源卷与新目标的关联</p>
      </div>
      <Button
        v-if="!showForm"
        type="button"
        variant="outline"
        :disabled="auth.restoreMode || !volume.manualDataIdentity"
        @click="showForm = true"
        ><Plus />添加手工记录</Button
      >
    </div>
    <ManualDataRecordForm
      v-if="showForm"
      :volume="volume"
      class="mb-7 pb-7 border-b border-border"
      @saved="saved"
    />
    <QueryState
      :pending="records.isPending.value"
      :error="records.error.value"
      :refreshing="records.isFetching.value"
      @retry="records.refetch()"
      ><ManualDataRecordList
        v-if="records.items.value.length"
        :records="records.items.value"
      /><EmptyState
        v-else-if="!records.error.value"
        :icon="FileCheck2"
        title="还没有手工数据记录"
        description="完成手工备份或恢复验证后，登记清单、数据时间点与证据。"
      /><Button
        v-if="records.hasNextPage.value"
        type="button"
        variant="outline"
        class="mt-5"
        :disabled="records.isFetchingNextPage.value"
        @click="records.fetchNextPage()"
        >载入更多记录</Button
      ></QueryState
    >
  </section>
</template>
