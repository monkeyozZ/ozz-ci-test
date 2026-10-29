<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { Wrench, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import NetworkStateBadge from '@/components/networking/NetworkStateBadge.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import { dateTime } from '@/lib/utils';
import type { Volume } from './types';
import { maintenanceState } from './presentation';
import StorageIssues from './StorageIssues.vue';
const props = defineProps<{
  volume: Volume;
  disabled?: boolean;
  pending?: boolean;
  error?: unknown;
}>();
const emit = defineEmits<{
  enter: [purpose: 'backup' | 'restore'];
  exit: [maintenanceId: string];
}>();
const purpose = ref<'backup' | 'restore'>('backup');
const purposeId = useId();
const maintenance = computed(() => props.volume.maintenance);
const held = computed(() => !!maintenance.value && maintenance.value.state !== 'closed');
</script>
<template>
  <section class="panel" data-volume-maintenance>
    <div class="section-head">
      <div>
        <h2 class="flex items-center gap-2"><Wrench class="size-5" />手工数据维护</h2>
        <p class="meta mt-2">维护期间暂停相关发布与销毁</p>
      </div>
      <NetworkStateBadge v-if="maintenance" v-bind="maintenanceState(maintenance)" />
    </div>
    <template v-if="maintenance && held">
      <dl class="storage-facts">
        <div>
          <dt>维护目的</dt>
          <dd>{{ maintenance.purpose === 'backup' ? '手工备份' : '向新目标手工恢复' }}</dd>
        </div>
        <div>
          <dt>进入时间</dt>
          <dd>{{ dateTime(maintenance.enteredAt) }}</dd>
        </div>
        <div>
          <dt>计划到期</dt>
          <dd>
            {{ dateTime(maintenance.expiresAt)
            }}{{ maintenance.overdue ? ' · 已超时，仍保持锁定' : '' }}
          </dd>
        </div>
        <div>
          <dt>维护记录</dt>
          <dd class="mono">{{ maintenance.id }}</dd>
        </div>
      </dl>
      <p class="field-hint mt-4">
        任务结束和维护超时都不会自动解除锁定。完成手工操作、清理辅助 Pod
        并核对实际挂载后，显式退出维护。
      </p>
      <StorageIssues class="mt-5" :issues="maintenance.exitBlockers" title="退出前需要处理" />
      <ServiceMutationError :error="error" class="mt-5" />
      <Button
        type="button"
        class="mt-5"
        variant="outline"
        :disabled="
          disabled ||
          pending ||
          !!volume.activeTask ||
          maintenance.exitBlockers.length > 0 ||
          maintenance.state === 'entering' ||
          maintenance.state === 'exiting'
        "
        @click="emit('exit', maintenance.id)"
        ><LoaderCircle v-if="pending" class="animate-spin" />核验并退出维护</Button
      >
    </template>
    <template v-else>
      <p class="text-sm">
        需要停止写入并由辅助 Pod
        访问卷时，先进入维护。平台仅建立维护互斥并核对资源；数据导出与恢复按手工指引执行。
      </p>
      <p v-if="maintenance?.releasedAt" class="meta mt-3">
        上次维护结束于 {{ dateTime(maintenance.releasedAt) }}
      </p>
      <div class="field mt-5 max-w-sm">
        <label :for="purposeId">维护目的</label
        ><select :id="purposeId" v-model="purpose" class="input" :disabled="disabled || pending">
          <option value="backup">手工备份</option>
          <option value="restore">向新目标手工恢复</option>
        </select>
      </div>
      <ServiceMutationError :error="error" class="mt-5" />
      <Button
        type="button"
        class="mt-5"
        variant="outline"
        :disabled="disabled || pending || !!volume.activeTask || volume.desiredState !== 'active'"
        @click="emit('enter', purpose)"
        ><LoaderCircle v-if="pending" class="animate-spin" />核验并进入维护</Button
      >
    </template>
  </section>
</template>
